import { suggestNames } from '@3d-editor/core';
import type { LateRpc } from '../sync/room';
import { ToolError } from './agent';

/*
 * The UI commands of browser editors (MCP editor_command → RPC `ui`, run by the web app's
 * apps/web/src/editor/rpc.ts) and their parameters. The `params` of editor_command are a free-form
 * map, and the editor reads only the keys it knows, so a misspelled parameter used to be ignored
 * silently: `view.set_view {veiw: 'TOP'}` answered ok and showed the default FRONT view. The server
 * therefore checks the command and the names of its parameters before it sends the request (also
 * when no editor is connected), with did-you-mean suggestions and the valid names, like tool
 * arguments and operator parameters; values the editor reads loosely are checked here too, and so
 * is the screenshot's `shading` (an editor older than that parameter would ignore it). The editor
 * checks the other values (view, shading and mode names, object names, frame numbers).
 */

/** What is wrong with a parameter value, and the values the agent may have meant. */
type ParamProblem = string | { problem: string; suggestions: string[] };

type ParamCheck = (value: unknown) => ParamProblem | null;

interface EditorParam {
  /** What the parameter is (for the tool description and errors). */
  doc: string;
  /** Checks a value before it is sent: the problem, or null when the value is fine. */
  check?: ParamCheck;
}

export interface EditorCommand {
  /** What the command does. */
  doc: string;
  params: Record<string, EditorParam>;
}

const VIEWS = 'FRONT | BACK | RIGHT | LEFT | TOP | BOTTOM | CAMERA';
/** The viewport shadings (view.shading, screenshot). */
const SHADING_VALUES = ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED'] as const;
const SHADINGS = SHADING_VALUES.join(' | ');
const MODES = 'OBJECT | EDIT | SCULPT | VERTEX_PAINT';
/** Largest screenshot side (pixels). */
const MAX_SCREENSHOT = 4096;

