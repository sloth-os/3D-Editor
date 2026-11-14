import type { Mat4, Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import { fcurveKey } from '../doc/scene-doc';
import type {
  CameraData,
  DeskFraming,
  DeskMove,
  FCurve,
  FModifierData,
  Interpolation,
  ObjectData,
  ShotData,
} from '../doc/types';
import { DESK_MOVES } from '../doc/types';
import { compose4, invert4, multiply4 } from '../math/mat4';
import { createFCurve, evaluateFCurve, insertKeyframe } from '../anim/fcurve';
import { createFModifier } from '../anim/fmodifiers';
import { matrixToCompatibleEuler } from '../constraints/math';
import { decomposeCompatible, trackRotation } from '../generate/layout';
import { OperatorError } from '../operators/context';
import { DESK_PROPS } from './props';
import {
  DeskScene,
  deskProp,
  projectPoint,
  v3add,
  v3cross,
  v3dot,
  v3flat,
  v3len,
  v3mul,
  v3norm,
  v3sub,
  viewFromPose,
  type CameraView,
} from './layout';
import {
  CRANE_M,
  DESK_SENSOR_WIDTH_MM,
  FRAMING_TABLE,
  MAX_WIDEN,
  ORBIT_DEG,
  animalFramePoints,
  effectiveFraming,
  finishCamera,
  followMap,
  inFrameSamples,
  lineSide,
  moveEnd,
  placeCamera,
  solveCamera,
  subjectPoint,
  unframedSubjects,
  type FollowMap,
  type LinePoints,
  type SolveSpec,
  type SolvedCamera,
} from './solver';

/*
 * Camera moves keyed over a shot's range (spec §6) and the writing of shot cameras.
 *
 * A move starts from the camera's pose at frame_start (the solved one, or where the camera is) and
 * is keyed over [frame_start, frame_end]: push/pull/dolly/crane as two BEZIER keys (an ease in and
 * out), the crane turning to keep its target in view; orbits at least 8 keys along the arc;
 * pans and tilts rotation only; whip_pan a 90° turn over 6 frames mid-shot; handheld NOISE F-modifiers
 * on the six transform channels restricted to the range and seeded by the shot id (no random
 * numbers: the same shot shakes the same way); dolly_zoom the lens against the distance (the subject
 * keeps its size); drone_flyover a rising arc towards the subject; rack_focus the focus distance from
 * the nearest subject to the farthest; tracking_follow and steadicam_walk follow the centre of the
 * subjects' group (a steadicam turning with their heading) with a key on every frame; locked_off none.
 *
 * Writing a pose replaces the camera's keys inside the range first (location, rotation, lens and
 * focus distance, and the handheld noise of the range), so solving a shot again replaces its move;
 * keys outside the range (other shots on the same camera) stay, and a channel that is animated
 * elsewhere gets keys at the range's ends so it holds the shot's pose. A camera keyed nowhere else
 * gets a locked-off pose as plain values. The first and last frames of the other shots on the
 * camera (`holds`) keep their view: a channel that the keys would change there (one that held its
 * value as a plain value, or followed keys the range cleared) gets a key holding its old value.
 * A camera's roll (a dutch angle set by hand) is kept by moves keyed from where it stands.
 */

/** Angles (degrees) and distances of the moves the desk adds to rideo's library (amount 1). */
export const PAN_DEG = 30;
export const TILT_DEG = 15;
export const WHIP_DEG = 90;
/** Frames a whip pan turns in (centred on the middle of the shot). */
export const WHIP_FRAMES = 6;
/** Handheld noise: location (m) and rotation (rad) strengths of the NOISE modifiers, and their time scales in seconds. */
export const HANDHELD_LOCATION_M = 0.03;
export const HANDHELD_ROTATION_RAD = 0.012;
export const HANDHELD_LOCATION_S = 0.8;
export const HANDHELD_ROTATION_S = 0.45;
/** Keys of the moves keyed along a path (orbit, drone) and of the crane's rotation. */
export const ORBIT_MIN_KEYS = 8;
export const DRONE_KEYS = 9;
export const CRANE_ROTATION_KEYS = 5;
/** How far a drone flyover rises (at least, m) and how much of the way to its subject it travels. */
export const DRONE_RISE_M = 4;
export const DRONE_TRAVEL = 0.6;
/** Steadicam bob (m) and its cadence (Hz). */
export const STEADICAM_BOB_M = 0.012;
export const STEADICAM_BOB_HZ = 1.8;
/** How much a dolly zoom narrows its lens (share at amount 1, at most DOLLY_ZOOM_MAX). */
export const DOLLY_ZOOM_SHARE = 0.35;
export const DOLLY_ZOOM_MAX = 0.9;

/** A camera pose: where it stands and the point it looks at (editor coordinates), and its lens. */
export interface CameraPose {
  position: Vec3;
  target: Vec3;
  lens: number;
}

const FRAME_EPS = 1e-3;
const TRANSFORM_PATHS = ['location', 'rotation_euler'] as const;

/**
 * Custom property of a camera whose depth of field rack_focus turned on (value 'rack_focus'): the
 * desk turns it off again once no focus keys are left on the camera.
 */
export const DESK_DOF_PROP = 'desk_dof';

const smooth = (t: number): number => t * t * (3 - 2 * t);
const rad = (deg: number): number => (deg * Math.PI) / 180;
const lerp3 = (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** FNV-1a hash of a string (the handheld noise's phase). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Keyframes and F-curves a move writes over `frames` frames (the estimates of memory-desk.ts). */
export function cameraMoveKeys(
  move: DeskMove | null | undefined,
  frames: number,
  amount = 1,
): { keys: number; fcurves: number } {
  const n = Math.max(1, Math.ceil(frames));
  // the start pose (and the hold at the end) on every channel
  const base = 2 * 8;
  switch (move ?? 'locked_off') {
    case 'locked_off':
      return { keys: base, fcurves: 8 };
    case 'push_in':
    case 'pull_out':
    case 'dolly_left':
    case 'dolly_right':
      return { keys: base + 2 * 3, fcurves: 8 };
    case 'crane_up':
    case 'crane_down':
      return { keys: base + 2 * 3 + CRANE_ROTATION_KEYS * 3, fcurves: 8 };
    case 'orbit_left':
    case 'orbit_right':
      return { keys: base + orbitKeyCount(amount) * 6, fcurves: 8 };
    case 'pan_left':
    case 'pan_right':
    case 'tilt_up':
    case 'tilt_down':
      return { keys: base + 2, fcurves: 8 };
    case 'whip_pan':
      return { keys: base + 4, fcurves: 8 };
    case 'handheld':
      return { keys: base + 12, fcurves: 8 };
    case 'dolly_zoom':
      return { keys: base + 2 * 4, fcurves: 8 };
    case 'drone_flyover':
      return { keys: base + DRONE_KEYS * 6, fcurves: 8 };
    case 'rack_focus':
      return { keys: base + 4, fcurves: 8 };
    case 'tracking_follow':
      return { keys: base + (n + 1) * 3, fcurves: 8 };
    case 'steadicam_walk':
      return { keys: base + (n + 1) * 6, fcurves: 8 };
  }
}

/** Keys an orbit puts on its arc: at least 8, one per 4° of turn. */
export function orbitKeyCount(amount: number): number {
  return Math.max(ORBIT_MIN_KEYS, Math.ceil((ORBIT_DEG * Math.abs(amount)) / 4) + 1);
}

/** Whether `move` is one of the desk's (rideo's) move ids. */
export const isDeskMove = (move: unknown): move is DeskMove =>
  typeof move === 'string' && (DESK_MOVES as readonly string[]).includes(move);

// ---------------------------------------------------------------- camera objects

/** Sets a camera up as the desk's cameras are: a 36 mm sensor fitted horizontally, desk_role 'camera' (and its shot). */
export function prepareDeskCamera(doc: SceneDoc, cameraId: string, shotId?: string): void {
  const o = doc.getObject(cameraId);
  if (!o || o.type !== 'CAMERA' || !o.data) return;
  const cam = doc.getCamera(o.data);
  if (cam && (cam.sensor_fit !== 'HORIZONTAL' || cam.sensor_width !== DESK_SENSOR_WIDTH_MM))
    doc.updateCamera(o.data, { sensor_fit: 'HORIZONTAL', sensor_width: DESK_SENSOR_WIDTH_MM });
  const props = { ...o.custom_props };
  let changed = false;
  if (props[DESK_PROPS.role] !== 'camera') {
    props[DESK_PROPS.role] = 'camera';
    changed = true;
  }
  if (shotId && typeof props[DESK_PROPS.shot] !== 'string') {
    props[DESK_PROPS.shot] = shotId;
    changed = true;
  }
  if (changed) doc.updateObject(cameraId, { custom_props: props });
}

/** Adds a desk camera (looking along +Y from 8 m in front of `at`, 1.6 m high) and returns its id. */
export function addDeskCamera(
  doc: SceneDoc,
  o: { name: string; shotId: string; lens: number; at?: Vec3 },
): string {
  const at = o.at ?? [0, 0, 0];
  const data = doc.addCamera({
    name: o.name,
    lens: o.lens,
    sensor_fit: 'HORIZONTAL',
    sensor_width: DESK_SENSOR_WIDTH_MM,
  });
  const position: Vec3 = [at[0], at[1] - 8, at[2] + 1.6];
  const rotation = lookEuler(v3sub([at[0], at[1], at[2] + 1], position), [Math.PI / 2, 0, 0]);
  return doc.addObject({
    type: 'CAMERA',
    name: o.name,
    data,
    location: position,
    rotation_euler: rotation,
    custom_props: { [DESK_PROPS.role]: 'camera', [DESK_PROPS.shot]: o.shotId },
  });
}

/**
 * The Euler XYZ rotation of a camera looking along `dir` (−Z view, +Y up; straight down the top of
 * the frame is +Y), turned by `roll` radians about its view axis (0: no roll), the angles closest to
 * `prev`.
 */
export function lookEuler(dir: Readonly<Vec3>, prev: Readonly<Vec3>, roll = 0): Vec3 {
  let m = trackRotation(dir, '-Z', 'Y', [0, 0, 1], [0, 1, 0]);
  if (!m) return [prev[0], prev[1], prev[2]];
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const x: Vec3 = [m[0], m[1], m[2]];
    const y: Vec3 = [m[4], m[5], m[6]];
    m = [
      ...v3add(v3mul(x, c), v3mul(y, s)),
      0,
      ...v3add(v3mul(x, -s), v3mul(y, c)),
      0,
      ...m.slice(8),
    ] as Mat4;
  }
  return matrixToCompatibleEuler(m, prev);
}

/** The roll of a camera view about its view axis (radians; 0 for the desk's level cameras). */
export function viewRoll(view: Pick<CameraView, 'forward' | 'up'>): number {
  const f = view.forward;
  if (Math.abs(f[2]) > 0.999) return 0;
  const right0 = v3norm(v3cross(f, [0, 0, 1]));
  const up0 = v3cross(right0, f);
  return Math.atan2(-v3dot(view.up, right0), v3dot(view.up, up0));
}

/**
 * The frames keying camera `cameraId` over [start, end] must not change the view of: the first and
 * last frames of the other shots that use the camera and lie outside the range (a shot overlapping
 * it is the one being keyed, or coverage the range replaces).
 */
export function cameraHolds(
  shots: readonly Pick<ShotData, 'id' | 'camera' | 'frame_start' | 'frame_end'>[],
  cameraId: string,
  start: number,
  end: number,
  except?: string,
): number[] {
  const out = new Set<number>();
  for (const s of shots)
    if (s.camera === cameraId && s.id !== except && (s.frame_end < start || s.frame_start > end)) {
      out.add(s.frame_start);
      out.add(s.frame_end);
    }
  return [...out].sort((a, b) => a - b);
}

/** The pose of camera `cameraId` at `frame` as it renders; it looks at `target` when given, else 5 m ahead. */
export function cameraPoseAt(
  scene: DeskScene,
  cameraId: string,
  frame: number,
  target?: Vec3,
): CameraPose | null {
  const view = scene.camera(cameraId, frame);
  if (!view) return null;
  return {
    position: view.position,
    target: target ?? v3add(view.position, v3mul(view.forward, 5)),
    lens: view.lens,
  };
}

/**
 * The point a camera looks at in a shot: where its view axis passes the subjects (their centre's
 * depth along the view), else 5 m ahead.
 */
export function viewTarget(
  scene: DeskScene,
  view: CameraView,
  subjects: readonly string[],
  frame: number,
): Vec3 {
  const centres = subjects
    .map((id) => scene.subject(id, frame))
    .filter((s): s is NonNullable<typeof s> => !!s && !s.hidden)
    .map((s) => s.chest);
  let depth = 5;
  if (centres.length) {
    const c = v3mul(centres.reduce(v3add, [0, 0, 0] as Vec3), 1 / centres.length);
    const d = v3dot(v3sub(c, view.position), view.forward);
    if (d > 0.3) depth = d;
  }
  return v3add(view.position, v3mul(view.forward, depth));
}

// ---------------------------------------------------------------- channels

type ChannelType = 'object' | 'camera';
interface Channel {
  type: ChannelType;
  id: string;
  path: string;
  index: number;
}

/** The channels of a camera the desk keys: its object's location and rotation, its data's lens and focus distance. */
function cameraChannels(cam: ObjectData): Channel[] {
  const out: Channel[] = [];
  for (const path of TRANSFORM_PATHS)
    for (let index = 0; index < 3; index++) out.push({ type: 'object', id: cam.id, path, index });
  if (cam.data) {
    out.push({ type: 'camera', id: cam.data, path: 'lens', index: 0 });
    out.push({ type: 'camera', id: cam.data, path: 'dof_focus_distance', index: 0 });
  }
  return out;
}

const keyOf = (c: Channel): string =>
  fcurveKey({ target_type: c.type, target_id: c.id, path: c.path, index: c.index });

/** NOISE modifiers of the desk's handheld move inside [start, end] (identified by their restricted range). */
function isRangeNoise(m: FModifierData, start: number, end: number): boolean {
  if (m.type !== 'NOISE' || m.params.use_restricted_range !== true) return false;
  const a = Number(m.params.frame_start);
  const b = Number(m.params.frame_end);
  return a >= start - FRAME_EPS && b <= end + FRAME_EPS;
}

/**
 * Removes the keys camera `cameraId` has inside [start, end] (location, rotation, lens, focus
 * distance) and the handheld noise of that range; F-curves left with nothing are removed. Returns
 * the keys removed.
 */
export function clearCameraRange(doc: SceneDoc, cameraId: string, start: number, end: number): number {
  const cam = doc.getObject(cameraId);
  if (!cam) return 0;
  let removed = 0;
  for (const c of cameraChannels(cam)) {
    const key = keyOf(c);
    const fc = doc.getFCurve(key);
    if (!fc) continue;
    const keys = fc.keyframes.filter((k) => k.frame < start - FRAME_EPS || k.frame > end + FRAME_EPS);
    const modifiers = (fc.modifiers ?? []).filter((m) => !isRangeNoise(m, start, end));
    removed += fc.keyframes.length - keys.length;
    if (keys.length === fc.keyframes.length && modifiers.length === (fc.modifiers ?? []).length) continue;
    if (!keys.length) doc.removeFCurve(key);
    else doc.setFCurve({ ...fc, keyframes: keys, modifiers: modifiers.length ? modifiers : undefined });
  }
  return removed;
}

/** The value a camera channel holds without keys: the object's location or rotation, the lens or focus distance. */
function staticValue(doc: SceneDoc, c: Channel): number {
  if (c.type === 'object') {
    const o = doc.getObject(c.id);
    const v = c.path === 'location' ? o?.location : o?.rotation_euler;
    return v?.[c.index] ?? 0;
  }
  const cam = doc.getCamera(c.id);
  return (c.path === 'lens' ? cam?.lens : cam?.dof_focus_distance) ?? 0;
}

interface HeldValue {
  channel: Channel;
  frame: number;
  value: number;
}

/**
 * The values camera `cam`'s channels have at `frames` (the views to keep: {@link restoreHolds}). The
 * focus distance counts only while a depth of field the user turned on uses it.
 */
function sampleHolds(doc: SceneDoc, cam: ObjectData, frames: readonly number[]): HeldValue[] {
  if (!frames.length) return [];
  const data = cam.data ? doc.getCamera(cam.data) : null;
  const focused = !!data?.dof_use && deskProp(cam, DESK_DOF_PROP) !== 'rack_focus';
  const out: HeldValue[] = [];
  for (const c of cameraChannels(cam)) {
    if (c.path === 'dof_focus_distance' && !focused) continue;
    for (const frame of frames)
      out.push({
        channel: c,
        frame,
        value: channelValue(doc, c.type, c.id, c.path, c.index, frame, staticValue(doc, c)),
      });
  }
  return out;
}

/**
 * Keys each held value back where the channel now evaluates otherwise (its plain value overridden by
 * new keys, or keys it followed cleared); returns the keys inserted.
 */
function restoreHolds(doc: SceneDoc, held: readonly HeldValue[]): number {
  let keys = 0;
  // a key put back can move a neighbouring frame of the same channel: settle in a few passes
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const h of held) {
      const c = h.channel;
      const now = channelValue(doc, c.type, c.id, c.path, c.index, h.frame, staticValue(doc, c));
      if (Math.abs(now - h.value) <= 1e-9) continue;
      const key = keyOf(c);
      const fc =
        doc.getFCurve(key) ??
        createFCurve({ target_type: c.type, target_id: c.id, path: c.path, index: c.index });
      doc.setFCurve(insertKeyframe(fc, h.frame, h.value, 'BEZIER'));
      keys++;
      changed = true;
    }
    if (!changed) break;
  }
  return keys;
}

