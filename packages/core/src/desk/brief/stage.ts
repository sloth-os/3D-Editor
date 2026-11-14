import type { SceneDoc } from '../../doc/scene-doc';
import type { ShotData } from '../../doc/types';
import { createEditorState, OperatorError, type OperatorContext } from '../../operators/context';
import { solveShotCameras } from '../../operators/desk-shots';
import type { ActorKind } from '../characters/types';
import type { DeskIssue, DeskIssueSeverity } from '../checks';
import { getShots } from '../shots';
import { importRideoBlocking } from '../rideo/import';
import { planBrief, shotCast } from './plan';
import {
  briefHash,
  castDigest,
  digest,
  elementDigest,
  readBriefRecord,
  setDigest,
  shotCameraDigest,
  shotTextDigest,
  writeBriefRecord,
  type BriefRecord,
} from './record';
import { SceneBriefSchema, briefProblems, type BriefChanges, type SceneBrief } from './schema';

/*
 * stageBrief: a host's SceneBrief (schema.ts) staged in an empty project, in one transaction (one
 * undo step): the scene's frame rate and render size, the set, the cast as actors, the props, a
 * shot per brief shot (round(durationSec × fps) frames, at least one, back to back; the host's ids
 * kept as the shots' external reference, source 'host', and as the actors' character ids), each
 * camera solved from its framing and fitted to its planned layout, the actors not cast in a shot
 * hidden in it, and the desk's checks run. plan.ts decides what the brief's words leave open; the
 * SceneBlocking import (desk/rideo/import.ts) is the staging engine. A record of the brief is kept
 * in the document (record.ts) for later updates (update.ts).
 *
 * Pure core: no DOM, no Node API, so it runs in a web worker as well as on the server.
 */

/** A desk check of the staged scene, with the host's shot id when it concerns a shot. */
export interface BriefIssue {
  code: string;
  severity: DeskIssueSeverity;
  message: string;
  /** The host's shot id (null: the whole scene, or a shot not from the brief). */
  shotId: string | null;
}

/**
 * What staging (or updating) a brief did:
 * - `sceneId`, `hash`: the brief now staged (briefRecord gives the same);
 * - `shots`: every shot of the brief, in brief order, with the desk's shot id, its frames and camera;
 * - `cast`: every cast member staged, with its actor object, name, kind and why that kind;
 * - `props`: every element staged as a prop, with its object and the cast member holding it;
 * - `changes`: how the brief differed from the one staged before (updateFromBrief; null otherwise);
 * - `solved`: the host shots whose cameras were solved by this call;
 * - `warnings`: what the desk read differently from the brief, or could not stage as it says;
 * - `issues`: the desk's checks of the brief's shots after staging.
 */
export interface StageBriefReport {
  sceneId: string;
  hash: string;
  shots: { shotId: string; deskShotId: string; frames: number; camera: string | null }[];
  cast: { castId: string; object: string; name: string; kind: ActorKind; reason: string }[];
  props: { elementId: string; object: string; heldBy: string | null }[];
  changes: BriefChanges | null;
  solved: string[];
  warnings: string[];
  issues: BriefIssue[];
}

/** A brief validated by SceneBriefSchema, or INVALID_PARAMS naming its first problems. */
export function parseBrief(raw: unknown): SceneBrief {
  const r = SceneBriefSchema.safeParse(raw);
  if (!r.success) throw new OperatorError(`invalid brief: ${briefProblems(r.error)}`, 'INVALID_PARAMS');
  return r.data;
}

/**
 * The operator context brief staging runs the solver in: `ctx`'s document, state and origin, with
 * its reports kept in `warnings` (the solver warns of shots whose camera widens or loses its plan).
 */
export function briefContext(ctx: OperatorContext, warnings: string[]): OperatorContext {
  return {
    ...ctx,
    report: (level, message) => {
      if (level !== 'INFO') warnings.push(message);
    },
  };
}

/** A context for `doc` alone (the functions' callers have no operator context: a worker, a tool). */
export function docContext(doc: SceneDoc): OperatorContext {
  return { doc, state: createEditorState(), origin: doc.origin, source: 'api', report: () => {} };
}

/** The shots of `doc` staged from the scene `sceneId` (source 'host'), by host shot id. */
export function hostShots(doc: SceneDoc, sceneId: string): Map<string, ShotData> {
  const out = new Map<string, ShotData>();
  for (const s of getShots(doc))
    if (
      s.external?.source === 'host' &&
      s.external.clip === sceneId &&
      s.external.shot &&
      !out.has(s.external.shot)
    )
      out.set(s.external.shot, s);
  return out;
}

/** The issues of `issues` with the host's shot ids. */
export function briefIssues(issues: readonly DeskIssue[], hostOf: ReadonlyMap<string, string>): BriefIssue[] {
  return issues.map((i) => ({
    code: i.code,
    severity: i.severity,
    message: i.message,
    shotId: i.shot ? (hostOf.get(i.shot) ?? null) : null,
  }));
}

