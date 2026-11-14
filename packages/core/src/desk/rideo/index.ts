/*
 * rideo's SceneBlocking import and export (spec §11): the blocking's schema and the import's input
 * (schema.ts), the reading rules (rules.ts), the import (import.ts), the export (export.ts) and the
 * two operators' executes (operators.ts, registered in operators/desk-shots.ts).
 */

export * from './schema';
export * from './rules';
export { HIDDEN_SCALE as RIDEO_HIDDEN_SCALE } from './keys';
export {
  RIDEO_PROPS,
  importRideoBlocking,
  parseRideoBlocking,
  type RideoImportResult,
  type ShotSolver,
  type SolvedShotLike,
} from './import';
export { RIDEO_EXPORT_WALK_M, exportRideoBlocking, type RideoExportResult } from './export';
export { exportRideoOperator, importInputOf, importRideoOperator, type ImportRideoParams } from './operators';
