import { describe, expect, it } from 'vitest';
import {
  compose4,
  createCone,
  createCube,
  createGrid,
  createMesh,
  determinant4,
  transformDirection3,
  type Mat4,
  type MeshData,
  type Vec3,
} from '../src';
import {
  SceneRaycaster,
  boundsGap,
  boundsValue,
  computeDrop,
  distributeDeltas,
  emptyBounds,
  extendBounds,
  isEmptyBounds,
  meshDistance,
  pointsBounds,
  rotationBetween,
  sampleSurface,
  trackRotation,
  unionBounds,
  type RaycastTarget,
  type TrackAxis,
  type UpAxis,
} from '../src/generate';

const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function target(mesh: MeshData, matrix: Mat4 = I, id = 'T'): RaycastTarget {
  return { id, objectId: id, instancer: null, mesh, matrix };
}

function col(m: Mat4, k: number): Vec3 {
  return [m[k * 4], m[k * 4 + 1], m[k * 4 + 2]];
}

function expectVec(a: readonly number[], b: readonly number[], digits = 9) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

function worldPoints(mesh: MeshData, m: Mat4): number[] {
  const out: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    out.push(
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    );
  }
  return out;
}

describe('bounds helpers', () => {
  it('build, union, measure and compare boxes', () => {
    const b = emptyBounds();
    expect(isEmptyBounds(b)).toBe(true);
    extendBounds(b, 1, 2, 3);
    extendBounds(b, NaN, 0, 0);
    extendBounds(b, -1, 0, Infinity);
    expect(b).toEqual({ min: [1, 2, 3], max: [1, 2, 3] });
    const p = pointsBounds([0, 0, 0, 1, 2, 3], compose4([10, 0, 0], [0, 0, 0], [2, 2, 2]));
    expect(p).toEqual({ min: [10, 0, 0], max: [12, 4, 6] });
    expect(unionBounds(b, p)).toEqual({ min: [1, 0, 0], max: [12, 4, 6] });
    expect(boundsGap({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [4, 5, 0], max: [5, 6, 1] })).toBeCloseTo(
      5,
      12,
    );
    expect(boundsGap({ min: [0, 0, 0], max: [2, 2, 2] }, { min: [1, 1, 1], max: [3, 3, 3] })).toBe(0);
    const box = { min: [0, -2, 4], max: [2, 2, 6] } as const;
    expect([
      boundsValue(box as never, 0, 'MIN'),
      boundsValue(box as never, 1, 'CENTER'),
      boundsValue(box as never, 2, 'MAX'),
    ]).toEqual([0, 0, 6]);
    expect(isEmptyBounds(pointsBounds([]))).toBe(true);
  });
});

describe('distributeDeltas', () => {
  it('EVEN keeps the extremes and equalizes the gaps between extents (any input order)', () => {
    const items = [
      { lo: 9, hi: 10 }, // last
      { lo: 0, hi: 1 }, // first
      { lo: 2, hi: 5 },
      { lo: 3, hi: 4 },
    ];
    const r = distributeDeltas(items, 'EVEN');
    expect(r.order).toEqual([1, 2, 3, 0]);
    expect(r.deltas[1]).toBe(0);
    expect(r.deltas[0]).toBeCloseTo(0, 12);
    const moved = items.map((it, i) => ({ lo: it.lo + r.deltas[i], hi: it.hi + r.deltas[i] }));
    const sorted = r.order.map((i) => moved[i]);
    const gaps = sorted.slice(1).map((it, i) => it.lo - sorted[i].hi);
    for (const g of gaps) expect(g).toBeCloseTo(r.gap, 12);
    expect(r.gap).toBeCloseTo((10 - 0 - (1 + 3 + 1 + 1)) / 3, 12);
  });

  it('GAP chains extents with a fixed gap; origins (lo = hi) space the points; one item is a no-op', () => {
    const r = distributeDeltas(
      [
        { lo: 0, hi: 2 },
        { lo: 10, hi: 11 },
        { lo: 4, hi: 8 },
      ],
      'GAP',
      0.5,
    );
    // order by centre: [0,2], [4,8], [10,11] → [0,2], [2.5,6.5], [7,8]
    expect(r.deltas).toEqual([0, 7 - 10, 2.5 - 4]);
    const o = distributeDeltas(
      [
        { lo: 0, hi: 0 },
        { lo: 1, hi: 1 },
        { lo: 9, hi: 9 },
      ],
      'EVEN',
    );
    expect(o.deltas).toEqual([0, 3.5, 0]);
    expect(distributeDeltas([{ lo: 3, hi: 4 }], 'EVEN').deltas).toEqual([0]);
    expect(distributeDeltas([], 'GAP', 1).deltas).toEqual([]);
    // items longer than the span overlap evenly (negative gap)
    expect(
      distributeDeltas(
        [
          { lo: 0, hi: 2 },
          { lo: 1, hi: 3 },
          { lo: 1.5, hi: 3.5 },
        ],
        'EVEN',
      ).gap,
    ).toBeLessThan(0);
  });
});

