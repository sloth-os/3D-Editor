import { z } from 'zod';
import type { Vec3 } from '../math/types';
import { invert4, multiply4 } from '../math/mat4';
import { vertexCount } from '../mesh/types';
import { decodeFloat32 } from '../mesh/shape-keys';
import type { CurveSample } from '../curve/path';
import type { ModifierDef } from './registry';
import { transformPositions, withPositions, zObjectRef } from './util';

const AXES = ['POS_X', 'POS_Y', 'POS_Z', 'NEG_X', 'NEG_Y', 'NEG_Z'] as const;
type DeformAxis = (typeof AXES)[number];

const curveSchema = z.object({
  object: zObjectRef(
    'Curve object (id) to bend the mesh along: the first spline of its curve data, in its own local space',
  ),
  deform_axis: z
    .enum(AXES)
    .default('POS_X')
    .describe(
      "Mesh axis laid along the curve. A vertex at coordinate d on this axis (in the curve object's space) lands at arc length d from the curve start (NEG_* axes run backwards); the other two axes become the curve's side/up directions",
    ),
  use_stretch: z
    .boolean()
    .default(false)
    .describe(
      'Stretch the mesh so its extent along the deform axis covers the whole curve (Blender curve "Stretch")',
    ),
  use_radius: z
    .boolean()
    .default(true)
    .describe(
      'Scale the cross-section by the interpolated point radius of the curve (Blender curve "Radius")',
    ),
  vertex_group: z
    .string()
    .default('')
    .describe('Limit the effect to this vertex group, weighted (empty = all vertices)'),
  invert_vertex_group: z.boolean().default(false).describe('Invert the influence of `vertex_group`'),
});

/** Coordinates (side, up) of a point's cross-section for a deform axis (a proper rotation per axis). */
function crossSection(x: number, y: number, z: number, axis: DeformAxis): [number, number] {
  switch (axis) {
    case 'POS_X':
      return [y, z];
    case 'POS_Y':
      return [-x, z];
    case 'POS_Z':
      return [x, y];
    case 'NEG_X':
      return [-y, z];
    case 'NEG_Y':
      return [x, z];
    case 'NEG_Z':
      return [x, -y];
  }
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

/** Up axis of a path sample: its twist frame, else a Z-up frame rotated by the tilt. */
function sampleUp(s: CurveSample): Vec3 {
  if (s.up) return s.up;
  const t = s.tangent;
  let u = normalize([-t[2] * t[0], -t[2] * t[1], 1 - t[2] * t[2]]);
  if (!u[0] && !u[1] && !u[2]) u = normalize([-t[1] * t[0], 1 - t[1] * t[1], -t[1] * t[2]]);
  if (!s.tilt) return u;
  const c = Math.cos(s.tilt);
  const sn = Math.sin(s.tilt);
  const k = t;
  const kxu: Vec3 = [k[1] * u[2] - k[2] * u[1], k[2] * u[0] - k[0] * u[2], k[0] * u[1] - k[1] * u[0]];
  return [u[0] * c + kxu[0] * sn, u[1] * c + kxu[1] * sn, u[2] * c + kxu[2] * sn];
}

export const curveModifier: ModifierDef<typeof curveSchema> = {
  type: 'CURVE',
  label: 'Curve',
  category: 'DEFORM',
  description:
    "Bends the mesh along a curve object (Blender's Curve deform). The mesh is taken into the curve object's space; " +
    'its coordinate along `deform_axis` becomes the arc length along the curve (from the curve start, so moving the ' +
    'object along that axis slides it along the curve), the other two coordinates are placed in the curve frame ' +
    '(twist mode and tilt, scaled by the point radius when `use_radius`). Beyond the ends of an open curve the mesh ' +
    'continues straight along the end tangent; closed curves wrap around. `use_stretch` fits the mesh length to the curve.',
  schema: curveSchema,
  dependencies: (p) => (p.object ? [p.object] : []),
  apply(mesh, p, ctx) {
    const n = vertexCount(mesh);
    if (!p.object || n === 0) return mesh;
    if (!ctx.getCurvePath) throw new Error('Curve paths are not available in this evaluation context');
    const cp = ctx.getCurvePath(p.object);
    if (!cp) throw new Error(`Object '${p.object}' is not a curve with at least two distinct points`);
    const toCurve = multiply4(invert4(cp.matrix), ctx.objectMatrix);
    const toOwner = invert4(toCurve);
    const q = transformPositions(mesh.positions, toCurve);
    const axis = p.deform_axis;
    const ai = axis.endsWith('X') ? 0 : axis.endsWith('Y') ? 1 : 2;
    const neg = axis.startsWith('NEG');
    const path = cp.path;
    const L = path.length;
    let lo = Infinity;
    let hi = -Infinity;
    if (p.use_stretch)
      for (let i = 0; i < n; i++) {
        const a = q[i * 3 + ai];
        if (a < lo) lo = a;
        if (a > hi) hi = a;
      }
    let weights: Float32Array | null = null;
    if (p.vertex_group) {
      const g = ctx.vertexGroups?.find((v) => v.name === p.vertex_group);
      if (!g) throw new Error(`Vertex group '${p.vertex_group}' not found`);
      const w = decodeFloat32(g.weights);
      if (w.length !== n)
        throw new Error(`Vertex group '${p.vertex_group}' does not match the mesh (${n} vertices)`);
      weights = p.invert_vertex_group ? w.map((x) => 1 - x) : w;
    }
    const out = q.slice();
    for (let i = 0; i < n; i++) {
      const w = weights ? Math.min(1, Math.max(0, weights[i])) : 1;
      if (w <= 0) continue;
      const x = q[i * 3];
      const y = q[i * 3 + 1];
      const zz = q[i * 3 + 2];
      const a = q[i * 3 + ai];
      let fac: number;
      if (p.use_stretch) fac = hi > lo ? (neg ? hi - a : a - lo) / (hi - lo) : 0;
      else fac = (neg ? -a : a) / L;
      if (!Number.isFinite(fac)) fac = 0;
      let s: CurveSample;
      let pos: Vec3;
      if (!path.cyclic && (fac < 0 || fac > 1)) {
        // extrapolate straight along the end tangent
        s = path.sample(fac < 0 ? 0 : 1);
        const d = (fac < 0 ? fac : fac - 1) * L;
        pos = [
          s.position[0] + s.tangent[0] * d,
          s.position[1] + s.tangent[1] * d,
          s.position[2] + s.tangent[2] * d,
        ];
      } else {
        s = path.sample(fac);
        pos = s.position;
      }
      const t = s.tangent;
      const u = sampleUp(s);
      const side = normalize([
        u[1] * t[2] - u[2] * t[1],
        u[2] * t[0] - u[0] * t[2],
        u[0] * t[1] - u[1] * t[0],
      ]);
      const r = p.use_radius ? s.radius : 1;
      const [cs, cu] = crossSection(x, y, zz, axis);
      for (let k = 0; k < 3; k++) {
        const v = pos[k] + (side[k] * cs + u[k] * cu) * r;
        out[i * 3 + k] = q[i * 3 + k] + (v - q[i * 3 + k]) * w;
      }
    }
    return withPositions(mesh, transformPositions(out, toOwner));
  },
};
