import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { confidenceTone } from '../lib/confidence';
import type { AlertRecord, AppConfig } from '../lib/types';

interface AlertDetailProps {
  alert?: AlertRecord | null;
  config: AppConfig;
  alertIndex: number;
  alertCount: number;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious: boolean;
  canNext: boolean;
  onClose: () => void;
}

function displayClass(config: AppConfig, label: string): string {
  return config.class_display_names[label] ?? label;
}

function formatDetectionTime(value?: string | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
    .format(date)
    .replace(/\s([AP]M)$/i, '$1');
}

export function AlertDetail({
  alert,
  config,
  alertIndex,
  alertCount,
  onPrevious,
  onNext,
  canPrevious,
  canNext,
  onClose
}: AlertDetailProps) {
  const [imageExpanded, setImageExpanded] = useState(false);

  useEffect(() => {
    setImageExpanded(false);
  }, [alert?.id]);

  if (!alert) {
    return null;
  }

  const imageSrc = alert.image_path ? convertFileSrc(alert.image_path) : null;
  const confidenceStyle = confidenceTone(alert.confidence);

  return (
    <>
      <section className="alert-detail-card">
        <div className="alert-detail-card__header">
          <div className="alert-detail-card__meta">
            <strong className="alert-detail-card__title">
              {displayClass(config, alert.class_label)}
            </strong>
            <span className="alert-detail-card__time">{formatDetectionTime(alert.detected_at)}</span>
          </div>
          <div className="alert-detail-card__nav">
            <button
              className="secondary-button secondary-button--muted"
              onClick={onPrevious}
              disabled={!canPrevious}
              aria-label="Previous detection"
            >
              ←
            </button>
            <span className="alert-detail-card__count">
              {alertIndex + 1}/{alertCount}
            </span>
            <button
              className="secondary-button secondary-button--muted"
              onClick={onNext}
              disabled={!canNext}
              aria-label="Next detection"
            >
              →
            </button>
          </div>
          <button
            className="secondary-button secondary-button--muted alert-detail-card__close"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {imageSrc ? (
          <button
            className="alert-image-shell alert-image-shell--button"
            onClick={() => setImageExpanded(true)}
          >
            <img className="alert-image" src={imageSrc} alt={`${alert.class_label} detection`} />
            <span className="alert-image-shell__hint">Open image</span>
          </button>
        ) : (
          <div className="alert-image-shell alert-image-shell--placeholder">
            <span>No image saved</span>
          </div>
        )}

        <dl className="detail-grid">
          <div>
            <dt>Confidence</dt>
            <dd>
              <span
                className="detail-confidence confidence-pill"
                style={{
                  color: confidenceStyle.color,
                  background: confidenceStyle.background,
                  borderColor: confidenceStyle.border
                }}
              >
                {Math.round(alert.confidence * 100)}%
              </span>
            </dd>
          </div>
          <div>
            <dt>Altitude</dt>
            <dd>{alert.alt_msl_m != null ? `${alert.alt_msl_m.toFixed(1)} m` : '--'}</dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd>
              {alert.sector.center_lat.toFixed(5)}, {alert.sector.center_lon.toFixed(5)}
            </dd>
          </div>
          <div>
            <dt>Heading</dt>
            <dd>{alert.sector.bearing_deg.toFixed(0)} deg</dd>
          </div>
        </dl>
      </section>

      {imageExpanded && imageSrc ? (
        <>
          <button
            className="image-lightbox-backdrop"
            onClick={() => setImageExpanded(false)}
            aria-label="Close image view"
          />
          <div className="image-lightbox">
            <div className="image-lightbox__toolbar">
              <span className="section-title">Detection image</span>
              <button
                className="secondary-button secondary-button--muted"
                onClick={() => setImageExpanded(false)}
              >
                Close
              </button>
            </div>
            <img
              className="image-lightbox__image"
              src={imageSrc}
              alt={`${alert.class_label} detection full view`}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
