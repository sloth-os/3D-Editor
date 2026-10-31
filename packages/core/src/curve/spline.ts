import type { Vec3 } from '../math/types';
import type { CurveData, HandleType, Spline, SplinePoint, SplineType } from '../doc/types';
import { evaluateNurbs } from './nurbs';

/** A spline sampled into a polyline (curve object space). */
export interface EvaluatedSpline {
  points: Vec3[];
  tilts: number[];
  radii: number[];
  cyclic: boolean;
  materialIndex: number;
  smooth: boolean;
  /**
   * Unit tangents at the sampled points (analytic for BEZIER and NURBS splines; absent for POLY
   * splines, whose direction is the polyline itself). Zero vectors mark undefined tangents.
   */
  tangents?: Vec3[];
}

const SPLINE_TYPES: readonly SplineType[] = ['POLY', 'BEZIER', 'NURBS'];
const HANDLE_TYPES: readonly HandleType[] = ['AUTO', 'VECTOR', 'ALIGNED', 'FREE'];

/** Upper bound of sampled points per spline (keeps absurd resolutions from exhausting memory). */
const MAX_SAMPLES_PER_SPLINE = 250_000;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function vec(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  return [num(v[0], 0), num(v[1], 0), num(v[2], 0)];
}

/** A well-formed copy of a spline point (missing or non-finite values replaced by defaults). */
export function sanitizeSplinePoint(p: Partial<SplinePoint> | null | undefined): SplinePoint {
  const src = (p ?? {}) as Partial<SplinePoint>;
  const ht = (t: unknown): HandleType =>
    HANDLE_TYPES.includes(t as HandleType) ? (t as HandleType) : 'AUTO';
  return {
    co: vec(src.co) ?? [0, 0, 0],
    handle_left: vec(src.handle_left),
    handle_right: vec(src.handle_right),
    handle_left_type: ht(src.handle_left_type),
    handle_right_type: ht(src.handle_right_type),
    radius: Math.max(0, num(src.radius, 1)),
    tilt: num(src.tilt, 0),
    weight: Math.min(1e6, Math.max(1e-6, num(src.weight, 1))),
  };
}

/**
 * A well-formed copy of a spline: unknown types become POLY, points are sanitized, order is
 * clamped to Blender's 2..6, resolution to 0..1024 (0 = use the curve's).
 */
export function sanitizeSpline(s: Partial<Spline> | null | undefined): Spline {
  const src = (s ?? {}) as Partial<Spline>;
  const points = Array.isArray(src.points)
    ? src.points.filter((p) => p && typeof p === 'object').map((p) => sanitizeSplinePoint(p))
    : [];
  return {
    type: SPLINE_TYPES.includes(src.type as SplineType) ? (src.type as SplineType) : 'POLY',
    points,
    use_cyclic_u: !!src.use_cyclic_u,
    resolution_u: Math.max(0, Math.min(1024, Math.round(num(src.resolution_u, 0)))),
    order_u: Math.max(2, Math.min(6, Math.round(num(src.order_u, 4)))),
    use_endpoint_u: src.use_endpoint_u === undefined ? true : !!src.use_endpoint_u,
    use_smooth: src.use_smooth === undefined ? true : !!src.use_smooth,
    material_index: Math.max(0, Math.round(num(src.material_index, 0))),
  };
}

/** Samples per segment used for a spline (spline override, else the curve's resolution). */
export function splineResolution(curve: CurveData, spline: Spline, forRender = false): number {
  const base = forRender && curve.render_resolution_u > 0 ? curve.render_resolution_u : curve.resolution_u;
  const r = spline.resolution_u > 0 ? spline.resolution_u : base;
  return Math.max(1, Math.min(1024, Math.round(Number.isFinite(r) ? r : 12)));
}

/** Whether a spline forms a closed loop when evaluated (Blender needs ≥ 2 Bezier / ≥ 3 other points). */
export function isSplineCyclic(spline: Pick<Spline, 'type' | 'points' | 'use_cyclic_u'>): boolean {
  const n = spline.points.length;
  return !!spline.use_cyclic_u && (spline.type === 'BEZIER' ? n > 1 : n > 2);
}

/** Ratio between a neighbour distance and the AUTO handle length (Blender's 2.5614). */
const AUTO_HANDLE_DIV = 2.5614;

/**
 * Resolved Bezier handles of every point, following Blender's handle rules:
 * - AUTO: smooth handles along the sum of the unit directions to the neighbours, each about 0.39×
 *   the distance to its neighbour (the length ratio between the two sides is limited to 5);
 * - VECTOR: a third of the way towards the neighbour (a corner);
 * - FREE / ALIGNED: the stored positions (AUTO when missing); ALIGNED handles are kept collinear
 *   through the point (the right handle's direction wins, each keeps its length).
 * End points of open splines use a mirrored virtual neighbour, as Blender does.
 */
