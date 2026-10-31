import type { MeshData } from '../types';
import { cloneMesh, edgeKey, pruneEdgeData, vertexCount } from '../types';
import type { MeshSelection } from '../selection';
import { emptySelection, selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import type { MeshOpResult } from './types';
import {
  allFaceRecs,
  completeSelection,
  dkey,
  type FaceRec,
  removeUnusedAmong,
  removeVertices,
  requireNonEmpty,
  UnionFind,
  writeFaces,
} from './util';

export type DeleteType = 'VERT' | 'EDGE' | 'FACE' | 'EDGE_FACE' | 'ONLY_FACE';

/**
 * Deletes selected geometry (Blender X menu):
 * - VERT: vertices and everything using them (other edges of removed faces stay as wire edges)
 * - EDGE: edges and the faces using them; vertices left without any edge are removed
 * - FACE: faces, plus edges/vertices no longer used by remaining faces
 * - EDGE_FACE: edges and faces, vertices are kept
 * - ONLY_FACE: faces only; their edges stay as wire edges
 */
export function deleteGeometry(src: MeshData, sel: MeshSelection, type: DeleteType): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const nv = vertexCount(src);
  const selV = new Uint8Array(nv);
  for (const v of s.verts) selV[v] = 1;
  const selE = new Uint8Array(topo.edges.length);
  for (const k of s.edges) selE[topo.edgeIndex.get(k)!] = 1;
  const delF = new Uint8Array(src.faces.length);
  for (let f = 0; f < src.faces.length; f++) {
    if (type === 'VERT') delF[f] = src.faces[f].some((v) => selV[v]) ? 1 : 0;
    else if (type === 'EDGE' || type === 'EDGE_FACE')
      delF[f] = s.faces.has(f) || topo.faceEdges[f].some((e) => selE[e]) ? 1 : 0;
    else delF[f] = s.faces.has(f) ? 1 : 0;
  }
  const count =
    type === 'VERT'
      ? s.verts.size
      : type === 'FACE' || type === 'ONLY_FACE'
        ? s.faces.size
        : s.edges.size + s.faces.size;
  requireNonEmpty(
    count,
    type === 'VERT' ? 'vertices' : type === 'FACE' || type === 'ONLY_FACE' ? 'faces' : 'edges',
  );

  const m = cloneMesh(src);
  const kept: FaceRec[] = allFaceRecs(src).filter((_, f) => !delF[f]);
  // Edges of deleted faces that no remaining face uses: keep some of them as wire edges.
  const loose: number[] = [];
  const looseSeen = new Set<string>();
  const addLoose = (a: number, b: number) => {
    const k = edgeKey(a, b);
    if (looseSeen.has(k)) return;
    looseSeen.add(k);
    loose.push(a, b);
  };
  for (let e = 0; e < topo.edges.length; e++) {
    const ef = topo.edgeFaces[e];
    if (ef.length === 0 || ef.some((f) => !delF[f])) continue;
    const [a, b] = topo.edges[e];
    let keep = false;
    if (type === 'VERT') keep = !selV[a] && !selV[b];
    else if (type === 'EDGE' || type === 'EDGE_FACE') keep = !selE[e];
    else if (type === 'ONLY_FACE') keep = true;
    if (keep) addLoose(a, b);
  }
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2) {
    const a = src.looseEdges[i];
    const b = src.looseEdges[i + 1];
    const e = topo.edgeIndex.get(edgeKey(a, b));
    let keep = true;
    if (type === 'VERT') keep = !selV[a] && !selV[b];
    else if ((type === 'EDGE' || type === 'EDGE_FACE') && e !== undefined) keep = !selE[e];
    if (keep) addLoose(a, b);
  }
  writeFaces(m, kept);
  m.looseEdges = loose;
  pruneEdgeData(m);
  if (type === 'VERT') {
    removeVertices(m, selV);
  } else if (type === 'EDGE') {
    const cand = new Set<number>();
    for (let e = 0; e < topo.edges.length; e++) if (selE[e]) topo.edges[e].forEach((v) => cand.add(v));
    removeUnusedAmong(m, cand);
  } else if (type === 'FACE') {
    const cand = new Set<number>();
    for (let f = 0; f < src.faces.length; f++) if (delF[f]) for (const v of src.faces[f]) cand.add(v);
    removeUnusedAmong(m, cand);
  }
  return { mesh: m, selection: emptySelection() };
}

// ---------------------------------------------------------------------------------- dissolve

/**
 * Merges each group of faces into one polygon following the group's outline. Groups whose outline
 * is not a single loop (holes, pinches) are left untouched. Returns the new face list and the
 * indices (into the new list) of the merged faces.
 */
