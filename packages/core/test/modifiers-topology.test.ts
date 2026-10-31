import { describe, expect, it } from 'vitest';
import {
  countInconsistentEdges,
  createCube,
  createCylinder,
  createGrid,
  createIcoSphere,
  createMesh,
  createUVSphere,
  edgeKey,
  faceCenter,
  faceIslands,
  faceNormal,
  getModifierDef,
  meshStats,
  registerBuiltinModifiers,
  vertexCount,
  type MeshData,
} from '../src';
import {
  applyModifier,
  boundsOf,
  expectClosedConsistent,
  expectValidMesh,
  openEdgeCount,
  signedVolume,
  vertexAt,
} from './modifiers-helpers';

/** Wire profile: a single loose edge. */
function line(a: number[], b: number[]): MeshData {
  return createMesh({ positions: [...a, ...b], looseEdges: [0, 1] });
}

describe('SCREW', () => {
  it('lathes a wire profile into a tube with outward normals', () => {
    const r = applyModifier('SCREW', line([1, 0, -1], [1, 0, 1]));
    expectValidMesh(r);
    expect(meshStats(r)).toMatchObject({ vertices: 32, faces: 16 });
    expect(countInconsistentEdges(r)).toBe(0);
    expect(openEdgeCount(r)).toBe(32);
    for (let f = 0; f < r.faces.length; f++) {
      const n = faceNormal(r, f);
      const c = faceCenter(r, f);
      expect(n[0] * c[0] + n[1] * c[1]).toBeGreaterThan(0);
    }
    const flipped = applyModifier('SCREW', line([1, 0, -1], [1, 0, 1]), { use_normal_flip: true });
    const n = faceNormal(flipped, 0);
    const c = faceCenter(flipped, 0);
    expect(n[0] * c[0] + n[1] * c[1]).toBeLessThan(0);
  });

  it('sweeps face profiles into closed solids (with caps for partial angles)', () => {
    const square = createMesh({
      positions: [1, 0, -0.5, 2, 0, -0.5, 2, 0, 0.5, 1, 0, 0.5],
      faces: [[0, 1, 2, 3]],
    });
    const half = applyModifier('SCREW', square, { angle: Math.PI });
    expect(meshStats(half)).toMatchObject({ vertices: 68, faces: 66 });
    expectClosedConsistent(half);
    expect(signedVolume(half)).toBeCloseTo(16 * 0.5 * 3 * Math.sin(Math.PI / 16), 8);
    const full = applyModifier('SCREW', square);
    expect(meshStats(full)).toMatchObject({ vertices: 64, faces: 64 });
    expectClosedConsistent(full);
    expect(signedVolume(full)).toBeCloseTo(16 * 0.5 * 3 * Math.sin((2 * Math.PI) / 16), 8);
    // reversed profile winding and negative angles still give outward normals
    const reversed = { ...square, faces: [[3, 2, 1, 0]] };
    expect(signedVolume(applyModifier('SCREW', reversed, { angle: -Math.PI / 2 }))).toBeGreaterThan(0);
  });

  it('merges on-axis vertices, supports helices and render steps', () => {
    const cone = applyModifier('SCREW', line([0, 0, 1], [1, 0, 0]), { use_merge_vertices: true });
    expect(meshStats(cone)).toMatchObject({ vertices: 17, faces: 16 });
    expect(cone.faces.every((f) => f.length === 3)).toBe(true);
    expect(countInconsistentEdges(cone)).toBe(0);
    const helix = applyModifier('SCREW', line([1, 0, 0], [1, 0, 0.5]), { screw_offset: 1, iterations: 2 });
    expect(vertexCount(helix)).toBe(66);
    expect(boundsOf(helix).max[2]).toBeCloseTo(2.5);
    const p = { steps: 4, render_steps: 8 };
    expect(vertexCount(applyModifier('SCREW', line([1, 0, 0], [1, 0, 1]), p))).toBe(8);
    expect(vertexCount(applyModifier('SCREW', line([1, 0, 0], [1, 0, 1]), p, { forRender: true }))).toBe(16);
    // closed meshes have nothing to sweep
    const cube = createCube();
    expect(applyModifier('SCREW', cube)).toBe(cube);
  });
});

