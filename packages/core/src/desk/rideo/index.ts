/*
 * SceneBlocking v1 import and export (spec §11; the blocking format rideo defined, the desk's for agents
 * that hold such JSON): the blocking's schema and the import's input (schema.ts), the reading rules
 * (rules.ts, also desk/brief's), the import (import.ts, also desk/brief's staging engine), the export
 * (export.ts) and the two operators' executes (operators.ts, registered in operators/desk-shots.ts).
 */

export * from './schema';
export * from './rules';
export { HIDDEN_SCALE as RIDEO_HIDDEN_SCALE } from './keys';
export {
  LAYOUT_SPACING_M,
  RIDEO_PROPS,
  importRideoBlocking,
  layoutMarks,
  openingMarks,
  parseRideoBlocking,
  type RideoImportResult,
  type ShotSolver,
  type SolvedShotLike,
} from './import';
export { RIDEO_EXPORT_WALK_M, exportRideoBlocking, type RideoExportResult } from './export';
export { exportRideoOperator, importInputOf, importRideoOperator, type ImportRideoParams } from './operators';
