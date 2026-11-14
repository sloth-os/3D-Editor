import type { SceneDoc } from '../../doc/scene-doc';
import type { ShotData } from '../../doc/types';
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
import { hostShots, parseBrief, stagedBy } from './stage';
import type { BriefChanges, BriefShot, SceneBrief } from './schema';

export { briefFrames } from './record';

/*
 * How a brief differs from the one a scene was staged from (the contract's BriefChanges): the shots
 * the brief adds, those it no longer has, those whose duration changed (or whose frame count, when
 * the frame rate changed: only the shots whose frame count does change) and those whose cast changed;
 * the cast members it adds and removes; and, beyond the contract's lists (`other`), whatever else an
 * update acts on: the frame rate and size, the set, the props, the shots' camera plans, words and
 * numbering, the cast's words. briefChanges is null exactly when updateFromBrief would change nothing
 * (it acts on this same diff, update.ts), so a desk that offers Update shots on a non-null value
 * offers it whenever the update does something. The desk never drops the staging silently.
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
  /** Its duration or its frame count changed (the contract's `retimed`). */
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
    const frames = o.frames !== briefFrames(s.durationSec, b.fps);
    const d = desk.get(s.id);
    shots.set(s.id, {
      added: false,
      frames,
      retimed: frames || o.durationSec !== s.durationSec,
      recast: !sameSet(o.castIds, shotCast(s)),
      replanned: !planAgrees(o, s, () => (d ? stagedCamera((scene ??= new DeskScene(doc)), d) : null)),
      reworded: o.text !== shotTextDigest(s),
      renumbered: o.index !== s.index,
    });
  }
  const now = new Set(b.shots.map((s) => s.id));
  const castBefore = new Map((staged?.cast ?? []).map((c) => [c.id, c]));
  const castNow = new Set(b.cast.map((c) => c.id));
  const list = (f: (d: ShotDiff) => boolean) => b.shots.filter((s) => f(shots.get(s.id)!)).map((s) => s.id);
  const changes: BriefChanges = {
    added: list((d) => d.added),
    removed: [...before.keys()].filter((id) => !now.has(id)),
    retimed: list((d) => !d.added && d.retimed),
    recast: list((d) => !d.added && d.recast),
    cast: {
      added: b.cast.filter((c) => !castBefore.has(c.id)).map((c) => c.id),
      removed: [...castBefore.keys()].filter((id) => !castNow.has(id)),
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
  // leave the actor as it is)
  const castWords = new Set<string>();
  let renamed = 0;
  let rekinded = 0;
  let reheighted = 0;
  for (const c of b.cast) {
    const was = castBefore.get(c.id);
    if (!was || !p.order.includes(c.id) || was.digest === castDigest(c)) continue;
    const name = was.name !== c.name;
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
  const shotsBefore = staged.shots.map((s) => ({ id: s.id, castIds: s.castIds }));
  const shotsAfter = b.shots.map((s) => ({ id: s.id, castIds: shotCast(s) }));
  const restage = new Set<string>();
  let propWords = 0;
  for (const [eid, x] of planned) {
    const e = elementById.get(eid)!;
    const was = recordElement.get(eid);
    const holder = p.holders.get(eid) ?? null;
    const flies = holder ? flyerKind(`${x.label} ${e.name}`) : null;
    const runsAfter = holderRuns(shotsAfter, holder);
    const touched = runsAfter.flat().some((id) => shots.get(id)!.frames);
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
  const kept = b.shots.filter((s) => !shots.get(s.id)!.added).map((s) => shots.get(s.id)!);
  const other: string[] = [];
  if (fps) other.push(`the frame rate (${staged.fps} to ${b.fps} fps)`);
  if (resized) other.push(`the frame size (${staged.width}×${staged.height} to ${b.width}×${b.height})`);
  if (set) other.push('the set');
  if (propWords || removedProps.size) other.push('the props');
  const replanned = kept.filter((d) => d.replanned).length;
  if (replanned) other.push(`${plural(replanned, 'shot')} with a new camera plan`);
  const reworded = kept.filter((d) => d.reworded).length;
  if (reworded) other.push(`${plural(reworded, 'shot')} with new words`);
  const renumbered = kept.filter((d) => d.renumbered).length;
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
