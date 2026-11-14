import { z } from 'zod';
import type { Vec2, Vec3 } from '../../math/types';
import { MeshBuilder, addBlade, smoothstep } from '../../generate/builder';
import { MATERIALS } from '../../generate/types';
import {
  generateBush,
  generateFlower,
  generateGrassTuft,
  generateTree,
  treeMaterials,
  type TreeParams,
} from '../../generate/vegetation';
import { generateRock } from '../../generate/terrain';
import { GradientNoise } from '../../generate/noise';
import { Rng } from '../../generate/random';
import type { CatalogEntry } from '../types';
import {
  MAT,
  appendGenerated,
  box,
  cylinder,
  defineModel,
  fromGenerated,
  heightField,
  material,
  procSlot,
  radialSurface,
  sphere,
  tube,
  xf,
  type Model,
  type ModelMaterial,
} from './architecture';

/*
 * Built-in nature models (CATALOG-B): trees, bushes, rocks, grass and flowers from the procedural
 * generators, terrain pieces (hill, mountain backdrop, sand dune, sand patch) and water. Water
 * surfaces are parts named `water` (flat, z ≈ 0.02 above the base so they never z-fight a ground
 * plane at z = 0); the director's desk treats them as passable.
 */

const seedParam = z.number().int().min(0).max(9999).default(0).describe('Variation (random layout seed)');

/** A tree from the generator; the main colour tints the foliage. */
function treePart(
  m: Model,
  part: string,
  params: Partial<TreeParams> & { style: TreeParams['style'] },
): void {
  const res = generateTree(params);
  const [bark, foliage] = treeMaterials(params.style).map(fromGenerated);
  m.part(part, res.mesh, [bark, m.main(foliage)]);
}

const oakTree = defineModel({
  id: 'oak_tree',
  name: 'Oak Tree',
  category: 'nature',
  tags: ['tree', 'deciduous', 'park', 'forest', 'woods', 'shade', 'countryside'],
  synonyms: ['tree', 'oak', 'broadleaf tree', 'deciduous tree', 'shade tree', 'maple', 'elm'],
  description: 'Broad deciduous tree, 7 m tall, with a rounded leafy crown on branching limbs.',
  dimensions_m: [5.041, 5.655, 7],
  triangles: 3280,
  anchor: 'origin',
  params: z.object({ seed: seedParam }),
  build(m, p) {
    treePart(m, 'tree', {
      style: 'DECIDUOUS',
      height: 7,
      branch_levels: 2,
      branches: 3,
      trunk_radius: 0.24,
      seed: p.seed,
    });
  },
});

const pineTree = defineModel({
  id: 'pine_tree',
  name: 'Pine Tree',
  category: 'nature',
  tags: ['tree', 'conifer', 'evergreen', 'forest', 'mountain', 'christmas tree'],
  synonyms: ['pine', 'fir', 'spruce', 'conifer', 'evergreen', 'fir tree', 'christmas tree'],
  description: 'Tall conifer, 9 m, with tiers of dark needle foliage tapering to a point.',
  dimensions_m: [3.945, 3.828, 9],
  triangles: 896,
  anchor: 'origin',
  params: z.object({ seed: seedParam }),
  build(m, p) {
    treePart(m, 'tree', { style: 'CONIFER', height: 9, trunk_radius: 0.22, branch_levels: 4, seed: p.seed });
  },
});

const palmTree = defineModel({
  id: 'palm_tree',
  name: 'Palm Tree',
  category: 'nature',
  tags: ['tree', 'palm', 'tropical', 'beach', 'island', 'coconut'],
  synonyms: ['palm', 'coconut palm', 'coconut tree', 'tropical tree', 'date palm'],
  description: 'Tropical palm, 8 m, a gently curved trunk under a crown of drooping fronds.',
  dimensions_m: [6.346, 6.211, 8],
  triangles: 2580,
  anchor: 'origin',
  params: z.object({ seed: seedParam }),
  build(m, p) {
    treePart(m, 'tree', { style: 'PALM', height: 8, branches: 3, seed: p.seed });
  },
});

