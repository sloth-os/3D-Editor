import type { Mat4, Vec3 } from '../../math/types';
import { compose4, invert4, multiply4 } from '../../math/mat4';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import type { FrameState } from '../../eval/frame-state';
import { OperatorError } from '../../operators/context';
import {
  baseName,
  channelsFor,
  descendants,
  keyTransforms,
  localBounds,
  originOf,
  parentMatrix,
  sceneSampler,
  transformSamples,
  writeChannel,
} from './common';

/*
 * desk.vehicle_drive (spec §4, §10 vehicle contract): a vehicle model (an EMPTY root with a body,
 * wheels `wheel.FL/FR/BL/BR` spinning about their local X with their origin at the hub, the front
 * wheels under `steer.FL/FR` pivots) driven along a smooth path through the points from where it
 * stands. The root is keyed on every frame along the path, facing along it (its front is −Y) and
 * pitched with its slope; each wheel turns by the distance its own hub rolls (along the way it points,
 * steered or not) over its radius (from its bounds), so on a curve the inner wheels turn less than the
 * outer ones; the steering pivots turn toward the path's curvature ahead (Ackermann: atan(wheelbase ·
 * curvature), at most ±35°, eased at 120°/s). The drive speeds up and slows down over up to 1.5 s at
 * its ends. The root (not the rear axle) follows the path, so on a tight curve the wheels still slide
 * a little sideways.
 */

/** Largest steering angle (rad). */
export const VEHICLE_MAX_STEER = (35 * Math.PI) / 180;
/** Fastest the steering turns (rad/s). */
const STEER_RATE = (120 * Math.PI) / 180;
/** Time to reach the cruising speed and to stop (s), at most. */
export const VEHICLE_EASE_SECONDS = 1.5;
/** Speed of a drive given neither speed_mps nor frame_end (m/s). */
export const VEHICLE_DEFAULT_MPS = 5;
/** Most frames one drive keys. */
export const VEHICLE_MAX_FRAMES = 20_000;
/** Samples of the smooth path per segment between two points. */
const PATH_SAMPLES = 48;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** `v` turned by `angle` (rad) about the unit axis `k` (Rodrigues). */
function turned(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [
    v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * kv * (1 - c),
    v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * kv * (1 - c),
    v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * kv * (1 - c),
  ];
}

