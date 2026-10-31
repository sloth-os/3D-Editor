import type { Vec3, Vec4 } from '../math/types';
import type { MaterialData, ProceduralTexture, ProceduralType, TextureSlot } from '../doc/types';
import { defaultMaterial } from '../doc/defaults';
import { cloneJson } from '../util/json';
import { defaultProcedural } from './procedural';

/*
 * Physically plausible material presets (original values). Colours are linear; metals use typical
 * measured normal-incidence reflectance (F0) as base colour. Procedural presets use OBJECT mapping
 * with scales in metres (scale = pattern repetitions per metre of object space), so patterns keep
 * a realistic size on objects of any shape. Object space is before the object's scale (as in
 * Blender): scaled objects need their scale applied for true metric pattern sizes.
 */

export type MaterialPresetCategory =
  | 'METAL'
  | 'PLASTIC'
  | 'GLASS'
  | 'LIQUID'
  | 'CERAMIC'
  | 'STONE'
  | 'WOOD'
  | 'FABRIC'
  | 'PAINT'
  | 'EMISSIVE'
  | 'ORGANIC'
  | 'GROUND'
  | 'PATTERN';

export interface MaterialPreset {
  /** Stable snake_case identifier (operator parameter value). */
  id: string;
  /** Display name, used as the material name. */
  name: string;
  category: MaterialPresetCategory;
  description: string;
  /** Material values (on top of `defaultMaterial`), including procedural texture slots. */
  material: Partial<Omit<MaterialData, 'id' | 'name'>>;
}

function proc(
  type: ProceduralType,
  init: Partial<Omit<ProceduralTexture, 'type'>> & { mapping?: ProceduralTexture['mapping'] },
): TextureSlot {
  return {
    image: '',
    scale: [1, 1],
    offset: [0, 0],
    procedural: defaultProcedural(type, { mapping: 'OBJECT', ...init }),
  };
}

const rgba = (r: number, g: number, b: number, a = 1): Vec4 => [r, g, b, a];
const grey = (v: number): Vec4 => [v, v, v, 1];

function metal(id: string, name: string, f0: Vec3, roughness: number, description: string): MaterialPreset {
  return {
    id,
    name,
    category: 'METAL',
    description,
    material: { base_color: [...f0, 1] as Vec4, metallic: 1, roughness },
  };
}

// rusty iron: one noise drives every channel so rust patches line up
const rust = (a: Vec4, b: Vec4) =>
  proc('NOISE', {
    scale: 3,
    detail: 6,
    roughness: 0.62,
    distortion: 0.4,
    seed: 7,
    ramp_low: 0.44,
    ramp_high: 0.56,
    color_a: a,
    color_b: b,
  });

// brick layout in metres (215 × 65 mm bricks, 10 mm joints), courses stacked along Z
const brickLayout = {
  plane: 'WALL',
  brick_width: 0.225,
  row_height: 0.075,
  mortar_size: 0.005,
  mortar_smooth: 0.2,
};
// 30 cm square tiles, 3 mm joints
const tileLayout = { brick_width: 0.3, row_height: 0.3, offset: 0, mortar_size: 0.0015, mortar_smooth: 0.3 };
const leatherGrain = { feature: 'F1', randomness: 1 };

