import { z } from 'zod';
import type { MeshData } from '../mesh/types';
import { compactVertices, edgeKey, vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import type { ModifierDef } from './registry';
import { DEG, MeshBuilder, UnionFind, faceNormalsOf, hasColors, makeRandom } from './util';

// ------------------------------------------------------------------ EDGE_SPLIT

const edgeSplitSchema = z.object({
  split_angle: z
    .number()
    .min(0)
    .max(Math.PI)
    .default(30 * DEG)
    .describe('Edges whose faces meet at a larger angle are split (radians)'),
  use_edge_angle: z.boolean().default(true).describe('Split edges sharper than split_angle'),
  use_edge_sharp: z.boolean().default(true).describe('Split edges marked sharp'),
});

/** Splits vertices along the given edges so the faces on both sides no longer share them. */
export function splitEdges(m: MeshData, isSplit: (e: number) => boolean): MeshData {
  const topo = buildTopology(m);
  const n = vertexCount(m);
  const uf = new UnionFind(topo.cornerCount);
  const cornerOf = (f: number, v: number) => topo.faceCornerStart[f] + m.faces[f].indexOf(v);
  let anySplit = false;
  for (let e = 0; e < topo.edges.length; e++) {
    const faces = topo.edgeFaces[e];
    if (faces.length < 2) continue;
    if (faces.length > 2 || isSplit(e)) {
      anySplit = true;
      continue;
    }
    const [a, b] = topo.edges[e];
    const [f, g] = faces;
    uf.union(cornerOf(f, a), cornerOf(g, a));
    uf.union(cornerOf(f, b), cornerOf(g, b));
  }
  if (!anySplit) return m;
  const colors = hasColors(m) ? m.colors! : null;
  const P = m.positions;
  const out = new MeshBuilder({ colors: !!colors, uvs: !!m.uvs });
  const classVertex = new Map<number, number>();
  const firstCopy = new Int32Array(n).fill(-1);
  const vertexOfCorner = new Int32Array(topo.cornerCount);
  // allocate vertices per original vertex, one per corner class (in order of appearance)
  const cornersOfVertex: number[][] = Array.from({ length: n }, () => []);
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    for (let i = 0; i < face.length; i++) cornersOfVertex[face[i]].push(topo.faceCornerStart[f] + i);
  }
  for (let v = 0; v < n; v++) {
    const cs = cornersOfVertex[v];
    if (cs.length === 0) {
      firstCopy[v] = out.addVertex(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], colors, v);
      continue;
    }
    for (const c of cs) {
      const r = uf.find(c);
      let idx = classVertex.get(r);
      if (idx === undefined) {
        idx = out.addVertex(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], colors, v);
        classVertex.set(r, idx);
        if (firstCopy[v] < 0) firstCopy[v] = idx;
      }
      vertexOfCorner[c] = idx;
    }
  }
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const verts = face.map((_, i) => vertexOfCorner[topo.faceCornerStart[f] + i]);
    out.addFace(verts, m.faceMaterials[f] ?? 0, m.faceSmooth[f] ?? false, m.uvs ? m.uvs[f].slice() : null);
    for (let i = 0; i < face.length; i++) {
      const attr = m.edgeAttrs[edgeKey(face[i], face[(i + 1) % face.length])];
      if (attr) out.setEdgeAttr(verts[i], verts[(i + 1) % face.length], attr);
    }
  }
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
    const a = firstCopy[m.looseEdges[i]];
    const b = firstCopy[m.looseEdges[i + 1]];
    out.addLooseEdge(a, b);
    out.setEdgeAttr(a, b, m.edgeAttrs[edgeKey(m.looseEdges[i], m.looseEdges[i + 1])]);
  }
  return out.build();
}

