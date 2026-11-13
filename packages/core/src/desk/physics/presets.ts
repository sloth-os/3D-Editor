import type { Mat4, Vec3 } from '../../math/types';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import type { CollisionShape, ObjectData, RigidBodyData } from '../../doc/types';
import { createPlane } from '../../mesh/primitives';
import { OperatorError } from '../../operators/context';
import { isMeshMemoryError } from '../../mesh/memory';
import { RigidBodySimulator, rigidBodyCacheInfo } from '../../physics/rigid-body';
import {
  MAX_INITIAL_VELOCITY,
  MAX_SIMULATED_FRAMES,
  RELEASE_TRACKED_STEPS,
  motionMode,
  newRigidBody,
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  worldParams,
} from '../../physics/settings';
import { getCatalogEntry } from '../../store/catalog';
import { getDeskSettings } from '../shots';
import {
  RIGID_BODY_BAKED_PROP,
  baseName,
  descendants,
  directionIn,
  originOf,
  parentMatrix,
  sceneSampler,
  worldBounds,
} from './common';

/*
 * The physics presets of the director's desk (spec §4, review finding 3): rigid bodies on props with
 * a ground under them, and props dropped, thrown or pushed at a frame. A preset gives the body a
 * start_frame (RigidBodyData): the prop follows its animation, a hand holding it, up to that frame,
 * then the simulation moves it, with the velocity the preset computed. Every preset then fits the
 * rigid body world to the frames the bodies need (`updateDeskWorldRange`): it starts
 * RELEASE_TRACKED_STEPS frames before the first release (so a released prop keeps the velocity its
 * hand gave it, checked against the step before for a jump of its animation) and ends when every body
 * has come to rest, found by simulating, so a ball thrown at frame 4000 of a long film costs the
 * simulation a few seconds of frames, not the film. A release preset also makes sure a ground is under
 * the body and where it lands (`ensureGround`): the floor at z = 0, not a table it stands on.
 */

/** Longest a preset lets bodies settle after the last release before it ends the world anyway (s). */
export const DESK_SETTLE_MAX_SECONDS = 20;

/** How long the world runs after the last release when the settling cannot be simulated (s). */
export const DESK_SETTLE_FALLBACK_SECONDS = 6;

/** Frames the world runs on after every body has come to rest. */
const SETTLE_MARGIN_FRAMES = 1;

/**
 * A body is at rest for the world's range when, over the last SETTLE_WINDOW_SECONDS, its origin moved
 * less than SETTLE_DISTANCE and it turned less than SETTLE_ANGLE (or the simulation put it to sleep):
 * holding its state from there is not visible, while the engine's own sleep waits for a ball to crawl
 * slower than 4 mm/s.
 */
export const SETTLE_WINDOW_SECONDS = 0.5;
export const SETTLE_DISTANCE = 0.005;
export const SETTLE_ANGLE = 0.01;

/**
 * Settings of a new ball (a SPHERE body): it bounces (restitution 0.6 against the desk's ground,
 * whose friction and restitution are 1 so that the props' own values decide) and rolls to a stop on
 * grass within seconds. The engine has no rolling resistance, so angular damping stands in for it:
 * at 0.9 a ball landing at 5 m/s rolls about 7 m and is at rest about 9 s later (at the default 0.1
 * it would roll on for half a minute); its spin in the air fades by the same rate.
 */
export const DESK_BALL_SETTINGS = { friction: 0.6, restitution: 0.6, angular_damping: 0.9 } as const;

/** Size of the ground plane a preset adds when the desk set has no size (m). */
const DEFAULT_GROUND_SIZE = 60;

/**
 * Words of a name or label, split at separators and camel case: 'SoccerBall.001' → soccer, ball;
 * 'beach_ball' → beach, ball.
 */
