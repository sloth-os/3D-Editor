import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { compose4, invert4, multiply4, translation4 } from '../math/mat4';
import { transformPoint3 } from '../math/vec3';
import { changedChannels, transformedChannels, transformTolerance } from '../doc/scene-doc';
import { FrameState } from '../eval/frame-state';
import type { EmptyDisplayType, LightData, LightType, ObjectData, ObjectType } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import { defaultCamera, defaultLight } from '../doc/defaults';
import { cameraFields, cameraPatch, LIGHT_TYPES, lightFields, lightPatch } from './light-camera';
import type { MeshData } from '../mesh/types';
import { appendMesh, cloneMesh, createMesh, edgeKey, meshBounds, vertexCount } from '../mesh/types';
import { createPrimitive, type PrimitiveType } from '../mesh/primitives';
import { buildTopology } from '../mesh/topology';
import { faceNormal } from '../mesh/normals';
import { selectAllElements, selectionFromVerts } from '../mesh/selection';
import { SceneEvaluator, type EvaluatedScene } from '../eval/evaluate';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { editModeMemoryRefusal } from './memory';
import { defineOperator, type OperatorRegistry } from './registry';
import {
  activeObject,
  commitEdit,
  editTarget,
  pollHasSelection,
  pollObjectMode,
  resolveObjectIds,
  selectedObjects,
  setSelection,
  vec3,
} from './helpers';
import {
  evaluatedWorld,
  keepChildrenWorld,
  keyChannelChanges,
  moveOrigin,
  transformRoots,
  transformStart,
  type ChannelChange,
} from './transform';
import { ARMATURE_PARENT_TYPES, armatureParentSet, remapDuplicatedReferences } from './armature';
import { copyAnimation } from './anim';
import {
  applyCurveTransform,
  checkCurveTransformApply,
  convertCurveObject,
  curveOriginSet,
  curveShadeSet,
} from './curve';

/**
 * Parents object `id` to the object `parent` (null clears the parent; an object parent, so a bone
 * parent's bone no longer applies), keeping its world matrix when `keep`, from where the scene
 * shows it and the new parent at the frame of `fs`: under a bone or an animated, posed or
 * constrained parent too (SceneDoc.setParent).
 */
function setParentAt(
  ctx: OperatorContext,
  fs: FrameState,
  id: string,
  parent: string | null,
  keep: boolean,
): void {
  const evaluated = keep
    ? { world: evaluatedWorld(fs, id), parentWorld: parent ? evaluatedWorld(fs, parent) : null }
    : undefined;
  ctx.doc.setParent(id, parent, keep, evaluated);
}

/**
 * Removes an object; its children get its parent (an object parent) and keep their world
 * matrices, from where the scene shows them at the frame of `fs`.
 */
function removeObjectAt(ctx: OperatorContext, fs: FrameState, id: string): void {
  const o = ctx.doc.getObject(id);
  if (!o) return;
  const parent = o.parent && o.parent !== id && ctx.doc.getObject(o.parent) ? o.parent : null;
  for (const child of ctx.doc.childrenOf(id)) setParentAt(ctx, fs, child.id, parent, true);
  ctx.doc.removeObject(id);
}

const placement = {
  location: vec3.optional().describe('World location (defaults to the 3D cursor)'),
  rotation: vec3.optional().describe('Euler XYZ rotation in radians'),
  scale: vec3.optional(),
  name: z.string().optional().describe('Name for the new object'),
  enter_editmode: z.boolean().default(false),
};

function placeObject(
  ctx: OperatorContext,
  p: { location?: number[]; rotation?: number[]; scale?: number[] },
) {
  return {
    location: (p.location ?? ctx.state.cursorLocation) as Vec3,
    rotation_euler: (p.rotation ?? [0, 0, 0]) as Vec3,
    scale: (p.scale ?? [1, 1, 1]) as Vec3,
  };
}

/** Adds a new object, selects it and makes it active (Blender behaviour). */
export function addObjectAndSelect(
  ctx: OperatorContext,
  init: Partial<ObjectData> & { type: ObjectType; name: string },
): string {
  const id = ctx.doc.addObject(init);
  setSelection(ctx, [id], id);
  return id;
}

/** Adds a primitive: in Edit Mode the geometry is merged into the edited mesh. */
function addPrimitive(
  ctx: OperatorContext,
  type: PrimitiveType,
  label: string,
  params: Record<string, unknown>,
  p: { location?: number[]; rotation?: number[]; scale?: number[]; name?: string; enter_editmode?: boolean },
): string {
  const mesh = createPrimitive(type, params);
  if (ctx.state.mode === 'EDIT') {
    const t = editTarget(ctx);
    const place = placeObject(ctx, p);
    const toLocal = multiply4(invert4(t.matrix), compose4(place.location, place.rotation_euler, place.scale));
    const out = cloneMesh(t.mesh);
    const offset = appendMesh(out, mesh, (v) => transformPoint3(toLocal, v));
    const newVerts: number[] = [];
    for (let i = offset; i < vertexCount(out); i++) newVerts.push(i);
    commitEdit(ctx, t, out, selectionFromVerts(out, newVerts));
    return t.object.id;
  }
  const meshId = ctx.doc.addMesh(p.name ?? label, mesh);
  const id = addObjectAndSelect(ctx, {
    type: 'MESH',
    name: p.name ?? label,
    data: meshId,
    ...placeObject(ctx, p),
  });
  if (p.enter_editmode) enterEditMode(ctx, id);
  return id;
}

export function enterEditMode(ctx: OperatorContext, id: string): void {
  const o = ctx.doc.getObject(id);
  if (!o || o.type !== 'MESH' || !o.data)
    throw new OperatorError('Edit Mode requires a mesh object', 'POLL_FAILED');
  // the host's memory check (the server's process): selecting every element of a large mesh
  const refused = editModeMemoryRefusal(ctx, o.data);
  if (refused) throw new OperatorError(`Edit Mode on '${o.name}': ${refused}`, 'OUT_OF_MEMORY');
  const mesh = ctx.doc.getMesh(o.data)!;
  ctx.state.activeId = id;
  if (!ctx.state.selectedIds.includes(id)) ctx.state.selectedIds = [...ctx.state.selectedIds, id];
  ctx.state.mode = 'EDIT';
  ctx.state.meshSelection = selectAllElements(mesh);
}

const fillType = z.enum(['NOTHING', 'NGON', 'TRIFAN']);

/** Bakes the evaluated (post-modifier) mesh of an object. */
export function evaluatedMesh(ctx: OperatorContext, id: string): MeshData | null {
  const ev = new SceneEvaluator(ctx.doc).evaluate(ctx.state.frame).byId.get(id);
  return ev?.mesh ?? null;
}

