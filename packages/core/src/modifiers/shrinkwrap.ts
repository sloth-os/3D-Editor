import { z } from 'zod';
import { invert4, multiply4 } from '../math/mat4';
import { vertexCount } from '../mesh/types';
import { computeVertexNormals } from '../mesh/normals';
import { triangulateMesh } from '../mesh/triangulate';
import { disabledObjectParam, type ModifierDef } from './registry';
import { Bvh } from './bvh';
import { det3, transformPositions, withPositions } from './util';

const schema = z.object({
  target: z.string().nullable().default(null).describe('Mesh object to wrap onto (null = no effect)'),
  wrap_method: z
    .enum(['NEAREST_SURFACEPOINT', 'PROJECT', 'NEAREST_VERTEX', 'TARGET_PROJECT'])
    .default('NEAREST_SURFACEPOINT')
    .describe(
      'NEAREST_SURFACEPOINT: closest point; PROJECT: cast along normals/axes; NEAREST_VERTEX: snap to closest vertex',
    ),
  wrap_mode: z
    .enum(['ON_SURFACE', 'INSIDE', 'OUTSIDE', 'OUTSIDE_SURFACE', 'ABOVE_SURFACE'])
    .default('ON_SURFACE')
    .describe(
      'ON_SURFACE always snaps; INSIDE/OUTSIDE only move vertices that are outside/inside; OUTSIDE_SURFACE/ABOVE_SURFACE apply the offset along the surface normal',
    ),
  offset: z.number().default(0).describe('Distance kept from the target surface'),
  use_project_x: z.boolean().default(false),
  use_project_y: z.boolean().default(false),
  use_project_z: z.boolean().default(false),
  use_negative_direction: z.boolean().default(false).describe('PROJECT: also cast in the negative direction'),
  use_positive_direction: z.boolean().default(true).describe('PROJECT: cast in the positive direction'),
  project_limit: z
    .number()
    .min(0)
    .default(0)
    .describe('PROJECT: maximum projection distance (0 = unlimited)'),
});

