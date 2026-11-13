import { describe, expect, it } from 'vitest';
import {
  countInconsistentEdges,
  createCircle,
  createCube,
  createGrid,
  createMesh,
  createPlane,
  edgeKey,
  faceNormal,
  getModifierDef,
  isClosedManifold,
  meshStats,
  registerBuiltinModifiers,
  rotationFromEuler,
  translation4,
  vertexCount,
  type MeshData,
} from '../src';
import {
  applyModifier,
  boundsOf,
  expectClosedConsistent,
  expectValidMesh,
  objectsCtx,
  openEdgeCount,
  signedVolume,
  translated,
  vertexAt,
} from './modifiers-helpers';

function withColors(m: MeshData): MeshData {
  const n = vertexCount(m);
  const colors: number[] = [];
  for (let i = 0; i < n; i++) colors.push(i / n, 0.5, 1 - i / n, 1);
  return { ...m, colors };
}

describe('SUBSURF', () => {
  it('subdivides a cube into a closed, consistently wound quad mesh', () => {
    const cube = createCube();
    const l1 = applyModifier('SUBSURF', cube, { levels: 1 });
    expect(meshStats(l1)).toMatchObject({ vertices: 26, faces: 24 });
    expectClosedConsistent(l1);
    expectValidMesh(l1);
    // Catmull–Clark corner rule: (F + 2R + (n-3)V) / n = 5/9 for a unit cube corner
    for (const c of vertexAt(l1, 0)) expect(Math.abs(c)).toBeCloseTo(5 / 9, 10);
    const l2 = applyModifier('SUBSURF', cube, { levels: 2 });
    expect(meshStats(l2)).toMatchObject({ vertices: 98, faces: 96 });
    expectClosedConsistent(l2);
    expect(l1.faces.every((f) => f.length === 4)).toBe(true);
    // smoothing shrinks the cube but keeps it positive and symmetric
    const v1 = signedVolume(l1);
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeLessThan(8);
    expect(signedVolume(l2)).toBeLessThan(v1);
  });

  it('uses render_levels for renders and returns the input for level 0', () => {
    const cube = createCube();
    expect(meshStats(applyModifier('SUBSURF', cube, {}, { forRender: true })).faces).toBe(96);
    expect(applyModifier('SUBSURF', cube, { levels: 0 })).toBe(cube);
  });

  it('SIMPLE keeps the shape', () => {
    const r = applyModifier('SUBSURF', createCube(), { levels: 2, subdivision_type: 'SIMPLE' });
    expect(meshStats(r).faces).toBe(96);
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8, 10);
    for (let i = 0; i < vertexCount(r); i++)
      expect(Math.max(...vertexAt(r, i).map(Math.abs))).toBeCloseTo(1, 10);
  });

  it('fully creased edges stay sharp', () => {
    const cube = createCube();
    const edgeAttrs: MeshData['edgeAttrs'] = {};
    for (const f of cube.faces)
      for (let i = 0; i < 4; i++) edgeAttrs[edgeKey(f[i], f[(i + 1) % 4])] = { crease: 1 };
    const r = applyModifier('SUBSURF', { ...cube, edgeAttrs }, { levels: 2 });
    expect(signedVolume(r)).toBeCloseTo(8, 8);
    expect(vertexAt(r, 7)).toEqual([1, 1, 1]);
    // creases propagate to the child edges
    expect(Object.values(r.edgeAttrs).every((a) => a.crease === 1)).toBe(true);
    // ... unless creases are disabled
    const smooth = applyModifier('SUBSURF', { ...cube, edgeAttrs }, { levels: 2, use_creases: false });
    expect(signedVolume(smooth)).toBeLessThan(7);
    // semi-sharp creases land in between
    const half: MeshData['edgeAttrs'] = {};
    for (const k in edgeAttrs) half[k] = { crease: 0.5 };
    const semi = signedVolume(applyModifier('SUBSURF', { ...cube, edgeAttrs: half }, { levels: 2 }));
    expect(semi).toBeGreaterThan(signedVolume(smooth));
    expect(semi).toBeLessThan(8);
  });

  it('handles open boundaries and loose edges', () => {
    const plane = createPlane();
    const r = applyModifier('SUBSURF', plane, { levels: 1 });
    expect(meshStats(r)).toMatchObject({ vertices: 9, faces: 4 });
    expect(openEdgeCount(r)).toBe(8);
    // boundary corners follow the cubic B-spline boundary rule (1 + 6 - 1) / 8
    expect(vertexAt(r, 2)).toEqual([0.75, 0.75, 0]);
    const kept = applyModifier('SUBSURF', plane, { levels: 1, boundary_smooth: 'PRESERVE_CORNERS' });
    expect(vertexAt(kept, 2)).toEqual([1, 1, 0]);
    const circle = createCircle({ vertices: 8 });
    const c = applyModifier('SUBSURF', circle, { levels: 1 });
    expect(c.looseEdges.length / 2).toBe(16);
    expect(vertexCount(c)).toBe(16);
    expect(c.positions.filter((_, i) => i % 3 === 2).every((z) => z === 0)).toBe(true);
  });

  it('interpolates UVs per corner and vertex colors, and keeps face attributes', () => {
    const cube = withColors(createCube());
    cube.faceMaterials = [0, 1, 2, 0, 1, 2];
    cube.faceSmooth = cube.faces.map(() => true);
    const r = applyModifier('SUBSURF', cube, { levels: 1 });
    expectValidMesh(r);
    expect(r.faceMaterials.slice(0, 8)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(r.faceSmooth.every(Boolean)).toBe(true);
    // first child of face 0: corner UV, edge midpoint UV, face center UV
    const uv0 = cube.uvs![0];
    const child = r.uvs![0];
    expect(child.slice(0, 2)).toEqual(uv0.slice(0, 2));
    expect(child[2]).toBeCloseTo((uv0[0] + uv0[2]) / 2);
    expect(child[4]).toBeCloseTo((uv0[0] + uv0[2] + uv0[4] + uv0[6]) / 4);
    // edge point colors are the average of their endpoints
    const fp = r.faces[0];
    const e = fp[1];
    const [a, b] = [cube.faces[0][0], cube.faces[0][1]];
    expect(r.colors![e * 4]).toBeCloseTo((cube.colors![a * 4] + cube.colors![b * 4]) / 2);
  });
});