/** Turns off the depth of field rack_focus turned on, once camera `cameraId` has no focus keys left. */
function settleDeskDof(doc: SceneDoc, cameraId: string): void {
  const cam = doc.getObject(cameraId);
  if (!cam?.data || deskProp(cam, DESK_DOF_PROP) !== 'rack_focus') return;
  const fc = doc.getFCurve(
    fcurveKey({ target_type: 'camera', target_id: cam.data, path: 'dof_focus_distance', index: 0 }),
  );
  if (fc?.keyframes.length) return;
  doc.updateCamera(cam.data, { dof_use: false });
  const props = { ...cam.custom_props };
  delete props[DESK_DOF_PROP];
  doc.updateObject(cameraId, { custom_props: props });
}

interface DesiredKey {
  frame: number;
  value: number;
  interpolation: Interpolation;
}

/**
 * The keys a camera gets over a range: world poses turned into its channels (through its parent),
 * lens and focus keys, then written as keys or, for channels animated nowhere else that hold one
 * value, as plain values.
 */
class CameraKeys {
  private readonly desired = new Map<string, { channel: Channel; keys: DesiredKey[] }>();
  private readonly forced = new Set<string>();
  private readonly cam: ObjectData;
  private readonly channels: Channel[];
  private prevRotation: Vec3;
  /** Roll about the view axis every look-at rotation keeps (radians). */
  roll = 0;

  constructor(
    private readonly doc: SceneDoc,
    private readonly scene: DeskScene,
    cameraId: string,
    private readonly start: number,
    private readonly end: number,
  ) {
    const cam = doc.getObject(cameraId);
    if (!cam || cam.type !== 'CAMERA')
      throw new OperatorError(`'${cameraId}' is not a camera`, 'INVALID_PARAMS');
    this.cam = cam;
    this.channels = cameraChannels(cam);
    this.prevRotation = [...cam.rotation_euler];
  }

  private put(c: Channel, frame: number, value: number, interpolation: Interpolation = 'BEZIER'): void {
    const key = keyOf(c);
    let entry = this.desired.get(key);
    if (!entry) this.desired.set(key, (entry = { channel: c, keys: [] }));
    entry.keys = entry.keys.filter((k) => Math.abs(k.frame - frame) > FRAME_EPS);
    entry.keys.push({ frame, value, interpolation });
  }

  /** Parent world matrix of the camera at `frame` (identity when it has none). */
  private parentWorld(frame: number): Mat4 | null {
    if (!this.cam.parent) return null;
    return this.scene.frameState(frame).parent(this.cam.id);
  }

