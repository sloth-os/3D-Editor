import type { SceneDoc } from '../../doc/scene-doc';
import type { DeskLayoutEntry, ObjectData, ShotData } from '../../doc/types';
import type { Mat4 } from '../../math/types';
import { OperatorError, type OperatorContext } from '../../operators/context';
import { solveShotCameras } from '../../operators/desk-shots';
import { checkShots } from '../checks';
import { createActor, defaultActorHeight, holdProp } from '../characters';
import { nextActorColor } from '../characters/actor';
import { attachSpans } from '../characters/attach';
import { createFigureActor, restyleActor } from '../characters/figure';
import { isActorKind } from '../characters/kinds';
import { RIDE_PREFIX } from '../characters/rig';
import { ACTOR_PALETTE, type ActorKind } from '../characters/types';
import { addDeskCamera, prepareDeskCamera, retimeCameraRange } from '../moves';
import { DESK_PROPS } from '../props';
import { buildSet, lightSet, setGround, setUnitRoot } from '../set';
import { unitOf } from '../units/list';
import { hangKept, removeKeeping, type KeptPlaces } from '../units/remove';
import { updateUnit } from '../units/update';
import { FRAMING_TABLE } from '../solver';
import { MAX_SHOT_SUBJECTS, getDeskSettings, getShots, newShotId, setDeskSettings, setShots } from '../shots';
import {
  LAYOUT_SPACING_M,
  RIDEO_PROPS,
  buildLandmark,
  buildProp,
  cameraOwnAsStaged,
  cameraParents,
  dropTether,
  flyProp,
  freeRowSpot,
  hangOnGround,
  hiddenSpans,
  holderSpans,
  hungFromName,
  hungMotion,
  motionDigest,
  ownKeysAsStaged,
  parseRideoBlocking,
  propMove,
  recordMotionOf,
  recordedMotion,
  rideoHeightRatio,
  sameMotion,
  shotMove,
  tetherPartsOf,
  updateCameraHold,
  type SpanShot,
} from '../rideo/import';
import { hideSpans } from '../rideo/keys';
import { editorPose, flyerKind, isHumanoid, isRideable, ridersByText, shotText } from '../rideo/rules';
import { RideoImportInputSchema, type RideoBlockingMark, type RideoBlockingProp } from '../rideo/schema';
import { briefFrames, diffBrief, holderRuns, planWithUnits, resolveBriefUnits } from './changes';
import { adoptLinkedPublishes } from './library';
import { shotCast } from './plan';
import {
  digest,
  readBriefRecord,
  renamedInDesk,
  shotTextDigest,
  writeBriefRecord,
  type BriefRecordShot,
} from './record';
import type { BriefShot, SceneBrief } from './schema';
import {
  briefContext,
  briefIssues,
  docContext,
  figureHook,
  hostShots,
  insertSetUnit,
  parseBrief,
  pinnedFigureHeight,
  propHook,
  recordOf,
  recordPinsOf,
  slotFailed,
  stagedActors,
  stagedBy,
  type StageBriefReport,
} from './stage';
import {
  SET_ROOT_ID,
  UNIT_FACTS_PROP,
  decodeHeld,
  reportRowOf,
  unitWarnings,
  type SetPlanInfo,
  type SlotUnit,
  type StageUnitRow,
  type UnitSource,
} from './units';
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
 * - a new shot is put after the brief's shot before it (before the first shot when it leads), in
 *   time and in the cut (the list: right after that shot, or right before the brief's shot after it
 *   when it leads), its camera solved from its framing and fitted to its planned layout, the cast
 *   not in it hidden; the scene's frame range grows to hold a shot the update puts or lengthens past
 *   its end (one the desk left past it stays so);
 * - a shot removed in the desk stays removed unless the brief changes its length, cast or camera
 *   plan: then it is staged again like a new one (with a warning);
 * - a shot whose cast changed shows its new cast and hides the rest (in the frames it alone covers),
 *   its camera solved again;
 * - a shot whose camera plan changed (framing, movement, lens, move, layout, continuity; a lens or move
 *   the host gives back as staged is no change), or every shot when the render size changed, has its
 *   camera solved again;
 * - a camera set by hand in the desk is never solved again: the update keeps it, and its keys
 *   change only as the ripple changes every curve's keys (timeline.ts), as a new length of its shot
 *   fits its move (moves.ts retimeCameraRange) and, for one hung straight from a piece that goes or
 *   is built anew, as the keyed motion of what the person put on such a piece is kept, below
 *   (units/remove.ts keepMotion); camera data it shares with another shot's camera changes as the
 *   update solves that camera or fits its move (the lens, keyed or as a plain value, the focus
 *   distance's keys and the depth of field: moves.ts CameraKeys, applyCameraMove; the update solves
 *   that camera only while the shared data is as staged, as an edit of it makes that camera count
 *   as set by hand too, and the data's other settings, its sensor among them, stay as they are); it
 *   warns (one hung from or under another object also when what it hangs from was built anew,
 *   staged again or no longer moves in the shot as it did);
 * - a shot's camera hung from (or under) another object keeps its hang unless the update solves it:
 *   one still as staged in a shot it solves, and one the person only hung (rideo/import.ts
 *   cameraOwnAsStaged) from or under a piece the update built anew or staged again that now moves in
 *   the shot otherwise than it did. One only hung counts as set by hand when its shot's cast, camera
 *   plan or frame size changes or a library set is placed, replaced, updated or taken out (kept,
 *   with that warning), unless the update solves it so: then it is not kept, and the warning that
 *   it is set by hand does not name it (the one that it was taken off and solved again does). A
 *   camera it solves stays on what it hangs from while that stands still through the shot, scaled
 *   evenly, not mirrored and shown; off one that moves in the shot, is scaled unevenly or is hidden
 *   by its scale there (one only hung: off one that moves), it is taken off and solved again, for
 *   every shot that uses it (the brief's or the desk's own: none keeps a set-by-hand warning for
 *   it), with a warning naming what the person hung it from and the other shots that use it
 *   (rideo/import.ts updateCameraHold). Solved or not, the camera, or the object of the person's it
 *   hangs under, is also named as no longer following the animation of what went when what takes
 *   its place does not move alike, as when another holder now flies the prop (the kept-objects rule
 *   below: units/remove.ts hangKept);
 * - cast members the brief no longer stages go; new ones stand on a free mark, shown in their shots
 *   (an actor removed in the desk is staged again only for a shot the update stages or recasts); a
 *   member the brief renames is renamed, unless the desk renamed it (it keeps the desk's name, with a
 *   warning): an actor is renamed in the desk when its name is not the one the record keeps of it,
 *   the name staging or an update gave it (made unique, "Guard.001" beside another "Guard", it is
 *   still the desk's own); one whose kind or height the brief changes stays the actor staged, with a
 *   warning;
 * - props whose element went go, new ones are placed, and a held prop whose holder or holder's shots
 *   changed is held (or flown) again; the set is rebuilt when its plan changed;
 * - what the person put on a piece that goes or is built anew (objects of their own below a shot's
 *   camera, an actor, a prop, a landmark, the ground, a wall or the sun: not the piece's own look)
 *   stays where it is in the world, hung from the piece built in its place, or from the set's ground
 *   once the set is staged (a piece that goes with nothing in its place), its keyed motion kept where
 *   it can be, and the warnings name it, also when it no longer follows the animation of what went
 *   (units/remove.ts hangKept);
 * - notes the desk did not edit follow the brief's words; shot names that are the desk's own
 *   ('Shot 3') follow the brief's order;
 * - riders are not seated by an update: a shot it stages, or whose words or cast change, that says
 *   someone rides is staged with the rider beside the mount, with a warning (desk.actor_mount seats
 *   them; staging the brief in a new project mounts them as staging does).
 *
 * The cut order (the shot list's) of the shots the desk keeps is the desk's: an update does not
 * change it, also when the person reordered the shots in the desk (desk.shot_move), and warns when
 * the brief now orders them otherwise than it did and the desk does not: stage the brief in a new
 * project to follow a new order. A brief that changes nothing the update acts on (briefChanges null)
 * leaves the staging as it is (changes.ts).
 *
 * Library pins (brief/units.ts; `units`, the units the desk holds) act per slot:
 * - the set: a unit placed takes the place of the words' set (its ground, walls and landmarks go) and
 *   is lit; a new version updates the instance (its root and the parts not edited here keep their
 *   ids); another item replaces it; no pin brings the words' set back. The cameras still as staged
 *   are solved again (one set by hand is kept, with a warning) when the slot changed the scene's
 *   set: a set placed, replaced or taken out, or a version that changes a part of it (not one with
 *   the same content, or whose changes all fall on parts edited here, which are kept). A set that
 *   does not go in leaves the scene's set, and the set the record keeps of it, as they were (a later
 *   brief is told from the set the scene has); its report row names the set's root only while a
 *   set instance stands there or the set was made local (an object of the person's at that id is
 *   not the set);
 * - a figure restyles its member's actor in place (same armature, keys, holds, shots) when its kind
 *   and height are the actor's; a member the update adds stands as the figure; no pin brings back the
 *   mannequin of the actor's kind and height (another kind or height is refused and the actor kept:
 *   rebuilding it is left to staging the brief in a new project);
 * - a prop unit replaces the element's prop, or updates it to a new version of the same item (its
 *   root id stays; a version whose root is another type of object than the instance's replaces it,
 *   as another item does), held or flown again; no pin brings back the words' prop. One that does
 *   not go in leaves the prop the desk has as it is (its keys, its hold or flight and its string,
 *   with what hangs on it) when the brief gives no other reason to stage the prop again; otherwise,
 *   or when the desk removed the prop, the prop is staged as without the unit (the version placed
 *   before, or the words' prop), as its slot's warning says;
 * - a unit not held changes nothing (the words, or the version placed, stay), a slot made local stays
 *   local, a refused pin is not tried again; the record says what each slot holds;
 * - a unit saved to the host's library from a slot whose answer the desk did not take in (library.ts
 *   pendingPublishes), and which the brief now pins there, is adopted first: the scene's objects it
 *   was made from become the instance (no copy of them goes in beside them), as the answer would
 *   have made them (library.ts adoptLinkedPublishes).
 */

/** Whether object `id` animates as the desk last staged it (its recorded motion digest). */
function asStaged(doc: SceneDoc, id: string): boolean {
  const recorded = recordedMotion(doc.getObject(id)).all;
  return recorded !== null && recorded === motionDigest(doc, id);
}

/** Records what object `id` animates as now, as staged by the desk. */
function recordMotion(doc: SceneDoc, id: string): void {
  recordMotionOf(doc, id);
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
export function updateFromBriefIn(
  ctx: OperatorContext,
  raw: unknown,
  opts: { units?: UnitSource } = {},
): StageBriefReport {
  const brief = parseBrief(raw);
  const doc = ctx.doc;
  const recorded = readBriefRecord(doc);
  if (!recorded)
    throw new OperatorError(
      `the project is not staged from a brief: stage scene '${brief.id}' first (stageBrief, desk.stage_brief)`,
      'INVALID_PARAMS',
    );
  if (recorded.sceneId !== brief.id)
    throw new OperatorError(
      `the project is staged from scene '${recorded.sceneId}', not '${brief.id}': stage this brief in another project`,
      'INVALID_PARAMS',
    );
  const sceneId = brief.id;
  const source = opts.units ?? null;
  // units saved to the host's library from this scene that the brief now pins (the host linked them
  // after the desk stopped waiting for its answer): the scene's own objects become the instances
  const late = adoptLinkedPublishes(doc, brief, source);
  const record = late.adopted.length ? readBriefRecord(doc)! : recorded;
  // the library units: what is held of each pin, decoded for the slots the update places
  const units = resolveBriefUnits(doc, brief, record, source);
  decodeHeld(units, source);
  const plan = planWithUnits(doc, brief, units);
  const diff = diffBrief(doc, record, brief, plan, units);
  const done = new Set<string>();
  const input = RideoImportInputSchema.parse(plan.input);
  const blocking = parseRideoBlocking(input.blocking ?? {});
  const plannedShot = new Map(input.shots.map((s) => [s.id, s]));
  const castById = new Map(brief.cast.map((c) => [c.id, c]));
  const elementById = new Map(brief.elements.map((e) => [e.id, e]));
  const recordShot = new Map(record.shots.map((s) => [s.id, s]));
  const recordCast = new Map(record.cast.map((c) => [c.id, c]));
  const warnings: string[] = [...plan.warnings, ...late.warnings, ...unitWarnings(units)];
  const stamp = (o: Record<string, string | number | boolean>) => ({ ...o, [RIDEO_PROPS.clip]: sceneId });
  const castNames = plan.order.map((id) => castById.get(id)!.name);
  const solve = new Set<string>();
  const keptNotes = new Map<string, string>();
  const shotDiff = (id: string) => diff.shots.get(id)!;

  // ------------------------------------------------------------ what is staged now
  const actors = stagedActors(doc, sceneId);
  const props = stagedBy(doc, 'prop', sceneId, (o) => o.custom_props?.[DESK_PROPS.elementId]);
  const staged = new Map<string, boolean>();
  // whether each shot's camera is as the staging left it but for where the person hung it (its keys
  // and its lens's, its settings, constraints and what hangs below it: cameraOwnAsStaged), read
  // before a ripple or a kept hang moves its keys: one the person only hung from another object was
  // not set by hand
  const ownCamera = new Map<string, boolean>();
  for (const s of hostShots(doc, sceneId).values())
    if (s.camera) {
      staged.set(s.camera, asStaged(doc, s.camera));
      ownCamera.set(s.camera, cameraOwnAsStaged(doc, s.camera));
    }
  for (const o of [...actors.values(), ...props.values()]) staged.set(o.id, asStaged(doc, o.id));
  // whether each prop's own transform channels carry only the keys the staging wrote, read before
  // anything moves them (a ripple below shifts the staging's keys and the person's alike): a prop the
  // person keyed too moves by those keys, which go with it when the words build it anew
  const ownStaged = new Map<string, boolean>();
  for (const o of props.values()) ownStaged.set(o.id, ownKeysAsStaged(doc, o.id));
  // the props this update builds or stages again (their animation is the staging's anew)
  const restagedProps = new Set<string>();
  // what each shot's camera hangs from before any piece is built anew (a camera on the old piece
  // hangs from the new one then): what the warnings name as what the person hung it from
  const hungBefore = cameraParents(doc);
  // the warnings that keep a shot's camera as set by hand (where in `warnings`, by desk shot): its
  // shot's cast, camera plan or frame size changed or a library set was placed, replaced, updated
  // or taken out, or (the camera loop below) what it hangs from was built anew, staged again or
  // moves otherwise. One the camera loop takes off and solves after all is not kept, and those
  // warnings go, for every shot that uses it
  const keptByHand = new Map<string, number[]>();
  const keepByHand = (shot: string, warning: string) =>
    keptByHand.set(shot, [...(keptByHand.get(shot) ?? []), warnings.push(warning) - 1]);
  const deskBefore = hostShots(doc, sceneId);
  // where what each shot's camera hangs from is at each frame of the shot (hungMotion), and the
  // objects there are, read before anything is built or staged anew: whether that still moves in the
  // shot as it did, and which piece the update built in the place of what a camera hung from
  const motionBefore = new Map<string, { camera: string; worlds: Mat4[] }>();
  for (const s of deskBefore.values()) {
    const worlds = hungMotion(doc, s);
    if (worlds) motionBefore.set(s.id, { camera: s.camera!, worlds });
  }
  const objectsBefore = new Set(motionBefore.size ? doc.listObjects().map((o) => o.id) : []);
  // the shots past the scene's last frame (a range the person shortened in the desk stays so)
  const sceneEnd = doc.getScene().frame_end;
  const pastEnd = new Set(getShots(doc).flatMap((s) => (s.frame_end > sceneEnd ? [s.id] : [])));
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
  // what the person put on the cameras and actors that go stays, hung from the set's ground once the
  // set is staged (it may be built anew below)
  const dropped: { kept: KeptPlaces; gone: string }[] = [];
  const drop = (id: string) => {
    const name = doc.getObject(id)?.name ?? id;
    dropped.push({ kept: removeKeeping(doc, [id]), gone: `'${name}'` });
  };
  if (gone.length) {
    const goneIds = new Set(gone.map((s) => s.id));
    const keep = getShots(doc).filter((x) => !goneIds.has(x.id));
    setShots(doc, keep);
    for (const s of gone)
      if (s.camera && doc.getObject(s.camera) && !keep.some((x) => x.camera === s.camera)) drop(s.camera);
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
      drop(o.id);
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
    const slot = units.cast.get(cid);
    const figure = figureHook(slot);
    const added = addActor(
      doc,
      cid,
      brief,
      plan.cast.get(cid)!.kind,
      plan.marks.get(cid),
      actors,
      stamp,
      figure,
      pinnedFigureHeight(brief, slot),
    );
    if (figure && added.failed === undefined) done.add(figure.key);
    else if (slot && figure) warnings.push(...slotFailed(slot, added.failed, done));
    actors.set(cid, doc.getObject(added.id)!);
    created.add(cid);
  }
  // the name each actor has as the desk staged it, for the record: what a later update tells a name
  // given in the desk from (an actor made unique, "Guard.001" beside another "Guard", is not renamed)
  const actorNames = new Map<string, string>();
  for (const [cid, o] of actors) {
    const c = castById.get(cid)!;
    if (created.has(cid)) {
      actorNames.set(cid, doc.getObject(o.id)!.name);
      continue;
    }
    // a name the brief changed: the actor takes it, unless the desk renamed it (its name stays)
    const was = recordCast.get(cid);
    const inDesk = was !== undefined && renamedInDesk(o.name, was);
    let name = o.name;
    if (was && was.name !== c.name && o.name !== c.name) {
      if (!inDesk) name = doc.rename('objects', o.id, c.name);
      else
        warnings.push(
          `${o.name} keeps the name it was given in the desk; the brief renamed ${was.name} to ${c.name}`,
        );
    }
    // a name given in the desk stays the desk's (the staged one is kept), unless it is the brief's
    actorNames.set(cid, was && inDesk && name !== c.name ? (was.actorName ?? was.name) : name);
    const kind = o.custom_props?.[DESK_PROPS.kind];
    const now = plan.cast.get(cid)!.kind;
    if (typeof kind === 'string' && kind !== now)
      warnings.push(
        `${c.name} now reads as a ${now} but stays the ${kind} staged before (its keys kept): stage the brief in a new project to rebuild it`,
      );
    // a library figure's height is the figure's
    if (was && was.heightM !== undefined && was.heightM !== c.heightM && !plan.units.figures.has(cid)) {
      const height = (h: number | null) => (h === null ? 'unset' : `${h} m`);
      warnings.push(
        `${c.name}'s height in the brief is now ${height(c.heightM)} (${height(was.heightM)} before), but the actor keeps the height it was staged with: stage the brief in a new project to rebuild it`,
      );
    }
  }
  // library figures on the actors the update keeps: a new look in place, or the mannequin again (a
  // figure that does not go in leaves the actor's look as it is, its slot saying why)
  for (const [cid, slot] of units.cast) {
    const actor = actors.get(cid);
    if (!actor || created.has(cid) || slot.action === 'none') continue;
    const name = castById.get(cid)?.name ?? actor.name;
    try {
      if (slot.action === 'remove') {
        const color = ACTOR_PALETTE[Math.max(0, plan.order.indexOf(cid)) % ACTOR_PALETTE.length];
        const r = restyleActor(doc, actor.id, { mannequin: { color } });
        warnings.push(...r.warnings.map((w) => `${name}: ${w}`));
      } else if (slot.payload) {
        const r = restyleActor(doc, actor.id, { figure: slot.payload, pin: slot.pin!, key: slot.key });
        warnings.push(...r.warnings.map((w) => `${name}: ${w}`));
        done.add(slot.key);
      }
    } catch (err) {
      warnings.push(...slotFailed(slot, err, done));
    }
    actors.set(cid, doc.getObject(actor.id)!);
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
    const following = brief.shots
      .slice(i + 1)
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
    // in the cut next to its brief neighbours: right after the brief's shot before it, else right
    // before the brief's shot after it (the desk's own order of the others stays)
    const list = getShots(doc);
    const neighbour = list.findIndex((x) => x.id === (prev ?? following)?.id);
    const at = neighbour < 0 ? list.length : prev ? neighbour + 1 : neighbour;
    setShots(doc, [...list.slice(0, at), shot, ...list.slice(at)]);
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
        keepByHand(
          d.id,
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
  // the cut order is the desk's: the shots it kept stay where it has them (also an order the person
  // gave them in the desk), the new ones went in next to their brief neighbours
  const ordered = [...byId.values()];
  // (written only when something changed: an update that changes nothing writes nothing)
  if (JSON.stringify(ordered) !== JSON.stringify(shotsNow)) setShots(doc, ordered);
  // a brief that now orders the shots the desk kept otherwise than it did, which the desk does not follow
  const kept = new Set(
    brief.shots.filter((s) => deskBefore.has(s.id) && recordShot.has(s.id)).map((s) => s.id),
  );
  const order = (ids: readonly string[]) => [...new Set(ids.filter((id) => kept.has(id)))].join('\u0000');
  const briefOrder = order(brief.shots.map((s) => s.id));
  const deskOrder = order(
    ordered.flatMap((s) =>
      s.external?.source === 'host' && s.external.clip === sceneId && s.external.shot
        ? [s.external.shot]
        : [],
    ),
  );
  if (briefOrder !== order(record.shots.map((s) => s.id)) && briefOrder !== deskOrder)
    warnings.push(
      'the brief orders some shots differently from the desk: the desk keeps its cut order (stage the brief in a new project to follow the new order)',
    );
  // the scene's range grows to hold a shot the update put or lengthened past its end; a shot the desk
  // left past it (a range shortened by hand) does not make it grow
  const end = doc.getScene().frame_end;
  const grown = ordered.filter((s) => s.frame_end > end && !pastEnd.has(s.id));
  if (grown.length) doc.updateScene({ frame_end: Math.max(...grown.map((s) => s.frame_end)) });
  if ((place.size || gone.length) && !doc.getScene().camera && ordered[0]?.camera)
    doc.updateScene({ camera: ordered[0].camera });

  // ------------------------------------------------------------ new cast members: shown in their shots only
  const cut = cutOf(doc, brief, actorCast);
  const timelineStart = cut[0]?.keyFrame ?? doc.getScene().frame_start;
  for (const cid of created) {
    const o = doc.getObject(actorId(cid)!)!;
    const hidden = hiddenSpans(holderSpans(cut, cid), cut, timelineStart);
    if (hidden.length) hideSpans(doc, o.id, [o.scale[0], o.scale[1], o.scale[2]], hidden);
  }

  // ------------------------------------------------------------ the set
  const setSlot = units.set;
  const setAction = setSlot?.action ?? 'none';
  // whether the library set's slot changed the scene's set: a set placed, replaced or taken out, or a
  // version that changes a part of it (not one with the same content, or whose changes all fall on
  // parts edited here, which are kept); a set that does not go in changes nothing
  let setChanged = false;
  if (setSlot && (setAction === 'place' || setAction === 'replace' || setAction === 'update')) {
    // a set that does not go in (its update or insert throws before writing anything) leaves the
    // slot as it was, saying why; the rest of the update goes on
    try {
      let parts = true;
      if (setAction === 'update') {
        const root = setSlot.inst!.root;
        const rep = updateUnit(doc, root, setSlot.payload!, setSlot.pin!);
        parts = rep.updated.length + rep.added.length + rep.removed.length > 0;
        warnings.push(...rep.warnings.map((w) => `the library set: ${w}`));
        const info = setSlot.held!.info as SetPlanInfo;
        const o = doc.getObject(root)!;
        doc.updateObject(root, {
          custom_props: {
            ...o.custom_props,
            [RIDEO_PROPS.ground]: info.ground,
            [UNIT_FACTS_PROP]: JSON.stringify(info),
          },
        });
      } else {
        // the words' set (or the library set before) goes, in the insert's own transaction: the
        // library set is the place; what the person put on what goes stays, on the set's root
        const placed = insertSetUnit(doc, sceneId, setSlot, [
          ...(setAction === 'replace' ? [setSlot.inst!.root] : []),
          ...wordSet(doc, sceneId),
        ]);
        warnings.push(...placed.warnings.map((w) => `the library set: ${w}`));
      }
      warnings.push(...relightSet(doc, blocking));
      done.add(setSlot.key);
      setChanged = parts;
    } catch (err) {
      warnings.push(...slotFailed(setSlot, err, done));
    }
  } else if (setSlot && setAction === 'remove') {
    // the words' set comes back; what the person put on the library set (objects of their own below
    // it, not its parts) stays, hung from the words' ground where it is in the world
    setChanged = true;
    const kept = removeKeeping(doc, [setSlot.inst!.root]);
    const staged = restageSet(doc, blocking, brief, castNames, stamp, sceneId);
    warnings.push(
      ...staged.warnings,
      ...hangKept(doc, staged.ground, kept, { of: 'the library set', on: "the words' ground" }).map(
        (w) => `the set: ${w}`,
      ),
    );
  } else if (diff.set) {
    // a library set (or one made local) is relit; the words' set is built again
    if (plan.set.unit) warnings.push(...relightSet(doc, blocking));
    else warnings.push(...restageSet(doc, blocking, brief, castNames, stamp, sceneId).warnings);
  }
  // the set is staged: what stays of the cameras and actors that went hangs from its ground
  for (const d of dropped) warnings.push(...hangOnGround(doc, d.kept, d.gone, setGround(doc)));
  // the cameras still as staged see the new set: solved again (one set by hand is kept). A library
  // set that did not go in (slotFailed made its action 'none'), or a version that changes none of
  // its parts, left the set as it was: no camera sees a new set then
  if (setChanged)
    for (const d of hostShots(doc, sceneId).values()) {
      if (!d.camera || solve.has(d.id)) continue;
      if (staged.get(d.camera) === false)
        keepByHand(
          d.id,
          `${d.name}: its camera was set by hand in the desk and is kept; the set changed, so check its framing (solve it again with desk.shot_solve)`,
        );
      else solve.add(d.id);
    }

  // ------------------------------------------------------------ props
  const plannedProps = new Map(blocking.props.filter((p) => p.elementId).map((p) => [p.elementId!, p]));
  // a prop whose element went goes with its string, but for what the person put on them, which
  // stays on the set's ground
  for (const [eid, o] of props)
    if (!plannedProps.has(eid)) {
      if (doc.getObject(o.id)) {
        const kept = removeKeeping(doc, [o.id, ...tetherPartsOf(doc, o.id)]);
        warnings.push(...hangOnGround(doc, kept, `'${doc.getObject(o.id)?.name ?? o.name}'`));
      }
      props.delete(eid);
    }
  const shotsAfter = brief.shots.map((s) => ({ id: s.id, castIds: shotCast(s) }));
  for (const [eid, p] of plannedProps) {
    const e = elementById.get(eid)!;
    const old = props.get(eid);
    const holder = plan.holders.get(eid) ?? null;
    const flies = holder ? flyerKind(`${p.label} ${e.name}`) : null;
    // a prop the brief did not change stays as the desk has it (also one removed in the desk), but a
    // flight over shots staged again flies again. The words' own reasons to stage it again (its
    // element or holder, a flight over shots staged again) are told from its library prop's slot
    // acting alone (bySlot), which stages it again only once its unit goes in
    const words =
      (diff.props.restage.has(eid) && !diff.props.bySlot.has(eid)) ||
      (flies !== null &&
        holderRuns(shotsAfter, holder)
          .flat()
          .some((id) => place.has(id)));
    if (!words && !diff.props.bySlot.has(eid)) continue;
    const current = old && doc.getObject(old.id) ? old : undefined;
    const slot = units.elements.get(eid);
    // the element's library prop: placed, updated or replaced; kept (another version not held, made
    // local); none any more (the words' prop again). One that does not go in is staged as without it
    // (buildProp: the version placed before, or the words' prop) when the words stage the prop again
    // or the desk has no prop for it (removed there), as its slot's warning says; for its slot alone
    // it leaves the prop the desk has as it is (its keys, its hold or flight and its string)
    const unit = slot?.action === 'remove' ? null : propHook(doc, slot, current?.id ?? null);
    const alone = !words && !!unit?.unit && !!current;
    // the string and tail of the flight before go (a flight flown again makes new ones): for the
    // slot alone once its unit went in
    if (old && !alone) warnings.push(...dropTether(doc, old.id));
    if (unit?.unit) done.add(unit.key);
    // stageHeld below holds or flies it while its holder has an actor in a shot, else hides it
    const holderActor = p.heldBy ? actors.get(p.heldBy) : undefined;
    const move = propMove(p, flies, !!holderActor && holderSpans(cut, p.heldBy!).length > 0);
    const byHand = !!current && ownStaged.get(current.id) === false;
    let made: ReturnType<typeof buildProp>;
    try {
      made = buildProp(doc, p, e.name, castNames, stamp, flies, move, current, unit, byHand, !alone);
    } catch (err) {
      // a unit for the slot alone that does not go in (it throws before writing anything)
      if (!alone || !slot) throw err;
      warnings.push(...slotFailed(slot, err, done));
      continue;
    }
    if (old && alone) warnings.push(...dropTether(doc, old.id));
    restagedProps.add(made.root);
    if (slot && made.failed !== undefined) warnings.push(...slotFailed(slot, made.failed, done));
    for (const w of made.warnings ?? []) warnings.push(`${doc.getObject(made.root)!.name}: ${w}`);
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
  if (solve.size)
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
  // a shot's camera hung from (or under) another object is taken off it only when this update
  // solves it: solveShotCameras keys it in that object's space, between whose keys it would drift
  // if that moves (rideo/import.ts updateCameraHold, which takes it off one that moves in the shot,
  // is scaled unevenly or is hidden there; on one that stands still, evenly scaled, it stays and
  // the solve keys it in its space). One it takes off is solved again for every shot that uses it,
  // the brief's or the desk's own (a later one skips it here, as it no longer hangs), as their keys
  // on it were in that object's space too: none of them keeps a warning that it is kept as set by
  // hand, and the warning that it was taken off names them. The update solves one whose shot it
  // solves (a camera still as staged), and one the person only hung (not set by hand:
  // cameraOwnAsStaged) from or under a piece it built anew or staged again that now moves in the
  // shot otherwise than it did: it would ride a motion no one framed (taken off only when what it
  // hangs from moves in the shot), also when its shot's cast, camera plan or frame size changed or
  // a library set was placed, replaced, updated or taken out, which kept it as set by hand above:
  // it is not kept then, and the warning that it was taken off and solved names it, not one that it
  // is set by hand (those go: notKept). Any other keeps its hang as the kept-objects rules
  // (hangKept) left it, on the piece built in place of what it hung from. Those rules name the
  // camera, or the object of the person's it hangs under, solved or not, when it no longer follows
  // the animation of what went (what took the piece's place does not move alike, as when another
  // holder now flies the prop). One the person set by hand, or one recorded without an own part (an
  // older desk's record: cameraOwnAsStaged is false), is not solved here: kept with its keys as the
  // ripple, the fit to a new length of its shot (resizeShot) and those rules (keepMotion) left
  // them, with a warning when what it hangs from was built anew, staged again or moves otherwise;
  // camera data it shares with another shot's camera changes as the update solves that camera or
  // fits its move. One recorded so that is still as staged is solved below for each shot of it the
  // update solves, which went into solve above or, when this loop takes the camera off for one of
  // them, here, and is recorded anew
  const notKept = new Set<number>();
  for (const s of desk.values()) {
    const cam = s.camera ? doc.getObject(s.camera) : null;
    if (!cam?.parent) continue;
    const was = hungBefore.get(cam.id);
    // the other shots that use the camera: solved with it when it is taken off (tookOff)
    const others = getShots(doc).filter((x) => x.id !== s.id && x.camera === cam.id);
    const also = others.map((x) => x.name);
    const tookOff = (off: boolean) => {
      if (!off) return;
      for (const x of [s, ...others]) {
        solve.add(x.id);
        for (const i of keptByHand.get(x.id) ?? []) notKept.add(i);
      }
    };
    if (solve.has(s.id)) {
      tookOff(updateCameraHold(doc, s, was, warnings, { also }));
      continue;
    }
    if (!was) continue;
    const parent = doc.getObject(cam.parent)!;
    // what it hangs from is a piece built in the place of what the person hung it from, or it hangs
    // under one this update built anew or staged again
    const builtNow = was.id !== parent.id && !objectsBefore.has(parent.id);
    const restaged =
      builtNow || [...restagedProps].some((root) => root !== cam.id && doc.isAncestor(root, cam.id));
    const before = motionBefore.get(s.id);
    const now = before?.camera === cam.id ? hungMotion(doc, s) : null;
    const moved = !!before && !!now && !sameMotion(before.worlds, now);
    if (ownCamera.get(cam.id) === true) {
      if (restaged && moved) tookOff(updateCameraHold(doc, s, was, warnings, { moving: true, also }));
    } else if (restaged || moved) {
      const from = was.id === parent.id || builtNow ? hungFromName(doc, parent, was) : `'${parent.name}'`;
      // (as kept by hand: the pass of another shot that uses the camera and takes it off after all
      // drops it)
      keepByHand(
        s.id,
        `${s.name}: its camera was set by hand in the desk and is kept; what it hangs from, ${from}, ${
          moved ? 'no longer moves as it did' : 'was staged anew'
        }, so check its framing (solve it again with desk.shot_solve)`,
      );
    }
  }
  // (from the last, so that the places of the others hold)
  for (const i of [...notKept].sort((a, b) => b - a)) warnings.splice(i, 1);
  if (solve.size)
    solveShotCameras(briefContext(ctx, warnings), [...solve], {
      enforce_line: false,
      fit_plan: true,
      keep_lens: false,
    });
  // the camera of a brief's shot the update solved, or one still as staged, is recorded anew, own
  // part included (an older desk's record gains it, so a later update can tell a hang); one the
  // person only hung keeps its own record as the staging's (a ripple or its kept hang may have
  // moved its keys); one they set by hand stays theirs
  for (const s of desk.values())
    if (s.camera && (solve.has(s.id) || staged.get(s.camera) === true)) recordMotion(doc, s.camera);
    else if (s.camera && ownCamera.get(s.camera) === true)
      recordMotionOf(doc, s.camera, { all: false, own: true });
  for (const o of actors.values())
    if (doc.getObject(o.id) && staged.get(o.id) !== false) recordMotion(doc, o.id);
  // a prop's own keys are the staging's when they were at the start (a ripple moved them with the
  // rest) or when this update staged it again; the person's keys on one it left stay theirs
  for (const o of props.values())
    if (doc.getObject(o.id))
      recordMotionOf(doc, o.id, {
        all: staged.get(o.id) !== false,
        own: ownStaged.get(o.id) !== false || restagedProps.has(o.id),
      });

  const kinds = new Map<string, { kind: ActorKind; actorName?: string }>();
  for (const [cid, o] of actors) {
    const k = doc.getObject(o.id)?.custom_props?.[DESK_PROPS.kind];
    kinds.set(cid, {
      kind: typeof k === 'string' && isActorKind(k) ? k : plan.cast.get(cid)!.kind,
      actorName: actorNames.get(cid),
    });
  }
  const planned = recordOf(
    brief,
    desk,
    kinds,
    plan.holders,
    plan.set,
    keptNotes,
    removedKept,
    recordPinsOf(units, done),
  );
  // a library set that did not go in left the scene's set as it was: the record keeps that set's
  // digest (the plan's is of a set never built), so that a later brief is told from the set the
  // scene has
  const setFailed = setSlot !== null && setAction !== 'none' && setSlot.action === 'none';
  const next = setFailed ? { ...planned, set: record.set } : planned;
  writeBriefRecord(doc, next);
  const objectOf = (s: SlotUnit): string | null =>
    'set' in s.slot
      ? (setUnitRoot(doc) ?? (s.local && doc.getObject(SET_ROOT_ID()) ? SET_ROOT_ID() : null))
      : 'castId' in s.slot
        ? actorId(s.slot.castId)
        : (props.get(s.slot.elementId)?.id ?? null);
  const unitRows = units.all
    .map((s) => reportRowOf(s, objectOf(s), done.has(s.key)))
    .filter((x): x is StageUnitRow => x !== null);
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
    units: unitRows,
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

/**
 * Adds the actor of cast member `cid` on its planned mark (a free spot when an actor stands there):
 * its library figure (`figure`), else a mannequin of the figure's height when its figure is pinned
 * but not placed (`pinnedHeight`, the desk's own), else one of the brief's height. A figure that does
 * not go in (`failed`: the error; nothing of it is left) stands as the mannequin of its own kind,
 * height and colour.
 */
function addActor(
  doc: SceneDoc,
  cid: string,
  brief: SceneBrief,
  kind: ActorKind,
  mark: RideoBlockingMark | undefined,
  actors: ReadonlyMap<string, ObjectData>,
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
  figure?: ReturnType<typeof figureHook>,
  pinnedHeight?: number,
): { id: string; failed?: unknown } {
  const c = brief.cast.find((x) => x.id === cid)!;
  const taken: RideoBlockingMark[] = [...actors.values()].map((o) => {
    const loc = doc.getObject(o.id)?.location ?? o.location;
    return { x: loc[0], z: -loc[1], facingDeg: 0, pose: 'stand', toX: null, toZ: null };
  });
  const want = mark ?? { x: 0, z: 0, facingDeg: 0, pose: 'stand', toX: null, toZ: null };
  const clear = taken.every((t) => Math.hypot(t.x - want.x, t.z - want.z) >= LAYOUT_SPACING_M / 2);
  const at = clear ? { x: want.x, z: want.z } : freeRowSpot(taken, want.x);
  const heightM =
    pinnedHeight ??
    (c.heightM && c.heightM > 0 ? c.heightM / rideoHeightRatio(kind) : defaultActorHeight(kind));
  // a library figure is the member: its own kind, height and colour
  let failed: unknown;
  let r: { actor: string } | null = null;
  if (figure)
    try {
      r = createFigureActor(doc, figure.unit, {
        pin: figure.pin,
        key: figure.key,
        name: c.name,
        location: [at.x, -at.z, 0],
        facing_deg: want.facingDeg,
        pose: editorPose('stand', figure.kind),
        character_id: cid,
      });
    } catch (err) {
      failed = err;
    }
  r ??= createActor(doc, {
    kind: figure ? figure.kind : kind,
    name: c.name,
    color: figure ? figure.color : nextActorColor(doc),
    height_m: figure ? figure.heightM : heightM,
    location: [at.x, -at.z, 0],
    facing_deg: want.facingDeg,
    pose: editorPose('stand', figure ? figure.kind : kind),
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
  return { id: r.actor, ...(failed === undefined ? {} : { failed }) };
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

/**
 * Rebuilds the set as planned: ground, sky or sun, walls, and the landmarks (the water). What the
 * person put on a piece built anew stays on the new one, and on the ground when its landmark goes.
 * Returns the ground (a library set's root while the scene holds one) and the warnings naming what
 * stays.
 */
function restageSet(
  doc: SceneDoc,
  blocking: ReturnType<typeof parseRideoBlocking>,
  brief: SceneBrief,
  castNames: readonly string[],
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
  sceneId: string,
): { ground: string; warnings: string[] } {
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
  const warnings = [...built.warnings];
  // a library set (an instance with key 'set', pinned or not) keeps its ground and pieces: lit only
  if (setUnitRoot(doc)) return { ground: built.ground, warnings };
  const ground = doc.getObject(built.ground);
  if (ground)
    doc.updateObject(built.ground, {
      custom_props: { ...ground.custom_props, [RIDEO_PROPS.ground]: set.ground },
    });
  // a library unit's pieces are never an old landmark of the words'
  const old = new Map(
    [...stagedBy(doc, 'landmark', sceneId, (o) => o.custom_props?.[RIDEO_PROPS.id])].filter(
      ([, o]) => unitOf(doc, o.id) === null,
    ),
  );
  const kept = new Set<string>();
  for (const l of set.landmarks) {
    const element = l.elementId ? (brief.elements.find((e) => e.id === l.elementId)?.name ?? null) : null;
    const made = buildLandmark(doc, l, element, castNames, stamp, old.get(l.id));
    for (const w of made.warnings ?? []) warnings.push(`${made.name}: ${w}`);
    kept.add(l.id);
  }
  // a landmark the words drop goes, but for what the person put on it, which stays on the ground
  for (const [rid, o] of old)
    if (!kept.has(rid) && doc.getObject(o.id))
      warnings.push(...hangOnGround(doc, removeKeeping(doc, [o.id]), `'${o.name}'`, built.ground));
  return { ground: built.ground, warnings };
}

/**
 * Lights a set planned from a library unit (or made local) and records its size and interior: its
 * ground and pieces stay. Returns the warnings naming what the person put on the sun lamp lit anew.
 */
function relightSet(doc: SceneDoc, blocking: ReturnType<typeof parseRideoBlocking>): string[] {
  const set = blocking.set;
  const lit = lightSet(doc, {
    sun_azimuth_deg: set.sun.azimuthDeg,
    sun_elevation_deg: Math.max(0, Math.min(90, set.sun.elevationDeg)),
    sky: !set.interior,
  });
  setDeskSettings(doc, { set_width: set.width, set_depth: set.depth, interior: set.interior });
  return lit.warnings;
}

/**
 * The words' set of scene `sceneId`: its ground and walls and its landmarks, never an object inside
 * a library unit instance. A library set placed takes them out with what only they used (insertUnit's
 * `remove`: their meshes and materials).
 */
function wordSet(doc: SceneDoc, sceneId: string): string[] {
  const ground = doc
    .listObjects()
    .filter(
      (o) =>
        o.custom_props?.[DESK_PROPS.role] === 'set' &&
        (o.custom_props?.[DESK_PROPS.label] === 'ground' || o.custom_props?.[DESK_PROPS.label] === 'wall') &&
        unitOf(doc, o.id) === null,
    );
  const landmarks = [
    ...stagedBy(doc, 'landmark', sceneId, (o) => o.custom_props?.[RIDEO_PROPS.id]).values(),
  ].filter((o) => unitOf(doc, o.id) === null);
  return [...ground, ...landmarks].map((o) => o.id);
}

/**
 * Updates a project staged from a brief (stageBrief) to a later brief of the same scene, in one
 * transaction (one undo step), keeping the staging of what did not change: see the module comment.
 * The report's `changes` say how the brief differed from the one staged before, as briefChanges
 * did (null: nothing to update; the staging stays as it is). Throws an OperatorError (INVALID_PARAMS)
 * for a brief that does not validate, a project not staged from a brief, or one staged from another
 * scene. `units`: the library units the desk holds for the brief's pins (see the module comment;
 * without it a pin's unit counts as not held). Runs in a web worker: no DOM, no Node API.
 */
export function updateFromBrief(
  doc: SceneDoc,
  brief: SceneBrief,
  opts: { units?: UnitSource } = {},
): StageBriefReport {
  return doc.transact(() => updateFromBriefIn(docContext(doc), brief, opts));
}
