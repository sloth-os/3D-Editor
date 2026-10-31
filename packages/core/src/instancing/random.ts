/*
 * Deterministic, counter-based randomness for scattering. Every random number is a pure function of
 * (seed, index, channel), so particle `i` keeps its random values when the particle count changes
 * and evaluation order never matters. Low-discrepancy sequences provide the even ("jittered")
 * distributions: their prefixes stay well spread for any length, which again keeps existing
 * particles in place when more are added.
 */

const TWO_POW_32 = 4294967296;

/** 32-bit integer avalanche mix (xor-shift-multiply finalizer). Returns an unsigned 32-bit value. */
export function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Folds any finite number (negative, fractional or beyond 32 bits) into an unsigned 32-bit seed. */
export function seed32(seed: number): number {
  if (!Number.isFinite(seed)) return 0;
  const s = Math.trunc(seed);
  const lo = s % TWO_POW_32;
  const hi = Math.floor(s / TWO_POW_32) % TWO_POW_32;
  return (lo >>> 0) ^ Math.imul(hi | 0, 0x9e3779b1);
}

/**
 * Derives an independent stream key from a seed and a salt (e.g. one stream per particle system
 * feature). Pass the result as `key` to {@link hash01}.
 */
export function streamKey(seed: number, salt: number): number {
  return mix32(seed32(seed) ^ mix32(salt + 0x632be5ab));
}

/** Uniform random number in [0, 1) for element `index` on random `channel` of stream `key`. */
export function hash01(key: number, index: number, channel: number): number {
  return mix32(mix32(key ^ Math.imul(channel + 1, 0x9e3779b1)) ^ (index >>> 0)) / TWO_POW_32;
}

/** Fractional part, always in [0, 1). */
export function fract(x: number): number {
  return x - Math.floor(x);
}

/** 1/φ: the additive recurrence `fract(i / φ)` is the most uniform 1D sequence (three-gap theorem). */
export const GOLDEN_1D = 0.6180339887498949;

/** Additive recurrence constants of the R2 sequence (inverse powers of the plastic number). */
const PLASTIC = 1.324717957244746;
export const R2_A = 1 / PLASTIC;
export const R2_B = 1 / (PLASTIC * PLASTIC);

/** Additive recurrence constants of the R3 sequence (inverse powers of the root of x⁴ = x + 1). */
const PHI3 = 1.2207440846057596;
export const R3_A = 1 / PHI3;
export const R3_B = 1 / (PHI3 * PHI3);
export const R3_C = 1 / (PHI3 * PHI3 * PHI3);

/** Greatest common divisor of two non-negative integers. */
export function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * A stride coprime with `n` close to n/φ: `(offset + i·stride) mod n` visits every element exactly
 * once per `n` steps while consecutive steps land far apart.
 */
export function goldenStride(n: number): number {
  if (n <= 2) return 1;
  let s = Math.max(1, Math.round(n * GOLDEN_1D));
  while (gcd(s, n) !== 1) s++;
  return s % n || 1;
}

/**
 * Uniformly distributed random unit quaternion [x, y, z, w] from three uniform numbers in [0, 1)
 * (Shoemake's method).
 */
export function randomQuat(u1: number, u2: number, u3: number): [number, number, number, number] {
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  const t1 = 2 * Math.PI * u2;
  const t2 = 2 * Math.PI * u3;
  return [a * Math.sin(t1), a * Math.cos(t1), b * Math.sin(t2), b * Math.cos(t2)];
}
