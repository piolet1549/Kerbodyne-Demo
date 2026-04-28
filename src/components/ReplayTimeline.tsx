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
  onChange: (index: number) => void;
  onSelectMarker: (markerId: string, index: number) => void;
  onRenameFlightName: (name: string) => void;
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
  onChange,
  onSelectMarker,
  onRenameFlightName
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
      </div>

      <div className="replay-timeline__slider-shell">
        <input
          className="replay-timeline__slider"
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
