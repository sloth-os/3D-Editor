import type { Vec3 } from '../math/types';

/** Per-edge attributes (only edges with non-default values are stored). */
export interface EdgeAttr {
  /** UV seam (used by unwrapping). */
  seam?: boolean;
  /** Sharp edge: splits shading normals across it. */
  sharp?: boolean;
  /** Subdivision crease weight in [0, 1]. */
  crease?: number;
}

/**
 * Editable polygon mesh (Blender "Mesh" datablock equivalent).
 *
 * - Faces are n-gons given as vertex index loops, counter-clockwise when seen from the front
 *   (the face normal follows the right-hand rule).
 * - All per-face arrays (`faceMaterials`, `faceSmooth`, `uvs`) are index-aligned with `faces`.
 * - `uvs[f]` holds per-corner UVs for face f as a flat array `[u0, v0, u1, v1, ...]`.
 * - Edges are implicit (derived from faces) except "loose" wire edges which are stored in
 *   `looseEdges` as flat pairs.
 *
 * Mesh operations should treat a MeshData as immutable input and return a new MeshData
 * (use `cloneMesh` when needed).
 */
export interface MeshData {
  positions: number[];
  faces: number[][];
  faceMaterials: number[];
  faceSmooth: boolean[];
  uvs: number[][] | null;
  /** Optional per-vertex RGBA colors (flat, 4 floats per vertex, linear 0..1). */
  colors: number[] | null;
  /** Edge attributes keyed by `edgeKey(a, b)`. */
  edgeAttrs: Record<string, EdgeAttr>;
  /** Wire edges that are not part of any face, as flat index pairs. */
  looseEdges: number[];
}

export function createMesh(init: Partial<MeshData> = {}): MeshData {
  const faces = init.faces ?? [];
  return {
    positions: init.positions ?? [],
    faces,
    faceMaterials: init.faceMaterials ?? faces.map(() => 0),
    faceSmooth: init.faceSmooth ?? faces.map(() => false),
    uvs: init.uvs ?? null,
    colors: init.colors ?? null,
    edgeAttrs: init.edgeAttrs ?? {},
    looseEdges: init.looseEdges ?? [],
  };
}

export function cloneMesh(m: MeshData): MeshData {
  const edgeAttrs: Record<string, EdgeAttr> = {};
  for (const k in m.edgeAttrs) edgeAttrs[k] = { ...m.edgeAttrs[k] };
  return {
    positions: m.positions.slice(),
    faces: m.faces.map((f) => f.slice()),
    faceMaterials: m.faceMaterials.slice(),
    faceSmooth: m.faceSmooth.slice(),
    uvs: m.uvs ? m.uvs.map((u) => u.slice()) : null,
    colors: m.colors ? m.colors.slice() : null,
    edgeAttrs,
    looseEdges: m.looseEdges.slice(),
  };
}

export function vertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

export function getVertex(m: MeshData, i: number): Vec3 {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
}

export function setVertex(m: MeshData, i: number, p: Readonly<Vec3>): void {
  m.positions[i * 3] = p[0];
  m.positions[i * 3 + 1] = p[1];
  m.positions[i * 3 + 2] = p[2];
}

/** Appends a vertex and returns its index. Extends the color array if present. */
export function addVertex(m: MeshData, p: Readonly<Vec3>, color?: readonly number[]): number {
  const i = m.positions.length / 3;
  m.positions.push(p[0], p[1], p[2]);
  if (m.colors) m.colors.push(...(color ?? [1, 1, 1, 1]));
  return i;
}

/** Appends a face (with optional per-corner UVs) and returns its index. */
export function addFace(
  m: MeshData,
  verts: number[],
  opts: { material?: number; smooth?: boolean; uvs?: number[] } = {},
): number {
  const f = m.faces.length;
  m.faces.push(verts);
  m.faceMaterials.push(opts.material ?? 0);
  m.faceSmooth.push(opts.smooth ?? false);
  if (m.uvs) m.uvs.push(opts.uvs ?? new Array(verts.length * 2).fill(0));
  return f;
}

/** Canonical key for the undirected edge (a, b). */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

