import type { Vec3 } from '../math/types';
import { len3 } from './vmath';

/*
 * Contact manifold construction: clipping the "incident" feature of one shape against the
 * "reference" face of the other (Sutherland-Hodgman), and reduction of many candidate points to
 * a stable set of at most four per contact normal.
 */

export interface ContactCandidate {
  /** Point on A's surface. */
  pa: Vec3;
  /** Point on B's surface. */
  pb: Vec3;
  /** Unit normal pointing from A to B. */
  n: Vec3;
  /** Signed separation along n (negative = penetration). */
  s: number;
}

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Unit Newell normal of the polygon in flat[0 … 3·count) into `out` (zero when degenerate). */
function newell(flat: ArrayLike<number>, count: number, out: Float64Array): void {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let k = 0; k < count; k++) {
    const a = k * 3;
    const b = ((k + 1) % count) * 3;
    nx += (flat[a + 1] - flat[b + 1]) * (flat[a + 2] + flat[b + 2]);
    ny += (flat[a + 2] - flat[b + 2]) * (flat[a] + flat[b]);
    nz += (flat[a] - flat[b]) * (flat[a + 1] + flat[b + 1]);
  }
  const l = len3(nx, ny, nz);
  if (l > 1e-300) {
    out[0] = nx / l;
    out[1] = ny / l;
    out[2] = nz / l;
  } else out[0] = out[1] = out[2] = 0;
}

// Scratch for clipping: the incident feature lives in clipSrc, clipFlat writes to clipDst and
// swaps the two (the narrow phase is not re-entrant).
let clipSrc = new Float64Array(96);
let clipDst = new Float64Array(96);
const nTmp = new Float64Array(3);

function ensureClipCapacity(points: number): void {
  if (clipSrc.length >= points * 3 && clipDst.length >= points * 3) return;
  const grow = (a: Float64Array) => {
    const b = new Float64Array(Math.max(points * 3, a.length * 2));
    b.set(a);
    return b;
  };
  clipSrc = grow(clipSrc);
  clipDst = grow(clipDst);
}

/**
 * Keeps the part of the polygon (closed, ≥ 3 points) or polyline (≤ 2 points) in clipSrc with
 * m · p ≤ offset (Sutherland-Hodgman). Returns the new point count; the result is in clipSrc.
 */
function clipFlat(count: number, mx: number, my: number, mz: number, offset: number): number {
  if (count === 0) return 0;
  ensureClipCapacity(count + 1);
  const src = clipSrc;
  const dst = clipDst;
  let n = 0;
  const push = (x: number, y: number, z: number) => {
    dst[n * 3] = x;
    dst[n * 3 + 1] = y;
    dst[n * 3 + 2] = z;
    n++;
  };
  if (count === 1) {
    if (mx * src[0] + my * src[1] + mz * src[2] - offset <= 0) return 1;
    return 0;
  }
  if (count === 2) {
    const da = mx * src[0] + my * src[1] + mz * src[2] - offset;
    const db = mx * src[3] + my * src[4] + mz * src[5] - offset;
    if (da <= 0 && db <= 0) return 2;
    if (da > 0 && db > 0) return 0;
    const t = da / (da - db);
    const qx = src[0] + (src[3] - src[0]) * t;
    const qy = src[1] + (src[4] - src[1]) * t;
    const qz = src[2] + (src[5] - src[2]) * t;
    if (da <= 0) {
      push(src[0], src[1], src[2]);
      push(qx, qy, qz);
    } else {
      push(qx, qy, qz);
      push(src[3], src[4], src[5]);
    }
  } else
    for (let i = 0; i < count; i++) {
      const a = i * 3;
      const b = ((i + 1) % count) * 3;
      const da = mx * src[a] + my * src[a + 1] + mz * src[a + 2] - offset;
      const db = mx * src[b] + my * src[b + 1] + mz * src[b + 2] - offset;
      if (da <= 0) push(src[a], src[a + 1], src[a + 2]);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        push(
          src[a] + (src[b] - src[a]) * t,
          src[a + 1] + (src[b + 1] - src[a + 1]) * t,
          src[a + 2] + (src[b + 2] - src[a + 2]) * t,
        );
      }
    }
  clipSrc = dst;
  clipDst = src;
  return n;
}

/**
 * Contact points between the supporting features of two shapes (flat xyz polygons, segments or
 * points in a common frame) for a contact normal n (A → B). The feature with the higher
 * dimension, or the face better aligned with n, is the reference; the other one is clipped
 * against it and projected onto it along n. Points separated by more than `maxSep` are dropped.
 * Returns the number of contacts appended (0 when the features do not form a usable manifold).
 */
