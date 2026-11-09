import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_UI_OPERATORS, createOperatorRegistry } from '@3d-editor/core';
import {
  EDITOR_COMMANDS,
  MAX_EDITOR_TIMEOUT_MS,
  checkEditorCommand,
  editorClosedMessage,
  editorTimeoutMessage,
} from '../../src/mcp/editor-commands';
import {
  BROWSER_RASTER_SECONDS,
  BUSY_FACTOR,
  BUSY_LOADS,
  MILLIONS_SOLID_SECONDS,
  NEW_SHADER_SECONDS,
  SERVER_SOLID_SECONDS,
} from '../../src/mcp/editor-costs';
import { MCP_INSTRUCTIONS } from '../../src/mcp/instructions';
import { DELETED_ELSEWHERE_NOTE, LIST_FAILED_NOTE } from '../../src/mcp/project-storage';
import {
  AUTO_BROWSER_RASTER_TIMEOUT_MS,
  BROWSER_RASTER_TIMEOUT_MS,
  OUT_OF_MEMORY_ADVICE,
  browserRenderFailure,
  renderToolError,
  samplesArg,
} from '../../src/mcp/rendering';
import { RpcError } from '../../src/sync/room';
import { RenderOutOfMemoryError } from '../../src/render';
import { sharedProcessError } from '../../src/render/pool';
import {
  browserUiOperator,
  browserUiOperatorsNote,
  closestOperatorIds,
  toolOnlyOperator,
} from '../../src/mcp/operator-groups';

/*
 * docs/mcp.md and docs/agent-guide.md describe the error codes and the waits for browser editors
 * that agents branch on: they must say what the server does. Which render operators are FAILED
 * (refused for a tool) and which NOT_FOUND (browser UI operators), how screenshots are drawn, how
 * long the server waits for an editor, and until when it sends progress.
 */

const read = (doc: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../docs/${doc}`, import.meta.url)), 'utf8');
const mcp = read('mcp.md');
const guide = read('agent-guide.md');
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** The cells of the Markdown table row whose first cell is `first`. */
function row(doc: string, first: string): string {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${first}`));
  expect(line, first).toBeDefined();
  return line!;
}

/**
 * The measured ranges that docs/mcp.md, the agent guide and the server's texts give (calm runs; see
 * 'docs: measured times'), by the names of the measurements in docs/mcp.md: A the first MATERIAL or
 * RENDERED screenshot, B the next ones, V a retry of a first screenshot that timed out, FIRST the
 * first screenshot or frame in a shading, LATER later screenshots, J screenshots after edits of
 * material values, E1/HVM_SS the first frame and next screenshots with a million triangles more,
 * E1M/MSX_SS after a large viewport, NEWSH a new shader of a plastic, PW/PB/PP sheen turned on for
 * the table, dowels and floor, PROC_MAX the table's maximum, S the main thread after the first
 * switch to MATERIAL or RENDERED, U/U_AFTER get_view during and after a select with 4 million
 * triangles, BR_FIRST, BR_LATER and BRH browser raster images, D and RS_1M grey clay on the server,
 * VF_ and SS_ viewport frames and screenshots (in the page), CALM_LOAD and BUSY_LOAD the load
 * averages of the runs.
 */
// measured ranges: begin
const M = {
  A: '18.7–22.5 s',
  B: '1.0–1.4 s',
  BRH: '2.1–8.1 s',
  BR_FIRST: '22.8–23.3 s',
  BR_LATER: '3.5–4.1 s',
  BUSY_LOAD: '6–20',
  D: '1.6–3.1 s',
  E1: '11.9–13.3 s',
  E1M: '11.8–12.8 s',
  FIRST: '18.6–25.4 s',
  HVM_SS: '1.2–2.6 s',
  J: '0.8–3.1 s',
  LATER: '0.5–2.6 s',
  MSX_SS: '0.5–0.8 s',
  NEWSH: '0.9–3.1 s',
  PB: '8.4–9.8 s',
  PP: '2.2–2.8 s',
  PROC_MAX: '11.7 s',
  PW: '10.8–11.7 s',
  RS_1M: '1.6–2.4 s',
  RS_COLD: '3.2–3.5 s',
  RS_EDITOR: '4.0–9.8 s',
  RS_MEM: '1.6 GB for 2 million triangles, 2.5 GB for 4 million and 3.2 GB for 6 million',
  RS_OOM_256: '2.1–2.7 s',
  S: '4.0–4.7 s',
  SERVER_SOLID_DETAIL:
    '1.7–4.9 s for a grid of 2 million triangles, 3.0–6.4 s for 4 million and 4.4–8.6 s for 6 million (the first render of a version of the scene, which sends it to the render process, took the longer times)',
  SS_NEXT_REN: '0.39–0.64 s',
  SS_NEXT_SOLID: '0.17–0.27 s',
  SS_REN: '0.60–0.72 s',
  SS_REN_1280: '0.80–1.03 s',
  SS_REN_OTHER: '0.61–0.74 s',
  SS_REN_OTHER_1280: '0.81–1.02 s',
  SS_RT: '30–100 ms',
  SS_SOLID: '0.37–0.57 s',
  SS_SOLID_1280: '0.49–0.63 s',
  U: '8.6 s',
  U_AFTER: '6.1 s',
  U_AFTER_SENT: '0.1 s',
  V: '18.8–20.8 s',
  VF_REN: '0.42–0.67 s',
  VF_SOLID: '0.19–0.29 s',
};
// measured ranges: end

