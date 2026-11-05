import { z } from 'zod';
import type { DatablockKind } from '../doc/types';
import { ANIMATABLE } from '../anim/properties';
import { defineOperator, type OperatorRegistry } from './registry';
import { OperatorError, type OperatorContext } from './context';
import { rekeyAnimated } from './anim';
import type { AnimTargetType } from '../doc/types';
import { resolveDatablock } from './datablocks';
import { cameraFields, LIGHT_TYPES, lightFields } from './light-camera';

const KINDS = [
  'objects',
  'meshes',
  'materials',
  'lights',
  'cameras',
  'images',
  'collections',
  'scene',
  'render',
  'world',
] as const;

/** Fields that must not be changed through the generic property setter. */
const READONLY = new Set(['id', 'data', 'modifiers']);

/**
 * Value schemas of light and camera fields: data.set_property validates them like
 * light.properties_set / camera.properties_set (enums, ranges), not only by JavaScript type.
 */
const FIELD_SCHEMAS: Partial<Record<DatablockKind, Record<string, z.ZodType>>> = {
  lights: { ...lightFields, type: z.enum(LIGHT_TYPES) },
  cameras: (() => {
    const { angle: _a, dof: _d, ...stored } = cameraFields;
    return { ...stored, type: z.enum(['PERSP', 'ORTHO']) };
  })(),
};

/** Hints for fields that are set through other operators. */
const OTHER_OPERATOR: Partial<Record<DatablockKind, Record<string, string>>> = {
  cameras: {
    angle: 'camera.properties_set {angle} (it sets lens)',
    dof: 'camera.properties_set {dof: {...}} or the dof_* fields',
  },
};

function validateFields(ctx: OperatorContext, kind: DatablockKind, values: Record<string, unknown>): void {
  const schemas = FIELD_SCHEMAS[kind];
  if (!schemas) return;
  for (const [k, v] of Object.entries(values)) {
    const schema = schemas[k];
    if (!schema) continue;
    const res = schema.safeParse(v);
    if (!res.success)
      throw new OperatorError(
        `Invalid value for ${kind} field '${k}': ${res.error.issues.map((i) => i.message).join('; ')}`,
        'INVALID_PARAMS',
      );
  }
  if (kind === 'cameras' && typeof values.dof_focus_object === 'string' && values.dof_focus_object) {
    const o = ctx.doc.resolveObject(values.dof_focus_object);
    if (!o) throw new OperatorError(`Focus object '${values.dof_focus_object}' not found`, 'NOT_FOUND');
    values.dof_focus_object = o.id;
  } else if (kind === 'cameras' && values.dof_focus_object === '') values.dof_focus_object = null;
}

const ANIM_TYPE: Partial<Record<string, AnimTargetType>> = {
  objects: 'object',
  materials: 'material',
  lights: 'light',
  cameras: 'camera',
  world: 'world',
};

/**
 * Generic property setter (like assigning `bpy.data.<kind>[name].<prop> = value`).
 * Covers every scalar/vector field of every datablock and the scene/render/world settings.
 */
export function registerDataOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'data.set_property',
      label: 'Set Property',
      description:
        'Set properties of a datablock (like bpy.data.<kind>[name].<field> = value): kind objects|meshes|materials|' +
        'lights|cameras|images|collections|scene|render|world, values = { field: value }. target (ignored for ' +
        'scene/render/world): the datablock id or name, or for object data the object that uses it: the name or ' +
        'id of a light object (kind lights), camera object (cameras) or mesh object (meshes), or of an object with ' +
        'one material (materials). Field names follow Blender (e.g. location, rotation_euler, hide_viewport, energy, ' +
        'spot_size, shadow_soft_size, size, lens, clip_end, dof_use, base_color, resolution_x, frame_end). For ' +
        'lights and cameras light.properties_set / camera.properties_set are the friendlier tools (several ' +
        'objects, warnings, keyframes).',
      category: 'Data',
      schema: z.object({
        kind: z.enum(KINDS),
        target: z
          .string()
          .optional()
          .describe(
            'Datablock id or name; for lights/cameras/meshes also the name or id of the object using the data',
          ),
        values: z.record(z.string(), z.unknown()),
      }),
      execute(ctx, p) {
        for (const k of Object.keys(p.values))
          if (READONLY.has(k))
            throw new OperatorError(`Field '${k}' cannot be set directly`, 'INVALID_PARAMS');
        if (p.kind === 'scene') ctx.doc.updateScene(p.values);
        else if (p.kind === 'render') ctx.doc.updateRender(p.values);
        else if (p.kind === 'world') ctx.doc.updateWorld(p.values);
        else {
          if (!p.target) throw new OperatorError('target is required', 'INVALID_PARAMS');
          const id = resolveDatablock(ctx.doc, p.kind, p.target).id;
          const current = ctx.doc.getBlock(p.kind, id)!;
          const values = { ...p.values };
          for (const [k, v] of Object.entries(values)) {
            if (!(k in current)) {
              const other = OTHER_OPERATOR[p.kind]?.[k];
              throw new OperatorError(
                `Unknown field '${k}' for ${p.kind}` + (other ? `: use ${other}` : ''),
                'INVALID_PARAMS',
              );
            }
            const cur = current[k];
            if (cur !== null && v !== null && typeof cur !== typeof v)
              throw new OperatorError(`Field '${k}' expects ${typeof cur}`, 'INVALID_PARAMS');
            if (Array.isArray(cur) && (!Array.isArray(v) || (cur.length && v.length !== cur.length)))
              throw new OperatorError(
                `Field '${k}' expects an array of length ${cur.length}`,
                'INVALID_PARAMS',
              );
          }
          validateFields(ctx, p.kind, values);
          ctx.doc.updateBlockByKind(p.kind, id, values);
          const animType = ANIM_TYPE[p.kind];
          if (animType) {
            const animatable = Object.keys(values).filter((k) => k in (ANIMATABLE[animType] ?? {}));
            if (animatable.length) rekeyAnimated(ctx, animType, id, animatable);
          }
          return { kind: p.kind, target: id };
        }
      },
    }),
  );
}
