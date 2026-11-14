import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { DeskLayoutEntry, DeskMove, ObjectData, ShotData } from '../../doc/types';
import { createCube, createCylinder, createPlane } from '../../mesh/primitives';
import type { MeshData } from '../../mesh/types';
import { srgbToLinear } from '../../render/color';
import { evaluateFCurve } from '../../anim/fcurve';
import { FrameState } from '../../eval/frame-state';
import { fcurveKey } from '../../doc/scene-doc';
import { OperatorError, type OperatorContext } from '../../operators/context';
import type { CatalogEntry } from '../../store/types';
import { DESK_PROPS } from '../props';
import { MAX_SHOT_SUBJECTS, getShots, newShotId, setDeskSettings, setShots } from '../shots';
import { DESK_SHAPE_PROP, DeskScene, toEditor } from '../layout';
import { buildSet } from '../set';
import { addDeskCamera, applyCameraMove, lookEuler, prepareDeskCamera } from '../moves';
import { cameraMoveOf, FRAMING_TABLE } from '../solver';
import { fitShotToPlan, planFit } from '../plan';
import { checkShots, type DeskIssue } from '../checks';
import { applyPose, createActor, holdProp, isActor, mount, moveAlongPath } from '../characters';
import { ACTOR_PALETTE, type ActorKind } from '../characters/types';
import { defaultActorHeight } from '../characters';
import { deskTetherFly } from '../physics';
import { docParts, footprint } from './footprint';
import { KeyArchive, clearAnimation, hideSpans, replaceKeys, setKey, truncateMotion } from './keys';
import {
  MOUNT_DISTANCE_M,
  PERSON_POSES,
  editorPose,
  flyerKind,
  inferActorKind,
  isHumanoid,
  isRideable,
  modelFor,
  moveOfMovement,
  panDirectionSaid,
  plainText,
  ridersByText,
  ridingDenied,
  shotText,
} from './rules';
import {
  RIDEO_BLOCKING_PALETTE,
  RideoImportInputSchema,
  RideoSceneBlockingSchema,
  rideoLandmarkColor,
  rideoMarkFor,
  type RideoBlockingActor,
  type RideoBlockingCamera,
  type RideoBlockingLandmark,
  type RideoBlockingMark,
  type RideoBlockingProp,
  type RideoCharacterInput,
  type RideoImportInput,
  type RideoSceneBlocking,
  type RideoShotInput,
} from './schema';

/*
 * desk.import_rideo_blocking (spec §11 "Import semantics"): a rideo clip's SceneBlocking as a scene,
 * its actors, props, landmarks and set, and a shot per rideo shot.
 *
 * Timeline. Shots in rideo's index order, each round(durationSec × fps) frames long, one after the
 * other; a cut where marks jump (someone stands elsewhere, a rider gets on or off) opens with a
 * pre-roll gap (pre_roll frames, never exported) in which the jump happens and holds and tethers
 * settle; a continuous shot follows its predecessor directly. At each shot's key frame (its start,
 * or its pre-roll's) every actor gets a CONSTANT key at its mark (rideo's markFor: the shot's own
 * mark, else the opening mark) and the mark's pose; toX/toZ is a walk (a run for a 'run' pose) over
 * the shot. Riders (a person within 0.6 m of a mount's mark, or a shot's text saying they ride it)
 * sit on their mount's saddle over the shots they ride in, the mount walking for both.
 *
 * Cameras are rideo's, as they are (axis-mapped, looking at their target): a shot's move is rideo's
 * camera.move, else the move its blocked end amounts to (as rideo makes it on save), else the move
 * its planned movement asks for; a blocked end that agrees with the move is keyed as it is, else the
 * move is keyed from the blocked start. Shots without a blocked camera are solved (desk.shot_solve's
 * solve, never enforcing the line); a camera whose view disagrees with the shot's planned layout is
 * refitted when another angle agrees (plan_mismatch is reported when none does).
 *
 * Props are built-in models chosen by their element's name and label (else a cube of edge `size`),
 * fitted to `size`. A held prop is in its holder's hand over the shots whose cast includes the holder
 * and hidden in the others (rideo draws a held prop only with its holder): its scale shrinks to a
 * point for those spans (hide_render cannot be keyed). A held kite or balloon flies on a string from
 * the holder's hand over those shots (one flight, from the first to the last), hidden with its string
 * and tail in the shots without the holder and after the last. Landmarks are primitives (box,
 * cylinder, wall; water a flat plane cameras may stand in) or a built-in model scaled to width ×
 * depth × height when the label names one, its footprint centred on the mark.
 *
 * Re-import updates in place: actors by character id, props and landmarks by rideo id, shots by rideo
 * shot id (their ids and cameras kept); objects the import did not make are left alone, imported ones
 * rideo no longer has are removed, shots rideo removed are disabled. A prop or landmark rideo still
 * describes the same way is kept with what was added to it (physics, materials, modifiers), else it is
 * built anew. The animation of imported actors and props is rebuilt from rideo's (keys added to them
 * by hand are lost).
 */

/** Custom properties the import writes (besides DESK_PROPS). */
export const RIDEO_PROPS = {
  /** rideo's own id of an actor ('a1'), prop ('p1') or landmark ('l1'). */
  id: 'desk_rideo_id',
  /** The rideo clip an object was imported from. */
  clip: 'desk_rideo_clip',
  /** The set ground's name (rideo set.ground), on the set's ground. */
  ground: 'desk_ground',
  /**
   * What an imported prop or landmark was built from (model, size, colour, shape): a re-import keeps
   * the object, and what was added to it since (physics, materials, modifiers), while it is the same.
   */
  build: 'desk_rideo_build',
  /**
   * rideo's actors in no shot, with their marks (JSON on the set's ground, RideoOffstage): the import
   * leaves them out of the scene, and the export writes them back as rideo has them.
   */
  offstage: 'desk_rideo_offstage',
  /**
   * The character rideo has holding a prop (its heldBy), on the prop: the export writes it back while
   * that character is one of the offstage actors (the desk has no hold of theirs to read).
   */
  heldBy: 'desk_rideo_held_by',
} as const;

/** What RIDEO_PROPS.offstage holds: rideo's actors in no shot and their marks by rideo shot id. */
export interface RideoOffstage {
  actors: RideoBlockingActor[];
  marks: Record<string, Record<string, RideoBlockingMark>>;
}

/** What an animal carries in its mouth (holding it does not make the animal a person). */
const MOUTH_ITEM = /\b(balls?|sticks?|bones?|frisbees?|newspapers?|slippers?|leash(es)?|toys?)\b/;
/** A position (m) or a facing (°) this far from the last one is a jump at a cut. */
const JUMP_M = 0.25;
const JUMP_DEG = 45;
/** Walks shorter than this are no walk (m). */
const MIN_WALK_M = 0.05;
/** Kites and balloons: string length per metre of their size, bounds, wind. */
const KITE_STRING_PER_SIZE = 8;
const KITE_STRING_MIN = 4;
const KITE_STRING_MAX = 30;
const BALLOON_STRING_M = 1.2;
const KITE_WIND_MPS = 5;
/** The wind blows away from the first kite shot's camera, turned this much (°) so the string is seen. */
const KITE_WIND_TURN_DEG = 25;

/** What the shot solver of desk-shots.ts returns (solveShotCameras). */
export interface SolvedShotLike {
  id: string;
  camera: string;
  agrees: boolean;
  refit: boolean;
}

/** desk-shots.ts' solveShotCameras, handed in so that this module does not import the operators. */
export type ShotSolver = (
  ctx: OperatorContext,
  ids: readonly string[],
  o: { enforce_line: boolean; fit_plan: boolean; keep_lens: boolean },
) => SolvedShotLike[];

export interface RideoImportResult {
  state: RideoImportInput['state'] | null;
  settings: {
    fps: number;
    width: number;
    height: number;
    aspect: number;
    min_shot_s: number | null;
    max_shot_s: number | null;
  };
  frames: { start: number; end: number };
  actors: {
    id: string;
    name: string;
    character_id: string;
    kind: ActorKind;
    reason: string;
    created: boolean;
  }[];
  shots: {
    id: string;
    name: string;
    rideo_shot: string;
    index: number;
    frame_start: number;
    frame_end: number;
    pre_roll: number;
    camera: string;
    camera_from: 'blocking' | 'solved' | 'refit';
    move: DeskMove | null;
    agrees: boolean;
  }[];
  disabled_shots: { id: string; name: string; rideo_shot: string | null }[];
  props: {
    id: string;
    name: string;
    rideo_id: string;
    element_id: string | null;
    label: string;
    model: string | null;
    held_by: string | null;
    flies: 'kite' | 'balloon' | null;
    /** False when a re-import kept the prop of an earlier import. */
    created: boolean;
  }[];
  landmarks: {
    id: string;
    name: string;
    rideo_id: string;
    element_id: string | null;
    label: string;
    shape: string;
    model: string | null;
    /** False when a re-import kept the landmark of an earlier import. */
    created: boolean;
  }[];
  mounts: { rider: string; mount: string; shots: string[] }[];
  holds: { actor: string; prop: string; shots: string[] }[];
  tethers: { flyer: string; anchor: string; frame_start: number; frame_end: number; string: string | null }[];
  removed: string[];
  boards: { shot: string; rideo_shot: string; state: string }[];
  issues: DeskIssue[];
  warnings: string[];
}

