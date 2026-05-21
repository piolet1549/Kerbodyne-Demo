import { useEffect, useMemo, useState } from 'react';
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
  onAdjustPlaybackSpeed: (direction: -1 | 1) => void;
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
  onAdjustPlaybackSpeed,
  onOpenRecordings
}: ReplayTimelineProps) {
  const [draftFlightName, setDraftFlightName] = useState(flightName);

  useEffect(() => {
    setDraftFlightName(flightName);
  }, [flightName]);

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
        <div className="replay-timeline__controls">
          <div className="replay-timeline__playback-controls">
            <button
              type="button"
              className="secondary-button secondary-button--muted replay-timeline__playback-button"
              onClick={() => onAdjustPlaybackSpeed(-1)}
              disabled={playbackSpeed <= 0.5}
              aria-label="Decrease replay speed"
            >
              -
            </button>
            <button
              type="button"
              className={`secondary-button replay-timeline__playback-button ${
                playbackActive ? 'secondary-button--active' : ''
              }`}
              onClick={onTogglePlayback}
            >
              {playbackActive ? 'Pause' : 'Play'}
            </button>
            <span className="replay-timeline__speed">{playbackSpeed}x</span>
            <button
              type="button"
              className="secondary-button secondary-button--muted replay-timeline__playback-button"
              onClick={() => onAdjustPlaybackSpeed(1)}
              disabled={playbackSpeed >= 4}
              aria-label="Increase replay speed"
            >
              +
            </button>
          </div>
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
        <span>{progress.current}</span>
        <span>
          {selectedIndex + 1}/{frames.length}
        </span>
        <span>{progress.total}</span>
      </div>
    </section>
  );
}
