import {
  ANIMATABLE,
  FrameState,
  ROOT_COLLECTION_ID,
  constraintTargets,
  decodeFloat32,
  decompose4,
  isMeshMemoryError,
  meshStats,
  modifierObjectParams,
  normalizeParticleSettings,
  transformPoint3,
  type ConstraintData,
  type CurveData,
  type DriverData,
  type EvalError,
  type EvaluatedObject,
  type EvaluatedScene,
  type FCurve,
  type Mat4,
  type MeshData,
  type ObjectData,
  type SceneDoc,
  type ShapeKeyData,
  type Vec3,
  type WorldSettings,
} from '@3d-editor/core';
import { evaluateCached, type EvalMode } from './eval-cache';

/*
 * Compact JSON descriptions of a scene for MCP agents. Numbers are rounded (get_scene: 4 decimals
 * = 0.1 mm by default, get_object: 6 decimals = 1 µm, both with a `decimals` option), references
 * are given by name (names are unique per datablock kind) and ids are included where useful. Lists
 * that can grow without bound (bones, spline points, shape keys, constraints, drivers, problems…)
 * are truncated, with the full count next to them, so a summary stays small enough to read.
 *
 * Values are the ones at the described frame, like Blender's properties: animated and driven
 * transforms, pose channels, shape key values, constraint influences, light / camera / curve /
 * world settings. Where such a value differs from the one stored in the document (the value that
 * tools such as transform_object edit, overridden by keyframes and drivers), the stored value is
 * listed too (`stored`, `stored_value`, `stored_influence`).
 *
 * Geometry is described as renders show it: the scene is evaluated with the render settings of
 * modifiers, curves and particles (SUBSURF render_levels, SCREW render_steps, show_render, curve
 * render_resolution_u, every particle), and the scene counts only take objects shown in renders
 * (like the renderers and the exporters: objects hidden with hide_render, e.g. Boolean cutters, are
 * counted apart in `not_rendered`). Where the viewport shows other geometry, its counts are listed
 * too (`evaluated_viewport`, `viewport_instances`: the objects shown in the viewport, like the
 * editor's statistics overlay).
 */

const RAD2DEG = 180 / Math.PI;

/** Decimals of the numbers in get_scene (0.1 mm), get_mesh_data and get_instances by default. */
export const SCENE_DECIMALS = 4;
/** Decimals of the numbers in get_object by default (1 µm: labels, jewellery, fine bevels). */
export const OBJECT_DECIMALS = 6;
/** Most decimals a summary can be asked for. */
export const MAX_DECIMALS = 6;

/**
 * Decimals of the summary being built (see {@link withDecimals}). Summaries are built
 * synchronously, so one module-wide setting cannot leak into another call.
 */
let decimalsNow = SCENE_DECIMALS;

/** Runs `fn` (which builds a summary) with numbers rounded to `decimals` (0–6). */
function withDecimals<T>(decimals: number | undefined, fn: () => T): T {
  const prev = decimalsNow;
  decimalsNow = Math.max(0, Math.min(MAX_DECIMALS, Math.round(decimals ?? prev)));
  try {
    return fn();
  } finally {
    decimalsNow = prev;
  }
}

/** Longest lists in `get_scene` (per object) and `get_object`. */
const SCENE_LIST = 12;
const OBJECT_LIST = 64;
/** Most evaluation problems listed. */
const MAX_PROBLEMS = 40;
/** Most users listed per material in `get_scene`. */
const MATERIAL_USERS = 24;
/** Most characters of a text object's body in `get_scene`. */
const TEXT_PREVIEW = 120;
/** Objects listed by `get_scene` unless asked for more. */
export const DEFAULT_MAX_OBJECTS = 300;

/**
 * `v` rounded to `decimals` (default: those of the summary being built, else 4); -0 becomes 0.
 */
export function round(v: number, decimals = decimalsNow): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

export function roundVec<T extends number[]>(v: T, decimals = decimalsNow): T {
  return v.map((x) => round(x, decimals)) as T;
}

/** Decimals of angles in degrees next to radians (two fewer: 0.01° for 4 decimals of radians). */
const degreeDecimals = () => Math.max(0, decimalsNow - 2);

/** The first `max` items and, when there are more, the total. */
function bounded<T>(items: readonly T[], max: number): { items: T[]; total?: number } {
  return items.length > max ? { items: items.slice(0, max), total: items.length } : { items: [...items] };
}

/** `{ [key]: items, [key + '_total']: n }` with the total only when the list was truncated. */
function listField<T>(key: string, items: readonly T[], max: number): Record<string, unknown> {
  if (!items.length) return {};
  const b = bounded(items, max);
  return b.total === undefined ? { [key]: b.items } : { [key]: b.items, [`${key}_total`]: b.total };
}

/** A number or a vector of numbers rounded like the rest of a summary; other values as they are. */
function rounded(v: unknown): unknown {
  if (typeof v === 'number') return round(v);
  const list = Array.isArray(v)
    ? (v as unknown[])
    : ArrayBuffer.isView(v) && !(v instanceof DataView)
      ? Array.from(v as unknown as ArrayLike<unknown>)
      : null;
  if (list && list.length && list.every((x) => typeof x === 'number')) return roundVec(list as number[]);
  return v;
}

/**
 * The stored (document) values of `keys` that differ from their values at the frame `now`: what
 * keyframes, drivers or F-curve modifiers override. Null when nothing differs.
 */
function storedDiff(
  now: object | null | undefined,
  stored: object | null | undefined,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!now || !stored) return null;
  const a = now as Record<string, unknown>;
  const b = stored as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (b[k] === undefined) continue;
    const s = rounded(b[k]);
    if (JSON.stringify(rounded(a[k])) !== JSON.stringify(s)) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

/** `{ [key]: diff }` when `diff` is not null (for spreading into a summary). */
const storedField = (diff: Record<string, unknown> | null, key = 'stored') => (diff ? { [key]: diff } : {});

const TRANSFORM_KEYS = ['location', 'rotation_euler', 'scale'] as const;
/** The channels of a pose bone that was never posed. */
const REST_POSE = { location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1] };

export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

