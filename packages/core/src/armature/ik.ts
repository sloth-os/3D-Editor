import type { Mat4, Quat, Vec3 } from '../math/types';
import { fromQuat4, invert4, multiply4 } from '../math/mat4';
import { multiplyQuat, quatFromAxisAngle } from '../math/quat';
import {
  blendMatrices,
  composeTRS,
  decomposeTRS,
  quatFromRotationMatrix,
  rotateAbout,
  rotationBetween,
  rotationPart,
  tailOf,
} from './bone-math';

/*
 * Inverse kinematics for bone chains.
 *
 * A chain is a run of bones (root first, each the parent of the next). Its joints are the bone
 * heads plus the effector (the tail of the last bone); each segment is rigid in its bone's frame,
 * so chains with disconnected bones work as well. Joint positions are solved with FABRIK
 * (forward and backward reaching), which keeps every segment length, then every bone is turned
 * by the shortest rotation that moves its segment onto the solved one (no extra twist).
 *
 * Pole targets follow Blender: before and after solving, the whole chain is rotated about its
 * root so that the root bone's X axis — rotated by `poleAngle` towards its Z axis — faces the pole
 * (in the plane perpendicular to the root → goal direction).
 *
 * Bones with IK settings (Blender's pose bone lock_ik_*, use_ik_limit_* / ik_min_* / ik_max_* and
 * ik_stiffness_*) make their job use a damped least-squares solver over the bones' local rotation
 * axes instead (like Blender's iTaSC / Standard solver): a locked axis is not a degree of freedom
 * at all, stiffness weights an axis down, and after every step each limited bone's rotation
 * relative to its rest pose is clamped (swing about X / Z and twist about Y, the bone axis).
 */

/** Per-bone IK settings (Blender pose bone lock_ik_*, use_ik_limit_*, ik_min_* / ik_max_*, ik_stiffness_*). */
export interface IkBoneSettings {
  /** Local X / Y / Z axes the solver may not rotate the bone about. */
  lock: [boolean, boolean, boolean];
  /** Allowed rotation per local axis relative to the rest pose ([min, max] radians), or null. */
  limit: [[number, number] | null, [number, number] | null, [number, number] | null];
  /** Resistance to rotation per local axis, 0 (none) … 0.99. */
  stiffness: [number, number, number];
}

/** The IK fields of a pose bone (Blender names); see `PoseBone`. */
export interface PoseBoneIkFields {
  lock_ik_x?: unknown;
  lock_ik_y?: unknown;
  lock_ik_z?: unknown;
  use_ik_limit_x?: unknown;
  use_ik_limit_y?: unknown;
  use_ik_limit_z?: unknown;
  ik_min_x?: unknown;
  ik_min_y?: unknown;
  ik_min_z?: unknown;
  ik_max_x?: unknown;
  ik_max_y?: unknown;
  ik_max_z?: unknown;
  ik_stiffness_x?: unknown;
  ik_stiffness_y?: unknown;
  ik_stiffness_z?: unknown;
}

/**
 * IK settings of a pose bone (null when it has none), with Blender's ranges and defaults: limits
 * ik_min_* in [-π, 0] (default -π) and ik_max_* in [0, π] (default π), stiffness in [0, 0.99].
 * Invalid values are reported through `problem` and replaced by the default.
 */
export function ikSettingsOf(
  pb: PoseBoneIkFields | null | undefined,
  problem: (message: string) => void = () => {},
): IkBoneSettings | null {
  if (!pb || typeof pb !== 'object') return null;
  const num = (key: keyof PoseBoneIkFields, def: number, lo: number, hi: number): number => {
    const v = pb[key];
    if (v === undefined || v === null) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problem(`${key} is not a number; using ${+def.toFixed(4)}`);
      return def;
    }
    return Math.min(hi, Math.max(lo, v));
  };
  const axes = ['x', 'y', 'z'] as const;
  const lock = axes.map((a) => pb[`lock_ik_${a}`] === true) as IkBoneSettings['lock'];
  const limit = axes.map((a) =>
    pb[`use_ik_limit_${a}`] === true
      ? [num(`ik_min_${a}`, -Math.PI, -Math.PI, 0), num(`ik_max_${a}`, Math.PI, 0, Math.PI)]
      : null,
  ) as IkBoneSettings['limit'];
  const stiffness = axes.map((a) => num(`ik_stiffness_${a}`, 0, 0, 0.99)) as IkBoneSettings['stiffness'];
  const s: IkBoneSettings = { lock, limit, stiffness };
  return hasIkSettings(s) ? s : null;
}

