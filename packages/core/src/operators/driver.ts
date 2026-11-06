import { z } from 'zod';
import type {
  AnimTargetType,
  DatablockKind,
  DriverData,
  DriverVariable,
  FCurve,
  FModifierData,
  FModifierType,
  Keyframe,
  ObjectData,
} from '../doc/types';
import { fcurveKey, type SceneDoc } from '../doc/scene-doc';
import { createFCurve } from '../anim/fcurve';
import { ANIMATABLE, isAnimatable, readChannel } from '../anim/properties';
import { getPathValue, parseDataPath } from '../anim/path';
import { EXPRESSION_SYNTAX_HELP, MAX_EXPRESSION_LENGTH, variableNameError } from '../anim/expression';
import { driverProblems } from '../anim/drivers';
import {
  FMODIFIER_PARAM_SCHEMAS,
  FMODIFIER_TYPE_INFO,
  FModifierError,
  defaultFModifierParams,
  normalizeFModifierParams,
  type FModifierParams,
} from '../anim/fmodifiers';
import { FrameState } from '../eval/frame-state';
import { SceneEvaluator } from '../eval/evaluate';
import { renderItems } from '../eval/renderables';
import { cameraFovY } from '../eval/camera';
import { evaluatedBounds } from '../io/common';
import { worldMatrixToTransform } from '../constraints/bake';
import { RigidBodySimulator } from '../physics/rigid-body';
import { multiply4 } from '../math/mat4';
import type { Mat4, Vec3 } from '../math/types';
import { renderAnimation } from '../render/animation';
import { base64Encode } from '../util/json';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, safeJsonSchema, type OperatorRegistry } from './registry';
import { activeObject, pollObjectMode, resolveObjectIds, setSelection, vec3 } from './helpers';
import { keyProperty, readTarget } from './anim';

/*
 * Animation tool operators: drivers (anim.driver_*), F-curve modifiers (anim.fmodifier_*), curve
 * extrapolation, bulk keyframing, camera turntables, transform baking and animation rendering
 * (render.render_animation). Each run is one document transaction (one undo step; the render is
 * read-only). Datablocks are referenced by id or exact name; data datablocks (light, camera, mesh,
 * curve, material) can also be reached through an object that uses them.
 */

const TARGET_TYPES = ['object', 'material', 'light', 'camera', 'world', 'scene', 'mesh', 'curve'] as const;
const FMOD_TYPES = ['NOISE', 'STEPPED', 'GENERATOR', 'LIMITS', 'ENVELOPE'] as const;
const TRANSFORM_PATHS = ['location', 'rotation_euler', 'scale'] as const;

const targetTypeSchema = z
  .enum(TARGET_TYPES)
  .default('object')
  .describe(
    'Datablock type: object, material, light, camera, world, scene, mesh (shape keys, path ' +
      'shape_keys["Key"].value) or curve (curve / text data)',
  );

const targetRef = (fallback: string) =>
  z
    .string()
    .optional()
    .describe(
      'The datablock: for object an object id or exact name; for material/light/camera/mesh/curve a datablock id ' +
        'or name, or an object using it (its data; for material its first material slot); ignored for world/scene. ' +
        `Default: ${fallback}`,
    );

/** Data path examples shared by the driver and keyframe path descriptions. */
const PATH_EXAMPLES =
  'object "location", "rotation_euler" (radians), "scale", "color", \'pose.bones["Bone"].rotation_euler\', ' +
  '\'modifiers["Wave"].height\', \'constraints["Track To"].influence\'; material "base_color", "roughness", ' +
  '"emission_strength"; light "energy", "color"; camera "lens"; world "strength"; mesh ' +
  '\'shape_keys["Smile"].value\'; curve "bevel_depth", "eval_time"';

/** Paths drivers can drive and variables can read: any numeric property, custom properties too. */
const PATH_HELP =
  `Data path in Blender syntax, e.g. ${PATH_EXAMPLES}; also custom properties ('custom_props["amount"]') ` +
  'and other numeric properties';

/** Paths that can get keyframes (animatable properties; custom properties can only be driven). */
const KEYFRAME_PATH_HELP =
  `Animatable property, data path in Blender syntax, e.g. ${PATH_EXAMPLES}. Custom properties ` +
  '(custom_props) cannot be keyframed: drive them with anim.driver_add instead';

const KIND: Record<AnimTargetType, DatablockKind | null> = {
  object: 'objects',
  material: 'materials',
  light: 'lights',
  camera: 'cameras',
  mesh: 'meshes',
  curve: 'curves',
  world: null,
  scene: null,
};

/** Object types whose `data` is a datablock of the given target type. */
const DATA_OBJECT_TYPES: Partial<Record<AnimTargetType, readonly string[]>> = {
  light: ['LIGHT'],
  camera: ['CAMERA'],
  mesh: ['MESH'],
  curve: ['CURVE', 'FONT'],
};

interface Target {
  type: AnimTargetType;
  id: string;
  name: string;
}

function blockName(doc: SceneDoc, kind: DatablockKind, id: string): string {
  const n = doc.getBlock(kind, id)?.name;
  return typeof n === 'string' ? n : id;
}

/** Display name of a datablock referenced by an animation target type and id. */
function targetName(doc: SceneDoc, type: AnimTargetType, id: string): string {
  if (type === 'world') return 'World';
  if (type === 'scene') return 'Scene';
  const kind = KIND[type];
  return kind && doc.has(kind, id) ? blockName(doc, kind, id) : id;
}

/**
 * Resolves a datablock reference (see `targetRef`). Without a reference the active object (or
 * its data) is used.
 */
function resolveTarget(
  ctx: OperatorContext,
  type: AnimTargetType,
  ref: string | undefined,
  param = 'target',
): Target {
  const doc = ctx.doc;
  if (type === 'world') return { type, id: 'world', name: 'World' };
  if (type === 'scene') return { type, id: 'scene', name: 'Scene' };
  const kind = KIND[type]!;
  if (type !== 'object' && ref !== undefined) {
    if (doc.has(kind, ref)) return { type, id: ref, name: blockName(doc, kind, ref) };
    for (const id of doc.map(kind).keys())
      if (doc.getBlock(kind, id)?.name === ref) return { type, id, name: ref };
  }
  const o = ref !== undefined ? doc.resolveObject(ref) : activeObject(ctx);
  if (!o) {
    if (ref === undefined) throw new OperatorError(`No active object (pass \`${param}\`)`, 'POLL_FAILED');
    throw new OperatorError(
      type === 'object' ? `Object '${ref}' not found` : `No ${type} or object named '${ref}'`,
      'NOT_FOUND',
    );
  }
  if (type === 'object') return { type, id: o.id, name: o.name };
  const dataId =
    type === 'material'
      ? ((o.material_slots ?? []).find((m): m is string => !!m && doc.has('materials', m)) ?? null)
      : DATA_OBJECT_TYPES[type]?.includes(o.type) && o.data && doc.has(kind, o.data)
        ? o.data
        : null;
  if (!dataId) throw new OperatorError(`Object '${o.name}' (${o.type}) has no ${type} data`, 'NOT_FOUND');
  return { type, id: dataId, name: blockName(doc, kind, dataId) };
}

/** Current stored datablock of a target. */
function targetData(ctx: OperatorContext, t: Target): Record<string, unknown> {
  const data = readTarget(ctx, t.type, t.id);
  if (!data) throw new OperatorError(`${t.type} '${t.name}' not found`, 'NOT_FOUND');
  return data;
}

/**
 * Number of channels of a numeric property at a data path (1 for numbers and booleans, the length
 * of numeric vectors). Throws INVALID_PARAMS with a hint for paths that do not resolve.
 */
function channelCount(data: Record<string, unknown>, t: Target, path: string): number {
  try {
    parseDataPath(path);
  } catch (e) {
    throw new OperatorError(`Invalid data path '${path}': ${(e as Error).message}`, 'INVALID_PARAMS');
  }
  const value = getPathValue(data, path);
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'number'))
    return value.length;
  if (value === undefined) {
    const known = Object.keys(ANIMATABLE[t.type] ?? {});
    throw new OperatorError(
      `Property '${path}' does not exist on ${t.type} '${t.name}'` +
        (known.length ? ` (common properties: ${known.join(', ')})` : ''),
      'INVALID_PARAMS',
    );
  }
  throw new OperatorError(
    `Property '${path}' of ${t.type} '${t.name}' is not a number, boolean or numeric vector`,
    'INVALID_PARAMS',
  );
}

