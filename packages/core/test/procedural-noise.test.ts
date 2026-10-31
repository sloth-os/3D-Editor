import { describe, expect, it } from 'vitest';
import {
  METRIC_CHEBYSHEV,
  METRIC_EUCLIDEAN,
  METRIC_MANHATTAN,
  NOISE_FBM,
  NOISE_RIDGED,
  NOISE_TURBULENCE,
  PFX_FMIX_M1,
  PFX_FMIX_M2,
  PFX_GRADIENTS,
  PFX_SEED_SALT,
  PFX_STREAM,
  PFX_UNIT,
  VORONOI_EDGE,
  VORONOI_F1,
  VORONOI_F2,
  fmix32,
  fractalNoise,
  gradientNoise,
  hash3,
  hashStream,
  hashUnit,
  sanitizeCoord,
  seedHash,
  streamSeed,
  voronoi3,
} from '../src/material/noise';

/*
 * Parity of the integer hash with an independent reference: BigInt arithmetic modulo 2³² (no
 * Math.imul / int32 tricks), which is exactly what GLSL ES 3.0 `uint` computes. The viewport shader
 * is generated from the same constants, so equal hashes here mean equal lattice values on the GPU.
 */

const M32 = (1n << 32n) - 1n;
const big = (v: number) => BigInt.asUintN(32, BigInt(v));

function refFmix(h: bigint): bigint {
  h &= M32;
  h ^= h >> 16n;
  h = (h * BigInt(PFX_FMIX_M1)) & M32;
  h ^= h >> 13n;
  h = (h * BigInt(PFX_FMIX_M2)) & M32;
  h ^= h >> 16n;
  return h;
}

function refHash3(x: number, y: number, z: number, s: number): bigint {
  const hz = refFmix(big(z) + BigInt(s));
  const hy = refFmix(big(y) + hz);
  return refFmix(big(x) + hy);
}

function refUnit(h: bigint): number {
  return Number(h >> 8n) / 16777216;
}

/** Reference gradient noise straight from the definition (BigInt hash, explicit trilinear blend). */
function refNoise(x: number, y: number, z: number, s: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  let sum = 0;
  for (let c = 0; c < 8; c++) {
    const ox = c & 1;
    const oy = (c >> 1) & 1;
    const oz = (c >> 2) & 1;
    const h = Number(refHash3(fx + ox, fy + oy, fz + oz, s) & 15n);
    const dx = x - fx - ox;
    const dy = y - fy - oy;
    const dz = z - fz - oz;
    const dot = PFX_GRADIENTS[h * 3] * dx + PFX_GRADIENTS[h * 3 + 1] * dy + PFX_GRADIENTS[h * 3 + 2] * dz;
    const wx = ox ? fade(x - fx) : 1 - fade(x - fx);
    const wy = oy ? fade(y - fy) : 1 - fade(y - fy);
    const wz = oz ? fade(z - fz) : 1 - fade(z - fz);
    sum += dot * wx * wy * wz;
  }
  return sum;
}

