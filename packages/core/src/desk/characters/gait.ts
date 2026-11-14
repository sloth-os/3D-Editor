import type { Mat4, Vec3 } from '../../math/types';
import { invert4, multiply4 } from '../../math/mat4';
import { transformDirection3, transformPoint3 } from '../../math/vec3';
import type { ArmatureData } from '../../doc/types';
import { DEG, restMatrices, sideSign, type Side } from './rig';
import { LEGS, isFront, legSide, type Leg } from './quadruped';

/*
 * Gaits (spec §8): walk and run for humanoids; walk, trot and gallop for quadrupeds. A gait is a
 * cycle of `grid` equal steps (8) on which every stance event of every leg falls: contact, the end
 * of the heel roll, the start of the toe roll and lift-off. Each leg is planted for `duty` of the
 * cycle at a footstep on the ground; between footsteps it swings along a lifted arc. Joint angles
 * come from an analytic two-bone IK of each leg at every key, so a planted foot stays where it was
 * put; the keys of a leg are LINEAR while it is planted (the IK holds in between to millimetres)
 * and BEZIER while it swings.
 *
 * Leg IK works in the rest frame of the leg's first bone under its posed parent (rig.ts: local X
 * is the knee hinge, +Y runs down the bone, +Z points back for a hanging leg): the leg plane is
 * yawed about +Y (the foot's heading) and tilted about +Z (sideways reach), then the two bones bend
 * in it. As euler XYZ (R = Rz·Ry·Rx) that is (bend, yaw, tilt) on the first bone and a bend about
 * X on the others.
 */

export type GaitName = 'walk' | 'run' | 'trot' | 'gallop';

export interface GaitDef {
  name: GaitName;
  /** Keys per cycle of the legs, the hips and the body; every stance event falls on this grid. */
  grid: number;
  /** Fraction of the cycle each leg is planted. */
  duty: number;
  /** Phase offset of each leg (cycle fraction, a multiple of 1/grid). */
  offsets: Record<string, number>;
  /** Phase after a contact at which the body centre passes over that footstep (cycle fraction). */
  mid: number;
  /** End of the heel roll (humanoids) and start of the toe roll or the hoof's breakover (cycle fractions after contact). */
  heelEnd: number;
  toeStart: number;
  /** Toe-up pitch at contact (humanoids) and heel-up pitch at lift-off (radians). */
  contactPitch: number;
  liftPitch: number;
  /** Swing: lift height and backward kick of the foot (fractions of the leg length). */
  lift: number;
  kick: number;
  /** Hips: drop below the rest height and bob, lowest at mid-stance (fractions of the leg length). */
  drop: number;
  bob: number;
  /** Speed at the reference size (m/s) and stride (one cycle) at that speed (fraction of the size). */
  speed: number;
  stride: number;
  /** Humanoids' upper body (degrees): arm swing, elbow bend, arm out, forward lean, chest twist. */
  armSwing: number;
  elbow: number;
  armOut: number;
  lean: number;
  twist: number;
  /** Quadrupeds (degrees): head nod, tail sway, back flex. */
  nod: number;
  tail: number;
  flex: number;
}

const BASE: Omit<GaitDef, 'name' | 'duty' | 'offsets' | 'speed' | 'stride'> = {
  grid: 8,
  mid: 0.25,
  heelEnd: 0,
  toeStart: 0,
  contactPitch: 0,
  liftPitch: 0,
  lift: 0.1,
  kick: 0.05,
  drop: 0.02,
  bob: 0,
  armSwing: 0,
  elbow: 0,
  armOut: 0,
  lean: 0,
  twist: 0,
  nod: 0,
  tail: 0,
  flex: 0,
};

