import { execFile } from 'node:child_process';
import type { RideoProbe } from './schemas';

/*
 * What the bridge learns of a clip before it uploads it: ffprobe's account of the file (codec, size,
 * frame rate, decoded frames, duration), which rideo stores as the resource's probe (common.ts
 * ProbeSchema) and the push checks against the rideo shot; and the first frame as a JPEG poster
 * (rideo stores posters as image/jpeg). ffprobe sits next to ffmpeg (FFMPEG_PATH); without it the
 * probe comes from the export's own records, which describe the same file.
 */

/** ffprobe's account of a video file. */
export interface ClipProbe {
  formatName: string;
  durationSec: number;
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** Decoded frames (`-count_frames`), or null when ffprobe could not count them. */
  frames: number | null;
  hasAudio: boolean;
}

/** MP4's format name as ffprobe gives it (and rideo stores it). */
export const MP4_FORMAT_NAME = 'mov,mp4,m4a,3gp,3g2,mj2';
const PROBE_TIMEOUT_MS = 30_000;
const POSTER_TIMEOUT_MS = 30_000;
/** Largest poster accepted from ffmpeg (bytes). */
const MAX_POSTER_BYTES = 16 * 1024 * 1024;

/** The ffprobe that belongs to an ffmpeg executable: next to it, else `ffprobe` on the PATH. */
export function ffprobePath(ffmpegPath: string): string {
  // the directory as written (POSIX or Windows separators), then ffmpeg[.exe]
  const m = /^(.*[\\/])?ffmpeg(\.exe)?$/i.exec(ffmpegPath);
  if (!m) return 'ffprobe';
  return `${m[1] ?? ''}ffprobe${m[2] ?? ''}`;
}

/** A rate like '24/1' or '24000/1001' as a number (null when it is not one). */
export function parseRate(rate: unknown): number | null {
  if (typeof rate !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(rate.trim());
  if (!m) return null;
  const v = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Parses `ffprobe -of json` output of a video file (see {@link probeClip}); null when it has no video. */
export function parseProbe(json: string): ClipProbe | null {
  let j: {
    streams?: Record<string, unknown>[];
    format?: Record<string, unknown>;
  };
  try {
    j = JSON.parse(json) as typeof j;
  } catch {
    return null;
  }
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const video = streams.find((s) => s.codec_type === 'video') ?? streams[0];
  if (!video) return null;
  const width = Number(video.width);
  const height = Number(video.height);
  const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
  const frames = Number(video.nb_read_frames ?? video.nb_frames);
  const duration = Number(j.format?.duration ?? video.duration);
  if (!(width > 0 && height > 0) || !fps) return null;
  return {
    formatName: typeof j.format?.format_name === 'string' ? j.format.format_name : MP4_FORMAT_NAME,
    durationSec: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    codec: typeof video.codec_name === 'string' ? video.codec_name : 'unknown',
    width,
    height,
    fps,
    frames: Number.isInteger(frames) && frames >= 0 ? frames : null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/** Runs ffprobe on a clip (counting its frames); null when ffprobe is missing or fails. */
export function probeClip(
  ffprobe: string,
  file: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ClipProbe | null> {
  const args = [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,nb_frames,duration:format=format_name,duration',
    '-of',
    'json',
    file,
  ];
  return new Promise((resolve) => {
    try {
      execFile(
        ffprobe,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : parseProbe(String(stdout))),
      );
    } catch {
      resolve(null);
    }
  });
}

/** The first frame of a clip as a JPEG (ffmpeg's mjpeg encoder); null when ffmpeg fails. */
export function posterJpeg(
  ffmpeg: string,
  file: string,
  timeoutMs = POSTER_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  const args = [
    '-v',
    'error',
    '-nostdin',
    '-i',
    file,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-',
  ];
  return new Promise((resolve) => {
    try {
      execFile(
        ffmpeg,
        args,
        { timeout: timeoutMs, windowsHide: true, encoding: 'buffer', maxBuffer: MAX_POSTER_BYTES },
        (err, stdout) => {
          const bytes = stdout as unknown as Buffer;
          // a JPEG starts with FF D8
          resolve(
            !err && bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 ? new Uint8Array(bytes) : null,
          );
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** The probe rideo stores for an uploaded clip (common.ts ProbeSchema) from ffprobe's account of it. */
export function rideoProbe(p: ClipProbe): RideoProbe {
  return {
    formatName: p.formatName.slice(0, 200),
    durationSec: Math.max(0, p.durationSec),
    hasVideo: true,
    hasAudio: p.hasAudio,
    width: p.width,
    height: p.height,
    fps: p.fps,
    videoCodec: p.codec.slice(0, 50),
  };
}