const bush = defineModel({
  id: 'bush',
  name: 'Bush',
  category: 'nature',
  tags: ['bush', 'shrub', 'hedge', 'garden', 'park', 'plant'],
  synonyms: ['shrub', 'hedge', 'shrubbery', 'thicket', 'plant'],
  description: 'Rounded leafy bush, 1.2 m across and 0.9 m high.',
  dimensions_m: [1.047, 1.119, 0.9],
  triangles: 2240,
  params: z.object({ seed: seedParam }),
  build(m, p) {
    const res = generateBush({ size: 1.2, height: 0.9, density: 0.55, seed: p.seed });
    m.part('bush', res.mesh, [fromGenerated(MATERIALS.bark), m.main(fromGenerated(MATERIALS.leaves))]);
  },
});

const rock = defineModel({
  id: 'rock',
  name: 'Rock',
  category: 'nature',
  tags: ['rock', 'stone', 'pebble', 'ground', 'river'],
  synonyms: ['stone', 'small rock', 'pebble', 'cobble'],
  description: 'Small faceted grey rock, about 0.6 m long, flat underneath.',
  dimensions_m: [0.611, 0.506, 0.258],
  triangles: 320,
  params: z.object({ seed: seedParam }),
  build(m, p) {
    const res = generateRock({ size: [0.6, 0.5, 0.4], detail: 3, facets: 4, seed: p.seed });
    m.part('rock', res.mesh, [m.main(fromGenerated(MATERIALS.rock))]);
  },
});

const boulder = defineModel({
  id: 'boulder',
  name: 'Boulder',
  category: 'nature',
  tags: ['rock', 'boulder', 'stone', 'mountain', 'landmark', 'big rock'],
  synonyms: ['big rock', 'large rock', 'boulder stone', 'crag', 'rock'],
  description: 'Large weathered boulder, about 2.2 m long and 1.5 m high, flat underneath.',
  dimensions_m: [2.357, 1.372, 1.067],
  triangles: 1280,
  params: z.object({ seed: seedParam }),
  build(m, p) {
    const res = generateRock({
      size: [2.2, 1.8, 1.5],
      detail: 4,
      roughness: 0.6,
      facets: 6,
      seed: p.seed + 7,
    });
    m.part('boulder', res.mesh, [m.main(material('Boulder Rock', '#7a766f', 0.88))]);
  },
});

const grassTuft = defineModel({
  id: 'grass_tuft',
  name: 'Grass Tuft',
  category: 'nature',
  tags: ['grass', 'tuft', 'lawn', 'meadow', 'plant', 'ground cover'],
  synonyms: ['grass', 'tussock', 'grass clump', 'tuft of grass', 'weeds'],
  description: 'Clump of arching grass blades, about 0.4 m high.',
  dimensions_m: [0.468, 0.509, 0.344],
  triangles: 1140,
  params: z.object({ seed: seedParam }),
  build(m, p) {
    const res = generateGrassTuft({ blades: 30, height: 0.4, spread: 0.12, seed: p.seed });
    m.part('grass', res.mesh, [m.main(fromGenerated(MATERIALS.grass))]);
  },
});

const FLOWER_COLOURS = ['#d8344a', '#f2c230', '#8e4fc9', '#f4f1ea', '#f07fb0', '#e8762c'];

