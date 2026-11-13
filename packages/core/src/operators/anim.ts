import { z } from 'zod';
import type { AnimTargetType, FCurve, Interpolation } from '../doc/types';
import { fcurveKey, type SceneDoc } from '../doc/scene-doc';
import { FrameState } from '../eval/frame-state';
import { createFCurve, evaluateFCurve, hasKeyframeAt, insertKeyframe, removeKeyframe } from '../anim/fcurve';
import { isAnimatable, propertyLength, readChannel } from '../anim/properties';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { selectedObjects } from './helpers';
import { resolveDatablock } from './datablocks';

/** Reads the current stored datablock for an animation target. */
export function readTarget(
  ctx: OperatorContext,
  type: AnimTargetType,
  id: string,
): Record<string, unknown> | null {
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
    case 'mesh':
      return d.getMeshBlock(id)
        ? ({ shape_keys: d.getShapeKeys(id) } as unknown as Record<string, unknown>)
        : null;
    case 'curve':
      return d.getCurve(id) as unknown as Record<string, unknown> | null;
  }
}

/**
 * Inserts keyframes for every channel of `path` (or one `index`) at `frame` using current values:
 * `opts.value`, else the value the property shows at the frame of `opts.shown` (a FrameState: an
 * animated or driven value where it has one, as Blender keys a property's current value), else its
 * stored value (what an operator that has just set it keys).
 */
