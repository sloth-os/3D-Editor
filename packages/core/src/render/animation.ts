import { zlibSync } from 'fflate';
import type { Vec3, Vec4 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { RenderEngine } from '../doc/types';
import { SceneEvaluator, type EvaluatedScene } from '../eval/evaluate';
import { renderItems } from '../eval/renderables';
import { evaluatedBounds } from '../io/common';
import { crc32, encodePNG } from './png';
import { autoFrameView } from './view';
import type { PathTraceProgress } from './pathtrace';
import { renderSceneSoftware, type SoftwareRenderOptions } from './index';

/*
 * Animated image encoders (pure TypeScript) and animation rendering:
 *
 * - APNG (PNG + acTL / fcTL / fdAT chunks): lossless RGBA, frames after the first only store the
 *   rectangle that changed (dispose NONE, blend SOURCE). Plays in every current browser and is a
 *   valid PNG (showing the first frame) for other viewers.
 * - GIF89a: one global palette for all frames (temporally stable colours) built by variance-based
 *   median cut on a 5-bit-per-channel histogram refined with k-means, optional Floyd–Steinberg or
 *   ordered (Bayer) dithering, NETSCAPE2.0 looping, LZW with code size growth and clear codes;
 *   later frames only store changed pixels (unchanged ones become transparent).
 * - renderAnimation renders a frame range with the software renderer into APNG, GIF, a PNG
 *   sequence or a labelled contact sheet; without a camera every frame uses one automatic view
 *   framing the whole animation, so motion shows.
 */

/** One RGBA8 image of an animation (row-major, top row first). */
export interface AnimationFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

// ---------------------------------------------------------------- byte output

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  byte(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
  }

  u16le(v: number): void {
    this.ensure(2);
    this.buf[this.length++] = v & 0xff;
    this.buf[this.length++] = (v >>> 8) & 0xff;
  }

  u32be(v: number): void {
    this.ensure(4);
    this.buf[this.length++] = (v >>> 24) & 0xff;
    this.buf[this.length++] = (v >>> 16) & 0xff;
    this.buf[this.length++] = (v >>> 8) & 0xff;
    this.buf[this.length++] = v & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function checkFrame(f: AnimationFrame, width: number, height: number, what: string): void {
  if (!f || f.width !== width || f.height !== height)
    throw new Error(`${what}: every frame must be ${width}×${height} (got ${f?.width}×${f?.height})`);
  if (!f.data || f.data.length < width * height * 4)
    throw new Error(`${what}: frame pixel data is too short`);
}

function checkSize(width: number, height: number, max: number, what: string): void {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1))
    throw new Error(`${what}: invalid frame size ${width}×${height}`);
  if (width > max || height > max)
    throw new Error(`${what}: frames larger than ${max}×${max} are not supported`);
}

function checkFps(fps: number, what: string): void {
  if (!(Number.isFinite(fps) && fps > 0))
    throw new Error(`${what}: fps must be a positive number (got ${fps})`);
}