function words(text: string): string[] {
  return baseName(text)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** A word that names a ball or a sphere: ball(s), …ball (football, basketball), sphere, globe, orb. */
const BALL_WORD = /^(?:[a-z]*balls?|spheres?|globes?|orbs?)$/;

/** Words of things named after balls that are not balls (a football goal, a baseball bat, a ball gown…). */
const NOT_A_BALL = new Set([
  'bag',
  'bat',
  'bats',
  'boot',
  'boots',
  'bust',
  'cap',
  'column',
  'court',
  'field',
  'game',
  'glove',
  'goal',
  'goals',
  'gown',
  'hoop',
  'lamp',
  'machine',
  'net',
  'park',
  'pen',
  'pillar',
  'pit',
  'pitch',
  'player',
  'post',
  'rack',
  'room',
  'shoe',
  'shoes',
  'stand',
  'statue',
  'table',
]);

/**
 * Whether a name or label names a ball: one of its words is a ball word ('marble' only as its last
 * word: a glass marble, not a marble column) and none names a thing called after balls.
 */
function namesBall(text: string): boolean {
  const w = words(text);
  if (!w.length || w.some((x) => NOT_A_BALL.has(x))) return false;
  const last = w[w.length - 1];
  return w.some((x) => BALL_WORD.test(x)) || last === 'marble' || last === 'marbles';
}

/** How desk.physics_setup simulates objects: dynamic, static colliders, or animated colliders. */
export type DeskPhysicsKindName = 'active' | 'passive' | 'animated';

export interface DeskBodySettings {
  kind: DeskPhysicsKindName;
  shape?: CollisionShape;
  mass?: number;
  friction?: number;
  restitution?: number;
}

const finite3 = (v: readonly number[]): boolean => v.length === 3 && v.every(Number.isFinite);

/**
 * Whether object `o` is a ball: its own name or label names one, or the store entry of the model it
 * belongs to is one (tagged 'ball': the catalog's balls, not its marble column); else its parents'
 * names and labels decide. It gets a SPHERE body.
 */
export function isBallLike(doc: SceneDoc, o: ObjectData): boolean {
  let cur: ObjectData | null = o;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const label = cur.custom_props?.desk_label;
    if (namesBall(cur.name) || (typeof label === 'string' && namesBall(label))) return true;
    const store = cur.custom_props?.store_id;
    const entry = typeof store === 'string' ? getCatalogEntry(store) : null;
    if (entry) return entry.tags.includes('ball') || namesBall(entry.name);
    cur = cur.parent ? doc.getObject(cur.parent) : null;
  }
  return false;
}

/** The collision shape a preset gives object `o`: SPHERE for balls, BOX otherwise, MESH for static colliders. */
export function guessShape(doc: SceneDoc, o: ObjectData, kind: DeskPhysicsKindName): CollisionShape {
  if (kind === 'passive') return 'MESH';
  return isBallLike(doc, o) ? 'SPHERE' : 'BOX';
}

/** Volume of a mesh object's local bounds (scaled by its own scale), for picking a model's main part. */
function partVolume(doc: SceneDoc, o: ObjectData): number {
  const mesh = o.data ? doc.getMesh(o.data) : null;
  if (!mesh || !mesh.positions.length) return 0;
  const P = mesh.positions;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v + 2 < P.length; v += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], P[v + k]);
      hi[k] = Math.max(hi[k], P[v + k]);
    }
  return [0, 1, 2].reduce((acc, k) => acc * Math.max(1e-6, (hi[k] - lo[k]) * Math.abs(o.scale[k])), 1);
}

/**
 * The mesh object that carries the rigid body of `id`: the object itself when it is a mesh; for a
 * model's root (an EMPTY with mesh parts, a store model) its only mesh part, or its largest one with
 * the model's other parts parented under it (keeping their transforms) so the whole model moves as
 * one body. Null (with a warning) when there is no mesh.
 */
export function bodyObjectFor(doc: SceneDoc, id: string, warnings: string[]): string | null {
  const o = doc.getObject(id);
  if (!o) return null;
  if (o.type === 'MESH' && o.data) return id;
  const parts = descendants(doc, id).filter((d) => d.type === 'MESH' && d.data);
  if (!parts.length) {
    warnings.push(`'${o.name}' has no mesh to give a rigid body (skipped)`);
    return null;
  }
  if (parts.length === 1) return parts[0].id;
  const main = parts.reduce((a, b) => (partVolume(doc, b) > partVolume(doc, a) ? b : a));
  const fs = sceneSampler(doc).at(sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).frame_start);
  const mainWorld = fs.world(main.id);
  if (!mainWorld) return main.id;
  // the parts directly under the root (and their children through them) follow the main part
  let moved = 0;
  for (const p of descendants(doc, id)) {
    if (p.id === main.id || p.parent !== id) continue;
    const world = fs.world(p.id);
    if (!world) continue;
    doc.updateObject(p.id, { parent: main.id, parent_type: 'OBJECT', parent_bone: '' });
    doc.setWorldMatrix(p.id, world, mainWorld);
    moved++;
  }
  if (moved)
    warnings.push(
      `'${o.name}' has ${parts.length} mesh parts: its largest, '${main.name}', carries the rigid body and ` +
        `the other parts follow it`,
    );
  return main.id;
}

