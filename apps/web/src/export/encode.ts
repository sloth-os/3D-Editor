import type { VideoEncoding } from './codec';
import { BT709_LIMITED } from './yuv';

/*
 * One video stream of a browser export through WebCodecs: I420 frames (converted by the render
 * workers) are wrapped as VideoFrames tagged BT.709 limited range, so the encoder writes those tags
 * into the stream (the H.264 VUI), and encoded in output order with the key frames the export asks
 * for. Frame `i` has the timestamp i × den / num seconds (in microseconds, as WebCodecs counts).
 * The encoder's queue is kept short (backpressure on encodeQueueSize), and its chunks are handed
 * on in decode order, one at a time (the muxer's backpressure is awaited before the next).
 */

/** Frames waiting in the encoder at most before `encode` waits. */
export const MAX_ENCODE_QUEUE = 4;
/** Encoded chunks waiting for the muxer at most before `encode` waits. */
const MAX_PENDING_CHUNKS = 16;

/** An encoded chunk of a stream (its bytes copied out of the encoder). */
export interface EncodedChunk {
  data: Uint8Array;
  key: boolean;
  /** The output frame it shows (from its timestamp). */
  frame: number;
}

/** What the export needs of a WebCodecs VideoEncoder (the real one, or a fake in unit tests). */
export interface VideoEncoderLike {
  readonly encodeQueueSize: number;
  readonly state: string;
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void;
  flush(): Promise<void>;
  close(): void;
  addEventListener(type: 'dequeue', listener: () => void): void;
  removeEventListener(type: 'dequeue', listener: () => void): void;
}

/** Creates an encoder with these callbacks. */
export type VideoEncoderFactory = (init: VideoEncoderInit) => VideoEncoderLike;

/** Makes the VideoFrame of an I420 frame (the browser's; replaced in unit tests). */
export type VideoFrameFactory = (data: Uint8Array, init: VideoFrameBufferInit) => VideoFrame;

export const browserEncoderFactory: VideoEncoderFactory = (init) => new VideoEncoder(init);
export const browserFrameFactory: VideoFrameFactory = (data, init) =>
  new VideoFrame(data as Uint8Array<ArrayBuffer>, init);

/** Microseconds of output frame `frame` at num/den frames per second. */
export function frameTimestamp(frame: number, fps: { num: number; den: number }): number {
  return Math.round((frame * 1e6 * fps.den) / fps.num);
}

/** The output frame of a chunk's timestamp (microseconds). */
export function timestampFrame(timestamp: number, fps: { num: number; den: number }): number {
  return Math.round((timestamp * fps.num) / (fps.den * 1e6));
}

export interface StreamEncoderOptions {
  encoding: VideoEncoding;
  width: number;
  height: number;
  fps: { num: number; den: number };
  /** Receives the stream's chunks in decode order (awaited one at a time). */
  onChunk(chunk: EncodedChunk, decoderConfig: VideoDecoderConfig | null): Promise<void>;
  encoderFactory?: VideoEncoderFactory;
  frameFactory?: VideoFrameFactory;
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export class StreamEncoder {
  private readonly encoder: VideoEncoderLike;
  private readonly o: StreamEncoderOptions;
  private readonly frameFactory: VideoFrameFactory;
  /** The muxing of the chunks, one after the other. */
  private chain: Promise<void> = Promise.resolve();
  private chunksPending = 0;
  private failure: Error | null = null;
  private closed = false;

  constructor(o: StreamEncoderOptions) {
    this.o = o;
    this.frameFactory = o.frameFactory ?? browserFrameFactory;
    this.encoder = (o.encoderFactory ?? browserEncoderFactory)({
      output: (chunk, meta) => this.output(chunk, meta),
      error: (e) => this.fail(asError(e)),
    });
    this.encoder.configure(o.encoding.config);
  }

  private fail(err: Error): void {
    this.failure ??= err;
  }

  private output(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const encoded: EncodedChunk = {
      data,
      key: chunk.type === 'key',
      frame: timestampFrame(chunk.timestamp, this.o.fps),
    };
    const config = meta?.decoderConfig ?? null;
    this.chunksPending++;
    this.chain = this.chain.then(async () => {
      try {
        if (!this.failure) await this.o.onChunk(encoded, config);
      } catch (err) {
        this.fail(asError(err));
      } finally {
        this.chunksPending--;
      }
    });
  }

  private check(): void {
    if (this.failure) throw this.failure;
  }

  /** Waits until the encoder's queue is short again. */
  private async room(): Promise<void> {
    while (
      this.encoder.encodeQueueSize >= MAX_ENCODE_QUEUE &&
      !this.failure &&
      this.encoder.state === 'configured'
    )
      await new Promise<void>((resolve) => {
        const done = () => {
          this.encoder.removeEventListener('dequeue', done);
          resolve();
        };
        this.encoder.addEventListener('dequeue', done);
      });
    if (this.chunksPending > MAX_PENDING_CHUNKS) await this.chain;
    this.check();
  }

  /** Encodes output frame `frame` (I420 bytes), a key frame when `key`. */
  async encode(i420: Uint8Array, frame: number, key: boolean): Promise<void> {
    this.check();
    await this.room();
    const { fps, width, height, encoding } = this.o;
    const timestamp = frameTimestamp(frame, fps);
    const vf = this.frameFactory(i420, {
      format: 'I420',
      codedWidth: width,
      codedHeight: height,
      timestamp,
      duration: frameTimestamp(frame + 1, fps) - timestamp,
      colorSpace: BT709_LIMITED,
    });
    try {
      const options = { keyFrame: key } as VideoEncoderEncodeOptions & { vp9?: { quantizer: number } };
      if (encoding.quantizer !== null) options.vp9 = { quantizer: encoding.quantizer };
      this.encoder.encode(vf, options);
    } finally {
      vf.close();
    }
  }

  /** Encodes what is queued and waits until every chunk is muxed. */
  async flush(): Promise<void> {
    this.check();
    await this.encoder.flush();
    await this.chain;
    this.check();
  }

  /** Closes the encoder (its queued frames are dropped). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      // closed already
    }
  }
}
