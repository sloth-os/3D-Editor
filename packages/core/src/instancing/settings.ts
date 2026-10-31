import { z } from 'zod';

/*
 * Particle system settings (stored in `ObjectData.particle_systems[].settings`). Names follow
 * Blender's ParticleSettings / ParticleSystem RNA where an equivalent exists. The systems are static
 * scatters (like Blender hair particles rendered as objects): particles are distributed over the
 * emitter mesh and every particle instances an object or a collection.
 */

/** Hard limit of particles per system and of instances per evaluation. */
export const MAX_INSTANCES = 200_000;

export const EMIT_FROM = ['VERT', 'FACE', 'VOLUME'] as const;
export const DISTRIBUTIONS = ['RANDOM', 'JITTERED', 'GRID'] as const;
export const PARTICLE_INSTANCE_TYPES = ['NONE', 'OBJECT', 'COLLECTION'] as const;
export const ROTATION_MODES = ['NONE', 'NORMAL', 'NORMAL_TANGENT', 'GLOBAL_Z'] as const;

export type EmitFrom = (typeof EMIT_FROM)[number];
export type Distribution = (typeof DISTRIBUTIONS)[number];
export type ParticleInstanceType = (typeof PARTICLE_INSTANCE_TYPES)[number];
export type RotationMode = (typeof ROTATION_MODES)[number];

/** Relative pick weight of one object of the instanced collection (Blender `instance_weights`). */
export interface InstanceWeight {
  /** Object id (operators also accept names and store ids). */
  object: string;
  /** Relative weight ≥ 0 (0 never picks the object). */
  weight: number;
}

/** Fully defaulted particle settings (see {@link ParticleSettingsSchema} for the documentation). */
export interface ParticleSettings {
  count: number;
  seed: number;
  emit_from: EmitFrom;
  distribution: Distribution;
  use_even_distribution: boolean;
  grid_resolution: number;
  grid_random: number;
  vertex_group_density: string;
  invert_vertex_group_density: boolean;
  instance_type: ParticleInstanceType;
  instance_object: string | null;
  instance_collection: string | null;
  use_whole_collection: boolean;
  use_collection_pick_random: boolean;
  instance_weights: InstanceWeight[];
  particle_size: number;
  size_random: number;
  rotation_mode: RotationMode;
  rotation_factor_random: number;
  phase_factor: number;
  phase_factor_random: number;
  use_rotation_instance: boolean;
  use_scale_instance: boolean;
  min_distance: number;
  use_modifier_stack: boolean;
  display_percentage: number;
}

const weightSchema = z.object({
  object: z.string().min(1).describe('Object id or name (a member of instance_collection)'),
  weight: z.number().min(0).max(1e6).describe('Relative pick weight (0 = never)'),
});

