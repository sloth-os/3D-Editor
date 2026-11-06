import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  createCube,
  createCylinder,
  createIcoSphere,
  selectAllElements,
  subdivide,
  type MeshData,
} from '../src';
import { applyModifier, expectClosedConsistent, signedVolume } from './modifiers-helpers';

// BEVEL modifier: UVs of the new geometry stay inside the UV island of the face they were cut from
// (product-shot issue "BEVEL modifier interpolates UVs across UV seams"), and the profile shapes of
// the last verification (square profile 1, extreme concave profiles, boxy corner patches).

/** Shoelace area of face fi's UV polygon. */
function uvArea(m: MeshData, fi: number): number {
  const uv = m.uvs![fi];
  const n = m.faces[fi].length;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += uv[i * 2] * uv[j * 2 + 1] - uv[j * 2] * uv[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Texels of an N × N grid over [0, 1]² covered by the UV polygons of two or more faces. */
function uvOverlap(m: MeshData, N = 256): number {
  const cover = new Uint16Array(N * N);
  const stamp = new Int32Array(N * N).fill(-1);
  m.faces.forEach((f, fi) => {
    const uv = m.uvs![fi];
    for (let t = 1; t + 1 < f.length; t++) {
      const [x0, y0, x1, y1, x2, y2] = [uv[0], uv[1], uv[t * 2], uv[t * 2 + 1], uv[t * 2 + 2], uv[t * 2 + 3]];
      const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(d) < 1e-18) continue;
      const lo = (v: number) => Math.max(0, Math.floor(v * N - 0.5));
      const hi = (v: number) => Math.min(N - 1, Math.ceil(v * N - 0.5));
      for (let py = lo(Math.min(y0, y1, y2)); py <= hi(Math.max(y0, y1, y2)); py++)
        for (let px = lo(Math.min(x0, x1, x2)); px <= hi(Math.max(x0, x1, x2)); px++) {
          const x = (px + 0.5) / N;
          const y = (py + 0.5) / N;
          const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
          const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
          if (l0 <= 1e-9 || l1 <= 1e-9 || 1 - l0 - l1 <= 1e-9) continue;
          const k = py * N + px;
          if (stamp[k] === fi) continue;
          stamp[k] = fi;
          cover[k]++;
        }
    }
  });
  let n = 0;
  for (const c of cover) if (c > 1) n++;
  return n;
}

/** Largest disagreement of the per-corner UVs of two faces at a shared vertex of a shared edge. */
function uvDiscontinuity(m: MeshData): number {
  const half = new Map<string, number[]>();
  m.faces.forEach((f, fi) => {
    const uv = m.uvs![fi];
    for (let i = 0; i < f.length; i++) {
      const j = (i + 1) % f.length;
      half.set(`${f[i]},${f[j]}`, [uv[i * 2], uv[i * 2 + 1], uv[j * 2], uv[j * 2 + 1]]);
    }
  });
  let worst = 0;
  for (const [key, a] of half) {
    const [x, y] = key.split(',');
    const b = half.get(`${y},${x}`);
    if (b)
      worst = Math.max(worst, Math.hypot(a[0] - b[2], a[1] - b[3]), Math.hypot(a[2] - b[0], a[3] - b[1]));
  }
  return worst;
}

/** UVs that are one linear function of the position (continuous everywhere, no seams). */
function linearUVs(m: MeshData): MeshData {
  const P = m.positions;
  return {
    ...m,
    uvs: m.faces.map((f) =>
      f.flatMap((v) => [P[v * 3] + 0.3 * P[v * 3 + 2], P[v * 3 + 1] + 0.7 * P[v * 3 + 2]]),
    ),
  };
}

function faceNormal(m: MeshData, f: number[]): number[] {
  const P = m.positions;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < f.length; i++) {
    const a = f[i] * 3;
    const b = f[(i + 1) % f.length] * 3;
    nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l, l / 2];
}

