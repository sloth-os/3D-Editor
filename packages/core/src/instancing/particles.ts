import type { Mat4 } from '../math/types';
import type { MeshData } from '../mesh/types';
import { faceNormalRaw } from '../mesh/normals';
import { slerpQuat } from '../math/quat';
import type { EvaluatedInstance } from './types';
import type { ParticleSettings } from './settings';
import { linear3, normalMatrix3, rotation3 } from './matrix';
import { hash01, randomQuat, streamKey } from './random';
import { SAMPLE_POINT, SAMPLE_TRI, SAMPLE_VERT, type ParticleSamples } from './sampling';

/*
 * Placement of particle instances. Each particle gets a world-space frame
 *
 *   F = T(E · p) · R · S(size · |L · n|)
 *
 * where p and n are the particle position and surface normal on the emitter mesh (object space),
 * E the emitter world matrix with linear part L, and R a pure rotation whose local +Z axis follows
 * the rotation mode (surface normal, world up, or the emitter orientation) plus phase and random
 * rotation. |L · n| is the emitter's scale along the surface normal (like the world-space hair
 * length that scales Blender hair instances): for an emitter that is only moved, rotated and
 * uniformly scaled, F equals E · (particle frame in object space) exactly, while an emitter
 * stretched along its surface (a ground plane scaled in X/Y) neither stretches nor shears its
 * instances. Every instance source contributes one or more templates (its own geometry, nested
 * instances, whole-collection members) whose matrices are relative to F.
 */

/** Geometry instanced relative to a particle frame. */
export interface SourceTemplate {
  sourceId: string;
  /** Matrix relative to the particle frame. */
  matrix: Mat4;
  /** True when `matrix` is the identity (fast path). */
  identity: boolean;
  /** Appended to the particle's instance id ('' for the main geometry). */
  suffix: string;
}

/** One choice of what a particle instances (an object, or a whole collection). */
export interface SourceOption {
  /** Display name (for messages). */
  name: string;
  templates: SourceTemplate[];
  /** Relative pick weight. */
  weight: number;
}

export interface PlacementInput {
  ownerId: string;
  systemId: string;
  samples: ParticleSamples;
  /** Mesh providing positions and normals; same topology as the distribution mesh. */
  mesh: MeshData;
  /** Emitter world matrix. */
  matrix: Mat4;
  settings: ParticleSettings;
  options: readonly SourceOption[];
  /** Viewport evaluation (applies display_percentage). */
  viewport: boolean;
  /** Maximum number of instances to create. */
  limit: number;
}

export interface PlacementResult {
  instances: EvaluatedInstance[];
  /** Particles that were placed (after display_percentage). */
  particles: number;
  truncated: boolean;
}

// random channels of the placement stream
const CH_SIZE = 0;
const CH_PHASE = 1;
const CH_ROT1 = 2;
const CH_ROT2 = 3;
const CH_ROT3 = 4;
const CH_PICK = 5;
const CH_DISPLAY = 6;

interface NormalCache {
  vertex?: Float64Array;
  face?: Float64Array;
}
const normalCache = new WeakMap<MeshData, NormalCache>();

function normalsOf(mesh: MeshData): NormalCache {
  let c = normalCache.get(mesh);
  if (!c) normalCache.set(mesh, (c = {}));
  return c;
}

/** Unit face normals (Newell), cached per mesh instance. */
function faceNormals(mesh: MeshData): Float64Array {
  const c = normalsOf(mesh);
  if (!c.face) {
    const out = new Float64Array(mesh.faces.length * 3);
    for (let f = 0; f < mesh.faces.length; f++) {
      const n = faceNormalRaw(mesh, f);
      const l = Math.hypot(n[0], n[1], n[2]);
      if (l > 0 && Number.isFinite(l)) {
        out[f * 3] = n[0] / l;
        out[f * 3 + 1] = n[1] / l;
        out[f * 3 + 2] = n[2] / l;
      }
    }
    c.face = out;
  }
  return c.face;
}

