import { describe, expect, it } from 'vitest';
import {
  APNGEncoder,
  apngFrameDelay,
  decodePNG,
  encodeAPNG,
  encodeGIF,
  gifFrameDelays,
  lzwEncode,
  quantizePalette,
} from '../src';
import { decodeAPNG, decodeGIF, lzwDecode, solidFrame } from './render-animation-helpers';
import { cpuMs } from './timing-helpers';

type RGBA = [number, number, number, number];
const BG: RGBA = [20, 40, 60, 255];
const RED: RGBA = [230, 30, 20, 255];
const GREEN: RGBA = [10, 200, 90, 255];

/** A square moving right over a background, plus a static green bar. */
function movingSquare(count: number, w = 24, h = 16) {
  return Array.from({ length: count }, (_, k) =>
    solidFrame(w, h, BG, [
      { x: 2, y: 12, w: 20, h: 2, color: GREEN },
      { x: 2 + 3 * k, y: 3, w: 5, h: 5, color: RED },
    ]),
  );
}

/** Deterministic pseudo-random bytes. */
function noiseBytes(n: number, seed: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) throw new Error(`differs at byte ${i}: ${a[i]} vs ${b[i]}`);
};

describe('encodeAPNG', () => {
  it('writes spec-conformant chunks and reproduces every frame exactly', () => {
    const frames = movingSquare(4);
    const file = encodeAPNG(frames, 24);
    const apng = decodeAPNG(file);
    expect(apng.width).toBe(24);
    expect(apng.height).toBe(16);
    expect(apng.numFrames).toBe(4);
    expect(apng.numPlays).toBe(0);
    expect(apng.chunkTypes).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'fcTL',
      'fdAT',
      'fcTL',
      'fdAT',
      'fcTL',
      'fdAT',
      'IEND',
    ]);
    expect(apng.frames.map((f) => f.sequence)).toEqual([0, 1, 3, 5]);
    expect(apng.frames.slice(1).map((f) => f.dataSequences)).toEqual([[2], [4], [6]]);
    for (const f of apng.frames) {
      expect([f.delayNum, f.delayDen]).toEqual([1, 24]);
      expect([f.dispose, f.blend]).toEqual([0, 0]);
    }
    // later frames only store the rectangle where the square moved
    expect(apng.frames[1]).toMatchObject({ x: 2, y: 3, width: 8, height: 5 });
    apng.canvases.forEach((c, k) => same(c, frames[k].data));
    // a plain PNG decoder shows the first frame
    same(decodePNG(file).data, frames[0].data);
  });

  it('handles identical frames, full frames, transparency, looping and noisy data', () => {
    const still = [solidFrame(5, 4, BG), solidFrame(5, 4, BG)];
    const apng = decodeAPNG(encodeAPNG(still, 10, { loop: 3 }));
    expect(apng.numPlays).toBe(3);
    expect(apng.frames[1]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
    same(apng.canvases[1], still[1].data);
    const full = decodeAPNG(encodeAPNG(movingSquare(3), 12, { optimize: false, level: 0 }));
    expect(full.frames.every((f) => f.width === 24 && f.height === 16)).toBe(true);
    const ghost = [
      solidFrame(6, 6, [0, 0, 0, 0], [{ x: 1, y: 1, w: 2, h: 2, color: [255, 0, 0, 128] }]),
      solidFrame(6, 6, [0, 0, 0, 0], [{ x: 3, y: 2, w: 2, h: 2, color: [0, 0, 255, 255] }]),
    ];
    decodeAPNG(encodeAPNG(ghost, 5)).canvases.forEach((c, k) => same(c, ghost[k].data));
    const noisy = [0, 1, 2].map((s) => ({ width: 13, height: 7, data: noiseBytes(13 * 7 * 4, s + 1) }));
    decodeAPNG(encodeAPNG(noisy, 30)).canvases.forEach((c, k) => same(c, noisy[k].data));
  });

  it('chooses exact 16-bit frame delays', () => {
    expect(apngFrameDelay(24)).toEqual([1, 24]);
    expect(apngFrameDelay(29.97)).toEqual([1000, 29970]);
    expect(apngFrameDelay(12.5)).toEqual([1000, 12500]);
    expect(apngFrameDelay(0.5)).toEqual([1000, 500]);
    expect(apngFrameDelay(1e-6)).toEqual([65535, 1]);
    expect(decodeAPNG(encodeAPNG(movingSquare(2), 29.97)).frames[0]).toMatchObject({
      delayNum: 1000,
      delayDen: 29970,
    });
  });

  it('encodes incrementally and validates its input', () => {
    const enc = new APNGEncoder(24, 16, 8);
    expect(() => enc.finish()).toThrow(/no frames/);
    for (const f of movingSquare(3)) enc.addFrame(f);
    expect(enc.frameCount).toBe(3);
    expect(decodeAPNG(enc.finish()).numFrames).toBe(3);
    expect(() => enc.addFrame(solidFrame(4, 4, BG))).toThrow(/every frame must be 24×16/);
    expect(() => encodeAPNG([], 24)).toThrow(/no frames/);
    expect(() => encodeAPNG(movingSquare(1), 0)).toThrow(/fps/);
    expect(() => encodeAPNG([{ width: 2, height: 2, data: new Uint8Array(3) }], 24)).toThrow(/too short/);
    expect(() => new APNGEncoder(0, 5, 24)).toThrow(/invalid frame size/);
  });
});

