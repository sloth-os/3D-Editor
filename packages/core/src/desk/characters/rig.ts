import type { Mat4, Vec3 } from '../../math/types';
import { compose4, eulerFromRotation, invert4, multiply4 } from '../../math/mat4';
import { cross3, dot3, normalize3, transformPoint3 } from '../../math/vec3';
import type { BoneData, PoseBone } from '../../doc/types';
import type { SceneDoc } from '../../doc/scene-doc';
import { boneRestMatrix, rollFromZAxis } from '../../armature/bone-math';
import { MeshBuilder, addIcoSphere, addRingSurface } from '../../generate/builder';
import type { MeshData } from '../../mesh/types';
import { srgbToLinear } from '../../render/color';
import { OperatorError } from '../../operators/context';
import { DESK_PROPS } from '../props';

/*
 * Shared rig vocabulary of the desk actors.
 *
 * Character (armature rest) space: the actor stands on z = 0 and faces −Y. L = +X is the
 * character's left, R = −X its right, F = −Y its front, B = +Y its back, U = +Z up. Bones are
 * built so that every bone lying in the sagittal (YZ) plane has its local X axis on +X (L): a
 * pose rotation about local X then bends the bone forward or back, local Z swings it sideways and
 * local Y twists it. Bones along X (the shoulders) keep local Z up instead.
 *
 * Parts are built in character space at rest (`PartSpec.build`) and moved into their bone's
 * frame, so a part object sits at its bone's head with identity rotation (BONE parenting places
 * children at the bone's tail: the part's location is (0, −length, 0)).
 */

export type Side = 'L' | 'R';
export const SIDES: readonly Side[] = ['L', 'R'];

/** x sign of a side in character space (L = +X). */
export function sideSign(s: Side): number {
  return s === 'L' ? 1 : -1;
}

export const DEG = Math.PI / 180;

/** Material slots of every actor part. */
export const MAT_BODY = 0;
export const MAT_DARK = 1;
export const MAT_LIGHT = 2;
export const MAT_ACCENT = 3;

/** A bone of a blueprint, in character space. */
export interface BoneSpec {
  name: string;
  parent: string | null;
  head: Vec3;
  tail: Vec3;
  connect?: boolean;
  /** Bones along X: local Z kept on this axis (default: local X on +X). */
  zAxis?: Vec3;
}

/** A mesh part following one bone, built in character space at rest. */
export interface PartSpec {
  bone: string;
  build(b: MeshBuilder): void;
}

/** A point that may touch the ground (on a bone, character space at rest), with its radius. */
export interface GroundProbe {
  bone: string;
  point: Vec3;
  radius: number;
}

/** Head landmarks in character space at rest (all on the `head` bone). */
export interface HeadLandmarks {
  nose: Vec3;
  eyeL: Vec3;
  eyeR: Vec3;
  earL: Vec3;
  earR: Vec3;
  top: Vec3;
}

/** What an actor is built from: bones, parts and the landmarks the desk measures. */
export interface Blueprint {
  family: 'humanoid' | 'quadruped';
  height: number;
  bones: BoneSpec[];
  parts: PartSpec[];
  probes: GroundProbe[];
  head: HeadLandmarks;
  /** A point on the chest bone (character space at rest) the camera aims at for the chest. */
  chest: Vec3;
  /** Other named points on bones (character space at rest) that keypoints read. */
  points: Record<string, { bone: string; point: Vec3 }>;
  /** Whether a part uses the accent material (saddles). */
  accent: boolean;
  /**
   * Quadrupeds: the barrel (the body under the saddle) as an elliptical cylinder along Y, character
   * space at rest: half its width (X) and height (Z) and the height of its axis. A rider's legs go
   * round it.
   */
  barrel?: { halfWidth: number; halfHeight: number; z: number };
}

// ---------------------------------------------------------------- vectors

export const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const vadd = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vlerp = (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const vlen = (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]);
/** Mirror of a character-space point onto the other side. */
export const mirrorX = (a: Readonly<Vec3>): Vec3 => [-a[0], a[1], a[2]];

