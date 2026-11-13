import { createMesh, type MeshData } from '../src/mesh/types';
import { defaultArmature, defaultBone } from '../src/doc/defaults';
import type { ArmatureData, BoneData } from '../src/doc/types';
import type { Vec3 } from '../src/math/types';

/**
 * Closed tube along +Z from z = z0 to z0 + height with `rings` vertex rings of `segments`
 * vertices (quads), capped with n-gons. Vertex i of ring r has index r * segments + i.
 */
export function tube(
  rings: number,
  segments: number,
  radius: number,
  height: number,
  opts: { z0?: number; center?: [number, number]; caps?: boolean } = {},
): MeshData {
  const z0 = opts.z0 ?? 0;
  const [cx, cy] = opts.center ?? [0, 0];
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    const z = z0 + (height * r) / (rings - 1);
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a), z);
    }
  }
  const faces: number[][] = [];
  for (let r = 0; r + 1 < rings; r++)
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      faces.push([r * segments + i, r * segments + j, (r + 1) * segments + j, (r + 1) * segments + i]);
    }
  if (opts.caps !== false) {
    faces.push(Array.from({ length: segments }, (_, i) => segments - 1 - i));
    faces.push(Array.from({ length: segments }, (_, i) => (rings - 1) * segments + i));
  }
  return createMesh({ positions, faces });
}

export function bone(name: string, head: Vec3, tail: Vec3, extra: Partial<BoneData> = {}): BoneData {
  return { ...defaultBone(name, head, tail), ...extra };
}

export function armatureData(bones: BoneData[], extra: Partial<ArmatureData> = {}): ArmatureData {
  return { ...defaultArmature('arm', 'Armature'), bones, ...extra };
}

/** Centroid of a ring of the tube (flat positions). */
export function ringCenter(positions: ArrayLike<number>, ring: number, segments: number): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < segments; i++)
    for (let k = 0; k < 3; k++) c[k] += positions[(ring * segments + i) * 3 + k] / segments;
  return c;
}

/** Mean distance of a ring's vertices from its centroid. */
export function ringRadius(positions: ArrayLike<number>, ring: number, segments: number): number {
  const c = ringCenter(positions, ring, segments);
  let s = 0;
  for (let i = 0; i < segments; i++) {
    const o = (ring * segments + i) * 3;
    s += Math.hypot(positions[o] - c[0], positions[o + 1] - c[1], positions[o + 2] - c[2]);
  }
  return s / segments;
}

export const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