const flowerBed = defineModel({
  id: 'flower_bed',
  name: 'Flower Bed',
  category: 'nature',
  tags: ['flowers', 'garden', 'bed', 'planter', 'park', 'spring', 'blossom'],
  synonyms: ['flowers', 'flowerbed', 'garden bed', 'planter', 'flower patch', 'raised bed', 'tulips'],
  description:
    'Raised timber-edged garden bed with soil, leafy clumps and colourful flowers (the main colour paints every bloom).',
  dimensions_m: [1.692, 0.7, 0.663],
  triangles: 3604,
  params: z.object({ seed: seedParam }),
  build(m, p) {
    const b = new MeshBuilder();
    const L = 1.6;
    const D = 0.7;
    const h = 0.22;
    const t = 0.05;
    // timber edging boards around the soil
    box(b, [-L / 2, -D / 2, 0], [L / 2, -D / 2 + t, h], 0);
    box(b, [-L / 2, D / 2 - t, 0], [L / 2, D / 2, h], 0);
    box(b, [-L / 2, -D / 2 + t, 0], [-L / 2 + t, D / 2 - t, h], 0);
    box(b, [L / 2 - t, -D / 2 + t, 0], [L / 2, D / 2 - t, h], 0);
    box(b, [-L / 2 + t, -D / 2 + t, 0], [L / 2 - t, D / 2 - t, h - 0.02], 1);
    const rng = new Rng(p.seed, 0xf10b);
    // leafy clumps at the soil
    for (let i = 0; i < 6; i++) sphere(b, [-0.65 + i * 0.26, rng.spread(0.18), h], [0.13, 0.11, 0.09], 1, 2);
    // the main colour paints every bloom
    const petals: ModelMaterial[] = m.color
      ? [m.main(material(`Petals ${m.color}`, m.color, 0.5))]
      : FLOWER_COLOURS.map((c) => material(`Petals ${c}`, c, 0.5));
    let k = 0;
    for (let row = 0; row < 2; row++)
      for (let i = 0; i < 4; i++) {
        const res = generateFlower({
          height: rng.range(0.38, 0.48),
          petals: 6,
          leaves: 1,
          seed: p.seed * 31 + k,
        });
        const pos: Vec3 = [
          -0.58 + i * 0.38 + (row ? 0.19 : 0) + rng.spread(0.05),
          (row ? 0.15 : -0.15) + rng.spread(0.04),
          h - 0.01,
        ];
        appendGenerated(b, res, [3, 5 + (k % petals.length), 4], xf(pos, [0, 0, rng.range(0, Math.PI * 2)]));
        k++;
      }
    m.part('flower_bed', b, [
      MAT.woodDark,
      MAT.soil,
      fromGenerated(MATERIALS.leaves),
      fromGenerated(MATERIALS.stem),
      fromGenerated(MATERIALS.flowerCenter),
      ...petals,
    ]);
  },
});

const hill = defineModel({
  id: 'hill',
  name: 'Hill',
  category: 'nature',
  tags: ['hill', 'mound', 'terrain', 'grass', 'landscape', 'landmark', 'meadow'],
  synonyms: ['mound', 'knoll', 'hillock', 'grassy hill', 'rise', 'slope'],
  description: 'Smooth grassy mound, 14 m across and 2.5 m high, edges flush with the ground.',
  dimensions_m: [14, 14, 2.5],
  triangles: 736,
  params: z.object({
    diameter: z.number().min(2).max(200).default(14).describe('Diameter in metres'),
    height: z.number().min(0.2).max(100).default(2.5).describe('Height in metres'),
  }),
  build(m, p) {
    const b = new MeshBuilder();
    const R = p.diameter / 2;
    const rings: Vec2[] = [];
    for (let i = 0; i <= 12; i++) {
      const r = (R * i) / 12;
      rings.push([r, (p.height * (1 + Math.cos((Math.PI * r) / R))) / 2]);
    }
    radialSurface(b, rings, 32, 0);
    m.part('hill', b, [m.main(material('Hill Grass', '#5f8a3a', 0.85))]);
  },
});

const mountains = defineModel({
  id: 'mountain_backdrop',
  name: 'Mountain Backdrop',
  category: 'nature',
  tags: ['mountain', 'mountains', 'range', 'backdrop', 'landscape', 'snow', 'alps', 'peaks'],
  synonyms: ['mountains', 'mountain range', 'peaks', 'alps', 'hills backdrop', 'massif'],
  description:
    'Distant mountain range backdrop, 60 m wide and 18 m high: forested foothills, grey rock and snow caps; place it far behind the set.',
  dimensions_m: [60, 16, 17.222],
  triangles: 1344,
  params: z.object({ seed: seedParam }),
  build(m, p) {
    const b = new MeshBuilder();
    const noise = new GradientNoise(p.seed + 11);
    const rng = new Rng(p.seed, 0x3017);
    const peaks = [
      { x: -18, h: 13 },
      { x: -5, h: 18 },
      { x: 9, h: 15 },
      { x: 22, h: 10.5 },
    ].map((q) => ({ x: q.x + rng.spread(1.5), h: q.h * rng.range(0.92, 1.0), w: rng.range(7, 9.5) }));
    const H = 18;
    const ridgeY = 2;
    const height = (x: number, y: number) => {
      let ridge = 0;
      for (const q of peaks) ridge = Math.max(ridge, q.h * Math.exp(-(((x - q.x) / q.w) ** 2)));
      ridge = Math.max(ridge, 3.5 * smoothstep(30, 18, Math.abs(x)));
      const half = y > ridgeY ? 6 : 10;
      const g = Math.max(0, 1 - ((y - ridgeY) / half) ** 2);
      const rough = 0.78 + 0.32 * noise.fractal(x / 6, y / 6, 0.5, { octaves: 4, type: 'RIDGED' });
      return Math.max(
        0,
        ridge * g * rough * smoothstep(30, 26.5, Math.abs(x)) * smoothstep(8, 6.8, Math.abs(y - 0)),
      );
    };
    heightField(b, 48, 14, [-30, 30], [-8, 8], height, (_x, _y, zz, nz) =>
      zz > 0.62 * H && nz > 0.45 ? 2 : zz > 0.18 * H || nz < 0.55 ? 1 : 0,
    );
    m.part('mountains', b, [
      material('Foothill Forest', '#4c6a35', 0.9),
      m.main(material('Mountain Rock', '#7d7a75', 0.9)),
      material('Snow Cap', '#eef1f5', 0.55),
    ]);
  },
});