describe('WIREFRAME', () => {
  it('turns a cube into a closed frame of beams', () => {
    const r = applyModifier('WIREFRAME', createCube(), { thickness: 0.1 });
    expectValidMesh(r);
    expect(meshStats(r)).toMatchObject({ vertices: 64, faces: 72 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeGreaterThan(0);
    expect(boundsOf(r).max[0]).toBeCloseTo(1.05);
    const kept = applyModifier('WIREFRAME', createCube(), { thickness: 0.1, use_replace: false });
    expect(meshStats(kept)).toMatchObject({ vertices: 72, faces: 78 });
  });

  it('closes open boundaries on request and supports creases and material offsets', () => {
    const grid = createGrid({ x_subdivisions: 2, y_subdivisions: 2 });
    const open = applyModifier('WIREFRAME', grid);
    expect(openEdgeCount(open)).toBeGreaterThan(0);
    const closed = applyModifier('WIREFRAME', grid, { use_boundary: true });
    expectClosedConsistent(closed);
    const creased = applyModifier('WIREFRAME', createCube(), { use_crease: true, material_offset: 1 });
    // 12 outer + 12 inner beam edges shared by two faces, plus 24 + 24 edges around the face openings
    expect(Object.values(creased.edgeAttrs).filter((a) => a.crease === 1).length).toBe(72);
    expect(creased.faceMaterials.every((m) => m === 1)).toBe(true);
  });
});

describe('EDGE_SPLIT', () => {
  it('splits sharp edges so faces no longer share them', () => {
    const cube = createCube();
    const r = applyModifier('EDGE_SPLIT', cube);
    expectValidMesh(r);
    expect(meshStats(r)).toMatchObject({ vertices: 24, faces: 6 });
    expect(faceIslands(r).count).toBe(6);
    expect(signedVolume(r)).toBeCloseTo(8);
    for (let f = 0; f < 6; f++)
      for (let i = 0; i < 4; i++)
        expect(vertexAt(r, r.faces[f][i])).toEqual(vertexAt(cube, cube.faces[f][i]));
    expect(applyModifier('EDGE_SPLIT', cube, { split_angle: (100 * Math.PI) / 180 })).toBe(cube);
  });

  it('splits along edges marked sharp', () => {
    const grid = createGrid({ x_subdivisions: 2, y_subdivisions: 2 });
    grid.edgeAttrs = { [edgeKey(1, 4)]: { sharp: true }, [edgeKey(4, 7)]: { sharp: true } };
    const r = applyModifier('EDGE_SPLIT', grid, { use_edge_angle: false });
    expect(vertexCount(r)).toBe(12);
    expect(faceIslands(r).count).toBe(2);
    expect(Object.values(r.edgeAttrs).filter((a) => a.sharp).length).toBe(4);
    expect(applyModifier('EDGE_SPLIT', grid, { use_edge_angle: false, use_edge_sharp: false })).toBe(grid);
  });
});

describe('BUILD', () => {
  const p = { frame_start: 1, frame_duration: 6 };
  it('shows a growing subset of faces over time', () => {
    registerBuiltinModifiers();
    expect(getModifierDef('BUILD')!.timeDependent).toBe(true);
    const cube = createCube();
    expect(meshStats(applyModifier('BUILD', cube, p, { frame: 1 }))).toMatchObject({ vertices: 0, faces: 0 });
    const mid = applyModifier('BUILD', cube, p, { frame: 4 });
    expect(mid.faces.length).toBe(3);
    expectValidMesh(mid);
    expect(applyModifier('BUILD', cube, p, { frame: 10 })).toBe(cube);
    expect(applyModifier('BUILD', cube, { ...p, use_reverse: true }, { frame: 4 }).faces.length).toBe(3);
    expect(applyModifier('BUILD', cube, { ...p, use_reverse: true }, { frame: 5 }).faces.length).toBe(2);
  });

  it('supports a seeded random order', () => {
    const sphere = createUVSphere({ segments: 8, ring_count: 4 });
    const a = applyModifier('BUILD', sphere, { ...p, use_random_order: true, seed: 1 }, { frame: 3 });
    const b = applyModifier('BUILD', sphere, { ...p, use_random_order: true, seed: 1 }, { frame: 3 });
    const c = applyModifier('BUILD', sphere, { ...p, use_random_order: true, seed: 2 }, { frame: 3 });
    expect(a).toEqual(b);
    expect(a.faces.length).toBe(c.faces.length);
    expect(a.positions).not.toEqual(c.positions);
  });
});

describe('DECIMATE', () => {
  it('collapses edges down to the requested ratio keeping a closed surface', () => {
    const sphere = { ...createUVSphere({ segments: 32, ring_count: 16 }), uvs: null };
    const tris = meshStats(sphere).triangles;
    const r = applyModifier('DECIMATE', sphere, { ratio: 0.5, use_collapse_triangulate: true });
    expectValidMesh(r);
    expect(r.faces.length).toBeLessThanOrEqual(Math.floor(tris * 0.5));
    expect(r.faces.length).toBeGreaterThan(tris * 0.4);
    expectClosedConsistent(r);
    const v0 = signedVolume(sphere);
    expect(Math.abs(signedVolume(r) - v0) / v0).toBeLessThan(0.05);
    expect(applyModifier('DECIMATE', sphere, { ratio: 1 })).toBe(sphere);
  });

  it('preserves open boundaries and UVs', () => {
    const grid = createGrid({ x_subdivisions: 8, y_subdivisions: 8 });
    const r = applyModifier('DECIMATE', grid, { ratio: 0.25 });
    expectValidMesh(r);
    expect(meshStats(r).triangles).toBeLessThanOrEqual(32);
    const b = boundsOf(r);
    expect(b.min.slice(0, 2)).toEqual([-1, -1]);
    expect(b.max.slice(0, 2)).toEqual([1, 1]);
    for (let f = 0; f < r.faces.length; f++) expect(faceNormal(r, f)[2]).toBeCloseTo(1);
    // UVs of a planar grid stay a linear function of the position
    for (let f = 0; f < r.faces.length; f++) {
      r.faces[f].forEach((v, i) => {
        const [x, y] = vertexAt(r, v);
        expect(r.uvs![f][i * 2]).toBeCloseTo((x + 1) / 2, 6);
        expect(r.uvs![f][i * 2 + 1]).toBeCloseTo((y + 1) / 2, 6);
      });
    }
  });

  it('dissolves coplanar faces into n-gons (planar decimation)', () => {
    const dense = applyModifier('SUBSURF', createCube(), { levels: 2, subdivision_type: 'SIMPLE' });
    const r = applyModifier('DECIMATE', dense, { decimate_type: 'DISSOLVE' });
    expect(meshStats(r)).toMatchObject({ vertices: 8, faces: 6 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8);
    // delimit by material keeps the material regions apart
    const mats = { ...dense, faceMaterials: dense.faces.map((_, f) => (f % 2 === 0 ? 0 : 1)) };
    const split = applyModifier('DECIMATE', mats, { decimate_type: 'DISSOLVE', delimit: ['MATERIAL'] });
    expect(split.faces.length).toBeGreaterThan(6);
    expectClosedConsistent(split);
    const ico = createIcoSphere();
    expect(applyModifier('DECIMATE', ico, { decimate_type: 'DISSOLVE' }).faces.length).toBe(ico.faces.length);
  });

  it('un-subdivides quad grids', () => {
    const cube = createCube();
    const once = applyModifier('SUBSURF', cube, { levels: 1, subdivision_type: 'SIMPLE' });
    const r = applyModifier('DECIMATE', once, { decimate_type: 'UNSUBDIV', iterations: 1 });
    expect(meshStats(r)).toMatchObject({ vertices: 8, faces: 6 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8);
    const twice = applyModifier('SUBSURF', cube, { levels: 2, subdivision_type: 'SIMPLE' });
    expect(
      meshStats(applyModifier('DECIMATE', twice, { decimate_type: 'UNSUBDIV', iterations: 2 })),
    ).toMatchObject({ vertices: 8, faces: 6 });
    const tris = applyModifier('TRIANGULATE', cube);
    expect(applyModifier('DECIMATE', tris, { decimate_type: 'UNSUBDIV', iterations: 1 })).toBe(tris);
  });
});

describe('BEVEL', () => {
  it('chamfers all cube edges into a closed mesh', () => {
    const r = applyModifier('BEVEL', createCube());
    expectValidMesh(r);
    expect(meshStats(r)).toMatchObject({ vertices: 24, faces: 26 });
    expectClosedConsistent(r);
    expect(r.faces.filter((f) => f.length === 3).length).toBe(8);
    const v = signedVolume(r);
    expect(v).toBeGreaterThan(7.87);
    expect(v).toBeLessThan(7.9);
    const b = boundsOf(r);
    expect(b.max).toEqual([1, 1, 1]);
  });

  it('rounds with several segments', () => {
    const flat = signedVolume(applyModifier('BEVEL', createCube(), { width: 0.2 }));
    const r = applyModifier('BEVEL', createCube(), { width: 0.2, segments: 3 });
    expectClosedConsistent(r);
    expect(r.faces.length).toBe(6 + 12 * 3 + 8 * 9);
    const v = signedVolume(r);
    expect(v).toBeGreaterThan(flat);
    expect(v).toBeLessThan(8);
  });

  it('respects the angle limit and partial bevels stay closed', () => {
    const cube = createCube();
    expect(applyModifier('BEVEL', cube, { angle_limit: (100 * Math.PI) / 180 })).toBe(cube);
    const cyl = createCylinder({ vertices: 16 });
    const r = applyModifier('BEVEL', cyl, { width: 0.05 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeLessThan(signedVolume(cyl));
    expect(signedVolume(r)).toBeGreaterThan(signedVolume(cyl) * 0.97);
  });

  it('bevels vertices and assigns the bevel material', () => {
    const r = applyModifier('BEVEL', createCube(), { affect: 'VERTICES' });
    expect(meshStats(r)).toMatchObject({ vertices: 24, faces: 14 });
    expectClosedConsistent(r);
    expect(signedVolume(r)).toBeCloseTo(8 - (8 * 0.1 ** 3) / 6, 8);
    const mat = applyModifier('BEVEL', createCube(), { material: 1 });
    expect(mat.faceMaterials.filter((m) => m === 1).length).toBe(20);
  });
});
