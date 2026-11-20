/*
 * Staging from a host's brief (the desk embed protocol v1's SceneBrief): the brief's schema
 * (schema.ts), what the desk reads from its words (words.ts, plan.ts), staging it in an empty project
 * (stage.ts, with the SceneBlocking import as its engine), the record of what was staged (record.ts),
 * how a later brief differs (changes.ts), updating the staging to it (update.ts, timeline.ts), the
 * results of each shot (results.ts), and the brief's library pins (units.ts: the units held, what
 * staging does per slot; library.ts: the units an update wants, linking a published unit). Pure
 * core: every function runs in a web worker.
 */

export {
  BRIEF_ELEMENT_KINDS,
  BRIEF_LIMITS,
  BriefIdSchema,
  BriefUnitPinSchema,
  MAX_UNIT_VERSION,
  MoveSchema,
  SceneBriefSchema,
  TIMES_OF_DAY,
  briefProblems,
  type BriefCast,
  type BriefChanges,
  type BriefElement,
  type BriefElementKind,
  type BriefShot,
  type BriefUnitPin,
  type Move,
  type SceneBrief,
  type TimeOfDay,
} from './schema';
export { TIME_OF_DAY_SUN } from './words';
export { stageBrief, type BriefIssue, type StageBriefOptions, type StageBriefReport } from './stage';
export { RECORD_PIN_STAGED, briefRecord, type RecordPin, type RecordPinStaged } from './record';
export { briefChanges } from './changes';
export { updateFromBrief } from './update';
export { shotResults, type ShotResultMeta } from './results';
export {
  MAX_SET_PIECES,
  MAX_UNIT_STAGE_M,
  MIN_UNIT_STAGE_M,
  SET_GROUND_TOLERANCE_M,
  UNIT_BUDGET,
  UNIT_PENDING_REASONS,
  UNIT_REFUSED_REASONS,
  briefPins,
  briefWithoutPins,
  pinKey,
  planInfoOf,
  stateUnitRows,
  unitBudget,
  unitReadProblem,
  unitSize,
  unitSourceOf,
  type BriefSlotPin,
  type GivenProblem,
  type GivenUnit,
  type PlanUnitInfo,
  type StageUnitRow,
  type StateUnitRow,
  type UnitBudgetVerdict,
  type UnitPendingReason,
  type UnitProblem,
  type UnitRefusal,
  type UnitSize,
  type UnitSource,
} from './units';
export { adoptPublished, pinsWanted, type AdoptPublishedOptions } from './library';
