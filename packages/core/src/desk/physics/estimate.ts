import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import type { OperatorContext } from '../../operators/context';
import {
  OPERATOR_FIXED_BYTES,
  keyframeEstimate,
  withObjects,
  type OperatorEstimate,
} from '../../operators/memory-base';
import { FRAME_STATE_BYTES_PER_OBJECT, newKeyframesWrites } from '../../operators/memory-keyframes';
import {
  SIMULATION_BYTES_PER_KINEMATIC_FRAME,
  documentSimulationBodies,
  simulationCacheBytes,
} from '../../physics/memory';
import { rigidBodyCacheBytes } from '../../physics/rigid-body';
import {
  MAX_SIMULATED_FRAMES,
  RELEASE_TRACKED_STEPS,
  motionMode,
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  worldParams,
} from '../../physics/settings';
import { deskBakePlan, deskSimulationEnd } from './bake';
import { DESK_SETTLE_MAX_SECONDS } from './presets';
import {
  TETHER_MAX_FRAMES,
  TETHER_TAIL_SEGMENTS,
  TETHER_TAIL_SETTLE_SECONDS,
  tetherLandFrames,
} from './tether';
import { VEHICLE_DEFAULT_MPS, VEHICLE_EASE_SECONDS, VEHICLE_MAX_FRAMES, vehiclePath } from './vehicle';

/*
 * Memory estimates of the desk's motion presets (operators/desk-motion.ts), counted from the document
 * and the parameters without running them; operators/memory-desk.ts DESK_MOTION_ESTIMATES calls them.
 * Upper bounds of what the presets do:
 *  - a release (desk.physics_setup, _drop, _throw, _push) simulates the rigid body world from
 *    RELEASE_TRACKED_STEPS frames before the first release until its bodies have come to rest, at most
 *    DESK_SETTLE_MAX_SECONDS after the last release and the animated colliders' last move (presets.ts
 *    updateDeskWorldRange); the document's cache keeps those frames (physics/memory.ts) and the
 *    matrices a body records on the frames before its release; a drop with a height rewrites the
 *    lifted location keys;
 *  - a bake keys the location and rotation (and the scale of a carrier that loses its parent or is a
 *    store model's root) of each body's carrier on every frame from its release (or the start of its
 *    hold) to the end (bake.ts deskBakePlan), stepping the world where its cache has no frames;
 *  - a flight keys the flyer, its string (location, rotation and scale) and its tail on every frame,
 *    and of a landing after it; hiding them after it keys their scale twice more;
 *  - a drive keys the vehicle, the spin of each wheel and the turn of each steering pivot on every
 *    frame of its path.
 */

/**
 * Peak heap per simulated body and frame the world steps (its contacts and solver arrays, the poses a
 * release's settling compares): 0.9 KB measured (40 balls bouncing for 99 frames, re-simulated by a
 * bake), rounded up.
 */
export const DESK_SETTLE_BYTES_PER_BODY_FRAME = 1_200;

/** Peak heap per baked body and frame besides its keyframes: its sampled matrix and channel values. */
export const DESK_BAKE_BYTES_PER_BODY_FRAME = 200;

/**
 * Peak heap per keyed object and frame of a flight besides its keyframes: the matrices of the flyer and
 * its tail, the string's samples and the integration's garbage (about 1 KB measured), rounded up.
 */
export const TETHER_BYTES_PER_OBJECT_FRAME = 1_200;

/** Peak heap per keyed object and frame of a drive besides its keyframes (under 0.1 KB measured), rounded up. */
export const VEHICLE_BYTES_PER_OBJECT_FRAME = 300;

const BODY_LOWER = 'the number of objects (objects)';
const BAKE_LOWER = 'the frame range (frame_start to frame_end) or the number of bodies to bake (objects)';
const TETHER_LOWER = 'the frame range (frame_start to frame_end), or fly without the tail (tail: false)';
const VEHICLE_LOWER = 'the length of the drive (frame_end, a higher speed_mps or a shorter path)';

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** The object `ref` names (an id or a name), or null. */
function objectOf(doc: SceneDoc, ref: unknown): ObjectData | null {
  if (typeof ref !== 'string') return null;
  return doc.getObject(ref) ?? doc.resolveObject(ref);
}

