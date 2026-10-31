import type { MeshData } from './types';
import { cloneMesh, edgeKey, parseEdgeKey, pruneEdgeData, vertexCount } from './types';

/**
 * Merges vertices closer than `distance` (Blender "Merge by Distance" / Weld).
 * If `onlyVerts` is given, only those vertices participate.
 * Collapsed duplicate corners are removed from faces; faces reduced below 3 corners are deleted.
 * Returns the new mesh and the number of removed vertices.
 */
export function mergeByDistance(
  src: MeshData,
  distance: number,
  onlyVerts?: Set<number>,
): { mesh: MeshData; removed: number; remap: Int32Array } {
  const m = cloneMesh(src);
  const n = vertexCount(m);
  const target = new Int32Array(n);
  for (let i = 0; i < n; i++) target[i] = i;
  const d = Math.max(distance, 1e-12);
  const d2 = d * d;
  const cell = d * 2;
  const grid = new Map<string, number[]>();
  const p = m.positions;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let i = 0; i < n; i++) {
    if (onlyVerts && !onlyVerts.has(i)) continue;
    const cx = Math.floor(p[i * 3] / cell);
    const cy = Math.floor(p[i * 3 + 1] / cell);
    const cz = Math.floor(p[i * 3 + 2] / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const bucket = grid.get(key(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            const ex = p[i * 3] - p[j * 3];
            const ey = p[i * 3 + 1] - p[j * 3 + 1];
            const ez = p[i * 3 + 2] - p[j * 3 + 2];
            if (ex * ex + ey * ey + ez * ez <= d2) {
              found = j;
              break;
            }
          }
        }
    if (found >= 0) target[i] = found;
    else {
      const k = key(cx, cy, cz);
      const bucket = grid.get(k);
      if (bucket) bucket.push(i);
      else grid.set(k, [i]);
    }
  }
  let merged = 0;
  for (let i = 0; i < n; i++) if (target[i] !== i) merged++;
  if (merged === 0) {
    const id = new Int32Array(n);
    for (let i = 0; i < n; i++) id[i] = i;
    return { mesh: m, removed: 0, remap: id };
  }
  // Rewrite faces, dropping consecutive duplicates (and duplicate corners in general).
  const keepFace: boolean[] = [];
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const uv = m.uvs ? m.uvs[f] : null;
    const nf: number[] = [];
    const nuv: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const v = target[face[i]];
      if (nf.includes(v)) continue;
      nf.push(v);
      if (uv) nuv.push(uv[i * 2], uv[i * 2 + 1]);
    }
    m.faces[f] = nf;
    if (m.uvs && uv) m.uvs[f] = nuv;
    keepFace.push(nf.length >= 3);
  }
  // Remove faces that became degenerate or exact duplicates of another face.
  const seen = new Set<string>();
  const keep = keepFace.map((k, f) => {
    if (!k) return false;
    const sig = [...m.faces[f]].sort((a, b) => a - b).join(',');
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  m.faces = m.faces.filter((_, f) => keep[f]);
  m.faceMaterials = m.faceMaterials.filter((_, f) => keep[f]);
  m.faceSmooth = m.faceSmooth.filter((_, f) => keep[f]);
  if (m.uvs) m.uvs = m.uvs.filter((_, f) => keep[f]);
  m.looseEdges = m.looseEdges.map((v) => target[v]);
  const attrs: MeshData['edgeAttrs'] = {};
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    const ta = target[a];
    const tb = target[b];
    if (ta !== tb) attrs[edgeKey(ta, tb)] = m.edgeAttrs[k];
  }
  m.edgeAttrs = attrs;
  pruneEdgeData(m);
  // Drop only the merged-away vertices (loose vertices that were not merged are preserved).
  const compact = new Int32Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) if (target[i] === i) compact[i] = next++;
  const pos = new Array<number>(next * 3);
  const col = m.colors ? new Array<number>(next * 4) : null;
  for (let i = 0; i < n; i++) {
    const j = compact[i];
    if (j < 0) continue;
    pos[j * 3] = p[i * 3];
    pos[j * 3 + 1] = p[i * 3 + 1];
    pos[j * 3 + 2] = p[i * 3 + 2];
    if (col && m.colors) for (let k = 0; k < 4; k++) col[j * 4 + k] = m.colors[i * 4 + k];
  }
  m.positions = pos;
  if (col) m.colors = col;
  m.faces = m.faces.map((f) => f.map((v) => compact[v]));
  m.looseEdges = m.looseEdges.map((v) => compact[v]);
  const attrs2: MeshData['edgeAttrs'] = {};
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    attrs2[edgeKey(compact[a], compact[b])] = m.edgeAttrs[k];
  }
  m.edgeAttrs = attrs2;
  const remap = new Int32Array(n);
  for (let i = 0; i < n; i++) remap[i] = compact[target[i]];
  return { mesh: m, removed: n - next, remap };
}