  /** Keys the camera standing at `position` with world rotation `euler` at `frame`. Returns the stored euler. */
  pose(
    frame: number,
    position: Readonly<Vec3>,
    euler: Readonly<Vec3>,
    which: { location?: boolean; rotation?: boolean } = {},
  ): Vec3 {
    let location: Vec3 = [...position];
    let rotation: Vec3 = [...euler];
    const parent = this.parentWorld(frame);
    if (parent) {
      const local = multiply4(invert4(parent), compose4(position, euler, [1, 1, 1]));
      const d = decomposeCompatible(local, this.prevRotation, [1, 1, 1]);
      if (d) {
        location = d.location;
        rotation = d.rotation;
      }
    }
    this.prevRotation = rotation;
    for (let i = 0; i < 3; i++) {
      if (which.location !== false)
        this.put({ type: 'object', id: this.cam.id, path: 'location', index: i }, frame, location[i]);
      if (which.rotation !== false)
        this.put({ type: 'object', id: this.cam.id, path: 'rotation_euler', index: i }, frame, rotation[i]);
    }
    return rotation;
  }

  /** The world rotation looking from `position` at `target` (with the camera's roll), closest to the previous one. */
  look(position: Readonly<Vec3>, target: Readonly<Vec3>, prev: Readonly<Vec3>): Vec3 {
    return lookEuler(v3sub(target, position), prev, this.roll);
  }

  lens(frame: number, value: number): void {
    if (this.cam.data) this.put({ type: 'camera', id: this.cam.data, path: 'lens', index: 0 }, frame, value);
  }

  focus(frame: number, value: number): void {
    if (this.cam.data)
      this.put({ type: 'camera', id: this.cam.data, path: 'dof_focus_distance', index: 0 }, frame, value);
  }

  /** Channels that must be keyed even when they hold one value (they carry the handheld noise). */
  force(paths: readonly string[]): void {
    for (const c of this.channels) if (paths.includes(c.path)) this.forced.add(keyOf(c));
  }

  /** Writes everything; returns the keyframes inserted. */
  commit(noise?: { seed: string; fps: number; amount: number }): number {
    const doc = this.doc;
    let keys = 0;
    const statics: Record<string, Vec3> = {};
    let lens: number | null = null;
    let focus: number | null = null;
    for (const c of this.channels) {
      const key = keyOf(c);
      const entry = this.desired.get(key);
      if (!entry || !entry.keys.length) continue;
      const list = [...entry.keys].sort((a, b) => a.frame - b.frame);
      const fc = doc.getFCurve(key);
      const animated = !!fc && fc.keyframes.length > 0;
      const constant = list.every((k) => Math.abs(k.value - list[0].value) < 1e-9);
      if (!animated && constant && !this.forced.has(key)) {
        if (fc) doc.removeFCurve(key);
        if (c.type === 'object') {
          const vec = (statics[c.path] ??= [
            ...(c.path === 'location' ? this.cam.location : this.cam.rotation_euler),
          ]);
          vec[c.index] = list[0].value;
        } else if (c.path === 'lens') lens = list[0].value;
        else focus = list[0].value;
        continue;
      }
      // a keyed channel holds the shot's pose from its start to its end
      const last = list[list.length - 1];
      if (last.frame < this.end - FRAME_EPS)
        list.push({ frame: this.end, value: last.value, interpolation: 'BEZIER' });
      if (list[0].frame > this.start + FRAME_EPS)
        list.unshift({ frame: this.start, value: list[0].value, interpolation: 'BEZIER' });
      let curve: FCurve =
        fc ?? createFCurve({ target_type: c.type, target_id: c.id, path: c.path, index: c.index });
      for (const k of list) curve = insertKeyframe(curve, k.frame, k.value, k.interpolation);
      // insertKeyframe keeps the interpolation of a key it replaces: set the requested ones
      curve = {
        ...curve,
        keyframes: curve.keyframes.map((k) => {
          const want = list.find((d) => Math.abs(d.frame - k.frame) <= FRAME_EPS);
          return want ? { ...k, interpolation: want.interpolation } : k;
        }),
      };
      if (noise && c.type === 'object') curve = withNoise(curve, c, this.start, this.end, noise);
      doc.setFCurve(curve);
      keys += list.length;
    }
    const patch: Partial<ObjectData> = {};
    if (statics.location) patch.location = statics.location;
    if (statics.rotation_euler) patch.rotation_euler = statics.rotation_euler;
    if (Object.keys(patch).length) doc.updateObject(this.cam.id, patch);
    if (this.cam.data && (lens !== null || focus !== null)) {
      const cp: Partial<CameraData> = {};
      if (lens !== null) cp.lens = lens;
      if (focus !== null) cp.dof_focus_distance = focus;
      doc.updateCamera(this.cam.data, cp);
    }
    return keys;
  }
}

/** A curve with the handheld NOISE modifier of a shot's range (seeded by the shot and the channel). */
function withNoise(
  curve: FCurve,
  c: Channel,
  start: number,
  end: number,
  o: { seed: string; fps: number; amount: number },
): FCurve {
  const location = c.path === 'location';
  const scale = Math.max(2, (location ? HANDHELD_LOCATION_S : HANDHELD_ROTATION_S) * o.fps);
  const strength = (location ? HANDHELD_LOCATION_M : HANDHELD_ROTATION_RAD) * o.amount;
  const modifier = createFModifier('NOISE', {
    blend_type: 'REPLACE',
    scale,
    strength,
    phase: (hash32(`${o.seed}:${c.path}:${c.index}`) % 100_000) / 10,
    depth: 1,
    use_restricted_range: true,
    frame_start: start,
    frame_end: end,
  });
  return { ...curve, modifiers: [...(curve.modifiers ?? []), modifier] };
}

// ---------------------------------------------------------------- where moves go

/** Where a dolly zoom from `start` ends: closer along its view, its lens wider by the same ratio. */
function dollyZoomEnd(start: CameraPose, amount: number): CameraPose {
  const d0 = v3len(v3sub(start.target, start.position));
  let lens1 = start.lens * (1 - Math.min(DOLLY_ZOOM_MAX, DOLLY_ZOOM_SHARE * amount));
  lens1 = Math.min(800, Math.max(8, lens1));
  const d1 = (d0 * lens1) / start.lens;
  const dir = v3norm(v3sub(start.target, start.position));
  return { position: v3sub(start.target, v3mul(dir, d1)), target: start.target, lens: lens1 };
}

/** Where an orbit from `start` has turned the camera by `angle` (radians) about its target, at its height. */
function orbitAt(start: CameraPose, move: 'orbit_left' | 'orbit_right', angle: number): Vec3 {
  const t0 = start.target;
  const p0 = start.position;
  const v: Vec3 = [p0[0] - t0[0], p0[1] - t0[1], 0];
  const r = Math.hypot(v[0], v[1]);
  const right = v3norm(v3cross(v3norm(v3sub(t0, p0), [0, 1, 0]), [0, 0, 1]), [1, 0, 0]);
  const k = move === 'orbit_left' ? -1 : 1;
  const turned: Vec3 = [
    v[0] * Math.cos(angle) + right[0] * k * r * Math.sin(angle),
    v[1] * Math.cos(angle) + right[1] * k * r * Math.sin(angle),
    0,
  ];
  return [t0[0] + turned[0], t0[1] + turned[1], p0[2]];
}

/** Where a crane move from `start` ends: straight up or down, at least 5 cm above the floor. */
function craneEnd(start: CameraPose, move: 'crane_up' | 'crane_down', amount: number): Vec3 {
  const p = start.position;
  return [p[0], p[1], Math.max(0.05, p[2] + (move === 'crane_up' ? 1 : -1) * CRANE_M * amount)];
}

/** Where a drone flyover from `start` is at eased share `s` of its way: rising towards the target. */
function dronePoseAt(start: CameraPose, s: number, amount: number): { position: Vec3; target: Vec3 } {
  const t0 = start.target;
  const p0 = start.position;
  const h: Vec3 = [p0[0] - t0[0], p0[1] - t0[1], 0];
  const rise = Math.max(DRONE_RISE_M, 1.2 * Math.hypot(h[0], h[1])) * amount;
  const k = 1 - DRONE_TRAVEL * s;
  return {
    position: [t0[0] + h[0] * k, t0[1] + h[1] * k, p0[2] + rise * Math.sin((Math.PI / 2) * s)],
    target: t0,
  };
}

/**
 * Where move `move` (strength `amount`) has taken a camera that started at `start` once share `t` of
 * the shot has passed (0 its first frame, 1 its last), as its keys have it (eased; a look-at camera
 * on an arc): push, pull, dolly, crane, orbit, dolly zoom and drone flyover; the start for the others
 * (locked off, handheld without its noise, rack focus, the turning moves before they turn, and the
 * moves that follow the subjects, which travel with them: solver.ts followMap).
 */
export function movePoseAt(
  start: CameraPose,
  move: DeskMove | null,
  t: number,
  aspect: number,
  amount = 1,
): CameraPose {
  const s = smooth(Math.min(1, Math.max(0, t)));
  switch (move) {
    case 'push_in':
    case 'pull_out':
    case 'dolly_left':
    case 'dolly_right': {
      // keyed at its ends, the view direction kept
      const e = moveEnd(start, start.lens, aspect, move, amount);
      if (!e) return start;
      return {
        position: lerp3(start.position, e.position, s),
        target: lerp3(start.target, e.target, s),
        lens: start.lens,
      };
    }
    case 'orbit_left':
    case 'orbit_right':
      return {
        position: orbitAt(start, move, rad(ORBIT_DEG * amount) * s),
        target: start.target,
        lens: start.lens,
      };
    case 'crane_up':
    case 'crane_down':
      return {
        position: lerp3(start.position, craneEnd(start, move, amount), s),
        target: start.target,
        lens: start.lens,
      };
    case 'dolly_zoom': {
      const e = dollyZoomEnd(start, amount);
      return {
        position: lerp3(start.position, e.position, s),
        target: start.target,
        lens: start.lens + (e.lens - start.lens) * s,
      };
    }
    case 'drone_flyover':
      return { ...dronePoseAt(start, s, amount), lens: start.lens };
    default:
      return start;
  }
}

// ---------------------------------------------------------------- moves

