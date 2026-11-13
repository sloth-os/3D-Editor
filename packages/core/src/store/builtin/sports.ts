import type { Vec2, Vec3 } from '../../math/types';
import { createIcoSphere } from '../../mesh/primitives';
import { MeshBuilder, addRingSurface, smoothstep } from '../../generate/builder';
import type { CatalogEntry } from '../types';
import {
  MAT,
  appendMesh,
  beam,
  block,
  box,
  cylinder,
  defineModel,
  extrude,
  lathe,
  material,
  torus,
  tube,
  xf,
} from './architecture';

/*
 * Built-in sports equipment and toys (CATALOG-B), built with the kit in architecture.ts. The kite
 * flies on desk.tether_fly: it faces −Y (toward the flyer) nose up, the string ties on at its
 * `bridle` empty and its tail hangs from `tail.1` (an empty at the kite's bottom tip) through
 * `tail.2` … `tail.5`, each segment drawn from its origin (its lower end) up to the one before. The
 * balloon's origin is its knot, marked by a `string_point` empty, as is the spool's line exit.
 */

const TAU = Math.PI * 2;

// ===================================================================== helpers

/** Adds the face `ids` (vertex indices) turned to face `dir` (from its Newell normal). */
function faceToward(b: MeshBuilder, ids: number[], mat: number, dir: Vec3, smooth: boolean): void {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < ids.length; i++) {
    const p = b.position(ids[i]);
    const q = b.position(ids[(i + 1) % ids.length]);
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  b.face(nx * dir[0] + ny * dir[1] + nz * dir[2] >= 0 ? ids : ids.slice().reverse(), mat, smooth);
}

