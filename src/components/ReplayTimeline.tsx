import { useEffect, useState } from 'react';
import type { ReviewTelemetryFrame } from '../lib/types';
import { formatTimestamp } from '../lib/time';

interface ReplayTimelineProps {
  flightName: string;
  frames: ReviewTelemetryFrame[];
  selectedIndex: number;
  onChange: (index: number) => void;
  onRenameFlightName: (name: string) => void;
}

export function ReplayTimeline({
  flightName,
  frames,
  selectedIndex,
  onChange,
  onRenameFlightName
}: ReplayTimelineProps) {
  const [draftFlightName, setDraftFlightName] = useState(flightName);

  useEffect(() => {
    setDraftFlightName(flightName);
  }, [flightName]);

  if (frames.length === 0) {
    return null;
  }

  const startFrame = frames[0];
  const endFrame = frames[frames.length - 1];

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

      <input
        className="replay-timeline__slider"
        type="range"
        min={0}
        max={Math.max(frames.length - 1, 0)}
        step={1}
        value={selectedIndex}
        onChange={(event) => onChange(Number(event.target.value))}
      />

      <div className="replay-timeline__footer">
        <span>{formatTimestamp(startFrame.recorded_at)}</span>
        <span>
          {selectedIndex + 1} / {frames.length}
        </span>
        <span>{formatTimestamp(endFrame.recorded_at)}</span>
      </div>
    </section>
  );
}
