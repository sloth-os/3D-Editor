import { z } from 'zod';
import type { PassName } from './protocol';
import { strictArgObject } from './strict';

/*
 * The parameters of a video export: one schema for the server's MCP tool export_video (its
 * arguments besides `project`), the REST body of POST /api/projects/:id/video-exports and the
 * browser export of the web app (apps/web/src/export). A preset sets the parameters a known use
 * needs where the call leaves them out: 'reference', the reference clips a video model takes (see
 * EXPORT_PRESET_PARAMS); 'rideo' is that preset's former name, still accepted (it becomes
 * 'reference').
 */

/** The image passes an export can write (protocol.ts PassName). */
export const PASS_NAMES = [
  'beauty',
  'depth',
  'normal',
  'mask',
  'edges',
  'pose',
] as const satisfies readonly PassName[];

/** Largest export frame (pixels). */
export const MAX_EXPORT_WIDTH = 3840;
export const MAX_EXPORT_HEIGHT = 2160;

/** Presets of an export (`preset`). */
export const EXPORT_PRESETS = ['reference'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

/**
 * Former names of presets, still accepted and replaced by the preset's name when the parameters
 * are parsed (`withExportPreset`): 'rideo' is 'reference'.
 */
export const EXPORT_PRESET_ALIASES: Readonly<Record<string, ExportPreset>> = { rideo: 'reference' };

/** Every name `preset` accepts: the presets and their former names. */
export const EXPORT_PRESET_NAMES = ['reference', 'rideo'] as const;

/**
 * The passes of preset 'reference', one per reference mode of a video model: the beauty clip in the
 * clay look (motion), the depth pass (the camera's motion through the set) and the pose pass.
 */
export const REFERENCE_PASSES = ['beauty', 'depth', 'pose'] as const satisfies readonly PassName[];

/**
 * What a preset sets where the call leaves it out (what the call gives wins; `outputs` key by key).
 * 'reference': reference clips for a video model, whichever reference mode each shot takes: draft
 * clips in the clay look with the beauty, depth and pose passes, without the sequence, posters or
 * contact sheet; its frame size is the render resolution at 100 % (plan.ts), at the scene's fps.
 */
export const EXPORT_PRESET_PARAMS = {
  reference: {
    quality: 'draft',
    look: 'clay',
    outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
    passes: REFERENCE_PASSES,
  },
} as const satisfies Record<ExportPreset, Record<string, unknown>>;

const QUALITY_TEXT =
  'draft: fastest (1 sample, shadows, no ambient occlusion, CRF 28); standard: 2 samples, shadows and ambient occlusion (CRF 23); high: 4 samples up to 1280×720, else 2 (CRF 18, slower encoding)';
const LOOK_TEXT = 'material: the scene as it is; clay: grey clay; solid: flat colours';
const PASSES_TEXT = 'Image passes, each its own video: beauty, depth, normal, mask, edges, pose';
const qualityArg = z.enum(['draft', 'standard', 'high']);
const lookArg = z.enum(['material', 'clay', 'solid']);
const passesArg = z.array(z.enum(PASS_NAMES)).min(1).max(PASS_NAMES.length);

export const videoExportParamsShape = {
  preset: z
    .enum(EXPORT_PRESET_NAMES)
    .optional()
    .describe(
      "reference: reference clips for a video model (quality draft, look clay, clips only, passes beauty, depth and pose, at the render resolution at 100 %); 'rideo' is its former name, still accepted; the parameters given win over it",
    ),
  shots: z
    .union([z.literal('all'), z.array(z.string().min(1)).min(1).max(512)])
    .optional()
    .describe(
      "Shots to export, by id or name, in cut order, or 'all' (default: every enabled shot; a scene without shots exports its frame range)",
    ),
  frame_start: z
    .number()
    .int()
    .optional()
    .describe('First scene frame (without shots; default: the scene frame_start)'),
  frame_end: z
    .number()
    .int()
    .optional()
    .describe('Last scene frame, inclusive (without shots; default: the scene frame_end)'),
  camera: z
    .string()
    .min(1)
    .optional()
    .describe('Camera object id or name when there are no shots (default: the scene camera)'),
  outputs: strictArgObject({
    sequence: z.boolean().default(true).describe('One MP4 of the whole sequence'),
    clips: z.boolean().default(true).describe('One frame-exact MP4 per shot'),
    posters: z.boolean().default(true).describe('First frame of each shot as PNG and JPEG'),
    contact_sheet: z.boolean().default(true).describe('First and middle frame of each shot, labelled'),
  })
    .optional()
    .describe('What to write (default: all of it)'),
  width: z
    .number()
    .int()
    .min(16)
    .max(MAX_EXPORT_WIDTH)
    .multipleOf(2)
    .optional()
    .describe('Width in pixels, even (default: the render resolution times its percentage)'),
  height: z
    .number()
    .int()
    .min(16)
    .max(MAX_EXPORT_HEIGHT)
    .multipleOf(2)
    .optional()
    .describe('Height in pixels, even (default: the render resolution times its percentage)'),
  fps: z.number().positive().max(120).optional().describe('Frames per second (default: the scene fps)'),
  quality: qualityArg.default('standard').describe(QUALITY_TEXT),
  look: lookArg.default('material').describe(LOOK_TEXT),
  passes: passesArg.default(['beauty']).describe(PASSES_TEXT),
  codec: z.enum(['h264', 'vp9']).default('h264').describe('Video codec (h264: MP4, vp9: WebM)'),
  match_model_duration: z
    .boolean()
    .default(false)
    .describe("Pad or trim each clip to the video model's duration limits (the scene's desk settings)"),
  label: z.string().max(200).optional().describe('A name for the export'),
};

/**
 * export_video's arguments besides `project`: the parameters, without the defaults a preset sets
 * (quality, look, passes), so that the export can tell what the call left out: the export fills
 * them in (the server parses its parameters with videoExportParamsSchema).
 */
export const exportVideoArgsShape = {
  ...videoExportParamsShape,
  quality: qualityArg.optional().describe(`${QUALITY_TEXT}. Default: standard (preset reference: draft)`),
  look: lookArg.optional().describe(`${LOOK_TEXT}. Default: material (preset reference: clay)`),
  passes: passesArg
    .optional()
    .describe(`${PASSES_TEXT}. Default: beauty (preset reference: beauty, depth and pose)`),
};

/** The preset a `preset` value names (a former name gives its preset), or null. */
export function exportPresetOf(name: unknown): ExportPreset | null {
  if (typeof name !== 'string') return null;
  if ((EXPORT_PRESETS as readonly string[]).includes(name)) return name as ExportPreset;
  return Object.hasOwn(EXPORT_PRESET_ALIASES, name) ? EXPORT_PRESET_ALIASES[name] : null;
}

/**
 * The parameters with what their preset sets where they leave it out (`outputs` key by key), a
 * former preset name replaced by the preset's; other input (no preset, an unknown one, not an
 * object) as it is, for the schema to judge.
 */
export function withExportPreset(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const given = input as Record<string, unknown>;
  const name = exportPresetOf(given.preset);
  if (!name) return input;
  const preset: Record<string, unknown> = EXPORT_PRESET_PARAMS[name];
  const out: Record<string, unknown> = { ...given, preset: name };
  for (const [key, value] of Object.entries(preset)) {
    const own = given[key];
    if (key === 'outputs' && own && typeof own === 'object' && !Array.isArray(own))
      out[key] = { ...(value as object), ...own };
    else if (own === undefined) out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

const videoExportParamsObject = strictArgObject(videoExportParamsShape);

/** Parameters as a caller gives them (defaults and preset not applied yet). */
export type VideoExportInput = z.input<typeof videoExportParamsObject>;

/**
 * Parsed parameters: defaults filled in, the preset applied and named by its current name
 * (`withExportPreset` replaces a former name before the object is checked).
 */
export type VideoExportParams = Omit<z.output<typeof videoExportParamsObject>, 'preset'> & {
  preset?: ExportPreset;
};

/**
 * The parameters of an export (the REST body of POST /api/projects/:id/video-exports, closed like
 * the tool's arguments; what the server's VideoExports.start and the browser export check), its
 * preset applied first. Typed with the preset's current name: the preprocessing step replaces a
 * former one before the object is validated, so no other value comes out.
 */
export const videoExportParamsSchema = z.preprocess(
  withExportPreset,
  videoExportParamsObject,
) as unknown as z.ZodType<VideoExportParams, unknown>;

export type ExportQuality = VideoExportParams['quality'];

/** What each quality renders (SPEC §9); the server's encoding: ffmpeg.ts QUALITY_ENCODING. */
export interface QualityPreset {
  /** RASTER anti-aliasing samples per axis. */
  samples: number;
  shadows: boolean;
  ao: boolean;
  msaa: boolean;
}

/**
 * The render settings of a quality: draft 1 sample, shadows, no ambient occlusion; standard 2
 * samples, shadows and ambient occlusion; high like standard with 4 samples at 1280×720 and below.
 * Every quality shades once per pixel and triangle (MSAA style), which the renderer does at about
 * the cost of one sample. (The renderer's shadow option covers sun and spot lights alike, so draft
 * keeps the spot lights' shadows too.)
 */
export function qualityPreset(quality: ExportQuality, width: number, height: number): QualityPreset {
  if (quality === 'draft') return { samples: 1, shadows: true, ao: false, msaa: true };
  if (quality === 'high')
    return { samples: width * height <= 1280 * 720 ? 4 : 2, shadows: true, ao: true, msaa: true };
  return { samples: 2, shadows: true, ao: true, msaa: true };
}

/** Rounds to the nearest even number of at least 2. */
function even(n: number): number {
  return Math.max(2, 2 * Math.round(n / 2));
}

/**
 * The export's frame size: the given width and height, else the render resolution times its
 * percentage; one of them alone keeps the render aspect. Even, and at most 3840×2160 (larger
 * sizes are scaled down keeping the aspect).
 */
export function exportSize(
  render: { resolution_x: number; resolution_y: number; resolution_percentage: number },
  width?: number,
  height?: number,
): { width: number; height: number } {
  const pct = Math.max(1, render.resolution_percentage || 100) / 100;
  const rx = Math.max(1, render.resolution_x || 1920) * pct;
  const ry = Math.max(1, render.resolution_y || 1080) * pct;
  let w = width ?? (height !== undefined ? (height * rx) / ry : rx);
  let h = height ?? (width !== undefined ? (width * ry) / rx : ry);
  const scale = Math.min(1, MAX_EXPORT_WIDTH / w, MAX_EXPORT_HEIGHT / h);
  w *= scale;
  h *= scale;
  return {
    width: Math.min(MAX_EXPORT_WIDTH, even(w)),
    height: Math.min(MAX_EXPORT_HEIGHT, even(h)),
  };
}
