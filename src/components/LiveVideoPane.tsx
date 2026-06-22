import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import JMuxer from 'jmuxer';
import type { VideoPreviewState } from '../lib/types';

interface LiveVideoPaneProps {
  video: VideoPreviewState;
  dominant: boolean;
  onSwap: () => void;
}

type DecoderTone = 'info' | 'warning' | 'error';

interface DecoderDiagnostic {
  message: string;
  tone: DecoderTone;
}

const FIRST_FRAME_WARNING_AFTER_MS = 5000;

function statusLabel(status: VideoPreviewState['status']) {
  switch (status) {
    case 'waiting_for_stream':
      return 'Waiting for feed';
    case 'waiting_for_keyframe':
      return 'Waiting for keyframe';
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
  const [decoderDiagnostic, setDecoderDiagnostic] = useState<DecoderDiagnostic | null>(null);
  const [hasRenderedDirectFrame, setHasRenderedDirectFrame] = useState(false);
  const displayUrlRef = useRef<string | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const jmuxerRef = useRef<JMuxer | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const renderedDirectFrameRef = useRef(false);
  const directStreamUrl = video.preview_url?.startsWith('ws://') || video.preview_url?.startsWith('wss://')
    ? video.preview_url
    : null;
  const jpegPreviewUrl = directStreamUrl ? null : video.preview_url;
  const waitingForFeed =
    matchesErrorIdle(video.status) ||
    video.status === 'waiting_for_stream' ||
    video.status === 'waiting_for_keyframe';
  const waitingForDirectDecode = Boolean(directStreamUrl) && !waitingForFeed && !hasRenderedDirectFrame;
  const overlayCentered = waitingForFeed || waitingForDirectDecode;
  const overlayMessage = waitingForDirectDecode
    ? decoderDiagnostic?.message ?? 'Preparing video decoder'
    : video.message ?? statusLabel(video.status);
  const overlayToneClass = waitingForDirectDecode
    ? `live-video-pane__status--decoder-${decoderDiagnostic?.tone ?? 'info'}`
    : `live-video-pane__status--${video.status}`;

  const handleCornerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (dominant || (event.key !== 'Enter' && event.key !== ' ')) {
      return;
    }
    event.preventDefault();
    onSwap();
  };

  useEffect(() => {
    renderedDirectFrameRef.current = hasRenderedDirectFrame;
  }, [hasRenderedDirectFrame]);

  useEffect(() => {
    if (!jpegPreviewUrl) {
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
          const separator = jpegPreviewUrl.includes('?') ? '&' : '?';
          const response = await fetch(
            `${jpegPreviewUrl}${separator}frame=${Date.now()}`,
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
  }, [jpegPreviewUrl, video.recording_active, video.current_clip_id]);

  useEffect(() => {
    if (!directStreamUrl || !videoElementRef.current) {
      websocketRef.current?.close();
      websocketRef.current = null;
      jmuxerRef.current?.destroy();
      jmuxerRef.current = null;
      return undefined;
    }

    const videoElement = videoElementRef.current;
    let cancelled = false;
    let firstDataWarningTimer: number | null = null;
    let frameCallbackHandle: number | null = null;
    let accessUnitCount = 0;

    renderedDirectFrameRef.current = false;
    setHasRenderedDirectFrame(false);
    setDecoderDiagnostic({ message: 'Connecting video decoder', tone: 'info' });
    videoElement.muted = true;
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.preload = 'auto';

    const clearFirstDataWarning = () => {
      if (firstDataWarningTimer !== null) {
        window.clearTimeout(firstDataWarningTimer);
        firstDataWarningTimer = null;
      }
    };

    const updateDiagnostic = (diagnostic: DecoderDiagnostic) => {
      if (!cancelled && !renderedDirectFrameRef.current) {
        setDecoderDiagnostic(diagnostic);
      }
    };

    const armFirstDataWarning = () => {
      if (firstDataWarningTimer !== null) {
        return;
      }
      firstDataWarningTimer = window.setTimeout(() => {
        updateDiagnostic({
          message:
            'Receiving H.264 video, but WebView has not rendered a frame. Check WebView2, Windows media codecs, and GPU drivers if this remains black.',
          tone: 'warning'
        });
      }, FIRST_FRAME_WARNING_AFTER_MS);
    };

    const markFrameRendered = () => {
      if (cancelled || renderedDirectFrameRef.current) {
        return;
      }
      renderedDirectFrameRef.current = true;
      clearFirstDataWarning();
      setHasRenderedDirectFrame(true);
      setDecoderDiagnostic(null);
    };

    const onVideoError = () => {
      updateDiagnostic({
        message: `Video decode failed: ${formatMediaError(videoElement.error)}`,
        tone: 'error'
      });
    };
    const onWaiting = () => {
      updateDiagnostic({ message: 'Video decoder is waiting for buffered frames', tone: 'info' });
    };
    const onStalled = () => {
      updateDiagnostic({ message: 'Video decoder stalled while waiting for frames', tone: 'warning' });
    };

    videoElement.addEventListener('loadeddata', markFrameRendered);
    videoElement.addEventListener('canplay', markFrameRendered);
    videoElement.addEventListener('playing', markFrameRendered);
    videoElement.addEventListener('timeupdate', markFrameRendered);
    videoElement.addEventListener('error', onVideoError);
    videoElement.addEventListener('waiting', onWaiting);
    videoElement.addEventListener('stalled', onStalled);

    const videoWithFrameCallback = videoElement as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (typeof videoWithFrameCallback.requestVideoFrameCallback === 'function') {
      frameCallbackHandle = videoWithFrameCallback.requestVideoFrameCallback(markFrameRendered);
    }

    if (!resolveMediaSourceConstructor()) {
      updateDiagnostic({
        message: 'Video decode unavailable: this WebView does not expose MediaSource playback support.',
        tone: 'error'
      });
      return () => {
        cancelled = true;
        clearFirstDataWarning();
        videoElement.removeEventListener('loadeddata', markFrameRendered);
        videoElement.removeEventListener('canplay', markFrameRendered);
        videoElement.removeEventListener('playing', markFrameRendered);
        videoElement.removeEventListener('timeupdate', markFrameRendered);
        videoElement.removeEventListener('error', onVideoError);
        videoElement.removeEventListener('waiting', onWaiting);
        videoElement.removeEventListener('stalled', onStalled);
      };
    }

    let jmuxer: JMuxer;
    try {
      jmuxer = new JMuxer({
        node: videoElement,
        mode: 'video',
        videoCodec: 'H264',
        live: true,
        flushingTime: 0,
        maxDelay: 120,
        clearBuffer: true,
        fps: 60,
        readFpsFromTrack: true,
        debug: false,
        onReady: () => {
          updateDiagnostic({ message: 'Video decoder ready; waiting for H.264 frames', tone: 'info' });
        },
        onData: () => {
          armFirstDataWarning();
          updateDiagnostic({ message: 'Decoder accepted video; waiting for first rendered frame', tone: 'info' });
        },
        onUnsupportedCodec: (codec) => {
          updateDiagnostic({
            message: `Video codec unsupported by WebView2: ${codec ?? 'unknown H.264 profile'}. Update WebView2 or install Windows Media Feature Pack.`,
            tone: 'error'
          });
        },
        onMissingVideoFrames: () => {
          updateDiagnostic({ message: 'Video frame gaps detected; waiting for a clean keyframe', tone: 'warning' });
        },
        onError: (error) => {
          updateDiagnostic({
            message: `Video buffer error: ${formatJmuxerError(error)}. Retrying decoder.`,
            tone: 'warning'
          });
          if (!cancelled) {
            window.setTimeout(() => {
              jmuxerRef.current?.reset();
            }, 250);
          }
        }
      });
    } catch (error) {
      updateDiagnostic({
        message: `Video decoder could not start: ${formatJmuxerError(error)}`,
        tone: 'error'
      });
      return () => {
        cancelled = true;
        clearFirstDataWarning();
        videoElement.removeEventListener('loadeddata', markFrameRendered);
        videoElement.removeEventListener('canplay', markFrameRendered);
        videoElement.removeEventListener('playing', markFrameRendered);
        videoElement.removeEventListener('timeupdate', markFrameRendered);
        videoElement.removeEventListener('error', onVideoError);
        videoElement.removeEventListener('waiting', onWaiting);
        videoElement.removeEventListener('stalled', onStalled);
      };
    }
    jmuxerRef.current = jmuxer;

    const websocket = new WebSocket(directStreamUrl);
    websocket.binaryType = 'arraybuffer';
    websocketRef.current = websocket;

    websocket.onopen = () => {
      updateDiagnostic({ message: 'Video bridge connected; waiting for aircraft frames', tone: 'info' });
    };

    websocket.onmessage = (event) => {
      if (cancelled || !(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) {
        return;
      }

      accessUnitCount += 1;
      if (accessUnitCount === 1 || accessUnitCount % 120 === 0) {
        updateDiagnostic({
          message: `Receiving H.264 video (${accessUnitCount} access units); waiting for WebView to render`,
          tone: 'info'
        });
      }
      armFirstDataWarning();

      try {
        jmuxer.feed({
          video: new Uint8Array(event.data),
          duration: 17
        });
      } catch (error) {
        updateDiagnostic({
          message: `Video muxer rejected aircraft frames: ${formatJmuxerError(error)}`,
          tone: 'error'
        });
        return;
      }

      if (videoElement.paused) {
        void videoElement.play().catch((error: unknown) => {
          updateDiagnostic({
            message: `Video playback did not start: ${formatJmuxerError(error)}`,
            tone: 'warning'
          });
        });
      }
    };

    websocket.onerror = () => {
      updateDiagnostic({ message: 'Video bridge WebSocket error', tone: 'error' });
      websocket.close();
    };

    websocket.onclose = () => {
      updateDiagnostic({ message: 'Video bridge closed before video rendered', tone: 'warning' });
    };

    return () => {
      cancelled = true;
      clearFirstDataWarning();
      websocket.close();
      if (websocketRef.current === websocket) {
        websocketRef.current = null;
      }
      jmuxer.destroy();
      if (jmuxerRef.current === jmuxer) {
        jmuxerRef.current = null;
      }
      if (
        frameCallbackHandle !== null &&
        typeof videoWithFrameCallback.cancelVideoFrameCallback === 'function'
      ) {
        videoWithFrameCallback.cancelVideoFrameCallback(frameCallbackHandle);
      }
      videoElement.removeEventListener('loadeddata', markFrameRendered);
      videoElement.removeEventListener('canplay', markFrameRendered);
      videoElement.removeEventListener('playing', markFrameRendered);
      videoElement.removeEventListener('timeupdate', markFrameRendered);
      videoElement.removeEventListener('error', onVideoError);
      videoElement.removeEventListener('waiting', onWaiting);
      videoElement.removeEventListener('stalled', onStalled);
      videoElement.removeAttribute('src');
      videoElement.load();
      renderedDirectFrameRef.current = false;
      setHasRenderedDirectFrame(false);
      setDecoderDiagnostic(null);
    };
  }, [directStreamUrl]);

  const streamUrl = useMemo(() => displayUrl, [displayUrl]);

  return (
    <div
      className={`live-video-pane ${dominant ? 'live-video-pane--dominant' : 'live-video-pane--corner'} ${
        waitingForFeed ? 'live-video-pane--waiting' : ''
      }`}
      {...(!dominant
        ? {
            onClick: onSwap,
            onKeyDown: handleCornerKeyDown,
            role: 'button' as const,
            tabIndex: 0,
            'aria-label': 'Show video in main view'
          }
        : {})}
    >
      {directStreamUrl ? (
        <video
          ref={videoElementRef}
          className="live-video-pane__video"
          muted
          autoPlay
          playsInline
        />
      ) : streamUrl ? (
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
          overlayCentered ? 'live-video-pane__overlay--centered' : ''
        }`}
      >
        <span className={`live-video-pane__status ${overlayToneClass}`}>
          {overlayMessage}
        </span>
      </div>
    </div>
  );
}

function matchesErrorIdle(status: VideoPreviewState['status']) {
  return status === 'idle' || status === 'error';
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function resolveMediaSourceConstructor() {
  const mediaWindow = window as Window &
    typeof globalThis & {
      WebKitMediaSource?: typeof MediaSource;
      ManagedMediaSource?: typeof MediaSource;
    };
  return mediaWindow.MediaSource ?? mediaWindow.WebKitMediaSource ?? mediaWindow.ManagedMediaSource ?? null;
}

function formatMediaError(error: MediaError | null) {
  if (!error) {
    return 'unknown media error';
  }

  const reason = (() => {
    switch (error.code) {
      case error.MEDIA_ERR_ABORTED:
        return 'playback aborted';
      case error.MEDIA_ERR_NETWORK:
        return 'network error';
      case error.MEDIA_ERR_DECODE:
        return 'decoder error';
      case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return 'source or codec unsupported';
      default:
        return `media error ${error.code}`;
    }
  })();

  return error.message ? `${reason} (${error.message})` : reason;
}

function formatJmuxerError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}