/** UV sphere about `c` (axis Z): `nu` segments around, `nv` bands; `mat(i, j)` picks each face's slot. */
function globe(
  b: MeshBuilder,
  c: Vec3,
  r: number,
  nu: number,
  nv: number,
  mat: (i: number, j: number) => number = () => 0,
): void {
  const bottom = b.vert([c[0], c[1], c[2] - r]);
  const top = b.vert([c[0], c[1], c[2] + r]);
  const rings: number[][] = [];
  for (let j = 1; j < nv; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / nv;
    const row: number[] = [];
    for (let i = 0; i < nu; i++) {
      const th = (TAU * i) / nu;
      row.push(
        b.vert([
          c[0] + r * Math.cos(phi) * Math.cos(th),
          c[1] + r * Math.cos(phi) * Math.sin(th),
          c[2] + r * Math.sin(phi),
        ]),
      );
    }
    rings.push(row);
  }
  for (let i = 0; i < nu; i++) {
    const i1 = (i + 1) % nu;
    b.face([bottom, rings[0][i1], rings[0][i]], mat(i, 0), true);
    for (let j = 0; j + 1 < rings.length; j++)
      b.face([rings[j][i], rings[j][i1], rings[j + 1][i1], rings[j + 1][i]], mat(i, j + 1), true);
    b.face([top, rings[rings.length - 1][i], rings[rings.length - 1][i1]], mat(i, nv - 1), true);
  }
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * A panel of a ball: the spherical polygon through the unit directions `corners` (counter-clockwise
 * seen from outside), its edges split in `E`, filled by `S` rings toward its centre that dip by
 * `groove` × R at the seams. Faces point outward.
 */
function ballPanel(
  b: MeshBuilder,
  c: Vec3,
  R: number,
  corners: Vec3[],
  mat: number,
  E = 2,
  S = 2,
  groove = 0.03,
): void {
  const boundary: Vec3[] = [];
  for (let k = 0; k < corners.length; k++)
    for (let e = 0; e < E; e++)
      boundary.push(norm(lerp3(corners[k], corners[(k + 1) % corners.length], e / E)));
  const f = norm(corners.reduce<Vec3>((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]));
  const at = (d: Vec3, s: number): number => {
    const rr = R * (1 - groove * s ** 4);
    return b.vert([c[0] + d[0] * rr, c[1] + d[1] * rr, c[2] + d[2] * rr]);
  };
  const pole = at(f, 0);
  const rings = Array.from({ length: S }, (_, k) =>
    boundary.map((d) => at(norm(lerp3(f, d, (k + 1) / S)), (k + 1) / S)),
  );
  const n = boundary.length;
  for (let j = 0; j < n; j++) {
    const j1 = (j + 1) % n;
    faceToward(b, [pole, rings[0][j], rings[0][j1]], mat, f, true);
    for (let k = 0; k + 1 < S; k++) {
      const mid = norm(lerp3(f, boundary[j], (k + 1.5) / S));
      faceToward(b, [rings[k][j], rings[k + 1][j], rings[k + 1][j1], rings[k][j1]], mat, mid, true);
    }
  }
}

/** Pentagons and hexagons of a truncated icosahedron as unit-direction loops (counter-clockwise outside). */
function soccerPanels(): { pentagons: Vec3[][]; hexagons: Vec3[][] } {
  const ico = createIcoSphere({ subdivisions: 1, radius: 1 });
  const V: Vec3[] = [];
  for (let i = 0; i < ico.positions.length; i += 3)
    V.push([ico.positions[i], ico.positions[i + 1], ico.positions[i + 2]]);
  const third = (a: Vec3, c: Vec3): Vec3 => norm(lerp3(a, c, 1 / 3));
  const dot = (a: Vec3, c: Vec3) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  const pentagons = V.map((c) => {
    const neighbours = V.filter((v) => v !== c)
      .sort((p, q) => dot(q, c) - dot(p, c))
      .slice(0, 5);
    const u = norm(neighbours[0].map((x, k) => x - c[k] * dot(neighbours[0], c)) as Vec3);
    const w: Vec3 = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
    return neighbours
      .map((v) => ({ v, a: Math.atan2(dot(v, w), dot(v, u)) }))
      .sort((p, q) => p.a - q.a)
      .map(({ v }) => third(c, v));
  });
  const hexagons = ico.faces.map((f) => {
    const [a, c, d] = f.map((i) => V[i]);
    return [third(a, c), third(c, a), third(c, d), third(d, c), third(d, a), third(a, d)];
  });
  return { pentagons, hexagons };
}

// ===================================================================== balls

const soccerBall = defineModel({
  id: 'soccer_ball',
  name: 'Soccer Ball',
  category: 'sports',
  tags: ['ball', 'soccer', 'football', 'sport', 'game', 'park', 'beach', 'kick'],
  synonyms: ['football', 'soccer ball', 'association football', 'footy', 'futbol', 'kickball'],
  description:
    'Size-5 soccer ball (22 cm) of 12 black pentagons and 20 white hexagons with sunken seams; origin at its contact point. Colour sets the hexagons.',
  dimensions_m: [0.216, 0.216, 0.216],
  triangles: 1080,
  build(m) {
    const R = 0.11;
    const c: Vec3 = [0, 0, R];
    const b = new MeshBuilder();
    const { pentagons, hexagons } = soccerPanels();
    for (const p of pentagons) ballPanel(b, c, R, p, 1);
    for (const h of hexagons) ballPanel(b, c, R, h, 0);
    // the seams are sunken: sit the ball on its lowest point
    b.translate(0, 0, -b.bounds().min[2]);
    m.part('ball', b, [
      m.main(material('Ball White', '#f4f4f0', 0.4, { coat: 0.4 })),
      material('Ball Black', '#1c1c1f', 0.4, { coat: 0.4 }),
    ]);
  },
});

/** Seam ring on a ball of radius R: the circle cut by the plane through `axis` offset `d` (≤ R). */
function seamRing(
  b: MeshBuilder,
  c: Vec3,
  R: number,
  axis: 'x' | 'y' | 'z',
  d: number,
  tubeR: number,
  mat: number,
): void {
  const k = (R - tubeR * 0.4) / R;
  const rho = Math.sqrt(Math.max(0, R * R - d * d)) * k;
  const off = d * k;
  const loc: Vec3 = [
    c[0] + (axis === 'x' ? off : 0),
    c[1] + (axis === 'y' ? off : 0),
    c[2] + (axis === 'z' ? off : 0),
  ];
  const rot: Vec3 = axis === 'x' ? [0, Math.PI / 2, 0] : axis === 'y' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  torus(b, rho, tubeR, 40, 4, mat, xf(loc, rot));
}

const basketball = defineModel({
  id: 'basketball',
  name: 'Basketball',
  category: 'sports',
  tags: ['ball', 'basketball', 'sport', 'game', 'court', 'hoop', 'dribble'],
  synonyms: ['basket ball', 'hoops ball', 'b-ball', 'netball'],
  description: 'Size-7 basketball (24 cm) in pebbled orange with black seams; origin at its contact point.',
  dimensions_m: [0.243, 0.243, 0.243],
  triangles: 2232,
  build(m) {
    const R = 0.12;
    // the seam through the bottom stands proud of the ball: lift it onto its seam
    const c: Vec3 = [0, 0, R + 0.0017];
    const b = new MeshBuilder();
    globe(b, c, R, 28, 18);
    seamRing(b, c, R, 'z', 0, 0.0028, 1);
    seamRing(b, c, R, 'y', 0, 0.0028, 1);
    seamRing(b, c, R, 'x', R * 0.55, 0.0028, 1);
    seamRing(b, c, R, 'x', -R * 0.55, 0.0028, 1);
    m.part('ball', b, [
      m.main(material('Basketball Leather', '#c85a1e', 0.7)),
      material('Ball Seam', '#1a1a1a', 0.6),
    ]);
  },
});

const BEACH_BALL_COLOURS = ['#e8322b', '#f4f2ea', '#2e6fd8', '#f5c518', '#f4f2ea', '#2fa84f'];

const beachBall = defineModel({
  id: 'beach_ball',
  name: 'Beach Ball',
  category: 'sports',
  tags: ['ball', 'beach', 'inflatable', 'toy', 'summer', 'pool', 'sea', 'play'],
  synonyms: ['beachball', 'inflatable ball', 'pool ball', 'beach toy', 'blow-up ball'],
  description:
    'Inflatable beach ball (40 cm) with six coloured gores (red, white, blue, yellow, white, green) and white caps; origin at its contact point.',
  dimensions_m: [0.4, 0.4, 0.4],
  triangles: 1368,
  build(m) {
    const R = 0.2;
    const b = new MeshBuilder();
    const nu = 36;
    const nv = 20;
    globe(b, [0, 0, R], R, nu, nv, (i, j) => (j < 2 || j >= nv - 2 ? 6 : Math.floor(i / (nu / 6))));
    m.part('ball', b, [
      // the first (red) gores take the main colour
      ...BEACH_BALL_COLOURS.map((hex, k) => {
        const mat = material(`Beach Ball ${k + 1}`, hex, 0.25, { coat: 0.6 });
        return k === 0 ? m.main(mat) : mat;
      }),
      material('Beach Ball Cap', '#f4f2ea', 0.25, { coat: 0.6 }),
    ]);
  },
});

const tennisBall = defineModel({
  id: 'tennis_ball',
  name: 'Tennis Ball',
  category: 'sports',
  tags: ['ball', 'tennis', 'sport', 'game', 'court', 'dog toy', 'fetch'],
  synonyms: ['tennis ball', 'fuzzy ball', 'felt ball', 'squash ball'],
  description:
    'Tennis ball (6.7 cm) in fuzzy optic yellow with its curved white seam; origin at its contact point.',
  dimensions_m: [0.069, 0.069, 0.067],
  triangles: 1136,
  build(m) {
    const R = 0.0335;
    const c: Vec3 = [0, 0, R];
    const b = new MeshBuilder();
    globe(b, c, R, 24, 14);
    // the seam: x = a cos t + b cos 3t, y = a sin t − b sin 3t, z = 2√(ab) sin 2t lies on the unit sphere when a + b = 1
    const a = 0.72;
    const bb = 0.28;
    const path: Vec3[] = [];
    for (let k = 0; k < 64; k++) {
      const t = (k / 64) * TAU;
      const d: Vec3 = [
        a * Math.cos(t) + bb * Math.cos(3 * t),
        a * Math.sin(t) - bb * Math.sin(3 * t),
        2 * Math.sqrt(a * bb) * Math.sin(2 * t),
      ];
      const rr = R - 0.0006;
      path.push([c[0] + d[0] * rr, c[1] + d[1] * rr, c[2] + d[2] * rr]);
    }
    tube(b, path, 0.0016, 4, 1, { cyclic: true });
    m.part('ball', b, [
      m.main(material('Tennis Felt', '#d2e33b', 0.95, { sheen: 1 })),
      material('Tennis Seam', '#f2f2ea', 0.8),
    ]);
  },
});

// ===================================================================== kite and spool

/** Kite geometry: spine 0.9 m, cross spar 0.75 m at 0.25 m below the nose, tail of 4 × 0.32 m. */
const KITE = { half: 0.375, spine: 0.9, cross: 0.25, segment: 0.32, segments: 4, bow: 0.035 };

const kite = defineModel({
  id: 'diamond_kite',
  name: 'Diamond Kite',
  category: 'sports',
  anchor: 'origin',
  tags: ['kite', 'diamond kite', 'flying', 'wind', 'toy', 'beach', 'park', 'sky', 'outdoor'],
  synonyms: ['kite', 'flying kite', 'eddy kite', 'paper kite', 'diamond kite', 'toy kite'],
  description:
    'Diamond kite (0.75 × 0.9 m sail in red and yellow) facing −Y nose up, with a bowed tail hanging below (2.2 m tall in all; origin under the spine at the tail end). Parts: sail, spars (with the bridle lines), a bridle empty where the flying line ties on, tail.1 (empty at the bottom tip) and tail.2 … tail.5 (tail segments, each from its origin up to the one before) for desk.tether_fly.',
  dimensions_m: [0.75, 0.242, 2.215],
  triangles: 180,
  build(m) {
    const zb = KITE.bow + KITE.segment * KITE.segments;
    const zt = zb + KITE.spine;
    const zc = zt - KITE.cross;
    const T: Vec3 = [0, 0, zt];
    const B: Vec3 = [0, 0, zb];
    const L: Vec3 = [KITE.half, 0, zc];
    const Rr: Vec3 = [-KITE.half, 0, zc];
    const C: Vec3 = [0, 0, zc];
    // the sail: two-colour panels, both sides
    const s = new MeshBuilder();
    for (const [side, dy] of [
      [-1, -0.0015],
      [1, 0.0015],
    ] as const) {
      const at = (p: Vec3): number => s.vert([p[0], p[1] + dy, p[2]]);
      const dir: Vec3 = [0, side, 0];
      faceToward(s, [at(T), at(L), at(C)], 0, dir, false);
      faceToward(s, [at(T), at(C), at(Rr)], 1, dir, false);
      faceToward(s, [at(C), at(L), at(B)], 1, dir, false);
      faceToward(s, [at(C), at(B), at(Rr)], 0, dir, false);
    }
    m.part('sail', s, [
      m.main(material('Kite Red', '#d7263d', 0.6, { sheen: 0.3 })),
      material('Kite Yellow', '#f6c026', 0.6, { sheen: 0.3 }),
    ]);
    // spars behind the sail, bridle lines in front of it
    const bridle: Vec3 = [0, -0.22, zc - 0.04];
    const sp = new MeshBuilder();
    cylinder(sp, [0, 0.008, zb], [0, 0.008, zt], 0.005, 6, 0);
    cylinder(sp, [-KITE.half, 0.016, zc], [KITE.half, 0.016, zc], 0.005, 6, 0);
    tube(sp, [[0, -0.003, zt - 0.08], bridle, [0, -0.003, zb + 0.18]], 0.0015, 4, 1);
    m.part('spars', sp, [MAT.woodLight, material('Kite Line', '#f2efe6', 0.7)]);
    m.empty('bridle', { location: bridle, size: 0.05 });
    // the tail: tail.1 at the bottom tip, then segments hanging from it
    m.empty('tail.1', { location: B, size: 0.05 });
    const tailMats = [
      material('Kite Red', '#d7263d', 0.6, { sheen: 0.3 }),
      material('Kite Yellow', '#f6c026', 0.6, { sheen: 0.3 }),
    ];
    for (let i = 1; i <= KITE.segments; i++) {
      const t = new MeshBuilder();
      box(t, [-0.018, -0.001, 0], [0.018, 0.001, KITE.segment], i % 2);
      extrude(
        t,
        [
          [0, 0],
          [0.07, 0.035],
          [0.07, -0.035],
        ],
        'y',
        -0.002,
        0.002,
        (i + 1) % 2,
      );
      extrude(
        t,
        [
          [0, 0],
          [-0.07, -0.035],
          [-0.07, 0.035],
        ],
        'y',
        -0.002,
        0.002,
        (i + 1) % 2,
      );
      m.part(`tail.${i + 1}`, t, tailMats, { location: [0, 0, zb - KITE.segment * i] });
    }
  },
});

const kiteSpool = defineModel({
  id: 'kite_spool',
  name: 'Kite Spool',
  category: 'sports',
  tags: ['kite', 'spool', 'reel', 'winder', 'string', 'line', 'toy', 'flying'],
  synonyms: ['kite reel', 'line winder', 'string reel', 'kite winder', 'kite handle', 'spool'],
  description:
    'Hand reel for a kite line (18 cm across) with flying line wound on and handle grips on both sides, standing on its rims; the string_point empty marks where the line leaves the reel.',
  dimensions_m: [0.2, 0.17, 0.17],
  triangles: 392,
  build(m) {
    const R = 0.085;
    const zc = R;
    const b = new MeshBuilder();
    for (const s of [-1, 1]) {
      cylinder(b, [s * 0.038, 0, zc], [s * 0.046, 0, zc], R, 24, 0);
      cylinder(b, [s * 0.046, 0, zc], [s * 0.1, 0, zc], 0.015, 10, 3);
    }
    cylinder(b, [-0.038, 0, zc], [0.038, 0, zc], 0.06, 24, 2);
    cylinder(b, [-0.039, 0, zc], [0.039, 0, zc], 0.028, 12, 1);
    m.part('reel', b, [
      m.main(material('Spool Plastic', '#e8432e', 0.45)),
      MAT.metal,
      material('Kite Line', '#f2efe6', 0.7),
      MAT.blackPlastic,
    ]);
    m.empty('string_point', { location: [0, 0, zc + 0.06], size: 0.03 });
  },
});

// ===================================================================== frisbee, skateboard, surfboard

const frisbee = defineModel({
  id: 'frisbee',
  name: 'Frisbee',
  category: 'sports',
  tags: ['frisbee', 'flying disc', 'disc', 'toy', 'beach', 'park', 'throw', 'sport'],
  synonyms: ['flying disc', 'flying disk', 'frisbee disc', 'ultimate disc', 'throwing disc'],
  description:
    'Flying disc (27 cm) with a domed top and rolled rim, lying dome up; origin at the rim bottom.',
  dimensions_m: [0.271, 0.271, 0.032],
  triangles: 864,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, 0.032],
        [0.06, 0.0315],
        [0.1, 0.0295],
        [0.122, 0.026],
        [0.132, 0.02],
        [0.1355, 0.012],
        [0.1345, 0.004],
        [0.13, 0],
        [0.126, 0.003],
        [0.124, 0.012],
        [0.12, 0.021],
        [0.1, 0.0255],
        [0.05, 0.0275],
        [0, 0.028],
      ],
      36,
      0,
    );
    m.part('disc', b, [m.main(material('Frisbee Plastic', '#f2552c', 0.35, { coat: 0.3 }))]);
  },
});