/** Bounding rectangle of the pixels (RGBA, or 1-byte indices with bpp 1) that differ, or null. */
function changedRect(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  bpp: number,
): { x: number; y: number; w: number; h: number } | null {
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  const stride = width * bpp;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let first = -1;
    for (let i = 0; i < stride; i++)
      if (a[row + i] !== b[row + i]) {
        first = i;
        break;
      }
    if (first < 0) continue;
    let last = first;
    for (let i = stride - 1; i > first; i--)
      if (a[row + i] !== b[row + i]) {
        last = i;
        break;
      }
    const fx = Math.floor(first / bpp);
    const lx = Math.floor(last / bpp);
    if (fx < x0) x0 = fx;
    if (lx > x1) x1 = lx;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------- APNG

/** APNG encoding options. */
export interface APNGOptions {
  /** Number of times the animation plays: 0 = forever (default). */
  loop?: number;
  /** Store only the changed rectangle of later frames (default true). */
  optimize?: boolean;
  /** zlib compression level 0..9 (default 6). */
  level?: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type ZlibLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * PNG scanlines (filter byte + filtered RGBA row) of a rectangle of an RGBA image, choosing per row
 * the filter with the smallest sum of absolute residuals.
 */
function filterRect(
  data: ArrayLike<number>,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Uint8Array {
  const rowLen = w * 4;
  const out = new Uint8Array((rowLen + 1) * h);
  const stride = width * 4;
  const predict = (f: number, a: number, b: number, c: number) =>
    f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
  for (let y = 0; y < h; y++) {
    const row = (y0 + y) * stride + x0 * 4;
    const prev = row - stride;
    const hasPrev = y > 0;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < rowLen && score < bestScore; i++) {
        const a = i >= 4 ? data[row + i - 4] : 0;
        const b = hasPrev ? data[prev + i] : 0;
        const c = i >= 4 && hasPrev ? data[prev + i - 4] : 0;
        const v = (data[row + i] - predict(f, a, b, c)) & 0xff;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const o = y * (rowLen + 1);
    out[o] = best;
    for (let i = 0; i < rowLen; i++) {
      const a = i >= 4 ? data[row + i - 4] : 0;
      const b = hasPrev ? data[prev + i] : 0;
      const c = i >= 4 && hasPrev ? data[prev + i - 4] : 0;
      out[o + 1 + i] = (data[row + i] - predict(best, a, b, c)) & 0xff;
    }
  }
  return out;
}

/** APNG frame delay as the fraction num/den seconds (both 16-bit) closest to 1 / fps. */
export function apngFrameDelay(fps: number): [number, number] {
  if (Number.isInteger(fps) && fps >= 1 && fps <= 65535) return [1, fps];
  for (const num of [1000, 100, 10, 1]) {
    const den = Math.round(fps * num);
    if (den >= 1 && den <= 65535) return [num, den];
  }
  return fps > 1 ? [1, 65535] : [65535, 1];
}

/**
 * Incremental APNG encoder: add RGBA frames one by one (only the previous frame is kept), then
 * `finish()` returns the file. Frames are stored as 8-bit RGBA.
 */
export class APNGEncoder {
  private readonly parts: Uint8Array[] = [];
  private seq = 0;
  private count = 0;
  private prev: Uint8Array | null = null;
  private readonly delay: [number, number];
  private readonly optimize: boolean;
  private readonly level: ZlibLevel;
  private readonly loop: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly fps: number,
    opts: APNGOptions = {},
  ) {
    checkSize(width, height, 0x7fffffff, 'APNG');
    checkFps(fps, 'APNG');
    this.delay = apngFrameDelay(fps);
    this.optimize = opts.optimize ?? true;
    this.level = Math.max(0, Math.min(9, Math.round(opts.level ?? 6))) as ZlibLevel;
    this.loop = Math.max(0, Math.floor(opts.loop ?? 0));
  }

  /** Number of frames added so far. */
  get frameCount(): number {
    return this.count;
  }

  /** Adds the next frame (same size as the encoder); later frames store only what changed. */
  addFrame(frame: AnimationFrame): void {
    const { width, height } = this;
    checkFrame(frame, width, height, 'APNG');
    const data = frame.data;
    let rect = { x: 0, y: 0, w: width, h: height };
    if (this.prev && this.optimize)
      rect = changedRect(this.prev, data, width, height, 4) ?? { x: 0, y: 0, w: 1, h: 1 };
    const fctl = new Uint8Array(26);
    const dv = new DataView(fctl.buffer);
    dv.setUint32(0, this.seq++);
    dv.setUint32(4, rect.w);
    dv.setUint32(8, rect.h);
    dv.setUint32(12, rect.x);
    dv.setUint32(16, rect.y);
    dv.setUint16(20, this.delay[0]);
    dv.setUint16(22, this.delay[1]);
    fctl[24] = 0; // dispose_op NONE: the frame stays as the base of the next one
    fctl[25] = 0; // blend_op SOURCE: the rectangle replaces the pixels (alpha included)
    this.parts.push(pngChunk('fcTL', fctl));
    const z = zlibSync(filterRect(data, width, rect.x, rect.y, rect.w, rect.h), { level: this.level });
    if (this.count === 0) this.parts.push(pngChunk('IDAT', z));
    else {
      const fdat = new Uint8Array(4 + z.length);
      new DataView(fdat.buffer).setUint32(0, this.seq++);
      fdat.set(z, 4);
      this.parts.push(pngChunk('fdAT', fdat));
    }
    this.prev = Uint8Array.from(data.subarray(0, width * height * 4));
    this.count++;
  }

  /** The APNG file (at least one frame must have been added). */
  finish(): Uint8Array {
    if (!this.count) throw new Error('APNG: no frames');
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, this.width);
    hv.setUint32(4, this.height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const actl = new Uint8Array(8);
    const av = new DataView(actl.buffer);
    av.setUint32(0, this.count);
    av.setUint32(4, this.loop);
    const w = new ByteWriter();
    for (const b of PNG_SIGNATURE) w.byte(b);
    w.bytes(pngChunk('IHDR', ihdr));
    w.bytes(pngChunk('acTL', actl));
    for (const p of this.parts) w.bytes(p);
    w.bytes(pngChunk('IEND', new Uint8Array(0)));
    return w.result();
  }
}

/** Encodes RGBA frames (all the same size) as an animated PNG playing at `fps`. */
export function encodeAPNG(
  frames: readonly AnimationFrame[],
  fps: number,
  opts: APNGOptions = {},
): Uint8Array {
  if (!frames?.length) throw new Error('APNG: no frames');
  const enc = new APNGEncoder(frames[0].width, frames[0].height, fps, opts);
  for (const f of frames) enc.addFrame(f);
  return enc.finish();
}

// ---------------------------------------------------------------- GIF: palette

/** GIF dithering: error diffusion, ordered (stable between frames) or none. */
export type GIFDither = 'FLOYD_STEINBERG' | 'BAYER' | 'NONE';

/** GIF encoding options. */
export interface GIFOptions {
  /** Number of times the animation plays: 0 = forever (default), 1 = once. */
  loop?: number;
  /** Dithering (default FLOYD_STEINBERG). */
  dither?: GIFDither;
  /**
   * Number of colours 2..256 (default 256). A transparent index, when needed (pixels with alpha
   * < 128, or unchanged pixels of optimized later frames), is added on top of them — except at
   * 256, the most a GIF colour table holds, where it takes the place of one colour.
   */
  colors?: number;
  /** Store only the changed pixels of later frames (default true). */
  optimize?: boolean;
}

const HIST_BITS = 5;
const HIST_SHIFT = 8 - HIST_BITS;
const HIST_SIZE = 1 << (3 * HIST_BITS);

interface Histogram {
  n: Float64Array;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  /** Sums of squares per channel. */
  rr: Float64Array;
  gg: Float64Array;
  bb: Float64Array;
}

/** Colour histogram of the opaque pixels (alpha >= 128) of all frames, subsampled to ~`maxSamples`. */
function histogram(frames: readonly AnimationFrame[], maxSamples: number): Histogram {
  const h: Histogram = {
    n: new Float64Array(HIST_SIZE),
    r: new Float64Array(HIST_SIZE),
    g: new Float64Array(HIST_SIZE),
    b: new Float64Array(HIST_SIZE),
    rr: new Float64Array(HIST_SIZE),
    gg: new Float64Array(HIST_SIZE),
    bb: new Float64Array(HIST_SIZE),
  };
  let total = 0;
  for (const f of frames) total += f.width * f.height;
  const step = Math.max(1, Math.ceil(total / maxSamples));
  let phase = 0;
  for (const f of frames) {
    const n = f.width * f.height;
    const d = f.data;
    let p = phase;
    for (; p < n; p += step) {
      const o = p * 4;
      if (d[o + 3] < 128) continue;
      const r = d[o];
      const g = d[o + 1];
      const b = d[o + 2];
      const i = ((r >> HIST_SHIFT) << (2 * HIST_BITS)) | ((g >> HIST_SHIFT) << HIST_BITS) | (b >> HIST_SHIFT);
      h.n[i]++;
      h.r[i] += r;
      h.g[i] += g;
      h.b[i] += b;
      h.rr[i] += r * r;
      h.gg[i] += g * g;
      h.bb[i] += b * b;
    }
    phase = p - n;
  }
  return h;
}

interface Box {
  bins: Int32Array;
  n: number;
  r: number;
  g: number;
  b: number;
  /** Sum of the squared channel values of the box's pixels. */
  q: number;
  /** Sum of squared distances of the box's pixels to its mean colour. */
  sse: number;
}

function makeBox(bins: Int32Array, h: Histogram): Box {
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let q = 0;
  for (const i of bins) {
    n += h.n[i];
    r += h.r[i];
    g += h.g[i];
    b += h.b[i];
    q += h.rr[i] + h.gg[i] + h.bb[i];
  }
  return { bins, n, r, g, b, q, sse: n > 0 ? Math.max(0, q - (r * r + g * g + b * b) / n) : 0 };
}

/**
 * Splits a box along the channel with the largest variance, at the position that minimises the
 * total squared error of the two halves.
 */
function splitBox(box: Box, h: Histogram): [Box, Box] | null {
  const m = box.bins.length;
  if (m < 2) return null;
  const channels = [
    { sum: h.r, sq: h.rr, total: box.r },
    { sum: h.g, sq: h.gg, total: box.g },
    { sum: h.b, sq: h.bb, total: box.b },
  ];
  let axis = 0;
  let bestVar = -1;
  channels.forEach((c, k) => {
    let q = 0;
    for (const i of box.bins) q += c.sq[i];
    const v = q - (c.total * c.total) / box.n;
    if (v > bestVar) {
      bestVar = v;
      axis = k;
    }
  });
  const key = channels[axis].sum;
  const sorted = Int32Array.from(box.bins).sort((a, b) => key[a] / h.n[a] - key[b] / h.n[b] || a - b);
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let q = 0;
  let cut = 1;
  let bestErr = Infinity;
  for (let k = 0; k < m - 1; k++) {
    const i = sorted[k];
    n += h.n[i];
    r += h.r[i];
    g += h.g[i];
    b += h.b[i];
    q += h.rr[i] + h.gg[i] + h.bb[i];
    const n2 = box.n - n;
    if (n <= 0 || n2 <= 0) continue;
    const r2 = box.r - r;
    const g2 = box.g - g;
    const b2 = box.b - b;
    const err = q - (r * r + g * g + b * b) / n + (box.q - q) - (r2 * r2 + g2 * g2 + b2 * b2) / n2;
    if (err < bestErr) {
      bestErr = err;
      cut = k + 1;
    }
  }
  return [makeBox(sorted.subarray(0, cut), h), makeBox(sorted.subarray(cut), h)];
}

/** Nearest palette entry search (exact, squared RGB distance) with a direct-mapped result cache. */
class NearestColor {
  private readonly rs: Int32Array;
  private readonly gs: Int32Array;
  private readonly bs: Int32Array;
  private readonly order: Int32Array;
  private readonly cacheKey = new Int32Array(1 << 16).fill(-1);
  private readonly cacheVal = new Uint8Array(1 << 16);

  constructor(palette: Uint8Array) {
    const n = palette.length / 3;
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => palette[a * 3 + 1] - palette[b * 3 + 1] || a - b,
    );
    this.order = Int32Array.from(order);
    this.rs = Int32Array.from(order, (i) => palette[i * 3]);
    this.gs = Int32Array.from(order, (i) => palette[i * 3 + 1]);
    this.bs = Int32Array.from(order, (i) => palette[i * 3 + 2]);
  }

  /** Index of the palette colour closest to (r, g, b) (integers 0..255). */
  find(r: number, g: number, b: number): number {
    const rgb = (r << 16) | (g << 8) | b;
    const slot = Math.imul(rgb, 0x9e3779b1) >>> 16;
    if (this.cacheKey[slot] === rgb) return this.cacheVal[slot];
    const { rs, gs, bs } = this;
    const n = gs.length;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gs[mid] < g) lo = mid + 1;
      else hi = mid;
    }
    let best = Infinity;
    let bestK = 0;
    let up = lo;
    let down = lo - 1;
    while (up < n || down >= 0) {
      if (up < n) {
        const dg = gs[up] - g;
        if (dg * dg >= best) up = n;
        else {
          const dr = rs[up] - r;
          const db = bs[up] - b;
          const d = dr * dr + dg * dg + db * db;
          if (d < best) {
            best = d;
            bestK = up;
          }
          up++;
        }
      }
      if (down >= 0) {
        const dg = g - gs[down];
        if (dg * dg >= best) down = -1;
        else {
          const dr = rs[down] - r;
          const db = bs[down] - b;
          const d = dr * dr + dg * dg + db * db;
          if (d < best) {
            best = d;
            bestK = down;
          }
          down--;
        }
      }
    }
    const idx = this.order[bestK];
    this.cacheKey[slot] = rgb;
    this.cacheVal[slot] = idx;
    return idx;
  }
}

