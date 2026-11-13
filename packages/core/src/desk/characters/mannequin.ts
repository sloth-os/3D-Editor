import type { Vec3 } from '../../math/types';
import type { MeshBuilder } from '../../generate/builder';
import {
  DEG,
  MAT_BODY,
  MAT_DARK,
  MAT_LIGHT,
  SIDES,
  ball,
  capsule,
  ellipsoid,
  frameAlong,
  loft,
  sideSign,
  v,
  type Blueprint,
  type BoneSpec,
  type GroundProbe,
  type PartSpec,
  type Section,
} from './rig';

/*
 * Segmented mannequins (spec §8): the humanoid kinds as one parametric body. Every bone gets one
 * smooth low-poly part in the actor colour, with darker balls at the joints and a light visor
 * (plus a small nose) where the face is, so the facing reads at a glance. Proportions are
 * fractions of the standing height h: an adult's head is h/7.5, a child's h/5.5, a toddler's
 * h/4.4. Man and woman differ in silhouette (shoulders, hips, waist, a hair bun); the elder
 * stoops slightly (a posture added to every pose, poses.ts).
 */

export type HumanoidKind = 'adult' | 'man' | 'woman' | 'child' | 'toddler' | 'elder';

interface HumanBuild {
  /** Default standing height (m). */
  height: number;
  /** Standing height in heads. */
  heads: number;
  /** Heights as fractions of h: hip joint, ankle joint, visible neck. */
  hip: number;
  ankle: number;
  neck: number;
  /** Half-widths as fractions of h: shoulder joints, hip joints. */
  shoulderX: number;
  hipX: number;
  /** Foot length (heel to toe) / h. */
  foot: number;
  /** Limb thickness factor (children are chubbier). */
  limb: number;
  /** Torso half-widths (w, lateral) and half-depths (d) / h. */
  pelvisW: number;
  pelvisD: number;
  waistW: number;
  waistD: number;
  chestW: number;
  chestD: number;
  /** Head half-width and half-depth as fractions of its half-height. */
  headW: number;
  headD: number;
  bun: boolean;
  /** Forward stoop added to every pose (degrees, elder). */
  stoop: number;
}

const ADULT: HumanBuild = {
  height: 1.7,
  heads: 7.5,
  hip: 0.53,
  ankle: 0.045,
  neck: 0.05,
  shoulderX: 0.108,
  hipX: 0.053,
  foot: 0.15,
  limb: 1,
  pelvisW: 0.098,
  pelvisD: 0.062,
  waistW: 0.082,
  waistD: 0.056,
  chestW: 0.104,
  chestD: 0.064,
  headW: 0.7,
  headD: 0.84,
  bun: false,
  stoop: 0,
};

const BUILDS: Record<HumanoidKind, HumanBuild> = {
  adult: ADULT,
  man: {
    ...ADULT,
    height: 1.76,
    shoulderX: 0.118,
    hipX: 0.05,
    limb: 1.05,
    pelvisW: 0.092,
    waistW: 0.084,
    waistD: 0.058,
    chestW: 0.12,
    chestD: 0.068,
  },
  woman: {
    ...ADULT,
    height: 1.64,
    neck: 0.055,
    shoulderX: 0.099,
    hipX: 0.058,
    limb: 0.92,
    pelvisW: 0.108,
    pelvisD: 0.066,
    waistW: 0.07,
    waistD: 0.05,
    chestW: 0.094,
    chestD: 0.064,
    bun: true,
  },
  child: {
    ...ADULT,
    height: 1.2,
    heads: 5.5,
    hip: 0.47,
    ankle: 0.05,
    neck: 0.035,
    shoulderX: 0.105,
    hipX: 0.055,
    foot: 0.155,
    limb: 1.15,
    pelvisW: 0.098,
    pelvisD: 0.066,
    waistW: 0.092,
    waistD: 0.064,
    chestW: 0.1,
    chestD: 0.068,
    headW: 0.74,
    headD: 0.86,
  },
  toddler: {
    ...ADULT,
    height: 0.9,
    heads: 4.4,
    hip: 0.41,
    ankle: 0.055,
    neck: 0.025,
    shoulderX: 0.11,
    hipX: 0.062,
    foot: 0.16,
    limb: 1.35,
    pelvisW: 0.112,
    pelvisD: 0.076,
    waistW: 0.106,
    waistD: 0.076,
    chestW: 0.106,
    chestD: 0.076,
    headW: 0.78,
    headD: 0.88,
  },
  elder: { ...ADULT, height: 1.65, limb: 0.95, stoop: 1 },
};