export function keyProperty(
  ctx: OperatorContext,
  type: AnimTargetType,
  id: string,
  path: string,
  frame: number,
  opts: { index?: number; value?: number; interpolation?: Interpolation; shown?: FrameState } = {},
): number {
  if (!isAnimatable(type, path))
    throw new OperatorError(`Property '${path}' of ${type} is not animatable`, 'INVALID_PARAMS');
  const target = readTarget(ctx, type, id);
  if (!target) throw new OperatorError(`${type} '${id}' not found`, 'NOT_FOUND');
  const len = propertyLength(type, path, target);
  if (!len || (readChannel(target, path, 0) === undefined && opts.value === undefined))
    throw new OperatorError(`Property '${path}' does not exist on this ${type}`, 'INVALID_PARAMS');
  const source = (opts.shown?.get<Record<string, unknown>>(type, id) ?? null) || target;
  const indices =
    opts.index !== undefined && opts.index >= 0 ? [opts.index] : Array.from({ length: len }, (_, i) => i);
  let n = 0;
  for (const index of indices) {
    const key = fcurveKey({ target_type: type, target_id: id, path, index });
    const fc: FCurve =
      ctx.doc.getFCurve(key) ?? createFCurve({ target_type: type, target_id: id, path, index });
    const value = opts.value ?? readChannel(source, path, index) ?? readChannel(target, path, index);
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
    for (const path of ['location', 'rotation_euler', 'scale'])
      keyProperty(ctx, 'object', id, path, ctx.state.frame);
}

/**
 * Gives duplicated datablocks their own copy of the originals' animation, as Blender's Duplicate
 * does with its default Duplicate Data settings (U.dupflag includes Action, so
 * BKE_id_copy_for_duplicate copies the action of the object, of its data and of the data's shape
 * keys). `copies` maps each original datablock (`<type>:<id>`, as F-curves and drivers name their
 * targets) to its copy's id. Its F-curves are copied to the copy, and so are its drivers (Blender
 * copies the drivers with the animation data), whose variables reading a duplicated datablock read
 * its copy (Blender relinks the copies' ID pointers to the duplicated IDs: copy_object_set_idnew).
 */
export function copyAnimation(doc: SceneDoc, copies: ReadonlyMap<string, string>): void {
  for (const [key, copy] of copies) {
    const sep = key.indexOf(':');
    const type = key.slice(0, sep);
    const id = key.slice(sep + 1);
    for (const fc of doc.listFCurves(id))
      if (fc.target_type === type) doc.setFCurve({ ...fc, target_id: copy });
    for (const d of doc.listDrivers(id)) {
      if (d.target_type !== type) continue;
      const variables = (Array.isArray(d.variables) ? d.variables : []).map((v) => {
        const to = copies.get(`${v.target_type}:${v.target_id}`);
        return to ? { ...v, target_id: to } : v;
      });
      doc.setDriver({ ...d, target_id: copy, variables });
    }
  }
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

const keyingSet = z
  .enum(['LocRotScale', 'Location', 'Rotation', 'Scale', 'Available'])
  .default('LocRotScale');

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
      description:
        'Insert keyframes on the selected objects for the given keying set at the current (or given) frame, with ' +
        'the values the objects show at the current frame (an animated or driven channel its value there, as ' +
        'Blender keys the current values; a key at another frame gets the value shown at the current one). ' +
        'Available keys each F-curve the object has, channel by channel.',
      category: 'Animation',
      schema: z.object({ type: keyingSet, frame: z.number().optional() }),
      poll: (ctx) => (selectedObjects(ctx).length ? true : 'No objects selected'),
      execute(ctx, p) {
        const frame = p.frame ?? ctx.state.frame;
        const shown = new FrameState(ctx.doc, ctx.state.frame);
        let n = 0;
        for (const o of selectedObjects(ctx)) {
          if (p.type === 'Available') {
            // each F-curve the object has, channel by channel (Blender's RKS_GEN_available)
            for (const fc of ctx.doc.listFCurves(o.id))
              if (fc.target_type === 'object')
                n += keyProperty(ctx, 'object', o.id, fc.path, frame, { index: fc.index, shown });
          } else
            for (const path of pathsFor(p.type))
              n += keyProperty(ctx, 'object', o.id, path, frame, { shown });
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
        for (const o of selectedObjects(ctx))
          for (const fc of ctx.doc.listFCurves(o.id)) ctx.doc.removeFCurve(fcurveKey(fc));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'anim.keyframe_insert_property',
      label: 'Insert Keyframe (Property)',
      description:
        'Insert a keyframe on any animatable property: target_type object|material|light|camera|world, path e.g. ' +
        '"location", "energy", "base_color". target: an object name or id (for light/camera the light/camera ' +
        'object, for material an object with one material), or a datablock id or name; "world" for the world. ' +
        'index -1 keys all channels. value overrides the current value: without it the value the property shows ' +
        'at the current frame is keyed (an animated or driven value there, as Blender keys the current value), ' +
        'also into another `frame`. Returns {inserted, target_id}.',
      category: 'Animation',
      schema: z.object({
        target_type: z.enum(['object', 'material', 'light', 'camera', 'world']),
        target: z
          .string()
          .describe(
            'Object name or id (light/camera: the light or camera object; material: an object with one material), ' +
              'or a datablock id or name; "world" for the world',
          ),
        path: z.string(),
        index: z.number().int().default(-1),
        frame: z.number().optional(),
        value: z.number().optional(),
        interpolation: z.enum(['CONSTANT', 'LINEAR', 'BEZIER']).default('BEZIER'),
      }),
      execute(ctx, p) {
        const kind = (
          {
            object: 'objects',
            material: 'materials',
            light: 'lights',
            camera: 'cameras',
            world: null,
          } as const
        )[p.target_type];
        const resolved = kind ? resolveDatablock(ctx.doc, kind, p.target) : null;
        if (resolved?.warning) ctx.report('WARNING', resolved.warning);
        const id = resolved ? resolved.id : 'world';
        const n = keyProperty(ctx, p.target_type, id, p.path, p.frame ?? ctx.state.frame, {
          index: p.index,
          value: p.value,
          interpolation: p.interpolation,
          shown: new FrameState(ctx.doc, ctx.state.frame),
        });
        return { inserted: n, target_id: id };
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
            ctx.doc.setFCurve({
              ...fc,
              keyframes: fc.keyframes.map((k) => ({ ...k, interpolation: p.type })),
            });
      },
    }),
  );
  const keyRef = z.object({
    fcurve: z.string().describe('F-curve key "<type>:<id>:<path>:<index>"'),
    frame: z.number(),
  });
  reg.register(
    defineOperator({
      id: 'anim.keyframes_move',
      label: 'Move Keyframes',
      description: 'Move keyframes in time by `delta` frames (keys are identified by f-curve key and frame).',
      category: 'Animation',
      redoable: true,
      schema: z.object({ keys: z.array(keyRef).min(1), delta: z.number().default(0) }),
      execute(ctx, p) {
        const byCurve = new Map<string, number[]>();
        for (const k of p.keys) byCurve.set(k.fcurve, [...(byCurve.get(k.fcurve) ?? []), k.frame]);
        let moved = 0;
        for (const [key, frames] of byCurve) {
          const fc = ctx.doc.getFCurve(key);
          if (!fc) continue;
          const sel = new Set(frames.map((f) => Math.round(f * 1000)));
          const movedKeys = fc.keyframes
            .filter((k) => sel.has(Math.round(k.frame * 1000)))
            .map((k) => ({ ...k, frame: k.frame + p.delta }));
          const targets = new Set(movedKeys.map((k) => Math.round(k.frame * 1000)));
          const rest = fc.keyframes.filter(
            (k) => !sel.has(Math.round(k.frame * 1000)) && !targets.has(Math.round(k.frame * 1000)),
          );
          moved += movedKeys.length;
          ctx.doc.setFCurve({ ...fc, keyframes: [...rest, ...movedKeys] });
        }
        return { moved };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'anim.keyframes_remove',
      label: 'Delete Keyframes',
      description: 'Delete specific keyframes (by f-curve key and frame). Curves left empty are removed.',
      category: 'Animation',
      schema: z.object({ keys: z.array(keyRef).min(1) }),
      execute(ctx, p) {
        let removed = 0;
        for (const k of p.keys) {
          const fc = ctx.doc.getFCurve(k.fcurve);
          if (!fc) continue;
          const next = removeKeyframe(fc, k.frame);
          removed += fc.keyframes.length - next.keyframes.length;
          if (next.keyframes.length === 0) ctx.doc.removeFCurve(k.fcurve);
          else ctx.doc.setFCurve(next);
        }
        return { removed };
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