/** Edges where the surface folds inward deeper than `tol` (each face's centroid above the other's plane). */
function concaveEdges(m: MeshData, tol: number): number {
  const topo = buildTopology(m);
  const P = m.positions;
  const fn = m.faces.map((f) => faceNormal(m, f));
  const cen = m.faces.map((f) => {
    const c = [0, 0, 0];
    for (const v of f) for (let q = 0; q < 3; q++) c[q] += P[v * 3 + q] / f.length;
    return c;
  });
  let n = 0;
  for (let e = 0; e < topo.edges.length; e++) {
    const fs = topo.edgeFaces[e];
    if (fs.length !== 2) continue;
    const [f, g] = fs;
    const [a, b] = topo.edges[e];
    const mid = [0, 1, 2].map((q) => (P[a * 3 + q] + P[b * 3 + q]) / 2);
    const d1 = [0, 1, 2].reduce((s, q) => s + (cen[g][q] - mid[q]) * fn[f][q], 0);
    const d2 = [0, 1, 2].reduce((s, q) => s + (cen[f][q] - mid[q]) * fn[g][q], 0);
    if (Math.min(d1, d2) > tol) n++;
  }
  return n;
}

describe('BEVEL modifier UVs (per face corner, inside the UV islands)', () => {
  // the product-shot repro: mesh.primitive_cylinder_add {vertices: 16, radius: 0.1, depth: 0.05}; caps are
  // circles at v 0.5..1, the side a strip at v 0..0.5, so every rim edge is a UV seam
  const cyl = createCylinder({ vertices: 16, radius: 0.1, depth: 0.05 });
  const originalArea = cyl.faces.reduce((s, _, fi) => s + uvArea(cyl, fi), 0);

  it('keeps the rim bevel faces out of the side strip and the cap circles out of each other', () => {
    expect(uvOverlap(cyl)).toBe(0);
    for (const segments of [1, 2, 3, 4]) {
      const r = applyModifier('BEVEL', cyl, {
        width: 0.004,
        segments,
        limit_method: 'ANGLE',
        angle_limit: 0.6,
      });
      expectClosedConsistent(r);
      // no new face spans from a cap island (v > 0.5) into the side strip (v < 0.5): 38 of 96 did with 3 segments
      const crossing = r.faces.filter((_, fi) => {
        const v = r.uvs![fi].filter((_, i) => i % 2 === 1);
        return Math.min(...v) < 0.5 - 1e-9 && Math.max(...v) > 0.5 + 1e-9;
      });
      expect(crossing.length, `segments ${segments}`).toBe(0);
      // and no two faces share texels (procedural bakes into these UVs would overwrite each other)
      expect(uvOverlap(r), `segments ${segments}`).toBe(0);
      // with an even segment count both halves of every strip fill exactly the band their face lost
      if (segments % 2 === 0) {
        const area = r.faces.reduce((s, _, fi) => s + uvArea(r, fi), 0);
        expect(area).toBeCloseTo(originalArea, 9);
      }
    }
  });

  it('does not squeeze the texture into a strip that crosses the wrap-around seam of the side', () => {
    // limit_method NONE also bevels the vertical edges, one of which is the seam where u jumps 1 → 0
    for (const segments of [1, 2, 3]) {
      const r = applyModifier('BEVEL', cyl, { width: 0.004, segments, limit_method: 'NONE' });
      const widest = Math.max(
        ...r.faces.map((_, fi) => {
          const u = r.uvs![fi].filter((_, i) => i % 2 === 0);
          return Math.max(...u) - Math.min(...u);
        }),
      );
      // a side quad is 1/16 wide; the strip on the seam used to span the whole texture (0.99)
      expect(widest).toBeLessThan(0.5);
      expect(uvOverlap(r), `segments ${segments}`).toBe(0);
    }
  });

  it('keeps continuous UVs continuous (no new seams inside the bevel)', () => {
    const cube = createCube();
    const meshes: [string, MeshData, Record<string, unknown>][] = [
      ['cylinder', createCylinder({ vertices: 16, radius: 1, depth: 1 }), { width: 0.1 }],
      [
        'cylinder NONE',
        createCylinder({ vertices: 16, radius: 1, depth: 1 }),
        { width: 0.1, limit_method: 'NONE' },
      ],
      ['cube', cube, { width: 0.2 }],
      ['cube vertices', cube, { width: 0.2, affect: 'VERTICES' }],
      [
        'split cube',
        subdivide(cube, selectAllElements(cube), { cuts: 1 }).mesh,
        { width: 0.1, angle_limit: 0.6 },
      ],
      ['icosphere', createIcoSphere({ subdivisions: 1 }), { width: 0.1, limit_method: 'NONE' }],
    ];
    for (const [name, mesh, params] of meshes)
      for (const segments of [1, 2, 3, 4, 5]) {
        const r = applyModifier('BEVEL', linearUVs(mesh), { ...params, segments });
        expect(uvDiscontinuity(r), `${name}, ${segments} segments`).toBeLessThan(1e-9);
      }
  });
});

