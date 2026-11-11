import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_UI_OPERATORS,
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  modifierObjectRefusal,
  modifierObjectTypes,
  registerBuiltinModifiers,
  type OperatorContext,
} from '@3d-editor/core';
import {
  EDITOR_COMMANDS,
  MAX_EDITOR_TIMEOUT_MS,
  checkEditorCommand,
  editorClosedMessage,
  editorTimeoutMessage,
} from '../../src/mcp/editor-commands';
import {
  BROWSER_BUSY_FACTOR,
  BROWSER_RASTER_SECONDS,
  BUSY_FACTOR,
  BUSY_LOADS,
  FAST_SECONDS,
  FIRST_SHADING_SECONDS,
  LATER_SECONDS,
  MARGIN_PERCENT,
  MILLIONS_MARGIN_PERCENT,
  MILLIONS_SELECT_SECONDS,
  MILLIONS_SOLID_SECONDS,
  NEW_SHADER_SECONDS,
  SERVER_SOLID_SCENE_SECONDS,
  SERVER_SOLID_SECONDS,
  measured,
  measuredBrowserImages,
  measuredNote,
  measuredOnServer,
} from '../../src/mcp/editor-costs';
import { MCP_INSTRUCTIONS } from '../../src/mcp/instructions';
import {
  DELETED_ELSEWHERE_NOTE,
  LIST_FAILED_NOTE,
  LIST_PARTIAL_NOTE,
  PROJECT_READ_MAX_AGE_MS,
  PROJECT_READ_WAIT_MS,
} from '../../src/mcp/project-storage';
import {
  ANIMATION_OUT_OF_MEMORY_ADVICE,
  AUTO_BROWSER_RASTER_TIMEOUT_MS,
  BROWSER_RASTER_TIMEOUT_MS,
  EXPORT_OUT_OF_MEMORY_ADVICE,
  OUT_OF_MEMORY_ADVICE,
  SCALE_UP_MIN_MS,
  SINGLE_THREAD_ANIMATION_ADVICE,
  SINGLE_THREAD_EXPORT_ADVICE,
  SINGLE_THREAD_RENDER_ADVICE,
  SLOW_EDITOR_RETRY_MS,
  browserRenderFailure,
  renderToolError,
  samplesArg,
} from '../../src/mcp/rendering';
import { RpcError } from '../../src/sync/room';
import { renderProcessExitError, sharedProcessError } from '../../src/render/pool';
import {
  checkMainThreadRender,
  refusedEvaluationMessage,
  operatorCheck,
  refusedOperatorMessage,
  storedMeshesMessage,
} from '../../src/render/memory';
import { outOfMemoryReply } from '../../src/api/projects';
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
 * long the server waits for an editor and how long the steps took (the ranges of editor-costs.ts),
 * what a render that runs out of memory answers, and until when the server sends progress.
 */

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const read = (doc: string) => file(`../../../../docs/${doc}`);
const mcp = read('mcp.md');
const guide = read('agent-guide.md');
/** A source file of the server (apps/server/src/…). */
const source = (rel: string) => file(`../../src/${rel}`);
/** A source file of the browser editor (apps/web/src/…). */
const web = (rel: string) => file(`../../../web/src/${rel}`);
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');
/**
 * A source file's text as an agent reads its strings and comments: concatenated string literals
 * joined ('a ' +\n 'b' → 'a b'), escaped quotes unescaped, and comment lines joined.
 */
