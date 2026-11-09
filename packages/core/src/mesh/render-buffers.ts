import type { MeshData } from './types';
import { edgeKey, vertexCount } from './types';
import { buildTopology } from './topology';
import { faceNormalRaw } from './normals';
import { triangulateFaceCorners } from './triangulate';

/**
 * GPU-ready triangle buffers derived from a polygon mesh. Normals honour per-face smooth flags
 * and sharp edges (corners are grouped into smoothing fans, like Blender's split normals).
 */
export interface RenderBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array;
  /** Triangle ranges per material slot, sorted by material index. */
  groups: { start: number; count: number; materialIndex: number }[];
  /** Source polygon index for every triangle (in `indices` order). */
  triFace: Uint32Array;
  /** Source mesh vertex for every render vertex. */
  vertexSource: Uint32Array;
}

export function buildRenderBuffers(m: MeshData): RenderBuffers {
  // Typed arrays throughout: a mesh of a million faces has four million corners, and per-corner
  // objects (string keys, small arrays, Map entries) used to take more than 2 GB of heap and
  // twenty seconds for it. The result is the same as with those structures, number for number.
  const faces = m.faces;
  const nFaces = faces.length;
  const nv = Math.floor(vertexCount(m));
  const p = m.positions;

  // --- flat corner numbering (face f has corners faceCornerStart[f] … faceCornerStart[f + 1] - 1)
  const faceCornerStart = new Int32Array(nFaces + 1);
  let nCorners = 0;
  for (let f = 0; f < nFaces; f++) {
    faceCornerStart[f] = nCorners;
    const face = faces[f];
    for (let i = 0; i < face.length; i++) {
      const v = face[i];
      // every corner names a vertex of the mesh (as the adjacency lists it used to fill required)
      if (!(Number.isInteger(v) && v >= 0 && v < nv))
        throw new TypeError(`face ${f} corner ${i}: vertex index ${v} is not a vertex of the mesh`);
    }
    nCorners += face.length;
  }
  faceCornerStart[nFaces] = nCorners;

  // --- face normals (unit) and corner angle weights
  const faceN = new Float64Array(nFaces * 3);
  for (let f = 0; f < nFaces; f++) {
    const n = faceNormalRaw(m, f);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    faceN[f * 3] = n[0] / l;
    faceN[f * 3 + 1] = n[1] / l;
    faceN[f * 3 + 2] = n[2] / l;
  }

  // --- union-find over corners to build smoothing fans
  const parent = new Int32Array(nCorners);
  for (let i = 0; i < nCorners; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  joinSmoothFans(m, faceCornerStart, nCorners, union);

  // --- accumulate angle-weighted normals per fan root
  const fanN = new Float64Array(nCorners * 3);
  for (let f = 0; f < nFaces; f++) {
    const face = faces[f];
    const n = face.length;
    for (let i = 0; i < n; i++) {
      const c = faceCornerStart[f] + i;
      let w = 1;
      if (m.faceSmooth[f]) {
        const v = face[i] * 3;
        const prev = face[(i + n - 1) % n] * 3;
        const next = face[(i + 1) % n] * 3;
        const ax = p[prev] - p[v];
        const ay = p[prev + 1] - p[v + 1];
        const az = p[prev + 2] - p[v + 2];
        const bx = p[next] - p[v];
        const by = p[next + 1] - p[v + 1];
        const bz = p[next + 2] - p[v + 2];
        const la = Math.hypot(ax, ay, az);
        const lb = Math.hypot(bx, by, bz);
        if (la > 0 && lb > 0) {
          const cos = (ax * bx + ay * by + az * bz) / (la * lb);
          w = Math.acos(Math.max(-1, Math.min(1, cos)));
        }
      }
      const r = find(c);
      fanN[r * 3] += faceN[f * 3] * w;
      fanN[r * 3 + 1] += faceN[f * 3 + 1] * w;
      fanN[r * 3 + 2] += faceN[f * 3 + 2] * w;
    }
  }

  // --- render vertices: one per vertex + smoothing fan + UV, numbered in the order their first
  // corner comes. The render vertices of each mesh vertex form a list (head / next); a corner
  // takes the one with its fan and the same UV (equal as the numbers' decimal text: -0 and 0 are
  // the same, NaN equals NaN), else makes a new one.
  const hasUV = !!m.uvs;
  const hasColor = !!m.colors && m.colors.length === vertexCount(m) * 4;
  const uvs = m.uvs;
  const sameUV = (a: unknown, b: unknown) => a === b || (a !== a && b !== b);
  const head = new Int32Array(nv).fill(-1);
  const next = new Int32Array(nCorners);
  /** Fan root, face and corner within the face of every render vertex's first corner. */
  const rvRoot = new Int32Array(nCorners);
  const rvFace = new Int32Array(nCorners);
  const rvCorner = new Int32Array(nCorners);
  const cornerVertex = new Int32Array(nCorners);
  let count = 0;
  for (let f = 0; f < nFaces; f++) {
    const face = faces[f];
    const uv = hasUV ? uvs![f] : null;
    for (let i = 0; i < face.length; i++) {
      const c = faceCornerStart[f] + i;
      const v = face[i];
      const r = find(c);
      const u0 = uv ? uv[i * 2] : 0;
      const u1 = uv ? uv[i * 2 + 1] : 0;
      let idx = head[v];
      while (idx >= 0) {
        if (rvRoot[idx] === r) {
          if (!hasUV) break;
          const ouv = uvs![rvFace[idx]];
          const k = rvCorner[idx] * 2;
          if (sameUV(ouv ? ouv[k] : 0, u0) && sameUV(ouv ? ouv[k + 1] : 0, u1)) break;
        }
        idx = next[idx];
      }
      if (idx < 0) {
        idx = count++;
        rvRoot[idx] = r;
        rvFace[idx] = f;
        rvCorner[idx] = i;
        next[idx] = head[v];
        head[v] = idx;
      }
      cornerVertex[c] = idx;
    }
  }
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvOut = hasUV ? new Float32Array(count * 2) : null;
  const colors = hasColor ? new Float32Array(count * 4) : null;
  const vertexSource = new Uint32Array(count);
  const cc = m.colors;
  for (let k = 0; k < count; k++) {
    const f = rvFace[k];
    const i = rvCorner[k];
    const v = faces[f][i];
    const r = rvRoot[k];
    positions[k * 3] = p[v * 3];
    positions[k * 3 + 1] = p[v * 3 + 1];
    positions[k * 3 + 2] = p[v * 3 + 2];
    const nx = fanN[r * 3];
    const ny = fanN[r * 3 + 1];
    const nz = fanN[r * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[k * 3] = nx / l;
    normals[k * 3 + 1] = ny / l;
    normals[k * 3 + 2] = nz / l;
    if (uvOut) {
      const uv = uvs![f];
      uvOut[k * 2] = (uv ? uv[i * 2] : 0) as number;
      uvOut[k * 2 + 1] = (uv ? uv[i * 2 + 1] : 0) as number;
    }
    if (colors) {
      colors[k * 4] = cc![v * 4];
      colors[k * 4 + 1] = cc![v * 4 + 1];
      colors[k * 4 + 2] = cc![v * 4 + 2];
      colors[k * 4 + 3] = cc![v * 4 + 3];
    }
    vertexSource[k] = v;
  }

  // --- triangles grouped by material (in face order within a material, materials ascending).
  // Triangles are counted first (quads and triangles without triangulating them; larger polygons
  // are triangulated once and kept for the second pass), then written in place.
  const triCount = new Map<number, number>();
  const polygons = new Map<number, number[]>();
  for (let f = 0; f < nFaces; f++) {
    const mat = m.faceMaterials[f] ?? 0;
    const n = faces[f].length;
    let t: number;
    if (n < 3) t = 0;
    else if (n === 3) t = 1;
    else if (n === 4) t = 2;
    else {
      const corners = triangulateFaceCorners(m, f);
      polygons.set(f, corners);
      t = corners.length / 3;
    }
    triCount.set(mat, (triCount.get(mat) ?? 0) + t);
  }
  const mats = [...triCount.keys()].sort((a, b) => a - b);
  let total = 0;
  const groups: RenderBuffers['groups'] = [];
  const offset = new Map<number, number>();
  for (const k of mats) {
    const n = triCount.get(k)! * 3;
    groups.push({ start: total, count: n, materialIndex: k });
    offset.set(k, total);
    total += n;
  }
  const indices = new Uint32Array(total);
  const triFace = new Uint32Array(total / 3);
  for (let f = 0; f < nFaces; f++) {
    const n = faces[f].length;
    if (n < 3) continue;
    const mat = m.faceMaterials[f] ?? 0;
    const corners = n > 4 ? polygons.get(f)! : triangulateFaceCorners(m, f);
    const base = faceCornerStart[f];
    let o = offset.get(mat)!;
    for (let i = 0; i < corners.length; i += 3) {
      indices[o] = cornerVertex[base + corners[i]];
      indices[o + 1] = cornerVertex[base + corners[i + 1]];
      indices[o + 2] = cornerVertex[base + corners[i + 2]];
      triFace[o / 3] = f;
      o += 3;
    }
    offset.set(mat, o);
  }

  return {
    positions,
    normals,
    uvs: uvOut,
    colors,
    indices,
    groups,
    triFace,
    vertexSource,
  };
}

/**
 * Joins the corners of smooth faces around shared edges into smoothing fans: across every edge
 * that exactly two faces use, both smooth and the edge not sharp, the corners of each of its two
 * vertices in the two faces (the first corner of the vertex in each face). Edges are found with
 * typed arrays: the corners' edges listed per lower vertex, in face order.
 */
function joinSmoothFans(
  m: MeshData,
  faceCornerStart: Int32Array,
  nCorners: number,
  union: (a: number, b: number) => void,
): void {
  const faces = m.faces;
  const nFaces = faces.length;
  if (!m.faceSmooth.some((s, f) => s && f < nFaces)) return;
  const nv = Math.floor(vertexCount(m));
  // the edge of every corner (to the next corner of its face), listed under its lower vertex
  const start = new Int32Array(nv + 1);
  for (let f = 0; f < nFaces; f++) {
    const face = faces[f];
    for (let i = 0; i < face.length; i++) start[Math.min(face[i], face[(i + 1) % face.length]) + 1]++;
  }
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const otherEnd = new Int32Array(nCorners);
  const edgeFace = new Int32Array(nCorners);
  for (let f = 0; f < nFaces; f++) {
    const face = faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const lo = a < b ? a : b;
      const k = fill[lo]++;
      otherEnd[k] = a < b ? b : a;
      edgeFace[k] = f;
    }
  }
  const hasAttrs = Object.keys(m.edgeAttrs).length > 0;
  const cornerOf = (f: number, v: number): number => {
    const i = faces[f].indexOf(v);
    return i < 0 ? -1 : faceCornerStart[f] + i;
  };
  // entries of one lower vertex, ordered by the other end (stable: faces stay in order)
  let order: number[] = [];
  for (let lo = 0; lo < nv; lo++) {
    const s = start[lo];
    const e = start[lo + 1];
    if (e - s < 2) continue;
    order.length = 0;
    for (let k = s; k < e; k++) order.push(k);
    if (e - s > 2) order.sort((x, y) => otherEnd[x] - otherEnd[y] || x - y);
    else if (otherEnd[order[0]] > otherEnd[order[1]]) order = [order[1], order[0]];
    for (let j = 0; j < order.length;) {
      const hi = otherEnd[order[j]];
      // the distinct faces of edge (lo, hi), in face order
      let f0 = -1;
      let f1 = -1;
      let distinct = 0;
      let last = -1;
      let q = j;
      for (; q < order.length && otherEnd[order[q]] === hi; q++) {
        const f = edgeFace[order[q]];
        if (f === last) continue;
        last = f;
        if (distinct === 0) f0 = f;
        else if (distinct === 1) f1 = f;
        distinct++;
      }
      j = q;
      if (distinct !== 2) continue;
      if (!m.faceSmooth[f0] || !m.faceSmooth[f1]) continue;
      if (hasAttrs && m.edgeAttrs[edgeKey(lo, hi)]?.sharp) continue;
      for (const v of [lo, hi]) {
        const c0 = cornerOf(f0, v);
        const c1 = cornerOf(f1, v);
        if (c0 >= 0 && c1 >= 0) union(c0, c1);
      }
    }
  }
}

/** Unique edges as flat vertex index pairs (for wireframe overlays). */
export function buildEdgeIndexList(m: MeshData): Uint32Array {
  const topo = buildTopology(m);
  const out = new Uint32Array(topo.edges.length * 2);
  topo.edges.forEach(([a, b], i) => {
    out[i * 2] = a;
    out[i * 2 + 1] = b;
  });
  return out;
}
