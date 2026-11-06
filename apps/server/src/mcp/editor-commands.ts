import { suggestNames } from '@3d-editor/core';
import { ToolError } from './agent';

/*
 * The UI commands of browser editors (MCP editor_command → RPC `ui`, run by the web app's
 * apps/web/src/editor/rpc.ts) and their parameters. The `params` of editor_command are a free-form
 * map, and the editor reads only the keys it knows, so a misspelled parameter used to be ignored
 * silently: `view.set_view {veiw: 'TOP'}` answered ok and showed the default FRONT view. The server
 * therefore checks the command and the names of its parameters before it sends the request (also
 * when no editor is connected), with did-you-mean suggestions and the valid names, like tool
 * arguments and operator parameters; values the editor reads loosely are checked here too. The
 * editor checks the other values (view, shading and mode names, object names, frame numbers).
 */

type ParamCheck = (value: unknown) => string | null;

interface EditorParam {
  /** What the parameter is (for the tool description and errors). */
  doc: string;
  /** Checks a value the editor would read loosely: the problem, or null when the value is fine. */
  check?: ParamCheck;
}

export interface EditorCommand {
  /** What the command does. */
  doc: string;
  params: Record<string, EditorParam>;
}

const VIEWS = 'FRONT | BACK | RIGHT | LEFT | TOP | BOTTOM | CAMERA';
const SHADINGS = 'WIREFRAME | SOLID | MATERIAL | RENDERED';
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

/** The commands a browser editor runs, by name (keep in sync with apps/web/src/editor/rpc.ts). */
export const EDITOR_COMMANDS: Record<string, EditorCommand> = {
  'view.frame_all': { doc: 'frame every object in the viewport', params: {} },
  'view.frame_selected': { doc: "frame the editor's selected objects", params: {} },
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
    doc: 'a PNG of the editor viewport as the person sees it',
    params: {
      width: { doc: 'pixels (default: the viewport size)', check: pixels },
      height: { doc: 'pixels (default: the viewport size)', check: pixels },
    },
  },
  get_view: { doc: 'the viewport camera (target, distance, yaw, pitch, ortho, camera view)', params: {} },
};

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
    const problem = p.check(params[k]);
    if (problem)
      throw new ToolError(`${command}: ${quote(k)} ${problem} (got ${JSON.stringify(params[k])}).`);
  }
}
