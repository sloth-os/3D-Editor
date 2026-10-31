import { z } from 'zod';
import type { EdgeAttr, MeshData } from '../mesh/types';
import { edgeKey, parseEdgeKey, vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import { triangulateFaceCorners } from '../mesh/triangulate';
import type { ModifierDef } from './registry';
import { DEG, axisIndex, cleanEdgeAttr, faceNormalsOf, hasColors, zAxis } from './util';
import { dissolveStraightVertices, mergeFaceRegions } from './polymerge';

const DELIMIT = ['NORMAL', 'MATERIAL', 'SEAM', 'SHARP', 'UV'] as const;

const schema = z.object({
  decimate_type: z
    .enum(['COLLAPSE', 'UNSUBDIV', 'DISSOLVE'])
    .default('COLLAPSE')
    .describe(
      'COLLAPSE: edge collapse to `ratio`; UNSUBDIV: undo grid subdivision `iterations` times; DISSOLVE: merge near-coplanar faces',
    ),
  ratio: z.number().min(0).max(1).default(1).describe('COLLAPSE: fraction of triangles to keep'),
  iterations: z.number().int().min(0).max(100).default(0).describe('UNSUBDIV: number of un-subdivide passes'),
  angle_limit: z
    .number()
    .min(0)
    .max(Math.PI)
    .default(5 * DEG)
    .describe('DISSOLVE: maximum angle (radians) between merged faces'),
  use_symmetry: z
    .boolean()
    .default(false)
    .describe('COLLAPSE: keep vertices on the symmetry plane on the plane'),
  symmetry_axis: zAxis('X'),
  use_collapse_triangulate: z
    .boolean()
    .default(false)
    .describe('COLLAPSE: keep the triangulated result (otherwise rejoin quads)'),
  use_dissolve_boundaries: z.boolean().default(false).describe('Accepted for compatibility (no effect)'),
  delimit: z
    .array(z.enum(DELIMIT))
    .default(() => [])
    .describe(
      'DISSOLVE: never merge across material changes, seams, sharp edges, UV discontinuities or flipped normals',
    ),
});

type DecimateParams = z.infer<typeof schema>;

// ------------------------------------------------------------------ COLLAPSE (quadric error metric)

interface HeapEntry {
  cost: number;
  a: number;
  b: number;
  va: number;
  vb: number;
  x: number;
  y: number;
  z: number;
}

class MinHeap {
  private items: HeapEntry[] = [];
  get size(): number {
    return this.items.length;
  }
  push(e: HeapEntry): void {
    const it = this.items;
    it.push(e);
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (it[p].cost <= e.cost) break;
      it[i] = it[p];
      i = p;
    }
    it[i] = e;
  }
  pop(): HeapEntry | undefined {
    const it = this.items;
    if (!it.length) return undefined;
    const top = it[0];
    const last = it.pop()!;
    if (it.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        let mc = last.cost;
        if (l < it.length && it[l].cost < mc) {
          m = l;
          mc = it[l].cost;
        }
        if (r < it.length && it[r].cost < mc) m = r;
        if (m === i) break;
        it[i] = it[m];
        i = m;
      }
      it[i] = last;
    }
    return top;
  }
}

function addPlane(Q: Float64Array, v: number, a: number, b: number, c: number, d: number, w: number): void {
  const o = v * 10;
  Q[o] += w * a * a;
  Q[o + 1] += w * a * b;
  Q[o + 2] += w * a * c;
  Q[o + 3] += w * a * d;
  Q[o + 4] += w * b * b;
  Q[o + 5] += w * b * c;
  Q[o + 6] += w * b * d;
  Q[o + 7] += w * c * c;
  Q[o + 8] += w * c * d;
  Q[o + 9] += w * d * d;
}

function quadricError(q: ArrayLike<number>, x: number, y: number, z: number): number {
  return (
    q[0] * x * x +
    2 * q[1] * x * y +
    2 * q[2] * x * z +
    2 * q[3] * x +
    q[4] * y * y +
    2 * q[5] * y * z +
    2 * q[6] * y +
    q[7] * z * z +
    2 * q[8] * z +
    q[9]
  );
}