export interface CameraMoveOptions {
  frame_start: number;
  frame_end: number;
  /** Strength of the move: 1 = the library's distance or angle. */
  amount?: number;
  /** Seed of the handheld noise (the shot id). */
  seed?: string;
  /**
   * The one subject a following move follows when no `subjects` are given. With `subjects`, a
   * following move follows their group whether or not this is given too (an imported rideo shot
   * keys the same follow as desk.shot_solve, desk.camera_move and the line key for it).
   */
  subject?: string;
  /**
   * The shot's subjects: following moves follow the centre of their group (and its heading), rack
   * focus racks from the nearest to the farthest.
   */
  subjects?: string[];
  /** Where the move starts (default: the camera's pose at frame_start, looking at its subjects). */
  start?: CameraPose;
  /** A scene reading to evaluate the camera and subjects with (default: a new one). */
  scene?: DeskScene;
  /**
   * Key every channel even when it holds one value (a camera other shots use too: its pose must
   * not leak out of the range).
   */
  keyed?: boolean;
  /**
   * Frames outside the range whose view must not change: the first and last frames of the other
   * shots on the camera ({@link cameraHolds}). A channel keyed or cleared by the move gets a key
   * there holding the value it had.
   */
  holds?: readonly number[];
}

export interface CameraMoveResult {
  keyframes: number;
  /** The pose at frame_end (null when the camera does not move). */
  end: CameraPose | null;
}

/**
 * Keys `move` on camera `cameraId` over [frame_start, frame_end], replacing the camera's keys in the
 * range, from the start pose (given: a solved pose, level; else where the camera stands, its roll
 * kept). A move of a single frame (or amount 0) keys the start pose only. The views at `holds`
 * (other shots' frames) stay as they were.
 */
export function applyCameraMove(
  doc: SceneDoc,
  cameraId: string,
  move: DeskMove | null,
  o: CameraMoveOptions,
): CameraMoveResult {
  const fs = Math.round(o.frame_start);
  const fe = Math.max(fs, Math.round(o.frame_end));
  const amount = o.amount ?? 1;
  const scene = o.scene ?? new DeskScene(doc);
  const cam = doc.getObject(cameraId);
  if (!cam || cam.type !== 'CAMERA')
    throw new OperatorError(`'${cameraId}' is not a camera`, 'INVALID_PARAMS');
  let start = o.start ?? null;
  if (!start) {
    const view = scene.camera(cameraId, fs);
    if (!view) throw new OperatorError(`Camera '${cam.name}' cannot be evaluated`, 'FAILED');
    start = {
      position: view.position,
      target: viewTarget(scene, view, o.subjects ?? [], fs),
      lens: view.lens,
    };
  }
  const startView = scene.camera(cameraId, fs);
  // the views of the other shots on the camera, before anything changes
  const held = sampleHolds(
    doc,
    cam,
    (o.holds ?? []).filter((f) => f < fs - FRAME_EPS || f > fe + FRAME_EPS),
  );
  clearCameraRange(doc, cameraId, fs, fe);
  const writer = new CameraKeys(doc, scene, cameraId, fs, fe);
  if (o.keyed || held.length) writer.force(['location', 'rotation_euler', 'lens']);
  // the start pose: rotation from the view when it was measured (its roll kept by every look-at
  // key of the move), else looking at the target
  const measured = !o.start && !!startView;
  if (measured) writer.roll = viewRoll(startView);
  const startEuler = measured
    ? worldEuler(scene, cameraId, fs, cam.rotation_euler)
    : writer.look(start.position, start.target, cam.rotation_euler);
  writer.pose(fs, start.position, startEuler);
  writer.lens(fs, start.lens);
  const span = fe - fs;
  const frameAt = (t: number) => fs + t * span;
  const fps = Math.max(1, doc.getScene().fps || 24);
  let end: CameraPose | null = null;
  let noise: { seed: string; fps: number; amount: number } | undefined;
  const m = span > 0 && amount !== 0 ? (move ?? 'locked_off') : 'locked_off';
  const aspect = scene.aspect;
  const lookPath = (n: number, at: (t: number) => { position: Vec3; target: Vec3 }) => {
    let prev = startEuler;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 1 : i / (n - 1);
      const p = at(t);
      prev = writer.look(p.position, p.target, prev);
      writer.pose(frameAt(t), p.position, prev);
    }
    const last = at(1);
    return { ...last, lens: start!.lens };
  };
  switch (m) {
    case 'locked_off':
      break;
    case 'push_in':
    case 'pull_out':
    case 'dolly_left':
    case 'dolly_right': {
      const e = moveEnd(start, start.lens, aspect, m, amount)!;
      writer.pose(fe, e.position, startEuler, { rotation: false });
      end = { ...e, lens: start.lens };
      break;
    }
    case 'crane_up':
    case 'crane_down': {
      const target = start.target;
      const p0 = start.position;
      const p1 = craneEnd(start, m, amount);
      writer.pose(fe, p1, startEuler, { rotation: false });
      // the rotation follows the (eased) rise so the target stays in view
      let prev = startEuler;
      for (let i = 0; i < CRANE_ROTATION_KEYS; i++) {
        const t = i / (CRANE_ROTATION_KEYS - 1);
        const p = lerp3(p0, p1, smooth(t));
        prev = writer.look(p, target, prev);
        writer.pose(frameAt(t), p, prev, { location: false });
      }
      end = { position: p1, target, lens: start.lens };
      break;
    }
    case 'orbit_left':
    case 'orbit_right': {
      const from = start;
      const total = rad(ORBIT_DEG * amount);
      end = lookPath(orbitKeyCount(amount), (t) => ({
        position: orbitAt(from, m, total * smooth(t)),
        target: from.target,
      }));
      break;
    }
    case 'pan_left':
    case 'pan_right': {
      const d = (m === 'pan_left' ? 1 : -1) * rad(PAN_DEG * amount);
      const e: Vec3 = [startEuler[0], startEuler[1], startEuler[2] + d];
      writer.pose(fe, start.position, e, { location: false });
      end = { position: start.position, target: turnTarget(start, 0, d), lens: start.lens };
      break;
    }
    case 'tilt_up':
    case 'tilt_down': {
      const d = (m === 'tilt_up' ? 1 : -1) * rad(TILT_DEG * amount);
      const e: Vec3 = [startEuler[0] + d, startEuler[1], startEuler[2]];
      writer.pose(fe, start.position, e, { location: false });
      end = { position: start.position, target: turnTarget(start, d, 0), lens: start.lens };
      break;
    }
    case 'whip_pan': {
      // to the right: a negative turn about +Z
      const d = -rad(WHIP_DEG * amount);
      const mid = (fs + fe) / 2;
      const half = Math.min(WHIP_FRAMES / 2, span / 2);
      const e: Vec3 = [startEuler[0], startEuler[1], startEuler[2] + d];
      writer.pose(mid - half, start.position, startEuler, { location: false });
      writer.pose(mid + half, start.position, e, { location: false });
      writer.pose(fe, start.position, e, { location: false });
      end = { position: start.position, target: turnTarget(start, 0, d), lens: start.lens };
      break;
    }
    case 'handheld':
      writer.pose(fe, start.position, startEuler);
      writer.force(['location', 'rotation_euler']);
      noise = { seed: o.seed ?? cameraId, fps, amount };
      break;
    case 'dolly_zoom': {
      // dolly in while the lens widens: the subject keeps its size, the background stretches
      const e = dollyZoomEnd(start, amount);
      writer.pose(fe, e.position, startEuler, { rotation: false });
      writer.lens(fe, e.lens);
      end = e;
      break;
    }
    case 'drone_flyover': {
      const from = start;
      end = lookPath(DRONE_KEYS, (t) => dronePoseAt(from, smooth(t), amount));
      break;
    }
    case 'rack_focus': {
      const from = start.position;
      const forward = v3norm(v3sub(start.target, from));
      const depths = (o.subjects ?? [])
        .map((id) => scene.subject(id, fs))
        .filter((s): s is NonNullable<typeof s> => !!s && !s.hidden)
        .map((s) => v3dot(v3sub(s.chest, from), forward))
        .filter((d) => d > 0.05);
      const toTarget = v3len(v3sub(start.target, start.position));
      let near = depths.length ? Math.min(...depths) : toTarget * 0.5;
      let far = depths.length ? Math.max(...depths) : toTarget * 3;
      if (far - near < 0.25) far = near * 3;
      near = Math.max(0.05, near);
      if (cam.data) {
        // the desk turns the depth of field on (and off again when no focus keys are left); one
        // the user turned on stays theirs
        if (!doc.getCamera(cam.data)?.dof_use) {
          doc.updateObject(cameraId, {
            custom_props: { ...doc.getObject(cameraId)?.custom_props, [DESK_DOF_PROP]: 'rack_focus' },
          });
        }
        doc.updateCamera(cam.data, { dof_use: true, dof_focus_object: null });
      }
      writer.focus(fs, near);
      writer.focus(frameAt(1 / 3), near);
      writer.focus(frameAt(2 / 3), far);
      writer.focus(fe, far);
      break;
    }
    case 'tracking_follow':
    case 'steadicam_walk': {
      // the subjects' group: the centre of all of them each frame (one subject: its origin; props
      // move the camera across the floor only) and, for a steadicam, their heading (its actors'; a
      // group without actors heads where it travels): solver.ts followMap maps them the same way.
      // The group of `subjects` whenever they are given (one `subject` only without them)
      const group = (o.subjects?.length ? o.subjects : o.subject ? [o.subject] : []).filter((id) =>
        scene.objects.has(id),
      );
      const span = { frame_start: fs, frame_end: fe };
      const at0 = scene.groupCentre(group, fs);
      if (!at0) break;
      const face0 = scene.groupHeading(group, fs, span);
      const off = v3sub(start.position, at0);
      const toff = v3sub(start.target, at0);
      let prev = startEuler;
      let last: { position: Vec3; target: Vec3 } = { position: start.position, target: start.target };
      for (let f = fs; f <= fe; f++) {
        const at = scene.groupCentre(group, f) ?? at0;
        if (m === 'tracking_follow') {
          // the camera travels with the group; its view direction stays
          const position = v3add(at, off);
          writer.pose(f, position, startEuler, { rotation: false });
          last = { position, target: v3add(at, toff) };
          continue;
        }
        // steadicam: the offset turns with the group's heading, with a gentle bob
        const face = scene.groupHeading(group, f, span);
        const turn = Math.atan2(
          face0[0] * face[1] - face0[1] * face[0],
          face0[0] * face[0] + face0[1] * face[1],
        );
        const rot = (v: Vec3): Vec3 => [
          v[0] * Math.cos(turn) - v[1] * Math.sin(turn),
          v[0] * Math.sin(turn) + v[1] * Math.cos(turn),
          v[2],
        ];
        const bob = STEADICAM_BOB_M * amount * Math.sin((2 * Math.PI * STEADICAM_BOB_HZ * (f - fs)) / fps);
        const position = v3add(v3add(at, rot(off)), [0, 0, bob]);
        const target = v3add(at, rot(toff));
        prev = writer.look(position, target, prev);
        writer.pose(f, position, prev);
        last = { position, target };
      }
      end = { ...last, lens: start.lens };
      break;
    }
  }
  const keyframes = writer.commit(noise) + restoreHolds(doc, held);
  settleDeskDof(doc, cameraId);
  return { keyframes, end };
}

