import type { Vec3 } from '../../math/types';
import { normalize3 } from '../../math/vec3';
import type { MeshBuilder } from '../../generate/builder';
import {
  DEG,
  MAT_ACCENT,
  MAT_BODY,
  MAT_DARK,
  MAT_LIGHT,
  ball,
  capsule,
  ellipsoid,
  frameAlong,
  loft,
  v,
  vadd,
  vlerp,
  vscale,
  vsub,
  type Blueprint,
  type BoneSpec,
  type GroundProbe,
  type PartSpec,
  type Section,
} from './rig';

/*
 * Quadruped actors (spec §8): one parametric four-legged body built from the same bones for every
 * species — root, hips, spine, chest, neck, head, tail.1..3, upper_leg / lower_leg / foot per leg
 * (FL, FR, BL, BR) and a `saddle` on rideable kinds. Sizes are fractions of the height at the
 * withers H (the height animals are measured by). Front legs bend at the knee (the cannon folds
 * back), hind legs at the hock (it points back). The rideable kinds (horse, pony, donkey, cow) wear
 * a saddle (accent colour); hooves, manes, ears and antlers are dark, eyes light so the head's
 * facing reads. Each species is a preset of the same parameters (BUILDS) with its own ears, head,
 * tail and extras (horns, antlers, a black face).
 */

export type QuadrupedKind =
  'horse' | 'pony' | 'donkey' | 'cow' | 'dog' | 'small_dog' | 'cat' | 'sheep' | 'pig' | 'deer' | 'bear';

/** Legs of a quadruped: front/back × left/right. */
export const LEGS = ['FL', 'FR', 'BL', 'BR'] as const;
export type Leg = (typeof LEGS)[number];
export const legSide = (leg: Leg): 1 | -1 => (leg[1] === 'L' ? 1 : -1);
export const isFront = (leg: Leg): boolean => leg[0] === 'F';

/** Tail shapes: per segment the angle above the horizontal backwards (degrees) and radius (fraction of H). */
const TAILS = {
  /** a horse's hair, hanging further down each segment (dark) */
  hair: { angles: [-30, -62, -82], radii: [0.06, 0.07, 0.06], dark: [true, true, true], flat: 0.55 },
  /** a dog's, rising in a curve */
  up: { angles: [38, 22, 2], radii: [0.065, 0.05, 0.03], dark: [false, false, false], flat: 1 },
  /** a cat's, held up and curling forward at the tip */
  raised: { angles: [50, 78, 128], radii: [0.06, 0.055, 0.05], dark: [false, false, false], flat: 1 },
  /** a short stub (deer, sheep, bears) */
  stub: { angles: [30, 10, -10], radii: [0.06, 0.05, 0.035], dark: [false, false, false], flat: 0.8 },
  /** a pig's, curled */
  curl: { angles: [40, -50, -150], radii: [0.025, 0.022, 0.02], dark: [false, false, false], flat: 1 },
  /** cattle and donkeys: a thin hanging tail ending in a dark tuft */
  tuft: { angles: [-55, -80, -88], radii: [0.025, 0.02, 0.045], dark: [false, false, true], flat: 0.8 },
} as const;
type TailShape = keyof typeof TAILS;

interface QuadBuild {
  /** Default height at the withers (m). */
  height: number;
  /** Fractions of H. Barrel: centre height, half-height, half-width, front and rear extent (y). */
  barrelZ: number;
  barrelR: number;
  barrelW: number;
  bodyFront: number;
  bodyRear: number;
  /** Legs: x offset, front / hind y, joint heights. */
  legX: number;
  frontY: number;
  backY: number;
  elbowZ: number;
  kneeZ: number;
  hipZ: number;
  hockZ: number;
  hockBack: number;
  fetlockZ: number;
  /** Leg radii: upper, lower. */
  legR: number;
  cannonR: number;
  /** Neck: length, angle above horizontal (deg), radii at base and top. */
  neckLen: number;
  neckAngle: number;
  neckR0: number;
  neckR1: number;
  /** Head: length, angle below horizontal (deg), cheek radius, muzzle radius. */
  headLen: number;
  headAngle: number;
  headR: number;
  muzzleR: number;
  /**
   * Ears (ears()): pricked up (horses, donkeys, cats), a dog's folded flaps, wide (big flat ears up
   * and out, deer), hanging, sticking out sideways (cattle, sheep) or round (bears).
   */
  ears: 'up' | 'fold' | 'wide' | 'floppy' | 'side' | 'round';
  earLen: number;
  earR: number;
  /** Two short horns beside the ears (cattle). */
  horns?: boolean;
  /** Branched antlers (a stag). */
  antlers?: boolean;
  /** A dark face and dark legs below the knees and hocks (a black-faced sheep). */
  darkPoints?: boolean;
  /**
   * Head shape: a long tapering horse head, a dog's skull with a stop and a short muzzle, or a
   * pig's head ending in a flat disc.
   */
  snout: 'long' | 'short' | 'pig';
  /** Heights of the leg roots inside the body (the legs swing from there). */
  frontRootZ: number;
  hindRootZ: number;
  /** Tail: total length and shape (TAILS). */
  tailLen: number;
  tail: TailShape;
  feet: 'hoof' | 'paw';
  mane: boolean;
  saddle: boolean;
}

