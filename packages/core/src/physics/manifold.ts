import type { Vec3 } from '../math/types';

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

function points(flat: readonly number[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}

function polygonNormal(p: Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let k = 0; k < p.length; k++) {
    const a = p[k];
    const b = p[(k + 1) % p.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return l > 1e-300 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

/** Keeps the part of a polygon (closed) or polyline (open, ≤ 2 points) with m · p ≤ offset. */
function clip(poly: Vec3[], m: Vec3, offset: number): Vec3[] {
  const n = poly.length;
  if (n === 0) return poly;
  if (n === 1) return dot(m, poly[0]) - offset <= 0 ? poly : [];
  if (n === 2) {
    const [a, b] = poly;
    const da = dot(m, a) - offset;
    const db = dot(m, b) - offset;
    if (da <= 0 && db <= 0) return poly;
    if (da > 0 && db > 0) return [];
    const t = da / (da - db);
    const q: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    return da <= 0 ? [a, q] : [q, b];
  }
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = dot(m, a) - offset;
    const db = dot(m, b) - offset;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/**
 * Contact points between the supporting features of two shapes (flat xyz polygons, segments or
 * points in a common frame) for a contact normal n (A → B). The feature with the higher
 * dimension, or the face better aligned with n, is the reference; the other one is clipped
 * against it and projected onto it along n. Points separated by more than `maxSep` are dropped.
 * Returns the number of contacts appended (0 when the features do not form a usable manifold).
 */
export function clipFeatures(
  faceA: readonly number[],
  faceB: readonly number[],
  n: Readonly<Vec3>,
  maxSep: number,
  out: ContactCandidate[],
): number {
  const A = points(faceA);
  const B = points(faceB);
  const dimA = A.length >= 3 ? 2 : A.length - 1;
  const dimB = B.length >= 3 ? 2 : B.length - 1;
  if (dimA < 0 || dimB < 0 || (dimA === 0 && dimB === 0)) return 0;
  let nA: Vec3 | null = null;
  let nB: Vec3 | null = null;
  if (dimA === 2) {
    nA = polygonNormal(A);
    if (dot(nA, n) < 0) nA = [-nA[0], -nA[1], -nA[2]];
  }
  if (dimB === 2) {
    nB = polygonNormal(B);
    if (dot(nB, n) > 0) nB = [-nB[0], -nB[1], -nB[2]];
  }
  let refIsA: boolean;
  if (dimA !== dimB) refIsA = dimA > dimB;
  else if (dimA === 2) refIsA = Math.abs(dot(nA!, n)) >= Math.abs(dot(nB!, n)) - 1e-3;
  else refIsA = true;
  const u: Vec3 = refIsA ? [n[0], n[1], n[2]] : [-n[0], -n[1], -n[2]];
  const ref = refIsA ? A : B;
  let inc = refIsA ? B : A;
  const r0 = ref[0];
  let nR: Vec3;
  if (ref.length >= 3) {
    // both face normals were oriented along u (A's along n, B's against it)
    nR = (refIsA ? nA : nB)!;
    const align = dot(nR, u);
    // faces far from the contact normal (edge/vertex contacts) do not give a face manifold
    if (align < 0.7) return 0;
    // orientation of the reference loop around u
    const loopN = polygonNormal(ref);
    const sign = dot(loopN, u) >= 0 ? 1 : -1;
    for (let k = 0; k < ref.length && inc.length; k++) {
      const a = ref[k];
      const b = ref[(k + 1) % ref.length];
      const e = sub(b, a);
      let m = cross(e, u);
      const ml = Math.hypot(m[0], m[1], m[2]);
      if (!(ml > 1e-12)) continue;
      m = [(m[0] / ml) * sign, (m[1] / ml) * sign, (m[2] / ml) * sign];
      inc = clip(inc, m, dot(m, a));
    }
  } else if (ref.length === 2) {
    const e = sub(ref[1], r0);
    const el = Math.hypot(e[0], e[1], e[2]);
    if (!(el > 1e-12)) return 0;
    if (inc.length === 2) {
      // crossing segments touch in a single point: only (nearly) parallel ones form a manifold
      const f = sub(inc[1], inc[0]);
      const fl = Math.hypot(f[0], f[1], f[2]);
      if (!(fl > 1e-12) || Math.abs(dot(e, f)) < 0.98 * el * fl) return 0;
    }
    const eu = dot(e, u);
    const ep: Vec3 = [e[0] - eu * u[0], e[1] - eu * u[1], e[2] - eu * u[2]];
    const epl = Math.hypot(ep[0], ep[1], ep[2]);
    if (!(epl > 1e-12)) return 0;
    const m: Vec3 = [ep[0] / epl, ep[1] / epl, ep[2] / epl];
    inc = clip(inc, [-m[0], -m[1], -m[2]], -dot(m, r0));
    inc = clip(inc, m, dot(m, ref[1]));
    // plane containing the segment, as perpendicular to u as possible
    const eh: Vec3 = [e[0] / el, e[1] / el, e[2] / el];
    const k = dot(u, eh);
    nR = [u[0] - k * eh[0], u[1] - k * eh[1], u[2] - k * eh[2]];
    const nl = Math.hypot(nR[0], nR[1], nR[2]);
    if (!(nl > 1e-9)) return 0;
    nR = [nR[0] / nl, nR[1] / nl, nR[2] / nl];
  } else return 0;
  const denom = dot(u, nR);
  if (!(denom > 1e-6)) return 0;
  let added = 0;
  for (const p of inc) {
    const t = dot(sub(p, r0), nR) / denom;
    if (!(t <= maxSep)) continue;
    const onRef: Vec3 = [p[0] - t * u[0], p[1] - t * u[1], p[2] - t * u[2]];
    out.push({
      pa: refIsA ? onRef : [p[0], p[1], p[2]],
      pb: refIsA ? [p[0], p[1], p[2]] : onRef,
      n: [n[0], n[1], n[2]],
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
  let [a, b, d] = [i0, i1, i2];
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
 * Merges contacts from several features (e.g. the triangles of a mesh): near-duplicate points
 * are dropped, contacts are grouped by normal and each group reduced to four points. At most
 * `maxGroups` groups (deepest first) are kept.
 */
export function mergeContacts(list: ContactCandidate[], maxGroups = 3): ContactCandidate[] {
  if (list.length <= 1) return list;
  const sorted = [...list].sort((p, q) => p.s - q.s);
  const unique: ContactCandidate[] = [];
  for (const c of sorted) {
    const dup = unique.some(
      (u) =>
        dot(u.n, c.n) > 0.999 &&
        Math.abs(u.pa[0] - c.pa[0]) < 1e-5 &&
        Math.abs(u.pa[1] - c.pa[1]) < 1e-5 &&
        Math.abs(u.pa[2] - c.pa[2]) < 1e-5,
    );
    if (!dup) unique.push(c);
  }
  const groups: ContactCandidate[][] = [];
  for (const c of unique) {
    const g = groups.find((gr) => dot(gr[0].n, c.n) > 0.995);
    if (g) g.push(c);
    else groups.push([c]);
  }
  const out: ContactCandidate[] = [];
  for (const g of groups.slice(0, maxGroups)) out.push(...reduceManifold(g));
  return out;
}