/** INVALID_PARAMS error for a data path that cannot get keyframes, with a hint at what can. */
function notAnimatableError(t: Target, path: string, consequence?: string): OperatorError {
  const known = Object.keys(ANIMATABLE[t.type] ?? {});
  const hint = /^custom_props\s*\[/.test(path)
    ? ': custom properties can be driven (anim.driver_add) but not keyframed'
    : known.length
      ? ` (animatable ${t.type} properties: ${known.join(', ')}, or nested paths as in the path description)`
      : ' (see the path description for animatable paths)';
  return new OperatorError(
    `Property '${path}' of ${t.type} is not animatable${consequence ? `, ${consequence}` : ''}${hint}`,
    'INVALID_PARAMS',
  );
}

/** Channel indices addressed by `index` (-1 = all) for a property with `count` channels. */
function channelsOf(count: number, index: number, path: string): number[] {
  if (index < 0) return Array.from({ length: count }, (_, i) => i);
  if (index >= count)
    throw new OperatorError(
      `Index ${index} is out of range for '${path}' (${count} channel${count === 1 ? '' : 's'}, 0..${count - 1})`,
      'INVALID_PARAMS',
    );
  return [index];
}

// ---------------------------------------------------------------- drivers

const variableSchema = z.object({
  name: z
    .string()
    .describe(
      'Name used in the expression: letters, digits and _, starting with a letter; not "frame" or a built-in ' +
        'function/constant name',
    ),
  target_type: targetTypeSchema,
  target: z
    .string()
    .optional()
    .describe(
      'Datablock the variable reads (object id or exact name; for material/light/camera/mesh/curve a datablock id ' +
        'or name, or an object using it; ignored for world/scene). Default: the driven datablock, when target_type ' +
        "is the same as the driver's",
    ),
  path: z.string().min(1).describe(`Property the variable reads. ${PATH_HELP}`),
  index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Channel of a vector property (0 = X/R, 1 = Y/G, 2 = Z/B, 3 = alpha); 0 for scalars'),
});
type VariableInput = z.infer<typeof variableSchema>;

/** Validates and resolves driver variables (names, targets, readable paths). */
function resolveVariables(ctx: OperatorContext, input: VariableInput[], owner: Target): DriverVariable[] {
  const out: DriverVariable[] = [];
  const names = new Set<string>();
  for (const v of input) {
    const nameError = variableNameError(v.name);
    if (nameError) throw new OperatorError(nameError, 'INVALID_PARAMS');
    if (names.has(v.name)) throw new OperatorError(`Duplicate variable name '${v.name}'`, 'INVALID_PARAMS');
    names.add(v.name);
    let t: Target;
    try {
      if (v.target === undefined && v.target_type === owner.type) t = owner;
      else if (v.target === undefined && v.target_type !== 'world' && v.target_type !== 'scene')
        throw new OperatorError(`\`target\` is required to read a ${v.target_type}`, 'INVALID_PARAMS');
      else t = resolveTarget(ctx, v.target_type, v.target);
      const count = channelCount(targetData(ctx, t), t, v.path);
      channelsOf(count, v.index, v.path);
    } catch (e) {
      if (e instanceof OperatorError) throw new OperatorError(`Variable '${v.name}': ${e.message}`, e.code);
      throw e;
    }
    out.push({ name: v.name, target_type: t.type, target_id: t.id, path: v.path, index: v.index });
  }
  return out;
}

/** Throws INVALID_PARAMS listing the problems of a driver (`channel` names it in the message). */
function validateDriver(expression: string, variables: DriverVariable[], channel?: string): void {
  const problems = driverProblems({ expression, variables });
  if (problems.length)
    throw new OperatorError(
      `Invalid driver${channel ? ` ${channel}` : ''}: ${problems.join('; ')}`,
      'INVALID_PARAMS',
    );
}

/**
 * JSON description of drivers with their evaluated property value (and error) at `frame`.
 * Tolerates malformed stored drivers (e.g. from old or foreign snapshots): they are listed with
 * their problems as `error`, so one bad driver never hides the others.
 */
function describeDrivers(ctx: OperatorContext, drivers: DriverData[], frame: number) {
  const fs = new FrameState(ctx.doc, frame);
  return drivers.map((d) => {
    const key = fcurveKey(d);
    let value: number | null = null;
    let error: string | null;
    try {
      const block = fs.get<Record<string, unknown>>(d.target_type, d.target_id);
      error = fs.errors.find((e) => e.source === `driver:${key}`)?.message ?? null;
      value = block && typeof d.path === 'string' ? (readChannel(block, d.path, d.index) ?? null) : null;
    } catch (e) {
      error = (e as Error).message;
    }
    if (!error && (!Array.isArray(d.variables) || typeof d.expression !== 'string')) {
      const problems = driverProblems({ expression: d.expression, variables: d.variables });
      if (problems.length) error = problems.join('; ');
    }
    const vars: unknown[] = Array.isArray(d.variables) ? d.variables : [];
    return {
      key,
      target_type: d.target_type,
      target_id: d.target_id,
      target_name: targetName(ctx.doc, d.target_type, d.target_id),
      path: d.path,
      index: d.index,
      expression: d.expression,
      variables: vars.map((raw) => {
        const v = raw as Partial<DriverVariable> | null;
        if (!v || typeof v !== 'object') return { malformed: raw ?? null };
        const name =
          typeof v.target_id === 'string' && v.target_type
            ? targetName(ctx.doc, v.target_type, v.target_id)
            : null;
        return { ...v, target_name: name };
      }),
      mute: !!d.mute,
      /** Property value at the frame (driven unless muted or failing). */
      value,
      error,
    };
  });
}

/** Drivers of a target, optionally filtered by path and channel. */
function driversOf(ctx: OperatorContext, t: Target, path?: string, index = -1): DriverData[] {
  return ctx.doc
    .listDrivers(t.id)
    .filter(
      (d) =>
        d.target_type === t.type &&
        (path === undefined || d.path === path) &&
        (index < 0 || d.index === index),
    )
    .sort((a, b) => String(a.path).localeCompare(String(b.path)) || a.index - b.index);
}

function noDriverError(ctx: OperatorContext, t: Target, path?: string, index = -1): OperatorError {
  const have = [...new Set(driversOf(ctx, t).map((d) => `${d.path}[${d.index}]`))];
  const what = path === undefined ? '' : ` on '${path}'${index >= 0 ? ` index ${index}` : ''}`;
  return new OperatorError(
    `No driver${what} of ${t.type} '${t.name}'` + (have.length ? ` (driven: ${have.join(', ')})` : ''),
    'NOT_FOUND',
  );
}

// ---------------------------------------------------------------- F-curves and modifiers

/** Animation curves of a target, optionally filtered by path and channel, sorted by path/index. */
function fcurvesOf(ctx: OperatorContext, t: Target, path?: string, index = -1): FCurve[] {
  return ctx.doc
    .listFCurves(t.id)
    .filter(
      (fc) =>
        fc.target_type === t.type &&
        (path === undefined || fc.path === path) &&
        (index < 0 || fc.index === index),
    )
    .sort((a, b) => a.path.localeCompare(b.path) || a.index - b.index);
}

/** Stores a curve, dropping an empty modifier list. */
function writeFCurve(doc: SceneDoc, fc: FCurve, modifiers: FModifierData[] | undefined): void {
  const { modifiers: _old, ...rest } = fc;
  doc.setFCurve(modifiers && modifiers.length ? { ...rest, modifiers } : rest);
}

function modifierInfo(fc: FCurve, i: number) {
  const m = fc.modifiers![i];
  return {
    fcurve: fcurveKey(fc),
    path: fc.path,
    index: fc.index,
    modifier_index: i,
    type: m.type,
    mute: !!m.mute,
    params: m.params as unknown as FModifierParams,
  };
}

function fmodParams(type: FModifierType, params: Record<string, unknown>, base?: Record<string, unknown>) {
  try {
    return normalizeFModifierParams(type, params, base);
  } catch (e) {
    if (e instanceof FModifierError) throw new OperatorError(e.message, 'INVALID_PARAMS');
    throw e;
  }
}

const asStored = (p: FModifierParams) => p as unknown as FModifierData['params'];

const FMOD_PARAM_HELP =
  'NOISE {scale (frames per change, default 1), strength (amplitude, default 1), phase (seed, default 1), ' +
  'offset, depth (octaves 0..32), lacunarity, roughness, blend_type REPLACE|ADD|SUBTRACT|MULTIPLY}; STEPPED ' +
  '{frame_step (default 2), frame_offset, use_frame_start/frame_start, use_frame_end/frame_end}; GENERATOR ' +
  '{coefficients [c0, c1, …] = c0 + c1*frame + …, poly_order, mode POLYNOMIAL|POLYNOMIAL_FACTORISED, ' +
  'use_additive}; LIMITS {use_min_x/min_x, use_max_x/max_x (frames), use_min_y/min_y, use_max_y/max_y ' +
  '(values)}; ENVELOPE {reference_value, default_min (-1), default_max (1), control_points [{frame, min ' +
  '(default -1), max (default 1)}]}. All ' +
  'types: use_influence/influence (0..1); all but STEPPED: use_restricted_range, frame_start, frame_end, ' +
  'blend_in, blend_out. anim.fmodifier_type_list returns the full parameter schemas';

// ---------------------------------------------------------------- turntable and bake helpers

/** Camera elevation used when the turntable distance is chosen automatically (radians, ≈17°). */
const TURNTABLE_ELEVATION = 0.3;

/**
 * Bounding sphere (centre, radius) of the rendered geometry of an object and its descendants (or
 * of the whole scene), evaluated at the current frame. Objects without geometry give their origin
 * and radius 0; null when there is nothing to frame.
 */
function framingSphere(
  ctx: OperatorContext,
  objectId: string | null,
): { center: Vec3; radius: number } | null {
  const ev = new SceneEvaluator(ctx.doc).evaluate(ctx.state.frame, { forRender: true, noPhysics: true });
  let owners: Set<string> | null = null;
  if (objectId) {
    owners = new Set([objectId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const o of ev.objects)
        if (o.data.parent && owners.has(o.data.parent) && !owners.has(o.id)) {
          owners.add(o.id);
          grew = true;
        }
    }
  }
  const items = renderItems(ev, { forRender: true }).filter((i) => !owners || owners.has(i.ownerId));
  const b = evaluatedBounds(items);
  if (b) {
    const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const radius = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    return { center, radius };
  }
  const o = objectId ? ev.byId.get(objectId) : undefined;
  return o ? { center: [o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]], radius: 0 } : null;
}

