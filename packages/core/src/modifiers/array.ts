import { z } from 'zod';
import type { Mat4 } from '../math/types';
import { identity4, invert4, multiply4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { meshBounds, parseEdgeKey, vertexCount } from '../mesh/types';
import { disabledObjectParam, type ModifierDef } from './registry';
import {
  MeshBuilder,
  PointGrid,
  UnionFind,
  det3,
  hasColors,
  mergeVerticesByMap,
  objectToOwnerSpace,
  reverseUVPairs,
  zObjectRef,
  zVec3,
} from './util';

const schema = z.object({
  fit_type: z
    .enum(['FIXED_COUNT', 'FIT_LENGTH'])
    .default('FIXED_COUNT')
    .describe('FIXED_COUNT uses `count`; FIT_LENGTH adds copies until `fit_length` is covered'),
  count: z.number().int().min(1).max(10000).default(2).describe('Number of copies (including the original)'),
  fit_length: z.number().min(0).default(0).describe('Length to fill for FIT_LENGTH'),
  use_relative_offset: z.boolean().default(true),
  relative_offset_displace: zVec3([1, 0, 0]).describe(
    'Offset between copies as a factor of the bounding-box size',
  ),
  use_constant_offset: z.boolean().default(false),
  constant_offset_displace: zVec3([1, 0, 0]).describe('Offset between copies in local units'),
  use_object_offset: z.boolean().default(false),
  offset_object: zObjectRef(
    'Object whose transform relative to this object is applied cumulatively per copy',
  ),
  use_merge_vertices: z
    .boolean()
    .default(false)
    .describe('Weld vertices of neighbouring copies within merge_threshold'),
  use_merge_vertices_cap: z.boolean().default(false).describe('Also weld the last copy to the first one'),
  merge_threshold: z.number().min(0).default(0.01),
  start_cap: zObjectRef('Mesh object added before the first copy (its local geometry is used)'),
  end_cap: zObjectRef('Mesh object added after the last copy (its local geometry is used)'),
  offset_u: z.number().min(-1).max(1).default(0).describe('UV U offset per copy'),
  offset_v: z.number().min(-1).max(1).default(0).describe('UV V offset per copy'),
});

type ArrayParams = z.infer<typeof schema>;

const MAX_VERTICES = 5_000_000;

function powMat(m: Mat4, k: number): Mat4 {
  let out = identity4();
  for (let i = 0; i < k; i++) out = multiply4(out, m);
  return out;
}

function appendTransformed(b: MeshBuilder, src: MeshData, M: Mat4, uvOffset: [number, number]): number {
  const offset = b.vertexCount;
  const P = src.positions;
  const colors = hasColors(src) ? src.colors! : null;
  const n = vertexCount(src);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3];
    const y = P[i * 3 + 1];
    const z = P[i * 3 + 2];
    b.addVertex(
      M[0] * x + M[4] * y + M[8] * z + M[12],
      M[1] * x + M[5] * y + M[9] * z + M[13],
      M[2] * x + M[6] * y + M[10] * z + M[14],
      colors,
      i,
    );
  }
  const flip = det3(M) < 0;
  for (let f = 0; f < src.faces.length; f++) {
    let verts = src.faces[f].map((v) => v + offset);
    let uv = src.uvs ? src.uvs[f].slice() : null;
    if (uv && (uvOffset[0] || uvOffset[1])) {
      for (let i = 0; i < uv.length; i += 2) {
        uv[i] += uvOffset[0];
        uv[i + 1] += uvOffset[1];
      }
    }
    if (flip) {
      verts = verts.reverse();
      if (uv) uv = reverseUVPairs(uv);
    }
    b.addFace(verts, src.faceMaterials[f] ?? 0, src.faceSmooth[f] ?? false, uv);
  }
  for (let i = 0; i + 1 < src.looseEdges.length; i += 2)
    b.addLooseEdge(src.looseEdges[i] + offset, src.looseEdges[i + 1] + offset);
  for (const k in src.edgeAttrs) {
    const [a, c] = parseEdgeKey(k);
    b.setEdgeAttr(a + offset, c + offset, src.edgeAttrs[k]);
  }
  return offset;
}

/** Offset transform between consecutive copies. */
function arrayOffset(mesh: MeshData, p: ArrayParams, objectOffset: Mat4 | null): Mat4 {
  const M = objectOffset ? objectOffset.slice() : identity4();
  const bounds = meshBounds(mesh);
  if (p.use_relative_offset && bounds) {
    for (let k = 0; k < 3; k++) M[12 + k] += p.relative_offset_displace[k] * (bounds.max[k] - bounds.min[k]);
  }
  if (p.use_constant_offset) for (let k = 0; k < 3; k++) M[12 + k] += p.constant_offset_displace[k];
  return M;
}

