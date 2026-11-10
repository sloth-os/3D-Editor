import { z } from 'zod';
import type { Vec3 } from '../math/types';
import { compose4, multiply4, translation4 } from '../math/mat4';
import { transformPoint3 } from '../math/vec3';
import {
  changedChannels,
  transformBasis,
  transformedChannels,
  transformTolerance,
  type TransformChannels,
} from '../doc/scene-doc';
import type { FrameState } from '../eval/frame-state';
import { selectedVertexSet } from '../mesh/selection';
import { vertexCount } from '../mesh/types';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import {
  evaluatedWorld,
  keyChannelChanges,
  transformFrameState,
  transformRoots,
  type ChannelChange,
} from './transform';
import { selectedObjects, vec3 } from './helpers';

/**
 * The center of the selection as Blender's Cursor to Selected finds it (snap_curs_to_sel_ex), at
 * the frame of `fs`: in Object Mode the origins of all selected objects (a selected child of a
 * selected parent too) where the scene shows them, constraints applied (rigid bodies where the
 * simulation has them, with a frame state from transformFrameState); in Edit Mode the selected
 * vertices. The center of their bounding box with the Bounding Box Center pivot point, else their
 * median. Null when nothing is selected.
 */
function selectionCenter(ctx: OperatorContext, fs: FrameState): Vec3 | null {
  const { doc, state } = ctx;
  let pts: Vec3[];
  if (state.mode === 'EDIT' && state.activeId) {
    const o = doc.getObject(state.activeId);
    const mesh = o?.data ? doc.getMesh(o.data) : null;
    if (!o || !mesh) return null;
    const w = evaluatedWorld(fs, o.id);
    const P = mesh.positions;
    pts = [...selectedVertexSet(mesh, state.meshSelection)]
      .filter((v) => v < vertexCount(mesh))
      .map((v) => transformPoint3(w, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]));
  } else
    pts = selectedObjects(ctx).map((o) => {
      const w = evaluatedWorld(fs, o.id);
      return [w[12], w[13], w[14]] as Vec3;
    });
  if (!pts.length) return null;
  if (state.pivotPoint === 'BOUNDING_BOX_CENTER') {
    const min = [...pts[0]];
    const max = [...pts[0]];
    for (const p of pts)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  return c;
}

/**
 * Moves objects by world offsets as Blender's snap operators do (snap_selected_to_location and
 * Selection to Grid): `offsets` maps each object to the world offset that takes its origin, where
 * the scene shows it at the frame of `fs`, to its target. Each location changes by the offset taken
 * into the parent's space with the inverse of the parent's matrix there (a bone's posed matrix for
 * a bone child), starting from the location its channels hold at the frame (an animated value
 * there; for a rigid body the simulation moves, the location it starts the simulation from, to
 * which Blender's snap_selected_to_location adds the offset from where the simulation shows it),
 * all computed before any is written. Only locations that change are written. Auto keying keys the
 * location of every object in `offsets` with the value it shows afterwards (also one already at its
 * target), as Blender's snapping keys its Location keying set; without it an animated location it
 * changes is keyed at the frame (see keyChannelChanges in transform.ts).
 */
function snapObjects(ctx: OperatorContext, fs: FrameState, offsets: Map<string, Vec3>): void {
  const doc = ctx.doc;
  const writes: { id: string; next: TransformChannels; tol: number; start: TransformChannels }[] = [];
  for (const [id, offset] of offsets) {
    const o = fs.byId.get(id);
    if (!o || !offset.every(Number.isFinite)) continue;
    const start: TransformChannels = {
      location: o.location,
      rotation_euler: o.rotation_euler,
      scale: o.scale,
    };
    const parent = o.parent && o.parent !== id && fs.byId.has(o.parent) ? fs.parent(id) : null;
    const local = compose4(o.location, o.rotation_euler, o.scale);
    const basis = transformBasis(start, parent ? multiply4(parent, local) : local, parent);
    const next = transformedChannels(start, basis, 'TRANSLATE', translation4(offset), [0, 0, 0]);
    writes.push({ id, next, tol: transformTolerance(basis), start });
  }
  const changes = new Map<string, ChannelChange>();
  doc.transact(() => {
    for (const w of writes) {
      const patch = changedChannels(w.start, { ...w.start, location: w.next.location }, w.tol);
      if (patch) doc.updateObject(w.id, patch);
      changes.set(w.id, { before: w.start, after: { ...w.start, ...patch } });
    }
    keyChannelChanges(ctx, changes, ['location']);
  });
}

/** What the Snap menu's descriptions say about keying. */
const SNAP_KEYING =
  ' An animated location is keyed at the current frame with its new value, so the object stays where it ' +
  'is put; with auto keying the location of every object it snaps is keyed (also one already in place), as ' +
  'in Blender.';

