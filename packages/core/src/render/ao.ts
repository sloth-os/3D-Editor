import type { PixelBuffers } from './raster';
import type { RenderView } from './view';
import { pooledFloat32 } from './buffers';

/*
 * Screen-space ambient occlusion of the CPU rasterizer (`SoftwareRenderOptions.ao`), from the
 * nearest covered sample of every output pixel (its depth and normal, see `Rasterizer.pixels`)
 * after the opaque surfaces are drawn.
 *
 * Each pixel looks at AO_TAPS neighbours on a spiral reaching `radius` metres around it (in screen
 * space at its depth); a neighbour occludes it by how far it rises above the pixel's tangent plane
 * (the cosine between the pixel's normal and the direction to it, less a small bias, so flat
 * surfaces stay unoccluded), fading out over `radius`. The spiral's start angle is interleaved over
 * 4 × 4 pixel blocks and a depth-aware 4 × 4 box blur (separable) merges the 16 patterns: 128
 * effective taps, deterministic, no noise. The result only darkens the ambient / environment light
 * (the caller scales each sample's ambient share), never direct light or emission.
 *
 * Large outputs (AO_HALF_RES_PIXELS and up) run the same taps and blur on every other pixel of
 * every other row (a quarter of the work: occlusion varies slowly over a few pixels at that size)
 * and give each pixel the occlusion of the grid pixels around it at its own depth.
 */

/** Neighbours looked at per pixel. */
export const AO_TAPS = 8;
/**
 * Outputs of at least this many pixels compute the occlusion at half resolution (each axis) and
 * upsample it depth-aware: at 1080p the full-resolution taps cost about 250 ms a frame, a quarter of
 * that on the half-resolution grid, for an occlusion that spans tens of pixels there anyway.
 */
export const AO_HALF_RES_PIXELS = 1600 * 900;
/** Spiral turns over the taps. */
const AO_TURNS = 2.5;
/**
 * Strength: the mean occlusion is multiplied by this (1: a pixel fully occluded by every tap is
 * black). Screen-space taps see few occluders at full strength (a floor at a wall's foot: about a
 * third of them, at partial angles), so 2 darkens creases and contacts to about 0.7.
 */
const AO_STRENGTH = 2;
/** Directions this close to the tangent plane (cosine) do not occlude (depth noise, faceting). */
const AO_BIAS = 0.12;
/** Largest screen radius in pixels (bounds the cost of objects near the camera). */
const AO_MAX_PIXELS = 160;
/**
 * The blur keeps neighbours whose depth differs from the pixel's by less than this share; the
 * upsampling likewise takes the grid pixels around a pixel within this share of its depth.
 */
const AO_BLUR_DEPTH = 0.04;

/**
 * Tap offsets of the 16 interleaved spirals, in units of the screen radius: x right, y down, tap k
 * of the spiral of pixel (x, y) at [((x & 3) | ((y & 3) << 2)) · AO_TAPS + k]. The spirals start
 * at 16 angles in a dithered order, so neighbouring pixels look in different directions.
 */
const [TAP_X, TAP_Y] = (() => {
  const order = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const tx = new Float64Array(16 * AO_TAPS);
  const ty = new Float64Array(16 * AO_TAPS);
  for (let q = 0; q < 16; q++) {
    const start = (2 * Math.PI * (order[q] + 0.5)) / 16;
    for (let k = 0; k < AO_TAPS; k++) {
      const reach = (k + 0.5) / AO_TAPS;
      const angle = start + 2 * Math.PI * AO_TURNS * reach;
      tx[q * AO_TAPS + k] = reach * Math.cos(angle);
      ty[q * AO_TAPS + k] = -reach * Math.sin(angle);
    }
  }
  return [tx, ty];
})();

/**
 * Distances from the camera plane (view depth) of depth keys (`PixelBuffers.key`: 1/w, or
 * 1 − z_ndc for orthographic views; 0 = nothing): Infinity where nothing is drawn. Into `out` when
 * given (the same length), else a new array.
 */