/**
 * Palette of at most `maxColors` RGB colours for the opaque pixels of the frames: variance-based
 * median cut on a 5-bit-per-channel histogram, refined by two k-means passes. Returns RGB triplets
 * (at least one colour). Deterministic.
 */
export function quantizePalette(frames: readonly AnimationFrame[], maxColors = 256): Uint8Array {
  const k = Math.max(1, Math.min(256, Math.floor(maxColors)));
  const h = histogram(frames, 1 << 22);
  const used: number[] = [];
  for (let i = 0; i < HIST_SIZE; i++) if (h.n[i] > 0) used.push(i);
  if (!used.length) return new Uint8Array(3);
  let boxes = [makeBox(Int32Array.from(used), h)];
  while (boxes.length < k) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++)
      if (boxes[i].bins.length > 1 && (pick < 0 || boxes[i].sse > boxes[pick].sse)) pick = i;
    if (pick < 0) break;
    const parts = splitBox(boxes[pick], h);
    if (!parts) break;
    boxes = [...boxes.slice(0, pick), ...parts, ...boxes.slice(pick + 1)];
  }
  const centres = new Float64Array(boxes.length * 3);
  boxes.forEach((bx, i) => {
    centres[i * 3] = bx.r / bx.n;
    centres[i * 3 + 1] = bx.g / bx.n;
    centres[i * 3 + 2] = bx.b / bx.n;
  });
  // k-means refinement over the histogram bins (weighted by pixel count)
  const toBytes = (c: Float64Array) => Uint8Array.from(c, (v) => Math.max(0, Math.min(255, Math.round(v))));
  for (let pass = 0; pass < 2 && boxes.length > 1; pass++) {
    const nearest = new NearestColor(toBytes(centres));
    const acc = new Float64Array(boxes.length * 4);
    for (const i of used) {
      const n = h.n[i];
      const j = nearest.find(Math.round(h.r[i] / n), Math.round(h.g[i] / n), Math.round(h.b[i] / n));
      acc[j * 4] += n;
      acc[j * 4 + 1] += h.r[i];
      acc[j * 4 + 2] += h.g[i];
      acc[j * 4 + 3] += h.b[i];
    }
    for (let j = 0; j < boxes.length; j++) {
      const n = acc[j * 4];
      if (n <= 0) continue;
      centres[j * 3] = acc[j * 4 + 1] / n;
      centres[j * 3 + 1] = acc[j * 4 + 2] / n;
      centres[j * 3 + 2] = acc[j * 4 + 3] / n;
    }
  }
  return toBytes(centres);
}

