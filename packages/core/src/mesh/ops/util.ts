import type { Vec3 } from '../../math/types';
import type { EdgeAttr, MeshData } from '../types';
import { addVertex, edgeKey, parseEdgeKey, vertexCount } from '../types';
import type { MeshSelection } from '../selection';
import { emptySelection } from '../selection';
import type { Topology } from '../topology';

/*
 * Shared helpers for the edit-mode mesh operations. Everything here works on plain MeshData and
 * plain arrays; operations clone their input mesh first and then use these helpers to rebuild it.
 */

/** Numeric key of the directed edge a→b (valid for meshes with fewer than 2^26 vertices). */
export function dkey(a: number, b: number): number {
  return a * 67108864 + b;
}

export function vpos(m: MeshData, v: number): Vec3 {
  const p = m.positions;
  return [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
}

export function setVpos(m: MeshData, v: number, p: Readonly<Vec3>): void {
  m.positions[v * 3] = p[0];
  m.positions[v * 3 + 1] = p[1];
  m.positions[v * 3 + 2] = p[2];
}

/**
 * Appends a vertex at `p` whose color (if the mesh has vertex colors) is the weighted blend of the
 * colors of `src` vertices. Returns the new vertex index.
 */
export function addVertexFrom(
  m: MeshData,
  p: Readonly<Vec3>,
  src: readonly number[],
  weights?: readonly number[],
): number {
  if (!m.colors) return addVertex(m, p);
  const c = [0, 0, 0, 0];
  let tw = 0;
  for (let k = 0; k < src.length; k++) {
    const w = weights ? weights[k] : 1;
    if (!w) continue;
    tw += w;
    for (let i = 0; i < 4; i++) c[i] += (m.colors[src[k] * 4 + i] ?? 1) * w;
  }
  if (Math.abs(tw) < 1e-12) return addVertex(m, p);
  return addVertex(
    m,
    p,
    c.map((x) => x / tw),
  );
}

// ---------------------------------------------------------------------------------- face records

/** A face with its per-face attributes, used while rebuilding the face list of a mesh. */
export interface FaceRec {
  v: number[];
  mat: number;
  smooth: boolean;
  /** Per-corner UVs aligned with `v` (null when the mesh has no UV layer). */
  uv: number[] | null;
  /** Marks faces that should be selected after the operation. */
  sel?: boolean;
}

export function faceRec(m: MeshData, f: number): FaceRec {
  const v = m.faces[f].slice();
  let uv: number[] | null = null;
  if (m.uvs) {
    const src = m.uvs[f];
    uv = src && src.length === v.length * 2 ? src.slice() : new Array<number>(v.length * 2).fill(0);
  }
  return { v, mat: m.faceMaterials[f] ?? 0, smooth: m.faceSmooth[f] ?? false, uv };
}

export function allFaceRecs(m: MeshData): FaceRec[] {
  return m.faces.map((_, f) => faceRec(m, f));
}

/**
 * Creates a face record that copies material/smooth flags from `like`. `uv` must be aligned with
 * `v`; it is ignored (null) when the mesh has no UV layer and zero-filled when missing.
 */
export function makeFace(
  m: MeshData,
  v: number[],
  like: Pick<FaceRec, 'mat' | 'smooth'> | null,
  uv?: number[] | null,
  sel = false,
): FaceRec {
  return {
    v,
    mat: like?.mat ?? 0,
    smooth: like?.smooth ?? false,
    uv: m.uvs ? (uv && uv.length === v.length * 2 ? uv : new Array<number>(v.length * 2).fill(0)) : null,
    sel,
  };
}

/** Replaces all faces (and per-face attributes) of `m`. Returns the indices of faces marked `sel`. */
export function writeFaces(m: MeshData, recs: FaceRec[]): number[] {
  const selected: number[] = [];
  m.faces = recs.map((r) => r.v);
  m.faceMaterials = recs.map((r) => r.mat);
  m.faceSmooth = recs.map((r) => r.smooth);
  if (m.uvs)
    m.uvs = recs.map((r) =>
      r.uv && r.uv.length === r.v.length * 2 ? r.uv : new Array<number>(r.v.length * 2).fill(0),
    );
  recs.forEach((r, i) => {
    if (r.sel) selected.push(i);
  });
  return selected;
}

export function uvOf(rec: FaceRec, i: number): [number, number] {
  if (!rec.uv) return [0, 0];
  return [rec.uv[i * 2], rec.uv[i * 2 + 1]];
}

export function lerpUV(a: readonly number[], b: readonly number[], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Reverses a face record in place (winding and aligned UVs). */
export function reverseFace(rec: FaceRec): FaceRec {
  rec.v.reverse();
  if (rec.uv) rec.uv = reverseUVPairs(rec.uv);
  return rec;
}

export function reverseUVPairs(uv: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = uv.length - 2; i >= 0; i -= 2) out.push(uv[i], uv[i + 1]);
  return out;
}

// ---------------------------------------------------------------------------------- selection

/**
 * Completes a selection "downwards": selected faces imply their edges and vertices, selected
 * edges imply their vertices. Out-of-range indices and edges that do not exist are dropped.
 */
export function completeSelection(m: MeshData, sel: MeshSelection, topo?: Topology): MeshSelection {
  const nv = vertexCount(m);
  const out = emptySelection();
  for (const v of sel.verts) if (v >= 0 && v < nv) out.verts.add(v);
  for (const k of sel.edges) {
    if (topo && !topo.edgeIndex.has(k)) continue;
    const [a, b] = parseEdgeKey(k);
    if (!(a >= 0 && a < nv && b >= 0 && b < nv) || a === b) continue;
    out.edges.add(k);
    out.verts.add(a);
    out.verts.add(b);
  }
  for (const f of sel.faces) {
    const face = m.faces[f];
    if (!face) continue;
    out.faces.add(f);
    for (let i = 0; i < face.length; i++) {
      out.verts.add(face[i]);
      out.edges.add(edgeKey(face[i], face[(i + 1) % face.length]));
    }
  }
  return out;
}

/** Sorted list of valid selected face indices. */
export function selectedFaceList(m: MeshData, sel: MeshSelection): number[] {
  return [...sel.faces].filter((f) => f >= 0 && f < m.faces.length).sort((a, b) => a - b);
}

/** Indices (into `topo.edges`) of selected edges, in topology order. */
export function selectedEdgeList(topo: Topology, sel: MeshSelection): number[] {
  const out: number[] = [];
  for (let e = 0; e < topo.edges.length; e++) {
    const [a, b] = topo.edges[e];
    if (sel.edges.has(edgeKey(a, b))) out.push(e);
  }
  return out;
}

/** Applies a vertex remap (old → new, -1 = removed) to a selection. */
export function remapSelection(m: MeshData, sel: MeshSelection, remap: ArrayLike<number>): MeshSelection {
  const out = emptySelection();
  for (const v of sel.verts) {
    const r = remap[v];
    if (r !== undefined && r >= 0) out.verts.add(r);
  }
  for (const k of sel.edges) {
    const [a, b] = parseEdgeKey(k);
    const ra = remap[a];
    const rb = remap[b];
    if (ra !== undefined && rb !== undefined && ra >= 0 && rb >= 0 && ra !== rb)
      out.edges.add(edgeKey(ra, rb));
  }
  for (const f of sel.faces) if (f < m.faces.length) out.faces.add(f);
  return out;
}

// ---------------------------------------------------------------------------------- vertices

/**
 * Removes the vertices flagged in `remove` (faces must no longer reference them; loose edges that
 * do are dropped). Remaps faces, loose edges, colors and edge attributes. Returns old → new map.
 */
export function removeVertices(m: MeshData, remove: Uint8Array): Int32Array {
  const n = vertexCount(m);
  const remap = new Int32Array(n);
  let next = 0;
  for (let i = 0; i < n; i++) remap[i] = remove[i] ? -1 : next++;
  if (next === n) return remap;
  const pos = new Array<number>(next * 3);
  const col = m.colors ? new Array<number>(next * 4) : null;
  for (let i = 0; i < n; i++) {
    const j = remap[i];
    if (j < 0) continue;
    pos[j * 3] = m.positions[i * 3];
    pos[j * 3 + 1] = m.positions[i * 3 + 1];
    pos[j * 3 + 2] = m.positions[i * 3 + 2];
    if (col && m.colors) for (let k = 0; k < 4; k++) col[j * 4 + k] = m.colors[i * 4 + k] ?? 1;
  }
  m.positions = pos;
  if (col) m.colors = col;
  m.faces = m.faces.map((f) => f.map((v) => remap[v]));
  const loose: number[] = [];
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
    const a = remap[m.looseEdges[i]];
    const b = remap[m.looseEdges[i + 1]];
    if (a >= 0 && b >= 0 && a !== b) loose.push(a, b);
  }
  m.looseEdges = loose;
  const attrs: Record<string, EdgeAttr> = {};
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    const ra = remap[a];
    const rb = remap[b];
    if (ra >= 0 && rb >= 0 && ra !== rb) attrs[edgeKey(ra, rb)] = m.edgeAttrs[k];
  }
  m.edgeAttrs = attrs;
  return remap;
}

