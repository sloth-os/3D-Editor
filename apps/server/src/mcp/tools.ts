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
  ANIMATABLE,
  base64Decode,
  base64Encode,
  detectFormat,
  encodePNG,
  enterEditMode,
  exportScene,
  importFile,
  renderSceneSoftware,
  selectAllElements,
  selectionFromEdges,
  selectionFromFaces,
  selectionFromVerts,
  edgeKey,
  emptySelection,
  meshStats,
  type AnimTargetType,
  type ExportFormat,
  type ImportFormat,
  type MeshSelection,
  type ObjectData,
  type OperatorInfo,
  type OperatorRegistry,
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
import { ToolError, type AgentProject, type AgentSession } from './agent';
import { describeObject, round, roundVec, summarizeScene } from './scene-summary';
import {
  addModifier,
  applyModifier,
  modifierTypes,
  removeModifier,
  requireModifier,
  updateModifier,
} from './modifiers';
import { MAX_IMPORT_BYTES, fetchLimited } from './fetch-limited';

export interface ToolContext {
  agent: AgentSession;
  rooms: RoomManager;
  registry: OperatorRegistry;
  config: ServerConfig;
  metrics: ServerMetrics;
  log: Log;
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
const meshSelectionSchema = z
  .object({
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
  })
  .describe('Edit-mode element selection');

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
  const { agent, rooms, registry, metrics, log } = ctx;

