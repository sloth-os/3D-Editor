/*
 * Occlusion queries for automatic weights: does a segment cross a triangle that faces it?
 *
 * Bone heat only lets a triangle hide a bone from a vertex when the triangle's front side faces
 * the ray (Blender's rule: dot(normal, ray) < -1e-5). The back faces of the walls a ray leaves
 * through, e.g. the inner wall of a solidified (double-walled) sleeve between its outer wall and
 * the bone, do not block. Queries stop at the first blocking triangle (any hit), so a vertex that
 * cannot see a bone costs about as much as one that can.
 *
 * The triangles are kept in a bounding volume hierarchy built with median splits along the
 * longest axis of the triangle centroids (quickselect, O(n log n)).
 */

/** Triangles per leaf. */
const LEAF = 4;
/** Facing threshold on the cosine between the triangle normal and the ray (Blender's value). */
const FACING = -1e-5;

export class FacingOccluder {
  private readonly bounds: Float64Array;
  /** Inner nodes: index of the left child (the right child follows it); leaves: -1. */
  private readonly child: Int32Array;
  private readonly start: Int32Array;
  private readonly count: Int32Array;
  private readonly order: Int32Array;
  /** Unit normal per triangle (zero for degenerate triangles, which never block). */
  private readonly normals: Float64Array;
  private readonly stack: Int32Array;
  private nodes = 0;

