import { z } from 'zod';
import { strictArgObject } from '../mcp/strict-args';
import type { PassName } from '../render/protocol';

/*
 * The parameters of a video export: one schema for the MCP tool export_video (its arguments
 * besides `project`) and the REST body of POST /api/projects/:id/video-exports. A preset sets the
 * parameters a known consumer needs where the call leaves them out: 'rideo', the clips rideo_push
 * sends (see EXPORT_PRESET_PARAMS).
 */

/** The image passes an export can write (render/protocol.ts PassName). */
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

/**
 * Longest wait of a status request for an export to finish or move on (export_status `wait_s`,
 * REST `?wait=`): under the 60 s request timeout of MCP SDK clients.
 */
export const MAX_EXPORT_WAIT_S = 50;

/** Presets of an export (`preset`). */
export const EXPORT_PRESETS = ['rideo'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

/**
 * The passes rideo_push sends, one per reference mode (rideo/shots.ts DEFAULT_PASS): motion the
 * beauty clip (in the clay look), pose the pose pass, camera the depth pass.
 */
export const RIDEO_PASSES = ['beauty', 'depth', 'pose'] as const satisfies readonly PassName[];

/**
 * What a preset sets where the call leaves it out (what the call gives wins; `outputs` key by key).
 * 'rideo': what rideo_push needs whatever mode each shot's reference takes: draft clips in the clay
 * look with the beauty, depth and pose passes, without the sequence, posters or contact sheet; its
 * frame size is the render resolution at 100 % (plan.ts), which rideo_import sets to rideo's, at the
 * scene's fps (rideo's too).
 */
export const EXPORT_PRESET_PARAMS = {
  rideo: {
    quality: 'draft',
    look: 'clay',
    outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
    passes: RIDEO_PASSES,
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
    .enum(EXPORT_PRESETS)
    .optional()
    .describe(
      "rideo: the clips rideo_push sends (quality draft, look clay, clips only, passes beauty, depth and pose, at the render resolution at 100 %, which rideo_import sets to rideo's); the parameters given win over it",
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
 * them in (VideoExports.start parses its parameters with videoExportParamsSchema).
 */
export const exportVideoArgsShape = {
  ...videoExportParamsShape,
  quality: qualityArg.optional().describe(`${QUALITY_TEXT}. Default: standard (preset rideo: draft)`),
  look: lookArg.optional().describe(`${LOOK_TEXT}. Default: material (preset rideo: clay)`),
  passes: passesArg
    .optional()
    .describe(`${PASSES_TEXT}. Default: beauty (preset rideo: beauty, depth and pose)`),
};

/**
 * The parameters with what their preset sets where they leave it out (`outputs` key by key); other
 * input (no preset, an unknown one, not an object) as it is, for the schema to judge.
 */
export function withExportPreset(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const given = input as Record<string, unknown>;
  const name = given.preset;
  if (typeof name !== 'string' || !Object.hasOwn(EXPORT_PRESET_PARAMS, name)) return input;
  const preset: Record<string, unknown> = EXPORT_PRESET_PARAMS[name as ExportPreset];
  const out: Record<string, unknown> = { ...given };
  for (const [key, value] of Object.entries(preset)) {
    const own = given[key];
    if (key === 'outputs' && own && typeof own === 'object' && !Array.isArray(own))
      out[key] = { ...(value as object), ...own };
    else if (own === undefined) out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

const videoExportParamsObject = strictArgObject(videoExportParamsShape);

/**
 * The parameters of an export (the REST body of POST /api/projects/:id/video-exports, closed like
 * the tool's arguments; what VideoExports.start checks), its preset applied first.
 */
export const videoExportParamsSchema = z.preprocess(withExportPreset, videoExportParamsObject);

export type VideoExportParams = z.output<typeof videoExportParamsObject>;
/** Parameters as a caller gives them (defaults and preset not applied yet). */
export type VideoExportInput = z.input<typeof videoExportParamsObject>;

export type ExportQuality = VideoExportParams['quality'];

/** What each quality renders (SPEC §9); encoding: ffmpeg.ts QUALITY_ENCODING. */
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
