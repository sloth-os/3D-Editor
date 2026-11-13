import type { Vec3 } from '../../math/types';
import type { EdgeAttr, MeshData } from '../types';
import { cloneMesh, edgeKey, parseEdgeKey, pruneEdgeData, vertexCount } from '../types';
import type { MeshSelection } from '../selection';
import { emptySelection, selectionFromVerts } from '../selection';
import { buildTopology } from '../topology';
import { mergeByDistance } from '../weld';
import type { MeshOpResult } from './types';
import {
  allFaceRecs,
  completeSelection,
  type FaceRec,
  mergeEdgeAttrs,
  pushTo,
  removeVertices,
  requireNonEmpty,
  UnionFind,
  vpos,
  writeFaces,
} from './util';

/**
 * Welds vertices: every vertex v is replaced by `target[v]` (a vertex with target[t] === t).
 * Faces lose collapsed corners (and are removed below three corners or when duplicated), wire
 * edges are remapped, edge attributes merged. Returns the new mesh and the old → new vertex map.
 */
export function weldVertices(src: MeshData, target: Int32Array): { mesh: MeshData; remap: Int32Array } {
  const m = cloneMesh(src);
  const out: FaceRec[] = [];
  const seen = new Set<string>();
  for (const rec of allFaceRecs(src)) {
    const v: number[] = [];
    const uv: number[] = [];
    for (let i = 0; i < rec.v.length; i++) {
      const t = target[rec.v[i]];
      if (v.includes(t)) continue;
      v.push(t);
      if (rec.uv) uv.push(rec.uv[i * 2], rec.uv[i * 2 + 1]);
    }
    if (v.length < 3) continue;
    const sig = [...v].sort((a, b) => a - b).join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ ...rec, v, uv: rec.uv ? uv : null });
  }
  writeFaces(m, out);
  const loose: number[] = [];
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2) {
    const a = target[src.looseEdges[i]];
    const b = target[src.looseEdges[i + 1]];
    if (a !== b) loose.push(a, b);
  }
  m.looseEdges = loose;
  const attrs: Record<string, EdgeAttr> = {};
  for (const k in src.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    const ta = target[a];
    const tb = target[b];
    if (ta === tb) continue;
    const nk = edgeKey(ta, tb);
    attrs[nk] = mergeEdgeAttrs(attrs[nk], src.edgeAttrs[k]);
  }
  m.edgeAttrs = attrs;
  pruneEdgeData(m);
  const n = vertexCount(src);
  const remove = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (target[i] !== i) remove[i] = 1;
  const compact = removeVertices(m, remove);
  const remap = new Int32Array(n);
  for (let i = 0; i < n; i++) remap[i] = compact[target[i]];
  return { mesh: m, remap };
}

export type MergeType = 'CENTER' | 'CURSOR' | 'COLLAPSE' | 'FIRST' | 'LAST';

/**
 * Merges selected vertices (Blender M menu): CENTER/CURSOR/FIRST/LAST merge all selected
 * vertices into one (at their median, the given cursor point, the first or the last selected
 * vertex); COLLAPSE merges each connected island of selected vertices at its median.
 * "First"/"last" follow the selection order (insertion order of `sel.verts`).
 */
export function mergeVertices(
  src: MeshData,
  sel: MeshSelection,
  type: MergeType,
  cursor?: Readonly<Vec3>,
): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const order = [...sel.verts].filter((v) => s.verts.has(v));
  const inOrder = new Set(order);
  for (const v of s.verts) if (!inOrder.has(v)) order.push(v);
  if (order.length < 2) requireNonEmpty(0, 'pair of vertices (need at least 2)');
  const n = vertexCount(src);
  const target = new Int32Array(n);
  for (let i = 0; i < n; i++) target[i] = i;
  const groups: number[][] = [];
  if (type === 'COLLAPSE') {
    const uf = new UnionFind(n);
    for (const [a, b] of topo.edges) if (s.verts.has(a) && s.verts.has(b)) uf.union(a, b);
    const byRoot = new Map<number, number[]>();
    for (const v of order) {
      const r = uf.find(v);
      pushTo(byRoot, r, v);
    }
    groups.push(...byRoot.values());
  } else groups.push(order);
  const m0 = cloneMesh(src);
  const survivors: number[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    let p: Vec3;
    let keep = Math.min(...g);
    if (type === 'FIRST' || type === 'LAST') {
      keep = type === 'FIRST' ? g[0] : g[g.length - 1];
      p = vpos(src, keep);
    } else if (type === 'CURSOR') {
      if (!cursor) throw new Error('Merge at cursor needs a cursor location');
      p = [cursor[0], cursor[1], cursor[2]];
    } else {
      p = [0, 0, 0];
      for (const v of g) for (let k = 0; k < 3; k++) p[k] += src.positions[v * 3 + k] / g.length;
    }
    for (let k = 0; k < 3; k++) m0.positions[keep * 3 + k] = p[k];
    if (m0.colors && type !== 'FIRST' && type !== 'LAST') {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (const v of g) acc += src.colors![v * 4 + c] / g.length;
        m0.colors[keep * 4 + c] = acc;
      }
    }
    for (const v of g) target[v] = keep;
    survivors.push(keep);
  }
  const { mesh, remap } = weldVertices(m0, target);
  return {
    mesh,
    selection: selectionFromVerts(
      mesh,
      survivors.map((v) => remap[v]).filter((v) => v >= 0),
    ),
  };
}

/**
 * Merge by distance (Blender "Remove Doubles") restricted to the selected vertices. Returns the
 * number of removed vertices too.
 */
export function removeDoubles(
  src: MeshData,
  sel: MeshSelection,
  threshold: number,
): MeshOpResult & { removed: number } {
  const s = completeSelection(src, sel);
  requireNonEmpty(s.verts.size, 'vertices');
  const { mesh, removed, remap } = mergeByDistance(src, threshold, s.verts);
  if (removed === 0) return { mesh, selection: selectionFromVerts(mesh, s.verts), removed };
  const verts = new Set<number>();
  for (const v of s.verts) if (remap[v] >= 0) verts.add(remap[v]);
  return { mesh, selection: verts.size ? selectionFromVerts(mesh, verts) : emptySelection(), removed };
}