/** Calm water ripples: a gentle procedural bump on the water surface. */
function waterMaterial(name: string, hex: string): ModelMaterial {
  return {
    name,
    color: hex,
    roughness: 0.1,
    coat: 0.6,
    textures: {
      normal: procSlot('NOISE', {
        scale: 1.5,
        detail: 2,
        color_a: [0, 0, 0, 1],
        color_b: [1, 1, 1, 1],
        params: { bump_distance: 0.01 },
      }),
    },
  };
}

/** Point at angle a on an ellipse (radii rx, ry), moved `off` metres along its outward normal. */
function ellipseOffset(rx: number, ry: number) {
  return (a: number, off: number): Vec2 => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const nx = c / rx;
    const ny = s / ry;
    const l = Math.hypot(nx, ny) || 1;
    return [rx * c + (off * nx) / l, ry * s + (off * ny) / l];
  };
}

const lake = defineModel({
  id: 'lake',
  name: 'Lake',
  category: 'nature',
  tags: ['water', 'lake', 'pond', 'landmark', 'swimming', 'shore'],
  synonyms: ['pond', 'pool', 'water', 'loch', 'lagoon', 'mere', 'swimming lake'],
  description:
    'Lake: a flat elliptical water surface (part `water`, z 0.02, blue and semi-glossy) inside a soft sloping shore ring (part `shore`) that blends into the ground at z = 0.',
  dimensions_m: [13.2, 10.2, 0.06],
  triangles: 432,
  params: z.object({
    width: z.number().min(1).max(500).default(10).describe('Water width along X in metres'),
    depth: z.number().min(1).max(500).default(7).describe('Water depth along Y in metres'),
  }),
  build(m, p) {
    const rx = p.width / 2;
    const ry = p.depth / 2;
    const n = 48;
    const water = new MeshBuilder();
    radialSurface(
      water,
      [
        [0, 0.02],
        [1, 0.02],
      ],
      n,
      0,
      { scale: [rx, ry], smooth: false },
    );
    m.part('water', water, [m.main(waterMaterial('Lake Water', '#2f6fa3'))]);
    const shore = new MeshBuilder();
    // under the water edge, a low bank just outside it, then down to the ground
    radialSurface(
      shore,
      [
        [-0.35, 0],
        [0.05, 0.05],
        [0.45, 0.06],
        [1.0, 0.03],
        [1.6, 0],
      ],
      n,
      0,
      { point: ellipseOffset(rx, ry) },
    );
    m.part('shore', shore, [material('Lake Shore', '#8f7f5f', 0.95)]);
  },
});

const sea = defineModel({
  id: 'sea',
  name: 'Sea',
  category: 'nature',
  tags: ['water', 'sea', 'ocean', 'beach', 'coast', 'landmark', 'waves'],
  synonyms: ['ocean', 'sea water', 'water', 'bay', 'surf', 'seawater'],
  description:
    'Sea surface, 40 × 30 m: a gently undulating deep-blue water plane (part `water`, 0.02 m above the base on average).',
  dimensions_m: [40, 30, 0.04],
  triangles: 1200,
  params: z.object({
    width: z.number().min(2).max(2000).default(40).describe('Width along X in metres'),
    depth: z.number().min(2).max(2000).default(30).describe('Depth along Y in metres'),
  }),
  build(m, p) {
    const b = new MeshBuilder();
    const nx = Math.max(4, Math.min(60, Math.round(p.width / 1.33)));
    const ny = Math.max(4, Math.min(40, Math.round(p.depth / 1.5)));
    heightField(
      b,
      nx,
      ny,
      [-p.width / 2, p.width / 2],
      [-p.depth / 2, p.depth / 2],
      (x, y) => 0.02 + 0.02 * Math.sin(x * 0.9 + y * 0.35) * Math.cos(y * 0.7 - x * 0.2),
    );
    m.part('water', b, [m.main(waterMaterial('Sea Water', '#1f5f8f'))]);
  },
});

