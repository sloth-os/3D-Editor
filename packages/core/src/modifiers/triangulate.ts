import { z } from 'zod';
import earcut from 'earcut';
import type { MeshData } from '../mesh/types';
import type { ModifierDef } from './registry';
import { faceNormalsOf } from './util';

const schema = z.object({
  quad_method: z
    .enum(['BEAUTY', 'FIXED', 'FIXED_ALTERNATE', 'SHORTEST_DIAGONAL', 'LONGEST_DIAGONAL'])
    .default('SHORTEST_DIAGONAL')
    .describe(
      'How quads are split: BEAUTY (best shaped triangles), FIXED (0-2), FIXED_ALTERNATE (1-3), shortest/longest diagonal',
    ),
  ngon_method: z
    .enum(['BEAUTY', 'CLIP'])
    .default('BEAUTY')
    .describe(
      'CLIP = ear clipping; BEAUTY = ear clipping followed by edge flips for better shaped triangles',
    ),
  min_vertices: z
    .number()
    .int()
    .min(4)
    .max(10000)
    .default(4)
    .describe('Only faces with at least this many corners are triangulated'),
  keep_custom_normals: z.boolean().default(false).describe('Accepted for compatibility (no effect)'),
});

type TriParams = z.infer<typeof schema>;

/** Shape quality of a triangle in (0, 1]: 1 for equilateral, → 0 for slivers. */
function triQuality(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ax = p[b * 3] - p[a * 3];
  const ay = p[b * 3 + 1] - p[a * 3 + 1];
  const az = p[b * 3 + 2] - p[a * 3 + 2];
  const bx = p[c * 3] - p[a * 3];
  const by = p[c * 3 + 1] - p[a * 3 + 1];
  const bz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = p[c * 3] - p[b * 3];
  const cy = p[c * 3 + 1] - p[b * 3 + 1];
  const cz = p[c * 3 + 2] - p[b * 3 + 2];
  const area2 = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  const sum = ax * ax + ay * ay + az * az + bx * bx + by * by + bz * bz + cx * cx + cy * cy + cz * cz;
  return sum > 0 ? (2 * Math.sqrt(3) * area2) / sum : 0;
}

/** Signed orientation of triangle (a, b, c) relative to normal n. */
function orient(
  p: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  n: ArrayLike<number>,
  o: number,
): number {
  const ax = p[b * 3] - p[a * 3];
  const ay = p[b * 3 + 1] - p[a * 3 + 1];
  const az = p[b * 3 + 2] - p[a * 3 + 2];
  const bx = p[c * 3] - p[a * 3];
  const by = p[c * 3 + 1] - p[a * 3 + 1];
  const bz = p[c * 3 + 2] - p[a * 3 + 2];
  return (ay * bz - az * by) * n[o] + (az * bx - ax * bz) * n[o + 1] + (ax * by - ay * bx) * n[o + 2];
}

function d2(p: ArrayLike<number>, a: number, b: number): number {
  const x = p[a * 3] - p[b * 3];
  const y = p[a * 3 + 1] - p[b * 3 + 1];
  const z = p[a * 3 + 2] - p[b * 3 + 2];
  return x * x + y * y + z * z;
}

/** Corner triples for a quad. */
function splitQuad(
  p: ArrayLike<number>,
  face: number[],
  method: TriParams['quad_method'],
  fn: Float64Array,
  f: number,
): number[] {
  const [a, b, c, d] = face;
  const diag02 = [0, 1, 2, 0, 2, 3];
  const diag13 = [0, 1, 3, 1, 2, 3];
  switch (method) {
    case 'FIXED':
      return diag02;
    case 'FIXED_ALTERNATE':
      return diag13;
    case 'SHORTEST_DIAGONAL':
      return d2(p, a, c) <= d2(p, b, d) ? diag02 : diag13;
    case 'LONGEST_DIAGONAL':
      return d2(p, a, c) >= d2(p, b, d) ? diag02 : diag13;
    default: {
      const o = f * 3;
      const ok02 = orient(p, a, b, c, fn, o) > 0 && orient(p, a, c, d, fn, o) > 0;
      const ok13 = orient(p, a, b, d, fn, o) > 0 && orient(p, b, c, d, fn, o) > 0;
      if (ok02 !== ok13) return ok02 ? diag02 : diag13;
      const q02 = Math.min(triQuality(p, a, b, c), triQuality(p, a, c, d));
      const q13 = Math.min(triQuality(p, a, b, d), triQuality(p, b, c, d));
      return q02 >= q13 ? diag02 : diag13;
    }
  }
}