export function linearDepths(
  key: Float32Array,
  view: RenderView,
  out: Float32Array = new Float32Array(key.length),
): Float32Array {
  const n = view.near;
  const f = view.far;
  for (let i = 0; i < key.length; i++) {
    const k = key[i];
    out[i] = !(k > 0) ? Infinity : view.ortho ? ((1 - k) * (f - n) + f + n) / 2 : 1 / k;
  }
  return out;
}

/**
 * Bytes of the working buffers `ambientOcclusion` keeps for a W × H image when it is given the
 * pixels' depths: the result, and the unfiltered and row-blurred occlusion (plus the grid's depths
 * at half resolution) on its grid.
 */
export function aoBufferBytes(W: number, H: number): number {
  const n = W * H;
  const half = n >= AO_HALF_RES_PIXELS;
  const g = half ? Math.ceil(W / 2) * Math.ceil(H / 2) : n;
  return 4 * (n + 2 * g + (half ? g : 0));
}

/**
 * The ambient occlusion factor of every output pixel (1 = open, 0 = fully occluded; 1 where nothing
 * is drawn) from the nearest samples in `pix`, for occluders up to `radius` metres away. `depth`:
 * the pixels' `linearDepths`, when the caller has them already; `half`: whether the taps run at half
 * resolution (default: from AO_HALF_RES_PIXELS output pixels on).
 */
export function ambientOcclusion(
  pix: PixelBuffers,
  view: RenderView,
  radius: number,
  depth?: Float32Array,
  half = pix.width * pix.height >= AO_HALF_RES_PIXELS,
): Float32Array {
  const W = pix.width;
  const H = pix.height;
  const n = W * H;
  const out = pooledFloat32('ao:out', n);
  out.fill(1);
  if (!(radius > 0)) return out;
  const D = depth ?? linearDepths(pix.key, view, pooledFloat32('ao:depth', n));
  // the grid the taps and the blur run on: every pixel, or every other pixel of every other row
  const s = half ? 2 : 1;
  const gw = Math.ceil(W / s);
  const gh = Math.ceil(H / s);
  let gd = D;
  if (s > 1) {
    gd = pooledFloat32('ao:grid', gw * gh);
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0, o = gy * s * W; gx < gw; gx++) gd[gy * gw + gx] = D[o + gx * s];
  }
  const raw = pooledFloat32('ao:raw', gw * gh);
  occlusion(pix.normal, gd, W, H, s, gw, gh, view, radius, raw);
  // full resolution: blurred into the result; half: back into `raw`, then upsampled
  blur(gd, raw, pooledFloat32('ao:rows', gw * gh), gw, gh, s > 1 ? raw : out);
  if (s > 1) upsample(D, W, H, gd, raw, gw, gh, out);
  return out;
}

/**
 * Unfiltered occlusion of the grid pixels into `raw` (1 where nothing is drawn): the grid holds the
 * pixels (s·gx, s·gy) of the W × H output, `gd` their depths and `normals` (world space) every
 * output pixel's.
 */