/** Field types without defaults (shared by the full and the patch schema). */
const FIELDS = {
  count: z
    .number()
    .int()
    .min(0)
    .max(MAX_INSTANCES)
    .describe(
      `Number of particles (0..${MAX_INSTANCES}). Ignored by GRID distribution, which places one particle per grid cell.`,
    ),
  seed: z
    .number()
    .int()
    .describe('Random seed; the same seed and settings always give the same scatter. Default 0.'),
  emit_from: z
    .enum(EMIT_FROM)
    .describe(
      'Where particles are emitted: FACE (surface, default), VERT (vertices) or VOLUME (inside a closed mesh).',
    ),
  distribution: z
    .enum(DISTRIBUTIONS)
    .describe(
      'JITTERED (default): even low-discrepancy coverage; RANDOM: independent uniform random points; GRID: regular ' +
        'grid of grid_resolution cells along the longest bounding box side (count is ignored). Particle i keeps its ' +
        'place when count changes (RANDOM and JITTERED).',
    ),
  use_even_distribution: z
    .boolean()
    .describe(
      'FACE emission: true (default) = density proportional to face area (uniform over the surface); false = every face ' +
        'receives the same share regardless of its size.',
    ),
  grid_resolution: z
    .number()
    .int()
    .min(1)
    .max(250)
    .describe('GRID: cells along the longest side (1..250, default 10).'),
  grid_random: z
    .number()
    .min(0)
    .max(1)
    .describe('GRID: random offset of the grid points, 0..1 of a cell (default 0).'),
  vertex_group_density: z
    .string()
    .describe(
      "Name of an emitter vertex group whose weights (0..1) scale the particle density (FACE/VERT emission; '' = none).",
    ),
  invert_vertex_group_density: z.boolean().describe('Use 1 - weight of vertex_group_density.'),
  instance_type: z
    .enum(PARTICLE_INSTANCE_TYPES)
    .describe(
      'What each particle instances: OBJECT (instance_object, default), COLLECTION (instance_collection) or NONE.',
    ),
  instance_object: z
    .string()
    .nullable()
    .describe('Object instanced at every particle (instance_type OBJECT); id or name, stored as id.'),
  instance_collection: z
    .string()
    .nullable()
    .describe(
      'Collection whose objects (including child collections) are instanced (instance_type COLLECTION); id or name.',
    ),
  use_whole_collection: z
    .boolean()
    .describe(
      'COLLECTION: instance the whole collection at every particle, objects keeping their relative placement around ' +
        'the collection instance_offset (default false: one object per particle).',
    ),
  use_collection_pick_random: z
    .boolean()
    .describe(
      'COLLECTION: pick the object of every particle at random (weighted by instance_weights); false (default) cycles ' +
        'through the objects in name order.',
    ),
  instance_weights: z
    .array(weightSchema)
    .describe(
      'COLLECTION: relative frequency per object, e.g. [{"object":"Rock","weight":3}]; objects not listed weigh 1.',
    ),
  particle_size: z
    .number()
    .min(0)
    .max(1e5)
    .describe(
      "Uniform scale of every instance (default 1 = the instanced object's own size; Blender's default 0.05 is meant " +
        'for halo particles). Instances also take the emitter scale along the surface normal: a uniformly scaled ' +
        'emitter scales them like the rest of the object, a ground plane stretched in X/Y does not stretch them.',
    ),
  size_random: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'Random size reduction 0..1: each particle is scaled by particle_size * (1 - size_random * rnd).',
    ),
  rotation_mode: z
    .enum(ROTATION_MODES)
    .describe(
      "Orientation of the instances' local +Z axis: NORMAL (default) = surface normal, NORMAL_TANGENT = normal with " +
        "+X along the surface tangent (UV U direction, else the emitter's X axis), GLOBAL_Z = world up, NONE = the " +
        "emitter object's orientation.",
    ),
  rotation_factor_random: z
    .number()
    .min(0)
    .max(1)
    .describe('Blend 0..1 from the aligned orientation towards a fully random orientation.'),
  phase_factor: z
    .number()
    .min(-1)
    .max(1)
    .describe('Rotation around the aligned +Z axis, -1..1 (times 180 degrees).'),
  phase_factor_random: z
    .number()
    .min(0)
    .max(2)
    .describe(
      'Random extra rotation around the aligned +Z axis, 0..2 (2 = any heading, the usual choice for scatters).',
    ),
  use_rotation_instance: z
    .boolean()
    .describe(
      "Keep the instanced object's own world rotation on top of the particle rotation (default false).",
    ),
  use_scale_instance: z.boolean().describe("Keep the instanced object's own world scale (default true)."),
  min_distance: z
    .number()
    .min(0)
    .max(1e5)
    .describe(
      'Minimum distance between particles in world units (Poisson-disk style rejection for natural scatters); fewer ' +
        'particles are placed when the surface is full. 0 = off.',
    ),
  use_modifier_stack: z
    .boolean()
    .describe(
      'true (default): emit from the evaluated mesh (after shape keys and modifiers); false: distribute on the original ' +
        'mesh, following deforming modifiers that keep its topology.',
    ),
  display_percentage: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      'Percentage (0..100) of the particles shown in the viewport; renders and exports use all of them.',
    ),
} as const;

/** Defaults (Blender's defaults except particle_size and use_modifier_stack, see the field docs). */
export const PARTICLE_DEFAULTS: Readonly<ParticleSettings> = Object.freeze({
  count: 1000,
  seed: 0,
  emit_from: 'FACE',
  distribution: 'JITTERED',
  use_even_distribution: true,
  grid_resolution: 10,
  grid_random: 0,
  vertex_group_density: '',
  invert_vertex_group_density: false,
  instance_type: 'OBJECT',
  instance_object: null,
  instance_collection: null,
  use_whole_collection: false,
  use_collection_pick_random: false,
  instance_weights: [],
  particle_size: 1,
  size_random: 0,
  rotation_mode: 'NORMAL',
  rotation_factor_random: 0,
  phase_factor: 0,
  phase_factor_random: 0,
  use_rotation_instance: false,
  use_scale_instance: true,
  min_distance: 0,
  use_modifier_stack: true,
  display_percentage: 100,
});

