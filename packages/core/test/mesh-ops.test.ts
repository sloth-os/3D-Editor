import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  countInconsistentEdges,
  createCube,
  createCylinder,
  createGrid,
  createIcoSphere,
  createMesh,
  createPlane,
  createUVSphere,
  deleteGeometry,
  dissolveEdges,
  dissolveFaces,
  dissolveVerts,
  duplicateSelection,
  edgeFaceAdd,
  edgeKey,
  emptySelection,
  eulerCharacteristic,
  extrudeEdgesOnly,
  extrudeIndividualFaces,
  extrudeRegion,
  extrudeVerticesOnly,
  faceArea,
  faceCenter,
  faceNormal,
  fillHoles,
  flipNormals,
  insetFaces,
  isClosedManifold,
  loopCut,
  makeNormalsConsistent,
  markSeam,
  markSharp,
  meshStats,
  mergeVertices,
  pokeFaces,
  quadsToTris,
  removeDoubles,
  selectAllElements,
  selectionFromEdges,
  selectionFromFaces,
  selectionFromVerts,
  separateMesh,
  setEdgeCrease,
  smoothVertices,
  splitSelection,
  subdivide,
  trisToQuads,
  usedVertices,
  validateMesh,
  vertexCount,
  type MeshData,
} from '../src';

/** Structural validity + consistent winding (+ optional closedness). */
function check(m: MeshData, closed?: boolean): void {
  expect(validateMesh(m)).toEqual([]);
  expect(countInconsistentEdges(m)).toBe(0);
  if (closed !== undefined) expect(isClosedManifold(m)).toBe(closed);
  // No orphaned vertices (inputs in these tests have none either).
  expect(usedVertices(m).every((u) => u === 1)).toBe(true);
}

/** For star-shaped meshes around the origin: all faces point away from the center. */
function outward(m: MeshData): boolean {
  return m.faces.every((_, f) => {
    const n = faceNormal(m, f);
    const c = faceCenter(m, f);
    return n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > -1e-9;
  });
}

/** Cube with vertex colors and edge attributes so attribute propagation is exercised. */
function richCube(): MeshData {
  const m = createCube();
  m.colors = [];
  for (let i = 0; i < 8; i++) m.colors.push(i / 8, 0.5, 1 - i / 8, 1);
  m.edgeAttrs[edgeKey(1, 5)] = { seam: true, crease: 0.5 };
  m.faceMaterials[5] = 1;
  m.faceSmooth[5] = true;
  return m;
}

const TOP = 5; // +Z face of createCube: [1, 5, 7, 3]
const PLUS_Y = 3;

const maxZ = (m: MeshData) => Math.max(...m.positions.filter((_, i) => i % 3 === 2));

