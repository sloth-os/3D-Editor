import type { Mat4, Vec3 } from '../../math/types';
import { compose4, identity4, invert4, multiply4 } from '../../math/mat4';
import { transformDirection3, transformPoint3 } from '../../math/vec3';
import type { Interpolation, ObjectData, PoseBone } from '../../doc/types';
import type { SceneDoc } from '../../doc/scene-doc';
import { computePose } from '../../armature/pose';
import type { ArmaturePose } from '../../armature/types';
import { compatibleEuler } from '../../constraints/math';
import { FrameState } from '../../eval/frame-state';
import { OperatorError } from '../../operators/context';
import { blueprintFor, isHumanoidKind, posedBones, requireBuiltKind, requirePose } from './kinds';
import { KeyWriter, bonePath, nextKey } from './keys';
import { poseBones } from './poses';
import {
  bezier3,
  gaitDef,
  gaitSpeed,
  gaitStride,
  legFrame,
  legRigs,
  moveTiming,
  smooth,
  solveLeg,
  turnRounds,
  type GaitDef,
  type GaitName,
  type LegRig,
} from './gait';
import { DEG, requireActor, restMatrices } from './rig';
import type { ActorKind } from './types';

/*
 * Locomotion (spec §8). An actor moves along a path by keying its armature OBJECT (location and
 * heading, rotation_euler[2]); its `root` bone stays at rest, so the object's transform is where
 * the actor is. The legs are keyed for every cycle of the gait from footsteps planned along the
 * path: each foot is planted at a footstep while the body passes over it and swings to the next,
 * and the joint angles at every key come from the leg IK (gait.ts), so stride = speed / cadence
 * and a planted foot stays put. The body accelerates and stops smoothly; the gait blends in from
 * the pose the actor stands in and, once the last steps have closed beside each other after the
 * arrival, into the end pose. A path that turns back on itself (a corner sharper than
 * SHARP_CORNER) is walked as moves that stop there and turn on the spot. A turn on the spot steps
 * round in rounds of one step per foot, the body facing the mean of its feet, so no planted foot is
 * dragged round; faceTo turns a standing actor that way too. Without face_path the body keeps its
 * heading and the footsteps are laid out in its own frame (backwards, sideways).
 */

/** A polyline path (world space) measured by arc length. */
export class PolyPath {
  readonly pts: Vec3[];
  readonly cum: number[];
  readonly length: number;

  constructor(points: readonly Vec3[]) {
    const pts: Vec3[] = [];
    for (const p of points) {
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-4) pts.push([p[0], p[1], p[2]]);
    }
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  private seg(s: number): number {
    const c = this.cum;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m;
      else hi = m;
    }
    return Math.min(lo, Math.max(0, this.pts.length - 2));
  }

  /** Point at arc length s (clamped to the path). */
  at(s: number): Vec3 {
    if (this.pts.length === 1) return [...this.pts[0]] as Vec3;
    const x = Math.max(0, Math.min(this.length, s));
    const i = this.seg(x);
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const l = this.cum[i + 1] - this.cum[i];
    const t = l > 0 ? (x - this.cum[i]) / l : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /** Horizontal unit tangent at s (beyond the ends: the end segments'). */
  tangent(s: number): Vec3 {
    if (this.pts.length < 2) return [0, -1, 0];
    const i = this.seg(Math.max(0, Math.min(this.length, s)));
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return l > 1e-9 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l, 0] : [0, -1, 0];
  }

  /** Heading (radians, 0 faces −Y) averaged over ±w around s, so corners are rounded. */
  heading(s: number, w: number): number {
    let x = 0;
    let y = 0;
    for (let k = -4; k <= 4; k++) {
      const t = this.tangent(s + (k / 4) * w);
      const wt = 1 - Math.abs(k) / 5;
      x += t[0] * wt;
      y += t[1] * wt;
    }
    return yawOf([x, y, 0]);
  }
}

/**
 * `pts` with each corner rounded by a circular arc of radius `r` (smaller where a segment beside it
 * is short: an arc takes at most 40% of each), sampled every 10° or less; the end points stay.
 */
export function roundCorners(pts: readonly Vec3[], r: number): Vec3[] {
  const out: Vec3[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const b = pts[i];
    const a = pts[i - 1];
    const c = pts[i + 1];
    const la = a ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    const lc = c ? Math.hypot(c[0] - b[0], c[1] - b[1]) : 0;
    if (!a || !c || !(r > 0) || la < 1e-6 || lc < 1e-6) {
      out.push([b[0], b[1], b[2]]);
      continue;
    }
    const u = [(b[0] - a[0]) / la, (b[1] - a[1]) / la];
    const v = [(c[0] - b[0]) / lc, (c[1] - b[1]) / lc];
    const cross = u[0] * v[1] - u[1] * v[0];
    const turn = Math.atan2(Math.abs(cross), u[0] * v[0] + u[1] * v[1]);
    // straight on, or turning back (an arc cannot round a U-turn within the segments)
    if (turn < DEG || turn > 170 * DEG) {
      out.push([b[0], b[1], b[2]]);
      continue;
    }
    const half = Math.tan(turn / 2);
    const t = Math.min(r * half, 0.4 * la, 0.4 * lc);
    const rr = t / half;
    const side = Math.sign(cross);
    // the arc from t before the corner to t after it, about a centre on the inside of the turn
    const p1 = [b[0] - u[0] * t, b[1] - u[1] * t];
    const cx = p1[0] - side * u[1] * rr;
    const cy = p1[1] + side * u[0] * rr;
    const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
    const z1 = b[2] + (a[2] - b[2]) * (t / la);
    const z2 = b[2] + (c[2] - b[2]) * (t / lc);
    const m = Math.max(2, Math.ceil(turn / (10 * DEG)));
    for (let k = 0; k <= m; k++) {
      const ang = a0 + (side * turn * k) / m;
      out.push([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang), z1 + ((z2 - z1) * k) / m]);
    }
  }
  return out;
}

/** Heading of a horizontal direction: 0 faces −Y, +90° faces +X. */
export function yawOf(d: Readonly<Vec3>): number {
  return Math.atan2(d[0], -d[1]);
}

/** The direction an actor with heading `yaw` faces. */
export function facingOf(yaw: number): Vec3 {
  return [Math.sin(yaw), -Math.cos(yaw), 0];
}

/** `a` moved by whole turns to within half a turn of `ref`. */
export function nearAngle(a: number, ref: number): number {
  return a + 2 * Math.PI * Math.round((ref - a) / (2 * Math.PI));
}

/** Speed profile: accelerate over `ta`, cruise at `v`, stop over `ta`; length L. */
export class Timing {
  constructor(
    readonly L: number,
    readonly v: number,
    readonly ta: number,
  ) {}
  get T(): number {
    return this.L / this.v + this.ta;
  }
  s(t: number): number {
    const { L, v, ta } = this;
    const T = this.T;
    if (t <= 0) return 0;
    if (t >= T) return L;
    if (ta > 0 && t < ta) return (v * t * t) / (2 * ta);
    if (ta > 0 && t > T - ta) return L - (v * (T - t) * (T - t)) / (2 * ta);
    return v * (t - ta / 2);
  }
  tOf(s: number): number {
    const { L, v, ta } = this;
    if (s <= 0) return 0;
    if (s >= L) return this.T;
    const ramp = (v * ta) / 2;
    if (ta > 0 && s < ramp) return Math.sqrt((2 * ta * s) / v);
    if (ta > 0 && s > L - ramp) return this.T - Math.sqrt((2 * ta * (L - s)) / v);
    return s / v + ta / 2;
  }
}

// ---------------------------------------------------------------- footsteps

/** One planted stretch of a foot: from contact to lift-off (gait phases), at a footprint. */
export interface Stance {
  /** Phase of contact (−Infinity: planted since the start). */
  contact: number;
  /** The gait's contact phase of this stance (times the heel and toe rolls). */
  nominal: number;
  /** Phase of lift-off (Infinity: the last footstep). */
  lift: number;
  /** Path distance of the footstep (the body centre is above it at the gait's `mid` phase). */
  s: number;
  /** Planted where the actor stands at the start (no heel roll). */
  start: boolean;
  final: boolean;
}