export function collapseDecimate(
  m: MeshData,
  ratio: number,
  opts: { triangulate?: boolean; symmetryAxis?: number | null } = {},
): MeshData {
  const nv = vertexCount(m);
  // --- triangulate (keeping per-corner UVs)
  const tri: number[] = [];
  const triFace: number[] = [];
  const triUV: number[] = [];
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const corners = triangulateFaceCorners(m, f);
    const uv = m.uvs ? m.uvs[f] : null;
    for (let t = 0; t < corners.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        tri.push(face[corners[t + k]]);
        triUV.push(uv ? (uv[corners[t + k] * 2] ?? 0) : 0, uv ? (uv[corners[t + k] * 2 + 1] ?? 0) : 0);
      }
      triFace.push(f);
    }
  }
  const T = triFace.length;
  const target = Math.max(0, Math.floor(T * ratio));
  const pos = Float64Array.from(m.positions);
  const colors = hasColors(m) ? Float64Array.from(m.colors!) : null;
  const aliveT = new Uint8Array(T).fill(1);
  const aliveV = new Uint8Array(nv).fill(1);
  const version = new Int32Array(nv);
  const vertTris: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) vertTris[tri[t * 3 + k]].push(t);
  // --- feature flags
  // undirected edge → number of triangles using it (numeric keys: min * nv + max)
  const ek = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const edgeUse = new Map<number, number>();
  for (let t = 0; t < T; t++)
    for (let k = 0; k < 3; k++) {
      const key = ek(tri[t * 3 + k], tri[t * 3 + ((k + 1) % 3)]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  const boundary = new Uint8Array(nv);
  for (const [key, c] of edgeUse) {
    if (c === 2) continue;
    boundary[Math.floor(key / nv)] = boundary[key % nv] = 1;
  }
  const locked = new Uint8Array(nv);
  const firstUV = new Float64Array(nv * 2).fill(NaN);
  const firstMat = new Int32Array(nv).fill(-1);
  for (let t = 0; t < T; t++) {
    const mat = m.faceMaterials[triFace[t]] ?? 0;
    for (let k = 0; k < 3; k++) {
      const v = tri[t * 3 + k];
      if (firstMat[v] < 0) firstMat[v] = mat;
      else if (firstMat[v] !== mat) locked[v] = 1;
      if (!m.uvs) continue;
      const u = triUV[(t * 3 + k) * 2];
      const w = triUV[(t * 3 + k) * 2 + 1];
      if (Number.isNaN(firstUV[v * 2])) {
        firstUV[v * 2] = u;
        firstUV[v * 2 + 1] = w;
      } else if (Math.abs(firstUV[v * 2] - u) > 1e-6 || Math.abs(firstUV[v * 2 + 1] - w) > 1e-6)
        locked[v] = 1;
    }
  }
  const sym = opts.symmetryAxis ?? null;
  let extent = 0;
  for (let i = 0; i < pos.length; i++) extent = Math.max(extent, Math.abs(pos[i]));
  const symEps = 1e-6 * Math.max(1, extent);
  const onPlane = new Uint8Array(nv);
  if (sym !== null) for (let v = 0; v < nv; v++) if (Math.abs(pos[v * 3 + sym]) <= symEps) onPlane[v] = 1;
  // --- quadrics
  const Q = new Float64Array(nv * 10);
  for (let t = 0; t < T; t++) {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3];
    const uy = pos[b * 3 + 1] - pos[a * 3 + 1];
    const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3];
    const vy = pos[c * 3 + 1] - pos[a * 3 + 1];
    const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-30) continue;
    const area = l / 2;
    nx /= l;
    ny /= l;
    nz /= l;
    const d = -(nx * pos[a * 3] + ny * pos[a * 3 + 1] + nz * pos[a * 3 + 2]);
    for (const v of [a, b, c]) addPlane(Q, v, nx, ny, nz, d, area);
    // boundary constraint planes (perpendicular to the face through boundary edges)
    for (let k = 0; k < 3; k++) {
      const p0 = tri[t * 3 + k];
      const p1 = tri[t * 3 + ((k + 1) % 3)];
      if (edgeUse.get(ek(p0, p1)) === 2) continue;
      const ex = pos[p1 * 3] - pos[p0 * 3];
      const ey = pos[p1 * 3 + 1] - pos[p0 * 3 + 1];
      const ez = pos[p1 * 3 + 2] - pos[p0 * 3 + 2];
      let px = ey * nz - ez * ny;
      let py = ez * nx - ex * nz;
      let pz = ex * ny - ey * nx;
      const pl = Math.hypot(px, py, pz);
      if (pl < 1e-30) continue;
      px /= pl;
      py /= pl;
      pz /= pl;
      const pd = -(px * pos[p0 * 3] + py * pos[p0 * 3 + 1] + pz * pos[p0 * 3 + 2]);
      const w = 100 * (ex * ex + ey * ey + ez * ez);
      addPlane(Q, p0, px, py, pz, pd, w);
      addPlane(Q, p1, px, py, pz, pd, w);
    }
  }
  const qsum = new Float64Array(10);
  const triHas = (t: number, v: number) => tri[t * 3] === v || tri[t * 3 + 1] === v || tri[t * 3 + 2] === v;
  const liveTris = (v: number) => vertTris[v].filter((t) => aliveT[t] && triHas(t, v));

  /** Decides which vertex survives (index order a, b) and where it goes; null when not allowed. */
  /** `rem` may be removed into `keep` without destroying seams, boundaries or the symmetry plane. */
  const canRemove = (keep: number, rem: number) =>
    !locked[rem] && (!boundary[rem] || boundary[keep]) && (!onPlane[rem] || onPlane[keep]);
  const plan = (a0: number, b0: number): HeapEntry | null => {
    if (boundary[a0] && boundary[b0] && edgeUse.get(ek(a0, b0)) === 2) return null;
    let a = a0;
    let b = b0;
    if (!canRemove(a0, b0)) {
      if (!canRemove(b0, a0)) return null;
      a = b0;
      b = a0;
    }
    for (let k = 0; k < 10; k++) qsum[k] = Q[a * 10 + k] + Q[b * 10 + k];
    let x: number;
    let y: number;
    let z: number;
    const fixedA = locked[a] || (boundary[a] && !boundary[b]) || (onPlane[a] && !onPlane[b]);
    if (fixedA) {
      x = pos[a * 3];
      y = pos[a * 3 + 1];
      z = pos[a * 3 + 2];
    } else {
      // candidates: both endpoints, the midpoint and the optimum of the summed quadric (3x3 solve)
      const ax = pos[a * 3];
      const ay = pos[a * 3 + 1];
      const az = pos[a * 3 + 2];
      const bx = pos[b * 3];
      const by = pos[b * 3 + 1];
      const bz = pos[b * 3 + 2];
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const mz = (az + bz) / 2;
      x = ax;
      y = ay;
      z = az;
      let bestE = quadricError(qsum, ax, ay, az);
      const consider = (cx: number, cy: number, cz: number) => {
        const err = quadricError(qsum, cx, cy, cz);
        if (err < bestE) {
          bestE = err;
          x = cx;
          y = cy;
          z = cz;
        }
      };
      consider(bx, by, bz);
      consider(mx, my, mz);
      const a11 = qsum[0];
      const a12 = qsum[1];
      const a13 = qsum[2];
      const b1 = qsum[3];
      const a22 = qsum[4];
      const a23 = qsum[5];
      const b2 = qsum[6];
      const a33 = qsum[7];
      const b3 = qsum[8];
      const det =
        a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
      const scale = Math.abs(a11) + Math.abs(a22) + Math.abs(a33);
      if (scale > 0 && Math.abs(det) > 1e-9 * scale * scale * scale) {
        const ox =
          (-b1 * (a22 * a33 - a23 * a23) + a12 * (b2 * a33 - a23 * b3) - a13 * (b2 * a23 - a22 * b3)) / det;
        const oy =
          (-a11 * (b2 * a33 - a23 * b3) + b1 * (a12 * a33 - a23 * a13) - a13 * (a12 * b3 - b2 * a13)) / det;
        const oz =
          (-a11 * (a22 * b3 - b2 * a23) + a12 * (a12 * b3 - b2 * a13) - b1 * (a12 * a23 - a22 * a13)) / det;
        const len = Math.hypot(ax - bx, ay - by, az - bz);
        if (Math.hypot(ox - mx, oy - my, oz - mz) <= len * 2) consider(ox, oy, oz);
      }
      if (sym !== null && onPlane[a] && onPlane[b]) {
        if (sym === 0) x = 0;
        else if (sym === 1) y = 0;
        else z = 0;
      }
    }
    const cost = Math.max(0, quadricError(qsum, x, y, z));
    return { cost, a, b, va: version[a], vb: version[b], x, y, z };
  };

  const heap = new MinHeap();
  for (const key of edgeUse.keys()) {
    const e = plan(Math.floor(key / nv), key % nv);
    if (e) heap.push(e);
  }
  let live = T;
  const cp = new Float64Array(9);
  /** False when moving vertex `moving` of triangle t to (x, y, z) flips or degenerates it. */
  const keepsOrientation = (t: number, moving: number, x: number, y: number, z: number): boolean => {
    for (let k = 0; k < 3; k++) {
      const v = tri[t * 3 + k];
      cp[k * 3] = pos[v * 3];
      cp[k * 3 + 1] = pos[v * 3 + 1];
      cp[k * 3 + 2] = pos[v * 3 + 2];
    }
    const n0x = (cp[4] - cp[1]) * (cp[8] - cp[2]) - (cp[5] - cp[2]) * (cp[7] - cp[1]);
    const n0y = (cp[5] - cp[2]) * (cp[6] - cp[0]) - (cp[3] - cp[0]) * (cp[8] - cp[2]);
    const n0z = (cp[3] - cp[0]) * (cp[7] - cp[1]) - (cp[4] - cp[1]) * (cp[6] - cp[0]);
    for (let k = 0; k < 3; k++) {
      if (tri[t * 3 + k] !== moving) continue;
      cp[k * 3] = x;
      cp[k * 3 + 1] = y;
      cp[k * 3 + 2] = z;
    }
    const n1x = (cp[4] - cp[1]) * (cp[8] - cp[2]) - (cp[5] - cp[2]) * (cp[7] - cp[1]);
    const n1y = (cp[5] - cp[2]) * (cp[6] - cp[0]) - (cp[3] - cp[0]) * (cp[8] - cp[2]);
    const n1z = (cp[3] - cp[0]) * (cp[7] - cp[1]) - (cp[4] - cp[1]) * (cp[6] - cp[0]);
    const l0 = Math.hypot(n0x, n0y, n0z);
    const l1 = Math.hypot(n1x, n1y, n1z);
    if (l1 < 1e-12 * Math.max(1, l0)) return false;
    // reject flips and large rotations (> 60°), which also prevents collapsing volumes flat
    return (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1 || 1) >= 0.5;
  };
  // scratch marks for neighbourhood queries
  const markA = new Int32Array(nv);
  const count = new Int32Array(nv);
  let stamp = 0;
  while (live > target && heap.size) {
    const e = heap.pop()!;
    const { a, b } = e;
    if (!aliveV[a] || !aliveV[b] || version[a] !== e.va || version[b] !== e.vb) continue;
    const trisA = liveTris(a);
    const trisB = liveTris(b);
    const shared = trisA.filter((t) => triHas(t, b));
    if (!shared.length) continue;
    // link condition: the only common neighbours are the opposite corners of the shared triangles
    stamp++;
    for (const t of trisA) for (let k = 0; k < 3; k++) markA[tri[t * 3 + k]] = stamp;
    stamp++;
    let common = 0;
    for (const t of trisB) {
      for (let k = 0; k < 3; k++) {
        const v = tri[t * 3 + k];
        if (v === a || v === b || markA[v] !== stamp - 1) continue;
        markA[v] = stamp; // count each common neighbour once
        common++;
      }
    }
    if (common !== shared.length) continue;
    // edge part of the link condition: triangles (a, u, w) and (b, u, w) must not both exist, otherwise they
    // would coincide after the collapse (e.g. collapsing a tetrahedron into a flat double-sided triangle)
    const opposite = new Set<number>();
    for (const t of trisA) {
      if (triHas(t, b)) continue;
      const u = tri[t * 3] === a ? tri[t * 3 + 1] : tri[t * 3];
      const w = tri[t * 3 + 2] === a ? tri[t * 3 + 1] : tri[t * 3 + 2];
      opposite.add(ek(u, w));
    }
    let pinch = false;
    for (const t of trisB) {
      if (pinch || triHas(t, a)) continue;
      const u = tri[t * 3] === b ? tri[t * 3 + 1] : tri[t * 3];
      const w = tri[t * 3 + 2] === b ? tri[t * 3 + 1] : tri[t * 3 + 2];
      pinch = opposite.has(ek(u, w));
    }
    if (pinch) continue;
    // reject collapses that flip or degenerate triangles
    let ok = true;
    for (const t of trisA) if (ok && !triHas(t, b)) ok = keepsOrientation(t, a, e.x, e.y, e.z);
    for (const t of trisB) if (ok && !triHas(t, a)) ok = keepsOrientation(t, b, e.x, e.y, e.z);
    if (!ok) continue;
    // reject fold-overs: two surviving triangles sharing an edge at the new vertex must not end up back to back
    const edgeNormals = new Map<number, number[]>();
    for (const list of [trisA, trisB]) {
      for (const t of list) {
        if (triHas(t, a) && triHas(t, b)) continue;
        for (let k = 0; k < 3; k++) {
          const v = tri[t * 3 + k];
          const vx = v === a || v === b ? e.x : pos[v * 3];
          const vy = v === a || v === b ? e.y : pos[v * 3 + 1];
          const vz = v === a || v === b ? e.z : pos[v * 3 + 2];
          cp[k * 3] = vx;
          cp[k * 3 + 1] = vy;
          cp[k * 3 + 2] = vz;
        }
        const nx = (cp[4] - cp[1]) * (cp[8] - cp[2]) - (cp[5] - cp[2]) * (cp[7] - cp[1]);
        const ny = (cp[5] - cp[2]) * (cp[6] - cp[0]) - (cp[3] - cp[0]) * (cp[8] - cp[2]);
        const nz = (cp[3] - cp[0]) * (cp[7] - cp[1]) - (cp[4] - cp[1]) * (cp[6] - cp[0]);
        const l = Math.hypot(nx, ny, nz) || 1;
        for (let k = 0; k < 3; k++) {
          const v = tri[t * 3 + k];
          if (v === a || v === b) continue;
          const prev = edgeNormals.get(v);
          if (prev && (prev[0] * nx + prev[1] * ny + prev[2] * nz) / l < -0.95) ok = false;
          else if (!prev) edgeNormals.set(v, [nx / l, ny / l, nz / l]);
        }
      }
    }
    if (!ok) continue;
    // --- perform the collapse b → a
    const pa = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
    const pb = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]];
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const dz = pb[2] - pa[2];
    const dl = dx * dx + dy * dy + dz * dz;
    const s =
      dl > 0
        ? Math.max(0, Math.min(1, ((e.x - pa[0]) * dx + (e.y - pa[1]) * dy + (e.z - pa[2]) * dz) / dl))
        : 0;
    // corner UV of `a` on the side of the shared edge (used when `a` is a seam vertex)
    const wedge = (() => {
      const t = shared[0];
      for (let k = 0; k < 3; k++)
        if (tri[t * 3 + k] === a) return [triUV[(t * 3 + k) * 2], triUV[(t * 3 + k) * 2 + 1]];
      return [0, 0];
    })();
    const cornerUV = (t: number, v: number) => {
      for (let k = 0; k < 3; k++) if (tri[t * 3 + k] === v) return [(t * 3 + k) * 2, (t * 3 + k) * 2 + 1];
      return null;
    };
    const uvA = cornerUV(shared[0], a)!;
    const uvB = cornerUV(shared[0], b)!;
    const lerpUV = [
      triUV[uvA[0]] + (triUV[uvB[0]] - triUV[uvA[0]]) * s,
      triUV[uvA[1]] + (triUV[uvB[1]] - triUV[uvA[1]]) * s,
    ];
    for (const t of shared) {
      aliveT[t] = 0;
      live--;
    }
    const merged: number[] = [];
    for (const t of trisB) {
      if (!aliveT[t]) continue;
      for (let k = 0; k < 3; k++) {
        if (tri[t * 3 + k] !== b) continue;
        tri[t * 3 + k] = a;
        if (locked[a]) {
          triUV[(t * 3 + k) * 2] = wedge[0];
          triUV[(t * 3 + k) * 2 + 1] = wedge[1];
        }
      }
      merged.push(t);
    }
    const survivors = trisA.filter((t) => aliveT[t]).concat(merged);
    if (!locked[a] && !locked[b] && m.uvs) {
      for (const t of survivors) {
        const c = cornerUV(t, a);
        if (c) {
          triUV[c[0]] = lerpUV[0];
          triUV[c[1]] = lerpUV[1];
        }
      }
    }
    if (colors && !locked[a])
      for (let k = 0; k < 4; k++) colors[a * 4 + k] += (colors[b * 4 + k] - colors[a * 4 + k]) * s;
    pos[a * 3] = e.x;
    pos[a * 3 + 1] = e.y;
    pos[a * 3 + 2] = e.z;
    for (let k = 0; k < 10; k++) Q[a * 10 + k] += Q[b * 10 + k];
    aliveV[b] = 0;
    version[a]++;
    boundary[a] |= boundary[b];
    locked[a] |= locked[b];
    onPlane[a] |= onPlane[b];
    vertTris[a] = survivors;
    vertTris[b] = [];
    // refresh edge use counts around the kept vertex and requeue its edges
    const around: number[] = [];
    for (const t of survivors) {
      for (let k = 0; k < 3; k++) {
        const w = tri[t * 3 + k];
        if (w === a) continue;
        if (count[w] === 0) around.push(w);
        count[w]++;
      }
    }
    for (const w of around) {
      edgeUse.set(ek(a, w), count[w]);
      count[w] = 0;
    }
    for (const w of around) {
      const next = plan(a, w);
      if (next) heap.push(next);
    }
  }
  // --- output
  const remap = new Int32Array(nv).fill(-1);
  const usedV = new Uint8Array(nv);
  for (let t = 0; t < T; t++) if (aliveT[t]) for (let k = 0; k < 3; k++) usedV[tri[t * 3 + k]] = 1;
  const facesBefore = new Uint8Array(nv);
  for (const f of m.faces) for (const v of f) facesBefore[v] = 1;
  let next = 0;
  for (let v = 0; v < nv; v++) if (aliveV[v] && (usedV[v] || !facesBefore[v])) remap[v] = next++;
  const positions = new Array<number>(next * 3);
  const outColors = colors ? new Array<number>(next * 4) : null;
  for (let v = 0; v < nv; v++) {
    const j = remap[v];
    if (j < 0) continue;
    for (let k = 0; k < 3; k++) positions[j * 3 + k] = pos[v * 3 + k];
    if (outColors && colors) for (let k = 0; k < 4; k++) outColors[j * 4 + k] = colors[v * 4 + k];
  }
  const faces: number[][] = [];
  const faceMaterials: number[] = [];
  const faceSmooth: boolean[] = [];
  const uvs: number[][] | null = m.uvs ? [] : null;
  const srcFace: number[] = [];
  for (let t = 0; t < T; t++) {
    if (!aliveT[t]) continue;
    faces.push([remap[tri[t * 3]], remap[tri[t * 3 + 1]], remap[tri[t * 3 + 2]]]);
    faceMaterials.push(m.faceMaterials[triFace[t]] ?? 0);
    faceSmooth.push(m.faceSmooth[triFace[t]] ?? false);
    srcFace.push(triFace[t]);
    if (uvs) uvs.push(triUV.slice(t * 6, t * 6 + 6));
  }
  const looseEdges: number[] = [];
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
    const a = remap[m.looseEdges[i]];
    const b = remap[m.looseEdges[i + 1]];
    if (a >= 0 && b >= 0 && a !== b) looseEdges.push(a, b);
  }
  let out: MeshData = {
    positions,
    faces,
    faceMaterials,
    faceSmooth,
    uvs,
    colors: outColors,
    edgeAttrs: {},
    looseEdges,
  };
  if (!opts.triangulate) out = joinTriangles(out, srcFace);
  // keep attributes of edges that survived unchanged
  const edges = new Set<string>();
  for (const f of out.faces)
    for (let i = 0; i < f.length; i++) edges.add(edgeKey(f[i], f[(i + 1) % f.length]));
  for (let i = 0; i + 1 < looseEdges.length; i += 2) edges.add(edgeKey(looseEdges[i], looseEdges[i + 1]));
  const edgeAttrs: Record<string, EdgeAttr> = {};
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    if (a >= nv || b >= nv || remap[a] < 0 || remap[b] < 0) continue;
    const nk = edgeKey(remap[a], remap[b]);
    const c = cleanEdgeAttr(m.edgeAttrs[k]);
    if (c && edges.has(nk)) edgeAttrs[nk] = c;
  }
  out.edgeAttrs = edgeAttrs;
  return out;
}

