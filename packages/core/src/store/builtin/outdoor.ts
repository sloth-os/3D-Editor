import { z } from 'zod';
import type { Vec2, Vec3 } from '../../math/types';
import { MeshBuilder, addBoxBetween } from '../../generate/builder';
import { MATERIALS } from '../../generate/types';
import { GradientNoise } from '../../generate/noise';
import type { CatalogEntry } from '../types';
import {
  MAT,
  at,
  beam,
  block,
  box,
  cylinder,
  defineModel,
  extrude,
  floorAt,
  fromGenerated,
  gableRoof,
  heightField,
  lathe,
  material,
  procSlot,
  radialSurface,
  roundedRect,
  sphere,
  tube,
  type ModelMaterial,
} from './architecture';

/*
 * Built-in outdoor models (CATALOG-B): beach, camping, farm and playground items. Swings hang from
 * their pivot (parts `swing.1`, `swing.2` rotate about X to swing); flames are a separate part
 * (`fire`) so they can be hidden; water surfaces are parts named `water`.
 */

/** Straw: hay colour with soft streaks (a low-frequency texture that does not alias in wide shots). */
function hayMaterial(name: string, hex: string): ModelMaterial {
  return {
    name,
    color: hex,
    roughness: 0.92,
    textures: {
      base_color: procSlot('NOISE', {
        scale: 5,
        detail: 3,
        color_a: [0.45, 0.24, 0.03, 1],
        color_b: [0.78, 0.5, 0.09, 1],
      }),
    },
  };
}

const HAY = hayMaterial('Hay Straw', '#d8b54a');
const TWINE = material('Twine', '#6b5a3a', 0.9);
const PLAY_FRAME = material('Playground Blue', '#2e6fb5', 0.45, { metallic: 0.5 });

const beachUmbrella = defineModel({
  id: 'beach_umbrella',
  name: 'Beach Umbrella',
  category: 'props',
  tags: ['beach', 'umbrella', 'parasol', 'sun', 'summer', 'shade', 'seaside'],
  synonyms: ['parasol', 'sun umbrella', 'sunshade', 'beach parasol', 'patio umbrella'],
  description:
    'Beach parasol, 2.25 m tall: an eight-panel striped canopy 2 m across on a pole with a weighted base.',
  dimensions_m: [1.858, 1.858, 2.25],
  triangles: 200,
  build(m) {
    const b = new MeshBuilder();
    cylinder(b, [0, 0, 0], [0, 0, 0.05], 0.22, 16, 2);
    cylinder(b, [0, 0, 0.05], [0, 0, 2.25], 0.02, 8, 0);
    const R = 1.0;
    const rim = 1.93;
    const apex = b.vert([0, 0, 2.22]);
    const under = b.vert([0, 0, 2.17]);
    const n = 8;
    const ring: number[] = [];
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      const p: Vec3 = [R * Math.cos(a), R * Math.sin(a), rim];
      pts.push(p);
      ring.push(b.vert(p));
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mat = i % 2 ? 1 : 3;
      b.face([apex, ring[i], ring[j]], mat);
      b.face([under, ring[j], ring[i]], mat);
      // scalloped valance hanging from the rim
      const p0 = pts[i];
      const p1 = pts[j];
      addBoxBetween(b, [p0[0], p0[1], rim - 0.06], [p1[0], p1[1], rim - 0.06], 0.01, 0.12, [0, 0, 1], {
        mat,
      });
    }
    m.part('umbrella', b, [
      MAT.white,
      m.main(material('Parasol Red', '#d64541', 0.7)),
      MAT.concrete,
      MAT.white,
    ]);
  },
});

