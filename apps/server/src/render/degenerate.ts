import { buildRenderBuffers, type Mat4, type MeshData, type RenderItem } from '@3d-editor/core';

/*
 * Names the objects behind the path tracer's "N degenerate triangle(s) skipped" warning. The core
 * scene compiler (render/pathtrace/compile.ts) drops zero-area and non-finite triangles of the
 * render geometry and only reports their number; without the objects an agent has to bisect the
 * scene with hide_render to find them. The triangles are counted here the way the compiler does
 * (the triangulated render buffers, float32 positions, |cross product|² > 0 and finite), per
 * distinct mesh like the compiler, and only when the compiler reported some.
 */

/** The aggregated warning of the core scene compiler. */
const DEGENERATE_WARNING = /^(\d+) degenerate triangle\(s\) skipped$/;
/** Objects named in the warning at most. */
const MAX_NAMED = 8;

const counts = new WeakMap<MeshData, number>();

/** Degenerate (zero-area or non-finite) triangles of a mesh's render triangulation. */
export function degenerateTriangleCount(mesh: MeshData): number {
  let n = counts.get(mesh);
  if (n === undefined) {
    n = countDegenerate(mesh);
    counts.set(mesh, n);
  }
  return n;
}

function countDegenerate(mesh: MeshData): number {
  if (!mesh.faces.length) return 0;
  const rb = buildRenderBuffers(mesh);
  const P = rb.positions;
  const idx = rb.indices;
  let n = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ex = P[b] - P[a];
    const ey = P[b + 1] - P[a + 1];
    const ez = P[b + 2] - P[a + 2];
    const fx = P[c] - P[a];
    const fy = P[c + 1] - P[a + 1];
    const fz = P[c + 2] - P[a + 2];
    const nx = ey * fz - ez * fy;
    const ny = ez * fx - ex * fz;
    const nz = ex * fy - ey * fx;
    const len2 = nx * nx + ny * ny + nz * nz;
    if (!(len2 > 0) || !Number.isFinite(len2)) n++;
  }
  return n;
}

/**
 * Whether the compiler bakes this transform into the geometry (a singular matrix, e.g. a scale of
 * 0 on an axis): such an object's triangles are checked in world space.
 */
function singular(M: Mat4): boolean {
  const det =
    M[0] * (M[5] * M[10] - M[6] * M[9]) -
    M[4] * (M[1] * M[10] - M[2] * M[9]) +
    M[8] * (M[1] * M[6] - M[2] * M[5]);
  const sx = Math.hypot(M[0], M[1], M[2]);
  const sy = Math.hypot(M[4], M[5], M[6]);
  const sz = Math.hypot(M[8], M[9], M[10]);
  return !(Math.abs(det) > 1e-12 * sx * sy * sz);
}

function bakeTransform(mesh: MeshData, M: Mat4): MeshData {
  const p = mesh.positions;
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
    out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
    out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
  }
  return { ...mesh, positions: out };
}

/**
 * `warnings` with the compiler's degenerate triangle warning extended by the objects the triangles
 * belong to, e.g. "4 degenerate triangle(s) skipped (zero-area or non-finite faces of the render
 * geometry; they do not render): 'Motto Plate' 4". Instanced objects are named once (the compiler
 * counts every distinct mesh once).
 */
export function nameDegenerateTriangles(warnings: readonly string[], items: readonly RenderItem[]): string[] {
  const i = warnings.findIndex((w) => DEGENERATE_WARNING.test(w));
  if (i < 0) return [...warnings];
  /** Objects (names) per distinct mesh, and the triangles of each. */
  const byMesh = new Map<MeshData, Set<string>>();
  const flattened: { name: string; n: number }[] = [];
  for (const item of items) {
    if (!item.mesh?.faces.length) continue;
    const name = item.object?.name ?? item.id;
    const M = item.worldMatrix;
    if (M && M.length >= 16 && M.every(Number.isFinite) && singular(M)) {
      const n = countDegenerate(bakeTransform(item.mesh, M));
      if (n > 0) flattened.push({ name: `${name} (scaled flat)`, n });
      continue;
    }
    let names = byMesh.get(item.mesh);
    if (!names) byMesh.set(item.mesh, (names = new Set()));
    names.add(name);
  }
  const found: { name: string; n: number }[] = [...flattened];
  for (const [mesh, names] of byMesh) {
    const n = degenerateTriangleCount(mesh);
    if (n > 0) found.push({ name: [...names].join("', '"), n });
  }
  const out = [...warnings];
  if (!found.length) return out;
  found.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const listed = found.slice(0, MAX_NAMED).map((f) => `'${f.name}' ${f.n}`);
  const more = found.length > MAX_NAMED ? `, and ${found.length - MAX_NAMED} more object(s)` : '';
  out[i] =
    `${warnings[i]} (zero-area or non-finite faces of the render geometry; they do not render): ` +
    `${listed.join(', ')}${more}`;
  return out;
}
