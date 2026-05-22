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
  flightTimeS?: number | null;
  batteryMahConsumed?: number | null;
}

interface AttitudeData {
  pitchDeg?: number | null;
  rollDeg?: number | null;
  navPitchDeg?: number | null;
  navRollDeg?: number | null;
  showFlightDirector?: boolean;
}

interface TelemetryHudProps {
  liveState?: AircraftLiveState | null;
  mode: 'live' | 'review';
  altitudeAglM?: number | null;
  altitudeMslM?: number | null;
  targetAltitudeMslM?: number | null;
  liveConnectionState?: HudStatus | null;
  visionStatus?: HudStatus | null;
  visionValue?: boolean | null;
  flightModeLabel: string;
  batteryPercent?: number | null;
  attitude?: AttitudeData | null;
  metricStates?: {
    altitude?: HudMetricState;
    speed?: HudMetricState;
    battery?: HudMetricState;
  };
  expandedHud?: ExpandedHudData | null;
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

function renderDuration(seconds?: number | null): string {
  if (seconds == null || Number.isNaN(seconds)) return '--';
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds
      .toString()
      .padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
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
  const hasCommand =
    Boolean(attitude?.showFlightDirector) &&
    attitude?.navPitchDeg != null &&
    !Number.isNaN(attitude.navPitchDeg) &&
    attitude?.navRollDeg != null &&
    !Number.isNaN(attitude.navRollDeg);
  const navPitch = hasCommand ? (attitude?.navPitchDeg as number) : pitch;
  const navRoll = hasCommand ? (attitude?.navRollDeg as number) : roll;
  const horizonTranslateY = clamp(pitch * 2.4, -58, 58);
  const horizonRotate = clamp(-roll, -60, 60);
  const commandTranslateY = clamp((navPitch - pitch) * 2.2, -36, 36);
  const commandRotate = clamp(roll - navRoll, -42, 42);
  const commandTranslateX = clamp((roll - navRoll) * 1.1, -36, 36);
  const pitchMarks = [-20, -10, 10, 20];

  return (
    <div className="telemetry-hud__attitude-shell" aria-label="Attitude indicator">
      <div className="telemetry-hud__attitude">
        <div className="telemetry-hud__attitude-roll-arc" />
        <div className="telemetry-hud__attitude-roll-notch" />
        <div className="telemetry-hud__attitude-mask">
          <div
            className="telemetry-hud__attitude-horizon"
            style={{ transform: `translateY(${horizonTranslateY}px) rotate(${horizonRotate}deg)` }}
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
        <div className="telemetry-hud__attitude-aircraft" />
        {hasCommand ? (
          <div
            className="telemetry-hud__attitude-command"
            style={{
              transform: `translate(${commandTranslateX}px, ${commandTranslateY}px) rotate(${commandRotate}deg)`
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function VisionIndicator({
  mode,
  status,
  value
}: {
  mode: 'live' | 'review';
  status?: HudStatus | null;
  value?: boolean | null;
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
  liveConnectionState,
  onOpenRawData
}: {
  mode: 'live' | 'review';
  expandedHud: ExpandedHudData;
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
                <span className="telemetry-hud__label">Flight time</span>
                <strong className="telemetry-hud__metric-value">
                  {renderDuration(expandedHud.flightTimeS)}
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
  targetAltitudeMslM,
  liveConnectionState,
  visionStatus,
  visionValue,
  flightModeLabel,
  batteryPercent,
  attitude,
  metricStates,
  expandedHud,
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
      <div className="telemetry-hud-stack telemetry-hud-stack--main">
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
              <VisionIndicator mode={mode} status={visionStatus} value={visionValue} />
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
                {renderValue(targetAltitudeMslM, ' m')}
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
                style={metricStyle(metricStates?.battery)}
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
            liveConnectionState={liveConnectionState}
            onOpenRawData={onOpenRawData}
          />
        </div>
      ) : null}
    </div>
  );
}