/** 8×8 Bayer threshold matrix, values (k + 0.5) / 64 - 0.5 in (-0.5, 0.5). */
const BAYER8 = (() => {
  let m = [[0]];
  while (m.length < 8) {
    const n = m.length;
    const next: number[][] = Array.from({ length: 2 * n }, () => new Array<number>(2 * n).fill(0));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = 4 * m[y][x];
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    m = next;
  }
  return Float32Array.from(m.flat(), (k) => (k + 0.5) / 64 - 0.5);
})();

/**
 * Typical per-channel step between neighbouring palette colours: the median over the palette of
 * the Chebyshev (largest channel) distance to the nearest other colour. Ordered dithering adds the
 * same offset to R, G and B, so this — not the Euclidean distance, up to √3 larger along the grey
 * diagonal — is the amplitude that spans exactly one palette step.
 */
function paletteSpacing(palette: Uint8Array): number {
  const n = palette.length / 3;
  if (n < 2) return 0;
  const d: number[] = [];
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dr = Math.abs(palette[i * 3] - palette[j * 3]);
      const dg = Math.abs(palette[i * 3 + 1] - palette[j * 3 + 1]);
      const db = Math.abs(palette[i * 3 + 2] - palette[j * 3 + 2]);
      best = Math.min(best, Math.max(dr, dg, db));
    }
    d.push(best);
  }
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

const clampByte = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/**
 * Maps an RGBA frame to palette indices (pixels with alpha < 128 get `transparent`, or the nearest
 * colour when there is no transparent index) with the given dithering.
 */
function mapFrame(
  f: AnimationFrame,
  palette: Uint8Array,
  nearest: NearestColor,
  dither: GIFDither,
  transparent: number,
  spacing: number,
): Uint8Array {
  const { width: w, height: h, data } = f;
  const out = new Uint8Array(w * h);
  const clear = (o: number) => transparent >= 0 && data[o + 3] < 128;
  if (dither === 'FLOYD_STEINBERG') {
    // serpentine error diffusion; rows padded by one pixel on both sides
    let cur = new Float32Array((w + 2) * 3);
    let next = new Float32Array((w + 2) * 3);
    for (let y = 0; y < h; y++) {
      const ltr = (y & 1) === 0;
      for (let s = 0; s < w; s++) {
        const x = ltr ? s : w - 1 - s;
        const p = y * w + x;
        const o = p * 4;
        if (clear(o)) {
          out[p] = transparent;
          continue;
        }
        const e = (x + 1) * 3;
        const r = clampByte(data[o] + cur[e]);
        const g = clampByte(data[o + 1] + cur[e + 1]);
        const b = clampByte(data[o + 2] + cur[e + 2]);
        const idx = nearest.find(r, g, b);
        out[p] = idx;
        const dir = ltr ? 3 : -3;
        for (let c = 0; c < 3; c++) {
          const err = (c === 0 ? r : c === 1 ? g : b) - palette[idx * 3 + c];
          cur[e + dir + c] += (err * 7) / 16;
          next[e - dir + c] += (err * 3) / 16;
          next[e + c] += (err * 5) / 16;
          next[e + dir + c] += err / 16;
        }
      }
      const t = cur;
      cur = next;
      next = t;
      next.fill(0);
    }
    return out;
  }
  const bayer = dither === 'BAYER' ? spacing : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const o = p * 4;
      if (clear(o)) {
        out[p] = transparent;
        continue;
      }
      if (bayer > 0) {
        const t = BAYER8[((y & 7) << 3) | (x & 7)] * bayer;
        out[p] = nearest.find(clampByte(data[o] + t), clampByte(data[o + 1] + t), clampByte(data[o + 2] + t));
      } else out[p] = nearest.find(data[o], data[o + 1], data[o + 2]);
    }
  return out;
}

// ---------------------------------------------------------------- GIF: LZW

/**
 * GIF LZW compression of palette indices (each < 2^minCodeSize): a clear code first, variable code
 * sizes growing to 12 bits, a clear code whenever the 4096-entry table is full, and an end code.
 * Returns the packed code stream (least significant bit first) without the sub-block framing.
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  if (!(Number.isInteger(minCodeSize) && minCodeSize >= 2 && minCodeSize <= 8))
    throw new Error(`LZW: minimum code size must be 2..8 (got ${minCodeSize})`);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new ByteWriter();
  let acc = 0;
  let bits = 0;
  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.byte(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  // open-addressing table (prefix code << 8 | pixel) → code, at most half full
  const HSIZE = 8192;
  const keys = new Int32Array(HSIZE);
  const codes = new Int16Array(HSIZE);
  const reset = () => {
    keys.fill(-1);
    next = endCode + 1;
    codeSize = minCodeSize + 1;
  };
  reset();
  emit(clearCode);
  const n = indices.length;
  if (n > 0) {
    let prefix = indices[0];
    if (prefix >= clearCode) throw new Error(`LZW: index ${prefix} does not fit ${minCodeSize} bits`);
    for (let i = 1; i < n; i++) {
      const k = indices[i];
      if (k >= clearCode) throw new Error(`LZW: index ${k} does not fit ${minCodeSize} bits`);
      const key = (prefix << 8) | k;
      let slot = Math.imul(key, 0x9e3779b1) >>> 19;
      while (keys[slot] !== -1 && keys[slot] !== key) slot = (slot + 1) & (HSIZE - 1);
      if (keys[slot] === key) {
        prefix = codes[slot];
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        keys[slot] = key;
        codes[slot] = next++;
        // the decoder adds its entries one code later: grow when the next code needs one more bit
        if (next > 1 << codeSize && codeSize < 12) codeSize++;
      } else {
        emit(clearCode);
        reset();
      }
      prefix = k;
    }
    emit(prefix);
    // the decoder adds a table entry for this last code too (unless it follows a clear code): grow
    // like it does, or the end code would be written one bit narrower than it is read
    if (next >= 1 << codeSize && codeSize < 12) codeSize++;
  }
  emit(endCode);
  if (bits > 0) out.byte(acc & 0xff);
  return out.result();
}

// ---------------------------------------------------------------- GIF: file

/** GIF frame delays in 1/100 s for `count` frames at `fps` (rounding errors do not accumulate). */
export function gifFrameDelays(count: number, fps: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const d = Math.round(((k + 1) * 100) / fps) - Math.round((k * 100) / fps);
    out.push(Math.max(2, Math.min(65535, d)));
  }
  return out;
}

