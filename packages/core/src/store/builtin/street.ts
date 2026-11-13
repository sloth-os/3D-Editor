import { z } from 'zod';
import type { Vec2 } from '../../math/types';
import { MeshBuilder, addLathe } from '../../generate/builder';
import type { CatalogEntry } from '../types';
import {
  DEG,
  MAT,
  appendMesh,
  at,
  beam,
  block,
  box,
  circle,
  cylinder,
  defineModel,
  extrude,
  lathe,
  material,
  radialSurface,
  roundedRect,
  textMesh,
  tube,
  xf,
  type ModelMaterial,
} from './architecture';

/*
 * Built-in street models (CATALOG-B): road pieces, sidewalk and street furniture. Road surfaces are
 * a couple of centimetres thick so they sit on a ground plane at z = 0 without z-fighting; their
 * markings sit 3 mm above the asphalt. Pole-mounted models (streetlight, traffic light, stop sign,
 * signpost) keep the foot of their pole at the origin.
 */

const ASPHALT = material('Asphalt', '#3b3d40', 0.92);
const MARKING = material('Road Marking', '#ecebe4', 0.6);
const KERB = material('Kerb Stone', '#7d7f80', 0.85);
const POLE = material('Street Pole Grey', '#5d6266', 0.45, { metallic: 0.8 });
const JOINT = material('Paving Joint', '#5f5e5a', 0.95);

const ASPHALT_TOP = 0.02;
const LINE_TOP = ASPHALT_TOP + 0.003;

const lengthParam = (def: number, min: number, max: number, what = 'Length along Y in metres') =>
  z.number().min(min).max(max).default(def).describe(what);

/** Closed slab of an annular sector (centre cx, cy; radii r0..r1; angles a0..a1) from z0 to z1. */
function arcSlab(
  b: MeshBuilder,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  n: number,
  z0: number,
  z1: number,
  mat: number,
): void {
  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    outer.push([cx + r1 * Math.cos(a), cy + r1 * Math.sin(a)]);
    inner.push([cx + r0 * Math.cos(a), cy + r0 * Math.sin(a)]);
  }
  extrude(b, [...outer, ...inner.reverse()], 'z', z0, z1, mat);
}

const road = defineModel({
  id: 'road',
  name: 'Road',
  category: 'street',
  tags: ['road', 'street', 'asphalt', 'tarmac', 'lane', 'traffic', 'town', 'city'],
  synonyms: ['street', 'straight road', 'tarmac road', 'roadway', 'highway', 'lane', 'asphalt road'],
  description:
    'Straight asphalt road section running along Y: two 3.5 m lanes, 10 m long, a dashed centre line and solid edge lines; 2 cm thick so it sits on the ground.',
  dimensions_m: [7, 10, 0.023],
  triangles: 48,
  params: z.object({
    length: lengthParam(10, 1, 500),
    lanes: z.number().int().min(1).max(6).default(2).describe('Number of 3.5 m lanes'),
  }),
  build(m, p) {
    const b = new MeshBuilder();
    const W = p.lanes * 3.5;
    const L = p.length;
    box(b, [-W / 2, -L / 2, 0], [W / 2, L / 2, ASPHALT_TOP], 0);
    for (const s of [-1, 1])
      box(
        b,
        [s * (W / 2 - 0.25) - 0.06, -L / 2, ASPHALT_TOP],
        [s * (W / 2 - 0.25) + 0.06, L / 2, LINE_TOP],
        1,
      );
    const dashes = Math.max(1, Math.floor(L / 6));
    for (let i = 1; i < p.lanes; i++) {
      const x = -W / 2 + i * 3.5;
      for (let k = 0; k < dashes; k++) {
        const y = -L / 2 + (L * (k + 0.5)) / dashes;
        box(b, [x - 0.06, y - 1.5, ASPHALT_TOP], [x + 0.06, y + 1.5, LINE_TOP], 1);
      }
    }
    m.part('road', b, [m.main(ASPHALT), MARKING]);
  },
});