export const HUMANOID_DEFAULT_HEIGHTS: Record<HumanoidKind, number> = Object.fromEntries(
  Object.entries(BUILDS).map(([k, b]) => [k, b.height]),
) as Record<HumanoidKind, number>;

/** Forward stoop (degrees of extra spine/neck flexion, 0..1 scale) of a humanoid kind. */
export function humanoidStoop(kind: HumanoidKind): number {
  return BUILDS[kind].stoop;
}

/** Bone layout and parts of a humanoid kind at standing height `h`. */
export function humanoidBlueprint(kind: HumanoidKind, h: number): Blueprint {
  const P = BUILDS[kind];
  const headH = h / P.heads;
  const hh = headH / 2;
  const chin = h - headH;
  const neckTop = chin + 0.22 * headH;
  const neckBase = chin - P.neck * h;
  const hipZ = P.hip * h;
  const ankleZ = P.ankle * h;
  const T = neckBase - hipZ;
  const spineZ = hipZ + 0.24 * T;
  const chestZ = hipZ + 0.56 * T;
  const shX = P.shoulderX * h;
  const shZ = neckBase - 0.022 * h;
  const upper = 0.62 * T;
  const fore = 0.52 * T;
  const hand = 0.36 * T;
  const elbowZ = shZ - upper;
  const wristZ = elbowZ - fore;
  const tipZ = wristZ - hand;
  const legLen = hipZ - ankleZ;
  const kneeZ = hipZ - 0.505 * legLen;
  const hipX = P.hipX * h;
  const footL = P.foot * h;
  const heelY = 0.2 * footL;
  const ballY = -0.53 * footL;
  const toeY = -0.8 * footL;
  const L = P.limb;

  const bones: BoneSpec[] = [
    { name: 'root', parent: null, head: v(0, 0, 0), tail: v(0, 0.1 * h, 0) },
    { name: 'hips', parent: 'root', head: v(0, 0, hipZ), tail: v(0, 0, spineZ) },
    { name: 'spine', parent: 'hips', head: v(0, 0, spineZ), tail: v(0, 0, chestZ), connect: true },
    { name: 'chest', parent: 'spine', head: v(0, 0, chestZ), tail: v(0, 0, neckBase), connect: true },
    { name: 'neck', parent: 'chest', head: v(0, 0, neckBase), tail: v(0, 0, neckTop), connect: true },
    { name: 'head', parent: 'neck', head: v(0, 0, neckTop), tail: v(0, 0, h), connect: true },
  ];
  for (const s of SIDES) {
    const x = sideSign(s);
    bones.push(
      {
        name: `shoulder.${s}`,
        parent: 'chest',
        head: v(x * 0.016 * h, 0, neckBase - 0.008 * h),
        tail: v(x * shX, 0, shZ),
        zAxis: v(0, 0, 1),
      },
      {
        name: `upper_arm.${s}`,
        parent: `shoulder.${s}`,
        head: v(x * shX, 0, shZ),
        tail: v(x * shX, 0, elbowZ),
        connect: true,
      },
      {
        name: `forearm.${s}`,
        parent: `upper_arm.${s}`,
        head: v(x * shX, 0, elbowZ),
        tail: v(x * shX, 0, wristZ),
        connect: true,
      },
      {
        name: `hand.${s}`,
        parent: `forearm.${s}`,
        head: v(x * shX, 0, wristZ),
        tail: v(x * shX, 0, tipZ),
        connect: true,
      },
      { name: `thigh.${s}`, parent: 'hips', head: v(x * hipX, 0, hipZ), tail: v(x * hipX, 0, kneeZ) },
      {
        name: `shin.${s}`,
        parent: `thigh.${s}`,
        head: v(x * hipX, 0, kneeZ),
        tail: v(x * hipX, 0, ankleZ),
        connect: true,
      },
      {
        name: `foot.${s}`,
        parent: `shin.${s}`,
        head: v(x * hipX, 0, ankleZ),
        tail: v(x * hipX, ballY, 0.26 * ankleZ),
        connect: true,
      },
      {
        name: `toe.${s}`,
        parent: `foot.${s}`,
        head: v(x * hipX, ballY, 0.26 * ankleZ),
        tail: v(x * hipX, toeY, 0.22 * ankleZ),
        connect: true,
      },
    );
  }
  // order: parents first, then the bones named by HUMANOID_BONES (left and right interleaved)
  const order = [
    'root',
    'hips',
    'spine',
    'chest',
    'neck',
    'head',
    'shoulder.L',
    'shoulder.R',
    'upper_arm.L',
    'upper_arm.R',
    'forearm.L',
    'forearm.R',
    'hand.L',
    'hand.R',
    'thigh.L',
    'thigh.R',
    'shin.L',
    'shin.R',
    'foot.L',
    'foot.R',
    'toe.L',
    'toe.R',
  ];
  bones.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  // ---- the head: an egg with the jaw narrower than the cranium, the face towards −Y
  const headCy = -0.06 * headH;
  const eyeZ = h - 0.5 * headH;
  const headFront = headCy - P.headD * hh;
  const headProfile: [number, number, number][] = [
    // u (0 chin .. 1 crown), width, depth factors
    [0, 0, 0],
    [0.06, 0.5, 0.55],
    [0.18, 0.78, 0.82],
    [0.34, 0.94, 0.96],
    [0.5, 1, 1],
    [0.66, 0.98, 0.98],
    [0.8, 0.88, 0.88],
    [0.92, 0.62, 0.64],
    [1, 0, 0],
  ];
  const headPart = (b: MeshBuilder) => {
    const f = frameAlong(v(0, headCy, chin), v(0, headCy, h));
    // the frame's z axis is the face direction (−Y)
    const secs: Section[] = headProfile.map(([u, w, d]) => ({
      t: u * headH,
      rx: P.headW * hh * w,
      rz: P.headD * hh * d,
      oz: u < 0.3 ? 0.04 * headH * (1 - u / 0.3) : -0.03 * headH * ((u - 0.3) / 0.7),
    }));
    loft(b, f, secs, 14, MAT_BODY);
    // visor across the eyes and a small nose under it
    ellipsoid(
      b,
      v(0, headFront + 0.2 * P.headD * hh, eyeZ + 0.02 * headH),
      v(0.78 * P.headW * hh, 0.34 * P.headD * hh, 0.12 * headH),
      MAT_LIGHT,
      2,
    );
    capsule(
      b,
      v(0, headFront + 0.05 * headH, eyeZ - 0.13 * headH),
      v(0, headFront - 0.07 * headH, eyeZ - 0.21 * headH),
      0.07 * headH,
      0.045 * headH,
      MAT_BODY,
      { segs: 8, rings: 1 },
    );
    if (P.bun) ball(b, v(0, headCy + 1.02 * P.headD * hh, h - 0.38 * headH), 0.27 * headH, MAT_DARK, 2);
  };

  const parts: PartSpec[] = [
    {
      bone: 'hips',
      build: (b) => {
        const base = hipZ - 0.085 * h;
        const f = frameAlong(v(0, 0, base), v(0, 0, spineZ + 0.02 * h));
        const W = P.pelvisW * h;
        const D = P.pelvisD * h;
        const ww = P.waistW * h;
        const wd = P.waistD * h;
        loft(
          b,
          f,
          [
            { t: 0, rx: 0, rz: 0 },
            { t: 0.012 * h, rx: 0.55 * W, rz: 0.5 * D, oz: -0.1 * D },
            { t: 0.035 * h, rx: 0.86 * W, rz: 0.86 * D, oz: -0.14 * D },
            { t: 0.07 * h, rx: 0.99 * W, rz: D, oz: -0.1 * D },
            { t: 0.1 * h, rx: W, rz: 0.98 * D, oz: -0.04 * D },
            { t: spineZ - base, rx: 0.98 * ww, rz: wd },
            { t: spineZ - base + 0.03 * h, rx: 0.7 * ww, rz: 0.7 * wd },
            { t: spineZ - base + 0.04 * h, rx: 0, rz: 0 },
          ],
          14,
          MAT_BODY,
        );
      },
    },
    {
      bone: 'spine',
      build: (b) => {
        const f = frameAlong(v(0, 0, spineZ - 0.03 * h), v(0, 0, chestZ + 0.03 * h));
        const ww = P.waistW * h;
        const wd = P.waistD * h;
        const len = chestZ - spineZ + 0.06 * h;
        loft(
          b,
          f,
          [
            { t: 0, rx: 0, rz: 0 },
            { t: 0.01 * h, rx: 0.75 * ww, rz: 0.75 * wd },
            { t: 0.03 * h, rx: ww, rz: wd, oz: 0.04 * wd },
            { t: 0.5 * len, rx: 0.98 * ww, rz: 1.02 * wd, oz: 0.06 * wd },
            { t: len - 0.03 * h, rx: 1.02 * ww, rz: wd },
            { t: len - 0.01 * h, rx: 0.75 * ww, rz: 0.75 * wd },
            { t: len, rx: 0, rz: 0 },
          ],
          14,
          MAT_BODY,
        );
      },
    },
    {
      bone: 'chest',
      build: (b) => {
        const base = chestZ - 0.03 * h;
        const top = neckBase + 0.012 * h;
        const f = frameAlong(v(0, 0, base), v(0, 0, top));
        const ww = P.waistW * h;
        const wd = P.waistD * h;
        const W = P.chestW * h;
        const D = P.chestD * h;
        const len = top - base;
        const bust = P.bun ? 0.1 : 0;
        loft(
          b,
          f,
          [
            { t: 0, rx: 0, rz: 0 },
            { t: 0.012 * h, rx: 0.8 * ww, rz: 0.8 * wd },
            { t: 0.03 * h, rx: 1.02 * ww, rz: wd },
            { t: 0.42 * len, rx: 0.93 * W, rz: (1 + bust) * D, oz: bust * D },
            { t: 0.74 * len, rx: W, rz: D, oz: 0.3 * bust * D },
            { t: 0.92 * len, rx: 0.86 * W, rz: 0.82 * D },
            { t: len, rx: 0.45 * W, rz: 0.55 * D },
            { t: len + 0.012 * h, rx: 0, rz: 0 },
          ],
          14,
          MAT_BODY,
        );
      },
    },
    {
      bone: 'neck',
      build: (b) =>
        capsule(
          b,
          v(0, 0, neckBase - 0.02 * h),
          v(0, -0.01 * h, neckTop),
          0.027 * h * L,
          0.025 * h * L,
          MAT_BODY,
          {
            segs: 10,
            rings: 1,
          },
        ),
    },
    { bone: 'head', build: headPart },
  ];
  for (const s of SIDES) {
    const x = sideSign(s);
    parts.push(
      {
        bone: `shoulder.${s}`,
        build: (b) =>
          capsule(
            b,
            v(x * 0.035 * h, 0, neckBase - 0.004 * h),
            v(x * (shX - 0.012 * h), 0, shZ + 0.004 * h),
            0.03 * h,
            0.04 * h * L,
            MAT_BODY,
            {
              sz: 0.85,
              segs: 10,
              rings: 1,
              side: v(0, 0, 1),
            },
          ),
      },
      {
        bone: `upper_arm.${s}`,
        build: (b) => {
          ball(b, v(x * shX, 0, shZ), 0.038 * h * L, MAT_DARK, 2);
          capsule(
            b,
            v(x * shX, 0, shZ - 0.02 * h),
            v(x * shX, 0, elbowZ),
            0.032 * h * L,
            0.025 * h * L,
            MAT_BODY,
            {
              bulge: (t) => 0.08 * Math.sin(Math.PI * t),
              cap1: 0.6,
            },
          );
        },
      },
      {
        bone: `forearm.${s}`,
        build: (b) => {
          ball(b, v(x * shX, 0, elbowZ), 0.028 * h * L, MAT_DARK, 2);
          capsule(
            b,
            v(x * shX, 0, elbowZ - 0.012 * h),
            v(x * shX, 0, wristZ),
            0.026 * h * L,
            0.018 * h * L,
            MAT_BODY,
            {
              bulge: (t) => 0.12 * Math.sin(Math.PI * Math.min(1, t * 1.6)),
              cap1: 0.6,
            },
          );
        },
      },
      {
        bone: `hand.${s}`,
        build: (b) => {
          ball(b, v(x * shX, 0, wristZ), 0.02 * h * L, MAT_DARK, 1);
          capsule(
            b,
            v(x * shX, 0, wristZ - 0.01 * h),
            v(x * shX, 0, tipZ + 0.012 * h),
            0.022 * h * L,
            0.019 * h * L,
            MAT_BODY,
            {
              sx: 0.5,
              segs: 10,
              rings: 2,
              cap1: 0.9,
            },
          );
          // thumb, towards the front of the hand
          capsule(
            b,
            v(x * shX, -0.012 * h, wristZ - 0.02 * h),
            v(x * (shX - 0.004 * h), -0.024 * h, wristZ - 0.055 * h),
            0.009 * h * L,
            0.007 * h * L,
            MAT_BODY,
            { segs: 6, rings: 1 },
          );
        },
      },
      {
        bone: `thigh.${s}`,
        build: (b) =>
          capsule(b, v(x * hipX, 0, hipZ), v(x * hipX, 0, kneeZ), 0.056 * h * L, 0.036 * h * L, MAT_BODY, {
            bulge: (t) => 0.05 * Math.sin(Math.PI * t),
            cap0: 0.7,
            cap1: 0.6,
            rings: 3,
          }),
      },
      {
        bone: `shin.${s}`,
        build: (b) => {
          ball(b, v(x * hipX, -0.004 * h, kneeZ), 0.038 * h * L, MAT_DARK, 2);
          const f = frameAlong(v(x * hipX, 0, kneeZ - 0.01 * h), v(x * hipX, 0, ankleZ + 0.004 * h));
          const len = kneeZ - ankleZ - 0.006 * h;
          const r0 = 0.035 * h * L;
          const r1 = 0.021 * h * L;
          // frame z is the back (+Y): the calf bulges there
          loft(
            b,
            f,
            [
              { t: -0.6 * r0, rx: 0, rz: 0 },
              { t: -0.3 * r0, rx: 0.8 * r0, rz: 0.8 * r0 },
              { t: 0, rx: r0, rz: r0 },
              { t: 0.25 * len, rx: 1.02 * r0, rz: 1.12 * r0, oz: 0.25 * r0 },
              { t: 0.5 * len, rx: 0.85 * r0, rz: 0.92 * r0, oz: 0.15 * r0 },
              { t: 0.8 * len, rx: 1.02 * r1, rz: 1.05 * r1 },
              { t: len, rx: r1, rz: r1 },
              { t: len + 0.5 * r1, rx: 0.7 * r1, rz: 0.7 * r1 },
              { t: len + 0.8 * r1, rx: 0, rz: 0 },
            ],
            10,
            MAT_BODY,
          );
        },
      },
      {
        bone: `foot.${s}`,
        build: (b) => {
          ball(b, v(x * hipX, 0, ankleZ), 0.024 * h * L, MAT_DARK, 2);
          // a shoe from the heel to the ball: the frame runs forward (−Y) with z pointing down,
          // so each section sits on the floor (centre `hgt` up)
          const f = frameAlong(v(x * hipX, heelY, 0), v(x * hipX, ballY, 0));
          const w = 0.031 * h * L;
          const hgt = 0.55 * ankleZ;
          const len = heelY - ballY + 0.01 * h;
          const sec = (t: number, wf: number, hf: number): Section => ({
            t,
            rx: w * wf,
            rz: hgt * hf,
            oz: -hgt * hf,
          });
          loft(
            b,
            f,
            [
              { t: 0, rx: 0, rz: 0, oz: -0.5 * hgt },
              sec(0.012 * h, 0.7, 0.75),
              sec(0.035 * h, 0.92, 1.0),
              sec(0.45 * len, 1.0, 0.95),
              sec(0.8 * len, 1.08, 0.62),
              sec(len, 1.06, 0.52),
              { t: len + 0.004 * h, rx: 0, rz: 0, oz: -0.5 * hgt },
            ],
            10,
            MAT_BODY,
          );
        },
      },
      {
        bone: `toe.${s}`,
        build: (b) => {
          const f = frameAlong(v(x * hipX, ballY + 0.004 * h, 0), v(x * hipX, toeY, 0));
          const w = 0.032 * h * L;
          const hgt = 0.27 * ankleZ;
          const len = ballY - toeY + 0.004 * h;
          loft(
            b,
            f,
            [
              { t: 0, rx: 0, rz: 0, oz: -hgt },
              { t: 0.004 * h, rx: w, rz: hgt * 1.05, oz: -hgt * 1.05 },
              { t: 0.6 * len, rx: 0.95 * w, rz: hgt, oz: -hgt },
              { t: 0.9 * len, rx: 0.7 * w, rz: 0.8 * hgt, oz: -0.8 * hgt },
              { t: len, rx: 0, rz: 0, oz: -0.6 * hgt },
            ],
            10,
            MAT_BODY,
          );
        },
      },
    );
  }

  const probes: GroundProbe[] = [];
  for (const s of SIDES) {
    const x = sideSign(s);
    probes.push(
      { bone: `foot.${s}`, point: v(x * hipX, heelY - 0.006 * h, 0), radius: 0 },
      { bone: `foot.${s}`, point: v(x * hipX, heelY + 0.004 * h, 0.4 * ankleZ), radius: 0 },
      { bone: `foot.${s}`, point: v(x * hipX, ballY, 0), radius: 0 },
      { bone: `toe.${s}`, point: v(x * hipX, toeY + 0.004 * h, 0.1 * ankleZ), radius: 0 },
      { bone: `shin.${s}`, point: v(x * hipX, -0.04 * h * L, kneeZ), radius: 0 },
      { bone: `hips`, point: v(x * 0.05 * h, 0.03 * h, hipZ - 0.08 * h), radius: 0 },
      { bone: `hand.${s}`, point: v(x * shX, 0, tipZ + 0.01 * h), radius: 0 },
      { bone: `forearm.${s}`, point: v(x * shX, 0.02 * h, elbowZ), radius: 0 },
    );
  }
  probes.push(
    { bone: 'hips', point: v(0, P.pelvisD * h * 0.95, hipZ), radius: 0 },
    { bone: 'chest', point: v(0, P.chestD * h * 0.95, chestZ + 0.06 * h), radius: 0 },
    { bone: 'head', point: v(0, headCy + P.headD * hh * 0.95, h - 0.5 * headH), radius: 0 },
  );

  const eye = (s: number): Vec3 => v(s * 0.42 * P.headW * hh, headFront + 0.12 * P.headD * hh, eyeZ);
  const ear = (s: number): Vec3 => v(s * 0.98 * P.headW * hh, headCy + 0.06 * headH, eyeZ - 0.06 * headH);
  return {
    family: 'humanoid',
    height: h,
    bones,
    parts,
    probes,
    head: {
      nose: v(0, headFront - 0.07 * headH, eyeZ - 0.21 * headH),
      eyeL: eye(1),
      eyeR: eye(-1),
      earL: ear(1),
      earR: ear(-1),
      top: v(0, headCy, h),
    },
    chest: v(0, 0, hipZ + 0.66 * T),
    points: {},
    accent: false,
  };
}

/** Degrees → radians, for pose tables. */
export const rad = (d: number) => d * DEG;
