import { z } from 'zod';
import type { AnimTargetType, FCurve, Interpolation } from '../doc/types';
import { fcurveKey } from '../doc/scene-doc';
import { createFCurve, evaluateFCurve, hasKeyframeAt, insertKeyframe, removeKeyframe } from '../anim/fcurve';
import { ANIMATABLE, readChannel } from '../anim/properties';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { selectedObjects } from './helpers';

/** Reads the current stored datablock for an animation target. */
export function readTarget(ctx: OperatorContext, type: AnimTargetType, id: string): Record<string, unknown> | null {
  const d = ctx.doc;
  switch (type) {
    case 'object':
      return d.getObject(id) as unknown as Record<string, unknown> | null;
    case 'material':
      return d.getMaterial(id) as unknown as Record<string, unknown> | null;
    case 'light':
      return d.getLight(id) as unknown as Record<string, unknown> | null;
    case 'camera':
      return d.getCamera(id) as unknown as Record<string, unknown> | null;
    case 'world':
      return d.getWorld() as unknown as Record<string, unknown>;
    case 'scene':
      return d.getScene() as unknown as Record<string, unknown>;
  }
}

/** Inserts keyframes for every channel of `path` (or one `index`) at `frame` using current values. */
export function keyProperty(
  ctx: OperatorContext,
  type: AnimTargetType,
  id: string,
  path: string,
  frame: number,
  opts: { index?: number; value?: number; interpolation?: Interpolation } = {},
): number {
  const len = ANIMATABLE[type]?.[path];
  if (!len) throw new OperatorError(`Property '${path}' of ${type} is not animatable`, 'INVALID_PARAMS');
  const target = readTarget(ctx, type, id);
  if (!target) throw new OperatorError(`${type} '${id}' not found`, 'NOT_FOUND');
  const indices = opts.index !== undefined && opts.index >= 0 ? [opts.index] : Array.from({ length: len }, (_, i) => i);
  let n = 0;
  for (const index of indices) {
    const key = fcurveKey({ target_type: type, target_id: id, path, index });
    const fc: FCurve = ctx.doc.getFCurve(key) ?? createFCurve({ target_type: type, target_id: id, path, index });
    const value = opts.value ?? readChannel(target, path, index);
    if (value === undefined) continue;
    ctx.doc.setFCurve(insertKeyframe(fc, frame, value, opts.interpolation));
    n++;
  }
  return n;
}

/**
 * When a property is animated, the stored base value is overridden by the curve. After an edit
 * we (re)key the edited channels at the current frame so the edit is visible — this mirrors
 * Blender's behaviour with auto-keying on, and is applied automatically for already-animated
 * transform channels.
 */
export function autoKeyTransforms(ctx: OperatorContext, ids: string[]): void {
  for (const id of ids)
    for (const path of ['location', 'rotation_euler', 'scale']) keyProperty(ctx, 'object', id, path, ctx.state.frame);
}

/** Updates keyframes of channels that are already animated (keeps edits visible). */
export function rekeyAnimated(ctx: OperatorContext, type: AnimTargetType, id: string, paths: string[]): void {
  for (const fc of ctx.doc.listFCurves(id)) {
    if (fc.target_type !== type || !paths.includes(fc.path)) continue;
    const target = readTarget(ctx, type, id);
    const v = target ? readChannel(target, fc.path, fc.index) : undefined;
    if (v === undefined) continue;
    const cur = evaluateFCurve(fc, ctx.state.frame);
    if (cur !== undefined && Math.abs(cur - v) < 1e-9) continue;
    ctx.doc.setFCurve(insertKeyframe(fc, ctx.state.frame, v));
  }
}

const keyingSet = z.enum(['LocRotScale', 'Location', 'Rotation', 'Scale', 'Available']).default('LocRotScale');

function pathsFor(type: z.infer<typeof keyingSet>): string[] {
  switch (type) {
    case 'Location':
      return ['location'];
    case 'Rotation':
      return ['rotation_euler'];
    case 'Scale':
      return ['scale'];
    default:
      return ['location', 'rotation_euler', 'scale'];
  }
}

