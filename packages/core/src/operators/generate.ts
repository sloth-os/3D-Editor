import { z } from 'zod';
import type { Vec3 } from '../math/types';
import { compose4 } from '../math/mat4';
import { meshBounds, meshStats } from '../mesh/types';
import { OperatorError, type OperatorContext } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, setSelection, vec3 } from './helpers';
import {
  ARCH_DEFAULTS,
  BARREL_DEFAULTS,
  BLOB_DEFAULTS,
  BUILDING_DEFAULTS,
  BUSH_DEFAULTS,
  CHAIR_DEFAULTS,
  CLOUD_DEFAULTS,
  COLUMN_DEFAULTS,
  FENCE_DEFAULTS,
  FLOWER_DEFAULTS,
  GEAR_DEFAULTS,
  GRASS_DEFAULTS,
  PIPE_DEFAULTS,
  ROCK_DEFAULTS,
  SHELF_DEFAULTS,
  SPRING_DEFAULTS,
  STAIRS_DEFAULTS,
  TABLE_DEFAULTS,
  TERRAIN_DEFAULTS,
  TREE_DEFAULTS,
  WHEEL_DEFAULTS,
  GeneratorLimitError,
  MAX_GENERATED_FACES,
  generateArch,
  generateBarrel,
  generateBlob,
  generateBuilding,
  generateBush,
  generateChair,
  generateCloud,
  generateColumn,
  generateFence,
  generateFlower,
  generateGear,
  generateGrassTuft,
  generatePipe,
  generateRock,
  generateShelf,
  generateSpring,
  generateStairs,
  generateTable,
  generateTerrain,
  generateTree,
  generateWheel,
  type GeneratedMaterial,
  type GeneratorResult,
} from '../generate';

/*
 * object.generate_* operators: procedural generators that create a new mesh object (terrain, rock,
 * vegetation, buildings, architecture, furniture, mechanical parts, blobs and clouds). Every
 * generator is deterministic (seeded where random), builds closed meshes with outward normals and
 * UVs, and uses one material slot per part so agents can re-assign materials per slot.
 */

const vec2 = z.tuple([z.number(), z.number()]);

const seed = z
  .number()
  .int()
  .default(0)
  .describe(
    'Random seed: the same seed and parameters always give the same result; change it for a variation',
  );

/** Parameters shared by every generator: naming, placement and material slots. */
const common = {
  name: z
    .string()
    .optional()
    .describe(
      'Name of the new object and its mesh (default: the generator name, made unique like "Tree.001")',
    ),
  location: vec3
    .optional()
    .describe('World location of the object origin in metres (default: the 3D cursor)'),
  rotation: vec3.default([0, 0, 0]).describe('Object rotation, Euler XYZ in radians'),
  scale: vec3.default([1, 1, 1]).describe('Object scale (all generator sizes are metres at scale 1)'),
  materials: z
    .boolean()
    .default(true)
    .describe(
      'true: fill the material slots with the default materials named in the description (an existing material ' +
        'with the same name is reused, so e.g. every generated tree shares "Bark"); false: leave every slot empty ' +
        'for you to assign (object.material_assign with slot = the slot index)',
    ),
};

type CommonParams = {
  name?: string;
  location?: number[];
  rotation: number[];
  scale: number[];
  materials: boolean;
};

/** Results above this many faces get a WARNING report (heavy for the viewport and for syncing). */
export const LARGE_GENERATED_FACES = 250_000;

const TAIL =
  'Object Mode only. The new object becomes the selection and the active object. ' +
  `A mesh may have at most ${MAX_GENERATED_FACES.toLocaleString('en-US')} faces: larger requests fail ` +
  'without changes, naming the parameters to lower. Inputs that cannot produce any geometry (e.g. too few ' +
  'distinct points) fail too; inputs that were partly ignored are reported as warnings. ' +
  'Returns {object (id), name, mesh (id), vertices, faces, triangles, dimensions (bounding box size along the ' +
  "object's axes × scale, metres), bounds (world-space {min, max}), material_slots: [{index, name, material}], " +
  'warnings (only when there are any)}.';

/** Result of every object.generate_* operator. */
export interface GeneratedObjectInfo {
  object: string;
  name: string;
  mesh: string;
  vertices: number;
  faces: number;
  triangles: number;
  dimensions: Vec3;
  bounds: { min: Vec3; max: Vec3 };
  material_slots: { index: number; name: string; material: string | null }[];
  /** Input problems the generator worked around (also reported as WARNING). */
  warnings?: string[];
}

/** Id of the material used for a generator default: an existing material of that name, else a new one. */
function generatorMaterial(ctx: OperatorContext, m: GeneratedMaterial): string {
  const existing = ctx.doc.listMaterials().find((x) => x.name === m.name);
  if (existing) return existing.id;
  return ctx.doc.addMaterial({
    name: m.name,
    base_color: [m.base_color[0], m.base_color[1], m.base_color[2], m.base_color[3]],
    roughness: m.roughness,
    metallic: m.metallic ?? 0,
    ...(m.transmission !== undefined ? { transmission: m.transmission } : {}),
    ...(m.ior !== undefined ? { ior: m.ior } : {}),
  });
}