/** True when the settings change anything (else the bone is solved like any other). */
export function hasIkSettings(s: IkBoneSettings | null | undefined): s is IkBoneSettings {
  return !!s && (s.lock.some(Boolean) || s.limit.some(Boolean) || s.stiffness.some((v) => v > 0));
}

/** A bone taking part in an IK job. `matrix` is updated in place by the solver. */
export interface IkBone {
  /** Armature-space matrix (head at the origin, +Y along the bone). */
  matrix: Mat4;
  length: number;
  /** Index of the parent within the job, -1 for bones whose parent is not part of the job. */
  parent: number;
  /**
   * The bone's rest frame, which IK limits are measured from: relative to its parent's matrix
   * (parent⁻¹ · frame) when the parent is part of the job, else in armature space. Defaults to the
   * bone's own starting matrix.
   */
  restFrame?: Mat4;
  /** Locks, limits and stiffness of the bone (null / omitted: free). */
  ik?: IkBoneSettings | null;
}

export interface IkChain {
  /** Job indices, root first; each bone is the parent of the next one. */
  bones: number[];
  /** Goal for the effector (tail of the last bone), armature space. */
  target: Vec3;
  /** Pole position (armature space) or null. */
  pole: Vec3 | null;
  poleAngle: number;
  iterations: number;
  useStretch: boolean;
  /** 0..1: blend of the chain bones between their unsolved and solved transforms. */
  influence: number;
}

export interface IkResult {
  /** Problems worth reporting (e.g. poles ignored for overlapping chains). */
  warnings: string[];
}

type V = [number, number, number];