/** The objects `refs` names, each once (unknown ones left out: the operator reports them). */
function objectsOf(doc: SceneDoc, refs: unknown): ObjectData[] {
  const out = new Map<string, ObjectData>();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const o = objectOf(doc, ref);
    if (o) out.set(o.id, o);
  }
  return [...out.values()];
}

/** `ids` and every object below them. */
function withDescendants(doc: SceneDoc, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const children = new Map<string, string[]>();
  for (const o of doc.listObjects())
    if (o.parent) {
      const list = children.get(o.parent);
      if (list) list.push(o.id);
      else children.set(o.parent, [o.id]);
    }
  const queue = [...out];
  while (queue.length)
    for (const c of children.get(queue.pop()!) ?? [])
      if (!out.has(c)) {
        out.add(c);
        queue.push(c);
      }
  return out;
}

/** Keyframes the F-curves of objects `ids` hold, and the latest frame of any object key (−∞: none). */
function objectKeys(doc: SceneDoc, ids: ReadonlySet<string>): { keys: number; last: number } {
  let keys = 0;
  let last = -Infinity;
  for (const fc of doc.listFCurves()) {
    if (fc.target_type !== 'object') continue;
    for (const k of fc.keyframes) last = Math.max(last, k.frame);
    if (ids.has(fc.target_id)) keys += fc.keyframes.length;
  }
  return { keys, last };
}

/** How a release preset changes the rigid body world: `count` bodies of `kind`, released at `start` (null: with the world). */
export interface DeskRelease {
  count: number;
  kind: 'active' | 'passive' | 'animated';
  start: number | null;
}

/**
 * The settling run of a release (presets.ts updateDeskWorldRange): the frames the world simulates at
 * most (its new range), the bodies it moves, the bytes its cache keeps, and the body frames whose
 * transforms it reads from the scene (animated bodies, bodies before their release).
 */
export function deskSettleSimulation(
  doc: SceneDoc,
  r: DeskRelease,
): { frames: number; bodies: number; bytes: number; read: number } {
  const scene = doc.getScene();
  const world = sanitizeRigidBodyWorld(scene.rigidbody_world);
  let simulated = 0;
  let kinematic = 0;
  let withWorld = false;
  const starts: number[] = [];
  for (const o of doc.listObjects()) {
    const rb = o.type === 'MESH' ? sanitizeRigidBody(o.rigid_body) : null;
    if (!rb) continue;
    const mode = motionMode(rb);
    if (mode === 'KINEMATIC') kinematic++;
    else if (mode === 'DYNAMIC' || mode === 'FROZEN') simulated++;
    if (mode !== 'DYNAMIC') continue;
    if (rb.start_frame === null) withWorld = true;
    else starts.push(rb.start_frame);
  }
  const count = Math.max(0, Math.floor(r.count));
  if (r.kind === 'animated') kinematic += count;
  else if (r.kind === 'active') {
    simulated += count;
    for (let i = 0; i < count; i++) {
      if (r.start === null) withWorld = true;
      else starts.push(r.start);
    }
  }
  if (!simulated) return { frames: 0, bodies: 0, bytes: 0, read: 0 };
  const fps = worldParams(scene).fps;
  const frameStart = Math.min(
    ...starts.map((s) => s - RELEASE_TRACKED_STEPS),
    withWorld ? world.frame_start : Infinity,
  );
  const lastStart = Math.max(...starts, withWorld ? frameStart + 1 : -Infinity);
  const moving = Math.max(lastStart + 1, kinematic ? objectKeys(doc, new Set()).last : -Infinity);
  const cap = Math.min(frameStart + MAX_SIMULATED_FRAMES, moving + Math.ceil(DESK_SETTLE_MAX_SECONDS * fps));
  const frames = Math.max(0, cap - frameStart);
  // a body follows (and records) the matrix of its animation on the RELEASE_TRACKED_STEPS frames before
  // its release and at it (physics/simulation.ts), dormant before
  let delayed = 0;
  for (const s of starts)
    delayed += Math.max(0, Math.min(s, cap) - Math.max(frameStart + 1, s - RELEASE_TRACKED_STEPS) + 1);
  return {
    frames,
    bodies: simulated,
    bytes:
      simulationCacheBytes({ simulated, kinematic }, frames) + SIMULATION_BYTES_PER_KINEMATIC_FRAME * delayed,
    read: kinematic * frames + delayed,
  };
}

