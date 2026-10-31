import type { Vec3 } from '../math/types';
import type { Spline } from '../doc/types';
import type { EvaluatedSpline } from './spline';

/*
 * NURBS spline evaluation (Blender's knot conventions):
 *
 * - open, uniform knots ("use_endpoint_u" off): 0, 1, 2, … — the curve does not reach the end points;
 * - open, endpoint knots ("use_endpoint_u" on): `order` repeated knots at both ends — the curve
 *   starts at the first and ends at the last control point;
 * - cyclic: the first `order - 1` control points are repeated after the last one with uniform knots,
 *   giving a closed, periodic curve.
 *
 * Weights make the curve rational (weight 1 everywhere = plain B-spline). Tilt and radius are blended
 * with the same rational basis as the positions.
 */

/** Order actually used for a spline: Blender clamps `order_u` to 2..6 and to the point count. */
export function nurbsOrder(spline: Pick<Spline, 'order_u'>, pointCount: number): number {
  const o = Number.isFinite(spline.order_u) ? Math.round(spline.order_u) : 4;
  return Math.max(2, Math.min(6, o, Math.max(2, pointCount)));
}

/**
 * Knot vector for `count` control points (for cyclic splines the knots cover the `count + order - 1`
 * wrapped control points).
 */
export function nurbsKnots(count: number, order: number, cyclic: boolean, endpoint: boolean): number[] {
  if (cyclic) {
    const len = count + 2 * order - 1;
    return Array.from({ length: len }, (_, i) => i);
  }
  const len = count + order;
  if (!endpoint) return Array.from({ length: len }, (_, i) => i);
  const last = count - order + 1;
  const knots: number[] = [];
  for (let i = 0; i < len; i++) {
    if (i < order) knots.push(0);
    else if (i >= count) knots.push(last);
    else knots.push(i - order + 1);
  }
  return knots;
}

/** Index of the knot span containing `u` (span ∈ [degree, n - 1], half-open except at the end). */
function findSpan(u: number, degree: number, n: number, knots: number[]): number {
  if (u >= knots[n]) {
    // end of the domain: last non-empty span
    let s = n - 1;
    while (s > degree && knots[s] >= knots[s + 1]) s--;
    return s;
  }
  if (u <= knots[degree]) {
    let s = degree;
    while (s < n - 1 && knots[s + 1] <= u) s++;
    return s;
  }
  let lo = degree;
  let hi = n;
  let mid = (lo + hi) >> 1;
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** The `degree + 1` non-zero basis functions N[span-degree .. span] at `u` (Cox–de Boor). */
function basisFunctions(span: number, u: number, degree: number, knots: number[]): number[] {
  const N = new Array<number>(degree + 1).fill(0);
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const temp = den !== 0 ? N[r] / den : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** Basis functions and their first derivatives at `u` for the span `span`. */
function basisWithDerivatives(
  span: number,
  u: number,
  degree: number,
  knots: number[],
): { N: number[]; dN: number[] } {
  const N = basisFunctions(span, u, degree, knots);
  const lower = basisFunctions(span, u, degree - 1, knots); // indices span-degree+1 .. span
  const dN = new Array<number>(degree + 1).fill(0);
  for (let k = 0; k <= degree; k++) {
    const i = span - degree + k;
    const a = k - 1 >= 0 ? lower[k - 1] : 0; // N_{i, degree-1}
    const b = k <= degree - 1 ? lower[k] : 0; // N_{i+1, degree-1}
    const d1 = knots[i + degree] - knots[i];
    const d2 = knots[i + degree + 1] - knots[i + 1];
    dN[k] = (d1 > 0 ? (degree * a) / d1 : 0) - (d2 > 0 ? (degree * b) / d2 : 0);
  }
  return { N, dN };
}

/**
 * Samples a NURBS spline: `resolution` samples per control-point segment (`resolution × (n − 1) + 1`
 * points for open splines, `resolution × n` for cyclic ones). Also returns analytic unit tangents.
 * Splines with fewer than two points are returned as their control points.
 */
export function evaluateNurbs(spline: Spline, resolution: number): EvaluatedSpline {
  const pts = spline.points;
  const n = pts.length;
  const cyclic = spline.use_cyclic_u && n > 2;
  const out: EvaluatedSpline = {
    points: [],
    tilts: [],
    radii: [],
    cyclic,
    materialIndex: spline.material_index,
    smooth: spline.use_smooth,
    tangents: [],
  };
  if (n < 2) {
    for (const p of pts) {
      out.points.push([p.co[0], p.co[1], p.co[2]]);
      out.tilts.push(p.tilt);
      out.radii.push(p.radius);
    }
    out.tangents = undefined;
    return out;
  }
  const order = nurbsOrder(spline, n);
  const degree = order - 1;
  // control points (wrapped for cyclic splines)
  const ctrl = cyclic ? n + order - 1 : n;
  const at = (i: number) => pts[i % n];
  const knots = nurbsKnots(n, order, cyclic, !!spline.use_endpoint_u);
  const u0 = knots[degree];
  const u1 = knots[ctrl];
  const res = Math.max(1, Math.round(resolution));
  const count = cyclic ? res * n : res * (n - 1) + 1;
  const step = cyclic ? (u1 - u0) / count : (u1 - u0) / (count - 1);
  for (let s = 0; s < count; s++) {
    const u = s === count - 1 && !cyclic ? u1 : u0 + step * s;
    const span = findSpan(u, degree, ctrl, knots);
    const { N, dN } = basisWithDerivatives(span, u, degree, knots);
    let w = 0;
    let dw = 0;
    const A: Vec3 = [0, 0, 0];
    const dA: Vec3 = [0, 0, 0];
    let tilt = 0;
    let radius = 0;
    for (let k = 0; k <= degree; k++) {
      const p = at(span - degree + k);
      const wk = p.weight;
      const b = N[k] * wk;
      const db = dN[k] * wk;
      w += b;
      dw += db;
      for (let c = 0; c < 3; c++) {
        A[c] += b * p.co[c];
        dA[c] += db * p.co[c];
      }
      tilt += b * p.tilt;
      radius += b * p.radius;
    }
    const iw = w !== 0 ? 1 / w : 0;
    const C: Vec3 = [A[0] * iw, A[1] * iw, A[2] * iw];
    // C' = (A' − w'·C) / w
    const d: Vec3 = [(dA[0] - dw * C[0]) * iw, (dA[1] - dw * C[1]) * iw, (dA[2] - dw * C[2]) * iw];
    const len = Math.hypot(d[0], d[1], d[2]);
    out.points.push(C);
    out.tilts.push(tilt * iw);
    out.radii.push(radius * iw);
    out.tangents!.push(len > 1e-12 ? [d[0] / len, d[1] / len, d[2] / len] : [0, 0, 0]);
  }
  return out;
}