const roadCorner = defineModel({
  id: 'road_corner',
  name: 'Road Corner',
  category: 'street',
  tags: ['road', 'street', 'corner', 'bend', 'curve', 'turn', 'asphalt', 'junction'],
  synonyms: ['bend', 'curve', 'turn', 'corner', 'road bend', 'curved road', 'road curve'],
  description:
    'Quarter-circle bend of a two-lane asphalt road (7 m wide, 7 m centre radius): enters from −Y and leaves towards +X, with dashed centre and solid edge lines.',
  dimensions_m: [10.5, 10.5, 0.023],
  triangles: 660,
  build(m) {
    const b = new MeshBuilder();
    const Rc = 7;
    const W = 7;
    const [a0, a1] = [Math.PI / 2, Math.PI];
    arcSlab(b, Rc, 0, Rc - W / 2, Rc + W / 2, a0, a1, 24, 0, ASPHALT_TOP, 0);
    for (const r of [Rc - W / 2 + 0.25, Rc + W / 2 - 0.25])
      arcSlab(b, Rc, 0, r - 0.06, r + 0.06, a0, a1, 24, ASPHALT_TOP, LINE_TOP, 1);
    const n = Math.max(1, Math.round((Rc * (a1 - a0)) / 6));
    const half = 1.5 / Rc;
    for (let i = 0; i < n; i++) {
      const c = a0 + ((a1 - a0) * (i + 0.5)) / n;
      arcSlab(b, Rc, 0, Rc - 0.06, Rc + 0.06, c - half, c + half, 4, ASPHALT_TOP, LINE_TOP, 1);
    }
    m.part('road', b, [m.main(ASPHALT), MARKING]);
  },
});

const sidewalk = defineModel({
  id: 'sidewalk',
  name: 'Sidewalk',
  category: 'street',
  tags: ['sidewalk', 'pavement', 'footpath', 'kerb', 'curb', 'street', 'town'],
  synonyms: ['pavement', 'footpath', 'walkway', 'curb', 'kerb', 'footway'],
  description:
    'Concrete sidewalk section running along Y, 2 m wide and 10 m long, 15 cm high with a granite kerb on its −X edge and paving joints.',
  dimensions_m: [2, 10, 0.152],
  triangles: 84,
  params: z.object({
    length: lengthParam(10, 0.5, 500),
    width: z.number().min(0.5).max(10).default(2).describe('Width along X in metres'),
  }),
  build(m, p) {
    const b = new MeshBuilder();
    const L = p.length;
    const W = p.width;
    const h = 0.15;
    box(b, [-W / 2 + 0.15, -L / 2, 0], [W / 2, L / 2, h], 0);
    box(b, [-W / 2, -L / 2, 0], [-W / 2 + 0.15, L / 2, h], 1);
    const joints = Math.max(0, Math.floor(L / 1.5) - 1);
    for (let k = 1; k <= joints; k++) {
      const y = -L / 2 + (L * k) / (joints + 1);
      box(b, [-W / 2 + 0.15, y - 0.006, h], [W / 2, y + 0.006, h + 0.002], 2);
    }
    m.part('sidewalk', b, [m.main(MAT.concrete), KERB, JOINT]);
  },
});

const streetlight = defineModel({
  id: 'streetlight',
  name: 'Streetlight',
  category: 'street',
  tags: ['streetlight', 'lamp', 'light', 'street', 'pole', 'night', 'road'],
  synonyms: ['street lamp', 'lamp post', 'lamppost', 'street light', 'light pole', 'lantern'],
  description:
    'Street lamp: a 6 m tapered pole on a plinth with a curved arm reaching 1.4 m forward (−Y) to the lamp head; the pole foot is the origin. `lit` makes the lamp glow.',
  dimensions_m: [0.28, 1.87, 6.3],
  triangles: 156,
  anchor: 'origin',
  params: z.object({ lit: z.boolean().default(false).describe('The lamp glows (night scenes)') }),
  build(m, p) {
    const b = new MeshBuilder();
    cylinder(b, [0, 0, 0], [0, 0, 0.45], 0.14, 8, 0, { r1: 0.11, smooth: false });
    cylinder(b, [0, 0, 0.45], [0, 0, 6.0], 0.075, 12, 0, { r1: 0.055 });
    tube(
      b,
      [
        [0, 0, 5.8],
        [0, -0.22, 6.1],
        [0, -0.7, 6.25],
        [0, -1.3, 6.25],
      ],
      0.04,
      8,
      0,
    );
    block(b, [0, -1.45, 6.24], [0.24, 0.56, 0.12], 0);
    block(b, [0, -1.45, 6.175], [0.18, 0.46, 0.012], 1);
    const lens: ModelMaterial = p.lit ? MAT.lampGlow : material('Lamp Lens', '#d9dcd6', 0.25);
    m.part('streetlight', b, [m.main(material('Lamp Post Green', '#2f3a35', 0.5, { metallic: 0.7 })), lens]);
  },
});

