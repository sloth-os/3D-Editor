import type { Vec3 } from '../math/types';
import type { WorldSettings } from '../doc/types';
import type { SampledTexture } from './raster';
import { studioRadiance } from './pathtrace/environment';

/*
 * Image-based lighting of the CPU rasterizer for the STUDIO and IMAGE world environments, matching
 * what the path tracer sees (pathtrace/environment.ts): the procedural photo studio or the
 * equirectangular image, × world strength × environment_strength, rotated by environment_rotation
 * about +Z. The world colour does not light the scene (like the path tracer, it is only the
 * background when `show_environment_background` is off).
 *
 * - Diffuse: irradiance as 9 spherical-harmonic coefficients (E/π, like the sky's).
 * - Specular: equirectangular radiance maps prefiltered for roughness 0, 0.2, 0.4, 0.6 and 1 with
 *   a reflection-vector lobe (R·L)^q, q from the Blinn–Phong equivalent of the GGX roughness (the
 *   usual "n = v = r" split-sum approximation); combined with an analytic environment BRDF
 *   (Karis 2014) so dielectrics get Fresnel reflections at grazing angles and metals their colour.
 *
 * The prefiltered maps depend only on the environment content (rotation and strength are applied
 * at lookup), so the studio is built once per process and images once per content.
 */

/** One equirectangular level (rgb floats, row 0 = nadir, u = 0.5 − atan2(y, x)/2π like Cycles). */
interface EnvLevel {
  width: number;
  height: number;
  data: Float32Array;
}

/** Prefiltered environment content (independent of rotation and strength). */
interface EnvMaps {
  /** Diffuse irradiance SH (27 numbers: 9 coefficients × rgb) giving E/π for unit radiance scale. */
  sh: Float64Array;
  /** Level k is prefiltered for roughness `LEVEL_ROUGHNESS[k]` (level 0: unfiltered). */
  levels: EnvLevel[];
}

/** Environment lighting of a render: shared maps plus the world's rotation and scale. */
export interface EnvironmentLighting {
  maps: EnvMaps;
  /** World → environment-local rotation about +Z (cos, sin of environment_rotation). */
  cosR: number;
  sinR: number;
  /** Radiance multiplier: world strength × environment_strength. */
  scale: number;
  /**
   * What the camera sees of the world (`sampleEnvironmentBackground`): the equirectangular image
   * of an IMAGE world at full resolution, or the procedural studio; neither for a reflection probe.
   */
  source?: { image: SampledTexture } | { studio: true };
}

/** Roughness of each prefiltered level. */
const LEVEL_ROUGHNESS = [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1];
/** Size (width; height = width / 2) of each level of the world environment (built once). */
const LEVEL_WIDTH = [256, 128, 64, 64, 32, 32, 32];
/** Level sizes of a reflection probe (built for every render: cheaper). */
const PROBE_LEVEL_WIDTH = [128, 64, 64, 32, 32, 32, 32];

const SRGB_LUT = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

const finiteNonNeg = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : d;

/**
 * Environment lighting of a world for the rasterizer, or null when the world has none (NONE, SKY
 * — which has its own lighting —, an IMAGE that cannot be decoded, or a zero strength).
 */
export function environmentLighting(
  world: WorldSettings,
  image: SampledTexture | null,
): EnvironmentLighting | null {
  const scale = finiteNonNeg(world.strength, 1) * finiteNonNeg(world.environment_strength, 1);
  if (!(scale > 0)) return null;
  let maps: EnvMaps | null = null;
  let source: EnvironmentLighting['source'];
  if (world.environment === 'STUDIO') {
    maps = studioMaps();
    source = { studio: true };
  } else if (world.environment === 'IMAGE' && image && image.width > 0 && image.height > 0) {
    maps = imageMaps(world.environment_image ?? '', image);
    source = { image };
  }
  if (!maps) return null;
  const rot = Number.isFinite(world.environment_rotation) ? world.environment_rotation : 0;
  return { maps, cosR: Math.cos(rot), sinR: Math.sin(rot), scale, source };
}