// ---------------------------------------------------------------- small helpers

const rad = (deg: number) => (deg * Math.PI) / 180;
const TAU = 2 * Math.PI;
/** `a` moved by whole turns to within half a turn of `ref`. */
const nearAngle = (a: number, ref: number) => a + TAU * Math.round((ref - a) / TAU);
/** rideo floor point (x, z) in editor coordinates. */
const floor = (x: number, z: number): Vec3 => [x, -z, 0];

function hexLinear(hex: string): [number, number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
    1,
  ];
}

/** A unit mesh standing on z = 0 (scaled by its object to width × depth × height). */
function unitMesh(shape: 'box' | 'cylinder'): MeshData {
  const mesh =
    shape === 'cylinder' ? createCylinder({ vertices: 24, radius: 0.5, depth: 1 }) : createCube({ size: 1 });
  const p = mesh.positions;
  for (let i = 2; i < p.length; i += 3) p[i] += 0.5;
  return mesh;
}

/** Ids of an object and everything parented below it. */
function subtree(doc: SceneDoc, id: string): string[] {
  const index = doc.childrenIndex();
  const out: string[] = [];
  const visit = (x: string) => {
    out.push(x);
    for (const c of index.get(x) ?? []) visit(c);
  };
  visit(id);
  return out;
}

/** Removes objects with everything below them. */
function removeTrees(doc: SceneDoc, ids: readonly string[]): void {
  const all = new Set<string>();
  for (const id of ids) if (doc.getObject(id)) for (const x of subtree(doc, id)) all.add(x);
  doc.removeObjects([...all]);
}

const prop = (o: ObjectData | null | undefined, key: string): string => {
  const v = o?.custom_props?.[key];
  return typeof v === 'string' ? v : '';
};

/** The objects of a role this import (this clip, or any rideo import when no clip is known) made, by key. */
function importedBy(
  doc: SceneDoc,
  role: string,
  key: (o: ObjectData) => string,
  clip: string | null,
): Map<string, ObjectData> {
  const out = new Map<string, ObjectData>();
  for (const o of doc.listObjects()) {
    if (prop(o, DESK_PROPS.role) !== role) continue;
    const k = key(o);
    if (!k) continue;
    const from = prop(o, RIDEO_PROPS.clip);
    if (clip && from && from !== clip) continue;
    if (!out.has(k)) out.set(k, o);
  }
  return out;
}

/** Removes the hold and ride constraints the import put on objects (and their influence curves). */
function removeAttachments(doc: SceneDoc, id: string): void {
  const o = doc.getObject(id);
  if (!o) return;
  const isOurs = (name: string) => name.startsWith('Hold ') || name.startsWith('Ride ');
  const curves = doc.listFCurves(id);
  const dropCurve = (name: string) => {
    for (const fc of curves)
      if (fc.path.includes(`[${JSON.stringify(name)}]`)) doc.removeFCurve(fcurveKey(fc));
  };
  const kept = (o.constraints ?? []).filter((c) => {
    if (!isOurs(c.name)) return true;
    dropCurve(c.name);
    return false;
  });
  let bonesChanged = false;
  const bones: Record<string, (typeof o.pose.bones)[string]> = {};
  for (const [name, pb] of Object.entries(o.pose?.bones ?? {})) {
    const list = pb.constraints ?? [];
    const keep = list.filter((c) => {
      if (!isOurs(c.name)) return true;
      dropCurve(c.name);
      return false;
    });
    if (keep.length !== list.length) bonesChanged = true;
    bones[name] = keep.length !== list.length ? { ...pb, constraints: keep } : pb;
  }
  const patch: Partial<ObjectData> = {};
  if (kept.length !== (o.constraints ?? []).length) patch.constraints = kept;
  if (bonesChanged) patch.pose = { ...o.pose, bones };
  if (Object.keys(patch).length) doc.updateObject(id, patch);
}

/** The value an object channel holds at `frame` (its F-curve, else its stored value). */
function channelAt(
  doc: SceneDoc,
  id: string,
  path: 'location' | 'rotation_euler' | 'scale',
  i: number,
  frame: number,
): number {
  const fc = doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index: i }));
  const v = fc ? evaluateFCurve(fc, frame) : undefined;
  if (v !== undefined) return v;
  return doc.getObject(id)?.[path][i] ?? 0;
}

// ---------------------------------------------------------------- the import

interface ActorPlan {
  characterId: string;
  name: string;
  kind: ActorKind;
  reason: string;
  height: number;
  color: string;
  rideoId: string;
  id: string;
  created: boolean;
}

interface ShotPlan {
  input: RideoShotInput;
  id: string;
  name: string;
  index: number;
  frameStart: number;
  frameEnd: number;
  preRoll: number;
  /** Where the shot's marks are keyed: its start, or its pre-roll's. */
  keyFrame: number;
  camera: RideoBlockingCamera | null;
  move: DeskMove | null;
  /** Rider character id → mount character id. */
  riders: Map<string, string>;
  marks: Map<string, RideoBlockingMark>;
}

