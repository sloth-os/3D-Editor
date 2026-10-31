/*
 * Deterministic noise primitives for procedural textures.
 *
 * Every random value is derived from an integer hash of a lattice cell that only uses uint32
 * wrap-around arithmetic (xor, logical shifts, 32-bit multiplication and addition). JavaScript
 * evaluates it with `Math.imul` / `>>>` and GLSL ES 3.0 with `uint`, so hashed values are
 * bit-identical on the CPU and in the viewport shader; hash bits become floats through the exact
 * conversion `(h >>> 8) · 2⁻²⁴`. The remaining arithmetic is the same formula on both sides (results
 * agree to float32 precision). The viewport GLSL (apps/web `viewport/procedural-glsl.ts`) is
 * generated from the constants exported here.
 */

/** First multiplier of the 32-bit finalizer (MurmurHash3 fmix32, public domain). */
export const PFX_FMIX_M1 = 0x85ebca6b;
/** Second multiplier of the 32-bit finalizer. */
export const PFX_FMIX_M2 = 0xc2b2ae35;
/** Odd increment (2³² / golden ratio) used to derive independent hash streams from one hash. */
export const PFX_STREAM = 0x9e3779b9;
/** Salt mixed into user seeds before hashing (so seed 0 is not a degenerate stream). */
export const PFX_SEED_SALT = 0x2545f491;
/** 2⁻²⁴: converts the top 24 bits of a hash to a float in [0, 1) exactly. */
export const PFX_UNIT = 1 / 16777216;
/** Coordinates are clamped to ±PFX_COORD_LIMIT so lattice indices stay well inside int32. */
export const PFX_COORD_LIMIT = 1e7;

/** Stream ids (multiples of PFX_STREAM) used for the derived values of one hash. */
export const PFX_STREAM_JITTER_Y = 1;
export const PFX_STREAM_JITTER_Z = 2;
export const PFX_STREAM_CELL = 3;
export const PFX_STREAM_CELL_R = 4;
export const PFX_STREAM_CELL_G = 5;
export const PFX_STREAM_CELL_B = 6;
/** Seed streams of the three domain-warp noises (distortion). */
export const PFX_STREAM_WARP = 101;

/**
 * Gradient directions indexed by `hash & 15`: the 12 cube edge midpoints plus 4 repeats, so every
 * direction has (almost) the same probability and the dot product needs no normalisation.
 */
export const PFX_GRADIENTS: readonly number[] = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1,
  0, -1, -1, 1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
];

/** Fractal noise flavours (`NOISE` texture `noise_type`). */
export const NOISE_FBM = 0;
export const NOISE_RIDGED = 1;
export const NOISE_TURBULENCE = 2;

/** Voronoi distance metrics. */
export const METRIC_EUCLIDEAN = 0;
export const METRIC_MANHATTAN = 1;
export const METRIC_CHEBYSHEV = 2;

const G = Float64Array.from(PFX_GRADIENTS);

/** 32-bit avalanche finalizer: uint32 → uint32 (input is reduced modulo 2³²). */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, PFX_FMIX_M1);
  h ^= h >>> 13;
  h = Math.imul(h, PFX_FMIX_M2);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of an integer lattice cell with a (pre-hashed) seed: fmix(x + fmix(y + fmix(z + s))). */
export function hash3(x: number, y: number, z: number, s: number): number {
  return fmix32(x + fmix32(y + fmix32(z + s)));
}

/** Independent value number `k` derived from a hash: fmix(h + k·PFX_STREAM). */
export function hashStream(h: number, k: number): number {
  return fmix32(h + Math.imul(k, PFX_STREAM));
}

/** Seed of stream `k` (octaves, warps): (s + k·PFX_STREAM) mod 2³². */
export function streamSeed(s: number, k: number): number {
  return (s + Math.imul(k, PFX_STREAM)) >>> 0;
}

/** Top 24 bits of a hash as a float in [0, 1) (exact in float32 and float64). */
export function hashUnit(h: number): number {
  return (h >>> 8) * PFX_UNIT;
}