// ---------------------------------------------------------------- colours

/** '#rrggbb' → linear RGBA (materials store linear colours). */
export function hexToLinear(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x808080;
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
    1,
  ];
}

/** A linear colour scaled towards black (`f` < 1) keeping its hue. */
export function shadeLinear(c: readonly number[], f: number): [number, number, number, number] {
  return [c[0] * f, c[1] * f, c[2] * f, 1];
}

// ---------------------------------------------------------------- bones

/** BoneData of a blueprint's bones (rolls keep local X on +X, or local Z on `zAxis`). */
export function boneData(specs: readonly BoneSpec[]): BoneData[] {
  return specs.map((s) => {
    const dir = normalize3(vsub(s.tail, s.head));
    const z = s.zAxis ?? cross3([1, 0, 0], dir);
    return {
      name: s.name,
      parent: s.parent,
      head: [...s.head] as Vec3,
      tail: [...s.tail] as Vec3,
      roll: vlen(z) > 1e-6 ? rollFromZAxis(s.head, s.tail, z) : 0,
      use_connect: !!s.connect,
      use_deform: false,
      envelope_distance: 0.05,
      envelope_weight: 1,
      head_radius: 0.02,
      tail_radius: 0.01,
    };
  });
}

/** Rest matrices (character space, origin at the head, +Y along the bone) of bones by name. */
export function restMatrices(bones: readonly BoneData[]): Map<string, { matrix: Mat4; length: number }> {
  const out = new Map<string, { matrix: Mat4; length: number }>();
  for (const b of bones) out.set(b.name, boneRestMatrix(b.head, b.tail, b.roll));
  return out;
}

/** Rotation part (3x3 in a Mat4) of a matrix. */
export function rotationOnly(m: Readonly<Mat4>): Mat4 {
  return [m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1];
}

/** Transpose of a rotation matrix (its inverse). */
export function transposeRot(m: Readonly<Mat4>): Mat4 {
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
}

/** Euler XYZ of a rotation matrix (radians). */
export function eulerOf(m: Readonly<Mat4>): Vec3 {
  return eulerFromRotation(m);
}

/** Rotation matrix of euler XYZ angles (radians). */
export function rotEuler(e: Readonly<Vec3>): Mat4 {
  return compose4([0, 0, 0], e, [1, 1, 1]);
}

/** A pose bone with a rotation (and location). */
export function poseBone(rot: Readonly<Vec3> = [0, 0, 0], loc: Readonly<Vec3> = [0, 0, 0]): PoseBone {
  return { location: [loc[0], loc[1], loc[2]], rotation_euler: [rot[0], rot[1], rot[2]], scale: [1, 1, 1] };
}

// ---------------------------------------------------------------- meshes

/**
 * One elliptical section of a loft: at `t` along the axis, half-widths `rx` (along the frame's x)
 * and `rz` (along its z), centred `ox`/`oz` off the axis. rx = rz = 0 makes a pole.
 */
export interface Section {
  t: number;
  rx: number;
  rz: number;
  ox?: number;
  oz?: number;
}

/** An orthonormal frame for lofting: origin, axis `u` and the section axes `x`, `z`. */
export interface LoftFrame {
  origin: Vec3;
  u: Vec3;
  x: Vec3;
  z: Vec3;
}

/** A loft frame along a → b; `side` hints the section x axis (made perpendicular). */
export function frameAlong(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  side: Readonly<Vec3> = [1, 0, 0],
): LoftFrame {
  const u = normalize3(vsub(b, a));
  let x = vsub(side, vscale(u, dot3(side, u)));
  if (vlen(x) < 1e-6) {
    const alt: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    x = vsub(alt, vscale(u, dot3(alt, u)));
  }
  x = normalize3(x);
  const z = cross3(x, u);
  return { origin: [a[0], a[1], a[2]], u, x, z: normalize3(z) };
}