const beachLounger = defineModel({
  id: 'beach_lounger',
  name: 'Beach Lounger',
  category: 'furniture',
  tags: ['beach', 'lounger', 'sunbed', 'deck chair', 'pool', 'summer', 'relax'],
  synonyms: ['sun lounger', 'sunbed', 'deck chair', 'chaise longue', 'lounge chair', 'pool lounger'],
  description:
    'Sun lounger, 2 m long along Y: a white frame with a padded bed and the backrest raised at the head end (+Y).',
  dimensions_m: [0.636, 1.841, 0.838],
  triangles: 276,
  build(m) {
    const b = new MeshBuilder();
    for (const x of [-0.3, 0.3]) {
      cylinder(b, [x, -0.95, 0.3], [x, 0.42, 0.3], 0.018, 8, 0);
      cylinder(b, [x, 0.42, 0.3], [x, 0.86, 0.78], 0.018, 8, 0);
      for (const y of [-0.85, 0.35]) cylinder(b, [x, y, 0], [x, y, 0.3], 0.018, 8, 0);
    }
    cylinder(b, [-0.3, -0.95, 0.3], [0.3, -0.95, 0.3], 0.018, 8, 0);
    box(b, [-0.29, -0.94, 0.31], [0.29, 0.42, 0.37], 1);
    const n: Vec3 = [0, -Math.sin(47 * (Math.PI / 180)), Math.cos(47 * (Math.PI / 180))];
    addBoxBetween(
      b,
      [0, 0.42 + n[1] * 0.04, 0.34 + n[2] * 0.04],
      [0, 0.84 + n[1] * 0.04, 0.79 + n[2] * 0.04],
      0.58,
      0.06,
      n,
      { mat: 1 },
    );
    m.part('lounger', b, [MAT.white, m.main(material('Lounger Cushion', '#2a7fb8', 0.85, { sheen: 0.3 }))]);
  },
});

const tent = defineModel({
  id: 'tent',
  name: 'Tent',
  category: 'props',
  tags: ['tent', 'camping', 'campsite', 'outdoor', 'shelter', 'festival'],
  synonyms: ['camping tent', 'ridge tent', 'pup tent', 'a-frame tent', 'shelter'],
  description:
    'Two-person ridge tent, 2.2 m long along Y, with its open door at the front (−Y), poles, guy ropes and a ground sheet.',
  dimensions_m: [1.7, 3.424, 1.3],
  triangles: 144,
  build(m) {
    const b = new MeshBuilder();
    const D = 2.2;
    box(b, [-0.85, -D / 2 - 0.05, 0], [0.85, D / 2 + 0.05, 0.01], 2);
    extrude(
      b,
      [
        [-0.8, 0.01],
        [0.8, 0.01],
        [0, 1.2],
      ],
      'y',
      -D / 2,
      D / 2,
      0,
    );
    // open door: a dark triangle in front, the rolled flap at its side
    extrude(
      b,
      [
        [-0.46, 0.01],
        [0.46, 0.01],
        [0, 0.92],
      ],
      'y',
      -D / 2 - 0.012,
      -D / 2,
      3,
    );
    cylinder(b, [-0.55, -D / 2 - 0.05, 0.05], [-0.25, -D / 2 - 0.05, 0.62], 0.05, 8, 0);
    for (const y of [-D / 2 - 0.02, D / 2 + 0.02]) cylinder(b, [0, y, 0], [0, y, 1.3], 0.015, 6, 1);
    for (const s of [-1, 1]) {
      const y0 = s * (D / 2 + 0.02);
      tube(
        b,
        [
          [0, y0, 1.27],
          [0, s * (D / 2 + 0.6), 0.02],
        ],
        0.006,
        4,
        4,
      );
      cylinder(b, [0, s * (D / 2 + 0.6), 0], [0, s * (D / 2 + 0.6), 0.06], 0.012, 4, 1);
    }
    m.part('tent', b, [
      m.main(material('Tent Fabric', '#d9822b', 0.85, { sheen: 0.3 })),
      MAT.darkMetal,
      material('Ground Sheet', '#2f4a32', 0.9),
      material('Tent Inside', '#2a2622', 0.95),
      material('Guy Rope', '#e8e0c8', 0.8),
    ]);
  },
});

