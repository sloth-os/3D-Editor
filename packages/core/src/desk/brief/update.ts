import type { SceneDoc } from '../../doc/scene-doc';
import type { DeskLayoutEntry, ObjectData, ShotData } from '../../doc/types';
import { OperatorError, type OperatorContext } from '../../operators/context';
import { solveShotCameras } from '../../operators/desk-shots';
import { checkShots } from '../checks';
import { createActor, defaultActorHeight, holdProp } from '../characters';
import { nextActorColor } from '../characters/actor';
import { attachSpans } from '../characters/attach';
import { isActorKind } from '../characters/kinds';
import { RIDE_PREFIX } from '../characters/rig';
import type { ActorKind } from '../characters/types';
import { addDeskCamera, prepareDeskCamera, retimeCameraRange } from '../moves';
import { DESK_PROPS } from '../props';
import { buildSet } from '../set';
import { FRAMING_TABLE } from '../solver';
import { MAX_SHOT_SUBJECTS, getDeskSettings, getShots, newShotId, setDeskSettings, setShots } from '../shots';
import {
  LAYOUT_SPACING_M,
  RIDEO_PROPS,
  buildLandmark,
  buildProp,
  flyProp,
  freeRowSpot,
  hiddenSpans,
  holderSpans,
  motionDigest,
  parseRideoBlocking,
  removeTrees,
  rideoHeightRatio,
  shotMove,
  tetherPartsOf,
  type SpanShot,
} from '../rideo/import';
import { hideSpans } from '../rideo/keys';
import { editorPose, flyerKind, isHumanoid, isRideable, ridersByText, shotText } from '../rideo/rules';
import { RideoImportInputSchema, type RideoBlockingMark, type RideoBlockingProp } from '../rideo/schema';
import { briefFrames, diffBrief, holderRuns } from './changes';
import { planBrief, shotCast } from './plan';
import { digest, readBriefRecord, shotTextDigest, writeBriefRecord, type BriefRecordShot } from './record';
import type { BriefShot, SceneBrief } from './schema';
import {
  briefContext,
  briefIssues,
  docContext,
  hostShots,
  parseBrief,
  recordOf,
  stagedActors,
  stagedBy,
  type StageBriefReport,
} from './stage';
import {
  deleteSceneRanges,
  insertSceneTime,
  keyVisible,
  shotSpan,
  uncoveredRanges,
  type FrameRange,
} from './timeline';

/*
 * updateFromBrief: a project staged from a brief (stage.ts) brought up to a later brief of the same
 * scene, in one transaction (one undo step). It acts on how the brief differs from the record of the
 * brief staged before (changes.ts diffBrief: what briefChanges reports), never on how the desk differs
 * from the brief: what the person did in the desk to a shot the brief did not change stays as they
 * left it (its length, its camera, its actors' marks, poses and keys, or its removal). Time is edited
 * as an editor's ripple edit does (timeline.ts), in frames no other shot covers, so that the shots
 * after an edit keep their staging only earlier or later and no other shot's keys are cut:
 *
 * - a shot the brief no longer has goes, with its camera and the frames no other shot covers;
 * - a shot whose frame count the brief changed (its duration, or the frame rate) takes the brief's
 *   length: it grows at its end over the frames no shot covers (and over shots overlapping its end),
 *   then over new frames before the next shot; it shrinks by its frames no other shot covers; its
 *   camera's move is fitted to its new length. A shot whose length was changed in the desk and whose
 *   frame count the brief did not change keeps the desk's length (with a warning);
 * - a new shot is put after the brief's shot before it (before the first shot when it leads), its
 *   camera solved from its framing and fitted to its planned layout, the cast not in it hidden;
 * - a shot removed in the desk stays removed unless the brief changes its length, cast or camera
 *   plan: then it is staged again like a new one (with a warning);
 * - a shot whose cast changed shows its new cast and hides the rest (in the frames it alone covers),
 *   its camera solved again;
 * - a shot whose camera plan changed (framing, movement, lens, move, layout, continuity; a lens or move
 *   the host gives back as staged is no change), or every shot when the render size changed, has its
 *   camera solved again;
 * - a camera set by hand in the desk is never solved again: the update keeps it and warns;
 * - cast members the brief no longer stages go; new ones stand on a free mark, shown in their shots
 *   (an actor removed in the desk is staged again only for a shot the update stages or recasts); a
 *   member the brief renames is renamed (unless the desk renamed it); one whose kind or height the
 *   brief changes stays the actor staged, with a warning;
 * - props whose element went go, new ones are placed, and a held prop whose holder or holder's shots
 *   changed is held (or flown) again; the set is rebuilt when its plan changed;
 * - notes the desk did not edit follow the brief's words; shot names that are the desk's own
 *   ('Shot 3') follow the brief's order;
 * - riders are not seated by an update: a shot it stages, or whose words or cast change, that says
 *   someone rides is staged with the rider beside the mount, with a warning (desk.actor_mount seats
 *   them; staging the brief in a new project mounts them as staging does).
 *
 * The brief's order of the shots the desk keeps is not changed by an update (a warning says so when
 * the brief reorders them): stage the brief in a new project to follow a new order.
 */