  function tool<S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; annotations?: ToolAnnotations },
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
    server.registerTool(
      name,
      { title: meta.title, description: meta.description, inputSchema: shape, annotations: meta.annotations },
      cb as unknown as ToolCallback<S>,
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
        'Project details: name, timestamps, statistics, connected editors and agents, persistence mode and editor URL.',
      annotations: READ_ONLY,
    },
    { project: projectArg },
    async ({ project }, extra) => {
      const p = await agent.project(project);
      const listing = p.room.listing();
      return {
        ...listing,
        persistence: rooms.persistence.mode,
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
      return { deleted: id };
    },
  );

  // ---------------------------------------------------------------- inspection

  tool(
    'get_scene',
    {
      title: 'Get scene',
      description:
        'Describe the whole scene: every object (id, name, type, parent, collection, location / rotation_euler (radians, also in degrees) / scale, world-space bounds after modifiers, data summary such as mesh vertex/face counts, light energy or camera lens, material slots, modifiers, animated channels), materials, collections, scene/render/world settings and the active camera. Units: meters, Z up.',
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      frame: z.number().optional().describe('Frame to evaluate (default: the agent current frame)'),
    },
    async ({ project, frame }) => {
      const p = await agent.project(project);
      return summarizeScene(p.scene, { frame: frame ?? p.state.frame, projectId: p.id });
    },
  );

  tool(
    'get_object',
    {
      title: 'Get object',
      description:
        'Detailed description of one object: transform, world location and bounds, parent and children, mesh statistics, full material properties per slot, modifier stack with parameters, custom properties, visibility and animation keyframes.',
      annotations: READ_ONLY,
    },
    { project: projectArg, object: objectArg, frame: z.number().optional() },
    async ({ project, object, frame }) => {
      const p = await agent.project(project);
      return describeObject(p.scene, requireObject(p, object), frame ?? p.state.frame);
    },
  );

  tool(
    'list_operators',
    {
      title: 'List operators',
      description:
        'The operator catalogue (Blender-style ids such as mesh.primitive_cube_add, transform.rotate, mesh.extrude_region_move, mesh.subdivide) with descriptions and JSON-schema parameters. Filter by category (e.g. Add, Object, Transform, Mesh, Material, Animation, Data, Snap, Select) and/or a search string. Without filters a compact list is returned; use include_parameters=true or a filter to get parameter schemas.',
      annotations: READ_ONLY,
    },
    {
      category: z.string().optional(),
      search: z
        .string()
        .optional()
        .describe('Case-insensitive text matched against id, label and description'),
      include_parameters: z.boolean().optional(),
    },
    async ({ category, search, include_parameters }) => {
      let list = operatorCatalogue(registry);
      const categories = [...new Set(list.map((o) => o.category))].sort();
      if (category) list = list.filter((o) => o.category.toLowerCase() === category.toLowerCase());
      if (search) {
        const s = search.toLowerCase();
        list = list.filter((o) => `${o.id} ${o.label} ${o.description}`.toLowerCase().includes(s));
      }
      const detailed = include_parameters ?? (!!(category || search) && list.length <= 60);
      return {
        count: list.length,
        categories,
        modifier_types: modifierTypes().map((m) => m.type),
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

  const selectionSchema = z
    .object({
      objects: z
        .array(z.string())
        .optional()
        .describe('Objects to select (ids or names); replaces the selection'),
      active: z.string().optional().describe('Active object (id or name); defaults to the last selected'),
      mode: z.enum(['OBJECT', 'EDIT']).optional().describe('Interaction mode; EDIT edits the active mesh'),
      mesh: meshSelectionSchema.extend({ select_mode: selectModeEnum.optional() }).optional(),
    })
    .describe("Selection/mode to set before running (persists for the agent's next calls)");

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
        "Execute any operator by id with JSON parameters (see list_operators), as one undo step. Operators act on the agent's own selection like in Blender: use `selection` to choose objects, the active object and the mode (EDIT + mesh element selection for mesh.* operators) before running. Returns the operator result, reports and the resulting selection.",
      annotations: EDIT,
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
      if (!registry.has(operator))
        throw new ToolError(
          `Unknown operator '${operator}'.${suggestOperators(registry, operator)} Use list_operators.`,
        );
      const def = registry.get(operator)!;
      if (def.uiOnly)
        throw new ToolError(`'${operator}' is only available in the browser editor UI (try editor_command).`);
      applySelection(p, selection);
      const res = p.run(operator, params ?? {});
      p.publishPresence();
      const out = {
        ok: res.ok,
        operator,
        result: res.result ?? null,
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
        'Run a list of operators in order as a single undo step (one `undo` reverts all of them). With stop_on_error (default true) execution stops at the first failure; changes made before it are kept.',
      annotations: EDIT,
    },
    {
      project: projectArg,
      operations: z
        .array(
          z.object({ operator: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }),
        )
        .min(1)
        .max(200),
      stop_on_error: z.boolean().default(true),
    },
    async ({ project, operations, stop_on_error }) => {
      const p = await agent.project(project);
      const results: Record<string, unknown>[] = [];
      let failed = 0;
      p.step(() => {
        for (const op of operations) {
          if (!registry.has(op.operator)) {
            failed++;
            results.push({
              operator: op.operator,
              ok: false,
              error: `unknown operator${suggestOperators(registry, op.operator)}`,
            });
            if (stop_on_error) break;
            continue;
          }
          const res = p.run(op.operator, op.params ?? {});
          results.push({
            operator: op.operator,
            ok: res.ok,
            ...(res.ok ? { result: res.result ?? null } : { error: res.error }),
          });
          if (!res.ok) {
            failed++;
            if (stop_on_error) break;
          }
        }
      });
      const out = {
        ok: failed === 0,
        executed: results.length,
        failed,
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
        "Add a primitive or object: cube, plane, grid, circle, uv_sphere, ico_sphere, cylinder, cone, torus (meshes), empty, camera or light. Placed at `location` (default: world origin) with optional rotation (radians) or rotation_degrees and scale. Type specific `params` follow Blender's operators, e.g. cube {size}, uv_sphere {segments, ring_count, radius}, cylinder {vertices, radius, depth}, torus {major_radius, minor_radius}, camera {lens}, light {energy (W), color}, empty {type: PLAIN_AXES|ARROWS|CUBE|SPHERE|...}. The new object becomes selected and active.",
      annotations: EDIT,
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
        "Give an object a principled (PBR) material in a slot (default 0): reuse an existing material (`material`), create/update one by `name`, or (without either) edit the slot's material when only this object uses it, otherwise create a new one. Properties: base_color (linear RGB/RGBA 0..1), metallic, roughness, emission_color + emission_strength, alpha, transmission, ior, blend_method. One undo step.",
      annotations: EDIT,
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
      if (o.type !== 'MESH')
        throw new ToolError(`'${o.name}' is a ${o.type}; materials apply to mesh objects.`);
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
    'add_modifier',
    {
      title: 'Add modifier',
      description: `Add a modifier to the end of a mesh object's stack (non-destructive, like Blender). type is a Blender modifier identifier, e.g. SUBSURF {levels, render_levels}, MIRROR, ARRAY {count}, SOLIDIFY {thickness}, BOOLEAN {operation, object}. Parameter names follow Blender; invalid parameters are reported with the type's JSON schema. Available types: ${modifierTypeList()}.`,
      annotations: EDIT,
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
        'Change parameters, name or visibility (show_viewport, show_render, show_in_editmode) of a modifier (by name or id).',
      annotations: EDIT,
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
        "Apply (bake) a modifier into the object's mesh data and remove it from the stack (like Blender's Apply; destructive to the base mesh).",
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
        "Run an edit-mode operator on a mesh object: enters Edit Mode on the object (headless), selects the given vertices/edges/faces (default: everything), runs the operator (mesh.* such as mesh.extrude_region_move {value}, mesh.inset, mesh.subdivide, mesh.loopcut, mesh.delete, mesh.merge, or transform.translate/rotate/resize to move the selected elements), then returns to Object Mode. Use list_operators (search 'mesh.') for the catalogue and parameters. One undo step.",
      annotations: EDIT,
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
      if (!registry.has(a.operator))
        throw new ToolError(`Unknown operator '${a.operator}'.${suggestOperators(registry, a.operator)}`);
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
        "Insert a keyframe at `frame` on an animatable property. Object properties: location, rotation_euler (radians), scale, color. Use 'data.<prop>' for the object's light/camera data (e.g. data.energy, data.lens), 'material.<prop>' for the material in slot 0 (e.g. material.base_color) and object='world' for world color/strength. `value` (number or vector) sets the keyed value; without it the current value is keyed. Use index for a single channel.",
      annotations: EDIT,
    },
    {
      project: projectArg,
      object: z.string().min(1).describe("Object id/name, or 'world'"),
      property: z.string().min(1),
      frame: z.number(),
      value: z.union([z.number(), z.array(z.number())]).optional(),
      index: z.number().int().min(0).optional(),
      interpolation: z.enum(['CONSTANT', 'LINEAR', 'BEZIER']).default('BEZIER'),
    },
    async (a) => {
      const p = await agent.project(a.project);
      let targetType: AnimTargetType = 'object';
      let target: string;
      let path = a.property;
      if (a.object === 'world') {
        targetType = 'world';
        target = 'world';
      } else {
        const o = requireObject(p, a.object);
        target = o.id;
        if (path.startsWith('data.')) {
          if (!o.data || (o.type !== 'LIGHT' && o.type !== 'CAMERA'))
            throw new ToolError(`'${o.name}' has no light/camera data.`);
          targetType = o.type === 'LIGHT' ? 'light' : 'camera';
          target = o.data;
          path = path.slice(5);
        } else if (path.startsWith('material.')) {
          const mat = o.material_slots.find(Boolean);
          if (!mat) throw new ToolError(`'${o.name}' has no material.`);
          targetType = 'material';
          target = mat;
          path = path.slice(9);
        }
      }
      const len = ANIMATABLE[targetType]?.[path];
      if (!len) {
        throw new ToolError(
          `'${path}' is not animatable on ${targetType}. Animatable: ${Object.keys(ANIMATABLE[targetType] ?? {}).join(', ')}.`,
        );
      }
      const values = Array.isArray(a.value) ? a.value : undefined;
      if (values && a.index === undefined && values.length !== len) {
        throw new ToolError(`'${path}' has ${len} channels; value must have ${len} numbers.`);
      }
      let inserted = 0;
      p.step(() => {
        if (values && a.index === undefined) {
          values.forEach((v, i) => {
            const r = p.runOrThrow<{ inserted: number }>('anim.keyframe_insert_property', {
              target_type: targetType,
              target,
              path,
              index: i,
              frame: a.frame,
              value: v,
              interpolation: a.interpolation,
            });
            inserted += r.result?.inserted ?? 0;
          });
        } else {
          const scalar = typeof a.value === 'number' ? a.value : values?.[0];
          const r = p.runOrThrow<{ inserted: number }>('anim.keyframe_insert_property', {
            target_type: targetType,
            target,
            path,
            index: a.index ?? -1,
            frame: a.frame,
            value: scalar,
            interpolation: a.interpolation,
          });
          inserted += r.result?.inserted ?? 0;
        }
      });
      return { inserted, target_type: targetType, path, frame: a.frame };
    },
  );

  tool(
    'set_scene_settings',
    {
      title: 'Scene settings',
      description:
        'Change scene, render and world settings: frame_start, frame_end, fps, frame_current (agent playhead), resolution_x/y, resolution_percentage, engine (RASTER|PATHTRACER), samples, film_transparent, view_transform, exposure, world_color (linear RGB), world_strength, environment (NONE|STUDIO|SKY|IMAGE), environment_strength, unit_system. One undo step.',
      annotations: EDIT,
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
      samples: z.number().int().min(1).max(100000).optional(),
      film_transparent: z.boolean().optional(),
      view_transform: z.enum(['STANDARD', 'AGX', 'FILMIC', 'ACES', 'NEUTRAL']).optional(),
      exposure: z.number().min(-32).max(32).optional(),
      world_color: vec3.optional(),
      world_strength: z.number().min(0).optional(),
      environment: z.enum(['NONE', 'STUDIO', 'SKY', 'IMAGE']).optional(),
      environment_strength: z.number().min(0).optional(),
      unit_system: z.enum(['METRIC', 'IMPERIAL', 'NONE']).optional(),
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
        'film_transparent',
        'view_transform',
        'exposure',
      ]);
      const world = pick(['world_color', 'world_strength', 'environment', 'environment_strength'], {
        world_color: 'color',
        world_strength: 'strength',
      });
      const start = (scene.frame_start as number | undefined) ?? p.scene.getScene().frame_start;
      const endFrame = (scene.frame_end as number | undefined) ?? p.scene.getScene().frame_end;
      if (endFrame < start) throw new ToolError('frame_end must be >= frame_start');
      p.step(() => {
        if (Object.keys(scene).length) p.runOrThrow('data.set_property', { kind: 'scene', values: scene });
        if (Object.keys(render).length) p.runOrThrow('data.set_property', { kind: 'render', values: render });
        if (Object.keys(world).length) p.runOrThrow('data.set_property', { kind: 'world', values: world });
      });
      if (a.frame_current !== undefined) p.runOrThrow('scene.frame_set', { frame: a.frame_current });
      p.publishPresence();
      const s = summarizeScene(p.scene, { frame: p.state.frame, projectId: p.id });
      return { scene: s.scene, render: s.render, world: s.world, frame_current: p.state.frame };
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

  for (const kind of ['undo', 'redo'] as const) {
    tool(
      kind,
      {
        title: kind === 'undo' ? 'Undo' : 'Redo',
        description:
          kind === 'undo'
            ? "Undo the agent's own most recent change(s) in a project (changes made by other users are never undone)."
            : "Redo the agent's most recently undone change(s).",
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
        'Export the scene (or some objects) as glb, gltf, obj, stl or ply. Returns the file as an embedded base64 resource plus a download link (HTTP endpoint of this server).',
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      format: z.enum(['glb', 'gltf', 'obj', 'stl', 'ply']).default('glb'),
      objects: z.array(z.string()).optional().describe('Only these objects (ids or names)'),
      apply_modifiers: z.boolean().default(true),
    },
    async (a, extra) => {
      const p = await agent.project(a.project);
      const objectIds = a.objects?.map((r) => requireObject(p, r).id);
      let res;
      try {
        res = exportScene(p.scene, a.format as ExportFormat, {
          objectIds,
          applyModifiers: a.apply_modifiers,
          frame: p.state.frame,
        });
      } catch (err) {
        if (isNotImplemented(err))
          throw new ToolError(`Exporting ${a.format} is not available in this build: ${errorMessage(err)}`);
        throw new ToolError(`Export failed: ${errorMessage(err)}`);
      }
      const filename = safeFileName(p.scene.name, res.extension);
      const downloadUrl = `${baseUrl(extra)}/api/projects/${encodeURIComponent(p.id)}/export?format=${a.format}`;
      const info = {
        format: a.format,
        filename,
        mime: res.mime,
        bytes: res.data.byteLength,
        download_url: downloadUrl,
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
        description: 'Download (same export, generated on request)',
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
        "Render a PNG of the scene to check your work. Uses a connected browser editor (WebGL, same look as the viewport) when available, otherwise the server's software renderer. Defaults to the scene camera; pass `camera` (camera object) or `view` {position, target, up?, fov_degrees?} for another viewpoint. Max 2048x2048.",
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
      view: z
        .object({
          position: vec3,
          target: vec3,
          up: vec3.optional(),
          fov_degrees: z.number().min(1).max(170).optional(),
        })
        .optional()
        .describe('Explicit viewpoint (world space, Z up)'),
      renderer: z.enum(['auto', 'browser', 'software']).default('auto'),
      shading: z.enum(['SOLID', 'MATERIAL']).optional(),
      client: z.string().optional().describe('Specific editor connection/client name for browser rendering'),
    },
    async (a) => {
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
      const view = a.view
        ? {
            position: a.view.position as Vec3,
            target: a.view.target as Vec3,
            up: (a.view.up ?? [0, 0, 1]) as Vec3,
            fovY: (a.view.fov_degrees ?? 50) * DEG2RAD,
          }
        : undefined;
      let fallbackReason: string | undefined;
      if (a.renderer !== 'software') {
        const conn = p.room.pickRpcTarget('render', a.client);
        if (conn) {
          try {
            const result = await p.room.rpcTo(
              conn,
              'render',
              {
                width,
                height,
                camera: cameraId ?? null,
                view: a.view ?? null,
                shading: a.shading ?? null,
                frame: p.state.frame,
              },
              15_000,
            );
            const img = decodeRenderResult(result);
            if (!img) throw new Error('the editor returned no image');
            return {
              content: [
                { type: 'image', data: img.data, mimeType: img.mimeType },
                {
                  type: 'text',
                  text: JSON.stringify({
                    renderer: 'browser',
                    client: conn.clientInfo.name ?? conn.clientInfo.app ?? conn.id,
                    connection: conn.id,
                    width: img.width ?? width,
                    height: img.height ?? height,
                  }),
                },
              ],
            };
          } catch (err) {
            fallbackReason = `browser render failed: ${err instanceof RpcError ? err.message : errorMessage(err)}`;
          }
        } else fallbackReason = 'no connected browser editor can render';
        if (a.renderer === 'browser')
          throw new ToolError(`${fallbackReason}. Open the project in a browser or use renderer=software.`);
      }
      let png: Uint8Array;
      try {
        png = encodePNG(
          renderSceneSoftware(p.scene, { width, height, cameraId, view, frame: p.state.frame, samples: 2 }),
        );
      } catch (err) {
        if (isNotImplemented(err))
          throw new ToolError(
            `Software rendering is not available in this build (${errorMessage(err)}); ${fallbackReason ?? ''}`.trim(),
          );
        throw new ToolError(`Rendering failed: ${errorMessage(err)}`);
      }
      return {
        content: [
          { type: 'image', data: base64Encode(png), mimeType: 'image/png' },
          {
            type: 'text',
            text: JSON.stringify({
              renderer: 'software',
              width,
              height,
              ...(fallbackReason ? { note: fallbackReason } : {}),
            }),
          },
        ],
      };
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
