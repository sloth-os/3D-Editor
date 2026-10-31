import {
  ROOT_COLLECTION_ID,
  SceneEvaluator,
  meshStats,
  transformPoint3,
  type EvaluatedObject,
  type EvaluatedScene,
  type Mat4,
  type MeshData,
  type ObjectData,
  type SceneDoc,
  type Vec3,
} from '@3d-editor/core';

/*
 * Compact JSON descriptions of a scene for MCP agents. Numbers are rounded, references are
 * given by name (names are unique per datablock kind) and ids are included where useful.
 */

const RAD2DEG = 180 / Math.PI;

export function round(v: number, decimals = 4): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

export function roundVec<T extends number[]>(v: T, decimals = 4): T {
  return v.map((x) => round(x, decimals)) as T;
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

/** World-space axis aligned bounds of an evaluated object (its origin for non-mesh objects). */
export function worldBounds(ev: EvaluatedObject): Bounds | null {
  if (ev.mesh && ev.mesh.positions.length >= 3) return boundsOf(worldVertices(ev.mesh, ev.worldMatrix));
  const m = ev.worldMatrix;
  return boundsOf([[m[12], m[13], m[14]]]);
}

function dataSummary(
  scene: SceneDoc,
  o: ObjectData,
  ev: EvaluatedObject | undefined,
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
    return out;
  }
  if (o.type === 'LIGHT' && o.data) {
    const l = scene.getLight(o.data);
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
    const c = scene.getCamera(o.data);
    if (!c) return null;
    return {
      kind: 'camera',
      type: c.type,
      lens: round(c.lens),
      sensor_width: c.sensor_width,
      ortho_scale: round(c.ortho_scale),
      clip_start: c.clip_start,
      clip_end: c.clip_end,
    };
  }
  if (o.type === 'EMPTY')
    return { kind: 'empty', display_type: o.empty_display_type, display_size: round(o.empty_display_size) };
  return null;
}

function nameOf(scene: SceneDoc, id: string | null): string | null {
  if (!id) return null;
  return scene.getObject(id)?.name ?? id;
}

function collectionName(scene: SceneDoc, id: string): string {
  return scene.getCollection(id)?.name ?? (id === ROOT_COLLECTION_ID ? 'Scene Collection' : id);
}

/** Summary of one object (used in scene listings). */
export function summarizeObject(scene: SceneDoc, o: ObjectData, ev: EvaluatedObject | undefined) {
  const animated = scene.listFCurves(o.id).map((f) => `${f.path}[${f.index}]`);
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    parent: nameOf(scene, o.parent),
    collection: collectionName(scene, o.collection),
    location: roundVec([...o.location]),
    rotation_euler: roundVec([...o.rotation_euler]),
    rotation_degrees: roundVec(o.rotation_euler.map((r) => r * RAD2DEG) as Vec3, 2),
    scale: roundVec([...o.scale]),
    world_bounds: ev ? worldBounds(ev) : null,
    data: dataSummary(scene, o, ev),
    materials: o.material_slots.map((id) => (id ? (scene.getMaterial(id)?.name ?? id) : null)),
    modifiers: o.modifiers.map((m) => ({
      name: m.name,
      type: m.type,
      show_viewport: m.show_viewport,
      show_render: m.show_render,
    })),
    ...(o.hide_viewport ? { hide_viewport: true } : {}),
    ...(o.hide_render ? { hide_render: true } : {}),
    ...(animated.length ? { animated } : {}),
    ...(ev?.modifierErrors.length ? { modifier_errors: ev.modifierErrors } : {}),
  };
}

function materialSummary(scene: SceneDoc, users: Map<string, string[]>) {
  return scene.listMaterials().map((m) => ({
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
    users: users.get(m.id) ?? [],
  }));
}

export function evaluate(scene: SceneDoc, frame?: number): EvaluatedScene {
  const f = frame ?? scene.getScene().frame_start;
  return new SceneEvaluator(scene).evaluate(f);
}

/** Full scene description returned by `get_scene` and the `project://{id}/scene` resource. */
export function summarizeScene(scene: SceneDoc, opts: { frame?: number; projectId?: string } = {}) {
  const ev = evaluate(scene, opts.frame);
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
  for (const o of objects) {
    if (o.type !== 'MESH' || !o.data) continue;
    const c = scene.meshCounts(o.data);
    if (c) {
      vertices += c.vertices;
      faces += c.faces;
    }
  }
  return {
    project: { id: opts.projectId, name: scene.name },
    units: { up_axis: 'Z', length: 'meters', angles: 'radians' },
    frame: ev.frame,
    counts: { objects: objects.length, vertices, faces, materials: scene.listMaterials().length },
    active_camera: settings.camera ? { id: settings.camera, name: nameOf(scene, settings.camera) } : null,
    scene: {
      frame_start: settings.frame_start,
      frame_end: settings.frame_end,
      fps: settings.fps,
      unit_system: settings.unit_system,
      unit_scale_length: settings.unit_scale_length,
    },
    render: {
      engine: render.engine,
      resolution_x: render.resolution_x,
      resolution_y: render.resolution_y,
      resolution_percentage: render.resolution_percentage,
      samples: render.samples,
      film_transparent: render.film_transparent,
      view_transform: render.view_transform,
      exposure: render.exposure,
    },
    world: {
      color: roundVec([...world.color]),
      strength: round(world.strength),
      environment: world.environment,
      environment_strength: round(world.environment_strength),
    },
    objects: objects.map((o) => summarizeObject(scene, o, ev.byId.get(o.id))),
    materials: materialSummary(scene, materialUsers),
    collections: scene.listCollections().map((c) => ({
      id: c.id,
      name: c.name,
      parent: c.parent ? collectionName(scene, c.parent) : null,
      ...(c.hide_viewport ? { hide_viewport: true } : {}),
      objects: objects.filter((o) => o.collection === c.id).map((o) => o.name),
    })),
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
  return {
    ...summarizeObject(scene, o, e),
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
    animation: scene.listFCurves(o.id).map((f) => ({
      path: f.path,
      index: f.index,
      keyframes: f.keyframes.map((k) => ({
        frame: k.frame,
        value: round(k.value),
        interpolation: k.interpolation,
      })),
    })),
  };
}
