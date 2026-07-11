import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertDetail } from './components/AlertDetail';
import { FlightSavesPanel } from './components/FlightSavesPanel';
import { LiveMap } from './components/LiveMap';
import { LiveVideoPane } from './components/LiveVideoPane';
import { ReplayTimeline } from './components/ReplayTimeline';
import { ReviewVideoModal } from './components/ReviewVideoModal';
import { SettingsDrawer } from './components/SettingsPanel';
import { TelemetryHud } from './components/TelemetryHud';
import {
  bootstrapApp,
  clearFocusedSession,
  completeActiveStream,
  deleteSession,
  exportSessionDetections,
  exportSessionTelemetry,
  focusSession,
  listOfflineRegions,
  listenToRuntimeEvents,
  selectOfflineRegion,
  startLiveIngest,
  setVisionPipelineEnabled,
  updateSessionDetails,
  updateConfig
} from './lib/runtime';
import type {
  AircraftLiveState,
  AlertRecord,
  AppSnapshot,
  DetectionConvergence,
  HudMetricState,
  OfflineRegionCatalog,
  ReviewTelemetryFrame,
  RuntimeEvent,
  TelemetryEnvelope,
  TrackPointRecord
} from './lib/types';

type OverlayPanel = 'flights' | 'settings' | null;
type FlightNotificationSeverity = 'info' | 'caution' | 'warning';
type VisionCommandState = 'idle' | 'starting' | 'stopping';
type ExportChoice = 'telemetry' | 'detections' | 'both';

interface FlightNotificationRecord {
  id: string;
  message: string;
  severity: FlightNotificationSeverity;
  persistent: boolean;
  placement?: 'default' | 'review-above-replay';
  actionLabel?: string;
  dismissLabel?: string;
  actionType?: 'open-detections' | 'dismiss-detection';
  durationMs?: number;
  closing?: boolean;
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon-export">
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 17.5h14" />
      <path d="M7 20h10" />
    </svg>
  );
}

const emptySnapshot: AppSnapshot = {
  config: {
    listen_port: 8765,
    legacy_telemetry_port: 45101,
    legacy_alert_port: 45100,
    aircraft_label: 'Kerbodyne Beta Vehicle',
    map_style_url: null,
    map_tile_template: null,
    offline_maps_root: null,
    selected_region_id: null,
    enabled_region_ids: [],
    region_name_overrides: {},
    default_map_mode: 'satellite',
    default_fov_deg: 38,
    default_range_m: 250,
    stale_after_seconds: 10,
    class_display_names: {
      fire: 'Fire',
      smoke: 'Smoke'
    },
    aircraft_icon: {
      size_px: 38,
      color_hex: '#f7f7f7',
      shape: 'compass'
    },
    track_display: {
      enabled: true,
      color_hex: '#f0f0f0',
      width_px: 2.8,
      style: 'solid'
    },
    flight_alerts: {
      high_speed_warning_mps: 35,
      low_speed_warning_mps: 9,
      high_altitude_warning_m: 120,
      low_battery_warning_percent: 20
    },
    video: {
      auto_record_live: false
    }
  },
  mode: 'idle',
  connection: {
    status: 'disconnected',
    port: 8765,
    last_packet_at: null,
    note: 'Awaiting telemetry'
  },
  active_session_id: null,
  active_session_has_armed_telemetry: false,
  focused_session_id: null,
  live_state: null,
  alerts: [],
  system_statuses: [],
  sessions: [],
  track: [],
  review_frames: [],
  review_video_clips: [],
  video_preview: {
    status: 'idle',
    preview_url: null,
    recording_active: false,
    current_clip_id: null,
    message: null
  },
  telemetry_ingest: {
    received_packets: 0,
    processed_packets: 0,
    parse_errors: 0,
    coalesced_packets: 0,
    dropped_packets: 0,
    persistence_errors: 0,
    frontend_updates: 0,
    queue_depth: 0,
    queue_high_water: 0,
    persistence_queue_depth: 0,
    persistence_queue_high_water: 0,
    processing_delay_ms: 0,
    max_processing_delay_ms: 0,
    last_batch_size: 0,
    last_batch_write_ms: 0,
    last_packet_type: null,
    last_received_at: null,
    last_processed_at: null,
    last_hf_received_at: null,
    last_mf_received_at: null,
    last_lf_received_at: null,
    last_oc_received_at: null,
    last_sequence: null,
    last_generated_at: null
  },
  raw_telemetry_packets: [],
  warnings: []
};

const CONVERGENCE_CLUSTER_DISTANCE_M = 75;

interface RayIntersectionCandidate {
  lat: number;
  lon: number;
  alertIds: string[];
}

interface EfficiencyMetric {
  liveWhPerKm: number | null;
  averageWhPerKm: number | null;
}

interface EfficiencyAccumulator {
  lastTimeMs: number | null;
  lastBatteryWh: number | null;
  fallbackEnergyWh: number;
  averageEfficiencySum: number;
  averageEfficiencyCount: number;
  lastAverageSampleKey: string | null;
  lastLiveWhPerKm: number | null;
}

function createEfficiencyAccumulator(): EfficiencyAccumulator {
  return {
    lastTimeMs: null,
    lastBatteryWh: null,
    fallbackEnergyWh: 0,
    averageEfficiencySum: 0,
    averageEfficiencyCount: 0,
    lastAverageSampleKey: null,
    lastLiveWhPerKm: null
  };
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function normalizeBearing(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function haversineDistanceM(startLat: number, startLon: number, endLat: number, endLon: number) {
  const earthRadiusM = 6378137;
  const lat1 = toRadians(startLat);
  const lat2 = toRadians(endLat);
  const latDiff = toRadians(endLat - startLat);
  const lonDiff = toRadians(endLon - startLon);
  const a =
    Math.sin(latDiff / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDiff / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusM * c;
}

function buildDetectionConvergences(alerts: AlertRecord[]): DetectionConvergence[] {
  const candidates: RayIntersectionCandidate[] = [];
  for (let firstIndex = 0; firstIndex < alerts.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < alerts.length; secondIndex += 1) {
      const intersection = intersectDetectionRays(alerts[firstIndex], alerts[secondIndex]);
      if (intersection) {
        candidates.push(intersection);
      }
    }
  }

  const clusters: Array<RayIntersectionCandidate & { count: number }> = [];
  candidates.forEach((candidate) => {
    const existing = clusters.find(
      (cluster) =>
        haversineDistanceM(cluster.lat, cluster.lon, candidate.lat, candidate.lon) <=
        CONVERGENCE_CLUSTER_DISTANCE_M
    );
    if (!existing) {
      clusters.push({ ...candidate, count: 1 });
      return;
    }
    const nextCount = existing.count + 1;
    existing.lat = (existing.lat * existing.count + candidate.lat) / nextCount;
    existing.lon = (existing.lon * existing.count + candidate.lon) / nextCount;
    existing.count = nextCount;
    candidate.alertIds.forEach((alertId) => {
      if (!existing.alertIds.includes(alertId)) {
        existing.alertIds.push(alertId);
      }
    });
  });

  return clusters
    .filter((cluster) => cluster.alertIds.length >= 2)
    .map((cluster) => {
      const alertIds = [...cluster.alertIds].sort();
      return {
        id: `convergence:${alertIds.join('+')}:${cluster.lat.toFixed(5)}:${cluster.lon.toFixed(5)}`,
        lat: cluster.lat,
        lon: cluster.lon,
        alertIds
      };
    });
}

function intersectDetectionRays(
  first: AlertRecord,
  second: AlertRecord
): RayIntersectionCandidate | null {
  const firstLat = first.sector.center_lat;
  const firstLon = first.sector.center_lon;
  const secondLat = second.sector.center_lat;
  const secondLon = second.sector.center_lon;
  if (!hasValidPosition(firstLat, firstLon) || !hasValidPosition(secondLat, secondLon)) {
    return null;
  }

  const originLat = (firstLat + secondLat) / 2;
  const metersPerLat = 111_320;
  const metersPerLon = Math.max(1, Math.cos(toRadians(originLat)) * metersPerLat);
  const p2 = {
    x: (secondLon - firstLon) * metersPerLon,
    y: (secondLat - firstLat) * metersPerLat
  };
  const firstBearing = normalizeBearing(first.sector.bearing_deg);
  const secondBearing = normalizeBearing(second.sector.bearing_deg);
  const d1 = {
    x: Math.sin(toRadians(firstBearing)),
    y: Math.cos(toRadians(firstBearing))
  };
  const d2 = {
    x: Math.sin(toRadians(secondBearing)),
    y: Math.cos(toRadians(secondBearing))
  };
  const determinant = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(determinant) < 0.00001) {
    return null;
  }

  const t = (p2.x * d2.y - p2.y * d2.x) / determinant;
  const u = (p2.x * d1.y - p2.y * d1.x) / determinant;
  if (t < 0 || u < 0) {
    return null;
  }

  return {
    lat: firstLat + (t * d1.y) / metersPerLat,
    lon: firstLon + (t * d1.x) / metersPerLon,
    alertIds: [first.id, second.id]
  };
}

function findMostRecentAlert(alerts: AlertRecord[]): AlertRecord | null {
  if (alerts.length === 0) {
    return null;
  }

  return alerts.slice(1).reduce<AlertRecord>((latest, current) => {
    return new Date(current.detected_at).getTime() > new Date(latest.detected_at).getTime()
      ? current
      : latest;
  }, alerts[0]);
}

function hasValidPosition(
  lat: number | null | undefined,
  lon: number | null | undefined
) {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    typeof lon === 'number' &&
    Number.isFinite(lon) &&
    !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001)
  );
}

function getRegionDisplayName(
  region: { id: string; name: string },
  overrides: Record<string, string>
) {
  const override = overrides[region.id]?.trim();
  return override || region.name;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function mixHexColors(first: string, second: string, weight: number) {
  const normalized = clamp(weight, 0, 1);
  const parse = (value: string) => {
    const trimmed = value.replace('#', '');
    const expanded =
      trimmed.length === 3
        ? trimmed
            .split('')
            .map((character) => `${character}${character}`)
            .join('')
        : trimmed;
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16)
    ];
  };
  const [r1, g1, b1] = parse(first);
  const [r2, g2, b2] = parse(second);
  const toHex = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  return `#${toHex(r1 + (r2 - r1) * normalized)}${toHex(g1 + (g2 - g1) * normalized)}${toHex(
    b1 + (b2 - b1) * normalized
  )}`;
}