describe('rotations', () => {
  it('rotationBetween turns one direction onto another (also opposite and degenerate ones)', () => {
    const dirs: Vec3[] = [
      [0, 0, 1],
      [0, 0, -1],
      [1, 2, 3],
      [-3, 0.5, -0.2],
      [0, 1, 0],
    ];
    for (const a of dirs)
      for (const b of dirs) {
        const r = rotationBetween(a, b);
        const got = transformDirection3(r, a);
        const l = Math.hypot(...a) / Math.hypot(...b);
        expectVec(got, [b[0] * l, b[1] * l, b[2] * l], 9);
        expect(determinant4(r)).toBeCloseTo(1, 9);
      }
    expect(rotationBetween([0, 0, 0], [1, 0, 0])).toEqual(I);
  });

  it('trackRotation points the track axis at the direction with the up axis towards world up', () => {
    const tracks: TrackAxis[] = ['X', 'Y', 'Z', '-X', '-Y', '-Z'];
    const ups: UpAxis[] = ['X', 'Y', 'Z'];
    const dir: Vec3 = [3, -2, 1];
    const d = dir.map((v) => v / Math.hypot(...dir));
    for (const t of tracks)
      for (const u of ups) {
        const m = trackRotation(dir, t, u);
        if (t.endsWith(u)) {
          expect(m).toBeNull();
          continue;
        }
        expect(m).not.toBeNull();
        const ti = 'XYZ'.indexOf(t.slice(-1));
        const sign = t.startsWith('-') ? -1 : 1;
        expectVec(
          col(m!, ti).map((v) => v * sign),
          d,
          9,
        );
        const up = col(m!, 'XYZ'.indexOf(u));
        expect(up[2]).toBeGreaterThan(0);
        expect(up[0] * d[0] + up[1] * d[1] + up[2] * d[2]).toBeCloseTo(0, 9);
        expect(determinant4(m!)).toBeCloseTo(1, 9);
      }
    // a camera (-Z, up Y) looking straight down keeps the fallback heading
    const down = trackRotation([0, 0, -1], '-Z', 'Y', [0, 0, 1], [1, 0, 0])!;
    expectVec(col(down, 2), [0, 0, 1]);
    expectVec(col(down, 1), [1, 0, 0]);
    expect(trackRotation([0, 0, 0], '-Z', 'Y')).toBeNull();
  });
});

