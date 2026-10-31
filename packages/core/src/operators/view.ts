import { z } from 'zod';
import type { Vec3 } from '../math/types';
import { transformPoint3 } from '../math/vec3';
import { defineOperator, type OperatorRegistry } from './registry';
import { selectionPivot, transformObjects } from './transform';
import { selectedObjects, vec3 } from './helpers';
import { translation4 } from '../math/mat4';

/** 3D cursor and snapping operators (headless-capable). */
export function registerViewOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'view3d.snap_cursor_to_selected',
      label: 'Cursor to Selected',
      description: 'Move the 3D cursor to the center of the selection.',
      category: 'Snap',
      undo: false,
      schema: z.object({}),
      execute(ctx) {
        ctx.state.cursorLocation = selectionPivot(ctx.doc, ctx.state, 'MEDIAN_POINT');
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.snap_cursor_to_active',
      label: 'Cursor to Active',
      description: 'Move the 3D cursor to the active object origin.',
      category: 'Snap',
      undo: false,
      schema: z.object({}),
      execute(ctx) {
        if (!ctx.state.activeId) return;
        ctx.state.cursorLocation = transformPoint3(ctx.doc.worldMatrix(ctx.state.activeId), [0, 0, 0]);
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
      description: 'Move selected objects to the 3D cursor.',
      category: 'Snap',
      schema: z.object({ use_offset: z.boolean().default(false) }),
      poll: (ctx) =>
        ctx.state.mode === 'OBJECT' && selectedObjects(ctx).length ? true : 'Select objects in Object Mode',
      execute(ctx, p) {
        const ids = selectedObjects(ctx).map((o) => o.id);
        const c = ctx.state.cursorLocation;
        if (p.use_offset) {
          const pivot = selectionPivot(ctx.doc, ctx.state, 'MEDIAN_POINT');
          transformObjects(
            ctx.doc,
            ids,
            translation4([c[0] - pivot[0], c[1] - pivot[1], c[2] - pivot[2]]),
            pivot,
            'MEDIAN_POINT',
          );
          return;
        }
        for (const id of ids) {
          const w = ctx.doc.worldMatrix(id);
          transformObjects(
            ctx.doc,
            [id],
            translation4([c[0] - w[12], c[1] - w[13], c[2] - w[14]]),
            [0, 0, 0],
            'MEDIAN_POINT',
          );
        }
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.snap_selected_to_grid',
      label: 'Selection to Grid',
      description: 'Snap selected object origins to the nearest grid point.',
      category: 'Snap',
      schema: z.object({ grid_size: z.number().positive().default(1) }),
      poll: (ctx) =>
        ctx.state.mode === 'OBJECT' && selectedObjects(ctx).length ? true : 'Select objects in Object Mode',
      execute(ctx, p) {
        for (const o of selectedObjects(ctx)) {
          const w = ctx.doc.worldMatrix(o.id);
          const g = p.grid_size;
          const target: Vec3 = [
            Math.round(w[12] / g) * g,
            Math.round(w[13] / g) * g,
            Math.round(w[14] / g) * g,
          ];
          transformObjects(
            ctx.doc,
            [o.id],
            translation4([target[0] - w[12], target[1] - w[13], target[2] - w[14]]),
            [0, 0, 0],
            'MEDIAN_POINT',
          );
        }
      },
    }),
  );
}
