import type { Mat4, Vec3 } from '../../math/types';
import { identity4, invert4, multiply4 } from '../../math/mat4';
import { transformDirection3, transformPoint3 } from '../../math/vec3';
import type { ArmatureData, PoseBone } from '../../doc/types';
import { computePose } from '../../armature/pose';
import { DEG, SIDES, poseBone, restMatrices, type Blueprint, type PartSurface, type Side } from './rig';
import { LEGS, isFront, type Leg } from './quadruped';

/*
 * Pose library (spec §8). Humanoid poses are written in joint angles (degrees) as rideo writes
 * its POSES (packages/shared/src/blocking/render.ts): per side [left, right] hip flexion forward,
 * knee flexion, shoulder flexion forward (`arm`), shoulder abduction (`armOut`), elbow flexion and
 * a forward torso `lean`; rideo's 10 poses keep its joint values. Each converts to bone-local
 * euler rotations (rig.ts: local X bends forward/back, Z sideways, Y twists), then the pose is
 * grounded: the hips move up or down so the lowest ground probe (feet, knees, seat, back, head)
 * touches z = 0, as rideo puts "the lowest foot or knee on the floor". Quadruped poses are written
 * per leg the same way.
 */

type Pair = [number, number];

/** Humanoid pose in joint angles (degrees); [left, right] pairs, missing = 0. */
export interface HumanPoseSpec {
  hip?: Pair;
  hipAbd?: Pair;
  hipTwist?: Pair;
  knee?: Pair;
  ankle?: Pair;
  toe?: Pair;
  arm?: Pair;
  armOut?: Pair;
  armTwist?: Pair;
  elbow?: Pair;
  wrist?: Pair;
  shrug?: Pair;
  /** Pelvis: forward tilt of the whole body above and below the hips, sideways roll, turn. */
  pelvis?: number;
  pelvisRoll?: number;
  pelvisTurn?: number;
  /** Forward lean split between spine and chest; twist turns the chest left (+). */
  lean?: number;
  chestTwist?: number;
  side?: number;
  neck?: number;
  /** Head nod (+ down), turn (+ to its left) and tilt. */
  head?: number;
  headTurn?: number;
  headTilt?: number;
  /** Extra hips offset in character space (m per metre of height). */
  shift?: Vec3;
  /** 'lowest': ground the lowest probe; 'none': keep the hips at rest height (riders). */
  ground?: 'lowest' | 'none';
  /** Height above the ground after grounding (fraction of the height; jumps). */
  lift?: number;
}