function occlusion(
  normals: Float32Array,
  gd: Float32Array,
  W: number,
  H: number,
  s: number,
  gw: number,
  gh: number,
  view: RenderView,
  radius: number,
  raw: Float32Array,
): void {
  const P = view.proj;
  const ortho = view.ortho;
  // view-space x and y of the grid pixels' centres: × depth (perspective) or as they are (ortho)
  const colX = new Float64Array(gw);
  const rowY = new Float64Array(gh);
  for (let gx = 0; gx < gw; gx++) {
    const ndc = ((gx * s + 0.5) / W) * 2 - 1;
    colX[gx] = ortho ? (ndc - P[12]) / P[0] : (ndc + P[8]) / P[0];
  }
  for (let gy = 0; gy < gh; gy++) {
    const ndc = 1 - ((gy * s + 0.5) / H) * 2;
    rowY[gy] = ortho ? (ndc - P[13]) / P[5] : (ndc + P[9]) / P[5];
  }
  // output pixels per metre at depth 1 (perspective) or anywhere (orthographic)
  const pxPerMetre = (P[5] * H) / 2;
  const R = view.right;
  const U = view.up;
  const F = view.forward;
  const ir2 = 1 / (radius * radius);
  // (the loop sums 4 × the clamped terms: x + |x| is 2 max(x, 0) without a branch)
  const scale = AO_STRENGTH / (4 * AO_TAPS * (1 - AO_BIAS));
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      const d = gd[i];
      raw[i] = 1;
      if (!(d < Infinity)) continue;
      // the reach in grid pixels
      const r = Math.min(AO_MAX_PIXELS, (radius * pxPerMetre) / (ortho ? 1 : d)) / s;
      if (!(r >= 1)) continue;
      // view-space position and normal of the pixel
      const px = ortho ? colX[gx] : colX[gx] * d;
      const py = ortho ? rowY[gy] : rowY[gy] * d;
      const o = (gy * s * W + gx * s) * 3;
      const wx = normals[o];
      const wy = normals[o + 1];
      const wz = normals[o + 2];
      const nx = wx * R[0] + wy * R[1] + wz * R[2];
      const ny = wx * U[0] + wy * U[1] + wz * U[2];
      const nz = -(wx * F[0] + wy * F[1] + wz * F[2]);
      const base = ((gx & 3) | ((gy & 3) << 2)) * AO_TAPS;
      // tap positions measured from the pixel's corner: floor of these rounds the offsets
      const cx = gx + 0.5;
      const cy = gy + 0.5;
      let occluded = 0;
      for (let k = 0; k < AO_TAPS; k++) {
        const fx = cx + r * TAP_X[base + k];
        const fy = cy + r * TAP_Y[base + k];
        if (!(fx >= 0 && fy >= 0 && fx < gw && fy < gh)) continue;
        const sx = fx | 0;
        const sy = fy | 0;
        const dj = gd[sy * gw + sx];
        if (!(dj < Infinity)) continue;
        // (the pixel itself gives v = 0: no occlusion; no data-dependent branches from here on,
        // their mispredictions cost more than the arithmetic)
        const vx = (ortho ? colX[sx] : colX[sx] * dj) - px;
        const vy = (ortho ? rowY[sy] : rowY[sy] * dj) - py;
        const vz = d - dj;
        const vv = vx * vx + vy * vy + vz * vz;
        const c = (vx * nx + vy * ny + vz * nz) / Math.sqrt(vv + 1e-12) - AO_BIAS;
        const f = 1 - vv * ir2;
        occluded += (c + Math.abs(c)) * (f + Math.abs(f));
      }
      const ao = 1 - occluded * scale;
      raw[i] = ao > 0 ? ao : 0;
    }
  }
}

/**
 * Depth-aware 4 × 4 box blur (the interleaving period) of `raw` on the gw × gh grid, rows into
 * `rows` then columns into `dst` (which may be `raw`): merges the 16 spirals. Pixels where nothing
 * is drawn are left as they are in `dst`.
 */
function blur(
  gd: Float32Array,
  raw: Float32Array,
  rows: Float32Array,
  gw: number,
  gh: number,
  dst: Float32Array,
): void {
  // (empty neighbours are infinitely deep: never within the tolerance)
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const i = row + x;
      const d = gd[i];
      if (!(d < Infinity)) continue;
      const tol = d * AO_BLUR_DEPTH;
      let sum = 0;
      let count = 0;
      const x1 = x + 1 < gw ? x + 1 : gw - 1;
      for (let bx = x - 2 > 0 ? x - 2 : 0; bx <= x1; bx++) {
        if (Math.abs(gd[row + bx] - d) <= tol) {
          sum += raw[row + bx];
          count++;
        }
      }
      rows[i] = sum / count;
    }
  }
  for (let y = 0; y < gh; y++) {
    const y0 = y - 2 > 0 ? y - 2 : 0;
    const y1 = y + 1 < gh ? y + 1 : gh - 1;
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const d = gd[i];
      if (!(d < Infinity)) continue;
      const tol = d * AO_BLUR_DEPTH;
      let sum = 0;
      let count = 0;
      for (let by = y0, j = y0 * gw + x; by <= y1; by++, j += gw) {
        if (Math.abs(gd[j] - d) <= tol) {
          sum += rows[j];
          count++;
        }
      }
      dst[i] = sum / count;
    }
  }
}