/** The world rotation (Euler XYZ, closest to `prev`) camera `id` has at `frame`. */
function worldEuler(scene: DeskScene, id: string, frame: number, prev: Readonly<Vec3>): Vec3 {
  return matrixToCompatibleEuler(scene.world(id, frame), prev);
}

/** The target of a pose turned by a tilt (about the camera's right) and a pan (about +Z). */
function turnTarget(start: CameraPose, tilt: number, pan: number): Vec3 {
  const d = v3sub(start.target, start.position);
  const dist = v3len(d);
  const yaw = Math.atan2(d[1], d[0]) + pan;
  const pitch = Math.asin(Math.max(-1, Math.min(1, d[2] / Math.max(1e-9, dist)))) + tilt;
  return v3add(start.position, [
    dist * Math.cos(pitch) * Math.cos(yaw),
    dist * Math.cos(pitch) * Math.sin(yaw),
    dist * Math.sin(pitch),
  ]);
}

/**
 * Moves the keys camera `cameraId` has in [from[0], from[1]] (and the handheld noise of that range)
 * to [to[0], to[1]], stretching them linearly: the shot's move follows its new range. The views at
 * `holds` (the other shots' frames, outside both ranges) stay as they were. Returns the keys moved.
 */
export function retimeCameraRange(
  doc: SceneDoc,
  cameraId: string,
  from: readonly [number, number],
  to: readonly [number, number],
  holds: readonly number[] = [],
): number {
  const cam = doc.getObject(cameraId);
  if (!cam) return 0;
  const [a, b] = from;
  const [c, d] = to;
  if (a === c && b === d) return 0;
  const held = sampleHolds(
    doc,
    cam,
    holds.filter((f) => (f < a - FRAME_EPS || f > b + FRAME_EPS) && (f < c - FRAME_EPS || f > d + FRAME_EPS)),
  );
  const map = (f: number) => (b > a ? c + ((f - a) * (d - c)) / (b - a) : c + (f - a));
  const inside = (f: number) => f >= a - FRAME_EPS && f <= b + FRAME_EPS;
  let moved = 0;
  for (const ch of cameraChannels(cam)) {
    const key = keyOf(ch);
    const fc = doc.getFCurve(key);
    if (!fc) continue;
    const kept = fc.keyframes.filter((k) => !inside(k.frame));
    const shifted = fc.keyframes.filter((k) => inside(k.frame)).map((k) => ({ ...k, frame: map(k.frame) }));
    if (!shifted.length && !(fc.modifiers ?? []).some((m) => isRangeNoise(m, a, b))) continue;
    moved += shifted.length;
    // keys of the new range replace the ones that were there
    const keys = [...kept.filter((k) => k.frame < c - FRAME_EPS || k.frame > d + FRAME_EPS), ...shifted].sort(
      (x, y) => x.frame - y.frame,
    );
    const modifiers = (fc.modifiers ?? []).map((m) =>
      isRangeNoise(m, a, b) ? { ...m, params: { ...m.params, frame_start: c, frame_end: d } } : m,
    );
    doc.setFCurve({ ...fc, keyframes: keys, modifiers: modifiers.length ? modifiers : undefined });
  }
  restoreHolds(doc, held);
  return moved;
}

/** The value of a camera channel at `frame` (its F-curve's, else `fallback`). */
export function channelValue(
  doc: SceneDoc,
  type: ChannelType,
  id: string,
  path: string,
  index: number,
  frame: number,
  fallback: number,
): number {
  const fc = doc.getFCurve(fcurveKey({ target_type: type, target_id: id, path, index }));
  return (fc && evaluateFCurve(fc, frame)) ?? fallback;
}

// ---------------------------------------------------------------- keeping a shot's subjects in frame

/** A box in the frame: |x| ≤ x and lo ≤ y ≤ hi (the frame is ±1 both ways, x right, y up). */
interface FrameBox {
  x: number;
  lo: number;
  hi: number;
}

/** desk.check's frame for subject_out_of_frame (|x| ≤ 1, −1 ≤ y ≤ 1.15). */
const CHECKED_FRAME: FrameBox = { x: 1, lo: -1, hi: 1.15 };
/**
 * Where desk.check's points (an actor's eyes, a prop's middle) must stay for a camera to be kept as
 * it is: a little inside what subject_out_of_frame allows.
 */
const CHECK_BOX: FrameBox = { x: 0.97, lo: -0.97, hi: 1.12 };
/** Where what a framing shows of an animal must stay for a camera to be kept as it is. */
const SHOWN_BOX: FrameBox = { x: 0.97, lo: -0.97, hi: 0.97 };
/**
 * Where a camera widened as far as its limit allows keeps desk.check's points when it cannot give
 * them room (backOff, not strict): inside the frame (desk.check lets eyes sit a little above it).
 */
const LOOSE_BOX: FrameBox = { x: 0.95, lo: -0.95, hi: 0.95 };
/**
 * Where a widened camera keeps the checked points (room around them), what it shows whole (an
 * animal, a prop's top and bottom, a person's feet), a person's head and where the framing cuts them.
 */
const KEEP_CHECKED: FrameBox = { x: 0.8, lo: -0.8, hi: 0.8 };
const KEEP_SHOWN: FrameBox = { x: 0.9, lo: -0.9, hi: 0.9 };
const KEEP_HEAD: FrameBox = { x: 0.95, lo: -1, hi: 0.95 };
const KEEP_FEET: FrameBox = { x: 0.95, lo: -0.9, hi: 1 };
const KEEP_CUT: FrameBox = { x: 0.95, lo: -1, hi: 1 };
/** Props up to this tall (m) are kept whole in a widened frame; taller ones by their middle. */
const WHOLE_PROP_M = 3;
/**
 * How far back (times rideo's distance, and at least in metres) the solve looks to say what keeping
 * every subject in frame would take, when its limit (solver.ts MAX_WIDEN) leaves one out.
 */
const NEEDED_BACK_OFF = 60;
const NEEDED_BACK_OFF_M = 600;
/** Shares of the way from a first frame's own aim to the middle of a shot's subjects a plan-keeping fit tries. */
const KEEPING_SHIFTS = [1, 0.75, 0.5, 0.25, 0] as const;

/** A point a camera keeps in frame at one of a shot's samples. */
interface KeepPoint {
  /** The subject it belongs to. */
  subject: string;
  /** Where it is; for a following move, where the camera at the shot's start sees it (followMap). */
  p: Vec3;
  /** Its sample (index into the shot's samples). */
  sample: number;
  /** desk.check's point of the subject (an actor's eyes, a prop's middle: subject_out_of_frame). */
  checked: boolean;
  /** Where it must stay for the camera to be kept as it is (null: it only shapes a widened camera). */
  check: FrameBox | null;
  /** Where a widened camera keeps it. */
  keep: FrameBox;
}

/**
 * What a shot's camera keeps in frame at each of its samples: of every subject it does not leave out
 * by design, desk.check's point (an actor's eyes, a prop's middle); for a widened camera also the
 * top of a person's head and where the framing cuts them below (rideo's frame for a person standing
 * there), a small prop whole; and what the framing shows of an animal (all of it from a medium out,
 * its head and chest closer).
 */
function keepPoints(
  scene: DeskScene,
  spec: SolveSpec,
  frames: readonly number[],
  follow: FollowMap | null,
): KeepPoint[] {
  const framing = spec.framing;
  const table = FRAMING_TABLE[framing];
  // the share of a person's height the bottom of rideo's frame cuts at (0: below the feet)
  const below = Math.max(0, table.look - table.coverage_m / (2 * 1.7));
  const left = unframedSubjects(scene, spec.subjects, spec);
  const out: KeepPoint[] = [];
  frames.forEach((frame, sample) => {
    const map = (p: Readonly<Vec3>): Vec3 => (sample > 0 && follow ? follow(p, frame) : [p[0], p[1], p[2]]);
    for (const id of spec.subjects) {
      if (left.has(id)) continue;
      // one put away at the sample (a hide key) shows nothing to keep in frame (desk.check's subject_hidden)
      const s = scene.subject(id, frame);
      if (!s || s.hidden) continue;
      const put = (p: Readonly<Vec3>, check: FrameBox | null, keep: FrameBox, checked = false) =>
        out.push({ subject: id, p: map(p), sample, checked, check, keep });
      if (!s.actor) {
        put(s.center, CHECK_BOX, KEEP_CHECKED, true);
        if (s.bounds.max[2] - s.bounds.min[2] <= WHOLE_PROP_M) {
          put([s.center[0], s.center[1], s.bounds.max[2]], null, KEEP_SHOWN);
          put([s.center[0], s.center[1], s.bounds.min[2]], null, KEEP_SHOWN);
        }
        continue;
      }
      put(s.eyes, CHECK_BOX, KEEP_CHECKED, true);
      if (s.animal) {
        for (const p of animalFramePoints(s, framing)) put(p, SHOWN_BOX, KEEP_SHOWN);
        continue;
      }
      if (framing !== 'extreme_close_up' && framing !== 'insert') put(s.head, null, KEEP_HEAD);
      if (below < 0.85) put(subjectPoint(s, below), null, below > 0 ? KEEP_CUT : KEEP_FEET);
    }
  });
  return out;
}

/** How far a projected point is outside a box: at most 1 inside it, beyond 1 outside (Infinity behind). */
function excess(view: CameraView, p: Readonly<Vec3>, box: FrameBox): number {
  const q = projectPoint(view, p);
  if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return Infinity;
  return Math.max(Math.abs(q.x) / box.x, q.y >= 0 ? q.y / box.hi : q.y / box.lo);
}