function readNumberExtra(extras: Record<string, unknown> | null | undefined, key: string) {
  const value = extras?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBooleanExtra(extras: Record<string, unknown> | null | undefined, key: string) {
  const value = extras?.[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function readStringExtra(extras: Record<string, unknown> | null | undefined, key: string) {
  const value = extras?.[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function getEfficiencyPacketTimeMs(liveState: AircraftLiveState) {
  const extras = liveState.extras as Record<string, unknown> | null;
  const bootTimeMs = readNumberExtra(extras, 'time_boot_ms');
  if (bootTimeMs != null && Number.isFinite(bootTimeMs)) {
    return bootTimeMs;
  }
  const wallTimeMs = new Date(liveState.last_update_at).getTime();
  return Number.isFinite(wallTimeMs) ? wallTimeMs : null;
}

function updateEfficiencyAccumulator(
  liveState: AircraftLiveState | null | undefined,
  accumulator: EfficiencyAccumulator
): EfficiencyMetric {
  if (!liveState?.armed) {
    return {
      liveWhPerKm: accumulator.lastLiveWhPerKm,
      averageWhPerKm:
        accumulator.averageEfficiencyCount > 0
          ? accumulator.averageEfficiencySum / accumulator.averageEfficiencyCount
          : null
    };
  }

  const packetTimeMs = getEfficiencyPacketTimeMs(liveState);
  if (packetTimeMs == null) {
    return {
      liveWhPerKm: accumulator.lastLiveWhPerKm,
      averageWhPerKm:
        accumulator.averageEfficiencyCount > 0
          ? accumulator.averageEfficiencySum / accumulator.averageEfficiencyCount
          : null
    };
  }

  const extras = liveState.extras as Record<string, unknown> | null;
  const speedMps = liveState.groundspeed_mps;
  const voltage = liveState.battery?.voltage_v;
  const currentA = readNumberExtra(extras, 'battery_a');
  const batteryWhConsumed = readNumberExtra(extras, 'battery_wh');
  const lastTimeMs = accumulator.lastTimeMs;
  const deltaHours =
    lastTimeMs != null && packetTimeMs > lastTimeMs
      ? (packetTimeMs - lastTimeMs) / 3_600_000
      : 0;
  const speedKmPerHour =
    speedMps != null && Number.isFinite(speedMps) && speedMps > 0 ? speedMps * 3.6 : null;
  const powerW =
    voltage != null &&
    currentA != null &&
    Number.isFinite(voltage) &&
    Number.isFinite(currentA)
      ? Math.abs(voltage * currentA)
      : null;

  let deltaEnergyWh = 0;
  if (
    batteryWhConsumed != null &&
    Number.isFinite(batteryWhConsumed) &&
    batteryWhConsumed >= 0
  ) {
    if (accumulator.lastBatteryWh != null && batteryWhConsumed >= accumulator.lastBatteryWh) {
      deltaEnergyWh = batteryWhConsumed - accumulator.lastBatteryWh;
    }
    accumulator.lastBatteryWh = batteryWhConsumed;
    accumulator.fallbackEnergyWh = batteryWhConsumed;
  } else if (deltaHours > 0 && powerW != null) {
    deltaEnergyWh = powerW * deltaHours;
    accumulator.fallbackEnergyWh += deltaEnergyWh;
  }

  const instantaneousWhPerKm =
    powerW != null && speedKmPerHour != null && speedKmPerHour > 1.8
      ? powerW / speedKmPerHour
      : null;
  const deltaDistanceKm =
    deltaHours > 0 && speedMps != null && Number.isFinite(speedMps)
      ? (speedMps * deltaHours * 3600) / 1000
      : 0;
  const segmentWhPerKm =
    deltaDistanceKm > 0 && deltaEnergyWh > 0 ? deltaEnergyWh / deltaDistanceKm : null;
  const computedWhPerKm = instantaneousWhPerKm ?? segmentWhPerKm;
  const liveWhPerKm = computedWhPerKm ?? accumulator.lastLiveWhPerKm;

  if (computedWhPerKm != null && Number.isFinite(computedWhPerKm)) {
    accumulator.lastLiveWhPerKm = computedWhPerKm;
  }

  const airborne = speedMps != null && Number.isFinite(speedMps) && speedMps > 5;
  const sampleKey = `${packetTimeMs}:${computedWhPerKm != null ? computedWhPerKm.toFixed(3) : 'na'}`;
  if (
    airborne &&
    computedWhPerKm != null &&
    Number.isFinite(computedWhPerKm) &&
    sampleKey !== accumulator.lastAverageSampleKey
  ) {
    accumulator.averageEfficiencySum += computedWhPerKm;
    accumulator.averageEfficiencyCount += 1;
    accumulator.lastAverageSampleKey = sampleKey;
  }

  accumulator.lastTimeMs = packetTimeMs;
  return {
    liveWhPerKm: accumulator.lastLiveWhPerKm,
    averageWhPerKm:
      accumulator.averageEfficiencyCount > 0
        ? accumulator.averageEfficiencySum / accumulator.averageEfficiencyCount
        : null
  };
}

function computeReviewEfficiencyMetric(
  frames: ReviewTelemetryFrame[],
  selectedIndex: number | null
): EfficiencyMetric {
  if (selectedIndex == null || selectedIndex < 0 || frames.length === 0) {
    return { liveWhPerKm: null, averageWhPerKm: null };
  }

  const accumulator = createEfficiencyAccumulator();
  const endIndex = Math.min(selectedIndex, frames.length - 1);
  let metric: EfficiencyMetric = { liveWhPerKm: null, averageWhPerKm: null };
  for (let index = 0; index <= endIndex; index += 1) {
    metric = updateEfficiencyAccumulator(frames[index].live_state, accumulator);
  }
  return metric;
}

function isLegacyCompatibilityTelemetry(extras: Record<string, unknown> | null | undefined) {
  return Boolean(
    readStringExtra(extras, 'legacy_packet_type') ??
      readBooleanExtra(extras, 'legacy_armed') ??
      false
  );
}

function normalizeDisplayedPitchDeg(
  value: number | null,
  legacyCompatibility: boolean
) {
  if (value == null) {
    return null;
  }
  return legacyCompatibility ? -value : value;
}

function normalizeDisplayedTargetAltitudeMsl(
  rawTargetMsl: number | null,
  currentAltitudeMsl: number | null,
  legacyCompatibility: boolean
) {
  if (rawTargetMsl == null) {
    return null;
  }
  if (!legacyCompatibility || currentAltitudeMsl == null) {
    return rawTargetMsl;
  }
  // Legacy sender currently computes demanded altitude as current - alt_error.
  // For the active airside build, the correct displayed target is the mirrored
  // value around the current altitude.
  return currentAltitudeMsl + (currentAltitudeMsl - rawTargetMsl);
}

function deriveTrackFromRawPackets(rawPackets: string[]): TrackPointRecord[] {
  const points: TrackPointRecord[] = [];

  for (const rawPacket of rawPackets) {
    try {
      const jsonStart = rawPacket.indexOf('{');
      if (jsonStart === -1) {
        continue;
      }
      const envelope = JSON.parse(rawPacket.slice(jsonStart)) as TelemetryEnvelope & {
        sent_at?: string;
        type?: string;
      };
      if (envelope.type !== 'telemetry') {
        continue;
      }
      const payload = envelope.payload;
      if (!payload || !hasValidPosition(payload.lat ?? null, payload.lon ?? null)) {
        continue;
      }
      points.push({
        lat: payload.lat as number,
        lon: payload.lon as number,
        recorded_at: envelope.sent_at ?? new Date().toISOString(),
        alt_msl_m: payload.alt_msl_m ?? null,
        heading_deg: payload.heading_deg ?? null,
        groundspeed_mps: payload.groundspeed_mps ?? null
      });
    } catch {
      continue;
    }
  }

  return points;
}

const ARDUPLANE_FLIGHT_MODE_LABELS: Record<number, string> = {
  0: 'Manual',
  1: 'Circle',
  2: 'Stabilize',
  3: 'Training',
  4: 'Acro',
  5: 'FBWA',
  6: 'FBWB',
  7: 'Cruise',
  8: 'Autotune',
  10: 'Auto',
  11: 'RTL',
  12: 'Loiter',
  15: 'Guided',
  16: 'Initializing',
  17: 'QStabilize',
  18: 'QHover',
  19: 'QLoiter',
  20: 'QLand',
  21: 'QRTL',
  22: 'QAutotune',
  23: 'QAcro',
  24: 'Thermal',
  25: 'LoiterAltQLand',
  26: 'Autoland',
  27: 'AutoTakeoff'
};

function formatFlightModeLabel(value: string | number | null | undefined) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.round(value);
    return ARDUPLANE_FLIGHT_MODE_LABELS[normalized] ?? `Mode ${normalized}`;
  }
  return '--';
}

function buildMetricState(
  tone: HudMetricState['tone'],
  color_hex?: string | null,
  pulse = false
): HudMetricState {
  return { tone, color_hex: color_hex ?? null, pulse };
}

export function App() {
  const measureToolbarHostRef = useRef<HTMLDivElement | null>(null);
  const rawTelemetryLogRef = useRef<HTMLDivElement | null>(null);
  const regionMenuRef = useRef<HTMLDivElement | null>(null);
  const notificationTimersRef = useRef<Record<string, number>>({});
  const seenSystemStatusIdsRef = useRef<Set<string>>(new Set());
  const armedAltitudeBaselineRef = useRef<number | null>(null);
  const armedAtTimestampRef = useRef<string | null>(null);
  const efficiencyAccumulatorRef = useRef<EfficiencyAccumulator>(createEfficiencyAccumulator());
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [offlineCatalog, setOfflineCatalog] = useState<OfflineRegionCatalog>({
    asset_origin: '',
    regions: []
  });
  const [offlineRegionsError, setOfflineRegionsError] = useState<string | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedConvergenceId, setSelectedConvergenceId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<OverlayPanel>(null);
  const [alertDetailVisible, setAlertDetailVisible] = useState(false);
  const [activeFlightLayout, setActiveFlightLayout] = useState<'video-dominant' | 'map-dominant'>(
    'video-dominant'
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1600 : window.innerWidth
  );
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 1000 : window.innerHeight
  );
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [stopFlightOpen, setStopFlightOpen] = useState(false);
  const [rawTelemetryOpen, setRawTelemetryOpen] = useState(false);
  const [expandedHudOpen, setExpandedHudOpen] = useState(false);
  const [measureToolActive, setMeasureToolActive] = useState(false);
  const [reviewVideoOpen, setReviewVideoOpen] = useState(false);
  const [deleteFlightTarget, setDeleteFlightTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [exportFlightTarget, setExportFlightTarget] = useState<{
    id: string;
    name: string;
    alertCount: number;
  } | null>(null);
  const [regionMenuOpen, setRegionMenuOpen] = useState(false);
  const [stopFlightName, setStopFlightName] = useState('');
  const [stopFlightDescription, setStopFlightDescription] = useState('');
  const [reviewFrameIndex, setReviewFrameIndex] = useState<number | null>(null);
  const [reviewPlaybackActive, setReviewPlaybackActive] = useState(false);
  const [reviewPlaybackSpeed, setReviewPlaybackSpeed] = useState(1);
  const [visionCommandState, setVisionCommandState] = useState<VisionCommandState>('idle');
  const [visionStartupConfirmed, setVisionStartupConfirmed] = useState(false);
  const [visionStopAcknowledged, setVisionStopAcknowledged] = useState(false);
  const [efficiencyMetric, setEfficiencyMetric] = useState<EfficiencyMetric>({
    liveWhPerKm: null,
    averageWhPerKm: null
  });
  const [lastIdleMapView, setLastIdleMapView] = useState<{
    center: [number, number];
    zoom: number;
    bearing: number;
  } | null>(null);
  const [flightNotifications, setFlightNotifications] = useState<FlightNotificationRecord[]>([]);
  const [unacknowledgedDetectionIds, setUnacknowledgedDetectionIds] = useState<string[]>([]);
  const [activeMapHiddenDetectionIds, setActiveMapHiddenDetectionIds] = useState<string[]>([]);
  const [lowSpeedMonitoringEnabled, setLowSpeedMonitoringEnabled] = useState(false);
  const clearBannerRef = useRef<number | null>(null);
  const previousAlertCountRef = useRef(0);
  const previousFocusedSessionIdRef = useRef<string | null>(null);
  const previousActiveSessionIdRef = useRef<string | null>(null);
  const previousActiveFlightRef = useRef(false);
  const latestVisionStatusIdRef = useRef<string | null>(null);
  const previousVisionActiveRef = useRef<boolean | null>(null);
  const lowSpeedLandingTimerRef = useRef<number | null>(null);

  const deferredAlerts = useDeferredValue(snapshot.alerts);
  const activeSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === snapshot.active_session_id) ?? null,
    [snapshot.sessions, snapshot.active_session_id]
  );
  const focusedSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === snapshot.focused_session_id) ?? null,
    [snapshot.sessions, snapshot.focused_session_id]
  );
  const enabledRegionIdsKey = snapshot.config.enabled_region_ids.join('|');
  const enabledRegions = useMemo(
    () =>
      snapshot.config.enabled_region_ids
        .map((regionId) => offlineCatalog.regions.find((region) => region.id === regionId) ?? null)
        .filter((region): region is NonNullable<typeof region> => Boolean(region)),
    [enabledRegionIdsKey, offlineCatalog.regions]
  );
  const selectedRegion = useMemo(
    () =>
      enabledRegions.find((region) => region.id === snapshot.config.selected_region_id) ??
      enabledRegions[0] ??
      null,
    [enabledRegions, snapshot.config.selected_region_id]
  );
  const selectedRegionLabel = selectedRegion
    ? getRegionDisplayName(selectedRegion, snapshot.config.region_name_overrides)
    : 'No enabled regions';
  const mapRegionReady =
    snapshot.config.enabled_region_ids.length === 0 ||
    (enabledRegions.length === snapshot.config.enabled_region_ids.length &&
      Boolean(offlineCatalog.asset_origin));
  const mapMode = snapshot.config.default_map_mode;
  const reviewMode = !Boolean(snapshot.active_session_id) && Boolean(snapshot.focused_session_id);
  const reviewFrames = snapshot.review_frames;
  const effectiveReviewFrameIndex = useMemo(() => {
    if (!reviewMode || reviewFrames.length === 0) {
      return null;
    }

    const fallbackIndex = reviewFrames.length - 1;
    const candidate = reviewFrameIndex ?? fallbackIndex;
    return Math.max(0, Math.min(candidate, reviewFrames.length - 1));
  }, [reviewFrameIndex, reviewFrames, reviewMode]);
  const selectedReviewFrame = useMemo(
    () =>
      effectiveReviewFrameIndex != null ? reviewFrames[effectiveReviewFrameIndex] ?? null : null,
    [effectiveReviewFrameIndex, reviewFrames]
  );
  const reviewArmedAltitudeBaseline = useMemo(() => {
    if (!reviewMode) {
      return null;
    }
    return (
      reviewFrames.find(
        (frame) => frame.live_state.armed && frame.live_state.alt_msl_m != null
      )?.live_state.alt_msl_m ?? null
    );
  }, [reviewFrames, reviewMode]);
  const displayLiveState = reviewMode ? selectedReviewFrame?.live_state ?? null : snapshot.live_state;
  const displayAltitudeMsl = displayLiveState?.alt_msl_m ?? null;
  const displayAltitudeAgl = useMemo(() => {
    if (displayAltitudeMsl == null) {
      return null;
    }
    if (!displayLiveState?.armed) {
      return 0;
    }
    const baseline = snapshot.active_session_id
      ? armedAltitudeBaselineRef.current
      : reviewArmedAltitudeBaseline;
    if (baseline == null || displayAltitudeMsl == null) {
      return 0;
    }
    return displayAltitudeMsl - baseline;
  }, [
    displayAltitudeMsl,
    displayLiveState?.armed,
    reviewArmedAltitudeBaseline,
    snapshot.active_session_id
  ]);
  const liveExtras = (displayLiveState?.extras ?? null) as Record<string, unknown> | null;
  const flightModeRaw =
    readStringExtra(liveExtras, 'flight_mode_label') ??
    readNumberExtra(liveExtras, 'flight_mode') ??
    readStringExtra(liveExtras, 'flight_mode');
  const flightModeLabel = formatFlightModeLabel(flightModeRaw);
  const legacyCompatibility = isLegacyCompatibilityTelemetry(liveExtras);
  const rawPitchDeg = readNumberExtra(liveExtras, 'pitch_deg');
  const pitchDeg = normalizeDisplayedPitchDeg(rawPitchDeg, legacyCompatibility);
  const rollDeg = readNumberExtra(liveExtras, 'roll_deg');
  const rawTargetAltitudeMslM = readNumberExtra(liveExtras, 'alt_demanded_m');
  const targetAltitudeMslM = normalizeDisplayedTargetAltitudeMsl(
    rawTargetAltitudeMslM,
    displayAltitudeMsl,
    legacyCompatibility
  );
  const throttlePct = readNumberExtra(liveExtras, 'throttle_pct');
  const verticalSpeedMps = readNumberExtra(liveExtras, 'vspeed_ms');
  const vibrationX = readNumberExtra(liveExtras, 'vib_x');
  const vibrationY = readNumberExtra(liveExtras, 'vib_y');
  const vibrationZ = readNumberExtra(liveExtras, 'vib_z');
  const cpuTempC = readNumberExtra(liveExtras, 'cpu_temp_c');
  const cpuPercent = readNumberExtra(liveExtras, 'cpu_pct');
  const cpuMhz = readNumberExtra(liveExtras, 'cpu_mhz');
  const npuTempC = readNumberExtra(liveExtras, 'npu_temp_c');
  const batteryMahConsumed = readNumberExtra(liveExtras, 'battery_mah');
  const visionActive = readBooleanExtra(liveExtras, 'vision_active');
  const fallbackTrack = useMemo(
    () => deriveTrackFromRawPackets(snapshot.raw_telemetry_packets),
    [snapshot.raw_telemetry_packets]
  );
  const displayTargetAltitudeAgl = useMemo(() => {
    if (!displayLiveState?.armed || targetAltitudeMslM == null) {
      return null;
    }
    const baseline = snapshot.active_session_id
      ? armedAltitudeBaselineRef.current
      : reviewArmedAltitudeBaseline;
    if (baseline == null) {
      return null;
    }
    return targetAltitudeMslM - baseline;
  }, [
    displayLiveState?.armed,
    reviewArmedAltitudeBaseline,
    snapshot.active_session_id,
    targetAltitudeMslM
  ]);
  const reviewEfficiencyMetric = useMemo(
    () => computeReviewEfficiencyMetric(reviewFrames, effectiveReviewFrameIndex),
    [effectiveReviewFrameIndex, reviewFrames]
  );
  const reviewFinalEfficiencyMetric = useMemo(
    () => computeReviewEfficiencyMetric(reviewFrames, reviewFrames.length - 1),
    [reviewFrames]
  );
  const displayEfficiencyMetric = reviewMode
    ? {
        liveWhPerKm: reviewEfficiencyMetric.liveWhPerKm,
        averageWhPerKm: reviewFinalEfficiencyMetric.averageWhPerKm
      }
    : efficiencyMetric;
  const displayTrack = useMemo(() => {
    if (!reviewMode) {
      return snapshot.track.length >= 2 ? snapshot.track : fallbackTrack;
    }
    if (effectiveReviewFrameIndex == null || reviewFrames.length === 0) {
      return snapshot.track.length >= 2 ? snapshot.track : fallbackTrack;
    }

    const reviewTrack = reviewFrames
      .slice(0, effectiveReviewFrameIndex + 1)
      .flatMap((frame) => {
        const lat = frame.live_state.lat;
        const lon = frame.live_state.lon;
        return hasValidPosition(lat, lon)
          ? [
              {
                lat: lat as number,
                lon: lon as number,
                recorded_at: frame.recorded_at,
                alt_msl_m: frame.live_state.alt_msl_m ?? null,
                heading_deg: frame.live_state.heading_deg ?? null,
                groundspeed_mps: frame.live_state.groundspeed_mps ?? null
              }
            ]
          : [];
      });
    if (reviewTrack.length >= 2) {
      return reviewTrack;
    }
    if (snapshot.track.length >= 2) {
      return snapshot.track;
    }
    return fallbackTrack;
  }, [effectiveReviewFrameIndex, fallbackTrack, reviewFrames, reviewMode, snapshot.track]);
  const detectionConvergences = useMemo(
    () => buildDetectionConvergences(deferredAlerts),
    [deferredAlerts]
  );
  const selectedConvergence = useMemo(
    () =>
      selectedConvergenceId
        ? detectionConvergences.find((convergence) => convergence.id === selectedConvergenceId) ??
          null
        : null,
    [detectionConvergences, selectedConvergenceId]
  );
  const selectedConvergenceAlertIds = useMemo(
    () => new Set(selectedConvergence?.alertIds ?? []),
    [selectedConvergence]
  );
  const detectionNavigationAlerts = useMemo(
    () =>
      selectedConvergence
        ? deferredAlerts.filter((alert) => selectedConvergenceAlertIds.has(alert.id))
        : deferredAlerts,
    [deferredAlerts, selectedConvergence, selectedConvergenceAlertIds]
  );
  const selectedAlert = useMemo<AlertRecord | null>(
    () => detectionNavigationAlerts.find((alert) => alert.id === selectedAlertId) ?? null,
    [detectionNavigationAlerts, selectedAlertId]
  );
  const selectedAlertIndex = useMemo(
    () => detectionNavigationAlerts.findIndex((alert) => alert.id === selectedAlertId),
    [detectionNavigationAlerts, selectedAlertId]
  );
  const reviewInitialMapFocusTarget = useMemo<[number, number] | null>(() => {
    if (!reviewMode) {
      return null;
    }
    const reviewLat = selectedReviewFrame?.live_state.lat;
    const reviewLon = selectedReviewFrame?.live_state.lon;
    if (hasValidPosition(reviewLat, reviewLon)) {
      return [reviewLat as number, reviewLon as number];
    }
    const lastTrackPoint =
      displayTrack[displayTrack.length - 1] ?? snapshot.track[snapshot.track.length - 1];
    return lastTrackPoint ? [lastTrackPoint.lat, lastTrackPoint.lon] : null;
  }, [displayTrack, reviewMode, selectedReviewFrame, snapshot.track]);
  const reviewInitialMapFocusKey = reviewMode ? snapshot.focused_session_id ?? null : null;

  function clearNotificationTimer(notificationId: string) {
    const existing = notificationTimersRef.current[notificationId];
    if (existing) {
      window.clearTimeout(existing);
      delete notificationTimersRef.current[notificationId];
    }
  }

  function dismissFlightNotification(notificationId: string) {
    clearNotificationTimer(notificationId);
    setFlightNotifications((current) => {
      const target = current.find((notification) => notification.id === notificationId);
      if (!target) {
        return current;
      }
      if (target.closing) {
        return current;
      }
      return current.map((notification) =>
        notification.id === notificationId ? { ...notification, closing: true } : notification
      );
    });
    notificationTimersRef.current[notificationId] = window.setTimeout(() => {
      setFlightNotifications((current) =>
        current.filter((notification) => notification.id !== notificationId)
      );
      clearNotificationTimer(notificationId);
    }, 360);
  }

  function upsertFlightNotification(notification: FlightNotificationRecord) {
    setFlightNotifications((current) => {
      const existing = current.find((entry) => entry.id === notification.id);
        if (
          existing &&
          existing.message === notification.message &&
          existing.severity === notification.severity &&
          existing.persistent === notification.persistent &&
          existing.placement === notification.placement &&
          existing.actionLabel === notification.actionLabel &&
          existing.dismissLabel === notification.dismissLabel &&
          existing.actionType === notification.actionType &&
          existing.durationMs === notification.durationMs &&
          !existing.closing
        ) {
        return current;
      }
      const next = current.filter((entry) => entry.id !== notification.id);
      return [{ ...notification, closing: false }, ...next].slice(0, 6);
    });
      clearNotificationTimer(notification.id);
      if (!notification.persistent) {
        notificationTimersRef.current[notification.id] = window.setTimeout(() => {
          dismissFlightNotification(notification.id);
        }, notification.durationMs ?? 5000);
      }
    }

  function handleFlightNotificationAction(notification: FlightNotificationRecord, action: 'open' | 'dismiss') {
    if (!notification.actionType) {
      dismissFlightNotification(notification.id);
      return;
    }
    if (notification.actionType === 'open-detections' && action === 'open') {
      setUnacknowledgedDetectionIds([]);
      openDetectionPanel();
      dismissFlightNotification(notification.id);
      return;
    }
    if (notification.actionType === 'open-detections' && action === 'dismiss') {
      setActiveMapHiddenDetectionIds((current) => {
        const next = new Set(current);
        unacknowledgedDetectionIds.forEach((alertId) => next.add(alertId));
        return [...next];
      });
      dismissFlightNotification(notification.id);
      return;
    }
    if (notification.actionType === 'dismiss-detection') {
      if (action === 'dismiss' || action === 'open') {
        setUnacknowledgedDetectionIds([]);
        dismissFlightNotification(notification.id);
      }
    }
  }

  function showBanner(message: string) {
    setBannerMessage(message);
    if (clearBannerRef.current) {
      window.clearTimeout(clearBannerRef.current);
    }
      clearBannerRef.current = window.setTimeout(() => {
        setBannerMessage(null);
        clearBannerRef.current = null;
      }, 5000);
  }

  async function runCommand(command: () => Promise<void>) {
    try {
      await command();
    } catch (error) {
      if (error instanceof Error) {
        showBanner(error.message);
        return;
      }
      if (typeof error === 'string') {
        showBanner(error);
        return;
      }
      if (error && typeof error === 'object' && 'message' in error) {
        const message = String((error as { message?: unknown }).message ?? '').trim();
        showBanner(message || 'Command failed');
        return;
      }
      showBanner('Command failed');
    }
  }

  async function refreshOfflineRegions(notify = false) {
    try {
      const catalog = await listOfflineRegions();
      setOfflineCatalog(catalog);
      setOfflineRegionsError(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to load offline map regions';
      setOfflineRegionsError(message);
      if (notify) {
        showBanner(message);
      }
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    bootstrapApp()
      .then((nextSnapshot) => {
        const normalizedSnapshot =
          nextSnapshot.config.default_map_mode === 'satellite'
            ? nextSnapshot
            : {
                ...nextSnapshot,
                config: {
                  ...nextSnapshot.config,
                  default_map_mode: 'satellite' as const
                }
              };
        setSnapshot(normalizedSnapshot);
        previousAlertCountRef.current = nextSnapshot.alerts.length;
        setSelectedAlertId(null);
        setSelectedConvergenceId(null);
        setAlertDetailVisible(false);
        void refreshOfflineRegions();
        if (nextSnapshot.config.default_map_mode !== 'satellite') {
          void updateConfig({
            ...nextSnapshot.config,
            default_map_mode: 'satellite'
          }).catch(() => {
            // Leave the local override in place even if persisting fails.
          });
        }
      })
      .catch((error) => {
        showBanner(error instanceof Error ? error.message : 'Unable to load ground station state');
      });

    listenToRuntimeEvents((event: RuntimeEvent) => {
      startTransition(() => {
        if (event.type === 'snapshot') {
          setSnapshot(event.snapshot);
          const previousAlertCount = previousAlertCountRef.current;
          const newAlertCount = Math.max(0, event.snapshot.alerts.length - previousAlertCount);
          const newAlerts = newAlertCount > 0 ? event.snapshot.alerts.slice(0, newAlertCount) : [];
          const mostRecentNewAlert = newAlerts[0] ?? null;

          if (Boolean(event.snapshot.active_session_id) && mostRecentNewAlert) {
            setActiveMapHiddenDetectionIds((current) =>
              current.filter((alertId) => !newAlerts.some((alert) => alert.id === alertId))
            );
            setUnacknowledgedDetectionIds((current) => {
              const next = new Set(current);
              newAlerts.forEach((alert) => next.add(alert.id));
              return [...next];
            });
            upsertFlightNotification({
              id: 'active-flight-detection',
              message: `${mostRecentNewAlert.class_label} detection received`,
              severity: 'warning',
              persistent: true,
              actionLabel: 'Open',
              dismissLabel: 'Dismiss',
              actionType: 'open-detections'
            });
          }

          setSelectedAlertId((current) => {
            previousAlertCountRef.current = event.snapshot.alerts.length;

            if (!current) {
              return null;
            }
            return event.snapshot.alerts.some((alert) => alert.id === current)
              ? current
              : null;
          });

          if (event.snapshot.alerts.length === 0) {
            setAlertDetailVisible(false);
            setSelectedConvergenceId(null);
            setUnacknowledgedDetectionIds([]);
            setActiveMapHiddenDetectionIds([]);
          }
        }
        if (event.type === 'live_telemetry') {
          setSnapshot((current) => {
            const recordedAt = new Set(current.track.map((point) => point.recorded_at));
            const trackPoints = event.update.track_points.filter(
              (point) => !recordedAt.has(point.recorded_at)
            );
            const rawTelemetryPackets = [
              ...current.raw_telemetry_packets,
              ...event.update.raw_telemetry_packets
            ].slice(-160);
            return {
              ...current,
              connection: event.update.connection,
              live_state: event.update.live_state,
              active_session_has_armed_telemetry:
                event.update.active_session_has_armed_telemetry,
              track: trackPoints.length > 0 ? [...current.track, ...trackPoints] : current.track,
              raw_telemetry_packets: rawTelemetryPackets,
              telemetry_ingest: event.update.telemetry_ingest
            };
          });
        }
        if (event.type === 'warning') {
          showBanner(event.message);
        }
      });
    })
      .then((listener) => {
        unlisten = listener;
      })
      .catch((error) => {
        showBanner(error instanceof Error ? error.message : 'Unable to subscribe to runtime events');
      });

    return () => {
      if (clearBannerRef.current) {
        window.clearTimeout(clearBannerRef.current);
      }
      if (lowSpeedLandingTimerRef.current) {
        window.clearTimeout(lowSpeedLandingTimerRef.current);
      }
      Object.values(notificationTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      notificationTimersRef.current = {};
      if (unlisten) {
        void unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (mapRegionReady) {
      return;
    }

    const handle = window.setTimeout(() => {
      void refreshOfflineRegions();
    }, 450);

    return () => {
      window.clearTimeout(handle);
    };
  }, [mapRegionReady, snapshot.config.enabled_region_ids]);

  useEffect(() => {
    const previousActiveSessionId = previousActiveSessionIdRef.current;
    const currentActiveSessionId = snapshot.active_session_id ?? null;
    if (previousActiveSessionId && !currentActiveSessionId && reviewMode) {
      setSelectedAlertId(null);
      setSelectedConvergenceId(null);
      setAlertDetailVisible(false);
    }
    previousActiveSessionIdRef.current = currentActiveSessionId;
  }, [reviewMode, snapshot.active_session_id]);

  useEffect(() => {
    const focusedSessionId = snapshot.focused_session_id ?? null;

    if (snapshot.active_session_id) {
      previousFocusedSessionIdRef.current = focusedSessionId;
      setReviewFrameIndex(null);
      return;
    }

    if (!focusedSessionId || reviewFrames.length === 0) {
      previousFocusedSessionIdRef.current = focusedSessionId;
      setReviewFrameIndex(null);
      return;
    }

    setReviewFrameIndex((current) => {
      const latestIndex = reviewFrames.length - 1;
      if (previousFocusedSessionIdRef.current !== focusedSessionId || current == null) {
        return latestIndex;
      }
      return Math.max(0, Math.min(current, latestIndex));
    });
    previousFocusedSessionIdRef.current = focusedSessionId;
  }, [reviewFrames.length, snapshot.active_session_id, snapshot.focused_session_id]);

  const activeFlight = Boolean(snapshot.active_session_id);
  const hasFlightContext = activeFlight || reviewMode;
  const flightLabel = activeSession?.name ?? focusedSession?.name ?? 'Ready';
  const showTelemetryHud = activeFlight || reviewMode;
  const panelOpen = activePanel === 'flights';
  const hasDetections = hasFlightContext && deferredAlerts.length > 0;
  const activeFlightHasDetections = activeFlight && deferredAlerts.length > 0;
  const activeFlightDetectionFlash = activeFlight && unacknowledgedDetectionIds.length > 0;
  const activeDetectionDetailOpen = activeFlight && alertDetailVisible && Boolean(selectedAlert);
  const dockMainHudRightForDetection =
    activeDetectionDetailOpen && viewportWidth >= 760 && viewportHeight < 920;
  const reviewDetectionDetailOpen = reviewMode && alertDetailVisible && Boolean(selectedAlert);
  const reviewExpandedHudOccluded =
    reviewDetectionDetailOpen && (viewportWidth < 1180 || viewportHeight < 900);
  const suppressExpandedHud =
    activeDetectionDetailOpen || reviewExpandedHudOccluded || measureToolActive;
  const visibleMapAlerts = useMemo(() => {
    if (selectedConvergence) {
      return deferredAlerts.filter((alert) => selectedConvergenceAlertIds.has(alert.id));
    }
    if (reviewMode) {
      return reviewDetectionDetailOpen ? deferredAlerts : [];
    }
    if (activeFlight) {
      if (activeDetectionDetailOpen) {
        return deferredAlerts;
      }
      const unacknowledgedIds = new Set(unacknowledgedDetectionIds);
      const hiddenIds = new Set(activeMapHiddenDetectionIds);
      return deferredAlerts.filter(
        (alert) => unacknowledgedIds.has(alert.id) && !hiddenIds.has(alert.id)
      );
    }
    return deferredAlerts;
  }, [
    activeDetectionDetailOpen,
    activeFlight,
    activeMapHiddenDetectionIds,
    deferredAlerts,
    reviewDetectionDetailOpen,
    reviewMode,
    selectedConvergence,
    selectedConvergenceAlertIds,
    unacknowledgedDetectionIds
  ]);
  const visibleMapAlertIds = useMemo(
    () => visibleMapAlerts.map((alert) => alert.id),
    [visibleMapAlerts]
  );
  const detectionViewingModeActive =
    hasFlightContext && alertDetailVisible && Boolean(selectedAlert);
  const visibleMapConvergences = detectionViewingModeActive ? detectionConvergences : [];
  const reviewHasVideoClips = reviewMode && snapshot.review_video_clips.length > 0;
  const flightHasReceivedConnection = Boolean(snapshot.connection.last_packet_at);
  const flightHasArmedTelemetry = snapshot.active_session_has_armed_telemetry;
  const videoDominant = activeFlight && activeFlightLayout === 'video-dominant';
  const mapIsCornerPane = activeFlight && videoDominant;
  const videoIsCornerPane = activeFlight && !videoDominant;
  const toolbarVideoMode = activeFlight && videoDominant;
  const videoPreview = snapshot.video_preview;

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (activeFlight && !previousActiveFlightRef.current) {
      setActiveFlightLayout('video-dominant');
      setReviewVideoOpen(false);
      setAlertDetailVisible(false);
      setSelectedAlertId(null);
      setSelectedConvergenceId(null);
      setUnacknowledgedDetectionIds([]);
      setActiveMapHiddenDetectionIds([]);
    }
    if (!activeFlight && previousActiveFlightRef.current) {
      setActiveFlightLayout('video-dominant');
      setSelectedConvergenceId(null);
      setUnacknowledgedDetectionIds([]);
      setActiveMapHiddenDetectionIds([]);
      dismissFlightNotification('active-flight-detection');
    }
    previousActiveFlightRef.current = activeFlight;
  }, [activeFlight]);
  useEffect(() => {
    if (activeFlight && activePanel === 'flights') {
      setActivePanel(null);
    }
  }, [activeFlight, activePanel]);

  useEffect(() => {
    if (!selectedConvergenceId) {
      return;
    }
    if (!selectedConvergence) {
      setSelectedConvergenceId(null);
    }
  }, [selectedConvergence, selectedConvergenceId]);

  useEffect(() => {
    if (!activeFlight) {
      setRawTelemetryOpen(false);
      setExpandedHudOpen(false);
    }
  }, [activeFlight]);

  useEffect(() => {
    if (!rawTelemetryOpen) {
      return;
    }
    const terminal = rawTelemetryLogRef.current;
    if (!terminal) {
      return;
    }
    terminal.scrollTop = terminal.scrollHeight;
  }, [rawTelemetryOpen, snapshot.raw_telemetry_packets]);

  useEffect(() => {
    if (!activeFlight) {
      seenSystemStatusIdsRef.current = new Set();
      armedAltitudeBaselineRef.current = null;
      armedAtTimestampRef.current = null;
      efficiencyAccumulatorRef.current = createEfficiencyAccumulator();
      setEfficiencyMetric({ liveWhPerKm: null, averageWhPerKm: null });
      setLowSpeedMonitoringEnabled(false);
      if (lowSpeedLandingTimerRef.current) {
        window.clearTimeout(lowSpeedLandingTimerRef.current);
        lowSpeedLandingTimerRef.current = null;
      }
      Object.values(notificationTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      notificationTimersRef.current = {};
      setFlightNotifications([]);
      return;
    }
  }, [activeFlight]);

  useEffect(() => {
    if (!activeFlight) {
      return;
    }

    if (
      displayLiveState?.armed &&
      armedAltitudeBaselineRef.current == null &&
      displayLiveState.alt_msl_m != null
    ) {
      armedAltitudeBaselineRef.current = displayLiveState.alt_msl_m;
    }
    if (displayLiveState?.armed && armedAtTimestampRef.current == null && displayLiveState.last_update_at) {
      armedAtTimestampRef.current = displayLiveState.last_update_at;
    }
  }, [activeFlight, displayLiveState?.alt_msl_m, displayLiveState?.armed]);

  useEffect(() => {
    if (!activeFlight) {
      return;
    }

    setEfficiencyMetric(
      updateEfficiencyAccumulator(displayLiveState, efficiencyAccumulatorRef.current)
    );
  }, [
    activeFlight,
    displayLiveState?.armed,
    displayLiveState?.battery?.voltage_v,
    displayLiveState?.groundspeed_mps,
    displayLiveState?.last_update_at,
    liveExtras
  ]);

  useEffect(() => {
    if (!activeFlight || lowSpeedMonitoringEnabled || !displayLiveState?.armed) {
      return;
    }

    const speed = displayLiveState.groundspeed_mps;
    if (speed == null || speed <= snapshot.config.flight_alerts.low_speed_warning_mps) {
      return;
    }

    const handle = window.setTimeout(() => {
      setLowSpeedMonitoringEnabled(true);
    }, 5000);

    return () => window.clearTimeout(handle);
  }, [
    activeFlight,
    displayLiveState?.armed,
    displayLiveState?.groundspeed_mps,
    lowSpeedMonitoringEnabled,
    snapshot.config.flight_alerts.low_speed_warning_mps
  ]);

  useEffect(() => {
    if (!activeFlight || !lowSpeedMonitoringEnabled) {
      if (lowSpeedLandingTimerRef.current) {
        window.clearTimeout(lowSpeedLandingTimerRef.current);
        lowSpeedLandingTimerRef.current = null;
      }
      return;
    }

    const speed = displayLiveState?.groundspeed_mps;
    if (speed == null || speed >= 4) {
      if (lowSpeedLandingTimerRef.current) {
        window.clearTimeout(lowSpeedLandingTimerRef.current);
        lowSpeedLandingTimerRef.current = null;
      }
      return;
    }

    if (!lowSpeedLandingTimerRef.current) {
      lowSpeedLandingTimerRef.current = window.setTimeout(() => {
        setLowSpeedMonitoringEnabled(false);
        lowSpeedLandingTimerRef.current = null;
      }, 3000);
    }
  }, [activeFlight, displayLiveState?.groundspeed_mps, lowSpeedMonitoringEnabled]);

  useEffect(() => {
    if (!activeFlight) {
      return;
    }

    const unseenStatuses = snapshot.system_statuses.filter(
      (status) => !seenSystemStatusIdsRef.current.has(status.id)
    );
    if (unseenStatuses.length === 0) {
      return;
    }

    unseenStatuses.forEach((status) => {
      seenSystemStatusIdsRef.current.add(status.id);
      const normalized = status.status.trim().toUpperCase();
      const severity: FlightNotificationSeverity = normalized.includes('ERROR') ||
        normalized.includes('FAIL') ||
        normalized.includes('WARN')
        ? 'warning'
        : normalized.includes('CAUTION')
          ? 'caution'
          : 'info';
      upsertFlightNotification({
        id: `status:${status.id}`,
        message: status.message,
        severity,
        persistent: severity === 'warning'
      });
    });
  }, [activeFlight, snapshot.system_statuses]);

  useEffect(() => {
    if (!regionMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!regionMenuRef.current?.contains(event.target as Node)) {
        setRegionMenuOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [regionMenuOpen]);

  const liveHudStatus = useMemo(() => {
    if (!activeFlight) {
      return null;
    }
    if (snapshot.connection.status === 'stale') {
      return { label: 'Link stale', variant: 'stale' as const };
    }
    if (!flightHasReceivedConnection) {
      return { label: 'Waiting', variant: 'waiting' as const };
    }
    if (!displayLiveState?.armed) {
      return { label: 'Awaiting arm', variant: 'pending' as const };
    }
    return { label: 'Ready', variant: 'connected' as const };
  }, [activeFlight, displayLiveState?.armed, flightHasReceivedConnection, snapshot.connection.status]);
  const visionHudStatus = useMemo(() => {
    if (!activeFlight && !reviewMode) {
      return null;
    }
    if (activeFlight && (!flightHasReceivedConnection || snapshot.connection.status === 'stale')) {
      return { label: 'Awaiting vision telemetry', variant: 'waiting' as const };
    }
    if (visionActive == null) {
      return {
        label: activeFlight ? 'Awaiting vision telemetry' : 'Vision pipeline unavailable',
        variant: 'waiting' as const
      };
    }
    if (visionActive) {
      return { label: 'Vision pipeline active', variant: 'connected' as const };
    }
    return {
      label: activeFlight ? 'Vision pipeline inactive' : 'Vision pipeline unavailable',
      variant: activeFlight ? ('pending' as const) : ('waiting' as const)
    };
  }, [activeFlight, flightHasReceivedConnection, reviewMode, snapshot.connection.status, visionActive]);
  const visionLinkAvailable =
    activeFlight && flightHasReceivedConnection && snapshot.connection.status !== 'stale';
  const visionRunning =
    !visionStopAcknowledged &&
    (visionActive === true || (visionStartupConfirmed && visionCommandState !== 'stopping'));
  const visionBusy = visionCommandState !== 'idle';

  useEffect(() => {
    if (!activeFlight) {
      setVisionCommandState('idle');
      setVisionStartupConfirmed(false);
      setVisionStopAcknowledged(false);
      latestVisionStatusIdRef.current = null;
      previousVisionActiveRef.current = null;
    }
  }, [activeFlight]);

  useEffect(() => {
    if (!activeFlight) {
      return;
    }

    const linkHealthy = flightHasReceivedConnection && snapshot.connection.status !== 'stale';
    const previousVisionActive = previousVisionActiveRef.current;

    if (visionActive === true) {
      if (visionStopAcknowledged) {
        return;
      }
      previousVisionActiveRef.current = true;
      if (visionCommandState !== 'stopping') {
        setVisionStopAcknowledged(false);
      }
      setVisionStartupConfirmed(true);
      if (visionCommandState === 'starting') {
        setVisionCommandState('idle');
      }
      dismissFlightNotification('vision:pipeline-failed');
      return;
    }

    if (visionActive === false) {
      if (visionCommandState === 'starting') {
        return;
      }

      if (visionStartupConfirmed && previousVisionActive !== true) {
        return;
      }

      if (visionCommandState === 'stopping') {
        previousVisionActiveRef.current = false;
        setVisionCommandState('idle');
        setVisionStartupConfirmed(false);
        setVisionStopAcknowledged(true);
        return;
      }

      if (previousVisionActive === true && linkHealthy && !visionStopAcknowledged) {
        upsertFlightNotification({
          id: 'vision:pipeline-failed',
          message: 'Vision pipeline stopped unexpectedly',
          severity: 'warning',
          persistent: true,
          dismissLabel: 'Dismiss'
        });
      }

      previousVisionActiveRef.current = false;
      setVisionStartupConfirmed(false);
      setVisionStopAcknowledged(false);
    }
  }, [
    activeFlight,
    flightHasReceivedConnection,
    snapshot.connection.status,
    visionActive,
    visionCommandState,
    visionStartupConfirmed,
    visionStopAcknowledged
  ]);

  useEffect(() => {
    if (!activeFlight) {
      return;
    }

    const latestVisionStatus = snapshot.system_statuses.find((status) => {
      const normalized = status.status.trim().toUpperCase();
      return normalized.includes('STARTUP') || normalized.includes('ERROR') || normalized.includes('FAIL');
    });
    if (!latestVisionStatus || latestVisionStatus.id === latestVisionStatusIdRef.current) {
      return;
    }

    latestVisionStatusIdRef.current = latestVisionStatus.id;
    const normalized = latestVisionStatus.status.trim().toUpperCase();
    if (normalized === 'STARTUP_SUCCESS') {
      setVisionStartupConfirmed(true);
      setVisionCommandState('idle');
      setVisionStopAcknowledged(false);
      dismissFlightNotification('vision:pipeline-failed');
      return;
    }

    if (normalized.includes('ERROR') || normalized.includes('FAIL')) {
      setVisionStartupConfirmed(false);
      setVisionCommandState('idle');
      setVisionStopAcknowledged(false);
      upsertFlightNotification({
        id: 'vision:pipeline-failed',
        message: visionCommandState === 'starting' ? 'Vision failed to start' : 'Vision pipeline reported a failure',
        severity: 'warning',
        persistent: true,
        dismissLabel: 'Dismiss'
      });
    }
  }, [activeFlight, snapshot.system_statuses, visionCommandState]);

  useEffect(() => {
    if (visionCommandState === 'idle') {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      const timedOutState = visionCommandState;
      setVisionCommandState('idle');
      if (timedOutState === 'starting') {
        setVisionStartupConfirmed(false);
        upsertFlightNotification({
          id: 'vision:pipeline-failed',
          message: 'Vision startup timed out',
          severity: 'warning',
          persistent: true,
          dismissLabel: 'Dismiss'
        });
      } else if (timedOutState === 'stopping') {
        upsertFlightNotification({
          id: 'vision:command-timeout',
          message: 'Vision stop command timed out',
          severity: 'warning',
          persistent: true,
          dismissLabel: 'Dismiss'
        });
      }
    }, 30000);

    return () => window.clearTimeout(timeoutId);
  }, [visionCommandState]);

  function handleVisionToggle() {
    if (!visionLinkAvailable || visionBusy) {
      return;
    }

    const enable = !visionRunning;
    setVisionCommandState(enable ? 'starting' : 'stopping');
    if (enable) {
      setVisionStopAcknowledged(false);
      setVisionStartupConfirmed(false);
      dismissFlightNotification('vision:pipeline-failed');
      dismissFlightNotification('vision:command-timeout');
    }
    if (!enable) {
      setVisionStopAcknowledged(false);
      dismissFlightNotification('vision:command-timeout');
    }

    void runCommand(async () => {
      try {
        const response = await setVisionPipelineEnabled(enable);
        if (enable && /already\s+(running|active)/i.test(response)) {
          setVisionStartupConfirmed(true);
          setVisionCommandState('idle');
          return;
        }
        if (!enable) {
          if (/not\s+running/i.test(response)) {
            setVisionCommandState('idle');
            setVisionStartupConfirmed(false);
            setVisionStopAcknowledged(true);
            previousVisionActiveRef.current = false;
          }
        }
      } catch (error) {
        setVisionCommandState('idle');
        if (enable) {
          setVisionStartupConfirmed(false);
        }
        throw error;
      }
    });
  }

  const visionControl = activeFlight
    ? {
        label: !visionLinkAvailable
          ? 'UNAVAILABLE'
          : visionCommandState === 'starting'
            ? 'STARTING'
            : visionCommandState === 'stopping'
              ? 'STOPPING'
              : visionRunning
                ? 'STOP VISION'
                : 'START VISION',
        disabled: !visionLinkAvailable,
        busy: visionBusy,
        active: visionRunning,
        onToggle: handleVisionToggle
      }
    : null;
  const telemetryMetricStates = useMemo(() => {
    const safeColor = '#f4f4f4';
    const cautionColor = '#ffb347';
    const warningColor = '#ff6b63';
    const batteryPercent = displayLiveState?.battery?.percent ?? null;
    const speed = displayLiveState?.groundspeed_mps ?? null;
    const altitude = displayLiveState?.alt_msl_m ?? null;
    const highSpeedWarning = snapshot.config.flight_alerts.high_speed_warning_mps;
    const highSpeedCaution = highSpeedWarning - 5;
    const lowSpeedWarning = snapshot.config.flight_alerts.low_speed_warning_mps;
    const lowBatteryWarning = snapshot.config.flight_alerts.low_battery_warning_percent;
    const lowBatteryCaution = lowBatteryWarning + 10;
    const armedAltitude = armedAltitudeBaselineRef.current;

    let speedState = buildMetricState('normal', safeColor, false);
    if (speed != null) {
      if (speed >= highSpeedWarning) {
        speedState = buildMetricState('warning', warningColor, true);
      } else if (speed >= highSpeedCaution) {
        const ratio = clamp((speed - highSpeedCaution) / Math.max(highSpeedWarning - highSpeedCaution, 0.1), 0, 1);
        speedState = buildMetricState('caution', mixHexColors(cautionColor, warningColor, ratio), true);
      } else if (lowSpeedMonitoringEnabled && speed <= lowSpeedWarning) {
        speedState = buildMetricState('warning', warningColor, true);
      } else if (lowSpeedMonitoringEnabled && speed < lowSpeedWarning + 5) {
        const ratio = clamp(1 - (speed - lowSpeedWarning) / 5, 0, 1);
        speedState = buildMetricState('caution', mixHexColors(cautionColor, warningColor, ratio), false);
      } else if (speed > highSpeedCaution - 5) {
        const ratio = clamp((speed - (highSpeedCaution - 5)) / 5, 0, 1);
        speedState = buildMetricState('normal', mixHexColors(safeColor, cautionColor, ratio), false);
      }
    }

    let altitudeState = buildMetricState('normal', safeColor, false);
    if (
      altitude != null &&
      armedAltitude != null &&
      altitude - armedAltitude >= snapshot.config.flight_alerts.high_altitude_warning_m
    ) {
      altitudeState = buildMetricState('warning', warningColor, true);
    }

    let batteryState = buildMetricState('normal', safeColor, false);
    if (batteryPercent != null) {
      if (batteryPercent <= lowBatteryWarning) {
        batteryState = buildMetricState('warning', warningColor, true);
      } else if (batteryPercent <= lowBatteryCaution) {
        const ratio = clamp(
          1 - (batteryPercent - lowBatteryWarning) / Math.max(lowBatteryCaution - lowBatteryWarning, 1),
          0,
          1
        );
        batteryState = buildMetricState('caution', mixHexColors(cautionColor, warningColor, ratio), true);
      } else if (batteryPercent <= lowBatteryCaution + 12) {
        const ratio = clamp(1 - (batteryPercent - lowBatteryCaution) / 12, 0, 1);
        batteryState = buildMetricState('normal', mixHexColors(safeColor, cautionColor, ratio), false);
      }
    }

    const derivedNotifications: FlightNotificationRecord[] = [];
    if (activeFlight) {
      if (speed != null) {
        if (speed >= highSpeedWarning) {
          derivedNotifications.push({
            id: 'telemetry:speed-high-warning',
            message: `High speed warning: ${speed.toFixed(1)} m/s`,
            severity: 'warning',
            persistent: true
          });
        } else if (speed >= highSpeedCaution) {
          derivedNotifications.push({
            id: 'telemetry:speed-high-caution',
            message: `High speed caution: ${speed.toFixed(1)} m/s`,
            severity: 'caution',
            persistent: false
          });
        } else if (lowSpeedMonitoringEnabled && speed <= lowSpeedWarning) {
          derivedNotifications.push({
            id: 'telemetry:speed-low-warning',
            message: `Low speed warning: ${speed.toFixed(1)} m/s`,
            severity: 'warning',
            persistent: true
          });
        }
      }
      if (
        altitude != null &&
        armedAltitude != null &&
        altitude - armedAltitude >= snapshot.config.flight_alerts.high_altitude_warning_m
      ) {
        derivedNotifications.push({
          id: 'telemetry:altitude-high-warning',
          message: `High altitude warning: ${(altitude - armedAltitude).toFixed(1)} m above arm altitude`,
          severity: 'warning',
          persistent: true
        });
      }
      if (batteryPercent != null) {
        if (batteryPercent <= lowBatteryWarning) {
          derivedNotifications.push({
            id: 'telemetry:battery-low-warning',
            message: `Low battery warning: ${batteryPercent.toFixed(0)}% remaining`,
            severity: 'warning',
            persistent: true
          });
        } else if (batteryPercent <= lowBatteryCaution) {
          derivedNotifications.push({
            id: 'telemetry:battery-low-caution',
            message: `Low battery caution: ${batteryPercent.toFixed(0)}% remaining`,
            severity: 'caution',
            persistent: false
          });
        }
      }
    }

    return {
      speed: speedState,
      altitude: altitudeState,
      battery: batteryState,
      notifications: derivedNotifications
    };
  }, [
    activeFlight,
    displayLiveState?.alt_msl_m,
    displayLiveState?.groundspeed_mps,
    displayLiveState?.battery?.percent,
    lowSpeedMonitoringEnabled,
    snapshot.config.flight_alerts.high_altitude_warning_m,
    snapshot.config.flight_alerts.high_speed_warning_mps,
    snapshot.config.flight_alerts.low_battery_warning_percent,
    snapshot.config.flight_alerts.low_speed_warning_mps,
    snapshot.connection.status
  ]);
  const linkPulseActive =
    activeFlight &&
    flightHasReceivedConnection &&
    snapshot.connection.status !== 'stale' &&
    snapshot.connection.status !== 'listening';

  useEffect(() => {
    if (!reviewMode || !reviewPlaybackActive || effectiveReviewFrameIndex == null || reviewFrames.length < 2) {
      return;
    }

    if (effectiveReviewFrameIndex >= reviewFrames.length - 1) {
      setReviewPlaybackActive(false);
      return;
    }

    const currentTimestamp = new Date(
      reviewFrames[effectiveReviewFrameIndex].recorded_at
    ).getTime();
    const nextTimestamp = new Date(
      reviewFrames[effectiveReviewFrameIndex + 1].recorded_at
    ).getTime();
    const deltaMs = Number.isFinite(currentTimestamp) && Number.isFinite(nextTimestamp)
      ? Math.max(16, Math.round(Math.max(nextTimestamp - currentTimestamp, 16) / reviewPlaybackSpeed))
      : Math.max(16, Math.round(1000 / reviewPlaybackSpeed));

    const timer = window.setTimeout(() => {
      setReviewFrameIndex((current) => {
        const baseIndex = current ?? effectiveReviewFrameIndex;
        return Math.min(baseIndex + 1, reviewFrames.length - 1);
      });
    }, deltaMs);

    return () => window.clearTimeout(timer);
  }, [
    effectiveReviewFrameIndex,
    reviewFrames,
    reviewMode,
    reviewPlaybackActive,
    reviewPlaybackSpeed
  ]);

  useEffect(() => {
    if (!reviewMode) {
      setReviewPlaybackActive(false);
    }
  }, [reviewMode]);

  useEffect(() => {
    const telemetryIds = new Set(
      flightNotifications
        .filter((notification) => notification.id.startsWith('telemetry:'))
        .map((notification) => notification.id)
    );
    const activeIds = new Set(
      telemetryMetricStates.notifications.map((notification) => notification.id)
    );

    telemetryMetricStates.notifications.forEach((notification) => {
      upsertFlightNotification(notification);
    });

    telemetryIds.forEach((notificationId) => {
      if (!activeIds.has(notificationId)) {
        dismissFlightNotification(notificationId);
      }
    });
  }, [flightNotifications, telemetryMetricStates.notifications]);

  function togglePanel(panel: Exclude<OverlayPanel, null>) {
    if (panel === 'flights' && activeFlight) {
      return;
    }
    setActivePanel((current) => (current === panel ? null : panel));
  }

  function handleSelectAlert(alertId: string) {
    if (reviewMode && alertDetailVisible && selectedAlertId === alertId) {
      closeDetectionPanel();
      return;
    }
    setSelectedConvergenceId(null);
    setSelectedAlertId(alertId);
    setAlertDetailVisible(true);
    setActivePanel(null);
  }

  function openDetectionPanel() {
    const targetAlert =
      [...deferredAlerts].reverse().find((alert) => unacknowledgedDetectionIds.includes(alert.id)) ??
      deferredAlerts[0];
    if (!targetAlert) {
      return;
    }
    setUnacknowledgedDetectionIds([]);
    setActiveMapHiddenDetectionIds([]);
    dismissFlightNotification('active-flight-detection');
    setSelectedConvergenceId(null);
    handleSelectAlert(targetAlert.id);
  }

  function closeDetectionPanel() {
    setAlertDetailVisible(false);
    setSelectedAlertId(null);
    setSelectedConvergenceId(null);
  }

  function handleSelectConvergence(convergenceId: string) {
    if (selectedConvergenceId === convergenceId) {
      setSelectedConvergenceId(null);
      return;
    }
    const convergence = detectionConvergences.find((entry) => entry.id === convergenceId);
    if (!convergence) {
      return;
    }
    const firstAssociatedAlert = deferredAlerts.find((alert) =>
      convergence.alertIds.includes(alert.id)
    );
    if (!firstAssociatedAlert) {
      return;
    }
    setSelectedConvergenceId(convergence.id);
    setSelectedAlertId(firstAssociatedAlert.id);
    setAlertDetailVisible(true);
    setActivePanel(null);
  }

  function handleFollowModeChange(enabled: boolean) {
    upsertFlightNotification({
      id: 'follow-mode',
      message: enabled ? 'follow enabled' : 'follow disabled',
      severity: 'info',
      persistent: false,
      durationMs: 3000
    });
  }

  function stepDetection(direction: -1 | 1) {
    if (detectionNavigationAlerts.length === 0) {
      return;
    }
    const currentIndex = selectedAlertIndex >= 0 ? selectedAlertIndex : 0;
    const nextIndex = Math.max(
      0,
      Math.min(currentIndex + direction, detectionNavigationAlerts.length - 1)
    );
    const nextAlert = detectionNavigationAlerts[nextIndex];
    if (!nextAlert) {
      return;
    }
    setSelectedAlertId(nextAlert.id);
    setAlertDetailVisible(true);
    setActivePanel(null);
  }

  function handleFocusSession(sessionId: string) {
    setSelectedAlertId(null);
    setSelectedConvergenceId(null);
    setAlertDetailVisible(false);
    setReviewFrameIndex(null);
    setReviewPlaybackActive(false);
    setReviewVideoOpen(false);
    void runCommand(async () => {
      await focusSession(sessionId);
      setActivePanel(null);
    });
  }

  function handleClearReview() {
    setSelectedAlertId(null);
    setSelectedConvergenceId(null);
    setAlertDetailVisible(false);
    setReviewPlaybackActive(false);
    setReviewVideoOpen(false);
    void runCommand(() => clearFocusedSession());
  }

  function handleReviewFrameChange(index: number) {
    setReviewFrameIndex(index);
  }

  function handleToggleReviewPlayback() {
    if (!reviewMode || reviewFrames.length === 0) {
      return;
    }
    if (!reviewPlaybackActive && effectiveReviewFrameIndex != null && effectiveReviewFrameIndex >= reviewFrames.length - 1) {
      setReviewFrameIndex(0);
    }
    setReviewPlaybackActive((current) => !current);
  }

  function handleSelectReviewPlaybackSpeed(speed: number) {
    setReviewPlaybackSpeed(speed);
  }

  function openStopFlightPrompt() {
    setStopFlightName(activeSession?.name ?? '');
    setStopFlightDescription(activeSession?.description ?? '');
    setStopFlightOpen(true);
  }

  function handleMapModeChange(nextMode: AppSnapshot['config']['default_map_mode']) {
    if (nextMode === snapshot.config.default_map_mode) {
      return;
    }

    void runCommand(async () => {
      await updateConfig({
        ...snapshot.config,
        default_map_mode: nextMode
      });
    });
  }

  function swapFlightSurfaces() {
    if (!activeFlight) {
      return;
    }
    setActiveFlightLayout((current) =>
      current === 'video-dominant' ? 'map-dominant' : 'video-dominant'
    );
  }

  function openExportPrompt(sessionId: string) {
    const session = snapshot.sessions.find((entry) => entry.id === sessionId);
    setExportFlightTarget({
      id: sessionId,
      name: session?.name ?? 'Saved flight',
      alertCount: session?.alert_count ?? 0
    });
  }

  async function handleExportSession(sessionId: string, choice: ExportChoice) {
    const savedPaths: string[] = [];
    if (choice === 'telemetry' || choice === 'both') {
      savedPaths.push(await exportSessionTelemetry(sessionId));
    }
    if (choice === 'detections' || choice === 'both') {
      savedPaths.push(await exportSessionDetections(sessionId));
    }
    const exportName =
      choice === 'telemetry'
        ? savedPaths[0]?.split(/[\\/]/).filter(Boolean).pop() ?? 'Telemetry export.csv'
        : choice === 'detections'
          ? savedPaths[0]?.split(/[\\/]/).filter(Boolean).pop() ?? 'Detection export'
          : 'Telemetry and detections';
    upsertFlightNotification({
      id: `export:${sessionId}:${Date.now()}`,
      message: `${exportName} saved to Downloads`,
      severity: 'info',
      persistent: false,
      placement: reviewMode ? 'review-above-replay' : 'default'
    });
    setExportFlightTarget(null);
  }

  const elevatedNotifications = reviewMode
    ? flightNotifications.filter((notification) => notification.placement === 'review-above-replay')
    : [];
  const baseNotifications = flightNotifications.filter(
    (notification) => notification.placement !== 'review-above-replay' || !reviewMode
  );
  const mapElement = (
    <LiveMap
      config={snapshot.config}
      liveState={displayLiveState}
      track={displayTrack}
      alerts={visibleMapAlerts}
      selectedAlertId={selectedAlertId}
      highlightedAlertIds={visibleMapAlertIds}
      convergences={visibleMapConvergences}
      selectedConvergenceId={selectedConvergenceId}
      convergenceAlerts={visibleMapAlerts}
      enabledRegions={mapRegionReady ? enabledRegions : []}
      selectedRegion={mapRegionReady ? selectedRegion : null}
      assetOrigin={mapRegionReady ? offlineCatalog.asset_origin : null}
      mapMode={mapMode}
      activeFlight={activeFlight}
      reviewMode={reviewMode}
      linkPulseActive={linkPulseActive}
      compactFlightView={mapIsCornerPane}
      forceFollow={mapIsCornerPane}
      preferredInitialView={activeFlight ? lastIdleMapView : null}
      measureToolbarHost={!mapIsCornerPane ? measureToolbarHostRef.current : null}
      focusTarget={reviewInitialMapFocusTarget}
      focusKey={reviewInitialMapFocusKey}
      onViewStateChange={(view) => {
        if (!activeFlight) {
          setLastIdleMapView(view);
        }
      }}
      onFollowModeChange={handleFollowModeChange}
      onMeasureModeChange={setMeasureToolActive}
      onSelectAlert={handleSelectAlert}
      onSelectConvergence={handleSelectConvergence}
    />
  );
  const exportTargetDetectionsKnown =
    exportFlightTarget?.id != null && exportFlightTarget.id === snapshot.focused_session_id;
  const exportTargetHasDetections =
    (exportFlightTarget?.alertCount ?? 0) > 0 ||
    (exportTargetDetectionsKnown &&
      deferredAlerts.some((alert) => alert.session_id === exportFlightTarget?.id));

  return (
    <div className="console-shell">
      <div className={`map-shell ${activeFlight ? 'map-shell--flight-mode' : ''}`}>
        <div
          className={`flight-surface-layout ${
            activeFlight
              ? videoDominant
                ? 'flight-surface-layout--video-dominant'
                : 'flight-surface-layout--map-dominant'
              : 'flight-surface-layout--idle'
          }`}
        >
          <div
            className={`flight-surface flight-surface--video ${
              activeFlight
                ? videoDominant
                  ? 'flight-surface--dominant'
                  : 'flight-surface--corner'
                : 'flight-surface--hidden'
            }`}
          >
            <LiveVideoPane
              video={videoPreview}
              dominant={videoDominant}
              onSwap={swapFlightSurfaces}
            />
          </div>
          <div
            className={`flight-surface flight-surface--map ${
              activeFlight
                ? videoDominant
                  ? 'flight-surface--corner'
                  : 'flight-surface--dominant'
                : 'flight-surface--dominant'
            }`}
          >
            {mapElement}
            {mapIsCornerPane ? (
              <button
                type="button"
                className="flight-surface__swap-hitbox"
                onClick={swapFlightSurfaces}
                aria-label="Show map in main view"
              />
            ) : null}
          </div>
        </div>

        {bannerMessage ? (
          <div className="warning-banner warning-banner--overlay">
            <span>{bannerMessage}</span>
            <button
              className="secondary-button secondary-button--muted"
              onClick={() => setBannerMessage(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {baseNotifications.length > 0 ? (
          <div className="flight-notification-stack" role="status" aria-live="polite">
            {baseNotifications.map((notification) => (
              <div
                key={notification.id}
                className={`flight-notification flight-notification--${notification.severity} ${
                  notification.closing ? 'flight-notification--closing' : ''
                } ${
                  notification.actionType === 'open-detections'
                    ? 'flight-notification--interactive'
                    : ''
                }`}
                onClick={() => {
                  if (notification.actionType === 'open-detections') {
                    handleFlightNotificationAction(notification, 'open');
                  }
                }}
              >
                <span>{notification.message}</span>
                {notification.actionLabel || notification.dismissLabel ? (
                  <div className="flight-notification__actions">
                    {notification.actionLabel ? (
                      <button
                        className="secondary-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleFlightNotificationAction(notification, 'open');
                        }}
                      >
                        {notification.actionLabel}
                      </button>
                    ) : null}
                    {notification.dismissLabel ? (
                      <button
                        className="secondary-button secondary-button--muted"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleFlightNotificationAction(notification, 'dismiss');
                        }}
                      >
                        {notification.dismissLabel}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {elevatedNotifications.length > 0 ? (
          <div
            className="flight-notification-stack flight-notification-stack--review-export"
            role="status"
            aria-live="polite"
          >
            {elevatedNotifications.map((notification) => (
              <div
                key={notification.id}
                className={`flight-notification flight-notification--${notification.severity} ${
                  notification.closing ? 'flight-notification--closing' : ''
                }`}
              >
                <span>{notification.message}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="map-toolbar">
          <div className="map-toolbar__group">
            <button
              className="primary-toggle"
              onClick={() => {
                if (reviewMode) {
                  handleClearReview();
                  return;
                }
                if (activeFlight) {
                  if (!flightHasArmedTelemetry) {
                    void runCommand(() => completeActiveStream(false));
                    return;
                  }
                  openStopFlightPrompt();
                  return;
                }
                void runCommand(() => startLiveIngest());
              }}
            >
              {reviewMode ? 'End Review' : activeFlight ? 'End flight' : 'Start flight'}
            </button>
            {reviewMode ? (
              <>
                {focusedSession?.id ? (
                  <button
                    className="secondary-button secondary-button--muted save-row__icon-button"
                    onClick={() => openExportPrompt(focusedSession.id)}
                    title="Export flight data"
                    aria-label="Export flight data"
                  >
                    <ExportIcon />
                  </button>
                ) : null}
              </>
            ) : null}
            {activeFlight ? (
              <>
                <button
                  className={`secondary-button flight-detections-button ${
                    activeFlightDetectionFlash ? 'flight-detections-button--flash' : ''
                  } ${!activeFlightHasDetections ? 'flight-detections-button--empty' : ''}`}
                  onClick={openDetectionPanel}
                  disabled={!activeFlightHasDetections}
                >
                  <span>Detections</span>
                  <span className="flight-detections-button__count">{deferredAlerts.length}</span>
                </button>
              </>
            ) : null}
          </div>

          <div className="map-toolbar__group">
            {!toolbarVideoMode ? (
              <div className="map-mode-toggle" role="tablist" aria-label="Basemap mode">
                <button
                  className={`secondary-button ${mapMode === 'street_dark' ? 'secondary-button--active' : ''}`}
                  onClick={() => handleMapModeChange('street_dark')}
                >
                  Street
                </button>
                <button
                  className={`secondary-button ${mapMode === 'satellite' ? 'secondary-button--active' : ''}`}
                  onClick={() => handleMapModeChange('satellite')}
                >
                  Satellite
                </button>
              </div>
            ) : null}
            {!toolbarVideoMode ? (
              <>
                <div ref={regionMenuRef} className="toolbar-select">
                  <button
                    className={`secondary-button toolbar-select__button ${
                      regionMenuOpen ? 'secondary-button--active' : ''
                    }`}
                    onClick={() => {
                      if (enabledRegions.length === 0) {
                        return;
                      }
                      setRegionMenuOpen((current) => !current);
                    }}
                    disabled={enabledRegions.length === 0}
                    aria-expanded={regionMenuOpen}
                    aria-label="Select region"
                  >
                    <span>{selectedRegionLabel}</span>
                    <span className="toolbar-select__chevron" aria-hidden="true" />
                  </button>
                  {regionMenuOpen && enabledRegions.length > 0 ? (
                    <div className="toolbar-select__menu">
                      {enabledRegions.map((region) => (
                        <button
                          key={region.id}
                          className={`toolbar-select__option ${
                            selectedRegion?.id === region.id ? 'toolbar-select__option--active' : ''
                          }`}
                          onClick={() => {
                            setRegionMenuOpen(false);
                            void runCommand(async () => {
                              await selectOfflineRegion(region.id);
                            });
                          }}
                        >
                          {getRegionDisplayName(region, snapshot.config.region_name_overrides)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div ref={measureToolbarHostRef} className="toolbar-measure-slot" />
                <button
                  className={`secondary-button ${activePanel === 'flights' ? 'secondary-button--active' : ''}`}
                  onClick={() => togglePanel('flights')}
                  disabled={activeFlight}
                >
                  Flights
                </button>
              </>
            ) : null}
            <button
              className={`secondary-button ${activePanel === 'settings' ? 'secondary-button--active' : ''}`}
              onClick={() => setActivePanel((current) => (current === 'settings' ? null : 'settings'))}
            >
              Settings
            </button>
          </div>
        </div>

        {showTelemetryHud ? (
          <TelemetryHud
            liveState={displayLiveState}
            mode={activeFlight ? 'live' : 'review'}
            altitudeAglM={displayAltitudeAgl}
            altitudeMslM={displayAltitudeMsl}
            targetAltitudeAglM={displayTargetAltitudeAgl}
            liveConnectionState={liveHudStatus}
            visionStatus={visionHudStatus}
            visionValue={visionActive}
            visionControl={visionControl}
            flightModeLabel={flightModeLabel}
            batteryPercent={displayLiveState?.battery?.percent ?? null}
            attitude={{
              pitchDeg,
              rollDeg
            }}
            metricStates={activeFlight ? telemetryMetricStates : undefined}
            expandedHud={
              (activeFlight || reviewMode) && !suppressExpandedHud
                ? {
                    open: activeFlight ? expandedHudOpen : reviewMode,
                    cpuTempC,
                    cpuPercent,
                    cpuClockMhz: cpuMhz,
                    npuTempC,
                    throttlePct,
                    verticalSpeedMps,
                    vibrationX,
                    vibrationY,
                    vibrationZ,
                    altitudeMslM: displayAltitudeMsl,
                    targetAltitudeMslM,
                    batteryMahConsumed,
                    liveEfficiencyWhPerKm: displayEfficiencyMetric.liveWhPerKm,
                    averageEfficiencyWhPerKm: displayEfficiencyMetric.averageWhPerKm
                  }
                : null
            }
            mainDock={dockMainHudRightForDetection ? 'right' : 'left'}
            onOpenRawData={activeFlight ? () => setRawTelemetryOpen(true) : undefined}
            onToggleExpandedHud={
              activeFlight ? () => setExpandedHudOpen((current) => !current) : undefined
            }
          />
        ) : null}

        {activeDetectionDetailOpen && selectedAlert ? (
          <div className="telemetry-hud-layer telemetry-hud-layer--detection-detail">
            <div className="telemetry-hud-stack telemetry-hud-stack--detection-detail">
              <AlertDetail
                alert={selectedAlert}
                config={snapshot.config}
                alertIndex={Math.max(selectedAlertIndex, 0)}
                alertCount={detectionNavigationAlerts.length}
                onPrevious={() => stepDetection(-1)}
                onNext={() => stepDetection(1)}
                canPrevious={selectedAlertIndex > 0}
                canNext={
                  selectedAlertIndex >= 0 &&
                  selectedAlertIndex < detectionNavigationAlerts.length - 1
                }
                onClose={closeDetectionPanel}
              />
            </div>
          </div>
        ) : null}

        {detectionViewingModeActive && selectedConvergence ? (
          <div
            className={`convergence-location-chip ${
              reviewMode ? 'convergence-location-chip--review' : ''
            }`}
          >
            Convergence at {selectedConvergence.lat.toFixed(5)}, {selectedConvergence.lon.toFixed(5)}
          </div>
        ) : null}

        {reviewMode && reviewFrames.length > 0 && effectiveReviewFrameIndex != null ? (
          <ReplayTimeline
            flightName={focusedSession?.name ?? 'Saved flight'}
            frames={reviewFrames}
            selectedIndex={effectiveReviewFrameIndex}
            markers={[]}
            selectedMarkerId={null}
            hasRecordings={reviewHasVideoClips}
            playbackActive={reviewPlaybackActive}
            playbackSpeed={reviewPlaybackSpeed}
            onChange={handleReviewFrameChange}
            onSelectMarker={() => {}}
            onRenameFlightName={(name) => {
              if (!focusedSession?.id) {
                return;
              }
              void runCommand(() =>
                updateSessionDetails(focusedSession.id, name, focusedSession.description ?? null)
              );
            }}
            onTogglePlayback={handleToggleReviewPlayback}
            onSelectPlaybackSpeed={handleSelectReviewPlaybackSpeed}
            onOpenRecordings={() => setReviewVideoOpen(true)}
          />
        ) : null}

        {alertDetailVisible && selectedAlert && !activeFlight ? (
            <AlertDetail
              alert={selectedAlert}
              config={snapshot.config}
              alertIndex={Math.max(selectedAlertIndex, 0)}
              alertCount={detectionNavigationAlerts.length}
              onPrevious={() => stepDetection(-1)}
              onNext={() => stepDetection(1)}
              canPrevious={selectedAlertIndex > 0}
              canNext={
                selectedAlertIndex >= 0 &&
                selectedAlertIndex < detectionNavigationAlerts.length - 1
              }
              onClose={closeDetectionPanel}
            />
        ) : null}

        {reviewMode && hasDetections && !alertDetailVisible ? (
          <button className="detection-toggle-fab" onClick={openDetectionPanel}>
            <span className="detection-toggle-fab__label">Detections</span>
            <span className="detection-toggle-fab__count">{deferredAlerts.length}</span>
          </button>
        ) : null}

        {panelOpen ? (
          <>
            <button
              className="drawer-backdrop drawer-backdrop--map"
              onClick={() => setActivePanel(null)}
              aria-label="Close panel"
            />
            <aside className="overlay-drawer">
              {activePanel === 'flights' ? (
                <FlightSavesPanel
                  sessions={snapshot.sessions}
                  focusedSessionId={snapshot.focused_session_id}
                  activeSessionId={snapshot.active_session_id}
                  onFocusSession={handleFocusSession}
                  onUpdateSession={(sessionId, name, description) =>
                    void runCommand(() => updateSessionDetails(sessionId, name, description))
                  }
                  onRequestDeleteSession={(sessionId, name) =>
                    setDeleteFlightTarget({ id: sessionId, name })
                  }
                  onExportSession={openExportPrompt}
                />
              ) : null}
            </aside>
          </>
        ) : null}
      </div>

        {reviewMode && reviewVideoOpen && snapshot.review_video_clips.length > 0 ? (
          <ReviewVideoModal
            clips={snapshot.review_video_clips}
            onClose={() => setReviewVideoOpen(false)}
          />
        ) : null}

        <SettingsDrawer
          open={activePanel === 'settings'}
          config={snapshot.config}
          regions={offlineCatalog.regions}
          regionsError={offlineRegionsError}
          onClose={() => setActivePanel(null)}
          onRefreshRegions={() => refreshOfflineRegions(true)}
          onSave={async (config) => {
          await updateConfig(config);
        }}
      />

      {stopFlightOpen ? (
        <>
          <button
            className="modal-backdrop"
            onClick={() => setStopFlightOpen(false)}
            aria-label="Close stop flight prompt"
          />
          <section className="modal-card">
            <div className="modal-card__header">
              <div>
                <span className="section-title">Save flight</span>
                <strong>{flightLabel}</strong>
              </div>
              <button
                className="secondary-button secondary-button--muted"
                onClick={() => setStopFlightOpen(false)}
              >
                Cancel
              </button>
            </div>

            <label className="modal-field">
              <span>Name</span>
              <input
                className="save-name-input"
                value={stopFlightName}
                onChange={(event) => setStopFlightName(event.target.value)}
                placeholder="Flight name"
              />
            </label>

            <label className="modal-field">
              <span>Description</span>
              <textarea
                className="save-name-input modal-textarea"
                value={stopFlightDescription}
                onChange={(event) => setStopFlightDescription(event.target.value)}
                rows={4}
                placeholder="Optional notes about this flight"
              />
            </label>

            <div className="modal-card__actions">
              <button
                className="primary-toggle"
                onClick={() =>
                  void runCommand(async () => {
                    await completeActiveStream(true, stopFlightName, stopFlightDescription);
                    setStopFlightOpen(false);
                  })
                }
              >
                Save
              </button>
              <button
                className="secondary-button secondary-button--danger"
                onClick={() =>
                  void runCommand(async () => {
                    await completeActiveStream(false, stopFlightName, stopFlightDescription);
                    setStopFlightOpen(false);
                  })
                }
              >
                Discard
              </button>
            </div>
          </section>
        </>
      ) : null}

      {deleteFlightTarget ? (
        <>
          <button
            className="modal-backdrop"
            onClick={() => setDeleteFlightTarget(null)}
            aria-label="Close delete flight prompt"
          />
          <section className="modal-card">
            <div className="modal-card__header">
              <div>
                <span className="section-title">Delete flight</span>
                <strong>{deleteFlightTarget.name}</strong>
              </div>
              <button
                className="secondary-button secondary-button--muted"
                onClick={() => setDeleteFlightTarget(null)}
              >
                Cancel
              </button>
            </div>

            <p className="modal-copy">
              This will permanently remove the saved flight, detections, track history, and stored
              images.
            </p>

            <div className="modal-card__actions">
              <button
                className="secondary-button secondary-button--danger"
                onClick={() =>
                  void runCommand(async () => {
                    await deleteSession(deleteFlightTarget.id);
                    setDeleteFlightTarget(null);
                  })
                }
              >
                Delete
              </button>
            </div>
          </section>
        </>
      ) : null}

      {exportFlightTarget ? (
        <>
          <button
            className="modal-backdrop"
            onClick={() => setExportFlightTarget(null)}
            aria-label="Close export options"
          />
          <section className="modal-card export-choice-modal">
            <div className="modal-card__header">
              <div>
                <span className="section-title">Export flight</span>
                <strong>{exportFlightTarget.name}</strong>
              </div>
            </div>

            <div className="modal-card__actions modal-card__actions--stacked">
              <button
                className="secondary-button"
                onClick={() =>
                  void runCommand(() => handleExportSession(exportFlightTarget.id, 'telemetry'))
                }
              >
                Flight log
              </button>
              <button
                className="secondary-button"
                disabled={!exportTargetHasDetections}
                onClick={() =>
                  void runCommand(() => handleExportSession(exportFlightTarget.id, 'detections'))
                }
              >
                Detections
              </button>
              <button
                className="secondary-button"
                disabled={!exportTargetHasDetections}
                onClick={() =>
                  void runCommand(() => handleExportSession(exportFlightTarget.id, 'both'))
                }
              >
                Both
              </button>
              <button
                className="secondary-button"
                onClick={() => setExportFlightTarget(null)}
              >
                Cancel
              </button>
            </div>
          </section>
        </>
      ) : null}

      {activeFlight && rawTelemetryOpen ? (
        <>
          <button
            className="modal-backdrop"
            onClick={() => setRawTelemetryOpen(false)}
            aria-label="Close raw telemetry panel"
          />
          <section className="modal-card raw-data-modal">
            <div className="modal-card__header">
              <div>
                <span className="section-title">Raw telemetry</span>
                <strong>Live ingest feed</strong>
              </div>
              <button
                className="secondary-button secondary-button--muted"
                onClick={() => setRawTelemetryOpen(false)}
              >
                Close
              </button>
            </div>

            <div
              ref={rawTelemetryLogRef}
              className="raw-data-terminal"
              role="log"
              aria-live="polite"
              aria-label="Raw telemetry packets"
            >
              {snapshot.raw_telemetry_packets.length > 0 ? (
                snapshot.raw_telemetry_packets.map((packet, index) => (
                  <pre key={`${index}-${packet.slice(0, 32)}`} className="raw-data-terminal__line">
                    {packet}
                  </pre>
                ))
              ) : (
                <div className="raw-data-terminal__empty">Waiting for telemetry packets...</div>
              )}
            </div>
          </section>
        </>
      ) : null}

    </div>
  );
}
