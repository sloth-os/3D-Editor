import type { Vec3 } from '../math/types';
import type { MeshData } from '../mesh/types';
import { vertexCount } from '../mesh/types';
import { triangulateMesh } from '../mesh/triangulate';
import { Bvh } from '../modifiers/bvh';
import { vertexNormalsOf } from '../modifiers/util';
import { envelopeFactor } from './skinning';
import { SparseLDL, nestedDissectionOrder } from './sparse';

/*
 * Automatic skin weights.
 *
 * "Bone heat" (like Blender's With Automatic Weights): every vertex is heated by its nearest
 * bone that it can "see" (the segment from the vertex to the closest point of the bone does not
 * cross the mesh), with a strength falling off with the squared distance, and the heat of each
 * bone diffuses over the surface. Per bone we solve the screened Poisson problem
 *
 *   (L + A·H) w = A·H·p
 *
 * with L the (clamped) cotangent Laplacian of the surface, A the vertex areas, H the heat
 * strengths (1 / distance²) and p the indicator of "this bone is the vertex's nearest visible
 * bone". The solutions form a partition of unity; tiny weights are dropped and the rest
 * renormalised. Everything is scale invariant and deterministic.
 */

export interface WeightBone {
  name: string;
  /** Rest head and tail in the same space as the mesh positions (armature space). */
  head: Vec3;
  tail: Vec3;
  /** Envelope settings (envelope weights only). */
  headRadius?: number;
  tailRadius?: number;
  distance?: number;
}

export interface HeatWeightOptions {
  /** Weights below this are dropped before renormalising (default 0.01). */
  threshold?: number;
  /** Maximum conjugate-gradient iterations per bone (huge meshes only; default 1000). */
  maxIterations?: number;
  /** Largest sparse factor (entries) for the direct solver before falling back to CG (default 2e7). */
  maxFactorSize?: number;
}

export interface WeightResult {
  /** One dense weight array per bone (same order as the input bones). */
  weights: Float32Array[];
  /** Non-fatal notes, e.g. vertices that could not see any bone. */
  warnings: string[];
}

/**
 * Envelope weights of every vertex for every bone (Blender's "With Envelope Weights"): 1 inside
 * the bone's envelope radius, falling to 0 over its envelope distance. Not normalised.
 */
export function computeEnvelopeWeights(
  positions: ArrayLike<number>,
  bones: readonly WeightBone[],
): Float32Array[] {
  const n = Math.floor(positions.length / 3);
  return bones.map((b) => {
    const w = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      w[v] = envelopeFactor(
        [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]],
        b.head,
        b.tail,
        b.headRadius ?? 0.1,
        b.tailRadius ?? 0.05,
        b.distance ?? 0.25,
      );
    }
    return w;
  });
}