/** Marks which vertices are referenced by faces or loose edges. */
export function usedVertices(m: MeshData): Uint8Array {
  const used = new Uint8Array(vertexCount(m));
  for (const f of m.faces) for (const v of f) used[v] = 1;
  for (const v of m.looseEdges) used[v] = 1;
  return used;
}

/** Removes those `candidates` that are no longer used by any face or loose edge. */
export function removeUnusedAmong(m: MeshData, candidates: Iterable<number>): Int32Array {
  const used = usedVertices(m);
  const remove = new Uint8Array(vertexCount(m));
  for (const v of candidates) if (v >= 0 && v < remove.length && !used[v]) remove[v] = 1;
  return removeVertices(m, remove);
}

// ---------------------------------------------------------------------------------- topology

/** Directed edge (a→b) → index of the (first) face traversing it. */
export function directedEdgeFaces(m: MeshData): Map<number, number> {
  const map = new Map<number, number>();
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    for (let i = 0; i < face.length; i++) {
      const k = dkey(face[i], face[(i + 1) % face.length]);
      if (!map.has(k)) map.set(k, f);
    }
  }
  return map;
}

/** Faces around a vertex in rotational order (each face's outgoing edge is the next face's incoming). */
export interface VertexFan {
  faces: number[];
  /** Corner index of the vertex inside each face. */
  corners: number[];
  /** True when the fan wraps around (interior vertex), false for boundary vertices. */
  closed: boolean;
}

