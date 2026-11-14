import type { ViewTransform } from '../../doc/types';
import { ditherThreshold, linearToSrgb, linearToSrgb255, linearToSrgbByte, srgbToLinear } from '../color';

/*
 * Display transforms (Blender's colour-management "view transforms") for the path tracer's output:
 * scene-linear Rec.709 radiance (exposure already applied) → display-encoded sRGB in [0, 1].
 *
 * STANDARD  the plain sRGB transfer function, everything above 1 clips (the rasterizer's output).
 * AGX       AgX-style (Blender 4 default): the channels are first pulled towards their luminance
 *           ("inset"), then each is encoded logarithmically from 10 stops below to 6.5 stops above
 *           middle grey and shaped by a smooth sigmoid; the result is linearized and partly
 *           re-saturated ("outset"). Bright saturated colours travel smoothly to white without the
 *           hue skews of per-channel curves.
 * FILMIC    Filmic-style (Blender 2.8–3.x default): the same log range and a slightly flatter
 *           sigmoid per channel with a mild inset, no outset (more desaturated highlights).
 * ACES      ACES-filmic-style: a steeper per-channel sigmoid (more contrast and saturation).
 * NEUTRAL   Khronos PBR Neutral: identity (up to a tiny black offset) below ≈ 0.76, then a
 *           hue-preserving compression of the peak channel with a little desaturation; then sRGB.
 *
 * All sigmoids keep middle grey (0.18) at the sRGB-encoded value Standard gives it, so the
 * exposure of mid-tones matches between the transforms. These are original approximations of the
 * respective looks (not bit-exact reproductions of Blender's OCIO configuration).
 */

const MIDDLE_GREY = 0.18;
const STOPS_BELOW = 10;
const STOPS_ABOVE = 6.5;
const LOG_MIN = Math.log2(MIDDLE_GREY) - STOPS_BELOW;
const LOG_RANGE = STOPS_BELOW + STOPS_ABOVE;
/** Log-encoded position of middle grey. */
const PIVOT_X = STOPS_BELOW / LOG_RANGE;
/** sRGB encoding of middle grey (≈ 0.461). */
const PIVOT_Y = linearToSrgb(MIDDLE_GREY);

/** Soft clip u / (1 + u^p)^(1/p): slope 1 at 0, approaches 1. */
function softClip(u: number, p: number): number {
  return u / Math.pow(1 + Math.pow(u, p), 1 / p);
}

/**
 * One side of the sigmoid: f(t) = softClip(k·t) / softClip(k) on [0, 1] with f(0) = 0, f(1) = 1 and
 * slope `a` at t = 0 (k solves (1 + k^p)^(1/p) = a; a ≤ 1 gives the identity).
 */
interface Side {
  k: number;
  p: number;
  norm: number;
}

function side(a: number, p: number): Side {
  if (!(a > 1)) return { k: 0, p, norm: 1 };
  const k = Math.pow(Math.pow(a, p) - 1, 1 / p);
  return { k, p, norm: 1 / softClip(k, p) };
}

function evalSide(s: Side, t: number): number {
  return s.k > 0 ? softClip(s.k * t, s.p) * s.norm : t;
}

/** Log-sigmoid view transform parameters. */
interface LogSigmoid {
  toe: Side;
  shoulder: Side;
  /** Inset: mix of every channel towards the luminance before the curve (0 = per channel). */
  inset: number;
  /** Outset: inverse mix after the curve (re-saturation, < inset). */
  outset: number;
}

/**
 * A sigmoid through (PIVOT_X, PIVOT_Y) with slope `contrast` (display units per log-range unit;
 * ≈ 2.46 matches the mid-tone contrast of Standard) and the toe / shoulder sharpness powers.
 */
function logSigmoid(
  contrast: number,
  toeP: number,
  shoulderP: number,
  inset: number,
  outset: number,
): LogSigmoid {
  return {
    toe: side((contrast * PIVOT_X) / PIVOT_Y, toeP),
    shoulder: side((contrast * (1 - PIVOT_X)) / (1 - PIVOT_Y), shoulderP),
    inset,
    outset,
  };
}