describe('GIF LZW', () => {
  const roundTrip = (indices: Uint8Array, minCodeSize: number) => {
    const res = lzwDecode(lzwEncode(indices, minCodeSize), minCodeSize);
    expect(res.ended).toBe(true);
    same(res.indices, indices);
    return res;
  };

  it('round-trips random data through code size growth and table resets', () => {
    const bytes = Uint8Array.from(noiseBytes(60000, 7));
    const res = roundTrip(bytes, 8);
    expect(res.clears).toBeGreaterThan(5); // the 4096-entry table fills up repeatedly
    for (const bits of [2, 3, 5, 7]) {
      const small = Uint8Array.from(noiseBytes(20000, bits), (v) => v & ((1 << bits) - 1));
      expect(roundTrip(small, bits).clears).toBeGreaterThan(1);
    }
  });

  it('compresses runs and handles tiny inputs', () => {
    const run = new Uint8Array(100000).fill(3);
    expect(lzwEncode(run, 2).length).toBeLessThan(1200);
    roundTrip(run, 2);
    roundTrip(Uint8Array.from([1]), 2);
    roundTrip(new Uint8Array(0), 4);
    // KwKwK patterns (code == next) and alternating sequences
    roundTrip(
      Uint8Array.from({ length: 5000 }, (_, i) => (i % 7 === 0 ? 1 : 0)),
      2,
    );
    roundTrip(
      Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 255),
      8,
    );
    expect(() => lzwEncode(Uint8Array.from([4]), 2)).toThrow(/does not fit/);
    expect(() => lzwEncode(new Uint8Array(1), 1)).toThrow(/minimum code size/);
  });

  it('writes the end code with the code size the decoder has grown to after the last data code', () => {
    // the decoder adds a table entry for the last data code as well: here that entry is the
    // eighth one, so it reads the end code with 4 bits instead of 3
    roundTrip(Uint8Array.from([0, 0, 1, 0, 2, 0, 3, 1, 1, 2, 1]), 2);
    // many short streams end exactly at a code size boundary
    let s = 99;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
    for (let k = 0; k < 4000; k++) {
      const bits = 2 + Math.floor(rnd() * 3);
      const n = 1 + Math.floor(rnd() * 60);
      roundTrip(
        Uint8Array.from({ length: n }, () => Math.floor(rnd() * (1 << bits))),
        bits,
      );
    }
    // through the file format: a strict decoder needs the end code
    const colours: RGBA[] = [BG, RED, GREEN, [250, 250, 250, 255]];
    for (let k = 0; k < 300; k++) {
      const frame = solidFrame(11, 1, BG);
      for (let x = 0; x < 11; x++) frame.data.set(colours[Math.floor(rnd() * 4)], x * 4);
      same(decodeGIF(encodeGIF([frame], 10, { dither: 'NONE' })).canvases[0], frame.data);
    }
  });
});

