import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import type { SessionVideoClip } from '../lib/types';

interface ReviewVideoModalProps {
  clips: SessionVideoClip[];
  onClose: () => void;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function ReviewVideoModal({ clips, onClose }: ReviewVideoModalProps) {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(clips[0]?.id ?? null);

  useEffect(() => {
    setSelectedClipId(clips[0]?.id ?? null);
  }, [clips]);

  const selectedClip = useMemo(
    () => clips.find((clip) => clip.id === selectedClipId) ?? clips[0] ?? null,
    [clips, selectedClipId]
  );
  const videoSrc = selectedClip ? convertFileSrc(selectedClip.file_path) : null;

  if (clips.length === 0) {
    return null;
  }

  return (
    <>
      <button className="modal-backdrop" onClick={onClose} aria-label="Close recordings" />
      <section className="modal-card review-video-modal">
        <div className="modal-card__header">
          <div>
            <span className="section-title">Recordings</span>
            <strong>{clips.length} clip{clips.length === 1 ? '' : 's'}</strong>
          </div>
          <button className="secondary-button secondary-button--muted" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="review-video-modal__body">
          <aside className="review-video-modal__clips">
            {clips.map((clip, index) => (
              <button
                key={clip.id}
                className={`review-video-modal__clip ${selectedClip?.id === clip.id ? 'review-video-modal__clip--active' : ''}`}
                onClick={() => setSelectedClipId(clip.id)}
              >
                <strong>Clip {index + 1}</strong>
                <span>{formatDuration(clip.duration_ms)}</span>
              </button>
            ))}
          </aside>

          <div className="review-video-modal__player">
            {videoSrc ? (
              <video className="review-video-modal__video" src={videoSrc} controls preload="metadata" />
            ) : (
              <div className="review-video-modal__empty">Recording unavailable</div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