export const arrayModifier: ModifierDef<typeof schema> = {
  type: 'ARRAY',
  label: 'Array',
  category: 'GENERATE',
  description:
    'Repeats the mesh `count` times (or as many times as fit into `fit_length`). The step between copies is the sum of ' +
    'a relative offset (factor of the bounding-box size), a constant offset and optionally the transform of ' +
    '`offset_object` relative to this object (applied cumulatively, e.g. for radial arrays around an empty). Optional ' +
    'start/end caps and welding of touching copies (`use_merge_vertices`).',
  schema,
  dependencies: (p) =>
    [p.use_object_offset ? p.offset_object : null, p.start_cap, p.end_cap].filter((x): x is string => !!x),
  // rna_modifier.cc: `RNA_MOD_OBJECT_SET(Array, start_cap, OB_MESH);` (the same for end_cap; the
  // offset object is any object)
  objectTypes: { start_cap: ['MESH'], end_cap: ['MESH'] },
  // MOD_array.cc is_disabled: a cap object that is not a mesh
  // (`if (amd->start_cap && amd->start_cap->type != OB_MESH) return true;`, the same for the end
  // cap); the curve of Fit Curve, also checked there, is not supported here
  disabled: (p, ctx) =>
    disabledObjectParam(ctx, p.start_cap, ['MESH'], 'start cap', 'a mesh', false) ??
    disabledObjectParam(ctx, p.end_cap, ['MESH'], 'end cap', 'a mesh', false),
  apply(mesh, p, ctx) {
    const nv = vertexCount(mesh);
    if (nv === 0) return mesh;
    const objectOffset =
      p.use_object_offset && p.offset_object ? objectToOwnerSpace(ctx, p.offset_object) : null;
    const M = arrayOffset(mesh, p, objectOffset);
    let count = p.count;
    if (p.fit_type === 'FIT_LENGTH') {
      const dist = Math.hypot(M[12], M[13], M[14]);
      count = dist > 1e-9 ? Math.floor(p.fit_length / dist + 1e-6) + 1 : 1;
      count = Math.max(1, Math.min(10000, count));
    }
    if (count * nv > MAX_VERTICES) throw new Error(`Array result too large (${count * nv} vertices)`);
    const startCap = p.start_cap ? (ctx.getObjectMesh(p.start_cap)?.mesh ?? null) : null;
    const endCap = p.end_cap ? (ctx.getObjectMesh(p.end_cap)?.mesh ?? null) : null;
    const anyColors = hasColors(mesh) || (startCap && hasColors(startCap)) || (endCap && hasColors(endCap));
    const anyUV = !!mesh.uvs || !!startCap?.uvs || !!endCap?.uvs;
    const b = new MeshBuilder({ colors: !!anyColors, uvs: anyUV });
    let Mk = identity4();
    for (let k = 0; k < count; k++) {
      appendTransformed(b, mesh, Mk, [k * p.offset_u, k * p.offset_v]);
      Mk = multiply4(Mk, M);
    }
    let startOffset = -1;
    let endOffset = -1;
    if (startCap && vertexCount(startCap)) startOffset = appendTransformed(b, startCap, invert4(M), [0, 0]);
    if (endCap && vertexCount(endCap)) endOffset = appendTransformed(b, endCap, powMat(M, count), [0, 0]);
    const out = b.build();
    if (!p.use_merge_vertices) return out;

    // --- welding between neighbouring copies (and caps)
    const thr = p.merge_threshold;
    const total = vertexCount(out);
    const uf = new UnionFind(total);
    const P = mesh.positions;
    const grid = new PointGrid(Math.max(thr, 1e-9));
    for (let i = 0; i < nv; i++) grid.insert(i, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    // vertex j of copy k sits on vertex i of copy k-1 when M·p_j ≈ p_i
    const pair = new Int32Array(nv).fill(-1);
    for (let j = 0; j < nv; j++) {
      const x = P[j * 3];
      const y = P[j * 3 + 1];
      const z = P[j * 3 + 2];
      pair[j] = grid.nearest(
        M[0] * x + M[4] * y + M[8] * z + M[12],
        M[1] * x + M[5] * y + M[9] * z + M[13],
        M[2] * x + M[6] * y + M[10] * z + M[14],
        thr,
      );
    }
    for (let k = 1; k < count; k++) {
      for (let j = 0; j < nv; j++) if (pair[j] >= 0) uf.union(k * nv + j, (k - 1) * nv + pair[j]);
    }
    const Q = out.positions;
    const weldRange = (from: number, to: number, againstStart: number) => {
      const g = new PointGrid(Math.max(thr, 1e-9));
      for (let i = 0; i < nv; i++) {
        const o = (againstStart + i) * 3;
        g.insert(againstStart + i, Q[o], Q[o + 1], Q[o + 2]);
      }
      for (let v = from; v < to; v++) {
        const hit = g.nearest(Q[v * 3], Q[v * 3 + 1], Q[v * 3 + 2], thr);
        if (hit >= 0) uf.union(v, hit);
      }
    };
    if (p.use_merge_vertices_cap && count > 1) weldRange((count - 1) * nv, count * nv, 0);
    if (startOffset >= 0) weldRange(startOffset, endOffset >= 0 ? endOffset : total, 0);
    if (endOffset >= 0) weldRange(endOffset, total, (count - 1) * nv);
    return mergeVerticesByMap(out, uf.roots());
  },
};
