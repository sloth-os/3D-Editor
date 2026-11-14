import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MP4_FORMAT_NAME,
  ffprobePath,
  parseProbe,
  parseRate,
  posterJpeg,
  probeClip,
  rideoProbe,
} from '../../src/rideo/probe';
import { defaultFfmpegPath, hasFfmpeg } from '../../src/video/ffmpeg';

/*
 * What the push learns of a clip before it uploads it (SPEC §11): ffprobe's account of it (rideo
 * stores it as the resource's probe, the push checks frames, rate and size against the rideo shot)
 * and its first frame as a JPEG poster. The real ffmpeg/ffprobe part is skipped without ffmpeg.
 */

const execFileP = promisify(execFile);
const ffmpeg = defaultFfmpegPath();
const real = await hasFfmpeg(ffmpeg);

describe('ffprobe output', () => {
  it('reads rates as ffprobe writes them', () => {
    expect(parseRate('24/1')).toBe(24);
    expect(parseRate('24000/1001')).toBeCloseTo(23.976, 3);
    expect(parseRate('25')).toBe(25);
    for (const bad of ['0/0', '0/1', 'abc', '', undefined, 24])
      expect(parseRate(bad), String(bad)).toBeNull();
  });

  it('reads the video stream, its decoded frame count and the container', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 160,
          height: 90,
          avg_frame_rate: '24/1',
          r_frame_rate: '24/1',
          nb_read_frames: '12',
        },
      ],
      format: { format_name: MP4_FORMAT_NAME, duration: '0.500000' },
    });
    expect(parseProbe(json)).toEqual({
      formatName: MP4_FORMAT_NAME,
      durationSec: 0.5,
      codec: 'h264',
      width: 160,
      height: 90,
      fps: 24,
      frames: 12,
      hasAudio: true,
    });
    // no decoded count: the container's own, else unknown
    const noCount = JSON.parse(json);
    delete noCount.streams[1].nb_read_frames;
    expect(parseProbe(JSON.stringify(noCount))!.frames).toBeNull();
    noCount.streams[1].nb_frames = '12';
    expect(parseProbe(JSON.stringify(noCount))!.frames).toBe(12);
    // not a video ffprobe can read
    expect(parseProbe('nope')).toBeNull();
    expect(parseProbe(JSON.stringify({ streams: [] }))).toBeNull();
    expect(
      parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 0, height: 0 }] })),
    ).toBeNull();
  });

  it('becomes the probe rideo stores', () => {
    expect(
      rideoProbe({
        formatName: MP4_FORMAT_NAME,
        durationSec: 0.5,
        codec: 'h264',
        width: 160,
        height: 90,
        fps: 24,
        frames: 12,
        hasAudio: false,
      }),
    ).toEqual({
      formatName: MP4_FORMAT_NAME,
      durationSec: 0.5,
      hasVideo: true,
      hasAudio: false,
      width: 160,
      height: 90,
      fps: 24,
      videoCodec: 'h264',
    });
  });

  it('ffprobe sits next to the ffmpeg in use', () => {
    expect(ffprobePath('ffmpeg')).toBe('ffprobe');
    expect(ffprobePath('ffmpeg.exe')).toBe('ffprobe.exe');
    expect(ffprobePath('/opt/ff/bin/ffmpeg')).toBe('/opt/ff/bin/ffprobe');
    expect(ffprobePath('C:\\ff\\ffmpeg.exe')).toBe('C:\\ff\\ffprobe.exe');
    expect(ffprobePath('/usr/local/bin/my-ffmpeg-wrapper')).toBe('ffprobe');
  });
});

describe.skipIf(!real)('with the real ffmpeg', () => {
  let dir = '';
  let clip = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rideo-probe-'));
    clip = path.join(dir, 'clip.mp4');
    await execFileP(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x90:rate=24',
      '-frames:v',
      '12',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      clip,
    ]);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('probes a clip: codec, size, rate and the frames decoded', async () => {
    const p = await probeClip(ffprobePath(ffmpeg), clip);
    expect(p).toMatchObject({
      formatName: MP4_FORMAT_NAME,
      codec: 'h264',
      width: 160,
      height: 90,
      fps: 24,
      frames: 12,
      hasAudio: false,
    });
    expect(p!.durationSec).toBeCloseTo(0.5, 2);
  });

  it('makes a JPEG of its first frame', async () => {
    const jpeg = await posterJpeg(ffmpeg, clip);
    expect(jpeg).not.toBeNull();
    expect([...jpeg!.slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it('answers null for what is not a video, or without ffprobe', async () => {
    const text = path.join(dir, 'not-a-video.mp4');
    await writeFile(text, 'hello');
    expect(await probeClip(ffprobePath(ffmpeg), text)).toBeNull();
    expect(await posterJpeg(ffmpeg, text)).toBeNull();
    expect(await probeClip(path.join(dir, 'no-ffprobe'), clip)).toBeNull();
  });
});