const AGX = logSigmoid(2.4, 1.5, 1.5, 0.2, 0.15);
const FILMIC = logSigmoid(2.2, 1.5, 1.4, 0.1, 0);
const ACES = logSigmoid(2.9, 1.6, 1.8, 0, 0);

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Sigmoid over the log-encoded value x ∈ [0, 1] → display-encoded value in [0, 1]. */
function curveAt(s: LogSigmoid, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x < PIVOT_X
    ? PIVOT_Y * (1 - evalSide(s.toe, (PIVOT_X - x) / PIVOT_X))
    : PIVOT_Y + (1 - PIVOT_Y) * evalSide(s.shoulder, (x - PIVOT_X) / (1 - PIVOT_X));
}

/** Log encoding + sigmoid of one (non-negative) channel → display-encoded value in [0, 1]. */
function curve(s: LogSigmoid, c: number): number {
  return c > 0 ? curveAt(s, (Math.log2(c) - LOG_MIN) / LOG_RANGE) : 0;
}

/*
 * Lookup tables for converting whole images (`filmToRGBA8`): the curves and the sRGB encoding are
 * smooth, so linear interpolation between 4096 samples is exact to far below an 8-bit step and
 * avoids a dozen `Math.pow` calls per pixel. `applyViewTransform` keeps the exact functions.
 */
const TABLE_SAMPLES = 4096;
const TABLE_SCALE = TABLE_SAMPLES / LOG_RANGE;

/** A log-sigmoid curve sampled over x ∈ [0, 1]: display-encoded (`enc`) and linearized (`lin`). */
interface CurveTable {
  enc: Float64Array;
  lin: Float64Array;
}

const curveTables = new Map<LogSigmoid, CurveTable>();

function curveTable(s: LogSigmoid): CurveTable {
  let t = curveTables.get(s);
  if (!t) {
    t = { enc: new Float64Array(TABLE_SAMPLES + 1), lin: new Float64Array(TABLE_SAMPLES + 1) };
    for (let i = 0; i <= TABLE_SAMPLES; i++) {
      t.enc[i] = curveAt(s, i / TABLE_SAMPLES);
      t.lin[i] = srgbToLinear(t.enc[i]);
    }
    curveTables.set(s, t);
  }
  return t;
}

/** A curve table at linear channel value c (non-negative). */
function tableAt(T: Float64Array, c: number): number {
  if (!(c > 0)) return T[0];
  const x = (Math.log2(c) - LOG_MIN) * TABLE_SCALE;
  if (!(x > 0)) return T[0];
  if (x >= TABLE_SAMPLES) return T[TABLE_SAMPLES];
  const i = x | 0;
  return T[i] + (T[i + 1] - T[i]) * (x - i);
}

/** sRGB encoding sampled over [0, 1] and, 64 times finer, over [0, 1/64] (where it bends most). */
let srgbTable: Float64Array | null = null;
let srgbTableLow: Float64Array | null = null;

/** `linearToSrgb` by table (the linear toe below 0.0031308 is computed exactly). */
function srgbFast(v: number): number {
  if (!(v > 0.0031308)) return v > 0 ? v * 12.92 : 0;
  if (v >= 1) return 1;
  if (!srgbTable || !srgbTableLow) {
    srgbTable = new Float64Array(TABLE_SAMPLES + 1);
    srgbTableLow = new Float64Array(TABLE_SAMPLES + 1);
    for (let i = 0; i <= TABLE_SAMPLES; i++) {
      srgbTable[i] = linearToSrgb(i / TABLE_SAMPLES);
      srgbTableLow[i] = linearToSrgb(i / (64 * TABLE_SAMPLES));
    }
  }
  const low = v < 1 / 64;
  const T = low ? srgbTableLow : srgbTable;
  const x = v * (low ? 64 * TABLE_SAMPLES : TABLE_SAMPLES);
  const i = x | 0;
  return T[i] + (T[i + 1] - T[i]) * (x - i);
}

