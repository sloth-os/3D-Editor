import { describe, expect, it } from 'vitest';
import { createMesh, createGrid, createCube, createUVSphere, type MeshData } from '../src';
import { compose4, invert4 } from '../src/math/mat4';
import type { Mat4 } from '../src/math/types';
import {
  buildBVH,
  bvhStats,
  meshGeometry,
  SceneIntersector,
  type MeshGeometry,
} from '../src/render/pathtrace';
import type { SceneInstances } from '../src/render/pathtrace';
import { rng } from './pathtrace-helpers';

// ---------------------------------------------------------------- helpers

function triangleSoup(n: number, seed: number, spread = 4, size = 0.6): MeshData {
  const r = rng(seed);
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < n; i++) {
    const cx = (r() - 0.5) * spread;
    const cy = (r() - 0.5) * spread;
    const cz = (r() - 0.5) * spread;
    for (let k = 0; k < 3; k++)
      positions.push(cx + (r() - 0.5) * size, cy + (r() - 0.5) * size, cz + (r() - 0.5) * size);
    faces.push([i * 3, i * 3 + 1, i * 3 + 2]);
  }
  return createMesh({ positions, faces });
}

/** Instances data for meshes with world matrices. */
function instancesOf(
  geoms: MeshGeometry[],
  mats: Mat4[],
  geomOf: number[],
): SceneInstances & { boxes: Float64Array } {
  const n = mats.length;
  const xform = new Float64Array(n * 12);
  const inv = new Float64Array(n * 12);
  const boxes = new Float64Array(n * 6);
  const cols = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
  mats.forEach((M, i) => {
    const I = invert4(M);
    cols.forEach((c, k) => {
      xform[i * 12 + k] = M[c];
      inv[i * 12 + k] = I[c];
    });
    const b = geoms[geomOf[i]].bounds;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = [c & 1 ? b[3] : b[0], c & 2 ? b[4] : b[1], c & 4 ? b[5] : b[2]];
      for (let a = 0; a < 3; a++) {
        const v = M[a] * p[0] + M[4 + a] * p[1] + M[8 + a] * p[2] + M[12 + a];
        lo[a] = Math.min(lo[a], v);
        hi[a] = Math.max(hi[a], v);
      }
    }
    boxes.set([...lo, ...hi], i * 6);
  });
  return { count: n, geom: Int32Array.from(geomOf), xform, inv, filtered: new Uint8Array(n), boxes };
}

/** Möller–Trumbore in double precision: t or Infinity. */
function rayTri(o: number[], d: number[], a: number[], b: number[], c: number[]): number {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-300) return Infinity;
  const inv = 1 / det;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 0 ? t : Infinity;
}

/** World-space triangle corners of instance i, triangle t. */
function worldTri(g: MeshGeometry, M: Mat4, t: number): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < 3; k++) {
    const x = g.verts[t * 9 + k * 3];
    const y = g.verts[t * 9 + k * 3 + 1];
    const z = g.verts[t * 9 + k * 3 + 2];
    out.push([0, 1, 2].map((a) => M[a] * x + M[4 + a] * y + M[8 + a] * z + M[12 + a]));
  }
  return out;
}

function randomRay(r: () => number, spread: number): { o: number[]; d: number[] } {
  const o = [(r() - 0.5) * spread * 2, (r() - 0.5) * spread * 2, (r() - 0.5) * spread * 2];
  // aim near the centre so most rays hit something
  const target = [(r() - 0.5) * spread * 0.6, (r() - 0.5) * spread * 0.6, (r() - 0.5) * spread * 0.6];
  const d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return { o, d: d.map((v) => v / l) };
}

// ---------------------------------------------------------------- BVH structure

