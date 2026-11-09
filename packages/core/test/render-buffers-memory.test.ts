import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildRenderBuffers,
  createCube,
  createCylinder,
  createGrid,
  createMesh,
  createUVSphere,
  edgeKey,
  type MeshData,
  type RenderBuffers,
} from '../src/mesh';
import { referenceBuildRenderBuffers } from './render-buffers-reference';

/*
 * buildRenderBuffers with typed arrays (round 9): a server render of a grid of 2 million triangles
 * spent 21 s and up to 2.8 GB of heap in it (a Map with a string key per corner, small arrays per
 * edge), which made render processes run out of memory. It must give exactly what the old version
 * gave (kept in render-buffers-reference.ts): the same render vertices in the same order, the same
 * float32 normals, UVs and colours, the same triangles, groups and sources, for every kind of mesh.
 */

function same(a: RenderBuffers, b: RenderBuffers): void {
  const bytes = (x: ArrayBufferView | null) =>
    x ? Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('hex') : null;
  expect(bytes(a.positions)).toBe(bytes(b.positions));
  expect(bytes(a.normals)).toBe(bytes(b.normals));
  expect(bytes(a.uvs)).toBe(bytes(b.uvs));
  expect(bytes(a.colors)).toBe(bytes(b.colors));
  expect(bytes(a.indices)).toBe(bytes(b.indices));
  expect(bytes(a.triFace)).toBe(bytes(b.triFace));
  expect(bytes(a.vertexSource)).toBe(bytes(b.vertexSource));
  expect(a.groups).toEqual(b.groups);
  // exact sizes (no views into larger buffers)
  for (const k of ['positions', 'normals', 'uvs', 'colors', 'indices', 'triFace', 'vertexSource'] as const) {
    const x = a[k];
    if (x) expect(x.byteLength).toBe(x.buffer.byteLength);
  }
}

const check = (m: MeshData) => same(buildRenderBuffers(m), referenceBuildRenderBuffers(m));

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('render buffers with typed arrays', () => {
  it('match the old buildRenderBuffers on primitives, flat and smooth, with sharp edges and seams', () => {
    check(createCube());
    const sphere = createUVSphere({ segments: 24, ring_count: 12 });
    sphere.faceSmooth = sphere.faceSmooth.map(() => true);
    check(sphere);
    const cyl = createCylinder({ vertices: 16 });
    // smooth sides, flat caps, a sharp seam on the side and a UV seam (split UVs per face)
    cyl.faceSmooth = cyl.faceSmooth.map((_, f) => cyl.faces[f].length === 4);
    cyl.edgeAttrs = { ...cyl.edgeAttrs, [edgeKey(cyl.faces[0][0], cyl.faces[0][1])]: { sharp: true } };
    check(cyl);
    const grid = createGrid({ x_subdivisions: 12, y_subdivisions: 9 });
    grid.faceSmooth = grid.faceSmooth.map((_, f) => f % 3 !== 0);
    grid.faceMaterials = grid.faceMaterials.map((_, f) => (f * 7) % 4);
    grid.colors = Array.from({ length: (grid.positions.length / 3) * 4 }, (_, i) => (i % 13) / 13);
    check(grid);
  });

  it('match on n-gons, concave and degenerate faces, non-manifold edges, loose edges and odd UVs', () => {
    const m = createMesh({
      positions: [
        0,
        0,
        0,
        2,
        0,
        0,
        2,
        2,
        0,
        1,
        1,
        0,
        0,
        2,
        0, // concave pentagon 0-4
        3,
        0,
        0,
        4,
        0,
        0,
        4,
        1,
        0,
        3,
        1,
        0, // quad 5-8
        3,
        0,
        1,
        5,
        5,
        5,
        6,
        6,
        6,
        7,
        7,
        7, // fins sharing edge 5-6, loose vertices
      ],
      faces: [
        [0, 1, 2, 3, 4],
        [5, 6, 7, 8],
        [5, 6, 9],
        [6, 5, 10], // a third face on edge 5-6 (non-manifold)
        [10, 11], // a two-corner face (no triangles)
        [7, 7, 8], // a repeated corner
        [11, 12, 12, 11, 7], // degenerate n-gon
      ],
      faceSmooth: [true, true, true, true, true, true, true],
      faceMaterials: [2, 0, 0, 5, 7, 0, 2],
      uvs: [
        [0, 0, 1, 0, 1, 1, 0.5, 0.5, 0, 1],
        [0, 0, -0, 0, NaN, 1, 0, 1],
        [0, 0, 0, 0, NaN, 0.25],
        [0, 0, 0, 0, 0.5, 0.5],
        [0, 0, 1],
        [0.1, 0.1, 0.1, 0.1, 0.2, 0.2],
        [0, 0, 1, 1, 1, 1, 0, 0, 0.5, 0.5],
      ],
      looseEdges: [11, 12, 5, 6],
    });
    check(m);
    // the same with flat faces, without UVs
    check({ ...m, faceSmooth: m.faceSmooth.map(() => false), uvs: null });
  });

  it('match on random meshes', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const nv = 4 + Math.floor(r() * 40);
      const positions = Array.from({ length: nv * 3 }, () => Math.round(r() * 8) / 4);
      const faces: number[][] = [];
      const nf = 1 + Math.floor(r() * 60);
      for (let f = 0; f < nf; f++) {
        const n = 1 + Math.floor(r() * 6);
        faces.push(Array.from({ length: n }, () => Math.floor(r() * nv)));
      }
      const uvs =
        r() < 0.7
          ? faces.map((face) => face.flatMap(() => [Math.floor(r() * 3) / 2, Math.floor(r() * 3) / 2]))
          : null;
      const edgeAttrs: MeshData['edgeAttrs'] = {};
      for (const face of faces)
        if (face.length > 1 && r() < 0.2) edgeAttrs[edgeKey(face[0], face[1])] = { sharp: true };
      check(
        createMesh({
          positions,
          faces,
          faceSmooth: faces.map(() => r() < 0.7),
          faceMaterials: faces.map(() => Math.floor(r() * 3)),
          uvs,
          colors: r() < 0.3 ? Array.from({ length: nv * 4 }, () => r()) : null,
          edgeAttrs,
        }),
      );
    }
  });

  it('throws for a corner naming no vertex, as the old one did', () => {
    const bad = createMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 3]] });
    expect(() => referenceBuildRenderBuffers(bad)).toThrow(TypeError);
    expect(() => buildRenderBuffers(bad)).toThrow(TypeError);
  });

  it('builds the buffers of 180,000 triangles in a 96 MB heap (the old version needed more than 160 MB)', () => {
    // a child process with a small heap: the old version runs out of memory in it (measured: it
    // fails with 160 MB and works with 192 MB; this version works with 48 MB, the process itself
    // and the grid taking 33 MB)
    const here = path.dirname(fileURLToPath(import.meta.url));
    const run = spawnSync(
      process.execPath,
      ['--max-old-space-size=96', '--import', 'tsx', path.join(here, 'render-buffers-heap-child.ts'), '300'],
      { cwd: path.resolve(here, '../../..'), encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.stderr).not.toMatch(/out of memory/);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('180000');
  });
});
