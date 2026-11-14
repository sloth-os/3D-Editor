import { fpsRational, fpsValue, type ExportQuality } from '@3d-editor/core';

/*
 * How the browser export encodes its videos with WebCodecs: the codec string (H.264 High, else Main,
 * else Constrained Baseline, at the lowest level that holds the frame size and rate; VP9 profile 0),
 * the bit rate of each quality (WebCodecs has no constant-quality mode for H.264: a bit rate per
 * pixel and frame instead of the server's CRF), VP9's quantizer (the server's CRF values), and where
 * the key frames go: at every shot start, so that each shot's clip starts on one and is cut from the
 * stream without encoding again, and at most round(2 × fps) frames after the one before (the
 * server's `-g`).
 */

/** H.264 levels from 3.0 up: macroblocks per second and per frame, High profile bit rate (bit/s). */
const AVC_LEVELS: readonly { idc: number; mbps: number; fs: number; br: number }[] = [
  { idc: 30, mbps: 40_500, fs: 1_620, br: 12_500_000 },
  { idc: 31, mbps: 108_000, fs: 3_600, br: 17_500_000 },
  { idc: 32, mbps: 216_000, fs: 5_120, br: 25_000_000 },
  { idc: 40, mbps: 245_760, fs: 8_192, br: 25_000_000 },
  { idc: 41, mbps: 245_760, fs: 8_192, br: 62_500_000 },
  { idc: 42, mbps: 522_240, fs: 8_704, br: 62_500_000 },
  { idc: 50, mbps: 589_824, fs: 22_080, br: 168_750_000 },
  { idc: 51, mbps: 983_040, fs: 36_864, br: 300_000_000 },
  { idc: 52, mbps: 2_073_600, fs: 36_864, br: 300_000_000 },
  { idc: 60, mbps: 4_177_920, fs: 139_264, br: 300_000_000 },
  { idc: 61, mbps: 8_355_840, fs: 139_264, br: 600_000_000 },
  { idc: 62, mbps: 16_711_680, fs: 139_264, br: 1_000_000_000 },
];

/**
 * The H.264 level (level_idc: 31 is 3.1) of a video of this size, rate and bit rate: the lowest from
 * 3.0 whose limits hold its macroblocks per frame and per second, its sides (at most √(8 × frame
 * size) macroblocks) and its bit rate. 3.0 at least: every decoder takes it, and nothing is gained
 * below.
 */
