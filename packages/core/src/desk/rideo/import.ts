import type { Mat4, Vec3 } from '../../math/types';
import { compose4, determinant4, invert4, multiply4 } from '../../math/mat4';
import { decomposeCompatible } from '../../generate/layout';
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
import { DESK_SHAPE_PROP, DeskScene, isWaterLabel, toEditor } from '../layout';
import { setInWaterSpans, type FrameSpan } from '../water';
import { buildSet, setGround } from '../set';
import { addDeskCamera, applyCameraMove, lookEuler, prepareDeskCamera } from '../moves';
import { cameraMoveOf, FRAMING_TABLE } from '../solver';
import { fitShotToPlan, planFit } from '../plan';
import { checkShots, type DeskIssue } from '../checks';
import { applyPose, createActor, holdProp, isActor, mount, moveAlongPath } from '../characters';
import { createFigureActor } from '../characters/figure';
import type { UnitPayload } from '../units/format';
import { insertUnit, type UnitPin } from '../units/insert';
import { readInstance, unitOf } from '../units/list';
import { UNIT_ROOT } from '../units/ids';
import {
  hangKept,
  keptPlaces,
  moversOf,
  oldLook,
  removeKeeping,
  removeObjectTrees,
  sameWorld,
  type KeptPlaces,
  type LaterWarning,
} from '../units/remove';
import { unitStatus } from '../units/status';
import { updateUnit, withArticle } from '../units/update';
import { ACTOR_PALETTE, type ActorKind } from '../characters/types';
import { defaultActorHeight } from '../characters';
import { deskTetherFly } from '../physics';
import { measureActorKind } from '../../store/builtin/actors';
import { docParts, footprint } from './footprint';
import { KeyArchive, clearAnimation, hideSpans, replaceKeys, setKey, truncateMotion } from './keys';
import { hiddenByScale } from '../hide';
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
  RIDEO_MAX_ACTORS,
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
 * desk.import_rideo_blocking (spec §11 "Import semantics"): a clip's SceneBlocking v1 (the blocking
 * format rideo defined, ./schema.ts) as a scene, its actors, props, landmarks and set, and a shot per
 * shot of the clip; also the staging engine of desk/brief stageBrief (source 'host'), which hands it a
 * blocking of the set and props only (state 'missing': the cast placed from the planned layouts).
 * "rideo" below is the format's: its coordinates, poses, landmarks and moves.
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
 * depth × height when the label names one, its footprint centred on the mark. A box or a cylinder
 * whose label names water (rideo's blue 'river', 'pond') is the primitive, its top the water over all
 * of rideo's footprint (no model whose shore would take its edge). rideo lets its cast stand in its
 * water (a swim, a wade): an actor whose mark or walk's end in a shot lies inside such a landmark
 * belongs in the water over that shot (desk_in_water: desk.check's walks_on_water leaves it alone).
 *
 * Re-import updates in place: actors by character id, props and landmarks by rideo id, shots by rideo
 * shot id (their ids and cameras kept); objects the import did not make are left alone, imported ones
 * rideo no longer has are removed, shots rideo removed are disabled. A prop or landmark rideo still
 * describes the same way is kept with what was added to it (physics, materials, modifiers), else it is
 * built anew. The animation of imported actors and props is rebuilt from rideo's (keys added to them
 * by hand are lost). What the person put on a piece that is built anew or goes (objects of their own
 * below it, not its look) stays where it is in the world, hung from the piece built in its place, or
 * from the set's ground for one that goes (hangOnGround), its keyed motion kept where it can be, and
 * the warnings name it (units/remove.ts hangKept).
 *
 * Library units (code-level hooks, ImportUnits; the SceneBlocking JSON is unchanged): brief staging
 * hands the import a prop unit per element and a figure unit per cast member it places (desk/brief),
 * and the opening marks it planned clear of a set unit's pieces. A prop unit is put in as an instance
 * (key 'el:<elementId>') at its spot, its base on the ground and its own size, and held or flown as a
 * built-in prop is; an earlier instance of the same library item is kept and updated to the pinned
 * version (its root id stays). A figure is put in as the cast member's actor (key 'cast:<castId>'),
 * its kind, height and colour the figure's. Objects inside an instance are the unit's: an import never
 * takes them for its own landmarks, props or actors (only an instance's root is), and a re-import
 * without hooks keeps an imported prop that is an instance (with its look) and a figure actor of the
 * same kind and height (with its colour).
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
  /**
   * A digest of what the import left an actor, prop, landmark or shot camera doing (motionDigest):
   * a re-import, which rebuilds them from rideo's blocking, says which were changed in the desk since.
   * On a prop it is followed by a space and the digest of the keys on its own transform channels
   * (ownKeysDigest): keys of the person's there are what the staging did not write (recordedMotion).
   */
  motion: 'desk_rideo_motion',
  /**
   * rideo's blocked camera of a shot (JSON {shot, camera}: its rideo shot id and RideoBlockingCamera),
   * on a camera the import placed as rideo blocked it: the export writes it back as it was while the
   * camera is as the import left it (RIDEO_PROPS.motion), so that a round trip keeps rideo's targets
   * (the desk keys a move between them; recomputed targets would move its middle).
   */
  camera: 'desk_rideo_camera',
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

/** A unit staging places through the import: its instance key, its pin and the decoded unit. */
export interface StagedUnit {
  /** The instance key (slotKey): 'el:<elementId>', 'cast:<castId>'. */
  key: string;
  pin: UnitPin;
  /** The decoded unit (null: the slot's instance is kept as it is, only placed again). */
  unit: UnitPayload | null;
}

/** A prop unit: its base (its root stands at z = −base) and the planning facts stamped on its root. */
export interface StagedProp extends StagedUnit {
  base: number;
  /** The scene prop desk_unit_facts of its root (JSON), or null. */
  facts: string | null;
}

/** A figure unit: the actor's kind, height and colour (the figure's). */
export interface StagedFigure extends StagedUnit {
  unit: UnitPayload;
  kind: ActorKind;
  heightM: number;
  color: string;
}

/**
 * Library units for the import (brief staging's; see the module comment): the opening marks to use
 * instead of the planned layouts' (state 'missing'), and per prop and per cast member the unit that
 * stages it (undefined: the built-in prop, the mannequin). `figureHeight`: the height of a member
 * whose figure is pinned but not placed (not here, or refused), which the host gives as the
 * figure's own: the desk's height of its kind (an animal's withers), used as it is rather than as
 * rideo's height, so that the mannequin standing in has the figure's rig and its arrival is a look
 * swap (undefined: rideo's height, as for any member). `failed`: a unit handed to the import that
 * did not go in (by its key, with the error), which leaves nothing of it behind: its member stands
 * as the mannequin of the figure's kind, height and colour, its element as the prop of the words
 * (or the prop it had, kept as it is), and the rest of the import goes on.
 */
export interface ImportUnits {
  marks?: ReadonlyMap<string, RideoBlockingMark>;
  prop?(p: RideoBlockingProp): StagedProp | null | undefined;
  figure?(characterId: string): StagedFigure | undefined;
  figureHeight?(characterId: string): number | undefined;
  failed?(key: string, err: unknown): void;
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

/**
 * Removes objects with everything below them; a library unit instance among them goes whole, with the
 * datablocks its part table lists that nothing else uses (units/remove.ts: a unit placed in its slot
 * again derives the same ids). `keep`: objects below them that stay, each with what is below it (see
 * removeObjectTrees).
 */
export function removeTrees(doc: SceneDoc, ids: readonly string[], keep: readonly string[] = []): void {
  removeObjectTrees(doc, ids, keep);
}

/**
 * Hangs what stays of a piece that goes with nothing in its place (`kept`: a landmark or a prop the
 * words drop, an actor or a shot's camera that goes, a flyer's old string; units/remove.ts
 * removeKeeping) from the set's ground (`ground`, else the words' ground or a library set's root; the
 * scene when there is none), where it was in the world, in the caller's transaction, and returns the
 * warnings naming it ("'pond' goes; 'Lily' stays where it is, on the words' ground"). `held`:
 * objects a later step of the caller may take out, whose warnings wait in `held.later`
 * (units/remove.ts KeptWords' `unnamed`).
 */
export function hangOnGround(
  doc: SceneDoc,
  kept: KeptPlaces,
  gone: string,
  ground: string | null = setGround(doc),
  held: { unnamed?: ReadonlySet<string>; later?: LaterWarning[] } = {},
): string[] {
  const on = !ground
    ? 'the scene'
    : readInstance(doc, ground)
      ? "the library set's root"
      : "the words' ground";
  return hangKept(doc, ground, kept, { of: gone, on, gone, unnamed: held.unnamed, later: held.later });
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
    // a part of a library unit instance is the unit's, not the import's (its root may be the import's)
    const owner = unitOf(doc, o.id);
    if (owner !== null && owner !== o.id) continue;
    const k = key(o);
    if (!k) continue;
    const from = prop(o, RIDEO_PROPS.clip);
    if (clip && from && from !== clip) continue;
    if (!out.has(k)) out.set(k, o);
  }
  return out;
}

/**
 * rideo's height of a character (its mannequin's top: heightM) over the desk's height of its kind
 * (createActor's height_m: a person's height, an animal's withers): 1 for people, the built kind's
 * top over its withers for animals (a pony's head is about a third above its withers). The import
 * divides rideo's heights by it, the export multiplies the desk's by it.
 */
export function rideoHeightRatio(kind: ActorKind): number {
  if (isHumanoid(kind)) return 1;
  try {
    const m = measureActorKind(kind);
    const r = m.size[2] / m.height;
    return Number.isFinite(r) && r > 0 ? r : 1;
  } catch {
    return 1;
  }
}

/** A short digest of a text (two 32-bit FNV-style lanes and its length). */
function digestOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(16)}.${(b >>> 0).toString(16)}.${text.length}`;
}

/**
 * A digest of what an object does (RIDEO_PROPS.motion): the placement, constraints, pose and
 * animation (its own curves and its data's) of it and of everything parented below it, and a
 * camera's lens. Equal digests: nothing of it was changed. `hang` false leaves out where `root`
 * hangs (its parent) and the channel values a hang with Keep Transform rewrites to keep it where it
 * is (cameraOwnDigest).
 */
export function motionDigest(doc: SceneDoc, root: string, o: { hang?: boolean } = {}): string {
  const parts: unknown[] = [];
  for (const id of subtree(doc, root)) {
    const ob = doc.getObject(id);
    if (!ob) continue;
    const curves = [...doc.listFCurves(id), ...(ob.data ? doc.listFCurves(ob.data) : [])]
      .map((fc) => [fcurveKey(fc), fc.keyframes, fc.extrapolation, fc.mute, fc.modifiers ?? null] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const camera = ob.type === 'CAMERA' && ob.data ? doc.getCamera(ob.data) : null;
    const placed = o.hang !== false || id !== root;
    parts.push([
      id,
      placed ? ob.parent : null,
      placed ? ob.parent_bone : null,
      placed ? ob.location : null,
      placed ? ob.rotation_euler : null,
      placed ? ob.scale : null,
      ob.constraints,
      ob.pose ?? null,
      curves,
      camera,
    ]);
  }
  return digestOf(JSON.stringify(parts));
}

/**
 * A digest of what the person may set on shot camera `id` besides where it hangs: motionDigest with
 * its parent and the channel values a hang with Keep Transform rewrites left out, so its keys and its
 * data's (lens, focus), its constraints and camera settings and what hangs below it. RIDEO_PROPS.motion
 * records it after a camera's motion (recordedMotion's `own`): a camera hung from another object
 * since whose `own` is as recorded was only hung there, not set by hand (cameraOwnAsStaged).
 */
export function cameraOwnDigest(doc: SceneDoc, id: string): string {
  return motionDigest(doc, id, { hang: false });
}

/** The transform channels of an object that a hold, a flight or a hide key writes (and the person may key). */
const OWN_CHANNELS: ReadonlySet<string> = new Set(['location', 'rotation_euler', 'scale']);

/** A number as ownKeysDigest reads it: to 1e-6, so that a channel read back from a matrix keeps its ulps out. */
function digestNumber(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * A digest of the keys and drivers on object `id`'s own transform channels (location, rotation,
 * scale; frames and values to 1e-6): on a prop, what the staging keyed there (its hold, its flight,
 * its hiding) and any key the person added since. RIDEO_PROPS.motion records it after a prop's
 * motion; recordedMotion's `own`.
 */
export function ownKeysDigest(doc: SceneDoc, id: string): string {
  const curves = doc
    .listFCurves(id)
    .filter((fc) => fc.target_type === 'object' && OWN_CHANNELS.has(fc.path))
    .map(
      (fc) =>
        [
          fc.path,
          fc.index,
          fc.keyframes.map((k) => [
            digestNumber(k.frame),
            digestNumber(k.value),
            k.interpolation,
            k.easing ?? null,
          ]),
          fc.extrapolation,
          fc.mute,
          fc.modifiers ?? null,
        ] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const drivers = doc
    .listDrivers(id)
    .filter((d) => d.target_type === 'object' && OWN_CHANNELS.has(d.path))
    .map((d) => [d.path, d.index, d.expression, d.variables, d.mute] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return digestOf(JSON.stringify([curves, drivers]));
}

/**
 * What RIDEO_PROPS.motion records of an object: `all`, the digest of what it did (motionDigest), and
 * `own`, on a prop the digest of the keys on its own transform channels (ownKeysDigest), on a camera
 * that of what was set on it besides where it hangs (cameraOwnDigest); null for a part not recorded
 * (`own` of a staging recorded before props, or cameras, had it).
 */
export function recordedMotion(o: ObjectData | null | undefined): { all: string | null; own: string | null } {
  const [all, own] = prop(o, RIDEO_PROPS.motion).split(' ');
  return { all: all || null, own: own || null };
}

/**
 * Records on object `id` what the staging left it doing (RIDEO_PROPS.motion): `all` its motion
 * digest, `own` (on a prop) the digest of its own transform channels' keys, (on a camera) the digest
 * of what was set on it besides where it hangs; a part not asked for keeps what was recorded before.
 */
export function recordMotionOf(
  doc: SceneDoc,
  id: string,
  parts: { all: boolean; own: boolean } = { all: true, own: true },
): void {
  const o = doc.getObject(id);
  const kind = prop(o, DESK_PROPS.role) === 'prop' ? 'prop' : o?.type === 'CAMERA' ? 'camera' : null;
  if (!o || !(parts.all || (parts.own && kind))) return;
  const was = recordedMotion(o);
  const all = parts.all ? motionDigest(doc, id) : was.all;
  const own = !kind
    ? null
    : !parts.own
      ? was.own
      : kind === 'prop'
        ? ownKeysDigest(doc, id)
        : cameraOwnDigest(doc, id);
  const value = [all ?? '', ...(own ? [own] : [])].join(' ');
  doc.updateObject(id, { custom_props: { ...o.custom_props, [RIDEO_PROPS.motion]: value } });
}

/**
 * Whether the keys on prop `id`'s own transform channels are those the staging left there
 * (recordedMotion's `own`): false when the person keyed it since (their keys move it too). A prop
 * recorded without them counts as left so.
 */
export function ownKeysAsStaged(doc: SceneDoc, id: string): boolean {
  const own = recordedMotion(doc.getObject(id)).own;
  return own === null || own === ownKeysDigest(doc, id);
}

/**
 * Whether shot camera `id` is as the staging left it but for where it hangs (recordedMotion's `own`:
 * cameraOwnDigest): false once the person keyed or set it by hand (its keys or its lens's, its
 * settings, constraints or what hangs below it), and for a camera recorded without it (staged before
 * cameras had it: then a hang cannot be told from what the person set on it).
 */
export function cameraOwnAsStaged(doc: SceneDoc, id: string): boolean {
  const own = recordedMotion(doc.getObject(id)).own;
  return own !== null && own === cameraOwnDigest(doc, id);
}

/** Records on each of `ids` what the import left it doing (RIDEO_PROPS.motion). */
function recordMotion(doc: SceneDoc, ids: Iterable<string>): void {
  for (const id of new Set(ids)) recordMotionOf(doc, id);
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
      `blocking is not a SceneBlocking v1: ${r.error.issues
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
  units: ImportUnits = {},
): RideoImportResult {
  const parsed = RideoImportInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new OperatorError(
      `blocking import: ${parsed.error.issues
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
  const source = input.source;
  if (!input.shots.length)
    throw new OperatorError('blocking import: the clip has no shots', 'INVALID_PARAMS');

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
          `the settings' aspect ratio ${ar} differs from their resolution ${width}×${height}: the desk follows the resolution, as a SceneBlocking does`,
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
    for (const [id, mark] of units.marks ?? openingMarks(ordered, cast))
      if (cast.includes(id)) opening.set(id, mark);
    // a brief never has positions: saying so would be noise there
    if (source === 'rideo')
      warnings.push(
        "the clip has no blocking (state 'missing'): the cast stands where the shots' planned layouts put them and every camera is solved",
      );
  } else if (input.state === 'incomplete')
    warnings.push("the clip's blocking is incomplete: its draft (completed by its source) is imported");
  cast.forEach((id, i) => {
    if (opening.has(id)) return;
    const a = blockActor.get(id);
    const at = a
      ? { x: a.x, z: a.z }
      : freeRowSpot(opening.values(), (i - (cast.length - 1) / 2) * LAYOUT_SPACING_M);
    opening.set(id, {
      x: at.x,
      z: at.z,
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
  // what each shot's camera hangs from before any piece is built anew (a camera on the old piece
  // hangs from the new one then): what the warnings name as what the person hung it from
  const hungBefore = cameraParents(doc);
  const removed: string[] = [];
  // what was changed in the desk since the last import (keys, poses, holds, mounts, flights, a
  // camera solved again): the import rebuilds them from rideo's blocking, so their changes are lost
  const changedSince = new Set<string>();
  // the earlier props the person keyed by hand (keys the staging did not write on their own transform
  // channels), read before anything changes: what followed one does not follow the prop built in its
  // place, whose staging moves it without those keys
  const byHand = new Set<string>();
  if (update) {
    const changed: string[] = [];
    const seen = new Set<string>();
    const check = (o: ObjectData | undefined, label: string) => {
      if (!o || seen.has(o.id)) return;
      seen.add(o.id);
      const recorded = recordedMotion(doc.getObject(o.id)).all;
      if (recorded && motionDigest(doc, o.id) !== recorded) {
        changed.push(label);
        changedSince.add(o.id);
      }
    };
    for (const o of oldProps.values() as Iterable<ObjectData>)
      if (!ownKeysAsStaged(doc, o.id)) byHand.add(o.id);
    for (const o of oldActors.values()) check(o, `'${o.name}'`);
    for (const o of oldProps.values()) check(o as ObjectData, `'${(o as ObjectData).name}'`);
    for (const o of oldLandmarks.values()) check(o as ObjectData, `'${(o as ObjectData).name}'`);
    for (const sh of oldShots)
      if (
        sh.camera &&
        sh.external?.source === source &&
        (!clip || !sh.external.clip || sh.external.clip === clip)
      )
        check(doc.getObject(sh.camera) ?? undefined, `the camera of shot '${sh.name}'`);
    if (changed.length)
      warnings.push(
        `${changed.join(', ')} ${changed.length > 1 ? 'were' : 'was'} changed in the desk since the last import ` +
          "(keys, poses, holds, mounts, flights or a camera): this import rebuilt them from the clip's blocking, " +
          "so those changes are gone. Stage them again, or before importing again export the desk's blocking " +
          '(desk.export_rideo_blocking) and import that, so that the clip carries them',
      );
  }

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
  // what the person put on the set built before stays, on the new one
  warnings.push(...built.warnings);
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
    const { warnings: kept, ...made } = buildLandmark(
      doc,
      l,
      elements.get(l.elementId ?? '')?.name ?? null,
      castNames,
      stamp,
      old,
    );
    for (const w of kept ?? []) warnings.push(`${made.name}: ${w}`);
    landmarkOut.push({ ...made, rideo_id: l.id, element_id: l.elementId, label: l.label });
  }
  // a landmark rideo no longer has goes, but for what the person put on it, which stays on the ground
  for (const [rid, o] of oldLandmarks)
    if (!keptLandmarks.has(rid) && doc.getObject((o as ObjectData).id)) {
      const { id, name } = o as ObjectData;
      removed.push(name);
      warnings.push(...hangOnGround(doc, removeKeeping(doc, [id]), `'${name}'`, built.ground));
    }

  // ------------------------------------------------------------ actors
  const actors = new Map<string, ActorPlan>();
  const actorOut: RideoImportResult['actors'] = [];
  for (const [i, id] of cast.entries()) {
    const { kind, reason } = kinds.get(id)!;
    const b = blockActor.get(id);
    const c = characters.get(id);
    const humanoid = isHumanoid(kind);
    // a library figure: its own height and colour; one pinned but not placed: the figure's height
    const figure = units.figure?.(id);
    const pinned = figure ? undefined : units.figureHeight?.(id);
    // people: rideo's height (the draft's, from the identity); animals: theirs when rideo has one,
    // their mannequin's top in rideo, made the withers the desk sizes an animal by
    let h = b?.heightM ?? c?.heightM ?? null;
    if (!humanoid && (h === null || Math.abs(h - 1.7) < 1e-6)) h = c?.heightM ?? null;
    const heightM = figure
      ? figure.heightM
      : pinned !== undefined
        ? pinned
        : h && h > 0
          ? h / rideoHeightRatio(kind)
          : defaultActorHeight(kind);
    const color = figure ? figure.color : (b?.color ?? ACTOR_PALETTE[i % ACTOR_PALETTE.length]).toLowerCase();
    const first = markOf(ordered[0].id, id);
    const old = oldActors.get(id);
    let actorId: string | null = null;
    let created = false;
    // what the person put on an actor built anew stays, on the new one (the import keys it on its marks)
    let rebuilt: KeptPlaces | null = null;
    if (old) {
      const sameKind = prop(old, DESK_PROPS.kind) === kind;
      const oldH = Number(old.custom_props?.[DESK_PROPS.heightM]);
      const inst = readInstance(doc, old.id);
      // a figure is kept only as that very version
      const sameFigure = figure
        ? !!inst && inst.ref === figure.pin.ref && inst.version === figure.pin.version
        : true;
      if (
        sameKind &&
        sameFigure &&
        Number.isFinite(oldH) &&
        Math.abs(oldH - heightM) < 0.005 &&
        isActor(doc, old.id)
      ) {
        actorId = old.id;
        resetActor(doc, old.id, nameOf(id), color);
      } else {
        rebuilt = removeKeeping(doc, [old.id]);
      }
    }
    if (!actorId && figure) {
      try {
        const r = createFigureActor(doc, figure.unit, {
          pin: figure.pin,
          key: figure.key,
          name: nameOf(id),
          location: floor(first.x, first.z),
          facing_deg: first.facingDeg,
          pose: editorPose(first.pose, kind),
          character_id: id,
        });
        for (const w of r.warnings) warnings.push(`${nameOf(id)}: ${w}`);
        actorId = r.actor;
        created = true;
      } catch (err) {
        // the figure does not go in (nothing of it is left): the mannequin of its kind, height and
        // colour stands in, which the figure restyles in place once it goes in
        units.failed?.(figure.key, err);
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
    if (rebuilt)
      for (const w of hangKept(doc, actorId, rebuilt, {
        of: 'the actor it replaces',
        on: 'the new actor',
        restaged: true,
      }))
        warnings.push(`${nameOf(id)}: ${w}`);
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
  // an actor rideo no longer stages goes, but for what the person put on it, which stays on the ground
  for (const [cid, o] of oldActors)
    if (!actors.has(cid) && doc.getObject(o.id)) {
      removed.push(o.name);
      warnings.push(...hangOnGround(doc, removeKeeping(doc, [o.id]), `'${o.name}'`, built.ground));
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
      warnings.push(...dropTether(doc, old.id, built.ground));
      keptProps.add(p.id);
    }
    const unit = units.prop?.(p);
    // the holds below hold or fly it while its holder is in a shot (every cast member is), else hide it
    const move = propMove(p, flies, !!p.heldBy && cast.includes(p.heldBy));
    const made = buildProp(
      doc,
      p,
      elementName,
      castNames,
      stamp,
      flies,
      move,
      old,
      unit,
      !!old && byHand.has(old.id),
    );
    if (unit && made.failed !== undefined) units.failed?.(unit.key, made.failed);
    for (const w of made.warnings ?? []) warnings.push(`${doc.getObject(made.root)!.name}: ${w}`);
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
  // a prop rideo no longer has goes with its string, but for what the person put on them, which
  // stays on the ground
  for (const [rid, o] of oldProps)
    if (!keptProps.has(rid) && doc.getObject((o as ObjectData).id)) {
      const { id, name } = o as ObjectData;
      removed.push(name);
      const gone = removeKeeping(doc, [id, ...tetherPartsOf(doc, id)]);
      warnings.push(...hangOnGround(doc, gone, `'${name}'`, built.ground));
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
        s.external?.source === source &&
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
        source,
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
    const fromClip = s.external?.source === source && (!clip || !s.external.clip || s.external.clip === clip);
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

  // ------------------------------------------------------------ the cast rideo puts in its water
  markCastInWater(
    doc,
    blocking.set.landmarks,
    (l) => elements.get(l.elementId ?? '')?.name ?? null,
    plans,
    actors,
  );

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
    placeCamera(
      doc,
      s,
      p,
      cameraSpace(doc, s, warnings, changedSince.has(s.camera!), hungBefore.get(s.camera!)),
    );
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
        `${p.name}: the blocked camera disagreed with the shot's planned layout; refitted (${fit.spec.angle})`,
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
      `${boards.length} shot board(s) were drawn before this staging (${boards
        .map((b) => b.shot)
        .join(
          ', ',
        )}): redraw them from the desk's camera views, or send those shots' references in 'camera' mode`,
    );

  // the cameras placed as rideo blocked them keep rideo's placement, for the export to give back
  for (const p of plans) {
    const cam = getShots(doc).find((sh) => sh.id === p.id)?.camera;
    const o = cam ? doc.getObject(cam) : null;
    if (!o) continue;
    const kept = { ...o.custom_props };
    delete kept[RIDEO_PROPS.camera];
    if (p.camera && from.get(p.id) === 'blocking')
      kept[RIDEO_PROPS.camera] = JSON.stringify({ shot: p.input.id, camera: p.camera });
    doc.updateObject(o.id, { custom_props: kept });
  }
  // what the import leaves each of its objects doing, for a later import to tell changes by
  recordMotion(doc, [
    ...[...actors.values()].map((a) => a.id),
    ...[...props.values()].map((p) => p.root),
    ...landmarkOut.map((l) => l.id),
    ...getShots(doc)
      .filter((sh) => sh.camera && plans.some((p) => p.id === sh.id))
      .map((sh) => sh.camera!),
  ]);

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

/** How far apart (m) the planned sides put the cast, and the rows behind each other on a side. */
export const LAYOUT_SPACING_M = 1.2;

/**
 * Opening marks of a clip without blocking: each character on the side of the frame the first shot
 * that plans it puts it (left −1.2 m, centre 0, right +1.2 m, front to back in order), facing the way
 * it is planned to face a front camera. The others have none here: the import stands them in a row
 * (as rideo's emptyBlocking).
 */
export function layoutMarks(
  shots: readonly Pick<RideoShotInput, 'layout'>[],
  cast: readonly string[],
): Map<string, RideoBlockingMark> {
  const out = new Map<string, RideoBlockingMark>();
  const sideX = { left: -LAYOUT_SPACING_M, centre: 0, right: LAYOUT_SPACING_M } as const;
  const facingDeg = { camera: 0, away: 180, left: 270, right: 90 } as const;
  const used = new Map<string, number>();
  for (const s of shots)
    for (const e of s.layout) {
      if (out.has(e.characterId) || !cast.includes(e.characterId)) continue;
      const n = used.get(e.side) ?? 0;
      used.set(e.side, n + 1);
      out.set(e.characterId, {
        x: sideX[e.side],
        z: -n * LAYOUT_SPACING_M,
        facingDeg: facingDeg[e.facing],
        pose: 'stand',
        toX: null,
        toZ: null,
      });
    }
  return out;
}

/**
 * Opening marks of a clip without blocking, for every character of `cast` (in cast order): where the
 * shots' planned layouts put them (layoutMarks), the others on free spots of the front row.
 */
export function openingMarks(
  shots: readonly Pick<RideoShotInput, 'layout'>[],
  cast: readonly string[],
): Map<string, RideoBlockingMark> {
  const out = layoutMarks(shots, cast);
  cast.forEach((id, i) => {
    if (out.has(id)) return;
    const at = freeRowSpot(out.values(), (i - (cast.length - 1) / 2) * LAYOUT_SPACING_M);
    out.set(id, { x: at.x, z: at.z, facingDeg: 0, pose: 'stand', toX: null, toZ: null });
  });
  return out;
}

/**
 * A spot on the front row (z = 0) for a character without a mark: x `preferred`, else the nearest
 * spot 1.2 m steps away (right first) that no mark taken holds (rideo's OVERLAP_M: two figures closer
 * than 0.35 m stand in the same place).
 */
export function freeRowSpot(taken: Iterable<RideoBlockingMark>, preferred: number): { x: number; z: number } {
  const marks = [...taken];
  const free = (x: number) => marks.every((m) => Math.hypot(m.x - x, m.z) >= LAYOUT_SPACING_M / 2);
  for (let k = 0; k <= 2 * RIDEO_MAX_ACTORS + marks.length; k++) {
    const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
    const x = preferred + step * LAYOUT_SPACING_M;
    if (free(x)) return { x, z: 0 };
  }
  return { x: preferred, z: 0 };
}

// ---------------------------------------------------------------- moves

/**
 * The move a shot is keyed with and rideo prompts: its camera.move, else (rideo sets it so when the
 * blocking is saved) the move its blocked camera's end amounts to, else its planned movement's.
 */
export function shotMove(
  s: RideoShotInput,
  camera: RideoBlockingCamera | null,
  warnings: string[],
): DeskMove {
  if (s.camera.move) {
    const said = camera?.end ? cameraMoveOf(placementOf(camera), placementOf(camera.end)) : null;
    if (said && said !== s.camera.move)
      warnings.push(
        `shot ${s.index + 1}: its camera move is ${s.camera.move} but its blocked camera's end is a ${said}: ${s.camera.move} is keyed (the export writes its end back)`,
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
    warnings.push(`shot ${s.index + 1}: its movement is a pan without a direction; keyed as ${move}`);
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

/** Whether matrix `m` turns and scales alike along every axis: no skew, no uneven scale, no mirror. */
function evenAxes(m: Readonly<Mat4>): boolean {
  const axis = (k: number): Vec3 => [m[k * 4], m[k * 4 + 1], m[k * 4 + 2]];
  const [x, y, z] = [axis(0), axis(1), axis(2)];
  const len = [x, y, z].map((v) => Math.hypot(v[0], v[1], v[2]));
  const s = len[0];
  if (!(s > 1e-9) || len.some((l) => Math.abs(l - s) > 1e-9 * s)) return false;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if ([dot(x, y), dot(x, z), dot(y, z)].some((d) => Math.abs(d) > 1e-9 * s * s)) return false;
  return determinant4(m) > 0;
}

/** What a shot's camera hung from before an import or an update built anything anew (cameraParents). */
export interface HungFrom {
  /** The object's id then. */
  id: string;
  /** Its name then. */
  name: string;
}

/**
 * What each shot's camera hangs from, by camera (cameras on nothing left out): read before an import
 * or an update builds a piece anew, which hangs a camera that hung from the old piece from the new
 * one (units/remove.ts hangKept), so that a warning names the object the person hung it from.
 */
export function cameraParents(doc: SceneDoc): Map<string, HungFrom> {
  const out = new Map<string, HungFrom>();
  for (const s of getShots(doc)) {
    const cam = s.camera ? doc.getObject(s.camera) : null;
    const parent = cam?.parent ? doc.getObject(cam.parent) : null;
    if (cam && parent) out.set(cam.id, { id: parent.id, name: parent.name });
  }
  return out;
}

/**
 * Where what the camera of `shot` hangs from (its parent, through what is above that) stands in the
 * world at each frame of the shot, from its first (null: the camera hangs from nothing): read before
 * a brief update builds or stages anything anew, to tell (sameMotion) whether that still moves in the
 * shot as it did.
 */
export function hungMotion(doc: SceneDoc, shot: ShotData): Mat4[] | null {
  const cam = shot.camera ? doc.getObject(shot.camera) : null;
  if (!cam?.parent) return null;
  const out: Mat4[] = [];
  for (let f = shot.frame_start; f <= shot.frame_end; f++) out.push(new FrameState(doc, f).parent(cam.id));
  return out;
}

/**
 * Whether two hungMotion readings of a shot agree (sameWorld, to rounding) at each frame from the
 * shot's first over the frames both hold: a shot made longer or shorter, or moved by a ripple, keeps
 * the motion of what its camera hangs from when those frames do.
 */
export function sameMotion(a: readonly Mat4[], b: readonly Mat4[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (!sameWorld(b[i], a[i])) return false;
  return true;
}

/**
 * How a warning names `now`, what a shot's camera hangs from: as the person hung it (`was`, read
 * before anything was built anew), and what was built in its place ("'kite' (built anew as
 * 'balloon')") or what it was renamed ("'Mira' (now 'Mira Jones')").
 */
export function hungFromName(doc: SceneDoc, now: ObjectData, was: HungFrom | undefined): string {
  if (!was || (was.id === now.id && was.name === now.name)) return `'${now.name}'`;
  if (was.id === now.id) return `'${was.name}' (now '${now.name}')`;
  if (doc.getObject(was.id)) return `'${now.name}'`;
  return was.name === now.name ? `'${was.name}' (built anew)` : `'${was.name}' (built anew as '${now.name}')`;
}

/** Why a shot's camera does not stay on what it hangs from (cameraHold), as a warning says it. */
const UNSTEADY = {
  moves: 'moves during the shot',
  uneven: 'is scaled unevenly or mirrored',
  hidden: 'is hidden by its scale in the shot',
} as const;

/**
 * Whether the camera of `shot` can stay on what it hangs from through the shot (null: it hangs from
 * nothing): `space` is that object's world matrix at the shot's first frame, and `why` (null: it can
 * stay) why it cannot. It moves in the shot (it is not where it is at the first frame at every frame
 * of the shot: keys in its space would hold the camera at the keys only); it is hidden by its scale
 * there (hide.ts hiddenByScale: a camera on it stands where its squashed space puts it, far off where
 * it is shown); or it turns and scales the camera unevenly (scaled unevenly, skewed or mirrored:
 * evenAxes), which bends the camera.
 */
function cameraHold(
  doc: SceneDoc,
  shot: ShotData,
): { parent: ObjectData; space: Mat4; why: keyof typeof UNSTEADY | null } | null {
  const cam = shot.camera!;
  const o = doc.getObject(cam);
  const parent = o?.parent ? doc.getObject(o.parent) : null;
  if (!o || !parent) return null;
  const space = new FrameState(doc, shot.frame_start).parent(cam);
  let still = true;
  // nothing above it keyed, driven, constrained or simulated: it stands still at every frame
  if (moversOf(doc, cam).length)
    for (let f = shot.frame_start + 1; f <= shot.frame_end && still; f++)
      still = sameWorld(new FrameState(doc, f).parent(cam), space);
  const why = !still ? 'moves' : hiddenByScale(space) ? 'hidden' : !evenAxes(space) ? 'uneven' : null;
  return { parent, space, why };
}

/**
 * Takes the camera of `shot` off what it hangs from, where it stands in the world at the shot's first
 * frame (where it stands at rest when its parent squashes it there, flat or to a point: a hidden
 * actor), at scale 1: the stretch an uneven parent gave its world matrix goes with the parent.
 */
function takeCameraOff(doc: SceneDoc, shot: ShotData): void {
  const cam = shot.camera!;
  const world = new FrameState(doc, shot.frame_start).world(cam);
  const placed =
    world &&
    world.every(Number.isFinite) &&
    !hiddenByScale(world) &&
    [0, 1, 2].every((k) => Math.hypot(world[k * 4], world[k * 4 + 1], world[k * 4 + 2]) > 1e-9);
  doc.setParent(cam, null, true, placed ? { world, parentWorld: null } : undefined);
  doc.updateObject(cam, { scale: [1, 1, 1] });
}

/**
 * The world matrix a shot's blocked camera is placed through: its parent's (null: it hangs from
 * nothing). A camera the person hung from another object (a rig) stays on it while that object
 * stands still through the shot, scaled evenly, not mirrored and shown (cameraHold): the blocking's
 * placement, turned into the parent's space (as CameraKeys.pose turns a solved one), then holds at
 * every frame. Hung from something that moves in the shot (a kite, an actor), keys in its space would
 * hold that placement at the keys only, an uneven parent bends the camera and a hidden one squashes
 * it: such a camera is taken off its parent (takeCameraOff), and `warnings` says so, naming what the
 * person hung it from (`was`: hungFromName). One kept on its parent that the re-import names as
 * changed since the last import (`named`: hung from it since) is said to stay on it, as that warning
 * says those changes are gone.
 */
function cameraSpace(
  doc: SceneDoc,
  shot: ShotData,
  warnings: string[],
  named: boolean,
  was: HungFrom | undefined,
): Mat4 | null {
  const hold = cameraHold(doc, shot);
  if (!hold) return null;
  const from = hungFromName(doc, hold.parent, was);
  if (!hold.why) {
    if (named)
      warnings.push(
        `${shot.name}: its camera stays hung from ${from}, which stands still in the shot; ` +
          "the import placed it in its space where the clip's blocking has it",
      );
    return hold.space;
  }
  takeCameraOff(doc, shot);
  warnings.push(
    `${shot.name}: its camera hung from ${from}, which ${UNSTEADY[hold.why]}; ` +
      `the import took it off '${hold.parent.name}' to place it where the clip's blocking has it`,
  );
  return null;
}

/**
 * A brief update's rule for the camera of `shot`, a camera it solves (update.ts): kept on what it
 * hangs from while that stands still through the shot, scaled evenly, not mirrored and shown
 * (cameraHold; a solve keys it in that space, as CameraKeys.pose does); else taken off it
 * (takeCameraOff) for the caller to solve again, and `warnings` says so, naming what the person hung
 * it from (`was`, read before the update built anything anew: hungFromName) and why, and the other
 * shots that use the camera (`also`, their names: the caller solves it again for them too).
 * `moving`: taken off only when what it hangs from moves in the shot (the update solves it because
 * that now moves otherwise than it did). Returns whether it was taken off.
 */
export function updateCameraHold(
  doc: SceneDoc,
  shot: ShotData,
  was: HungFrom | undefined,
  warnings: string[],
  o: { moving?: boolean; also?: readonly string[] } = {},
): boolean {
  const hold = cameraHold(doc, shot);
  if (!hold?.why || (o.moving && hold.why !== 'moves')) return false;
  const from = hungFromName(doc, hold.parent, was);
  takeCameraOff(doc, shot);
  const also = o.also ?? [];
  const others = also.length > 1 ? `${also.slice(0, -1).join(', ')} and ${also[also.length - 1]}` : also[0];
  warnings.push(
    `${shot.name}: its camera hung from ${from}, which ${UNSTEADY[hold.why]}; ` +
      `the update took it off '${hold.parent.name}' and solved it again` +
      (also.length ? `, also for ${others}, which ${also.length > 1 ? 'use' : 'uses'} the same camera` : ''),
  );
  return true;
}

/**
 * Poses a shot's camera as rideo blocked it (position, target, lens) and keys its move: the blocked
 * end itself when it is the shot's move (an orbit along its arc; see endIsMove), else the shot's move
 * from the blocked start; a locked-off shot holds its pose. `space`: the parent's world matrix the
 * camera hangs from (cameraSpace), still through the shot; its channels are the placement in it.
 */
function placeCamera(doc: SceneDoc, shot: ShotData, p: ShotPlan, space: Mat4 | null): void {
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
  const placed = inSpace(space, start.position, rotation, o.rotation_euler);
  doc.updateObject(cam, { location: placed.location, rotation_euler: placed.rotation });
  const move = shot.move;
  if (end && endIsMove(move, start, end)) {
    keyPlacedMove(doc, cam, start, end, shot.frame_start, shot.frame_end, rotation, space);
    return;
  }
  if (move && move !== 'locked_off')
    applyCameraMove(doc, cam, move, {
      frame_start: shot.frame_start,
      frame_end: shot.frame_end,
      seed: shot.id,
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
 * The channels that stand an object hung from world matrix `space` (null: from nothing) at `position`
 * turned by world Euler `euler`: local = inverse(space) × world, its rotation the Euler closest to
 * `prev` (as CameraKeys.pose keys a camera through its parent).
 */
function inSpace(
  space: Mat4 | null,
  position: Vec3,
  euler: Vec3,
  prev: Readonly<Vec3>,
): { location: Vec3; rotation: Vec3 } {
  if (!space) return { location: position, rotation: euler };
  const d = decomposeCompatible(
    multiply4(invert4(space), compose4(position, euler, [1, 1, 1])),
    prev,
    [1, 1, 1],
  );
  return d ? { location: d.location, rotation: d.rotation } : { location: position, rotation: euler };
}

/**
 * Keys a camera from `start` to `end` over [f0, f1]: along the arc around the target when the target
 * stays and the distance to it does (an orbit), else straight; eased (smoothstep), at most 12 keys,
 * each looking at the target where it is then. `euler`: the world rotation at `start`; `space`: the
 * world matrix the camera hangs from (inSpace), which the keys are turned into.
 */
function keyPlacedMove(
  doc: SceneDoc,
  cam: string,
  start: { position: Vec3; target: Vec3 },
  end: { position: Vec3; target: Vec3 },
  f0: number,
  f1: number,
  euler: Vec3,
  space: Mat4 | null,
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
  let rot = euler;
  let local = doc.getObject(cam)!.rotation_euler as Vec3;
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
    const placed = inSpace(space, pos, rot, local);
    local = placed.rotation;
    at.push(f0 + Math.round(u * frames * 1000) / 1000);
    for (let i = 0; i < 3; i++) {
      loc[i].push(placed.location[i]);
      eul[i].push(placed.rotation[i]);
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

/** What the span helpers read of a shot: its key frame, its end, its cast and words, its blocked camera. */
export interface SpanShot {
  keyFrame: number;
  frameEnd: number;
  camera: RideoBlockingCamera | null;
  input: Pick<RideoShotInput, 'characterIds' | 'description' | 'action'>;
}

/** Consecutive shots (by plan index) whose cast includes `characterId`. */
export function holderSpans(
  plans: readonly Pick<SpanShot, 'input'>[],
  characterId: string,
): { from: number; to: number }[] {
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
export function hiddenSpans(
  spans: readonly { from: number; to: number }[],
  plans: readonly Pick<SpanShot, 'keyFrame'>[],
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
  // a library figure's colour is the figure's (the unit's): it stays
  if (readInstance(doc, id)?.kind !== 'figure')
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
  // a mark is the whole body's pose: never layered over the pose it had before (a seated mark
  // after a standing one, or a gesture after a seated one, must not keep the other's legs)
  applyPose(doc, a.id, editorPose(m.pose, a.kind), { frame, blend_frames: 0, layer: 'full' });
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
            applyPose(doc, a.id, editorPose(m.pose, a.kind), {
              frame: p.keyFrame,
              blend_frames: 0,
              layer: 'full',
            });
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

/** Whether `o` is a string or tail desk.tether_fly made for a flyer (see tetherPartsOf). */
export function isTetherPart(o: ObjectData): boolean {
  return (
    typeof o.custom_props?.desk_string_to === 'string' || typeof o.custom_props?.desk_tail_of === 'string'
  );
}

/** The string and tail objects desk.tether_fly made for a flyer. */
export function tetherPartsOf(doc: SceneDoc, flyer: string): string[] {
  return doc
    .listObjects()
    .filter((o) => o.custom_props?.desk_string_to === flyer || o.custom_props?.desk_tail_of === flyer)
    .map((o) => o.id);
}

/**
 * Takes out the string and tail desk.tether_fly made for flyer `flyer` (a flight flown again makes
 * new ones), but for what the person put on them, which stays on the ground (hangOnGround). Returns
 * the warnings naming it.
 */
export function dropTether(doc: SceneDoc, flyer: string, ground?: string | null): string[] {
  const parts = tetherPartsOf(doc, flyer);
  if (!parts.length) return [];
  const gone = `'${doc.getObject(parts[0])?.name ?? parts[0]}'`;
  return hangOnGround(doc, removeKeeping(doc, parts), gone, ground);
}

/** Whether an earlier import's object (in the scene) was built as `build` says, to be kept; one built otherwise is built anew. */
function keepable(doc: SceneDoc, old: ObjectData | undefined, build: string): old is ObjectData {
  if (!old || !doc.getObject(old.id)) return false;
  if (prop(doc.getObject(old.id), RIDEO_PROPS.build) === build) return true;
  // a library unit instance is kept with its look (only unit actions change it)
  return !!readInstance(doc, old.id);
}

/** The library item and version an imported prop was built from ('unit:<ref>@<version>' recipes), else null. */
function unitBuildOf(doc: SceneDoc, id: string): { ref: string; version: number } | null {
  try {
    const b = JSON.parse(prop(doc.getObject(id), RIDEO_PROPS.build)) as unknown;
    const m = Array.isArray(b) && typeof b[1] === 'string' ? /^unit:(.+)@(\d+)$/.exec(b[1]) : null;
    return m ? { ref: m[1], version: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

/** Points the shots' subjects and layouts that name object `from` at `to`. */
function remapShotRefs(doc: SceneDoc, from: string, to: string): void {
  const shots = getShots(doc);
  if (!shots.some((s) => s.subjects.includes(from) || s.layout.some((e) => e.subject === from))) return;
  setShots(
    doc,
    shots.map((s) => ({
      ...s,
      subjects: s.subjects.map((id) => (id === from ? to : id)),
      layout: s.layout.map((e) => (e.subject === from ? { ...e, subject: to } : e)),
    })),
  );
}

/**
 * How the staging moves a prop whose element has a holder (rideo's heldBy): in the holder's hand
 * ('held'), on a string from it ('flown': a kite or a balloon), or out of sight while the holder is
 * in no shot ('hidden').
 */
export interface PropMove {
  /** The holder's character id. */
  by: string;
  how: 'held' | 'flown' | 'hidden';
  /**
   * The person keyed the prop too (its own transform channels carry keys the staging did not write,
   * ownKeysAsStaged): those keys move it beside its holder, and go with it.
   */
  byHand?: boolean;
}

/**
 * How the staging moves prop `p` (null: not at all, it has no holder): its holder holds it, or flies
 * it as `flies` says, while the holder is in a shot (`inShot`); it is hidden otherwise.
 */
export function propMove(
  p: Pick<RideoBlockingProp, 'heldBy'>,
  flies: 'kite' | 'balloon' | null,
  inShot: boolean,
): PropMove | null {
  if (!p.heldBy) return null;
  return { by: p.heldBy, how: !inShot ? 'hidden' : flies ? 'flown' : 'held' };
}

/** The tether flights a flyer records (desk.tether_fly: "lo:hi[hs][@anchor[/bone]]" entries). */
const FLIGHTS = 'desk_tether_flights';

/**
 * How the staging moved an earlier prop (see PropMove), read before it goes: by the holder it records
 * (RIDEO_PROPS.heldBy), flown when it carries a flight, held when it carries a hold, else hidden;
 * null when it records no holder (the staging left it where it stands). `byHand`: the person keyed
 * it too (read before the update or import changed anything: ownKeysAsStaged).
 */
function movedBy(doc: SceneDoc, id: string, byHand: boolean): PropMove | null {
  const o = doc.getObject(id);
  const by = prop(o, RIDEO_PROPS.heldBy);
  if (!o || !by) return null;
  const how: PropMove['how'] = prop(o, FLIGHTS).trim()
    ? 'flown'
    : (o.constraints ?? []).some((c) => !c.mute && c.type === 'CHILD_OF' && c.name.startsWith('Hold '))
      ? 'held'
      : 'hidden';
  return byHand ? { by, how, byHand } : { by, how };
}

/**
 * Whether the staging moves a prop built anew as it moved the one it takes the place of (KeptWords'
 * `restaged`): held, or flown, again by the same holder, or hidden again, and the old one carried no
 * keys of the person's (their keys moved it too, and go with it). What was on the old one then
 * follows the new one; otherwise what moved it with the old one is named (a flight or a hold lost
 * with the holder, keys the person gave the old prop).
 */
const movesAlike = (was: PropMove | null, now: PropMove | null): boolean =>
  !!was && !!now && !was.byHand && was.by === now.by && was.how === now.how;

/**
 * A prop staged from a library unit (see buildProp): the instance with key `unit.key`, its root at the
 * prop's spot with its base on the ground and the unit's own size. An earlier root of the same library
 * item (an instance, or one made local) is kept, updated to the pin's version, cleared of its
 * animation and of the import's holds; another earlier root is swapped for the unit (the unit's root
 * takes its id when their types agree, else shots that named it name the new root). A version whose
 * root is another type of object than the instance's (an empty in one version, a mesh in the next),
 * which no update turns into the other, takes the instance's place as another item's unit does, with
 * a warning. What the person put on the prop a unit takes the place of (objects of their own below
 * it, not its look) stays, hung from the new root where it is in the world (insertUnit's `keep`), and
 * follows the root's motion where the staging moves it (`move`) as it moved that prop (movesAlike;
 * `byHand`: the person keyed that prop too, see buildProp). `unnamed`: what of that the caller
 * takes out right after (see buildProp), which the insert keeps like the rest but names in no
 * warning.
 */
function buildUnitProp(
  doc: SceneDoc,
  p: RideoBlockingProp,
  label: string,
  props: Record<string, string | number | boolean>,
  flies: 'kite' | 'balloon' | null,
  move: PropMove | null,
  old: ObjectData | undefined,
  unit: StagedProp,
  byHand: boolean,
  unnamed: readonly string[],
): { root: string; baseScale: Vec3; model: string | null; created: boolean; warnings: string[] } {
  const model = `unit:${unit.pin.ref}@${unit.pin.version}`;
  const build = JSON.stringify(['prop', model, label, flies]);
  const own = stampFacts({ ...props, [RIDEO_PROPS.build]: build }, unit.facts);
  const at: Vec3 = [p.x, -p.z, -unit.base];
  const cur = old && doc.getObject(old.id) ? old : undefined;
  const inst = cur ? readInstance(doc, cur.id) : null;
  const sameItem = cur && (inst ? inst.ref === unit.pin.ref : unitBuildOf(doc, cur.id)?.ref === unit.pin.ref);
  const unitRoot = unit.unit?.body.blocks.objects?.['@root'];
  const curType = cur ? doc.getObject(cur.id)?.type : undefined;
  // the instance's own item at another version: updated in place, unless its root is another type of
  // object than the instance's, which no update turns into the other: it then takes the instance's
  // place, in the insert's transaction, as another item's unit does
  const next =
    inst && sameItem && unit.unit && (inst.version !== unit.pin.version || inst.sha256 !== unit.pin.sha256)
      ? unit.unit
      : null;
  const retyped = next !== null && unitRoot !== undefined && unitRoot.type !== curType;
  // the scene's root as its version wrote it (then its type is the version's own), or edited here
  const rootEdited =
    retyped && cur
      ? unitStatus(doc, cur.id).edited.some((p) => p.kind === 'objects' && p.src === UNIT_ROOT)
      : false;
  const curName = cur ? doc.getObject(cur.id)?.name : undefined;
  let root: string;
  let created = false;
  const warnings: string[] = [];
  if (cur && sameItem && !retyped) {
    root = cur.id;
    if (next) updateUnit(doc, root, next, unit.pin);
    clearAnimation(doc, root);
    removeAttachments(doc, root);
  } else {
    if (!unit.unit) throw new OperatorError(`the library unit of '${label}' is not here to place`, 'FAILED');
    const swap = cur && !inst && unitRoot && curType === unitRoot.type ? cur.id : undefined;
    // the prop it takes the place of goes in the insert's own transaction (a unit that does not go
    // in leaves it as it is), but for what the person put on it, which the root placed at the
    // prop's spot takes over where it is
    const r = insertUnit(doc, unit.unit, {
      ...unit.pin,
      key: unit.key,
      name: label,
      location: at,
      rotation_euler: [0, 0, 0],
      ...(swap ? { replace: swap } : {}),
      ...(cur && !swap
        ? {
            remove: [cur.id],
            keep: oldLook(doc, cur.id).kept,
            restaged: movesAlike(movedBy(doc, cur.id, byHand), move),
          }
        : {}),
      rootProps: own,
      unnamed,
    });
    root = r.root;
    // what the person put on the prop the unit replaces stays, named here
    warnings.push(...r.warnings);
    if (retyped && inst) {
      // v1's own root type is the scene's only while the scene left its root as v1 wrote it
      const was = rootEdited
        ? `the scene's '${curName}' (v${inst.version}'s root, edited here) ${withArticle(curType)}`
        : `v${inst.version}'s ${withArticle(curType)}`;
      warnings.push(
        `v${unit.pin.version}'s root is ${withArticle(unitRoot?.type)} and ${was}, so v${unit.pin.version} replaces v${inst.version}, edits and all, instead of updating it`,
      );
    }
    if (cur && !swap) remapShotRefs(doc, cur.id, root);
    created = !swap;
  }
  const o = doc.getObject(root)!;
  doc.updateObject(root, {
    location: at,
    rotation_euler: [0, 0, 0],
    custom_props: { ...o.custom_props, ...own },
  });
  const s = doc.getObject(root)!.scale;
  return { root, baseScale: [s[0], s[1], s[2]], model, created, warnings };
}

/** `props` with the planning facts a unit's root keeps (desk_unit_facts), when there are any. */
const stampFacts = (
  props: Record<string, string | number | boolean>,
  facts: string | null,
): Record<string, string | number | boolean> => (facts ? { ...props, desk_unit_facts: facts } : props);

/**
 * Adds a prop: the built-in model its element or label names, fitted to `size`, else a cube of edge
 * `size`; an earlier import's prop built the same way is kept (with what was added to it since),
 * cleared of its animation and of the import's holds, which the import keys anew, and put back on
 * its mark. With `unit`, the library prop (buildUnitProp); one that does not go in (its update or
 * insert throws before writing anything) leaves the prop the element had as it was and is staged as
 * without a unit (the words' prop, or that prop kept): `failed` holds the error. `unit` null: the
 * library prop the element had goes for the words' prop, and what the person put on it (objects of
 * their own below it, not its parts) stays, hung from the words' prop where it is in the world; the
 * warnings name it (units/remove.ts hangKept). So does what the person put on an earlier prop built
 * otherwise (the words describe it anew), which goes for the prop built in its place; the shots that
 * named it name the new one. `move`: how the staging moves the prop once it is built (its hold or
 * flight comes after); what was on the prop it replaces follows the new one's motion where it moves
 * it as it moved that one (movesAlike), and is named as no longer following that one's otherwise.
 * `byHand`: the person keyed `old` by hand (keys the staging did not write on its own transform
 * channels, read by the caller before anything changed: ownKeysAsStaged); those keys go with it, so
 * what was on it is named whatever moves the new prop. `fallback` false: a unit that does not go in
 * throws its error instead, the scene as it was (an update whose words give no reason to stage the
 * prop again leaves it as the desk has it). `unnamed`: objects below `old` that the caller takes
 * out right after a unit went in, its own warning naming what goes (the string and tail of the
 * flight before, which an update acting for the prop's slot alone takes out only once its unit is
 * in: dropTether); the unit's insert keeps them like the rest but names them in no warning.
 */
export function buildProp(
  doc: SceneDoc,
  p: RideoBlockingProp,
  elementName: string,
  castNames: readonly string[],
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
  flies: 'kite' | 'balloon' | null,
  move: PropMove | null,
  old?: ObjectData,
  unit?: StagedProp | null,
  byHand = false,
  fallback = true,
  unnamed: readonly string[] = [],
): {
  root: string;
  baseScale: Vec3;
  model: string | null;
  created: boolean;
  warnings?: string[];
  failed?: unknown;
} {
  const label = p.label || elementName || p.id;
  if (unit)
    try {
      return buildUnitProp(
        doc,
        p,
        label,
        stamp({
          [DESK_PROPS.role]: 'prop',
          [DESK_PROPS.label]: label,
          [RIDEO_PROPS.id]: p.id,
          [DESK_PROPS.color]: p.color,
          ...(p.elementId ? { [DESK_PROPS.elementId]: p.elementId } : {}),
        }),
        flies,
        move,
        old,
        unit,
        byHand,
        unnamed,
      );
    } catch (err) {
      if (!fallback) throw err;
      return {
        ...buildProp(doc, p, elementName, castNames, stamp, flies, move, old, undefined, byHand),
        failed: err,
      };
    }
  // null: the element has no unit (any more): an instance of one goes, for the words' prop (the
  // shots that named it name the new prop), but for what the person put on it (objects of their own
  // below it, not its parts), which the words' prop takes over where it is
  let replaced: string | null = null;
  let kept: KeptPlaces | null = null;
  // how the staging moved the prop that goes (what is on it follows the new one only when it moves alike)
  let was: PropMove | null = null;
  let of = 'the library prop';
  if (
    unit === null &&
    old &&
    doc.getObject(old.id) &&
    (readInstance(doc, old.id) || unitBuildOf(doc, old.id))
  ) {
    replaced = old.id;
    was = movedBy(doc, old.id, byHand);
    kept = keptPlaces(doc, readInstance(doc, old.id) ? oldLook(doc, old.id).kept : [], [old.id]);
    removeTrees(doc, [old.id], kept.ids);
    old = undefined;
  }
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
  const prior = old && doc.getObject(old.id) ? old.id : null;
  if (prior && !keepable(doc, old, build)) {
    // built otherwise now: the prop goes for the one built in its place, but for what the person put
    // on it (objects of their own below it, not its look), which the new prop takes over where it is
    replaced = prior;
    was = movedBy(doc, prior, byHand);
    kept = removeKeeping(doc, [prior]);
    of = 'the prop it replaces';
    old = undefined;
  }
  let root: string;
  let created = true;
  if (keepable(doc, old, build)) {
    root = old.id;
    created = false;
    const inst = readInstance(doc, root);
    // the import's own keys (holds, flights, hiding) are on the prop and its look (a model's tail): a
    // library unit's parts carry none; what the person put on the prop keeps its own
    for (const id of inst ? [root] : [root, ...oldLook(doc, root).look]) clearAnimation(doc, id);
    removeAttachments(doc, root);
    const o = doc.getObject(root)!;
    doc.updateObject(root, {
      // a library prop stands on its base (its root's height is kept)
      location: inst ? [at[0], at[1], o.location[2]] : at,
      rotation_euler: [0, 0, 0],
      custom_props: inst
        ? { ...o.custom_props, ...props, [RIDEO_PROPS.build]: prop(o, RIDEO_PROPS.build) || build }
        : { ...o.custom_props, ...props },
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
  // what stays follows the new prop, and is named as no longer following the old one's motion unless
  // the staging moves the new one alike (held or flown again by the same holder, or hidden again)
  const warnings = kept
    ? hangKept(doc, root, kept, { of, on: "the words' prop", restaged: movesAlike(was, move) })
    : [];
  if (replaced) remapShotRefs(doc, replaced, root);
  const s = doc.getObject(root)!.scale;
  return { root, baseScale: [s[0], s[1], s[2]], model, created, ...(warnings.length ? { warnings } : {}) };
}

/**
 * Adds a landmark: water as a flat plane, else a primitive, or the built-in model its label names
 * (its footprint centred on the mark); an earlier import's landmark built the same way is kept (with
 * what was added to it since) and put on its mark. One built otherwise goes for the one built in its
 * place, but for what the person put on it (objects of their own below it, not its look), which the
 * new landmark takes over where it is in the world; `warnings` names it (units/remove.ts hangKept).
 */
export function buildLandmark(
  doc: SceneDoc,
  l: RideoBlockingLandmark,
  elementName: string | null,
  castNames: readonly string[],
  stamp: (o: Record<string, string | number | boolean>) => Record<string, string | number | boolean>,
  old?: ObjectData,
): {
  id: string;
  name: string;
  shape: string;
  model: string | null;
  created: boolean;
  warnings?: string[];
} {
  const label = l.label || elementName || l.id;
  const water = l.shape === 'water';
  const shape = water ? 'water' : l.shape;
  // a box or a cylinder of water (rideo's 'river'): the primitive, whose top is water over all of
  // its footprint, as rideo draws it (a lake model's shore would take its edge)
  const wet = !water && rideoWater(l, elementName);
  const color =
    l.color.toLowerCase() === '#8a8f98' && l.label ? rideoLandmarkColor(l.label, l.shape) : l.color;
  const found =
    water || wet
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
  const prior = old && doc.getObject(old.id) ? old.id : null;
  const kept = prior && !keepable(doc, old, build) ? removeKeeping(doc, [prior]) : null;
  if (kept) old = undefined;
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
      roughness: water || wet ? 0.1 : 0.8,
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
  const warnings = kept
    ? hangKept(doc, id, kept, { of: 'the landmark it replaces', on: 'the new landmark' })
    : [];
  return { id, name: o.name, shape, model, created, ...(warnings.length ? { warnings } : {}) };
}

/**
 * Whether rideo landmark `l` is water its cast may stand in: its shape 'water', or a box or a
 * cylinder its label (else its element's name) names water (rideo draws it blue: 'the river').
 */
function rideoWater(l: RideoBlockingLandmark, elementName: string | null): boolean {
  if (l.shape === 'water') return true;
  return (l.shape === 'box' || l.shape === 'cylinder') && isWaterLabel(l.label || elementName || '');
}

/**
 * Whether rideo floor point (x, z) lies in landmark `l`'s footprint as rideo measures it (its
 * insideLandmark, whatever the height): an ellipse for a cylinder, else a rectangle, turned by
 * rotationDeg.
 */
function inFootprint(l: RideoBlockingLandmark, x: number, z: number): boolean {
  const a = -rad(l.rotationDeg);
  const dx = x - l.x;
  const dz = z - l.z;
  const lx = dx * Math.cos(a) + dz * Math.sin(a);
  const lz = -dx * Math.sin(a) + dz * Math.cos(a);
  if (l.shape === 'cylinder') return Math.hypot(lx / (l.width / 2), lz / (l.depth / 2)) <= 1;
  return Math.abs(lx) <= l.width / 2 && Math.abs(lz) <= l.depth / 2;
}

/**
 * The frames at which each actor belongs in rideo's water: the shots (from their key frame) where
 * its mark, or the end of its walk, lies inside a water landmark (rideoWater). Every imported actor
 * gets its own (none: the property removed), so a re-import follows rideo.
 */
function markCastInWater(
  doc: SceneDoc,
  landmarks: readonly RideoBlockingLandmark[],
  elementName: (l: RideoBlockingLandmark) => string | null,
  plans: readonly ShotPlan[],
  actors: ReadonlyMap<string, ActorPlan>,
): void {
  const waters = landmarks.filter((l) => rideoWater(l, elementName(l)));
  for (const [characterId, a] of actors) {
    const spans: FrameSpan[] = [];
    for (const p of plans) {
      const m = p.marks.get(characterId);
      if (!m) continue;
      const ends: [number, number][] = [
        [m.x, m.z],
        [m.toX ?? m.x, m.toZ ?? m.z],
      ];
      if (ends.some(([x, z]) => waters.some((l) => inFootprint(l, x, z))))
        spans.push([p.keyFrame, p.frameEnd]);
    }
    setInWaterSpans(doc, a.id, spans);
  }
}

/**
 * Flies a held kite or balloon from its holder's right hand (a quadruped's head) over the shots the
 * holder is in, as one flight from the first such shot's key frame to the last such shot's end, put
 * away after it (after: 'hide'; the caller hides it in the shots between that the holder is not in, so
 * it is still up, flying on, when the holder is seen again): the wind blows away from the first
 * of those shots' camera (turned a little, so the string is seen), a kite is already up unless the
 * shot's text says it is launched.
 */
export function flyProp(
  doc: SceneDoc,
  root: string,
  holder: Pick<ActorPlan, 'id' | 'kind'>,
  kind: 'kite' | 'balloon',
  spans: readonly { from: number; to: number }[],
  plans: readonly SpanShot[],
  p: Pick<RideoBlockingProp, 'id' | 'size'>,
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
