import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { ToolError } from '../mcp/agent';

/*
 * The ffmpeg executable of video exports (FFMPEG_PATH, default `ffmpeg` on the PATH): availability
 * checks, the encoder command lines (frame-exact H.264 for stream-copy cuts, VP9, lossless RGB) and
 * a process wrapper that streams raw frames into ffmpeg's stdin with backpressure.
 */

/** How long `ffmpeg -version` may take before ffmpeg counts as missing. */
const VERSION_TIMEOUT_MS = 5000;
/** Bytes of ffmpeg's stderr kept for error messages. */
const STDERR_TAIL_BYTES = 4096;

/** The executable when none is given: FFMPEG_PATH, else `ffmpeg` on the PATH. */
export function defaultFfmpegPath(env: Record<string, string | undefined> = process.env): string {
  return env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

const checks = new Map<string, Promise<boolean>>();
const encoderLists = new Map<string, Promise<Set<string>>>();

/**
 * Whether `path` runs as ffmpeg: `ffmpeg -version` exits with 0 within 5 s. Checked once per path
 * and process (the answer is cached, also a negative one: the server checks at startup), so it is
 * cheap to ask again. Never rejects.
 */
export function hasFfmpeg(path: string = defaultFfmpegPath()): Promise<boolean> {
  let check = checks.get(path);
  if (!check) {
    check = new Promise<boolean>((resolve) => {
      try {
        execFile(path, ['-version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err) =>
          resolve(!err),
        );
      } catch {
        resolve(false);
      }
    });
    checks.set(path, check);
  }
  return check;
}

/** The video encoders `ffmpeg -encoders` lists (cached per path; empty when it fails). Never rejects. */
export function ffmpegEncoders(path: string = defaultFfmpegPath()): Promise<Set<string>> {
  let list = encoderLists.get(path);
  if (!list) {
    list = new Promise<Set<string>>((resolve) => {
      try {
        execFile(
          path,
          ['-hide_banner', '-encoders'],
          { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => resolve(err ? new Set() : parseEncoders(String(stdout))),
        );
      } catch {
        resolve(new Set());
      }
    });
    encoderLists.set(path, list);
  }
  return list;
}

/** The encoder names of `ffmpeg -encoders` output (lines like ` V....D libx264  libx264 H.264 …`). */
export function parseEncoders(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([VAS][.A-Z]{5})\s+(\S+)/.exec(line);
    if (m && m[2] !== '=') out.add(m[2]);
  }
  return out;
}

/** Forgets the cached answers of {@link hasFfmpeg} and {@link ffmpegEncoders} (tests with a fake ffmpeg). */
export function clearFfmpegChecks(): void {
  checks.clear();
  encoderLists.clear();
}

/** What the server says when it cannot export videos for want of ffmpeg, with the remedy. */
export function ffmpegUnavailable(path: string, missing: string | null = null): ToolError {
  const what = missing
    ? `the ffmpeg at '${path}' has no ${missing} encoder`
    : `ffmpeg is not installed on the server (or FFMPEG_PATH='${path}' does not run it)`;
  return new ToolError(
    `Video export needs ffmpeg: ${what}. Install ffmpeg with libx264 on the server (Debian/Ubuntu: apt-get install ffmpeg; Alpine: apk add ffmpeg) or set FFMPEG_PATH to it, then restart the server.`,
    'FFMPEG_UNAVAILABLE',
  );
}

/**
 * Checks that `path` runs ffmpeg with libx264 (FFMPEG_UNAVAILABLE otherwise); returns its encoders.
 */
export async function requireFfmpeg(path: string): Promise<Set<string>> {
  if (!(await hasFfmpeg(path))) throw ffmpegUnavailable(path);
  const encoders = await ffmpegEncoders(path);
  if (!encoders.has('libx264')) throw ffmpegUnavailable(path, 'libx264');
  return encoders;
}

// ---------------------------------------------------------------- command lines

/** A frame rate as ffmpeg's rational (NTSC rates exact: 23.976 → 24000/1001). */
export function fpsRational(fps: number): { num: number; den: number; text: string } {
  if (!(Number.isFinite(fps) && fps > 0)) throw new Error(`invalid frame rate ${fps}`);
  for (const base of [24, 30, 48, 60, 120]) {
    const ntsc = (base * 1000) / 1001;
    if (Math.abs(fps - ntsc) < 0.0015) return { num: base * 1000, den: 1001, text: `${base * 1000}/1001` };
  }
  if (Math.abs(fps - Math.round(fps)) < 1e-9) {
    const n = Math.round(fps);
    return { num: n, den: 1, text: `${n}/1` };
  }
  const num = Math.round(fps * 1000);
  return { num, den: 1000, text: `${num}/1000` };
}

/** The exact rate of a rational (frames per second). */
export function fpsValue(r: { num: number; den: number }): number {
  return r.num / r.den;
}

export type RawPixelFormat = 'rgba' | 'rgb24' | 'gray';
export type VideoQuality = 'draft' | 'standard' | 'high';

/** x264 / VP9 rate control per quality (SPEC §9: CRF 28 veryfast, 23 medium, 18 slow). */
export const QUALITY_ENCODING: Readonly<
  Record<VideoQuality, { preset: string; crf: number; vp9Crf: number; vp9Speed: number }>
> = {
  draft: { preset: 'veryfast', crf: 28, vp9Crf: 40, vp9Speed: 6 },
  standard: { preset: 'medium', crf: 23, vp9Crf: 33, vp9Speed: 4 },
  high: { preset: 'slow', crf: 18, vp9Crf: 28, vp9Speed: 2 },
};

/** How a stream is encoded: H.264 or VP9 for viewing, lossless RGB H.264 for data passes. */
export type StreamCodec = 'h264' | 'vp9' | 'lossless';

/**
 * The encoder threads of an x264 stream (libx264, libx264rgb) `height` pixels high: x264's own
 * automatic count, 1.5 per core but at most one per two rows of 16-pixel macroblocks (6 on 4
 * cores; 22 at most at 720p, 34 at 1080p). Exports pass it explicitly (`-threads`), so the count,
 * and the encoders' memory the export plans with (memory.ts), is the same whatever x264 itself
 * would see: it counts every core of the machine, also in a container whose CPU quota Node's
 * `availableParallelism()` follows.
 */
export function x264Threads(height: number, cores: number = availableParallelism()): number {
  const rows = Math.max(1, ((Math.max(1, Math.round(height)) + 15) >> 4) >> 1);
  return Math.max(1, Math.min(Math.round(1.5 * cores), rows));
}

export interface EncodeSettings {
  width: number;
  height: number;
  fps: number;
  /** The raw frames written to stdin. */
  input: RawPixelFormat;
  codec: StreamCodec;
  quality: VideoQuality;
  /** Output frame numbers that must start with a keyframe (the shot starts). */
  keyframes: readonly number[];
  output: string;
  /** x264 encoder threads (h264, lossless; default {@link x264Threads}); VP9 keeps libvpx's own. */
  threads?: number;
}

/** The container of a stream (mp4, webm or mkv). */
export function streamExtension(codec: StreamCodec): 'mp4' | 'webm' | 'mkv' {
  return codec === 'vp9' ? 'webm' : codec === 'lossless' ? 'mkv' : 'mp4';
}

/**
 * ffmpeg's -force_key_frames expression for keyframes at exactly these frame numbers (frame
 * numbers, not times: exact whatever the rate's rounding).
 */
export function keyframeExpression(frames: readonly number[]): string {
  const list = [...new Set(frames.map((f) => Math.max(0, Math.round(f))))].sort((a, b) => a - b);
  if (!list.length || list[0] !== 0) list.unshift(0);
  return `expr:${list.map((f) => `eq(n,${f})`).join('+')}`;
}

/**
 * The ffmpeg arguments that encode raw frames from stdin into `output`:
 * - h264: libx264 without B-frames (stream-copy cuts at the forced keyframes are frame-exact),
 *   yuv420p, BT.709 matrix and tags, full → limited range, a keyframe at least every 2 s and at
 *   every shot start, +faststart, no audio;
 * - vp9: libvpx-vp9 in WebM with the same keyframes and colour tags;
 * - lossless: libx264rgb at qp 0 in Matroska (exact RGB values, for mask and edge passes).
 * The x264 encoders get their thread count explicitly ({@link x264Threads}).
 */
export function encoderArgs(s: EncodeSettings): string[] {
  if (!(s.width >= 2 && s.height >= 2 && s.width % 2 === 0 && s.height % 2 === 0))
    throw new Error(`video size ${s.width}×${s.height} must be even`);
  const rate = fpsRational(s.fps);
  const gop = Math.max(1, Math.round(2 * fpsValue(rate)));
  const q = QUALITY_ENCODING[s.quality];
  const threads = ['-threads', String(Math.max(1, Math.round(s.threads ?? x264Threads(s.height))))];
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    s.input,
    '-s',
    `${s.width}x${s.height}`,
    '-framerate',
    rate.text,
    '-i',
    'pipe:0',
    '-an',
    '-sn',
    '-dn',
  ];
  const keys = ['-g', String(gop), '-force_key_frames', keyframeExpression(s.keyframes)];
  const bt709 = [
    '-vf',
    'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-color_range',
    'tv',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
  ];
  if (s.codec === 'lossless')
    args.push(
      '-c:v',
      'libx264rgb',
      ...threads,
      '-preset',
      'veryfast',
      '-qp',
      '0',
      '-bf',
      '0',
      ...keys,
      '-pix_fmt',
      'rgb24',
    );
  else if (s.codec === 'vp9')
    args.push(
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      String(q.vp9Crf),
      '-deadline',
      'good',
      '-cpu-used',
      String(q.vp9Speed),
      '-row-mt',
      '1',
      ...keys,
      ...bt709,
    );
  else
    args.push(
      '-c:v',
      'libx264',
      ...threads,
      '-preset',
      q.preset,
      '-crf',
      String(q.crf),
      '-bf',
      '0',
      ...keys,
      ...bt709,
      '-movflags',
      '+faststart',
    );
  args.push('-f', s.codec === 'vp9' ? 'webm' : s.codec === 'lossless' ? 'matroska' : 'mp4', s.output);
  return args;
}

/**
 * The ffmpeg arguments that copy frames [start, start + frames) of a stream encoded by
 * {@link encoderArgs} into a clip without re-encoding: the input is opened half a frame after the
 * shot's forced keyframe (stream copy starts at the keyframe at or before that time, which is that
 * one) and `frames` frames are copied; MP4 clips get +faststart.
 */
export function clipArgs(
  input: string,
  output: string,
  start: number,
  frames: number,
  fps: number,
): string[] {
  const rate = fpsRational(fps);
  const t = ((start + 0.5) * rate.den) / rate.num;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-ss',
    t.toFixed(6),
    '-i',
    input,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-frames:v',
    String(frames),
    '-an',
    '-avoid_negative_ts',
    'make_zero',
  ];
  if (output.endsWith('.mp4')) args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

/** The ffmpeg arguments that write one raw RGBA frame from stdin as a PNG and a JPEG (posters). */
export function posterArgs(width: number, height: number, png: string, jpeg: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-update',
    '1',
    '-pix_fmt',
    'rgb24',
    png,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-update',
    '1',
    '-q:v',
    '2',
    '-pix_fmt',
    'yuvj420p',
    jpeg,
  ];
}