/** Orders the faces around `v`. Returns null for non-manifold vertices (several fans, bad winding). */
export function vertexFan(
  m: MeshData,
  v: number,
  vertFaces: readonly number[],
  dmap: Map<number, number>,
): VertexFan | null {
  if (vertFaces.length === 0) return null;
  const cornerOf = (f: number): number => m.faces[f].indexOf(v);
  const nextOf = (f: number): number => {
    const face = m.faces[f];
    return face[(cornerOf(f) + 1) % face.length];
  };
  const prevOf = (f: number): number => {
    const face = m.faces[f];
    return face[(cornerOf(f) + face.length - 1) % face.length];
  };
  const start = vertFaces[0];
  const forward: number[] = [start];
  const seen = new Set<number>([start]);
  let closed = false;
  let f = start;
  for (;;) {
    const g = dmap.get(dkey(nextOf(f), v));
    if (g === undefined) break;
    if (g === start) {
      closed = true;
      break;
    }
    if (seen.has(g)) return null;
    seen.add(g);
    forward.push(g);
    f = g;
  }
  const backward: number[] = [];
  if (!closed) {
    f = start;
    for (;;) {
      const g = dmap.get(dkey(v, prevOf(f)));
      if (g === undefined) break;
      if (seen.has(g)) return null;
      seen.add(g);
      backward.push(g);
      f = g;
    }
  }
  const faces = [...backward.reverse(), ...forward];
  if (faces.length !== vertFaces.length) return null;
  return { faces, corners: faces.map(cornerOf), closed };
}

