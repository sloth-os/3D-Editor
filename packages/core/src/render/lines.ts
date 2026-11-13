import type { Vec3 } from '../math/types';
import { linearToSrgb, srgbToLinear } from './color';

/*
 * Screen-space lines over rendered images (`SoftwareRenderOptions.lines`, `drawLines`): world-space
 * segments (kite strings, tethers, skeleton bones of pose passes) projected with the render's view
 * and drawn as round-capped strokes of a fixed width in pixels, anti-aliased by coverage and hidden
 * where a depth buffer has something nearer.
 */

/** A world-space segment drawn as a screen-space line (`SoftwareRenderOptions.lines`). */
export interface ScreenLine {
  a: Vec3;
  b: Vec3;
  /** Width in output pixels (drawn at least 1 px wide). */
  width_px: number;
  /** Display (sRGB) colour, 0..1 per channel; single-channel images take the first. */
  color: [number, number, number];
}

/** The projection `drawLines` needs (a `RenderView` has it). */
export interface LineView {
  /** World → clip transform (column-major). */
  viewProj: ArrayLike<number>;
  /** World → view transform (column-major): orthographic views take depths from it. */
  view: ArrayLike<number>;
  ortho: boolean;
}

export interface DrawLinesOptions {
  /** Interleaved channels per pixel of `image`: 4 (RGBA, default), 3 (RGB) or 1. */
  channels?: 1 | 3 | 4;
  /**
   * Distance of the nearest surface from the camera plane per pixel (as `RenderAovs.depth`;
   * Infinity: nothing): line pixels behind it are not drawn.
   */
  depth?: Float32Array;
  /** Blend edge pixels by coverage (default true); false sets pixels at least half covered. */
  antialias?: boolean;
}

/** A tolerance for lines lying on the surfaces they are tested against (relative, absolute in m). */
const DEPTH_TOLERANCE = 2e-3;
const DEPTH_TOLERANCE_ABS = 2e-3;

/**
 * Draws `lines` into `image` (`width` × `height` pixels, top row first) as seen by `view`; returns
 * the number of pixels touched. Colours blend in linear light for 3- and 4-channel images (RGBA:
 * composited over the pixel by its alpha, unpremultiplied), by value for single-channel ones.
 */
export function drawLines(
  image: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  lines: readonly ScreenLine[],
  view: LineView,
  opts: DrawLinesOptions = {},
): number {
  const ch = opts.channels ?? 4;
  if (image.length < width * height * ch) throw new Error('drawLines: image smaller than width × height');
  const aa = opts.antialias ?? true;
  const zbuf = opts.depth ?? null;
  const M = view.viewProj;
  const V = view.view;
  let touched = 0;
  const clip = (p: Vec3) => [
    M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12],
    M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13],
    M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14],
    M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15],
  ];
  const viewDepth = (p: Vec3) => -(V[2] * p[0] + V[6] * p[1] + V[10] * p[2] + V[14]);
  for (const line of lines) {
    if (!isFiniteVec(line.a) || !isFiniteVec(line.b)) continue;
    let ca = clip(line.a);
    let cb = clip(line.b);
    let da = viewDepth(line.a);
    let db = viewDepth(line.b);
    // clip against the near plane (z ≥ −w)
    const ea = ca[2] + ca[3];
    const eb = cb[2] + cb[3];
    if (ea < 0 && eb < 0) continue;
    if (ea < 0 || eb < 0) {
      const t = ea / (ea - eb);
      const cut = ca.map((v, i) => v + (cb[i] - v) * t);
      const dcut = da + (db - da) * t;
      if (ea < 0) {
        ca = cut;
        da = dcut;
      } else {
        cb = cut;
        db = dcut;
      }
    }
    if (!(ca[3] > 0) || !(cb[3] > 0)) continue;
    const ax = (ca[0] / ca[3]) * 0.5 * width + 0.5 * width;
    const ay = (0.5 - (ca[1] / ca[3]) * 0.5) * height;
    const bx = (cb[0] / cb[3]) * 0.5 * width + 0.5 * width;
    const by = (0.5 - (cb[1] / cb[3]) * 0.5) * height;
    const half = Math.max(0.5, (Number.isFinite(line.width_px) ? line.width_px : 1) / 2);
    const reach = half + 1;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + reach));
    if (x0 > x1 || y0 > y1) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const col = line.color;
    const lin = [srgbToLinear(clamp01(col[0])), srgbToLinear(clamp01(col[1])), srgbToLinear(clamp01(col[2]))];
    const grey = Math.round(clamp01(col[0]) * 255);
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      // the columns of this row the stroke can reach (the segment's x span over the row's band)
      let rx0 = x0;
      let rx1 = x1;
      if (Math.abs(dy) > 1e-9) {
        const ta = (cy - reach - ay) / dy;
        const tb = (cy + reach - ay) / dy;
        const tmin = Math.max(0, Math.min(ta, tb));
        const tmax = Math.min(1, Math.max(ta, tb));
        if (tmin > tmax) continue;
        rx0 = Math.max(x0, Math.floor(ax + dx * tmin - reach));
        rx1 = Math.min(x1, Math.ceil(ax + dx * tmax + reach));
      }
      for (let x = rx0; x <= rx1; x++) {
        const cx = x + 0.5;
        // closest point of the segment
        let t = len2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - cx;
        const qy = ay + dy * t - cy;
        const dist = Math.sqrt(qx * qx + qy * qy);
        let cov = aa ? half + 0.5 - dist : dist <= half ? 1 : 0;
        if (!(cov > 0)) continue;
        if (cov > 1) cov = 1;
        if (!aa && cov < 1) continue;
        const p = y * width + x;
        if (zbuf) {
          // depth along the line: 1/depth is linear in screen space for perspective views
          const d = view.ortho ? da + (db - da) * t : 1 / (1 / da + (1 / db - 1 / da) * t);
          const z = zbuf[p];
          if (d > z * (1 + DEPTH_TOLERANCE) + DEPTH_TOLERANCE_ABS) continue;
        }
        touched++;
        const o = p * ch;
        if (ch === 1) {
          image[o] = Math.round(image[o] + (grey - image[o]) * cov);
          continue;
        }
        // "over" in linear light: the line covers `cov` of the pixel, what was there keeps its
        // own alpha (RGB images are opaque) under the rest; colours stay unpremultiplied, so a
        // line's soft edge over a transparent pixel keeps the line's colour (no dark fringe)
        const below = ch === 4 ? (image[o + 3] / 255) * (1 - cov) : 1 - cov;
        const alpha = cov + below;
        for (let c = 0; c < 3; c++) {
          const dst = srgbToLinear(image[o + c] / 255);
          image[o + c] = Math.round(linearToSrgb((lin[c] * cov + dst * below) / alpha) * 255);
        }
        if (ch === 4) image[o + 3] = Math.round(alpha * 255);
      }
    }
  }
  return touched;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