/** Adds the generated mesh as a new selected, active object and describes it. */
export function addGeneratedObject(
  ctx: OperatorContext,
  label: string,
  res: GeneratorResult,
  p: CommonParams,
): GeneratedObjectInfo {
  const name = p.name?.trim() || label;
  const meshId = ctx.doc.addMesh(name, res.mesh);
  const slots = res.materials.map((m) => (p.materials ? generatorMaterial(ctx, m) : null));
  const location = (p.location ?? ctx.state.cursorLocation).slice(0, 3) as Vec3;
  const rotation = p.rotation.slice(0, 3) as Vec3;
  const scale = p.scale.slice(0, 3) as Vec3;
  const id = ctx.doc.addObject({
    type: 'MESH',
    name,
    data: meshId,
    location,
    rotation_euler: rotation,
    scale,
    material_slots: slots,
  });
  setSelection(ctx, [id], id);
  // describe the stored (float32-encoded) mesh so the numbers match the document exactly
  const stored = ctx.doc.getMesh(meshId) ?? res.mesh;
  const stats = meshStats(stored);
  const local = meshBounds(stored) ?? { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  const m = compose4(location, rotation, scale);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const P = stored.positions;
  for (let i = 0; i + 2 < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  const bounds = P.length >= 3 ? { min, max } : { min: [...location] as Vec3, max: [...location] as Vec3 };
  // micrometre rounding hides float32 noise (2.799999952 → 2.8)
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
  return {
    object: id,
    name: ctx.doc.getObject(id)?.name ?? name,
    mesh: meshId,
    vertices: stats.vertices,
    faces: stats.faces,
    triangles: stats.triangles,
    dimensions: [0, 1, 2].map((k) => r6((local.max[k] - local.min[k]) * Math.abs(scale[k]))) as Vec3,
    bounds: { min: bounds.min.map(r6) as Vec3, max: bounds.max.map(r6) as Vec3 },
    material_slots: res.materials.map((mat, index) => ({ index, name: mat.name, material: slots[index] })),
    ...(res.warnings?.length ? { warnings: res.warnings.slice() } : {}),
  };
}

/**
 * Runs a generator for an operator: oversized requests and inputs without any geometry become
 * INVALID_PARAMS errors (before anything is added to the document), warnings become reports.
 * `lower` names the parameters that drive the size of the result (for the messages).
 */
export function runGenerator(
  ctx: OperatorContext,
  label: string,
  lower: string,
  build: () => GeneratorResult,
): GeneratorResult {
  let res: GeneratorResult;
  try {
    res = build();
  } catch (err) {
    if (err instanceof GeneratorLimitError)
      throw new OperatorError(`${label}: ${err.message}; lower ${lower}`, 'INVALID_PARAMS');
    throw err;
  }
  if (res.mesh.faces.length === 0)
    throw new OperatorError(
      `${label}: nothing to generate${res.warnings?.length ? `: ${res.warnings.join('; ')}` : ''}`,
      'INVALID_PARAMS',
    );
  for (const w of res.warnings ?? []) ctx.report('WARNING', `${label}: ${w}`);
  const faces = res.mesh.faces.length;
  if (faces > LARGE_GENERATED_FACES)
    ctx.report(
      'WARNING',
      `${label}: large mesh (${faces.toLocaleString('en-US')} faces); lower ${lower} for a lighter scene`,
    );
  return res;
}

/** Registers one generator operator `object.generate_<kind>`. */
function generator<S extends z.ZodRawShape>(
  reg: OperatorRegistry,
  def: {
    kind: string;
    label: string;
    description: string;
    /** Parameters to lower when the result is too big (used in error and warning messages). */
    lower: string;
    shape: S;
    build: (p: z.output<z.ZodObject<S>>) => GeneratorResult;
  },
): void {
  const schema = z.object({ ...def.shape, ...common });
  reg.register(
    defineOperator({
      id: `object.generate_${def.kind}`,
      label: def.label,
      description: `${def.description} ${TAIL}`,
      category: 'Add',
      redoable: true,
      schema,
      poll: pollObjectMode,
      execute(ctx, p) {
        const params = p as unknown as z.output<z.ZodObject<S>> & CommonParams;
        const res = runGenerator(ctx, def.label, def.lower, () => def.build(params));
        return addGeneratedObject(ctx, def.label, res, params);
      },
    }),
  );
}

const T = TERRAIN_DEFAULTS;
const R = ROCK_DEFAULTS;
const TR = TREE_DEFAULTS;
const BU = BUILDING_DEFAULTS;
const ST = STAIRS_DEFAULTS;
const FE = FENCE_DEFAULTS;
const PI = PIPE_DEFAULTS;

export function registerGenerateOperators(reg: OperatorRegistry): void {
  // ------------------------------------------------------------------ landscape
  generator(reg, {
    kind: 'terrain',
    label: 'Terrain',
    lower: 'subdivisions',
    description:
      'Generate a noise heightfield terrain: a square grid of `size` × `size` metres centred on the object origin ' +
      'with heights spanning exactly z = 0 … `height` (fractal gradient noise; optional island falloff and ' +
      'terraces), UVs 0..1 over the whole terrain, smooth shaded. Material slots with zones=true: 0 Grass, ' +
      '1 Rock (faces steeper than rock_slope, and the skirt of a solid terrain), 2 Snow (faces above ' +
      'snow_height × height); with zones=false a single slot 0 Ground. An open surface unless solid=true.',
    shape: {
      size: z
        .number()
        .min(0.01)
        .max(1e5)
        .default(T.size)
        .describe('Width and depth of the terrain in metres'),
      subdivisions: z
        .number()
        .int()
        .min(1)
        .max(512)
        .default(T.subdivisions)
        .describe('Grid cells per side: (subdivisions+1)² vertices, subdivisions² quads'),
      height: z
        .number()
        .min(0)
        .max(1e5)
        .default(T.height)
        .describe('Elevation range in metres: the lowest point is at z = 0, the highest at z = height'),
      noise_scale: z
        .number()
        .min(0.001)
        .max(1e6)
        .default(T.noise_scale)
        .describe('Size of the largest features (hills) in metres; larger = broader hills'),
      octaves: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(T.octaves)
        .describe('Noise detail levels: 1 = smooth swells, 8+ = very fine detail'),
      roughness: z
        .number()
        .min(0)
        .max(1)
        .default(T.roughness)
        .describe('Amplitude kept per octave, 0..1 (higher = rougher, more small-scale relief)'),
      noise_type: z
        .enum(['FBM', 'RIDGED', 'BILLOW'])
        .default(T.noise_type)
        .describe('FBM: rolling hills; RIDGED: sharp mountain crests; BILLOW: rounded dunes'),
      seed,
      island_falloff: z
        .number()
        .min(0)
        .max(1)
        .default(T.island_falloff)
        .describe('0..1: lowers the terrain towards its rim (1 = an island whose border is at z = 0)'),
      terraces: z
        .number()
        .int()
        .min(0)
        .max(100)
        .default(T.terraces)
        .describe('Number of flat terrace levels (0 = smooth slopes)'),
      zones: z
        .boolean()
        .default(T.zones)
        .describe('Assign the Grass / Rock / Snow slots per face (false: one Ground slot)'),
      rock_slope: z
        .number()
        .min(0)
        .max(Math.PI / 2)
        .default(T.rock_slope)
        .describe('zones: faces steeper than this slope angle (radians) get slot 1 Rock'),
      snow_height: z
        .number()
        .min(0)
        .max(1)
        .default(T.snow_height)
        .describe('zones: faces above this fraction of `height` get slot 2 Snow (1 = no snow)'),
      solid: z
        .boolean()
        .default(T.solid)
        .describe('Close the terrain into a solid block with skirt walls and a bottom at z = −base_depth'),
      base_depth: z
        .number()
        .min(0.001)
        .max(1e5)
        .default(T.base_depth)
        .describe('solid: depth of the block below z = 0 in metres'),
    },
    build: (p) => generateTerrain(p),
  });

  generator(reg, {
    kind: 'rock',
    label: 'Rock',
    lower: 'detail',
    description:
      'Generate a rock or boulder: a noise-displaced icosphere with flat fractured facets, resting on z = 0 and ' +
      'centred on the Z axis (origin at the bottom centre). Material slot 0 Rock.',
    shape: {
      size: vec3
        .default(R.size)
        .describe('Approximate dimensions [x, y, z] in metres (flat_bottom cuts away part of the height)'),
      roughness: z
        .number()
        .min(0)
        .max(1)
        .default(R.roughness)
        .describe('Amount of noise displacement, 0 (smooth pebble) .. 1 (craggy)'),
      detail: z
        .number()
        .int()
        .min(1)
        .max(6)
        .default(R.detail)
        .describe('Icosphere subdivision level: 20·4^(detail−1) triangles (4 = 1280)'),
      facets: z
        .number()
        .int()
        .min(0)
        .max(16)
        .default(R.facets)
        .describe('Number of flat fractured faces cut into the rock'),
      flat_bottom: z
        .boolean()
        .default(R.flat_bottom)
        .describe('Flatten the underside so the rock sits stably on the ground'),
      seed,
    },
    build: (p) => generateRock({ ...p, size: p.size as Vec3 }),
  });

  // ------------------------------------------------------------------ vegetation
  generator(reg, {
    kind: 'tree',
    label: 'Tree',
    lower: 'branch_levels, branches, leaf_density or resolution',
    description:
      'Generate a tree standing on z = 0 with its trunk on the object Z axis (origin at the foot of the trunk); ' +
      'the total height including foliage is exactly `height`. Styles: DECIDUOUS (tapered trunk with ' +
      'recursive branches ending in leafy clumps), CONIFER (straight trunk with stacked jagged needle tiers), ' +
      'PALM (curved banded trunk, coconuts and drooping fronds). Material slots: 0 Bark (trunk, branches, ' +
      'coconuts), 1 foliage (Leaves / Needles / Palm Leaves).',
    shape: {
      style: z.enum(['DECIDUOUS', 'CONIFER', 'PALM']).default(TR.style).describe('Tree type'),
      height: z.number().min(0.1).max(1000).default(TR.height).describe('Total height in metres'),
      trunk_radius: z
        .number()
        .min(0.002)
        .max(100)
        .default(TR.trunk_radius)
        .describe('Radius of the trunk near the ground in metres'),
      branch_levels: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(TR.branch_levels)
        .describe(
          'DECIDUOUS: branching depth (recursion levels); CONIFER: foliage tiers = branch_levels + 3',
        ),
      branch_angle: z
        .number()
        .min(0)
        .max(Math.PI / 2)
        .default(TR.branch_angle)
        .describe(
          'Radians. DECIDUOUS: angle between a branch and its parent; CONIFER: slope of the tiers; PALM: frond droop',
        ),
      branches: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(TR.branches)
        .describe('DECIDUOUS: child branches per branch (the trunk gets 1.6×); PALM: fronds = branches × 3'),
      leaf_density: z
        .number()
        .min(0)
        .max(1)
        .default(TR.leaf_density)
        .describe('Amount of foliage 0..1 (0 = bare branches / no fronds or needles)'),
      leaf_size: z
        .number()
        .min(0.01)
        .max(100)
        .default(TR.leaf_size)
        .describe(
          'Metres. DECIDUOUS: diameter of a leaf clump; CONIFER: depth of the jagged tier rims; PALM: frond width',
        ),
      resolution: z
        .number()
        .int()
        .min(3)
        .max(64)
        .default(TR.resolution)
        .describe('Vertices around the trunk (branches use fewer)'),
      seed,
    },
    build: (p) => generateTree(p),
  });

  generator(reg, {
    kind: 'bush',
    label: 'Bush',
    lower: 'density',
    description:
      'Generate a bush: a dome of leafy clumps on a few short stems, standing on z = 0 and centred on the Z ' +
      'axis; its height is exactly `height`. Material slots: 0 Bark (stems), 1 Leaves.',
    shape: {
      size: z.number().min(0.02).max(100).default(BUSH_DEFAULTS.size).describe('Diameter in metres'),
      height: z.number().min(0.02).max(100).default(BUSH_DEFAULTS.height).describe('Height in metres'),
      density: z
        .number()
        .min(0)
        .max(1)
        .default(BUSH_DEFAULTS.density)
        .describe('Number of leaf clumps: 0 → 8 clumps, 1 → 40 clumps'),
      leaf_size: z
        .number()
        .min(0.01)
        .max(100)
        .default(BUSH_DEFAULTS.leaf_size)
        .describe('Diameter of one leaf clump in metres'),
      seed,
    },
    build: (p) => generateBush(p),
  });

  generator(reg, {
    kind: 'grass_tuft',
    label: 'Grass',
    lower: 'blades',
    description:
      'Generate a tuft of curved, pointed grass blades (thin closed blades) rooted around the object origin ' +
      'on z = 0. Material slot 0 Grass. Tip: scatter it with object.scatter_on_surface or object.scatter_add.',
    shape: {
      blades: z.number().int().min(1).max(1000).default(GRASS_DEFAULTS.blades).describe('Number of blades'),
      height: z
        .number()
        .min(0.005)
        .max(100)
        .default(GRASS_DEFAULTS.height)
        .describe('Height of the tallest blades in metres'),
      spread: z
        .number()
        .min(0)
        .max(100)
        .default(GRASS_DEFAULTS.spread)
        .describe('Radius over which the blade roots are spread, in metres'),
      blade_width: z
        .number()
        .min(0.0005)
        .max(10)
        .default(GRASS_DEFAULTS.blade_width)
        .describe('Width of a blade at its root in metres'),
      bend: z
        .number()
        .min(0)
        .max(1)
        .default(GRASS_DEFAULTS.bend)
        .describe('How far the blades arch over, 0 (upright) .. 1'),
      seed,
    },
    build: (p) => generateGrassTuft(p),
  });

  generator(reg, {
    kind: 'flower',
    label: 'Flower',
    lower: 'petals',
    description:
      'Generate a flower: a curved stem with leaves, a ring of petals and a centre disc, standing on z = 0 ' +
      '(origin at the foot of the stem). Material slots: 0 Stem (stem and leaves), 1 Petals, 2 Flower Center.',
    shape: {
      height: z
        .number()
        .min(0.01)
        .max(100)
        .default(FLOWER_DEFAULTS.height)
        .describe('Height of the flower head above the ground in metres'),
      petals: z.number().int().min(0).max(64).default(FLOWER_DEFAULTS.petals).describe('Number of petals'),
      petal_length: z
        .number()
        .min(0.001)
        .max(10)
        .default(FLOWER_DEFAULTS.petal_length)
        .describe('Petal length in metres'),
      petal_width: z
        .number()
        .min(0.0005)
        .max(10)
        .default(FLOWER_DEFAULTS.petal_width)
        .describe('Petal width in metres'),
      head_size: z
        .number()
        .min(0.001)
        .max(10)
        .default(FLOWER_DEFAULTS.head_size)
        .describe('Radius of the centre disc in metres'),
      leaves: z
        .number()
        .int()
        .min(0)
        .max(6)
        .default(FLOWER_DEFAULTS.leaves)
        .describe('Number of leaves on the stem'),
      seed,
    },
    build: (p) => generateFlower(p),
  });

  // ------------------------------------------------------------------ architecture
  generator(reg, {
    kind: 'building',
    label: 'Building',
    lower: 'floors, window_rows, window_cols / window_cols_side, or width and depth',
    description:
      'Generate a multi-storey building: a closed wall shell with recessed windows (reveal, frame and glass) ' +
      'on every facade, a front door, and a FLAT (with parapet), GABLE or HIP roof. The footprint ' +
      '(`width` along X × `depth` along Y) is centred on the object origin, the ground floor is at z = 0 and ' +
      'the front facade with the door faces −Y. Wall height = floors × floor_height; GABLE/HIP add roof_height ' +
      '(the gable ridge runs along the longer side). Material slots: 0 Wall, 1 Window Glass, 2 Window Frame, ' +
      '3 Roof, 4 Door.',
    shape: {
      floors: z.number().int().min(1).max(200).default(BU.floors).describe('Number of storeys'),
      width: z.number().min(1).max(1000).default(BU.width).describe('Size along X in metres'),
      depth: z.number().min(1).max(1000).default(BU.depth).describe('Size along Y in metres'),
      floor_height: z.number().min(1).max(100).default(BU.floor_height).describe('Storey height in metres'),
      window_cols: z
        .number()
        .int()
        .min(0)
        .max(200)
        .nullable()
        .default(BU.window_cols)
        .describe(
          'Window columns on the front and back facades (null = automatic, about one per 2.5 m; 0 = none)',
        ),
      window_cols_side: z
        .number()
        .int()
        .min(0)
        .max(200)
        .nullable()
        .default(BU.window_cols_side)
        .describe('Window columns on the left and right facades (null = automatic; 0 = none)'),
      window_rows: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(BU.window_rows)
        .describe('Rows of windows per storey'),
      window_width: z
        .number()
        .min(0.1)
        .max(100)
        .default(BU.window_width)
        .describe('Window width in metres (shrunk to fit the column pitch)'),
      window_height: z
        .number()
        .min(0.1)
        .max(100)
        .default(BU.window_height)
        .describe('Window height in metres (shrunk to fit the storey)'),
      sill_height: z
        .number()
        .min(0)
        .max(100)
        .default(BU.sill_height)
        .describe('Height of the window bottoms above each storey floor in metres'),
      window_inset: z
        .number()
        .min(0.01)
        .max(2)
        .default(BU.window_inset)
        .describe('How deep windows and the door are recessed into the wall, in metres'),
      door: z.boolean().default(BU.door).describe('Add a door centred on the front (−Y) facade'),
      door_width: z.number().min(0.3).max(100).default(BU.door_width).describe('Door width in metres'),
      door_height: z
        .number()
        .min(0.5)
        .max(100)
        .default(BU.door_height)
        .describe('Door height in metres (at most floor_height − 0.3)'),
      roof: z
        .enum(['FLAT', 'GABLE', 'HIP'])
        .default(BU.roof)
        .describe(
          'FLAT: flat roof with a parapet; GABLE: pitched with gable ends; HIP: pitched on all four sides',
        ),
      roof_height: z
        .number()
        .min(0.05)
        .max(1000)
        .default(BU.roof_height)
        .describe('GABLE/HIP: ridge height above the top of the walls in metres'),
      roof_overhang: z
        .number()
        .min(0)
        .max(50)
        .default(BU.roof_overhang)
        .describe('GABLE/HIP: roof overhang beyond the walls in metres'),
    },
    build: (p) => generateBuilding(p),
  });

  generator(reg, {
    kind: 'stairs',
    label: 'Stairs',
    lower: 'steps',
    description:
      'Generate stairs. STRAIGHT: the flight climbs along +Y starting at y = 0 (front edge of the first step), ' +
      'centred on X, solid down to the ground or a sloped slab. SPIRAL: wedge-shaped treads wind around a ' +
      'central column on the Z axis, starting towards +X. The top tread is at z = steps × rise; optional ' +
      'handrails. Material slots: 0 Concrete (steps), 1 Metal (spiral column and railing).',
    shape: {
      steps: z.number().int().min(1).max(500).default(ST.steps).describe('Number of steps'),
      width: z
        .number()
        .min(0.05)
        .max(1000)
        .default(ST.width)
        .describe('STRAIGHT: width of the flight; SPIRAL: radial length of the treads (metres)'),
      rise: z.number().min(0.005).max(10).default(ST.rise).describe('Height of one step in metres'),
      run: z
        .number()
        .min(0.01)
        .max(10)
        .default(ST.run)
        .describe('Depth of one tread in metres (SPIRAL: measured on the walking line at mid-width)'),
      style: z.enum(['STRAIGHT', 'SPIRAL']).default(ST.style).describe('Straight flight or spiral staircase'),
      solid: z
        .boolean()
        .default(ST.solid)
        .describe('STRAIGHT: fill the flight down to the ground (false: a sloped slab of `thickness`)'),
      thickness: z
        .number()
        .min(0.005)
        .max(10)
        .default(ST.thickness)
        .describe('Slab thickness of a non-solid straight flight / tread thickness of spiral steps (metres)'),
      inner_radius: z
        .number()
        .min(0.01)
        .max(100)
        .default(ST.inner_radius)
        .describe('SPIRAL: radius of the central column in metres'),
      clockwise: z
        .boolean()
        .default(ST.clockwise)
        .describe('SPIRAL: turn clockwise (seen from above) while climbing'),
      railing: z.boolean().default(ST.railing).describe('Add handrails on posts (slot 1)'),
    },
    build: (p) => generateStairs(p),
  });

  generator(reg, {
    kind: 'fence',
    label: 'Fence',
    lower: 'the number of points or the path length, or raise post_spacing and picket_width / picket_gap',
    description:
      'Generate a fence along a path of points (object space, relative to the object origin): posts at every ' +
      'path point plus intermediate posts at most post_spacing apart, with horizontal rails (RAIL) or two rails ' +
      'and pointed boards (PICKET). Point z values let the fence follow uneven ground. Without points: a ' +
      'straight fence of `length` along +X starting at the origin. Material slot 0 Fence Wood.',
    shape: {
      points: z
        .array(z.union([vec3, vec2]))
        .max(10000)
        .nullable()
        .default(null)
        .describe(
          'Path points [x, y] or [x, y, z] in metres relative to the object origin; at least 2 at distinct ' +
            '[x, y] positions (fewer fail). null or [] = a straight fence of `length` along +X',
        ),
      length: z
        .number()
        .min(0.1)
        .max(1e4)
        .default(FE.length)
        .describe('Length of the straight fence in metres (used when points is null)'),
      height: z.number().min(0.05).max(100).default(FE.height).describe('Height in metres'),
      post_spacing: z
        .number()
        .min(0.1)
        .max(1000)
        .default(FE.post_spacing)
        .describe('Maximum distance between posts in metres'),
      post_width: z
        .number()
        .min(0.005)
        .max(10)
        .default(FE.post_width)
        .describe('Width of the square posts in metres'),
      rails: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(FE.rails)
        .describe('RAIL: number of horizontal rails between posts'),
      style: z
        .enum(['RAIL', 'PICKET'])
        .default(FE.style)
        .describe('RAIL: horizontal rails only; PICKET: two rails with pointed vertical boards'),
      picket_width: z
        .number()
        .min(0.005)
        .max(1)
        .default(FE.picket_width)
        .describe('PICKET: board width in metres'),
      picket_gap: z
        .number()
        .min(0)
        .max(1)
        .default(FE.picket_gap)
        .describe('PICKET: gap between boards in metres'),
      closed: z.boolean().default(FE.closed).describe('Close the path into a loop (needs 3+ points)'),
    },
    build: (p) => generateFence(p),
  });

  generator(reg, {
    kind: 'column',
    label: 'Column',
    lower: 'segments or flutes',
    description:
      'Generate a classical (Doric-like) column standing on z = 0 with its axis on Z: a slightly tapered, ' +
      'optionally fluted shaft, a square plinth with torus moulding (base) and an echinus + square abacus ' +
      '(capital); total height exactly `height`. Material slots: 0 Marble (shaft), 1 Marble Trim (base and capital).',
    shape: {
      height: z
        .number()
        .min(0.01)
        .max(1e4)
        .default(COLUMN_DEFAULTS.height)
        .describe('Total height in metres'),
      radius: z
        .number()
        .min(0.001)
        .max(1000)
        .default(COLUMN_DEFAULTS.radius)
        .describe('Shaft radius at its foot in metres (tapers to ~86% at the top)'),
      flutes: z
        .number()
        .int()
        .min(0)
        .max(64)
        .default(COLUMN_DEFAULTS.flutes)
        .describe('Number of vertical flutes (grooves); 0 = smooth shaft'),
      base: z
        .boolean()
        .default(COLUMN_DEFAULTS.base)
        .describe('Add the plinth and torus moulding at the foot'),
      capital: z.boolean().default(COLUMN_DEFAULTS.capital).describe('Add the capital on top'),
      segments: z
        .number()
        .int()
        .min(8)
        .max(256)
        .default(COLUMN_DEFAULTS.segments)
        .describe('Vertices around a smooth shaft (fluted shafts use 6 per flute)'),
    },
    build: (p) => generateColumn(p),
  });

  generator(reg, {
    kind: 'arch',
    label: 'Arch',
    lower: 'segments',
    description:
      'Generate a free-standing masonry arch: two piers and a ROUND (semicircular, or segmental when too low) ' +
      'or POINTED (gothic) opening, standing on z = 0 with the opening centred on the origin, spanning X and ' +
      'with its thickness along Y. Outer size: (width + 2·pier_width) × thickness × height. Material slot 0 Stone.',
    shape: {
      width: z
        .number()
        .min(0.01)
        .max(1e4)
        .default(ARCH_DEFAULTS.width)
        .describe('Clear width of the opening in metres'),
      height: z.number().min(0.02).max(1e4).default(ARCH_DEFAULTS.height).describe('Total height in metres'),
      thickness: z
        .number()
        .min(0.001)
        .max(1e4)
        .default(ARCH_DEFAULTS.thickness)
        .describe('Depth of the arch along Y in metres'),
      pier_width: z
        .number()
        .min(0.001)
        .max(1e4)
        .default(ARCH_DEFAULTS.pier_width)
        .describe('Width of each pier beside the opening in metres'),
      crown: z
        .number()
        .min(0.001)
        .max(1e4)
        .default(ARCH_DEFAULTS.crown)
        .describe('Masonry above the top of the opening in metres (at most 90% of the height)'),
      style: z
        .enum(['ROUND', 'POINTED'])
        .default(ARCH_DEFAULTS.style)
        .describe('ROUND: semicircular arch; POINTED: two-centred gothic arch'),
      segments: z
        .number()
        .int()
        .min(4)
        .max(256)
        .default(ARCH_DEFAULTS.segments)
        .describe('Vertices along the curve of the opening'),
    },
    build: (p) => generateArch(p),
  });

  // ------------------------------------------------------------------ furniture & props
  generator(reg, {
    kind: 'table',
    label: 'Table',
    lower: 'the table parameters',
    description:
      'Generate a table standing on z = 0, centred on the origin: RECTANGLE (top, four legs, aprons) or ROUND ' +
      '(round top on a pedestal). Material slots: 0 Wood (top), 1 Wood Dark (legs and frame).',
    shape: {
      width: z
        .number()
        .min(0.05)
        .max(100)
        .default(TABLE_DEFAULTS.width)
        .describe('Size along X in metres (ROUND: diameter)'),
      depth: z
        .number()
        .min(0.05)
        .max(100)
        .default(TABLE_DEFAULTS.depth)
        .describe('Size along Y in metres (ignored for ROUND)'),
      height: z
        .number()
        .min(0.05)
        .max(100)
        .default(TABLE_DEFAULTS.height)
        .describe('Height of the top surface in metres'),
      top_thickness: z
        .number()
        .min(0.002)
        .max(50)
        .default(TABLE_DEFAULTS.top_thickness)
        .describe('Thickness of the top in metres'),
      leg_thickness: z
        .number()
        .min(0.005)
        .max(30)
        .default(TABLE_DEFAULTS.leg_thickness)
        .describe('Leg width in metres'),
      shape: z.enum(['RECTANGLE', 'ROUND']).default(TABLE_DEFAULTS.shape).describe('Table shape'),
    },
    build: (p) => generateTable(p),
  });

  generator(reg, {
    kind: 'chair',
    label: 'Chair',
    lower: 'the chair parameters',
    description:
      'Generate a chair standing on z = 0, centred on the origin and facing −Y (the backrest is on the +Y side): ' +
      'seat, four legs with side stretchers and a slatted or panel backrest. Material slots: 0 Wood (seat and ' +
      'backrest), 1 Wood Dark (frame).',
    shape: {
      width: z.number().min(0.05).max(100).default(CHAIR_DEFAULTS.width).describe('Size along X in metres'),
      depth: z.number().min(0.05).max(100).default(CHAIR_DEFAULTS.depth).describe('Size along Y in metres'),
      seat_height: z
        .number()
        .min(0.05)
        .max(100)
        .default(CHAIR_DEFAULTS.seat_height)
        .describe('Height of the top of the seat in metres'),
      back_height: z
        .number()
        .min(0)
        .max(100)
        .default(CHAIR_DEFAULTS.back_height)
        .describe('Height of the backrest above the seat in metres (0 = stool)'),
      seat_thickness: z
        .number()
        .min(0.005)
        .max(50)
        .default(CHAIR_DEFAULTS.seat_thickness)
        .describe('Seat thickness in metres'),
      leg_thickness: z
        .number()
        .min(0.005)
        .max(30)
        .default(CHAIR_DEFAULTS.leg_thickness)
        .describe('Leg width in metres'),
      back_style: z
        .enum(['SLATS', 'PANEL'])
        .default(CHAIR_DEFAULTS.back_style)
        .describe('SLATS: three horizontal slats; PANEL: one solid board'),
    },
    build: (p) => generateChair(p),
  });

  generator(reg, {
    kind: 'shelf',
    label: 'Shelf',
    lower: 'shelves',
    description:
      'Generate an open bookshelf standing on z = 0, centred on the origin and facing −Y: two side boards, ' +
      'evenly spaced shelves (including bottom and top), a plinth and an optional back panel. Material slots: ' +
      '0 Wood (shelves), 1 Wood Dark (sides, plinth and back).',
    shape: {
      width: z.number().min(0.05).max(100).default(SHELF_DEFAULTS.width).describe('Size along X in metres'),
      depth: z.number().min(0.02).max(100).default(SHELF_DEFAULTS.depth).describe('Size along Y in metres'),
      height: z.number().min(0.05).max(100).default(SHELF_DEFAULTS.height).describe('Height in metres'),
      shelves: z
        .number()
        .int()
        .min(2)
        .max(50)
        .default(SHELF_DEFAULTS.shelves)
        .describe('Number of horizontal boards including the bottom and the top one'),
      board_thickness: z
        .number()
        .min(0.002)
        .max(20)
        .default(SHELF_DEFAULTS.board_thickness)
        .describe('Board thickness in metres'),
      back_panel: z.boolean().default(SHELF_DEFAULTS.back_panel).describe('Close the back with a thin panel'),
    },
    build: (p) => generateShelf(p),
  });

  generator(reg, {
    kind: 'wheel',
    label: 'Wheel',
    lower: 'spokes or segments',
    description:
      'Generate a wheel (cylinder based): a rounded tyre around a rim band, hub and spokes (or a solid disc), ' +
      'centred on the origin with its axle along X (rolls along Y; set location z = radius to stand it on ' +
      'the ground). Material slots: 0 Rubber (tyre), 1 Metal (rim, hub, spokes).',
    shape: {
      radius: z
        .number()
        .min(0.01)
        .max(100)
        .default(WHEEL_DEFAULTS.radius)
        .describe('Outer radius of the tyre in metres'),
      width: z
        .number()
        .min(0.005)
        .max(100)
        .default(WHEEL_DEFAULTS.width)
        .describe('Width of the tyre along the axle in metres'),
      rim_radius: z
        .number()
        .min(0.002)
        .max(100)
        .default(WHEEL_DEFAULTS.rim_radius)
        .describe('Radius of the rim (inner edge of the tyre) in metres, 20%..97% of radius'),
      hub_radius: z
        .number()
        .min(0.001)
        .max(100)
        .default(WHEEL_DEFAULTS.hub_radius)
        .describe('Radius of the central hub in metres'),
      spokes: z
        .number()
        .int()
        .min(0)
        .max(64)
        .default(WHEEL_DEFAULTS.spokes)
        .describe('Number of spokes (0 = solid disc)'),
      segments: z
        .number()
        .int()
        .min(8)
        .max(256)
        .default(WHEEL_DEFAULTS.segments)
        .describe('Vertices around the wheel'),
    },
    build: (p) => generateWheel(p),
  });

  generator(reg, {
    kind: 'barrel',
    label: 'Barrel',
    lower: 'staves or hoops',
    description:
      'Generate a wooden barrel (cylinder based) standing on z = 0 with its axis on Z: bulging stave body with ' +
      'recessed heads and metal hoops. Material slots: 0 Barrel Wood (staves and heads), 1 Iron (hoops).',
    shape: {
      height: z.number().min(0.02).max(100).default(BARREL_DEFAULTS.height).describe('Height in metres'),
      radius: z
        .number()
        .min(0.01)
        .max(100)
        .default(BARREL_DEFAULTS.radius)
        .describe('Radius at the top and bottom in metres'),
      bulge: z
        .number()
        .min(0)
        .max(1)
        .default(BARREL_DEFAULTS.bulge)
        .describe('Extra radius at mid-height as a fraction of radius (0 = cylinder)'),
      hoops: z.number().int().min(0).max(20).default(BARREL_DEFAULTS.hoops).describe('Number of metal hoops'),
      staves: z
        .number()
        .int()
        .min(0)
        .max(128)
        .default(BARREL_DEFAULTS.staves)
        .describe('Number of wooden staves (relief grooves); 0 = smooth body'),
    },
    build: (p) => generateBarrel(p),
  });

  // ------------------------------------------------------------------ mechanical
  generator(reg, {
    kind: 'gear',
    label: 'Gear',
    lower: 'teeth',
    description:
      'Generate a spur gear lying in the XY plane, centred on the origin (z = ±thickness/2) with its axis on Z: ' +
      'trapezoidal teeth and an optional central bore hole. Material slot 0 Steel.',
    shape: {
      teeth: z.number().int().min(3).max(200).default(GEAR_DEFAULTS.teeth).describe('Number of teeth'),
      radius: z
        .number()
        .min(0.001)
        .max(1e4)
        .default(GEAR_DEFAULTS.radius)
        .describe('Outer (tip) radius in metres'),
      tooth_depth: z
        .number()
        .min(0)
        .max(1e4)
        .default(GEAR_DEFAULTS.tooth_depth)
        .describe('Radial tooth height in metres (tip radius − root radius; at most 60% of radius)'),
      thickness: z
        .number()
        .min(0.0001)
        .max(1e4)
        .default(GEAR_DEFAULTS.thickness)
        .describe('Thickness along the axis (Z) in metres'),
      bore: z
        .number()
        .min(0)
        .max(1e4)
        .default(GEAR_DEFAULTS.bore)
        .describe('Radius of the central bore hole in metres (0 = solid; at most 90% of the root radius)'),
    },
    build: (p) => generateGear(p),
  });

  generator(reg, {
    kind: 'spring',
    label: 'Spring',
    lower: 'turns, resolution (path samples per turn) or wire_segments',
    description:
      'Generate a helical coil spring: a round wire swept along a helix around the Z axis, standing on z = 0 ' +
      '(origin at the bottom centre), total height exactly `height`, with optionally closed (flat) end coils. ' +
      'Material slot 0 Steel.',
    shape: {
      coil_radius: z
        .number()
        .min(0.001)
        .max(1e4)
        .default(SPRING_DEFAULTS.coil_radius)
        .describe('Radius of the coil (axis to wire centre) in metres'),
      turns: z.number().min(0.25).max(500).default(SPRING_DEFAULTS.turns).describe('Number of turns'),
      height: z
        .number()
        .min(0)
        .max(1e4)
        .default(SPRING_DEFAULTS.height)
        .describe('Total height in metres (at least the wire diameter)'),
      wire_radius: z
        .number()
        .min(0.0001)
        .max(1e4)
        .default(SPRING_DEFAULTS.wire_radius)
        .describe('Radius of the wire in metres (at most 90% of coil_radius)'),
      wire_segments: z
        .number()
        .int()
        .min(3)
        .max(64)
        .default(SPRING_DEFAULTS.wire_segments)
        .describe('Vertices around the wire'),
      resolution: z
        .number()
        .int()
        .min(6)
        .max(256)
        .default(SPRING_DEFAULTS.resolution)
        .describe('Path samples per turn'),
      closed_ends: z
        .boolean()
        .default(SPRING_DEFAULTS.closed_ends)
        .describe('Flatten the last half turn at both ends (compression spring)'),
    },
    build: (p) => generateSpring(p),
  });

  generator(reg, {
    kind: 'pipe',
    label: 'Pipe',
    lower: 'the number of points, segments or bend_segments',
    description:
      'Generate a pipe: a circle of `radius` swept along a list of points (object space, relative to the object ' +
      'origin) with rounded bends (or sharp mitred corners), optional wall thickness (hollow) and closed ends. ' +
      'Material slot 0 Metal.',
    shape: {
      points: z
        .array(z.union([vec3, vec2]))
        .min(2)
        .max(10000)
        .default(PI.points)
        .describe(
          'Path points [x, y, z] (or [x, y]) in metres relative to the object origin; at least 2 distinct ' +
            'points (coincident points fail)',
        ),
      radius: z.number().min(0.0001).max(1000).default(PI.radius).describe('Outer radius in metres'),
      segments: z.number().int().min(3).max(128).default(PI.segments).describe('Vertices around the pipe'),
      bend_radius: z
        .number()
        .min(0)
        .max(1e4)
        .default(PI.bend_radius)
        .describe('Radius of the rounded bends at interior points in metres (0 = sharp mitred corners)'),
      bend_segments: z
        .number()
        .int()
        .min(1)
        .max(64)
        .default(PI.bend_segments)
        .describe('Segments per 90° of bend'),
      thickness: z
        .number()
        .min(0)
        .max(1000)
        .default(PI.thickness)
        .describe('Wall thickness of a hollow pipe in metres (0 = solid tube)'),
      closed_ends: z
        .boolean()
        .default(PI.closed_ends)
        .describe('Close the two open ends (caps for a solid tube, rings for a hollow pipe)'),
      cyclic: z
        .boolean()
        .default(PI.cyclic)
        .describe('Connect the last point back to the first (closed loop without ends; needs 3+ points)'),
    },
    build: (p) => generatePipe({ ...p, points: p.points.map((q): Vec3 => [q[0], q[1], q[2] ?? 0]) }),
  });

  // ------------------------------------------------------------------ organic (marching cubes)
  generator(reg, {
    kind: 'cloud',
    label: 'Cloud',
    lower: 'resolution',
    description:
      'Generate a puffy cumulus cloud: a smooth union of spheres (base layer plus smaller puffs heaped on top) ' +
      'meshed with marching cubes and stretched to exactly `size`, centred on the Z axis with its (optionally ' +
      'flat) base at z = 0. Material slot 0 Cloud.',
    shape: {
      size: vec3.default(CLOUD_DEFAULTS.size).describe('Exact dimensions [x, y, z] in metres'),
      puffs: z
        .number()
        .int()
        .min(1)
        .max(64)
        .default(CLOUD_DEFAULTS.puffs)
        .describe('Number of puffs (spheres)'),
      smoothness: z
        .number()
        .min(0)
        .max(2)
        .default(CLOUD_DEFAULTS.smoothness)
        .describe('How softly the puffs merge, as a fraction of the cloud height (0 = hard union)'),
      flat_bottom: z
        .boolean()
        .default(CLOUD_DEFAULTS.flat_bottom)
        .describe('Cut the underside flat (cumulus look)'),
      resolution: z
        .number()
        .int()
        .min(8)
        .max(160)
        .default(CLOUD_DEFAULTS.resolution)
        .describe('Marching-cubes cells along the longest side (higher = smoother, more faces)'),
      seed,
    },
    build: (p) => generateCloud({ ...p, size: p.size as Vec3 }),
  });

  generator(reg, {
    kind: 'blob',
    label: 'Blob',
    lower: 'resolution',
    description:
      'Generate an organic blob: the smooth union of spheres (metaball-like signed distance blend) meshed with ' +
      'marching cubes. Give explicit `spheres` (object space, kept as given) or let `count` random spheres fill ' +
      'a cube of `size` (centred on the origin). Material slot 0 Blob.',
    shape: {
      spheres: z
        .array(
          z.object({
            center: vec3.describe('Sphere centre in metres (object space)'),
            radius: z.number().positive().max(1e4).describe('Sphere radius in metres'),
          }),
        )
        .max(256)
        .nullable()
        .default(BLOB_DEFAULTS.spheres)
        .describe(
          'Explicit spheres; null or empty = random spheres from count/size/seed. The grid spans all ' +
            'spheres, so spheres much smaller than (their spread) / resolution are lost: such requests ' +
            'fail (no surface) or warn',
        ),
      count: z
        .number()
        .int()
        .min(1)
        .max(64)
        .default(BLOB_DEFAULTS.count)
        .describe('Number of random spheres'),
      size: z
        .number()
        .min(0.01)
        .max(1000)
        .default(BLOB_DEFAULTS.size)
        .describe('Size of the cube the random spheres are placed in, in metres'),
      smoothness: z
        .number()
        .min(0)
        .max(100)
        .default(BLOB_DEFAULTS.smoothness)
        .describe('Blend distance in metres: how softly the spheres merge (0 = hard union)'),
      resolution: z
        .number()
        .int()
        .min(8)
        .max(160)
        .default(BLOB_DEFAULTS.resolution)
        .describe('Marching-cubes cells along the longest side (higher = smoother, more faces)'),
      seed,
    },
    build: (p) =>
      generateBlob({
        ...p,
        spheres: p.spheres?.map((s) => ({ center: s.center as Vec3, radius: s.radius })) ?? null,
      }),
  });
}
