import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, edgeKey, parseEdgeKey, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology, type Topology } from '../topology';
import { faceCenter, faceNormal } from '../normals';
import type { MeshOpResult } from './types';
import {
  addVertexFrom,
  allFaceRecs,
  centroid,
  completeSelection,
  dkey,
  type FaceRec,
  makeFace,
  polygonNormal,
  pushTo,
  removeUnusedAmong,
  reverseFace,
  symmetricEigen3,
  UnionFind,
  vpos,
  writeFaces,
} from './util';

export interface BridgeOptions {
  /** Number of intermediate loops (equal vertex counts only). */
  cuts?: number;
  /** Shifts the vertex pairing of the second loop. */
  twist?: number;
}

interface Loop {
  verts: number[];
  closed: boolean;
  /** True when `verts` follows the winding of the faces along the loop; null without faces. */
  oriented: boolean;
}

function traverses(face: readonly number[], a: number, b: number): boolean {
  const i = face.indexOf(a);
  return i >= 0 && face[(i + 1) % face.length] === b;
}

/** Orders the vertices of a connected edge set that forms a simple cycle or path; null otherwise. */
function orderComponent(edges: [number, number][]): { verts: number[]; closed: boolean } | null {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    pushTo(adj, a, b);
    pushTo(adj, b, a);
  }
  if ([...adj.values()].some((n) => n.length > 2)) return null;
  const ends = [...adj.keys()].filter((v) => adj.get(v)!.length === 1);
  if (ends.length !== 0 && ends.length !== 2) return null;
  const start = ends.length ? ends[0] : adj.keys().next().value!;
  const verts = [start];
  let prev = -1;
  let cur = start;
  for (;;) {
    const next = adj.get(cur)!.find((w) => w !== prev);
    if (next === undefined || next === start) break;
    verts.push(next);
    prev = cur;
    cur = next;
  }
  return verts.length === adj.size ? { verts, closed: ends.length === 0 } : null;
}

function loopsFromSelection(
  src: MeshData,
  topo: Topology,
  sel: MeshSelection,
): { loops: Loop[]; regionFaces: Set<number> } {
  const regionFaces = new Set<number>();
  const loops: Loop[] = [];
  if (sel.faces.size) {
    const uf = new UnionFind(src.faces.length);
    for (const f of sel.faces) {
      regionFaces.add(f);
      for (const e of topo.faceEdges[f]) {
        const ef = topo.edgeFaces[e];
        if (ef.length === 2 && sel.faces.has(ef[0]) && sel.faces.has(ef[1])) uf.union(ef[0], ef[1]);
      }
    }
    const groups = new Map<number, number[]>();
    for (const f of sel.faces) pushTo(groups, uf.find(f), f);
    for (const group of groups.values()) {
      const half = new Set<number>();
      for (const f of group) {
        const face = src.faces[f];
        for (let i = 0; i < face.length; i++) half.add(dkey(face[i], face[(i + 1) % face.length]));
      }
      const next = new Map<number, number>();
      for (const f of group) {
        const face = src.faces[f];
        for (let i = 0; i < face.length; i++) {
          const a = face[i];
          const b = face[(i + 1) % face.length];
          if (!half.has(dkey(b, a))) next.set(a, b);
        }
      }
      const start = next.keys().next().value;
      if (start === undefined)
        throw new Error('Selected faces have no outline to bridge (select two separate face regions)');
      const chain = [start];
      for (let v = next.get(start)!; v !== start; v = next.get(v)!) {
        if (v === undefined || chain.length > next.size)
          throw new Error('Selected face regions must have a single outline');
        chain.push(v);
      }
      if (chain.length !== next.size)
        throw new Error('Selected face regions must have a single outline (no holes)');
      // Once the region is removed, the surrounding faces run along the outline in reverse.
      loops.push({ verts: chain.reverse(), closed: true, oriented: true });
    }
    return { loops, regionFaces };
  }
  const comps = new UnionFind(src.positions.length / 3);
  const edges: [number, number][] = [...sel.edges].map(parseEdgeKey);
  for (const [a, b] of edges) comps.union(a, b);
  const byRoot = new Map<number, [number, number][]>();
  for (const e of edges) pushTo(byRoot, comps.find(e[0]), e);
  for (const group of byRoot.values()) {
    const ordered = orderComponent(group);
    if (!ordered) throw new Error('Each selected edge loop must be a simple chain or cycle');
    let { verts } = ordered;
    let oriented = false;
    for (let i = 0; i + 1 < verts.length || (ordered.closed && i < verts.length); i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const ef = topo.edgeFaces[topo.edgeIndex.get(edgeKey(a, b))!];
      if (ef.length !== 1) continue;
      if (!traverses(src.faces[ef[0]], a, b)) verts = verts.reverse();
      oriented = true;
      break;
    }
    loops.push({ verts, closed: ordered.closed, oriented });
  }
  return { loops, regionFaces };
}