/**
 * object.convert to MESH bakes the evaluated geometry and drops the modifier stack. Like Apply
 * (object.modifier_apply; Blender's "Modifier is disabled or returned error, skipping apply"), the
 * selected objects whose geometry did not evaluate fully are refused instead of being baked without
 * what failed: a modifier error, a stored mesh that was not loaded, a curve or text without the
 * surface it should have. Blender's Convert bakes whatever its evaluation shows, but there a
 * modifier fails only where Blender itself shows the failure; here a modifier is also skipped over a
 * limit of its own (Subdivision Surface results over 4,000,000 faces) or for the server's memory,
 * which a browser editor evaluates and Blender computes, so baking without it would lose it.
 */
function refuseIncompleteGeometry(ctx: OperatorContext, ev: EvaluatedScene, target: string): void {
  if (target !== 'MESH') return;
  const problems: string[] = [];
  // a stored mesh the host did not load (its evaluation error `mesh:<id>`) was refused for memory
  let unloaded = false;
  // the evaluation's messages quote the objects they name by id ('<id>'): the refusal names them
  const named = (message: string) =>
    message.replace(/'([^'\s]+)'/g, (quoted, id: string) => {
      const x = ctx.doc.getObject(id);
      return x ? `'${x.name}'` : quoted;
    });
  for (const o of selectedObjects(ctx)) {
    const curve = o.type === 'CURVE' || o.type === 'FONT';
    if (!curve && !(o.type === 'MESH' && o.modifiers.length)) continue;
    const e = ev.byId.get(o.id);
    const messages = (e?.modifierErrors ?? []).map(
      (m) =>
        `${m.modifierId === 'shape_keys' ? 'shape keys' : `modifier '${o.modifiers.find((x) => x.id === m.modifierId)?.name ?? m.modifierId}'`}: ${named(m.message)}`,
    );
    // a curve problem leaves the object without geometry only when it has neither a surface nor a wire
    const noGeometry = !e?.mesh && !e?.lines;
    for (const err of ev.errors)
      if (err.source === `mesh:${o.id}` || (err.source === `curve:${o.id}` && noGeometry)) {
        messages.push(named(err.message));
        if (err.source === `mesh:${o.id}`) unloaded = true;
      }
    if (messages.length) problems.push(`'${o.name}': ${messages.join('; ')}`);
  }
  if (problems.length)
    throw new OperatorError(
      `Cannot convert ${problems.join('; ')}. Nothing was converted: fix or remove what failed (lower what ` +
        'was skipped for memory) and convert again',
      unloaded ? 'OUT_OF_MEMORY' : 'FAILED',
    );
}

function singleUserMesh(ctx: OperatorContext, o: ObjectData): string {
  if (!o.data) throw new OperatorError('Object has no data');
  if (ctx.doc.dataUsers(o.data) <= 1) return o.data;
  const copy = ctx.doc.addMesh(ctx.doc.getMeshBlock(o.data)?.name ?? o.name, ctx.doc.getMeshCopy(o.data)!);
  ctx.doc.updateObject(o.id, { data: copy });
  return copy;
}

