import type { ProceduralTexture, ProceduralType } from '../doc/types';

/*
 * Parameter specification of the procedural textures: the single source of truth for defaults,
 * validation (operators), packing into the compiled form shared with the viewport shader, and the
 * self-describing documentation exposed to AI agents.
 */

export const PROCEDURAL_TYPES: readonly ProceduralType[] = [
  'NOISE',
  'VORONOI',
  'CHECKER',
  'GRADIENT',
  'WAVE',
  'BRICK',
  'MARBLE',
  'WOOD',
  'MAGIC',
];

export const PROCEDURAL_MAPPINGS: readonly ProceduralTexture['mapping'][] = ['GENERATED', 'OBJECT', 'UV'];

/** One entry of `ProceduralTexture.params`. */
export interface ProceduralParamSpec {
  key: string;
  kind: 'number' | 'int' | 'enum';
  default: number | string;
  min?: number;
  max?: number;
  /** Allowed values of enum params (stored as strings, compiled to their index). */
  values?: readonly string[];
  description: string;
}

const RAMP_INTERPOLATIONS = ['LINEAR', 'EASE', 'CONSTANT'] as const;
const PROFILES = ['SIN', 'SAW', 'TRI'] as const;

/** Params accepted by every procedural type. */
export const PROCEDURAL_COMMON_PARAMS: readonly ProceduralParamSpec[] = [
  {
    key: 'offset_x',
    kind: 'number',
    default: 0,
    description: 'texture-space X translation added to the coordinate before scaling',
  },
  { key: 'offset_y', kind: 'number', default: 0, description: 'texture-space Y translation' },
  { key: 'offset_z', kind: 'number', default: 0, description: 'texture-space Z translation' },
  {
    key: 'ramp_interpolation',
    kind: 'enum',
    default: 'LINEAR',
    values: RAMP_INTERPOLATIONS,
    description:
      'colour ramp between the stops ramp_low (color_a) and ramp_high (color_b): LINEAR, EASE (smoothstep) or CONSTANT (hard step at ramp_high)',
  },
  {
    key: 'bump_distance',
    kind: 'number',
    default: 0.1,
    min: 0,
    max: 10,
    description:
      'normal channel only: bump displacement in metres for height 1 (red channel), multiplied by the material normal_strength',
  },
];

