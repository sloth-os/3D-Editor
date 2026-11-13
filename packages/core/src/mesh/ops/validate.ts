import type { MeshData } from '../types';
import { edgeKey, parseEdgeKey, vertexCount } from '../types';

/**
 * Structural sanity check of a MeshData. Returns a list of human-readable problems (empty when
 * the mesh is valid). Used by tests and handy when debugging operators: every edit-mode
 * operation must return a mesh for which this returns `[]`.
 */
export function validateMesh(m: MeshData): string[] {
  const problems: string[] = [];
  const nv = vertexCount(m);
  if (m.positions.length % 3 !== 0) problems.push('positions length is not a multiple of 3');
  for (let i = 0; i < m.positions.length; i++)
    if (!Number.isFinite(m.positions[i])) {
      problems.push(`position component ${i} is not finite`);
      break;
    }
  const F = m.faces.length;
  if (m.faceMaterials.length !== F)
    problems.push(`faceMaterials length ${m.faceMaterials.length} != faces ${F}`);
  if (m.faceSmooth.length !== F) problems.push(`faceSmooth length ${m.faceSmooth.length} != faces ${F}`);
  if (m.uvs && m.uvs.length !== F) problems.push(`uvs length ${m.uvs.length} != faces ${F}`);
  const faceEdges = new Set<string>();
  for (let f = 0; f < F; f++) {
    const face = m.faces[f];
    if (face.length < 3) problems.push(`face ${f} has ${face.length} corners`);
    const seen = new Set<number>();
    for (const v of face) {
      if (!Number.isInteger(v) || v < 0 || v >= nv) problems.push(`face ${f} references invalid vertex ${v}`);
      if (seen.has(v)) problems.push(`face ${f} repeats vertex ${v}`);
      seen.add(v);
    }
    for (let i = 0; i < face.length; i++) faceEdges.add(edgeKey(face[i], face[(i + 1) % face.length]));
    if (m.uvs) {
      const uv = m.uvs[f];
      if (!uv || uv.length !== face.length * 2)
        problems.push(`uvs of face ${f} not aligned with its corners`);
      else if (uv.some((x) => !Number.isFinite(x)))
        problems.push(`uvs of face ${f} contain non-finite values`);
    }
  }
  if (m.colors) {
    if (m.colors.length !== nv * 4) problems.push(`colors length ${m.colors.length} != 4 × ${nv}`);
    else if (m.colors.some((x) => !Number.isFinite(x))) problems.push('colors contain non-finite values');
  }
  if (m.looseEdges.length % 2 !== 0) problems.push('looseEdges has odd length');
  const loose = new Set<string>();
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
    const a = m.looseEdges[i];
    const b = m.looseEdges[i + 1];
    if (a < 0 || a >= nv || b < 0 || b >= nv) problems.push(`loose edge ${a}-${b} out of range`);
    if (a === b) problems.push(`degenerate loose edge ${a}-${b}`);
    const k = edgeKey(a, b);
    if (faceEdges.has(k)) problems.push(`loose edge ${k} duplicates a face edge`);
    if (loose.has(k)) problems.push(`duplicate loose edge ${k}`);
    loose.add(k);
  }
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    if (k !== edgeKey(a, b)) problems.push(`edge attribute key ${k} is not canonical`);
    if (!faceEdges.has(k) && !loose.has(k)) problems.push(`edge attribute for missing edge ${k}`);
  }
  return problems;
}