/** Joins pairs of triangles that came from the same source face into planar convex quads. */
function joinTriangles(m: MeshData, srcFace: number[]): MeshData {
  const fn = faceNormalsOf(m);
  const P = m.positions;
  const directed = new Map<string, number>();
  m.faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) directed.set(`${f[k]},${f[(k + 1) % 3]}`, i);
  });
  const taken = new Uint8Array(m.faces.length);
  const faces: number[][] = [];
  const faceMaterials: number[] = [];
  const faceSmooth: boolean[] = [];
  const uvs: number[][] | null = m.uvs ? [] : null;
  const convex = (q: number[], nx: number, ny: number, nz: number) => {
    for (let i = 0; i < 4; i++) {
      const a = q[i] * 3;
      const b = q[(i + 1) % 4] * 3;
      const c = q[(i + 2) % 4] * 3;
      const ux = P[b] - P[a];
      const uy = P[b + 1] - P[a + 1];
      const uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[b];
      const vy = P[c + 1] - P[b + 1];
      const vz = P[c + 2] - P[b + 2];
      if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz <= 0) return false;
    }
    return true;
  };
  for (let t = 0; t < m.faces.length; t++) {
    if (taken[t]) continue;
    const f = m.faces[t];
    let joined = false;
    for (let k = 0; k < 3 && !joined; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const u = directed.get(`${b},${a}`);
      if (u === undefined || u === t || taken[u] || srcFace[u] !== srcFace[t]) continue;
      if (fn[t * 3] * fn[u * 3] + fn[t * 3 + 1] * fn[u * 3 + 1] + fn[t * 3 + 2] * fn[u * 3 + 2] < 0.999)
        continue;
      const g = m.faces[u];
      const d = g.find((v) => v !== a && v !== b)!;
      const c = f[(k + 2) % 3];
      const quad = [b, c, a, d];
      if (!convex(quad, fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2])) continue;
      taken[t] = taken[u] = 1;
      faces.push(quad);
      faceMaterials.push(m.faceMaterials[t]);
      faceSmooth.push(m.faceSmooth[t]);
      if (uvs && m.uvs) {
        const uvOf = (face: number, v: number) => {
          const i = m.faces[face].indexOf(v);
          return [m.uvs![face][i * 2], m.uvs![face][i * 2 + 1]];
        };
        uvs.push([...uvOf(t, b), ...uvOf(t, c), ...uvOf(t, a), ...uvOf(u, d)]);
      }
      joined = true;
    }
    if (!joined) {
      taken[t] = 1;
      faces.push(f.slice());
      faceMaterials.push(m.faceMaterials[t]);
      faceSmooth.push(m.faceSmooth[t]);
      if (uvs && m.uvs) uvs.push(m.uvs[t].slice());
    }
  }
  return { ...m, faces, faceMaterials, faceSmooth, uvs };
}