/**
 * Encodes RGBA frames (all the same size, at most 65535×65535) as an animated GIF89a playing at
 * `fps`. GIF timing has 1/100 s steps and viewers slow down delays below 2/100 s, so rates above
 * 50 fps play at 50 fps. Pixels with alpha < 128 become transparent.
 */
export function encodeGIF(frames: readonly AnimationFrame[], fps: number, opts: GIFOptions = {}): Uint8Array {
  if (!frames?.length) throw new Error('GIF: no frames');
  const { width, height } = frames[0];
  checkSize(width, height, 65535, 'GIF');
  checkFps(fps, 'GIF');
  for (const f of frames) checkFrame(f, width, height, 'GIF');
  const optimize = opts.optimize ?? true;
  const dither = opts.dither ?? 'FLOYD_STEINBERG';
  const colors = Math.max(2, Math.min(256, Math.floor(opts.colors ?? 256)));
  const loop = Math.max(0, Math.floor(opts.loop ?? 0));
  let hasAlpha = false;
  for (const f of frames) {
    const d = f.data;
    for (let o = 3; o < width * height * 4 && !hasAlpha; o += 4) if (d[o] < 128) hasAlpha = true;
    if (hasAlpha) break;
  }
  // the transparent index comes on top of the requested colours (a table holds at most 256)
  const reserve = hasAlpha || (optimize && frames.length > 1) ? 1 : 0;
  const palette = quantizePalette(frames, Math.min(colors, 256 - reserve));
  const used = palette.length / 3;
  const transparent = reserve ? used : -1;
  let tableBits = 1;
  while (1 << tableBits < used + reserve) tableBits++;
  const minCodeSize = Math.max(2, tableBits);
  const nearest = new NearestColor(palette);
  const spacing = dither === 'BAYER' ? paletteSpacing(palette) : 0;
  const delays = gifFrameDelays(frames.length, fps);

  const w = new ByteWriter();
  w.ascii('GIF89a');
  w.u16le(width);
  w.u16le(height);
  w.byte(0x80 | (7 << 4) | (tableBits - 1)); // global colour table, 8-bit colour resolution
  w.byte(transparent >= 0 ? transparent : 0); // background colour index
  w.byte(0); // square pixels
  for (let i = 0; i < 1 << tableBits; i++) {
    w.byte(i < used ? palette[i * 3] : 0);
    w.byte(i < used ? palette[i * 3 + 1] : 0);
    w.byte(i < used ? palette[i * 3 + 2] : 0);
  }
  if (loop !== 1) {
    // NETSCAPE2.0 application extension: repeat count (0 = forever)
    w.byte(0x21);
    w.byte(0xff);
    w.byte(11);
    w.ascii('NETSCAPE2.0');
    w.byte(3);
    w.byte(1);
    w.u16le(loop === 0 ? 0 : Math.min(65535, loop - 1));
    w.byte(0);
  }
  let prev: Uint8Array | null = null;
  frames.forEach((f, k) => {
    const indices = mapFrame(f, palette, nearest, dither, transparent, spacing);
    let rect = { x: 0, y: 0, w: width, h: height };
    let pixels = indices;
    let disposal = 1; // leave in place
    let useTransparency = hasAlpha;
    if (hasAlpha)
      disposal = 2; // restore to background: transparent areas must clear the previous frame
    else if (optimize && prev) {
      rect = changedRect(prev, indices, width, height, 1) ?? { x: 0, y: 0, w: 1, h: 1 };
      pixels = new Uint8Array(rect.w * rect.h);
      for (let y = 0; y < rect.h; y++) {
        const src = (rect.y + y) * width + rect.x;
        for (let x = 0; x < rect.w; x++) {
          const v = indices[src + x];
          pixels[y * rect.w + x] = v === prev[src + x] ? transparent : v;
        }
      }
      useTransparency = true;
    }
    // graphic control extension
    w.byte(0x21);
    w.byte(0xf9);
    w.byte(4);
    w.byte((disposal << 2) | (useTransparency ? 1 : 0));
    w.u16le(delays[k]);
    w.byte(useTransparency ? transparent : 0);
    w.byte(0);
    // image descriptor (no local colour table, not interlaced)
    w.byte(0x2c);
    w.u16le(rect.x);
    w.u16le(rect.y);
    w.u16le(rect.w);
    w.u16le(rect.h);
    w.byte(0);
    w.byte(minCodeSize);
    const stream = lzwEncode(pixels, minCodeSize);
    for (let i = 0; i < stream.length; i += 255) {
      const len = Math.min(255, stream.length - i);
      w.byte(len);
      w.bytes(stream.subarray(i, i + len));
    }
    w.byte(0);
    prev = indices;
  });
  w.byte(0x3b);
  return w.result();
}

// ---------------------------------------------------------------- contact sheet

/** Contact sheet options. */
export interface ContactSheetOptions {
  /** Tiles per row (default: as many as make the sheet roughly square). */
  columns?: number;
  /** Label of each tile (e.g. its frame number: digits, '-' and '.'), drawn in its top-left corner. */
  labels?: readonly (string | number)[];
  /** Gap between and around the tiles in pixels (default 2). */
  gap?: number;
  /** RGBA 0..255 colour of the gaps and empty cells (default opaque white). */
  background?: readonly [number, number, number, number];
}

/** 3×5 pixel glyphs for tile labels: 15 bits, rows top to bottom, 3 bits per row (MSB = left). */
const LABEL_GLYPHS: Readonly<Record<string, number>> = {
  '0': 0b111_101_101_101_111,
  '1': 0b010_110_010_010_111,
  '2': 0b111_001_111_100_111,
  '3': 0b111_001_111_001_111,
  '4': 0b101_101_111_001_001,
  '5': 0b111_100_111_001_111,
  '6': 0b111_100_111_101_111,
  '7': 0b111_001_001_001_001,
  '8': 0b111_101_111_101_111,
  '9': 0b111_101_111_001_111,
  '-': 0b000_000_111_000_000,
  '.': 0b000_000_000_000_010,
};