/** Type-specific params. */
export const PROCEDURAL_TYPE_PARAMS: Readonly<Record<ProceduralType, readonly ProceduralParamSpec[]>> = {
  NOISE: [
    {
      key: 'noise_type',
      kind: 'enum',
      default: 'FBM',
      values: ['FBM', 'RIDGED', 'TURBULENCE'],
      description: 'FBM (smooth clouds), RIDGED (sharp ridges/veins), TURBULENCE (billowy |noise| sum)',
    },
    {
      key: 'lacunarity',
      kind: 'number',
      default: 2,
      min: 1,
      max: 8,
      description: 'frequency multiplier between octaves',
    },
  ],
  VORONOI: [
    {
      key: 'feature',
      kind: 'enum',
      default: 'F1',
      values: ['F1', 'F2', 'DISTANCE_TO_EDGE', 'CELL'],
      description:
        'factor: F1 distance to the nearest cell point, F2 second nearest, DISTANCE_TO_EDGE distance to the cell border, CELL a random value per cell',
    },
    {
      key: 'distance',
      kind: 'enum',
      default: 'EUCLIDEAN',
      values: ['EUCLIDEAN', 'MANHATTAN', 'CHEBYSHEV'],
      description: 'distance metric for F1/F2',
    },
    {
      key: 'randomness',
      kind: 'number',
      default: 1,
      min: 0,
      max: 1,
      description: 'jitter of the cell points (0 = regular grid)',
    },
    {
      key: 'color_randomness',
      kind: 'number',
      default: 0,
      min: 0,
      max: 1,
      description: 'mixes a random colour per cell over the ramp colour (0 = off, 1 = fully random colours)',
    },
  ],
  CHECKER: [],
  GRADIENT: [
    {
      key: 'gradient_type',
      kind: 'enum',
      default: 'LINEAR',
      values: ['LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL'],
      description:
        'LINEAR x, QUADRATIC x², EASING smoothstep(x), DIAGONAL (x+y)/2, SPHERICAL 1−|p|, QUADRATIC_SPHERE (1−|p|)², RADIAL angle around Z',
    },
  ],
  WAVE: [
    {
      key: 'wave_type',
      kind: 'enum',
      default: 'BANDS',
      values: ['BANDS', 'RINGS'],
      description: 'straight bands or concentric rings',
    },
    {
      key: 'direction',
      kind: 'enum',
      default: 'X',
      values: ['X', 'Y', 'Z', 'DIAGONAL', 'SPHERICAL'],
      description:
        'BANDS: X/Y/Z/DIAGONAL axis of variation; RINGS: X/Y/Z axis the rings go around or SPHERICAL (DIAGONAL rings and SPHERICAL bands fall back to SPHERICAL/DIAGONAL)',
    },
    { key: 'wave_profile', kind: 'enum', default: 'SIN', values: PROFILES, description: 'wave shape' },
    {
      key: 'phase',
      kind: 'number',
      default: 0,
      description: 'phase offset in radians (2π = one period)',
    },
    {
      key: 'detail_scale',
      kind: 'number',
      default: 1,
      min: 0,
      max: 1000,
      description: 'scale of the distortion noise',
    },
  ],
  BRICK: [
    {
      key: 'plane',
      kind: 'enum',
      default: 'XY',
      values: ['XY', 'WALL'],
      description:
        'XY: bricks along X, rows along Y (Blender, floors); WALL: rows along Z, bricks along X+Y (vertical walls facing ±X or ±Y)',
    },
    {
      key: 'mortar_size',
      kind: 'number',
      default: 0.02,
      min: 0,
      max: 0.5,
      description: 'mortar width in scaled texture units',
    },
    {
      key: 'mortar_smooth',
      kind: 'number',
      default: 0.1,
      min: 0,
      max: 1,
      description: 'softness of the brick/mortar transition',
    },
    {
      key: 'brick_width',
      kind: 'number',
      default: 0.5,
      min: 0.001,
      max: 1000,
      description: 'brick length (scaled texture units, along X)',
    },
    {
      key: 'row_height',
      kind: 'number',
      default: 0.25,
      min: 0.001,
      max: 1000,
      description: 'row height (scaled texture units, along Y)',
    },
    {
      key: 'offset',
      kind: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      description: 'row offset as a fraction of the brick width',
    },
    {
      key: 'offset_frequency',
      kind: 'int',
      default: 2,
      min: 1,
      max: 99,
      description: 'every n-th row is offset',
    },
    {
      key: 'squash',
      kind: 'number',
      default: 1,
      min: 0.001,
      max: 99,
      description: 'brick width factor of squashed rows',
    },
    {
      key: 'squash_frequency',
      kind: 'int',
      default: 2,
      min: 1,
      max: 99,
      description: 'every n-th row is squashed',
    },
    {
      key: 'bias',
      kind: 'number',
      default: 0,
      min: -1,
      max: 1,
      description: 'shifts the random per-brick ramp factor (−1 → color_a only, 1 → color_b only)',
    },
    {
      key: 'mortar_r',
      kind: 'number',
      default: 0.5,
      min: 0,
      max: 1000,
      description: 'mortar colour red (linear)',
    },
    { key: 'mortar_g', kind: 'number', default: 0.5, min: 0, max: 1000, description: 'mortar colour green' },
    { key: 'mortar_b', kind: 'number', default: 0.5, min: 0, max: 1000, description: 'mortar colour blue' },
  ],
  MARBLE: [
    {
      key: 'marble_type',
      kind: 'enum',
      default: 'SOFT',
      values: ['SOFT', 'SHARP', 'SHARPER'],
      description: 'vein sharpness (factor 0 = vein → color_a)',
    },
    { key: 'wave_profile', kind: 'enum', default: 'SIN', values: PROFILES, description: 'band shape' },
  ],
  WOOD: [
    {
      key: 'wood_type',
      kind: 'enum',
      default: 'RINGS',
      values: ['RINGS', 'BANDS'],
      description: 'RINGS: growth rings around the texture Z axis; BANDS: straight bands along the diagonal',
    },
    { key: 'wave_profile', kind: 'enum', default: 'SAW', values: PROFILES, description: 'ring shape' },
    {
      key: 'grain',
      kind: 'number',
      default: 0.3,
      min: 0,
      max: 1,
      description: 'strength of fine fibre streaks along Z',
    },
  ],
  MAGIC: [],
};