/** Rigid body settings a preset gives object `o` (its existing settings kept where not asked to change). */
function bodySettings(doc: SceneDoc, o: ObjectData, s: DeskBodySettings): RigidBodyData {
  const existing = sanitizeRigidBody(o.rigid_body);
  const type = s.kind === 'active' ? 'ACTIVE' : 'PASSIVE';
  const shape =
    s.shape ?? (existing && existing.type === type ? existing.collision_shape : guessShape(doc, o, s.kind));
  let rb: RigidBodyData = existing ? { ...existing, type } : newRigidBody(type);
  if (!existing && s.kind !== 'passive' && shape === 'SPHERE') rb = { ...rb, ...DESK_BALL_SETTINGS };
  rb = {
    ...rb,
    collision_shape: shape,
    enabled: true,
    kinematic: s.kind === 'animated',
    ...(s.mass !== undefined ? { mass: s.mass } : {}),
    ...(s.friction !== undefined ? { friction: s.friction } : {}),
    ...(s.restitution !== undefined ? { restitution: s.restitution } : {}),
  };
  // only ACTIVE, not animated bodies start late
  if (s.kind !== 'active') rb = { ...rb, start_frame: null };
  return rb;
}

/** Stores rigid body settings on an object, which is no longer a baked body then. */
function setBody(doc: SceneDoc, id: string, rb: RigidBodyData): void {
  const o = doc.getObject(id)!;
  if (o.custom_props && RIGID_BODY_BAKED_PROP in o.custom_props) {
    const props = { ...o.custom_props };
    delete props[RIGID_BODY_BAKED_PROP];
    doc.updateObject(id, { rigid_body: rb, custom_props: props });
  } else doc.updateObject(id, { rigid_body: rb });
}

/** Changes the rigid body of `id` (which has one) by `patch`. */
function patchBody(doc: SceneDoc, id: string, patch: Partial<RigidBodyData>): RigidBodyData {
  const rb = { ...sanitizeRigidBody(doc.getObject(id)!.rigid_body)!, ...patch };
  setBody(doc, id, rb);
  return rb;
}

/** XY rectangle and bottom of a body at a frame state (null for objects without geometry). */
interface Footprint {
  x: number;
  y: number;
  bottom: number;
}

function footprints(
  doc: SceneDoc,
  ids: readonly string[],
  frame: number,
  extra: readonly Vec3[],
): Footprint[] {
  const fs = sceneSampler(doc).at(frame);
  const out: Footprint[] = [];
  for (const id of ids) {
    const o = doc.getObject(id);
    const m = o ? fs.world(id) : null;
    const b = o && m ? worldBounds(doc, o, m) : null;
    if (b) out.push({ x: (b.min[0] + b.max[0]) / 2, y: (b.min[1] + b.max[1]) / 2, bottom: b.min[2] });
  }
  for (const p of extra) out.push({ x: p[0], y: p[1], bottom: p[2] });
  return out;
}

/** Whether passive collider bounds `b` lie under footprint `f` (its XY inside, its top not above the bottom). */
function under(b: { min: Vec3; max: Vec3 }, f: Footprint): boolean {
  const m = 0.01;
  return (
    f.x >= b.min[0] - m &&
    f.x <= b.max[0] + m &&
    f.y >= b.min[1] - m &&
    f.y <= b.max[1] + m &&
    b.max[2] <= f.bottom + 0.05
  );
}

/** A flat ground: bounds no thicker than 5 cm (a plane, a thin slab). */
const flat = (b: { min: Vec3; max: Vec3 }): boolean => b.max[2] - b.min[2] <= 0.05;

/** How far from z = 0 the top of a collider may be for it to count as the floor (m). */
const FLOOR_TOLERANCE = 0.05;

/**
 * Whether static collider `o` (bounds `b`) is a floor: the desk set's flat ground, or a collider
 * whose top is at z = 0 (a plane, a floor slab). A table, a shelf or a stage stands on the floor
 * and is not one: a prop pushed or dropped off it must land on something.
 */
const floorLike = (o: ObjectData, b: { min: Vec3; max: Vec3 }): boolean =>
  (o.custom_props?.desk_role === 'set' && flat(b)) || Math.abs(b.max[2]) <= FLOOR_TOLERANCE;

/**
 * A passive floor under the bodies `ids` (at `frame`) and the points `extra` (where they land), or
 * null when none is needed: an existing static floor under all of them (see `floorLike`: tables and
 * other raised colliders do not count), else the desk set's flat ground given a static body, else a
 * new ground plane at z = 0 (desk_role 'set') covering them. The ground's friction and restitution
 * are 1, so that the props' own values decide (a contact uses the product of both bodies' values).
 */