/** Parses the blocking (rideo's draft): INVALID_PARAMS naming the first problems when it is not one. */
export function parseRideoBlocking(raw: unknown): RideoSceneBlocking {
  const withDate =
    raw && typeof raw === 'object' && !Array.isArray(raw) && !('updatedAt' in raw)
      ? { ...(raw as Record<string, unknown>), updatedAt: new Date(0).toISOString() }
      : raw;
  const r = RideoSceneBlockingSchema.safeParse(withDate);
  if (!r.success)
    throw new OperatorError(
      `blocking is not a rideo SceneBlocking v1: ${r.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
      'INVALID_PARAMS',
    );
  return r.data;
}

/**
 * Imports a rideo clip's blocking into `ctx.doc` (see the module comment). `solve` solves the cameras
 * of shots without one (desk-shots.ts' solveShotCameras).
 */
export function importRideoBlocking(
  ctx: OperatorContext,
  raw: unknown,
  solve: ShotSolver,
): RideoImportResult {
  const parsed = RideoImportInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new OperatorError(
      `rideo import: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      'INVALID_PARAMS',
    );
  const input = parsed.data;
  const missing = input.state === 'missing';
  const blocking = parseRideoBlocking(input.blocking ?? {});
  const doc = ctx.doc;
  const warnings: string[] = [];
  const clip = input.clip ?? null;
  if (!input.shots.length) throw new OperatorError('rideo import: the clip has no shots', 'INVALID_PARAMS');

  // ------------------------------------------------------------ settings
  const scene = doc.getScene();
  const fps = input.settings?.fps ?? Math.max(1, scene.fps || 24);
  const render = doc.getRender();
  const width = input.settings?.width ?? render.resolution_x;
  const height = input.settings?.height ?? render.resolution_y;
  const aspect = width / Math.max(1, height);
  if (input.settings) {
    doc.updateScene({ fps });
    doc.updateRender({ resolution_x: width, resolution_y: height, resolution_percentage: 100 });
    const ar = input.settings.aspectRatio;
    if (ar) {
      const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar.trim());
      if (m && Math.abs(Number(m[1]) / Number(m[2]) - aspect) > 0.02)
        warnings.push(
          `rideo's aspect ratio ${ar} differs from its resolution ${width}×${height}: the desk follows the resolution, as rideo's blocking does`,
        );
    }
  }
  // the video model's limits when the import is given them; without them the desk keeps its own
  // (a director's, or those of an earlier import)
  const limits = input.modelLimits;
  const desk = setDeskSettings(doc, {
    aspect,
    ...(limits ? { min_shot_s: limits.minSeconds ?? null, max_shot_s: limits.maxSeconds ?? null } : {}),
  });

  // ------------------------------------------------------------ shots in rideo order
  const seenShot = new Set<string>();
  const ordered = input.shots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.index - b.s.index || a.i - b.i)
    .map((x) => x.s)
    .filter((s) => {
      if (seenShot.has(s.id)) {
        warnings.push(`shot ${s.id} is listed twice: the first is imported`);
        return false;
      }
      seenShot.add(s.id);
      return true;
    });

  // ------------------------------------------------------------ the cast
  const characters = new Map<string, RideoCharacterInput>(input.characters.map((c) => [c.id, c]));
  const elementsById = new Map(input.elements.map((e) => [e.id, e]));
  const cast: string[] = [];
  for (const s of ordered) for (const id of s.characterIds) if (!cast.includes(id)) cast.push(id);
  for (const a of blocking.actors)
    if (!cast.includes(a.characterId))
      warnings.push(
        `${characters.get(a.characterId)?.name ?? a.characterId} is in the blocking but in no shot: left out`,
      );
  const blockActor = new Map(blocking.actors.map((a) => [a.characterId, a]));
  // opening marks: the blocking's (missing state: placed from the shots' planned layouts)
  const opening = new Map<string, RideoBlockingMark>();
  if (missing) {
    for (const [id, mark] of layoutMarks(ordered, cast)) opening.set(id, mark);
    warnings.push(
      "rideo has no blocking for this clip (state 'missing'): the cast stands where the shots' planned layouts put them and every camera is solved",
    );
  } else if (input.state === 'incomplete')
    warnings.push("rideo's blocking of this clip is incomplete: its draft (completed by rideo) is imported");
  cast.forEach((id, i) => {
    if (opening.has(id)) return;
    const a = blockActor.get(id);
    opening.set(id, {
      x: a?.x ?? (i - (cast.length - 1) / 2) * 1.2,
      z: a?.z ?? 0,
      facingDeg: a?.facingDeg ?? 0,
      pose: a?.pose ?? 'stand',
      toX: null,
      toZ: null,
    });
  });
  const effective: Pick<RideoSceneBlocking, 'shots' | 'actors'> = {
    shots: missing ? {} : blocking.shots,
    actors: cast.map((id, i) => {
      const m = opening.get(id)!;
      return {
        id: blockActor.get(id)?.id ?? `a${i + 1}`,
        characterId: id,
        color: blockActor.get(id)?.color ?? RIDEO_BLOCKING_PALETTE[i % RIDEO_BLOCKING_PALETTE.length].color,
        heightM: blockActor.get(id)?.heightM ?? 1.7,
        x: m.x,
        z: m.z,
        facingDeg: m.facingDeg,
        pose: m.pose,
      };
    }),
  };
  const markOf = (shotId: string, id: string): RideoBlockingMark => rideoMarkFor(effective, shotId, id)!;

  // ------------------------------------------------------------ kinds
  // a character holding a prop acts as a person (an animal carrying a ball or a stick in its mouth does not)
  const holders = new Set(
    blocking.props
      .filter(
        (p) =>
          p.heldBy &&
          !MOUTH_ITEM.test(plainText(`${p.label} ${elementsById.get(p.elementId ?? '')?.name ?? ''}`)),
      )
      .map((p) => p.heldBy!),
  );
  const personPose = new Set<string>();
  for (const id of cast) {
    if (PERSON_POSES.has(opening.get(id)!.pose)) personPose.add(id);
    for (const s of ordered) if (PERSON_POSES.has(markOf(s.id, id).pose)) personPose.add(id);
  }
  const nameOf = (id: string) => characters.get(id)?.name?.trim() || blockActor.get(id)?.id || id;
  const kindOf = (id: string, ev: { ridden: boolean; rides: boolean }) => {
    const c = characters.get(id) ?? { id, name: nameOf(id), summary: '' };
    return inferActorKind(
      c,
      { holds: holders.has(id), personPose: personPose.has(id), ...ev },
      input.castOverrides[id],
    );
  };
  // who rides whom by the shots' words, before the kinds: a character a shot says is ridden is the
  // animal its words make it, and one that rides is a person whatever animal it is (a bear cub on a
  // pony); any character but a mount (or one cast as an animal) may be the rider
  const saidRiders = new Map<string, { rider: string; mount: string }[]>();
  const riderIds = new Set<string>();
  const riddenIds = new Set<string>();
  for (const s of ordered) {
    const steeds = s.characterIds
      .map((id) => ({ id, kind: kindOf(id, { ridden: true, rides: false }).kind }))
      .filter((x) => isRideable(x.kind));
    const people = s.characterIds.filter((id) => {
      const o = input.castOverrides[id];
      return !steeds.some((m) => m.id === id) && (!o || isHumanoid(o));
    });
    const pairs = ridersByText(
      shotText(s),
      people.map((id) => ({ id, name: nameOf(id) })),
      steeds.map((m) => ({ id: m.id, name: nameOf(m.id), kind: m.kind })),
    );
    saidRiders.set(s.id, pairs);
    for (const p of pairs) {
      riderIds.add(p.rider);
      riddenIds.add(p.mount);
    }
  }
  const kinds = new Map<string, { kind: ActorKind; reason: string }>();
  for (const id of cast) kinds.set(id, kindOf(id, { ridden: riddenIds.has(id), rides: riderIds.has(id) }));

  // ------------------------------------------------------------ riders per shot
  const ridersOf = (s: RideoShotInput): Map<string, string> => {
    const out = new Map<string, string>();
    const taken = new Set<string>();
    for (const p of saidRiders.get(s.id) ?? [])
      if (isHumanoid(kinds.get(p.rider)!.kind) && isRideable(kinds.get(p.mount)!.kind)) {
        out.set(p.rider, p.mount);
        taken.add(p.mount);
      }
    const people = s.characterIds.filter((id) => isHumanoid(kinds.get(id)!.kind));
    const mounts = s.characterIds.filter((id) => isRideable(kinds.get(id)!.kind));
    // a person standing on a mount's mark rides it (rideo's normalize keeps them 0.35 m apart), unless
    // the shot's words say they are busy with it otherwise (brushing it, leading it, beside it)
    const near: { rider: string; mount: string; d: number }[] = [];
    for (const r of people)
      for (const m of mounts) {
        if (out.has(r) || taken.has(m)) continue;
        const a = markOf(s.id, r);
        const b = markOf(s.id, m);
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > MOUNT_DISTANCE_M) continue;
        if (ridingDenied(shotText(s), { name: nameOf(r) }, { name: nameOf(m), kind: kinds.get(m)!.kind }))
          continue;
        near.push({ rider: r, mount: m, d });
      }
    for (const n of near.sort((a, b) => a.d - b.d)) {
      if (out.has(n.rider) || taken.has(n.mount)) continue;
      out.set(n.rider, n.mount);
      taken.add(n.mount);
      warnings.push(
        `shot ${s.index + 1}: ${nameOf(n.rider)} is seated on ${nameOf(n.mount)} because their marks are ${n.d.toFixed(2)} m apart, though the shot's words do not say who rides (say it, as in '${nameOf(n.rider)} rides ${nameOf(n.mount)}', or set their marks apart)`,
      );
    }
    return out;
  };

  // ------------------------------------------------------------ the existing import (update in place)
  const update = input.update;
  const oldActors = update
    ? importedBy(doc, 'actor', (o) => prop(o, DESK_PROPS.characterId), clip)
    : new Map<string, ObjectData>();
  const oldProps = update ? importedBy(doc, 'prop', (o) => prop(o, RIDEO_PROPS.id), clip) : new Map();
  const oldLandmarks = update ? importedBy(doc, 'landmark', (o) => prop(o, RIDEO_PROPS.id), clip) : new Map();
  const oldShots = getShots(doc);
  const removed: string[] = [];

  // ------------------------------------------------------------ the set
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
  const groundObj = doc.getObject(built.ground);
  if (groundObj) {
    const kept = { ...groundObj.custom_props };
    delete kept[RIDEO_PROPS.offstage];
    // the actors left out (in no shot) and their marks, for the export to write back
    const offstage: RideoOffstage = {
      actors: missing ? [] : blocking.actors.filter((a) => !cast.includes(a.characterId)),
      marks: {},
    };
    for (const a of offstage.actors)
      for (const [shot, b] of Object.entries(blocking.shots)) {
        const m = b.marks[a.characterId];
        if (m) (offstage.marks[shot] ??= {})[a.characterId] = m;
      }
    doc.updateObject(built.ground, {
      custom_props: {
        ...kept,
        [RIDEO_PROPS.ground]: set.ground,
        ...(offstage.actors.length ? { [RIDEO_PROPS.offstage]: JSON.stringify(offstage) } : {}),
      },
    });
  }

  const elements = elementsById;
  const castNames = cast.map(nameOf);
  const stamp = (o: Record<string, string | number | boolean>) =>
    clip ? { ...o, [RIDEO_PROPS.clip]: clip } : o;

  // ------------------------------------------------------------ landmarks
  const landmarkOut: RideoImportResult['landmarks'] = [];
  const keptLandmarks = new Set<string>();
  for (const l of blocking.set.landmarks) {
    const old = oldLandmarks.get(l.id) as ObjectData | undefined;
    if (old) keptLandmarks.add(l.id);
    const made = buildLandmark(doc, l, elements.get(l.elementId ?? '')?.name ?? null, castNames, stamp, old);
    landmarkOut.push({ ...made, rideo_id: l.id, element_id: l.elementId, label: l.label });
  }
  for (const [rid, o] of oldLandmarks)
    if (!keptLandmarks.has(rid) && doc.getObject((o as ObjectData).id)) {
      removed.push((o as ObjectData).name);
      removeTrees(doc, [(o as ObjectData).id]);
    }

  // ------------------------------------------------------------ actors
  const actors = new Map<string, ActorPlan>();
  const actorOut: RideoImportResult['actors'] = [];
  for (const [i, id] of cast.entries()) {
    const { kind, reason } = kinds.get(id)!;
    const b = blockActor.get(id);
    const c = characters.get(id);
    const humanoid = isHumanoid(kind);
    // people: rideo's height (the draft's, from the identity); animals: theirs when rideo has one
    let h = b?.heightM ?? c?.heightM ?? null;
    if (!humanoid && (h === null || Math.abs(h - 1.7) < 1e-6)) h = c?.heightM ?? null;
    const heightM = h && h > 0 ? h : defaultActorHeight(kind);
    const color = (b?.color ?? ACTOR_PALETTE[i % ACTOR_PALETTE.length]).toLowerCase();
    const first = markOf(ordered[0].id, id);
    const old = oldActors.get(id);
    let actorId: string | null = null;
    let created = false;
    if (old) {
      const sameKind = prop(old, DESK_PROPS.kind) === kind;
      const oldH = Number(old.custom_props?.[DESK_PROPS.heightM]);
      if (sameKind && Number.isFinite(oldH) && Math.abs(oldH - heightM) < 0.005 && isActor(doc, old.id)) {
        actorId = old.id;
        resetActor(doc, old.id, nameOf(id), color);
      } else {
        removeTrees(doc, [old.id]);
      }
    }
    if (!actorId) {
      const r = createActor(doc, {
        kind,
        name: nameOf(id),
        color,
        height_m: heightM,
        location: floor(first.x, first.z),
        facing_deg: first.facingDeg,
        pose: editorPose(first.pose, kind),
        character_id: id,
      });
      actorId = r.actor;
      created = true;
    }
    const o = doc.getObject(actorId)!;
    doc.updateObject(actorId, {
      location: floor(first.x, first.z),
      rotation_euler: [0, 0, rad(first.facingDeg)],
      custom_props: stamp({
        ...o.custom_props,
        [RIDEO_PROPS.id]: b?.id ?? `a${i + 1}`,
        [DESK_PROPS.characterId]: id,
      }),
    });
    actors.set(id, {
      characterId: id,
      name: doc.getObject(actorId)!.name,
      kind,
      reason,
      height: heightM,
      color,
      rideoId: b?.id ?? `a${i + 1}`,
      id: actorId,
      created,
    });
    actorOut.push({
      id: actorId,
      name: doc.getObject(actorId)!.name,
      character_id: id,
      kind,
      reason,
      created,
    });
  }
  for (const [cid, o] of oldActors)
    if (!actors.has(cid) && doc.getObject(o.id)) {
      removed.push(o.name);
      removeTrees(doc, [o.id]);
    }

  // ------------------------------------------------------------ props
  const props = new Map<
    string,
    {
      root: string;
      baseScale: Vec3;
      model: string | null;
      plan: RideoBlockingProp;
      flies: 'kite' | 'balloon' | null;
    }
  >();
  const propOut: RideoImportResult['props'] = [];
  const keptProps = new Set<string>();
  for (const p of blocking.props) {
    const old = oldProps.get(p.id) as ObjectData | undefined;
    const elementName = elements.get(p.elementId ?? '')?.name ?? '';
    const flies = p.heldBy ? flyerKind(`${p.label} ${elementName}`) : null;
    if (old) {
      for (const x of tetherPartsOf(doc, old.id)) removeTrees(doc, [x]);
      keptProps.add(p.id);
    }
    const made = buildProp(doc, p, elementName, castNames, stamp, flies, old);
    props.set(p.id, { ...made, plan: p, flies });
    // rideo's holder, for the export to write back while the desk has no hold of theirs
    const rest = { ...doc.getObject(made.root)!.custom_props };
    delete rest[RIDEO_PROPS.heldBy];
    doc.updateObject(made.root, {
      custom_props: p.heldBy ? { ...rest, [RIDEO_PROPS.heldBy]: p.heldBy } : rest,
    });
    if (p.heldBy && !cast.includes(p.heldBy))
      warnings.push(`'${p.label || p.id}' is held by ${nameOf(p.heldBy)}, who is in no shot: it is hidden`);
    propOut.push({
      id: made.root,
      name: doc.getObject(made.root)!.name,
      rideo_id: p.id,
      element_id: p.elementId,
      label: p.label,
      model: made.model,
      held_by: p.heldBy,
      flies,
      created: made.created,
    });
  }
  for (const [rid, o] of oldProps)
    if (!keptProps.has(rid) && doc.getObject((o as ObjectData).id)) {
      removed.push((o as ObjectData).name);
      for (const x of tetherPartsOf(doc, (o as ObjectData).id)) removeTrees(doc, [x]);
      removeTrees(doc, [(o as ObjectData).id]);
    }

  // ------------------------------------------------------------ timeline
  const plans: ShotPlan[] = [];
  let cursor = scene.frame_start;
  let prev: ShotPlan | null = null;
  for (const s of ordered) {
    const riders = ridersOf(s);
    const marks = new Map(cast.map((id) => [id, markOf(s.id, id)]));
    const frames = Math.max(1, Math.round(s.durationSec * fps));
    let preRoll = 0;
    if (prev && s.continuity !== 'continuous' && marksJump(prev, marks, riders, cast))
      preRoll = input.preRollFrames;
    if (prev && s.continuity === 'continuous' && marksJump(prev, marks, riders, cast))
      warnings.push(`shot ${s.index + 1} continues shot ${prev.index + 1}, but marks jump between them`);
    const frameStart = (prev ? prev.frameEnd + 1 : cursor) + preRoll;
    const camera = missing ? null : (blocking.shots[s.id]?.camera ?? null);
    const plan: ShotPlan = {
      input: s,
      id: '',
      name: s.name?.trim() || `Shot ${s.index + 1}`,
      index: s.index,
      frameStart,
      frameEnd: frameStart + frames - 1,
      preRoll,
      keyFrame: frameStart - preRoll,
      camera,
      move: null,
      riders,
      marks,
    };
    plan.move = shotMove(s, camera, warnings);
    plans.push(plan);
    prev = plan;
    cursor = plan.frameEnd + 1;
  }
  const lastFrame = plans[plans.length - 1].frameEnd;
  if (lastFrame > doc.getScene().frame_end || update) doc.updateScene({ frame_end: lastFrame });

  // ------------------------------------------------------------ shots and their cameras
  const byExternal = new Map<string, ShotData>();
  if (update)
    for (const s of oldShots)
      if (
        s.external?.source === 'rideo' &&
        s.external.shot &&
        (!clip || !s.external.clip || s.external.clip === clip)
      )
        byExternal.set(s.external.shot, s);
  const shotsOut: ShotData[] = [];
  for (const p of plans) {
    const old = byExternal.get(p.input.id);
    p.id = old?.id ?? newShotId();
    let camera = old?.camera ?? null;
    if (!camera || doc.getObject(camera)?.type !== 'CAMERA')
      camera = addDeskCamera(doc, {
        name: p.name,
        shotId: p.id,
        lens: p.camera?.lensMm ?? p.input.camera.lensMm ?? FRAMING_TABLE[p.input.camera.framing].lens_mm,
      });
    else clearCameraAnimation(doc, camera);
    prepareDeskCamera(doc, camera, p.id);
    if (!doc.getScene().camera) doc.updateScene({ camera });
    const subjects = shotSubjects(p, actors, props);
    const layout: DeskLayoutEntry[] = [];
    for (const e of p.input.layout) {
      const a = actors.get(e.characterId);
      if (a && !layout.some((x) => x.subject === a.id))
        layout.push({ subject: a.id, side: e.side, facing: e.facing });
    }
    const spec = missing ? null : (blocking.shots[p.input.id]?.spec ?? null);
    shotsOut.push({
      id: p.id,
      name: p.name,
      enabled: true,
      camera,
      frame_start: p.frameStart,
      frame_end: p.frameEnd,
      notes: shotText(p.input).slice(0, 2000),
      framing: p.input.camera.framing,
      angle: spec?.angle ?? p.input.angle ?? old?.angle ?? null,
      height: spec?.height ?? p.input.height ?? old?.height ?? null,
      move: p.move,
      lens_mm: p.camera ? Math.round(p.camera.lensMm) : (p.input.camera.lensMm ?? null),
      subjects,
      layout,
      continuity: p.input.continuity,
      pre_roll: p.preRoll,
      external: {
        source: 'rideo',
        project: input.project ?? null,
        clip,
        shot: p.input.id,
        index: p.input.index,
      },
    });
  }
  // shots rideo removed are disabled; shots added by hand stay (after the imported ones)
  const importedIds = new Set(shotsOut.map((s) => s.id));
  const disabled: RideoImportResult['disabled_shots'] = [];
  for (const s of oldShots) {
    if (importedIds.has(s.id)) continue;
    const fromClip =
      s.external?.source === 'rideo' && (!clip || !s.external.clip || s.external.clip === clip);
    if (update && fromClip && s.enabled) {
      disabled.push({ id: s.id, name: s.name, rideo_shot: s.external?.shot ?? null });
      shotsOut.push({ ...s, enabled: false });
    } else shotsOut.push(s);
  }
  setShots(doc, shotsOut);

  // ------------------------------------------------------------ actors on their marks (phase A)
  const riding = rideSpans(plans);
  animateActors(doc, plans, actors, riding, cast);

  // ------------------------------------------------------------ riders on their mounts (phase B)
  const mountsOut: RideoImportResult['mounts'] = [];
  for (const span of riding) {
    const rider = actors.get(span.rider)!;
    const steed = actors.get(span.mount)!;
    const first = plans[span.from];
    const next = plans[span.to + 1];
    mount(doc, rider.id, steed.id, { frame: first.keyFrame, dismount_frame: next?.keyFrame });
    // the rider's marks after the ride (the dismount keyed them beside the mount)
    if (next) keyMark(doc, rider, next.marks.get(span.rider)!, next.keyFrame, false);
    mountsOut.push({
      rider: rider.name,
      mount: steed.name,
      shots: plans.slice(span.from, span.to + 1).map((p) => p.name),
    });
  }

  // ------------------------------------------------------------ held props, kites and balloons (phases C, D, E)
  const holdsOut: RideoImportResult['holds'] = [];
  const tethersOut: RideoImportResult['tethers'] = [];
  const timelineStart = plans[0].keyFrame;
  for (const { root, baseScale, plan: p, flies } of props.values()) {
    if (!p.heldBy) continue;
    const holder = actors.get(p.heldBy);
    const spans = holder ? holderSpans(plans, p.heldBy) : [];
    const hidden = hiddenSpans(spans, plans, timelineStart);
    if (!holder || !spans.length) {
      hideSpans(doc, root, baseScale, [{ from: timelineStart, to: null }]);
      continue;
    }
    if (flies) {
      const t = flyProp(doc, root, holder, flies, spans, plans, p);
      tethersOut.push({
        flyer: doc.getObject(root)!.name,
        anchor: holder.name,
        frame_start: t.frame_start,
        frame_end: t.frame_end,
        string: t.string ? (doc.getObject(t.string)?.name ?? null) : null,
      });
      for (const w of t.warnings) warnings.push(`${doc.getObject(root)!.name}: ${w}`);
      // the flight hides the flyer, its string and its tail after its last shot (after: 'hide')
      const gaps = hidden.filter((h) => h.to !== null);
      hideSpans(doc, root, baseScale, gaps);
      if (t.string) hideSpans(doc, t.string, 'keep', gaps);
      for (const tail of t.tail) {
        const s = doc.getObject(tail)?.scale ?? [1, 1, 1];
        hideSpans(doc, tail, [s[0], s[1], s[2]], gaps);
      }
    } else {
      for (const span of spans)
        holdProp(doc, holder.id, root, {
          hand: 'right',
          frame: plans[span.from].keyFrame,
          release_frame: plans[span.to + 1]?.keyFrame,
        });
      hideSpans(doc, root, baseScale, hidden);
    }
    holdsOut.push({
      actor: holder.name,
      prop: doc.getObject(root)!.name,
      shots: spans.flatMap((s) => plans.slice(s.from, s.to + 1).map((x) => x.name)),
    });
  }

  // ------------------------------------------------------------ the cast of each shot
  // rideo draws a shot with its own characters only (shotActors) and wants the clip's others out of
  // its frame (absent_in_frame): an actor is hidden by its scale over the shots it is not cast in, as a
  // held prop is, before any camera is solved; its marks and walks are kept, so that it stands where
  // the blocking has it when it comes back (and the export writes the same marks)
  for (const a of actors.values()) {
    const hidden = hiddenSpans(holderSpans(plans, a.characterId), plans, timelineStart);
    if (!hidden.length) continue;
    const s = doc.getObject(a.id)?.scale ?? [1, 1, 1];
    hideSpans(doc, a.id, [s[0], s[1], s[2]], hidden);
  }

  // ------------------------------------------------------------ cameras (phase F)
  const shotResults: RideoImportResult['shots'] = [];
  const toSolve: string[] = [];
  const stored = new Map(getShots(doc).map((s) => [s.id, s]));
  for (const p of plans) {
    const s = stored.get(p.id)!;
    if (!p.camera) {
      toSolve.push(p.id);
      continue;
    }
    placeCamera(doc, s, p);
  }
  const from = new Map<string, 'blocking' | 'solved' | 'refit'>();
  const agrees = new Map<string, boolean>();
  if (toSolve.length)
    for (const r of solve(ctx, toSolve, { enforce_line: false, fit_plan: true, keep_lens: false })) {
      from.set(r.id, 'solved');
      agrees.set(r.id, r.agrees);
    }
  // blocked cameras that disagree with their shot's plan: refitted when another angle agrees
  for (const [i, p] of plans.entries()) {
    if (!p.camera) continue;
    from.set(p.id, 'blocking');
    const s = getShots(doc).find((x) => x.id === p.id)!;
    if (!s.layout.length) {
      agrees.set(p.id, true);
      continue;
    }
    const fit = planFit(new DeskScene(doc), s, i);
    if (!fit || fit.own.agrees) {
      agrees.set(p.id, true);
      continue;
    }
    if (fit.spec && fit.solved && fit.agreement.agrees) {
      fitShotToPlan(doc, s);
      from.set(p.id, 'refit');
      agrees.set(p.id, true);
      warnings.push(
        `${p.name}: rideo's camera disagreed with the shot's planned layout; refitted (${fit.spec.angle})`,
      );
    } else {
      agrees.set(p.id, false);
      warnings.push(`${p.name}: no camera agrees with the shot's planned layout (plan_mismatch)`);
    }
  }
  const finalShots = new Map(getShots(doc).map((s) => [s.id, s]));
  for (const p of plans) {
    const s = finalShots.get(p.id)!;
    shotResults.push({
      id: s.id,
      name: s.name,
      rideo_shot: p.input.id,
      index: p.input.index,
      frame_start: s.frame_start,
      frame_end: s.frame_end,
      pre_roll: s.pre_roll,
      camera: s.camera ?? '',
      camera_from: from.get(p.id) ?? 'solved',
      move: s.move,
      agrees: agrees.get(p.id) ?? true,
    });
  }

  // ------------------------------------------------------------ boards drawn before this staging
  const boards: RideoImportResult['boards'] = [];
  for (const p of plans) {
    const st = p.input.boardState?.trim();
    if (st && !/^(none|missing)$/i.test(st)) boards.push({ shot: p.name, rideo_shot: p.input.id, state: st });
  }
  if (boards.length)
    warnings.push(
      `${boards.length} shot board(s) were drawn in rideo before this staging (${boards
        .map((b) => b.shot)
        .join(
          ', ',
        )}): redraw them from the desk's camera views, or push those shots' references in 'camera' mode`,
    );

  const issues = checkShots(doc, { shots: plans.map((p) => p.id) }).issues;
  return {
    state: input.state ?? null,
    settings: { fps, width, height, aspect, min_shot_s: desk.min_shot_s, max_shot_s: desk.max_shot_s },
    frames: { start: plans[0].frameStart, end: lastFrame },
    actors: actorOut,
    shots: shotResults,
    disabled_shots: disabled,
    props: propOut,
    landmarks: landmarkOut,
    mounts: mountsOut,
    holds: holdsOut,
    tethers: tethersOut,
    removed,
    boards,
    issues,
    warnings,
  };
}