/** Hashed seed used by all noise functions for a user seed (any integer; fractions truncate). */
export function seedHash(seed: number): number {
  const s = Number.isFinite(seed) ? Math.trunc(seed) % 4294967296 : 0;
  return fmix32((s >>> 0) + PFX_SEED_SALT);
}

/** Finite coordinate clamped to ±PFX_COORD_LIMIT (NaN → 0). */
export function sanitizeCoord(v: number): number {
  return v > -PFX_COORD_LIMIT ? (v < PFX_COORD_LIMIT ? v : PFX_COORD_LIMIT) : v === v ? -PFX_COORD_LIMIT : 0;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad(h: number, x: number, y: number, z: number): number {
  const i = (h & 15) * 3;
  return G[i] * x + G[i + 1] * y + G[i + 2] * z;
}

/**
 * Signed 3D gradient (Perlin-style) noise in [-1, 1] (measured extremes ≈ ±0.99998, standard
 * deviation ≈ 0.27), zero at lattice points, C² continuous (quintic fade). `s` is a hashed seed
 * (see `seedHash`).
 */
export function gradientNoise(x: number, y: number, z: number, s: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const ix = fx | 0;
  const iy = fy | 0;
  const iz = fz | 0;
  const tx = x - fx;
  const ty = y - fy;
  const tz = z - fz;
  const u = fade(tx);
  const v = fade(ty);
  const w = fade(tz);
  // hash3(x, y, z) = fmix(x + fmix(y + fmix(z + s))), factored over the 8 corners
  const hz0 = fmix32(iz + s);
  const hz1 = fmix32(iz + 1 + s);
  const h00 = fmix32(iy + hz0);
  const h10 = fmix32(iy + 1 + hz0);
  const h01 = fmix32(iy + hz1);
  const h11 = fmix32(iy + 1 + hz1);
  const n000 = grad(fmix32(ix + h00), tx, ty, tz);
  const n100 = grad(fmix32(ix + 1 + h00), tx - 1, ty, tz);
  const n010 = grad(fmix32(ix + h10), tx, ty - 1, tz);
  const n110 = grad(fmix32(ix + 1 + h10), tx - 1, ty - 1, tz);
  const n001 = grad(fmix32(ix + h01), tx, ty, tz - 1);
  const n101 = grad(fmix32(ix + 1 + h01), tx - 1, ty, tz - 1);
  const n011 = grad(fmix32(ix + h11), tx, ty - 1, tz - 1);
  const n111 = grad(fmix32(ix + 1 + h11), tx - 1, ty - 1, tz - 1);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

function octave(x: number, y: number, z: number, s: number, mode: number): number {
  const n = gradientNoise(x, y, z, s);
  if (mode === NOISE_FBM) return n;
  const a = n < 0 ? -n : n;
  if (mode === NOISE_TURBULENCE) return a;
  const r = 1 - a;
  return r * r;
}

function normalizeOctaves(sum: number, maxAmp: number, mode: number): number {
  return mode === NOISE_FBM ? (0.5 * sum) / maxAmp + 0.5 : sum / maxAmp;
}

/**
 * Fractal (fBm) noise normalised to about [0, 1] (Blender Noise Texture semantics): octave i has
 * frequency lacunarityⁱ and amplitude roughnessⁱ; `detail` (0..15) is the number of extra octaves,
 * its fractional part blends in one more. FBM sums signed noise (centred on 0.5), TURBULENCE sums
 * |noise|, RIDGED sums (1 − |noise|)² (sharp ridges where the noise crosses zero). Every octave uses
 * its own hash stream so octaves are uncorrelated.
 */
export function fractalNoise(
  x: number,
  y: number,
  z: number,
  detail: number,
  roughness: number,
  lacunarity: number,
  s: number,
  mode: number,
): number {
  const octaves = Math.floor(detail);
  let freq = 1;
  let amp = 1;
  let sum = 0;
  let maxAmp = 0;
  for (let i = 0; i <= octaves; i++) {
    sum += amp * octave(x * freq, y * freq, z * freq, streamSeed(s, i), mode);
    maxAmp += amp;
    amp *= roughness;
    freq *= lacunarity;
  }
  let value = normalizeOctaves(sum, maxAmp, mode);
  const rest = detail - octaves;
  if (rest > 0) {
    const sum2 = sum + amp * octave(x * freq, y * freq, z * freq, streamSeed(s, octaves + 1), mode);
    value += rest * (normalizeOctaves(sum2, maxAmp + amp, mode) - value);
  }
  return value;
}

/** Output slots of `voronoi3`. */
export const VORONOI_F1 = 0;
export const VORONOI_F2 = 1;
export const VORONOI_EDGE = 2;

const vorPts = new Float64Array(27 * 3);

/**
 * 3D Voronoi (cellular) noise: one feature point per unit cell, jittered by `randomness` (0 = cell
 * corners, 1 = uniformly random). Writes the distance to the nearest (F1) and second nearest (F2)
 * feature point under `metric`, and — when `edge` is set — the Euclidean distance to the nearest
 * cell boundary, into `out`. Returns the hash of the nearest feature point's cell (cell identity
 * for per-cell random values via `hashStream`).
 */
export function voronoi3(
  x: number,
  y: number,
  z: number,
  randomness: number,
  metric: number,
  s: number,
  edge: boolean,
  out: Float64Array | number[],
): number {
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const fz0 = Math.floor(z);
  const icx = fx0 | 0;
  const icy = fy0 | 0;
  const icz = fz0 | 0;
  const fx = x - fx0;
  const fy = y - fy0;
  const fz = z - fz0;
  let d1 = Infinity;
  let d2 = Infinity;
  let h1 = 0;
  let b1 = 0;
  let n = 0;
  for (let k = -1; k <= 1; k++) {
    const hz = fmix32(icz + k + s);
    for (let j = -1; j <= 1; j++) {
      const hy = fmix32(icy + j + hz);
      for (let i = -1; i <= 1; i++, n++) {
        const h = fmix32(icx + i + hy);
        const px = i + hashUnit(h) * randomness;
        const py = j + hashUnit(hashStream(h, PFX_STREAM_JITTER_Y)) * randomness;
        const pz = k + hashUnit(hashStream(h, PFX_STREAM_JITTER_Z)) * randomness;
        vorPts[n * 3] = px;
        vorPts[n * 3 + 1] = py;
        vorPts[n * 3 + 2] = pz;
        const dx = px - fx;
        const dy = py - fy;
        const dz = pz - fz;
        let d: number;
        if (metric === METRIC_MANHATTAN) d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        else if (metric === METRIC_CHEBYSHEV) d = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
        else d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          h1 = h;
          b1 = n;
        } else if (d < d2) d2 = d;
      }
    }
  }
  out[VORONOI_F1] = d1;
  out[VORONOI_F2] = d2;
  if (edge) {
    // distance to the bisector planes between the nearest point and every other point
    const ax = vorPts[b1 * 3];
    const ay = vorPts[b1 * 3 + 1];
    const az = vorPts[b1 * 3 + 2];
    let e = Infinity;
    for (let m = 0; m < 27; m++) {
      if (m === b1) continue;
      const qx = vorPts[m * 3];
      const qy = vorPts[m * 3 + 1];
      const qz = vorPts[m * 3 + 2];
      const dx = qx - ax;
      const dy = qy - ay;
      const dz = qz - az;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-6) continue;
      const mx = 0.5 * (ax + qx) - fx;
      const my = 0.5 * (ay + qy) - fy;
      const mz = 0.5 * (az + qz) - fz;
      const d = (mx * dx + my * dy + mz * dz) / len;
      if (d < e) e = d;
    }
    out[VORONOI_EDGE] = e === Infinity ? 0 : Math.max(0, e);
  } else out[VORONOI_EDGE] = 0;
  return h1;
}
