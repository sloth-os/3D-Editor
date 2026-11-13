import type { Vec3 } from '../math/types';

/*
 * Iso-surface extraction on a regular grid (marching cubes with a face-walking polygonizer).
 *
 * Instead of case tables, each cube's polygons are derived directly: on every cube face the
 * iso-contour is a set of segments joining the edge crossings (an ambiguous face with four
 * crossings is resolved from its centre value, so the two cubes sharing the face always agree);
 * the segments are oriented from the "entry" to the "exit" crossing when walking the face
 * counter-clockwise from outside the cube, and chained across faces into closed loops. Crossing
 * vertices are shared through a per-grid-edge cache, so the surface is welded and watertight
 * wherever the field is outside on the grid boundary. Polygons are wound so that normals point
 * from the inside (value < iso) to the outside.
 */

/** Scalar samples on (nx+1)·(ny+1)·(nz+1) grid points; index = i + (nx+1)·(j + (ny+1)·k). */
export interface ScalarGrid {
  nx: number;
  ny: number;
  nz: number;
  /** Position of grid point (0, 0, 0). */
  origin: Vec3;
  /** Spacing between grid points along x, y and z. */
  step: Vec3;
  values: Float64Array;
}

/** Samples `field` on a grid covering [min, max] with cells of size `cell` (at least one per axis). */
export function sampleGrid(
  field: (x: number, y: number, z: number) => number,
  min: Readonly<Vec3>,
  max: Readonly<Vec3>,
  cell: number,
): ScalarGrid {
  const n = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / cell)));
  const step: Vec3 = [0, 1, 2].map((k) => (max[k] - min[k]) / n[k] || cell) as Vec3;
  const [nx, ny, nz] = n;
  const values = new Float64Array((nx + 1) * (ny + 1) * (nz + 1));
  let o = 0;
  for (let k = 0; k <= nz; k++) {
    const z = min[2] + k * step[2];
    for (let j = 0; j <= ny; j++) {
      const y = min[1] + j * step[1];
      for (let i = 0; i <= nx; i++) {
        const v = field(min[0] + i * step[0], y, z);
        values[o++] = Number.isFinite(v) ? v : 1;
      }
    }
  }
  return { nx, ny, nz, origin: [min[0], min[1], min[2]], step, values };
}

// cube corner c = x + 2y + 4z; edges as corner pairs (low corner first)
const EDGES: readonly [number, number][] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];
const EDGE_OF: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(-1));
EDGES.forEach(([a, b], e) => {
  EDGE_OF[a][b] = e;
  EDGE_OF[b][a] = e;
});
// cube faces as corner loops, counter-clockwise seen from outside the cube
const FACES: readonly number[][] = [
  [0, 4, 6, 2],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 2, 3, 1],
  [4, 5, 7, 6],
];

/**
 * Extracts the iso-surface `value = iso` as triangles. Returns flat positions and triangle vertex
 * indices (welded).
 */
export function polygonize(grid: ScalarGrid, iso = 0): { positions: number[]; triangles: number[] } {
  const { nx, ny, nz, values, origin, step } = grid;
  const sx = nx + 1;
  const sxy = (nx + 1) * (ny + 1);
  const positions: number[] = [];
  const triangles: number[] = [];
  const cache = new Map<number, number>();
  const val = new Float64Array(8);
  const pidx = new Int32Array(8);
  const inside = new Uint8Array(8);
  const next = new Int32Array(12);
  const vertexOf = (e: number): number => {
    const [a, b] = EDGES[e];
    const axis = (a ^ b) === 1 ? 0 : (a ^ b) === 2 ? 1 : 2;
    const key = pidx[a] * 3 + axis;
    let v = cache.get(key);
    if (v === undefined) {
      const va = val[a];
      const vb = val[b];
      let t = (iso - va) / (vb - va);
      if (!Number.isFinite(t)) t = 0.5;
      t = Math.min(0.999, Math.max(0.001, t));
      const pa = pidx[a];
      const ia = pa % sx;
      const ja = Math.floor(pa / sx) % (ny + 1);
      const ka = Math.floor(pa / sxy);
      const p: Vec3 = [origin[0] + ia * step[0], origin[1] + ja * step[1], origin[2] + ka * step[2]];
      p[axis] += t * step[axis];
      v = positions.length / 3;
      positions.push(p[0], p[1], p[2]);
      cache.set(key, v);
    }
    return v;
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const p = i + (c & 1) + sx * (j + ((c >> 1) & 1)) + sxy * (k + ((c >> 2) & 1));
          pidx[c] = p;
          val[c] = values[p];
          inside[c] = values[p] < iso ? 1 : 0;
          mask |= inside[c] << c;
        }
        if (mask === 0 || mask === 255) continue;
        next.fill(-1);
        for (const face of FACES) {
          let crossings = 0;
          for (let m = 0; m < 4; m++) if (inside[face[m]] !== inside[face[(m + 1) % 4]]) crossings++;
          if (crossings === 0) continue;
          // edge m joins face corner m and m+1; edge m-1 joins corner m-1 and m
          const edge = (m: number) => EDGE_OF[face[(m + 4) % 4]][face[(m + 5) % 4]];
          let separateInside = true;
          if (crossings === 4) {
            const centre = (val[face[0]] + val[face[1]] + val[face[2]] + val[face[3]]) / 4;
            separateInside = centre >= iso;
          }
          for (let m = 0; m < 4; m++) {
            if (crossings === 2) {
              // the single inside run: entry before its first corner, exit after its last corner
              if (inside[face[m]] && !inside[face[(m + 3) % 4]]) {
                let last = m;
                while (inside[face[(last + 1) % 4]]) last = (last + 1) % 4;
                next[edge(m - 1)] = edge(last);
              }
            } else if (separateInside && inside[face[m]]) next[edge(m - 1)] = edge(m);
            else if (!separateInside && !inside[face[m]]) next[edge(m)] = edge(m - 1);
          }
        }
        // chain segments into loops and fan-triangulate them
        const used = new Uint8Array(12);
        for (let e0 = 0; e0 < 12; e0++) {
          if (next[e0] < 0 || used[e0]) continue;
          const loop: number[] = [];
          let e = e0;
          while (e >= 0 && !used[e]) {
            used[e] = 1;
            loop.push(vertexOf(e));
            e = next[e];
          }
          for (let t = 1; t + 1 < loop.length; t++) triangles.push(loop[0], loop[t], loop[t + 1]);
        }
      }
  return { positions, triangles };
}
