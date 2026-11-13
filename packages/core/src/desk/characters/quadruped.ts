import type { Vec3 } from '../../math/types';
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
 * back), hind legs at the hock (it points back). Horses and ponies wear a saddle (accent colour),
 * hooves and manes are dark, eyes light so the head's facing reads.
 */

export type QuadrupedKind = 'horse' | 'pony' | 'dog';

/** Legs of a quadruped: front/back × left/right. */
export const LEGS = ['FL', 'FR', 'BL', 'BR'] as const;
export type Leg = (typeof LEGS)[number];
export const legSide = (leg: Leg): 1 | -1 => (leg[1] === 'L' ? 1 : -1);
export const isFront = (leg: Leg): boolean => leg[0] === 'F';

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
  ears: 'up' | 'floppy';
  earLen: number;
  earR: number;
  /** Head shape: a long tapering horse head, or a dog's skull with a stop and a short muzzle. */
  snout: 'long' | 'short';
  /** Heights of the leg roots inside the body (the legs swing from there). */
  frontRootZ: number;
  hindRootZ: number;
  /** Tail: total length and droop; 'hair' is a horse tail. */
  tailLen: number;
  tail: 'hair' | 'up';
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

const BUILDS: Record<QuadrupedKind, QuadBuild> = {
  horse: HORSE,
  pony: {
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
  },
  dog: {
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
    ears: 'up',
    earLen: 0.13,
    earR: 0.04,
    snout: 'short',
    frontRootZ: 0.82,
    hindRootZ: 0.84,
    tailLen: 0.45,
    tail: 'up',
    feet: 'paw',
    mane: false,
    saddle: false,
  },
};

export const QUADRUPED_DEFAULT_HEIGHTS: Record<QuadrupedKind, number> = Object.fromEntries(
  Object.entries(BUILDS).map(([k, b]) => [k, b.height]),
) as Record<QuadrupedKind, number>;

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
  const tailDir = (k: number): Vec3 => {
    // hair tails hang (droop more each segment); 'up' tails rise then curl back down a little
    const ang = P.tail === 'hair' ? [-30, -62, -82][k] : [25, 10, -15][k];
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
          P.snout === 'long'
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
        loft(b, f, secs, 12, MAT_BODY);
        const along = (t: number, side: number, up: number) =>
          vadd(vadd(vadd(neckTop, vscale(f.u, t)), vscale(f.x, side)), vscale(f.z, -up));
        for (const sd of [1, -1]) {
          // eyes on the sides, light so the facing reads; dark ears
          const eyeT = P.snout === 'long' ? 0.2 * len : 0.3 * len;
          ball(b, along(eyeT, sd * 0.8 * hr, 0.35 * hr), 0.2 * hr, MAT_LIGHT, 1);
          ball(b, along(eyeT + 0.04 * hr, sd * 0.88 * hr, 0.38 * hr), 0.11 * hr, MAT_DARK, 1);
          const earBase = along(-0.05 * hr, sd * 0.55 * hr, 0.75 * hr);
          if (P.ears === 'up') {
            const tip = vadd(earBase, vadd(vscale(f.z, -s(P.earLen)), vscale(f.x, sd * s(0.02))));
            capsule(b, earBase, vadd(tip, vscale(f.u, -s(0.02))), s(P.earR), s(0.006), MAT_DARK, {
              segs: 6,
              rings: 1,
              sx: 0.6,
            });
          } else {
            // floppy ears hang beside the head
            const tip = vadd(
              earBase,
              vadd(vscale(f.x, sd * s(0.05)), vadd(vscale(f.z, s(P.earLen)), vscale(f.u, s(0.02)))),
            );
            capsule(b, earBase, tip, s(0.035), s(0.03), MAT_DARK, { segs: 8, rings: 1, sz: 0.35, side: f.u });
          }
          // nostrils
          if (P.snout === 'long')
            ball(b, along(len + 0.05 * mr, sd * 0.4 * mr, 0.25 * mr), 0.18 * mr, MAT_DARK, 1);
        }
        if (P.snout === 'short') {
          // a dark nose at the tip of the muzzle
          ball(b, along(len + 0.15 * mr, 0, -0.34 * hr + 0.45 * mr), 0.42 * mr, MAT_DARK, 1);
        }
      },
    },
  ];
  const tailR = P.tail === 'hair' ? [0.06, 0.07, 0.06] : [0.05, 0.04, 0.025];
  const tailPts = [tailBase, tail1, tail2, tail3];
  for (let k = 0; k < 3; k++) {
    const a = tailPts[k];
    const c = tailPts[k + 1];
    parts.push({
      bone: `tail.${k + 1}`,
      build: (b) =>
        capsule(
          b,
          a,
          c,
          s(tailR[k]),
          s(tailR[k] * (k === 2 ? 0.5 : 0.95)),
          P.tail === 'hair' ? MAT_DARK : MAT_BODY,
          {
            segs: 8,
            rings: 2,
            sx: P.tail === 'hair' ? 0.55 : 1,
          },
        ),
    });
  }
  for (const leg of LEGS) {
    const j = joints(leg);
    const fr = isFront(leg);
    const upR = s(P.legR) * (fr ? 1 : 1.25);
    const loR = s(P.cannonR);
    parts.push(
      {
        bone: `upper_leg.${leg}`,
        build: (b) => {
          // the leg grows out of the body: a thick top tapering to the knee / hock
          const top = vadd(j.vis, v(0, 0, s(fr ? 0.1 : 0.12)));
          capsule(b, top, j.mid, upR * (fr ? 1.3 : 1.5), loR * 1.25, MAT_BODY, {
            sz: fr ? 1.15 : 1.4,
            rings: 3,
            side: v(1, 0, 0),
            bulge: (t) => 0.1 * Math.sin(Math.PI * t),
          });
          ball(b, j.mid, loR * 1.4, MAT_DARK, 1);
        },
      },
      {
        bone: `lower_leg.${leg}`,
        build: (b) => {
          capsule(b, j.mid, j.low, loR * 1.1, loR, MAT_BODY, { rings: 2, segs: 8 });
          ball(b, j.low, loR * 1.25, MAT_DARK, 1);
        },
      },
      {
        bone: `foot.${leg}`,
        build: (b) => {
          if (P.feet === 'hoof') {
            const hoofTop = vlerp(j.low, j.tip, 0.55);
            capsule(b, j.low, hoofTop, loR, loR * 1.05, MAT_BODY, { rings: 1, segs: 8 });
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
            capsule(b, j.low, vlerp(j.low, j.tip, 0.6), loR, loR * 0.95, MAT_BODY, { rings: 1, segs: 8 });
            // a paw resting on the floor, toes forward
            ellipsoid(
              b,
              v(j.tip[0], j.tip[1] - s(0.01), s(0.03)),
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
      { bone: `lower_leg.${leg}`, point: j.mid, radius: s(P.cannonR) * 1.4 },
      { bone: `lower_leg.${leg}`, point: j.low, radius: s(P.cannonR) * 1.25 },
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
  const earTop = P.ears === 'up' ? s(P.earLen) : 0;
  const short = P.snout === 'short';
  const eyeT = short ? 0.3 * len : 0.2 * len;
  return {
    family: 'quadruped',
    height: H,
    bones,
    parts,
    probes,
    head: {
      nose: along(len + 0.35 * s(P.muzzleR), 0, short ? -0.34 * hr : 0),
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
  };
}
