import type { MeshData } from '../../mesh/types';
import { buildRenderBuffers } from '../../mesh/render-buffers';
import { buildBVH, type BVH } from './bvh';

/**
 * Ray-tracing geometry of one mesh (bottom-level acceleration structure). Triangles are stored in
 * BVH leaf order; per-vertex attributes come from the mesh's render buffers, so smooth normals
 * honour `faceSmooth` and sharp edges exactly like the rasterizer and the viewport.
 * Plain typed arrays only (can be posted to a worker).
 */
export interface MeshGeometry {
  triCount: number;
  /** Object-space triangle corners, 9 floats per triangle (v0, v1, v2). */
  verts: Float32Array;
  /** Render-vertex index of each corner (3 per triangle), for normals/UVs/colours. */
  vidx: Uint32Array;
  /** Material slot of each triangle. */
  slot: Uint16Array;
  /** 1 when the corner normals differ from the face normal (smooth shading). */
  smooth: Uint8Array;
  /** Per render vertex: unit normal (3), UV (2) and linear RGBA colour (4). */
  normals: Float32Array;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  bvh: BVH;
  /** Object-space bounds: min xyz, max xyz. */
  bounds: Float64Array;
  /** Triangles dropped because they were degenerate or not finite. */
  skipped: number;
}

const cache = new WeakMap<MeshData, MeshGeometry>();

/**
 * Builds (or returns the cached) ray-tracing geometry of a mesh. Meshes are immutable by
 * convention, so the cache is keyed by the mesh object itself.
 */
export function meshGeometry(mesh: MeshData): MeshGeometry {
  let g = cache.get(mesh);
  if (!g) {
    g = buildMeshGeometry(mesh);
    cache.set(mesh, g);
  }
  return g;
}

function buildMeshGeometry(mesh: MeshData): MeshGeometry {
  const rb = buildRenderBuffers(mesh);
  const P = rb.positions;
  const N = rb.normals;
  const idx = rb.indices;
  const total = idx.length / 3;
  const triSlot = new Uint16Array(total);
  for (const g of rb.groups) {
    const s = Math.max(0, Math.min(65535, g.materialIndex | 0));
    triSlot.fill(s, g.start / 3, (g.start + g.count) / 3);
  }
  // keep finite, non-degenerate triangles
  const keep = new Uint32Array(total);
  let n = 0;
  for (let t = 0; t < total; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
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
    if (!(len2 > 0) || !Number.isFinite(len2)) continue;
    keep[n++] = t;
  }
  const boxes = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    const t = keep[i];
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const x = P[v];
      const y = P[v + 1];
      const z = P[v + 2];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (z > z1) z1 = z;
    }
    const o = i * 6;
    boxes[o] = x0;
    boxes[o + 1] = y0;
    boxes[o + 2] = z0;
    boxes[o + 3] = x1;
    boxes[o + 4] = y1;
    boxes[o + 5] = z1;
  }
  const bvh = buildBVH(boxes, n, 4);
  const verts = new Float32Array(n * 9);
  const vidx = new Uint32Array(n * 3);
  const slot = new Uint16Array(n);
  const smooth = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = keep[bvh.prims[i]];
    let fx: number;
    let fy: number;
    let fz: number;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      vidx[i * 3 + k] = v;
      verts[i * 9 + k * 3] = P[v * 3];
      verts[i * 9 + k * 3 + 1] = P[v * 3 + 1];
      verts[i * 9 + k * 3 + 2] = P[v * 3 + 2];
    }
    {
      const o = i * 9;
      const ex = verts[o + 3] - verts[o];
      const ey = verts[o + 4] - verts[o + 1];
      const ez = verts[o + 5] - verts[o + 2];
      const gx = verts[o + 6] - verts[o];
      const gy = verts[o + 7] - verts[o + 1];
      const gz = verts[o + 8] - verts[o + 2];
      fx = ey * gz - ez * gy;
      fy = ez * gx - ex * gz;
      fz = ex * gy - ey * gx;
      const l = Math.hypot(fx, fy, fz) || 1;
      fx /= l;
      fy /= l;
      fz /= l;
    }
    let flat = true;
    for (let k = 0; k < 3 && flat; k++) {
      const v = vidx[i * 3 + k] * 3;
      if (N[v] * fx + N[v + 1] * fy + N[v + 2] * fz < 0.99999) flat = false;
    }
    smooth[i] = flat ? 0 : 1;
    slot[i] = triSlot[t];
  }
  // leaves reference triangles directly by position
  for (let i = 0; i < n; i++) bvh.prims[i] = i;
  const bounds = new Float64Array(6);
  bounds.set(bvh.bounds.subarray(0, 6));
  return {
    triCount: n,
    verts,
    vidx,
    slot,
    smooth,
    normals: N,
    uvs: rb.uvs,
    colors: rb.colors,
    bvh,
    bounds,
    skipped: total - n,
  };
}
