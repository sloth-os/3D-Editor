import { describe, expect, it } from 'vitest';
import {
  createCube,
  createCylinder,
  createGrid,
  createIcoSphere,
  createTorus,
  createUVSphere,
  cubeProject,
  cylinderProject,
  edgeKey,
  emptySelection,
  resetUVs,
  selectionFromFaces,
  smartProject,
  sphereProject,
  validateMesh,
  type MeshData,
} from '../src';

/** Signed UV area of a face (shoelace). */
function uvArea(m: MeshData, f: number): number {
  const uv = m.uvs![f];
  let a = 0;
  for (let i = 0; i < uv.length; i += 2) {
    const j = (i + 2) % uv.length;
    a += uv[i] * uv[j + 1] - uv[j] * uv[i + 1];
  }
  return a / 2;
}

function expectUVsInUnitSquare(m: MeshData) {
  expect(validateMesh(m)).toEqual([]);
  for (const uv of m.uvs!)
    for (const x of uv) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
}

/** Islands as UV-space bounding boxes of face groups sharing UV corners. */
function overlapArea(m: MeshData, faces: number[]): number {
  // Sum of face UV areas vs. area covered on a raster: overlaps make the raster coverage smaller.
  const N = 256;
  const hit = new Uint8Array(N * N);
  let doubled = 0;
  for (const f of faces) {
    const uv = m.uvs![f];
    const xs = uv.filter((_, i) => i % 2 === 0);
    const ys = uv.filter((_, i) => i % 2 === 1);
    for (
      let gx = Math.floor(Math.min(...xs) * N);
      gx <= Math.min(N - 1, Math.floor(Math.max(...xs) * N));
      gx++
    )
      for (
        let gy = Math.floor(Math.min(...ys) * N);
        gy <= Math.min(N - 1, Math.floor(Math.max(...ys) * N));
        gy++
      ) {
        const px = (gx + 0.5) / N;
        const py = (gy + 0.5) / N;
        // point in convex polygon (faces here are convex)
        let inside = true;
        let sign = 0;
        for (let i = 0; i < xs.length && inside; i++) {
          const j = (i + 1) % xs.length;
          const c = (xs[j] - xs[i]) * (py - ys[i]) - (ys[j] - ys[i]) * (px - xs[i]);
          if (Math.abs(c) < 1e-12) continue;
          if (sign === 0) sign = Math.sign(c);
          else if (Math.sign(c) !== sign) inside = false;
        }
        if (!inside) continue;
        if (hit[gy * N + gx]) doubled++;
        hit[gy * N + gx] = 1;
      }
  }
  return doubled / (N * N);
}

