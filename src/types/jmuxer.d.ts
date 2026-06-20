declare module 'jmuxer' {
  export interface JMuxerOptions {
    node: HTMLVideoElement | string;
    mode?: 'video' | 'audio' | 'both';
    videoCodec?: 'H264' | 'H265';
    flushingTime?: number;
    maxDelay?: number;
    clearBuffer?: boolean;
    fps?: number;
    debug?: boolean;
    onError?: (error?: unknown) => void;
  }

  export interface JMuxerFeedData {
    video?: Uint8Array;
    audio?: Uint8Array;
    duration?: number;
    compositionTimeOffset?: number;
  }

  export default class JMuxer {
    static isSupported(codec: string): boolean;
    constructor(options: JMuxerOptions);
    feed(data: JMuxerFeedData): void;
    reset(): void;
    destroy(): void;
  }
}