const campfire = defineModel({
  id: 'campfire',
  name: 'Campfire',
  category: 'props',
  tags: ['campfire', 'fire', 'camping', 'flames', 'logs', 'stones', 'night', 'bonfire'],
  synonyms: ['bonfire', 'fire pit', 'camp fire', 'fireplace', 'fire', 'firepit'],
  description:
    'Campfire: a ring of stones around a teepee of logs with glowing embers and flames (part `fire`, emissive).',
  dimensions_m: [0.999, 1.009, 0.61],
  triangles: 620,
  // stones, wood and flames in their own colours
  color: false,
  params: z.object({ lit: z.boolean().default(true).describe('Flames and embers (false: unlit logs)') }),
  build(m, p) {
    const stones = new MeshBuilder();
    const noise = new GradientNoise(41);
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2;
      sphere(stones, [0.43 * Math.cos(a), 0.43 * Math.sin(a), 0.045], [0.1, 0.085, 0.07], 1, 0, {
        smooth: false,
        displace: (d) => 1 + 0.25 * noise.noise3(d[0] * 2 + i, d[1] * 2, d[2] * 2),
        matrix: at(0, 0, 0, a),
      });
    }
    floorAt(stones);
    m.part('stones', stones, [fromGenerated(MATERIALS.rock)]);
    const logs = new MeshBuilder();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      cylinder(
        logs,
        [0.3 * Math.cos(a), 0.3 * Math.sin(a), 0.04],
        [0.04 * Math.cos(a), 0.04 * Math.sin(a), 0.42],
        0.045,
        7,
        0,
        { capMat: 1 },
      );
    }
    m.part('logs', logs, [fromGenerated(MATERIALS.bark), material('Charred Wood', '#2a1d16', 0.9)]);
    if (p.lit) {
      const fire = new MeshBuilder();
      radialSurface(
        fire,
        [
          [0, 0.025],
          [0.24, 0.02],
        ],
        16,
        2,
        { smooth: false },
      );
      const flames: [Vec3, number, number][] = [
        [[0, 0, 0.03], 1, 0],
        [[0.07, 0.04, 0.03], 0.75, 0],
        [[-0.06, -0.05, 0.03], 0.7, 0],
        [[0.01, 0, 0.05], 0.55, 1],
      ];
      for (const [c, s, mi] of flames)
        lathe(
          fire,
          [
            [0, 0],
            [0.11 * s, 0.1 * s],
            [0.08 * s, 0.32 * s],
            [0.03 * s, 0.5 * s],
            [0, 0.58 * s],
          ],
          10,
          mi,
          { matrix: at(c[0], c[1], c[2]) },
        );
      m.part('fire', fire, [
        material('Flame Orange', '#ff7a1a', 0.6, { emission: 5 }),
        material('Flame Yellow', '#ffd34d', 0.6, { emission: 8 }),
        material('Embers', '#b3260f', 0.8, { emission: 2 }),
      ]);
    }
  },
});

const hayBale = defineModel({
  id: 'hay_bale',
  name: 'Hay Bale',
  category: 'props',
  tags: ['hay', 'bale', 'straw', 'farm', 'barn', 'countryside', 'harvest'],
  synonyms: ['straw bale', 'bale of hay', 'hay block', 'round bale', 'straw'],
  description:
    'Small square hay bale (0.9 × 0.46 × 0.36 m, long side along X) tied with two strings; shape round gives a 1.4 m round bale lying along X.',
  dimensions_m: [0.9, 0.47, 0.37],
  triangles: 132,
  params: z.object({
    shape: z.enum(['square', 'round']).default('square').describe('Small square bale or large round bale'),
  }),
  build(m, p) {
    const b = new MeshBuilder();
    if (p.shape === 'square') {
      extrude(b, roundedRect(0.46, 0.36, 0.05, 2, 0, 0.18), 'x', -0.45, 0.45, 0);
      for (const x of [-0.2, 0.2])
        extrude(b, roundedRect(0.47, 0.37, 0.05, 2, 0, 0.185), 'x', x - 0.012, x + 0.012, 1);
    } else {
      cylinder(b, [-0.6, 0, 0.7], [0.6, 0, 0.7], 0.7, 24, 0, { capMat: 2 });
      for (const x of [-0.35, 0, 0.35]) cylinder(b, [x - 0.012, 0, 0.7], [x + 0.012, 0, 0.7], 0.705, 24, 1);
    }
    m.part('bale', b, [m.main(HAY), TWINE, hayMaterial('Hay Bale End', '#c9a43e')]);
  },
});

const haystack = defineModel({
  id: 'haystack',
  name: 'Haystack',
  category: 'props',
  tags: ['hay', 'haystack', 'farm', 'field', 'countryside', 'harvest', 'straw'],
  synonyms: ['hayrick', 'rick', 'hay pile', 'straw stack', 'hay mound', 'stook'],
  description:
    'Tall domed haystack, 3.5 m across and 3.2 m high, built around a pole that sticks out of the top.',
  dimensions_m: [3.56, 3.56, 3.7],
  triangles: 260,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, 0],
        [1.6, 0],
        [1.78, 0.7],
        [1.62, 1.6],
        [1.05, 2.55],
        [0.38, 3.08],
        [0, 3.2],
      ],
      24,
      0,
    );
    cylinder(b, [0, 0, 2.5], [0, 0, 3.7], 0.045, 6, 1);
    m.part('haystack', b, [m.main(HAY), MAT.woodDark]);
  },
});