/**
 * Closed smooth solid lofted through elliptical sections (sorted by `t`), `segs` points per ring.
 * The first and last section should be poles (rx = rz = 0) to close it.
 */
export function loft(
  b: MeshBuilder,
  f: LoftFrame,
  sections: readonly Section[],
  segs: number,
  mat: number,
): void {
  // rings counter-clockwise seen from where the sequence advances: angle from z towards x when
  // x × z points along u, else from x towards z
  const ccw = dot3(cross3(f.z, f.x), f.u) > 0;
  const rings: Vec3[][] = sections.map((s) => {
    const c = vadd(vadd(f.origin, vscale(f.u, s.t)), vadd(vscale(f.x, s.ox ?? 0), vscale(f.z, s.oz ?? 0)));
    if (s.rx < 1e-7 && s.rz < 1e-7) return [c];
    const ring: Vec3[] = [];
    for (let j = 0; j < segs; j++) {
      const a = (2 * Math.PI * j) / segs;
      const cz = Math.cos(a) * s.rz;
      const sx = Math.sin(a) * s.rx;
      const p = ccw
        ? vadd(c, vadd(vscale(f.z, cz), vscale(f.x, sx)))
        : vadd(c, vadd(vscale(f.x, Math.cos(a) * s.rx), vscale(f.z, Math.sin(a) * s.rz)));
      ring.push(p);
    }
    return ring;
  });
  addRingSurface(b, rings, { mat, smooth: true, capStart: true, capEnd: true });
}

/**
 * Sections of a rounded capsule of length `len` along the axis with radius `r0` at t = 0 and `r1`
 * at t = len (rounded ends reaching `cap0`·r0 before and `cap1`·r1 beyond), scaled across by
 * `sx`/`sz`; `bulge(t01)` widens the middle (calves, thighs).
 */
export function capsuleSections(
  len: number,
  r0: number,
  r1: number,
  o: {
    sx?: number;
    sz?: number;
    cap0?: number;
    cap1?: number;
    rings?: number;
    bulge?: (t: number) => number;
  } = {},
): Section[] {
  const sx = o.sx ?? 1;
  const sz = o.sz ?? 1;
  const cap0 = (o.cap0 ?? 1) * r0;
  const cap1 = (o.cap1 ?? 1) * r1;
  // rounded ends: rings at 50° and 75° from the axis (a hemisphere squashed to `cap` long)
  const ends = [50 * DEG, 75 * DEG];
  const out: Section[] = [{ t: -cap0, rx: 0, rz: 0 }];
  for (const a of ends)
    out.push({ t: -cap0 * Math.cos(a), rx: r0 * sx * Math.sin(a), rz: r0 * sz * Math.sin(a) });
  const n = Math.max(1, o.rings ?? 3);
  for (let i = 0; i <= n; i++) {
    const t01 = i / n;
    const r = (r0 + (r1 - r0) * t01) * (1 + (o.bulge ? o.bulge(t01) : 0));
    out.push({ t: len * t01, rx: r * sx, rz: r * sz });
  }
  for (const a of [...ends].reverse())
    out.push({ t: len + cap1 * Math.cos(a), rx: r1 * sx * Math.sin(a), rz: r1 * sz * Math.sin(a) });
  out.push({ t: len + cap1, rx: 0, rz: 0 });
  return out;
}

/** A rounded capsule from a to b (radii r0 at a, r1 at b); `side` orients the sx axis. */
export function capsule(
  b: MeshBuilder,
  a: Readonly<Vec3>,
  c: Readonly<Vec3>,
  r0: number,
  r1: number,
  mat: number,
  o: Parameters<typeof capsuleSections>[3] & { side?: Vec3; segs?: number } = {},
): void {
  const len = vlen(vsub(c, a));
  if (!(len > 1e-6)) return;
  loft(b, frameAlong(a, c, o.side), capsuleSections(len, r0, r1, o), o.segs ?? 10, mat);
}

