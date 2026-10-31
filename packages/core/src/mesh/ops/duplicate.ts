import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, createMesh, edgeKey, parseEdgeKey, pruneEdgeData, vertexCount } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces, selectionFromVerts } from '../selection';
import { buildTopology, vertexIslands } from '../topology';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  type FaceRec,
  removeUnusedAmong,
  removeVertices,
  requireNonEmpty,
  writeFaces,
} from './util';

/**
 * Duplicates the selected geometry (Shift+D): selected faces with their vertices, selected edges
 * that are not part of selected faces (as wire edges) and lone selected vertices. The copy is
 * moved by `offset` (local space) and becomes the selection.
 */
export function duplicateSelection(
  src: MeshData,
  sel: MeshSelection,
  offset: Readonly<Vec3> = [0, 0, 0],
): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.verts.size, 'geometry');
  const m = cloneMesh(src);
  const map = new Map<number, number>();
  for (const v of [...s.verts].sort((a, b) => a - b)) {
    const p = src.positions;
    map.set(
      v,
      addVertexFrom(m, [p[v * 3] + offset[0], p[v * 3 + 1] + offset[1], p[v * 3 + 2] + offset[2]], [v]),
    );
  }
  const recs = allFaceRecs(src);
  const copies: FaceRec[] = [];
  const faceEdgeKeys = new Set<string>();
  for (const f of [...s.faces].sort((a, b) => a - b)) {
    copies.push({ ...recs[f], v: recs[f].v.map((v) => map.get(v)!), sel: true });
    const face = src.faces[f];
    for (let i = 0; i < face.length; i++) faceEdgeKeys.add(edgeKey(face[i], face[(i + 1) % face.length]));
  }
  for (const k of s.edges) {
    if (faceEdgeKeys.has(k)) continue;
    const [a, b] = parseEdgeKey(k);
    m.looseEdges.push(map.get(a)!, map.get(b)!);
  }
  for (const k of [...faceEdgeKeys, ...s.edges]) {
    const attr = src.edgeAttrs[k];
    if (!attr) continue;
    const [a, b] = parseEdgeKey(k);
    m.edgeAttrs[edgeKey(map.get(a)!, map.get(b)!)] = { ...attr };
  }
  writeFaces(m, [...recs, ...copies]);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromVerts(m, [...map.values()]) };
}

/**
 * Split (Y): disconnects the selected faces from the unselected geometry by giving them their own
 * copies of the shared vertices. The faces keep their place and stay selected.
 */
export function splitSelection(src: MeshData, sel: MeshSelection): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.faces.size, 'faces');
  const m = cloneMesh(src);
  const shared = new Set<number>();
  for (const f of s.faces)
    for (const v of src.faces[f])
      if (
        topo.vertFaces[v].some((g) => !s.faces.has(g)) ||
        topo.vertEdges[v].some((e) => topo.edgeFaces[e].length === 0)
      )
        shared.add(v);
  const map = new Map<number, number>();
  for (const v of [...shared].sort((a, b) => a - b))
    map.set(
      v,
      addVertexFrom(m, [src.positions[v * 3], src.positions[v * 3 + 1], src.positions[v * 3 + 2]], [v]),
    );
  const recs = allFaceRecs(src);
  for (const f of s.faces) recs[f] = { ...recs[f], v: recs[f].v.map((v) => map.get(v) ?? v), sel: true };
  for (const k in src.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    if (map.has(a) || map.has(b))
      m.edgeAttrs[edgeKey(map.get(a) ?? a, map.get(b) ?? b)] = { ...src.edgeAttrs[k] };
  }
  const selected = writeFaces(m, recs);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}

/** Builds a standalone mesh from the given faces, wire edges and extra vertices of `src`. */
export function extractMesh(
  src: MeshData,
  faces: readonly number[],
  wire: readonly [number, number][] = [],
  extraVerts: readonly number[] = [],
): MeshData {
  const map = new Map<number, number>();
  const positions: number[] = [];
  const colors: number[] | null = src.colors ? [] : null;
  const use = (v: number): number => {
    let i = map.get(v);
    if (i === undefined) {
      i = positions.length / 3;
      map.set(v, i);
      positions.push(src.positions[v * 3], src.positions[v * 3 + 1], src.positions[v * 3 + 2]);
      if (colors && src.colors) colors.push(...src.colors.slice(v * 4, v * 4 + 4));
    }
    return i;
  };
  const recs = allFaceRecs(src);
  const list: FaceRec[] = faces.map((f) => ({ ...recs[f], v: recs[f].v.map(use) }));
  const looseEdges: number[] = [];
  for (const [a, b] of wire) looseEdges.push(use(a), use(b));
  for (const v of extraVerts) use(v);
  const out = createMesh({ positions, colors, uvs: src.uvs ? [] : null, looseEdges });
  writeFaces(out, list);
  for (const k in src.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    const ma = map.get(a);
    const mb = map.get(b);
    if (ma !== undefined && mb !== undefined) out.edgeAttrs[edgeKey(ma, mb)] = { ...src.edgeAttrs[k] };
  }
  pruneEdgeData(out);
  return out;
}

