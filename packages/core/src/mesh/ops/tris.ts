import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, edgeKey, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import { faceNormal } from '../normals';
import { triangulateFaceCorners } from '../triangulate';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  type FaceRec,
  requireNonEmpty,
  uvOf,
  vpos,
  writeFaces,
} from './util';

export type QuadMethod = 'BEAUTY' | 'FIXED' | 'FIXED_ALTERNATE' | 'SHORTEST_DIAGONAL' | 'LONGEST_DIAGONAL';
export type NgonMethod = 'BEAUTY' | 'CLIP';

function dist2(m: MeshData, a: number, b: number): number {
  const dx = m.positions[a * 3] - m.positions[b * 3];
  const dy = m.positions[a * 3 + 1] - m.positions[b * 3 + 1];
  const dz = m.positions[a * 3 + 2] - m.positions[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

function subFace(rec: FaceRec, corners: number[]): FaceRec {
  return {
    v: corners.map((i) => rec.v[i]),
    mat: rec.mat,
    smooth: rec.smooth,
    uv: rec.uv ? corners.flatMap((i) => uvOf(rec, i)) : null,
    sel: rec.sel,
  };
}

/** Triangulates the selected faces (Ctrl+T). Corner UVs are kept; new triangles are selected. */
export function quadsToTris(
  src: MeshData,
  sel: MeshSelection,
  opts: { quadMethod?: QuadMethod; ngonMethod?: NgonMethod } = {},
): MeshOpResult {
  const s = completeSelection(src, sel);
  requireNonEmpty(s.faces.size, 'faces');
  const qm = opts.quadMethod ?? 'BEAUTY';
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const out: FaceRec[] = recs.slice();
  const extra: FaceRec[] = [];
  for (const f of s.faces) {
    const rec = { ...recs[f], sel: true };
    const n = rec.v.length;
    let tris: number[];
    if (n === 3) tris = [0, 1, 2];
    else if (n === 4 && qm === 'FIXED') tris = [0, 1, 2, 0, 2, 3];
    else if (n === 4 && qm === 'FIXED_ALTERNATE') tris = [0, 1, 3, 1, 2, 3];
    else if (n === 4 && qm === 'LONGEST_DIAGONAL')
      tris =
        dist2(src, rec.v[0], rec.v[2]) >= dist2(src, rec.v[1], rec.v[3])
          ? [0, 1, 2, 0, 2, 3]
          : [0, 1, 3, 1, 2, 3];
    else tris = triangulateFaceCorners(src, f);
    const list: FaceRec[] = [];
    for (let t = 0; t + 2 < tris.length; t += 3) list.push(subFace(rec, [tris[t], tris[t + 1], tris[t + 2]]));
    if (list.length === 0) list.push(rec);
    out[f] = list[0];
    extra.push(...list.slice(1));
  }
  const selected = writeFaces(m, [...out, ...extra]);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}

export interface JoinTrianglesOptions {
  /** Maximum angle (radians) between the two triangle normals. Default 40°. */
  faceThreshold?: number;
  /** Maximum deviation (radians) of the resulting quad's corner angles from 90°. Default 40°. */
  shapeThreshold?: number;
  /** Do not join across UV discontinuities / seams / sharp edges / material changes. */
  uvs?: boolean;
  seam?: boolean;
  sharp?: boolean;
  materials?: boolean;
}

function angleBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

/**
 * Joins pairs of adjacent selected triangles into quads (Alt+J). Candidate pairs are ranked by
 * flatness and squareness; only convex quads within the thresholds are created.
 */
export function trisToQuads(
  src: MeshData,
  sel: MeshSelection,
  opts: JoinTrianglesOptions = {},
): MeshOpResult {
  const faceT = opts.faceThreshold ?? (40 * Math.PI) / 180;
  const shapeT = opts.shapeThreshold ?? (40 * Math.PI) / 180;
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.faces.size, 'faces');
  const recs = allFaceRecs(src);
  const isTri = (f: number) => s.faces.has(f) && src.faces[f].length === 3;
  const candidates: { f: number; g: number; quad: FaceRec; err: number }[] = [];
  for (let e = 0; e < topo.edges.length; e++) {
    const ef = topo.edgeFaces[e];
    if (ef.length !== 2 || !isTri(ef[0]) || !isTri(ef[1])) continue;
    const [f, g] = ef;
    const [a, b] = topo.edges[e];
    const attr = src.edgeAttrs[edgeKey(a, b)];
    if ((opts.seam && attr?.seam) || (opts.sharp && attr?.sharp)) continue;
    if (opts.materials && recs[f].mat !== recs[g].mat) continue;
    // Rotate f so that its shared edge is corners 0→1: f = (x, y, c); g contains y→x.
    const fv = src.faces[f];
    let k = 0;
    while (
      k < 3 &&
      !(fv[k] !== fv[(k + 1) % 3] && [a, b].includes(fv[k]) && [a, b].includes(fv[(k + 1) % 3]))
    )
      k++;
    const x = fv[k];
    const y = fv[(k + 1) % 3];
    const c = fv[(k + 2) % 3];
    const gv = src.faces[g];
    const gi = gv.indexOf(y);
    if (gv[(gi + 1) % 3] !== x) continue; // inconsistent winding
    const d = gv[(gi + 2) % 3];
    if (opts.uvs && src.uvs) {
      const fx = uvOf(recs[f], k);
      const fy = uvOf(recs[f], (k + 1) % 3);
      const gy = uvOf(recs[g], gi);
      const gx = uvOf(recs[g], (gi + 1) % 3);
      if (Math.hypot(fx[0] - gx[0], fx[1] - gx[1]) > 1e-5 || Math.hypot(fy[0] - gy[0], fy[1] - gy[1]) > 1e-5)
        continue;
    }
    const nf = faceNormal(src, f);
    const ng = faceNormal(src, g);
    const faceErr = angleBetween(nf, ng);
    if (faceErr > faceT + 1e-9) continue;
    // Quad outline: y → c → x → d.
    const quadV = [y, c, x, d];
    const pts = quadV.map((v) => vpos(src, v));
    const qn: Vec3 = [nf[0] + ng[0], nf[1] + ng[1], nf[2] + ng[2]];
    let shapeErr = 0;
    let convex = true;
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      const u: Vec3 = [pts[(i + 3) % 4][0] - p[0], pts[(i + 3) % 4][1] - p[1], pts[(i + 3) % 4][2] - p[2]];
      const w: Vec3 = [pts[(i + 1) % 4][0] - p[0], pts[(i + 1) % 4][1] - p[1], pts[(i + 1) % 4][2] - p[2]];
      const cr: Vec3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
      if (cr[0] * qn[0] + cr[1] * qn[1] + cr[2] * qn[2] <= 1e-12) convex = false;
      const lu = Math.hypot(u[0], u[1], u[2]);
      const lw = Math.hypot(w[0], w[1], w[2]);
      if (lu < 1e-12 || lw < 1e-12) convex = false;
      else
        shapeErr = Math.max(
          shapeErr,
          Math.abs(
            angleBetween([u[0] / lu, u[1] / lu, u[2] / lu], [w[0] / lw, w[1] / lw, w[2] / lw]) - Math.PI / 2,
          ),
        );
    }
    if (!convex || shapeErr > shapeT + 1e-9) continue;
    const uv = recs[f].uv
      ? [
          ...uvOf(recs[f], (k + 1) % 3),
          ...uvOf(recs[f], (k + 2) % 3),
          ...uvOf(recs[f], k),
          ...uvOf(recs[g], (gi + 2) % 3),
        ]
      : null;
    candidates.push({
      f,
      g,
      quad: { v: quadV, mat: recs[f].mat, smooth: recs[f].smooth, uv, sel: true },
      err: faceErr + shapeErr,
    });
  }
  candidates.sort((p, q) => p.err - q.err);
  const used = new Uint8Array(src.faces.length);
  const replace = new Map<number, FaceRec>();
  const removed = new Set<number>();
  for (const c of candidates) {
    if (used[c.f] || used[c.g]) continue;
    used[c.f] = used[c.g] = 1;
    replace.set(c.f, c.quad);
    removed.add(c.g);
  }
  const m = cloneMesh(src);
  const out: FaceRec[] = [];
  for (let f = 0; f < recs.length; f++) {
    if (removed.has(f)) continue;
    out.push(replace.get(f) ?? (s.faces.has(f) ? { ...recs[f], sel: true } : recs[f]));
  }
  const selected = writeFaces(m, out);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}

