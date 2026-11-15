import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData, ShotData } from '../../doc/types';
import { DeskScene } from '../layout';
import { DESK_PROPS } from '../props';
import { flyerKind } from '../rideo/rules';
import { planBrief, shotCast, type BriefPlan } from './plan';
import {
  briefFrames,
  briefHash,
  castDigest,
  elementDigest,
  readBriefRecord,
  setDigest,
  shotCameraDigest,
  shotTextDigest,
  type BriefRecord,
  type BriefRecordShot,
} from './record';
import { hostShots, parseBrief, stagedActors, stagedBy } from './stage';
import type { BriefChanges, BriefShot, SceneBrief } from './schema';

export { briefFrames } from './record';

/*
 * How a brief differs from the one a scene was staged from (the contract's BriefChanges), as far as
 * an update acts on it: the shots the brief adds; the staged shots it no longer has; those whose frame
 * count changed (a new duration, or a new frame rate: only the shots whose frame count does change)
 * and that the desk does not already give that length; those whose cast changed; the cast members it
 * adds that a shot casts, and those it no longer has whose actor is staged; and, beyond the contract's
 * lists (`other`), whatever else an update acts on: the frame rate and size, the set, the props, the
 * shots' camera plans, the words and numbering of the shots the desk has, the names, kinds and heights
 * of the cast members it has actors of. A shot removed in the desk counts only for what stages it
 * again (its length, cast or camera plan): its words and number are not acted on.
 *
 * briefChanges is null exactly when updateFromBrief would change nothing of the staging (it acts on
 * this same diff, update.ts): such an update gives only the warnings every update of the brief
 * repeats (how the desk reads the brief, a shot whose length was changed in the desk, a cast member
 * kept as the kind staged), so a desk that offers Update shots on a non-null value offers it whenever
 * the update does something. The desk never drops the staging silently.
 *
 * A lens or a move the host gives back as the desk staged it (a host that copies the shot results
 * into its shots, then sends the brief again) agrees with the staging: no change.
 */

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const clampLens = (mm: number) => Math.min(800, Math.max(8, Math.round(mm)));

/** What a later brief changes of one of its shots, against the record. */
export interface ShotDiff {
  /** Not staged before (not in the record). */
  added: boolean;
  /** Its frame count changed (its duration at the brief's frame rate): the desk shot takes the new length. */
  frames: boolean;
  /**
   * Its frame count changed and the desk shot does not have that length already (one removed in the
   * desk is staged again with it): the contract's `retimed`.
   */
  retimed: boolean;
  recast: boolean;
  /** Its camera plan changed (framing, movement, lens, move, layout, continuity; see the module comment). */
  replanned: boolean;
  /** Its description or action changed. */
  reworded: boolean;
  /** Its index changed (the desk's own shot names follow it). */
  renumbered: boolean;
}

/** How a brief differs from the staging, item by item (what updateFromBrief acts on). */
export interface BriefDiff {
  /** The contract's changes, with `other` when something else differs; null: nothing does. */
  changes: BriefChanges | null;
  /** The brief's shots by host id. */
  shots: Map<string, ShotDiff>;
  fps: boolean;
  resized: boolean;
  /** The set as planned changed (rebuilt). */
  set: boolean;
  /** Elements staged as props that are new or are staged again, and the staged props the brief no longer plans. */
  props: { restage: Set<string>; removed: Set<string> };
  /**
   * Cast members staged before whose words change what an update does: a new name (the actor is
   * renamed), a kind or a height other than the staged actor's (kept, with a warning).
   */
  castWords: Set<string>;
  /** The brief's plan (null: the brief is the one staged, nothing to plan). */
  plan: BriefPlan | null;
}

/** The runs of consecutive shots (by host id) in which `holder` is cast; [] without a holder. */
export function holderRuns(
  shots: readonly { id: string; castIds: readonly string[] }[],
  holder: string | null,
): string[][] {
  const runs: string[][] = [];
  let open = false;
  for (const s of shots) {
    if (holder && s.castIds.includes(holder)) {
      if (open) runs[runs.length - 1].push(s.id);
      else runs.push([s.id]);
      open = true;
    } else open = false;
  }
  return runs;
}

/** The lens (as the shot results round it) and the move the desk staged for a shot. */
function stagedCamera(scene: DeskScene, d: ShotData): { lensMm: number; move: string | null } {
  const view = d.camera ? scene.camera(d.camera, d.frame_start) : null;
  return { lensMm: clampLens(view?.lens ?? d.lens_mm ?? 50), move: d.move };
}

/**
 * Whether brief shot `s` plans its camera as recorded shot `r` did: the same digest, or the same once
 * a lens or move that equals what the desk staged is read as the one recorded (null in records
 * written before they kept it).
 */