export const shrinkwrapModifier: ModifierDef<typeof schema> = {
  type: 'SHRINKWRAP',
  label: 'Shrinkwrap',
  category: 'DEFORM',
  description:
    "Moves vertices onto the surface of the `target` mesh object (evaluated, in this object's space): to the closest " +
    'surface point, the closest vertex, or by projecting along the vertex normals (or the selected axes). `offset` ' +
    'keeps a distance from the surface; wrap modes restrict which vertices move. Vertices without a hit stay put.',
  schema,
  dependencies: (p) => (p.target ? [p.target] : []),
  // rna_modifier.cc: `RNA_MOD_OBJECT_SET(Shrinkwrap, target, OB_MESH);`
  objectTypes: { target: ['MESH'] },
  // MOD_shrinkwrap.cc is_disabled: `if (!smd->target || smd->target->type != OB_MESH) return true;`
  // (its auxiliary target is not supported here)
  disabled: (p, ctx) => disabledObjectParam(ctx, p.target, ['MESH'], 'target', 'a mesh'),
  apply(mesh, p, ctx) {
    if (!p.target || vertexCount(mesh) === 0) return mesh;
    const tgt = ctx.getObjectMesh(p.target);
    if (!tgt || vertexCount(tgt.mesh) === 0) return mesh;
    const toLocal = multiply4(invert4(ctx.objectMatrix), tgt.matrix);
    const tpos = transformPositions(tgt.mesh.positions, toLocal);
    const flip = det3(toLocal) < 0 ? -1 : 1;
    const n = vertexCount(mesh);
    const P = mesh.positions;
    const out = P.slice();
    if (p.wrap_method === 'NEAREST_VERTEX') {
      const idx = new Int32Array(tpos.length / 3);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      const bvh = new Bvh(tpos, idx, 1);
      for (let i = 0; i < n; i++) {
        const x = P[i * 3];
        const y = P[i * 3 + 1];
        const z = P[i * 3 + 2];
        const hit = bvh.closest(x, y, z);
        if (!hit) continue;
        const d = Math.sqrt(hit.dist2);
        const k = d > 1e-12 && p.offset ? p.offset / d : 0;
        out[i * 3] = hit.x + (x - hit.x) * k;
        out[i * 3 + 1] = hit.y + (y - hit.y) * k;
        out[i * 3 + 2] = hit.z + (z - hit.z) * k;
      }
      return withPositions(mesh, out);
    }
    const tris = triangulateMesh(tgt.mesh).indices;
    if (tris.length === 0) return mesh;
    const bvh = new Bvh(tpos, tris, 3);
    const triNormal = (t: number): number[] => {
      const a = tris[t * 3] * 3;
      const b = tris[t * 3 + 1] * 3;
      const c = tris[t * 3 + 2] * 3;
      const ux = tpos[b] - tpos[a];
      const uy = tpos[b + 1] - tpos[a + 1];
      const uz = tpos[b + 2] - tpos[a + 2];
      const vx = tpos[c] - tpos[a];
      const vy = tpos[c + 1] - tpos[a + 1];
      const vz = tpos[c + 2] - tpos[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      return [(nx / l) * flip, (ny / l) * flip, (nz / l) * flip];
    };
    const place = (i: number, hx: number, hy: number, hz: number, nrm: number[]) => {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      const side = (x - hx) * nrm[0] + (y - hy) * nrm[1] + (z - hz) * nrm[2];
      if (p.wrap_mode === 'INSIDE' && side <= 0) return;
      if (p.wrap_mode === 'OUTSIDE' && side >= 0) return;
      let dir = nrm;
      if (p.wrap_mode === 'ON_SURFACE') {
        const d = Math.hypot(x - hx, y - hy, z - hz);
        if (d > 1e-12) dir = [(x - hx) / d, (y - hy) / d, (z - hz) / d];
      } else if (p.wrap_mode === 'INSIDE') dir = [-nrm[0], -nrm[1], -nrm[2]];
      out[i * 3] = hx + dir[0] * p.offset;
      out[i * 3 + 1] = hy + dir[1] * p.offset;
      out[i * 3 + 2] = hz + dir[2] * p.offset;
    };
    if (p.wrap_method === 'PROJECT') {
      const axes = [p.use_project_x, p.use_project_y, p.use_project_z];
      const normals = axes.some(Boolean) ? null : computeVertexNormals(mesh);
      const limit = p.project_limit > 0 ? p.project_limit : Infinity;
      for (let i = 0; i < n; i++) {
        let dx: number;
        let dy: number;
        let dz: number;
        if (normals) {
          dx = normals[i * 3];
          dy = normals[i * 3 + 1];
          dz = normals[i * 3 + 2];
        } else {
          dx = axes[0] ? 1 : 0;
          dy = axes[1] ? 1 : 0;
          dz = axes[2] ? 1 : 0;
        }
        const l = Math.hypot(dx, dy, dz);
        if (l < 1e-12) continue;
        dx /= l;
        dy /= l;
        dz /= l;
        const x = P[i * 3];
        const y = P[i * 3 + 1];
        const z = P[i * 3 + 2];
        let best: { t: number; prim: number } | null = null;
        if (p.use_positive_direction) best = bvh.raycast(x, y, z, dx, dy, dz, 0, limit);
        if (p.use_negative_direction) {
          const neg = bvh.raycast(x, y, z, -dx, -dy, -dz, 0, limit);
          if (neg && (!best || neg.t < best.t)) best = { t: -neg.t, prim: neg.prim };
        }
        if (!best) continue;
        place(i, x + dx * best.t, y + dy * best.t, z + dz * best.t, triNormal(best.prim));
      }
      return withPositions(mesh, out);
    }
    for (let i = 0; i < n; i++) {
      const hit = bvh.closest(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      if (hit) place(i, hit.x, hit.y, hit.z, triNormal(hit.prim));
    }
    return withPositions(mesh, out);
  },
};