/** Closest point parameter (0..1) on segment a→b to p. */
function segmentParam(px: number, py: number, pz: number, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  if (!(l2 > 0)) return 0;
  const t = ((px - a[0]) * dx + (py - a[1]) * dy + (pz - a[2]) * dz) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Sparse symmetric matrix (CSR) with a separate diagonal. */
interface SparseSystem {
  rowStart: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
  diag: Float64Array;
}

/** y = M·x */
function multiply(m: SparseSystem, x: Float64Array, y: Float64Array): void {
  const n = m.diag.length;
  for (let i = 0; i < n; i++) {
    let s = m.diag[i] * x[i];
    for (let k = m.rowStart[i]; k < m.rowStart[i + 1]; k++) s += m.vals[k] * x[m.cols[k]];
    y[i] = s;
  }
}

/** Jacobi-preconditioned conjugate gradients, starting from `x` (updated in place). */
function solvePcg(m: SparseSystem, b: Float64Array, x: Float64Array, maxIt: number, tol: number): void {
  const n = b.length;
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  multiply(m, x, ap);
  let bn = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - ap[i];
    bn += b[i] * b[i];
  }
  bn = Math.sqrt(bn);
  if (bn === 0) {
    x.fill(0);
    return;
  }
  let rz = 0;
  for (let i = 0; i < n; i++) {
    z[i] = r[i] / m.diag[i];
    p[i] = z[i];
    rz += r[i] * z[i];
  }
  for (let it = 0; it < maxIt; it++) {
    let rn = 0;
    for (let i = 0; i < n; i++) rn += r[i] * r[i];
    if (Math.sqrt(rn) <= tol * bn) break;
    multiply(m, p, ap);
    let pap = 0;
    for (let i = 0; i < n; i++) pap += p[i] * ap[i];
    if (!(pap > 0)) break;
    const alpha = rz / pap;
    let rzNew = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
      z[i] = r[i] / m.diag[i];
      rzNew += r[i] * z[i];
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
}

/** Number of decay lengths kept around a bone's heat sources. */
const BAND = 8;

/** Solves the heat system on the band of vertices around a set of seeds (zero outside). */
class BandSolver {
  private readonly cost: Float64Array;
  private readonly local: Int32Array;

  constructor(
    private readonly n: number,
    private readonly rowStart: Int32Array,
    private readonly cols: Int32Array,
    private readonly vals: Float64Array,
    private readonly diag: Float64Array,
    private readonly P: ArrayLike<number>,
    private readonly invDecay: Float64Array,
  ) {
    this.cost = new Float64Array(n).fill(Infinity);
    this.local = new Int32Array(n).fill(-1);
  }

  /** Vertices within BAND decay lengths of the seeds (Dijkstra over the mesh edges). */
  private region(seeds: readonly number[]): number[] {
    const { cost, rowStart, cols, P, invDecay } = this;
    const heap = new MinHeap();
    const visited: number[] = [];
    for (const s of seeds) {
      if (cost[s] === 0) continue;
      cost[s] = 0;
      heap.push(0, s);
      visited.push(s);
    }
    const out: number[] = [];
    while (heap.size) {
      const [c, v] = heap.pop();
      if (c > cost[v]) continue;
      out.push(v);
      for (let k = rowStart[v]; k < rowStart[v + 1]; k++) {
        const u = cols[k];
        const len = Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
        const nc = c + len * 0.5 * (invDecay[u] + invDecay[v]);
        if (nc > BAND || nc >= cost[u]) continue;
        if (cost[u] === Infinity) visited.push(u);
        cost[u] = nc;
        heap.push(nc, u);
      }
    }
    for (const v of visited) cost[v] = Infinity;
    return out;
  }

  /** Writes the solution (zero outside the band) into `target`. */
  solve(seeds: number[], rhs: number[], guess: number[], target: Float32Array, maxIt: number): void {
    const verts = this.region(seeds);
    const m = verts.length;
    const { local, rowStart, cols, vals, diag } = this;
    verts.forEach((v, i) => (local[v] = i));
    const lr = new Int32Array(m + 1);
    for (let i = 0; i < m; i++) {
      const v = verts[i];
      let c = 0;
      for (let k = rowStart[v]; k < rowStart[v + 1]; k++) if (local[cols[k]] >= 0) c++;
      lr[i + 1] = lr[i] + c;
    }
    const lc = new Int32Array(lr[m]);
    const lv = new Float64Array(lr[m]);
    const ld = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const v = verts[i];
      let o = lr[i];
      for (let k = rowStart[v]; k < rowStart[v + 1]; k++) {
        const u = local[cols[k]];
        if (u < 0) continue;
        lc[o] = u;
        lv[o++] = vals[k];
      }
      ld[i] = diag[v];
    }
    const b = new Float64Array(m);
    const x = new Float64Array(m);
    seeds.forEach((v, i) => {
      b[local[v]] = rhs[i];
      x[local[v]] = guess[i];
    });
    solvePcg({ rowStart: lr, cols: lc, vals: lv, diag: ld }, b, x, maxIt, 1e-5);
    for (let i = 0; i < m; i++) target[verts[i]] = x[i];
    for (const v of verts) local[v] = -1;
  }
}