export function parseEdgeKey(k: string): [number, number] {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

/** Ensures a UV layer exists (filled with zeros) and returns it. */
export function ensureUVs(m: MeshData): number[][] {
  if (!m.uvs) m.uvs = m.faces.map((f) => new Array(f.length * 2).fill(0));
  return m.uvs;
}

/** Number of unique edges (face edges + loose edges). */
export function countEdges(m: MeshData): number {
  const set = new Set<string>();
  for (const f of m.faces) for (let i = 0; i < f.length; i++) set.add(edgeKey(f[i], f[(i + 1) % f.length]));
  for (let i = 0; i < m.looseEdges.length; i += 2) set.add(edgeKey(m.looseEdges[i], m.looseEdges[i + 1]));
  return set.size;
}

export function countTriangles(m: MeshData): number {
  let t = 0;
  for (const f of m.faces) t += Math.max(0, f.length - 2);
  return t;
}

export interface MeshStats {
  vertices: number;
  edges: number;
  faces: number;
  triangles: number;
}

export function meshStats(m: MeshData): MeshStats {
  return {
    vertices: vertexCount(m),
    edges: countEdges(m),
    faces: m.faces.length,
    triangles: countTriangles(m),
  };
}

/** Axis-aligned bounding box; returns null for empty meshes. */
export function meshBounds(m: MeshData): { min: Vec3; max: Vec3 } | null {
  const p = m.positions;
  if (p.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Removes vertices that are not referenced by any face or loose edge and remaps indices.
 * Returns the old→new index map (-1 for removed vertices).
 */
export function compactVertices(m: MeshData): Int32Array {
  const n = vertexCount(m);
  const used = new Uint8Array(n);
  for (const f of m.faces) for (const v of f) used[v] = 1;
  for (const v of m.looseEdges) used[v] = 1;
  const remap = new Int32Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) if (used[i]) remap[i] = next++;
  if (next === n) {
    for (let i = 0; i < n; i++) remap[i] = i;
    return remap;
  }
  const pos = new Array<number>(next * 3);
  const col = m.colors ? new Array<number>(next * 4) : null;
  for (let i = 0; i < n; i++) {
    const j = remap[i];
    if (j < 0) continue;
    pos[j * 3] = m.positions[i * 3];
    pos[j * 3 + 1] = m.positions[i * 3 + 1];
    pos[j * 3 + 2] = m.positions[i * 3 + 2];
    if (col && m.colors) for (let k = 0; k < 4; k++) col[j * 4 + k] = m.colors[i * 4 + k];
  }
  m.positions = pos;
  if (col) m.colors = col;
  m.faces = m.faces.map((f) => f.map((v) => remap[v]));
  m.looseEdges = m.looseEdges.map((v) => remap[v]);
  const attrs: Record<string, EdgeAttr> = {};
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    if (remap[a] >= 0 && remap[b] >= 0) attrs[edgeKey(remap[a], remap[b])] = m.edgeAttrs[k];
  }
  m.edgeAttrs = attrs;
  return remap;
}

/** Removes faces by index (keeps vertices; call compactVertices afterwards if needed). */
export function removeFaces(m: MeshData, remove: Set<number>): void {
  if (remove.size === 0) return;
  const keep = (_: unknown, i: number) => !remove.has(i);
  m.faces = m.faces.filter(keep);
  m.faceMaterials = m.faceMaterials.filter(keep);
  m.faceSmooth = m.faceSmooth.filter(keep);
  if (m.uvs) m.uvs = m.uvs.filter(keep);
}

/** Drops edge attributes and loose edges referring to edges that no longer exist. */
export function pruneEdgeData(m: MeshData): void {
  const faceEdges = new Set<string>();
  for (const f of m.faces)
    for (let i = 0; i < f.length; i++) faceEdges.add(edgeKey(f[i], f[(i + 1) % f.length]));
  const loose: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < m.looseEdges.length; i += 2) {
    const a = m.looseEdges[i];
    const b = m.looseEdges[i + 1];
    if (a === b) continue;
    const k = edgeKey(a, b);
    if (faceEdges.has(k) || seen.has(k)) continue;
    seen.add(k);
    loose.push(a, b);
  }
  m.looseEdges = loose;
  const attrs: Record<string, EdgeAttr> = {};
  for (const k in m.edgeAttrs) if (faceEdges.has(k) || seen.has(k)) attrs[k] = m.edgeAttrs[k];
  m.edgeAttrs = attrs;
}

/** Appends `src` (optionally transformed by `transform`) into `dst`. Returns the vertex offset. */
export function appendMesh(
  dst: MeshData,
  src: MeshData,
  transform?: (p: Vec3) => Vec3,
  materialOffset = 0,
): number {
  const offset = vertexCount(dst);
  const n = vertexCount(src);
  for (let i = 0; i < n; i++) {
    const p = getVertex(src, i);
    const q = transform ? transform(p) : p;
    dst.positions.push(q[0], q[1], q[2]);
  }
  if (dst.colors || src.colors) {
    if (!dst.colors) dst.colors = new Array(offset * 4).fill(1);
    if (src.colors) dst.colors.push(...src.colors);
    else for (let i = 0; i < n * 4; i++) dst.colors.push(1);
  }
  if (src.uvs && !dst.uvs) ensureUVs(dst);
  for (let f = 0; f < src.faces.length; f++) {
    dst.faces.push(src.faces[f].map((v) => v + offset));
    dst.faceMaterials.push(src.faceMaterials[f] + materialOffset);
    dst.faceSmooth.push(src.faceSmooth[f]);
    if (dst.uvs) dst.uvs.push(src.uvs ? src.uvs[f].slice() : new Array(src.faces[f].length * 2).fill(0));
  }
  for (const v of src.looseEdges) dst.looseEdges.push(v + offset);
  for (const k in src.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    dst.edgeAttrs[edgeKey(a + offset, b + offset)] = { ...src.edgeAttrs[k] };
  }
  return offset;
}