// ------------------------------------------------------------------ DISSOLVE (planar)

export function planarDissolve(m: MeshData, angleLimit: number, delimit: ReadonlySet<string>): MeshData {
  const topo = buildTopology(m);
  const fn = faceNormalsOf(m);
  const nf = m.faces.length;
  const regionN = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const face = m.faces[f];
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let i = 0; i < face.length; i++) {
      const a = face[i] * 3;
      const b = face[(i + 1) % face.length] * 3;
      const p = m.positions;
      ax += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
      ay += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
      az += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
    }
    regionN[f * 3] = ax;
    regionN[f * 3 + 1] = ay;
    regionN[f * 3 + 2] = az;
  }
  const cosLimit = Math.cos(angleLimit);
  const pairs: { f: number; g: number; c: number }[] = [];
  for (let e = 0; e < topo.edges.length; e++) {
    const faces = topo.edgeFaces[e];
    if (faces.length !== 2) continue;
    const [f, g] = faces;
    const c = fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2];
    if (c < cosLimit - 1e-12) continue;
    if (delimit.has('MATERIAL') && m.faceMaterials[f] !== m.faceMaterials[g]) continue;
    const attr = m.edgeAttrs[edgeKey(topo.edges[e][0], topo.edges[e][1])];
    if (delimit.has('SEAM') && attr?.seam) continue;
    if (delimit.has('SHARP') && attr?.sharp) continue;
    if (delimit.has('NORMAL') && c <= 0) continue;
    pairs.push({ f, g, c });
  }
  pairs.sort((p, q) => q.c - p.c);
  const merged = mergeFaceRegions(
    m,
    pairs.map((p) => [p.f, p.g] as [number, number]),
    {
      uvTolerance: delimit.has('UV') ? 1e-5 : -1,
      canMerge: (ra, rb) => {
        const ax = regionN[ra * 3];
        const ay = regionN[ra * 3 + 1];
        const az = regionN[ra * 3 + 2];
        const bx = regionN[rb * 3];
        const by = regionN[rb * 3 + 1];
        const bz = regionN[rb * 3 + 2];
        const l = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
        return l > 0 && (ax * bx + ay * by + az * bz) / l >= cosLimit - 1e-12;
      },
      onMerge: (root, other) => {
        for (let k = 0; k < 3; k++) regionN[root * 3 + k] += regionN[other * 3 + k];
      },
    },
  );
  return dissolveStraightVertices(merged, angleLimit);
}

