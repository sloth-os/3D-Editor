import { z } from 'zod';
import type { MeshData } from '../mesh/types';
import { createMesh, vertexCount } from '../mesh/types';
import { buildTopology } from '../mesh/topology';
import type { ModifierDef } from './registry';
import { MeshBuilder, evenOffsetFactors, faceNormalsOf, hasColors, vertexNormalsOf } from './util';

const schema = z.object({
  thickness: z.number().default(0.02).describe('Width/depth of the wire beams'),
  offset: z
    .number()
    .min(-1)
    .max(1)
    .default(0)
    .describe('Shift the beams inward (-1) or outward (1) along the normals'),
  use_replace: z
    .boolean()
    .default(true)
    .describe('Remove the original faces (otherwise keep them inside the frame)'),
  use_even_offset: z.boolean().default(true).describe('Keep the beam width constant at sharp corners'),
  use_relative_offset: z.boolean().default(false).describe('Scale the thickness by the local edge length'),
  use_boundary: z.boolean().default(false).describe('Close the beams along open mesh boundaries'),
  use_crease: z.boolean().default(false).describe('Crease the long beam edges (for subdivision afterwards)'),
  crease_weight: z.number().min(0).max(1).default(1),
  material_offset: z.number().int().default(0).describe('Material index offset for the wire faces'),
});

type WireframeParams = z.infer<typeof schema>;