const HORSE: QuadBuild = {
  height: 1.6,
  barrelZ: 0.73,
  barrelR: 0.22,
  barrelW: 0.19,
  bodyFront: -0.5,
  bodyRear: 0.52,
  legX: 0.105,
  frontY: -0.33,
  backY: 0.36,
  elbowZ: 0.6,
  kneeZ: 0.32,
  hipZ: 0.64,
  hockZ: 0.36,
  hockBack: 0.07,
  fetlockZ: 0.09,
  legR: 0.065,
  cannonR: 0.032,
  neckLen: 0.56,
  neckAngle: 52,
  neckR0: 0.15,
  neckR1: 0.075,
  headLen: 0.38,
  headAngle: 52,
  headR: 0.085,
  muzzleR: 0.055,
  ears: 'up',
  earLen: 0.09,
  earR: 0.022,
  snout: 'long',
  frontRootZ: 0.86,
  hindRootZ: 0.88,
  tailLen: 0.55,
  tail: 'hair',
  feet: 'hoof',
  mane: true,
  saddle: true,
};

const PONY: QuadBuild = {
  ...HORSE,
  height: 1.2,
  barrelZ: 0.7,
  barrelR: 0.245,
  barrelW: 0.22,
  bodyFront: -0.48,
  bodyRear: 0.5,
  elbowZ: 0.56,
  kneeZ: 0.3,
  hipZ: 0.6,
  hockZ: 0.33,
  legR: 0.075,
  cannonR: 0.04,
  neckLen: 0.5,
  neckAngle: 48,
  neckR0: 0.17,
  neckR1: 0.09,
  headLen: 0.42,
  headR: 0.1,
  muzzleR: 0.065,
  earLen: 0.1,
  tailLen: 0.6,
};

const DOG: QuadBuild = {
  height: 0.55,
  barrelZ: 0.72,
  barrelR: 0.19,
  barrelW: 0.16,
  bodyFront: -0.52,
  bodyRear: 0.52,
  legX: 0.11,
  frontY: -0.36,
  backY: 0.4,
  elbowZ: 0.55,
  kneeZ: 0.3,
  hipZ: 0.62,
  hockZ: 0.26,
  hockBack: 0.1,
  fetlockZ: 0.08,
  legR: 0.06,
  cannonR: 0.04,
  neckLen: 0.24,
  neckAngle: 52,
  neckR0: 0.125,
  neckR1: 0.095,
  headLen: 0.4,
  headAngle: 6,
  headR: 0.125,
  muzzleR: 0.068,
  ears: 'fold',
  earLen: 0.15,
  earR: 0.06,
  snout: 'short',
  frontRootZ: 0.82,
  hindRootZ: 0.84,
  tailLen: 0.45,
  tail: 'up',
  feet: 'paw',
  mane: false,
  saddle: false,
};

