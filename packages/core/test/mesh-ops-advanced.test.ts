import { describe, expect, it } from 'vitest';
import {
  appendMesh,
  bevel,
  bridgeEdgeLoops,
  countInconsistentEdges,
  createCircle,
  createCube,
  createCylinder,
  createGrid,
  createIcoSphere,
  createMesh,
  createPlane,
  createUVSphere,
  edgeKey,
  emptySelection,
  eulerCharacteristic,
  faceCenter,
  faceNormal,
  insetFaces,
  isClosedManifold,
  loopSelect,
  meshStats,
  profileExponent,
  profilePoints,
  rotationFromEuler,
  selectAllElements,
  selectionFromEdges,
  selectionFromFaces,
  selectionFromVerts,
  solidifyFaces,
  spin,
  symmetrize,
  usedVertices,
  validateMesh,
  vertexCount,
  type MeshData,
} from '../src';

function check(m: MeshData, closed?: boolean): void {
  expect(validateMesh(m)).toEqual([]);
  expect(countInconsistentEdges(m)).toBe(0);
  if (closed !== undefined) expect(isClosedManifold(m)).toBe(closed);
  // No orphaned vertices (inputs in these tests have none either).
  expect(usedVertices(m).every((u) => u === 1)).toBe(true);
}

function outward(m: MeshData, center: [number, number, number] = [0, 0, 0]): boolean {
  return m.faces.every((_, f) => {
    const n = faceNormal(m, f);
    const c = faceCenter(m, f);
    return n[0] * (c[0] - center[0]) + n[1] * (c[1] - center[1]) + n[2] * (c[2] - center[2]) > -1e-9;
  });
}

const verts = (m: MeshData) =>
  Array.from({ length: vertexCount(m) }, (_, i) => [
    m.positions[i * 3],
    m.positions[i * 3 + 1],
    m.positions[i * 3 + 2],
  ]);

function richCube(): MeshData {
  const m = createCube();
  m.colors = new Array(8 * 4).fill(0.5);
  m.edgeAttrs[edgeKey(0, 1)] = { seam: true };
  return m;
}