const waterTrough = defineModel({
  id: 'water_trough',
  name: 'Water Trough',
  category: 'props',
  tags: ['trough', 'water', 'farm', 'horse', 'cattle', 'drinking', 'paddock'],
  synonyms: ['horse trough', 'cattle trough', 'drinking trough', 'stock tank', 'trough'],
  description:
    'Galvanised farm water trough, 1.8 × 0.6 m and 0.6 m high on two trestles, filled with water (part `water`).',
  dimensions_m: [1.84, 0.64, 0.62],
  triangles: 198,
  build(m) {
    const b = new MeshBuilder();
    const z0 = 0.1;
    const z1 = 0.6;
    const t = 0.02;
    box(b, [-0.9, -0.3, z0], [0.9, 0.3, z0 + t], 0);
    box(b, [-0.9, -0.3, z0], [0.9, -0.3 + t, z1], 0);
    box(b, [-0.9, 0.3 - t, z0], [0.9, 0.3, z1], 0);
    box(b, [-0.9, -0.3, z0], [-0.9 + t, 0.3, z1], 0);
    box(b, [0.9 - t, -0.3, z0], [0.9, 0.3, z1], 0);
    for (const y of [-0.3, 0.3]) cylinder(b, [-0.92, y, z1], [0.92, y, z1], 0.02, 8, 0);
    for (const x of [-0.9, 0.9]) cylinder(b, [x, -0.32, z1], [x, 0.32, z1], 0.02, 8, 0);
    for (const x of [-0.6, 0.6]) box(b, [x - 0.05, -0.3, 0], [x + 0.05, 0.3, z0], 1);
    m.part('trough', b, [m.main(MAT.metal), MAT.woodDark]);
    const w = new MeshBuilder();
    heightField(w, 1, 1, [-0.88, 0.88], [-0.28, 0.28], () => 0.5);
    m.part('water', w, [material('Trough Water', '#4f7f8f', 0.1, { coat: 0.5 })]);
  },
});

const well = defineModel({
  id: 'well',
  name: 'Well',
  category: 'architecture',
  tags: ['well', 'water', 'village', 'farm', 'stone', 'medieval', 'garden', 'fairy tale'],
  synonyms: ['wishing well', 'water well', 'stone well', 'village well', 'draw well'],
  description:
    'Round stone well with a wooden windlass, rope and bucket under a small gabled roof; dark water inside (part `water`).',
  dimensions_m: [1.86, 1.64, 2.389],
  triangles: 660,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0.6, 0],
        [0.78, 0],
        [0.78, 0.78],
        [0.6, 0.78],
      ],
      24,
      0,
      { loop: true, smooth: false },
    );
    lathe(
      b,
      [
        [0.57, 0.78],
        [0.82, 0.78],
        [0.82, 0.88],
        [0.57, 0.88],
      ],
      24,
      1,
      { loop: true, smooth: false },
    );
    for (const x of [-0.7, 0.7]) box(b, [x - 0.05, -0.05, 0.88], [x + 0.05, 0.05, 2.0], 2);
    cylinder(b, [-0.68, 0, 1.6], [0.68, 0, 1.6], 0.055, 10, 2);
    cylinder(b, [-0.25, 0, 1.6], [0.25, 0, 1.6], 0.075, 10, 3);
    box(b, [0.75, -0.02, 1.58], [0.8, 0.02, 1.62], 4);
    box(b, [0.78, -0.02, 1.45], [0.82, 0.02, 1.62], 4);
    cylinder(b, [0, -0.075, 1.6], [0, -0.075, 1.2], 0.008, 4, 3);
    lathe(
      b,
      [
        [0, 1.0],
        [0.1, 1.0],
        [0.12, 1.2],
        [0.105, 1.2],
        [0.087, 1.02],
        [0, 1.02],
      ],
      12,
      2,
      { matrix: at(0, -0.075, 0) },
    );
    gableRoof(b, 0.6, 1.5, 2.0, 2.32, 5, { overhang: 0.18, thick: 0.06, matrix: at(0, 0, 0, Math.PI / 2) });
    m.part('well', b, [
      m.main(MAT.stone),
      material('Well Coping', '#a39d93', 0.85),
      MAT.woodDark,
      material('Rope', '#c2a878', 0.9),
      MAT.darkMetal,
      MAT.roofTile,
    ]);
    const w = new MeshBuilder();
    radialSurface(
      w,
      [
        [0, 0.3],
        [0.61, 0.3],
      ],
      24,
      0,
      { smooth: false },
    );
    m.part('water', w, [material('Well Water', '#1c3440', 0.08, { coat: 0.5 })]);
  },
});