/** Where a planted foot is when flat: its end (ankle, fetlock), foot and toe directions, forward. */
interface Footprint {
  end: Vec3;
  dir: Vec3;
  toeDir: Vec3 | null;
  fwd: Vec3;
}

/** One step of a turn on the spot: a foot swings from τ = a to b, from one heading's footprint to another's. */
interface TurnStep {
  a: number;
  b: number;
  from: number;
  to: number;
}

/** Where in a step of a turn on the spot (fractions of its swing) the leg is keyed. */
export const TURN_STEP_KEYS = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1] as const;

/** Least swing height (fraction of the leg length) of a short swing, so that it reads as a step. */
const MIN_LIFT = 0.08;

/** Rest geometry of a foot (character space; forward = −Y, up = +Z). */
interface FootGeom {
  /** Footstep offsets of the leg root from the body centre: forward and lateral. */
  fwd: number;
  lat: number;
  /** End (ankle, fetlock) height when flat; the foot's rest direction (forward, up) and length. */
  endZ: number;
  dir: [number, number];
  len: number;
  /** Quadrupeds: offsets of the foot tip (hoof, paw) from the leg root. */
  tipF: number;
  tipL: number;
  /** Heel pivot behind the end (humanoids' heel roll; 0: none). */
  heelBack: number;
  /** Toe-roll pivot (the ball of a foot, the tip of a hoof) ahead of the end, and its height. */
  ballFwd: number;
  ballZ: number;
  /** Humanoids: the toe bone's rest direction (forward, up). */
  toeDir: [number, number] | null;
}

interface FootPose {
  end: Vec3;
  dir: Vec3;
  toeDir: Vec3 | null;
  /** The foot's heading along the ground. */
  fwd: Vec3;
  planted: boolean;
}

const rot2 = (f: number, u: number, a: number): [number, number] => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [f * c - u * s, f * s + u * c];
};

/** `d` pitched by `a` in the vertical plane of the horizontal direction `fwd` (+ tips forward up). */
function pitched(d: Readonly<Vec3>, fwd: Readonly<Vec3>, a: number): Vec3 {
  const f = d[0] * fwd[0] + d[1] * fwd[1];
  const [f2, u2] = rot2(f, d[2], a);
  return [d[0] + fwd[0] * (f2 - f), d[1] + fwd[1] * (f2 - f), u2];
}

/**
 * A footprint rolled by `pitch`: toe up about the heel (+, after contact) or heel up about the ball
 * or the hoof's tip (−, before lift-off); the toe stays flat while the heel is up.
 */
function rolled(fp: Footprint, gm: FootGeom, pitch: number): FootPose {
  if (pitch === 0) return { end: fp.end, dir: fp.dir, toeDir: fp.toeDir, fwd: fp.fwd, planted: true };
  const [pf, pu] = pitch > 0 ? [-gm.heelBack, -gm.endZ] : [gm.ballFwd, gm.ballZ - gm.endZ];
  const [rf, ru] = rot2(-pf, -pu, pitch);
  const f = fp.fwd;
  return {
    end: [fp.end[0] + f[0] * (pf + rf), fp.end[1] + f[1] * (pf + rf), fp.end[2] + pu + ru],
    dir: pitched(fp.dir, f, pitch),
    toeDir: fp.toeDir && pitch > 0 ? pitched(fp.toeDir, f, pitch) : fp.toeDir,
    fwd: f,
    planted: true,
  };
}

export interface MoveOptions {
  frame_start: number;
  speed_mps?: number;
  frame_end?: number;
  gait?: string;
  face_path?: boolean;
  end_pose?: string;
}

export interface MoveResult {
  /** Frame the actor reaches the last point. */
  frame_end: number;
  length_m: number;
  gait: GaitName | null;
  speed_mps: number;
  /** Last keyed frame: the last steps close and the end pose is reached after frame_end. */
  frame_settled: number;
  keys: number;
}

/** Body channels of a humanoid gait at phase Φ (radians, bone-local). */
function humanBody(g: GaitDef, phi: number): Record<string, Vec3> {
  const c = Math.cos(2 * Math.PI * phi);
  const arm = g.armSwing * DEG;
  const out: Record<string, Vec3> = {};
  // the left foot lands at phase 0 with the left arm back and the right arm forward
  for (const [s, k] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    const fwd = k * c;
    const outSign = s === 'L' ? -1 : 1;
    out[`upper_arm.${s}`] = [-arm * fwd, 0, outSign * g.armOut * DEG];
    out[`forearm.${s}`] = [-(g.elbow + 10 * Math.max(0, fwd)) * DEG, 0, 0];
    out[`hand.${s}`] = [-6 * DEG, 0, 0];
    out[`shoulder.${s}`] = [0, 0, 0];
  }
  const twist = g.twist * DEG * c;
  out.hips = [0, -0.4 * twist, 0];
  out.spine = [g.lean * 0.45 * DEG, 0.4 * twist, 0];
  out.chest = [g.lean * 0.55 * DEG, 0.6 * twist, 0];
  out.neck = [-g.lean * 0.3 * DEG, -0.3 * twist, 0];
  out.head = [-g.lean * 0.4 * DEG, -0.3 * twist, 0];
  return out;
}

/** Body channels of a quadruped gait at phase Φ. */
function animalBody(g: GaitDef, phi: number): Record<string, Vec3> {
  const c1 = Math.cos(2 * Math.PI * phi);
  const c2 = Math.cos(4 * Math.PI * phi);
  return {
    hips: [0, 0, 0],
    spine: [g.flex * DEG * c1, 0, 0],
    chest: [-g.flex * DEG * c1, 0, 0],
    neck: [g.nod * DEG * c2, 0, 0],
    head: [-0.5 * g.nod * DEG * c2, 0, 0],
    'tail.1': [0, 0, g.tail * DEG * c1],
    'tail.2': [0, 0, g.tail * DEG * Math.cos(2 * Math.PI * (phi - 0.08))],
    'tail.3': [0, 0, g.tail * DEG * Math.cos(2 * Math.PI * (phi - 0.16))],
  };
}

/** Bones whose rotation moves the legs' roots: keyed on every gait key so the IK holds between them. */
const BODY_EVERY_KEY = new Set(['hips', 'spine', 'chest']);

/**
 * Footsteps of one leg (see the module comment). With `endAtL` the last footstep is under the body
 * where it stops (the end pose's feet), and the foot lands there no earlier than the gait would
 * land a foot that far ahead.
 */
function planLeg(g: GaitDef, offset: number, phi0: number, S: number, L: number, endAtL: boolean): Stance[] {
  const grid = g.grid;
  const ideal = (k: number) => S * (k + offset + g.mid - phi0);
  const close = 0.15 * S;
  const list: Stance[] = [];
  const k0 = Math.floor(phi0 - offset + 1e-9);
  const inStance = phi0 - offset - k0 < g.duty - 1e-9;
  // a foot that stands where it is until `lift` (it rolls onto its toes only when the gait has
  // time for it after the start)
  const standing = (lift: number): Stance => ({
    contact: -Infinity,
    nominal: lift - g.duty,
    lift,
    s: 0,
    start: true,
    final: false,
  });
  if (inStance) {
    const nominal = k0 + offset;
    const lift = nominal + g.duty;
    const quickContact = phi0 + 1 / grid;
    const tooLate =
      lift - quickContact < 2 / grid || (g.toeStart > 0 && nominal + g.toeStart - quickContact < 1 / grid);
    if (ideal(k0) <= 0.12 * S || tooLate) {
      // already where the gait wants it (or about to lift): it stays where it stands
      list.push({ contact: -Infinity, nominal, lift, s: 0, start: true, final: false });
    } else {
      // the gait wants this foot ahead: a quick first step there
      list.push(standing(phi0));
      list.push({
        contact: quickContact,
        nominal,
        lift,
        s: Math.min(ideal(k0), L),
        start: false,
        final: false,
      });
    }
  } else list.push(standing(phi0));
  for (let k = k0 + 1; !list[list.length - 1].final; k++) {
    const last = list[list.length - 1];
    let s = ideal(k);
    const final = s >= L - close;
    if (final) s = endAtL ? L : Math.min(s, L);
    let contact = Math.max(k + offset, last.lift + 1 / grid);
    if (final) contact = Math.max(contact, Math.ceil((phi0 + s / S - g.mid) * grid - 1e-6) / grid);
    list.push({
      contact,
      nominal: k + offset,
      lift: final ? Infinity : k + offset + g.duty,
      s,
      start: false,
      final,
    });
    if (k > k0 + 1_000_000) break;
  }
  return list;
}

