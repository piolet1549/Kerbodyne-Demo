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
  exportSessionTelemetry,
  focusSession,
  listOfflineRegions,
  listenToRuntimeEvents,
  selectOfflineRegion,
  startVideoRecording,
  startLiveIngest,
  stopVideoRecording,
  updateSessionDetails,
  updateConfig
} from './lib/runtime';
import type { AlertRecord, AppSnapshot, HudMetricState, OfflineRegionCatalog, RuntimeEvent } from './lib/types';

type OverlayPanel = 'flights' | 'settings' | null;
type FlightNotificationSeverity = 'info' | 'caution' | 'warning';

interface FlightNotificationRecord {
  id: string;
  message: string;
  severity: FlightNotificationSeverity;
  persistent: boolean;
  placement?: 'default' | 'review-above-replay';
  actionLabel?: string;
  dismissLabel?: string;
  actionType?: 'open-detections' | 'dismiss-detection';
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
  raw_telemetry_packets: [],
  warnings: []
};

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

function formatFlightModeLabel(value: string | number | null | undefined) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `Mode ${Math.round(value)}`;
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

function findNearestFrameIndex(frames: AppSnapshot['review_frames'], timestamp: string) {
  if (frames.length === 0) {
    return 0;
  }
  const target = new Date(timestamp).getTime();
  if (!Number.isFinite(target)) {
    return frames.length - 1;
  }
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const current = new Date(frame.recorded_at).getTime();
    if (!Number.isFinite(current)) {
      return;
    }
    const distance = Math.abs(current - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export function App() {
  const measureToolbarHostRef = useRef<HTMLDivElement | null>(null);
  const rawTelemetryLogRef = useRef<HTMLDivElement | null>(null);
  const regionMenuRef = useRef<HTMLDivElement | null>(null);
  const notificationTimersRef = useRef<Record<string, number>>({});
  const seenSystemStatusIdsRef = useRef<Set<string>>(new Set());
  const armedAltitudeBaselineRef = useRef<number | null>(null);
  const armedAtTimestampRef = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [offlineCatalog, setOfflineCatalog] = useState<OfflineRegionCatalog>({
    asset_origin: '',
    regions: []
  });
  const [offlineRegionsError, setOfflineRegionsError] = useState<string | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<OverlayPanel>(null);
  const [alertDetailVisible, setAlertDetailVisible] = useState(false);
  const [activeFlightLayout, setActiveFlightLayout] = useState<'video-dominant' | 'map-dominant'>(
    'video-dominant'
  );
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [stopFlightOpen, setStopFlightOpen] = useState(false);
  const [rawTelemetryOpen, setRawTelemetryOpen] = useState(false);
  const [expandedHudOpen, setExpandedHudOpen] = useState(false);
  const [reviewVideoOpen, setReviewVideoOpen] = useState(false);
  const [deleteFlightTarget, setDeleteFlightTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [regionMenuOpen, setRegionMenuOpen] = useState(false);
  const [stopFlightName, setStopFlightName] = useState('');
  const [stopFlightDescription, setStopFlightDescription] = useState('');
  const [reviewFrameIndex, setReviewFrameIndex] = useState<number | null>(null);
  const [reviewPlaybackActive, setReviewPlaybackActive] = useState(false);
  const [reviewPlaybackSpeed, setReviewPlaybackSpeed] = useState(1);
  const [lastIdleMapView, setLastIdleMapView] = useState<{
    center: [number, number];
    zoom: number;
    bearing: number;
  } | null>(null);
  const [flightNotifications, setFlightNotifications] = useState<FlightNotificationRecord[]>([]);
  const [unacknowledgedDetectionIds, setUnacknowledgedDetectionIds] = useState<string[]>([]);
  const [lowSpeedMonitoringEnabled, setLowSpeedMonitoringEnabled] = useState(false);
  const clearBannerRef = useRef<number | null>(null);
  const previousAlertCountRef = useRef(0);
  const previousFocusedSessionIdRef = useRef<string | null>(null);
  const previousActiveSessionIdRef = useRef<string | null>(null);
  const previousActiveFlightRef = useRef(false);
  const lowSpeedLandingTimerRef = useRef<number | null>(null);
  const cpuThrottleTimerRef = useRef<number | null>(null);

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
  const pitchDeg = readNumberExtra(liveExtras, 'pitch_deg');
  const rollDeg = readNumberExtra(liveExtras, 'roll_deg');
  const navPitchDeg = readNumberExtra(liveExtras, 'nav_pitch_deg');
  const navRollDeg = readNumberExtra(liveExtras, 'nav_roll_deg');
  const targetAltitudeMslM = readNumberExtra(liveExtras, 'alt_demanded_m');
  const throttlePct = readNumberExtra(liveExtras, 'throttle_pct');
  const verticalSpeedMps = readNumberExtra(liveExtras, 'vspeed_ms');
  const vibrationX = readNumberExtra(liveExtras, 'vib_x');
  const vibrationY = readNumberExtra(liveExtras, 'vib_y');
  const vibrationZ = readNumberExtra(liveExtras, 'vib_z');
  const cpuTempC = readNumberExtra(liveExtras, 'cpu_temp_c');
  const cpuPercent = readNumberExtra(liveExtras, 'cpu_pct');
  const cpuMhz = readNumberExtra(liveExtras, 'cpu_mhz');
  const npuTempC = readNumberExtra(liveExtras, 'npu_temp_c');
  const visionActive = readBooleanExtra(liveExtras, 'vision_active');
  const displayTrack = useMemo(() => {
    if (!reviewMode) {
      return snapshot.track;
    }
    if (effectiveReviewFrameIndex == null || reviewFrames.length === 0) {
      return snapshot.track;
    }

    return reviewFrames
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
  }, [effectiveReviewFrameIndex, reviewFrames, reviewMode, snapshot.track]);
  const selectedAlert = useMemo<AlertRecord | null>(
    () => deferredAlerts.find((alert) => alert.id === selectedAlertId) ?? null,
    [deferredAlerts, selectedAlertId]
  );
  const selectedAlertIndex = useMemo(
    () => deferredAlerts.findIndex((alert) => alert.id === selectedAlertId),
    [deferredAlerts, selectedAlertId]
  );
  const mapFocusTarget = useMemo<[number, number] | null>(() => {
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
  const mapFocusKey = reviewMode
    ? `${snapshot.focused_session_id ?? 'none'}:${effectiveReviewFrameIndex ?? 'none'}`
    : null;

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
        }, 5000);
      }
    }

  function handleFlightNotificationAction(notification: FlightNotificationRecord, action: 'open' | 'dismiss') {
    if (notification.actionType === 'open-detections' && action === 'open') {
      setUnacknowledgedDetectionIds([]);
      openDetectionPanel();
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
      showBanner(error instanceof Error ? error.message : 'Command failed');
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

            const mostRecent = findMostRecentAlert(event.snapshot.alerts);
            if (!Boolean(event.snapshot.active_session_id) && mostRecent && event.snapshot.alerts.length > previousAlertCount) {
              setAlertDetailVisible(true);
              return mostRecent.id;
            }

            if (!current) {
              return null;
            }
            return event.snapshot.alerts.some((alert) => alert.id === current)
              ? current
              : null;
          });

          if (event.snapshot.alerts.length === 0) {
            setAlertDetailVisible(false);
            setUnacknowledgedDetectionIds([]);
          }
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
  const reviewHasVideoClips = reviewMode && snapshot.review_video_clips.length > 0;
  const flightHasReceivedConnection = Boolean(snapshot.connection.last_packet_at);
  const flightHasArmedTelemetry = snapshot.active_session_has_armed_telemetry;
  const videoDominant = activeFlight && activeFlightLayout === 'video-dominant';
  const mapIsCornerPane = activeFlight && videoDominant;
  const videoIsCornerPane = activeFlight && !videoDominant;
  const toolbarVideoMode = activeFlight && videoDominant;
  const videoPreview = snapshot.video_preview;
  const feedUnavailable =
    videoPreview.status === 'idle' ||
    videoPreview.status === 'waiting_for_stream' ||
    videoPreview.status === 'waiting_for_keyframe' ||
    videoPreview.status === 'error';
  const recordButtonDisabled = !videoPreview.recording_active && feedUnavailable;
  useEffect(() => {
    if (activeFlight && !previousActiveFlightRef.current) {
      setActiveFlightLayout('video-dominant');
      setReviewVideoOpen(false);
      setAlertDetailVisible(false);
      setSelectedAlertId(null);
      setUnacknowledgedDetectionIds([]);
    }
    if (!activeFlight && previousActiveFlightRef.current) {
      setActiveFlightLayout('video-dominant');
      setUnacknowledgedDetectionIds([]);
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
    if (!activeFlight) {
      setRawTelemetryOpen(false);
      setExpandedHudOpen(false);
      if (cpuThrottleTimerRef.current) {
        window.clearTimeout(cpuThrottleTimerRef.current);
        cpuThrottleTimerRef.current = null;
      }
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

    if (!displayLiveState?.armed) {
      armedAltitudeBaselineRef.current = null;
      return;
    }

    if (armedAltitudeBaselineRef.current == null && displayLiveState.alt_msl_m != null) {
      armedAltitudeBaselineRef.current = displayLiveState.alt_msl_m;
    }
    if (armedAtTimestampRef.current == null && displayLiveState.last_update_at) {
      armedAtTimestampRef.current = displayLiveState.last_update_at;
    }
  }, [activeFlight, displayLiveState?.alt_msl_m, displayLiveState?.armed]);

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
    const notificationId = 'telemetry:cpu-throttle-warning';
    const clearThrottleTimer = () => {
      if (cpuThrottleTimerRef.current) {
        window.clearTimeout(cpuThrottleTimerRef.current);
        cpuThrottleTimerRef.current = null;
      }
    };

    if (!activeFlight) {
      clearThrottleTimer();
      dismissFlightNotification(notificationId);
      return;
    }

    if (cpuMhz != null && cpuMhz < 2400) {
      const throttledMessage = `CPU throttling detected: ${(cpuMhz / 1000).toFixed(2)} GHz`;
      const existingWarning = flightNotifications.find(
        (notification) => notification.id === notificationId && !notification.closing
      );

      if (existingWarning) {
        upsertFlightNotification({
          id: notificationId,
          message: throttledMessage,
          severity: 'warning',
          persistent: true
        });
        return;
      }

      if (!cpuThrottleTimerRef.current) {
        cpuThrottleTimerRef.current = window.setTimeout(() => {
          upsertFlightNotification({
            id: notificationId,
            message: throttledMessage,
            severity: 'warning',
            persistent: true
          });
          cpuThrottleTimerRef.current = null;
        }, 5000);
      }
      return;
    }

    clearThrottleTimer();
    dismissFlightNotification(notificationId);
  }, [activeFlight, cpuMhz, flightNotifications]);

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
    if (activeFlight && snapshot.connection.status === 'stale') {
      return { label: 'Vision telemetry stale', variant: 'stale' as const };
    }
    if (!flightHasReceivedConnection && activeFlight) {
      return { label: 'Awaiting vision telemetry', variant: 'waiting' as const };
    }
    if (visionActive) {
      return { label: 'Vision pipeline active', variant: 'connected' as const };
    }
    return {
      label: activeFlight ? 'Vision pipeline inactive' : 'Vision pipeline unavailable',
      variant: activeFlight ? ('pending' as const) : ('waiting' as const)
    };
  }, [activeFlight, flightHasReceivedConnection, reviewMode, snapshot.connection.status, visionActive]);
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
  const reviewDetectionMarkers = useMemo(
    () =>
      reviewMode && reviewFrames.length > 0
        ? deferredAlerts
            .map((alert) => ({
              id: alert.id,
              index: findNearestFrameIndex(reviewFrames, alert.detected_at)
            }))
            .sort((first, second) => first.index - second.index)
        : [],
    [deferredAlerts, reviewFrames, reviewMode]
  );
  const reviewDetectionMarkerIndex = useMemo(
    () => new Map(reviewDetectionMarkers.map((marker) => [marker.id, marker.index])),
    [reviewDetectionMarkers]
  );
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

  useEffect(() => {
    if (!reviewMode || !selectedAlertId || effectiveReviewFrameIndex == null) {
      return;
    }
    const selectedMarkerFrame = reviewDetectionMarkerIndex.get(selectedAlertId);
    if (selectedMarkerFrame == null) {
      return;
    }
    if (selectedMarkerFrame !== effectiveReviewFrameIndex) {
      setSelectedAlertId(null);
      setAlertDetailVisible(false);
    }
  }, [
    effectiveReviewFrameIndex,
    reviewDetectionMarkerIndex,
    reviewMode,
    selectedAlertId
  ]);

  function togglePanel(panel: Exclude<OverlayPanel, null>) {
    if (panel === 'flights' && activeFlight) {
      return;
    }
    setActivePanel((current) => (current === panel ? null : panel));
  }

  function handleSelectAlert(alertId: string) {
    setSelectedAlertId(alertId);
    setAlertDetailVisible(true);
    setActivePanel(null);
    if (reviewMode) {
      const markerIndex = reviewDetectionMarkerIndex.get(alertId);
      if (markerIndex != null) {
        setReviewFrameIndex(markerIndex);
      }
    }
  }

  function openDetectionPanel() {
    const firstAlert = deferredAlerts[0];
    if (!firstAlert) {
      return;
    }
    setUnacknowledgedDetectionIds([]);
    dismissFlightNotification('active-flight-detection');
    handleSelectAlert(firstAlert.id);
  }

  function stepDetection(direction: -1 | 1) {
    if (deferredAlerts.length === 0) {
      return;
    }
    const currentIndex = selectedAlertIndex >= 0 ? selectedAlertIndex : 0;
    const nextIndex = Math.max(0, Math.min(currentIndex + direction, deferredAlerts.length - 1));
    const nextAlert = deferredAlerts[nextIndex];
    if (!nextAlert) {
      return;
    }
    handleSelectAlert(nextAlert.id);
  }

  function handleFocusSession(sessionId: string) {
    setSelectedAlertId(null);
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
    setAlertDetailVisible(false);
    setReviewPlaybackActive(false);
    setReviewVideoOpen(false);
    void runCommand(() => clearFocusedSession());
  }

  function handleReviewFrameChange(index: number) {
    setReviewFrameIndex(index);
    if (!selectedAlertId) {
      return;
    }
    const selectedMarkerFrame = reviewDetectionMarkerIndex.get(selectedAlertId);
    if (selectedMarkerFrame == null || selectedMarkerFrame !== index) {
      setSelectedAlertId(null);
      setAlertDetailVisible(false);
    }
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

  async function handleToggleRecording() {
    if (!activeFlight) {
      return;
    }
    if (snapshot.video_preview.recording_active) {
      await stopVideoRecording();
      return;
    }
    await startVideoRecording();
  }

  async function handleExportSession(sessionId: string) {
    const exportPath = await exportSessionTelemetry(sessionId);
    const exportFileName =
      exportPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Telemetry export.csv';
    upsertFlightNotification({
      id: `export:${sessionId}:${Date.now()}`,
      message: `${exportFileName} saved to Downloads`,
      severity: 'info',
      persistent: false,
      placement: reviewMode ? 'review-above-replay' : 'default'
    });
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
      alerts={deferredAlerts}
      selectedAlertId={selectedAlertId}
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
      focusTarget={mapFocusTarget}
      focusKey={mapFocusKey}
      onViewStateChange={(view) => {
        if (!activeFlight) {
          setLastIdleMapView(view);
        }
      }}
      onSelectAlert={handleSelectAlert}
    />
  );

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
                    onClick={() =>
                      void runCommand(() => handleExportSession(focusedSession.id))
                    }
                    title="Export telemetry"
                    aria-label="Export telemetry"
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
            {activeFlight ? (
              <button
                className={`secondary-button ${
                  videoPreview.recording_active ? 'secondary-button--active' : ''
                }`}
                onClick={() => void runCommand(handleToggleRecording)}
                disabled={recordButtonDisabled}
              >
                {videoPreview.recording_active ? 'Stop recording' : 'Record'}
              </button>
            ) : null}
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
            targetAltitudeMslM={targetAltitudeMslM}
            liveConnectionState={liveHudStatus}
            visionStatus={visionHudStatus}
            visionValue={visionActive}
            flightModeLabel={flightModeLabel}
            batteryPercent={displayLiveState?.battery?.percent ?? null}
            attitude={{
              pitchDeg,
              rollDeg,
              navPitchDeg,
              navRollDeg
            }}
            metricStates={activeFlight ? telemetryMetricStates : undefined}
            expandedHud={
              (activeFlight || reviewMode)
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
                    targetAltitudeMslM
                  }
                : null
            }
            onOpenRawData={activeFlight ? () => setRawTelemetryOpen(true) : undefined}
            onToggleExpandedHud={
              activeFlight ? () => setExpandedHudOpen((current) => !current) : undefined
            }
          />
        ) : null}

        {reviewMode && reviewFrames.length > 0 && effectiveReviewFrameIndex != null ? (
          <ReplayTimeline
            flightName={focusedSession?.name ?? 'Saved flight'}
            frames={reviewFrames}
            selectedIndex={effectiveReviewFrameIndex}
            markers={reviewDetectionMarkers}
            selectedMarkerId={selectedAlertId}
            hasRecordings={reviewHasVideoClips}
            playbackActive={reviewPlaybackActive}
            playbackSpeed={reviewPlaybackSpeed}
            onChange={handleReviewFrameChange}
            onSelectMarker={(markerId, markerIndex) => {
              setReviewFrameIndex(markerIndex);
              setSelectedAlertId(markerId);
              setAlertDetailVisible(true);
            }}
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

        {alertDetailVisible && selectedAlert ? (
          activeFlight ? (
            <>
              <button
                className="modal-backdrop"
                onClick={() => {
                  setAlertDetailVisible(false);
                  setSelectedAlertId(null);
                }}
                aria-label="Close detection details"
              />
              <div className="alert-detail-modal">
                <AlertDetail
                  alert={selectedAlert}
                  config={snapshot.config}
                  alertIndex={Math.max(selectedAlertIndex, 0)}
                  alertCount={deferredAlerts.length}
                  onPrevious={() => stepDetection(-1)}
                  onNext={() => stepDetection(1)}
                  canPrevious={selectedAlertIndex > 0}
                  canNext={selectedAlertIndex >= 0 && selectedAlertIndex < deferredAlerts.length - 1}
                  onClose={() => {
                    setAlertDetailVisible(false);
                    setSelectedAlertId(null);
                  }}
                />
              </div>
            </>
          ) : (
            <AlertDetail
              alert={selectedAlert}
              config={snapshot.config}
              alertIndex={Math.max(selectedAlertIndex, 0)}
              alertCount={deferredAlerts.length}
              onPrevious={() => stepDetection(-1)}
              onNext={() => stepDetection(1)}
              canPrevious={selectedAlertIndex > 0}
              canNext={selectedAlertIndex >= 0 && selectedAlertIndex < deferredAlerts.length - 1}
              onClose={() => {
                setAlertDetailVisible(false);
                setSelectedAlertId(null);
              }}
            />
          )
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
                  onExportSession={(sessionId) =>
                    void runCommand(() => handleExportSession(sessionId))
                  }
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