describe('bevel', () => {
  it('bevels all edges of a cube with one segment', () => {
    const c = richCube();
    const r = bevel(c, selectAllElements(c), { offset: 0.2 });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 24, faces: 26, edges: 48 });
    check(r.mesh, true);
    expect(eulerCharacteristic(r.mesh)).toBe(2);
    expect(outward(r.mesh)).toBe(true);
    // Every vertex lies on the cube surface, 0.2 away from two of the original edges.
    for (const p of verts(r.mesh)) {
      const a = p.map(Math.abs).sort((x, y) => y - x);
      expect(a[0]).toBeCloseTo(1);
      expect(a[1]).toBeCloseTo(0.8);
      expect(a[2]).toBeCloseTo(0.8);
    }
    expect(r.selection.faces.size).toBe(20); // 12 strips + 8 corners
    expect(r.mesh.colors).toHaveLength(24 * 4);
  });

  it('makes round bevels with more segments (circular profiles, spherical corners)', () => {
    const c = createCube();
    for (const segments of [2, 3, 4]) {
      const r = bevel(c, selectAllElements(c), { offset: 0.2, segments });
      check(r.mesh, true);
      expect(outward(r.mesh)).toBe(true);
      for (const p of verts(r.mesh)) {
        // Distance from the rounded "core" box [-0.8, 0.8]^3 is the bevel radius everywhere
        // except on the flat faces (which touch the original cube surface).
        const d = Math.hypot(...p.map((x) => Math.max(0, Math.abs(x) - 0.8)));
        expect(d).toBeCloseTo(0.2, 6);
      }
    }
    expect(meshStats(bevel(c, selectAllElements(c), { offset: 0.2, segments: 3 }).mesh)).toMatchObject({
      vertices: 80,
    });
  });

  it('bevels a single edge like Blender (end faces become pentagons)', () => {
    const c = createCube();
    const r = bevel(c, selectionFromEdges(c, [edgeKey(1, 5)]), { offset: 0.25 });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 10, faces: 7 });
    check(r.mesh, true);
    expect(r.mesh.faces.filter((f) => f.length === 5)).toHaveLength(2);
    // Edge 1-5 runs along x at y=-1, z=1: new rails at y=-0.75 (top) and z=0.75 (front).
    const rails = verts(r.mesh).filter(
      (p) =>
        Math.abs(Math.abs(p[0]) - 1) < 1e-9 && (Math.abs(p[1] + 0.75) < 1e-9 || Math.abs(p[2] - 0.75) < 1e-9),
    );
    expect(rails).toHaveLength(4);
    const round = bevel(c, selectionFromEdges(c, [edgeKey(1, 5)]), { offset: 0.25, segments: 4 });
    check(round.mesh, true);
    expect(round.mesh.faces.filter((f) => f.length === 8)).toHaveLength(2);
    const chamfer = bevel(c, selectionFromEdges(c, [edgeKey(1, 5)]), {
      offset: 0.25,
      segments: 4,
      profile: 0.25,
    });
    // A 0.25 profile is a straight chamfer: all profile points satisfy y + (1 - z) ... on the line.
    for (const p of verts(chamfer.mesh))
      if (p[1] < -0.75 + 1e-9 && p[2] > 0.75 - 1e-9) expect(p[1] - p[2]).toBeCloseTo(-1.75);
  });

  it('bevels edge loops, L-junctions and edges of open meshes', () => {
    const c = createCube();
    const loop = bevel(c, selectionFromFaces(c, [5]), { offset: 0.2, segments: 3 });
    check(loop.mesh, true);
    const corner = bevel(c, selectionFromEdges(c, [edgeKey(1, 5), edgeKey(5, 7)]), {
      offset: 0.2,
      segments: 3,
    });
    check(corner.mesh, true);
    expect(
      meshStats(bevel(c, selectionFromEdges(c, [edgeKey(1, 5), edgeKey(5, 7)]), { offset: 0.2 }).mesh),
    ).toMatchObject({
      vertices: 11,
      faces: 8,
    });
    const g = createGrid({ x_subdivisions: 4, y_subdivisions: 4 });
    const gl = bevel(g, loopSelect(g, emptySelection(), [5, 6], { mode: 'EDGE' }), {
      offset: 0.1,
      segments: 2,
    });
    check(gl.mesh, false);
    expect(eulerCharacteristic(gl.mesh)).toBe(1);
  });

  it('bevels vertices', () => {
    const c = createCube();
    const one = bevel(c, selectionFromVerts(c, [0]), { offset: 0.3, affect: 'VERTICES' });
    expect(meshStats(one.mesh)).toMatchObject({ vertices: 10, faces: 7 });
    check(one.mesh, true);
    const all = bevel(c, selectAllElements(c), { offset: 0.3, affect: 'VERTICES' });
    expect(meshStats(all.mesh)).toMatchObject({ vertices: 24, faces: 14 });
    check(all.mesh, true);
    const round = bevel(c, selectionFromVerts(c, [0]), { offset: 0.3, affect: 'VERTICES', segments: 3 });
    check(round.mesh, true);
  });

  it('supports width and depth offsets and other primitives', () => {
    const c = createCube();
    const w = bevel(c, selectAllElements(c), { offset: 0.2 * Math.SQRT2, offsetType: 'WIDTH' });
    for (const p of verts(w.mesh)) expect(p.map(Math.abs).sort((x, y) => y - x)[1]).toBeCloseTo(0.8);
    const d = bevel(c, selectAllElements(c), { offset: 0.2 / Math.SQRT2, offsetType: 'DEPTH' });
    for (const p of verts(d.mesh)) expect(p.map(Math.abs).sort((x, y) => y - x)[1]).toBeCloseTo(0.8);
    for (const m of [
      createCylinder({ vertices: 8 }),
      createIcoSphere({ subdivisions: 1 }),
      createUVSphere({ segments: 8, ring_count: 4 }),
    ]) {
      const r = bevel(m, selectAllElements(m), { offset: 0.05, segments: 2 });
      check(r.mesh, true);
      expect(eulerCharacteristic(r.mesh)).toBe(2);
    }
    expect(() => bevel(createPlane(), selectAllElements(createPlane()), { offset: 0.1 })).toThrow(
      /manifold edges/,
    );
  });

  it('computes superellipse profiles', () => {
    expect(profileExponent(0.5)).toBeCloseTo(2);
    expect(profileExponent(0.25)).toBeCloseTo(1);
    const pts = profilePoints([1, 0, 0], [0, 1, 0], [1, 1, 0], 2, 2);
    // Quarter circle around (0,0,0) from A to B bulging towards V.
    expect(Math.hypot(pts[0][0], pts[0][1])).toBeCloseTo(1);
  });
});