function planAgrees(
  r: BriefRecordShot,
  s: BriefShot,
  staged: () => { lensMm: number; move: string | null } | null,
): boolean {
  if (r.camera === shotCameraDigest(s)) return true;
  const st = staged();
  if (!st) return false;
  const lenses = [s.lensMm];
  if (s.lensMm !== null && s.lensMm === st.lensMm) lenses.push(r.lensMm === undefined ? null : r.lensMm);
  const moves: (typeof s.move)[] = [s.move];
  if (s.move !== null && s.move === st.move)
    moves.push((r.move === undefined ? null : r.move) as typeof s.move);
  for (const lensMm of lenses)
    for (const move of moves) if (shotCameraDigest({ ...s, lensMm, move }) === r.camera) return true;
  return false;
}

/**
 * How validated brief `b` differs from record `r` (null: nothing staged; another scene's record counts
 * as nothing of this one: every shot and cast member is new) and the staging in `doc` (the lenses and
 * moves staged, the props staged). `plan`: the brief's plan when the caller has it.
 */
export function diffBrief(
  doc: SceneDoc,
  r: BriefRecord | null,
  b: SceneBrief,
  plan: BriefPlan | null = null,
): BriefDiff {
  const staged = r && r.sceneId === b.id ? r : null;
  const shots = new Map<string, ShotDiff>();
  const none = { restage: new Set<string>(), removed: new Set<string>() };
  // the brief staged, as it was: nothing differs
  if (staged && staged.hash === briefHash(b)) {
    for (const s of b.shots)
      shots.set(s.id, {
        added: !staged.shots.some((x) => x.id === s.id),
        frames: false,
        retimed: false,
        recast: false,
        replanned: false,
        reworded: false,
        renumbered: false,
      });
    return {
      changes: null,
      shots,
      fps: false,
      resized: false,
      set: false,
      props: none,
      castWords: new Set(),
      plan,
    };
  }
  const p = plan ?? planBrief(b);
  const before = new Map((staged?.shots ?? []).map((s) => [s.id, s]));
  const desk = staged ? hostShots(doc, b.id) : new Map<string, ShotData>();
  let scene: DeskScene | null = null;
  for (const s of b.shots) {
    const o = before.get(s.id);
    if (!o) {
      shots.set(s.id, {
        added: true,
        frames: true,
        retimed: false,
        recast: false,
        replanned: true,
        reworded: true,
        renumbered: true,
      });
      continue;
    }
    const wanted = briefFrames(s.durationSec, b.fps);
    const frames = o.frames !== wanted;
    const d = desk.get(s.id);
    shots.set(s.id, {
      added: false,
      frames,
      retimed: frames && (!d || d.frame_end - d.frame_start + 1 !== wanted),
      recast: !sameSet(o.castIds, shotCast(s)),
      replanned: !planAgrees(o, s, () => (d ? stagedCamera((scene ??= new DeskScene(doc)), d) : null)),
      reworded: o.text !== shotTextDigest(s),
      renumbered: o.index !== s.index,
    });
  }
  const now = new Set(b.shots.map((s) => s.id));
  const castBefore = new Map((staged?.cast ?? []).map((c) => [c.id, c]));
  const castNow = new Set(b.cast.map((c) => c.id));
  // the actors staged now: an update renames, warns of and removes only those
  const actors = staged ? stagedActors(doc, b.id) : new Map<string, ObjectData>();
  const list = (f: (d: ShotDiff) => boolean) => b.shots.filter((s) => f(shots.get(s.id)!)).map((s) => s.id);
  const changes: BriefChanges = {
    added: list((d) => d.added),
    // a shot removed in the desk that the brief drops leaves nothing to remove
    removed: [...before.keys()].filter((id) => !now.has(id) && desk.has(id)),
    retimed: list((d) => !d.added && d.retimed),
    recast: list((d) => !d.added && d.recast),
    cast: {
      // a member in no shot is not staged; one whose actor was removed in the desk has nothing to remove
      added: b.cast
        .filter((c) => !castBefore.has(c.id) && (!staged || p.order.includes(c.id)))
        .map((c) => c.id),
      removed: [...castBefore.keys()].filter((id) => !castNow.has(id) && actors.has(id)),
    },
  };
  if (!staged)
    return {
      changes,
      shots,
      fps: true,
      resized: true,
      set: true,
      props: none,
      castWords: new Set(),
      plan: p,
    };

  // ---------------------------------------------------------------- what else differs
  const fps = staged.fps !== b.fps;
  const resized = staged.width !== b.width || staged.height !== b.height;
  const set = staged.set !== setDigest(p.set);
  // the cast: a new name, or a kind or height other than the actor staged (words that change neither
  // leave the actor as it is), of the members with an actor in the desk
  const castWords = new Set<string>();
  let renamed = 0;
  let rekinded = 0;
  let reheighted = 0;
  for (const c of b.cast) {
    const was = castBefore.get(c.id);
    const actor = actors.get(c.id);
    if (!was || !actor || !p.order.includes(c.id) || was.digest === castDigest(c)) continue;
    // renamed (or, renamed in the desk, kept with a warning) unless the actor has the new name
    const name = was.name !== c.name && actor.name !== c.name;
    const kind = was.kind !== null && was.kind !== p.cast.get(c.id)?.kind;
    const height = was.heightM !== undefined && was.heightM !== c.heightM;
    renamed += +name;
    rekinded += +kind;
    reheighted += +height;
    if (name || kind || height) castWords.add(c.id);
  }
  // the props: new or changed elements, new holders, holders' shots changed, flights over shots retimed or added
  const elementById = new Map(b.elements.map((e) => [e.id, e]));
  const recordElement = new Map(staged.elements.map((e) => [e.id, e]));
  const planned = new Map(p.blockingProps.filter((x) => x.elementId).map((x) => [x.elementId!, x]));
  // the holders' runs of shots over the shots the desk has, before and after the update (one removed
  // in the desk counts once the update stages it again: its length, cast or camera plan changed)
  const staysOrStaged = (id: string, d: ShotDiff) =>
    desk.has(id) || d.added || d.frames || d.recast || d.replanned;
  const shotsBefore = staged.shots
    .filter((s) => desk.has(s.id))
    .map((s) => ({ id: s.id, castIds: s.castIds }));
  const shotsAfter = b.shots
    .filter((s) => staysOrStaged(s.id, shots.get(s.id)!))
    .map((s) => ({ id: s.id, castIds: shotCast(s) }));
  const restage = new Set<string>();
  let propWords = 0;
  for (const [eid, x] of planned) {
    const e = elementById.get(eid)!;
    const was = recordElement.get(eid);
    const holder = p.holders.get(eid) ?? null;
    const flies = holder ? flyerKind(`${x.label} ${e.name}`) : null;
    const runsAfter = holderRuns(shotsAfter, holder);
    // a flight over a shot the update gives a new length or stages
    const touched = runsAfter.flat().some((id) => shots.get(id)!.added || shots.get(id)!.retimed);
    const element = !was || was.digest !== elementDigest(e) || was.holder !== holder;
    if (element) propWords++;
    if (
      element ||
      JSON.stringify(holderRuns(shotsBefore, was?.holder ?? null)) !== JSON.stringify(runsAfter) ||
      (flies !== null && touched)
    )
      restage.add(eid);
  }
  const removedProps = new Set(
    [...stagedBy(doc, 'prop', b.id, (o) => o.custom_props?.[DESK_PROPS.elementId]).keys()].filter(
      (eid) => !planned.has(eid),
    ),
  );
  const keptIds = b.shots.filter((s) => !shots.get(s.id)!.added).map((s) => s.id);
  const kept = keptIds.map((id) => shots.get(id)!);
  // the words and number of a shot removed in the desk are not acted on (it stays removed)
  const inDesk = kept.filter((d, i) => desk.has(keptIds[i]));
  const other: string[] = [];
  if (fps) other.push(`the frame rate (${staged.fps} to ${b.fps} fps)`);
  if (resized) other.push(`the frame size (${staged.width}×${staged.height} to ${b.width}×${b.height})`);
  if (set) other.push('the set');
  if (propWords || removedProps.size) other.push('the props');
  const replanned = kept.filter((d) => d.replanned).length;
  if (replanned) other.push(`${plural(replanned, 'shot')} with a new camera plan`);
  const reworded = inDesk.filter((d) => d.reworded).length;
  if (reworded) other.push(`${plural(reworded, 'shot')} with new words`);
  const renumbered = inDesk.filter((d) => d.renumbered).length;
  if (renumbered && !changes.added.length && !changes.removed.length)
    other.push(`${plural(renumbered, 'shot')} renumbered`);
  if (renamed) other.push(`${plural(renamed, 'cast member')} renamed`);
  if (rekinded) other.push(`${plural(rekinded, 'cast member')} of another kind`);
  if (reheighted) other.push(`${plural(reheighted, 'cast member')} of another height`);
  if (other.length) changes.other = other;
  return {
    changes: noChanges(changes) ? null : changes,
    shots,
    fps,
    resized,
    set,
    props: { restage, removed: removedProps },
    castWords,
    plan: p,
  };
}

/** Whether changes say nothing changed. */
export const noChanges = (c: BriefChanges): boolean =>
  !c.added.length &&
  !c.removed.length &&
  !c.retimed.length &&
  !c.recast.length &&
  !c.cast.added.length &&
  !c.cast.removed.length &&
  !c.other?.length;

/**
 * How `brief` differs from the brief `doc` was staged from (see the module comment); null when it
 * does not, which is exactly when updateFromBrief would change nothing. A document not staged from a
 * brief, or staged from another scene's, differs by every shot and cast member of `brief`. Throws an
 * OperatorError (INVALID_PARAMS) for a brief that does not validate.
 */
export function briefChanges(doc: SceneDoc, brief: SceneBrief): BriefChanges | null {
  return diffBrief(doc, readBriefRecord(doc), parseBrief(brief)).changes;
}