/**
 * The record of brief `b` staged with the desk shots `desk` (by host shot id), the cast's kinds, the
 * held elements' holders and the set as planned. `notes`: the digest to keep for shots whose notes
 * were edited in the desk (the staged notes' digest, so that a later update still keeps them).
 */
export function recordOf(
  b: SceneBrief,
  desk: ReadonlyMap<string, ShotData>,
  kinds: ReadonlyMap<string, { kind: ActorKind }>,
  holders: ReadonlyMap<string, string>,
  plannedSet: unknown,
  notes: ReadonlyMap<string, string> = new Map(),
): BriefRecord {
  return {
    version: 1,
    sceneId: b.id,
    hash: briefHash(b),
    fps: b.fps,
    width: b.width,
    height: b.height,
    set: setDigest(plannedSet),
    shots: b.shots
      .filter((s) => desk.has(s.id))
      .map((s) => {
        const d = desk.get(s.id)!;
        return {
          id: s.id,
          desk: d.id,
          index: s.index,
          durationSec: s.durationSec,
          frames: d.frame_end - d.frame_start + 1,
          castIds: shotCast(s),
          elementIds: [...s.elementIds],
          text: shotTextDigest(s),
          notes: notes.get(s.id) ?? digest(d.notes),
          camera: shotCameraDigest(s),
        };
      }),
    cast: b.cast.map((c) => ({
      id: c.id,
      name: c.name,
      kind: kinds.get(c.id)?.kind ?? null,
      digest: castDigest(c),
    })),
    elements: b.elements.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      holder: holders.get(e.id) ?? null,
      digest: elementDigest(e),
    })),
  };
}

/**
 * Stages brief `raw` in `ctx.doc` inside the caller's transaction (desk.stage_brief's execute; see
 * stageBrief). INVALID_PARAMS for a brief that does not validate, or a document already staged
 * from a brief or holding shots.
 */
export function stageBriefIn(
  ctx: OperatorContext,
  raw: unknown,
  opts: { preRollFrames?: number } = {},
): StageBriefReport {
  const brief = parseBrief(raw);
  const doc = ctx.doc;
  const staged = readBriefRecord(doc);
  if (staged)
    throw new OperatorError(
      staged.sceneId === brief.id
        ? `the project is already staged from scene '${brief.id}': update it (updateFromBrief, desk.update_from_brief)`
        : `the project is staged from scene '${staged.sceneId}', not '${brief.id}': stage this brief in another project`,
      'INVALID_PARAMS',
    );
  if (getShots(doc).length)
    throw new OperatorError(
      'the project already has shots: a brief is staged in an empty project (one without shots)',
      'INVALID_PARAMS',
    );
  const plan = planBrief(brief, opts);
  const warnings = [...plan.warnings];
  const r = importRideoBlocking(briefContext(ctx, warnings), plan.input, solveShotCameras);
  warnings.push(...r.warnings);
  for (const s of plan.skipped) {
    const e = brief.elements.find((x) => x.id === s.id)!;
    warnings.push(`${e.name} ${s.why}`);
  }
  const desk = hostShots(doc, brief.id);
  writeBriefRecord(doc, recordOf(brief, desk, plan.cast, plan.holders, plan.set));
  const hostOf = new Map([...desk].map(([host, s]) => [s.id, host]));
  return {
    sceneId: brief.id,
    hash: briefHash(brief),
    shots: brief.shots
      .filter((s) => desk.has(s.id))
      .map((s) => {
        const d = desk.get(s.id)!;
        return { shotId: s.id, deskShotId: d.id, frames: d.frame_end - d.frame_start + 1, camera: d.camera };
      }),
    cast: r.actors.map((a) => ({
      castId: a.character_id,
      object: a.id,
      name: a.name,
      kind: a.kind,
      reason: plan.cast.get(a.character_id)?.reason ?? a.reason,
    })),
    props: r.props
      .filter((p) => p.element_id)
      .map((p) => ({
        elementId: p.element_id!,
        object: p.id,
        heldBy: plan.holders.get(p.element_id!) ?? null,
      })),
    changes: null,
    solved: r.shots.filter((s) => s.camera_from === 'solved').map((s) => s.rideo_shot),
    warnings,
    issues: briefIssues(r.issues, hostOf),
  };
}

/**
 * Stages a host's SceneBrief in an empty project, in one transaction (one undo step): see the module
 * comment. `preRollFrames`: the gap the SceneBlocking import puts before a cut where marks jump
 * (a brief has no marks: unused unless the staging is updated with some). Throws an OperatorError
 * (INVALID_PARAMS) for a brief that does not validate, or a project that has shots or is staged from
 * a brief already (updateFromBrief updates that). Runs in a web worker: no DOM, no Node API.
 */
export function stageBrief(
  doc: SceneDoc,
  brief: SceneBrief,
  opts: { preRollFrames?: number } = {},
): StageBriefReport {
  return doc.transact(() => stageBriefIn(docContext(doc), brief, opts));
}