export function bezierHandles(spline: Spline): { left: Vec3; right: Vec3 }[] {
  const pts = spline.points;
  const n = pts.length;
  const cyclic = isSplineCyclic({ ...spline, type: 'BEZIER' });
  return pts.map((p, i) => {
    const c = p.co;
    const prev = i > 0 ? pts[i - 1].co : cyclic ? pts[n - 1].co : null;
    const next = i < n - 1 ? pts[i + 1].co : cyclic ? pts[0].co : null;
    if (!prev && !next) return { left: [c[0], c[1], c[2]] as Vec3, right: [c[0], c[1], c[2]] as Vec3 };
    const p1: Vec3 = prev
      ? [prev[0], prev[1], prev[2]]
      : [2 * c[0] - next![0], 2 * c[1] - next![1], 2 * c[2] - next![2]];
    const p3: Vec3 = next
      ? [next[0], next[1], next[2]]
      : [2 * c[0] - prev![0], 2 * c[1] - prev![1], 2 * c[2] - prev![2]];
    const da: Vec3 = [c[0] - p1[0], c[1] - p1[1], c[2] - p1[2]];
    const db: Vec3 = [p3[0] - c[0], p3[1] - c[1], p3[2] - c[2]];
    let la = Math.hypot(da[0], da[1], da[2]);
    let lb = Math.hypot(db[0], db[1], db[2]);
    if (la === 0) la = 1;
    if (lb === 0) lb = 1;
    let left: Vec3 = [c[0], c[1], c[2]];
    let right: Vec3 = [c[0], c[1], c[2]];
    const lt = p.handle_left_type;
    const rt = p.handle_right_type;
    const needsAuto =
      lt === 'AUTO' ||
      rt === 'AUTO' ||
      (lt !== 'VECTOR' && !p.handle_left) ||
      (rt !== 'VECTOR' && !p.handle_right);
    if (needsAuto) {
      const t: Vec3 = [db[0] / lb + da[0] / la, db[1] / lb + da[1] / la, db[2] / lb + da[2] / la];
      const len = Math.hypot(t[0], t[1], t[2]) * AUTO_HANDLE_DIV;
      if (len > 0) {
        let a = la;
        let b = lb;
        if (a > 5 * b) a = 5 * b;
        if (b > 5 * a) b = 5 * a;
        left = [c[0] - (t[0] * a) / len, c[1] - (t[1] * a) / len, c[2] - (t[2] * a) / len];
        right = [c[0] + (t[0] * b) / len, c[1] + (t[1] * b) / len, c[2] + (t[2] * b) / len];
      }
    }
    if (lt === 'VECTOR') left = [c[0] - da[0] / 3, c[1] - da[1] / 3, c[2] - da[2] / 3];
    else if (lt !== 'AUTO' && p.handle_left) left = [p.handle_left[0], p.handle_left[1], p.handle_left[2]];
    if (rt === 'VECTOR') right = [c[0] + db[0] / 3, c[1] + db[1] / 3, c[2] + db[2] / 3];
    else if (rt !== 'AUTO' && p.handle_right)
      right = [p.handle_right[0], p.handle_right[1], p.handle_right[2]];
    // keep ALIGNED handles collinear (skipped when either side is FREE, like Blender)
    if ((lt === 'ALIGNED' || rt === 'ALIGNED') && lt !== 'FREE' && rt !== 'FREE') {
      let ha = Math.hypot(left[0] - c[0], left[1] - c[1], left[2] - c[2]);
      let hb = Math.hypot(right[0] - c[0], right[1] - c[1], right[2] - c[2]);
      if (ha === 0) ha = 1;
      if (hb === 0) hb = 1;
      if (lt === 'ALIGNED' && hb > 1e-12) {
        const k = ha / hb;
        left = [c[0] + (c[0] - right[0]) * k, c[1] + (c[1] - right[1]) * k, c[2] + (c[2] - right[2]) * k];
      }
      if (rt === 'ALIGNED' && ha > 1e-12) {
        const k = hb / ha;
        right = [c[0] + (c[0] - left[0]) * k, c[1] + (c[1] - left[1]) * k, c[2] + (c[2] - left[2]) * k];
      }
    }
    return { left, right };
  });
}

function cubic(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const it = 1 - t;
  const a = it * it * it;
  const b = 3 * it * it * t;
  const c = 3 * it * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
  ];
}

/** Unit derivative direction of a cubic Bezier segment (robust to zero-length handles). */
function cubicTangent(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const it = 1 - t;
  const a = it * it;
  const b = 2 * it * t;
  const c = t * t;
  const d: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) d[k] = a * (p1[k] - p0[k]) + b * (p2[k] - p1[k]) + c * (p3[k] - p2[k]);
  let l = Math.hypot(d[0], d[1], d[2]);
  if (l < 1e-12) {
    // degenerate handle at an end: use the direction towards the next distinct control point
    const from = t < 0.5 ? p0 : p3;
    const cands = t < 0.5 ? [p2, p3] : [p1, p0];
    for (const q of cands) {
      const s = t < 0.5 ? 1 : -1;
      d[0] = (q[0] - from[0]) * s;
      d[1] = (q[1] - from[1]) * s;
      d[2] = (q[2] - from[2]) * s;
      l = Math.hypot(d[0], d[1], d[2]);
      if (l > 1e-12) break;
    }
  }
  return l > 1e-12 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 0];
}