/** Whether object `id` animates as the desk last staged it (its recorded motion digest). */
function asStaged(doc: SceneDoc, id: string): boolean {
  const recorded = doc.getObject(id)?.custom_props?.[RIDEO_PROPS.motion];
  return typeof recorded === 'string' && recorded === motionDigest(doc, id);
}

/** Records what object `id` animates as now, as staged by the desk. */
function recordMotion(doc: SceneDoc, id: string): void {
  const o = doc.getObject(id);
  if (o)
    doc.updateObject(id, {
      custom_props: { ...o.custom_props, [RIDEO_PROPS.motion]: motionDigest(doc, id) },
    });
}

/** The shots of the cut in time order (enabled), as the import's span helpers read them, with their cast ids. */
function cutOf(doc: SceneDoc, brief: SceneBrief, actorCast: ReadonlyMap<string, string>): SpanShot[] {
  const byHost = new Map(brief.shots.map((s) => [s.id, s]));
  return getShots(doc)
    .filter((s) => s.enabled)
    .sort((a, b) => a.frame_start - b.frame_start)
    .map((s) => {
      const b =
        s.external?.source === 'host' && s.external.clip === brief.id && s.external.shot
          ? byHost.get(s.external.shot)
          : undefined;
      const characterIds = b
        ? shotCast(b)
        : s.subjects.map((id) => actorCast.get(id)).filter((c): c is string => !!c);
      return {
        keyFrame: s.frame_start - s.pre_roll,
        frameEnd: s.frame_end,
        camera: null,
        input: { characterIds, description: b?.description ?? s.notes, action: b?.action ?? '' },
      };
    });
}

/**
 * The frame after which new frames go so that they stretch no shot: `after`, or past the end of the
 * shots spanning it (frames inserted inside a shot would make it longer).
 */
function clearOf(spans: readonly FrameRange[], after: number): number {
  let at = after;
  for (;;) {
    const over = spans.filter((s) => s.from <= at && s.to > at);
    if (!over.length) return at;
    at = Math.max(...over.map((s) => s.to));
  }
}

/**
 * Makes desk shot `id` `frames` long from its first frame (see the module comment): growing, over
 * the frames after its end no shot covers and those of shots that overlap its end, then over new
 * frames before the next shot; shrinking, by its frames no other shot covers. Its camera's move is
 * fitted to the new length. Returns warnings.
 */
function resizeShot(doc: SceneDoc, id: string, frames: number): string[] {
  const shots = getShots(doc);
  const d = shots.find((s) => s.id === id);
  if (!d) return [];
  const end = d.frame_start + frames - 1;
  if (end === d.frame_end) return [];
  const others = shots.filter((s) => s.id !== id).map(shotSpan);
  const warnings: string[] = [];
  const setEnd = () =>
    setShots(
      doc,
      getShots(doc).map((x) => (x.id === id ? { ...x, frame_end: end } : x)),
    );
  if (end > d.frame_end) {
    let f = d.frame_end;
    while (f < end) {
      const next = f + 1;
      const covering = others.filter((o) => o.from <= next && o.to >= next);
      const overlapping = covering.filter((o) => o.from <= d.frame_end);
      if (!covering.length)
        f = Math.min(end, Math.min(Infinity, ...others.filter((o) => o.from > f).map((o) => o.from)) - 1);
      else if (overlapping.length) f = Math.min(end, Math.max(...overlapping.map((o) => o.to)));
      else break;
    }
    if (f < end) warnings.push(...insertSceneTime(doc, f, end - f));
    setEnd();
    if (d.camera) retimeCameraRange(doc, d.camera, [d.frame_start, d.frame_end], [d.frame_start, end]);
  } else {
    if (d.camera) retimeCameraRange(doc, d.camera, [d.frame_start, d.frame_end], [d.frame_start, end]);
    warnings.push(...deleteSceneRanges(doc, uncoveredRanges(others, end + 1, d.frame_end)));
    setEnd();
  }
  return warnings;
}

/** Whether rider `riderId` is seated on `mountId` at `frame` (a ride constraint holds there). */
function ridesAt(doc: SceneDoc, riderId: string, mountId: string, frame: number): boolean {
  return attachSpans(doc, riderId, RIDE_PREFIX).some(
    (s) => s.constraint.target === mountId && s.grab <= frame + 1e-6 && s.release > frame,
  );
}