/** Human/agent oriented summary of every type (factor semantics, use of the shared fields). */
export const PROCEDURAL_TYPE_DOCS: Readonly<Record<ProceduralType, string>> = {
  NOISE:
    'fractal gradient noise (clouds); detail = octaves 0..15, roughness = amplitude falloff, distortion = domain warp',
  VORONOI:
    'cellular noise (stones, cells, scales); factor per `feature`; distortion warps the domain; detail/roughness unused',
  CHECKER: 'alternating 3D checker cells, factor 0/1 (one cell per scaled unit)',
  GRADIENT: 'gradient of the scaled coordinate per `gradient_type` (use OBJECT mapping for centred spheres)',
  WAVE: 'sine/saw/triangle bands or rings (20 rad per scaled unit like Blender); distortion = noise amount',
  BRICK:
    'brick wall: random ramp factor per brick, mortar in mortar_r/g/b; rows along Y, bricks along X (plane=WALL: rows along Z)',
  MARBLE:
    'turbulent vein bands along the XYZ diagonal (scale = bands per unit); distortion = turbulence (≈2), detail/roughness = turbulence noise',
  WOOD: 'wood growth rings (scale = rings per unit), distortion = ring wobble, `grain` fibre streaks',
  MAGIC:
    'psychedelic interference pattern; detail = depth 0..10, distortion = folding; each RGB channel is ramped separately',
};

/** Per-type defaults of the shared fields (Blender's defaults where Blender has the texture). */
export const PROCEDURAL_TYPE_DEFAULTS: Readonly<
  Record<ProceduralType, Partial<Omit<ProceduralTexture, 'type' | 'params'>>>
> = {
  NOISE: { scale: 5, detail: 2, roughness: 0.5, distortion: 0 },
  VORONOI: { scale: 5, detail: 0, roughness: 0.5, distortion: 0 },
  CHECKER: { scale: 5, color_a: [0.8, 0.8, 0.8, 1], color_b: [0.2, 0.2, 0.2, 1] },
  GRADIENT: { scale: 1 },
  WAVE: { scale: 5, detail: 2, roughness: 0.5, distortion: 0 },
  BRICK: {
    scale: 5,
    detail: 0,
    color_a: [0.32, 0.08, 0.04, 1],
    color_b: [0.5, 0.17, 0.08, 1],
  },
  MARBLE: {
    scale: 2,
    detail: 4,
    roughness: 0.5,
    distortion: 2,
    color_a: [0.25, 0.25, 0.27, 1],
    color_b: [0.9, 0.9, 0.88, 1],
  },
  WOOD: {
    scale: 8,
    detail: 2,
    roughness: 0.5,
    distortion: 0.6,
    color_a: [0.17, 0.07, 0.025, 1],
    color_b: [0.42, 0.2, 0.08, 1],
  },
  MAGIC: { scale: 5, detail: 2, distortion: 1 },
};

/** Spec of a param for a type (common or type-specific), or undefined. */
export function proceduralParamSpec(type: ProceduralType, key: string): ProceduralParamSpec | undefined {
  return (
    PROCEDURAL_TYPE_PARAMS[type]?.find((p) => p.key === key) ??
    PROCEDURAL_COMMON_PARAMS.find((p) => p.key === key)
  );
}

/**
 * Checks a params record against the spec of `type`. Returns human-readable problems (unknown keys,
 * wrong value kinds, out-of-range numbers, unknown enum values); empty when valid.
 */
export function validateProceduralParams(type: ProceduralType, params: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!PROCEDURAL_TYPE_PARAMS[type]) return [`unknown procedural type '${String(type)}'`];
  for (const [key, value] of Object.entries(params)) {
    const spec = proceduralParamSpec(type, key);
    if (!spec) {
      const valid = [...PROCEDURAL_TYPE_PARAMS[type], ...PROCEDURAL_COMMON_PARAMS].map((p) => p.key);
      problems.push(`unknown param '${key}' for ${type} (valid: ${valid.join(', ')})`);
      continue;
    }
    if (spec.kind === 'enum') {
      if (typeof value !== 'string' || !spec.values!.includes(value))
        problems.push(`param '${key}' must be one of ${spec.values!.join('|')}`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`param '${key}' must be a finite number`);
      continue;
    }
    if (spec.kind === 'int' && !Number.isInteger(value)) problems.push(`param '${key}' must be an integer`);
    if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))
      problems.push(`param '${key}' must be in [${spec.min ?? '-∞'}, ${spec.max ?? '∞'}]`);
  }
  return problems;
}

/** Compact one-line description of the params of a type (for operator descriptions). */
export function describeProceduralParams(type: ProceduralType): string {
  const parts = PROCEDURAL_TYPE_PARAMS[type].map((p) =>
    p.kind === 'enum' ? `${p.key}=${p.values!.join('|')} (${p.default})` : `${p.key}=${p.default}`,
  );
  return parts.length ? parts.join(', ') : 'none';
}
