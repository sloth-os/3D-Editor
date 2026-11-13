import { z } from 'zod';
import { strictArgObject } from '../mcp/strict-args';
import type { PassName } from '../render/protocol';

/*
 * The parameters of a video export: one schema for the MCP tool export_video (its arguments
 * besides `project`) and the REST body of POST /api/projects/:id/video-exports.
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

export const videoExportParamsShape = {
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
  quality: z
    .enum(['draft', 'standard', 'high'])
    .default('standard')
    .describe(
      'draft: fastest (1 sample, shadows, no ambient occlusion, CRF 28); standard: 2 samples, shadows and ambient occlusion (CRF 23); high: 4 samples up to 1280×720, else 2 (CRF 18, slower encoding)',
    ),
  look: z
    .enum(['material', 'clay', 'solid'])
    .default('material')
    .describe('material: the scene as it is; clay: grey clay; solid: flat colours'),
  passes: z
    .array(z.enum(PASS_NAMES))
    .min(1)
    .max(PASS_NAMES.length)
    .default(['beauty'])
    .describe('Image passes, each its own video: beauty, depth, normal, mask, edges, pose'),
  codec: z.enum(['h264', 'vp9']).default('h264').describe('Video codec (h264: MP4, vp9: WebM)'),
  match_model_duration: z
    .boolean()
    .default(false)
    .describe("Pad or trim each clip to the video model's duration limits (the scene's desk settings)"),
  label: z.string().max(200).optional().describe('A name for the export'),
};

/** The REST body of POST /api/projects/:id/video-exports (closed like the tool's arguments). */
export const videoExportParamsSchema = strictArgObject(videoExportParamsShape);

export type VideoExportParams = z.output<typeof videoExportParamsSchema>;

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
