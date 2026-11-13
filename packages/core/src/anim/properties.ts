import type { AnimTargetType } from '../doc/types';
import { getPathValue, parseDataPath, setPathValue } from './path';

/** Animatable top-level properties per target type, with their vector length (1 for scalars). */
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
  camera: {
    lens: 1,
    ortho_scale: 1,
    shift_x: 1,
    shift_y: 1,
    dof_focus_distance: 1,
    dof_aperture_fstop: 1,
    clip_start: 1,
    clip_end: 1,
  },
  world: {
    color: 3,
    strength: 1,
    environment_rotation: 1,
    environment_strength: 1,
    sun_elevation: 1,
    sun_rotation: 1,
    sun_intensity: 1,
    sky_zenith_color: 3,
    sky_horizon_color: 3,
    mist_density: 1,
  },
  scene: {},
  mesh: {},
  curve: {
    bevel_depth: 1,
    bevel_factor_start: 1,
    bevel_factor_end: 1,
    extrude: 1,
    offset: 1,
    eval_time: 1,
    size: 1,
    space_character: 1,
    shear: 1,
    space_line: 1,
    space_word: 1,
    offset_x: 1,
    offset_y: 1,
  },
};

/** Nested animatable paths (Blender data path syntax). */
const PATTERNS: Partial<Record<AnimTargetType, RegExp[]>> = {
  object: [
    /^pose\.bones\[(["']).+\1\]\.(location|rotation_euler|scale)$/,
    /^pose\.bones\[(["']).+\1\]\.constraints\[(["']).+\2\]\.influence$/,
    /^constraints\[(["']).+\1\]\.(influence|\w+)$/,
    /^modifiers\[(["']).+\1\]\.\w+$/,
    /^particle_systems\[(["']).+\1\]\.\w+$/,
  ],
  mesh: [/^shape_keys\[(["']).+\1\]\.value$/],
  curve: [/^splines\[\d+\]\.points\[\d+\]\.(co|handle_left|handle_right|radius|tilt|weight)$/],
  material: [/^textures\.\w+\.procedural\.\w+$/],
};

export function isAnimatable(type: AnimTargetType, path: string): boolean {
  if (path in (ANIMATABLE[type] ?? {})) return true;
  return (PATTERNS[type] ?? []).some((re) => re.test(path));
}

/**
 * Number of channels of an animatable property. For nested paths the length is taken from the
 * current value (`sample`), e.g. 3 for `pose.bones["Arm"].rotation_euler`.
 */
export function propertyLength(
  type: AnimTargetType,
  path: string,
  sample?: Record<string, unknown> | null,
): number {
  const fixed = ANIMATABLE[type]?.[path];
  if (fixed) return fixed;
  if (!isAnimatable(type, path)) return 0;
  const v = sample ? getPathValue(sample, path) : undefined;
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' || v === undefined ? 1 : 0;
}

/** Reads `obj[path][index]` (or `obj[path]` for scalars); supports nested data paths. */
export function readChannel(obj: Record<string, unknown>, path: string, index: number): number | undefined {
  let v: unknown;
  try {
    v = getPathValue(obj, path);
  } catch {
    return undefined;
  }
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) && typeof v[index] === 'number') return v[index] as number;
  return undefined;
}

/**
 * Writes a channel into `obj` (the top-level field is replaced by an updated copy; nested
 * containers are copied on write, never mutated). Unresolvable paths are ignored.
 */
export function writeChannel(obj: Record<string, unknown>, path: string, index: number, value: number): void {
  let cur: unknown;
  try {
    cur = getPathValue(obj, path);
    if (Array.isArray(cur)) {
      const copy = cur.slice();
      copy[index] = value;
      cur = copy;
    } else if (typeof cur === 'boolean') cur = value >= 0.5;
    else cur = value;
    const updated = setPathValue(obj, path, cur);
    const root = parseDataPath(path)[0];
    if (root.kind === 'prop') obj[root.name] = (updated as Record<string, unknown>)[root.name];
  } catch {
    /* path does not resolve on this datablock: ignore */
  }
}