describe('integer hash (GLSL parity)', () => {
  it('matches hand-computed fmix32 values', () => {
    // 0 is a fixed point of the finalizer. fmix32(1) step by step (uint32):
    //   h ^= h >> 16 → 0x00000001;  h *= 0x85ebca6b → 0x85ebca6b;  h ^= h >> 13 → 0x85efe535;
    //   h *= 0xc2b2ae35 → 0x514e79f9;  h ^= h >> 16 → 0x514e28b7
    expect(fmix32(0)).toBe(0);
    expect(fmix32(1)).toBe(0x514e28b7);
    expect(fmix32(0x12345678)).toBe(0xe37cd1bc);
    // hash3 = fmix(x + fmix(y + fmix(z + s))), negative coordinates wrap like uint(int)
    expect(hash3(1, 2, 3, 0)).toBe(0x0d4cd949);
    expect(hash3(-1, -2, -3, 0)).toBe(0x76691fa0);
    for (const v of [1, 2, 3, 0x7fffffff, 0x80000000, 0xffffffff, 123456789, PFX_SEED_SALT])
      expect(fmix32(v)).toBe(Number(refFmix(big(v))));
  });

  it('reduces inputs modulo 2³² like uint arithmetic (negative lattice coordinates)', () => {
    expect(fmix32(-1)).toBe(fmix32(0xffffffff));
    expect(fmix32(2 ** 32 + 5)).toBe(fmix32(5));
    for (const [x, y, z] of [
      [0, 0, 0],
      [-1, 2, -3],
      [1000, -2000, 3000],
      [-2147483648, 2147483647, 7],
    ]) {
      for (const s of [0, seedHash(0), seedHash(42), 0xffffffff])
        expect(hash3(x, y, z, s)).toBe(Number(refHash3(x, y, z, s)));
    }
  });

  it('derives streams and seeds with wrap-around arithmetic', () => {
    const h = hash3(3, 4, 5, seedHash(1));
    for (const k of [1, 2, 3, 6, 101])
      expect(hashStream(h, k)).toBe(Number(refFmix(BigInt(h) + BigInt(k) * BigInt(PFX_STREAM))));
    expect(streamSeed(0xffffffff, 1)).toBe(Number((0xffffffffn + BigInt(PFX_STREAM)) & M32));
    expect(seedHash(7)).toBe(Number(refFmix(7n + BigInt(PFX_SEED_SALT))));
    expect(seedHash(-1)).toBe(Number(refFmix(0xffffffffn + BigInt(PFX_SEED_SALT))));
    expect(seedHash(2.9)).toBe(seedHash(2));
    expect(seedHash(NaN)).toBe(seedHash(0));
  });

  it('converts hashes to floats exactly (24 bits, float32-representable)', () => {
    expect(PFX_UNIT).toBe(2 ** -24);
    for (const h of [0, 1, 255, 256, 0xffffffff, 0x80000000, 123456789]) {
      const u = hashUnit(h);
      expect(u).toBe(refUnit(big(h)));
      expect(Math.fround(u)).toBe(u);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
    expect(hashUnit(0xffffffff)).toBe(16777215 / 16777216);
  });

  it('has a balanced gradient table of cube edge directions', () => {
    expect(PFX_GRADIENTS).toHaveLength(48);
    for (let i = 0; i < 16; i++) {
      const g = PFX_GRADIENTS.slice(i * 3, i * 3 + 3);
      expect(g.filter((v) => v === 0)).toHaveLength(1);
      expect(g.every((v) => Math.abs(v) <= 1)).toBe(true);
    }
  });
});

describe('gradient noise', () => {
  const s = seedHash(0);

  it('matches the reference definition at arbitrary points', () => {
    const pts = [
      [0.5, 0.25, 0.125],
      [-3.7, 12.01, 0.99],
      [101.3, -55.5, 7.75],
      [1e-9, -1e-9, 3.5],
    ];
    for (const [x, y, z] of pts) expect(gradientNoise(x, y, z, s)).toBeCloseTo(refNoise(x, y, z, s), 12);
  });

  it('is zero on lattice points, bounded and deterministic', () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [3, -4, 5],
      [-100, 7, 2],
    ])
      expect(gradientNoise(x, y, z, s)).toBeCloseTo(0, 12);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 20000; i++) {
      const v = gradientNoise(i * 0.1371, i * 0.0713 - 40, i * 0.0291 + 3, s);
      min = Math.min(min, v);
      max = Math.max(max, v);
      expect(gradientNoise(i * 0.1371, i * 0.0713 - 40, i * 0.0291 + 3, s)).toBe(v);
    }
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
    expect(max - min).toBeGreaterThan(1);
  });

  it('is continuous across lattice cells and depends on the seed', () => {
    for (const x of [1, 2, -3]) {
      const a = gradientNoise(x - 1e-7, 0.3, 0.7, s);
      const b = gradientNoise(x + 1e-7, 0.3, 0.7, s);
      expect(Math.abs(a - b)).toBeLessThan(1e-5);
    }
    let diff = 0;
    for (let i = 0; i < 50; i++)
      diff += Math.abs(
        gradientNoise(i * 0.37, 0.5, 0.25, s) - gradientNoise(i * 0.37, 0.5, 0.25, seedHash(9)),
      );
    expect(diff).toBeGreaterThan(1);
  });

  it('clamps and sanitises coordinates', () => {
    expect(sanitizeCoord(NaN)).toBe(0);
    expect(sanitizeCoord(Infinity)).toBe(1e7);
    expect(sanitizeCoord(-Infinity)).toBe(-1e7);
    expect(sanitizeCoord(-3.5)).toBe(-3.5);
  });
});

