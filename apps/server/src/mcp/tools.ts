import { z } from 'zod';
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import {
  base64Decode,
  base64Encode,
  detectFormat,
  enterEditMode,
  exportScene,
  importFile,
  selectAllElements,
  selectionFromEdges,
  selectionFromFaces,
  selectionFromVerts,
  edgeKey,
  emptySelection,
  meshStats,
  isAnimatable,
  propertyLength,
  readChannel,
  type ExportFormat,
  type ImportFormat,
  type MeshSelection,
  type ObjectData,
  type OperatorInfo,
  type OperatorRegistry,
  type RunResult,
  type SelectMode,
  type Vec3,
} from '@3d-editor/core';
import type { ServerConfig } from '../config';
import type { ServerMetrics } from '../observability/metrics';
import type { Log } from '../observability/log';
import { errorMessage, withSpan } from '../observability/tracing';
import type { RoomManager } from '../sync/room-manager';
import { RpcError } from '../sync/room';
import { isNotImplemented, safeFileName } from '../api/projects';
import { persistenceNote } from '../persistence';
import { ToolError, type AgentProject, type AgentSession } from './agent';
import {
  DEFAULT_MAX_OBJECTS,
  describeObject,
  round,
  roundVec,
  sceneSettingsAt,
  summarizeScene,
} from './scene-summary';
import {
  addModifier,
  applyModifier,
  findModifierType,
  modifierParamsSchema,
  modifierTypes,
  removeModifier,
  requireModifier,
  updateModifier,
} from './modifiers';
import { MAX_IMPORT_BYTES, fetchLimited } from './fetch-limited';
import { DEFAULT_MESH_PAGE, MAX_HEIGHTMAP, MAX_MESH_PAGE, MESH_DATA_FIELDS, meshData } from './mesh-data';
import {
  keyTargetData,
  keyframeTarget,
  missingPathReason,
  notAnimatable,
  unsetProceduralParam,
} from './keyframes';
import { findOperatorGroup, operatorGroupNames, toolOnlyOperator } from './operator-groups';
import { strictArgObject, strictToolSchema } from './strict-args';
import type { AnimationOutput, FrameOptions, Renderer } from '../render';
import type { RenderStore, StoredFile } from '../render/store';
import {
  DEFAULT_ANIMATION_TIME_LIMIT,
  DEFAULT_IMAGE_TIME_LIMIT,
  MAX_ANIMATION_SIZE,
  MAX_RENDER_FRAMES,
  MAX_TIME_LIMIT,
  animationFrameSize,
  denoiseArg,
  engineArg,
  maxBouncesArg,
  progressReporter,
  renderToolError,
  samplesArg,
  seedArg,
} from './rendering';