/** Humanoid gaits (reference height 1.7 m): walk ~1.8 steps/s at 1.3 m/s, run ~2.8 at 3.5. */
export const HUMAN_GAITS: Record<'walk' | 'run', GaitDef> = {
  walk: {
    ...BASE,
    name: 'walk',
    duty: 5 / 8,
    offsets: { L: 0, R: 0.5 },
    mid: 0.25,
    heelEnd: 1 / 8,
    toeStart: 3 / 8,
    contactPitch: 18 * DEG,
    liftPitch: 60 * DEG,
    lift: 0.12,
    kick: 0.06,
    drop: 0.012,
    speed: 1.3,
    stride: 0.847,
    armSwing: 17,
    elbow: 16,
    armOut: 7,
    lean: 3,
    twist: 6,
  },
  run: {
    ...BASE,
    name: 'run',
    duty: 3 / 8,
    offsets: { L: 0, R: 0.5 },
    mid: 0.15,
    heelEnd: 0,
    toeStart: 1 / 8,
    contactPitch: 0,
    liftPitch: 55 * DEG,
    lift: 0.3,
    kick: 0.22,
    drop: 0.045,
    bob: 0.03,
    speed: 3.5,
    stride: 1.47,
    armSwing: 38,
    elbow: 88,
    armOut: 9,
    lean: 11,
    twist: 10,
  },
};

/** Quadruped gaits (reference: a 1.6 m horse at the withers). */
export const ANIMAL_GAITS: Record<'walk' | 'trot' | 'gallop', GaitDef> = {
  walk: {
    ...BASE,
    name: 'walk',
    duty: 4 / 8,
    offsets: { BL: 0, FL: 2 / 8, BR: 4 / 8, FR: 6 / 8 },
    mid: 0.2,
    toeStart: 2 / 8,
    liftPitch: 40 * DEG,
    lift: 0.16,
    kick: 0.05,
    drop: 0.03,
    speed: 1.6,
    stride: 0.9,
    nod: 5,
    tail: 6,
  },
  trot: {
    ...BASE,
    name: 'trot',
    duty: 3 / 8,
    offsets: { FL: 0, BR: 0, FR: 4 / 8, BL: 4 / 8 },
    mid: 0.15,
    toeStart: 1 / 8,
    liftPitch: 45 * DEG,
    lift: 0.24,
    kick: 0.08,
    drop: 0.05,
    bob: 0.02,
    speed: 3.6,
    stride: 1.45,
    nod: 3,
    tail: 8,
  },
  gallop: {
    ...BASE,
    name: 'gallop',
    duty: 2 / 8,
    offsets: { BL: 0, BR: 1 / 8, FL: 4 / 8, FR: 5 / 8 },
    mid: 0.125,
    toeStart: 1 / 8,
    liftPitch: 55 * DEG,
    lift: 0.3,
    kick: 0.12,
    drop: 0.07,
    bob: 0.03,
    speed: 9,
    stride: 2.4,
    nod: 8,
    tail: 12,
    flex: 5,
  },
};

const HUMAN_REF = 1.7;
const ANIMAL_REF = 1.6;

/** Default speed (m/s) of a gait for an actor of size `size` (height, or withers height). */
export function gaitSpeed(g: GaitDef, family: 'humanoid' | 'quadruped', size: number): number {
  return g.speed * Math.sqrt(size / (family === 'humanoid' ? HUMAN_REF : ANIMAL_REF));
}

/** Stride (metres per cycle) at speed v: longer steps when faster (clamped to 0.5–1.4× the reference). */
export function gaitStride(g: GaitDef, family: 'humanoid' | 'quadruped', size: number, v: number): number {
  const ref = gaitSpeed(g, family, size);
  const k = Math.min(1.4, Math.max(0.5, Math.sqrt(Math.max(1e-6, v) / ref)));
  return g.stride * size * k;
}

/** The gait 'auto' picks from the speed: humanoids walk below ~2.2 m/s; quadrupeds walk, trot, gallop. */
export function autoGait(family: 'humanoid' | 'quadruped', size: number, v: number): GaitName {
  if (family === 'humanoid') return v < 2.2 * Math.sqrt(size / HUMAN_REF) ? 'walk' : 'run';
  const k = Math.sqrt(size / ANIMAL_REF);
  return v < 2.4 * k ? 'walk' : v < 6 * k ? 'trot' : 'gallop';
}

export function gaitDef(family: 'humanoid' | 'quadruped', name: GaitName): GaitDef | null {
  if (family === 'humanoid') return name === 'walk' || name === 'run' ? HUMAN_GAITS[name] : null;
  return name === 'walk' || name === 'trot' || name === 'gallop' ? ANIMAL_GAITS[name] : null;
}

/** A move's gait and timing: cruise speed v (m/s), stride S (m per cycle), speed ramps ta (s), and a turn on the spot before the first step (s). */
export interface MoveTiming {
  gait: GaitName;
  g: GaitDef;
  v: number;
  S: number;
  ta: number;
  turnT: number;
}