/** 3D cursor and snapping operators (headless-capable). */
export function registerViewOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'view3d.snap_cursor_to_selected',
      label: 'Cursor to Selected',
      description:
        'Move the 3D cursor to the center of the selection: the median of the selected objects’ origins ' +
        '(of the selected vertices in Edit Mode), or the center of their bounding box when the pivot point is ' +
        'Bounding Box Center, where the scene shows them at the current frame. Leaves the cursor where it is ' +
        'when nothing is selected.',
      category: 'Snap',
      undo: false,
      schema: z.object({}),
      execute(ctx) {
        const c = selectionCenter(ctx, transformFrameState(ctx.doc, ctx.state.frame));
        if (c) ctx.state.cursorLocation = c;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.snap_cursor_to_active',
      label: 'Cursor to Active',
      description:
        'Move the 3D cursor to the active object origin, where the scene shows it at the current frame.',
      category: 'Snap',
      undo: false,
      schema: z.object({}),
      execute(ctx) {
        const id = ctx.state.activeId;
        if (!id || !ctx.doc.getObject(id)) return;
        const w = evaluatedWorld(transformFrameState(ctx.doc, ctx.state.frame), id);
        ctx.state.cursorLocation = [w[12], w[13], w[14]];
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.snap_cursor_to_center',
      label: 'Cursor to World Origin',
      description: 'Reset the 3D cursor to the world origin.',
      category: 'Snap',
      undo: false,
      schema: z.object({}),
      execute(ctx) {
        ctx.state.cursorLocation = [0, 0, 0];
        ctx.state.cursorRotation = [0, 0, 0];
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.cursor_set',
      label: 'Set 3D Cursor',
      description: 'Place the 3D cursor at a world location.',
      category: 'Snap',
      undo: false,
      schema: z.object({ location: vec3, rotation: vec3.optional() }),
      execute(ctx, p) {
        ctx.state.cursorLocation = p.location as Vec3;
        if (p.rotation) ctx.state.cursorRotation = p.rotation as Vec3;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.snap_selected_to_cursor',
      label: 'Selection to Cursor',
      description:
        'Move selected objects to the 3D cursor: each origin to the cursor, or with use_offset the selection as ' +
        'a whole, its center (as Cursor to Selected finds it, or the active object with the Active Element pivot ' +
        'point) to the cursor. As in Blender, a selected child of a selected parent only follows its parent.' +
        SNAP_KEYING,
      category: 'Snap',
      schema: z.object({ use_offset: z.boolean().default(false) }),
      poll: (ctx) =>
        ctx.state.mode === 'OBJECT' && selectedObjects(ctx).length ? true : 'Select objects in Object Mode',
      execute(ctx, p) {
        const fs = transformFrameState(ctx.doc, ctx.state.frame);
        const ids = selectedObjects(ctx).map((o) => o.id);
        const c = ctx.state.cursorLocation;
        const offsets = new Map<string, Vec3>();
        // as Blender's snap_selected_to_location, a selected child of a selected parent (or ancestor)
        // only follows it, also without use_offset
        const roots = transformRoots(ctx.doc, ids);
        if (p.use_offset) {
          const active = ctx.state.activeId;
          const center =
            ctx.state.pivotPoint === 'ACTIVE_ELEMENT' && active && ids.includes(active)
              ? (() => {
                  const w = evaluatedWorld(fs, active);
                  return [w[12], w[13], w[14]] as Vec3;
                })()
              : selectionCenter(ctx, fs);
          if (!center) throw new OperatorError('Nothing selected', 'POLL_FAILED');
          const d: Vec3 = [c[0] - center[0], c[1] - center[1], c[2] - center[2]];
          for (const id of roots) offsets.set(id, d);
        } else
          for (const id of roots) {
            const w = evaluatedWorld(fs, id);
            offsets.set(id, [c[0] - w[12], c[1] - w[13], c[2] - w[14]]);
          }
        snapObjects(ctx, fs, offsets);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.snap_selected_to_grid',
      label: 'Selection to Grid',
      description:
        'Snap selected object origins to the nearest grid point: each origin, where the scene shows it at the ' +
        'current frame, moves to the grid point nearest to it. As in Blender, every selected object moves from ' +
        'where it was before the operator, so a selected child of a selected parent also follows its parent’s move.' +
        SNAP_KEYING,
      category: 'Snap',
      schema: z.object({ grid_size: z.number().positive().default(1) }),
      poll: (ctx) =>
        ctx.state.mode === 'OBJECT' && selectedObjects(ctx).length ? true : 'Select objects in Object Mode',
      execute(ctx, p) {
        const fs = transformFrameState(ctx.doc, ctx.state.frame);
        const g = p.grid_size;
        const offsets = new Map<string, Vec3>();
        for (const o of selectedObjects(ctx)) {
          const w = evaluatedWorld(fs, o.id);
          offsets.set(o.id, [0, 1, 2].map((k) => Math.round(w[12 + k] / g) * g - w[12 + k]) as Vec3);
        }
        snapObjects(ctx, fs, offsets);
      },
    }),
  );
}