const trafficLight = defineModel({
  id: 'traffic_light',
  name: 'Traffic Light',
  category: 'street',
  tags: ['traffic light', 'signal', 'street', 'junction', 'crossing', 'road', 'stoplight'],
  synonyms: ['traffic signal', 'stoplight', 'stop light', 'signal light', 'traffic lights', 'semaphore'],
  description:
    'Pole-mounted traffic signal: three lamps facing −Y in a dark housing at about 2.6 m; `state` picks the lit lamp (red by default). The pole foot is the origin.',
  dimensions_m: [0.5, 0.48, 3.175],
  triangles: 288,
  anchor: 'origin',
  params: z.object({ state: z.enum(['red', 'amber', 'green']).default('red').describe('Which lamp is lit') }),
  build(m, p) {
    const b = new MeshBuilder();
    cylinder(b, [0, 0, 0], [0, 0, 3.15], 0.06, 10, 0);
    block(b, [0, -0.06, 1.1], [0.1, 0.1, 0.16], 1);
    block(b, [0, -0.17, 2.6], [0.32, 0.22, 0.98], 1);
    block(b, [0, -0.055, 2.6], [0.5, 0.02, 1.15], 1);
    const lamps: [string, number, number][] = [
      ['red', 2.92, 3],
      ['amber', 2.6, 4],
      ['green', 2.28, 5],
    ];
    for (const [, zz, mi] of lamps) {
      cylinder(b, [0, -0.27, zz], [0, -0.3, zz], 0.1, 16, mi);
      block(b, [0, -0.35, zz + 0.115], [0.26, 0.14, 0.02], 1);
    }
    const lit = (c: string, hex: string, dark: string) =>
      p.state === c
        ? material(`Signal ${c} lit`, hex, 0.3, { emission: 8 })
        : material(`Signal ${c} off`, dark, 0.35);
    m.part('traffic_light', b, [
      m.main(POLE),
      MAT.blackPlastic,
      MAT.white,
      lit('red', '#ff2a1a', '#4a1512'),
      lit('amber', '#ffb020', '#4a3512'),
      lit('green', '#2bd96b', '#123d24'),
    ]);
  },
});

const trafficCone = defineModel({
  id: 'traffic_cone',
  name: 'Traffic Cone',
  category: 'street',
  tags: ['cone', 'traffic cone', 'roadworks', 'safety', 'street', 'pylon'],
  synonyms: ['cone', 'safety cone', 'pylon', 'road cone', 'witch hat'],
  description: 'Orange traffic cone, 70 cm, with two white reflective bands on a square black base.',
  dimensions_m: [0.38, 0.38, 0.71],
  triangles: 304,
  build(m) {
    const b = new MeshBuilder();
    extrude(b, roundedRect(0.38, 0.38, 0.05, 2), 'z', 0, 0.03, 2);
    const rAt = (zz: number) => 0.15 - ((0.15 - 0.028) * (zz - 0.03)) / (0.7 - 0.03);
    const bands: [number, number, number][] = [
      [0.03, 0.26, 0],
      [0.26, 0.36, 1],
      [0.36, 0.44, 0],
      [0.44, 0.54, 1],
      [0.54, 0.7, 0],
    ];
    for (const [z0, z1, mi] of bands)
      addLathe(
        b,
        [
          [rAt(z0), z0],
          [rAt(z1), z1],
        ],
        20,
        { mat: mi, smooth: true },
      );
    radialSurface(
      b,
      [
        [0.028, 0.7],
        [0.015, 0.708],
        [0, 0.71],
      ],
      20,
      0,
    );
    m.part('cone', b, [
      m.main(material('Cone Orange', '#f2611d', 0.55)),
      material('Reflective White', '#f1f1ec', 0.35),
      MAT.blackPlastic,
    ]);
  },
});