describe('bridge edge loops', () => {
  it('bridges two inset faces into a tunnel through a cube', () => {
    const c = createCube();
    const ins = insetFaces(c, selectionFromFaces(c, [4, 5]), { thickness: 0.3, individual: true });
    const r = bridgeEdgeLoops(ins.mesh, ins.selection);
    check(r.mesh, true);
    expect(eulerCharacteristic(r.mesh)).toBe(0); // genus 1
    expect(r.selection.faces.size).toBe(4);
    const cut = bridgeEdgeLoops(ins.mesh, ins.selection, { cuts: 3 });
    check(cut.mesh, true);
    expect(cut.selection.faces.size).toBe(16);
  });

  it('bridges free edge loops into a tube facing outwards', () => {
    const m = createCircle({ vertices: 8 });
    appendMesh(m, createCircle({ vertices: 8 }), (p) => [p[0], p[1], p[2] + 2]);
    const r = bridgeEdgeLoops(m, selectAllElements(m));
    check(r.mesh, false);
    expect(r.mesh.faces).toHaveLength(8);
    expect(outward(r.mesh, [0, 0, 1])).toBe(true);
    const twisted = bridgeEdgeLoops(m, selectAllElements(m), { twist: 1 });
    check(twisted.mesh, false);
  });

  it('joins loops with different vertex counts using triangles', () => {
    const m = createCircle({ vertices: 8 });
    appendMesh(m, createCircle({ vertices: 5, radius: 0.5 }), (p) => [p[0], p[1], p[2] + 1]);
    const r = bridgeEdgeLoops(m, selectAllElements(m));
    check(r.mesh, false);
    expect(r.mesh.faces).toHaveLength(13);
    expect(r.mesh.faces.every((f) => f.length === 3)).toBe(true);
  });

  it('bridges open chains and rejects bad selections', () => {
    const m = createMesh({
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0],
      looseEdges: [0, 1, 1, 2, 3, 4, 4, 5],
    });
    const r = bridgeEdgeLoops(m, selectAllElements(m));
    expect(r.mesh.faces).toHaveLength(2);
    check(r.mesh, false);
    expect(() => bridgeEdgeLoops(m, selectionFromEdges(m, [edgeKey(0, 1)]))).toThrow(/two edge loops/);
  });
});

describe('spin', () => {
  it('lathes a wire profile into a closed surface of revolution', () => {
    const prof = createMesh({ positions: [1, 0, -1, 1.5, 0, 0, 1, 0, 1], looseEdges: [0, 1, 1, 2] });
    const r = spin(prof, selectAllElements(prof), { steps: 12, angle: 2 * Math.PI });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 36, faces: 24 });
    check(r.mesh, false);
    expect(outward(r.mesh)).toBe(true);
    const quarter = spin(prof, selectAllElements(prof), { steps: 4, angle: Math.PI / 2 });
    expect(meshStats(quarter.mesh)).toMatchObject({ vertices: 15, faces: 8 });
    // The last step is selected and rotated by 90°.
    for (const v of quarter.selection.verts) expect(quarter.mesh.positions[v * 3]).toBeCloseTo(0);
  });

  it('sweeps faces into solids and supports world-space axes', () => {
    const sq = createMesh({ positions: [1, 0, 0, 2, 0, 0, 2, 0, 1, 1, 0, 1], faces: [[0, 1, 2, 3]] });
    const torus = spin(sq, selectAllElements(sq), { steps: 8, angle: 2 * Math.PI });
    check(torus.mesh, true);
    expect(eulerCharacteristic(torus.mesh)).toBe(0);
    const half = spin(sq, selectAllElements(sq), { steps: 6, angle: Math.PI });
    check(half.mesh, true);
    expect(eulerCharacteristic(half.mesh)).toBe(2);
    // Object rotated 90° about X: the world Z axis is the local -Y axis.
    const rot = spin(sq, selectAllElements(sq), {
      steps: 2,
      angle: Math.PI,
      axis: [0, 0, 1],
      matrix: rotationFromEuler([Math.PI / 2, 0, 0]),
    });
    check(rot.mesh, true);
    const dupli = spin(sq, selectAllElements(sq), { steps: 3, angle: Math.PI, dupli: true });
    expect(dupli.mesh.faces).toHaveLength(4);
    // Sweeping a region with interior vertices leaves no orphaned intermediate copies.
    const grid = createGrid({ x_subdivisions: 3, y_subdivisions: 3 });
    const swept = spin(grid, selectAllElements(grid), {
      steps: 4,
      angle: Math.PI / 2,
      center: [0, 0, -2],
      axis: [1, 0, 0],
    });
    check(swept.mesh, true);
    expect(vertexCount(swept.mesh)).toBe(16 + 3 * 12 + 16);
  });
});