/** Binary min-heap of (key, value) pairs. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }

  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

/**
 * Automatic (bone heat) weights of a mesh for the given bones. Mesh positions and bones must be
 * in the same space (armature space). Returns one dense weight array per bone; every vertex's
 * weights sum to 1 (vertices are never left without a bone).
 */
export function computeHeatWeights(
  mesh: MeshData,
  bones: readonly WeightBone[],
  opts: HeatWeightOptions = {},
): WeightResult {
  const n = vertexCount(mesh);
  const nb = bones.length;
  const warnings: string[] = [];
  const out = bones.map(() => new Float32Array(n));
  if (n === 0 || nb === 0) return { weights: out, warnings };
  const P = Float64Array.from(mesh.positions);
  let invalid = 0;
  for (let i = 0; i < P.length; i++)
    if (!Number.isFinite(P[i])) {
      P[i] = 0;
      invalid++;
    }
  if (invalid) warnings.push(`${invalid} invalid vertex coordinates were treated as 0`);
  const threshold = opts.threshold ?? 0.01;
  const maxIt = opts.maxIterations ?? 1000;

  // ---- scale (for epsilons)
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number) => {
    lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
    hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
  };
  for (let v = 0; v < n; v++) grow(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
  for (const b of bones) {
    grow(...b.head);
    grow(...b.tail);
  }
  const scale = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const minDist = scale * 1e-4;

  // ---- surface: triangles, cotangent Laplacian, vertex areas
  const tris = triangulateMesh({ ...mesh, positions: Array.from(P) }).indices;
  const area = new Float64Array(n);
  const edgeW = new Map<number, number>();
  const addEdge = (a: number, b: number, w: number) => {
    const key = a < b ? a * n + b : b * n + a;
    edgeW.set(key, (edgeW.get(key) ?? 0) + w);
  };
  for (let t = 0; t < tris.length; t += 3) {
    const ids = [tris[t], tris[t + 1], tris[t + 2]];
    const pt = ids.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const e1 = [pt[1][0] - pt[0][0], pt[1][1] - pt[0][1], pt[1][2] - pt[0][2]];
    const e2 = [pt[2][0] - pt[0][0], pt[2][1] - pt[0][1], pt[2][2] - pt[0][2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dbl = Math.hypot(cr[0], cr[1], cr[2]);
    for (const i of ids) area[i] += dbl / 6;
    for (let c = 0; c < 3; c++) {
      const o = pt[c];
      const a = pt[(c + 1) % 3];
      const b = pt[(c + 2) % 3];
      const ux = a[0] - o[0];
      const uy = a[1] - o[1];
      const uz = a[2] - o[2];
      const vx = b[0] - o[0];
      const vy = b[1] - o[1];
      const vz = b[2] - o[2];
      const cx = uy * vz - uz * vy;
      const cy = uz * vx - ux * vz;
      const cz = ux * vy - uy * vx;
      const s = Math.hypot(cx, cy, cz);
      const cot = s > 1e-20 ? (ux * vx + uy * vy + uz * vz) / s : 0;
      addEdge(ids[(c + 1) % 3], ids[(c + 2) % 3], 0.5 * cot);
    }
  }
  const looseLen = new Float64Array(n);
  const looseCnt = new Uint32Array(n);
  for (let i = 0; i + 1 < mesh.looseEdges.length; i += 2) {
    const a = mesh.looseEdges[i];
    const b = mesh.looseEdges[i + 1];
    if (a === b || a >= n || b >= n) continue;
    addEdge(a, b, 1);
    const l = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    looseLen[a] += l;
    looseLen[b] += l;
    looseCnt[a]++;
    looseCnt[b]++;
  }
  let areaSum = 0;
  let areaCnt = 0;
  for (let v = 0; v < n; v++)
    if (area[v] > 0) {
      areaSum += area[v];
      areaCnt++;
    }
  const fallbackArea = areaCnt ? (areaSum / areaCnt) * 1e-3 : (scale * 1e-2) ** 2;
  for (let v = 0; v < n; v++) {
    if (area[v] > 0) continue;
    area[v] = looseCnt[v] ? (looseLen[v] / looseCnt[v]) ** 2 : fallbackArea;
  }

  // adjacency (CSR) with clamped positive weights; connected components
  const deg = new Int32Array(n + 1);
  for (const key of edgeW.keys()) {
    deg[Math.floor(key / n) + 1]++;
    deg[(key % n) + 1]++;
  }
  for (let v = 0; v < n; v++) deg[v + 1] += deg[v];
  const cols = new Int32Array(deg[n]);
  const vals = new Float64Array(deg[n]);
  const lapDiag = new Float64Array(n);
  const fill = deg.slice(0, n);
  const comp = new Int32Array(n);
  for (let v = 0; v < n; v++) comp[v] = v;
  const find = (v: number): number => {
    while (comp[v] !== v) {
      comp[v] = comp[comp[v]];
      v = comp[v];
    }
    return v;
  };
  for (const [key, w0] of edgeW) {
    const a = Math.floor(key / n);
    const b = key % n;
    const w = Math.max(w0, 1e-4);
    cols[fill[a]] = b;
    vals[fill[a]++] = -w;
    cols[fill[b]] = a;
    vals[fill[b]++] = -w;
    lapDiag[a] += w;
    lapDiag[b] += w;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) comp[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  // ---- heat sources: nearest visible bone(s)
  const normals = vertexNormalsOf({ ...mesh, positions: Array.from(P) });
  const bvh = tris.length ? new Bvh(P, tris, 3) : null;
  const closest = new Float64Array(nb * 3);
  const dist = new Float64Array(nb);
  const order = new Int32Array(nb);
  const heat = new Float64Array(n);
  const source = new Int32Array(n * Math.min(nb, 4)).fill(-1);
  const maxSources = Math.min(nb, 4);
  const sourceCount = new Int32Array(n);
  /** Fills dist/closest for vertex v; returns false when every distance is invalid. */
  const measure = (v: number) => {
    const x = P[v * 3];
    const y = P[v * 3 + 1];
    const z = P[v * 3 + 2];
    for (let j = 0; j < nb; j++) {
      const b = bones[j];
      const t = segmentParam(x, y, z, b.head, b.tail);
      const cx = b.head[0] + (b.tail[0] - b.head[0]) * t;
      const cy = b.head[1] + (b.tail[1] - b.head[1]) * t;
      const cz = b.head[2] + (b.tail[2] - b.head[2]) * t;
      closest[j * 3] = cx;
      closest[j * 3 + 1] = cy;
      closest[j * 3 + 2] = cz;
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const d = Math.hypot(dx, dy, dz);
      // bones behind the surface (normal pointing towards the bone) count as much further away
      const nl = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      const cos =
        d > 0 && nl > 0
          ? (dx * normals[v * 3] + dy * normals[v * 3 + 1] + dz * normals[v * 3 + 2]) / (d * nl)
          : 1;
      dist[j] = Math.max(d, minDist) / (0.5 * (cos + 1.001));
      order[j] = j;
    }
    order.sort((a, b) => dist[a] - dist[b] || a - b);
  };
  const visible = (v: number, j: number): boolean => {
    if (!bvh) return true;
    const x = P[v * 3];
    const y = P[v * 3 + 1];
    const z = P[v * 3 + 2];
    const dx = closest[j * 3] - x;
    const dy = closest[j * 3 + 1] - y;
    const dz = closest[j * 3 + 2] - z;
    if (Math.hypot(dx, dy, dz) < minDist) return true;
    return !bvh.raycast(x, y, z, dx, dy, dz, 1e-6, 1 - 1e-6);
  };
  const assign = (v: number, useVisibility: boolean): boolean => {
    measure(v);
    let best = -1;
    for (let k = 0; k < nb; k++) {
      const j = order[k];
      if (!useVisibility || visible(v, j)) {
        best = j;
        break;
      }
    }
    if (best < 0) return false;
    const limit = dist[best] * (1 + 1e-4);
    let count = 0;
    for (let k = 0; k < nb && count < maxSources; k++) {
      const j = order[k];
      if (dist[j] > limit) break;
      if (j !== best && useVisibility && !visible(v, j)) continue;
      source[v * maxSources + count++] = j;
    }
    sourceCount[v] = count;
    heat[v] = count / (dist[best] * dist[best]);
    return true;
  };
  let hidden = 0;
  for (let v = 0; v < n; v++) if (!assign(v, true)) hidden++;
  // components without any heat source would have no solution: use the nearest bones there
  const compHeat = new Map<number, number>();
  for (let v = 0; v < n; v++) compHeat.set(find(v), (compHeat.get(find(v)) ?? 0) + heat[v]);
  let rescued = 0;
  for (let v = 0; v < n; v++) {
    if (compHeat.get(find(v))! > 0) continue;
    assign(v, false);
    rescued++;
  }
  if (hidden)
    warnings.push(
      `${hidden} vertices could not see any bone${rescued ? ` (${rescued} use their nearest bone instead)` : ''}`,
    );

  // ---- solve one screened Poisson problem per bone. The matrix is the same for every bone: it
  // is factorised once (sparse LDLᵀ) and each bone costs two triangular solves. Huge meshes fall
  // back to conjugate gradients restricted to the band of vertices each bone can reach (away
  // from its heat sources a weight decays like exp(-x / d), d = local distance to the bones).
  const diag = new Float64Array(n);
  for (let v = 0; v < n; v++) diag[v] = lapDiag[v] + area[v] * heat[v];
  for (let v = 0; v < n; v++) if (!(diag[v] > 0)) diag[v] = 1; // isolated vertex without heat
  const system = { rowStart: deg, cols, vals, diag };
  const ldl = SparseLDL.factor(system, nestedDissectionOrder(system, P, n), opts.maxFactorSize ?? 2e7);
  let band: BandSolver | null = null;
  if (!ldl) {
    const invDecay = new Float64Array(n);
    for (let v = 0; v < n; v++) invDecay[v] = Math.sqrt(heat[v]);
    band = new BandSolver(n, deg, cols, vals, diag, P, invDecay);
  }
  for (let j = 0; j < nb; j++) {
    const seeds: number[] = [];
    const seedValue: number[] = [];
    for (let v = 0; v < n; v++) {
      const c = sourceCount[v];
      for (let k = 0; k < c; k++)
        if (source[v * maxSources + k] === j) {
          seeds.push(v);
          seedValue.push(1 / c);
        }
    }
    if (!seeds.length) continue;
    const rhs = seeds.map((v, i) => area[v] * heat[v] * seedValue[i]);
    if (ldl) {
      const b = new Float64Array(n);
      seeds.forEach((v, i) => (b[v] = rhs[i]));
      out[j].set(ldl.solve(b));
    } else band!.solve(seeds, rhs, seedValue, out[j], maxIt);
  }

  // ---- clean up: drop tiny weights, renormalise, never leave a vertex unweighted
  for (let v = 0; v < n; v++) {
    let sum = 0;
    for (let j = 0; j < nb; j++) {
      let w = out[j][v];
      if (!(w >= threshold)) w = 0;
      out[j][v] = w;
      sum += w;
    }
    if (sum > 0) {
      for (let j = 0; j < nb; j++) out[j][v] /= sum;
      continue;
    }
    // fall back to the heat sources (or the nearest bone)
    if (!sourceCount[v]) assign(v, false);
    const c = sourceCount[v];
    for (let k = 0; k < c; k++) out[source[v * maxSources + k]][v] = 1 / c;
  }
  return { weights: out, warnings };
}