export function mergeFaceGroups(
  src: MeshData,
  recs: FaceRec[],
  groups: number[][],
): { recs: FaceRec[]; merged: number[] } {
  const remove = new Set<number>();
  const result: FaceRec[] = [];
  const replacement = new Map<number, FaceRec>();
  for (const group of groups) {
    if (group.length < 2) continue;
    const inGroup = new Set(group);
    const half = new Set<number>();
    for (const f of group) {
      const face = src.faces[f];
      for (let i = 0; i < face.length; i++) half.add(dkey(face[i], face[(i + 1) % face.length]));
    }
    const outgoing = new Map<number, { b: number; f: number; i: number }[]>();
    let total = 0;
    for (const f of group) {
      const face = src.faces[f];
      for (let i = 0; i < face.length; i++) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        if (half.has(dkey(b, a))) continue;
        const list = outgoing.get(a) ?? [];
        list.push({ b, f, i });
        outgoing.set(a, list);
        total++;
      }
    }
    if (total < 3) continue;
    const startA = outgoing.keys().next().value as number;
    const loopV: number[] = [];
    const loopUV: number[] = [];
    let a = startA;
    let ok = true;
    for (let guard = 0; guard <= total; guard++) {
      const list = outgoing.get(a);
      if (!list || list.length !== 1) {
        ok = false;
        break;
      }
      const h = list[0];
      loopV.push(a);
      const rec = recs[h.f];
      loopUV.push(rec.uv ? rec.uv[h.i * 2] : 0, rec.uv ? rec.uv[h.i * 2 + 1] : 0);
      a = h.b;
      if (a === startA) break;
    }
    if (!ok || a !== startA || loopV.length !== total || new Set(loopV).size !== loopV.length) continue;
    const first = Math.min(...group);
    const like = recs[first];
    replacement.set(first, {
      v: loopV,
      mat: like.mat,
      smooth: like.smooth,
      uv: like.uv ? loopUV : null,
      sel: true,
    });
    for (const f of inGroup) if (f !== first) remove.add(f);
  }
  const merged: number[] = [];
  for (let f = 0; f < recs.length; f++) {
    if (remove.has(f)) continue;
    const r = replacement.get(f);
    if (r) merged.push(result.length);
    result.push(r ?? recs[f]);
  }
  return { recs: result, merged };
}

/** Angle limit used when cleaning up vertices left between two (nearly) collinear edges. */
const COLLINEAR_LIMIT = (5 * Math.PI) / 180;

/**
 * Removes vertices that have exactly two edges from face outlines and wire chains (joining their
 * two edges into one). With `maxAngle`, only vertices whose edges deviate less than that from a
 * straight line are removed (so corners survive). A vertex is skipped when a face using it would
 * drop below three corners.
 */
function dissolveValence2(m: MeshData, verts: Iterable<number>, maxAngle?: number): void {
  const topo = buildTopology(m);
  const targets = new Set<number>();
  const P = m.positions;
  for (const v of verts) {
    if (!(v >= 0 && v < topo.vertEdges.length) || topo.vertEdges[v].length !== 2) continue;
    if (maxAngle !== undefined) {
      const [a, b] = topo.vertEdges[v].map((e) =>
        topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0],
      );
      const u = [P[a * 3] - P[v * 3], P[a * 3 + 1] - P[v * 3 + 1], P[a * 3 + 2] - P[v * 3 + 2]];
      const w = [P[b * 3] - P[v * 3], P[b * 3 + 1] - P[v * 3 + 1], P[b * 3 + 2] - P[v * 3 + 2]];
      const lu = Math.hypot(u[0], u[1], u[2]);
      const lw = Math.hypot(w[0], w[1], w[2]);
      if (lu < 1e-12 || lw < 1e-12) continue;
      const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw);
      if (Math.PI - Math.acos(Math.max(-1, Math.min(1, cos))) > maxAngle) continue;
    }
    targets.add(v);
  }
  for (let changed = true; changed && targets.size;) {
    changed = false;
    for (const face of m.faces) {
      if (face.filter((v) => !targets.has(v)).length >= 3) continue;
      for (const v of face) if (targets.delete(v)) changed = true;
    }
  }
  if (targets.size === 0) return;
  const recs = allFaceRecs(m);
  for (const rec of recs) {
    if (!rec.v.some((v) => targets.has(v))) continue;
    const keepIdx = rec.v.map((_, i) => i).filter((i) => !targets.has(rec.v[i]));
    rec.uv = rec.uv ? keepIdx.flatMap((i) => [rec.uv![i * 2], rec.uv![i * 2 + 1]]) : null;
    rec.v = keepIdx.map((i) => rec.v[i]);
  }
  writeFaces(m, recs);
  // Wire chains: a - v - b becomes a - b.
  let pairs: [number, number][] = [];
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) pairs.push([m.looseEdges[i], m.looseEdges[i + 1]]);
  for (const v of targets) {
    const hits = pairs.filter(([a, b]) => a === v || b === v);
    if (hits.length !== 2) continue;
    const a = hits[0][0] === v ? hits[0][1] : hits[0][0];
    const b = hits[1][0] === v ? hits[1][1] : hits[1][0];
    if (a === b) continue;
    pairs = pairs.filter((p) => p !== hits[0] && p !== hits[1]);
    pairs.push([a, b]);
  }
  m.looseEdges = pairs.flat();
  pruneEdgeData(m);
  removeUnusedAmong(m, targets);
}