describe('binned SAH BVH', () => {
  it('covers every primitive exactly once with nested bounds', () => {
    const r = rng(7);
    const n = 3000;
    const boxes = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) {
      const c = [r() * 10, r() * 10, r() * 2];
      const s = [r() * 0.3, r() * 0.3, r() * 0.3];
      boxes.set([c[0] - s[0], c[1] - s[1], c[2] - s[2], c[0] + s[0], c[1] + s[1], c[2] + s[2]], i * 6);
    }
    const bvh = buildBVH(boxes, n, 4);
    const seen = new Uint8Array(n);
    const stack = [0];
    let maxDepth = 0;
    const depthOf = new Map<number, number>([[0, 0]]);
    while (stack.length) {
      const node = stack.pop()!;
      const d = depthOf.get(node)!;
      maxDepth = Math.max(maxDepth, d);
      const nb = bvh.bounds.subarray(node * 6, node * 6 + 6);
      if (bvh.count[node] > 0) {
        expect(bvh.count[node]).toBeLessThanOrEqual(4);
        for (let k = bvh.child[node]; k < bvh.child[node] + bvh.count[node]; k++) {
          const p = bvh.prims[k];
          seen[p]++;
          for (let a = 0; a < 3; a++) {
            expect(boxes[p * 6 + a]).toBeGreaterThanOrEqual(nb[a]);
            expect(boxes[p * 6 + 3 + a]).toBeLessThanOrEqual(nb[3 + a]);
          }
        }
      } else {
        for (const c of [bvh.child[node], bvh.child[node] + 1]) {
          const cb = bvh.bounds.subarray(c * 6, c * 6 + 6);
          for (let a = 0; a < 3; a++) {
            expect(cb[a]).toBeGreaterThanOrEqual(nb[a]);
            expect(cb[3 + a]).toBeLessThanOrEqual(nb[3 + a]);
          }
          depthOf.set(c, d + 1);
          stack.push(c);
        }
      }
    }
    expect([...seen].every((v) => v === 1)).toBe(true);
    expect(bvh.depth).toBe(maxDepth);
    expect(bvhStats(bvh).depth).toBe(maxDepth);
    // SAH keeps it shallow for uniformly spread boxes
    expect(maxDepth).toBeLessThan(40);
  });

  it('handles empty input, a single primitive and identical centroids', () => {
    const empty = buildBVH(new Float64Array(0), 0);
    expect(empty.nodeCount).toBe(1);
    expect(empty.count[0]).toBe(0);
    const one = buildBVH(new Float64Array([0, 0, 0, 1, 1, 1]), 1);
    expect(one.count[0]).toBe(1);
    const n = 100;
    const same = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) same.set([0, 0, 0, 1, 1, 1], i * 6);
    const bvh = buildBVH(same, n, 4);
    const st = bvhStats(bvh);
    expect(st.maxLeafSize).toBeLessThanOrEqual(4);
    expect(st.leaves).toBeGreaterThanOrEqual(n / 4);
  });
});

// ---------------------------------------------------------------- mesh geometry

describe('mesh geometry (BLAS)', () => {
  it('is cached per mesh, keeps smooth flags, UVs and colours, and drops degenerate triangles', () => {
    const cube = createCube({ size: 2 });
    const g = meshGeometry(cube);
    expect(meshGeometry(cube)).toBe(g);
    expect(g.triCount).toBe(12);
    expect([...g.smooth].every((s) => s === 0)).toBe(true);
    expect(g.bounds[0]).toBeCloseTo(-1);
    expect(g.bounds[5]).toBeCloseTo(1);
    const sphere = createUVSphere({ segments: 12, ring_count: 6 });
    sphere.faceSmooth = sphere.faceSmooth.map(() => true);
    const gs = meshGeometry(sphere);
    expect([...gs.smooth].some((s) => s === 1)).toBe(true);
    expect(gs.uvs).not.toBeNull();
    const bad = createMesh({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, 2, 0, 0, 3, 0, 0],
      faces: [
        [0, 1, 2],
        [3, 1, 2],
        [0, 4, 5],
      ],
      colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });
    const gb = meshGeometry(bad);
    expect(gb.triCount).toBe(1);
    expect(gb.skipped).toBe(2);
    expect(gb.colors).not.toBeNull();
  });
});

// ---------------------------------------------------------------- intersection

