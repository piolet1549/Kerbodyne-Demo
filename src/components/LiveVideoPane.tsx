import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import JMuxer from 'jmuxer';
import { reportVideoPerformance } from '../lib/runtime';
import type { VideoPreviewState } from '../lib/types';

interface LiveVideoPaneProps {
  video: VideoPreviewState;
  dominant: boolean;
  visible: boolean;
  onSwap: () => void;
}

type DecoderTone = 'info' | 'warning' | 'error';

interface DecoderDiagnostic {
  message: string;
  tone: DecoderTone;
}

interface VideoPlaybackQualitySnapshot {
  totalVideoFrames: number;
  droppedVideoFrames: number;
}

type PerformanceVideoElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: { presentedFrames?: number }) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  getVideoPlaybackQuality?: () => VideoPlaybackQualitySnapshot;
  webkitDecodedFrameCount?: number;
  webkitDroppedFrameCount?: number;
};

const FIRST_FRAME_WARNING_AFTER_MS = 5000;
const VIDEO_PERFORMANCE_REPORT_INTERVAL_MS = 500;
const VIDEO_STALL_AFTER_MS = 250;
const VIDEO_SOURCE_FPS = 60;
const VIDEO_MUX_BATCH_INTERVAL_MS = 50;
const VIDEO_MAX_PENDING_ACCESS_UNITS = 18;
const VIDEO_SOFT_CATCHUP_SECONDS = 0.18;
const VIDEO_HARD_CATCHUP_SECONDS = 0.65;
const VIDEO_TARGET_LATENCY_SECONDS = 0.08;
const VIDEO_DEGRADED_FPS_FLOOR = 40;
const VIDEO_DEGRADED_FPS_RATIO = 0.55;
const VIDEO_DEGRADED_REFRESH_AFTER_MS = 8000;
const VIDEO_DECODER_REFRESH_COOLDOWN_MS = 60_000;

interface PendingAccessUnit {
  data: Uint8Array;
  keyframe: boolean;
}

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