// ---------------------------------------------------------------- processes

/** An ffmpeg process fed raw frames on stdin. */
export class FfmpegProcess {
  private readonly child: ChildProcess;
  private stderr = '';
  private failure: Error | null = null;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
  private killed = false;

  constructor(
    readonly path: string,
    readonly args: readonly string[],
  ) {
    this.child = spawn(path, [...args], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.exited = new Promise<void>((resolve) => {
      this.child.once('close', (code, signal) => {
        this.exit = { code, signal };
        resolve();
      });
      this.child.once('error', (err) => {
        this.failure ??= err;
        this.exit ??= { code: null, signal: null };
        resolve();
      });
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // a write after ffmpeg exited fails with EPIPE: reported by write() / finish()
    this.child.stdin?.on('error', (err) => {
      this.failure ??= err;
    });
  }

  /** The process id (undefined when it could not start). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The error of a failed process: its exit and the end of what it printed. */
  private error(): Error {
    const tail = this.stderr.trim().split('\n').slice(-3).join(' | ');
    const how = this.exit
      ? this.exit.signal
        ? `was stopped (${this.exit.signal})`
        : `exited with code ${this.exit.code}`
      : 'failed';
    const cause = this.failure && !tail ? `: ${this.failure.message}` : '';
    return new Error(`ffmpeg ${how}${cause}${tail ? `: ${tail}` : ''}`);
  }

  /** Whether the process failed or exited (it takes no more input). */
  private ended(): boolean {
    return !!this.failure || !!this.exit;
  }

  /** Writes one frame's bytes; resolves once ffmpeg took them (backpressure), rejects when it died. */
  async write(bytes: Uint8Array): Promise<void> {
    const stdin = this.child.stdin;
    if (this.ended() || !stdin || stdin.destroyed) throw this.error();
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (stdin.write(buf)) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        stdin.off('drain', done);
        stdin.off('close', done);
        resolve();
      };
      stdin.once('drain', done);
      stdin.once('close', done);
      this.exited.then(done, reject);
    });
    if (this.ended()) throw this.error();
  }

  /** Ends the input and waits for ffmpeg to finish; rejects when it failed. */
  async finish(): Promise<void> {
    this.child.stdin?.end();
    await this.exited;
    if (this.killed) throw new Error('ffmpeg was stopped');
    if (this.failure || !this.exit || this.exit.code !== 0) throw this.error();
  }

  /** Stops ffmpeg at once (SIGKILL); resolves when it has exited. */
  kill(): Promise<void> {
    this.killed = true;
    if (!this.exit) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    return this.exited;
  }
}

/** Runs ffmpeg to completion (with optional stdin bytes); `signal` kills it. Rejects when it fails. */
export async function runFfmpeg(
  path: string,
  args: readonly string[],
  opts: { input?: Uint8Array; signal?: AbortSignal } = {},
): Promise<void> {
  const p = new FfmpegProcess(path, args);
  const onAbort = () => void p.kill();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (opts.input) await p.write(opts.input);
    await p.finish();
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