/** Armature-space foot of a leg in an evaluated pose: end, foot and toe directions. */
function footIn(pose: ArmaturePose, leg: LegRig): { end: Vec3; dir: Vec3; toeDir: Vec3 | null } | null {
  const f = pose.bones.get(leg.foot)?.matrix;
  if (!f) return null;
  const t = leg.toe ? pose.bones.get(leg.toe)?.matrix : undefined;
  const unit = (m: Readonly<Mat4>): Vec3 => {
    const l = Math.hypot(m[4], m[5], m[6]) || 1;
    return [m[4] / l, m[5] / l, m[6] / l];
  };
  return { end: [f[12], f[13], f[14]], dir: unit(f), toeDir: t ? unit(t) : null };
}

/**
 * One move of moveActor (a path without corners that turn back), or, with `turnTo` (a world
 * heading, radians), a turn on the spot from frame_start to frame_end stepped as a move's first turn
 * is; null when the actor does not stand on its feet then (the caller turns it whole).
 */
function moveSegment(
  doc: SceneDoc,
  actorId: string,
  points: readonly Vec3[],
  o: MoveOptions,
  turnTo: number | null = null,
): MoveResult | null {
  const meta = requireActor(doc, actorId);
  const kind = requireBuiltKind(meta.kind) as ActorKind;
  const arm = doc.getArmature(meta.armature);
  if (!arm) throw new OperatorError(`Actor '${meta.name}' has no armature data`, 'FAILED');
  const family = isHumanoidKind(kind) ? 'humanoid' : 'quadruped';
  const bp = blueprintFor(kind, meta.height);
  const endPose = requirePose(kind, o.end_pose ?? 'stand');
  if (!Number.isFinite(o.frame_start))
    throw new OperatorError('frame_start must be a number', 'INVALID_PARAMS');
  if (!points.length && turnTo === null)
    throw new OperatorError('points must hold at least one point', 'INVALID_PARAMS');
  for (const p of points)
    if (p.length !== 3 || !p.every(Number.isFinite))
      throw new OperatorError('points must be finite [x, y, z] triples', 'INVALID_PARAMS');
  const asked = o.gait && o.gait !== 'auto' ? o.gait : null;
  if (asked && !gaitDef(family, asked as GaitName))
    throw new OperatorError(
      `Gait '${asked}' does not fit a ${kind} (${family === 'humanoid' ? 'walk, run' : 'walk, trot, gallop'} or auto)`,
      'INVALID_PARAMS',
    );
  if (o.frame_end !== undefined && !(o.frame_end > o.frame_start))
    throw new OperatorError('frame_end must be after frame_start', 'INVALID_PARAMS');
  if (o.speed_mps !== undefined && !(o.speed_mps > 0))
    throw new OperatorError('speed_mps must be positive', 'INVALID_PARAMS');
  const fps = Math.max(1, doc.getScene().fps || 24);
  const f0 = o.frame_start;

  // where and how the actor stands at frame_start
  const fs0 = new FrameState(doc, f0);
  const obj0 = fs0.get<ObjectData>('object', meta.id);
  const world0 = fs0.world(meta.id);
  if (!obj0 || !world0) throw new OperatorError(`Actor '${meta.name}' cannot be evaluated`, 'FAILED');
  const parentW = fs0.parent(meta.id);
  const parentInv = invert4(parentW);
  const parentYaw = Math.hypot(parentW[4], parentW[5]) > 1e-9 ? yawOf([-parentW[4], -parentW[5], 0]) : 0;
  const start: Vec3 = [world0[12], world0[13], world0[14]];
  const yaw0 = yawOf([-world0[4], -world0[5], 0]);
  const raw = new PolyPath([start, ...points]);
  const startPose = obj0.pose?.bones ?? {};
  if (raw.length < 1e-3 && turnTo === null)
    return {
      frame_end: o.frame_end ?? f0,
      length_m: 0,
      gait: null,
      speed_mps: 0,
      frame_settled: f0,
      keys: 0,
    };

  // gait, speed and timing (a sharp first turn is made on the spot before the first step)
  const size = meta.height;
  const total = o.frame_end !== undefined ? (o.frame_end - f0) / fps : null;
  const faceP = o.face_path !== false;
  const w = 0.25 * size;
  const timingOf = (p: PolyPath) => {
    if (turnTo !== null) {
      // a turn on the spot: the walk's steps, the whole time to turn
      const gw = gaitDef(family, 'walk')!;
      const vw = gaitSpeed(gw, family, size);
      return {
        yawStart: nearAngle(turnTo, yaw0),
        gait: 'walk' as GaitName,
        g: gw,
        v: vw,
        S: gaitStride(gw, family, size, vw),
        ta: 0,
        turnT: total ?? 0,
      };
    }
    const yawStart = faceP ? nearAngle(p.heading(0, w), yaw0) : yaw0;
    const opts = { asked: asked as GaitName | null, speed: o.speed_mps, total };
    return { yawStart, ...moveTiming(family, size, p.length, Math.abs(yawStart - yaw0), opts) };
  };
  // the corners rounded, so the actor turns over a step or two: by a quarter stride, as wide as a
  // sideways pull of 0.8 g allows at speed (a runner sweeps round a corner a walker steps round),
  // and for an animal at least its length, so its hind legs follow its forelegs round
  let path = raw;
  if (raw.pts.length > 2) {
    const { S: S0, v: v0 } = timingOf(raw);
    const r = Math.max(S0 / 4, (v0 * v0) / (0.8 * 9.81), (family === 'humanoid' ? 0.15 : 0.8) * size);
    path = new PolyPath(roundCorners(raw.pts, Math.min(1.2 * size, r)));
  }
  const L = path.length;
  const timed = timingOf(path);
  const { yawStart, gait: gaitName, g, turnT } = timed;
  let { v, S, ta } = timed;
  // legs and their feet
  const legs = legRigs(arm, family);
  const narrow = family === 'humanoid' ? (g.name === 'run' ? 0.6 : 0.85) : 1;
  // without face_path the body keeps its heading (bodyFrameStride); without a speed or an arrival
  // frame such a walk is slower, at the same cadence
  const latSide = SIDE_STANCE * size;
  let sideways = 0;
  if (!faceP && turnTo === null) {
    const restLat = legs.length ? Math.min(...legs.map((l) => Math.abs(l.root[0]) * narrow)) : latSide;
    const bf = bodyFrameStride(path.pts, facingOf(yaw0), S, size, restLat);
    const k = bf.k;
    sideways = bf.sideways;
    if (k < 1) {
      S *= k;
      if (o.speed_mps === undefined && total === null) v *= k;
      else if (total === null) ta = Math.min(ta, (0.3 * S) / v);
    }
  }
  const timing = new Timing(L, v, ta);
  const T = timing.T;
  const Tc = S / v;
  const grid = g.grid;

  const legLen = legs.length ? legs.reduce((a, l) => a + l.L1 + l.L2, 0) / legs.length : size / 2;
  const geom = new Map<string, FootGeom>();
  for (const leg of legs) {
    const df = -(leg.tip[1] - leg.end[1]);
    const du = leg.tip[2] - leg.end[2];
    const toeBone = leg.toe ? arm.bones.find((b) => b.name === leg.toe) : undefined;
    const lat = leg.root[0] * narrow;
    geom.set(leg.id, {
      fwd: -leg.root[1],
      lat: Math.sign(lat) * Math.max(Math.abs(lat), latSide * sideways),
      endZ: leg.end[2],
      dir: [df / leg.footLen, du / leg.footLen],
      len: leg.footLen,
      tipF: -(leg.tip[1] - leg.root[1]),
      tipL: leg.tip[0] - leg.root[0],
      heelBack: family === 'humanoid' ? 0.38 * df : 0,
      ballFwd: df,
      ballZ: leg.tip[2],
      toeDir: toeBone ? [-(toeBone.tail[1] - toeBone.head[1]), toeBone.tail[2] - toeBone.head[2]] : null,
    });
  }

  // the poses the move starts and ends in, and whether their feet stand flat (then the first and
  // last footprints are where those poses put the feet, so nothing slides into or out of the move)
  const evalCtx = { frame: 0, armatureMatrix: identity4(), getWorldMatrix: () => null };
  const startFK = computePose(arm, startPose, evalCtx);
  const endBones = posedBones(kind, arm, bp, endPose);
  const endFK = computePose(arm, endBones, evalCtx);
  const touching = (pose: ArmaturePose, leg: LegRig) => {
    let n = 0;
    for (const p of bp.probes) {
      if (p.bone !== leg.foot && p.bone !== leg.toe) continue;
      const m = pose.bones.get(p.bone)?.matrix;
      const r = restInv.get(p.bone);
      if (m && r && transformPoint3(multiply4(m, r), p.point)[2] - p.radius < 0.012 * size) n++;
    }
    return n >= 2;
  };
  const restInv = new Map<string, Mat4>();
  for (const [n, r] of restMatrices(arm.bones)) restInv.set(n, invert4(r.matrix));
  const startStands = legs.every((leg) => touching(startFK, leg));
  const endStands = legs.every((leg) => touching(endFK, leg));
  if (turnTo !== null && (!startStands || !(turnT > 0))) return null;

  // the gait clock: driven by the distance travelled, then by time while the last steps close
  const phi0 = family === 'humanoid' ? Math.ceil(g.mid * grid - 1e-9) / grid : 3 / grid;
  const phiT = phi0 + L / S;
  const phiAt = (t: number) => (t <= T ? phi0 + timing.s(t) / S : phiT + (t - T) / Tc);
  const tAt = (phi: number) => (phi <= phiT ? timing.tOf((phi - phi0) * S) : T + (phi - phiT) * Tc);
  const schedules = new Map<string, Stance[]>();
  for (const leg of legs) schedules.set(leg.id, planLeg(g, g.offsets[leg.id] ?? 0, phi0, S, L, endStands));
  // the steps have closed when every foot stands on its last footstep, past its heel roll
  let phiEnd = phiT;
  for (const list of schedules.values()) {
    const last = list[list.length - 1];
    if (Number.isFinite(last.contact)) phiEnd = Math.max(phiEnd, last.contact + g.heelEnd + 1 / grid);
  }
  phiEnd = Math.min(phiEnd, phiT + 2);
  const tEnd = turnTo === null ? Math.max(T, tAt(phiEnd)) : 0;

  // the body (armature object)
  const bodyS = (t: number) => timing.s(Math.min(t, T));
  const bodyYaw = (t: number): number => {
    if (turnTo !== null) return yawStart;
    if (!faceP) return yaw0;
    const y = nearAngle(path.heading(bodyS(t), w), yawStart);
    if (turnT > 0) return y;
    return yaw0 + (y - yaw0) * smooth(t / (0.5 * Tc));
  };
  const objWorld = (t: number): Mat4 =>
    compose4(path.at(bodyS(t)), [obj0.rotation_euler[0], obj0.rotation_euler[1], bodyYaw(t)], obj0.scale);
  const objEnd = objWorld(tEnd);

  // footprints: the nominal one of a footstep, or where the start or end pose puts the foot. Facing
  // the path they point along its heading, rounded as the body's is (on a sharp corner the feet turn
  // with the body over a few steps rather than all at the corner); without face_path they are laid
  // out in the frame of the body, which keeps its heading (walking backwards, the left foot stays
  // on the left)
  const bodyFwd = facingOf(yaw0);
  const along = (s: number): Vec3 => (faceP ? facingOf(path.heading(s, w)) : bodyFwd);
  const stepDir = (t: Readonly<Vec3>, fu: [number, number]): Vec3 => {
    const n = Math.hypot(fu[0], fu[1]) || 1;
    return [(t[0] * fu[0]) / n, (t[1] * fu[0]) / n, fu[1] / n];
  };
  const nominalPrint = (leg: LegRig, s0: number): Footprint => {
    const gm = geom.get(leg.id)!;
    // the leg's root over the footstep: further along the path facing it, else ahead in the body
    const s = faceP ? s0 + gm.fwd : s0;
    const fwd = along(s);
    const base = path.at(s);
    if (!faceP) for (let i = 0; i < 2; i++) base[i] += fwd[i] * gm.fwd;
    const at = (f: number, l: number, u: number): Vec3 => [
      base[0] + fwd[0] * f - fwd[1] * l,
      base[1] + fwd[1] * f + fwd[0] * l,
      base[2] + u,
    ];
    if (family === 'quadruped') {
      const tip = at(gm.tipF, gm.lat + gm.tipL, 0);
      const d = stepDir(fwd, gm.dir);
      return {
        end: [tip[0] - d[0] * gm.len, tip[1] - d[1] * gm.len, tip[2] - d[2] * gm.len],
        dir: d,
        toeDir: null,
        fwd,
      };
    }
    return {
      end: at(0, gm.lat, gm.endZ),
      dir: stepDir(fwd, gm.dir),
      toeDir: gm.toeDir ? stepDir(fwd, gm.toeDir) : null,
      fwd,
    };
  };
  const posedPrint = (pose: ArmaturePose, leg: LegRig, m: Readonly<Mat4>): Footprint | null => {
    const f = footIn(pose, leg);
    if (!f) return null;
    // the body's front (−Y) made horizontal
    const fl = Math.hypot(m[4], m[5]) || 1;
    return {
      end: transformPoint3(m, f.end),
      dir: transformDirection3(m, f.dir),
      toeDir: f.toeDir ? transformDirection3(m, f.toeDir) : null,
      fwd: [-m[4] / fl, -m[5] / fl, 0],
    };
  };
  const prints = new Map<Stance, Footprint>();
  for (const leg of legs)
    for (const st of schedules.get(leg.id)!) {
      let fp: Footprint | null = null;
      if (st.start && startStands) fp = posedPrint(startFK, leg, objWorld(0));
      else if (st.final && endStands) fp = posedPrint(endFK, leg, objEnd);
      prints.set(st, fp ?? nominalPrint(leg, st.s));
    }

  /** A planted foot at phase Φ of its stance. */
  const plantedPose = (leg: LegRig, st: Stance, phi: number): FootPose => {
    const gm = geom.get(leg.id)!;
    let pitch = 0;
    const roll = Math.max(st.nominal + g.toeStart, st.start ? phi0 : -Infinity);
    if (!st.start && g.heelEnd > 0 && phi - st.contact < g.heelEnd)
      pitch = g.contactPitch * (1 - Math.max(0, (phi - st.contact) / g.heelEnd));
    else if (!st.final && Number.isFinite(st.lift) && st.lift - roll >= 1 / grid - EPS && phi >= roll) {
      const u = (phi - roll) / (st.lift - roll);
      pitch = -g.liftPitch * Math.max(0, Math.min(1, u));
    }
    return rolled(prints.get(st)!, gm, pitch);
  };

  /** A swinging toe: flat as it left the ground, back to its rest bend on the foot by mid-swing. */
  const swingToe = (leg: LegRig, from: Vec3 | null, dir: Vec3, u: number): Vec3 | null => {
    const gm = geom.get(leg.id)!;
    if (!from || !gm.toeDir) return null;
    const bend = Math.atan2(gm.toeDir[1], gm.toeDir[0]) - Math.atan2(gm.dir[1], gm.dir[0]);
    const h = Math.hypot(dir[0], dir[1]) || 1;
    const rest = pitched(dir, [dir[0] / h, dir[1] / h, 0], bend);
    const k = smooth(2 * u);
    const t: Vec3 = [0, 1, 2].map((i) => from[i] + (rest[i] - from[i]) * k) as Vec3;
    const l = Math.hypot(t[0], t[1], t[2]) || 1;
    return [t[0] / l, t[1] / l, t[2] / l];
  };

  /** Where a foot is at phase Φ: planted at a footprint or swinging between two. */
  const footAt = (leg: LegRig, phi: number): FootPose => {
    const list = schedules.get(leg.id)!;
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (phi >= st.contact - EPS && phi <= st.lift + EPS) return plantedPose(leg, st, phi);
      const next = list[i + 1];
      if (!next || !(phi > st.lift && phi < next.contact)) continue;
      const a = plantedPose(leg, st, st.lift);
      const b = plantedPose(leg, next, next.contact);
      const u = (phi - st.lift) / (next.contact - st.lift);
      const t0 = prints.get(st)!.fwd;
      const t1 = prints.get(next)!.fwd;
      // a swing shorter than the gait's (the quick first step) lifts and folds the foot less, but
      // always clear of the ground (a paw kept within millimetres of it reads as a skate)
      const amp = Math.min(1, (next.contact - st.lift) / (1 - g.duty));
      const lift = Math.max(amp * g.lift, Math.min(g.lift, MIN_LIFT)) * legLen;
      const kick = amp * g.kick * legLen;
      const c1: Vec3 = [a.end[0] - t0[0] * kick, a.end[1] - t0[1] * kick, a.end[2] + 1.3 * lift];
      const c2: Vec3 = [
        b.end[0] - t1[0] * 0.25 * kick,
        b.end[1] - t1[1] * 0.25 * kick,
        b.end[2] + 0.55 * lift,
      ];
      const end = bezier3(a.end, c1, c2, b.end, u);
      // the foot turns from its lift-off to its contact angle, curling back mid-swing (a hoof folds)
      // and straight again before it comes down, so it lands from above rather than skimming in
      // (pitched in the plane of the travel direction: a foot pointing straight down at lift-off
      // curls back whichever way its pastern leans)
      const k = smooth(Math.min(1, u / 0.8));
      const fwd = unitMix(t0, t1, k);
      const curl = amp * (family === 'humanoid' ? 0.15 : 1.2) * Math.sin(Math.PI * Math.min(1, u / 0.8));
      const dir = pitched(unitMix(a.dir, b.dir, k), fwd, -curl);
      return { end, dir, toeDir: swingToe(leg, a.toeDir, dir, u), fwd, planted: false };
    }
    return plantedPose(leg, list[list.length - 1], phi);
  };
  const plantedThrough = (leg: LegRig, a: number, b: number) =>
    schedules.get(leg.id)!.some((st) => a >= st.contact - EPS && b <= st.lift + EPS);

  // keys: every step of the gait grid (each stance event, at its exact phase), the arrival and the end
  const keyAt = new Map<number, number>();
  if (turnTo === null)
    for (let m = Math.ceil(phi0 * grid - 1e-9); m / grid < phiEnd + 1e-9; m++)
      keyAt.set(round6(tAt(m / grid)), m / grid);
  for (const t of [0, T, tEnd])
    if (![...keyAt.keys()].some((k) => Math.abs(k - t) < 1e-5)) keyAt.set(round6(t), phiAt(t));
  // the phase follows the distance, so while the speed ramps up and down the grid's steps stretch
  // in time: keys there as close together as in the cruise, or planted feet slip between them
  const spacing = Tc / grid;
  const grid0 = [...keyAt.keys()].sort((a, b) => a - b);
  for (let i = 0; i + 1 < grid0.length; i++) {
    const a = grid0[i];
    const n = Math.ceil((grid0[i + 1] - a) / (1.05 * spacing)) - 1;
    for (let j = 1; j <= n; j++) {
      const t = round6(a + ((grid0[i + 1] - a) * j) / (n + 1));
      keyAt.set(t, phiAt(t));
    }
  }
  const keyTimes = [...keyAt.keys()].filter((t) => t >= 0 && t <= tEnd + 1e-9).sort((a, b) => a - b);

  const frameOf = (t: number) => Math.round((f0 + (turnT + t) * fps) * 1e4) / 1e4;
  const blendIn = (t: number) => smooth(t / Math.max(1e-6, 0.5 * Tc));
  const blendOut = (t: number) => (t <= T ? 1 : 1 - smooth((t - T) / Math.max(1e-6, tEnd - T)));
  // legs keyed by the IK from the first key when the actor stands; else blended in from its pose
  const legBlend = (t: number) => (startStands ? 1 : Math.min(1, 6 * blendIn(t)));
  const bobPhase = family === 'humanoid' ? g.mid : g.duty / 2;
  const nominalDrop = (t: number, phi: number) =>
    blendIn(t) * blendOut(t) * legLen * (g.drop + g.bob * Math.cos(4 * Math.PI * (phi - bobPhase)));

  const zero: Vec3 = [0, 0, 0];
  const rot0 = (b: string): Vec3 => (startPose[b]?.rotation_euler ?? zero) as Vec3;
  const legBones = new Set<string>();
  for (const leg of legs) for (const b of [leg.upper, leg.lower, leg.foot, leg.toe]) if (b) legBones.add(b);
  const body = family === 'humanoid' ? humanBody : animalBody;
  // the hips location (rest axes): the start pose's, the gait's (rest), the end pose's
  const startHips = (startPose.hips?.location ?? zero) as Vec3;
  const endHips = (endBones.hips?.location ?? zero) as Vec3;
  const hipsDown = poseBones(arm, {}, [0, 0, -1]).hips?.location ?? zero;
  const hipsAt = (t: number, drop: number): Vec3 => {
    const a = blendIn(t);
    const b = 1 - blendOut(t);
    return [0, 1, 2].map((i) => {
      const gait = startHips[i] * (1 - a);
      return gait + (endHips[i] - gait) * b + hipsDown[i] * drop;
    }) as Vec3;
  };

  // every key's body pose and feet; the drop of the hips each planted leg needs to reach its foot
  interface KeyState {
    t: number;
    /** Gait phase (NaN while turning on the spot). */
    phi: number;
    frame: number;
    objM: Mat4;
    yaw: number;
    bodyRot: Record<string, Vec3>;
    feet: Map<string, FootPose>;
    drop: number;
    need: number;
    /** Legs planted from this key to the next. */
    planted: Set<string>;
    /** A half key: the legs and the body that carries them are keyed, not the arms, head or tail. */
    half?: boolean;
  }
  const states: KeyState[] = [];
  const bonesFor = (rot: Record<string, Vec3>, hips: Vec3): Record<string, PoseBone> => {
    const bones = poseBones(arm, rot, zero);
    if (bones.hips) bones.hips = { ...bones.hips, location: hips };
    return bones;
  };
  const reachNeed = (st: KeyState, drop: number): number => {
    const pose = computePose(arm, bonesFor(st.bodyRot, hipsAt(st.t, drop)), evalCtx);
    let need = 0;
    for (const leg of legs) {
      const foot = st.feet.get(leg.id)!;
      const parent = pose.bones.get(leg.parent);
      if (!foot.planted || !parent) continue;
      const M = legFrame(leg, multiply4(st.objM, parent.matrix));
      const reach = 0.995 * (leg.L1 + leg.L2);
      const dx = foot.end[0] - M[12];
      const dy = foot.end[1] - M[13];
      const top = foot.end[2] + Math.sqrt(Math.max(0, reach * reach - dx * dx - dy * dy));
      need = Math.max(need, M[14] - top);
    }
    return need;
  };
  const addState = (st: KeyState) => {
    // the extra drop that lets every planted leg reach (a few refinements: the roots move with it)
    let extra = 0;
    for (let iter = 0; iter < 4; iter++) {
      const n = reachNeed(st, st.drop + extra);
      if (n <= 1e-5) break;
      extra += n;
    }
    st.need = extra;
    states.push(st);
  };

  // the turn on the spot (before t = 0): the body turns about its origin while the feet step round
  // under it in rounds of one step of each foot (turnRounds), so that no planted foot is dragged
  // round: each step puts a foot where the start pose puts it under a heading part of the way round
  // (the last round's under the heading the move starts on), and the body faces the mean heading of
  // its feet, so a planted foot is never turned far from it
  const turnSteps = new Map<string, TurnStep[]>();
  if (turnT > 0 && startStands) {
    const Y = yawStart - yaw0;
    const left = Y > 0;
    const rank = (leg: LegRig) => (leg.front ? 0 : 2) + (leg.side > 0 === left ? 0 : 1);
    const order = [...legs].sort((a, b) => rank(a) - rank(b));
    const n = order.length;
    const steps = n * turnRounds(family, Y);
    const slot = (0.95 * turnT) / steps;
    const heading = new Map(legs.map((l) => [l.id, yaw0]));
    for (const leg of legs) turnSteps.set(leg.id, []);
    for (let k = 0; k < steps; k++) {
      const leg = order[k % n];
      const a = -turnT + 0.025 * turnT + k * slot;
      const to = yaw0 + Y * Math.min(1, (k + 1) / (steps - n + 1));
      turnSteps.get(leg.id)!.push({ a, b: a + slot, from: heading.get(leg.id)!, to });
      heading.set(leg.id, to);
    }
    const prints = new Map<string, Footprint>();
    const printAt = (leg: LegRig, h: number): Footprint => {
      const key = `${leg.id}:${h}`;
      let fp = prints.get(key);
      if (!fp) {
        const m = compose4(start, [obj0.rotation_euler[0], obj0.rotation_euler[1], h], obj0.scale);
        fp = posedPrint(startFK, leg, m) ?? nominalPrint(leg, 0);
        prints.set(key, fp);
      }
      return fp;
    };
    /** A foot's heading at τ: that of its last step, between two while it swings. */
    const headingAt = (leg: LegRig, tau: number): number => {
      let h = yaw0;
      for (const st of turnSteps.get(leg.id)!) {
        if (tau <= st.a) return h;
        if (tau < st.b) return st.from + (st.to - st.from) * smooth((tau - st.a) / (st.b - st.a));
        h = st.to;
      }
      return h;
    };
    // keys: through each step closely enough that the leg follows the foot up and down (sparser,
    // the joint angles interpolated between the planted and the lifted foot would drag its ball)
    const times = new Set<number>();
    for (let k = 0; k < 8; k++) times.add(round6(-turnT + (k * turnT) / 8));
    for (const list of turnSteps.values())
      for (const st of list) for (const u of TURN_STEP_KEYS) times.add(round6(st.a + (st.b - st.a) * u));
    for (const tau of [...times].filter((x) => x < -1e-6).sort((a, b) => a - b)) {
      const feet = new Map<string, FootPose>();
      for (const leg of legs) {
        const gm = geom.get(leg.id)!;
        const st = turnSteps.get(leg.id)!.find((x) => tau > x.a + 1e-6 && tau < x.b - 1e-6);
        if (!st) {
          feet.set(leg.id, rolled(printAt(leg, headingAt(leg, tau)), gm, 0));
          continue;
        }
        const p = printAt(leg, st.from);
        const q = printAt(leg, st.to);
        // lifted and put down straight, turned to its new heading in the air (from 15% to 70% of
        // the swing) so that it never twists on the ground
        const u = (tau - st.a) / (st.b - st.a);
        const h = 0.8 * g.lift * legLen;
        const end = bezier3(p.end, vAdd(p.end, [0, 0, 1.3 * h]), vAdd(q.end, [0, 0, 1.3 * h]), q.end, u);
        const k = smooth((u - 0.15) / 0.55);
        feet.set(leg.id, {
          end,
          dir: unitMix(p.dir, q.dir, k),
          toeDir: p.toeDir && q.toeDir ? unitMix(p.toeDir, q.toeDir, k) : null,
          fwd: unitMix(p.fwd, q.fwd, k),
          planted: false,
        });
      }
      const yaw = legs.reduce((a, l) => a + headingAt(l, tau), 0) / Math.max(1, legs.length);
      const bodyRot: Record<string, Vec3> = {};
      for (const b of arm.bones)
        if (b.name !== 'root' && !legBones.has(b.name)) bodyRot[b.name] = rot0(b.name);
      addState({
        t: tau,
        phi: Number.NaN,
        frame: frameOf(tau),
        objM: compose4(start, [obj0.rotation_euler[0], obj0.rotation_euler[1], yaw], obj0.scale),
        yaw,
        bodyRot,
        feet,
        drop: 0,
        need: 0,
        planted: new Set(),
      });
    }
  }

  /** The body's rotations at a time and gait phase: the gait's, blended in from the start pose and out to the end pose. */
  const bodyRotAt = (t: number, phi: number): Record<string, Vec3> => {
    const wIn = blendIn(t);
    const wOut = blendOut(t);
    const gv = body(g, phi);
    const out: Record<string, Vec3> = {};
    for (const b of arm.bones) {
      if (b.name === 'root' || legBones.has(b.name)) continue;
      const s0 = rot0(b.name);
      const gb = gv[b.name] ?? zero;
      const eb = (endBones[b.name]?.rotation_euler ?? zero) as Vec3;
      out[b.name] = [0, 1, 2].map((i) => {
        const a = s0[i] + (gb[i] - s0[i]) * wIn;
        return a + (eb[i] - a) * (1 - wOut);
      }) as Vec3;
    }
    return out;
  };
  for (const t of keyTimes) {
    const phi = keyAt.get(t)!;
    const bodyRot = bodyRotAt(t, phi);
    const feet = new Map<string, FootPose>();
    for (const leg of legs) feet.set(leg.id, footAt(leg, phi));
    addState({
      t,
      phi,
      frame: frameOf(t),
      objM: objWorld(t),
      yaw: bodyYaw(t),
      bodyRot,
      feet,
      drop: nominalDrop(t, phi),
      need: 0,
      planted: new Set(),
    });
  }
  // which legs stay planted from each key to the next (their keys are LINEAR there)
  const markPlanted = () => {
    for (let i = 0; i + 1 < states.length; i++) {
      const a = states[i];
      const b = states[i + 1];
      a.planted.clear();
      for (const leg of legs) {
        const plantedNow = Number.isNaN(a.phi)
          ? !(turnSteps.get(leg.id) ?? []).some((st) => a.t < st.b - 1e-6 && b.t > st.a + 1e-6)
          : plantedThrough(leg, a.phi, b.phi);
        if (plantedNow) a.planted.add(leg.id);
      }
    }
  };
  markPlanted();
  // the extra drops, smoothed so the hips do not bob from key to key (a raised cosine window
  // around every key that needs one) and limited; past the limit a foot falls short (slides)
  const tau = 1.6 * (Tc / grid);
  const maxExtra = 0.1 * legLen;
  for (const st of states) {
    let extra = 0;
    for (const o2 of states) {
      const dt = Math.abs(o2.t - st.t);
      if (dt < tau && o2.need > 0)
        extra = Math.max(extra, o2.need * 0.5 * (1 + Math.cos((Math.PI * dt) / tau)));
    }
    // ... gone once the last steps have closed, so the legs end in the end pose's own angles
    st.drop += Math.min(maxExtra, extra) * (st.t > T ? blendOut(st.t) : 1);
  }
  // half keys: half way between two gait keys every leg gets one more key, with the body that
  // carries it (joint angles interpolated between sparse keys let a swinging foot sag and a
  // planted one slip); the hips' drop is interpolated as its LINEAR keys are
  const swingKeys: KeyState[] = [];
  for (let i = 0; i + 1 < states.length; i++) {
    const a = states[i];
    const b = states[i + 1];
    if (Number.isNaN(a.phi) || b.phi - a.phi < 0.5 / grid) continue;
    const phi = (a.phi + b.phi) / 2;
    const feet = new Map<string, FootPose>();
    for (const leg of legs) feet.set(leg.id, footAt(leg, phi));
    const t = Math.min(b.t, Math.max(a.t, tAt(phi)));
    const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
    swingKeys.push({
      t,
      phi,
      frame: frameOf(t),
      objM: objWorld(t),
      yaw: bodyYaw(t),
      bodyRot: bodyRotAt(t, phi),
      feet,
      drop: a.drop + (b.drop - a.drop) * k,
      need: 0,
      planted: new Set(),
      half: true,
    });
  }
  states.push(...swingKeys);
  states.sort((a, b) => a.t - b.t);
  markPlanted();

  // collected keys per channel
  interface Sample {
    frame: number;
    value: number;
    interp: Interpolation;
  }
  const chans = new Map<string, { bone: string | null; path: string; index: number; keys: Sample[] }>();
  const put = (
    bone: string | null,
    p: string,
    index: number,
    frame: number,
    value: number,
    interp: Interpolation,
  ) => {
    const k = `${p}\u0000${index}`;
    let c = chans.get(k);
    if (!c) chans.set(k, (c = { bone, path: p, index, keys: [] }));
    c.keys.push({ frame, value, interp });
  };
  const lastEuler = new Map<string, Vec3>();
  const putRot = (bone: string, frame: number, e: Vec3, interp: Interpolation) => {
    const c = compatibleEuler(e, lastEuler.get(bone) ?? rot0(bone));
    lastEuler.set(bone, c);
    const p = bonePath(bone, 'rotation_euler');
    for (let i = 0; i < 3; i++) put(bone, p, i, frame, c[i], interp);
  };
  let lastYaw = obj0.rotation_euler[2];
  const putObject = (frame: number, pos: Vec3, yawWorld: number) => {
    const loc = transformPoint3(parentInv, pos);
    const yaw = nearAngle(yawWorld - parentYaw, lastYaw);
    lastYaw = yaw;
    for (let i = 0; i < 3; i++) put(null, 'location', i, frame, loc[i], 'BEZIER');
    put(null, 'rotation_euler', 2, frame, yaw, 'BEZIER');
  };

  // a turn on the spot of an actor that does not stand on its feet: the pose holds through it
  if (turnT > 0 && !startStands) {
    putObject(f0, start, yaw0);
    for (const b of arm.bones) if (b.name !== 'root') putRot(b.name, f0, rot0(b.name), 'BEZIER');
  }

  for (let ti = 0; ti < states.length; ti++) {
    const st = states[ti];
    const { frame, objM } = st;
    const hips = hipsAt(st.t, st.drop);
    const pose = computePose(arm, bonesFor(st.bodyRot, hips), evalCtx);
    putObject(frame, [objM[12], objM[13], objM[14]], st.yaw);
    // the body: every key for the bones that carry the legs, every other gait key for the rest
    const onEven =
      !st.half &&
      (Math.abs(st.phi * grid - Math.round(st.phi * grid)) > 1e-6 || Math.round(st.phi * grid) % 2 === 0);
    for (const [b, val] of Object.entries(st.bodyRot))
      if (BODY_EVERY_KEY.has(b) || onEven || ti === 0 || ti === states.length - 1)
        putRot(b, frame, val, 'BEZIER');
    const anyPlanted = st.planted.size > 0;
    for (let i = 0; i < 3; i++)
      put('hips', bonePath('hips', 'location'), i, frame, hips[i], anyPlanted ? 'LINEAR' : 'BEZIER');
    for (const leg of legs) keyLeg(leg, st, pose, legBlend(st.t));
  }
  /** Keys a leg at a key: the IK under the posed body puts its foot where the key wants it. */
  function keyLeg(leg: LegRig, st: KeyState, pose: ArmaturePose, lb: number): void {
    const foot = st.feet.get(leg.id)!;
    const parent = pose.bones.get(leg.parent);
    if (!parent) return;
    const sol = solveLeg(
      leg,
      legFrame(leg, multiply4(st.objM, parent.matrix)),
      foot.end,
      foot.dir,
      foot.fwd,
      foot.toeDir,
    );
    const interp: Interpolation = st.planted.has(leg.id) ? 'LINEAR' : 'BEZIER';
    const blend = (b: string, e: Vec3): Vec3 => {
      const s0 = rot0(b);
      return [s0[0] + (e[0] - s0[0]) * lb, s0[1] + (e[1] - s0[1]) * lb, s0[2] + (e[2] - s0[2]) * lb];
    };
    putRot(leg.upper, st.frame, blend(leg.upper, sol.upper), interp);
    putRot(leg.lower, st.frame, blend(leg.lower, sol.lower), interp);
    putRot(leg.foot, st.frame, blend(leg.foot, sol.foot), interp);
    if (leg.toe) putRot(leg.toe, st.frame, blend(leg.toe, sol.toe), interp);
  }

  // the end pose, once the steps have closed (a turn on the spot ends in the pose it started in)
  const fFinal = turnTo === null ? frameOf(tEnd) + Math.max(2, Math.round(0.25 * fps)) : frameOf(0);
  if (turnTo === null) {
    for (const b of arm.bones)
      if (b.name !== 'root')
        putRot(b.name, fFinal, (endBones[b.name]?.rotation_euler ?? zero) as Vec3, 'BEZIER');
    for (let i = 0; i < 3; i++) put('hips', bonePath('hips', 'location'), i, fFinal, endHips[i], 'BEZIER');
  }

  // write: the move's range replaces whatever was keyed there
  const wr = new KeyWriter();
  let keys = 0;
  for (const c of chans.values()) {
    const first = c.keys[0]?.value ?? 0;
    if (c.bone && c.keys.every((k) => Math.abs(k.value - first) < 1e-7)) {
      // a channel the move does not change is left alone
      const cur = c.path.endsWith('.location')
        ? ((startPose[c.bone]?.location ?? zero) as Vec3)[c.index]
        : rot0(c.bone)[c.index];
      if (Math.abs(cur - first) < 1e-7) continue;
    }
    wr.clear(meta.id, c.path, c.index, f0, fFinal);
    for (const k of c.keys) {
      wr.key(meta.id, c.path, c.index, k.frame, k.value, k.interp);
      keys++;
    }
  }
  wr.commit(doc);
  return {
    frame_end: frameOf(T),
    length_m: L,
    gait: gaitName,
    speed_mps: v,
    frame_settled: fFinal,
    keys,
  };
}

