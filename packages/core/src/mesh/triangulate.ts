import earcut from 'earcut';
import type { MeshData } from './types';
import { faceNormalRaw } from './normals';

/**
 * Triangulates a polygon face. Returns corner indices (0..n-1 within the face) as a flat list of
 * triangles, preserving the face winding. Handles concave polygons via ear clipping on the
 * polygon projected to its dominant plane.
 */
export function triangulateFaceCorners(m: MeshData, f: number): number[] {
  const face = m.faces[f];
  const n = face.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const p = m.positions;
  if (n === 4) {
    // Choose the diagonal that keeps both triangles facing the polygon normal and is shorter.
    const nrm = faceNormalRaw(m, f);
    const tri = (a: number, b: number, c: number) => {
      const ia = face[a] * 3;
      const ib = face[b] * 3;
      const ic = face[c] * 3;
      const ux = p[ib] - p[ia];
      const uy = p[ib + 1] - p[ia + 1];
      const uz = p[ib + 2] - p[ia + 2];
      const vx = p[ic] - p[ia];
      const vy = p[ic + 1] - p[ia + 1];
      const vz = p[ic + 2] - p[ia + 2];
      return (uy * vz - uz * vy) * nrm[0] + (uz * vx - ux * vz) * nrm[1] + (ux * vy - uy * vx) * nrm[2];
    };
    const d02 = sqDist(p, face[0], face[2]);
    const d13 = sqDist(p, face[1], face[3]);
    const ok02 = tri(0, 1, 2) > 0 && tri(0, 2, 3) > 0;
    const ok13 = tri(0, 1, 3) > 0 && tri(1, 2, 3) > 0;
    if (ok02 && (!ok13 || d02 <= d13)) return [0, 1, 2, 0, 2, 3];
    if (ok13) return [0, 1, 3, 1, 2, 3];
    return [0, 1, 2, 0, 2, 3];
  }
  const nrm = faceNormalRaw(m, f);
  const ax = Math.abs(nrm[0]);
  const ay = Math.abs(nrm[1]);
  const az = Math.abs(nrm[2]);
  // Drop the dominant axis; flip one axis when needed so the projected polygon stays CCW.
  let i0: number;
  let i1: number;
  let flip: boolean;
  if (az >= ax && az >= ay) {
    i0 = 0;
    i1 = 1;
    flip = nrm[2] < 0;
  } else if (ax >= ay) {
    i0 = 1;
    i1 = 2;
    flip = nrm[0] < 0;
  } else {
    i0 = 2;
    i1 = 0;
    flip = nrm[1] < 0;
  }
  const coords = new Array<number>(n * 2);
  for (let i = 0; i < n; i++) {
    coords[i * 2] = p[face[i] * 3 + i0];
    coords[i * 2 + 1] = (flip ? -1 : 1) * p[face[i] * 3 + i1];
  }
  const tris = earcut(coords);
  if (tris.length === 0) {
    // Degenerate polygon: fall back to a fan so the face is still rendered.
    const fan: number[] = [];
    for (let i = 1; i < n - 1; i++) fan.push(0, i, i + 1);
    return fan;
  }
  // earcut returns CCW-in-2D triangles in an arbitrary rotation; make sure they follow face winding.
  const out: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const cross =
      (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
      (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2]);
    if (cross >= 0) out.push(a, b, c);
    else out.push(a, c, b);
  }
  return out;
}

function sqDist(p: number[], a: number, b: number): number {
  const dx = p[a * 3] - p[b * 3];
  const dy = p[a * 3 + 1] - p[b * 3 + 1];
  const dz = p[a * 3 + 2] - p[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Triangulates all faces; returns vertex index triples and the source face of each triangle. */
export function triangulateMesh(m: MeshData): { indices: number[]; triFace: number[] } {
  const indices: number[] = [];
  const triFace: number[] = [];
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const corners = triangulateFaceCorners(m, f);
    for (let i = 0; i < corners.length; i += 3) {
      indices.push(face[corners[i]], face[corners[i + 1]], face[corners[i + 2]]);
      triFace.push(f);
    }
  }
  return { indices, triFace };
}