describe('sampleSurface', () => {
  const grid = createGrid({ x_subdivisions: 4, y_subdivisions: 4, size: 10 });

  it('places seeded, deterministic points on the transformed surface with its normal', () => {
    const m = compose4([100, 0, 5], [0, 0, 0], [2, 1, 1]);
    const a = sampleSurface(grid, m, 200, 3);
    expect(a).toHaveLength(200);
    expect(sampleSurface(grid, m, 200, 3)).toEqual(a);
    expect(sampleSurface(grid, m, 200, 4)).not.toEqual(a);
    for (const s of a) {
      expect(s.point[0]).toBeGreaterThanOrEqual(90 - 1e-9);
      expect(s.point[0]).toBeLessThanOrEqual(110 + 1e-9);
      expect(Math.abs(s.point[1])).toBeLessThanOrEqual(5 + 1e-9);
      expect(s.point[2]).toBeCloseTo(5, 12);
      expectVec(s.normal, [0, 0, 1]);
      expect(s.face).toBeGreaterThanOrEqual(0);
    }
    // area-uniform: both halves of the plane get about half of the points
    const left = sampleSurface(grid, I, 4000, 9).filter((s) => s.point[0] < 0).length;
    expect(left / 4000).toBeGreaterThan(0.45);
    expect(left / 4000).toBeLessThan(0.55);
  });

  it('keeps a minimum distance (returning fewer points when the surface is full)', () => {
    const pts = sampleSurface(grid, I, 500, 1, { minDistance: 1.5 });
    expect(pts.length).toBeGreaterThan(20);
    expect(pts.length).toBeLessThan(500);
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const [a, b] = [pts[i].point, pts[j].point];
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThanOrEqual(1.5);
      }
  });

  it('skips faces steeper than max_slope and handles empty or degenerate meshes', () => {
    const cube = createCube({ size: 2 });
    const top = sampleSurface(cube, I, 50, 2, { maxSlope: 0.1 });
    expect(top).toHaveLength(50);
    for (const s of top) expect(s.point[2]).toBeCloseTo(1, 12);
    const all = sampleSurface(cube, I, 300, 2);
    expect(new Set(all.map((s) => s.face)).size).toBe(6);
    expect(sampleSurface(createMesh(), I, 10, 0)).toEqual([]);
    expect(sampleSurface(cube, I, 0, 0)).toEqual([]);
    expect(sampleSurface(cube, I, NaN, 0)).toEqual([]);
    const flat = createMesh({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], faces: [[0, 1, 2]] });
    expect(sampleSurface(flat, I, 5, 0)).toEqual([]);
  });
});

