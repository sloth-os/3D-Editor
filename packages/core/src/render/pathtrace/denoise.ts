import type { FilmImage } from './film';

/*
 * Edge-avoiding à-trous wavelet denoiser (Dammertz et al. 2010) with the variance-guided
 * luminance weights of SVGF (Schied et al. 2017), for a single converged-or-not frame:
 *
 * 1. the reflected light is separated from what the camera sees directly (emission, background)
 *    and demodulated by the albedo guide, so textures stay sharp;
 * 2. five passes of a 5×5 B3-spline kernel with growing step (1, 2, 4, 8, 16 pixels), each tap
 *    weighted by normal similarity, depth similarity (relative to the local depth gradient) and
 *    luminance similarity scaled by the filtered per-pixel variance estimate;
 * 3. the result is remodulated and the direct part added back. Alpha is left untouched.
 */

export interface DenoiseOptions {
  /** Number of à-trous passes (default 5). */
  iterations?: number;
  /** Normal weight exponent (default 64). */
  sigmaNormal?: number;
  /** Depth tolerance relative to the local depth gradient (default 1). */
  sigmaDepth?: number;
  /** Luminance tolerance in standard deviations (default 4). */
  sigmaLuminance?: number;
  /** Factor applied to the luminance tolerance after every pass (default 0.5: stricter at coarse scales). */
  luminanceDecay?: number;
}

