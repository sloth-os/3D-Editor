import type { MeshData } from '../mesh/types';

/*
 * Geometric measurements of meshes (used by scene.measure and the generator tests).
 */

/**
 * Signed volume enclosed by a mesh (divergence theorem over fan-triangulated faces). Positive when
 * a closed mesh has outward facing normals; meaningless for open meshes.
 */
export function signedVolume(m: MeshData): number {
  const p = m.positions;
  let v = 0;
  for (const f of m.faces) {
    const a = f[0] * 3;
    for (let i = 1; i + 1 < f.length; i++) {
      const b = f[i] * 3;
      const c = f[i + 1] * 3;
      v +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
  }
  return v / 6;
}

/** Total surface area (sum of the polygon areas, Newell's method). */
export function surfaceArea(m: MeshData): number {
  const p = m.positions;
  let total = 0;
  for (const f of m.faces) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < f.length; i++) {
      const a = f[i] * 3;
      const b = f[(i + 1) % f.length] * 3;
      nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
      ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
      nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
    }
    total += Math.hypot(nx, ny, nz) / 2;
  }
  return total;
}