function boundsOf(points: Iterable<Vec3>): Bounds | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const p of points) {
    any = true;
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  if (!any) return null;
  return {
    min: roundVec(min),
    max: roundVec(max),
    size: roundVec([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
    center: roundVec([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]),
  };
}

/**
 * World-space bounds of a mesh's vertices without an array per vertex (a mesh of millions of
 * vertices would otherwise allocate hundreds of megabytes of garbage). Same numbers as
 * transformPoint3 (divided by w unless it is 0).
 */
function meshWorldBounds(mesh: MeshData, m: Mat4): Bounds | null {
  const p = mesh.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const q: Vec3 = [0, 0, 0];
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const iw = w !== 0 ? 1 / w : 1;
    q[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw;
    q[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw;
    q[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw;
    any = true;
    for (let k = 0; k < 3; k++) {
      if (q[k] < min[k]) min[k] = q[k];
      if (q[k] > max[k]) max[k] = q[k];
    }
  }
  if (!any) return null;
  return {
    min: roundVec(min),
    max: roundVec(max),
    size: roundVec([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
    center: roundVec([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]),
  };
}

function* worldLinePoints(lines: Float32Array, m: Mat4): Generator<Vec3> {
  for (let i = 0; i + 2 < lines.length; i += 3)
    yield transformPoint3(m, [lines[i], lines[i + 1], lines[i + 2]]);
}

function* posedBonePoints(ev: EvaluatedObject): Generator<Vec3> {
  for (const b of ev.pose?.bones.values() ?? []) {
    yield transformPoint3(ev.worldMatrix, b.head);
    yield transformPoint3(ev.worldMatrix, b.tail);
  }
}

/**
 * World-space axis aligned bounds of an evaluated object: its geometry after modifiers (meshes,
 * curves and text with a surface), its wire (curves without a surface, also after edge-only
 * modifiers such as ARRAY), its posed bones (armatures), otherwise its origin.
 */
export function worldBounds(ev: EvaluatedObject): Bounds | null {
  if (ev.mesh && ev.mesh.positions.length >= 3) return meshWorldBounds(ev.mesh, ev.worldMatrix);
  // a mesh the server did not load (or could not evaluate): its extent is not known
  if (ev.data.type === 'MESH' && ev.data.data && !ev.mesh) return null;
  if (ev.lines && ev.lines.length >= 3) return boundsOf(worldLinePoints(ev.lines, ev.worldMatrix));
  if (ev.pose?.bones.size) return boundsOf(posedBonePoints(ev));
  const m = ev.worldMatrix;
  return boundsOf([[m[12], m[13], m[14]]]);
}

function nameOf(scene: SceneDoc, id: string | null | undefined): string | null {
  if (!id) return null;
  return scene.getObject(id)?.name ?? id;
}

function collectionName(scene: SceneDoc, id: string): string {
  return scene.getCollection(id)?.name ?? (id === ROOT_COLLECTION_ID ? 'Scene Collection' : id);
}

// ---------------------------------------------------------------- evaluation problems

/** Object (or data) id a problem source refers to, e.g. `pose:<id>`, `driver:object:<id>:…`. */
function problemTarget(source: string): string | null {
  const [kind, ...rest] = source.split(':');
  if (!rest.length) return null;
  if (kind === 'driver') return rest[1] ?? null;
  return rest[0] || null;
}

/** Evaluation problems by object id (data ids are mapped to the objects using them). */
function problemsByObject(scene: SceneDoc, ev: EvaluatedScene): Map<string, EvalError[]> {
  const byData = new Map<string, string[]>();
  for (const o of scene.listObjects()) {
    if (o.data) byData.set(o.data, [...(byData.get(o.data) ?? []), o.id]);
    for (const m of o.material_slots) if (m) byData.set(m, [...(byData.get(m) ?? []), o.id]);
  }
  const out = new Map<string, EvalError[]>();
  for (const e of ev.errors) {
    const t = problemTarget(e.source);
    if (!t) continue;
    for (const id of ev.byId.has(t) ? [t] : (byData.get(t) ?? [])) out.set(id, [...(out.get(id) ?? []), e]);
  }
  return out;
}

/** `message` with object ids replaced by the objects' names (evaluation messages name ids). */
function withNames(scene: SceneDoc, message: string): string {
  return message.replace(/[A-Za-z0-9_-]{8,40}/g, (word) => scene.getObject(word)?.name ?? word);
}

/** A problem with its source made readable (object names instead of ids). */
function describeProblem(
  scene: SceneDoc,
  e: EvalError,
): { source: string; object?: string; message: string } {
  const t = problemTarget(e.source);
  const object = t ? scene.getObject(t)?.name : undefined;
  return {
    source: e.source.split(':')[0],
    ...(object ? { object } : {}),
    message: withNames(scene, e.message),
  };
}

/** Name of the modifier an evaluated modifier error belongs to ('shape keys' for shape key errors). */
function modifierName(o: ObjectData, modifierId: string): string {
  if (modifierId === 'shape_keys') return 'shape keys';
  return o.modifiers.find((m) => m.id === modifierId)?.name ?? modifierId;
}

/** Modifier errors of an evaluated object, by modifier name, with object names in the messages. */
function modifierErrors(scene: SceneDoc, ev: EvaluatedObject): { modifier: string; message: string }[] {
  return ev.modifierErrors.map((e) => ({
    modifier: modifierName(ev.data, e.modifierId),
    message: withNames(scene, e.message),
  }));
}

/**
 * Every evaluation problem of the scene, for the top-level `problems` list: scene errors (drivers,
 * poses, curves, instancing, physics), constraint errors and modifier errors of every object; then
 * those that only the VIEWPORT evaluation has (`viewport` when the viewport may differ), marked
 * `viewport: true`: a Subdivision Surface whose viewport levels are skipped while its render_levels
 * evaluate, for one, which the viewport counts (`evaluated_viewport`) show unsubdivided.
 */
function allProblems(
  scene: SceneDoc,
  ev: EvaluatedScene,
  viewport: EvaluatedScene | null = null,
): Record<string, unknown>[] {
  const out = problemsOf(scene, ev);
  if (!viewport || viewport === ev) return out;
  const index = new Map(out.map((p, i) => [sameProblem(p), i]));
  for (const p of problemsOf(scene, viewport)) {
    const i = index.get(sameProblem(p));
    if (i === undefined) out.push({ ...p, viewport: true });
    // both evaluations skipped it for memory: the viewport's advice names both settings
    // ("levels (render_levels for renders)")
    else out[i] = { ...out[i], message: p.message };
  }
  return out;
}

/**
 * What tells two problems apart, also across the two evaluations: everything but the free heap a
 * memory refusal names, which changes between the evaluations of one call, and the setting it
 * says to lower, which the render evaluation names for renders only.
 */
function sameProblem(p: unknown): string {
  return JSON.stringify(p)
    .replace(/has [\d,]+ MB of its/g, 'has MB of its')
    .replace(/\. Lower [^"]*? to evaluate it on the server/g, '. Lower to evaluate it on the server');
}

/** The problems of one evaluation (see {@link allProblems}). */
function problemsOf(scene: SceneDoc, ev: EvaluatedScene): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = ev.errors.map((e) => describeProblem(scene, e));
  for (const o of ev.objects) {
    for (const e of o.constraintErrors) {
      const c = o.data.constraints?.find((x) => x.id === e.constraintId);
      out.push({
        source: 'constraint',
        object: o.name,
        ...(c ? { constraint: c.name } : {}),
        message: withNames(scene, e.message),
      });
    }
    for (const e of modifierErrors(scene, o))
      out.push({ source: 'modifier', object: o.name, modifier: e.modifier, message: e.message });
  }
  return out;
}

// ---------------------------------------------------------------- feature summaries

function curveSummary(c: CurveData, type: 'CURVE' | 'FONT', detailed: boolean): Record<string, unknown> {
  const points = c.splines.reduce((n, s) => n + s.points.length, 0);
  const types: Record<string, number> = {};
  for (const s of c.splines) types[s.type] = (types[s.type] ?? 0) + 1;
  const out: Record<string, unknown> = {
    kind: type === 'FONT' ? 'text' : 'curve',
    curve: c.name,
    dimensions: c.dimensions,
  };
  if (type === 'FONT') {
    out.body = !detailed && c.body.length > TEXT_PREVIEW ? `${c.body.slice(0, TEXT_PREVIEW)}…` : c.body;
    if (!detailed && c.body.length > TEXT_PREVIEW) out.body_length = c.body.length;
    Object.assign(out, { size: round(c.size), align_x: c.align_x, align_y: c.align_y });
  } else {
    Object.assign(out, {
      splines: c.splines.length,
      points,
      spline_types: types,
      cyclic: c.splines.filter((s) => s.use_cyclic_u).length,
    });
  }
  // the shape settings (curve.properties_set): get_object lists every one, get_scene the ones
  // that shape the surface or differ from the defaults
  if (detailed) {
    Object.assign(out, {
      fill_mode: c.fill_mode,
      bevel_mode: c.bevel_mode,
      bevel_depth: round(c.bevel_depth),
      bevel_resolution: c.bevel_resolution,
      bevel_object: c.bevel_object,
      // [bevel_factor_start, bevel_factor_end]
      bevel_factor: [round(c.bevel_factor_start), round(c.bevel_factor_end)],
      extrude: round(c.extrude),
      offset: round(c.offset),
      use_fill_caps: c.use_fill_caps,
      twist_mode: c.twist_mode,
      resolution_u: c.resolution_u,
      render_resolution_u: c.render_resolution_u,
    });
    if (type === 'CURVE')
      Object.assign(out, {
        use_path: c.use_path,
        path_duration: c.path_duration,
        eval_time: round(c.eval_time),
      });
  } else {
    out.fill_mode = c.fill_mode;
    if (c.bevel_depth > 0 || c.bevel_mode === 'OBJECT')
      Object.assign(out, {
        bevel_mode: c.bevel_mode,
        bevel_depth: round(c.bevel_depth),
        bevel_resolution: c.bevel_resolution,
      });
    if (c.bevel_mode === 'OBJECT' && c.bevel_object) out.bevel_object = c.bevel_object;
    if (c.extrude > 0) out.extrude = round(c.extrude);
    if (c.offset !== 0) out.offset = round(c.offset);
    if (c.bevel_factor_start !== 0 || c.bevel_factor_end !== 1)
      out.bevel_factor = [round(c.bevel_factor_start), round(c.bevel_factor_end)];
    if (c.use_fill_caps) out.use_fill_caps = true;
    if (c.twist_mode !== 'MINIMUM' && type === 'CURVE') out.twist_mode = c.twist_mode;
    if (c.resolution_u !== 12) out.resolution_u = c.resolution_u;
    if (c.render_resolution_u > 0) out.render_resolution_u = c.render_resolution_u;
    // path animation fields (every curve has use_path on, like in Blender): when used
    if (c.use_path && type === 'CURVE' && c.eval_time !== 0)
      Object.assign(out, { path_duration: c.path_duration, eval_time: round(c.eval_time) });
  }
  if (detailed) {
    if (type === 'CURVE') {
      out.splines = c.splines.slice(0, 16).map((s, i) => ({
        index: i,
        type: s.type,
        use_cyclic_u: s.use_cyclic_u,
        ...(s.type === 'NURBS' ? { order_u: s.order_u, use_endpoint_u: s.use_endpoint_u } : {}),
        material_index: s.material_index,
        points: s.points.length,
        co: s.points.slice(0, OBJECT_LIST).map((p) => roundVec([...p.co])),
        ...(s.points.some((p) => p.radius !== 1)
          ? { radius: s.points.slice(0, OBJECT_LIST).map((p) => round(p.radius)) }
          : {}),
        ...(s.points.some((p) => p.tilt !== 0)
          ? { tilt: s.points.slice(0, OBJECT_LIST).map((p) => round(p.tilt)) }
          : {}),
      }));
      if (c.splines.length > 16) out.splines_total = c.splines.length;
    } else
      Object.assign(out, {
        space_line: round(c.space_line),
        space_word: round(c.space_word),
        space_character: round(c.space_character),
        shear: round(c.shear),
        offset_x: round(c.offset_x),
        offset_y: round(c.offset_y),
      });
  }
  return out;
}

/** Armature data; `o` is the object at the frame (animated pose channels). */
function armatureSummary(scene: SceneDoc, o: ObjectData, ev: EvaluatedObject | undefined, detailed: boolean) {
  const arm = o.data ? scene.getArmature(o.data) : null;
  if (!arm) return null;
  const posed = Object.entries(o.pose?.bones ?? {}).filter(
    ([, pb]) =>
      pb.location.some((v) => v !== 0) ||
      pb.rotation_euler.some((v) => v !== 0) ||
      pb.scale.some((v) => v !== 1) ||
      !!pb.constraints?.length,
  );
  const out: Record<string, unknown> = {
    kind: 'armature',
    armature: arm.name,
    bone_count: arm.bones.length,
    pose_position: arm.pose_position,
  };
  if (!detailed) {
    Object.assign(
      out,
      listField(
        'bones',
        arm.bones.map((b) => (b.parent ? `${b.name} < ${b.parent}` : b.name)),
        24,
      ),
    );
    if (posed.length) out.posed_bones = posed.length;
    const ik = posed.filter(([, pb]) => pb.constraints?.some((c) => c.type === 'IK')).map(([n]) => n);
    if (ik.length) out.ik_bones = ik.slice(0, SCENE_LIST);
    return out;
  }
  const world = ev?.worldMatrix;
  out.display_type = arm.display_type;
  out.bones = arm.bones.slice(0, 128).map((b) => {
    const pb = ev?.pose?.bones.get(b.name);
    return {
      name: b.name,
      parent: b.parent,
      head: roundVec([...b.head]),
      tail: roundVec([...b.tail]),
      ...(b.roll ? { roll: round(b.roll) } : {}),
      ...(b.use_connect ? { use_connect: true } : {}),
      ...(b.use_deform ? {} : { use_deform: false }),
      ...(pb && world
        ? {
            posed_head_world: roundVec(transformPoint3(world, pb.head)),
            posed_tail_world: roundVec(transformPoint3(world, pb.tail)),
          }
        : {}),
    };
  });
  if (arm.bones.length > 128) out.bones_total = arm.bones.length;
  // pose channels at the frame (keyed / driven), with the stored channels where they differ
  const storedBones = scene.getObject(o.id)?.pose?.bones ?? {};
  out.pose = Object.fromEntries(
    posed.slice(0, OBJECT_LIST).map(([name, pb]) => {
      const stored = storedBones[name];
      return [
        name,
        {
          location: roundVec([...pb.location]),
          rotation_euler: roundVec([...pb.rotation_euler]),
          scale: roundVec([...pb.scale]),
          // a bone without a stored channel rests at its rest pose (animation may still move it)
          ...storedField(storedDiff(pb, stored ?? REST_POSE, TRANSFORM_KEYS)),
          ...(pb.constraints?.length
            ? {
                constraints: pb.constraints.map((c) =>
                  constraintSummary(
                    scene,
                    c,
                    [],
                    true,
                    stored?.constraints?.find((x) => x.id === c.id),
                  ),
                ),
              }
            : {}),
        },
      ];
    }),
  );
  if (posed.length > OBJECT_LIST) out.pose_total = posed.length;
  return out;
}

/**
 * A constraint (`c` at the frame: animated influence and parameters); `stored` is the document's
 * constraint, whose influence is listed as `stored_influence` when keys or drivers change it.
 */
function constraintSummary(
  scene: SceneDoc,
  c: ConstraintData,
  errors: { constraintId: string; message: string }[],
  detailed: boolean,
  stored?: ConstraintData,
): Record<string, unknown> {
  const targets = constraintTargets(c).map((id) => nameOf(scene, id));
  const errs = errors.filter((e) => e.constraintId === c.id).map((e) => e.message);
  const storedParams = detailed && stored ? storedDiff(c.params, stored.params, Object.keys(c.params)) : null;
  return {
    name: c.name,
    type: c.type,
    ...(targets.length ? { targets } : {}),
    ...(c.subtarget ? { subtarget: c.subtarget } : {}),
    influence: round(c.influence),
    ...(stored && round(stored.influence) !== round(c.influence)
      ? { stored_influence: round(stored.influence) }
      : {}),
    ...(c.mute ? { mute: true } : {}),
    ...(detailed ? { id: c.id, params: c.params } : {}),
    ...storedField(storedParams, 'stored_params'),
    ...(errs.length ? { errors: errs } : {}),
  };
}

function particleSummary(
  scene: SceneDoc,
  o: ObjectData,
  instancesBySystem: Map<string, number>,
  viewportBySystem: Map<string, number> | null,
  detailed: boolean,
) {
  return o.particle_systems.map((ps) => {
    const instances = instancesBySystem.get(ps.id) ?? 0;
    const viewport = viewportBySystem?.get(ps.id) ?? instances;
    const { settings } = normalizeParticleSettings(ps.settings);
    const source =
      settings.instance_type === 'OBJECT'
        ? { instance_object: nameOf(scene, settings.instance_object) }
        : settings.instance_type === 'COLLECTION'
          ? {
              instance_collection: settings.instance_collection
                ? collectionName(scene, settings.instance_collection)
                : null,
            }
          : {};
    return {
      name: ps.name,
      count: settings.count,
      instance_type: settings.instance_type,
      ...source,
      instances,
      ...(viewport !== instances ? { viewport_instances: viewport } : {}),
      ...(settings.display_percentage < 100 ? { display_percentage: settings.display_percentage } : {}),
      ...(ps.show_viewport ? {} : { show_viewport: false }),
      ...(ps.show_render ? {} : { show_render: false }),
      ...(detailed ? { id: ps.id, settings: ps.settings } : {}),
    };
  });
}

function driverSummary(scene: SceneDoc, d: DriverData, detailed: boolean): Record<string, unknown> {
  return {
    path:
      d.index > 0 || /^(location|rotation_euler|scale|color)$/.test(d.path)
        ? `${d.path}[${d.index}]`
        : d.path,
    ...(d.target_type !== 'object' ? { on: d.target_type } : {}),
    expression: d.expression,
    ...(d.mute ? { mute: true } : {}),
    ...(detailed
      ? {
          variables: d.variables.map((v) => ({
            name: v.name,
            target_type: v.target_type,
            target: v.target_type === 'object' ? nameOf(scene, v.target_id) : v.target_id,
            path: v.path,
            index: v.index,
          })),
        }
      : {}),
  };
}

function fcurveLabel(fc: FCurve, objectId: string): string {
  const prefix = fc.target_id === objectId ? '' : `${fc.target_type}.`;
  return `${prefix}${fc.path}[${fc.index}]`;
}

interface InstanceCounts {
  /** Instances shown (their owner object is visible: in renders, or in the viewport). */
  total: number;
  /** Instances per owner object and per particle system id (shown or not). */
  byOwner: Map<string, number>;
  bySystem: Map<string, number>;
}

/** Which objects a count takes: those shown in renders, or those shown in the viewport. */
type Shown = 'RENDER' | 'VIEWPORT';

/** Whether an evaluated object is shown in renders (RENDER) or in the viewport (VIEWPORT). */
const isShown = (o: EvaluatedObject, shown: Shown) => (shown === 'RENDER' ? o.renderVisible : o.visible);

/**
 * Instance counts of `ev`: the instances shown (instances follow their owner's visibility, like
 * the renderers and the viewport), and per owner object and particle system id.
 */
function instanceCounts(ev: EvaluatedScene, shown: Shown): InstanceCounts {
  const byOwner = new Map<string, number>();
  const bySystem = new Map<string, number>();
  let total = 0;
  for (const inst of ev.instances) {
    byOwner.set(inst.ownerId, (byOwner.get(inst.ownerId) ?? 0) + 1);
    // ids: `${owner}:${system}:${particle}…` for particles, `${owner}:${source}` for collections
    const parts = inst.id.split(':');
    if (parts.length >= 3) bySystem.set(parts[1], (bySystem.get(parts[1]) ?? 0) + 1);
    const owner = ev.byId.get(inst.ownerId);
    if (owner && isShown(owner, shown)) total++;
  }
  return { total, byOwner, bySystem };
}

/**
 * `{evaluated_viewport}`: the viewport's evaluated mesh statistics when they differ from the
 * render geometry (`render`), e.g. SCREW steps vs render_steps, SUBSURF levels vs render_levels,
 * a modifier shown in only one of them, or curve resolution_u vs render_resolution_u.
 */
function viewportStats(
  render: MeshData | null | undefined,
  viewport: EvaluatedObject | undefined,
): { evaluated_viewport?: ReturnType<typeof meshStats> | 'none' } {
  if (!viewport || viewport.mesh === render) return {};
  if (!viewport.mesh) return render ? { evaluated_viewport: 'none' } : {};
  const v = meshStats(viewport.mesh);
  if (!render) return { evaluated_viewport: v };
  const r = meshStats(render);
  return v.vertices !== r.vertices || v.faces !== r.faces || v.triangles !== r.triangles
    ? { evaluated_viewport: v }
    : {};
}

function dataSummary(
  scene: SceneDoc,
  o: ObjectData,
  ev: EvaluatedObject | undefined,
  detailed = false,
  ctx?: SummaryContext,
): Record<string, unknown> | null {
  if (o.type === 'MESH' && o.data) {
    let base: MeshData | null = null;
    // a mesh too large to decode in the server's heap (core mesh/memory.ts): its stored counts
    let notLoaded: string | null = null;
    try {
      base = scene.getMesh(o.data);
    } catch (e) {
      if (!isMeshMemoryError(e)) throw e;
      notLoaded = e.message;
    }
    const block = scene.getMeshBlock(o.data);
    const out: Record<string, unknown> = {
      kind: 'mesh',
      mesh: block?.name ?? o.data,
      users: scene.dataUsers(o.data),
    };
    const stored = notLoaded ? scene.meshCounts(o.data) : null;
    if (stored)
      Object.assign(out, {
        vertices: stored.vertices,
        faces: stored.faces,
        triangles: stored.corners - 2 * stored.faces,
        not_loaded: notLoaded,
      });
    if (base) {
      Object.assign(out, meshStats(base));
      // the geometry renders show (listed whenever modifiers or shape keys could change it); the
      // viewport's too where its modifier settings give other geometry
      const viewport = viewportStats(ev?.mesh ?? base, ctx?.viewportOf(o.id));
      if (ev?.mesh && (ev.mesh !== base || o.modifiers.length || viewport.evaluated_viewport))
        out.evaluated = meshStats(ev.mesh);
      Object.assign(out, viewport);
    }
    // values at the frame (keyed / driven), like Blender's shape key sliders; the stored value
    // (what object.shape_key_set changes) when animation overrides it
    const keys = ctx ? ctx.shapeKeys(o.data) : scene.getShapeKeys(o.data);
    const storedKeys = new Map(scene.getShapeKeys(o.data).map((k) => [k.name, k]));
    const storedValue = (k: ShapeKeyData) => {
      const s = storedKeys.get(k.name);
      return s && round(s.value) !== round(k.value) ? { stored_value: round(s.value) } : {};
    };
    if (keys.length)
      Object.assign(
        out,
        listField(
          'shape_keys',
          keys.map((k) =>
            detailed
              ? {
                  name: k.name,
                  value: round(k.value),
                  ...storedValue(k),
                  slider_min: k.slider_min,
                  slider_max: k.slider_max,
                  ...(k.mute ? { mute: true } : {}),
                  ...(k.relative_key ? { relative_key: k.relative_key } : {}),
                }
              : { name: k.name, value: round(k.value), ...storedValue(k), ...(k.mute ? { mute: true } : {}) },
          ),
          detailed ? OBJECT_LIST : SCENE_LIST,
        ),
      );
    const groups = scene.getVertexGroups(o.data);
    if (groups.length)
      Object.assign(
        out,
        listField(
          'vertex_groups',
          groups.map((g) => {
            if (!detailed) return g.name;
            const w = decodeFloat32(g.weights);
            let assigned = 0;
            for (const x of w) if (x > 0) assigned++;
            return { name: g.name, assigned_vertices: assigned };
          }),
          detailed ? OBJECT_LIST : 24,
        ),
      );
    return out;
  }
  if ((o.type === 'CURVE' || o.type === 'FONT') && o.data) {
    const stored = scene.getCurve(o.data);
    const c = ev?.curve ?? stored;
    if (!c) return null;
    const out = curveSummary(c, o.type, detailed);
    if (typeof out.bevel_object === 'string') out.bevel_object = nameOf(scene, out.bevel_object);
    out.users = scene.dataUsers(o.data);
    if (ev?.mesh) out.evaluated = meshStats(ev.mesh);
    else {
      out.evaluated = 'wire (no surface: add bevel_depth, extrude or a 2D fill)';
      if (ev?.lines?.length) out.wire_edges = ev.lines.length / 6;
    }
    Object.assign(out, viewportStats(ev?.mesh, ctx?.viewportOf(o.id)));
    Object.assign(out, storedField(storedDiff(c, stored, Object.keys(ANIMATABLE.curve))));
    return out;
  }
  if (o.type === 'ARMATURE') return armatureSummary(scene, ev?.data ?? o, ev, detailed);
  if (o.type === 'LIGHT' && o.data) {
    // the light datablock at the frame (animated energy, colour, size …); edit it with
    // light.properties_set (or data.set_property kind 'lights'), key it with data.<field>
    const stored = scene.getLight(o.data);
    const l = ev?.light ?? stored;
    if (!l) return null;
    const out: Record<string, unknown> = {
      kind: 'light',
      light: l.name,
      ...(detailed ? { id: o.data } : {}),
      type: l.type,
      energy: round(l.energy),
      color: roundVec([...l.color]),
      use_shadow: l.use_shadow,
      shadow_soft_size: round(l.shadow_soft_size),
    };
    if (l.type === 'SPOT')
      Object.assign(out, { spot_size: round(l.spot_size), spot_blend: round(l.spot_blend) });
    if (l.type === 'AREA')
      Object.assign(out, { shape: l.shape, size: round(l.size), size_y: round(l.size_y) });
    if (l.type === 'SUN') {
      delete out.shadow_soft_size;
      if (typeof l.angle === 'number') out.angle = round(l.angle);
    }
    Object.assign(out, storedField(storedDiff(l, stored, Object.keys(ANIMATABLE.light))));
    return out;
  }
  if (o.type === 'CAMERA' && o.data) {
    const stored = scene.getCamera(o.data);
    const c = ev?.camera ?? stored;
    if (!c) return null;
    return {
      kind: 'camera',
      camera: c.name,
      ...(detailed ? { id: o.data } : {}),
      type: c.type,
      lens: round(c.lens),
      sensor_width: c.sensor_width,
      ...(detailed || c.sensor_fit !== 'AUTO' ? { sensor_fit: c.sensor_fit } : {}),
      ...(c.type === 'ORTHO' || detailed ? { ortho_scale: round(c.ortho_scale) } : {}),
      clip_start: c.clip_start,
      clip_end: c.clip_end,
      ...(c.shift_x || c.shift_y || detailed ? { shift_x: round(c.shift_x), shift_y: round(c.shift_y) } : {}),
      // depth of field (path tracer): off unless dof_use is true (camera.properties_set)
      dof_use: c.dof_use,
      ...(c.dof_use || detailed
        ? {
            dof_focus_distance: round(c.dof_focus_distance),
            dof_aperture_fstop: c.dof_aperture_fstop,
            ...(c.dof_focus_object ? { dof_focus_object: nameOf(scene, c.dof_focus_object) } : {}),
          }
        : {}),
      ...storedField(storedDiff(c, stored, Object.keys(ANIMATABLE.camera))),
    };
  }
  if (o.type === 'EMPTY')
    return {
      kind: 'empty',
      display_type: o.empty_display_type,
      display_size: round(o.empty_display_size),
      ...(o.instance_type === 'COLLECTION'
        ? {
            instance_collection: o.instance_collection ? collectionName(scene, o.instance_collection) : null,
          }
        : {}),
    };
  return null;
}

/** Context shared by the object summaries of one evaluation. */
interface SummaryContext {
  /** The scene evaluated for rendering (what the summaries describe). */
  ev: EvaluatedScene;
  problems: Map<string, EvalError[]>;
  /** Problems of the VIEWPORT evaluation by object (empty when the viewport cannot differ). */
  viewportProblems: Map<string, EvalError[]>;
  /** Instances in renders (every particle of the systems shown in renders). */
  instances: InstanceCounts;
  /** Instances in the viewport, when they differ from the render counts. */
  viewport: InstanceCounts | null;
  /** The object evaluated with the viewport settings (only when the viewport may differ). */
  viewportOf(id: string): EvaluatedObject | undefined;
  /** Shape keys of a mesh with their values at the frame. */
  shapeKeys(meshId: string): ShapeKeyData[];
}

/**
 * Whether the viewport can show other geometry or instances than renders: modifiers (render_levels,
 * render_steps, show_viewport vs show_render …), particle systems (display_percentage, visibility)
 * or curves with their own render resolution. Without any, one evaluation describes both.
 */
function viewportMayDiffer(scene: SceneDoc): boolean {
  for (const o of scene.listObjects()) {
    if (o.modifiers.length || o.particle_systems?.length) return true;
    if ((o.type === 'CURVE' || o.type === 'FONT') && o.data) {
      const c = scene.getCurve(o.data);
      if (c && c.render_resolution_u > 0 && c.render_resolution_u !== c.resolution_u) return true;
    }
  }
  return false;
}

/**
 * Context of the summaries of `ev` (a RENDER evaluation); `viewport` is the VIEWPORT evaluation of
 * the same frame, for the counts that differ in the viewport (null: they cannot differ).
 */
function summaryContext(
  scene: SceneDoc,
  ev: EvaluatedScene,
  viewportEv: EvaluatedScene | null,
): SummaryContext {
  const instances = instanceCounts(ev, 'RENDER');
  // the viewport's instances (display_percentage, show_viewport, owners hidden in only one of the
  // two); without a VIEWPORT evaluation the instances are the same, shown as their owners are
  const shown = instanceCounts(viewportEv ?? ev, 'VIEWPORT');
  const differs = (a: Map<string, number>, b: Map<string, number>) =>
    a.size !== b.size || [...a].some(([k, n]) => b.get(k) !== n);
  const viewport =
    instances.total !== shown.total ||
    differs(instances.bySystem, shown.bySystem) ||
    differs(instances.byOwner, shown.byOwner)
      ? shown
      : null;
  let fs: FrameState | null = null;
  return {
    ev,
    problems: problemsByObject(scene, ev),
    viewportProblems: viewportEv && viewportEv !== ev ? problemsByObject(scene, viewportEv) : new Map(),
    instances,
    viewport,
    viewportOf: (id) => (viewportEv && viewportEv !== ev ? viewportEv.byId.get(id) : undefined),
    shapeKeys: (meshId) => {
      fs ??= new FrameState(scene, ev.frame);
      return fs.get<{ shape_keys: ShapeKeyData[] }>('mesh', meshId)?.shape_keys ?? scene.getShapeKeys(meshId);
    },
  };
}

/** Summary of one object (used in scene listings; `detailed` for get_object). */
export function summarizeObject(
  scene: SceneDoc,
  o: ObjectData,
  ev: EvaluatedObject | undefined,
  ctx?: SummaryContext,
  detailed = false,
) {
  const max = detailed ? OBJECT_LIST : SCENE_LIST;
  const fcurves = scene.listFCurves(o.id);
  if (o.data) fcurves.push(...scene.listFCurves(o.data));
  const animated = fcurves.map((f) => fcurveLabel(f, o.id));
  const drivers = scene.listDrivers(o.id);
  if (o.data) drivers.push(...scene.listDrivers(o.data));
  const constraintErrors = ev?.constraintErrors ?? [];
  const problems = (ctx?.problems.get(o.id) ?? []).map((e) => `${e.source.split(':')[0]}: ${e.message}`);
  const instances = ctx?.instances.byOwner.get(o.id) ?? 0;
  const viewportInstances = ctx?.viewport ? (ctx.viewport.byOwner.get(o.id) ?? 0) : instances;
  // the object at the frame: animated / driven transforms, constraints, modifiers, particle settings
  const a = ev?.data ?? o;
  const rb = a.rigid_body;
  const modErrors: { modifier: string; message: string; viewport?: true }[] = ev
    ? modifierErrors(scene, ev)
    : [];
  // what only the viewport's evaluation has (its own modifier settings), marked as such
  const viewportEv = ctx?.viewportOf(o.id);
  if (viewportEv) {
    const index = new Map(modErrors.map((e, i) => [sameProblem(e), i]));
    for (const e of modifierErrors(scene, viewportEv)) {
      const i = index.get(sameProblem(e));
      if (i === undefined) modErrors.push({ ...e, viewport: true });
      else modErrors[i] = { ...modErrors[i], message: e.message };
    }
    const own = new Set(problems.map(sameProblem));
    for (const e of ctx?.viewportProblems.get(o.id) ?? []) {
      const text = `${e.source.split(':')[0]} (viewport): ${e.message}`;
      if (!own.has(sameProblem(`${e.source.split(':')[0]}: ${e.message}`))) problems.push(text);
    }
  }
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    parent: nameOf(scene, o.parent),
    ...(o.parent && o.parent_type === 'BONE' ? { parent_bone: o.parent_bone } : {}),
    collection: collectionName(scene, o.collection),
    // local transform at the frame (keyframes, drivers, F-curve modifiers); `stored` = the
    // document values where those override them (what transform_object sets)
    location: roundVec([...a.location]),
    rotation_euler: roundVec([...a.rotation_euler]),
    rotation_degrees: roundVec(a.rotation_euler.map((r) => r * RAD2DEG) as Vec3, degreeDecimals()),
    scale: roundVec([...a.scale]),
    ...storedField(storedDiff(a, o, TRANSFORM_KEYS)),
    world_bounds: ev ? worldBounds(ev) : null,
    data: dataSummary(scene, o, ev, detailed, ctx),
    materials: o.material_slots.map((id) => (id ? (scene.getMaterial(id)?.name ?? id) : null)),
    modifiers: a.modifiers.map((m) => {
      const refs: Record<string, unknown> = {};
      for (const k of modifierObjectParams(m.type)) {
        const v = m.params[k];
        if (typeof v === 'string' && v) refs[k] = nameOf(scene, v);
      }
      return {
        name: m.name,
        type: m.type,
        show_viewport: m.show_viewport,
        show_render: m.show_render,
        ...refs,
      };
    }),
    ...(a.constraints?.length
      ? listField(
          'constraints',
          a.constraints.map((c) =>
            constraintSummary(
              scene,
              c,
              constraintErrors,
              detailed,
              o.constraints?.find((x) => x.id === c.id),
            ),
          ),
          max,
        )
      : {}),
    ...(a.particle_systems?.length
      ? {
          particle_systems: particleSummary(
            scene,
            a,
            ctx?.instances.bySystem ?? new Map(),
            ctx?.viewport?.bySystem ?? null,
            detailed,
          ),
        }
      : {}),
    ...(instances ? { instances } : {}),
    ...(viewportInstances !== instances ? { viewport_instances: viewportInstances } : {}),
    ...(rb
      ? {
          rigid_body: detailed
            ? { ...rb, mass: round(rb.mass) }
            : {
                type: rb.type,
                shape: rb.collision_shape,
                mass: round(rb.mass),
                ...(rb.enabled ? {} : { enabled: false }),
                ...(rb.kinematic ? { kinematic: true } : {}),
              },
        }
      : {}),
    ...(ev?.simulated ? { simulated: true } : {}),
    ...(a.hide_viewport ? { hide_viewport: true } : {}),
    ...(a.hide_render ? { hide_render: true } : {}),
    ...(animated.length ? listField('animated', animated, detailed ? OBJECT_LIST : 24) : {}),
    ...(drivers.length
      ? listField(
          'drivers',
          drivers.map((d) => driverSummary(scene, d, detailed)),
          max,
        )
      : {}),
    ...(modErrors.length ? listField('modifier_errors', modErrors, max) : {}),
    ...(problems.length ? listField('problems', problems, max) : {}),
  };
}

function materialSummary(scene: SceneDoc, users: Map<string, Set<string>>) {
  return scene.listMaterials().map((m) => {
    const procedural = Object.entries(m.textures ?? {})
      .filter(([, slot]) => slot?.procedural)
      .map(([channel, slot]) => `${channel}: ${slot!.procedural!.type}`);
    return {
      id: m.id,
      name: m.name,
      base_color: roundVec([...m.base_color]),
      metallic: round(m.metallic),
      roughness: round(m.roughness),
      ...(m.emission_strength > 0
        ? { emission_color: roundVec([...m.emission_color]), emission_strength: round(m.emission_strength) }
        : {}),
      ...(m.alpha < 1 ? { alpha: round(m.alpha), blend_method: m.blend_method } : {}),
      ...(m.transmission > 0 ? { transmission: round(m.transmission), ior: round(m.ior) } : {}),
      ...(procedural.length ? { procedural } : {}),
      ...boundedUsers([...(users.get(m.id) ?? [])]),
    };
  });
}

/** `users` (object names, at most MATERIAL_USERS) and `users_total` when there are more. */
function boundedUsers(names: string[]): { users: string[]; users_total?: number } {
  return names.length > MATERIAL_USERS
    ? { users: names.slice(0, MATERIAL_USERS), users_total: names.length }
    : { users: names };
}

/**
 * World settings that keyframes or drivers change at the frame: their values at the frame and,
 * in `stored`, the document values (what set_scene_settings / world.sky_set change).
 */
function animatedWorld(world: WorldSettings, stored: WorldSettings): Record<string, unknown> {
  const diff = storedDiff(world, stored, Object.keys(ANIMATABLE.world));
  if (!diff) return {};
  const now = Object.fromEntries(
    Object.keys(diff).map((k) => [k, rounded((world as unknown as Record<string, unknown>)[k])]),
  );
  return { animated: now, stored: diff };
}

interface GeometryCounts {
  vertices: number;
  faces: number;
  triangles: number;
}

/**
 * Evaluated geometry of the scene as renders (`shown` RENDER) or the viewport (VIEWPORT) show it:
 * the meshes after shape keys and modifiers, including the surfaces of curves and text, of the
 * objects shown there (instances counted separately), and the triangles of the instances whose
 * owner is shown (like the renderers, the exporters and the editor's statistics). The geometry of
 * the objects that are not shown is counted apart (`hidden`, with their names).
 */
function evaluatedGeometry(
  ev: EvaluatedScene,
  shown: Shown,
  /** Statistics of meshes counted before (shared by the render and viewport counts). */
  stats = new Map<MeshData, ReturnType<typeof meshStats>>(),
): {
  geometry: GeometryCounts;
  instanceTriangles: number;
  hidden: GeometryCounts & { objects: string[]; instances: number; instanceTriangles: number };
} {
  const geometry = { vertices: 0, faces: 0, triangles: 0 };
  const hidden = {
    objects: [] as string[],
    vertices: 0,
    faces: 0,
    triangles: 0,
    instances: 0,
    instanceTriangles: 0,
  };
  const hiddenNames = new Set<string>();
  const statsOf = (m: MeshData) => {
    let s = stats.get(m);
    if (!s) stats.set(m, (s = meshStats(m)));
    return s;
  };
  for (const o of ev.objects) {
    if (!o.mesh) continue;
    const s = statsOf(o.mesh);
    const into = isShown(o, shown) ? geometry : hidden;
    into.vertices += s.vertices;
    into.faces += s.faces;
    into.triangles += s.triangles;
    if (into === hidden) hiddenNames.add(o.name);
  }
  let instanceTriangles = 0;
  for (const inst of ev.instances) {
    const owner = ev.byId.get(inst.ownerId);
    const src = ev.byId.get(inst.sourceId)?.mesh;
    const triangles = src ? statsOf(src).triangles : 0;
    if (owner && isShown(owner, shown)) instanceTriangles += triangles;
    else {
      hidden.instances++;
      hidden.instanceTriangles += triangles;
      if (owner) hiddenNames.add(owner.name);
    }
  }
  hidden.objects = [...hiddenNames];
  return { geometry, instanceTriangles, hidden };
}

/**
 * The scene evaluated at `frame` (default: the scene's frame_start), cached per document state:
 * RENDER (default) with the render settings of modifiers, curves and particles, VIEWPORT with the
 * viewport's.
 */
export function evaluate(scene: SceneDoc, frame?: number, mode: EvalMode = 'RENDER'): EvaluatedScene {
  return evaluateCached(scene, frame ?? scene.getScene().frame_start, mode);
}

/** The RENDER evaluation and, when the viewport may show other geometry, the VIEWPORT one. */
function evaluateBoth(
  scene: SceneDoc,
  frame?: number,
): { ev: EvaluatedScene; viewport: EvaluatedScene | null } {
  const ev = evaluate(scene, frame, 'RENDER');
  return { ev, viewport: viewportMayDiffer(scene) ? evaluate(scene, ev.frame, 'VIEWPORT') : null };
}

/**
 * Scene, render and world settings (`world`: the world at the frame, with the stored values where
 * keyframes or drivers change them).
 */
function settingsSummary(scene: SceneDoc, world: WorldSettings, rigidBodies: number) {
  const settings = scene.getScene();
  const render = scene.getRender();
  const storedWorld = scene.getWorld();
  const rbw = settings.rigidbody_world;
  return {
    scene: {
      frame_start: settings.frame_start,
      frame_end: settings.frame_end,
      fps: settings.fps,
      unit_system: settings.unit_system,
      unit_scale_length: settings.unit_scale_length,
      ...(rigidBodies || rbw?.enabled === false
        ? {
            use_gravity: settings.use_gravity,
            gravity: roundVec([...(settings.gravity ?? [0, 0, -9.81])]),
            rigidbody_world: rbw
              ? {
                  enabled: rbw.enabled,
                  frame_start: rbw.frame_start,
                  frame_end: rbw.frame_end,
                  substeps_per_frame: rbw.substeps_per_frame,
                  solver_iterations: rbw.solver_iterations,
                  time_scale: rbw.time_scale,
                }
              : null,
          }
        : {}),
    },
    render: {
      engine: render.engine,
      resolution_x: render.resolution_x,
      resolution_y: render.resolution_y,
      resolution_percentage: render.resolution_percentage,
      samples: render.samples,
      max_bounces: render.max_bounces,
      use_denoising: render.use_denoising,
      film_transparent: render.film_transparent,
      view_transform: render.view_transform,
      exposure: render.exposure,
    },
    world: {
      color: roundVec([...world.color]),
      strength: round(world.strength),
      environment: world.environment,
      environment_strength: round(world.environment_strength),
      ...(world.environment === 'SKY'
        ? {
            sky: {
              sun_elevation: round(world.sun_elevation),
              sun_rotation: round(world.sun_rotation),
              sun_intensity: round(world.sun_intensity),
              show_background: world.show_environment_background,
            },
          }
        : {}),
      ...(world.mist_density > 0
        ? {
            mist_density: round(world.mist_density, Math.max(5, decimalsNow)),
            mist_color: roundVec([...world.mist_color]),
          }
        : {}),
      ...animatedWorld(world, storedWorld),
    },
  };
}

/**
 * The scene, render and world settings at `frame` without evaluating the geometry (what
 * set_scene_settings returns).
 */
export function sceneSettingsAt(scene: SceneDoc, frame: number) {
  const world = new FrameState(scene, frame).get<WorldSettings>('world', 'world') ?? scene.getWorld();
  const rigidBodies = scene.listObjects().filter((o) => o.rigid_body).length;
  return settingsSummary(scene, world, rigidBodies);
}

export interface SceneSummaryOptions {
  frame?: number;
  projectId?: string;
  /** Objects listed at most (default DEFAULT_MAX_OBJECTS); the counts cover every object. */
  maxObjects?: number;
  /** Decimals of the numbers (0–6, default SCENE_DECIMALS = 0.1 mm). */
  decimals?: number;
}

/** Full scene description returned by `get_scene` and the `project://{id}/scene` resource. */
export function summarizeScene(scene: SceneDoc, opts: SceneSummaryOptions = {}) {
  return withDecimals(opts.decimals ?? SCENE_DECIMALS, () => sceneSummary(scene, opts));
}

function sceneSummary(scene: SceneDoc, opts: SceneSummaryOptions) {
  const both = evaluateBoth(scene, opts.frame);
  const ev = both.ev;
  const ctx = summaryContext(scene, ev, both.viewport);
  const objects = scene.listObjects();
  const materialUsers = new Map<string, Set<string>>();
  for (const o of objects)
    for (const s of o.material_slots) {
      if (!s) continue;
      let set = materialUsers.get(s);
      if (!set) materialUsers.set(s, (set = new Set()));
      set.add(o.name);
    }
  const settings = scene.getScene();
  // world settings at the frame (animated sun, mist …)
  const world = ev.world ?? scene.getWorld();
  // base geometry: the stored mesh data of mesh objects (before shape keys and modifiers)
  let vertices = 0;
  let faces = 0;
  const byType: Record<string, number> = {};
  for (const o of objects) {
    byType[o.type] = (byType[o.type] ?? 0) + 1;
    if (o.type !== 'MESH' || !o.data) continue;
    const c = scene.meshCounts(o.data);
    if (c) {
      vertices += c.vertices;
      faces += c.faces;
    }
  }
  // what renders show (objects shown in renders), and what the viewport shows: with its modifier /
  // curve settings, or (when those cannot differ) the same geometry with the viewport visibility
  const meshStatsCache = new Map<MeshData, ReturnType<typeof meshStats>>();
  const evaluated = evaluatedGeometry(ev, 'RENDER', meshStatsCache);
  const viewportGeometry = evaluatedGeometry(both.viewport ?? ev, 'VIEWPORT', meshStatsCache).geometry;
  const viewportDiffers =
    viewportGeometry.vertices !== evaluated.geometry.vertices ||
    viewportGeometry.faces !== evaluated.geometry.faces ||
    viewportGeometry.triangles !== evaluated.geometry.triangles;
  const hidden = evaluated.hidden;
  const notRendered =
    hidden.objects.length > 0
      ? {
          not_rendered: {
            ...listField('objects', hidden.objects, MATERIAL_USERS),
            vertices: hidden.vertices,
            faces: hidden.faces,
            triangles: hidden.triangles,
            ...(hidden.instances
              ? { instances: hidden.instances, instance_triangles: hidden.instanceTriangles }
              : {}),
          },
        }
      : {};
  const maxObjects = Math.max(1, opts.maxObjects ?? DEFAULT_MAX_OBJECTS);
  const listed = objects.slice(0, maxObjects);
  const rigidBodies = objects.filter((o) => o.rigid_body).length;
  const drivers = scene.listDrivers().length;
  return {
    project: { id: opts.projectId, name: scene.name },
    units: { up_axis: 'Z', length: 'meters', angles: 'radians' },
    frame: ev.frame,
    counts: {
      objects: objects.length,
      by_type: byType,
      // base meshes (as stored, before modifiers; curves and text not included)
      vertices,
      faces,
      // what is rendered: the objects shown in renders, after shape keys, modifiers (render
      // settings), curve bevels/extrusions and text; the geometry of objects hidden from renders
      // (hide_render: Boolean cutters, helpers) apart; the viewport's counts (objects shown in the
      // viewport, its modifier/curve settings) when they differ
      evaluated: evaluated.geometry,
      ...notRendered,
      ...(viewportDiffers ? { evaluated_viewport: viewportGeometry } : {}),
      materials: scene.listMaterials().length,
      instances: ctx.instances.total,
      ...(evaluated.instanceTriangles ? { instance_triangles: evaluated.instanceTriangles } : {}),
      ...(ctx.viewport ? { viewport_instances: ctx.viewport.total } : {}),
      ...(drivers ? { drivers } : {}),
      ...(rigidBodies ? { rigid_bodies: rigidBodies } : {}),
    },
    active_camera: settings.camera ? { id: settings.camera, name: nameOf(scene, settings.camera) } : null,
    ...settingsSummary(scene, world, rigidBodies),
    objects: listed.map((o) => summarizeObject(scene, o, ev.byId.get(o.id), ctx)),
    ...(listed.length < objects.length
      ? {
          objects_truncated: {
            shown: listed.length,
            total: objects.length,
            hint: 'Pass max_objects to list more, or use get_object for single objects.',
          },
        }
      : {}),
    materials: materialSummary(scene, materialUsers),
    collections: scene.listCollections().map((c) => {
      const members = objects.filter((o) => o.collection === c.id).map((o) => o.name);
      return {
        id: c.id,
        name: c.name,
        parent: c.parent ? collectionName(scene, c.parent) : null,
        ...(c.hide_viewport ? { hide_viewport: true } : {}),
        ...(c.hide_render ? { hide_render: true } : {}),
        ...listField('objects', members, 50),
      };
    }),
    ...listField('problems', allProblems(scene, ev, both.viewport), MAX_PROBLEMS),
  };
}

/**
 * Detailed description of one object (`get_object`), its numbers rounded to `decimals` (0–6,
 * default OBJECT_DECIMALS = 1 µm, so sub-millimetre parts read back as they were made).
 */
export function describeObject(scene: SceneDoc, o: ObjectData, frame?: number, decimals = OBJECT_DECIMALS) {
  return withDecimals(decimals, () => objectDescription(scene, o, frame));
}

function objectDescription(scene: SceneDoc, o: ObjectData, frame?: number) {
  const both = evaluateBoth(scene, frame);
  const ev = both.ev;
  const e = ev.byId.get(o.id);
  const world = e?.worldMatrix ?? scene.worldMatrix(o.id);
  // materials at the frame (animated / driven), like the rest of the description
  const materials = o.material_slots.map((id, slot) => {
    if (!id) return { slot, material: null };
    const stored = scene.getMaterial(id);
    const m = e?.materials[slot]?.id === id ? e.materials[slot] : stored;
    return {
      slot,
      material: m
        ? {
            ...m,
            base_color: roundVec([...m.base_color]),
            ...storedField(storedDiff(m, stored, Object.keys(ANIMATABLE.material))),
          }
        : { id, missing: true },
    };
  });
  const fcurves = scene.listFCurves(o.id);
  if (o.data) fcurves.push(...scene.listFCurves(o.data));
  // the final world transform (parents, constraints, rigid body simulation), decomposed
  const wt = decompose4(world);
  return {
    ...summarizeObject(scene, o, e, summaryContext(scene, ev, both.viewport), true),
    frame: ev.frame,
    world_location: roundVec([world[12], world[13], world[14]]),
    world_transform: {
      location: roundVec([...wt.location]),
      rotation_euler: roundVec([...wt.rotation]),
      rotation_degrees: roundVec(wt.rotation.map((r) => r * RAD2DEG) as Vec3, degreeDecimals()),
      scale: roundVec([...wt.scale]),
    },
    children: scene.childrenOf(o.id).map((c) => c.name),
    materials,
    // modifiers at the frame (animated parameters), stored parameters where they differ
    modifiers: (e?.data ?? o).modifiers.map((m) => {
      const stored = o.modifiers.find((x) => x.id === m.id);
      return {
        ...m,
        ...storedField(
          stored ? storedDiff(m.params, stored.params, Object.keys(m.params)) : null,
          'stored_params',
        ),
      };
    }),
    custom_props: o.custom_props,
    display: {
      display_type: o.display_type,
      show_wire: o.show_wire,
      show_in_front: o.show_in_front,
      color: o.color,
    },
    visibility: { hide_viewport: o.hide_viewport, hide_render: o.hide_render, hide_select: o.hide_select },
    animation: fcurves.slice(0, OBJECT_LIST).map((f) => ({
      ...(f.target_id === o.id ? {} : { target_type: f.target_type }),
      path: f.path,
      index: f.index,
      ...(f.extrapolation !== 'CONSTANT' ? { extrapolation: f.extrapolation } : {}),
      ...(f.mute ? { mute: true } : {}),
      ...(f.modifiers?.length ? { modifiers: f.modifiers.map((m) => ({ type: m.type, ...m.params })) } : {}),
      keyframe_count: f.keyframes.length,
      keyframes: f.keyframes.slice(0, 100).map((k) => ({
        frame: k.frame,
        value: round(k.value),
        interpolation: k.interpolation,
      })),
    })),
    ...(fcurves.length > OBJECT_LIST ? { animation_total: fcurves.length } : {}),
  };
}
