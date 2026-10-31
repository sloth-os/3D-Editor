import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { compose4, invert4, multiply4 } from '../math/mat4';
import { transformPoint3 } from '../math/vec3';
import type { EmptyDisplayType, LightType, ObjectData, ObjectType } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { appendMesh, cloneMesh, createMesh, edgeKey, meshBounds, vertexCount } from '../mesh/types';
import { createPrimitive, type PrimitiveType } from '../mesh/primitives';
import { buildTopology } from '../mesh/topology';
import { faceNormal } from '../mesh/normals';
import { selectAllElements, selectionFromVerts } from '../mesh/selection';
import { SceneEvaluator } from '../eval/evaluate';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
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
import { transformRoots } from './transform';

const placement = {
  location: vec3.optional().describe('World location (defaults to the 3D cursor)'),
  rotation: vec3.optional().describe('Euler XYZ rotation in radians'),
  scale: vec3.optional(),
  name: z.string().optional().describe('Name for the new object'),
  enter_editmode: z.boolean().default(false),
};

function placeObject(ctx: OperatorContext, p: { location?: number[]; rotation?: number[]; scale?: number[] }) {
  return {
    location: (p.location ?? ctx.state.cursorLocation) as Vec3,
    rotation_euler: (p.rotation ?? [0, 0, 0]) as Vec3,
    scale: (p.scale ?? [1, 1, 1]) as Vec3,
  };
}

/** Adds a new object, selects it and makes it active (Blender behaviour). */
export function addObjectAndSelect(ctx: OperatorContext, init: Partial<ObjectData> & { type: ObjectType; name: string }): string {
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
  const id = addObjectAndSelect(ctx, { type: 'MESH', name: p.name ?? label, data: meshId, ...placeObject(ctx, p) });
  if (p.enter_editmode) enterEditMode(ctx, id);
  return id;
}

