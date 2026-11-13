import { z } from 'zod';
import { invert4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { compactVertices, parseEdgeKey, pruneEdgeData, vertexCount } from '../mesh/types';
import { buildTopology, faceIslands } from '../mesh/topology';
import type { ModifierDef } from './registry';
import {
  MeshBuilder,
  UnionFind,
  axisIndex,
  det3,
  hasColors,
  mergeVerticesByMap,
  ownerToObjectSpace,
  reverseUVPairs,
  transformPositions,
  zAxis,
  zObjectRef,
} from './util';

const schema = z.object({
  angle: z
    .number()
    .default(2 * Math.PI)
    .describe('Total rotation per iteration in radians (2π = full revolution)'),
  steps: z.number().int().min(1).max(10000).default(16).describe('Segments per iteration in the viewport'),
  render_steps: z.number().int().min(1).max(10000).default(16).describe('Segments per iteration for renders'),
  axis: zAxis('Z').describe('Local rotation axis'),
  screw_offset: z
    .number()
    .default(0)
    .describe('Distance moved along the axis per iteration (helix / screw thread)'),
  iterations: z.number().int().min(1).max(1000).default(1).describe('Number of times the screw is repeated'),
  use_merge_vertices: z.boolean().default(false).describe('Merge vertices that lie on the axis'),
  merge_threshold: z.number().min(0).default(0.01),
  use_normal_flip: z.boolean().default(false).describe('Flip the normals of the generated surface'),
  use_normal_calculate: z
    .boolean()
    .default(false)
    .describe('Accepted for compatibility (orientation is always computed)'),
  use_smooth_shade: z.boolean().default(true).describe('Smooth shading for the generated faces'),
  use_stretch_u: z.boolean().default(false).describe('Accepted for compatibility (no effect)'),
  use_stretch_v: z.boolean().default(false).describe('Accepted for compatibility (no effect)'),
  object: zObjectRef('Object whose local axis is used as rotation axis'),
});

type ScrewParams = z.infer<typeof schema>;

interface Chain {
  verts: number[];
  closed: boolean;
}

/** Orders an undirected edge list into chains/cycles (branch points start new chains). */
function edgeChains(edges: [number, number][]): Chain[] {
  const adj = new Map<number, number[]>();
  edges.forEach(([a, b], i) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(i);
    adj.get(b)!.push(i);
  });
  const used = new Uint8Array(edges.length);
  const chains: Chain[] = [];
  const walk = (start: number, firstEdge: number): Chain => {
    const verts = [start];
    let cur = start;
    let e = firstEdge;
    for (;;) {
      used[e] = 1;
      const [a, b] = edges[e];
      cur = a === cur ? b : a;
      if (cur === start) return { verts, closed: true };
      verts.push(cur);
      const nexts = adj.get(cur)!.filter((x) => !used[x]);
      if (adj.get(cur)!.length !== 2 || nexts.length === 0) return { verts, closed: false };
      e = nexts[0];
    }
  };
  for (const [v, es] of adj) {
    if (es.length === 2) continue;
    for (const e of es) if (!used[e]) chains.push(walk(v, e));
  }
  for (let e = 0; e < edges.length; e++) if (!used[e]) chains.push(walk(edges[e][0], e));
  return chains;
}