/** A smooth ellipsoid (icosphere) at `c` with semi-axes `r`. */
export function ellipsoid(
  b: MeshBuilder,
  c: Readonly<Vec3>,
  r: Readonly<Vec3>,
  mat: number,
  levels = 2,
): void {
  addIcoSphere(b, c, r, levels, { mat, smooth: true });
}

/** A sphere at `c` (joint balls: `levels` 1 = 20 triangles, 2 = 80). */
export function ball(b: MeshBuilder, c: Readonly<Vec3>, r: number, mat: number, levels = 2): void {
  addIcoSphere(b, c, [r, r, r], levels, { mat, smooth: true });
}

/** Builds a part in character space and moves it into its bone's frame (head at the origin). */
export function buildPartMesh(part: PartSpec, rest: Readonly<Mat4>): MeshData {
  const b = new MeshBuilder();
  part.build(b);
  const inv = invert4(rest as Mat4);
  const p = b.positions;
  for (let i = 0; i < p.length; i += 3) {
    const q = transformPoint3(inv, [p[i], p[i + 1], p[i + 2]]);
    p[i] = q[0];
    p[i + 1] = q[1];
    p[i + 2] = q[2];
  }
  return b.build();
}

/** The vertices of a blueprint's parts (character space at rest) by bone, built once per blueprint. */
export interface PartSurface {
  bone: string;
  /** x, y, z of every vertex. */
  pos: readonly number[];
}

const surfaces = new WeakMap<Blueprint, PartSurface[]>();

/** The surface of an actor's parts: what touches the ground when a pose is grounded. */
export function partSurfaces(bp: Blueprint): readonly PartSurface[] {
  let s = surfaces.get(bp);
  if (!s) {
    s = bp.parts.map((part) => {
      const b = new MeshBuilder();
      part.build(b);
      return { bone: part.bone, pos: b.positions.slice() };
    });
    surfaces.set(bp, s);
  }
  return s;
}

// ---------------------------------------------------------------- actors in a document

/** Name prefix of the CHILD_OF that seats a rider on a mount's saddle ('Ride <mount>'). */
export const RIDE_PREFIX = 'Ride ';

/** What the desk stores on an actor's armature object. */
export interface ActorMeta {
  id: string;
  name: string;
  kind: string;
  height: number;
  color: string;
  armature: string;
}

/** The actor `ref` names (an id or exact name), or a NOT_FOUND / FAILED OperatorError. */
export function requireActor(doc: SceneDoc, ref: string): ActorMeta {
  const o = doc.getObject(ref) ?? doc.resolveObject(ref);
  if (!o) throw new OperatorError(`Actor '${ref}' not found`, 'NOT_FOUND');
  const props = o.custom_props ?? {};
  if (o.type !== 'ARMATURE' || props[DESK_PROPS.role] !== 'actor' || !o.data)
    throw new OperatorError(
      `'${o.name}' is not an actor (add one with desk.actor_add: an armature with desk_role 'actor')`,
      'FAILED',
    );
  const height = Number(props[DESK_PROPS.heightM]);
  return {
    id: o.id,
    name: o.name,
    kind: String(props[DESK_PROPS.kind] ?? ''),
    height: Number.isFinite(height) && height > 0 ? height : 1.7,
    color: String(props[DESK_PROPS.color] ?? '#808080'),
    armature: o.data,
  };
}

/** Part objects of an actor (BONE-parented children carrying desk_actor), by bone name. */
export function actorParts(doc: SceneDoc, actorId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of doc.childIds(actorId)) {
    const o = doc.getObject(id);
    if (o && o.custom_props?.[DESK_PROPS.actor] === actorId && o.parent_type === 'BONE')
      out.set(o.parent_bone, id);
  }
  return out;
}

/** World matrix of a bone's head frame rotated into character axes: armature · bone · rest⁻¹. */
export function boneDelta(posed: Readonly<Mat4>, rest: Readonly<Mat4>): Mat4 {
  return multiply4(posed as Mat4, invert4(rest as Mat4));
}