const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Readonly<Vec3>): V | null => {
  const l = len(a);
  return l > 1e-12 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const head = (m: Readonly<Mat4>): V => [m[12], m[13], m[14]];

/** Mutable job state: matrices plus the rigid parent → child relations used for propagation. */
class Job {
  readonly children: number[][];
  /** parent⁻¹ · child at the start (fixed while solving). */
  readonly local: (Mat4 | null)[];
  /** Matrices at the start of the solve. */
  readonly initial: Mat4[];

  constructor(readonly bones: IkBone[]) {
    this.initial = bones.map((b) => b.matrix.slice());
    this.children = bones.map(() => []);
    this.local = bones.map((_, i) => this.relation(i));
    bones.forEach((b, i) => {
      if (b.parent >= 0) this.children[b.parent].push(i);
    });
  }

  /** Current parent⁻¹ · bone transform (null for bones without a parent in the job). */
  relation(i: number): Mat4 | null {
    const b = this.bones[i];
    return b.parent >= 0 ? multiply4(invert4(this.bones[b.parent].matrix), b.matrix) : null;
  }

  /** Recomputes the descendants of bone i from its (changed) matrix. */
  propagate(i: number): void {
    const stack = [...this.children[i]];
    while (stack.length) {
      const c = stack.pop()!;
      this.bones[c].matrix = multiply4(this.bones[this.bones[c].parent].matrix, this.local[c]!);
      stack.push(...this.children[c]);
    }
  }

  /** Rotates bone i about `pivot` (its relation to its parent changes, descendants follow). */
  rotate(i: number, r: Mat4, pivot: Readonly<Vec3>): void {
    this.bones[i].matrix = rotateAbout(this.bones[i].matrix, r, pivot);
    this.local[i] = this.relation(i);
    this.propagate(i);
  }

  /** Joint positions of a chain: bone heads, then the effector (tail of the last bone). */
  joints(chain: number[]): V[] {
    const pts = chain.map((i) => head(this.bones[i].matrix));
    const last = this.bones[chain[chain.length - 1]];
    pts.push(tailOf(last.matrix, last.length) as V);
    return pts;
  }
}

/**
 * Rotates the chain about its root so the root's pole "up" vector faces the pole, with the root
 * → effector direction turned onto the root → goal direction (Blender's pole constraint).
 */
function alignPole(job: Job, chain: IkChain): void {
  if (!chain.pole) return;
  const root = chain.bones[0];
  const m = job.bones[root].matrix;
  const rootPos = head(m);
  const pts = job.joints(chain.bones);
  const dir = unit(sub(pts[pts.length - 1], rootPos));
  const x = unit([m[0], m[1], m[2]]);
  const z = unit([m[8], m[9], m[10]]);
  const poleDir = unit(sub(chain.target, rootPos));
  const poleUp = unit(sub(chain.pole, rootPos));
  if (!dir || !x || !z || !poleDir || !poleUp) return;
  const c = Math.cos(chain.poleAngle);
  const s = Math.sin(chain.poleAngle);
  const up: V = [x[0] * c + z[0] * s, x[1] * c + z[1] * s, x[2] * c + z[2] * s];
  const m0 = unit(cross(dir, up));
  const p0 = unit(cross(poleDir, poleUp));
  if (!m0 || !p0) return;
  const m1 = cross(m0, dir);
  const p1 = cross(p0, poleDir);
  // Q = P · Mᵀ with frames (row0, row1, −dir)
  const M = [m0, m1, [-dir[0], -dir[1], -dir[2]] as V];
  const P = [p0, p1, [-poleDir[0], -poleDir[1], -poleDir[2]] as V];
  const q = new Array<number>(16).fill(0);
  for (let r = 0; r < 3; r++)
    for (let col = 0; col < 3; col++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += P[k][r] * M[k][col];
      q[col * 4 + r] = v;
    }
  q[15] = 1;
  job.rotate(root, q, rootPos);
}

/** Direction used to bend a straight chain: towards the pole, else the root bone's −Z axis. */
function bendDirection(job: Job, chain: IkChain, axis: Readonly<Vec3>): V {
  const perp = (v: Readonly<Vec3>): V | null => {
    const d = dot(v, axis);
    return unit([v[0] - axis[0] * d, v[1] - axis[1] * d, v[2] - axis[2] * d]);
  };
  const root = job.bones[chain.bones[0]].matrix;
  if (chain.pole) {
    const p = perp(sub(chain.pole, head(root)));
    if (p) return p;
  }
  return (
    perp([-root[8], -root[9], -root[10]]) ??
    perp([root[0], root[1], root[2]]) ??
    perp([1, 0, 0]) ??
    perp([0, 1, 0])!
  );
}

/** Solves the joint positions of one chain (FABRIK); returns the solved joints. */
function fabrik(job: Job, chain: IkChain): V[] {
  const pts = job.joints(chain.bones);
  const n = pts.length - 1;
  const seg = new Array<number>(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    seg[i] = len(sub(pts[i + 1], pts[i]));
    total += seg[i];
  }
  const root = pts[0];
  const goal = chain.target;
  const toGoal = sub(goal, root);
  const dist = len(toGoal);
  if (total < 1e-12) return pts;
  const goalDir = unit(toGoal);
  if (dist >= total || !goalDir) {
    // out of reach (or goal on the root): stretch straight towards the goal
    const d = goalDir ?? unit(sub(pts[n], root)) ?? ([0, 1, 0] as V);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      pts[i + 1] = [p[0] + d[0] * seg[i], p[1] + d[1] * seg[i], p[2] + d[2] * seg[i]];
    }
    return pts;
  }
  // A perfectly straight chain cannot fold: give it a slight, deterministic bend.
  if (n >= 2) {
    const axis = unit(sub(pts[n], root)) ?? goalDir;
    let maxOff = 0;
    for (let i = 1; i < n; i++) {
      const v = sub(pts[i], root);
      const along = dot(v, axis);
      maxOff = Math.max(
        maxOff,
        len([v[0] - axis[0] * along, v[1] - axis[1] * along, v[2] - axis[2] * along]),
      );
    }
    if (maxOff < 1e-6 * total) {
      const b = bendDirection(job, chain, axis);
      const off = 0.02 * total;
      for (let i = 1; i < n; i++)
        pts[i] = [pts[i][0] + b[0] * off, pts[i][1] + b[1] * off, pts[i][2] + b[2] * off];
    }
  }
  const tol = Math.max(1e-9, total * 1e-7);
  const place = (from: V, toward: V, l: number, fallback: V | null): V => {
    const d = unit(sub(toward, from)) ?? fallback ?? goalDir;
    return [from[0] + d[0] * l, from[1] + d[1] * l, from[2] + d[2] * l];
  };
  for (let it = 0; it < chain.iterations; it++) {
    // forward: effector onto the goal, walk back to the root
    pts[n] = [goal[0], goal[1], goal[2]];
    for (let i = n - 1; i >= 0; i--) pts[i] = place(pts[i + 1], pts[i], seg[i], null);
    // backward: root back in place, walk out to the effector
    pts[0] = [root[0], root[1], root[2]];
    for (let i = 0; i < n; i++) pts[i + 1] = place(pts[i], pts[i + 1], seg[i], null);
    if (len(sub(pts[n], goal)) <= tol) break;
  }
  return pts;
}