const joined = (s: string) =>
  s
    .replace(/(['"`])\s*\+\s*\n\s*(['"`])/g, '')
    .replace(/\\(['"`])/g, '$1')
    .replace(/\s*\n\s*(\*|\/\/)? ?/g, ' ');

/** The Markdown table row whose first cell starts with `first`. */
function row(doc: string, first: string): string {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${first}`));
  expect(line, first).toBeDefined();
  return line!;
}
/** The cell `col` (1 = the first) of a table row (the measured tables have no `|` in their cells). */
const cell = (line: string, col: number) => line.split('|')[col].trim();

/** The registry's description of an operator. */
const describeOperator = (() => {
  const all = createOperatorRegistry().describe({ includeUiOnly: true });
  return (id: string) => {
    const op = all.find((d) => d.id === id);
    expect(op, id).toBeDefined();
    return op!.description;
  };
})();

/**
 * Numbers that only the docs give (docs/mcp.md, Live editors and Engines and routing), measured and
 * made as editor-costs.ts says: the first frame with a million triangles added, the commands that
 * waited after the first switch to MATERIAL or RENDERED, the first WIREFRAME screenshot of 4 million
 * triangles, get_view with 4 million triangles (sent during a select or a screenshot, and after it:
 * this round's runs), a server render with a 256 MB heap, the editor's own CPU use, the number of
 * agents and of calm runs pooled (all, and of the scene with 4 million triangles), the longest select
 * and SOLID screenshot with 4 million triangles, and the sentences that say how far above that their
 * ranges run and why (LOO, which also says that a range of all but one agent's runs held the runs of
 * the one left out).
 */
// measured ranges: begin
const M = {
  AGENTS: 9,
  BROWSER_BUSY_RAW: '4.30',
  BUSY_LOO_HELD: true,
  BUSY_RAW: '2.52',
  CALM_RUNS: 225,
  CPU_MAX: '3.9',
  CPU_MEDIAN: '1.4',
  FIRST_NO_MSAA: '7.9–21 s',
  GET_VIEW_AFTER: '0.4 s',
  GET_VIEW_AFTER_MAX: '0.28',
  GET_VIEW_AGENTS: 'ten',
  GET_VIEW_DURING: '0.4 s',
  GET_VIEW_DURING_MAX: '0.30',
  GET_VIEW_RUNS: 37,
  LOO: "Those of a `select` and a `SOLID` screenshot with 4 million triangles, which include requests sent as soon as the one before had answered, run to 50 % more than their longest time: with 25 %, earlier ranges made from fewer runs missed such runs of later agents (up to 0.735 s against 0.1–0.7 s, and 3.478 s against 0.5–3.4 s). A range made that way from all but one agent's runs held all the runs of the agent left out.",
  MILLIONS_SELECT_MAX: '0.735',
  MILLIONS_SOLID_MAX: '3.478',
  MILLIONS_WIRE_FIRST: '6.0–14 s',
  OOM_256: '0.9–3.4 s',
  RUNS_4M: 52,
  SWITCH: '2.9–7.0 s',
};
// measured ranges: end

/**
 * How long the server held up every request with 4 million triangles (a stored document of 134 MB), in
 * calm runs of round 11's five TEXTS agents on 2026-11-11, with /healthz probes: the longest wait of a
 * request in each hold. The fix rounds probed open loop every 10 ms (a hold is the union of the slow
 * requests' overlapping waits): the first from the process that drove the browser and, in its last two
 * runs, also from a process of its own (the longer wait of the two; a slow request alone in a hold of
 * its own, or a hold with far fewer requests than 10 ms apart, was a stall of the first process, not of
 * the server, and is left out), the second fix round and the second verifier from a process of their
 * own only (a process that watched the CPUs every 2 s left out the holds next to other processes'
 * work); the others probed closed loop (waits back to back are separate holds there). A hold at the
 * minute's read is the read's (also while an editor loaded the project); one while an editor opened
 * the project at another time is the open's.
 */
const HOLDS = {
  // the minute's read (RoomManager.refreshActive) of a project with editors open: round 11's agent
  // (an idle editor), its first verifier (idle editors; one drawing SOLID screenshots back to back;
  // one more editor opened 3 s before the read), the first fix round (idle editors, an editor drawing
  // screenshots back to back, one more editor opened 3 to 0 s before the read, the only editor opened
  // 3 to 0 s before it, an idle editor), the second verifier (idle editors, editors stepping through
  // selects and screenshots, one drawing screenshots back to back, one more editor or the only one
  // opened 3 to 0 s before the read) and the second fix round (idle and stepping editors)
  REFRESH_MS: [
    570, 540, 532, 686, 512, 437, 652, 802, 502, 652, 592, 796, 743, 1140, 794, 1470, 761, 730, 520, 556, 577,
    616, 548, 533, 782, 1029, 934, 877, 823, 874, 1159, 923, 743, 837, 1104, 771, 997, 1304, 945, 1122, 852,
    600, 589, 579, 952, 565, 637, 506, 541, 595, 503, 524, 543, 536,
    // the second verifier (its first run had no CPU watcher yet; vmstat showed the CPUs idle)
    567, 558, 689, 687, 534, 523, 922, 831, 1249, 526, 894, 831, 575, 590, 599, 548, 531, 470, 565, 538,
    // the second fix round
    704, 528, 496, 522, 558, 448, 612, 506, 576, 552,
  ],
  // an editor opening the project without a copy of it: the first editor of a project nobody had open
  // (the read before it opens, RoomManager.readUnused, then the document sent to it), and one more
  // editor (the document)
  OPEN_MS: [
    684, 553, 568, 610, 480, 348, 352, 325, 944, 917, 1071, 867, 353, 422, 380, 394, 539, 438, 364, 406, 459,
    590, 414, 565, 625, 915, 990, 819, 779, 834, 712, 734, 579, 797, 785, 963,
    // the second verifier (1306: its first editor, before the CPU watcher; vmstat showed the CPUs idle)
    1306, 777, 514, 349, 865, 822, 373, 408, 383, 424, 350, 926, 575, 936, 691,
    // the second fix round
    889, 543, 410, 962, 851,
  ],
  // a get_view sent with no command running, the editor idle, that a hold overlapped: how long after
  // the hold's end it answered, the longest of each of the agents that probed it with a process of
  // their own (the first fix round, the second verifier, the second fix round)
  GET_VIEW_AFTER_HOLD_MS: [12, 7, 14],
  // the longest such get_view, and the hold it waited for (the second verifier: a refresh)
  GET_VIEW_HELD: { waitMs: 677, holdMs: 687 },
  // a get_view that no hold overlapped, the editor idle, open loop every 100 ms: the longest of the
  // second verifier and of the second fix round
  GET_VIEW_IDLE_MS: [18, 38],
};

/** The parts of NEW_SHADER_SECONDS: the range of the plastics and the longest time (the table's). */
const [NEW_SHADER, PROCEDURAL_MAX] = /^(.+), or up to (.+) for a material with several procedural textures$/
  .exec(NEW_SHADER_SECONDS)!
  .slice(1);
/** The parts of BROWSER_RASTER_SECONDS: the first image, the next ones, 4 million triangles. */
const [BR_FIRST, BR_LATER, BR_MILLIONS] =
  /^(.+) for the first image of a scene with 71 materials, as it compiled them, then (.+), and (.+) for 4 million triangles$/
    .exec(BROWSER_RASTER_SECONDS)!
    .slice(1);

/** Every text an agent reads: the docs, the server's instructions and the sources of the tools' texts. */
const agentTexts = () => [
  flat(mcp),
  flat(guide),
  MCP_INSTRUCTIONS,
  joined(source('mcp/tools.ts')),
  joined(source('mcp/editor-commands.ts')),
  joined(source('mcp/rendering.ts')),
  joined(source('mcp/operator-groups.ts')),
];

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
      guide.indexOf('\n- `OUT_OF_MEMORY`:', guide.indexOf('- `FAILED`:')),
    );
    for (const id of failed) expect(bullet).toContain(id);
    expect(bullet).toMatch(/`render\.render` is a browser UI operator: `NOT_FOUND`/);
    expect(bullet).not.toMatch(/or `render\.\*`/);
  });

  it('OUT_OF_MEMORY: an operator the server does not run, and renders and exports that ran out of memory', () => {
    expect(row(mcp, '`OUT_OF_MEMORY`')).toContain(
      "The server's process would run out of memory: the operator was not run, or a mesh it reads was not loaded",
    );
    expect(flat(guide)).toContain(
      "- `OUT_OF_MEMORY`: the server's process would run out of memory: the operator was not run, or a mesh it " +
        'reads was not loaded (`get_scene` lists such a mesh with `not_loaded`).',
    );
    expect(flat(guide)).toContain('Renders and exports that ran out of memory carry this code too.');
    // the operator refusal the error tables quote, with the server's wording (render/memory.ts)
    const refusal = refusedOperatorMessage(
      { estimate: { bytes: 1, faces: 1, lower: 'X', addedStoredBytes: 0 }, storedBytes: 0 } as never,
      1,
      1,
    ).replace(/\d+/g, '…');
    const quoted =
      "`mesh.subdivide failed: not run on the server: it would need about … MB of JavaScript heap for a mesh of about … faces, and the server's process has … MB of its … MB heap free …`";
    expect(`mesh.subdivide failed: ${refusal}`).toContain(quoted.slice(1, -' …`'.length));
    expect(row(mcp, quoted)).toContain('`OUT_OF_MEMORY`');
    // a project that already needs more than the server keeps for one: every operator that adds
    // geometry or objects is refused (render/memory.ts operatorCheck), so lowering its own parameters
    // cannot help, and one that adds nothing runs (asked of the check itself, with room in the heap)
    const MB = 1024 * 1024;
    const check = operatorCheck({
      heapFree: () => 4096 * MB,
      collect: () => undefined,
      heapLimit: () => 2096 * MB,
    });
    const full = { storedBytes: 700 * MB, saveBytes: 200 * MB, objects: 15_000 };
    const adds = { bytes: 1, faces: 6, objects: 1, addedStoredBytes: 11_000, addedSaveBytes: 33_000 };
    expect(check({ operator: 'mesh.primitive_cube_add', estimate: adds, ...full } as never)).toMatch(
      /^not run on the server: the project's meshes and objects already take about 700 MB .*, and this operator would add to them\. /,
    );
    expect(
      check({
        operator: 'object.shade_smooth',
        estimate: { bytes: 1, faces: 6, addedStoredBytes: 0 },
        ...full,
      } as never),
    ).toBeNull();
    expect(row(mcp, quoted)).toContain(
      'When the project already needs more than that (grown in a browser editor or on a server with a ' +
        'larger heap; meshes the server did not load count too), every operator that adds geometry or ' +
        'objects is refused until some are deleted (`delete_objects`): ',
    );
    // what it needs: its meshes, objects and datablocks (MEM round 11: objects count too) and a save
    // of it (MEM fix round 2: the server's saves of projects at the ceiling ran it out of memory),
    // quoted as storedMeshesMessage says it
    const would = storedMeshesMessage(
      {
        operator: 'object.array_place',
        estimate: { bytes: 1, faces: 6, objects: 8000, addedStoredBytes: 400 * MB, addedSaveBytes: 300 * MB },
        storedBytes: 100 * MB,
        saveBytes: 30 * MB,
        objects: 2000,
      } as never,
      2096 * MB,
    );
    const dottedWould = would
      .replace(/\(\d+ times what its objects, datablocks and keyframes take\)/, '(…)')
      .replace(/\(half of its [^)]*\)/, '(…)')
      .replace(/[\d,]+ (MB|new objects|objects)/g, '… $1');
    const kept = ' keeps for one project';
    expect(row(mcp, quoted)).toContain(
      `\`… ${dottedWould.slice('not run on the server: '.length, dottedWould.indexOf(kept) + kept.length)} …\``,
    );
    expect(row(mcp, quoted)).toContain(
      "`… the project's meshes and objects would then take about … MB of JavaScript heap with … new objects " +
        '(now … MB with … objects), and a save of it about … MB more for a moment (…): … MB in all, more than the ' +
        "… MB the server's process keeps for one project …`",
    );
    expect(row(mcp, quoted)).toContain(
      'for a save of it, which takes three times what its objects, datablocks and keyframes take for a moment',
    );
    expect(would).toContain('(3 times what its objects, datablocks and keyframes take)');
    // the import's (import_model): the same message after 'Import failed: ', with what to lower
    const imported = storedMeshesMessage(
      {
        operator: 'import_scene.gltf',
        estimate: {
          bytes: 1,
          faces: 6,
          objects: 8000,
          addedStoredBytes: 400 * MB,
          addedSaveBytes: 300 * MB,
          lower: 'the nodes (objects) of the file',
        },
        storedBytes: 100 * MB,
        saveBytes: 30 * MB,
        objects: 2000,
      } as never,
      2096 * MB,
    );
    expect(flat(mcp)).toContain(
      `"Import failed: ${imported.replace(/[\d,]+ (MB|new objects|objects)/g, '… $1')}" (or what else the file has too much of)`,
    );
    expect(
      row(
        guide,
        '`mesh.subdivide failed: not run on the server: it would need about … MB of JavaScript heap …`',
      ),
    ).toContain('(`OUT_OF_MEMORY`)');
    // run_operator, batch and edit_mesh name the code
    const tools = joined(source('mcp/tools.ts'));
    expect(tools).toContain('OUT_OF_MEMORY (the server');
    // the tools whose other errors carry the code as JSON: every ToolError with code OUT_OF_MEMORY
    // (renders, exports, import_model's memory check) and a mesh the server could not decode
    expect(tools).toContain("throw new ToolError(`Import failed: ${refused}`, 'OUT_OF_MEMORY');");
    expect(tools).toContain(
      "return withProjectNotes( failure(err.message, err.code === 'OUT_OF_MEMORY' ? { code: err.code } : undefined),",
    );
    expect(tools).toContain(
      'if (isMeshMemoryError(err)) return withProjectNotes(failure(`${name} failed: ${err.message}`, { code: err.code }), notes);',
    );
    expect(flat(mcp)).toContain(
      'The out-of-memory errors of `render_image`, `render_animation`, `export_scene`, `import_model` and ' +
        "`apply_modifier`, and the error of a tool that reads a stored mesh the server's process has no memory to decode " +
        '(`get_mesh_data` …), carry `{"code": "OUT_OF_MEMORY"}` as JSON after the message',
    );
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
    expect(
      cell(
        row(mcp, 'The first `MATERIAL` or `RENDERED` screenshot or viewport frame after the editor opened'),
        2,
      ),
    ).toBe(FIRST_SHADING_SECONDS);
    expect(flat(mcp)).toContain(
      'a first `RENDERED` screenshot that timed out after 3 s, retried at once, answered once the editor had ' +
        'finished the first one and drawn a screenshot that compiled nothing, and later retries compile nothing ' +
        'either.',
    );
    expect(flat(guide)).toContain(
      'the first screenshot or viewport frame in each of them after it opened the project builds and compiles ' +
        `the scene's materials for that shading (${FIRST_SHADING_SECONDS} for a scene with 71 materials), and ` +
        `the editor keeps them, so later screenshots in that shading compile nothing and take ${LATER_SECONDS}`,
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
    // edits of values: in the range of later screenshots, which covers them
    const later = row(mcp, 'Later `MATERIAL` and `RENDERED` screenshots');
    expect(cell(later, 1)).toContain('and after edits of material values');
    expect(cell(later, 2)).toBe(LATER_SECONDS);
    expect(flat(guide)).toContain(
      'and after material edits that change values (colours, roughness, texture settings). An edit that ' +
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
    const engine = web('viewport/engine.ts');
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
    // the measured scenes: a 720×720 grid (518,400 quads, about a million triangles) and a viewport
    // whose multisampling slow RENDERED frames at 2600×1700 had turned off (not a million quads)
    const noMsaa = row(mcp, 'The same with the viewport drawing without multisampling');
    expect(cell(noMsaa, 1)).toContain(
      'with a grid of about a million triangles added (720×720 quads; more than a million triangles turn ' +
        'multisampling off from the first frame), or the first `MATERIAL` frame after slow `RENDERED` frames ' +
        'at 2600×1700 pixels had turned it off',
    );
    expect(mcp).not.toContain('a grid of a million quads');
    expect(cell(noMsaa, 2)).toBe(M.FIRST_NO_MSAA);
    expect(cell(row(mcp, 'Later `MATERIAL` and `RENDERED` screenshots'), 1)).toContain(
      'turned its multisampling off or toggled X-ray',
    );
    expect(flat(guide)).toContain('also after the viewport switched to it, turned its anti-aliasing off');
  });

  it('give later screenshots one range, the same in the docs, the guide and editor-costs.ts', () => {
    // LATER_SECONDS pools every case: a shading the editor had drawn, the viewport in any shading,
    // after it turned multisampling off, after X-ray toggles and edits of material values
    const costs = joined(source('mcp/editor-costs.ts'));
    expect(costs).toContain(
      'Later MATERIAL or RENDERED screenshots, in a shading the editor had drawn: with the viewport in any ' +
        'shading, after it turned its multisampling off (a million triangles more, a large viewport), after ' +
        'X-ray toggles and after edits of material values; they compile nothing.',
    );
    expect(cell(row(mcp, 'Later `MATERIAL` and `RENDERED` screenshots'), 2)).toBe(LATER_SECONDS);
    expect(flat(guide)).toContain(
      `so later screenshots in that shading compile nothing and take ${LATER_SECONDS}`,
    );
    const commands = source('mcp/editor-commands.ts');
    const fn = commands.indexOf('export function editorTimeoutMessage(');
    const docComment = joined(commands.slice(commands.lastIndexOf('/**', fn), fn));
    expect(docComment).toContain('so later screenshots in that shading compiled nothing (LATER_SECONDS)');
    // round 9's per-case numbers are gone
    for (const text of agentTexts())
      expect(text).not.toMatch(
        /screenshots in its shading then took|and the next two screenshots in that shading/,
      );
  });

  it('advise grey clay rendered on the server when a SOLID or WIREFRAME screenshot timed out', () => {
    // renderer 'software' alone renders with the scene's engine, so it path traces a PATHTRACER scene
    // on the server for up to its time_limit; render_image draws shading 'SOLID' rasterized. A server
    // render that runs out of memory fails with renderToolError's message and code OUT_OF_MEMORY,
    // after which only the editor's screenshot shows the scene
    const tools = source('mcp/tools.ts');
    expect(tools).toContain('SOLID: grey clay shading (always rasterized)');
    expect(tools).toContain('software: always the server');
    for (const shading of ['SOLID', 'WIREFRAME'])
      expect(editorTimeoutMessage('screenshot', 10_000, null, { shading })).toContain(
        "render without the editor: render_image with shading 'SOLID' and renderer 'software' (grey clay, " +
          `rendered on the server: ${SERVER_SOLID_SECONDS}; a scene that needs more memory than a server ` +
          "render has fails with 'Rendering failed: out of memory: …' (code OUT_OF_MEMORY), and then retry the " +
          'screenshot with a larger timeout_ms).',
      );
    expect(flat(mcp)).toContain(
      'and advises a retry with a larger `timeout_ms` or `render_image` with `shading: "SOLID"` and ' +
        '`renderer: "software"` (grey clay, rendered on the server without the editor: ' +
        `${SERVER_SOLID_SECONDS}; a scene that needs more memory than a server render has fails with ` +
        '"Rendering failed: out of memory: …" and code `OUT_OF_MEMORY`, see [Engines and ' +
        'routing](#engines-and-routing), and then the screenshot with a larger `timeout_ms` is what is left).',
    );
    expect(flat(guide)).toContain(
      `(${SERVER_SOLID_SCENE_SECONDS} at 1280×720 for that scene, ${SERVER_SOLID_SECONDS})`,
    );
    for (const text of agentTexts())
      expect(text).not.toMatch(
        /which can run out of memory for millions of triangles|ran out of memory after/,
      );
    expect(flat(mcp)).not.toContain(
      '`render_image` with `renderer: "software"`, which renders without the editor',
    );
  });

  it('give the cost of new shaders for materials with procedural textures, and of millions of triangles', () => {
    const shader = row(mcp, 'After an edit that needs a shader no material had');
    expect(cell(shader, 2)).toBe(
      `${NEW_SHADER}; up to ${PROCEDURAL_MAX} for the table's and the dowels' materials (several procedural textures)`,
    );
    expect(flat(guide)).toContain(
      `(${NEW_SHADER} in that scene, up to ${PROCEDURAL_MAX} for a material with several procedural textures)`,
    );
    expect(flat(mcp)).toContain(`(${NEW_SHADER_SECONDS}), and that a retry then compiles nothing again`);
    expect(cell(row(mcp, '4 million triangles, the viewport in `SOLID`'), 2)).toBe(MILLIONS_SOLID_SECONDS);
    expect(cell(row(mcp, '4 million triangles: a `select`'), 2)).toBe(MILLIONS_SELECT_SECONDS);
    expect(flat(guide)).toContain(`(${MILLIONS_SOLID_SECONDS} per \`SOLID\` screenshot with 4 million)`);
    expect(flat(mcp)).toContain(
      'A screenshot of a scene of millions of triangles takes half a second or more in any shading: with 4 ' +
        'million triangles, the first one in `WIREFRAME`, `MATERIAL` or `RENDERED` shading took seconds longer ' +
        '(the first `WIREFRAME` one most, see the table) and later ones about as long as a `SOLID` one or longer.',
    );
    expect(flat(guide)).toContain(
      'A screenshot of a scene of millions of triangles takes half a second or more in any shading (',
    );
    // "half a second or more" agrees with the measured range, whose lower end is 0.5 s or more (round
    // 10 said "about a second or more" next to "0.5–1.8 s")
    expect(Number(/^([\d.]+)–/.exec(MILLIONS_SOLID_SECONDS)![1])).toBeGreaterThanOrEqual(0.5);
    for (const text of agentTexts()) expect(text).not.toMatch(/about a second or more/);
    // the first WIREFRAME screenshot builds the wires of every mesh: measured (docs) and said (guide)
    expect(
      cell(
        row(
          mcp,
          '4 million triangles: the first `WIREFRAME` screenshot (it builds the wires of every mesh, and keeps ' +
            'them while the mesh stays the same)',
        ),
        2,
      ),
    ).toBe(M.MILLIONS_WIRE_FIRST);
    expect(flat(guide)).toContain(
      `per \`SOLID\` screenshot with 4 million), and several times as long for the first \`WIREFRAME\` ` +
        'screenshot or frame of such a scene, while the editor builds the wires of every mesh.',
    );
    // round 9's "seconds per frame in any shading" was the statistics overlay counting edges
    for (const doc of [mcp, guide].map(flat)) expect(doc).not.toMatch(/seconds per frame/);
    expect(cell(row(mcp, '`SOLID` and `WIREFRAME` screenshots'), 2)).toBe(FAST_SECONDS);
    expect(flat(guide)).toContain(`A \`SOLID\` or \`WIREFRAME\` screenshot (${FAST_SECONDS} for that scene)`);
  });

  it('say that requests wait for the work the editor is doing, not by when they arrived', () => {
    // a SOLID or WIREFRAME screenshot waits for the viewport's frame in progress; the other commands for
    // the editor's main thread: during a screenshot and while it builds the materials after the
    // viewport's first switch to MATERIAL or RENDERED (measured with get_view sent every 300 ms), and
    // while it carries out a command. Not for the viewport's frames: with 4 million triangles in SOLID
    // shading a get_view sent every 100 ms after a select or a screenshot answered within 0.09 s while
    // the next frame took 0.6-3.3 s to be drawn (r11 TEXTS gv-probe runs); a CPU profile of the page
    // showed the select's own 0.2 s in the statistics overlay's sceneStats (countEdges)
    const doc = flat(mcp);
    expect(doc).toContain(
      'A screenshot waits until the frame the viewport is drawing is done, also a `SOLID` or `WIREFRAME` one',
    );
    expect(doc).toContain(
      "The other commands draw nothing themselves, but wait while the editor's main thread is busy: after the " +
        "viewport switched to `MATERIAL` or `RENDERED` for the first time (while it builds the scene's " +
        'materials; the rest of that frame holds up only screenshots), for the whole of a screenshot it draws, ' +
        'and while it carries out a command: with 4 million triangles in `SOLID` shading a `select` took ' +
        `${MILLIONS_SELECT_SECONDS} (see the table), as the statistics overlay counts the edges of every mesh ` +
        'again (after a screenshot too).',
    );
    // "tenths of a second" understated the measured 0.1-1.2 s (editor-costs.ts MILLIONS_SELECT_SECONDS)
    for (const text of agentTexts()) expect(text).not.toContain('tenths of a second');
    expect(joined(source('mcp/tools.ts'))).toContain(
      'while it carries out a command: with 4 million triangles in SOLID shading a select took ' +
        `\${MILLIONS_SELECT_SECONDS}; the viewport's frames do not hold them up)`,
    );
    for (const text of [doc, flat(guide), joined(source('mcp/tools.ts'))])
      expect(text).not.toMatch(
        /while it draws a frame of a scene with millions|during each frame of a scene/,
      );
    expect(cell(row(mcp, 'Other commands, after the viewport switched to `MATERIAL` or `RENDERED`'), 2)).toBe(
      M.SWITCH,
    );
    expect(flat(guide)).toContain(
      "waits until the viewport's frame in progress is done, also one that compiles; the other commands wait " +
        "while the editor's main thread is busy: during a screenshot",
    );
  });

  it("give the measured times of a browser editor's raster images, in docs/mcp.md and rendering.ts", () => {
    // an older verifier's numbers (12.9 s, 23–44 s) and "every raster image … about 20 s": only the
    // first image of a 71-material scene took that long (it compiles the materials), later ones less
    const rendering = joined(source('mcp/rendering.ts'));
    const doc = flat(mcp);
    const raster = doc.slice(doc.indexOf('a raster image can take longer'), doc.indexOf('A faster answer'));
    expect(doc).not.toMatch(/every (raster|RASTER) image of a heavy scene can take about 20 s|23–44 s/);
    for (const text of [raster, rendering]) {
      expect(text).not.toMatch(
        /every (raster|RASTER) image of a heavy scene can take about 20 s|23–44 s|12\.9 s/,
      );
      expect(text).toContain('the first image of a 71-material scene');
    }
    expect(raster).toContain(
      `in a headless editor at the default 800×450, the first image of a 71-material scene took ${BR_FIRST} ` +
        `while it compiled the materials, the next ones ${BR_LATER}, and images of 4 million triangles ` +
        `${BR_MILLIONS} (on a calm machine with 4 CPUs, widened like the ranges under ` +
        `[\`editor_command\`](#editor_command); on a busy machine up to ${BROWSER_BUSY_FACTOR} times as long)`,
    );
    // rendering.ts names the constant instead of repeating its numbers
    expect(rendering).toContain(
      '(editor-costs.ts BROWSER_RASTER_SECONDS, which says how its ranges were made)',
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
    // a browser editor's images took longer on a busy machine than the other steps: their own factor
    expect(failure.advice).toContain(measuredBrowserImages(BROWSER_RASTER_SECONDS));
    expect(measuredBrowserImages('1 s')).toBe(measured('1 s', BROWSER_BUSY_FACTOR));
    expect(Number(BROWSER_BUSY_FACTOR)).toBeGreaterThan(Number(BUSY_FACTOR));
    expect(doc).not.toMatch(
      /A heavy scene takes tens of seconds in an editor|can take tens of seconds for a heavy scene/,
    );
  });

  it("say for which images renderer 'auto' skips a slow editor, scaled to their pixels both ways", () => {
    // RENDER's round-10 rule (rendering.ts slowBrowserRaster): the time of the editor's last image is
    // scaled to the pixels of the next one, down after a slow image and up after one that took
    // SCALE_UP_MIN_MS or more; the docs said only the first
    const doc = flat(mcp);
    expect(doc).toContain(
      `Likewise, after an image that took ${SCALE_UP_MIN_MS / 1000} s or more, \`auto\` does not ask for a ` +
        `larger one when that time scaled to the pixels of the new image comes to more than ` +
        `${AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000} s (after a 1280×720 image of 12.5 s, a 1920×1080 one would ` +
        'take about 28 s).',
    );
    expect(Math.round((12.5 * 1920 * 1080) / (1280 * 720))).toBe(28);
    expect(joined(source('mcp/tools.ts'))).toContain(
      'and for a larger image after one that took ${SCALE_UP_MIN_MS / 1000} s or more, when that time scaled ' +
        'to its pixels is longer than auto waits',
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
    const rpc = web('editor/rpc.ts').replace(/\s*\n\s*\/\/ ?/g, ' ');
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
    // the in-page timings of round 9 (frames, screenshots, the MCP round trip) are not stated any more:
    // they were never measured over calm runs of several agents
    for (const doc of [mcp, guide].map(flat)) {
      expect(doc).not.toMatch(/about one frame|one frame of the viewport|then one frame/);
      expect(doc).not.toMatch(/the MCP round trip added|its frames took [\d.–]+ s in `SOLID`/);
    }
  });

  it('say exactly how long a get_view waited with 4 million triangles: during and after a command', () => {
    // round 9 said that a get_view sent during or after a select waited seconds for the viewport's
    // frames: on round 9's code one more update of the statistics overlay, which counted the scene's
    // edges. Round 10 said 0.2 s from the probes' first 1.5 s after a command; probes sent for 5 s
    // after it waited longer with no command running: the server's holds (below), which the docs
    // give apart. The editor's own longest: 0.30 s (during) and 0.28 s (after) right after the first
    // select since it had opened the project (a round-10 verifier's T2X run); 37 calm runs of ten
    // agents, pooled (round 11's first verifier: 75 and 136 ms in four runs; its second verifier: 263
    // and 245 ms, and its second fix round 213 and 181 ms, in two runs each). Round 11's first fix
    // attached "unless the server held it up" only to the editor that was not busy, so the 0.4 s read
    // as a bound of every get_view, also one the server held up (0.677 s)
    const doc = flat(mcp);
    expect(doc).toContain(
      `Leaving out the requests that the server held up (below), with 4 million triangles in \`SOLID\` shading, ` +
        `in ${M.GET_VIEW_RUNS} calm runs of ${M.GET_VIEW_AGENTS} agents (rounds 10 and 11), a \`get_view\` sent ` +
        'while the editor carried out a `select` or drew a screenshot answered at most ' +
        `${M.GET_VIEW_DURING} after it, and one sent after it had answered, also while the viewport still drew ` +
        `its next frame, took at most ${M.GET_VIEW_AFTER} (the longest times measured, ${M.GET_VIEW_DURING_MAX} ` +
        `and ${M.GET_VIEW_AFTER_MAX} s, both right after the first \`select\` since the editor had opened the ` +
        `project, widened by ${MARGIN_PERCENT} % and rounded up to 0.1 s); an editor that was not busy answered a ` +
        `\`get_view\` within 0.1 s (${(Math.max(...HOLDS.GET_VIEW_IDLE_MS) / 1000).toFixed(3)} s measured).`,
    );
    expect(
      Math.ceil((Math.max(...HOLDS.GET_VIEW_IDLE_MS) / 1000) * (1 + Number(MARGIN_PERCENT) / 100) * 10) / 10,
    ).toBe(0.1);
    expect(doc).not.toContain('one sent after it had answered took at most 0.2 s');
    expect(doc).not.toContain('in milliseconds, unless the server held it up');
    expect(doc).not.toMatch(
      /0\.1 s after a `select`|waited until it was done and the viewport had drawn|waited for the frames the viewport drew after the selection changed/,
    );
  });

  /*
   * The server holds up every request while it reads back from storage a project that an editor has
   * open (once a minute) and while it gives an editor that opens a project the whole document. Round 11
   * gave 0.3-0.8 s from idle editors only (0.44-0.57 s measured); its first verifier measured 1.14 s
   * with the editor drawing screenshots back to back and 1.47 s with an editor loading the project at
   * the minute's read, a get_view held 0.596 s, and the holds of an editor opening the project, which
   * the docs did not give. Its second verifier measured a get_view held 0.677 s with no command
   * running, more than the 0.60 s the first fix gave as the longest: such a get_view waits for the rest
   * of the hold, and answered at most 0.014 s after it had ended; and an editor's first open of 1.306 s.
   */
  it("say how long the server holds up every request: the minute's read and an editor opening the project", () => {
    const doc = flat(mcp);
    const range = (ms: readonly number[]) => {
      const lo = Math.min(...ms) / 1000;
      const hi = Math.max(...ms) / 1000;
      const pct = Number(MARGIN_PERCENT) / 100;
      const down = Math.floor(Number((lo * (1 - pct) * 10).toFixed(6))) / 10;
      const up = Math.ceil(Number((hi * (1 + pct) * 10).toFixed(6))) / 10;
      return { widened: `${down}–${up} s`, measured: `${lo.toFixed(2)}–${hi.toFixed(2)} s` };
    };
    const refresh = range(HOLDS.REFRESH_MS);
    const open = range(HOLDS.OPEN_MS);
    // the longest measured (seconds, as measured), and the bound widened and rounded up to 0.1 s
    const afterMax = Math.max(...HOLDS.GET_VIEW_AFTER_HOLD_MS) / 1000;
    const afterHold = {
      widened: `${Math.ceil(Number((afterMax * (1 + Number(MARGIN_PERCENT) / 100) * 10).toFixed(6))) / 10} s`,
      measured: `${afterMax.toFixed(3)} s`,
    };
    expect(doc).toContain(
      'The server itself holds up every request, `get_view` too, while it reads a project that a browser ' +
        'editor has open back from storage and merges what it read into the open one, which it does once a ' +
        'minute (to take in what other writers stored), and when a browser editor opens the project, while it ' +
        'reads it back from storage (when no editor or agent had it open) and sends the editor what its own copy ' +
        'lacks (all of it, for an editor that has none). With 4 million triangles (a stored document of 134 MB), ' +
        "in the calm runs of this round's five TEXTS agents, the minute's read held them " +
        `${refresh.widened} each time (${refresh.measured} measured, widened like the ranges above; the longest ` +
        'while an editor drew screenshots back to back or loaded the project), and an editor that opened the ' +
        `project without a copy of it ${open.widened} (${open.measured} measured; the longest when no editor or ` +
        'agent had it open). A request sent during a hold waits for the rest of it: a `get_view` sent with no ' +
        `command running, the editor idle, answered at most ${afterHold.widened} after the hold had ended ` +
        `(${afterHold.measured} measured, widened like the ranges above), so it waited about as long as the ` +
        `rest of the hold (the longest, ${(HOLDS.GET_VIEW_HELD.waitMs / 1000).toFixed(2)} s, in a hold of ` +
        `${(HOLDS.GET_VIEW_HELD.holdMs / 1000).toFixed(2)} s).`,
    );
    // the longest held get_view waited for the rest of its hold, and no longer than it
    expect(HOLDS.GET_VIEW_HELD.waitMs).toBeLessThanOrEqual(
      HOLDS.GET_VIEW_HELD.holdMs + Math.max(...HOLDS.GET_VIEW_AFTER_HOLD_MS),
    );
    expect(HOLDS.REFRESH_MS).toContain(HOLDS.GET_VIEW_HELD.holdMs);
    expect(doc).not.toMatch(/A request sent as a hold starts waits for all of it|waited up to 0\.60 s/);
    expect(flat(guide)).toContain(
      'Once a minute the server holds up every request while it merges what storage holds of a project ' +
        `that an editor has open (${refresh.widened} with 4 million triangles), and while it sends a project ` +
        `to an editor that has no copy of it yet (${open.widened}); a request sent during such a hold waits for ` +
        'the rest of it.',
    );
    expect(flat(guide)).toContain(
      'with 4 million triangles in `SOLID` shading a `select` took ' +
        `${MILLIONS_SELECT_SECONDS}; a \`get_view\` sent then answered at most ${M.GET_VIEW_AFTER} after it, not ` +
        "waiting for the viewport's frames, when the server did not hold it up)",
    );
    for (const text of [doc, flat(guide)]) expect(text).not.toMatch(/0\.3–0\.8 s|up to 0\.57 s/);
    // the minute's read: every 60 s, of rooms with connected editors (and rooms whose write to WebDAV
    // another writer may have replaced); a room nobody uses (no editor, no agent, no unsaved change)
    // is read back before it opens, unless it was read in the last 2 s; an editor that connects gets
    // the server's state vector, and the whole document as the answer to its own (y-protocols sync)
    const rooms = source('sync/room-manager.ts');
    expect(rooms).toContain('const refreshMs = opts.refreshIntervalMs ?? 60_000;');
    expect(rooms).toContain('if (room.conns.size > 0 || room.needsReadBack) await room.refresh();');
    expect(rooms).toContain('return !room.isDirty && room.conns.size === 0 && room.holders.size === 0;');
    expect(rooms).toContain('const UNUSED_ROOM_READ_MS = 2000;');
    expect(rooms).toContain('if (live) await this.readUnused(live);');
    const room = source('sync/room.ts');
    expect(room).toContain('encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, this.doc)),');
    expect(room).toContain('syncProtocol.readSyncMessage(decoder, enc, this.doc, conn);');
    // a browser editor keeps a copy of the project in IndexedDB and asks for what it lacks
    expect(web('project/session.ts')).toContain(
      's.idb = new IndexeddbPersistence(projectDbName(id), s.doc.ydoc);',
    );
    expect(web('sync/provider.ts')).toContain(
      'this.send(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, this.doc)));',
    );
  });
});

describe('docs: measured times', () => {
  it('say how the ranges were made: pooled calm runs widened by a margin, and the busy factors', () => {
    const doc = flat(mcp);
    expect(doc).toContain(
      'Each run started once the CPUs had been at least 90 % idle for 5 s, and runs that other processes ' +
        'disturbed are left out;',
    );
    expect(M.AGENTS).toBe(9);
    expect(doc).toContain(
      `Each range below pools the ${M.CALM_RUNS} calm runs of nine agents on 2026-11-09 and 2026-11-11 (the ` +
        "TEXTS agent of round 9 in four passes and its two verifiers, this round's TEXTS agents and their three " +
        `verifiers) and runs from ${MARGIN_PERCENT} % less than the shortest to ${MARGIN_PERCENT} % more than the ` +
        `longest time measured, rounded outward to 0.1 s (to 1 s from 10 s on). ${M.LOO} Times with 4 million ` +
        `triangles pool this round's ${M.RUNS_4M} runs only: on round 9's code the editor's statistics overlay ` +
        'counted the edges of every mesh each time it was updated, also after every slow frame, which took ' +
        "seconds with 4 million triangles and held these steps up by seconds; this round's code counts them in a " +
        'fraction of that time. A `SOLID` screenshot there includes screenshots sent as soon as a `select` had ' +
        'answered, which waited for the frame the viewport drew then (a screenshot waits for the frames in ' +
        'progress), and a `select` selects sent as soon as a screenshot had answered.',
    );
    // commands other than screenshots do not wait for the viewport's frames (editor-commands.ts)
    expect(doc).not.toContain('answered: they waited for the frame the viewport drew then');
    // the select and the SOLID screenshot with 4 million triangles: ranges made with MARGIN_PERCENT from
    // fewer runs missed a later agent's runs of them (round 10's third verifier: 0.731 s against 0.1–0.7 s,
    // 3.478 s against 0.5–3.4 s), so their upper ends run MILLIONS_MARGIN_PERCENT above the longest time
    expect(M.LOO).toContain(
      `Those of a \`select\` and a \`SOLID\` screenshot with 4 million triangles, which include requests sent as ` +
        `soon as the one before had answered, run to ${MILLIONS_MARGIN_PERCENT} % more than their longest time: ` +
        `with ${MARGIN_PERCENT} %, earlier ranges made from fewer runs missed such runs of later agents (up to `,
    );
    const missed = /up to ([\d.]+) s against 0\.1–0\.7 s, and ([\d.]+) s against 0\.5–3\.4 s\)/.exec(M.LOO)!;
    expect(Number(missed[1])).toBeGreaterThanOrEqual(0.731);
    expect(Number(missed[2])).toBeGreaterThanOrEqual(3.478);
    const upperEnd = (range: string) => Number(/–([\d.]+) s$/.exec(range)![1]);
    const lowerEnd = (range: string) => Number(/^([\d.]+)–/.exec(range)![1]);
    const widenedUp = (max: string, pct: string) =>
      Math.ceil(Number((Number(max) * (1 + Number(pct) / 100) * 10).toFixed(6))) / 10;
    expect(upperEnd(MILLIONS_SOLID_SECONDS)).toBe(widenedUp(M.MILLIONS_SOLID_MAX, MILLIONS_MARGIN_PERCENT));
    expect(upperEnd(MILLIONS_SELECT_SECONDS)).toBe(widenedUp(M.MILLIONS_SELECT_MAX, MILLIONS_MARGIN_PERCENT));
    expect(Number(M.MILLIONS_SOLID_MAX)).toBeGreaterThanOrEqual(3.478);
    expect(Number(M.MILLIONS_SELECT_MAX)).toBeGreaterThanOrEqual(0.731);
    // their lower ends, like every other end, are MARGIN_PERCENT below the shortest time
    expect(lowerEnd(MILLIONS_SOLID_SECONDS)).toBeLessThanOrEqual(0.78 * (1 - Number(MARGIN_PERCENT) / 100));
    // round 10 gave one busy factor without a margin (3.5, the largest ratio of the busy runs pooled
    // then): a browser editor's later raster images took 4.5 times the upper end of their range in a
    // verifier's two runs with four CPU-bound processes (30.4 s and 29.7 s against 2.6–6.7 s). Each
    // factor is now the largest ratio of every busy run pooled, widened like the ranges and rounded up
    // to 0.5, the browser images' apart; the longest such image a verifier measured fits
    expect(doc).toContain(
      'On the same machine kept busy by other processes (four CPU-bound processes and other work, 1-minute load ' +
        `averages of ${BUSY_LOADS} on its 4 CPUs), the same steps took up to ${M.BUSY_RAW} times as long as the ` +
        `upper end of their range, and a browser editor's raster images up to ${M.BROWSER_BUSY_RAW} times (an ` +
        'image right after one that timed out, which it waited for, left out); widened by ' +
        `${MARGIN_PERCENT} % and rounded up to 0.5, the texts say up to ${BUSY_FACTOR} and ${BROWSER_BUSY_FACTOR} ` +
        'times as long' +
        (M.BUSY_LOO_HELD
          ? ", and factors made that way from all but one agent's busy runs held the busy runs of the agent left out."
          : '.'),
    );
    const widen = (raw: string) => Math.ceil(Number(raw) * (1 + Number(MARGIN_PERCENT) / 100) * 2) / 2;
    expect(Number(BUSY_FACTOR)).toBe(widen(M.BUSY_RAW));
    expect(Number(BROWSER_BUSY_FACTOR)).toBe(widen(M.BROWSER_BUSY_RAW));
    // the longest such images measured with four CPU-bound processes: 30.41 s (round 10's verifier) and
    // 33.96 s (its second fix round)
    expect(Number(BR_LATER.split('–')[1].split(' ')[0]) * Number(BROWSER_BUSY_FACTOR)).toBeGreaterThanOrEqual(
      33.96,
    );
    expect(flat(guide)).toContain(
      'These times are the ranges measured on a calm machine with 4 CPUs, the editor in software WebGL ' +
        `(SwiftShader), widened by ${MARGIN_PERCENT} % (the longest \`SOLID\` screenshot with 4 million ` +
        `triangles by ${MILLIONS_MARGIN_PERCENT} %; [how](mcp.md#live-editors)); on a busy one (load averages of ` +
        `${BUSY_LOADS}) the same steps took up to ${BUSY_FACTOR} times as long.`,
    );
    // the short texts say the same
    const made = `the range widened by ${MARGIN_PERCENT} %`;
    expect(measured('1 s')).toBe(
      `1 s, measured on a calm machine with 4 CPUs in software WebGL (${made}), up to ${BUSY_FACTOR} times as long on a busy one`,
    );
    expect(measuredOnServer('1 s')).toBe(
      `1 s, measured on a calm server with 4 CPUs (${made}), up to ${BUSY_FACTOR} times as long on a busy one`,
    );
    // a message says how the range of its own step with 4 million triangles was made: a select's
    // says nothing of screenshots
    const note = (millions: string) =>
      'The times given are the ranges measured on a calm machine with 4 CPUs, the editor in software WebGL, ' +
      `widened by ${MARGIN_PERCENT} %${millions}; on a busy one (load averages of ${BUSY_LOADS}) the same steps ` +
      `took up to ${BUSY_FACTOR} times as long.`;
    const by = `with 4 million triangles by ${MILLIONS_MARGIN_PERCENT} %`;
    expect(measuredNote()).toBe(note(''));
    expect(measuredNote('select')).toBe(note(` (the longest select ${by})`));
    expect(measuredNote('SOLID screenshot')).toBe(note(` (the longest SOLID screenshot ${by})`));
    for (const [command, params, millions] of [
      ['screenshot', {}, 'SOLID screenshot'],
      ['screenshot', { shading: 'SOLID' }, undefined],
      ['screenshot', { shading: 'MATERIAL' }, undefined],
      ['select', {}, 'select'],
      ['get_view', {}, 'select'],
    ] as const)
      expect(
        editorTimeoutMessage(command, 10_000, null, params).endsWith(` ${measuredNote(millions)}`),
        command,
      ).toBe(true);
    // the quoted messages of the Live editors section (a screenshot's and a select's) end so
    for (const millions of ['SOLID screenshot', 'select'] as const)
      expect(doc).toContain(measuredNote(millions));
    for (const text of [doc, flat(guide)]) expect(text).not.toMatch(/vary with the machine's load/);
  });

  it("say what the editor's own CPU use was, instead of 'keeps every CPU busy'", () => {
    const doc = flat(mcp);
    expect(doc).toContain(
      `while it compiled and drew, the editor itself used ${M.CPU_MEDIAN} of the 4 CPUs (the median of 2-second ` +
        `samples), up to ${M.CPU_MAX}.`,
    );
    for (const text of agentTexts()) expect(text).not.toMatch(/keeps every CPU busy|keeps them busy/);
  });

  it('round every range outward as the docs say: to 0.1 s, from 10 s on to 1 s', () => {
    const ranges = [
      FIRST_SHADING_SECONDS,
      LATER_SECONDS,
      FAST_SECONDS,
      NEW_SHADER,
      PROCEDURAL_MAX,
      MILLIONS_SOLID_SECONDS,
      MILLIONS_SELECT_SECONDS,
      SERVER_SOLID_SCENE_SECONDS,
      ...SERVER_SOLID_SECONDS.split(', ').map((s) => s.split(' for ')[0]),
      BR_FIRST,
      BR_LATER,
      BR_MILLIONS,
      M.FIRST_NO_MSAA,
      M.SWITCH,
      M.OOM_256,
      M.MILLIONS_WIRE_FIRST,
    ];
    for (const range of ranges) {
      const values = /^([\d.]+)(?:–([\d.]+))? s$/.exec(range)?.slice(1).filter(Boolean);
      expect(values, range).toBeDefined();
      for (const v of values!) expect(v, range).toMatch(Number(v) >= 10 ? /^\d+$/ : /^\d\.\d$/);
    }
  });

  it('hold the calm times that the verifiers of round 10 measured outside the earlier ranges', () => {
    // round 10's ranges left out a calm select with 4 million triangles (516 ms, a select sent right
    // after a WIREFRAME screenshot, against 0.1–0.5 s) and the raw-SDK out-of-memory probes with
    // RENDER_WORKER_MEMORY_MB=256 (1.26–1.38 s, against 1.6–3.4 s): every calm run is pooled now, and the
    // select and SOLID screenshot with 4 million triangles get a wider upper end
    const holds = (range: string, value: number) => {
      const [lo, hi] = /^([\d.]+)–([\d.]+) s$/.exec(range)!.slice(1).map(Number);
      return lo <= value && value <= hi;
    };
    for (const v of [0.165, 0.516]) expect(holds(MILLIONS_SELECT_SECONDS, v), `${v} s`).toBe(true);
    // round 10's third verifier: a select sent as soon as a WIREFRAME screenshot had answered (731 ms,
    // against 0.1–0.7 s) and a SOLID screenshot sent as soon as a select had answered (3478 ms, against
    // 0.5–3.4 s), both in calm runs
    expect(holds(MILLIONS_SELECT_SECONDS, 0.731)).toBe(true);
    expect(holds(MILLIONS_SOLID_SECONDS, 3.478)).toBe(true);
    expect(
      cell(
        row(
          mcp,
          '4 million triangles, the viewport in `SOLID` (without multisampling): a `SOLID` screenshot',
        ),
        2,
      ),
    ).toBe(MILLIONS_SOLID_SECONDS);
    for (const v of [1.26, 1.307, 1.37, 1.379, 2.38]) expect(holds(M.OOM_256, v), `${v} s`).toBe(true);
    expect(cell(row(mcp, '4 million triangles: a `select`'), 2)).toBe(MILLIONS_SELECT_SECONDS);
    expect(flat(mcp)).toContain(`a grid of 2 million triangles failed after ${M.OOM_256} `);
  });

  it('state no number of an earlier round any more', () => {
    // round 9's ranges (one agent's calm runs), its busy factor and loads, and its server render ranges
    const old =
      /18\.6–25\.4|0\.5–2\.6 s|0\.8–3\.1|0\.9–3\.1|11\.7 s|4\.0–4\.7|3\.4–4\.4|0\.6–1\.2 s|1\.6–3\.1 s|1\.7–6\.0|3\.0–9\.8|1\.7–4\.9|3\.0–6\.4|4\.4–8\.6|22\.8–23\.3|3\.5–4\.1 s|2\.1–8\.1|load averages of 6–20|4\.6 times/;
    for (const text of agentTexts()) expect(text).not.toMatch(old);
    // round 10's ranges that its verifiers' runs disproved or that pooling every calm run changed, its
    // busy loads and its count of calm runs and of a leave-one-agent-out miss
    const round10 =
      /0\.4–1\.5 s|0\.5–1\.8 s|0\.1–0\.5 s|8\.8–19 s|1\.6–3\.4 s|6\.1–11 s|load averages of 4–15|109 calm runs|by up to 24 %/;
    for (const text of agentTexts()) expect(text).not.toMatch(round10);
    // the ranges and factors of round 10's second fix round that the runs of its third verifier and
    // third fix round changed (the method paragraph quotes the two that a later agent's runs missed:
    // "… against 0.1–0.7 s, and … against 0.5–3.4 s"), and its counts of runs
    const fix2 =
      /13–33 s|7\.9–19 s|0\.4–1\.6 s|2\.9–6\.3 s|(?<!against )0\.5–3\.4 s|(?<!against )0\.1–0\.7 s|6\.0–12 s|17–34 s|2\.6–6\.7 s|1\.5–4\.7 s|up to 16 s for|6\.5 times as long|157 calm runs|this round's 28 runs/;
    for (const text of agentTexts()) expect(text).not.toMatch(fix2);
  });
});

describe('docs: server renders', () => {
  it('say that instances take memory in server renders and exports, as the out-of-memory advice does', () => {
    // the software rasterizer keeps world-space vertices per drawn item (core raster.ts worldCache,
    // keyed by its world matrix), so a server render's memory grows with the instances it draws
    expect(file('../../../../packages/core/src/render/raster.ts')).toContain(
      'worldCache: Map<Mat4, WorldVertices> | null = null;',
    );
    expect(OUT_OF_MEMORY_ADVICE).toContain('the number of particle instances');
    // OBJ, STL and PLY write every export item, instances included (core io/common.ts), as a world-space
    // copy of its mesh
    expect(file('../../../../packages/core/src/io/common.ts')).toContain(
      'for (const it of instanceExportItems(scene, new Set(picked.map((o) => o.id)), apply)) items.push(it);',
    );
    for (const format of ['obj', 'stl'])
      expect(file(`../../../../packages/core/src/io/${format}.ts`), format).toContain(
        'const mesh = bakeWorldMesh(it.mesh, it.ev.worldMatrix);',
      );
    expect(file('../../../../packages/core/src/io/ply.ts')).toContain(
      '.map((it) => bakeWorldMesh(it.mesh!, it.ev.worldMatrix));',
    );
    expect(flat(guide)).toContain(
      'Instances cost far less than real objects and render and export, but each one drawn still takes memory ' +
        'in a server render (it grows with the number of instances and the size of the source), and OBJ, STL ' +
        'and PLY exports write each one as a copy: when a server render or export runs out of memory, lower ' +
        "`count` or the source's detail. Instances are not objects:",
    );
    expect(flat(guide)).not.toMatch(/Instances are cheap/);
  });

  it('give one range for grey clay of 2 million triangles, everywhere', () => {
    const doc = flat(mcp);
    expect(doc).toContain(
      `Grey clay (\`shading: "SOLID"\`) at 1280×720 took ${SERVER_SOLID_SCENE_SECONDS} for the 71-material ` +
        `example scene (20,042 triangles) and ${SERVER_SOLID_SECONDS} (on a calm machine with 4 CPUs, widened ` +
        'like the ranges under [`editor_command`](#editor_command)): the first render of a version of the ' +
        'scene, which sends it to the render process, took the longer times, and so did renders of 4 million ' +
        'triangles while an editor drew a screenshot that had timed out. On a busy machine renders took up to ' +
        `${BUSY_FACTOR} times as long.`,
    );
    // every range given for 2 million triangles is SERVER_SOLID_SECONDS's (round 9 gave two)
    const twoMillion = SERVER_SOLID_SECONDS.split(' for 2 million')[0];
    for (const text of agentTexts())
      for (const m of text.matchAll(/([\d.]+–[\d.]+ s) for (a grid of )?2 million/g))
        expect(m[1], m[0]).toBe(twoMillion);
    expect(doc).toContain('The server renders in render processes of its own');
    expect(doc).not.toMatch(/The server's render threads|every render thread|on a render thread/);
  });

  it('say what a render or export that runs out of memory answers, and what each tool can do then', () => {
    const doc = flat(mcp);
    // the stable start of each tool's message, and the code
    expect(doc).toContain(
      'The call fails with `code` `OUT_OF_MEMORY`, as JSON on the lines after the message ' +
        '(`{"code": "OUT_OF_MEMORY"}`), and the message starts the same way every time: "Rendering failed: out ' +
        'of memory: " (`render_image`), "Rendering the animation failed: out of memory: " (`render_animation`) ' +
        'or "Export failed: out of memory: " (`export_scene`).',
    );
    // what happened, as the render processes say it (render/pool.ts)
    const heap = renderProcessExitError(
      1,
      null,
      'FATAL ERROR: Reached heap limit … JavaScript heap out of memory',
      2096,
    );
    const unknownHeap = renderProcessExitError(1, null, 'JavaScript heap out of memory');
    const killed = renderProcessExitError(null, 'SIGKILL', '', 2096);
    const replaced = '; the server keeps running and starts a new render process for the next render';
    expect(heap.message).toBe(
      `out of memory: the render process ran out of its 2096 MB JavaScript heap${replaced}`,
    );
    expect(unknownHeap.message).toBe(
      `out of memory: the render process ran out of its JavaScript heap${replaced}`,
    );
    expect(killed.message).toBe(
      'out of memory: the render process was killed (SIGKILL), most likely by the system because the machine ' +
        `ran out of memory${replaced}`,
    );
    expect(doc).toContain(
      'Then it says what happened: "the render process ran out of its 2096 MB JavaScript heap" (with its heap ' +
        'limit; "its JavaScript heap" when the process had not reported it yet), "the render process could not ' +
        'allocate memory (…)" or "the render process was killed (SIGKILL), most likely by the system because ' +
        `the machine ran out of memory", each followed by "${replaced}".`,
    );
    // what to do: advice each tool can follow (render_animation has no renderer argument)
    for (const [what, advice, tool] of [
      ['Rendering', OUT_OF_MEMORY_ADVICE, 'render_image'],
      ['Rendering the animation', ANIMATION_OUT_OF_MEMORY_ADVICE, 'render_animation'],
      ['Export', EXPORT_OUT_OF_MEMORY_ADVICE, 'export_scene'],
    ] as const) {
      const err = renderToolError(heap, what);
      expect(err.code).toBe('OUT_OF_MEMORY');
      expect(err.message).toBe(`${what} failed: ${heap.message}. ${advice}`);
      expect(doc).toContain(`\`${tool}\` "${advice}"`);
    }
    expect(ANIMATION_OUT_OF_MEMORY_ADVICE).not.toContain("(renderer 'browser')");
    expect(ANIMATION_OUT_OF_MEMORY_ADVICE).toContain("render_image {frame, renderer: 'browser'}");
    // the measured example quotes the whole message
    const small = renderProcessExitError(1, null, 'JavaScript heap out of memory', 256);
    expect(doc).toContain(
      `With \`RENDER_WORKER_MEMORY_MB=256\`, a grid of 2 million triangles failed after ${M.OOM_256} ` +
        `(measured and widened like the times above): "${renderToolError(small).message}"`,
    );
    // a render that only shared the process: no code, no JSON, run it again
    const shared = renderToolError(sharedProcessError(small));
    expect(shared.code).toBe('FAILED');
    expect(doc).toContain(
      'The requests of another long render that waited behind it in the same render process fail without ' +
        '`code` and without JSON, since that render was not the cause and can run again: ' +
        `"${shared.message}"`,
    );
    expect(shared.message).not.toContain(OUT_OF_MEMORY_ADVICE);
    // the REST endpoints
    expect(outOfMemoryReply(heap, 'render')).toEqual({
      status: 507,
      body: { error: `render failed: ${heap.message}`, code: 'OUT_OF_MEMORY' },
    });
    expect(outOfMemoryReply(sharedProcessError(small), 'export')).toMatchObject({
      status: 503,
      body: { code: 'INTERRUPTED' },
      retryAfter: 1,
    });
    expect(doc).toContain(
      'The REST endpoints answer such renders and exports with 507 and ' +
        '`{"error": "render failed: out of memory: …", "code": "OUT_OF_MEMORY"}` (`export failed: …` for ' +
        'exports), and an interrupted one with 503, `{"error": "render failed: interrupted: …", "code": ' +
        '"INTERRUPTED"}` and `Retry-After: 1`.',
    );
    // the error tables
    expect(
      row(
        mcp,
        '`Rendering failed: out of memory: the render process ran out of its 2096 MB JavaScript heap; the server keeps running …`',
      ),
    ).toContain('`OUT_OF_MEMORY`');
    expect(
      row(
        guide,
        '`Rendering failed: out of memory: the render process ran out of its 2096 MB JavaScript heap; …`',
      ),
    ).toContain('(`OUT_OF_MEMORY`; the server keeps running)');
    // round 9's message and its "plain message"
    for (const text of agentTexts())
      expect(text).not.toMatch(
        /Rendering failed: the render process ran out of memory|plain message \(no JSON and no `code`\)|plain message without a `code`/,
      );
  });

  it('say what the agents read about out-of-memory renders in the instructions, the guide and editor_command', () => {
    expect(MCP_INSTRUCTIONS).toContain(
      "a scene that needs more memory than a server render has fails with 'Rendering failed: out of memory: …' " +
        'and code OUT_OF_MEMORY, and then only the editor shows it: retry the screenshot with a larger timeout_ms)',
    );
    const guideText = flat(guide);
    expect(guideText).toContain(
      'The call fails with code `OUT_OF_MEMORY` (JSON after the message) and a message that starts ' +
        '"Rendering failed: out of memory: " (`render_animation`: "Rendering the animation failed: out of ' +
        'memory: ", `export_scene`: "Export failed: out of memory: ")',
    );
    expect(guideText).toContain(
      'Another long render that waited in the same process fails with "Rendering failed: interrupted: …" and ' +
        'no code: it was not the cause, so run it again.',
    );
  });

  it("say that a browser editor's RASTER image ignores `samples`, and how the editor anti-aliases it (engine.ts)", () => {
    // the row said only "`RASTER`: anti-aliasing supersampling 1, 2 or 4 (default 2)", which a browser
    // editor's final render (finalSampling) does not use
    const engine = web('viewport/engine.ts');
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
      'a scene that needs more memory than a server render has fails with "Rendering failed: out of memory: …" ' +
        '(`OUT_OF_MEMORY`), and then only a screenshot with a larger `timeout_ms` shows it.',
    );
    expect(MCP_INSTRUCTIONS).toContain(
      "a quick look with render_image {shading: 'SOLID'} (grey clay, rendered on the server while the editor is " +
        `busy and when the scene's render engine is PATHTRACER: ${measuredOnServer(SERVER_SOLID_SECONDS)}; `,
    );
  });

  it('say which objects apply_modifier and object.convert refuse, and with which code', () => {
    expect(describeOperator('object.convert')).toContain(
      'are refused with those errors and nothing is converted, instead of baking the geometry without them',
    );
    expect(flat(mcp)).toContain(
      'Both refuse an object whose geometry did not evaluate fully (a modifier that failed or was skipped for ' +
        'memory, a mesh the server did not load; for `object.convert` also a curve or text surface that was not ' +
        "built: the `problems` of `get_scene`) with those errors and change nothing; the failure's `code` in " +
        '`run_operator` is `OUT_OF_MEMORY` when memory was the cause, else `FAILED`, and `apply_modifier` ' +
        '("object.modifier_apply failed: …") carries `{"code": "OUT_OF_MEMORY"}` after the message when memory ' +
        'was the cause.',
    );
    // apply_modifier's error is the operator's message with the operator's OUT_OF_MEMORY code
    // (modifiers.ts applyModifier), which the tool wrapper prints as JSON after it (tools.ts)
    expect(joined(source('mcp/modifiers.ts'))).toContain(
      "`object.modifier_apply failed: ${res.error}`, res.code === 'OUT_OF_MEMORY' ? 'OUT_OF_MEMORY' : undefined,",
    );
    expect(flat(mcp)).toContain(
      'The out-of-memory errors of `render_image`, `render_animation`, `export_scene`, `import_model` and ' +
        '`apply_modifier`, and the error of a tool that reads a stored mesh',
    );
    expect(flat(mcp)).not.toContain('gives the message only');
    expect(flat(guide)).toContain(
      'An object whose geometry did not evaluate fully (a modifier that failed or was skipped for memory, a ' +
        'surface that was not built: the `problems` of `get_scene`) is refused with those errors and nothing is ' +
        'converted (`OUT_OF_MEMORY` when memory was the cause, else `FAILED`).',
    );
  });

  it("say that get_scene lists the problems that only the viewport's evaluation has", () => {
    const tools = joined(source('mcp/tools.ts'));
    expect(tools).toContain(
      'including those only the viewport evaluation has (`viewport: true`, e.g. a Subdivision Surface whose ' +
        'viewport levels were skipped for memory; per object, modifier_errors entries with `viewport: true` and ' +
        "problems whose source is followed by ' (viewport)')",
    );
    expect(source('mcp/scene-summary.ts')).toContain('(viewport)');
  });
});

describe('docs: browser path traces and the Render window', () => {
  /*
   * VIEW's round 11 refuses a path trace in two ways (render/memory.ts planRenderThreads): over the
   * memory a render may use in the tab ("it needs about … GB of memory with one render thread, more
   * than …"; lower the resolution or the triangles) and over the tab's JavaScript heap ("its render
   * thread needs about … GB of JavaScript heap, more than the … GB the tab has left for it: …"; lower
   * the triangles), with "or render with the RASTER engine" only when a RASTER render would fit; and
   * a WebGL render whose geometry would not fit the page's heap ("The RASTER render was not started:
   * …", rasterRefusal, thrown by the engine for F12, Render Animation and render_image). The docs
   * quoted the first form only, with "(resolution, triangles)", and said only path traces may not start.
   */
  it('say that a render that does not fit into the tab is not started, and what the error says', () => {
    // apps/web: F12, Render Animation and the editor's render_image refuse a render that would not
    // fit into the tab's memory; the server joins the editor's reason with its advice
    const ui = joined(web('editor/ui-operators.ts'));
    expect(ui).toContain(
      "with the PATHTRACER engine the image refines progressively on the render workers, as many as the tab's " +
        'memory allows, and a path traced render that would not fit into it is not started: the window says why.',
    );
    const caveat = browserUiOperator('render.render')!;
    expect(caveat).toContain(
      "with the render engine PATHTRACER path traced on that computer's render workers, as many as its tab's " +
        "memory allows; a render that would not fit into the tab's memory, path traced or with WebGL, is not " +
        'started: the window says why',
    );
    expect(row(mcp, '`render.render`')).toContain(
      "(with `PATHTRACER` path traced on that computer's render workers, as many as the tab's memory allows; a " +
        "render that would not fit into the tab's memory, path traced or with WebGL, is not started, and the " +
        'window says why)',
    );
    const tools = joined(source('mcp/tools.ts'));
    expect(tools).toContain(
      "PATHTRACER on the editor's render workers, as many as the tab's memory allows (samples, max_bounces, " +
        'denoise, time_limit, seed; waits time_limit + ',
    );
    expect(tools).toContain(
      "an editor does not start a RASTER image whose geometry at the render settings would not fit into its tab's " +
        'JavaScript heap (renderer auto then renders on the server, `note` says why; renderer browser fails ' +
        'with why and what to lower)',
    );
    // the editor's refusals (apps/web render/memory.ts) and how the server passes them on
    const memory = web('render/memory.ts');
    expect(memory).toContain('`Path tracing was not started: ${reason} (about ${tris} triangles, `');
    expect(memory).toContain(
      'const needs1 = `it needs about ${f.need} GB of memory with one render thread`;',
    );
    expect(memory).toContain('? `${needs1}, more than the ${f.total} GB ${budget}`');
    expect(memory).toContain("} else reason = heapReason('its render thread', m.heap, mem);");
    expect(memory).toContain(
      'return `${subject} needs about ${f.need} GB of JavaScript heap, ${left}: ${share}${use}`;',
    );
    expect(memory).toContain(': `more than the ${f.room} GB the tab has left for it`;');
    expect(memory).toContain(
      'const lower = overBudget ? `the resolution or ${LOWER_TRIANGLES}` : LOWER_TRIANGLES;',
    );
    expect(memory).toContain("(needs.rasterFits ? ', or render with the RASTER engine.' : '.'),");
    expect(memory).toContain("'The RASTER render was not started: ' +");
    expect(memory).toContain(
      "heapReason('the geometry it evaluates at the render settings', needs.heap, mem) +",
    );
    for (const refusal of [
      'Path tracing was not started: it needs about 4.3 GB of memory with one render thread.',
      'The RASTER render was not started: the geometry it evaluates at the render settings needs about 0.48 GB ' +
        'of JavaScript heap.',
    ]) {
      const failure = browserRenderFailure(new RpcError(refusal, 'REMOTE'), {
        renderer: 'browser',
        pathTrace: refusal.startsWith('Path'),
        timeoutMs: 60_000,
        timeLimit: 30,
      });
      // one sentence end, no double period
      expect(failure.reason).toBe(`browser render failed: ${refusal.slice(0, -1)}`);
      expect(failure.advice).toBe("Use renderer 'software' to render on the server.");
      expect(`${failure.reason}. ${failure.advice}`).not.toContain('..');
    }
    // the rows of docs/mcp.md: the three refusals, what each says to lower, and the advice
    const budgetRow = row(
      mcp,
      '`browser render failed: Path tracing was not started: it needs about … GB of memory with one render thread, more than …`',
    );
    expect(budgetRow).toContain('the message says what to lower (the resolution or the triangles)');
    const heapRow = row(
      mcp,
      '`browser render failed: Path tracing was not started: its render thread needs about … GB of JavaScript heap, more than the … GB the tab has left for it: …`',
    );
    expect(heapRow).toContain('the message says what to lower (the triangles)');
    for (const r of [budgetRow, heapRow])
      expect(r).toContain(
        'adds "or render with the RASTER engine" when a RASTER render of the scene would fit, and the advice to ' +
          'render on the server (`renderer: "software"`)',
      );
    const rasterRow = row(
      mcp,
      '`browser render failed: The RASTER render was not started: the geometry it evaluates at the render settings needs about … GB of JavaScript heap, …`',
    );
    expect(rasterRow).toContain(
      'the message says what to lower (the triangles) and the advice to render on the server (`renderer: "software"`). ' +
        'With `renderer: "auto"` the server renders the image, and `note` gives this reason',
    );
    expect(flat(mcp)).not.toContain('the message says what to lower (resolution, triangles)');
    expect(
      row(
        guide,
        '`browser render failed: Path tracing was not started: …`, `browser render failed: The RASTER render was not started: …`',
      ),
    ).toContain(
      "lower what the message names (the triangles; for a path trace that does not fit the tab's memory also the " +
        'resolution), use `RASTER` where the message suggests it, or render on the server (`renderer: "software"`)',
    );
  });
});

describe('docs: keys of animated channels', () => {
  it('say that transform_object and the operators key a channel that has keyframes, at the current frame', () => {
    // core object.transform_set (keyChannelChanges) and the *.properties_set operators (rekeyAnimated)
    expect(describeOperator('object.transform_set')).toContain(
      'without it a channel that is already animated is keyed there with its new value, so the object shows it',
    );
    const tools = joined(source('mcp/tools.ts'));
    expect(tools).toContain(
      "A channel that already has keyframes is keyed at the agent's current frame with its new value, so the " +
        'object shows it there (its keys at other frames stay)',
    );
    expect(MCP_INSTRUCTIONS).toContain(
      'a channel that already has keyframes is keyed at your current frame with its new value (its keys at ' +
        'other frames stay)',
    );
    expect(flat(guide)).toContain(
      '**Stored versus evaluated**: `transform_object` and the `*.properties_set` operators set values; a ' +
        'channel that already has keyframes is keyed at your current frame with its new value, so the object ' +
        'shows it there, while its keys at other frames stay and it still moves between them',
    );
    expect(flat(guide)).toContain(
      '`transform_object` on an animated channel keys the new value at your current frame only: its keys at ' +
        'other frames stay, so the object still moves between them.',
    );
    for (const op of ['object.origin_set', 'object.transform_apply'])
      expect(describeOperator(op)).toMatch(/is keyed at the current frame/);
    expect(flat(guide)).toContain(
      '`object.origin_set` and `object.transform_apply` key an animated channel they change at your current ' +
        'frame the same way.',
    );
    // round 9's texts: the stored value only, the keys win
    for (const text of agentTexts())
      expect(text).not.toMatch(/the keys win|the keyframes win|changes only the stored value/);
  });

  it('say that insert_keyframe without value keys the value shown at the current frame', () => {
    expect(describeOperator('anim.keyframe_insert')).toContain(
      'with the values the objects show at the current frame',
    );
    expect(joined(source('mcp/tools.ts'))).toContain(
      "otherwise the value the property shows at the agent's current frame is keyed (an animated or driven " +
        'value there, as Blender keys the current value), also into another `frame`',
    );
    expect(flat(mcp)).toContain(
      "without it the value the property shows at the agent's current frame is keyed (an animated or driven " +
        'value there, as Blender keys the current value), also when `frame` is another frame.',
    );
    expect(flat(guide)).toContain(
      '(without `value` it keys the value the property shows at your current frame, an animated or driven one ' +
        'too, as Blender keys the current value)',
    );
  });

  it('say that duplicates copy the animation, as Blender does by default', () => {
    expect(describeOperator('object.duplicate')).toContain(
      'each copy gets its own copy of the animation (keyframes and drivers) of the object',
    );
    // Blender's Duplicate Linked shares the object's action (object_add.cc: dupflag 0 copies no action):
    // the texts do not say that a linked copy gets its own keyframes as Blender does
    expect(joined(source('mcp/tools.ts'))).toContain(
      "The copy gets its own copy of the object's keyframes and drivers and, unless linked, of its data's " +
        "(shape keys, curve, light and camera values), as Blender's Shift+D does by default; Blender's linked " +
        "duplicates (Alt+D) share the object's action with the original instead, so that later key edits " +
        'change both, while here a linked copy gets its own keyframes too.',
    );
    expect(joined(source('mcp/tools.ts'))).not.toContain(
      'As Blender does by default, the copy gets its own copy',
    );
    expect(flat(mcp)).toContain(
      '`duplicate_object` (and `object.duplicate`) copies the animation as Blender does by default',
    );
    expect(flat(mcp)).toContain(
      'Blender shares one action between linked duplicates; here each linked copy gets its own keyframes.',
    );
    // a linked duplicate shares whatever data the object has (core object.duplicate keeps `data` for
    // every type), not only a mesh
    expect(cell(row(mcp, '`duplicate_object` |'), 3)).toBe(
      '`linked: true` shares the object data (a mesh, curve, text, armature, light or camera) and its ' +
        "animation (Alt+D); a linked copy, too, gets its own copy of the object's keyframes and drivers",
    );
    expect(joined(source('mcp/tools.ts'))).toContain(
      'Duplicate an object (Shift+D; linked=true shares the object data, a mesh, curve, text, armature, ' +
        'light or camera, like Alt+D)',
    );
    expect(joined(source('mcp/tools.ts'))).not.toContain('linked=true shares the mesh data');
  });
});

describe('docs: projects in storage that others share', () => {
  it("say that delete_project's bound is for an id, and what looking up a name adds", () => {
    // a verifier measured 6 rounds of requests (3 stated) deleting by a name that could be an id, 7 for a
    // loaded project (5 s plus one request stated): AgentSession.findProject tries such a name as an
    // id first (RoomManager.exists: project.json, then document.ybin), then lists storage to compare
    // the name with every project, also one this server has loaded (round 11: the name rule over
    // loaded and stored projects together), within one 5 s wait when a loaded project has the name
    const agentSrc = source('mcp/agent.ts');
    expect(agentSrc).toContain('if (isValidProjectId(r) && (await rooms.exists(r))) return { id: r };');
    expect(agentSrc).toContain('await listForName(rooms, late ? 0 : deadline)');
    // the listing reads the project.json only of stored projects that are new or changed, or read more
    // than a minute ago (round 11 STORAGE fix1: RoomManager.listNames; round 11 said "then every
    // project's project.json at once")
    expect(source('sync/room-manager.ts')).toContain('listNames');
    expect(flat(mcp)).toContain(
      "five when it has no `project.json`), when you pass the project's id. A name is looked up first: one " +
        'that could be an id (letters, digits, `-` and `_`) is tried as an id first (up to two more requests ' +
        'one after another), then storage is listed to compare the name with every project (one request, ' +
        'then the `project.json` of each stored project that is new or changed since this server read it, or ' +
        'that it read more than a minute ago), at most 5 s in all when this server has loaded a project of ' +
        'that name; a project this server has not loaded is found by that listing instead of the first read ' +
        'of its `project.json`.',
    );
    for (const text of [flat(mcp), joined(source('mcp/tools.ts'))])
      expect(text).not.toMatch(/then every project's `?project\.json`? at once/);
    // also when storage listed slowly the last time: the name was compared with that listing (agent.ts
    // findProject, note 'slow')
    expect(source('mcp/agent.ts')).toContain(
      "note: foundWithout(r, match.id, 'slow', waitMs, earlier.ageMs)",
    );
    expect(flat(mcp)).toContain(
      'or took longer than 5 s to list its projects the last time (the name is then compared with that ' +
        'listing), the call deletes nothing',
    );
    // a deletion by a name that was not compared with every project deletes nothing (tools.ts
    // delete_project asks findProject for its note): another project in storage may have that name
    expect(source('mcp/tools.ts')).toContain(
      'if (note) throw new ToolError(`delete_project deleted nothing: ${note}`);',
    );
    expect(flat(mcp)).toContain(
      "the call deletes nothing and fails with \"delete_project deleted nothing: Project '<name>' was found " +
        'by name, but …: … may have this name too. Pass the id <id> to name this project without a lookup."',
    );
  });

  it('say when another writer deleted a project this server has open, and when listing storage failed', () => {
    const doc = flat(mcp);
    expect(doc).toContain(DELETED_ELSEWHERE_NOTE.slice(0, DELETED_ELSEWHERE_NOTE.indexOf(' This server')));
    expect(doc).toContain(`"${LIST_FAILED_NOTE}"`);
    expect(doc).toContain(`"${LIST_PARTIAL_NOTE}"`);
    expect(doc).toContain(
      'When listing storage fails or does not answer in that time, a name that a project this server has ' +
        'loaded has finds that project, compared with the loaded projects only',
    );
    // and the result of such a call says so (tools.ts withProjectNotes, agent.ts collectProjectNotes)
    expect(doc).toContain(
      "says so in its result: `project_note` (\"Project '<name>' was found by name, but storage did not " +
        'answer within 5 s, so only the projects this server has loaded were compared: a project that is ' +
        'only in storage may have this name too. Pass the id <id> to name this project without a lookup.")',
    );
    // in the result's JSON, also next to an image or a file (one text, which scripts/mcp.mjs parses;
    // round 11's first fix gave it a text of its own), and in failures (it left them out)
    expect(doc).toContain(
      "a field of the result's JSON (also of the JSON that comes with an image or a file; a screenshot, " +
        'which has none, gets a text of its own after the image) and of the JSON after the message of a ' +
        'call that failed (a JSON of its own after a message that has none)',
    );
    expect(doc).toContain(
      'A call that found its project by a name compared with fewer projects than all adds `project_note` ' +
        '(see [Projects](#projects)) to the JSON after its message, or as JSON of its own after a plain message.',
    );
    expect(doc).not.toContain('a field of the result object, or a text of its own after an image or a file');
    const tools = source('mcp/tools.ts');
    expect(tools).toContain(
      'return withProjectNotes(failure(`${name} failed: ${errorMessage(err)}`), notes);',
    );
    expect(doc).toContain(
      'Editors and agents that have the project open on another server sharing the storage stay connected ' +
        'there, and their next change stores the project again',
    );
    expect(row(mcp, '`get_project`')).toContain('`deleted_from_storage`');
    expect(row(mcp, '`list_projects`')).toContain('`storage_listing_failed`');
    expect(flat(guide)).toContain('`deleted_from_storage: true`');
  });

  it("give get_project's and delete_project's waits and messages as the code has them", () => {
    const doc = flat(mcp);
    expect(doc).toContain(
      `\`get_project\` checks it before it answers (unless the server read it in the last ` +
        `${PROJECT_READ_MAX_AGE_MS / 1000} s; it waits up to ${PROJECT_READ_WAIT_MS / 1000} s in all for that ` +
        'check and for a read of the project that is still going on)',
    );
    expect(flat(guide)).toContain(
      `unless the server read it in the last ${PROJECT_READ_MAX_AGE_MS / 1000} s, and waits up to ` +
        `${PROJECT_READ_WAIT_MS / 1000} s for that`,
    );
    // delete_project: storage first, then the close code and the editors' label
    const protocol = file('../../../../packages/core/src/sync/protocol.ts');
    expect(protocol).toContain('export const PROJECT_DELETED_CLOSE_CODE = 4404;');
    expect(web('ui/App.tsx')).toContain("'Deleted on server'");
    expect(doc).toContain(
      '`delete_project` deletes the stored files, and once storage has deleted them, closes the project for ' +
        'every editor and agent that has it open on this server (browser editors get close code 4404 and show ' +
        '"Deleted on server")',
    );
    const rooms = source('sync/room-manager.ts');
    expect(rooms).toContain(
      '`could not delete project ${id} from storage (${errorMessage(err)}); ${kept}: delete it again`',
    );
    expect(rooms).toContain(
      "storage did not finish this project's earlier reads and writes within ${waitMs / 1000} s",
    );
    expect(doc).toContain(
      'the call fails with "delete_project failed: could not delete project <id> from storage (<reason>); …: ' +
        'delete it again"',
    );
    expect(doc).toContain(
      `Reasons are "storage did not finish this project's earlier reads and writes within ` +
        `${PROJECT_READ_WAIT_MS / 1000} s"`,
    );
    expect(source('persistence/index.ts')).toContain('timeoutMs: 30_000');
    expect(doc).toContain('"DELETE <path> got no complete answer within 30 s"');
    // with WebDAV through this server's proxy, a browser's next change reopens the project here
    expect(doc).toContain(
      "with WebDAV through this server's `/dav` proxy, this server then opens the project again and those " +
        'browsers sync with it live, which undoes the deletion for everyone.',
    );
    // the REST endpoint's answer to a deletion that storage failed: 503 with the reason, like the GET
    // routes (api/projects.ts; it answered Fastify's 500 before round 10's last fix)
    expect(source('api/projects.ts')).toContain(
      'if (err instanceof StorageUnavailableError) return reply.code(503).send({ error: err.message });',
    );
    expect(doc).toContain(
      '503 when the server stopped it or the storage is unavailable, also for a `DELETE` that storage could ' +
        'not carry out (`{"error": "could not delete project <id> from storage (<reason>); …"}`, or "could not ' +
        'read project <id> from storage (<reason>)" for a project the server has not loaded);',
    );
    expect(doc).not.toMatch(/Fastify's `\{statusCode, error, message\}`/);
  });

  it("say what wm.save_mainfile shows the person, as the editor's toasts do", () => {
    const caveat = browserUiOperator('wm.save_mainfile')!;
    expect(web('storage/webdav.ts')).toContain("{ message: 'Saved to WebDAV', level: 'info' }");
    expect(web('project/session.ts')).toContain("message: 'Saved in this browser'");
    expect(caveat).toContain(
      "shows the person what happened: 'Saved to WebDAV', 'Saved in this browser' (no WebDAV), 'Not saved to " +
        "WebDAV (<reason>). The project is saved in this browser.', or that it syncs once back online",
    );
    for (const text of agentTexts()) expect(text).not.toMatch(/shows the person a Saved message/);
    // only a save to WebDAV stores a deleted project again (WebDAVSync.save); Save always connects
    // to the server again (ProjectSession.flush), which closes the connection of a project it
    // deleted within the hour (RoomManager's tombstones) unless storage holds it again
    expect(web('project/session.ts')).toMatch(
      /: \{ message: 'Saved in this browser', level: 'info' \};\s*this\.provider\?\.reconnect\(\);/,
    );
    expect(source('sync/room-manager.ts')).toContain('const TOMBSTONE_TTL_MS = 60 * 60 * 1000;');
    const reconnect =
      'It also connects that editor to the server again, which closes the connection again while the server ' +
      'has the project deleted (within an hour of deleting it, unless storage holds it again)';
    // the toast names who deleted it (the server, another device, another tab): one example is quoted
    expect(web('storage/webdav.ts')).toContain(
      '`"${this.doc.name}" was deleted from WebDAV on another device; this browser stored it there again.`',
    );
    expect(caveat).toContain(
      'with WebDAV, a project that the server or another device had deleted is stored there again (for example \'"<name>" ' +
        `was deleted on the server; this browser stored it there again.'). ${reconnect}`,
    );
    expect(flat(mcp)).toContain(
      'with WebDAV, a project that the server or another device had deleted is stored there again (for example "\\"<name>\\" ' +
        `was deleted on the server; this browser stored it there again."). ${reconnect}`,
    );
    for (const text of [caveat, flat(mcp)])
      expect(text).not.toMatch(/back online; a project that the server/);
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
  const prose = (doc: string) => {
    const lines = doc.split('\n');
    const out: [string, string][] = [];
    let fenced = false;
    for (let i = 0; i + 1 < lines.length; i++) {
      const [line, next] = [lines[i], lines[i + 1]];
      if (line.trimStart().startsWith('```')) fenced = !fenced;
      if (fenced || /^\s*(\||#|```|<!--)/.test(line)) continue;
      out.push([line, next]);
    }
    return out;
  };
  const shortLines = (doc: string) =>
    prose(doc)
      .filter(([line, next]) => line.trim() && next.trim() && !/^\s*([-*|#]\s|```|\d+\.\s|<!--)/.test(next))
      .filter(([line, next]) => {
        // a code span is one word with what touches it, also an opening parenthesis: "(`{…}`,"
        const word = next.trim().match(/^(\S*?`[^`]*`\S*|\S+)/)![0];
        // a line cut 20 or more columns short (round 11 left "… ends its advice with "… or render" at 61
        // columns and four more of 65-76 columns, which the old limit of 60 let through)
        return line.length < 80 && line.length + 1 + word.length <= 100;
      })
      .map(([line]) => line);
  // a line longer than 100 columns holds one word that cannot be broken (a long code span)
  const longLines = (doc: string) =>
    prose(doc)
      .map(([line]) => line)
      .filter(
        (line) =>
          line.length > 100 &&
          /\s/.test(
            line
              .trim()
              .replace(/^[-*]\s+/, '')
              .replace(/`[^`]*`/g, ''),
          ),
      );

  it('cuts no prose line short before a word that fits on it', () => {
    expect(shortLines(mcp)).toEqual([]);
    expect(shortLines(guide)).toEqual([]);
  });

  it('wraps every prose line at 100 columns', () => {
    expect(longLines(mcp)).toEqual([]);
    expect(longLines(guide)).toEqual([]);
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

describe('docs: single-thread renders', () => {
  /*
   * With RENDER_WORKERS=0 the refusals of renders and exports gave the advice of a render process,
   * which evaluates meshes hidden from renders too, and the docs quoted it; the check of the server's
   * own process counts the meshes shown in renders only (render/memory.ts estimateRenderMemory).
   */
  it("quote the refusals of the server's own process with the advice of that mode", () => {
    const doc = flat(mcp);
    const MB = 1024 * 1024;
    // an empty scene with no free heap: refused, with numbers the docs leave out
    const scene = SceneDoc.create({ name: 'Single thread', empty: true });
    const refused = (what: 'render' | 'export') => {
      try {
        checkMainThreadRender(
          scene,
          () => 0,
          () => undefined,
          what,
          () => 1024 * MB,
        );
      } catch (err) {
        return err as Error;
      }
      throw new Error('not refused');
    };
    // the messages with their numbers as the docs leave them out
    const dotted = (m: string) =>
      m
        .replace(/about \d+ MB/, 'about … MB')
        .replace(/about [\d,]+ triangles/, 'about … triangles')
        .replace(/has \d+ MB of its \d+ MB/, 'has … MB of its … MB');
    const render = dotted(renderToolError(refused('render')).message);
    expect(render).toBe(
      "Rendering failed: out of memory: this render was not started: it needs about … MB of JavaScript heap (about … triangles), and renders run in the server's own process (its render processes are off: RENDER_WORKERS=0, or they could not start), which has … MB of its … MB heap free; running out of it would stop the server. " +
        SINGLE_THREAD_RENDER_ADVICE,
    );
    expect(doc).toContain(`with \`code\` \`OUT_OF_MEMORY\`: "${render}"`);
    const animation = renderToolError(refused('render'), 'Rendering the animation').message;
    const tail =
      "or render the frames one by one with render_image {frame, renderer: 'browser'} in a browser editor that has the project open.";
    expect(animation.endsWith(tail)).toBe(true);
    expect(doc).toContain(`\`render_animation\` ends its advice with "… ${tail}"`);
    const exported = renderToolError(refused('export'), 'Export').message;
    expect(exported.endsWith(`running out of it would stop the server. ${SINGLE_THREAD_EXPORT_ADVICE}`)).toBe(
      true,
    );
    expect(doc).toContain(
      'An export says "Export failed: out of memory: this export was not started: … and exports run in the ' +
        "server's own process (…), which has … MB of its … MB heap free; running out of it would stop the " +
        `server. ${SINGLE_THREAD_EXPORT_ADVICE}"`,
    );
    expect(SINGLE_THREAD_ANIMATION_ADVICE.endsWith(tail)).toBe(true);
    // what the check counts, as measured (a 748 MB heap; rendering.test.ts gives the estimate)
    expect(doc).toContain(
      'Unlike a render process, this check leaves meshes hidden from renders out (the render still ' +
        "evaluates them, and the server's guard skips a modifier of theirs that would not fit into its heap), " +
        'so hiding the heavy mesh lets the render start: with a 748 MB heap (`--max-old-space-size=700`), a ' +
        'grid of 100×100 quads with a Subdivision Surface of render level 4 was refused ("it needs about 1716 ' +
        'MB of JavaScript heap (about 5,120,012 triangles) … which has 673 MB of its 748 MB heap free …"), and ' +
        'once it was hidden from renders `render_image`, `render_animation` and `export_scene` worked.',
    );
    // an export that names the hidden mesh writes what the guard let it evaluate, and says nothing
    // (round 11's TEXTS agent and its verifier, live: the binary STL of objects ['G'] had 1,000,084
    // bytes, 84 + 50 per triangle: the 20,000 triangles of the grid; warnings [])
    expect((1_000_084 - 84) / 50).toBe(2 * 100 * 100);
    expect(doc).toContain(
      "An export that names such a hidden mesh in `objects` writes it as the server's guard let it " +
        'evaluate, and `warnings` does not say what is missing: with `objects: ["G"]` the STL file held the ' +
        '20,000 triangles of the grid without its Subdivision Surface.',
    );
    // the error tables
    expect(
      row(
        mcp,
        '`Rendering failed: out of memory: the render process ran out of its 2096 MB JavaScript heap; the server keeps running …`',
      ),
    ).toContain(
      "Without render processes (`RENDER_WORKERS=0`) one that would not fit into the server's heap is not " +
        'started (`Rendering failed: out of memory: this render was not started: …`); that check counts the ' +
        'meshes shown in renders only, so hiding a mesh from renders (`hide_render`) helps there.',
    );
    const guideRow = row(
      guide,
      '`Rendering failed: out of memory: the render process ran out of its 2096 MB JavaScript heap; …`',
    );
    expect(guideRow).toContain(
      '(hiding meshes from renders helps only without render processes: `… was not started: …`)',
    );
    expect(guideRow).not.toContain('hiding meshes from renders does not help');
  });

  /*
   * The descriptions of render_image, render_animation and export_scene said only what a render
   * process does (it evaluates every mesh, also those hidden from renders): without render processes
   * the server's own process renders and exports, refuses one it has no memory for with its own
   * message, and its check leaves meshes hidden from renders out.
   */
  it('say in the descriptions of the render and export tools what that mode refuses and what helps there', () => {
    const tools = joined(source('mcp/tools.ts'));
    const scene = SceneDoc.create({ name: 'Single thread', empty: true });
    const refused = (what: 'render' | 'export') => {
      try {
        checkMainThreadRender(
          scene,
          () => 0,
          () => undefined,
          what,
          () => 1024 * 1024 * 1024,
        );
      } catch (err) {
        return err as Error;
      }
      throw new Error('not refused');
    };
    const start = (m: string) => m.slice(0, m.indexOf(' was not started: ') + ' was not started: '.length);
    for (const [message, sentence] of [
      [
        renderToolError(refused('render')).message,
        'Without render processes (RENDER_WORKERS=0, or they could not start) the server renders in its own process, and a render it does not have the memory for is not started (',
      ],
      [
        renderToolError(refused('render'), 'Rendering the animation').message,
        "Without render processes (RENDER_WORKERS=0, or they could not start) the frames render in the server's own process, and an animation it does not have the memory for is not started (",
      ],
      [
        renderToolError(refused('export'), 'Export').message,
        "Without render processes (RENDER_WORKERS=0, or they could not start) the export runs in the server's own process, and one it does not have the memory for is not started (",
      ],
    ]) {
      expect(tools).toContain(`${sentence}'${start(message)}…'`);
    }
    expect(tools).toContain(
      'that check counts only the meshes shown in renders, so hiding a heavy mesh from renders (hide_render) lets the render start.',
    );
    expect(tools).toContain(
      'that check counts only the meshes shown in renders, so hiding a heavy mesh from renders (hide_render; an export without objects leaves it out of the file) lets the export start.',
    );
  });
});

describe('docs: agent guide (round 11)', () => {
  it('say that a listing that read some stored projects lists them', () => {
    // LIST_FAILED_NOTE (listing failed: loaded projects only) and LIST_PARTIAL_NOTE (some project.json
    // reads failed: only those missing), as list_projects says them
    expect(LIST_FAILED_NOTE).toContain('so only the projects this server has loaded are listed');
    expect(LIST_PARTIAL_NOTE).toContain(
      'so those projects are missing until a later list_projects reads them; the other projects in storage ' +
        'and the projects this server has loaded are listed',
    );
    const doc = flat(guide);
    expect(doc).toContain(
      'When `list_projects` has `storage_listing_failed: true`, some projects in storage are missing from it, ' +
        'and its `note` says which: when listing storage failed or did not answer within 30 s, it lists only ' +
        'the projects loaded on the server; when reading the `project.json` of some stored projects failed, ' +
        'only those are missing.',
    );
    expect(doc).not.toContain(
      '`storage_listing_failed: true` (storage failed or did not answer within 30 s), it lists only the ' +
        'projects loaded on the server.',
    );
  });

  it("say which images renderer 'auto' renders on the server after a slow or long one, scaled to their pixels", () => {
    const auto = AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000;
    const minutes = SLOW_EDITOR_RETRY_MS / 60_000;
    expect(minutes).toBe(2);
    const doc = flat(guide);
    expect(doc).toContain(
      `After an editor needed longer than \`auto\` waits (${auto} s) for a raster image, \`auto\` renders on ` +
        `the server without asking it for ${minutes} minutes after that image (so it stays fast), except a ` +
        `smaller image whose time, that one's scaled to its pixels, comes to at most ${auto} s; for ` +
        `${minutes} minutes after an image that took ${SCALE_UP_MIN_MS / 1000} s or more, a larger image whose ` +
        `time scaled that way comes to more than ${auto} s goes to the server too (\`SOLID\` images and the ` +
        'others are judged apart). `renderer: "browser"` still uses the editor, and once it has drawn an image ' +
        `within ${auto} s, \`auto\` asks it again (for a larger image, by the rule above).`,
    );
    expect(doc).not.toContain(
      '`auto` renders on the server for 2 minutes without asking it (so it stays fast);',
    );
  });
});

describe("docs: other areas' messages (round 11)", () => {
  const MB = 1024 * 1024;

  /*
   * MEM: an import that would not fit is refused with the editor_command call that runs it in a
   * browser editor; one that would make the project hold more than the server keeps for one project
   * says what to lower, and a browser editor would not help. mcp.md quotes a measured refusal
   * (8 glTF meshes sharing the accessors of a grid of 300×300 quads, on a 688 MB heap) and the
   * ceiling's wording.
   */
  it('quote the import refusals as the server words them', () => {
    const core = joined(file('../../../../packages/core/src/operators/memory.ts'));
    const meshes =
      'the meshes of the file (every glTF mesh is decoded into a mesh of its own, also where meshes share the same accessors)';
    const nodes = 'the nodes (objects) of the file';
    for (const lower of [meshes, nodes]) expect(core).toContain(`'${lower}'`);
    const peak = refusedOperatorMessage(
      {
        operator: 'import_scene.gltf',
        estimate: {
          bytes: 380 * MB,
          faces: 1_440_000,
          meshes: 8,
          objects: 8,
          addedStoredBytes: 1,
          lower: meshes,
        },
        storedBytes: 0,
      } as never,
      623 * MB,
      688 * MB,
    );
    expect(flat(mcp)).toContain(`for example (one line): "Import failed: ${peak}"`);
    expect(peak).toContain(
      "(a browser editor runs it in its own memory: editor_command {command: 'run_operator', params: {operator: 'import_scene.gltf', params: {data_base64}}})",
    );
    // 25,000 nodes: 11,000 bytes kept and 33,000 more while the project is saved for each (MEM fix
    // round 2: the save counts too)
    const ceiling = storedMeshesMessage(
      {
        operator: 'import_scene.gltf',
        estimate: {
          bytes: 1,
          faces: 0,
          objects: 25_000,
          addedStoredBytes: 262 * MB,
          addedSaveBytes: 786 * MB,
          lower: nodes,
        },
        storedBytes: 0,
        saveBytes: 0,
        objects: 0,
      } as never,
      688 * MB,
    );
    const dotted = ceiling.replace(/[\d,]+ (MB|new objects|objects)/g, '… $1');
    expect(dotted).toContain(
      'and a save of it about … MB more for a moment (3 times what its objects, datablocks and keyframes take): … MB in all, more than the … MB',
    );
    expect(flat(mcp)).toContain(`fails with "Import failed: ${dotted}"`);
    expect(ceiling).not.toContain('a browser editor');
  });

  /*
   * BONE: object.modifier_apply refuses a modifier that can change nothing (Blender's is_disabled,
   * "Modifier is disabled, skipping apply") and keeps it; mcp.md and the apply_modifier description
   * quote the message.
   */
  it("quote Apply's refusal of a modifier that can change nothing", () => {
    const doc = SceneDoc.create({ name: 'Apply', empty: true });
    const registry = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: { type: 'test' },
      source: 'test',
      report: () => undefined,
    };
    expect(registry.run(ctx, 'mesh.primitive_cube_add', { name: 'Box' }).ok).toBe(true);
    expect(registry.run(ctx, 'object.modifier_add', { type: 'BOOLEAN' }).ok).toBe(true);
    const refused = registry.run(ctx, 'object.modifier_apply', { object: 'Box', modifier: 'Boolean' });
    expect(refused).toMatchObject({ ok: false, code: 'FAILED' });
    const message = `object.modifier_apply failed: ${(refused as { error: string }).error}`;
    expect(message).toBe(
      "object.modifier_apply failed: Modifier is disabled, skipping apply: the Boolean modifier 'Boolean' has no object, so it changes nothing; change it with object.modifier_set or remove it with object.modifier_remove",
    );
    expect(doc.getObject(ctx.state.activeId!)!.modifiers.map((m) => m.name)).toEqual(['Boolean']);
    expect(flat(mcp)).toContain(`("${message}", \`code\` \`FAILED\` in \`run_operator\`)`);
    expect(joined(source('mcp/tools.ts'))).toContain(`'${message}'`);
    // and one hidden in the viewport
    expect(
      registry.run(ctx, 'object.modifier_set', { object: 'Box', modifier: 'Boolean', show_viewport: false })
        .ok,
    ).toBe(true);
    const hidden = registry.run(ctx, 'object.modifier_apply', { object: 'Box', modifier: 'Boolean' });
    expect((hidden as { error: string }).error).toBe(
      "Modifier 'Boolean' is disabled in the viewport; enable it before applying",
    );
    expect(flat(mcp)).toContain(
      '"object.modifier_apply failed: Modifier \'Bevel\' is disabled in the viewport; enable it before applying"',
    );
    // that refusal is this editor's: Blender 4.2 applies a modifier hidden in the viewport
    // (object_modifier.cc, ED_object_modifier_apply: "Force mode on the evaluated modifier, enforcing
    // the modifier evaluation in the apply() functions", md_eval->mode |= eModifierMode_Realtime on a
    // dependency graph built without visibility optimizations); round 11 credited it to Blender
    expect(flat(mcp)).toContain(
      'A modifier hidden in the viewport is refused too, unlike Blender, which applies it ("object.modifier_apply failed: Modifier',
    );
    expect(joined(source('mcp/tools.ts'))).toContain(
      "A modifier hidden in the viewport is refused too ('… is disabled in the viewport; enable it before applying'), unlike Blender, which applies it.",
    );
    for (const text of [flat(mcp), joined(source('mcp/tools.ts'))])
      expect(text).not.toMatch(/(nor|neither) is one hidden in the viewport/);
  });

  /*
   * BONE fix1: a modifier parameter that names an object takes the object types Blender stores there,
   * and object.modifier_add and object.modifier_set refuse another type. MCP add_modifier and
   * update_modifier run those operators on mesh objects only (modifiers.ts operatorsApply) and edit
   * the stack of a curve or text object directly, without that check (checked live: an Armature
   * modifier on a curve with a mesh as its object is stored with via 'document' and reports the
   * error below in get_scene problems). The docs said only that these parameters take names or ids.
   */
  it('say which object types modifier object parameters take, and where add_modifier refuses another', () => {
    registerBuiltinModifiers();
    const doc = flat(mcp);
    expect(modifierObjectTypes('BOOLEAN', 'object')).toEqual(['MESH']);
    expect(modifierObjectTypes('ARRAY', 'start_cap')).toEqual(['MESH']);
    expect(modifierObjectTypes('ARRAY', 'end_cap')).toEqual(['MESH']);
    expect(modifierObjectTypes('SHRINKWRAP', 'target')).toEqual(['MESH']);
    expect(modifierObjectTypes('ARMATURE', 'object')).toEqual(['ARMATURE']);
    expect(modifierObjectTypes('CURVE', 'object')).toEqual(['CURVE']);
    expect(modifierObjectTypes('ARRAY', 'offset_object')).toBeNull();
    expect(modifierObjectTypes('MIRROR', 'mirror_object')).toBeNull();
    expect(doc).toContain(
      'As in Blender, some take objects of one type only: a mesh for `BOOLEAN object`, `ARRAY start_cap` ' +
        'and `end_cap` and `SHRINKWRAP target`, an armature for `ARMATURE object`, a curve for `CURVE object`.',
    );
    // the refusal the docs quote, as the tools give it (modifiers.ts prefixes the operator's error)
    const refusal = modifierObjectRefusal('ARMATURE', 'object', { name: 'Box', type: 'MESH' });
    // both hints of object.convert (the docs named only the one to MESH)
    expect(doc).toContain(
      `On a mesh object, \`add_modifier\` and \`update_modifier\` refuse an object of another type ("object.modifier_add failed: ${refusal}", ` +
        '`object.modifier_set failed: …` for `update_modifier`; a curve or text where a mesh is needed adds ' +
        '"(object.convert with target MESH makes it one)", a text where a curve is needed "(object.convert with ' +
        'target CURVE makes it one)").',
    );
    for (const type of ['CURVE', 'FONT'])
      expect(modifierObjectRefusal('BOOLEAN', 'object', { name: 'Label', type })).toMatch(
        / \(object\.convert with target MESH makes it one\)$/,
      );
    expect(modifierObjectRefusal('CURVE', 'object', { name: 'Label', type: 'FONT' })).toMatch(
      / \(object\.convert with target CURVE makes it one\)$/,
    );
    expect(modifierObjectRefusal('CURVE', 'object', { name: 'Box', type: 'MESH' })).not.toMatch(
      /object\.convert/,
    );
    const modifiers = source('mcp/modifiers.ts');
    expect(modifiers).toContain(
      'if (!res.ok) throw new ToolError(`object.modifier_add failed: ${res.error}`);',
    );
    expect(modifiers).toContain(
      'if (!res.ok) throw new ToolError(`object.modifier_set failed: ${res.error}`);',
    );
    expect(modifiers).toContain("return o.type === 'MESH';");
    expect(doc).toContain(
      'On a curve or text object they store it without that check (`via: "document"`); look at the ' +
        '`problems` of `get_scene` then (an Armature modifier whose object is a mesh: "armature object not ' +
        'found (or it is not an armature)").',
    );
    expect(file('../../../../packages/core/src/modifiers/armature.ts')).toContain(
      "throw new Error('armature object not found (or it is not an armature)');",
    );
  });

  /*
   * MEM fix1: the inspection tools (get_scene, get_object, get_mesh_data, get_instances) refuse an
   * evaluation the server's heap has no room for (mcp/eval-cache.ts), and an operator that adds to a
   * project already over what the server keeps for one says so instead of naming the operator's
   * share; the docs quoted neither.
   */
  it('quote the refusal of an evaluation and of a project already over what the server keeps for one', () => {
    const evaluation = refusedEvaluationMessage(70_000, 400 * MB, 300 * MB, 2096 * MB);
    const dottedEvaluation = evaluation
      .replace(/scene's [\d,]+ objects/, "scene's … objects")
      .replace(/about [\d,]+ MB/, 'about … MB')
      .replace(
        /has [\d,]+ MB of its [\d,]+ MB heap free and keeps [\d,]+ MB/,
        'has … MB of its … MB heap free and keeps … MB',
      );
    expect(flat(mcp)).toContain(`"get_scene failed: ${dottedEvaluation}" (\`get_object failed: …\``);
    // the tools give it their name and code OUT_OF_MEMORY (a MeshMemoryError), as JSON after it
    expect(joined(source('mcp/tools.ts'))).toContain(
      'if (isMeshMemoryError(err)) return withProjectNotes(failure(`${name} failed: ${err.message}`, { code: err.code }), notes);',
    );
    expect(source('mcp/eval-cache.ts')).toContain('if (refused) throw new MeshMemoryError(refused);');
    expect(flat(guide)).toContain(
      '`get_scene`, `get_object`, `get_mesh_data` and `get_instances` fail with it when the server has no room to evaluate a scene of many objects ("not evaluated on the server: …").',
    );
    const over = storedMeshesMessage(
      {
        operator: 'mesh.primitive_cube_add',
        estimate: { bytes: 1, faces: 6, objects: 1, addedStoredBytes: 1 },
        storedBytes: 700 * MB,
        saveBytes: 200 * MB,
        objects: 5,
      } as never,
      2096 * MB,
    );
    const dottedOver = over
      .replace(/\(\d+ times what its objects, datablocks and keyframes take\)/, '(…)')
      .replace(/\(half of its [^)]*\)/, '(…)')
      .replace(/[\d,]+ (MB|objects)/g, '… $1');
    expect(dottedOver).toBe(
      "not run on the server: the project's meshes and objects already take about … MB of JavaScript heap with … objects, and a save of it about … MB more for a moment (…): … MB in all, more than the … MB the server's process keeps for one project (…), and this operator would add to them. Delete objects and meshes the project no longer needs",
    );
    expect(row(mcp, '`mesh.subdivide failed: not run on the server:')).toContain(
      `\`… ${dottedOver.slice('not run on the server: '.length)}\``,
    );
    expect(flat(guide)).toContain('or "… already take about … MB …" when it needs more already');
    expect(flat(guide)).toContain('counting what a save of it takes for a moment');
  });

  /*
   * A project argument takes the exact name, and a name in another letter case when no project has
   * the exact one (agent.ts matching); the argument's description said "exact project name".
   */
  it('say that a project argument also takes a name in another letter case', () => {
    expect(source('mcp/tools.ts')).toContain(
      "'Project id or name (see list_projects): the exact name, or, when no project has it, the name in another letter case'",
    );
    expect(source('mcp/tools.ts')).not.toContain('exact project name');
    expect(source('mcp/agent.ts')).toContain(
      'return exact.length > 0 ? exact : projects.filter((p) => p.name.toLowerCase() === name.toLowerCase());',
    );
  });
});
