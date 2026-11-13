import { z } from 'zod';
import type { MeshData } from '../mesh/types';
import { compactVertices, parseEdgeKey, vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import type { ModifierDef } from './registry';
import {
  MeshBuilder,
  evenOffsetFactors,
  faceNormalsOf,
  hasColors,
  reverseUVPairs,
  vertexNormalsOf,
} from './util';

const schema = z.object({
  thickness: z.number().default(0.01).describe('Shell thickness (negative values flip the side)'),
  offset: z
    .number()
    .min(-1)
    .max(1)
    .default(-1)
    .describe('Where the shell goes: -1 = inside (behind the normals), 0 = centered, 1 = outside'),
  use_even_offset: z.boolean().default(false).describe('Keep the thickness constant at sharp corners'),
  use_rim: z.boolean().default(true).describe('Close the gap between the two shells along open boundaries'),
  use_rim_only: z.boolean().default(false).describe('Only output the rim faces (no shells)'),
  use_flip_normals: z.boolean().default(false).describe('Flip the normals of the whole result'),
  use_quality_normals: z
    .boolean()
    .default(false)
    .describe('Accepted for compatibility (angle-weighted normals are always used)'),
  material_offset: z
    .number()
    .int()
    .default(0)
    .describe('Material index offset for the new (inner) shell faces'),
  material_offset_rim: z.number().int().default(0).describe('Material index offset for rim faces'),
  edge_crease_inner: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Crease weight for the inner boundary edges'),
  edge_crease_outer: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Crease weight for the outer boundary edges'),
  edge_crease_rim: z.number().min(0).max(1).default(0).describe('Crease weight for edges across the rim'),
});

type SolidifyParams = z.infer<typeof schema>;

export function solidifyMesh(m: MeshData, p: SolidifyParams): MeshData {
  const n = vertexCount(m);
  const P = m.positions;
  const fn = faceNormalsOf(m);
  const vn = vertexNormalsOf(m, fn);
  const even = p.use_even_offset ? evenOffsetFactors(m, vn, fn) : null;
  const colors = hasColors(m) ? m.colors! : null;
  const outerT = (p.thickness * (p.offset + 1)) / 2;
  const innerT = (p.thickness * (p.offset - 1)) / 2;
  const used = new Uint8Array(n);
  for (const f of m.faces) for (const v of f) used[v] = 1;

  const b = MeshBuilder.like(m);
  // outer copies keep the original indices; inner copies are appended for face vertices only
  for (let i = 0; i < n; i++) {
    const s = (even ? even[i] : 1) * outerT;
    b.addVertex(
      P[i * 3] + vn[i * 3] * s,
      P[i * 3 + 1] + vn[i * 3 + 1] * s,
      P[i * 3 + 2] + vn[i * 3 + 2] * s,
      colors,
      i,
    );
  }
  const inner = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const s = (even ? even[i] : 1) * innerT;
    inner[i] = b.addVertex(
      P[i * 3] + vn[i * 3] * s,
      P[i * 3 + 1] + vn[i * 3 + 1] * s,
      P[i * 3 + 2] + vn[i * 3 + 2] * s,
      colors,
      i,
    );
  }
  const flip = p.use_flip_normals;
  const add = (verts: number[], mat: number, smooth: boolean, uv: number[] | null) => {
    if (flip) b.addFace(verts.slice().reverse(), mat, smooth, uv ? reverseUVPairs(uv) : null);
    else b.addFace(verts, mat, smooth, uv);
  };
  if (!p.use_rim_only) {
    for (let f = 0; f < m.faces.length; f++) {
      add(
        m.faces[f].slice(),
        m.faceMaterials[f] ?? 0,
        m.faceSmooth[f] ?? false,
        m.uvs ? m.uvs[f].slice() : null,
      );
    }
    for (let f = 0; f < m.faces.length; f++) {
      const mat = Math.max(0, (m.faceMaterials[f] ?? 0) + p.material_offset);
      add(
        m.faces[f].map((v) => inner[v]).reverse(),
        mat,
        m.faceSmooth[f] ?? false,
        m.uvs ? reverseUVPairs(m.uvs[f]) : null,
      );
    }
  }
  // edge attributes are copied to both shells
  for (const k in m.edgeAttrs) {
    const [a, c] = parseEdgeKey(k);
    if (a >= n || c >= n) continue;
    b.setEdgeAttr(a, c, m.edgeAttrs[k]);
    if (inner[a] >= 0 && inner[c] >= 0) b.setEdgeAttr(inner[a], inner[c], m.edgeAttrs[k]);
  }
  if (p.use_rim || p.use_rim_only) {
    const topo = buildTopology(m);
    const rimVerts = new Set<number>();
    for (let f = 0; f < m.faces.length; f++) {
      const face = m.faces[f];
      const uv = m.uvs ? m.uvs[f] : null;
      for (let i = 0; i < face.length; i++) {
        const e = topo.faceEdges[f][i];
        if (topo.edgeFaces[e].length !== 1) continue;
        const j = (i + 1) % face.length;
        const a = face[i];
        const c = face[j];
        // the face traverses a→c on the outer shell, so the rim traverses c→a there
        const quadUV = uv
          ? [
              uv[j * 2],
              uv[j * 2 + 1],
              uv[i * 2],
              uv[i * 2 + 1],
              uv[i * 2],
              uv[i * 2 + 1],
              uv[j * 2],
              uv[j * 2 + 1],
            ]
          : null;
        add(
          [c, a, inner[a], inner[c]],
          Math.max(0, (m.faceMaterials[f] ?? 0) + p.material_offset_rim),
          m.faceSmooth[f] ?? false,
          quadUV,
        );
        if (p.edge_crease_outer > 0) b.setEdgeAttr(a, c, { crease: p.edge_crease_outer });
        if (p.edge_crease_inner > 0) b.setEdgeAttr(inner[a], inner[c], { crease: p.edge_crease_inner });
        rimVerts.add(a);
        rimVerts.add(c);
      }
    }
    if (p.edge_crease_rim > 0)
      for (const v of rimVerts) b.setEdgeAttr(v, inner[v], { crease: p.edge_crease_rim });
  }
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) b.addLooseEdge(m.looseEdges[i], m.looseEdges[i + 1]);
  const out = b.build();
  if (p.use_rim_only) compactVertices(out);
  return out;
}

export const solidifyModifier: ModifierDef<typeof schema> = {
  type: 'SOLIDIFY',
  label: 'Solidify',
  category: 'GENERATE',
  description:
    'Gives a surface thickness: adds an inner (or outer, see `offset`) copy of every face with flipped winding, offset ' +
    'along the vertex normals by `thickness`, and closes open boundaries with rim quads so the result is a closed ' +
    'shell. `use_even_offset` keeps the wall thickness constant at corners.',
  schema,
  apply(mesh, p) {
    if (mesh.faces.length === 0) return mesh;
    return solidifyMesh(mesh, p);
  },
};
