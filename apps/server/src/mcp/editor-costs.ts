/*
 * What a browser editor without GPU acceleration costs, for the texts that tell agents about it
 * (editor_command's errors and descriptions, the server instructions, the Shading group of
 * list_operators). Measured in headless Chromium with software WebGL (SwiftShader) on
 * examples/domino-cascade (81 objects, 71 materials) with 1280×720 screenshots: docs/mcp.md has the
 * measurements, and editorTimeoutMessage (editor-commands.ts) what they mean. The times vary with
 * the machine's load, so every text that gives one says that, and that it was measured in software
 * WebGL ({@link measured}, {@link MEASURED_NOTE}).
 */

/**
 * From a material edit that needs a shader no material had (coat or sheen turned on, a procedural
 * texture on a set of channels that no other material has) until the viewport in MATERIAL or
 * RENDERED shading had drawn it, or the next screenshot in such a shading had: it compiles the
 * shader, which takes longest for a material with several procedural textures (sheen turned on
 * for the table's Wood, whose colour, roughness and bump are BRICK and WAVE textures; the plastics
 * have none).
 */
export const NEW_SHADER_SECONDS =
  '0.6–4.5 s, or up to 12.9 s for a material with several procedural textures';

/**
 * A SOLID screenshot of a scene with 4 million triangles, the viewport in SOLID shading (without
 * multisampling, which the viewport turns off for more than a million triangles, and so the
 * screenshot).
 */
export const MILLIONS_SOLID_SECONDS = '3.3–5.2 s';

/** A measured time as a text gives it inline: that it was measured in software WebGL and varies. */
export function measured(time: string): string {
  return `${time}, measured in software WebGL and varying with the machine's load`;
}

/** The sentence after the measured times of a text of several sentences (editorTimeoutMessage). */
export const MEASURED_NOTE =
  "The times given were measured in software WebGL and vary with the machine's load.";