export function ensureGround(
  doc: SceneDoc,
  ids: readonly string[],
  extra: readonly Vec3[],
  frame: number,
  warnings: string[],
): string | null {
  const feet = footprints(doc, ids, frame, extra);
  if (!feet.length) return null;
  const fs = sceneSampler(doc).at(frame);
  const boundsOf = (o: ObjectData) => {
    const m = fs.world(o.id);
    return m ? worldBounds(doc, o, m) : null;
  };
  const floors: { id: string; b: { min: Vec3; max: Vec3 } }[] = [];
  const sets: { id: string; b: { min: Vec3; max: Vec3 } }[] = [];
  for (const o of doc.listObjects()) {
    if (ids.includes(o.id) || o.type !== 'MESH') continue;
    const rb = sanitizeRigidBody(o.rigid_body);
    if (rb && motionMode(rb) === 'STATIC') {
      const b = boundsOf(o);
      if (b && floorLike(o, b)) floors.push({ id: o.id, b });
    } else if (!rb && o.custom_props?.desk_role === 'set') {
      const b = boundsOf(o);
      if (b && flat(b)) sets.push({ id: o.id, b });
    }
  }
  const covering = floors.find((c) => feet.every((f) => under(c.b, f)));
  if (covering) return covering.id;
  if (feet.every((f) => floors.some((c) => under(c.b, f)))) return null;
  const set = sets.find((s) => feet.every((f) => under(s.b, f)));
  if (set) {
    setBody(doc, set.id, {
      ...newRigidBody('PASSIVE'),
      collision_shape: 'MESH',
      friction: 1,
      restitution: 1,
    });
    warnings.push(`'${doc.getObject(set.id)!.name}' became the static ground collider`);
    return set.id;
  }
  // a new ground plane under everything, at least the desk set's size
  const xs = feet.map((f) => f.x);
  const ys = feet.map((f) => f.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const desk = getDeskSettings(doc);
  const size = Math.max(DEFAULT_GROUND_SIZE, desk.set_width, desk.set_depth, spread + 40);
  const mesh = doc.addMesh('Ground', createPlane({ size }));
  const ground = doc.addObject({
    type: 'MESH',
    name: 'Ground',
    data: mesh,
    location: [Math.round(cx), Math.round(cy), 0],
    custom_props: { desk_role: 'set', desk_label: 'ground' },
    rigid_body: { ...newRigidBody('PASSIVE'), collision_shape: 'MESH', friction: 1, restitution: 1 },
  });
  if (feet.some((f) => f.bottom < -0.05))
    warnings.push('some objects start below z = 0, under the new ground plane: lift them or move the ground');
  return ground;
}

/** Seconds of fall a landing prediction looks ahead at most. */
const LANDING_MAX_SECONDS = 10;

/**
 * Where body `id` lands on z = 0 when it leaves its pose at `frame` with `velocity` (m/s; plus the
 * velocity of its animation into that frame with `inherit`) and flies freely: a point for
 * `ensureGround`, so that the ground also covers where a pushed or thrown prop comes down (off a
 * table, past the end of the set). Null when the body has no pose or geometry there.
 */
function landingPoint(
  doc: SceneDoc,
  id: string,
  frame: number,
  velocity: Readonly<Vec3>,
  inherit: boolean,
): Vec3 | null {
  const o = doc.getObject(id);
  const sampler = sceneSampler(doc);
  const now = o ? sampler.at(frame).world(id) : null;
  const b = o && now ? worldBounds(doc, o, now) : null;
  if (!b) return null;
  const params = worldParams(doc.getScene());
  const v: Vec3 = [velocity[0], velocity[1], velocity[2]];
  if (inherit) {
    const before = sampler.at(frame - 1).world(id);
    const perFrame = params.fps / Math.max(1e-6, params.timeScale);
    if (before) for (let k = 0; k < 3; k++) v[k] += (now![12 + k] - before[12 + k]) * perFrame;
  }
  const g = -params.gravity[2];
  const h = Math.max(0, b.min[2]);
  const t =
    g > 1e-9 ? (v[2] + Math.sqrt(v[2] * v[2] + 2 * g * h)) / g : h > 0 || v[2] < 0 ? LANDING_MAX_SECONDS : 0;
  const time = Math.min(LANDING_MAX_SECONDS, Number.isFinite(t) ? t : 0);
  return [(b.min[0] + b.max[0]) / 2 + v[0] * time, (b.min[1] + b.max[1]) / 2 + v[1] * time, 0];
}

/**
 * Last frame at which the animated (kinematic) bodies `ids` may move: the latest key of the F-curves
 * of them, their parents and their constraint targets (the scene's frame_end when a driver moves
 * one of those), −Infinity when nothing animates them.
 */
function animationEnd(doc: SceneDoc, ids: readonly string[]): number {
  const seen = new Set<string>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const o = doc.getObject(id);
    if (!o) continue;
    if (o.parent) queue.push(o.parent);
    for (const c of o.constraints) if (c.target && !c.mute) queue.push(c.target);
  }
  let end = -Infinity;
  for (const fc of doc.listFCurves())
    if (fc.target_type === 'object' && seen.has(fc.target_id) && !fc.mute)
      for (const k of fc.keyframes) end = Math.max(end, k.frame);
  for (const d of doc.listDrivers())
    if (d.target_type === 'object' && seen.has(d.target_id) && !d.mute)
      end = Math.max(end, doc.getScene().frame_end);
  return end;
}

