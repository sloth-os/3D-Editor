/*
 * Deterministic low-discrepancy sampling for the path tracer.
 *
 * Every random number of a path is a pure function of (pixel, sample index, dimension, seed), so
 * images do not depend on how the work is split between rows, passes or threads.
 *
 * The first dimensions (pixel filter, lens and the first two bounces) use a padded 2D Sobol
 * (0,2)-sequence with nested uniform (Owen-style) scrambling: the sample index is shuffled per
 * dimension pair and the coordinates are scrambled per pixel. Power-of-two prefixes of every pair
 * remain (0,m,2)-nets, so a pixel's first 2^m samples are perfectly stratified in each pair.
 * Deeper dimensions use a plain hash, where stratification hardly matters.
 */

/*
 * The internal bit functions return signed 32-bit values: those stay small integers in optimized
 * code, while unsigned values ≥ 2³¹ would be boxed as heap numbers whenever they cross a call.
 * Only the final conversion to [0, 1) reads them as unsigned.
 */

/** MurmurHash3 finalizer (signed 32-bit result). */
function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return x ^ (x >>> 16);
}

/** Hash of two 32-bit integers (signed 32-bit result). */
function mix2(a: number, b: number): number {
  return mix32(a ^ mix32(b + 0x6a09e667));
}

/** Bit reversal of a 32-bit integer (signed 32-bit result). */
function rev32(x: number): number {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
  x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
  return (x >>> 16) | (x << 16);
}

/** 32-bit avalanche hash (the MurmurHash3 finalizer). Returns an unsigned 32-bit integer. */
export function hash32(x: number): number {
  return mix32(x) >>> 0;
}

/** Hash of two 32-bit integers (unsigned 32-bit result). */
export function hash2(a: number, b: number): number {
  return mix2(a, b) >>> 0;
}

/** Reverses the bit order of a 32-bit integer (unsigned result). */
export function reverseBits(x: number): number {
  return rev32(x) >>> 0;
}

/**
 * Seeded bijection where every output bit is the input bit XOR a function of the less significant
 * bits only (additions carry upwards, products with even constants only involve lower bits). Applied
 * to bit-reversed values this is a nested uniform scramble.
 */
function scrambleLow(x: number, seed: number): number {
  x = (x + seed) | 0;
  x ^= Math.imul(x, 0xb7da4e58);
  x = Math.imul(x, 0x82651bfb);
  x ^= Math.imul(x, 0x4dd01ab4);
  x = (x + (seed >>> 7) * 0x2f) | 0;
  x ^= Math.imul(x, 0xe753343a);
  x = Math.imul(x, 0xb584702d);
  x ^= Math.imul(x, 0x5e62c5e8);
  return x;
}

/** Owen-style scramble of a 32-bit binary fraction (most significant bit first; unsigned result). */
export function owenScramble(x: number, seed: number): number {
  return rev32(scrambleLow(rev32(x), seed)) >>> 0;
}

/**
 * Second Sobol dimension, bit-reversed, as XOR tables over the 4 bytes of the index: the
 * generator matrix is Pascal's triangle mod 2 (direction numbers v_k = v_{k-1} ^ (v_{k-1} >> 1)).
 */
const SOBOL1_REV: Int32Array = (() => {
  const dir = new Int32Array(32);
  let v = 0x80000000;
  for (let k = 0; k < 32; k++) {
    dir[k] = rev32(v);
    v = (v ^ (v >>> 1)) >>> 0;
  }
  const t = new Int32Array(4 * 256);
  for (let b = 0; b < 4; b++)
    for (let i = 0; i < 256; i++) {
      let x = 0;
      for (let k = 0; k < 8; k++) if (i & (1 << k)) x ^= dir[b * 8 + k];
      t[b * 256 + i] = x;
    }
  return t;
})();

/** Second Sobol dimension of index i, bit-reversed (signed 32-bit result). */
function sobol1Reversed(i: number): number {
  const T = SOBOL1_REV;
  return T[i & 255] ^ T[256 + ((i >>> 8) & 255)] ^ T[512 + ((i >>> 16) & 255)] ^ T[768 + (i >>> 24)];
}

/** Unscrambled 2D Sobol point (van der Corput, second Sobol dimension) for an index, in [0, 1)². */
export function sobol2(i: number): [number, number] {
  return [(rev32(i) >>> 0) * 2 ** -32, (rev32(sobol1Reversed(i)) >>> 0) * 2 ** -32];
}

const INV_2_32 = 2 ** -32;

/** Number of leading dimension pairs drawn from the scrambled Sobol sequence. */
export const SOBOL_PAIRS = 12;

/**
 * Per-path sample generator. `start` selects the pixel and sample index; `next2D(dim)` then yields a
 * point in [0, 1)² in `u0`/`u1` for dimension pair `dim` (the same call always gives the same
 * point for the same pixel, sample, dimension and seed).
 */
