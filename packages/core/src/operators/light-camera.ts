import { z } from 'zod';
import type { CameraData, LightData, ObjectData } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { ANIMATABLE } from '../anim/properties';
import { defineOperator, type OperatorRegistry } from './registry';
import { OperatorError, type OperatorContext } from './context';
import { selectedObjects } from './helpers';
import { keyProperty, rekeyAnimated } from './anim';
import { nameList, objectsUsing, resolveDatablock } from './datablocks';

/*
 * Light and camera data editing (Blender: Properties editor > Object Data of a light or camera,
 * i.e. bpy.data.lights[...] / bpy.data.cameras[...]). The operators take the object that uses the
 * data, so agents never need the hidden datablock ids, and change everything in one undo step.
 */

const DEG = Math.PI / 180;

export const LIGHT_TYPES = ['POINT', 'SUN', 'SPOT', 'AREA'] as const;
export const AREA_SHAPES = ['SQUARE', 'RECTANGLE', 'DISK', 'ELLIPSE'] as const;

const rgb = z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]);

/** Light data fields (Blender names, all optional). Shared by light.properties_set and object.light_add. */
export const lightFields = {
  energy: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Power in watts for POINT, SPOT and AREA lights (Blender default 1000 W) or irradiance in W/m² for SUN ' +
        '(default 1; clear daylight is about 3-5)',
    ),
  color: rgb.optional().describe('Linear RGB light color, usually 0..1 per channel (default [1,1,1])'),
  use_shadow: z.boolean().optional().describe('Whether the light casts shadows (default true)'),
  shadow_soft_size: z
    .number()
    .min(0)
    .optional()
    .describe(
      'POINT and SPOT: radius of the light source in meters (Blender UI "Radius", default 0.25). Larger = softer ' +
        'shadows and broader highlights, 0 = a hard point light. AREA lights use size/size_y, SUN lights angle',
    ),
  spot_size: z
    .number()
    .min(DEG)
    .max(Math.PI)
    .optional()
    .describe('SPOT: full angle of the light cone in radians, 1°..180° (default π/4 = 45°)'),
  spot_blend: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('SPOT: softness of the cone edge, 0 = hard edge .. 1 = fades from the center (default 0.15)'),
  shape: z
    .enum(AREA_SHAPES)
    .optional()
    .describe(
      'AREA: shape of the emitting surface (default SQUARE); RECTANGLE and ELLIPSE use size × size_y',
    ),
  size: z
    .number()
    .min(0)
    .optional()
    .describe(
      'AREA: size in meters: side of a SQUARE, X side of a RECTANGLE, diameter of a DISK, X diameter of an ELLIPSE ' +
        '(default 1). Larger = softer shadows at the same power',
    ),
  size_y: z
    .number()
    .min(0)
    .optional()
    .describe(
      'AREA with shape RECTANGLE or ELLIPSE: size along the light’s local Y axis in meters (default 1)',
    ),
  angle: z
    .number()
    .min(0)
    .max(Math.PI)
    .optional()
    .describe(
      'SUN: angular diameter of the sun disc in radians (default 0.00918 = 0.526°); larger = softer sun shadows ' +
        '(path tracer)',
    ),
};