describe('symmetrize', () => {
  it('cuts and mirrors a cube', () => {
    const c = createCube();
    const r = symmetrize(c, emptySelection(), 'NEGATIVE_X');
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 12, faces: 10 });
    check(r.mesh, true);
    expect(outward(r.mesh)).toBe(true);
  });

  it('copies the source half onto the other side', () => {
    const m = createUVSphere({ segments: 8, ring_count: 6 });
    // Deform the -X side only.
    for (let i = 0; i < vertexCount(m); i++) if (m.positions[i * 3] < -0.1) m.positions[i * 3] *= 1.5;
    const r = symmetrize(m, emptySelection(), 'NEGATIVE_X');
    check(r.mesh, true);
    const pts = verts(r.mesh);
    for (const p of pts)
      expect(
        pts.some(
          (q) => Math.abs(q[0] + p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9 && Math.abs(q[2] - p[2]) < 1e-9,
        ),
      ).toBe(true);
    // The +X extent now equals the (deformed) -X extent.
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(Math.max(...verts(m).map((p) => -p[0])), 6);
    const pz = symmetrize(createCube(), emptySelection(), 'POSITIVE_Z');
    check(pz.mesh, true);
  });

  it('limits the operation to the selected faces without leaving cracks', () => {
    const c = createCube();
    const r = symmetrize(c, selectionFromFaces(c, [3]), 'NEGATIVE_X');
    check(r.mesh, true);
    // The +Y face is now two mirrored halves welded to the untouched geometry; its neighbours
    // received the cut vertices.
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 10, faces: 7 });
    expect(r.selection.faces.size).toBe(2);
    // A selected island is symmetrized on its own.
    const two = createCube();
    appendMesh(two, createUVSphere({ segments: 8, ring_count: 4 }), (p) => [
      p[0] * 0.5 - 0.2,
      p[1],
      p[2] + 4,
    ]);
    const island = symmetrize(
      two,
      selectionFromFaces(two, two.faces.map((_, f) => f).slice(6)),
      'POSITIVE_X',
    );
    check(island.mesh, true);
    const ys = verts(island.mesh).filter((p) => p[2] > 2);
    for (const p of ys)
      expect(ys.some((q) => Math.abs(q[0] + p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9)).toBe(true);
  });
});

describe('solidify', () => {
  it('turns a plane into a closed box', () => {
    const p = createPlane();
    const r = solidifyFaces(p, selectAllElements(p), 0.2);
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 8, faces: 6 });
    check(r.mesh, true);
    expect(outward(r.mesh, [0, 0, -0.1])).toBe(true);
    expect(Math.min(...verts(r.mesh).map((q) => q[2]))).toBeCloseTo(-0.2);
    const g = createGrid({ x_subdivisions: 3, y_subdivisions: 3 });
    const rg = solidifyFaces(g, selectAllElements(g), 0.1);
    check(rg.mesh, true);
  });
});