const sandDune = defineModel({
  id: 'sand_dune',
  name: 'Sand Dune',
  category: 'nature',
  tags: ['sand', 'dune', 'desert', 'beach', 'terrain', 'landscape'],
  synonyms: ['dune', 'sandhill', 'desert dune', 'sand hill', 'barchan'],
  description:
    'Crescent sand dune, 10 × 7 m and 1.6 m high: a gentle windward slope facing −Y and a steep lee face towards +Y.',
  dimensions_m: [10, 7, 1.596],
  triangles: 1536,
  build(m) {
    const b = new MeshBuilder();
    const H = 1.6;
    const height = (x: number, y: number) => {
      const yc = 1.0 - 0.09 * x * x;
      const t = y - yc;
      const prof = t < 0 ? Math.exp(-((t / 2.6) ** 2)) : Math.max(0, 1 - t / 1.1) ** 1.3;
      const w = Math.max(0, 1 - (x / 5) ** 2) ** 0.8;
      return Math.max(0, H * prof * w * smoothstep(3.5, 2.6, Math.abs(y)) * smoothstep(5, 4.4, Math.abs(x)));
    };
    heightField(b, 32, 24, [-5, 5], [-3.5, 3.5], height);
    m.part('dune', b, [m.main(MAT.sand)]);
  },
});

const sandPatch = defineModel({
  id: 'sand_patch',
  name: 'Sand Patch',
  category: 'nature',
  tags: ['sand', 'beach', 'ground', 'shore', 'terrain', 'landmark'],
  synonyms: ['beach', 'sand', 'sandy ground', 'beach sand', 'sandpit', 'shore'],
  description:
    'Patch of beach sand, 10 × 6 m, a few centimetres high with soft edges that blend into the ground.',
  dimensions_m: [10, 6, 0.054],
  triangles: 768,
  params: z.object({
    width: z.number().min(1).max(500).default(10).describe('Width along X in metres'),
    depth: z.number().min(1).max(500).default(6).describe('Depth along Y in metres'),
    seed: seedParam,
  }),
  build(m, p) {
    const b = new MeshBuilder();
    const noise = new GradientNoise(p.seed + 3);
    const hw = p.width / 2;
    const hd = p.depth / 2;
    const edge = Math.min(0.8, hw / 3, hd / 3);
    const height = (x: number, y: number) => {
      const e = smoothstep(0, edge, Math.min(hw - Math.abs(x), hd - Math.abs(y)));
      return e * (0.045 + 0.015 * noise.fractal(x / 2.5, y / 2.5, 0.3, { octaves: 2 }));
    };
    heightField(b, 32, 12, [-hw, hw], [-hd, hd], height);
    m.part('sand', b, [m.main(MAT.sand)]);
  },
});

const log = defineModel({
  id: 'log',
  name: 'Log',
  category: 'nature',
  tags: ['log', 'wood', 'fallen tree', 'forest', 'campfire', 'timber'],
  synonyms: ['fallen log', 'tree trunk', 'timber', 'firewood log', 'trunk'],
  description:
    'Fallen log lying along X, 2.4 m long, bark sides and pale sawn ends, with two broken branch stubs.',
  dimensions_m: [2.4, 0.516, 0.438],
  triangles: 100,
  build(m) {
    const b = new MeshBuilder();
    const r = 0.21;
    cylinder(b, [-1.2, 0, r], [1.2, 0, r], r, 16, 0, { r1: r * 0.88, capMat: 1 });
    cylinder(b, [-0.3, 0.05, r + 0.1], [-0.05, 0.22, r + 0.2], 0.05, 6, 0, { r1: 0.03, capMat: 1 });
    cylinder(b, [0.55, -0.08, r + 0.05], [0.75, -0.25, r + 0.1], 0.045, 6, 0, { r1: 0.03, capMat: 1 });
    m.part('log', b, [m.main(fromGenerated(MATERIALS.bark)), material('Log End', '#c9a679', 0.8)]);
  },
});