// ---------------------------------------------------------------- the missing state

/**
 * Opening marks of a clip rideo has not blocked: each character on the side of the frame the first
 * shot that plans it puts it (left −1.2 m, centre 0, right +1.2 m, front to back in order), facing
 * the way it is planned to face a front camera; the others in a row, as rideo's emptyBlocking.
 */
function layoutMarks(
  shots: readonly RideoShotInput[],
  cast: readonly string[],
): Map<string, RideoBlockingMark> {
  const out = new Map<string, RideoBlockingMark>();
  const sideX = { left: -1.2, centre: 0, right: 1.2 } as const;
  const facingDeg = { camera: 0, away: 180, left: 270, right: 90 } as const;
  const used = new Map<string, number>();
  for (const s of shots)
    for (const e of s.layout) {
      if (out.has(e.characterId) || !cast.includes(e.characterId)) continue;
      const n = used.get(e.side) ?? 0;
      used.set(e.side, n + 1);
      out.set(e.characterId, {
        x: sideX[e.side],
        z: -n * 1.2,
        facingDeg: facingDeg[e.facing],
        pose: 'stand',
        toX: null,
        toZ: null,
      });
    }
  return out;
}

// ---------------------------------------------------------------- moves

/**
 * The move a shot is keyed with and rideo prompts: its camera.move, else (rideo sets it so when the
 * blocking is saved) the move its blocked camera's end amounts to, else its planned movement's.
 */
