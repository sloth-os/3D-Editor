import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  countInconsistentEdges,
  faceIslands,
  isClosedManifold,
  meshBounds,
  validateMesh,
  type MeshData,
} from '../src';
import * as G from '../src/generate';

/*
 * Every procedural generator: structural validity, closed and outward-facing parts, determinism,
 * the effect of its parameters and robustness against degenerate input.
 */

/** Signed volume of every connected part of a mesh. */
function partVolumes(m: MeshData): number[] {
  const { islandOf, count } = faceIslands(m, buildTopology(m));
  const vol = new Array<number>(count).fill(0);
  const p = m.positions;
  m.faces.forEach((f, fi) => {
    const a = f[0] * 3;
    for (let i = 1; i + 1 < f.length; i++) {
      const b = f[i] * 3;
      const c = f[i + 1] * 3;
      vol[islandOf[fi]] +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
          p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6;
    }
  });
  return vol;
}

/** Valid mesh with slots for every material index (and closed, outward parts unless `open`). */
function expectValid(r: G.GeneratorResult, opts: { open?: boolean; minFaces?: number } = {}): MeshData {
  const m = r.mesh;
  expect(validateMesh(m)).toEqual([]);
  expect(m.faces.length).toBeGreaterThanOrEqual(opts.minFaces ?? 1);
  expect(m.uvs).not.toBeNull();
  expect(m.positions.every(Number.isFinite)).toBe(true);
  expect(r.materials.length).toBeGreaterThan(0);
  for (const mi of m.faceMaterials) {
    expect(Number.isInteger(mi)).toBe(true);
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(mi).toBeLessThan(r.materials.length);
  }
  for (const mat of r.materials) {
    expect(mat.name.length).toBeGreaterThan(0);
    expect(mat.base_color.every((c) => c >= 0 && c <= 1)).toBe(true);
  }
  if (!opts.open) {
    expect(isClosedManifold(m)).toBe(true);
    expect(countInconsistentEdges(m)).toBe(0);
    expect(G.signedVolume(m)).toBeGreaterThan(0);
    for (const v of partVolumes(m)) expect(v).toBeGreaterThan(0);
  }
  return m;
}

function bounds(m: MeshData) {
  const b = meshBounds(m)!;
  return { min: b.min, max: b.max, size: [0, 1, 2].map((k) => b.max[k] - b.min[k]) };
}

/** Every generator with a few parameter variants (all must be closed unless marked open). */
const CASES: [string, () => G.GeneratorResult, { open?: boolean }?][] = [
  ['terrain', () => G.generateTerrain({ subdivisions: 24 }), { open: true }],
  [
    'terrain solid island terraces',
    () => G.generateTerrain({ subdivisions: 24, solid: true, island_falloff: 1, terraces: 4 }),
  ],
  [
    'terrain ridged no zones',
    () => G.generateTerrain({ subdivisions: 16, noise_type: 'RIDGED', zones: false, solid: true }),
  ],
  ['rock', () => G.generateRock()],
  ['rock smooth round', () => G.generateRock({ roughness: 0, facets: 0, flat_bottom: false, detail: 2 })],
  ['tree deciduous', () => G.generateTree({ branch_levels: 2 })],
  ['tree conifer', () => G.generateTree({ style: 'CONIFER' })],
  ['tree palm', () => G.generateTree({ style: 'PALM' })],
  ['tree bare', () => G.generateTree({ leaf_density: 0, branch_levels: 1 })],
  ['bush', () => G.generateBush()],
  ['grass tuft', () => G.generateGrassTuft()],
  ['flower', () => G.generateFlower()],
  ['building gable', () => G.generateBuilding()],
  ['building flat', () => G.generateBuilding({ roof: 'FLAT', floors: 5 })],
  ['building hip', () => G.generateBuilding({ roof: 'HIP', width: 8, depth: 12, window_rows: 2 })],
  ['building hip square', () => G.generateBuilding({ roof: 'HIP', width: 8, depth: 8 })],
  [
    'building no windows no door',
    () => G.generateBuilding({ window_cols: 0, window_cols_side: 0, door: false }),
  ],
  ['stairs straight', () => G.generateStairs()],
  ['stairs slab railing', () => G.generateStairs({ solid: false, railing: true })],
  ['stairs spiral', () => G.generateStairs({ style: 'SPIRAL', railing: true, clockwise: true })],
  ['fence picket', () => G.generateFence()],
  [
    'fence rail closed path',
    () =>
      G.generateFence({
        style: 'RAIL',
        points: [
          [0, 0],
          [3, 0, 0.5],
          [3, 4, 1],
        ],
        closed: true,
      }),
  ],
  ['pipe', () => G.generatePipe()],
  ['pipe hollow', () => G.generatePipe({ thickness: 0.03 })],
  ['pipe sharp', () => G.generatePipe({ bend_radius: 0 })],
  ['pipe cyclic', () => G.generatePipe({ cyclic: true })],
  ['table', () => G.generateTable()],
  ['table round', () => G.generateTable({ shape: 'ROUND' })],
  ['chair slats', () => G.generateChair()],
  ['chair panel', () => G.generateChair({ back_style: 'PANEL' })],
  ['shelf', () => G.generateShelf()],
  ['shelf open back', () => G.generateShelf({ back_panel: false, shelves: 2 })],
  ['gear bore', () => G.generateGear()],
  ['gear solid', () => G.generateGear({ bore: 0 })],
  ['spring', () => G.generateSpring()],
  ['spring open ends', () => G.generateSpring({ closed_ends: false, turns: 2.5 })],
  ['column fluted', () => G.generateColumn()],
  ['column plain', () => G.generateColumn({ flutes: 0, base: false, capital: false })],
  ['arch round', () => G.generateArch()],
  ['arch pointed', () => G.generateArch({ style: 'POINTED' })],
  ['arch low (segmental)', () => G.generateArch({ height: 1, width: 3, crown: 0.3 })],
  ['blob', () => G.generateBlob({ resolution: 24 })],
  [
    'blob explicit',
    () =>
      G.generateBlob({
        spheres: [
          { center: [0, 0, 0], radius: 1 },
          { center: [1.2, 0, 0], radius: 0.7 },
        ],
        resolution: 24,
      }),
  ],
  ['cloud', () => G.generateCloud({ resolution: 28 })],
  ['wheel', () => G.generateWheel()],
  ['wheel disc', () => G.generateWheel({ spokes: 0 })],
  ['barrel', () => G.generateBarrel()],
  ['barrel smooth', () => G.generateBarrel({ staves: 0, hoops: 0, bulge: 0 })],
];