/** Turns every chain bone (root first) so its segment points at the solved joint. */
function applyJoints(job: Job, chain: IkChain, pts: V[]): void {
  const bones = chain.bones;
  for (let k = 0; k < bones.length; k++) {
    const i = bones[k];
    const m = job.bones[i].matrix;
    const h = head(m);
    const cur = k + 1 < bones.length ? head(job.bones[bones[k + 1]].matrix) : tailOf(m, job.bones[i].length);
    const from = sub(cur, h);
    const to = sub(pts[k + 1], h);
    if (len(from) < 1e-12 || len(to) < 1e-12) continue;
    job.rotate(i, rotationBetween(from, to), h);
  }
}

/** Scales the chain bones along their Y axis so the (straightened) chain reaches the goal. */
function stretch(job: Job, chain: IkChain): void {
  const pts = job.joints(chain.bones);
  const n = pts.length - 1;
  let total = 0;
  for (let i = 0; i < n; i++) total += len(sub(pts[i + 1], pts[i]));
  const dist = len(sub(chain.target, pts[0]));
  if (total < 1e-12 || dist <= total * (1 + 1e-9)) return;
  const f = dist / total;
  // new heads: the root stays, every segment grows by f
  const heads: V[] = [pts[0]];
  for (let i = 1; i < n; i++) {
    const d = sub(pts[i], pts[i - 1]);
    const p = heads[i - 1];
    heads.push([p[0] + d[0] * f, p[1] + d[1] * f, p[2] + d[2] * f]);
  }
  for (let k = 0; k < chain.bones.length; k++) {
    const b = job.bones[chain.bones[k]];
    const trs = decomposeTRS(b.matrix);
    const r = rotationPart(b.matrix);
    const m = r.slice();
    for (let c = 0; c < 3; c++) {
      m[c] *= trs.scale[0];
      m[4 + c] *= trs.scale[1] * f;
      m[8 + c] *= trs.scale[2];
    }
    m[12] = heads[k][0];
    m[13] = heads[k][1];
    m[14] = heads[k][2];
    b.matrix = m;
  }
  // refresh the chain's own relations, then let the other descendants follow
  for (const i of chain.bones) job.local[i] = job.relation(i);
  for (const i of chain.bones)
    for (const c of job.children[i]) if (!chain.bones.includes(c)) job.propagate(i);
}

/** Effector (tail of the last bone) of a chain. */
function effectorOf(job: Job, chain: IkChain): V {
  const last = job.bones[chain.bones[chain.bones.length - 1]];
  return tailOf(last.matrix, last.length) as V;
}

/**
 * Largest-eigenvalue eigenvector of a symmetric 4x4 matrix (cyclic Jacobi rotations), used by
 * Horn's method below.
 */
