import type { Vec3 } from '../math/types';
import { clipFeatures, reduceManifold, type ContactCandidate } from './manifold';
import { closestSegmentPoints } from './sat';
import { len3, type Mat3 } from './vmath';

/*
 * Closed-form narrow phase tests for the most common pairs:
 * - box / box: separating axis test over the 15 axes of two oriented boxes (3 + 3 face normals,
 *   9 edge-edge cross products, Gottschalk), with clipped face manifolds or one edge-edge point;
 * - sphere / box: closest point on the box;
 * - sphere / triangle: closest point on the triangle (Ericson).
 * Normals point from the first shape to the second; contacts separated by more than `maxSep`
 * (speculative distance) are not generated.
 */

/** An oriented box inside a body's frame. */
export interface BoxFrame {
  /** Box centre in body space. */
  center: Vec3;
  /** Rotation box → body, row-major (column k is the box's k-th axis). */
  axes: Mat3;
  half: Vec3;
  /** Axes are the identity and the centre is the origin (no transform needed). */
  aligned: boolean;
}

const absR = new Float64Array(9);

/**
 * Contacts between box A (axis aligned, centred at the origin, half extents `ha`) and box B
 * (half extents `hb`, rotation `r` whose columns are B's axes in A's frame, centre `t`).
 * Returns false when a separating axis with a gap larger than `maxSep` exists.
 */
export function collideBoxes(
  ha: Readonly<Vec3>,
  hb: Readonly<Vec3>,
  r: Readonly<Mat3>,
  t: Readonly<Vec3>,
  maxSep: number,
  out: ContactCandidate[],
): boolean {
  for (let k = 0; k < 9; k++) absR[k] = Math.abs(r[k]);
  // ---- A's face normals
  let faceA = -1;
  let sepA = -Infinity;
  for (let i = 0; i < 3; i++) {
    const rb = hb[0] * absR[i * 3] + hb[1] * absR[i * 3 + 1] + hb[2] * absR[i * 3 + 2];
    const s = Math.abs(t[i]) - ha[i] - rb;
    if (s > maxSep) return false;
    if (s > sepA) {
      sepA = s;
      faceA = i;
    }
  }
  // ---- B's face normals
  let faceB = -1;
  let sepB = -Infinity;
  for (let j = 0; j < 3; j++) {
    const ra = ha[0] * absR[j] + ha[1] * absR[3 + j] + ha[2] * absR[6 + j];
    const d = t[0] * r[j] + t[1] * r[3 + j] + t[2] * r[6 + j];
    const s = Math.abs(d) - ra - hb[j];
    if (s > maxSep) return false;
    if (s > sepB) {
      sepB = s;
      faceB = j;
    }
  }
  // ---- edge-edge axes A_i × B_j
  let edge = -1;
  let sepE = -Infinity;
  let ex = 0;
  let ey = 0;
  let ez = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const bx = r[j];
      const by = r[3 + j];
      const bz = r[6 + j];
      const lx = i === 0 ? 0 : i === 1 ? bz : -by;
      const ly = i === 0 ? -bz : i === 1 ? 0 : bx;
      const lz = i === 0 ? by : i === 1 ? -bx : 0;
      const len = len3(lx, ly, lz);
      // (nearly) parallel edges: the face axes cover this direction
      if (len < 1e-5) continue;
      const ra = ha[0] * Math.abs(lx) + ha[1] * Math.abs(ly) + ha[2] * Math.abs(lz);
      let rb = 0;
      for (let m = 0; m < 3; m++) rb += hb[m] * Math.abs(lx * r[m] + ly * r[3 + m] + lz * r[6 + m]);
      const d = t[0] * lx + t[1] * ly + t[2] * lz;
      const s = (Math.abs(d) - ra - rb) / len;
      if (s > maxSep) return false;
      if (s > sepE) {
        sepE = s;
        edge = i * 3 + j;
        const k = (d < 0 ? -1 : 1) / len;
        ex = lx * k;
        ey = ly * k;
        ez = lz * k;
      }
    }

  const edgeContact = (): boolean => {
    if (edge < 0) return false;
    const i = (edge / 3) | 0;
    const j = edge % 3;
    const n: Vec3 = [ex, ey, ez];
    // A's supporting edge: parallel to its axis i, at the corner furthest along n
    const a0: Vec3 = [0, 0, 0];
    const a1: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      if (k === i) {
        a0[k] = -ha[k];
        a1[k] = ha[k];
      } else a0[k] = a1[k] = n[k] > 0 ? ha[k] : -ha[k];
    }
    // B's supporting edge: parallel to its axis j, at the corner furthest along −n
    let cx = t[0];
    let cy = t[1];
    let cz = t[2];
    for (let m = 0; m < 3; m++) {
      if (m === j) continue;
      const s = n[0] * r[m] + n[1] * r[3 + m] + n[2] * r[6 + m] > 0 ? -hb[m] : hb[m];
      cx += s * r[m];
      cy += s * r[3 + m];
      cz += s * r[6 + m];
    }
    const hx = hb[j] * r[j];
    const hy = hb[j] * r[3 + j];
    const hz = hb[j] * r[6 + j];
    const [pa, pb] = closestSegmentPoints(a0, a1, [cx - hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz + hz]);
    const s = n[0] * (pb[0] - pa[0]) + n[1] * (pb[1] - pa[1]) + n[2] * (pb[2] - pa[2]);
    if (!(s <= maxSep)) return false;
    const gap = len3(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    if (gap > 1.5 * Math.abs(s) + Math.max(maxSep, 0) + 1e-3) return false;
    out.push({ pa, pb, n, s });
    return true;
  };

  // prefer face contacts (stable manifolds) unless an edge axis separates clearly better
  const maxFace = Math.max(sepA, sepB);
  if (edge >= 0 && sepE > maxFace + 0.05 * Math.abs(maxFace) + 1e-3 && edgeContact()) return true;
  const contacts: ContactCandidate[] = [];
  if (sepB > sepA + 0.02 * Math.abs(sepA) + 5e-4) {
    // reference face on B (the one facing A), incident face on A
    const j = faceB;
    const d = t[0] * r[j] + t[1] * r[3 + j] + t[2] * r[6 + j];
    const sg = d < 0 ? -1 : 1;
    const n: Vec3 = [r[j] * sg, r[3 + j] * sg, r[6 + j] * sg];
    let i = 0;
    for (let k = 1; k < 3; k++) if (Math.abs(n[k]) > Math.abs(n[i])) i = k;
    clipFeatures(faceOfA(ha, i, n[i] > 0 ? 1 : -1), faceOfB(hb, r, t, j, -sg), n, maxSep, contacts);
  } else {
    // reference face on A (the one facing B), incident face on B
    const i = faceA;
    const sg = t[i] < 0 ? -1 : 1;
    const n: Vec3 = [0, 0, 0];
    n[i] = sg;
    let j = 0;
    for (let m = 1; m < 3; m++) if (absR[i * 3 + m] > absR[i * 3 + j]) j = m;
    const facing = r[i * 3 + j] * sg > 0 ? -1 : 1;
    clipFeatures(faceOfA(ha, i, sg), faceOfB(hb, r, t, j, facing), n, maxSep, contacts);
  }
  if (contacts.length === 0) return edgeContact();
  for (const c of reduceManifold(contacts)) out.push(c);
  return true;
}