/** Angle of the rotation between the rotation parts of two matrices (their scale removed). */
function turnBetween(a: Readonly<Mat4>, b: Readonly<Mat4>): number {
  let tr = 0;
  for (let c = 0; c < 3; c++) {
    const la = Math.hypot(a[c * 4], a[c * 4 + 1], a[c * 4 + 2]) || 1;
    const lb = Math.hypot(b[c * 4], b[c * 4 + 1], b[c * 4 + 2]) || 1;
    tr += (a[c * 4] * b[c * 4] + a[c * 4 + 1] * b[c * 4 + 1] + a[c * 4 + 2] * b[c * 4 + 2]) / (la * lb);
  }
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
}

/**
 * Whether every simulated body is at rest: asleep, or moved less than SETTLE_DISTANCE and turned less
 * than SETTLE_ANGLE between the matrices `before` and `now` (a window apart).
 */
function atRest(doc: SceneDoc, now: Map<string, Mat4> | null, before: Map<string, Mat4> | null): boolean {
  const info = rigidBodyCacheInfo(doc);
  if (!info) return true;
  return info.objects.every((b) => {
    if (b.motion !== 'DYNAMIC' || b.sleeping) return true;
    const m = now?.get(b.object);
    const p = before?.get(b.object);
    if (!m || !p) return false;
    const moved = Math.hypot(m[12] - p[12], m[13] - p[13], m[14] - p[14]);
    return moved < SETTLE_DISTANCE && turnBetween(m, p) < SETTLE_ANGLE;
  });
}

/** The rigid body world's range after a preset (see {@link updateDeskWorldRange}). */
export interface DeskWorldRange {
  frame_start: number;
  frame_end: number;
  /** Whether every body came to rest before the world's end (else it ends at the settling limit). */
  settled: boolean;
}

/**
 * Fits the rigid body world (enabled) to the frames its bodies need (review finding 3a): it starts
 * RELEASE_TRACKED_STEPS frames before the first start frame (a released body follows its animation
 * over those steps: the last gives the velocity it keeps, the one before shows a jump of the
 * animation; bodies without a start frame start with the world as before), and ends once every
 * simulated body has been released and has come to rest (simulated to find out, the animated colliders
 * done moving), at most DESK_SETTLE_MAX_SECONDS after the last release. The simulation it runs is the
 * document's cached one, so evaluating those frames afterwards costs nothing more. Call it after
 * setting a start_frame (a hold's release) so the world covers it. Returns the range; null when the
 * scene has no simulated body.
 */
export function updateDeskWorldRange(doc: SceneDoc, warnings: string[]): DeskWorldRange | null {
  const scene = doc.getScene();
  const world = sanitizeRigidBodyWorld(scene.rigidbody_world);
  const starts: number[] = [];
  let withWorld = false;
  const animated: string[] = [];
  for (const o of doc.listObjects()) {
    const rb = sanitizeRigidBody(o.rigid_body);
    if (!rb || o.type !== 'MESH') continue;
    const mode = motionMode(rb);
    if (mode === 'KINEMATIC') animated.push(o.id);
    if (mode !== 'DYNAMIC') continue;
    if (rb.start_frame === null) withWorld = true;
    else starts.push(rb.start_frame);
  }
  if (!starts.length && !withWorld) {
    if (!world.enabled && animated.length) doc.updateScene({ rigidbody_world: { ...world, enabled: true } });
    return null;
  }
  const frameStart = Math.min(
    ...starts.map((s) => s - RELEASE_TRACKED_STEPS),
    withWorld ? world.frame_start : Infinity,
  );
  const lastStart = Math.max(...starts, withWorld ? frameStart + 1 : -Infinity);
  const fps = worldParams(scene).fps;
  // the bodies settle within DESK_SETTLE_MAX_SECONDS of the last release and the colliders' last move
  const moving = Math.max(lastStart + 1, animationEnd(doc, animated));
  const cap = Math.min(frameStart + MAX_SIMULATED_FRAMES, moving + Math.ceil(DESK_SETTLE_MAX_SECONDS * fps));
  doc.updateScene({ rigidbody_world: { ...world, enabled: true, frame_start: frameStart, frame_end: cap } });
  let end = cap;
  let settled = false;
  const sim = new RigidBodySimulator();
  const host = sceneSampler(doc);
  const window = Math.max(1, Math.round(SETTLE_WINDOW_SECONDS * fps));
  const history: (Map<string, Mat4> | null)[] = [];
  try {
    for (let f = frameStart + 1; f <= cap; f++) {
      const now = sim.evaluate(doc, f, host);
      history.push(now);
      if (history.length > window + 1) history.shift();
      if (f < moving || history.length <= window) continue;
      if (atRest(doc, now, history[0])) {
        end = Math.min(cap, f + SETTLE_MARGIN_FRAMES);
        settled = true;
        break;
      }
    }
  } catch (e) {
    if (!isMeshMemoryError(e)) throw e;
    end = Math.min(cap, Math.max(moving, lastStart + Math.ceil(DESK_SETTLE_FALLBACK_SECONDS * fps)));
    warnings.push(
      `the settling of the bodies could not be simulated here (${(e as Error).message}); the rigid body world ` +
        `ends ${DESK_SETTLE_FALLBACK_SECONDS} s after the last release, at frame ${end}`,
    );
  }
  if (!settled && end === cap)
    warnings.push(
      cap === frameStart + MAX_SIMULATED_FRAMES
        ? `some bodies are still moving at frame ${cap}, the ${MAX_SIMULATED_FRAMES}-frame limit of a simulation: ` +
            'the simulation holds their state from there'
        : `some bodies are still moving at frame ${cap}, ${DESK_SETTLE_MAX_SECONDS} s after the last release and ` +
            "the animated colliders' last move: the simulation holds their state from there (extend it with " +
            'rigidbody.world_set frame_end)',
    );
  doc.updateScene({
    rigidbody_world: { ...sanitizeRigidBodyWorld(doc.getScene().rigidbody_world), frame_end: end },
  });
  return { frame_start: frameStart, frame_end: end, settled };
}

