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
  buildTopology,
  detectFormat,
  enterEditMode,
  importFile,
  importMemoryRefusal,
  editOperatorMemoryRefusal,
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
  FrameState,
  OperatorError,
  BROWSER_UI_OPERATORS,
  isMeshMemoryError,
  type EditorState,
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
import { RpcError, type Room, type SyncConnection } from '../sync/room';
import { ProjectNameTakenError, requireFreeProjectName, withProjectNames } from '../sync/project-names';
import { isNotImplemented, safeFileName } from '../api/projects';
import { persistenceNote } from '../persistence';
import {
  NotFoundError,
  ToolError,
  collectProjectNotes,
  type AgentProject,
  type AgentSession,
  type ErrorCode,
} from './agent';
import type { HistoryLimits } from './history';
import {
  DEFAULT_MAX_OBJECTS,
  MAX_DECIMALS,
  OBJECT_DECIMALS,
  SCENE_DECIMALS,
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
import { DEFAULT_INSTANCE_PAGE, MAX_INSTANCE_PAGE, listInstances } from './instances';
import {
  keyTargetData,
  keyframeTarget,
  missingPathReason,
  notAnimatable,
  unsetProceduralParam,
} from './keyframes';
import {
  browserUiOperator,
  browserUiOperatorsNote,
  closestOperatorIds,
  findOperatorGroup,
  operatorGroupNames,
  toolOnlyOperator,
} from './operator-groups';
import { strictArgObject, strictToolSchema } from './strict-args';
import {
  DEFAULT_EDITOR_TIMEOUT_MS,
  MAX_EDITOR_TIMEOUT_MS,
  blockingLateRpcs,
  checkEditorCommand,
  describeLateRpcs,
  editorClosedMessage,
  editorCommandList,
  editorTimeoutMessage,
} from './editor-commands';
import {
  AFTER_SAVE_HOLD_SECONDS,
  BROWSER_RASTER_SECONDS,
  CHANGE_APPLY_SECONDS,
  FIRST_SHADING_SECONDS,
  MILLIONS_SELECT_SECONDS,
  NEW_SHADER_SECONDS,
  READ_HOLD_SECONDS,
  SAVE_HOLD_SECONDS,
  SERVER_SOLID_SECONDS,
  measured,
  measuredBrowserImages,
  measuredOnServer,
} from './editor-costs';
import {
  DELETED_ELSEWHERE_NOTE,
  LIST_FAILED_NOTE,
  LIST_PARTIAL_NOTE,
  PROJECT_READ_MAX_AGE_MS,
  PROJECT_READ_WAIT_MS,
  listProjects,
  readBeforeAnswer,
} from './project-storage';
import {
  isCancelled,
  isOutOfMemory,
  type AnimationOutput,
  type FrameOptions,
  type Renderer,
} from '../render';
import type { RenderStore, StoredFile } from '../render/store';
import {
  AUTO_BROWSER_RASTER_TIMEOUT_MS,
  BROWSER_PATHTRACE_EXTRA_MS,
  BROWSER_RASTER_TIMEOUT_MS,
  DEFAULT_ANIMATION_TIME_LIMIT,
  DEFAULT_IMAGE_TIME_LIMIT,
  MAX_ANIMATION_SIZE,
  MAX_RENDER_FRAMES,
  MAX_TIME_LIMIT,
  animationFrameSize,
  SLOW_EDITOR_RETRY_MS,
  browserRenderFailure,
  browserRenderTimeout,
  keepAlive,
  noteBrowserRaster,
  slowBrowserRaster,
  SCALE_UP_MIN_MS,
  denoiseArg,
  engineArg,
  maxBouncesArg,
  progressReporter,
  renderToolError,
  samplesArg,
  animationSamplesArg,
  seedArg,
} from './rendering';

export interface ToolContext {
  agent: AgentSession;
  rooms: RoomManager;
  registry: OperatorRegistry;
  config: ServerConfig;
  metrics: ServerMetrics;
  log: Log;
  /** Server-side renderer (render processes). */
  renderer: Renderer;
  /** Stored render results (render_animation `store`). */
  renderStore: RenderStore;
  /** Limits of the agents' undo histories (for descriptions and notes). */
  historyLimits: HistoryLimits;
}

const formatMb = (bytes: number) => `${+(bytes / 1048576).toFixed(1)} MB`;

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolOutput = CallToolResult | Record<string, unknown> | unknown[];

const DEG2RAD = Math.PI / 180;
const MAX_RENDER_SIZE = 2048;
const MAX_EMBEDDED_EXPORT_BYTES = 20 * 1024 * 1024;

// ------------------------------------------------------------------ shared schemas

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const color = z.union([vec3, vec4]).describe('Linear RGB or RGBA, components 0..1');
const projectArg = z
  .string()
  .min(1)
  .describe(
    'Project id or name (see list_projects): the exact name, or, when no project has it, the name in another letter case',
  );
const objectArg = z.string().min(1).describe('Object id or exact object name');
const objectList = z.array(z.string().min(1)).min(1).describe('Object ids or exact names');
const selectModeEnum = z.enum(['VERT', 'EDGE', 'FACE']);
const meshSelectionShape = {
  verts: z.array(z.number().int().min(0)).optional().describe('Vertex indices'),
  edges: z
    .array(z.tuple([z.number().int().min(0), z.number().int().min(0)]))
    .optional()
    .describe(
      'Edges of the mesh as [vertexA, vertexB] pairs: two vertices that follow each other in a face (get_mesh_data faces), or a loose edge',
    ),
  faces: z.array(z.number().int().min(0)).optional().describe('Face indices'),
  all: z
    .boolean()
    .optional()
    .describe(
      'Without verts, edges or faces: select everything (true, the default) or nothing (false). With them only the listed elements are selected (all: true is refused)',
    ),
};
// nested argument objects are closed like the tools' arguments (see strict-args.ts)
const meshSelectionSchema = strictArgObject(meshSelectionShape).describe('Edit-mode element selection');
const selectModeArg = selectModeEnum
  .optional()
  .describe(
    'VERT selects the listed vertices with the vertices of the listed edges and faces; EDGE only the listed edges and FACE only the listed faces (other lists are refused). Default: inferred (faces alone → FACE, edges alone → EDGE, else VERT)',
  );

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

/**
 * Characters that end a line in common clients (JavaScript's `\n` and `\r`, the others Python's
 * `splitlines()` also splits at), see {@link oneLine}.
 */
const LINE_BREAKS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

/**
 * `s` on one line: line breaks, which names (of objects, projects, …) can contain, become escapes
 * as in JSON (`\n`, `\r`, `\u2028` …). The message of an error is its first line, and the JSON of
 * run_operator, batch and edit_mesh failures follows on the next one, so a name with a line break
 * in a message must not end that line early.
 */
export function oneLine(s: string): string {
  let out = '';
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (!LINE_BREAKS.has(code)) out += c;
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/**
 * An error result: the message on one line (see {@link oneLine}), followed on the next line by
 * `details` as JSON when given.
 */
function failure(message: string, details?: unknown): CallToolResult {
  const first = oneLine(message);
  const body = details === undefined ? first : `${first}\n${JSON.stringify(details, null, 2)}`;
  return { content: [{ type: 'text', text: body }], isError: true };
}

function isCallToolResult(v: unknown): v is CallToolResult {
  return typeof v === 'object' && v !== null && Array.isArray((v as { content?: unknown }).content);
}

/** `s` parsed as a JSON object, or null when it is not one. */
function jsonObject(s: string): Record<string, unknown> | null {
  if (!s.trimStart().startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A tool's result with the notes of the projects it found by a name that was not compared with
 * every project (agent.ts collectProjectNotes: storage did not answer in time, listing it failed, or
 * reading some project.json files failed), so that the agent knows another project may have that
 * name and can pass the id instead: `project_note` in the result's JSON, a result object or the JSON
 * that comes with an image or a file (one text, which scripts/mcp.mjs parses), and in the JSON after
 * a failure's message (a JSON of its own after a message that had none); a result without JSON (a
 * screenshot) gets a text of its own after its content. A note that a failure's message already
 * gives is not repeated.
 */
function withProjectNotes(out: ToolOutput, notes: string[]): CallToolResult {
  const r = isCallToolResult(out) ? out : null;
  const said = (n: string) => !!r?.isError && r.content.some((c) => c.type === 'text' && c.text.includes(n));
  const project_note = notes.filter((n) => !said(n)).join(' ');
  if (!project_note) return r ?? text(out);
  const own = { type: 'text' as const, text: JSON.stringify({ project_note }) };
  if (r?.isError) {
    // failure(): the message on its first line, then its JSON
    const [first] = r.content;
    if (r.content.length === 1 && first.type === 'text') {
      const nl = first.text.indexOf('\n');
      const details = nl < 0 ? {} : jsonObject(first.text.slice(nl + 1));
      const message = nl < 0 ? first.text : first.text.slice(0, nl);
      if (details)
        return {
          ...r,
          content: [
            { type: 'text', text: `${message}\n${JSON.stringify({ ...details, project_note }, null, 2)}` },
          ],
        };
    }
    return { ...r, content: [...r.content, own] };
  }
  if (r) {
    const at = r.content.findIndex((c) => c.type === 'text' && jsonObject(c.text) !== null);
    if (at < 0) return { ...r, content: [...r.content, own] };
    const content = r.content.map((c, i) =>
      i === at && c.type === 'text'
        ? {
            ...c,
            text: JSON.stringify(
              { ...jsonObject(c.text), project_note },
              null,
              c.text.includes('\n') ? 2 : undefined,
            ),
          }
        : c,
    );
    return { ...r, content };
  }
  if (typeof out === 'object' && out !== null && !Array.isArray(out)) return text({ ...out, project_note });
  return { content: [...text(out).content, own] };
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

/** The object an agent refers to by id or exact name; a {@link NotFoundError} when there is none. */
function requireObject(p: AgentProject, ref: string): ObjectData {
  const o = p.scene.resolveObject(ref);
  if (!o) {
    const names = objectNames(p);
    throw new NotFoundError(
      `Object '${ref}' not found in project '${p.scene.name}'.${names ? ` Objects: ${names}.` : ' The scene is empty.'}`,
    );
  }
  return o;
}

/** An object's id, name, type, transform (as precise as get_object) and parent. */
function brief(p: AgentProject, id: string) {
  const o = p.scene.getObject(id);
  if (!o) return { id, deleted: true };
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    location: roundVec([...o.location], OBJECT_DECIMALS),
    rotation_euler: roundVec([...o.rotation_euler], OBJECT_DECIMALS),
    scale: roundVec([...o.scale], OBJECT_DECIMALS),
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

/** Where an agent finds the edges of a mesh, for the error of an edge the mesh does not have. */
const EDGES_HINT =
  'an edge joins two vertices that follow each other in one of the faces get_mesh_data lists (the last ' +
  "with the first), or is one of its loose_edges (include: ['loose_edges'])";

type MeshList = 'verts' | 'edges' | 'faces';
/** The element lists of a mesh selection that each select mode selects from (VERT: by their vertices). */
const MODE_LISTS: Record<SelectMode, readonly MeshList[]> = {
  VERT: ['verts', 'edges', 'faces'],
  EDGE: ['edges'],
  FACE: ['faces'],
};

const andList = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];

/**
 * What select mode VERT selects with the lists `lists`: the listed vertices, and the vertices of the
 * listed edges and faces.
 */
function vertModeSelects(lists: readonly MeshList[]): string {
  const of = lists.filter((k) => k !== 'verts');
  const theirs = of.length ? `the vertices of the listed ${andList(of)}` : '';
  if (!lists.includes('verts')) return theirs;
  return of.length ? `the listed vertices with ${theirs}` : 'the listed vertices';
}

/**
 * The refusal of a mesh selection `sel` whose element lists (`lists`, not empty) cannot be selected
 * as asked, or null when they can: lists `ignored` that select mode `mode` (EDGE or FACE) does not
 * select from, `all: true` (every element, which the lists would not change), or both in one
 * message. The remedies for ignored lists: listing what `mode` selects, the mode that selects them,
 * which leaving select_mode out infers (inferSelectMode: FACE for faces alone, EDGE for edges alone,
 * else VERT), and VERT, which selects the vertices of every list; for `all: true`: leaving all out,
 * or the lists. Every remedy it names is a call the server accepts as it is: with both problems
 * each remedy for the lists also leaves all out, since a call that kept all: true would be refused
 * again.
 */
function listsRefusal(
  mode: SelectMode,
  sel: z.infer<typeof meshSelectionSchema>,
  lists: readonly MeshList[],
  ignored: readonly MeshList[],
): string | null {
  const all = sel.all === true;
  if (!ignored.length)
    return all
      ? `all: true selects every element, so the listed ${andList(lists)} would change nothing: leave all ` +
          'out to select only the listed elements, or leave the lists out to select everything'
      : null;
  const used = mode === 'FACE' ? 'faces' : 'edges';
  const inferred = inferSelectMode(sel);
  const andAll = all ? 'leave all out and ' : '';
  const remedies = [
    `${andAll}${lists.includes(used) ? `list only ${used}` : `list ${used} instead`}`,
    `${all ? 'leave all and select_mode out' : 'leave select_mode out'} (or ${andAll}pass '${inferred}') to ` +
      `select ${inferred === 'VERT' ? vertModeSelects(lists) : `the listed ${andList(lists)}`}`,
    ...(inferred === 'VERT' ? [] : [`${andAll}pass 'VERT' to select ${vertModeSelects(lists)}`]),
    ...(all ? ['leave the lists out to select everything'] : []),
  ];
  return (
    `select_mode '${mode}' selects only the listed ${used}, so the listed ${andList(ignored)} would be ignored` +
    `${all ? ', and all: true selects every element, so the lists would change nothing' : ''}: ` +
    `${remedies.slice(0, -1).join(', ')}, or ${remedies[remedies.length - 1]}`
  );
}

/**
 * The Edit Mode element selection `sel` asks for in select mode `mode` on an object's base mesh.
 * What cannot be selected as asked is a ToolError with code POLL_FAILED (a selection that cannot be
 * applied), not silently left out: a list that `mode` does not select from (EDGE uses only `edges`,
 * FACE only `faces`: an explicit select_mode, as inferSelectMode infers them only from those lists
 * alone) and `all: true` with lists (everything, which the lists would not change), both named in
 * one message ({@link listsRefusal}); an index the mesh does not have, or an edge between two of its
 * vertices that no edge of the mesh connects (the edges of its faces and its loose wire edges: the
 * topology selectionFromEdges selects from, which would skip it in EDGE mode while VERT mode would
 * select its two vertices).
 */
function meshSelection(
  p: AgentProject,
  objectId: string,
  sel: z.infer<typeof meshSelectionSchema> | undefined,
  mode: SelectMode,
): MeshSelection {
  const o = p.scene.getObject(objectId);
  const mesh = o?.data ? p.scene.getMesh(o.data) : null;
  if (!mesh) throw new ToolError('object has no mesh data', 'POLL_FAILED');
  if (!sel) return selectAllElements(mesh);
  const lists = (['verts', 'edges', 'faces'] as const).filter((k) => sel[k]?.length);
  if (!lists.length) return sel.all === false ? emptySelection() : selectAllElements(mesh);
  const ignored = lists.filter((k) => !MODE_LISTS[mode].includes(k));
  const refused = listsRefusal(mode, sel, lists, ignored);
  if (refused) throw new ToolError(refused, 'POLL_FAILED');
  const nv = mesh.positions.length / 3;
  for (const v of sel.verts ?? [])
    if (v >= nv)
      throw new ToolError(`vertex index ${v} out of range (mesh has ${nv} vertices)`, 'POLL_FAILED');
  for (const [a, b] of sel.edges ?? [])
    if (a >= nv || b >= nv)
      throw new ToolError(
        `edge [${a}, ${b}]: vertex index ${Math.max(a, b)} out of range (mesh has ${nv} vertices)`,
        'POLL_FAILED',
      );
  for (const f of sel.faces ?? [])
    if (f >= mesh.faces.length)
      throw new ToolError(
        `face index ${f} out of range (mesh has ${mesh.faces.length} faces)`,
        'POLL_FAILED',
      );
  const topo = sel.edges?.length ? buildTopology(mesh) : undefined;
  for (const [a, b] of sel.edges ?? [])
    if (!topo!.edgeIndex.has(edgeKey(a, b)))
      throw new ToolError(
        a === b
          ? `edge [${a}, ${b}] names vertex ${a} twice: ${EDGES_HINT}`
          : `edge [${a}, ${b}]: vertices ${a} and ${b} are not connected by an edge of the mesh: ${EDGES_HINT}`,
        'POLL_FAILED',
      );
  if (mode === 'FACE') return selectionFromFaces(mesh, sel.faces ?? []);
  if (mode === 'EDGE')
    return selectionFromEdges(
      mesh,
      (sel.edges ?? []).map(([a, b]) => edgeKey(a, b)),
      topo,
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
function errorCode(res: RunResult): ErrorCode {
  return res.code ?? 'FAILED';
}

/**
 * The kind of a failure thrown around an operator (an unknown project or object, a selection that
 * cannot be applied): the code the error carries (ToolError, NotFoundError, core OperatorError),
 * else `fallback`. Decided by the error's class and code, never by its message.
 */
function codeOf(err: unknown, fallback: ErrorCode): ErrorCode {
  if (err instanceof ToolError || err instanceof OperatorError) return err.code ?? fallback;
  return fallback;
}

/**
 * Closest operator ids to a (mistyped) id, ignoring letter case: the registry's and the browser
 * editor's UI operators (BROWSER_UI_OPERATORS), which the note after the list names as such, with
 * what to use instead and how a live editor runs them. Completions of the id come first
 * ('wm.save' → wm.save_mainfile, 'view3d.view' → view3d.view_all …), then the ids nearest by edit
 * distance ('VIEW3D.VIEW_ALL' or 'view3d.viewall' → view3d.view_all); see closestOperatorIds.
 */
function suggestOperators(registry: OperatorRegistry, id: string): string {
  const candidates = [
    ...registry
      .list()
      .filter((d) => !d.uiOnly)
      .map((d) => d.id),
    ...BROWSER_UI_OPERATORS.filter((b) => !registry.has(b)),
  ];
  const scored = closestOperatorIds(id, candidates);
  if (!scored.length) return '';
  const browser = scored.filter((s) => BROWSER_UI_OPERATORS.includes(s) && !registry.has(s));
  return ` Did you mean: ${scored.join(', ')}?${browser.length ? ` ${browserUiOperatorsNote(browser, scored, id)}` : ''}`;
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
 * The browser editor render_image sends a render to: the one `client` names, else the most
 * recently active editor that is neither still busy with a request the server stopped waiting for
 * (Room.lateRpcs: it is still drawing an image, and a new render would wait behind it) nor, for
 * renderer 'auto', too slow for its last RASTER image of this shading (slowBrowserRaster), else
 * the most recently active one. `busy` and `slow` say why the chosen editor is not to be asked.
 */
function renderEditor(
  room: Room,
  a: { client?: string; renderer: 'auto' | 'browser'; shading?: 'SOLID' | 'MATERIAL'; pixels?: number },
): { conn: SyncConnection | null; busy: string | null; slow: string | null } {
  const busyWith = (c: SyncConnection) => describeLateRpcs(blockingLateRpcs(room.lateRpcs(c)));
  const slowWith = (c: SyncConnection) =>
    a.renderer === 'auto' ? slowBrowserRaster(room, c, a.shading, Date.now(), a.pixels) : null;
  const conn = a.client
    ? room.pickRpcTarget('render', a.client)
    : (room.rpcCandidates('render').find((c) => !busyWith(c) && !slowWith(c)) ??
      room.pickRpcTarget('render'));
  return { conn, busy: conn ? busyWith(conn) : null, slow: conn ? slowWith(conn) : null };
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

/**
 * Refuses a project name that another project already has, ignoring letter case (see
 * sync/project-names.ts): projects are found by id or name, and a second project with the same
 * name would make every by-name reference ambiguous. Call it inside withProjectNames.
 */
async function requireFreeName(rooms: RoomManager, name: string, self?: string): Promise<void> {
  try {
    await requireFreeProjectName(rooms, name, self);
  } catch (err) {
    if (!(err instanceof ProjectNameTakenError)) throw err;
    const ids = err.ids;
    const caseNote = err.differsInCase
      ? ` Names that differ only in letter case count as the same name, so '${name}' is taken too.`
      : '';
    throw new ToolError(
      `A project named '${err.holders[0].name}' already exists (id ${ids.join(', ')}).${caseNote} Project names are unique because tools find projects by name: ` +
        `work in that project (pass its id), delete it first with delete_project {project: '${ids[0]}', confirm: true}, or choose another name.`,
    );
  }
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
      // the notes of the projects the call found by name (withProjectNotes), also when it fails
      let notes: string[] = [];
      try {
        const result = await withSpan(
          `mcp.tool ${name}`,
          {
            'mcp.tool': name,
            'mcp.session': agent.id,
            ...(typeof projectRef === 'string' ? { 'project.ref': projectRef } : {}),
          },
          async (span) => {
            const run = await collectProjectNotes(async () => {
              try {
                return { out: await handler(args, extra) };
              } catch (err) {
                return { err };
              }
            });
            notes = run.notes;
            if ('err' in run.value) throw run.value.err;
            const r = withProjectNotes(run.value.out, notes);
            if (r.isError) span.setAttribute('mcp.tool.error', true);
            return r;
          },
        );
        metrics.mcpToolCalls.inc({ tool: name, status: result.isError ? 'error' : 'ok' });
        return result;
      } catch (err) {
        metrics.mcpToolCalls.inc({ tool: name, status: 'error' });
        // the out-of-memory errors of the rendering and export tools carry their code as JSON on
        // the next line (like run_operator's failures); every other tool error stays one message
        // (with a project_note, also that as JSON)
        if (err instanceof ToolError)
          return withProjectNotes(
            failure(err.message, err.code === 'OUT_OF_MEMORY' ? { code: err.code } : undefined),
            notes,
          );
        // a stored mesh the server's process has no memory to decode (get_mesh_data …), as the
        // operators that read it say it: code OUT_OF_MEMORY
        if (isMeshMemoryError(err))
          return withProjectNotes(failure(`${name} failed: ${err.message}`, { code: err.code }), notes);
        log.warn({ err: errorMessage(err), tool: name, session: agent.id }, 'MCP tool failed');
        return withProjectNotes(failure(`${name} failed: ${errorMessage(err)}`), notes);
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
        'List all projects on this server (persisted and currently open) with id, name, timestamps, statistics (objects, vertices, faces) and the number of connected editors (peers). A loaded project whose last read of storage found that another writer had deleted it has deleted_from_storage: true (get_project checks storage before it answers, and says what that means). When listing the projects in storage fails, or storage does not answer (WebDAV storage: 30 s per request), only the projects this server has loaded are listed; when reading the project.json of some stored projects fails, only those are missing. Both set storage_listing_failed: true with a note that says which projects are missing; meanwhile tools do not find the missing projects by name, and create_project and rename_project do not refuse a name that one of them has.',
      annotations: READ_ONLY,
    },
    {},
    async (_args, extra) => {
      // RoomManager.listProjects reports a failed listing of storage only in its log and metric
      const { projects, failed: listingFailed, partial } = await listProjects(rooms);
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          created_at: p.created_at,
          updated_at: p.updated_at,
          stats: p.stats,
          peers: p.peers,
          loaded: p.live,
          ...(p.live && rooms.get(p.id)?.deletedFromStorage ? { deleted_from_storage: true } : {}),
          editor_url: editorUrl(extra, p.id),
        })),
        ...(listingFailed
          ? { storage_listing_failed: true, note: partial ? LIST_PARTIAL_NOTE : LIST_FAILED_NOTE }
          : {}),
      };
    },
  );

  tool(
    'create_project',
    {
      title: 'Create project',
      description:
        "Create a new project. By default it contains Blender's startup scene (a 2 m cube named 'Cube' with 'Material', a 'Camera' and a point 'Light'); pass empty=true for an empty scene. Project names are unique, ignoring letter case (tools find projects by id or name): a name that another project already has ('Lighthouse' when 'lighthouse' exists, too) is refused with that project's id, so work in it, delete it first (delete_project) or pick another name. Returns the project id and the URL that opens it in the editor.",
      annotations: EDIT,
    },
    {
      name: z.string().trim().min(1).max(200).describe('Project name (not used by another project)'),
      empty: z.boolean().default(false).describe('Start with an empty scene'),
    },
    async ({ name, empty }, extra) => {
      const room = await withProjectNames(rooms, async () => {
        await requireFreeName(rooms, name);
        return rooms.createProject({ name, empty });
      });
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
      description: `Project details: name, timestamps, statistics, connected editors and agents, editor URL, and the server's persistence: \`persistence\` disk | webdav (saved, survives restarts) or memory (lost when the server stops) with an explanation. It checks storage before it answers (unless this server read it in the last ${PROJECT_READ_MAX_AGE_MS / 1000} s; it waits up to ${PROJECT_READ_WAIT_MS / 1000} s in all for that check and for a read of the project that is still going on): when another writer (a server sharing the storage, or a browser syncing with it) has deleted the project from storage while it is open here, it has deleted_from_storage: true and deleted_from_storage_note: this server keeps it open while editors or agents use it, and the next change made here stores it again.`,
      annotations: READ_ONLY,
    },
    { project: projectArg },
    async ({ project }, extra) => {
      const p = await agent.project(project);
      const persistence = rooms.persistence;
      // a room that agents use reads storage only when it saves (see readBeforeAnswer)
      await readBeforeAnswer(p.room, persistence.store);
      const listing = p.room.listing();
      return {
        ...listing,
        persistence: persistence.mode,
        persistence_note: persistenceNote(persistence.mode),
        ...(persistence.mode === 'memory' ? {} : { stored_at: persistence.location }),
        ...(p.room.deletedFromStorage
          ? { deleted_from_storage: true, deleted_from_storage_note: DELETED_ELSEWHERE_NOTE }
          : {}),
        editor_url: editorUrl(extra, p.id),
        clients: p.room.presence().map((e) => ({ name: e.state.user?.name ?? 'unknown', kind: e.kind })),
      };
    },
  );

  tool(
    'rename_project',
    {
      title: 'Rename project',
      description:
        'Rename a project (stored in the document, synced to all editors). The name must not be used by another project, ignoring letter case (changing the case of its own name is fine).',
      annotations: EDIT,
    },
    {
      project: projectArg,
      name: z.string().trim().min(1).max(200).describe('New project name (not used by another project)'),
    },
    async ({ project, name }) => {
      const p = await agent.project(project);
      await withProjectNames(rooms, async () => {
        await requireFreeName(rooms, name, p.id);
        p.transact(() => p.scene.setName(name));
      });
      return { id: p.id, name: p.scene.name };
    },
  );

  tool(
    'delete_project',
    {
      title: 'Delete project',
      description:
        "Permanently delete a project: deletes its stored files, and once storage has deleted them, closes the project for every editor and agent that has it open on this server (browser editors show 'Deleted on server'). This cannot be undone. When storage fails, or the project's earlier reads and writes of storage do not finish within 5 s, nothing is closed and the call fails with 'delete_project failed: could not delete project <id> from storage (<reason>); …: delete it again' (the project stays open here, and storage may still hold all or part of it). With WebDAV storage, whose requests each wait up to 30 s for an answer, the call takes up to 5 s plus one request for a project loaded on this server, and up to three requests one after another for one that is not (its project.json, read twice, then the deletion; five when it has no project.json), when you pass the project's id. A name is looked up first: one that could be an id (letters, digits, '-' and '_') is tried as an id first (up to two more requests one after another), then storage is listed to compare the name with every project (one request, then the project.json of each stored project that is new or changed since this server last read it, that had none then, or that it read more than a minute ago), at most 5 s in all when this server has loaded a project of that name; a project this server has not loaded is found by that listing instead of the first read of its project.json. A deletion needs the name compared with every project as storage holds it: when storage does not answer in that time or listing it fails (the name is then compared with the projects this server has loaded only, or without those whose project.json could not be read), or took longer than 5 s to list its projects the last time (the name is then compared with that listing, while it is at most a minute old), the call deletes nothing: it fails with 'delete_project deleted nothing: Project '<name>' was found by name, but …', which gives the project's id to pass instead. Editors and agents that have it open on another server sharing the storage stay connected there, and their next change stores the project again (until then get_project on that server, which checks storage first, shows deleted_from_storage: true); browsers that sync with the same WebDAV storage keep their copy, and their next change or Save stores it again too: with WebDAV through this server's /dav proxy, this server then opens the project again and those browsers sync with it live, which undoes the deletion for everyone. Requires confirm=true.",
      annotations: DESTRUCTIVE,
    },
    { project: projectArg, confirm: z.literal(true).describe('Must be true to confirm the deletion') },
    async ({ project }) => {
      // a deletion cannot be undone: a name that was not compared with every project (storage did
      // not answer in time, or listing it failed) may name another project than the one meant
      const { id, note } = await agent.findProject(project);
      if (note) throw new ToolError(`delete_project deleted nothing: ${note}`);
      const deleted = await rooms.deleteProject(id);
      if (!deleted) throw new ToolError(`Project '${project}' not found.`);
      // only now: a deletion that storage refused leaves the project open here, and the agent keeps
      // its undo history and editor state in it
      agent.forget(id);
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
        "Describe the whole scene at a frame. Values are the EVALUATED ones at that frame, like Blender's properties: keyframed, driven and F-curve-modified location / rotation_euler (radians, also in degrees) / scale, shape key values, constraint influences, pose channels, light / camera / curve / world settings; where animation overrides the value stored in the document (what transform_object or the *.properties_set operators change), the stored value is listed too (`stored`, `stored_value`, `stored_influence`). Contents: counts (objects by type; vertices / faces = BASE mesh data of mesh objects before modifiers, curves and text not included; evaluated {vertices, faces, triangles} = the geometry renders show, the same objects the renderers and export_scene use: objects shown in renders only (objects hidden with hide_render, e.g. Boolean cutters and helpers, are left out and counted apart in not_rendered {objects: their names, vertices, faces, triangles, and instances / instance_triangles of hidden emitters}; hidden source objects of scatters and collection instances are listed there too, while their instances render and are counted in instances / instance_triangles), after shape keys, modifiers with their RENDER settings (SUBSURF render_levels, SCREW render_steps, show_render), curve bevels (render_resolution_u) and text, instances not included; evaluated_viewport = the objects shown in the viewport with the viewport settings (what the editor's statistics overlay shows), only listed when it differs; instances and instance_triangles = particle / collection instances in renders (their emitter or instancing empty shown in renders), viewport_instances when the viewport shows others), every object (id, name, type, parent, collection, transform, world-space bounds of the render geometry after modifiers, armature deformation, constraints and physics (wire curves: of their wire), data summary: mesh vertex/face counts (base, evaluated = render, evaluated_viewport when it differs) with shape keys and vertex groups, curve splines/points/fill_mode/bevel/extrude, text body, armature bones with parents and pose_position, light (datablock name, type, energy, colour, size/shape, spot), camera (lens, clipping, dof_use); material slots, modifiers with their object references, constraints (type, targets, influence, errors), particle systems (count, instanced object/collection, instances; where they are: get_instances), rigid body (type, shape, mass), animated channels, drivers (path + expression) and evaluation problems), materials (with procedural textures), collections, scene/render/world settings (rigid body world, sky, mist) and the active camera. `problems` lists evaluation errors (drivers, constraints, modifiers, poses, curves, instancing, physics) with object names so you can fix them, including those only the viewport evaluation has (`viewport: true`, e.g. a Subdivision Surface whose viewport levels were skipped for memory; per object, modifier_errors entries with `viewport: true` and problems whose source is followed by ' (viewport)'), then the modifiers Blender disables because they can change nothing, which the evaluations leave out ({source: 'modifier', object, modifier, disabled: true, message}, with `viewport: true` when only the viewport evaluation has the entry; a Boolean without a mesh object, a Subdivision Surface with 0 levels, …: 'Modifier is disabled: the Boolean modifier 'Boolean' has no object, so it changes nothing; change it with update_modifier or remove it with remove_modifier'; one that only the viewport's settings disable, which renders use, has `viewport: true` and ends 'so it changes nothing in the viewport; renders use it', one that only the render settings disable, which the viewport uses, ends 'so it changes nothing in renders; the viewport uses it'); at most 40 entries in all, errors first (problems_total counts them all when there are more). A stored mesh the server's process has no memory to decode is listed with its stored counts (vertices, faces, triangles) and `not_loaded` (why); operators on it and get_mesh_data fail with code OUT_OF_MEMORY (as JSON after the message). Long lists are truncated with *_total counts; use get_object for everything about one object and get_mesh_data for vertex positions. Evaluations are cached per document state and frame, so repeated get_scene / get_object calls (e.g. checking motion at many frames) are cheap until the scene changes. Units: meters, Z up. Numbers are rounded to `decimals` (default 4 = 0.1 mm; up to 6 = 1 µm); get_object rounds to 6 by default.",
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
      decimals: z
        .number()
        .int()
        .min(0)
        .max(MAX_DECIMALS)
        .default(SCENE_DECIMALS)
        .describe(
          `Rounding of the numbers (default ${SCENE_DECIMALS}: 0.1 mm; ${MAX_DECIMALS} for sub-millimetre detail, or use get_object)`,
        ),
    },
    async ({ project, frame, max_objects, decimals }) => {
      const p = await agent.project(project);
      return summarizeScene(p.scene, {
        frame: frame ?? p.state.frame,
        projectId: p.id,
        maxObjects: max_objects,
        decimals,
      });
    },
  );

  tool(
    'get_object',
    {
      title: 'Get object',
      description:
        'Detailed description of one object at a frame, with the EVALUATED values at that frame (keyframes, drivers, F-curve modifiers applied; `stored` / `stored_value` / `stored_influence` / `stored_params` give the document values where animation overrides them): local transform, world_location and world_transform (the final world location / rotation / scale after parents, constraints and physics), world bounds of the render geometry (wire curves: their wire), parent (and parent bone) and children, data (mesh statistics base and evaluated = what renders show (render settings of the modifiers: SUBSURF render_levels, SCREW render_steps, show_render), plus evaluated_viewport when the viewport shows other geometry; shape keys with values, vertex groups with assigned vertex counts; every curve shape setting (fill_mode, bevel_mode/depth/resolution/object, bevel_factor, extrude, offset, use_fill_caps, twist_mode, resolution_u, render_resolution_u, path settings) and the spline points; text body and layout; armature bones with rest head/tail and posed world positions, pose channels and bone constraints; light / camera datablock name and id with every setting incl. depth of field), full material properties per slot, modifier stack with parameters, constraints with parameters and errors, particle systems with settings and instance counts (instance transforms: get_instances), rigid body settings, drivers with variables, animation curves (keyframes, extrapolation, F-curve modifiers, including the object data), custom properties, visibility and evaluation problems. The mesh statistics in data (data.evaluated, or the base counts when nothing changes the mesh) are those of the object itself, also when it is hidden from renders (hide_render: get_scene then counts it in counts.not_rendered, not in counts.evaluated). Numbers are rounded to `decimals` (default 6 = 1 µm, so sub-millimetre parts such as labels, engravings and fine bevels read back as they were made). Vertex positions and faces: get_mesh_data. Evaluations are cached per document state and frame: checking many objects or frames is cheap.',
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      object: objectArg,
      frame: z.number().optional().describe("Frame to evaluate (default: the agent's current frame)"),
      decimals: z
        .number()
        .int()
        .min(0)
        .max(MAX_DECIMALS)
        .default(OBJECT_DECIMALS)
        .describe(`Rounding of the numbers (default ${OBJECT_DECIMALS}: 1 µm)`),
    },
    async ({ project, object, frame, decimals }) => {
      const p = await agent.project(project);
      return describeObject(p.scene, requireObject(p, object), frame ?? p.state.frame, decimals);
    },
  );

  tool(
    'get_mesh_data',
    {
      title: 'Get mesh data',
      description: `Read the geometry of a mesh, curve or text object, in pages: vertex positions (meters), vertex normals, vertex colors (include "colors": linear [r, g, b, a] 0..1 per vertex from the color layer that paint.vertex_color_set / _stroke / _set_data write, null when there is none), faces (vertex index loops, counter-clockwise seen from the front), per-face material indices (with the material_slots they refer to), smooth flags, face normals and centers, UVs, loose edges, vertex group weights (source BASE), and a world-space heightmap of the surface (highest Z on an XY grid — for placing things on terrain). source BASE (default for meshes) is the stored mesh, whose indices edit_mesh selections, vertex groups and shape keys use; EVALUATED is the geometry after shape keys and modifiers at the frame (curves and text: their generated surface), RENDER the same with render settings (subdivision render_levels …); with either, modifier_errors lists the modifiers that evaluation left out ({modifier, message}: one that failed or was skipped for memory; {modifier, disabled: true, message}: one Blender disables because it can change nothing) and modifier_errors_note says that the geometry is the result without them. space LOCAL (object space, default) or WORLD. include picks the fields (default vertices, faces, face_materials). At most \`limit\` vertices and faces per call (default ${DEFAULT_MESH_PAGE}, max ${MAX_MESH_PAGE}); when more remain the result has truncated: true and next {vertex_offset, face_offset} to pass for the next page. totals gives the full counts. Compact JSON.`,
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
    'get_instances',
    {
      title: 'Get instances',
      description: `List the instances an object generates, with the world transform of each, in pages: every particle of its particle systems (object.scatter_add, object.particle_system_add; one entry per instanced object, so whole-collection particles give one per collection object) and the objects of the collection it instances (object.collection_instance_add). Read-only: check a scatter (spacing / min_distance, nothing on a path, a beach or in the water, sizes, orientations) without making the instances real. Each entry: {system, particle} (particle index) or {collection}, the source object it instances, location (m), rotation_euler (radians, XYZ) and scale in WORLD space. Also per particle system: instance_object / instance_collection, count, particles and instances placed, location_bounds (min/max of the instance locations) and whether it is shown; problems lists instancing errors. source RENDER (default) lists what renders show (every particle of the systems with show_render), VIEWPORT what the editor shows (display_percentage, show_viewport). \`particle_system\` (name or id) restricts the list to one system; \`total\` counts the listed kind. At most \`limit\` per call (default ${DEFAULT_INSTANCE_PAGE}, max ${MAX_INSTANCE_PAGE}); when more remain the result has truncated: true and next {offset}. Compact JSON.`,
      annotations: READ_ONLY,
    },
    {
      project: projectArg,
      object: objectArg.describe('Particle emitter or collection-instancing empty (id or exact name)'),
      particle_system: z
        .string()
        .min(1)
        .optional()
        .describe('Only this particle system of the object (name or id); default: all of them'),
      source: z
        .enum(['RENDER', 'VIEWPORT'])
        .default('RENDER')
        .describe('RENDER: the instances renders show (default); VIEWPORT: the editor viewport'),
      frame: z.number().optional().describe("Frame to evaluate (default: the agent's current frame)"),
      offset: z.number().int().min(0).default(0).describe('First instance of the page'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_INSTANCE_PAGE)
        .default(DEFAULT_INSTANCE_PAGE)
        .describe('Instances per page'),
      decimals: z.number().int().min(0).max(6).default(4).describe('Rounding of the transforms'),
    },
    async (a) => {
      const p = await agent.project(a.project);
      const out = listInstances(p.scene, requireObject(p, a.object), {
        frame: a.frame ?? p.state.frame,
        source: a.source,
        particle_system: a.particle_system,
        offset: a.offset,
        limit: a.limit,
        decimals: a.decimals,
      });
      // compact JSON: instance lists are long
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
    mesh: strictArgObject({ ...meshSelectionShape, select_mode: selectModeArg })
      .optional()
      .describe('Edit-mode element selection of the active mesh (with mode EDIT)'),
  }).describe(
    "Selection/mode to set before running (kept for the agent's next calls). All or nothing: a selection that cannot be applied is not applied at all, and a call that fails leaves the selection as it was",
  );

  /**
   * Sets the agent's selection, active object and mode (and the Edit Mode element selection) from a
   * `selection` argument, all or nothing: when any part fails (an unknown object: NotFoundError;
   * Edit Mode without an active mesh, mesh elements without Edit Mode, an element index out of
   * range, an edge the mesh does not have, lists the select mode does not select from, `all: true`
   * with lists: ToolError with code POLL_FAILED) the agent's editor state is left as it was, and
   * the error says why.
   */
  function applySelection(p: AgentProject, sel: z.infer<typeof selectionSchema> | undefined): void {
    if (!sel) return;
    const before = { ...p.state };
    try {
      setSelection(p, sel);
    } catch (err) {
      Object.assign(p.state, before);
      throw err;
    }
  }

  /**
   * Why Edit Mode `operator` would be refused for memory on the mesh of object `objectId` with the
   * element selection `sel` (all elements without one), asked before Edit Mode is entered and the
   * elements are selected, which takes seconds on a mesh of millions of faces (core
   * editOperatorMemoryRefusal: from the mesh's stored counts and the selection's sizes). Null: go
   * on; the registry checks the operator again with the real selection.
   */
  function editMemoryRefusal(
    p: AgentProject,
    operator: string,
    params: unknown,
    objectId: string,
    sel: z.infer<typeof meshSelectionSchema> | undefined,
  ): string | null {
    let parsed: unknown;
    try {
      parsed = registry.parseParams(operator, params ?? {});
    } catch {
      return null;
    }
    const lists = !!(sel?.verts?.length || sel?.edges?.length || sel?.faces?.length);
    const sizes = lists
      ? { verts: new Set(sel?.verts).size, edges: 0, faces: new Set(sel?.faces).size }
      : sel?.all === false
        ? { verts: 0, edges: 0, faces: 0 }
        : ('all' as const);
    return editOperatorMemoryRefusal(p.context(), operator, parsed, objectId, sizes);
  }

  /**
   * editMemoryRefusal for a run_operator or batch `selection` that enters Edit Mode or selects
   * elements (see setSelection): null when it does neither or names no object it can resolve
   * (applying it says why).
   */
  function selectionMemoryRefusal(
    p: AgentProject,
    operator: string,
    params: unknown,
    sel: z.infer<typeof selectionSchema> | undefined,
  ): string | null {
    if (!sel || !(sel.mode === 'EDIT' || (sel.mesh && p.state.mode === 'EDIT'))) return null;
    const ref = sel.active ?? sel.objects?.[sel.objects.length - 1];
    const id = ref === undefined ? p.state.activeId : (p.scene.resolveObject(ref)?.id ?? null);
    return id ? editMemoryRefusal(p, operator, params, id, sel.mesh) : null;
  }

  function setSelection(p: AgentProject, sel: z.infer<typeof selectionSchema>): void {
    const state = p.state;
    // element selections only exist in Edit Mode: one given for Object Mode would do nothing
    if (sel.mesh && (sel.mode === 'OBJECT' || (sel.mode === undefined && state.mode !== 'EDIT')))
      throw new ToolError(
        `selection.mesh selects vertices, edges or faces in Edit Mode: add mode 'EDIT' (selection: {objects: ['<mesh object>'], mode: 'EDIT', mesh: {faces: […]}}).`,
        'POLL_FAILED',
      );
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
        throw new ToolError(
          `Edit mode needs an active mesh object (selection.active)${active ? `: '${active.name}' is a ${active.type} object` : ''}.`,
          'POLL_FAILED',
        );
      if (state.mode !== 'EDIT' || sel.mode === 'EDIT') enterEditMode(p.context(), active.id);
      if (sel.mesh) {
        const mode = inferSelectMode(sel.mesh, sel.mesh.select_mode);
        state.selectMode = mode;
        state.meshSelection = meshSelection(p, active.id, sel.mesh, mode);
      }
    }
  }

  /**
   * Puts the agent's editor state back to what it was before a call (or a batch operation) that
   * failed: a failed call changes nothing, its selection included.
   */
  function restoreState(p: AgentProject, before: EditorState): void {
    Object.assign(p.state, before);
    // objects the failed operator deleted are not selected
    p.syncSelection();
  }

  /**
   * Why an operator id cannot run through run_operator, batch or edit_mesh, with the failure code,
   * or null when it can: an operator of the browser editor's UI (NOT_FOUND: the server does not
   * have it; the message says how to run it in a live editor with editor_command), an unknown id
   * (NOT_FOUND, with the closest ids) or a render operator that a tool replaces (FAILED).
   */
  function operatorRefusal(id: string): { error: string; code: ErrorCode } | null {
    const browser = browserUiOperator(id, !!registry.get(id)?.uiOnly);
    if (browser) return { error: browser, code: 'NOT_FOUND' };
    if (!registry.has(id))
      return {
        error: `Unknown operator '${id}'.${suggestOperators(registry, id)} Use list_operators.`,
        code: 'NOT_FOUND',
      };
    const tool = toolOnlyOperator(id);
    return tool ? { error: tool, code: 'FAILED' } : null;
  }

  /** The message of an error thrown inside a tool: an agent-facing error's own, else logged. */
  function thrownMessage(tool: string, err: unknown): string {
    if (err instanceof ToolError || err instanceof OperatorError) return err.message;
    log.warn({ err: errorMessage(err), tool, session: agent.id }, 'MCP tool failed');
    return `${tool} failed: ${errorMessage(err)}`;
  }

  /**
   * The error result of a run_operator or edit_mesh call that failed before or around its operator
   * (an unknown project or object, a refused operator id, a selection that cannot be applied),
   * shaped like an operator failure: the message on the first line, then the JSON {ok: false,
   * operator, error, code, selection} with the code the error carries (FAILED when it has none)
   * and the agent's editor state, which the call left as it was (no `selection` when the project
   * could not be opened).
   */
  function callFailure(tool: string, operator: string, err: unknown, p?: AgentProject): CallToolResult {
    const error = oneLine(thrownMessage(tool, err));
    return failure(error, {
      ok: false,
      operator,
      error,
      code: codeOf(err, 'FAILED'),
      ...(p ? { selection: selectionSummary(p) } : {}),
    });
  }

  tool(
    'run_operator',
    {
      title: 'Run operator',
      description:
        "Execute any operator by id with JSON parameters (see list_operators), as one undo step. Operators act on the agent's own selection like in Blender: use `selection` to choose objects, the active object and the mode (EDIT + mesh element selection for mesh.* operators) before running. Returns {ok, operator, result, reports, duration_ms, selection}. Every failure is an error result whose first line is the message, followed by JSON {ok: false, operator, error, code, selection} (plus result, reports and duration_ms when the operator ran; without selection when the project is unknown). `code`: INVALID_PARAMS (unknown, misspelled or invalid parameters: fix params), POLL_FAILED (wrong mode, selection or object type, or a `selection` that cannot be applied: mode EDIT without an active mesh, mesh elements without mode EDIT, an element index out of range, an edge [a, b] whose vertices no edge of the mesh connects, lists that select_mode does not select from (EDGE selects only edges, FACE only faces), all: true with lists; change the selection/mode), NOT_FOUND (an unknown project, object, datablock or operator id; unknown ids come with the closest ids, letter case ignored, the ids they are the beginning of first ('wm.save' → wm.save_mainfile), and ids of the browser editor's own UI operators (view3d.*, wm.*, screen.*, ed.*, render.render …) with what to use here instead where the tools offer it (object.duplicate {offset} for Shift+D's object.duplicate_move, transform.translate / rotate / resize for view3d.transform_modal, mesh.loopcut through edit_mesh for mesh.loopcut_pick, the undo tool for ed.undo, create_project for wm.read_homefile …), how to run them in a live editor (editor_command {command: 'run_operator', params: {operator, params}}) and what they do to the person's editor there) OUT_OF_MEMORY (the server's process would run out of memory: the operator is not run, or a mesh it reads was not loaded; the message says how much it needs, what is free and what to lower, where the operator has something to lower, and a browser editor that has the project open runs it in its own memory, except when the project, or all the projects the server has open, would then need more than the server keeps for them ('the project's … would then take about …', or '… already take about …' for a project already past it, or 'the open projects' …'): the server refuses an editor's changes for the same reason, so lower what the message names or delete objects and meshes the project no longer needs) or FAILED (the operator itself failed; render.render_software and render.render_animation are refused: use render_image / render_animation). The message is always one line (line breaks in names show as \\n). A call that fails changes nothing in the agent's editor state: a selection that cannot be applied is not applied at all, and when the operator fails the selection, active object and mode are put back as they were before the call (the failure's `selection` shows them).",
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
      // every failure is the message plus JSON with a code (see callFailure), like operator failures
      let p: AgentProject | undefined;
      let before: EditorState | undefined;
      let res: RunResult | undefined;
      try {
        p = await agent.project(project);
        const refused = operatorRefusal(operator);
        if (refused) throw new ToolError(refused.error, refused.code);
        before = { ...p.state };
        // an Edit Mode operator that would not fit is refused before its selection is built
        const early = selectionMemoryRefusal(p, operator, params, selection);
        if (early)
          return failure(`${operator} failed: ${early}`, {
            ok: false,
            operator,
            error: oneLine(early),
            code: 'OUT_OF_MEMORY',
            selection: selectionSummary(p),
          });
        // all or nothing: a selection that cannot be applied fails the call and changes nothing
        applySelection(p, selection);
        res = p.run(operator, params ?? {});
        // a call that fails changes nothing: the selection and mode it asked for are not kept
        if (!res.ok) restoreState(p, before);
        p.publishPresence();
        const out = {
          ok: res.ok,
          operator,
          result: res.result ?? null,
          ...(res.ok ? {} : { error: oneLine(res.error ?? 'unknown error'), code: errorCode(res) }),
          reports: res.reports,
          duration_ms: round(res.durationMs, 2),
          selection: selectionSummary(p),
        };
        if (!res.ok) return failure(`${operator} failed: ${res.error}`, out);
        return out;
      } catch (err) {
        if (p && before && !res?.ok) restoreState(p, before);
        return callFailure('run_operator', operator, err, p);
      }
    },
  );

  tool(
    'batch',
    {
      title: 'Run several operators',
      description:
        "Run a list of operators in order as a single undo step (one `undo` reverts all of them). Each operation is {operator, params, selection?}: `selection` (as in run_operator: objects, active object, mode, edit-mode mesh elements) is set before that operation runs and stays set for the following ones, for operators that act on the selection (object.convert, object.transform_apply, export_mesh.* use_selection …). An operation that fails changes nothing in the agent's editor state: its selection is not kept (all or nothing, as in run_operator), so the following operations see the selection of before it. With stop_on_error (default true) execution stops at the first failure; changes made before it are kept. Returns {ok, executed, failed, results, selection} with per operation {operator, ok, result | error + code, reports} — `code` is INVALID_PARAMS, POLL_FAILED, NOT_FOUND, OUT_OF_MEMORY or FAILED as in run_operator: a selection that cannot be applied fails its operation with an error starting 'selection: ', NOT_FOUND for an unknown object, else POLL_FAILED; unknown operator ids fail with NOT_FOUND and the closest ids, ids of the browser editor's UI operators (view3d.*, wm.*, render.render …) with NOT_FOUND, what to use instead, how to run them in a live editor (editor_command) and what they do there, render.render_software and render.render_animation with FAILED; `reports` are the operator's warnings and notes (e.g. 'scaled object: apply the scale'), exactly as run_operator returns them; operations_with_warnings counts operations that reported a WARNING or ERROR. When an operation failed, the result is an error whose first line is 'n of m operation(s) failed', followed by that JSON; when the call fails as a whole (an unknown project), the first line is the message and the JSON also has `error` and `code`.",
      annotations: EDIT,
      argsHint:
        'Each operation is {operator, params, selection} inside `operations` (batch {project, operations: [{operator, params: {…}, selection: {objects: […]}}, …], stop_on_error}).',
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
            selection: selectionSchema
              .optional()
              .describe(
                'Selection/mode to set before this operation (stays set for the following ones), as in run_operator',
              ),
          }),
        )
        .min(1)
        .max(200)
        .describe('Operations in order: [{operator, params, selection?}, …]'),
      stop_on_error: z.boolean().default(true),
    },
    async ({ project, operations, stop_on_error }) => {
      const results: Record<string, unknown>[] = [];
      let failed = 0;
      let p: AgentProject | undefined;
      try {
        p = await agent.project(project);
        const ap = p;
        ap.step(() => {
          for (const op of operations) {
            // refused like in run_operator: browser UI operators, unknown ids, render operators
            const refused = operatorRefusal(op.operator);
            if (refused) {
              failed++;
              results.push({
                operator: op.operator,
                ok: false,
                error: oneLine(refused.error),
                code: refused.code,
              });
              if (stop_on_error) break;
              continue;
            }
            // an operation that fails changes nothing: neither its selection nor the operator's
            const before = { ...ap.state };
            // an Edit Mode operator that would not fit is refused before its selection is built
            const early = selectionMemoryRefusal(ap, op.operator, op.params, op.selection);
            if (early) {
              failed++;
              results.push({
                operator: op.operator,
                ok: false,
                error: oneLine(early),
                code: 'OUT_OF_MEMORY',
              });
              if (stop_on_error) break;
              continue;
            }
            if (op.selection)
              try {
                applySelection(ap, op.selection);
              } catch (err) {
                if (!(err instanceof ToolError || err instanceof OperatorError)) throw err;
                failed++;
                results.push({
                  operator: op.operator,
                  ok: false,
                  error: oneLine(`selection: ${err.message}`),
                  // the error's own code: NOT_FOUND for an unknown object, else POLL_FAILED
                  code: codeOf(err, 'POLL_FAILED'),
                });
                if (stop_on_error) break;
                continue;
              }
            const res = ap.run(op.operator, op.params ?? {});
            results.push({
              operator: op.operator,
              ok: res.ok,
              ...(res.ok
                ? { result: res.result ?? null }
                : { error: oneLine(res.error ?? 'unknown error'), code: errorCode(res) }),
              // warnings and info the operator reported (like run_operator's `reports`)
              ...(res.reports.length ? { reports: res.reports } : {}),
            });
            if (!res.ok) {
              restoreState(ap, before);
              failed++;
              if (stop_on_error) break;
            }
          }
        });
      } catch (err) {
        // the call itself failed (an unknown project): the message, then the batch JSON with a code
        const error = oneLine(thrownMessage('batch', err));
        return failure(error, {
          ok: false,
          executed: results.length,
          failed,
          results,
          error,
          code: codeOf(err, 'FAILED'),
          ...(p ? { selection: selectionSummary(p) } : {}),
        });
      }
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
        "Set (or, with relative=true, change) the location (meters), rotation (radians, or rotation_degrees) and scale of one or more objects in their local (parent) space (operator object.transform_set). A channel that already has keyframes is keyed at the agent's current frame with its new value, so the object shows it there (its keys at other frames stay); with auto keying the location, rotation and scale are keyed at that frame. Relative mode adds location/rotation offsets to the values the object shows at the agent's current frame and multiplies its scale there (animated or driven channels included, like Blender's G / R / S), not to the stored values that get_object lists under `stored`. One undo step.",
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
        // from the values the objects show at the agent's frame (animated or driven channels there),
        // like Blender's G / R / S and a Python `location.x += 1`, not the stored ones; all of them
        // read before any is changed (like Blender's transform data), from one evaluation
        const shown = new FrameState(p.scene, p.state.frame);
        const changes = ids.map((id) => {
          const o = shown.get<ObjectData>('object', id) ?? p.scene.getObject(id)!;
          return {
            objects: [id],
            location: a.location ? o.location.map((v, i) => v + a.location![i]) : undefined,
            rotation_euler: rot ? o.rotation_euler.map((v, i) => v + rot[i]) : undefined,
            scale: a.scale ? o.scale.map((v, i) => v * a.scale![i]) : undefined,
          };
        });
        for (const change of changes) p.runOrThrow('object.transform_set', change);
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
        "Duplicate an object (Shift+D; linked=true shares the object data, a mesh, curve, text, armature, light or camera, like Alt+D), optionally offset (meters) and renamed. The copy gets its own copy of the object's keyframes and drivers and, unless linked, of its data's (shape keys, curve, light and camera values), as Blender's Shift+D does by default; Blender's linked duplicates (Alt+D) share the object's action with the original instead, so that later key edits change both, while here a linked copy gets its own keyframes too. An offset of an animated location is keyed like a move. The copy becomes selected and active.",
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
      description: `Add a modifier to the end of the stack of a mesh, curve or text object (non-destructive, like Blender; on curves and text it acts on the generated geometry). type is a Blender modifier identifier, e.g. SUBSURF {levels, render_levels}, MIRROR, ARRAY {count}, SOLIDIFY {thickness}, BOOLEAN {operation, object}, ARMATURE {object: "Rig"} (skinning; usually added by object.parent_to type ARMATURE_AUTO), CURVE {object: "Path", deform_axis} (bend along a curve). Object parameters accept object names; as in Blender, some take one object type only (a mesh for BOOLEAN object, ARRAY start_cap / end_cap and SHRINKWRAP target, an armature for ARMATURE object, a curve for CURVE object), and an object of another type is refused (update_modifier too), e.g. "Parameter 'object' of the Armature modifier takes an armature object; 'Box' is a mesh object" (after 'object.modifier_add failed: ' on a mesh object). Parameter names follow Blender: list_modifier_types {type} gives every type's parameters (JSON schema with enums, ranges and defaults); unknown parameter names and invalid values are rejected with that schema. Available types: ${modifierTypeList()}.`,
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
      description: `Apply (bake) a modifier into the object's mesh data, like Blender's Apply (destructive to the base mesh): the stack up to and including that modifier is baked into the mesh and the applied modifiers are removed (Blender applies only that modifier, to the mesh without the modifiers before it, and keeps those). As in Blender, the modifier is applied also when it is hidden in the viewport; modifiers before it that are hidden in the viewport or can change nothing are skipped and kept. Mesh objects only: convert a curve or text object to a mesh, which bakes all of its modifiers, with run_operator {operator: "object.convert", params: {target: "MESH"}, selection: {objects: ["<name>"]}} (object.convert acts on the selection). An object whose geometry did not evaluate fully (a modifier that failed or was skipped for memory, a mesh the server did not load: the problems of get_scene) is refused with those errors and nothing changes; when memory was the cause, code OUT_OF_MEMORY follows as JSON after the message. As in Blender, a modifier that can change nothing is not applied and stays (a Boolean, Armature or Curve modifier without an object, a Shrinkwrap without a target, a Bevel of width 0, a Subdivision Surface with 0 viewport levels, …): 'object.modifier_apply failed: Modifier is disabled, skipping apply: the Boolean modifier 'Boolean' has no object, so it changes nothing; change it with object.modifier_set or remove it with object.modifier_remove'.`,
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
        "Run an edit-mode operator on a mesh object: enters Edit Mode on the object (headless), selects the given vertices/edges/faces (default: everything), runs the operator (mesh.* such as mesh.extrude_region_move {value}, mesh.inset, mesh.subdivide, mesh.loopcut, mesh.delete, mesh.merge, or transform.translate/rotate/resize to move the selected elements), then returns to Object Mode; the object is then the agent's selected and active object. Use list_operators (search 'mesh.') for the catalogue and parameters. One undo step. Returns {ok, operator, result, reports, mesh, selection_after}. Every failure is an error result whose first line is the message, followed by JSON {ok: false, operator, error, code, selection} (plus result, reports, mesh and selection_after when the operator ran; without selection when the project is unknown), with `code` as in run_operator: NOT_FOUND (an unknown project, object or operator id; ids of the browser editor's UI operators say what to use instead, e.g. mesh.loopcut {edge} for mesh.loopcut_pick and transform.* for view3d.transform_modal, how to run them in a live editor (editor_command) and what they do there), POLL_FAILED (not a mesh object, an element index out of range, an edge [a, b] whose vertices no edge of the mesh connects, lists that select_mode does not select from (EDGE selects only edges, FACE only faces), all: true with lists, the operator's preconditions), INVALID_PARAMS (fix params), OUT_OF_MEMORY (the server's process would run out of memory for Edit Mode or the operator on this mesh: the message says what to lower, where there is something to lower, and a browser editor runs it in its own memory, except when the project, or all the projects the server has open, would then need more than the server keeps for them ('the project's … would then take about …', or '… already take about …' for a project already past it, or 'the open projects' …'): the server refuses an editor's changes for the same reason) or FAILED (the operator itself failed). A call that fails changes nothing in the agent's editor state: its selection, active object and mode stay as they were (the failure's `selection` shows them).",
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
      select_mode: selectModeArg,
    },
    async (a) => {
      // every failure is the message plus JSON with a code (see callFailure), like operator failures
      let p: AgentProject | undefined;
      let before: EditorState | undefined;
      let res: RunResult | undefined;
      try {
        p = await agent.project(a.project);
        const ap = p;
        const o = requireObject(ap, a.object);
        if (o.type !== 'MESH' || !o.data)
          throw new ToolError(`'${o.name}' is not a mesh object.`, 'POLL_FAILED');
        const refused = operatorRefusal(a.operator);
        if (refused) throw new ToolError(refused.error, refused.code);
        const mode = inferSelectMode(a.selection, a.select_mode);
        before = { ...ap.state };
        // an operator that would not fit is refused before Edit Mode and its selection are built
        const early = editMemoryRefusal(ap, a.operator, a.params, o.id, a.selection);
        if (early) {
          const c = ap.scene.meshCounts(o.data)!;
          return failure(`${a.operator} failed: ${early}`, {
            ok: false,
            operator: a.operator,
            error: oneLine(early),
            code: 'OUT_OF_MEMORY',
            mesh: { vertices: c.vertices, faces: c.faces, triangles: c.corners - 2 * c.faces },
            selection: selectionSummary(ap),
          });
        }
        // an element index out of range or an edge the mesh does not have throws before the
        // operator runs (POLL_FAILED)
        res = ap.step(() => {
          ap.state.mode = 'OBJECT';
          ap.state.selectedIds = [o.id];
          ap.state.activeId = o.id;
          enterEditMode(ap.context(), o.id);
          ap.state.selectMode = mode;
          ap.state.meshSelection = meshSelection(ap, o.id, a.selection, mode);
          try {
            return ap.run(a.operator, a.params ?? {});
          } finally {
            ap.state.mode = 'OBJECT';
          }
        });
        const after = ap.scene.getObject(o.id);
        const mesh = after?.data ? ap.scene.getMesh(after.data) : null;
        const sel = ap.state.meshSelection;
        const out = {
          ok: res.ok,
          operator: a.operator,
          result: res.result ?? null,
          ...(res.ok ? {} : { error: oneLine(res.error ?? 'unknown error'), code: errorCode(res) }),
          reports: res.reports,
          mesh: mesh ? meshStats(mesh) : null,
          selection_after: {
            select_mode: ap.state.selectMode,
            verts: [...sel.verts].slice(0, 500),
            faces: [...sel.faces].slice(0, 500),
          },
        };
        // a call that fails changes nothing: the agent's selection and mode stay as they were
        if (!res.ok) restoreState(ap, before);
        ap.publishPresence();
        if (!res.ok)
          return failure(`${a.operator} failed: ${res.error}`, { ...out, selection: selectionSummary(ap) });
        return out;
      } catch (err) {
        if (p && before && !res?.ok) restoreState(p, before);
        return callFailure('edit_mesh', a.operator, err, p);
      }
    },
  );

  // ---------------------------------------------------------------- animation & settings

  tool(
    'insert_keyframe',
    {
      title: 'Insert keyframe',
      description:
        'Insert a keyframe at `frame` on an animatable property (Blender data paths). Object: location, rotation_euler (radians), scale, color; nested object paths: pose.bones["Bone"].location / rotation_euler / scale (armature bones, bone axes), pose.bones["Bone"].constraints["IK"].influence, constraints["Name"].influence (or another numeric constraint parameter), modifiers["Name"].<parameter>, particle_systems["Name"].<setting>. \'data.<path>\' keys the object\'s data: light (data.energy, data.color), camera (data.lens, data.dof_focus_distance), curve or text (data.bevel_factor_end to grow a curve, data.extrude, data.eval_time, data.size, data.splines[0].points[1].co) or mesh shape keys (data.shape_keys["Smile"].value, or just shape_keys["Smile"].value). \'material.<path>\' keys the material in `material_slot` (default: the first): material.base_color, material.roughness, material.emission_strength, procedural texture parameters such as material.textures.base_color.procedural.scale. object=\'world\' keys world settings (color, strength, sun_elevation, sun_rotation, mist_density …). `value` (number or vector) sets the keyed value, otherwise the value the property shows at the agent\'s current frame is keyed (an animated or driven value there, as Blender keys the current value), also into another `frame`; `index` keys one channel. For many keys at once use run_operator anim.keyframes_insert_many; drivers: anim.driver_add; F-curve modifiers (noise, cycles): anim.fmodifier_add / anim.extrapolation_set.',
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
            // without a value, the value the shape key shows at the agent's frame (an animated or
            // driven value there), as anim.keyframe_insert_property keys the other targets
            const shown = new FrameState(p.scene, p.state.frame).get<Record<string, unknown>>('mesh', t.id);
            const current = readChannel(shown ?? sample, t.path, index) ?? readChannel(sample, t.path, index);
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
          ' The history belongs to the MCP session, or — when the client sends an agent id (header x-mcp-agent-id or ?agent=<id> on the endpoint URL; scripts/mcp.mjs sends one) — to that agent id across sessions, so one-shot CLI calls can undo each other. It ends when the server restarts or the project is unloaded.' +
          ` It keeps the last ${ctx.historyLimits.maxSteps} steps per project and at most ${formatMb(ctx.historyLimits.maxBytes)} of replaced or deleted data (older steps are dropped; the newest step is always kept).`,
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
        // objects the steps removed are no longer selected (also in the presence others see)
        p.syncSelection();
        const dropped = p.history.stats().dropped_steps;
        return {
          [kind === 'undo' ? 'undone' : 'redone']: done,
          can_undo: p.undo.canUndo(),
          can_redo: p.undo.canRedo(),
          ...(done < steps
            ? {
                note:
                  `${done ? `Only ${done} of ${steps} step(s)` : 'Nothing'} to ${kind} in ${historyScope()}.` +
                  (kind === 'undo' && dropped
                    ? ` The history keeps the last ${p.history.maxSteps} steps and at most ${formatMb(p.history.maxBytes)} of replaced or deleted data per project: ${dropped} older step(s) were dropped.`
                    : ''),
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
      description: `Import a 3D file (gltf, glb, obj, stl, ply) into a project from base64 data or an http(s) URL (max ${MAX_IMPORT_BYTES / 1024 / 1024} MB). Y-up formats are converted to the editor's Z-up space. Imported objects become selected. One undo step. The import runs in the server's own process, which checks first that it has the memory for it, counted from the file: a binary STL by its triangles and distinct vertices, an ASCII STL by its size, faces and vertices, an OBJ file by its size, objects, vertices and faces, a glTF file by the meshes, nodes and keyframes its JSON makes the importer decode and by the images embedded in it, a PLY file by the elements its body holds. One it does not have the memory for fails before it starts with 'Import failed: not run on the server: …', what to lower and code OUT_OF_MEMORY (as JSON after the message). When the server's free heap is too small, the message also says how a browser editor that has the project open runs the import in its own memory (editor_command run_operator with the file in base64); when the project, or all the projects the server has open, would then need more than the server keeps for them ('the project's … would then take about …', or '… already take about …' for a project already past it, or 'the open projects' …'), it does not, as the server refuses that editor's changes for the same reason.`,
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
      // the server's memory check, as for the import_* operators of run_operator (core operators/memory.ts)
      const refused = importMemoryRefusal(p.scene, fmt, bytes);
      if (refused) throw new ToolError(`Import failed: ${refused}`, 'OUT_OF_MEMORY');
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
        "Export the scene (or some objects) as glb, gltf, obj, stl or ply at a frame (default: the agent's current frame). OBJ/STL/PLY hold world-space meshes. glTF/GLB keep the hierarchy (armature bones as nodes, BONE-parented objects under their bone), materials (procedural textures baked into images, by default about 64 texels per metre of surface (512–2048 px per mesh), or bake_resolution px; meshes without UVs get generated UVs for them), cameras, lights and the animation sampled once per frame (2 or 4 times per frame where an object's motion curves between frames, e.g. on a fast orbit; motion that is straight between frames, like LINEAR keys or rigid bodies, keeps one key per frame) over the scene frame range from the evaluated scene (keyframes, drivers, constraints, IK, rigid body physics), with shape keys as morph targets and Armature-deformed meshes as skins. Returns {format, filename, mime, bytes, frame, objects, apply_modifiers, download_url, elapsed_ms, warnings} plus the file as an embedded base64 resource (up to 20 MiB) and a download link. The export runs in a render process, so it does not hold up the server; a glTF export samples every frame of the scene range, which takes seconds for long ranges and large scenes. download_url (an HTTP endpoint of this server) exports again when it is fetched, with the same options (format, objects, apply_modifiers, frame, bake_resolution): the same file as the embedded one while the scene is unchanged, the project's current state after later edits. `warnings` lists what the format could not represent — check it: e.g. area lights become point lights, other animated deformation (modifier stacks) is baked into per-frame morph targets, image textures on meshes without UVs are dropped. The export runs in a render process: one that needs more memory than a render process has fails with 'Export failed: out of memory: …', what to lower and code OUT_OF_MEMORY (as JSON after the message) while the server keeps running: every export evaluates all meshes of the scene with their modifiers at render settings (SUBSURF render_levels), also those it does not write and with apply_modifiers: false, which lower only the memory of writing the file. Without render processes (RENDER_WORKERS=0, or they could not start) the export runs in the server's own process, and one it does not have the memory for is not started ('Export failed: out of memory: this export was not started: …', what to lower and code OUT_OF_MEMORY): that check counts only the meshes shown in renders, so hiding a heavy mesh from renders (hide_render; an export without objects leaves it out of the file) lets the export start.",
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
      bake_resolution: z
        .number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .describe(
          'glTF/GLB: size in pixels of the square images procedural textures are baked into, for every bake (64–4096). Default: per mesh, about 64 texels per metre of its surface (512–2048 px), within a budget for the whole export; raise it for large objects whose baked texture looks blurry',
        ),
    },
    async (a, extra) => {
      const p = await agent.project(a.project);
      const objectIds = a.objects?.map((r) => requireObject(p, r).id);
      const frame = a.frame ?? p.state.frame;
      let res;
      try {
        // in a render process: a large glTF export (animation sampled per frame, texture bakes)
        // takes seconds and must not hold up the event loop that serves editors and agents
        res = await renderer.exportScene({
          scene: p.scene,
          projectId: p.id,
          format: a.format as ExportFormat,
          options: { objectIds, applyModifiers: a.apply_modifiers, frame, bakeResolution: a.bake_resolution },
          signal: extra.signal,
        });
      } catch (err) {
        if (isCancelled(err)) throw new ToolError('The export was cancelled.');
        if (isNotImplemented(err))
          throw new ToolError(`Exporting ${a.format} is not available in this build: ${errorMessage(err)}`);
        // out of memory (code OUT_OF_MEMORY, with what an export can lower), or interrupted
        if (isOutOfMemory(err)) throw renderToolError(err, 'Export');
        throw new ToolError(`Export failed: ${errorMessage(err)}`);
      }
      const filename = safeFileName(p.scene.name, res.extension);
      // the link exports with the same options when it is fetched (GET …/export, see api/projects.ts)
      const query = new URLSearchParams({ format: a.format, frame: String(frame) });
      if (objectIds) query.set('objects', objectIds.join(','));
      if (!a.apply_modifiers) query.set('apply_modifiers', 'false');
      if (a.bake_resolution !== undefined) query.set('bake_resolution', String(a.bake_resolution));
      const downloadUrl = `${baseUrl(extra)}/api/projects/${encodeURIComponent(p.id)}/export?${query}`;
      const info = {
        format: a.format,
        filename,
        mime: res.mime,
        bytes: res.data.byteLength,
        frame,
        objects: objectIds ? objectIds.map((id) => p.scene.getObject(id)?.name ?? id) : 'all',
        apply_modifiers: a.apply_modifiers,
        ...(a.bake_resolution !== undefined ? { bake_resolution: a.bake_resolution } : {}),
        download_url: downloadUrl,
        elapsed_ms: res.elapsedMs,
        // what the format could not represent (procedural textures that need UVs, area lights …)
        warnings: res.warnings,
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
          'Download: exported again on request with the same options (format, objects, apply_modifiers, frame, bake_resolution)',
      });
      return { content };
    },
  );

  // ---------------------------------------------------------------- rendering & live editors

  tool(
    'render_image',
    {
      title: 'Render image',
      description: `Render a PNG of the scene to check your work or make a final picture. engine RASTER (fast, default for most scenes) or PATHTRACER (physically based, soft shadows, global illumination; default: the scene's render engine). RASTER renders use a connected browser editor (WebGL, the look of its Rendered viewport shading whatever shading it shows; SOLID: grey clay) when available, otherwise the server's software rasterizer: renderer auto waits ${AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000} s for the editor's image and then renders on the server (\`note\` says why), renderer browser waits up to ${BROWSER_RASTER_TIMEOUT_MS / 1000} s (an editor without GPU acceleration took ${measuredBrowserImages(BROWSER_RASTER_SECONDS)}) and then fails with what to do instead; an editor does not start a RASTER image whose geometry at the render settings would not fit into its tab's JavaScript heap (renderer auto then renders on the server, \`note\` says why; renderer browser fails with why and what to lower); an editor may still be drawing an image the server stopped waiting for, and holds up its next renders and commands until it has: meanwhile renders go to another connected editor that is not busy, else renderer auto renders on the server without asking it (\`note\` says so), as it also does for ${SLOW_EDITOR_RETRY_MS / 1000} s after an editor needed longer than auto waits for a RASTER image (for a smaller image, when that time scaled to its pixels is longer too), and for a larger image after one that took ${SCALE_UP_MIN_MS / 1000} s or more, when that time scaled to its pixels is longer than auto waits; PATHTRACER renders run on the server's CPU cores in parallel (samples per pixel, max_bounces, denoise, time_limit in seconds — the render stops sampling when the time is up, after at least one sample per pixel), or with renderer browser on a browser editor's render workers (as many as the tab's memory allows; a path trace that would not fit into it is not started, and the error says why). The server's software rasterizer (RASTER without a browser editor) draws no shadows, and its glossy reflections come from one small reflection probe in front of what the image centre shows, looked up by direction only: water, floors and large glossy tables far from that point can show reflections the path tracer does not (a wide smear of a nearby object, a far end that is too bright), so judge shadows and reflections with PATHTRACER. The server renders in render processes of its own: grey clay (shading SOLID) at 1280×720 took ${measuredOnServer(SERVER_SOLID_SECONDS)}, and a render that needs more memory than a render process has fails with 'Rendering failed: out of memory: …', what to do and code OUT_OF_MEMORY (as JSON after the message) while the server keeps running. Without render processes (RENDER_WORKERS=0, or they could not start) the server renders in its own process, and a render it does not have the memory for is not started ('Rendering failed: out of memory: this render was not started: …', what to do and code OUT_OF_MEMORY): that check counts only the meshes shown in renders, so hiding a heavy mesh from renders (hide_render) lets the render start. Film > Transparent (set_scene_settings film_transparent) gives a transparent background with both engines. Defaults to the scene camera; pass \`camera\` (camera object) or \`view\` {position, target, up?, fov_degrees? (VERTICAL angle) | lens? (mm)} for another viewpoint. Max 2048x2048 (path tracing: 2048x1280). Long renders send progress notifications. The JSON text after the image gives renderer, engine, size, frame, timing, for path tracing samples (reached) and requested_samples, and \`warnings\` (e.g. textures that could not be used, or degenerate triangles skipped, with the objects they belong to).`,
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
          `auto: RASTER on a connected browser editor (WebGL, the look of its Rendered viewport shading; the server's rasterizer when none is connected, the editor fails, it has no image after ${AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000} s, it is still busy with an earlier image or it was too slow for its last one: asked again ${SLOW_EDITOR_RETRY_MS / 1000} s later), PATHTRACER on the server (all its cores); browser: only a browser editor: RASTER with WebGL (waits up to ${BROWSER_RASTER_TIMEOUT_MS / 1000} s; an editor without GPU acceleration took ${measuredBrowserImages(BROWSER_RASTER_SECONDS)}), PATHTRACER on the editor's render workers, as many as the tab's memory allows (samples, max_bounces, denoise, time_limit, seed; waits time_limit + ${BROWSER_PATHTRACE_EXTRA_MS / 1000} s; the result does not include the samples reached; a path trace that would not fit into the tab's memory fails with the editor's reason); software: always the server`,
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
      let fallbackAdvice = "Open the project in a browser or use renderer 'software'.";
      if (a.renderer === 'browser' || (a.renderer === 'auto' && engine === 'RASTER')) {
        const renderer = a.renderer;
        const { conn, busy, slow } = renderEditor(p.room, {
          client: a.client,
          renderer,
          shading: a.shading,
          pixels: width * height,
        });
        if (conn && busy && a.renderer === 'auto')
          fallbackReason =
            `the browser editor is still busy with an earlier request that the server stopped waiting for (${busy}): ` +
            "renderer 'auto' renders on the server until it has finished";
        else if (conn && slow && a.renderer === 'auto')
          fallbackReason =
            `the browser editor ${slow}: renderer 'auto' renders on the server and asks that editor again ` +
            `${SLOW_EDITOR_RETRY_MS / 1000} s after that image; renderer 'browser' waits up to ${BROWSER_RASTER_TIMEOUT_MS / 1000} s`;
        else if (conn) {
          // the editor path traces on its render workers when asked (SOLID shading rasterizes)
          const browserPT = engine === 'PATHTRACER' && a.shading !== 'SOLID';
          const timeLimit = a.time_limit ?? DEFAULT_IMAGE_TIME_LIMIT;
          const requested = a.samples ?? rs.samples;
          // path tracing: time_limit plus loading, compiling, denoising and the PNG; RASTER: long
          // enough for heavy scenes in software WebGL when the browser is asked for, short with
          // 'auto', which then renders on the server
          const timeoutMs = browserRenderTimeout(a.renderer, browserPT, timeLimit);
          // long browser renders send no progress of their own: keep the request alive (renderer
          // 'browser' only: with 'auto' the server's renderer may follow, with its own progress)
          const t0 = Date.now();
          const stopKeepAlive =
            a.renderer === 'browser'
              ? keepAlive(extra, (seconds) =>
                  browserPT
                    ? {
                        progress: Math.min(seconds, Math.ceil(timeLimit)),
                        total: Math.ceil(timeLimit),
                        message: `path tracing in the browser editor: ${seconds} s (time_limit ${timeLimit} s)`,
                      }
                    : {
                        progress: seconds,
                        total: timeoutMs / 1000,
                        message: `rendering in the browser editor: ${seconds} s (waiting up to ${timeoutMs / 1000} s)`,
                      },
                )
              : () => undefined;
          // the size of a RASTER image, for the slow-editor rule of the next ones (slowBrowserRaster)
          if (!browserPT) noteBrowserRaster(conn, width, height);
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
              timeoutMs,
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
            const failed = browserRenderFailure(err, {
              renderer: a.renderer,
              pathTrace: browserPT,
              timeoutMs,
              timeLimit,
              shading: a.shading,
              busy,
            });
            fallbackReason = failed.reason;
            fallbackAdvice = failed.advice;
          } finally {
            stopKeepAlive();
          }
        } else fallbackReason = 'no connected browser editor can render';
        if (a.renderer === 'browser') throw new ToolError(`${fallbackReason}. ${fallbackAdvice}`);
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
        "Render a range of frames on the server to check motion (keyframes, drivers, F-curve modifiers, constraints, armatures, physics, turntables) or to make an animated result. format CONTACT_SHEET (default: one PNG showing every rendered frame in a labelled grid — the easiest way to review a whole animation; sample long ranges to 12–24 tiles with frame_step), GIF (animated, 256 colours), APNG (animated PNG, returned as image/png) or PNG_SEQUENCE (one PNG per frame, returned as embedded image/png resources named frame_0001.png …). Frames frame_start..frame_end every frame_step (default: the scene frame range). Camera: `camera`, else the scene camera, else one fixed automatic view framing all frames (returned as view). engine RASTER (fast) or PATHTRACER (frames path traced in parallel on all CPU cores; keep size, samples and frame count small). time_limit bounds the whole render (default 60 s): path traced frames get an equal share and stop sampling early, frames that cannot start in time are dropped (truncated: true). Path traced results report requested_samples, samples_reached {min, mean, max} and frame_samples (the samples per pixel each frame reached, aligned with frames) plus undersampled_frames (frames that stopped early). store=true keeps the files on the server for an hour and returns download links (results too large to embed are stored automatically). The frames render in the server's render processes: a render that needs more memory than a render process has fails with 'Rendering the animation failed: out of memory: …', what to lower and code OUT_OF_MEMORY (as JSON after the message) while the server keeps running. Without render processes (RENDER_WORKERS=0, or they could not start) the frames render in the server's own process, and an animation it does not have the memory for is not started ('Rendering the animation failed: out of memory: this render was not started: …', what to lower and code OUT_OF_MEMORY): that check counts only the meshes shown in renders, so hiding a heavy mesh from renders (hide_render) lets it start.",
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
      samples: animationSamplesArg,
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
      description: `Send a UI command to a live browser editor that has the project open (most recently active one, or \`client\`; get_connected_clients lists them). Commands and their \`params\`: ${editorCommandList()}. run_operator runs the operators of the browser editor's own user interface (view3d.*, wm.*, screen.*, ed.* …) on the person's editor: its selection, view, frame and undo history, windows on the person's screen, even its project (wm.read_homefile switches that editor to a new project, so it leaves this one before it can answer, and the error says so) and the person's clipboard (wm.share); the run_operator tool refuses them with a message that says what each one does there. Unknown commands and unknown or misspelled parameter names are rejected with suggestions before anything is sent. Fails when no browser editor accepting UI commands is connected, or when the editor's connection to the project closes before it answers. \`timeout_ms\` (default ${DEFAULT_EDITOR_TIMEOUT_MS}, at most ${MAX_EDITOR_TIMEOUT_MS}: under the 60 s request timeout MCP SDK clients use by default) is how long to wait for the editor's answer. In an editor without GPU acceleration (software WebGL, e.g. a headless browser) a screenshot of a heavy scene in MATERIAL or RENDERED shading takes seconds, and the first screenshot or viewport frame in each of them after the editor opened the project longer (${measured(`${FIRST_SHADING_SECONDS} for a scene with 71 materials`)}): the editor builds and compiles the scene's materials for that shading and keeps them, so later screenshots in it, and the viewport switching to it, compile nothing, also after the viewport turned its anti-aliasing off (for slow frames or more than a million triangles) and after material edits that change values (colours, roughness, texture settings), while an edit that needs a shader no material had (coat or sheen turned on, a procedural texture on a set of channels that no other material has) makes the next one in each of these two shadings compile it (${measured(NEW_SHADER_SECONDS)}); SOLID and WIREFRAME screenshots wait until the frame the viewport is drawing is done, also one that compiles; a screenshot of a scene with millions of triangles takes half a second or more in any shading, and the first WIREFRAME screenshot or frame of such a scene several times as long (the editor builds the wires of every mesh); the other commands wait while the editor's main thread is busy (during a screenshot, seconds after the viewport switched to MATERIAL or RENDERED for the first time, while it builds the scene's materials, while it carries out a command: with 4 million triangles in SOLID shading a select took ${MILLIONS_SELECT_SECONDS}, while it applies a change made elsewhere: ${CHANGE_APPLY_SECONDS} for an agent's move of an object among 4 million triangles, while its statistics overlay counts every mesh again, which it does when the frame rate it shows changes as the viewport keeps drawing (0.19–0.25 s with 4 million triangles, 1.1–1.8 s after a person's own edit in that editor), and while it copies the frame its viewport drew into the project's thumbnail (at most 0.1 s with 4 million triangles), once per change: 3 s after it, or, while the viewport has not drawn it yet, at the first of its tries every 0.5 s (for up to 30 s) after that (3.0–5.1 s after a person's own edit); the viewport's frames do not hold them up), and the server holds up every request, these too, while it saves a project 1.5 s after a change (and twice more right after it), while it reads back from storage a project that an editor has open (once a minute) and while it sends a project to an editor that opens it (with 4 million triangles ${SAVE_HOLD_SECONDS} for a save and at most ${AFTER_SAVE_HOLD_SECONDS} for each of the two after it, ${READ_HOLD_SECONDS} for the others). So raise timeout_ms there, take screenshots with shading 'SOLID' (grey clay, much faster), take a quick look with render_image {shading: 'SOLID'} (grey clay, rendered on the server while the editor is busy and when the scene's render engine is PATHTRACER: ${measuredOnServer(SERVER_SOLID_SECONDS)}; a scene that needs more memory than a server render has fails with 'Rendering failed: out of memory: …' and code OUT_OF_MEMORY, and then retry the screenshot with a larger timeout_ms) and make final images with render_image. On a timeout the error says so and what to do; the editor may still carry the command out, and its next commands and renders wait until it has (a later timeout names that earlier request; render_image renderer auto renders on the server meanwhile): a screenshot that timed out still compiles what it needs and keeps it, so retrying it waits for the rest and compiles nothing again.`,
      annotations: { ...EDIT, openWorldHint: true },
      argsHint: 'Command parameters go inside `params` (editor_command {project, command, params: {…}}).',
    },
    {
      project: projectArg,
      command: z.string().min(1).describe('UI command, e.g. view.set_view (see the description)'),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The command's parameters, e.g. {view: 'TOP'}"),
      client: z.string().optional().describe('Connection id or client name'),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(MAX_EDITOR_TIMEOUT_MS)
        .default(DEFAULT_EDITOR_TIMEOUT_MS)
        .describe(
          `How long to wait for the editor's answer in ms (default ${DEFAULT_EDITOR_TIMEOUT_MS}, at most ${MAX_EDITOR_TIMEOUT_MS}, under the 60 s default request timeout of MCP SDK clients); in software WebGL the first screenshot or viewport frame of a heavy scene in MATERIAL or RENDERED shading takes longer (${measured(`${FIRST_SHADING_SECONDS} for a scene with 71 materials`)}: the editor builds and compiles that shading's materials and keeps them, so later ones compile nothing), one after a material edit that needs a shader no material had as long as compiling that shader takes (${measured(NEW_SHADER_SECONDS)}), and every screenshot half a second or more in any shading with millions of triangles, the first WIREFRAME one several times as long`,
        ),
    },
    async (a, extra) => {
      // a misspelled command or parameter would be ignored by the editor: refuse it first
      checkEditorCommand(a.command, a.params ?? {});
      const p = await agent.project(a.project);
      // what the editor is still busy with (requests the server stopped waiting for), for a timeout
      const target = p.room.pickRpcTarget('ui', a.client);
      const busy = target ? describeLateRpcs(blockingLateRpcs(p.room.lateRpcs(target))) : null;
      // the editor sends no progress: keep requests with a progress token alive while it works
      const stopKeepAlive = keepAlive(extra, (seconds) => ({
        progress: seconds,
        total: a.timeout_ms / 1000,
        message: `waiting for the editor: ${seconds} s (timeout_ms ${a.timeout_ms})`,
      }));
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
        if (err instanceof RpcError && err.code === 'TIMEOUT')
          throw new ToolError(editorTimeoutMessage(a.command, a.timeout_ms, busy, a.params ?? {}));
        // the editor left the project before it answered (wm.read_homefile does so on purpose)
        if (err instanceof RpcError && err.code === 'CLOSED')
          throw new ToolError(editorClosedMessage(a.command, a.params ?? {}));
        throw new ToolError(`editor_command '${a.command}' failed: ${errorMessage(err)}`);
      } finally {
        stopKeepAlive();
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
