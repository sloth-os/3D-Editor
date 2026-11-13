import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/mcp/agent';
import {
  FfmpegProcess,
  QUALITY_ENCODING,
  clearFfmpegChecks,
  clipArgs,
  defaultFfmpegPath,
  encoderArgs,
  ffmpegEncoders,
  fpsRational,
  hasFfmpeg,
  keyframeExpression,
  parseEncoders,
  posterArgs,
  requireFfmpeg,
  runFfmpeg,
  streamExtension,
  type EncodeSettings,
} from '../../src/video/ffmpeg';
import { makeFakeFfmpeg, type FakeFfmpeg } from '../helpers/video-fake-ffmpeg';

/*
 * The ffmpeg side of video exports: availability checks, the encoder, clip and poster command
 * lines, and the process wrapper that streams frames into ffmpeg (against a fake ffmpeg: a Node
 * script that reads its stdin and writes placeholder files).
 */

let fake: FakeFfmpeg;
let dir: string;

beforeAll(async () => {
  fake = await makeFakeFfmpeg();
  dir = await mkdtemp(path.join(tmpdir(), 'video-ffmpeg-'));
});

afterEach(() => {
  delete process.env.FAKE_FFMPEG_FAIL;
  delete process.env.FAKE_FFMPEG_NO_X264;
  delete process.env.FAKE_FFMPEG_DELAY_MS;
  clearFfmpegChecks();
});

/** The value after `flag` in an argument list. */
const after = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

const settings = (patch: Partial<EncodeSettings> = {}): EncodeSettings => ({
  width: 160,
  height: 90,
  fps: 24,
  input: 'rgba',
  codec: 'h264',
  quality: 'standard',
  keyframes: [0, 12],
  output: '/out/sequence.mp4',
  ...patch,
});

describe('frame rates and keyframes', () => {
  it('writes rates as exact rationals (NTSC rates as /1001)', () => {
    expect(fpsRational(24).text).toBe('24/1');
    expect(fpsRational(25).text).toBe('25/1');
    expect(fpsRational(23.976).text).toBe('24000/1001');
    expect(fpsRational(24000 / 1001).text).toBe('24000/1001');
    expect(fpsRational(29.97).text).toBe('30000/1001');
    expect(fpsRational(59.94)).toEqual({ num: 60000, den: 1001, text: '60000/1001' });
    expect(fpsRational(12.5).text).toBe('12500/1000');
    expect(() => fpsRational(0)).toThrow();
    expect(() => fpsRational(Number.NaN)).toThrow();
  });

  it('forces keyframes at exact frame numbers, always frame 0, each once', () => {
    expect(keyframeExpression([12, 0, 12, 30])).toBe('expr:eq(n,0)+eq(n,12)+eq(n,30)');
    expect(keyframeExpression([5])).toBe('expr:eq(n,0)+eq(n,5)');
    expect(keyframeExpression([])).toBe('expr:eq(n,0)');
  });
});