/**
 * The world as the camera sees it in direction (x, y, z) (× scale), into out: the equirectangular
 * image of an IMAGE world at its full resolution (bilinear, like the path tracer's background) or
 * the procedural studio, rather than the 256 × 128 map the lighting is prefiltered from.
 */
export function sampleEnvironmentBackground(
  env: EnvironmentLighting,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const src = env.source;
  if (!src) {
    sampleEnvironmentLighting(env, x, y, z, 0, out);
    return;
  }
  const lx = env.cosR * x + env.sinR * y;
  const ly = -env.sinR * x + env.cosR * y;
  if ('studio' in src) {
    const L = studioRadiance(lx, ly, z) * env.scale;
    out[0] = out[1] = out[2] = L;
    return;
  }
  const img = src.image;
  const W = img.width;
  const H = img.height;
  const u = 0.5 - Math.atan2(ly, lx) / (2 * Math.PI);
  const v = 0.5 + Math.asin(z > 1 ? 1 : z < -1 ? -1 : z) / Math.PI;
  if (!(u === u && v === v)) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  // row 0 of the image is the zenith
  const fx = u * W - 0.5;
  const fy = Math.min(H - 1, Math.max(0, (1 - v) * H - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const xa = ((x0 % W) + W) % W;
  const xb = xa + 1 === W ? 0 : xa + 1;
  const yb = Math.min(H - 1, y0 + 1);
  const d = img.data;
  const i00 = (y0 * W + xa) * 4;
  const i10 = (y0 * W + xb) * 4;
  const i01 = (yb * W + xa) * 4;
  const i11 = (yb * W + xb) * 4;
  const k = env.scale;
  const w00 = (1 - ax) * (1 - ay) * k;
  const w10 = ax * (1 - ay) * k;
  const w01 = (1 - ax) * ay * k;
  const w11 = ax * ay * k;
  const L = SRGB_LUT;
  out[0] = L[d[i00]] * w00 + L[d[i10]] * w10 + L[d[i01]] * w01 + L[d[i11]] * w11;
  out[1] = L[d[i00 + 1]] * w00 + L[d[i10 + 1]] * w10 + L[d[i01 + 1]] * w01 + L[d[i11 + 1]] * w11;
  out[2] = L[d[i00 + 2]] * w00 + L[d[i10 + 2]] * w10 + L[d[i01 + 2]] * w01 + L[d[i11 + 2]] * w11;
}

let studioCache: EnvMaps | null = null;

function studioMaps(): EnvMaps {
  if (!studioCache) {
    const w = LEVEL_WIDTH[0];
    const h = w / 2;
    const data = new Float32Array(w * h * 3);
    const d = new Float64Array(3);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        // 2×2 supersampling per texel (the soft panel edges are a few texels wide)
        let s = 0;
        for (let a = 0; a < 2; a++)
          for (let b = 0; b < 2; b++) {
            equirectDir((i + 0.25 + 0.5 * a) / w, (j + 0.25 + 0.5 * b) / h, d);
            s += studioRadiance(d[0], d[1], d[2]);
          }
        const o = (j * w + i) * 3;
        data[o] = data[o + 1] = data[o + 2] = s / 4;
      }
    studioCache = prefilter({ width: w, height: h, data });
  }
  return studioCache;
}

/** Single-entry cache of the last image environment (keyed by image id and a content fingerprint). */
let imageCache: { key: string; maps: EnvMaps } | null = null;

function imageMaps(id: string, img: SampledTexture): EnvMaps {
  const d = img.data;
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(d.length / 4099));
  for (let i = 0; i < d.length; i += step) hash = Math.imul(hash ^ d[i], 16777619);
  const key = `${id}|${img.width}x${img.height}|${hash >>> 0}`;
  if (imageCache?.key === key) return imageCache.maps;
  // box-filter the image into the base level (rows from the nadir; image row 0 is the zenith)
  const w = LEVEL_WIDTH[0];
  const h = w / 2;
  const W = img.width;
  const H = img.height;
  const data = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    const y0 = Math.floor((1 - (j + 1) / h) * H);
    const y1 = Math.max(y0 + 1, Math.floor((1 - j / h) * H));
    for (let i = 0; i < w; i++) {
      const x0 = Math.floor((i / w) * W);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) / w) * W));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < H; y++)
        for (let x = x0; x < x1 && x < W; x++) {
          const o = (y * W + x) * 4;
          r += SRGB_LUT[d[o]];
          g += SRGB_LUT[d[o + 1]];
          b += SRGB_LUT[d[o + 2]];
          n++;
        }
      const o = (j * w + i) * 3;
      if (n) {
        data[o] = r / n;
        data[o + 1] = g / n;
        data[o + 2] = b / n;
      }
    }
  }
  const maps = prefilter({ width: w, height: h, data });
  imageCache = { key, maps };
  return maps;
}