const stump = defineModel({
  id: 'tree_stump',
  name: 'Tree Stump',
  category: 'nature',
  tags: ['stump', 'tree', 'wood', 'forest', 'seat', 'chopping'],
  synonyms: ['stump', 'tree trunk', 'chopping block', 'cut tree', 'stub'],
  description: 'Sawn tree stump, 0.45 m high, with flared roots and a pale cut top.',
  dimensions_m: [1.163, 1.114, 0.455],
  triangles: 272,
  build(m) {
    const b = new MeshBuilder();
    const top = 0.45;
    radialSurface(
      b,
      [
        [0.42, 0],
        [0.33, 0.1],
        [0.3, 0.25],
        [0.29, top],
      ],
      16,
      0,
    );
    radialSurface(
      b,
      [
        [0, top + 0.005],
        [0.29, top + 0.005],
      ],
      16,
      1,
      { smooth: false },
    );
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      const c = Math.cos(a);
      const s = Math.sin(a);
      tube(
        b,
        [
          [0.22 * c, 0.22 * s, 0.14],
          [0.42 * c, 0.42 * s, 0.07],
          [0.6 * c, 0.6 * s, 0.03],
        ],
        (k) => [0.08, 0.06, 0.03][k],
        6,
        0,
      );
    }
    m.part('stump', b, [m.main(fromGenerated(MATERIALS.bark)), material('Log End', '#c9a679', 0.8)]);
  },
});

const reeds = defineModel({
  id: 'reeds',
  name: 'Reeds',
  category: 'nature',
  tags: ['reeds', 'water', 'pond', 'marsh', 'river', 'bulrush', 'cattail', 'plants'],
  synonyms: ['bulrushes', 'cattails', 'rushes', 'reed bed', 'marsh grass', 'sedge'],
  description:
    'Clump of tall reeds with a few brown cattail heads, about 1.8 m high, for pond and river edges.',
  dimensions_m: [1.178, 0.998, 1.781],
  triangles: 1192,
  params: z.object({ seed: seedParam }),
  build(m, p) {
    const b = new MeshBuilder();
    const rng = new Rng(p.seed, 0x4eed);
    for (let i = 0; i < 24; i++) {
      const ra = 0.22 * Math.sqrt(rng.next());
      const ta = rng.range(0, Math.PI * 2);
      const base: Vec3 = [ra * Math.cos(ta), ra * Math.sin(ta), 0];
      const out: Vec3 = [Math.cos(ta + rng.spread(0.5)), Math.sin(ta + rng.spread(0.5)), 0];
      const h = rng.range(1.1, 1.7);
      const lean = rng.range(0.05, 0.3);
      const spine: Vec3[] = [];
      for (let s = 0; s <= 5; s++) {
        const t = s / 5;
        spine.push([base[0] + out[0] * h * lean * t * t, base[1] + out[1] * h * lean * t * t, h * t]);
      }
      const widths = spine.map((_, s) => (s === 5 ? 0 : 0.03 * (1 - s / 6)));
      addBlade(
        b,
        spine,
        widths,
        widths.map((w) => w * 0.3),
        spine.map(() => out),
        { mat: 0, smooth: true },
      );
    }
    for (let i = 0; i < 7; i++) {
      const ta = rng.range(0, Math.PI * 2);
      const ra = 0.15 * Math.sqrt(rng.next());
      const h = rng.range(1.35, 1.65);
      const x = ra * Math.cos(ta);
      const y = ra * Math.sin(ta);
      const dx = 0.06 * Math.cos(ta);
      const dy = 0.06 * Math.sin(ta);
      cylinder(b, [x, y, 0], [x + dx, y + dy, h + 0.18], 0.006, 4, 0);
      cylinder(
        b,
        [x + dx * 0.85, y + dy * 0.85, h - 0.04],
        [x + dx * 0.95, y + dy * 0.95, h + 0.12],
        0.024,
        8,
        1,
      );
    }
    m.part('reeds', b, [
      m.main(material('Reed Green', '#6f8f3c', 0.7)),
      material('Cattail Brown', '#5a3a22', 0.85),
    ]);
  },
});

/** Built-in nature models. */
export const NATURE_MODELS: CatalogEntry[] = [
  oakTree,
  pineTree,
  palmTree,
  bush,
  rock,
  boulder,
  grassTuft,
  flowerBed,
  hill,
  mountains,
  lake,
  sea,
  sandDune,
  sandPatch,
  log,
  stump,
  reeds,
];
