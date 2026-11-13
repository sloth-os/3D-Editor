import { z } from 'zod';
import type { MeshData } from '../mesh/types';
import { edgeKey, vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import type { ModifierDef } from './registry';
import { DEG, faceNormalsOf, withPositions } from './util';

// ------------------------------------------------------------------ SMOOTH

const smoothSchema = z.object({
  factor: z
    .number()
    .min(-10)
    .max(10)
    .default(0.5)
    .describe('Strength per iteration (negative values inflate)'),
  iterations: z.number().int().min(0).max(1000).default(1),
  use_x: z.boolean().default(true),
  use_y: z.boolean().default(true),
  use_z: z.boolean().default(true),
});

/** Moves every vertex toward the average of its edge neighbours. */
export function smoothPositions(
  m: MeshData,
  factor: number,
  iterations: number,
  axes: [boolean, boolean, boolean],
): number[] {
  const topo = buildTopology(m);
  const n = vertexCount(m);
  let cur = m.positions.slice();
  for (let it = 0; it < iterations; it++) {
    const next = cur.slice();
    for (let v = 0; v < n; v++) {
      const es = topo.vertEdges[v];
      if (es.length === 0) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const e of es) {
        const w = topo.edges[e][0] === v ? topo.edges[e][1] : topo.edges[e][0];
        x += cur[w * 3];
        y += cur[w * 3 + 1];
        z += cur[w * 3 + 2];
      }
      const avg = [x / es.length, y / es.length, z / es.length];
      for (let k = 0; k < 3; k++)
        if (axes[k]) next[v * 3 + k] = cur[v * 3 + k] + (avg[k] - cur[v * 3 + k]) * factor;
    }
    cur = next;
  }
  return cur;
}

export const smoothModifier: ModifierDef<typeof smoothSchema> = {
  type: 'SMOOTH',
  label: 'Smooth',
  category: 'DEFORM',
  description:
    'Laplacian smoothing: each iteration moves every vertex toward the average of its edge-connected neighbours by ' +
    '`factor`, optionally limited to some axes. Shrinks and relaxes the shape; topology is unchanged.',
  schema: smoothSchema,
  // MOD_smooth.cc is_disabled: `if (smd->fac == 0.0f || flag == 0) return true;` (flag: the axes)
  disabled: (p) =>
    p.factor === 0
      ? 'has a factor of 0'
      : p.use_x || p.use_y || p.use_z
        ? null
        : 'uses no axis (use_x, use_y and use_z are off)',
  apply(mesh, p) {
    if (p.iterations === 0 || p.factor === 0 || !(p.use_x || p.use_y || p.use_z)) return mesh;
    return withPositions(mesh, smoothPositions(mesh, p.factor, p.iterations, [p.use_x, p.use_y, p.use_z]));
  },
};

// ------------------------------------------------------------------ SMOOTH_BY_ANGLE

const smoothByAngleSchema = z.object({
  angle: z
    .number()
    .min(0)
    .max(Math.PI)
    .default(30 * DEG)
    .describe('Edges whose faces meet at a larger angle (radians) become sharp'),
  ignore_sharpness: z
    .boolean()
    .default(false)
    .describe('Clear existing sharp edge marks instead of keeping them'),
});

export const smoothByAngleModifier: ModifierDef<typeof smoothByAngleSchema> = {
  type: 'SMOOTH_BY_ANGLE',
  label: 'Smooth by Angle',
  category: 'NORMALS',
  description:
    'Shading only (Blender 4.1+ "Smooth by Angle"): sets every face to smooth shading and marks edges whose adjacent ' +
    'faces meet at more than `angle` (and non-manifold edges) as sharp, so flat areas and hard corners render ' +
    'correctly. Existing sharp edges are kept unless `ignore_sharpness`. Geometry is not changed.',
  schema: smoothByAngleSchema,
  apply(mesh, p) {
    const topo = buildTopology(mesh);
    const fn = faceNormalsOf(mesh);
    const cosLimit = Math.cos(p.angle);
    const edgeAttrs: MeshData['edgeAttrs'] = {};
    for (const k in mesh.edgeAttrs) {
      const a = { ...mesh.edgeAttrs[k] };
      if (p.ignore_sharpness) delete a.sharp;
      if (a.seam || a.sharp || a.crease) edgeAttrs[k] = a;
    }
    for (let e = 0; e < topo.edges.length; e++) {
      const faces = topo.edgeFaces[e];
      let sharp = false;
      if (faces.length > 2) sharp = true;
      else if (faces.length === 2) {
        const [f, g] = faces;
        const c = fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2];
        sharp = c < cosLimit - 1e-9;
      }
      if (!sharp) continue;
      const [a, b] = topo.edges[e];
      const k = edgeKey(a, b);
      edgeAttrs[k] = { ...edgeAttrs[k], sharp: true };
    }
    return { ...mesh, faceSmooth: mesh.faces.map(() => true), edgeAttrs };
  },
};
