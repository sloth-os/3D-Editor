import { describe, expect, it } from 'vitest';
import { computeEnvelopeWeights, computeHeatWeights, type WeightBone } from '../src/armature/weights';
import { FacingOccluder } from '../src/armature/occlusion';
import { SparseLDL, nestedDissectionOrder } from '../src/armature/sparse';
import { createGrid } from '../src/mesh/primitives';
import { triangulateMesh } from '../src/mesh/triangulate';
import { appendMesh, createMesh, type MeshData } from '../src/mesh/types';
import { tube } from './armature-helpers';
import { cpuMs } from './timing-helpers';

const RINGS = 21;
const SEG = 12;

const twoBones: WeightBone[] = [
  { name: 'Lower', head: [0, 0, 0], tail: [0, 0, 1] },
  { name: 'Upper', head: [0, 0, 1], tail: [0, 0, 2] },
];

function sums(weights: Float32Array[], n: number): number[] {
  return Array.from({ length: n }, (_, v) => weights.reduce((s, w) => s + w[v], 0));
}

/**
 * Closed tube (outward normals, 12 segments) along +X from x0 to x0 + length around the line
 * y = 0, z = zc. Vertex i of ring r has index r * 12 + i; i = 6 is the top (largest z).
 */
function tubeAlongX(x0: number, length: number, zc: number, radius: number, rings: number): MeshData {
  const m = tube(rings, 12, radius, length);
  // rotation about Y taking +Z to +X, (x, y, z) → (z, y, -x): keeps the normals pointing out
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    p[i] = p[i + 2] + x0;
    p[i + 2] = zc - x;
  }
  return m;
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

  it('ignores bones hidden behind the front faces of other parts of the mesh', () => {
    // Two closed tubes along X: "A" (x -1..1, z 0..0.2) whose bone sits at its left end, and "B"
    // below the right end of A with its bone inside. The top of A's right end is much nearer to B's
    // bone than to A's, but B's surface faces it and hides that bone, so all of A stays on bone A.
    const bones: WeightBone[] = [
      { name: 'A', head: [-0.95, 0, 0.1], tail: [-0.75, 0, 0.1] },
      { name: 'B', head: [0.55, 0, -0.35], tail: [0.95, 0, -0.35] },
    ];
    const partA = tubeAlongX(-1, 2, 0.1, 0.1, 41);
    const nA = partA.positions.length / 3;
    const mesh: MeshData = createMesh();
    appendMesh(mesh, partA);
    appendMesh(mesh, tubeAlongX(0.5, 0.5, -0.35, 0.15, 11));
    const { weights, warnings } = computeHeatWeights(mesh, bones);
    expect(warnings).toEqual([]);
    for (let v = 0; v < nA; v++) expect(weights[0][v]).toBeCloseTo(1, 5);
    for (let v = nA; v < mesh.positions.length / 3; v++) expect(weights[1][v]).toBeCloseTo(1, 5);
    // without B's surface nothing hides bone B: the top of A's right end follows it
    const alone = computeHeatWeights(partA, bones).weights;
    const topOfRightEnd = 40 * 12 + 6;
    expect(alone[1][topOfRightEnd]).toBeGreaterThan(0.5);
  });

  it('lets back faces through: the inner wall of a double-walled sleeve does not hide its bone', () => {
    // solidified tube: outer wall (normals out) and inner wall (normals in), joined at both rims
    const rings = 41;
    const segs = 16;
    const positions: number[] = [];
    for (const r of [0.3, 0.25])
      for (let k = 0; k < rings; k++)
        for (let i = 0; i < segs; i++) {
          const a = (2 * Math.PI * i) / segs;
          positions.push(r * Math.cos(a), r * Math.sin(a), (2 * k) / (rings - 1));
        }
    const off = rings * segs;
    const faces: number[][] = [];
    for (let k = 0; k + 1 < rings; k++)
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % segs;
        faces.push([k * segs + i, k * segs + j, (k + 1) * segs + j, (k + 1) * segs + i]);
        faces.push([
          off + k * segs + i,
          off + (k + 1) * segs + i,
          off + (k + 1) * segs + j,
          off + k * segs + j,
        ]);
      }
    const top = (rings - 1) * segs;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      faces.push([i, off + i, off + j, j]);
      faces.push([top + i, top + j, off + top + j, off + top + i]);
    }
    const { weights, warnings } = computeHeatWeights(createMesh({ positions, faces }), twoBones);
    expect(warnings).toEqual([]);
    const ringLower = (k: number) => {
      let s = 0;
      for (let i = 0; i < segs; i++) s += weights[0][k * segs + i];
      return s / segs;
    };
    expect(ringLower(4)).toBeGreaterThan(0.85); // outer wall around bone Lower
    expect(ringLower(36)).toBeLessThan(0.15); // outer wall around bone Upper
  });

  it('stays fast when parts of the mesh cannot see their bones (a layer enclosing another)', () => {
    // body tube (z 0..6) with a closed "clothing" shell around it in the same mesh: the body hides
    // every bone (z 0.15..5.85, inside the body) from the shell, which costs one ray per vertex and
    // binds to the nearest bones
    const body = tube(81, 32, 0.25, 6);
    const shell = tube(81, 32, 0.35, 6.2, { z0: -0.1 });
    const both: MeshData = createMesh();
    appendMesh(both, body);
    appendMesh(both, shell);
    const [z0, len] = [0.15, 5.7 / 40];
    const bones: WeightBone[] = Array.from({ length: 40 }, (_, i) => ({
      name: `B${i}`,
      head: [0, 0, z0 + len * i],
      tail: [0, 0, z0 + len * (i + 1)],
    }));
    computeHeatWeights(body, bones); // warm up
    // CPU time, so that a busy machine slows neither measurement: the ratio was 1.4 to 2.2; ray
    // testing every bone for each vertex of the shell (the old code) made it 7.5 to 8.4, and 18 to
    // 21 under coverage
    let t = cpuMs();
    computeHeatWeights(body, bones);
    const bodyMs = cpuMs() - t;
    t = cpuMs();
    const res = computeHeatWeights(both, bones);
    const bothMs = cpuMs() - t;
    expect(bothMs).toBeLessThan(4 * bodyMs + 50);
    const nBody = body.positions.length / 3;
    const n = both.positions.length / 3;
    expect(res.warnings).toEqual([expect.stringContaining(`${n - nBody} vertices`)]);
    // the shell follows the bones at its height: the weighted mean height of its bones is close to
    // its own (the weights spread over several of these short bones, as heat decays over about the
    // distance to the bones)
    for (let v = nBody; v < n; v += 7) {
      let mean = 0;
      for (let k = 0; k < 40; k++) mean += res.weights[k][v] * (z0 + len * (k + 0.5));
      const z = Math.min(z0 + 40 * len, Math.max(z0, both.positions[v * 3 + 2]));
      expect(Math.abs(mean - z)).toBeLessThan(0.3);
    }
  }, 60000);

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
    // bones with invalid coordinates get no weights; the others are computed without them
    const broken = computeHeatWeights(wire, [
      twoBones[0],
      { name: 'Bad', head: [NaN, 0, 0], tail: [0, 0, 1] },
      twoBones[1],
    ]);
    expect(broken.warnings).toEqual(['bones with invalid head/tail coordinates get no weights: Bad']);
    expect(Array.from(broken.weights[1])).toEqual([0, 0, 0, 0]);
    const valid = computeHeatWeights(wire, twoBones).weights;
    expect(Array.from(broken.weights[0])).toEqual(Array.from(valid[0]));
    expect(Array.from(broken.weights[2])).toEqual(Array.from(valid[1]));
  });

  it('falls back to conjugate gradients for huge factors with the same result', () => {
    const mesh = tube(RINGS, SEG, 0.2, 2);
    const direct = computeHeatWeights(mesh, twoBones).weights;
    const iterative = computeHeatWeights(mesh, twoBones, { maxFactorSize: 0 }).weights;
    for (let j = 0; j < 2; j++)
      for (let v = 0; v < RINGS * SEG; v++) expect(iterative[j][v]).toBeCloseTo(direct[j][v], 4);
  });
});