describe('generators produce valid, closed, outward-facing meshes', () => {
  for (const [name, fn, opts] of CASES)
    it(name, () => {
      expectValid(fn(), opts);
    });

  it('the open terrain surface faces up', () => {
    const m = G.generateTerrain({ subdivisions: 8 }).mesh;
    for (let f = 0; f < m.faces.length; f++) {
      const [a, b, c] = m.faces[f].map((v) => [
        m.positions[v * 3],
        m.positions[v * 3 + 1],
        m.positions[v * 3 + 2],
      ]);
      const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      expect(nz).toBeGreaterThan(0);
    }
  });
});

describe('generators are deterministic and seeded', () => {
  const seeded: [string, (seed: number) => G.GeneratorResult][] = [
    ['terrain', (seed) => G.generateTerrain({ subdivisions: 12, seed })],
    ['rock', (seed) => G.generateRock({ detail: 2, seed })],
    ['tree', (seed) => G.generateTree({ branch_levels: 2, seed })],
    ['conifer', (seed) => G.generateTree({ style: 'CONIFER', seed })],
    ['palm', (seed) => G.generateTree({ style: 'PALM', seed })],
    ['bush', (seed) => G.generateBush({ seed })],
    ['grass', (seed) => G.generateGrassTuft({ seed })],
    ['flower', (seed) => G.generateFlower({ seed })],
    ['blob', (seed) => G.generateBlob({ seed, resolution: 16 })],
    ['cloud', (seed) => G.generateCloud({ seed, resolution: 16 })],
  ];
  for (const [name, fn] of seeded)
    it(name, () => {
      const a = fn(7).mesh;
      const b = fn(7).mesh;
      expect(b.positions).toEqual(a.positions);
      expect(b.faces).toEqual(a.faces);
      expect(b.faceMaterials).toEqual(a.faceMaterials);
      const c = fn(8).mesh;
      expect(c.positions).not.toEqual(a.positions);
    });

  it('unseeded generators are pure functions of their parameters', () => {
    for (const fn of [
      () => G.generateBuilding(),
      () => G.generateStairs({ style: 'SPIRAL' }),
      () => G.generateGear(),
      () => G.generateColumn(),
      () => G.generateWheel(),
      () => G.generatePipe(),
    ])
      expect(fn().mesh).toEqual(fn().mesh);
  });

  it('seeds of any magnitude (negative, fractional, huge, NaN) are accepted', () => {
    for (const seed of [-1, 0.5, 1e15, -1e300, NaN, Infinity])
      expectValid(G.generateRock({ detail: 1, seed }));
    expect(G.seedOf(NaN)).toBe(G.seedOf(0));
    expect(G.seedOf(3.7)).toBe(G.seedOf(3));
  });
});