/** rideo's 10 (its joint values) and the editor's own poses. */
export const HUMAN_POSE_SPECS: Record<string, HumanPoseSpec> = {
  stand: { armOut: [8, 8], elbow: [8, 8] },
  walk: {
    hip: [24, -20],
    knee: [6, 24],
    ankle: [8, -12],
    arm: [-20, 22],
    armOut: [6, 6],
    elbow: [15, 15],
    lean: 3,
  },
  run: {
    hip: [48, -30],
    knee: [25, 80],
    ankle: [10, 15],
    arm: [-45, 50],
    armOut: [8, 8],
    elbow: [85, 85],
    lean: 14,
  },
  sit: { hip: [90, 90], knee: [90, 90], arm: [25, 25], armOut: [8, 8], elbow: [45, 45], lean: 2 },
  crouch: {
    hip: [75, 75],
    knee: [140, 140],
    ankle: [-35, -35],
    arm: [35, 35],
    armOut: [12, 12],
    elbow: [40, 40],
    lean: 32,
    head: -20,
  },
  kneel: {
    hip: [0, 90],
    knee: [90, 90],
    ankle: [70, 0],
    arm: [10, 10],
    armOut: [8, 8],
    elbow: [20, 20],
    lean: 4,
  },
  lie: { pelvis: -90, armOut: [12, 12], elbow: [5, 5], ankle: [20, 20], head: 8 },
  reach: { arm: [0, 85], armOut: [8, 4], elbow: [8, 5], lean: 6, shrug: [0, 6] },
  point: { arm: [0, 80], armOut: [8, 18], elbow: [8, 0], wrist: [0, -5], headTurn: -12 },
  wave: { arm: [0, 20], armOut: [8, 125], armTwist: [0, -40], elbow: [8, 45], headTilt: 4 },
  idle: {
    hip: [3, -2],
    knee: [0, 9],
    hipAbd: [2, 4],
    armOut: [6, 9],
    elbow: [10, 14],
    pelvisRoll: 3,
    side: -2,
    headTilt: 3,
    ankle: [-3, 9],
  },
  talk: {
    arm: [8, 30],
    armOut: [7, 12],
    armTwist: [0, 30],
    elbow: [18, 80],
    wrist: [0, 10],
    head: -3,
    headTurn: 6,
    lean: 2,
  },
  arms_crossed: {
    arm: [30, 30],
    armOut: [14, 14],
    armTwist: [62, 62],
    elbow: [112, 104],
    lean: -2,
    head: -2,
  },
  hands_on_hips: {
    arm: [-12, -12],
    armOut: [44, 44],
    armTwist: [70, 70],
    elbow: [100, 100],
    wrist: [20, 20],
  },
  carry: { arm: [40, 40], armOut: [-6, -6], armTwist: [30, 30], elbow: [62, 62], lean: -4 },
  throw: {
    hip: [22, -18],
    knee: [8, 14],
    ankle: [14, -4],
    arm: [55, -15],
    armOut: [10, 92],
    armTwist: [0, 80],
    elbow: [20, 95],
    chestTwist: -24,
    lean: -6,
    headTurn: 18,
  },
  kick: {
    hip: [4, 72],
    knee: [12, 18],
    ankle: [-4, 30],
    arm: [-20, 25],
    armOut: [35, 30],
    elbow: [20, 25],
    lean: -12,
  },
  jump: {
    hip: [35, 35],
    knee: [65, 65],
    ankle: [35, 35],
    arm: [150, 150],
    armOut: [18, 18],
    elbow: [12, 12],
    lean: 4,
    head: -10,
    lift: 0.12,
  },
  look_up: { armOut: [8, 8], elbow: [8, 8], neck: -18, head: -32, lean: -4 },
  ride: {
    hip: [62, 62],
    hipAbd: [26, 26],
    hipTwist: [8, 8],
    knee: [78, 78],
    ankle: [-8, -8],
    arm: [32, 32],
    armOut: [6, 6],
    elbow: [62, 62],
    lean: 8,
    ground: 'none',
  },
  sit_ground: {
    hip: [82, 82],
    hipAbd: [6, 6],
    knee: [28, 28],
    ankle: [12, 12],
    arm: [-28, -28],
    armOut: [14, 14],
    elbow: [6, 6],
    lean: -8,
  },
};

/** Quadruped leg angles (degrees): upper swings forward (+), lower bends at the knee/hock, foot at the fetlock. */
interface LegAngles {
  upper?: number;
  lower?: number;
  foot?: number;
  abd?: number;
}

/** Quadruped pose (degrees). */
export interface AnimalPoseSpec {
  legs?: Partial<Record<Leg, LegAngles>>;
  /** Pitch of the whole body at the hips (+ nose down), back arch, chest pitch. */
  body?: number;
  spine?: number;
  chest?: number;
  /** Neck raise (+ up), head raise (+ nose up), turns. */
  neck?: number;
  head?: number;
  neckTurn?: number;
  headTurn?: number;
  /** Tail raise per segment (+ up) and sideways swing. */
  tail?: [number, number, number];
  tailSide?: number;
  ground?: 'lowest' | 'none';
  /** Sits on the rump: the body pitch is solved so the straight front legs stand on the ground (`body` is ignored). */
  seated?: boolean;
  /** Grazes: the neck angle is solved so the muzzle reaches the ground (`neck` is ignored). */
  graze?: boolean;
}

const FOLDED_FRONT: LegAngles = { upper: 42, lower: 150, foot: 20 };
const FOLDED_BACK: LegAngles = { upper: 70, lower: 140, foot: 30 };

