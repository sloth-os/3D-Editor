import type { Vec3 } from '../math/types';
import { len3, perpendicular } from './vmath';

/*
 * GJK (distance between convex sets) and EPA (penetration depth of overlapping convex sets),
 * working on support functions in a common frame. GJK uses the closest-point sub-algorithms of
 * Ericson's "Real-Time Collision Detection"; EPA expands a polytope of the Minkowski difference
 * A − B until its face closest to the origin is on the boundary.
 */

/** Writes the support point of a convex set in direction (dx, dy, dz) into `out`. */
export type SupportFn = (dx: number, dy: number, dz: number, out: Float64Array) => void;

export interface SimplexVertex {
  /** Point of the Minkowski difference (a − b). */
  w: Vec3;
  a: Vec3;
  b: Vec3;
}

export interface GjkResult {
  /** True when the sets overlap or touch (distance below tolerance). */
  overlap: boolean;
  /** Distance between the sets (0 when overlapping). */
  distance: number;
  /** Closest points on A and B (meaningful when not overlapping). */
  pa: Vec3;
  pb: Vec3;
  /** Final simplex, used to seed EPA. */
  simplex: SimplexVertex[];
}

export interface EpaResult {
  /** Unit penetration normal pointing from A to B (move B along it to separate). */
  normal: Vec3;
  /** Penetration depth (≥ 0). */
  depth: number;
  /** Deepest points on A and B (pa − pb = depth · normal). */
  pa: Vec3;
  pb: Vec3;
}

const tmpA = new Float64Array(3);
const tmpB = new Float64Array(3);

