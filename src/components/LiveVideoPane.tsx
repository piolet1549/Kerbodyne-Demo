import { useEffect, useRef, useState } from 'react';
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
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const waitingForFeed = matchesErrorIdle(video.status) || video.status === 'waiting_for_stream' || video.status === 'waiting_for_keyframe';
  const WrapperTag = dominant ? 'div' : 'button';

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    const revokeFrameUrl = (url: string | null) => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };

    const schedulePoll = (delay = 66) => {
      timeoutId = window.setTimeout(() => {
        void pollFrame();
      }, delay);
    };

    async function pollFrame() {
      if (cancelled || !video.preview_url) {
        return;
      }

      try {
        const response = await fetch(`${video.preview_url}?t=${Date.now()}`, {
          cache: 'no-store'
        });
        if (cancelled) {
          return;
        }
        if (response.status === 200) {
          const blob = await response.blob();
          if (cancelled) {
            return;
          }
          const nextUrl = URL.createObjectURL(blob);
          const previousUrl = frameUrlRef.current;
          frameUrlRef.current = nextUrl;
          setFrameUrl(nextUrl);
          revokeFrameUrl(previousUrl);
        }
      } catch {
        // Swallow transient frame fetch errors and keep polling.
      }

      if (!cancelled) {
        schedulePoll();
      }
    }

    if (video.preview_url) {
      schedulePoll(0);
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
      const previousUrl = frameUrlRef.current;
      frameUrlRef.current = null;
      setFrameUrl(null);
      revokeFrameUrl(previousUrl);
    };
  }, [video.preview_url]);

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
      {frameUrl ? (
        <img className="live-video-pane__image" src={frameUrl} alt="Live aircraft video feed" />
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
