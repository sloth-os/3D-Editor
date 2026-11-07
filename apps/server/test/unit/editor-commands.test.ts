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
  editorClosedMessage,
  editorCommandList,
  editorTimeoutMessage,
} from '../../src/mcp/editor-commands';
import { MCP_INSTRUCTIONS } from '../../src/mcp/instructions';
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

  it("checks the screenshot's shading before it is sent, letter case ignored, with suggestions", () => {
    for (const shading of ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED', 'solid', 'Rendered'])
      expect(() => checkEditorCommand('screenshot', { shading, width: 320 })).not.toThrow();
    expect(() => checkEditorCommand('screenshot', { shading: 'SOILD' })).toThrow(
      `screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?).`,
    );
    expect(() => checkEditorCommand('screenshot', { shading: 'render' })).toThrow(
      /\(got "render"; did you mean 'RENDERED'\?\)\.$/,
    );
    // nothing close: the valid values only
    expect(() => checkEditorCommand('screenshot', { shading: 'clay' })).toThrow(
      `screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "clay").`,
    );
    expect(() => checkEditorCommand('screenshot', { shading: 3 })).toThrow(
      /letter case ignored \(got 3\)\.$/,
    );
    expect(() => checkEditorCommand('screenshot', { shading: null })).toThrow(/\(got null\)/);
    expect(() => checkEditorCommand('screenshot', { shadig: 'SOLID' })).toThrow(
      /'shadig' \(did you mean 'shading'\?\) for the editor command screenshot\. Its parameters: width \(.*\), height \(.*\), shading \(WIREFRAME \| SOLID \| MATERIAL \| RENDERED \(default: the viewport's shading\)\)\./,
    );
    expect(editorCommandList()).toContain(
      "screenshot {width: pixels (default: the viewport size); height: pixels (default: the viewport size); shading: WIREFRAME | SOLID | MATERIAL | RENDERED (default: the viewport's shading)} — a PNG of the editor's viewport as the person sees it",
    );
  });
});

describe('editor command timeouts', () => {
  it('name timeout_ms and its maximum, and say what to do', () => {
    const msg = editorTimeoutMessage('screenshot', 10_000);
    expect(msg).toBe(
      "editor_command 'screenshot' failed: the editor did not answer within timeout_ms = 10000 ms (at most 55000); " +
        'it may still carry the command out, and its next commands and renders wait until it has. The screenshot ' +
        "is drawn in the viewport's shading, like a frame of the viewport, which takes seconds for a heavy scene " +
        'in MATERIAL or RENDERED shading without GPU acceleration (software WebGL, e.g. a headless browser), tens ' +
        'of seconds the first time while it compiles the shaders: pass a larger timeout_ms (at most 55000), or ' +
        "pass shading 'SOLID' for the screenshot (grey clay, much faster); for a quick look use render_image " +
        "with shading 'SOLID', and render_image for final images.",
    );
    // at the maximum there is no larger timeout to ask for
    const max = editorTimeoutMessage('screenshot', MAX_EDITOR_TIMEOUT_MS);
    expect(max).toContain('timeout_ms is at its maximum (55000)');
    expect(max).not.toContain('pass a larger timeout_ms');
  });

  it('advise SOLID for screenshots in the shading they were asked for, and not again for SOLID ones', () => {
    const rendered = editorTimeoutMessage('screenshot', 10_000, null, { shading: 'rendered', width: 640 });
    expect(rendered).toContain(
      'until it has. In RENDERED shading an editor without GPU acceleration (software WebGL, e.g. a headless ' +
        'browser) can take seconds per screenshot of a heavy scene, and tens of seconds while its viewport shows ' +
        "another shading (each screenshot then builds and compiles the scene's materials for RENDERED): pass a " +
        'larger timeout_ms (at most 55000)',
    );
    expect(rendered).toContain("or pass shading 'SOLID' for the screenshot (grey clay, much faster)");
    for (const shading of ['SOLID', 'wireframe']) {
      const msg = editorTimeoutMessage('screenshot', 10_000, null, { shading });
      expect(msg).toBe(
        "editor_command 'screenshot' failed: the editor did not answer within timeout_ms = 10000 ms (at most 55000); " +
          'it may still carry the command out, and its next commands and renders wait until it has. An editor ' +
          'without GPU acceleration (software WebGL, e.g. a headless browser) can take seconds per screenshot of a ' +
          `scene with millions of triangles even in ${shading.toUpperCase()} shading: pass a larger timeout_ms (at ` +
          "most 55000); render_image renders without the editor with renderer 'software'.",
      );
    }
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

describe('the cost of screenshots', () => {
  /*
   * In software WebGL a screenshot in the viewport's shading costs about one frame of the viewport
   * (about 1 s in RENDERED for a 71-material scene that the viewport showed in RENDERED); one in
   * another shading builds and compiles the scene's materials for that image (20–25 s in RENDERED
   * while the viewport showed SOLID): apps/web rpc.ts. The texts must not make MATERIAL and
   * RENDERED screenshots slow in themselves.
   */
  const overstated =
    /tens of seconds per screenshot (in (them|MATERIAL or RENDERED)|of a heavy scene, the first)/;

  it('is told by the shading the viewport shows: tens of seconds only in another shading', () => {
    for (const shading of ['MATERIAL', 'rendered']) {
      const msg = editorTimeoutMessage('screenshot', 10_000, null, { shading });
      expect(msg).not.toMatch(overstated);
      expect(msg).toContain('and tens of seconds while its viewport shows another shading');
    }
    // in the viewport's own shading a screenshot is a frame of the viewport
    const own = editorTimeoutMessage('screenshot', 10_000);
    expect(own).not.toMatch(overstated);
    expect(own).toContain("The screenshot is drawn in the viewport's shading, like a frame of the viewport");
    expect(MCP_INSTRUCTIONS).not.toMatch(overstated);
    expect(MCP_INSTRUCTIONS).toContain(
      'and tens of seconds for a screenshot in one of them while its viewport shows another shading (it ' +
        'builds and compiles the materials for that image)',
    );
  });
});

describe('an editor that leaves the project before it answers', () => {
  it('wm.read_homefile: says that it was expected, where the new project is, and does not read as a failure', () => {
    // the editor closes the project it has open before it switches to the new one (createProject)
    const manager = readFileSync(
      fileURLToPath(new URL('../../../web/src/project/manager.ts', import.meta.url)),
      'utf8',
    );
    const create = manager.slice(manager.indexOf('export async function createProject('));
    expect(create.indexOf('prev?.close()')).toBeGreaterThan(0);
    expect(create.indexOf('prev?.close()')).toBeLessThan(create.indexOf('await '));
    expect(
      editorClosedMessage('run_operator', { operator: 'wm.read_homefile', params: { name: 'Switched' } }),
    ).toBe(
      "editor_command 'run_operator' got no answer for wm.read_homefile, as expected: the editor creates a new " +
        "project ('Switched') and switches to it, which closes its connection to this project before it can " +
        'answer; list_projects lists the new project, get_connected_clients the editors that still have this one open.',
    );
    // its default name
    expect(editorClosedMessage('run_operator', { operator: 'wm.read_homefile' })).toContain(
      "creates a new project ('Untitled')",
    );
  });

  it('other commands: the connection closed, so whether the command ran is unknown', () => {
    for (const [command, params] of [
      ['screenshot', {}],
      ['run_operator', { operator: 'view3d.view_all' }],
    ] as const)
      expect(editorClosedMessage(command, params)).toBe(
        `editor_command '${command}' failed: the editor's connection to this project closed before it answered ` +
          '(its page was closed or reloaded, it opened another project or lost its connection, or the server ' +
          'closed the project), so whether it carried the command out is unknown; get_connected_clients lists ' +
          'the editors that have the project open.',
      );
  });
});

describe('the view commands', () => {
  const UI_OPERATORS = fileURLToPath(new URL('../../../web/src/editor/ui-operators.ts', import.meta.url));

  it('view.frame_selected frames the selected vertices in Edit Mode, and both leave the camera view', () => {
    const src = readFileSync(UI_OPERATORS, 'utf8');
    const start = src.indexOf("id: 'view3d.view_selected'");
    const body = src.slice(start, src.indexOf('reg.register(', start));
    expect(body).toContain("ctx.state.mode === 'EDIT'");
    expect(body).toContain('ctx.state.meshSelection.verts');
    // frameSphere leaves the camera view
    const engine = readFileSync(
      fileURLToPath(new URL('../../../web/src/viewport/engine.ts', import.meta.url)),
      'utf8',
    );
    const frame = engine.slice(engine.indexOf('  frameSphere('));
    expect(frame.slice(0, frame.indexOf('\n  }\n'))).toContain('cameraView.value = false');
    expect(EDITOR_COMMANDS['view.frame_selected'].doc).toBe(
      "frame the editor's selection, out of the camera view: its selected objects (every visible one when none " +
        'is selected), in Edit Mode the selected vertices of its active mesh (all of them when none is)',
    );
    expect(EDITOR_COMMANDS['view.frame_all'].doc).toBe(
      'frame every visible object in the viewport, out of the camera view',
    );
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
  const ENGINE_SOURCE = fileURLToPath(new URL('../../../web/src/viewport/engine.ts', import.meta.url));

  it("is documented as the editor draws it (rpc.ts, engine.ts): the viewport's or the given shading, rasterized", () => {
    const src = readFileSync(RPC_SOURCE, 'utf8');
    const start = src.indexOf("case 'screenshot': {");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('case ', start + 10));
    const doc = EDITOR_COMMANDS.screenshot.doc;
    // a capture of the viewport (its view, no overlays) in `shading`, else the viewport's shading
    expect(body).toContain('useViewport: true');
    expect(body).toMatch(/params\.shading|uiEnumParam\(params, \['shading'\]/);
    expect(body).toMatch(/view\.shading\.value/);
    // rasterized: without an engine a viewport capture never path traces, whatever the render engine
    expect(body).not.toMatch(/engine:/);
    const engine = readFileSync(ENGINE_SOURCE, 'utf8');
    expect(engine).toMatch(/opts\.engine \?\? \(opts\.useViewport \? 'RASTER'/);
    expect(doc).toMatch(/^a PNG of the editor's viewport as the person sees it: /);
    expect(doc).toContain("in the viewport's shading or `shading`, without overlays");
    expect(doc).toContain('never path traced');
    expect(doc).toContain('also when the render engine is PATHTRACER');
    // MATERIAL is the viewport's Material Preview (its studio environment), not the look of
    // render_image's MATERIAL, which rpcRenderShading draws as RENDERED
    expect(body).not.toContain('rpcRenderShading');
    expect(engine).toMatch(/scene\.environment = shading === 'MATERIAL' \? this\.envTexture/);
    expect(doc).toContain('MATERIAL is Material Preview (studio lighting)');
    expect(doc).not.toMatch(/whatever the viewport's shading/);
    expect(EDITOR_COMMANDS.screenshot.params.shading.doc).toContain("default: the viewport's shading");
  });
});
