import type { MeshData } from '../types';
import { cloneMesh, edgeKey, pruneEdgeData } from '../types';
import { selectionFromVerts } from '../selection';
import { buildTopology, type Topology } from '../topology';
import { computeVertexNormals } from '../normals';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  copyEdgeAttr,
  curvatureOffset,
  type FaceRec,
  lerpUV,
  uvOf,
  vpos,
  writeFaces,
} from './util';

/** New vertices placed along an edge, oriented from `s` to `t`. */
export interface EdgeCuts {
  s: number;
  t: number;
  verts: number[];
  /** Parameter of each cut measured from `s` (0..1). */
  taus: number[];
}

/** Cut vertices of an edge ordered from vertex `from`, with parameters measured from `from`. */
export function cutsFrom(c: EdgeCuts, from: number): { v: number; tau: number }[] {
  const out = c.verts.map((v, i) => ({ v, tau: c.taus[i] }));
  if (from === c.s) return out;
  return out.reverse().map((x) => ({ v: x.v, tau: 1 - x.tau }));
}

/**
 * Creates the cut vertices of an edge (s→t) at the given parameters, displaced by `smoothness`
 * along the curvature implied by the vertex normals.
 */
export function makeEdgeCuts(
  m: MeshData,
  src: MeshData,
  s: number,
  t: number,
  taus: number[],
  smoothness: number,
  normals: number[] | null,
): EdgeCuts {
  const ps = vpos(src, s);
  const pt = vpos(src, t);
  const verts = taus.map((tau) => {
    const p: [number, number, number] = [
      ps[0] + (pt[0] - ps[0]) * tau,
      ps[1] + (pt[1] - ps[1]) * tau,
      ps[2] + (pt[2] - ps[2]) * tau,
    ];
    if (normals && smoothness) {
      const d = curvatureOffset(src, normals, [s, t], [1 - tau, tau], p, 0.5 * smoothness);
      p[0] += d[0];
      p[1] += d[1];
      p[2] += d[2];
    }
    return addVertexFrom(m, p, [s, t], [1 - tau, tau]);
  });
  return { s, t, verts, taus };
}

/**
 * Inserts the cut vertices of all cut edges of a face into its loop (no further splitting), with
 * interpolated UVs. Used for faces adjacent to cut edges so no T-junctions are created.
 */
export function insertEdgeCuts(
  rec: FaceRec,
  faceEdges: readonly number[],
  cuts: Map<number, EdgeCuts>,
): FaceRec {
  const v: number[] = [];
  const uv: number[] | null = rec.uv ? [] : null;
  const n = rec.v.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    v.push(rec.v[i]);
    const ui = uvOf(rec, i);
    if (uv) uv.push(ui[0], ui[1]);
    const c = cuts.get(faceEdges[i]);
    if (!c) continue;
    const uj = uvOf(rec, j);
    for (const { v: cv, tau } of cutsFrom(c, rec.v[i])) {
      v.push(cv);
      if (uv) uv.push(...lerpUV(ui, uj, tau));
    }
  }
  return { ...rec, v, uv };
}

/**
 * Splits a quad whose edges at corner index k (k→k+1) and k+2 (k+2→k+3) are both cut (with the
 * same number of cuts) into a strip of quads.
 */
export function splitQuadStrip(rec: FaceRec, k: number, c1: EdgeCuts, c2: EdgeCuts): FaceRec[] {
  const q = [0, 1, 2, 3].map((i) => rec.v[(k + i) % 4]);
  const u = [0, 1, 2, 3].map((i) => uvOf(rec, (k + i) % 4));
  const a = cutsFrom(c1, q[0]);
  const b = cutsFrom(c2, q[3]);
  const rungs: { c: number; d: number; uc: [number, number]; ud: [number, number] }[] = [
    { c: q[0], d: q[3], uc: u[0], ud: u[3] },
  ];
  for (let j = 0; j < a.length; j++)
    rungs.push({ c: a[j].v, d: b[j].v, uc: lerpUV(u[0], u[1], a[j].tau), ud: lerpUV(u[3], u[2], b[j].tau) });
  rungs.push({ c: q[1], d: q[2], uc: u[1], ud: u[2] });
  const out: FaceRec[] = [];
  for (let j = 0; j + 1 < rungs.length; j++) {
    const r0 = rungs[j];
    const r1 = rungs[j + 1];
    out.push({
      v: [r0.c, r1.c, r1.d, r0.d],
      mat: rec.mat,
      smooth: rec.smooth,
      uv: rec.uv ? [...r0.uc, ...r1.uc, ...r1.ud, ...r0.ud] : null,
      sel: rec.sel,
    });
  }
  return out;
}

interface OrientedEdge {
  e: number;
  s: number;
  t: number;
}

/**
 * Oriented quad edge ring through edge (a, b): every ring edge is oriented so that cut parameters
 * line up across the ring. Returns the ring edges and the quads with the corner index of their
 * first ring edge.
 */