/**
 * desk.physics_setup, _drop, _throw and _push: the bodies' settling run (its cache kept), a ground
 * collider, and for a drop with a height the lifted location keys rewritten. Null when no object is
 * named (the operator fails by itself).
 */
export function deskReleaseEstimate(
  ctx: OperatorContext,
  op: 'setup' | 'drop' | 'throw' | 'push',
  p: Record<string, unknown>,
): OperatorEstimate | null {
  const doc = ctx.doc;
  const objects = op === 'setup' || op === 'drop' ? objectsOf(doc, p.objects) : objectsOf(doc, [p.object]);
  if (!objects.length) return null;
  const kind = op === 'setup' && (p.kind === 'passive' || p.kind === 'animated') ? p.kind : 'active';
  const sim = deskSettleSimulation(doc, {
    count: objects.length,
    kind,
    start:
      op === 'setup'
        ? null
        : num(p.frame, sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).frame_start),
  });
  const rewritten =
    op === 'drop' && num(p.height, 0) !== 0
      ? objectKeys(
          doc,
          withDescendants(
            doc,
            objects.map((o) => o.id),
          ),
        ).keys
      : 0;
  const keys = rewritten ? newKeyframesWrites(0, 0, BODY_LOWER, rewritten) : null;
  const kept = Math.max(0, sim.bytes - rigidBodyCacheBytes(doc));
  const base: OperatorEstimate = {
    bytes:
      OPERATOR_FIXED_BYTES +
      (keys?.bytes ?? 0) +
      sim.bytes +
      DESK_SETTLE_BYTES_PER_BODY_FRAME * sim.bodies * sim.frames +
      FRAME_STATE_BYTES_PER_OBJECT * sim.read,
    faces: 0,
    addedStoredBytes: kept,
    ...(kept > 0 ? { simulationBytes: kept } : {}),
    lower: BODY_LOWER,
  };
  // a ground plane when none is under the bodies (setup: unless ground is false; passive bodies need none)
  const ground = (op !== 'setup' || p.ground !== false) && kind !== 'passive';
  return ground ? withObjects(base, { objects: 1, datablocks: { meshes: 1 } }, BODY_LOWER) : base;
}

/**
 * desk.physics_bake: six keyframes per baked body and frame on its carrier (the body, or the root of
 * the store model it carries), nine for a carrier that loses its parent or a model's root (its scale
 * too, keyed when a hold scaled it), from its release, hold or parent's motion to the end (the bake
 * drops the redundant ones, which cannot be known before), and a key per channel holding the body a
 * root carries in it; the keys those objects hold rewritten, and the world stepped over the range (as
 * if nothing were cached: a cache made stale by an edit is simulated again). Null when the bake fails
 * by itself (bake.ts deskBakePlan refuses it: no world, a bad range, over the
 * DESK_BAKE_MAX_BODY_FRAMES budget).
 */