/** Most pixels of a contact sheet image. */
const MAX_SHEET_PIXELS = 1 << 26;

/**
 * Draws a label (white glyphs on a darkened box) at the top-left corner (x0, y0) of a tile,
 * clipped to the tile. Characters without a glyph are skipped.
 */
function drawLabel(
  out: Uint8ClampedArray,
  sheetWidth: number,
  x0: number,
  y0: number,
  tileW: number,
  tileH: number,
  text: string,
  scale: number,
): void {
  const glyphs = [...text].map((c) => LABEL_GLYPHS[c]).filter((g) => g !== undefined);
  if (!glyphs.length) return;
  const boxW = Math.min(tileW, (glyphs.length * 4 + 1) * scale);
  const boxH = Math.min(tileH, 7 * scale);
  for (let y = 0; y < boxH; y++)
    for (let x = 0; x < boxW; x++) {
      const o = ((y0 + y) * sheetWidth + x0 + x) * 4;
      out[o] *= 0.3;
      out[o + 1] *= 0.3;
      out[o + 2] *= 0.3;
      out[o + 3] = 255;
    }
  glyphs.forEach((g, k) => {
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++) {
        if (!((g >> ((4 - r) * 3 + (2 - c))) & 1)) continue;
        const px = (1 + k * 4 + c) * scale;
        const py = (1 + r) * scale;
        for (let sy = 0; sy < scale && py + sy < boxH; sy++)
          for (let sx = 0; sx < scale && px + sx < boxW; sx++) {
            const o = ((y0 + py + sy) * sheetWidth + x0 + px + sx) * 4;
            out.fill(255, o, o + 4);
          }
      }
  });
}

/**
 * Grid of a contact sheet of `count` tiles of w×h: `columns` when given (clamped to 1..count),
 * otherwise as many columns as make the sheet roughly square.
 */
export function contactSheetGrid(
  count: number,
  w: number,
  h: number,
  columns?: number,
): { columns: number; rows: number } {
  const n = Math.max(1, Math.floor(count) || 1);
  const auto = Math.ceil(Math.sqrt((n * h) / w)) || 1;
  const c = Math.max(1, Math.min(n, Math.floor(columns ?? auto) || auto));
  return { columns: c, rows: Math.ceil(n / c) };
}

/** Grid, gap and image size of a contact sheet of `count` tiles of w×h (see {@link contactSheet}). */
export function contactSheetLayout(
  count: number,
  w: number,
  h: number,
  opts: Pick<ContactSheetOptions, 'columns' | 'gap'> = {},
): { columns: number; rows: number; gap: number; width: number; height: number } {
  const { columns, rows } = contactSheetGrid(count, w, h, opts.columns);
  const gap = Math.max(0, Math.min(64, Math.floor(opts.gap ?? 2) || 0));
  return {
    columns,
    rows,
    gap,
    width: columns * w + (columns + 1) * gap,
    height: rows * h + (rows + 1) * gap,
  };
}

/**
 * Tiles RGBA frames (all the same size) into one image, left to right and top to bottom, with an
 * optional label per tile — a single picture showing a whole animation at a glance. Throws for
 * empty or mismatched input and sheets above 2^26 pixels.
 */
export function contactSheet(
  frames: readonly AnimationFrame[],
  opts: ContactSheetOptions = {},
): { width: number; height: number; data: Uint8ClampedArray } {
  if (!frames?.length) throw new Error('Contact sheet: no frames');
  const { width: w, height: h } = frames[0];
  checkSize(w, h, 65535, 'Contact sheet');
  for (const f of frames) checkFrame(f, w, h, 'Contact sheet');
  const { columns, gap, width: W, height: H } = contactSheetLayout(frames.length, w, h, opts);
  if (W * H > MAX_SHEET_PIXELS)
    throw new Error(`Contact sheet of ${W}×${H} pixels is too large: use fewer or smaller frames`);
  const out = new Uint8ClampedArray(W * H * 4);
  const bg = opts.background ?? [255, 255, 255, 255];
  for (let i = 0; i < W * H; i++) out.set(bg, i * 4);
  const scale = Math.max(1, Math.floor(Math.min(w, h) / 60));
  frames.forEach((f, k) => {
    const x0 = gap + (k % columns) * (w + gap);
    const y0 = gap + Math.floor(k / columns) * (h + gap);
    for (let y = 0; y < h; y++) out.set(f.data.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * W + x0) * 4);
    const label = opts.labels?.[k];
    if (label !== undefined) drawLabel(out, W, x0, y0, w, h, String(label), scale);
  });
  return { width: W, height: H, data: out };
}

// ---------------------------------------------------------------- rendering

/**
 * APNG and GIF: animated images; PNG_SEQUENCE: one PNG per frame; CONTACT_SHEET: one PNG with
 * every frame in a grid, labelled with its frame number.
 */
export type AnimationFormat = 'APNG' | 'GIF' | 'PNG_SEQUENCE' | 'CONTACT_SHEET';

