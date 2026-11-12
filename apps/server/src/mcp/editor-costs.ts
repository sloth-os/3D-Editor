/*
 * What a browser editor without GPU acceleration costs, and what grey clay rendered on the server
 * costs, for the texts that tell agents about them (editor_command's errors and descriptions, the
 * server instructions, the render_image texts, the Shading group of list_operators). Measured on a
 * machine with 4 CPUs: in headless Chromium with software WebGL (SwiftShader) on
 * examples/domino-cascade (81 objects, 71 materials) and on projects of 2 and 4 million triangles,
 * with 1280×720 screenshots, and server renders through MCP. The calm runs (each started once the
 * CPUs had been at least 90 % idle for 5 s; runs that other processes disturbed are left out) of
 * nine agents on the code of rounds 9 and 10 are pooled: TEXTS round 9 (4 passes) and its two
 * verifiers, TEXTS round 10, its three verifiers and its second and third fix rounds. Every range
 * runs from {@link MARGIN_PERCENT} % less than the shortest to as much more than the longest time
 * of all the runs, rounded outward (to 0.1 s, from 10 s on to 1 s), except that the ranges of a
 * select and a SOLID screenshot with 4 million triangles run to {@link MILLIONS_MARGIN_PERCENT} %
 * more than their longest time: made with {@link MARGIN_PERCENT} % from the runs of fewer agents,
 * they missed later agents' runs (docs/mcp.md, Live editors, says by how much). A range made that
 * way from all but one agent's runs held all the runs of the agent left out. The times of the scene
 * with 4 million triangles ({@link MILLIONS_SOLID_SECONDS}, the last part of {@link
 * BROWSER_RASTER_SECONDS}, the first WIREFRAME screenshot in docs/mcp.md) pool round 10's runs
 * only: on round 9's code the editor's statistics overlay (apps/web Viewport.tsx InfoOverlay)
 * counted the edges of every mesh each time it was updated, also after every slow frame (core
 * meshStats of that scene took 4.4–4.7 s in Node on round 9's code, 0.15–0.38 s on round 10's),
 * which held those steps up by seconds: measured the same way in round 10, round 9's code took
 * about 4 s for a SOLID screenshot and about 3 s for a select, round 10's about 1 s and 0.2 s. A
 * select there ({@link MILLIONS_SELECT_SECONDS}) pools the 40 calm runs of round 13's LAST agent
 * only (2026-11-12): until round 12 the overlay still counted every mesh, edges too, each time it
 * was drawn, also when the frame rate it shows changed, and a select waited for that (0.18–0.31 s
 * in that agent's runs of round 12's code, up to 1.12 s right after a screenshot); since round 13
 * it counts a mesh once, when the mesh changes, without its edges (apps/web session.ts meshCounts),
 * and draws the frame rate apart (Viewport.tsx FrameRate). A SOLID screenshot there pools
 * screenshots sent at once after a select had answered, which wait for the frame the viewport draws
 * then, and a select selects sent at once after a SOLID screenshot had answered. docs/mcp.md (Live
 * editors) has the ranges, how they were made, and what was measured; the editorTimeoutMessage doc
 * comment (editor-commands.ts) what they mean. On the same machine kept busy by other processes
 * (four CPU-bound processes and other work, 1-minute load averages of {@link BUSY_LOADS}), the same
 * steps took longer: a browser editor's RASTER images most, so the texts give two factors over the
 * upper end of the ranges ({@link BUSY_FACTOR}, {@link BROWSER_BUSY_FACTOR}), and every text that
 * gives a time says how it was made and how much longer it took on a busy machine ({@link
 * measured}, {@link measuredBrowserImages}, {@link measuredOnServer}, {@link measuredNote}).
 */

/** How much the ranges are widened on each side beyond the shortest and longest calm time (%). */
export const MARGIN_PERCENT = '25';

/**
 * How much more than their longest calm time the ranges of a select and a SOLID screenshot with 4
 * million triangles run to (%): made with {@link MARGIN_PERCENT} % from the runs of fewer agents,
 * these ranges missed later agents' runs of them (requests sent as soon as the one before had
 * answered). The lower end of a SOLID screenshot's uses {@link MARGIN_PERCENT} %; a select's range
 * is given as "at most", its lower end rounding to 0.
 */
