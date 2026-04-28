import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { AlertDetail } from './components/AlertDetail';
import { FlightSavesPanel } from './components/FlightSavesPanel';
import { LiveMap } from './components/LiveMap';
import { ReplayTimeline } from './components/ReplayTimeline';
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
  startLiveIngest,
  updateSessionDetails,
  updateConfig
} from './lib/runtime';
import type {
  AlertRecord,
  AppSnapshot,
  HudMetricState,
  OfflineRegionCatalog,
  RuntimeEvent
} from './lib/types';

type OverlayPanel = 'flights' | 'settings' | null;
type FlightNotificationSeverity = 'info' | 'caution' | 'warning';

interface FlightNotificationRecord {
  id: string;
  message: string;
  severity: FlightNotificationSeverity;
  persistent: boolean;
  closing?: boolean;
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

function sanitizeExportFileName(value: string) {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'flight-telemetry';
}

export function App() {
  const measureToolbarHostRef = useRef<HTMLDivElement | null>(null);
  const rawTelemetryLogRef = useRef<HTMLDivElement | null>(null);
  const regionMenuRef = useRef<HTMLDivElement | null>(null);
  const notificationTimersRef = useRef<Record<string, number>>({});
  const seenSystemStatusIdsRef = useRef<Set<string>>(new Set());
  const armedAltitudeBaselineRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [offlineCatalog, setOfflineCatalog] = useState<OfflineRegionCatalog>({
    asset_origin: '',
    regions: []
  });
  const [offlineRegionsError, setOfflineRegionsError] = useState<string | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<OverlayPanel>(null);
  const [alertDetailVisible, setAlertDetailVisible] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [stopFlightOpen, setStopFlightOpen] = useState(false);
  const [rawTelemetryOpen, setRawTelemetryOpen] = useState(false);
  const [deleteFlightTarget, setDeleteFlightTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [regionMenuOpen, setRegionMenuOpen] = useState(false);
  const [stopFlightName, setStopFlightName] = useState('');
  const [stopFlightDescription, setStopFlightDescription] = useState('');
  const [reviewFrameIndex, setReviewFrameIndex] = useState<number | null>(null);
  const [flightNotifications, setFlightNotifications] = useState<FlightNotificationRecord[]>([]);
  const [lowSpeedMonitoringEnabled, setLowSpeedMonitoringEnabled] = useState(false);
  const clearBannerRef = useRef<number | null>(null);
  const previousAlertCountRef = useRef(0);
  const previousFocusedSessionIdRef = useRef<string | null>(null);
  const previousActiveSessionIdRef = useRef<string | null>(null);

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
  const displayLiveState = reviewMode ? selectedReviewFrame?.live_state ?? null : snapshot.live_state;
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
        return hasValidPosition(lat, lon) ? ([[lat, lon]] as [number, number][]) : [];
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
    return lastTrackPoint ?? null;
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
      }, 10000);
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
    }, 6000);
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
          setSelectedAlertId((current) => {
            const mostRecent = findMostRecentAlert(event.snapshot.alerts);
            const hasNewAlert =
              Boolean(event.snapshot.active_session_id) &&
              event.snapshot.alerts.length > previousAlertCountRef.current;
            previousAlertCountRef.current = event.snapshot.alerts.length;

            if (hasNewAlert && mostRecent) {
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
  const flightHasReceivedConnection = Boolean(snapshot.connection.last_packet_at);
  const flightHasArmedTelemetry = snapshot.active_session_has_armed_telemetry;
  useEffect(() => {
    if (activeFlight && activePanel === 'flights') {
      setActivePanel(null);
    }
  }, [activeFlight, activePanel]);

  useEffect(() => {
    if (!activeFlight) {
      setRawTelemetryOpen(false);
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
      setLowSpeedMonitoringEnabled(false);
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
      if (snapshot.connection.status === 'stale') {
        derivedNotifications.push({
          id: 'telemetry:link-stale',
          message: 'Telemetry link is stale',
          severity: 'warning',
          persistent: true
        });
      }
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
    displayLiveState?.battery?.percent,
    displayLiveState?.groundspeed_mps,
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
    void runCommand(async () => {
      await focusSession(sessionId);
      setActivePanel(null);
    });
  }

  function handleClearReview() {
    setSelectedAlertId(null);
    setAlertDetailVisible(false);
    void runCommand(() => clearFocusedSession());
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

  async function handleExportSession(sessionId: string) {
    const session = snapshot.sessions.find((entry) => entry.id === sessionId);
    const chosenPath = await save({
      title: 'Export telemetry',
      defaultPath: `${sanitizeExportFileName(session?.name ?? 'flight-telemetry')}.csv`,
      filters: [
        {
          name: 'CSV',
          extensions: ['csv']
        }
      ]
    });
    if (!chosenPath) {
      return;
    }
    const exportPath = chosenPath.toLowerCase().endsWith('.csv') ? chosenPath : `${chosenPath}.csv`;
    await exportSessionTelemetry(sessionId, exportPath);
  }

  return (
    <div className="console-shell">
      <div className="map-shell">
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
          measureToolbarHost={measureToolbarHostRef.current}
          focusTarget={mapFocusTarget}
          focusKey={mapFocusKey}
          onSelectAlert={handleSelectAlert}
        />

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

        {activeFlight && flightNotifications.length > 0 ? (
          <div className="flight-notification-stack" role="status" aria-live="polite">
            {flightNotifications.map((notification) => (
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
          </div>

          <div className="map-toolbar__group">
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
            reviewTimestamp={selectedReviewFrame?.recorded_at ?? null}
            liveConnectionState={liveHudStatus}
            metricStates={activeFlight ? telemetryMetricStates : undefined}
            onOpenRawData={activeFlight ? () => setRawTelemetryOpen(true) : undefined}
            onExportTelemetry={
              reviewMode && focusedSession?.id
                ? () =>
                    void runCommand(() =>
                      handleExportSession(focusedSession.id)
                    )
                : undefined
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
            onChange={setReviewFrameIndex}
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
          />
        ) : null}

        {alertDetailVisible && selectedAlert ? (
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
        ) : null}

        {hasDetections && !alertDetailVisible ? (
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
