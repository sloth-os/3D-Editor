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
  const HEAD = 'it may still carry the command out, and its next commands and renders wait until it has.';
  const NO_GPU = 'An editor without GPU acceleration (software WebGL, e.g. a headless browser)';
  const SOLID_ADVICE =
    "pass shading 'SOLID' for the screenshot (grey clay, much faster); for a quick look use render_image " +
    "with shading 'SOLID', and render_image for final images.";
  /** A material edit compiles the shaders of the objects with that material again. */
  const edited = (next: string) =>
    `After a material edit, its next ${next} can compile the shaders of the objects with that material ` +
    'again (10–15 s for an object with procedural wood textures).';
  const KEPT =
    'It keeps what it compiled, so a retry waits for the editor to finish and then takes about one frame.';
  const VIEWPORT =
    "The screenshot is drawn in the viewport's shading, like a frame of the viewport. An editor without GPU " +
    'acceleration (software WebGL, e.g. a headless browser) takes seconds for that with a heavy scene in ' +
    'MATERIAL or RENDERED shading, and tens of seconds for its first screenshot or frame in one of them after ' +
    "it opened the project, while it builds and compiles the scene's materials for that shading. " +
    `${edited('screenshot or frame in each of these shadings')} ${KEPT}`;
  const shaded = (shading: string) =>
    `${NO_GPU} takes seconds per ${shading} screenshot of a heavy scene, and tens of seconds for its first ` +
    `${shading} screenshot or viewport frame after it opened the project, while it builds and compiles the ` +
    `scene's materials for ${shading} shading. ${edited(`${shading} screenshot or viewport frame`)} ${KEPT}`;
  const fast = (shading: string) =>
    `${NO_GPU} can take seconds per screenshot of a scene with millions of triangles even in ${shading} ` +
    "shading, and a screenshot waits for the viewport's frames in MATERIAL or RENDERED shading that compile " +
    'shaders: its first one (tens of seconds for a heavy scene, while the editor builds and compiles the ' +
    "scene's materials) and its first one after a material edit (seconds).";
  const viewport = (command: string) =>
    `'${command}' waits while the editor draws its viewport. ${NO_GPU} takes seconds per frame for a scene ` +
    'with millions of triangles, and seconds for its first frame of a heavy scene in MATERIAL or RENDERED ' +
    "shading, while it builds the scene's materials.";
  const SWITCH =
    "switch the viewport to SOLID shading (editor_command view.shading {shading: 'SOLID'}), which draws much faster.";
  const BUSY =
    "It was still busy with an earlier request that the server had stopped waiting for (editor_command 'screenshot' sent 12 s ago).";
  /** The cases: command, params, why it can take long, the advice below and at the maximum. */
  const cases: [string, Record<string, unknown>, string, string, string][] = [
    [
      'screenshot',
      {},
      VIEWPORT,
      `Retry with a larger timeout_ms (at most 55000), or ${SOLID_ADVICE}`,
      `With timeout_ms at its maximum (55000), retry or ${SOLID_ADVICE}`,
    ],
    ...(['MATERIAL', 'rendered'] as const).map(
      (shading): [string, Record<string, unknown>, string, string, string] => [
        'screenshot',
        { shading, width: 640 },
        shaded(shading.toUpperCase()),
        `Retry with a larger timeout_ms (at most 55000), or ${SOLID_ADVICE}`,
        `With timeout_ms at its maximum (55000), retry or ${SOLID_ADVICE}`,
      ],
    ),
    ...(['SOLID', 'wireframe'] as const).map(
      (shading): [string, Record<string, unknown>, string, string, string] => [
        'screenshot',
        { shading },
        fast(shading.toUpperCase()),
        "Pass a larger timeout_ms (at most 55000), or render without the editor: render_image with renderer 'software'.",
        "With timeout_ms at its maximum (55000), render without the editor: render_image with renderer 'software'.",
      ],
    ),
    ...['select', 'set_frame', 'view.set_view', 'run_operator'].map(
      (command): [string, Record<string, unknown>, string, string, string] => [
        command,
        {},
        viewport(command),
        `Pass a larger timeout_ms (at most 55000), or ${SWITCH}`,
        `With timeout_ms at its maximum (55000), ${SWITCH}`,
      ],
    ),
  ];

  it('name timeout_ms and its maximum, why the editor can take that long and what to do', () => {
    for (const [command, params, why, below] of cases)
      expect(
        editorTimeoutMessage(command, 10_000, null, params),
        `${command} ${JSON.stringify(params)}`,
      ).toBe(
        `editor_command '${command}' failed: the editor did not answer within timeout_ms = 10000 ms (at most ` +
          `55000); ${HEAD} ${why} ${below}`,
      );
  });

  it('at the maximum, advise what else helps instead of a larger timeout_ms', () => {
    for (const [command, params, why, , atMax] of cases) {
      const msg = editorTimeoutMessage(command, MAX_EDITOR_TIMEOUT_MS, null, params);
      expect(msg, `${command} ${JSON.stringify(params)}`).toBe(
        `editor_command '${command}' failed: the editor did not answer within timeout_ms = 55000 ms (at most ` +
          `55000); ${HEAD} ${why} ${atMax}`,
      );
      expect(msg).not.toMatch(/larger timeout_ms/);
    }
  });

  it('read as sentences on both sides of the maximum, with and without the earlier request', () => {
    for (const [command, params] of cases)
      for (const timeout of [10_000, MAX_EDITOR_TIMEOUT_MS - 1, MAX_EDITOR_TIMEOUT_MS])
        for (const busy of [null, "editor_command 'screenshot' sent 12 s ago"]) {
          const msg = editorTimeoutMessage(command, timeout, busy, params);
          const label = `${command} ${JSON.stringify(params)} ${timeout} ${busy}`;
          // a statement is never joined to an instruction with "or" ("… is at its maximum (55000), or pass …")
          expect(msg, label).not.toMatch(/maximum \(\d+\)[,;:]? or /);
          expect(msg, label).not.toMatch(/is at its maximum/);
          // every sentence starts with a capital letter or a quoted command (e.g. is no sentence end)
          for (const m of msg.replace(/e\.g\. /g, 'eg ').matchAll(/[.;:] (\S)/g))
            if (m[0].startsWith('.')) expect(m[1], `${label}: ${m[0]}`).toMatch(/[A-Z']/);
          expect(msg, label).toMatch(/\.$/);
          expect(msg.includes(BUSY), label).toBe(!!busy);
          if (busy) expect(msg, label).toContain(`until it has. ${BUSY} `);
          expect(msg.includes('With timeout_ms at its maximum (55000), '), label).toBe(
            timeout === MAX_EDITOR_TIMEOUT_MS,
          );
          expect(msg.includes('a larger timeout_ms (at most 55000), or '), label).toBe(
            timeout < MAX_EDITOR_TIMEOUT_MS,
          );
        }
  });

  it('advise SOLID for screenshots in other shadings, and not again for SOLID or WIREFRAME ones', () => {
    for (const [command, params] of cases) {
      const msg = editorTimeoutMessage(command, 10_000, null, params);
      const shading = typeof params.shading === 'string' ? params.shading.toUpperCase() : null;
      expect(msg.includes("pass shading 'SOLID'"), `${command} ${shading}`).toBe(
        command === 'screenshot' && shading !== 'SOLID' && shading !== 'WIREFRAME',
      );
    }
  });

  it('explain commands that draw nothing by the viewport they wait for, not by screenshots', () => {
    for (const command of ['select', 'set_frame', 'view.set_view', 'run_operator'])
      expect(editorTimeoutMessage(command, 10_000)).not.toMatch(/screenshot|render_image/);
  });

  it('stay under the default request timeout of MCP SDK clients', () => {
    expect(MAX_EDITOR_TIMEOUT_MS).toBe(55_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC - MAX_EDITOR_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });
});

describe('the cost of screenshots', () => {
  /*
   * Measured in headless Chromium with software WebGL (SwiftShader), a scene of 81 objects and 71
   * materials at 1280×720 (docs/mcp.md): the first screenshot or viewport frame in MATERIAL or
   * RENDERED shading after the editor opened the project took 20–24 s, as it builds and compiles the
   * scene's materials for that shading; the editor keeps them (scene-objects.ts materialSets), so
   * later screenshots in it took 1.0–2.3 s, also after the viewport switched to it, and a retry of a
   * first screenshot that timed out waited for the rest of it and then took about one frame. Until a
   * material changes: an edit rebuilds the materials of the objects that use it, and the next
   * screenshot in each of those shadings after an edit of the table's material (procedural wood
   * textures, shaders no other object shares) took 10–15 s, more than the default timeout_ms. The
   * texts must tell the first screenshot in a shading from later ones, not make every screenshot in
   * another shading than the viewport's pay again, and not promise one frame after a material edit.
   */
  const overstated =
    /tens of seconds (per screenshot|for a screenshot in)|each screenshot then builds|while (its|the) viewport shows another/;
  /** A text that says the editor keeps what it built, or that later screenshots take one frame. */
  const promisesReuse = /keeps (them|what it compiled)|about one frame/;

  it('is tens of seconds only for the first screenshot or frame in a shading, which the editor keeps', () => {
    for (const shading of ['MATERIAL', 'rendered']) {
      const msg = editorTimeoutMessage('screenshot', 10_000, null, { shading });
      expect(msg).not.toMatch(overstated);
      expect(msg).toContain(
        `tens of seconds for its first ${shading.toUpperCase()} screenshot or viewport frame after it opened the project`,
      );
      expect(msg).toContain(
        'It keeps what it compiled, so a retry waits for the editor to finish and then takes about one frame.',
      );
    }
    // in the viewport's own shading a screenshot is a frame of the viewport
    const own = editorTimeoutMessage('screenshot', 10_000);
    expect(own).not.toMatch(overstated);
    expect(own).toContain("The screenshot is drawn in the viewport's shading, like a frame of the viewport.");
    expect(own).toContain(
      'tens of seconds for its first screenshot or frame in one of them after it opened the project',
    );
    expect(MCP_INSTRUCTIONS).not.toMatch(overstated);
    expect(MCP_INSTRUCTIONS).toContain(
      'a screenshot of a heavy scene in MATERIAL or RENDERED shading takes seconds, and the first screenshot or ' +
        'viewport frame in each of them after the editor opened the project tens of seconds (it builds and ' +
        "compiles the scene's materials for that shading and keeps them",
    );
    expect(MCP_INSTRUCTIONS).toContain(
      'a screenshot that timed out still builds the materials, so retrying it waits for the rest and then takes about one frame',
    );
  });

  it('can be seconds again after a material edit, which the texts that promise reuse say', () => {
    for (const shading of ['MATERIAL', 'rendered'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        `After a material edit, its next ${shading.toUpperCase()} screenshot or viewport frame can compile the ` +
          'shaders of the objects with that material again (10–15 s for an object with procedural wood textures).',
      );
    expect(editorTimeoutMessage('screenshot', 10_000)).toContain(
      'After a material edit, its next screenshot or frame in each of these shadings can compile the shaders of the ' +
        'objects with that material again (10–15 s for an object with procedural wood textures).',
    );
    // SOLID and WIREFRAME screenshots wait for the viewport's frame that compiles them
    for (const shading of ['SOLID', 'WIREFRAME'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        'and its first one after a material edit (seconds)',
      );
    expect(MCP_INSTRUCTIONS).toContain(
      'after a material edit the next one in each can compile the shaders of the objects with that material ' +
        'again, 10–15 s for an object with procedural wood textures',
    );
    // no text promises reuse without the exception
    const texts = [
      MCP_INSTRUCTIONS,
      ...[undefined, 'MATERIAL', 'RENDERED', 'SOLID', 'WIREFRAME'].flatMap((shading) =>
        [10_000, MAX_EDITOR_TIMEOUT_MS].map((t) =>
          editorTimeoutMessage('screenshot', t, null, shading ? { shading } : {}),
        ),
      ),
    ];
    for (const text of texts) if (promisesReuse.test(text)) expect(text).toMatch(/after a material edit/i);
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