export function avcLevel(width: number, height: number, fps: number, bitrate = 0): number {
  const mbw = Math.ceil(width / 16);
  const mbh = Math.ceil(height / 16);
  const fs = mbw * mbh;
  const mbps = fs * fps;
  for (const l of AVC_LEVELS) {
    const side = Math.sqrt(8 * l.fs);
    if (fs <= l.fs && mbps <= l.mbps && mbw <= side && mbh <= side && bitrate <= l.br) return l.idc;
  }
  return AVC_LEVELS[AVC_LEVELS.length - 1].idc;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** The H.264 codec strings to try, best first: High, Main, Constrained Baseline, at `avcLevel`. */
export function avcCodecs(width: number, height: number, fps: number, bitrate = 0): string[] {
  const level = hex2(avcLevel(width, height, fps, bitrate));
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}

/** VP9 levels: luma samples per frame and per second. */
const VP9_LEVELS: readonly { level: number; size: number; rate: number }[] = [
  { level: 10, size: 36_864, rate: 829_440 },
  { level: 11, size: 73_728, rate: 2_764_800 },
  { level: 20, size: 122_880, rate: 4_608_000 },
  { level: 21, size: 245_760, rate: 9_216_000 },
  { level: 30, size: 552_960, rate: 20_736_000 },
  { level: 31, size: 983_040, rate: 36_864_000 },
  { level: 40, size: 2_228_224, rate: 83_558_400 },
  { level: 41, size: 2_228_224, rate: 160_432_128 },
  { level: 50, size: 8_912_896, rate: 311_951_360 },
  { level: 51, size: 8_912_896, rate: 588_251_136 },
  { level: 52, size: 8_912_896, rate: 1_176_502_272 },
  { level: 60, size: 35_651_584, rate: 1_176_502_272 },
  { level: 61, size: 35_651_584, rate: 2_353_004_544 },
  { level: 62, size: 35_651_584, rate: 4_706_009_088 },
];

/** The VP9 codec string (profile 0, 8 bits) of a video of this size and rate, at the lowest level that holds it. */
export function vp9Codec(width: number, height: number, fps: number): string {
  const size = width * height;
  const l =
    VP9_LEVELS.find((v) => size <= v.size && size * fps <= v.rate) ?? VP9_LEVELS[VP9_LEVELS.length - 1];
  return `vp09.00.${String(l.level).padStart(2, '0')}.08`;
}

/**
 * Bits per pixel and frame of each quality at 1280 × 720: about what the server's x264 at CRF 28 /
 * 23 / 18 spends on a textured scene; clay and flat looks take less (the encoder spends at most this
 * much).
 */
export const BITS_PER_PIXEL: Readonly<Record<ExportQuality, number>> = {
  draft: 0.05,
  standard: 0.09,
  high: 0.15,
};

/** Lowest bit rate of a video (bit/s): small frames need a floor to stay sharp. */
export const MIN_BITRATE = 150_000;

/**
 * The bit rate of an H.264 video (bit/s): `BITS_PER_PIXEL` of its quality per pixel and frame at
 * 1280 × 720; larger frames take fewer bits per pixel for the same look and smaller ones more (by
 * the fourth root of the pixel ratio, between half and twice), and at least MIN_BITRATE. Rounded
 * to kbit/s.
 */
export function videoBitrate(quality: ExportQuality, width: number, height: number, fps: number): number {
  const pixels = width * height;
  const scale = Math.min(2, Math.max(0.5, Math.pow((1280 * 720) / pixels, 0.25)));
  const bps = BITS_PER_PIXEL[quality] * scale * pixels * fps;
  return Math.max(MIN_BITRATE, Math.round(bps / 1000) * 1000);
}

/** VP9's quantizer (0–63) of each quality: the server's VP9 CRF (ffmpeg.ts QUALITY_ENCODING). */
export const VP9_QUANTIZER: Readonly<Record<ExportQuality, number>> = { draft: 40, standard: 33, high: 28 };

/** Frames from one key frame to the next at most: round(2 × fps) of the exact rate (the server's `-g`). */
export function gopFrames(fps: number): number {
  return Math.max(1, Math.round(2 * fpsValue(fpsRational(fps))));
}

/**
 * Where the key frames of a stream go: at every shot start (the first frame of each clip) and
 * whenever `gop` frames have passed since the last one. Ask for the frames in order.
 */
export class KeyFrameSchedule {
  private readonly starts: ReadonlySet<number>;
  private last = -Infinity;

  constructor(
    shotStarts: Iterable<number>,
    readonly gop: number,
  ) {
    this.starts = new Set([0, ...shotStarts]);
  }

  /** Whether output frame `index` is a key frame (frames asked in order; a repeated frame keeps its answer). */
  keyFrame(index: number): boolean {
    if (index === this.last) return true;
    const key = this.starts.has(index) || index - this.last >= this.gop;
    if (key) this.last = index;
    return key;
  }
}

/** A video encoding the browser can do: the encoder configuration and how packets are muxed. */
export interface VideoEncoding {
  /** The codec asked for ('vp9' falls back to 'h264' where the browser cannot encode it). */
  codec: 'h264' | 'vp9';
  config: VideoEncoderConfig;
  /** VP9's quantizer per frame (`bitrateMode: 'quantizer'`), else null (bit rate). */
  quantizer: number | null;
  /** mediabunny's codec name. */
  muxCodec: 'avc' | 'vp9';
  container: 'mp4' | 'webm';
  mime: 'video/mp4' | 'video/webm';
}

/** Asks the browser whether it encodes a configuration (VideoEncoder.isConfigSupported). */
export type ConfigProbe = (config: VideoEncoderConfig) => Promise<boolean>;

/** The probe of this browser (false without WebCodecs). */
export const browserConfigProbe: ConfigProbe = async (config) => {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return !!(await VideoEncoder.isConfigSupported(config)).supported;
  } catch {
    return false;
  }
};

/**
 * The encoding of a stream of this size, rate and quality the browser supports: H.264 High, Main or
 * Constrained Baseline (variable bit rate, `latencyMode: 'quality'`, length-prefixed NAL units for
 * MP4), or VP9 (quantizer mode, else bit rate) in WebM; null when it supports none.
 */
export async function chooseEncoding(
  codec: 'h264' | 'vp9',
  o: { width: number; height: number; fps: number; quality: ExportQuality },
  probe: ConfigProbe = browserConfigProbe,
): Promise<VideoEncoding | null> {
  const { width, height, fps, quality } = o;
  const bitrate = videoBitrate(quality, width, height, fps);
  const base = { width, height, framerate: fps, latencyMode: 'quality' as const };
  if (codec === 'vp9') {
    const vp9 = vp9Codec(width, height, fps);
    const quantized: VideoEncoderConfig = { ...base, codec: vp9, bitrateMode: 'quantizer' };
    if (await probe(quantized))
      return {
        codec,
        config: quantized,
        quantizer: VP9_QUANTIZER[quality],
        muxCodec: 'vp9',
        container: 'webm',
        mime: 'video/webm',
      };
    const rated: VideoEncoderConfig = { ...base, codec: vp9, bitrate, bitrateMode: 'variable' };
    if (await probe(rated))
      return {
        codec,
        config: rated,
        quantizer: null,
        muxCodec: 'vp9',
        container: 'webm',
        mime: 'video/webm',
      };
    return null;
  }
  for (const c of avcCodecs(width, height, fps, bitrate)) {
    const config: VideoEncoderConfig = {
      ...base,
      codec: c,
      bitrate,
      bitrateMode: 'variable',
      avc: { format: 'avc' },
    };
    if (await probe(config))
      return { codec, config, quantizer: null, muxCodec: 'avc', container: 'mp4', mime: 'video/mp4' };
  }
  return null;
}