function shotMove(s: RideoShotInput, camera: RideoBlockingCamera | null, warnings: string[]): DeskMove {
  if (s.camera.move) {
    const said = camera?.end ? cameraMoveOf(placementOf(camera), placementOf(camera.end)) : null;
    if (said && said !== s.camera.move)
      warnings.push(
        `shot ${s.index + 1}: rideo's camera move is ${s.camera.move} but its blocked camera's end is a ${said}: ${s.camera.move} is keyed (the export writes its end back)`,
      );
    return s.camera.move;
  }
  if (camera?.end) {
    const m = cameraMoveOf(placementOf(camera), placementOf(camera.end));
    if (m) return m;
  }
  const move = moveOfMovement(s.camera.movement, shotText(s));
  if ((move === 'pan_left' || move === 'pan_right') && !panDirectionSaid(shotText(s)) && camera?.end) {
    // a pan the text gives no direction: the way the blocked target turns
    const p = placementOf(camera);
    const e = placementOf(camera.end);
    const f: Vec3 = [p.target[0] - p.position[0], p.target[1] - p.position[1], 0];
    const right: Vec3 = [f[1], -f[0], 0];
    const dt: Vec3 = [e.target[0] - p.target[0], e.target[1] - p.target[1], 0];
    const side = dt[0] * right[0] + dt[1] * right[1];
    if (Math.abs(side) > 1e-3) return side > 0 ? 'pan_right' : 'pan_left';
  }
  if (s.camera.movement === 'pan' && !panDirectionSaid(shotText(s)))
    warnings.push(`shot ${s.index + 1}: rideo plans a pan without a direction; keyed as ${move}`);
  return move;
}

