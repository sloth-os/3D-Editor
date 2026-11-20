/*
 * Library units (docs/architecture.md, "Library units"): self-contained, versioned copies of part of
 * a scene (a set, a prop, a figure) that a host's library keeps and pins in its briefs. The file
 * format (format.ts), instance keys and derived ids (ids.ts), which fields belong to the unit and
 * which to the scene (ownership.ts), the id-bearing fields (refs.ts), making a unit from a scene
 * (extract.ts), putting one in (insert.ts), updating an instance (update.ts), linking a published
 * scene (adopt.ts), the instances a scene holds (list.ts) and what was edited of them (status.ts).
 * Pure core: every function runs in the desk's staging worker and in Node.
 */
export { UNIT_ERROR_CODES, UnitError, type UnitErrorCode } from './errors';
export { UNIT_BLOCK_KINDS, UNIT_KINDS, type UnitBlockKind, type UnitKind } from './kinds';
export {
  MAX_UNIT_BLOBS,
  MAX_UNIT_BODY_BYTES,
  MAX_UNIT_BYTES,
  MAX_UNIT_CREDITS,
  MAX_UNIT_HEADER_BYTES,
  MAX_UNIT_LANDMARKS,
  MAX_UNIT_META_BYTES,
  MAX_UNIT_META_CREDITS,
  MAX_UNIT_NAME_LENGTH,
  MAX_UNIT_RECORDS,
  UNIT_CONTAINER_VERSION,
  UNIT_FORMAT,
  UNIT_LANDMARK_ROLES,
  UNIT_VERSION,
  UnitCountsSchema,
  UnitCreditSchema,
  UnitFigureFactsSchema,
  UnitHeaderSchema,
  UnitLandmarkSchema,
  UnitPropFactsSchema,
  UnitSetFactsSchema,
  checkUnitBody,
  decodeUnit,
  decodeUnitBody,
  encodeUnit,
  encodeUnitBody,
  readUnitHeader,
  rigDigest,
  unitMeta,
  type UnitBody,
  type UnitCounts,
  type UnitCredit,
  type UnitHeader,
  type UnitHeaderInput,
  type UnitLandmark,
  type UnitPayload,
  type UnitPublishMeta,
} from './format';
export {
  UNIT_KEY_PATTERN,
  UNIT_ROOT,
  UNIT_SOURCE_ID_PATTERN,
  deriveUnitId,
  parseSlotKey,
  requireUnitKey,
  slotKey,
  type UnitSlot,
} from './ids';
export {
  FIGURE_ROOT_UNIT_PROPS,
  OBJECT_SCENE_FIELDS,
  PART_SCENE_FIELDS,
  ROOT_SCENE_FIELDS,
  SCENE_PROPS,
  SCENE_PROP_PREFIXES,
  isSceneProp,
  partSum16,
  unitView,
  type PartPlace,
} from './ownership';
export { mapRecordRefs, collectRecordRefs, type RefSite, type UnitRecord } from './refs';
export {
  extractUnit,
  planUnit,
  type UnitExtraction,
  type UnitLinkPlan,
  type UnitPlan,
  type UnitSpec,
} from './extract';
export {
  insertUnit,
  requirePin,
  type InsertUnitOptions,
  type InsertUnitResult,
  type UnitPin,
} from './insert';
export { makeLocal, updateUnit, type UnitKeptReason, type UnitUpdateReport } from './update';
export { adoptUnit } from './adopt';
export {
  UNIT_PROPS,
  docHasUnitInstances,
  listUnits,
  readInstance,
  unitOf,
  unitsInUse,
  type UnitInstance,
  type UnitInstanceInfo,
  type UnitPartStamp,
} from './list';
export { unitStatus, type UnitPartRef } from './status';