export class UnionFind {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    let r = a;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[a] !== r) {
      const n = this.parent[a];
      this.parent[a] = r;
      a = n;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

// ---------------------------------------------------------------------------------- geometry

/** Newell normal (unnormalized) of a polygon given by points. */
export function polygonNormal(pts: readonly Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

export function centroid(pts: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = pts.length || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** Two unit vectors spanning the plane perpendicular to the unit vector `n`. */
export function planeBasis(n: Readonly<Vec3>): [Vec3, Vec3] {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const o: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  let t: Vec3 = [n[1] * o[2] - n[2] * o[1], n[2] * o[0] - n[0] * o[2], n[0] * o[1] - n[1] * o[0]];
  const l = Math.hypot(t[0], t[1], t[2]) || 1;
  t = [t[0] / l, t[1] / l, t[2] / l];
  const b: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return [t, b];
}

/**
 * Best-fit affine UV map of a face: `at(p, corner)` returns the UV of point `p` (projected into the
 * face plane), anchored at the given corner so corner UVs are reproduced exactly. Works for points
 * outside the face as well (used by inset/bevel/extrude to place new corners).
 */
export interface UVFrame {
  at(p: Readonly<Vec3>, corner: number): [number, number];
}

export function uvFrame(m: MeshData, rec: FaceRec): UVFrame | null {
  if (!rec.uv) return null;
  const uv = rec.uv;
  const pts = rec.v.map((v) => vpos(m, v));
  const n = pts.length;
  const nr = polygonNormal(pts);
  const len = Math.hypot(nr[0], nr[1], nr[2]);
  const anchor = (corner: number): [number, number] => [uv[corner * 2], uv[corner * 2 + 1]];
  if (len < 1e-14 || n < 3) return { at: (_p, corner) => anchor(corner) };
  const [t1, t2] = planeBasis([nr[0] / len, nr[1] / len, nr[2] / len]);
  const c = centroid(pts);
  const xs = pts.map((p) => (p[0] - c[0]) * t1[0] + (p[1] - c[1]) * t1[1] + (p[2] - c[2]) * t1[2]);
  const ys = pts.map((p) => (p[0] - c[0]) * t2[0] + (p[1] - c[1]) * t2[1] + (p[2] - c[2]) * t2[2]);
  let mu = 0;
  let mv = 0;
  for (let i = 0; i < n; i++) {
    mu += uv[i * 2] / n;
    mv += uv[i * 2 + 1] / n;
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxu = 0;
  let syu = 0;
  let sxv = 0;
  let syv = 0;
  for (let i = 0; i < n; i++) {
    const du = uv[i * 2] - mu;
    const dv = uv[i * 2 + 1] - mv;
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
    syy += ys[i] * ys[i];
    sxu += xs[i] * du;
    syu += ys[i] * du;
    sxv += xs[i] * dv;
    syv += ys[i] * dv;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-18) return { at: (_p, corner) => anchor(corner) };
  const gux = (sxu * syy - syu * sxy) / det;
  const guy = (syu * sxx - sxu * sxy) / det;
  const gvx = (sxv * syy - syv * sxy) / det;
  const gvy = (syv * sxx - sxv * sxy) / det;
  return {
    at(p, corner) {
      const q = pts[corner];
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      const dz = p[2] - q[2];
      const x = dx * t1[0] + dy * t1[1] + dz * t1[2];
      const y = dx * t2[0] + dy * t2[1] + dz * t2[2];
      const a = anchor(corner);
      return [a[0] + gux * x + guy * y, a[1] + gvx * x + gvy * y];
    },
  };
}

/**
 * Phong-tessellation style displacement for a point `p` expressed with `weights` over corner
 * vertices `verts` (unit vertex normals in `normals`). Returns the offset to add to `p` to follow
 * the curvature implied by the normals; scaled by `amount` (0.5 ≈ circular arcs for fine meshes).
 */
export function curvatureOffset(
  m: MeshData,
  normals: readonly number[],
  verts: readonly number[],
  weights: readonly number[],
  p: Readonly<Vec3>,
  amount: number,
): Vec3 {
  if (amount === 0) return [0, 0, 0];
  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < verts.length; k++) {
    const w = weights[k];
    if (w === 0) continue;
    const v = verts[k];
    const nx = normals[v * 3];
    const ny = normals[v * 3 + 1];
    const nz = normals[v * 3 + 2];
    const d =
      (p[0] - m.positions[v * 3]) * nx +
      (p[1] - m.positions[v * 3 + 1]) * ny +
      (p[2] - m.positions[v * 3 + 2]) * nz;
    out[0] -= w * d * nx;
    out[1] -= w * d * ny;
    out[2] -= w * d * nz;
  }
  return [out[0] * amount, out[1] * amount, out[2] * amount];
}

// ---------------------------------------------------------------------------------- edge attributes

export function getEdgeAttr(m: MeshData, a: number, b: number): EdgeAttr | undefined {
  return m.edgeAttrs[edgeKey(a, b)];
}

/** Copies (merges) the attributes of edge (a, b) onto edge (c, d) if it has any. */
export function copyEdgeAttr(m: MeshData, a: number, b: number, c: number, d: number): void {
  const src = m.edgeAttrs[edgeKey(a, b)];
  if (!src) return;
  const k = edgeKey(c, d);
  m.edgeAttrs[k] = mergeEdgeAttrs(m.edgeAttrs[k], src);
}

export function mergeEdgeAttrs(a: EdgeAttr | undefined, b: EdgeAttr | undefined): EdgeAttr {
  const out: EdgeAttr = { ...(a ?? {}) };
  if (b?.seam) out.seam = true;
  if (b?.sharp) out.sharp = true;
  if (b?.crease !== undefined) out.crease = Math.max(out.crease ?? 0, b.crease);
  return out;
}

/** Writes an edge attribute, deleting the entry when it only holds default values. */
export function setEdgeAttr(m: MeshData, key: string, attr: EdgeAttr): void {
  const clean: EdgeAttr = {};
  if (attr.seam) clean.seam = true;
  if (attr.sharp) clean.sharp = true;
  if (attr.crease !== undefined && attr.crease > 0) clean.crease = Math.min(1, attr.crease);
  if (Object.keys(clean).length) m.edgeAttrs[key] = clean;
  else delete m.edgeAttrs[key];
}

// ---------------------------------------------------------------------------------- misc

/** Appends `value` to the list stored under `key` (creating it). */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let s = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Votes on the orientation of a new face loop given the directed edges of existing faces:
 * > 0 keep the loop, < 0 reverse it, 0 undetermined.
 */
export function orientationVote(dmap: Map<number, number>, loop: readonly number[]): number {
  let vote = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    if (dmap.has(dkey(a, b))) vote--;
    if (dmap.has(dkey(b, a))) vote++;
  }
  return vote;
}

/** Mean of all vertex positions (used for orientation heuristics). */
export function meshCentroid(m: MeshData): Vec3 {
  const n = vertexCount(m);
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    c[0] += m.positions[i * 3];
    c[1] += m.positions[i * 3 + 1];
    c[2] += m.positions[i * 3 + 2];
  }
  return n ? [c[0] / n, c[1] / n, c[2] / n] : c;
}

/** Throws when the selection does not contain anything relevant for an operation. */
export function requireNonEmpty(count: number, what: string): void {
  if (count === 0) throw new Error(`No ${what} selected`);
}

/** Eigen decomposition of a symmetric 3x3 matrix (cyclic Jacobi). Vectors are unit length. */
export function symmetricEigen3(a: readonly (readonly number[])[]): { values: number[]; vectors: Vec3[] } {
  const A = a.map((r) => r.slice());
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
    if (off < 1e-30) break;
    for (const [p, q] of pairs) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k][p];
        const akq = A[k][q];
        A[k][p] = c * akp - s * akq;
        A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p][k];
        const aqk = A[q][k];
        A[p][k] = c * apk - s * aqk;
        A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p];
        const vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return {
    values: [A[0][0], A[1][1], A[2][2]],
    vectors: [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]] as Vec3),
  };
}

/** Normal of the least-squares plane through the points (unit length; [0,0,1] if degenerate). */
export function bestFitNormal(pts: readonly Vec3[]): Vec3 {
  if (pts.length < 3) return [0, 0, 1];
  const c = centroid(pts);
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
  }
  const { values, vectors } = symmetricEigen3(C);
  let best = 0;
  for (let i = 1; i < 3; i++) if (values[i] < values[best]) best = i;
  const n = vectors[best];
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1];
}

/** Orders points by angle around their centroid in the plane with normal `n` (counter-clockwise). */
export function angularOrder(pts: readonly Vec3[], n: Readonly<Vec3>): number[] {
  const c = centroid(pts);
  const [t, b] = planeBasis(n);
  const ang = pts.map((p) => {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return Math.atan2(d[0] * b[0] + d[1] * b[1] + d[2] * b[2], d[0] * t[0] + d[1] * t[1] + d[2] * t[2]);
  });
  return pts.map((_, i) => i).sort((i, j) => ang[i] - ang[j]);
}
