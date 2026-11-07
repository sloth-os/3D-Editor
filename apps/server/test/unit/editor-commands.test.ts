import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  EDITOR_COMMANDS,
  MAX_EDITOR_TIMEOUT_MS,
  blockingLateRpcs,
  checkEditorCommand,
  describeLateRpcs,
  editorCommandList,
  editorTimeoutMessage,
} from '../../src/mcp/editor-commands';
import type { LateRpc } from '../../src/sync/room';

/*
 * The server checks editor_command commands and parameter names against its catalogue before it
 * sends them to a browser editor, so the catalogue must list exactly the commands and parameters
 * the editor's handler (apps/web/src/editor/rpc.ts, uiCommand) reads.
 */

const RPC_SOURCE = fileURLToPath(new URL('../../../web/src/editor/rpc.ts', import.meta.url));

/** The commands of uiCommand and the parameter names each one reads, from the editor's source. */
function webCommands(): Map<string, Set<string>> {
  const src = readFileSync(RPC_SOURCE, 'utf8');
  const start = src.indexOf('export async function uiCommand(');
  expect(start).toBeGreaterThan(0);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const out = new Map<string, Set<string>>();
  const cases = body.split(/\n\s*case '/).slice(1);
  for (const c of cases) {
    const name = c.slice(0, c.indexOf("'"));
    const read = new Set<string>();
    for (const m of c.matchAll(/params\.(\w+)/g)) read.add(m[1]);
    for (const m of c.matchAll(/ui(?:Number|Boolean)Param\(params, '(\w+)'/g)) read.add(m[1]);
    for (const m of c.matchAll(/uiEnumParam\(params, \[([^\]]*)\]/g))
      for (const k of m[1].matchAll(/'(\w+)'/g)) read.add(k[1]);
    out.set(name, read);
  }
  return out;
}

describe('editor command catalogue', () => {
  it('lists exactly the commands and parameters of the browser editor', () => {
    const web = webCommands();
    expect(Object.keys(EDITOR_COMMANDS).sort()).toEqual([...web.keys()].sort());
    for (const [name, read] of web)
      expect([...read].sort(), `parameters of ${name}`).toEqual(
        Object.keys(EDITOR_COMMANDS[name].params).sort(),
      );
  });

  it('accepts valid commands and refuses unknown names with suggestions', () => {
    expect(() => checkEditorCommand('view.set_view', { view: 'TOP' })).not.toThrow();
    expect(() => checkEditorCommand('screenshot', { width: 640, height: 360 })).not.toThrow();
    expect(() =>
      checkEditorCommand('run_operator', { operator: 'view3d.view_all', params: {} }),
    ).not.toThrow();
    expect(() => checkEditorCommand('view.shading', { shadng: 'SOLID' })).toThrow(
      /'shadng' \(did you mean 'shading'\?\)/,
    );
    expect(() => checkEditorCommand('set_mod', {})).toThrow(/did you mean 'set_mode'\?/);
    expect(() => checkEditorCommand('get_view', { x: 1 })).toThrow(/get_view takes no parameters/);
    expect(() => checkEditorCommand('notify', { message: 42 })).toThrow(/'message' must be a string/);
    expect(() => checkEditorCommand('run_operator', { operator: 'x', params: [1] })).toThrow(
      /must be an object/,
    );
    expect(editorCommandList()).toContain('view.set_view {view: FRONT | BACK');
  });
});

describe('editor command timeouts', () => {
  it('name timeout_ms and its maximum, and say what to do', () => {
    const msg = editorTimeoutMessage('screenshot', 10_000);
    expect(msg).toBe(
      "editor_command 'screenshot' failed: the editor did not answer within timeout_ms = 10000 ms (at most 55000); " +
        'it may still carry the command out, and its next commands and renders wait until it has. An editor ' +
        'without GPU acceleration (software WebGL, e.g. a headless browser) can take tens of seconds per frame ' +
        "for a heavy scene drawn with materials and lights, as screenshots are whatever the viewport's shading, " +
        'the first time also compiling the shaders: pass a larger timeout_ms (at most 55000); for a quick look ' +
        "use render_image with shading 'SOLID' (grey clay, much faster), and render_image for final images.",
    );
    // at the maximum there is no larger timeout to ask for
    const max = editorTimeoutMessage('screenshot', MAX_EDITOR_TIMEOUT_MS);
    expect(max).toContain('timeout_ms is at its maximum (55000)');
    expect(max).not.toContain('pass a larger timeout_ms');
  });

  it('explain commands that draw nothing by the viewport they wait for, not by screenshots', () => {
    for (const command of ['select', 'set_frame', 'view.set_view', 'run_operator']) {
      const msg = editorTimeoutMessage(command, 10_000);
      expect(msg).toBe(
        `editor_command '${command}' failed: the editor did not answer within timeout_ms = 10000 ms (at most 55000); ` +
          'it may still carry the command out, and its next commands and renders wait until it has. ' +
          `'${command}' waits while the editor draws its viewport, which takes seconds per frame for a heavy scene ` +
          'in MATERIAL or RENDERED shading without GPU acceleration (software WebGL, e.g. a headless browser), tens ' +
          'of seconds the first time while it compiles the shaders: pass a larger timeout_ms (at most 55000), or ' +
          "switch the viewport to SOLID shading (editor_command view.shading {shading: 'SOLID'}), which draws much faster.",
      );
      expect(msg).not.toMatch(/screenshot|render_image/);
    }
  });

  it('name the earlier request the editor was still busy with', () => {
    expect(editorTimeoutMessage('select', 10_000, "editor_command 'screenshot' sent 12 s ago")).toContain(
      "until it has. It was still busy with an earlier request that the server had stopped waiting for (editor_command 'screenshot' sent 12 s ago). 'select' waits",
    );
  });

  it('stay under the default request timeout of MCP SDK clients', () => {
    expect(MAX_EDITOR_TIMEOUT_MS).toBe(55_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC - MAX_EDITOR_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });
});

describe('unanswered editor requests', () => {
  const now = 1_000_000;
  it('describe the oldest one', () => {
    const late: LateRpc[] = [
      { method: 'render', engine: 'RASTER', sentAt: now - 16_200 },
      { method: 'ui', command: 'screenshot', sentAt: now - 4_000 },
    ];
    expect(describeLateRpcs(late, now)).toBe('a RASTER render sent 16 s ago and 1 more');
    expect(describeLateRpcs(late.slice(1), now)).toBe("editor_command 'screenshot' sent 4 s ago");
    expect(describeLateRpcs([], now)).toBeNull();
  });

  it('hold up the editor unless they are path traces, which run on its render workers', () => {
    const late: LateRpc[] = [
      { method: 'render', engine: 'PATHTRACER', sentAt: now },
      { method: 'render', engine: 'RASTER', sentAt: now },
      { method: 'ui', command: 'select', sentAt: now },
    ];
    expect(blockingLateRpcs(late).map((l) => l.engine ?? l.command)).toEqual(['RASTER', 'select']);
  });
});

describe('the screenshot command', () => {
  it("is documented as the editor draws it (rpc.ts): with materials and lights, whatever the viewport's shading", () => {
    const src = readFileSync(RPC_SOURCE, 'utf8');
    const start = src.indexOf("case 'screenshot': {");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('case ', start + 10));
    const doc = EDITOR_COMMANDS.screenshot.doc;
    // no shading passed: the engine draws RENDERED (materials, lights), not what the viewport shows
    expect(body).toContain('useViewport: true');
    expect(body).not.toMatch(/shading/);
    expect(doc).toMatch(/drawn with materials and lights \(RENDERED\) whatever the viewport's shading/);
    expect(doc).not.toMatch(/as the (person|user) sees it/);
  });
});
