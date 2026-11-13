import { z } from 'zod';
import type { Mat4 } from '../math/types';
import { identity4, invert4, multiply4, scaling4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { edgeKey, parseEdgeKey, vertexCount } from '../mesh/types';
import type { ModifierDef } from './registry';
import {
  MeshBuilder,
  boundsDiagonal,
  hasColors,
  mergeVerticesByMap,
  ownerToObjectSpace,
  reverseUVPairs,
  transformPositions,
  zBool3,
  zObjectRef,
} from './util';

const schema = z.object({
  use_axis: zBool3([true, false, false]).describe(
    'Mirror across the local X, Y and/or Z axis (applied in that order)',
  ),
  use_bisect_axis: zBool3([false, false, false]).describe(
    'Cut the mesh at the mirror plane and discard the negative side first',
  ),
  use_bisect_flip_axis: zBool3([false, false, false]).describe(
    'Discard the positive side instead when bisecting',
  ),
  mirror_object: zObjectRef('Object whose origin/orientation defines the mirror planes (null = own origin)'),
  use_mirror_merge: z
    .boolean()
    .default(true)
    .describe('Merge vertices on the mirror plane with their mirrored copy'),
  merge_threshold: z
    .number()
    .min(0)
    .default(0.001)
    .describe('Maximum distance between a vertex and its mirror for merging'),
  use_clip: z.boolean().default(false).describe('Edit-mode clipping (no effect on evaluation)'),
  use_mirror_u: z.boolean().default(false).describe('Flip U of mirrored faces (u → 1 − u + mirror_offset_u)'),
  use_mirror_v: z.boolean().default(false).describe('Flip V of mirrored faces (v → 1 − v + mirror_offset_v)'),
  mirror_offset_u: z.number().default(0),
  mirror_offset_v: z.number().default(0),
  offset_u: z.number().default(0).describe('U offset added to mirrored faces'),
  offset_v: z.number().default(0).describe('V offset added to mirrored faces'),
});

type MirrorParams = z.infer<typeof schema>;

/**
 * Cuts the mesh by a plane given as per-vertex signed distances and removes everything on the negative
 * side. Intersection vertices are shared between neighbouring faces; UVs and colors are interpolated.
 */
export function bisectByDistance(m: MeshData, dist: ArrayLike<number>, eps: number): MeshData {
  const n = vertexCount(m);
  const P = m.positions;
  const colors = hasColors(m) ? m.colors! : null;
  const side = new Int8Array(n);
  for (let i = 0; i < n; i++) side[i] = dist[i] > eps ? 1 : dist[i] < -eps ? -1 : 0;
  const b = MeshBuilder.like(m);
  const map = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (side[i] >= 0) map[i] = b.addVertex(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], colors, i);
  }
  const cuts = new Map<string, number>();
  const crosses = (a: number, c: number) => (side[a] > 0 && side[c] < 0) || (side[a] < 0 && side[c] > 0);
  const cut = (a: number, c: number): number => {
    const k = edgeKey(a, c);
    let idx = cuts.get(k);
    if (idx !== undefined) return idx;
    const lo = Math.min(a, c);
    const hi = Math.max(a, c);
    const t = dist[lo] / (dist[lo] - dist[hi]);
    const rgba = colors
      ? [0, 1, 2, 3].map((q) => colors[lo * 4 + q] + (colors[hi * 4 + q] - colors[lo * 4 + q]) * t)
      : null;
    idx = b.addVertexRGBA(
      P[lo * 3] + (P[hi * 3] - P[lo * 3]) * t,
      P[lo * 3 + 1] + (P[hi * 3 + 1] - P[lo * 3 + 1]) * t,
      P[lo * 3 + 2] + (P[hi * 3 + 2] - P[lo * 3 + 2]) * t,
      rgba,
    );
    cuts.set(k, idx);
    return idx;
  };
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const uv = m.uvs ? m.uvs[f] : null;
    const verts: number[] = [];
    const nuv: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const c = face[(i + 1) % face.length];
      if (side[a] >= 0) {
        verts.push(map[a]);
        if (uv) nuv.push(uv[i * 2], uv[i * 2 + 1]);
      }
      if (crosses(a, c)) {
        verts.push(cut(a, c));
        if (uv) {
          const t = dist[a] / (dist[a] - dist[c]);
          const j = (i + 1) % face.length;
          nuv.push(
            uv[i * 2] + (uv[j * 2] - uv[i * 2]) * t,
            uv[i * 2 + 1] + (uv[j * 2 + 1] - uv[i * 2 + 1]) * t,
          );
        }
      }
    }
    if (verts.length >= 3) b.addFace(verts, m.faceMaterials[f], m.faceSmooth[f], uv ? nuv : null);
  }
  for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
    const a = m.looseEdges[i];
    const c = m.looseEdges[i + 1];
    if (side[a] >= 0 && side[c] >= 0) b.addLooseEdge(map[a], map[c]);
    else if (crosses(a, c)) b.addLooseEdge(side[a] > 0 ? map[a] : map[c], cut(a, c));
  }
  for (const k in m.edgeAttrs) {
    const [a, c] = parseEdgeKey(k);
    if (a >= n || c >= n) continue;
    if (side[a] >= 0 && side[c] >= 0) b.setEdgeAttr(map[a], map[c], m.edgeAttrs[k]);
    else if (crosses(a, c) && cuts.has(k))
      b.setEdgeAttr(side[a] > 0 ? map[a] : map[c], cuts.get(k)!, m.edgeAttrs[k]);
  }
  return b.build();
}