// ---------------------------------------------------------------- the presets

/** Rigid bodies on `objectIds` (EMPTY model roots: their mesh part), and the ground under them. */
export function setupBodies(
  doc: SceneDoc,
  objectIds: readonly string[],
  s: DeskBodySettings & { ground?: boolean; landing?: readonly Vec3[] },
  warnings: string[],
): { bodies: string[]; ground: string | null } {
  const bodies: string[] = [];
  for (const id of objectIds) {
    const target = bodyObjectFor(doc, id, warnings);
    if (!target || bodies.includes(target)) continue;
    const o = doc.getObject(target)!;
    setBody(doc, target, bodySettings(doc, o, s));
    bodies.push(target);
  }
  let ground: string | null = null;
  if (bodies.length && s.ground !== false && s.kind !== 'passive') {
    const frame = sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).frame_start;
    ground = ensureGround(doc, bodies, s.landing ?? [], frame, warnings);
  }
  return { bodies, ground };
}

/**
 * The body object of `id` for a release preset: its existing ACTIVE body (made dynamic), else a new
 * one (setup defaults: a ball gets a SPHERE). The preset puts a ground under it afterwards, whether or
 * not it had a body (`ensureGround` at the release frame, where it lands included).
 */
function releaseBody(doc: SceneDoc, id: string, warnings: string[]): string {
  const target = bodyObjectFor(doc, id, warnings);
  const name = doc.getObject(id)?.name ?? id;
  if (!target) throw new OperatorError(`'${name}' has no mesh to simulate`, 'FAILED');
  const rb = sanitizeRigidBody(doc.getObject(target)!.rigid_body);
  if (!rb) setupBodies(doc, [target], { kind: 'active', ground: false }, warnings);
  else if (rb.type !== 'ACTIVE' || rb.kinematic || !rb.enabled)
    patchBody(doc, target, { type: 'ACTIVE', kinematic: false, enabled: true });
  return target;
}

/**
 * Lifts object `id` by `height` metres in world Z: its stored location, or every key of an animated
 * location channel, moves by the lift in its parent's space (at `frame`).
 */
function lift(doc: SceneDoc, id: string, height: number, frame: number): void {
  const o = doc.getObject(id)!;
  const fs = sceneSampler(doc).at(frame);
  const parent = parentMatrix(fs, o);
  const d = parent ? directionIn(parent, [0, 0, height]) : ([0, 0, height] as Vec3);
  const location = [...o.location] as Vec3;
  for (let i = 0; i < 3; i++) {
    if (!d[i]) continue;
    const key = fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: i });
    const fc = doc.getFCurve(key);
    if (fc && fc.keyframes.length)
      doc.setFCurve({ ...fc, keyframes: fc.keyframes.map((k) => ({ ...k, value: k.value + d[i] })) });
    else location[i] += d[i];
  }
  if (location.some((v, i) => v !== o.location[i])) doc.updateObject(id, { location });
}

