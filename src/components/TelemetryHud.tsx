import type { AircraftLiveState } from '../lib/types';
import { formatTimestamp } from '../lib/time';

interface TelemetryHudProps {
  liveState?: AircraftLiveState | null;
  mode: 'live' | 'review';
  reviewTimestamp?: string | null;
  liveConnectionState?: {
    label: string;
    variant: 'waiting' | 'pending' | 'connected' | 'stale';
  } | null;
  onOpenRawData?: (() => void) | undefined;
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
  const positionLabel = positionAvailable
    ? `${liveState!.lat!.toFixed(5)}, ${liveState!.lon!.toFixed(5)}`
    : '--';
  return positionLabel;
}

export function TelemetryHud({
  liveState,
  mode,
  reviewTimestamp,
  liveConnectionState,
  onOpenRawData
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
      </div>
      <div className="telemetry-hud__grid">
        <div>
          <span className="telemetry-hud__label">Altitude</span>
          <strong>{renderValue(liveState?.alt_msl_m, ' m')}</strong>
        </div>
        <div>
          <span className="telemetry-hud__label">Speed</span>
          <strong>{renderValue(liveState?.groundspeed_mps, ' m/s')}</strong>
        </div>
        <div>
          <span className="telemetry-hud__label">Heading</span>
          <strong>{renderWholeValue(liveState?.heading_deg, ' deg')}</strong>
        </div>
        <div>
          <span className="telemetry-hud__label">Battery</span>
          <strong>{renderValue(liveState?.battery?.voltage_v, ' V')}</strong>
          <span className="telemetry-hud__subvalue">
            {liveState?.battery?.percent != null
              ? `${liveState.battery.percent.toFixed(0)}%`
              : '--'}
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