const placementOf = (c: {
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}) => ({
  position: toEditor({ x: c.x, y: c.y, z: c.z }),
  target: toEditor({ x: c.targetX, y: c.targetY, z: c.targetZ }),
});

function clearCameraAnimation(doc: SceneDoc, cameraId: string): void {
  clearAnimation(doc, cameraId);
  const data = doc.getObject(cameraId)?.data;
  if (data)
    for (const fc of doc.listFCurves(data)) if (fc.target_type === 'camera') doc.removeFCurve(fcurveKey(fc));
}

/**
 * Poses a shot's camera as rideo blocked it (position, target, lens) and keys its move: the blocked
 * end itself when it is the shot's move (an orbit along its arc; see endIsMove), else the shot's move
 * from the blocked start; a locked-off shot holds its pose.
 */
function placeCamera(doc: SceneDoc, shot: ShotData, p: ShotPlan): void {
  const cam = shot.camera!;
  const c = p.camera!;
  const data = doc.getObject(cam)?.data;
  if (data) doc.updateCamera(data, { lens: c.lensMm, sensor_fit: 'HORIZONTAL', sensor_width: 36 });
  const start = placementOf(c);
  const end = c.end ? placementOf(c.end) : null;
  const o = doc.getObject(cam)!;
  const rotation = lookEuler(
    [
      start.target[0] - start.position[0],
      start.target[1] - start.position[1],
      start.target[2] - start.position[2],
    ],
    o.rotation_euler,
  );
  doc.updateObject(cam, { location: start.position, rotation_euler: rotation });
  const move = shot.move;
  if (end && endIsMove(move, start, end)) {
    keyPlacedMove(doc, cam, start, end, shot.frame_start, shot.frame_end);
    return;
  }
  if (move && move !== 'locked_off')
    applyCameraMove(doc, cam, move, {
      frame_start: shot.frame_start,
      frame_end: shot.frame_end,
      seed: shot.id,
      subject: shot.subjects[0],
      subjects: shot.subjects,
      start: { position: start.position, target: start.target, lens: c.lensMm },
    });
}

/** A camera's view turned by less than this (radians) has not panned or tilted. */
const TURN_MIN = rad(1);

/**
 * Whether a blocked end is the shot's move: the move rideo reads it as (cameraMoveOf), or, for the
 * pans and tilts rideo's reading does not name, the camera staying where it is while its view turns
 * that way (more sideways than up or down for a pan, the other way round for a tilt).
 */
function endIsMove(
  move: DeskMove | null,
  start: { position: Vec3; target: Vec3 },
  end: { position: Vec3; target: Vec3 },
): boolean {
  if (!move) return false;
  if (cameraMoveOf(start, end) === move) return true;
  const pan = move === 'pan_left' || move === 'pan_right';
  const tilt = move === 'tilt_up' || move === 'tilt_down';
  if (!pan && !tilt) return false;
  if (Math.hypot(...[0, 1, 2].map((i) => end.position[i] - start.position[i])) > 0.05) return false;
  const view = (p: { position: Vec3; target: Vec3 }) => {
    const d = [0, 1, 2].map((i) => p.target[i] - p.position[i]);
    return { yaw: Math.atan2(d[1], d[0]), pitch: Math.atan2(d[2], Math.hypot(d[0], d[1])) };
  };
  const a = view(start);
  const b = view(end);
  let yaw = b.yaw - a.yaw;
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  const pitch = b.pitch - a.pitch;
  // the view turning clockwise seen from above (a negative yaw) pans right
  const rightward = yaw < 0;
  const upward = pitch > 0;
  if (pan)
    return (
      Math.abs(yaw) > TURN_MIN && Math.abs(yaw) >= Math.abs(pitch) && rightward === (move === 'pan_right')
    );
  return Math.abs(pitch) > TURN_MIN && Math.abs(pitch) > Math.abs(yaw) && upward === (move === 'tilt_up');
}

/**
 * Keys a camera from `start` to `end` over [f0, f1]: along the arc around the target when the target
 * stays and the distance to it does (an orbit), else straight; eased (smoothstep), at most 12 keys,
 * each looking at the target where it is then.
 */
function keyPlacedMove(
  doc: SceneDoc,
  cam: string,
  start: { position: Vec3; target: Vec3 },
  end: { position: Vec3; target: Vec3 },
  f0: number,
  f1: number,
): void {
  const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const r0 = sub(start.position, start.target);
  const r1 = sub(end.position, end.target);
  const flat0 = Math.hypot(r0[0], r0[1]);
  const flat1 = Math.hypot(r1[0], r1[1]);
  const a0 = Math.atan2(r0[1], r0[0]);
  let da = Math.atan2(r1[1], r1[0]) - a0;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  const arc =
    len(sub(end.target, start.target)) < 0.05 &&
    Math.abs(flat0 - flat1) < 0.05 * Math.max(flat0, 1e-3) &&
    Math.abs(da) > rad(5);
  const frames = Math.max(1, f1 - f0);
  const n = Math.min(12, Math.max(arc ? 8 : 2, Math.ceil(frames / 8) + 1));
  let rot = doc.getObject(cam)!.rotation_euler as Vec3;
  const loc: number[][] = [[], [], []];
  const eul: number[][] = [[], [], []];
  const at: number[] = [];
  for (let k = 0; k < n; k++) {
    const u = n === 1 ? 1 : k / (n - 1);
    const s = u * u * (3 - 2 * u);
    const target = lerp(start.target, end.target, s);
    let pos: Vec3;
    if (arc) {
      const a = a0 + da * s;
      const r = flat0 + (flat1 - flat0) * s;
      pos = [
        target[0] + Math.cos(a) * r,
        target[1] + Math.sin(a) * r,
        start.position[2] + (end.position[2] - start.position[2]) * s,
      ];
    } else pos = lerp(start.position, end.position, s);
    rot = lookEuler(sub(target, pos), rot);
    at.push(f0 + Math.round(u * frames * 1000) / 1000);
    for (let i = 0; i < 3; i++) {
      loc[i].push(pos[i]);
      eul[i].push(rot[i]);
    }
  }
  for (let i = 0; i < 3; i++) {
    replaceKeys(
      doc,
      cam,
      'location',
      i,
      -Infinity,
      Infinity,
      at.map((frame, k) => ({ frame, value: loc[i][k], interpolation: 'BEZIER' as const })),
    );
    replaceKeys(
      doc,
      cam,
      'rotation_euler',
      i,
      -Infinity,
      Infinity,
      at.map((frame, k) => ({ frame, value: eul[i][k], interpolation: 'BEZIER' as const })),
    );
  }
}

// ---------------------------------------------------------------- shots

/** The shot's subjects: its cast's actors (rideo's spec subjects first); an insert's prop too. */
function shotSubjects(
  p: ShotPlan,
  actors: ReadonlyMap<string, ActorPlan>,
  props: ReadonlyMap<string, { root: string; plan: RideoBlockingProp }>,
): string[] {
  const out: string[] = [];
  for (const id of p.input.characterIds) {
    const a = actors.get(id);
    if (a && !out.includes(a.id)) out.push(a.id);
  }
  if (p.input.camera.framing === 'insert')
    for (const x of props.values())
      if (x.plan.elementId && p.input.elementIds.includes(x.plan.elementId) && !out.includes(x.root))
        out.push(x.root);
  return out.slice(0, MAX_SHOT_SUBJECTS);
}