/**
 * Updates `ctx.doc`, staged from a brief of the same scene, to brief `raw` inside the caller's
 * transaction (desk.update_from_brief's execute; see updateFromBrief). INVALID_PARAMS for a brief
 * that does not validate, a project not staged from a brief or staged from another scene.
 */
export function updateFromBriefIn(ctx: OperatorContext, raw: unknown): StageBriefReport {
  const brief = parseBrief(raw);
  const doc = ctx.doc;
  const record = readBriefRecord(doc);
  if (!record)
    throw new OperatorError(
      `the project is not staged from a brief: stage scene '${brief.id}' first (stageBrief, desk.stage_brief)`,
      'INVALID_PARAMS',
    );
  if (record.sceneId !== brief.id)
    throw new OperatorError(
      `the project is staged from scene '${record.sceneId}', not '${brief.id}': stage this brief in another project`,
      'INVALID_PARAMS',
    );
  const sceneId = brief.id;
  const plan = planBrief(brief);
  const diff = diffBrief(doc, record, brief, plan);
  const input = RideoImportInputSchema.parse(plan.input);
  const blocking = parseRideoBlocking(input.blocking ?? {});
  const plannedShot = new Map(input.shots.map((s) => [s.id, s]));
  const castById = new Map(brief.cast.map((c) => [c.id, c]));
  const elementById = new Map(brief.elements.map((e) => [e.id, e]));
  const recordShot = new Map(record.shots.map((s) => [s.id, s]));
  const recordCast = new Map(record.cast.map((c) => [c.id, c]));
  const warnings: string[] = [...plan.warnings];
  const stamp = (o: Record<string, string | number | boolean>) => ({ ...o, [RIDEO_PROPS.clip]: sceneId });
  const castNames = plan.order.map((id) => castById.get(id)!.name);
  const solve = new Set<string>();
  const keptNotes = new Map<string, string>();
  const shotDiff = (id: string) => diff.shots.get(id)!;

  // ------------------------------------------------------------ what is staged now
  const actors = stagedActors(doc, sceneId);
  const props = stagedBy(doc, 'prop', sceneId, (o) => o.custom_props?.[DESK_PROPS.elementId]);
  const staged = new Map<string, boolean>();
  for (const s of hostShots(doc, sceneId).values())
    if (s.camera) staged.set(s.camera, asStaged(doc, s.camera));
  for (const o of [...actors.values(), ...props.values()]) staged.set(o.id, asStaged(doc, o.id));
  const deskBefore = hostShots(doc, sceneId);
  // the shots this update stages: new ones, and those removed in the desk that the brief changed; the
  // others removed in the desk stay removed (kept in the record)
  const place = new Set<string>();
  const removedKept = new Map<string, BriefRecordShot>();
  for (const s of brief.shots) {
    if (deskBefore.has(s.id)) continue;
    const d = shotDiff(s.id);
    const r = recordShot.get(s.id);
    if (!r || d.frames || d.recast || d.replanned) place.add(s.id);
    else removedKept.set(s.id, r);
  }

  // ------------------------------------------------------------ settings
  if (diff.fps) doc.updateScene({ fps: brief.fps });
  if (diff.resized) {
    doc.updateRender({ resolution_x: brief.width, resolution_y: brief.height, resolution_percentage: 100 });
    setDeskSettings(doc, { aspect: brief.width / brief.height });
  }

  // ------------------------------------------------------------ shots the brief no longer has
  const inBrief = new Set(brief.shots.map((s) => s.id));
  const gone = [...deskBefore].filter(([host]) => !inBrief.has(host)).map(([, s]) => s);
  if (gone.length) {
    const goneIds = new Set(gone.map((s) => s.id));
    const keep = getShots(doc).filter((x) => !goneIds.has(x.id));
    setShots(doc, keep);
    for (const s of gone)
      if (s.camera && !keep.some((x) => x.camera === s.camera)) removeTrees(doc, [s.camera]);
    // their frames go, but none another shot covers
    const spans = keep.map(shotSpan);
    warnings.push(
      ...deleteSceneRanges(
        doc,
        gone.flatMap((s) => uncoveredRanges(spans, s.frame_start - s.pre_roll, s.frame_end)),
      ),
    );
  }

  // ------------------------------------------------------------ the cast
  const removedActors = new Set<string>();
  for (const [cid, o] of actors)
    if (!plan.order.includes(cid)) {
      removedActors.add(o.id);
      removeTrees(doc, [o.id]);
      actors.delete(cid);
    }
  if (removedActors.size) {
    setShots(
      doc,
      getShots(doc).map((s) => ({
        ...s,
        subjects: s.subjects.filter((id) => !removedActors.has(id)),
        layout: s.layout.filter((e) => !removedActors.has(e.subject)),
      })),
    );
    const pair = getDeskSettings(doc).main_pair;
    if (pair && pair.some((id) => removedActors.has(id))) setDeskSettings(doc, { main_pair: null });
  }
  // a member without an actor is staged when new to the brief or to its shots, or cast in a shot this
  // update stages or recasts (an actor removed in the desk stays removed otherwise)
  const stagedBefore = new Set(record.shots.flatMap((s) => s.castIds));
  const restaged = brief.shots.filter(
    (s) => place.has(s.id) || (deskBefore.has(s.id) && shotDiff(s.id).recast),
  );
  const created = new Set<string>();
  for (const cid of plan.order) {
    if (actors.has(cid)) continue;
    if (recordCast.has(cid) && stagedBefore.has(cid) && !restaged.some((s) => shotCast(s).includes(cid)))
      continue;
    const id = addActor(doc, cid, brief, plan.cast.get(cid)!.kind, plan.marks.get(cid), actors, stamp);
    actors.set(cid, doc.getObject(id)!);
    created.add(cid);
  }
  for (const [cid, o] of actors) {
    const c = castById.get(cid)!;
    if (created.has(cid)) continue;
    // a name the brief changed (one changed in the desk stays)
    const was = recordCast.get(cid);
    if (was && was.name !== c.name && o.name !== c.name) doc.rename('objects', o.id, c.name);
    const kind = o.custom_props?.[DESK_PROPS.kind];
    const now = plan.cast.get(cid)!.kind;
    if (typeof kind === 'string' && kind !== now)
      warnings.push(
        `${c.name} now reads as a ${now} but stays the ${kind} staged before (its keys kept): stage the brief in a new project to rebuild it`,
      );
    if (was && was.heightM !== undefined && was.heightM !== c.heightM) {
      const height = (h: number | null) => (h === null ? 'unset' : `${h} m`);
      warnings.push(
        `${c.name}'s height in the brief is now ${height(c.heightM)} (${height(was.heightM)} before), but the actor keeps the height it was staged with: stage the brief in a new project to rebuild it`,
      );
    }
  }
  const actorId = (cid: string) => actors.get(cid)?.id ?? null;
  const actorCast = new Map([...actors].map(([cid, o]) => [o.id, cid]));

  // ------------------------------------------------------------ shots whose frame count the brief changed
  for (const s of brief.shots) {
    const d = hostShots(doc, sceneId).get(s.id);
    const sd = shotDiff(s.id);
    if (!d || !(sd.frames || sd.added)) continue;
    warnings.push(...resizeShot(doc, d.id, briefFrames(s.durationSec, brief.fps)));
  }

  // ------------------------------------------------------------ new shots, and removed ones the brief changed
  for (const [i, s] of brief.shots.entries()) {
    if (!place.has(s.id)) continue;
    const desk = hostShots(doc, sceneId);
    const frames = briefFrames(s.durationSec, brief.fps);
    const prev = brief.shots
      .slice(0, i)
      .reverse()
      .map((p) => desk.get(p.id))
      .find((x): x is ShotData => !!x);
    const spans = getShots(doc).map(shotSpan);
    let after: number;
    if (prev) after = clearOf(spans, prev.frame_end);
    else {
      const first = [...desk.values()].sort(
        (a, b) => a.frame_start - a.pre_roll - (b.frame_start - b.pre_roll),
      )[0];
      after = clearOf(spans, (first ? first.frame_start - first.pre_roll : doc.getScene().frame_start) - 1);
    }
    warnings.push(...insertSceneTime(doc, after, frames));
    const start = after + 1;
    const end = start + frames - 1;
    const p = plannedShot.get(s.id)!;
    const id = newShotId();
    const name = `Shot ${s.index + 1}`;
    const camera = addDeskCamera(doc, {
      name,
      shotId: id,
      lens: p.camera.lensMm ?? FRAMING_TABLE[p.camera.framing].lens_mm,
    });
    prepareDeskCamera(doc, camera, id);
    const shot: ShotData = {
      id,
      name,
      enabled: true,
      camera,
      frame_start: start,
      frame_end: end,
      notes: shotText(p).slice(0, 2000),
      framing: p.camera.framing,
      angle: null,
      height: null,
      move: shotMove(p, null, warnings),
      lens_mm: p.camera.lensMm ?? null,
      subjects: subjectsOf(s, p.camera.framing, actorId, props),
      layout: layoutOf(s, actorId),
      continuity: s.continuity,
      pre_roll: 0,
      external: { source: 'host', project: null, clip: sceneId, shot: s.id, index: s.index },
    };
    setShots(doc, [...getShots(doc), shot]);
    for (const [cid, o] of actors)
      if (!created.has(cid)) keyVisible(doc, o.id, start, end, shotCast(s).includes(cid));
    solve.add(id);
    const r = recordShot.get(s.id);
    if (r) {
      const sd = shotDiff(s.id);
      const why = [sd.frames && 'length', sd.recast && 'cast', sd.replanned && 'camera plan'].filter(Boolean);
      warnings.push(
        `${name} was removed in the desk; the brief changed its ${why.join(' and ')}, so it is staged again`,
      );
    }
  }

  // ------------------------------------------------------------ kept shots: the brief's fields
  const shotsNow = getShots(doc);
  const byId = new Map(shotsNow.map((s) => [s.id, s]));
  const deskNow = hostShots(doc, sceneId);
  for (const s of brief.shots) {
    const d = deskNow.get(s.id);
    if (!d || place.has(s.id)) continue;
    const r = recordShot.get(s.id);
    const sd = shotDiff(s.id);
    const p = plannedShot.get(s.id)!;
    const next: ShotData = { ...byId.get(d.id)!, external: { ...d.external!, index: s.index } };
    if (!r || d.name === `Shot ${r.index + 1}`) next.name = `Shot ${s.index + 1}`;
    const notes = shotText(p).slice(0, 2000);
    if (!r || digest(d.notes) === r.notes) next.notes = notes;
    else {
      keptNotes.set(s.id, r.notes);
      if (notes !== d.notes && r.text !== shotTextDigest(s))
        warnings.push(`${d.name}: its notes were edited in the desk and are kept; the brief's words changed`);
    }
    const before = r ? r.castIds : [];
    const recast = !r || sd.recast;
    const replanned = !r || sd.replanned;
    if (recast || replanned) {
      next.subjects = subjectsOf(s, p.camera.framing, actorId, props);
      next.layout = layoutOf(s, actorId);
    }
    if (replanned) {
      next.framing = p.camera.framing;
      next.move = shotMove(p, null, warnings);
      next.lens_mm = p.camera.lensMm ?? null;
      next.continuity = s.continuity;
    }
    if (recast) {
      // shown and hidden in the frames it alone covers: another shot's keys are its own
      const span = shotSpan(d);
      const alone = uncoveredRanges(shotsNow.filter((x) => x.id !== d.id).map(shotSpan), span.from, span.to);
      let changed = false;
      for (const [cid, o] of actors) {
        if (created.has(cid)) continue;
        const was = before.includes(cid);
        const is = shotCast(s).includes(cid);
        if (was === is) continue;
        changed = true;
        for (const x of alone) keyVisible(doc, o.id, x.from, x.to, is);
      }
      if (changed && alone.reduce((n, x) => n + x.to - x.from + 1, 0) < span.to - span.from + 1)
        warnings.push(
          `${next.name} overlaps other shots in the desk: its new cast shows only in the frames no other shot covers`,
        );
    }
    byId.set(d.id, next);
    if (recast || replanned || diff.resized) {
      if (d.camera && staged.get(d.camera) === false) {
        warnings.push(
          `${next.name}: its camera was set by hand in the desk and is kept; its ${recast ? 'cast' : replanned ? 'camera plan' : 'frame size'} changed, so check its framing (solve it again with desk.shot_solve)`,
        );
      } else solve.add(d.id);
    }
    // a length the person gave it in the desk stays while the brief does not change its own
    const length = d.frame_end - d.frame_start + 1;
    const wanted = briefFrames(s.durationSec, brief.fps);
    if (length !== wanted)
      warnings.push(
        `${next.name} is ${length} frames long in the desk and ${wanted} in the brief: kept as edited in the desk`,
      );
  }
  // the cut in time order; the brief's order of the shots kept is the desk's
  const ordered = [...byId.values()].sort(
    (a, b) => a.frame_start - b.frame_start || a.id.localeCompare(b.id),
  );
  setShots(doc, ordered);
  const deskOrder = ordered
    .filter((s) => s.external?.source === 'host' && s.external.clip === sceneId && s.external.shot)
    .map((s) => s.external!.shot!);
  const briefOrder = brief.shots.map((s) => s.id).filter((id) => deskOrder.includes(id));
  if (deskOrder.join('\u0000') !== briefOrder.join('\u0000'))
    warnings.push(
      'the brief orders some shots differently from the desk: the desk keeps its cut order (stage the brief in a new project to follow the new order)',
    );
  const last = ordered.reduce((m, s) => Math.max(m, s.frame_end), -Infinity);
  if (Number.isFinite(last) && last > doc.getScene().frame_end) doc.updateScene({ frame_end: last });
  if (!doc.getScene().camera && ordered[0]?.camera) doc.updateScene({ camera: ordered[0].camera });

  // ------------------------------------------------------------ new cast members: shown in their shots only
  const cut = cutOf(doc, brief, actorCast);
  const timelineStart = cut[0]?.keyFrame ?? doc.getScene().frame_start;
  for (const cid of created) {
    const o = doc.getObject(actorId(cid)!)!;
    const hidden = hiddenSpans(holderSpans(cut, cid), cut, timelineStart);
    if (hidden.length) hideSpans(doc, o.id, [o.scale[0], o.scale[1], o.scale[2]], hidden);
  }

  // ------------------------------------------------------------ the set
  if (diff.set) restageSet(doc, blocking, brief, castNames, stamp, sceneId);

  // ------------------------------------------------------------ props
  const plannedProps = new Map(blocking.props.filter((p) => p.elementId).map((p) => [p.elementId!, p]));
  for (const [eid, o] of props)
    if (!plannedProps.has(eid)) {
      for (const x of tetherPartsOf(doc, o.id)) removeTrees(doc, [x]);
      removeTrees(doc, [o.id]);
      props.delete(eid);
    }
  const shotsAfter = brief.shots.map((s) => ({ id: s.id, castIds: shotCast(s) }));
  for (const [eid, p] of plannedProps) {
    const e = elementById.get(eid)!;
    const old = props.get(eid);
    const holder = plan.holders.get(eid) ?? null;
    const flies = holder ? flyerKind(`${p.label} ${e.name}`) : null;
    // a prop the brief did not change stays as the desk has it (also one removed in the desk), but a
    // flight over shots staged again flies again
    const restage =
      diff.props.restage.has(eid) ||
      (flies !== null &&
        holderRuns(shotsAfter, holder)
          .flat()
          .some((id) => place.has(id)));
    if (!restage) continue;
    if (old) for (const x of tetherPartsOf(doc, old.id)) removeTrees(doc, [x]);
    const made = buildProp(
      doc,
      p,
      e.name,
      castNames,
      stamp,
      flies,
      old && doc.getObject(old.id) ? old : undefined,
    );
    const rest = { ...doc.getObject(made.root)!.custom_props };
    delete rest[RIDEO_PROPS.heldBy];
    doc.updateObject(made.root, {
      custom_props: p.heldBy ? { ...rest, [RIDEO_PROPS.heldBy]: p.heldBy } : rest,
    });
    props.set(eid, doc.getObject(made.root)!);
    if (p.heldBy)
      stageHeld(doc, made.root, made.baseScale, p, flies, actors.get(p.heldBy) ?? null, cut, warnings);
  }
  // an insert shot frames its props: subjects of new or replanned inserts may name props made just now
  setShots(
    doc,
    getShots(doc).map((x) => {
      const host = x.external?.source === 'host' && x.external.clip === sceneId ? x.external.shot : null;
      const s = host ? brief.shots.find((b) => b.id === host) : undefined;
      if (!s || !solve.has(x.id)) return x;
      return { ...x, subjects: subjectsOf(s, x.framing ?? 'medium', actorId, props) };
    }),
  );

  // ------------------------------------------------------------ riders the update does not seat
  const desk = hostShots(doc, sceneId);
  for (const s of brief.shots) {
    const d = desk.get(s.id);
    const sd = shotDiff(s.id);
    if (!d || !(place.has(s.id) || sd.reworded || sd.recast)) continue;
    const ids = shotCast(s).filter((cid) => actors.has(cid));
    const kind = (cid: string) => plan.cast.get(cid)?.kind ?? 'adult';
    const pairs = ridersByText(
      [s.description, s.action].filter(Boolean).join('. '),
      ids.filter((cid) => isHumanoid(kind(cid))).map((cid) => ({ id: cid, name: castById.get(cid)!.name })),
      ids
        .filter((cid) => isRideable(kind(cid)))
        .map((cid) => ({ id: cid, name: castById.get(cid)!.name, kind: kind(cid) })),
    );
    for (const pr of pairs) {
      if (ridesAt(doc, actors.get(pr.rider)!.id, actors.get(pr.mount)!.id, d.frame_start)) continue;
      const rider = castById.get(pr.rider)!.name;
      warnings.push(
        `${d.name}: the brief says ${rider} rides ${castById.get(pr.mount)!.name}, but an update does not seat riders: seat ${rider} with desk.actor_mount (frame ${d.frame_start}), or stage the brief in a new project`,
      );
    }
  }

  // ------------------------------------------------------------ cameras, motion records, checks
  if (solve.size)
    solveShotCameras(briefContext(ctx, warnings), [...solve], {
      enforce_line: false,
      fit_plan: true,
      keep_lens: false,
    });
  for (const s of desk.values())
    if (s.camera && (solve.has(s.id) || staged.get(s.camera) === true)) recordMotion(doc, s.camera);
  for (const o of [...actors.values(), ...props.values()])
    if (doc.getObject(o.id) && staged.get(o.id) !== false) recordMotion(doc, o.id);

  const kinds = new Map<string, { kind: ActorKind }>();
  for (const [cid, o] of actors) {
    const k = doc.getObject(o.id)?.custom_props?.[DESK_PROPS.kind];
    kinds.set(cid, { kind: typeof k === 'string' && isActorKind(k) ? k : plan.cast.get(cid)!.kind });
  }
  const next = recordOf(brief, desk, kinds, plan.holders, plan.set, keptNotes, removedKept);
  writeBriefRecord(doc, next);
  const hostOf = new Map([...desk].map(([host, s]) => [s.id, host]));
  const issues = checkShots(doc, { shots: [...desk.values()].map((s) => s.id) }).issues;
  return {
    sceneId,
    hash: next.hash,
    shots: brief.shots
      .filter((s) => desk.has(s.id))
      .map((s) => {
        const d = desk.get(s.id)!;
        return { shotId: s.id, deskShotId: d.id, frames: d.frame_end - d.frame_start + 1, camera: d.camera };
      }),
    cast: plan.order
      .filter((cid) => actors.has(cid))
      .map((cid) => {
        const o = doc.getObject(actors.get(cid)!.id)!;
        const kind = kinds.get(cid)!.kind;
        const planned = plan.cast.get(cid)!;
        return {
          castId: cid,
          object: o.id,
          name: o.name,
          kind,
          reason: planned.kind === kind ? planned.reason : `the ${kind} staged before`,
        };
      }),
    props: [...props].map(([eid, o]) => ({
      elementId: eid,
      object: o.id,
      heldBy: plan.holders.get(eid) ?? null,
    })),
    changes: diff.changes,
    solved: [...desk].filter(([, s]) => solve.has(s.id)).map(([host]) => host),
    warnings,
    issues: briefIssues(issues, hostOf),
  };
}

