import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
  type Target,
} from 'mediabunny';
import type { EncodedChunk } from './encode';
import { BT709_LIMITED } from './yuv';

/*
 * The files of one video stream of a browser export, written from its encoded chunks with
 * mediabunny: the sequence (every frame of the export) and the clip of each shot, both made of the
 * same chunks without encoding again (the server cuts its clips from the sequence by stream copy at
 * the forced key frames the same way). Each chunk goes to the sequence and to the clip of the shot
 * whose frames it shows, its timestamp rebased to the clip's start; the encoder puts a key frame at
 * every shot start, and a clip whose first chunk is not one is an error (it could not be decoded).
 *
 * MP4 files are written with their index (moov) before the media data, so players start them before
 * they are fully read: clips and in-memory sequences are kept in memory until finished ("in-memory"
 * fast start); a sequence written to disk reserves room for its index at the start of the file
 * ("reserve", from the number of frames). WebM (VP9) needs neither. The decoder configuration of
 * every file is the encoder's, its colour space set to BT.709 limited range (what the frames were
 * tagged with, and what the H.264 stream's VUI says): mediabunny writes it as the MP4 `colr` box.
 * Timestamps are exact multiples of the frame duration (den / num seconds): each file's time scale
 * is the frame rate's.
 */

/** A shot of the export as the muxer sees it: its first output frame and its frame count. */
export interface MuxShot {
  start: number;
  frames: number;
}

export interface StreamMuxerOptions {
  muxCodec: 'avc' | 'vp9';
  container: 'mp4' | 'webm';
  fps: { num: number; den: number };
  /** Output frames of the export. */
  frames: number;
  shots: readonly MuxShot[];
  /**
   * Where the sequence goes: a stream of positioned writes (a file on disk), 'memory', or null when
   * the export writes no sequence of this stream.
   */
  sequence: WritableStream<StreamTargetChunk> | 'memory' | null;
  /** Whether every shot gets a clip of this stream. */
  clips: boolean;
  /** Receives each finished clip (in shot order), with its shot's index. */
  onClip(shot: number, bytes: Uint8Array): Promise<void>;
}

/** An output file being written: its mediabunny output, packet source and packets so far. */
interface Writer {
  output: Output;
  source: EncodedVideoPacketSource;
  target: Target;
  packets: number;
  started: Promise<void>;
}

