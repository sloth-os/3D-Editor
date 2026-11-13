import { describe, expect, it } from 'vitest';
import {
  buildRenderBuffers,
  createCube,
  createCylinder,
  createIcoSphere,
  selectAllElements,
  subdivide,
  type MeshData,
} from '../src';
import { applyModifier, expectClosedConsistent, expectValidMesh, signedVolume } from './modifiers-helpers';

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
    // 24 shrunk quads, 24 half-edge strips of 3 quads, 8 corner patches of 6 quads around a triangle,
    // nothing at the 12 welded edge midpoints
    expect(faceSizes(r)).toEqual({ tris: 8, quads: 24 + 24 * 3 + 8 * 6, ngons: 0 });
    // the rounded cube edges are continuous through the midpoints: the same profile as the unsplit cube
    const whole = applyModifier('BEVEL', cube, { width: 0.1, segments: 3 });
    expect(signedVolume(r)).toBeCloseTo(signedVolume(whole), 9);
  });
});

/** Triangles of the render triangulation with exactly zero area (the path tracer skips and reports them). */
const zeroAreaTriangles = (m: MeshData) => {
  const rb = buildRenderBuffers(m);
  const P = rb.positions;
  let n = 0;
  for (let t = 0; t < rb.indices.length; t += 3) {
    const [a, b, c] = [rb.indices[t] * 3, rb.indices[t + 1] * 3, rb.indices[t + 2] * 3];
    const e = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const f = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const nx = e[1] * f[2] - e[2] * f[1];
    const ny = e[2] * f[0] - e[0] * f[2];
    const nz = e[0] * f[1] - e[1] * f[0];
    if (!(nx * nx + ny * ny + nz * nz > 0)) n++;
  }
  return n;
};