export const MILLIONS_MARGIN_PERCENT = '50';

/**
 * How many times as long screenshots, other editor commands and server renders took at most on a
 * busy machine (see the header) as the upper end of their range, widened by {@link MARGIN_PERCENT} %
 * and rounded up to 0.5 (docs/mcp.md says the largest ratio measured).
 */
export const BUSY_FACTOR = '3.5';

/**
 * The same for a browser editor's RASTER images (render_image renderer 'browser'): an image right
 * after one that timed out (which it waited for) is left out.
 */
export const BROWSER_BUSY_FACTOR = '5.5';

/** The 1-minute load averages during the busy runs (4 CPUs, see the header). */
export const BUSY_LOADS = '3–15';

/**
 * The first MATERIAL or RENDERED screenshot or viewport frame after the editor opened
 * examples/domino-cascade: it builds and compiles the 71 materials for that shading (with the
 * viewport multisampled: in SOLID, or switched to that shading).
 */
export const FIRST_SHADING_SECONDS = '13–38 s';

/**
 * Later MATERIAL or RENDERED screenshots, in a shading the editor had drawn: with the viewport in
 * any shading, after it turned its multisampling off (a million triangles more, a large viewport),
 * after X-ray toggles and after edits of material values; they compile nothing.
 */
export const LATER_SECONDS = '0.3–3.9 s';

/** SOLID and WIREFRAME screenshots of examples/domino-cascade, the viewport in any shading. */
export const FAST_SECONDS = '0.4–1.7 s';

/**
 * From a material edit that needs a shader no material had (coat or sheen turned on, a procedural
 * texture on a set of channels that no other material has) until the viewport in MATERIAL or
 * RENDERED shading had drawn it, or the next screenshot in such a shading had: it compiles the
 * shader, which takes longest for a material with several procedural textures (sheen turned on for
 * the table's Wood, whose colour, roughness and bump are BRICK and WAVE textures, and the dowels'
 * Beech, WOOD on colour and bump; the plastics, the floor's Parquet (BRICK on its colour) and Wood
 * Dark took the shorter range).
 */
export const NEW_SHADER_SECONDS = '0.6–4.2 s, or up to 18 s for a material with several procedural textures';

/**
 * A SOLID screenshot of a scene with 4 million triangles, the viewport in SOLID shading (without
 * multisampling, which the viewport turns off for more than a million triangles, and so the
 * screenshot), also one sent as soon as a select had answered: it waits for the frame the viewport
 * draws then, after the selection changed. The upper end is {@link MILLIONS_MARGIN_PERCENT} % above
 * the longest time.
 */
export const MILLIONS_SOLID_SECONDS = '0.5–5.3 s';

/**
 * A select (editor_command) in that scene, the viewport in SOLID shading: the editor carries it out
 * once its main thread is free (after a screenshot it is drawing; the viewport's frames do not hold it
 * up, apart from the first ones that build materials or wires), also one sent as soon as a SOLID
 * screenshot had answered. The upper end is {@link MILLIONS_MARGIN_PERCENT} % above the longest
 * time (0.024 s), rounded up to 0.1 s; the header says which runs.
 */
export const MILLIONS_SELECT_SECONDS = 'at most 0.1 s';

/**
 * Grey clay rendered on the server (render_image with shading 'SOLID' rendered by the server's
 * software rasterizer, 1280×720) in a render process: the first render of a version of the
 * document sends it to the render process, which decodes it (the longer times). 2 million
 * triangles: a grid, and the quick look of a PATHTRACER scene of that grid with an idle editor; 4 or
 * 6 million: two or three grids, and a project of two grids right after a screenshot had timed out
 * while the editor still drew it.
 */
export const SERVER_SOLID_SECONDS = '1.2–7.4 s for 2 million triangles, 2.2–14 s for 4 or 6 million';

/** The same for examples/domino-cascade (20,042 triangles, 71 materials). */
export const SERVER_SOLID_SCENE_SECONDS = '1.1–4.0 s';

/**
 * A RASTER image of a browser editor in software WebGL (render_image renderer 'browser', default
 * 800 wide): its first image of examples/domino-cascade, as it built and compiled the 71
 * materials, later ones, and images of a scene of 4 million triangles (two grids of 2 million).
 */
