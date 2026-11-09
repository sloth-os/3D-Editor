/*
 * What a browser editor without GPU acceleration costs, and what grey clay rendered on the server
 * costs, for the texts that tell agents about them (editor_command's errors and descriptions, the
 * server instructions, the render_image texts, the Shading group of list_operators). Measured on a
 * machine with 4 CPUs and no other work (each run started once the CPUs had been at least 90 % idle
 * for 5 s): in headless Chromium with software WebGL (SwiftShader) on examples/domino-cascade (81
 * objects, 71 materials) and on projects of 2 and 4 million triangles, with 1280×720 screenshots,
 * and server renders through MCP. docs/mcp.md has the measurements, and editorTimeoutMessage
 * (editor-commands.ts) what they mean. On the same machine kept busy by other processes (1-minute
 * load averages of {@link BUSY_LOADS}) the same steps took up to {@link BUSY_FACTOR} times as long
 * as the upper end of their range on the calm one, so every text that gives a time says that it
 * was measured on a calm machine and how much longer it took on a busy one ({@link measured},
 * {@link measuredOnServer}, {@link MEASURED_NOTE}).
 */

/**
 * How many times as long the measured steps took at most on a busy machine (see the header) as the
 * upper end of their range on a calm one.
 */
export const BUSY_FACTOR = '4.6';

/** The 1-minute load averages during the busy runs (4 CPUs, see the header). */
export const BUSY_LOADS = '6–20';

/**
 * From a material edit that needs a shader no material had (coat or sheen turned on, a procedural
 * texture on a set of channels that no other material has) until the viewport in MATERIAL or
 * RENDERED shading had drawn it, or the next screenshot in such a shading had: it compiles the
 * shader, which takes longest for a material with several procedural textures (sheen turned on
 * for the table's Wood, whose colour, roughness and bump are BRICK and WAVE textures; the plastics
 * have none).
 */
export const NEW_SHADER_SECONDS =
  '0.9–3.1 s, or up to 11.7 s for a material with several procedural textures';

/**
 * A SOLID screenshot of a scene with 4 million triangles, the viewport in SOLID shading (without
 * multisampling, which the viewport turns off for more than a million triangles, and so the
 * screenshot).
 */
export const MILLIONS_SOLID_SECONDS = '3.4–4.4 s';

/**
 * A select (editor_command) in that scene: it waits for the viewport's frame, which took seconds
 * with 4 million triangles in SOLID shading.
 */
export const MILLIONS_SELECT_SECONDS = '2.6–3.6 s';

/**
 * Grey clay rendered on the server (render_image with shading 'SOLID' rendered by the server's
 * software rasterizer, 1280×720) in a render process: the first render of a version of the
 * document sends it to the render process, which decodes it (the longer times); grids of 1, 2 or 3
 * times 2 million triangles, and the projects of an editor: 4 million triangles right after a
 * screenshot had timed out while the editor still drew it, 2 million as the quick look of a
 * PATHTRACER scene. A render process held up to 3.2 GB of memory for 6 million triangles.
 */
export const SERVER_SOLID_SECONDS = '1.7–6.0 s for 2 million triangles, 3.0–9.8 s for 4 or 6 million';

/**
 * A RASTER image of a browser editor in software WebGL (render_image renderer 'browser', default
 * 800 wide): its first image of examples/domino-cascade, as it built and compiled the 71
 * materials, later ones, and images of a scene of 4 million triangles (two grids of 2 million).
 */
export const BROWSER_RASTER_SECONDS =
  '22.8–23.3 s for the first image of a scene with 71 materials, as it compiled them, then 3.5–4.1 s, and 2.1–8.1 s for 4 million triangles';

/** A measured time as a text gives it inline: on a calm machine, and how much longer on a busy one. */
export function measured(time: string): string {
  return `${time}, measured on a calm machine with 4 CPUs in software WebGL, up to ${BUSY_FACTOR} times as long on a busy one`;
}

/** A measured time of a server render as a text gives it inline (see {@link measured}). */
export function measuredOnServer(time: string): string {
  return `${time}, measured on a calm server with 4 CPUs, up to ${BUSY_FACTOR} times as long on a busy one`;
}

/** The sentence after the measured times of a text of several sentences (editorTimeoutMessage). */
export const MEASURED_NOTE =
  'The times given were measured on a calm machine with 4 CPUs, the editor in software WebGL; on a busy ' +
  `one (load averages of ${BUSY_LOADS}) they took up to ${BUSY_FACTOR} times as long.`;
