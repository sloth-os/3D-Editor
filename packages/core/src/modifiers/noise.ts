import { makeRandom } from './util';

/*
 * Seeded 3D gradient noise (lattice gradient noise with quintic fade) and fractal sums of it.
 * Output of `gradientNoise3` is roughly in [-1, 1]; `fbm3` maps to [0, 1].
 */

// 12 cube-edge gradient directions (+4 repeats so the table has 16 entries)
const GRADS = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
  [1, 1, 0],
  [0, -1, 1],
  [-1, 1, 0],
  [0, -1, -1],
];

const tables = new Map<number, Uint8Array>();

function permutation(seed: number): Uint8Array {
  const key = Math.floor(seed) | 0;
  let t = tables.get(key);
  if (t) return t;
  const rnd = makeRandom(key);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  t = new Uint8Array(512);
  for (let i = 0; i < 512; i++) t[i] = p[i & 255];
  if (tables.size > 64) tables.clear();
  tables.set(key, t);
  return t;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function dotGrad(hash: number, x: number, y: number, z: number): number {
  const g = GRADS[hash & 15];
  return g[0] * x + g[1] * y + g[2] * z;
}

/** Gradient noise in roughly [-1, 1]. */
export function gradientNoise3(x: number, y: number, z: number, seed = 0): number {
  const p = permutation(seed);
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  const dx = x - fx;
  const dy = y - fy;
  const dz = z - fz;
  const u = fade(dx);
  const v = fade(dy);
  const w = fade(dz);
  const h = (i: number, j: number, k: number) => p[p[p[X + i] + Y + j] + Z + k];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x00 = lerp(dotGrad(h(0, 0, 0), dx, dy, dz), dotGrad(h(1, 0, 0), dx - 1, dy, dz), u);
  const x10 = lerp(dotGrad(h(0, 1, 0), dx, dy - 1, dz), dotGrad(h(1, 1, 0), dx - 1, dy - 1, dz), u);
  const x01 = lerp(dotGrad(h(0, 0, 1), dx, dy, dz - 1), dotGrad(h(1, 0, 1), dx - 1, dy, dz - 1), u);
  const x11 = lerp(dotGrad(h(0, 1, 1), dx, dy - 1, dz - 1), dotGrad(h(1, 1, 1), dx - 1, dy - 1, dz - 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

/** Fractal Brownian motion (sum of `octaves` noise layers, halving amplitude per octave) in [0, 1]. */
export function fbm3(x: number, y: number, z: number, octaves: number, seed = 0): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  const n = Math.max(1, Math.min(16, Math.floor(octaves)));
  for (let o = 0; o < n; o++) {
    // irrational offsets keep integer input coordinates away from the lattice (where gradient noise is 0)
    sum +=
      amp *
      gradientNoise3(
        x * f + 0.5137 * (o + 1),
        y * f + 0.2923 * (o + 1),
        z * f + 0.7311 * (o + 1),
        seed + o * 31,
      );
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  const v = 0.5 + 0.5 * (sum / norm) * 1.4;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
