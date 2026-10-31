import type { Mat4, Quat, Vec3 } from '../math/types';
import { invert4, multiply4 } from '../math/mat4';
import { invertRigid, quatFromRotationMatrix, rotationPart } from './bone-math';
import type { ArmaturePose, PoseBoneMatrix } from './types';

/*
 * Mesh skinning by an armature pose (Blender's Armature modifier). Positions are deformed in
 * armature space by the bones' deform matrices (posed · rest⁻¹), blended with normalised
 * per-vertex weights: linearly (LBS), or as dual quaternions (DQS, "Preserve Volume"), where
 * the rotation/translation part of each bone is blended as a dual quaternion and any pose scale
 * is blended separately and applied first, about the bone head in rest space.
 */

/** Sparse per-vertex weights (CSR): vertex v uses entries offsets[v] .. offsets[v+1]-1. */
export interface SkinWeights {
  offsets: Int32Array;
  bones: Int32Array;
  weights: Float64Array;
}

/** Builds CSR weights from dense per-bone weight arrays (entries ≤ 0 or non-finite are skipped). */
export function denseToSkinWeights(
  perBone: readonly (ArrayLike<number> | null)[],
  vertexCount: number,
): SkinWeights {
  const valid = (x: number) => x > 0 && Number.isFinite(x);
  const offsets = new Int32Array(vertexCount + 1);
  for (const w of perBone) {
    if (!w) continue;
    const n = Math.min(vertexCount, w.length);
    for (let v = 0; v < n; v++) if (valid(w[v])) offsets[v + 1]++;
  }
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const total = offsets[vertexCount];
  const bones = new Int32Array(total);
  const weights = new Float64Array(total);
  const fill = offsets.slice(0, vertexCount);
  perBone.forEach((w, b) => {
    if (!w) return;
    const n = Math.min(vertexCount, w.length);
    for (let v = 0; v < n; v++) {
      if (!valid(w[v])) continue;
      bones[fill[v]] = b;
      weights[fill[v]++] = w[v];
    }
  });
  return { offsets, bones, weights };
}

/**
 * Envelope influence (0..1) of a bone at point `p` (Blender's envelope falloff): 1 inside the
 * capsule whose radius is interpolated from `headRadius` to `tailRadius` (spherical caps at both
 * ends), falling off quadratically to 0 over `distance` beyond it.
 */
export function envelopeFactor(
  p: Readonly<Vec3>,
  head: Readonly<Vec3>,
  tail: Readonly<Vec3>,
  headRadius: number,
  tailRadius: number,
  distance: number,
): number {
  const bx = tail[0] - head[0];
  const by = tail[1] - head[1];
  const bz = tail[2] - head[2];
  const l = Math.hypot(bx, by, bz);
  const px = p[0] - head[0];
  const py = p[1] - head[1];
  const pz = p[2] - head[2];
  const along = l > 0 ? (px * bx + py * by + pz * bz) / l : 0;
  let d2: number;
  let rad: number;
  if (along < 0 || l === 0) {
    d2 = px * px + py * py + pz * pz;
    rad = headRadius;
  } else if (along > l) {
    const qx = p[0] - tail[0];
    const qy = p[1] - tail[1];
    const qz = p[2] - tail[2];
    d2 = qx * qx + qy * qy + qz * qz;
    rad = tailRadius;
  } else {
    d2 = Math.max(0, px * px + py * py + pz * pz - along * along);
    const t = along / l;
    rad = headRadius + (tailRadius - headRadius) * t;
  }
  if (d2 < rad * rad) return 1;
  const outer = rad + distance;
  if (distance <= 0 || d2 >= outer * outer) return 0;
  const a = Math.sqrt(d2) - rad;
  return 1 - (a * a) / (distance * distance);
}

/** Envelope weight of a posed bone at a rest-space point (falloff × envelope weight). */
export function boneEnvelopeWeight(b: PoseBoneMatrix, p: Readonly<Vec3>): number {
  const e = b.envelope ?? { distance: 0.25, weight: 1, headRadius: 0.1, tailRadius: 0.05 };
  const head = b.restHead ?? ([b.rest[12], b.rest[13], b.rest[14]] as Vec3);
  const tail =
    b.restTail ??
    ([
      b.rest[12] + b.rest[4] * b.length,
      b.rest[13] + b.rest[5] * b.length,
      b.rest[14] + b.rest[6] * b.length,
    ] as Vec3);
  const f = envelopeFactor(p, head, tail, e.headRadius, e.tailRadius, e.distance);
  return f > 0 ? f * e.weight : 0;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Per-bone deform data used while skinning. */
interface DeformBone {
  /** posed · rest⁻¹ */
  deform: Mat4;
  /** DQS: unit rotation quaternion and dual part of the rigid motion. */
  q: Quat;
  qd: Quat;
  /** DQS: rest-space scale/shear matrix applied before the rigid motion (null = none). */
  scale: Mat4 | null;
}

function mulQuat(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function prepareBone(b: PoseBoneMatrix, dqs: boolean): DeformBone {
  const restInv = invertRigid(b.rest);
  const deform = multiply4(b.matrix, restInv);
  if (!dqs) return { deform, q: [0, 0, 0, 1], qd: [0, 0, 0, 0], scale: null };
  // posed = T·R·S (S in bone space); rigid G = (T·R)·rest⁻¹; scale K = rest·S·rest⁻¹
  const r = rotationPart(b.matrix);
  r[12] = b.matrix[12];
  r[13] = b.matrix[13];
  r[14] = b.matrix[14];
  const g = multiply4(r, restInv);
  const s = multiply4(invertRigid(r), b.matrix);
  let scale: Mat4 | null = null;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(s[i] - IDENTITY[i]) > 1e-7) {
      scale = multiply4(multiply4(b.rest, s), restInv);
      break;
    }
  }
  const q = quatFromRotationMatrix(g);
  const t: Quat = [g[12], g[13], g[14], 0];
  const tq = mulQuat(t, q);
  return { deform, q, qd: [tq[0] * 0.5, tq[1] * 0.5, tq[2] * 0.5, tq[3] * 0.5], scale };
}