/** Camera data fields (Blender names, all optional). Shared by camera.properties_set and object.camera_add. */
export const cameraFields = {
  lens: z
    .number()
    .min(1)
    .optional()
    .describe(
      'PERSP: focal length in mm (default 50); smaller = wider view. With the default 36 mm sensor 35 mm ≈ 54° wide',
    ),
  angle: z
    .number()
    .gt(0)
    .lt(Math.PI)
    .optional()
    .describe(
      'PERSP: field of view in radians across the sensor width (the wider image side with sensor_fit AUTO). Sets ' +
        'lens = sensor_width / (2·tan(angle/2)); pass either lens or angle',
    ),
  sensor_width: z.number().min(1).optional().describe('Sensor width in mm (default 36)'),
  sensor_fit: z
    .enum(['AUTO', 'HORIZONTAL', 'VERTICAL'])
    .optional()
    .describe('Which image side the sensor (and ortho_scale) spans: AUTO = the wider side (default)'),
  clip_start: z.number().positive().optional().describe('Near clipping distance in meters (default 0.1)'),
  clip_end: z.number().positive().optional().describe('Far clipping distance in meters (default 1000)'),
  ortho_scale: z
    .number()
    .positive()
    .optional()
    .describe('ORTHO: width of the view in meters across the wider image side (default 6)'),
  shift_x: z
    .number()
    .optional()
    .describe('Horizontal lens shift, in units of the wider image side (default 0)'),
  shift_y: z
    .number()
    .optional()
    .describe('Vertical lens shift, in units of the wider image side (default 0)'),
  dof_use: z
    .boolean()
    .optional()
    .describe(
      'Depth of field on/off (Blender dof.use_dof, default false). Only the path tracer renders the blur',
    ),
  dof_focus_distance: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Distance in meters from the camera to the plane in focus (Blender dof.focus_distance, default 10)',
    ),
  dof_aperture_fstop: z
    .number()
    .positive()
    .optional()
    .describe(
      'F-stop (Blender dof.aperture_fstop, default 2.8): smaller = more blur (1.4 strong, 16 almost none)',
    ),
  dof_focus_object: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Object (name or id) kept in focus (Blender dof.focus_object): overrides dof_focus_distance with the depth ' +
        'of its origin along the view axis at every frame; null or "" clears it',
    ),
  dof: z
    .object({
      use_dof: z.boolean().optional(),
      focus_distance: z.number().min(0).optional(),
      focus_object: z.string().nullable().optional(),
      aperture_fstop: z.number().positive().optional(),
    })
    .optional()
    .describe(
      'Blender-style alternative to the dof_* parameters (camera.data.dof): {use_dof, focus_distance, ' +
        'focus_object, aperture_fstop}',
    ),
};

type LightFieldParams = { [K in keyof typeof lightFields]?: z.infer<(typeof lightFields)[K]> } & {
  type?: LightData['type'];
};
type CameraFieldParams = { [K in keyof typeof cameraFields]?: z.infer<(typeof cameraFields)[K]> } & {
  type?: CameraData['type'];
};

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Validated light data patch for the given fields (unchanged fields are not included), plus
 * warnings for fields that do not affect the resulting light type.
 */
export function lightPatch(
  current: LightData,
  p: LightFieldParams,
): { patch: Partial<LightData>; warnings: string[] } {
  const patch: Partial<LightData> = {};
  const keys = ['type', ...Object.keys(lightFields)] as (keyof LightFieldParams)[];
  for (const k of keys) if (p[k] !== undefined) (patch as Record<string, unknown>)[k] = p[k];
  const type = patch.type ?? current.type;
  const shape = patch.shape ?? current.shape;
  const warnings: string[] = [];
  const unused = (fields: string[], why: string) => {
    const given = fields.filter((f) => f in patch);
    if (given.length)
      warnings.push(
        `${given.join(', ')} ${given.length > 1 ? 'have' : 'has'} no effect on this ${type} light (${why})`,
      );
  };
  if (type !== 'SPOT') unused(['spot_size', 'spot_blend'], 'SPOT lights only');
  if (type !== 'AREA') unused(['shape', 'size', 'size_y'], 'AREA lights only');
  else if (shape !== 'RECTANGLE' && shape !== 'ELLIPSE')
    unused(['size_y'], `only RECTANGLE and ELLIPSE area lights use it; the shape is ${shape}`);
  if (type === 'AREA') unused(['shadow_soft_size'], 'area lights use size/size_y');
  if (type === 'SUN') unused(['shadow_soft_size'], 'sun lights use angle');
  if (type !== 'SUN') unused(['angle'], 'SUN lights only');
  return { patch, warnings };
}

/** Stored camera fields a patch may set. */
const CAMERA_KEYS = [
  'type',
  'lens',
  'sensor_width',
  'sensor_fit',
  'clip_start',
  'clip_end',
  'ortho_scale',
  'shift_x',
  'shift_y',
  'dof_use',
  'dof_focus_distance',
  'dof_aperture_fstop',
  'dof_focus_object',
] as const;