export class Sampler {
  u0 = 0;
  u1 = 0;
  private pixelSeed = 0;
  private sampleSeed = 0;
  private index = 0;
  private indexReversed = 0;
  private px = -1;
  private py = -1;
  /**
   * Per-pixel scramble seeds of the Sobol pairs (index shuffle, first and second coordinate),
   * filled lazily: `seedGen[dim] === gen` marks the entries valid for the current pixel.
   */
  private readonly seeds = new Int32Array(SOBOL_PAIRS * 3);
  private readonly seedGen = new Int32Array(SOBOL_PAIRS);
  private gen = 0;

  constructor(private readonly seed = 0) {}

  start(px: number, py: number, sampleIndex: number): void {
    if (px !== this.px || py !== this.py || this.gen === 0) {
      // new pixel: its seeds (consecutive samples of one pixel share them)
      this.px = px;
      this.py = py;
      this.pixelSeed = mix2(mix2(px, py), this.seed);
      this.gen = (this.gen + 1) | 0 || 1;
    }
    this.index = sampleIndex | 0;
    this.indexReversed = rev32(this.index);
    this.sampleSeed = mix2(this.pixelSeed, this.index);
  }

  next2D(dim: number): void {
    if (dim < SOBOL_PAIRS) {
      const k = dim * 3;
      const seeds = this.seeds;
      if (this.seedGen[dim] !== this.gen) {
        const s = mix32(this.pixelSeed ^ Math.imul(dim + 1, 0x9e3779b9));
        seeds[k] = s;
        seeds[k + 1] = mix32((s >>> 0) + 1);
        seeds[k + 2] = mix32((s >>> 0) + 2);
        this.seedGen[dim] = this.gen;
      }
      // shuffle the sample index (first 2^m indices map onto an aligned block of 2^m) …
      const idx = dim === 0 ? this.index : rev32(scrambleLow(this.indexReversed, seeds[k]));
      // … then scramble both coordinates (dimension 0 of Sobol is the bit-reversed index)
      this.u0 = (rev32(scrambleLow(idx, seeds[k + 1])) >>> 0) * INV_2_32;
      this.u1 = (rev32(scrambleLow(sobol1Reversed(idx), seeds[k + 2])) >>> 0) * INV_2_32;
    } else {
      const s = mix32(this.pixelSeed ^ Math.imul(dim + 1, 0x9e3779b9));
      const h = mix2(this.sampleSeed, s);
      this.u0 = (h >>> 0) * INV_2_32;
      this.u1 = (mix32((h >>> 0) + 0x3c6ef372) >>> 0) * INV_2_32;
    }
  }

  /**
   * `next2D` mapped to a pixel filter offset in pixels (both coordinates distributed like the
   * Blackman–Harris filter), into `u0`/`u1`.
   */
  nextFilter(dim: number): void {
    this.next2D(dim);
    this.u0 = filterOffset(this.u0);
    this.u1 = filterOffset(this.u1);
  }
}

// ------------------------------------------------------------------ pixel filter

/** Blackman–Harris pixel filter width in pixels (Blender's default). */
export const FILTER_WIDTH = 1.5;
const FILTER_TABLE_SIZE = 256;

/**
 * Inverse CDF of the 1D Blackman–Harris window over [-width/2, width/2]: filter importance
 * sampling (each sample lands in one pixel with weight 1, separable in x and y).
 */
const FILTER_TABLE: Float64Array = (() => {
  const n = 1024;
  const cdf = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const w =
      0.35875 -
      0.48829 * Math.cos(2 * Math.PI * t) +
      0.14128 * Math.cos(4 * Math.PI * t) -
      0.01168 * Math.cos(6 * Math.PI * t);
    cdf[i + 1] = cdf[i] + Math.max(0, w);
  }
  for (let i = 1; i <= n; i++) cdf[i] /= cdf[n];
  const table = new Float64Array(FILTER_TABLE_SIZE + 1);
  let j = 0;
  for (let k = 0; k <= FILTER_TABLE_SIZE; k++) {
    const u = k / FILTER_TABLE_SIZE;
    while (j < n - 1 && cdf[j + 1] < u) j++;
    const span = cdf[j + 1] - cdf[j];
    const f = span > 0 ? (u - cdf[j]) / span : 0;
    table[k] = ((j + Math.min(1, Math.max(0, f))) / n - 0.5) * FILTER_WIDTH;
  }
  return table;
})();

/** Maps a uniform number in [0, 1) to a pixel offset distributed like the Blackman–Harris filter. */
export function filterOffset(u: number): number {
  const x = u * FILTER_TABLE_SIZE;
  const i = Math.min(FILTER_TABLE_SIZE - 1, Math.floor(x));
  const f = x - i;
  return FILTER_TABLE[i] + (FILTER_TABLE[i + 1] - FILTER_TABLE[i]) * f;
}
