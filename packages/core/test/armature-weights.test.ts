import { describe, expect, it } from 'vitest';
import { computeEnvelopeWeights, computeHeatWeights, type WeightBone } from '../src/armature/weights';
import { SparseLDL, nestedDissectionOrder } from '../src/armature/sparse';
import { createGrid } from '../src/mesh/primitives';
import { appendMesh, createMesh, type MeshData } from '../src/mesh/types';
import { tube } from './armature-helpers';

const RINGS = 21;
const SEG = 12;

const twoBones: WeightBone[] = [
  { name: 'Lower', head: [0, 0, 0], tail: [0, 0, 1] },
  { name: 'Upper', head: [0, 0, 1], tail: [0, 0, 2] },
];

function sums(weights: Float32Array[], n: number): number[] {
  return Array.from({ length: n }, (_, v) => weights.reduce((s, w) => s + w[v], 0));
}

describe('automatic (bone heat) weights', () => {
  it('sum to 1 per vertex and favour the nearest bone', () => {
    const mesh = tube(RINGS, SEG, 0.2, 2);
    const { weights, warnings } = computeHeatWeights(mesh, twoBones);
    expect(warnings).toEqual([]);
    const n = RINGS * SEG;
    for (const s of sums(weights, n)) expect(s).toBeCloseTo(1, 5);
    for (let r = 0; r < RINGS; r++)
      for (let i = 0; i < SEG; i++) {
        const v = r * SEG + i;
        const [lo, up] = [weights[0][v], weights[1][v]];
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(up).toBeGreaterThanOrEqual(0);
        if (r < 8) expect(lo).toBeGreaterThan(0.85);
        if (r > 12) expect(up).toBeGreaterThan(0.85);
        if (r === 10) expect(up).toBeCloseTo(0.5, 2);
        // rings are (up to the triangulation of the quads) symmetric around the axis
        expect(up).toBeCloseTo(weights[1][r * SEG], 3);
      }
    // smooth, monotonic transition along the tube
    for (let r = 1; r < RINGS; r++)
      expect(weights[1][r * SEG]).toBeGreaterThanOrEqual(weights[1][(r - 1) * SEG]);
    // deterministic
    const again = computeHeatWeights(mesh, twoBones).weights;
    expect(Array.from(again[1])).toEqual(Array.from(weights[1]));
  });

  it('does not depend on the mesh scale or resolution', () => {
    const coarse = computeHeatWeights(tube(11, 8, 0.2, 2), twoBones).weights[1];
    const fine = computeHeatWeights(tube(41, 24, 0.2, 2), twoBones).weights[1];
    const scaled = computeHeatWeights(
      tube(11, 8, 2, 20),
      twoBones.map(
        (b) => ({ ...b, head: b.head.map((x) => x * 10), tail: b.tail.map((x) => x * 10) }) as WeightBone,
      ),
    ).weights[1];
    for (let r = 0; r < 11; r++) {
      expect(coarse[r * 8]).toBeCloseTo(fine[r * 4 * 24], 1); // same height: ring 4r of 41
      expect(scaled[r * 8]).toBeCloseTo(coarse[r * 8], 5);
    }
  });

  it('ignores bones hidden behind other parts of the mesh', () => {
    // bottom sheet facing down (-Z) and a lid sheet at z = 0.5 above it; bone "Up" sits just above
    // the lid, much nearer to the bottom sheet than bone "Down" below it, but the lid hides it
    const bottom = createGrid({ x_subdivisions: 6, y_subdivisions: 6, size: 2 });
    bottom.faces = bottom.faces.map((f) => f.slice().reverse());
    const lid = createGrid({ x_subdivisions: 6, y_subdivisions: 6, size: 2 });
    lid.positions = lid.positions.map((v, i) => (i % 3 === 2 ? v + 0.5 : v));
    const mesh: MeshData = createMesh();
    appendMesh(mesh, bottom);
    const lidStart = mesh.positions.length / 3;
    appendMesh(mesh, lid);
    const bones: WeightBone[] = [
      { name: 'Down', head: [-1, 0, -0.9], tail: [1, 0, -0.9] },
      { name: 'Up', head: [-1, 0, 0.6], tail: [1, 0, 0.6] },
    ];
    const { weights } = computeHeatWeights(mesh, bones);
    for (let v = 0; v < lidStart; v++) expect(weights[0][v]).toBeCloseTo(1, 5);
    for (let v = lidStart; v < mesh.positions.length / 3; v++) expect(weights[1][v]).toBeCloseTo(1, 5);
  });

  it('handles loose vertices, edges, degenerate bones and empty input', () => {
    const wire = createMesh({ positions: [0, 0, 0, 0, 0, 1, 0, 0, 2, 5, 5, 5], looseEdges: [0, 1, 1, 2] });
    const bones: WeightBone[] = [...twoBones, { name: 'Point', head: [5, 5, 5], tail: [5, 5, 5] }];
    const { weights } = computeHeatWeights(wire, bones);
    for (const s of sums(weights, 4)) expect(s).toBeCloseTo(1, 5);
    expect(weights[0][0]).toBeGreaterThan(0.5);
    expect(weights[1][2]).toBeGreaterThan(0.5);
    expect(weights[2][3]).toBeCloseTo(1, 5); // isolated vertex on the zero-length bone
    for (const w of weights) for (const x of w) expect(Number.isFinite(x)).toBe(true);
    expect(computeHeatWeights(createMesh(), twoBones).weights.map((w) => w.length)).toEqual([0, 0]);
    expect(computeHeatWeights(wire, []).weights).toEqual([]);
  });

  it('falls back to conjugate gradients for huge factors with the same result', () => {
    const mesh = tube(RINGS, SEG, 0.2, 2);
    const direct = computeHeatWeights(mesh, twoBones).weights;
    const iterative = computeHeatWeights(mesh, twoBones, { maxFactorSize: 0 }).weights;
    for (let j = 0; j < 2; j++)
      for (let v = 0; v < RINGS * SEG; v++) expect(iterative[j][v]).toBeCloseTo(direct[j][v], 4);
  });
});