/** Legs of a family (a turn on the spot steps each once a round). */
export const LEG_COUNT = { humanoid: 2, quadruped: 4 } as const;

/**
 * How far (radians) a planted foot may be turned from the body while the body turns on the spot over
 * it: people a little under what a hip turns a leg (MAX_LEG_TWIST); animals less, as their feet
 * stand far from the middle the body turns about and their legs lean over planted feet as it turns
 * (a horse's shoulder, half a metre ahead of that middle, swings over 20 cm to the side over 25°).
 */
const TURN_TWIST = { humanoid: 46 * DEG, quadruped: 25 * DEG } as const;

/**
 * Rounds of steps (one step of each foot a round) a turn on the spot of dTurn (radians) takes: each
 * step puts a foot a little further round, the body facing the mean of its feet, so a planted foot
 * is never turned from the body by more than TURN_TWIST: with n feet and R rounds, the feet's
 * headings spread (n − 1)·dTurn / (n·R − n + 1) and the body is half way between.
 */
export function turnRounds(family: 'humanoid' | 'quadruped', dTurn: number): number {
  const n = LEG_COUNT[family];
  const twist = TURN_TWIST[family];
  return Math.max(1, Math.ceil(((n - 1) * Math.abs(dTurn)) / (2 * twist * n) + (n - 1) / n));
}

/** Seconds a step of a turn on the spot takes at least (an animal's quicker the smaller it is). */
export function turnStepTime(family: 'humanoid' | 'quadruped', size: number): number {
  return family === 'humanoid' ? 0.24 : 0.16 * Math.max(0.6, Math.min(1.2, Math.sqrt(size / ANIMAL_REF)));
}

/**
 * The gait and timing of a move of length L (m) whose first heading turns dTurn (radians) from the
 * actor's (a turn over 30° is made on the spot first, a step of each foot per round: turnRounds):
 * at `speed`, else arriving `total` seconds after it starts (frame_end), else at the gait's own
 * speed. `asked` is a gait that fits the family (null: the speed picks one).
 */
export function moveTiming(
  family: 'humanoid' | 'quadruped',
  size: number,
  L: number,
  dTurn: number,
  o: { asked: GaitName | null; speed?: number; total: number | null },
): MoveTiming {
  const { asked, total } = o;
  let turnT =
    dTurn > 30 * DEG
      ? Math.max(
          Math.min(0.8, Math.max(0.3, (dTurn / Math.PI) * 0.8)) * (family === 'humanoid' ? 1 : 1.6),
          LEG_COUNT[family] * turnRounds(family, dTurn) * turnStepTime(family, size),
        )
      : 0;
  if (total !== null && turnT > total / 3) turnT = total / 3;
  const walkT = total === null ? null : total - turnT;
  const base = gaitDef(family, asked ?? 'walk')!;
  let v = o.speed ?? (walkT !== null ? L / walkT : gaitSpeed(base, family, size));
  let gait: GaitName = asked ?? autoGait(family, size, v);
  let g = gaitDef(family, gait)!;
  let S = gaitStride(g, family, size, v);
  let ta = Math.min(0.3 * (S / v), walkT !== null ? walkT / 3 : Infinity);
  if (walkT !== null) {
    // the speed ramps lose v·ta of the distance: v = L / (T − ta), where ta depends on v
    for (let i = 0; i < 5; i++) {
      v = L / Math.max(1e-6, walkT - ta);
      if (!asked) gait = autoGait(family, size, v);
      g = gaitDef(family, gait)!;
      S = gaitStride(g, family, size, v);
      ta = Math.min(0.3 * (S / v), walkT / 3);
    }
  }
  return { gait, g, v, S, ta, turnT };
}

// ---------------------------------------------------------------- legs

/** A leg's chain and rest geometry (character space). */
export interface LegRig {
  id: string;
  side: 1 | -1;
  front: boolean;
  parent: string;
  /** upper, lower, foot (and the toe of humanoids). */
  upper: string;
  lower: string;
  foot: string;
  toe: string | null;
  /** Rest points: root (upper head), middle joint, end (foot head) and foot tip (foot tail). */
  root: Vec3;
  mid: Vec3;
  end: Vec3;
  tip: Vec3;
  L1: number;
  L2: number;
  footLen: number;
  /** Rest angles (radians) in the upper bone's rest frame, from its +Y towards +Z: lower, foot, toe. */
  lam0: number;
  lam1: number;
  lam2: number;
  /** The middle joint points forward (knees, horses' front knees) or back (hocks). */
  knee: 'forward' | 'back';
  /** Rest matrices (character space) of the upper bone and of the parent. */
  upperRest: Mat4;
  parentRest: Mat4;
}