const swingSet = defineModel({
  id: 'swing_set',
  name: 'Swing Set',
  category: 'sports',
  tags: ['swing', 'playground', 'park', 'children', 'play', 'garden'],
  synonyms: ['swings', 'swing', 'playground swing', 'garden swing', 'swing frame'],
  description:
    'Playground swing set: an A-frame 2.8 m wide and 2.2 m high with two swings; each swing (`swing.1`, `swing.2`) hangs from its pivot on the top bar and turns about X.',
  dimensions_m: [2.8, 1.765, 2.24],
  triangles: 220,
  build(m) {
    const b = new MeshBuilder();
    const top = 2.2;
    cylinder(b, [-1.4, 0, top], [1.4, 0, top], 0.04, 10, 0);
    for (const x of [-1.32, 1.32])
      // The slanted legs' end caps tilt; start them 13 mm up so no rim dips below the ground.
      for (const s of [-1, 1]) cylinder(b, [x, s * 0.85, 0.013], [x, 0, top], 0.035, 8, 0);
    m.part('frame', b, [m.main(PLAY_FRAME)]);
    for (const [i, x] of [-0.55, 0.55].entries()) {
      const s = new MeshBuilder();
      for (const dx of [-0.21, 0.21])
        cylinder(s, [dx, 0, -0.02], [dx, 0, -1.74], 0.008, 4, 0, { smooth: false });
      box(s, [-0.25, -0.09, -1.78], [0.25, 0.09, -1.74], 1);
      m.part(`swing.${i + 1}`, s, [MAT.metal, material('Swing Seat', '#e04a2f', 0.6)], {
        location: [x, 0, top - 0.02],
      });
    }
  },
});

const slide = defineModel({
  id: 'slide',
  name: 'Slide',
  category: 'sports',
  tags: ['slide', 'playground', 'park', 'children', 'play', 'garden'],
  synonyms: ['playground slide', 'slippery slide', 'kids slide', 'chute', 'slipper slide'],
  description:
    'Playground slide: a ladder at the back (+Y) up to a 1.5 m platform with rails, and a yellow chute down to the front (−Y).',
  dimensions_m: [0.72, 3.851, 2.2],
  triangles: 416,
  build(m) {
    const b = new MeshBuilder();
    const deck = 1.5;
    box(b, [-0.35, 0.5, deck - 0.06], [0.35, 1.0, deck], 2);
    for (const x of [-0.33, 0.33])
      for (const y of [0.52, 0.98]) cylinder(b, [x, y, 0], [x, y, 2.2], 0.03, 8, 1);
    for (const x of [-0.33, 0.33]) cylinder(b, [x, 0.52, 2.15], [x, 0.98, 2.15], 0.025, 8, 1);
    // ladder at the back
    for (const x of [-0.25, 0.25]) beam(b, [x, 1.55, 0.01], [x, 1.0, deck], 0.05, 0.05, 1, [1, 0, 0]);
    for (let k = 1; k <= 5; k++) {
      const t = k / 6;
      cylinder(b, [-0.25, 1.55 - 0.55 * t, deck * t], [0.25, 1.55 - 0.55 * t, deck * t], 0.018, 6, 1);
    }
    // chute: a channel along the path, from the deck down to the front
    const path: Vec3[] = [
      [0, 0.52, deck],
      [0, -1.55, 0.42],
      [0, -2.25, 0.3],
    ];
    for (let i = 0; i + 1 < path.length; i++) {
      const p0 = path[i];
      const p1 = path[i + 1];
      const dy = p1[1] - p0[1];
      const dz = p1[2] - p0[2];
      const l = Math.hypot(dy, dz);
      const n: Vec3 = [0, -dz / l, dy / l];
      const up = n[2] < 0 ? ([0, -n[1], -n[2]] as Vec3) : n;
      addBoxBetween(b, p0, p1, 0.5, 0.03, up, { mat: 0 });
      for (const s of [-1, 1]) {
        const o: Vec3 = [s * 0.25, up[1] * 0.08, up[2] * 0.08];
        addBoxBetween(
          b,
          [p0[0] + o[0], p0[1] + o[1], p0[2] + o[2]],
          [p1[0] + o[0], p1[1] + o[1], p1[2] + o[2]],
          0.03,
          0.17,
          up,
          { mat: 0 },
        );
      }
    }
    for (const x of [-0.2, 0.2]) cylinder(b, [x, -2.1, 0], [x, -2.1, 0.3], 0.025, 6, 1);
    m.part('slide', b, [m.main(material('Slide Yellow', '#f2c12e', 0.4)), PLAY_FRAME, MAT.plank]);
  },
});