describe('fractal noise', () => {
  const s = seedHash(3);

  it('stays in [0, 1] for every flavour and blends fractional detail continuously', () => {
    for (const mode of [NOISE_FBM, NOISE_RIDGED, NOISE_TURBULENCE])
      for (let i = 0; i < 2000; i++) {
        const v = fractalNoise(i * 0.31, i * 0.17, 1.5, 4.5, 0.6, 2, s, mode);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    const a = fractalNoise(0.3, 0.4, 0.5, 2, 0.5, 2, s, NOISE_FBM);
    const b = fractalNoise(0.3, 0.4, 0.5, 2.0001, 0.5, 2, s, NOISE_FBM);
    const c = fractalNoise(0.3, 0.4, 0.5, 3, 0.5, 2, s, NOISE_FBM);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
    expect(a).not.toBe(c);
  });

  it('with roughness 0 equals the first octave', () => {
    const v = fractalNoise(1.3, 2.7, -0.4, 6, 0, 2, s, NOISE_FBM);
    expect(v).toBeCloseTo(0.5 + 0.5 * gradientNoise(1.3, 2.7, -0.4, streamSeed(s, 0)), 12);
  });
});

describe('voronoi', () => {
  const s = seedHash(11);
  const out = new Float64Array(3);

  it('orders F1 ≤ F2 and gives zero F1 on feature points', () => {
    for (let i = 0; i < 500; i++) {
      voronoi3(i * 0.113, i * 0.071, 0.5, 1, METRIC_EUCLIDEAN, s, true, out);
      expect(out[VORONOI_F1]).toBeLessThanOrEqual(out[VORONOI_F2]);
      expect(out[VORONOI_EDGE]).toBeGreaterThanOrEqual(0);
      expect(out[VORONOI_EDGE]).toBeLessThanOrEqual(out[VORONOI_F2]);
    }
    // randomness 0: feature points sit on the cell corners
    voronoi3(2, 3, 4, 0, METRIC_EUCLIDEAN, s, false, out);
    expect(out[VORONOI_F1]).toBeCloseTo(0, 12);
    voronoi3(2.5, 3.5, 4.5, 0, METRIC_EUCLIDEAN, s, true, out);
    expect(out[VORONOI_F1]).toBeCloseTo(Math.sqrt(0.75), 12);
    expect(out[VORONOI_EDGE]).toBeCloseTo(0, 12);
  });

  it('supports Manhattan and Chebyshev metrics', () => {
    voronoi3(2.25, 3.5, 4.5, 0, METRIC_MANHATTAN, s, false, out);
    expect(out[VORONOI_F1]).toBeCloseTo(1.25, 12);
    voronoi3(2.25, 3.5, 4.5, 0, METRIC_CHEBYSHEV, s, false, out);
    expect(out[VORONOI_F1]).toBeCloseTo(0.5, 12);
  });

  it('returns the same cell hash inside a cell (randomness 0)', () => {
    const h1 = voronoi3(5.1, 5.1, 5.1, 0, METRIC_EUCLIDEAN, s, false, out);
    const h2 = voronoi3(4.9, 4.95, 5.2, 0, METRIC_EUCLIDEAN, s, false, out);
    expect(h1).toBe(h2);
    expect(h1).toBe(Number(refHash3(5, 5, 5, s)));
  });
});