function applyLogSigmoid(
  s: LogSigmoid,
  r: number,
  g: number,
  b: number,
  out: Float64Array | number[],
  fast: boolean,
): void {
  r = r > 0 ? r : 0;
  g = g > 0 ? g : 0;
  b = b > 0 ? b : 0;
  if (s.inset > 0) {
    const l = lum(r, g, b) * s.inset;
    const k = 1 - s.inset;
    r = r * k + l;
    g = g * k + l;
    b = b * k + l;
  }
  if (!(s.outset > 0)) {
    const T = fast ? curveTable(s).enc : null;
    out[0] = T ? tableAt(T, r) : curve(s, r);
    out[1] = T ? tableAt(T, g) : curve(s, g);
    out[2] = T ? tableAt(T, b) : curve(s, b);
    return;
  }
  // back to linear, re-saturate (inverse mix away from the luminance), encode again
  const T = fast ? curveTable(s).lin : null;
  const lr = T ? tableAt(T, r) : srgbToLinear(curve(s, r));
  const lg = T ? tableAt(T, g) : srgbToLinear(curve(s, g));
  const lb = T ? tableAt(T, b) : srgbToLinear(curve(s, b));
  const l = lum(lr, lg, lb) * s.outset;
  const k = 1 / (1 - s.outset);
  out[0] = fast ? srgbFast((lr - l) * k) : linearToSrgb((lr - l) * k);
  out[1] = fast ? srgbFast((lg - l) * k) : linearToSrgb((lg - l) * k);
  out[2] = fast ? srgbFast((lb - l) * k) : linearToSrgb((lb - l) * k);
}

/** Khronos PBR Neutral tone mapping (linear in, linear out), then sRGB encoding. */
function applyNeutral(r: number, g: number, b: number, out: Float64Array | number[], fast: boolean): void {
  const START = 0.8 - 0.04;
  const DESATURATION = 0.15;
  r = r > 0 ? r : 0;
  g = g > 0 ? g : 0;
  b = b > 0 ? b : 0;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, g, b);
  if (peak >= START) {
    const d = 1 - START;
    const newPeak = 1 - (d * d) / (peak + d - START);
    const k = newPeak / peak;
    r *= k;
    g *= k;
    b *= k;
    const w = 1 - 1 / (DESATURATION * (peak - newPeak) + 1);
    r += (newPeak - r) * w;
    g += (newPeak - g) * w;
    b += (newPeak - b) * w;
  }
  out[0] = fast ? srgbFast(r) : linearToSrgb(r);
  out[1] = fast ? srgbFast(g) : linearToSrgb(g);
  out[2] = fast ? srgbFast(b) : linearToSrgb(b);
}

/** The view transforms understood by `applyViewTransform`. */
export const VIEW_TRANSFORMS: readonly ViewTransform[] = ['STANDARD', 'AGX', 'FILMIC', 'ACES', 'NEUTRAL'];

/** A supported view transform (unknown or missing values fall back to STANDARD). */
export function viewTransformOf(v: unknown): ViewTransform {
  return typeof v === 'string' && (VIEW_TRANSFORMS as readonly string[]).includes(v)
    ? (v as ViewTransform)
    : 'STANDARD';
}

/**
 * Converts scene-linear rgb (exposure already applied; negative and non-finite values count as 0)
 * to display-encoded sRGB in [0, 1] with a view transform, into `out[0..2]`.
 */
export function applyViewTransform(
  view: ViewTransform,
  r: number,
  g: number,
  b: number,
  out: Float64Array | number[],
): void {
  viewTransform(view, r, g, b, out, false);
}

/** `applyViewTransform`, by lookup tables when `fast` (within a small fraction of an 8-bit step). */
function viewTransform(
  view: ViewTransform,
  r: number,
  g: number,
  b: number,
  out: Float64Array | number[],
  fast: boolean,
): void {
  r = Number.isFinite(r) ? r : 0;
  g = Number.isFinite(g) ? g : 0;
  b = Number.isFinite(b) ? b : 0;
  switch (view) {
    case 'AGX':
      applyLogSigmoid(AGX, r, g, b, out, fast);
      return;
    case 'FILMIC':
      applyLogSigmoid(FILMIC, r, g, b, out, fast);
      return;
    case 'ACES':
      applyLogSigmoid(ACES, r, g, b, out, fast);
      return;
    case 'NEUTRAL':
      applyNeutral(r, g, b, out, fast);
      return;
    default:
      out[0] = fast ? srgbFast(r) : linearToSrgb(r);
      out[1] = fast ? srgbFast(g) : linearToSrgb(g);
      out[2] = fast ? srgbFast(b) : linearToSrgb(b);
  }
}

