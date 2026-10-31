import { z } from 'zod';
import { invert4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { vertexCount } from '../mesh/types';
import { computeVertexNormals } from '../mesh/normals';
import type { ModifierDef } from './registry';
import { fbm3 } from './noise';
import { withPositions } from './util';

const schema = z.object({
  strength: z.number().default(1).describe('Displacement distance for a texture value of 1 above mid_level'),
  mid_level: z.number().default(0.5).describe('Texture value that causes no displacement'),
  direction: z
    .enum(['NORMAL', 'X', 'Y', 'Z', 'RGB_TO_XYZ'])
    .default('NORMAL')
    .describe('Displace along vertex normals, one axis, or the RGB texture channels mapped to XYZ'),
  space: z.enum(['LOCAL', 'GLOBAL']).default('LOCAL').describe('Axis space for X/Y/Z/RGB_TO_XYZ directions'),
  texture_type: z
    .enum(['NONE', 'CLOUDS', 'WAVES', 'CHECKER'])
    .default('CLOUDS')
    .describe(
      'Procedural texture: NONE (constant 1), CLOUDS (fractal noise), WAVES (sine bands), CHECKER (3D checker)',
    ),
  texture_coords: z
    .enum(['LOCAL', 'GLOBAL', 'UV'])
    .default('LOCAL')
    .describe('Coordinates used to look up the texture'),
  noise_scale: z.number().positive().default(0.25).describe('Texture feature size'),
  noise_depth: z.number().int().min(0).max(15).default(2).describe('Extra noise octaves for CLOUDS'),
  seed: z.number().int().default(0).describe('Random seed of the noise pattern'),
});

type DisplaceParams = z.infer<typeof schema>;

function sample(p: DisplaceParams, x: number, y: number, z: number, channel: number): number {
  const s = p.noise_scale;
  switch (p.texture_type) {
    case 'NONE':
      return 1;
    case 'CLOUDS': {
      const o = channel * 37.17;
      return fbm3(x / s + o, y / s - o, z / s + o * 0.5, p.noise_depth + 1, p.seed);
    }
    case 'WAVES':
      return 0.5 + 0.5 * Math.sin(((x + y + z) / s) * 2 * Math.PI + (channel * 2 * Math.PI) / 3 + p.seed);
    case 'CHECKER': {
      const c = Math.floor(x / s + 1e-9) + Math.floor(y / s + 1e-9) + Math.floor(z / s + 1e-9);
      return ((c % 2) + 2) % 2;
    }
  }
}

/** Per-vertex average UV (for UV texture coordinates). */
function vertexUVs(m: MeshData): Float64Array {
  const n = vertexCount(m);
  const out = new Float64Array(n * 2);
  const cnt = new Uint32Array(n);
  if (!m.uvs) return out;
  for (let f = 0; f < m.faces.length; f++) {
    const face = m.faces[f];
    const uv = m.uvs[f];
    for (let i = 0; i < face.length; i++) {
      out[face[i] * 2] += uv[i * 2] ?? 0;
      out[face[i] * 2 + 1] += uv[i * 2 + 1] ?? 0;
      cnt[face[i]]++;
    }
  }
  for (let i = 0; i < n; i++) {
    if (cnt[i]) {
      out[i * 2] /= cnt[i];
      out[i * 2 + 1] /= cnt[i];
    }
  }
  return out;
}

export const displaceModifier: ModifierDef<typeof schema> = {
  type: 'DISPLACE',
  label: 'Displace',
  category: 'DEFORM',
  description:
    'Moves vertices by a procedural texture value: offset = (texture − mid_level) × strength, along the vertex normal, ' +
    'a local/global axis, or per-channel along XYZ (RGB_TO_XYZ). Textures: CLOUDS (seeded fractal gradient noise, ' +
    '`noise_scale`, `noise_depth`), WAVES, CHECKER or NONE (uniform push). Topology is unchanged.',
  schema,
  apply(mesh, p, ctx) {
    const n = vertexCount(mesh);
    if (n === 0 || p.strength === 0) return mesh;
    const P = mesh.positions;
    const M = ctx.objectMatrix;
    const normals = p.direction === 'NORMAL' ? computeVertexNormals(mesh) : null;
    const uvs = p.texture_coords === 'UV' ? vertexUVs(mesh) : null;
    // axis directions expressed in local space
    const axes: number[][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    if (p.space === 'GLOBAL') {
      const inv = invert4(M);
      for (const a of axes) {
        const [x, y, z] = a;
        a[0] = inv[0] * x + inv[4] * y + inv[8] * z;
        a[1] = inv[1] * x + inv[5] * y + inv[9] * z;
        a[2] = inv[2] * x + inv[6] * y + inv[10] * z;
      }
    }
    const out = P.slice();
    for (let i = 0; i < n; i++) {
      let x = P[i * 3];
      let y = P[i * 3 + 1];
      let z = P[i * 3 + 2];
      if (uvs) {
        x = uvs[i * 2];
        y = uvs[i * 2 + 1];
        z = 0;
      } else if (p.texture_coords === 'GLOBAL') {
        const gx = M[0] * x + M[4] * y + M[8] * z + M[12];
        const gy = M[1] * x + M[5] * y + M[9] * z + M[13];
        const gz = M[2] * x + M[6] * y + M[10] * z + M[14];
        x = gx;
        y = gy;
        z = gz;
      }
      if (p.direction === 'RGB_TO_XYZ') {
        for (let c = 0; c < 3; c++) {
          const d = (sample(p, x, y, z, c) - p.mid_level) * p.strength;
          for (let k = 0; k < 3; k++) out[i * 3 + k] += axes[c][k] * d;
        }
        continue;
      }
      const d = (sample(p, x, y, z, 0) - p.mid_level) * p.strength;
      if (normals) {
        for (let k = 0; k < 3; k++) out[i * 3 + k] += normals[i * 3 + k] * d;
      } else {
        const a = axes[p.direction === 'X' ? 0 : p.direction === 'Y' ? 1 : 2];
        for (let k = 0; k < 3; k++) out[i * 3 + k] += a[k] * d;
      }
    }
    return withPositions(mesh, out);
  },
};