/** The view of a camera starting at `start` at each sample of a shot, through its move (a following camera: its start). */
function sampleViews(
  start: CameraPose,
  move: DeskMove | null,
  span: ShotSpan,
  frames: readonly number[],
  aspect: number,
  follow: FollowMap | null,
): CameraView[] {
  const length = span.frame_end - span.frame_start;
  return frames.map((f) => {
    const pose = follow
      ? start
      : movePoseAt(start, move, length > 0 ? (f - span.frame_start) / length : 0, aspect);
    return viewFromPose(pose.position, pose.target, pose.lens, aspect);
  });
}

/** A shot's range (its move is the spec's). */
export interface ShotSpan {
  frame_start: number;
  frame_end: number;
}

/** The views of a camera standing at `position` looking at `target` through a shot's move, at its samples. */
type Views = (position: Vec3, target: Vec3) => CameraView[];

/** A camera kept around a shot's subjects, and whether it keeps them where they must be. */
interface Kept {
  position: Vec3;
  target: Vec3;
  holds: boolean;
}

/** Whether every point with a check box is inside it through `views` (the camera kept as it is). */
const checksHold = (views: readonly CameraView[], points: readonly KeepPoint[]): boolean =>
  points.every((k) => !k.check || excess(views[k.sample], k.p, k.check) <= 1);

/**
 * Backs a camera off from `pose`, at its height and on its side of the subjects, until `points` are
 * where they must be at their samples through the move: with `strict` each in its keep box (room
 * around it), else only those with a check box, desk.check's points inside the frame (LOOSE_BOX) and
 * what it shows of an animal inside its box. It aims across the frame at the middle of the points (their extents as the move's own
 * travel leaves them; `recentre` of the way there from the pose's own aim, 0 keeping the composition
 * of the pose's first frame) and up the frame at the middle of their heights, backs off until they
 * hold, then tilts for as much room above them as below and closes in as far as that allows. It never
 * stands farther than `cap` from what it aims at: when nothing within that holds the points it takes
 * the distance that holds them best (`holds` false).
 */
function backOff(
  views: Views,
  points: readonly KeepPoint[],
  pose: { position: Vec3; target: Vec3 },
  o: { cap: number; strict: boolean; recentre: number },
): Kept {
  const used = o.strict ? points : points.filter((k) => k.check);
  if (!used.length) return { position: pose.position, target: pose.target, holds: true };
  const box = (k: KeepPoint): FrameBox => (o.strict ? k.keep : k.checked ? LOOSE_BOX : (k.check ?? k.keep));
  const back = v3norm(v3flat(v3sub(pose.position, pose.target)), [0, -1, 0]);
  const right = v3norm(v3cross([-back[0], -back[1], 0], [0, 0, 1]), [1, 0, 0]);
  const height = pose.position[2];
  // the middle of the points across and up the frame, each seen from where the move has the camera
  // at its sample (a dolly's frame slides along with it)
  const travel = views(pose.position, pose.target).map((v) => v3sub(v.position, pose.position));
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const k of used) {
    const q = v3sub(k.p, travel[k.sample]);
    const x = v3dot(v3sub(q, pose.target), right);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, q[2]);
    z1 = Math.max(z1, q[2]);
  }
  let target = v3add(v3add(pose.target, v3mul(right, (o.recentre * (x0 + x1)) / 2)), [
    0,
    0,
    (z0 + z1) / 2 - pose.target[2],
  ]);
  const at = (a: number): Vec3 => [target[0] + back[0] * a, target[1] + back[1] * a, height];
  const worst = (a: number) => {
    const vs = views(at(a), target);
    let w = 0;
    for (const k of used) w = Math.max(w, excess(vs[k.sample], k.p, box(k)));
    return w;
  };
  const own = Math.max(0.3, Math.hypot(pose.position[0] - pose.target[0], pose.position[1] - pose.target[1]));
  // back off (at the camera's height) until everything holds, then close in again as far as that
  // allows; within the cap on the distance to the aim, else the distance that holds it best
  const fit = (): { a: number; w: number } => {
    const reach = Math.max(0.3, Math.sqrt(Math.max(0, o.cap * o.cap - (height - target[2]) ** 2)));
    const first = Math.min(own, reach);
    let best = { a: first, w: worst(first) };
    let near = first;
    let far = first;
    while (best.w > 1 && far < reach) {
      near = far;
      far = Math.min(reach, far * 1.25);
      const w = worst(far);
      if (w < best.w) best = { a: far, w };
    }
    if (best.w <= 1 && best.a > first)
      for (let i = 0; i < BISECT_STEPS; i++) {
        const mid = (near + best.a) / 2;
        if (worst(mid) <= 1) best = { a: mid, w: 1 };
        else near = mid;
      }
    return best;
  };
  let best = fit();
  for (let i = 0; i < TILT_PASSES; i++) {
    const z = balancedTilt(views, used, box, at(best.a), target, z0, z1);
    if (z === null || Math.abs(z - target[2]) < 1e-6) break;
    target = [target[0], target[1], z];
    best = fit();
  }
  return { position: at(best.a), target, holds: best.w <= 1 };
}

/** Steps of the bisections that close a widened camera in and balance its tilt. */
const BISECT_STEPS = 12;
const TILT_STEPS = 24;
/** Times a widened camera is tilted to balance its frame and closed in again. */
const TILT_PASSES = 2;

/**
 * The height to aim a camera at `position` at (looking towards `target` across) that leaves the
 * points as much room above as below them, each in its box: where the highest point is as far up its
 * box as the lowest is down its own. Null when no height between `z0` and `z1` (with room around
 * them) balances them.
 */
