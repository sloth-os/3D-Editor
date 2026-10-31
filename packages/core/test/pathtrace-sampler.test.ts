import { describe, expect, it } from 'vitest';
import { FILTER_WIDTH, Sampler, filterOffset, hash32, owenScramble, sobol2 } from '../src/render/pathtrace';
import { SOBOL_PAIRS } from '../src/render/pathtrace/sampler';

/** True when every elementary interval of area 2^-m holds exactly one of the 2^m points. */
function isNet(pts: number[][], m: number): boolean {
  for (let a = 0; a <= m; a++) {
    const nx = 1 << a;
    const ny = 1 << (m - a);
    const cnt = new Int32Array(nx * ny);
    for (const [x, y] of pts) cnt[Math.floor(x * nx) * ny + Math.floor(y * ny)]++;
    if (!cnt.every((c) => c === 1)) return false;
  }
  return true;
}

describe('low-discrepancy sampler', () => {
  it('unscrambled 2D Sobol points form (0,m,2)-nets', () => {
    for (const m of [1, 3, 5, 8]) {
      const pts = Array.from({ length: 1 << m }, (_, i) => sobol2(i));
      expect(isNet(pts, m)).toBe(true);
    }
  });

  it('keeps every power-of-two prefix of each Sobol pair stratified for any pixel and seed', () => {
    for (const seed of [0, 12345]) {
      for (const [px, py] of [
        [0, 0],
        [7, 3],
        [640, 359],
      ]) {
        for (let dim = 0; dim < SOBOL_PAIRS; dim++) {
          for (const m of [2, 4, 6]) {
            const s = new Sampler(seed);
            const pts: number[][] = [];
            for (let i = 0; i < 1 << m; i++) {
              s.start(px, py, i);
              s.next2D(dim);
              pts.push([s.u0, s.u1]);
            }
            expect(isNet(pts, m)).toBe(true);
          }
        }
      }
    }
  });

  it('is deterministic, decorrelated between pixels, dimensions and seeds, and stays in [0, 1)', () => {
    const a = new Sampler(1);
    const b = new Sampler(1);
    const c = new Sampler(2);
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      for (const dim of [0, 3, SOBOL_PAIRS + 5]) {
        a.start(10, 20, i);
        a.next2D(dim);
        b.start(10, 20, i);
        b.next2D(dim);
        expect([a.u0, a.u1]).toEqual([b.u0, b.u1]);
        c.start(10, 20, i);
        c.next2D(dim);
        seen.add(`${a.u0 === c.u0}`);
        for (const v of [a.u0, a.u1]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        }
      }
    }
    expect(seen.has('false')).toBe(true);
    // different pixels give different sequences
    a.start(0, 0, 0);
    a.next2D(1);
    const p0 = [a.u0, a.u1];
    a.start(1, 0, 0);
    a.next2D(1);
    expect([a.u0, a.u1]).not.toEqual(p0);
    // hashed (deep) dimensions are uniform
    let sum = 0;
    let sum2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      a.start(i % 97, Math.floor(i / 97), i);
      a.next2D(SOBOL_PAIRS + 3);
      sum += a.u0;
      sum2 += a.u0 * a.u0;
    }
    expect(sum / n).toBeCloseTo(0.5, 1);
    expect(sum2 / n - (sum / n) ** 2).toBeCloseTo(1 / 12, 2);
  });

  it('owen scrambling and hashing are bijective on small domains', () => {
    // scrambling 2^8 values whose low 24 bits are 0 permutes their top byte
    const out = new Set<number>();
    for (let i = 0; i < 256; i++) out.add(owenScramble((i << 24) >>> 0, 0xdeadbeef) >>> 24);
    expect(out.size).toBe(256);
    const h = new Set<number>();
    for (let i = 0; i < 4096; i++) h.add(hash32(i));
    expect(h.size).toBe(4096);
  });

  it('importance-samples the Blackman–Harris pixel filter', () => {
    const half = FILTER_WIDTH / 2;
    expect(filterOffset(0)).toBeCloseTo(-half, 6);
    expect(filterOffset(0.999999)).toBeCloseTo(half, 3);
    expect(filterOffset(0.5)).toBeCloseTo(0, 6);
    let prev = -Infinity;
    let inside = 0;
    for (let i = 0; i < 1000; i++) {
      const v = filterOffset((i + 0.5) / 1000);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
      if (Math.abs(v) < 0.5) inside++;
    }
    // most of the filter's weight lies within the pixel, some reaches the neighbours
    expect(inside).toBeGreaterThan(750);
    expect(inside).toBeLessThan(1000);
  });
});