/** The subjects of brief shot `s`: its cast's actors; an insert's props too. */
function subjectsOf(
  s: BriefShot,
  framing: string,
  actorId: (cid: string) => string | null,
  props: ReadonlyMap<string, ObjectData>,
): string[] {
  const out: string[] = [];
  for (const cid of shotCast(s)) {
    const id = actorId(cid);
    if (id && !out.includes(id)) out.push(id);
  }
  if (framing === 'insert')
    for (const eid of s.elementIds) {
      const p = props.get(eid);
      if (p && !out.includes(p.id)) out.push(p.id);
    }
  return out.slice(0, MAX_SHOT_SUBJECTS);
}

/** The planned layout of brief shot `s` on its actors. */
function layoutOf(s: BriefShot, actorId: (cid: string) => string | null): DeskLayoutEntry[] {
  const out: DeskLayoutEntry[] = [];
  for (const e of s.layout) {
    const id = actorId(e.castId);
    if (id && !out.some((x) => x.subject === id)) out.push({ subject: id, side: e.side, facing: e.facing });
  }
  return out;
}

/** Adds the actor of cast member `cid` on its planned mark (a free spot when an actor stands there). */
function addActor(
  doc: SceneDoc,
  cid: string,
  brief: SceneBrief,
  kind: ActorKind,
  mark: RideoBlockingMark | undefined,
  actors: ReadonlyMap<string, ObjectData>,
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
): string {
  const c = brief.cast.find((x) => x.id === cid)!;
  const taken: RideoBlockingMark[] = [...actors.values()].map((o) => {
    const loc = doc.getObject(o.id)?.location ?? o.location;
    return { x: loc[0], z: -loc[1], facingDeg: 0, pose: 'stand', toX: null, toZ: null };
  });
  const want = mark ?? { x: 0, z: 0, facingDeg: 0, pose: 'stand', toX: null, toZ: null };
  const clear = taken.every((t) => Math.hypot(t.x - want.x, t.z - want.z) >= LAYOUT_SPACING_M / 2);
  const at = clear ? { x: want.x, z: want.z } : freeRowSpot(taken, want.x);
  const heightM = c.heightM && c.heightM > 0 ? c.heightM / rideoHeightRatio(kind) : defaultActorHeight(kind);
  const r = createActor(doc, {
    kind,
    name: c.name,
    color: nextActorColor(doc),
    height_m: heightM,
    location: [at.x, -at.z, 0],
    facing_deg: want.facingDeg,
    pose: editorPose('stand', kind),
    character_id: cid,
  });
  const used = new Set(
    doc
      .listObjects()
      .map((o) => o.custom_props?.[RIDEO_PROPS.id])
      .filter((v): v is string => typeof v === 'string'),
  );
  let n = 1;
  while (used.has(`a${n}`)) n++;
  const o = doc.getObject(r.actor)!;
  doc.updateObject(r.actor, {
    custom_props: stamp({ ...o.custom_props, [RIDEO_PROPS.id]: `a${n}`, [DESK_PROPS.characterId]: cid }),
  });
  return r.actor;
}