/** Unit area-weighted vertex normals (zero for loose vertices), cached per mesh instance. */
function vertexNormals(mesh: MeshData): Float64Array {
  const c = normalsOf(mesh);
  if (!c.vertex) {
    const nv = Math.floor(mesh.positions.length / 3);
    const out = new Float64Array(nv * 3);
    for (let f = 0; f < mesh.faces.length; f++) {
      const loop = mesh.faces[f];
      if (!loop || loop.length < 3) continue;
      const n = faceNormalRaw(mesh, f);
      if (!Number.isFinite(n[0] + n[1] + n[2])) continue;
      for (const v of loop) {
        if (!(v >= 0 && v < nv)) continue;
        out[v * 3] += n[0];
        out[v * 3 + 1] += n[1];
        out[v * 3 + 2] += n[2];
      }
    }
    for (let v = 0; v < nv; v++) {
      const l = Math.hypot(out[v * 3], out[v * 3 + 1], out[v * 3 + 2]);
      if (l > 0) {
        out[v * 3] /= l;
        out[v * 3 + 1] /= l;
        out[v * 3 + 2] /= l;
      }
    }
    c.vertex = out;
  }
  return c.vertex;
}

/** Builds the cumulative pick table for options (random picks). */
function pickTable(options: readonly SourceOption[]): { cum: number[]; total: number } {
  const cum: number[] = [];
  let total = 0;
  for (const o of options) {
    total += o.weight > 0 && Number.isFinite(o.weight) ? o.weight : 0;
    cum.push(total);
  }
  return { cum, total };
}

/** In-order sequence (Blender: objects cycle in order, weights act as repeat counts). */
function orderSequence(options: readonly SourceOption[]): number[] {
  const reps = options.map((o) => (o.weight > 0 && Number.isFinite(o.weight) ? Math.round(o.weight) : 0));
  const total = reps.reduce((a, b) => a + b, 0);
  if (total === 0) {
    // fractional weights: one slot per option with positive weight
    const seq = options.flatMap((o, i) => (o.weight > 0 ? [i] : []));
    return seq;
  }
  if (total > 10000) {
    const k = 10000 / total;
    for (let i = 0; i < reps.length; i++) reps[i] = reps[i] > 0 ? Math.max(1, Math.round(reps[i] * k)) : 0;
  }
  const seq: number[] = [];
  reps.forEach((r, i) => {
    for (let k = 0; k < r; k++) seq.push(i);
  });
  return seq;
}