const BUILDS: Record<QuadrupedKind, QuadBuild> = {
  horse: HORSE,
  pony: PONY,
  dog: DOG,
  donkey: {
    ...PONY,
    height: 1.1,
    legR: 0.062,
    cannonR: 0.03,
    neckLen: 0.46,
    neckAngle: 42,
    neckR0: 0.16,
    neckR1: 0.085,
    headLen: 0.48,
    headAngle: 55,
    headR: 0.105,
    muzzleR: 0.072,
    earLen: 0.25,
    earR: 0.04,
    tailLen: 0.55,
    tail: 'tuft',
  },
  cow: {
    ...HORSE,
    height: 1.4,
    barrelZ: 0.66,
    barrelR: 0.3,
    barrelW: 0.27,
    bodyFront: -0.6,
    bodyRear: 0.62,
    legX: 0.13,
    frontY: -0.42,
    backY: 0.45,
    elbowZ: 0.5,
    kneeZ: 0.27,
    hipZ: 0.56,
    hockZ: 0.32,
    hockBack: 0.06,
    fetlockZ: 0.08,
    legR: 0.072,
    cannonR: 0.04,
    neckLen: 0.3,
    neckAngle: 22,
    neckR0: 0.19,
    neckR1: 0.13,
    headLen: 0.4,
    headAngle: 62,
    headR: 0.115,
    muzzleR: 0.09,
    ears: 'side',
    earLen: 0.13,
    earR: 0.045,
    horns: true,
    frontRootZ: 0.8,
    hindRootZ: 0.82,
    tailLen: 0.62,
    tail: 'tuft',
    mane: false,
  },
  small_dog: {
    ...DOG,
    height: 0.3,
    barrelZ: 0.7,
    barrelR: 0.22,
    barrelW: 0.19,
    bodyFront: -0.56,
    bodyRear: 0.56,
    elbowZ: 0.5,
    kneeZ: 0.28,
    hipZ: 0.56,
    hockZ: 0.26,
    legR: 0.08,
    cannonR: 0.05,
    neckLen: 0.26,
    neckR0: 0.15,
    neckR1: 0.12,
    headLen: 0.46,
    headR: 0.17,
    muzzleR: 0.075,
    ears: 'floppy',
    earLen: 0.2,
    earR: 0.07,
    tailLen: 0.42,
  },
  cat: {
    ...DOG,
    height: 0.25,
    barrelZ: 0.7,
    barrelR: 0.22,
    barrelW: 0.18,
    bodyFront: -0.62,
    bodyRear: 0.62,
    legX: 0.1,
    frontY: -0.44,
    backY: 0.46,
    elbowZ: 0.55,
    kneeZ: 0.3,
    hipZ: 0.62,
    hockZ: 0.28,
    hockBack: 0.1,
    legR: 0.06,
    cannonR: 0.04,
    neckLen: 0.24,
    neckAngle: 48,
    neckR0: 0.13,
    neckR1: 0.11,
    headLen: 0.24,
    headAngle: 8,
    headR: 0.19,
    muzzleR: 0.075,
    ears: 'up',
    earLen: 0.13,
    earR: 0.075,
    tailLen: 0.85,
    tail: 'raised',
  },
  sheep: {
    ...HORSE,
    height: 0.75,
    barrelZ: 0.7,
    barrelR: 0.31,
    barrelW: 0.29,
    bodyFront: -0.52,
    bodyRear: 0.52,
    legX: 0.11,
    frontY: -0.36,
    backY: 0.4,
    elbowZ: 0.46,
    kneeZ: 0.26,
    hipZ: 0.52,
    hockZ: 0.3,
    hockBack: 0.08,
    fetlockZ: 0.08,
    legR: 0.055,
    cannonR: 0.034,
    neckLen: 0.28,
    neckAngle: 42,
    neckR0: 0.17,
    neckR1: 0.12,
    headLen: 0.32,
    headAngle: 50,
    headR: 0.11,
    muzzleR: 0.07,
    ears: 'side',
    earLen: 0.12,
    earR: 0.04,
    darkPoints: true,
    frontRootZ: 0.8,
    hindRootZ: 0.82,
    tailLen: 0.16,
    tail: 'stub',
    mane: false,
    saddle: false,
  },
  pig: {
    ...HORSE,
    height: 0.65,
    barrelZ: 0.66,
    barrelR: 0.3,
    barrelW: 0.27,
    bodyFront: -0.6,
    bodyRear: 0.58,
    legX: 0.12,
    frontY: -0.4,
    backY: 0.42,
    elbowZ: 0.4,
    kneeZ: 0.22,
    hipZ: 0.46,
    hockZ: 0.24,
    hockBack: 0.05,
    fetlockZ: 0.07,
    legR: 0.07,
    cannonR: 0.045,
    neckLen: 0.18,
    neckAngle: 18,
    neckR0: 0.22,
    neckR1: 0.18,
    headLen: 0.42,
    headAngle: 22,
    headR: 0.16,
    muzzleR: 0.1,
    ears: 'floppy',
    earLen: 0.15,
    earR: 0.05,
    snout: 'pig',
    frontRootZ: 0.78,
    hindRootZ: 0.8,
    tailLen: 0.16,
    tail: 'curl',
    mane: false,
    saddle: false,
  },
  deer: {
    ...HORSE,
    height: 1.0,
    barrelR: 0.2,
    barrelW: 0.16,
    bodyFront: -0.48,
    bodyRear: 0.48,
    legR: 0.05,
    cannonR: 0.022,
    neckLen: 0.44,
    neckAngle: 56,
    neckR0: 0.11,
    neckR1: 0.07,
    headLen: 0.32,
    headAngle: 42,
    headR: 0.085,
    muzzleR: 0.045,
    ears: 'wide',
    earLen: 0.15,
    earR: 0.05,
    antlers: true,
    tailLen: 0.14,
    tail: 'stub',
    mane: false,
    saddle: false,
  },
  bear: {
    ...DOG,
    height: 1.05,
    barrelZ: 0.66,
    barrelR: 0.3,
    barrelW: 0.27,
    bodyFront: -0.62,
    bodyRear: 0.58,
    legX: 0.14,
    frontY: -0.42,
    backY: 0.42,
    elbowZ: 0.42,
    kneeZ: 0.22,
    hipZ: 0.5,
    hockZ: 0.2,
    hockBack: 0.04,
    fetlockZ: 0.08,
    legR: 0.1,
    cannonR: 0.07,
    neckLen: 0.24,
    neckAngle: 25,
    neckR0: 0.2,
    neckR1: 0.16,
    headLen: 0.36,
    headAngle: 15,
    headR: 0.15,
    muzzleR: 0.08,
    ears: 'round',
    earLen: 0.07,
    earR: 0.055,
    frontRootZ: 0.8,
    hindRootZ: 0.82,
    tailLen: 0.08,
    tail: 'stub',
  },
};

export const QUADRUPED_DEFAULT_HEIGHTS: Record<QuadrupedKind, number> = Object.fromEntries(
  Object.entries(BUILDS).map(([k, b]) => [k, b.height]),
) as Record<QuadrupedKind, number>;

/**
 * An ear flap: a flattened, rounded capsule from `a` to `c` (half-width r0 at the base, r1 at the
 * tip) whose flat faces look along `face`, `thin` of its width thick.
 */
function flap(
  b: MeshBuilder,
  a: Readonly<Vec3>,
  c: Readonly<Vec3>,
  r0: number,
  r1: number,
  thin: number,
  face: Readonly<Vec3>,
  mat: number,
): void {
  capsule(b, a, c, r0, r1, mat, { segs: 8, rings: 2, sx: thin, side: face as Vec3 });
}

/**
 * One ear of a quadruped at `base` on the skull (side `sd`; head frame `f`: u forward along the
 * head, x to the left, −z up). Ears are soft flaps in the body colour (a dark face's own colour on a
 * black-faced sheep) with a darker inside where it shows, so a close-up reads them as ears, never as
 * horns: pricked leaves turned forward (horses, donkeys, cats), a dog's flap standing up and out
 * with its tip folded forward, big flaps up and out (deer), flaps out to the side (cattle, sheep),
 * flaps hanging beside the head (small dogs, pigs) and round ears (bears).
 */