export type SeparateType = 'SELECTED' | 'MATERIAL' | 'LOOSE';

/**
 * Separate (P): splits geometry off into new meshes. SELECTED moves the selected faces (and
 * selected wire edges / lone vertices) out; LOOSE splits every connected part (the part with the
 * lowest vertex index stays); MATERIAL splits by face material index (the lowest index stays).
 * Vertices shared between staying and leaving faces are duplicated.
 */
export function separateMesh(
  src: MeshData,
  sel: MeshSelection,
  type: SeparateType,
): { mesh: MeshData; parts: MeshData[] } {
  const topo = buildTopology(src);
  const wirePairs: [number, number][] = [];
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2)
    wirePairs.push([src.looseEdges[i], src.looseEdges[i + 1]]);
  const isolated: number[] = [];
  for (let v = 0; v < vertexCount(src); v++) if (topo.vertEdges[v].length === 0) isolated.push(v);
  // Group id per face / wire edge / isolated vertex; group 0 stays in the original mesh.
  let faceGroup: number[];
  let wireGroup: number[];
  let vertGroup: number[];
  if (type === 'SELECTED') {
    const s = completeSelection(src, sel, topo);
    faceGroup = src.faces.map((_, f) => (s.faces.has(f) ? 1 : 0));
    wireGroup = wirePairs.map(([a, b]) => (s.edges.has(edgeKey(a, b)) ? 1 : 0));
    vertGroup = isolated.map((v) => (s.verts.has(v) ? 1 : 0));
    if (!faceGroup.includes(1) && !wireGroup.includes(1) && !vertGroup.includes(1))
      requireNonEmpty(0, 'geometry');
  } else if (type === 'LOOSE') {
    const { islandOf } = vertexIslands(src, topo);
    faceGroup = src.faces.map((f) => islandOf[f[0]]);
    wireGroup = wirePairs.map(([a]) => islandOf[a]);
    vertGroup = isolated.map((v) => islandOf[v]);
  } else {
    const mats = [...new Set(src.faceMaterials)].sort((a, b) => a - b);
    faceGroup = src.faceMaterials.map((mi) => mats.indexOf(mi));
    wireGroup = wirePairs.map(() => 0);
    vertGroup = isolated.map(() => 0);
  }
  const groups = [...new Set([...faceGroup, ...wireGroup, ...vertGroup])].sort((a, b) => a - b);
  if (type !== 'SELECTED' && groups.length < 2)
    throw new Error(type === 'LOOSE' ? 'Mesh has only one connected part' : 'Mesh uses only one material');
  const stay = type === 'SELECTED' ? 0 : groups[0];
  const parts: MeshData[] = [];
  for (const g of groups) {
    if (g === stay) continue;
    parts.push(
      extractMesh(
        src,
        faceGroup.flatMap((x, f) => (x === g ? [f] : [])),
        wirePairs.filter((_, i) => wireGroup[i] === g),
        isolated.filter((_, i) => vertGroup[i] === g),
      ),
    );
  }
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const leaving = new Set<number>();
  faceGroup.forEach((g, f) => {
    if (g !== stay) for (const v of src.faces[f]) leaving.add(v);
  });
  writeFaces(
    m,
    recs.filter((_, f) => faceGroup[f] === stay),
  );
  m.looseEdges = wirePairs.filter((_, i) => wireGroup[i] === stay).flat();
  pruneEdgeData(m);
  const removeIsolated = new Uint8Array(vertexCount(src));
  isolated.forEach((v, i) => {
    if (vertGroup[i] !== stay) removeIsolated[v] = 1;
  });
  wirePairs.forEach(([a, b], i) => {
    if (wireGroup[i] !== stay) {
      leaving.add(a);
      leaving.add(b);
    }
  });
  const remap = removeUnusedAmong(m, leaving);
  const remove2 = new Uint8Array(vertexCount(m));
  removeIsolated.forEach((x, v) => {
    if (x && remap[v] >= 0) remove2[remap[v]] = 1;
  });
  removeVertices(m, remove2);
  return { mesh: m, parts };
}