describe('GIF palette and dithering', () => {
  it('keeps exact colours when there are few of them', () => {
    const frames = movingSquare(3);
    const pal = quantizePalette(frames, 256);
    const colours = new Set<string>();
    for (let i = 0; i < pal.length; i += 3) colours.add(`${pal[i]},${pal[i + 1]},${pal[i + 2]}`);
    expect(colours).toEqual(new Set(['20,40,60', '230,30,20', '10,200,90']));
    expect(quantizePalette(frames, 256)).toEqual(pal);
    expect(quantizePalette([solidFrame(3, 3, [0, 0, 0, 0])], 16)).toEqual(new Uint8Array(3));
  });

  it('spreads colours over smooth gradients', () => {
    const w = 256;
    const data = new Uint8ClampedArray(w * 4);
    for (let x = 0; x < w; x++) data.set([x, Math.floor(x / 2), 255 - x, 255], x * 4);
    const pal = quantizePalette([{ width: w, height: 1, data }], 16);
    expect(pal.length).toBe(16 * 3);
    let worst = 0;
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (let i = 0; i < pal.length; i += 3)
        best = Math.min(best, Math.hypot(pal[i] - x, pal[i + 1] - Math.floor(x / 2), pal[i + 2] - (255 - x)));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(16);
  });

  it('dithers gradients so local averages match the source', () => {
    const w = 64;
    const h = 32;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data.set([x * 4, x * 4, x * 4, 255], (y * w + x) * 4);
    const frame = { width: w, height: h, data };
    const gif = (dither: 'NONE' | 'FLOYD_STEINBERG' | 'BAYER') =>
      decodeGIF(encodeGIF([frame], 10, { colors: 4, dither }));
    // 4 greys spread over the ramp (the ends 0..29 and 223..252 lie outside the palette's hull)
    expect(Array.from(gif('NONE').palette)).toEqual([30, 30, 30, 94, 94, 94, 158, 158, 158, 222, 222, 222]);
    /** Mean error of 8×8 block averages (one full Bayer tile each) away from the unreachable ends. */
    const blockError = (dither: 'NONE' | 'FLOYD_STEINBERG' | 'BAYER') => {
      const c = gif(dither).canvases[0];
      let err = 0;
      let blocks = 0;
      for (let by = 0; by < h; by += 8)
        for (let bx = 8; bx < w - 8; bx += 8) {
          let sum = 0;
          let want = 0;
          for (let y = by; y < by + 8; y++)
            for (let x = bx; x < bx + 8; x++) {
              sum += c[(y * w + x) * 4];
              want += x * 4;
            }
          err += Math.abs(sum - want) / 64;
          blocks++;
        }
      return err / blocks;
    };
    expect(blockError('NONE')).toBeGreaterThan(12); // banding: whole blocks snap to one grey
    expect(blockError('FLOYD_STEINBERG')).toBeLessThan(2);
    expect(blockError('BAYER')).toBeLessThan(4);
    // ordered dithering only uses the two palette greys around each source value
    const bayer = gif('BAYER').canvases[0];
    for (let x = 8; x < w - 8; x++) {
      const v = x * 4;
      for (let y = 0; y < h; y++) expect(Math.abs(bayer[(y * w + x) * 4] - v)).toBeLessThanOrEqual(64);
    }
    const a = encodeGIF([frame], 10, { colors: 4, dither: 'BAYER' });
    expect(encodeGIF([frame], 10, { colors: 4, dither: 'BAYER' })).toEqual(a);
  });
});

