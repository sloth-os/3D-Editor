import { describe, expect, it } from 'vitest';
import {
  BITS_PER_PIXEL,
  KeyFrameSchedule,
  MIN_BITRATE,
  VP9_QUANTIZER,
  avcCodecs,
  avcLevel,
  chooseEncoding,
  gopFrames,
  videoBitrate,
  vp9Codec,
} from '../src/export/codec';
import { BT709_LIMITED, i420Size, toI420 } from '../src/export/yuv';

/*
 * How the browser export encodes: RGB to I420 (BT.709 limited range, the bar values of the
 * standard), the key frames (every shot start, then every round(2 × fps) frames), the H.264 level
 * and profile strings, the bit rate of each quality and size, and the encoder configuration the
 * browser is asked for.
 */

/** A 2 × 2 frame of one RGBA colour. */
function flat(rgb: [number, number, number]): Uint8Array {
  const px = new Uint8Array(16);
  for (let i = 0; i < 4; i++) px.set([...rgb, 255], i * 4);
  return px;
}

describe('I420 (BT.709, limited range)', () => {
  it('gives the standard 100 % colour bar values', () => {
    const bars: [string, [number, number, number], [number, number, number]][] = [
      ['black', [0, 0, 0], [16, 128, 128]],
      ['white', [255, 255, 255], [235, 128, 128]],
      ['red', [255, 0, 0], [63, 102, 240]],
      ['green', [0, 255, 0], [173, 42, 26]],
      ['blue', [0, 0, 255], [32, 240, 118]],
      ['yellow', [255, 255, 0], [219, 16, 138]],
      ['cyan', [0, 255, 255], [188, 154, 16]],
      ['magenta', [255, 0, 255], [78, 214, 230]],
    ];
    for (const [name, rgb, yuv] of bars) {
      const out = toI420(flat(rgb), 'rgba', 2, 2);
      expect([...out], name).toEqual([yuv[0], yuv[0], yuv[0], yuv[0], yuv[1], yuv[2]]);
    }
  });

  it('keeps grey neutral and maps the same bytes alike from RGBA, RGB and gray input', () => {
    for (const v of [0, 1, 64, 128, 191, 254, 255]) {
      const rgba = toI420(flat([v, v, v]), 'rgba', 2, 2);
      const rgb = toI420(new Uint8Array(12).fill(v), 'rgb24', 2, 2);
      const gray = toI420(new Uint8Array(4).fill(v), 'gray', 2, 2);
      expect(rgba[4]).toBe(128);
      expect(rgba[5]).toBe(128);
      expect(rgb).toEqual(rgba);
      expect(gray).toEqual(rgba);
      // Y = 16 + 219/255 × v
      expect(rgba[0]).toBe(Math.round(16 + (219 * v) / 255));
    }
  });

  it('averages each chroma sample over its 2 × 2 pixels and ignores alpha', () => {
    // red and blue columns: Cb = (102.34 + 240.0) / 2, Cr = (240.0 + 117.73) / 2
    const px = new Uint8Array([255, 0, 0, 0, 0, 0, 255, 17, 255, 0, 0, 255, 0, 0, 255, 99]);
    const out = toI420(px, 'rgba', 2, 2);
    expect([...out]).toEqual([63, 32, 63, 32, 171, 179]);
  });

  it('lays the planes out as I420 (Y, then U and V at half width and height)', () => {
    const w = 4;
    const h = 2;
    const px = new Uint8Array(w * h * 4);
    // left half white, right half black
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) px.set(x < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * w + x) * 4);
    const out = toI420(px, 'rgba', w, h);
    expect(out.length).toBe(i420Size(w, h));
    expect([...out]).toEqual([235, 235, 16, 16, 235, 235, 16, 16, 128, 128, 128, 128]);
    expect(() => toI420(px, 'rgba', 3, 2)).toThrow(/even sides/);
  });

  it('tags frames BT.709 limited range', () => {
    expect(BT709_LIMITED).toEqual({
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: false,
    });
  });
});

describe('key frames', () => {
  it('puts one at every shot start and then every round(2 × fps) frames', () => {
    expect(gopFrames(24)).toBe(48);
    expect(gopFrames(30000 / 1001)).toBe(60);
    expect(gopFrames(24000 / 1001)).toBe(48);
    expect(gopFrames(60)).toBe(120);
    expect(gopFrames(0.5)).toBe(1);
    const s = new KeyFrameSchedule([0, 7], 48);
    const keys = Array.from({ length: 121 }, (_, i) => (s.keyFrame(i) ? i : -1)).filter((i) => i >= 0);
    expect(keys).toEqual([0, 7, 55, 103]);
    // a shot start resets the count
    const t = new KeyFrameSchedule([30, 40], 48);
    const k2 = Array.from({ length: 100 }, (_, i) => (t.keyFrame(i) ? i : -1)).filter((i) => i >= 0);
    expect(k2).toEqual([0, 30, 40, 88]);
  });

  it('answers a frame asked again (a padded frame repeated) as before', () => {
    const s = new KeyFrameSchedule([5], 48);
    expect(s.keyFrame(0)).toBe(true);
    expect(s.keyFrame(0)).toBe(true);
    expect(s.keyFrame(4)).toBe(false);
    expect(s.keyFrame(5)).toBe(true);
    expect(s.keyFrame(5)).toBe(true);
  });
});