/** Gives objects rigid bodies (and a ground); returns them and the ground. */
export function deskPhysicsSetupBodies(
  doc: SceneDoc,
  objectIds: readonly string[],
  s: DeskBodySettings & { ground?: boolean },
): { bodies: string[]; ground: string | null; world: DeskWorldRange | null; warnings: string[] } {
  const warnings: string[] = [];
  const { bodies, ground } = setupBodies(doc, objectIds, s, warnings);
  if (!bodies.length)
    throw new OperatorError('None of the objects has a mesh to give a rigid body', 'FAILED');
  const world = updateDeskWorldRange(doc, warnings);
  return { bodies, ground, world, warnings };
}

/** Lifts objects by `height` and releases them at `frame` (their start frame). */
export function deskDrop(
  doc: SceneDoc,
  objectIds: readonly string[],
  o: { frame: number; height?: number },
): { bodies: string[]; world: DeskWorldRange | null; warnings: string[] } {
  const warnings: string[] = [];
  const bodies: string[] = [];
  for (const id of objectIds) {
    const target = releaseBody(doc, id, warnings);
    if (bodies.includes(target)) continue;
    if (o.height) lift(doc, target, o.height, o.frame);
    patchBody(doc, target, {
      start_frame: o.frame,
      inherit_velocity: true,
      initial_linear_velocity: [0, 0, 0],
      initial_angular_velocity: [0, 0, 0],
    });
    bodies.push(target);
  }
  // a floor under them and where they come down (with the velocity of the hand that lets them go)
  const landing: Vec3[] = [];
  for (const b of bodies) {
    const p = landingPoint(doc, b, o.frame, [0, 0, 0], true);
    if (p) landing.push(p);
  }
  ensureGround(doc, bodies, landing, o.frame, warnings);
  const world = updateDeskWorldRange(doc, warnings);
  return { bodies, world, warnings };
}

/**
 * Coefficients of a free flight in the simulation's integrator (physics/world.ts: per step
 * v ← (v + g·dt)·(1 − damping)^dt, then p ← p + v·dt): after `steps` steps the centre of mass has moved
 * by A·v0 + B·g for a launch velocity v0. Exact for the discrete steps, damping included.
 */
export function flightCoefficients(
  steps: number,
  dt: number,
  linearDamping: number,
): { A: number; B: number } {
  const k = Math.pow(1 - linearDamping, dt);
  let av = 1;
  let bv = 0;
  let A = 0;
  let B = 0;
  for (let i = 0; i < steps; i++) {
    av *= k;
    bv = (bv + dt) * k;
    A += av * dt;
    B += bv * dt;
  }
  return { A, B };
}

/**
 * Launch velocity that carries a body released at frame `frame` by `displacement` metres in
 * `flightFrames` frames (fractional: between two simulated frames, as the evaluation interpolates)
 * under the world's gravity, steps and the body's linear damping, when nothing is hit on the way.
 */
export function ballisticVelocity(
  displacement: Readonly<Vec3>,
  flightFrames: number,
  p: { gravity: Readonly<Vec3>; substeps: number; dt: number; linearDamping: number },
): Vec3 {
  const whole = Math.floor(flightFrames);
  const t = flightFrames - whole;
  const c0 = flightCoefficients(whole * p.substeps, p.dt, p.linearDamping);
  const c1 = t > 0 ? flightCoefficients((whole + 1) * p.substeps, p.dt, p.linearDamping) : c0;
  const A = c0.A + (c1.A - c0.A) * t;
  const B = c0.B + (c1.B - c0.B) * t;
  if (!(A > 0))
    throw new OperatorError(
      'The simulation does not advance (time_scale 0): nothing can be thrown',
      'FAILED',
    );
  return [0, 1, 2].map((i) => (displacement[i] - B * p.gravity[i]) / A) as Vec3;
}

/** The world matrix of object `id` at a (possibly fractional) frame, simulated when it is an ACTIVE body. */
function worldAt(doc: SceneDoc, id: string, frame: number): Mat4 | null {
  const sampler = sceneSampler(doc);
  const rb = sanitizeRigidBody(doc.getObject(id)?.rigid_body);
  const simulated =
    rb?.type === 'ACTIVE' && sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).enabled
      ? new RigidBodySimulator().evaluate(doc, frame, sampler)
      : null;
  return sampler.at(frame, simulated).world(id);
}

/**
 * Releases `objectId` at `frame` with the launch velocity that lands its origin on `target` (a point,
 * or an object's origin at the landing frame) after flight_s seconds under the scene's gravity: the
 * flight is solved for the simulation's own integrator (steps, damping), so it lands within
 * millimetres when nothing is in the way. With a spin, the centre of mass lands where it would be over
 * the target in the release orientation. The prop's hand velocity is not inherited (the throw sets it).
 */
