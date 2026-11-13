import type { Vec3 } from '../math/types';
import { normalize3 } from '../math/vec3';
import type { MeshData } from './types';
import { vertexCount } from './types';

/** Unnormalized face normal via Newell's method (length = 2 × area for planar polygons). */
export function faceNormalRaw(m: MeshData, f: number): Vec3 {
  const face = m.faces[f];
  const p = m.positions;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i] * 3;
    const b = face[(i + 1) % face.length] * 3;
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  return [nx, ny, nz];
}

export function faceNormal(m: MeshData, f: number): Vec3 {
  return normalize3(faceNormalRaw(m, f));
}

export function faceArea(m: MeshData, f: number): number {
  const n = faceNormalRaw(m, f);
  return Math.hypot(n[0], n[1], n[2]) / 2;
}

export function faceCenter(m: MeshData, f: number): Vec3 {
  const face = m.faces[f];
  const c: Vec3 = [0, 0, 0];
  for (const v of face) {
    c[0] += m.positions[v * 3];
    c[1] += m.positions[v * 3 + 1];
    c[2] += m.positions[v * 3 + 2];
  }
  const n = face.length || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** Area-weighted smooth vertex normals (flat array, 3 per vertex). */
export function computeVertexNormals(m: MeshData): number[] {
  const n = vertexCount(m);
  const out = new Array<number>(n * 3).fill(0);
  for (let f = 0; f < m.faces.length; f++) {
    const fn = faceNormalRaw(m, f);
    for (const v of m.faces[f]) {
      out[v * 3] += fn[0];
      out[v * 3 + 1] += fn[1];
      out[v * 3 + 2] += fn[2];
    }
  }
  for (let i = 0; i < n; i++) {
    const v = normalize3([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    out[i * 3] = v[0];
    out[i * 3 + 1] = v[1];
    out[i * 3 + 2] = v[2];
  }
  return out;
}

/** Mean of a set of vertex positions. */
export function centroidOf(m: MeshData, verts: Iterable<number>): Vec3 {
  const c: Vec3 = [0, 0, 0];
  let n = 0;
  for (const v of verts) {
    c[0] += m.positions[v * 3];
    c[1] += m.positions[v * 3 + 1];
    c[2] += m.positions[v * 3 + 2];
    n++;
  }
  return n ? [c[0] / n, c[1] / n, c[2] / n] : c;
}