describe('MIRROR', () => {
  // cube spanning x ∈ [0, 2] without its -X face: one half of a symmetric box
  const half = (() => {
    const c = translated(createCube(), [1, 0, 0]);
    return {
      ...c,
      faces: c.faces.slice(1),
      faceMaterials: c.faceMaterials.slice(1),
      faceSmooth: c.faceSmooth.slice(1),
      uvs: c.uvs!.slice(1),
    };
  })();

  it('mirrors and welds the seam into a closed, outward-facing mesh', () => {
    const r = applyModifier('MIRROR', half);
    expectValidMesh(r);
    expect(meshStats(r)).toMatchObject({ vertices: 12, faces: 10 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(16, 10);
    const b = boundsOf(r);
    expect(b.min[0]).toBeCloseTo(-2);
    expect(b.max[0]).toBeCloseTo(2);
    // symmetric: every vertex has a mirror partner
    const key = (x: number, y: number, z: number) => [x, y, z].map((c) => Math.round(c * 1e6)).join(',');
    const set = new Set<string>();
    for (let i = 0; i < vertexCount(r); i++) {
      const [x, y, z] = vertexAt(r, i);
      set.add(key(x, y, z));
    }
    for (let i = 0; i < vertexCount(r); i++) {
      const [x, y, z] = vertexAt(r, i);
      expect(set.has(key(-x, y, z))).toBe(true);
    }
  });

  it('leaves the seam open without merging', () => {
    const r = applyModifier('MIRROR', half, { use_mirror_merge: false });
    expect(vertexCount(r)).toBe(16);
    expect(openEdgeCount(r)).toBe(8);
  });

  it('bisects before mirroring (and flips the kept side)', () => {
    const shifted = translated(createCube(), [0.5, 0, 0]); // x ∈ [-0.5, 1.5]
    const keepPos = applyModifier('MIRROR', shifted, { use_bisect_axis: [true, false, false] });
    expectClosedConsistent(keepPos);
    expect(signedVolume(keepPos)).toBeCloseTo(12, 8);
    const keepNeg = applyModifier('MIRROR', shifted, {
      use_bisect_axis: [true, false, false],
      use_bisect_flip_axis: [true, false, false],
    });
    expectClosedConsistent(keepNeg);
    expect(signedVolume(keepNeg)).toBeCloseTo(4, 8);
  });

  it('mirrors across several axes and across a mirror object', () => {
    const quarter = translated(createCube(), [2, 2, 0]);
    const r = applyModifier('MIRROR', quarter, { use_axis: [true, true, false] });
    expect(r.faces.length).toBe(24);
    expect(signedVolume(r)).toBeCloseTo(32, 8);
    const ctx = objectsCtx({ empty: { mesh: createMesh(), matrix: translation4([2, 0, 0]) } });
    const m = applyModifier('MIRROR', createCube(), { mirror_object: 'empty' }, ctx);
    expect(boundsOf(m).max[0]).toBeCloseTo(5);
    expect(signedVolume(m)).toBeCloseTo(16, 8);
    expectClosedConsistent(m);
  });

  it('flips UVs of the mirrored half when requested', () => {
    const r = applyModifier('MIRROR', half, { use_mirror_merge: false, use_mirror_u: true });
    const n = half.faces.length;
    const orig = half.uvs![0];
    const mir = r.uvs![n];
    // mirrored face corners are reversed and u is flipped
    expect(mir[0]).toBeCloseTo(1 - orig[orig.length - 2]);
    expect(mir[1]).toBeCloseTo(orig[orig.length - 1]);
  });
});

describe('ARRAY', () => {
  it('repeats with a relative offset', () => {
    const r = applyModifier('ARRAY', createCube(), { count: 3 });
    expectValidMesh(r);
    expect(vertexCount(r)).toBe(24);
    expect(boundsOf(r).max[0]).toBeCloseTo(5);
    expect(signedVolume(r)).toBeCloseTo(24);
    expect(countInconsistentEdges(r)).toBe(0);
  });

  it('merges touching copies', () => {
    const r = applyModifier('ARRAY', createPlane(), { count: 3, use_merge_vertices: true });
    expect(meshStats(r)).toMatchObject({ vertices: 8, faces: 3 });
    expect(openEdgeCount(r)).toBe(8);
  });

  it('supports constant offsets, fit length and object offsets', () => {
    const stacked = applyModifier('ARRAY', createCube(), {
      count: 2,
      use_relative_offset: false,
      use_constant_offset: true,
      constant_offset_displace: [0, 0, 3],
    });
    expect(boundsOf(stacked).max[2]).toBeCloseTo(4);
    const fit = applyModifier('ARRAY', createCube(), { fit_type: 'FIT_LENGTH', fit_length: 10 });
    expect(vertexCount(fit) / 8).toBe(6);
    const ctx = objectsCtx({ empty: { mesh: createMesh(), matrix: rotationFromEuler([0, 0, Math.PI / 2]) } });
    const radial = applyModifier(
      'ARRAY',
      translated(createCube({ size: 1 }), [3, 0, 0]),
      { count: 4, use_relative_offset: false, use_object_offset: true, offset_object: 'empty' },
      ctx,
    );
    const b = boundsOf(radial);
    expect(b.min[0]).toBeCloseTo(-3.5);
    expect(b.max[1]).toBeCloseTo(3.5);
    expect(signedVolume(radial)).toBeCloseTo(4);
  });

  it('adds caps and offsets UVs per copy', () => {
    const cap = createCube({ size: 0.5 });
    const ctx = objectsCtx({ cap: { mesh: cap, matrix: translation4([10, 10, 10]) } });
    const r = applyModifier(
      'ARRAY',
      createCube(),
      { count: 2, start_cap: 'cap', end_cap: 'cap', offset_u: 0.5 },
      ctx,
    );
    expect(vertexCount(r)).toBe(32);
    const b = boundsOf(r);
    expect(b.min[0]).toBeCloseTo(-2.25);
    expect(b.max[0]).toBeCloseTo(4.25);
    expect(r.uvs![6][0]).toBeCloseTo(r.uvs![0][0] + 0.5);
  });

  it('declares dependencies on helper objects', () => {
    registerBuiltinModifiers();
    const def = getModifierDef('ARRAY')!;
    const deps = def.dependencies!(
      def.schema.parse({ use_object_offset: true, offset_object: 'a', start_cap: 'b' }),
    );
    expect(deps).toEqual(['a', 'b']);
    expect(def.dependencies!(def.schema.parse({ offset_object: 'a' }))).toEqual([]);
    expect(applyModifier('ARRAY', createCube(), { count: 1 }).faces.length).toBe(6);
  });
});

describe('SOLIDIFY', () => {
  it('turns a plane into a closed slab (inside by default)', () => {
    const r = applyModifier('SOLIDIFY', createPlane(), { thickness: 0.2 });
    expectValidMesh(r);
    expect(meshStats(r)).toMatchObject({ vertices: 8, faces: 6 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(0.8, 10);
    const b = boundsOf(r);
    expect(b.min[2]).toBeCloseTo(-0.2);
    expect(b.max[2]).toBeCloseTo(0);
    const centered = boundsOf(applyModifier('SOLIDIFY', createPlane(), { thickness: 0.2, offset: 0 }));
    expect(centered.min[2]).toBeCloseTo(-0.1);
    expect(centered.max[2]).toBeCloseTo(0.1);
    const outside = boundsOf(applyModifier('SOLIDIFY', createPlane(), { thickness: 0.2, offset: 1 }));
    expect(outside.max[2]).toBeCloseTo(0.2);
  });

  it('builds an inner shell with even thickness', () => {
    const r = applyModifier('SOLIDIFY', createCube(), { thickness: 0.1, use_even_offset: true });
    expect(meshStats(r)).toMatchObject({ vertices: 16, faces: 12 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8 - 1.8 ** 3, 8);
  });

  it('supports rim options, flipping and material offsets', () => {
    const noRim = applyModifier('SOLIDIFY', createPlane(), { thickness: 0.2, use_rim: false });
    expect(noRim.faces.length).toBe(2);
    expect(openEdgeCount(noRim)).toBe(8);
    const rimOnly = applyModifier('SOLIDIFY', createPlane(), { thickness: 0.2, use_rim_only: true });
    expect(meshStats(rimOnly)).toMatchObject({ vertices: 8, faces: 4 });
    const flipped = applyModifier('SOLIDIFY', createPlane(), { thickness: 0.2, use_flip_normals: true });
    expect(signedVolume(flipped)).toBeCloseTo(-0.8, 10);
    const mats = applyModifier('SOLIDIFY', createPlane(), {
      thickness: 0.2,
      material_offset: 1,
      material_offset_rim: 2,
    });
    expect(mats.faceMaterials).toEqual([0, 1, 2, 2, 2, 2]);
    const creased = applyModifier('SOLIDIFY', createPlane(), { thickness: 0.2, edge_crease_rim: 1 });
    expect(Object.values(creased.edgeAttrs).filter((a) => a.crease === 1).length).toBe(4);
  });
});

describe('TRIANGULATE', () => {
  it('triangulates quads keeping winding, volume and UVs', () => {
    const cube = createCube();
    const r = applyModifier('TRIANGULATE', cube);
    expect(meshStats(r)).toMatchObject({ vertices: 8, faces: 12 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8);
    for (let f = 0; f < r.faces.length; f++) {
      const src = cube.faces[Math.floor(f / 2)];
      r.faces[f].forEach((v, i) => {
        const j = src.indexOf(v);
        expect(r.uvs![f].slice(i * 2, i * 2 + 2)).toEqual(
          cube.uvs![Math.floor(f / 2)].slice(j * 2, j * 2 + 2),
        );
      });
    }
  });

  it('honours quad methods and min_vertices', () => {
    // kite: diagonal 0-2 (length 3) is longer than 1-3 (length 2)
    const kite = createMesh({ positions: [0, -1, 0, 1, 0, 0, 0, 2, 0, -1, 0, 0], faces: [[0, 1, 2, 3]] });
    const diag = (m: MeshData) => {
      const [a, b] = m.faces;
      const shared = a.filter((v) => b.includes(v)).sort();
      return shared.join('-');
    };
    expect(diag(applyModifier('TRIANGULATE', kite, { quad_method: 'FIXED' }))).toBe('0-2');
    expect(diag(applyModifier('TRIANGULATE', kite, { quad_method: 'FIXED_ALTERNATE' }))).toBe('1-3');
    expect(diag(applyModifier('TRIANGULATE', kite, { quad_method: 'SHORTEST_DIAGONAL' }))).toBe('1-3');
    expect(diag(applyModifier('TRIANGULATE', kite, { quad_method: 'LONGEST_DIAGONAL' }))).toBe('0-2');
    expect(applyModifier('TRIANGULATE', createCube(), { min_vertices: 5 }).faces.length).toBe(6);
  });

  it('triangulates n-gons with ear clipping and beauty flips', () => {
    const ngon = createCircle({ vertices: 16, fill_type: 'NGON' });
    for (const method of ['CLIP', 'BEAUTY'] as const) {
      const r = applyModifier('TRIANGULATE', ngon, { ngon_method: method });
      expect(r.faces.length).toBe(14);
      for (let f = 0; f < r.faces.length; f++) expect(faceNormal(r, f)[2]).toBeCloseTo(1);
    }
    const minAngle = (m: MeshData) => {
      let best = Math.PI;
      for (const f of m.faces) {
        for (let i = 0; i < 3; i++) {
          const a = vertexAt(m, f[i]);
          const b = vertexAt(m, f[(i + 1) % 3]);
          const c = vertexAt(m, f[(i + 2) % 3]);
          const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
          best = Math.min(best, Math.acos(cos));
        }
      }
      return best;
    };
    const beauty = minAngle(applyModifier('TRIANGULATE', ngon, { ngon_method: 'BEAUTY' }));
    expect(beauty).toBeGreaterThanOrEqual(
      minAngle(applyModifier('TRIANGULATE', ngon, { ngon_method: 'CLIP' })) - 1e-9,
    );
  });
});

describe('WELD', () => {
  // two quads that should share an edge, but the shared vertices are duplicated with a tiny gap
  const split = createMesh({
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1.0004, 0, 0, 2, 0, 0, 2, 1, 0, 1.0004, 1, 0],
    faces: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  });

  it('merges close vertices (ALL)', () => {
    const r = applyModifier('WELD', split);
    expect(vertexCount(r)).toBe(6);
    expect(openEdgeCount(r)).toBe(6);
    expect(applyModifier('WELD', split, { merge_threshold: 0.0001 })).toBe(split);
  });

  it('only collapses short edges in CONNECTED mode', () => {
    expect(vertexCount(applyModifier('WELD', split, { mode: 'CONNECTED' }))).toBe(8);
    const shortEdge = createMesh({
      positions: [0, 0, 0, 1, 0, 0, 1, 0.0005, 0, 0, 1, 0],
      faces: [[0, 1, 2, 3]],
    });
    const r = applyModifier('WELD', shortEdge, { mode: 'CONNECTED' });
    expect(meshStats(r)).toMatchObject({ vertices: 3, faces: 1 });
    expect(vertexAt(r, 1)[1]).toBeCloseTo(0.00025);
  });
});

it('generate modifiers keep closed inputs closed', () => {
  const cube = createCube();
  for (const [type, params] of [
    ['SUBSURF', { levels: 2 }],
    ['ARRAY', { count: 2 }],
    ['SOLIDIFY', { thickness: 0.2 }],
    ['TRIANGULATE', {}],
    ['WELD', {}],
  ] as const) {
    expect(isClosedManifold(applyModifier(type, cube, params))).toBe(true);
  }
  const grid = createGrid({ x_subdivisions: 2, y_subdivisions: 2 });
  expect(isClosedManifold(applyModifier('SOLIDIFY', grid, { thickness: 0.1 }))).toBe(true);
});