function balancedTilt(
  views: Views,
  points: readonly KeepPoint[],
  box: (k: KeepPoint) => FrameBox,
  position: Vec3,
  target: Vec3,
  z0: number,
  z1: number,
): number | null {
  // above minus below: falls as the aim rises (everything moves down the frame)
  const lean = (z: number): number => {
    const vs = views(position, [target[0], target[1], z]);
    let up = -Infinity;
    let down = -Infinity;
    for (const k of points) {
      const q = projectPoint(vs[k.sample], k.p);
      if (!Number.isFinite(q.y)) continue;
      const b = box(k);
      up = Math.max(up, q.y / b.hi);
      down = Math.max(down, -q.y / -b.lo);
    }
    return up - down;
  };
  const room = Math.max(1, z1 - z0);
  let lo = z0 - room;
  let hi = z1 + room;
  if (!(lean(lo) > 0 && lean(hi) < 0)) return null;
  for (let i = 0; i < TILT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (lean(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The frames of a shot's camera keeps its subjects in: the shot's samples desk.check judges
 * (inFrameSamples), how a following move maps them, its keep points, and the views from a pose.
 */
function shotFrame(scene: DeskScene, spec: SolveSpec, span: ShotSpan) {
  const frames = inFrameSamples({ ...span, move: spec.move });
  const follow = followMap(scene, spec.subjects, spec.move, span);
  const points = keepPoints(scene, spec, frames, follow);
  const lens = Math.min(800, Math.max(8, Math.round(spec.lens_mm)));
  const views: Views = (position, target) =>
    sampleViews({ position, target, lens }, spec.move, span, frames, scene.aspect, follow);
  return { frames, follow, points, views };
}

/** Whether a camera stands on the side of the scene's line it keeps to (or on the line); any without one. */
const onLineSide =
  (line: LinePoints | null | undefined) =>
  (p: { position: Vec3 }): boolean =>
    !line || lineSide(line.a, line.b, p.position) !== -line.side;

/**
 * Keeps a shot's subjects in frame from the poses `base` gives for its first `n` samples (for every
 * n, from all of them down to the first alone): a pose as it is when desk.check's points stay where
 * they must (rideo's camera exactly for subjects that stay put), else backed off from it within
 * `cap` until everything holds (strict), else until desk.check's points do (loose). A shot that
 * cannot hold its subjects at every sample within the limit holds the first ones (the first frame
 * first: rideo draws its board from it) and lets the later ones leave the frame; one that cannot hold
 * them all even so holds its actors (rideo frames its characters, and its props as they fall). Null
 * when not even the actors at the first frame can be held within the limit (`accept` taking the pose).
 */
function keepWithin(
  scene: DeskScene,
  f: ReturnType<typeof shotFrame>,
  base: (n: number) => { position: Vec3; target: Vec3 },
  cap: number,
  recentre: number,
  accept: (p: { position: Vec3; target: Vec3 }) => boolean = () => true,
): { position: Vec3; target: Vec3; held: number } | null {
  const actors = f.points.filter((k) => scene.isActor(k.subject));
  const sets = actors.length && actors.length < f.points.length ? [f.points, actors] : [f.points];
  for (const points of sets)
    for (let n = f.frames.length; n >= 1; n--) {
      const pts = points.filter((k) => k.sample < n);
      const pose = base(n);
      if (
        v3len(v3sub(pose.position, pose.target)) <= cap + 1e-9 &&
        checksHold(f.views(pose.position, pose.target), pts) &&
        accept(pose)
      )
        return { position: pose.position, target: pose.target, held: n };
      for (const strict of [true, false]) {
        const kept = backOff(f.views, pts, pose, { cap, strict, recentre });
        if (kept.holds && accept(kept)) return { position: kept.position, target: kept.target, held: n };
      }
    }
  return null;
}

/** How a shot's camera frames its subjects: the solve's account of it (desk.shot_solve's result). */
export interface FitReport {
  /** It stands farther back than rideo's camera for the shot (distance_ratio over 1). */
  widened: boolean;
  /**
   * Its distance from the point it looks at, over that of rideo's camera for the shot's framing,
   * angle and height at its first frame (1: rideo's framing).
   */
  distance_ratio: number;
  /** The framing that distance amounts to (solver.ts effectiveFraming): the shot's own, or wider. */
  effective_framing: DeskFraming;
  /**
   * Subjects whose desk.check point (an actor's eyes, a prop's middle) leaves its frame at the frames
   * desk.check samples, through its move: subject_out_of_frame.
   */
  out_of_frame: { subject: string; name: string; frames: number[] }[];
  /**
   * About how far back (over rideo's distance) a camera would stand to keep every subject in frame,
   * when the limit (solver.ts MAX_WIDEN) left one out; null when none is out, or none could.
   */
  needed_ratio: number | null;
}

/**
 * The account of a shot's camera at `pose` (its start; the move is the spec's): its distance against
 * rideo's camera for the shot at its first frame (solveCamera, with `o`), the framing that amounts
 * to, and the subjects it loses at the frames desk.check samples.
 */
export function shotFitReport(
  scene: DeskScene,
  spec: SolveSpec,
  span: ShotSpan,
  pose: CameraPose,
  o: { line?: LinePoints | null; fallbackTarget?: Vec3 } = {},
): FitReport {
  const s = { ...spec, lens_mm: pose.lens };
  const ref = solveCamera(scene, s, span.frame_start, o);
  const refDist = Math.max(1e-6, v3len(v3sub(ref.position, ref.target)));
  const ratio = v3len(v3sub(pose.position, pose.target)) / refDist;
  const framed = s.angle !== 'over_shoulder' && s.angle !== 'pov';
  const f = shotFrame(scene, s, span);
  const views = f.views(pose.position, pose.target);
  const out = new Map<string, number[]>();
  for (const k of f.points) {
    if (!k.checked || excess(views[k.sample], k.p, CHECKED_FRAME) <= 1) continue;
    const list = out.get(k.subject) ?? [];
    if (!list.includes(f.frames[k.sample])) list.push(f.frames[k.sample]);
    out.set(k.subject, list);
  }
  let needed: number | null = null;
  if (out.size && framed) {
    // what holding them all would take: the shot's own fit over all its samples, without the limit
    const placed = placeCamera(scene, s, span.frame_start, { ...o, over: f.frames, follow: f.follow });
    const far = Math.max(refDist * NEEDED_BACK_OFF, NEEDED_BACK_OFF_M);
    const kept = checksHold(f.views(placed.position, placed.target), f.points)
      ? { ...placed, holds: true }
      : backOff(f.views, f.points, placed, { cap: far, strict: false, recentre: 1 });
    if (kept.holds) needed = round2(v3len(v3sub(kept.position, kept.target)) / refDist);
  }
  const r = framed ? ratio : 1;
  return {
    widened: r > 1.005,
    distance_ratio: round2(r),
    effective_framing: effectiveFraming(s.framing, r),
    out_of_frame: [...out].map(([id, frames]) => ({
      subject: id,
      name: scene.name(id),
      frames: frames.sort((a, b) => a - b),
    })),
    needed_ratio: needed,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * How many (subject, sample) pairs a camera at `pose` loses over a shot: desk.check's point out of
 * its frame, or a subject so far along its view that it no longer reads at the shot's framing (beyond
 * MAX_WIDEN times the distance of rideo's camera for the shot: one walking straight away from it) or
 * so near (within that distance over MAX_WIDEN: one walking into the lens). What a shot that names no
 * angle compares the angles it may take by.
 */
export function shotFitLosses(
  scene: DeskScene,
  spec: SolveSpec,
  span: ShotSpan,
  pose: CameraPose,
  o: { line?: LinePoints | null; fallbackTarget?: Vec3 } = {},
): number {
  const s = { ...spec, lens_mm: pose.lens };
  const ref = solveCamera(scene, s, span.frame_start, o);
  const refDist = v3len(v3sub(ref.position, ref.target));
  const far = MAX_WIDEN[s.framing] * refDist;
  const near = refDist / MAX_WIDEN[s.framing];
  const f = shotFrame(scene, s, span);
  const views = f.views(pose.position, pose.target);
  let lost = 0;
  for (const k of f.points) {
    if (!k.checked) continue;
    const depth = projectPoint(views[k.sample], k.p).depth;
    if (excess(views[k.sample], k.p, CHECKED_FRAME) > 1 || depth > far || depth < near) lost++;
  }
  return lost;
}

/**
 * Half the width of the body an actor without a rig (a stand-in its parts do not shape) hides what is
 * behind it with: a column this far around its chest from its feet to the top of its head (m: about a
 * person's shoulders).
 */
export const OCCLUDER_RADIUS_M = 0.2;
/** How near its subject the line of sight may pass through another body without hiding it (share of the line). */
const OCCLUSION_END = 0.97;
/** The share of an actor's height its hips stand at (where its body is tested below its chest). */
const HIPS_SHARE = 0.5;

/** A subject of a shot that an actor the shot does not frame hides from its camera. */
export interface Occlusion {
  subject: string;
  name: string;
  /** Who hides it (names). */
  by: string[];
  /**
   * The frames (of those desk.check samples) its desk.check point is hidden at: an actor's eyes (its
   * face does not show), a prop's middle.
   */
  frames: number[];
  /** The frames its eyes show but its body (chest) is hidden at (actors). */
  body_frames: number[];
}

/** A box a line of sight is tested against: an actor's body part (or column), in its own space. */
interface Occluder {
  /** The actor whose body it is. */
  id: string;
  /** World (or, for a following move, the start's mapped space) to box space. */
  inverse: Mat4;
  local: { min: Vec3; max: Vec3 };
}

/**
 * The affine map a following move's map (followMap) applies at one frame, as a matrix (a turn about
 * the vertical and a shift): from the images of the origin and the three axes.
 */
function affineOf(map: (p: Readonly<Vec3>) => Vec3): Mat4 {
  const o = map([0, 0, 0]);
  const x = v3sub(map([1, 0, 0]), o);
  const y = v3sub(map([0, 1, 0]), o);
  const z = v3sub(map([0, 0, 1]), o);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
}

/**
 * The bodies of the actors a shot does not frame at `frame`, as boxes in the space the shot's
 * camera sees them in from its start (`map`: a following move's map of the frame, else none): a
 * rigged actor by its body parts (their meshes' boxes, as posed), an actor without a rig by a column
 * OCCLUDER_RADIUS_M around its chest from its feet to the top of its head. Actors hidden from
 * renders, or scaled away (put away by a hide key, or too small to hide anyone), hide nothing.
 */
function occluders(scene: DeskScene, others: readonly string[], frame: number, map: Mat4 | null): Occluder[] {
  const unmap = map ? invert4(map) : null;
  const out: Occluder[] = [];
  for (const id of others) {
    const s = scene.subject(id, frame);
    if (!s || s.hidden || s.height < 0.3) continue;
    const boxes = s.posed ? scene.bodyBoxes(id, frame) : [];
    if (!boxes.length) {
      const r = OCCLUDER_RADIUS_M;
      boxes.push({
        inverse: compose4([-s.chest[0], -s.chest[1], 0], [0, 0, 0], [1, 1, 1]),
        local: { min: [-r, -r, s.feet[2]], max: [r, r, s.head[2]] },
      });
    }
    for (const b of boxes)
      out.push({ id, inverse: unmap ? multiply4(b.inverse, unmap) : b.inverse, local: b.local });
  }
  return out;
}

/**
 * Whether the line of sight from `from` to `to` passes through a box before it nears its end
 * (OCCLUSION_END). A camera inside the box sees past it (camera_inside is about set pieces).
 */
function sightBlocked(from: Readonly<Vec3>, to: Readonly<Vec3>, b: Occluder): boolean {
  const a = transformPoint(b.inverse, from);
  const e = transformPoint(b.inverse, to);
  let t0 = 0;
  let t1 = OCCLUSION_END;
  let inside = true;
  for (let k = 0; k < 3; k++) {
    if (a[k] < b.local.min[k] || a[k] > b.local.max[k]) inside = false;
    const d = e[k] - a[k];
    if (Math.abs(d) < 1e-12) {
      if (a[k] < b.local.min[k] || a[k] > b.local.max[k]) return false;
      continue;
    }
    const u = (b.local.min[k] - a[k]) / d;
    const w = (b.local.max[k] - a[k]) / d;
    t0 = Math.max(t0, Math.min(u, w));
    t1 = Math.min(t1, Math.max(u, w));
    if (t0 > t1) return false;
  }
  return !inside;
}

/** `p` through an affine matrix. */
const transformPoint = (m: Readonly<Mat4>, p: Readonly<Vec3>): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/** The actors of the scene that are not among `subjects` and show in renders: who may stand in the way. */
function bystanders(scene: DeskScene, subjects: readonly string[]): string[] {
  const cast = new Set(subjects);
  return [...scene.objects.values()]
    .filter((o) => !cast.has(o.id) && !o.hide_render && scene.isActor(o.id))
    .map((o) => o.id);
}

/**
 * The subjects of a shot hidden from a camera at `pose` (through the shot's move) behind actors the
 * shot does not frame, at the frames desk.check samples (occluded_subject): the line from the camera
 * to a subject's eyes (a prop's middle) passes through such an actor's body (its posed body parts, a
 * column for an actor without a rig), or, its eyes showing, the line to its chest or its hips does
 * (its body is hidden). Only points the frame shows count. A camera widened over its shot or fitted
 * around a group can end up behind a bystander (Kite Day S11: Ada's back covering Ben's body and the
 * melon). Actors hidden from renders, or scaled away, hide nothing; a rider's mount does not hide her
 * (nor she it); a subject put away at a frame is hidden behind nobody there.
 */
export function shotOcclusions(
  scene: DeskScene,
  spec: SolveSpec,
  span: ShotSpan,
  pose: CameraPose,
): Occlusion[] {
  if (!bystanders(scene, spec.subjects).length) return [];
  const f = shotFrame(scene, { ...spec, lens_mm: pose.lens }, span);
  return occlusionsThrough(scene, spec.subjects, f.frames, f.views(pose.position, pose.target), f.follow).map(
    ({ by_ids: _, ...o }) => o,
  );
}

/** An occlusion with the ids of who hides the subject (occlusionsThrough). */
export interface OcclusionBy extends Occlusion {
  by_ids: string[];
}

/**
 * The subjects (of `subjects`) hidden behind actors not among them, seen through `views` (one per
 * frame of `frames`; null where there is no camera): shotOcclusions's rule at those frames. `follow`:
 * how a following move maps the frames after the first into the space its camera sees them in from
 * its start (the views being the start's); none for views of the camera where it stands at each
 * frame (desk.check reads the keyed camera).
 */
export function occlusionsThrough(
  scene: DeskScene,
  subjects: readonly string[],
  frames: readonly number[],
  views: readonly (CameraView | null)[],
  follow: FollowMap | null = null,
): OcclusionBy[] {
  const others = bystanders(scene, subjects);
  if (!others.length) return [];
  const found = new Map<string, { by: Set<string>; frames: Set<number>; body: Set<number> }>();
  frames.forEach((frame, sample) => {
    const view = views[sample];
    if (!view) return;
    const mapped = sample > 0 && follow ? follow : null;
    const map = mapped
      ? (p: Readonly<Vec3>) => mapped(p, frame)
      : (p: Readonly<Vec3>): Vec3 => [p[0], p[1], p[2]];
    const bodies = occluders(scene, others, frame, mapped ? affineOf(map) : null);
    if (!bodies.length) return;
    const mounts = new Map<string, string | null>();
    const mountOf = (id: string): string | null => {
      if (!mounts.has(id)) mounts.set(id, scene.mountOf(id, frame));
      return mounts.get(id)!;
    };
    for (const id of subjects) {
      const s = scene.subject(id, frame);
      if (!s || s.hidden) continue;
      // a rider sits on her mount (and a mount carries its rider): neither hides the other
      const theirs = bodies.filter((b) => b.id !== mountOf(id) && mountOf(b.id) !== id);
      if (!theirs.length) continue;
      // who hides a point the frame shows (one out of it is subject_out_of_frame's matter, or not shown)
      const blockers = (p: Readonly<Vec3>): string[] => {
        const q = map(p);
        if (excess(view, q, CHECKED_FRAME) > 1) return [];
        return [...new Set(theirs.filter((b) => sightBlocked(view.position, q, b)).map((b) => b.id))];
      };
      let by = blockers(s.actor ? s.eyes : s.center);
      const face = by.length > 0;
      // its eyes show: its body, at its chest and its hips
      if (!face && s.actor)
        by = [...new Set([...blockers(s.chest), ...blockers(subjectPoint(s, HIPS_SHARE))])];
      if (!by.length) continue;
      const entry = found.get(id) ?? {
        by: new Set<string>(),
        frames: new Set<number>(),
        body: new Set<number>(),
      };
      for (const b of by) entry.by.add(b);
      (face ? entry.frames : entry.body).add(frame);
      found.set(id, entry);
    }
  });
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return [...found].map(([id, e]) => {
    // who hides it by name (in name order), and their ids in the same order
    const by = [...e.by]
      .map((b) => ({ id: b, name: scene.name(b) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      subject: id,
      name: scene.name(id),
      by: by.map((b) => b.name),
      by_ids: by.map((b) => b.id),
      frames: sorted(e.frames),
      body_frames: sorted(e.body),
    };
  });
}

/** Turns about its aim (degrees, each side in turn) a camera a bystander blocks tries, then rises (m). */
const UNBLOCK_TURNS_DEG = [10, -10, 20, -20] as const;
const UNBLOCK_RISES_M = [0.5, 1] as const;

/** How much a camera's occlusions weigh: a subject's eyes hidden at a sample twice its body. */
const occlusionWeight = (os: readonly Occlusion[]): number =>
  os.reduce((n, o) => n + 2 * o.frames.length + o.body_frames.length, 0);

/**
 * A camera at `pose` that sees past the actors the shot does not frame (shotOcclusions): the pose
 * itself when none of them hides a subject, else the first of a few small changes that hides less
 * (none, if one does) and keeps desk.check's points in frame as well as the pose (and `accept`
 * takes: its side of the line): turned about its aim by UNBLOCK_TURNS_DEG (a step aside), then raised
 * by UNBLOCK_RISES_M (looking over them). The pose when none does better (the solve then warns).
 */
function unblocked(
  scene: DeskScene,
  spec: SolveSpec,
  span: ShotSpan,
  f: ReturnType<typeof shotFrame>,
  pose: { position: Vec3; target: Vec3 },
  accept: (p: { position: Vec3; target: Vec3 }) => boolean,
): { position: Vec3; target: Vec3 } {
  const lens = Math.min(800, Math.max(8, Math.round(spec.lens_mm)));
  const weigh = (p: { position: Vec3; target: Vec3 }) =>
    occlusionWeight(shotOcclusions(scene, spec, span, { position: p.position, target: p.target, lens }));
  let best = { pose, weight: weigh(pose) };
  if (!best.weight) return pose;
  const misses = (p: { position: Vec3; target: Vec3 }) => {
    const views = f.views(p.position, p.target);
    return f.points.filter((k) => k.check && excess(views[k.sample], k.p, k.check) > 1).length;
  };
  const missed = misses(pose);
  const { position: at, target } = pose;
  const turned = (deg: number): { position: Vec3; target: Vec3 } => {
    const a = (deg * Math.PI) / 180;
    const dx = at[0] - target[0];
    const dy = at[1] - target[1];
    return {
      position: [
        target[0] + dx * Math.cos(a) - dy * Math.sin(a),
        target[1] + dx * Math.sin(a) + dy * Math.cos(a),
        at[2],
      ],
      target,
    };
  };
  const tries = [
    ...UNBLOCK_TURNS_DEG.map(turned),
    ...UNBLOCK_RISES_M.map((m) => ({ position: [at[0], at[1], at[2] + m] as Vec3, target })),
  ];
  for (const c of tries) {
    if (!accept(c) || misses(c) > missed) continue;
    const weight = weigh(c);
    if (weight >= best.weight) continue;
    best = { pose: c, weight };
    if (!weight) break;
  }
  return best.pose;
}

/**
 * Solves a shot's camera over the shot (F3): placed by rideo's rules (placeCamera) around where its
 * subjects are at the frames desk.check samples (the first, middle and last; the first only for
 * moves that turn away), seen through a following move; then kept in frame through the shot's move:
 * when desk.check's point of a subject it does not leave out by design (an actor's eyes, a prop's
 * middle) or what the framing shows of an animal would leave the frame at one of those frames, the
 * camera is widened, at most MAX_WIDEN times as far back as rideo's camera for the shot at its first
 * frame (about one framing step wider). Subjects it cannot keep within that leave the frame at the
 * later frames (the first frame is kept first: rideo draws the shot's board from it), and the report
 * says so. A camera an actor outside the shot blocks steps aside or up to see past them (unblocked).
 * Subjects that stay put and in frame, seen past nobody, give rideo's camera exactly.
 * Over-the-shoulder and point-of-view cameras stand where their rules put them.
 */
export function fitShotCamera(
  scene: DeskScene,
  spec: SolveSpec,
  span: ShotSpan,
  o: { line?: LinePoints | null; fallbackTarget?: Vec3 } = {},
): SolvedCamera & FitReport {
  const ref = placeCamera(scene, spec, span.frame_start, o);
  let kept: { position: Vec3; target: Vec3 } = ref;
  if (ref.rule === 'framed') {
    const f = shotFrame(scene, spec, span);
    const cap = MAX_WIDEN[spec.framing] * v3len(v3sub(ref.position, ref.target));
    // rideo's camera itself when not even its actors at the first frame can be held within the limit
    // (or only from the other side of the line)
    kept =
      keepWithin(
        scene,
        f,
        (n) =>
          n === 1
            ? ref
            : placeCamera(scene, spec, span.frame_start, {
                ...o,
                over: f.frames.slice(0, n),
                follow: f.follow,
              }),
        cap,
        1,
        onLineSide(o.line),
      ) ?? ref;
    // a step aside or up when a bystander hides a subject from there
    kept = unblocked(scene, spec, span, f, kept, onLineSide(o.line));
  }
  const done = finishCamera(scene, spec, span.frame_start, kept);
  return {
    ...done,
    ...shotFitReport(
      scene,
      spec,
      span,
      { position: done.position, target: done.target, lens: done.lens_mm },
      o,
    ),
  };
}

/**
 * Fits a shot's camera keeping the composition of rideo's camera at its first frame (planFit: a plan
 * agreeing there): from that camera (placeCamera without the line), aimed from its own aim towards
 * the middle of the subjects over the shot by the largest share of KEEPING_SHIFTS that `accept` takes
 * (the first frame still agrees), and backed off along its line of sight within the limit until the
 * subjects hold at as many of the samples (from the first) as it can. Null when none of those cameras
 * is accepted; over-the-shoulder and point-of-view shots have none.
 */
export function fitShotCameraKeeping(
  scene: DeskScene,
  spec: SolveSpec,
  span: ShotSpan,
  accept: (view: CameraView) => boolean,
): (SolvedCamera & FitReport) | null {
  const ref = placeCamera(scene, spec, span.frame_start);
  if (ref.rule !== 'framed') return null;
  const f = shotFrame(scene, spec, span);
  const cap = MAX_WIDEN[spec.framing] * v3len(v3sub(ref.position, ref.target));
  const lens = Math.min(800, Math.max(8, Math.round(spec.lens_mm)));
  const agrees = (p: { position: Vec3; target: Vec3 }) =>
    accept(viewFromPose(p.position, p.target, lens, scene.aspect));
  let best: { position: Vec3; target: Vec3; held: number } | null = null;
  for (const shift of KEEPING_SHIFTS) {
    const kept = keepWithin(scene, f, () => ref, cap, shift, agrees);
    if (kept && (!best || kept.held > best.held)) best = kept;
    if (best?.held === f.frames.length) break;
  }
  if (!best) return null;
  const done = finishCamera(scene, spec, span.frame_start, best);
  if (!accept(viewFromPose(done.position, done.target, done.lens_mm, scene.aspect))) return null;
  return {
    ...done,
    ...shotFitReport(scene, spec, span, { position: done.position, target: done.target, lens: done.lens_mm }),
  };
}

/**
 * A camera pose placed by other means (a pose mirrored over the line) with the shot's subjects kept
 * in frame through its move: the pose itself when they stay in frame, else widened as fitShotCamera
 * widens, within the same limit, never onto the other side of `line` (and backed out of set pieces).
 * Over-the-shoulder and point-of-view shots keep their pose.
 */
export function keepShotInFrame(
  scene: DeskScene,
  spec: SolveSpec,
  span: ShotSpan,
  pose: CameraPose,
  line: LinePoints | null = null,
): CameraPose {
  if (spec.angle === 'over_shoulder' || spec.angle === 'pov') return pose;
  const s = { ...spec, lens_mm: pose.lens };
  const f = shotFrame(scene, s, span);
  const ref = placeCamera(scene, s, span.frame_start);
  const cap = Math.max(
    MAX_WIDEN[s.framing] * v3len(v3sub(ref.position, ref.target)),
    v3len(v3sub(pose.position, pose.target)),
  );
  const kept = keepWithin(scene, f, () => pose, cap, 1, onLineSide(line)) ?? pose;
  if (kept.position === pose.position && kept.target === pose.target) return pose;
  const done = finishCamera(scene, s, span.frame_start, kept);
  return { position: done.position, target: done.target, lens: pose.lens };
}