export function enterEditMode(ctx: OperatorContext, id: string): void {
  const o = ctx.doc.getObject(id);
  if (!o || o.type !== 'MESH' || !o.data) throw new OperatorError('Edit Mode requires a mesh object', 'POLL_FAILED');
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
        poll: (ctx) => (ctx.state.mode === 'OBJECT' || ctx.state.mode === 'EDIT' ? true : 'Not available in this mode'),
        execute(ctx, p: Record<string, any>) {
          const { location, rotation, scale, name, enter_editmode, ...params } = p;
          const objectId = addPrimitive(ctx, type, label, params, { location, rotation, scale, name, enter_editmode });
          return { object: objectId, name: ctx.doc.getObject(objectId)?.name };
        },
      }),
    );
  prim('mesh.primitive_cube_add', 'CUBE', 'Cube', 'Add a cube mesh.', { size: z.number().positive().default(2) });
  prim('mesh.primitive_plane_add', 'PLANE', 'Plane', 'Add a plane mesh.', { size: z.number().positive().default(2) });
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
        for (const f of p.faces) for (const v of f) if (v >= n) throw new OperatorError(`Face index ${v} out of range`, 'INVALID_PARAMS');
        for (const [a, b] of p.edges) if (a >= n || b >= n) throw new OperatorError('Edge index out of range', 'INVALID_PARAMS');
        const faceEdges = new Set<string>();
        for (const f of p.faces) for (let i = 0; i < f.length; i++) faceEdges.add(edgeKey(f[i], f[(i + 1) % f.length]));
        const mesh = createMesh({
          positions: p.vertices.flat(),
          faces: p.faces.map((f) => f.slice()),
          faceSmooth: p.faces.map(() => p.smooth),
          uvs: p.uvs && p.uvs.length === p.faces.length ? p.uvs.map((u) => u.slice()) : null,
          looseEdges: p.edges.filter(([a, b]) => !faceEdges.has(edgeKey(a, b))).flat(),
        });
        const meshId = ctx.doc.addMesh(p.name, mesh);
        const id = addObjectAndSelect(ctx, { type: 'MESH', name: p.name, data: meshId, ...placeObject(ctx, p) });
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
        type: z.enum(['PLAIN_AXES', 'ARROWS', 'SINGLE_ARROW', 'CIRCLE', 'CUBE', 'SPHERE', 'CONE']).default('PLAIN_AXES'),
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
      description: 'Add a camera object. Becomes the scene camera if none is set.',
      category: 'Add',
      redoable: true,
      schema: z.object({
        lens: z.number().positive().default(50),
        type: z.enum(['PERSP', 'ORTHO']).default('PERSP'),
        ...placement,
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const data = ctx.doc.addCamera({ name: p.name ?? 'Camera', lens: p.lens, type: p.type });
        const id = addObjectAndSelect(ctx, { type: 'CAMERA', name: p.name ?? 'Camera', data, ...placeObject(ctx, p) });
        if (!ctx.doc.getScene().camera) ctx.doc.updateScene({ camera: id });
        return { object: id };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.light_add',
      label: 'Light',
      description: 'Add a light object (POINT, SUN, SPOT or AREA). energy is in watts (W/m² for sun).',
      category: 'Add',
      redoable: true,
      schema: z.object({
        type: z.enum(['POINT', 'SUN', 'SPOT', 'AREA']).default('POINT'),
        energy: z.number().min(0).optional(),
        color: vec3.optional(),
        radius: z.number().min(0).default(1),
        ...placement,
      }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const label = p.type.charAt(0) + p.type.slice(1).toLowerCase();
        const data = ctx.doc.addLight({
          name: p.name ?? label,
          type: p.type as LightType,
          ...(p.energy !== undefined ? { energy: p.energy } : {}),
          ...(p.color ? { color: p.color as Vec3 } : {}),
        });
        const id = addObjectAndSelect(ctx, { type: 'LIGHT', name: p.name ?? label, data, ...placeObject(ctx, p) });
        return { object: id };
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
        if (action === 'SELECT') setSelection(ctx, all, ctx.state.activeId && all.includes(ctx.state.activeId) ? ctx.state.activeId : all[0] ?? null);
        else if (action === 'DESELECT') setSelection(ctx, [], ctx.state.activeId);
        else setSelection(ctx, all.filter((id) => !sel.has(id)), ctx.state.activeId);
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.select',
      label: 'Select Objects',
      description: 'Select objects by id or name. With extend=false the previous selection is replaced. The last one becomes active unless `active` is given.',
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
        const active = p.active ? (ctx.doc.resolveObject(p.active)?.id ?? null) : given[given.length - 1] ?? ctx.state.activeId;
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
      schema: z.object({ type: z.enum(['MESH', 'EMPTY', 'CAMERA', 'LIGHT']), extend: z.boolean().default(false) }),
      poll: pollObjectMode,
      execute(ctx, p) {
        const ids = ctx.doc.listObjects().filter((o) => o.type === p.type && !o.hide_viewport).map((o) => o.id);
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
      schema: z.object({ pattern: z.string().default('*'), case_sensitive: z.boolean().default(false), extend: z.boolean().default(true) }),
      execute(ctx, p) {
        const re = new RegExp(
          `^${p.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
          p.case_sensitive ? '' : 'i',
        );
        const ids = ctx.doc.listObjects().filter((o) => re.test(o.name)).map((o) => o.id);
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
        for (const id of ids) ctx.doc.removeObject(id);
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
      description: 'Duplicate selected objects (linked=true shares mesh data like Alt+D). The copies become the selection.',
      category: 'Object',
      redoable: true,
      schema: z.object({ linked: z.boolean().default(false), offset: vec3.default([0, 0, 0]) }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        const sel = selectedObjects(ctx);
        const map = new Map<string, string>();
        for (const o of sel) {
          let data = o.data;
          if (o.data && !p.linked) {
            if (o.type === 'MESH') data = ctx.doc.addMesh(ctx.doc.getMeshBlock(o.data)?.name ?? o.name, ctx.doc.getMeshCopy(o.data)!);
            else if (o.type === 'LIGHT') {
              const { id: _id, ...l } = ctx.doc.getLight(o.data)!;
              data = ctx.doc.addLight(l);
            } else if (o.type === 'CAMERA') {
              const { id: _id, ...c } = ctx.doc.getCamera(o.data)!;
              data = ctx.doc.addCamera(c);
            }
          }
          const { id: _id, ...rest } = o;
          const nid = ctx.doc.addObject({
            ...rest,
            data,
            modifiers: o.modifiers.map((m) => ({ ...m, id: `${m.id}_${Math.random().toString(36).slice(2, 7)}` })),
          });
          map.set(o.id, nid);
        }
        // Re-link parents inside the duplicated set; offset only the roots.
        for (const [src, dst] of map) {
          const o = ctx.doc.getObject(src)!;
          if (o.parent && map.has(o.parent)) ctx.doc.updateObject(dst, { parent: map.get(o.parent)! });
        }
        for (const id of transformRoots(ctx.doc, [...map.values()])) {
          const o = ctx.doc.getObject(id)!;
          if (p.offset.some((v) => v !== 0)) {
            const w = ctx.doc.worldMatrix(id);
            w[12] += p.offset[0];
            w[13] += p.offset[1];
            w[14] += p.offset[2];
            ctx.doc.setWorldMatrix(id, w);
          } else void o;
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
        for (const o of ctx.doc.listObjects()) if (sel.has(o.id) !== p.unselected) ctx.doc.updateObject(o.id, { hide_viewport: true });
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
        description: `Reset the ${field} of the selected objects.`,
        category: 'Object',
        schema: z.object({}),
        poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
        execute(ctx) {
          for (const o of selectedObjects(ctx)) ctx.doc.updateObject(o.id, { [field]: value });
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
      description: "Apply the selected objects' location/rotation/scale to their mesh data (Ctrl+A).",
      category: 'Object',
      redoable: true,
      schema: z.object({ location: z.boolean().default(false), rotation: z.boolean().default(true), scale: z.boolean().default(true) }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        for (const o of selectedObjects(ctx)) {
          const loc: Vec3 = p.location ? [0, 0, 0] : o.location;
          const rot: Vec3 = p.rotation ? [0, 0, 0] : o.rotation_euler;
          const scl: Vec3 = p.scale ? [1, 1, 1] : o.scale;
          const before = compose4(o.location, o.rotation_euler, o.scale);
          const after = compose4(loc, rot, scl);
          const delta = multiply4(invert4(after), before); // vertex' = after⁻¹ · before · vertex
          if (o.type === 'MESH' && o.data) {
            const meshId = singleUserMesh(ctx, o);
            const m = cloneMesh(ctx.doc.getMesh(meshId)!);
            for (let i = 0; i < vertexCount(m); i++) {
              const q = transformPoint3(delta, [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
              m.positions[i * 3] = q[0];
              m.positions[i * 3 + 1] = q[1];
              m.positions[i * 3 + 2] = q[2];
            }
            // Negative scale flips winding: keep normals pointing outward.
            const det = scl[0] * scl[1] * scl[2];
            const det0 = o.scale[0] * o.scale[1] * o.scale[2];
            if (Math.sign(det) !== Math.sign(det0)) {
              m.faces = m.faces.map((f) => f.slice().reverse());
              if (m.uvs) m.uvs = m.uvs.map((uv) => reversePairs(uv));
            }
            ctx.doc.setMesh(meshId, m);
          }
          // children keep their world transform
          const childWorld = new Map(ctx.doc.childrenOf(o.id).map((c) => [c.id, ctx.doc.worldMatrix(c.id)]));
          ctx.doc.updateObject(o.id, { location: loc, rotation_euler: rot, scale: scl });
          for (const [cid, w] of childWorld) ctx.doc.setWorldMatrix(cid, w);
        }
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.origin_set',
      label: 'Set Origin',
      description: 'Move the object origin (ORIGIN_GEOMETRY, ORIGIN_CURSOR) or the geometry (GEOMETRY_ORIGIN) without moving the visual result.',
      category: 'Object',
      schema: z.object({
        type: z.enum(['ORIGIN_GEOMETRY', 'ORIGIN_CURSOR', 'GEOMETRY_ORIGIN']).default('ORIGIN_GEOMETRY'),
        center: z.enum(['MEDIAN', 'BOUNDS']).default('MEDIAN'),
      }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx, p) {
        for (const o of selectedObjects(ctx)) {
          if (o.type !== 'MESH' || !o.data) continue;
          const meshId = singleUserMesh(ctx, o);
          const m = cloneMesh(ctx.doc.getMesh(meshId)!);
          const n = vertexCount(m);
          if (n === 0) continue;
          const world = ctx.doc.worldMatrix(o.id);
          let centerLocal: Vec3;
          if (p.center === 'BOUNDS') {
            const b = meshBounds(m)!;
            centerLocal = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
          } else {
            centerLocal = [0, 0, 0];
            for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) centerLocal[k] += m.positions[i * 3 + k] / n;
          }
          if (p.type === 'GEOMETRY_ORIGIN') {
            for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m.positions[i * 3 + k] -= centerLocal[k];
            ctx.doc.setMesh(meshId, m);
            continue;
          }
          const target: Vec3 = p.type === 'ORIGIN_CURSOR' ? transformPoint3(invert4(world), ctx.state.cursorLocation) : centerLocal;
          for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m.positions[i * 3 + k] -= target[k];
          ctx.doc.setMesh(meshId, m);
          const newOriginWorld = transformPoint3(world, target);
          const childWorld = new Map(ctx.doc.childrenOf(o.id).map((c) => [c.id, ctx.doc.worldMatrix(c.id)]));
          const w = world.slice();
          w[12] = newOriginWorld[0];
          w[13] = newOriginWorld[1];
          w[14] = newOriginWorld[2];
          ctx.doc.setWorldMatrix(o.id, w);
          for (const [cid, cw] of childWorld) ctx.doc.setWorldMatrix(cid, cw);
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
        description: `Set ${smooth ? 'smooth' : 'flat'} shading on all faces of the selected mesh objects.`,
        category: 'Object',
        schema: z.object({}),
        poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
        execute(ctx) {
          const done = new Set<string>();
          for (const o of selectedObjects(ctx)) {
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
      schema: z.object({ angle: z.number().min(0).max(Math.PI).default((30 * Math.PI) / 180) }),
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
      description: 'Parent the selected objects to the active object (keeping their world transform).',
      category: 'Object',
      schema: z.object({ keep_transform: z.boolean().default(true) }),
      poll: (ctx) => {
        if (pollObjectMode(ctx) !== true) return pollObjectMode(ctx);
        return ctx.state.activeId && selectedObjects(ctx).length > 1 ? true : 'Select children and then the parent (active)';
      },
      execute(ctx, p) {
        const parent = ctx.state.activeId!;
        for (const o of selectedObjects(ctx)) {
          if (o.id === parent) continue;
          if (ctx.doc.isAncestor(o.id, parent)) throw new OperatorError('Loop in parents', 'FAILED');
          ctx.doc.setParent(o.id, parent, p.keep_transform);
        }
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.parent_to',
      label: 'Parent To',
      description: 'Set (or clear with parent=null) the parent of objects by id/name.',
      category: 'Object',
      schema: z.object({
        objects: z.array(z.string()).optional(),
        parent: z.string().nullable(),
        keep_transform: z.boolean().default(true),
      }),
      execute(ctx, p) {
        const ids = resolveObjectIds(ctx, p.objects);
        const parent = p.parent ? ctx.doc.resolveObject(p.parent)?.id : null;
        if (p.parent && !parent) throw new OperatorError(`Parent '${p.parent}' not found`, 'NOT_FOUND');
        for (const id of ids) if (id !== parent) ctx.doc.setParent(id, parent ?? null, p.keep_transform);
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
        for (const o of selectedObjects(ctx)) if (o.parent) ctx.doc.setParent(o.id, null, p.type === 'CLEAR_KEEP_TRANSFORM');
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
        return selectedObjects(ctx).filter((o) => o.type === 'MESH').length > 1 ? true : 'Select at least two meshes';
      },
      execute(ctx) {
        const active = activeObject(ctx)!;
        const activeMeshId = singleUserMesh(ctx, active);
        const out = cloneMesh(ctx.doc.getMesh(activeMeshId)!);
        const inv = invert4(ctx.doc.worldMatrix(active.id));
        const slots = [...active.material_slots];
        for (const o of selectedObjects(ctx)) {
          if (o.id === active.id || o.type !== 'MESH' || !o.data) continue;
          const src = ctx.doc.getMesh(o.data);
          if (!src) continue;
          const toActive: Mat4 = multiply4(inv, ctx.doc.worldMatrix(o.id));
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
          ctx.doc.removeObject(o.id);
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
      description: 'Apply all modifiers of the selected mesh objects (bake the evaluated mesh).',
      category: 'Object',
      schema: z.object({ target: z.enum(['MESH']).default('MESH') }),
      poll: (ctx) => (pollObjectMode(ctx) === true ? pollHasSelection(ctx) : pollObjectMode(ctx)),
      execute(ctx) {
        const ev = new SceneEvaluator(ctx.doc).evaluate(ctx.state.frame);
        for (const o of selectedObjects(ctx)) {
          if (o.type !== 'MESH' || !o.data || o.modifiers.length === 0) continue;
          const mesh = ev.byId.get(o.id)?.mesh;
          if (!mesh) continue;
          const meshId = singleUserMesh(ctx, o);
          ctx.doc.setMesh(meshId, cloneMesh(mesh));
          ctx.doc.updateObject(o.id, { modifiers: [] });
        }
      },
    }),
  );

  // ------------------------------------------------------------------ mode
  reg.register(
    defineOperator({
      id: 'object.mode_set',
      label: 'Set Object Mode',
      description: 'Switch interaction mode (OBJECT, EDIT, SCULPT, VERTEX_PAINT). toggle=true switches back to OBJECT if already in the mode.',
      category: 'Object',
      undo: false,
      schema: z.object({ mode: z.enum(['OBJECT', 'EDIT', 'SCULPT', 'VERTEX_PAINT']).default('OBJECT'), toggle: z.boolean().default(false) }),
      execute(ctx, p) {
        let mode = p.mode;
        if (p.toggle && ctx.state.mode === mode) mode = 'OBJECT';
        if (mode === 'OBJECT') {
          ctx.state.mode = 'OBJECT';
          return;
        }
        const a = activeObject(ctx);
        if (!a || a.type !== 'MESH') throw new OperatorError(`${mode} mode requires an active mesh object`, 'POLL_FAILED');
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
      description: 'Rename an object (names are kept unique, Blender style).',
      category: 'Object',
      schema: z.object({ object: z.string().optional(), name: z.string().min(1) }),
      execute(ctx, p) {
        const id = p.object ? ctx.doc.resolveObject(p.object)?.id : ctx.state.activeId;
        if (!id) throw new OperatorError('No object to rename', 'NOT_FOUND');
        return { name: ctx.doc.rename('objects', id, p.name) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.move_to_collection',
      label: 'Move to Collection',
      description: 'Move selected objects to a collection (id or name). Use new_collection_name to create one.',
      category: 'Object',
      schema: z.object({ collection: z.string().default(ROOT_COLLECTION_ID), new_collection_name: z.string().optional() }),
      poll: pollHasSelection,
      execute(ctx, p) {
        let cid = p.collection;
        if (p.new_collection_name) cid = ctx.doc.addCollection({ name: p.new_collection_name, parent: p.collection || ROOT_COLLECTION_ID });
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
      schema: z.object({ name: z.string().default('Collection'), parent: z.string().default(ROOT_COLLECTION_ID) }),
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