/** Removes the animation curves and drivers of an object whose path starts with one of `paths`. */
function removeAnimation(
  doc: SceneDoc,
  objectId: string,
  match: (path: string) => boolean,
): { fcurves: number; drivers: number } {
  let fcurves = 0;
  let drivers = 0;
  for (const fc of doc.listFCurves(objectId))
    if (fc.target_type === 'object' && match(fc.path)) {
      doc.removeFCurve(fcurveKey(fc));
      fcurves++;
    }
  for (const d of doc.listDrivers(objectId))
    if (d.target_type === 'object' && match(d.path)) {
      doc.removeDriver(fcurveKey(d));
      drivers++;
    }
  return { fcurves, drivers };
}

const hasRigidBodies = (doc: SceneDoc, objects: readonly ObjectData[]) =>
  !!doc.getScene().rigidbody_world?.enabled && objects.some((o) => o.rigid_body?.enabled);

/** Largest number of frames anim.bake_transforms samples in one run. */
const MAX_BAKE_FRAMES = 10000;

/** Largest number of frames render.render_animation renders in one run. */
const MAX_RENDER_FRAMES = 1000;

/** Largest frame width / height of render.render_animation. */
const MAX_RENDER_SIZE = 2048;

/**
 * Default frame size of render.render_animation: the render resolution (with its percentage)
 * scaled so its long side is `fit` pixels at most; an explicit width or height keeps the aspect.
 * A derived side above MAX_RENDER_SIZE scales both sides down, keeping the aspect.
 */
function animationFrameSize(
  doc: SceneDoc,
  width: number | undefined,
  height: number | undefined,
  fit: number,
): { width: number; height: number } {
  const rs = doc.getRender();
  const pct = (rs.resolution_percentage > 0 ? rs.resolution_percentage : 100) / 100;
  const fw = Math.max(1, rs.resolution_x * pct || 1);
  const fh = Math.max(1, rs.resolution_y * pct || 1);
  const aspect = fw / fh;
  let w = width;
  let h = height;
  if (!w && !h) {
    const s = Math.min(1, fit / Math.max(fw, fh));
    w = fw * s;
    h = fh * s;
  } else if (!h) h = w! / aspect;
  else if (!w) w = h * aspect;
  // explicit sides are within the limit already; a derived one may not be
  const s = Math.min(1, MAX_RENDER_SIZE / Math.max(w!, h!));
  return {
    width: Math.max(1, Math.min(MAX_RENDER_SIZE, Math.round(w! * s))),
    height: Math.max(1, Math.min(MAX_RENDER_SIZE, Math.round(h! * s))),
  };
}