/** Holds (or flies) prop `root` by its holder over the shots the holder is in; hidden in the others. */
function stageHeld(
  doc: SceneDoc,
  root: string,
  baseScale: readonly [number, number, number] | number[],
  p: RideoBlockingProp,
  flies: 'kite' | 'balloon' | null,
  holder: ObjectData | null,
  cut: readonly SpanShot[],
  warnings: string[],
): void {
  const timelineStart = cut[0]?.keyFrame ?? doc.getScene().frame_start;
  const scale: [number, number, number] = [baseScale[0], baseScale[1], baseScale[2]];
  const spans = holder ? holderSpans(cut, p.heldBy!) : [];
  if (!holder || !spans.length) {
    hideSpans(doc, root, scale, [{ from: timelineStart, to: null }]);
    return;
  }
  const hidden = hiddenSpans(spans, cut, timelineStart);
  const kindProp = holder.custom_props?.[DESK_PROPS.kind];
  const kind: ActorKind = typeof kindProp === 'string' && isActorKind(kindProp) ? kindProp : 'adult';
  if (flies) {
    const t = flyProp(doc, root, { id: holder.id, kind }, flies, spans, cut, p);
    for (const w of t.warnings) warnings.push(`${doc.getObject(root)!.name}: ${w}`);
    const gaps = hidden.filter((h) => h.to !== null);
    hideSpans(doc, root, scale, gaps);
    if (t.string) hideSpans(doc, t.string, 'keep', gaps);
    for (const tail of t.tail) {
      const s = doc.getObject(tail)?.scale ?? [1, 1, 1];
      hideSpans(doc, tail, [s[0], s[1], s[2]], gaps);
    }
    return;
  }
  for (const span of spans)
    holdProp(doc, holder.id, root, {
      hand: 'right',
      frame: cut[span.from].keyFrame,
      release_frame: cut[span.to + 1]?.keyFrame,
    });
  hideSpans(doc, root, scale, hidden);
}