describe('encoder command lines', () => {
  it('encodes H.264 for frame-exact stream-copy cuts', () => {
    const args = encoderArgs(settings());
    expect(after(args, '-f')).toBe('rawvideo');
    expect(after(args, '-pix_fmt')).toBe('rgba');
    expect(after(args, '-s')).toBe('160x90');
    expect(after(args, '-framerate')).toBe('24/1');
    expect(after(args, '-i')).toBe('pipe:0');
    expect(after(args, '-c:v')).toBe('libx264');
    expect(after(args, '-bf')).toBe('0');
    expect(after(args, '-g')).toBe('48');
    expect(after(args, '-force_key_frames')).toBe('expr:eq(n,0)+eq(n,12)');
    expect(after(args, '-preset')).toBe(QUALITY_ENCODING.standard.preset);
    expect(after(args, '-crf')).toBe('23');
    expect(after(args, '-vf')).toBe('scale=out_color_matrix=bt709:out_range=tv,format=yuv420p');
    expect(after(args, '-colorspace')).toBe('bt709');
    expect(after(args, '-color_primaries')).toBe('bt709');
    expect(after(args, '-color_trc')).toBe('bt709');
    expect(after(args, '-color_range')).toBe('tv');
    expect(after(args, '-movflags')).toBe('+faststart');
    expect(args).toContain('-an');
    expect(args.slice(-3)).toEqual(['-f', 'mp4', '/out/sequence.mp4']);
    // quality presets: CRF 28 veryfast, 23 medium, 18 slow
    expect(after(encoderArgs(settings({ quality: 'draft' })), '-crf')).toBe('28');
    expect(after(encoderArgs(settings({ quality: 'draft' })), '-preset')).toBe('veryfast');
    expect(after(encoderArgs(settings({ quality: 'high' })), '-crf')).toBe('18');
    expect(after(encoderArgs(settings({ quality: 'high' })), '-preset')).toBe('slow');
    // GOP of 2 s at other rates
    expect(after(encoderArgs(settings({ fps: 30000 / 1001 })), '-g')).toBe('60');
    expect(after(encoderArgs(settings({ fps: 30000 / 1001 })), '-framerate')).toBe('30000/1001');
  });

  it('encodes VP9 WebM and lossless RGB Matroska', () => {
    const vp9 = encoderArgs(settings({ codec: 'vp9', output: '/out/s.webm' }));
    expect(after(vp9, '-c:v')).toBe('libvpx-vp9');
    expect(after(vp9, '-b:v')).toBe('0');
    expect(after(vp9, '-colorspace')).toBe('bt709');
    expect(vp9.slice(-3)).toEqual(['-f', 'webm', '/out/s.webm']);
    expect(vp9).not.toContain('-movflags');
    const lossless = encoderArgs(settings({ codec: 'lossless', input: 'rgb24', output: '/out/mask.mkv' }));
    expect(after(lossless, '-c:v')).toBe('libx264rgb');
    expect(after(lossless, '-qp')).toBe('0');
    expect(after(lossless, '-bf')).toBe('0');
    expect(lossless).not.toContain('-vf'); // no YUV conversion: exact RGB values
    expect(lossless.slice(-3)).toEqual(['-f', 'matroska', '/out/mask.mkv']);
    expect(streamExtension('h264')).toBe('mp4');
    expect(streamExtension('vp9')).toBe('webm');
    expect(streamExtension('lossless')).toBe('mkv');
  });

  it('refuses odd frame sizes', () => {
    expect(() => encoderArgs(settings({ width: 161 }))).toThrow(/even/);
    expect(() => encoderArgs(settings({ height: 0 }))).toThrow(/even/);
  });

  it('cuts clips by stream copy from half a frame after the shot start', () => {
    const args = clipArgs('/out/sequence.mp4', '/out/shot-02.mp4', 12, 12, 24);
    expect(after(args, '-ss')).toBe((12.5 / 24).toFixed(6));
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(after(args, '-i')).toBe('/out/sequence.mp4');
    expect(after(args, '-c')).toBe('copy');
    expect(after(args, '-frames:v')).toBe('12');
    expect(after(args, '-movflags')).toBe('+faststart');
    expect(args.at(-1)).toBe('/out/shot-02.mp4');
    const ntsc = clipArgs('/a.mkv', '/b.mkv', 100, 24, 24000 / 1001);
    expect(Number(after(ntsc, '-ss'))).toBeCloseTo((100.5 * 1001) / 24000, 6);
    expect(ntsc).not.toContain('-movflags');
  });

  it('writes posters as PNG and JPEG from one raw frame', () => {
    const args = posterArgs(160, 90, '/out/p.png', '/out/p.jpg');
    expect(after(args, '-s')).toBe('160x90');
    expect(after(args, '-pix_fmt')).toBe('rgba');
    expect(args.filter((a) => a === '-frames:v')).toHaveLength(2);
    expect(args).toContain('/out/p.png');
    expect(args.at(-1)).toBe('/out/p.jpg');
  });
});