describe('SceneRaycaster', () => {
  it('hits the nearest face with world-space point, normal, distance and side', () => {
    const rc = new SceneRaycaster([target(createCube({ size: 2 }))]);
    const hit = rc.cast([0.2, 0.3, 10], [0, 0, -5])!;
    expect(hit.distance).toBeCloseTo(9, 12);
    expectVec(hit.point, [0.2, 0.3, 1]);
    expectVec(hit.normal, [0, 0, 1]);
    expect(hit.front).toBe(true);
    expect(hit.target.id).toBe('T');
    const inside = rc.cast([0, 0, 0], [1, 0, 0])!;
    expectVec(inside.normal, [1, 0, 0]);
    expect(inside.front).toBe(false);
    expect(rc.cast([5, 5, 5], [0, 0, -1])).toBeNull();
    expect(rc.cast([0, 0, 10], [0, 0, -1], 8)).toBeNull();
    expect(rc.cast([0, 0, 10], [0, 0, 0])).toBeNull();
    expect(rc.cast([NaN, 0, 10], [0, 0, -1])).toBeNull();
    expect(rc.cast([0, 0, 10], [0, 0, -1], Infinity, { skip: () => true })).toBeNull();
    const both = rc.castAll([0.1, 0.1, 10], [0, 0, -1]);
    expect(both.map((h) => h.distance)).toEqual([expect.closeTo(9, 9), expect.closeTo(11, 9)]);
  });

  it('casts through rotated, scaled, translated and mirrored transforms (outward normals)', () => {
    const m = compose4([5, 0, 0], [0, 0, Math.PI / 4], [2, 1, 3]);
    const rc = new SceneRaycaster([target(createCube({ size: 2 }), m)]);
    const top = rc.cast([5, 0, 20], [0, 0, -1])!;
    expect(top.point[2]).toBeCloseTo(3, 9);
    expectVec(top.normal, [0, 0, 1]);
    const side = rc.cast([20, 0, 0], [-1, 0, 0])!;
    // along y = 0 the ray enters through the box's −Y face (local Y = −1), which faces (1, −1, 0)/√2
    expectVec(side.normal, [Math.SQRT1_2, -Math.SQRT1_2, 0], 6);
    expect(side.point[0]).toBeCloseTo(5 + Math.SQRT2, 9);
    const end = rc.cast([5 + 20 * Math.SQRT1_2, 20 * Math.SQRT1_2, 0], [-1, -1, 0])!;
    expectVec(end.normal, [Math.SQRT1_2, Math.SQRT1_2, 0], 6); // the +X face along the box's long axis
    expect(end.point[0]).toBeCloseTo(5 + 2 * Math.SQRT1_2, 9);
    const mirrored = new SceneRaycaster([
      target(createCube({ size: 2 }), compose4([0, 0, 0], [0, 0, 0], [-1, 1, 1])),
    ]);
    const mh = mirrored.cast([10, 0, 0], [-1, 0, 0])!;
    expectVec(mh.normal, [1, 0, 0]);
    expect(mh.front).toBe(true);
    // singular (zero scale) and non-finite transforms are ignored
    const flat = new SceneRaycaster([target(createCube(), compose4([0, 0, 0], [0, 0, 0], [1, 1, 0]))]);
    expect(flat.size).toBe(0);
    expect(new SceneRaycaster([target(createCube(), [NaN, ...I.slice(1)])]).size).toBe(0);
  });

  it('picks the nearest of several targets', () => {
    const rc = new SceneRaycaster([
      target(createCube(), compose4([0, 0, 0], [0, 0, 0], [1, 1, 1]), 'low'),
      target(createCube(), compose4([0, 0, 5], [0, 0, 0], [1, 1, 1]), 'high'),
    ]);
    expect(rc.cast([0, 0, 20], [0, 0, -1])!.target.id).toBe('high');
    expect(rc.cast([0, 0, 20], [0, 0, -1], Infinity, { skip: (t) => t.id === 'high' })!.target.id).toBe(
      'low',
    );
    expect(rc.bounds()).toEqual({ min: [-1, -1, -1], max: [1, 1, 6] });
  });
});