export function orientedEdgeRing(
  m: MeshData,
  topo: Topology,
  a: number,
  b: number,
): { edges: OrientedEdge[]; quads: { f: number; k: number }[]; closed: boolean } {
  const e0 = topo.edgeIndex.get(edgeKey(a, b));
  if (e0 === undefined) throw new Error(`Edge [${a}, ${b}] does not exist`);
  const seenE = new Set<number>([e0]);
  const seenF = new Set<number>();
  const walk = (f0: number, outE: OrientedEdge[], outQ: { f: number; k: number }[]): boolean => {
    let s = a;
    let t = b;
    let f = f0;
    for (;;) {
      const face = m.faces[f];
      if (face.length !== 4 || seenF.has(f)) return false;
      let k = 0;
      while (
        k < 4 &&
        !((face[k] === s && face[(k + 1) % 4] === t) || (face[k] === t && face[(k + 1) % 4] === s))
      )
        k++;
      if (k === 4) return false;
      seenF.add(f);
      outQ.push({ f, k });
      const [ns, nt] =
        face[k] === s ? [face[(k + 3) % 4], face[(k + 2) % 4]] : [face[(k + 2) % 4], face[(k + 3) % 4]];
      const ne = topo.edgeIndex.get(edgeKey(ns, nt))!;
      if (ne === e0) return true;
      if (seenE.has(ne)) return false;
      seenE.add(ne);
      outE.push({ e: ne, s: ns, t: nt });
      const ef = topo.edgeFaces[ne];
      if (ef.length !== 2) return false;
      s = ns;
      t = nt;
      f = ef[0] === f ? ef[1] : ef[0];
    }
  };
  const ef = topo.edgeFaces[e0];
  const fwdE: OrientedEdge[] = [];
  const fwdQ: { f: number; k: number }[] = [];
  const bwdE: OrientedEdge[] = [];
  const bwdQ: { f: number; k: number }[] = [];
  let closed = false;
  if (ef.length >= 1 && ef.length <= 2) {
    closed = walk(ef[0], fwdE, fwdQ);
    if (!closed && ef.length === 2) walk(ef[1], bwdE, bwdQ);
  }
  return { edges: [...bwdE.reverse(), { e: e0, s: a, t: b }, ...fwdE], quads: [...bwdQ, ...fwdQ], closed };
}

export interface LoopCutOptions {
  /** Number of parallel loops to insert (default 1). */
  cuts?: number;
  /** 0..1: displace the new loops to follow the surface curvature. */
  smoothness?: number;
  /**
   * Edge slide for a single cut, -1..1 (0 = centered). Positive values move the loop towards the
   * second vertex of `edge`.
   */
  factor?: number;
}

/**
 * Loop cut (Ctrl+R): inserts `cuts` edge loops across the quad edge ring through `edge`.
 * Faces at the ends of an open ring (triangles, n-gons) receive the new vertices in their outline.
 * The new loop vertices are selected.
 */
export function loopCut(
  src: MeshData,
  edge: readonly [number, number],
  opts: LoopCutOptions = {},
): MeshOpResult {
  const n = Math.max(1, Math.floor(opts.cuts ?? 1));
  const topo = buildTopology(src);
  const ring = orientedEdgeRing(src, topo, edge[0], edge[1]);
  if (ring.quads.length === 0) throw new Error('Loop cut needs at least one quad adjacent to the edge');
  const taus: number[] = [];
  for (let j = 1; j <= n; j++) taus.push(j / (n + 1));
  if (n === 1 && opts.factor) taus[0] = Math.min(0.99, Math.max(0.01, 0.5 + 0.5 * opts.factor));
  const smooth = opts.smoothness ?? 0;
  const normals = smooth ? computeVertexNormals(src) : null;
  const m = cloneMesh(src);
  const cuts = new Map<number, EdgeCuts>();
  const newVerts: number[] = [];
  for (const re of ring.edges) {
    const c = makeEdgeCuts(m, src, re.s, re.t, taus, smooth, normals);
    cuts.set(re.e, c);
    newVerts.push(...c.verts);
    const chain = [re.s, ...c.verts, re.t];
    for (let i = 0; i + 1 < chain.length; i++) copyEdgeAttr(m, re.s, re.t, chain[i], chain[i + 1]);
  }
  const recs = allFaceRecs(src);
  const out: FaceRec[] = recs.slice();
  const extra: FaceRec[] = [];
  const ringFaces = new Set<number>();
  for (const { f, k } of ring.quads) {
    ringFaces.add(f);
    const fe = topo.faceEdges[f];
    const strip = splitQuadStrip(recs[f], k, cuts.get(fe[k])!, cuts.get(fe[(k + 2) % 4])!);
    out[f] = strip[0];
    extra.push(...strip.slice(1));
  }
  for (let f = 0; f < src.faces.length; f++) {
    if (ringFaces.has(f)) continue;
    if (topo.faceEdges[f].some((e) => cuts.has(e))) out[f] = insertEdgeCuts(recs[f], topo.faceEdges[f], cuts);
  }
  writeFaces(m, [...out, ...extra]);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromVerts(m, newVerts) };
}