function dist2(p: Vec3, q: Vec3): number {
  return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
}

/**
 * Bridge Edge Loops: connects two (or more, in sequence) selected edge loops with a band of quads.
 * Loops can be closed or open; with selected faces their outlines are bridged and the faces
 * removed (e.g. two opposite faces of a cube become a tunnel). Loops with different vertex counts
 * are connected with triangles. Winding follows the neighbouring faces.
 */
export function bridgeEdgeLoops(src: MeshData, sel: MeshSelection, opts: BridgeOptions = {}): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const { loops, regionFaces } = loopsFromSelection(src, topo, s);
  if (loops.length < 2) throw new Error('Select two edge loops (or two face regions) to bridge');
  if (loops.length > 2) {
    const cs = loops.map((l) => centroid(l.verts.map((v) => vpos(src, v))));
    const c = centroid(cs);
    const C = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const p of cs)
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (p[i] - c[i]) * (p[j] - c[j]);
    const { values, vectors } = symmetricEigen3(C);
    const dir = vectors[values.indexOf(Math.max(...values))];
    const key = cs.map((p) => (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1] + (p[2] - c[2]) * dir[2]);
    const order = loops.map((_, i) => i).sort((i, j) => key[i] - key[j]);
    loops.splice(0, loops.length, ...order.map((i) => loops[i]));
  }
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const remaining = recs.map((r, f) => (regionFaces.has(f) ? null : r));
  const neighbourUV = (v: number): [number, number] => {
    for (const f of topo.vertFaces[v]) {
      const r = remaining[f];
      if (r?.uv) {
        const i = r.v.indexOf(v);
        return [r.uv[i * 2], r.uv[i * 2 + 1]];
      }
    }
    return [0, 0];
  };
  const like = (l: Loop): FaceRec | null => {
    for (const v of l.verts) for (const f of topo.vertFaces[v]) if (remaining[f]) return remaining[f];
    return regionFaces.size ? recs[[...regionFaces][0]] : null;
  };
  const added: FaceRec[] = [];
  for (let li = 0; li + 1 < loops.length; li++) {
    const L1 = loops[li];
    const L2 = loops[li + 1];
    if (L1.closed !== L2.closed) throw new Error('Cannot bridge a closed loop with an open chain');
    const inL1 = new Set(L1.verts);
    if (L2.verts.some((v) => inL1.has(v))) throw new Error('Cannot bridge edge loops that share vertices');
    const closed = L1.closed;
    const A = L1.verts.slice();
    let B = L2.verts.slice();
    // Winding: A runs with its faces, B against its faces (so the band is consistent with both).
    const fixA = L1.oriented;
    const fixB = L2.oriented;
    if (fixB) B.reverse();
    /** Whether two loops run in the same direction (parallel rings / chains). */
    const sameSense = (X: number[], Y: number[]): boolean => {
      const px = X.map((v) => vpos(src, v));
      const py = Y.map((v) => vpos(src, v));
      if (closed) {
        const nx = polygonNormal(px);
        const ny = polygonNormal(py);
        return nx[0] * ny[0] + nx[1] * ny[1] + nx[2] * ny[2] >= 0;
      }
      const a = px.length - 1;
      const b = py.length - 1;
      return dist2(px[0], py[0]) + dist2(px[a], py[b]) <= dist2(px[0], py[b]) + dist2(px[a], py[0]);
    };
    if (!fixA && fixB && !sameSense(A, B)) A.reverse();
    const freeB = !fixB;
    const band: FaceRec[] = [];
    const likeRec = like(L1) ?? like(L2);
    if (A.length === B.length) {
      const n = A.length;
      const PA = A.map((v) => vpos(src, v));
      let best = { cost: Infinity, off: 0, rev: false };
      for (const rev of freeB ? [false, true] : [false]) {
        const BB = rev ? B.slice().reverse() : B;
        const PB = BB.map((v) => vpos(src, v));
        for (let off = 0; off < (closed ? n : 1); off++) {
          let cost = 0;
          for (let i = 0; i < n; i++) cost += dist2(PA[i], PB[(i + off) % n]);
          if (cost < best.cost - 1e-12) best = { cost, off, rev };
        }
      }
      if (best.rev) B.reverse();
      const off = closed ? (((best.off + Math.round(opts.twist ?? 0)) % n) + n) % n : 0;
      B = B.map((_, i) => B[(i + off) % n]);
      const cuts = Math.max(0, Math.floor(opts.cuts ?? 0));
      const rings: number[][] = [A];
      const ringUV: [number, number][][] = [A.map(neighbourUV)];
      const uvB = B.map(neighbourUV);
      for (let c = 1; c <= cuts; c++) {
        const t = c / (cuts + 1);
        rings.push(
          A.map((a, i) => {
            const pa = vpos(src, a);
            const pb = vpos(src, B[i]);
            return addVertexFrom(
              m,
              [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t],
              [a, B[i]],
              [1 - t, t],
            );
          }),
        );
        ringUV.push(ringUV[0].map((u, i) => [u[0] + (uvB[i][0] - u[0]) * t, u[1] + (uvB[i][1] - u[1]) * t]));
      }
      rings.push(B);
      ringUV.push(uvB);
      for (let r = 0; r + 1 < rings.length; r++) {
        const R0 = rings[r];
        const R1 = rings[r + 1];
        const U0 = ringUV[r];
        const U1 = ringUV[r + 1];
        for (let i = 0; i < (closed ? n : n - 1); i++) {
          const j = (i + 1) % n;
          band.push(
            makeFace(
              m,
              [R0[j], R0[i], R1[i], R1[j]],
              likeRec,
              [...U0[j], ...U0[i], ...U1[i], ...U1[j]],
              true,
            ),
          );
        }
      }
    } else {
      // Different vertex counts: zip the loops together with triangles by arc length.
      if (freeB && !sameSense(A, B)) B.reverse();
      if (closed) {
        let k = 0;
        const a0 = vpos(src, A[0]);
        for (let i = 1; i < B.length; i++) if (dist2(a0, vpos(src, B[i])) < dist2(a0, vpos(src, B[k]))) k = i;
        B = B.map((_, i) => B[(i + k) % B.length]);
      }
      const param = (l: number[]): number[] => {
        const P = l.map((v) => vpos(src, v));
        const acc = [0];
        const segs = closed ? l.length : l.length - 1;
        for (let i = 0; i < segs; i++) acc.push(acc[i] + Math.sqrt(dist2(P[i], P[(i + 1) % l.length])));
        const total = acc[acc.length - 1] || 1;
        return acc.map((x) => x / total);
      };
      const tA = param(A);
      const tB = param(B);
      const nA = tA.length - 1;
      const nB = tB.length - 1;
      const at = (l: number[], i: number) => l[i % l.length];
      let i = 0;
      let j = 0;
      while (i < nA || j < nB) {
        if (j >= nB || (i < nA && tA[i + 1] <= tB[j + 1])) {
          const tri = [at(A, i + 1), at(A, i), at(B, j)];
          band.push(makeFace(m, tri, likeRec, tri.flatMap(neighbourUV), true));
          i++;
        } else {
          const tri = [at(A, i), at(B, j), at(B, j + 1)];
          band.push(makeFace(m, tri, likeRec, tri.flatMap(neighbourUV), true));
          j++;
        }
      }
    }
    if (!fixA && !fixB) {
      // Free-standing loops: make the band face away from its center.
      const tmp = cloneMesh(m);
      writeFaces(tmp, band);
      const c = centroid([...A, ...B].map((v) => vpos(src, v)));
      let score = 0;
      for (let f = 0; f < tmp.faces.length; f++) {
        const n = faceNormal(tmp, f);
        const fc = faceCenter(tmp, f);
        score += n[0] * (fc[0] - c[0]) + n[1] * (fc[1] - c[1]) + n[2] * (fc[2] - c[2]);
      }
      if (score < 0) for (const r of band) reverseFace(r);
    }
    added.push(...band);
  }
  const kept = remaining.filter((r): r is FaceRec => r !== null);
  const selected = writeFaces(m, [...kept, ...added]);
  pruneEdgeData(m);
  removeUnusedAmong(
    m,
    [...regionFaces].flatMap((f) => src.faces[f]),
  );
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}