/** Options of {@link renderAnimation}. */
export interface AnimationRenderOptions {
  /** Output format (default APNG). */
  format?: AnimationFormat;
  /** Frame range (default: the scene range) and step between rendered frames (default 1). */
  frame_start?: number;
  frame_end?: number;
  frame_step?: number;
  /** Output size (default: render resolution × resolution_percentage). */
  width?: number;
  height?: number;
  /** Playback rate (default: scene fps / frame_step, i.e. real time). */
  fps?: number;
  /** Render engine (default: the scene's render engine). */
  engine?: RenderEngine;
  /**
   * Camera object id or name (default: the scene camera). Without any camera, every frame uses the
   * same automatic 3/4 view framing the geometry of all rendered frames (sampled), so motion shows.
   */
  camera?: string;
  shading?: 'SOLID' | 'MATERIAL';
  /**
   * Anti-aliasing supersampling (raster) or samples per pixel (path tracer, also when the engine
   * comes from the render settings; default: render settings `samples`).
   */
  samples?: number;
  /** PATHTRACER: maximum bounces (default: render settings `max_bounces`). */
  max_bounces?: number;
  /** PATHTRACER: denoise every frame (default: render settings `use_denoising`). */
  denoise?: boolean;
  /** PATHTRACER: wall-clock budget per frame in seconds (0 / unset = none). */
  time_limit?: number;
  /**
   * Wall-clock budget of the whole render in seconds (0 / unset = none). Each path traced frame
   * gets at most the remaining time as its time limit (it then stops sampling early, after at
   * least one sample), and no frame is started once the budget is used up: the frames rendered so
   * far are encoded and `cancelled` is true. At least one frame is always rendered.
   */
  total_time_limit?: number;
  /** PATHTRACER: noise pattern seed (default 0). */
  seed?: number;
  /**
   * PATHTRACER: vary the noise pattern from frame to frame (seed + frame, like Cycles' Animated
   * Seed). Default false: the same pattern every frame, which flickers less and compresses better.
   */
  animated_seed?: boolean;
  /** RGBA background 0..1 (display values); alpha < 1 gives transparent frames. */
  background?: Vec4;
  /** APNG / GIF: number of plays, 0 = forever (default). */
  loop?: number;
  /** GIF dithering (default FLOYD_STEINBERG). */
  dither?: GIFDither;
  /** GIF: number of colours 2..256 (default 256; see {@link GIFOptions.colors}). */
  colors?: number;
  /** CONTACT_SHEET: tiles per row (default: a roughly square sheet). */
  columns?: number;
  /** Called after each rendered frame; return false to stop (the frames so far are encoded). */
  onFrame?: (progress: { frame: number; index: number; total: number }) => boolean | void;
}

/** Result of {@link renderAnimation}. */
export interface AnimationRenderResult {
  format: AnimationFormat;
  /** image/apng, image/gif or image/png (PNG sequence files, contact sheet). */
  mime: string;
  /** Size of each frame. */
  width: number;
  height: number;
  fps: number;
  /** The frames that were rendered, in order. */
  frames: number[];
  /** The APNG, GIF or contact sheet PNG file. */
  data?: Uint8Array;
  /** PNG_SEQUENCE: one PNG per frame, named like Blender's output (frame_0001.png …). */
  files?: { frame: number; name: string; data: Uint8Array }[];
  /** CONTACT_SHEET: size and grid of the sheet image. */
  sheet?: { width: number; height: number; columns: number; rows: number };
  /** The fixed automatic view (fovY in radians) every frame used, when there was no camera. */
  view?: { position: Vec3; target: Vec3; fovY: number };
  /** True when onFrame or total_time_limit stopped the render before its last frame. */
  cancelled: boolean;
  /**
   * True when total_time_limit cut the render short: later frames were skipped and/or a path
   * traced frame stopped sampling early because of it.
   */
  time_limit_reached: boolean;
  /** Path traced frames that stopped sampling before the requested samples (a time limit ran out). */
  undersampled_frames: number[];
}

/** Most frames one animation render accepts. */
export const MAX_ANIMATION_FRAMES = 10000;
/** Most pixels (all frames together) of a GIF or contact sheet render, which keep every frame. */
const MAX_GIF_PIXELS = 1 << 26;

/**
 * File name of a PNG sequence frame, numbered like Blender's `####` (at least 4 digits, a sign
 * for negative frames): frame_0001.png, frame_12345.png, frame_-0001.png.
 */
export function sequenceFrameName(frame: number): string {
  const f = Math.round(frame);
  return `frame_${f < 0 ? '-' : ''}${String(Math.abs(f)).padStart(4, '0')}.png`;
}

/** Most frames evaluated to frame the automatic view of an animation without a camera. */
const AUTO_VIEW_SAMPLES = 64;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Indices of at most `max` of `count` frames: all of them when there are few enough, otherwise the
 * first, the last and one per stratum in between, at golden-ratio offsets within the strata so
 * that periodic motion is not always sampled at the same phase. Sorted and deterministic.
 */
export function sampleFrameIndices(count: number, max: number): number[] {
  const n = Math.max(0, Math.floor(count));
  const m = Math.max(2, Math.floor(max));
  if (n <= m) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>([0, n - 1]);
  const strata = m - 2;
  for (let j = 0; j < strata; j++) {
    const r = (j * 0.6180339887498949) % 1;
    out.add(Math.min(n - 1, Math.floor(((j + r) * n) / strata)));
  }
  return [...out].sort((a, b) => a - b);
}

/** True when an evaluated scene has a usable scene camera (what `renderSceneSoftware` would use). */
function hasSceneCamera(scene: EvaluatedScene): boolean {
  const cam = scene.activeCamera;
  return !!(cam && cam.type === 'CAMERA' && cam.camera);
}

/**
 * The fixed automatic view of an animation rendered without a camera: the default 3/4 view framing
 * the union of the rendered geometry of the frames (up to AUTO_VIEW_SAMPLES of them, stopping
 * early when `expired`). Framing each frame on its own would follow moving objects, so that they
 * would seem to stand still.
 */
function animationAutoView(
  evaluator: SceneEvaluator,
  frames: readonly number[],
  first: EvaluatedScene,
  aspect: number,
  expired: () => boolean,
): { position: Vec3; target: Vec3; up: Vec3; fovY: number } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const i of sampleFrameIndices(frames.length, AUTO_VIEW_SAMPLES)) {
    const scene = i === 0 ? first : evaluator.evaluate(frames[i], { forRender: true });
    const meshes = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
    const b = evaluatedBounds(meshes);
    if (b && b.min.every(Number.isFinite) && b.max.every(Number.isFinite)) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.min[k]);
        max[k] = Math.max(max[k], b.max[k]);
      }
      any = true;
    }
    if (expired()) break;
  }
  return autoFrameView(any ? { min, max } : null, aspect);
}

/**
 * Renders frames `frame_start`..`frame_end` (every `frame_step`) with the software renderer
 * (`renderSceneSoftware`, so the engine option and its settings apply) and encodes them as an
 * animated PNG, a GIF, a sequence of PNG files or a contact sheet. One scene evaluator is shared
 * by all frames, so unchanged geometry is evaluated once. Without a camera (option or scene
 * camera) all frames share one automatic view framing the whole animation. Throws for invalid
 * ranges and sizes (before rendering anything).
 */