function ears(
  b: MeshBuilder,
  P: QuadBuild,
  base: Vec3,
  sd: number,
  f: { u: Vec3; x: Vec3; z: Vec3 },
  s: (x: number) => number,
): void {
  const up = vscale(f.z, -1);
  const out = vscale(f.x, sd);
  const fwd = f.u;
  const dir = (a: number, o: number, w: number): Vec3 =>
    normalize3(vadd(vadd(vscale(up, a), vscale(out, o)), vscale(fwd, w)));
  const at = (p: Vec3, d: Vec3, l: number): Vec3 => vadd(p, vscale(d, l));
  // `d` made square to the axis `a` (a flap's face across its length)
  const across = (d: Vec3, a: Vec3): Vec3 =>
    normalize3(vsub(d, vscale(a, d[0] * a[0] + d[1] * a[1] + d[2] * a[2])));
  const L = s(P.earLen);
  const R = s(P.earR);
  const skin = P.darkPoints ? MAT_DARK : MAT_BODY;
  // the darker inside of a flap from a to c (radii r0 → r1, `thin` thick): a thinner, narrower
  // flap over 12–80% of its length, just proud of the face it looks along (`face`)
  const inside = (a: Vec3, c: Vec3, r0: number, r1: number, thin: number, face: Vec3) => {
    const n = normalize3(face);
    const end = (t: number) => {
      const r = r0 + t * (r1 - r0);
      return { p: vadd(vlerp(a, c, t), vscale(n, 0.75 * thin * r)), r: 0.6 * r };
    };
    const e0 = end(0.12);
    const e1 = end(0.8);
    flap(b, e0.p, e1.p, e0.r, e1.r, 0.5 * thin, face, MAT_DARK);
  };
  switch (P.ears) {
    case 'up': {
      // a leaf standing up, leaning a little out and back, its hollow turned forward
      const tip = at(base, dir(1, 0.2, -0.12), L);
      const face = dir(0.1, 0.35, 1);
      flap(b, base, tip, R, 0.3 * R, 0.4, face, skin);
      inside(base, tip, R, 0.3 * R, 0.4, face);
      return;
    }
    case 'fold': {
      // a wide flap standing up and out from the back of the skull, its top folded forward over
      // a hinge across it (the folded part's hollow turned down)
      const d1 = dir(1, 0.75, -0.15);
      const f1 = across(dir(0, 0.4, 1), d1);
      const mid = at(base, d1, 0.62 * L);
      const fold = 40 * DEG;
      const d2 = normalize3(vadd(vscale(d1, Math.cos(fold)), vscale(f1, Math.sin(fold))));
      const f2 = normalize3(vsub(vscale(f1, Math.cos(fold)), vscale(d1, Math.sin(fold))));
      flap(b, base, mid, R, 0.85 * R, 0.3, f1, skin);
      flap(b, mid, at(mid, d2, 0.36 * L), 0.85 * R, 0.5 * R, 0.3, f2, skin);
      inside(base, mid, R, 0.85 * R, 0.3, f1);
      return;
    }
    case 'wide': {
      // big flat ears turned forward, standing up and out
      const tip = at(base, dir(0.75, 0.65, 0), L);
      const face = dir(0, 0.3, 1);
      capsule(b, base, tip, 0.6 * R, R, skin, { segs: 8, rings: 2, sx: 0.35, cap1: 1.4, side: face });
      inside(base, tip, 0.6 * R, R, 0.35, face);
      return;
    }
    case 'side': {
      // flaps sticking out sideways and a little down (cattle, sheep), their hollow forward
      const tip = at(base, dir(-0.35, 1, 0), L);
      const face = dir(-0.3, 0, 1);
      flap(b, base, tip, R, 0.7 * R, 0.4, face, skin);
      inside(base, tip, R, 0.7 * R, 0.4, face);
      return;
    }
    case 'round': {
      // a round ear on the crown, its hollow forward
      const c = at(base, up, 0.4 * R);
      ellipsoid(b, c, v(R, R, R), skin, 1);
      ellipsoid(b, at(c, fwd, 0.55 * R), v(0.6 * R, 0.6 * R, 0.6 * R), MAT_DARK, 1);
      return;
    }
    case 'floppy': {
      // flaps hanging beside the head, a little forward
      const tip = vadd(base, vadd(vscale(out, s(0.05)), vadd(vscale(up, -L), vscale(fwd, s(0.02)))));
      capsule(b, base, tip, R, 0.85 * R, skin, { segs: 8, rings: 2, sz: 0.35, side: fwd });
      return;
    }
  }
}

/** Whether a quadruped kind is built with a saddle bone. */
export function quadrupedHasSaddle(kind: QuadrupedKind): boolean {
  return BUILDS[kind].saddle;
}