export function clipFeatures(
  faceA: ArrayLike<number>,
  faceB: ArrayLike<number>,
  n: Readonly<Vec3>,
  maxSep: number,
  out: ContactCandidate[],
): number {
  const cA = Math.floor(faceA.length / 3);
  const cB = Math.floor(faceB.length / 3);
  const dimA = cA >= 3 ? 2 : cA - 1;
  const dimB = cB >= 3 ? 2 : cB - 1;
  if (dimA < 0 || dimB < 0 || (dimA === 0 && dimB === 0)) return 0;
  const nx = n[0];
  const ny = n[1];
  const nz = n[2];
  let nAx = 0;
  let nAy = 0;
  let nAz = 0;
  let nBx = 0;
  let nBy = 0;
  let nBz = 0;
  if (dimA === 2) {
    newell(faceA, cA, nTmp);
    const s = nTmp[0] * nx + nTmp[1] * ny + nTmp[2] * nz < 0 ? -1 : 1;
    nAx = nTmp[0] * s;
    nAy = nTmp[1] * s;
    nAz = nTmp[2] * s;
  }
  if (dimB === 2) {
    newell(faceB, cB, nTmp);
    const s = nTmp[0] * nx + nTmp[1] * ny + nTmp[2] * nz > 0 ? -1 : 1;
    nBx = nTmp[0] * s;
    nBy = nTmp[1] * s;
    nBz = nTmp[2] * s;
  }
  let refIsA: boolean;
  if (dimA !== dimB) refIsA = dimA > dimB;
  else if (dimA === 2)
    refIsA = Math.abs(nAx * nx + nAy * ny + nAz * nz) >= Math.abs(nBx * nx + nBy * ny + nBz * nz) - 1e-3;
  else refIsA = true;
  const ux = refIsA ? nx : -nx;
  const uy = refIsA ? ny : -ny;
  const uz = refIsA ? nz : -nz;
  const ref = refIsA ? faceA : faceB;
  const refCount = refIsA ? cA : cB;
  const inc = refIsA ? faceB : faceA;
  let incCount = refIsA ? cB : cA;
  ensureClipCapacity(incCount + refCount + 1);
  for (let i = 0; i < incCount * 3; i++) clipSrc[i] = inc[i];
  const r0x = ref[0];
  const r0y = ref[1];
  const r0z = ref[2];
  let nRx: number;
  let nRy: number;
  let nRz: number;
  if (refCount >= 3) {
    // both face normals were oriented along u (A's along n, B's against it)
    nRx = refIsA ? nAx : nBx;
    nRy = refIsA ? nAy : nBy;
    nRz = refIsA ? nAz : nBz;
    // faces far from the contact normal (edge/vertex contacts) do not give a face manifold
    if (nRx * ux + nRy * uy + nRz * uz < 0.7) return 0;
    // orientation of the reference loop around u
    newell(ref, refCount, nTmp);
    const sign = nTmp[0] * ux + nTmp[1] * uy + nTmp[2] * uz >= 0 ? 1 : -1;
    for (let k = 0; k < refCount && incCount; k++) {
      const a = k * 3;
      const b = ((k + 1) % refCount) * 3;
      const ex = ref[b] - ref[a];
      const ey = ref[b + 1] - ref[a + 1];
      const ez = ref[b + 2] - ref[a + 2];
      let mx = ey * uz - ez * uy;
      let my = ez * ux - ex * uz;
      let mz = ex * uy - ey * ux;
      const ml = len3(mx, my, mz);
      if (!(ml > 1e-12)) continue;
      mx = (mx / ml) * sign;
      my = (my / ml) * sign;
      mz = (mz / ml) * sign;
      incCount = clipFlat(incCount, mx, my, mz, mx * ref[a] + my * ref[a + 1] + mz * ref[a + 2]);
    }
  } else if (refCount === 2) {
    const ex = ref[3] - r0x;
    const ey = ref[4] - r0y;
    const ez = ref[5] - r0z;
    const el = len3(ex, ey, ez);
    if (!(el > 1e-12)) return 0;
    if (incCount === 2) {
      // crossing segments touch in a single point: only (nearly) parallel ones form a manifold
      const fx = clipSrc[3] - clipSrc[0];
      const fy = clipSrc[4] - clipSrc[1];
      const fz = clipSrc[5] - clipSrc[2];
      const fl = len3(fx, fy, fz);
      if (!(fl > 1e-12) || Math.abs(ex * fx + ey * fy + ez * fz) < 0.98 * el * fl) return 0;
    }
    const eu = ex * ux + ey * uy + ez * uz;
    const px = ex - eu * ux;
    const py = ey - eu * uy;
    const pz = ez - eu * uz;
    const pl = len3(px, py, pz);
    if (!(pl > 1e-12)) return 0;
    const mx = px / pl;
    const my = py / pl;
    const mz = pz / pl;
    incCount = clipFlat(incCount, -mx, -my, -mz, -(mx * r0x + my * r0y + mz * r0z));
    incCount = clipFlat(incCount, mx, my, mz, mx * ref[3] + my * ref[4] + mz * ref[5]);
    // plane containing the segment, as perpendicular to u as possible
    const k = (ux * ex + uy * ey + uz * ez) / el;
    nRx = ux - (k * ex) / el;
    nRy = uy - (k * ey) / el;
    nRz = uz - (k * ez) / el;
    const nl = len3(nRx, nRy, nRz);
    if (!(nl > 1e-9)) return 0;
    nRx /= nl;
    nRy /= nl;
    nRz /= nl;
  } else return 0;
  const denom = ux * nRx + uy * nRy + uz * nRz;
  if (!(denom > 1e-6)) return 0;
  let added = 0;
  for (let i = 0; i < incCount; i++) {
    const px = clipSrc[i * 3];
    const py = clipSrc[i * 3 + 1];
    const pz = clipSrc[i * 3 + 2];
    const t = ((px - r0x) * nRx + (py - r0y) * nRy + (pz - r0z) * nRz) / denom;
    if (!(t <= maxSep)) continue;
    const onRef: Vec3 = [px - t * ux, py - t * uy, pz - t * uz];
    out.push({
      pa: refIsA ? onRef : [px, py, pz],
      pb: refIsA ? [px, py, pz] : onRef,
      n: [nx, ny, nz],
      s: t,
    });
    added++;
  }
  return added;
}