const skateboard = defineModel({
  id: 'skateboard',
  name: 'Skateboard',
  category: 'sports',
  tags: ['skateboard', 'skate', 'board', 'sport', 'street', 'skatepark', 'toy', 'ride'],
  synonyms: ['skate board', 'skate', 'deck', 'longboard', 'cruiser'],
  description:
    'Skateboard (0.8 m) with kicktails, black grip on top, a coloured underside, trucks and four wheels `wheel.FL/FR/BL/BR` (origin at the hub, rolling about X); the nose points −Y.',
  dimensions_m: [0.21, 0.796, 0.16],
  triangles: 1220,
  build(m) {
    const L = 0.8;
    const W = 0.105;
    const zd = 0.088;
    const thick = 0.012;
    const b = new MeshBuilder();
    const GRIP = 0;
    const PRINT = 1;
    const PLY = 2;
    const METAL = 3;
    const ys: number[] = [];
    for (let k = 0; k <= 24; k++) ys.push(-L / 2 + 0.002 + ((L - 0.004) * k) / 24);
    const width = (y: number) => {
      const e = Math.abs(y) - (L / 2 - W);
      return e > 0 ? Math.sqrt(Math.max(0, W * W - e * e)) : W;
    };
    const lift = (y: number) => 0.06 * smoothstep(0.2, 0.4, Math.abs(y)) ** 1.3;
    const rows = ys.map((y) => {
      const w = Math.max(0.012, width(y));
      const z = zd + lift(y);
      return [b.vert([-w, y, z + thick]), b.vert([w, y, z + thick]), b.vert([w, y, z]), b.vert([-w, y, z])];
    });
    for (let i = 0; i + 1 < rows.length; i++) {
      const [a, c] = [rows[i], rows[i + 1]];
      faceToward(b, [a[0], a[1], c[1], c[0]], GRIP, [0, 0, 1], true);
      faceToward(b, [a[3], a[2], c[2], c[3]], PRINT, [0, 0, -1], true);
      faceToward(b, [a[1], a[2], c[2], c[1]], PLY, [1, 0, 0], true);
      faceToward(b, [a[0], a[3], c[3], c[0]], PLY, [-1, 0, 0], true);
    }
    faceToward(b, rows[0], PLY, [0, -1, 0], false);
    faceToward(b, rows[rows.length - 1], PLY, [0, 1, 0], false);
    // trucks: baseplate, kingpin block, hanger and axle
    const hub = 0.027;
    for (const y of [-0.21, 0.21]) {
      block(b, [0, y, zd - 0.006], [0.06, 0.09, 0.012], METAL);
      block(b, [0, y, zd - 0.03], [0.04, 0.05, 0.036], METAL);
      beam(b, [-0.075, y, hub + 0.008], [0.075, y, hub + 0.008], 0.03, 0.026, METAL);
      cylinder(b, [-0.1, y, hub], [0.1, y, hub], 0.004, 6, METAL);
    }
    m.part('deck', b, [
      material('Grip Tape', '#1b1b1c', 0.95),
      m.main(material('Deck Print', '#e0572b', 0.5)),
      material('Maple Ply', '#d8b98c', 0.6),
      MAT.metal,
    ]);
    // wheels about their hubs (urethane with a bearing core)
    const w = new MeshBuilder();
    lathe(
      w,
      [
        [0.009, -0.016],
        [0.021, -0.016],
        [0.027, -0.01],
        [0.027, 0.01],
        [0.021, 0.016],
        [0.009, 0.016],
      ],
      16,
      0,
      { loop: true },
    );
    cylinder(w, [0, 0, -0.012], [0, 0, 0.012], 0.0095, 10, 1);
    const wheel = new MeshBuilder();
    appendMesh(wheel, w.build(), [], xf([0, 0, 0], [0, Math.PI / 2, 0]));
    const wid = m.mesh('wheel', wheel);
    const mats = [material('Skate Wheel', '#efe4c4', 0.5), MAT.darkMetal];
    for (const [name, x, y] of [
      ['wheel.FL', 0.085, -0.21],
      ['wheel.FR', -0.085, -0.21],
      ['wheel.BL', 0.085, 0.21],
      ['wheel.BR', -0.085, 0.21],
    ] as const)
      m.object(name, wid, mats, { location: [x, y, hub] });
  },
});

