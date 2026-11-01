import {
  ROOT_COLLECTION_ID,
  SceneEvaluator,
  constraintTargets,
  decodeFloat32,
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
  type Vec3,
} from '@3d-editor/core';

/*
 * Compact JSON descriptions of a scene for MCP agents. Numbers are rounded, references are
 * given by name (names are unique per datablock kind) and ids are included where useful. Lists
 * that can grow without bound (bones, spline points, shape keys, constraints, drivers, problems…)
 * are truncated, with the full count next to them, so a summary stays small enough to read.
 */

const RAD2DEG = 180 / Math.PI;

/** Longest lists in `get_scene` (per object) and `get_object`. */
const SCENE_LIST = 12;
const OBJECT_LIST = 64;
/** Most evaluation problems listed. */
const MAX_PROBLEMS = 40;
/** Most characters of a text object's body in `get_scene`. */
const TEXT_PREVIEW = 120;
/** Objects listed by `get_scene` unless asked for more. */
export const DEFAULT_MAX_OBJECTS = 300;

export function round(v: number, decimals = 4): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

export function roundVec<T extends number[]>(v: T, decimals = 4): T {
  return v.map((x) => round(x, decimals)) as T;
}

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

function* worldVertices(mesh: MeshData, m: Mat4): Generator<Vec3> {
  const p = mesh.positions;
  for (let i = 0; i + 2 < p.length; i += 3) yield transformPoint3(m, [p[i], p[i + 1], p[i + 2]]);
}

function* posedBonePoints(ev: EvaluatedObject): Generator<Vec3> {
  for (const b of ev.pose?.bones.values() ?? []) {
    yield transformPoint3(ev.worldMatrix, b.head);
    yield transformPoint3(ev.worldMatrix, b.tail);
  }
}

/**
 * World-space axis aligned bounds of an evaluated object: its geometry after modifiers (meshes,
 * curves and text with a surface), its posed bones (armatures), otherwise its origin.
 */