/** One rendered cube face of a reflection probe: linear rgb and coverage, square, top row first. */
export interface ProbeFace {
  size: number;
  color: Float32Array;
  cov: Float32Array;
  /** The face's view axes (world, unit): image right, image up and the viewing direction. */
  right: Readonly<Vec3>;
  up: Readonly<Vec3>;
  forward: Readonly<Vec3>;
}

/**
 * Lighting from a reflection probe: six 90° cube faces rendered from one point (`faces`, any order
 * covering ±X, ±Y, ±Z) resampled to an equirectangular map and prefiltered like an environment.
 * Where a face shows no geometry, `background(x, y, z, out)` gives the radiance of that direction
 * (the world). The result has scale 1 and no rotation (the faces are in world space).
 */
export function probeLighting(
  faces: readonly ProbeFace[],
  background: (x: number, y: number, z: number, out: Float64Array) => void,
): EnvironmentLighting {
  const w = PROBE_LEVEL_WIDTH[0];
  const h = w / 2;
  const data = new Float32Array(w * h * 3);
  const d = new Float64Array(3);
  const bg = new Float64Array(3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      equirectDir((i + 0.5) / w, (j + 0.5) / h, d);
      // the face the direction points into most directly (its projection lies within the face)
      let best = faces[0];
      let bestDot = -Infinity;
      for (const f of faces) {
        const c = d[0] * f.forward[0] + d[1] * f.forward[1] + d[2] * f.forward[2];
        if (c > bestDot) {
          bestDot = c;
          best = f;
        }
      }
      const f = best;
      const N = f.size;
      const x = (d[0] * f.right[0] + d[1] * f.right[1] + d[2] * f.right[2]) / bestDot;
      const y = (d[0] * f.up[0] + d[1] * f.up[1] + d[2] * f.up[2]) / bestDot;
      // bilinear within the face (pixel centres at (k + 0.5) / N of the [-1, 1] square)
      const fx = Math.min(N - 1, Math.max(0, (x * 0.5 + 0.5) * N - 0.5));
      const fy = Math.min(N - 1, Math.max(0, (0.5 - y * 0.5) * N - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(N - 1, x0 + 1);
      const y1 = Math.min(N - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const wts = [(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay];
      const px = [y0 * N + x0, y0 * N + x1, y1 * N + x0, y1 * N + x1];
      let r = 0;
      let g = 0;
      let b = 0;
      let cv = 0;
      for (let k = 0; k < 4; k++) {
        const p = px[k];
        r += f.color[p * 3] * wts[k];
        g += f.color[p * 3 + 1] * wts[k];
        b += f.color[p * 3 + 2] * wts[k];
        cv += f.cov[p] * wts[k];
      }
      const o = (j * w + i) * 3;
      if (cv < 1) {
        background(d[0], d[1], d[2], bg);
        const rest = 1 - cv;
        r += bg[0] * rest;
        g += bg[1] * rest;
        b += bg[2] * rest;
      }
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
    }
  return { maps: prefilter({ width: w, height: h, data }, PROBE_LEVEL_WIDTH), cosR: 1, sinR: 0, scale: 1 };
}

/** Direction (unit) of an equirectangular coordinate (Cycles' convention, see environment.ts). */
function equirectDir(u: number, v: number, out: Float64Array): void {
  const phi = 2 * Math.PI * (0.5 - u);
  const el = Math.PI * (v - 0.5);
  const c = Math.cos(el);
  out[0] = c * Math.cos(phi);
  out[1] = c * Math.sin(phi);
  out[2] = Math.sin(el);
}

/** Halves a level (2×2 box filter). */
function downsample(src: EnvLevel): EnvLevel {
  const w = Math.max(2, src.width >> 1);
  const h = Math.max(1, src.height >> 1);
  const data = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let b = 0; b < 2; b++) {
          const y = Math.min(src.height - 1, j * 2 + b);
          for (let a = 0; a < 2; a++)
            s += src.data[(y * src.width + Math.min(src.width - 1, i * 2 + a)) * 3 + c];
        }
        data[(j * w + i) * 3 + c] = s / 4;
      }
  return { width: w, height: h, data };
}

/** Builds the prefiltered levels and the irradiance SH from the base (unfiltered) level. */
function prefilter(base: EnvLevel, widths: readonly number[] = LEVEL_WIDTH): EnvMaps {
  const levels: EnvLevel[] = [base];
  let src = base;
  for (let k = 1; k < LEVEL_ROUGHNESS.length; k++) {
    while (src.width > Math.min(widths[k], base.width)) src = downsample(src);
    levels.push(convolve(src, LEVEL_ROUGHNESS[k]));
  }
  // irradiance from the unfiltered (downsampled) radiance: the SH applies the cosine lobe itself
  return { sh: irradianceSH(src), levels };
}

/**
 * Convolves a level with the GGX reflection lobe of a roughness (split-sum prefiltering with
 * n = v = R): a source direction L at angle θ from the output direction R weighs D(θ/2) · cos θ
 * (GGX normal distribution, α = roughness²; at roughness 1 a cosine lobe). The long GGX tails
 * matter: at roughness 0.26 half of the reflected light comes from more than 7° off the mirror
 * direction. Source texels within the cone holding 99 % of the lobe (at most the hemisphere) are
 * averaged, weighted by the lobe and their solid angle.
 */
function convolve(src: EnvLevel, roughness: number): EnvLevel {
  const w = src.width;
  const h = src.height;
  const out = new Float32Array(w * h * 3);
  const a = roughness * roughness;
  const aa = a * a;
  // GGX: a fraction tan²θh / (α² + tan²θh) of the half vectors lies within θh
  const thetaMax = Math.min(Math.PI / 2, 2 * Math.atan(9.95 * a));
  const cosMax = Math.max(0, Math.cos(thetaMax));
  // lobe values over cos θ ∈ [cosMax, 1] (linearly interpolated: nothing costly in the loop)
  const LUT_N = 4096;
  const lut = new Float64Array(LUT_N + 2);
  for (let i = 0; i <= LUT_N + 1; i++) {
    const c = Math.min(1, cosMax + ((1 - cosMax) * i) / LUT_N);
    const den = ((1 + c) / 2) * (aa - 1) + 1;
    lut[i] = (c * aa) / (Math.PI * den * den);
  }
  const lutScale = LUT_N / Math.max(1e-12, 1 - cosMax);
  // source texel directions and solid angles
  const dirs = new Float64Array(w * h * 3);
  const omega = new Float64Array(h);
  const elev = new Float64Array(h);
  const d = new Float64Array(3);
  for (let j = 0; j < h; j++) {
    const top = Math.PI * ((j + 1) / h - 0.5);
    const bottom = Math.PI * (j / h - 0.5);
    omega[j] = ((2 * Math.PI) / w) * (Math.sin(top) - Math.sin(bottom));
    elev[j] = (top + bottom) / 2;
    for (let i = 0; i < w; i++) {
      equirectDir((i + 0.5) / w, (j + 0.5) / h, d);
      dirs[(j * w + i) * 3] = d[0];
      dirs[(j * w + i) * 3 + 1] = d[1];
      dirs[(j * w + i) * 3 + 2] = d[2];
    }
  }
  const dPhi = (2 * Math.PI) / w;
  for (let j = 0; j < h; j++) {
    const elO = elev[j];
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 3;
      const rx = dirs[o];
      const ry = dirs[o + 1];
      const rz = dirs[o + 2];
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sw = 0;
      for (let jj = 0; jj < h; jj++) {
        const elS = elev[jj];
        if (Math.abs(elS - elO) > thetaMax + Math.PI / h) continue;
        // azimuth half-width of the cone on this row (whole row near the poles)
        const cs = Math.cos(elS) * Math.cos(elO);
        let half = Math.PI;
        if (cs > 1e-9) {
          const c = (cosMax - Math.sin(elS) * Math.sin(elO)) / cs;
          if (c > 1) continue;
          if (c > -1) half = Math.acos(c) + dPhi;
        }
        const span = Math.min(w, Math.ceil(half / dPhi) * 2 + 1);
        const start = span >= w ? 0 : i - (span >> 1);
        for (let t = 0; t < span; t++) {
          const ii = (((start + t) % w) + w) % w;
          const s = (jj * w + ii) * 3;
          const c = rx * dirs[s] + ry * dirs[s + 1] + rz * dirs[s + 2];
          if (c <= cosMax) continue;
          const fl = (c - cosMax) * lutScale;
          const li = fl | 0;
          const wgt = (lut[li] + (lut[li + 1] - lut[li]) * (fl - li)) * omega[jj];
          sr += src.data[s] * wgt;
          sg += src.data[s + 1] * wgt;
          sb += src.data[s + 2] * wgt;
          sw += wgt;
        }
      }
      if (sw > 0) {
        out[o] = sr / sw;
        out[o + 1] = sg / sw;
        out[o + 2] = sb / sw;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Irradiance SH (E/π) of a level, like `skyIrradianceSH`. */
function irradianceSH(src: EnvLevel): Float64Array {
  const w = src.width;
  const h = src.height;
  const L = new Float64Array(27);
  const d = new Float64Array(3);
  for (let j = 0; j < h; j++) {
    const top = Math.PI * ((j + 1) / h - 0.5);
    const bottom = Math.PI * (j / h - 0.5);
    const omega = ((2 * Math.PI) / w) * (Math.sin(top) - Math.sin(bottom));
    for (let i = 0; i < w; i++) {
      equirectDir((i + 0.5) / w, (j + 0.5) / h, d);
      const [x, y, z] = [d[0], d[1], d[2]];
      const b = [
        0.282095,
        0.488603 * y,
        0.488603 * z,
        0.488603 * x,
        1.092548 * x * y,
        1.092548 * y * z,
        0.315392 * (3 * z * z - 1),
        1.092548 * x * z,
        0.546274 * (x * x - y * y),
      ];
      const s = (j * w + i) * 3;
      for (let k = 0; k < 9; k++) {
        const bk = b[k] * omega;
        L[k * 3] += src.data[s] * bk;
        L[k * 3 + 1] += src.data[s + 1] * bk;
        L[k * 3 + 2] += src.data[s + 2] * bk;
      }
    }
  }
  // cosine-lobe convolution (π, 2π/3, π/4 per band), then / π
  const A = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];
  for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) L[k * 3 + c] *= A[k];
  return L;
}

/** Bilinear lookup of a level at equirectangular coordinates (u, v), added × `k` into out. */
function lookup(level: EnvLevel, u: number, v: number, k: number, out: Float64Array): void {
  const w = level.width;
  const h = level.height;
  const fx = u * w - 0.5;
  let fy = v * h - 0.5;
  if (fy < 0) fy = 0;
  else if (fy > h - 1) fy = h - 1;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const xa = ((x0 % w) + w) % w;
  const xb = xa + 1 === w ? 0 : xa + 1;
  const yb = y0 + 1 < h ? y0 + 1 : y0;
  const d = level.data;
  const i00 = (y0 * w + xa) * 3;
  const i10 = (y0 * w + xb) * 3;
  const i01 = (yb * w + xa) * 3;
  const i11 = (yb * w + xb) * 3;
  const w00 = (1 - ax) * (1 - ay) * k;
  const w10 = ax * (1 - ay) * k;
  const w01 = (1 - ax) * ay * k;
  const w11 = ax * ay * k;
  out[0] += d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
  out[1] += d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
  out[2] += d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
}

/**
 * Radiance (× scale) arriving from world direction (x, y, z), prefiltered for `roughness`
 * (0 = mirror, 1 = cosine lobe), into out.
 */
export function sampleEnvironmentLighting(
  env: EnvironmentLighting,
  x: number,
  y: number,
  z: number,
  roughness: number,
  out: Float64Array,
): void {
  const lx = env.cosR * x + env.sinR * y;
  const ly = -env.sinR * x + env.cosR * y;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  const u = 0.5 - Math.atan2(ly, lx) / (2 * Math.PI);
  const v = 0.5 + Math.asin(z > 1 ? 1 : z < -1 ? -1 : z) / Math.PI;
  if (!(u === u && v === v)) return;
  const r = roughness < 0 ? 0 : roughness > 1 ? 1 : roughness;
  let k = 0;
  while (k < LEVEL_ROUGHNESS.length - 2 && r > LEVEL_ROUGHNESS[k + 1]) k++;
  const t = (r - LEVEL_ROUGHNESS[k]) / (LEVEL_ROUGHNESS[k + 1] - LEVEL_ROUGHNESS[k]);
  const levels = env.maps.levels;
  if (t < 1) lookup(levels[k], u, v, (1 - t) * env.scale, out);
  if (t > 0) lookup(levels[k + 1], u, v, t * env.scale, out);
}

/** Diffuse irradiance / π (× scale) for a world-space unit normal, into out (clamped at 0). */
export function environmentIrradiance(
  env: EnvironmentLighting,
  nx: number,
  ny: number,
  nz: number,
  out: Float64Array,
): void {
  const x = env.cosR * nx + env.sinR * ny;
  const y = -env.sinR * nx + env.cosR * ny;
  const z = nz;
  const sh = env.maps.sh;
  const b0 = 0.282095;
  const b1 = 0.488603 * y;
  const b2 = 0.488603 * z;
  const b3 = 0.488603 * x;
  const b4 = 1.092548 * x * y;
  const b5 = 1.092548 * y * z;
  const b6 = 0.315392 * (3 * z * z - 1);
  const b7 = 1.092548 * x * z;
  const b8 = 0.546274 * (x * x - y * y);
  for (let c = 0; c < 3; c++) {
    const v =
      sh[c] * b0 +
      sh[3 + c] * b1 +
      sh[6 + c] * b2 +
      sh[9 + c] * b3 +
      sh[12 + c] * b4 +
      sh[15 + c] * b5 +
      sh[18 + c] * b6 +
      sh[21 + c] * b7 +
      sh[24 + c] * b8;
    out[c] = v > 0 ? v * env.scale : 0;
  }
}

/**
 * Split-sum environment BRDF (Karis, "Physically Based Shading on Mobile", 2014): the scale A and
 * bias B with which the prefiltered radiance is weighted, specular = F0 · A + B.
 */
export function envBRDF(roughness: number, ndv: number, out: Float64Array): void {
  const r0 = -roughness + 1;
  const r1 = -0.0275 * roughness + 0.0425;
  const r2 = -0.572 * roughness + 1.04;
  const r3 = 0.022 * roughness - 0.04;
  const n = ndv > 0 ? ndv : 0;
  // exp2(−9.28 n) = exp(−6.4324 n)
  const a004 = Math.min(r0 * r0, Math.exp(-6.4324 * n)) * r0 + r1;
  out[0] = -1.04 * a004 + r2;
  out[1] = 1.04 * a004 + r3;
}
