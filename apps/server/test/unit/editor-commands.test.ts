import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { KEEP_ALIVE_MS, keepAlive } from '../../src/mcp/rendering';
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
  /**
   * Measured (docs/mcp.md): an edit that needs a shader no material had until it is drawn, and a SOLID
   * screenshot of 4 million triangles.
   */
  const NEW_SHADER = '0.9–3.6 s measured';
  const HEAVY = '5.5–8.9 s in SOLID with 4 million';
  /** Only an edit that needs a shader no material had makes the next screenshot compile one. */
  const NEEDS =
    'a material edit that needs a shader no material had (coat or sheen turned on, a procedural texture ' +
    'on a set of channels that no other material has)';
  const edited = (next: string) => `After ${NEEDS}, its next ${next} compiles it (${NEW_SHADER}).`;
  const KEPT =
    'It keeps what it compiled, so a retry waits for the editor to finish and then takes about one frame.';
  const VIEWPORT =
    "The screenshot is drawn in the viewport's shading, like a frame of the viewport. An editor without GPU " +
    'acceleration (software WebGL, e.g. a headless browser) takes seconds for that with a scene of millions of ' +
    `triangles in any shading (${HEAVY}) and with a heavy scene in MATERIAL or RENDERED shading, and tens of ` +
    'seconds for its first screenshot or frame in one of these two after it opened the project, while it ' +
    "builds and compiles the scene's materials for that shading. " +
    `${edited('screenshot or frame in each of these two')} ${KEPT}`;
  const shaded = (shading: string) =>
    `${NO_GPU} takes seconds per ${shading} screenshot of a heavy scene, and tens of seconds for its first ` +
    `${shading} screenshot or viewport frame after it opened the project, while it builds and compiles the ` +
    `scene's materials for ${shading} shading. ${edited(`${shading} screenshot or viewport frame`)} ${KEPT}`;
  const fast = (shading: string) =>
    `${NO_GPU} can take seconds per screenshot of a scene with millions of triangles even in ${shading} ` +
    'shading, and a screenshot waits until the frame its viewport is drawing is done. In MATERIAL or ' +
    'RENDERED shading that frame compiles shaders the first time after the editor opened the project (tens ' +
    "of seconds for a heavy scene, while it builds and compiles the scene's materials) and after a material " +
    'edit that needs a shader no material had (coat or sheen turned on, a procedural texture on a set of ' +
    `channels that no other material has: ${NEW_SHADER}). ${KEPT}`;
  const viewport = (command: string) =>
    `'${command}' waits while the editor draws its viewport. ${NO_GPU} takes seconds per frame for a scene ` +
    'with millions of triangles, and seconds for its first frame of a heavy scene in MATERIAL or RENDERED ' +
    "shading, while it builds and compiles the scene's materials.";
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
        "Retry with a larger timeout_ms (at most 55000), or render without the editor: render_image with renderer 'software'.",
        "With timeout_ms at its maximum (55000), retry or render without the editor: render_image with renderer 'software'.",
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
   * RENDERED shading after the editor opened the project took 18.5–26.4 s, as it builds and compiles the
   * scene's materials for that shading; the editor keeps them (scene-objects.ts materialSets), so
   * later screenshots in it took about one frame, also after the viewport switched to it, and a retry
   * of a first screenshot that timed out waited for the rest of it and then took about one frame. A
   * material edit builds that material again and keeps the one it replaces until the new one has been
   * drawn in every shading the old one was drawn in (scene-objects.ts replaceSlot): an edit of values
   * compiled nothing in either shading, and one that needs a shader no material had compiled it once
   * in each (0.9–3.6 s). The texts must tell the first screenshot in a shading from later ones and
   * name the edits that compile, and no text may claim a compile that the editor no longer does.
   */
  const overstated =
    /tens of seconds (per screenshot|for a screenshot in)|each screenshot then builds|while (its|the) viewport shows another/;
  /** A text that says the editor keeps what it built, or that later screenshots take one frame. */
  const promisesReuse = /keeps (them|what it compiled|it)|about one frame/;
  const screenshots = [undefined, 'MATERIAL', 'RENDERED', 'SOLID', 'WIREFRAME'].flatMap((shading) =>
    [10_000, MAX_EDITOR_TIMEOUT_MS].map((t) =>
      editorTimeoutMessage('screenshot', t, null, shading ? { shading } : {}),
    ),
  );
  /** The doc comment of editorTimeoutMessage, which gives the measurements behind the texts. */
  const docComment = (() => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/mcp/editor-commands.ts', import.meta.url)),
      'utf8',
    );
    const fn = src.indexOf('export function editorTimeoutMessage(');
    return src.slice(src.lastIndexOf('/**', fn), fn).replace(/\s*\n\s*\* ?/g, ' ');
  })();

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
      'tens of seconds for its first screenshot or frame in one of these two after it opened the project',
    );
    expect(MCP_INSTRUCTIONS).not.toMatch(overstated);
    expect(MCP_INSTRUCTIONS).toContain(
      'a screenshot of a heavy scene in MATERIAL or RENDERED shading takes seconds, the first screenshot or ' +
        'viewport frame in each of them after the editor opened the project tens of seconds (it builds and ' +
        "compiles the scene's materials for that shading and keeps them",
    );
    expect(MCP_INSTRUCTIONS).toContain(
      'a screenshot that timed out still compiles what it needs and keeps it, so retrying it waits for the rest and then takes about one frame',
    );
  });

  it('name the material edits that compile a shader, with the measured range, and only those', () => {
    const cost = '0.9–3.6 s measured';
    const needs =
      'a material edit that needs a shader no material had (coat or sheen turned on, a procedural texture on ' +
      'a set of channels that no other material has)';
    for (const shading of ['MATERIAL', 'rendered'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        `After ${needs}, its next ${shading.toUpperCase()} screenshot or viewport frame compiles it (${cost}).`,
      );
    expect(editorTimeoutMessage('screenshot', 10_000)).toContain(
      `After ${needs}, its next screenshot or frame in each of these two compiles it (${cost}).`,
    );
    // SOLID and WIREFRAME screenshots wait for the viewport's frame, also one that compiles; a retry is cheap
    for (const shading of ['SOLID', 'WIREFRAME']) {
      const msg = editorTimeoutMessage('screenshot', 10_000, null, { shading });
      expect(msg).toContain('a screenshot waits until the frame its viewport is drawing is done.');
      expect(msg).toContain(
        'and after a material edit that needs a shader no material had (coat or sheen turned on, a procedural ' +
          `texture on a set of channels that no other material has: ${cost}).`,
      );
      expect(msg).toContain('so a retry waits for the editor to finish and then takes about one frame.');
      expect(msg).toContain('Retry with a larger timeout_ms (at most 55000)');
    }
    expect(MCP_INSTRUCTIONS).toContain(
      "it builds and compiles the scene's materials for that shading and keeps them, also through material " +
        'edits that change values; an edit that needs a shader no material had, such as coat or sheen turned ' +
        'on or a procedural texture on a set of channels that no other material has, makes the next one in ' +
        `each of them compile it, ${cost})`,
    );
    // no text promises reuse without the exception
    for (const text of [MCP_INSTRUCTIONS, ...screenshots])
      if (promisesReuse.test(text)) expect(text).toMatch(/needs a shader no material had/i);
  });

  it("cover scenes with millions of triangles, also in the viewport's shading", () => {
    expect(editorTimeoutMessage('screenshot', 10_000)).toContain(
      'takes seconds for that with a scene of millions of triangles in any shading (5.5–8.9 s in SOLID ' +
        'with 4 million)',
    );
    for (const shading of ['SOLID', 'WIREFRAME'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        `can take seconds per screenshot of a scene with millions of triangles even in ${shading} shading`,
      );
    expect(MCP_INSTRUCTIONS).toContain(
      'and a scene with millions of triangles seconds per frame in any shading',
    );
  });

  it('state no outdated numbers, nor numbers that depend on when a request arrived', () => {
    // round 6 measured 10–15 s for the table's and the dowels' "procedural wood textures" after any
    // edit of their materials, and a SOLID screenshot sent right after an edit at 6.5 s; round 7's
    // first texts described a recompile in the second shading drawn after a value edit (1.2–11.9 s),
    // which the editor no longer does (it keeps the replaced material for every shading it was drawn
    // in), and waits that depended on when the request arrived (4–38 ms, 8.4 s, 17.5–21.0 s)
    const texts = [MCP_INSTRUCTIONS, ...screenshots, editorTimeoutMessage('select', 10_000), docComment];
    for (const text of texts) {
      expect(text).not.toMatch(/10–15 s|procedural wood|6\.5 s|right after the edit/);
      expect(text).not.toMatch(/second of (the|these) two|1\.2–11\.9|11\.9 s|can compile shaders again/);
      expect(text).not.toMatch(/4–38 ms|8\.4 s|17\.5|sent right after|right after the viewport switched/);
      expect(text).not.toMatch(/transmission turned on|or transmission/);
    }
  });

  it('give the measurements behind the texts in the doc comment of editorTimeoutMessage', () => {
    // the doc comment names the mechanism (scene-objects.ts replaceSlot keeps the replaced material
    // for every shading it was drawn in) and the measured ranges the texts quote
    expect(docComment).toContain(
      'A material edit builds that material again and keeps the one it replaces until the new one has ' +
        'been drawn in every shading the old one was drawn in (scene-objects.ts replaceSlot)',
    );
    expect(docComment).toContain(
      'compiles it for the next screenshot or frame in each of the two, which took 0.9–3.6 s',
    );
    expect(docComment).toContain('With 4 million triangles a SOLID screenshot took 5.5–8.9 s');
    const sceneObjects = readFileSync(
      fileURLToPath(new URL('../../../web/src/viewport/scene-objects.ts', import.meta.url)),
      'utf8',
    );
    // the mechanism: a slot keeps, per draw context, the material it drew with before
    expect(sceneObjects).toContain('kept: Map<string, THREE.Material>;');
    expect(sceneObjects).toMatch(/private replaceSlot\(old: SlotMaterial \| undefined/);
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

describe('get_view and screenshots during an animated view change', () => {
  it('give the view it ends on, at once', () => {
    const engine = readFileSync(
      fileURLToPath(new URL('../../../web/src/viewport/engine.ts', import.meta.url)),
      'utf8',
    );
    // setPose sets the view at once; only the frames drawn in the next 220 ms animate (shownPose)
    const setPose = engine.slice(engine.indexOf('  setPose(p: ViewPose'));
    expect(setPose.slice(0, setPose.indexOf('\n  }\n'))).toContain('this.pose = p;');
    // a screenshot of the viewport's view and get_view read it
    expect(engine).toContain('const vc = viewportCamera(this.pose, aspect);');
    const rpc = readFileSync(RPC_SOURCE, 'utf8');
    const getView = rpc.slice(rpc.indexOf("case 'get_view': {"));
    expect(getView.slice(0, getView.indexOf('return'))).toContain('const p = e.pose;');
    expect(EDITOR_COMMANDS.get_view.doc).toBe(
      'the viewport camera (target, distance, yaw, pitch, ortho, camera view); during an animated view change ' +
        '(view.set_view, view.frame_all, view.frame_selected) the view it ends on',
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

describe('the progress notifications of a request that waits for an editor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * keepAlive with fake interval timers and a Date.now() that the test sets: the seconds of each
   * notification it sends.
   */
  function run(nowAtTicks: number[]): number[] {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const seconds: number[] = [];
    const sendNotification = vi.fn(async () => undefined);
    const extra = { _meta: { progressToken: 1 }, sendNotification } as unknown as Parameters<
      typeof keepAlive
    >[0];
    const stop = keepAlive(extra, (s) => {
      seconds.push(s);
      return { progress: s, total: 55, message: `waiting for the editor: ${s} s` };
    });
    const t0 = now;
    for (const at of nowAtTicks) {
      now = t0 + at;
      vi.advanceTimersByTime(KEEP_ALIVE_MS);
    }
    stop();
    expect(sendNotification).toHaveBeenCalledTimes(nowAtTicks.length);
    return seconds;
  }

  it('say how long the request has waited, never less than the intervals that passed', () => {
    // Node counts the interval from the event loop's time, which can be some milliseconds before
    // Date.now() when the timer is set: the first notification then came at 4997 ms by Date.now()
    // and said "4 s" (a flaky integration test, mcp-error-codes.test.ts 'keeps long browser
    // requests alive with progress notifications')
    expect(run([4997, 9996])).toEqual([5, 10]);
    // a timer that fires late (a busy event loop) gives the whole seconds that passed
    expect(run([7200, 10_400])).toEqual([7, 10]);
  });
});
