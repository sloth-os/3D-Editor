import type { Vec3 } from '../math/types';
import { add3, distance3, length3, lerp3, scale3, sub3 } from '../math/vec3';
import type { CurveData, Spline, SplinePoint } from '../doc/types';

/** A spline sampled into a polyline (curve object space). */
export interface EvaluatedSpline {
  points: Vec3[];
  tilts: number[];
  radii: number[];
  cyclic: boolean;
  materialIndex: number;
  smooth: boolean;
}

/** Samples per segment used for a spline (spline override, else the curve's resolution). */
export function splineResolution(curve: CurveData, spline: Spline, forRender = false): number {
  const base = forRender && curve.render_resolution_u > 0 ? curve.render_resolution_u : curve.resolution_u;
  return Math.max(1, Math.min(1024, Math.round(spline.resolution_u > 0 ? spline.resolution_u : base)));
}

/**
 * Resolved Bezier handles of every point. AUTO handles are computed from the neighbours (smooth,
 * tangent parallel to next−prev), VECTOR handles point a third of the way to the neighbour,
 * ALIGNED/FREE handles use the stored positions (falling back to AUTO when missing).
 */
export function bezierHandles(spline: Spline): { left: Vec3; right: Vec3 }[] {
  const pts = spline.points;
  const n = pts.length;
  const cyclic = spline.use_cyclic_u && n > 2;
  const neighbour = (i: number): SplinePoint | null =>
    i >= 0 && i < n ? pts[i] : cyclic ? pts[(i + n) % n] : null;
  return pts.map((p, i) => {
    const prev = neighbour(i - 1);
    const next = neighbour(i + 1);
    const auto = (): { left: Vec3; right: Vec3 } => {
      if (!prev && !next) return { left: p.co.slice() as Vec3, right: p.co.slice() as Vec3 };
      if (!prev) {
        const d = sub3(next!.co, p.co);
        return { left: sub3(p.co, scale3(d, 1 / 3)), right: add3(p.co, scale3(d, 1 / 3)) };
      }
      if (!next) {
        const d = sub3(p.co, prev.co);
        return { left: sub3(p.co, scale3(d, 1 / 3)), right: add3(p.co, scale3(d, 1 / 3)) };
      }
      const dl = distance3(p.co, prev.co);
      const dr = distance3(next.co, p.co);
      const t = sub3(next.co, prev.co);
      const tl = length3(t) || 1;
      const dir = scale3(t, 1 / tl);
      // 0.39 ≈ the circle-approximating handle length Blender uses for auto handles
      return { left: sub3(p.co, scale3(dir, dl * 0.39)), right: add3(p.co, scale3(dir, dr * 0.39)) };
    };
    let memo: { left: Vec3; right: Vec3 } | null = null;
    const a = () => (memo ??= auto());
    const left: Vec3 =
      p.handle_left_type === 'VECTOR'
        ? prev
          ? lerp3(p.co, prev.co, 1 / 3)
          : (p.co.slice() as Vec3)
        : (p.handle_left_type === 'FREE' || p.handle_left_type === 'ALIGNED') && p.handle_left
          ? (p.handle_left.slice() as Vec3)
          : a().left;
    const right: Vec3 =
      p.handle_right_type === 'VECTOR'
        ? next
          ? lerp3(p.co, next.co, 1 / 3)
          : (p.co.slice() as Vec3)
        : (p.handle_right_type === 'FREE' || p.handle_right_type === 'ALIGNED') && p.handle_right
          ? (p.handle_right.slice() as Vec3)
          : a().right;
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

/**
 * Samples a spline into a polyline. POLY splines use their points directly; BEZIER splines are
 * sampled with `resolution` steps per segment. NURBS splines are evaluated by `evaluateNurbs`
 * when available (see curve workstream) and otherwise fall back to their control polygon.
 */
export function evaluateSpline(spline: Spline, resolution: number): EvaluatedSpline {
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
  };
  if (n === 0) return out;
  if (spline.type === 'BEZIER' && n > 1) {
    const h = bezierHandles(spline);
    const segs = cyclic ? n : n - 1;
    for (let s = 0; s < segs; s++) {
      const i = s;
      const j = (s + 1) % n;
      const steps = Math.max(1, resolution);
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        out.points.push(cubic(pts[i].co, h[i].right, h[j].left, pts[j].co, t));
        out.tilts.push(pts[i].tilt + (pts[j].tilt - pts[i].tilt) * t);
        out.radii.push(pts[i].radius + (pts[j].radius - pts[i].radius) * t);
      }
    }
    if (!cyclic) {
      const last = pts[n - 1];
      out.points.push(last.co.slice() as Vec3);
      out.tilts.push(last.tilt);
      out.radii.push(last.radius);
    }
    return out;
  }
  if (spline.type === 'NURBS' && nurbsEvaluator && n > 1) return nurbsEvaluator(spline, resolution);
  for (const p of pts) {
    out.points.push(p.co.slice() as Vec3);
    out.tilts.push(p.tilt);
    out.radii.push(p.radius);
  }
  return out;
}

type NurbsEvaluator = (spline: Spline, resolution: number) => EvaluatedSpline;
let nurbsEvaluator: NurbsEvaluator | null = null;

/** Installs the NURBS evaluator (kept pluggable so the sampling core stays dependency free). */
export function setNurbsEvaluator(fn: NurbsEvaluator | null): void {
  nurbsEvaluator = fn;
}

/** Samples every spline of a curve. */
export function evaluateCurveSplines(curve: CurveData, forRender = false): EvaluatedSpline[] {
  return curve.splines.map((s) => evaluateSpline(s, splineResolution(curve, s, forRender)));
}
