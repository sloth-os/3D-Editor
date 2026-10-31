import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  curveToMesh,
  curveToMeshData,
  defaultCurve,
  defaultSpline,
  defaultSplinePoint,
  faceNormalRaw,
  countInconsistentEdges,
  isClosedManifold,
  objectBevelProfiles,
  renderItems,
  roundBevelProfile,
  type CurveData,
  type CurveMeshOptions,
  type MeshData,
  type Spline,
  type SplinePoint,
  type Vec2,
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
const OPTS: CurveMeshOptions = { forRender: false, isText: false };
const build = (c: CurveData, opts: Partial<CurveMeshOptions> = {}) => curveToMesh(c, { ...OPTS, ...opts });
const mesh = (c: CurveData, opts: Partial<CurveMeshOptions> = {}): MeshData => {
  const r = build(c, opts);
  expect(r.mesh).not.toBeNull();
  return r.mesh!;
};

const square = (s: number, cyclic = true, z = 0): Spline =>
  spline('POLY', [pt([-s, -s, z]), pt([s, -s, z]), pt([s, s, z]), pt([-s, s, z])], { use_cyclic_u: cyclic });
const circle = (r = 1): Spline =>
  spline('BEZIER', [pt([-r, 0, 0]), pt([0, r, 0]), pt([r, 0, 0]), pt([0, -r, 0])], { use_cyclic_u: true });
const line = (x0: number, x1: number, extra: Partial<SplinePoint>[] = []): Spline =>
  spline('POLY', [pt([x0, 0, 0], extra[0]), pt([x1, 0, 0], extra[1])]);

function vertex(m: MeshData, i: number): Vec3 {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
}

/** Signed volume enclosed by the faces (positive for outward normals). */
function volume(m: MeshData): number {
  let v = 0;
  for (const f of m.faces) {
    const a = vertex(m, f[0]);
    for (let i = 1; i + 1 < f.length; i++) {
      const b = vertex(m, f[i]);
      const c = vertex(m, f[i + 1]);
      v +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
  }
  return v;
}

/** Projected (signed) area of the faces onto the XY plane. */
function areaZ(m: MeshData, filter: (nz: number) => boolean = () => true): number {
  let a = 0;
  m.faces.forEach((_, f) => {
    const n = faceNormalRaw(m, f);
    if (filter(n[2])) a += n[2] / 2;
  });
  return a;
}

function bounds(m: MeshData): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], m.positions[i + k]);
      max[k] = Math.max(max[k], m.positions[i + k]);
    }
  return { min, max };
}

describe('wire curves', () => {
  it('return wire lines when there is no surface', () => {
    const r = build(curve([spline('POLY', [pt([0, 0, 0]), pt([1, 0, 0]), pt([1, 1, 0])])]));
    expect(r.mesh).toBeNull();
    expect(Array.from(r.lines!)).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
    const closed = build(curve([square(1)]));
    expect(closed.lines!.length).toBe(4 * 6);
    // empty curves give nothing at all
    expect(build(curve([]))).toEqual({ mesh: null, lines: null });
  });

  it('converts wires to vertices + loose edges for Convert to Mesh', () => {
    const m = curveToMeshData(curve([square(1)]), OPTS)!;
    expect(m.positions.length / 3).toBe(4);
    expect(m.looseEdges.length / 2).toBe(4);
    expect(m.faces).toHaveLength(0);
    expect(curveToMeshData(curve([]), OPTS)).toBeNull();
  });
});