export const edgeSplitModifier: ModifierDef<typeof edgeSplitSchema> = {
  type: 'EDGE_SPLIT',
  label: 'Edge Split',
  category: 'GENERATE',
  description:
    'Disconnects faces along sharp edges (angle above `split_angle` and/or edges marked sharp) by duplicating the ' +
    'vertices, giving hard shading edges with smooth shading elsewhere. Positions are unchanged.',
  schema: edgeSplitSchema,
  apply(mesh, p) {
    if (!p.use_edge_angle && !p.use_edge_sharp) return mesh;
    const topo = buildTopology(mesh);
    const fn = faceNormalsOf(mesh);
    const cosLimit = Math.cos(p.split_angle);
    return splitEdges(mesh, (e) => {
      const [a, b] = topo.edges[e];
      if (p.use_edge_sharp && mesh.edgeAttrs[edgeKey(a, b)]?.sharp) return true;
      if (!p.use_edge_angle) return false;
      const [f, g] = topo.edgeFaces[e];
      const c = fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2];
      return c < cosLimit - 1e-9;
    });
  },
};

// ------------------------------------------------------------------ BUILD

const buildSchema = z.object({
  frame_start: z.number().default(1).describe('Frame at which the build starts'),
  frame_duration: z.number().min(1).default(100).describe('Number of frames the build takes'),
  use_reverse: z.boolean().default(false).describe('Deconstruct instead: start complete and remove faces'),
  use_random_order: z.boolean().default(false).describe('Add faces in a random (seeded) order'),
  seed: z.number().int().default(0),
});

export const buildModifier: ModifierDef<typeof buildSchema> = {
  type: 'BUILD',
  label: 'Build',
  category: 'GENERATE',
  description:
    'Animation (time dependent): shows a growing subset of the faces between `frame_start` and frame_start + ' +
    '`frame_duration` (in index order or a seeded random order); `use_reverse` makes the mesh disappear instead. ' +
    'Meshes without faces build their loose edges.',
  schema: buildSchema,
  timeDependent: true,
  apply(mesh, p, ctx) {
    const frac = Math.max(0, Math.min(1, (ctx.frame - p.frame_start) / p.frame_duration));
    const F = mesh.faces.length;
    const L = mesh.looseEdges.length / 2;
    const total = F > 0 ? F + L : L;
    if (total === 0) return mesh;
    const order = Array.from({ length: total }, (_, i) => i);
    if (p.use_random_order) {
      const rnd = makeRandom(p.seed);
      for (let i = total - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
      }
    }
    const built = Math.floor(frac * total + 1e-9);
    const count = p.use_reverse ? total - built : built;
    if (count >= total) return mesh;
    const visible = new Uint8Array(total);
    for (let i = 0; i < count; i++) visible[order[i]] = 1;
    const faceOffset = F > 0 ? 0 : -1;
    const keepFace = (f: number) => faceOffset === 0 && visible[f] === 1;
    const keepLoose = (l: number) => visible[F > 0 ? F + l : l] === 1;
    const out: MeshData = {
      positions: mesh.positions.slice(),
      colors: mesh.colors ? mesh.colors.slice() : null,
      faces: [],
      faceMaterials: [],
      faceSmooth: [],
      uvs: mesh.uvs ? [] : null,
      edgeAttrs: {},
      looseEdges: [],
    };
    for (let f = 0; f < F; f++) {
      if (!keepFace(f)) continue;
      out.faces.push(mesh.faces[f].slice());
      out.faceMaterials.push(mesh.faceMaterials[f] ?? 0);
      out.faceSmooth.push(mesh.faceSmooth[f] ?? false);
      if (out.uvs && mesh.uvs) out.uvs.push(mesh.uvs[f].slice());
    }
    for (let l = 0; l < L; l++)
      if (keepLoose(l)) out.looseEdges.push(mesh.looseEdges[l * 2], mesh.looseEdges[l * 2 + 1]);
    const edges = new Set<string>();
    for (const f of out.faces)
      for (let i = 0; i < f.length; i++) edges.add(edgeKey(f[i], f[(i + 1) % f.length]));
    for (let i = 0; i < out.looseEdges.length; i += 2)
      edges.add(edgeKey(out.looseEdges[i], out.looseEdges[i + 1]));
    for (const k in mesh.edgeAttrs) if (edges.has(k)) out.edgeAttrs[k] = { ...mesh.edgeAttrs[k] };
    compactVertices(out);
    return out;
  },
};
