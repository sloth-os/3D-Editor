import {
  isExportError,
  planExport as planExportOf,
  type ExportPlan,
  type SceneDoc,
  type VideoExportParams,
} from '@3d-editor/core';
import { NotFoundError, ToolError } from '../mcp/agent';

/*
 * What a video export renders (core export/plan.ts: the shots in cut order or a frame range, their
 * cameras, frames and places in the output, rates and match_model_duration), with core's planning
 * errors as the server's tool errors of the same codes.
 */

export { MAX_EXPORT_FRAMES, sceneFrameAt, slugify, type ExportPlan, type PlannedShot } from '@3d-editor/core';

/** An error of core's export planning as the server's tool error with the same code; other errors as they are. */
export function exportToolError(err: unknown): unknown {
  if (!isExportError(err)) return err;
  return err.code === 'NOT_FOUND' ? new NotFoundError(err.message) : new ToolError(err.message, err.code);
}

/**
 * The plan of an export of `doc` (a snapshot) with these parameters. Throws a ToolError
 * (INVALID_PARAMS / NOT_FOUND) for shots or cameras that do not exist, and for exports that are too
 * long.
 */
export function planExport(doc: SceneDoc, params: VideoExportParams): ExportPlan {
  try {
    return planExportOf(doc, params);
  } catch (err) {
    throw exportToolError(err);
  }
}
