/*
 * Bounding volume hierarchy over triangles (or points) for nearest-point and ray queries.
 * Built top-down with median splits along the longest axis; queries are iterative.
 */

const LEAF = 4;

export interface ClosestHit {
  x: number;
  y: number;
  z: number;
  dist2: number;
  /** Primitive index. */
  prim: number;
}

export interface RayHit {
  t: number;
  prim: number;
}

/** Closest point on triangle (a, b, c) to p (region-based barycentric test). */
export function closestPointOnTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: number[],
): void {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax;
    out[1] = ay;
    out[2] = az;
    return;
  }
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx;
    out[1] = by;
    out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v;
    out[1] = ay + aby * v;
    out[2] = az + abz * v;
    return;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w;
    out[1] = ay + acy * w;
    out[2] = az + acz * w;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + (cx - bx) * w;
    out[1] = by + (cy - by) * w;
    out[2] = bz + (cz - bz) * w;
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

export class Bvh {
  /** Node bounds: minX, minY, minZ, maxX, maxY, maxZ. */
  private bounds: number[] = [];
  /** For inner nodes: index of the left child (right = left + 1 is not assumed); for leaves -1. */
  private left: number[] = [];
  private right: number[] = [];
  private start: number[] = [];
  private count: number[] = [];
  readonly order: Int32Array;