/** A smooth path sampled densely by arc length (centripetal Catmull–Rom through the points). */
interface SampledPath {
  points: Vec3[];
  /** Arc length at each sample. */
  s: number[];
  length: number;
}

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  // centripetal parameterisation (alpha 0.5): no cusps or loops between close points
  const knot = (a: Vec3, b: Vec3, prev: number) => prev + Math.max(1e-6, Math.sqrt(len(sub(b, a))));
  const t0 = 0;
  const t1 = knot(p0, p1, t0);
  const t2 = knot(p1, p2, t1);
  const t3 = knot(p2, p3, t2);
  const u = t1 + (t2 - t1) * t;
  const mix = (a: Vec3, b: Vec3, ta: number, tb: number): Vec3 => {
    const w = (u - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/**
 * The path through `points` (the first is where the vehicle stands), leaving along `heading`: a
 * phantom point behind the start makes the first segment start along it, one past the end makes the
 * last end straight.
 */
export function vehiclePath(points: readonly Vec3[], heading: Vec3): SampledPath {
  const n = points.length;
  const first = len(sub(points[1], points[0]));
  const before: Vec3 = [
    points[0][0] - heading[0] * first,
    points[0][1] - heading[1] * first,
    points[0][2] - heading[2] * first,
  ];
  const after: Vec3 = [
    2 * points[n - 1][0] - points[n - 2][0],
    2 * points[n - 1][1] - points[n - 2][1],
    2 * points[n - 1][2] - points[n - 2][2],
  ];
  const ext = [before, ...points, after];
  const out: Vec3[] = [[...points[0]]];
  for (let i = 1; i < ext.length - 2; i++)
    for (let k = 1; k <= PATH_SAMPLES; k++)
      out.push(catmullRom(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], k / PATH_SAMPLES));
  const s = [0];
  for (let i = 1; i < out.length; i++) s.push(s[i - 1] + len(sub(out[i], out[i - 1])));
  return { points: out, s, length: s[s.length - 1] };
}

/** Index of the sample segment holding arc length `d` (binary search). */
function segmentAt(path: SampledPath, d: number): number {
  let lo = 0;
  let hi = path.s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path.s[mid] <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Point of the path at arc length `d` (clamped to the path). */
export function pathPoint(path: SampledPath, d: number): Vec3 {
  const x = Math.min(path.length, Math.max(0, d));
  const i = segmentAt(path, x);
  const j = Math.min(path.points.length - 1, i + 1);
  const span = path.s[j] - path.s[i];
  const t = span > 1e-12 ? (x - path.s[i]) / span : 0;
  const a = path.points[i];
  const b = path.points[j];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Unit tangent of the path at arc length `d`. */
export function pathTangent(path: SampledPath, d: number): Vec3 {
  const h = Math.min(0.05, path.length / 4);
  const a = pathPoint(path, Math.max(0, d - h));
  const b = pathPoint(path, Math.min(path.length, d + h));
  const t = sub(b, a);
  const l = len(t);
  return l > 1e-12 ? [t[0] / l, t[1] / l, t[2] / l] : [0, -1, 0];
}

/** Yaw (about +Z) that turns a −Y-facing object along horizontal direction `t`. */
const yawOf = (t: Vec3): number => Math.atan2(t[0], -t[1]);

/** Signed horizontal curvature of the path at arc length `d` (1/m; positive turns left). */
export function pathCurvature(path: SampledPath, d: number): number {
  const h = 0.25;
  const a = pathTangent(path, Math.max(0, d - h));
  const b = pathTangent(path, Math.min(path.length, d + h));
  const span = Math.min(path.length, d + h) - Math.max(0, d - h);
  if (span < 1e-6) return 0;
  let turn = yawOf(b) - yawOf(a);
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  return turn / span;
}

/**
 * Distance driven after `t` seconds of a drive of `length` metres lasting `duration` seconds: equal
 * speed-up and slow-down phases of `ease` seconds, a constant speed between.
 */
export function drivenDistance(t: number, duration: number, length: number, ease: number): number {
  if (t <= 0) return 0;
  if (t >= duration) return length;
  const e = Math.min(ease, duration / 2);
  const cruise = length / (duration - e);
  if (t < e) return (0.5 * cruise * t * t) / e;
  if (t > duration - e) {
    const r = duration - t;
    return length - (0.5 * cruise * r * r) / e;
  }
  return 0.5 * cruise * e + cruise * (t - e);
}

/** Bounds of an object and its mesh parts in the object's own (unscaled) space, from a frame state. */
function partBounds(doc: SceneDoc, fs: FrameState, o: ObjectData): { min: Vec3; max: Vec3 } | null {
  const world = fs.world(o.id);
  if (!world) return null;
  const inv = invert4(world);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const part of [o, ...descendants(doc, o.id)]) {
    const b = part.type === 'MESH' ? localBounds(doc, part) : null;
    const w = fs.world(part.id);
    if (!b || !w) continue;
    const m = multiply4(inv, w);
    for (const x of [b.min[0], b.max[0]])
      for (const y of [b.min[1], b.max[1]])
        for (const z of [b.min[2], b.max[2]]) {
          const p: Vec3 = [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ];
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[k]);
            max[k] = Math.max(max[k], p[k]);
          }
          any = true;
        }
  }
  return any ? { min, max } : null;
}

const columnLength = (m: Readonly<Mat4>, c: number): number =>
  Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);

export interface VehicleWheel {
  id: string;
  /** Wheel radius (m), from its bounds about its local X axis. */
  radius: number;
  /** +1 when the wheel's local X points along the vehicle's +X (it turns forward with a positive angle), −1 when mirrored. */
  sign: number;
  front: boolean;
  /** Where its hub is in the vehicle root's space (the point whose travel turns it). */
  hub: Vec3;
  /** Whether a steer.* pivot above it turns it (it rolls where the steering points). */
  steered: boolean;
}