describe('availability', { timeout: 30_000 }, () => {
  it('reads encoder lists', () => {
    const text = [
      'Encoders:',
      ' V..... = Video',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC',
      ' V....D libvpx-vp9           libvpx VP9 (codec vp9)',
      ' A....D aac                  AAC (Advanced Audio Coding)',
    ].join('\n');
    expect([...parseEncoders(text)].sort()).toEqual(['aac', 'libvpx-vp9', 'libx264']);
  });

  it('takes FFMPEG_PATH, else ffmpeg on the PATH', () => {
    expect(defaultFfmpegPath({ FFMPEG_PATH: ' /opt/ff/ffmpeg ' })).toBe('/opt/ff/ffmpeg');
    expect(defaultFfmpegPath({ FFMPEG_PATH: '' })).toBe('ffmpeg');
    expect(defaultFfmpegPath({})).toBe('ffmpeg');
  });

  it('finds a working ffmpeg and its encoders', async () => {
    expect(await hasFfmpeg(fake.path)).toBe(true);
    expect((await ffmpegEncoders(fake.path)).has('libx264')).toBe(true);
    expect((await requireFfmpeg(fake.path)).has('libvpx-vp9')).toBe(true);
  });

  it('answers FFMPEG_UNAVAILABLE with the remedy for a missing ffmpeg or libx264', async () => {
    const missing = path.join(dir, 'no-such-ffmpeg');
    expect(await hasFfmpeg(missing)).toBe(false);
    const err = await requireFfmpeg(missing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('FFMPEG_UNAVAILABLE');
    expect((err as Error).message).toContain(missing);
    expect((err as Error).message).toMatch(/apt-get install ffmpeg/);
    expect((err as Error).message).toMatch(/FFMPEG_PATH/);
    // a non-executable file
    expect(await hasFfmpeg(fake.log)).toBe(false);
    process.env.FAKE_FFMPEG_NO_X264 = '1';
    const noX264 = await requireFfmpeg(fake.path).catch((e: unknown) => e);
    expect((noX264 as ToolError).code).toBe('FFMPEG_UNAVAILABLE');
    expect((noX264 as Error).message).toMatch(/no libx264 encoder/);
  });
});

// these spawn the fake ffmpeg (a Node script): slow on a busy machine
describe('ffmpeg processes', { timeout: 30_000 }, () => {
  it('streams frames into ffmpeg and waits for it', async () => {
    const out = path.join(dir, 'stream.mp4');
    const p = new FfmpegProcess(fake.path, encoderArgs(settings({ output: out })));
    const frame = new Uint8Array(160 * 90 * 4);
    for (let i = 0; i < 5; i++) await p.write(frame);
    await p.finish();
    expect(await readFile(out, 'utf8')).toBe(`fake stream.mp4 ${5 * frame.length}\n`);
  });

  it('reports a failing ffmpeg with the end of what it printed', async () => {
    process.env.FAKE_FFMPEG_FAIL = 'broken';
    const p = new FfmpegProcess(fake.path, encoderArgs(settings({ output: path.join(dir, 'broken.mp4') })));
    await p.write(new Uint8Array(16));
    await expect(p.finish()).rejects.toThrow(/exited with code 1: fake failure for broken/);
  });

  it('kills ffmpeg (SIGKILL) and refuses later writes', async () => {
    process.env.FAKE_FFMPEG_DELAY_MS = '10000';
    const p = new FfmpegProcess(fake.path, encoderArgs(settings({ output: path.join(dir, 'killed.mp4') })));
    await p.write(new Uint8Array(16));
    const t0 = Date.now();
    await p.kill();
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(p.write(new Uint8Array(16))).rejects.toThrow(/ffmpeg/);
    await expect(p.finish()).rejects.toThrow(/stopped/);
  });

  it('fails cleanly when the executable does not exist', async () => {
    const p = new FfmpegProcess(path.join(dir, 'missing-ffmpeg'), ['-version']);
    await p.exited;
    await expect(p.write(new Uint8Array(4))).rejects.toThrow(/ffmpeg/);
    await expect(p.finish()).rejects.toThrow(/ENOENT|ffmpeg/);
  });

  it('runs one-shot commands with input, and stops them on abort', async () => {
    const png = path.join(dir, 'poster.png');
    const jpg = path.join(dir, 'poster.jpg');
    await runFfmpeg(fake.path, posterArgs(2, 2, png, jpg), { input: new Uint8Array(16) });
    expect(await readFile(png, 'utf8')).toBe('fake poster.png 16\n');
    expect(await readFile(jpg, 'utf8')).toBe('fake poster.jpg 16\n');
    process.env.FAKE_FFMPEG_DELAY_MS = '10000';
    const abort = new AbortController();
    const run = runFfmpeg(fake.path, clipArgs(png, path.join(dir, 'clip.mp4'), 0, 1, 24), {
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    await expect(run).rejects.toThrow(/stopped/);
  });
});