describe('envelope weights', () => {
  it('are 1 inside the envelope radius and fade out over the distance', () => {
    const pts = [0, 0, 0.5, 0.15, 0, 0.5, 0.3, 0, 0.5, 2, 0, 0.5];
    const [w] = computeEnvelopeWeights(pts, [
      { name: 'B', head: [0, 0, 0], tail: [0, 0, 1], headRadius: 0.1, tailRadius: 0.1, distance: 0.1 },
    ]);
    expect(w[0]).toBe(1);
    expect(w[1]).toBeCloseTo(1 - 0.05 ** 2 / 0.01, 5);
    expect(w[2]).toBe(0);
    expect(w[3]).toBe(0);
  });
});

describe('sparse LDLᵀ solver', () => {
  it('solves symmetric positive definite mesh systems', () => {
    const mesh = createGrid({ x_subdivisions: 30, y_subdivisions: 20, size: 3 });
    const n = mesh.positions.length / 3;
    // graph Laplacian of the grid + a positive diagonal shift
    const adj: Set<number>[] = Array.from({ length: n }, () => new Set());
    for (const f of mesh.faces)
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        adj[a].add(b);
        adj[b].add(a);
      }
    const rowStart = new Int32Array(n + 1);
    for (let v = 0; v < n; v++) rowStart[v + 1] = rowStart[v] + adj[v].size;
    const cols = new Int32Array(rowStart[n]);
    const vals = new Float64Array(rowStart[n]);
    const diag = new Float64Array(n);
    for (let v = 0; v < n; v++) {
      let k = rowStart[v];
      for (const u of adj[v]) {
        cols[k] = u;
        vals[k++] = -1;
      }
      diag[v] = adj[v].size + 0.01 * (1 + (v % 7));
    }
    const m = { rowStart, cols, vals, diag };
    const order = nestedDissectionOrder(m, mesh.positions, n);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    const ldl = SparseLDL.factor(m, order)!;
    expect(ldl).not.toBeNull();
    // nested dissection keeps the factor sparse (far below the dense n²/2)
    expect(ldl.nonzeros).toBeLessThan((n * n) / 20);
    const b = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.1);
    const x = ldl.solve(b);
    for (let v = 0; v < n; v++) {
      let s = diag[v] * x[v];
      for (let k = rowStart[v]; k < rowStart[v + 1]; k++) s += vals[k] * x[cols[k]];
      expect(s).toBeCloseTo(b[v], 8);
    }
    // not positive definite → null
    expect(SparseLDL.factor({ ...m, diag: new Float64Array(n).fill(-1) }, order)).toBeNull();
    // too large → null
    expect(SparseLDL.factor(m, order, 10)).toBeNull();
  });
});
