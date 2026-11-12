import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { createOperatorRegistry } from '@3d-editor/core';
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
import {
  AFTER_SAVE_HOLD_SECONDS,
  BROWSER_RASTER_SECONDS,
  BUSY_FACTOR,
  BUSY_LOADS,
  CHANGE_APPLY_SECONDS,
  FAST_SECONDS,
  FIRST_SHADING_SECONDS,
  LATER_SECONDS,
  MARGIN_PERCENT,
  MILLIONS_MARGIN_PERCENT,
  MILLIONS_SELECT_SECONDS,
  MILLIONS_SOLID_SECONDS,
  NEW_SHADER_SECONDS,
  READ_HOLD_SECONDS,
  SAVE_HOLD_SECONDS,
  SERVER_SOLID_SCENE_SECONDS,
  SERVER_SOLID_SECONDS,
  measured,
  measuredNote,
  measuredOnServer,
} from '../../src/mcp/editor-costs';
import { MCP_INSTRUCTIONS } from '../../src/mcp/instructions';
import { KEEP_ALIVE_MS, keepAlive, renderToolError } from '../../src/mcp/rendering';
import { inBrowserEditor } from '../../src/render/memory';
import { renderProcessExitError } from '../../src/render/pool';
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

/**
 * The first WIREFRAME screenshot or frame of a mesh builds its wires: with 4 million triangles several
 * times as long as a SOLID screenshot (docs/mcp.md has the measured range).
 */
const WIRES =
  'several times as long for its first WIREFRAME screenshot or frame of such a scene (it builds the ' +
  'wires of every mesh then, and keeps them while the mesh stays the same)';

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

  /*
   * An import the server's process has no memory for ends its refusal with the editor_command call
   * that runs it in a browser editor (render/memory.ts inBrowserEditor), and the run_operator
   * command's doc says it is for that too: the call the refusal gives must pass this catalogue's
   * check, name an operator of the registry (which the browser editor runs) that takes the file as
   * data_base64, and have the shape the command's doc gives.
   */
  it("accepts the editor_command call that an import's memory refusal gives, as run_operator's doc says", () => {
    const registry = createOperatorRegistry();
    const doc = EDITOR_COMMANDS.run_operator.doc;
    expect(doc).toContain("for an operator the server's process refused for memory");
    expect(doc).toContain('{operator: "import_scene.gltf", params: {data_base64}}');
    for (const operator of ['import_scene.gltf', 'import_mesh.stl', 'import_mesh.ply', 'import_scene.obj']) {
      const advice = inBrowserEditor(operator);
      expect(advice).toBe(
        `a browser editor runs it in its own memory: editor_command {command: 'run_operator', params: {operator: '${operator}', params: {data_base64}}}`,
      );
      expect(registry.has(operator), operator).toBe(true);
      const schema = registry.describe().find((d) => d.id === operator)?.parameters as
        { properties?: Record<string, unknown> } | undefined;
      expect(Object.keys(schema?.properties ?? {}), operator).toContain('data_base64');
      expect(() =>
        checkEditorCommand('run_operator', { operator, params: { data_base64: 'Z2xURg==' } }),
      ).not.toThrow();
    }
    // the doc's example has the refusal's shape: the operator and the file in params.data_base64
    expect(inBrowserEditor('import_scene.gltf')).toContain(
      doc.slice(doc.indexOf('{operator: "import_scene.gltf"'), doc.indexOf('}}') + 2).replace(/"/g, "'"),
    );
  });
});

/**
 * The last sentence of an editor_command timeout: how the ranges were made and how much longer the
 * steps took on a busy machine. `millions`: the step with 4 million triangles whose time the message
 * gives, whose range runs further above its longest time; a message names only its own step (a
 * select's timeout says nothing of screenshots).
 */
const measuredSentence = (millions?: string) =>
  'The times given are the ranges measured on a calm machine with 4 CPUs, the editor in software WebGL, ' +
  `widened by ${MARGIN_PERCENT} %` +
  (millions ? ` (the longest ${millions} with 4 million triangles by ${MILLIONS_MARGIN_PERCENT} %)` : '') +
  `; on a busy one (load averages of ${BUSY_LOADS}) the same steps took up to ${BUSY_FACTOR} times as long.`;

