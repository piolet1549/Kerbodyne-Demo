import { useEffect, useState } from 'react';
import type {
  AircraftIconShape,
  AppConfig,
  MapMode,
  OfflineRegionManifest,
  TrackLineStyle
} from '../lib/types';

const DEFAULT_FOV_DEG = 38;
const DEFAULT_STALE_TIMEOUT_S = 10;
const DEFAULT_AIRCRAFT_ICON = {
  size_px: 38,
  color_hex: '#f7f7f7',
  shape: 'compass' as AircraftIconShape
};
const DEFAULT_TRACK_DISPLAY = {
  enabled: true,
  color_hex: '#f0f0f0',
  width_px: 2.8,
  style: 'solid' as TrackLineStyle
};
const DEFAULT_FLIGHT_ALERTS = {
  high_speed_warning_mps: 35,
  low_speed_warning_mps: 9,
  high_altitude_warning_m: 120,
  low_battery_warning_percent: 20
};

const AIRCRAFT_ICON_OPTIONS: Array<{ value: AircraftIconShape; label: string }> = [
  { value: 'compass', label: 'Compass' },
  { value: 'delta', label: 'Delta' },
  { value: 'dart', label: 'Dart' },
  { value: 'kite', label: 'Kite' },
  { value: 'spear', label: 'Spear' },
  { value: 'wing', label: 'Wing' }
];
const DISPLAY_COLOR_OPTIONS = [
  '#f4f4f4',
  '#101010',
  '#8a8a8a',
  '#ff9a3d',
  '#ff6b63',
  '#ffd44d',
  '#68de92',
  '#2fb5aa',
  '#69b7ff',
  '#4b86ff',
  '#8d74ff',
  '#c26dff',
  '#8a5a3c',
  '#c57b42',
  '#d64545'
];

interface SettingsDrawerProps {
  open: boolean;
  config: AppConfig;
  regions: OfflineRegionManifest[];
  assetOrigin?: string | null;
  regionsError?: string | null;
  onClose: () => void;
  onRefreshRegions: () => Promise<void>;
  onSave: (config: AppConfig) => Promise<void>;
}