describe('extrude', () => {
  it('extrudes the top face of a cube as a region', () => {
    const c = richCube();
    const r = extrudeRegion(c, selectionFromFaces(c, [TOP]), { offset: [0, 0, 1] });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 12, faces: 10, edges: 20 });
    check(r.mesh, true);
    expect(eulerCharacteristic(r.mesh)).toBe(2);
    expect(outward(r.mesh)).toBe(true);
    expect(maxZ(r.mesh)).toBeCloseTo(2);
    // The moved face keeps its material/smooth flags and is the new selection.
    expect([...r.selection.faces]).toEqual([TOP]);
    expect(r.mesh.faceMaterials[TOP]).toBe(1);
    expect(r.mesh.faceSmooth[TOP]).toBe(true);
    for (const v of r.selection.verts) expect(r.mesh.positions[v * 3 + 2]).toBeCloseTo(2);
    // Side walls take the region face's material.
    expect(r.mesh.faceMaterials.filter((x) => x === 1)).toHaveLength(5);
    expect(r.mesh.colors).toHaveLength(12 * 4);
  });

  it('extrudes a two-face region with walls only on the region boundary', () => {
    const c = createCube();
    const r = extrudeRegion(c, selectionFromFaces(c, [TOP, PLUS_Y]), { normalOffset: 0.5, evenOffset: true });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 14, faces: 12 });
    check(r.mesh, true);
    expect(outward(r.mesh)).toBe(true);
    expect(maxZ(r.mesh)).toBeCloseTo(1.5);
    expect(Math.max(...r.mesh.positions.filter((_, i) => i % 3 === 1))).toBeCloseTo(1.5);
  });

  it('extrudes faces individually', () => {
    const c = createCube();
    const r = extrudeIndividualFaces(c, selectionFromFaces(c, [TOP, PLUS_Y]), 0.5);
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 16, faces: 14 });
    check(r.mesh, true);
    expect(r.selection.faces.size).toBe(2);
    expect(maxZ(r.mesh)).toBeCloseTo(1.5);
  });

  it('extrudes a plane into an open box and keeps consistent winding', () => {
    const p = createPlane();
    const r = extrudeRegion(p, selectionFromFaces(p, [0]), { offset: [0, 0, 1] });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 8, faces: 5 });
    check(r.mesh, false);
    expect(faceNormal(r.mesh, 0)[2]).toBeCloseTo(1);
  });

  it('extrudes edges and vertices', () => {
    const p = createPlane();
    const e = extrudeEdgesOnly(p, selectionFromEdges(p, [edgeKey(1, 2)]), { offset: [1, 0, 0] });
    expect(meshStats(e.mesh)).toMatchObject({ vertices: 6, faces: 2 });
    check(e.mesh, false);
    expect(e.selection.edges.size).toBe(1);
    const v = extrudeVerticesOnly(p, selectionFromVerts(p, [0]), { offset: [0, 0, 1] });
    expect(v.mesh.looseEdges).toEqual([0, 4]);
    expect(v.mesh.positions.slice(12)).toEqual([-1, -1, 1]);
    // Region extrude of a wire-less edge selection extrudes the edges too.
    const re = extrudeRegion(p, selectionFromEdges(p, [edgeKey(1, 2)]), { offset: [1, 0, 0] });
    expect(re.mesh.faces).toHaveLength(2);
    expect(() => extrudeRegion(p, emptySelection())).toThrow(/selected/);
  });
});

describe('inset', () => {
  it('insets the top face of a cube', () => {
    const c = richCube();
    const r = insetFaces(c, selectionFromFaces(c, [TOP]), { thickness: 0.25 });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 12, faces: 10 });
    check(r.mesh, true);
    expect(faceArea(r.mesh, TOP)).toBeCloseTo(1.5 * 1.5);
    expect([...r.selection.faces]).toEqual([TOP]);
    // UVs of the inner face are interpolated inside the original face's UV rectangle.
    const orig = c.uvs![TOP];
    const inner = r.mesh.uvs![TOP];
    const [umin, umax] = [
      Math.min(...orig.filter((_, i) => i % 2 === 0)),
      Math.max(...orig.filter((_, i) => i % 2 === 0)),
    ];
    for (let i = 0; i < inner.length; i += 2) {
      expect(inner[i]).toBeGreaterThan(umin);
      expect(inner[i]).toBeLessThan(umax);
    }
  });

  it('applies depth and individual mode', () => {
    const c = createCube();
    const d = insetFaces(c, selectionFromFaces(c, [TOP]), { thickness: 0.2, depth: -0.3 });
    check(d.mesh, true);
    for (const v of d.selection.verts) expect(d.mesh.positions[v * 3 + 2]).toBeCloseTo(0.7);
    const ind = insetFaces(c, selectionFromFaces(c, [TOP, PLUS_Y]), { thickness: 0.2, individual: true });
    expect(meshStats(ind.mesh)).toMatchObject({ vertices: 16, faces: 14 });
    check(ind.mesh, true);
    const reg = insetFaces(c, selectionFromFaces(c, [TOP, PLUS_Y]), { thickness: 0.2 });
    expect(meshStats(reg.mesh)).toMatchObject({ vertices: 14, faces: 12 });
    check(reg.mesh, true);
    // Two faces touching only at a vertex get separate inset corners there.
    const g = createGrid({ x_subdivisions: 2, y_subdivisions: 2 });
    const diag = insetFaces(g, selectionFromFaces(g, [0, 3]), { thickness: 0.1 });
    check(diag.mesh, false);
    expect(meshStats(diag.mesh)).toMatchObject({ vertices: 17, faces: 12 });
  });
});