export const LiveVideoPane = memo(function LiveVideoPane({
  video,
  dominant,
  visible,
  onSwap
}: LiveVideoPaneProps) {
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [decoderDiagnostic, setDecoderDiagnostic] = useState<DecoderDiagnostic | null>(null);
  const [hasRenderedDirectFrame, setHasRenderedDirectFrame] = useState(false);
  const [decoderRecoveryFrame, setDecoderRecoveryFrame] = useState<string | null>(null);
  const displayUrlRef = useRef<string | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const jmuxerRef = useRef<JMuxer | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const renderedDirectFrameRef = useRef(false);
  const visibleRef = useRef(visible);
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
    visibleRef.current = visible;
  }, [visible]);

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
    const performanceVideoElement = videoElement as PerformanceVideoElement;
    let cancelled = false;
    let firstDataWarningTimer: number | null = null;
    let frameCallbackHandle: number | null = null;
    let performanceReportTimer: number | null = null;
    let accessUnitCount = 0;
    let lastRenderedFrameAt: number | null = null;
    let lastQualityPresentedFrames = 0;
    let lastRawDecoderDroppedFrames = 0;
    let decoderDroppedFramesOffset = 0;
    let performanceReportInFlight = false;
    let batchFlushTimer: number | null = null;
    let pendingAccessUnits: PendingAccessUnit[] = [];
    let pendingAccessUnitBytes = 0;
    let discardUntilKeyframe = false;
    let frontendDroppedAccessUnits = 0;
    let fedFrameCount = 0;
    let fedTimelineDurationMs = 0;
    let lastAccessUnitAt: number | null = null;
    let peakRenderedFps = 0;
    let degradedRenderingStartedAt: number | null = null;
    let decoderRefreshCooldownUntil = 0;
    let recoveryAwaitingFrame = false;
    let recoveryKeyframeFed = false;
    const renderedFrameTimes: number[] = [];
    const qualityFrameSamples: Array<{ at: number; presentedFrames: number }> = [];

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

    const markFirstFrameRendered = () => {
      if (cancelled || renderedDirectFrameRef.current) {
        return;
      }
      if (recoveryAwaitingFrame && !recoveryKeyframeFed) {
        return;
      }
      renderedDirectFrameRef.current = true;
      clearFirstDataWarning();
      setHasRenderedDirectFrame(true);
      if (!recoveryAwaitingFrame || recoveryKeyframeFed) {
        recoveryAwaitingFrame = false;
        setDecoderRecoveryFrame(null);
      }
      setDecoderDiagnostic(null);
    };

    const recordRenderedFrame = (now: number) => {
      if (cancelled) {
        return;
      }
      lastRenderedFrameAt = performance.now();
      renderedFrameTimes.push(now);
      while (renderedFrameTimes[0] != null && now - renderedFrameTimes[0] > 1000) {
        renderedFrameTimes.shift();
      }
      markFirstFrameRendered();
      if (typeof performanceVideoElement.requestVideoFrameCallback === 'function') {
        frameCallbackHandle = performanceVideoElement.requestVideoFrameCallback(
          recordRenderedFrame
        );
      }
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

    videoElement.addEventListener('loadeddata', markFirstFrameRendered);
    videoElement.addEventListener('canplay', markFirstFrameRendered);
    videoElement.addEventListener('playing', markFirstFrameRendered);
    videoElement.addEventListener('timeupdate', markFirstFrameRendered);
    videoElement.addEventListener('error', onVideoError);
    videoElement.addEventListener('waiting', onWaiting);
    videoElement.addEventListener('stalled', onStalled);

    if (typeof performanceVideoElement.requestVideoFrameCallback === 'function') {
      frameCallbackHandle = performanceVideoElement.requestVideoFrameCallback(
        recordRenderedFrame
      );
    }

    if (!resolveMediaSourceConstructor()) {
      updateDiagnostic({
        message: 'Video decode unavailable: this WebView does not expose MediaSource playback support.',
        tone: 'error'
      });
      return () => {
        cancelled = true;
        clearFirstDataWarning();
        if (
          frameCallbackHandle !== null &&
          typeof performanceVideoElement.cancelVideoFrameCallback === 'function'
        ) {
          performanceVideoElement.cancelVideoFrameCallback(frameCallbackHandle);
        }
        videoElement.removeEventListener('loadeddata', markFirstFrameRendered);
        videoElement.removeEventListener('canplay', markFirstFrameRendered);
        videoElement.removeEventListener('playing', markFirstFrameRendered);
        videoElement.removeEventListener('timeupdate', markFirstFrameRendered);
        videoElement.removeEventListener('error', onVideoError);
        videoElement.removeEventListener('waiting', onWaiting);
        videoElement.removeEventListener('stalled', onStalled);
      };
    }

    let requestDecoderRefresh: (() => void) | null = null;
    let jmuxer: JMuxer;
    try {
      jmuxer = new JMuxer({
        node: videoElement,
        mode: 'video',
        videoCodec: 'H264',
        live: true,
        flushingTime: 0,
        maxDelay: 1500,
        clearBuffer: true,
        fps: VIDEO_SOURCE_FPS,
        readFpsFromTrack: false,
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
              requestDecoderRefresh?.();
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
        if (
          frameCallbackHandle !== null &&
          typeof performanceVideoElement.cancelVideoFrameCallback === 'function'
        ) {
          performanceVideoElement.cancelVideoFrameCallback(frameCallbackHandle);
        }
        videoElement.removeEventListener('loadeddata', markFirstFrameRendered);
        videoElement.removeEventListener('canplay', markFirstFrameRendered);
        videoElement.removeEventListener('playing', markFirstFrameRendered);
        videoElement.removeEventListener('timeupdate', markFirstFrameRendered);
        videoElement.removeEventListener('error', onVideoError);
        videoElement.removeEventListener('waiting', onWaiting);
        videoElement.removeEventListener('stalled', onStalled);
      };
    }
    jmuxerRef.current = jmuxer;

    const websocket = new WebSocket(directStreamUrl);
    websocket.binaryType = 'arraybuffer';
    websocketRef.current = websocket;

    // Batch several Annex-B access units into each MSE append. This keeps latency low
    // without forcing the WebView main thread to create and append 60 MP4 fragments/sec.
    const nextBatchDurationMs = (frameCount: number) => {
      const nextFrameCount = fedFrameCount + frameCount;
      const nextTimelineDurationMs = Math.round((nextFrameCount * 1000) / VIDEO_SOURCE_FPS);
      const durationMs = Math.max(1, nextTimelineDurationMs - fedTimelineDurationMs);
      fedFrameCount = nextFrameCount;
      fedTimelineDurationMs = nextTimelineDurationMs;
      return durationMs;
    };

    const flushPendingAccessUnits = () => {
      if (cancelled || pendingAccessUnits.length === 0) {
        return;
      }

      const batch = pendingAccessUnits;
      const batchBytes = pendingAccessUnitBytes;
      pendingAccessUnits = [];
      pendingAccessUnitBytes = 0;
      const videoBatch = concatenateAccessUnits(batch, batchBytes);
      recoveryKeyframeFed ||= batch.some((unit) => unit.keyframe);

      try {
        jmuxer.feed({
          video: videoBatch,
          duration: nextBatchDurationMs(batch.length)
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

    const queueAccessUnit = (data: Uint8Array) => {
      const keyframe = containsH264NalType(data, 5);
      if (discardUntilKeyframe) {
        if (!keyframe) {
          frontendDroppedAccessUnits += 1;
          return;
        }
        discardUntilKeyframe = false;
      }

      if (pendingAccessUnits.length >= VIDEO_MAX_PENDING_ACCESS_UNITS) {
        const latestKeyframeIndex = findLastKeyframeIndex(pendingAccessUnits);
        if (latestKeyframeIndex > 0) {
          const dropped = pendingAccessUnits.splice(0, latestKeyframeIndex);
          frontendDroppedAccessUnits += dropped.length;
          pendingAccessUnitBytes = pendingAccessUnits.reduce(
            (total, unit) => total + unit.data.byteLength,
            0
          );
        } else if (latestKeyframeIndex === 0) {
          flushPendingAccessUnits();
        } else if (keyframe) {
          frontendDroppedAccessUnits += pendingAccessUnits.length;
          pendingAccessUnits = [];
          pendingAccessUnitBytes = 0;
        } else {
          frontendDroppedAccessUnits += pendingAccessUnits.length + 1;
          pendingAccessUnits = [];
          pendingAccessUnitBytes = 0;
          discardUntilKeyframe = true;
          return;
        }
      }

      pendingAccessUnits.push({ data, keyframe });
      pendingAccessUnitBytes += data.byteLength;
    };

    const currentBufferAheadSeconds = () => {
      const buffered = videoElement.buffered;
      if (!buffered || buffered.length === 0) {
        return 0;
      }
      const latestRange = buffered.length - 1;
      return Math.max(0, buffered.end(latestRange) - videoElement.currentTime);
    };

    const correctPlaybackLatency = (bufferAheadSeconds: number) => {
      if (videoElement.seeking || videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }
      if (bufferAheadSeconds > VIDEO_HARD_CATCHUP_SECONDS && videoElement.buffered.length > 0) {
        const latestRange = videoElement.buffered.length - 1;
        const rangeStart = videoElement.buffered.start(latestRange);
        const rangeEnd = videoElement.buffered.end(latestRange);
        videoElement.playbackRate = 1;
        videoElement.currentTime = Math.max(
          rangeStart,
          rangeEnd - VIDEO_TARGET_LATENCY_SECONDS
        );
        return;
      }
      videoElement.playbackRate =
        bufferAheadSeconds > VIDEO_SOFT_CATCHUP_SECONDS ? 1.06 : 1;
    };

    const refreshDegradedDecoder = (now: number) => {
      const recoveryFrame = captureVideoFrame(videoElement);
      if (recoveryFrame) {
        setDecoderRecoveryFrame(recoveryFrame);
      }
      pendingAccessUnits = [];
      pendingAccessUnitBytes = 0;
      discardUntilKeyframe = true;
      fedFrameCount = 0;
      fedTimelineDurationMs = 0;
      recoveryAwaitingFrame = true;
      recoveryKeyframeFed = false;
      renderedDirectFrameRef.current = false;
      setHasRenderedDirectFrame(false);
      setDecoderDiagnostic({ message: 'Refreshing video decoder', tone: 'info' });
      videoElement.playbackRate = 1;
      jmuxer.reset();
      peakRenderedFps = 0;
      degradedRenderingStartedAt = null;
      decoderRefreshCooldownUntil = now + VIDEO_DECODER_REFRESH_COOLDOWN_MS;
    };
    requestDecoderRefresh = () => {
      const now = performance.now();
      if (now >= decoderRefreshCooldownUntil) {
        refreshDegradedDecoder(now);
      }
    };

    batchFlushTimer = window.setInterval(
      flushPendingAccessUnits,
      VIDEO_MUX_BATCH_INTERVAL_MS
    );

    const reportPerformance = () => {
      if (cancelled || performanceReportInFlight) {
        return;
      }
      const now = performance.now();
      while (renderedFrameTimes[0] != null && now - renderedFrameTimes[0] > 1000) {
        renderedFrameTimes.shift();
      }

      const quality = performanceVideoElement.getVideoPlaybackQuality?.();
      const rawDroppedFrames = Math.max(
        0,
        Math.trunc(
          quality?.droppedVideoFrames ?? performanceVideoElement.webkitDroppedFrameCount ?? 0
        )
      );
      if (rawDroppedFrames < lastRawDecoderDroppedFrames) {
        decoderDroppedFramesOffset += lastRawDecoderDroppedFrames;
      }
      lastRawDecoderDroppedFrames = rawDroppedFrames;
      const decoderDroppedFramesTotal =
        decoderDroppedFramesOffset + rawDroppedFrames + frontendDroppedAccessUnits;

      let renderedFps = renderedFrameTimes.length;
      if (typeof performanceVideoElement.requestVideoFrameCallback !== 'function') {
        const decodedFrames = Math.max(
          0,
          Math.trunc(
            quality?.totalVideoFrames ?? performanceVideoElement.webkitDecodedFrameCount ?? 0
          )
        );
        const presentedFrames = Math.max(0, decodedFrames - rawDroppedFrames);
        if (presentedFrames < lastQualityPresentedFrames) {
          qualityFrameSamples.length = 0;
        }
        if (presentedFrames > lastQualityPresentedFrames) {
          lastRenderedFrameAt = now;
          markFirstFrameRendered();
        }
        lastQualityPresentedFrames = presentedFrames;
        qualityFrameSamples.push({ at: now, presentedFrames });
        while (qualityFrameSamples[0] != null && now - qualityFrameSamples[0].at > 1000) {
          qualityFrameSamples.shift();
        }
        const oldestSample = qualityFrameSamples[0];
        if (oldestSample && now > oldestSample.at) {
          renderedFps =
            ((presentedFrames - oldestSample.presentedFrames) * 1000) /
            (now - oldestSample.at);
        }
      }

      const lastRenderedFrameAgeMs =
        lastRenderedFrameAt == null ? null : Math.max(0, Math.round(now - lastRenderedFrameAt));
      const stallActive = Boolean(
        renderedDirectFrameRef.current &&
          lastRenderedFrameAgeMs != null &&
          lastRenderedFrameAgeMs >= VIDEO_STALL_AFTER_MS &&
          visibleRef.current &&
          document.visibilityState === 'visible' &&
          websocket.readyState === WebSocket.OPEN
      );
      const bufferAheadSeconds = currentBufferAheadSeconds();
      correctPlaybackLatency(bufferAheadSeconds);

      if (renderedFps > 0) {
        peakRenderedFps = Math.max(peakRenderedFps, renderedFps);
      }
      const ingressCurrent = lastAccessUnitAt != null && now - lastAccessUnitAt < 500;
      const severelyDegraded = Boolean(
        renderedDirectFrameRef.current &&
          peakRenderedFps >= VIDEO_DEGRADED_FPS_FLOOR &&
          renderedFps < peakRenderedFps * VIDEO_DEGRADED_FPS_RATIO &&
          ingressCurrent &&
          visibleRef.current &&
          document.visibilityState === 'visible'
      );
      if (severelyDegraded) {
        degradedRenderingStartedAt ??= now;
        if (
          now - degradedRenderingStartedAt >= VIDEO_DEGRADED_REFRESH_AFTER_MS &&
          now >= decoderRefreshCooldownUntil
        ) {
          refreshDegradedDecoder(now);
        }
      } else {
        degradedRenderingStartedAt = null;
      }

      performanceReportInFlight = true;
      void reportVideoPerformance({
        rendered_fps_1s: Number(renderedFps.toFixed(2)),
        decoder_dropped_frames_total: decoderDroppedFramesTotal,
        last_rendered_frame_age_ms: lastRenderedFrameAgeMs,
        stall_active: stallActive
      })
        .catch(() => {
          // Runtime shutdown can race the final performance report.
        })
        .finally(() => {
          performanceReportInFlight = false;
        });
    };

    performanceReportTimer = window.setInterval(
      reportPerformance,
      VIDEO_PERFORMANCE_REPORT_INTERVAL_MS
    );

    websocket.onopen = () => {
      updateDiagnostic({ message: 'Video bridge connected; waiting for aircraft frames', tone: 'info' });
    };

    websocket.onmessage = (event) => {
      if (cancelled || !(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) {
        return;
      }

      accessUnitCount += 1;
      lastAccessUnitAt = performance.now();
      if (accessUnitCount === 1 || accessUnitCount % 120 === 0) {
        updateDiagnostic({
          message: `Receiving H.264 video (${accessUnitCount} access units); waiting for WebView to render`,
          tone: 'info'
        });
      }
      armFirstDataWarning();

      queueAccessUnit(new Uint8Array(event.data));
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
      requestDecoderRefresh = null;
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
        typeof performanceVideoElement.cancelVideoFrameCallback === 'function'
      ) {
        performanceVideoElement.cancelVideoFrameCallback(frameCallbackHandle);
      }
      if (performanceReportTimer !== null) {
        window.clearInterval(performanceReportTimer);
      }
      if (batchFlushTimer !== null) {
        window.clearInterval(batchFlushTimer);
      }
      pendingAccessUnits = [];
      pendingAccessUnitBytes = 0;
      videoElement.playbackRate = 1;
      videoElement.removeEventListener('loadeddata', markFirstFrameRendered);
      videoElement.removeEventListener('canplay', markFirstFrameRendered);
      videoElement.removeEventListener('playing', markFirstFrameRendered);
      videoElement.removeEventListener('timeupdate', markFirstFrameRendered);
      videoElement.removeEventListener('error', onVideoError);
      videoElement.removeEventListener('waiting', onWaiting);
      videoElement.removeEventListener('stalled', onStalled);
      videoElement.removeAttribute('src');
      videoElement.load();
      renderedDirectFrameRef.current = false;
      setHasRenderedDirectFrame(false);
      setDecoderDiagnostic(null);
      setDecoderRecoveryFrame(null);
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
      {decoderRecoveryFrame && !hasRenderedDirectFrame ? (
        <img
          className="live-video-pane__recovery-frame"
          src={decoderRecoveryFrame}
          alt="Last rendered aircraft video frame"
        />
      ) : null}
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
});

function concatenateAccessUnits(units: PendingAccessUnit[], totalBytes: number) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  units.forEach((unit) => {
    output.set(unit.data, offset);
    offset += unit.data.byteLength;
  });
  return output;
}

function findLastKeyframeIndex(units: PendingAccessUnit[]) {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (units[index]?.keyframe) {
      return index;
    }
  }
  return -1;
}

function containsH264NalType(data: Uint8Array, expectedType: number) {
  for (let index = 0; index + 3 < data.length; index += 1) {
    if (data[index] !== 0 || data[index + 1] !== 0) {
      continue;
    }
    let headerIndex = -1;
    if (data[index + 2] === 1) {
      headerIndex = index + 3;
    } else if (data[index + 2] === 0 && data[index + 3] === 1) {
      headerIndex = index + 4;
    }
    if (headerIndex < data.length && (data[headerIndex] & 0x1f) === expectedType) {
      return true;
    }
  }
  return false;
}

function captureVideoFrame(video: HTMLVideoElement) {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0
  ) {
    return null;
  }
  try {
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
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