  /**
   * @param positions flat xyz vertex positions
   * @param tris flat vertex indices, three per triangle (counter-clockwise = front)
   */
  constructor(
    private readonly positions: ArrayLike<number>,
    private readonly tris: ArrayLike<number>,
  ) {
    const n = Math.floor(tris.length / 3);
    // leaves hold at least 2 triangles once a node is split, so there are at most 2n - 1 nodes
    const maxNodes = Math.max(1, 2 * n);
    this.bounds = new Float64Array(maxNodes * 6);
    this.child = new Int32Array(maxNodes).fill(-1);
    this.start = new Int32Array(maxNodes);
    this.count = new Int32Array(maxNodes);
    this.order = new Int32Array(n);
    this.normals = new Float64Array(n * 3);
    const P = positions;
    const cen = new Float64Array(n * 3);
    for (let t = 0; t < n; t++) {
      this.order[t] = t;
      const a = tris[t * 3] * 3;
      const b = tris[t * 3 + 1] * 3;
      const c = tris[t * 3 + 2] * 3;
      const e1x = P[b] - P[a];
      const e1y = P[b + 1] - P[a + 1];
      const e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a];
      const e2y = P[c + 1] - P[a + 1];
      const e2z = P[c + 2] - P[a + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      if (l > 0 && Number.isFinite(l)) {
        this.normals[t * 3] = nx / l;
        this.normals[t * 3 + 1] = ny / l;
        this.normals[t * 3 + 2] = nz / l;
      }
      for (let k = 0; k < 3; k++) cen[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
    }
    let depth = 1;
    if (n > 0) {
      // iterative top-down build: [node, start, end, depth]
      const work: number[] = [this.newNode(), 0, n, 1];
      while (work.length) {
        const d = work.pop()!;
        const e = work.pop()!;
        const s = work.pop()!;
        const node = work.pop()!;
        depth = Math.max(depth, d);
        this.fitBounds(node, s, e);
        if (e - s <= LEAF) {
          this.start[node] = s;
          this.count[node] = e - s;
          continue;
        }
        // split at the median centroid along the longest axis of the centroid bounds
        let lo0 = Infinity;
        let lo1 = Infinity;
        let lo2 = Infinity;
        let hi0 = -Infinity;
        let hi1 = -Infinity;
        let hi2 = -Infinity;
        for (let i = s; i < e; i++) {
          const t = this.order[i] * 3;
          lo0 = Math.min(lo0, cen[t]);
          hi0 = Math.max(hi0, cen[t]);
          lo1 = Math.min(lo1, cen[t + 1]);
          hi1 = Math.max(hi1, cen[t + 1]);
          lo2 = Math.min(lo2, cen[t + 2]);
          hi2 = Math.max(hi2, cen[t + 2]);
        }
        const ex = hi0 - lo0;
        const ey = hi1 - lo1;
        const ez = hi2 - lo2;
        const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
        const mid = (s + e) >> 1;
        this.select(cen, axis, s, e, mid);
        const left = this.newNode();
        this.newNode();
        this.child[node] = left;
        work.push(left, s, mid, d + 1, left + 1, mid, e, d + 1);
      }
    }
    this.stack = new Int32Array(depth * 2 + 8);
  }

  private newNode(): number {
    return this.nodes++;
  }

  private fitBounds(node: number, s: number, e: number): void {
    const P = this.positions;
    const T = this.tris;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = this.order[i] * 3;
      for (let j = 0; j < 3; j++) {
        const v = T[t + j] * 3;
        const x = P[v];
        const y = P[v + 1];
        const z = P[v + 2];
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
  }

  /** Reorders order[s..e) so that position k holds the k-th smallest centroid along `axis`. */
  private select(cen: Float64Array, axis: number, s: number, e: number, k: number): void {
    const o = this.order;
    let lo = s;
    let hi = e - 1;
    while (hi > lo) {
      const pivot = cen[o[(lo + hi) >> 1] * 3 + axis];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (cen[o[i] * 3 + axis] < pivot) i++;
        while (cen[o[j] * 3 + axis] > pivot) j--;
        if (i <= j) {
          const tmp = o[i];
          o[i] = o[j];
          o[j] = tmp;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  /**
   * True when a triangle whose front faces the ray crosses the segment o + t·d, tMin < t < tMax
   * (t is relative to `d`, which need not be normalised).
   */
  blocked(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin: number, tMax: number) {
    if (this.nodes === 0) return false;
    const dl = Math.hypot(dx, dy, dz);
    if (!(dl > 0) || !Number.isFinite(dl)) return false;
    const P = this.positions;
    const T = this.tris;
    const N = this.normals;
    const B = this.bounds;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const facing = FACING * dl;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const b = node * 6;
      // slab test; a ray parallel to a slab only has to start inside it
      let t0 = tMin;
      let t1 = tMax;
      for (let k = 0; k < 3 && t0 <= t1; k++) {
        const o = k === 0 ? ox : k === 1 ? oy : oz;
        const dk = k === 0 ? dx : k === 1 ? dy : dz;
        const lo = B[b + k];
        const hi = B[b + 3 + k];
        if (dk === 0) {
          if (o < lo || o > hi) t0 = Infinity;
          continue;
        }
        const inv = k === 0 ? ix : k === 1 ? iy : iz;
        const a = (lo - o) * inv;
        const c = (hi - o) * inv;
        if (a < c) {
          if (a > t0) t0 = a;
          if (c < t1) t1 = c;
        } else {
          if (c > t0) t0 = c;
          if (a < t1) t1 = a;
        }
      }
      if (!(t0 <= t1)) continue;
      const left = this.child[node];
      if (left >= 0) {
        stack[sp++] = left;
        stack[sp++] = left + 1;
        continue;
      }
      for (let i = this.start[node], end = i + this.count[node]; i < end; i++) {
        const t = this.order[i];
        // only triangles facing against the ray can block it
        if (N[t * 3] * dx + N[t * 3 + 1] * dy + N[t * 3 + 2] * dz >= facing) continue;
        const pa = T[t * 3] * 3;
        const pb = T[t * 3 + 1] * 3;
        const pc = T[t * 3 + 2] * 3;
        const e1x = P[pb] - P[pa];
        const e1y = P[pb + 1] - P[pa + 1];
        const e1z = P[pb + 2] - P[pa + 2];
        const e2x = P[pc] - P[pa];
        const e2y = P[pc + 1] - P[pa + 1];
        const e2z = P[pc + 2] - P[pa + 2];
        const hx = dy * e2z - dz * e2y;
        const hy = dz * e2x - dx * e2z;
        const hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (det === 0 || !Number.isFinite(det)) continue;
        const inv = 1 / det;
        const sx = ox - P[pa];
        const sy = oy - P[pa + 1];
        const sz = oz - P[pa + 2];
        const u = (sx * hx + sy * hy + sz * hz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (hit > tMin && hit < tMax) return true;
      }
    }
    return false;
  }
}