export function wireframeMesh(m: MeshData, p: WireframeParams): MeshData {
  const n = vertexCount(m);
  const P = m.positions;
  const fn = faceNormalsOf(m);
  const vn = vertexNormalsOf(m, fn);
  const even = p.use_even_offset ? evenOffsetFactors(m, vn, fn) : null;
  const colors = hasColors(m) ? m.colors! : null;
  const topo = buildTopology(m);
  // optional per-vertex thickness scale from the local edge length
  const scale = new Float64Array(n).fill(1);
  if (p.use_relative_offset && topo.edges.length) {
    const len = topo.edges.map(([a, b]) =>
      Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]),
    );
    const mean = len.reduce((s, l) => s + l, 0) / len.length || 1;
    for (let v = 0; v < n; v++) {
      const es = topo.vertEdges[v];
      if (es.length) scale[v] = es.reduce((s, e) => s + len[e], 0) / es.length / mean;
    }
  }
  const tOut = (p.thickness * (p.offset + 1)) / 2;
  const tIn = (p.thickness * (p.offset - 1)) / 2;
  const b = new MeshBuilder({ colors: !!colors, uvs: !!m.uvs });
  const used = new Uint8Array(n);
  for (const f of m.faces) for (const v of f) used[v] = 1;
  const shell = (v: number, t: number, ox = 0, oy = 0, oz = 0) => {
    const s = t * scale[v] * (even ? even[v] : 1);
    return b.addVertex(
      P[v * 3] + ox + vn[v * 3] * s,
      P[v * 3 + 1] + oy + vn[v * 3 + 1] * s,
      P[v * 3 + 2] + oz + vn[v * 3 + 2] * s,
      colors,
      v,
    );
  };
  const outer = new Int32Array(n).fill(-1);
  const inner = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    if (!used[v]) continue;
    outer[v] = shell(v, tOut);
    inner[v] = shell(v, tIn);
  }
  const crease = p.use_crease && p.crease_weight > 0 ? { crease: p.crease_weight } : null;
  const boundaryUsed = new Map<number, { f: number; i: number }>();
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const L = face.length;
    if (L < 3) continue;
    const nx = fn[f * 3];
    const ny = fn[f * 3 + 1];
    const nz = fn[f * 3 + 2];
    const uv = m.uvs ? m.uvs[f] : null;
    const so: number[] = [];
    const si: number[] = [];
    const cuv: number[] = [];
    for (let i = 0; i < L; i++) {
      const v = face[i];
      const prev = face[(i + L - 1) % L];
      const next = face[(i + 1) % L];
      // edge directions
      let e0x = P[v * 3] - P[prev * 3];
      let e0y = P[v * 3 + 1] - P[prev * 3 + 1];
      let e0z = P[v * 3 + 2] - P[prev * 3 + 2];
      let e1x = P[next * 3] - P[v * 3];
      let e1y = P[next * 3 + 1] - P[v * 3 + 1];
      let e1z = P[next * 3 + 2] - P[v * 3 + 2];
      const l0 = Math.hypot(e0x, e0y, e0z) || 1;
      const l1 = Math.hypot(e1x, e1y, e1z) || 1;
      e0x /= l0;
      e0y /= l0;
      e0z /= l0;
      e1x /= l1;
      e1y /= l1;
      e1z /= l1;
      // inward perpendiculars (left of the edge direction for CCW faces)
      const i0x = ny * e0z - nz * e0y;
      const i0y = nz * e0x - nx * e0z;
      const i0z = nx * e0y - ny * e0x;
      const i1x = ny * e1z - nz * e1y;
      const i1y = nz * e1x - nx * e1z;
      const i1z = nx * e1y - ny * e1x;
      const d = (Math.abs(p.thickness) / 2) * scale[v];
      let wx = i0x + i1x;
      let wy = i0y + i1y;
      let wz = i0z + i1z;
      const c = i0x * i1x + i0y * i1y + i0z * i1z;
      const wl = Math.hypot(wx, wy, wz);
      if (wl < 1e-9) {
        wx = i1x * d;
        wy = i1y * d;
        wz = i1z * d;
      } else if (p.use_even_offset) {
        const k = Math.min(d / Math.max(1 + c, 1e-6), (4 * d) / wl);
        wx *= k;
        wy *= k;
        wz *= k;
      } else {
        wx *= d / wl;
        wy *= d / wl;
        wz *= d / wl;
      }
      so.push(shell(v, tOut, wx, wy, wz));
      si.push(shell(v, tIn, wx, wy, wz));
      if (uv) {
        // express the inset offset in the corner's edge basis to interpolate the UV
        const ax = P[prev * 3] - P[v * 3];
        const ay = P[prev * 3 + 1] - P[v * 3 + 1];
        const az = P[prev * 3 + 2] - P[v * 3 + 2];
        const bx = P[next * 3] - P[v * 3];
        const by = P[next * 3 + 1] - P[v * 3 + 1];
        const bz = P[next * 3 + 2] - P[v * 3 + 2];
        const aa = ax * ax + ay * ay + az * az;
        const ab = ax * bx + ay * by + az * bz;
        const bb = bx * bx + by * by + bz * bz;
        const wa = wx * ax + wy * ay + wz * az;
        const wb = wx * bx + wy * by + wz * bz;
        const det = aa * bb - ab * ab;
        const al = Math.abs(det) > 1e-20 ? (wa * bb - wb * ab) / det : 0;
        const be = Math.abs(det) > 1e-20 ? (wb * aa - wa * ab) / det : 0;
        const ip = (i + L - 1) % L;
        const inx = (i + 1) % L;
        cuv.push(
          uv[i * 2] + al * (uv[ip * 2] - uv[i * 2]) + be * (uv[inx * 2] - uv[i * 2]),
          uv[i * 2 + 1] + al * (uv[ip * 2 + 1] - uv[i * 2 + 1]) + be * (uv[inx * 2 + 1] - uv[i * 2 + 1]),
        );
      }
    }
    const mat = Math.max(0, (m.faceMaterials[f] ?? 0) + p.material_offset);
    const smooth = m.faceSmooth[f] ?? false;
    for (let i = 0; i < L; i++) {
      const j = (i + 1) % L;
      const a = face[i];
      const c = face[j];
      const U = (k: number) => (uv ? [uv[k * 2], uv[k * 2 + 1]] : [0, 0]);
      const S = (k: number) => (uv ? [cuv[k * 2], cuv[k * 2 + 1]] : [0, 0]);
      b.addFace(
        [outer[a], outer[c], so[j], so[i]],
        mat,
        smooth,
        uv ? [...U(i), ...U(j), ...S(j), ...S(i)] : null,
      );
      b.addFace(
        [inner[c], inner[a], si[i], si[j]],
        mat,
        smooth,
        uv ? [...U(j), ...U(i), ...S(i), ...S(j)] : null,
      );
      b.addFace([so[i], so[j], si[j], si[i]], mat, smooth, uv ? [...S(i), ...S(j), ...S(j), ...S(i)] : null);
      if (crease) {
        b.setEdgeAttr(outer[a], outer[c], crease);
        b.setEdgeAttr(inner[a], inner[c], crease);
        b.setEdgeAttr(so[i], so[j], crease);
        b.setEdgeAttr(si[i], si[j], crease);
      }
      const e = topo.faceEdges[f][i];
      if (topo.edgeFaces[e].length === 1) boundaryUsed.set(e, { f, i });
    }
  }
  if (p.use_boundary) {
    for (const { f, i } of boundaryUsed.values()) {
      const face = m.faces[f];
      const j = (i + 1) % face.length;
      const a = face[i];
      const c = face[j];
      const uv = m.uvs ? m.uvs[f] : null;
      const quadUV = uv
        ? [
            uv[j * 2],
            uv[j * 2 + 1],
            uv[i * 2],
            uv[i * 2 + 1],
            uv[i * 2],
            uv[i * 2 + 1],
            uv[j * 2],
            uv[j * 2 + 1],
          ]
        : null;
      b.addFace(
        [outer[c], outer[a], inner[a], inner[c]],
        Math.max(0, (m.faceMaterials[f] ?? 0) + p.material_offset),
        m.faceSmooth[f] ?? false,
        quadUV,
      );
    }
  }
  if (!p.use_replace) {
    const base = b.vertexCount;
    for (let v = 0; v < n; v++) b.addVertex(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], colors, v);
    for (let f = 0; f < m.faces.length; f++) {
      b.addFace(
        m.faces[f].map((v) => v + base),
        m.faceMaterials[f] ?? 0,
        m.faceSmooth[f] ?? false,
        m.uvs ? m.uvs[f].slice() : null,
      );
    }
    for (let i = 0; i + 1 < m.looseEdges.length; i += 2)
      b.addLooseEdge(m.looseEdges[i] + base, m.looseEdges[i + 1] + base);
  }
  return b.build();
}

export const wireframeModifier: ModifierDef<typeof schema> = {
  type: 'WIREFRAME',
  label: 'Wireframe',
  category: 'GENERATE',
  description:
    'Turns every edge into a solid beam of `thickness`: each face is replaced by a frame of quads (outer side, inner ' +
    'side and the wall around the opening), so a closed input gives a closed, consistently wound wire mesh. ' +
    '`use_boundary` closes beams on open edges; `use_replace` false keeps the original faces too.',
  schema,
  apply(mesh, p) {
    if (mesh.faces.length === 0) return p.use_replace ? createMesh() : mesh;
    return wireframeMesh(mesh, p);
  },
};