/** The index of the shot showing output frame `frame` (shots in order, back to back). */
export function shotOfFrame(shots: readonly MuxShot[], frame: number): number {
  let lo = 0;
  let hi = shots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (shots[mid].start <= frame) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class StreamMuxer {
  private readonly o: StreamMuxerOptions;
  private readonly frameSeconds: number;
  private config: VideoDecoderConfig | null = null;
  private sequence: Writer | null = null;
  private clip: { shot: number; writer: Writer } | null = null;
  private lastShot = -1;
  private finished = false;

  constructor(o: StreamMuxerOptions) {
    this.o = o;
    this.frameSeconds = o.fps.den / o.fps.num;
    if (o.sequence) {
      const memory = o.sequence === 'memory';
      this.sequence = this.writer(
        memory ? new BufferTarget() : new StreamTarget(o.sequence as WritableStream<StreamTargetChunk>),
        memory ? 'in-memory' : 'reserve',
        o.frames,
      );
    }
  }

  private writer(target: Target, fastStart: 'in-memory' | 'reserve', maxPackets: number): Writer {
    const format = this.o.container === 'mp4' ? new Mp4OutputFormat({ fastStart }) : new WebMOutputFormat();
    const output = new Output({ format, target });
    const source = new EncodedVideoPacketSource(this.o.muxCodec);
    output.addVideoTrack(source, {
      frameRate: this.o.fps.num / this.o.fps.den,
      ...(fastStart === 'reserve' ? { maximumPacketCount: maxPackets } : {}),
    });
    const started = output.start();
    // a failure to start surfaces at the first packet
    started.catch(() => undefined);
    return { output, source, target, packets: 0, started };
  }

  /** The decoder configuration every file gets: the encoder's, tagged BT.709 limited range. */
  private meta(): EncodedVideoChunkMetadata {
    if (!this.config) throw new Error('the video encoder gave no decoder configuration with its first chunk');
    return { decoderConfig: { ...this.config, colorSpace: { ...BT709_LIMITED } } };
  }

  private async put(w: Writer, chunk: EncodedChunk, frame: number): Promise<void> {
    await w.started;
    const packet = new EncodedPacket(
      chunk.data,
      chunk.key ? 'key' : 'delta',
      frame * this.frameSeconds,
      this.frameSeconds,
    );
    await w.source.add(packet, w.packets === 0 ? this.meta() : undefined);
    w.packets++;
  }

  private async closeClip(): Promise<void> {
    const c = this.clip;
    if (!c) return;
    this.clip = null;
    const expected = this.o.shots[c.shot].frames;
    if (c.writer.packets !== expected) {
      await c.writer.output.cancel();
      throw new Error(
        `shot ${c.shot + 1}'s clip got ${c.writer.packets} of its ${expected} frames from the encoder`,
      );
    }
    await c.writer.output.finalize();
    const buffer = (c.writer.target as BufferTarget).buffer;
    if (!buffer) throw new Error(`shot ${c.shot + 1}'s clip was not written`);
    await this.o.onClip(c.shot, new Uint8Array(buffer));
  }

  /** Muxes a chunk (in decode order); `decoderConfig` is the encoder's when it gave one with it. */
  async add(chunk: EncodedChunk, decoderConfig: VideoDecoderConfig | null): Promise<void> {
    if (this.finished) throw new Error('the stream is finished');
    if (decoderConfig) {
      if (this.config && !sameConfig(this.config, decoderConfig))
        throw new Error(
          'the video encoder changed its decoder configuration in the middle of the stream, which one file cannot hold',
        );
      this.config = decoderConfig;
    }
    if (chunk.frame < 0 || chunk.frame >= this.o.frames)
      throw new Error(
        `the video encoder gave a chunk of frame ${chunk.frame + 1} of an export of ${this.o.frames}`,
      );
    if (this.sequence) await this.put(this.sequence, chunk, chunk.frame);
    if (!this.o.clips) return;
    const shot = shotOfFrame(this.o.shots, chunk.frame);
    if (shot < this.lastShot)
      throw new Error(
        `the video encoder gave a chunk of shot ${shot + 1} after shot ${this.lastShot + 1} had started`,
      );
    if (shot !== this.clip?.shot) {
      await this.closeClip();
      if (!chunk.key)
        throw new Error(
          `shot ${shot + 1}'s clip would not start on a key frame (the encoder ignored the one asked for)`,
        );
      this.lastShot = shot;
      this.clip = { shot, writer: this.writer(new BufferTarget(), 'in-memory', this.o.shots[shot].frames) };
    }
    await this.put(this.clip.writer, chunk, chunk.frame - this.o.shots[shot].start);
  }

  /**
   * Finishes the files: the last clip goes to `onClip`; resolves with the sequence's bytes when it
   * is kept in memory (null when it went to its stream, or there is none).
   */
  async finish(): Promise<Uint8Array | null> {
    if (this.finished) throw new Error('the stream is finished');
    this.finished = true;
    await this.closeClip();
    if (this.o.clips && this.lastShot !== this.o.shots.length - 1)
      throw new Error(`the video encoder gave no chunk of shot ${this.lastShot + 2}`);
    const s = this.sequence;
    if (!s) return null;
    if (s.packets !== this.o.frames) {
      await s.output.cancel();
      throw new Error(`the sequence got ${s.packets} of its ${this.o.frames} frames from the encoder`);
    }
    await s.output.finalize();
    if (this.o.sequence !== 'memory') return null;
    const buffer = (s.target as BufferTarget).buffer;
    if (!buffer) throw new Error('the sequence was not written');
    return new Uint8Array(buffer);
  }

  /** Drops what is written (the export failed or was cancelled). */
  async cancel(): Promise<void> {
    this.finished = true;
    const outputs = [this.sequence?.output, this.clip?.writer.output].filter((o): o is Output => !!o);
    this.clip = null;
    await Promise.allSettled(
      outputs.filter((o) => o.state !== 'finalized' && o.state !== 'canceled').map((o) => o.cancel()),
    );
  }
}

/** Whether two decoder configurations describe the same stream (codec, size, parameter sets). */
function sameConfig(a: VideoDecoderConfig, b: VideoDecoderConfig): boolean {
  if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
  const da = bytesOf(a.description);
  const db = bytesOf(b.description);
  if (!da || !db) return !da && !db;
  if (da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  return true;
}

function bytesOf(d: AllowSharedBufferSource | undefined): Uint8Array | null {
  if (!d) return null;
  if (
    d instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && d instanceof SharedArrayBuffer)
  )
    return new Uint8Array(d);
  const v = d as ArrayBufferView;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}