describe('generator parameters', () => {
  it('terrain: heights span exactly 0..height over size × size, subdivisions set the grid', () => {
    const m = G.generateTerrain({ size: 30, height: 5, subdivisions: 10 }).mesh;
    const b = bounds(m);
    expect(b.min[2]).toBeCloseTo(0, 9);
    expect(b.max[2]).toBeCloseTo(5, 9);
    expect(b.size[0]).toBeCloseTo(30, 9);
    expect(b.size[1]).toBeCloseTo(30, 9);
    expect(m.faces).toHaveLength(100);
    expect(m.positions.length / 3).toBe(121);
    // UVs cover 0..1 over the whole terrain
    const us = m.uvs!.flat();
    expect(Math.min(...us)).toBeCloseTo(0);
    expect(Math.max(...us)).toBeCloseTo(1);
  });

  it('terrain: island falloff lowers the rim, terraces flatten levels, solid adds a base', () => {
    const island = G.generateTerrain({ subdivisions: 20, island_falloff: 1, height: 4 }).mesh;
    const N = 21;
    const z = (i: number, j: number) => island.positions[(j * N + i) * 3 + 2];
    for (let i = 0; i < N; i++) {
      expect(z(i, 0)).toBeLessThan(1e-9);
      expect(z(0, i)).toBeLessThan(1e-9);
    }
    const h = G.terrainHeights({ ...G.TERRAIN_DEFAULTS, terraces: 3 }, 30);
    const levels = new Set([...h].map((v) => Math.round(v * 1000)));
    // most samples sit on one of the 3 flat levels (0, 1/3, 2/3) or at the top
    const flat = [...h].filter((v) => [0, 1 / 3, 2 / 3, 1].some((l) => Math.abs(v - l) < 1e-9)).length;
    expect(flat / h.length).toBeGreaterThan(0.5);
    expect(levels.size).toBeGreaterThan(3);
    const solid = G.generateTerrain({ subdivisions: 8, solid: true, base_depth: 2 }).mesh;
    expect(bounds(solid).min[2]).toBeCloseTo(-2);
  });

  it('terrain: zones assign rock to steep and snow to high faces', () => {
    const r = G.generateTerrain({
      subdivisions: 32,
      height: 12,
      noise_scale: 6,
      snow_height: 0.7,
      rock_slope: 0.5,
    });
    expect(r.materials.map((m) => m.name)).toEqual(['Grass', 'Rock', 'Snow']);
    const used = new Set(r.mesh.faceMaterials);
    expect([...used].sort()).toEqual([0, 1, 2]);
    const single = G.generateTerrain({ subdivisions: 4, zones: false });
    expect(single.materials.map((m) => m.name)).toEqual(['Ground']);
    expect(new Set(single.mesh.faceMaterials)).toEqual(new Set([0]));
  });

  it('rock: rests on z = 0, centred, roughly sized; detail sets the resolution', () => {
    const r = G.generateRock({ size: [2, 1, 1], detail: 3, flat_bottom: true });
    const b = bounds(r.mesh);
    expect(b.min[2]).toBeCloseTo(0, 9);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0, 9);
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(0, 9);
    expect(b.size[0]).toBeGreaterThan(1.2);
    expect(b.size[0]).toBeLessThan(2.6);
    expect(b.size[0]).toBeGreaterThan(b.size[1]);
    expect(r.mesh.faces).toHaveLength(320);
    expect(G.generateRock({ detail: 4 }).mesh.faces).toHaveLength(1280);
  });

  it('trees: exact height, standing on z = 0 around the Z axis, wood and foliage slots', () => {
    for (const style of ['DECIDUOUS', 'CONIFER', 'PALM'] as const) {
      const r = G.generateTree({ style, height: 9, branch_levels: 2 });
      const b = bounds(r.mesh);
      expect(b.max[2]).toBeCloseTo(9, 6);
      expect(b.min[2]).toBeCloseTo(0, 6);
      expect(Math.abs(b.min[0] + b.max[0]) / 2).toBeLessThan(9 * 0.3);
      expect(new Set(r.mesh.faceMaterials)).toEqual(new Set([0, 1]));
      expect(r.materials[0].name).toBe('Bark');
    }
    expect(G.generateTree({ style: 'CONIFER' }).materials[1].name).toBe('Needles');
    expect(G.generateTree({ style: 'PALM' }).materials[1].name).toBe('Palm Leaves');
    // the trunk is centred at the origin at ground level
    const trunk = G.generateTree({ leaf_density: 0, branch_levels: 1 }).mesh;
    const ground: number[][] = [];
    for (let i = 0; i < trunk.positions.length; i += 3)
      if (trunk.positions[i + 2] < 1e-6) ground.push([trunk.positions[i], trunk.positions[i + 1]]);
    expect(ground.length).toBeGreaterThan(2);
    for (const [x, y] of ground) expect(Math.hypot(x, y)).toBeLessThan(0.5);
  });

  it('trees: branching depth, branches and leaf density change the result', () => {
    const faces = (p: Partial<G.TreeParams>) => G.generateTree({ branch_levels: 2, ...p }).mesh.faces.length;
    expect(faces({ branch_levels: 3 })).toBeGreaterThan(faces({ branch_levels: 1 }));
    expect(faces({ branches: 6 })).toBeGreaterThan(faces({ branches: 2 }));
    const leaves = (d: number) =>
      G.generateTree({ leaf_density: d, branch_levels: 2 }).mesh.faceMaterials.filter((m) => m === 1).length;
    expect(leaves(0)).toBe(0);
    expect(leaves(1)).toBeGreaterThan(leaves(0.3));
    // palms: fronds = branches × 3
    const fronds = (n: number) =>
      G.generateTree({ style: 'PALM', branches: n }).mesh.faceMaterials.filter((m) => m === 1).length;
    expect(fronds(4) / fronds(2)).toBeCloseTo(2, 0);
  });

  it('bush, grass and flower: sizes and part counts', () => {
    const bush = G.generateBush({ size: 2, height: 1.5 });
    const bb = bounds(bush.mesh);
    expect(bb.max[2]).toBeCloseTo(1.5, 6);
    expect(bb.min[2]).toBeCloseTo(0, 6);
    expect(bb.size[0]).toBeLessThanOrEqual(2.3);
    const islands = (m: MeshData) => faceIslands(m, buildTopology(m)).count;
    expect(islands(G.generateGrassTuft({ blades: 10 }).mesh)).toBe(10);
    const grass = bounds(G.generateGrassTuft({ height: 0.5 }).mesh);
    expect(grass.max[2]).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(grass.max[2]).toBeGreaterThan(0.25);
    const flower = G.generateFlower({ petals: 5, leaves: 0, height: 0.6 });
    expect(new Set(flower.mesh.faceMaterials)).toEqual(new Set([0, 1, 2]));
    expect(islands(flower.mesh)).toBe(1 + 1 + 5); // stem, centre disc, petals
    expect(bounds(flower.mesh).max[2]).toBeGreaterThan(0.55);
    expect(bounds(flower.mesh).max[2]).toBeLessThan(0.7);
  });

  it('building: footprint, wall and roof heights, front door, window grid, slots', () => {
    const r = G.generateBuilding({
      floors: 4,
      floor_height: 3,
      width: 12,
      depth: 9,
      roof: 'FLAT',
      window_cols: 4,
      window_cols_side: 3,
    });
    const b = bounds(r.mesh);
    expect(b.min).toEqual([-6, -4.5, 0]);
    expect(b.max[0]).toBe(6);
    expect(b.max[2]).toBeCloseTo(12 + 0.45, 9); // parapet
    expect(r.materials.map((m) => m.name)).toEqual(['Wall', 'Window Glass', 'Window Frame', 'Roof', 'Door']);
    const glass = r.mesh.faceMaterials.filter((m) => m === 1).length;
    // (4 + 3) × 2 facades × 4 floors, minus the window above the centred door's column (none: 4 columns)
    expect(glass).toBe((4 + 3) * 2 * 4);
    expect(r.mesh.faceMaterials.filter((m) => m === 4)).toHaveLength(1);
    // the door faces −Y
    const doorFace = r.mesh.faces[r.mesh.faceMaterials.indexOf(4)];
    for (const v of doorFace) expect(r.mesh.positions[v * 3 + 1]).toBeLessThan(-4.5 + 0.2);
    const gable = bounds(
      G.generateBuilding({ floors: 2, floor_height: 3, roof: 'GABLE', roof_height: 2 }).mesh,
    );
    expect(gable.max[2]).toBeGreaterThan(8);
    expect(gable.max[2]).toBeLessThan(8.3);
    const noDoor = G.generateBuilding({ door: false });
    expect(noDoor.mesh.faceMaterials.includes(4)).toBe(false);
  });

  it('stairs: top tread at steps × rise, run along +Y; spiral winds around Z', () => {
    const s = bounds(G.generateStairs({ steps: 10, rise: 0.2, run: 0.3, width: 1.2 }).mesh);
    expect(s.max[2]).toBeCloseTo(2, 9);
    expect(s.min[2]).toBeCloseTo(0, 9);
    expect(s.size[0]).toBeCloseTo(1.2, 9);
    expect(s.min[1]).toBeCloseTo(0, 9);
    expect(s.max[1]).toBeCloseTo(3, 9);
    const sp = G.generateStairs({ style: 'SPIRAL', steps: 16, rise: 0.2, width: 1, inner_radius: 0.2 });
    const b = bounds(sp.mesh);
    expect(b.size[0]).toBeLessThanOrEqual(2.4 + 1e-9);
    expect(b.max[2]).toBeGreaterThanOrEqual(3.2 - 1e-9);
    expect(faceIslands(sp.mesh, buildTopology(sp.mesh)).count).toBe(16 + 1); // treads + column
  });

  it('fence: posts at path points, length of a straight run, height', () => {
    const f = bounds(G.generateFence({ length: 8, height: 1.2, post_spacing: 2, post_width: 0.1 }).mesh);
    expect(f.size[0]).toBeCloseTo(8.1, 6);
    expect(f.max[2]).toBeGreaterThan(1.2);
    expect(f.max[2]).toBeLessThan(1.35);
    const path = G.generateFence({
      points: [
        [0, 0],
        [4, 0],
        [4, 3, 1],
      ],
      style: 'RAIL',
      rails: 3,
    });
    const pb = bounds(path.mesh);
    expect(pb.max[0]).toBeCloseTo(4.05, 1);
    expect(pb.max[1]).toBeCloseTo(3.05, 1);
    expect(pb.max[2]).toBeGreaterThan(1.9); // follows the raised last point
    // RAIL: posts + 3 rails per bay; bays = ceil(4/2) + ceil(3.16/2) = 4, posts = 5
    expect(faceIslands(path.mesh, buildTopology(path.mesh)).count).toBe(5 + 4 * 3);
  });

  it('pipe: follows its points with the given radius; caps and hollow walls', () => {
    const r = G.generatePipe({
      points: [
        [0, 0, 0],
        [0, 0, 2],
      ],
      radius: 0.25,
      segments: 12,
    });
    const b = bounds(r.mesh);
    expect(b.min[2]).toBeCloseTo(0, 9);
    expect(b.max[2]).toBeCloseTo(2, 9);
    expect(b.size[0]).toBeCloseTo(0.5, 6);
    expect(G.signedVolume(r.mesh)).toBeCloseTo(2 * 12 * 0.5 * 0.25 * 0.25 * Math.sin((2 * Math.PI) / 12), 6);
    const hollow = G.generatePipe({
      points: [
        [0, 0, 0],
        [0, 0, 2],
      ],
      radius: 0.25,
      thickness: 0.05,
      segments: 12,
    });
    const ring = 12 * 0.5 * Math.sin((2 * Math.PI) / 12) * (0.25 ** 2 - 0.2 ** 2);
    expect(G.signedVolume(hollow.mesh)).toBeCloseTo(2 * ring, 6);
    const open = G.generatePipe({
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      closed_ends: false,
    });
    expect(isClosedManifold(open.mesh)).toBe(false);
  });

  it('pipe: rounded bends stay inside the corner, sharp corners keep the radius', () => {
    const bent = G.generatePipe({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 0],
      ],
      radius: 0.1,
      bend_radius: 0.5,
    });
    const bb = bounds(bent.mesh);
    expect(bb.max[0]).toBeCloseTo(2.1, 6);
    expect(bb.max[1]).toBeCloseTo(2, 6);
    const path = G.filletPath(
      [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 0],
      ],
      0.5,
      4,
      false,
    );
    expect(path[0]).toEqual([0, 0, 0]);
    expect(path[path.length - 1]).toEqual([2, 2, 0]);
    // every fillet point is 0.5 from the corner circle centre (1.5, 0.5)
    for (const q of path.slice(1, -1)) expect(Math.hypot(q[0] - 1.5, q[1] - 0.5)).toBeCloseTo(0.5, 9);
  });

  it('furniture: heights and footprints', () => {
    const t = bounds(G.generateTable({ width: 2, depth: 1, height: 0.8 }).mesh);
    expect(t.size).toEqual([2, 1, 0.8].map((v) => expect.closeTo(v, 9)));
    expect(t.min[2]).toBe(0);
    const round = bounds(G.generateTable({ shape: 'ROUND', width: 1.2 }).mesh);
    expect(round.size[0]).toBeCloseTo(1.2, 6);
    const c = G.generateChair({ seat_height: 0.5, back_height: 0.4 });
    expect(bounds(c.mesh).max[2]).toBeCloseTo(0.9, 9);
    const backSide = c.mesh.positions.filter((_, i) => i % 3 === 1 && c.mesh.positions[i + 1] > 0.6);
    for (const y of backSide) expect(y).toBeGreaterThan(0); // backrest on +Y
    const sh = G.generateShelf({ shelves: 4, height: 2 });
    expect(bounds(sh.mesh).max[2]).toBeCloseTo(2, 9);
    expect(sh.mesh.faceMaterials.filter((m) => m === 0)).toHaveLength(4 * 6);
  });

  it('gear: teeth, radius, thickness, bore', () => {
    const g = G.generateGear({ teeth: 12, radius: 1, thickness: 0.2, bore: 0.3, tooth_depth: 0.1 });
    const b = bounds(g.mesh);
    expect(b.max[0]).toBeCloseTo(1, 1);
    expect(b.min[2]).toBeCloseTo(-0.1, 9);
    expect(b.max[2]).toBeCloseTo(0.1, 9);
    // 5 outline points per tooth on 4 rings (bore and outer, bottom and top)
    expect(g.mesh.positions.length / 3).toBe(12 * 5 * 4);
    const radii: number[] = [];
    for (let i = 0; i < g.mesh.positions.length; i += 3)
      radii.push(Math.hypot(g.mesh.positions[i], g.mesh.positions[i + 1]));
    expect(Math.min(...radii)).toBeCloseTo(0.3, 9);
    expect(Math.max(...radii)).toBeCloseTo(1, 9);
    expect(G.signedVolume(G.generateGear({ bore: 0 }).mesh)).toBeGreaterThan(
      G.signedVolume(G.generateGear({ bore: 0.2 }).mesh),
    );
  });

  it('spring: coil radius, height and turns', () => {
    const s = G.generateSpring({ coil_radius: 0.3, height: 1, wire_radius: 0.03, turns: 4 });
    const b = bounds(s.mesh);
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(1, 6);
    expect(b.size[0]).toBeCloseTo(0.66, 2);
    const more = G.generateSpring({ turns: 8 }).mesh.faces.length;
    expect(more).toBeGreaterThan(G.generateSpring({ turns: 4 }).mesh.faces.length);
  });

  it('column: exact height, flutes add grooves, base and capital use slot 1', () => {
    const c = G.generateColumn({ height: 4, radius: 0.3 });
    expect(bounds(c.mesh).max[2]).toBeCloseTo(4, 9);
    expect(bounds(c.mesh).min[2]).toBeCloseTo(0, 9);
    expect(new Set(c.mesh.faceMaterials)).toEqual(new Set([0, 1]));
    const plain = G.generateColumn({ base: false, capital: false, flutes: 0 });
    expect(new Set(plain.mesh.faceMaterials)).toEqual(new Set([0]));
    expect(bounds(plain.mesh).max[0]).toBeCloseTo(0.25, 2);
  });

  it('arch: outer size and a clear opening', () => {
    const a = G.generateArch({ width: 2, height: 3, pier_width: 0.5, thickness: 0.4 });
    const b = bounds(a.mesh);
    expect(b.size).toEqual([3, 0.4, 3].map((v) => expect.closeTo(v, 9)));
    // a vertical ray through the middle of the opening first meets masonry above the springing line
    const zs: number[] = [];
    for (let i = 0; i < a.mesh.positions.length; i += 3)
      if (Math.abs(a.mesh.positions[i]) < 1e-9) zs.push(a.mesh.positions[i + 2]);
    expect(Math.min(...zs)).toBeCloseTo(2.6, 6); // top of the opening = height − crown
    const pointed = G.generateArch({ style: 'POINTED', width: 2, height: 3 });
    expect(G.signedVolume(pointed.mesh)).toBeGreaterThan(G.signedVolume(a.mesh) * 0.5);
  });

  it('blob and cloud: smooth unions meshed watertight; cloud has the exact size', () => {
    const one = G.generateBlob({
      spheres: [{ center: [0, 0, 0], radius: 1 }],
      resolution: 40,
      smoothness: 0,
    });
    expect(G.signedVolume(one.mesh)).toBeCloseTo((4 / 3) * Math.PI, 1);
    // two spheres 0.1 m apart: a 0.35 m blend bridges the gap, a hard union keeps them apart
    const pair: G.BlobSphere[] = [
      { center: [-0.65, 0, 0], radius: 0.6 },
      { center: [0.65, 0, 0], radius: 0.6 },
    ];
    const soft = G.generateBlob({ spheres: pair, smoothness: 0.35, resolution: 40 });
    expect(faceIslands(soft.mesh, buildTopology(soft.mesh)).count).toBe(1);
    const hard = G.generateBlob({ spheres: pair, smoothness: 0, resolution: 40 });
    expect(faceIslands(hard.mesh, buildTopology(hard.mesh)).count).toBe(2);
    expect(G.signedVolume(soft.mesh)).toBeGreaterThan(G.signedVolume(hard.mesh));
    const c = G.generateCloud({ size: [5, 3, 2], resolution: 24 });
    const b = bounds(c.mesh);
    expect(b.size).toEqual([5, 3, 2].map((v) => expect.closeTo(v, 6)));
    expect(b.min[2]).toBeCloseTo(0, 9);
  });

  it('wheel and barrel', () => {
    const w = G.generateWheel({ radius: 0.5, width: 0.2 });
    const b = bounds(w.mesh);
    expect(b.size[0]).toBeCloseTo(0.2, 6); // axle along X
    expect(b.size[1]).toBeCloseTo(1, 2);
    expect(b.size[2]).toBeCloseTo(1, 2);
    expect(new Set(w.mesh.faceMaterials)).toEqual(new Set([0, 1]));
    const barrel = G.generateBarrel({ height: 1.2, radius: 0.4, bulge: 0.2, hoops: 3 });
    const bb = bounds(barrel.mesh);
    expect(bb.max[2]).toBeCloseTo(1.2, 9);
    expect(bb.size[0]).toBeGreaterThan(0.8 * 1.15);
    expect(faceIslands(barrel.mesh, buildTopology(barrel.mesh)).count).toBe(1 + 3);
  });
});

