import { describe, expect, it } from 'vitest';
import {
  buildRenderBuffers,
  buildTopology,
  countInconsistentEdges,
  createCircle,
  createCone,
  createCube,
  createCylinder,
  createGrid,
  createIcoSphere,
  createPlane,
  createTorus,
  createUVSphere,
  decodeMesh,
  encodeMesh,
  eulerCharacteristic,
  faceCenter,
  faceNormal,
  isClosedManifold,
  meshStats,
  mergeByDistance,
  selectionFromFaces,
  selectionFromVerts,
  flushSelection,
  convertSelectMode,
  triangulateMesh,
  createMesh,
  edgeKey,
  type MeshData,
} from '../src';

function outwardNormals(m: MeshData): boolean {
  // For convex primitives centered at origin: face normal points away from the center.
  return m.faces.every((_, f) => {
    const n = faceNormal(m, f);
    const c = faceCenter(m, f);
    return n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0;
  });
}

describe('primitives', () => {
  it('cube is a closed manifold with outward normals', () => {
    const m = createCube();
    expect(meshStats(m)).toEqual({ vertices: 8, edges: 12, faces: 6, triangles: 12 });
    expect(isClosedManifold(m)).toBe(true);
    expect(eulerCharacteristic(m)).toBe(2);
    expect(countInconsistentEdges(m)).toBe(0);
    expect(outwardNormals(m)).toBe(true);
    expect(m.uvs).not.toBeNull();
  });

  it.each([
    ['uv sphere', createUVSphere({ segments: 12, ring_count: 6 }), 12 * 5 + 2],
    ['ico sphere', createIcoSphere({ subdivisions: 2 }), 42],
    ['cylinder', createCylinder({ vertices: 16 }), 32],
    ['cone', createCone({ vertices: 16 }), 17],
    ['torus', createTorus({ major_segments: 12, minor_segments: 6 }), 72],
  ])('%s is closed, consistently wound', (_name, m, verts) => {
    expect(meshStats(m).vertices).toBe(verts);
    expect(isClosedManifold(m)).toBe(true);
    expect(countInconsistentEdges(m)).toBe(0);
  });

  it('spheres/cylinders have outward normals', () => {
    for (const m of [createUVSphere(), createIcoSphere(), createCylinder(), createCone()])
      expect(outwardNormals(m)).toBe(true);
  });

  it('torus has Euler characteristic 0', () => {
    expect(eulerCharacteristic(createTorus())).toBe(0);
  });

  it('plane, grid and circle variants', () => {
    expect(meshStats(createPlane())).toMatchObject({ vertices: 4, faces: 1 });
    expect(meshStats(createGrid({ x_subdivisions: 3, y_subdivisions: 2 }))).toMatchObject({
      vertices: 12,
      faces: 6,
    });
    const ring = createCircle({ vertices: 8 });
    expect(ring.faces.length).toBe(0);
    expect(ring.looseEdges.length).toBe(16);
    expect(meshStats(ring).edges).toBe(8);
    expect(createCircle({ vertices: 8, fill_type: 'NGON' }).faces[0]).toHaveLength(8);
    expect(createCircle({ vertices: 8, fill_type: 'TRIFAN' }).faces).toHaveLength(8);
    expect(faceNormal(createPlane(), 0)[2]).toBeCloseTo(1);
  });
});

