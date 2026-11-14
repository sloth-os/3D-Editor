/*
 * Staging from a host's brief (the desk embed protocol v1's SceneBrief): the brief's schema
 * (schema.ts), what the desk reads from its words (words.ts, plan.ts), staging it in an empty project
 * (stage.ts, with the SceneBlocking import as its engine), the record of what was staged (record.ts),
 * how a later brief differs (changes.ts), updating the staging to it (update.ts, timeline.ts) and the
 * results of each shot (results.ts). Pure core: every function runs in a web worker.
 */

export {
  BRIEF_ELEMENT_KINDS,
  BRIEF_LIMITS,
  BriefIdSchema,
  MoveSchema,
  SceneBriefSchema,
  TIMES_OF_DAY,
  briefProblems,
  type BriefCast,
  type BriefChanges,
  type BriefElement,
  type BriefElementKind,
  type BriefShot,
  type Move,
  type SceneBrief,
  type TimeOfDay,
} from './schema';
export { TIME_OF_DAY_SUN } from './words';
export { stageBrief, type BriefIssue, type StageBriefReport } from './stage';
export { briefRecord } from './record';
export { briefChanges } from './changes';
export { updateFromBrief } from './update';
export { shotResults, type ShotResultMeta } from './results';