/** Validated camera data patch for the given fields, plus warnings (e.g. DOF settings while DOF is off). */
export function cameraPatch(
  doc: SceneDoc,
  cameraObjectIds: string[],
  current: CameraData,
  p: CameraFieldParams,
): { patch: Partial<CameraData>; warnings: string[] } {
  const flat: Record<string, unknown> = {};
  for (const k of CAMERA_KEYS)
    if (p[k as keyof CameraFieldParams] !== undefined) flat[k] = p[k as keyof CameraFieldParams];
  const dof = p.dof ?? {};
  const alias: [keyof typeof dof, keyof CameraData][] = [
    ['use_dof', 'dof_use'],
    ['focus_distance', 'dof_focus_distance'],
    ['focus_object', 'dof_focus_object'],
    ['aperture_fstop', 'dof_aperture_fstop'],
  ];
  for (const [from, to] of alias) {
    const v = dof[from];
    if (v === undefined) continue;
    if (flat[to] !== undefined && flat[to] !== v)
      throw new OperatorError(`dof.${from} and ${to} disagree: pass only one of them`, 'INVALID_PARAMS');
    flat[to] = v;
  }
  const patch = flat as Partial<CameraData>;
  const warnings: string[] = [];
  if (p.angle !== undefined) {
    if (p.lens !== undefined)
      throw new OperatorError('Pass either lens or angle, not both', 'INVALID_PARAMS');
    const sensor = patch.sensor_width ?? current.sensor_width ?? 36;
    patch.lens = round(sensor / (2 * Math.tan(p.angle / 2)));
    if (patch.lens < 1)
      throw new OperatorError(
        `angle ${p.angle} needs a lens under 1 mm: use a smaller angle`,
        'INVALID_PARAMS',
      );
  }
  if ('dof_focus_object' in patch) {
    const ref = patch.dof_focus_object;
    if (!ref) patch.dof_focus_object = null;
    else {
      const o = doc.resolveObject(ref);
      if (!o) throw new OperatorError(`Focus object '${ref}' not found`, 'NOT_FOUND');
      if (cameraObjectIds.includes(o.id))
        throw new OperatorError(`A camera cannot focus on itself ('${o.name}')`, 'INVALID_PARAMS');
      patch.dof_focus_object = o.id;
    }
  }
  const clipStart = patch.clip_start ?? current.clip_start;
  const clipEnd = patch.clip_end ?? current.clip_end;
  if (clipEnd <= clipStart)
    throw new OperatorError(
      `clip_end (${clipEnd}) must be greater than clip_start (${clipStart})`,
      'INVALID_PARAMS',
    );
  const type = patch.type ?? current.type;
  if (type === 'ORTHO' && (p.lens !== undefined || p.angle !== undefined))
    warnings.push('lens/angle have no effect on an ORTHO camera (use ortho_scale)');
  if (type === 'PERSP' && patch.ortho_scale !== undefined)
    warnings.push('ortho_scale has no effect on a PERSP camera (use lens or angle)');
  const dofOn = patch.dof_use ?? current.dof_use;
  const dofGiven = ['dof_focus_distance', 'dof_aperture_fstop', 'dof_focus_object'].filter((k) => k in patch);
  if (!dofOn && dofGiven.length)
    warnings.push(
      `${dofGiven.join(', ')} set, but depth of field is off: also pass dof_use: true to blur (path tracer only)`,
    );
  return { patch, warnings };
}

interface DataTarget {
  /** The object the data was reached through (null for a datablock nobody uses). */
  object: ObjectData | null;
  /** Light or camera datablock id. */
  data: string;
}

/**
 * Light/camera datablocks named by `object`/`objects` (object names or ids, or datablock ids or
 * names), or the default targets: the selected light/camera objects, for cameras else the scene
 * camera.
 */