describe('computeDrop', () => {
  const box = (at: Vec3, size = 1) => worldPoints(createCube({ size }), compose4(at, [0, 0, 0], [1, 1, 1]));
  const geometry = (at: Vec3, size = 1) =>
    new SceneRaycaster([target(createCube({ size }), compose4(at, [0, 0, 0], [1, 1, 1]), 'self')]);

  it('drops onto the ground plane and lifts geometry sunk below it', () => {
    const none = new SceneRaycaster([]);
    expect(computeDrop(box([0, 0, 5]), null, none, true)!.dz).toBeCloseTo(-4.5, 12);
    const up = computeDrop(box([0, 0, 0.2]), null, none, true)!;
    expect(up.dz).toBeCloseTo(0.3, 12);
    expect(up.target).toBeNull();
    expectVec(up.normal, [0, 0, 1]);
    expect(computeDrop(box([0, 0, 5]), null, none, false)).toBeNull();
    expect(computeDrop(box([0, 0, -5]), null, none, true)).toBeNull(); // entirely below the plane
  });

  it('rests on the first surface below the top of the geometry, ignoring surfaces above it', () => {
    const floor = target(createGrid({ x_subdivisions: 2, y_subdivisions: 2, size: 20 }), I, 'floor');
    const table = target(
      createGrid({ x_subdivisions: 1, y_subdivisions: 1, size: 4 }),
      compose4([0, 0, 1], [0, 0, 0], [1, 1, 1]),
      'table',
    );
    const rc = new SceneRaycaster([floor, table]);
    // a box under the table top drops to the floor
    const under = computeDrop(box([0, 0, 0.6], 0.5), geometry([0, 0, 0.6], 0.5), rc, true)!;
    expect(under.dz).toBeCloseTo(-0.35, 9);
    expect(under.target!.id).toBe('floor');
    // a box above the table lands on it
    const over = computeDrop(box([0, 0, 3], 0.5), geometry([0, 0, 3], 0.5), rc, true)!;
    expect(over.dz).toBeCloseTo(1 - 2.75, 9);
    expect(over.target!.id).toBe('table');
    // a box sunk into the table top is lifted onto it
    const sunk = computeDrop(box([0, 0, 1.1], 0.5), geometry([0, 0, 1.1], 0.5), rc, true)!;
    expect(sunk.dz).toBeCloseTo(0.15, 9);
  });

  it('finds peaks between the vertices of the dropped geometry (reverse rays)', () => {
    // a cone tip under the middle of a wide box: no box vertex is above the cone
    const cone = target(
      createCone({ radius1: 1, radius2: 0, depth: 2, vertices: 16 }),
      compose4([0, 0, 1], [0, 0, 0], [1, 1, 1]),
      'cone',
    );
    const rc = new SceneRaycaster([cone]);
    const at: Vec3 = [0, 0, 6];
    const withReverse = computeDrop(box(at, 4), geometry(at, 4), rc, true)!;
    expect(withReverse.target!.id).toBe('cone');
    expect(withReverse.dz).toBeCloseTo(2 - 4, 9); // box bottom (z = 4) onto the tip (z = 2)
    const vertsOnly = computeDrop(box(at, 4), null, rc, true)!;
    expect(vertsOnly.dz).toBeCloseTo(-4, 9); // without them it would fall through to the plane
  });

  it('drops a single point (origin) and skips non-finite points', () => {
    const rc = new SceneRaycaster([target(createCube({ size: 2 }), I, 'cube')]);
    const r = computeDrop([0.5, 0.5, 4, NaN, 0, 0], null, rc, false)!;
    expect(r.dz).toBeCloseTo(-3, 12);
    expectVec(r.point, [0.5, 0.5, 1]);
    expect(computeDrop([], null, rc, true)).toBeNull();
  });
});

describe('meshDistance', () => {
  it('measures the closest surface distance, and 0 for crossing meshes', () => {
    const a = { mesh: createCube({ size: 1 }), matrix: I };
    const b = { mesh: createCube({ size: 1 }), matrix: compose4([3, 0.2, 0], [0, 0, 0], [1, 1, 1]) };
    const d = meshDistance(a, b)!;
    expect(d.distance).toBeCloseTo(2, 9);
    expect(d.intersecting).toBe(false);
    expect(d.pointA[0]).toBeCloseTo(0.5, 9);
    expect(d.pointB[0]).toBeCloseTo(2.5, 9);
    const c = {
      mesh: createCube({ size: 1 }),
      matrix: compose4([0.7, 0.3, 0.1], [0.3, 0.2, 0.1], [1, 1, 1]),
    };
    const x = meshDistance(a, c)!;
    expect(x.distance).toBe(0);
    expect(x.intersecting).toBe(true);
    // a cone tip pointing at a face between its vertices: vertex-to-surface distance finds it
    const cone = {
      mesh: createCone({ radius1: 0.2, radius2: 0, depth: 1 }),
      matrix: compose4([0, 0, -1.25], [Math.PI, 0, 0], [1, 1, 1]),
    };
    expect(meshDistance(a, cone)!.distance).toBeCloseTo(0.25, 9);
    expect(meshDistance(a, { mesh: createMesh(), matrix: I })).toBeNull();
  });
});