describe('round bevel', () => {
  it('sweeps a closed circle into a watertight torus with outward normals', () => {
    const m = mesh(curve([circle(1)], { bevel_depth: 0.1, bevel_resolution: 4 }));
    // 4 Bezier segments × 12 samples, 4 × 4 + 4 profile points
    expect(m.positions.length / 3).toBe(48 * 20);
    expect(m.faces).toHaveLength(48 * 20);
    expect(isClosedManifold(m)).toBe(true);
    const ideal = (2 * Math.PI * Math.PI * 1 * 0.01 * ((20 / 2) * Math.sin((2 * Math.PI) / 20))) / Math.PI;
    expect(volume(m)).toBeGreaterThan(0);
    expect(volume(m) / ideal).toBeCloseTo(1, 1);
    for (let i = 0; i < m.positions.length / 3; i++) {
      const v = vertex(m, i);
      expect(Math.abs(Math.hypot(Math.hypot(v[0], v[1]) - 1, v[2]) - 0.1)).toBeLessThan(0.004);
    }
    expect(m.faceSmooth.every(Boolean)).toBe(true);
  });

  it('caps open tubes with use_fill_caps and builds HALF / FRONT / BACK profiles', () => {
    const base = curve([line(0, 4)], { bevel_depth: 0.2, bevel_resolution: 2 });
    const open = mesh(base);
    expect(isClosedManifold(open)).toBe(false);
    const capped = mesh({ ...base, use_fill_caps: true });
    expect(isClosedManifold(capped)).toBe(true);
    expect(volume(capped)).toBeGreaterThan(0.9 * Math.PI * 0.04 * 4);
    expect(roundBevelProfile(0.2, 0, 2, 'HALF')!.points).toHaveLength(2 * 3 + 1);
    expect(roundBevelProfile(0.2, 0.1, 2, 'FRONT')!.points).toHaveLength(2 + 3);
    expect(roundBevelProfile(0.2, 0.1, 2, 'BACK')!.back).toBe(0);
    expect(roundBevelProfile(0, 0.1, 2, 'FULL')).toBeNull();
    const half = mesh({ ...base, fill_mode: 'HALF' });
    // half tube on the left (+Y) side of a curve running along +X
    expect(bounds(half).min[1]).toBeGreaterThanOrEqual(-1e-9);
    expect(bounds(half).max[1]).toBeCloseTo(0.2);
  });

  it('extrudes 3D curves into ribbons (Z up) and rounds the extrusion with a bevel', () => {
    const ribbon = mesh(curve([line(0, 2)], { extrude: 0.5 }));
    expect(ribbon.positions.length / 3).toBe(4);
    const b = bounds(ribbon);
    expect(b.min[2]).toBeCloseTo(-0.5);
    expect(b.max[2]).toBeCloseTo(0.5);
    expect(b.max[1] - b.min[1]).toBeCloseTo(0);
    const stadium = mesh(curve([circle(2)], { extrude: 0.3, bevel_depth: 0.1 }));
    expect(isClosedManifold(stadium)).toBe(true);
    expect(bounds(stadium).max[2]).toBeCloseTo(0.4);
  });

  it('tapers by point radius, collapsing zero-radius ends into a tip', () => {
    const c = curve([spline('BEZIER', [pt([0, 0, 0], { radius: 1 }), pt([3, 0, 0], { radius: 0 })])], {
      bevel_depth: 0.3,
      bevel_resolution: 2,
      use_fill_caps: true,
    });
    const m = mesh(c);
    // 13 samples, the last one collapsed to a single vertex
    expect(m.positions.length / 3).toBe(12 * 12 + 1);
    expect(isClosedManifold(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
    const mid = mesh({
      ...c,
      splines: [spline('POLY', [pt([0, 0, 0], { radius: 2 }), pt([1, 0, 0], { radius: 2 })])],
    });
    expect(bounds(mid).max[2]).toBeCloseTo(0.6);
  });

  it('applies tilt, offset and the twist mode', () => {
    const tilted = mesh(
      curve([line(0, 2, [{ tilt: Math.PI / 2 }, { tilt: Math.PI / 2 }])], { extrude: 0.5 }),
    );
    const b = bounds(tilted);
    expect(b.max[2] - b.min[2]).toBeLessThan(1e-9);
    expect(b.max[1] - b.min[1]).toBeCloseTo(1);
    const offset = mesh(curve([line(0, 2)], { bevel_depth: 0.1, offset: 0.5 }));
    expect(bounds(offset).min[1]).toBeCloseTo(0.4);
    // a vertical curve with Z_UP twist still gets a valid tube
    const vertical = mesh(
      curve([spline('POLY', [pt([0, 0, 0]), pt([0, 0, 2])])], { bevel_depth: 0.1, twist_mode: 'Z_UP' }),
    );
    expect(vertical.positions.every(Number.isFinite)).toBe(true);
    for (const mode of ['Z_UP', 'MINIMUM', 'TANGENT'] as const) {
      const m = mesh(curve([circle(1)], { bevel_depth: 0.05, twist_mode: mode }));
      expect(isClosedManifold(m)).toBe(true);
      expect(volume(m)).toBeGreaterThan(0);
    }
  });

  it('keeps POLY corners mitred and splits their shading', () => {
    const c = curve([spline('POLY', [pt([0, 0, 0]), pt([2, 0, 0]), pt([2, 2, 0])])], { bevel_depth: 0.1 });
    const m = mesh(c);
    // the corner ring is stretched by √2 along the bisector, so the tube keeps its width
    let far = 0;
    for (let i = 0; i < m.positions.length / 3; i++) {
      const v = vertex(m, i);
      if (Math.abs(v[0] - 2) < 0.2 && Math.abs(v[1]) < 0.2) far = Math.max(far, Math.hypot(v[0] - 2, v[1]));
    }
    expect(far).toBeCloseTo(0.1 * Math.SQRT2, 6);
    expect(Object.values(m.edgeAttrs).filter((a) => a.sharp).length).toBe(20);
  });
});

describe('bevel factor', () => {
  it('builds only the requested part of the length', () => {
    const c = curve([line(0, 10)], { bevel_depth: 0.5 });
    const part = mesh({ ...c, bevel_factor_start: 0.2, bevel_factor_end: 0.5 });
    expect(bounds(part).min[0]).toBeCloseTo(2);
    expect(bounds(part).max[0]).toBeCloseTo(5);
    // nothing left: no surface and no wire fallback (growing animations start empty)
    expect(build({ ...c, bevel_factor_end: 0 })).toEqual({ mesh: null, lines: null });
    // swapped factors are ordered
    expect(bounds(mesh({ ...c, bevel_factor_start: 0.5, bevel_factor_end: 0.2 })).max[0]).toBeCloseTo(5);
  });

  it('opens trimmed closed curves (and caps them when asked)', () => {
    const c = curve([square(1)], { bevel_depth: 0.1, bevel_factor_end: 0.6 });
    expect(isClosedManifold(mesh(c))).toBe(false);
    expect(isClosedManifold(mesh({ ...c, use_fill_caps: true }))).toBe(true);
    // u keeps its place along the full length while growing
    const m = mesh({ ...c, bevel_factor_start: 0 });
    for (const uv of m.uvs!)
      for (let i = 0; i < uv.length; i += 2) expect(uv[i]).toBeLessThanOrEqual(0.6 + 1e-9);
  });
});

describe('2D fill', () => {
  const holed = (extra: Partial<CurveData> = {}) =>
    curve([square(1), square(0.5)], { dimensions: '2D', ...extra });

  it('fills closed splines with even-odd holes facing +Z', () => {
    const m = mesh(holed());
    expect(areaZ(m)).toBeCloseTo(3);
    expect(areaZ(m, (nz) => nz < 0)).toBe(0);
    // FULL behaves like BOTH for 2D curves, and a flat fill is built only once
    expect(mesh(holed({ fill_mode: 'FULL' })).faces.length).toBe(m.faces.length);
    expect(areaZ(mesh(holed({ fill_mode: 'BACK' })))).toBeCloseTo(-3);
    const none = build(holed({ fill_mode: 'NONE' }));
    expect(none.mesh).toBeNull();
    expect(none.lines!.length).toBe(8 * 6);
  });

  it('treats nested contours as islands inside holes', () => {
    const m = mesh(curve([square(3), square(2), square(1)], { dimensions: '2D' }));
    expect(areaZ(m)).toBeCloseTo(36 - 16 + 4);
    // an outer contour without holes is a single n-gon
    expect(mesh(curve([square(1)], { dimensions: '2D' })).faces).toHaveLength(1);
  });

  it('offsets outlines outwards (positive) or inwards, keeping square corners', () => {
    expect(areaZ(mesh(curve([square(1)], { dimensions: '2D', offset: 0.1 })))).toBeCloseTo(2.2 * 2.2);
    expect(areaZ(mesh(curve([square(1)], { dimensions: '2D', offset: -0.1 })))).toBeCloseTo(1.8 * 1.8);
    // holes grow into the hole when the shape gets bolder
    expect(areaZ(mesh(holed({ offset: 0.05 })))).toBeCloseTo(2.1 * 2.1 - 0.9 * 0.9);
  });

  it('extrudes into closed solids with front and back caps', () => {
    const m = mesh(holed({ extrude: 0.25 }));
    expect(isClosedManifold(m)).toBe(true);
    expect(volume(m)).toBeCloseTo(3 * 0.5);
    expect(areaZ(m, (nz) => nz > 1e-9)).toBeCloseTo(3);
    const front = mesh(holed({ extrude: 0.25, fill_mode: 'FRONT' }));
    expect(isClosedManifold(front)).toBe(false);
    expect(areaZ(front, (nz) => nz < -1e-9)).toBe(0);
    const back = mesh(holed({ extrude: 0.25, fill_mode: 'BACK' }));
    expect(areaZ(back, (nz) => nz > 1e-9)).toBe(0);
    // walls only
    expect(areaZ(mesh(holed({ extrude: 0.25, fill_mode: 'NONE' })))).toBeCloseTo(0);
  });

  it('bevels filled shapes outward with caps at extrude + bevel depth', () => {
    const m = mesh(
      curve([circle(1)], { dimensions: '2D', extrude: 0.1, bevel_depth: 0.05, bevel_resolution: 3 }),
    );
    expect(isClosedManifold(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
    const b = bounds(m);
    expect(b.max[2]).toBeCloseTo(0.15);
    expect(b.min[2]).toBeCloseTo(-0.15);
    expect(b.max[0]).toBeCloseTo(1.05, 2);
    // holes are beveled into the hole
    const ring = mesh(curve([circle(1), circle(0.5)], { dimensions: '2D', extrude: 0.1, bevel_depth: 0.05 }));
    expect(isClosedManifold(ring)).toBe(true);
    let inner = Infinity;
    for (let i = 0; i < ring.positions.length / 3; i++)
      inner = Math.min(inner, Math.hypot(ring.positions[i * 3], ring.positions[i * 3 + 1]));
    expect(inner).toBeCloseTo(0.45, 2);
  });

  it('builds a single cap set when zero radius flattens an extruded shape', () => {
    const flat = curve([{ ...square(1), points: square(1).points.map((p) => ({ ...p, radius: 0 })) }], {
      dimensions: '2D',
      extrude: 0.2,
    });
    const m = mesh(flat);
    expect(m.faces).toHaveLength(1);
    expect(areaZ(m)).toBeCloseTo(4);
    for (let i = 2; i < m.positions.length; i += 3) expect(m.positions[i]).toBe(0);
  });

  it('keeps every extruded and beveled 2D solid consistently wound', () => {
    for (const extra of [{ extrude: 0.2 }, { extrude: 0.1, bevel_depth: 0.05 }, { bevel_depth: 0.05 }])
      expect(countInconsistentEdges(mesh(holed(extra)))).toBe(0);
  });

  it('keeps open splines of filled curves as wires (lines + loose edges)', () => {
    const c = curve([square(1), line(2, 3)], { dimensions: '2D' });
    const r = build(c);
    expect(r.mesh!.faces).toHaveLength(1);
    expect(r.mesh!.looseEdges).toHaveLength(2);
    expect(r.lines!.length).toBe(6);
  });
});

describe('materials, shading and UVs', () => {
  it('maps spline material_index and use_smooth to faces', () => {
    const c = curve([line(0, 1), { ...line(0, 1), material_index: 2, use_smooth: false }], {
      bevel_depth: 0.1,
    });
    const m = mesh(c);
    expect(new Set(m.faceMaterials)).toEqual(new Set([0, 2]));
    m.faces.forEach((_, f) => expect(m.faceSmooth[f]).toBe(m.faceMaterials[f] === 0));
  });

  it('gives UVs along the length (u) and around the profile (v)', () => {
    const m = mesh(curve([line(0, 4)], { bevel_depth: 0.2, use_fill_caps: true }));
    expect(m.uvs).not.toBeNull();
    let maxU = 0;
    for (const uv of m.uvs!)
      for (const v of uv) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
        maxU = Math.max(maxU, v);
      }
    expect(maxU).toBeCloseTo(1);
    // a corner at u = 0 lies at x = 0
    const f = m.faces.findIndex((face) => face.length === 4);
    const face = m.faces[f];
    face.forEach((v, i) => expect(m.uvs![f][i * 2]).toBeCloseTo(vertex(m, v)[0] / 4));
  });
});

describe('bevel objects', () => {
  const sq: Vec2[] = [
    [-0.1, -0.1],
    [0.1, -0.1],
    [0.1, 0.1],
    [-0.1, 0.1],
  ];

  it('sweeps closed profiles from getBevelProfile', () => {
    const c = curve([circle(1)], { bevel_mode: 'OBJECT', bevel_object: 'prof' });
    const m = mesh(c, { getBevelProfile: (id) => (id === 'prof' ? [sq] : null) });
    expect(isClosedManifold(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
    // square profile corners are sharp
    expect(Object.keys(m.edgeAttrs).length).toBeGreaterThan(0);
    // extrude is ignored in OBJECT mode (Blender)
    expect(mesh({ ...c, extrude: 1 }, { getBevelProfile: () => [sq] }).positions.length).toBe(
      m.positions.length,
    );
  });

  it('tells open and cyclic profile splines apart with getBevelCurve', () => {
    const profileCurve = curve([
      spline('POLY', [pt([-0.1, 0.1, 0]), pt([-0.1, -0.1, 0]), pt([0.1, -0.1, 0]), pt([0.1, 0.1, 0])]),
    ]);
    const c = curve([circle(1)], { bevel_mode: 'OBJECT', bevel_object: 'u' });
    const channel = mesh(c, { getBevelCurve: () => profileCurve });
    expect(isClosedManifold(channel)).toBe(false);
    const closed = mesh(c, {
      getBevelCurve: () => ({
        ...profileCurve,
        splines: [{ ...profileCurve.splines[0], use_cyclic_u: true }],
      }),
    });
    expect(isClosedManifold(closed)).toBe(true);
    expect(objectBevelProfiles([sq])[0].closed).toBe(true);
    expect(objectBevelProfiles([[...sq, sq[0]]])[0].points).toHaveLength(4);
    expect(
      objectBevelProfiles([
        [
          [0, 0],
          [1, 0],
          [1, 2],
        ],
      ])[0].closed,
    ).toBe(false);
  });

  it('orients end caps of open profiles consistently with the walls', () => {
    // a clockwise open profile (an arch): walls and caps must still agree everywhere
    const arch: Vec2[] = [
      [0.1, 0],
      [0.07, 0.07],
      [0, 0.1],
      [-0.07, 0.07],
      [-0.1, 0],
    ];
    for (const prof of [arch, [...arch].reverse()]) {
      const m = mesh(curve([line(0, 2)], { bevel_mode: 'OBJECT', bevel_object: 'p', use_fill_caps: true }), {
        getBevelProfile: () => [prof],
      });
      // the chord side of an open profile stays open; caps and walls must agree in winding
      expect(isClosedManifold(m)).toBe(false);
      expect(m.faces.filter((f) => f.length === 5)).toHaveLength(2);
      expect(countInconsistentEdges(m)).toBe(0);
    }
    expect(countInconsistentEdges(mesh(curve([line(0, 4)], { bevel_depth: 0.2, use_fill_caps: true })))).toBe(
      0,
    );
  });

  it('reports a missing bevel object and falls back to the wire', () => {
    const r = build(curve([circle(1)], { bevel_mode: 'OBJECT', bevel_object: 'gone' }), {
      getBevelProfile: () => null,
    });
    expect(r.mesh).toBeNull();
    expect(r.lines).not.toBeNull();
    expect(r.errors?.[0]).toMatch(/bevel object/);
  });
});

describe('robustness', () => {
  it('never throws for malformed data', () => {
    const junk = [
      { ...curve([]), splines: 'x' as unknown as Spline[] },
      curve([spline('BEZIER', [pt([NaN, NaN, NaN])])], { bevel_depth: 0.1 }),
      curve([spline('POLY', [pt([1, 1, 1]), pt([1, 1, 1]), pt([1, 1, 1])], { use_cyclic_u: true })], {
        bevel_depth: 0.1,
        dimensions: '2D',
      }),
      curve([line(0, 1)], { bevel_depth: NaN, extrude: -1, bevel_resolution: 1e9, bevel_factor_end: NaN }),
      curve([square(1)], {
        dimensions: '2D',
        offset: Infinity,
        fill_mode: 'WHAT' as never,
        twist_mode: 'BAD' as never,
      }),
      { ...curve([line(0, 1)]), bevel_mode: 'OBJECT' as const, bevel_object: 'x' },
    ];
    for (const c of junk) {
      expect(() => build(c)).not.toThrow();
      expect(() => build(c, { isText: true })).not.toThrow();
    }
  });

  it('falls back to a wire for absurdly dense surfaces', () => {
    const pts = Array.from({ length: 30000 }, (_, i) => pt([i * 0.01, Math.sin(i), 0]));
    const r = build(curve([spline('POLY', pts)], { bevel_depth: 0.1, bevel_resolution: 32 }));
    expect(r.mesh).toBeNull();
    expect(r.errors?.[0]).toMatch(/too dense/);
    expect(r.lines).not.toBeNull();
  });
});

describe('scene evaluation', () => {
  it('renders beveled curves with their materials and re-evaluates on change', () => {
    const doc = new SceneDoc();
    const mat = doc.addMaterial({ name: 'Red' });
    const cid = doc.addCurve({ splines: [circle(1)], bevel_depth: 0.1 });
    const id = doc.addObject({ type: 'CURVE', name: 'Ring', data: cid, material_slots: [mat] });
    const ev = new SceneEvaluator(doc);
    const a = ev.evaluate(1);
    const items = renderItems(a);
    expect(items.map((i) => i.id)).toEqual([id]);
    expect(items[0].materials[0]?.name).toBe('Red');
    expect(a.byId.get(id)!.lines).toBeUndefined();
    const key = a.byId.get(id)!.meshKey;
    expect(ev.evaluate(2).byId.get(id)!.meshKey).toBe(key);
    doc.updateCurve(cid, { bevel_depth: 0.2 });
    const b = ev.evaluate(1).byId.get(id)!;
    expect(b.meshKey).not.toBe(key);
    expect(bounds(b.mesh!).max[2]).toBeCloseTo(0.2);
  });
});