function supportVertex(supA: SupportFn, supB: SupportFn, dx: number, dy: number, dz: number): SimplexVertex {
  supA(dx, dy, dz, tmpA);
  supB(-dx, -dy, -dz, tmpB);
  const a: Vec3 = [tmpA[0], tmpA[1], tmpA[2]];
  const b: Vec3 = [tmpB[0], tmpB[1], tmpB[2]];
  return { w: [a[0] - b[0], a[1] - b[1], a[2] - b[2]], a, b };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

interface Closest {
  v: Vec3;
  /** Indices into the input simplex and their barycentric weights. */
  idx: number[];
  lambda: number[];
}

function closestSegment(s: SimplexVertex[], i: number, j: number): Closest {
  const a = s[i].w;
  const ab = sub(s[j].w, a);
  const len2 = dot(ab, ab);
  const t = len2 > 0 ? -dot(a, ab) / len2 : 0;
  if (t <= 0) return { v: [...a], idx: [i], lambda: [1] };
  if (t >= 1) return { v: [...s[j].w], idx: [j], lambda: [1] };
  return { v: [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], idx: [i, j], lambda: [1 - t, t] };
}

function closestTriangle(s: SimplexVertex[], i: number, j: number, k: number): Closest {
  const a = s[i].w;
  const b = s[j].w;
  const c = s[k].w;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const d1 = -dot(ab, a);
  const d2 = -dot(ac, a);
  if (d1 <= 0 && d2 <= 0) return { v: [...a], idx: [i], lambda: [1] };
  const d3 = -dot(ab, b);
  const d4 = -dot(ac, b);
  if (d3 >= 0 && d4 <= d3) return { v: [...b], idx: [j], lambda: [1] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return { v: [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], idx: [i, j], lambda: [1 - t, t] };
  }
  const d5 = -dot(ab, c);
  const d6 = -dot(ac, c);
  if (d6 >= 0 && d5 <= d6) return { v: [...c], idx: [k], lambda: [1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return { v: [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t], idx: [i, k], lambda: [1 - t, t] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bc = sub(c, b);
    return { v: [b[0] + bc[0] * t, b[1] + bc[1] * t, b[2] + bc[2] * t], idx: [j, k], lambda: [1 - t, t] };
  }
  const denom = va + vb + vc;
  if (!(Math.abs(denom) > 1e-300)) {
    // degenerate triangle: best of its edges
    let best = closestSegment(s, i, j);
    for (const cand of [closestSegment(s, j, k), closestSegment(s, i, k)])
      if (dot(cand.v, cand.v) < dot(best.v, best.v)) best = cand;
    return best;
  }
  const v = vb / denom;
  const w = vc / denom;
  return {
    v: [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w],
    idx: [i, j, k],
    lambda: [1 - v - w, v, w],
  };
}

/** Faces of a tetrahedron (three vertices) with the vertex opposite to each. */
const TETRA_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3],
  [0, 2, 3, 1],
  [0, 3, 1, 2],
  [1, 3, 2, 0],
];

/**
 * Tolerance of the flatness test below: about the height, relative to the coordinates, under
 * which a tetrahedron counts as flat. Rounding noise of the volume is ~10⁵ times smaller.
 */
const FLAT_TETRA = 1e-10;

/**
 * Whether a tetrahedron is flat: 6·volume ≤ FLAT_TETRA · coordinate scale · longest edge² (the
 * square bounds twice any face area, so this is a height of ~FLAT_TETRA · scale or less).
 */
function flatTetra(s: SimplexVertex[]): boolean {
  let scale = 0;
  let maxEdge2 = 0;
  for (let i = 0; i < 4; i++) {
    const p = s[i].w;
    scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    for (let j = i + 1; j < 4; j++) {
      const q = s[j].w;
      maxEdge2 = Math.max(maxEdge2, (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2);
    }
  }
  const vol6 = dot(sub(s[1].w, s[0].w), cross(sub(s[2].w, s[0].w), sub(s[3].w, s[0].w)));
  return !(Math.abs(vol6) > FLAT_TETRA * scale * maxEdge2);
}

/** Closest point of a tetrahedron to the origin; null when the origin is inside. */
function closestTetra(s: SimplexVertex[]): Closest | null {
  // A flat tetrahedron (GJK collects one near a face of A − B, e.g. on a hull face or a mesh
  // triangle) has no inside: the side tests below would compare rounding noise and could
  // report an overlap of separated shapes. Its closest point is that of its best face.
  const flat = flatTetra(s);
  let best: Closest | null = null;
  let bestD = Infinity;
  let anyOutside = false;
  for (const [i, j, k, l] of TETRA_FACES) {
    if (!flat) {
      const a = s[i].w;
      const n = cross(sub(s[j].w, a), sub(s[k].w, a));
      const sp = -dot(a, n);
      const sd = dot(sub(s[l].w, a), n);
      // origin and the fourth vertex on opposite sides
      if (!(sp * sd < 0)) continue;
    }
    anyOutside = true;
    const c = closestTriangle(s, i, j, k);
    const d = dot(c.v, c.v);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return anyOutside ? best : null;
}

/**
 * Distance between two convex sets. `dir` is an initial search direction (e.g. from A's centre
 * towards B's centre).
 */
export function gjk(supA: SupportFn, supB: SupportFn, dir: Readonly<Vec3>): GjkResult {
  let d: Vec3 = len3(dir[0], dir[1], dir[2]) > 1e-12 ? [-dir[0], -dir[1], -dir[2]] : [1, 0, 0];
  let simplex: SimplexVertex[] = [supportVertex(supA, supB, d[0], d[1], d[2])];
  let lambda = [1];
  let v: Vec3 = [...simplex[0].w];
  let maxW2 = dot(v, v);
  for (let iter = 0; iter < 64; iter++) {
    const vv = dot(v, v);
    if (vv <= 1e-20 * Math.max(1, maxW2)) return finish(simplex, lambda, true);
    d = [-v[0], -v[1], -v[2]];
    const sv = supportVertex(supA, supB, d[0], d[1], d[2]);
    maxW2 = Math.max(maxW2, dot(sv.w, sv.w));
    // no significant progress towards the origin: v is the closest point
    if (vv - dot(v, sv.w) <= 1e-12 * vv + 1e-24) break;
    if (simplex.some((p) => p.w[0] === sv.w[0] && p.w[1] === sv.w[1] && p.w[2] === sv.w[2])) break;
    simplex.push(sv);
    let c: Closest | null;
    if (simplex.length === 2) c = closestSegment(simplex, 0, 1);
    else if (simplex.length === 3) c = closestTriangle(simplex, 0, 1, 2);
    else {
      c = closestTetra(simplex);
      if (!c) return finish(simplex, [0.25, 0.25, 0.25, 0.25], true);
    }
    const next = dot(c.v, c.v);
    simplex = c.idx.map((i) => simplex[i]);
    lambda = c.lambda;
    if (next >= vv) {
      v = c.v;
      break;
    }
    v = c.v;
  }
  const vv = dot(v, v);
  return finish(simplex, lambda, vv <= 1e-20 * Math.max(1, maxW2));
}

function finish(simplex: SimplexVertex[], lambda: number[], overlap: boolean): GjkResult {
  const pa: Vec3 = [0, 0, 0];
  const pb: Vec3 = [0, 0, 0];
  simplex.forEach((s, i) => {
    const l = lambda[i] ?? 0;
    for (let k = 0; k < 3; k++) {
      pa[k] += s.a[k] * l;
      pb[k] += s.b[k] * l;
    }
  });
  const distance = overlap ? 0 : len3(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
  return { overlap, distance, pa, pb, simplex };
}

interface EpaFace {
  i: number;
  j: number;
  k: number;
  n: Vec3;
  d: number;
  alive: boolean;
}

/**
 * Penetration of two overlapping convex sets, seeded with GJK's final simplex. Returns null when
 * the Minkowski difference is degenerate (flat sets touching edge-on).
 */
export function epa(supA: SupportFn, supB: SupportFn, seed: SimplexVertex[]): EpaResult | null {
  const verts = seed.slice(0, 4);
  if (!blowUp(supA, supB, verts)) return null;
  const centroid: Vec3 = [0, 0, 0];
  for (const p of verts) for (let k = 0; k < 3; k++) centroid[k] += p.w[k] / 4;
  const faces: EpaFace[] = [];
  const makeFace = (i: number, j: number, k: number): EpaFace | null => {
    const a = verts[i].w;
    const n = cross(sub(verts[j].w, a), sub(verts[k].w, a));
    const l = len3(n[0], n[1], n[2]);
    if (!(l > 1e-300)) return null;
    n[0] /= l;
    n[1] /= l;
    n[2] /= l;
    return { i, j, k, n, d: dot(n, a), alive: true };
  };
  for (const [i, j, k] of [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ]) {
    let f = makeFace(i, j, k);
    if (f && dot(f.n, sub(centroid, verts[i].w)) > 0) f = makeFace(i, k, j);
    if (!f) return null;
    faces.push(f);
  }
  let best = faces[0];
  for (let iter = 0; iter < 96; iter++) {
    best = faces[0];
    let bestD = Infinity;
    for (const f of faces)
      if (f.alive && f.d < bestD) {
        bestD = f.d;
        best = f;
      }
    const sv = supportVertex(supA, supB, best.n[0], best.n[1], best.n[2]);
    const dist = dot(sv.w, best.n);
    if (dist - best.d <= 1e-9 + 1e-7 * Math.abs(best.d)) break;
    const idx = verts.length;
    verts.push(sv);
    // remove faces visible from the new point; the boundary of the removed region is the horizon
    const horizon: [number, number][] = [];
    const toggle = (a: number, b: number) => {
      const h = horizon.findIndex(([x, y]) => x === b && y === a);
      if (h >= 0) horizon.splice(h, 1);
      else horizon.push([a, b]);
    };
    for (const f of faces) {
      if (!f.alive) continue;
      if (dot(f.n, sv.w) - f.d > 1e-12) {
        f.alive = false;
        toggle(f.i, f.j);
        toggle(f.j, f.k);
        toggle(f.k, f.i);
      }
    }
    if (horizon.length < 3) break;
    let ok = true;
    for (const [a, b] of horizon) {
      const f = makeFace(a, b, idx);
      if (!f) {
        ok = false;
        continue;
      }
      faces.push(f);
    }
    if (!ok || faces.length > 512) break;
  }
  const a = verts[best.i];
  const b = verts[best.j];
  const c = verts[best.k];
  const p: Vec3 = [best.n[0] * best.d, best.n[1] * best.d, best.n[2] * best.d];
  const [u, v, w] = barycentric(p, a.w, b.w, c.w);
  const pa: Vec3 = [0, 1, 2].map((k) => a.a[k] * u + b.a[k] * v + c.a[k] * w) as Vec3;
  const pb: Vec3 = [0, 1, 2].map((k) => a.b[k] * u + b.b[k] * v + c.b[k] * w) as Vec3;
  if (![...pa, ...pb, ...best.n, best.d].every(Number.isFinite)) return null;
  return { normal: best.n, depth: Math.max(0, best.d), pa, pb };
}

/** Grows a simplex to a non-degenerate tetrahedron; false when the Minkowski difference is flat. */
function blowUp(supA: SupportFn, supB: SupportFn, verts: SimplexVertex[]): boolean {
  const eps = 1e-10;
  const scaleOf = () => Math.max(1e-9, ...verts.map((p) => len3(p.w[0], p.w[1], p.w[2])));
  // a degenerate seed shrinks to its non-degenerate part, which is grown again below: a flat
  // tetrahedron keeps its largest face, a collinear triangle its longest edge
  if (verts.length === 4 && flatTetra(verts)) {
    let drop = 0;
    let bestArea = -1;
    for (const [i, j, k, l] of TETRA_FACES) {
      const n = cross(sub(verts[j].w, verts[i].w), sub(verts[k].w, verts[i].w));
      const area = len3(n[0], n[1], n[2]);
      if (area > bestArea) {
        bestArea = area;
        drop = l;
      }
    }
    verts.splice(drop, 1);
  }
  if (verts.length === 3) {
    let longest = 0;
    let maxLen = -1;
    for (let e = 0; e < 3; e++) {
      const d = sub(verts[(e + 1) % 3].w, verts[e].w);
      const l = len3(d[0], d[1], d[2]);
      if (l > maxLen) {
        maxLen = l;
        longest = e;
      }
    }
    const n = cross(sub(verts[1].w, verts[0].w), sub(verts[2].w, verts[0].w));
    if (!(len3(n[0], n[1], n[2]) > eps * scaleOf() * maxLen)) verts.splice((longest + 2) % 3, 1);
  }
  if (verts.length === 2) {
    const d = sub(verts[1].w, verts[0].w);
    if (!(len3(d[0], d[1], d[2]) > eps * scaleOf())) verts.pop();
  }
  if (verts.length === 0) verts.push(supportVertex(supA, supB, 1, 0, 0));
  if (verts.length === 1) {
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      const sv = supportVertex(supA, supB, d[0], d[1], d[2]);
      if (Math.hypot(...sub(sv.w, verts[0].w)) > eps * scaleOf()) {
        verts.push(sv);
        break;
      }
    }
    if (verts.length < 2) return false;
  }
  if (verts.length === 2) {
    const axis = sub(verts[1].w, verts[0].w);
    const al = Math.hypot(...axis);
    const u: Vec3 = [axis[0] / al, axis[1] / al, axis[2] / al];
    const p = perpendicular(u[0], u[1], u[2]);
    const q = cross(u, p);
    for (let k = 0; k < 6 && verts.length < 3; k++) {
      const ang = (k * Math.PI) / 3;
      const d: Vec3 = [0, 1, 2].map((m) => p[m] * Math.cos(ang) + q[m] * Math.sin(ang)) as Vec3;
      const sv = supportVertex(supA, supB, d[0], d[1], d[2]);
      const off = sub(sv.w, verts[0].w);
      if (Math.hypot(...cross(off, u)) > eps * scaleOf()) verts.push(sv);
    }
    if (verts.length < 3) return false;
  }
  if (verts.length === 3) {
    const n = cross(sub(verts[1].w, verts[0].w), sub(verts[2].w, verts[0].w));
    const nl = Math.hypot(...n);
    if (!(nl > 0)) return false;
    for (const s of [1, -1]) {
      const sv = supportVertex(supA, supB, n[0] * s, n[1] * s, n[2] * s);
      if (Math.abs(dot(sub(sv.w, verts[0].w), n)) / nl > eps * scaleOf()) {
        verts.push(sv);
        break;
      }
    }
    if (verts.length < 4) return false;
  }
  // non-degenerate volume
  const vol = dot(
    sub(verts[1].w, verts[0].w),
    cross(sub(verts[2].w, verts[0].w), sub(verts[3].w, verts[0].w)),
  );
  const s = scaleOf();
  return Math.abs(vol) > 1e-14 * s * s * s;
}

/** Barycentric coordinates of p (assumed in the triangle's plane) in triangle a, b, c. */
export function barycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): [number, number, number] {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  if (!(Math.abs(den) > 1e-300)) return [1, 0, 0];
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}