describe('encodeGIF', () => {
  it('writes GIF89a with a global palette, looping, delays and changed-pixel frames', () => {
    const frames = movingSquare(5);
    const file = encodeGIF(frames, 24, { dither: 'NONE' });
    const gif = decodeGIF(file);
    expect(gif.width).toBe(24);
    expect(gif.height).toBe(16);
    expect(gif.loopCount).toBe(0);
    expect(gif.frames).toHaveLength(5);
    expect(gif.frames.map((f) => f.delay)).toEqual([4, 4, 5, 4, 4]);
    expect(gif.frames.every((f) => f.disposal === 1)).toBe(true);
    expect(gif.frames[0]).toMatchObject({ x: 0, y: 0, width: 24, height: 16 });
    expect(gif.frames[1]).toMatchObject({ x: 2, y: 3, width: 8, height: 5 });
    expect(gif.frames[1].transparentIndex).not.toBeNull();
    gif.canvases.forEach((c, k) => same(c, frames[k].data));
    expect(file[file.length - 1]).toBe(0x3b);
  });

  it('supports play counts, single frames and identical frames', () => {
    expect(decodeGIF(encodeGIF(movingSquare(2), 10, { loop: 1 })).loopCount).toBeNull();
    expect(decodeGIF(encodeGIF(movingSquare(2), 10, { loop: 3 })).loopCount).toBe(2);
    const single = decodeGIF(encodeGIF([solidFrame(3, 2, RED)], 10));
    expect(single.frames).toHaveLength(1);
    expect(single.frames[0].transparentIndex).toBeNull();
    expect(single.palette.length).toBe(6); // two-entry table (minimum size)
    same(single.canvases[0], solidFrame(3, 2, RED).data);
    const still = decodeGIF(encodeGIF([solidFrame(4, 4, BG), solidFrame(4, 4, BG)], 10, { dither: 'NONE' }));
    expect(still.frames[1]).toMatchObject({ width: 1, height: 1 });
    same(still.canvases[1], solidFrame(4, 4, BG).data);
    const full = decodeGIF(encodeGIF(movingSquare(3), 10, { optimize: false, dither: 'NONE' }));
    expect(full.frames.every((f) => f.width === 24 && f.transparentIndex === null)).toBe(true);
  });

  it('adds the transparent index on top of the requested number of colours', () => {
    const black: RGBA = [0, 0, 0, 255];
    const white: RGBA = [255, 255, 255, 255];
    const a = solidFrame(16, 16, black, [{ x: 0, y: 0, w: 8, h: 16, color: white }]);
    const b = solidFrame(16, 16, black, [{ x: 8, y: 0, w: 8, h: 16, color: white }]);
    // two colours plus the transparent index of the optimized second frame: a 4-entry table
    const gif = decodeGIF(encodeGIF([a, b], 2, { colors: 2, dither: 'NONE' }));
    expect(gif.palette.length).toBe(4 * 3);
    expect(gif.frames[1].transparentIndex).toBe(2);
    gif.canvases.forEach((c, k) => same(c, [a, b][k].data));
    // no transparency needed: exactly the requested colours
    const still = decodeGIF(encodeGIF([a], 2, { colors: 2, dither: 'NONE' }));
    expect(still.palette.length).toBe(2 * 3);
    same(still.canvases[0], a.data);
    // 16 colours of a 20-colour animation: 16 used plus the transparent index
    const bars = (shift: number) =>
      solidFrame(
        20,
        4,
        black,
        Array.from({ length: 20 }, (_, i) => ({
          x: (i + shift) % 20,
          y: 0,
          w: 1,
          h: 4,
          color: [i * 12, 255 - i * 12, (i * 37) % 256, 255] as RGBA,
        })),
      );
    const sixteen = decodeGIF(encodeGIF([bars(0), bars(1)], 2, { colors: 16, dither: 'NONE' }));
    const used = new Set<number>();
    for (const f of sixteen.frames) for (const v of f.indices) if (v !== f.transparentIndex) used.add(v);
    expect(used.size).toBe(16);
    expect(sixteen.frames[1].transparentIndex).toBe(16);
  });

  it('keeps transparency with restore-to-background frames', () => {
    const clear: RGBA = [0, 0, 0, 0];
    const frames = [
      solidFrame(8, 8, clear, [{ x: 1, y: 1, w: 3, h: 3, color: RED }]),
      solidFrame(8, 8, clear, [{ x: 4, y: 4, w: 3, h: 3, color: RED }]),
    ];
    const gif = decodeGIF(encodeGIF(frames, 10, { dither: 'NONE' }));
    expect(gif.frames.every((f) => f.disposal === 2 && f.width === 8 && f.transparentIndex !== null)).toBe(
      true,
    );
    gif.canvases.forEach((c, k) =>
      frames[k].data.forEach((v, i) => {
        if (i % 4 === 3) expect(c[i] > 0).toBe(v > 0);
        else if (frames[k].data[i - (i % 4) + 3] > 0) expect(c[i]).toBe(v);
      }),
    );
  });

  it('timestamps frames in 1/100 s without drift and validates input', () => {
    expect(gifFrameDelays(24, 24).reduce((a, b) => a + b, 0)).toBe(100);
    expect(gifFrameDelays(30, 30).reduce((a, b) => a + b, 0)).toBe(100);
    expect(gifFrameDelays(3, 100)).toEqual([2, 2, 2]);
    expect(gifFrameDelays(1, 0.001)).toEqual([65535]);
    expect(() => encodeGIF([], 10)).toThrow(/no frames/);
    expect(() => encodeGIF([solidFrame(2, 2, BG), solidFrame(3, 2, BG)], 10)).toThrow(
      /every frame must be 2×2/,
    );
    expect(() => encodeGIF([solidFrame(2, 2, BG)], Number.NaN)).toThrow(/fps/);
  });

  it('encodes larger noisy animations quickly and losslessly in palette space', () => {
    const frames = Array.from({ length: 12 }, (_, k) => ({
      width: 96,
      height: 64,
      data: noiseBytes(96 * 64 * 4, k + 3).map((v, i) => (i % 4 === 3 ? 255 : v)),
    }));
    // CPU time: about 0.2 s, 0.5 s under coverage on a busy machine
    const t0 = cpuMs();
    const gif = decodeGIF(encodeGIF(frames, 12));
    expect(cpuMs() - t0).toBeLessThan(5000);
    expect(gif.frames).toHaveLength(12);
    expect(gif.palette.length).toBe(256 * 3);
    expect(gif.frames.every((f) => f.indices.every((v) => v < 256))).toBe(true);
  });
});