const sandcastle = defineModel({
  id: 'sandcastle',
  name: 'Sandcastle',
  category: 'props',
  tags: ['sandcastle', 'beach', 'sand', 'castle', 'summer', 'children', 'seaside'],
  synonyms: ['sand castle', 'sand fort', 'beach castle', 'castle of sand'],
  description:
    'Sandcastle, 0.8 m across: four crenellated towers joined by walls around a central keep with a small red flag.',
  dimensions_m: [0.84, 0.84, 0.66],
  triangles: 684,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, 0],
        [0.42, 0],
        [0.36, 0.08],
        [0, 0.09],
      ],
      24,
      0,
    );
    const crenel = (cx: number, cy: number, r: number, zt: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        block(b, [cx + r * Math.cos(a), cy + r * Math.sin(a), zt + 0.025], [0.035, 0.035, 0.05], 0, a);
      }
    };
    cylinder(b, [0, 0, 0.06], [0, 0, 0.42], 0.12, 14, 0, { smooth: false });
    crenel(0, 0, 0.105, 0.42, 7);
    for (const x of [-0.22, 0.22])
      for (const y of [-0.22, 0.22]) {
        cylinder(b, [x, y, 0.06], [x, y, 0.3], 0.085, 10, 0, { r1: 0.07, smooth: false });
        crenel(x, y, 0.06, 0.3, 5);
      }
    for (const s of [-1, 1]) {
      box(b, [-0.15, s * 0.22 - 0.025, 0.06], [0.15, s * 0.22 + 0.025, 0.2], 0);
      box(b, [s * 0.22 - 0.025, -0.15, 0.06], [s * 0.22 + 0.025, 0.15, 0.2], 0);
    }
    cylinder(b, [0, 0, 0.42], [0, 0, 0.66], 0.005, 4, 1);
    extrude(
      b,
      [
        [0, 0.56],
        [0.12, 0.6],
        [0, 0.645],
      ],
      'y',
      -0.003,
      0.003,
      2,
    );
    m.part('sandcastle', b, [m.main(material('Wet Sand', '#bf9a5e', 0.95)), MAT.woodLight, MAT.red]);
  },
});

const bucketAndSpade = defineModel({
  id: 'bucket_and_spade',
  name: 'Bucket and Spade',
  category: 'sports',
  tags: ['bucket', 'spade', 'beach', 'sand', 'toy', 'children', 'pail', 'shovel'],
  synonyms: ['beach bucket', 'pail and shovel', 'sand bucket', 'toy bucket', 'spade', 'pail'],
  description:
    'Children’s beach toys: a red plastic bucket with a wire handle and a blue spade lying beside it (+X).',
  dimensions_m: [0.597, 0.254, 0.294],
  triangles: 372,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, 0],
        [0.09, 0],
        [0.12, 0.2],
        [0.127, 0.2],
        [0.127, 0.212],
        [0.112, 0.212],
        [0.083, 0.014],
        [0, 0.014],
      ],
      20,
      0,
      { smooth: false },
    );
    const handle: Vec3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = (i / 10) * Math.PI;
      handle.push([0.122 * Math.cos(t), 0, 0.19 + 0.1 * Math.sin(t)]);
    }
    tube(b, handle, 0.004, 4, 1);
    cylinder(b, [0.16, -0.06, 0.014], [0.36, -0.06, 0.014], 0.012, 6, 2);
    block(b, [0.15, -0.06, 0.014], [0.02, 0.07, 0.022], 2);
    extrude(
      b,
      [
        [0.36, -0.045],
        [0.45, -0.05],
        [0.47, 0],
        [0.45, 0.05],
        [0.36, 0.045],
      ].map(([x, y]) => [x, y - 0.06] as Vec2),
      'z',
      0.004,
      0.012,
      2,
    );
    m.part('bucket_and_spade', b, [
      m.main(material('Toy Red', '#e53935', 0.45)),
      MAT.metal,
      material('Toy Blue', '#1e88e5', 0.45),
    ]);
  },
});

/** Built-in outdoor models. */
export const OUTDOOR_MODELS: CatalogEntry[] = [
  beachUmbrella,
  beachLounger,
  tent,
  campfire,
  hayBale,
  haystack,
  waterTrough,
  well,
  swingSet,
  slide,
  sandcastle,
  bucketAndSpade,
];
