import type { AircraftLiveState, HudMetricState } from '../lib/types';

type HudStatusVariant = 'waiting' | 'pending' | 'connected' | 'stale';

interface HudStatus {
  label: string;
  variant: HudStatusVariant;
}

interface ExpandedHudData {
  open: boolean;
  cpuTempC?: number | null;
  cpuPercent?: number | null;
  cpuClockMhz?: number | null;
  npuTempC?: number | null;
  throttlePct?: number | null;
  verticalSpeedMps?: number | null;
  vibrationX?: number | null;
  vibrationY?: number | null;
  vibrationZ?: number | null;
  altitudeMslM?: number | null;
  targetAltitudeMslM?: number | null;
  batteryMahConsumed?: number | null;
  liveEfficiencyWhPerKm?: number | null;
  averageEfficiencyWhPerKm?: number | null;
}

interface VisionControlState {
  label: string;
  disabled: boolean;
  busy: boolean;
  active: boolean;
  onToggle: () => void;
}

interface AttitudeData {
  pitchDeg?: number | null;
  rollDeg?: number | null;
}

interface TelemetryHudProps {
  liveState?: AircraftLiveState | null;
  mode: 'live' | 'review';
  altitudeAglM?: number | null;
  altitudeMslM?: number | null;
  targetAltitudeAglM?: number | null;
  liveConnectionState?: HudStatus | null;
  visionStatus?: HudStatus | null;
  visionValue?: boolean | null;
  visionControl?: VisionControlState | null;
  flightModeLabel: string;
  batteryPercent?: number | null;
  attitude?: AttitudeData | null;
  metricStates?: {
    altitude?: HudMetricState;
    speed?: HudMetricState;
    battery?: HudMetricState;
  };
  expandedHud?: ExpandedHudData | null;
  mainDock?: 'left' | 'right';
  onOpenRawData?: (() => void) | undefined;
  onToggleExpandedHud?: (() => void) | undefined;
}

function renderValue(value?: number | null, suffix = ''): string {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value.toFixed(1)}${suffix}`;
}

function renderWholeValue(value?: number | null, suffix = ''): string {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value.toFixed(0)}${suffix}`;
}

function renderHeadingValue(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--';
  const normalized = ((Math.round(value) % 360) + 360) % 360;
  return normalized.toString().padStart(3, '0');
}

function renderHeadingDegrees(value?: number | null): string {
  const heading = renderHeadingValue(value);
  return heading === '--' ? '--' : `${heading} deg`;
}

function renderHeadingCardinal(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--';
  const normalized = ((value % 360) + 360) % 360;
  const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(normalized / 45) % cardinals.length;
  return cardinals[index];
}

function renderSpeedMph(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--';
  return `${(value * 2.2369362920544).toFixed(1)} mph`;
}