/**
 * Contacts between a box (axis aligned at the origin, half extents h) and a two-sided triangle
 * (flat xyz in the box frame): separating axis test over the box faces, the triangle normal and
 * the 9 edge-edge axes. Normals point from the box to the triangle. `skipEdge(j)` marks
 * triangle edges (v_j → v_j+1) that must not produce edge-edge contacts (internal mesh edges);
 * they still separate. Returns false when separated by more than `maxSep`.
 */
export function collideBoxTriangle(
  h: Readonly<Vec3>,
  tri: ArrayLike<number>,
  maxSep: number,
  out: ContactCandidate[],
  skipEdge?: (edge: number) => boolean,
): boolean {
  // ---- box face axes
  let faceK = 0;
  let faceSign = 1;
  let sepF = -Infinity;
  for (let k = 0; k < 3; k++) {
    const a = tri[k];
    const b = tri[3 + k];
    const c = tri[6 + k];
    const sPos = Math.min(a, b, c) - h[k];
    const sNeg = -Math.max(a, b, c) - h[k];
    if (sPos > maxSep || sNeg > maxSep) return false;
    if (sPos > sepF) {
      sepF = sPos;
      faceK = k;
      faceSign = 1;
    }
    if (sNeg > sepF) {
      sepF = sNeg;
      faceK = k;
      faceSign = -1;
    }
  }
  // ---- triangle normal (two-sided)
  const e0x = tri[3] - tri[0];
  const e0y = tri[4] - tri[1];
  const e0z = tri[5] - tri[2];
  const e2x = tri[6] - tri[0];
  const e2y = tri[7] - tri[1];
  const e2z = tri[8] - tri[2];
  let nx = e0y * e2z - e0z * e2y;
  let ny = e0z * e2x - e0x * e2z;
  let nz = e0x * e2y - e0y * e2x;
  const nl = len3(nx, ny, nz);
  if (!(nl > 0)) return false;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const d = nx * tri[0] + ny * tri[1] + nz * tri[2];
  const sepT = Math.abs(d) - (h[0] * Math.abs(nx) + h[1] * Math.abs(ny) + h[2] * Math.abs(nz));
  if (sepT > maxSep) return false;
  const tSign = d < 0 ? -1 : 1;
  // ---- edge-edge axes e_k × edge_j
  let edgeJ = -1;
  let edgeK = 0;
  let sepE = -Infinity;
  let lx = 0;
  let ly = 0;
  let lz = 0;
  for (let j = 0; j < 3; j++) {
    const a = j * 3;
    const b = ((j + 1) % 3) * 3;
    const fx = tri[b] - tri[a];
    const fy = tri[b + 1] - tri[a + 1];
    const fz = tri[b + 2] - tri[a + 2];
    const fl = len3(fx, fy, fz);
    for (let k = 0; k < 3; k++) {
      const ax = k === 0 ? 0 : k === 1 ? fz : -fy;
      const ay = k === 0 ? -fz : k === 1 ? 0 : fx;
      const az = k === 0 ? fy : k === 1 ? -fx : 0;
      const len = len3(ax, ay, az);
      if (len < 1e-9 * fl) continue;
      const rb = h[0] * Math.abs(ax) + h[1] * Math.abs(ay) + h[2] * Math.abs(az);
      const p0 = ax * tri[0] + ay * tri[1] + az * tri[2];
      const p1 = ax * tri[3] + ay * tri[4] + az * tri[5];
      const p2 = ax * tri[6] + ay * tri[7] + az * tri[8];
      const sPos = (Math.min(p0, p1, p2) - rb) / len;
      const sNeg = (-Math.max(p0, p1, p2) - rb) / len;
      if (sPos > maxSep || sNeg > maxSep) return false;
      const s = Math.max(sPos, sNeg);
      if (s > sepE) {
        sepE = s;
        edgeJ = j;
        edgeK = k;
        const sg = (sPos >= sNeg ? 1 : -1) / len;
        lx = ax * sg;
        ly = ay * sg;
        lz = az * sg;
      }
    }
  }

  const edgeUsable = edgeJ >= 0 && !skipEdge?.(edgeJ);
  const edgeContact = (): boolean => {
    if (!edgeUsable) return false;
    const n: Vec3 = [lx, ly, lz];
    const b0: Vec3 = [0, 0, 0];
    const b1: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (i === edgeK) {
        b0[i] = -h[i];
        b1[i] = h[i];
      } else b0[i] = b1[i] = n[i] > 0 ? h[i] : -h[i];
    }
    const a = edgeJ * 3;
    const b = ((edgeJ + 1) % 3) * 3;
    const [pa, pb] = closestSegmentPoints(
      b0,
      b1,
      [tri[a], tri[a + 1], tri[a + 2]],
      [tri[b], tri[b + 1], tri[b + 2]],
    );
    const s = n[0] * (pb[0] - pa[0]) + n[1] * (pb[1] - pa[1]) + n[2] * (pb[2] - pa[2]);
    if (!(s <= maxSep)) return false;
    const gap = len3(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    if (gap > 1.5 * Math.abs(s) + Math.max(maxSep, 0) + 1e-3) return false;
    out.push({ pa, pb, n, s });
    return true;
  };

  const maxFace = Math.max(sepF, sepT);
  if (edgeUsable && sepE > maxFace + 0.05 * Math.abs(maxFace) + 1e-3 && edgeContact()) return true;
  const contacts: ContactCandidate[] = [];
  if (sepF > sepT + 0.02 * Math.abs(sepT) + 5e-4) {
    // reference: the box face facing the triangle
    const n: Vec3 = [0, 0, 0];
    n[faceK] = faceSign;
    clipFeatures(faceOfA(h, faceK, faceSign), tri, n, maxSep, contacts);
  } else {
    // reference: the triangle; incident: the box face most aligned with the normal towards it
    const n: Vec3 = [nx * tSign, ny * tSign, nz * tSign];
    let k = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(n[i]) > Math.abs(n[k])) k = i;
    clipFeatures(faceOfA(h, k, n[k] > 0 ? 1 : -1), tri, n, maxSep, contacts);
  }
  if (contacts.length === 0) return edgeContact();
  for (const c of reduceManifold(contacts)) out.push(c);
  return true;
}

