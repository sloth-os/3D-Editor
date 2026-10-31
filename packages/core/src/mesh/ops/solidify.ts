import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import { faceNormal } from '../normals';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  copyEdgeAttr,
  type FaceRec,
  makeFace,
  requireNonEmpty,
  reverseFace,
  uvOf,
  vpos,
  writeFaces,
} from './util';

/**
 * Solidify the selected faces (edit-mode "Solidify"): a copy of the selected region is offset by
 * `thickness` against the face normals (shell factor keeps the thickness even), flipped, and
 * joined to the original along the region outline. A single plane becomes a closed box.
 * The new (back) faces are selected.
 */
export function solidifyFaces(src: MeshData, sel: MeshSelection, thickness: number): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const faces = [...s.faces].sort((a, b) => a - b);
  requireNonEmpty(faces.length, 'faces');
  const inR = new Uint8Array(src.faces.length);
  for (const f of faces) inR[f] = 1;
  const regionCount = new Int32Array(topo.edges.length);
  for (const f of faces) for (const e of topo.faceEdges[f]) regionCount[e]++;
  const fn = new Map<number, Vec3>();
  const acc = new Map<number, Vec3>();
  for (const f of faces) {
    const n = faceNormal(src, f);
    fn.set(f, n);
    for (const v of src.faces[f]) {
      const a = acc.get(v) ?? [0, 0, 0];
      acc.set(v, [a[0] + n[0], a[1] + n[1], a[2] + n[2]]);
    }
  }
  const m = cloneMesh(src);
  const copy = new Map<number, number>();
  for (const [v, a] of acc) {
    const l = Math.hypot(a[0], a[1], a[2]);
    const n: Vec3 = l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
    let dot = 0;
    let cnt = 0;
    for (const f of topo.vertFaces[v]) {
      const nf = fn.get(f);
      if (!nf) continue;
      dot += n[0] * nf[0] + n[1] * nf[1] + n[2] * nf[2];
      cnt++;
    }
    const k = thickness / Math.max(0.25, cnt ? dot / cnt : 1);
    const p = vpos(src, v);
    copy.set(v, addVertexFrom(m, [p[0] - n[0] * k, p[1] - n[1] * k, p[2] - n[2] * k], [v]));
  }
  const recs = allFaceRecs(src);
  const added: FaceRec[] = [];
  for (const f of faces) {
    const rec = recs[f];
    const face = src.faces[f];
    added.push(
      reverseFace({
        ...rec,
        v: face.map((v) => copy.get(v)!),
        uv: rec.uv ? rec.uv.slice() : null,
        sel: true,
      }),
    );
    for (let i = 0; i < face.length; i++) {
      if (regionCount[topo.faceEdges[f][i]] !== 1) continue;
      const j = (i + 1) % face.length;
      const a = face[i];
      const b = face[j];
      added.push(
        makeFace(m, [b, a, copy.get(a)!, copy.get(b)!], rec, [
          ...uvOf(rec, j),
          ...uvOf(rec, i),
          ...uvOf(rec, i),
          ...uvOf(rec, j),
        ]),
      );
      copyEdgeAttr(m, a, b, copy.get(a)!, copy.get(b)!);
    }
  }
  const selected = writeFaces(m, [...recs, ...added]);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}
