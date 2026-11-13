import { z } from 'zod';
import type { Mat4 } from '../math/types';
import { invert4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { vertexCount } from '../mesh/types';
import { computeVertexNormals } from '../mesh/normals';
import type { ModifierDef } from './registry';
import {
  DEG,
  axisIndex,
  objectToOwnerSpace,
  ownerToObjectSpace,
  transformPositions,
  withPositions,
  zAxis,
  zObjectRef,
} from './util';

/** Runs `fn` on positions expressed in the space of a helper object (or local space when unset). */
function inHelperSpace(mesh: MeshData, toSpace: Mat4 | null, fn: (q: number[]) => number[] | null): MeshData {
  const q = toSpace ? transformPositions(mesh.positions, toSpace) : mesh.positions.slice();
  const r = fn(q);
  if (!r) return mesh;
  return withPositions(mesh, toSpace ? transformPositions(r, invert4(toSpace)) : r);
}

// ------------------------------------------------------------------ CAST

const castSchema = z.object({
  cast_type: z.enum(['SPHERE', 'CYLINDER', 'CUBOID']).default('SPHERE').describe('Target shape'),
  factor: z
    .number()
    .min(-10)
    .max(10)
    .default(0.5)
    .describe('Blend between original (0) and target shape (1)'),
  radius: z
    .number()
    .min(0)
    .default(0)
    .describe('Only vertices within this distance of the center are affected (0 = all)'),
  size: z.number().min(0).default(0).describe('Size of the target shape (0 = automatic from the vertices)'),
  use_radius_as_size: z.boolean().default(false).describe('Use `radius` as the target size'),
  use_x: z.boolean().default(true),
  use_y: z.boolean().default(true),
  use_z: z.boolean().default(true),
  use_transform: z
    .boolean()
    .default(false)
    .describe('Accepted for compatibility; the control object transform is always used'),
  object: zObjectRef('Control object defining the center (and orientation) of the shape'),
});

export const castModifier: ModifierDef<typeof castSchema> = {
  type: 'CAST',
  label: 'Cast',
  category: 'DEFORM',
  description:
    'Pushes vertices toward a sphere, cylinder (around Z) or cuboid centered at the object origin (or `object`), by ' +
    '`factor`. The target size is automatic (average distance / bounding box) unless `size` is set; `radius` limits ' +
    'the affected region; per-axis toggles restrict the effect.',
  schema: castSchema,
  dependencies: (p) => (p.object ? [p.object] : []),
  // MOD_cast.cc is_disabled: `if ((cmd->fac == 0.0f) || flag == 0) return true;` (flag: the axes)
  disabled: (p) =>
    p.factor === 0
      ? 'has a factor of 0'
      : p.use_x || p.use_y || p.use_z
        ? null
        : 'uses no axis (use_x, use_y and use_z are off)',
  apply(mesh, p, ctx) {
    const n = vertexCount(mesh);
    const axes = [p.use_x, p.use_y, p.use_z];
    if (n === 0 || p.factor === 0 || !axes.some(Boolean)) return mesh;
    const toSpace = p.object ? ownerToObjectSpace(ctx, p.object) : null;
    return inHelperSpace(mesh, toSpace, (q) => {
      const radial = p.cast_type === 'CYLINDER' ? [axes[0], axes[1], false] : axes;
      const len = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < 3; k++) if (radial[k]) s += q[i * 3 + k] ** 2;
        len[i] = Math.sqrt(s);
      }
      const affected = (i: number) => p.radius <= 0 || len[i] <= p.radius;
      const fixedSize = p.size > 0 ? p.size : p.use_radius_as_size && p.radius > 0 ? p.radius : 0;
      const out = q.slice();
      if (p.cast_type === 'CUBOID') {
        const half = [fixedSize, fixedSize, fixedSize];
        if (!fixedSize) {
          for (let i = 0; i < n; i++) {
            if (!affected(i)) continue;
            for (let k = 0; k < 3; k++) half[k] = Math.max(half[k], Math.abs(q[i * 3 + k]));
          }
        }
        for (let i = 0; i < n; i++) {
          if (!affected(i)) continue;
          let s = Infinity;
          for (let k = 0; k < 3; k++) {
            const a = Math.abs(q[i * 3 + k]);
            if (axes[k] && a > 1e-12) s = Math.min(s, half[k] / a);
          }
          if (!Number.isFinite(s)) continue;
          for (let k = 0; k < 3; k++)
            if (axes[k]) out[i * 3 + k] = q[i * 3 + k] + (q[i * 3 + k] * s - q[i * 3 + k]) * p.factor;
        }
        return out;
      }
      let size = fixedSize;
      if (!size) {
        let sum = 0;
        let cnt = 0;
        for (let i = 0; i < n; i++) {
          if (!affected(i)) continue;
          sum += len[i];
          cnt++;
        }
        size = cnt ? sum / cnt : 0;
      }
      if (!(size > 0)) return null;
      for (let i = 0; i < n; i++) {
        if (!affected(i) || len[i] < 1e-12) continue;
        const s = size / len[i];
        for (let k = 0; k < 3; k++)
          if (radial[k]) out[i * 3 + k] = q[i * 3 + k] + (q[i * 3 + k] * s - q[i * 3 + k]) * p.factor;
      }
      return out;
    });
  },
};

