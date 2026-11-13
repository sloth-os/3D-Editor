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
    .describe('draft: fast, sun shadows only; standard: all shadows and ambient occlusion; high: finest'),
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