// ------------------------------------------------------------------ UNSUBDIV

/** Reverts one level of quad-grid subdivision, or returns null when the topology does not allow it. */
export function unsubdivideOnce(m: MeshData): MeshData | null {
  if (m.faces.length === 0 || m.faces.some((f) => f.length !== 4)) return null;
  const topo = buildTopology(m);
  const nv = vertexCount(m);
  // 2-colour the vertex graph
  const color = new Int8Array(nv).fill(-1);
  for (let s = 0; s < nv; s++) {
    if (color[s] >= 0 || topo.vertEdges[s].length === 0) continue;
    color[s] = 0;
    const stack = [s];
    while (stack.length) {
      const v = stack.pop()!;
      for (const e of topo.vertEdges[v]) {
        const w = topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0];
        if (color[w] < 0) {
          color[w] = 1 - color[v];
          stack.push(w);
        } else if (color[w] === color[v]) return null;
      }
    }
  }
  const directed = new Map<string, number>();
  m.faces.forEach((f, i) => {
    for (let k = 0; k < 4; k++) directed.set(`${f[k]},${f[(k + 1) % 4]}`, i);
  });
  let best: {
    faces: number[][];
    srcQuad: number[];
    corners: number[][];
    vset: Uint8Array;
    score: number;
  } | null = null;
  for (const cls of [0, 1]) {
    // diagonal graph between class `cls` corners of each quad, 2-coloured into V (0) and F (1)
    const diag: number[][] = Array.from({ length: nv }, () => []);
    for (const f of m.faces) {
      const k = color[f[0]] === cls ? 0 : 1;
      diag[f[k]].push(f[k + 2]);
      diag[f[k + 2]].push(f[k]);
    }
    const dc = new Int8Array(nv).fill(-1);
    let ok = true;
    for (let s = 0; s < nv && ok; s++) {
      if (color[s] !== cls || dc[s] >= 0 || diag[s].length === 0) continue;
      dc[s] = 0;
      const stack = [s];
      while (stack.length && ok) {
        const v = stack.pop()!;
        for (const w of diag[v]) {
          if (dc[w] < 0) {
            dc[w] = 1 - dc[v];
            stack.push(w);
          } else if (dc[w] === dc[v]) ok = false;
        }
      }
    }
    if (!ok) continue;
    for (const fColor of [0, 1]) {
      const isF = (v: number) => color[v] === cls && dc[v] === fColor;
      const faces: number[][] = [];
      const srcQuad: number[] = [];
      const corners: number[][] = [];
      let valid = true;
      let irregular = 0;
      const vset = new Uint8Array(nv);
      for (let v = 0; v < nv && valid; v++) {
        if (!isF(v)) continue;
        const ring: number[] = [];
        const ringQuads: number[] = [];
        const ringCorner: number[] = [];
        const start = topo.vertFaces[v][0];
        let q = start;
        let guard = 0;
        do {
          const f = m.faces[q];
          const i = f.indexOf(v);
          ring.push(f[(i + 2) % 4]);
          ringQuads.push(q);
          ringCorner.push((i + 2) % 4);
          const next = directed.get(`${f[(i + 1) % 4]},${v}`);
          if (next === undefined) {
            valid = false;
            break;
          }
          q = next;
        } while (q !== start && guard++ < 64);
        if (!valid || q !== start || ring.length < 3) {
          valid = false;
          break;
        }
        if (ring.length !== 4) irregular++;
        ring.reverse();
        ringQuads.reverse();
        ringCorner.reverse();
        faces.push(ring);
        srcQuad.push(ringQuads[0]);
        corners.push(ringQuads.map((qq, k) => qq * 4 + ringCorner[k]));
        for (const r of ring) vset[r] = 1;
      }
      if (!valid || faces.length === 0) continue;
      // every quad must belong to exactly one new face
      const count = faces.reduce((s, f) => s + f.length, 0);
      if (count !== m.faces.length) continue;
      let vCount = 0;
      for (let v = 0; v < nv; v++) if (vset[v]) vCount++;
      const score = irregular * 1000 - vCount;
      if (!best || score < best.score) best = { faces, srcQuad, corners, vset, score };
    }
  }
  if (!best) return null;
  const remap = new Int32Array(nv).fill(-1);
  let next = 0;
  for (let v = 0; v < nv; v++) if (best.vset[v]) remap[v] = next++;
  const positions = new Array<number>(next * 3);
  const colors = hasColors(m) ? new Array<number>(next * 4) : null;
  for (let v = 0; v < nv; v++) {
    const j = remap[v];
    if (j < 0) continue;
    for (let k = 0; k < 3; k++) positions[j * 3 + k] = m.positions[v * 3 + k];
    if (colors) for (let k = 0; k < 4; k++) colors[j * 4 + k] = m.colors![v * 4 + k];
  }
  return {
    positions,
    colors,
    faces: best.faces.map((f) => f.map((v) => remap[v])),
    faceMaterials: best.srcQuad.map((q) => m.faceMaterials[q] ?? 0),
    faceSmooth: best.srcQuad.map((q) => m.faceSmooth[q] ?? false),
    uvs: m.uvs
      ? best.corners.map((cs) =>
          cs.flatMap((c) => [
            m.uvs![Math.floor(c / 4)][(c % 4) * 2],
            m.uvs![Math.floor(c / 4)][(c % 4) * 2 + 1],
          ]),
        )
      : null,
    edgeAttrs: {},
    looseEdges: [],
  };
}