export function deskThrow(
  doc: SceneDoc,
  objectId: string,
  target: Vec3 | string,
  o: { frame: number; flight_s: number; spin?: Vec3 },
): { body: string; velocity: Vec3; landing_frame: number; world: DeskWorldRange | null; warnings: string[] } {
  const warnings: string[] = [];
  const scene = doc.getScene();
  const params = worldParams(scene);
  const flightFrames = o.flight_s * params.fps;
  const landing = o.frame + flightFrames;
  let point: Vec3;
  if (typeof target === 'string') {
    const m = worldAt(doc, target, landing);
    if (!m) throw new OperatorError(`Target '${target}' has no transform at frame ${landing}`, 'FAILED');
    point = originOf(m);
  } else point = [...target] as Vec3;
  if (!finite3(point)) throw new OperatorError('target must be three finite numbers', 'INVALID_PARAMS');
  const body = releaseBody(doc, objectId, warnings);
  const release = sceneSampler(doc).at(o.frame).world(body);
  if (!release)
    throw new OperatorError(`'${doc.getObject(body)!.name}' has no transform at frame ${o.frame}`, 'FAILED');
  const rb = sanitizeRigidBody(doc.getObject(body)!.rigid_body)!;
  const from = originOf(release);
  const velocity = ballisticVelocity(
    [point[0] - from[0], point[1] - from[1], point[2] - from[2]],
    flightFrames,
    {
      gravity: params.gravity,
      substeps: params.substeps,
      dt: params.timeScale / params.fps / params.substeps,
      linearDamping: rb.linear_damping,
    },
  );
  const fastest = Math.max(...velocity.map(Math.abs));
  if (!(fastest <= MAX_INITIAL_VELOCITY))
    throw new OperatorError(
      `Landing there after ${o.flight_s} s needs ${Math.round(fastest)} m/s (at most ${MAX_INITIAL_VELOCITY}): ` +
        'give a longer flight_s',
      'INVALID_PARAMS',
    );
  const spin = o.spin ?? [0, 0, 0];
  if (!finite3(spin) || spin.some((w) => Math.abs(w) > MAX_INITIAL_VELOCITY))
    throw new OperatorError(
      `spin must be three numbers within ±${MAX_INITIAL_VELOCITY} rad/s`,
      'INVALID_PARAMS',
    );
  patchBody(doc, body, {
    start_frame: o.frame,
    inherit_velocity: false,
    initial_linear_velocity: velocity,
    initial_angular_velocity: [...spin] as Vec3,
  });
  // a floor under the hand, the target and where the body comes down after it (a catch in the air)
  const g = params.gravity;
  const arrival = velocity.map((v, k) => v + g[k] * o.flight_s) as Vec3;
  const fall =
    -g[2] > 1e-9 ? (arrival[2] + Math.sqrt(arrival[2] ** 2 + 2 * -g[2] * Math.max(0, point[2]))) / -g[2] : 0;
  const after = Math.min(LANDING_MAX_SECONDS, Number.isFinite(fall) ? fall : 0);
  ensureGround(
    doc,
    [body],
    [point, [point[0] + arrival[0] * after, point[1] + arrival[1] * after, 0]],
    o.frame,
    warnings,
  );
  const world = updateDeskWorldRange(doc, warnings);
  return { body, velocity, landing_frame: landing, world, warnings };
}

/** Pushes `objectId` at `frame`: it starts moving along `direction` at speed_mps (added to its own motion). */
export function deskPush(
  doc: SceneDoc,
  objectId: string,
  o: { direction: Vec3; speed_mps: number; frame: number },
): { body: string; velocity: Vec3; world: DeskWorldRange | null; warnings: string[] } {
  const warnings: string[] = [];
  const len = Math.hypot(o.direction[0], o.direction[1], o.direction[2]);
  if (!(len > 1e-9) || !Number.isFinite(len))
    throw new OperatorError('direction must be a non-zero vector', 'INVALID_PARAMS');
  const velocity = o.direction.map((d) => (d / len) * o.speed_mps) as Vec3;
  if (velocity.some((v) => Math.abs(v) > MAX_INITIAL_VELOCITY))
    throw new OperatorError(`speed_mps must be at most ${MAX_INITIAL_VELOCITY}`, 'INVALID_PARAMS');
  const body = releaseBody(doc, objectId, warnings);
  patchBody(doc, body, {
    start_frame: o.frame,
    inherit_velocity: true,
    initial_linear_velocity: velocity,
    initial_angular_velocity: [0, 0, 0],
  });
  // a floor under it and where it would come down pushed off what it stands on (a table)
  const landing = landingPoint(doc, body, o.frame, velocity, true);
  ensureGround(doc, [body], landing ? [landing] : [], o.frame, warnings);
  const world = updateDeskWorldRange(doc, warnings);
  return { body, velocity, world, warnings };
}
