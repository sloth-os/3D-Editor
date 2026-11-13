import { afterEach, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  bezierHandles,
  buildCurvePath,
  computeFrames,
  defaultCurve,
  defaultSpline,
  defaultSplinePoint,
  evaluateCurveSplines,
  evaluateNurbs,
  evaluateSpline,
  nurbsKnots,
  nurbsOrder,
  pathFromSpline,
  sanitizeSpline,
  setNurbsEvaluator,
  splineResolution,
  type CurveData,
  type Spline,
  type SplinePoint,
  type Vec3,
} from '../src';

const pt = (co: Vec3, extra: Partial<SplinePoint> = {}): SplinePoint => ({
  ...defaultSplinePoint(co),
  ...extra,
});
const spline = (type: Spline['type'], points: SplinePoint[], extra: Partial<Spline> = {}): Spline => ({
  ...defaultSpline(type, points),
  ...extra,
});
const curve = (splines: Spline[], extra: Partial<CurveData> = {}): CurveData => ({
  ...defaultCurve('c', 'Curve'),
  splines,
  ...extra,
});
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const circlePoints = (r = 1) => [pt([-r, 0, 0]), pt([0, r, 0]), pt([r, 0, 0]), pt([0, -r, 0])];

describe('Bezier handles', () => {
  it('computes smooth AUTO handles that approximate a circle (Blender ratio 2.5614)', () => {
    const s = spline('BEZIER', circlePoints(2), { use_cyclic_u: true });
    const h = bezierHandles(s);
    // neighbours are 2√2 away: handle length = 2√2 / 2.5614
    expect(dist(h[0].right, s.points[0].co)).toBeCloseTo((2 * Math.SQRT2) / 2.5614, 6);
    // handle directions are tangent to the circle (perpendicular to the radius)
    expect(h[0].right[0]).toBeCloseTo(-2);
    expect(h[0].left[1]).toBeCloseTo(-h[0].right[1]);
    const ev = evaluateSpline(s, 16);
    expect(ev.points).toHaveLength(64);
    expect(ev.cyclic).toBe(true);
    for (const p of ev.points) expect(Math.abs(len(p) - 2)).toBeLessThan(2 * 0.003);
  });

  it('points end handles of open splines at the mirrored neighbour', () => {
    const s = spline('BEZIER', [pt([0, 0, 0]), pt([3, 0, 0])]);
    const h = bezierHandles(s);
    expect(h[0].right).toEqual([3 / 2.5614, 0, 0].map((v) => expect.closeTo(v, 9)));
    expect(h[1].left[0]).toBeCloseTo(3 - 3 / 2.5614);
    // a straight two-point Bezier stays on the line
    for (const p of evaluateSpline(s, 10).points) expect(Math.abs(p[1]) + Math.abs(p[2])).toBeLessThan(1e-12);
  });

  it('limits the AUTO handle length ratio to 5 (uneven neighbour spacing)', () => {
    const s = spline('BEZIER', [pt([-10, 0, 0]), pt([0, 0, 0]), pt([1, 1, 0])]);
    const h = bezierHandles(s);
    const la = dist(h[1].left, s.points[1].co);
    const lb = dist(h[1].right, s.points[1].co);
    expect(la / lb).toBeCloseTo(5, 6);
  });

  it('places VECTOR handles a third of the way to the neighbours (corners, straight segments)', () => {
    const s = spline('BEZIER', [
      pt([0, 0, 0], { handle_left_type: 'VECTOR', handle_right_type: 'VECTOR' }),
      pt([3, 0, 0], { handle_left_type: 'VECTOR', handle_right_type: 'VECTOR' }),
      pt([3, 3, 0], { handle_left_type: 'VECTOR', handle_right_type: 'VECTOR' }),
    ]);
    const h = bezierHandles(s);
    expect(h[1].left).toEqual([2, 0, 0]);
    expect(h[1].right).toEqual([3, 1, 0]);
    const ev = evaluateSpline(s, 6);
    // every sample lies on one of the two legs
    for (const p of ev.points) expect(Math.min(Math.abs(p[1]), Math.abs(p[0] - 3))).toBeLessThan(1e-12);
  });

  it('samples straight segments between two VECTOR handles with their start point only (Blender)', () => {
    const corner = (co: Vec3) => pt(co, { handle_left_type: 'VECTOR', handle_right_type: 'VECTOR' });
    const square = spline(
      'BEZIER',
      [corner([-1, -1, 0]), corner([1, -1, 0]), corner([1, 1, 0]), corner([-1, 1, 0])],
      {
        use_cyclic_u: true,
      },
    );
    const ev = evaluateSpline(square, 12);
    expect(ev.points).toEqual([
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0],
    ]);
    expect(ev.straight).toEqual([true, true, true, true]);
    expect(evaluateCurveSplines(curve([square]))[0].points).toHaveLength(4);
    // an open straight line: start and end point
    expect(evaluateSpline(spline('BEZIER', [corner([0, 0, 0]), corner([3, 0, 0])]), 12).points).toEqual([
      [0, 0, 0],
      [3, 0, 0],
    ]);
    // a VECTOR handle facing an AUTO handle is not straight: that segment keeps its samples
    const mixed = spline('BEZIER', [corner([0, 0, 0]), corner([2, 0, 0]), pt([3, 1, 0])]);
    const m = evaluateSpline(mixed, 6);
    expect(m.points).toHaveLength(1 + 6 + 1);
    expect(m.straight).toEqual([true, false, false, false, false, false, false, false]);
    // smooth splines carry no straight flags at all
    expect(
      evaluateSpline(spline('BEZIER', [pt([0, 0, 0]), pt([1, 1, 0]), pt([2, 0, 0])]), 4).straight,
    ).toBeUndefined();
    // paths keep the segment direction along straight spans (no tangent blending across corners)
    const path = pathFromSpline(ev)!;
    for (const t of [0.01, 0.05, 0.1, 0.2, 0.24]) expect(path.sample(t).tangent).toEqual([1, 0, 0]);
    for (const t of [0.26, 0.4, 0.49]) {
      const tan = path.sample(t).tangent;
      expect(tan[0]).toBeCloseTo(0, 12);
      expect(tan[1]).toBeCloseTo(1, 12);
    }
    expect(path.sample(0.125).position).toEqual([0, -1, 0]);
  });

  it('uses FREE handles as stored and keeps ALIGNED handles collinear', () => {
    const free = spline('BEZIER', [
      pt([0, 0, 0], {
        handle_right: [0, 2, 0],
        handle_right_type: 'FREE',
        handle_left: [-1, 0, 0],
        handle_left_type: 'FREE',
      }),
      pt([4, 0, 0]),
    ]);
    expect(bezierHandles(free)[0].right).toEqual([0, 2, 0]);
    const aligned = spline('BEZIER', [
      pt([0, 0, 0], {
        handle_left: [0, -1, 0],
        handle_right: [2, 0, 0],
        handle_left_type: 'ALIGNED',
        handle_right_type: 'ALIGNED',
      }),
      pt([4, 0, 0]),
    ]);
    const h = bezierHandles(aligned)[0];
    // the left handle keeps its length (1) but is turned opposite to the right one
    expect(h.left[0]).toBeCloseTo(-1);
    expect(h.left[1]).toBeCloseTo(0);
    expect(h.right).toEqual([2, 0, 0]);
    // FREE/ALIGNED without stored positions fall back to AUTO
    const missing = spline('BEZIER', [pt([0, 0, 0], { handle_right_type: 'FREE' }), pt([3, 0, 0])]);
    expect(bezierHandles(missing)[0].right[0]).toBeCloseTo(3 / 2.5614);
  });

  it('interpolates tilt and radius per segment and gives analytic tangents', () => {
    const s = spline('BEZIER', [
      pt([0, 0, 0], { tilt: 0, radius: 1 }),
      pt([4, 0, 0], { tilt: 1, radius: 3 }),
    ]);
    const ev = evaluateSpline(s, 4);
    expect(ev.tilts).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(ev.radii).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(ev.tangents).toHaveLength(5);
    for (const t of ev.tangents!) expect(t[0]).toBeCloseTo(1);
  });

  it('keeps Phase-0 sampling counts (resolution steps per segment plus the end point)', () => {
    const s = spline('BEZIER', [pt([0, 0, 0]), pt([2, 0, 0]), pt([2, 2, 0])]);
    const ev = evaluateSpline(s, 8);
    expect(ev.points).toHaveLength(17);
    expect(ev.points[16]).toEqual([2, 2, 0]);
    // two cyclic Bezier points form a closed loop (Blender allows it)
    expect(evaluateSpline({ ...s, points: s.points.slice(0, 2), use_cyclic_u: true }, 4).points).toHaveLength(
      8,
    );
  });
});

