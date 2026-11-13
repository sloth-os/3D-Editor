import type { MeshData } from '../types';
import { cloneMesh, createMesh, edgeKey, parseEdgeKey, pruneEdgeData } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromEdges, selectionFromFaces } from '../selection';
import { buildTopology, type Topology } from '../topology';
import { faceNormalRaw } from '../normals';
import { triangulateFaceCorners } from '../triangulate';
import type { MeshOpResult } from './types';
import {
  allFaceRecs,
  angularOrder,
  bestFitNormal,
  centroid,
  completeSelection,
  directedEdgeFaces,
  type FaceRec,
  makeFace,
  meshCentroid,
  orientationVote,
  polygonNormal,
  pushTo,
  requireNonEmpty,
  vpos,
  writeFaces,
} from './util';

/** Orders vertices along the selected edges if they form one cycle or one open path; else null. */
function orderAlongEdges(
  verts: number[],
  edges: Iterable<string>,
): { order: number[]; closed: boolean } | null {
  const vset = new Set(verts);
  const adj = new Map<number, number[]>();
  for (const v of verts) adj.set(v, []);
  for (const k of edges) {
    const [a, b] = parseEdgeKey(k);
    if (!vset.has(a) || !vset.has(b)) continue;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const ends = verts.filter((v) => adj.get(v)!.length === 1);
  if (verts.some((v) => adj.get(v)!.length > 2 || adj.get(v)!.length === 0)) return null;
  if (ends.length !== 0 && ends.length !== 2) return null;
  const start = ends.length ? ends[0] : verts[0];
  const order = [start];
  let prev = -1;
  let cur = start;
  for (;;) {
    const next = adj.get(cur)!.find((w) => w !== prev);
    if (next === undefined || next === start) break;
    order.push(next);
    prev = cur;
    cur = next;
  }
  if (order.length !== verts.length) return null;
  return { order, closed: ends.length === 0 };
}

/** UV of vertex v taken from the first face using it (for new faces next to existing ones). */
function neighbourUV(src: MeshData, topo: Topology, recs: FaceRec[], v: number): [number, number] {
  const f = topo.vertFaces[v]?.[0];
  if (f === undefined || !recs[f].uv) return [0, 0];
  const i = src.faces[f].indexOf(v);
  return [recs[f].uv![i * 2], recs[f].uv![i * 2 + 1]];
}

/**
 * Chooses the winding of a new face loop: opposite to the neighbouring faces along shared edges,
 * otherwise agreeing with the normals of faces around its vertices, otherwise facing away from the
 * mesh center. Returns the (possibly reversed) loop.
 */
function orientNewLoop(src: MeshData, topo: Topology, dmap: Map<number, number>, loop: number[]): number[] {
  let vote = orientationVote(dmap, loop);
  if (vote === 0) {
    const pts = loop.map((v) => vpos(src, v));
    const n = polygonNormal(pts);
    let acc = 0;
    for (const v of loop)
      for (const f of topo.vertFaces[v]) {
        const fn = faceNormalRaw(src, f);
        const l = Math.hypot(fn[0], fn[1], fn[2]) || 1;
        acc += (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2]) / l;
      }
    if (Math.abs(acc) > 1e-9) vote = acc > 0 ? 1 : -1;
    else if (src.faces.length) {
      const mc = meshCentroid(src);
      const c = centroid(pts);
      const d = (c[0] - mc[0]) * n[0] + (c[1] - mc[1]) * n[1] + (c[2] - mc[2]) * n[2];
      if (d < -1e-12) vote = -1;
    }
  }
  return vote < 0 ? loop.slice().reverse() : loop;
}

/**
 * Make Edge/Face (Blender F key): two selected vertices get a wire edge; three or more get a new
 * face. The vertex order follows the selected edges when they form a loop/path (e.g. a hole
 * outline) and the angular order around the best-fit plane otherwise. The face is wound
 * consistently with its neighbours.
 */