// Face corner scratch (the narrow phase is not re-entrant; clipFeatures copies what it keeps).
const faceScratchA = new Float64Array(12);
const faceScratchB = new Float64Array(12);
/** Corner signs (u, v) of a box face, counter-clockwise around the face axis. */
const CORNER_U = [-1, 1, 1, -1];
const CORNER_V = [-1, -1, 1, 1];

/** Corners (flat xyz, in a shared scratch array) of A's face on axis i at side `sign`. */
function faceOfA(h: Readonly<Vec3>, i: number, sign: number): Float64Array {
  const u = (i + 1) % 3;
  const v = (i + 2) % 3;
  const out = faceScratchA;
  for (let c = 0; c < 4; c++) {
    out[c * 3 + i] = sign * h[i];
    out[c * 3 + u] = CORNER_U[c] * h[u];
    out[c * 3 + v] = CORNER_V[c] * h[v];
  }
  return out;
}

/** Corners of B's face on its axis j at side `sign` (B placed by rotation r and centre t). */
function faceOfB(
  h: Readonly<Vec3>,
  r: Readonly<Mat3>,
  t: Readonly<Vec3>,
  j: number,
  sign: number,
): Float64Array {
  const u = (j + 1) % 3;
  const v = (j + 2) % 3;
  const out = faceScratchB;
  for (let c = 0; c < 4; c++) {
    const a = sign * h[j];
    const b = CORNER_U[c] * h[u];
    const d = CORNER_V[c] * h[v];
    for (let k = 0; k < 3; k++)
      out[c * 3 + k] = t[k] + r[k * 3 + j] * a + r[k * 3 + u] * b + r[k * 3 + v] * d;
  }
  return out;
}