function averageDirections(a: Vec3, b: Vec3): Vec3 {
  const s: Vec3 = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const l = Math.hypot(s[0], s[1], s[2]);
  if (l > 1e-9) return [s[0] / l, s[1] / l, s[2] / l];
  return Math.hypot(a[0], a[1], a[2]) > 0 ? a : b;
}

type NurbsEvaluator = (spline: Spline, resolution: number) => EvaluatedSpline;
let nurbsEvaluator: NurbsEvaluator | null = null;

/** Overrides the built-in NURBS evaluator (null restores it). */
export function setNurbsEvaluator(fn: NurbsEvaluator | null): void {
  nurbsEvaluator = fn;
}

/**
 * Samples a spline into a polyline. POLY splines use their points directly; BEZIER splines are
 * sampled with `resolution` steps per segment (Blender handle rules, tilt and radius interpolated
 * linearly per segment); NURBS splines with `resolution` steps per control-point segment.
 */
export function evaluateSpline(spline: Spline, resolution: number): EvaluatedSpline {
  const s = sanitizeSpline(spline);
  const pts = s.points;
  const n = pts.length;
  let res = Math.max(1, Math.min(1024, Math.round(num(resolution, 12))));
  if (n * res > MAX_SAMPLES_PER_SPLINE)
    res = Math.max(1, Math.floor(MAX_SAMPLES_PER_SPLINE / Math.max(1, n)));
  const cyclic = isSplineCyclic(s);
  const out: EvaluatedSpline = {
    points: [],
    tilts: [],
    radii: [],
    cyclic,
    materialIndex: s.material_index,
    smooth: s.use_smooth,
  };
  if (n === 0) return out;
  if (s.type === 'BEZIER' && n > 1) {
    const h = bezierHandles(s);
    const segs = cyclic ? n : n - 1;
    const tangents: Vec3[] = [];
    let carried: Vec3 | null = null; // end tangent of the previous segment
    let firstStart: Vec3 | null = null;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const p0 = pts[i].co;
      const p1 = h[i].right;
      const p2 = h[j].left;
      const p3 = pts[j].co;
      for (let k = 0; k < res; k++) {
        const t = k / res;
        out.points.push(k === 0 ? [p0[0], p0[1], p0[2]] : cubic(p0, p1, p2, p3, t));
        out.tilts.push(pts[i].tilt + (pts[j].tilt - pts[i].tilt) * t);
        out.radii.push(pts[i].radius + (pts[j].radius - pts[i].radius) * t);
        let tan = cubicTangent(p0, p1, p2, p3, t);
        if (k === 0) {
          if (i === 0) firstStart = tan;
          else if (carried) tan = averageDirections(carried, tan);
        }
        tangents.push(tan);
      }
      carried = cubicTangent(p0, p1, p2, p3, 1);
    }
    if (cyclic) {
      if (carried && firstStart) tangents[0] = averageDirections(carried, firstStart);
    } else {
      const last = pts[n - 1];
      out.points.push([last.co[0], last.co[1], last.co[2]]);
      out.tilts.push(last.tilt);
      out.radii.push(last.radius);
      tangents.push(carried ?? [0, 0, 0]);
    }
    out.tangents = tangents;
    return out;
  }
  if (s.type === 'NURBS' && n > 1) return nurbsEvaluator ? nurbsEvaluator(s, res) : evaluateNurbs(s, res);
  for (const p of pts) {
    out.points.push([p.co[0], p.co[1], p.co[2]]);
    out.tilts.push(p.tilt);
    out.radii.push(p.radius);
  }
  return out;
}

/**
 * Samples every spline of a curve. 2D curves are flattened onto their local XY plane (z = 0, no tilt),
 * like Blender which keeps 2D curve points at z = 0.
 */
export function evaluateCurveSplines(curve: CurveData, forRender = false): EvaluatedSpline[] {
  const splines = Array.isArray(curve.splines) ? curve.splines : [];
  const flat = curve.dimensions === '2D';
  return splines.map((raw) => {
    const s = sanitizeSpline(raw);
    const ev = evaluateSpline(s, splineResolution(curve, s, forRender));
    if (flat) {
      for (const p of ev.points) p[2] = 0;
      for (let i = 0; i < ev.tilts.length; i++) ev.tilts[i] = 0;
      if (ev.tangents)
        ev.tangents = ev.tangents.map((t) => {
          const l = Math.hypot(t[0], t[1]);
          return l > 1e-12 ? ([t[0] / l, t[1] / l, 0] as Vec3) : ([0, 0, 0] as Vec3);
        });
    }
    return ev;
  });
}
