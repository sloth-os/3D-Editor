import { z } from 'zod';
import { invert4, multiply4 } from '../math/mat4';
import { createMesh, meshBounds, vertexCount } from '../mesh/types';
import type { MeshData } from '../mesh/types';
import type { ModifierDef } from './registry';
import { csgMeshBoolean } from './csg';
import { transformPositions } from './util';

const schema = z.object({
  operation: z
    .enum(['DIFFERENCE', 'UNION', 'INTERSECT'])
    .default('DIFFERENCE')
    .describe('DIFFERENCE subtracts the operand, UNION joins it, INTERSECT keeps the overlap'),
  operand_type: z
    .enum(['OBJECT'])
    .default('OBJECT')
    .describe('Only single objects are supported as operands'),
  object: z.string().nullable().default(null).describe('Operand mesh object id (null = no effect)'),
  solver: z
    .enum(['EXACT', 'FAST'])
    .default('EXACT')
    .describe('Accepted for compatibility; both use the same BSP solver'),
  double_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(1e-6)
    .describe('Distance below which points count as lying on a plane (raise for nearly coplanar input)'),
  use_self: z.boolean().default(false).describe('Accepted for compatibility (no effect)'),
  use_hole_tolerant: z.boolean().default(false).describe('Accepted for compatibility (no effect)'),
});

function boxesOverlap(a: MeshData, b: MeshData): boolean {
  const ba = meshBounds(a);
  const bb = meshBounds(b);
  if (!ba || !bb) return false;
  for (let k = 0; k < 3; k++) if (ba.max[k] < bb.min[k] || bb.max[k] < ba.min[k]) return false;
  return true;
}

export const booleanModifier: ModifierDef<typeof schema> = {
  type: 'BOOLEAN',
  label: 'Boolean',
  category: 'GENERATE',
  description:
    'Constructive solid geometry with another mesh object (`object`): DIFFERENCE cuts it away, UNION merges it, ' +
    "INTERSECT keeps only the common volume. Uses the operand's evaluated mesh and its transform relative to this " +
    "object. Both meshes should be closed solids. Faces coming from the operand use this object's first material " +
    'slot. Implemented with BSP trees; the result is welded, T-junction free and merged back into n-gons.',
  schema,
  dependencies: (p) => (p.object ? [p.object] : []),
  apply(mesh, p, ctx) {
    if (!p.object) return mesh;
    const operand = ctx.getObjectMesh(p.object);
    if (!operand) return mesh;
    const toLocal = multiply4(invert4(ctx.objectMatrix), operand.matrix);
    const b = operand.mesh;
    if (vertexCount(b) === 0 || b.faces.length === 0)
      return p.operation === 'INTERSECT' ? createMesh() : mesh;
    if (mesh.faces.length === 0) {
      if (p.operation !== 'UNION') return mesh;
    }
    // fast paths for disjoint bounding boxes
    const moved: MeshData = { ...b, positions: transformPositions(b.positions, toLocal) };
    if (!boxesOverlap(mesh, moved)) {
      if (p.operation === 'DIFFERENCE') return mesh;
      if (p.operation === 'INTERSECT') return createMesh();
    }
    return csgMeshBoolean(mesh, b, p.operation, {
      bMatrix: toLocal,
      bMaterial: 0,
      tolerance: p.double_threshold,
    });
  },
};