describe('loop cut', () => {
  it('cuts a cube once around its vertical edges', () => {
    const c = richCube();
    const r = loopCut(c, [0, 1]);
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 12, faces: 10 });
    check(r.mesh, true);
    expect(r.selection.verts.size).toBe(4);
    for (const v of r.selection.verts) expect(r.mesh.positions[v * 3 + 2]).toBeCloseTo(0);
  });

  it('supports several cuts, slide factor and smoothness', () => {
    const c = createCube();
    const three = loopCut(c, [0, 1], { cuts: 3 });
    expect(meshStats(three.mesh)).toMatchObject({ vertices: 20, faces: 18 });
    check(three.mesh, true);
    const slid = loopCut(c, [0, 1], { factor: 0.5 });
    for (const v of slid.selection.verts) expect(slid.mesh.positions[v * 3 + 2]).toBeCloseTo(0.5);
    const smooth = loopCut(c, [0, 1], { smoothness: 1 });
    const r = Math.hypot(smooth.mesh.positions[8 * 3], smooth.mesh.positions[8 * 3 + 1]);
    expect(r).toBeGreaterThan(Math.SQRT2);
  });

  it('inserts cut vertices into faces at the end of an open ring (UV sphere)', () => {
    const m = createUVSphere({ segments: 8, ring_count: 6 });
    const r = loopCut(m, [1, 2]);
    check(r.mesh, true);
    expect(vertexCount(r.mesh)).toBe(vertexCount(m) + 5);
  });

  it('interpolates UVs along the cut edges', () => {
    const g = createGrid({ x_subdivisions: 2, y_subdivisions: 1 });
    const r = loopCut(g, [0, 3]);
    check(r.mesh, false);
    expect(r.mesh.faces).toHaveLength(4);
    for (let f = 0; f < r.mesh.faces.length; f++) {
      const face = r.mesh.faces[f];
      face.forEach((v, i) => {
        // createGrid maps x∈[-1,1] → u∈[0,1]
        expect(r.mesh.uvs![f][i * 2]).toBeCloseTo((r.mesh.positions[v * 3] + 1) / 2);
      });
    }
  });
});

describe('subdivide', () => {
  it('subdivides every face of a cube', () => {
    const c = richCube();
    const r = subdivide(c, selectAllElements(c));
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 26, faces: 24 });
    check(r.mesh, true);
    expect(outward(r.mesh)).toBe(true);
    expect(r.selection.faces.size).toBe(24);
    // Seam attributes are kept on both halves of the split edge.
    const seams = Object.values(r.mesh.edgeAttrs).filter((a) => a.seam);
    expect(seams).toHaveLength(2);
  });

  it('subdivides with several cuts and smoothness', () => {
    const c = createCube();
    const r = subdivide(c, selectAllElements(c), { cuts: 2, smoothness: 1 });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 56, faces: 54 });
    check(r.mesh, true);
    // Face centers bulge outwards.
    expect(Math.max(...r.mesh.positions.map(Math.abs))).toBeGreaterThan(1);
  });

  it('inserts vertices into neighbouring faces (no T-junctions)', () => {
    const c = createCube();
    const r = subdivide(c, selectionFromFaces(c, [TOP]));
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 13, faces: 9 });
    check(r.mesh, true);
    expect(r.mesh.faces.filter((f) => f.length === 5)).toHaveLength(4);
  });

  it('handles triangles and n-gons', () => {
    const ico = createIcoSphere({ subdivisions: 1 });
    const r = subdivide(ico, selectAllElements(ico), { cuts: 2 });
    check(r.mesh, true);
    expect(r.mesh.faces).toHaveLength(20 * 9);
    const cyl = createCylinder({ vertices: 6 });
    const rc = subdivide(cyl, selectAllElements(cyl));
    check(rc.mesh, true);
    expect(rc.mesh.faces.length).toBe(6 * 4 + 2 * 6);
  });

  it('splits quads with two opposite selected edges into strips', () => {
    const p = createPlane();
    const r = subdivide(p, selectionFromEdges(p, [edgeKey(0, 1), edgeKey(2, 3)]), { cuts: 2 });
    expect(r.mesh.faces).toHaveLength(3);
    check(r.mesh, false);
  });
});