describe('generators survive degenerate input', () => {
  const all: [string, (p: Record<string, unknown>) => G.GeneratorResult][] = [
    [
      'terrain',
      (p) =>
        G.generateTerrain({
          ...p,
          subdivisions: (p.subdivisions as number) ?? 4,
        } as Partial<G.TerrainParams>),
    ],
    ['rock', (p) => G.generateRock(p as Partial<G.RockParams>)],
    ['tree', (p) => G.generateTree(p as Partial<G.TreeParams>)],
    ['conifer', (p) => G.generateTree({ ...(p as Partial<G.TreeParams>), style: 'CONIFER' })],
    ['palm', (p) => G.generateTree({ ...(p as Partial<G.TreeParams>), style: 'PALM' })],
    ['bush', (p) => G.generateBush(p as Partial<G.BushParams>)],
    ['grass', (p) => G.generateGrassTuft(p as Partial<G.GrassParams>)],
    ['flower', (p) => G.generateFlower(p as Partial<G.FlowerParams>)],
    ['building', (p) => G.generateBuilding(p as Partial<G.BuildingParams>)],
    ['stairs', (p) => G.generateStairs(p as Partial<G.StairsParams>)],
    ['spiral', (p) => G.generateStairs({ ...(p as Partial<G.StairsParams>), style: 'SPIRAL' })],
    ['fence', (p) => G.generateFence(p as Partial<G.FenceParams>)],
    ['pipe', (p) => G.generatePipe(p as Partial<G.PipeParams>)],
    ['table', (p) => G.generateTable(p as Partial<G.TableParams>)],
    ['chair', (p) => G.generateChair(p as Partial<G.ChairParams>)],
    ['shelf', (p) => G.generateShelf(p as Partial<G.ShelfParams>)],
    ['gear', (p) => G.generateGear(p as Partial<G.GearParams>)],
    ['spring', (p) => G.generateSpring(p as Partial<G.SpringParams>)],
    ['column', (p) => G.generateColumn(p as Partial<G.ColumnParams>)],
    ['arch', (p) => G.generateArch(p as Partial<G.ArchParams>)],
    ['blob', (p) => G.generateBlob({ ...(p as Partial<G.BlobParams>), resolution: 12 })],
    ['cloud', (p) => G.generateCloud({ ...(p as Partial<G.CloudParams>), resolution: 12 })],
    ['wheel', (p) => G.generateWheel(p as Partial<G.WheelParams>)],
    ['barrel', (p) => G.generateBarrel(p as Partial<G.BarrelParams>)],
  ];
  const DEFAULTS: Record<string, object> = {
    terrain: G.TERRAIN_DEFAULTS,
    rock: G.ROCK_DEFAULTS,
    tree: G.TREE_DEFAULTS,
    conifer: G.TREE_DEFAULTS,
    palm: G.TREE_DEFAULTS,
    bush: G.BUSH_DEFAULTS,
    grass: G.GRASS_DEFAULTS,
    flower: G.FLOWER_DEFAULTS,
    building: G.BUILDING_DEFAULTS,
    stairs: G.STAIRS_DEFAULTS,
    spiral: G.STAIRS_DEFAULTS,
    fence: G.FENCE_DEFAULTS,
    pipe: G.PIPE_DEFAULTS,
    table: G.TABLE_DEFAULTS,
    chair: G.CHAIR_DEFAULTS,
    shelf: G.SHELF_DEFAULTS,
    gear: G.GEAR_DEFAULTS,
    spring: G.SPRING_DEFAULTS,
    column: G.COLUMN_DEFAULTS,
    arch: G.ARCH_DEFAULTS,
    blob: G.BLOB_DEFAULTS,
    cloud: G.CLOUD_DEFAULTS,
    wheel: G.WHEEL_DEFAULTS,
    barrel: G.BARREL_DEFAULTS,
  };
  /** Every numeric parameter (and vector component) replaced by `v`. */
  const fill = (defaults: object, v: number) =>
    Object.fromEntries(
      Object.entries(defaults).map(([k, d]) => [
        k,
        typeof d === 'number'
          ? v
          : Array.isArray(d) && d.every((x) => typeof x === 'number')
            ? d.map(() => v)
            : d,
      ]),
    );
  for (const [name, fn] of all)
    for (const v of [NaN, 0, -3])
      it(`${name} with every number = ${v}`, () => {
        const r = fn(fill(DEFAULTS[name], v));
        expect(validateMesh(r.mesh)).toEqual([]);
        expect(r.mesh.positions.every(Number.isFinite)).toBe(true);
        for (const mi of r.mesh.faceMaterials) expect(mi).toBeLessThan(r.materials.length);
      });

  it('degenerate paths and shapes give empty or minimal meshes instead of throwing', () => {
    expect(G.generatePipe({ points: [] }).mesh.faces).toHaveLength(0);
    expect(
      G.generatePipe({
        points: [
          [1, 1, 1],
          [1, 1, 1],
        ],
      }).mesh.faces,
    ).toHaveLength(0);
    expect(
      G.generatePipe({
        points: [
          [0, 0, 0],
          [NaN, 0, 0],
          [1, 0, 0],
        ] as G.PipeParams['points'],
      }).mesh.faces.length,
    ).toBeGreaterThan(0);
    // a fence with a single point falls back to a straight run
    expectValid(G.generateFence({ points: [[0, 0]] }));
    expectValid(
      G.generateFence({
        points: [
          [0, 0],
          [0, 0],
          [3, 0],
        ],
      }),
    );
    const blob = G.generateBlob({
      spheres: [
        { center: [NaN, 0, 0], radius: 1 },
        { center: [0, 0, 0], radius: -1 },
      ] as G.BlobSphere[],
      resolution: 12,
    });
    expectValid(blob); // falls back to random spheres
    // a building smaller than its window size has no windows but stays closed
    expectValid(G.generateBuilding({ width: 1, depth: 1, floor_height: 1 }));
  });
});

