import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { invert4, multiply4 } from '../math/mat4';
import { transformDirection3, transformPoint3 } from '../math/vec3';
import type { ObjectData } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { vertexCount } from '../mesh/types';
import type { MeshSelection } from '../mesh/selection';
import { flushSelection, selectedVertexSet } from '../mesh/selection';
import type { OperatorContext } from './context';
import { OperatorError } from './context';

export const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const optionalVec3 = vec3.optional();

/** Existing selected objects (in selection order). */
export function selectedObjects(ctx: OperatorContext): ObjectData[] {
  const out: ObjectData[] = [];
  for (const id of ctx.state.selectedIds) {
    const o = ctx.doc.getObject(id);
    if (o) out.push(o);
  }
  return out;
}

export function activeObject(ctx: OperatorContext): ObjectData | null {
  return ctx.state.activeId ? ctx.doc.getObject(ctx.state.activeId) : null;
}

/** Replaces the selection (and active object). */
export function setSelection(
  ctx: OperatorContext,
  ids: string[],
  active: string | null = ids[ids.length - 1] ?? null,
): void {
  ctx.state.selectedIds = [...new Set(ids)];
  ctx.state.activeId = active;
}

/** Resolves ids or names to object ids; throws for unknown references. */
export function resolveObjectIds(ctx: OperatorContext, refs: string[] | undefined): string[] {
  if (!refs || refs.length === 0) return selectedObjects(ctx).map((o) => o.id);
  // many references: one name index instead of a scan of the scene per name (the first object of a
  // name wins, as in SceneDoc.findObjectByName)
  let byName: Map<string, string> | null = null;
  if (refs.length > 16) {
    byName = new Map();
    for (const o of ctx.doc.listObjects()) if (!byName.has(o.name)) byName.set(o.name, o.id);
  }
  return refs.map((r) => {
    const id = byName ? (ctx.doc.getObject(r)?.id ?? byName.get(r)) : ctx.doc.resolveObject(r)?.id;
    if (!id) throw new OperatorError(`Object '${r}' not found`, 'NOT_FOUND');
    return id;
  });
}

export function pollObjectMode(ctx: OperatorContext): true | string {
  return ctx.state.mode === 'OBJECT' ? true : 'Operator requires Object Mode';
}

export function pollHasSelection(ctx: OperatorContext): true | string {
  return selectedObjects(ctx).length > 0 ? true : 'No objects selected';
}

export function pollEditMesh(ctx: OperatorContext): true | string {
  if (ctx.state.mode !== 'EDIT') return 'Operator requires Edit Mode';
  const o = activeObject(ctx);
  if (!o || o.type !== 'MESH' || !o.data) return 'Active object is not a mesh';
  return true;
}

export interface EditTarget {
  object: ObjectData;
  meshId: string;
  /** Immutable current mesh (clone before modifying). */
  mesh: MeshData;
  selection: MeshSelection;
  /** Object world matrix. */
  matrix: Mat4;
}

/** The mesh being edited in edit mode. Throws OperatorError if not in mesh edit mode. */
export function editTarget(ctx: OperatorContext): EditTarget {
  const p = pollEditMesh(ctx);
  if (p !== true) throw new OperatorError(p, 'POLL_FAILED');
  const object = activeObject(ctx)!;
  const mesh = ctx.doc.getMesh(object.data!);
  if (!mesh) throw new OperatorError('Mesh data missing', 'FAILED');
  return {
    object,
    meshId: object.data!,
    mesh,
    selection: ctx.state.meshSelection,
    matrix: ctx.doc.worldMatrix(object.id),
  };
}

/** Writes an edited mesh back to the document and updates the (flushed) edit selection. */
export function commitEdit(
  ctx: OperatorContext,
  target: EditTarget,
  mesh: MeshData,
  selection: MeshSelection,
): void {
  ctx.doc.setMesh(target.meshId, mesh);
  ctx.state.meshSelection = flushSelection(mesh, selection, ctx.state.selectMode);
}

/** World-space positions of the selected vertices of the edit mesh. */
export function selectedWorldVerts(target: EditTarget): Vec3[] {
  const out: Vec3[] = [];
  const m = target.mesh;
  for (const v of selectedVertexSet(m, target.selection)) {
    if (v >= vertexCount(m)) continue;
    out.push(
      transformPoint3(target.matrix, [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]]),
    );
  }
  return out;
}

/** Converts a world-space point into an object's local space. */
export function worldToLocal(matrix: Mat4, p: Vec3): Vec3 {
  return transformPoint3(invert4(matrix), p);
}

export function worldDirToLocal(matrix: Mat4, d: Vec3): Vec3 {
  return transformDirection3(invert4(matrix), d);
}

/** World matrix of `objWorld` expressed relative to `parentWorld` (local = P⁻¹·W). */
export function relativeTo(parentWorld: Mat4, world: Mat4): Mat4 {
  return multiply4(invert4(parentWorld), world);
}
