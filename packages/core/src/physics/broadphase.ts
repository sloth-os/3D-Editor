import type { Body } from './body';

/*
 * Broad phase: sweep and prune along X. The body order is kept between steps and re-sorted with
 * an insertion sort, which is close to linear for coherent motion. Pairs are reported sorted by
 * body index so the solver order never depends on positions.
 */
export class SweepAndPrune {
  private order: number[] = [];

  /**
   * Overlapping pairs `[a, b]` (a < b, body indices) of bodies whose bounds overlap and that
   * `filter` accepts, sorted by (a, b).
   */
  pairs(bodies: readonly Body[], filter: (a: Body, b: Body) => boolean): [number, number][] {
    const n = bodies.length;
    if (this.order.length !== n) this.order = bodies.map((_, i) => i);
    const order = this.order;
    // insertion sort by minX (ties by index keeps the order deterministic)
    for (let i = 1; i < n; i++) {
      const cur = order[i];
      const key = bodies[cur].minX;
      let j = i - 1;
      while (j >= 0) {
        const o = bodies[order[j]];
        if (o.minX < key || (o.minX === key && order[j] < cur)) break;
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = cur;
    }
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = bodies[order[i]];
      for (let j = i + 1; j < n; j++) {
        const b = bodies[order[j]];
        if (b.minX > a.maxX) break;
        if (b.minY > a.maxY || b.maxY < a.minY || b.minZ > a.maxZ || b.maxZ < a.minZ) continue;
        if (!filter(a, b)) continue;
        out.push(a.index < b.index ? [a.index, b.index] : [b.index, a.index]);
      }
    }
    out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    return out;
  }
}