// Regression tests for the verifier's follow-up on the product-shot issue: with limit_method NONE (or an
// angle_limit below the side angle) the vertical edges of a cylinder are beveled too, every rim vertex
// has three beveled edges and got a triangle fan whose center stuck out toward the sharp corner.
describe('BEVEL modifier where three or more beveled edges meet (quad-grid patches)', () => {
  it('rounds a cylinder rim with limit_method NONE without notches (quads only, nothing sticks out)', () => {
    const verts = 32;
    const cyl = createCylinder({ vertices: verts, radius: 1, depth: 0.6 });
    const r = applyModifier('BEVEL', cyl, { width: 0.1, segments: 4, limit_method: 'NONE' });
    expectValidMesh(r);
    expectClosedConsistent(r);
    // Blender's ADJ patch at each of the 64 rim vertices: 3 sectors of 2 × 2 quads around a center vertex;
    // 96 beveled edges × 4 strip quads; the 32 side faces; the two caps
    expect(faceSizes(r)).toEqual({ tris: 0, quads: 32 + 96 * 4 + 64 * 12, ngons: 2 });
    // 3 miter points and 7 patch vertices per rim vertex, 3 profile vertices at both ends of every edge
    expect(r.positions.length / 3).toBe(64 * (3 + 7) + 96 * 2 * 3);
    // an angle limit below the 11.25° between the side faces bevels the same edges
    const angle = applyModifier('BEVEL', cyl, { width: 0.1, segments: 4, angle_limit: 0.1 });
    expect(angle.positions).toEqual(r.positions);
    // the clamped width (the two bevels of a side face stop just short of its middle) leaves no
    // zero-area faces (the path tracer used to skip and report them)
    expect(zeroAreaTriangles(r)).toBe(0);
    // effective width from the shrunk cap: its corners sit width / cos(π/n) inside the rim vertices
    const H = 0.3;
    const cap = r.faces.find((f) => f.length === verts && f.every((i) => r.positions[i * 3 + 2] === H))!;
    const rhoCap = Math.min(...cap.map((i) => Math.hypot(r.positions[i * 3], r.positions[i * 3 + 1])));
    const w = (1 - rhoCap) * Math.cos(Math.PI / verts);
    expect(w).toBeGreaterThan(0.09);
    // every vertex of the rounded rim lies on or inside the round profile of radius w along the flat
    // side faces (the old fan centers stuck out by 11% of the width, toward the sharp corner)
    let out = -Infinity;
    for (let i = 0; i < r.positions.length; i += 3) {
      const [x, y] = [r.positions[i], r.positions[i + 1]];
      const z = Math.abs(r.positions[i + 2]);
      const rho = Math.hypot(x, y);
      if (z <= H - w + 1e-9 || rho <= rhoCap + 1e-9) continue;
      const sector = (2 * Math.PI) / verts;
      const a = (((Math.atan2(y, x) % sector) + sector) % sector) - sector / 2;
      const side = Math.cos(Math.PI / verts) / Math.cos(a); // the flat side face at this angle
      out = Math.max(out, Math.hypot(rho - (side - w), z - (H - w)) - w);
    }
    expect(out).toBeLessThan(1e-3 * w);
    // odd segment counts: 3 sectors of 1 × 2 quads around a center triangle
    const odd = applyModifier('BEVEL', cyl, { width: 0.1, segments: 3, limit_method: 'NONE' });
    expectClosedConsistent(odd);
    expect(faceSizes(odd)).toEqual({ tris: 64, quads: 32 + 96 * 3 + 64 * 6, ngons: 2 });
  });

  it('makes cube corners exact sphere patches with Blender topology for any segment count', () => {
    const cube = createCube();
    for (const segments of [2, 3, 4, 5, 6, 8]) {
      const r = applyModifier('BEVEL', cube, { width: 0.2, segments });
      expectValidMesh(r);
      expectClosedConsistent(r);
      const m = Math.floor(segments / 2);
      const odd = segments % 2;
      // per corner 3 sectors of m × (m + odd) quads, plus a center triangle for odd counts
      expect(faceSizes(r)).toEqual({
        tris: 8 * odd,
        quads: 6 + 12 * segments + 8 * 3 * m * (m + odd),
        ngons: 0,
      });
      // every vertex off the flat faces is exactly the bevel width from the inner box (cylinders along
      // the edges, spheres at the corners)
      for (let i = 0; i < r.positions.length; i += 3) {
        const p = [r.positions[i], r.positions[i + 1], r.positions[i + 2]];
        const d = Math.hypot(...p.map((x) => Math.max(0, Math.abs(x) - 0.8)));
        expect(d).toBeCloseTo(0.2, 9);
      }
    }
    // affect VERTICES: the corner patch is a quad grid on the sphere through its three face arcs
    const v = applyModifier('BEVEL', cube, { width: 0.3, segments: 4, affect: 'VERTICES' });
    expectClosedConsistent(v);
    expect(faceSizes(v)).toEqual({ tris: 0, quads: 8 * 12, ngons: 6 });
    for (let i = 0; i < v.positions.length; i += 3) {
      const p = [v.positions[i], v.positions[i + 1], v.positions[i + 2]];
      if (!p.every((x) => Math.abs(x) > 0.7 + 1e-9)) continue;
      const d = Math.hypot(...p.map((x) => Math.abs(x) - 0.7));
      expect(d).toBeCloseTo(Math.SQRT2 * 0.3, 9);
    }
  });

  it('fills corners of five beveled edges (icosahedron) with five quad sectors or a center pentagon', () => {
    const ico = createIcoSphere({ subdivisions: 1 });
    for (const segments of [4, 3]) {
      const r = applyModifier('BEVEL', ico, { width: 0.1, segments });
      expectValidMesh(r);
      expectClosedConsistent(r);
      const m = Math.floor(segments / 2);
      const odd = segments % 2;
      // 20 shrunk triangles, 30 edges × segments strip quads, 12 patches of 5 sectors (+ a pentagon)
      expect(faceSizes(r)).toEqual({
        tris: 20,
        quads: 30 * segments + 12 * 5 * m * (m + odd),
        ngons: 12 * odd,
      });
      expect(signedVolume(r)).toBeGreaterThan(0.95 * signedVolume(ico));
      expect(signedVolume(r)).toBeLessThan(signedVolume(ico));
    }
  });
});
