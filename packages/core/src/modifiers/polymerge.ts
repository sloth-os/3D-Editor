import type { EdgeAttr, MeshData } from '../mesh/types';
import { edgeKey, parseEdgeKey, vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import { UnionFind, cleanEdgeAttr, hasColors } from './util';

/*
 * Polygon merging utilities: greedy merging of adjacent faces into larger n-gons (used by the Boolean
 * result clean-up and planar decimation) and dissolving of redundant vertices on straight edges.
 */

interface Loop {
  verts: number[];
  uvs: number[] | null;
}

/**
 * Merges two consistently wound loops that share one contiguous chain of edges (traversed in opposite
 * directions). Returns null when they share no edge, share several separate chains, the result would not be
 * a simple loop, or (with `uvTolerance`) the corner UVs along the chain differ.
 */
export function mergeLoops(A: Loop, B: Loop, uvTolerance = -1): Loop | null {
  const a = A.verts;
  const b = B.verts;
  const nA = a.length;
  const nB = b.length;
  const posB = new Map<number, number>();
  for (let j = 0; j < nB; j++) {
    if (posB.has(b[j])) return null;
    posB.set(b[j], j);
  }
  const shared = new Uint8Array(nA);
  let count = 0;
  for (let i = 0; i < nA; i++) {
    const j = posB.get(a[(i + 1) % nA]);
    if (j !== undefined && b[(j + 1) % nB] === a[i]) {
      shared[i] = 1;
      count++;
    }
  }
  if (count === 0 || count >= nA || count >= nB) return null;
  let s = -1;
  let starts = 0;
  for (let i = 0; i < nA; i++) {
    if (shared[i] && !shared[(i + nA - 1) % nA]) {
      starts++;
      s = i;
    }
  }
  if (starts !== 1) return null;
  const t = s + count; // chain covers edges s .. t-1, vertices a[s] .. a[t]
  const x = a[s];
  const y = a[t % nA];
  const u = posB.get(y)!;
  const w = posB.get(x)!;
  if ((w - u + nB) % nB !== count) return null;
  if (uvTolerance >= 0 && A.uvs && B.uvs) {
    for (let k = 0; k <= count; k++) {
      const ia = (s + k) % nA;
      const ib = (w - k + nB) % nB;
      if (
        Math.abs(A.uvs[ia * 2] - B.uvs[ib * 2]) > uvTolerance ||
        Math.abs(A.uvs[ia * 2 + 1] - B.uvs[ib * 2 + 1]) > uvTolerance
      )
        return null;
    }
  }
  const verts: number[] = [];
  const uvs: number[] | null = A.uvs && B.uvs ? [] : null;
  for (let k = 0; k <= nA - count; k++) {
    const i = (t + k) % nA;
    verts.push(a[i]);
    if (uvs) uvs.push(A.uvs![i * 2], A.uvs![i * 2 + 1]);
  }
  for (let k = 1; k < nB - count; k++) {
    const j = (w + k) % nB;
    verts.push(b[j]);
    if (uvs) uvs.push(B.uvs![j * 2], B.uvs![j * 2 + 1]);
  }
  if (verts.length < 3 || new Set(verts).size !== verts.length) return null;
  return { verts, uvs };
}

/**
 * Greedily merges faces along candidate pairs (faces sharing an edge), in the given order. Each merge must
 * keep the region a simple polygon. `canMerge(ra, rb)` receives the current region representatives (face
 * indices) and may veto. Material/smooth flags come from the region's first face. Vertices that end up
 * unused (interior to merged regions) are removed; other vertices are kept.
 */
export function mergeFaceRegions(
  m: MeshData,
  pairs: Iterable<[number, number]>,
  opts: {
    canMerge?: (ra: number, rb: number) => boolean;
    onMerge?: (root: number, other: number) => void;
    uvTolerance?: number;
  } = {},
): MeshData {
  const nf = m.faces.length;
  const loops: (Loop | null)[] = m.faces.map((f, i) => ({
    verts: f.slice(),
    uvs: m.uvs ? m.uvs[i].slice() : null,
  }));
  const uf = new UnionFind(nf);
  let merges = 0;
  for (const [f, g] of pairs) {
    const ra = uf.find(f);
    const rb = uf.find(g);
    if (ra === rb) continue;
    if (opts.canMerge && !opts.canMerge(ra, rb)) continue;
    const merged = mergeLoops(loops[ra]!, loops[rb]!, opts.uvTolerance ?? -1);
    if (!merged) continue;
    uf.union(ra, rb);
    const root = uf.find(ra);
    const other = root === ra ? rb : ra;
    loops[root] = merged;
    loops[other] = null;
    opts.onMerge?.(root, other);
    merges++;
  }
  if (merges === 0) return m;
  const faces: number[][] = [];
  const faceMaterials: number[] = [];
  const faceSmooth: boolean[] = [];
  const uvs: number[][] | null = m.uvs ? [] : null;
  for (let f = 0; f < nf; f++) {
    const l = loops[f];
    if (!l) continue;
    faces.push(l.verts);
    faceMaterials.push(m.faceMaterials[f] ?? 0);
    faceSmooth.push(m.faceSmooth[f] ?? false);
    if (uvs) uvs.push(l.uvs ?? new Array(l.verts.length * 2).fill(0));
  }
  const out: MeshData = { ...m, faces, faceMaterials, faceSmooth, uvs, edgeAttrs: { ...m.edgeAttrs } };
  return removeOrphanedVertices(m, out);
}

/** Removes vertices that were used by faces of `before` but are no longer used by `after` (same vertex set). */
export function removeOrphanedVertices(before: MeshData, after: MeshData): MeshData {
  const n = vertexCount(after);
  const usedBefore = new Uint8Array(n);
  const usedAfter = new Uint8Array(n);
  for (const f of before.faces) for (const v of f) usedBefore[v] = 1;
  for (const f of after.faces) for (const v of f) usedAfter[v] = 1;
  for (const v of after.looseEdges) usedAfter[v] = 1;
  const remap = new Int32Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) if (usedAfter[i] || !usedBefore[i]) remap[i] = next++;
  const faceEdgeSet = new Set<string>();
  const faces = after.faces.map((f) => f.map((v) => remap[v]));
  for (const f of faces)
    for (let i = 0; i < f.length; i++) faceEdgeSet.add(edgeKey(f[i], f[(i + 1) % f.length]));
  const looseEdges = after.looseEdges.map((v) => remap[v]);
  for (let i = 0; i + 1 < looseEdges.length; i += 2)
    faceEdgeSet.add(edgeKey(looseEdges[i], looseEdges[i + 1]));
  const edgeAttrs: Record<string, EdgeAttr> = {};
  for (const k in after.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    if (a >= n || b >= n || remap[a] < 0 || remap[b] < 0) continue;
    const nk = edgeKey(remap[a], remap[b]);
    if (faceEdgeSet.has(nk)) edgeAttrs[nk] = { ...after.edgeAttrs[k] };
  }
  if (next === n) return { ...after, faces, looseEdges, edgeAttrs };
  const pos = new Array<number>(next * 3);
  const colors = hasColors(after) ? after.colors! : null;
  const col = colors ? new Array<number>(next * 4) : null;
  for (let i = 0; i < n; i++) {
    const j = remap[i];
    if (j < 0) continue;
    for (let k = 0; k < 3; k++) pos[j * 3 + k] = after.positions[i * 3 + k];
    if (col && colors) for (let k = 0; k < 4; k++) col[j * 4 + k] = colors[i * 4 + k];
  }
  return { ...after, positions: pos, colors: col, faces, looseEdges, edgeAttrs };
}