/**
 * Reduces contacts sharing (approximately) one normal to at most four: the deepest point, the
 * point furthest from it, the one spanning the largest triangle with both and the one furthest
 * outside that triangle.
 */
export function reduceManifold(c: ContactCandidate[], max = 4): ContactCandidate[] {
  if (c.length <= max) return c;
  const n = c[0].n;
  let i0 = 0;
  for (let i = 1; i < c.length; i++) if (c[i].s < c[i0].s) i0 = i;
  const P = (i: number) => c[i].pa;
  let i1 = -1;
  let best = -1;
  for (let i = 0; i < c.length; i++) {
    const d = sub(P(i), P(i0));
    const tangential = dot(d, d) - dot(d, n) ** 2;
    if (i !== i0 && tangential > best) {
      best = tangential;
      i1 = i;
    }
  }
  if (i1 < 0) return [c[i0]];
  const area = (a: number, b: number, q: number) => dot(cross(sub(P(b), P(a)), sub(P(q), P(a))), n);
  let i2 = -1;
  best = 0;
  for (let i = 0; i < c.length; i++) {
    if (i === i0 || i === i1) continue;
    const ar = Math.abs(area(i0, i1, i));
    if (ar > best) {
      best = ar;
      i2 = i;
    }
  }
  if (i2 < 0) return [c[i0], c[i1]];
  if (max < 4) return [c[i0], c[i1], c[i2]];
  // orient the triangle counter-clockwise around n
  const a = i0;
  let b = i1;
  let d = i2;
  if (area(a, b, d) < 0) [b, d] = [d, b];
  let i3 = -1;
  best = 0;
  for (let i = 0; i < c.length; i++) {
    if (i === i0 || i === i1 || i === i2) continue;
    const outside = -Math.min(area(a, b, i), area(b, d, i), area(d, a, i));
    if (outside > best) {
      best = outside;
      i3 = i;
    }
  }
  return i3 < 0 ? [c[i0], c[i1], c[i2]] : [c[i0], c[i1], c[i2], c[i3]];
}

/**
 * Merges contacts from several features (e.g. the triangles of a mesh): contacts are grouped by
 * normal, each group is reduced to four points and near-duplicate points (shared vertices of
 * neighbouring triangles) are dropped. At most `maxGroups` groups (deepest first) are kept.
 * Linear in the number of contacts.
 */
export function mergeContacts(list: ContactCandidate[], maxGroups = 3): ContactCandidate[] {
  if (list.length <= 1) return list;
  const sorted = [...list].sort((p, q) => p.s - q.s);
  const groups: ContactCandidate[][] = [];
  for (const c of sorted) {
    let g: ContactCandidate[] | undefined;
    for (const gr of groups)
      if (dot(gr[0].n, c.n) > 0.995) {
        g = gr;
        break;
      }
    if (g) g.push(c);
    else groups.push([c]);
  }
  const out: ContactCandidate[] = [];
  for (const g of groups.slice(0, maxGroups))
    for (const c of reduceManifold(g)) {
      const dup = out.some(
        (u) =>
          dot(u.n, c.n) > 0.999 &&
          Math.abs(u.pa[0] - c.pa[0]) < 1e-5 &&
          Math.abs(u.pa[1] - c.pa[1]) < 1e-5 &&
          Math.abs(u.pa[2] - c.pa[2]) < 1e-5,
      );
      if (!dup) out.push(c);
    }
  return out;
}
