/*
 * The parameters of a video export: core's (export/params.ts), one schema for the MCP tool
 * export_video, the REST body of POST /api/projects/:id/video-exports and the browser export of the
 * web app, and what only the server's job API adds (how long a status request may wait).
 */

export {
  EXPORT_PRESETS,
  EXPORT_PRESET_ALIASES,
  EXPORT_PRESET_NAMES,
  EXPORT_PRESET_PARAMS,
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_WIDTH,
  PASS_NAMES,
  REFERENCE_PASSES,
  exportPresetOf,
  exportSize,
  exportVideoArgsShape,
  qualityPreset,
  videoExportParamsSchema,
  videoExportParamsShape,
  withExportPreset,
  type ExportPreset,
  type ExportQuality,
  type QualityPreset,
  type VideoExportInput,
  type VideoExportParams,
} from '@3d-editor/core';

/**
 * Longest wait of a status request for an export to finish or move on (export_status `wait_s`,
 * REST `?wait=`): under the 60 s request timeout of MCP SDK clients.
 */
export const MAX_EXPORT_WAIT_S = 50;