export const decimateModifier: ModifierDef<typeof schema> = {
  type: 'DECIMATE',
  label: 'Decimate',
  category: 'GENERATE',
  description:
    'Reduces the polygon count. COLLAPSE: quadric-error edge collapses on a triangulated copy until `ratio` of the ' +
    'triangles remain (boundaries, UV seams and material borders are preserved; quads are rejoined unless ' +
    '`use_collapse_triangulate`). DISSOLVE: merges neighbouring faces within `angle_limit` into n-gons and removes ' +
    'redundant vertices on straight edges (planar decimation). UNSUBDIV: reverts grid subdivision `iterations` times ' +
    '(quad meshes only; otherwise no change).',
  schema,
  apply(mesh, p: DecimateParams) {
    if (mesh.faces.length === 0) return mesh;
    if (p.decimate_type === 'COLLAPSE') {
      if (p.ratio >= 1) return mesh;
      return collapseDecimate(mesh, p.ratio, {
        triangulate: p.use_collapse_triangulate,
        symmetryAxis: p.use_symmetry ? axisIndex(p.symmetry_axis) : null,
      });
    }
    if (p.decimate_type === 'DISSOLVE') return planarDissolve(mesh, p.angle_limit, new Set(p.delimit));
    let cur = mesh;
    for (let i = 0; i < p.iterations; i++) {
      const next = unsubdivideOnce(cur);
      if (!next) break;
      cur = next;
    }
    return cur;
  },
};