/**
 * Half-resolution occlusion (grid pixel (gx, gy) = output pixel (2gx, 2gy)) to every output pixel
 * of `out`: the mean of the grid pixels it is (or lies halfway between) whose depth is within
 * AO_BLUR_DEPTH of its own, else the one of the four around it nearest in depth (silhouettes:
 * neither neighbour is on the pixel's surface). Pixels where nothing is drawn are left as they are.
 */
function upsample(
  D: Float32Array,
  W: number,
  H: number,
  gd: Float32Array,
  ao: Float32Array,
  gw: number,
  gh: number,
  out: Float32Array,
): void {
  for (let y = 0; y < H; y++) {
    const gy0 = y >> 1;
    const below = gy0 + 1 < gh ? gy0 + 1 : gy0;
    // rows of the grid pixels the pixel is (even rows) or lies between (odd rows)
    const r0 = gy0 * gw;
    const r1 = (y & 1 ? below : gy0) * gw;
    const rb = below * gw;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = D[i];
      if (!(d < Infinity)) continue;
      const gx0 = x >> 1;
      const right = gx0 + 1 < gw ? gx0 + 1 : gx0;
      const gx1 = x & 1 ? right : gx0;
      const tol = d * AO_BLUR_DEPTH;
      let sum = 0;
      let count = 0;
      // the (up to four distinct) grid pixels around, each once
      let c = r0 + gx0;
      if (Math.abs(gd[c] - d) <= tol) {
        sum += ao[c];
        count++;
      }
      if (gx1 !== gx0) {
        c = r0 + gx1;
        if (Math.abs(gd[c] - d) <= tol) {
          sum += ao[c];
          count++;
        }
      }
      if (r1 !== r0) {
        c = r1 + gx0;
        if (Math.abs(gd[c] - d) <= tol) {
          sum += ao[c];
          count++;
        }
        if (gx1 !== gx0) {
          c = r1 + gx1;
          if (Math.abs(gd[c] - d) <= tol) {
            sum += ao[c];
            count++;
          }
        }
      }
      if (count) {
        out[i] = sum / count;
        continue;
      }
      // nothing at this depth around: the nearest in depth of the 2 × 2 grid pixels (1 if all empty)
      let best = Infinity;
      let v = 1;
      c = r0 + gx0;
      let e = Math.abs(gd[c] - d);
      if (e < best) {
        best = e;
        v = ao[c];
      }
      c = r0 + right;
      e = Math.abs(gd[c] - d);
      if (e < best) {
        best = e;
        v = ao[c];
      }
      c = rb + gx0;
      e = Math.abs(gd[c] - d);
      if (e < best) {
        best = e;
        v = ao[c];
      }
      c = rb + right;
      e = Math.abs(gd[c] - d);
      if (e < best) v = ao[c];
      out[i] = v;
    }
  }
}

/**
 * Darkens the ambient share of every opaque sample (`share`: 3 × 10 bits per sample, see
 * `Rasterizer.ambientShare`) by its output pixel's occlusion `ao` (`block` × `block` samples per
 * pixel, sample buffers `width` wide).
 */
export function applyAmbientOcclusion(
  color: Float32Array,
  share: Uint32Array,
  ao: Float32Array,
  width: number,
  height: number,
  block: number,
): void {
  const outW = Math.floor(width / block);
  for (let y = 0; y < height; y++) {
    const pRow = ((y / block) | 0) * outW;
    const rowStart = y * width;
    for (let px = 0; px < outW; px++) {
      // (most pixels are open: their samples are skipped together)
      const f = (1 - ao[pRow + px]) / 1023;
      if (!(f > 0)) continue;
      for (let s = rowStart + px * block, end = s + block; s < end; s++) {
        const q = share[s];
        if (q === 0) continue;
        const o = s * 3;
        color[o] *= 1 - f * (q & 1023);
        color[o + 1] *= 1 - f * ((q >>> 10) & 1023);
        color[o + 2] *= 1 - f * ((q >>> 20) & 1023);
      }
    }
  }
}