/**
 * Dissolves vertices that only connect two face edges which are (nearly) collinear — the angle between the
 * two edges deviates from a straight line by at most `maxAngle` radians. Faces keep at least 3 corners.
 */
export function dissolveStraightVertices(m: MeshData, maxAngle: number): MeshData {
  const topo = buildTopology(m);
  const n = vertexCount(m);
  const P = m.positions;
  const size = m.faces.map((f) => f.length);
  const remove = new Uint8Array(n);
  const cosLimit = Math.cos(Math.PI - maxAngle);
  let any = false;
  for (let v = 0; v < n; v++) {
    const es = topo.vertEdges[v];
    if (es.length !== 2) continue;
    if (topo.edgeFaces[es[0]].length === 0 || topo.edgeFaces[es[1]].length === 0) continue;
    const a = topo.edges[es[0]][0] === v ? topo.edges[es[0]][1] : topo.edges[es[0]][0];
    const b = topo.edges[es[1]][0] === v ? topo.edges[es[1]][1] : topo.edges[es[1]][0];
    const ax = P[a * 3] - P[v * 3];
    const ay = P[a * 3 + 1] - P[v * 3 + 1];
    const az = P[a * 3 + 2] - P[v * 3 + 2];
    const bx = P[b * 3] - P[v * 3];
    const by = P[b * 3 + 1] - P[v * 3 + 1];
    const bz = P[b * 3 + 2] - P[v * 3 + 2];
    const la = Math.hypot(ax, ay, az);
    const lb = Math.hypot(bx, by, bz);
    if (la < 1e-30 || lb < 1e-30) continue;
    const c = (ax * bx + ay * by + az * bz) / (la * lb);
    if (c > cosLimit) continue; // not straight enough
    const fs = topo.vertFaces[v];
    if (fs.some((f) => size[f] <= 3)) continue;
    for (const f of fs) size[f]--;
    remove[v] = 1;
    any = true;
  }
  if (!any) return m;
  const faces: number[][] = [];
  const uvs: number[][] | null = m.uvs ? [] : null;
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const uv = m.uvs ? m.uvs[f] : null;
    const nf: number[] = [];
    const nuv: number[] = [];
    for (let i = 0; i < face.length; i++) {
      if (remove[face[i]]) continue;
      nf.push(face[i]);
      if (uv) nuv.push(uv[i * 2], uv[i * 2 + 1]);
    }
    faces.push(nf);
    if (uvs) uvs.push(nuv);
  }
  // edge attributes survive on the merged edge when both halves carried them
  const edgeAttrs: Record<string, EdgeAttr> = {};
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    if (!remove[a] && !remove[b]) edgeAttrs[k] = { ...m.edgeAttrs[k] };
  }
  for (let v = 0; v < n; v++) {
    if (!remove[v]) continue;
    const [e0, e1] = topo.vertEdges[v];
    const k0 = edgeKey(topo.edges[e0][0], topo.edges[e0][1]);
    const k1 = edgeKey(topo.edges[e1][0], topo.edges[e1][1]);
    const a0 = cleanEdgeAttr(m.edgeAttrs[k0]);
    const a1 = cleanEdgeAttr(m.edgeAttrs[k1]);
    if (!a0 || !a1) continue;
    // walk to the surviving endpoints
    const end = (from: number, e: number): number => {
      let cur = topo.edges[e][0] === from ? topo.edges[e][1] : topo.edges[e][0];
      let prev = from;
      let guard = 0;
      while (remove[cur] && guard++ < n) {
        const es = topo.vertEdges[cur];
        const nextE = es.find((x) => !topo.edges[x].includes(prev)) ?? es[0];
        prev = cur;
        cur = topo.edges[nextE][0] === cur ? topo.edges[nextE][1] : topo.edges[nextE][0];
      }
      return cur;
    };
    const ea = end(v, e0);
    const eb = end(v, e1);
    if (ea !== eb) {
      const merged: EdgeAttr = {};
      if (a0.seam && a1.seam) merged.seam = true;
      if (a0.sharp && a1.sharp) merged.sharp = true;
      if (a0.crease && a1.crease) merged.crease = Math.min(a0.crease, a1.crease);
      const c = cleanEdgeAttr(merged);
      if (c) edgeAttrs[edgeKey(ea, eb)] = c;
    }
  }
  const out: MeshData = {
    ...m,
    faces,
    uvs,
    edgeAttrs,
    faceMaterials: m.faceMaterials.slice(),
    faceSmooth: m.faceSmooth.slice(),
  };
  return removeOrphanedVertices(m, out);
}