export type PokeCenterMode = 'MEDIAN_WEIGHTED' | 'MEDIAN' | 'BOUNDS';

/**
 * Poke faces: every selected face becomes a fan of triangles around a new center vertex, which can
 * be offset along the face normal (`relative`: offset is multiplied by the average center-corner
 * distance).
 */
export function pokeFaces(
  src: MeshData,
  sel: MeshSelection,
  opts: { offset?: number; relative?: boolean; centerMode?: PokeCenterMode } = {},
): MeshOpResult {
  const s = completeSelection(src, sel);
  requireNonEmpty(s.faces.size, 'faces');
  const mode = opts.centerMode ?? 'MEDIAN_WEIGHTED';
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const out: FaceRec[] = recs.slice();
  const extra: FaceRec[] = [];
  for (const f of s.faces) {
    const rec = recs[f];
    const n = rec.v.length;
    const pts = rec.v.map((v) => vpos(src, v));
    let w = new Array<number>(n).fill(1);
    if (mode === 'MEDIAN_WEIGHTED') {
      const len = (i: number, j: number) =>
        Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]);
      w = pts.map((_, i) => len(i, (i + n - 1) % n) + len(i, (i + 1) % n));
      if (w.every((x) => x < 1e-12)) w.fill(1);
    }
    const tw = w.reduce((a, b) => a + b, 0);
    let c: Vec3 = [0, 0, 0];
    if (mode === 'BOUNDS') {
      const lo: Vec3 = [Infinity, Infinity, Infinity];
      const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const p of pts)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
      c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    } else for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += (pts[i][k] * w[i]) / tw;
    let off = opts.offset ?? 0;
    if (opts.relative)
      off *= pts.reduce((a, p) => a + Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]), 0) / n;
    const nrm = faceNormal(src, f);
    const cv = addVertexFrom(m, [c[0] + nrm[0] * off, c[1] + nrm[1] * off, c[2] + nrm[2] * off], rec.v, w);
    let cu = 0;
    let cvv = 0;
    for (let i = 0; i < n; i++) {
      cu += (uvOf(rec, i)[0] * w[i]) / tw;
      cvv += (uvOf(rec, i)[1] * w[i]) / tw;
    }
    const list: FaceRec[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      list.push({
        v: [rec.v[i], rec.v[j], cv],
        mat: rec.mat,
        smooth: rec.smooth,
        uv: rec.uv ? [...uvOf(rec, i), ...uvOf(rec, j), cu, cvv] : null,
        sel: true,
      });
    }
    out[f] = list[0];
    extra.push(...list.slice(1));
  }
  const selected = writeFaces(m, [...out, ...extra]);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}