export function renderAnimation(doc: SceneDoc, opts: AnimationRenderOptions = {}): AnimationRenderResult {
  const format = opts.format ?? 'APNG';
  if (format !== 'APNG' && format !== 'GIF' && format !== 'PNG_SEQUENCE' && format !== 'CONTACT_SHEET')
    throw new Error(
      `Unknown animation format '${String(format)}' (APNG, GIF, PNG_SEQUENCE or CONTACT_SHEET)`,
    );
  const keepFrames = format === 'GIF' || format === 'CONTACT_SHEET';
  const scene = doc.getScene();
  const settings = doc.getRender();
  const start = opts.frame_start ?? scene.frame_start;
  const end = opts.frame_end ?? scene.frame_end;
  const step = opts.frame_step ?? 1;
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new Error('frame_start and frame_end must be numbers');
  if (end < start) throw new Error(`frame_end (${end}) is before frame_start (${start})`);
  if (!(Number.isInteger(step) && step >= 1))
    throw new Error(`frame_step must be a whole number >= 1 (got ${step})`);
  const total = Math.floor((end - start) / step) + 1;
  if (total > MAX_ANIMATION_FRAMES)
    throw new Error(
      `Too many frames (${total}, at most ${MAX_ANIMATION_FRAMES}): shorten the range or raise frame_step`,
    );
  const pct = (settings.resolution_percentage ?? 100) / 100;
  const width = Math.round(opts.width ?? settings.resolution_x * pct);
  const height = Math.round(opts.height ?? settings.resolution_y * pct);
  if (!(width >= 1 && height >= 1)) throw new Error(`Invalid animation size ${width}×${height}`);
  if (format === 'GIF' && (width > 65535 || height > 65535))
    throw new Error('GIF frames are limited to 65535×65535');
  if (keepFrames && width * height * total > MAX_GIF_PIXELS)
    throw new Error(
      `A ${format === 'GIF' ? 'GIF' : 'contact sheet'} of ${total} frames at ${width}×${height} is too large ` +
        `(at most ${MAX_GIF_PIXELS} pixels in all): reduce the size or the number of frames`,
    );
  if (format === 'CONTACT_SHEET') {
    // the grid with its gaps is known now: fail before rendering, not after (a stopped render
    // only ever gives a smaller sheet)
    const sheet = contactSheetLayout(total, width, height, { columns: opts.columns });
    if (sheet.width * sheet.height > MAX_SHEET_PIXELS)
      throw new Error(
        `A contact sheet of ${total} frames at ${width}×${height} would be ${sheet.width}×${sheet.height} ` +
          `pixels, too large (at most ${MAX_SHEET_PIXELS}): reduce the size or the number of frames`,
      );
  }
  const fps = opts.fps ?? (scene.fps || 24) / step;
  checkFps(fps, 'Animation');
  const budget = typeof opts.total_time_limit === 'number' && opts.total_time_limit > 0 ? opts.total_time_limit : 0;
  const t0 = now();
  const left = () => budget - (now() - t0) / 1000;
  const expired = () => budget > 0 && left() <= 0;
  const evaluator = new SceneEvaluator(doc);
  const frameList = Array.from({ length: total }, (_, i) => start + i * step);
  // without a camera, one automatic view for every frame (framing each frame alone would follow
  // the moving objects and hide their motion)
  let view: ReturnType<typeof animationAutoView> | undefined;
  if (!opts.camera) {
    const first = evaluator.evaluate(frameList[0], { forRender: true });
    if (!hasSceneCamera(first)) view = animationAutoView(evaluator, frameList, first, width / height, expired);
  }
  const base: SoftwareRenderOptions = {
    width,
    height,
    cameraId: opts.camera,
    view,
    shading: opts.shading,
    samples: opts.samples,
    background: opts.background,
    // explicit, so that `samples` means samples per pixel when the scene's engine path traces
    engine: opts.engine ?? settings.engine,
    max_bounces: opts.max_bounces,
    denoise: opts.denoise,
    time_limit: opts.time_limit,
    evaluator,
  };
  const seed = opts.seed ?? 0;
  const apng = format === 'APNG' ? new APNGEncoder(width, height, fps, { loop: opts.loop }) : null;
  const kept: AnimationFrame[] = [];
  const files: { frame: number; name: string; data: Uint8Array }[] = [];
  const frames: number[] = [];
  const undersampled: number[] = [];
  let cancelled = false;
  let budgetHit = false;
  for (let i = 0; i < total; i++) {
    const frame = frameList[i];
    let timeLimit = opts.time_limit;
    let budgetBound = false;
    if (budget > 0) {
      // a path traced frame may use the rest of the budget (at least one sample is rendered)
      const rest = Math.max(1e-3, left());
      if (!(typeof timeLimit === 'number' && timeLimit > 0 && timeLimit <= rest)) {
        timeLimit = rest;
        budgetBound = true;
      }
    }
    const progress: { last?: PathTraceProgress } = {};
    const img = renderSceneSoftware(doc, {
      ...base,
      frame,
      time_limit: timeLimit,
      seed: opts.animated_seed ? seed + Math.round(frame) : seed,
      onProgress: (p) => {
        progress.last = p;
      },
    });
    frames.push(frame);
    if (progress.last && progress.last.samples < progress.last.total) {
      undersampled.push(frame);
      if (budgetBound) budgetHit = true;
    }
    if (apng) apng.addFrame(img);
    else if (keepFrames) kept.push(img);
    else files.push({ frame, name: sequenceFrameName(frame), data: encodePNG(img) });
    const stopped = opts.onFrame?.({ frame, index: i, total }) === false;
    const outOfTime = expired();
    if ((stopped || outOfTime) && i < total - 1) {
      cancelled = true;
      if (outOfTime) budgetHit = true;
      break;
    }
  }
  const result: AnimationRenderResult = {
    format,
    mime: format === 'APNG' ? 'image/apng' : format === 'GIF' ? 'image/gif' : 'image/png',
    width,
    height,
    fps,
    frames,
    cancelled,
    time_limit_reached: budgetHit,
    undersampled_frames: undersampled,
  };
  if (view) result.view = { position: view.position, target: view.target, fovY: view.fovY };
  if (apng) result.data = apng.finish();
  else if (format === 'GIF')
    result.data = encodeGIF(kept, fps, { loop: opts.loop, dither: opts.dither, colors: opts.colors });
  else if (format === 'CONTACT_SHEET') {
    const labels = frames.map((f) => String(Math.round(f * 100) / 100));
    const sheet = contactSheet(kept, { columns: opts.columns, labels });
    result.sheet = {
      width: sheet.width,
      height: sheet.height,
      ...contactSheetGrid(kept.length, width, height, opts.columns),
    };
    result.data = encodePNG(sheet);
  } else result.files = files;
  return result;
}