/** Bone layout and parts of a quadruped kind with height `H` at the withers. */
export function quadrupedBlueprint(kind: QuadrupedKind, H: number): Blueprint {
  const P = BUILDS[kind];
  const s = (x: number) => x * H;
  const bz = s(P.barrelZ);
  const front = s(P.bodyFront);
  const rear = s(P.bodyRear);
  const midF = front * 0.3;
  const midR = rear * 0.3;
  // spine line: hips (rump → mid back), spine (mid back), chest (→ chest front)
  const hipsHead = v(0, rear - s(0.06), bz + s(0.02));
  const spineHead = v(0, midR, bz + s(0.01));
  const chestHead = v(0, midF, bz);
  const chestTail = v(0, front + s(0.08), bz + s(0.02));
  const neckBase = v(0, front + s(0.1), bz + s(P.barrelR * 0.55));
  const na = P.neckAngle * DEG;
  const neckTop = vadd(neckBase, v(0, -s(P.neckLen) * Math.cos(na), s(P.neckLen) * Math.sin(na)));
  const ha = P.headAngle * DEG;
  const headTip = vadd(neckTop, v(0, -s(P.headLen) * Math.cos(ha), -s(P.headLen) * Math.sin(ha)));
  const tailBase = v(0, rear - s(0.02), bz + s(P.barrelR * 0.55));
  const tailShape = TAILS[P.tail];
  const tailDir = (k: number): Vec3 => {
    const ang = tailShape.angles[k];
    const len = s(P.tailLen) / 3;
    return v(0, len * Math.cos(ang * DEG), len * Math.sin(ang * DEG));
  };
  const tail1 = vadd(tailBase, tailDir(0));
  const tail2 = vadd(tail1, tailDir(1));
  const tail3 = vadd(tail2, tailDir(2));

  const bones: BoneSpec[] = [
    { name: 'root', parent: null, head: v(0, 0, 0), tail: v(0, s(0.25), 0) },
    { name: 'hips', parent: 'root', head: hipsHead, tail: spineHead },
    { name: 'spine', parent: 'hips', head: spineHead, tail: chestHead, connect: true },
    { name: 'chest', parent: 'spine', head: chestHead, tail: chestTail, connect: true },
    { name: 'neck', parent: 'chest', head: neckBase, tail: neckTop },
    { name: 'head', parent: 'neck', head: neckTop, tail: headTip, connect: true },
    { name: 'tail.1', parent: 'hips', head: tailBase, tail: tail1 },
    { name: 'tail.2', parent: 'tail.1', head: tail1, tail: tail2, connect: true },
    { name: 'tail.3', parent: 'tail.2', head: tail2, tail: tail3, connect: true },
  ];
  // leg joints (character space)
  const joints = (leg: (typeof LEGS)[number]) => {
    const x = legSide(leg) * s(P.legX);
    if (isFront(leg)) {
      const y = s(P.frontY);
      return {
        top: v(x, y, s(P.frontRootZ)),
        vis: v(x, y, s(P.elbowZ)),
        mid: v(x, y, s(P.kneeZ)),
        low: v(x, y, s(P.fetlockZ)),
        tip: v(x, y - s(0.035), 0),
      };
    }
    const y = s(P.backY);
    return {
      top: v(x, y - s(0.03), s(P.hindRootZ)),
      vis: v(x, y - s(0.03), s(P.hipZ)),
      mid: v(x, y + s(P.hockBack), s(P.hockZ)),
      low: v(x, y + s(0.03), s(P.fetlockZ)),
      tip: v(x, y, 0),
    };
  };
  for (const leg of LEGS) {
    const j = joints(leg);
    const parent = isFront(leg) ? 'chest' : 'hips';
    bones.push(
      { name: `upper_leg.${leg}`, parent, head: j.top, tail: j.mid },
      { name: `lower_leg.${leg}`, parent: `upper_leg.${leg}`, head: j.mid, tail: j.low, connect: true },
      { name: `foot.${leg}`, parent: `lower_leg.${leg}`, head: j.low, tail: j.tip, connect: true },
    );
  }
  const seat = v(0, -s(0.1), bz + s(P.barrelR) + s(0.035));
  if (P.saddle)
    bones.push({ name: 'saddle', parent: 'spine', head: seat, tail: vadd(seat, v(0, -s(0.2), 0)) });

  // ---- parts
  const W = s(P.barrelW);
  const R = s(P.barrelR);
  const bodyPart =
    (y0: number, y1: number, secs: [number, number, number, number][]) =>
    (b: MeshBuilder): void => {
      // frame along −Y (forward) with z pointing down: oz < 0 lifts a section
      const f = frameAlong(v(0, y0, bz), v(0, y1, bz));
      const len = y0 - y1;
      loft(
        b,
        f,
        secs.map(([t, wf, hf, lift]) => ({ t: t * len, rx: W * wf, rz: R * hf, oz: -lift * R })),
        16,
        MAT_BODY,
      );
    };
  const parts: PartSpec[] = [
    {
      bone: 'hips',
      build: bodyPart(rear + s(0.02), midR - s(0.08), [
        [0, 0, 0, 0.1],
        [0.06, 0.62, 0.62, 0.12],
        [0.2, 0.92, 0.9, 0.08],
        [0.45, 1, 1, 0.04],
        [0.75, 0.98, 1, 0],
        [0.95, 0.9, 0.92, 0],
        [1, 0, 0, 0],
      ]),
    },
    {
      bone: 'spine',
      build: bodyPart(midR + s(0.06), midF - s(0.06), [
        [0, 0, 0, 0],
        [0.04, 0.88, 0.9, 0],
        [0.2, 1, 1, -0.02],
        [0.5, 1.02, 1.03, -0.03],
        [0.8, 1, 1.02, -0.02],
        [0.96, 0.9, 0.9, 0],
        [1, 0, 0, 0],
      ]),
    },
    {
      bone: 'chest',
      build: bodyPart(midF + s(0.06), front - s(0.02), [
        [0, 0, 0, 0],
        [0.05, 0.9, 0.9, 0],
        [0.3, 1, 1.02, 0],
        [0.65, 0.92, 0.98, 0.05],
        [0.88, 0.7, 0.8, 0.12],
        [1, 0, 0, 0.15],
      ]),
    },
    {
      bone: 'neck',
      build: (b) => {
        capsule(b, vadd(neckBase, v(0, s(0.02), -s(0.04))), neckTop, s(P.neckR0), s(P.neckR1), MAT_BODY, {
          sx: 0.62,
          rings: 3,
          cap0: 0.5,
          cap1: 0.8,
        });
        if (P.mane) {
          // a dark crest along the top of the neck
          const up = v(0, Math.sin(na), Math.cos(na));
          capsule(
            b,
            vadd(neckBase, vadd(vscale(up, s(P.neckR0) * 0.8), v(0, s(0.04), 0))),
            vadd(neckTop, vscale(up, s(P.neckR1) * 0.9)),
            s(0.035),
            s(0.03),
            MAT_DARK,
            { sx: 0.45, rings: 2, segs: 8 },
          );
        }
      },
    },
    {
      bone: 'head',
      build: (b) => {
        const f = frameAlong(neckTop, headTip);
        // frame x is the side (+X); z = x × u points to the jaw (down/back for a forward head),
        // so `up` below is −z
        const len = s(P.headLen);
        const hr = s(P.headR);
        const mr = s(P.muzzleR);
        const secs: Section[] =
          P.snout === 'pig'
            ? [
                // a round head running straight into a broad snout ending in a flat disc
                { t: -0.45 * hr, rx: 0, rz: 0 },
                { t: -0.25 * hr, rx: 0.8 * hr, rz: 0.8 * hr },
                { t: 0.15 * len, rx: hr, rz: hr, oz: -0.05 * hr },
                { t: 0.45 * len, rx: 0.85 * hr, rz: 0.85 * hr, oz: 0.05 * hr },
                { t: 0.8 * len, rx: 1.05 * mr, rz: mr, oz: 0.12 * hr },
                { t: len, rx: 1.1 * mr, rz: 1.05 * mr, oz: 0.12 * hr },
                { t: len + 0.02 * mr, rx: 0, rz: 0, oz: 0.12 * hr },
              ]
            : P.snout === 'long'
              ? [
                  { t: -0.35 * hr, rx: 0, rz: 0 },
                  { t: -0.15 * hr, rx: 0.75 * hr, rz: 0.8 * hr },
                  { t: 0.15 * len, rx: 0.95 * hr, rz: 1.05 * hr, oz: 0.12 * hr },
                  { t: 0.35 * len, rx: 0.8 * hr, rz: 0.95 * hr, oz: 0.06 * hr },
                  { t: 0.65 * len, rx: 0.95 * mr, rz: 1.1 * mr },
                  { t: 0.92 * len, rx: mr, rz: 1.05 * mr, oz: 0.05 * mr },
                  { t: len, rx: 0.75 * mr, rz: 0.85 * mr, oz: 0.05 * mr },
                  { t: len + 0.35 * mr, rx: 0, rz: 0, oz: 0.05 * mr },
                ]
              : [
                  // a round skull, a stop, then a narrower muzzle set lower
                  { t: -0.45 * hr, rx: 0, rz: 0, oz: -0.1 * hr },
                  { t: -0.25 * hr, rx: 0.78 * hr, rz: 0.8 * hr, oz: -0.1 * hr },
                  { t: 0.12 * len, rx: hr, rz: hr, oz: -0.08 * hr },
                  { t: 0.36 * len, rx: 0.9 * hr, rz: 0.92 * hr, oz: 0 },
                  { t: 0.5 * len, rx: 1.05 * mr, rz: 1.2 * mr, oz: 0.3 * hr },
                  { t: 0.85 * len, rx: mr, rz: 1.05 * mr, oz: 0.34 * hr },
                  { t: len, rx: 0.8 * mr, rz: 0.85 * mr, oz: 0.34 * hr },
                  { t: len + 0.3 * mr, rx: 0, rz: 0, oz: 0.34 * hr },
                ];
        loft(b, f, secs, 12, P.darkPoints ? MAT_DARK : MAT_BODY);
        const along = (t: number, side: number, up: number) =>
          vadd(vadd(vadd(neckTop, vscale(f.u, t)), vscale(f.x, side)), vscale(f.z, -up));
        for (const sd of [1, -1]) {
          // eyes on the sides, light so the facing reads; the ears (ears())
          const eyeT = P.snout === 'long' ? 0.2 * len : 0.3 * len;
          ball(b, along(eyeT, sd * 0.8 * hr, 0.35 * hr), 0.2 * hr, MAT_LIGHT, 1);
          ball(b, along(eyeT + 0.04 * hr, sd * 0.88 * hr, 0.38 * hr), 0.11 * hr, MAT_DARK, 1);
          ears(b, P, along(-0.05 * hr, sd * 0.55 * hr, 0.75 * hr), sd, f, s);
          if (P.horns) {
            // short light horns curving out and up between the ears
            const base = along(-0.15 * hr, sd * 0.35 * hr, 0.85 * hr);
            const tip = vadd(base, vadd(vscale(f.x, sd * 0.09 * H), vscale(f.z, -0.05 * H)));
            capsule(b, base, tip, 0.025 * H, 0.008 * H, MAT_LIGHT, { segs: 6, rings: 1 });
          }
          if (P.antlers) {
            // a beam rising up, out and back from between the ears, two tines pointing forward
            // (character space: +Z up, +Y back)
            const base = along(0.05 * hr, sd * 0.35 * hr, 0.8 * hr);
            const p1 = vadd(base, v(sd * s(0.05), s(0.02), s(0.12)));
            const p2 = vadd(p1, v(sd * s(0.05), s(0.05), s(0.11)));
            const p3 = vadd(p2, v(-sd * s(0.01), s(0.03), s(0.1)));
            const r0 = s(0.016);
            capsule(b, base, p1, r0, 0.85 * r0, MAT_DARK, { segs: 6, rings: 1 });
            capsule(b, p1, p2, 0.85 * r0, 0.7 * r0, MAT_DARK, { segs: 6, rings: 1 });
            capsule(b, p2, p3, 0.7 * r0, 0.35 * r0, MAT_DARK, { segs: 6, rings: 1 });
            for (const [from, tine] of [
              [p1, v(sd * s(0.01), -s(0.08), s(0.06))],
              [p2, v(sd * s(0.02), -s(0.06), s(0.08))],
            ] as const)
              capsule(b, from, vadd(from, tine), 0.6 * r0, 0.3 * r0, MAT_DARK, { segs: 6, rings: 1 });
          }
          // nostrils
          if (P.snout === 'long')
            ball(b, along(len + 0.05 * mr, sd * 0.4 * mr, 0.25 * mr), 0.18 * mr, MAT_DARK, 1);
        }
        if (P.snout === 'short') {
          // a dark nose at the tip of the muzzle
          ball(b, along(len + 0.15 * mr, 0, -0.34 * hr + 0.45 * mr), 0.42 * mr, MAT_DARK, 1);
        } else if (P.snout === 'pig') {
          // the snout's flat disc with two nostrils
          const disc = along(len + 0.03 * mr, 0, -0.12 * hr);
          ellipsoid(b, disc, v(0.9 * mr, 0.9 * mr, 0.9 * mr), MAT_LIGHT, 1);
          for (const sd of [1, -1])
            ball(b, along(len + 0.1 * mr, sd * 0.35 * mr, -0.12 * hr), 0.2 * mr, MAT_DARK, 1);
        }
      },
    },
  ];
  const tailPts = [tailBase, tail1, tail2, tail3];
  for (let k = 0; k < 3; k++) {
    const a = tailPts[k];
    const c = tailPts[k + 1];
    const r = s(tailShape.radii[k]);
    parts.push({
      bone: `tail.${k + 1}`,
      build: (b) =>
        capsule(b, a, c, r, r * (k === 2 ? 0.5 : 0.95), tailShape.dark[k] ? MAT_DARK : MAT_BODY, {
          segs: 8,
          rings: 2,
          sx: tailShape.flat,
        }),
    });
  }
  // a round part's radius at a joint near the floor: no larger than the joint's height, so a
  // standing leg's pastern or fetlock never dips below the sole (the feet stand on their probes)
  const above = (r: number, at: Vec3) => Math.min(r, 0.9 * at[2]);
  for (const leg of LEGS) {
    const j = joints(leg);
    const fr = isFront(leg);
    const upR = s(P.legR) * (fr ? 1 : 1.25);
    const loR = s(P.cannonR);
    parts.push(
      {
        bone: `upper_leg.${leg}`,
        build: (b) => {
          // the leg grows out of the body: thick where it leaves the body, then narrowing fast
          // (r falls as (1 − t)^p, not linearly) to a slim forearm or gaskin above the knee / hock
          const top = vadd(j.vis, v(0, 0, s(fr ? 0.1 : 0.12)));
          const r0 = upR * (fr ? 1.3 : 1.5);
          const r1 = loR * 1.25;
          const p = fr ? 1.6 : 2;
          capsule(b, top, j.mid, r0, r1, MAT_BODY, {
            sz: fr ? 1.15 : 1.4,
            rings: 4,
            side: v(1, 0, 0),
            bulge: (t) => (r1 + (r0 - r1) * (1 - t) ** p) / (r0 + (r1 - r0) * t) - 1,
          });
          ball(b, j.mid, loR * 1.4, MAT_DARK, 1);
        },
      },
      {
        bone: `lower_leg.${leg}`,
        build: (b) => {
          const mat = P.darkPoints ? MAT_DARK : MAT_BODY;
          capsule(b, j.mid, j.low, loR * 1.1, above(loR, j.low), mat, { rings: 2, segs: 8 });
          ball(b, j.low, above(loR * 1.25, j.low), MAT_DARK, 1);
        },
      },
      {
        bone: `foot.${leg}`,
        build: (b) => {
          if (P.feet === 'hoof') {
            const hoofTop = vlerp(j.low, j.tip, 0.55);
            const mat = P.darkPoints ? MAT_DARK : MAT_BODY;
            capsule(b, j.low, hoofTop, above(loR, j.low), above(loR * 1.05, hoofTop), mat, {
              rings: 1,
              segs: 8,
            });
            // a hoof: a short dark cone standing on the floor
            const f = frameAlong(
              v(j.tip[0], j.tip[1] + s(0.012), 0),
              v(j.tip[0], j.tip[1] + s(0.012), hoofTop[2]),
            );
            const hr = loR * 1.45;
            loft(
              b,
              f,
              [
                { t: 0, rx: 0, rz: 0 },
                { t: 0.001, rx: hr, rz: hr * 1.1, oz: 0.1 * hr },
                { t: 0.6 * hoofTop[2], rx: hr * 0.92, rz: hr * 0.95, oz: 0.05 * hr },
                { t: hoofTop[2], rx: hr * 0.75, rz: hr * 0.75 },
                { t: hoofTop[2] + 0.001, rx: 0, rz: 0 },
              ],
              10,
              MAT_DARK,
            );
          } else {
            const end = vlerp(j.low, j.tip, 0.6);
            capsule(b, j.low, end, above(loR, j.low), above(loR * 0.95, end), MAT_BODY, {
              rings: 1,
              segs: 8,
            });
            // a paw resting on the floor (its sole at the ground), toes forward
            ellipsoid(
              b,
              v(j.tip[0], j.tip[1] - s(0.01), s(0.032)),
              v(loR * 1.35, loR * 1.9, s(0.032)),
              MAT_BODY,
              2,
            );
          }
        },
      },
    );
  }
  if (P.saddle)
    parts.push({
      bone: 'saddle',
      build: (b) => {
        // a seat on the back: a dark-leather pad hugging the barrel, raised at the cantle
        const f = frameAlong(
          v(0, seat[1] + s(0.13), seat[2] - s(0.03)),
          v(0, seat[1] - s(0.14), seat[2] - s(0.03)),
        );
        loft(
          b,
          f,
          [
            { t: 0, rx: 0, rz: 0, oz: -0.02 * H },
            { t: s(0.02), rx: W * 0.55, rz: s(0.04), oz: -s(0.02) },
            { t: s(0.13), rx: W * 0.68, rz: s(0.035), oz: 0 },
            { t: s(0.24), rx: W * 0.58, rz: s(0.04), oz: -s(0.015) },
            { t: s(0.27), rx: 0, rz: 0, oz: -s(0.02) },
          ],
          12,
          MAT_ACCENT,
        );
        // stirrups hanging on both sides
        for (const sd of [1, -1]) {
          const hang = v(sd * (W + s(0.02)), seat[1] - s(0.02), bz - s(0.1));
          capsule(
            b,
            v(sd * W * 0.9, seat[1] - s(0.02), seat[2] - s(0.04)),
            hang,
            s(0.008),
            s(0.008),
            MAT_ACCENT,
            {
              segs: 5,
              rings: 1,
            },
          );
          ellipsoid(b, vsub(hang, v(0, 0, s(0.015))), v(s(0.018), s(0.03), s(0.012)), MAT_DARK, 1);
        }
      },
    });

  const probes: GroundProbe[] = [];
  for (const leg of LEGS) {
    const j = joints(leg);
    probes.push(
      { bone: `foot.${leg}`, point: j.tip, radius: 0 },
      { bone: `foot.${leg}`, point: v(j.tip[0], j.tip[1] + s(0.04), 0), radius: 0 },
      { bone: `lower_leg.${leg}`, point: j.mid, radius: above(s(P.cannonR) * 1.4, j.mid) },
      { bone: `lower_leg.${leg}`, point: j.low, radius: above(s(P.cannonR) * 1.25, j.low) },
    );
  }
  probes.push(
    { bone: 'hips', point: v(0, rear - s(0.05), bz - R * 0.6), radius: 0 },
    { bone: 'hips', point: v(0, midR, bz - R), radius: 0 },
    { bone: 'spine', point: v(0, 0, bz - R * 1.02), radius: 0 },
    { bone: 'chest', point: v(0, midF - s(0.05), bz - R), radius: 0 },
    { bone: 'head', point: headTip, radius: s(P.muzzleR) },
  );

  // landmarks on the head (character space): eyes, nose (muzzle tip), ears and the top
  const f = frameAlong(neckTop, headTip);
  const along = (t: number, side: number, up: number) =>
    vadd(vadd(vadd(neckTop, vscale(f.u, t)), vscale(f.x, side)), vscale(f.z, -up));
  const hr = s(P.headR);
  const len = s(P.headLen);
  const earTop =
    P.ears === 'up'
      ? s(P.earLen)
      : P.ears === 'fold'
        ? 0.6 * s(P.earLen)
        : P.ears === 'wide'
          ? 0.75 * s(P.earLen)
          : P.ears === 'round'
            ? 0.6 * s(P.earR)
            : 0;
  const short = P.snout === 'short';
  const eyeT = short ? 0.3 * len : 0.2 * len;
  return {
    family: 'quadruped',
    height: H,
    bones,
    parts,
    probes,
    head: {
      nose: along(len + 0.35 * s(P.muzzleR), 0, short ? -0.34 * hr : P.snout === 'pig' ? -0.12 * hr : 0),
      eyeL: along(eyeT, 0.9 * hr, 0.35 * hr),
      eyeR: along(eyeT, -0.9 * hr, 0.35 * hr),
      earL: along(-0.05 * hr, 0.55 * hr, 0.75 * hr),
      earR: along(-0.05 * hr, -0.55 * hr, 0.75 * hr),
      top: along(-0.05 * hr, 0, 0.75 * hr + earTop),
    },
    chest: v(0, front * 0.6, bz),
    // where each leg leaves the body: the front legs' elbows, the hind legs' stifles (keypoints)
    points: Object.fromEntries(
      LEGS.map((leg) => [
        `${isFront(leg) ? 'elbow' : 'knee'}.${leg}`,
        { bone: `upper_leg.${leg}`, point: joints(leg).vis },
      ]),
    ),
    accent: P.saddle,
    barrel: { halfWidth: W, halfHeight: R, z: bz },
  };
}