/**
 * Corners a move does not walk round (radians): sharper than this (walking there and back) the
 * actor stops at the corner, turns on the spot and walks on, as a person does.
 */
export const SHARP_CORNER = 135 * DEG;

/** Half the stance width (fraction of the height) of a walk sideways without face_path. */
const SIDE_STANCE = 0.08;

/**
 * Without face_path the body keeps its heading (`fwd`) and the footsteps are laid out in its frame:
 * the factor (≤ 1) by which a stride S shortens along `pts` and how far sideways the path goes (the
 * sine of its largest angle off `fwd`). A step backwards is shorter; a step sideways never brings the
 * feet together: the stance a little wider (SIDE_STANCE), the stride short enough that the trailing
 * foot stays a sixteenth of the height `size` from the leading one, also on the first step from the
 * start pose's stance (half width `restLat`).
 */
export function bodyFrameStride(
  pts: readonly Readonly<Vec3>[],
  fwd: Readonly<Vec3>,
  S: number,
  size: number,
  restLat: number,
): { k: number; sideways: number } {
  const back = 0.65 * S;
  const side = Math.max(0.05 * S, Math.min(S, 2 * (restLat + SIDE_STANCE * size - size / 16)));
  let k = 1;
  let sideways = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const c = ((b[0] - a[0]) * fwd[0] + (b[1] - a[1]) * fwd[1]) / l;
    const sn = Math.sqrt(Math.max(0, 1 - c * c));
    const ahead = c >= 0 ? S : back;
    k = Math.min(k, 1 / Math.sqrt((c * c) / (ahead * ahead) + (sn * sn) / (side * side)) / S);
    sideways = Math.max(sideways, sn);
  }
  return { k, sideways };
}

