import { Rng } from './random';

/*
 * Seeded gradient noise for the generators: classic lattice gradient noise (quintic fade, twelve
 * cube-edge gradients) with a permutation table shuffled from the seed, plus fractal sums
 * (fBm, ridged and billow). Values are deterministic for a given seed on every platform.
 */

// Twelve cube-edge gradient directions, padded to 16 entries so `hash & 15` indexes them.
const GRAD: readonly (readonly [number, number, number])[] = [
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

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function dotGrad(h: number, x: number, y: number, z: number): number {
  const g = GRAD[h & 15];
  return g[0] * x + g[1] * y + g[2] * z;
}

export type FractalType = 'FBM' | 'RIDGED' | 'BILLOW';

export interface FractalOptions {
  /** Number of summed octaves (1..12). */
  octaves?: number;
  /** Amplitude multiplier per octave (0..1, "roughness"). */
  gain?: number;
  /** Frequency multiplier per octave. */
  lacunarity?: number;
  type?: FractalType;
}

export class GradientNoise {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = new Rng(seed, 0x6e6f6973);
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Gradient noise at a point, roughly in [-1, 1] (0 at lattice points). */
  noise3(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    x -= fx;
    y -= fy;
    z -= fz;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const p = this.perm;
    const A = p[X] + Y;
    const AA = p[A] + Z;
    const AB = p[A + 1] + Z;
    const B = p[X + 1] + Y;
    const BA = p[B] + Z;
    const BB = p[B + 1] + Z;
    const l = (t: number, a: number, b: number) => a + t * (b - a);
    return l(
      w,
      l(
        v,
        l(u, dotGrad(p[AA], x, y, z), dotGrad(p[BA], x - 1, y, z)),
        l(u, dotGrad(p[AB], x, y - 1, z), dotGrad(p[BB], x - 1, y - 1, z)),
      ),
      l(
        v,
        l(u, dotGrad(p[AA + 1], x, y, z - 1), dotGrad(p[BA + 1], x - 1, y, z - 1)),
        l(u, dotGrad(p[AB + 1], x, y - 1, z - 1), dotGrad(p[BB + 1], x - 1, y - 1, z - 1)),
      ),
    );
  }

  /**
   * Fractal sum of octaves, normalized to about [-1, 1]. FBM sums signed noise; RIDGED sums
   * sharpened ridges (1 - |n|)² (mountain crests); BILLOW sums |n| (rounded hills).
   */
  fractal(x: number, y: number, z: number, opts: FractalOptions = {}): number {
    const octaves = Math.max(1, Math.min(12, Math.round(opts.octaves ?? 4)));
    const gain = Math.max(0, Math.min(1, opts.gain ?? 0.5));
    const lac = opts.lacunarity ?? 2;
    const type = opts.type ?? 'FBM';
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      // per-octave offsets decorrelate the lattices of successive octaves
      const n = this.noise3(x * freq + o * 31.7, y * freq - o * 17.3, z * freq + o * 11.1);
      let s: number;
      if (type === 'RIDGED') {
        const r = 1 - Math.abs(n);
        s = r * r * 2 - 1;
      } else if (type === 'BILLOW') s = Math.abs(n) * 2 - 1;
      else s = n;
      sum += s * amp;
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return norm > 0 ? sum / norm : 0;
  }
}