describe('delete and dissolve', () => {
  it('deletes faces, vertices and edges', () => {
    const c = createCube();
    const f = deleteGeometry(c, selectionFromFaces(c, [TOP]), 'FACE');
    expect(meshStats(f.mesh)).toMatchObject({ vertices: 8, faces: 5 });
    const topo = buildTopology(f.mesh);
    expect(topo.edgeFaces.filter((x) => x.length === 1)).toHaveLength(4);
    check(f.mesh, false);
    const v = deleteGeometry(c, selectionFromVerts(c, [0]), 'VERT');
    expect(meshStats(v.mesh)).toMatchObject({ vertices: 7, faces: 3 });
    check(v.mesh);
    const e = deleteGeometry(c, selectionFromEdges(c, [edgeKey(1, 5)]), 'EDGE');
    expect(meshStats(e.mesh)).toMatchObject({ vertices: 8, faces: 4 });
    const only = deleteGeometry(createPlane(), selectAllElements(createPlane()), 'ONLY_FACE');
    expect(only.mesh.faces).toHaveLength(0);
    expect(only.mesh.looseEdges).toHaveLength(8);
    const all = deleteGeometry(c, selectAllElements(c), 'FACE');
    expect(meshStats(all.mesh)).toMatchObject({ vertices: 0, faces: 0 });
    const ef = deleteGeometry(c, selectionFromFaces(c, [TOP]), 'EDGE_FACE');
    expect(meshStats(ef.mesh)).toMatchObject({ vertices: 8, faces: 1 });
  });

  it('dissolves vertices, edges and faces', () => {
    const c = createCube();
    const v = dissolveVerts(c, selectionFromVerts(c, [0]));
    expect(meshStats(v.mesh)).toMatchObject({ vertices: 7, faces: 4 });
    check(v.mesh, true);
    const e = dissolveEdges(c, selectionFromEdges(c, [edgeKey(1, 5)]));
    expect(meshStats(e.mesh)).toMatchObject({ vertices: 8, faces: 5 });
    check(e.mesh, true);
    // Dissolving a loop-cut edge loop restores the original quads and drops the now straight verts.
    const cut = loopCut(c, [0, 1]);
    const back = dissolveEdges(cut.mesh, cut.selection);
    expect(meshStats(back.mesh)).toMatchObject({ vertices: 8, faces: 6 });
    check(back.mesh, true);
    const keep = dissolveEdges(cut.mesh, cut.selection, { useVerts: false });
    expect(meshStats(keep.mesh)).toMatchObject({ vertices: 12, faces: 6 });
    const f = dissolveFaces(c, selectionFromFaces(c, [TOP, PLUS_Y]));
    expect(meshStats(f.mesh)).toMatchObject({ vertices: 8, faces: 5 });
    check(f.mesh, true);
    // Dissolving the inner edges of a subdivided face restores a single face.
    const g = createGrid({ x_subdivisions: 2, y_subdivisions: 2 });
    const d = dissolveFaces(g, selectAllElements(g));
    expect(meshStats(d.mesh)).toMatchObject({ vertices: 8, faces: 1 });
    check(d.mesh, false);
    const dv = dissolveFaces(g, selectAllElements(g), { useVerts: true });
    expect(meshStats(dv.mesh)).toMatchObject({ vertices: 4, faces: 1 });
  });

  it('dissolves a vertex in the middle of an edge', () => {
    const c = createCube();
    const cut = loopCut(c, [0, 1]);
    const one = [...cut.selection.verts][0];
    const r = dissolveVerts(cut.mesh, selectionFromVerts(cut.mesh, [one]));
    check(r.mesh, true);
    expect(vertexCount(r.mesh)).toBe(11);
  });
});