/** Computes the instances of one particle system. */
export function placeParticles(input: PlacementInput): PlacementResult {
  const { samples, mesh, settings: s, options } = input;
  const instances: EvaluatedInstance[] = [];
  if (samples.count === 0 || options.length === 0 || input.limit <= 0)
    return { instances, particles: 0, truncated: false };
  const key = streamKey(s.seed, 0x91ace);
  const E = input.matrix;
  const L = linear3(E);
  const Rm = rotation3(L);
  const Nm = normalMatrix3(L);
  // emitter rotation columns
  const ex0 = Rm[0];
  const ex1 = Rm[1];
  const ex2 = Rm[2];
  const ez0 = Rm[6];
  const ez1 = Rm[7];
  const ez2 = Rm[8];
  const mode = s.rotation_mode;
  const needTangent = mode === 'NORMAL_TANGENT';
  const p = mesh.positions;
  const nv = Math.floor(p.length / 3);
  const fn = faceNormals(mesh);
  const vn = vertexNormals(mesh);
  const tris = samples.tris;
  const display = input.viewport ? Math.max(0, Math.min(100, s.display_percentage)) / 100 : 1;
  const pickRandom = s.use_collection_pick_random && options.length > 1;
  const table = pickRandom ? pickTable(options) : null;
  const sequence = !pickRandom && options.length > 1 ? orderSequence(options) : null;
  if ((table && table.total <= 0) || (sequence && sequence.length === 0))
    return { instances, particles: 0, truncated: false };
  const phaseBase = s.phase_factor * Math.PI;
  const phaseRandom = s.phase_factor_random * Math.PI;
  const randRot = s.rotation_factor_random;
  const sizeBase = s.particle_size;
  const sizeRandom = s.size_random;
  const prefix = `${input.ownerId}:${input.systemId}:`;

  // Rotation shared by every particle for NONE / GLOBAL_Z.
  const fixed = mode === 'NONE' || mode === 'GLOBAL_Z';
  let fx0 = ex0;
  let fx1 = ex1;
  let fx2 = ex2;
  let fz0 = ez0;
  let fz1 = ez1;
  let fz2 = ez2;
  if (mode === 'GLOBAL_Z') {
    const r = alignX(ex0, ex1, ex2, ez0, ez1, ez2, 0, 0, 1);
    fx0 = r[0];
    fx1 = r[1];
    fx2 = r[2];
    fz0 = 0;
    fz1 = 0;
    fz2 = 1;
  }

  let particles = 0;
  let truncated = false;
  for (let i = 0; i < samples.count; i++) {
    const pid = samples.ids[i];
    if (display < 1 && !(hash01(key, pid, CH_DISPLAY) < display)) continue;
    // ---- position, normal and tangent in object space
    let px: number;
    let py: number;
    let pz: number;
    let nx = 0;
    let ny = 0;
    let nz = 1;
    let tx = 1;
    let ty = 0;
    let tz = 0;
    let hasTangent = false;
    const kind = samples.kind[i];
    const elem = samples.elem[i];
    if (kind === SAMPLE_TRI && tris) {
      const v0 = tris.verts[elem * 3];
      const v1 = tris.verts[elem * 3 + 1];
      const v2 = tris.verts[elem * 3 + 2];
      if (v0 >= nv || v1 >= nv || v2 >= nv) continue;
      const w1 = samples.bary[i * 2];
      const w2 = samples.bary[i * 2 + 1];
      const w0 = 1 - w1 - w2;
      px = w0 * p[v0 * 3] + w1 * p[v1 * 3] + w2 * p[v2 * 3];
      py = w0 * p[v0 * 3 + 1] + w1 * p[v1 * 3 + 1] + w2 * p[v2 * 3 + 1];
      pz = w0 * p[v0 * 3 + 2] + w1 * p[v1 * 3 + 2] + w2 * p[v2 * 3 + 2];
      {
        const f = tris.face[elem];
        if (mesh.faceSmooth[f]) {
          nx = w0 * vn[v0 * 3] + w1 * vn[v1 * 3] + w2 * vn[v2 * 3];
          ny = w0 * vn[v0 * 3 + 1] + w1 * vn[v1 * 3 + 1] + w2 * vn[v2 * 3 + 1];
          nz = w0 * vn[v0 * 3 + 2] + w1 * vn[v1 * 3 + 2] + w2 * vn[v2 * 3 + 2];
        } else if (f < mesh.faces.length) {
          nx = fn[f * 3];
          ny = fn[f * 3 + 1];
          nz = fn[f * 3 + 2];
        }
        if (needTangent) {
          const uv = mesh.uvs?.[f];
          const c0 = tris.corners[elem * 3];
          const c1 = tris.corners[elem * 3 + 1];
          const c2 = tris.corners[elem * 3 + 2];
          if (uv && uv.length >= 2 * Math.max(c0, c1, c2) + 2) {
            const du1 = uv[c1 * 2] - uv[c0 * 2];
            const dv1 = uv[c1 * 2 + 1] - uv[c0 * 2 + 1];
            const du2 = uv[c2 * 2] - uv[c0 * 2];
            const dv2 = uv[c2 * 2 + 1] - uv[c0 * 2 + 1];
            const det = du1 * dv2 - du2 * dv1;
            if (det !== 0 && Number.isFinite(det)) {
              const r = 1 / det;
              const e1x = p[v1 * 3] - p[v0 * 3];
              const e1y = p[v1 * 3 + 1] - p[v0 * 3 + 1];
              const e1z = p[v1 * 3 + 2] - p[v0 * 3 + 2];
              const e2x = p[v2 * 3] - p[v0 * 3];
              const e2y = p[v2 * 3 + 1] - p[v0 * 3 + 1];
              const e2z = p[v2 * 3 + 2] - p[v0 * 3 + 2];
              tx = (e1x * dv2 - e2x * dv1) * r;
              ty = (e1y * dv2 - e2y * dv1) * r;
              tz = (e1z * dv2 - e2z * dv1) * r;
              hasTangent = true;
            }
          }
        }
      }
    } else if (kind === SAMPLE_VERT) {
      if (elem < 0 || elem >= nv) continue;
      px = p[elem * 3];
      py = p[elem * 3 + 1];
      pz = p[elem * 3 + 2];
      nx = vn[elem * 3];
      ny = vn[elem * 3 + 1];
      nz = vn[elem * 3 + 2];
    } else if (kind === SAMPLE_POINT && samples.points) {
      px = samples.points[i * 3];
      py = samples.points[i * 3 + 1];
      pz = samples.points[i * 3 + 2];
    } else continue;
    if (!Number.isFinite(px + py + pz)) continue;
    // unit object-space normal (+Z when unknown or degenerate)
    let nl = Math.hypot(nx, ny, nz);
    if (!(nl > 1e-12) || !Number.isFinite(nl)) {
      nx = 0;
      ny = 0;
      nz = 1;
      nl = 1;
    }
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // the emitter's scale along the normal (world length of the unit normal)
    const stretch = Math.hypot(
      L[0] * nx + L[3] * ny + L[6] * nz,
      L[1] * nx + L[4] * ny + L[7] * nz,
      L[2] * nx + L[5] * ny + L[8] * nz,
    );

    // ---- world position
    const wx = E[0] * px + E[4] * py + E[8] * pz + E[12];
    const wy = E[1] * px + E[5] * py + E[9] * pz + E[13];
    const wz = E[2] * px + E[6] * py + E[10] * pz + E[14];

    // ---- orientation: columns x, y, z of R
    let x0: number;
    let x1: number;
    let x2: number;
    let z0: number;
    let z1: number;
    let z2: number;
    if (fixed) {
      x0 = fx0;
      x1 = fx1;
      x2 = fx2;
      z0 = fz0;
      z1 = fz1;
      z2 = fz2;
    } else {
      // world normal through the normal matrix (falls back to the emitter rotation)
      let n0 = Nm[0] * nx + Nm[3] * ny + Nm[6] * nz;
      let n1 = Nm[1] * nx + Nm[4] * ny + Nm[7] * nz;
      let n2 = Nm[2] * nx + Nm[5] * ny + Nm[8] * nz;
      let l = Math.hypot(n0, n1, n2);
      if (!(l > 1e-12) || !Number.isFinite(l)) {
        n0 = Rm[0] * nx + Rm[3] * ny + Rm[6] * nz;
        n1 = Rm[1] * nx + Rm[4] * ny + Rm[7] * nz;
        n2 = Rm[2] * nx + Rm[5] * ny + Rm[8] * nz;
        l = Math.hypot(n0, n1, n2);
      }
      if (l > 1e-12 && Number.isFinite(l)) {
        z0 = n0 / l;
        z1 = n1 / l;
        z2 = n2 / l;
      } else {
        z0 = ez0;
        z1 = ez1;
        z2 = ez2;
      }
      let done = false;
      x0 = 0;
      x1 = 0;
      x2 = 0;
      if (needTangent) {
        // tangent: UV direction, else the emitter's X axis, projected onto the tangent plane
        let t0: number;
        let t1: number;
        let t2: number;
        if (hasTangent) {
          t0 = L[0] * tx + L[3] * ty + L[6] * tz;
          t1 = L[1] * tx + L[4] * ty + L[7] * tz;
          t2 = L[2] * tx + L[5] * ty + L[8] * tz;
        } else {
          t0 = ex0;
          t1 = ex1;
          t2 = ex2;
        }
        const d = t0 * z0 + t1 * z1 + t2 * z2;
        t0 -= d * z0;
        t1 -= d * z1;
        t2 -= d * z2;
        const tl = Math.hypot(t0, t1, t2);
        if (tl > 1e-9 && Number.isFinite(tl)) {
          x0 = t0 / tl;
          x1 = t1 / tl;
          x2 = t2 / tl;
          done = true;
        }
      }
      if (!done) {
        const r = alignX(ex0, ex1, ex2, ez0, ez1, ez2, z0, z1, z2);
        x0 = r[0];
        x1 = r[1];
        x2 = r[2];
      }
    }
    // y = z × x
    let y0 = z1 * x2 - z2 * x1;
    let y1 = z2 * x0 - z0 * x2;
    let y2 = z0 * x1 - z1 * x0;
    // phase: rotation around the aligned +Z axis
    const phase = phaseBase + (phaseRandom ? phaseRandom * hash01(key, pid, CH_PHASE) : 0);
    if (phase !== 0) {
      const c = Math.cos(phase);
      const sn = Math.sin(phase);
      const nx0 = c * x0 + sn * y0;
      const nx1 = c * x1 + sn * y1;
      const nx2 = c * x2 + sn * y2;
      y0 = -sn * x0 + c * y0;
      y1 = -sn * x1 + c * y1;
      y2 = -sn * x2 + c * y2;
      x0 = nx0;
      x1 = nx1;
      x2 = nx2;
    }
    if (randRot > 0) {
      const q = slerpQuat(
        quatFromBasis(x0, x1, x2, y0, y1, y2, z0, z1, z2),
        randomQuat(hash01(key, pid, CH_ROT1), hash01(key, pid, CH_ROT2), hash01(key, pid, CH_ROT3)),
        randRot,
      );
      const [qx, qy, qz, qw] = q;
      x0 = 1 - 2 * (qy * qy + qz * qz);
      x1 = 2 * (qx * qy + qz * qw);
      x2 = 2 * (qx * qz - qy * qw);
      y0 = 2 * (qx * qy - qz * qw);
      y1 = 1 - 2 * (qx * qx + qz * qz);
      y2 = 2 * (qy * qz + qx * qw);
      z0 = 2 * (qx * qz + qy * qw);
      z1 = 2 * (qy * qz - qx * qw);
      z2 = 1 - 2 * (qx * qx + qy * qy);
    }
    const size = sizeBase * stretch * (sizeRandom > 0 ? 1 - sizeRandom * hash01(key, pid, CH_SIZE) : 1);
    const F: Mat4 = [
      x0 * size,
      x1 * size,
      x2 * size,
      0,
      y0 * size,
      y1 * size,
      y2 * size,
      0,
      z0 * size,
      z1 * size,
      z2 * size,
      0,
      wx,
      wy,
      wz,
      1,
    ];

    // ---- source choice
    let option: SourceOption;
    if (table) {
      const u = hash01(key, pid, CH_PICK) * table.total;
      let k = 0;
      while (k < table.cum.length - 1 && !(table.cum[k] > u)) k++;
      option = options[k];
    } else if (sequence) option = options[sequence[i % sequence.length]];
    else option = options[0];
    particles++;

    const base = prefix + pid;
    let frameUsed = false;
    for (const t of option.templates) {
      if (instances.length >= input.limit) {
        truncated = true;
        break;
      }
      let matrix: Mat4;
      if (!t.identity) matrix = mulFrame(F, t.matrix);
      else if (frameUsed) matrix = F.slice();
      else {
        matrix = F;
        frameUsed = true;
      }
      instances.push({ id: base + t.suffix, ownerId: input.ownerId, sourceId: t.sourceId, matrix });
    }
    if (truncated) break;
  }
  return { instances, particles, truncated };
}