describe('docs: error codes of refused render operators', () => {
  it('render.render_software and render.render_animation are FAILED, render.render is NOT_FOUND', () => {
    const registry = createOperatorRegistry();
    const failed = registry
      .list()
      .map((d) => d.id)
      .filter((id) => toolOnlyOperator(id));
    expect(failed.sort()).toEqual(['render.render_animation', 'render.render_software']);
    expect(BROWSER_UI_OPERATORS).toContain('render.render');
    // the code table of docs/mcp.md
    const failedRow = row(mcp, '`FAILED`');
    for (const id of failed) expect(failedRow).toContain(id);
    expect(failedRow).not.toMatch(/`render\.\*`/);
    expect(row(mcp, '`NOT_FOUND`')).toContain('`render.render` included');
    // the FAILED bullet of the agent guide
    const bullet = guide.slice(
      guide.indexOf('- `FAILED`:'),
      guide.indexOf('\n\n', guide.indexOf('- `FAILED`:')),
    );
    for (const id of failed) expect(bullet).toContain(id);
    expect(bullet).toMatch(/`render\.render` is a browser UI operator: `NOT_FOUND`/);
    expect(bullet).not.toMatch(/or `render\.\*`/);
  });
});

describe('docs: browser editors', () => {
  it('describe screenshots as the person sees the viewport: in its shading or `shading`, never path traced', () => {
    expect(row(mcp, '`screenshot`')).toMatch(
      /`shading` \(as for `view\.shading`; default: the viewport's\) *\| A PNG of the viewport as the person sees it/,
    );
    const doc = flat(mcp);
    expect(doc).toContain(
      '`screenshot` shows the viewport as the person sees it: its view (the scene camera when the viewport ' +
        'looks through it; during an animated view change the view it ends on), in the shading the viewport ' +
        'shows, or in `shading` when given, without overlays. ' +
        'It is rasterized (WebGL) like the viewport, never path traced:',
    );
    for (const text of [doc, flat(guide)])
      expect(text).not.toMatch(/whatever (the editor's |the viewport's )?shading|drawn that way whatever/);
    expect(flat(guide)).toContain("in the viewport's shading unless you pass `shading`");
    // the messages shown are the server's
    expect(doc).toContain(editorTimeoutMessage('screenshot', 10_000));
    expect(doc).toContain(editorTimeoutMessage('select', 10_000));
    expect(() => checkEditorCommand('screenshot', { shading: 'SOILD' })).toThrow(
      `screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?).`,
    );
    expect(doc).toContain(
      `"screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?)."`,
    );
  });

  it('describe get_view during an animated view change by the kinds of change, like the command list', () => {
    // the view changes the viewport animates are axis views, orbit steps and framing, from the view
    // commands, run_operator or the person (editor-commands.test.ts checks them against the editor)
    const getView = row(mcp, '`get_view`');
    expect(getView).toContain(
      'while the viewport animates a view change (an axis view, an orbit step or framing, asked for by a ' +
        'command, an operator or the person) the view it ends on',
    );
    expect(getView).not.toMatch(/view\.set_view|view\.frame_all|view\.frame_selected/);
    expect(EDITOR_COMMANDS.get_view.doc).toContain(
      'while the viewport animates a view change (an axis view, an orbit step or framing, asked for by a ' +
        'command, an operator or the person) the view it ends on',
    );
  });

  it('give the cost of screenshots: tens of seconds only for the first one in a shading, which the editor keeps', () => {
    for (const doc of [mcp, guide].map(flat)) {
      expect(doc).not.toMatch(/tens of seconds per `editor_command` screenshot in those shadings/);
      expect(doc).not.toMatch(/tens of seconds per screenshot of a heavy scene in `MATERIAL` or `RENDERED`/);
      expect(doc).not.toMatch(/where one drawn with materials and lights took 20 s/);
      // not every screenshot in another shading than the viewport's: only the first one in a shading
      expect(doc).not.toMatch(
        /in another shading (it )?builds and compiles the scene's materials for that image/,
      );
      expect(doc).not.toMatch(/took 20–25 s (each )?while the viewport showed `SOLID`/);
    }
    expect(flat(mcp)).toContain(
      "An editor builds and compiles the scene's materials for `MATERIAL` or `RENDERED` shading the first " +
        'time it draws that shading after it opened the project, for a screenshot or a frame of its viewport, ' +
        'and keeps them for later ones',
    );
    expect(flat(mcp)).toContain(
      `the first \`MATERIAL\` or \`RENDERED\` screenshot took ${M.A}, also when the other had been drawn ` +
        `before, and the next ones ${M.B}`,
    );
    expect(flat(mcp)).toContain(
      `a first \`RENDERED\` screenshot that timed out after 3 s, retried at once, answered ${M.V} later (the ` +
        'rest of the first one, then a screenshot that compiled nothing)',
    );
    expect(flat(guide)).toContain(
      'the first screenshot or viewport frame in each of them after it opened the project builds and compiles ' +
        `the scene's materials for that shading (${M.FIRST} for a scene with 71 materials), and the editor ` +
        `keeps them, so later screenshots in that shading compile nothing and take ${M.LATER}`,
    );
    expect(flat(guide)).toContain(
      'a screenshot that timed out still compiles what it needs and keeps it, so retrying it waits for the ' +
        'rest and compiles nothing again',
    );
  });

  it('say which material edits make the next screenshot in a shading compile a shader, and how long', () => {
    // a material edit builds that material again and keeps the one it replaces until the new one has
    // been drawn in every shading the old one was drawn in (scene-objects.ts replaceSlot), so it gets
    // the old one's shader when they need the same one (docs/mcp.md has the measurements)
    for (const doc of [mcp, guide].map(flat)) {
      expect(doc).not.toMatch(/did not make the next screenshot pay again/);
      // round 6's numbers, from before the editor reused the shaders of edited materials, and a
      // number that depended on when the request arrived
      expect(doc).not.toMatch(
        /10–15 s|sent right after the edit 6\.5 s|builds the materials of the objects that use it again/,
      );
      // round 7's first texts: a recompile in the second shading drawn after an edit of values, which
      // the editor no longer does, waits that depended on when a request arrived, and transmission as
      // an edit that needs a new shader (it reused the glass marble's)
      expect(doc).not.toMatch(
        /second of the two shadings|in the other of the two (paid|pays)|1\.2–11\.9|8\.0–9\.6|10\.5–11\.9|8–12 s/,
      );
      expect(doc).not.toMatch(/4–38 ms|8\.4 s|17\.5|9\.3 s|sent right after|right after the switch/);
      expect(doc).not.toMatch(/(sheen or|or) transmission turned on/);
    }
    expect(flat(mcp)).toContain(
      'A material edit builds that material again and keeps the one it replaces until the new one has been ' +
        "drawn in every shading the old one was drawn in, so the new one gets the old one's shader when they " +
        'need the same one: an edit of values (colours, roughness, the type and settings of a procedural ' +
        'texture) compiles nothing, and an edit that needs a shader no material had (coat or sheen turned on, ' +
        'procedural textures on a set of channels that no other material has) compiles it for the next ' +
        'screenshot or frame in each of these shadings',
    );
    expect(flat(mcp)).toContain(
      'After roughness edits of the table, the dowels, the floor, the glass marble and two plastics, the next ' +
        `screenshots in both shadings took ${M.J}, in either order and with the viewport in any shading, and ` +
        'no shader was compiled.',
    );
    expect(flat(mcp)).toContain(
      'the editor keeps what it built for both (a material edit that needs a shader no material had compiles ' +
        'it, see below)',
    );
    expect(flat(guide)).toContain(
      `so later screenshots in that shading compile nothing and take ${M.LATER}, also after the viewport ` +
        'switched to it or turned its anti-aliasing off (for slow frames or more than a million triangles), and ' +
        `after material edits that change values (colours, roughness, texture settings: ${M.J}). An edit that ` +
        'needs a shader no material had',
    );
    expect(row(guide, "`editor_command '…' failed: the editor did not answer")).toContain(
      'or after a material edit that needs a new shader',
    );
  });

  it('say that a screenshot is drawn with the anti-aliasing of the viewport, so it compiles no material shaders', () => {
    // engine.ts: a capture uses the viewport's sample count (captureSamples) or, when its draw context
    // was drawn only with the other one, that one; the viewport turns multisampling off for more than
    // a million drawn triangles and for slow settled frames, and on again for fast ones
    const engine = readFileSync(
      fileURLToPath(new URL('../../../web/src/viewport/engine.ts', import.meta.url)),
      'utf8',
    );
    expect(engine).toContain('export const VIEWPORT_MSAA_SAMPLES = 4;');
    expect(engine).toContain('export const MSAA_OFF_FRAME_MS = 1000;');
    expect(engine).toContain('export const MSAA_ON_FRAME_MS = MSAA_OFF_FRAME_MS / 8;');
    expect(engine).toContain('export const MSAA_HEAVY_TRIANGLES = 1_000_000;');
    // a screenshot (renderPixels with useViewport) takes its sample count from captureSamples; final
    // renders decide theirs apart (finalSampling), which the docs describe under render_image
    expect(engine).toContain('private captureSamples(): number {');
    const doc = flat(mcp);
    expect(doc).toContain(
      "A screenshot is drawn with the viewport's anti-aliasing: 4× multisampling, which the viewport turns off " +
        'for a scene of more than a million drawn triangles and after a frame whose scene and overlays took more ' +
        'than a second to draw (its full-screen passes, such as selection outlines, do not count, nor do frames ' +
        'that build shaders or their pipelines or that a screenshot held up), until drawing them takes less than ' +
        '125 ms; a shading (with X-ray on or off) drawn before only with ' +
        'the other sample count is drawn with that one. So a screenshot in a shading the editor has drawn ' +
        '(in `SOLID` with the same X-ray setting) compiles no material shaders,',
    );
    expect(doc).toContain(
      'With a grid of a million triangles added to the scene, the viewport drew without multisampling from the ' +
        `start: its first \`MATERIAL\` or \`RENDERED\` frame took ${M.E1}, and the next two screenshots in ` +
        `that shading ${M.HVM_SS}; after a 2600×1700 viewport had turned multisampling off, its first ` +
        `\`MATERIAL\` frame back at 1400×860 took ${M.E1M} and the next two screenshots ${M.MSX_SS}.`,
    );
    expect(flat(guide)).toContain('also after the viewport switched to it or turned its anti-aliasing off');
  });

  it('give later screenshots one range that covers each case of docs/mcp.md, in the guide and the doc comment', () => {
    /** The range ("0.4–3.3 s" or "1.2 s") that the first group of `re` matches in `text`. */
    const range = (text: string, re: RegExp): [number, number] => {
      const found = text.match(re)?.[1];
      expect(found, String(re)).toBeDefined();
      const [lo, hi = lo] = found!.split('–').map(Number);
      return [lo, hi];
    };
    const R = '([\\d.]+(?:–[\\d.]+)?) s';
    const doc = flat(mcp);
    // the screenshots in a shading the editor had drawn, case by case: the next ones with the viewport
    // in SOLID, in the viewport's shading, in the other one, after the viewport drew without
    // multisampling (a scene of a million triangles, a large viewport) and after a retry
    const cases = [
      `also when the other had been drawn before, and the next ones ${R}`,
      `screenshots in its shading then took ${R}`,
      `the first one in the other of the two [\\d.–]+ s and the next ones ${R}`,
      `and the next two screenshots in that shading ${R}`,
      `back at 1400×860 took [\\d.–]+ s and the next two screenshots ${R}`,
      `then a screenshot that compiled nothing\\), and the next one in ${R}`,
    ].map((re) => range(doc, new RegExp(re)));
    const source = readFileSync(
      fileURLToPath(new URL('../../src/mcp/editor-commands.ts', import.meta.url)),
      'utf8',
    );
    const fn = source.indexOf('export function editorTimeoutMessage(');
    const docComment = source.slice(source.lastIndexOf('/**', fn), fn).replace(/\s*\n\s*\* ?/g, ' ');
    const later = [
      range(flat(guide), new RegExp(`so later screenshots in that shading compile nothing and take ${R}`)),
      range(docComment, new RegExp(`so later screenshots in that shading compiled nothing and took ${R}`)),
    ];
    for (const [lo, hi] of later)
      for (const [a, b] of cases) {
        expect(lo).toBeLessThanOrEqual(a);
        expect(hi).toBeGreaterThanOrEqual(b);
      }
  });

  it('advise grey clay rendered on the server when a SOLID or WIREFRAME screenshot timed out', () => {
    // renderer 'software' alone renders with the scene's engine, so it path traces a PATHTRACER scene
    // on the server for up to its time_limit; render_image draws shading 'SOLID' rasterized. Server
    // renders run in render processes (round 9): they rendered grids of millions of triangles, and a
    // render that runs out of memory fails with renderToolError's message, after which only the
    // editor's screenshot shows the scene (round 8 named an out-of-memory error after 17.4–21.4 s)
    const tools = readFileSync(fileURLToPath(new URL('../../src/mcp/tools.ts', import.meta.url)), 'utf8');
    expect(tools).toContain('SOLID: grey clay shading (always rasterized)');
    expect(tools).toContain('software: always the server');
    for (const shading of ['SOLID', 'WIREFRAME'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        "render without the editor: render_image with shading 'SOLID' and renderer 'software' (grey clay, " +
          `rendered on the server: ${SERVER_SOLID_SECONDS}; a scene that needs more memory than a server ` +
          "render has fails with 'Rendering failed: the render process ran out of memory …', and then retry " +
          'the screenshot with a larger timeout_ms).',
      );
    expect(flat(mcp)).toContain(
      'and advises a retry with a larger `timeout_ms` or `render_image` with `shading: "SOLID"` and ' +
        '`renderer: "software"` (grey clay, rendered on the server without the editor: ' +
        `${SERVER_SOLID_SECONDS}; a scene that needs more memory than a server render has fails with ` +
        '"Rendering failed: the render process ran out of memory …", see [Engines and routing](#engines-and-routing), ' +
        'and then the screenshot with a larger `timeout_ms` is what is left).',
    );
    expect(flat(guide)).toContain(`(${M.D} at 1280×720 for that scene, ${SERVER_SOLID_SECONDS})`);
    for (const text of [flat(mcp), flat(guide), MCP_INSTRUCTIONS])
      expect(text).not.toMatch(
        /which can run out of memory for millions of triangles|ran out of memory after/,
      );
    expect(flat(mcp)).not.toContain(
      '`render_image` with `renderer: "software"`, which renders without the editor',
    );
  });

  it('give the cost of new shaders for materials with procedural textures, and one range for edits of values', () => {
    const doc = flat(mcp);
    expect(doc).toContain(
      `Turning sheen on took ${M.PW} in each of the two shadings for the table's material, whose colour, ` +
        `roughness and bump are \`BRICK\` and \`WAVE\` textures, ${M.PB} for the dowels' (\`WOOD\` on colour ` +
        `and bump) and ${M.PP} for the floor's (\`BRICK\` on its colour).`,
    );
    expect(flat(guide)).toContain(
      `(${M.NEWSH} in that scene, up to ${M.PROC_MAX} for a material with several procedural textures)`,
    );
    // the docs quote the ranges of the short texts (editor-costs.ts): the plastics', and the table's
    // maximum as "up to"
    expect(NEW_SHADER_SECONDS).toBe(
      `${M.NEWSH}, or up to ${M.PROC_MAX} for a material with several procedural textures`,
    );
    expect(M.PW.endsWith(`–${M.PROC_MAX}`)).toBe(true);
    expect(doc).toContain(`(${NEW_SHADER_SECONDS}), and that a retry then compiles nothing again`);
    expect(doc).toContain(
      `a screenshot without \`shading\` or with \`shading: "SOLID"\` took ${MILLIONS_SOLID_SECONDS}`,
    );
    expect(flat(guide)).toContain(`(${MILLIONS_SOLID_SECONDS} per \`SOLID\` screenshot with 4 million)`);
    // the screenshots after edits of material values: the same measured range in both docs
    const inMcp = doc.match(/two plastics, the next screenshots in both shadings took ([\d.–]+ s)/)?.[1];
    const inGuide = flat(guide).match(/\(colours, roughness, texture settings: ([\d.–]+ s)\)/)?.[1];
    expect(inMcp).toBe(M.J);
    expect(inGuide).toBe(inMcp);
  });

  it('say that requests wait for the work the editor is doing, not by when they arrived', () => {
    // a SOLID or WIREFRAME screenshot waits for the viewport's frame in progress; the other commands for
    // the editor's main thread: during a screenshot and while it builds the materials after the
    // viewport's first switch to MATERIAL or RENDERED (measured with get_view sent every 300 ms)
    const doc = flat(mcp);
    expect(doc).toContain(
      'A screenshot waits until the frame the viewport is drawing is done, also a `SOLID` or `WIREFRAME` one',
    );
    expect(doc).toContain(
      "The other commands draw nothing themselves, but wait while the editor's main thread is busy: for " +
        `${M.S} after the viewport switched to \`MATERIAL\` or \`RENDERED\` for the first time`,
    );
    expect(doc).toContain('for the whole of a screenshot it draws');
    expect(flat(guide)).toContain(
      "A `SOLID` or `WIREFRAME` screenshot waits until the viewport's frame in progress is done, also one that " +
        "compiles; the other commands wait while the editor's main thread is busy: during a screenshot",
    );
  });

  it("give the measured times of a browser editor's raster images, in docs/mcp.md and rendering.ts", () => {
    // an older verifier's numbers (12.9 s, 23–44 s) and "every raster image … about 20 s": only the
    // first image of a 71-material scene took that long (it compiles the materials), later ones less
    const rendering = readFileSync(
      fileURLToPath(new URL('../../src/mcp/rendering.ts', import.meta.url)),
      'utf8',
    ).replace(/\s*\n\s*\* ?/g, ' ');
    // the raster passage of docs/mcp.md (12.9 s can be a shader's compile time elsewhere in it)
    const doc = flat(mcp);
    const raster = doc.slice(doc.indexOf('a raster image can take longer'), doc.indexOf('A faster answer'));
    expect(doc).not.toMatch(/every (raster|RASTER) image of a heavy scene can take about 20 s|23–44 s/);
    for (const text of [raster, rendering]) {
      expect(text).not.toMatch(
        /every (raster|RASTER) image of a heavy scene can take about 20 s|23–44 s|12\.9 s/,
      );
      expect(text).toContain('the first image of a 71-material scene');
    }
    expect(flat(mcp)).toContain(
      'in a headless editor at the default 800×450 on a calm machine with 4 CPUs, the first image of a ' +
        `71-material scene took ${M.BR_FIRST} while it compiled the materials, and the next ones ${M.BR_LATER}; ` +
        `images of 4 million triangles took ${M.BRH}; on a busy machine up to ${BUSY_FACTOR} times as long)`,
    );
    expect(rendering).toContain(
      `the first image of a 71-material scene took ${M.BR_FIRST}, as it built and compiled the materials, and ` +
        `the next ones ${M.BR_LATER}; images of 4 million triangles took ${M.BRH}; on a busy machine up to ` +
        `${BUSY_FACTOR} times as long`,
    );
    // the error shown for renderer 'browser' is the server's (it used to say 'tens of seconds')
    const failure = browserRenderFailure(
      new RpcError("editor did not answer 'render' within 55000 ms", 'TIMEOUT'),
      {
        renderer: 'browser',
        pathTrace: false,
        timeoutMs: BROWSER_RASTER_TIMEOUT_MS,
        timeLimit: 30,
      },
    );
    expect(doc).toContain(`error: ${failure.reason}. ${failure.advice}`);
    expect(doc).not.toMatch(
      /A heavy scene takes tens of seconds in an editor|can take tens of seconds for a heavy scene/,
    );
    // the short texts quote the same ranges (editor-costs.ts)
    expect(BROWSER_RASTER_SECONDS).toBe(
      `${M.BR_FIRST} for the first image of a scene with 71 materials, as it compiled them, then ` +
        `${M.BR_LATER}, and ${M.BRH} for 4 million triangles`,
    );
  });

  it('show the timeout messages of the server below and at the maximum of timeout_ms', () => {
    const doc = flat(mcp);
    expect(doc).toContain(editorTimeoutMessage('screenshot', 10_000));
    expect(doc).toContain(editorTimeoutMessage('select', 10_000));
    // at the maximum: what the doc says the advice starts with
    const quoted = doc.match(/At the maximum the advice starts with "([^"]*) …"/)?.[1];
    expect(quoted).toBeDefined();
    for (const [command, params] of [
      ['screenshot', {}],
      ['screenshot', { shading: 'SOLID' }],
      ['select', {}],
    ] as const)
      expect(editorTimeoutMessage(command, MAX_EDITOR_TIMEOUT_MS, null, params)).toContain(` ${quoted} `);
  });

  it('say what ed.undo undoes there: also operators run with editor_command, never the tools', () => {
    const doc = flat(mcp);
    expect(doc).not.toContain("undoes the user's change, not the agent's");
    expect(doc).toContain(
      "(`ed.undo` undoes the last change there: the person's, or an operator the agent ran there with " +
        "`editor_command`, never the agent's changes made with the tools: use the `undo` tool for those)",
    );
  });

  it('show the message of an editor that left the project before it answered (wm.read_homefile)', () => {
    expect(flat(mcp)).toContain(
      `"${editorClosedMessage('run_operator', { operator: 'wm.read_homefile', params: {} })}"`,
    );
    expect(flat(guide)).toContain('`wm.read_homefile` switches their editor to a new project, so the editor');
  });

  it('give the waits of the code', () => {
    expect(MAX_EDITOR_TIMEOUT_MS).toBe(55_000);
    for (const doc of [mcp, guide].map(flat)) {
      expect(doc).not.toMatch(/at most 60000|100–60000|waits up to 60 s|within 60 s/);
      expect(doc).toContain(`at most ${MAX_EDITOR_TIMEOUT_MS}`);
    }
    expect(row(mcp, '`editor_command`')).toContain(`\`timeout_ms\` 100–${MAX_EDITOR_TIMEOUT_MS}`);
    expect(row(mcp, 'Browser renders')).toContain(
      `Raster: ${BROWSER_RASTER_TIMEOUT_MS / 1000} s with \`renderer: "browser"\`, ${AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000} s with \`auto\``,
    );
  });

  it('say that progress notifications last until the editor answers, not until time_limit', () => {
    expect(flat(mcp)).not.toMatch(/until `time_limit` has passed/);
    expect(flat(mcp)).toContain('until the image arrives');
  });
});

describe('docs: what a screenshot costs, and what it waits for', () => {
  it('say that a screenshot compiles no material shaders, while the first one links two programs of its own', () => {
    // the first screenshot after the editor opened the project links the output pass and the
    // picture's copy quad (measured: links+2 for the first screenshot of every run, links+0 after)
    const doc = flat(mcp);
    expect(doc).toContain(
      'So a screenshot in a shading the editor has drawn (in `SOLID` with the same X-ray setting) compiles no ' +
        'material shaders, unless a material edit needs a shader no material had; only the first screenshot ' +
        'after the editor opened the project links two programs of its own (the pass that draws the picture ' +
        'and its copy, which the editor keeps; a browser render before it links them too).',
    );
    expect(doc).not.toMatch(/\(in `SOLID` with the same X-ray setting\) compiles nothing/);
  });

  it('give what a screenshot costs as rpc.ts does: a frame of its own shading at its size and work of its own', () => {
    const rpc = readFileSync(
      fileURLToPath(new URL('../../../web/src/editor/rpc.ts', import.meta.url)),
      'utf8',
    ).replace(/\s*\n\s*\/\/ ?/g, ' ');
    expect(rpc).toContain("It costs a frame of its own shading, not of the viewport's, and work of its own");
    expect(rpc).toContain(
      '(in Rendered shading with shadows, the point and spot light shadow maps are drawn again)',
    );
    expect(rpc).toContain('draws into render targets of its size, reads the pixels back and encodes a PNG');
    expect(rpc).toContain('the viewport syncs back for its next frame');
    expect(flat(mcp)).toContain(
      "A screenshot costs a frame of its own shading, not of the viewport's, at its size, and work of its own: " +
        'it waits for the frames the GPU still draws for the viewport, prepares the scene for its shading (in ' +
        '`RENDERED` with shadows it draws the shadow maps of point and spot lights again), draws into render ' +
        'targets of its size, reads the pixels back and encodes a PNG; the viewport then prepares the scene for ' +
        'its own shading again and draws its next frame at its usual cost.',
    );
    // measured as VIEW's V3 did (frames and screenshots in the page, both viewport shadings, both sizes)
    expect(flat(mcp)).toContain(
      `With the viewport at 1067×631 (a page of 1400×860) and 4× multisampling, its frames took ${M.VF_SOLID} ` +
        `in \`SOLID\` and ${M.VF_REN} in \`RENDERED\`; in the editor, from its start of a screenshot to the PNG, ` +
        `a \`SOLID\` screenshot took ${M.SS_SOLID} at the viewport's size and ${M.SS_SOLID_1280} at 1280×720 ` +
        `with the viewport in either shading, and a \`RENDERED\` one ${M.SS_REN} and ${M.SS_REN_1280} with the ` +
        `viewport in \`RENDERED\`, ${M.SS_REN_OTHER} and ${M.SS_REN_OTHER_1280} with the viewport in \`SOLID\`; ` +
        `the MCP round trip added ${M.SS_RT}, and the viewport had drawn its next frame ${M.SS_NEXT_SOLID} ` +
        `(\`SOLID\`) or ${M.SS_NEXT_REN} (\`RENDERED\`) after the screenshot's answer.`,
    );
    for (const doc of [mcp, guide].map(flat))
      expect(doc).not.toMatch(/about one frame|one frame of the viewport|then one frame/);
  });

  it('say that a get_view sent during a select or a screenshot also waits for the frame drawn after it', () => {
    // with 4 million triangles a get_view sent 0.2 s after a select had answered still waited for the
    // viewport's next frame (round 8 measured 5.4 s); the docs said it waited until the select was done
    const doc = flat(mcp);
    expect(doc).toContain(
      'a `get_view` sent during a `select` or a screenshot waited until it was done and the viewport had drawn ' +
        'its next frame, up to',
    );
    expect(doc).toContain(
      `its next frame, up to ${M.U} (one sent ${M.U_AFTER_SENT} after a \`select\` had answered still waited ` +
        `${M.U_AFTER})`,
    );
    expect(doc).not.toMatch(/waited until it was done: up to/);
  });
});

describe('docs: measured times', () => {
  it('give ranges from calm runs, and how much longer the same steps took on a busy machine', () => {
    // round 8 gave ranges from calm and busy runs "at load averages from 0.4 to 6.7": on a busy machine
    // 46 of 137 values were outside them, 31 of them below a load of 6.7
    const doc = flat(mcp);
    // calm: no other work (the CPUs idle when a run started; the editor itself keeps them busy)
    expect(doc).toContain(
      'headless Chromium with SwiftShader on a machine with 4 CPUs and no other work (each run started once ' +
        'the CPUs had been at least 90 % idle for 5 s;',
    );
    expect(BUSY_LOADS).toBe(M.BUSY_LOAD);
    expect(doc).toContain(
      'On the same machine kept busy by other processes (1-minute load averages of ' +
        `${BUSY_LOADS} on its 4 CPUs), the same steps took up to ${BUSY_FACTOR} times as long as the upper end of the ranges below.`,
    );
    expect(doc).not.toMatch(/load averages from [\d.]+ to [\d.]+ on 4 CPUs; the times vary/);
    for (const text of [doc, flat(guide)]) expect(text).not.toMatch(/vary with the machine's load/);
    expect(flat(guide)).toContain(
      `These times were measured on a calm machine with 4 CPUs, the editor in software WebGL (SwiftShader); on a busy one`,
    );
    expect(flat(guide)).toContain(`they took up to ${BUSY_FACTOR} times as long.`);
  });
});

describe('docs: server renders', () => {
  it('say what a server render of millions of triangles costs, and what happens when it runs out of memory', () => {
    // round 8: "ran out of memory after 17.4–21.4 s with a grid of 2 million triangles"; render
    // processes (round 9) render it, and a render that runs out of memory gets renderToolError's message
    const doc = flat(mcp);
    for (const text of [doc, flat(guide)])
      expect(text).not.toMatch(
        /ran out of memory after [\d.–]+ s with a grid of 2 million|ran out of memory with a mesh of 2 million/,
      );
    expect(doc).toContain('The server renders in render processes of its own');
    expect(doc).toContain(
      `On a calm machine with 4 CPUs, grey clay (\`shading: "SOLID"\`) at 1280×720 took ${M.D} for the ` +
        `71-material example scene (20,042 triangles), ${M.RS_1M} with a grid of a million triangles added ` +
        `(${M.RS_COLD} as the first render after the server started, which starts a render process), and ` +
        `${M.SERVER_SOLID_DETAIL}; a render process then held ${M.RS_MEM}. With 4 million triangles, right after ` +
        `a screenshot had timed out and while the editor still drew it, the same render took ${M.RS_EDITOR}. On a ` +
        `busy machine renders took up to ${BUSY_FACTOR} times as long.`,
    );
    expect(doc).toContain(
      `With \`RENDER_WORKER_MEMORY_MB=256\`, a grid of 2 million triangles failed after ${M.RS_OOM_256}:`,
    );
    expect(doc).toContain(
      'A render that needs more memory ends only its render process: the call fails with a plain message (no ' +
        'JSON and no `code`), and the server keeps running and starts a new render process for the next render.',
    );
    const oom = renderToolError(
      new RenderOutOfMemoryError(
        'the render process ran out of memory (its JavaScript heap is limited to 256 MB); the server keeps running and starts a new render process for the next render',
        256,
      ),
    ).message;
    expect(doc).toContain(`"${oom}"`);
    expect(oom).toContain(OUT_OF_MEMORY_ADVICE);
    // a render that only waited in the process another render ran out of memory: no advice about its scene
    const shared = renderToolError(
      sharedProcessError(new RenderOutOfMemoryError('the render process ran out of memory', 256, 'heap')),
    ).message;
    expect(doc).toContain(`"${shared}"`);
    expect(shared).not.toContain(OUT_OF_MEMORY_ADVICE);
    // a plain message: the tool wrapper prints no code for render_image's errors
    expect(doc).toContain('the call fails with a plain message (no JSON and no `code`)');
    // the error table names the message
    expect(row(mcp, '`Rendering failed: the render process ran out of memory')).toContain(
      'needed more memory than its render process has',
    );
    expect(doc).not.toMatch(/The server's render threads|every render thread|on a render thread/);
  });

  it("say that a browser editor's RASTER image ignores `samples`, and how the editor anti-aliases it (engine.ts)", () => {
    // the row said only "`RASTER`: anti-aliasing supersampling 1, 2 or 4 (default 2)", which a browser
    // editor's final render (finalSampling) does not use
    const engine = readFileSync(
      fileURLToPath(new URL('../../../web/src/viewport/engine.ts', import.meta.url)),
      'utf8',
    );
    const samples = /export const FINAL_RENDER_SAMPLES = (\d+);/.exec(engine)?.[1];
    const budgetMs = Number(/export const FINAL_SUPERSAMPLE_MS = (\d+);/.exec(engine)?.[1]);
    expect(samples).toBeDefined();
    expect(budgetMs).toBeGreaterThan(0);
    const browser =
      `(WebGL: ${samples} samples, or the GPU's maximum: 4 in software WebGL; where the viewport drew that shading ` +
      'only without multisampling, or has not drawn it while its multisampling is off: 5 pictures averaged when ' +
      `the first took at most ${budgetMs / 1000} s, else SMAA)`;
    expect(row(mcp, '`samples`')).toContain(`a browser editor ignores it ${browser}`);
    expect(flat(samplesArg.description ?? '')).toContain(
      `a browser editor's RASTER image ignores it ${browser}`,
    );
  });

  it('say where the quick look renders, and the screenshot again where the server cannot hold the scene', () => {
    const guideText = flat(guide);
    expect(guideText).toContain(
      'for a quick look use `render_image {shading: "SOLID"}`: grey clay, which renders on the server while the ' +
        "editor is busy (right after a timeout) and when the scene's render engine is `PATHTRACER`",
    );
    expect(guideText).toContain(
      'a scene that needs more memory than a server render has fails with "Rendering failed: the render ' +
        'process ran out of memory …", and then only a screenshot with a larger `timeout_ms` shows it.',
    );
    expect(MCP_INSTRUCTIONS).toContain(
      "a quick look with render_image {shading: 'SOLID'} (grey clay, rendered on the server while the editor is " +
        "busy and when the scene's render engine is PATHTRACER: ",
    );
    expect(MCP_INSTRUCTIONS).toContain(
      "a scene that needs more memory than a server render has fails with 'Rendering failed: the render process " +
        "ran out of memory …', and then only the editor shows it: retry the screenshot with a larger timeout_ms)",
    );
  });
});

describe('docs: projects in storage that others share', () => {
  it('say when another writer deleted a project this server has open, and when listing storage failed', () => {
    const doc = flat(mcp);
    expect(doc).toContain(DELETED_ELSEWHERE_NOTE.slice(0, DELETED_ELSEWHERE_NOTE.indexOf(' This server')));
    expect(doc).toContain(`"${LIST_FAILED_NOTE}"`);
    expect(doc).toContain(
      'Editors and agents that have it open on another server sharing the storage stay connected there, and ' +
        'their next change stores the project again',
    );
    expect(row(mcp, '`get_project`')).toContain('`deleted_from_storage`');
    expect(row(mcp, '`list_projects`')).toContain('`storage_listing_failed`');
    expect(flat(guide)).toContain('`deleted_from_storage: true`');
  });
});

describe('docs: code spans', () => {
  // A code span broken across two lines is two pieces in the raw text that agents read, and in a
  // list item prettier left its second line at column 0 ("`renderer:" / "\"auto\"`").
  const broken = (doc: string) => {
    let fenced = false;
    return doc.split('\n').filter((line) => {
      if (line.trimStart().startsWith('```')) fenced = !fenced;
      else if (!fenced) return (line.match(/`/g) ?? []).length % 2 === 1;
      return false;
    });
  };

  it('stay on one line in the agent guide, whose list items prettier re-indents', () => {
    expect(broken(guide)).toEqual([]);
    expect(flat(guide)).toContain('With the default `renderer: "auto"`, `render_image` waits 15 s');
  });

  it('stay on one line in docs/mcp.md', () => {
    expect(broken(mcp)).toEqual([]);
    expect(mcp).toContain('`{ok, operator, result, reports, mesh, selection_after}`');
    expect(mcp).toContain(
      "`{project, command: 'run_operator', params: {operator: 'view3d.view_all', params: {}}}`",
    );
  });
});

describe('docs: wrapping', () => {
  // The docs are wrapped by hand at 100 columns. A prose line cut far short although the next word
  // fits on it is what a reflow leaves behind (docs/mcp.md had "what it does there. They act on that
  // editor" followed by the rest of the sentence): agents read the raw text.
  const shortLines = (doc: string) => {
    const lines = doc.split('\n');
    const short: string[] = [];
    let fenced = false;
    for (let i = 0; i + 1 < lines.length; i++) {
      const [line, next] = [lines[i], lines[i + 1]];
      if (line.trimStart().startsWith('```')) fenced = !fenced;
      if (fenced || !line.trim() || !next.trim()) continue;
      // tables, headings, fences and comments; the next line starts a list item or a table
      if (/^\s*(\||#|```|<!--)/.test(line) || /^\s*([-*|#]\s|```|\d+\.\s|<!--)/.test(next)) continue;
      const word = next.trim().match(/^(`[^`]*`\S*|\S+)/)![0];
      if (line.length < 60 && line.length + 1 + word.length <= 100) short.push(line);
    }
    return short;
  };

  it('cuts no prose line short before a word that fits on it', () => {
    expect(shortLines(mcp)).toEqual([]);
    expect(shortLines(guide)).toEqual([]);
  });
});

describe('docs: selections', () => {
  it('say which lists each select mode uses, and that the others and all: true with lists are refused', () => {
    expect(row(mcp, '`mesh`')).toContain(
      '`select_mode` (`VERT`: the listed vertices with those of the listed edges and faces; `EDGE`: only ' +
        '`edges`; `FACE`: only `faces`; when omitted `FACE` for faces alone, `EDGE` for edges alone, else `VERT`)',
    );
    expect(row(mcp, 'A list that `select_mode` does not select from')).toContain('`POLL_FAILED`');
    expect(row(mcp, '`all: true` with `verts`, `edges` or `faces`')).toContain('`POLL_FAILED`');
    // both at once: one message whose remedies all leave all: true out (mcp-error-codes.test.ts
    // checks the quoted remedies against the server's message)
    expect(row(mcp, 'Both: `all: true` with lists that `select_mode` does not select from')).toContain(
      "`POLL_FAILED` | `select_mode 'EDGE' selects only the listed edges, so the listed faces would be ignored, and all: true …`",
    );
    expect(flat(mcp)).toContain(
      'Every remedy that a refused element selection names is accepted as it is: one message names both ' +
        'problems when they come together, and each of its remedies for the lists also leaves `all` out',
    );
    expect(flat(guide)).toContain(
      'The refusal names both problems when they come together, and every remedy it names works as it is.',
    );
    expect(row(guide, "`select_mode 'FACE' selects only the listed faces")).toContain(
      'with `all: true` also leave `all` out',
    );
    expect(flat(mcp)).not.toMatch(/before applying the lists/);
    expect(flat(guide)).toContain(
      'Lists that the select mode would not use are refused (`POLL_FAILED`), and so is `all: true` with lists',
    );
    // leaving select_mode out is VERT only for some lists: faces alone are FACE, edges alone EDGE
    const refusal = row(guide, "`select_mode 'FACE' selects only the listed faces");
    expect(refusal).not.toMatch(/leave `select_mode` out for `VERT`/);
    expect(refusal).toContain(
      'left out, `select_mode` is `FACE` for faces alone, `EDGE` for edges alone, else `VERT`',
    );
  });
});

describe('docs: browser UI operators', () => {
  it('say what every one does in a live editor, and show the messages of the server', () => {
    const doc = flat(mcp);
    for (const id of ['view3d.view_all', 'object.duplicate_move'])
      expect(doc).toContain(browserUiOperator(id)!);
    const table = mcp.slice(mcp.indexOf('| Browser UI operator'), mcp.indexOf('Two of the messages'));
    for (const id of BROWSER_UI_OPERATORS) expect(table, id).toContain(`\`${id}\``);
    // the File operators do not all just open dialogs
    expect(mcp).not.toContain("Opens the editor's dialogs and menus");
    expect(row(mcp, '`wm.read_homefile`')).toContain(
      "Creates a new project (`{name, empty}`) and switches the person's editor to it, away from the project " +
        'it had open, which it leaves before it can answer: `editor_command` says it got no answer',
    );
    expect(row(mcp, '`wm.share`')).toContain("Puts the project's link on the person's clipboard");
    // render.render renders a still at once; its animation window waits for the person's Render button
    expect(row(mcp, '`render.render`')).toContain(
      '`{animation: true}` opens the Render Animation window instead, which renders nothing until the person ' +
        'presses its Render button',
    );
    for (const doc of [mcp, guide].map(flat))
      expect(doc).not.toMatch(/animation: true\W+renders the frame range/);
    expect(flat(guide)).not.toMatch(/wm\.share[^.]*(dialog|menu)/);
  });

  it('give the did-you-mean note of the server for wm.save', () => {
    const registry = createOperatorRegistry();
    const candidates = [
      ...registry
        .list()
        .filter((d) => !d.uiOnly)
        .map((d) => d.id),
      ...BROWSER_UI_OPERATORS.filter((b) => !registry.has(b)),
    ];
    const ids = closestOperatorIds('wm.save', candidates);
    const message = `Did you mean: ${ids.join(', ')}? ${browserUiOperatorsNote(ids, ids, 'wm.save')}`;
    const quoted = flat(mcp).match(/`wm\.save` gets "(Did you mean: [^"]*) …"/)?.[1];
    expect(quoted).toBeDefined();
    expect(message.startsWith(quoted!)).toBe(true);
  });
});