const angleIn = (restInv: Mat4, dir: Vec3): number => {
  const d = transformDirection3(restInv, dir);
  return Math.atan2(d[2], d[1]);
};

/** The legs of an armature (humanoid: L, R; quadruped: FL, FR, BL, BR). */
export function legRigs(arm: ArmatureData, family: 'humanoid' | 'quadruped'): LegRig[] {
  const rest = restMatrices(arm.bones);
  const bone = (n: string) => arm.bones.find((b) => b.name === n);
  const out: LegRig[] = [];
  const ids: string[] = family === 'humanoid' ? ['L', 'R'] : [...LEGS];
  for (const id of ids) {
    const names =
      family === 'humanoid'
        ? { upper: `thigh.${id}`, lower: `shin.${id}`, foot: `foot.${id}`, toe: `toe.${id}` as string | null }
        : { upper: `upper_leg.${id}`, lower: `lower_leg.${id}`, foot: `foot.${id}`, toe: null };
    const u = bone(names.upper);
    const l = bone(names.lower);
    const f = bone(names.foot);
    const t = names.toe ? bone(names.toe) : undefined;
    const ur = rest.get(names.upper);
    if (!u || !l || !f || !ur || !u.parent) continue;
    const pr = rest.get(u.parent);
    if (!pr) continue;
    const inv = invert4(ur.matrix);
    const dir = (b: { head: Vec3; tail: Vec3 }): Vec3 => [
      b.tail[0] - b.head[0],
      b.tail[1] - b.head[1],
      b.tail[2] - b.head[2],
    ];
    const len = (b: { head: Vec3; tail: Vec3 }) => Math.hypot(...dir(b));
    const front = family === 'humanoid' ? true : isFront(id as Leg);
    out.push({
      id,
      side: family === 'humanoid' ? (sideSign(id as Side) as 1 | -1) : legSide(id as Leg),
      front,
      parent: u.parent,
      upper: names.upper,
      lower: names.lower,
      foot: names.foot,
      toe: t ? names.toe : null,
      root: [...u.head] as Vec3,
      mid: [...l.head] as Vec3,
      end: [...f.head] as Vec3,
      tip: [...f.tail] as Vec3,
      L1: len(u),
      L2: len(l),
      footLen: len(f),
      lam0: angleIn(inv, dir(l)),
      lam1: angleIn(inv, dir(f)),
      lam2: t ? angleIn(inv, dir(t)) : 0,
      knee: family === 'humanoid' || front ? 'forward' : 'back',
      upperRest: ur.matrix,
      parentRest: pr.matrix,
    });
  }
  return out;
}

/** Rotation about local X/Y/Z of a 3-vector. */
const rotY = (v: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
};
const rotZ = (v: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
};

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Euler rotations of a leg's bones that put its end at `end` with its foot along `footDir`. */
export interface LegSolution {
  upper: Vec3;
  lower: Vec3;
  foot: Vec3;
  toe: Vec3;
  /** Distance the end was short of the target (0 when reached). */
  miss: number;
}

/** How far the leg IK turns a leg about its own axis from the body's forward (radians). */
export const MAX_LEG_TWIST = 50 * (Math.PI / 180);

/** How far the leg IK rolls a foot out of the leg plane (radians). */
const MAX_FOOT_ROLL = 25 * DEG;

/**
 * Solves a leg. `frame` is the world matrix of the upper bone's rest frame under its posed parent
 * (object · parentPosed · parentRest⁻¹ · upperRest); `end` the world target of the foot's head,
 * `footDir` the world direction of the foot bone, `heading` the world direction the foot points
 * along the ground (the leg plane turns about the bone's rest axis to it; null: the body's
 * forward), `toeDir` the world direction of the toe (null: its rest bend on the foot).
 */