export const ANIMAL_POSE_SPECS: Record<string, AnimalPoseSpec> = {
  stand: {},
  walk: {
    legs: {
      FL: { upper: 16, lower: 8 },
      FR: { upper: -12, lower: 4 },
      BL: { upper: 4, lower: 10 },
      BR: { upper: -14, lower: -10, foot: 20 },
    },
    neck: -4,
    head: -4,
  },
  trot: {
    legs: {
      FL: { upper: 22, lower: 70, foot: 30 },
      FR: { upper: -14 },
      BL: { upper: -10, lower: -4 },
      BR: { upper: 26, lower: 40, foot: 30 },
    },
    neck: 4,
    tail: [10, 0, 0],
  },
  gallop: {
    legs: {
      FL: { upper: 40, lower: 30, foot: 10 },
      FR: { upper: 30, lower: 60, foot: 20 },
      BL: { upper: -35, lower: -20, foot: 25 },
      BR: { upper: -25, lower: -30, foot: 30 },
    },
    neck: -12,
    head: 8,
    spine: -4,
    tail: [25, 10, 0],
  },
  sit: {
    seated: true,
    legs: {
      FL: { upper: -3 },
      FR: { upper: -3 },
      BL: { upper: 95, lower: 150, foot: -50 },
      BR: { upper: 95, lower: 150, foot: -50 },
    },
    neck: 6,
    head: -8,
    tail: [-30, -20, -10],
  },
  lie: {
    legs: { FL: FOLDED_FRONT, FR: FOLDED_FRONT, BL: FOLDED_BACK, BR: FOLDED_BACK },
    neck: -6,
    head: 4,
    tail: [-10, -10, 0],
  },
  eat: {
    legs: { FL: { upper: 6, abd: 4 }, FR: { upper: -4, abd: 4 } },
    graze: true,
    head: 40,
    tail: [-5, 0, 0],
  },
  look_up: { neck: 18, head: 26, tail: [12, 0, 0] },
};

/** Kinds whose own build calls for another version of a pose (a dog lies with its front legs out). */
export const ANIMAL_KIND_POSE_SPECS: Readonly<Record<string, Readonly<Record<string, AnimalPoseSpec>>>> = {
  dog: {
    lie: {
      legs: {
        FL: { upper: 62, lower: -28, foot: -6, abd: 3 },
        FR: { upper: 58, lower: -30, foot: -6, abd: 3 },
        BL: FOLDED_BACK,
        BR: FOLDED_BACK,
      },
      neck: 4,
      head: -4,
      tail: [-25, -5, 0],
    },
  },
};

/** A quadruped pose of a kind: its own version if it has one, else the family's. */
export function animalPoseSpec(kind: string, pose: string): AnimalPoseSpec {
  return ANIMAL_KIND_POSE_SPECS[kind]?.[pose] ?? ANIMAL_POSE_SPECS[pose];
}

// ---------------------------------------------------------------- conversion

const r = (d: number | undefined) => (d ?? 0) * DEG;
const pick = (p: Pair | undefined, s: Side) => (p ? p[s === 'L' ? 0 : 1] : 0);

/**
 * Bone-local euler rotations (radians) of a humanoid pose; `stoop` (0..1) adds the elder's
 * posture. The hips offset (character space, m) comes with it.
 */