// ------------------------------------------------------------------ SIMPLE_DEFORM

const simpleDeformSchema = z.object({
  deform_method: z.enum(['TWIST', 'BEND', 'TAPER', 'STRETCH']).default('TWIST'),
  angle: z
    .number()
    .default(45 * DEG)
    .describe('TWIST: rotation per unit length; BEND: bend angle per unit length (radians)'),
  factor: z
    .number()
    .default(45 * DEG)
    .describe('TAPER: scale change per unit length; STRETCH: relative length change'),
  deform_axis: zAxis('Z').describe('Axis the deformation is applied along / around'),
  limits: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
    .default(() => [0, 1] as [number, number])
    .describe('Lower/upper limit as fractions of the bounding box along the deformation axis'),
  lock_x: z.boolean().default(false),
  lock_y: z.boolean().default(false),
  lock_z: z.boolean().default(false),
  origin: zObjectRef('Object defining the deformation origin and orientation'),
});

type SimpleDeformParams = z.infer<typeof simpleDeformSchema>;

export function simpleDeformPositions(q: number[], p: SimpleDeformParams): number[] {
  const n = q.length / 3;
  const A = axisIndex(p.deform_axis);
  const B = A === 0 ? 1 : 0; // bend coordinate
  const C = 3 - A - B;
  const limitAxis = p.deform_method === 'BEND' ? B : A;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, q[i * 3 + limitAxis]);
    hi = Math.max(hi, q[i * 3 + limitAxis]);
  }
  const l0 = Math.min(p.limits[0], p.limits[1]);
  const l1 = Math.max(p.limits[0], p.limits[1]);
  const cut0 = lo + (hi - lo) * l0;
  const cut1 = lo + (hi - lo) * l1;
  const clampC = (v: number) => (v < cut0 ? cut0 : v > cut1 ? cut1 : v);
  const out = q.slice();
  // the two axes perpendicular to A (right-handed order)
  const U = (A + 1) % 3;
  const V = (A + 2) % 3;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    switch (p.deform_method) {
      case 'TWIST': {
        const th = p.angle * clampC(q[o + A]);
        const c = Math.cos(th);
        const s = Math.sin(th);
        out[o + U] = q[o + U] * c - q[o + V] * s;
        out[o + V] = q[o + U] * s + q[o + V] * c;
        break;
      }
      case 'TAPER': {
        const s = 1 + p.factor * clampC(q[o + A]);
        out[o + U] = q[o + U] * s;
        out[o + V] = q[o + V] * s;
        break;
      }
      case 'STRETCH': {
        const len = Math.max(0.01, 1 + p.factor);
        const side = 1 / Math.sqrt(len);
        const a = q[o + A];
        const ac = clampC(a);
        out[o + A] = ac * len + (a - ac);
        out[o + U] = q[o + U] * side;
        out[o + V] = q[o + V] * side;
        break;
      }
      case 'BEND': {
        const k = p.angle;
        if (Math.abs(k) < 1e-12) break;
        const r = 1 / k;
        const b = q[o + B];
        const c = q[o + C];
        const bc = clampC(b);
        const th = bc * k;
        const sn = Math.sin(th);
        const cs = Math.cos(th);
        out[o + B] = (r - c) * sn + (b - bc) * cs;
        out[o + C] = r - (r - c) * cs + (b - bc) * sn;
        break;
      }
    }
  }
  const locks = [p.lock_x, p.lock_y, p.lock_z];
  for (let k = 0; k < 3; k++) if (locks[k]) for (let i = 0; i < n; i++) out[i * 3 + k] = q[i * 3 + k];
  return out;
}

export const simpleDeformModifier: ModifierDef<typeof simpleDeformSchema> = {
  type: 'SIMPLE_DEFORM',
  label: 'Simple Deform',
  category: 'DEFORM',
  description:
    'Simple deformations along `deform_axis` (in local space or the space of `origin`): TWIST rotates by `angle` per ' +
    'unit along the axis, BEND bends the perpendicular X (or Y) direction around the axis with curvature `angle` per ' +
    'unit, TAPER scales the cross-section by 1 + factor × coordinate, STRETCH lengthens the axis by 1 + factor while ' +
    'keeping the volume. `limits` restricts the deformed range (outside parts move rigidly).',
  schema: simpleDeformSchema,
  dependencies: (p) => (p.origin ? [p.origin] : []),
  apply(mesh, p, ctx) {
    if (vertexCount(mesh) === 0) return mesh;
    const toSpace = p.origin ? ownerToObjectSpace(ctx, p.origin) : null;
    return inHelperSpace(mesh, toSpace, (q) => simpleDeformPositions(q, p));
  },
};

