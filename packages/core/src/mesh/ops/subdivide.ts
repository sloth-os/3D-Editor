import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh, edgeKey, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import { computeVertexNormals } from '../normals';
import type { MeshOpResult } from './types';
import { cutsFrom, type EdgeCuts, insertEdgeCuts, makeEdgeCuts, splitQuadStrip } from './loopcut';
import {
  addVertexFrom,
  allFaceRecs,
  completeSelection,
  copyEdgeAttr,
  type FaceRec,
  requireNonEmpty,
  uvOf,
  vpos,
  writeFaces,
} from './util';
import { unionSelection } from './select';

export interface SubdivideOptions {
  /** Number of cuts per selected edge (default 1). */
  cuts?: number;
  /** 0..1: displace new vertices to follow the curvature implied by the vertex normals. */
  smoothness?: number;
}

type Grid = { v: number; uv: [number, number] }[][];

/**
 * Subdivides the selected edges (Blender W › Subdivide). Faces with all edges selected are
 * split into grids (quads), triangle patterns (triangles) or corner quads around a center vertex
 * (n-gons); quads with two opposite selected edges are split into strips; every other face that
 * touches a cut edge gets the new vertices inserted into its outline, so no cracks appear.
 */
export function subdivide(src: MeshData, sel: MeshSelection, opts: SubdivideOptions = {}): MeshOpResult {
  const n = Math.max(1, Math.floor(opts.cuts ?? 1));
  const N = n + 1;
  const smooth = opts.smoothness ?? 0;
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const selEdge = new Uint8Array(topo.edges.length);
  let count = 0;
  for (const k of s.edges) {
    selEdge[topo.edgeIndex.get(k)!] = 1;
    count++;
  }
  requireNonEmpty(count, 'edges');
  const normals = smooth ? computeVertexNormals(src) : null;
  const m = cloneMesh(src);
  const taus: number[] = [];
  for (let j = 1; j <= n; j++) taus.push(j / N);
  const cuts = new Map<number, EdgeCuts>();
  const segKeys: string[] = [];
  for (let e = 0; e < topo.edges.length; e++) {
    if (!selEdge[e]) continue;
    const [a, b] = topo.edges[e];
    const c = makeEdgeCuts(m, src, a, b, taus, smooth, normals);
    cuts.set(e, c);
    const chain = [a, ...c.verts, b];
    for (let i = 0; i + 1 < chain.length; i++) {
      copyEdgeAttr(m, a, b, chain[i], chain[i + 1]);
      segKeys.push(edgeKey(chain[i], chain[i + 1]));
    }
  }
  const P = (v: number): Vec3 => vpos(m, v);
  const recs = allFaceRecs(src);
  const out: FaceRec[] = recs.slice();
  const extra: FaceRec[] = [];
  const emit = (f: number, list: FaceRec[]) => {
    out[f] = list[0];
    extra.push(...list.slice(1));
  };
  for (let f = 0; f < src.faces.length; f++) {
    const fe = topo.faceEdges[f];
    const mask = fe.map((e) => selEdge[e] === 1);
    const nsel = mask.filter(Boolean).length;
    if (nsel === 0) continue;
    const rec: FaceRec = { ...recs[f], sel: s.faces.has(f) };
    const fv = rec.v;
    const len = fv.length;
    const wrap = (list: FaceRec[]) => emit(f, list);
    if (nsel === len && len === 4) {
      // Grid of (N+1)^2 points with a Coons patch interior.
      const grid: Grid = [];
      const u = [0, 1, 2, 3].map((i) => uvOf(rec, i));
      const edgePts = (e: number, from: number) => cutsFrom(cuts.get(e)!, from).map((x) => x.v);
      const bottom = [fv[0], ...edgePts(fe[0], fv[0]), fv[1]];
      const right = [fv[1], ...edgePts(fe[1], fv[1]), fv[2]];
      const top = [fv[3], ...edgePts(fe[2], fv[3]), fv[2]];
      const left = [fv[0], ...edgePts(fe[3], fv[0]), fv[3]];
      const c = fv.map(P);
      for (let i = 0; i <= N; i++) {
        grid.push([]);
        for (let j = 0; j <= N; j++) {
          const x = i / N;
          const y = j / N;
          const uv: [number, number] = [
            (1 - x) * (1 - y) * u[0][0] + x * (1 - y) * u[1][0] + x * y * u[2][0] + (1 - x) * y * u[3][0],
            (1 - x) * (1 - y) * u[0][1] + x * (1 - y) * u[1][1] + x * y * u[2][1] + (1 - x) * y * u[3][1],
          ];
          let v: number;
          if (j === 0) v = bottom[i];
          else if (j === N) v = top[i];
          else if (i === 0) v = left[j];
          else if (i === N) v = right[j];
          else {
            const pb = P(bottom[i]);
            const pt = P(top[i]);
            const pl = P(left[j]);
            const pr = P(right[j]);
            const p: Vec3 = [0, 0, 0];
            for (let k = 0; k < 3; k++)
              p[k] =
                (1 - y) * pb[k] +
                y * pt[k] +
                (1 - x) * pl[k] +
                x * pr[k] -
                ((1 - x) * (1 - y) * c[0][k] +
                  x * (1 - y) * c[1][k] +
                  x * y * c[2][k] +
                  (1 - x) * y * c[3][k]);
            v = addVertexFrom(m, p, fv, [(1 - x) * (1 - y), x * (1 - y), x * y, (1 - x) * y]);
          }
          grid[i].push({ v, uv });
        }
      }
      const list: FaceRec[] = [];
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          const q = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]];
          list.push({
            v: q.map((g) => g.v),
            mat: rec.mat,
            smooth: rec.smooth,
            uv: rec.uv ? q.flatMap((g) => g.uv) : null,
            sel: rec.sel,
          });
        }
      wrap(list);
    } else if (nsel === len && len === 3) {
      // Triangular grid: P(i, j) = q0 + i/N (q1 - q0) + j/N (q2 - q0).
      const u = [0, 1, 2].map((i) => uvOf(rec, i));
      const e0 = [fv[0], ...cutsFrom(cuts.get(fe[0])!, fv[0]).map((x) => x.v), fv[1]];
      const e1 = [fv[1], ...cutsFrom(cuts.get(fe[1])!, fv[1]).map((x) => x.v), fv[2]];
      const e2 = [fv[0], ...cutsFrom(cuts.get(fe[2])!, fv[0]).map((x) => x.v), fv[2]];
      const idx: number[][] = [];
      for (let i = 0; i <= N; i++) {
        idx.push([]);
        for (let j = 0; i + j <= N; j++) {
          let v: number;
          if (j === 0) v = e0[i];
          else if (i + j === N) v = e1[j];
          else if (i === 0) v = e2[j];
          else {
            const k = N - i - j;
            const lerpP = (a: Vec3, b: Vec3, t: number): Vec3 => [
              a[0] + (b[0] - a[0]) * t,
              a[1] + (b[1] - a[1]) * t,
              a[2] + (b[2] - a[2]) * t,
            ];
            const p1 = lerpP(P(e2[j]), P(e1[j]), i / (N - j));
            const p2 = lerpP(P(e0[i]), P(e1[N - i]), j / (N - i));
            const p3 = lerpP(P(e0[N - k]), P(e2[N - k]), j / (N - k));
            const p: Vec3 = [
              (p1[0] + p2[0] + p3[0]) / 3,
              (p1[1] + p2[1] + p3[1]) / 3,
              (p1[2] + p2[2] + p3[2]) / 3,
            ];
            v = addVertexFrom(m, p, fv, [k / N, i / N, j / N]);
          }
          idx[i].push(v);
        }
      }
      const uvAt = (i: number, j: number): [number, number] => {
        const w0 = (N - i - j) / N;
        const w1 = i / N;
        const w2 = j / N;
        return [w0 * u[0][0] + w1 * u[1][0] + w2 * u[2][0], w0 * u[0][1] + w1 * u[1][1] + w2 * u[2][1]];
      };
      const list: FaceRec[] = [];
      const tri = (a: [number, number], b: [number, number], c: [number, number]) =>
        list.push({
          v: [idx[a[0]][a[1]], idx[b[0]][b[1]], idx[c[0]][c[1]]],
          mat: rec.mat,
          smooth: rec.smooth,
          uv: rec.uv ? [...uvAt(a[0], a[1]), ...uvAt(b[0], b[1]), ...uvAt(c[0], c[1])] : null,
          sel: rec.sel,
        });
      for (let i = 0; i < N; i++)
        for (let j = 0; i + j < N; j++) {
          tri([i, j], [i + 1, j], [i, j + 1]);
          if (i + j <= N - 2) tri([i + 1, j], [i + 1, j + 1], [i, j + 1]);
        }
      wrap(list);
    } else if (nsel === len) {
      // N-gon: center vertex and one polygon per original corner.
      const outline = insertEdgeCuts(rec, fe, cuts);
      const pts = outline.v.map(P);
      const ctr: Vec3 = [0, 0, 0];
      for (const p of pts) for (let k = 0; k < 3; k++) ctr[k] += p[k] / pts.length;
      const center = addVertexFrom(m, ctr, fv);
      let cu = 0;
      let cv = 0;
      for (let i = 0; i < len; i++) {
        cu += uvOf(rec, i)[0] / len;
        cv += uvOf(rec, i)[1] / len;
      }
      const h = Math.ceil(n / 2);
      const stride = n + 1; // outline: corner i at index i*stride, its cuts follow
      const list: FaceRec[] = [];
      const ol = outline.v.length;
      for (let i = 0; i < len; i++) {
        const corner = i * stride;
        const ids: number[] = [];
        for (let k = corner - (n + 1 - h); k <= corner + h; k++) ids.push(((k % ol) + ol) % ol);
        const v = [...ids.map((k) => outline.v[k]), center];
        const uv = outline.uv
          ? [...ids.flatMap((k) => [outline.uv![k * 2], outline.uv![k * 2 + 1]]), cu, cv]
          : null;
        list.push({ v, mat: rec.mat, smooth: rec.smooth, uv, sel: rec.sel });
      }
      wrap(list);
    } else if (len === 4 && nsel === 2 && mask[0] === mask[2]) {
      const k = mask[0] ? 0 : 1;
      wrap(splitQuadStrip(rec, k, cuts.get(fe[k])!, cuts.get(fe[k + 2])!));
    } else {
      wrap([insertEdgeCuts(rec, fe, cuts)]);
    }
  }
  // Loose (wire) edges become chains.
  const loose: number[] = [];
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2) {
    const a = src.looseEdges[i];
    const b = src.looseEdges[i + 1];
    const e = topo.edgeIndex.get(edgeKey(a, b));
    const c = e !== undefined ? cuts.get(e) : undefined;
    if (!c) {
      loose.push(a, b);
      continue;
    }
    const chain = [a, ...cutsFrom(c, a).map((x) => x.v), b];
    for (let k = 0; k + 1 < chain.length; k++) loose.push(chain[k], chain[k + 1]);
  }
  m.looseEdges = loose;
  const selFaces = writeFaces(m, [...out, ...extra]);
  pruneEdgeData(m);
  const result = unionSelection(selectionFromFaces(m, selFaces), {
    verts: new Set(s.verts),
    edges: new Set(segKeys),
    faces: new Set(),
  });
  for (const c of cuts.values()) for (const v of c.verts) result.verts.add(v);
  return { mesh: m, selection: result };
}
