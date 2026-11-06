import { describe, expect, it } from 'vitest';
import { createCube, createCylinder, selectAllElements, subdivide, type MeshData } from '../src';
import { applyModifier, expectClosedConsistent, signedVolume } from './modifiers-helpers';

// Regression tests for the BEVEL modifier's two-edge vertices (product-shot issue "BEVEL modifier with
// segments > 1 leaves notches (a sawtooth of triangles) at every vertex of a cylinder rim").

const faceSizes = (m: MeshData) => {
  const out = { tris: 0, quads: 0, ngons: 0 };
  for (const f of m.faces) {
    if (f.length === 3) out.tris++;
    else if (f.length === 4) out.quads++;
    else out.ngons++;
  }
  return out;
};

describe('BEVEL modifier at vertices where two beveled edges meet', () => {
  it('rounds a cylinder rim with quads only and Blender topology (no corner patches)', () => {
    const cyl = createCylinder({ vertices: 32, radius: 1, depth: 0.6 });
    const r = applyModifier('BEVEL', cyl, {
      width: 0.1,
      segments: 4,
      limit_method: 'ANGLE',
      angle_limit: 0.6,
    });
    expectClosedConsistent(r);
    // Blender: per rim vertex one miter point on the cap, one point on the side edge and 3 profile
    // vertices shared by both rim strips: 32 * 2 * 5 = 320 vertices; faces: 2 caps, 32 sides, 64 * 4 strip quads
    expect(r.positions.length / 3).toBe(320);
    expect(faceSizes(r)).toEqual({ tris: 0, quads: 32 + 64 * 4, ngons: 2 });
    // every vertex of the rounded zone lies on the round profile (radius 0.1 around rho 0.9, |z| 0.2):
    // the old corner patches pushed their fan center out toward the sharp corner (the notches)
    let maxDev = 0;
    for (let i = 0; i < r.positions.length; i += 3) {
      const rho = Math.hypot(r.positions[i], r.positions[i + 1]);
      const z = Math.abs(r.positions[i + 2]);
      if (z > 0.2 + 1e-9 && rho > 0.9 + 1e-3)
        maxDev = Math.max(maxDev, Math.abs(Math.hypot(rho - 0.9, z - 0.2) - 0.1));
    }
    expect(maxDev).toBeLessThan(1e-3);
    // the volume is the cylinder minus the rounded-off rims, a bit more than with a flat chamfer
    const chamfer = signedVolume(applyModifier('BEVEL', cyl, { width: 0.1, angle_limit: 0.6 }));
    expect(signedVolume(r)).toBeGreaterThan(chamfer);
    expect(signedVolume(r)).toBeLessThan(signedVolume(cyl));
  });

  it('shares one profile per vertex on a hexagonal prism and with two segments', () => {
    const prism = createCylinder({ vertices: 6, radius: 1, depth: 1 });
    const r = applyModifier('BEVEL', prism, { width: 0.1, segments: 4, angle_limit: 1.2 });
    expectClosedConsistent(r);
    expect(faceSizes(r)).toEqual({ tris: 0, quads: 6 + 12 * 4, ngons: 2 });
    expect(r.positions.length / 3).toBe(6 * 2 * 5);
    const two = applyModifier('BEVEL', createCylinder({ vertices: 32 }), { width: 0.1, segments: 2 });
    expectClosedConsistent(two);
    // with two segments the old code left a sliver quad patch at each of the 64 rim vertices
    expect(faceSizes(two)).toEqual({ tris: 0, quads: 32 + 64 * 2, ngons: 2 });
  });

  it('welds the middle vertices of beveled edge loops (four edges, two beveled)', () => {
    // a cube with every face split in four: the cube edge midpoints have two beveled and two flat edges
    const cube = createCube();
    const split = subdivide(cube, selectAllElements(cube), { cuts: 1 }).mesh;
    const r = applyModifier('BEVEL', split, { width: 0.1, segments: 3, angle_limit: 0.6 });
    expectClosedConsistent(r);
    // 24 shrunk quads, 24 half-edge strips of 3 quads, 8 corner fans of 3 * 3 triangles, nothing at the
    // 12 welded edge midpoints
    expect(faceSizes(r)).toEqual({ tris: 8 * 9, quads: 24 + 24 * 3, ngons: 0 });
    // the rounded cube edges are continuous through the midpoints: the same profile as the unsplit cube
    const whole = applyModifier('BEVEL', cube, { width: 0.1, segments: 3 });
    expect(signedVolume(r)).toBeCloseTo(signedVolume(whole), 9);
  });
});
