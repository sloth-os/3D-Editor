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
  flipDegenerateEars(out, coords);
  return out;
}

/**
 * Removes zero-area triangles from a polygon triangulation (CCW in `coords`) by edge flips. Polygons
 * with collinear corners (the n-gons a Boolean leaves along straight edges, text outlines) give ear
 * clipping "ears" of three collinear corners; such a triangle's long edge is a diagonal shared with
 * another triangle, and flipping it to the collinear middle corner makes two proper triangles.
 */
function flipDegenerateEars(tris: number[], coords: number[]): void {
  const T = tris.length / 3;
  if (T < 2) return;
  const cross = (a: number, b: number, c: number) =>
    (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
    (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2]);
  const len2 = (a: number, b: number) =>
    (coords[b * 2] - coords[a * 2]) ** 2 + (coords[b * 2 + 1] - coords[a * 2 + 1]) ** 2;
  // twice the area against the squared longest edge: below this the height is 1e-7 of the length
  const degenerate = (a: number, b: number, c: number) => {
    const l = Math.max(len2(a, b), len2(b, c), len2(c, a));
    return l > 0 && cross(a, b, c) <= 1e-7 * l;
  };
  const n = coords.length / 2;
  const owner = new Map<number, number>(); // directed edge a→b (a * n + b) → triangle
  for (let t = 0; t < T; t++)
    for (let k = 0; k < 3; k++) owner.set(tris[t * 3 + k] * n + tris[t * 3 + ((k + 1) % 3)], t);
  for (let guard = 0, t = 0; t < T && guard < 4 * T; t++) {
    const p = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    if (!degenerate(p[0], p[1], p[2])) continue;
    // the longest edge x → y, the (nearly) collinear corner z between its ends
    let k = 0;
    for (let q = 1; q < 3; q++) if (len2(p[q], p[(q + 1) % 3]) > len2(p[k], p[(k + 1) % 3])) k = q;
    const x = p[k];
    const y = p[(k + 1) % 3];
    const z = p[(k + 2) % 3];
    const u = owner.get(y * n + x);
    if (u === undefined) continue;
    let d = -1;
    for (let q = 0; q < 3; q++) {
      const c = tris[u * 3 + q];
      if (c !== x && c !== y) d = c;
    }
    if (d < 0) continue;
    // the two triangles form the quad y z x d (CCW) with z on its diagonal x–y: the other diagonal
    // z–d splits it into (y, z, d) and (z, x, d)
    if (!(cross(y, z, d) > 0 && cross(z, x, d) > 0) || degenerate(y, z, d) || degenerate(z, x, d)) continue;
    for (const [tt, tri] of [
      [t, [y, z, d]],
      [u, [z, x, d]],
    ] as const) {
      for (let q = 0; q < 3; q++) owner.delete(tris[tt * 3 + q] * n + tris[tt * 3 + ((q + 1) % 3)]);
      tris[tt * 3] = tri[0];
      tris[tt * 3 + 1] = tri[1];
      tris[tt * 3 + 2] = tri[2];
    }
    for (const tt of [t, u])
      for (let q = 0; q < 3; q++) owner.set(tris[tt * 3 + q] * n + tris[tt * 3 + ((q + 1) % 3)], tt);
    guard++;
    t = -1; // rescan: a flip can leave the neighbour degenerate
  }
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
