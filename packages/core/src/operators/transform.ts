import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import {
  axisAngle4,
  invert4,
  multiply4,
  rotationFromEuler,
  scaling4,
  translation4,
} from '../math/mat4';
import { normalize3, transformDirection3, transformPoint3 } from '../math/vec3';
import type { SceneDoc } from '../doc/scene-doc';
import type { MeshData } from '../mesh/types';
import { cloneMesh, vertexCount } from '../mesh/types';
import { selectedVertexSet } from '../mesh/selection';
import type { EditorState, OperatorContext, PivotPoint } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { activeObject, editTarget, selectedObjects, vec3 } from './helpers';
import { autoKeyTransforms } from './anim';

/*
 * Transform helpers shared by the transform operators (headless / MCP / redo panel) and the
 * interactive modal transform in the browser.
 */

/** World-space pivot for the current selection according to the pivot point setting. */
export function selectionPivot(doc: SceneDoc, state: EditorState, pivot: PivotPoint = state.pivotPoint): Vec3 {
  if (pivot === 'CURSOR') return [...state.cursorLocation] as Vec3;
  if (state.mode === 'EDIT' && state.activeId) {
    const o = doc.getObject(state.activeId);
    const mesh = o?.data ? doc.getMesh(o.data) : null;
    if (!o || !mesh) return [0, 0, 0];
    const mw = doc.worldMatrix(o.id);
    const verts = [...selectedVertexSet(mesh, state.meshSelection)].filter((v) => v < vertexCount(mesh));
    if (verts.length === 0) return transformPoint3(mw, [0, 0, 0]);
    const pts = verts.map((v) => transformPoint3(mw, [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]));
    return centerOf(pts, pivot === 'BOUNDING_BOX_CENTER');
  }
  const ids = state.selectedIds.filter((id) => doc.getObject(id));
  if (ids.length === 0) return [0, 0, 0];
  if (pivot === 'ACTIVE_ELEMENT' && state.activeId && doc.getObject(state.activeId)) {
    const m = doc.worldMatrix(state.activeId);
    return [m[12], m[13], m[14]];
  }
  const pts = ids.map((id) => {
    const m = doc.worldMatrix(id);
    return [m[12], m[13], m[14]] as Vec3;
  });
  return centerOf(pts, pivot === 'BOUNDING_BOX_CENTER');
}

function centerOf(pts: Vec3[], bounds: boolean): Vec3 {
  if (pts.length === 0) return [0, 0, 0];
  if (bounds) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of pts)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k];
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
}

/** M about pivot: T(p) · M · T(-p). */
export function aboutPivot(m: Mat4, pivot: Vec3): Mat4 {
  return multiply4(translation4(pivot), multiply4(m, translation4([-pivot[0], -pivot[1], -pivot[2]])));
}

/** Selected objects without those whose ancestor is also selected (they follow their parent). */
export function transformRoots(doc: SceneDoc, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let p = doc.getObject(id)?.parent ?? null;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (set.has(p)) return false;
      seen.add(p);
      p = doc.getObject(p)?.parent ?? null;
    }
    return true;
  });
}

/**
 * Applies a world-space linear transform `m` (no pivot applied) to objects.
 * With INDIVIDUAL_ORIGINS each object rotates/scales about its own origin; otherwise about `pivot`.
 * Returns the new world matrices (also written to the document).
 */
export function transformObjects(
  doc: SceneDoc,
  ids: string[],
  m: Mat4,
  pivot: Vec3,
  pivotMode: PivotPoint,
  originals?: Map<string, Mat4>,
): Map<string, Mat4> {
  const out = new Map<string, Mat4>();
  doc.transact(() => {
    for (const id of transformRoots(doc, ids)) {
      const w0 = originals?.get(id) ?? doc.worldMatrix(id);
      const p: Vec3 = pivotMode === 'INDIVIDUAL_ORIGINS' ? [w0[12], w0[13], w0[14]] : pivot;
      const w1 = multiply4(aboutPivot(m, p), w0);
      doc.setWorldMatrix(id, w1);
      out.set(id, w1);
    }
  });
  return out;
}

export type Falloff = EditorState['proportionalFalloff'];