export function screwMesh(
  mesh: MeshData,
  p: ScrewParams,
  stepsPerIteration: number,
  toSpace: number[] | null,
): MeshData {
  const n = vertexCount(mesh);
  const q = toSpace ? transformPositions(mesh.positions, toSpace) : mesh.positions.slice();
  const A = axisIndex(p.axis);
  const U = (A + 1) % 3;
  const V = (A + 2) % 3;
  const full = Math.abs(Math.abs(p.angle) - 2 * Math.PI) < 1e-6;
  const closed = full && p.screw_offset === 0;
  const iters = closed ? 1 : p.iterations;
  const totalSteps = stepsPerIteration * iters;
  const totalAngle = p.angle * iters;
  const totalOffset = p.screw_offset * iters;
  const K = closed ? totalSteps : totalSteps + 1;
  if (K * n > 5_000_000) throw new Error(`Screw result too large (${K * n} vertices)`);
  const sgn = totalAngle < 0 ? -1 : 1;
  const colors = hasColors(mesh) ? mesh.colors! : null;
  const b = new MeshBuilder({ colors: !!colors, uvs: !!mesh.uvs });
  for (let k = 0; k < K; k++) {
    const th = (totalAngle * k) / totalSteps;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const off = (totalOffset * k) / totalSteps;
    for (let v = 0; v < n; v++) {
      const pt = [0, 0, 0];
      const u = q[v * 3 + U];
      const w = q[v * 3 + V];
      pt[U] = u * c - w * s;
      pt[V] = u * s + w * c;
      pt[A] = q[v * 3 + A] + off;
      b.addVertex(pt[0], pt[1], pt[2], colors, v);
    }
  }
  const idx = (k: number, v: number) => (closed ? k % K : k) * n + v;
  const topo = buildTopology(mesh);
  if (mesh.looseEdges.length === 0 && !topo.edgeFaces.some((f) => f.length === 1)) return mesh; // nothing to sweep
  // rotation tangent at point (axis × point), scaled by the rotation direction
  const tangent = (x: number[]) => {
    const t = [0, 0, 0];
    t[U] = -x[V] * sgn;
    t[V] = x[U] * sgn;
    return t;
  };
  const uvParam = new Map<string, [number, number]>(); // directed profile edge → v coordinates
  const assignUV = (chain: number[], isClosed: boolean) => {
    const len: number[] = [0];
    const m = isClosed ? chain.length : chain.length - 1;
    for (let i = 0; i < m; i++) {
      const a = chain[i];
      const c = chain[(i + 1) % chain.length];
      len.push(
        len[i] + Math.hypot(q[a * 3] - q[c * 3], q[a * 3 + 1] - q[c * 3 + 1], q[a * 3 + 2] - q[c * 3 + 2]),
      );
    }
    const total = len[len.length - 1] || 1;
    for (let i = 0; i < m; i++)
      uvParam.set(`${chain[i]},${chain[(i + 1) % chain.length]}`, [len[i] / total, len[i + 1] / total]);
  };
  const lathe = (a: number, c: number, material: number, smooth: boolean) => {
    const vv = uvParam.get(`${a},${c}`) ?? [0, 1];
    for (let k = 0; k < totalSteps; k++) {
      const uv = mesh.uvs
        ? [
            k / totalSteps,
            vv[0],
            k / totalSteps,
            vv[1],
            (k + 1) / totalSteps,
            vv[1],
            (k + 1) / totalSteps,
            vv[0],
          ]
        : null;
      b.addFace([idx(k, a), idx(k, c), idx(k + 1, c), idx(k + 1, a)], material, smooth, uv);
    }
  };

  // --- face profiles: caps + lathed boundary edges
  const boundaryNext = new Map<number, number>();
  const boundaryFace = new Map<string, number>();
  // Orientation is decided per connected face island (area-weighted), so neighbouring faces always agree:
  // when the island's normals point along the sweep direction, the start cap must be reversed.
  const faceFlip = new Uint8Array(mesh.faces.length);
  const islands = faceIslands(mesh, topo);
  const islandScore = new Float64Array(islands.count);
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    const ctr = [0, 0, 0];
    for (const v of face) for (let k = 0; k < 3; k++) ctr[k] += q[v * 3 + k] / face.length;
    const t = tangent(ctr);
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < face.length; i++) {
      const a = face[i] * 3;
      const b = face[(i + 1) % face.length] * 3;
      nx += (q[a + 1] - q[b + 1]) * (q[a + 2] + q[b + 2]);
      ny += (q[a + 2] - q[b + 2]) * (q[a] + q[b]);
      nz += (q[a] - q[b]) * (q[a + 1] + q[b + 1]);
    }
    islandScore[islands.islandOf[f]] += nx * t[0] + ny * t[1] + nz * t[2];
  }
  for (let f = 0; f < mesh.faces.length; f++) faceFlip[f] = islandScore[islands.islandOf[f]] > 0 ? 1 : 0;
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) {
      if (topo.edgeFaces[topo.faceEdges[f][i]].length !== 1) continue;
      // lathe in the direction that matches the cap orientation
      const a = face[i];
      const c = face[(i + 1) % face.length];
      const [from, to] = faceFlip[f] ? [a, c] : [c, a];
      boundaryNext.set(from, to);
      boundaryFace.set(`${from},${to}`, f);
    }
  }
  if (mesh.uvs) {
    const seen = new Set<number>();
    for (const start of boundaryNext.keys()) {
      if (seen.has(start)) continue;
      const chain: number[] = [];
      let cur = start;
      while (!seen.has(cur) && boundaryNext.has(cur)) {
        seen.add(cur);
        chain.push(cur);
        cur = boundaryNext.get(cur)!;
      }
      assignUV(chain, cur === start);
    }
  }
  for (const [key, f] of boundaryFace) {
    const [from, to] = key.split(',').map(Number);
    lathe(from, to, mesh.faceMaterials[f] ?? 0, p.use_smooth_shade);
  }
  if (!closed) {
    for (let f = 0; f < mesh.faces.length; f++) {
      const face = mesh.faces[f];
      const uv = mesh.uvs ? mesh.uvs[f] : null;
      const start = face.map((v) => idx(0, v));
      const end = face.map((v) => idx(K - 1, v));
      const mat = mesh.faceMaterials[f] ?? 0;
      const smooth = mesh.faceSmooth[f] ?? false;
      if (faceFlip[f]) {
        b.addFace(start.reverse(), mat, smooth, uv ? reverseUVPairs(uv) : null);
        b.addFace(end, mat, smooth, uv ? uv.slice() : null);
      } else {
        b.addFace(start, mat, smooth, uv ? uv.slice() : null);
        b.addFace(end.reverse(), mat, smooth, uv ? reverseUVPairs(uv) : null);
      }
    }
  }

  // --- loose edge profiles, oriented so normals face away from the axis (or out of closed loops)
  const loose: [number, number][] = [];
  for (let i = 0; i + 1 < mesh.looseEdges.length; i += 2)
    loose.push([mesh.looseEdges[i], mesh.looseEdges[i + 1]]);
  for (const chain of edgeChains(loose)) {
    const vs = chain.verts;
    const m = chain.closed ? vs.length : vs.length - 1;
    if (m < 1) continue;
    const centroid = [0, 0, 0];
    for (const v of vs) for (let k = 0; k < 3; k++) centroid[k] += q[v * 3 + k] / vs.length;
    let score = 0;
    for (let i = 0; i < m; i++) {
      const a = vs[i];
      const c = vs[(i + 1) % vs.length];
      const d = [q[c * 3] - q[a * 3], q[c * 3 + 1] - q[a * 3 + 1], q[c * 3 + 2] - q[a * 3 + 2]];
      const mid = [0, 1, 2].map((k) => (q[a * 3 + k] + q[c * 3 + k]) / 2);
      const t = tangent(mid);
      const nrm = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
      const out = chain.closed ? [0, 1, 2].map((k) => mid[k] - centroid[k]) : [0, 0, 0];
      if (!chain.closed) {
        out[U] = mid[U];
        out[V] = mid[V];
      }
      score += nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2];
    }
    const ordered = score < 0 ? vs.slice().reverse() : vs;
    if (mesh.uvs) assignUV(ordered, chain.closed);
    for (let i = 0; i < m; i++) lathe(ordered[i], ordered[(i + 1) % ordered.length], 0, p.use_smooth_shade);
  }
  // profile edge attributes are repeated on every copy
  for (const key in mesh.edgeAttrs) {
    const [a, c] = parseEdgeKey(key);
    if (a >= n || c >= n) continue;
    for (let k = 0; k < K; k++) b.setEdgeAttr(idx(k, a), idx(k, c), mesh.edgeAttrs[key]);
  }
  let out = b.build();
  if (p.use_merge_vertices && totalOffset === 0) {
    const uf = new UnionFind(vertexCount(out));
    let any = false;
    for (let v = 0; v < n; v++) {
      if (Math.hypot(q[v * 3 + U], q[v * 3 + V]) > p.merge_threshold) continue;
      for (let k = 1; k < K; k++) uf.union(idx(0, v), idx(k, v));
      any = true;
    }
    if (any) out = mergeVerticesByMap(out, uf.roots());
  }
  const flipAll = p.use_normal_flip !== (toSpace ? det3(toSpace) < 0 : false);
  if (flipAll) {
    out.faces = out.faces.map((f) => f.slice().reverse());
    if (out.uvs) out.uvs = out.uvs.map(reverseUVPairs);
  }
  if (toSpace) out.positions = transformPositions(out.positions, invert4(toSpace));
  pruneEdgeData(out);
  compactVertices(out);
  return out;
}

export const screwModifier: ModifierDef<typeof schema> = {
  type: 'SCREW',
  label: 'Screw',
  category: 'GENERATE',
  description:
    'Lathe/screw: sweeps profile geometry around the local `axis` (or the axis of `object`) by `angle` in `steps` ' +
    'segments, optionally moving `screw_offset` along the axis per turn (springs, threads) and repeating ' +
    '`iterations` times. Profiles are loose edges (e.g. a curve drawn as wire edges) and/or faces: face boundaries ' +
    'are swept and partial sweeps get start/end caps, giving closed solids. Normals face away from the axis.',
  schema,
  dependencies: (p) => (p.object ? [p.object] : []),
  apply(mesh, p, ctx) {
    if (vertexCount(mesh) === 0 || (p.angle === 0 && p.screw_offset === 0)) return mesh;
    const toSpace = p.object ? ownerToObjectSpace(ctx, p.object) : null;
    return screwMesh(mesh, p, ctx.forRender ? p.render_steps : p.steps, toSpace);
  },
};