export function worldBounds(ev: EvaluatedObject): Bounds | null {
  if (ev.mesh && ev.mesh.positions.length >= 3) return boundsOf(worldVertices(ev.mesh, ev.worldMatrix));
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

/** A problem with its source made readable (object names instead of ids). */
function describeProblem(
  scene: SceneDoc,
  e: EvalError,
): { source: string; object?: string; message: string } {
  const t = problemTarget(e.source);
  const object = t ? scene.getObject(t)?.name : undefined;
  return { source: e.source.split(':')[0], ...(object ? { object } : {}), message: e.message };
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
  if (c.dimensions === '2D' || type === 'FONT') out.fill_mode = c.fill_mode;
  if (c.use_path && type === 'CURVE')
    Object.assign(out, { path_duration: c.path_duration, eval_time: round(c.eval_time) });
  if (detailed) {
    Object.assign(out, {
      resolution_u: c.resolution_u,
      render_resolution_u: c.render_resolution_u,
      twist_mode: c.twist_mode,
      use_fill_caps: c.use_fill_caps,
    });
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
  out.pose = Object.fromEntries(
    posed.slice(0, OBJECT_LIST).map(([name, pb]) => [
      name,
      {
        location: roundVec([...pb.location]),
        rotation_euler: roundVec([...pb.rotation_euler]),
        scale: roundVec([...pb.scale]),
        ...(pb.constraints?.length
          ? { constraints: pb.constraints.map((c) => constraintSummary(scene, c, [], true)) }
          : {}),
      },
    ]),
  );
  return out;
}

function constraintSummary(
  scene: SceneDoc,
  c: ConstraintData,
  errors: { constraintId: string; message: string }[],
  detailed: boolean,
): Record<string, unknown> {
  const targets = constraintTargets(c).map((id) => nameOf(scene, id));
  const errs = errors.filter((e) => e.constraintId === c.id).map((e) => e.message);
  return {
    name: c.name,
    type: c.type,
    ...(targets.length ? { targets } : {}),
    ...(c.subtarget ? { subtarget: c.subtarget } : {}),
    influence: round(c.influence),
    ...(c.mute ? { mute: true } : {}),
    ...(detailed ? { id: c.id, params: c.params } : {}),
    ...(errs.length ? { errors: errs } : {}),
  };
}

function particleSummary(
  scene: SceneDoc,
  o: ObjectData,
  instancesBySystem: Map<string, number>,
  detailed: boolean,
) {
  return o.particle_systems.map((ps) => {
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
      instances: instancesBySystem.get(ps.id) ?? 0,
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

/** Instance counts of an evaluated scene: per owner object and per particle system id. */
function instanceCounts(ev: EvaluatedScene): { byOwner: Map<string, number>; bySystem: Map<string, number> } {
  const byOwner = new Map<string, number>();
  const bySystem = new Map<string, number>();
  for (const inst of ev.instances) {
    byOwner.set(inst.ownerId, (byOwner.get(inst.ownerId) ?? 0) + 1);
    // ids: `${owner}:${system}:${particle}…` for particles, `${owner}:${source}` for collections
    const parts = inst.id.split(':');
    if (parts.length >= 3) bySystem.set(parts[1], (bySystem.get(parts[1]) ?? 0) + 1);
  }
  return { byOwner, bySystem };
}

function dataSummary(
  scene: SceneDoc,
  o: ObjectData,
  ev: EvaluatedObject | undefined,
  detailed = false,
): Record<string, unknown> | null {
  if (o.type === 'MESH' && o.data) {
    const base = scene.getMesh(o.data);
    const block = scene.getMeshBlock(o.data);
    const out: Record<string, unknown> = {
      kind: 'mesh',
      mesh: block?.name ?? o.data,
      users: scene.dataUsers(o.data),
    };
    if (base) Object.assign(out, meshStats(base));
    if (ev?.mesh && base && ev.mesh !== base) out.evaluated = meshStats(ev.mesh);
    const keys = scene.getShapeKeys(o.data);
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
                  slider_min: k.slider_min,
                  slider_max: k.slider_max,
                  ...(k.mute ? { mute: true } : {}),
                  ...(k.relative_key ? { relative_key: k.relative_key } : {}),
                }
              : { name: k.name, value: round(k.value), ...(k.mute ? { mute: true } : {}) },
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
    const c = ev?.curve ?? scene.getCurve(o.data);
    if (!c) return null;
    const out = curveSummary(c, o.type, detailed);
    if (typeof out.bevel_object === 'string') out.bevel_object = nameOf(scene, out.bevel_object);
    out.users = scene.dataUsers(o.data);
    if (ev?.mesh) out.evaluated = meshStats(ev.mesh);
    else out.evaluated = 'wire (no surface: add bevel_depth, extrude or a 2D fill)';
    return out;
  }
  if (o.type === 'ARMATURE') return armatureSummary(scene, o, ev, detailed);
  if (o.type === 'LIGHT' && o.data) {
    const l = ev?.light ?? scene.getLight(o.data);
    if (!l) return null;
    const out: Record<string, unknown> = {
      kind: 'light',
      type: l.type,
      energy: round(l.energy),
      color: roundVec([...l.color]),
    };
    if (l.type === 'SPOT')
      Object.assign(out, { spot_size: round(l.spot_size), spot_blend: round(l.spot_blend) });
    if (l.type === 'AREA')
      Object.assign(out, { shape: l.shape, size: round(l.size), size_y: round(l.size_y) });
    return out;
  }
  if (o.type === 'CAMERA' && o.data) {
    const c = ev?.camera ?? scene.getCamera(o.data);
    if (!c) return null;
    return {
      kind: 'camera',
      type: c.type,
      lens: round(c.lens),
      sensor_width: c.sensor_width,
      ortho_scale: round(c.ortho_scale),
      clip_start: c.clip_start,
      clip_end: c.clip_end,
      ...(c.dof_use
        ? { dof_focus_distance: round(c.dof_focus_distance), dof_aperture_fstop: c.dof_aperture_fstop }
        : {}),
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
  ev: EvaluatedScene;
  problems: Map<string, EvalError[]>;
  instances: ReturnType<typeof instanceCounts>;
}

function summaryContext(scene: SceneDoc, ev: EvaluatedScene): SummaryContext {
  return { ev, problems: problemsByObject(scene, ev), instances: instanceCounts(ev) };
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
  const problems = ctx?.problems.get(o.id) ?? [];
  const instances = ctx?.instances.byOwner.get(o.id) ?? 0;
  const rb = o.rigid_body;
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    parent: nameOf(scene, o.parent),
    ...(o.parent && o.parent_type === 'BONE' ? { parent_bone: o.parent_bone } : {}),
    collection: collectionName(scene, o.collection),
    location: roundVec([...o.location]),
    rotation_euler: roundVec([...o.rotation_euler]),
    rotation_degrees: roundVec(o.rotation_euler.map((r) => r * RAD2DEG) as Vec3, 2),
    scale: roundVec([...o.scale]),
    world_bounds: ev ? worldBounds(ev) : null,
    data: dataSummary(scene, o, ev, detailed),
    materials: o.material_slots.map((id) => (id ? (scene.getMaterial(id)?.name ?? id) : null)),
    modifiers: o.modifiers.map((m) => {
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
    ...(o.constraints?.length
      ? listField(
          'constraints',
          o.constraints.map((c) => constraintSummary(scene, c, constraintErrors, detailed)),
          max,
        )
      : {}),
    ...(o.particle_systems?.length
      ? { particle_systems: particleSummary(scene, o, ctx?.instances.bySystem ?? new Map(), detailed) }
      : {}),
    ...(instances ? { instances } : {}),
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
    ...(o.hide_viewport ? { hide_viewport: true } : {}),
    ...(o.hide_render ? { hide_render: true } : {}),
    ...(animated.length ? listField('animated', animated, detailed ? OBJECT_LIST : 24) : {}),
    ...(drivers.length
      ? listField(
          'drivers',
          drivers.map((d) => driverSummary(scene, d, detailed)),
          max,
        )
      : {}),
    ...(ev?.modifierErrors.length ? { modifier_errors: ev.modifierErrors } : {}),
    ...(problems.length
      ? listField(
          'problems',
          problems.map((e) => `${e.source.split(':')[0]}: ${e.message}`),
          max,
        )
      : {}),
  };
}

function materialSummary(scene: SceneDoc, users: Map<string, string[]>) {
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
      users: users.get(m.id) ?? [],
    };
  });
}

export function evaluate(scene: SceneDoc, frame?: number): EvaluatedScene {
  const f = frame ?? scene.getScene().frame_start;
  return new SceneEvaluator(scene).evaluate(f);
}

export interface SceneSummaryOptions {
  frame?: number;
  projectId?: string;
  /** Objects listed at most (default DEFAULT_MAX_OBJECTS); the counts cover every object. */
  maxObjects?: number;
}

/** Full scene description returned by `get_scene` and the `project://{id}/scene` resource. */
export function summarizeScene(scene: SceneDoc, opts: SceneSummaryOptions = {}) {
  const ev = evaluate(scene, opts.frame);
  const ctx = summaryContext(scene, ev);
  const objects = scene.listObjects();
  const materialUsers = new Map<string, string[]>();
  for (const o of objects)
    for (const s of o.material_slots) {
      if (!s) continue;
      const list = materialUsers.get(s) ?? [];
      if (!list.includes(o.name)) list.push(o.name);
      materialUsers.set(s, list);
    }
  const settings = scene.getScene();
  const render = scene.getRender();
  const world = scene.getWorld();
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
  const maxObjects = Math.max(1, opts.maxObjects ?? DEFAULT_MAX_OBJECTS);
  const listed = objects.slice(0, maxObjects);
  const rbw = settings.rigidbody_world;
  const rigidBodies = objects.filter((o) => o.rigid_body).length;
  const drivers = scene.listDrivers().length;
  return {
    project: { id: opts.projectId, name: scene.name },
    units: { up_axis: 'Z', length: 'meters', angles: 'radians' },
    frame: ev.frame,
    counts: {
      objects: objects.length,
      by_type: byType,
      vertices,
      faces,
      materials: scene.listMaterials().length,
      instances: ev.instances.length,
      ...(drivers ? { drivers } : {}),
      ...(rigidBodies ? { rigid_bodies: rigidBodies } : {}),
    },
    active_camera: settings.camera ? { id: settings.camera, name: nameOf(scene, settings.camera) } : null,
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
        ? { mist_density: round(world.mist_density, 5), mist_color: roundVec([...world.mist_color]) }
        : {}),
    },
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
    ...(ev.errors.length
      ? listField(
          'problems',
          ev.errors.map((e) => describeProblem(scene, e)),
          MAX_PROBLEMS,
        )
      : {}),
  };
}

/** Detailed description of one object (`get_object`). */
export function describeObject(scene: SceneDoc, o: ObjectData, frame?: number) {
  const ev = evaluate(scene, frame);
  const e = ev.byId.get(o.id);
  const world = e?.worldMatrix ?? scene.worldMatrix(o.id);
  const materials = o.material_slots.map((id, slot) => {
    if (!id) return { slot, material: null };
    const m = scene.getMaterial(id);
    return { slot, material: m ? { ...m, base_color: roundVec([...m.base_color]) } : { id, missing: true } };
  });
  const fcurves = scene.listFCurves(o.id);
  if (o.data) fcurves.push(...scene.listFCurves(o.data));
  return {
    ...summarizeObject(scene, o, e, summaryContext(scene, ev), true),
    frame: ev.frame,
    world_location: roundVec([world[12], world[13], world[14]]),
    children: scene.childrenOf(o.id).map((c) => c.name),
    materials,
    modifiers: o.modifiers.map((m) => ({ ...m })),
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