function dataTargets(
  ctx: OperatorContext,
  kind: 'lights' | 'cameras',
  p: { object?: string; objects?: string[] },
): DataTarget[] {
  const refs = [...(p.object ? [p.object] : []), ...(p.objects ?? [])];
  const label = kind === 'lights' ? 'light' : 'camera';
  const type = kind === 'lights' ? 'LIGHT' : 'CAMERA';
  const out: DataTarget[] = [];
  const add = (object: ObjectData | null, data: string) => {
    if (!out.some((t) => t.data === data && t.object?.id === object?.id)) out.push({ object, data });
  };
  for (const ref of refs) {
    const r = resolveDatablock(ctx.doc, kind, ref);
    // a datablock id/name: report it through the first object using it
    add(r.object ?? objectsUsing(ctx.doc, kind).find((x) => x.data === r.id) ?? null, r.id);
  }
  if (refs.length) return out;
  for (const o of selectedObjects(ctx)) if (o.type === type && o.data) add(o, o.data);
  if (!out.length && kind === 'cameras') {
    const sceneCam = ctx.doc.getScene().camera;
    const o = sceneCam ? ctx.doc.getObject(sceneCam) : null;
    if (o && o.type === 'CAMERA' && o.data) add(o, o.data);
  }
  if (!out.length) {
    const names = objectsUsing(ctx.doc, kind).map((o) => o.name);
    throw new OperatorError(
      `No ${label} object given or selected: pass object (a ${label} object name or id)` +
        (names.length ? `; ${label} objects: ${nameList(names)}` : `; the scene has no ${label} objects`),
      'INVALID_PARAMS',
    );
  }
  return out;
}

/** Keys the given animatable fields at `frame` (keyframe=true) or re-keys channels that are already animated. */
function keyFields(
  ctx: OperatorContext,
  type: 'light' | 'camera',
  id: string,
  fields: string[],
  keyframe: boolean,
  frame: number,
): number {
  const animatable = fields.filter((k) => k in (ANIMATABLE[type] ?? {}));
  if (!animatable.length) return 0;
  if (!keyframe) {
    rekeyAnimated(ctx, type, id, animatable);
    return 0;
  }
  let n = 0;
  for (const path of animatable) n += keyProperty(ctx, type, id, path, frame);
  return n;
}

const targetParams = {
  object: z
    .string()
    .optional()
    .describe('Object (name or id) whose data to change; a datablock id or name works too'),
  objects: z.array(z.string()).optional().describe('Several objects (names or ids) to change at once'),
};

const keyParams = {
  keyframe: z
    .boolean()
    .default(false)
    .describe(
      'Also insert keyframes for the animatable values given (energy, color, lens, dof_focus_distance …)',
    ),
  frame: z.number().optional().describe('Frame for keyframe=true (default: the current frame)'),
};

/** Light settings without the datablock id. */
export function summarizeLight(l: LightData): Record<string, unknown> {
  const { id: _id, ...rest } = l;
  return rest;
}
/** Camera settings with the focus object as a name. */
export function summarizeCamera(doc: SceneDoc, c: CameraData): Record<string, unknown> {
  const { id: _id, ...rest } = c;
  const focus = c.dof_focus_object ? doc.getObject(c.dof_focus_object) : null;
  return { ...rest, dof_focus_object: focus ? focus.name : null };
}

