import type { Vec3 } from '../../math/types';
import type { MeshData } from '../types';
import { cloneMesh } from '../types';
import type { MeshSelection } from '../selection';
import { selectionFromFaces } from '../selection';
import { buildTopology } from '../topology';
import type { MeshOpResult } from './types';
import { allFaceRecs, completeSelection, requireNonEmpty, reverseFace, writeFaces } from './util';

/** Reverses the winding (normal direction) of the selected faces. */
export function flipNormals(src: MeshData, sel: MeshSelection): MeshOpResult {
  const s = completeSelection(src, sel);
  requireNonEmpty(s.faces.size, 'faces');
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  for (const f of s.faces) reverseFace(recs[f]);
  writeFaces(m, recs);
  return { mesh: m, selection: selectionFromFaces(m, s.faces) };
}

function traverses(face: readonly number[], a: number, b: number): boolean {
  const i = face.indexOf(a);
  return i >= 0 && face[(i + 1) % face.length] === b;
}

/**
 * Recalculate normals (Shift+N): makes the winding of the selected faces consistent within each
 * connected island (breadth-first propagation across manifold edges). Islands that border
 * unselected faces are then oriented to agree with them; free-standing islands are oriented
 * outwards using their signed volume. `inside` reverses the final orientation.
 */
export function makeNormalsConsistent(src: MeshData, sel: MeshSelection, inside = false): MeshOpResult {
  const topo = buildTopology(src);
  const s = completeSelection(src, sel, topo);
  requireNonEmpty(s.faces.size, 'faces');
  const F = src.faces.length;
  const flip = new Uint8Array(F);
  const visited = new Uint8Array(F);
  const P = src.positions;
  for (const start of [...s.faces].sort((a, b) => a - b)) {
    if (visited[start]) continue;
    visited[start] = 1;
    const island = [start];
    const queue = [start];
    while (queue.length) {
      const f = queue.shift()!;
      const face = src.faces[f];
      for (let i = 0; i < face.length; i++) {
        const e = topo.faceEdges[f][i];
        const ef = topo.edgeFaces[e];
        if (ef.length !== 2) continue;
        const g = ef[0] === f ? ef[1] : ef[0];
        if (visited[g] || !s.faces.has(g)) continue;
        const a = face[i];
        const b = face[(i + 1) % face.length];
        const fForward = !flip[f]; // f effectively traverses a→b
        const gForward = traverses(src.faces[g], a, b);
        flip[g] = gForward === fForward ? 1 : 0;
        visited[g] = 1;
        island.push(g);
        queue.push(g);
      }
    }
    // Islands bordering unselected faces follow those neighbours (they are trusted); free islands
    // are oriented outwards by their signed volume relative to the island centroid.
    let vote = 0;
    for (const f of island) {
      const face = src.faces[f];
      for (let i = 0; i < face.length; i++) {
        const ef = topo.edgeFaces[topo.faceEdges[f][i]];
        if (ef.length !== 2) continue;
        const g = ef[0] === f ? ef[1] : ef[0];
        if (s.faces.has(g)) continue;
        const fForward = !flip[f];
        vote += traverses(src.faces[g], face[i], face[(i + 1) % face.length]) === fForward ? -1 : 1;
      }
    }
    let reverse = vote < 0;
    if (vote === 0) {
      const c: Vec3 = [0, 0, 0];
      const lo: Vec3 = [Infinity, Infinity, Infinity];
      const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      let cnt = 0;
      for (const f of island)
        for (const v of src.faces[f]) {
          for (let k = 0; k < 3; k++) {
            c[k] += P[v * 3 + k];
            lo[k] = Math.min(lo[k], P[v * 3 + k]);
            hi[k] = Math.max(hi[k], P[v * 3 + k]);
          }
          cnt++;
        }
      c[0] /= cnt;
      c[1] /= cnt;
      c[2] /= cnt;
      let vol = 0;
      for (const f of island) {
        const face = flip[f] ? src.faces[f].slice().reverse() : src.faces[f];
        const p0 = face[0] * 3;
        for (let i = 1; i + 1 < face.length; i++) {
          const p1 = face[i] * 3;
          const p2 = face[i + 1] * 3;
          const ax = P[p0] - c[0];
          const ay = P[p0 + 1] - c[1];
          const az = P[p0 + 2] - c[2];
          const bx = P[p1] - c[0];
          const by = P[p1 + 1] - c[1];
          const bz = P[p1 + 2] - c[2];
          const cx = P[p2] - c[0];
          const cy = P[p2 + 1] - c[1];
          const cz = P[p2 + 2] - c[2];
          vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
        }
      }
      // Flat islands have no meaningful volume: keep them as they are.
      const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      reverse = vol < -1e-9 * size * size * size;
    }
    if (reverse !== inside) for (const f of island) flip[f] ^= 1;
  }
  const m = cloneMesh(src);
  const recs = allFaceRecs(src);
  for (let f = 0; f < F; f++) if (flip[f]) reverseFace(recs[f]);
  writeFaces(m, recs);
  return { mesh: m, selection: selectionFromFaces(m, s.faces) };
}