/** The wheels of a vehicle model (wheel.* parts) with their radii, and its steering pivots (steer.*). */
export function vehicleRig(
  doc: SceneDoc,
  fs: FrameState,
  root: ObjectData,
): { wheels: VehicleWheel[]; steering: ObjectData[]; wheelbase: number } {
  const rootWorld = fs.world(root.id)!;
  const toRoot = invert4(rootWorld);
  const parts = descendants(doc, root.id);
  const wheels: VehicleWheel[] = [];
  const centres: { front: boolean; y: number }[] = [];
  for (const part of parts) {
    const m = /^wheel[._](.*)$/i.exec(baseName(part.name));
    if (!m) continue;
    const world = fs.world(part.id);
    const b = partBounds(doc, fs, part);
    if (!world || !b) continue;
    const radius = Math.max(
      ((b.max[1] - b.min[1]) / 2) * columnLength(world, 1),
      ((b.max[2] - b.min[2]) / 2) * columnLength(world, 2),
    );
    if (!(radius > 1e-4)) continue;
    const inRoot = multiply4(toRoot, world);
    const front = /^f/i.test(m[1]) || /front/i.test(m[1]);
    let steered = false;
    for (
      let up = part.parent ? doc.getObject(part.parent) : null, n = 0;
      up && up.id !== root.id && n < 64;
      n++
    ) {
      if (/^steer[._]/i.test(baseName(up.name))) steered = true;
      up = up.parent ? doc.getObject(up.parent) : null;
    }
    wheels.push({
      id: part.id,
      radius,
      sign: inRoot[0] >= 0 ? 1 : -1,
      front,
      hub: [inRoot[12], inRoot[13], inRoot[14]],
      steered,
    });
    centres.push({ front, y: inRoot[13] });
  }
  const steering = parts.filter((p) => /^steer[._]/i.test(baseName(p.name)));
  const fy = centres.filter((c) => c.front).map((c) => c.y);
  const by = centres.filter((c) => !c.front).map((c) => c.y);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  let wheelbase = fy.length && by.length ? Math.abs(mean(by) - mean(fy)) * columnLength(rootWorld, 1) : 0;
  if (!(wheelbase > 0.1)) {
    const b = partBounds(doc, fs, root);
    wheelbase = b ? Math.max(0.5, 0.6 * (b.max[1] - b.min[1]) * columnLength(rootWorld, 1)) : 2.5;
  }
  return { wheels, steering, wheelbase };
}

export interface VehicleResult {
  frame_end: number;
  length_m: number;
  /** Cruising speed (m/s). */
  speed_mps: number;
  wheels: VehicleWheel[];
  steering: string[];
  keyframes: number;
  warnings: string[];
}

/** Keys channel `path[index]` of `id` at `frame − 1` with its value there when it has no key before `frame`. */
function holdChannel(
  doc: SceneDoc,
  id: string,
  path: 'location' | 'rotation_euler',
  index: number,
  frame: number,
  value: number,
): void {
  const fc = doc.getFCurve(`object:${id}:${path}:${index}`);
  if (fc?.keyframes.some((k) => k.frame < frame - 1e-3)) return;
  writeChannel(doc, id, path, index, [frame - 1], [value], { interpolation: 'CONSTANT' });
}