export const BROWSER_RASTER_SECONDS =
  '17–41 s for the first image of a scene with 71 materials, as it compiled them, then 2.6–7.9 s, and 1.5–5.9 s for 4 million triangles';

/*
 * What holds up an editor's commands besides the work of the commands themselves, with 4 million
 * triangles (two grids of 1000×1000 quads, a stored document of 134 MB, disk storage): the calm runs
 * of round 11's and round 12's TEXTS agents and verifiers (2026-11-11 and 2026-11-12; the editor
 * applying an agent's move: round 13's LAST agent), the server probed with /healthz every 10 ms from a
 * process of its own, the editor's main thread with its long tasks. Each range is made as above
 * ({@link MARGIN_PERCENT}); docs/mcp.md (Live editors) has the measured values.
 */

/**
 * The editor's main thread while it applies a change made elsewhere: another agent's move of one of
 * the grids, the viewport in SOLID shading. In the 16 calm runs of round 13's LAST agent
 * (2026-11-12) it made no long task (one of 50 ms or more, the shortest the browser reports) within
 * 3 s of the change: under 0.05 s, widened by {@link MARGIN_PERCENT} % and rounded up to 0.1 s. On
 * round 12's code its long task right after the change took 0.17–0.25 s (round 12's TEXTS agents),
 * most of it the statistics overlay counting every mesh again (a CPU profile of round 13's runs of
 * that code sampled 0.14–0.36 s in its counting functions within 3 s of each move).
 */
export const CHANGE_APPLY_SECONDS = 'at most 0.1 s';

/**
 * The server holds up every request while it saves a project after a change (Room.save: it reads the
 * stored project, merges it into the open one, encodes the project, compares the two and writes it).
 */
export const SAVE_HOLD_SECONDS = '0.3–0.9 s';

/**
 * Right after a save the server holds up every request twice more, while it takes a fingerprint of
 * the document it wrote (Room.guarded and Room.save storedPrint, to tell the room's own state from
 * other writers'): at most this long each.
 */
export const AFTER_SAVE_HOLD_SECONDS = '0.2 s';

/**
 * The server holds up every request while it reads back from storage a project that an editor has
 * open (once a minute) and while it sends a project to an editor that opens it.
 */
export const READ_HOLD_SECONDS = '0.2–1.9 s';

/** How the ranges were made, after a time: see the header. */
const MADE = `the range widened by ${MARGIN_PERCENT} %`;

/**
 * A measured time as a text gives it inline: on a calm machine, and how much longer on a busy one
 * (`factor`: {@link BUSY_FACTOR}, or {@link BROWSER_BUSY_FACTOR} for a browser editor's RASTER images).
 */
export function measured(time: string, factor: string = BUSY_FACTOR): string {
  return `${time}, measured on a calm machine with 4 CPUs in software WebGL (${MADE}), up to ${factor} times as long on a busy one`;
}

/** A measured time of a browser editor's RASTER images (render_image renderer 'browser', see {@link measured}). */
export function measuredBrowserImages(time: string): string {
  return measured(time, BROWSER_BUSY_FACTOR);
}

/** A measured time of a server render as a text gives it inline (see {@link measured}). */
export function measuredOnServer(time: string): string {
  return `${time}, measured on a calm server with 4 CPUs (${MADE}), up to ${BUSY_FACTOR} times as long on a busy one`;
}

/**
 * The sentence after the measured times of a text of several sentences (editorTimeoutMessage).
 * `millions`: the step with 4 million triangles whose time the text gives, if any (a select:
 * {@link MILLIONS_SELECT_SECONDS}, a SOLID screenshot: {@link MILLIONS_SOLID_SECONDS}), whose range
 * runs to {@link MILLIONS_MARGIN_PERCENT} % more than its longest time; a text names only its own
 * step (a select's timeout says nothing of screenshots).
 */
export function measuredNote(millions?: 'select' | 'SOLID screenshot'): string {
  return (
    `The times given are the ranges measured on a calm machine with 4 CPUs, the editor in software WebGL, widened by ${MARGIN_PERCENT} %` +
    (millions ? ` (the longest ${millions} with 4 million triangles by ${MILLIONS_MARGIN_PERCENT} %)` : '') +
    `; on a busy one (load averages of ${BUSY_LOADS}) the same steps took up to ${BUSY_FACTOR} times as long.`
  );
}