/**
 * Appends a mirrored copy (transform `T`, which must be orientation-reversing) with flipped winding, then
 * merges every vertex closer than `threshold` to its own mirror image (placing it halfway).
 */
function mirrorOnce(m: MeshData, T: Mat4, p: MirrorParams): MeshData {
  const n = vertexCount(m);
  const mirrored = transformPositions(m.positions, T);
  const positions = m.positions.concat(mirrored);
  const colors = hasColors(m) ? m.colors!.concat(m.colors!) : null;
  const faces = m.faces.map((f) => f.slice());
  const faceMaterials = m.faceMaterials.slice();
  const faceSmooth = m.faceSmooth.slice();
  const uvs = m.uvs ? m.uvs.map((u) => u.slice()) : null;
  for (let f = 0; f < m.faces.length; f++) {
    faces.push(m.faces[f].map((v) => v + n).reverse());
    faceMaterials.push(m.faceMaterials[f]);
    faceSmooth.push(m.faceSmooth[f]);
    if (uvs && m.uvs) {
      const uv = reverseUVPairs(m.uvs[f]);
      for (let i = 0; i < uv.length; i += 2) {
        if (p.use_mirror_u) uv[i] = 1 - uv[i] + p.mirror_offset_u;
        if (p.use_mirror_v) uv[i + 1] = 1 - uv[i + 1] + p.mirror_offset_v;
        uv[i] += p.offset_u;
        uv[i + 1] += p.offset_v;
      }
      uvs.push(uv);
    }
  }
  const looseEdges = m.looseEdges.concat(m.looseEdges.map((v) => v + n));
  const edgeAttrs: MeshData['edgeAttrs'] = {};
  for (const k in m.edgeAttrs) {
    const [a, b] = parseEdgeKey(k);
    edgeAttrs[k] = { ...m.edgeAttrs[k] };
    edgeAttrs[edgeKey(a + n, b + n)] = { ...m.edgeAttrs[k] };
  }
  const doubled: MeshData = {
    positions,
    faces,
    faceMaterials,
    faceSmooth,
    uvs,
    colors,
    edgeAttrs,
    looseEdges,
  };
  const target = new Int32Array(n * 2);
  for (let i = 0; i < n * 2; i++) target[i] = i;
  if (!p.use_mirror_merge) return doubled;
  const t2 = p.merge_threshold * p.merge_threshold;
  let merged = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - mirrored[i * 3];
    const dy = positions[i * 3 + 1] - mirrored[i * 3 + 1];
    const dz = positions[i * 3 + 2] - mirrored[i * 3 + 2];
    if (dx * dx + dy * dy + dz * dz <= t2) {
      target[n + i] = i;
      for (let k = 0; k < 3; k++) positions[i * 3 + k] = (positions[i * 3 + k] + mirrored[i * 3 + k]) / 2;
      merged++;
    }
  }
  if (!merged) return doubled;
  // Faces whose vertices all merge with their mirror lie in the mirror plane and coincide with their own
  // mirror copy. When attached to other geometry they would become zero-thickness internal fins, so both
  // copies are dropped (a mesh lying entirely in the plane keeps one copy via duplicate removal).
  const F = m.faces.length;
  const inPlane = m.faces.map((f) => f.every((v) => target[n + v] === v));
  if (inPlane.some(Boolean)) {
    const otherEdges = new Set<string>();
    for (let f = 0; f < F; f++) {
      if (inPlane[f]) continue;
      const face = m.faces[f];
      for (let i = 0; i < face.length; i++) otherEdges.add(edgeKey(face[i], face[(i + 1) % face.length]));
    }
    const drop = new Set<number>();
    for (let f = 0; f < F; f++) {
      if (!inPlane[f]) continue;
      const face = m.faces[f];
      if (face.some((v, i) => otherEdges.has(edgeKey(v, face[(i + 1) % face.length])))) {
        drop.add(f);
        drop.add(F + f);
      }
    }
    if (drop.size) {
      const keep = (_: unknown, f: number) => !drop.has(f);
      doubled.faces = doubled.faces.filter(keep);
      doubled.faceMaterials = doubled.faceMaterials.filter(keep);
      doubled.faceSmooth = doubled.faceSmooth.filter(keep);
      if (doubled.uvs) doubled.uvs = doubled.uvs.filter(keep);
    }
  }
  return mergeVerticesByMap(doubled, target, positions);
}

