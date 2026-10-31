import type { AnimTargetType } from '../doc/types';

/** Animatable property paths per target type, with their vector length (1 for scalars). */
export const ANIMATABLE: Record<AnimTargetType, Record<string, number>> = {
  object: { location: 3, rotation_euler: 3, scale: 3, color: 4 },
  material: {
    base_color: 4,
    metallic: 1,
    roughness: 1,
    ior: 1,
    transmission: 1,
    emission_color: 3,
    emission_strength: 1,
    alpha: 1,
    coat_weight: 1,
    sheen_weight: 1,
  },
  light: { color: 3, energy: 1, spot_size: 1, spot_blend: 1, shadow_soft_size: 1, size: 1, size_y: 1 },
  camera: { lens: 1, ortho_scale: 1, shift_x: 1, shift_y: 1, dof_focus_distance: 1, dof_aperture_fstop: 1, clip_start: 1, clip_end: 1 },
  world: { color: 3, strength: 1, environment_rotation: 1, environment_strength: 1 },
  scene: {},
};

export function isAnimatable(type: AnimTargetType, path: string): boolean {
  return path in (ANIMATABLE[type] ?? {});
}

export function propertyLength(type: AnimTargetType, path: string): number {
  return ANIMATABLE[type]?.[path] ?? 0;
}

/** Reads `obj[path][index]` (or `obj[path]` for scalars). */
export function readChannel(obj: Record<string, unknown>, path: string, index: number): number | undefined {
  const v = obj[path];
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && typeof v[index] === 'number') return v[index] as number;
  return undefined;
}

/** Writes a channel into a (cloned) plain object. */
export function writeChannel(obj: Record<string, unknown>, path: string, index: number, value: number): void {
  const v = obj[path];
  if (Array.isArray(v)) {
    const copy = v.slice();
    copy[index] = value;
    obj[path] = copy;
  } else obj[path] = value;
}