export const MATERIAL_PRESETS: readonly MaterialPreset[] = [
  // ---------------------------------------------------------------- metals
  metal('gold', 'Gold', [1.0, 0.766, 0.336], 0.18, 'Polished yellow gold.'),
  metal('silver', 'Silver', [0.972, 0.96, 0.915], 0.12, 'Polished silver.'),
  metal('copper', 'Copper', [0.955, 0.638, 0.538], 0.25, 'Clean copper with a soft sheen.'),
  metal('brass', 'Brass', [0.91, 0.778, 0.423], 0.3, 'Satin brass.'),
  metal('chrome', 'Chrome', [0.55, 0.556, 0.554], 0.04, 'Mirror-like chrome plating.'),
  {
    id: 'brushed_aluminium',
    name: 'Brushed Aluminium',
    category: 'METAL',
    description: 'Aluminium with fine brushing streaks along X (procedural roughness).',
    material: {
      base_color: [0.913, 0.922, 0.924, 1],
      metallic: 1,
      roughness: 0.35,
      textures: {
        roughness: proc('WAVE', {
          scale: 40,
          detail: 3,
          distortion: 6,
          color_a: grey(0.22),
          color_b: grey(0.42),
          params: { direction: 'Y', detail_scale: 0.6 },
        }),
      },
    },
  },
  {
    id: 'rusty_iron',
    name: 'Rusty Iron',
    category: 'METAL',
    description:
      'Raw iron with patches of rough, non-metallic rust (procedural colour, metallic, roughness, bump).',
    material: {
      base_color: [0.36, 0.36, 0.37, 1],
      metallic: 1,
      roughness: 0.45,
      textures: {
        base_color: rust(rgba(0.33, 0.33, 0.34), rgba(0.36, 0.13, 0.05)),
        metallic: rust(grey(1), grey(0)),
        roughness: rust(grey(0.4), grey(0.9)),
        normal: rust(grey(0), grey(1)),
      },
      normal_strength: 0.05,
    },
  },
  // ---------------------------------------------------------------- plastics
  {
    id: 'glossy_plastic',
    name: 'Glossy Plastic',
    category: 'PLASTIC',
    description: 'Smooth, shiny red plastic.',
    material: { base_color: [0.62, 0.05, 0.04, 1], roughness: 0.12 },
  },
  {
    id: 'matte_plastic',
    name: 'Matte Plastic',
    category: 'PLASTIC',
    description: 'Satin-matte blue plastic.',
    material: { base_color: [0.12, 0.26, 0.55, 1], roughness: 0.55 },
  },
  {
    id: 'rubber',
    name: 'Rubber',
    category: 'PLASTIC',
    description: 'Black rubber.',
    material: { base_color: [0.025, 0.025, 0.025, 1], roughness: 0.8 },
  },
  // ---------------------------------------------------------------- glass & liquids
  {
    id: 'clear_glass',
    name: 'Clear Glass',
    category: 'GLASS',
    description: 'Clear window glass (full transmission, IOR 1.5).',
    material: { base_color: [1, 1, 1, 1], roughness: 0, transmission: 1, ior: 1.5 },
  },
  {
    id: 'frosted_glass',
    name: 'Frosted Glass',
    category: 'GLASS',
    description: 'Sandblasted glass: transmissive with blurry refraction.',
    material: { base_color: [0.95, 0.97, 1, 1], roughness: 0.4, transmission: 1, ior: 1.5 },
  },
  {
    id: 'tinted_glass',
    name: 'Tinted Glass',
    category: 'GLASS',
    description: 'Green-tinted bottle glass.',
    material: { base_color: [0.25, 0.55, 0.4, 1], roughness: 0.02, transmission: 1, ior: 1.52 },
  },
  {
    id: 'water',
    name: 'Water',
    category: 'LIQUID',
    description: 'Water surface (IOR 1.333) with gentle procedural ripples.',
    material: {
      base_color: [0.85, 0.95, 1, 1],
      roughness: 0.03,
      transmission: 1,
      ior: 1.333,
      textures: {
        normal: proc('NOISE', {
          scale: 2,
          detail: 3,
          color_a: grey(0),
          color_b: grey(1),
          params: { bump_distance: 0.02 },
        }),
      },
    },
  },
  // ---------------------------------------------------------------- ceramics
  {
    id: 'ceramic',
    name: 'Glazed Ceramic',
    category: 'CERAMIC',
    description: 'Off-white ceramic under a glossy glaze (clear coat).',
    material: { base_color: [0.8, 0.78, 0.72, 1], roughness: 0.25, coat_weight: 1, coat_roughness: 0.03 },
  },
  {
    id: 'porcelain',
    name: 'Porcelain',
    category: 'CERAMIC',
    description: 'Bright white porcelain.',
    material: { base_color: [0.93, 0.93, 0.95, 1], roughness: 0.15, coat_weight: 0.6, coat_roughness: 0.05 },
  },
  {
    id: 'ceramic_tiles',
    name: 'Ceramic Tiles',
    category: 'CERAMIC',
    description:
      '30 cm glossy white floor tiles (XY plane) with rough grey grout (procedural colour, roughness, bump).',
    material: {
      base_color: [0.86, 0.86, 0.87, 1],
      roughness: 0.08,
      textures: {
        base_color: proc('BRICK', {
          scale: 1,
          color_a: rgba(0.82, 0.83, 0.83),
          color_b: rgba(0.9, 0.9, 0.91),
          params: { ...tileLayout, mortar_r: 0.32, mortar_g: 0.31, mortar_b: 0.3 },
        }),
        roughness: proc('BRICK', {
          scale: 1,
          color_a: grey(0.08),
          color_b: grey(0.12),
          params: { ...tileLayout, mortar_r: 0.85, mortar_g: 0.85, mortar_b: 0.85 },
        }),
        normal: proc('BRICK', {
          scale: 1,
          color_a: grey(1),
          color_b: grey(1),
          params: { ...tileLayout, mortar_r: 0, mortar_g: 0, mortar_b: 0, bump_distance: 0.002 },
        }),
      },
    },
  },
  // ---------------------------------------------------------------- stone
  {
    id: 'marble',
    name: 'Marble',
    category: 'STONE',
    description: 'Polished white marble with grey veins (procedural MARBLE).',
    material: {
      base_color: [0.88, 0.87, 0.84, 1],
      roughness: 0.12,
      coat_weight: 0.3,
      coat_roughness: 0.05,
      textures: {
        base_color: proc('MARBLE', {
          scale: 1.5,
          detail: 4,
          distortion: 2.5,
          color_a: rgba(0.3, 0.3, 0.32),
          color_b: rgba(0.88, 0.87, 0.84),
          params: { marble_type: 'SHARP' },
        }),
      },
    },
  },
  {
    id: 'concrete',
    name: 'Concrete',
    category: 'STONE',
    description: 'Weathered grey concrete with blotches and a fine pitted surface.',
    material: {
      base_color: [0.42, 0.41, 0.39, 1],
      roughness: 0.9,
      textures: {
        base_color: proc('NOISE', {
          scale: 4,
          detail: 8,
          roughness: 0.6,
          ramp_low: 0.3,
          ramp_high: 0.7,
          color_a: rgba(0.3, 0.3, 0.29),
          color_b: rgba(0.52, 0.51, 0.49),
        }),
        normal: proc('NOISE', {
          scale: 25,
          detail: 4,
          seed: 3,
          color_a: grey(0),
          color_b: grey(1),
          params: { bump_distance: 0.003 },
        }),
      },
    },
  },
  {
    id: 'brick',
    name: 'Brick',
    category: 'STONE',
    description:
      'Red brick wall (215 × 65 mm bricks in courses along Z, mortar joints) with recessed mortar bump; walls facing ±X/±Y.',
    material: {
      base_color: [0.4, 0.11, 0.06, 1],
      roughness: 0.85,
      textures: {
        base_color: proc('BRICK', {
          scale: 1,
          color_a: rgba(0.3, 0.07, 0.04),
          color_b: rgba(0.48, 0.15, 0.07),
          params: { ...brickLayout, mortar_r: 0.45, mortar_g: 0.43, mortar_b: 0.4 },
        }),
        normal: proc('BRICK', {
          scale: 1,
          color_a: grey(1),
          color_b: grey(1),
          params: { ...brickLayout, mortar_r: 0, mortar_g: 0, mortar_b: 0, bump_distance: 0.006 },
        }),
      },
    },
  },
  {
    id: 'rock',
    name: 'Rock',
    category: 'STONE',
    description: 'Rough natural stone with mottled colour and cracks (procedural colour and bump).',
    material: {
      base_color: [0.3, 0.29, 0.27, 1],
      roughness: 0.85,
      textures: {
        base_color: proc('NOISE', {
          scale: 2,
          detail: 8,
          roughness: 0.65,
          distortion: 0.5,
          ramp_low: 0.25,
          ramp_high: 0.75,
          color_a: rgba(0.16, 0.15, 0.14),
          color_b: rgba(0.42, 0.4, 0.37),
        }),
        normal: proc('VORONOI', {
          scale: 3,
          distortion: 0.3,
          ramp_low: 0,
          ramp_high: 0.12,
          color_a: grey(0),
          color_b: grey(1),
          params: { feature: 'DISTANCE_TO_EDGE', bump_distance: 0.02 },
        }),
      },
    },
  },
  // ---------------------------------------------------------------- wood
  {
    id: 'wood',
    name: 'Wood',
    category: 'WOOD',
    description:
      'Oiled oak-like wood: growth rings around the object Z axis plus fibre grain (procedural WOOD).',
    material: {
      base_color: [0.35, 0.17, 0.07, 1],
      roughness: 0.5,
      textures: {
        base_color: proc('WOOD', {
          scale: 30,
          detail: 3,
          distortion: 0.8,
          color_a: rgba(0.2, 0.08, 0.03),
          color_b: rgba(0.45, 0.22, 0.09),
          params: { wave_profile: 'SAW', grain: 0.35, offset_y: 0.6 },
        }),
        normal: proc('WOOD', {
          scale: 30,
          detail: 3,
          distortion: 0.8,
          color_a: grey(0),
          color_b: grey(1),
          params: { wave_profile: 'SAW', grain: 0.35, offset_y: 0.6, bump_distance: 0.0004 },
        }),
      },
    },
  },
  // ---------------------------------------------------------------- fabric & leather
  {
    id: 'fabric',
    name: 'Fabric',
    category: 'FABRIC',
    description: 'Blue woven cotton with sheen and a fine weave bump.',
    material: {
      base_color: [0.08, 0.15, 0.35, 1],
      roughness: 0.95,
      sheen_weight: 0.6,
      sheen_tint: [1, 1, 1],
      textures: {
        base_color: proc('NOISE', {
          scale: 30,
          detail: 2,
          color_a: rgba(0.06, 0.12, 0.3),
          color_b: rgba(0.1, 0.18, 0.4),
        }),
        normal: proc('CHECKER', {
          scale: 300,
          color_a: grey(0),
          color_b: grey(1),
          params: { bump_distance: 0.0004 },
        }),
      },
    },
  },
  {
    id: 'velvet',
    name: 'Velvet',
    category: 'FABRIC',
    description: 'Deep red velvet with a strong soft sheen.',
    material: {
      base_color: [0.28, 0.015, 0.04, 1],
      roughness: 0.85,
      sheen_weight: 1,
      sheen_tint: [1, 0.55, 0.6],
    },
  },
  {
    id: 'leather',
    name: 'Leather',
    category: 'FABRIC',
    description: 'Brown leather with a pebbled grain (procedural Voronoi bump).',
    material: {
      base_color: [0.22, 0.09, 0.035, 1],
      roughness: 0.5,
      textures: {
        base_color: proc('NOISE', {
          scale: 8,
          detail: 4,
          color_a: rgba(0.18, 0.07, 0.03),
          color_b: rgba(0.27, 0.11, 0.045),
        }),
        normal: proc('VORONOI', {
          scale: 150,
          ramp_low: 0,
          ramp_high: 0.8,
          color_a: grey(1),
          color_b: grey(0),
          params: { ...leatherGrain, bump_distance: 0.0005 },
        }),
      },
    },
  },
  // ---------------------------------------------------------------- paint & emissive
  {
    id: 'car_paint',
    name: 'Car Paint',
    category: 'PAINT',
    description: 'Metallic red car paint under a glossy clear coat.',
    material: {
      base_color: [0.45, 0.01, 0.02, 1],
      metallic: 0.6,
      roughness: 0.35,
      coat_weight: 1,
      coat_roughness: 0.02,
    },
  },
  {
    id: 'neon',
    name: 'Neon',
    category: 'EMISSIVE',
    description: 'Bright cyan neon tube (emission strength 12).',
    material: {
      base_color: [0.02, 0.02, 0.02, 1],
      roughness: 0.3,
      emission_color: [0.05, 0.75, 1],
      emission_strength: 12,
    },
  },
  {
    id: 'lava',
    name: 'Lava',
    category: 'EMISSIVE',
    description: 'Dark cooled crust with glowing orange cracks (procedural emission).',
    material: {
      base_color: [0.05, 0.03, 0.02, 1],
      roughness: 0.8,
      emission_color: [1, 0.25, 0.02],
      emission_strength: 6,
      textures: {
        base_color: proc('NOISE', {
          scale: 1.5,
          detail: 6,
          roughness: 0.6,
          color_a: rgba(0.03, 0.025, 0.02),
          color_b: rgba(0.12, 0.04, 0.015),
          params: { noise_type: 'RIDGED' },
        }),
        emission: proc('NOISE', {
          scale: 1.5,
          detail: 6,
          roughness: 0.6,
          ramp_low: 0.62,
          ramp_high: 0.8,
          color_a: rgba(0, 0, 0),
          color_b: rgba(1, 0.25, 0.02),
          params: { noise_type: 'RIDGED' },
        }),
      },
    },
  },
  // ---------------------------------------------------------------- organic & ground
  {
    id: 'skin',
    name: 'Skin',
    category: 'ORGANIC',
    description: 'Skin-like soft surface with subtle colour variation and sheen.',
    material: {
      base_color: [0.8, 0.52, 0.42, 1],
      roughness: 0.45,
      sheen_weight: 0.15,
      sheen_tint: [1, 0.8, 0.75],
      textures: {
        base_color: proc('NOISE', {
          scale: 20,
          detail: 3,
          color_a: rgba(0.74, 0.47, 0.37),
          color_b: rgba(0.84, 0.56, 0.46),
        }),
      },
    },
  },
  {
    id: 'grass',
    name: 'Grass',
    category: 'GROUND',
    description: 'Lawn-like ground cover: patchy greens with a fine bump.',
    material: {
      base_color: [0.08, 0.22, 0.03, 1],
      roughness: 0.75,
      textures: {
        base_color: proc('NOISE', {
          scale: 6,
          detail: 6,
          roughness: 0.6,
          ramp_low: 0.3,
          ramp_high: 0.7,
          color_a: rgba(0.04, 0.13, 0.02),
          color_b: rgba(0.16, 0.32, 0.05),
        }),
        normal: proc('NOISE', {
          scale: 80,
          detail: 2,
          seed: 5,
          color_a: grey(0),
          color_b: grey(1),
          params: { bump_distance: 0.003 },
        }),
      },
    },
  },
  {
    id: 'snow',
    name: 'Snow',
    category: 'GROUND',
    description: 'Fresh snow: bright, soft and gently undulating.',
    material: {
      base_color: [0.9, 0.92, 0.95, 1],
      roughness: 0.55,
      sheen_weight: 0.3,
      sheen_tint: [1, 1, 1],
      textures: {
        normal: proc('NOISE', {
          scale: 3,
          detail: 5,
          color_a: grey(0),
          color_b: grey(1),
          params: { bump_distance: 0.02 },
        }),
      },
    },
  },
  {
    id: 'sand',
    name: 'Sand',
    category: 'GROUND',
    description: 'Dry desert sand with wind ripples (procedural colour and bump).',
    material: {
      base_color: [0.7, 0.55, 0.36, 1],
      roughness: 0.95,
      textures: {
        base_color: proc('NOISE', {
          scale: 15,
          detail: 4,
          color_a: rgba(0.62, 0.47, 0.3),
          color_b: rgba(0.78, 0.62, 0.42),
        }),
        normal: proc('WAVE', {
          scale: 0.5,
          detail: 3,
          distortion: 6,
          color_a: grey(0),
          color_b: grey(1),
          params: { direction: 'X', bump_distance: 0.01 },
        }),
      },
    },
  },
  // ---------------------------------------------------------------- patterns
  {
    id: 'checker',
    name: 'Checker',
    category: 'PATTERN',
    description: 'Black and white checkerboard over the object bounds (8 cells per side, GENERATED mapping).',
    material: {
      base_color: [0.5, 0.5, 0.5, 1],
      roughness: 0.4,
      textures: {
        base_color: proc('CHECKER', {
          mapping: 'GENERATED',
          scale: 8,
          color_a: grey(0.8),
          color_b: grey(0.03),
        }),
      },
    },
  },
];

/** Preset by id (case-insensitive; spaces and dashes count as underscores). */
export function getMaterialPreset(id: string): MaterialPreset | undefined {
  const key = id
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return MATERIAL_PRESETS.find((p) => p.id === key);
}

/**
 * Complete material values of a preset (every principled field and texture slot, deep-copied), as
 * written by `material.preset_apply`.
 */
export function presetMaterialValues(preset: MaterialPreset): Omit<MaterialData, 'id' | 'name'> {
  const { id: _id, name: _name, ...base } = defaultMaterial('', preset.name);
  return { ...base, ...cloneJson(preset.material), textures: cloneJson(preset.material.textures ?? {}) };
}