/** Rebuilds the set as planned: ground, sky or sun, walls, and the landmarks (the water). */
function restageSet(
  doc: SceneDoc,
  blocking: ReturnType<typeof parseRideoBlocking>,
  brief: SceneBrief,
  castNames: readonly string[],
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
  sceneId: string,
): void {
  const set = blocking.set;
  const built = buildSet(doc, {
    width: set.width,
    depth: set.depth,
    ground: set.ground,
    interior: set.interior,
    sun_azimuth_deg: set.sun.azimuthDeg,
    sun_elevation_deg: Math.max(0, Math.min(90, set.sun.elevationDeg)),
    sky: !set.interior,
  });
  const ground = doc.getObject(built.ground);
  if (ground)
    doc.updateObject(built.ground, {
      custom_props: { ...ground.custom_props, [RIDEO_PROPS.ground]: set.ground },
    });
  const old = stagedBy(doc, 'landmark', sceneId, (o) => o.custom_props?.[RIDEO_PROPS.id]);
  const kept = new Set<string>();
  for (const l of set.landmarks) {
    const element = l.elementId ? (brief.elements.find((e) => e.id === l.elementId)?.name ?? null) : null;
    buildLandmark(doc, l, element, castNames, stamp, old.get(l.id));
    kept.add(l.id);
  }
  for (const [rid, o] of old) if (!kept.has(rid) && doc.getObject(o.id)) removeTrees(doc, [o.id]);
}

/**
 * Updates a project staged from a brief (stageBrief) to a later brief of the same scene, in one
 * transaction (one undo step), keeping the staging of what did not change: see the module comment.
 * The report's `changes` say how the brief differed from the one staged before, as briefChanges
 * did (null: nothing to update; the staging stays as it is). Throws an OperatorError (INVALID_PARAMS)
 * for a brief that does not validate, a project not staged from a brief, or one staged from another
 * scene. Runs in a web worker: no DOM, no Node API.
 */
export function updateFromBrief(doc: SceneDoc, brief: SceneBrief): StageBriefReport {
  return doc.transact(() => updateFromBriefIn(docContext(doc), brief));
}
