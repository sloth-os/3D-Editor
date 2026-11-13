import type { Vec3 } from '../math/types';

/*
 * Deterministic pseudo random numbers for the procedural generators. Every generator derives its
 * streams from the user's seed plus a per-feature salt, so the same parameters always produce the
 * same geometry on every device, and changing one feature (e.g. leaf density) does not reshuffle
 * unrelated ones (e.g. the branch layout).
 */

const TWO_POW_32 = 4294967296;

/** 32-bit avalanche hash (xor-shift-multiply finalizer). Returns an unsigned 32-bit integer. */
export function hash32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

/** Folds any number (negative, fractional, huge or NaN) and a salt into a 32-bit seed. */
export function seedOf(seed: number, salt = 0): number {
  const s = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const lo = (s % TWO_POW_32) >>> 0;
  const hi = (Math.floor(s / TWO_POW_32) % TWO_POW_32) >>> 0;
  return hash32(lo ^ hash32(hi ^ hash32((salt >>> 0) + 0x632be5ab)));
}

/** Small, fast, seedable generator (Weyl sequence + hash finalizer). */
export class Rng {
  private state: number;

  constructor(seed: number, salt = 0) {
    this.state = seedOf(seed, salt);
  }

  /** Uniform number in [0, 1). */
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    return hash32(this.state) / TWO_POW_32;
  }

  /** Uniform number in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform number in [-a, a). */
  spread(a: number): number {
    return (this.next() * 2 - 1) * a;
  }

  /** Uniform integer in [a, b] (inclusive). */
  int(a: number, b: number): number {
    if (b <= a) return a;
    return a + Math.min(b - a, Math.floor(this.next() * (b - a + 1)));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /** Standard normal deviate (Box-Muller). */
  normal(): number {
    const u = Math.max(1e-12, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Uniformly distributed unit vector. */
  unitVector(): Vec3 {
    const z = this.next() * 2 - 1;
    const a = this.next() * 2 * Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(a), r * Math.sin(a), z];
  }

  /** Independent generator derived from this one's seed history and a salt. */
  fork(salt: number): Rng {
    const r = new Rng(0);
    r.state = hash32(this.state ^ hash32((salt >>> 0) + 0x7f4a7c15));
    return r;
  }
}