/** Whether the cast stands elsewhere at a cut than at the end of the shot before (or a rider gets on or off). */
function marksJump(
  prev: ShotPlan,
  marks: ReadonlyMap<string, RideoBlockingMark>,
  riders: ReadonlyMap<string, string>,
  cast: readonly string[],
): boolean {
  for (const id of cast) {
    if ((prev.riders.get(id) ?? null) !== (riders.get(id) ?? null)) return true;
    if (riders.has(id)) continue;
    const a = prev.marks.get(id)!;
    const b = marks.get(id)!;
    const walked = a.toX !== null && a.toZ !== null;
    const ex = walked ? a.toX! : a.x;
    const ez = walked ? a.toZ! : a.z;
    if (Math.hypot(b.x - ex, b.z - ez) > JUMP_M) return true;
    if (!walked) {
      const d = Math.abs(((((b.facingDeg - a.facingDeg) % 360) + 540) % 360) - 180);
      if (d > JUMP_DEG) return true;
    }
  }
  return false;
}

/** Consecutive shots (by plan index) in which a rider rides the same mount. */
function rideSpans(plans: readonly ShotPlan[]): { rider: string; mount: string; from: number; to: number }[] {
  const out: { rider: string; mount: string; from: number; to: number }[] = [];
  const open = new Map<string, { rider: string; mount: string; from: number; to: number }>();
  plans.forEach((p, i) => {
    for (const [rider, steed] of open) {
      if (p.riders.get(rider) !== steed.mount) {
        out.push(steed);
        open.delete(rider);
      }
    }
    for (const [rider, m] of p.riders) {
      const cur = open.get(rider);
      if (cur) cur.to = i;
      else open.set(rider, { rider, mount: m, from: i, to: i });
    }
  });
  out.push(...open.values());
  return out.sort((a, b) => a.from - b.from);
}

/** Consecutive shots (by plan index) whose cast includes `characterId`. */
function holderSpans(plans: readonly ShotPlan[], characterId: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  plans.forEach((p, i) => {
    if (!p.input.characterIds.includes(characterId)) return;
    const last = out[out.length - 1];
    if (last && last.to === i - 1) last.to = i;
    else out.push({ from: i, to: i });
  });
  return out;
}

/** The frame spans a held prop is hidden in: before its first holder span, between spans, after the last. */
function hiddenSpans(
  spans: readonly { from: number; to: number }[],
  plans: readonly ShotPlan[],
  timelineStart: number,
): { from: number; to: number | null }[] {
  if (!spans.length) return [{ from: timelineStart, to: null }];
  const out: { from: number; to: number | null }[] = [];
  const first = plans[spans[0].from].keyFrame;
  if (first > timelineStart) out.push({ from: timelineStart, to: first - 1 });
  for (let k = 0; k < spans.length; k++) {
    const next = plans[spans[k].to + 1];
    if (!next) break;
    const resume = spans[k + 1] ? plans[spans[k + 1].from].keyFrame - 1 : null;
    out.push({ from: next.keyFrame, to: resume });
  }
  return out;
}

// ---------------------------------------------------------------- actors

/** An existing imported actor made ready for new keys: no animation, no holds or rides, standing. */
function resetActor(doc: SceneDoc, id: string, name: string, color: string): void {
  clearAnimation(doc, id);
  removeAttachments(doc, id);
  const o = doc.getObject(id)!;
  if (o.name !== name) doc.rename('objects', id, name);
  doc.updateObject(id, { custom_props: { ...o.custom_props, [DESK_PROPS.color]: color } });
  applyPose(doc, id, 'stand');
}

/**
 * Keys an actor on a mark at `frame` (CONSTANT; the frame before holds where it was) with the mark's
 * pose; with `truncate`, the motion keys it has from `frame` on (a walk settling after its shot)
 * are removed first.
 */
function keyMark(doc: SceneDoc, a: ActorPlan, m: RideoBlockingMark, frame: number, truncate: boolean): void {
  if (truncate) truncateMotion(doc, a.id, frame);
  const target = floor(m.x, m.z);
  const before = [0, 1, 2].map((i) => channelAt(doc, a.id, 'location', i, frame - 1));
  const yawBefore = channelAt(doc, a.id, 'rotation_euler', 2, frame - 1);
  for (let i = 0; i < 3; i++) {
    setKey(doc, a.id, 'location', i, frame - 1, before[i]);
    setKey(doc, a.id, 'location', i, frame, target[i]);
  }
  setKey(doc, a.id, 'rotation_euler', 2, frame - 1, yawBefore);
  setKey(doc, a.id, 'rotation_euler', 2, frame, nearAngle(rad(m.facingDeg), yawBefore));
  applyPose(doc, a.id, editorPose(m.pose, a.kind), { frame, blend_frames: 0 });
}

/**
 * Phase A: every actor on its mark at each shot's key frame (riders excepted while they ride) and
 * its walks; a mount carrying a rider walks to the rider's target when it has none of its own.
 */
function animateActors(
  doc: SceneDoc,
  plans: readonly ShotPlan[],
  actors: ReadonlyMap<string, ActorPlan>,
  riding: readonly { rider: string; mount: string; from: number; to: number }[],
  cast: readonly string[],
): void {
  const ridesAt = (id: string, i: number) => riding.some((r) => r.rider === id && i >= r.from && i <= r.to);
  const state = new Map<string, { mark: RideoBlockingMark; walked: boolean; rode: boolean } | null>();
  // each shot is keyed into curves that hold only the keys around it (see KeyArchive): the cost of
  // a shot does not grow with the shots keyed before it
  const archive = new KeyArchive(doc);
  try {
    for (const [i, p] of plans.entries()) {
      for (const id of cast) {
        const a = actors.get(id)!;
        if (i > 0) archive.shelve(a.id, p.keyFrame);
        const rides = ridesAt(id, i);
        const last = state.get(id) ?? null;
        if (rides) {
          state.set(id, { mark: p.marks.get(id)!, walked: false, rode: true });
          continue;
        }
        const m = p.marks.get(id)!;
        const same =
          !!last &&
          !last.walked &&
          !last.rode &&
          last.mark.x === m.x &&
          last.mark.z === m.z &&
          last.mark.facingDeg === m.facingDeg &&
          last.mark.pose === m.pose;
        if (!same) {
          if (i === 0) {
            for (let k = 0; k < 3; k++) setKey(doc, a.id, 'location', k, p.keyFrame, floor(m.x, m.z)[k]);
            setKey(doc, a.id, 'rotation_euler', 2, p.keyFrame, rad(m.facingDeg));
            applyPose(doc, a.id, editorPose(m.pose, a.kind), { frame: p.keyFrame, blend_frames: 0 });
          } else keyMark(doc, a, m, p.keyFrame, true);
        }
        // the walk: the mark's own, else (a mount carrying someone) its rider's
        let to: [number, number] | null = m.toX !== null && m.toZ !== null ? [m.toX, m.toZ] : null;
        if (!to)
          for (const [rider, steed] of p.riders)
            if (steed === id) {
              const rm = p.marks.get(rider)!;
              if (rm.toX !== null && rm.toZ !== null) to = [rm.toX, rm.toZ];
            }
        let walked = false;
        if (to && Math.hypot(to[0] - m.x, to[1] - m.z) >= MIN_WALK_M && p.frameEnd > p.frameStart) {
          const run = m.pose === 'run';
          moveAlongPath(doc, a.id, [floor(to[0], to[1])], {
            frame_start: p.frameStart,
            frame_end: p.frameEnd,
            gait: run ? (isHumanoid(a.kind) ? 'run' : 'gallop') : 'auto',
            face_path: true,
          });
          walked = true;
        }
        state.set(id, { mark: m, walked, rode: false });
      }
    }
  } finally {
    archive.restore();
  }
}

// ---------------------------------------------------------------- props

/** The string and tail objects desk.tether_fly made for a flyer. */
function tetherPartsOf(doc: SceneDoc, flyer: string): string[] {
  return doc
    .listObjects()
    .filter((o) => o.custom_props?.desk_string_to === flyer || o.custom_props?.desk_tail_of === flyer)
    .map((o) => o.id);
}

/** Whether an earlier import's object was built as `build` says, to be kept; one built otherwise is removed. */
function keepable(doc: SceneDoc, old: ObjectData | undefined, build: string): old is ObjectData {
  if (!old || !doc.getObject(old.id)) return false;
  if (prop(doc.getObject(old.id), RIDEO_PROPS.build) === build) return true;
  removeTrees(doc, [old.id]);
  return false;
}