describe('H.264 levels and bit rates', () => {
  it('picks the lowest level from 3.0 that holds the size, rate and bit rate', () => {
    expect(avcLevel(160, 90, 24)).toBe(30);
    expect(avcLevel(1280, 720, 24)).toBe(31);
    expect(avcLevel(1280, 720, 60)).toBe(32);
    expect(avcLevel(1920, 1080, 30)).toBe(40);
    expect(avcLevel(1920, 1080, 60)).toBe(42);
    expect(avcLevel(3840, 2160, 30)).toBe(51);
    // a wide strip: its width in macroblocks (240) needs level 4's √(8 × 8192)
    expect(avcLevel(3840, 128, 24)).toBe(40);
    // the bit rate: 20 Mbit/s is beyond level 3.1's 17.5 Mbit/s
    expect(avcLevel(1280, 720, 24, 20_000_000)).toBe(32);
    expect(avcCodecs(1280, 720, 24)).toEqual(['avc1.64001f', 'avc1.4d001f', 'avc1.42e01f']);
    expect(avcCodecs(3840, 2160, 30)).toEqual(['avc1.640033', 'avc1.4d0033', 'avc1.42e033']);
    expect(vp9Codec(1280, 720, 24)).toBe('vp09.00.31.08');
    expect(vp9Codec(1920, 1080, 60)).toBe('vp09.00.41.08');
  });

  it('spends bits per pixel by quality, more per pixel for small frames, at least MIN_BITRATE', () => {
    expect(BITS_PER_PIXEL).toEqual({ draft: 0.05, standard: 0.09, high: 0.15 });
    const table: [number, number, number, [number, number, number]][] = [
      [1280, 720, 24, [1_106_000, 1_991_000, 3_318_000]],
      [1280, 720, 60, [2_765_000, 4_977_000, 8_294_000]],
      [1920, 1080, 30, [2_540_000, 4_571_000, 7_619_000]],
      [3840, 2160, 30, [7_183_000, 12_930_000, 21_549_000]],
      [160, 90, 24, [MIN_BITRATE, MIN_BITRATE, MIN_BITRATE]],
    ];
    for (const [w, h, fps, rates] of table)
      expect(
        (['draft', 'standard', 'high'] as const).map((q) => videoBitrate(q, w, h, fps)),
        `${w}×${h}@${fps}`,
      ).toEqual(rates);
  });
});

describe('encoder configuration', () => {
  it('asks for H.264 High, then Main, then Constrained Baseline, in quality latency mode', async () => {
    const asked: string[] = [];
    const enc = await chooseEncoding(
      'h264',
      { width: 1280, height: 720, fps: 24, quality: 'standard' },
      async (c) => {
        asked.push(c.codec);
        return c.codec.startsWith('avc1.4d');
      },
    );
    expect(asked).toEqual(['avc1.64001f', 'avc1.4d001f']);
    expect(enc).toEqual({
      codec: 'h264',
      config: {
        codec: 'avc1.4d001f',
        width: 1280,
        height: 720,
        framerate: 24,
        latencyMode: 'quality',
        bitrate: 1_991_000,
        bitrateMode: 'variable',
        avc: { format: 'avc' },
      },
      quantizer: null,
      muxCodec: 'avc',
      container: 'mp4',
      mime: 'video/mp4',
    });
    expect(
      await chooseEncoding(
        'h264',
        { width: 1280, height: 720, fps: 24, quality: 'draft' },
        async () => false,
      ),
    ).toBeNull();
  });

  it('asks for VP9 with a quantizer (the server CRF), else a bit rate', async () => {
    const q = await chooseEncoding(
      'vp9',
      { width: 1280, height: 720, fps: 24, quality: 'draft' },
      async () => true,
    );
    expect(q?.config).toMatchObject({ codec: 'vp09.00.31.08', bitrateMode: 'quantizer' });
    expect(q?.quantizer).toBe(VP9_QUANTIZER.draft);
    expect(q?.container).toBe('webm');
    const rated = await chooseEncoding(
      'vp9',
      { width: 1280, height: 720, fps: 24, quality: 'high' },
      async (c) => c.bitrateMode !== 'quantizer',
    );
    expect(rated?.config).toMatchObject({ bitrateMode: 'variable', bitrate: 3_318_000 });
    expect(rated?.quantizer).toBeNull();
  });
});
