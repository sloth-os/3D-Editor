import type { MeshData } from '../mesh/types';

const meshKeys = new WeakMap<MeshData, string>();

/**
 * Content hash of a mesh's vertex positions and faces, memoised per mesh instance (meshes read
 * from a document are immutable: an edit replaces the instance). Two meshes with the same key
 * build the same collision shapes.
 */
export function meshKey(mesh: MeshData): string {
  let key = meshKeys.get(mesh);
  if (key !== undefined) return key;
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  const mix = (x: number) => {
    h1 = Math.imul(h1 ^ x, 0x01000193);
    h2 = Math.imul(h2 ^ x, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  };
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const pos = Array.isArray(mesh.positions) ? mesh.positions : [];
  mix(pos.length);
  for (const v of pos) {
    f64[0] = v;
    mix(u32[0]);
    mix(u32[1]);
  }
  const faces = Array.isArray(mesh.faces) ? mesh.faces : [];
  mix(faces.length);
  for (const f of faces) {
    if (!Array.isArray(f)) {
      mix(-1);
      continue;
    }
    mix(f.length);
    for (const i of f) mix(typeof i === 'number' ? i | 0 : -1);
  }
  key = `${pos.length}:${faces.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  meshKeys.set(mesh, key);
  return key;
}