describe('merge', () => {
  it('collapses the top face into a pyramid', () => {
    const c = richCube();
    const r = mergeVertices(c, selectionFromFaces(c, [TOP]), 'COLLAPSE');
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 5, faces: 5 });
    check(r.mesh, true);
    const v = [...r.selection.verts][0];
    expect([r.mesh.positions[v * 3], r.mesh.positions[v * 3 + 1], r.mesh.positions[v * 3 + 2]]).toEqual([
      0, 0, 1,
    ]);
  });

  it('merges at center, cursor, first and last', () => {
    const c = createCube();
    const pick = (r: { mesh: MeshData; selection: { verts: Set<number> } }) => {
      const v = [...r.selection.verts][0];
      return r.mesh.positions.slice(v * 3, v * 3 + 3);
    };
    const sel = { verts: new Set([7, 1]), edges: new Set<string>(), faces: new Set<number>() };
    expect(pick(mergeVertices(c, sel, 'CENTER'))).toEqual([0, 0, 1]);
    expect(pick(mergeVertices(c, sel, 'CURSOR', [3, 3, 3]))).toEqual([3, 3, 3]);
    expect(pick(mergeVertices(c, sel, 'FIRST'))).toEqual([1, 1, 1]);
    expect(pick(mergeVertices(c, sel, 'LAST'))).toEqual([-1, -1, 1]);
    expect(vertexCount(mergeVertices(c, sel, 'CENTER').mesh)).toBe(7);
  });

  it('removes doubles among selected vertices only', () => {
    const c = createCube();
    const split = splitSelection(c, selectionFromFaces(c, [TOP]));
    expect(vertexCount(split.mesh)).toBe(12);
    const none = removeDoubles(split.mesh, selectionFromFaces(split.mesh, [0]), 1e-4);
    expect(none.removed).toBe(0);
    const r = removeDoubles(split.mesh, selectAllElements(split.mesh), 1e-4);
    expect(r.removed).toBe(4);
    check(r.mesh, true);
  });
});

describe('make edge/face and fill', () => {
  const holed = () => {
    const c = createCube();
    return deleteGeometry(c, selectionFromFaces(c, [TOP]), 'FACE').mesh;
  };

  it('closes a hole with a correctly oriented face', () => {
    const m = holed();
    const r = edgeFaceAdd(m, selectionFromVerts(m, [1, 3, 5, 7]));
    check(r.mesh, true);
    expect(outward(r.mesh)).toBe(true);
    expect(r.selection.faces.size).toBe(1);
    expect(() => edgeFaceAdd(r.mesh, selectionFromVerts(r.mesh, [1, 3, 5, 7]))).toThrow(/already exists/);
  });

  it('adds wire edges and faces from loose vertices', () => {
    const m = createMesh({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] });
    const e = edgeFaceAdd(m, selectionFromVerts(m, [0, 2]));
    expect(e.mesh.looseEdges).toEqual([0, 2]);
    const f = edgeFaceAdd(m, selectionFromVerts(m, [2, 0, 3, 1]));
    expect(f.mesh.faces).toHaveLength(1);
    check(f.mesh);
    expect(f.mesh.faces[0]).toHaveLength(4);
    expect(faceArea(f.mesh, 0)).toBeCloseTo(1);
  });

  it('fills boundary loops with triangles', () => {
    const m = holed();
    const r = fillHoles(m, selectionFromVerts(m, [1, 3, 5, 7]));
    check(r.mesh, true);
    expect(r.mesh.faces).toHaveLength(7);
    expect(outward(r.mesh)).toBe(true);
  });
});