function maxEigenvector4(a: number[][]): number[] {
  const m = a.map((r) => r.slice());
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += m[p][q] * m[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++)
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(m[p][q]) < 1e-300) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const mkp = m[k][p];
          const mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < 4; k++) {
          const mpk = m[p][k];
          const mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (m[i][i] > m[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * Rotation R minimising Σ w·|R·a − b|² (Horn's quaternion method), as a 4x4 matrix; null when
 * the vectors do not determine it.
 */
function fitRotation(pairs: { a: V; b: V; w: number }[]): Mat4 | null {
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const { a, b, w } of pairs)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += w * a[i] * b[j];
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const n = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [w, x, y, z] = maxEigenvector4(n);
  const l = Math.hypot(w, x, y, z);
  if (!(l > 1e-12)) return null;
  const q = [x / l, y / l, z / l, w / l];
  const [qx, qy, qz, qw] = q;
  return [
    1 - 2 * (qy * qy + qz * qz),
    2 * (qx * qy + qw * qz),
    2 * (qx * qz - qw * qy),
    0,
    2 * (qx * qy - qw * qz),
    1 - 2 * (qx * qx + qz * qz),
    2 * (qy * qz + qw * qx),
    0,
    2 * (qx * qz + qw * qy),
    2 * (qy * qz - qw * qx),
    1 - 2 * (qx * qx + qy * qy),
    0,
    0,
    0,
    0,
    1,
  ];
}

/**
 * Joint refinement of chains that share bones (multi-effector cyclic coordinate descent): each
 * bone, from the tips towards the roots, takes the rotation about its head that best moves all
 * effectors below it onto their goals (the shortest rotation when it drives a single effector).
 */
function refineShared(job: Job, chains: IkChain[]): void {
  const order = [...new Set(chains.flatMap((c) => c.bones))].sort((a, b) => b - a);
  const users = new Map<number, IkChain[]>();
  for (const c of chains)
    for (const b of c.bones) {
      const list = users.get(b);
      if (list) list.push(c);
      else users.set(b, [c]);
    }
  let scale = 0;
  for (const c of chains) for (const b of c.bones) scale += job.bones[b].length;
  const tol = Math.max(1e-9, scale * 1e-5);
  const error = () => chains.reduce((s, c) => s + len(sub(effectorOf(job, c), c.target)), 0);
  const maxIt = Math.min(1000, Math.max(...chains.map((c) => c.iterations)));
  let prev = error();
  for (let it = 0; it < maxIt && prev > tol; it++) {
    for (const b of order) {
      const list = users.get(b)!;
      const pivot = head(job.bones[b].matrix);
      const pairs = list.map((c) => ({
        a: sub(effectorOf(job, c), pivot),
        b: sub(c.target, pivot),
        w: 1,
      }));
      let r: Mat4 | null;
      if (pairs.length === 1) r = rotationBetween(pairs[0].a, pairs[0].b);
      else r = fitRotation(pairs);
      if (r) job.rotate(b, r, pivot);
    }
    const e = error();
    // stop once an iteration hardly improves anything (e.g. unreachable goals)
    if (e > prev * (1 - 1e-4)) break;
    prev = e;
  }
}

/**
 * Applies the chains' influence: every chain bone's transform relative to its parent is blended
 * between the unsolved (FK) and the solved result (bones of several chains use the largest
 * influence); descendants follow their blended parents.
 */
function blendInfluence(bones: IkBone[], initial: Mat4[], chains: IkChain[]): void {
  const weight = new Map<number, number>();
  for (const c of chains)
    for (const b of c.bones) weight.set(b, Math.max(weight.get(b) ?? 0, Math.min(1, c.influence)));
  if ([...weight.values()].every((w) => w >= 1)) return;
  const solved = bones.map((b) => b.matrix);
  const out: Mat4[] = [];
  bones.forEach((b, i) => {
    const w = weight.get(i) ?? 1;
    if (b.parent < 0) out.push(blendMatrices(initial[i], solved[i], w));
    else {
      const fk = multiply4(invert4(initial[b.parent]), initial[i]);
      const ik = multiply4(invert4(solved[b.parent]), solved[i]);
      out.push(multiply4(out[b.parent], blendMatrices(fk, ik, w)));
    }
  });
  bones.forEach((b, i) => (b.matrix = out[i]));
}

// ------------------------------------------------------------------ constrained solver

/** Twist (about the bone's Y axis) and swing rotation vector (x, z) of a local rotation q = swing · twist. */
function swingTwist(q: Readonly<Quat>): { sx: number; sz: number; twist: number } {
  const tl = Math.hypot(q[1], q[3]);
  // a half-turn swing has no defined twist: take none
  const tw: Quat = tl > 1e-9 ? [0, q[1] / tl, 0, q[3] / tl] : [0, 0, 0, 1];
  let twist = 2 * Math.atan2(tw[1], tw[3]);
  if (twist > Math.PI) twist -= 2 * Math.PI;
  else if (twist < -Math.PI) twist += 2 * Math.PI;
  let sw = multiplyQuat(q, [0, -tw[1], 0, tw[3]]);
  if (sw[3] < 0) sw = [-sw[0], -sw[1], -sw[2], -sw[3]];
  const sl = Math.hypot(sw[0], sw[1], sw[2]);
  const angle = 2 * Math.atan2(sl, sw[3]);
  const k = sl > 1e-12 ? angle / sl : 2;
  return { sx: sw[0] * k, sz: sw[2] * k, twist };
}

/** Rotation from a swing rotation vector (x, 0, z) followed by a twist about Y: swing · twist. */
function fromSwingTwist(sx: number, sz: number, twist: number): Quat {
  const a = Math.hypot(sx, sz);
  const swing: Quat = a > 1e-12 ? quatFromAxisAngle([sx / a, 0, sz / a], a) : [0, 0, 0, 1];
  return multiplyQuat(swing, quatFromAxisAngle([0, 1, 0], twist));
}

/**
 * Clamps a bone's rotation relative to its rest frame to its IK limits (swing about X / Z and
 * twist about Y). Returns the clamped local rotation, or null when it is within the limits.
 */
export function clampIkRotation(q: Readonly<Quat>, s: IkBoneSettings): Quat | null {
  if (!s.limit.some(Boolean)) return null;
  const st = swingTwist(q);
  const clamp = (v: number, l: [number, number] | null) => (l ? Math.min(l[1], Math.max(l[0], v)) : v);
  const sx = clamp(st.sx, s.limit[0]);
  const twist = clamp(st.twist, s.limit[1]);
  const sz = clamp(st.sz, s.limit[2]);
  if (sx === st.sx && sz === st.sz && twist === st.twist) return null;
  return fromSwingTwist(sx, sz, twist);
}

/** Solves A x = b (small dense system, partial pivoting); null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = M[r][n];
    for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k];
    x[r] = v / M[r][r];
  }
  return x;
}

/**
 * The rest frame of a job bone in armature space, under its parent's current matrix (without a
 * `restFrame`, the bone's starting pose counts as its rest pose).
 */
function restFrameOf(job: Job, i: number): Mat4 {
  const b = job.bones[i];
  if (b.parent < 0) return b.restFrame ?? job.initial[i];
  const rel = b.restFrame ?? multiply4(invert4(job.initial[b.parent]), job.initial[i]);
  return multiply4(job.bones[b.parent].matrix, rel);
}

/** Replaces the rotation of bone i (location and scale kept), descendants follow. */
function setRotation(job: Job, i: number, r: Readonly<Quat>): void {
  const trs = decomposeTRS(job.bones[i].matrix);
  job.bones[i].matrix = composeTRS({ location: trs.location, rotation: [...r] as Quat, scale: trs.scale });
  job.local[i] = job.relation(i);
  job.propagate(i);
}

/** Clamps bone i to its IK limits; true when it changed. */
function enforceLimits(job: Job, i: number): boolean {
  const s = job.bones[i].ik;
  if (!s || !s.limit.some(Boolean)) return false;
  const frame = quatFromRotationMatrix(rotationPart(restFrameOf(job, i)));
  const cur = quatFromRotationMatrix(rotationPart(job.bones[i].matrix));
  const local = multiplyQuat([-frame[0], -frame[1], -frame[2], frame[3]], cur);
  const clamped = clampIkRotation(local, s);
  if (!clamped) return false;
  setRotation(job, i, multiplyQuat(frame, clamped));
  return true;
}

interface Dof {
  bone: number;
  axis: 0 | 1 | 2;
  weight: number;
}

/**
 * Damped least-squares IK over the local rotation axes of the chain bones (Blender's Jacobian
 * solver): locked axes are left out, stiffness lowers an axis' weight, limits are enforced after
 * every step (axes held at a limit stop moving that way). All chains of the job are solved
 * together. Returns the remaining effector error.
 */
function solveConstrained(job: Job, chains: IkChain[]): number {
  const order = [...new Set(chains.flatMap((c) => c.bones))].sort((a, b) => a - b);
  const dofs: Dof[] = [];
  for (const b of order) {
    const s = job.bones[b].ik;
    for (const axis of [0, 1, 2] as const) {
      if (s?.lock[axis]) continue;
      dofs.push({ bone: b, axis, weight: Math.max(0.01, 1 - Math.min(0.99, s?.stiffness[axis] ?? 0)) });
    }
  }
  const inChain = chains.map((c) => new Set(c.bones));
  let scale = 0;
  for (const b of order) scale += job.bones[b].length;
  const tol = Math.max(1e-9, scale * 1e-7);
  const lambda = 0.02 * scale;
  const maxIt = Math.min(10000, Math.max(...chains.map((c) => c.iterations)));
  const m = chains.length * 3;
  const errorVec = (): number[] => {
    const e: number[] = [];
    for (const c of chains) {
      const eff = effectorOf(job, c);
      e.push(c.target[0] - eff[0], c.target[1] - eff[1], c.target[2] - eff[2]);
    }
    return e;
  };
  for (const b of order) enforceLimits(job, b);
  let e = errorVec();
  let err = Math.hypot(...e);
  let best = err;
  let stall = 0;
  for (let it = 0; it < maxIt && err > tol && dofs.length; it++) {
    // Jacobian columns: d(effector)/d(angle) = axis × (effector − joint)
    const effectors = chains.map((c) => effectorOf(job, c));
    const cols = dofs.map((d) => {
      const M = job.bones[d.bone].matrix;
      const a = unit([M[d.axis * 4], M[d.axis * 4 + 1], M[d.axis * 4 + 2]]) ?? ([0, 0, 0] as V);
      const h = head(M);
      const col: number[] = [];
      chains.forEach((c, ci) => {
        if (!inChain[ci].has(d.bone)) col.push(0, 0, 0);
        else col.push(...cross(a, sub(effectors[ci], h)));
      });
      return col;
    });
    let weights = dofs.map((d) => d.weight);
    let step: number[] | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const A: number[][] = [];
      for (let r = 0; r < m; r++) {
        const row = new Array<number>(m).fill(0);
        for (let c = 0; c < m; c++) {
          let v = 0;
          for (let j = 0; j < dofs.length; j++) v += cols[j][r] * weights[j] * cols[j][c];
          row[c] = v + (r === c ? lambda * lambda : 0);
        }
        A.push(row);
      }
      const y = solveLinear(A, e);
      if (!y) break;
      step = dofs.map((_, j) => {
        let v = 0;
        for (let r = 0; r < m; r++) v += cols[j][r] * y[r];
        return weights[j] * v;
      });
      // axes held at a limit that the step pushes further out drop out (active set), once
      if (pass > 0) break;
      let blocked = false;
      weights = weights.map((w, j) => {
        const d = dofs[j];
        const lim = job.bones[d.bone].ik?.limit[d.axis];
        if (!lim || step![j] === 0) return w;
        const frame = quatFromRotationMatrix(rotationPart(restFrameOf(job, d.bone)));
        const cur = quatFromRotationMatrix(rotationPart(job.bones[d.bone].matrix));
        const st = swingTwist(multiplyQuat([-frame[0], -frame[1], -frame[2], frame[3]], cur));
        const v = d.axis === 0 ? st.sx : d.axis === 1 ? st.twist : st.sz;
        const atMax = v >= lim[1] - 1e-9 && step![j] > 0;
        const atMin = v <= lim[0] + 1e-9 && step![j] < 0;
        if (!atMax && !atMin) return w;
        blocked = true;
        return 0;
      });
      if (!blocked) break;
    }
    if (!step) break;
    // keep steps small (the linearisation only holds near the current pose)
    const big = Math.max(...step.map(Math.abs));
    const f = big > 0.2 ? 0.2 / big : 1;
    const perBone = new Map<number, V>();
    dofs.forEach((d, j) => {
      const v = perBone.get(d.bone) ?? ([0, 0, 0] as V);
      v[d.axis] += step![j] * f;
      perBone.set(d.bone, v);
    });
    for (const b of order) {
      const v = perBone.get(b);
      if (!v) continue;
      const angle = len(v);
      if (!(angle > 0)) continue;
      // rotation about the bone's own (current) local axes: R ← R · Rot(v)
      const cur = quatFromRotationMatrix(rotationPart(job.bones[b].matrix));
      setRotation(job, b, multiplyQuat(cur, quatFromAxisAngle([v[0] / angle, v[1] / angle, v[2] / angle], angle)));
    }
    for (const b of order) enforceLimits(job, b);
    e = errorVec();
    err = Math.hypot(...e);
    if (err < best * (1 - 1e-6)) {
      best = err;
      stall = 0;
    } else if (++stall >= 20) break;
  }
  return err;
}

/**
 * Solves the IK chains of one job. A single chain uses FABRIK with its pole; chains that share
 * bones are first solved one after the other and then refined jointly (poles are ignored there,
 * like Blender does with several targets). Jobs with locked, limited or stiff bones use the
 * damped least-squares solver (`solveConstrained`). Bone matrices are updated in place.
 */
export function solveIk(bones: IkBone[], chains: IkChain[]): IkResult {
  const warnings: string[] = [];
  const initial = bones.map((x) => x.matrix.slice());
  const job = new Job(bones);
  const valid = chains.filter(
    (c) => c.bones.length > 0 && c.target.every(Number.isFinite) && c.influence > 0,
  );
  if (valid.length === 0) return { warnings };
  if (valid.some((c) => c.bones.some((b) => hasIkSettings(bones[b].ik)))) {
    const single = valid.length === 1 ? valid[0] : null;
    const rootSet = single ? hasIkSettings(bones[single.bones[0]].ik) : false;
    if (single?.pole && rootSet)
      warnings.push(
        'the pole target is ignored: the root bone of the chain has IK locks, limits or stiffness',
      );
    if (!single && valid.some((c) => c.pole))
      warnings.push('pole targets are ignored for IK chains that share bones');
    const pole = single && !rootSet ? single : null;
    if (pole) alignPole(job, pole);
    solveConstrained(job, valid.map((c) => ({ ...c, pole: null })));
    if (pole) alignPole(job, pole);
    for (const chain of valid) if (chain.useStretch) stretch(job, chain);
    blendInfluence(bones, initial, valid);
    return { warnings };
  }
  if (valid.length === 1) {
    const chain = valid[0];
    alignPole(job, chain);
    applyJoints(job, chain, fabrik(job, chain));
    alignPole(job, chain);
    if (chain.useStretch) stretch(job, chain);
    blendInfluence(bones, initial, valid);
    return { warnings };
  }
  if (valid.some((c) => c.pole)) warnings.push('pole targets are ignored for IK chains that share bones');
  const shared = valid.map((c) => ({ ...c, pole: null }));
  for (let pass = 0; pass < 2; pass++)
    for (const chain of shared) applyJoints(job, chain, fabrik(job, chain));
  refineShared(job, shared);
  for (const chain of shared) if (chain.useStretch) stretch(job, chain);
  blendInfluence(bones, initial, valid);
  return { warnings };
}