/** Half-width, half-thickness and rocker of a surfboard along t (0 nose … 1 tail). */
const BOARD = {
  width: [
    [0, 0.0],
    [0.02, 0.06],
    [0.08, 0.14],
    [0.2, 0.21],
    [0.4, 0.255],
    [0.55, 0.26],
    [0.7, 0.245],
    [0.85, 0.2],
    [0.95, 0.15],
    [1, 0.12],
  ] as Vec2[],
  thick: [
    [0, 0.006],
    [0.1, 0.018],
    [0.3, 0.03],
    [0.5, 0.033],
    [0.75, 0.03],
    [0.92, 0.02],
    [1, 0.014],
  ] as Vec2[],
  rocker: [
    [0, 0.12],
    [0.1, 0.06],
    [0.25, 0.02],
    [0.5, 0],
    [0.8, 0.008],
    [1, 0.035],
  ] as Vec2[],
};

/** Piecewise-linear lookup in (x, y) points sorted by x (clamped). */
function linear(pts: Vec2[], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++)
    if (x <= pts[i][0]) {
      const t = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    }
  return pts[pts.length - 1][1];
}

const surfboard = defineModel({
  id: 'surfboard',
  name: 'Surfboard',
  category: 'sports',
  tags: ['surfboard', 'surf', 'board', 'beach', 'sea', 'wave', 'sport', 'water', 'summer'],
  synonyms: ['surf board', 'shortboard', 'longboard', 'thruster', 'paddle board', 'board'],
  description:
    'Shortboard surfboard (2 m × 0.52 m) in turquoise with a pointed nose (−Y), nose and tail rocker, rounded rails and three fins; lying fins down with the fin tips at z = 0.',
  dimensions_m: [0.519, 2, 0.22],
  triangles: 1006,
  build(m) {
    const len = 2.0;
    const b = new MeshBuilder();
    const n = 16;
    const rings: Vec3[][] = [];
    const stations = 30;
    let lowest = Infinity;
    const yOf = (t: number) => -len / 2 + len * t;
    const bottomAt = (t: number) => linear(BOARD.rocker, t) - 0.6 * linear(BOARD.thick, t);
    rings.push([[0, yOf(0), linear(BOARD.rocker, 0)]]);
    for (let k = 1; k <= stations; k++) {
      const t = (k / stations) ** 1.15;
      const w = linear(BOARD.width, t);
      const h = linear(BOARD.thick, t);
      const z0 = linear(BOARD.rocker, t);
      const ring: Vec3[] = [];
      for (let j = 0; j < n; j++) {
        const a = (j / n) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const x = w * Math.sign(ca) * Math.abs(ca) ** 0.75;
        const z = h * Math.sign(sa) * Math.abs(sa) ** 0.9 * (sa < 0 ? 0.6 : 1);
        ring.push([x, yOf(t), z0 + z]);
      }
      rings.push(ring);
    }
    addRingSurface(b, rings, { mat: 0, smooth: true, flip: true, capEnd: true });
    // three fins under the tail
    const fins: [number, number][] = [
      [0.12, 0.885],
      [-0.12, 0.885],
      [0, 0.94],
    ];
    for (const [x, t] of fins) {
      const y = yOf(t);
      const zb = bottomAt(t) + 0.004;
      extrude(
        b,
        [
          [y - 0.06, zb],
          [y + 0.055, zb],
          [y + 0.045, zb - 0.03],
          [y + 0.01, zb - 0.1],
          [y - 0.005, zb - 0.11],
        ],
        'x',
        x - 0.0035,
        x + 0.0035,
        1,
      );
      lowest = Math.min(lowest, zb - 0.11);
    }
    b.translate(0, 0, -lowest);
    m.part('board', b, [
      m.main(material('Surfboard', '#36b0c2', 0.25, { coat: 1 })),
      material('Surf Fin', '#2b2d33', 0.4),
    ]);
  },
});

