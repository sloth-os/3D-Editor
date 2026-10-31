/*
 * Static bounding volume hierarchy over the triangles of a MESH collision shape (body space).
 * Built once per shape with median splits; queries return overlapping triangle indices in
 * ascending order so contact generation is deterministic.
 */

const LEAF_SIZE = 4;

export class TriangleBVH {
  /** Per node: minX, minY, minZ, maxX, maxY, maxZ. */
  private readonly bounds: Float64Array;
  /**
   * Per node: [left child, right child, 0] for inner nodes, [first primitive, count, 1] for
   * leaves (primitives index `order`).
   */
  private readonly links: Int32Array;
  /** Triangle indices referenced by leaves. */
  private readonly order: Int32Array;
  /** Per triangle bounds: minX, minY, minZ, maxX, maxY, maxZ. */
  private readonly triBounds: Float64Array;
  readonly nodeCount: number;

  constructor(verts: ArrayLike<number>, tris: ArrayLike<number>) {
    const n = Math.floor(tris.length / 3);
    const tb = new Float64Array(n * 6);
    const cen = new Float64Array(n * 3);
    for (let t = 0; t < n; t++) {
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k] * 3;
        const x = verts[v];
        const y = verts[v + 1];
        const z = verts[v + 2];
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (z < z0) z0 = z;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        if (z > z1) z1 = z;
      }
      tb[t * 6] = x0;
      tb[t * 6 + 1] = y0;
      tb[t * 6 + 2] = z0;
      tb[t * 6 + 3] = x1;
      tb[t * 6 + 4] = y1;
      tb[t * 6 + 5] = z1;
      cen[t * 3] = (x0 + x1) / 2;
      cen[t * 3 + 1] = (y0 + y1) / 2;
      cen[t * 3 + 2] = (z0 + z1) / 2;
    }
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const maxNodes = Math.max(1, 2 * n);
    const bounds = new Float64Array(maxNodes * 6);
    const links = new Int32Array(maxNodes * 3);
    let count = 0;
    const build = (start: number, end: number): number => {
      const node = count++;
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      let cx0 = Infinity;
      let cy0 = Infinity;
      let cz0 = Infinity;
      let cx1 = -Infinity;
      let cy1 = -Infinity;
      let cz1 = -Infinity;
      for (let i = start; i < end; i++) {
        const t = order[i];
        x0 = Math.min(x0, tb[t * 6]);
        y0 = Math.min(y0, tb[t * 6 + 1]);
        z0 = Math.min(z0, tb[t * 6 + 2]);
        x1 = Math.max(x1, tb[t * 6 + 3]);
        y1 = Math.max(y1, tb[t * 6 + 4]);
        z1 = Math.max(z1, tb[t * 6 + 5]);
        cx0 = Math.min(cx0, cen[t * 3]);
        cy0 = Math.min(cy0, cen[t * 3 + 1]);
        cz0 = Math.min(cz0, cen[t * 3 + 2]);
        cx1 = Math.max(cx1, cen[t * 3]);
        cy1 = Math.max(cy1, cen[t * 3 + 1]);
        cz1 = Math.max(cz1, cen[t * 3 + 2]);
      }
      const o = node * 6;
      bounds[o] = x0;
      bounds[o + 1] = y0;
      bounds[o + 2] = z0;
      bounds[o + 3] = x1;
      bounds[o + 4] = y1;
      bounds[o + 5] = z1;
      if (end - start <= LEAF_SIZE) {
        links[node * 3] = start;
        links[node * 3 + 1] = end - start;
        links[node * 3 + 2] = 1;
        return node;
      }
      const ex = cx1 - cx0;
      const ey = cy1 - cy0;
      const ez = cz1 - cz0;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const slice = Array.from(order.subarray(start, end));
      slice.sort((a, b) => cen[a * 3 + axis] - cen[b * 3 + axis] || a - b);
      order.set(slice, start);
      const mid = (start + end) >> 1;
      const left = build(start, mid);
      const right = build(mid, end);
      links[node * 3] = left;
      links[node * 3 + 1] = right;
      links[node * 3 + 2] = 0;
      return node;
    };
    if (n > 0) build(0, n);
    this.bounds = bounds;
    this.links = links;
    this.order = order;
    this.triBounds = tb;
    this.nodeCount = count;
  }

  /** Appends (ascending) the indices of triangles whose bounds overlap the box to `out`. */
  query(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: number[]): number[] {
    if (this.nodeCount === 0) return out;
    const start = out.length;
    const b = this.bounds;
    const l = this.links;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      const o = node * 6;
      if (b[o] > x1 || b[o + 3] < x0 || b[o + 1] > y1 || b[o + 4] < y0 || b[o + 2] > z1 || b[o + 5] < z0)
        continue;
      if (l[node * 3 + 2] === 1) {
        const first = l[node * 3];
        const end = first + l[node * 3 + 1];
        const tb = this.triBounds;
        for (let i = first; i < end; i++) {
          const t = this.order[i];
          const q = t * 6;
          if (
            tb[q] > x1 ||
            tb[q + 3] < x0 ||
            tb[q + 1] > y1 ||
            tb[q + 4] < y0 ||
            tb[q + 2] > z1 ||
            tb[q + 5] < z0
          )
            continue;
          out.push(t);
        }
      } else stack.push(l[node * 3 + 1], l[node * 3]);
    }
    if (out.length - start > 1) {
      const found = out.splice(start).sort((a, c) => a - c);
      for (const t of found) out.push(t);
    }
    return out;
  }
}