/**
 * Contact between a box (axis aligned at the origin, half extents h) and a sphere with centre c
 * (box frame) and radius `radius`. The normal points from the box to the sphere.
 */
export function collideSphereBox(
  c: Readonly<Vec3>,
  radius: number,
  h: Readonly<Vec3>,
  maxSep: number,
  out: ContactCandidate[],
): boolean {
  const qx = Math.min(h[0], Math.max(-h[0], c[0]));
  const qy = Math.min(h[1], Math.max(-h[1], c[1]));
  const qz = Math.min(h[2], Math.max(-h[2], c[2]));
  const dx = c[0] - qx;
  const dy = c[1] - qy;
  const dz = c[2] - qz;
  const dist = len3(dx, dy, dz);
  let n: Vec3;
  let pa: Vec3;
  let s: number;
  if (dist > 1e-12) {
    s = dist - radius;
    if (s > maxSep) return false;
    n = [dx / dist, dy / dist, dz / dist];
    pa = [qx, qy, qz];
  } else {
    // centre inside the box: out through the nearest face
    let axis = 0;
    let depth = Infinity;
    for (let k = 0; k < 3; k++) {
      const dk = h[k] - Math.abs(c[k]);
      if (dk < depth) {
        depth = dk;
        axis = k;
      }
    }
    n = [0, 0, 0];
    n[axis] = c[axis] < 0 ? -1 : 1;
    pa = [c[0], c[1], c[2]];
    pa[axis] = n[axis] * h[axis];
    s = -depth - radius;
  }
  out.push({ pa, pb: [c[0] - n[0] * radius, c[1] - n[1] * radius, c[2] - n[2] * radius], n, s });
  return true;
}

/** Closest point to p on triangle (a, b, c) (Ericson, "Real-Time Collision Detection" 5.1.5). */
export function closestPointOnTriangle(
  p: Readonly<Vec3>,
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
): Vec3 {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [a[0], a[1], a[2]];
  const bpx = p[0] - b[0];
  const bpy = p[1] - b[1];
  const bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [b[0], b[1], b[2]];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + abx * v, a[1] + aby * v, a[2] + abz * v];
  }
  const cpx = p[0] - c[0];
  const cpy = p[1] - c[1];
  const cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [c[0], c[1], c[2]];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + acx * w, a[1] + acy * w, a[2] + acz * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = va + vb + vc;
  if (!(Math.abs(denom) > 1e-300)) return [a[0], a[1], a[2]];
  const v = vb / denom;
  const w = vc / denom;
  return [a[0] + abx * v + acx * w, a[1] + aby * v + acy * w, a[2] + abz * v + acz * w];
}