type FieldName = keyof typeof FIELDS;

export const PARTICLE_SETTING_NAMES = Object.keys(FIELDS) as FieldName[];

function withDefaults() {
  const shape: Record<string, z.ZodType> = {};
  for (const k of PARTICLE_SETTING_NAMES) {
    const f = FIELDS[k] as z.ZodType;
    const d = PARTICLE_DEFAULTS[k];
    shape[k] = (f as any).default(() => (Array.isArray(d) ? d.slice() : d)).describe(f.description ?? '');
  }
  return shape as { [K in FieldName]: z.ZodDefault<(typeof FIELDS)[K]> };
}

/**
 * Validated, fully defaulted particle settings: `ParticleSettingsSchema.parse({})` yields
 * {@link PARTICLE_DEFAULTS}. Object and collection references are ids once stored.
 */
export const ParticleSettingsSchema = z.object(withDefaults());

/** Partial settings (no defaults) for operator input: only the given fields change. Unknown keys fail. */
export const ParticleSettingsPatchSchema = z
  .object(
    Object.fromEntries(
      PARTICLE_SETTING_NAMES.map((k) => [
        k,
        (FIELDS[k] as z.ZodType).optional().describe(FIELDS[k].description ?? ''),
      ]),
    ) as { [K in FieldName]: z.ZodOptional<(typeof FIELDS)[K]> },
  )
  .strict();

export type ParticleSettingsPatch = z.infer<typeof ParticleSettingsPatchSchema>;

/** Blender identifiers accepted for enum settings (stored data written by scripts or older tools). */
const ENUM_ALIASES: Record<string, Record<string, string>> = {
  distribution: { RAND: 'RANDOM', JIT: 'JITTERED' },
  rotation_mode: { NOR: 'NORMAL', NOR_TAN: 'NORMAL_TANGENT', GLOB_Z: 'GLOBAL_Z' },
  instance_type: { GROUP: 'COLLECTION' },
};

interface NumericRange {
  min: number;
  max: number;
  int: boolean;
}

const RANGES: Partial<Record<FieldName, NumericRange>> = {
  count: { min: 0, max: MAX_INSTANCES, int: true },
  seed: { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, int: true },
  grid_resolution: { min: 1, max: 250, int: true },
  grid_random: { min: 0, max: 1, int: false },
  particle_size: { min: 0, max: 1e5, int: false },
  size_random: { min: 0, max: 1, int: false },
  rotation_factor_random: { min: 0, max: 1, int: false },
  phase_factor: { min: -1, max: 1, int: false },
  phase_factor_random: { min: 0, max: 2, int: false },
  min_distance: { min: 0, max: 1e5, int: false },
  display_percentage: { min: 0, max: 100, int: true },
};

/**
 * Lenient normalization of stored (possibly animated, partially invalid or outdated) settings for
 * evaluation: missing fields take their defaults, Blender enum identifiers are mapped, animated
 * numbers are rounded/clamped into range, and invalid values fall back to the default with a message.
 * Never throws.
 */
export function normalizeParticleSettings(raw: unknown): { settings: ParticleSettings; errors: string[] } {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  for (const k of PARTICLE_SETTING_NAMES) {
    let v = src[k];
    const d = PARTICLE_DEFAULTS[k];
    if (v === undefined) {
      out[k] = Array.isArray(d) ? d.slice() : d;
      continue;
    }
    const aliases = ENUM_ALIASES[k];
    if (aliases && typeof v === 'string') v = aliases[v.toUpperCase()] ?? v.toUpperCase();
    const range = RANGES[k];
    if (range && typeof v === 'number' && Number.isFinite(v)) {
      const r = range.int ? Math.round(v) : v;
      v = Math.min(range.max, Math.max(range.min, r));
    } else if (typeof d === 'boolean' && typeof v === 'number') v = v >= 0.5;
    const res = (FIELDS[k] as z.ZodType).safeParse(v);
    if (res.success) out[k] = res.data;
    else {
      out[k] = Array.isArray(d) ? d.slice() : d;
      errors.push(`invalid ${k} ${JSON.stringify(src[k])}, using ${JSON.stringify(d)}`);
    }
  }
  return { settings: out as unknown as ParticleSettings, errors };
}

/** Default name of new particle systems (Blender: "ParticleSystem", "ParticleSystem.001", ...). */
export const DEFAULT_PARTICLE_SYSTEM_NAME = 'ParticleSystem';
