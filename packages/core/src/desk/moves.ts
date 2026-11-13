import type { Mat4, Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import { fcurveKey } from '../doc/scene-doc';
import type {
  CameraData,
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
  v3add,
  v3cross,
  v3dot,
  v3len,
  v3mul,
  v3norm,
  v3sub,
  type CameraView,
} from './layout';
import { CRANE_M, DESK_SENSOR_WIDTH_MM, ORBIT_DEG, moveEnd } from './solver';

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
 * the nearest subject to the farthest; tracking_follow and steadicam_walk follow the first subject with
 * a key on every frame; locked_off none.
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

/** Moves keyed on every frame of the shot (they follow its first subject). */
export const FOLLOW_MOVES: ReadonlySet<DeskMove> = new Set(['tracking_follow', 'steadicam_walk']);

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
  const centres = subjects.map((id) => scene.subject(id, frame)?.chest).filter((p): p is Vec3 => !!p);
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

// ---------------------------------------------------------------- moves

export interface CameraMoveOptions {
  frame_start: number;
  frame_end: number;
  /** Strength of the move: 1 = the library's distance or angle. */
  amount?: number;
  /** Seed of the handheld noise (the shot id). */
  seed?: string;
  /** The subject a following move follows (the shot's first subject). */
  subject?: string;
  /** The shot's subjects (rack focus racks from the nearest to the farthest). */
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
      const dz = (m === 'crane_up' ? 1 : -1) * CRANE_M * amount;
      const target = start.target;
      const p0 = start.position;
      const p1: Vec3 = [p0[0], p0[1], Math.max(0.05, p0[2] + dz)];
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
      const t0 = start.target;
      const p0 = start.position;
      const v: Vec3 = [p0[0] - t0[0], p0[1] - t0[1], 0];
      const r = Math.hypot(v[0], v[1]);
      const right = v3norm(v3cross(v3norm(v3sub(t0, p0), [0, 1, 0]), [0, 0, 1]), [1, 0, 0]);
      const k = m === 'orbit_left' ? -1 : 1;
      const total = rad(ORBIT_DEG * amount);
      end = lookPath(orbitKeyCount(amount), (t) => {
        const a = total * smooth(t);
        const turned: Vec3 = [
          v[0] * Math.cos(a) + right[0] * k * r * Math.sin(a),
          v[1] * Math.cos(a) + right[1] * k * r * Math.sin(a),
          0,
        ];
        return { position: [t0[0] + turned[0], t0[1] + turned[1], p0[2]], target: t0 };
      });
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
      const d0 = v3len(v3sub(start.target, start.position));
      let lens1 = start.lens * (1 - Math.min(0.9, 0.35 * amount));
      lens1 = Math.min(800, Math.max(8, lens1));
      const d1 = (d0 * lens1) / start.lens;
      const dir = v3norm(v3sub(start.target, start.position));
      const p1 = v3sub(start.target, v3mul(dir, d1));
      writer.pose(fe, p1, startEuler, { rotation: false });
      writer.lens(fe, lens1);
      end = { position: p1, target: start.target, lens: lens1 };
      break;
    }
    case 'drone_flyover': {
      const t0 = start.target;
      const p0 = start.position;
      const h: Vec3 = [p0[0] - t0[0], p0[1] - t0[1], 0];
      const rise = Math.max(DRONE_RISE_M, 1.2 * Math.hypot(h[0], h[1])) * amount;
      end = lookPath(DRONE_KEYS, (t) => {
        const s = smooth(t);
        const k = 1 - DRONE_TRAVEL * s;
        return {
          position: [t0[0] + h[0] * k, t0[1] + h[1] * k, p0[2] + rise * Math.sin((Math.PI / 2) * s)],
          target: t0,
        };
      });
      break;
    }
    case 'rack_focus': {
      const from = start.position;
      const forward = v3norm(v3sub(start.target, from));
      const depths = (o.subjects ?? [])
        .map((id) => scene.subject(id, fs))
        .filter((s): s is NonNullable<typeof s> => !!s)
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
      const subject = o.subject ?? o.subjects?.[0];
      if (!subject || !scene.objects.has(subject)) break;
      const at0 = scene.origin(subject, fs);
      const face0 = scene.facing(subject, fs);
      const off = v3sub(start.position, at0);
      const toff = v3sub(start.target, at0);
      let prev = startEuler;
      let last: { position: Vec3; target: Vec3 } = { position: start.position, target: start.target };
      for (let f = fs; f <= fe; f++) {
        const at = scene.origin(subject, f);
        if (m === 'tracking_follow') {
          // the camera travels with the subject; its view direction stays
          const position = v3add(at, off);
          writer.pose(f, position, startEuler, { rotation: false });
          last = { position, target: v3add(at, toff) };
          continue;
        }
        // steadicam: the offset turns with the subject's heading, with a gentle bob
        const face = scene.facing(subject, f);
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