const stopSign = defineModel({
  id: 'stop_sign',
  name: 'Stop Sign',
  category: 'street',
  tags: ['stop sign', 'sign', 'road sign', 'traffic', 'junction', 'street'],
  synonyms: ['stop', 'road sign', 'traffic sign', 'octagon sign', 'street sign'],
  description:
    'Red octagonal STOP sign with a white border and lettering, facing −Y on a 2.4 m post; the post foot is the origin.',
  dimensions_m: [0.75, 0.08, 2.675],
  triangles: 1236,
  anchor: 'origin',
  build(m) {
    const b = new MeshBuilder();
    box(b, [-0.03, -0.03, 0], [0.03, 0.03, 2.45], 0);
    const zc = 2.3;
    const octagon = (r: number) => circle(r, 8, Math.PI / 8).map(([x, zz]) => [x, zz + zc] as Vec2);
    extrude(b, octagon(0.406), 'y', -0.04, -0.03, 1);
    extrude(b, octagon(0.375), 'y', -0.046, -0.04, 2);
    const text = textMesh('STOP', 0.24, 0.004);
    if (text) appendMesh(b, text, [1], xf([0, -0.048, zc], [Math.PI / 2, 0, 0]));
    m.part('sign', b, [MAT.metal, MAT.white, m.main(material('Stop Red', '#c1121f', 0.4))]);
  },
});

const mailbox = defineModel({
  id: 'mailbox',
  name: 'Mailbox',
  category: 'street',
  tags: ['mailbox', 'post', 'letters', 'mail', 'rural', 'house', 'garden'],
  synonyms: ['letterbox', 'post box', 'postbox', 'mail box', 'letter box', 'rural mailbox'],
  description:
    'Rural mailbox: a round-topped metal box on a wooden post, door at the front (−Y) and a raised red flag on its side.',
  dimensions_m: [0.266, 0.545, 1.3],
  triangles: 156,
  build(m) {
    const b = new MeshBuilder();
    box(b, [-0.045, -0.045, 0], [0.045, 0.045, 1.0], 0);
    box(b, [-0.1, -0.22, 1.0], [0.1, 0.22, 1.03], 0);
    const outline = (k: number): Vec2[] => {
      const pts: Vec2[] = [
        [-0.12 * k, 1.03],
        [0.12 * k, 1.03],
      ];
      for (let i = 0; i <= 10; i++) {
        const t = (i / 10) * Math.PI;
        pts.push([0.12 * k * Math.cos(t), 1.17 + 0.12 * k * Math.sin(t)]);
      }
      return pts;
    };
    extrude(b, outline(1), 'y', -0.25, 0.25, 1);
    extrude(b, outline(1.05), 'y', -0.27, -0.25, 2);
    block(b, [0, -0.285, 1.22], [0.05, 0.02, 0.02], 2);
    // flag arm on the left side (+X), raised
    box(b, [0.125, 0.04, 1.08], [0.14, 0.07, 1.3], 3);
    box(b, [0.125, 0.07, 1.22], [0.14, 0.2, 1.3], 3);
    m.part('mailbox', b, [
      MAT.woodDark,
      m.main(material('Mailbox Metal', '#9aa0a4', 0.4, { metallic: 0.7 })),
      material('Mailbox Door', '#868c90', 0.45, { metallic: 0.7 }),
      MAT.red,
    ]);
  },
});

const fireHydrant = defineModel({
  id: 'fire_hydrant',
  name: 'Fire Hydrant',
  category: 'street',
  tags: ['fire hydrant', 'hydrant', 'street', 'sidewalk', 'fire', 'water'],
  synonyms: ['hydrant', 'fireplug', 'fire plug', 'water hydrant', 'pillar hydrant'],
  description:
    'Red pillar fire hydrant, 76 cm, with a domed bonnet, two side outlets and a larger front outlet (−Y).',
  dimensions_m: [0.45, 0.37, 0.76],
  triangles: 640,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, 0],
        [0.16, 0],
        [0.16, 0.05],
        [0.115, 0.065],
        [0.115, 0.5],
        [0.135, 0.52],
        [0.135, 0.56],
        [0.12, 0.58],
        [0.1, 0.66],
        [0.06, 0.71],
        [0, 0.72],
      ],
      20,
      0,
    );
    cylinder(b, [0, 0, 0.7], [0, 0, 0.76], 0.03, 5, 1, { smooth: false });
    for (const sx of [-1, 1]) {
      cylinder(b, [sx * 0.1, 0, 0.42], [sx * 0.19, 0, 0.42], 0.045, 12, 0);
      cylinder(b, [sx * 0.19, 0, 0.42], [sx * 0.225, 0, 0.42], 0.055, 12, 1);
    }
    cylinder(b, [0, -0.1, 0.36], [0, -0.17, 0.36], 0.06, 12, 0);
    cylinder(b, [0, -0.17, 0.36], [0, -0.21, 0.36], 0.07, 12, 1);
    m.part('hydrant', b, [
      m.main(material('Hydrant Red', '#c0392b', 0.45)),
      material('Hydrant Caps', '#d9d6cf', 0.35, { metallic: 0.6 }),
    ]);
  },
});