describe('codec', () => {
  it('round-trips all attributes', () => {
    const m = createCube();
    m.faceSmooth[2] = true;
    m.faceMaterials[3] = 2;
    m.colors = new Array(8 * 4).fill(0.5);
    m.edgeAttrs[edgeKey(0, 1)] = { seam: true, crease: 0.5 };
    m.edgeAttrs[edgeKey(1, 3)] = { sharp: true };
    m.looseEdges = [0, 7];
    const d = decodeMesh(encodeMesh(m));
    expect(d.faces).toEqual(m.faces);
    expect(d.faceSmooth).toEqual(m.faceSmooth);
    expect(d.faceMaterials).toEqual(m.faceMaterials);
    expect(d.looseEdges).toEqual([0, 7]);
    expect(d.edgeAttrs[edgeKey(0, 1)]).toEqual({ seam: true, crease: 0.5 });
    expect(d.edgeAttrs[edgeKey(1, 3)]).toEqual({ sharp: true });
    expect(d.colors?.length).toBe(32);
    d.positions.forEach((v, i) => expect(v).toBeCloseTo(m.positions[i], 5));
    d.uvs!.forEach((uv, f) => uv.forEach((v, i) => expect(v).toBeCloseTo(m.uvs![f][i], 5)));
  });

  it('rejects garbage', () => {
    expect(() => decodeMesh(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => decodeMesh(new Uint8Array(64))).toThrow();
  });
});

describe('triangulation and render buffers', () => {
  it('triangulates concave n-gons with correct winding', () => {
    // L-shaped hexagon in XY plane (CCW)
    const m = createMesh({
      positions: [0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0],
      faces: [[0, 1, 2, 3, 4, 5]],
    });
    const { indices } = triangulateMesh(m);
    expect(indices.length).toBe(12);
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
      const p = m.positions;
      const cross =
        (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) -
        (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3]);
      expect(cross).toBeGreaterThan(0);
    }
  });

  it('flat cube splits normals, smooth cube shares them', () => {
    const flat = buildRenderBuffers(createCube());
    expect(flat.positions.length / 3).toBe(24);
    expect(flat.indices.length).toBe(36);
    const sm = createCube();
    sm.uvs = null;
    sm.faceSmooth = sm.faces.map(() => true);
    const smooth = buildRenderBuffers(sm);
    expect(smooth.positions.length / 3).toBe(8);
    // smooth normal at a corner points diagonally
    const n = [smooth.normals[0], smooth.normals[1], smooth.normals[2]];
    expect(Math.abs(n[0])).toBeCloseTo(1 / Math.sqrt(3), 3);
  });

  it('sharp edges split smooth normals', () => {
    const sm = createCube();
    sm.uvs = null;
    sm.faceSmooth = sm.faces.map(() => true);
    const topo = buildTopology(sm);
    for (const [a, b] of topo.edges) sm.edgeAttrs[edgeKey(a, b)] = { sharp: true };
    expect(buildRenderBuffers(sm).positions.length / 3).toBe(24);
  });

  it('groups triangles by material', () => {
    const m = createCube();
    m.faceMaterials = [0, 1, 0, 1, 0, 2];
    const rb = buildRenderBuffers(m);
    expect(rb.groups.map((g) => g.materialIndex)).toEqual([0, 1, 2]);
    expect(rb.groups.map((g) => g.count)).toEqual([18, 12, 6]);
    expect(rb.triFace.length).toBe(12);
  });
});

describe('selection', () => {
  it('flushes vertex selection to edges and faces', () => {
    const m = createPlane();
    const s = selectionFromVerts(m, [0, 1]);
    expect(s.edges.size).toBe(1);
    expect(s.faces.size).toBe(0);
    const all = selectionFromVerts(m, [0, 1, 2, 3]);
    expect(all.faces.has(0)).toBe(true);
  });

  it('face selection selects its edges/verts and converts between modes', () => {
    const m = createCube();
    const s = selectionFromFaces(m, [0]);
    expect(s.verts.size).toBe(4);
    expect(s.edges.size).toBe(4);
    const asVerts = convertSelectMode(m, s, 'FACE', 'VERT');
    expect(asVerts.faces.size).toBe(1);
    const flushed = flushSelection(m, { verts: new Set([99]), edges: new Set(), faces: new Set() }, 'VERT');
    expect(flushed.verts.size).toBe(0);
  });
});

describe('merge by distance', () => {
  it('welds a triangle soup into a closed cube', () => {
    const cube = createCube();
    // explode into separate vertices per face corner
    const positions: number[] = [];
    const faces: number[][] = [];
    for (const f of cube.faces) {
      const nf: number[] = [];
      for (const v of f) {
        nf.push(positions.length / 3);
        positions.push(cube.positions[v * 3], cube.positions[v * 3 + 1], cube.positions[v * 3 + 2]);
      }
      faces.push(nf);
    }
    const soup = createMesh({ positions, faces });
    expect(isClosedManifold(soup)).toBe(false);
    const { mesh, removed } = mergeByDistance(soup, 1e-4);
    expect(removed).toBe(24 - 8);
    expect(isClosedManifold(mesh)).toBe(true);
  });

  it('keeps unmerged loose vertices', () => {
    const m = createMesh({ positions: [0, 0, 0, 0, 0, 0.00001, 5, 5, 5] });
    const { mesh } = mergeByDistance(m, 0.001);
    expect(mesh.positions.length / 3).toBe(2);
  });
});