/** Projects a face to 2D (CCW with respect to its normal). */
function project(p: ArrayLike<number>, face: number[], fn: Float64Array, f: number): number[] {
  const nx = fn[f * 3];
  const ny = fn[f * 3 + 1];
  const nz = fn[f * 3 + 2];
  // orthonormal basis (u, v) with u × v = n
  let ux: number;
  let uy: number;
  let uz: number;
  if (Math.abs(nx) < 0.9) {
    ux = 0;
    uy = nz;
    uz = -ny;
  } else {
    ux = -nz;
    uy = 0;
    uz = nx;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  const out = new Array<number>(face.length * 2);
  for (let i = 0; i < face.length; i++) {
    const o = face[i] * 3;
    out[i * 2] = p[o] * ux + p[o + 1] * uy + p[o + 2] * uz;
    out[i * 2 + 1] = p[o] * vx + p[o + 1] * vy + p[o + 2] * vz;
  }
  return out;
}

function cross2(c: number[], a: number, b: number, d: number): number {
  return (
    (c[b * 2] - c[a * 2]) * (c[d * 2 + 1] - c[a * 2 + 1]) -
    (c[b * 2 + 1] - c[a * 2 + 1]) * (c[d * 2] - c[a * 2])
  );
}

/** True if d lies inside the circumcircle of CCW triangle (a, b, c). */
function inCircle(c: number[], a: number, b: number, cc: number, d: number): boolean {
  const adx = c[a * 2] - c[d * 2];
  const ady = c[a * 2 + 1] - c[d * 2 + 1];
  const bdx = c[b * 2] - c[d * 2];
  const bdy = c[b * 2 + 1] - c[d * 2 + 1];
  const cdx = c[cc * 2] - c[d * 2];
  const cdy = c[cc * 2 + 1] - c[d * 2 + 1];
  const det =
    (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) -
    (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) +
    (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
  return det > 1e-12 * (adx * adx + ady * ady + bdx * bdx + bdy * bdy + cdx * cdx + cdy * cdy) ** 2;
}

/** Triangulates an n-gon given as 2D coordinates; returns CCW corner triples. */
export function triangulatePolygon2D(coords: number[], beauty: boolean): number[] {
  const n = coords.length / 2;
  let tris = earcut(coords);
  if (tris.length === 0) {
    tris = [];
    for (let i = 1; i < n - 1; i++) tris.push(0, i, i + 1);
  }
  for (let t = 0; t < tris.length; t += 3) {
    if (cross2(coords, tris[t], tris[t + 1], tris[t + 2]) < 0) {
      const tmp = tris[t + 1];
      tris[t + 1] = tris[t + 2];
      tris[t + 2] = tmp;
    }
  }
  if (!beauty || tris.length < 6) return tris;
  // Delaunay-style edge flips restricted to internal diagonals
  const isBoundary = (a: number, b: number) => Math.abs(a - b) === 1 || Math.abs(a - b) === n - 1;
  for (let pass = 0; pass < n * 4; pass++) {
    let flipped = false;
    const edgeTri = new Map<string, number>();
    for (let t = 0; t < tris.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = tris[t + k];
        const b = tris[t + ((k + 1) % 3)];
        edgeTri.set(`${a},${b}`, t);
      }
    }
    for (let t = 0; t < tris.length && !flipped; t += 3) {
      for (let k = 0; k < 3 && !flipped; k++) {
        const a = tris[t + k];
        const b = tris[t + ((k + 1) % 3)];
        const c = tris[t + ((k + 2) % 3)];
        if (isBoundary(a, b)) continue;
        const u = edgeTri.get(`${b},${a}`);
        if (u === undefined) continue;
        let d = -1;
        for (let q = 0; q < 3; q++) if (tris[u + q] !== a && tris[u + q] !== b) d = tris[u + q];
        if (d < 0 || !inCircle(coords, a, b, c, d)) continue;
        // new triangles (c, a, d) and (d, b, c) must both stay CCW (quad convex)
        if (cross2(coords, c, a, d) <= 0 || cross2(coords, d, b, c) <= 0) continue;
        tris[t] = c;
        tris[t + 1] = a;
        tris[t + 2] = d;
        tris[u] = d;
        tris[u + 1] = b;
        tris[u + 2] = c;
        flipped = true;
      }
    }
    if (!flipped) break;
  }
  return tris;
}

export function triangulateModifierMesh(m: MeshData, p: TriParams): MeshData {
  if (!m.faces.some((f) => f.length >= Math.max(4, p.min_vertices))) return m;
  const fn = faceNormalsOf(m);
  const P = m.positions;
  const faces: number[][] = [];
  const faceMaterials: number[] = [];
  const faceSmooth: boolean[] = [];
  const uvs: number[][] | null = m.uvs ? [] : null;
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const uv = m.uvs ? m.uvs[f] : null;
    if (face.length < 4 || face.length < p.min_vertices) {
      faces.push(face.slice());
      faceMaterials.push(m.faceMaterials[f] ?? 0);
      faceSmooth.push(m.faceSmooth[f] ?? false);
      if (uvs) uvs.push(uv ? uv.slice() : new Array(face.length * 2).fill(0));
      continue;
    }
    const corners =
      face.length === 4
        ? splitQuad(P, face, p.quad_method, fn, f)
        : triangulatePolygon2D(project(P, face, fn, f), p.ngon_method === 'BEAUTY');
    for (let t = 0; t < corners.length; t += 3) {
      const c = [corners[t], corners[t + 1], corners[t + 2]];
      faces.push(c.map((i) => face[i]));
      faceMaterials.push(m.faceMaterials[f] ?? 0);
      faceSmooth.push(m.faceSmooth[f] ?? false);
      if (uvs) uvs.push(uv ? c.flatMap((i) => [uv[i * 2] ?? 0, uv[i * 2 + 1] ?? 0]) : [0, 0, 0, 0, 0, 0]);
    }
  }
  const edgeAttrs: MeshData['edgeAttrs'] = {};
  for (const k in m.edgeAttrs) edgeAttrs[k] = { ...m.edgeAttrs[k] };
  return {
    positions: m.positions.slice(),
    faces,
    faceMaterials,
    faceSmooth,
    uvs,
    colors: m.colors ? m.colors.slice() : null,
    edgeAttrs,
    looseEdges: m.looseEdges.slice(),
  };
}

export const triangulateModifier: ModifierDef<typeof schema> = {
  type: 'TRIANGULATE',
  label: 'Triangulate',
  category: 'GENERATE',
  description:
    'Splits quads and n-gons (with at least `min_vertices` corners) into triangles. Quads use `quad_method`, larger ' +
    'polygons ear clipping (`ngon_method` CLIP) optionally improved by edge flips (BEAUTY). Winding, materials, ' +
    'smooth flags, UVs and edge attributes are preserved.',
  schema,
  apply(mesh, p) {
    return triangulateModifierMesh(mesh, p);
  },
};