const busStop = defineModel({
  id: 'bus_stop',
  name: 'Bus Stop',
  category: 'street',
  tags: ['bus stop', 'shelter', 'street', 'town', 'city', 'transport', 'waiting'],
  synonyms: ['bus shelter', 'bus station', 'tram stop', 'shelter', 'stop'],
  description:
    'Bus shelter with glass back and side panels, a roof, a bench inside and a round BUS sign on a pole at the front left; open towards −Y.',
  dimensions_m: [3.87, 1.62, 2.67],
  triangles: 1476,
  build(m) {
    const b = new MeshBuilder();
    for (const x of [-1.55, 1.55])
      for (const y of [-0.65, 0.65]) box(b, [x - 0.04, y - 0.04, 0], [x + 0.04, y + 0.04, 2.4], 0);
    box(b, [-1.72, -0.8, 2.4], [1.72, 0.82, 2.5], 0);
    box(b, [-1.51, 0.62, 0.1], [1.51, 0.66, 2.3], 1);
    box(b, [1.53, -0.6, 0.1], [1.57, 0.6, 2.3], 1);
    box(b, [-1.57, -0.6, 0.3], [-1.53, 0.6, 2.1], 2);
    box(b, [-1.2, 0.3, 0.42], [1.2, 0.6, 0.47], 3);
    for (const x of [-1.1, 0, 1.1]) box(b, [x - 0.03, 0.4, 0], [x + 0.03, 0.5, 0.42], 0);
    // round BUS sign on a pole at the front left
    const sx = -1.9;
    const sy = -0.75;
    cylinder(b, [sx, sy, 0], [sx, sy, 2.65], 0.035, 8, 0);
    cylinder(b, [sx, sy + 0.01, 2.42], [sx, sy - 0.02, 2.42], 0.25, 20, 4, { smooth: false });
    cylinder(b, [sx, sy - 0.02, 2.42], [sx, sy - 0.03, 2.42], 0.21, 20, 5, { smooth: false });
    const text = textMesh('BUS', 0.15, 0.004);
    if (text) appendMesh(b, text, [6], xf([sx, sy - 0.033, 2.42], [Math.PI / 2, 0, 0]));
    m.part('bus_stop', b, [
      m.main(material('Shelter Frame', '#3d4a57', 0.5, { metallic: 0.6 })),
      material('Shelter Glass', '#b8d4e0', 0.08, { alpha: 0.35 }),
      material('Advert Panel', '#e8e2d0', 0.6, { emission: 0.6 }),
      MAT.wood,
      material('Bus Sign Red', '#c62828', 0.45),
      MAT.white,
      material('Sign Lettering', '#1c2b3a', 0.5),
    ]);
  },
});

