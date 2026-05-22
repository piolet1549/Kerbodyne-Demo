import { useEffect, useMemo, useState } from 'react';
import type { VideoPreviewState } from '../lib/types';

interface LiveVideoPaneProps {
  video: VideoPreviewState;
  dominant: boolean;
  onSwap: () => void;
}

function statusLabel(status: VideoPreviewState['status']) {
  switch (status) {
    case 'waiting_for_stream':
      return 'Waiting for feed';
    case 'waiting_for_keyframe':
      return 'Waiting for feed';
    case 'live':
      return 'Live video';
    case 'recording':
      return 'Recording live video';
    case 'stale':
      return 'Feed stale';
    case 'error':
      return 'Waiting for feed';
    default:
      return 'Waiting for feed';
  }
}

export function LiveVideoPane({ video, dominant, onSwap }: LiveVideoPaneProps) {
  const [streamNonce, setStreamNonce] = useState(0);
  const waitingForFeed =
    matchesErrorIdle(video.status) ||
    video.status === 'waiting_for_stream' ||
    video.status === 'waiting_for_keyframe';
  const WrapperTag = dominant ? 'div' : 'button';

  useEffect(() => {
    setStreamNonce((current) => current + 1);
  }, [video.preview_url, video.recording_active, video.current_clip_id, video.status]);

  const streamUrl = useMemo(() => {
    if (!video.preview_url) {
      return null;
    }

    const separator = video.preview_url.includes('?') ? '&' : '?';
    return `${video.preview_url}${separator}stream=${streamNonce}`;
  }, [video.preview_url, streamNonce]);

  return (
    <WrapperTag
      {...(!dominant ? { type: 'button' as const } : {})}
      className={`live-video-pane ${dominant ? 'live-video-pane--dominant' : 'live-video-pane--corner'} ${
        waitingForFeed ? 'live-video-pane--waiting' : ''
      }`}
      {...(!dominant
        ? {
            onClick: onSwap,
            'aria-label': 'Show video in main view'
          }
        : {})}
    >
      {streamUrl ? (
        <img
          key={streamUrl}
          className="live-video-pane__image"
          src={streamUrl}
          alt="Live aircraft video feed"
        />
      ) : (
        <div className="live-video-pane__empty" />
      )}
      <div
        className={`live-video-pane__overlay ${
          waitingForFeed ? 'live-video-pane__overlay--centered' : ''
        }`}
      >
        <span className={`live-video-pane__status live-video-pane__status--${video.status}`}>
          {video.message ?? statusLabel(video.status)}
        </span>
      </div>
    </WrapperTag>
  );
}

function matchesErrorIdle(status: VideoPreviewState['status']) {
  return status === 'idle' || status === 'error';
}