export function humanRotations(
  spec: HumanPoseSpec,
  stoop = 0,
  height = 1.7,
): { rot: Record<string, Vec3>; shift: Vec3 } {
  const rot: Record<string, Vec3> = {};
  const lean = (spec.lean ?? 0) + 7 * stoop;
  rot.hips = [r(-(spec.pelvis ?? 0)), r(spec.pelvisTurn), r(spec.pelvisRoll)];
  rot.spine = [r(lean * 0.45), r((spec.chestTwist ?? 0) * 0.4), r((spec.side ?? 0) * 0.5)];
  rot.chest = [r(lean * 0.55 + 6 * stoop), r((spec.chestTwist ?? 0) * 0.6), r((spec.side ?? 0) * 0.5)];
  rot.neck = [
    r((spec.neck ?? 0) + 10 * stoop),
    r((spec.headTurn ?? 0) * 0.35),
    r((spec.headTilt ?? 0) * 0.4),
  ];
  rot.head = [
    r((spec.head ?? 0) - 16 * stoop),
    r((spec.headTurn ?? 0) * 0.65),
    r((spec.headTilt ?? 0) * 0.6),
  ];
  for (const s of SIDES) {
    const out = s === 'L' ? -1 : 1; // sign of an outward swing about local Z
    const twist = s === 'L' ? 1 : -1; // sign of an inward (internal) twist about local Y
    rot[`thigh.${s}`] = [
      r(-pick(spec.hip, s) - 4 * stoop),
      r(twist * -pick(spec.hipTwist, s)),
      r(out * pick(spec.hipAbd, s)),
    ];
    rot[`shin.${s}`] = [r(pick(spec.knee, s) + 6 * stoop), 0, 0];
    rot[`foot.${s}`] = [r(pick(spec.ankle, s) - 2 * stoop), 0, 0];
    rot[`toe.${s}`] = [r(pick(spec.toe, s)), 0, 0];
    rot[`shoulder.${s}`] = [r(pick(spec.shrug, s)), 0, 0];
    rot[`upper_arm.${s}`] = [
      r(-pick(spec.arm, s) - 4 * stoop),
      r(twist * pick(spec.armTwist, s)),
      r(out * pick(spec.armOut, s)),
    ];
    rot[`forearm.${s}`] = [r(-pick(spec.elbow, s) - 8 * stoop), 0, 0];
    rot[`hand.${s}`] = [r(-pick(spec.wrist, s)), 0, 0];
  }
  const sh = spec.shift ?? [0, 0, 0];
  return { rot, shift: [sh[0] * height, sh[1] * height, sh[2] * height] };
}

/** Bone-local euler rotations (radians) of a quadruped pose. */
export function animalRotations(spec: AnimalPoseSpec): { rot: Record<string, Vec3>; shift: Vec3 } {
  const rot: Record<string, Vec3> = {};
  // body bones point forward (−Y): local X rotation pitches their front end down
  rot.hips = [r(spec.body), 0, 0];
  rot.spine = [r(spec.spine), 0, 0];
  rot.chest = [r(spec.chest), 0, 0];
  rot.neck = [r(-(spec.neck ?? 0)), r(spec.neckTurn), 0];
  rot.head = [r(-(spec.head ?? 0)), r(spec.headTurn), 0];
  // tail bones point back: local X rotation lifts them
  const tail = spec.tail ?? [0, 0, 0];
  rot['tail.1'] = [r(tail[0]), 0, r(spec.tailSide)];
  rot['tail.2'] = [r(tail[1]), 0, r((spec.tailSide ?? 0) * 0.6)];
  rot['tail.3'] = [r(tail[2]), 0, r((spec.tailSide ?? 0) * 0.4)];
  for (const leg of LEGS) {
    const a = spec.legs?.[leg] ?? {};
    const out = leg[1] === 'L' ? -1 : 1;
    // legs hang down: −X swings forward; front knees fold the cannon back (+X), hocks forward (−X)
    rot[`upper_leg.${leg}`] = [r(-(a.upper ?? 0)), 0, r(out * (a.abd ?? 0))];
    rot[`lower_leg.${leg}`] = [r(isFront(leg) ? (a.lower ?? 0) : -(a.lower ?? 0)), 0, 0];
    rot[`foot.${leg}`] = [r(a.foot), 0, 0];
  }
  // a body pitched at the hips keeps the front legs where they were, and most of the neck's angle
  if (spec.body) {
    for (const leg of ['FL', 'FR'] as const) rot[`upper_leg.${leg}`][0] -= r(spec.body);
    rot.neck[0] -= 0.8 * r(spec.body);
  }
  return { rot, shift: [0, 0, 0] };
}