const parkBench = defineModel({
  id: 'park_bench',
  name: 'Park Bench',
  category: 'street',
  tags: ['bench', 'park', 'seat', 'garden', 'street', 'outdoor', 'sit'],
  synonyms: ['bench', 'garden bench', 'seat', 'public bench', 'wooden bench'],
  description:
    'Park bench, 1.8 m: wooden seat and back slats on cast-iron side frames with armrests; the seat faces −Y.',
  dimensions_m: [1.86, 0.63, 0.882],
  triangles: 180,
  build(m) {
    const b = new MeshBuilder();
    for (const x of [-0.82, 0.82]) {
      box(b, [x - 0.03, -0.26, 0], [x + 0.03, -0.2, 0.62], 1);
      beam(b, [x, 0.24, 0.003], [x, 0.3, 0.88], 0.06, 0.06, 1, [1, 0, 0]);
      box(b, [x - 0.03, -0.24, 0.4], [x + 0.03, 0.26, 0.44], 1);
      box(b, [x - 0.035, -0.3, 0.62], [x + 0.035, 0.22, 0.66], 1);
    }
    for (const y of [-0.2, -0.08, 0.04, 0.16]) box(b, [-0.93, y - 0.05, 0.44], [0.93, y + 0.05, 0.475], 0);
    for (const zz of [0.56, 0.68, 0.8]) {
      const y = 0.25 + ((zz - 0.45) / 0.43) * 0.06;
      beam(b, [-0.93, y, zz], [0.93, y, zz], 0.03, 0.09, 0, [0, -0.14, 0.99]);
    }
    m.part('bench', b, [
      m.main(material('Bench Wood', '#9a6b3f', 0.6)),
      material('Cast Iron', '#2b2d30', 0.55, { metallic: 0.8 }),
    ]);
  },
});

const picnicTable = defineModel({
  id: 'picnic_table',
  name: 'Picnic Table',
  category: 'street',
  tags: ['picnic table', 'table', 'bench', 'park', 'garden', 'camping', 'outdoor'],
  synonyms: ['picnic bench', 'park table', 'garden table', 'outdoor table', 'picnic set'],
  description: 'Wooden A-frame picnic table, 1.8 m long, with a bench on each long side (±Y).',
  dimensions_m: [1.8, 1.681, 0.759],
  triangles: 204,
  build(m) {
    const b = new MeshBuilder();
    for (let i = 0; i < 5; i++) {
      const y = -0.39 + i * 0.16;
      box(b, [-0.9, y, 0.72], [0.9, y + 0.14, 0.76], 0);
    }
    for (const s of [-1, 1])
      for (const k of [0, 1]) {
        const y = s * (0.56 + k * 0.14);
        box(b, [-0.9, y - 0.06, 0.42], [0.9, y + 0.06, 0.46], 0);
      }
    for (const x of [-0.62, 0.62]) {
      // slanted 12 cm legs reach 4.3 cm beyond their end points: start above the ground, stop under the top
      beam(b, [x, -0.8, 0.0445], [x, -0.1, 0.68], 0.12, 0.05, 1, [1, 0, 0]);
      beam(b, [x, 0.8, 0.0445], [x, 0.1, 0.68], 0.12, 0.05, 1, [1, 0, 0]);
      box(b, [x - 0.025, -0.83, 0.36], [x + 0.025, 0.83, 0.42], 1);
      box(b, [x - 0.025, -0.4, 0.66], [x + 0.025, 0.4, 0.72], 1);
    }
    m.part('picnic_table', b, [m.main(material('Picnic Wood', '#a07a52', 0.75)), MAT.wood]);
  },
});

const fountain = defineModel({
  id: 'fountain',
  name: 'Fountain',
  category: 'street',
  tags: ['fountain', 'park', 'plaza', 'water', 'square', 'town', 'garden'],
  synonyms: ['water fountain', 'park fountain', 'basin', 'plaza fountain', 'birdbath'],
  description:
    'Round stone fountain: a 3.2 m basin and a pedestal with an upper bowl; the water surfaces and a small jet are the part `water`.',
  dimensions_m: [3.24, 3.24, 1.8],
  triangles: 1168,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, 0],
        [1.5, 0],
        [1.5, 0.42],
        [1.62, 0.46],
        [1.62, 0.54],
        [1.38, 0.54],
        [1.38, 0.15],
        [0, 0.15],
      ],
      40,
      0,
      { smooth: false },
    );
    lathe(
      b,
      [
        [0, 0.15],
        [0.26, 0.15],
        [0.18, 0.3],
        [0.16, 0.95],
        [0.24, 1.02],
        [0.62, 1.14],
        [0.64, 1.22],
        [0.52, 1.22],
        [0.2, 1.12],
        [0.09, 1.18],
        [0.07, 1.36],
        [0, 1.4],
      ],
      28,
      0,
    );
    m.part('fountain', b, [m.main(material('Fountain Stone', '#b9b3a7', 0.8))]);
    const w = new MeshBuilder();
    radialSurface(
      w,
      [
        [0, 0.44],
        [1.385, 0.44],
      ],
      40,
      0,
      { smooth: false },
    );
    radialSurface(
      w,
      [
        [0, 1.19],
        [0.53, 1.19],
      ],
      28,
      0,
      { smooth: false },
    );
    lathe(
      w,
      [
        [0, 1.36],
        [0.05, 1.42],
        [0.03, 1.65],
        [0.06, 1.75],
        [0, 1.8],
      ],
      10,
      1,
    );
    m.part('water', w, [
      material('Fountain Water', '#4a90b8', 0.08, { coat: 0.5 }),
      material('Water Spray', '#d9ecf5', 0.1, { alpha: 0.45 }),
    ]);
  },
});