function buildRegionAssetUrl(
  assetOrigin: string | null | undefined,
  regionId: string,
  relativePath: string | null | undefined
) {
  if (!assetOrigin || !relativePath) {
    return null;
  }
  const normalizedOrigin = assetOrigin.replace(/\/+$/, '');
  const encodedRegion = encodeURIComponent(regionId);
  const encodedPath = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${normalizedOrigin}/regions/${encodedRegion}/${encodedPath}`;
}

export function SettingsDrawer({
  open,
  config,
  regions,
  assetOrigin,
  regionsError,
  onClose,
  onRefreshRegions,
  onSave
}: SettingsDrawerProps) {
  const [draft, setDraft] = useState<AppConfig>(config);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewMapMode, setPreviewMapMode] = useState<MapMode>('satellite');
  const configFingerprint = JSON.stringify(config);
  const draftFingerprint = JSON.stringify(draft);

  useEffect(() => {
    setDraft(config);
    setError(null);
  }, [configFingerprint]);

  useEffect(() => {
    setPreviewMapMode(config.default_map_mode);
  }, [config.default_map_mode, open]);

  useEffect(() => {
    if (!open || draftFingerprint === configFingerprint) {
      return;
    }

    const handle = window.setTimeout(async () => {
      setSaving(true);
      setError(null);
      try {
        await onSave(draft);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Unable to save settings');
      } finally {
        setSaving(false);
      }
    }, 240);

    return () => window.clearTimeout(handle);
  }, [configFingerprint, draft, draftFingerprint, onSave, open]);

  if (!open) {
    return null;
  }

  function patch<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function patchAircraftIcon(
    next: Partial<AppConfig['aircraft_icon']>
  ) {
    setDraft((current) => ({
      ...current,
      aircraft_icon: {
        ...current.aircraft_icon,
        ...next
      }
    }));
  }

  function patchTrackDisplay(
    next: Partial<AppConfig['track_display']>
  ) {
    setDraft((current) => ({
      ...current,
      track_display: {
        ...current.track_display,
        ...next
      }
    }));
  }

  function patchFlightAlerts(
    next: Partial<AppConfig['flight_alerts']>
  ) {
    setDraft((current) => ({
      ...current,
      flight_alerts: {
        ...current.flight_alerts,
        ...next
      }
    }));
  }

  function toggleRegion(regionId: string) {
    setDraft((current) => {
      const enabled = current.enabled_region_ids.includes(regionId);
      const nextEnabled = enabled
        ? current.enabled_region_ids.filter((enabledRegionId) => enabledRegionId !== regionId)
        : [...current.enabled_region_ids, regionId];
      const nextSelected = enabled
        ? current.selected_region_id === regionId
          ? nextEnabled[0] ?? null
          : current.selected_region_id
        : current.selected_region_id ?? regionId;
      return {
        ...current,
        enabled_region_ids: nextEnabled,
        selected_region_id: nextSelected
      };
    });
  }

  function patchRegionName(region: OfflineRegionManifest, value: string) {
    setDraft((current) => {
      const nextOverrides = { ...current.region_name_overrides };
      const trimmed = value.trim();
      if (!trimmed || trimmed === region.name) {
        delete nextOverrides[region.id];
      } else {
        nextOverrides[region.id] = value;
      }
      return {
        ...current,
        region_name_overrides: nextOverrides
      };
    });
  }

  function getRegionDisplayName(region: OfflineRegionManifest) {
    const override = draft.region_name_overrides[region.id]?.trim();
    return override || region.name;
  }

  function resetAlertDefaults() {
    setDraft((current) => ({
      ...current,
      default_fov_deg: DEFAULT_FOV_DEG,
      stale_after_seconds: DEFAULT_STALE_TIMEOUT_S,
      flight_alerts: { ...DEFAULT_FLIGHT_ALERTS }
    }));
  }

  const previewIconScale = Math.max(0.78, Math.min(1.22, draft.aircraft_icon.size_px / 38));
  const previewAircraftSize = draft.aircraft_icon.size_px;
  const previewAircraftRotation = -58;
  const previewSceneWidth = 500;
  const previewSceneHeight = 160;
  const previewOffsetX = 100;
  const previewTrackAnchorX = 34 + previewOffsetX;
  const previewTrackAnchorY = 96;
  const previewPathCurve = `M ${360 + previewOffsetX} 30
    C ${328 + previewOffsetX} 52, ${298 + previewOffsetX} 132, ${252 + previewOffsetX} 108
    S ${188 + previewOffsetX} 22, ${142 + previewOffsetX} 52
    S ${86 + previewOffsetX} 120, ${previewTrackAnchorX} ${previewTrackAnchorY}`;
  const previewTailWidth = `${Math.max(2, Math.min(8, draft.track_display.width_px * 1.25))}px`;
  const previewRegion =
    regions.find((region) => region.id === draft.selected_region_id) ??
    regions.find((region) => draft.enabled_region_ids.includes(region.id)) ??
    regions[0] ??
    null;
  const previewStreetImage = previewRegion
    ? buildRegionAssetUrl(assetOrigin, previewRegion.id, previewRegion.street_image)
    : null;
  const previewSatelliteImage = previewRegion
    ? buildRegionAssetUrl(assetOrigin, previewRegion.id, previewRegion.satellite_image)
    : null;
  const previewBackgroundImage =
    previewMapMode === 'street_dark'
      ? previewStreetImage ?? previewSatelliteImage
      : previewSatelliteImage ?? previewStreetImage;
  const previewBackgroundClass =
    previewMapMode === 'street_dark'
      ? 'settings-display-preview__bg--street'
      : 'settings-display-preview__bg--satellite';

  return (
    <>
      <button className="modal-backdrop" onClick={onClose} aria-label="Close settings" />
      <section className="modal-card settings-modal">
        <div className="modal-card__header settings-modal__header">
          <div>
            <span className="section-title settings-drawer__title">Settings</span>
            <span className="settings-modal__status">
              {saving ? 'Saving…' : error ? 'Save failed' : 'Changes save automatically'}
            </span>
          </div>
          <button className="secondary-button secondary-button--muted" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="settings-modal__body">
            <section className="settings-section">
              <div className="settings-section__header">
                <strong>Display</strong>
              </div>

              <div className="settings-display-grid settings-display-grid--expanded">
                <div className="settings-subpanel settings-subpanel--display settings-subpanel--display-preview">
                  <div className="settings-display-preview">
                    <div
                      className={`settings-display-preview__bg ${previewBackgroundClass}`}
                      style={
                        previewBackgroundImage
                          ? { backgroundImage: `url("${previewBackgroundImage}")` }
                          : undefined
                      }
                    />
                    <div className="settings-display-preview__shade" />
                    <div className="settings-display-preview__toolbar">
                      <div className="map-mode-toggle settings-display-preview__toggle" role="tablist" aria-label="Preview basemap mode">
                        <button
                          className={previewMapMode === 'street_dark' ? 'secondary-button secondary-button--active' : 'secondary-button secondary-button--muted'}
                          onClick={() => setPreviewMapMode('street_dark')}
                          type="button"
                        >
                          Street
                        </button>
                        <button
                          className={previewMapMode === 'satellite' ? 'secondary-button secondary-button--active' : 'secondary-button secondary-button--muted'}
                          onClick={() => setPreviewMapMode('satellite')}
                          type="button"
                        >
                          Satellite
                        </button>
                      </div>
                    </div>
                    {!previewBackgroundImage ? (
                      <div className="settings-display-preview__empty">Preview imagery unavailable</div>
                    ) : null}
                    <div className="settings-display-preview__scene">
                      <svg
                        className="settings-display-preview__canvas"
                        viewBox={`0 0 ${previewSceneWidth} ${previewSceneHeight}`}
                        aria-hidden="true"
                      >
                        {draft.track_display.enabled ? (
                          <path
                            d={previewPathCurve}
                            fill="none"
                            stroke={draft.track_display.color_hex}
                            strokeWidth={previewTailWidth}
                            strokeLinecap="round"
                            strokeDasharray={draft.track_display.style === 'dashed' ? '15 12' : undefined}
                          />
                        ) : null}
                      </svg>
                      <div
                        className="settings-display-preview__aircraft"
                        style={{
                          left: `${(previewTrackAnchorX / previewSceneWidth) * 100}%`,
                          top: `${(previewTrackAnchorY / previewSceneHeight) * 100}%`,
                          transform: `translate(-50%, -92%) rotate(${previewAircraftRotation}deg)`
                        }}
                      >
                        <div
                          className="aircraft-marker"
                          data-shape={draft.aircraft_icon.shape}
                          style={{
                            ['--aircraft-size' as string]: `${previewAircraftSize}px`,
                            ['--aircraft-fill' as string]: draft.aircraft_icon.color_hex
                          }}
                        >
                          <div className="aircraft-marker__glyph" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-subpanel settings-subpanel--display">
                  <div className="settings-display-heading">
                    <span className="settings-tool-card__label">Icon</span>
                  </div>
                  <div className="settings-display-controls">
                    <div className="settings-display-precolor settings-display-precolor--icon">
                      <div className="settings-display-field settings-display-field--full">
                        <div className="settings-shape-grid settings-shape-grid--compact">
                          {AIRCRAFT_ICON_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              className={`settings-shape-button ${
                                draft.aircraft_icon.shape === option.value
                                  ? 'settings-shape-button--active'
                                  : ''
                              }`}
                              onClick={() => patchAircraftIcon({ shape: option.value })}
                            >
                              <div
                                className={`settings-shape-preview settings-shape-preview--${option.value}`}
                                style={{
                                  ['--shape-preview-color' as string]: draft.aircraft_icon.color_hex
                                }}
                              />
                              <span>{option.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <label className="settings-display-field settings-display-field--full settings-display-field--control-offset">
                      <div className="settings-color-panel">
                        <div className="settings-color-swatches">
                          {DISPLAY_COLOR_OPTIONS.map((color) => (
                            <button
                              key={color}
                              type="button"
                              className={`settings-color-swatch ${
                                draft.aircraft_icon.color_hex.toLowerCase() === color.toLowerCase()
                                  ? 'settings-color-swatch--active'
                                  : ''
                              }`}
                              style={{ ['--settings-swatch-color' as string]: color }}
                              onClick={() => patchAircraftIcon({ color_hex: color })}
                              aria-label={`Use ${color} for icon`}
                            />
                          ))}
                          <label
                            className={`settings-color-swatch settings-color-swatch--custom ${
                              !DISPLAY_COLOR_OPTIONS.some(
                                (color) =>
                                  color.toLowerCase() === draft.aircraft_icon.color_hex.toLowerCase()
                              )
                                ? 'settings-color-swatch--active'
                                : ''
                            }`}
                            aria-label="Choose custom icon color"
                          >
                            <input
                              type="color"
                              value={draft.aircraft_icon.color_hex}
                              onChange={(event) =>
                                patchAircraftIcon({ color_hex: event.target.value })
                              }
                            />
                          </label>
                        </div>
                        <span className="settings-inline-value">{draft.aircraft_icon.color_hex}</span>
                      </div>
                    </label>

                    <label className="settings-display-field settings-display-field--range settings-display-field--full settings-display-field--control-offset">
                      <div className="settings-display-field__header">
                        <span className="settings-display-field__label">Size</span>
                        <button
                          type="button"
                          className="secondary-button secondary-button--muted settings-inline-reset"
                          onClick={() =>
                            patchAircraftIcon({ size_px: DEFAULT_AIRCRAFT_ICON.size_px })
                          }
                        >
                          Reset
                        </button>
                      </div>
                      <input
                        type="range"
                        min={26}
                        max={56}
                        step={1}
                        value={draft.aircraft_icon.size_px}
                        onChange={(event) =>
                          patchAircraftIcon({ size_px: Number(event.target.value) })
                        }
                      />
                      <span className="settings-inline-value">{draft.aircraft_icon.size_px}px</span>
                    </label>
                  </div>
                </div>

                <div className="settings-subpanel settings-subpanel--display settings-subpanel--display-path">
                  <div className="settings-display-heading">
                    <span className="settings-tool-card__label">Path</span>
                  </div>
                  <div className="settings-display-controls settings-display-controls--path">
                    <div className="settings-display-precolor settings-display-precolor--path">
                      <label className="settings-display-field settings-display-field--full settings-display-field--path-toggle">
                        <div className="settings-pill-row">
                          <button
                            className={`secondary-button secondary-button--muted ${
                              draft.track_display.enabled ? 'secondary-button--active' : ''
                            }`}
                            onClick={() => patchTrackDisplay({ enabled: true })}
                          >
                            Enabled
                          </button>
                          <button
                            className={`secondary-button secondary-button--muted ${
                              !draft.track_display.enabled ? 'secondary-button--active' : ''
                            }`}
                            onClick={() => patchTrackDisplay({ enabled: false })}
                          >
                            Disabled
                          </button>
                        </div>
                      </label>

                      <label className="settings-display-field settings-display-field--full settings-display-field--path-toggle">
                        <div className="settings-pill-row">
                          <button
                            className={`secondary-button secondary-button--muted ${
                              draft.track_display.style === 'solid' ? 'secondary-button--active' : ''
                            }`}
                            onClick={() => patchTrackDisplay({ style: 'solid' })}
                          >
                            Solid
                          </button>
                          <button
                            className={`secondary-button secondary-button--muted ${
                              draft.track_display.style === 'dashed' ? 'secondary-button--active' : ''
                            }`}
                            onClick={() => patchTrackDisplay({ style: 'dashed' })}
                          >
                            Dashed
                          </button>
                        </div>
                      </label>
                    </div>

                    <label className="settings-display-field settings-display-field--full settings-display-field--control-offset">
                      <div className="settings-color-panel">
                        <div className="settings-color-swatches">
                          {DISPLAY_COLOR_OPTIONS.map((color) => (
                            <button
                              key={color}
                              type="button"
                              className={`settings-color-swatch ${
                                draft.track_display.color_hex.toLowerCase() === color.toLowerCase()
                                  ? 'settings-color-swatch--active'
                                  : ''
                              }`}
                              style={{ ['--settings-swatch-color' as string]: color }}
                              onClick={() => patchTrackDisplay({ color_hex: color })}
                              aria-label={`Use ${color} for path`}
                            />
                          ))}
                          <label
                            className={`settings-color-swatch settings-color-swatch--custom ${
                              !DISPLAY_COLOR_OPTIONS.some(
                                (color) =>
                                  color.toLowerCase() === draft.track_display.color_hex.toLowerCase()
                              )
                                ? 'settings-color-swatch--active'
                                : ''
                            }`}
                            aria-label="Choose custom path color"
                          >
                            <input
                              type="color"
                              value={draft.track_display.color_hex}
                              onChange={(event) =>
                                patchTrackDisplay({ color_hex: event.target.value })
                              }
                            />
                          </label>
                        </div>
                        <span className="settings-inline-value">{draft.track_display.color_hex}</span>
                      </div>
                    </label>

                    <label className="settings-display-field settings-display-field--range settings-display-field--full settings-display-field--control-offset">
                      <div className="settings-display-field__header">
                        <span className="settings-display-field__label">Size</span>
                        <button
                          type="button"
                          className="secondary-button secondary-button--muted settings-inline-reset"
                          onClick={() =>
                            patchTrackDisplay({ width_px: DEFAULT_TRACK_DISPLAY.width_px })
                          }
                        >
                          Reset
                        </button>
                      </div>
                      <input
                        type="range"
                        min={1.5}
                        max={6}
                        step={0.1}
                        value={draft.track_display.width_px}
                        onChange={(event) =>
                          patchTrackDisplay({ width_px: Number(event.target.value) })
                        }
                      />
                      <span className="settings-inline-value">
                        {draft.track_display.width_px.toFixed(1)}px
                      </span>
                    </label>
                  </div>
                </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__header">
              <strong>Alerts</strong>
              <button
                className="secondary-button secondary-button--muted"
                onClick={resetAlertDefaults}
              >
                Reset to default
              </button>
            </div>

            <div className="settings-form settings-form--two-column">
              <label>
                Detection FOV (deg)
                <input
                  type="number"
                  step="0.1"
                  value={draft.default_fov_deg}
                  onChange={(event) => patch('default_fov_deg', Number(event.target.value))}
                />
              </label>
              <label>
                Link stale timeout (s)
                <input
                  type="number"
                  min={2}
                  step="1"
                  value={draft.stale_after_seconds}
                  onChange={(event) => patch('stale_after_seconds', Number(event.target.value))}
                />
              </label>
              <label>
                High speed warning (m/s)
                <input
                  type="number"
                  step="0.1"
                  value={draft.flight_alerts.high_speed_warning_mps}
                  onChange={(event) =>
                    patchFlightAlerts({ high_speed_warning_mps: Number(event.target.value) })
                  }
                />
                <span className="settings-hint">
                  Caution triggers 5 m/s below the warning threshold.
                </span>
              </label>

              <label>
                Low speed warning (m/s)
                <input
                  type="number"
                  step="0.1"
                  value={draft.flight_alerts.low_speed_warning_mps}
                  onChange={(event) =>
                    patchFlightAlerts({ low_speed_warning_mps: Number(event.target.value) })
                  }
                />
                <span className="settings-hint">No caution band is used for low speed.</span>
              </label>

              <label>
                High altitude warning (m)
                <input
                  type="number"
                  step="1"
                  value={draft.flight_alerts.high_altitude_warning_m}
                  onChange={(event) =>
                    patchFlightAlerts({ high_altitude_warning_m: Number(event.target.value) })
                  }
                />
                <span className="settings-hint">
                  Measured above the aircraft altitude at arm.
                </span>
              </label>

              <label>
                Low battery warning (%)
                <input
                  type="number"
                  step="1"
                  value={draft.flight_alerts.low_battery_warning_percent}
                  onChange={(event) =>
                    patchFlightAlerts({ low_battery_warning_percent: Number(event.target.value) })
                  }
                />
                <span className="settings-hint">
                  Caution triggers 10% above the warning threshold.
                </span>
              </label>

            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__header">
              <strong>Maps</strong>
              <button
                className="secondary-button secondary-button--muted"
                onClick={async () => {
                  try {
                    setError(null);
                    await onRefreshRegions();
                  } catch (refreshError) {
                    setError(
                      refreshError instanceof Error
                        ? refreshError.message
                        : 'Unable to refresh offline regions'
                    );
                  }
                }}
              >
                Refresh
              </button>
            </div>

            <div className="settings-region-list">
              {regions.length > 0 ? (
                regions.map((region) => {
                  const enabled = draft.enabled_region_ids.includes(region.id);
                  return (
                    <div key={region.id} className="settings-region-card">
                      <div className="settings-region-card__row">
                        <button
                          className={`settings-region-toggle ${
                            enabled ? 'settings-region-toggle--active' : ''
                          }`}
                          onClick={() => toggleRegion(region.id)}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} ${getRegionDisplayName(region)}`}
                          title={enabled ? 'Disable region' : 'Enable region'}
                        />
                        <div className="settings-region-card__content">
                          <input
                            className="settings-region-name-input"
                            value={getRegionDisplayName(region)}
                            onChange={(event) => patchRegionName(region, event.target.value)}
                            placeholder={region.name}
                          />
                          <span className="settings-region-card__id">{region.id}</span>
                        </div>
                      </div>
                      <span>
                        Bounds {region.bounds[1].toFixed(4)}, {region.bounds[0].toFixed(4)} to{' '}
                        {region.bounds[3].toFixed(4)}, {region.bounds[2].toFixed(4)}
                      </span>
                      <span>
                        Imagery {region.imagery_capture_date || 'Capture date not provided'}
                      </span>
                      <span>{region.imagery_attribution || 'Attribution not provided'}</span>
                    </div>
                  );
                })
              ) : (
                <div className="settings-region-card">
                  <strong>No offline regions found</strong>
                  <span>Add region folders to the offline maps directory, then refresh.</span>
                </div>
              )}
            </div>

            {regionsError ? (
              <div className="settings-region-card settings-region-card--error">
                <strong>Offline maps</strong>
                <span>{regionsError}</span>
              </div>
            ) : null}
          </section>
        </div>

        {error ? <p className="drawer-error">{error}</p> : null}
      </section>
    </>
  );
}