export function edgeFaceAdd(src: MeshData, sel: MeshSelection): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const verts = [...s.verts];
  if (verts.length < 2) throw new Error('Select at least two vertices');
  const m = cloneMesh(src);
  if (verts.length === 2) {
    const k = edgeKey(verts[0], verts[1]);
    if (topo.edgeIndex.has(k)) throw new Error('An edge already exists between the two selected vertices');
    m.looseEdges.push(verts[0], verts[1]);
    return { mesh: m, selection: selectionFromEdges(m, [k]) };
  }
  const along = orderAlongEdges(verts, s.edges);
  let loop: number[];
  if (along) loop = along.order;
  else {
    const pts = verts.map((v) => vpos(src, v));
    loop = angularOrder(pts, bestFitNormal(pts)).map((i) => verts[i]);
  }
  const sig = [...loop].sort((a, b) => a - b).join(',');
  for (const f of src.faces)
    if (f.length === loop.length && [...f].sort((a, b) => a - b).join(',') === sig)
      throw new Error('A face with these vertices already exists');
  loop = orientNewLoop(src, topo, directedEdgeFaces(src), loop);
  const recs = allFaceRecs(src);
  const likeFace = loop.map((v) => topo.vertFaces[v][0]).find((f) => f !== undefined);
  const face = makeFace(
    m,
    loop,
    likeFace !== undefined ? recs[likeFace] : null,
    loop.flatMap((v) => neighbourUV(src, topo, recs, v)),
    true,
  );
  const selected = writeFaces(m, [...recs, face]);
  pruneEdgeData(m); // wire edges that became face edges
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}

/** Closed loops formed by the given edges (components where every vertex has exactly two edges). */
export function edgeCycles(edges: [number, number][]): number[][] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    pushTo(adj, a, b);
    pushTo(adj, b, a);
  }
  const seen = new Set<number>();
  const cycles: number[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // Collect the component.
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (const w of adj.get(v)!)
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
    }
    if (comp.length < 3 || comp.some((v) => adj.get(v)!.length !== 2)) continue;
    const order = [start];
    let prev = -1;
    let cur = start;
    for (;;) {
      const nb = adj.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === start) break;
      order.push(next);
      prev = cur;
      cur = next;
      if (order.length > comp.length) break;
    }
    if (order.length === comp.length) cycles.push(order);
  }
  return cycles;
}

/**
 * Fill (Blender Alt+F): fills closed loops of selected boundary/wire edges with triangles,
 * wound consistently with the neighbouring faces. The new faces are selected.
 */
export function fillHoles(src: MeshData, sel: MeshSelection): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  const edges: [number, number][] = [];
  for (const k of s.edges) {
    const e = topo.edgeIndex.get(k)!;
    if (topo.edgeFaces[e].length <= 1) edges.push(topo.edges[e]);
  }
  const cycles = edgeCycles(edges);
  requireNonEmpty(cycles.length, 'closed boundary loops');
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  const dmap = directedEdgeFaces(src);
  const added: FaceRec[] = [];
  for (const cyc of cycles) {
    const loop = orientNewLoop(src, topo, dmap, cyc);
    const tmp = createMesh({ positions: src.positions, faces: [loop] });
    const tri = triangulateFaceCorners(tmp, 0);
    const likeFace = loop.map((v) => topo.vertFaces[v][0]).find((f) => f !== undefined);
    const like = likeFace !== undefined ? recs[likeFace] : null;
    for (let t = 0; t < tri.length; t += 3) {
      const v = [loop[tri[t]], loop[tri[t + 1]], loop[tri[t + 2]]];
      added.push(
        makeFace(
          m,
          v,
          like,
          v.flatMap((x) => neighbourUV(src, topo, recs, x)),
          true,
        ),
      );
    }
  }
  const selected = writeFaces(m, [...recs, ...added]);
  pruneEdgeData(m);
  return { mesh: m, selection: selectionFromFaces(m, selected) };
}