// ------------------------------------------------------------------ WAVE

const waveSchema = z.object({
  height: z.number().default(0.5).describe('Wave amplitude'),
  width: z.number().positive().default(1.5).describe('Half distance between wave crests'),
  narrowness: z.number().min(0).default(1.5).describe('How narrow each crest is'),
  speed: z.number().default(0.25).describe('Distance travelled per frame'),
  start_position_x: z.number().default(0),
  start_position_y: z.number().default(0),
  start_position_object: zObjectRef('Object whose location is used as the wave origin'),
  use_x: z.boolean().default(true).describe('Waves travel along X (with use_y: circular ripples)'),
  use_y: z.boolean().default(true).describe('Waves travel along Y (with use_x: circular ripples)'),
  use_cyclic: z.boolean().default(true).describe('Repeat the wave (otherwise a single pulse)'),
  use_normal: z.boolean().default(false).describe('Displace along vertex normals instead of local Z'),
  use_normal_x: z.boolean().default(true),
  use_normal_y: z.boolean().default(true),
  use_normal_z: z.boolean().default(true),
  time_offset: z.number().default(0).describe('Frame at which the wave starts'),
  lifetime: z.number().min(0).default(0).describe('Frames before the wave starts to fade (0 = forever)'),
  damping_time: z.number().min(0).default(10).describe('Frames the fade-out takes after the lifetime'),
  falloff_radius: z
    .number()
    .min(0)
    .default(0)
    .describe('Amplitude falls to zero at this distance from the origin (0 = off)'),
});

type WaveParams = z.infer<typeof waveSchema>;

export function wavePositions(
  mesh: MeshData,
  p: WaveParams,
  frame: number,
  start: [number, number],
): number[] | null {
  const n = vertexCount(mesh);
  if (!p.use_x && !p.use_y) return null;
  const elapsed = frame - p.time_offset;
  let amp = p.height;
  if (p.lifetime > 0 && elapsed > p.lifetime) {
    amp *= p.damping_time > 0 ? Math.max(0, 1 - (elapsed - p.lifetime) / p.damping_time) : 0;
  }
  if (amp === 0) return null;
  const travel = elapsed * p.speed;
  const w = p.width;
  const floor = Math.exp(-p.narrowness * w * w);
  const norm = 1 - floor > 1e-9 ? 1 / (1 - floor) : 1;
  const P = mesh.positions;
  const normals = p.use_normal ? computeVertexNormals(mesh) : null;
  const mask = [p.use_normal_x, p.use_normal_y, p.use_normal_z];
  const out = P.slice();
  for (let i = 0; i < n; i++) {
    const dx = P[i * 3] - start[0];
    const dy = P[i * 3 + 1] - start[1];
    const radial = Math.hypot(dx, dy);
    const d = p.use_x && p.use_y ? radial : p.use_x ? dx : dy;
    let u = d - travel;
    if (p.use_cyclic) u = ((((u + w) % (2 * w)) + 2 * w) % (2 * w)) - w;
    else if (u <= -w || u >= w) continue;
    let h = amp * (Math.exp(-p.narrowness * u * u) - floor) * norm;
    if (p.falloff_radius > 0) h *= Math.max(0, 1 - radial / p.falloff_radius);
    if (h === 0) continue;
    if (normals) {
      for (let k = 0; k < 3; k++) if (mask[k]) out[i * 3 + k] += normals[i * 3 + k] * h;
    } else out[i * 3 + 2] += h;
  }
  return out;
}

export const waveModifier: ModifierDef<typeof waveSchema> = {
  type: 'WAVE',
  label: 'Wave',
  category: 'DEFORM',
  description:
    'Animated ripples (time dependent): crests of `height` travel outward from the start position (circular when both ' +
    'use_x and use_y are on, otherwise along one axis) at `speed` units per frame, starting at frame `time_offset`. ' +
    'Displaces along local Z or the vertex normals. Optional lifetime/damping and falloff radius.',
  schema: waveSchema,
  timeDependent: true,
  dependencies: (p) => (p.start_position_object ? [p.start_position_object] : []),
  apply(mesh, p, ctx) {
    if (vertexCount(mesh) === 0) return mesh;
    let start: [number, number] = [p.start_position_x, p.start_position_y];
    if (p.start_position_object) {
      const m = objectToOwnerSpace(ctx, p.start_position_object);
      if (m) start = [m[12], m[13]];
    }
    const out = wavePositions(mesh, p, ctx.frame, start);
    return out ? withPositions(mesh, out) : mesh;
  },
};
