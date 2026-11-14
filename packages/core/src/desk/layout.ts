import type { Mat4, Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { AnimTargetType, CameraData, FCurve, ObjectData } from '../doc/types';
import { compose4, identity4, invert4 } from '../math/mat4';
import { evaluateFCurve } from '../anim/fcurve';
import { writeChannel } from '../anim/properties';
import { FrameState } from '../eval/frame-state';
import { cameraFovY, orthoHalfExtents } from '../eval/camera';
import { RigidBodySimulator } from '../physics/rigid-body';
import { sanitizeRigidBodyWorld } from '../physics/settings';
import { sunDirection } from '../render/sky';
import { HUMANOID_KINDS, actorInfo, isActor, type ActorKind } from './characters';
import { RIDE_PREFIX } from './characters/rig';
import { collapsedBox, hiddenByScale, maybeCollapsed } from './hide';
import { DESK_PROPS } from './props';
import { getDeskSettings } from './shots';

/*
 * Screen-space and scene-reading helpers of the director's desk, shared by the solver, plan
 * fitting, the line, camera moves and the checks.
 *
 * Coordinates: the editor is Z up with the front facing −Y; rideo (whose rules the desk follows) is
 * y up with z towards the audience. rideo (x, y, z) is editor (x, −z, y): a proper rotation, so
 * dot and cross products, distances and sides agree in both. The solver works in rideo coordinates
 * (toRideo / toEditor at its boundary) so that its formulas read like rideo's; everything else works
 * in editor coordinates.
 *
 * A DeskScene reads one state of the document: frame states (with the rigid body simulation where
 * the scene has one) share one reading of the objects, subjects and camera views are cached per
 * frame. An object that is just its own animated channels (no parent, constraints, rigid body or
 * drivers: a camera, an actor walking on its marks) is read from its own F-curves, as a frame state
 * evaluates it, without evaluating the scene. Make a new one after changing the document.
 */

/** A point or direction in rideo's coordinates (metres, y up, z towards the audience). */
export interface RVec {
  x: number;
  y: number;
  z: number;
}

export const toRideo = (v: Readonly<Vec3>): RVec => ({ x: v[0], y: v[2], z: -v[1] });
export const toEditor = (r: RVec): Vec3 => [r.x, -r.z, r.y];

/** Near plane of the desk's projections (m), as rideo's projectPoint. */
export const DESK_NEAR = 0.05;

/** The channels an object's world matrix is made of when nothing else moves it. */
const TRANSFORM_PATHS: ReadonlySet<string> = new Set(['location', 'rotation_euler', 'scale']);

/** rideo's default sun: azimuth 135° (front right), elevation 40°. */
export const DEFAULT_SUN_AZIMUTH_DEG = 135;
export const DEFAULT_SUN_ELEVATION_DEG = 40;

/**
 * Custom property naming a landmark's (or a model part's) shape as rideo's landmarks do; 'water'
 * lets cameras stand in it (rideo's landmark shape 'water': the rideo import sets it).
 */
export const DESK_SHAPE_PROP = 'desk_shape';

/** Custom property built-in store models give their parts (CATALOG: water surfaces are parts named `water`). */
export const STORE_PART_PROP = 'store_part';

/** Nouns that name open water: a landmark whose label ends in one is water when nothing marks its shape. */
const WATER_NOUNS: ReadonlySet<string> = new Set([
  'water',
  'waters',
  'sea',
  'ocean',
  'lake',
  'pond',
  'river',
  'pool',
  'stream',
  'bay',
  'lagoon',
  'creek',
  'brook',
  'canal',
  'puddle',
  'loch',
  'harbour',
  'harbor',
  'reservoir',
  'fjord',
  'estuary',
  'shallows',
  'surf',
  'waves',
]);

/** Words that start what qualifies a label's noun ("the pond by the barn", "a lake of fire"). */
const LABEL_QUALIFIERS: ReadonlySet<string> = new Set([
  'with',
  'by',
  'near',
  'of',
  'in',
  'on',
  'at',
  'behind',
  'beside',
  'next',
  'and',
  'under',
  'over',
  'from',
  'to',
  'for',
  'across',
  'along',
  'past',
  'beyond',
  'between',
]);

/**
 * Whether a landmark label names water: its head noun (the last word before a qualifier such as
 * "by the barn") is one of open water's (the lake, a swimming pool, the bay). Words that only start
 * with one do not count: the lakeside cabin, a pool table, the seats and the research hut are solid.
 */
export function isWaterLabel(label: string): boolean {
  const words = label.toLowerCase().match(/[a-z]+/g) ?? [];
  const cut = words.findIndex((w, i) => i > 0 && LABEL_QUALIFIERS.has(w));
  const head = (cut > 0 ? words.slice(0, cut) : words).at(-1);
  return !!head && WATER_NOUNS.has(head);
}

const EPS = 1e-9;

/** How far below its soles (m) an actor's body must reach to rest on it (a lying animal, hooves up). */
const BODY_REST_M = 0.1;

/**
 * How far above the floor under it (m) the bottom of a prop must be for the prop to fly: a kite in
 * the sky, a ball high in its flight, a balloon (a cup on a table or a lamp on a shelf rests on them).
 */
export const AIRBORNE_M = 1;

/**
 * A following group without actors heads where it travels over this many seconds around a frame
 * (DeskScene.groupHeading), when it travels more than HEADING_MIN_M there.
 */
export const HEADING_WINDOW_S = 0.5;
export const HEADING_MIN_M = 0.05;

/** Whether an actor kind is an animal (any kind but a person's: framed by its body length too). */
export const isAnimalKind = (kind: string): boolean =>
  !!kind && !(HUMANOID_KINDS as readonly string[]).includes(kind as ActorKind);

export const v3add = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3mul = (a: Readonly<Vec3>, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const v3dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const v3len = (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]);
/** Unit vector of `a` (`fallback` when it has no length). */
export function v3norm(a: Readonly<Vec3>, fallback: Readonly<Vec3> = [0, -1, 0]): Vec3 {
  const l = v3len(a);
  return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [fallback[0], fallback[1], fallback[2]];
}
/** `a` on the floor (z = 0). */
export const v3flat = (a: Readonly<Vec3>): Vec3 => [a[0], a[1], 0];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A custom property of an object as a string ('' when absent). */
export function deskProp(o: Pick<ObjectData, 'custom_props'> | null | undefined, key: string): string {
  const v = o && isRecord(o.custom_props) ? o.custom_props[key] : undefined;
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/**
 * Whether a set piece is water that cameras may stand in (rideo's landmark shape 'water'): its
 * desk_shape when it has one, else a built-in model's water part (store_part 'water'), else for a
 * piece that is not a model's part (`part` false) its label (desk_label, else its name) naming
 * water by its head noun ({@link isWaterLabel}).
 */
export function isWater(o: Pick<ObjectData, 'custom_props' | 'name'>, part = false): boolean {
  const shape = deskProp(o, DESK_SHAPE_PROP).trim().toLowerCase();
  if (shape) return shape === 'water';
  if (deskProp(o, STORE_PART_PROP) === 'water') return true;
  return !part && isWaterLabel(deskProp(o, DESK_PROPS.label) || o.name);
}

/** A numeric custom property (null when absent or not a finite number). */
export function deskNumber(
  o: Pick<ObjectData, 'custom_props'> | null | undefined,
  key: string,
): number | null {
  const v = o && isRecord(o.custom_props) ? o.custom_props[key] : undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The aspect ratio (width / height) the desk solves and checks shots for: the desk setting, else the
 * render resolution's.
 */
export function deskAspect(doc: SceneDoc): number {
  const desk = getDeskSettings(doc);
  if (desk.aspect) return desk.aspect;
  const r = doc.getRender();
  const w = Number(r.resolution_x);
  const h = Number(r.resolution_y);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

/** rideo's sun direction (towards the sun) in editor coordinates, from its azimuth and elevation in degrees. */
export function rideoSunVector(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return toEditor({ x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: Math.cos(az) * Math.cos(el) });
}

// ---------------------------------------------------------------- bounds

/** Axis-aligned box (world space). */
export interface Box {
  min: Vec3;
  max: Vec3;
}

const emptyBox = (): Box => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const boxEmpty = (b: Box): boolean => !(b.min[0] <= b.max[0] && b.min[1] <= b.max[1] && b.min[2] <= b.max[2]);

function growBox(b: Box, p: Readonly<Vec3>): void {
  for (let k = 0; k < 3; k++) {
    if (p[k] < b.min[k]) b.min[k] = p[k];
    if (p[k] > b.max[k]) b.max[k] = p[k];
  }
}

function transform(m: Readonly<Mat4>, p: Readonly<Vec3>): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Grows `b` by the eight corners of the local box `local` placed by `m`. */
function growByCorners(b: Box, local: Box, m: Readonly<Mat4>): void {
  for (let c = 0; c < 8; c++)
    growBox(
      b,
      transform(m, [
        c & 1 ? local.max[0] : local.min[0],
        c & 2 ? local.max[1] : local.min[1],
        c & 4 ? local.max[2] : local.min[2],
      ]),
    );
}

// ---------------------------------------------------------------- subjects and cameras

/** A shot subject at one frame (editor coordinates): where it stands, its height and which way it faces. */
export interface DeskSubject {
  id: string;
  name: string;
  /** An actor (desk_role 'actor'): rideo's characters; other subjects are props and set pieces. */
  actor: boolean;
  /**
   * Its mark on the floor (rideo's mark): the actor object's origin, where locomotion puts the
   * actor, at the height its body rests on (its soles, or the body of one lying down); the bottom
   * centre of a prop's bounds.
   */
  feet: Vec3;
  eyes: Vec3;
  chest: Vec3;
  /** Top of the head (actors) or of the bounds. */
  head: Vec3;
  /** head − feet height (the posed height). */
  height: number;
  /**
   * Measured on its posed body (CHARACTERS' actorInfo): its chest, eyes and head are where the pose
   * puts them (a seated actor's face is ahead of its mark, a lying one's far from it). Otherwise
   * they stand straight over its feet, as rideo's figures do.
   */
  posed: boolean;
  /** Unit horizontal direction it faces (front = the object's −Y). */
  facing: Vec3;
  /** World bounds of its geometry. */
  bounds: Box;
  center: Vec3;
  /**
   * An animal (an actor of any kind but a person's, by its desk_kind): long rather than tall, framed
   * by its body length as well as its height.
   */
  animal: boolean;
  /**
   * An animal's body along its facing: its front (nose) and back (tail) ends at the height of the
   * middle of its bounds, and the length between them; null for other subjects.
   */
  extent: { front: Vec3; back: Vec3; length: number } | null;
  /**
   * A prop flying: its bottom more than AIRBORNE_M above the floor under it (a kite, a ball high in
   * its flight). It is measured where it is, as every prop is: its feet are the bottom of its bounds.
   */
  airborne: boolean;
  /**
   * Put away at this frame: its world matrix collapsed by a hide key (hide.ts hiddenByScale; a kite
   * after desk.tether_fly's after: 'hide', an actor the rideo import hides in shots it is not cast
   * in), so nothing of it shows. Its points are where it was put away; the solver and the checks
   * leave it out at such frames.
   */
  hidden: boolean;
}

/** A camera at one frame: its basis (no roll for the desk's cameras) and the tangents of its half field of view. */
export interface CameraView {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  lens: number;
  ortho: boolean;
  /** tan of half the horizontal and vertical field of view (perspective), or the half extents (ortho). */
  tanH: number;
  tanV: number;
}

/** Projection of a point: x right and y up in [−1, 1] inside the frame, depth along the view (NaN x/y behind it). */
export interface Projected {
  x: number;
  y: number;
  depth: number;
}

/** rideo's lens tangents: tan of half the field of view of a lens on its 36 mm wide sensor. */
export function lensTangents(lensMm: number, aspect: number): { tanH: number; tanV: number } {
  const tanH = 36 / 2 / Math.max(1, lensMm);
  return { tanH, tanV: tanH / Math.max(0.1, aspect) };
}

/**
 * The view of a camera at `position` looking at `target` with no roll (rideo's cameraBasis): straight
 * up or down, the top of the frame is the back of the set (+Y).
 */
export function viewFromPose(
  position: Readonly<Vec3>,
  target: Readonly<Vec3>,
  lens: number,
  aspect: number,
): CameraView {
  const forward = v3norm(v3sub(target, position), [0, 1, 0]);
  const right = Math.abs(forward[2]) > 0.999 ? ([1, 0, 0] as Vec3) : v3norm(v3cross(forward, [0, 0, 1]));
  const up = v3cross(right, forward);
  return { position: [...position], forward, right, up, lens, ortho: false, ...lensTangents(lens, aspect) };
}

/** rideo's projectPoint: x right and y up in [−1, 1] in the frame; NaN when not in front of the near plane. */
export function projectPoint(view: CameraView, p: Readonly<Vec3>): Projected {
  const d = v3sub(p, view.position);
  const depth = v3dot(d, view.forward);
  if (view.ortho) return { x: v3dot(d, view.right) / view.tanH, y: v3dot(d, view.up) / view.tanV, depth };
  if (depth <= DESK_NEAR) return { x: Number.NaN, y: Number.NaN, depth };
  return { x: v3dot(d, view.right) / (depth * view.tanH), y: v3dot(d, view.up) / (depth * view.tanV), depth };
}

/** Whether a projected point is in the picture (rideo's inPicture). */
export const inPicture = (p: Pick<Projected, 'x' | 'y'>, margin = 1): boolean =>
  Number.isFinite(p.x) && Math.abs(p.x) <= margin && Math.abs(p.y) <= margin;

/** A solid volume a camera must not stand in: the oriented box of a mesh's stored geometry. */
interface Solid {
  /** The object carrying the desk role (a model's root) and its label. */
  owner: string;
  label: string;
  inverse: Mat4;
  local: Box;
}

/**
 * One reading of the document for the desk at any frame. Frames are evaluated as the viewport shows
 * them, with the rigid body simulation (from the document's shared cache) where the scene has one.
 *
 * A scene can take everything but its cameras from another, earlier reading (`subjects`): what the
 * solver writes while it places shots is camera keys, so a solve measures its subjects once and reads
 * each new camera pose afresh. Only valid while nothing else changed since that reading and nothing
 * but cameras depends on a camera ({@link DeskScene.camerasLeadNothing}).
 */
export class DeskScene {
  readonly aspect: number;
  /** The scene's objects as stored, by id. */
  readonly objects: ReadonlyMap<string, ObjectData>;
  private readonly frames = new Map<number, FrameState>();
  private base: FrameState | null = null;
  private readonly subjects = new Map<string, DeskSubject | null>();
  private readonly views = new Map<string, CameraView | null>();
  private readonly meshBoxes = new Map<string, Box | null>();
  private readonly solidLists = new Map<number, Solid[]>();
  /** Datablocks' own F-curves (`type:id`; null: a driver writes the datablock too). */
  private readonly curveLists = new Map<string, FCurve[] | null>();
  /** The datablocks drivers write (`type:id`). */
  private driven: Set<string> | null = null;
  private childList: Map<string, string[]> | null = null;
  private readonly physics: boolean;
  private readonly sim = new RigidBodySimulator();
  /** The reading subjects, set pieces and other objects than cameras come from (this one, or `subjects`). */
  private readonly reading: DeskScene;

  constructor(
    readonly doc: SceneDoc,
    o: { aspect?: number; physics?: boolean; subjects?: DeskScene } = {},
  ) {
    this.aspect = o.aspect ?? o.subjects?.aspect ?? deskAspect(doc);
    this.reading = o.subjects ? o.subjects.reading : this;
    // sharing a reading, only the cameras are read anew (in the document's order, by name)
    const from = this.reading !== this ? this.reading.objects : null;
    const list = from
      ? doc
          .objectIds()
          .map((id) => {
            const x = from.get(id);
            return x && x.type !== 'CAMERA' ? x : doc.getObject(id);
          })
          .filter((x): x is ObjectData => !!x)
          .sort((a, b) => a.name.localeCompare(b.name))
      : doc.listObjects();
    this.objects = new Map(list.map((x) => [x.id, x]));
    const world = sanitizeRigidBodyWorld(doc.getScene().rigidbody_world);
    this.physics =
      o.physics !== false && world.enabled && [...this.objects.values()].some((x) => !!x.rigid_body?.enabled);
  }

  /** Whether object `id` is read from the shared reading (everything but cameras, when there is one). */
  private shared(id: string): boolean {
    return this.reading !== this && this.objects.get(id)?.type !== 'CAMERA';
  }

  /**
   * Whether nothing but cameras depends on a camera: no other object is parented to one, constrained
   * to one (its own or its bones' constraints) or driven by one. Then a reading of the subjects stays
   * true while cameras are keyed (see the class comment).
   */
  camerasLeadNothing(): boolean {
    const cameras = [...this.objects.values()].filter((o) => o.type === 'CAMERA').map((o) => o.id);
    if (!cameras.length) return true;
    const names = new Set(cameras);
    const mentions = (v: unknown) => {
      const s = JSON.stringify(v ?? null);
      return cameras.some((id) => s.includes(id));
    };
    for (const o of this.objects.values()) {
      if (names.has(o.id)) continue;
      if (o.parent && names.has(o.parent)) return false;
      if (o.constraints?.some((c) => c.target && names.has(c.target))) return false;
      if (o.pose && mentions(o.pose)) return false;
    }
    return !mentions(this.doc.listDrivers().filter((d) => !names.has(d.target_id)));
  }

  /** The frame state of `frame` (cached; at most a few hundred kept). */
  frameState(frame: number): FrameState {
    const key = Number.isFinite(frame) ? frame : 0;
    let fs = this.frames.get(key);
    if (fs) return fs;
    const plain = this.base
      ? new FrameState(this.doc, key, null, { base: this.base })
      : new FrameState(this.doc, key);
    this.base ??= plain;
    fs = plain;
    if (this.physics) {
      const simulated = this.simulatedAt(key, plain);
      if (simulated) fs = new FrameState(this.doc, key, simulated, { base: plain });
    }
    if (this.frames.size >= 256) this.frames.delete(this.frames.keys().next().value as number);
    this.frames.set(key, fs);
    return fs;
  }

  private simulatedAt(frame: number, fs: FrameState): Map<string, Mat4> | null {
    try {
      return this.sim.evaluate(this.doc, frame, {
        transformsAt: (f) => new FrameState(this.doc, f, null, { base: fs }).allWorldMatrices(),
        meshOf: (id) => {
          const o = this.objects.get(id);
          return o?.type === 'MESH' && o.data ? this.doc.getMesh(o.data) : null;
        },
      });
    } catch {
      // a simulation the host refuses (memory) or that fails: the animated transforms
      return null;
    }
  }

  /** The world matrix of object `id` at `frame` (identity when it cannot be evaluated). */
  world(id: string, frame: number): Mat4 {
    if (this.shared(id)) return this.reading.world(id, frame);
    return this.ownWorld(id, frame) ?? this.frameState(frame).world(id) ?? identity4();
  }

  /** A datablock's unmuted, keyed F-curves, or null when a driver writes it too. */
  private curvesOf(type: AnimTargetType, id: string): FCurve[] | null {
    const key = `${type}:${id}`;
    let out = this.curveLists.get(key);
    if (out === undefined) {
      this.driven ??= new Set(
        this.doc
          .listDrivers()
          .filter((d) => !d.mute)
          .map((d) => `${d.target_type}:${d.target_id}`),
      );
      out = this.driven.has(key)
        ? null
        : this.doc
            .listFCurves(id)
            .filter((fc) => fc.target_type === type && !fc.mute && fc.keyframes.length > 0);
      this.curveLists.set(key, out);
    }
    return out;
  }

  /** Datablock `id` with its F-curves applied at `frame` (a frame state's animated value), or null when driven. */
  private ownValues<T>(
    type: AnimTargetType,
    id: string,
    raw: T,
    frame: number,
    paths?: ReadonlySet<string>,
  ): T | null {
    const curves = this.curvesOf(type, id);
    if (!curves) return null;
    const at = Number.isFinite(frame) ? frame : 0;
    const out = { ...raw } as Record<string, unknown>;
    for (const fc of curves) {
      if (paths && !paths.has(fc.path)) continue;
      const v = evaluateFCurve(fc, at);
      if (v !== undefined) writeChannel(out, fc.path, fc.index, v);
    }
    return out as T;
  }

  /**
   * The world matrix of an object that is just its own channels (no parent, constraints, rigid body
   * or drivers) at `frame`: its location, rotation and scale as its F-curves give them, what a frame
   * state evaluates for it. Null for other objects.
   */
  private ownWorld(id: string, frame: number): Mat4 | null {
    const o = this.objects.get(id);
    if (!o || o.parent || o.constraints?.length || o.rigid_body?.enabled) return null;
    const own = this.ownValues('object', id, o, frame, TRANSFORM_PATHS);
    return own && compose4(own.location, own.rotation_euler, own.scale);
  }

  /** The world position of object `id`'s origin at `frame`. */
  origin(id: string, frame: number): Vec3 {
    const m = this.world(id, frame);
    return [m[12], m[13], m[14]];
  }

  /**
   * Whether object `id` is put away at `frame` by a hide key (its own or its parents'): its world
   * matrix may be collapsed (hide.ts maybeCollapsed) and its geometry, as {@link bounds} gathers it,
   * is less than a micrometre across (collapsedBox), which tells a store model in very large units
   * shown a few centimetres across, at a tiny world scale, from one put away. Without geometry, its
   * world matrix alone decides (hiddenByScale).
   */
  hidden(id: string, frame: number): boolean {
    if (this.shared(id)) return this.reading.hidden(id, frame);
    const world = this.world(id, frame);
    if (!maybeCollapsed(world)) return false;
    const box = emptyBox();
    this.eachMesh(id, frame, (local, m) => growByCorners(box, local, m));
    return boxEmpty(box) ? hiddenByScale(world) : collapsedBox(box);
  }

  /**
   * The objects of `ids` that are here (not gone) and, while any of them is, shown at `frame` (not
   * put away by a hide key): a group a camera follows or frames leaves its hidden members out.
   */
  private shownOf(ids: readonly string[], frame: number): string[] {
    const here = ids.filter((id) => this.objects.has(id));
    const shown = here.filter((id) => !this.hidden(id, frame));
    return shown.length ? shown : here;
  }

  /**
   * Where a group of objects is at `frame` (the point following moves follow): across the floor the
   * mean of their origins (a ball rolling ahead of a dog pulls the camera along); in height the mean
   * of its actors' origins when it has actors, else of all of them, so a prop never lifts or drops
   * the camera that follows actors (a bouncing ball, a carried basket, a kite: they move it across
   * the floor only). One object's is its origin. Ids of objects that are gone are left out, and those
   * put away at `frame` (hidden) while others are shown; null for none.
   */
  groupCentre(ids: readonly string[], frame: number): Vec3 | null {
    const here = this.shownOf(ids, frame);
    if (here.length === 1) return this.origin(here[0], frame);
    if (!here.length) return null;
    const actors = here.filter((id) => this.isActor(id));
    const c: Vec3 = [0, 0, 0];
    let z = 0;
    for (const id of here) {
      const p = this.origin(id, frame);
      c[0] += p[0] / here.length;
      c[1] += p[1] / here.length;
      if (!actors.length) z += p[2] / here.length;
      else if (actors.includes(id)) z += p[2] / actors.length;
    }
    c[2] = z;
    return c;
  }

  /**
   * Which way a following group heads at `frame` (unit, on the floor; a steadicam turns with it): the
   * facing of its actors (their mean; the first one's when they face every way at once), so a prop's
   * spin never turns the camera; a group without actors heads where it travels from HEADING_WINDOW_S
   * before `frame` to as long after it (within `span`), else where it travels over the span, else
   * nowhere new (−Y: the camera does not turn). Ids of objects that are gone are left out, and actors
   * put away at `frame` (hidden) while others are shown.
   */
  groupHeading(
    ids: readonly string[],
    frame: number,
    span: { frame_start: number; frame_end: number },
  ): Vec3 {
    const here = ids.filter((id) => this.objects.has(id));
    const actors = this.shownOf(
      here.filter((id) => this.isActor(id)),
      frame,
    );
    if (actors.length) {
      if (actors.length === 1) return this.facing(actors[0], frame);
      const sum = actors.map((id) => this.facing(id, frame)).reduce(v3add, [0, 0, 0] as Vec3);
      return v3len(sum) > 1e-6 ? v3norm(sum) : this.facing(actors[0], frame);
    }
    if (!here.length) return [0, -1, 0];
    const lo = Math.min(span.frame_start, span.frame_end);
    const hi = Math.max(span.frame_start, span.frame_end);
    const travel = (a: number, b: number): Vec3 | null => {
      const p = this.groupCentre(here, a);
      const q = this.groupCentre(here, b);
      if (!p || !q) return null;
      const d: Vec3 = [q[0] - p[0], q[1] - p[1], 0];
      return v3len(d) > HEADING_MIN_M ? v3norm(d) : null;
    };
    const fps = Math.max(1, this.doc.getScene().fps || 24);
    const w = Math.max(1, Math.round(HEADING_WINDOW_S * fps));
    const at = (f: number) => Math.min(hi, Math.max(lo, f));
    return travel(at(frame - w), at(frame + w)) ?? travel(lo, hi) ?? [0, -1, 0];
  }

  /** Children of each object (stored parenting). */
  children(id: string): readonly string[] {
    if (!this.childList) {
      const map = new Map<string, string[]>();
      for (const o of this.objects.values()) {
        if (!o.parent) continue;
        let list = map.get(o.parent);
        if (!list) map.set(o.parent, (list = []));
        list.push(o.id);
      }
      this.childList = map;
    }
    return this.childList.get(id) ?? [];
  }

  /**
   * The actor that actor `id` rides at `frame`: the target of a 'Ride …' CHILD_OF on it (CHARACTERS'
   * desk.actor_mount seats a rider on its mount's saddle) holding it then (unmuted, influence at
   * least ½), or null.
   */
  mountOf(id: string, frame: number): string | null {
    if (this.shared(id)) return this.reading.mountOf(id, frame);
    const rides = (cs: ObjectData['constraints'] | undefined) =>
      (cs ?? []).filter((c) => c.type === 'CHILD_OF' && c.name.startsWith(RIDE_PREFIX) && !!c.target);
    const o = this.objects.get(id);
    if (!rides(o?.constraints).length) return null;
    // the influence of a ride is keyed (it seats and dismounts): read as evaluated at the frame
    const evaluated = this.frameState(frame).get<ObjectData>('object', id) ?? o;
    const ride = rides(evaluated?.constraints).find(
      (c) => !c.mute && (c.influence ?? 1) >= 0.5 && this.objects.has(c.target!),
    );
    return ride ? ride.target! : null;
  }

  /** Whether one of actors `a` and `b` rides the other at `frame` (a rider and her mount move as one). */
  rideTogether(a: string, b: string, frame: number): boolean {
    return this.mountOf(a, frame) === b || this.mountOf(b, frame) === a;
  }

  /** Whether object `id` is an actor (desk_role 'actor'; armatures built by CHARACTERS and stand-ins). */
  isActor(id: string): boolean {
    return deskProp(this.objects.get(id), DESK_PROPS.role) === 'actor';
  }

  /** The scene's actors (desk_role 'actor'), in the document's order. */
  actorIds(): string[] {
    return [...this.objects.values()]
      .filter((o) => deskProp(o, DESK_PROPS.role) === 'actor')
      .map((o) => o.id);
  }

  /** The name of object `id` (its id when it is gone). */
  name(id: string): string {
    return this.objects.get(id)?.name ?? id;
  }

  /** Local bounds of a mesh datablock's stored geometry (cached). */
  private meshBox(meshId: string): Box | null {
    const key = `${meshId}:${this.doc.meshVersion(meshId)}`;
    if (this.meshBoxes.has(key)) return this.meshBoxes.get(key)!;
    const mesh = this.doc.getMesh(meshId);
    let box: Box | null = null;
    if (mesh && mesh.positions.length >= 3) {
      box = emptyBox();
      const p = mesh.positions;
      for (let i = 0; i + 2 < p.length; i += 3) growBox(box, [p[i], p[i + 1], p[i + 2]]);
      if (boxEmpty(box)) box = null;
    }
    this.meshBoxes.set(key, box);
    return box;
  }

  /** The local box of object `id`'s own geometry (meshes only), or null. */
  private localBox(id: string): Box | null {
    const o = this.objects.get(id);
    return o?.type === 'MESH' && o.data ? this.meshBox(o.data) : null;
  }

  /**
   * Calls `fn` with each mesh of object `id` and its descendants (cameras, lights, strings and other
   * actors below it left out): the local box of its stored geometry and its world matrix at `frame`.
   */
  private eachMesh(id: string, frame: number, fn: (local: Box, world: Readonly<Mat4>) => void): void {
    const fs = this.frameState(frame);
    const visit = (oid: string, root: boolean) => {
      const o = this.objects.get(oid);
      if (!o) return;
      if (!root) {
        if (o.type === 'CAMERA' || o.type === 'LIGHT') return;
        const role = deskProp(o, DESK_PROPS.role);
        if (role === 'actor' || role === 'string' || role === 'camera') return;
      }
      const local = this.localBox(oid);
      if (local) fn(local, fs.world(oid) ?? identity4());
      for (const c of this.children(oid)) visit(c, false);
    };
    visit(id, true);
  }

  /**
   * The oriented boxes of object `id`'s meshes and its descendants' at `frame` (as {@link bounds}
   * gathers them: cameras, lights, strings and other actors below it left out), each the local box
   * of its stored geometry and the inverse of its world matrix: an actor's body part by part, what a
   * line of sight is tested against (moves.ts shotOcclusions). Meshes scaled to nothing are left out.
   */
  bodyBoxes(id: string, frame: number): { inverse: Mat4; local: Box }[] {
    if (this.shared(id)) return this.reading.bodyBoxes(id, frame);
    const out: { inverse: Mat4; local: Box }[] = [];
    this.eachMesh(id, frame, (local, m) => {
      const det =
        m[0] * (m[5] * m[10] - m[6] * m[9]) -
        m[4] * (m[1] * m[10] - m[2] * m[9]) +
        m[8] * (m[1] * m[6] - m[2] * m[5]);
      if (Math.abs(det) > 1e-12) out.push({ inverse: invert4(m as Mat4), local });
    });
    return out;
  }

  /**
   * World bounds of object `id` and its descendants at `frame`: the stored geometry of their meshes
   * (cameras, lights, strings and other actors below it left out), else the origin of `id`.
   */
  bounds(id: string, frame: number): Box {
    if (this.shared(id)) return this.reading.bounds(id, frame);
    const box = emptyBox();
    this.eachMesh(id, frame, (local, m) => growByCorners(box, local, m));
    if (boxEmpty(box)) {
      const p = this.origin(id, frame);
      return { min: [...p], max: [...p] };
    }
    return box;
  }

  /**
   * The ends of object `id`'s geometry (as {@link bounds} measures it) along the horizontal unit
   * `axis` at `frame`, at the height of the middle of `box`: an animal's nose and tail when `axis`
   * is its facing. Null without geometry.
   */
  private extentAlong(id: string, frame: number, axis: Readonly<Vec3>, box: Box): DeskSubject['extent'] {
    let lo = Infinity;
    let hi = -Infinity;
    this.eachMesh(id, frame, (local, m) => {
      for (let c = 0; c < 8; c++) {
        const d = v3dot(
          transform(m, [
            c & 1 ? local.max[0] : local.min[0],
            c & 2 ? local.max[1] : local.min[1],
            c & 4 ? local.max[2] : local.min[2],
          ]),
          axis,
        );
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
    });
    if (!(hi >= lo)) return null;
    const mid = boxCenter(box);
    const at = v3dot(mid, axis);
    return {
      front: v3add(mid, v3mul(axis, hi - at)),
      back: v3add(mid, v3mul(axis, lo - at)),
      length: hi - lo,
    };
  }

  /** The horizontal direction object `id` faces at `frame`: its −Y axis on the floor. */
  facing(id: string, frame: number): Vec3 {
    const m = this.world(id, frame);
    return v3norm([-m[4], -m[5], 0], [0, -1, 0]);
  }

  /**
   * The height of the floor under point `p` at `frame`: the top of the highest solid set piece
   * below it (or around it) other than object `id`'s own pieces, else the ground (z = 0).
   */
  floorUnder(id: string, p: Readonly<Vec3>, frame: number): number {
    let floor = 0;
    for (const s of this.solids(frame)) {
      if (s.owner === id) continue;
      // a ray straight down from p in the solid's own space: where it enters the box
      const q = transform(s.inverse, p);
      const d: Vec3 = [-s.inverse[8], -s.inverse[9], -s.inverse[10]];
      let t0 = -Infinity;
      let t1 = Infinity;
      let hit = true;
      for (let k = 0; k < 3 && hit; k++) {
        if (Math.abs(d[k]) < EPS) {
          hit = q[k] >= s.local.min[k] && q[k] <= s.local.max[k];
          continue;
        }
        const a = (s.local.min[k] - q[k]) / d[k];
        const b = (s.local.max[k] - q[k]) / d[k];
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      }
      if (!hit || t1 < Math.max(t0, 0)) continue;
      floor = Math.max(floor, p[2] - Math.max(t0, 0));
    }
    return floor;
  }

  /**
   * Subject `id` at `frame`. Actors are measured by CHARACTERS' actorInfo (head, eyes, chest,
   * facing), standing on their mark: the armature object's origin (not the middle of their soles,
   * which a seated or lying pose puts well away from the body), at the height of their soles, or of
   * their body when it rests lower (a lying animal). When CHARACTERS cannot measure an actor (one
   * that is not an armature), it stands on its origin, as tall as its desk_height_m (else its parts'
   * bounds), facing its −Y. Other subjects stand on the bottom of their bounds and are as tall as
   * them. Null when the object is gone.
   */
  subject(id: string, frame: number): DeskSubject | null {
    if (this.shared(id)) return this.reading.subject(id, frame);
    const key = `${id}@${frame}`;
    if (this.subjects.has(key)) return this.subjects.get(key)!;
    const s = this.measure(id, frame);
    this.subjects.set(key, s);
    return s;
  }

  private measure(id: string, frame: number): DeskSubject | null {
    const o = this.objects.get(id);
    if (!o) return null;
    const actor = deskProp(o, DESK_PROPS.role) === 'actor';
    const hidden = this.hidden(id, frame);
    if (actor && isActor(this.doc, id)) {
      try {
        const info = actorInfo(this.frameState(frame), this.doc, id);
        const mark = this.origin(id, frame);
        // the floor under it: its soles, or its body when that rests lower (a lying animal's hooves
        // are in the air)
        const low = info.bounds.min[2];
        const floor = Number.isFinite(low) && low < info.feet[2] - BODY_REST_M ? low : info.feet[2];
        const height = info.head_top[2] - floor;
        if (Number.isFinite(height) && height > 0) {
          const bounds: Box = { min: [...info.bounds.min], max: [...info.bounds.max] };
          const facing = v3norm(v3flat(info.facing), this.facing(id, frame));
          const animal = isAnimalKind(info.kind);
          return {
            id,
            name: o.name,
            actor,
            feet: [mark[0], mark[1], floor],
            eyes: [...info.eyes],
            chest: [...info.chest],
            head: [...info.head_top],
            height,
            posed: true,
            facing,
            bounds,
            center: boxCenter(bounds),
            animal,
            extent: animal ? this.extentAlong(id, frame, facing, bounds) : null,
            airborne: false,
            hidden,
          };
        }
      } catch {
        // CHARACTERS cannot measure it: the parts' bounds below
      }
    }
    const bounds = this.bounds(id, frame);
    const center = boxCenter(bounds);
    if (actor) {
      const at = this.origin(id, frame);
      const stored = deskNumber(o, DESK_PROPS.heightM);
      const measured = bounds.max[2] - bounds.min[2];
      const height = stored && stored > 0 ? stored : measured > 0.01 ? measured : 1.7;
      const feet: Vec3 = [at[0], at[1], at[2]];
      const facing = this.facing(id, frame);
      const animal = isAnimalKind(deskProp(o, DESK_PROPS.kind));
      return {
        id,
        name: o.name,
        actor,
        feet,
        eyes: [at[0], at[1], at[2] + 0.93 * height],
        chest: [at[0], at[1], at[2] + 0.72 * height],
        head: [at[0], at[1], at[2] + height],
        height,
        posed: false,
        facing,
        bounds,
        center,
        animal,
        extent: animal ? this.extentAlong(id, frame, facing, bounds) : null,
        airborne: false,
        hidden,
      };
    }
    const height = Math.max(0, bounds.max[2] - bounds.min[2]);
    const feet: Vec3 = [center[0], center[1], bounds.min[2]];
    return {
      id,
      name: o.name,
      actor,
      feet,
      eyes: [feet[0], feet[1], feet[2] + 0.93 * height],
      chest: [feet[0], feet[1], feet[2] + 0.72 * height],
      head: [feet[0], feet[1], bounds.max[2]],
      height,
      posed: false,
      facing: this.facing(id, frame),
      bounds,
      center,
      animal: false,
      extent: null,
      airborne: feet[2] - this.floorUnder(id, feet, frame) > AIRBORNE_M,
      hidden,
    };
  }

  /**
   * Camera object `id` at `frame` as it renders (its evaluated matrix and lens; the scene's aspect),
   * or null when it is not a camera.
   */
  camera(id: string, frame: number): CameraView | null {
    const key = `${id}@${frame}`;
    if (this.views.has(key)) return this.views.get(key)!;
    const view = this.measureCamera(id, frame);
    this.views.set(key, view);
    return view;
  }

  private measureCamera(id: string, frame: number): CameraView | null {
    const o = this.objects.get(id);
    if (!o || o.type !== 'CAMERA' || !o.data) return null;
    const stored = this.doc.getCamera(o.data);
    const own = stored && this.ownValues('camera', o.data, stored, frame);
    const cam = own ?? this.frameState(frame).get<CameraData>('camera', o.data) ?? stored;
    if (!cam) return null;
    const m = this.world(id, frame);
    const right = v3norm([m[0], m[1], m[2]], [1, 0, 0]);
    const up = v3norm([m[4], m[5], m[6]], [0, 0, 1]);
    const forward = v3norm([-m[8], -m[9], -m[10]], [0, 1, 0]);
    const position: Vec3 = [m[12], m[13], m[14]];
    if (cam.type === 'ORTHO') {
      const { halfW, halfH } = orthoHalfExtents(cam, this.aspect);
      return { position, forward, right, up, lens: cam.lens, ortho: true, tanH: halfW, tanV: halfH };
    }
    const tanV = Math.tan(cameraFovY(cam, this.aspect) / 2);
    return { position, forward, right, up, lens: cam.lens, ortho: false, tanH: tanV * this.aspect, tanV };
  }

  /**
   * Unit direction towards the key light, editor coordinates: the SKY world's sun, else the first
   * sun lamp (the set's own first), else rideo's default sun.
   */
  sun(frame: number): Vec3 {
    const world = this.doc.getWorld();
    if (world.environment === 'SKY') return sunDirection(world);
    const suns = [...this.objects.values()].filter((o) => {
      if (o.type !== 'LIGHT' || !o.data || o.hide_render) return false;
      return this.doc.getLight(o.data)?.type === 'SUN';
    });
    suns.sort(
      (a, b) =>
        Number(deskProp(b, DESK_PROPS.role) === 'set') - Number(deskProp(a, DESK_PROPS.role) === 'set'),
    );
    if (suns.length) {
      const m = this.world(suns[0].id, frame);
      return v3norm([m[8], m[9], m[10]], [0, 0, 1]);
    }
    return rideoSunVector(DEFAULT_SUN_AZIMUTH_DEG, DEFAULT_SUN_ELEVATION_DEG);
  }

  /** Whether the set is an interior (desk setting). */
  get interior(): boolean {
    return getDeskSettings(this.doc).interior;
  }

  /** Landmarks (desk_role 'landmark', visible in renders) with their labels and bounds at `frame`. */
  landmarks(frame: number): { id: string; label: string; bounds: Box }[] {
    if (this.reading !== this) return this.reading.landmarks(frame);
    const out: { id: string; label: string; bounds: Box }[] = [];
    for (const o of this.objects.values()) {
      if (deskProp(o, DESK_PROPS.role) !== 'landmark' || o.hide_render) continue;
      out.push({
        id: o.id,
        label: deskProp(o, DESK_PROPS.label) || o.name,
        bounds: this.bounds(o.id, frame),
      });
    }
    return out;
  }

  /**
   * The solid set pieces at `frame` (desk_role landmark, prop or set; actors left out, and water
   * ({@link isWater}): a water landmark, or the water parts of a model such as a fountain's), each
   * part of a model as its own oriented box.
   */
  solids(frame: number): Solid[] {
    if (this.reading !== this) return this.reading.solids(frame);
    const cached = this.solidLists.get(frame);
    if (cached) return cached;
    const fs = this.frameState(frame);
    const out: Solid[] = [];
    this.solidLists.set(frame, out);
    for (const o of this.objects.values()) {
      const role = deskProp(o, DESK_PROPS.role);
      if (role !== 'landmark' && role !== 'prop' && role !== 'set') continue;
      const label = deskProp(o, DESK_PROPS.label) || o.name;
      if (o.hide_render || isWater(o)) continue;
      const visit = (id: string, root: boolean) => {
        const x = this.objects.get(id);
        if (!x) return;
        if (!root && (x.type === 'CAMERA' || x.type === 'LIGHT' || deskProp(x, DESK_PROPS.role))) return;
        if (!root && isWater(x, true)) return;
        const local = this.localBox(id);
        if (local) {
          const extent = v3sub(local.max, local.min);
          // planes (the ground, the walls of a room) have nothing to stand in
          if (Math.min(extent[0], extent[1], extent[2]) > 1e-4)
            out.push({ owner: o.id, label, inverse: invert4(fs.world(id) ?? identity4()), local });
        }
        for (const c of this.children(id)) visit(c, false);
      };
      visit(o.id, true);
    }
    return out;
  }

  /** The solid a point stands in at `frame` (see {@link solids}), or null. */
  insideSolid(
    p: Readonly<Vec3>,
    frame: number,
    solids = this.solids(frame),
  ): { owner: string; label: string } | null {
    for (const s of solids) {
      const q = transform(s.inverse, p);
      if (
        q[0] >= s.local.min[0] &&
        q[0] <= s.local.max[0] &&
        q[1] >= s.local.min[1] &&
        q[1] <= s.local.max[1] &&
        q[2] >= s.local.min[2] &&
        q[2] <= s.local.max[2]
      )
        return { owner: s.owner, label: s.label };
    }
    return null;
  }
}

export function boxCenter(b: Box): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}