describe('generator building blocks', () => {
  it('Rng is deterministic, uniform-ish and in range', () => {
    const a = new G.Rng(42);
    const b = new G.Rng(42);
    const xs = Array.from({ length: 2000 }, () => a.next());
    expect(Array.from({ length: 2000 }, () => b.next())).toEqual(xs);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1);
    const r = new G.Rng(1);
    for (let i = 0; i < 200; i++) {
      const k = r.int(2, 5);
      expect(k).toBeGreaterThanOrEqual(2);
      expect(k).toBeLessThanOrEqual(5);
      const u = r.unitVector();
      expect(Math.hypot(...u)).toBeCloseTo(1, 12);
    }
    expect(new G.Rng(42, 1).next()).not.toBe(new G.Rng(42, 2).next());
  });

  it('gradient noise is seeded, bounded and zero on lattice points', () => {
    const n = new G.GradientNoise(3);
    expect(n.noise3(1, 2, 3)).toBe(0);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 500; i++) {
      const v = n.fractal(i * 0.37, i * 0.11, i * 0.07, { octaves: 5 });
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(-1.01);
    expect(hi).toBeLessThanOrEqual(1.01);
    expect(new G.GradientNoise(3).noise3(0.3, 0.4, 0.5)).toBe(n.noise3(0.3, 0.4, 0.5));
    expect(new G.GradientNoise(4).noise3(0.3, 0.4, 0.5)).not.toBe(n.noise3(0.3, 0.4, 0.5));
    expect(n.noise3(NaN, 0, 0)).toBe(0);
  });

  it('marching cubes meshes a sphere watertight with the right volume', () => {
    const grid = G.sampleGrid(
      (x, y, z) => Math.hypot(x, y, z) - 1,
      [-1.3, -1.3, -1.3],
      [1.3, 1.3, 1.3],
      0.08,
    );
    const { positions, triangles } = G.polygonize(grid, 0);
    const b = new G.MeshBuilder();
    for (let i = 0; i < positions.length; i += 3) b.vert([positions[i], positions[i + 1], positions[i + 2]]);
    for (let t = 0; t < triangles.length; t += 3) b.face([triangles[t], triangles[t + 1], triangles[t + 2]]);
    const m = b.build();
    expect(isClosedManifold(m)).toBe(true);
    expect(countInconsistentEdges(m)).toBe(0);
    expect(G.signedVolume(m)).toBeCloseTo((4 / 3) * Math.PI, 1);
    for (let i = 0; i < positions.length; i += 3)
      expect(Math.hypot(positions[i], positions[i + 1], positions[i + 2])).toBeCloseTo(1, 1);
  });

  it('marching cubes resolves ambiguous saddle faces consistently (two touching blobs)', () => {
    // a field with many ambiguous faces: two spheres whose surfaces almost touch on a coarse grid
    const f = (x: number, y: number, z: number) =>
      Math.min(Math.hypot(x - 0.52, y, z) - 0.5, Math.hypot(x + 0.52, y + 0.03, z) - 0.5);
    for (const step of [0.1, 0.13, 0.17]) {
      const { positions, triangles } = G.polygonize(
        G.sampleGrid(f, [-1.2, -0.7, -0.7], [1.2, 0.7, 0.7], step),
      );
      const b = new G.MeshBuilder();
      for (let i = 0; i < positions.length; i += 3)
        b.vert([positions[i], positions[i + 1], positions[i + 2]]);
      for (let t = 0; t < triangles.length; t += 3)
        b.face([triangles[t], triangles[t + 1], triangles[t + 2]]);
      const m = b.build();
      expect(isClosedManifold(m)).toBe(true);
      expect(countInconsistentEdges(m)).toBe(0);
      for (const v of partVolumes(m)) expect(v).toBeGreaterThan(0);
    }
  });

  it('builder shapes are closed and outward for any orientation, including mirrored matrices', () => {
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const shapes: ((b: G.MeshBuilder) => void)[] = [
      (b) => G.addBox(b, [0, 0, 0], [1, 2, 3]),
      (b) => G.addBox(b, [1, 1, 1], [0, 0, 0]),
      (b) => G.addBox(b, [0, 0, 0], [1, 1, 1], { matrix: mirror }),
      (b) => G.addBoxBetween(b, [0, 0, 0], [1, 1, 1], 0.2, 0.3),
      (b) => G.addBoxBetween(b, [0, 0, 0], [0, 0, 2], 0.2, 0.3),
      (b) =>
        G.addPrism(
          b,
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0.5, 0.4],
            [0, 1],
          ],
          0,
          1,
        ),
      (b) =>
        G.addPrism(
          b,
          [
            [0, 0],
            [0, 1],
            [0.5, 0.4],
            [1, 1],
            [1, 0],
          ],
          1,
          0,
        ),
      (b) =>
        G.addPrism(
          b,
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          0,
          1,
          { matrix: mirror },
        ),
      (b) =>
        G.addLathe(
          b,
          [
            [0, -1],
            [1, 0],
            [0, 1],
          ],
          12,
        ),
      (b) =>
        G.addLathe(
          b,
          [
            [0, 1],
            [1, 0],
            [0, -1],
          ],
          12,
        ),
      (b) =>
        G.addLathe(
          b,
          [
            [1, -0.2],
            [1.4, -0.2],
            [1.4, 0.2],
            [1, 0.2],
          ],
          16,
          { loop: true },
        ),
      (b) =>
        G.addLathe(
          b,
          [
            [1, 0.2],
            [1.4, 0.2],
            [1.4, -0.2],
            [1, -0.2],
          ],
          16,
          { loop: true },
        ),
      (b) =>
        G.addTube(
          b,
          [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
            [1, 1, 1],
          ],
          0.1,
          8,
          { miter: true },
        ),
      (b) =>
        G.addTube(
          b,
          Array.from({ length: 24 }, (_, i): [number, number, number] => [
            2 * Math.cos((i / 24) * 2 * Math.PI),
            2 * Math.sin((i / 24) * 2 * Math.PI),
            Math.sin(i / 4),
          ]),
          0.3,
          8,
          { cyclic: true },
        ),
      (b) =>
        G.addBlade(
          b,
          [
            [0, 0, 0],
            [0.5, 0, 0.1],
            [1, 0, 0],
          ],
          [0, 0.2, 0],
          [0, 0.01, 0],
          [
            [0, 0, 1],
            [0, 0, 1],
            [0, 0, 1],
          ],
        ),
      (b) => G.addIcoSphere(b, [0, 0, 1], [1, 2, 0.5], 3),
      (b) => G.addIcoSphere(b, [0, 0, 1], [1, 1, 1], 2, { displace: (d) => 1 + 0.3 * d[0], matrix: mirror }),
    ];
    for (const fill of shapes) {
      const b = new G.MeshBuilder();
      fill(b);
      const m = b.build();
      expect(validateMesh(m)).toEqual([]);
      expect(isClosedManifold(m)).toBe(true);
      expect(countInconsistentEdges(m)).toBe(0);
      expect(G.signedVolume(m)).toBeGreaterThan(0);
    }
  });

  it('builder rejects degenerate faces and sanitizes non-finite vertices', () => {
    const b = new G.MeshBuilder();
    const a = b.vert([0, 0, 0]);
    const c = b.vert([NaN, 1, Infinity]);
    const d = b.vert([1, 1, 0]);
    expect(b.face([a, a, c])).toBe(-1);
    expect(b.face([a, c, a, d])).toBe(-1);
    expect(b.face([a, c, d, a])).toBe(0); // closing duplicate collapsed
    expect(b.position(c)).toEqual([0, 1, 0]);
    expect(b.sharedVert([1, 1, 0])).toBe(b.sharedVert([1 + 1e-9, 1, 0]));
    expect(validateMesh(b.build())).toEqual([]);
  });

  it('signedVolume and surfaceArea of a unit cube', () => {
    const b = new G.MeshBuilder();
    G.addBox(b, [0, 0, 0], [1, 1, 1]);
    const m = b.build();
    expect(G.signedVolume(m)).toBeCloseTo(1, 12);
    expect(G.surfaceArea(m)).toBeCloseTo(6, 12);
  });
});