/**
 * X axis of the minimal rotation taking the frame (ex, ez) to a frame whose Z axis is `n`
 * (rotation about ez × n applied to ex). Keeps the heading of the emitter frame as well as possible.
 */
function alignX(
  ex0: number,
  ex1: number,
  ex2: number,
  ez0: number,
  ez1: number,
  ez2: number,
  n0: number,
  n1: number,
  n2: number,
): [number, number, number] {
  const c = ez0 * n0 + ez1 * n1 + ez2 * n2;
  // v = ez × n
  const v0 = ez1 * n2 - ez2 * n1;
  const v1 = ez2 * n0 - ez0 * n2;
  const v2 = ez0 * n1 - ez1 * n0;
  if (c > -1 + 1e-9) {
    // A·x = x + v × x + (v (v·x) − |v|² x) / (1 + c)
    const k = 1 / (1 + c);
    const vx = v0 * ex0 + v1 * ex1 + v2 * ex2;
    const vv = v0 * v0 + v1 * v1 + v2 * v2;
    const r0 = ex0 + (v1 * ex2 - v2 * ex1) + (v0 * vx - vv * ex0) * k;
    const r1 = ex1 + (v2 * ex0 - v0 * ex2) + (v1 * vx - vv * ex1) * k;
    const r2 = ex2 + (v0 * ex1 - v1 * ex0) + (v2 * vx - vv * ex2) * k;
    const l = Math.hypot(r0, r1, r2) || 1;
    return [r0 / l, r1 / l, r2 / l];
  }
  // opposite directions: half turn about the emitter's X axis (keeps X, flips Y and Z)
  return [ex0, ex1, ex2];
}