export function deskBakeEstimate(ctx: OperatorContext, p: Record<string, unknown>): OperatorEstimate | null {
  const doc = ctx.doc;
  const named =
    Array.isArray(p.objects) && p.objects.length ? objectsOf(doc, p.objects).map((o) => o.id) : undefined;
  let plan: ReturnType<typeof deskBakePlan>;
  try {
    plan = deskBakePlan(doc, {
      frame_start: typeof p.frame_start === 'number' ? p.frame_start : undefined,
      frame_end: typeof p.frame_end === 'number' ? p.frame_end : undefined,
      objects: named,
    });
  } catch {
    return null;
  }
  if (!plan.bodies.length) return null;
  const ids = new Set(plan.bodies.flatMap((b) => [b.id, b.carrier]));
  // location and rotation, and the scale of a carrier that loses its parent or is a model's root
  const channels = (b: (typeof plan.bodies)[number]) => (b.unparent || b.carrier !== b.id ? 9 : 6);
  // the body a model's root carries: at most a key per channel where it holds from the bake's start
  const held = (b: (typeof plan.bodies)[number]) => (b.carrier !== b.id ? 9 : 0);
  const keys = newKeyframesWrites(
    plan.bodies.reduce((n, b) => n + channels(b) * (plan.frame_end - b.from + 1) + held(b), 0),
    plan.bodies.reduce((n, b) => n + channels(b) + held(b), 0),
    BAKE_LOWER,
    objectKeys(doc, ids).keys,
  );
  const params = worldParams(doc.getScene());
  const stepped = Math.max(0, Math.min(plan.frame_end, deskSimulationEnd(doc, params)) - params.frameStart);
  const bodies = documentSimulationBodies(doc);
  const simulation = simulationCacheBytes(bodies, stepped);
  return keyframeEstimate({
    ...keys,
    bytes:
      keys.bytes +
      DESK_BAKE_BYTES_PER_BODY_FRAME * plan.body_frames +
      simulation +
      DESK_SETTLE_BYTES_PER_BODY_FRAME * bodies.simulated * stepped,
    simulation: Math.max(0, simulation - rigidBodyCacheBytes(doc)),
  });
}

/** Objects a flight keys (the flyer, its string, its tail segments), their channels, and those it adds. */
export function deskTetherObjects(
  doc: SceneDoc,
  p: Record<string, unknown>,
): { channels: number; objects: number; added: number; rewritten: number } | null {
  const flyer = objectOf(doc, p.flyer);
  if (!flyer) return null;
  const parts = withDescendants(doc, [flyer.id]);
  // the keys of the flyer, its parts and an earlier flight's string and tail are rewritten
  const keyed = new Set(parts);
  let ownTail = 0;
  let string = false;
  let tail = 0;
  for (const o of doc.listObjects()) {
    if (parts.has(o.id) && o.id !== flyer.id && /^tail/i.test(o.name)) ownTail++;
    if (o.custom_props?.desk_string_to === flyer.id) {
      string = true;
      keyed.add(o.id);
    }
    if (o.custom_props?.desk_tail_of === flyer.id) {
      tail++;
      keyed.add(o.id);
    }
  }
  const wantString = p.string !== false;
  const own = p.tail !== false && ownTail >= 2;
  const segments = p.tail === false ? 0 : own ? ownTail - 1 : TETHER_TAIL_SEGMENTS;
  // the flyer and an own tail part: location and rotation; the string and a new segment: and scale
  const channels = 6 + (wantString ? 9 : 0) + segments * (own ? 6 : 9);
  const added = (wantString && !string ? 1 : 0) + (own ? 0 : Math.max(0, segments - tail));
  return {
    channels,
    objects: 1 + (wantString ? 1 : 0) + segments,
    added,
    rewritten: objectKeys(doc, keyed).keys,
  };
}

/**
 * desk.tether_fly: every keyed channel on every frame of the flight (and of a landing, after: 'land'),
 * a key before it, and the keys that hide the flyer, its string and its tail after it (after: 'hide';
 * the flyer's scale then too). Null when it fails by itself.
 */