export interface SkinOptions {
  /** Dual quaternion skinning (Blender "Preserve Volume"). */
  preserveVolume: boolean;
  /** Optional per-vertex influence of the whole deformation (0..1). */
  mask?: ArrayLike<number> | null;
}

/** Minimum total weight for a vertex to be deformed at all (Blender uses the same cut-off). */
const MIN_CONTRIB = 1e-4;

/**
 * Deforms armature-space positions (flat xyz) by `bones` with the given weights. Weights are
 * normalised per vertex; vertices whose total weight is below 1e-4 keep their position.
 * Returns new positions (the input is not modified).
 */
export function skinPositions(
  positions: ArrayLike<number>,
  weights: SkinWeights,
  bones: readonly PoseBoneMatrix[],
  opts: SkinOptions,
): number[] {
  const n = Math.floor(positions.length / 3);
  const out = Array.from(positions) as number[];
  const prepared = bones.map((b) => prepareBone(b, opts.preserveVolume));
  const { offsets, bones: bi, weights: bw } = weights;
  for (let v = 0; v < n; v++) {
    const s = offsets[v];
    const e = offsets[v + 1];
    if (s === e) continue;
    let total = 0;
    for (let i = s; i < e; i++) total += bw[i];
    if (!(total > MIN_CONTRIB)) continue;
    const mask = opts.mask ? Math.min(1, Math.max(0, opts.mask[v] ?? 0)) : 1;
    if (mask === 0) continue;
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    let rx: number;
    let ry: number;
    let rz: number;
    if (!opts.preserveVolume) {
      rx = 0;
      ry = 0;
      rz = 0;
      for (let i = s; i < e; i++) {
        const m = prepared[bi[i]].deform;
        const w = bw[i] / total;
        rx += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
        ry += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
        rz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
    } else {
      // blend dual quaternions (aligned to one hemisphere) and the scale matrices (identity for
      // bones without pose scale)
      const q: Quat = [0, 0, 0, 0];
      const qd: Quat = [0, 0, 0, 0];
      let sx = x;
      let sy = y;
      let sz = z;
      let scaled = false;
      for (let i = s; i < e; i++) {
        const b = prepared[bi[i]];
        let w = bw[i] / total;
        if (b.scale) scaled = true;
        if (q[0] * b.q[0] + q[1] * b.q[1] + q[2] * b.q[2] + q[3] * b.q[3] < 0) w = -w;
        for (let c = 0; c < 4; c++) {
          q[c] += w * b.q[c];
          qd[c] += w * b.qd[c];
        }
      }
      if (scaled) {
        const k = new Array<number>(16).fill(0);
        for (let i = s; i < e; i++) {
          const m = prepared[bi[i]].scale ?? IDENTITY;
          const w = bw[i] / total;
          for (let c = 0; c < 16; c++) k[c] += w * m[c];
        }
        sx = k[0] * x + k[4] * y + k[8] * z + k[12];
        sy = k[1] * x + k[5] * y + k[9] * z + k[13];
        sz = k[2] * x + k[6] * y + k[10] * z + k[14];
      }
      const ql = Math.hypot(q[0], q[1], q[2], q[3]);
      if (!(ql > 1e-12)) continue;
      const [qx, qy, qz, qw] = [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
      const d = [qd[0] / ql, qd[1] / ql, qd[2] / ql, qd[3] / ql];
      // remove the component of the dual part along the real part (keeps a pure rigid motion)
      const proj = qx * d[0] + qy * d[1] + qz * d[2] + qw * d[3];
      const dx = d[0] - qx * proj;
      const dy = d[1] - qy * proj;
      const dz = d[2] - qz * proj;
      const dw = d[3] - qw * proj;
      // translation = 2 · qd · conj(q)
      const tx = 2 * (-dw * qx + dx * qw - dy * qz + dz * qy);
      const ty = 2 * (-dw * qy + dx * qz + dy * qw - dz * qx);
      const tz = 2 * (-dw * qz - dx * qy + dy * qx + dz * qw);
      // rotate (sx, sy, sz) by the unit quaternion
      const cx = 2 * (qy * sz - qz * sy);
      const cy = 2 * (qz * sx - qx * sz);
      const cz = 2 * (qx * sy - qy * sx);
      rx = sx + qw * cx + (qy * cz - qz * cy) + tx;
      ry = sy + qw * cy + (qz * cx - qx * cz) + ty;
      rz = sz + qw * cz + (qx * cy - qy * cx) + tz;
    }
    out[v * 3] = x + (rx - x) * mask;
    out[v * 3 + 1] = y + (ry - y) * mask;
    out[v * 3 + 2] = z + (rz - z) * mask;
  }
  return out;
}

/** Deform bones of a pose (in pose order), i.e. bones with `deform !== false`. */
export function deformBones(pose: ArmaturePose): PoseBoneMatrix[] {
  const out: PoseBoneMatrix[] = [];
  for (const name of pose.order) {
    const b = pose.bones.get(name);
    if (b && b.deform !== false) out.push(b);
  }
  return out;
}

/** Matrix mapping a mesh object's local space into its armature's space: armWorld⁻¹ · meshWorld. */
export function meshToArmatureSpace(meshWorld: Readonly<Mat4>, armatureWorld: Readonly<Mat4>): Mat4 {
  return multiply4(invert4(armatureWorld), meshWorld);
}