/**
 * Adds a prop: the built-in model its element or label names, fitted to `size`, else a cube of edge
 * `size`; an earlier import's prop built the same way is kept (with what was added to it since),
 * cleared of its animation and of the import's holds, which the import keys anew, and put back on
 * its mark.
 */
function buildProp(
  doc: SceneDoc,
  p: RideoBlockingProp,
  elementName: string,
  castNames: readonly string[],
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
  flies: 'kite' | 'balloon' | null,
  old?: ObjectData,
): { root: string; baseScale: Vec3; model: string | null; created: boolean } {
  const label = p.label || elementName || p.id;
  const queries = flies === 'kite' ? ['kite'] : flies === 'balloon' ? ['balloon'] : [elementName, p.label];
  const found = modelFor(queries.filter(Boolean), { exclude: castNames });
  const build = JSON.stringify([
    'prop',
    found?.entry.id ?? 'cube',
    p.size,
    p.color.toLowerCase(),
    label,
    flies,
  ]);
  const props = stamp({
    [DESK_PROPS.role]: 'prop',
    [DESK_PROPS.label]: label,
    [RIDEO_PROPS.id]: p.id,
    [DESK_PROPS.color]: p.color,
    [RIDEO_PROPS.build]: build,
    ...(p.elementId ? { [DESK_PROPS.elementId]: p.elementId } : {}),
  });
  const at = floor(p.x, p.z);
  const model = found?.entry.id ?? null;
  let root: string;
  let created = true;
  if (keepable(doc, old, build)) {
    root = old.id;
    created = false;
    for (const id of subtree(doc, root)) clearAnimation(doc, id);
    removeAttachments(doc, root);
    const o = doc.getObject(root)!;
    doc.updateObject(root, {
      location: at,
      rotation_euler: [0, 0, 0],
      custom_props: { ...o.custom_props, ...props },
    });
  } else if (found) {
    const entry: CatalogEntry = found.entry;
    const largest = Math.max(...entry.dimensions_m);
    const res = entry.build(doc, {
      location: at,
      name: label,
      scale: largest > 0 ? p.size / largest : 1,
      ...(p.color.toLowerCase() !== '#c9a227' && !flies ? { color: p.color } : {}),
    });
    root = res.root;
    const o = doc.getObject(root)!;
    doc.updateObject(root, { custom_props: { ...o.custom_props, ...props } });
  } else {
    const mat = doc.addMaterial({ name: label, base_color: hexLinear(p.color), roughness: 0.6 });
    root = doc.addObject({
      type: 'MESH',
      name: label,
      data: doc.addMesh(label, unitMesh('box')),
      location: at,
      scale: [p.size, p.size, p.size],
      material_slots: [mat],
      custom_props: props,
    });
  }
  const s = doc.getObject(root)!.scale;
  return { root, baseScale: [s[0], s[1], s[2]], model, created };
}

/**
 * Adds a landmark: water as a flat plane, else a primitive, or the built-in model its label names
 * (its footprint centred on the mark); an earlier import's landmark built the same way is kept (with
 * what was added to it since) and put on its mark.
 */
function buildLandmark(
  doc: SceneDoc,
  l: RideoBlockingLandmark,
  elementName: string | null,
  castNames: readonly string[],
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
  old?: ObjectData,
): { id: string; name: string; shape: string; model: string | null; created: boolean } {
  const label = l.label || elementName || l.id;
  const water = l.shape === 'water';
  const shape = water ? 'water' : l.shape;
  const color =
    l.color.toLowerCase() === '#8a8f98' && l.label ? rideoLandmarkColor(l.label, l.shape) : l.color;
  const found = water
    ? null
    : modelFor([l.label, elementName ?? ''].filter(Boolean), {
        exclude: castNames,
        categories: ['nature', 'architecture', 'street', 'props', 'furniture', 'vehicles', 'sports'],
      });
  const model = found?.entry.id ?? null;
  const build = JSON.stringify([
    'landmark',
    shape,
    model ?? 'primitive',
    l.width,
    l.depth,
    l.height,
    color,
    label,
  ]);
  const props = stamp({
    [DESK_PROPS.role]: 'landmark',
    [DESK_PROPS.label]: label,
    [RIDEO_PROPS.id]: l.id,
    [DESK_PROPS.color]: l.color,
    [DESK_SHAPE_PROP]: shape,
    [RIDEO_PROPS.build]: build,
    ...(water ? { [DESK_PROPS.heightM]: l.height } : {}),
    ...(l.elementId ? { [DESK_PROPS.elementId]: l.elementId } : {}),
  });
  const at = floor(l.x, l.z);
  const rotation: Vec3 = [0, 0, rad(l.rotationDeg)];
  let id: string;
  let created = true;
  if (keepable(doc, old, build)) {
    id = old.id;
    created = false;
    doc.updateObject(id, { location: at, rotation_euler: rotation });
  } else if (found) {
    id = found.entry.build(doc, {
      location: at,
      rotation_deg: l.rotationDeg,
      width_m: l.width,
      depth_m: l.depth,
      height_m: l.height,
      name: label,
    }).root;
  } else {
    const mat = doc.addMaterial({
      name: label,
      base_color: hexLinear(water && l.color.toLowerCase() === '#8a8f98' ? '#3f7fc0' : color),
      roughness: water ? 0.1 : 0.8,
    });
    const mesh = water
      ? (() => {
          const m = createPlane({ size: 1 });
          for (let i = 2; i < m.positions.length; i += 3) m.positions[i] = 0.02;
          return m;
        })()
      : unitMesh(l.shape === 'cylinder' ? 'cylinder' : 'box');
    id = doc.addObject({
      type: 'MESH',
      name: label,
      data: doc.addMesh(label, mesh),
      location: at,
      rotation_euler: rotation,
      scale: [l.width, l.depth, water ? 1 : l.height],
      material_slots: [mat],
    });
  }
  const o = doc.getObject(id)!;
  let location = o.location;
  if (model) {
    // rideo's landmark is a box centred on its mark: the model's footprint is, too (a tree's crown
    // leans off its trunk), measured as the export reads it back
    const f = footprint(doc, new FrameState(doc, doc.getScene().frame_start), docParts(doc), id);
    if (f) location = [o.location[0] + at[0] - f.x, o.location[1] + at[1] + f.z, o.location[2]];
  }
  doc.updateObject(id, { location, custom_props: { ...o.custom_props, ...props } });
  return { id, name: o.name, shape, model, created };
}

/**
 * Flies a held kite or balloon from its holder's right hand (a quadruped's head) over the shots the
 * holder is in, as one flight from the first such shot's key frame to the last such shot's end, put
 * away after it (after: 'hide'; a later flight of the same flyer would replace this one's string and
 * tail keys, so shots between are hidden by the caller instead): the wind blows away from the first
 * of those shots' camera (turned a little, so the string is seen), a kite is already up unless the
 * shot's text says it is launched.
 */
function flyProp(
  doc: SceneDoc,
  root: string,
  holder: ActorPlan,
  kind: 'kite' | 'balloon',
  spans: readonly { from: number; to: number }[],
  plans: readonly ShotPlan[],
  p: RideoBlockingProp,
): { frame_start: number; frame_end: number; string: string | null; tail: string[]; warnings: string[] } {
  const first = plans[spans[0].from];
  const last = plans[spans[spans.length - 1].to];
  const frameStart = first.keyFrame;
  const frameEnd = Math.max(last.frameEnd, frameStart + 1);
  let windDeg = 0;
  if (first.camera) {
    const dx = first.camera.targetX - first.camera.x;
    const dz = first.camera.targetZ - first.camera.z;
    if (Math.hypot(dx, dz) > 1e-6) windDeg = (Math.atan2(dx, dz) * 180) / Math.PI;
  }
  windDeg += KITE_WIND_TURN_DEG;
  const launched = /\b(launch(es|ed|ing)?|takes? off|lifts? off|lets? (it )?go|runs? with)\b/.test(
    plainText(shotText(first.input)),
  );
  const length =
    kind === 'kite'
      ? Math.min(KITE_STRING_MAX, Math.max(KITE_STRING_MIN, KITE_STRING_PER_SIZE * p.size))
      : BALLOON_STRING_M;
  const r = deskTetherFly(doc, {
    flyer: root,
    anchor: holder.id,
    anchor_bone: isHumanoid(holder.kind) ? 'hand.R' : 'head',
    length_m: Math.round(length * 100) / 100,
    wind_dir_deg: Math.round(windDeg * 10) / 10,
    wind_mps: kind === 'kite' ? KITE_WIND_MPS : 1.5,
    frame_start: frameStart,
    frame_end: frameEnd,
    ...(launched ? {} : { launch_frames: 0 }),
    seed: seedOf(p.id),
    after: 'hide',
  });
  const tail = r.tail_objects.filter((t) => !subtree(doc, root).includes(t));
  return { frame_start: frameStart, frame_end: frameEnd, string: r.string, tail, warnings: r.warnings };
}

/** A deterministic seed from a rideo id. */
function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
