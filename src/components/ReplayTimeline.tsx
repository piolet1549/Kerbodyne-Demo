import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewTelemetryFrame } from '../lib/types';

interface ReplayTimelineMarker {
  id: string;
  index: number;
}

interface ReplayTimelineProps {
  flightName: string;
  frames: ReviewTelemetryFrame[];
  selectedIndex: number;
  markers: ReplayTimelineMarker[];
  selectedMarkerId?: string | null;
  hasRecordings?: boolean;
  playbackActive: boolean;
  playbackSpeed: number;
  onChange: (index: number) => void;
  onSelectMarker: (markerId: string, index: number) => void;
  onRenameFlightName: (name: string) => void;
  onTogglePlayback: () => void;
  onSelectPlaybackSpeed: (speed: number) => void;
  onOpenRecordings?: () => void;
}

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function ReplayTimeline({
  flightName,
  frames,
  selectedIndex,
  markers,
  selectedMarkerId,
  hasRecordings,
  playbackActive,
  playbackSpeed,
  onChange,
  onSelectMarker,
  onRenameFlightName,
  onTogglePlayback,
  onSelectPlaybackSpeed,
  onOpenRecordings
}: ReplayTimelineProps) {
  const [draftFlightName, setDraftFlightName] = useState(flightName);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const speedOptions = [0.5, 1, 2, 4];
  const speedMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraftFlightName(flightName);
  }, [flightName]);

  useEffect(() => {
    if (!speedMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!speedMenuRef.current?.contains(event.target as Node)) {
        setSpeedMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSpeedMenuOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [speedMenuOpen]);

  const progress = useMemo(() => {
    if (frames.length === 0) {
      return { current: '00:00:00', total: '00:00:00' };
    }

    const start = new Date(frames[0].recorded_at).getTime();
    const current = new Date(frames[selectedIndex]?.recorded_at ?? frames[0].recorded_at).getTime();
    const end = new Date(frames[frames.length - 1].recorded_at).getTime();
    return {
      current: formatElapsed(current - start),
      total: formatElapsed(end - start)
    };
  }, [frames, selectedIndex]);

  if (frames.length === 0) {
    return null;
  }

  function commitRename() {
    const trimmed = draftFlightName.trim();
    if (!trimmed || trimmed === flightName) {
      setDraftFlightName(flightName);
      return;
    }
    onRenameFlightName(trimmed);
  }

  return (
    <section className="replay-timeline">
      <div className="replay-timeline__header">
        <input
          className="save-name-input replay-timeline__name-input"
          value={draftFlightName}
          onChange={(event) => setDraftFlightName(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              setDraftFlightName(flightName);
              event.currentTarget.blur();
            }
          }}
          aria-label="Flight name"
        />
        {hasRecordings && onOpenRecordings ? (
          <button
            type="button"
            className="secondary-button secondary-button--muted replay-timeline__recordings-button"
            onClick={onOpenRecordings}
          >
            View recordings
          </button>
        ) : null}
      </div>

      <div
        className={`replay-timeline__slider-shell ${
          selectedMarkerId ? 'replay-timeline__slider-shell--marker-active' : ''
        }`}
      >
        <input
          className={`replay-timeline__slider ${
            selectedMarkerId ? 'replay-timeline__slider--marker-active' : ''
          }`}
          type="range"
          min={0}
          max={Math.max(frames.length - 1, 0)}
          step={1}
          value={selectedIndex}
          onChange={(event) => onChange(Number(event.target.value))}
        />

        {markers.map((marker) => {
          const denominator = Math.max(frames.length - 1, 1);
          const left = `calc((100% - var(--replay-thumb-size, 16px)) * ${
            marker.index / denominator
          } + (var(--replay-thumb-size, 16px) / 2))`;
          const isDimmed = Boolean(selectedMarkerId) && selectedMarkerId !== marker.id;
          return (
            <button
              key={marker.id}
              className={`replay-timeline__marker ${
                isDimmed ? 'replay-timeline__marker--dimmed' : ''
              } ${selectedMarkerId === marker.id ? 'replay-timeline__marker--active' : ''}`}
              style={{ left }}
              onClick={() => onSelectMarker(marker.id, marker.index)}
              aria-label="Jump to detection"
              title="Jump to detection"
            />
          );
        })}
      </div>

      <div className="replay-timeline__footer">
        <div className="replay-timeline__playback-controls">
          <button
            type="button"
            className={`secondary-button replay-timeline__icon-button ${
              playbackActive ? 'secondary-button--active' : ''
            }`}
            onClick={onTogglePlayback}
            aria-label={playbackActive ? 'Pause replay' : 'Play replay'}
            title={playbackActive ? 'Pause replay' : 'Play replay'}
          >
            <span
              className={`replay-timeline__play-icon ${
                playbackActive ? 'replay-timeline__play-icon--pause' : ''
              }`}
              aria-hidden="true"
            />
          </button>
          <div ref={speedMenuRef} className="replay-timeline__speed-picker">
            <button
              type="button"
              className={`secondary-button secondary-button--muted replay-timeline__speed-button ${
                speedMenuOpen ? 'secondary-button--active' : ''
              }`}
              onClick={() => setSpeedMenuOpen((current) => !current)}
              aria-expanded={speedMenuOpen}
              aria-label="Select replay speed"
            >
              {playbackSpeed}x
            </button>
            {speedMenuOpen ? (
              <div className="replay-timeline__speed-menu">
                {speedOptions.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    className={`replay-timeline__speed-option ${
                      speed === playbackSpeed ? 'replay-timeline__speed-option--active' : ''
                    }`}
                    onClick={() => {
                      setSpeedMenuOpen(false);
                      onSelectPlaybackSpeed(speed);
                    }}
                  >
                    {speed}x
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="replay-timeline__time replay-timeline__time--elapsed">
            {progress.current}
          </span>
        </div>
        <span className="replay-timeline__frame-placeholder" aria-hidden="true">
          {selectedIndex + 1}/{frames.length}
        </span>
        <span className="replay-timeline__time replay-timeline__time--total">{progress.total}</span>
        <span className="replay-timeline__frame-counter">
          {selectedIndex + 1}/{frames.length}
        </span>
      </div>
    </section>
  );
}