/** Drives vehicle `vehicleId` through `points` from frame_start (see the module comment). */
export function vehicleDrive(
  doc: SceneDoc,
  vehicleId: string,
  points: readonly Vec3[],
  o: { frame_start: number; speed_mps?: number; frame_end?: number },
): VehicleResult {
  const warnings: string[] = [];
  const root = doc.getObject(vehicleId);
  if (!root) throw new OperatorError(`Object '${vehicleId}' not found`, 'NOT_FOUND');
  const fps = Math.max(1, doc.getScene().fps || 24);
  const sampler = sceneSampler(doc);
  const fs0 = sampler.at(o.frame_start);
  const world0 = fs0.world(root.id);
  if (!world0) throw new OperatorError(`'${root.name}' has no transform at frame ${o.frame_start}`, 'FAILED');
  const start = originOf(world0);
  // its heading: where its front (−Y) points, on the ground plane
  const forward: Vec3 = [-world0[4], -world0[5], 0];
  const fl = Math.hypot(forward[0], forward[1]);
  const heading: Vec3 = fl > 1e-9 ? [forward[0] / fl, forward[1] / fl, 0] : [0, -1, 0];
  const route: Vec3[] = [start];
  for (const q of points) {
    if (!q.every(Number.isFinite)) throw new OperatorError('points must be finite numbers', 'INVALID_PARAMS');
    if (len(sub(q, route[route.length - 1])) > 0.01) route.push([q[0], q[1], q[2]]);
  }
  if (route.length < 2)
    throw new OperatorError(
      'The path goes nowhere: give points away from where the vehicle stands',
      'INVALID_PARAMS',
    );
  const path = vehiclePath(route, heading);
  let duration: number;
  if (o.frame_end !== undefined) {
    if (!(o.frame_end > o.frame_start))
      throw new OperatorError(
        `frame_end (${o.frame_end}) must be after frame_start (${o.frame_start})`,
        'INVALID_PARAMS',
      );
    duration = (o.frame_end - o.frame_start) / fps;
  } else {
    const speed = o.speed_mps ?? VEHICLE_DEFAULT_MPS;
    if (o.speed_mps === undefined)
      warnings.push(`no speed_mps or frame_end: driving at ${VEHICLE_DEFAULT_MPS} m/s`);
    const ease = Math.min(VEHICLE_EASE_SECONDS, path.length / speed);
    duration = path.length / speed + ease;
  }
  const frameEnd = o.frame_end ?? o.frame_start + Math.max(1, Math.ceil(duration * fps));
  const frames = frameEnd - o.frame_start + 1;
  if (frames > VEHICLE_MAX_FRAMES)
    throw new OperatorError(
      `A drive of ${frames} frames is longer than ${VEHICLE_MAX_FRAMES}: drive faster or a shorter path`,
      'INVALID_PARAMS',
    );
  const ease = Math.min(VEHICLE_EASE_SECONDS, duration / 2);
  const cruise = path.length / (duration - ease);

  const rig = vehicleRig(doc, fs0, root);
  if (!rig.wheels.length) warnings.push(`'${root.name}' has no wheel.* parts: only the vehicle moves`);
  if (!rig.steering.length && rig.wheels.some((w) => w.front))
    warnings.push(`'${root.name}' has no steer.* pivots: its front wheels do not steer`);
  const rootScale = [...root.scale] as Vec3;
  const rootSamples = transformSamples();
  let yawPrev = Math.atan2(heading[0], -heading[1]);
  let rotation: Vec3 = [...root.rotation_euler];
  const spin = new Map<string, { frames: number[]; values: number[] }>();
  const steer = new Map<string, { frames: number[]; values: number[] }>();
  for (const w of rig.wheels) spin.set(w.id, { frames: [], values: [] });
  for (const p of rig.steering) steer.set(p.id, { frames: [], values: [] });
  const restSpin = new Map(rig.wheels.map((w) => [w.id, doc.getObject(w.id)!.rotation_euler[0]]));
  const restSteer = new Map(rig.steering.map((p) => [p.id, p.rotation_euler[2]]));
  let delta = 0;
  // each wheel's own distance rolled, where its hub was and the way it rolled at the previous frame
  const rolled = new Map(
    rig.wheels.map((w) => [w.id, { distance: 0, hub: null as Vec3 | null, way: [0, 0, 0] as Vec3 }]),
  );
  for (let i = 0; i < frames; i++) {
    const f = o.frame_start + i;
    const t = i / fps;
    const d = drivenDistance(t, duration, path.length, ease);
    const at = pathPoint(path, d);
    const tangent = pathTangent(path, d);
    // facing along the path (unwrapped), pitched with its slope
    let yaw = Math.atan2(tangent[0], -tangent[1]);
    while (yaw - yawPrev > Math.PI) yaw -= 2 * Math.PI;
    while (yaw - yawPrev < -Math.PI) yaw += 2 * Math.PI;
    yawPrev = yaw;
    const pitch = -Math.atan2(tangent[2], Math.hypot(tangent[0], tangent[1]));
    const world = compose4(at, [pitch, 0, yaw], rootScale);
    const fs = i === 0 ? fs0 : sampler.at(f);
    const keys = channelsFor(world, parentMatrix(fs, root), rootScale, rotation);
    rotation = keys.rotation_euler;
    rootSamples.frames.push(f);
    rootSamples.location.push(keys.location);
    rootSamples.rotation.push(keys.rotation_euler);
    // steering toward the curvature half a wheelbase ahead, eased
    const target = Math.max(
      -VEHICLE_MAX_STEER,
      Math.min(VEHICLE_MAX_STEER, Math.atan(rig.wheelbase * pathCurvature(path, d + rig.wheelbase / 2))),
    );
    const step = STEER_RATE / fps;
    delta = i === 0 ? target : delta + Math.max(-step, Math.min(step, target - delta));
    for (const p of rig.steering) {
      const s = steer.get(p.id)!;
      s.frames.push(f);
      s.values.push(restSteer.get(p.id)! + delta);
    }
    // each wheel turns by the distance its own hub travels the way it rolls (its front, −Y, turned by the
    // steering above it): on a curve the inner wheels roll less than the outer ones, none of them slides
    const front = unit([-world[4], -world[5], -world[6]]);
    const up = unit([world[8], world[9], world[10]]);
    for (const w of rig.wheels) {
      const r = rolled.get(w.id)!;
      const hub: Vec3 = [
        world[0] * w.hub[0] + world[4] * w.hub[1] + world[8] * w.hub[2] + world[12],
        world[1] * w.hub[0] + world[5] * w.hub[1] + world[9] * w.hub[2] + world[13],
        world[2] * w.hub[0] + world[6] * w.hub[1] + world[10] * w.hub[2] + world[14],
      ];
      const way = w.steered && rig.steering.length ? turned(front, up, delta) : front;
      if (r.hub) {
        const along = unit([r.way[0] + way[0], r.way[1] + way[1], r.way[2] + way[2]]);
        const moved = sub(hub, r.hub);
        r.distance += moved[0] * along[0] + moved[1] * along[1] + moved[2] * along[2];
      }
      r.hub = hub;
      r.way = way;
      const s = spin.get(w.id)!;
      s.frames.push(f);
      s.values.push(restSpin.get(w.id)! + (w.sign * r.distance) / w.radius);
    }
  }
  // before the drive everything keeps its own transform
  const fsBefore = sampler.at(o.frame_start - 1);
  const rootBefore = fsBefore.byId.get(root.id) ?? root;
  for (let k = 0; k < 3; k++) {
    holdChannel(doc, root.id, 'location', k, o.frame_start, rootBefore.location[k]);
    holdChannel(doc, root.id, 'rotation_euler', k, o.frame_start, rootBefore.rotation_euler[k]);
  }
  let keyframes = keyTransforms(doc, root.id, rootSamples, { clean: true });
  for (const w of rig.wheels) {
    const s = spin.get(w.id)!;
    holdChannel(
      doc,
      w.id,
      'rotation_euler',
      0,
      o.frame_start,
      fsBefore.byId.get(w.id)?.rotation_euler[0] ?? restSpin.get(w.id)!,
    );
    keyframes += writeChannel(doc, w.id, 'rotation_euler', 0, s.frames, s.values, { clean: true });
  }
  for (const p of rig.steering) {
    const s = steer.get(p.id)!;
    holdChannel(
      doc,
      p.id,
      'rotation_euler',
      2,
      o.frame_start,
      fsBefore.byId.get(p.id)?.rotation_euler[2] ?? restSteer.get(p.id)!,
    );
    keyframes += writeChannel(doc, p.id, 'rotation_euler', 2, s.frames, s.values, { clean: true });
  }
  return {
    frame_end: frameEnd,
    length_m: path.length,
    speed_mps: cruise,
    wheels: rig.wheels,
    steering: rig.steering.map((p) => p.id),
    keyframes,
    warnings,
  };
}