/** Quaternion [x, y, z, w] of the rotation with basis columns x, y, z. */
function quatFromBasis(
  m00: number,
  m10: number,
  m20: number,
  m01: number,
  m11: number,
  m21: number,
  m02: number,
  m12: number,
  m22: number,
): [number, number, number, number] {
  const tr = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

/** F · T for an affine particle frame F and template matrix T. */
function mulFrame(F: Readonly<Mat4>, T: Readonly<Mat4>): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 3; c++) {
    const b0 = T[c * 4];
    const b1 = T[c * 4 + 1];
    const b2 = T[c * 4 + 2];
    out[c * 4] = F[0] * b0 + F[4] * b1 + F[8] * b2;
    out[c * 4 + 1] = F[1] * b0 + F[5] * b1 + F[9] * b2;
    out[c * 4 + 2] = F[2] * b0 + F[6] * b1 + F[10] * b2;
    out[c * 4 + 3] = 0;
  }
  out[12] = F[0] * T[12] + F[4] * T[13] + F[8] * T[14] + F[12];
  out[13] = F[1] * T[12] + F[5] * T[13] + F[9] * T[14] + F[13];
  out[14] = F[2] * T[12] + F[6] * T[13] + F[10] * T[14] + F[14];
  out[15] = 1;
  return out;
}
