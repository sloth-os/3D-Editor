import type { PixelBuffers } from './raster';
import type { RenderView } from './view';
import { pooledFloat32 } from './buffers';

/*
 * Screen-space ambient occlusion of the CPU rasterizer (`SoftwareRenderOptions.ao`), at output
 * resolution, from the nearest covered sample of every pixel (its depth and normal, see
 * `Rasterizer.pixels`) after the opaque surfaces are drawn.
 *
 * Each pixel looks at AO_TAPS neighbours on a spiral reaching `radius` metres around it (in screen
 * space at its depth); a neighbour occludes it by how far it rises above the pixel's tangent plane
 * (the cosine between the pixel's normal and the direction to it, less a small bias, so flat
 * surfaces stay unoccluded), fading out over `radius`. The spiral's start angle is interleaved over
 * 4 × 4 pixel blocks and a depth-aware 4 × 4 box blur (separable) merges the 16 patterns: 128
 * effective taps, deterministic, no noise. The result only darkens the ambient / environment light
 * (the caller scales each sample's ambient share), never direct light or emission.
 */

/** Neighbours looked at per pixel. */
export const AO_TAPS = 8;
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
/** The blur keeps neighbours whose depth differs from the pixel's by less than this share. */
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
 * The ambient occlusion factor of every output pixel (1 = open, 0 = fully occluded; 1 where nothing
 * is drawn) from the nearest samples in `pix`, for occluders up to `radius` metres away.
 */
export function ambientOcclusion(pix: PixelBuffers, view: RenderView, radius: number): Float32Array {
  const W = pix.width;
  const H = pix.height;
  const n = W * H;
  const out = pooledFloat32('ao:out', n);
  out.fill(1);
  if (!(radius > 0)) return out;
  const P = view.proj;
  const ortho = view.ortho;
  const near = view.near;
  const far = view.far;
  // linear depth (distance in front of the camera plane) per pixel; 0 where nothing is drawn
  const depth = pooledFloat32('ao:depth', n);
  for (let i = 0; i < n; i++) {
    const k = pix.key[i];
    depth[i] = k > 0 ? (ortho ? ((1 - k) * (far - near) + far + near) / 2 : 1 / k) : 0;
  }
  // view-space x and y of pixel centres: × depth (perspective) or as they are (orthographic)
  const colX = new Float64Array(W);
  const rowY = new Float64Array(H);
  for (let x = 0; x < W; x++) {
    const ndc = ((x + 0.5) / W) * 2 - 1;
    colX[x] = ortho ? (ndc - P[12]) / P[0] : (ndc + P[8]) / P[0];
  }
  for (let y = 0; y < H; y++) {
    const ndc = 1 - ((y + 0.5) / H) * 2;
    rowY[y] = ortho ? (ndc - P[13]) / P[5] : (ndc + P[9]) / P[5];
  }
  // pixels per metre at depth 1 (perspective) or anywhere (orthographic)
  const pxPerMetre = (P[5] * H) / 2;
  const R = view.right;
  const U = view.up;
  const F = view.forward;
  const nrm = pix.normal;
  const ir2 = 1 / (radius * radius);
  // (the loop sums 4 × the clamped terms: x + |x| is 2 max(x, 0) without a branch)
  const scale = AO_STRENGTH / (4 * AO_TAPS * (1 - AO_BIAS));
  const raw = pooledFloat32('ao:raw', n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = depth[i];
      raw[i] = 1;
      if (!(d > 0)) continue;
      const rPx = Math.min(AO_MAX_PIXELS, (radius * pxPerMetre) / (ortho ? 1 : d));
      if (!(rPx >= 1)) continue;
      // view-space position and normal of the pixel
      const px = ortho ? colX[x] : colX[x] * d;
      const py = ortho ? rowY[y] : rowY[y] * d;
      const wx = nrm[i * 3];
      const wy = nrm[i * 3 + 1];
      const wz = nrm[i * 3 + 2];
      const nx = wx * R[0] + wy * R[1] + wz * R[2];
      const ny = wx * U[0] + wy * U[1] + wz * U[2];
      const nz = -(wx * F[0] + wy * F[1] + wz * F[2]);
      const base = ((x & 3) | ((y & 3) << 2)) * AO_TAPS;
      // tap positions measured from the pixel's corner: floor of these rounds the offsets
      const cx = x + 0.5;
      const cy = y + 0.5;
      let occlusion = 0;
      for (let k = 0; k < AO_TAPS; k++) {
        const fx = cx + rPx * TAP_X[base + k];
        const fy = cy + rPx * TAP_Y[base + k];
        if (!(fx >= 0 && fy >= 0 && fx < W && fy < H)) continue;
        const sx = fx | 0;
        const sy = fy | 0;
        const dj = depth[sy * W + sx];
        if (!(dj > 0)) continue;
        // (the pixel itself gives v = 0: no occlusion; no data-dependent branches from here on,
        // their mispredictions cost more than the arithmetic)
        const vx = (ortho ? colX[sx] : colX[sx] * dj) - px;
        const vy = (ortho ? rowY[sy] : rowY[sy] * dj) - py;
        const vz = d - dj;
        const vv = vx * vx + vy * vy + vz * vz;
        const c = (vx * nx + vy * ny + vz * nz) / Math.sqrt(vv + 1e-12) - AO_BIAS;
        const f = 1 - vv * ir2;
        occlusion += (c + Math.abs(c)) * (f + Math.abs(f));
      }
      const ao = 1 - occlusion * scale;
      raw[i] = ao > 0 ? ao : 0;
    }
  }
  // depth-aware 4 × 4 box blur (the interleaving period), rows then columns: merges the 16 spirals
  const rows = pooledFloat32('ao:rows', n);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const d = depth[i];
      if (!(d > 0)) continue;
      const tol = d * AO_BLUR_DEPTH;
      let sum = 0;
      let count = 0;
      const x1 = x + 1 < W ? x + 1 : W - 1;
      for (let bx = x - 2 > 0 ? x - 2 : 0; bx <= x1; bx++) {
        const dj = depth[row + bx];
        if (dj > 0 && Math.abs(dj - d) <= tol) {
          sum += raw[row + bx];
          count++;
        }
      }
      rows[i] = sum / count;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = y - 2 > 0 ? y - 2 : 0;
    const y1 = y + 1 < H ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = depth[i];
      if (!(d > 0)) continue;
      const tol = d * AO_BLUR_DEPTH;
      let sum = 0;
      let count = 0;
      for (let by = y0, j = y0 * W + x; by <= y1; by++, j += W) {
        const dj = depth[j];
        if (dj > 0 && Math.abs(dj - d) <= tol) {
          sum += rows[j];
          count++;
        }
      }
      out[i] = sum / count;
    }
  }
  return out;
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
