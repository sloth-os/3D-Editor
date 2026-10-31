import type { Mat4, Vec3 } from '../math/types';
import { invert4, multiply4 } from '../math/mat4';
import { blendMatrices, decomposeTRS, rotateAbout, rotationBetween, rotationPart, tailOf } from './bone-math';

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
 */

/** A bone taking part in an IK job. `matrix` is updated in place by the solver. */
export interface IkBone {
  /** Armature-space matrix (head at the origin, +Y along the bone). */
  matrix: Mat4;
  length: number;
  /** Index of the parent within the job, -1 for bones whose parent is not part of the job. */
  parent: number;
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

  constructor(readonly bones: IkBone[]) {
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

/**
 * Solves the IK chains of one job. A single chain uses FABRIK with its pole; chains that share
 * bones are first solved one after the other and then refined jointly (poles are ignored there,
 * like Blender does with several targets). Bone matrices are updated in place.
 */
export function solveIk(bones: IkBone[], chains: IkChain[]): IkResult {
  const warnings: string[] = [];
  const initial = bones.map((x) => x.matrix.slice());
  const job = new Job(bones);
  const valid = chains.filter(
    (c) => c.bones.length > 0 && c.target.every(Number.isFinite) && c.influence > 0,
  );
  if (valid.length === 0) return { warnings };
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