// ===================================================================== balloon

const balloon = defineModel({
  id: 'balloon',
  name: 'Balloon',
  category: 'props',
  tags: ['balloon', 'party', 'birthday', 'toy', 'celebration', 'helium', 'float'],
  synonyms: ['party balloon', 'helium balloon', 'toy balloon', 'latex balloon', 'balloons'],
  description:
    'Glossy red party balloon (28 cm across, 35 cm tall) with its knot at the origin, marked by a string_point empty where a string ties on (desk.tether_fly flies it from there).',
  dimensions_m: [0.276, 0.276, 0.345],
  triangles: 616,
  build(m) {
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, 0],
        [0.009, 0.004],
        [0.011, 0.012],
        [0.006, 0.018],
        [0.012, 0.024],
        [0.035, 0.036],
        [0.08, 0.075],
        [0.118, 0.13],
        [0.138, 0.19],
        [0.135, 0.245],
        [0.112, 0.295],
        [0.068, 0.33],
        [0, 0.345],
      ],
      28,
      0,
    );
    m.part('balloon', b, [m.main(material('Balloon Latex', '#d7263d', 0.18, { coat: 1 }))]);
    m.empty('string_point', { location: [0, 0, 0], size: 0.03 });
  },
});

export const SPORTS_MODELS: CatalogEntry[] = [
  soccerBall,
  basketball,
  beachBall,
  tennisBall,
  kite,
  kiteSpool,
  frisbee,
  skateboard,
  surfboard,
  balloon,
];