/** Display-space background composited behind partially covered pixels (sRGB-encoded rgba, 0..1). */
export type DisplayBackground = readonly [number, number, number, number];

/**
 * Converts a linear premultiplied RGBA film to RGBA8 for display: un-premultiplies covered pixels,
 * applies the exposure factor and the view transform, and composites an optional display-space
 * background behind uncovered parts (like the rasterizer's `background` option). STANDARD uses the
 * renderers' exact sRGB conversion. `dither` quantizes with an 8 × 8 ordered dither (less banding,
 * the same pattern in every frame).
 */
export function filmToRGBA8(
  linear: Float32Array,
  width: number,
  height: number,
  exposure = 1,
  view: ViewTransform = 'STANDARD',
  background: DisplayBackground | null = null,
  dither = false,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  filmRowsToRGBA8(linear, width, 0, height, out, exposure, view, background, dither);
  return out;
}

/** View-transformed colour of the pixel being converted (`filmRowsToRGBA8`). */
const DISPLAY = new Float64Array(3);

/**
 * `filmToRGBA8` of `rows` rows of the image from row `y0` on: `linear` holds those rows (from its
 * start), `out` is the whole image (`width` wide). Converts a film a band at a time, so a renderer
 * needs no film the size of the image.
 */
export function filmRowsToRGBA8(
  linear: Float32Array,
  width: number,
  y0: number,
  rows: number,
  out: Uint8ClampedArray,
  exposure = 1,
  view: ViewTransform = 'STANDARD',
  background: DisplayBackground | null = null,
  dither = false,
): void {
  const d = DISPLAY;
  const vt = viewTransformOf(view);
  const bgA = background ? Math.min(1, Math.max(0, Number.isFinite(background[3]) ? background[3] : 1)) : 0;
  const bg = [0, 0, 0];
  if (background)
    for (let k = 0; k < 3; k++)
      bg[k] = Math.min(1, Math.max(0, Number.isFinite(background[k]) ? background[k] : 0));
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const p = ((y0 + y) * width + x) * 4;
      const raw = linear[o + 3];
      const a = raw > 0 ? (raw < 1 ? raw : 1) : 0;
      const rest = (1 - a) * bgA;
      const total = a + rest;
      out[p + 3] = Math.round(total * 255);
      if (!(total > 0)) continue;
      const k = a > 0 ? exposure / a : 0;
      if (dither) {
        // (floor(v + t) as `ditherByte`; the clamped array clamps to 0..255 and maps NaN to 0)
        const t = ditherThreshold(x, y0 + y);
        if (vt === 'STANDARD' && rest === 0) {
          out[p] = Math.floor(linearToSrgb255(linear[o] * k) + t);
          out[p + 1] = Math.floor(linearToSrgb255(linear[o + 1] * k) + t);
          out[p + 2] = Math.floor(linearToSrgb255(linear[o + 2] * k) + t);
          continue;
        }
        if (a > 0) viewTransform(vt, linear[o] * k, linear[o + 1] * k, linear[o + 2] * k, d, true);
        else d.fill(0);
        const ia = 255 / total;
        out[p] = Math.floor((d[0] * a + bg[0] * rest) * ia + t);
        out[p + 1] = Math.floor((d[1] * a + bg[1] * rest) * ia + t);
        out[p + 2] = Math.floor((d[2] * a + bg[2] * rest) * ia + t);
        continue;
      }
      if (vt === 'STANDARD' && rest === 0) {
        // exactly the rasterizer's conversion
        out[p] = linearToSrgbByte(linear[o] * k);
        out[p + 1] = linearToSrgbByte(linear[o + 1] * k);
        out[p + 2] = linearToSrgbByte(linear[o + 2] * k);
        continue;
      }
      if (a > 0) viewTransform(vt, linear[o] * k, linear[o + 1] * k, linear[o + 2] * k, d, true);
      else d.fill(0);
      // over the display-space background (straight alpha out)
      const ia = 1 / total;
      out[p] = Math.round((d[0] * a + bg[0] * rest) * ia * 255);
      out[p + 1] = Math.round((d[1] * a + bg[1] * rest) * ia * 255);
      out[p + 2] = Math.round((d[2] * a + bg[2] * rest) * ia * 255);
    }
}