export function registerObjectOperators(reg: OperatorRegistry): void {
  // ------------------------------------------------------------------ primitives
  const prim = <S extends z.ZodRawShape>(
    id: string,
    type: PrimitiveType,
    label: string,
    description: string,
    shape: S,
  ) =>
    reg.register(
      defineOperator({
        id,
        label,
        description,
        category: 'Add',
        redoable: true,
        schema: z.object({ ...shape, ...placement }),
        poll: (ctx) =>
          ctx.state.mode === 'OBJECT' || ctx.state.mode === 'EDIT' ? true : 'Not available in this mode',
        execute(ctx, p: Record<string, any>) {
          const { location, rotation, scale, name, enter_editmode, ...params } = p;
          const objectId = addPrimitive(ctx, type, label, params, {
            location,
            rotation,
            scale,
            name,
            enter_editmode,
          });
          return { object: objectId, name: ctx.doc.getObject(objectId)?.name };
        },
      }),
    );
  prim('mesh.primitive_cube_add', 'CUBE', 'Cube', 'Add a cube mesh.', {
    size: z.number().positive().default(2),
  });
  prim('mesh.primitive_plane_add', 'PLANE', 'Plane', 'Add a plane mesh.', {
    size: z.number().positive().default(2),
  });
  prim('mesh.primitive_grid_add', 'GRID', 'Grid', 'Add a subdivided grid mesh.', {
    x_subdivisions: z.number().int().min(1).max(1000).default(10),
    y_subdivisions: z.number().int().min(1).max(1000).default(10),
    size: z.number().positive().default(2),
  });
  prim('mesh.primitive_circle_add', 'CIRCLE', 'Circle', 'Add a circle (edge ring, n-gon or triangle fan).', {
    vertices: z.number().int().min(3).max(10000).default(32),
    radius: z.number().positive().default(1),
    fill_type: fillType.default('NOTHING'),
  });
  prim('mesh.primitive_uv_sphere_add', 'UV_SPHERE', 'Sphere', 'Add a UV sphere mesh.', {
    segments: z.number().int().min(3).max(500).default(32),
    ring_count: z.number().int().min(3).max(500).default(16),
    radius: z.number().positive().default(1),
  });
  prim('mesh.primitive_ico_sphere_add', 'ICO_SPHERE', 'Icosphere', 'Add an icosphere mesh.', {
    subdivisions: z.number().int().min(1).max(8).default(2),
    radius: z.number().positive().default(1),
  });
  prim('mesh.primitive_cylinder_add', 'CYLINDER', 'Cylinder', 'Add a cylinder mesh.', {
    vertices: z.number().int().min(3).max(10000).default(32),
    radius: z.number().positive().default(1),
    depth: z.number().positive().default(2),
    end_fill_type: fillType.default('NGON'),
  });
  prim('mesh.primitive_cone_add', 'CONE', 'Cone', 'Add a cone mesh.', {
    vertices: z.number().int().min(3).max(10000).default(32),
    radius1: z.number().min(0).default(1),
    radius2: z.number().min(0).default(0),
    depth: z.number().positive().default(2),
    end_fill_type: fillType.default('NGON'),
  });
  prim('mesh.primitive_torus_add', 'TORUS', 'Torus', 'Add a torus mesh.', {
    major_segments: z.number().int().min(3).max(1000).default(48),
    minor_segments: z.number().int().min(3).max(1000).default(12),
    major_radius: z.number().positive().default(1),
    minor_radius: z.number().positive().default(0.25),
  });

  reg.register(
    defineOperator({
      id: 'object.add_mesh_from_data',
      label: 'Mesh From Data',
      description:
        'Create a mesh object from raw geometry (like Blender mesh.from_pydata): vertices [[x,y,z],...], faces as vertex index loops (counter-clockwise = front), optional loose edges.',
      category: 'Add',
      schema: z.object({
        name: z.string().default('Mesh'),
        vertices: z.array(vec3).min(1),
        faces: z.array(z.array(z.number().int().min(0)).min(3)).default([]),
        edges: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).default([]),
        uvs: z.array(z.array(z.number())).optional().describe('Per-face flat [u0,v0,u1,v1,...] arrays'),
        smooth: z.boolean().default(false),
        location: vec3.optional(),
        rotation: vec3.optional(),
        scale: vec3.optional(),
      }),
      execute(ctx, p) {
        const n = p.vertices.length;
        for (const f of p.faces)
          for (const v of f)
            if (v >= n) throw new OperatorError(`Face index ${v} out of range`, 'INVALID_PARAMS');
        for (const [a, b] of p.edges)
          if (a >= n || b >= n) throw new OperatorError('Edge index out of range', 'INVALID_PARAMS');
        const faceEdges = new Set<string>();
        for (const f of p.faces)
          for (let i = 0; i < f.length; i++) faceEdges.add(edgeKey(f[i], f[(i + 1) % f.length]));
        const mesh = createMesh({
          positions: p.vertices.flat(),
          faces: p.faces.map((f) => f.slice()),
          faceSmooth: p.faces.map(() => p.smooth),
          uvs: p.uvs && p.uvs.length === p.faces.length ? p.uvs.map((u) => u.slice()) : null,
          looseEdges: p.edges.filter(([a, b]) => !faceEdges.has(edgeKey(a, b))).flat(),
        });
        const meshId = ctx.doc.addMesh(p.name, mesh);
        const id = addObjectAndSelect(ctx, {
          type: 'MESH',
          name: p.name,
          data: meshId,
          ...placeObject(ctx, p),
        });
        return { object: id, name: ctx.doc.getObject(id)?.name };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.empty_add',
      label: 'Empty',
      description: 'Add an empty object (transform helper).',
      category: 'Add',
      redoable: true,
      schema: z.object({
        type: z
          .enum(['PLAIN_AXES', 'ARROWS', 'SINGLE_ARROW', 'CIRCLE', 'CUBE', 'SPHERE', 'CONE'])
          .default('PLAIN_AXES'),
        radius: z.number().positive().default(1),
        ...placement,
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const id = addObjectAndSelect(ctx, {
          type: 'EMPTY',
          name: p.name ?? 'Empty',
          empty_display_type: p.type as EmptyDisplayType,
          empty_display_size: p.radius,
          ...placeObject(ctx, p),
        });
        return { object: id };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.camera_add',
      label: 'Camera',
      description:
        'Add a camera object (looking down its local -Z axis; becomes the scene camera if none is set). Optional ' +
        'camera settings as in camera.properties_set: lens or angle, sensor, clipping, ortho_scale, shift and depth ' +
        'of field (dof_use, dof_focus_distance or dof_focus_object, dof_aperture_fstop). Returns {object, name, camera}.',
      category: 'Add',
      redoable: true,
      schema: z.object({
        type: z.enum(['PERSP', 'ORTHO']).default('PERSP').describe('Projection: PERSP or ORTHO'),
        ...cameraFields,
        ...placement,
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const name = p.name ?? 'Camera';
        const { location: _l, rotation: _r, scale: _s, name: _n, enter_editmode: _e, ...fields } = p;
        // unset fields keep Blender's defaults (lens 50 mm, …)
        const { patch, warnings } = cameraPatch(ctx.doc, [], defaultCamera('', name), fields);
        const data = ctx.doc.addCamera({ ...patch, name });
        const id = addObjectAndSelect(ctx, { type: 'CAMERA', name, data, ...placeObject(ctx, p) });
        for (const w of warnings) ctx.report('WARNING', w);
        if (!ctx.doc.getScene().camera) ctx.doc.updateScene({ camera: id });
        return { object: id, name: ctx.doc.getObject(id)?.name, camera: data };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.light_add',
      label: 'Light',
      description:
        'Add a light object (POINT, SUN, SPOT or AREA; spot and area lights shine down their local -Z axis). energy is ' +
        'in watts (W/m² for SUN). radius sizes the light like Blender’s Add > Light: AREA size = size_y = radius, ' +
        'POINT/SPOT shadow_soft_size = 0.25 × radius. Every light setting of light.properties_set can be given ' +
        'directly (shadow_soft_size, spot_size, spot_blend, shape, size, size_y, angle, use_shadow) and wins over ' +
        'radius. Returns {object, name, light}.',
      category: 'Add',
      redoable: true,
      schema: z.object({
        type: z.enum(LIGHT_TYPES).default('POINT').describe('Light type'),
        radius: z
          .number()
          .min(0)
          .default(1)
          .describe(
            'Blender’s add-light size (default 1): AREA lights get size = size_y = radius (meters), POINT and SPOT ' +
              'lights shadow_soft_size = 0.25 × radius; SUN lights ignore it. Explicit size/size_y/shadow_soft_size win',
          ),
        ...lightFields,
        use_shadow: z.boolean().default(true).describe('Whether the light casts shadows'),
        ...placement,
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const type = p.type as LightType;
        const label = type.charAt(0) + type.slice(1).toLowerCase();
        const name = p.name ?? label;
        const { location: _l, rotation: _r, scale: _s, name: _n, enter_editmode: _e, radius, ...fields } = p;
        // Blender (object_light_add_exec + BKE_object_obdata_size_init): the radius scales the light radius
        // and, ×4, the 0.25 m default area size
        const sized: Partial<LightData> =
          type === 'AREA'
            ? { size: radius, size_y: radius }
            : type === 'SUN'
              ? {}
              : { shadow_soft_size: 0.25 * radius };
        const { patch, warnings } = lightPatch(defaultLight('', name, type), fields);
        const data = ctx.doc.addLight({ ...sized, ...patch, type, name });
        const id = addObjectAndSelect(ctx, { type: 'LIGHT', name, data, ...placeObject(ctx, p) });
        for (const w of warnings) ctx.report('WARNING', w);
        return { object: id, name: ctx.doc.getObject(id)?.name, light: data };
      },
    }),
  );

  // ------------------------------------------------------------------ selection
  reg.register(
    defineOperator({
      id: 'object.select_all',
      label: 'Select All',
      description: 'Change selection of all visible objects.',
      category: 'Select',
      undo: false,
      schema: z.object({ action: z.enum(['TOGGLE', 'SELECT', 'DESELECT', 'INVERT']).default('TOGGLE') }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const all = ctx.doc
          .listObjects()
          .filter((o) => !o.hide_viewport && !o.hide_select && ctx.doc.isCollectionVisible(o.collection))
          .map((o) => o.id);
        const sel = new Set(ctx.state.selectedIds);
        let action = p.action;
        if (action === 'TOGGLE') action = sel.size ? 'DESELECT' : 'SELECT';
        if (action === 'SELECT')
          setSelection(
            ctx,
            all,
            ctx.state.activeId && all.includes(ctx.state.activeId) ? ctx.state.activeId : (all[0] ?? null),
          );
        else if (action === 'DESELECT') setSelection(ctx, [], ctx.state.activeId);
        else
          setSelection(
            ctx,
            all.filter((id) => !sel.has(id)),
            ctx.state.activeId,
          );
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.select',
      label: 'Select Objects',
      description:
        'Select objects by id or name. With extend=false the previous selection is replaced. The last one becomes active unless `active` is given.',
      category: 'Select',
      undo: false,
      schema: z.object({
        objects: z.array(z.string()).default([]),
        extend: z.boolean().default(false),
        deselect: z.boolean().default(false),
        active: z.string().optional(),
      }),
      execute(ctx, p) {
        const ids = resolveObjectIds(ctx, p.objects.length ? p.objects : []);
        const given = p.objects.length ? ids : [];
        let next: string[];
        if (p.deselect) next = ctx.state.selectedIds.filter((id) => !given.includes(id));
        else next = p.extend ? [...ctx.state.selectedIds, ...given] : given;
        const active = p.active
          ? (ctx.doc.resolveObject(p.active)?.id ?? null)
          : (given[given.length - 1] ?? ctx.state.activeId);
        setSelection(ctx, next, active);
        return { selected: ctx.state.selectedIds };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.select_by_type',
      label: 'Select All by Type',
      description: 'Select all visible objects of a type.',
      category: 'Select',
      undo: false,
      schema: z.object({
        type: z.enum(['MESH', 'EMPTY', 'CAMERA', 'LIGHT']),
        extend: z.boolean().default(false),
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = ctx.doc
          .listObjects()
          .filter((o) => o.type === p.type && !o.hide_viewport)
          .map((o) => o.id);
        setSelection(ctx, p.extend ? [...ctx.state.selectedIds, ...ids] : ids);
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.select_pattern',
      label: 'Select Pattern',
      description: 'Select objects whose name matches a wildcard pattern (* and ?).',
      category: 'Select',
      undo: false,
      schema: z.object({
        pattern: z.string().default('*'),
        case_sensitive: z.boolean().default(false),
        extend: z.boolean().default(true),
      }),
      execute(ctx, p) {
        const re = new RegExp(
          `^${p.pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
          p.case_sensitive ? '' : 'i',
        );
        const ids = ctx.doc
          .listObjects()
          .filter((o) => re.test(o.name))
          .map((o) => o.id);
        setSelection(ctx, p.extend ? [...ctx.state.selectedIds, ...ids] : ids);
        return { selected: ids.length };
      },
    }),
  );

  // ------------------------------------------------------------------ delete / duplicate
  reg.register(
    defineOperator({
      id: 'object.delete',
      label: 'Delete',
      description: 'Delete the selected objects (or the given objects by id/name).',
      category: 'Object',
      schema: z.object({ objects: z.array(z.string()).optional() }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = resolveObjectIds(ctx, p.objects);
        if (ids.length === 0) throw new OperatorError('Nothing selected', 'POLL_FAILED');
        // children keep their world matrices where the scene shows them
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        for (const id of ids) removeObjectAt(ctx, fs, id);
        setSelection(
          ctx,
          ctx.state.selectedIds.filter((id) => !ids.includes(id)),
          ids.includes(ctx.state.activeId ?? '') ? null : ctx.state.activeId,
        );
        ctx.report('INFO', `Deleted ${ids.length} object(s)`);
        return { deleted: ids.length };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.duplicate',
      label: 'Duplicate Objects',
      description:
        'Duplicate selected objects (linked=true shares the object data, a mesh, curve, text, armature, light or ' +
        'camera, like Alt+D). The copies become the selection. ' +
        'References between duplicated objects (parents, modifier objects such as the Armature modifier, ' +
        'constraint and bone constraint targets, driver variables) point at the copies. As Blender does by ' +
        'default, each copy gets its own copy of the animation (keyframes and drivers) of the object and, ' +
        'unless linked, of its data (shape keys, curve, light and camera values); Blender shares the object ' +
        'action between linked duplicates instead, where later key edits change both. `offset` moves the ' +
        'copies as transform.translate does (keying as it keys).',
      category: 'Object',
      redoable: true,
      schema: z.object({ linked: z.boolean().default(false), offset: vec3.default([0, 0, 0]) }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        const sel = selectedObjects(ctx);
        const map = new Map<string, string>();
        // the datablocks copied (`<type>:<id>` as animation names them) and their copies' ids; data
        // shared by several duplicated objects is copied once, as Blender does
        const copies = new Map<string, string>();
        const dataTypes: Partial<Record<ObjectType, string>> = {
          MESH: 'mesh',
          CURVE: 'curve',
          FONT: 'curve',
          LIGHT: 'light',
          CAMERA: 'camera',
          ARMATURE: 'armature',
        };
        for (const o of sel) {
          let data = o.data;
          const dataKey = `${dataTypes[o.type]}:${o.data}`;
          if (o.data && !p.linked && copies.has(dataKey)) data = copies.get(dataKey)!;
          else if (o.data && !p.linked) {
            if (o.type === 'MESH') {
              data = ctx.doc.addMesh(
                ctx.doc.getMeshBlock(o.data)?.name ?? o.name,
                ctx.doc.getMeshCopy(o.data)!,
              );
              const keys = ctx.doc.getShapeKeys(o.data);
              if (keys.length) ctx.doc.setShapeKeys(data, keys);
              const groups = ctx.doc.getVertexGroups(o.data);
              if (groups.length) ctx.doc.setVertexGroups(data, groups);
            } else if (o.type === 'CURVE' || o.type === 'FONT') {
              const { id: _id, ...c } = ctx.doc.getCurve(o.data)!;
              data = ctx.doc.addCurve(c);
            } else if (o.type === 'ARMATURE') {
              const { id: _id, ...a } = ctx.doc.getArmature(o.data)!;
              data = ctx.doc.addArmature(a);
            } else if (o.type === 'LIGHT') {
              const { id: _id, ...l } = ctx.doc.getLight(o.data)!;
              data = ctx.doc.addLight(l);
            } else if (o.type === 'CAMERA') {
              const { id: _id, ...c } = ctx.doc.getCamera(o.data)!;
              data = ctx.doc.addCamera(c);
            }
            if (data && data !== o.data) copies.set(dataKey, data);
          }
          const { id: _id, ...rest } = o;
          const nid = ctx.doc.addObject({
            ...rest,
            data,
            modifiers: o.modifiers.map((m) => ({
              ...m,
              id: `${m.id}_${Math.random().toString(36).slice(2, 7)}`,
            })),
          });
          map.set(o.id, nid);
          copies.set(`object:${o.id}`, nid);
        }
        // the copies' own keyframes and drivers, drivers reading duplicated datablocks reading the copies
        copyAnimation(ctx.doc, copies);
        // Re-link parents inside the duplicated set; offset only the roots.
        for (const [src, dst] of map) {
          const o = ctx.doc.getObject(src)!;
          if (o.parent && map.has(o.parent)) ctx.doc.updateObject(dst, { parent: map.get(o.parent)! });
        }
        // modifier objects and constraint targets inside the set point at the copies too
        remapDuplicatedReferences(ctx.doc, map);
        // the offset moves the copies as Move does: in their parents' space as the scene shows it
        // (a bone's posed matrix, an animated or constrained parent)
        if (p.offset.some((v) => v !== 0)) {
          const fs = new FrameState(ctx.doc, ctx.state.frame);
          const offset = translation4(p.offset as Vec3);
          const changes = new Map<string, ChannelChange>();
          for (const id of transformRoots(ctx.doc, [...map.values()])) {
            const t = transformStart(fs, id, 'TRANSLATE');
            if (!t) continue;
            const next = transformedChannels(t.channels, t.basis, 'TRANSLATE', offset, [0, 0, 0]);
            const patch = changedChannels(t.channels, next, transformTolerance(t.basis));
            if (patch) ctx.doc.updateObject(id, patch);
            changes.set(id, { before: t.channels, after: { ...t.channels, ...patch } });
          }
          // a copied animated location keeps the offset (keyed as Move keys)
          keyChannelChanges(ctx, changes);
        }
        const ids = [...map.values()];
        setSelection(ctx, ids, map.get(ctx.state.activeId ?? '') ?? ids[ids.length - 1] ?? null);
        return { objects: ids };
      },
    }),
  );

  // ------------------------------------------------------------------ visibility
  reg.register(
    defineOperator({
      id: 'object.hide_view_set',
      label: 'Hide Selected',
      description: 'Hide the selected (or unselected) objects in the viewport.',
      category: 'Object',
      schema: z.object({ unselected: z.boolean().default(false) }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const sel = new Set(ctx.state.selectedIds);
        for (const o of ctx.doc.listObjects())
          if (sel.has(o.id) !== p.unselected) ctx.doc.updateObject(o.id, { hide_viewport: true });
        if (!p.unselected) setSelection(ctx, [], null);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.hide_view_clear',
      label: 'Reveal Hidden',
      description: 'Reveal all hidden objects and select them.',
      category: 'Object',
      schema: z.object({ select: z.boolean().default(true) }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const revealed: string[] = [];
        for (const o of ctx.doc.listObjects())
          if (o.hide_viewport) {
            ctx.doc.updateObject(o.id, { hide_viewport: false });
            revealed.push(o.id);
          }
        if (p.select) setSelection(ctx, [...ctx.state.selectedIds, ...revealed], ctx.state.activeId);
      },
    }),
  );

  // ------------------------------------------------------------------ clear / apply transforms
  const clear = (id: string, label: string, field: 'location' | 'rotation_euler' | 'scale', value: Vec3) =>
    reg.register(
      defineOperator({
        id,
        label,
        description:
          `Reset the ${field} of the selected objects. With auto keying their ${field} is keyed at the current ` +
          'frame, as in Blender; without it an animated channel it changes is keyed there with its new value, ' +
          'so the object shows it.',
        category: 'Object',
        schema: z.object({}),
        poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
        execute(ctx) {
          // keyed as Blender's Clear keys (its Location, Rotation or Scale keying set) with auto keying,
          // and without it the animated channels it changes (see keyChannelChanges)
          const fs = new FrameState(ctx.doc, ctx.state.frame);
          const changes = new Map<string, ChannelChange>();
          for (const o of selectedObjects(ctx)) {
            const shown = fs.byId.get(o.id) ?? o;
            const before = {
              location: shown.location,
              rotation_euler: shown.rotation_euler,
              scale: shown.scale,
            };
            if (o[field].some((v, i) => v !== value[i])) ctx.doc.updateObject(o.id, { [field]: value });
            changes.set(o.id, { before, after: { ...before, [field]: value } });
          }
          keyChannelChanges(ctx, changes, [field]);
        },
      }),
    );
  clear('object.location_clear', 'Clear Location', 'location', [0, 0, 0]);
  clear('object.rotation_clear', 'Clear Rotation', 'rotation_euler', [0, 0, 0]);
  clear('object.scale_clear', 'Clear Scale', 'scale', [1, 1, 1]);

  reg.register(
    defineOperator({
      id: 'object.transform_apply',
      label: 'Apply Transform',
      description:
        "Apply the selected objects' location/rotation/scale to their mesh data (Ctrl+A), as the objects show " +
        'them at the current frame; children keep their places. Curves transform their control points; 2D ' +
        'curves can only take rotations about Z and X/Y locations, text only a uniform scale (the operator ' +
        'fails without changing anything otherwise). An animated channel it resets is keyed at the current ' +
        'frame with its reset value, so nothing moves there; at other frames its keys go on moving, turning or ' +
        'scaling the object on top of what the data now holds (Blender keeps the reset value without a key ' +
        'until the frame changes, then its keys do the same).',
      category: 'Object',
      redoable: true,
      schema: z.object({
        location: z.boolean().default(false),
        rotation: z.boolean().default(true),
        scale: z.boolean().default(true),
        properties: z
          .boolean()
          .default(true)
          .describe(
            'Curves and text: also scale curve point radii and font size/offset/bevel/extrude, so tubes and ' +
              'text keep their thickness (Blender "Apply Properties")',
          ),
      }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        // what the scene shows at the frame: Blender applies the values an animated object shows
        // there (its channels hold them), and children keep their world matrices (keepChildrenWorld)
        const shown = new FrameState(ctx.doc, ctx.state.frame);
        const showing = (o: ObjectData, fs: FrameState): ObjectData => {
          const c = fs.byId.get(o.id);
          return c ? { ...o, location: c.location, rotation_euler: c.rotation_euler, scale: c.scale } : o;
        };
        // curves and text cannot absorb every transform: refuse before anything changes
        checkCurveTransformApply(
          ctx,
          selectedObjects(ctx).map((o) => showing(o, shown)),
          p,
        );
        const changed = new Set<string>();
        const differs = (a: Vec3, b: Vec3) => a.some((v, i) => v !== b[i]);
        for (const sel of selectedObjects(ctx)) {
          // re-read: applying a selected parent changes the transforms of its children
          const o = ctx.doc.getObject(sel.id) ?? sel;
          const cur = showing(
            o,
            o.parent && changed.has(o.parent) ? new FrameState(ctx.doc, ctx.state.frame) : shown,
          );
          const loc: Vec3 = p.location ? [0, 0, 0] : cur.location;
          const rot: Vec3 = p.rotation ? [0, 0, 0] : cur.rotation_euler;
          const scl: Vec3 = p.scale ? [1, 1, 1] : cur.scale;
          // like Blender's Apply Object Transform, only the applied channels are reset; the others,
          // and channels whose stored values are at their reset values, are not written at all (an
          // animated channel keeps its keys and is keyed with its reset value at the frame, below)
          const reset: Partial<ObjectData> = {};
          if (p.location && differs([0, 0, 0], o.location)) reset.location = [0, 0, 0];
          if (p.rotation && differs([0, 0, 0], o.rotation_euler)) reset.rotation_euler = [0, 0, 0];
          if (p.scale && differs([1, 1, 1], o.scale)) reset.scale = [1, 1, 1];
          const bake =
            differs(loc, cur.location) || differs(rot, cur.rotation_euler) || differs(scl, cur.scale);
          if (!bake && Object.keys(reset).length === 0) continue;
          const before = compose4(cur.location, cur.rotation_euler, cur.scale);
          const after = compose4(loc, rot, scl);
          const delta = multiply4(invert4(after), before); // vertex' = after⁻¹ · before · vertex
          if (!bake) {
            // the values shown are the reset ones already: only the stored channels are reset
          } else if (o.type === 'MESH' && o.data) {
            const meshId = singleUserMesh(ctx, o);
            const m = cloneMesh(ctx.doc.getMesh(meshId)!);
            for (let i = 0; i < vertexCount(m); i++) {
              const q = transformPoint3(delta, [
                m.positions[i * 3],
                m.positions[i * 3 + 1],
                m.positions[i * 3 + 2],
              ]);
              m.positions[i * 3] = q[0];
              m.positions[i * 3 + 1] = q[1];
              m.positions[i * 3 + 2] = q[2];
            }
            // Negative scale flips winding: keep normals pointing outward.
            const det = scl[0] * scl[1] * scl[2];
            const det0 = cur.scale[0] * cur.scale[1] * cur.scale[2];
            if (Math.sign(det) !== Math.sign(det0)) {
              m.faces = m.faces.map((f) => f.slice().reverse());
              if (m.uvs) m.uvs = m.uvs.map((uv) => reversePairs(uv));
            }
            ctx.doc.setMesh(meshId, m);
          } else if (o.type === 'CURVE' || o.type === 'FONT') {
            // false (with a warning) when its data cannot take the transform: it stays on the object
            if (!applyCurveTransform(ctx, o, delta, p.properties)) continue;
          }
          // children keep their world transform
          keepChildrenWorld(
            ctx,
            o.id,
            () => {
              if (Object.keys(reset).length) ctx.doc.updateObject(o.id, reset);
              // an animated channel it resets is keyed with its reset value at the frame, where
              // Blender keeps the reset value without a key until the frame changes (its Apply
              // does not auto key)
              const held = { location: cur.location, rotation_euler: cur.rotation_euler, scale: cur.scale };
              const applied = { location: loc, rotation_euler: rot, scale: scl };
              keyChannelChanges(ctx, new Map([[o.id, { before: held, after: applied }]]), undefined, false);
            },
            shown,
            changed,
          );
          changed.add(o.id);
        }
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.origin_set',
      label: 'Set Origin',
      description:
        'Move the object origin onto the centre of its geometry (ORIGIN_GEOMETRY) or onto the 3D cursor ' +
        '(ORIGIN_CURSOR) without moving the geometry where it shows at the current frame, or move the geometry so ' +
        'that its centre is on the origin (GEOMETRY_ORIGIN, which moves what is shown); children keep their places. ' +
        'An animated location the origin move changes is keyed at the current frame with its new value, so the ' +
        "geometry stays where it is there; the location's other keys do not change, so at those keyframes the " +
        'geometry shows moved by the opposite of the origin move (Blender keeps the new value without a key until ' +
        'the frame changes, and from then on shows the geometry moved so at every frame).',
      category: 'Object',
      schema: z.object({
        type: z.enum(['ORIGIN_GEOMETRY', 'ORIGIN_CURSOR', 'GEOMETRY_ORIGIN']).default('ORIGIN_GEOMETRY'),
        center: z.enum(['MEDIAN', 'BOUNDS']).default('MEDIAN'),
      }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        // where the scene shows the objects (a bone or an animated or constrained parent included),
        // read before anything changes: the operator keeps every other object's world matrix
        const before = new FrameState(ctx.doc, ctx.state.frame);
        const changed = new Set<string>();
        for (const o of selectedObjects(ctx)) {
          // curves move their control points, text its offset_x/offset_y
          if (o.type === 'CURVE' || o.type === 'FONT')
            curveOriginSet(ctx, o, p.type, p.center, before, changed);
          if (o.type !== 'MESH' || !o.data) continue;
          const meshId = singleUserMesh(ctx, o);
          const m = cloneMesh(ctx.doc.getMesh(meshId)!);
          const n = vertexCount(m);
          if (n === 0) continue;
          const world = evaluatedWorld(before, o.id);
          let centerLocal: Vec3;
          if (p.center === 'BOUNDS') {
            const b = meshBounds(m)!;
            centerLocal = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
          } else {
            centerLocal = [0, 0, 0];
            for (let i = 0; i < n; i++)
              for (let k = 0; k < 3; k++) centerLocal[k] += m.positions[i * 3 + k] / n;
          }
          if (p.type === 'GEOMETRY_ORIGIN') {
            for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m.positions[i * 3 + k] -= centerLocal[k];
            ctx.doc.setMesh(meshId, m);
            continue;
          }
          const target: Vec3 =
            p.type === 'ORIGIN_CURSOR'
              ? transformPoint3(invert4(world), ctx.state.cursorLocation)
              : centerLocal;
          for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m.positions[i * 3 + k] -= target[k];
          ctx.doc.setMesh(meshId, m);
          // the origin moves onto the old centre, so nothing moves visually
          moveOrigin(ctx, o.id, target, before, changed);
        }
      },
    }),
  );

  // ------------------------------------------------------------------ shading
  const shade = (id: string, label: string, smooth: boolean) =>
    reg.register(
      defineOperator({
        id,
        label,
        description:
          `Set ${smooth ? 'smooth' : 'flat'} shading on all faces of the selected mesh objects ` +
          '(curve objects: the use_smooth flag of every spline; text is always smooth shaded).',
        category: 'Object',
        schema: z.object({}),
        poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
        execute(ctx) {
          const done = new Set<string>();
          for (const o of selectedObjects(ctx)) {
            if ((o.type === 'CURVE' || o.type === 'FONT') && !done.has(o.data ?? o.id)) {
              done.add(o.data ?? o.id);
              curveShadeSet(ctx, o, smooth);
            }
            if (o.type !== 'MESH' || !o.data || done.has(o.data)) continue;
            done.add(o.data);
            const m = cloneMesh(ctx.doc.getMesh(o.data)!);
            m.faceSmooth = m.faces.map(() => smooth);
            if (!smooth) for (const k in m.edgeAttrs) delete m.edgeAttrs[k].sharp;
            ctx.doc.setMesh(o.data, m);
          }
        },
      }),
    );
  shade('object.shade_smooth', 'Shade Smooth', true);
  shade('object.shade_flat', 'Shade Flat', false);

  reg.register(
    defineOperator({
      id: 'object.shade_auto_smooth',
      label: 'Shade Auto Smooth',
      description: 'Smooth shading with edges sharper than `angle` (radians) marked sharp.',
      category: 'Object',
      redoable: true,
      schema: z.object({
        angle: z
          .number()
          .min(0)
          .max(Math.PI)
          .default((30 * Math.PI) / 180),
      }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        const done = new Set<string>();
        for (const o of selectedObjects(ctx)) {
          if (o.type !== 'MESH' || !o.data || done.has(o.data)) continue;
          done.add(o.data);
          const m = cloneMesh(ctx.doc.getMesh(o.data)!);
          m.faceSmooth = m.faces.map(() => true);
          const topo = buildTopology(m);
          const normals = m.faces.map((_, f) => faceNormal(m, f));
          for (let e = 0; e < topo.edges.length; e++) {
            const [a, b] = topo.edges[e];
            const k = edgeKey(a, b);
            const ef = topo.edgeFaces[e];
            let sharp = false;
            if (ef.length === 2) {
              const n0 = normals[ef[0]];
              const n1 = normals[ef[1]];
              const cos = Math.max(-1, Math.min(1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
              sharp = Math.acos(cos) > p.angle + 1e-6;
            }
            if (sharp) m.edgeAttrs[k] = { ...m.edgeAttrs[k], sharp: true };
            else if (m.edgeAttrs[k]?.sharp) {
              const { sharp: _s, ...rest } = m.edgeAttrs[k];
              if (Object.keys(rest).length) m.edgeAttrs[k] = rest;
              else delete m.edgeAttrs[k];
            }
          }
          ctx.doc.setMesh(o.data, m);
        }
      },
    }),
  );

  // ------------------------------------------------------------------ parenting
  reg.register(
    defineOperator({
      id: 'object.parent_set',
      label: 'Set Parent',
      description:
        'Parent the selected objects to the active object (keeping their world transform). type OBJECT (default), ' +
        'or with an armature as the active object: ARMATURE (adds an Armature modifier), ARMATURE_NAME (+ empty ' +
        'vertex groups for the deform bones), ARMATURE_ENVELOPE (+ weights from bone envelopes), ARMATURE_AUTO ' +
        '(+ automatic weights) or BONE (the child rigidly follows `bone`).',
      category: 'Object',
      schema: z.object({
        type: z
          .enum(['OBJECT', ...ARMATURE_PARENT_TYPES])
          .default('OBJECT')
          .describe('Parent type'),
        keep_transform: z.boolean().default(true).describe('Keep the world transform of the children'),
        bone: z.string().default('').describe('BONE: name of the parent bone (default: the only bone)'),
      }),
      poll: (ctx) => {
        if (pollObjectMode(ctx) !== true) return pollObjectMode(ctx);
        return ctx.state.activeId && selectedObjects(ctx).length > 1
          ? true
          : 'Select children and then the parent (active)';
      },
      execute(ctx, p) {
        const parent = ctx.state.activeId!;
        if (p.type !== 'OBJECT')
          return armatureParentSet(
            ctx,
            selectedObjects(ctx).map((o) => o.id),
            parent,
            p.type,
            p,
          );
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        for (const o of selectedObjects(ctx)) {
          if (o.id === parent) continue;
          if (ctx.doc.isAncestor(o.id, parent)) throw new OperatorError('Loop in parents', 'FAILED');
          setParentAt(ctx, fs, o.id, parent, p.keep_transform);
        }
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.parent_to',
      label: 'Parent To',
      description:
        'Set (or clear with parent=null) the parent of objects by id/name. type as in object.parent_set ' +
        '(ARMATURE_AUTO binds meshes to an armature with automatic weights, BONE follows `bone`).',
      category: 'Object',
      schema: z.object({
        objects: z
          .array(z.string())
          .optional()
          .describe('Child object ids or names (default: the selection)'),
        parent: z.string().nullable().describe('Parent object id or name (null clears the parent)'),
        keep_transform: z.boolean().default(true).describe('Keep the world transform of the children'),
        type: z
          .enum(['OBJECT', ...ARMATURE_PARENT_TYPES])
          .default('OBJECT')
          .describe('Parent type'),
        bone: z.string().default('').describe('BONE: name of the parent bone (default: the only bone)'),
      }),
      execute(ctx, p) {
        const ids = resolveObjectIds(ctx, p.objects);
        const parent = p.parent ? ctx.doc.resolveObject(p.parent)?.id : null;
        if (p.parent && !parent) throw new OperatorError(`Parent '${p.parent}' not found`, 'NOT_FOUND');
        if (p.type !== 'OBJECT') {
          if (!parent) throw new OperatorError(`Parent type ${p.type} needs a parent`, 'INVALID_PARAMS');
          return armatureParentSet(ctx, ids, parent, p.type, p);
        }
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        for (const id of ids) {
          if (id === parent) continue;
          setParentAt(ctx, fs, id, parent ?? null, p.keep_transform);
        }
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.parent_clear',
      label: 'Clear Parent',
      description: 'Remove the parent of the selected objects.',
      category: 'Object',
      schema: z.object({ type: z.enum(['CLEAR', 'CLEAR_KEEP_TRANSFORM']).default('CLEAR_KEEP_TRANSFORM') }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        for (const o of selectedObjects(ctx))
          if (o.parent) setParentAt(ctx, fs, o.id, null, p.type === 'CLEAR_KEEP_TRANSFORM');
      },
    }),
  );

  // ------------------------------------------------------------------ join / convert
  reg.register(
    defineOperator({
      id: 'object.join',
      label: 'Join',
      description: 'Join the selected mesh objects into the active one.',
      category: 'Object',
      schema: z.object({}),
      poll: (ctx) => {
        if (pollObjectMode(ctx) !== true) return pollObjectMode(ctx);
        const a = activeObject(ctx);
        if (!a || a.type !== 'MESH') return 'Active object must be a mesh';
        return selectedObjects(ctx).filter((o) => o.type === 'MESH').length > 1
          ? true
          : 'Select at least two meshes';
      },
      execute(ctx) {
        const active = activeObject(ctx)!;
        const activeMeshId = singleUserMesh(ctx, active);
        const out = cloneMesh(ctx.doc.getMesh(activeMeshId)!);
        // where the scene shows the objects (Blender joins with their evaluated matrices)
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        const inv = invert4(evaluatedWorld(fs, active.id));
        const slots = [...active.material_slots];
        for (const o of selectedObjects(ctx)) {
          if (o.id === active.id || o.type !== 'MESH' || !o.data) continue;
          const src = ctx.doc.getMesh(o.data);
          if (!src) continue;
          const toActive: Mat4 = multiply4(inv, evaluatedWorld(fs, o.id));
          // map material slots
          const slotMap = o.material_slots.map((mat) => {
            let i = slots.indexOf(mat);
            if (i < 0) {
              slots.push(mat);
              i = slots.length - 1;
            }
            return i;
          });
          const remapped = cloneMesh(src);
          remapped.faceMaterials = remapped.faceMaterials.map((mi) => slotMap[mi] ?? 0);
          appendMesh(out, remapped, (v) => transformPoint3(toActive, v));
          removeObjectAt(ctx, fs, o.id);
        }
        ctx.doc.setMesh(activeMeshId, out);
        ctx.doc.updateObject(active.id, { material_slots: slots });
        setSelection(ctx, [active.id], active.id);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.convert',
      label: 'Convert to Mesh',
      description:
        'Convert the selected objects. MESH: bake the evaluated geometry — applies the modifiers of mesh objects; ' +
        'curve and text objects become meshes (surface, or loose edges for plain wires) keeping name, transform and ' +
        'materials. CURVE: turns text objects into 2D curve objects of their glyph outlines. ' +
        'Returns {converted: [{object, name, type}]} listing every object that changed (mesh objects whose ' +
        'modifiers were applied included). Like object.modifier_apply, objects whose geometry did not evaluate ' +
        'fully (a modifier that failed or was skipped, a curve or text surface that was not built: the problems ' +
        'of get_scene) are refused with those errors and nothing is converted, instead of baking the geometry ' +
        'without them.',
      category: 'Object',
      schema: z.object({
        target: z.enum(['MESH', 'CURVE']).default('MESH').describe('Object type to convert to'),
        keep_original: z
          .boolean()
          .default(false)
          .describe(
            'Keep the original object and add the converted copy (the copies are selected afterwards)',
          ),
      }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        const ev = new SceneEvaluator(ctx.doc).evaluate(ctx.state.frame);
        refuseIncompleteGeometry(ctx, ev, p.target);
        const converted: { object: string; name: string; type: string }[] = [];
        for (const o of selectedObjects(ctx)) {
          if (o.type === 'CURVE' || o.type === 'FONT') {
            const r = convertCurveObject(ctx, o, p.target, ev, p.keep_original);
            if (r) converted.push(r);
            continue;
          }
          if (p.target !== 'MESH' || o.type !== 'MESH' || !o.data || o.modifiers.length === 0) continue;
          const mesh = ev.byId.get(o.id)?.mesh;
          if (!mesh) continue;
          if (p.keep_original) {
            // a copy gets the baked result; the original keeps its modifier stack
            const { id: _id, name, ...rest } = o;
            const copyMesh = ctx.doc.addMesh(ctx.doc.getMeshBlock(o.data)?.name ?? name, cloneMesh(mesh));
            const id = ctx.doc.addObject({ ...rest, name, data: copyMesh, modifiers: [] });
            converted.push({ object: id, name: ctx.doc.getObject(id)!.name, type: 'MESH' });
            continue;
          }
          const meshId = singleUserMesh(ctx, o);
          ctx.doc.setMesh(meshId, cloneMesh(mesh));
          ctx.doc.updateObject(o.id, { modifiers: [] });
          converted.push({ object: o.id, name: o.name, type: 'MESH' });
        }
        const convertedIds = converted.map((c) => c.object);
        if (p.keep_original && convertedIds.length) setSelection(ctx, convertedIds);
        return { converted };
      },
    }),
  );

  // ------------------------------------------------------------------ mode
  reg.register(
    defineOperator({
      id: 'object.mode_set',
      label: 'Set Object Mode',
      description:
        'Switch interaction mode (OBJECT, EDIT, SCULPT, VERTEX_PAINT). toggle=true switches back to OBJECT if already in the mode.',
      category: 'Object',
      undo: false,
      schema: z.object({
        mode: z.enum(['OBJECT', 'EDIT', 'SCULPT', 'VERTEX_PAINT']).default('OBJECT'),
        toggle: z.boolean().default(false),
      }),
      execute(ctx, p) {
        let mode = p.mode;
        if (p.toggle && ctx.state.mode === mode) mode = 'OBJECT';
        if (mode === 'OBJECT') {
          ctx.state.mode = 'OBJECT';
          return;
        }
        const a = activeObject(ctx);
        if (!a || a.type !== 'MESH')
          throw new OperatorError(`${mode} mode requires an active mesh object`, 'POLL_FAILED');
        if (mode === 'EDIT') enterEditMode(ctx, a.id);
        else {
          ctx.state.mode = mode;
          if (!ctx.state.selectedIds.includes(a.id)) ctx.state.selectedIds = [...ctx.state.selectedIds, a.id];
        }
      },
    }),
  );

  // ------------------------------------------------------------------ naming / generic properties
  reg.register(
    defineOperator({
      id: 'object.rename',
      label: 'Rename',
      description:
        'Rename an object (names are kept unique, Blender style: a taken name gets a .001 suffix). Returns the ' +
        'name it got.',
      category: 'Object',
      schema: z.object({
        object: z.string().optional().describe('Object id or name (default: the active object)'),
        name: z.string().min(1).describe('New name'),
      }),
      execute(ctx, p) {
        if (p.object) {
          const o = ctx.doc.resolveObject(p.object);
          if (!o) throw new OperatorError(`Object '${p.object}' not found`, 'NOT_FOUND');
          return { object: o.id, old_name: o.name, name: ctx.doc.rename('objects', o.id, p.name) };
        }
        const active = ctx.state.activeId ? ctx.doc.getObject(ctx.state.activeId) : null;
        if (!active)
          throw new OperatorError('No active object to rename: pass `object` (id or name)', 'POLL_FAILED');
        return {
          object: active.id,
          old_name: active.name,
          name: ctx.doc.rename('objects', active.id, p.name),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.move_to_collection',
      label: 'Move to Collection',
      description:
        'Move selected objects to a collection (id or name). Use new_collection_name to create one.',
      category: 'Object',
      schema: z.object({
        collection: z.string().default(ROOT_COLLECTION_ID),
        new_collection_name: z.string().optional(),
      }),
      poll: pollHasSelection,
      execute(ctx, p) {
        let cid = p.collection;
        if (p.new_collection_name)
          cid = ctx.doc.addCollection({
            name: p.new_collection_name,
            parent: p.collection || ROOT_COLLECTION_ID,
          });
        else if (!ctx.doc.getCollection(cid)) {
          const byName = ctx.doc.listCollections().find((c) => c.name === cid);
          if (!byName) throw new OperatorError(`Collection '${cid}' not found`, 'NOT_FOUND');
          cid = byName.id;
        }
        for (const o of selectedObjects(ctx)) ctx.doc.updateObject(o.id, { collection: cid });
        return { collection: cid };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'collection.create',
      label: 'New Collection',
      description: 'Create a new collection.',
      category: 'Collection',
      schema: z.object({
        name: z.string().default('Collection'),
        parent: z.string().default(ROOT_COLLECTION_ID),
      }),
      execute(ctx, p) {
        return { collection: ctx.doc.addCollection({ name: p.name, parent: p.parent }) };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'collection.delete',
      label: 'Delete Collection',
      description: 'Delete a collection; its objects move to the parent collection.',
      category: 'Collection',
      schema: z.object({ collection: z.string() }),
      execute(ctx, p) {
        ctx.doc.removeCollection(p.collection);
      },
    }),
  );
}

function reversePairs(uv: number[]): number[] {
  const out: number[] = [];
  for (let i = uv.length - 2; i >= 0; i -= 2) out.push(uv[i], uv[i + 1]);
  return out;
}
