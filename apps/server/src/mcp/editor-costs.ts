/*
 * What a browser editor without GPU acceleration costs, for the texts that tell agents about it
 * (editor_command's errors and descriptions, the server instructions, the Shading group of
 * list_operators). Measured in headless Chromium with software WebGL (SwiftShader) on
 * examples/domino-cascade (81 objects, 71 materials) with 1280×720 screenshots: docs/mcp.md has the
 * measurements, and editorTimeoutMessage (editor-commands.ts) what they mean. The times vary with
 * the machine's load.
 */

/**
 * From a material edit that needs a shader no material had (coat or sheen turned on, a procedural
 * texture on a set of channels that no other material has) until the viewport in MATERIAL or
 * RENDERED shading had drawn it, or the next screenshot in such a shading had: it compiles the shader.
 */
export const NEW_SHADER_SECONDS = '0.9–3.6 s';

/** A SOLID screenshot of a scene with 4 million triangles (the viewport in SOLID shading). */
export const MILLIONS_SOLID_SECONDS = '5.5–8.9 s';
