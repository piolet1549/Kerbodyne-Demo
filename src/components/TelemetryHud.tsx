import type { AircraftLiveState, HudMetricState } from '../lib/types';
import { formatTimestamp } from '../lib/time';

interface TelemetryHudProps {
  liveState?: AircraftLiveState | null;
  mode: 'live' | 'review';
  reviewTimestamp?: string | null;
  liveConnectionState?: {
    label: string;
    variant: 'waiting' | 'pending' | 'connected' | 'stale';
  } | null;
  metricStates?: {
    altitude?: HudMetricState;
    speed?: HudMetricState;
    battery?: HudMetricState;
  };
  onOpenRawData?: (() => void) | undefined;
  onExportTelemetry?: (() => void) | undefined;
}

function renderValue(value?: number | null, suffix = ''): string {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value.toFixed(1)}${suffix}`;
}

function renderWholeValue(value?: number | null, suffix = ''): string {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value.toFixed(0)}${suffix}`;
}

function renderPositionLabel(liveState?: AircraftLiveState | null) {
  const positionAvailable =
    liveState?.armed &&
    liveState.lat != null &&
    !Number.isNaN(liveState.lat) &&
    liveState.lon != null &&
    !Number.isNaN(liveState.lon);
  return positionAvailable ? `${liveState!.lat!.toFixed(5)}, ${liveState!.lon!.toFixed(5)}` : '--';
}

function metricClasses(state?: HudMetricState) {
  return [
    'telemetry-hud__metric-value',
    state?.tone ? `telemetry-hud__metric-value--${state.tone}` : '',
    state?.pulse ? 'telemetry-hud__metric-value--pulse' : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function metricStyle(state?: HudMetricState) {
  if (!state?.color_hex) {
    return undefined;
  }
  return { color: state.color_hex };
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

export function TelemetryHud({
  liveState,
  mode,
  reviewTimestamp,
  liveConnectionState,
  metricStates,
  onOpenRawData,
  onExportTelemetry
}: TelemetryHudProps) {
  const positionLabel = renderPositionLabel(liveState);

  return (
    <div className="telemetry-hud">
      <div className="telemetry-hud__topline">
        <div className="telemetry-hud__row telemetry-hud__row--wide">
          <span className="telemetry-hud__label">
            {mode === 'review' ? 'Replay position' : 'Position'}
          </span>
          <strong>{positionLabel}</strong>
          {mode === 'review' && reviewTimestamp ? (
            <span className="telemetry-hud__subvalue">{formatTimestamp(reviewTimestamp)}</span>
          ) : null}
        </div>

        {mode === 'live' && liveConnectionState ? (
          <span className={`telemetry-hud__status telemetry-hud__status--${liveConnectionState.variant}`}>
            {liveConnectionState.label}
          </span>
        ) : null}

        {mode === 'review' && onExportTelemetry ? (
          <button
            className="secondary-button telemetry-hud__export-button"
            onClick={onExportTelemetry}
            aria-label="Export flight telemetry"
            title="Export flight telemetry"
          >
            <ExportIcon />
          </button>
        ) : null}
      </div>

      <div className="telemetry-hud__grid">
        <div>
          <span className="telemetry-hud__label">Altitude</span>
          <strong
            className={metricClasses(metricStates?.altitude)}
            style={metricStyle(metricStates?.altitude)}
          >
            {renderValue(liveState?.alt_msl_m, ' m')}
          </strong>
        </div>
        <div>
          <span className="telemetry-hud__label">Speed</span>
          <strong
            className={metricClasses(metricStates?.speed)}
            style={metricStyle(metricStates?.speed)}
          >
            {renderValue(liveState?.groundspeed_mps, ' m/s')}
          </strong>
        </div>
        <div>
          <span className="telemetry-hud__label">Heading</span>
          <strong className="telemetry-hud__metric-value">
            {renderWholeValue(liveState?.heading_deg, ' deg')}
          </strong>
        </div>
        <div>
          <span className="telemetry-hud__label">Battery</span>
          <strong
            className={metricClasses(metricStates?.battery)}
            style={metricStyle(metricStates?.battery)}
          >
            {renderValue(liveState?.battery?.voltage_v, ' V')}
          </strong>
          <span
            className={`telemetry-hud__subvalue ${
              metricStates?.battery?.pulse ? 'telemetry-hud__subvalue--pulse' : ''
            }`}
            style={metricStyle(metricStates?.battery)}
          >
            {liveState?.battery?.percent != null ? `${liveState.battery.percent.toFixed(0)}%` : '--'}
          </span>
        </div>
      </div>

      {mode === 'live' && onOpenRawData ? (
        <div className="telemetry-hud__actions">
          <button className="secondary-button telemetry-hud__action" onClick={onOpenRawData}>
            View raw data
          </button>
        </div>
      ) : null}
    </div>
  );
}
