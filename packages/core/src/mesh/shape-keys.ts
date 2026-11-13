import type { ShapeKeyData, VertexGroupData } from '../doc/types';
import type { MeshData } from './types';

/** Float32 little-endian bytes of a numeric array (shape key positions, vertex weights). */
export function encodeFloat32(values: ArrayLike<number>): Uint8Array {
  const f = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) f[i] = values[i];
  return new Uint8Array(f.buffer);
}

export function decodeFloat32(bytes: Uint8Array): Float32Array {
  const n = bytes.byteLength >> 2;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * Blends shape keys onto a mesh (relative keys, like Blender): each unmuted key adds
 * `value × (key − reference)` where the reference is its `relative_key` (or the basis mesh).
 * Keys whose vertex count does not match the mesh are skipped and reported.
 */
export function applyShapeKeys(
  base: MeshData,
  keys: readonly ShapeKeyData[],
): { mesh: MeshData; errors: string[] } {
  const errors: string[] = [];
  const n = base.positions.length;
  const decoded = new Map<string, Float32Array>();
  for (const k of keys) {
    const d = decodeFloat32(k.data);
    if (d.length !== n) errors.push(`shape key "${k.name}" has ${d.length / 3} vertices, mesh has ${n / 3}`);
    else decoded.set(k.name, d);
  }
  const active = keys.filter((k) => !k.mute && k.value !== 0 && decoded.has(k.name));
  if (active.length === 0) return { mesh: base, errors };
  const pos = base.positions.slice();
  for (const k of active) {
    const v = Math.min(k.slider_max, Math.max(k.slider_min, k.value));
    const d = decoded.get(k.name)!;
    const ref = k.relative_key && k.relative_key !== k.name ? decoded.get(k.relative_key) : undefined;
    for (let i = 0; i < n; i++) pos[i] += v * (d[i] - (ref ? ref[i] : base.positions[i]));
  }
  return { mesh: { ...base, positions: pos }, errors };
}

/** Dense per-vertex weights of a vertex group (zeros when the vertex count mismatches). */
export function vertexGroupWeights(group: VertexGroupData, vertexCount: number): Float32Array {
  const w = decodeFloat32(group.weights);
  return w.length === vertexCount ? w : new Float32Array(vertexCount);
}