export function mirrorMesh(mesh: MeshData, p: MirrorParams, toMirrorSpace: Mat4 = identity4()): MeshData {
  const fromMirrorSpace = invert4(toMirrorSpace);
  let cur = mesh;
  for (let axis = 0; axis < 3; axis++) {
    if (!p.use_axis[axis]) continue;
    if (p.use_bisect_axis[axis]) {
      const local = transformPositions(cur.positions, toMirrorSpace);
      const sign = p.use_bisect_flip_axis[axis] ? -1 : 1;
      const dist = new Float64Array(local.length / 3);
      for (let i = 0; i < dist.length; i++) dist[i] = sign * local[i * 3 + axis];
      const eps = Math.max(1e-9, boundsDiagonal(local) * 1e-7);
      cur = bisectByDistance(cur, dist, eps);
    }
    const s: [number, number, number] = [1, 1, 1];
    s[axis] = -1;
    const T = multiply4(fromMirrorSpace, multiply4(scaling4(s), toMirrorSpace));
    cur = mirrorOnce(cur, T, p);
  }
  return cur;
}

export const mirrorModifier: ModifierDef<typeof schema> = {
  type: 'MIRROR',
  label: 'Mirror',
  category: 'GENERATE',
  description:
    'Mirrors the mesh across the local X/Y/Z planes of the object (or of `mirror_object`). Mirrored faces get flipped ' +
    'winding so normals stay outward; vertices within `merge_threshold` of the plane are welded to their mirror. ' +
    '`use_bisect_axis` first cuts the mesh at the plane and removes the negative side (positive side with ' +
    '`use_bisect_flip_axis`). Typical use: model one half of a symmetric object.',
  schema,
  dependencies: (p) => (p.mirror_object ? [p.mirror_object] : []),
  apply(mesh, p, ctx) {
    if (!p.use_axis.some(Boolean) || mesh.positions.length === 0) return mesh;
    const toMirror = (p.mirror_object && ownerToObjectSpace(ctx, p.mirror_object)) || identity4();
    return mirrorMesh(mesh, p, toMirror);
  },
};