export function falloffWeight(t: number, falloff: Falloff): number {
  const x = Math.max(0, Math.min(1, t));
  switch (falloff) {
    case 'CONSTANT':
      return 1;
    case 'LINEAR':
      return 1 - x;
    case 'SHARP':
      return (1 - x) * (1 - x);
    case 'ROOT':
      return Math.sqrt(1 - x);
    case 'SPHERE':
      return Math.sqrt(Math.max(0, 1 - x * x));
    case 'SMOOTH':
    default:
      return 3 * (1 - x) * (1 - x) - 2 * (1 - x) * (1 - x) * (1 - x);
  }
}

export interface VertexTransformOptions {
  proportional?: boolean;
  proportionalSize?: number;
  falloff?: Falloff;
}

/**
 * Applies a world-space transform about `pivot` to the selected vertices of a mesh whose object
 * has world matrix `objWorld`. Supports proportional editing (weights by distance to the nearest
 * selected vertex). Returns a new mesh.
 */
export function transformVertices(
  mesh: MeshData,
  verts: Set<number>,
  objWorld: Mat4,
  m: Mat4,
  pivot: Vec3,
  opts: VertexTransformOptions = {},
): MeshData {
  const out = cloneMesh(mesh);
  const inv = invert4(objWorld);
  // Local-space transform: L = W⁻¹ · (T(p)·M·T(-p)) · W
  const local = multiply4(inv, multiply4(aboutPivot(m, pivot), objWorld));
  const n = vertexCount(mesh);
  const P = mesh.positions;
  const apply = (i: number, w: number) => {
    const src: Vec3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    const dst = transformPoint3(local, src);
    out.positions[i * 3] = src[0] + (dst[0] - src[0]) * w;
    out.positions[i * 3 + 1] = src[1] + (dst[1] - src[1]) * w;
    out.positions[i * 3 + 2] = src[2] + (dst[2] - src[2]) * w;
  };
  for (const i of verts) if (i < n) apply(i, 1);
  if (opts.proportional && verts.size > 0) {
    const radius = Math.max(1e-6, opts.proportionalSize ?? 1);
    const sel = [...verts].filter((i) => i < n);
    const world = (i: number) => transformPoint3(objWorld, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const selWorld = sel.map(world);
    for (let i = 0; i < n; i++) {
      if (verts.has(i)) continue;
      const q = world(i);
      let best = Infinity;
      for (const s of selWorld) {
        const d = Math.hypot(q[0] - s[0], q[1] - s[1], q[2] - s[2]);
        if (d < best) best = d;
      }
      if (best < radius) apply(i, falloffWeight(best / radius, opts.falloff ?? 'SMOOTH'));
    }
  }
  return out;
}

/** Orientation basis (columns X, Y, Z) for constraint axes. */
export function orientationMatrix(doc: SceneDoc, state: EditorState): Mat4 {
  if (state.transformOrientation === 'LOCAL' && state.activeId) {
    const o = doc.getObject(state.activeId);
    if (o) return rotationFromEuler(o.rotation_euler);
  }
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Applies a world-space transform to the current selection (objects or edit-mode vertices). */
export function transformSelection(ctx: OperatorContext, m: Mat4, pivotOverride?: Vec3): void {
  const { doc, state } = ctx;
  const pivot = pivotOverride ?? selectionPivot(doc, state);
  if (state.mode === 'EDIT') {
    const t = editTarget(ctx);
    const verts = selectedVertexSet(t.mesh, t.selection);
    if (verts.size === 0) throw new OperatorError('No vertices selected', 'POLL_FAILED');
    const mesh = transformVertices(t.mesh, verts, t.matrix, m, pivot, {
      proportional: state.proportionalEditing,
      proportionalSize: state.proportionalSize,
      falloff: state.proportionalFalloff,
    });
    doc.setMesh(t.meshId, mesh);
    return;
  }
  const ids = selectedObjects(ctx).map((o) => o.id);
  if (ids.length === 0) throw new OperatorError('No objects selected', 'POLL_FAILED');
  transformObjects(doc, ids, m, pivot, state.pivotPoint);
  if (state.autoKeying) autoKeyTransforms(ctx, ids);
}

const orientEnum = z.enum(['GLOBAL', 'LOCAL']).default('GLOBAL');
const axisEnum = z.enum(['X', 'Y', 'Z']);

function pollTransform(ctx: OperatorContext): true | string {
  if (ctx.state.mode === 'EDIT') return activeObject(ctx)?.type === 'MESH' ? true : 'No mesh in edit mode';
  if (ctx.state.mode !== 'OBJECT') return 'Transform is not available in this mode';
  return selectedObjects(ctx).length > 0 ? true : 'No objects selected';
}

/** Pure rotation basis of the active object's world matrix (LOCAL) or identity (GLOBAL). */
function orientAxes(ctx: OperatorContext, orient: 'GLOBAL' | 'LOCAL'): Mat4 {
  const id: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (orient !== 'LOCAL') return id;
  const o = activeObject(ctx);
  if (!o) return id;
  const w = ctx.doc.worldMatrix(o.id);
  const out = id.slice();
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(w[c * 4], w[c * 4 + 1], w[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) out[c * 4 + r] = w[c * 4 + r] / l;
  }
  return out;
}

export function registerTransformOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'transform.translate',
      label: 'Move',
      description: 'Move selected objects (or selected vertices in Edit Mode) by a world-space offset.',
      category: 'Transform',
      redoable: true,
      schema: z.object({
        value: vec3.default([0, 0, 0]),
        orient_type: orientEnum,
      }),
      poll: pollTransform,
      execute(ctx, p) {
        let v = p.value as Vec3;
        if (p.orient_type === 'LOCAL') v = transformDirection3(orientAxes(ctx, 'LOCAL'), v);
        transformSelection(ctx, translation4(v));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'transform.rotate',
      label: 'Rotate',
      description: 'Rotate the selection around an axis through the pivot point. `value` is in radians.',
      category: 'Transform',
      redoable: true,
      schema: z.object({
        value: z.number().default(0),
        orient_axis: axisEnum.default('Z'),
        orient_type: orientEnum,
        axis: vec3.optional().describe('Arbitrary world-space rotation axis (overrides orient_axis)'),
        center: vec3.optional().describe('Optional world-space pivot override'),
      }),
      poll: pollTransform,
      execute(ctx, p) {
        const base: Vec3 = p.orient_axis === 'X' ? [1, 0, 0] : p.orient_axis === 'Y' ? [0, 1, 0] : [0, 0, 1];
        let axis = p.orient_type === 'LOCAL' ? normalize3(transformDirection3(orientAxes(ctx, 'LOCAL'), base)) : base;
        if (p.axis) {
          axis = normalize3(p.axis as Vec3);
          if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) throw new OperatorError('Rotation axis must not be zero', 'INVALID_PARAMS');
        }
        transformSelection(ctx, axisAngle4(axis, p.value), p.center as Vec3 | undefined);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'transform.resize',
      label: 'Scale',
      description: 'Scale the selection about the pivot point.',
      category: 'Transform',
      redoable: true,
      schema: z.object({
        value: vec3.default([1, 1, 1]),
        center: vec3.optional(),
      }),
      poll: pollTransform,
      execute(ctx, p) {
        transformSelection(ctx, scaling4(p.value as Vec3), p.center as Vec3 | undefined);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.transform_set',
      label: 'Set Transform',
      description:
        'Set location / rotation_euler (radians) / scale of objects directly (local space). Omitted values are kept. Applies to `objects` (ids or names) or to the selection.',
      category: 'Object',
      schema: z.object({
        objects: z.array(z.string()).optional(),
        location: vec3.optional(),
        rotation_euler: vec3.optional(),
        scale: vec3.optional(),
      }),
      execute(ctx, p) {
        const ids = (p.objects?.length ? p.objects : ctx.state.selectedIds).map((r) => {
          const o = ctx.doc.resolveObject(r);
          if (!o) throw new OperatorError(`Object '${r}' not found`, 'NOT_FOUND');
          return o.id;
        });
        if (ids.length === 0) throw new OperatorError('No objects given or selected', 'POLL_FAILED');
        for (const id of ids) {
          const patch: Record<string, unknown> = {};
          if (p.location) patch.location = p.location;
          if (p.rotation_euler) patch.rotation_euler = p.rotation_euler;
          if (p.scale) patch.scale = p.scale;
          ctx.doc.updateObject(id, patch);
        }
        if (ctx.state.autoKeying) autoKeyTransforms(ctx, ids);
      },
    }),
  );
}