describe('smart project', () => {
  it('unwraps a cube into six equal, non-overlapping islands inside 0..1', () => {
    const c = createCube();
    c.uvs = null;
    const r = smartProject(c, emptySelection());
    expect(r.mesh.uvs).not.toBeNull();
    expectUVsInUnitSquare(r.mesh);
    const areas = r.mesh.faces.map((_, f) => Math.abs(uvArea(r.mesh, f)));
    for (const a of areas) expect(a).toBeCloseTo(areas[0], 9);
    expect(areas[0]).toBeGreaterThan(0.05);
    expect(overlapArea(r.mesh, [0, 1, 2, 3, 4, 5])).toBe(0);
    // Islands are not mirrored: UV winding matches the face winding.
    for (let f = 0; f < 6; f++) expect(uvArea(r.mesh, f)).toBeGreaterThan(0);
  });

  it('handles curved meshes without NaNs or overlaps', () => {
    for (const m of [
      createUVSphere({ segments: 16, ring_count: 8 }),
      createTorus({ major_segments: 16, minor_segments: 8 }),
      createIcoSphere({ subdivisions: 2 }),
    ]) {
      const r = smartProject(m, emptySelection(), { islandMargin: 0.02 });
      expectUVsInUnitSquare(r.mesh);
      expect(
        overlapArea(
          r.mesh,
          r.mesh.faces.map((_, f) => f),
        ),
      ).toBeLessThan(0.002);
      for (let f = 0; f < r.mesh.faces.length; f++) expect(uvArea(r.mesh, f)).toBeGreaterThan(0);
    }
  });

  it('keeps flat connected regions in one island and splits them at seams', () => {
    const g = createGrid({ x_subdivisions: 4, y_subdivisions: 4 });
    const whole = smartProject(g, emptySelection());
    expectUVsInUnitSquare(whole.mesh);
    // A single planar island fills the square: total UV area 1.
    const total = whole.mesh.faces.reduce((a, _, f) => a + Math.abs(uvArea(whole.mesh, f)), 0);
    expect(total).toBeCloseTo(1, 6);
    for (let j = 0; j < 4; j++) g.edgeAttrs[edgeKey(j * 5 + 2, (j + 1) * 5 + 2)] = { seam: true };
    const split = smartProject(g, emptySelection(), { islandMargin: 0.05 });
    expectUVsInUnitSquare(split.mesh);
    const total2 = split.mesh.faces.reduce((a, _, f) => a + Math.abs(uvArea(split.mesh, f)), 0);
    expect(total2).toBeLessThan(0.95);
    expect(
      overlapArea(
        split.mesh,
        split.mesh.faces.map((_, f) => f),
      ),
    ).toBe(0);
  });

  it('only changes the selected faces', () => {
    const c = createCube();
    const r = smartProject(c, selectionFromFaces(c, [5]));
    for (let f = 0; f < 5; f++) expect(r.mesh.uvs![f]).toEqual(c.uvs![f]);
    expect(r.mesh.uvs![5]).not.toEqual(c.uvs![5]);
    expectUVsInUnitSquare(r.mesh);
  });
});

describe('projections', () => {
  it('cube projection maps each cube face onto a unit square', () => {
    const c = createCube();
    c.uvs = null;
    const r = cubeProject(c, emptySelection(), { cubeSize: 2 });
    expectUVsInUnitSquare(r.mesh);
    for (let f = 0; f < 6; f++) {
      expect(Math.abs(uvArea(r.mesh, f))).toBeCloseTo(1);
      expect(uvArea(r.mesh, f)).toBeGreaterThan(0);
    }
    const scaled = cubeProject(c, emptySelection(), { cubeSize: 0.5, clipToBounds: true });
    expectUVsInUnitSquare(scaled.mesh);
    const fit = cubeProject(c, emptySelection(), { cubeSize: 10, scaleToBounds: true });
    expect(Math.max(...fit.mesh.uvs!.flat())).toBeCloseTo(1);
  });

  it('cylinder projection wraps around the axis without seam jumps', () => {
    const cyl = createCylinder({ vertices: 16, end_fill_type: 'NOTHING' });
    const r = cylinderProject(cyl, emptySelection());
    expect(validateMesh(r.mesh)).toEqual([]);
    for (const uv of r.mesh.uvs!) {
      const us = uv.filter((_, i) => i % 2 === 0);
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.2);
      for (const v of uv.filter((_, i) => i % 2 === 1)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    const fitted = cylinderProject(cyl, emptySelection(), { scaleToBounds: true });
    expectUVsInUnitSquare(fitted.mesh);
  });

  it('sphere projection handles the poles', () => {
    const s = createUVSphere({ segments: 12, ring_count: 6 });
    const r = sphereProject(s, emptySelection());
    expect(validateMesh(r.mesh)).toEqual([]);
    for (const uv of r.mesh.uvs!) {
      const us = uv.filter((_, i) => i % 2 === 0);
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.2);
    }
    const vs = r.mesh.uvs!.flatMap((uv) => uv.filter((_, i) => i % 2 === 1));
    expect(Math.min(...vs)).toBeCloseTo(0);
    expect(Math.max(...vs)).toBeCloseTo(1);
  });

  it('resets UVs to the unit square', () => {
    const c = createCube();
    const r = resetUVs(c, selectionFromFaces(c, [0]));
    expect(r.mesh.uvs![0]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(r.mesh.uvs![1]).toEqual(c.uvs![1]);
    const t = resetUVs(createIcoSphere({ subdivisions: 1 }), emptySelection());
    expectUVsInUnitSquare(t.mesh);
  });
});