const pixels: ParamCheck = (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= MAX_SCREENSHOT
    ? null
    : `must be a whole number of pixels from 16 to ${MAX_SCREENSHOT}`;
const text: ParamCheck = (v) => (typeof v === 'string' ? null : 'must be a string');
const record: ParamCheck = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? null
    : 'must be an object of operator parameters';
/**
 * One of `values`, letter case ignored like the editor reads them (rpc.ts uiEnumParam); a
 * misspelled value gets the closest ones as suggestions.
 */
const oneOf =
  (values: readonly string[]): ParamCheck =>
  (v) =>
    typeof v === 'string' && values.includes(v.toUpperCase())
      ? null
      : {
          problem: `must be ${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}, letter case ignored`,
          suggestions: typeof v === 'string' && v.trim() ? nearest(v.toUpperCase(), values) : [],
        };

/** The commands a browser editor runs, by name (keep in sync with apps/web/src/editor/rpc.ts). */
export const EDITOR_COMMANDS: Record<string, EditorCommand> = {
  'view.frame_all': { doc: 'frame every visible object in the viewport, out of the camera view', params: {} },
  'view.frame_selected': {
    doc:
      "frame the editor's selection, out of the camera view: its selected objects (every visible one when " +
      'none is selected), in Edit Mode the selected vertices of its active mesh (all of them when none is)',
    params: {},
  },
  'view.set_view': {
    doc: 'switch to a standard view or the camera view',
    params: { view: { doc: `${VIEWS} (default FRONT)` }, type: { doc: 'the same as view' } },
  },
  'view.shading': {
    doc: 'switch the viewport shading',
    params: { shading: { doc: `${SHADINGS} (default SOLID)` }, type: { doc: 'the same as shading' } },
  },
  select: {
    doc: "select objects in the editor (the editor's own selection, not the agent's)",
    params: { objects: { doc: 'object names or ids; the last one becomes active; [] deselects everything' } },
  },
  set_mode: {
    doc: "switch the editor's interaction mode",
    params: { mode: { doc: `${MODES} (default OBJECT)` } },
  },
  set_frame: { doc: "set the editor's current frame", params: { frame: { doc: 'frame number (required)' } } },
  play: { doc: 'start or stop playback', params: { playing: { doc: 'true (default) or false' } } },
  notify: {
    doc: 'show a message to the person at the editor',
    params: { message: { doc: 'the text', check: text } },
  },
  run_operator: {
    doc: 'run an operator in the editor: for UI-only operators such as view3d.*; edit the document with the run_operator tool',
    params: {
      operator: { doc: 'operator id (required)', check: text },
      params: { doc: 'operator parameters', check: record },
    },
  },
  screenshot: {
    doc:
      "a PNG of the editor's viewport as the person sees it: its view (the scene camera when it looks through it), " +
      "in the viewport's shading or `shading`, without overlays, rasterized (WebGL) like the viewport, never path " +
      "traced: MATERIAL is Material Preview (studio lighting), RENDERED the Rendered viewport (the scene's lights " +
      'and world) also when the render engine is PATHTRACER (render_image path traces)',
    params: {
      width: { doc: 'pixels (default: the viewport size)', check: pixels },
      height: { doc: 'pixels (default: the viewport size)', check: pixels },
      shading: { doc: `${SHADINGS} (default: the viewport's shading)`, check: oneOf(SHADING_VALUES) },
    },
  },
  get_view: { doc: 'the viewport camera (target, distance, yaw, pitch, ortho, camera view)', params: {} },
};

/** Default `timeout_ms` of editor_command: how long the server waits for the editor's answer. */
export const DEFAULT_EDITOR_TIMEOUT_MS = 10_000;
/**
 * The longest the server waits for a browser editor outside path tracing (editor_command's largest
 * `timeout_ms`, render_image's wait for a RASTER image with renderer 'browser'): under the 60 s
 * request timeout that MCP clients built on the TypeScript SDK use by default, so the server's
 * error, which says what to do, arrives before such a client gives up with "Request timed out".
 */
export const MAX_EDITOR_WAIT_MS = 55_000;
/** Largest `timeout_ms` of editor_command. */
export const MAX_EDITOR_TIMEOUT_MS = MAX_EDITOR_WAIT_MS;

/**
 * The requests among `late` (an editor's requests that the server stopped waiting for and it has
 * not answered yet, Room.lateRpcs) that keep its main thread busy, so that its next commands and
 * renders wait for them: all but path traced renders, which run on its render workers.
 */
export function blockingLateRpcs(late: readonly LateRpc[]): LateRpc[] {
  return late.filter((l) => !(l.method === 'render' && l.engine === 'PATHTRACER'));
}

/**
 * The oldest of an editor's unanswered requests (see {@link blockingLateRpcs}) for messages, e.g.
 * "a RASTER render sent 16 s ago" or "editor_command 'screenshot' sent 40 s ago and 1 more";
 * null when there are none.
 */
export function describeLateRpcs(late: readonly LateRpc[], now = Date.now()): string | null {
  if (!late.length) return null;
  const l = late[0];
  const what =
    l.method === 'render'
      ? `a ${l.engine === 'PATHTRACER' ? 'path traced' : 'RASTER'} render`
      : l.method === 'ui'
        ? `editor_command '${l.command ?? '?'}'`
        : `a '${l.method}' request`;
  const age = Math.max(0, Math.round((now - l.sentAt) / 1000));
  return `${what} sent ${age} s ago${late.length > 1 ? ` and ${late.length - 1} more` : ''}`;
}

/**
 * The error of an editor command the editor did not answer within `timeoutMs`: how long the server
 * waited (`timeout_ms` and its maximum), that the editor may still carry the command out (and holds
 * its next commands and renders until it has), the earlier request it was still busy with
 * (`busy`, see {@link describeLateRpcs}), why it can take that long and what to do instead.
 * Without GPU acceleration (software WebGL) the editor draws its viewport at seconds per frame for
 * a heavy scene in MATERIAL or RENDERED shading, tens of seconds for the first frame in a shading,
 * which compiles its shaders; other commands draw nothing themselves, but wait for those frames.
 * A screenshot in the viewport's shading costs about one such frame; one in another shading
 * (`params.shading`) builds and compiles the scene's materials for that image (apps/web rpc.ts): a
 * RENDERED screenshot of a 71-material scene took 20–25 s while the viewport showed SOLID, about
 * 1 s while it showed RENDERED, a SOLID one under 1 s, and a SOLID (grey clay) render_image
 * 0.5–2 s; a scene of millions of triangles takes seconds per frame in SOLID shading too.
 */
export function editorTimeoutMessage(
  command: string,
  timeoutMs: number,
  busy?: string | null,
  params: Record<string, unknown> = {},
): string {
  const wait =
    timeoutMs < MAX_EDITOR_TIMEOUT_MS
      ? `pass a larger timeout_ms (at most ${MAX_EDITOR_TIMEOUT_MS})`
      : `timeout_ms is at its maximum (${MAX_EDITOR_TIMEOUT_MS})`;
  const head =
    `editor_command '${command}' failed: the editor did not answer within timeout_ms = ${timeoutMs} ms ` +
    `(at most ${MAX_EDITOR_TIMEOUT_MS}); it may still carry the command out, and its next commands and ` +
    'renders wait until it has.' +
    (busy
      ? ` It was still busy with an earlier request that the server had stopped waiting for (${busy}).`
      : '');
  const noGpu = 'without GPU acceleration (software WebGL, e.g. a headless browser)';
  const slowShadings =
    `for a heavy scene in MATERIAL or RENDERED shading ${noGpu}, tens of seconds the first time while it ` +
    'compiles the shaders';
  if (command === 'screenshot') {
    const shading = typeof params.shading === 'string' ? params.shading.toUpperCase() : null;
    const solid =
      `or pass shading 'SOLID' for the screenshot (grey clay, much faster); for a quick look use ` +
      "render_image with shading 'SOLID', and render_image for final images.";
    // the fast shadings already: only a larger timeout or rendering without the editor helps
    if (shading === 'SOLID' || shading === 'WIREFRAME')
      return (
        `${head} An editor ${noGpu} can take seconds per screenshot of a scene with millions of triangles ` +
        `even in ${shading} shading: ${wait}; render_image renders without the editor with renderer 'software'.`
      );
    // another shading than the viewport's builds and compiles the materials for every image
    if (shading)
      return (
        `${head} In ${shading} shading an editor ${noGpu} can take seconds per screenshot of a heavy scene, ` +
        'and tens of seconds while its viewport shows another shading (each screenshot then builds and ' +
        `compiles the scene's materials for ${shading}): ${wait}, ${solid}`
      );
    return (
      `${head} The screenshot is drawn in the viewport's shading, like a frame of the viewport, which takes ` +
      `seconds ${slowShadings}: ${wait}, ${solid}`
    );
  }
  return (
    `${head} '${command}' waits while the editor draws its viewport, which takes seconds per frame ` +
    `${slowShadings}: ${wait}, or switch the viewport to SOLID shading (editor_command view.shading ` +
    "{shading: 'SOLID'}), which draws much faster."
  );
}

/**
 * The error of an editor command whose editor's connection to the project closed before it answered
 * (RpcError CLOSED): its page was closed or reloaded, it opened another project or lost its
 * connection, or the server closed the project, so whether it carried the command out is unknown.
 * The editor's wm.read_homefile (`params.operator` of run_operator) closes it on purpose: it creates
 * a new project and switches that editor to it, closing the project it had open before it can
 * answer (createProject in apps/web/src/project/manager.ts).
 */
export function editorClosedMessage(command: string, params: Record<string, unknown> = {}): string {
  if (command === 'run_operator' && params.operator === 'wm.read_homefile') {
    const op = params.params;
    const name =
      typeof op === 'object' && op !== null && typeof (op as { name?: unknown }).name === 'string'
        ? (op as { name: string }).name
        : 'Untitled';
    return (
      "editor_command 'run_operator' got no answer for wm.read_homefile, as expected: the editor creates a " +
      `new project ('${name}') and switches to it, which closes its connection to this project before it ` +
      'can answer; list_projects lists the new project, get_connected_clients the editors that still have ' +
      'this one open.'
    );
  }
  return (
    `editor_command '${command}' failed: the editor's connection to this project closed before it answered ` +
    '(its page was closed or reloaded, it opened another project or lost its connection, or the server ' +
    'closed the project), so whether it carried the command out is unknown; get_connected_clients lists ' +
    'the editors that have the project open.'
  );
}

const quote = (s: string) => `'${s}'`;

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

/**
 * The names closest to a misspelled one: the nearest by edit distance when it is a plain typo
 * (commands share prefixes such as 'view.', which would make every one of them look similar),
 * else the suggestions of the operator parameter checks.
 */
function nearest(name: string, candidates: readonly string[]): string[] {
  const lower = name.toLowerCase();
  const scored = candidates.map((c) => ({ c, d: editDistance(lower, c.toLowerCase()) }));
  const best = Math.min(...scored.map((s) => s.d));
  if (best <= Math.max(2, Math.floor(name.length / 4)))
    return scored.filter((s) => s.d === best).map((s) => s.c);
  return suggestNames(name, candidates);
}

/** `name {param, …}` of a command, for lists in descriptions and errors. */
function signature(name: string): string {
  const params = Object.keys(EDITOR_COMMANDS[name].params);
  return params.length ? `${name} {${params.join(', ')}}` : name;
}

/** The commands and their parameters, for the editor_command description. */
export function editorCommandList(): string {
  return Object.entries(EDITOR_COMMANDS)
    .map(([name, c]) => {
      const params = Object.entries(c.params).map(([k, p]) => `${k}: ${p.doc}`);
      return `${name}${params.length ? ` {${params.join('; ')}}` : ''} — ${c.doc}`;
    })
    .join('; ');
}

/**
 * Checks an editor command and its parameters before they are sent to an editor: unknown commands,
 * unknown or misspelled parameter names, and values the editor would read loosely are a ToolError
 * that says what is wrong and lists what is valid.
 */
export function checkEditorCommand(command: string, params: Record<string, unknown>): void {
  const names = Object.keys(EDITOR_COMMANDS);
  const spec = EDITOR_COMMANDS[command];
  if (!spec) {
    const near = nearest(command, names);
    throw new ToolError(
      `Unknown editor command ${quote(command)}${near.length ? ` (did you mean ${near.map(quote).join(' or ')}?)` : ''}. ` +
        `Commands: ${names.map(signature).join(', ')}.`,
    );
  }
  const valid = Object.keys(spec.params);
  const unknown = Object.keys(params).filter((k) => !valid.includes(k));
  if (unknown.length) {
    const listed = unknown.map((k) => {
      const near = nearest(k, valid);
      return near.length ? `${quote(k)} (did you mean ${near.map(quote).join(' or ')}?)` : quote(k);
    });
    throw new ToolError(
      `Unknown parameter${unknown.length > 1 ? 's' : ''} ${listed.join(', ')} for the editor command ${command}. ` +
        (valid.length
          ? `Its parameters: ${Object.entries(spec.params)
              .map(([k, p]) => `${k} (${p.doc})`)
              .join(', ')}.`
          : `${command} takes no parameters.`),
    );
  }
  for (const [k, p] of Object.entries(spec.params)) {
    if (params[k] === undefined || !p.check) continue;
    const found = p.check(params[k]);
    if (!found) continue;
    const { problem, suggestions } = typeof found === 'string' ? { problem: found, suggestions: [] } : found;
    const near = suggestions.length ? `; did you mean ${suggestions.map(quote).join(' or ')}?` : '';
    throw new ToolError(`${command}: ${quote(k)} ${problem} (got ${JSON.stringify(params[k])}${near}).`);
  }
}