export function registerDriverOperators(reg: OperatorRegistry): void {
  // ---------------------------------------------------------------- drivers

  reg.register(
    defineOperator({
      id: 'anim.driver_add',
      label: 'Add Driver',
      description:
        'Add a driver (Blender scripted-expression driver): every frame the property at `path` of the target ' +
        'datablock is set to `expression`, evaluated from `variables` (each reads one channel of any datablock) and ' +
        '`frame` (the current frame). Drivers override keyframes of the same channel and are applied after F-curves ' +
        '(a driver reading its own object sees the keyframed values). Example: target "Wheel", path ' +
        '"rotation_euler", index 1, expression "-x / 0.35", variables [{name: "x", target: "Car", path: ' +
        '"location", index: 0}]. ' +
        EXPRESSION_SYNTAX_HELP +
        ' Returns the created drivers with the driven value (and error, if any) at the current frame.',
      category: 'Animation',
      schema: z.object({
        target_type: targetTypeSchema,
        target: targetRef('the active object (or its data)'),
        path: z.string().min(1).describe(`Driven property. ${PATH_HELP}`),
        index: z
          .number()
          .int()
          .min(-1)
          .default(-1)
          .describe(
            'Channel of a vector property (0 = X/R, 1 = Y/G, 2 = Z/B, 3 = alpha); -1 = every channel, each with its ' +
              'own driver using the same expression; scalars use channel 0',
          ),
        expression: z
          .string()
          .min(1)
          .max(MAX_EXPRESSION_LENGTH)
          .describe(
            'Expression giving the property value (radians for rotations), e.g. "sin(frame / 10) * 2"',
          ),
        variables: z
          .array(variableSchema)
          .max(64)
          .default([])
          .describe('Variables available in the expression, each reading one channel of a datablock'),
        replace: z
          .boolean()
          .default(true)
          .describe('Replace an existing driver of the same channel (false: fail instead)'),
      }),
      execute(ctx, p) {
        const t = resolveTarget(ctx, p.target_type, p.target);
        const channels = channelsOf(channelCount(targetData(ctx, t), t, p.path), p.index, p.path);
        const variables = resolveVariables(ctx, p.variables, t);
        validateDriver(p.expression, variables);
        const drivers: DriverData[] = channels.map((index) => ({
          target_type: t.type,
          target_id: t.id,
          path: p.path,
          index,
          expression: p.expression,
          variables,
          mute: false,
        }));
        // check every channel before writing: a failed run must not leave some drivers behind
        const taken = drivers.filter((d) => ctx.doc.getDriver(fcurveKey(d)));
        if (taken.length && !p.replace)
          throw new OperatorError(
            `${t.type} '${t.name}' ${taken.map((d) => `${p.path}[${d.index}]`).join(', ')} already ` +
              `${taken.length === 1 ? 'has a driver' : 'have drivers'} (pass replace: true to overwrite)`,
            'INVALID_PARAMS',
          );
        const replaced = taken.length;
        for (const d of drivers) {
          if (ctx.doc.getFCurve(fcurveKey(d)))
            ctx.report(
              'WARNING',
              `${p.path}[${d.index}] of '${t.name}' is keyframed: the driver overrides its animation`,
            );
          ctx.doc.setDriver(d);
        }
        if (t.type === 'scene')
          ctx.report(
            'WARNING',
            'Scene settings are not animated by the evaluator: a scene driver is only seen by other drivers',
          );
        const out = describeDrivers(ctx, drivers, ctx.state.frame);
        for (const d of out)
          if (d.error)
            ctx.report(
              'WARNING',
              `Driver ${d.path}[${d.index}] fails at frame ${ctx.state.frame}: ${d.error}`,
            );
        return { drivers: out, replaced };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'anim.driver_update',
      label: 'Edit Driver',
      description:
        'Change existing drivers of a property: a new `expression`, a new `variables` list (replaces the old list) ' +
        'and/or `mute`. index -1 updates every driven channel of `path`. Returns the drivers with their value (and ' +
        'error) at the current frame.',
      category: 'Animation',
      schema: z.object({
        target_type: targetTypeSchema,
        target: targetRef('the active object (or its data)'),
        path: z.string().min(1).describe('Driven property (data path), as given to anim.driver_add'),
        index: z
          .number()
          .int()
          .min(-1)
          .default(-1)
          .describe('Driven channel; -1 = every driven channel of the path'),
        expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH).optional().describe('New expression'),
        variables: z
          .array(variableSchema)
          .max(64)
          .optional()
          .describe('New variable list (replaces all variables; same format as anim.driver_add)'),
        mute: z.boolean().optional().describe('Disable (true) or enable (false) the drivers'),
      }),
      execute(ctx, p) {
        if (p.expression === undefined && p.variables === undefined && p.mute === undefined)
          throw new OperatorError(
            'Nothing to update: pass expression, variables and/or mute',
            'INVALID_PARAMS',
          );
        const t = resolveTarget(ctx, p.target_type, p.target);
        const found = driversOf(ctx, t, p.path, p.index);
        if (!found.length) throw noDriverError(ctx, t, p.path, p.index);
        const variables = p.variables ? resolveVariables(ctx, p.variables, t) : null;
        const updated: DriverData[] = found.map((d) => ({
          ...d,
          expression: p.expression ?? d.expression,
          // a malformed stored list (evaluated as no variables) is rewritten as an empty one
          variables: variables ?? (Array.isArray(d.variables) ? d.variables : []),
          mute: p.mute ?? !!d.mute,
        }));
        // validate every driver before writing any (e.g. new variables missing a name one uses)
        for (const d of updated) validateDriver(d.expression, d.variables, `${d.path}[${d.index}]`);
        for (const d of updated) ctx.doc.setDriver(d);
        return { drivers: describeDrivers(ctx, updated, ctx.state.frame) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'anim.driver_remove',
      label: 'Remove Driver',
      description:
        'Remove drivers of a datablock: those of `path` (index -1 = all its channels), or every driver of the ' +
        'datablock when `path` is omitted. The properties return to their keyframed / stored values. Returns the ' +
        'removed driver keys.',
      category: 'Animation',
      schema: z.object({
        target_type: targetTypeSchema,
        target: targetRef('the active object (or its data)'),
        path: z.string().min(1).optional().describe('Driven property (default: every driven property)'),
        index: z.number().int().min(-1).default(-1).describe('Driven channel; -1 = all channels'),
      }),
      execute(ctx, p) {
        const t = resolveTarget(ctx, p.target_type, p.target);
        const found = driversOf(ctx, t, p.path, p.index);
        if (!found.length) throw noDriverError(ctx, t, p.path, p.index);
        const removed = found.map((d) => fcurveKey(d));
        for (const key of removed) ctx.doc.removeDriver(key);
        return { removed };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'anim.driver_list',
      label: 'List Drivers',
      description:
        'Read-only: list drivers (all, those of one target type, or of one datablock) with their expression, ' +
        'variables (with resolved target names), mute state, the driven value at `frame` (default: current frame) ' +
        'and the evaluation error, if any. Use it to debug drivers.',
      category: 'Animation',
      undo: false,
      schema: z.object({
        target_type: z.enum(TARGET_TYPES).optional().describe('Only drivers of this datablock type'),
        target: z
          .string()
          .optional()
          .describe(
            'Only drivers of this datablock (id or name, or an object using it; needs target_type, default object)',
          ),
        frame: z.number().optional().describe('Frame to evaluate at (default: the current frame)'),
      }),
      execute(ctx, p) {
        let drivers = ctx.doc.listDrivers();
        if (p.target !== undefined) {
          const t = resolveTarget(ctx, p.target_type ?? 'object', p.target);
          drivers = driversOf(ctx, t);
        } else if (p.target_type) drivers = drivers.filter((d) => d.target_type === p.target_type);
        drivers.sort((a, b) => fcurveKey(a).localeCompare(fcurveKey(b)));
        const frame = p.frame ?? ctx.state.frame;
        return { frame, drivers: describeDrivers(ctx, drivers, frame) };
      },
    }),
  );

  // ---------------------------------------------------------------- F-curve modifiers

  reg.register(
    defineOperator({
      id: 'anim.fmodifier_type_list',
      label: 'List F-Curve Modifier Types',
      description:
        'Read-only: list the F-curve modifier types (NOISE, STEPPED, GENERATOR, LIMITS, ENVELOPE) with what they do, ' +
        'their default params and the JSON schema of the params (names, ranges, descriptions).',
      category: 'Animation',
      undo: false,
      schema: z.object({ type: z.enum(FMOD_TYPES).optional().describe('Only this type (default: all)') }),
      execute(_ctx, p) {
        return {
          types: FMODIFIER_TYPE_INFO.filter((i) => !p.type || i.type === p.type).map((i) => ({
            ...i,
            defaults: defaultFModifierParams(i.type),
            parameters: safeJsonSchema(FMODIFIER_PARAM_SCHEMAS[i.type]),
          })),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'anim.fmodifier_add',
      label: 'Add F-Curve Modifier',
      description:
        'Add an F-curve modifier (Blender FModifier) at the end of the modifier stack of the animation curve of ' +
        '`path` / `index` (index -1: every channel of the property). A channel without a curve gets one with a single ' +
        'keyframe holding its current value at the current frame, so e.g. NOISE can shake a static camera. Time ' +
        'modifiers (STEPPED, LIMITS min_x/max_x) apply first, from the last to the first, and every value ' +
        'modifier (NOISE, GENERATOR, ENVELOPE, LIMITS min_y/max_y) is then evaluated at the modified time ' +
        'wherever it is in the stack (a NOISE listed before a STEPPED is stepped too); value modifiers apply in ' +
        'stack order. On a curve with CYCLIC extrapolation the value modifiers repeat with every cycle (like ' +
        "below Blender's Cycles modifier). A driven channel ignores its curve and modifiers while the driver is " +
        'active (a warning is reported). Params: ' +
        FMOD_PARAM_HELP +
        '. Returns the added modifiers (curve key, stack position, validated params), the created curves and, ' +
        'when some channels are driven, driven_channels.',
      category: 'Animation',
      schema: z.object({
        target_type: targetTypeSchema,
        target: targetRef('the active object (or its data)'),
        path: z.string().min(1).describe(KEYFRAME_PATH_HELP),
        index: z
          .number()
          .int()
          .min(-1)
          .default(-1)
          .describe('Channel (0 = X/R, 1 = Y/G, 2 = Z/B, 3 = alpha); -1 = every channel of the property'),
        type: z.enum(FMOD_TYPES).describe('Modifier type'),
        params: z
          .record(z.string(), z.unknown())
          .default({})
          .describe('Modifier parameters (Blender names; omitted ones get their defaults)'),
        mute: z.boolean().default(false).describe('Add the modifier disabled'),
        vary_phase: z
          .boolean()
          .default(true)
          .describe(
            'NOISE on several channels without an explicit `phase`: channel k gets phase + k * scale so the ' +
              'channels move independently (Blender would give every channel the same noise)',
          ),
      }),
      execute(ctx, p) {
        const t = resolveTarget(ctx, p.target_type, p.target);
        const params = fmodParams(p.type, p.params);
        // channels of the property; curves that already exist count even if the path no longer resolves
        const existing = fcurvesOf(ctx, t, p.path, p.index);
        let count = 0;
        try {
          count = channelCount(targetData(ctx, t), t, p.path);
        } catch (e) {
          if (!existing.length) throw e;
        }
        const channels = count ? channelsOf(count, p.index, p.path) : existing.map((fc) => fc.index);
        // channels without a curve get one keyed at their current value: check they can be keyed
        // before writing anything (a failed run must not leave curves or modifiers behind)
        const missing = channels.filter(
          (index) =>
            !ctx.doc.getFCurve(fcurveKey({ target_type: t.type, target_id: t.id, path: p.path, index })),
        );
        if (missing.length) {
          if (!isAnimatable(t.type, p.path))
            throw notAnimatableError(t, p.path, 'so it cannot get an animation curve');
          const data = targetData(ctx, t);
          for (const index of missing)
            if (readChannel(data, p.path, index) === undefined)
              throw new OperatorError(
                `${p.path}[${index}] of ${t.type} '${t.name}' has no value to key`,
                'INVALID_PARAMS',
              );
        }
        // an active driver overrides the curve of its channel, modifiers included (Blender would
        // apply them to the driver's own curve, which drivers here do not have)
        const driven = channels.filter((index) => {
          const d = ctx.doc.getDriver(
            fcurveKey({ target_type: t.type, target_id: t.id, path: p.path, index }),
          );
          return !!d && !d.mute;
        });
        if (driven.length)
          ctx.report(
            'WARNING',
            `${p.path}[${driven.join(', ')}] of '${t.name}' ${driven.length === 1 ? 'is' : 'are'} driven: the ` +
              `driver overrides the animation curve and its modifiers, so this ${p.type} modifier has no effect ` +
              'while the driver is active (mute or remove the driver with anim.driver_update / ' +
              'anim.driver_remove, or put the effect into its expression, e.g. "... + noise(frame / 10)")',
          );
        const created: string[] = [];
        const added: ReturnType<typeof modifierInfo>[] = [];
        channels.forEach((index, k) => {
          const key = fcurveKey({ target_type: t.type, target_id: t.id, path: p.path, index });
          let fc = ctx.doc.getFCurve(key);
          if (!fc) {
            keyProperty(ctx, t.type, t.id, p.path, ctx.state.frame, { index });
            fc = ctx.doc.getFCurve(key);
            if (!fc)
              throw new OperatorError(
                `Could not create an animation curve for ${p.path}[${index}]`,
                'FAILED',
              );
            created.push(key);
          }
          let own = params;
          if (p.type === 'NOISE' && p.vary_phase && channels.length > 1 && !('phase' in p.params)) {
            const n = params as { phase: number; scale: number };
            own = { ...params, phase: n.phase + k * n.scale } as FModifierParams;
          }
          const modifiers = [...(fc.modifiers ?? []), { type: p.type, mute: p.mute, params: asStored(own) }];
          writeFCurve(ctx.doc, fc, modifiers);
          added.push(modifierInfo({ ...fc, modifiers }, modifiers.length - 1));
        });
        return {
          modifiers: added,
          created_fcurves: created,
          ...(driven.length ? { driven_channels: driven } : {}),
        };
      },
    }),
  );

  const stackSelector = {
    modifier_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Position of the modifier in the stack of each curve (0 = first)'),
    type: z.enum(FMOD_TYPES).optional().describe('Only modifiers of this type'),
  };

  reg.register(
    defineOperator({
      id: 'anim.fmodifier_update',
      label: 'Edit F-Curve Modifier',
      description:
        'Change F-curve modifiers of the curves of `path` / `index` (-1 = all channels): the modifiers at ' +
        '`modifier_index` and/or of `type` (at least one is required) get `params` merged over their current ' +
        'parameters (validated; GENERATOR coefficients follow a new poly_order) and/or a new `mute` state. Returns ' +
        'the updated modifiers.',
      category: 'Animation',
      schema: z.object({
        target_type: targetTypeSchema,
        target: targetRef('the active object (or its data)'),
        path: z.string().min(1).describe('Animated property (data path)'),
        index: z
          .number()
          .int()
          .min(-1)
          .default(-1)
          .describe('Channel; -1 = every animated channel of the path'),
        ...stackSelector,
        params: z.record(z.string(), z.unknown()).default({}).describe('Parameters to change'),
        mute: z.boolean().optional().describe('Disable (true) or enable (false) the modifiers'),
      }),
      execute(ctx, p) {
        if (p.modifier_index === undefined && p.type === undefined)
          throw new OperatorError(
            'Pass modifier_index and/or type to select the modifiers',
            'INVALID_PARAMS',
          );
        const t = resolveTarget(ctx, p.target_type, p.target);
        const curves = fcurvesOf(ctx, t, p.path, p.index);
        if (!curves.length)
          throw new OperatorError(
            `${t.type} '${t.name}' has no animation curve for '${p.path}'`,
            'NOT_FOUND',
          );
        const selected = (m: FModifierData, i: number) =>
          (p.modifier_index === undefined || i === p.modifier_index) && (!p.type || m.type === p.type);
        // validate every change before writing any (params valid for one type may not be for another)
        const plan: { fc: FCurve; next: FModifierData[] }[] = [];
        for (const fc of curves) {
          const mods = fc.modifiers ?? [];
          if (!mods.some(selected)) continue;
          const next = mods.map((m, i) => {
            if (!selected(m, i)) return m;
            let params: FModifierParams;
            try {
              params = fmodParams(m.type, p.params, (m.params ?? {}) as Record<string, unknown>);
            } catch (e) {
              const err = e as OperatorError;
              throw new OperatorError(`${fc.path}[${fc.index}] modifier ${i}: ${err.message}`, err.code);
            }
            return { ...m, mute: p.mute ?? !!m.mute, params: asStored(params) };
          });
          plan.push({ fc, next });
        }
        if (!plan.length) throw new OperatorError('No matching F-curve modifier found', 'NOT_FOUND');
        const updated: ReturnType<typeof modifierInfo>[] = [];
        for (const { fc, next } of plan) {
          writeFCurve(ctx.doc, fc, next);
          next.forEach((m, i) => {
            if (selected(m, i)) updated.push(modifierInfo({ ...fc, modifiers: next }, i));
          });
        }
        return { modifiers: updated };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'anim.fmodifier_remove',
      label: 'Remove F-Curve Modifier',
      description:
        'Remove F-curve modifiers from the animation curves of a datablock: of `path` (default: all animated ' +
        'properties) and `index` (-1 = all channels); only the modifier at `modifier_index` and/or of `type` when ' +
        'given, otherwise every modifier. Keyframes are kept. Returns the number removed.',
      category: 'Animation',
      schema: z.object({
        target_type: targetTypeSchema,
        target: targetRef('the active object (or its data)'),
        path: z.string().min(1).optional().describe('Animated property (default: every animated property)'),
        index: z.number().int().min(-1).default(-1).describe('Channel; -1 = all channels'),
        ...stackSelector,
      }),
      execute(ctx, p) {
        const t = resolveTarget(ctx, p.target_type, p.target);
        const curves = fcurvesOf(ctx, t, p.path, p.index);
        if (!curves.length)
          throw new OperatorError(
            `${t.type} '${t.name}' has no animation curve${p.path ? ` for '${p.path}'` : 's'}`,
            'NOT_FOUND',
          );
        let removed = 0;
        const fcurves: string[] = [];
        for (const fc of curves) {
          const mods = fc.modifiers ?? [];
          const keep = mods.filter(
            (m, i) =>
              !((p.modifier_index === undefined || i === p.modifier_index) && (!p.type || m.type === p.type)),
          );
          if (keep.length === mods.length) continue;
          removed += mods.length - keep.length;
          fcurves.push(fcurveKey(fc));
          writeFCurve(ctx.doc, fc, keep);
        }
        if (!removed) throw new OperatorError('No matching F-curve modifier found', 'NOT_FOUND');
        return { removed, fcurves };
      },
    }),
  );

  // ---------------------------------------------------------------- curves

  reg.register(
    defineOperator({
      id: 'anim.extrapolation_set',
      label: 'Set Extrapolation',
      description:
        'Set how the animation curves of objects continue before their first and after their last keyframe: ' +
        'CONSTANT (hold the end values), LINEAR (continue with the slope of the end segments) or CYCLIC (repeat the ' +
        'keyed range forever, e.g. for loops; keep the first and last key equal for a seamless loop). Like ' +
        "Blender's Cycles modifier, CYCLIC also repeats the curve's F-modifiers with every cycle: a NOISE gives the " +
        'same values in each cycle and jumps back at the cycle boundary unless faded out there (NOISE ' +
        "use_restricted_range with blend_in / blend_out). Affects the objects' curves (optionally only `path` / " +
        '`index`), and with include_data also their object data (light, camera, curve, mesh shape keys) and ' +
        'materials. To change the curves of one datablock only, pass target_type and target instead of objects ' +
        "(as for the F-modifier operators), e.g. {target_type: 'light', target: 'Lamp', path: 'color'} changes the " +
        "light data's color curves but not the lamp object's viewport color, which has the same path. Returns the " +
        'number of curves (fcurves) and how many changed.',
      category: 'Animation',
      schema: z.object({
        objects: z
          .array(z.string())
          .optional()
          .describe('Object ids or names (default: the selected objects); not with target_type'),
        target_type: z
          .enum(TARGET_TYPES)
          .optional()
          .describe(
            'Only the curves of one datablock: object, material, light, camera, world, scene, mesh (shape keys) or ' +
              'curve (with `target`; instead of objects / include_data)',
          ),
        target: targetRef('the active object (or its data)'),
        type: z.enum(['CONSTANT', 'LINEAR', 'CYCLIC']).describe('Extrapolation mode'),
        path: z
          .string()
          .min(1)
          .optional()
          .describe('Only curves of this property, e.g. "rotation_euler" (default: all)'),
        index: z.number().int().min(-1).default(-1).describe('Only this channel; -1 = all channels'),
        include_data: z
          .boolean()
          .default(false)
          .describe(
            "Also the curves of the objects' data (light, camera, curve, mesh) and of their materials",
          ),
      }),
      execute(ctx, p) {
        const targets = new Map<string, Target>();
        if (p.target_type !== undefined) {
          if (p.objects !== undefined || p.include_data)
            throw new OperatorError(
              'Pass either target_type / target (the curves of one datablock) or objects / include_data, not both',
              'INVALID_PARAMS',
            );
          const t = resolveTarget(ctx, p.target_type, p.target);
          targets.set(`${t.type}:${t.id}`, t);
        } else if (p.target !== undefined)
          throw new OperatorError(
            '`target` needs target_type (object, material, light, camera, world, scene, mesh or curve)',
            'INVALID_PARAMS',
          );
        const ids = p.target_type !== undefined ? [] : resolveObjectIds(ctx, p.objects);
        if (p.target_type === undefined && !ids.length)
          throw new OperatorError('No objects selected (pass `objects`)', 'POLL_FAILED');
        for (const id of ids) {
          const o = ctx.doc.getObject(id)!;
          targets.set(`object:${id}`, { type: 'object', id, name: o.name });
          if (!p.include_data) continue;
          for (const type of ['light', 'camera', 'mesh', 'curve'] as const)
            if (DATA_OBJECT_TYPES[type]?.includes(o.type) && o.data)
              targets.set(`${type}:${o.data}`, { type, id: o.data, name: o.data });
          for (const m of o.material_slots ?? [])
            if (m) targets.set(`material:${m}`, { type: 'material', id: m, name: m });
        }
        let matched = 0;
        let changed = 0;
        for (const t of targets.values())
          for (const fc of fcurvesOf(ctx, t, p.path, p.index)) {
            matched++;
            if (fc.extrapolation === p.type) continue;
            ctx.doc.setFCurve({ ...fc, extrapolation: p.type });
            changed++;
          }
        if (!matched) {
          const only = p.target_type !== undefined ? [...targets.values()][0] : null;
          throw new OperatorError(
            `No animation curves${p.path ? ` for '${p.path}'` : ''}` +
              (only ? ` on ${only.type} '${only.name}'` : ' on the given objects'),
            'NOT_FOUND',
          );
        }
        return { type: p.type, fcurves: matched, changed };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'anim.keyframes_insert_many',
      label: 'Insert Keyframes (Bulk)',
      description:
        'Insert many keyframes on one channel in one step: frames[k] gets values[k] (same lengths, up to 100000). ' +
        'Existing keys within 0.001 frames of a new key are replaced; replace = true deletes all other keys of the ' +
        'channel first. Rotations are radians. interpolation applies to each new key (BEZIER = smooth auto-clamped, ' +
        'LINEAR, CONSTANT = hold); easing (LINEAR only) shapes the segment after the key. Optionally sets the ' +
        "curve's extrapolation. Returns the curve key, inserted count and resulting frame range.",
      category: 'Animation',
      schema: z.object({
        target_type: targetTypeSchema,
        target: targetRef('the active object (or its data)'),
        path: z.string().min(1).describe(KEYFRAME_PATH_HELP),
        index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Channel of a vector property (0 = X/R, 1 = Y/G, 2 = Z/B, 3 = alpha); 0 for scalars'),
        frames: z
          .array(z.number())
          .min(1)
          .max(100000)
          .describe('Frame numbers (may be fractional, any order)'),
        values: z
          .array(z.number())
          .min(1)
          .max(100000)
          .describe('Value for each frame (same length as frames)'),
        interpolation: z
          .enum(['CONSTANT', 'LINEAR', 'BEZIER'])
          .default('BEZIER')
          .describe('Interpolation of the new keys'),
        easing: z
          .enum(['AUTO', 'EASE_IN', 'EASE_OUT', 'EASE_IN_OUT'])
          .optional()
          .describe('Easing of LINEAR segments after the new keys (default: none = AUTO)'),
        replace: z.boolean().default(false).describe('Delete all existing keys of the channel first'),
        extrapolation: z
          .enum(['CONSTANT', 'LINEAR', 'CYCLIC'])
          .optional()
          .describe("Also set the curve's extrapolation"),
      }),
      execute(ctx, p) {
        if (p.frames.length !== p.values.length)
          throw new OperatorError(
            `frames (${p.frames.length}) and values (${p.values.length}) must have the same length`,
            'INVALID_PARAMS',
          );
        const t = resolveTarget(ctx, p.target_type, p.target);
        if (!isAnimatable(t.type, p.path)) throw notAnimatableError(t, p.path);
        channelsOf(channelCount(targetData(ctx, t), t, p.path), p.index, p.path);
        const key = fcurveKey({ target_type: t.type, target_id: t.id, path: p.path, index: p.index });
        const fc =
          ctx.doc.getFCurve(key) ??
          createFCurve({ target_type: t.type, target_id: t.id, path: p.path, index: p.index });
        const slot = (f: number) => Math.round(f * 1000);
        const keys = new Map<number, Keyframe>();
        if (!p.replace) for (const k of fc.keyframes) keys.set(slot(k.frame), k);
        const fresh = new Set<number>();
        p.frames.forEach((frame, i) => {
          const s = slot(frame);
          // replace keys within 0.001 frames (neighbouring slots too); later frames win
          for (const n of [s - 1, s + 1]) {
            keys.delete(n);
            fresh.delete(n);
          }
          keys.set(s, {
            frame,
            value: p.values[i],
            interpolation: p.interpolation,
            ...(p.easing ? { easing: p.easing } : {}),
          });
          fresh.add(s);
        });
        const keyframes = [...keys.values()].sort((a, b) => a.frame - b.frame);
        ctx.doc.setFCurve({
          ...fc,
          keyframes,
          ...(p.extrapolation ? { extrapolation: p.extrapolation } : {}),
        });
        if (ctx.doc.getDriver(key))
          ctx.report(
            'WARNING',
            `${p.path}[${p.index}] of '${t.name}' has a driver, which overrides the keyframes`,
          );
        return {
          fcurve: key,
          inserted: fresh.size,
          keyframes: keyframes.length,
          frame_range: [keyframes[0].frame, keyframes[keyframes.length - 1].frame],
        };
      },
    }),
  );

  // ---------------------------------------------------------------- turntable

  reg.register(
    defineOperator({
      id: 'anim.turntable',
      label: 'Camera Turntable',
      description:
        'Make a camera orbit around an object or point (product turntable): adds an empty "Turntable Pivot" at the ' +
        'centre (the bounding-box centre of `target` and its children, `center`, or of all rendered geometry) whose ' +
        'Z rotation is keyed linearly from frame_start to frame_end + 1 with CYCLIC extrapolation (a seamless loop ' +
        'of frame_end - frame_start + 1 frames), and parents a camera to it at `radius` / `height`, aimed at the ' +
        'centre. Uses `camera` (its transform animation is removed) or creates "Turntable Camera"; without radius / ' +
        'height the distance frames the bounding sphere for the camera lens and render aspect (≈17° above). ' +
        'Returns the camera and pivot ids, centre, radius, height and frame range.',
      category: 'Animation',
      poll: pollObjectMode,
      schema: z.object({
        target: z
          .string()
          .optional()
          .describe('Object id or name to orbit (its geometry and children are framed)'),
        center: vec3
          .optional()
          .describe('Orbit centre [x, y, z] in metres (overrides the centre of `target`)'),
        camera: z
          .string()
          .optional()
          .describe('Existing camera object (id or name) to use; default: create a new camera'),
        radius: z
          .number()
          .positive()
          .optional()
          .describe('Horizontal distance from the centre in metres (default: auto)'),
        height: z
          .number()
          .optional()
          .describe('Camera height above the centre in metres (default: auto, ≈17° above)'),
        frame_start: z
          .number()
          .int()
          .optional()
          .describe('First frame of the loop (default: scene frame_start)'),
        frame_end: z.number().int().optional().describe('Last frame of the loop (default: scene frame_end)'),
        revolutions: z.number().positive().max(1000).default(1).describe('Full turns per loop'),
        direction: z
          .enum(['CCW', 'CW'])
          .default('CCW')
          .describe('Orbit direction seen from above: CCW = counter-clockwise (positive Z rotation)'),
        start_angle: z
          .number()
          .default(-Math.PI / 2)
          .describe(
            'Camera angle around Z at frame_start in radians (default -pi/2: in front, on the -Y side)',
          ),
        lens: z.number().positive().default(50).describe('Focal length in mm of a newly created camera'),
        set_active_camera: z.boolean().default(true).describe('Make it the scene camera'),
        set_frame_range: z
          .boolean()
          .default(false)
          .describe('Set the scene frame range to frame_start..frame_end'),
      }),
      execute(ctx, p) {
        const doc = ctx.doc;
        const scene = doc.getScene();
        const start = p.frame_start ?? scene.frame_start;
        const end = p.frame_end ?? scene.frame_end;
        if (end < start)
          throw new OperatorError(`frame_end (${end}) is before frame_start (${start})`, 'INVALID_PARAMS');
        const target = p.target !== undefined ? resolveTarget(ctx, 'object', p.target) : null;
        let camObj: ObjectData | null = null;
        if (p.camera !== undefined) {
          camObj = doc.resolveObject(p.camera);
          if (!camObj) throw new OperatorError(`Camera '${p.camera}' not found`, 'NOT_FOUND');
          if (camObj.type !== 'CAMERA')
            throw new OperatorError(
              `'${camObj.name}' is a ${camObj.type} object, not a camera`,
              'INVALID_PARAMS',
            );
          if (target && camObj.id === target.id)
            throw new OperatorError('The camera cannot orbit around itself', 'INVALID_PARAMS');
        }
        const sphere =
          p.center && p.radius !== undefined && p.height !== undefined
            ? null
            : framingSphere(ctx, target?.id ?? null);
        const center: Vec3 = p.center
          ? [p.center[0], p.center[1], p.center[2]]
          : (sphere?.center ?? [0, 0, 0]);
        const extent = sphere && sphere.radius > 1e-6 ? sphere.radius : 1;
        // distance that fits the bounding sphere into the narrower field of view
        const render = doc.getRender();
        const aspect =
          render.resolution_x > 0 && render.resolution_y > 0
            ? render.resolution_x / render.resolution_y
            : 16 / 9;
        const camData = camObj?.data ? doc.getCamera(camObj.data) : null;
        const fovY = cameraFovY(
          {
            lens: camData?.lens ?? p.lens,
            sensor_width: camData?.sensor_width ?? 36,
            sensor_fit: camData?.sensor_fit ?? 'AUTO',
          },
          aspect,
        );
        const fov = Math.min(fovY, 2 * Math.atan(Math.tan(fovY / 2) * aspect));
        const distance = camData?.type === 'ORTHO' ? extent * 4 : (extent / Math.sin(fov / 2)) * 1.1;
        const radius = p.radius ?? distance * Math.cos(TURNTABLE_ELEVATION);
        const height =
          p.height ??
          (p.radius !== undefined
            ? p.radius * Math.tan(TURNTABLE_ELEVATION)
            : distance * Math.sin(TURNTABLE_ELEVATION));
        const pivot = doc.addObject({
          type: 'EMPTY',
          name: 'Turntable Pivot',
          location: center,
          empty_display_type: 'PLAIN_AXES',
          empty_display_size: Math.max(0.1, Math.min(10, extent * 0.5)),
        });
        const a0 = p.start_angle;
        // in pivot space: on a circle around Z, looking at the pivot origin (camera -Z forward, +Y up)
        const placement = {
          parent: pivot,
          parent_type: 'OBJECT' as const,
          parent_bone: '',
          location: [radius * Math.cos(a0), radius * Math.sin(a0), height] as Vec3,
          rotation_euler: [Math.atan2(radius, height), 0, a0 + Math.PI / 2] as Vec3,
          scale: [1, 1, 1] as Vec3,
        };
        let camera: string;
        let removedAnimation = { fcurves: 0, drivers: 0 };
        if (camObj) {
          camera = camObj.id;
          removedAnimation = removeAnimation(doc, camera, (path) =>
            (TRANSFORM_PATHS as readonly string[]).includes(path),
          );
          doc.updateObject(camera, placement);
          if (camObj.constraints?.length)
            ctx.report(
              'WARNING',
              `Camera '${camObj.name}' has constraints, which still apply on top of the orbit`,
            );
        } else {
          const reach = Math.hypot(radius, height);
          const data = doc.addCamera({
            name: 'Turntable Camera',
            lens: p.lens,
            clip_start: Math.max(1e-4, Math.min(0.1, (reach - extent) / 4)),
            clip_end: Math.max(1000, (reach + extent) * 4),
          });
          camera = doc.addObject({ type: 'CAMERA', name: 'Turntable Camera', data, ...placement });
        }
        const turn = (p.direction === 'CW' ? -1 : 1) * 2 * Math.PI * p.revolutions;
        doc.setFCurve({
          ...createFCurve({ target_type: 'object', target_id: pivot, path: 'rotation_euler', index: 2 }),
          keyframes: [
            { frame: start, value: 0, interpolation: 'LINEAR' },
            { frame: end + 1, value: turn, interpolation: 'LINEAR' },
          ],
          extrapolation: 'CYCLIC',
        });
        if (p.set_active_camera) doc.updateScene({ camera });
        if (p.set_frame_range) doc.updateScene({ frame_start: start, frame_end: end });
        setSelection(ctx, [pivot, camera], camera);
        return {
          camera,
          camera_name: doc.getObject(camera)!.name,
          pivot,
          pivot_name: doc.getObject(pivot)!.name,
          center,
          radius,
          height,
          frame_start: start,
          frame_end: end,
          loop_frames: end - start + 1,
          revolutions: p.revolutions,
          removed_camera_animation: removedAnimation,
        };
      },
    }),
  );

  // ---------------------------------------------------------------- bake

  reg.register(
    defineOperator({
      id: 'anim.bake_transforms',
      label: 'Bake Transforms',
      description:
        'Bake the visual transform of objects (the final result of animation, drivers, parenting, constraints and ' +
        'rigid body simulation) into location / rotation_euler / scale keyframes every `step` frames from ' +
        'frame_start to frame_end (Blender Bake Action with Visual Keying). Values are relative to the evaluated ' +
        'parent (world space with clear_parents, which also unparents and always bakes all channels); rotations ' +
        'stay continuous (compatible eulers). Existing keys of the baked channels inside the range are replaced, ' +
        'and their drivers and F-curve modifiers removed (their effect is baked in). Use clear_constraints to ' +
        'remove the constraints afterwards (otherwise they apply again on top of the keys). Returns per-object ' +
        'counts.',
      category: 'Animation',
      poll: pollObjectMode,
      schema: z.object({
        objects: z
          .array(z.string())
          .optional()
          .describe('Object ids or names (default: the selected objects)'),
        frame_start: z.number().int().optional().describe('First frame (default: scene frame_start)'),
        frame_end: z.number().int().optional().describe('Last frame (default: scene frame_end)'),
        step: z.number().int().min(1).max(1000).default(1).describe('Frames between baked keys'),
        channels: z
          .array(z.enum(TRANSFORM_PATHS))
          .min(1)
          .default(['location', 'rotation_euler', 'scale'])
          .describe('Transform properties to bake'),
        clear_constraints: z
          .boolean()
          .default(false)
          .describe("Remove the objects' constraints after baking"),
        clear_parents: z
          .boolean()
          .default(false)
          .describe('Bake world-space transforms and unparent the objects'),
        interpolation: z
          .enum(['CONSTANT', 'LINEAR', 'BEZIER'])
          .default('LINEAR')
          .describe('Interpolation of the baked keys'),
      }),
      execute(ctx, p) {
        const doc = ctx.doc;
        const ids = [...new Set(resolveObjectIds(ctx, p.objects))];
        if (!ids.length) throw new OperatorError('No objects selected (pass `objects`)', 'POLL_FAILED');
        const scene = doc.getScene();
        const start = p.frame_start ?? scene.frame_start;
        const end = p.frame_end ?? scene.frame_end;
        if (end < start)
          throw new OperatorError(`frame_end (${end}) is before frame_start (${start})`, 'INVALID_PARAMS');
        const count = Math.floor((end - start) / p.step) + 1;
        if (count > MAX_BAKE_FRAMES)
          throw new OperatorError(
            `Too many frames to bake (${count}, at most ${MAX_BAKE_FRAMES}): shorten the range or raise step`,
            'INVALID_PARAMS',
          );
        const frames = Array.from({ length: count }, (_, i) => start + i * p.step);
        const channels = p.clear_parents ? [...TRANSFORM_PATHS] : [...new Set(p.channels)];
        // evaluate every frame first: writing keys changes what later frames evaluate to
        const all = doc.listObjects();
        const sim = hasRigidBodies(doc, all) ? new RigidBodySimulator() : null;
        const samples = new Map(
          ids.map((id) => [
            id,
            { location: [] as Vec3[], rotation_euler: [] as Vec3[], scale: [] as Vec3[] },
          ]),
        );
        const previous = new Map(ids.map((id) => [id, doc.getObject(id)!.rotation_euler]));
        let simError: string | null = null;
        for (const frame of frames) {
          let simulated: Map<string, Mat4> | null = null;
          if (sim && !simError)
            try {
              simulated = sim.evaluate(doc, frame, {
                transformsAt: (f) => new FrameState(doc, f).allWorldMatrices(),
                meshOf: (id) => {
                  const o = doc.getObject(id);
                  return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
                },
              });
            } catch (e) {
              simError = (e as Error).message;
              ctx.report('WARNING', `Rigid body simulation failed, baking without it: ${simError}`);
            }
          const fs = new FrameState(doc, frame, simulated);
          for (const id of ids) {
            const parent = fs.parent(id);
            const world = fs.world(id) ?? multiply4(parent, fs.local(id));
            const hasParent = !!fs.byId.get(id)?.parent;
            const t = worldMatrixToTransform(
              world,
              !p.clear_parents && hasParent ? parent : null,
              previous.get(id),
            );
            previous.set(id, t.rotation_euler);
            const s = samples.get(id)!;
            s.location.push(t.location);
            s.rotation_euler.push(t.rotation_euler);
            s.scale.push(t.scale);
          }
        }
        let removedDrivers = 0;
        let removedModifiers = 0;
        const objects: { object: string; name: string; keyframes: number }[] = [];
        for (const id of ids) {
          const o = doc.getObject(id)!;
          const s = samples.get(id)!;
          let keyframes = 0;
          for (const path of channels)
            for (let i = 0; i < 3; i++) {
              const key = fcurveKey({ target_type: 'object', target_id: id, path, index: i });
              const fc =
                doc.getFCurve(key) ?? createFCurve({ target_type: 'object', target_id: id, path, index: i });
              const kept = fc.keyframes.filter((k) => k.frame < start - 1e-3 || k.frame > end + 1e-3);
              const baked: Keyframe[] = frames.map((frame, j) => ({
                frame,
                value: s[path][j][i],
                interpolation: p.interpolation,
              }));
              removedModifiers += fc.modifiers?.length ?? 0;
              writeFCurve(doc, { ...fc, keyframes: [...kept, ...baked] }, undefined); // setFCurve sorts
              keyframes += baked.length;
              if (doc.getDriver(key)) {
                doc.removeDriver(key);
                removedDrivers++;
              }
            }
          if (o.rigid_body?.enabled && o.rigid_body.type === 'ACTIVE')
            ctx.report(
              'WARNING',
              `'${o.name}' is an active rigid body: the simulation still overrides the baked keys`,
            );
          objects.push({ object: id, name: o.name, keyframes });
        }
        let clearedConstraints = 0;
        for (const id of ids) {
          const o = doc.getObject(id)!;
          if (p.clear_constraints && o.constraints?.length) {
            clearedConstraints += o.constraints.length;
            doc.updateObject(id, { constraints: [] });
            const gone = removeAnimation(doc, id, (path) => path.startsWith('constraints['));
            removedDrivers += gone.drivers;
          }
          if (p.clear_parents && o.parent)
            doc.updateObject(id, { parent: null, parent_type: 'OBJECT', parent_bone: '' });
        }
        return {
          objects,
          frame_start: start,
          frame_end: end,
          step: p.step,
          frames: frames.length,
          channels,
          cleared_constraints: clearedConstraints,
          cleared_parents: p.clear_parents,
          removed_drivers: removedDrivers,
          removed_modifiers: removedModifiers,
        };
      },
    }),
  );

  // ---------------------------------------------------------------- animation rendering

  reg.register(
    defineOperator({
      id: 'render.render_animation',
      label: 'Render Animation (Software)',
      description:
        'Read-only: render a range of frames on the CPU and return the encoded result as base64, e.g. to check ' +
        'motion from keyframes, drivers, F-curve modifiers, turntables or baked animation. Formats: CONTACT_SHEET ' +
        '(default: one PNG showing every rendered frame in a grid, each labelled with its frame number in the ' +
        'top-left corner: the easiest way to see a whole animation at once), GIF (animated, 256-colour palette), ' +
        'APNG (animated PNG, lossless) or PNG_SEQUENCE (one PNG per frame). Frames frame_start..frame_end every ' +
        `frame_step (default: the scene frame range; at most ${MAX_RENDER_FRAMES} frames; use frame_step to ` +
        'sample long animations, e.g. 12-24 tiles for a contact sheet). Camera: `camera`, else the scene camera, ' +
        'else one fixed automatic 3/4 view framing the geometry of all rendered frames (so moving objects move ' +
        'in the image; returned as view). Frame size defaults to the render resolution scaled to fit 480 px ' +
        '(contact sheet tiles: up to 240 px, smaller for many frames). The PATHTRACER engine is far slower than ' +
        'RASTER: keep size, samples and frame count small. time_limit bounds the whole render: each path traced ' +
        'frame gets an equal share of the remaining time and stops sampling when its share runs out (noisier, at ' +
        'least 1 sample per pixel), no frame starts after the budget is used up, ' +
        'and the frames rendered so far are returned (truncated: true). Returns { format, mime, data_base64, ' +
        'bytes, width, height (of one frame), fps, frames (rendered frame numbers), frame_count, truncated }, ' +
        'plus sheet { width, height, columns, rows } for CONTACT_SHEET, files [{ frame, name, data_base64 }] ' +
        'instead of data_base64 for PNG_SEQUENCE, view { position, target, fov_degrees } (usable as a still ' +
        'render viewpoint) when the automatic view was used, and undersampled_frames (path traced frames that ' +
        'ran out of time) when there are any.',
      category: 'Render',
      undo: false,
      schema: z.object({
        format: z
          .enum(['CONTACT_SHEET', 'GIF', 'APNG', 'PNG_SEQUENCE'])
          .default('CONTACT_SHEET')
          .describe('Output: labelled frame grid PNG, animated GIF, animated PNG or one PNG per frame'),
        frame_start: z.number().int().optional().describe('First frame (default: scene frame_start)'),
        frame_end: z.number().int().optional().describe('Last frame (default: scene frame_end)'),
        frame_step: z.number().int().min(1).max(10000).default(1).describe('Render every n-th frame'),
        width: z
          .number()
          .int()
          .min(1)
          .max(2048)
          .optional()
          .describe(
            'Frame width in pixels (default: see description; with only height, keeps the render aspect)',
          ),
        height: z
          .number()
          .int()
          .min(1)
          .max(2048)
          .optional()
          .describe('Frame height in pixels (default: from width and the render aspect)'),
        camera: z.string().optional().describe('Camera object id or name (default: the scene camera)'),
        engine: z
          .enum(['RASTER', 'PATHTRACER'])
          .optional()
          .describe('RASTER (fast) or PATHTRACER (physically based, slow); default: the scene render engine'),
        shading: z
          .enum(['MATERIAL', 'SOLID'])
          .default('MATERIAL')
          .describe('MATERIAL: materials and lights; SOLID: grey clay shading (always rasterized)'),
        samples: z
          .number()
          .int()
          .min(1)
          .max(4096)
          .optional()
          .describe(
            'RASTER: anti-aliasing supersampling 1, 2 or 4 (default 2); PATHTRACER: samples per pixel',
          ),
        fps: z
          .number()
          .positive()
          .max(1000)
          .optional()
          .describe(
            'GIF / APNG playback rate in frames per second (default: scene fps / frame_step = real time)',
          ),
        loop: z
          .number()
          .int()
          .min(0)
          .max(65535)
          .default(0)
          .describe('GIF / APNG play count; 0 = loop forever'),
        dither: z
          .enum(['FLOYD_STEINBERG', 'BAYER', 'NONE'])
          .default('FLOYD_STEINBERG')
          .describe('GIF dithering (BAYER: ordered, stable between frames)'),
        colors: z.number().int().min(2).max(256).default(256).describe('GIF palette size'),
        columns: z
          .number()
          .int()
          .min(1)
          .max(64)
          .optional()
          .describe('CONTACT_SHEET tiles per row (default: a roughly square sheet)'),
        time_limit: z
          .number()
          .min(0)
          .max(3600)
          .default(120)
          .describe(
            'Wall-clock budget of the whole render in seconds (0 = no limit): each path traced frame gets an ' +
              'equal share of the remaining time and stops sampling when its share is used up; no frame is started ' +
              'after the budget runs out, and the frames so far are returned',
          ),
      }),
      execute(ctx, p) {
        const doc = ctx.doc;
        const scene = doc.getScene();
        const start = p.frame_start ?? scene.frame_start;
        const end = p.frame_end ?? scene.frame_end;
        if (end < start)
          throw new OperatorError(`frame_end (${end}) is before frame_start (${start})`, 'INVALID_PARAMS');
        const total = Math.floor((end - start) / p.frame_step) + 1;
        if (total > MAX_RENDER_FRAMES)
          throw new OperatorError(
            `Too many frames (${total}, at most ${MAX_RENDER_FRAMES}): shorten the range or raise frame_step`,
            'INVALID_PARAMS',
          );
        if (p.camera !== undefined) {
          const cam = doc.resolveObject(p.camera);
          if (!cam) throw new OperatorError(`Camera '${p.camera}' not found`, 'NOT_FOUND');
          if (cam.type !== 'CAMERA')
            throw new OperatorError(`'${cam.name}' is a ${cam.type} object, not a camera`, 'INVALID_PARAMS');
        }
        // contact sheets: up to 240 px tiles, smaller so that many frames stay within ~2048 px
        const fit =
          p.format === 'CONTACT_SHEET'
            ? Math.max(48, Math.min(240, Math.floor(2048 / Math.ceil(Math.sqrt(total)))))
            : 480;
        const size = animationFrameSize(doc, p.width, p.height, fit);
        let res: ReturnType<typeof renderAnimation>;
        try {
          res = renderAnimation(doc, {
            format: p.format,
            frame_start: start,
            frame_end: end,
            frame_step: p.frame_step,
            width: size.width,
            height: size.height,
            camera: p.camera,
            engine: p.engine,
            shading: p.shading,
            samples: p.samples,
            fps: p.fps,
            loop: p.loop,
            dither: p.dither,
            colors: p.colors,
            columns: p.columns,
            // also bounds each path traced frame, not only the gaps between frames
            total_time_limit: p.time_limit,
          });
        } catch (e) {
          throw new OperatorError((e as Error).message, 'INVALID_PARAMS');
        }
        const short = res.undersampled_frames;
        const shortNote = short.length
          ? `frame${short.length > 1 ? 's' : ''} ${short.join(', ')} stopped path tracing with fewer samples ` +
            'than requested'
          : '';
        if (res.cancelled)
          ctx.report(
            'WARNING',
            `Stopped after ${res.frames.length} of ${total} frames (time_limit ${p.time_limit} s)` +
              (shortNote ? `; ${shortNote}` : '') +
              ': raise time_limit, or render fewer or smaller frames (or fewer samples)',
          );
        else if (shortNote)
          ctx.report(
            'WARNING',
            `time_limit (${p.time_limit} s) ran out: ${shortNote}; raise time_limit or lower samples`,
          );
        return {
          format: res.format,
          mime: res.mime,
          width: res.width,
          height: res.height,
          fps: res.fps,
          frames: res.frames,
          frame_count: res.frames.length,
          truncated: res.cancelled,
          ...(res.undersampled_frames.length ? { undersampled_frames: res.undersampled_frames } : {}),
          ...(res.view
            ? {
                view: {
                  position: res.view.position,
                  target: res.view.target,
                  fov_degrees: (res.view.fovY * 180) / Math.PI,
                },
              }
            : {}),
          ...(res.sheet ? { sheet: res.sheet } : {}),
          ...(res.data ? { bytes: res.data.length, data_base64: base64Encode(res.data) } : {}),
          ...(res.files
            ? {
                files: res.files.map((f) => ({
                  frame: f.frame,
                  name: f.name,
                  data_base64: base64Encode(f.data),
                })),
              }
            : {}),
        };
      },
    }),
  );
}