describe('triangulate, join, poke', () => {
  it('triangulates and rejoins a cube', () => {
    const c = richCube();
    const t = quadsToTris(c, selectAllElements(c));
    expect(t.mesh.faces).toHaveLength(12);
    expect(t.mesh.faces.every((f) => f.length === 3)).toBe(true);
    check(t.mesh, true);
    const q = trisToQuads(t.mesh, selectAllElements(t.mesh));
    expect(q.mesh.faces).toHaveLength(6);
    expect(q.mesh.faces.every((f) => f.length === 4)).toBe(true);
    check(q.mesh, true);
    expect(outward(q.mesh)).toBe(true);
    const fixed = quadsToTris(c, selectionFromFaces(c, [TOP]), { quadMethod: 'FIXED' });
    expect(fixed.mesh.faces).toHaveLength(7);
    expect(fixed.selection.faces.size).toBe(2);
  });

  it('respects join thresholds', () => {
    const t = quadsToTris(createCube(), selectAllElements(createCube())).mesh;
    const strict = trisToQuads(t, selectAllElements(t), { faceThreshold: 0.01, shapeThreshold: 0.01 });
    expect(strict.mesh.faces).toHaveLength(6);
    const ico = createIcoSphere({ subdivisions: 1 });
    const none = trisToQuads(ico, selectAllElements(ico), { faceThreshold: 0.1 });
    expect(none.mesh.faces).toHaveLength(20);
  });

  it('pokes faces', () => {
    const c = createCube();
    const r = pokeFaces(c, selectionFromFaces(c, [TOP]), { offset: 0.5 });
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 9, faces: 9 });
    check(r.mesh, true);
    expect(maxZ(r.mesh)).toBeCloseTo(1.5);
  });
});

describe('normals', () => {
  it('flips and recalculates normals', () => {
    const c = createCube();
    const flipped = flipNormals(c, selectionFromFaces(c, [0, TOP]));
    expect(countInconsistentEdges(flipped.mesh)).toBeGreaterThan(0);
    const fixed = makeNormalsConsistent(flipped.mesh, selectAllElements(flipped.mesh));
    check(fixed.mesh, true);
    expect(outward(fixed.mesh)).toBe(true);
    const inside = makeNormalsConsistent(flipped.mesh, selectAllElements(flipped.mesh), true);
    expect(countInconsistentEdges(inside.mesh)).toBe(0);
    expect(outward(inside.mesh)).toBe(false);
    // Entirely inverted sphere is turned outwards.
    const s = createUVSphere({ segments: 8, ring_count: 5 });
    const inv = flipNormals(s, selectAllElements(s));
    expect(outward(makeNormalsConsistent(inv.mesh, selectAllElements(inv.mesh)).mesh)).toBe(true);
  });
});