export interface ToolContext {
  agent: AgentSession;
  rooms: RoomManager;
  registry: OperatorRegistry;
  config: ServerConfig;
  metrics: ServerMetrics;
  log: Log;
  /** Server-side renderer (render threads). */
  renderer: Renderer;
  /** Stored render results (render_animation `store`). */
  renderStore: RenderStore;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolOutput = CallToolResult | Record<string, unknown> | unknown[];

const DEG2RAD = Math.PI / 180;
const MAX_RENDER_SIZE = 2048;
const MAX_EMBEDDED_EXPORT_BYTES = 20 * 1024 * 1024;

// ------------------------------------------------------------------ shared schemas

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const color = z.union([vec3, vec4]).describe('Linear RGB or RGBA, components 0..1');
const projectArg = z.string().min(1).describe('Project id or exact project name (see list_projects)');
const objectArg = z.string().min(1).describe('Object id or exact object name');
const objectList = z.array(z.string().min(1)).min(1).describe('Object ids or exact names');
const selectModeEnum = z.enum(['VERT', 'EDGE', 'FACE']);
const meshSelectionShape = {
  verts: z.array(z.number().int().min(0)).optional().describe('Vertex indices'),
  edges: z
    .array(z.tuple([z.number().int().min(0), z.number().int().min(0)]))
    .optional()
    .describe('Edges as [vertexA, vertexB] pairs'),
  faces: z.array(z.number().int().min(0)).optional().describe('Face indices'),
  all: z
    .boolean()
    .optional()
    .describe('Select everything (true) or nothing (false) before applying the lists'),
};
// nested argument objects are closed like the tools' arguments (see strict-args.ts)
const meshSelectionSchema = strictArgObject(meshSelectionShape).describe('Edit-mode element selection');

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const EDIT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const ADD_OPERATORS: Record<string, string> = {
  cube: 'mesh.primitive_cube_add',
  plane: 'mesh.primitive_plane_add',
  grid: 'mesh.primitive_grid_add',
  circle: 'mesh.primitive_circle_add',
  uv_sphere: 'mesh.primitive_uv_sphere_add',
  ico_sphere: 'mesh.primitive_ico_sphere_add',
  cylinder: 'mesh.primitive_cylinder_add',
  cone: 'mesh.primitive_cone_add',
  torus: 'mesh.primitive_torus_add',
  empty: 'object.empty_add',
  camera: 'object.camera_add',
  light: 'object.light_add',
  bezier_curve: 'curve.primitive_bezier_curve_add',
  bezier_circle: 'curve.primitive_bezier_circle_add',
  nurbs_path: 'curve.primitive_nurbs_path_add',
  text: 'object.text_add',
  armature: 'object.armature_add',
};

// ------------------------------------------------------------------ helpers

function text(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

function failure(message: string, details?: unknown): CallToolResult {
  const body = details === undefined ? message : `${message}\n${JSON.stringify(details, null, 2)}`;
  return { content: [{ type: 'text', text: body }], isError: true };
}

function isCallToolResult(v: unknown): v is CallToolResult {
  return typeof v === 'object' && v !== null && Array.isArray((v as { content?: unknown }).content);
}

/** Origin of the MCP request (used for editor/download links). */
function baseUrl(extra: ToolExtra): string {
  const url = extra.requestInfo?.url;
  if (url) return url.origin;
  const host = extra.requestInfo?.headers?.host;
  return typeof host === 'string' ? `http://${host}` : '';
}

function editorUrl(extra: ToolExtra, projectId: string): string {
  return `${baseUrl(extra)}/?project=${encodeURIComponent(projectId)}`;
}

function radians(rotation?: number[], degrees?: number[]): Vec3 | undefined {
  if (rotation && degrees)
    throw new ToolError('Pass either rotation (radians) or rotation_degrees, not both.');
  if (degrees) return degrees.map((d) => d * DEG2RAD) as Vec3;
  return rotation as Vec3 | undefined;
}

function objectNames(p: AgentProject, max = 40): string {
  const names = p.scene.listObjects().map((o) => o.name);
  return names.length > max
    ? `${names.slice(0, max).join(', ')}, ... (${names.length} total)`
    : names.join(', ');
}

function requireObject(p: AgentProject, ref: string): ObjectData {
  const o = p.scene.resolveObject(ref);
  if (!o) {
    const names = objectNames(p);
    throw new ToolError(
      `Object '${ref}' not found in project '${p.scene.name}'.${names ? ` Objects: ${names}.` : ' The scene is empty.'}`,
    );
  }
  return o;
}

function brief(p: AgentProject, id: string) {
  const o = p.scene.getObject(id);
  if (!o) return { id, deleted: true };
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    location: roundVec([...o.location]),
    rotation_euler: roundVec([...o.rotation_euler]),
    scale: roundVec([...o.scale]),
    parent: o.parent ? (p.scene.getObject(o.parent)?.name ?? o.parent) : null,
  };
}

function selectionSummary(p: AgentProject) {
  const s = p.state;
  const name = (id: string) => p.scene.getObject(id)?.name;
  const out: Record<string, unknown> = {
    mode: s.mode,
    selected: s.selectedIds.map(name).filter(Boolean),
    active: s.activeId ? (name(s.activeId) ?? null) : null,
    frame: s.frame,
  };
  if (s.mode === 'EDIT') {
    out.mesh = {
      select_mode: s.selectMode,
      verts: s.meshSelection.verts.size,
      edges: s.meshSelection.edges.size,
      faces: s.meshSelection.faces.size,
    };
  }
  return out;
}

function meshSelection(
  p: AgentProject,
  objectId: string,
  sel: z.infer<typeof meshSelectionSchema> | undefined,
  mode: SelectMode,
): MeshSelection {
  const o = p.scene.getObject(objectId);
  const mesh = o?.data ? p.scene.getMesh(o.data) : null;
  if (!mesh) throw new ToolError('object has no mesh data');
  if (!sel) return selectAllElements(mesh);
  const hasLists = !!(sel.verts?.length || sel.edges?.length || sel.faces?.length);
  if (!hasLists) return sel.all === false ? emptySelection() : selectAllElements(mesh);
  const nv = mesh.positions.length / 3;
  for (const v of sel.verts ?? [])
    if (v >= nv) throw new ToolError(`vertex index ${v} out of range (mesh has ${nv} vertices)`);
  for (const f of sel.faces ?? [])
    if (f >= mesh.faces.length)
      throw new ToolError(`face index ${f} out of range (mesh has ${mesh.faces.length} faces)`);
  if (mode === 'FACE') return selectionFromFaces(mesh, sel.faces ?? []);
  if (mode === 'EDGE')
    return selectionFromEdges(
      mesh,
      (sel.edges ?? []).map(([a, b]) => edgeKey(a, b)),
    );
  const verts = new Set(sel.verts ?? []);
  for (const [a, b] of sel.edges ?? []) {
    verts.add(a);
    verts.add(b);
  }
  for (const f of sel.faces ?? []) for (const v of mesh.faces[f]) verts.add(v);
  return selectionFromVerts(mesh, verts);
}

function inferSelectMode(
  sel: z.infer<typeof meshSelectionSchema> | undefined,
  explicit?: SelectMode,
): SelectMode {
  if (explicit) return explicit;
  if (sel?.faces?.length && !sel.verts?.length && !sel.edges?.length) return 'FACE';
  if (sel?.edges?.length && !sel.verts?.length && !sel.faces?.length) return 'EDGE';
  return 'VERT';
}

/** Kind of an operator failure (see core OperatorError); failures that are not OperatorErrors are FAILED. */
type OperatorErrorCode = NonNullable<RunResult['code']>;

function errorCode(res: RunResult): OperatorErrorCode {
  return res.code ?? 'FAILED';
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Closest operator ids to a (mistyped) id. */
function suggestOperators(registry: OperatorRegistry, id: string): string {
  const needle = id.toLowerCase();
  const tail = needle.split('.').pop() ?? needle;
  const scored = registry
    .list()
    .filter((d) => !d.uiOnly)
    .map((d) => {
      const cand = d.id.toLowerCase();
      let score = editDistance(needle, cand);
      if (tail.length > 2 && cand.includes(tail)) score -= 3;
      return { id: d.id, score };
    })
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .filter((x) => x.score <= Math.max(4, Math.ceil(needle.length / 2)))
    .slice(0, 8)
    .map((x) => x.id);
  return scored.length ? ` Did you mean: ${scored.join(', ')}?` : '';
}

const describeCache = new WeakMap<OperatorRegistry, OperatorInfo[]>();
function operatorCatalogue(registry: OperatorRegistry): OperatorInfo[] {
  let list = describeCache.get(registry);
  if (!list) {
    list = registry.describe();
    describeCache.set(registry, list);
  }
  return list;
}

/**
 * Decodes the answer of a browser editor to the `render` RPC (and the `ui` `screenshot` command).
 * Request params: `{ width, height, camera: objectId | null, view: { position, target, up?,
 * fov_degrees? } | null, shading: 'SOLID' | 'MATERIAL' | null, frame }`. Accepted results: a
 * `data:image/png;base64,...` URL, raw base64, or an object `{ data_base64 | png_base64 | dataUrl |
 * image | data, mime | mimeType?, width?, height? }`.
 */
function decodeRenderResult(
  r: unknown,
): { data: string; mimeType: string; width?: number; height?: number } | null {
  const fromDataUrl = (s: string) => {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(s);
    if (m)
      return { data: m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString('base64'), mimeType: m[1] };
    return /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 16
      ? { data: s.replace(/\s+/g, ''), mimeType: 'image/png' }
      : null;
  };
  if (typeof r === 'string') return fromDataUrl(r);
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  const raw = o.data_base64 ?? o.png_base64 ?? o.base64 ?? o.dataUrl ?? o.data_url ?? o.image ?? o.data;
  if (typeof raw !== 'string') return null;
  const decoded = fromDataUrl(raw);
  if (!decoded) return null;
  const mime =
    typeof o.mime === 'string' ? o.mime : typeof o.mimeType === 'string' ? o.mimeType : decoded.mimeType;
  return {
    data: decoded.data,
    mimeType: mime,
    width: typeof o.width === 'number' ? o.width : undefined,
    height: typeof o.height === 'number' ? o.height : undefined,
  };
}

// ------------------------------------------------------------------ registration

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { agent, rooms, registry, metrics, log, renderer, renderStore } = ctx;

  /**
   * Registers a tool. Its arguments are strict: unknown or misspelled argument names (also inside
   * nested argument objects) fail the call with suggestions and the valid names, and the input
   * schema in tools/list is closed. `argsHint` is added to that error when an unknown argument is
   * not a typo of a valid one (e.g. that operator parameters belong in `params`).
   */
  function tool<S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; annotations?: ToolAnnotations; argsHint?: string },
    shape: S,
    handler: (args: z.output<z.ZodObject<S>>, extra: ToolExtra) => Promise<ToolOutput> | ToolOutput,
  ): void {
    const cb = async (args: z.output<z.ZodObject<S>>, extra: ToolExtra): Promise<CallToolResult> => {
      const end = metrics.mcpToolDuration.startTimer({ tool: name });
      const projectRef = (args as { project?: unknown }).project;
      try {
        const result = await withSpan(
          `mcp.tool ${name}`,
          {
            'mcp.tool': name,
            'mcp.session': agent.id,
            ...(typeof projectRef === 'string' ? { 'project.ref': projectRef } : {}),
          },
          async (span) => {
            const out = await handler(args, extra);
            const r = isCallToolResult(out) ? out : text(out);
            if (r.isError) span.setAttribute('mcp.tool.error', true);
            return r;
          },
        );
        metrics.mcpToolCalls.inc({ tool: name, status: result.isError ? 'error' : 'ok' });
        return result;
      } catch (err) {
        metrics.mcpToolCalls.inc({ tool: name, status: 'error' });
        if (err instanceof ToolError) return failure(err.message);
        log.warn({ err: errorMessage(err), tool: name, session: agent.id }, 'MCP tool failed');
        return failure(`${name} failed: ${errorMessage(err)}`);
      } finally {
        end();
      }
    };
    const inputSchema = strictToolSchema(shape, { tool: name, hint: meta.argsHint });
    server.registerTool<z.ZodRawShape, typeof inputSchema>(
      name,
      { title: meta.title, description: meta.description, inputSchema, annotations: meta.annotations },
      cb as unknown as ToolCallback<typeof inputSchema>,
    );
  }

  // ---------------------------------------------------------------- projects

  tool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List all projects on this server (persisted and currently open) with id, name, timestamps, statistics (objects, vertices, faces) and the number of connected editors (peers).',
      annotations: READ_ONLY,
    },
    {},
    async (_args, extra) => {
      const projects = await rooms.listProjects();
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          created_at: p.created_at,
          updated_at: p.updated_at,
          stats: p.stats,
          peers: p.peers,
          loaded: p.live,
          editor_url: editorUrl(extra, p.id),
        })),
      };
    },
  );

  tool(
    'create_project',
    {
      title: 'Create project',
      description:
        "Create a new project. By default it contains Blender's startup scene (a 2 m cube named 'Cube' with 'Material', a 'Camera' and a point 'Light'); pass empty=true for an empty scene. Returns the project id and the URL that opens it in the editor.",
      annotations: EDIT,
    },
    {
      name: z.string().trim().min(1).max(200).describe('Project name'),
      empty: z.boolean().default(false).describe('Start with an empty scene'),
    },
    async ({ name, empty }, extra) => {
      const room = await rooms.createProject({ name, empty });
      const p = await agent.project(room.id);
      return {
        id: room.id,
        name: room.scene.name,
        editor_url: editorUrl(extra, room.id),
        objects: p.scene.listObjects().map((o) => ({ id: o.id, name: o.name, type: o.type })),
      };
    },
  );

  tool(
    'get_project',
    {
      title: 'Get project',
      description:
        "Project details: name, timestamps, statistics, connected editors and agents, editor URL, and the server's persistence: `persistence` disk | webdav (saved, survives restarts) or memory (lost when the server stops) with an explanation.",
      annotations: READ_ONLY,
    },
    { project: projectArg },
    async ({ project }, extra) => {
      const p = await agent.project(project);
      const listing = p.room.listing();
      const persistence = rooms.persistence;
      return {
        ...listing,
        persistence: persistence.mode,
        persistence_note: persistenceNote(persistence.mode),
        ...(persistence.mode === 'memory' ? {} : { stored_at: persistence.location }),
        editor_url: editorUrl(extra, p.id),
        clients: p.room.presence().map((e) => ({ name: e.state.user?.name ?? 'unknown', kind: e.kind })),
      };
    },
  );

  tool(
    'rename_project',
    {
      title: 'Rename project',
      description: 'Rename a project (stored in the document, synced to all editors).',
      annotations: EDIT,
    },
    { project: projectArg, name: z.string().trim().min(1).max(200) },
    async ({ project, name }) => {
      const p = await agent.project(project);
      p.transact(() => p.scene.setName(name));
      return { id: p.id, name: p.scene.name };
    },
  );

  tool(
    'delete_project',
    {
      title: 'Delete project',
      description:
        'Permanently delete a project: disconnects every open editor and deletes its stored files. This cannot be undone. Requires confirm=true.',
      annotations: DESTRUCTIVE,
    },
    { project: projectArg, confirm: z.literal(true).describe('Must be true to confirm the deletion') },
    async ({ project }) => {
      const id = await agent.resolveProjectId(project);
      agent.forget(id);
      const deleted = await rooms.deleteProject(id);
      if (!deleted) throw new ToolError(`Project '${project}' not found.`);
      // like DELETE /api/projects/:id: its stored renders are no longer downloadable
      renderStore.forgetProject(id);
      return { deleted: id };
    },
  );

  // ---------------------------------------------------------------- inspection

  tool(
    'get_scene',
    {
      title: 'Get scene',
      description:
        "Describe the whole scene at a frame. Values are the EVALUATED ones at that frame, like Blender's properties: keyframed, driven and F-curve-modified location / rotation_euler (radians, also in degrees) / scale, shape key values, constraint influences, pose channels, light / camera / curve / world settings; where animation overrides the value stored in the document (what transform_object or the *.properties_set operators change), the stored value is listed too (`stored`, `stored_value`, `stored_influence`). Contents: counts (objects by type; vertices / faces = BASE mesh data of mesh objects before modifiers, curves and text not included; evaluated {vertices, faces, triangles} = the geometry renders show: after shape keys, modifiers with their RENDER settings (SUBSURF render_levels, SCREW render_steps, show_render), curve bevels (render_resolution_u) and text, instances not included; evaluated_viewport = the same with the viewport settings, only listed when the viewport shows other geometry; instances and instance_triangles = particle / collection instances of renders, viewport_instances when the viewport shows fewer), every object (id, name, type, parent, collection, transform, world-space bounds of the render geometry after modifiers, armature deformation, constraints and physics (wire curves: of their wire), data summary: mesh vertex/face counts (base, evaluated = render, evaluated_viewport when it differs) with shape keys and vertex groups, curve splines/points/fill_mode/bevel/extrude, text body, armature bones with parents and pose_position, light (datablock name, type, energy, colour, size/shape, spot), camera (lens, clipping, dof_use); material slots, modifiers with their object references, constraints (type, targets, influence, errors), particle systems (count, instanced object/collection, instances), rigid body (type, shape, mass), animated channels, drivers (path + expression) and evaluation problems), materials (with procedural textures), collections, scene/render/world settings (rigid body world, sky, mist) and the active camera. `problems` lists evaluation errors (drivers, constraints, modifiers, poses, curves, instancing, physics) with object names so you can fix them. Long lists are truncated with *_total counts; use get_object for everything about one object and get_mesh_data for vertex positions. Evaluations are cached per document state and frame, so repeated get_scene / get_object calls (e.g. checking motion at many frames) are cheap until the scene changes. Units: meters, Z up.",
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      frame: z.number().optional().describe('Frame to evaluate (default: the agent current frame)'),
      max_objects: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe(`Objects listed at most (default ${DEFAULT_MAX_OBJECTS}; counts always cover all)`),
    },
    async ({ project, frame, max_objects }) => {
      const p = await agent.project(project);
      return summarizeScene(p.scene, {
        frame: frame ?? p.state.frame,
        projectId: p.id,
        maxObjects: max_objects,
      });
    },
  );

  tool(
    'get_object',
    {
      title: 'Get object',
      description:
        'Detailed description of one object at a frame, with the EVALUATED values at that frame (keyframes, drivers, F-curve modifiers applied; `stored` / `stored_value` / `stored_influence` / `stored_params` give the document values where animation overrides them): local transform, world_location and world_transform (the final world location / rotation / scale after parents, constraints and physics), world bounds of the render geometry (wire curves: their wire), parent (and parent bone) and children, data (mesh statistics base and evaluated = what renders show (render settings of the modifiers: SUBSURF render_levels, SCREW render_steps, show_render), plus evaluated_viewport when the viewport shows other geometry; shape keys with values, vertex groups with assigned vertex counts; every curve shape setting (fill_mode, bevel_mode/depth/resolution/object, bevel_factor, extrude, offset, use_fill_caps, twist_mode, resolution_u, render_resolution_u, path settings) and the spline points; text body and layout; armature bones with rest head/tail and posed world positions, pose channels and bone constraints; light / camera datablock name and id with every setting incl. depth of field), full material properties per slot, modifier stack with parameters, constraints with parameters and errors, particle systems with settings and instance counts, rigid body settings, drivers with variables, animation curves (keyframes, extrapolation, F-curve modifiers, including the object data), custom properties, visibility and evaluation problems. Vertex positions and faces: get_mesh_data. Evaluations are cached per document state and frame: checking many objects or frames is cheap.',
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      object: objectArg,
      frame: z.number().optional().describe("Frame to evaluate (default: the agent's current frame)"),
    },
    async ({ project, object, frame }) => {
      const p = await agent.project(project);
      return describeObject(p.scene, requireObject(p, object), frame ?? p.state.frame);
    },
  );

  tool(
    'get_mesh_data',
    {
      title: 'Get mesh data',
      description: `Read the geometry of a mesh, curve or text object, in pages: vertex positions (meters), vertex normals, faces (vertex index loops, counter-clockwise seen from the front), per-face material indices (with the material_slots they refer to), smooth flags, face normals and centers, UVs, loose edges, vertex group weights (source BASE), and a world-space heightmap of the surface (highest Z on an XY grid — for placing things on terrain). source BASE (default for meshes) is the stored mesh, whose indices edit_mesh selections, vertex groups and shape keys use; EVALUATED is the geometry after shape keys and modifiers at the frame (curves and text: their generated surface), RENDER the same with render settings (subdivision render_levels …). space LOCAL (object space, default) or WORLD. include picks the fields (default vertices, faces, face_materials). At most \`limit\` vertices and faces per call (default ${DEFAULT_MESH_PAGE}, max ${MAX_MESH_PAGE}); when more remain the result has truncated: true and next {vertex_offset, face_offset} to pass for the next page. totals gives the full counts. Compact JSON.`,
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      object: objectArg,
      include: z
        .array(z.enum(MESH_DATA_FIELDS))
        .optional()
        .describe('Fields to return (default ["vertices", "faces", "face_materials"])'),
      source: z
        .enum(['BASE', 'EVALUATED', 'RENDER'])
        .optional()
        .describe(
          'BASE: stored mesh (default for meshes); EVALUATED: after shape keys and modifiers (default for curves and text); RENDER: evaluated with render settings',
        ),
      space: z
        .enum(['LOCAL', 'WORLD'])
        .default('LOCAL')
        .describe('Coordinates of positions, normals and centers'),
      vertex_offset: z.number().int().min(0).default(0).describe('First vertex of the page'),
      face_offset: z.number().int().min(0).default(0).describe('First face of the page'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_MESH_PAGE)
        .default(DEFAULT_MESH_PAGE)
        .describe('Vertices and faces per page'),
      frame: z
        .number()
        .optional()
        .describe("Frame for evaluated / world data (default: the agent's current frame)"),
      decimals: z.number().int().min(0).max(6).default(4).describe('Rounding of coordinates'),
      heightmap_resolution: z
        .number()
        .int()
        .min(8)
        .max(MAX_HEIGHTMAP)
        .default(64)
        .describe('Heightmap samples along the longer side of the object (include "heightmap")'),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const o = requireObject(p, a.object);
      const out = meshData(p.scene, o, {
        source: a.source,
        space: a.space,
        include: a.include,
        vertex_offset: a.vertex_offset,
        face_offset: a.face_offset,
        limit: a.limit,
        frame: a.frame ?? p.state.frame,
        decimals: a.decimals,
        heightmap_resolution: a.heightmap_resolution,
      });
      // compact JSON: geometry lists are long
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  );

  tool(
    'list_operators',
    {
      title: 'List operators',
      description: `The operator catalogue (Blender-style ids such as mesh.primitive_cube_add, transform.rotate, mesh.extrude_region_move, curve.primitive_bezier_curve_add, object.constraint_add, armature.chain_add, rigidbody.object_add, anim.driver_add) with descriptions and JSON-schema parameters. Filter by \`category\`: a registry category (e.g. Add, Object, Transform, Mesh, Curve, Text, Armature, Pose, Physics, Layout, Scene, World, Material, Animation, Render, Data, Snap, Select) or a feature group: ${operatorGroupNames().join(', ')}; and/or a search string. Without filters a compact list is returned; filters (up to 60 results) or include_parameters=true give parameter schemas.`,
      annotations: READ_ONLY,
    },
    {
      category: z
        .string()
        .optional()
        .describe(
          'Registry category or feature group (case-insensitive), e.g. "Constraints", "Rigging", "Physics"',
        ),
      search: z
        .string()
        .optional()
        .describe('Case-insensitive text matched against id, label and description'),
      include_parameters: z.boolean().optional(),
    },
    async ({ category, search, include_parameters }) => {
      // operators replaced by tools (renders) are not listed: run_operator refuses them
      let list = operatorCatalogue(registry).filter(
        (o) => !registry.get(o.id)?.uiOnly && !toolOnlyOperator(o.id),
      );
      const categories = [...new Set(list.map((o) => o.category))].sort();
      let group: ReturnType<typeof findOperatorGroup> = null;
      if (category) {
        const c = category.trim().toLowerCase();
        group = findOperatorGroup(c);
        const g = group;
        // a registry category and a feature group of the same name (Text, Curve(s) …): both
        const matching = list.filter((o) => o.category.toLowerCase() === c || !!g?.match(o.id));
        if (!matching.length && !group)
          throw new ToolError(
            `Unknown category '${category}'. Categories: ${categories.join(', ')}. Feature groups: ${operatorGroupNames().join(', ')}.`,
          );
        list = matching;
      }
      if (search) {
        const s = search.toLowerCase();
        list = list.filter((o) => `${o.id} ${o.label} ${o.description}`.toLowerCase().includes(s));
      }
      const detailed = include_parameters ?? (!!(category || search) && list.length <= 60);
      return {
        count: list.length,
        ...(group
          ? {
              group: {
                name: group.name,
                description: group.description,
                ...(group.tools ? { tools: group.tools } : {}),
              },
            }
          : {}),
        categories,
        groups: operatorGroupNames(),
        modifier_types: modifierTypes().map((m) => m.type),
        modifier_parameters: 'list_modifier_types {type} gives the parameter schema of a modifier type',
        operators: list.map((o) =>
          detailed
            ? {
                id: o.id,
                label: o.label,
                category: o.category,
                description: o.description,
                parameters: o.parameters,
              }
            : { id: o.id, category: o.category, description: o.description },
        ),
        ...(detailed
          ? {}
          : { hint: 'Pass category, search or include_parameters=true to get parameter schemas.' }),
      };
    },
  );

  // ---------------------------------------------------------------- generic operator execution

  const selectionSchema = strictArgObject({
    objects: z
      .array(z.string())
      .optional()
      .describe('Objects to select (ids or names); replaces the selection'),
    active: z.string().optional().describe('Active object (id or name); defaults to the last selected'),
    mode: z.enum(['OBJECT', 'EDIT']).optional().describe('Interaction mode; EDIT edits the active mesh'),
    mesh: strictArgObject({ ...meshSelectionShape, select_mode: selectModeEnum.optional() })
      .optional()
      .describe('Edit-mode element selection of the active mesh (with mode EDIT)'),
  }).describe("Selection/mode to set before running (persists for the agent's next calls)");

  function applySelection(p: AgentProject, sel: z.infer<typeof selectionSchema> | undefined): void {
    if (!sel) return;
    const state = p.state;
    if (sel.objects) {
      const ids = sel.objects.map((r) => requireObject(p, r).id);
      state.selectedIds = [...new Set(ids)];
      state.activeId = sel.active ? requireObject(p, sel.active).id : (ids[ids.length - 1] ?? null);
    } else if (sel.active) {
      const id = requireObject(p, sel.active).id;
      state.activeId = id;
      if (!state.selectedIds.includes(id)) state.selectedIds = [...state.selectedIds, id];
    }
    if (sel.mode === 'OBJECT') state.mode = 'OBJECT';
    if (sel.mode === 'EDIT' || (sel.mesh && state.mode === 'EDIT')) {
      const active = state.activeId ? p.scene.getObject(state.activeId) : null;
      if (!active || active.type !== 'MESH')
        throw new ToolError('Edit mode needs an active mesh object (selection.active).');
      if (state.mode !== 'EDIT' || sel.mode === 'EDIT') enterEditMode(p.context(), active.id);
      if (sel.mesh) {
        const mode = inferSelectMode(sel.mesh, sel.mesh.select_mode);
        state.selectMode = mode;
        state.meshSelection = meshSelection(p, active.id, sel.mesh, mode);
      }
    }
  }

  tool(
    'run_operator',
    {
      title: 'Run operator',
      description:
        "Execute any operator by id with JSON parameters (see list_operators), as one undo step. Operators act on the agent's own selection like in Blender: use `selection` to choose objects, the active object and the mode (EDIT + mesh element selection for mesh.* operators) before running. Returns {ok, operator, result, reports, duration_ms, selection}. A failure is an error result whose first line is the message, followed by that JSON with `error` and `code`: INVALID_PARAMS (unknown, misspelled or invalid parameters: fix params), POLL_FAILED (wrong mode, selection or object type, or not available here: change the selection/mode), NOT_FOUND (an unknown operator, object or datablock) or FAILED (the operator itself failed).",
      annotations: EDIT,
      argsHint:
        "Operator parameters go inside `params` (run_operator {project, operator, params: {…}, selection}); list_operators {search} gives each operator's parameters.",
    },
    {
      project: projectArg,
      operator: z.string().min(1).describe("Operator id, e.g. 'transform.translate'"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Operator parameters (defaults are applied)'),
      selection: selectionSchema.optional(),
    },
    async ({ project, operator, params, selection }) => {
      const p = await agent.project(project);
      // refusals carry an operator error code like operator failures, so agents can branch on it
      const refuse = (error: string, code: OperatorErrorCode) =>
        failure(error, { ok: false, operator, error, code });
      if (!registry.has(operator))
        return refuse(
          `Unknown operator '${operator}'.${suggestOperators(registry, operator)} Use list_operators.`,
          'NOT_FOUND',
        );
      const def = registry.get(operator)!;
      if (def.uiOnly)
        return refuse(
          `'${operator}' is only available in the browser editor UI (try editor_command).`,
          'POLL_FAILED',
        );
      const refused = toolOnlyOperator(operator);
      if (refused) return refuse(refused, 'FAILED');
      applySelection(p, selection);
      const res = p.run(operator, params ?? {});
      p.publishPresence();
      const out = {
        ok: res.ok,
        operator,
        result: res.result ?? null,
        ...(res.ok ? {} : { error: res.error ?? 'unknown error', code: errorCode(res) }),
        reports: res.reports,
        duration_ms: round(res.durationMs, 2),
        selection: selectionSummary(p),
      };
      if (!res.ok) return failure(`${operator} failed: ${res.error}`, out);
      return out;
    },
  );

  tool(
    'batch',
    {
      title: 'Run several operators',
      description:
        "Run a list of operators in order as a single undo step (one `undo` reverts all of them). With stop_on_error (default true) execution stops at the first failure; changes made before it are kept. Returns per operation {operator, ok, result | error + code, reports} — `code` is INVALID_PARAMS, POLL_FAILED, NOT_FOUND or FAILED as in run_operator; `reports` are the operator's warnings and notes (e.g. 'scaled object: apply the scale'), exactly as run_operator returns them; operations_with_warnings counts operations that reported a WARNING or ERROR.",
      annotations: EDIT,
      argsHint:
        'Each operation is {operator, params} inside `operations` (batch {project, operations: [{operator, params: {…}}, …], stop_on_error}).',
    },
    {
      project: projectArg,
      operations: z
        .array(
          strictArgObject({
            operator: z.string().min(1).describe("Operator id, e.g. 'object.modifier_add'"),
            params: z
              .record(z.string(), z.unknown())
              .optional()
              .describe('Operator parameters (defaults are applied)'),
          }),
        )
        .min(1)
        .max(200)
        .describe('Operations in order: [{operator, params}, …]'),
      stop_on_error: z.boolean().default(true),
    },
    async ({ project, operations, stop_on_error }) => {
      const p = await agent.project(project);
      const results: Record<string, unknown>[] = [];
      let failed = 0;
      p.step(() => {
        for (const op of operations) {
          const known = registry.has(op.operator);
          const refused = known
            ? toolOnlyOperator(op.operator)
            : `unknown operator${suggestOperators(registry, op.operator)}`;
          if (refused) {
            failed++;
            results.push({
              operator: op.operator,
              ok: false,
              error: refused,
              code: known ? 'FAILED' : 'NOT_FOUND',
            });
            if (stop_on_error) break;
            continue;
          }
          const res = p.run(op.operator, op.params ?? {});
          results.push({
            operator: op.operator,
            ok: res.ok,
            ...(res.ok ? { result: res.result ?? null } : { error: res.error, code: errorCode(res) }),
            // warnings and info the operator reported (like run_operator's `reports`)
            ...(res.reports.length ? { reports: res.reports } : {}),
          });
          if (!res.ok) {
            failed++;
            if (stop_on_error) break;
          }
        }
      });
      const warnings = results.filter((r) =>
        (r.reports as { level: string }[] | undefined)?.some(
          (x) => x.level === 'WARNING' || x.level === 'ERROR',
        ),
      ).length;
      const out = {
        ok: failed === 0,
        executed: results.length,
        failed,
        ...(warnings ? { operations_with_warnings: warnings } : {}),
        results,
        selection: selectionSummary(p),
      };
      return failed ? failure(`${failed} of ${operations.length} operation(s) failed`, out) : out;
    },
  );

  // ---------------------------------------------------------------- objects

  tool(
    'add_object',
    {
      title: 'Add object',
      description:
        "Add a primitive or object: cube, plane, grid, circle, uv_sphere, ico_sphere, cylinder, cone, torus (meshes), bezier_curve, bezier_circle, nurbs_path (curves), text, armature, empty, camera or light. Placed at `location` (default: world origin) with optional rotation (radians) or rotation_degrees and scale. Type specific `params` follow Blender's operators (see list_operators for the exact schema: unknown parameters are rejected), e.g. cube {size}, uv_sphere {segments, ring_count, radius}, cylinder {vertices, radius, depth}, torus {major_radius, minor_radius}, curves {radius, bevel_depth, extrude}, text {body, size, extrude, align_x}, armature {bone_name}, camera {lens, clip_end, dof_use, dof_focus_distance, dof_aperture_fstop …}, light {energy (W; W/m² for SUN), color, radius, shape: SQUARE | RECTANGLE | DISK | ELLIPSE, size, size_y, spot_size, spot_blend, shadow_soft_size …} with light_type POINT | SUN | SPOT | AREA. Light and camera data are changed afterwards with run_operator light.properties_set / camera.properties_set {object: name, …the same fields}. Empty {type: PLAIN_AXES|ARROWS|CUBE|SPHERE|...}. Other generators (object.generate_tree, curve.add_from_points …) run through run_operator. The new object becomes selected and active.",
      annotations: EDIT,
      argsHint:
        'Type-specific operator parameters (size, radius, segments, depth, energy, lens, body …) go inside `params`; list_operators gives their names.',
    },
    {
      project: projectArg,
      type: z.enum([
        'cube',
        'plane',
        'grid',
        'circle',
        'uv_sphere',
        'ico_sphere',
        'cylinder',
        'cone',
        'torus',
        'bezier_curve',
        'bezier_circle',
        'nurbs_path',
        'text',
        'armature',
        'empty',
        'camera',
        'light',
      ]),
      name: z.string().min(1).optional(),
      params: z.record(z.string(), z.unknown()).optional().describe('Type specific operator parameters'),
      location: vec3.optional(),
      rotation: vec3.optional().describe('Euler XYZ in radians'),
      rotation_degrees: vec3.optional().describe('Euler XYZ in degrees (alternative to rotation)'),
      scale: vec3.optional(),
      light_type: z.enum(['POINT', 'SUN', 'SPOT', 'AREA']).optional().describe('For type=light'),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const operator = ADD_OPERATORS[a.type];
      const params: Record<string, unknown> = { ...(a.params ?? {}) };
      if (a.name) params.name = a.name;
      if (a.location) params.location = a.location;
      const rot = radians(a.rotation, a.rotation_degrees);
      if (rot) params.rotation = rot;
      if (a.scale) params.scale = a.scale;
      if (a.type === 'light' && a.light_type) params.type = a.light_type;
      p.state.mode = 'OBJECT';
      const res = p.runOrThrow<{ object: string }>(operator, params);
      const id = res.result?.object ?? p.state.activeId;
      return { object: id ? brief(p, id) : null, operator, selection: selectionSummary(p) };
    },
  );

  tool(
    'create_mesh',
    {
      title: 'Create mesh from data',
      description:
        'Create a mesh object from raw geometry (like Blender mesh.from_pydata): vertices [[x,y,z],...] in object space (meters), faces as lists of vertex indices in counter-clockwise order seen from the outside (front), optional loose edges and per-face UVs. Placed at location with optional rotation/scale.',
      annotations: EDIT,
    },
    {
      project: projectArg,
      name: z.string().min(1).default('Mesh'),
      vertices: z.array(vec3).min(1),
      faces: z.array(z.array(z.number().int().min(0)).min(3)).default([]),
      edges: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).default([]),
      uvs: z.array(z.array(z.number())).optional().describe('Per-face flat [u0,v0,u1,v1,...] arrays'),
      smooth: z.boolean().default(false),
      location: vec3.optional(),
      rotation: vec3.optional(),
      rotation_degrees: vec3.optional(),
      scale: vec3.optional(),
    },
    async (a) => {
      const p = await agent.project(a.project);
      p.state.mode = 'OBJECT';
      const res = p.runOrThrow<{ object: string }>('object.add_mesh_from_data', {
        name: a.name,
        vertices: a.vertices,
        faces: a.faces,
        edges: a.edges,
        uvs: a.uvs,
        smooth: a.smooth,
        location: a.location,
        rotation: radians(a.rotation, a.rotation_degrees),
        scale: a.scale,
      });
      const id = res.result?.object ?? p.state.activeId;
      const o = id ? p.scene.getObject(id) : null;
      const mesh = o?.data ? p.scene.getMesh(o.data) : null;
      return { object: id ? brief(p, id) : null, mesh: mesh ? meshStats(mesh) : null };
    },
  );

  tool(
    'transform_object',
    {
      title: 'Transform objects',
      description:
        'Set (or, with relative=true, change) the location (meters), rotation (radians, or rotation_degrees) and scale of one or more objects in their local (parent) space. Relative mode adds location/rotation offsets and multiplies scale. One undo step.',
      annotations: EDIT,
    },
    {
      project: projectArg,
      object: objectArg.optional(),
      objects: objectList.optional(),
      location: vec3.optional(),
      rotation: vec3.optional().describe('Euler XYZ radians'),
      rotation_degrees: vec3.optional(),
      scale: vec3.optional(),
      relative: z.boolean().default(false),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const refs = [...(a.object ? [a.object] : []), ...(a.objects ?? [])];
      if (refs.length === 0) throw new ToolError('Pass object or objects.');
      const ids = [...new Set(refs.map((r) => requireObject(p, r).id))];
      const rot = radians(a.rotation, a.rotation_degrees);
      if (!a.location && !rot && !a.scale)
        throw new ToolError('Nothing to change: pass location, rotation, rotation_degrees or scale.');
      p.step(() => {
        if (!a.relative) {
          p.runOrThrow('object.transform_set', {
            objects: ids,
            location: a.location,
            rotation_euler: rot,
            scale: a.scale,
          });
          return;
        }
        for (const id of ids) {
          const o = p.scene.getObject(id)!;
          p.runOrThrow('object.transform_set', {
            objects: [id],
            location: a.location ? o.location.map((v, i) => v + a.location![i]) : undefined,
            rotation_euler: rot ? o.rotation_euler.map((v, i) => v + rot[i]) : undefined,
            scale: a.scale ? o.scale.map((v, i) => v * a.scale![i]) : undefined,
          });
        }
      });
      return { objects: ids.map((id) => brief(p, id)) };
    },
  );

  tool(
    'delete_objects',
    {
      title: 'Delete objects',
      description:
        'Delete objects (by id or name). Children are kept and re-parented (keeping their world transform).',
      annotations: DESTRUCTIVE,
    },
    { project: projectArg, objects: objectList },
    async ({ project, objects }) => {
      const p = await agent.project(project);
      const ids = objects.map((r) => requireObject(p, r).id);
      p.state.mode = 'OBJECT';
      p.runOrThrow('object.delete', { objects: ids });
      return { deleted: ids.length, remaining: p.scene.objectIds().length };
    },
  );

  tool(
    'duplicate_object',
    {
      title: 'Duplicate object',
      description:
        'Duplicate an object (Shift+D; linked=true shares the mesh data like Alt+D), optionally offset (meters) and renamed. The copy becomes selected and active.',
      annotations: EDIT,
    },
    {
      project: projectArg,
      object: objectArg,
      linked: z.boolean().default(false),
      offset: vec3.optional(),
      name: z.string().min(1).optional(),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const src = requireObject(p, a.object);
      const created = p.step(() => {
        p.state.mode = 'OBJECT';
        p.state.selectedIds = [src.id];
        p.state.activeId = src.id;
        const res = p.runOrThrow<{ objects: string[] }>('object.duplicate', {
          linked: a.linked,
          offset: a.offset ?? [0, 0, 0],
        });
        const ids = res.result?.objects ?? [...p.state.selectedIds];
        if (a.name && ids[0]) p.runOrThrow('object.rename', { object: ids[0], name: a.name });
        return ids;
      });
      return { objects: created.map((id) => brief(p, id)) };
    },
  );

  tool(
    'set_parent',
    {
      title: 'Set parent',
      description:
        'Parent objects to another object (parent=null clears the parent). keep_transform (default true) preserves world transforms.',
      annotations: EDIT,
    },
    {
      project: projectArg,
      object: objectArg.optional(),
      objects: objectList.optional(),
      parent: z.string().nullable().describe('Parent object id/name, or null to clear'),
      keep_transform: z.boolean().default(true),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const refs = [...(a.object ? [a.object] : []), ...(a.objects ?? [])];
      if (!refs.length) throw new ToolError('Pass object or objects.');
      const ids = refs.map((r) => requireObject(p, r).id);
      const parent = a.parent ? requireObject(p, a.parent).id : null;
      p.runOrThrow('object.parent_to', { objects: ids, parent, keep_transform: a.keep_transform });
      return { objects: ids.map((id) => brief(p, id)) };
    },
  );

  tool(
    'set_material',
    {
      title: 'Set material',
      description:
        "Give a mesh, curve or text object a principled (PBR) material in a slot (default 0; curve and text splines choose their slot with material_index): reuse an existing material (`material`), create/update one by `name`, or (without either) edit the slot's material when only this object uses it, otherwise create a new one. Properties: base_color (linear RGB/RGBA 0..1), metallic, roughness, emission_color + emission_strength, alpha, transmission, ior, blend_method. One undo step.",
      annotations: EDIT,
      argsHint:
        'Other material settings (coat_weight, coat_roughness, sheen_weight, use_backface_culling) are set with run_operator material.update {material, …}; procedural textures with material.procedural_set, presets with material.preset_apply.',
    },
    {
      project: projectArg,
      object: objectArg,
      material: z.string().optional().describe('Existing material id or name to assign'),
      name: z.string().min(1).optional().describe('Material name (created if it does not exist)'),
      base_color: color.optional(),
      metallic: z.number().min(0).max(1).optional(),
      roughness: z.number().min(0).max(1).optional(),
      emission_color: vec3.optional(),
      emission_strength: z.number().min(0).optional(),
      alpha: z.number().min(0).max(1).optional(),
      transmission: z.number().min(0).max(1).optional(),
      ior: z.number().min(1).max(4).optional(),
      blend_method: z.enum(['OPAQUE', 'CLIP', 'BLEND']).optional(),
      slot: z.number().int().min(0).max(63).default(0),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const o = requireObject(p, a.object);
      if (o.type !== 'MESH' && o.type !== 'CURVE' && o.type !== 'FONT')
        throw new ToolError(`'${o.name}' is a ${o.type}; materials apply to mesh, curve and text objects.`);
      const props: Record<string, unknown> = {};
      if (a.base_color) props.base_color = a.base_color.length === 3 ? [...a.base_color, 1] : a.base_color;
      for (const k of [
        'metallic',
        'roughness',
        'emission_color',
        'emission_strength',
        'alpha',
        'transmission',
        'ior',
        'blend_method',
      ] as const) {
        if (a[k] !== undefined) props[k] = a[k];
      }
      const findMat = (ref: string) =>
        p.scene.getMaterial(ref) ?? p.scene.listMaterials().find((m) => m.name === ref) ?? null;
      let created = false;
      const materialId = p.step(() => {
        let mat = a.material ? findMat(a.material) : null;
        if (a.material && !mat) {
          const names = p.scene
            .listMaterials()
            .map((m) => m.name)
            .join(', ');
          throw new ToolError(`Material '${a.material}' not found.${names ? ` Materials: ${names}.` : ''}`);
        }
        if (!mat && a.name) mat = findMat(a.name);
        if (!mat && !a.name) {
          const current = o.material_slots[a.slot] ? p.scene.getMaterial(o.material_slots[a.slot]!) : null;
          const users = current
            ? p.scene.listObjects().filter((x) => x.material_slots.includes(current.id)).length
            : 0;
          if (current && users <= 1) mat = current;
        }
        if (mat) {
          if (Object.keys(props).length) p.runOrThrow('material.update', { material: mat.id, ...props });
        } else {
          const res = p.runOrThrow<{ material: string }>('material.new', {
            name: a.name ?? `${o.name} Material`,
            assign: false,
            ...props,
          });
          mat = p.scene.getMaterial(res.result!.material);
          created = true;
        }
        p.runOrThrow('object.material_assign', { material: mat!.id, objects: [o.id], slot: a.slot });
        return mat!.id;
      });
      const m = p.scene.getMaterial(materialId)!;
      return {
        object: o.name,
        slot: a.slot,
        created,
        material: {
          id: m.id,
          name: m.name,
          base_color: roundVec([...m.base_color]),
          metallic: m.metallic,
          roughness: m.roughness,
          emission_color: m.emission_color,
          emission_strength: m.emission_strength,
          alpha: m.alpha,
          transmission: m.transmission,
          ior: m.ior,
          blend_method: m.blend_method,
        },
      };
    },
  );

  // ---------------------------------------------------------------- modifiers

  const modifierTypeList = () =>
    modifierTypes()
      .map((m) => `${m.type} (${m.label})`)
      .join(', ') || 'see list_operators';

  tool(
    'list_modifier_types',
    {
      title: 'List modifier types',
      description:
        'The modifier types add_modifier / update_modifier accept, with label, category (GENERATE, DEFORM, NORMALS), description and the JSON schema of their parameters (Blender names, types, enums, ranges, units in the descriptions, defaults). Pass `type` (identifier or label, e.g. "SCREW" or "Subdivision Surface") for one type; parameters are included for at most 6 types unless include_parameters is true.',
      annotations: READ_ONLY,
    },
    {
      type: z.string().optional().describe('One modifier type (identifier or label)'),
      category: z
        .enum([...new Set(modifierTypes().map((m) => m.category))] as [string, ...string[]])
        .optional()
        .describe('Only types of this category'),
      include_parameters: z
        .boolean()
        .optional()
        .describe('Include parameter schemas (default: true when at most 6 types match)'),
    },
    async ({ type, category, include_parameters }) => {
      let list = modifierTypes();
      if (type) {
        const found = findModifierType(type);
        if (!found)
          throw new ToolError(
            `Unknown modifier type '${type}'. Types: ${list.map((m) => m.type).join(', ')}.`,
          );
        list = list.filter((m) => m.type === found);
      }
      if (category) list = list.filter((m) => m.category === category);
      const detailed = include_parameters ?? list.length <= 6;
      return {
        count: list.length,
        types: list.map((m) => ({
          ...m,
          ...(detailed ? { parameters: modifierParamsSchema(m.type) } : {}),
        })),
        ...(detailed ? {} : { hint: 'Pass type (or include_parameters: true) for the parameter schemas.' }),
      };
    },
  );

  tool(
    'add_modifier',
    {
      title: 'Add modifier',
      description: `Add a modifier to the end of the stack of a mesh, curve or text object (non-destructive, like Blender; on curves and text it acts on the generated geometry). type is a Blender modifier identifier, e.g. SUBSURF {levels, render_levels}, MIRROR, ARRAY {count}, SOLIDIFY {thickness}, BOOLEAN {operation, object}, ARMATURE {object: "Rig"} (skinning; usually added by object.parent_to type ARMATURE_AUTO), CURVE {object: "Path", deform_axis} (bend along a curve). Object parameters accept object names. Parameter names follow Blender: list_modifier_types {type} gives every type's parameters (JSON schema with enums, ranges and defaults); unknown parameter names and invalid values are rejected with that schema. Available types: ${modifierTypeList()}.`,
      annotations: EDIT,
      argsHint:
        'Modifier parameters (levels, count, thickness, object …) go inside `params`; list_modifier_types {type} gives their names.',
    },
    {
      project: projectArg,
      object: objectArg,
      type: z
        .string()
        .min(1)
        .describe("Modifier type, e.g. 'SUBSURF' (or its label, e.g. 'Subdivision Surface')"),
      name: z.string().min(1).optional(),
      params: z.record(z.string(), z.unknown()).optional().describe('Modifier parameters (Blender names)'),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const o = requireObject(p, a.object);
      const change = addModifier(p, registry, o, a.type.trim(), { name: a.name, params: a.params });
      return {
        object: o.name,
        ...change,
        stack: p.scene.getObject(o.id)?.modifiers.map((m) => `${m.name} (${m.type})`),
      };
    },
  );

  tool(
    'update_modifier',
    {
      title: 'Update modifier',
      description:
        'Change parameters, name or visibility (show_viewport, show_render, show_in_editmode) of a modifier (by name or id). Unknown parameter names and invalid values are rejected with the JSON schema of the type (see list_modifier_types).',
      annotations: EDIT,
      argsHint: 'Modifier parameters go inside `params`; list_modifier_types {type} gives their names.',
    },
    {
      project: projectArg,
      object: objectArg,
      modifier: z.string().min(1).describe('Modifier name or id'),
      params: z.record(z.string(), z.unknown()).optional(),
      name: z.string().min(1).optional().describe('New name'),
      show_viewport: z.boolean().optional(),
      show_render: z.boolean().optional(),
      show_in_editmode: z.boolean().optional(),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const o = requireObject(p, a.object);
      const mod = requireModifier(o, a.modifier);
      const change = updateModifier(p, registry, o, mod, {
        params: a.params,
        name: a.name,
        show_viewport: a.show_viewport,
        show_render: a.show_render,
        show_in_editmode: a.show_in_editmode,
      });
      return { object: o.name, ...change };
    },
  );

  tool(
    'remove_modifier',
    {
      title: 'Remove modifier',
      description: 'Remove a modifier (by name or id) from an object.',
      annotations: EDIT,
    },
    { project: projectArg, object: objectArg, modifier: z.string().min(1) },
    async (a) => {
      const p = await agent.project(a.project);
      const o = requireObject(p, a.object);
      const change = removeModifier(p, registry, o, requireModifier(o, a.modifier));
      return {
        object: o.name,
        removed: change.modifier?.name,
        via: change.via,
        stack: p.scene.getObject(o.id)?.modifiers.map((m) => m.name),
      };
    },
  );

  tool(
    'apply_modifier',
    {
      title: 'Apply modifier',
      description:
        'Apply (bake) a modifier into the object\'s mesh data and remove it from the stack (like Blender\'s Apply; destructive to the base mesh). Mesh objects only: convert a curve or text object to a mesh, which bakes all of its modifiers, with run_operator {operator: "object.convert", params: {target: "MESH"}, selection: {objects: ["<name>"]}} (object.convert acts on the selection).',
      annotations: EDIT,
    },
    { project: projectArg, object: objectArg, modifier: z.string().min(1) },
    async (a) => {
      const p = await agent.project(a.project);
      const o = requireObject(p, a.object);
      const change = applyModifier(p, registry, o, requireModifier(o, a.modifier));
      const after = p.scene.getObject(o.id);
      const mesh = after?.data ? p.scene.getMesh(after.data) : null;
      return {
        object: o.name,
        applied: change.modifier?.name,
        via: change.via,
        mesh: mesh ? meshStats(mesh) : null,
      };
    },
  );

  // ---------------------------------------------------------------- mesh editing

  tool(
    'edit_mesh',
    {
      title: 'Edit mesh',
      description:
        "Run an edit-mode operator on a mesh object: enters Edit Mode on the object (headless), selects the given vertices/edges/faces (default: everything), runs the operator (mesh.* such as mesh.extrude_region_move {value}, mesh.inset, mesh.subdivide, mesh.loopcut, mesh.delete, mesh.merge, or transform.translate/rotate/resize to move the selected elements), then returns to Object Mode. Use list_operators (search 'mesh.') for the catalogue and parameters. One undo step. Returns {ok, operator, result, reports, mesh, selection_after}; a failure also carries `error` and `code` (INVALID_PARAMS, POLL_FAILED, NOT_FOUND or FAILED, as run_operator).",
      annotations: EDIT,
      argsHint:
        'Operator parameters go inside `params`; the elements to select go inside `selection` {verts, edges, faces, all}.',
    },
    {
      project: projectArg,
      object: objectArg,
      operator: z.string().min(1).describe("e.g. 'mesh.extrude_region_move'"),
      params: z.record(z.string(), z.unknown()).optional(),
      selection: meshSelectionSchema.optional(),
      select_mode: selectModeEnum
        .optional()
        .describe('Default: inferred from the selection (faces → FACE, edges → EDGE, else VERT)'),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const o = requireObject(p, a.object);
      if (o.type !== 'MESH' || !o.data) throw new ToolError(`'${o.name}' is not a mesh object.`);
      const refuse = (error: string, code: OperatorErrorCode) =>
        failure(error, { ok: false, operator: a.operator, error, code });
      if (!registry.has(a.operator))
        return refuse(
          `Unknown operator '${a.operator}'.${suggestOperators(registry, a.operator)}`,
          'NOT_FOUND',
        );
      const refused = toolOnlyOperator(a.operator);
      if (refused) return refuse(refused, 'FAILED');
      const mode = inferSelectMode(a.selection, a.select_mode);
      const res = p.step(() => {
        p.state.mode = 'OBJECT';
        p.state.selectedIds = [o.id];
        p.state.activeId = o.id;
        enterEditMode(p.context(), o.id);
        p.state.selectMode = mode;
        p.state.meshSelection = meshSelection(p, o.id, a.selection, mode);
        try {
          return p.run(a.operator, a.params ?? {});
        } finally {
          p.state.mode = 'OBJECT';
        }
      });
      const after = p.scene.getObject(o.id);
      const mesh = after?.data ? p.scene.getMesh(after.data) : null;
      const sel = p.state.meshSelection;
      const out = {
        ok: res.ok,
        operator: a.operator,
        result: res.result ?? null,
        ...(res.ok ? {} : { error: res.error ?? 'unknown error', code: errorCode(res) }),
        reports: res.reports,
        mesh: mesh ? meshStats(mesh) : null,
        selection_after: {
          select_mode: p.state.selectMode,
          verts: [...sel.verts].slice(0, 500),
          faces: [...sel.faces].slice(0, 500),
        },
      };
      p.publishPresence();
      if (!res.ok) return failure(`${a.operator} failed: ${res.error}`, out);
      return out;
    },
  );

  // ---------------------------------------------------------------- animation & settings

  tool(
    'insert_keyframe',
    {
      title: 'Insert keyframe',
      description:
        'Insert a keyframe at `frame` on an animatable property (Blender data paths). Object: location, rotation_euler (radians), scale, color; nested object paths: pose.bones["Bone"].location / rotation_euler / scale (armature bones, bone axes), pose.bones["Bone"].constraints["IK"].influence, constraints["Name"].influence (or another numeric constraint parameter), modifiers["Name"].<parameter>, particle_systems["Name"].<setting>. \'data.<path>\' keys the object\'s data: light (data.energy, data.color), camera (data.lens, data.dof_focus_distance), curve or text (data.bevel_factor_end to grow a curve, data.extrude, data.eval_time, data.size, data.splines[0].points[1].co) or mesh shape keys (data.shape_keys["Smile"].value, or just shape_keys["Smile"].value). \'material.<path>\' keys the material in `material_slot` (default: the first): material.base_color, material.roughness, material.emission_strength, procedural texture parameters such as material.textures.base_color.procedural.scale. object=\'world\' keys world settings (color, strength, sun_elevation, sun_rotation, mist_density …). `value` (number or vector) sets the keyed value, otherwise the current value is keyed; `index` keys one channel. For many keys at once use run_operator anim.keyframes_insert_many; drivers: anim.driver_add; F-curve modifiers (noise, cycles): anim.fmodifier_add / anim.extrapolation_set.',
      annotations: EDIT,
      argsHint:
        'Key one property per call (property: a data path such as location or data.energy, value, frame, index); many keys at once: run_operator anim.keyframes_insert_many.',
    },
    {
      project: projectArg,
      object: z.string().min(1).describe("Object id/name, or 'world'"),
      property: z
        .string()
        .min(1)
        .describe(
          'Data path, e.g. location, pose.bones["Arm"].rotation_euler, data.bevel_factor_end, material.roughness',
        ),
      frame: z.number(),
      value: z.union([z.number(), z.array(z.number())]).optional(),
      index: z.number().int().min(0).optional(),
      interpolation: z.enum(['CONSTANT', 'LINEAR', 'BEZIER']).default('BEZIER'),
      material_slot: z
        .number()
        .int()
        .min(0)
        .max(63)
        .optional()
        .describe("For 'material.' paths: the material slot (default: the first filled slot)"),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const t = keyframeTarget(p, a.object, a.property.trim(), a.material_slot);
      const values = Array.isArray(a.value) ? a.value : undefined;
      const scalar = typeof a.value === 'number' ? a.value : undefined;
      const sample = keyTargetData(p, t.type, t.id);
      if (!isAnimatable(t.type, t.path) || !sample) throw new ToolError(notAnimatable(t));
      const pose = /^pose\.bones\[(["'])(.+)\1\]\.(location|rotation_euler|scale)$/.exec(t.path);
      // a bone that was never posed has no pose channel yet, and a procedural texture parameter
      // that was never set is not stored: both are created below before they are keyed
      const unposed = !!pose && !p.scene.getObject(t.id)?.pose?.bones?.[pose[2]];
      const unsetParam = t.type === 'material' ? unsetProceduralParam(sample, t.path) : null;
      if (!unposed && !unsetParam) {
        // keying a path that does not resolve would create an F-curve that animates nothing
        const missing = missingPathReason(sample, t.path);
        if (missing) throw new ToolError(`'${t.path}' does not exist on ${t.label}: ${missing}.`);
      }
      const len = pose ? 3 : unsetParam ? 1 : propertyLength(t.type, t.path, sample);
      if (!len) throw new ToolError(`'${t.path}' does not exist on ${t.label}.`);
      if (values && a.index === undefined && values.length !== len)
        throw new ToolError(`'${t.path}' has ${len} channels; value must have ${len} numbers.`);
      if (a.index !== undefined && a.index >= len)
        throw new ToolError(`'${t.path}' has ${len} channel(s); index must be 0..${len - 1}.`);
      let inserted = 0;
      p.step(() => {
        if (unsetParam)
          p.runOrThrow('material.procedural_set', {
            material: t.id,
            channel: unsetParam.channel,
            procedural: { params: { [unsetParam.key]: unsetParam.value } },
          });
        if (pose && unposed) {
          // a bone that was never posed has no pose channel yet: create it with the rest values
          // (the operator checks that the bone exists) so it can be keyed like any property
          const channel = pose[3];
          p.runOrThrow('pose.bone_transform_set', {
            object: t.id,
            bone: pose[2],
            [channel]: channel === 'scale' ? [1, 1, 1] : [0, 0, 0],
          });
        }
        const channels = a.index !== undefined ? [a.index] : Array.from({ length: len }, (_, i) => i);
        for (const index of channels) {
          const value = a.index !== undefined ? (scalar ?? values?.[0]) : (values?.[index] ?? scalar);
          if (t.type === 'curve') {
            const r = p.runOrThrow<{ inserted: number }>('curve.keyframe_insert', {
              object: t.objectId,
              path: t.path,
              index: len > 1 || a.index !== undefined ? index : -1,
              frame: a.frame,
              value,
              interpolation: a.interpolation,
            });
            inserted += r.result?.inserted ?? 0;
          } else if (t.type === 'mesh') {
            const current = readChannel(sample, t.path, index);
            if (value === undefined && current === undefined)
              throw new ToolError(`'${t.path}' does not exist on ${t.label}.`);
            const r = p.runOrThrow<{ inserted: number }>('anim.keyframes_insert_many', {
              target_type: 'mesh',
              target: t.id,
              path: t.path,
              index,
              frames: [a.frame],
              values: [value ?? current],
              interpolation: a.interpolation,
            });
            inserted += r.result?.inserted ?? 1;
          } else {
            const r = p.runOrThrow<{ inserted: number }>('anim.keyframe_insert_property', {
              target_type: t.type,
              target: t.id,
              path: t.path,
              index: len === 1 && a.index === undefined ? -1 : index,
              frame: a.frame,
              value,
              interpolation: a.interpolation,
            });
            inserted += r.result?.inserted ?? 0;
          }
        }
      });
      return { inserted, target_type: t.type, target: t.name, path: t.path, frame: a.frame };
    },
  );

  tool(
    'set_scene_settings',
    {
      title: 'Scene settings',
      description:
        'Change scene, render, world and physics settings in one undo step (lights and cameras are objects: edit their data with run_operator light.properties_set / camera.properties_set, e.g. camera depth of field dof_use / dof_focus_distance / dof_aperture_fstop or an area light shape and size; set_active_camera picks the render camera). Scene: frame_start, frame_end, fps, frame_current (agent playhead), unit_system. Render: resolution_x/y, resolution_percentage, engine (RASTER|PATHTRACER), samples (path tracer samples per pixel), max_bounces, use_denoising, film_transparent, view_transform (AGX default), exposure. World: world_color (linear RGB), world_strength, environment (NONE|STUDIO|SKY|IMAGE), environment_strength; procedural sky (same as run_operator world.sky_set: sky_preset, sun_elevation / sun_rotation in radians, sun_intensity W/m², sun_size; any of them switches the environment to SKY); mist (same as world.mist_set: mist_density 1/m or mist_distance in m where it reaches 95 %, mist_color). Physics (same as rigidbody.world_set): use_gravity, gravity (m/s², default [0,0,-9.81]), rigidbody_enabled, rigidbody_frame_start/_end (simulated range), substeps_per_frame, solver_iterations, time_scale.',
      annotations: EDIT,
      argsHint:
        'Lights and cameras are objects: change their data with run_operator light.properties_set / camera.properties_set {object, …}; the active camera with set_active_camera.',
    },
    {
      project: projectArg,
      frame_start: z.number().int().optional(),
      frame_end: z.number().int().optional(),
      fps: z.number().positive().max(1000).optional(),
      frame_current: z.number().optional(),
      resolution_x: z.number().int().min(1).max(16384).optional(),
      resolution_y: z.number().int().min(1).max(16384).optional(),
      resolution_percentage: z.number().int().min(1).max(1000).optional(),
      engine: z.enum(['RASTER', 'PATHTRACER']).optional(),
      samples: z.number().int().min(1).max(100000).optional().describe('Path tracer samples per pixel'),
      max_bounces: z.number().int().min(0).max(1024).optional().describe('Path tracer light bounces'),
      use_denoising: z.boolean().optional().describe('Denoise path traced renders'),
      film_transparent: z.boolean().optional(),
      view_transform: z.enum(['STANDARD', 'AGX', 'FILMIC', 'ACES', 'NEUTRAL']).optional(),
      exposure: z.number().min(-32).max(32).optional(),
      world_color: vec3.optional(),
      world_strength: z.number().min(0).optional(),
      environment: z.enum(['NONE', 'STUDIO', 'SKY', 'IMAGE']).optional(),
      environment_strength: z.number().min(0).optional(),
      sky_preset: z
        .enum(['NOON', 'CLEAR_DAY', 'MORNING', 'SUNSET', 'DUSK', 'NIGHT', 'OVERCAST'])
        .optional()
        .describe('Procedural sky preset (applied before the explicit sun values)'),
      sun_elevation: z
        .number()
        .min(-Math.PI / 2)
        .max(Math.PI / 2)
        .optional()
        .describe('Radians above the horizon'),
      sun_rotation: z
        .number()
        .min(-1000)
        .max(1000)
        .optional()
        .describe(
          'Sun azimuth in radians counter-clockwise from +Y (≈3.9 front-lights the default camera view)',
        ),
      sun_intensity: z.number().min(0).max(1e5).optional().describe('Sun irradiance W/m²'),
      sun_size: z
        .number()
        .min(0)
        .max(Math.PI / 2)
        .optional()
        .describe('Sun disc angular diameter in radians'),
      mist_density: z.number().min(0).max(1000).optional().describe('Mist density 1/m (0 = off)'),
      mist_distance: z
        .number()
        .positive()
        .max(1e7)
        .optional()
        .describe('Depth in metres where the mist reaches 95 %'),
      mist_color: vec3.optional(),
      unit_system: z.enum(['METRIC', 'IMPERIAL', 'NONE']).optional(),
      use_gravity: z.boolean().optional(),
      gravity: vec3.optional().describe('Gravity acceleration m/s²'),
      rigidbody_enabled: z.boolean().optional().describe('Simulate rigid bodies'),
      rigidbody_frame_start: z.number().int().optional(),
      rigidbody_frame_end: z.number().int().optional(),
      substeps_per_frame: z.number().int().min(1).max(1000).optional(),
      solver_iterations: z.number().int().min(1).max(1000).optional(),
      time_scale: z.number().min(0).max(100).optional(),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const pick = (keys: readonly string[], rename: Record<string, string> = {}) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          const v = (a as Record<string, unknown>)[k];
          if (v !== undefined) out[rename[k] ?? k] = v;
        }
        return out;
      };
      const scene = pick(['frame_start', 'frame_end', 'fps', 'unit_system']);
      const render = pick([
        'resolution_x',
        'resolution_y',
        'resolution_percentage',
        'engine',
        'samples',
        'max_bounces',
        'use_denoising',
        'film_transparent',
        'view_transform',
        'exposure',
      ]);
      const sky = pick(['sky_preset', 'sun_elevation', 'sun_rotation', 'sun_intensity', 'sun_size'], {
        sky_preset: 'preset',
      });
      const useSky = a.environment === 'SKY' || Object.keys(sky).length > 0;
      if (useSky && a.environment && a.environment !== 'SKY')
        throw new ToolError(`Sky settings need environment SKY (got ${a.environment}).`);
      const world = pick(['world_color', 'world_strength', 'environment_strength'], {
        world_color: 'color',
        world_strength: 'strength',
      });
      if (a.environment && !useSky) world.environment = a.environment;
      if (a.mist_density !== undefined && a.mist_distance !== undefined)
        throw new ToolError('Pass either mist_density or mist_distance, not both.');
      const mist = pick(['mist_density', 'mist_distance', 'mist_color'], {
        mist_density: 'density',
        mist_distance: 'distance',
        mist_color: 'color',
      });
      const physics = pick(
        [
          'use_gravity',
          'gravity',
          'rigidbody_enabled',
          'rigidbody_frame_start',
          'rigidbody_frame_end',
          'substeps_per_frame',
          'solver_iterations',
          'time_scale',
        ],
        {
          rigidbody_enabled: 'enabled',
          rigidbody_frame_start: 'frame_start',
          rigidbody_frame_end: 'frame_end',
        },
      );
      const start = (scene.frame_start as number | undefined) ?? p.scene.getScene().frame_start;
      const endFrame = (scene.frame_end as number | undefined) ?? p.scene.getScene().frame_end;
      if (endFrame < start) throw new ToolError('frame_end must be >= frame_start');
      const reports: Record<string, unknown> = {};
      p.step(() => {
        if (Object.keys(scene).length) p.runOrThrow('data.set_property', { kind: 'scene', values: scene });
        if (Object.keys(render).length) p.runOrThrow('data.set_property', { kind: 'render', values: render });
        if (Object.keys(world).length) p.runOrThrow('data.set_property', { kind: 'world', values: world });
        if (useSky) reports.sky = p.runOrThrow('world.sky_set', { ...sky, enable: true }).result;
        if (Object.keys(mist).length) reports.mist = p.runOrThrow('world.mist_set', mist).result;
        if (Object.keys(physics).length)
          reports.rigidbody_world = p.runOrThrow('rigidbody.world_set', physics).result;
      });
      if (a.frame_current !== undefined) p.runOrThrow('scene.frame_set', { frame: a.frame_current });
      p.publishPresence();
      // the settings only (no geometry evaluation)
      const s = sceneSettingsAt(p.scene, p.state.frame);
      const sc = p.scene.getScene();
      return {
        scene: {
          ...s.scene,
          use_gravity: sc.use_gravity,
          gravity: roundVec([...sc.gravity]),
          rigidbody_world: sc.rigidbody_world,
        },
        render: s.render,
        world: s.world,
        frame_current: p.state.frame,
        ...(Object.keys(reports).length ? { applied: reports } : {}),
      };
    },
  );

  tool(
    'set_active_camera',
    {
      title: 'Set active camera',
      description: 'Make a camera object the scene camera used for renders.',
      annotations: EDIT,
    },
    { project: projectArg, camera: objectArg },
    async ({ project, camera }) => {
      const p = await agent.project(project);
      const o = requireObject(p, camera);
      if (o.type !== 'CAMERA') throw new ToolError(`'${o.name}' is a ${o.type}, not a camera.`);
      p.runOrThrow('data.set_property', { kind: 'scene', values: { camera: o.id } });
      return { active_camera: { id: o.id, name: o.name } };
    },
  );

  // ---------------------------------------------------------------- undo / redo

  const historyScope = () =>
    agent.agentId
      ? `the history of agent id '${agent.agentId}' (shared by every MCP session that sends this id)`
      : 'the history of this MCP session (it starts empty with every new connection; send the same agent id with every connection — header x-mcp-agent-id or ?agent=<id> on the endpoint URL, as scripts/mcp.mjs does — to undo across connections)';
  for (const kind of ['undo', 'redo'] as const) {
    tool(
      kind,
      {
        title: kind === 'undo' ? 'Undo' : 'Redo',
        description:
          (kind === 'undo'
            ? "Undo the agent's own most recent change(s) in a project (changes made by other users are never undone). Each tool call is one step (a batch is one step)."
            : "Redo the agent's most recently undone change(s).") +
          ' The history belongs to the MCP session, or — when the client sends an agent id (header x-mcp-agent-id or ?agent=<id> on the endpoint URL; scripts/mcp.mjs sends one) — to that agent id across sessions, so one-shot CLI calls can undo each other. It ends when the server restarts or the project is unloaded.',
        annotations: EDIT,
      },
      { project: projectArg, steps: z.number().int().min(1).max(100).default(1) },
      async ({ project, steps }) => {
        const p = await agent.project(project);
        let done = 0;
        for (let i = 0; i < steps; i++) {
          const item = kind === 'undo' ? p.undo.undo() : p.undo.redo();
          if (!item) break;
          done++;
        }
        p.room.touch();
        return {
          [kind === 'undo' ? 'undone' : 'redone']: done,
          can_undo: p.undo.canUndo(),
          can_redo: p.undo.canRedo(),
          ...(done < steps
            ? {
                note: `${done ? `Only ${done} of ${steps} step(s)` : 'Nothing'} to ${kind} in ${historyScope()}.`,
              }
            : {}),
        };
      },
    );
  }

  // ---------------------------------------------------------------- import / export

  tool(
    'import_model',
    {
      title: 'Import model',
      description: `Import a 3D file (gltf, glb, obj, stl, ply) into a project from base64 data or an http(s) URL (max ${MAX_IMPORT_BYTES / 1024 / 1024} MB). Y-up formats are converted to the editor's Z-up space. Imported objects become selected. One undo step.`,
      annotations: { ...EDIT, openWorldHint: true },
    },
    {
      project: projectArg,
      format: z
        .enum(['gltf', 'glb', 'obj', 'stl', 'ply'])
        .optional()
        .describe('Detected from the URL/name when omitted'),
      data_base64: z.string().optional(),
      url: z.string().optional(),
      name: z.string().optional().describe('Base name for created objects'),
      location: vec3.optional(),
    },
    async (a) => {
      if (!!a.data_base64 === !!a.url) throw new ToolError('Pass exactly one of data_base64 or url.');
      const p = await agent.project(a.project);
      let bytes: Uint8Array;
      let format: ImportFormat | null = a.format ?? null;
      if (a.url) {
        const r = await fetchLimited(a.url).catch((err: unknown) => {
          throw new ToolError(`Could not download ${a.url}: ${errorMessage(err)}`);
        });
        bytes = r.data;
        format ??= detectFormat(r.url.pathname) ?? detectFormat(a.url.split('?')[0]);
      } else {
        bytes = base64Decode(a.data_base64!);
        if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ToolError('file too large');
      }
      format ??= a.name ? detectFormat(a.name) : null;
      if (!format) throw new ToolError('Could not detect the file format; pass format.');
      const fmt = format;
      let result;
      try {
        result = p.step(() =>
          p.transact(() =>
            importFile(p.scene, fmt, bytes, { name: a.name, location: a.location as Vec3 | undefined }),
          ),
        );
      } catch (err) {
        if (isNotImplemented(err))
          throw new ToolError(`Importing ${fmt} is not available in this build: ${errorMessage(err)}`);
        throw new ToolError(`Import failed: ${errorMessage(err)}`);
      }
      p.state.mode = 'OBJECT';
      p.state.selectedIds = [...result.objects];
      p.state.activeId = result.objects[result.objects.length - 1] ?? null;
      p.publishPresence();
      return {
        format: fmt,
        bytes: bytes.byteLength,
        objects: result.objects.map((id) => brief(p, id)),
        warnings: result.warnings,
      };
    },
  );

  tool(
    'export_scene',
    {
      title: 'Export scene',
      description:
        "Export the scene (or some objects) as glb, gltf, obj, stl or ply at a frame (default: the agent's current frame). OBJ/STL/PLY hold world-space meshes. glTF/GLB keep the hierarchy (armature bones as nodes, BONE-parented objects under their bone), materials (procedural textures baked into images; meshes without UVs get generated UVs for them), cameras, lights and the animation sampled once per frame over the scene frame range from the evaluated scene (keyframes, drivers, constraints, IK, rigid body physics), with shape keys as morph targets and Armature-deformed meshes as skins. Returns {format, filename, mime, bytes, frame, objects, apply_modifiers, download_url, warnings} plus the file as an embedded base64 resource (up to 20 MiB) and a download link. download_url (an HTTP endpoint of this server) exports again when it is fetched, with the same options (format, objects, apply_modifiers, frame): the same file as the embedded one while the scene is unchanged, the project's current state after later edits. `warnings` lists what the format could not represent — check it: e.g. area lights become point lights, other animated deformation (modifier stacks) is baked into per-frame morph targets, image textures on meshes without UVs are dropped.",
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      format: z.enum(['glb', 'gltf', 'obj', 'stl', 'ply']).default('glb'),
      objects: z
        .array(z.string())
        .optional()
        .describe('Only these objects (ids or names; default: every object shown in renders)'),
      apply_modifiers: z.boolean().default(true).describe('Apply the modifier stacks (default true)'),
      frame: z
        .number()
        .optional()
        .describe("Frame the scene is evaluated at (default: the agent's current frame)"),
    },
    async (a, extra) => {
      const p = await agent.project(a.project);
      const objectIds = a.objects?.map((r) => requireObject(p, r).id);
      const frame = a.frame ?? p.state.frame;
      let res;
      try {
        res = exportScene(p.scene, a.format as ExportFormat, {
          objectIds,
          applyModifiers: a.apply_modifiers,
          frame,
        });
      } catch (err) {
        if (isNotImplemented(err))
          throw new ToolError(`Exporting ${a.format} is not available in this build: ${errorMessage(err)}`);
        throw new ToolError(`Export failed: ${errorMessage(err)}`);
      }
      const filename = safeFileName(p.scene.name, res.extension);
      // the link exports with the same options when it is fetched (GET …/export, see api/projects.ts)
      const query = new URLSearchParams({ format: a.format, frame: String(frame) });
      if (objectIds) query.set('objects', objectIds.join(','));
      if (!a.apply_modifiers) query.set('apply_modifiers', 'false');
      const downloadUrl = `${baseUrl(extra)}/api/projects/${encodeURIComponent(p.id)}/export?${query}`;
      const info = {
        format: a.format,
        filename,
        mime: res.mime,
        bytes: res.data.byteLength,
        frame,
        objects: objectIds ? objectIds.map((id) => p.scene.getObject(id)?.name ?? id) : 'all',
        apply_modifiers: a.apply_modifiers,
        download_url: downloadUrl,
        // what the format could not represent (procedural textures that need UVs, area lights …)
        warnings: res.warnings ?? [],
      };
      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(info, null, 2) }];
      if (res.data.byteLength <= MAX_EMBEDDED_EXPORT_BYTES) {
        content.push({
          type: 'resource',
          resource: {
            uri: `project://${p.id}/export/${filename}`,
            mimeType: res.mime,
            blob: base64Encode(res.data),
          },
        });
      }
      content.push({
        type: 'resource_link',
        uri: downloadUrl,
        name: filename,
        mimeType: res.mime,
        description:
          'Download: exported again on request with the same options (format, objects, apply_modifiers, frame)',
      });
      return { content };
    },
  );

  // ---------------------------------------------------------------- rendering & live editors

  tool(
    'render_image',
    {
      title: 'Render image',
      description:
        "Render a PNG of the scene to check your work or make a final picture. engine RASTER (fast, default for most scenes) or PATHTRACER (physically based, soft shadows, global illumination; default: the scene's render engine). RASTER renders use a connected browser editor (WebGL, same look as the viewport) when available, otherwise the server's software rasterizer; PATHTRACER renders run on the server's CPU cores in parallel (samples per pixel, max_bounces, denoise, time_limit in seconds — the render stops sampling when the time is up, after at least one sample per pixel), or with renderer browser on a browser editor's render workers. Film > Transparent (set_scene_settings film_transparent) gives a transparent background with both engines. Defaults to the scene camera; pass `camera` (camera object) or `view` {position, target, up?, fov_degrees? (VERTICAL angle) | lens? (mm)} for another viewpoint. Max 2048x2048 (path tracing: 2048x1280). Long renders send progress notifications. The JSON text after the image gives renderer, engine, size, frame, timing, for path tracing samples (reached) and requested_samples, and `warnings` (e.g. textures that could not be used, or degenerate triangles skipped, with the objects they belong to).",
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      width: z.number().int().min(16).max(MAX_RENDER_SIZE).default(800),
      height: z
        .number()
        .int()
        .min(16)
        .max(MAX_RENDER_SIZE)
        .optional()
        .describe('Default: from the render resolution aspect ratio'),
      camera: z.string().optional().describe('Camera object id or name'),
      view: strictArgObject({
        position: vec3.describe('Eye position (world space, metres)'),
        target: vec3.describe('Point looked at (world space)'),
        up: vec3.optional().describe('Up direction (default [0, 0, 1])'),
        fov_degrees: z
          .number()
          .min(1)
          .max(170)
          .optional()
          .describe(
            'VERTICAL field of view in degrees (default 50). The horizontal angle is wider for landscape images: hfov = 2·atan(tan(fov/2)·width/height). To match a Blender camera use `lens` instead',
          ),
        lens: z
          .number()
          .min(1)
          .max(5000)
          .optional()
          .describe(
            "Focal length in mm instead of fov_degrees, like a Blender camera with a 36 mm sensor and sensor_fit AUTO (the sensor spans the image's longer side): 50 mm ≈ 39.6° across the longer side",
          ),
      })
        .optional()
        .describe(
          'Explicit viewpoint instead of a camera (world space, Z up): position, target, up, and fov_degrees (vertical) or lens (mm)',
        ),
      engine: engineArg,
      samples: samplesArg,
      max_bounces: maxBouncesArg,
      denoise: denoiseArg,
      time_limit: z
        .number()
        .min(0.1)
        .max(MAX_TIME_LIMIT)
        .optional()
        .describe(
          `PATHTRACER: wall-clock budget in seconds (default ${DEFAULT_IMAGE_TIME_LIMIT}): sampling stops when it is used up (at least one sample per pixel)`,
        ),
      seed: seedArg,
      frame: z.number().optional().describe("Frame to render (default: the agent's current frame)"),
      renderer: z
        .enum(['auto', 'browser', 'software'])
        .default('auto')
        .describe(
          "auto: RASTER on a connected browser editor (WebGL, the viewport's look; else the server's rasterizer), PATHTRACER on the server (all its cores); browser: only a browser editor: RASTER with WebGL, PATHTRACER on the editor's render workers (samples, max_bounces, denoise, time_limit, seed; the result does not include the samples reached); software: always the server",
        ),
      shading: z
        .enum(['SOLID', 'MATERIAL'])
        .optional()
        .describe('MATERIAL (default): materials and lights; SOLID: grey clay shading (always rasterized)'),
      client: z.string().optional().describe('Specific editor connection/client name for browser rendering'),
    },
    async (a, extra) => {
      const p = await agent.project(a.project);
      const rs = p.scene.getRender();
      const width = a.width;
      const height =
        a.height ??
        Math.min(
          MAX_RENDER_SIZE,
          Math.max(16, Math.round((width * rs.resolution_y) / Math.max(1, rs.resolution_x))),
        );
      let cameraId: string | undefined;
      if (a.camera) {
        const cam = requireObject(p, a.camera);
        if (cam.type !== 'CAMERA') throw new ToolError(`'${cam.name}' is not a camera.`);
        cameraId = cam.id;
      }
      const frame = a.frame ?? p.state.frame;
      const engine = a.engine ?? rs.engine;
      if (a.view?.lens !== undefined && a.view.fov_degrees !== undefined)
        throw new ToolError(
          'Pass either view.fov_degrees (vertical field of view) or view.lens (mm), not both.',
        );
      // the vertical field of view (a lens covers 36 mm across the image's longer side, like Blender)
      const fovDegrees =
        a.view?.lens !== undefined
          ? (2 * Math.atan((18 / a.view.lens) * (height > width ? 1 : height / width))) / DEG2RAD
          : (a.view?.fov_degrees ?? 50);
      const view = a.view
        ? { position: a.view.position, target: a.view.target, up: a.view.up, fov_degrees: fovDegrees }
        : null;
      let fallbackReason: string | undefined;
      if (a.renderer === 'browser' || (a.renderer === 'auto' && engine === 'RASTER')) {
        const conn = p.room.pickRpcTarget('render', a.client);
        if (conn) {
          // the editor path traces on its render workers when asked (SOLID shading rasterizes)
          const browserPT = engine === 'PATHTRACER' && a.shading !== 'SOLID';
          const timeLimit = a.time_limit ?? DEFAULT_IMAGE_TIME_LIMIT;
          const requested = a.samples ?? rs.samples;
          // long browser renders send no progress of their own: keep the request alive
          const progress = browserPT ? progressReporter(extra) : undefined;
          const t0 = Date.now();
          const keepAlive = progress
            ? setInterval(() => {
                const seconds = Math.floor((Date.now() - t0) / 1000);
                progress({
                  progress: Math.min(seconds, Math.ceil(timeLimit)),
                  total: Math.ceil(timeLimit),
                  message: `path tracing in the browser editor: ${seconds} s (time_limit ${timeLimit} s)`,
                });
              }, 5000)
            : null;
          try {
            const result = await p.room.rpcTo(
              conn,
              'render',
              {
                width,
                height,
                camera: cameraId ?? null,
                view,
                shading: a.shading ?? null,
                frame,
                ...(browserPT
                  ? {
                      engine: 'PATHTRACER',
                      samples: requested,
                      max_bounces: a.max_bounces ?? rs.max_bounces,
                      denoise: a.denoise ?? rs.use_denoising,
                      time_limit: timeLimit,
                      seed: a.seed ?? 0,
                    }
                  : { engine: 'RASTER' }),
              },
              // path tracing takes up to time_limit plus loading, compiling, denoising and the PNG
              browserPT ? timeLimit * 1000 + 30_000 : 15_000,
            );
            const img = decodeRenderResult(result);
            if (!img) throw new Error('the editor returned no image');
            const reached =
              typeof result === 'object' &&
              result &&
              typeof (result as { samples?: unknown }).samples === 'number'
                ? (result as { samples: number }).samples
                : undefined;
            return {
              content: [
                { type: 'image', data: img.data, mimeType: img.mimeType },
                {
                  type: 'text',
                  text: JSON.stringify({
                    renderer: 'browser',
                    engine: browserPT ? 'PATHTRACER' : 'RASTER',
                    client: conn.clientInfo.name ?? conn.clientInfo.app ?? conn.id,
                    connection: conn.id,
                    width: img.width ?? width,
                    height: img.height ?? height,
                    frame,
                    elapsed_ms: Date.now() - t0,
                    ...(browserPT
                      ? {
                          ...(reached !== undefined ? { samples: reached } : {}),
                          requested_samples: requested,
                          time_limit: timeLimit,
                          ...(reached === undefined
                            ? {
                                note_samples:
                                  'The browser editor does not report the samples it reached: sampling stops at time_limit. Use renderer software for the samples reached.',
                              }
                            : {}),
                        }
                      : {}),
                    ...(engine === 'PATHTRACER' && !browserPT
                      ? { note_engine: 'SOLID shading always rasterizes' }
                      : {}),
                  }),
                },
              ],
            };
          } catch (err) {
            fallbackReason = `browser render failed: ${err instanceof RpcError ? err.message : errorMessage(err)}`;
          } finally {
            if (keepAlive) clearInterval(keepAlive);
          }
        } else fallbackReason = 'no connected browser editor can render';
        if (a.renderer === 'browser')
          throw new ToolError(`${fallbackReason}. Open the project in a browser or use renderer=software.`);
      }
      const options: FrameOptions = {
        width,
        height,
        frame,
        engine,
        cameraId,
        view: view
          ? {
              position: view.position,
              target: view.target,
              up: view.up ?? [0, 0, 1],
              fovY: view.fov_degrees * DEG2RAD,
            }
          : undefined,
        shading: a.shading,
        samples: a.samples,
        max_bounces: a.max_bounces,
        denoise: a.denoise,
        time_limit: engine === 'PATHTRACER' ? (a.time_limit ?? DEFAULT_IMAGE_TIME_LIMIT) : undefined,
        seed: a.seed,
      };
      let res;
      try {
        res = await renderer.renderImage({
          scene: p.scene,
          projectId: p.id,
          options,
          signal: extra.signal,
          onProgress: progressReporter(extra),
        });
      } catch (err) {
        throw renderToolError(err);
      }
      const pt = res.pathtrace;
      return {
        content: [
          { type: 'image', data: base64Encode(res.png), mimeType: 'image/png' },
          {
            type: 'text',
            text: JSON.stringify({
              renderer: 'software',
              engine: res.engine,
              width: res.width,
              height: res.height,
              frame,
              threads: res.threads,
              elapsed_ms: res.elapsedMs,
              ...(pt
                ? {
                    samples: pt.samples,
                    requested_samples: pt.requested,
                    ...(pt.stopped === 'time'
                      ? {
                          time_limit_reached: true,
                          hint: 'Sampling stopped at time_limit: raise time_limit or lower samples/size for a cleaner image.',
                        }
                      : {}),
                  }
                : {}),
              ...(engine === 'PATHTRACER' && res.engine === 'RASTER'
                ? { note_engine: 'SOLID shading always rasterizes' }
                : {}),
              ...(res.warnings.length ? { warnings: res.warnings.slice(0, 20) } : {}),
              ...(fallbackReason ? { note: fallbackReason } : {}),
            }),
          },
        ],
      };
    },
  );

  tool(
    'render_animation',
    {
      title: 'Render animation',
      description:
        'Render a range of frames on the server to check motion (keyframes, drivers, F-curve modifiers, constraints, armatures, physics, turntables) or to make an animated result. format CONTACT_SHEET (default: one PNG showing every rendered frame in a labelled grid — the easiest way to review a whole animation; sample long ranges to 12–24 tiles with frame_step), GIF (animated, 256 colours), APNG (animated PNG, returned as image/png) or PNG_SEQUENCE (one PNG per frame, returned as embedded image/png resources named frame_0001.png …). Frames frame_start..frame_end every frame_step (default: the scene frame range). Camera: `camera`, else the scene camera, else one fixed automatic view framing all frames (returned as view). engine RASTER (fast) or PATHTRACER (frames path traced in parallel on all CPU cores; keep size, samples and frame count small). time_limit bounds the whole render (default 60 s): path traced frames get an equal share and stop sampling early, frames that cannot start in time are dropped (truncated: true). Path traced results report requested_samples, samples_reached {min, mean, max} and frame_samples (the samples per pixel each frame reached, aligned with frames) plus undersampled_frames (frames that stopped early). store=true keeps the files on the server for an hour and returns download links (results too large to embed are stored automatically).',
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      format: z
        .enum(['CONTACT_SHEET', 'GIF', 'APNG', 'PNG_SEQUENCE'])
        .default('CONTACT_SHEET')
        .describe('Labelled frame grid PNG, animated GIF, animated PNG or one PNG per frame'),
      frame_start: z.number().int().optional().describe('First frame (default: scene frame_start)'),
      frame_end: z.number().int().optional().describe('Last frame (default: scene frame_end)'),
      frame_step: z.number().int().min(1).max(10000).default(1).describe('Render every n-th frame'),
      width: z
        .number()
        .int()
        .min(16)
        .max(MAX_ANIMATION_SIZE)
        .optional()
        .describe(
          'Frame width in pixels (default: the render resolution scaled to fit 480 px; contact sheet tiles up to 240 px)',
        ),
      height: z
        .number()
        .int()
        .min(16)
        .max(MAX_ANIMATION_SIZE)
        .optional()
        .describe('Frame height in pixels (default: from width and the render aspect)'),
      camera: z.string().optional().describe('Camera object id or name (default: the scene camera)'),
      engine: engineArg,
      shading: z
        .enum(['SOLID', 'MATERIAL'])
        .optional()
        .describe('MATERIAL (default): materials and lights; SOLID: grey clay shading (always rasterized)'),
      samples: samplesArg,
      max_bounces: maxBouncesArg,
      denoise: denoiseArg,
      seed: seedArg,
      animated_seed: z
        .boolean()
        .default(false)
        .describe('PATHTRACER: vary the noise pattern per frame (default false: steadier, smaller files)'),
      time_limit: z
        .number()
        .min(1)
        .max(MAX_TIME_LIMIT)
        .default(DEFAULT_ANIMATION_TIME_LIMIT)
        .describe('Wall-clock budget of the whole render in seconds'),
      frame_time_limit: z
        .number()
        .min(0.1)
        .max(MAX_TIME_LIMIT)
        .optional()
        .describe(
          'PATHTRACER: at most this many seconds of sampling per frame (default: a share of time_limit)',
        ),
      fps: z
        .number()
        .positive()
        .max(1000)
        .optional()
        .describe('GIF / APNG playback rate (default: scene fps / frame_step = real time)'),
      loop: z.number().int().min(0).max(65535).default(0).describe('GIF / APNG play count; 0 = forever'),
      dither: z
        .enum(['FLOYD_STEINBERG', 'BAYER', 'NONE'])
        .default('FLOYD_STEINBERG')
        .describe('GIF dithering (BAYER: ordered, stable between frames)'),
      colors: z.number().int().min(2).max(256).default(256).describe('GIF palette size'),
      columns: z.number().int().min(1).max(64).optional().describe('CONTACT_SHEET tiles per row'),
      store: z
        .boolean()
        .default(false)
        .describe('Keep the result on the server for an hour and return download links (like export_scene)'),
    },
    async (a, extra) => {
      const p = await agent.project(a.project);
      const sc = p.scene.getScene();
      const start = a.frame_start ?? sc.frame_start;
      const end = a.frame_end ?? sc.frame_end;
      if (end < start) throw new ToolError(`frame_end (${end}) is before frame_start (${start}).`);
      const total = Math.floor((end - start) / a.frame_step) + 1;
      if (total > MAX_RENDER_FRAMES)
        throw new ToolError(
          `Too many frames (${total}, at most ${MAX_RENDER_FRAMES}): shorten the range or raise frame_step.`,
        );
      let cameraId: string | undefined;
      if (a.camera) {
        const cam = requireObject(p, a.camera);
        if (cam.type !== 'CAMERA')
          throw new ToolError(`'${cam.name}' is a ${cam.type} object, not a camera.`);
        cameraId = cam.id;
      }
      // contact sheets: up to 240 px tiles, smaller for many frames (sheets stay around 2048 px)
      const fit =
        a.format === 'CONTACT_SHEET'
          ? Math.max(48, Math.min(240, Math.floor(2048 / Math.ceil(Math.sqrt(total)))))
          : 480;
      const size = animationFrameSize(p.scene, a.width, a.height, fit);
      const engine = a.engine ?? p.scene.getRender().engine;
      let res: AnimationOutput;
      try {
        res = await renderer.renderAnimation({
          scene: p.scene,
          projectId: p.id,
          format: a.format,
          frame_start: start,
          frame_end: end,
          frame_step: a.frame_step,
          width: size.width,
          height: size.height,
          fps: a.fps,
          base: {
            engine,
            cameraId,
            shading: a.shading,
            samples: a.samples,
            max_bounces: a.max_bounces,
            denoise: a.denoise,
            seed: a.seed,
          },
          frame_time_limit: a.frame_time_limit,
          time_limit: a.time_limit,
          animated_seed: a.animated_seed,
          loop: a.loop,
          dither: a.dither,
          colors: a.colors,
          columns: a.columns,
          max_frames: MAX_RENDER_FRAMES,
          signal: extra.signal,
          onProgress: progressReporter(extra),
        });
      } catch (err) {
        throw renderToolError(err, 'Rendering the animation');
      }
      const files: StoredFile[] = res.files
        ? res.files.map((f) => ({ name: f.name, mime: 'image/png', data: f.data }))
        : [
            {
              name: `animation.${a.format === 'GIF' ? 'gif' : 'png'}`,
              mime: a.format === 'GIF' ? 'image/gif' : 'image/png',
              data: res.data!,
            },
          ];
      if (a.format === 'CONTACT_SHEET') files[0].name = 'contact_sheet.png';
      const bytes = files.reduce((n, f) => n + f.data.byteLength, 0);
      const tooLarge = bytes > MAX_EMBEDDED_EXPORT_BYTES;
      let renderId: string | null = null;
      if (a.store || tooLarge) renderId = renderStore.put(p.id, files);
      const base = `${baseUrl(extra)}/api/projects/${encodeURIComponent(p.id)}/renders/${renderId}`;
      const info: Record<string, unknown> = {
        format: res.format,
        engine,
        mime: a.format === 'APNG' ? 'image/png (animated PNG)' : res.mime,
        width: res.width,
        height: res.height,
        fps: round(res.fps, 3),
        frames: res.frames,
        frame_count: res.frames.length,
        requested_frames: total,
        truncated: res.cancelled,
        bytes,
        threads: res.threads,
        parallelism: res.parallelism,
        elapsed_ms: res.elapsedMs,
      };
      if (res.time_limit_reached) {
        info.time_limit_reached = true;
        info.hint =
          'The time limit cut the render short: raise time_limit, or render fewer/smaller frames or fewer samples.';
      }
      if (res.frame_samples?.length) {
        // what the time budget left of the requested samples, per frame (aligned with frames)
        const fs = res.frame_samples;
        info.requested_samples = res.requested_samples;
        info.samples_reached = {
          min: Math.min(...fs),
          mean: round(fs.reduce((a, b) => a + b, 0) / fs.length, 1),
          max: Math.max(...fs),
        };
        info.frame_samples = fs;
      }
      if (res.undersampled_frames.length) info.undersampled_frames = res.undersampled_frames;
      if (res.warnings.length) info.warnings = res.warnings.slice(0, 20);
      if (res.sheet) info.sheet = res.sheet;
      if (res.view)
        info.view = {
          position: roundVec([...res.view.position]),
          target: roundVec([...res.view.target]),
          fov_degrees: round(res.view.fovY / DEG2RAD, 2),
        };
      if (renderId) {
        info.download_urls = files.map((f) => `${base}/${f.name}`);
        if (!a.store)
          info.note = `The result (${bytes} bytes) is too large to embed; download it from download_urls.`;
      } else if (tooLarge)
        throw new ToolError(`The result (${bytes} bytes) is too large to return or store.`);
      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(info, null, 2) }];
      if (!tooLarge) {
        if (res.files)
          for (const f of files)
            content.push({
              type: 'resource',
              resource: {
                uri: `project://${p.id}/renders/${renderId ?? 'latest'}/${f.name}`,
                mimeType: 'image/png',
                blob: base64Encode(f.data),
              },
            });
        else content.unshift({ type: 'image', data: base64Encode(files[0].data), mimeType: files[0].mime });
      }
      if (renderId)
        for (const f of files.slice(0, 50))
          content.push({
            type: 'resource_link',
            uri: `${base}/${f.name}`,
            name: f.name,
            mimeType: f.mime,
            description: 'Download (kept on the server for an hour)',
          });
      return { content };
    },
  );

  tool(
    'get_connected_clients',
    {
      title: 'Connected clients',
      description:
        'Who is working on a project right now: browser editors and AI agents with their name, kind (human/agent), mode, selection, current frame and the capabilities (render, ui) of each editor connection.',
      annotations: READ_ONLY,
    },
    { project: projectArg },
    async ({ project }) => {
      const p = await agent.project(project);
      const room = p.room;
      const nameOf = (id: unknown) => (typeof id === 'string' ? (p.scene.getObject(id)?.name ?? id) : null);
      return {
        connections: [...room.conns].map((c) => c.info()),
        presence: room.presence().map((e) => ({
          client_id: e.clientId,
          kind: e.kind,
          name: e.state.user?.name ?? 'unknown',
          color: e.state.user?.color,
          connection: e.connectionId,
          device: e.state.device,
          mode: e.state.mode,
          selection: Array.isArray(e.state.selection) ? e.state.selection.map(nameOf) : [],
          active: nameOf(e.state.active),
          frame: e.state.frame,
          you: e.clientId === p.presenceId,
          ...(e.clientId === p.presenceId && agent.agentId ? { agent_id: agent.agentId } : {}),
        })),
      };
    },
  );

  tool(
    'editor_command',
    {
      title: 'Editor command',
      description:
        'Send a UI command to a live browser editor that has the project open (most recently active one, or `client`): e.g. view.frame_all, view.frame_selected, view.set_view {view: FRONT|TOP|RIGHT|CAMERA...}, select {objects}, set_mode {mode}, screenshot. Fails when no browser editor accepting UI commands is connected.',
      annotations: { ...EDIT, openWorldHint: true },
      argsHint: 'Command parameters go inside `params` (editor_command {project, command, params: {…}}).',
    },
    {
      project: projectArg,
      command: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
      client: z.string().optional().describe('Connection id or client name'),
      timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
    },
    async (a, extra) => {
      const p = await agent.project(a.project);
      try {
        const result = await p.room.rpc(
          'ui',
          { command: a.command, params: a.params ?? {} },
          { capability: 'ui', target: a.client, timeoutMs: a.timeout_ms },
        );
        if (a.command === 'screenshot') {
          const img = decodeRenderResult(result);
          if (img) return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }] };
        }
        return { command: a.command, result: result ?? null };
      } catch (err) {
        if (err instanceof RpcError && err.code === 'NO_CLIENT') {
          throw new ToolError(
            `No browser editor accepting UI commands is connected to this project. Open ${editorUrl(extra, p.id)} in a browser.`,
          );
        }
        throw new ToolError(`editor_command '${a.command}' failed: ${errorMessage(err)}`);
      }
    },
  );
}

/** `project://{id}/scene` resources (JSON scene description). */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'project-scene',
    new ResourceTemplate('project://{id}/scene', {
      list: async () => ({
        resources: (await ctx.rooms.listProjects()).map((p) => ({
          uri: `project://${p.id}/scene`,
          name: `${p.name} – scene`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Project scene',
      description: 'JSON description of a project scene (same as get_scene)',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = String(Array.isArray(variables.id) ? variables.id[0] : variables.id);
      const p = await ctx.agent.project(id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(summarizeScene(p.scene, { frame: p.state.frame, projectId: p.id }), null, 2),
          },
        ],
      };
    },
  );
}