describe('two-level ray queries', () => {
  it('match brute force for random rays against a triangle soup', () => {
    const mesh = triangleSoup(600, 3);
    const g = meshGeometry(mesh);
    const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const inst = instancesOf([g], [I], [0]);
    const tlas = buildBVH(inst.boxes, 1, 2);
    const isect = new SceneIntersector([g], inst, tlas);
    const r = rng(11);
    let hits = 0;
    for (let k = 0; k < 2000; k++) {
      const { o, d } = randomRay(r, 4);
      let best = Infinity;
      let bestTri = -1;
      for (let t = 0; t < g.triCount; t++) {
        const tt = rayTri(o, d, ...(worldTri(g, I, t) as [number[], number[], number[]]));
        if (tt < best) {
          best = tt;
          bestTri = t;
        }
      }
      const hit = isect.intersect(o[0], o[1], o[2], d[0], d[1], d[2], Infinity);
      expect(hit).toBe(best < Infinity);
      if (!hit) continue;
      hits++;
      expect(isect.t).toBeCloseTo(best, 9);
      if (isect.tri !== bestTri) {
        // only acceptable when two triangles are hit at (numerically) the same distance
        const other = rayTri(o, d, ...(worldTri(g, I, isect.tri) as [number[], number[], number[]]));
        expect(Math.abs(other - best)).toBeLessThan(1e-9);
      }
      // barycentrics reproduce the hit point
      const [a, b, c] = worldTri(g, I, isect.tri);
      const b0 = 1 - isect.b1 - isect.b2;
      for (let ax = 0; ax < 3; ax++)
        expect(b0 * a[ax] + isect.b1 * b[ax] + isect.b2 * c[ax]).toBeCloseTo(o[ax] + d[ax] * isect.t, 7);
      // occlusion agrees with tMax just before and after the hit
      expect(isect.occluded(o[0], o[1], o[2], d[0], d[1], d[2], best * 1.001)).toBe(true);
      expect(isect.occluded(o[0], o[1], o[2], d[0], d[1], d[2], best * 0.999)).toBe(false);
    }
    expect(hits).toBeGreaterThan(300);
  });

  it('match brute force with rotated, non-uniformly scaled, mirrored and shared instances', () => {
    const meshes = [triangleSoup(200, 5, 2, 0.5), createUVSphere({ segments: 16, ring_count: 8 })];
    const geoms = meshes.map(meshGeometry);
    const r = rng(19);
    const mats: Mat4[] = [];
    const geomOf: number[] = [];
    for (let i = 0; i < 12; i++) {
      mats.push(
        compose4(
          [(r() - 0.5) * 6, (r() - 0.5) * 6, (r() - 0.5) * 6],
          [r() * 6, r() * 6, r() * 6],
          [(0.4 + r()) * (i % 3 === 0 ? -1 : 1), 0.4 + r() * 1.5, 0.4 + r()],
        ),
      );
      geomOf.push(i % 2);
    }
    const inst = instancesOf(geoms, mats, geomOf);
    const tlas = buildBVH(inst.boxes, mats.length, 2);
    const isect = new SceneIntersector(geoms, inst, tlas);
    let hits = 0;
    for (let k = 0; k < 1500; k++) {
      const { o, d } = randomRay(r, 5);
      let best = Infinity;
      let bestInst = -1;
      for (let i = 0; i < mats.length; i++) {
        const g = geoms[geomOf[i]];
        for (let t = 0; t < g.triCount; t++) {
          const tt = rayTri(o, d, ...(worldTri(g, mats[i], t) as [number[], number[], number[]]));
          if (tt < best) {
            best = tt;
            bestInst = i;
          }
        }
      }
      const hit = isect.intersect(o[0], o[1], o[2], d[0], d[1], d[2], Infinity);
      expect(hit).toBe(best < Infinity);
      if (!hit) continue;
      hits++;
      expect(isect.t).toBeCloseTo(best, 8);
      if (isect.inst !== bestInst) expect(Math.abs(isect.t - best)).toBeLessThan(1e-8);
    }
    expect(hits).toBeGreaterThan(200);
  }, 30_000);

  it('is watertight: rays through shared vertices and edges never slip through', () => {
    const grid = createGrid({ x_subdivisions: 12, y_subdivisions: 12, size: 2 } as never);
    const g = meshGeometry(grid);
    const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const inst = instancesOf([g], [I], [0]);
    const isect = new SceneIntersector([g], inst, buildBVH(inst.boxes, 1, 2));
    const r = rng(23);
    let tested = 0;
    // every grid vertex and edge midpoint, from random directions above the plane
    const pts: number[][] = [];
    for (let t = 0; t < g.triCount; t++)
      for (let k = 0; k < 3; k++) {
        const a = [0, 1, 2].map((c) => g.verts[t * 9 + k * 3 + c]);
        const b = [0, 1, 2].map((c) => g.verts[t * 9 + ((k + 1) % 3) * 3 + c]);
        pts.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      }
    for (const p of pts) {
      if (Math.abs(p[0]) > 0.999 || Math.abs(p[1]) > 0.999) continue; // skip the outer border
      const d = [(r() - 0.5) * 1.2, (r() - 0.5) * 1.2, -1];
      const l = Math.hypot(d[0], d[1], d[2]);
      const o = [p[0] - (d[0] / l) * 3, p[1] - (d[1] / l) * 3, p[2] - (d[2] / l) * 3];
      expect(isect.intersect(o[0], o[1], o[2], d[0] / l, d[1] / l, d[2] / l, Infinity)).toBe(true);
      expect(isect.t).toBeCloseTo(3, 9);
      tested++;
    }
    expect(tested).toBeGreaterThan(500);
    // cube corners and edges seen along the diagonals
    const cube = meshGeometry(createCube({ size: 2 }));
    const ci = instancesOf([cube], [I], [0]);
    const ic = new SceneIntersector([cube], ci, buildBVH(ci.boxes, 1, 2));
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const o = [sx * 4, sy * 4, sz * 4];
          const d = [-sx, -sy, -sz].map((v) => v / Math.sqrt(3));
          expect(ic.intersect(o[0], o[1], o[2], d[0], d[1], d[2], Infinity)).toBe(true);
          expect(ic.t).toBeCloseTo(3 * Math.sqrt(3), 9);
        }
  });

  it('reports no hit for empty scenes, degenerate directions and rays behind or beyond tMax', () => {
    const empty: SceneInstances = {
      count: 0,
      geom: new Int32Array(0),
      xform: new Float64Array(0),
      inv: new Float64Array(0),
      filtered: new Uint8Array(0),
    };
    const isect = new SceneIntersector([], empty, buildBVH(new Float64Array(0), 0));
    expect(isect.intersect(0, 0, 0, 0, 0, 1, Infinity)).toBe(false);
    expect(isect.occluded(0, 0, 0, 0, 0, 1, Infinity)).toBe(false);
    const g = meshGeometry(createCube({ size: 2 }));
    const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const inst = instancesOf([g], [I], [0]);
    const ic = new SceneIntersector([g], inst, buildBVH(inst.boxes, 1, 2));
    expect(ic.intersect(0, 0, 5, 0, 0, 0, Infinity)).toBe(false);
    expect(ic.intersect(0, 0, 5, NaN, 0, -1, Infinity)).toBe(false);
    expect(ic.intersect(0, 0, 5, 0, 0, 1, Infinity)).toBe(false);
    expect(ic.intersect(0, 0, 5, 0, 0, -1, 3.9)).toBe(false);
    expect(ic.intersect(0, 0, 5, 0, 0, -1, 4.1)).toBe(true);
    // axis-aligned ray exactly in the plane of a face still finds the cube
    expect(ic.intersect(-5, 1, 0, 1, 0, 0, Infinity)).toBe(true);
    expect(ic.t).toBeCloseTo(4, 9);
  });

  it('filters transparent surfaces on occlusion rays through the shadow callback', () => {
    const plane = meshGeometry(createGrid({ x_subdivisions: 1, y_subdivisions: 1, size: 2 } as never));
    const mats: Mat4[] = [0, 1].map((k) => compose4([0, 0, k], [0, 0, 0], [1, 1, 1]));
    const inst = instancesOf([plane], mats, [0, 0]);
    inst.filtered[0] = 1;
    inst.filtered[1] = 1;
    const isect = new SceneIntersector([plane], inst, buildBVH(inst.boxes, 2, 2));
    let calls = 0;
    isect.shadowFilter = () => {
      calls++;
      return 0.5;
    };
    expect(isect.occluded(0.1, 0.2, 5, 0, 0, -1, 10)).toBe(false);
    expect(isect.transmittance).toBeCloseTo(0.25, 12);
    expect(calls).toBe(2);
    isect.shadowFilter = () => 0;
    expect(isect.occluded(0.1, 0.2, 5, 0, 0, -1, 10)).toBe(true);
    // closest-hit queries are not filtered
    isect.shadowFilter = () => 1;
    expect(isect.intersect(0.1, 0.2, 5, 0, 0, -1, 10)).toBe(true);
    expect(isect.t).toBeCloseTo(4, 9);
  });
});
