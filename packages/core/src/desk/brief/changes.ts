import type { SceneDoc } from '../../doc/scene-doc';
import { shotCast } from './plan';
import { readBriefRecord, type BriefRecord } from './record';
import { parseBrief } from './stage';
import type { BriefChanges, SceneBrief } from './schema';

/*
 * How a brief differs from the one a scene was staged from (the contract's BriefChanges): the shots
 * the brief adds, those it no longer has, those whose duration changed (or whose frame count, when
 * the frame rate changed) and those whose cast changed; the cast members it adds and removes. The
 * desk offers to update its staging with them (update.ts); it never drops the staging silently.
 */

/** The frames a shot of `durationSec` takes at `fps` (at least one). */
export const briefFrames = (durationSec: number, fps: number): number =>
  Math.max(1, Math.round(durationSec * fps));

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * The changes from record `r` (null: nothing staged; another scene's record counts as nothing of
 * this one) to validated brief `b`, all lists empty when they agree.
 */
export function compareRecord(r: BriefRecord | null, b: SceneBrief): BriefChanges {
  const staged = r && r.sceneId === b.id ? r : null;
  const before = new Map((staged?.shots ?? []).map((s) => [s.id, s]));
  const now = new Set(b.shots.map((s) => s.id));
  const castBefore = new Set((staged?.cast ?? []).map((c) => c.id));
  const castNow = new Set(b.cast.map((c) => c.id));
  return {
    added: b.shots.filter((s) => !before.has(s.id)).map((s) => s.id),
    removed: [...before.keys()].filter((id) => !now.has(id)),
    retimed: b.shots
      .filter((s) => {
        const o = before.get(s.id);
        return !!o && (o.durationSec !== s.durationSec || o.frames !== briefFrames(s.durationSec, b.fps));
      })
      .map((s) => s.id),
    recast: b.shots
      .filter((s) => {
        const o = before.get(s.id);
        return !!o && !sameSet(o.castIds, shotCast(s));
      })
      .map((s) => s.id),
    cast: {
      added: b.cast.filter((c) => !castBefore.has(c.id)).map((c) => c.id),
      removed: [...castBefore].filter((id) => !castNow.has(id)),
    },
  };
}

/** Whether changes say nothing changed. */
export const noChanges = (c: BriefChanges): boolean =>
  !c.added.length &&
  !c.removed.length &&
  !c.retimed.length &&
  !c.recast.length &&
  !c.cast.added.length &&
  !c.cast.removed.length;

/**
 * How `brief` differs from the brief `doc` was staged from (see the module comment); null when it
 * does not. A document not staged from a brief, or staged from another scene's, differs by every shot
 * and cast member of `brief`. Throws an OperatorError (INVALID_PARAMS) for a brief that does not validate.
 */
export function briefChanges(doc: SceneDoc, brief: SceneBrief): BriefChanges | null {
  const changes = compareRecord(readBriefRecord(doc), parseBrief(brief));
  return noChanges(changes) ? null : changes;
}