describe('BEVEL modifier profiles (Blender superellipses, evenly spaced segments)', () => {
  it('reproduces the original shape with the square profile 1 (no creases or notches)', () => {
    const cube = createCube();
    for (const segments of [2, 4]) {
      const r = applyModifier('BEVEL', cube, { width: 0.2, segments, profile: 1 });
      expectClosedConsistent(r);
      expect(signedVolume(r)).toBeCloseTo(signedVolume(cube), 3);
      expect(concaveEdges(r, 1e-4)).toBe(0);
    }
    const cyl = createCylinder({ vertices: 16, radius: 1, depth: 1 });
    for (const segments of [2, 4, 6]) {
      const r = applyModifier('BEVEL', cyl, { width: 0.1, segments, profile: 1 });
      // every rim vertex keeps its sharp corner: the old boxy profile (exponent 4) rounded it off
      expect(signedVolume(r)).toBeCloseTo(signedVolume(cyl), 3);
      const top = Math.max(...r.positions.filter((_, i) => i % 3 === 2));
      expect(top).toBeCloseTo(0.5, 9);
    }
  });

  it('spaces the segments evenly along the profile (a straight chamfer gets equal steps)', () => {
    const r = applyModifier('BEVEL', createCylinder({ vertices: 8, radius: 1, depth: 1 }), {
      width: 0.2,
      segments: 4,
      profile: 0.25,
      angle_limit: 0.9, // the rims only (the vertical edges of an octagon turn by 45°)
    });
    // the rim vertex at angle 0: its chamfer runs from the cap's miter point to the side; collect the
    // profile chain in the vertical half plane y = 0, x > 0.7 and z > 0.2
    const pts: number[][] = [];
    for (let i = 0; i < r.positions.length; i += 3)
      if (Math.abs(r.positions[i + 1]) < 1e-9 && r.positions[i] > 0.7 && r.positions[i + 2] > 0.2)
        pts.push([r.positions[i], r.positions[i + 2]]);
    pts.sort((a, b) => a[0] - b[0]);
    expect(pts.length).toBe(5);
    const steps = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 9);
  });

  it('leaves no (near) zero-area faces at cube corners with extreme concave profiles', () => {
    for (const profile of [0, 0.01, 0.05])
      for (const segments of [3, 4, 5, 6]) {
        const r = applyModifier('BEVEL', createCube(), { width: 0.2, segments, profile });
        expectClosedConsistent(r);
        const smallest = Math.min(...r.faces.map((f) => faceNormal(r, f)[3]));
        // the old corner patches collapsed to areas down to 4e-14 (path-traced renders skip such triangles)
        expect(smallest, `profile ${profile}, ${segments} segments`).toBeGreaterThan(1e-6);
      }
  });

  it('fills corners with boxy profiles without folds', () => {
    for (const profile of [0.75, 1])
      for (const segments of [2, 3, 4, 5, 6]) {
        for (const [name, mesh, width] of [
          ['cube', createCube(), 0.2],
          ['icosphere', createIcoSphere({ subdivisions: 1 }), 0.1],
        ] as const) {
          const r = applyModifier('BEVEL', mesh, { width, segments, profile, limit_method: 'NONE' });
          expect(concaveEdges(r, width * 1e-4), `${name}, profile ${profile}, ${segments} segments`).toBe(0);
        }
      }
  });
});
