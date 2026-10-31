import type { MeshData } from '../types';
import { cloneMesh, edgeKey, parseEdgeKey, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  type FaceRec,
  lerpUV,
  pushTo,
  removeUnusedAmong,
  reverseFace,
  uvOf,
  vpos,
  writeFaces,
} from './util';

export type SymmetrizeDirection =
  'NEGATIVE_X' | 'POSITIVE_X' | 'NEGATIVE_Y' | 'POSITIVE_Y' | 'NEGATIVE_Z' | 'POSITIVE_Z';

/**
 * Symmetrize (Blender Mesh › Symmetrize): the selected faces (all faces when none are selected)
 * are cut at the mirror plane through the object origin, the half on the target side is deleted
 * and replaced by a mirrored copy of the source half (NEGATIVE_X copies −X onto +X, ...).
 * Vertices within `threshold` of the plane are snapped onto it and shared by both halves.
 */
export function symmetrize(
  src: MeshData,
  sel: MeshSelection,
  direction: SymmetrizeDirection,
  threshold = 1e-4,
): MeshOpResult {
  const axis = direction.endsWith('X') ? 0 : direction.endsWith('Y') ? 1 : 2;
  const sign = direction.startsWith('NEGATIVE') ? -1 : 1;
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const useAll = s.faces.size === 0;
  const inSel = (f: number) => useAll || s.faces.has(f);
  const coord = (v: number) => src.positions[v * 3 + axis] * sign;
  const side = (v: number) => (coord(v) > threshold ? 1 : coord(v) < -threshold ? -1 : 0);
  const m = cloneMesh(src);
  // Snap vertices near the plane.
  const touched = new Set<number>();
  for (let f = 0; f < src.faces.length; f++) if (inSel(f)) for (const v of src.faces[f]) touched.add(v);
  const wireSel = (a: number, b: number) => useAll || (s.verts.has(a) && s.verts.has(b));
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2)
    if (wireSel(src.looseEdges[i], src.looseEdges[i + 1]))
      touched.add(src.looseEdges[i]).add(src.looseEdges[i + 1]);
  for (const v of touched) if (side(v) === 0) m.positions[v * 3 + axis] = 0;
  // Cut vertices on edges crossing the plane.
  const cut = new Map<string, number>();
  const cutVert = (a: number, b: number): number => {
    const k = edgeKey(a, b);
    let c = cut.get(k);
    if (c === undefined) {
      const ca = coord(a);
      const cb = coord(b);
      const t = ca / (ca - cb);
      const p: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < 3; i++)
        p[i] = src.positions[a * 3 + i] + (src.positions[b * 3 + i] - src.positions[a * 3 + i]) * t;
      p[axis] = 0;
      c = addVertexFrom(m, p, [a, b], [1 - t, t]);
      cut.set(k, c);
      const attr = src.edgeAttrs[k];
      if (attr) m.edgeAttrs[edgeKey(a, c)] = { ...attr };
    }
    return c;
  };
  const tOf = (a: number, b: number) => coord(a) / (coord(a) - coord(b));
  const recs = allFaceRecs(src);
  const out: FaceRec[] = [];
  const sourceFaces: FaceRec[] = [];
  for (let f = 0; f < recs.length; f++) {
    const rec = recs[f];
    if (!inSel(f)) {
      out.push(rec);
      continue;
    }
    const n = rec.v.length;
    const sides = rec.v.map(side);
    if (sides.every((x) => x <= 0) && sides.some((x) => x < 0)) continue; // entirely on the target side
    if (sides.every((x) => x === 0)) {
      out.push({ ...rec, sel: true }); // lies in the mirror plane: keep once
      continue;
    }
    const v: number[] = [];
    const uv: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (sides[i] >= 0) {
        v.push(rec.v[i]);
        uv.push(...uvOf(rec, i));
      }
      if (sides[i] * sides[j] < 0) {
        v.push(cutVert(rec.v[i], rec.v[j]));
        uv.push(...lerpUV(uvOf(rec, i), uvOf(rec, j), tOf(rec.v[i], rec.v[j])));
      }
    }
    if (v.length < 3) continue;
    const r: FaceRec = { ...rec, v, uv: rec.uv ? uv : null, sel: true };
    out.push(r);
    sourceFaces.push(r);
  }
  // Unselected faces that use a cut edge get the cut vertex in their outline.
  if (!useAll && cut.size)
    for (const r of out) {
      if (r.sel) continue;
      const v: number[] = [];
      const uv: number[] = [];
      for (let i = 0; i < r.v.length; i++) {
        const j = (i + 1) % r.v.length;
        v.push(r.v[i]);
        uv.push(...uvOf(r, i));
        const c = cut.get(edgeKey(r.v[i], r.v[j]));
        if (c !== undefined) {
          v.push(c);
          uv.push(...lerpUV(uvOf(r, i), uvOf(r, j), tOf(r.v[i], r.v[j])));
        }
      }
      r.v = v;
      if (r.uv) r.uv = uv;
    }
  // Mirror the source half. With a partial selection, mirrored vertices that land on vertices of
  // the remaining (unselected) geometry on the target side are welded to them.
  const cell = Math.max(threshold * 2, 1e-6);
  const cellKey = (p: readonly number[]) => p.map((x) => Math.floor(x / cell)).join(',');
  const keep = new Map<string, number[]>();
  if (!useAll)
    for (const r of out) {
      if (r.sel) continue;
      for (const v of r.v)
        if (v < src.positions.length / 3 && side(v) < 0) pushTo(keep, cellKey(vpos(m, v)), v);
    }
  const existingAt = (p: readonly number[]): number | undefined => {
    const c = p.map((x) => Math.floor(x / cell));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const v of keep.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
            const q = vpos(m, v);
            if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= threshold) return v;
          }
    return undefined;
  };
  const mirror = new Map<number, number>();
  const mirrorOf = (v: number): number => {
    if (Math.abs(m.positions[v * 3 + axis]) <= 0) return v;
    let w = mirror.get(v);
    if (w === undefined) {
      const p: [number, number, number] = [
        m.positions[v * 3],
        m.positions[v * 3 + 1],
        m.positions[v * 3 + 2],
      ];
      p[axis] = -p[axis];
      w = existingAt(p) ?? addVertexFrom(m, p, [v]);
      mirror.set(v, w);
    }
    return w;
  };
  for (const r of sourceFaces) {
    out.push(reverseFace({ ...r, v: r.v.map(mirrorOf), uv: r.uv ? r.uv.slice() : null, sel: true }));
  }
  // Wire edges: keep the source half and mirror it.
  const loose: number[] = [];
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2) {
    const a = src.looseEdges[i];
    const b = src.looseEdges[i + 1];
    if (!wireSel(a, b)) {
      loose.push(a, b);
      continue;
    }
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0 && sb <= 0 && (sa < 0 || sb < 0)) continue;
    let pa = a;
    let pb = b;
    if (sa * sb < 0) {
      if (sa < 0) pa = cutVert(a, b);
      else pb = cutVert(a, b);
    }
    loose.push(pa, pb);
    const ma = mirrorOf(pa);
    const mb = mirrorOf(pb);
    if (ma !== pa || mb !== pb) loose.push(ma, mb);
  }
  m.looseEdges = loose;
  // Mirror edge attributes of the source half.
  for (const k of Object.keys(m.edgeAttrs)) {
    const [a, b] = parseEdgeKey(k);
    const ma = mirror.get(a) ?? a;
    const mb = mirror.get(b) ?? b;
    if (ma !== a || mb !== b) m.edgeAttrs[edgeKey(ma, mb)] = { ...m.edgeAttrs[k] };
  }
  const selected = writeFaces(m, out);
  pruneEdgeData(m);
  removeUnusedAmong(m, touched);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}