// ---------------------------------------------------------------- grounding

interface RestCache {
  rest: Map<string, { matrix: Mat4; length: number }>;
  inv: Map<string, Mat4>;
}

const restCache = new WeakMap<ArmatureData, RestCache>();

function restOf(arm: ArmatureData): RestCache {
  let c = restCache.get(arm);
  if (!c) {
    const rest = restMatrices(arm.bones);
    const inv = new Map<string, Mat4>();
    for (const [n, m] of rest) inv.set(n, invert4(m.matrix));
    c = { rest, inv };
    restCache.set(arm, c);
  }
  return c;
}

/** Pose bones (armature data order) for rotations and a hips location (character space). */
export function poseBones(
  arm: ArmatureData,
  rot: Record<string, Vec3>,
  hipsShift: Vec3,
): Record<string, PoseBone> {
  const { inv } = restOf(arm);
  const out: Record<string, PoseBone> = {};
  for (const b of arm.bones) {
    let loc: Vec3 = [0, 0, 0];
    if (b.name === 'hips') {
      // a location is in the bone's rest axes
      const i = inv.get('hips');
      if (i) loc = transformDirection3(i, hipsShift);
    }
    out[b.name] = poseBone(rot[b.name] ?? [0, 0, 0], loc);
  }
  return out;
}

/** Armature-space points of the probes under a pose. */
export function probePoints(
  arm: ArmatureData,
  bones: Record<string, PoseBone>,
  probes: Blueprint['probes'],
): { point: Vec3; radius: number }[] {
  const deltas = poseDeltas(arm, bones);
  const out: { point: Vec3; radius: number }[] = [];
  for (const p of probes) {
    const d = deltas.get(p.bone);
    if (d) out.push({ point: transformPoint3(d, p.point), radius: p.radius });
  }
  return out;
}

/** Per bone, the armature-space matrix taking rest (character) space points to where a pose puts them. */
function poseDeltas(arm: ArmatureData, bones: Record<string, PoseBone>): Map<string, Mat4> {
  const pose = computePose(arm, bones, { frame: 0, armatureMatrix: identity4(), getWorldMatrix: () => null });
  const { inv } = restOf(arm);
  const out = new Map<string, Mat4>();
  for (const [name, b] of pose.bones) {
    const i = inv.get(name);
    if (i) out.set(name, multiply4(b.matrix, i));
  }
  return out;
}

/** The lowest height (armature space) of the probes and the parts' surface under a pose. */
export function lowestPoint(
  arm: ArmatureData,
  bones: Record<string, PoseBone>,
  probes: Blueprint['probes'],
  surface: readonly PartSurface[] = [],
): number {
  const deltas = poseDeltas(arm, bones);
  let low = Infinity;
  for (const p of probes) {
    const d = deltas.get(p.bone);
    if (d) low = Math.min(low, transformPoint3(d, p.point)[2] - p.radius);
  }
  for (const s of surface) {
    const d = deltas.get(s.bone);
    if (!d) continue;
    const pos = s.pos;
    for (let i = 0; i + 2 < pos.length; i += 3)
      low = Math.min(low, d[2] * pos[i] + d[6] * pos[i + 1] + d[10] * pos[i + 2] + d[14]);
  }
  return low;
}

/**
 * Grounds a pose: the hips move so the lowest probe or part surface point touches z = 0 (plus
 * `lift`), unless `ground` is 'none'. Returns the pose bones with the hips location set.
 */
export function groundedPose(
  arm: ArmatureData,
  probes: Blueprint['probes'],
  rot: Record<string, Vec3>,
  shift: Vec3,
  ground: 'lowest' | 'none' = 'lowest',
  lift = 0,
  surface: readonly PartSurface[] = [],
): Record<string, PoseBone> {
  const first = poseBones(arm, rot, shift);
  if (ground === 'none') return first;
  const low = lowestPoint(arm, first, probes, surface);
  if (!Number.isFinite(low)) return first;
  return poseBones(arm, rot, [shift[0], shift[1], shift[2] - low + lift]);
}
