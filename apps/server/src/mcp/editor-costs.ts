/*
 * What a browser editor without GPU acceleration costs, and what grey clay rendered on the server
 * costs, for the texts that tell agents about them (editor_command's errors and descriptions, the
 * server instructions, the render_image texts, the Shading group of list_operators). Measured on a
 * machine with 4 CPUs: in headless Chromium with software WebGL (SwiftShader) on
 * examples/domino-cascade (81 objects, 71 materials) and on projects of 2 and 4 million triangles,
 * with 1280×720 screenshots, and server renders through MCP. The calm runs (each started once the
 * CPUs had been at least 90 % idle for 5 s; runs that other processes disturbed are left out) of
 * four agents on the code of rounds 9 and 10 are pooled: TEXTS round 9 (4 passes), its two
 * verifiers and TEXTS round 10. A range made from all but one agent's runs missed the runs of the
 * one left out by up to 24 %, so every range runs from {@link MARGIN_PERCENT} % less than the
 * shortest to as much more than the longest time of all the runs, rounded outward (to 0.1 s, from
 * 10 s on to 1 s). The times of the scene with 4 million triangles ({@link MILLIONS_SOLID_SECONDS},
 * {@link MILLIONS_SELECT_SECONDS}, the last part of {@link BROWSER_RASTER_SECONDS}, the first
 * WIREFRAME screenshot in docs/mcp.md) pool the runs of TEXTS round 10 only: on round 9's code the
 * editor's statistics overlay (apps/web Viewport.tsx InfoOverlay) counted the edges of every mesh
 * each time it was updated, also after every slow frame (core meshStats of that scene took
 * 4.4–4.7 s in Node on round 9's code, 0.15–0.38 s on round 10's), which held those steps up by
 * seconds: measured the same way in round 10, round 9's code took about 4 s for a SOLID screenshot
 * and about 3 s for a select, round 10's about 1 s and 0.2 s; a range made the same way from all
 * but one of round 10's runs held the run left out. docs/mcp.md (Live editors) has the ranges, how
 * they were made, and what was measured; the editorTimeoutMessage doc comment (editor-commands.ts)
 * what they mean. On the same machine kept busy by other processes (1-minute load averages of
 * {@link BUSY_LOADS}) the same steps took up to {@link BUSY_FACTOR} times as long as the upper end
 * of their range, so every text that gives a time says how it was made and how much longer it took
 * on a busy machine ({@link measured}, {@link measuredOnServer}, {@link MEASURED_NOTE}).
 */

/** How much the ranges are widened on each side beyond the shortest and longest calm time (%). */
export const MARGIN_PERCENT = '25';

/**
 * How many times as long the measured steps took at most on a busy machine (see the header) as the
 * upper end of their range; a browser image right after one that timed out (which it waited for) is
 * left out.
 */
export const BUSY_FACTOR = '3.5';

/** The 1-minute load averages during the busy runs (4 CPUs, see the header). */
export const BUSY_LOADS = '4–15';

/**
 * The first MATERIAL or RENDERED screenshot or viewport frame after the editor opened
 * examples/domino-cascade: it builds and compiles the 71 materials for that shading (with the
 * viewport multisampled: in SOLID, or switched to that shading).
 */
export const FIRST_SHADING_SECONDS = '13–33 s';

/**
 * Later MATERIAL or RENDERED screenshots, in a shading the editor had drawn: with the viewport in
 * any shading, after it turned its multisampling off (a million triangles more, a large viewport),
 * after X-ray toggles and after edits of material values; they compile nothing.
 */
export const LATER_SECONDS = '0.3–3.9 s';

/** SOLID and WIREFRAME screenshots of examples/domino-cascade, the viewport in any shading. */
export const FAST_SECONDS = '0.4–1.5 s';

/**
 * From a material edit that needs a shader no material had (coat or sheen turned on, a procedural
 * texture on a set of channels that no other material has) until the viewport in MATERIAL or
 * RENDERED shading had drawn it, or the next screenshot in such a shading had: it compiles the
 * shader, which takes longest for a material with several procedural textures (sheen turned on for
 * the table's Wood, whose colour, roughness and bump are BRICK and WAVE textures, and the dowels'
 * Beech, WOOD on colour and bump; the plastics, the floor's Parquet (BRICK on its colour) and Wood
 * Dark took the shorter range).
 */
export const NEW_SHADER_SECONDS = '0.6–4.2 s, or up to 16 s for a material with several procedural textures';

/**
 * A SOLID screenshot of a scene with 4 million triangles, the viewport in SOLID shading (without
 * multisampling, which the viewport turns off for more than a million triangles, and so the
 * screenshot).
 */
export const MILLIONS_SOLID_SECONDS = '0.5–1.8 s';

/**
 * A select (editor_command) in that scene, the viewport in SOLID shading: the editor carries it out
 * once its main thread is free (after the frame or screenshot it is drawing).
 */
export const MILLIONS_SELECT_SECONDS = '0.1–0.5 s';

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
  '17–34 s for the first image of a scene with 71 materials, as it compiled them, then 2.6–6.7 s, and 1.5–4.7 s for 4 million triangles';

/** How the ranges were made, after a time: see the header. */
const MADE = `the range widened by ${MARGIN_PERCENT} %`;

/** A measured time as a text gives it inline: on a calm machine, and how much longer on a busy one. */
export function measured(time: string): string {
  return `${time}, measured on a calm machine with 4 CPUs in software WebGL (${MADE}), up to ${BUSY_FACTOR} times as long on a busy one`;
}

/** A measured time of a server render as a text gives it inline (see {@link measured}). */
export function measuredOnServer(time: string): string {
  return `${time}, measured on a calm server with 4 CPUs (${MADE}), up to ${BUSY_FACTOR} times as long on a busy one`;
}

/** The sentence after the measured times of a text of several sentences (editorTimeoutMessage). */
export const MEASURED_NOTE =
  `The times given are the ranges measured on a calm machine with 4 CPUs, the editor in software WebGL, widened by ${MARGIN_PERCENT} %; ` +
  `on a busy one (load averages of ${BUSY_LOADS}) the same steps took up to ${BUSY_FACTOR} times as long.`;