  /**
   * @param positions flat xyz array
   * @param prims flat vertex indices, `stride` per primitive (3 = triangles, 1 = points)
   */
  constructor(
    readonly positions: ArrayLike<number>,
    readonly prims: ArrayLike<number>,
    readonly stride: 1 | 3,
  ) {
    const n = prims.length / stride;
    this.order = new Int32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    if (n === 0) return;
    const cen = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let j = 0; j < stride; j++) s += positions[prims[i * stride + j] * 3 + k];
        cen[i * 3 + k] = s / stride;
      }
    }
    const stack: [number, number, number][] = [[this.newNode(), 0, n]];
    while (stack.length) {
      const [node, s, e] = stack.pop()!;
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let i = s; i < e; i++) {
        const p = this.order[i];
        for (let j = 0; j < stride; j++) {
          const v = prims[p * stride + j] * 3;
          const x = positions[v];
          const y = positions[v + 1];
          const z = positions[v + 2];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
      }
      const b = node * 6;
      this.bounds[b] = x0;
      this.bounds[b + 1] = y0;
      this.bounds[b + 2] = z0;
      this.bounds[b + 3] = x1;
      this.bounds[b + 4] = y1;
      this.bounds[b + 5] = z1;
      if (e - s <= LEAF) {
        this.start[node] = s;
        this.count[node] = e - s;
        continue;
      }
      const ex = x1 - x0;
      const ey = y1 - y0;
      const ez = z1 - z0;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const slice = Array.from(this.order.subarray(s, e));
      slice.sort((p, q) => cen[p * 3 + axis] - cen[q * 3 + axis]);
      for (let i = 0; i < slice.length; i++) this.order[s + i] = slice[i];
      const mid = (s + e) >> 1;
      const l = this.newNode();
      const r = this.newNode();
      this.left[node] = l;
      this.right[node] = r;
      stack.push([l, s, mid], [r, mid, e]);
    }
  }

  private newNode(): number {
    const i = this.left.length;
    this.left.push(-1);
    this.right.push(-1);
    this.start.push(0);
    this.count.push(0);
    for (let k = 0; k < 6; k++) this.bounds.push(0);
    return i;
  }

  private boxDist2(node: number, x: number, y: number, z: number): number {
    const b = node * 6;
    const dx = x < this.bounds[b] ? this.bounds[b] - x : x > this.bounds[b + 3] ? x - this.bounds[b + 3] : 0;
    const dy =
      y < this.bounds[b + 1] ? this.bounds[b + 1] - y : y > this.bounds[b + 4] ? y - this.bounds[b + 4] : 0;
    const dz =
      z < this.bounds[b + 2] ? this.bounds[b + 2] - z : z > this.bounds[b + 5] ? z - this.bounds[b + 5] : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Closest point on any primitive to (x, y, z). */
  closest(x: number, y: number, z: number): ClosestHit | null {
    if (this.order.length === 0) return null;
    const P = this.positions;
    const I = this.prims;
    const tmp = [0, 0, 0];
    let best: ClosestHit | null = null;
    let bestD = Infinity;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (this.boxDist2(node, x, y, z) >= bestD) continue;
      if (this.left[node] < 0) {
        for (let i = this.start[node]; i < this.start[node] + this.count[node]; i++) {
          const p = this.order[i];
          if (this.stride === 3) {
            const a = I[p * 3] * 3;
            const b = I[p * 3 + 1] * 3;
            const c = I[p * 3 + 2] * 3;
            closestPointOnTriangle(
              x,
              y,
              z,
              P[a],
              P[a + 1],
              P[a + 2],
              P[b],
              P[b + 1],
              P[b + 2],
              P[c],
              P[c + 1],
              P[c + 2],
              tmp,
            );
          } else {
            const a = I[p] * 3;
            tmp[0] = P[a];
            tmp[1] = P[a + 1];
            tmp[2] = P[a + 2];
          }
          const d = (tmp[0] - x) ** 2 + (tmp[1] - y) ** 2 + (tmp[2] - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { x: tmp[0], y: tmp[1], z: tmp[2], dist2: d, prim: p };
          }
        }
        continue;
      }
      const l = this.left[node];
      const r = this.right[node];
      const dl = this.boxDist2(l, x, y, z);
      const dr = this.boxDist2(r, x, y, z);
      if (dl < dr) stack.push(r, l);
      else stack.push(l, r);
    }
    return best;
  }

  /** Nearest triangle hit along the ray o + t·d with tMin < t < tMax (both faces count). */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    tMax: number,
  ): RayHit | null {
    if (this.order.length === 0 || this.stride !== 3) return null;
    const P = this.positions;
    const I = this.prims;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    let best: RayHit | null = null;
    let far = tMax;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      const b = node * 6;
      let t0 = tMin;
      let t1 = far;
      const slab = (o: number, inv: number, lo: number, hi: number) => {
        let a = (lo - o) * inv;
        let c = (hi - o) * inv;
        if (a > c) {
          const t = a;
          a = c;
          c = t;
        }
        if (Number.isNaN(a) || Number.isNaN(c)) return;
        if (a > t0) t0 = a;
        if (c < t1) t1 = c;
      };
      slab(ox, ix, this.bounds[b], this.bounds[b + 3]);
      slab(oy, iy, this.bounds[b + 1], this.bounds[b + 4]);
      slab(oz, iz, this.bounds[b + 2], this.bounds[b + 5]);
      if (t0 > t1) continue;
      if (this.left[node] >= 0) {
        stack.push(this.left[node], this.right[node]);
        continue;
      }
      for (let i = this.start[node]; i < this.start[node] + this.count[node]; i++) {
        const p = this.order[i];
        const a = I[p * 3] * 3;
        const bb = I[p * 3 + 1] * 3;
        const c = I[p * 3 + 2] * 3;
        const e1x = P[bb] - P[a];
        const e1y = P[bb + 1] - P[a + 1];
        const e1z = P[bb + 2] - P[a + 2];
        const e2x = P[c] - P[a];
        const e2y = P[c + 1] - P[a + 1];
        const e2z = P[c + 2] - P[a + 2];
        const hx = dy * e2z - dz * e2y;
        const hy = dz * e2x - dx * e2z;
        const hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < 1e-18) continue;
        const inv = 1 / det;
        const sx = ox - P[a];
        const sy = oy - P[a + 1];
        const sz = oz - P[a + 2];
        const u = (sx * hx + sy * hy + sz * hz) * inv;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > tMin && t < far) {
          far = t;
          best = { t, prim: p };
        }
      }
    }
    return best;
  }
}