describe('facing occluder (bone visibility)', () => {
  const closedTube = () => {
    const m = tube(9, 16, 0.5, 2);
    return new FacingOccluder(m.positions, triangulateMesh(m).indices);
  };

  it('never lets a ray slip through shared vertices or edges of a closed surface', () => {
    const occ = closedTube();
    // rays from outside towards the axis, exactly through every vertex and edge midpoint
    for (let r = 1; r < 8; r++)
      for (let i = 0; i < 32; i++) {
        const a = (Math.PI * i) / 16;
        const z = 0.25 * r + (i % 2 ? 0.125 : 0);
        const [x, y] = [0.8 * Math.cos(a), 0.8 * Math.sin(a)];
        expect(occ.blocked(x, y, z, -x, -y, 0, 1e-5, 1 - 1e-5)).toBe(true);
      }
  });

  it('is only blocked by front faces, inside the segment', () => {
    const occ = closedTube();
    // from the axis outwards: the walls are back faces
    expect(occ.blocked(0, 0, 1, 0.8, 0, 0, 1e-5, 1 - 1e-5)).toBe(false);
    // outside, but stopping before the wall (t < 0.375) or starting behind it
    expect(occ.blocked(0.8, 0, 1, -0.8, 0, 0, 1e-5, 0.3)).toBe(false);
    expect(occ.blocked(0.8, 0, 1, -0.8, 0, 0, 0.5, 1)).toBe(false);
    // a ray passing beside the tube
    expect(occ.blocked(0.8, 0.8, 1, 0, -1.6, 0, 0, 1)).toBe(false);
  });

  it('handles degenerate input', () => {
    expect(new FacingOccluder([], []).blocked(0, 0, 0, 1, 0, 0, 0, 1)).toBe(false);
    const occ = closedTube();
    expect(occ.blocked(0.8, 0, 1, 0, 0, 0, 0, 1)).toBe(false); // zero-length ray
    expect(occ.blocked(0.8, 0, 1, NaN, 0, 0, 0, 1)).toBe(false);
    // a degenerate (zero-area) triangle never blocks
    const flat = new FacingOccluder([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2]);
    expect(flat.blocked(1, 1, 0, 0, -2, 0, 0, 1)).toBe(false);
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