const KERNEL = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];
/** 5×5 B3-spline tap weights and inverse tap distances (≥ 1). */
const TAP_WEIGHT = new Float64Array(25).map((_, t) => KERNEL[t % 5] * KERNEL[Math.floor(t / 5)]);
const TAP_INV_DIST = new Float64Array(25).map(
  (_, t) => 1 / Math.max(1, Math.hypot((t % 5) - 2, Math.floor(t / 5) - 2)),
);
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Returns the denoised premultiplied rgba (same layout as `img.color`). */
export function denoiseFilm(img: FilmImage, opts: DenoiseOptions = {}): Float32Array {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  // no more passes than the image can hold: the last kernel spans 4 · 2^(n−1) pixels
  const fit = Math.max(1, Math.floor(Math.log2(Math.max(1, Math.min(img.width, img.height) / 4))));
  const iterations = Math.max(0, Math.min(8, fit, Math.floor(opts.iterations ?? 5)));
  const decay = Math.min(1, Math.max(0.05, opts.luminanceDecay ?? 0.5));
  const sn = Math.max(1, opts.sigmaNormal ?? 64);
  const sz = Math.max(1e-3, opts.sigmaDepth ?? 1);
  const sl = Math.max(1e-3, opts.sigmaLuminance ?? 4);
  const out = new Float32Array(img.color);
  if (!n || !iterations) return out;
  const surface = new Uint8Array(n);
  // demodulated reflected light and its variance
  let cur = new Float32Array(n * 3);
  let next = new Float32Array(n * 3);
  let vcur = new Float32Array(n);
  let vnext = new Float32Array(n);
  const alb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const nx = img.normal[i * 3];
    const ny = img.normal[i * 3 + 1];
    const nz = img.normal[i * 3 + 2];
    surface[i] = nx * nx + ny * ny + nz * nz > 0.25 ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      const a = Math.max(0.02, img.albedo[i * 3 + k]);
      alb[i * 3 + k] = a;
      const refl = img.color[i * 4 + k] - img.emission[i * 3 + k];
      cur[i * 3 + k] = refl / a;
    }
    const al = Math.max(0.02, lum(alb[i * 3], alb[i * 3 + 1], alb[i * 3 + 2]));
    const v = img.variance[i];
    vcur[i] = Number.isFinite(v) ? v / (al * al) : 0;
  }
  // depth gradient magnitude per pixel (central differences over surface neighbours)
  const grad = new Float32Array(n);
  const depth = img.depth;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!surface[i]) continue;
      let gx = 0;
      let gy = 0;
      if (x > 0 && x < w - 1 && surface[i - 1] && surface[i + 1])
        gx = Math.abs(depth[i + 1] - depth[i - 1]) * 0.5;
      if (y > 0 && y < h - 1 && surface[i - w] && surface[i + w])
        gy = Math.abs(depth[i + w] - depth[i - w]) * 0.5;
      grad[i] = Math.max(gx, gy, 1e-4 * depth[i]);
    }
  const blur = new Float32Array(n);
  let sigmaL = sl;
  for (let it = 0; it < iterations; it++, sigmaL *= decay) {
    const step = 1 << it;
    // 3×3 Gaussian of the variance (more robust luminance tolerance)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let ws = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const k = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
            s += vcur[yy * w + xx] * k;
            ws += k;
          }
        }
        blur[y * w + x] = s / ws;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!surface[i]) {
          next[i * 3] = cur[i * 3];
          next[i * 3 + 1] = cur[i * 3 + 1];
          next[i * 3 + 2] = cur[i * 3 + 2];
          vnext[i] = vcur[i];
          continue;
        }
        const pr = cur[i * 3];
        const pg = cur[i * 3 + 1];
        const pb = cur[i * 3 + 2];
        const pl = lum(pr, pg, pb);
        const pnx = img.normal[i * 3];
        const pny = img.normal[i * 3 + 1];
        const pnz = img.normal[i * 3 + 2];
        const pz = depth[i];
        const lt = 1 / (sigmaL * Math.sqrt(Math.max(blur[i], 0)) + 1e-6);
        const zt = 1 / (sz * grad[i] * step + 1e-6);
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sw = 0;
        let sv = 0;
        const N = img.normal;
        for (let ky = 0; ky < 5; ky++) {
          const yy = y + (ky - 2) * step;
          if (yy < 0 || yy >= h) continue;
          for (let kx = 0; kx < 5; kx++) {
            const xx = x + (kx - 2) * step;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!surface[j]) continue;
            const tap = ky * 5 + kx;
            let wgt = TAP_WEIGHT[tap];
            if (j !== i) {
              let nd = pnx * N[j * 3] + pny * N[j * 3 + 1] + pnz * N[j * 3 + 2];
              if (nd <= 0) continue;
              // nd^64 by repeated squaring (sigmaNormal 64), else Math.pow
              if (sn === 64) {
                nd *= nd;
                nd *= nd;
                nd *= nd;
                nd *= nd;
                nd *= nd;
                nd *= nd;
              } else nd = Math.pow(nd, sn);
              const qr = cur[j * 3];
              const qg = cur[j * 3 + 1];
              const qb = cur[j * 3 + 2];
              const dl = pl - (0.2126 * qr + 0.7152 * qg + 0.0722 * qb);
              const dz = pz - depth[j];
              const e = (dz < 0 ? -dz : dz) * zt * TAP_INV_DIST[tap] + (dl < 0 ? -dl : dl) * lt;
              if (e > 30) continue;
              wgt *= nd * Math.exp(-e);
              if (!(wgt > 1e-12)) continue;
              sr += qr * wgt;
              sg += qg * wgt;
              sb += qb * wgt;
            } else {
              sr += pr * wgt;
              sg += pg * wgt;
              sb += pb * wgt;
            }
            sw += wgt;
            sv += wgt * wgt * vcur[j];
          }
        }
        const iw = 1 / sw;
        next[i * 3] = sr * iw;
        next[i * 3 + 1] = sg * iw;
        next[i * 3 + 2] = sb * iw;
        vnext[i] = sv * iw * iw;
      }
    let t = cur;
    cur = next;
    next = t;
    t = vcur;
    vcur = vnext;
    vnext = t;
  }
  for (let i = 0; i < n; i++) {
    if (!surface[i]) continue;
    for (let k = 0; k < 3; k++) {
      const v = cur[i * 3 + k] * alb[i * 3 + k] + img.emission[i * 3 + k];
      out[i * 4 + k] = Number.isFinite(v) ? Math.max(0, v) : img.color[i * 4 + k];
    }
  }
  return out;
}