/**
 * A path (its first point where the actor stands) cut at its sharp corners (SHARP_CORNER): the
 * parts in order, each from its first point to its last, the next starting at that corner.
 */
export function splitAtSharpCorners(points: readonly Vec3[]): Vec3[][] {
  const pts: Vec3[] = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-4) pts.push([p[0], p[1], p[2]]);
  }
  const parts: Vec3[][] = [];
  let part: Vec3[] = pts.slice(0, 1);
  for (let i = 1; i < pts.length; i++) {
    part.push(pts[i]);
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    if (!c) break;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
    if (turn > SHARP_CORNER) {
      parts.push(part);
      part = [b];
    }
  }
  parts.push(part);
  return parts;
}

/**
 * The cruise speed (m/s) at which a move cut into `parts` (splitAtSharpCorners) arrives `total`
 * seconds after it starts: each part turns on the spot (from heading `yaw0`, then at its corner),
 * walks, and, all but the last, stops (its last steps close and it stands, about a cycle and a
 * quarter of a second); null when no speed makes it in time.
 */
function partsSpeed(
  family: 'humanoid' | 'quadruped',
  size: number,
  parts: readonly Vec3[][],
  yaw0: number,
  faceP: boolean,
  asked: GaitName | null,
  total: number,
): number | null {
  const lengths = parts.map((p) => new PolyPath(p).length);
  const turns: number[] = [];
  let heading = yaw0;
  for (const p of parts) {
    const first = new PolyPath(p).tangent(0);
    const h = faceP ? nearAngle(yawOf(first), heading) : heading;
    turns.push(Math.abs(h - heading));
    const last = new PolyPath(p).tangent(Infinity);
    heading = faceP ? nearAngle(yawOf(last), h) : heading;
  }
  const time = (v: number) =>
    parts.reduce((sum, _, k) => {
      const t = moveTiming(family, size, lengths[k], turns[k], { asked, speed: v, total: null });
      const stop = k < parts.length - 1 ? 1.0 * (t.S / t.v) + 0.25 : 0;
      return sum + t.turnT + lengths[k] / t.v + t.ta + stop;
    }, 0);
  let lo = 0.05;
  let hi = 30;
  if (time(hi) > total) return null;
  if (time(lo) <= total) return lo;
  for (let i = 0; i < 50; i++) {
    const mid = Math.sqrt(lo * hi);
    if (time(mid) > total) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Keys the actor moving along `points` from where it stands at frame_start (see the module
 * comment): a path with sharp corners (splitAtSharpCorners) is walked as one move per part, each
 * but the last ending in 'stand' at its corner, the next starting with a turn on the spot there.
 * Throws an OperatorError for bad input.
 */
export function moveActor(
  doc: SceneDoc,
  actorId: string,
  points: readonly Vec3[],
  o: MoveOptions,
): MoveResult {
  const meta = requireActor(doc, actorId);
  const whole = () => moveSegment(doc, actorId, points, o)!;
  if (!Number.isFinite(o.frame_start) || points.some((p) => p.length !== 3 || !p.every(Number.isFinite)))
    return whole();
  const kind = requireBuiltKind(meta.kind) as ActorKind;
  const family = isHumanoidKind(kind) ? 'humanoid' : 'quadruped';
  const world = new FrameState(doc, o.frame_start).world(meta.id);
  if (!world || !points.length) return whole();
  const parts = splitAtSharpCorners([[world[12], world[13], world[14]], ...points]);
  if (parts.length < 2) return whole();
  const faceP = o.face_path !== false;
  const asked =
    o.gait && o.gait !== 'auto' && gaitDef(family, o.gait as GaitName) ? (o.gait as GaitName) : null;
  let speed = o.speed_mps;
  if (o.frame_end !== undefined) {
    const fps = Math.max(1, doc.getScene().fps || 24);
    const yaw0 = yawOf([-world[4], -world[5], 0]);
    const v = partsSpeed(family, meta.height, parts, yaw0, faceP, asked, (o.frame_end - o.frame_start) / fps);
    if (v === null) return whole();
    speed = v;
  }
  let frame = o.frame_start;
  let length = 0;
  let keys = 0;
  let last: MoveResult | null = null;
  for (let k = 0; k < parts.length; k++) {
    const end = k === parts.length - 1;
    const timed = end && o.frame_end !== undefined && o.frame_end > frame + 1;
    const r = moveSegment(doc, actorId, parts[k].slice(1), {
      ...o,
      frame_start: frame,
      frame_end: timed ? o.frame_end : undefined,
      speed_mps: timed ? undefined : speed,
      end_pose: end ? o.end_pose : 'stand',
    })!;
    length += r.length_m;
    keys += r.keys;
    frame = r.frame_settled;
    last = r;
  }
  return { ...last!, length_m: length, keys };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const vAdd = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The unit vector a fraction `k` of the way from `a` to `b`. */
function unitMix(a: Readonly<Vec3>, b: Readonly<Vec3>, k: number): Vec3 {
  const m: Vec3 = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const l = Math.hypot(m[0], m[1], m[2]) || 1;
  return [m[0] / l, m[1] / l, m[2] / l];
}

/** Tolerance of gait phases (key times are rounded to microseconds). */
const EPS = 1e-5;

// ---------------------------------------------------------------- turning

/**
 * Keys the actor turning on the spot to `yawTarget` (world heading, radians) so the turn ends at
 * `frame` after `turnFrames`; returns the heading reached (degrees, world). An actor standing on
 * its feet steps round as a move's first turn does (its feet never dragged round); one that does
 * not (seated, lying, riding), or a turn of no frames, turns whole.
 */
export function turnActor(
  doc: SceneDoc,
  actorId: string,
  o: { yaw: number; frame: number; turnFrames: number },
): number {
  const meta = requireActor(doc, actorId);
  const from = o.turnFrames > 0 ? o.frame - o.turnFrames : o.frame - 1;
  const fs = new FrameState(doc, from);
  const obj = fs.get<ObjectData>('object', meta.id);
  if (!obj) throw new OperatorError(`Actor '${meta.name}' cannot be evaluated`, 'FAILED');
  const parentW = fs.parent(meta.id);
  const parentYaw = Math.hypot(parentW[4], parentW[5]) > 1e-9 ? yawOf([-parentW[4], -parentW[5], 0]) : 0;
  const old = obj.rotation_euler[2];
  const target = nearAngle(o.yaw - parentYaw, old);
  const path = 'rotation_euler';
  const next = nextKey(doc, meta.id, path, 2, o.frame);
  const stepped =
    o.turnFrames > 0 &&
    Math.abs(target - old) > 1e-6 &&
    moveSegment(doc, meta.id, [], { frame_start: from, frame_end: o.frame }, target + parentYaw) !== null;
  const w = new KeyWriter();
  if (!stepped) {
    w.clear(meta.id, path, 2, from, o.frame);
    w.key(meta.id, path, 2, from, old, o.turnFrames > 0 ? 'BEZIER' : 'CONSTANT');
    w.key(meta.id, path, 2, o.frame, target);
  }
  // a later key that held the old heading now holds the new one
  if (next && Math.abs(next.value - old) < 1e-6)
    w.key(meta.id, path, 2, next.frame, target, next.interpolation);
  w.commit(doc);
  return ((target + parentYaw) * 180) / Math.PI;
}

/** World position of an actor (its object origin) at `frame`. */
export function actorPosition(doc: SceneDoc, actorId: string, frame: number): Vec3 {
  const m = new FrameState(doc, frame).world(actorId);
  return m ? [m[12], m[13], m[14]] : [0, 0, 0];
}
