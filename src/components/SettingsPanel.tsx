import { useEffect, useState } from 'react';
import type { AppConfig, OfflineRegionManifest } from '../lib/types';

const DEFAULT_FOV_DEG = 38;
const DEFAULT_STALE_TIMEOUT_S = 10;

interface SettingsDrawerProps {
  open: boolean;
  config: AppConfig;
  regions: OfflineRegionManifest[];
  regionsError?: string | null;
  onClose: () => void;
  onRefreshRegions: () => Promise<void>;
  onSave: (config: AppConfig) => Promise<void>;
}

export function SettingsDrawer({
  open,
  config,
  regions,
  regionsError,
  onClose,
  onRefreshRegions,
  onSave
}: SettingsDrawerProps) {
  const [draft, setDraft] = useState<AppConfig>(config);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const configFingerprint = JSON.stringify(config);
  const draftFingerprint = JSON.stringify(draft);

  useEffect(() => {
    setDraft(config);
    setError(null);
  }, [configFingerprint]);

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
    }, 260);

    return () => window.clearTimeout(handle);
  }, [configFingerprint, draft, draftFingerprint, onSave, open]);

  if (!open) {
    return null;
  }

  function patch<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
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
              <strong>Flight display</strong>
              <button
                className="secondary-button secondary-button--muted"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    default_fov_deg: DEFAULT_FOV_DEG,
                    stale_after_seconds: DEFAULT_STALE_TIMEOUT_S
                  }))
                }
              >
                Reset to default
              </button>
            </div>
            <div className="settings-form">
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
                  value={draft.stale_after_seconds}
                  onChange={(event) => patch('stale_after_seconds', Number(event.target.value))}
                />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__header">
              <strong>Offline maps</strong>
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
