import { suggestNames } from '@3d-editor/core';
import type { LateRpc } from '../sync/room';
import { ToolError } from './agent';
import { MEASURED_NOTE, MILLIONS_SOLID_SECONDS, NEW_SHADER_SECONDS } from './editor-costs';

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
  get_view: {
    doc:
      'the viewport camera (target, distance, yaw, pitch, ortho, camera view); while the viewport animates a ' +
      'view change (an axis view, an orbit step or framing, asked for by a command, an operator or the person) ' +
      'the view it ends on',
    params: {},
  },
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
 * (`busy`, see {@link describeLateRpcs}), why it can take that long and what to do instead: a
 * larger timeout_ms while there is one (below the maximum), then the other remedies.
 *
 * Measured in headless Chromium with software WebGL (SwiftShader), a scene of 81 objects and 71
 * materials, 1280×720 (docs/mcp.md has the details; the times vary with the machine's load, which
 * the messages say with {@link MEASURED_NOTE}): the first screenshot or viewport frame in MATERIAL
 * or RENDERED shading after the editor opened the project builds and compiles that shading's
 * materials, 18.5–30.6 s for each of the two; the editor keeps them (apps/web scene-objects.ts
 * ObjectView.materialSets), so later screenshots in that shading compiled nothing and took
 * 0.4–3.3 s, also after the viewport switched to it, and SOLID or WIREFRAME ones 0.5–2.0 s. A
 * screenshot is drawn with the viewport's sample count, or with the other one when its shading was
 * drawn only with that one (apps/web engine.ts captureSamples): software WebGL builds every
 * material's pipelines again for another sample count, so the first MATERIAL or RENDERED screenshot
 * after the viewport had drawn that shading without multisampling (more than a million triangles,
 * slow frames) built none and took 0.4–2.3 s. A material edit builds that material again and keeps
 * the one it replaces until the new one has been drawn in every shading the old one was drawn in
 * (scene-objects.ts replaceSlot), so three.js gives the new one the old one's shader when they need
 * the same: after roughness edits of untextured, procedural and glass materials the next
 * screenshots in both shadings took 0.8–3.8 s, and no shader was compiled. An edit that needs a
 * shader no material had (coat or sheen turned on, a procedural texture on a set of channels that
 * no other material has) compiles it for the next screenshot or frame in each of the two, which
 * took 0.6–4.5 s for the plastics and 10.8–12.9 s for the table's material, whose colour, roughness
 * and bump are procedural textures (the viewport's frame after the edit, or the first screenshot in
 * a shading after it). A screenshot waits until the frame the viewport is drawing is done, also in
 * SOLID or WIREFRAME shading: when that frame compiles shaders, up to that frame's time. The editor
 * finishes a screenshot that timed out and keeps what it compiled: a retry waits for the rest of it
 * and compiles nothing again (a first RENDERED screenshot that timed out after 3 s, retried at
 * once, answered 17.7–20.9 s later). Other commands draw nothing themselves but wait while the
 * editor's main thread is busy: for 4.0–6.2 s after the viewport switched to MATERIAL or RENDERED
 * for the first time (it builds the materials and their shaders), and while it draws a screenshot.
 * With 4 million triangles (the viewport without multisampling) a SOLID screenshot took 3.3–5.2 s,
 * a WIREFRAME one 4.1–11.9 s and a select 2.5–3.8 s. On the server, grey clay (render_image with
 * shading 'SOLID' and renderer 'software', the remedy of SOLID and WIREFRAME screenshots) took
 * 1.7–3.6 s for that scene and 2.2–2.5 s with a grid of a million triangles added, and ran out of
 * memory after 17.4–21.4 s with a grid of 2 million triangles.
 */