export function registerAnimOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'anim.keyframe_insert',
      label: 'Insert Keyframe',
      description: 'Insert keyframes on the selected objects for the given keying set at the current (or given) frame.',
      category: 'Animation',
      schema: z.object({ type: keyingSet, frame: z.number().optional() }),
      poll: (ctx) => (selectedObjects(ctx).length ? true : 'No objects selected'),
      execute(ctx, p) {
        const frame = p.frame ?? ctx.state.frame;
        let n = 0;
        for (const o of selectedObjects(ctx)) {
          if (p.type === 'Available') {
            const animated = new Set(ctx.doc.listFCurves(o.id).map((f) => f.path));
            for (const path of animated) n += keyProperty(ctx, 'object', o.id, path, frame);
          } else for (const path of pathsFor(p.type)) n += keyProperty(ctx, 'object', o.id, path, frame);
        }
        ctx.report('INFO', `Inserted ${n} keyframes at frame ${frame}`);
        return { inserted: n };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'anim.keyframe_delete',
      label: 'Delete Keyframe',
      description: 'Delete keyframes of the selected objects at the current (or given) frame.',
      category: 'Animation',
      schema: z.object({ frame: z.number().optional() }),
      poll: (ctx) => (selectedObjects(ctx).length ? true : 'No objects selected'),
      execute(ctx, p) {
        const frame = p.frame ?? ctx.state.frame;
        let n = 0;
        for (const o of selectedObjects(ctx))
          for (const fc of ctx.doc.listFCurves(o.id)) {
            if (!hasKeyframeAt(fc, frame)) continue;
            const next = removeKeyframe(fc, frame);
            n++;
            if (next.keyframes.length === 0) ctx.doc.removeFCurve(fcurveKey(fc));
            else ctx.doc.setFCurve(next);
          }
        return { deleted: n };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'anim.keyframe_clear',
      label: 'Clear Keyframes',
      description: 'Remove all animation curves from the selected objects.',
      category: 'Animation',
      schema: z.object({}),
      poll: (ctx) => (selectedObjects(ctx).length ? true : 'No objects selected'),
      execute(ctx) {
        for (const o of selectedObjects(ctx)) for (const fc of ctx.doc.listFCurves(o.id)) ctx.doc.removeFCurve(fcurveKey(fc));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'anim.keyframe_insert_property',
      label: 'Insert Keyframe (Property)',
      description:
        'Insert a keyframe on any animatable property: target_type object|material|light|camera|world, path e.g. "location", "energy", "base_color". index -1 keys all channels. value overrides the current value.',
      category: 'Animation',
      schema: z.object({
        target_type: z.enum(['object', 'material', 'light', 'camera', 'world']),
        target: z.string().describe('Datablock id (or object name); "world" for the world'),
        path: z.string(),
        index: z.number().int().default(-1),
        frame: z.number().optional(),
        value: z.number().optional(),
        interpolation: z.enum(['CONSTANT', 'LINEAR', 'BEZIER']).default('BEZIER'),
      }),
      execute(ctx, p) {
        let id = p.target;
        if (p.target_type === 'object') {
          const o = ctx.doc.resolveObject(p.target);
          if (!o) throw new OperatorError(`Object '${p.target}' not found`, 'NOT_FOUND');
          id = o.id;
        }
        if (p.target_type === 'world') id = 'world';
        const n = keyProperty(ctx, p.target_type, id, p.path, p.frame ?? ctx.state.frame, {
          index: p.index,
          value: p.value,
          interpolation: p.interpolation,
        });
        return { inserted: n };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'anim.interpolation_type',
      label: 'Set Interpolation',
      description: 'Set the interpolation of all keyframes on the selected objects.',
      category: 'Animation',
      schema: z.object({ type: z.enum(['CONSTANT', 'LINEAR', 'BEZIER']).default('BEZIER') }),
      execute(ctx, p) {
        for (const o of selectedObjects(ctx))
          for (const fc of ctx.doc.listFCurves(o.id))
            ctx.doc.setFCurve({ ...fc, keyframes: fc.keyframes.map((k) => ({ ...k, interpolation: p.type })) });
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'scene.frame_set',
      label: 'Set Frame',
      description: 'Set the current frame (per-user state).',
      category: 'Animation',
      undo: false,
      schema: z.object({ frame: z.number() }),
      execute(ctx, p) {
        ctx.state.frame = p.frame;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'screen.frame_jump',
      label: 'Jump to Endpoint',
      description: 'Jump to the first or last frame of the scene range.',
      category: 'Animation',
      undo: false,
      schema: z.object({ end: z.boolean().default(false) }),
      execute(ctx, p) {
        const s = ctx.doc.getScene();
        ctx.state.frame = p.end ? s.frame_end : s.frame_start;
      },
    }),
  );
}