function renderEfficiency(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value.toFixed(1)} Wh/km`;
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatSignedPitchLabel(value: number) {
  return `${value > 0 ? '+' : ''}${value}`;
}

function AttitudeIndicator({ attitude }: { attitude?: AttitudeData | null }) {
  const pitch = attitude?.pitchDeg ?? 0;
  const roll = attitude?.rollDeg ?? 0;
  const displayPitch = -pitch;
  const displayRoll = -roll;
  const pitchScale = 2.2;
  const horizonTranslateY = clamp(displayPitch * pitchScale, -188, 188);
  const horizonRotate = clamp(displayRoll, -85, 85);
  const pitchMarks = Array.from({ length: 18 }, (_, index) => -90 + index * 10).filter(
    (mark) => mark !== 0
  );

  return (
    <div className="telemetry-hud__attitude-shell" aria-label="Attitude indicator">
      <div className="telemetry-hud__attitude">
        <div className="telemetry-hud__attitude-roll-arc" />
        <div className="telemetry-hud__attitude-roll-notch" />
        <div className="telemetry-hud__attitude-mask">
          <div className="telemetry-hud__attitude-roll-plane" style={{ transform: `rotate(${horizonRotate}deg)` }}>
            <div
              className="telemetry-hud__attitude-horizon"
              style={{ transform: `translateY(${horizonTranslateY}px)` }}
            >
              <div className="telemetry-hud__attitude-sky" />
              <div className="telemetry-hud__attitude-ground" />
              <div className="telemetry-hud__attitude-line" />
              {pitchMarks.map((mark) => (
                <div
                  key={mark}
                  className="telemetry-hud__attitude-pitch-mark"
                  style={{ top: `calc(50% + ${mark * -2.4}px)` }}
                >
                  <span className="telemetry-hud__attitude-pitch-label">
                    {formatSignedPitchLabel(mark)}
                  </span>
                  <span className="telemetry-hud__attitude-pitch-bar" />
                  <span className="telemetry-hud__attitude-pitch-label">
                    {formatSignedPitchLabel(mark)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="telemetry-hud__attitude-aircraft" />
      </div>
    </div>
  );
}

function VisionIndicator({
  mode,
  status,
  value,
  control
}: {
  mode: 'live' | 'review';
  status?: HudStatus | null;
  value?: boolean | null;
  control?: VisionControlState | null;
}) {
  if (mode === 'review') {
    return (
      <div className="telemetry-hud__vision-indicator telemetry-hud__vision-indicator--review">
        <span className="telemetry-hud__label">Vision</span>
        <strong title={status?.label} aria-label={status?.label}>
          {value == null ? '--' : value ? 'on' : 'off'}
        </strong>
      </div>
    );
  }

  if (control) {
    const className = [
      'telemetry-hud__vision-indicator',
      'telemetry-hud__vision-indicator--button',
      control.active ? 'telemetry-hud__vision-indicator--active' : '',
      control.busy ? 'telemetry-hud__vision-indicator--busy' : '',
      control.disabled ? 'telemetry-hud__vision-indicator--disabled' : ''
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        type="button"
        className={className}
        title={status?.label}
        aria-label={status?.label ?? control.label}
        disabled={control.disabled || control.busy}
        onClick={control.onToggle}
      >
        <span className="telemetry-hud__vision-label">{control.label}</span>
      </button>
    );
  }

  const className = [
    'telemetry-hud__vision-indicator',
    status ? `telemetry-hud__vision-indicator--${status.variant}` : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} title={status?.label} aria-label={status?.label}>
      <span className="telemetry-hud__vision-label">Vision</span>
    </div>
  );
}

function ExpandedHudPanel({
  mode,
  expandedHud,
  liveState,
  liveConnectionState,
  onOpenRawData
}: {
  mode: 'live' | 'review';
  expandedHud: ExpandedHudData;
  liveState?: AircraftLiveState | null;
  liveConnectionState?: HudStatus | null;
  onOpenRawData?: (() => void) | undefined;
}) {
  const className = [
    'telemetry-hud',
    'telemetry-hud--expanded-panel',
    mode === 'live' && liveConnectionState ? `telemetry-hud--status-${liveConnectionState.variant}` : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      title={mode === 'live' && liveConnectionState ? liveConnectionState.label : undefined}
      aria-label={mode === 'live' && liveConnectionState ? liveConnectionState.label : undefined}
    >
      <div className="telemetry-hud__expanded telemetry-hud__expanded--standalone">
        <div className="telemetry-hud__expanded-grid">
          <section className="telemetry-hud__expanded-section telemetry-hud__expanded-section--full">
            <div className="telemetry-hud__expanded-metrics telemetry-hud__expanded-metrics--pi">
              <div>
                <span className="telemetry-hud__label">CPU temp</span>
                <strong className="telemetry-hud__metric-value">
                  {renderValue(expandedHud.cpuTempC, ' C')}
                </strong>
              </div>
              <div>
                <span className="telemetry-hud__label">CPU load</span>
                <strong className="telemetry-hud__metric-value">
                  {renderValue(expandedHud.cpuPercent, ' %')}
                </strong>
              </div>
              <div>
                <span className="telemetry-hud__label">NPU temp</span>
                <strong className="telemetry-hud__metric-value">
                  {renderValue(expandedHud.npuTempC, ' C')}
                </strong>
              </div>
              <div>
                <span className="telemetry-hud__label">Clock speed</span>
                <strong className="telemetry-hud__metric-value">
                  {renderWholeValue(expandedHud.cpuClockMhz, ' MHz')}
                </strong>
              </div>
            </div>
          </section>

          <section className="telemetry-hud__expanded-section">
            <div className="telemetry-hud__expanded-metrics">
              <div>
                <span className="telemetry-hud__label">Throttle</span>
                <strong className="telemetry-hud__metric-value">
                  {renderWholeValue(expandedHud.throttlePct, ' %')}
                </strong>
              </div>
              <div>
                <span className="telemetry-hud__label">Vertical speed</span>
                <strong className="telemetry-hud__metric-value">
                  {renderValue(expandedHud.verticalSpeedMps, ' m/s')}
                </strong>
              </div>
              <div>
                <span className="telemetry-hud__label">Battery used</span>
                <strong className="telemetry-hud__metric-value">
                  {renderWholeValue(expandedHud.batteryMahConsumed, ' mAh')}
                </strong>
              </div>
              <div>
                <span className="telemetry-hud__label">Altitude MSL</span>
                <strong className="telemetry-hud__metric-value">
                  {renderValue(expandedHud.altitudeMslM, ' m')}
                </strong>
                <span className="telemetry-hud__subvalue">
                  {renderValue(expandedHud.targetAltitudeMslM, ' m')}
                </span>
              </div>
              <div>
                <span className="telemetry-hud__label">Efficiency</span>
                <strong className="telemetry-hud__metric-value">
                  {renderEfficiency(expandedHud.liveEfficiencyWhPerKm)}
                </strong>
                <span className="telemetry-hud__subvalue">
                  {renderEfficiency(expandedHud.averageEfficiencyWhPerKm)}
                </span>
              </div>
              <div className="telemetry-hud__vibration">
                <span className="telemetry-hud__label">Vibration</span>
                <div className="telemetry-hud__vibration-list">
                  <strong className="telemetry-hud__metric-value">
                    X {renderValue(expandedHud.vibrationX)}
                  </strong>
                  <strong className="telemetry-hud__metric-value">
                    Y {renderValue(expandedHud.vibrationY)}
                  </strong>
                  <strong className="telemetry-hud__metric-value">
                    Z {renderValue(expandedHud.vibrationZ)}
                  </strong>
                </div>
              </div>
            </div>
          </section>
        </div>

        {mode === 'live' && onOpenRawData ? (
          <div className="telemetry-hud__expanded-actions">
            <button className="secondary-button telemetry-hud__action" onClick={onOpenRawData}>
              View raw data
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TelemetryHud({
  liveState,
  mode,
  altitudeAglM,
  altitudeMslM,
  targetAltitudeAglM,
  liveConnectionState,
  visionStatus,
  visionValue,
  visionControl,
  flightModeLabel,
  batteryPercent,
  attitude,
  metricStates,
  expandedHud,
  mainDock = 'left',
  onOpenRawData,
  onToggleExpandedHud
}: TelemetryHudProps) {
  const liveHudClassName = [
    'telemetry-hud',
    mode === 'live' && liveConnectionState ? `telemetry-hud--status-${liveConnectionState.variant}` : ''
  ]
    .filter(Boolean)
    .join(' ');

  const showExpanded = (mode === 'live' && expandedHud?.open) || (mode === 'review' && expandedHud);

  return (
    <div className="telemetry-hud-layer">
      <div
        className={`telemetry-hud-stack telemetry-hud-stack--main ${
          mainDock === 'right' ? 'telemetry-hud-stack--main-right' : ''
        }`}
      >
        <div
          className={liveHudClassName}
          title={mode === 'live' && liveConnectionState ? liveConnectionState.label : undefined}
          aria-label={mode === 'live' && liveConnectionState ? liveConnectionState.label : undefined}
        >
          <div className="telemetry-hud__topline">
            <div className="telemetry-hud__mode-box">
              <span className="telemetry-hud__label">Flight mode</span>
              <strong>{flightModeLabel}</strong>
            </div>

            <div className="telemetry-hud__topline-actions">
              <VisionIndicator
                mode={mode}
                status={visionStatus}
                value={visionValue}
                control={visionControl}
              />
            </div>
          </div>

          <AttitudeIndicator attitude={attitude} />

          <div className="telemetry-hud__grid">
            <div>
              <span className="telemetry-hud__label">Altitude</span>
              <strong
                className={metricClasses(metricStates?.altitude)}
                style={metricStyle(metricStates?.altitude)}
              >
                {renderValue(altitudeAglM, ' m')}
              </strong>
              <span
                className={`telemetry-hud__subvalue ${
                  metricStates?.altitude?.pulse ? 'telemetry-hud__subvalue--pulse' : ''
                }`}
              >
                {liveState?.armed ? renderValue(targetAltitudeAglM, ' m') : ''}
              </span>
            </div>
            <div>
              <span className="telemetry-hud__label">Speed</span>
              <strong
                className={metricClasses(metricStates?.speed)}
                style={metricStyle(metricStates?.speed)}
              >
                {renderValue(liveState?.groundspeed_mps, ' m/s')}
              </strong>
              <span className="telemetry-hud__subvalue">
                {renderSpeedMph(liveState?.groundspeed_mps)}
              </span>
            </div>
            <div>
              <span className="telemetry-hud__label">Heading</span>
              <strong className="telemetry-hud__metric-value">
                {renderHeadingDegrees(liveState?.heading_deg)}
              </strong>
              <span className="telemetry-hud__subvalue">
                {renderHeadingCardinal(liveState?.heading_deg)}
              </span>
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
                style={
                  metricStates?.battery?.tone && metricStates.battery.tone !== 'normal'
                    ? metricStyle(metricStates.battery)
                    : undefined
                }
              >
                {batteryPercent != null && !Number.isNaN(batteryPercent)
                  ? `${batteryPercent.toFixed(0)}%`
                  : '--'}
              </span>
            </div>
          </div>

          {mode === 'live' && onToggleExpandedHud ? (
            <div className="telemetry-hud__actions">
              <button
                className={`secondary-button telemetry-hud__action ${
                  expandedHud?.open ? 'secondary-button--active' : ''
                }`}
                onClick={onToggleExpandedHud}
              >
                More data
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {showExpanded && expandedHud ? (
        <div className="telemetry-hud-stack telemetry-hud-stack--expanded">
          <ExpandedHudPanel
            mode={mode}
            expandedHud={expandedHud}
            liveState={liveState}
            liveConnectionState={liveConnectionState}
            onOpenRawData={onOpenRawData}
          />
        </div>
      ) : null}
    </div>
  );
}