describe('smooth, duplicate, split, separate, edge data', () => {
  it('smooths a bumped vertex towards its neighbours', () => {
    const g = createGrid({ x_subdivisions: 2, y_subdivisions: 2 });
    g.positions[4 * 3 + 2] = 1;
    const r = smoothVertices(g, selectionFromVerts(g, [4]), { factor: 1, repeat: 1 });
    expect(r.mesh.positions[4 * 3 + 2]).toBeCloseTo(0);
    const zOnly = smoothVertices(g, selectionFromVerts(g, [4]), { factor: 0.5, xaxis: false, yaxis: false });
    expect(zOnly.mesh.positions[4 * 3 + 2]).toBeCloseTo(0.5);
    // Boundary vertices slide along the boundary only.
    const b = smoothVertices(g, selectionFromVerts(g, [1]), { factor: 1 });
    expect(b.mesh.positions[1 * 3 + 1]).toBeCloseTo(-1);
  });

  it('duplicates the selection with an offset', () => {
    const c = richCube();
    const r = duplicateSelection(c, selectionFromFaces(c, [TOP]), [0, 0, 2]);
    expect(meshStats(r.mesh)).toMatchObject({ vertices: 12, faces: 7 });
    check(r.mesh);
    expect(r.selection.faces.size).toBe(1);
    const f = [...r.selection.faces][0];
    expect(faceCenter(r.mesh, f)[2]).toBeCloseTo(3);
    expect(r.mesh.uvs![f]).toEqual(c.uvs![TOP]);
    // The seam on edge 1-5 is copied to the duplicate (1→8, 5→10).
    expect(r.mesh.edgeAttrs[edgeKey(8, 10)]).toEqual({ seam: true, crease: 0.5 });
  });

  it('splits and separates selections', () => {
    const c = createCube();
    const s = splitSelection(c, selectionFromFaces(c, [TOP]));
    expect(vertexCount(s.mesh)).toBe(12);
    check(s.mesh, false);
    const sep = separateMesh(c, selectionFromFaces(c, [TOP]), 'SELECTED');
    expect(meshStats(sep.mesh)).toMatchObject({ vertices: 8, faces: 5 });
    expect(sep.parts).toHaveLength(1);
    expect(meshStats(sep.parts[0])).toMatchObject({ vertices: 4, faces: 1 });
    const two = createCube();
    const dup = duplicateSelection(two, selectAllElements(two), [3, 0, 0]).mesh;
    const loose = separateMesh(dup, emptySelection(), 'LOOSE');
    expect(meshStats(loose.mesh)).toMatchObject({ vertices: 8, faces: 6 });
    expect(loose.parts.map((p) => p.faces.length)).toEqual([6]);
    const mat = createCube();
    mat.faceMaterials = [0, 0, 1, 1, 2, 2];
    const bm = separateMesh(mat, emptySelection(), 'MATERIAL');
    expect(bm.mesh.faces).toHaveLength(2);
    expect(bm.parts.map((p) => p.faceMaterials)).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(() => separateMesh(createCube(), emptySelection(), 'LOOSE')).toThrow(/one connected part/);
  });

  it('marks seams, sharp edges and creases', () => {
    const c = createCube();
    const top = selectionFromFaces(c, [TOP]);
    const seam = markSeam(c, top).mesh;
    expect(Object.values(seam.edgeAttrs).filter((a) => a.seam)).toHaveLength(4);
    expect(Object.keys(markSeam(seam, top, true).mesh.edgeAttrs)).toHaveLength(0);
    const sharp = markSharp(c, selectionFromVerts(c, [0]), { useVerts: true }).mesh;
    expect(Object.values(sharp.edgeAttrs).filter((a) => a.sharp)).toHaveLength(3);
    const crease = setEdgeCrease(c, top, 0.75).mesh;
    expect(Object.values(crease.edgeAttrs).map((a) => a.crease)).toEqual([0.75, 0.75, 0.75, 0.75]);
    expect(Object.keys(setEdgeCrease(crease, top, 0).mesh.edgeAttrs)).toHaveLength(0);
  });
});

describe('attribute preservation', () => {
  it('keeps UVs aligned and finite and colors sized for every operation', () => {
    const c = richCube();
    const top = selectionFromFaces(c, [TOP]);
    const all = selectAllElements(c);
    const results: MeshData[] = [
      extrudeRegion(c, top, { offset: [0, 0, 1] }).mesh,
      extrudeIndividualFaces(c, all, 0.2).mesh,
      insetFaces(c, all, { thickness: 0.1, depth: 0.1 }).mesh,
      insetFaces(c, all, { thickness: 0.1, individual: true }).mesh,
      loopCut(c, [0, 1], { cuts: 2, smoothness: 0.5 }).mesh,
      subdivide(c, all, { cuts: 3, smoothness: 0.3 }).mesh,
      dissolveVerts(c, selectionFromVerts(c, [0, 7])).mesh,
      mergeVertices(c, top, 'CENTER').mesh,
      pokeFaces(c, all).mesh,
      quadsToTris(c, all).mesh,
      duplicateSelection(c, all).mesh,
      splitSelection(c, top).mesh,
    ];
    for (const m of results) {
      expect(validateMesh(m)).toEqual([]);
      expect(m.uvs).not.toBeNull();
      expect(m.colors).toHaveLength(vertexCount(m) * 4);
      expect(m.colors!.every((x) => Number.isFinite(x))).toBe(true);
    }
  });
});