export function registerLightCameraOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'light.properties_set',
      label: 'Set Light Properties',
      description:
        'Change the light data of light objects (Blender: Properties > Object Data of a light): type, energy, color, ' +
        'use_shadow, shadow_soft_size (POINT/SPOT radius), spot_size/spot_blend (SPOT cone), shape/size/size_y (AREA ' +
        'soft box), angle (SUN softness). Targets: object/objects (light object names or ids, also datablock ids); ' +
        'default: the selected light objects. Only the given fields change, all targets in one undo step; light objects ' +
        'sharing one light datablock change together. Animated fields are re-keyed at the current frame (keyframe=true ' +
        'inserts keys). Fields that do not apply to the light type are stored but reported as warnings. Returns ' +
        '{lights: [{object, light (datablock id), ...all light settings}], keyframes}.',
      category: 'Data',
      schema: z.object({
        ...targetParams,
        type: z.enum(LIGHT_TYPES).optional().describe('Light type: POINT, SUN, SPOT or AREA'),
        ...lightFields,
        ...keyParams,
      }),
      execute(ctx, p) {
        const targets = dataTargets(ctx, 'lights', p);
        const frame = p.frame ?? ctx.state.frame;
        const lights: Record<string, unknown>[] = [];
        let keyframes = 0;
        const done = new Set<string>();
        for (const t of targets) {
          const current = ctx.doc.getLight(t.data)!;
          if (!done.has(t.data)) {
            done.add(t.data);
            const { patch, warnings } = lightPatch(current, p);
            if (!Object.keys(patch).length)
              throw new OperatorError(
                'No light properties given: pass at least one of type, energy, color, use_shadow, ' +
                  'shadow_soft_size, spot_size, spot_blend, shape, size, size_y, angle',
                'INVALID_PARAMS',
              );
            ctx.doc.updateLight(t.data, patch);
            keyframes += keyFields(ctx, 'light', t.data, Object.keys(patch), p.keyframe, frame);
            for (const w of warnings) ctx.report('WARNING', `${t.object?.name ?? current.name}: ${w}`);
          }
          lights.push({
            object: t.object?.name ?? null,
            light: t.data,
            ...summarizeLight(ctx.doc.getLight(t.data)!),
          });
        }
        return { lights, ...(p.keyframe ? { keyframes } : {}) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'camera.properties_set',
      label: 'Set Camera Properties',
      description:
        'Change the camera data of camera objects (Blender: Properties > Object Data of a camera): type PERSP/ORTHO, ' +
        'lens (mm) or angle (field of view), sensor_width/sensor_fit, clip_start/clip_end, ortho_scale, shift_x/shift_y ' +
        'and depth of field: dof_use, dof_focus_distance, dof_aperture_fstop, dof_focus_object (or Blender-style ' +
        'dof: {use_dof, focus_distance, focus_object, aperture_fstop}). Depth of field is rendered by the path ' +
        'tracer. Targets: object/objects (camera object names or ids); default: the selected cameras, else the ' +
        'scene camera. Only the given fields change, in one undo step. Animated fields are re-keyed at the current ' +
        'frame (keyframe=true inserts keys, e.g. for a focus pull). Returns {cameras: [{object, camera (datablock ' +
        'id), ...all camera settings}], keyframes}.',
      category: 'Data',
      schema: z.object({
        ...targetParams,
        type: z
          .enum(['PERSP', 'ORTHO'])
          .optional()
          .describe('Projection: PERSP (perspective) or ORTHO (orthographic)'),
        ...cameraFields,
        ...keyParams,
      }),
      execute(ctx, p) {
        const targets = dataTargets(ctx, 'cameras', p);
        const frame = p.frame ?? ctx.state.frame;
        const cameras: Record<string, unknown>[] = [];
        let keyframes = 0;
        const done = new Set<string>();
        // every object using a changed camera datablock (a camera must not focus on itself)
        const users = (data: string) =>
          ctx.doc
            .listObjects()
            .filter((o) => o.type === 'CAMERA' && o.data === data)
            .map((o) => o.id);
        for (const t of targets) {
          const current = ctx.doc.getCamera(t.data)!;
          if (!done.has(t.data)) {
            done.add(t.data);
            const { patch, warnings } = cameraPatch(ctx.doc, users(t.data), current, p);
            if (!Object.keys(patch).length)
              throw new OperatorError(
                'No camera properties given: pass at least one of type, lens, angle, sensor_width, sensor_fit, ' +
                  'clip_start, clip_end, ortho_scale, shift_x, shift_y, dof_use, dof_focus_distance, ' +
                  'dof_aperture_fstop, dof_focus_object or dof',
                'INVALID_PARAMS',
              );
            ctx.doc.updateCamera(t.data, patch);
            keyframes += keyFields(ctx, 'camera', t.data, Object.keys(patch), p.keyframe, frame);
            for (const w of warnings) ctx.report('WARNING', `${t.object?.name ?? current.name}: ${w}`);
          }
          cameras.push({
            object: t.object?.name ?? null,
            camera: t.data,
            ...summarizeCamera(ctx.doc, ctx.doc.getCamera(t.data)!),
          });
        }
        return { cameras, ...(p.keyframe ? { keyframes } : {}) };
      },
    }),
  );
}