describe('editor command timeouts', () => {
  const HEAD = 'it may still carry the command out, and its next commands and renders wait until it has.';
  const NO_GPU = 'An editor without GPU acceleration (software WebGL, e.g. a headless browser)';
  /**
   * Measured (docs/mcp.md, editor-costs.ts): the first screenshot or frame in MATERIAL or RENDERED
   * shading, an edit that needs a shader no material had until it is drawn, a SOLID screenshot and a
   * select of 4 million triangles, and grey clay rendered on the server; the last sentence says how
   * the ranges were made and how much longer the steps took on a busy machine.
   */
  const NEW_SHADER = NEW_SHADER_SECONDS;
  const HEAVY = `${MILLIONS_SOLID_SECONDS} in SOLID with 4 million`;
  /** The first screenshot or frame in a shading: the editor builds and compiles its materials. */
  const FIRST = `(${FIRST_SHADING_SECONDS} for a scene with 71 materials)`;
  /** Only an edit that needs a shader no material had makes the next screenshot compile one. */
  const NEEDS =
    'a material edit that needs a shader no material had (coat or sheen turned on, a procedural texture ' +
    'on a set of channels that no other material has)';
  const edited = (next: string) => `After ${NEEDS}, its next ${next} compiles it (${NEW_SHADER}).`;
  const KEPT =
    'It keeps what it compiled, so a retry waits for the editor to finish and compiles nothing again.';
  const VIEWPORT =
    "The screenshot is drawn in the viewport's shading, like a frame of the viewport. An editor without GPU " +
    'acceleration (software WebGL, e.g. a headless browser) takes half a second or more for that with a ' +
    `scene of millions of triangles in any shading (${HEAVY}), ${WIRES}, seconds with a heavy scene in ` +
    'MATERIAL or RENDERED shading, and its ' +
    'first screenshot or frame in one of these two after it opened the project takes longer, while it ' +
    `builds and compiles the scene's materials for that shading ${FIRST}. ` +
    `${edited('screenshot or frame in each of these two')} ${KEPT}`;
  const shaded = (shading: string) =>
    `${NO_GPU} takes seconds per ${shading} screenshot of a heavy scene, and its first ${shading} ` +
    'screenshot or viewport frame after it opened the project takes longer, while it builds and compiles ' +
    `the scene's materials for ${shading} shading ${FIRST}. ` +
    `${edited(`${shading} screenshot or viewport frame`)} ${KEPT}`;
  const fast = (shading: string) =>
    `${NO_GPU} takes half a second or more per screenshot of a scene with millions of triangles even in ` +
    `${shading} shading, ${WIRES}, and a screenshot waits until the frame its viewport is drawing is done. In MATERIAL or ` +
    `RENDERED shading that frame compiles shaders the first time after the editor opened the project ` +
    `(${FIRST_SHADING_SECONDS} for a scene with 71 materials, while it builds and compiles the scene's ` +
    'materials) and after a material ' +
    'edit that needs a shader no material had (coat or sheen turned on, a procedural texture on a set of ' +
    `channels that no other material has: ${NEW_SHADER}). ${KEPT}`;
  /**
   * A command other than a screenshot waits for the editor's main thread, not for the viewport's
   * frames: only the first ones in MATERIAL, RENDERED or WIREFRAME shading build materials or wires
   * on it (round 11 said that commands wait while the editor draws its viewport and that it draws a
   * scene of millions of triangles slowly: get_view probes sent while the viewport drew its frames
   * answered within 0.14 s). It also waits while the editor applies a change made elsewhere, and
   * every request waits while the server holds up its event loop (a save and the two short holds
   * right after it, the minute's read, an editor opening the project): a timeout_ms of a few seconds
   * can run out in these alone, which round 12's message did not name.
   */
  const viewport = (command: string) =>
    `'${command}' waits while the editor's main thread is busy, and while the server holds up every request: ` +
    `while it saves a project after a change (with 4 million triangles ${SAVE_HOLD_SECONDS}, then twice more ` +
    `for at most ${AFTER_SAVE_HOLD_SECONDS}), reads back from storage a project that an editor has open (once ` +
    `a minute) or sends a project to an editor that opens it (${READ_HOLD_SECONDS}). ${NO_GPU} is busy for ` +
    "seconds with its first frame of a heavy scene in MATERIAL or RENDERED shading, while it builds and compiles the scene's " +
    'materials, and with its first WIREFRAME frame of a scene with millions of triangles, while it builds ' +
    'the wires of every mesh; with millions of triangles it is also busy while it carries out a command ' +
    `(with 4 million in SOLID shading a select took ${MILLIONS_SELECT_SECONDS}) and while it applies a change ` +
    `made elsewhere (${CHANGE_APPLY_SECONDS} for an agent's move of an object among 4 million triangles), but ` +
    'not while it draws its other frames.';
  /**
   * The server cannot know the viewport's shading (the person can change it): switching to SOLID is
   * advised only for a viewport in another shading (a select of 4 million triangles in SOLID shading
   * used to be told to switch to SOLID).
   */
  const SWITCH =
    "if the viewport is not in SOLID shading, switch it to SOLID (editor_command view.shading {shading: 'SOLID'}), " +
    'which draws much faster.';
  /**
   * Grey clay rendered on the server: a render process holds the scene (SERVER_SOLID_SECONDS); a
   * scene that needs more memory than a render process has fails with code OUT_OF_MEMORY and a
   * message that starts 'Rendering failed: out of memory: ', and then only a retry of the screenshot
   * shows it (round 8 named an out-of-memory error after 17.4–21.4 s with 2 million triangles, where
   * the server now renders them).
   */
  const tooLarge = (atMax: boolean) =>
    "a scene that needs more memory than a server render has fails with 'Rendering failed: out of memory: " +
    `…' (code OUT_OF_MEMORY), and then retry the screenshot${atMax ? '' : ' with a larger timeout_ms'}`;
  /**
   * The quick look of the other screenshots: renderer 'auto' renders on the server while the editor
   * is busy (right after the timeout) and for a PATHTRACER scene (render_image asks a browser editor
   * only for RASTER images).
   */
  const solidAdvice = (atMax: boolean) =>
    "pass shading 'SOLID' for the screenshot (grey clay, much faster); for a quick look use render_image " +
    "with shading 'SOLID' (grey clay: while the editor is busy, as right after this timeout, and when the " +
    `scene's render engine is PATHTRACER, it renders on the server: ${SERVER_SOLID_SECONDS}; ${tooLarge(atMax)}), ` +
    'and render_image for final images.';
  /**
   * A look without the editor after a SOLID or WIREFRAME screenshot timed out: grey clay on the server.
   * Without shading 'SOLID', renderer 'software' renders with the scene's engine, and so path traces
   * a PATHTRACER scene (domino-cascade: 31.1 and 32.8 s at 640×360, its time_limit reached).
   */
  const solidRender = (atMax: boolean) =>
    "render without the editor: render_image with shading 'SOLID' and renderer 'software' (grey clay, " +
    `rendered on the server: ${SERVER_SOLID_SECONDS}; ${tooLarge(atMax)}).`;
  const BUSY =
    "It was still busy with an earlier request that the server had stopped waiting for (editor_command 'screenshot' sent 12 s ago).";
  /** The cases: command, params, why it can take long, the advice below and at the maximum. */
  const cases: [string, Record<string, unknown>, string, string, string][] = [
    [
      'screenshot',
      {},
      VIEWPORT,
      `Retry with a larger timeout_ms (at most 55000), or ${solidAdvice(false)} ${measuredSentence('SOLID screenshot')}`,
      `With timeout_ms at its maximum (55000), retry or ${solidAdvice(true)} ${measuredSentence('SOLID screenshot')}`,
    ],
    ...(['MATERIAL', 'rendered'] as const).map(
      (shading): [string, Record<string, unknown>, string, string, string] => [
        'screenshot',
        { shading, width: 640 },
        shaded(shading.toUpperCase()),
        `Retry with a larger timeout_ms (at most 55000), or ${solidAdvice(false)} ${measuredSentence()}`,
        `With timeout_ms at its maximum (55000), retry or ${solidAdvice(true)} ${measuredSentence()}`,
      ],
    ),
    ...(['SOLID', 'wireframe'] as const).map(
      (shading): [string, Record<string, unknown>, string, string, string] => [
        'screenshot',
        { shading },
        fast(shading.toUpperCase()),
        `Retry with a larger timeout_ms (at most 55000), or ${solidRender(false)} ${measuredSentence()}`,
        `With timeout_ms at its maximum (55000), retry or ${solidRender(true)} ${measuredSentence()}`,
      ],
    ),
    ...['select', 'set_frame', 'view.set_view', 'run_operator'].map(
      (command): [string, Record<string, unknown>, string, string, string] => [
        command,
        {},
        viewport(command),
        `Pass a larger timeout_ms (at most 55000), or, ${SWITCH} ${measuredSentence('select')}`,
        `With timeout_ms at its maximum (55000), retry, or, ${SWITCH} ${measuredSentence('select')}`,
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
          expect(/a larger timeout_ms \(at most 55000\), or[ ,]/.test(msg), label).toBe(
            timeout < MAX_EDITOR_TIMEOUT_MS,
          );
          // the times of every message were measured on a calm machine, and it says how much longer
          // they took on a busy one
          const millions =
            command !== 'screenshot' ? 'select' : params.shading ? undefined : 'SOLID screenshot';
          expect(msg.endsWith(` ${measuredNote(millions)}`), label).toBe(true);
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

  it('give the server render with its measured times, and the screenshot again where the server cannot hold the scene', () => {
    // round 8 sent agents to grey clay on the server with "which can run out of memory for millions of
    // triangles", although its render worker then took the whole server down for a grid of 2 million;
    // render processes (round 9) hold millions of triangles, and a render that runs out of memory
    // fails with renderToolError's message: then only the editor can show the scene
    for (const shading of [undefined, 'MATERIAL', 'RENDERED', 'SOLID', 'WIREFRAME'])
      for (const timeout of [10_000, MAX_EDITOR_TIMEOUT_MS]) {
        const msg = editorTimeoutMessage('screenshot', timeout, null, shading ? { shading } : {});
        const label = `${shading} ${timeout}`;
        expect(msg, label).toContain(`on the server: ${SERVER_SOLID_SECONDS};`);
        expect(msg, label).toContain(
          "a scene that needs more memory than a server render has fails with 'Rendering failed: out of " +
            "memory: …' (code OUT_OF_MEMORY), and then retry the screenshot",
        );
        expect(msg.includes('and then retry the screenshot with a larger timeout_ms'), label).toBe(
          timeout < MAX_EDITOR_TIMEOUT_MS,
        );
        expect(msg, label).not.toMatch(/which can run out of memory|ran out of memory after/);
      }
    // the server's message for a render that ran out of memory starts as the advice quotes it, with
    // the code the advice names (the render process's error, render/pool.ts)
    for (const oom of [
      renderProcessExitError(1, null, 'FATAL ERROR: … JavaScript heap out of memory', 256),
      renderProcessExitError(null, 'SIGKILL', '', 256),
    ]) {
      const err = renderToolError(oom);
      expect(err.message).toMatch(/^Rendering failed: out of memory: the render process /);
      expect(err.code).toBe('OUT_OF_MEMORY');
    }
  });

  it('say where the quick look renders: on the server while the editor is busy and for a PATHTRACER scene', () => {
    // right after a timeout the editor still draws the screenshot, so renderer 'auto' renders on the
    // server; it asks a browser editor only for RASTER images (mcp-error-codes.test.ts renders the
    // quick look in both cases and with an idle editor)
    for (const shading of [undefined, 'MATERIAL', 'RENDERED'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, shading ? { shading } : {})).toContain(
        "for a quick look use render_image with shading 'SOLID' (grey clay: while the editor is busy, as right " +
          "after this timeout, and when the scene's render engine is PATHTRACER, it renders on the server: " +
          `${SERVER_SOLID_SECONDS};`,
      );
  });

  it('advise switching the viewport to SOLID only for a viewport in another shading', () => {
    // a select of a 4 million triangle scene timed out in SOLID shading, and the message told the
    // agent to switch the viewport to SOLID; the server cannot know the viewport's shading
    for (const command of ['select', 'set_frame', 'run_operator'])
      for (const timeout of [10_000, MAX_EDITOR_TIMEOUT_MS]) {
        const msg = editorTimeoutMessage(command, timeout);
        expect(msg).toContain(`, or, ${SWITCH}`);
        expect(msg).not.toMatch(/, or switch the viewport to SOLID shading/);
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

describe('the measured costs', () => {
  it('are the ranges measured on a calm machine, and every text that gives one says how much longer they took on a busy one', () => {
    // docs/mcp.md has the measurements behind them (examples/domino-cascade in headless Chromium,
    // server renders through MCP; calm runs, and the same steps on the machine kept busy), and
    // docs-errors.test.ts checks that it gives the same values; here: each is a measured range
    const ranges = (text: string) =>
      [...text.matchAll(/(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) s\b/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [name, text, count] of [
      ['FIRST_SHADING_SECONDS', FIRST_SHADING_SECONDS, 1],
      ['LATER_SECONDS', LATER_SECONDS, 1],
      ['FAST_SECONDS', FAST_SECONDS, 1],
      ['NEW_SHADER_SECONDS', NEW_SHADER_SECONDS, 1],
      ['MILLIONS_SOLID_SECONDS', MILLIONS_SOLID_SECONDS, 1],
      ['MILLIONS_SELECT_SECONDS', MILLIONS_SELECT_SECONDS, 1],
      ['SERVER_SOLID_SECONDS', SERVER_SOLID_SECONDS, 2],
      ['SERVER_SOLID_SCENE_SECONDS', SERVER_SOLID_SCENE_SECONDS, 1],
      ['BROWSER_RASTER_SECONDS', BROWSER_RASTER_SECONDS, 3],
    ] as const) {
      const found = ranges(text);
      expect(found, name).toHaveLength(count);
      for (const [lo, hi] of found) expect(lo, name).toBeLessThan(hi);
    }
    expect(Number(BUSY_FACTOR)).toBeGreaterThan(1);
    expect(BUSY_LOADS).toMatch(/^\d+(\.\d+)?–\d+(\.\d+)?$/);
    // every range was widened by the margin (editor-costs.ts says why), and the texts say so
    expect(Number(MARGIN_PERCENT)).toBeGreaterThan(0);
    const made = `the range widened by ${MARGIN_PERCENT} %`;
    expect(measured('1–2 s')).toBe(
      `1–2 s, measured on a calm machine with 4 CPUs in software WebGL (${made}), up to ${BUSY_FACTOR} times as long on a busy one`,
    );
    expect(measuredOnServer('1–2 s')).toBe(
      `1–2 s, measured on a calm server with 4 CPUs (${made}), up to ${BUSY_FACTOR} times as long on a busy one`,
    );
    for (const millions of [undefined, 'select', 'SOLID screenshot'] as const)
      expect(measuredNote(millions), millions).toBe(measuredSentence(millions));
    // the ranges of a select and a SOLID screenshot with 4 million triangles run further above their
    // longest time: made with MARGIN_PERCENT from fewer agents' runs, they missed later agents' runs
    // (round 10's third verifier: 0.731 s against 0.1–0.7 s, 3.478 s against 0.5–3.4 s)
    expect(Number(MILLIONS_MARGIN_PERCENT)).toBeGreaterThan(Number(MARGIN_PERCENT));
    // a range that held on a calm machine reads as one at any load unless the text says how much
    // longer it took on a busy one (round 8: 46 of 137 values of a busy machine were outside the
    // ranges, which said only that the times vary); the descriptions of editor_command and
    // render_image are checked in mcp-error-codes.test.ts
    const texts = [
      MCP_INSTRUCTIONS,
      ...[undefined, 'MATERIAL', 'RENDERED', 'SOLID', 'WIREFRAME'].flatMap((shading) =>
        [10_000, MAX_EDITOR_TIMEOUT_MS].map((t) =>
          editorTimeoutMessage('screenshot', t, null, shading ? { shading } : {}),
        ),
      ),
      ...[10_000, MAX_EDITOR_TIMEOUT_MS].map((t) => editorTimeoutMessage('select', t)),
    ];
    for (const text of texts) {
      expect(text).toMatch(/\d s\b/);
      expect(text).toMatch(
        new RegExp(
          `on a calm (machine|server) with 4 CPUs.*widened by ${MARGIN_PERCENT} %.*up to ${BUSY_FACTOR.replace('.', '\\.')} times as long`,
        ),
      );
      expect(text).not.toMatch(/vary(ing)? with the machine's load/);
    }
  });
});

describe('the cost of screenshots', () => {
  /*
   * Measured in headless Chromium with software WebGL (SwiftShader), a scene of 81 objects and 71
   * materials at 1280×720 (docs/mcp.md): the first screenshot or viewport frame in MATERIAL or
   * RENDERED shading after the editor opened the project builds and compiles the scene's materials
   * for that shading; the editor keeps them (scene-objects.ts materialSets), so later screenshots in
   * it compiled nothing, also after the viewport switched to it, and a retry of a first screenshot
   * that timed out waited for the rest of it and compiled nothing again. A material edit builds that
   * material again and keeps the one it replaces until the new one has been drawn in every shading
   * the old one was drawn in (scene-objects.ts replaceSlot): an edit of values compiled nothing in
   * either shading, and one that needs a shader no material had compiled it once in each. The texts
   * must tell the first screenshot in a shading from later ones and name the edits that compile, and
   * no text may claim a compile that the editor no longer does. A screenshot that compiles nothing
   * still costs a frame of its own shading at its own size and work of its own (rpc.ts), which took
   * longer than a frame of the viewport: no text calls it one frame.
   */
  const overstated =
    /tens of seconds (per screenshot|for a screenshot in)|each screenshot then builds|while (its|the) viewport shows another/;
  /** A text that says the editor keeps what it built, or that later screenshots compile nothing. */
  const promisesReuse = /keeps (them|what it compiled|it)|compiles? nothing/;
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

  it('takes longer only for the first screenshot or frame in a shading, which the editor keeps', () => {
    const first = `(${FIRST_SHADING_SECONDS} for a scene with 71 materials)`;
    for (const shading of ['MATERIAL', 'rendered']) {
      const msg = editorTimeoutMessage('screenshot', 10_000, null, { shading });
      expect(msg).not.toMatch(overstated);
      expect(msg).toContain(
        `its first ${shading.toUpperCase()} screenshot or viewport frame after it opened the project takes ` +
          `longer, while it builds and compiles the scene's materials for ${shading.toUpperCase()} shading ${first}.`,
      );
      expect(msg).toContain(
        'It keeps what it compiled, so a retry waits for the editor to finish and compiles nothing again.',
      );
    }
    // in the viewport's own shading a screenshot is a frame of the viewport
    const own = editorTimeoutMessage('screenshot', 10_000);
    expect(own).not.toMatch(overstated);
    expect(own).toContain("The screenshot is drawn in the viewport's shading, like a frame of the viewport.");
    expect(own).toContain(
      'its first screenshot or frame in one of these two after it opened the project takes longer, while it ' +
        `builds and compiles the scene's materials for that shading ${first}.`,
    );
    expect(MCP_INSTRUCTIONS).not.toMatch(overstated);
    expect(MCP_INSTRUCTIONS).toContain(
      'a screenshot of a heavy scene in MATERIAL or RENDERED shading takes seconds, the first screenshot or ' +
        'viewport frame in each of them after the editor opened the project longer (it builds and compiles ' +
        `the scene's materials for that shading, ${measured(`${FIRST_SHADING_SECONDS} for a scene with 71 materials`)}, ` +
        'and keeps them',
    );
    // round 9 gave the first one as "tens of seconds" without a number
    for (const text of [MCP_INSTRUCTIONS, ...screenshots]) expect(text).not.toMatch(/tens of seconds/);
    expect(MCP_INSTRUCTIONS).toContain(
      'a screenshot that timed out still compiles what it needs and keeps it, so retrying it waits for the rest and compiles nothing again',
    );
  });

  it('name the material edits that compile a shader, with the measured range, and only those', () => {
    const cost = NEW_SHADER_SECONDS;
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
      expect(msg).toContain('so a retry waits for the editor to finish and compiles nothing again.');
      expect(msg).toContain('Retry with a larger timeout_ms (at most 55000)');
      expect(msg.endsWith(measuredNote())).toBe(true);
    }
    expect(MCP_INSTRUCTIONS).toContain(
      "it builds and compiles the scene's materials for that shading, " +
        `${measured(`${FIRST_SHADING_SECONDS} for a scene with 71 materials`)}, and keeps them, also when the viewport ` +
        'turns its anti-aliasing off and through material edits that change values; an edit that needs a ' +
        'shader no material had, such as coat or sheen turned ' +
        'on or a procedural texture on a set of channels that no other material has, makes the next one in ' +
        `each of them compile it: ${measured(cost)})`,
    );
    // no text promises reuse without the exception
    for (const text of [MCP_INSTRUCTIONS, ...screenshots])
      if (promisesReuse.test(text)) expect(text).toMatch(/needs a shader no material had/i);
  });

  it("cover scenes with millions of triangles, also in the viewport's shading", () => {
    // since round 10 a SOLID screenshot of 4 million triangles takes about a second (round 9's code
    // spent seconds per frame counting the scene's edges for the statistics overlay): no text says
    // that such a scene takes seconds per frame or per screenshot in any shading
    expect(editorTimeoutMessage('screenshot', 10_000)).toContain(
      'takes half a second or more for that with a scene of millions of triangles in any shading ' +
        `(${MILLIONS_SOLID_SECONDS} in SOLID with 4 million)`,
    );
    for (const shading of ['SOLID', 'WIREFRAME'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        `takes half a second or more per screenshot of a scene with millions of triangles even in ${shading} shading`,
      );
    // the first WIREFRAME screenshot or frame of a mesh builds its wires (with 4 million triangles
    // several times as long as a SOLID screenshot), which a SOLID screenshot also waits for when
    // the viewport draws it
    for (const shading of ['SOLID', 'WIREFRAME'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        `even in ${shading} shading, ${WIRES}, and a screenshot waits until the frame its viewport is drawing is done.`,
      );
    expect(editorTimeoutMessage('screenshot', 10_000)).toContain(
      `(${MILLIONS_SOLID_SECONDS} in SOLID with 4 million), ${WIRES}, seconds with a heavy scene in MATERIAL or ` +
        'RENDERED shading',
    );
    // a select took a fraction of a second: its first WIREFRAME frame is not "several times as long"
    // as that but seconds (docs/mcp.md gives the measured range with 4 million triangles)
    expect(editorTimeoutMessage('select', 10_000)).toContain(
      'and with its first WIREFRAME frame of a scene with millions of triangles, while it builds the wires of ' +
        'every mesh;',
    );
    // the viewport's other frames do not hold commands up (get_view probes sent while the viewport
    // drew them answered within 0.14 s): round 11 said that a command waits while the editor draws
    // its viewport and that it draws a scene with millions of triangles slowly
    expect(editorTimeoutMessage('select', 10_000)).not.toMatch(
      /waits while the editor draws its viewport|draws a scene with millions of triangles slowly/,
    );
    expect(editorTimeoutMessage('select', 10_000)).not.toContain('several times as long');
    expect(MCP_INSTRUCTIONS).toContain(
      'and one of a scene with millions of triangles half a second or more in any shading, the first in ' +
        'WIREFRAME shading several times as long:',
    );
    for (const text of [MCP_INSTRUCTIONS, ...screenshots, editorTimeoutMessage('select', 10_000)])
      expect(text).not.toMatch(/seconds per frame|takes seconds for that|can take seconds per screenshot/);
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
      expect(text).not.toMatch(/second of (the|these) two|1\.2–11\.9|can compile shaders again/);
      expect(text).not.toMatch(/(recompil|second shading)[^;)]*11\.9 s/);
      expect(text).not.toMatch(/4–38 ms|8\.4 s|17\.5|sent right after|right after the viewport switched/);
      expect(text).not.toMatch(/transmission turned on|or transmission/);
    }
  });

  /*
   * The doc comment of MILLIONS_SELECT_SECONDS said a select waits "after the frame or screenshot it
   * is drawing": the viewport's frames do not hold a command up (round 11's TEXTS agent profiled the
   * select: the statistics overlay counts the edges of every mesh again), only a screenshot, and the
   * first frames that build materials or wires, do.
   */
  it("say in the doc comment of MILLIONS_SELECT_SECONDS that the viewport's frames do not hold a select up", () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/mcp/editor-costs.ts', import.meta.url)),
      'utf8',
    );
    const at = src.indexOf('export const MILLIONS_SELECT_SECONDS');
    const comment = src.slice(src.lastIndexOf('/**', at), at).replace(/\s*\n\s*\* ?/g, ' ');
    expect(comment).toContain(
      "once its main thread is free (after a screenshot it is drawing; the viewport's frames do not hold it " +
        'up, apart from the first ones that build materials or wires), counting the edges of every mesh ' +
        'again for the statistics overlay',
    );
    expect(comment).not.toContain('after the frame or screenshot it is drawing');
  });

  it('give the measurements behind the texts in the doc comment of editorTimeoutMessage', () => {
    // the doc comment names the mechanism (scene-objects.ts replaceSlot keeps the replaced material
    // for every shading it was drawn in) and the constants of editor-costs.ts, whose header says how
    // their ranges were made: it states no numbers of its own, which could disagree with them
    expect(docComment).toContain(
      'A material edit builds that material again and keeps the one it replaces until the new one has ' +
        'been drawn in every shading the old one was drawn in (scene-objects.ts replaceSlot)',
    );
    expect(docComment).toContain(
      'The times come from editor-costs.ts (its header says how they were measured and made: calm runs of ' +
        'nine agents in headless Chromium with software WebGL, pooled, widened by MARGIN_PERCENT, the longest ' +
        'select and SOLID screenshot with 4 million triangles by MILLIONS_MARGIN_PERCENT; on a machine kept ' +
        'busy by other processes the same steps took up to BUSY_FACTOR times as long, which the messages say ' +
        'with {@link measuredNote}).',
    );
    for (const name of [
      '{@link FIRST_SHADING_SECONDS} for a scene of 81 objects and 71 materials',
      'compiled nothing (LATER_SECONDS)',
      'SOLID or WIREFRAME ones took FAST_SECONDS',
      "({@link NEW_SHADER_SECONDS}: longest for the table's material, whose colour, roughness and bump are " +
        'procedural textures)',
      'a SOLID screenshot took {@link MILLIONS_SOLID_SECONDS}',
      'a select {@link MILLIONS_SELECT_SECONDS}; a SOLID screenshot sent as soon as a select had answered ' +
        'waits for the frame the viewport draws then (a screenshot waits for the frames in progress), and ' +
        'these ranges include it and selects sent as soon as a screenshot had answered. Other commands do ' +
        "not wait for the viewport's frames, only for the work that holds the editor's main thread",
      'took {@link SERVER_SOLID_SECONDS} in a render process',
      // round 12: what else holds a command up (the editor applying a change made elsewhere, the
      // server's holds), which a timeout_ms of a few seconds can run out in
      "and applying a change made elsewhere (another agent's move of an object) {@link CHANGE_APPLY_SECONDS}",
      'while it saves a project after a change ({@link SAVE_HOLD_SECONDS}, then twice more for at most ' +
        '{@link AFTER_SAVE_HOLD_SECONDS} while it takes fingerprints of what it wrote)',
      'sends a project to an editor that opens it ({@link READ_HOLD_SECONDS})',
    ])
      expect(docComment).toContain(name);
    expect(docComment).not.toMatch(/\d\.\d+–\d|\d s\b/);
    // a screenshot is drawn with the viewport's sample count, so it builds no pipelines also after the
    // viewport drew its shading without multisampling (engine.ts captureSamples)
    expect(docComment).toContain(
      "A screenshot is drawn with the viewport's sample count, or with the other one when its shading " +
        'was drawn only with that one (apps/web engine.ts captureSamples)',
    );
    expect(docComment).toContain('(more than a million triangles, slow frames) built none.');
    expect(docComment).not.toMatch(/one frame/);
    // a render that runs out of memory: renderToolError's message and its stable start
    expect(docComment).toContain(
      'fails with renderToolError\'s message (rendering.ts), which starts "Rendering failed: out of memory: "',
    );
    expect(docComment).not.toMatch(/ran out of memory after|which can run out of memory/);
    const engineSource = readFileSync(
      fileURLToPath(new URL('../../../web/src/viewport/engine.ts', import.meta.url)),
      'utf8',
    );
    expect(engineSource).toContain('private captureSamples(): number {');
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
      'the viewport camera (target, distance, yaw, pitch, ortho, camera view); while the viewport animates a ' +
        'view change (an axis view, an orbit step or framing, asked for by a command, an operator or the person) ' +
        'the view it ends on',
    );
  });

  it('name every kind of view change the viewport animates, not only those of the view commands', () => {
    // the view changes that animate are the operators that call setPose(…, true) or frameSphere (which
    // animates by default): an axis view, an orbit step and framing. The view commands run them
    // (rpc.ts), the person runs them with Numpad 1/3/7, 4/6/8/2, Home, Numpad . and the navigation
    // gizmo, and an agent with editor_command run_operator, so the doc names the kinds, not the
    // commands (which left out run_operator view3d.view_orbit, and named view.set_view, whose CAMERA
    // view does not animate)
    const src = readFileSync(
      fileURLToPath(new URL('../../../web/src/editor/ui-operators.ts', import.meta.url)),
      'utf8',
    );
    const animated = src
      .split('reg.register(')
      .filter((block) => /setPose\([^)]*, true\)|frameSphere\(/.test(block))
      .map((block) => block.match(/id: '([\w.]+)'/)?.[1]);
    expect(animated.sort()).toEqual([
      'view3d.view_all',
      'view3d.view_axis',
      'view3d.view_orbit',
      'view3d.view_selected',
    ]);
    // nothing else in the web app animates the view (interaction.ts setOrthoAuto, which would, is
    // called nowhere)
    const webSrc = fileURLToPath(new URL('../../../web/src/', import.meta.url));
    const animating = readdirSync(webSrc, { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) => {
        const text = readFileSync(join(webSrc, f), 'utf8');
        const calls: string[] = [...(text.match(/\.setPose\([^)]*,\s*true\)|\.frameSphere\(/g) ?? [])];
        if (/\.setOrthoAuto\(/.test(text)) calls.push('setOrthoAuto()');
        return calls.length ? [`${f.replace(/\\/g, '/')}: ${calls.length}`] : [];
      });
    expect(animating.sort()).toEqual(['editor/ui-operators.ts: 5', 'viewport/interaction.ts: 1']);
    const interaction = readFileSync(join(webSrc, 'viewport/interaction.ts'), 'utf8');
    const ortho = interaction.slice(interaction.indexOf('  setOrthoAuto(): void {'));
    expect(ortho.slice(0, ortho.indexOf('\n  }\n'))).toContain('this.engine.setPose(p, true);');
    const engine = readFileSync(
      fileURLToPath(new URL('../../../web/src/viewport/engine.ts', import.meta.url)),
      'utf8',
    );
    expect(engine).toContain('frameSphere(sphere: THREE.Sphere | null, animate = true): void {');
    // the camera view only switches what the viewport looks through
    const camera = src.slice(src.indexOf("id: 'view3d.view_camera'"));
    expect(camera.slice(0, camera.indexOf('reg.register('))).not.toMatch(/setPose|frameSphere/);
    const doc = EDITOR_COMMANDS.get_view.doc;
    expect(doc).toContain('an axis view, an orbit step or framing');
    expect(doc).not.toMatch(/view\.set_view|view\.frame_all|view\.frame_selected/);
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