describe('NURBS', () => {
  it('builds Blender knot vectors', () => {
    expect(nurbsKnots(5, 4, false, true)).toEqual([0, 0, 0, 0, 1, 2, 2, 2, 2]);
    expect(nurbsKnots(4, 3, false, false)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(nurbsKnots(4, 3, true, false)).toHaveLength(4 + 2 * 3 - 1);
    expect(nurbsOrder({ order_u: 6 }, 3)).toBe(3);
    expect(nurbsOrder({ order_u: 1 }, 8)).toBe(2);
    expect(nurbsOrder({ order_u: 9 }, 8)).toBe(6);
  });

  it('passes through the end points with use_endpoint_u and stays inside the hull without', () => {
    const pts = [pt([0, 0, 0]), pt([1, 2, 0]), pt([3, 2, 0]), pt([4, 0, 0])];
    const clamped = evaluateNurbs(spline('NURBS', pts, { order_u: 4, use_endpoint_u: true }), 8);
    expect(clamped.points).toHaveLength(8 * 3 + 1);
    expect(dist(clamped.points[0], [0, 0, 0])).toBeLessThan(1e-9);
    expect(dist(clamped.points[clamped.points.length - 1], [4, 0, 0])).toBeLessThan(1e-9);
    // a clamped cubic with 4 points is the Bezier curve of its control polygon
    const mid = clamped.points[12];
    expect(mid[0]).toBeCloseTo(2);
    expect(mid[1]).toBeCloseTo(1.5);
    const uniform = evaluateNurbs(spline('NURBS', pts, { order_u: 4, use_endpoint_u: false }), 8);
    expect(uniform.points[0][0]).toBeGreaterThan(0.5);
    expect(uniform.points[uniform.points.length - 1][0]).toBeLessThan(3.5);
    // tangents follow the curve
    expect(clamped.tangents![0][1]).toBeGreaterThan(0.8);
  });

  it('is a polyline through the points with order 2', () => {
    const pts = [pt([0, 0, 0]), pt([1, 1, 0]), pt([2, 0, 0])];
    const ev = evaluateNurbs(spline('NURBS', pts, { order_u: 2, use_endpoint_u: true }), 2);
    expect(ev.points.map((p) => p.map((v) => Math.round(v * 1e9) / 1e9))).toEqual([
      [0, 0, 0],
      [0.5, 0.5, 0],
      [1, 1, 0],
      [1.5, 0.5, 0],
      [2, 0, 0],
    ]);
  });

  it('pulls the curve towards heavier weights and closes cyclic splines', () => {
    const base = [pt([0, 0, 0]), pt([1, 1, 0]), pt([2, 0, 0])];
    const plain = evaluateNurbs(spline('NURBS', base, { order_u: 3 }), 8);
    const heavy = evaluateNurbs(
      spline('NURBS', [base[0], { ...base[1], weight: 5 }, base[2]], { order_u: 3 }),
      8,
    );
    expect(heavy.points[8][1]).toBeGreaterThan(plain.points[8][1]);
    const ring = [pt([1, 0, 0]), pt([0, 1, 0]), pt([-1, 0, 0]), pt([0, -1, 0])];
    const cyc = evaluateNurbs(spline('NURBS', ring, { use_cyclic_u: true, order_u: 3 }), 6);
    expect(cyc.cyclic).toBe(true);
    expect(cyc.points).toHaveLength(24);
    // periodic: the gap from the last sample to the first is an ordinary step
    const step = dist(cyc.points[1], cyc.points[0]);
    expect(dist(cyc.points[23], cyc.points[0])).toBeCloseTo(step, 1);
    // tilt / radius blended with the same basis
    const tilted = evaluateNurbs(
      spline(
        'NURBS',
        base.map((p, i) => ({ ...p, radius: i + 1 })),
        { order_u: 2 },
      ),
      2,
    );
    expect(tilted.radii).toEqual([1, 1.5, 2, 2.5, 3].map((v) => expect.closeTo(v, 9)));
  });

  it('can be overridden through setNurbsEvaluator', () => {
    const s = spline('NURBS', [pt([0, 0, 0]), pt([1, 0, 0])]);
    setNurbsEvaluator(() => ({
      points: [[9, 9, 9]],
      tilts: [0],
      radii: [1],
      cyclic: false,
      materialIndex: 0,
      smooth: true,
    }));
    expect(evaluateSpline(s, 4).points).toEqual([[9, 9, 9]]);
    setNurbsEvaluator(null);
    expect(evaluateSpline(s, 4).points.length).toBe(5);
  });
  afterEach(() => setNurbsEvaluator(null));
});

describe('sampling robustness', () => {
  it('sanitizes malformed points and splines instead of throwing', () => {
    const bad = {
      type: 'WHAT',
      points: [{ co: [NaN, 1, Infinity] }, null, { co: 'x', radius: -2, weight: 0 }],
      order_u: 99,
      resolution_u: -5,
    } as unknown as Spline;
    const s = sanitizeSpline(bad);
    expect(s.type).toBe('POLY');
    expect(s.points).toHaveLength(2);
    expect(s.points[0].co).toEqual([0, 1, 0]);
    expect(s.points[1].radius).toBe(0);
    expect(s.points[1].weight).toBeGreaterThan(0);
    expect(s.order_u).toBe(6);
    expect(s.resolution_u).toBe(0);
    expect(() => evaluateSpline(bad, NaN)).not.toThrow();
    expect(evaluateSpline(spline('BEZIER', []), 12).points).toEqual([]);
    expect(evaluateSpline(spline('BEZIER', [pt([1, 2, 3])]), 12).points).toEqual([[1, 2, 3]]);
    expect(() =>
      evaluateCurveSplines({ ...curve([]), splines: 'nope' as unknown as Spline[] }),
    ).not.toThrow();
  });

  it('uses per-spline and render resolutions', () => {
    const s = spline('BEZIER', [pt([0, 0, 0]), pt([1, 0, 0])]);
    const c = curve([s, { ...s, resolution_u: 3 }], { resolution_u: 5, render_resolution_u: 20 });
    expect(splineResolution(c, c.splines[0])).toBe(5);
    expect(splineResolution(c, c.splines[0], true)).toBe(20);
    expect(splineResolution(c, c.splines[1], true)).toBe(3);
    expect(evaluateCurveSplines(c).map((e) => e.points.length)).toEqual([6, 4]);
    expect(splineResolution({ ...c, resolution_u: NaN }, s)).toBe(12);
  });

  it('flattens 2D curves onto z = 0 and ignores their tilt', () => {
    const c = curve([spline('POLY', [pt([0, 0, 5], { tilt: 2 }), pt([1, 0, -3])])], { dimensions: '2D' });
    const [e] = evaluateCurveSplines(c);
    expect(e.points).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(e.tilts).toEqual([0, 0]);
  });
});

describe('frames and paths', () => {
  const helix = (turns = 2, n = 64): Vec3[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / (n - 1)) * turns * Math.PI * 2;
      return [Math.cos(a), Math.sin(a), i * 0.05];
    });

  it('keeps every frame orthonormal and +Z up for Z_UP / 2D curves', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ];
    for (const [mode, is2D] of [
      ['Z_UP', false],
      ['MINIMUM', false],
      ['TANGENT', false],
      ['MINIMUM', true],
    ] as const) {
      const f = computeFrames(pts, false, [0, 0, 0], mode, is2D);
      for (let i = 0; i < pts.length; i++) {
        expect(len(f.ups[i])).toBeCloseTo(1);
        expect(dot(f.ups[i], f.tangents[i])).toBeCloseTo(0);
        expect(dot(f.sides[i], f.tangents[i])).toBeCloseTo(0);
        expect(Math.abs(f.ups[i][2])).toBeCloseTo(1);
      }
    }
    // the 90° corner: bisector tangent and a 1/cos(45°) miter
    const f = computeFrames(pts, false, [0, 0, 0], 'Z_UP', false);
    expect(f.miters[1]).toBeCloseTo(Math.SQRT2);
    expect(f.turns[1]).toBeCloseTo(Math.PI / 2);
    // side = up × tangent: the left of the direction of travel
    expect(f.sides[0]).toEqual([0, 1, 0].map((v) => expect.closeTo(v, 9)));
  });

  it('handles vertical tangents in Z_UP without NaN', () => {
    const f = computeFrames(
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 0, 2],
      ],
      false,
      [0, 0, 0],
      'Z_UP',
      false,
    );
    for (const u of f.ups) {
      expect(u.every(Number.isFinite)).toBe(true);
      expect(len(u)).toBeCloseTo(1);
    }
  });

  it('transports MINIMUM twist frames smoothly and closes cyclic loops', () => {
    const f = computeFrames(helix(), false, new Array(64).fill(0), 'MINIMUM', false);
    for (let i = 1; i < 64; i++) expect(dot(f.ups[i], f.ups[i - 1])).toBeGreaterThan(0.95);
    // a closed, non-planar loop still ends where it started
    const loop: Vec3[] = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a), 0.4 * Math.sin(3 * a)];
    });
    const c = computeFrames(loop, true, new Array(48).fill(0), 'MINIMUM', false);
    // minimal twist: the frame never turns more than the tangent does, also across the closing seam
    for (let i = 0; i < 48; i++) {
      const j = (i + 1) % 48;
      expect(dot(c.ups[i], c.ups[j])).toBeGreaterThan(dot(c.tangents[i], c.tangents[j]) - 0.01);
    }
  });

  it('uses the bending direction for TANGENT and rotates frames by tilt', () => {
    const circle: Vec3[] = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a), 0];
    });
    const f = computeFrames(circle, true, new Array(32).fill(0), 'TANGENT', false);
    for (const u of f.ups) expect(Math.abs(u[2])).toBeCloseTo(1);
    const tilted = computeFrames(circle, true, new Array(32).fill(Math.PI / 2), 'Z_UP', false);
    for (let i = 0; i < 32; i++) expect(Math.abs(tilted.ups[i][2])).toBeLessThan(1e-9);
  });

  it('builds paths with smooth tangents and twist frames', () => {
    const c = curve([spline('BEZIER', circlePoints(1), { use_cyclic_u: true })], { twist_mode: 'Z_UP' });
    const path = buildCurvePath(c)!;
    expect(path.cyclic).toBe(true);
    expect(path.length).toBeCloseTo(2 * Math.PI, 1);
    const s = path.sample(0.3);
    expect(len(s.tangent)).toBeCloseTo(1);
    expect(s.up).toBeDefined();
    expect(Math.abs(dot(s.up!, s.tangent))).toBeLessThan(1e-9);
    expect(s.up![2]).toBeCloseTo(1);
    // tangent is perpendicular to the radius on a circle
    expect(Math.abs(dot(s.tangent, s.position))).toBeLessThan(0.02);
    // wraps around
    expect(dist(path.sample(1.3).position, s.position)).toBeLessThan(1e-9);
    // degenerate splines have no path
    expect(
      pathFromSpline({
        points: [[0, 0, 0]],
        tilts: [0],
        radii: [1],
        cyclic: false,
        materialIndex: 0,
        smooth: true,
      }),
    ).toBeNull();
    expect(
      pathFromSpline({
        points: [
          [1, 1, 1],
          [1, 1, 1],
        ],
        tilts: [0, 0],
        radii: [1, 1],
        cyclic: false,
        materialIndex: 0,
        smooth: true,
      }),
    ).toBeNull();
  });

  it('keeps Phase-0 path semantics for POLY splines', () => {
    const doc = new SceneDoc();
    const c = {
      ...doc.getCurve(doc.addCurve())!,
      splines: [spline('POLY', [pt([0, 0, 0]), pt([2, 0, 0]), pt([2, 2, 0])])],
    };
    const path = buildCurvePath(c)!;
    expect(path.length).toBeCloseTo(4);
    expect(path.sample(0.5).position).toEqual([2, 0, 0]);
    expect(path.sample(0.75).tangent).toEqual([0, 1, 0]);
    expect(path.sample(-1).position).toEqual([0, 0, 0]);
    expect(path.sample(NaN).position).toEqual([0, 0, 0]);
  });
});