export function solveLeg(
  leg: LegRig,
  frame: Readonly<Mat4>,
  end: Readonly<Vec3>,
  footDir: Readonly<Vec3>,
  heading: Readonly<Vec3> | null,
  toeDir: Readonly<Vec3> | null = null,
): LegSolution {
  const inv = invert4(frame as Mat4);
  const A = transformPoint3(inv, end);
  // a hanging leg's rest frame has +Y down and +Z back: the foot's heading turns it about Y
  let yaw = 0;
  if (heading) {
    const h = transformDirection3(inv, heading);
    if (Math.hypot(h[0], h[2]) > 1e-6) yaw = -Math.atan2(h[0], -h[2]);
  }
  // as far as a hip turns the leg (beyond, on a sharp corner or a turn on the spot, the foot
  // pivots on the ground instead): the twist is the euler's middle angle, at 90° in gimbal lock
  yaw = Math.max(-MAX_LEG_TWIST, Math.min(MAX_LEG_TWIST, yaw));
  // tilt about +Z so the target lies in the yawed leg plane (x = 0)
  const R = Math.hypot(A[0], A[1]);
  let tilt = 0;
  if (R > 1e-9) {
    const k = Math.max(-1, Math.min(1, (A[2] * Math.tan(yaw)) / R));
    tilt = wrapAngle(Math.atan2(A[1], A[0]) - Math.acos(k));
  }
  const Q = rotY(rotZ(A, -tilt), -yaw);
  const { L1, L2 } = leg;
  const d0 = Math.hypot(Q[1], Q[2]);
  const d = Math.max(Math.abs(L1 - L2) + 1e-6, Math.min(L1 + L2 - 1e-6, d0));
  const gamma = Math.atan2(Q[2], Q[1]);
  const cosDelta = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const delta = Math.acos(Math.max(-1, Math.min(1, cosDelta)));
  const thU = leg.knee === 'forward' ? gamma - delta : gamma + delta;
  const my = L1 * Math.cos(thU);
  const mz = L1 * Math.sin(thU);
  const ey = d * Math.cos(gamma);
  const ez = d * Math.sin(gamma);
  const thL = Math.atan2(ez - mz, ey - my);
  const planeOf = (d: Readonly<Vec3>): Vec3 => rotY(rotZ(transformDirection3(inv, d), -tilt), -yaw);
  const inPlane = (d: Readonly<Vec3>): number => {
    const q = planeOf(d);
    return Math.atan2(q[2], q[1]);
  };
  // the foot bends in the leg plane to footDir and rolls out of it by what the leg's lean leaves
  // (a planted hoof stays flat while the leg leans over it as the body turns): in the foot's rest
  // frame footDir is (x, y, z) and the euler (a, 0, c) points the bone at (−sin c·cos a, cos c·cos a, sin a)
  const qf = planeOf(footDir);
  const beta = thL + leg.lam1 - leg.lam0;
  const yf = qf[1] * Math.cos(beta) + qf[2] * Math.sin(beta);
  const zf = qf[2] * Math.cos(beta) - qf[1] * Math.sin(beta);
  const roll =
    Math.abs(yf) > 1e-9 ? Math.max(-MAX_FOOT_ROLL, Math.min(MAX_FOOT_ROLL, Math.atan(-qf[0] / yf))) : 0;
  const footRel = wrapAngle(Math.atan2(zf, yf / Math.cos(roll)));
  const thF = inPlane(footDir);
  const toeRel = toeDir === null ? 0 : wrapAngle(inPlane(toeDir) - thF - (leg.lam2 - leg.lam1));
  return {
    upper: [thU, yaw, tilt],
    lower: [wrapAngle(thL - thU - leg.lam0), 0, 0],
    foot: [footRel, 0, roll],
    toe: [toeRel, 0, 0],
    miss: Math.max(0, d0 - (L1 + L2)),
  };
}

/** World matrix of a leg's upper rest frame given the world matrix of its posed parent bone. */
export function legFrame(leg: LegRig, parentWorld: Readonly<Mat4>): Mat4 {
  return multiply4(multiply4(parentWorld as Mat4, invert4(leg.parentRest)), leg.upperRest);
}

/** A cubic Bézier point. */
export function bezier3(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const a = (1 - u) ** 3;
  const b = 3 * (1 - u) ** 2 * u;
  const c = 3 * (1 - u) * u * u;
  const e = u ** 3;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
    a * p0[2] + b * p1[2] + c * p2[2] + e * p3[2],
  ];
}

export const smooth = (u: number): number => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};
