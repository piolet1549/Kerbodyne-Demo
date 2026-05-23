import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const displayUrlRef = useRef<string | null>(null);
  const waitingForFeed =
    matchesErrorIdle(video.status) ||
    video.status === 'waiting_for_stream' ||
    video.status === 'waiting_for_keyframe';
  const WrapperTag = dominant ? 'div' : 'button';

  useEffect(() => {
    if (!video.preview_url) {
      if (displayUrlRef.current) {
        URL.revokeObjectURL(displayUrlRef.current);
        displayUrlRef.current = null;
      }
      setDisplayUrl(null);
      return undefined;
    }

    let cancelled = false;
    let controller: AbortController | null = null;

    const loadFrames = async () => {
      while (!cancelled) {
        controller = new AbortController();
        try {
          const separator = video.preview_url!.includes('?') ? '&' : '?';
          const response = await fetch(
            `${video.preview_url}${separator}frame=${Date.now()}`,
            {
              cache: 'no-store',
              signal: controller.signal
            }
          );

          if (response.ok) {
            const blob = await response.blob();
            if (blob.size > 0 && !cancelled) {
              const nextUrl = URL.createObjectURL(blob);
              const previousUrl = displayUrlRef.current;
              displayUrlRef.current = nextUrl;
              setDisplayUrl(nextUrl);
              if (previousUrl) {
                URL.revokeObjectURL(previousUrl);
              }
            }
          }
        } catch {
          // Keep retrying; the runtime state overlay handles user-facing status.
        }

        await delay(66);
      }
    };

    void loadFrames();

    return () => {
      cancelled = true;
      controller?.abort();
      if (displayUrlRef.current) {
        URL.revokeObjectURL(displayUrlRef.current);
        displayUrlRef.current = null;
      }
      setDisplayUrl(null);
    };
  }, [video.preview_url, video.recording_active, video.current_clip_id]);

  const streamUrl = useMemo(() => displayUrl, [displayUrl]);

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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