export function deskTetherEstimate(
  ctx: OperatorContext,
  p: Record<string, unknown>,
): OperatorEstimate | null {
  const frames = Math.floor(num(p.frame_end, 0) - num(p.frame_start, 0)) + 1;
  if (!(frames >= 2) || frames > TETHER_MAX_FRAMES) return null;
  const t = deskTetherObjects(ctx.doc, p);
  if (!t) return null;
  const fps = Math.max(1, num(ctx.doc.getScene().fps, 24));
  // a landing (the longest it can take: from as high as the string reaches above the anchor) and the
  // tail settling after it, keyed for every object: an upper bound
  const anchor = objectOf(ctx.doc, p.anchor);
  const landing =
    p.after === 'land'
      ? tetherLandFrames(
          ctx.doc,
          anchor?.id ?? '',
          typeof p.anchor_bone === 'string' ? p.anchor_bone : undefined,
          Math.floor(num(p.frame_end, 0)),
          num(p.length_m, 0),
          fps,
        ) + Math.round(TETHER_TAIL_SETTLE_SECONDS * fps)
      : 0;
  // the flyer's scale channels, keyed twice to hide it (the string's and the tail's scale channels
  // are among their channels, whose budget of frames + 1 keys already holds two more)
  const hide = p.after === 'hide' ? 3 : 0;
  // every frame, and the key held (or hiding) before the flight
  const keys = newKeyframesWrites(
    t.channels * (frames + landing + 1) + 2 * hide,
    t.channels + hide,
    TETHER_LOWER,
    t.rewritten,
  );
  const e = keyframeEstimate({
    ...keys,
    bytes: keys.bytes + TETHER_BYTES_PER_OBJECT_FRAME * t.objects * (frames + landing),
  });
  return t.added ? withObjects(e, { objects: t.added, datablocks: { meshes: t.added } }, TETHER_LOWER) : e;
}

/**
 * desk.vehicle_drive: the frames of the drive, from frame_end, else as vehicle.ts drives it: the length
 * of the smooth path through the points from where the vehicle stands, at speed_mps, eased at both
 * ends. Null without a point away from the vehicle.
 */
export function deskVehicleFrames(
  doc: SceneDoc,
  vehicle: ObjectData,
  p: Record<string, unknown>,
): number | null {
  if (typeof p.frame_end === 'number' && typeof p.frame_start === 'number')
    return Math.floor(p.frame_end - p.frame_start) + 1;
  const route: Vec3[] = [[...vehicle.location] as Vec3];
  for (const q of Array.isArray(p.points) ? p.points : []) {
    if (!Array.isArray(q) || q.length !== 3 || !q.every((x) => typeof x === 'number' && Number.isFinite(x)))
      continue;
    const last = route[route.length - 1];
    if (Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) > 0.01) route.push([q[0], q[1], q[2]]);
  }
  if (route.length < 2) return null;
  // its front (−Y) turned by its own yaw (the drive reads it from the evaluated scene)
  const yaw = vehicle.rotation_euler[2];
  const length = vehiclePath(route, [Math.sin(yaw), -Math.cos(yaw), 0]).length;
  const speed = Math.max(1e-3, num(p.speed_mps, VEHICLE_DEFAULT_MPS));
  const fps = Math.max(1, num(doc.getScene().fps, 24));
  const seconds = length / speed + Math.min(VEHICLE_EASE_SECONDS, length / speed);
  return Math.max(1, Math.ceil(seconds * fps)) + 1;
}

/** desk.vehicle_drive: the vehicle, its wheels' spin and its steering keyed on every frame. Null when it fails by itself. */
export function deskVehicleEstimate(
  ctx: OperatorContext,
  p: Record<string, unknown>,
): OperatorEstimate | null {
  const doc = ctx.doc;
  const vehicle = objectOf(doc, p.vehicle);
  if (!vehicle) return null;
  const frames = deskVehicleFrames(doc, vehicle, p);
  if (frames === null || !(frames >= 1) || frames > VEHICLE_MAX_FRAMES) return null;
  const parts = withDescendants(doc, [vehicle.id]);
  let rigged = 0;
  for (const id of parts) if (/^(wheel|steer)[._]/i.test(doc.getObject(id)?.name ?? '')) rigged++;
  const channels = 6 + rigged;
  const keys = newKeyframesWrites(
    channels * (frames + 1),
    channels,
    VEHICLE_LOWER,
    objectKeys(doc, parts).keys,
  );
  return keyframeEstimate({
    ...keys,
    bytes: keys.bytes + VEHICLE_BYTES_PER_OBJECT_FRAME * (1 + rigged) * frames,
  });
}