const signpost = defineModel({
  id: 'signpost',
  name: 'Signpost',
  category: 'street',
  tags: ['signpost', 'sign', 'direction', 'fingerpost', 'trail', 'crossroads', 'path'],
  synonyms: ['fingerpost', 'direction sign', 'guidepost', 'waymarker', 'trail sign', 'sign post'],
  description:
    'Wooden fingerpost with three pointed direction boards at different heights; the post foot is the origin.',
  dimensions_m: [1.246, 0.946, 2.42],
  triangles: 216,
  anchor: 'origin',
  build(m) {
    const b = new MeshBuilder();
    box(b, [-0.05, -0.05, 0], [0.05, 0.05, 2.3], 0);
    cylinder(b, [0, 0, 2.3], [0, 0, 2.42], 0.075, 4, 0, { r1: 0.01, smooth: false });
    const arm: Vec2[] = [
      [0.05, -0.07],
      [0.6, -0.07],
      [0.68, 0],
      [0.6, 0.07],
      [0.05, 0.07],
    ];
    const boards: [number, number][] = [
      [2.08, 25 * DEG],
      [1.84, -70 * DEG],
      [1.6, 155 * DEG],
    ];
    for (const [h, yaw] of boards) {
      const mtx = at(0, 0, h, yaw);
      extrude(b, arm, 'y', -0.016, 0.016, 1, { matrix: mtx });
      for (const s of [-1, 1])
        for (const dz of [-0.025, 0.02])
          box(b, [0.14, s * 0.016, dz - 0.008], [0.5, s * 0.019, dz + 0.008], 2, mtx);
    }
    m.part('signpost', b, [
      MAT.woodDark,
      m.main(material('Sign Board Cream', '#efe6cf', 0.6)),
      material('Sign Lettering', '#1c2b3a', 0.5),
    ]);
  },
});

const trashBin = defineModel({
  id: 'trash_bin',
  name: 'Trash Bin',
  category: 'street',
  tags: ['trash', 'bin', 'litter', 'waste', 'rubbish', 'street', 'park', 'garbage'],
  synonyms: ['litter bin', 'garbage can', 'trash can', 'rubbish bin', 'waste bin', 'dustbin', 'bin'],
  description:
    'Round street litter bin, 1 m tall, dark green metal with bands, a domed lid and a front opening (−Y).',
  dimensions_m: [0.52, 0.52, 1],
  triangles: 416,
  build(m) {
    const b = new MeshBuilder();
    cylinder(b, [0, 0, 0], [0, 0, 0.06], 0.26, 20, 0);
    cylinder(b, [0, 0, 0.06], [0, 0, 0.85], 0.24, 20, 0);
    for (const zz of [0.3, 0.6]) cylinder(b, [0, 0, zz], [0, 0, zz + 0.03], 0.25, 20, 0);
    lathe(
      b,
      [
        [0.26, 0.85],
        [0.26, 0.88],
        [0.18, 0.97],
        [0, 1.0],
      ],
      20,
      0,
    );
    box(b, [-0.12, -0.245, 0.68], [0.12, -0.18, 0.8], 1);
    m.part('bin', b, [m.main(material('Bin Green', '#2f4a3a', 0.5, { metallic: 0.6 })), MAT.blackPlastic]);
  },
});

/** Built-in street models. */
export const STREET_MODELS: CatalogEntry[] = [
  road,
  roadCorner,
  sidewalk,
  streetlight,
  trafficLight,
  trafficCone,
  stopSign,
  mailbox,
  fireHydrant,
  busStop,
  parkBench,
  picnicTable,
  fountain,
  signpost,
  trashBin,
];