/**
 * Dissolve vertices: the faces around each selected vertex are merged into one face and the vertex
 * is removed; vertices with exactly two edges are removed from the outline (joining the edges).
 */
export function dissolveVerts(src: MeshData, sel: MeshSelection): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.verts.size, 'vertices');
  const uf = new UnionFind(src.faces.length);
  const inGroup = new Uint8Array(src.faces.length);
  const valence2: number[] = [];
  for (const v of s.verts) {
    if (topo.vertEdges[v].length === 2) {
      valence2.push(v);
      continue;
    }
    const vf = topo.vertFaces[v];
    for (const f of vf) {
      inGroup[f] = 1;
      uf.union(vf[0], f);
    }
  }
  const groups = collectGroups(uf, inGroup);
  const m = cloneMesh(src);
  const { recs, merged } = mergeFaceGroups(src, allFaceRecs(src), groups);
  // Boundary vertices stay on the merged outline: drop them from it.
  for (const r of recs) {
    if (!r.sel) continue;
    const keepIdx = r.v.map((_, i) => i).filter((i) => !s.verts.has(r.v[i]));
    if (keepIdx.length >= 3 && keepIdx.length < r.v.length) {
      r.uv = r.uv ? keepIdx.flatMap((i) => [r.uv![i * 2], r.uv![i * 2 + 1]]) : null;
      r.v = keepIdx.map((i) => r.v[i]);
    }
  }
  writeFaces(m, recs);
  pruneEdgeData(m);
  const remap = removeUnusedAmong(m, s.verts);
  dissolveValence2(
    m,
    valence2.map((v) => remap[v]),
  );
  return { mesh: m, selection: selectionFromFaces(m, merged) };
}

function collectGroups(uf: UnionFind, member: Uint8Array): number[][] {
  const groups = new Map<number, number[]>();
  for (let f = 0; f < member.length; f++) {
    if (!member[f]) continue;
    const r = uf.find(f);
    const g = groups.get(r) ?? [];
    g.push(f);
    groups.set(r, g);
  }
  return [...groups.values()];
}

/**
 * Dissolve edges: the two faces of each selected manifold edge are merged. With `useVerts`,
 * vertices of dissolved edges that are left between two collinear edges are dissolved as well.
 */
export function dissolveEdges(
  src: MeshData,
  sel: MeshSelection,
  opts: { useVerts?: boolean } = {},
): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.edges.size, 'edges');
  const uf = new UnionFind(src.faces.length);
  const member = new Uint8Array(src.faces.length);
  const touched = new Set<number>();
  for (const k of s.edges) {
    const e = topo.edgeIndex.get(k)!;
    const ef = topo.edgeFaces[e];
    if (ef.length !== 2) continue;
    member[ef[0]] = member[ef[1]] = 1;
    uf.union(ef[0], ef[1]);
    touched.add(topo.edges[e][0]);
    touched.add(topo.edges[e][1]);
  }
  const m = cloneMesh(src);
  const { recs, merged } = mergeFaceGroups(src, allFaceRecs(src), collectGroups(uf, member));
  writeFaces(m, recs);
  pruneEdgeData(m);
  // Vertices that only existed inside the merged regions disappear.
  const remap = removeUnusedAmong(m, touched);
  if (opts.useVerts ?? true)
    dissolveValence2(
      m,
      [...touched].map((v) => remap[v]),
      COLLINEAR_LIMIT,
    );
  return { mesh: m, selection: selectionFromFaces(m, merged) };
}

/**
 * Dissolve faces: each connected group of selected faces becomes a single face. With `useVerts`,
 * outline vertices left between two collinear edges are removed too.
 */
export function dissolveFaces(
  src: MeshData,
  sel: MeshSelection,
  opts: { useVerts?: boolean } = {},
): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.faces.size, 'faces');
  const uf = new UnionFind(src.faces.length);
  const member = new Uint8Array(src.faces.length);
  const touched = new Set<number>();
  for (const f of s.faces) {
    member[f] = 1;
    for (const v of src.faces[f]) touched.add(v);
    for (const e of topo.faceEdges[f]) {
      const ef = topo.edgeFaces[e];
      if (ef.length === 2 && s.faces.has(ef[0]) && s.faces.has(ef[1])) uf.union(ef[0], ef[1]);
    }
  }
  const m = cloneMesh(src);
  const { recs, merged } = mergeFaceGroups(src, allFaceRecs(src), collectGroups(uf, member));
  writeFaces(m, recs);
  pruneEdgeData(m);
  const remap = removeUnusedAmong(m, touched);
  if (opts.useVerts)
    dissolveValence2(
      m,
      [...touched].map((v) => remap[v]),
      COLLINEAR_LIMIT,
    );
  return { mesh: m, selection: selectionFromFaces(m, merged) };
}