export function editorTimeoutMessage(
  command: string,
  timeoutMs: number,
  busy?: string | null,
  params: Record<string, unknown> = {},
): string {
  const atMax = timeoutMs >= MAX_EDITOR_TIMEOUT_MS;
  /**
   * The sentence that says what to do: a larger timeout_ms first (`retry`: retrying with it), at
   * the maximum `atMaxFirst` instead, then `others`.
   */
  const remedy = (others: string, { retry = false, atMaxFirst = '' } = {}) =>
    atMax
      ? `With timeout_ms at its maximum (${MAX_EDITOR_TIMEOUT_MS}), ${atMaxFirst}${others}`
      : `${retry ? 'Retry with' : 'Pass'} a larger timeout_ms (at most ${MAX_EDITOR_TIMEOUT_MS}), or ${others}`;
  const head =
    `editor_command '${command}' failed: the editor did not answer within timeout_ms = ${timeoutMs} ms ` +
    `(at most ${MAX_EDITOR_TIMEOUT_MS}); it may still carry the command out, and its next commands and ` +
    'renders wait until it has.' +
    (busy
      ? ` It was still busy with an earlier request that the server had stopped waiting for (${busy}).`
      : '');
  const noGpu = 'without GPU acceleration (software WebGL, e.g. a headless browser)';
  if (command === 'screenshot') {
    const shading = typeof params.shading === 'string' ? params.shading.toUpperCase() : null;
    const solid =
      "pass shading 'SOLID' for the screenshot (grey clay, much faster); for a quick look use render_image " +
      "with shading 'SOLID', and render_image for final images.";
    // only an edit that needs a shader no material had compiles one: the editor gives an edited
    // material the shader of the one it replaces when they need the same (see above)
    const edited = (next: string) =>
      `After a material edit that needs a shader no material had (coat or sheen turned on, a procedural ` +
      `texture on a set of channels that no other material has), its next ${next} compiles it ` +
      `(${NEW_SHADER_SECONDS}). ${MEASURED_NOTE}`;
    // the editor keeps what a screenshot that timed out compiled: retrying is worth it (the retry
    // still costs a screenshot: a frame of its shading and the work of its own, see rpc.ts)
    const kept =
      'It keeps what it compiled, so a retry waits for the editor to finish and compiles nothing again.';
    // the fast shadings already: a retry, a larger timeout or rendering without the editor helps; the
    // render must be grey clay (shading 'SOLID'): with the scene's render engine, renderer 'software'
    // path traces a PATHTRACER scene on the server, for up to its time_limit (rendering.ts
    // DEFAULT_IMAGE_TIME_LIMIT, 30 s); the server's render worker ran out of memory for a mesh of 2
    // million triangles (see the doc comment)
    if (shading === 'SOLID' || shading === 'WIREFRAME')
      return (
        `${head} An editor ${noGpu} can take seconds per screenshot of a scene with millions of triangles ` +
        `even in ${shading} shading, and a screenshot waits until the frame its viewport is drawing is done. ` +
        'In MATERIAL or RENDERED shading that frame compiles shaders the first time after the editor opened ' +
        "the project (tens of seconds for a heavy scene, while it builds and compiles the scene's materials) " +
        'and after a material edit that needs a shader no material had (coat or sheen turned on, a ' +
        `procedural texture on a set of channels that no other material has: ${NEW_SHADER_SECONDS}). ` +
        `${MEASURED_NOTE} ${kept} ` +
        remedy(
          "render without the editor: render_image with shading 'SOLID' and renderer 'software' (grey clay, " +
            'rendered on the server, which can run out of memory for millions of triangles).',
          { retry: true, atMaxFirst: 'retry or ' },
        )
      );
    if (shading)
      return (
        `${head} An editor ${noGpu} takes seconds per ${shading} screenshot of a heavy scene, and tens of ` +
        `seconds for its first ${shading} screenshot or viewport frame after it opened the project, while it ` +
        `builds and compiles the scene's materials for ${shading} shading. ` +
        `${edited(`${shading} screenshot or viewport frame`)} ${kept} ` +
        remedy(solid, { retry: true, atMaxFirst: 'retry or ' })
      );
    return (
      `${head} The screenshot is drawn in the viewport's shading, like a frame of the viewport. An editor ` +
      `${noGpu} takes seconds for that with a scene of millions of triangles in any shading (${MILLIONS_SOLID_SECONDS} ` +
      'in SOLID with 4 million) and with a heavy scene in MATERIAL or RENDERED shading, and tens of seconds ' +
      'for its first screenshot or frame in one of these two after it opened the project, while it builds ' +
      "and compiles the scene's materials for that shading. " +
      `${edited('screenshot or frame in each of these two')} ${kept} ` +
      remedy(solid, { retry: true, atMaxFirst: 'retry or ' })
    );
  }
  return (
    `${head} '${command}' waits while the editor draws its viewport. An editor ${noGpu} takes seconds per ` +
    'frame for a scene with millions of triangles, and seconds for its first frame of a heavy scene in ' +
    "MATERIAL or RENDERED shading, while it builds and compiles the scene's materials. " +
    remedy(
      "switch the viewport to SOLID shading (editor_command view.shading {shading: 'SOLID'}), which draws " +
        'much faster.',
    )
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
