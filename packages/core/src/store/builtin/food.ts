import type { Vec2, Vec3 } from '../../math/types';
import { MeshBuilder, addBlade, addIcoSphere, addLathe, addPrism, addTube } from '../../generate/builder';
import { Rng } from '../../generate/random';
import type { CatalogEntry } from '../types';
import {
  addCylinder,
  addTorus,
  defineModel,
  mapVerts,
  paintFaces,
  part,
  type ModelGeometry,
  type ModelMaterial,
} from './kit';

/*
 * Built-in food (CATALOG-A): watermelons (whole, half, slice), fruit, bread, cake, pizza and a
 * sandwich. Original procedural models in real sizes, lying on z = 0 with the base centred on the
 * origin; the long axis of elongated food runs along Y.
 */

const SHARP = 0.75;

const M = {
  rindDark: { name: 'Watermelon Rind Dark', color: '#1f4a22', roughness: 0.45, coat: 0.3 },
  rindLight: { name: 'Watermelon Rind Light', color: '#5d8c38', roughness: 0.45, coat: 0.3 },
  pith: { name: 'Watermelon Pith', color: '#e9efcf', roughness: 0.6 },
  flesh: { name: 'Watermelon Flesh', color: '#e0383e', roughness: 0.55, coat: 0.2 },
  seed: { name: 'Seed Black', color: '#1a1412', roughness: 0.3, coat: 0.5 },
  stem: { name: 'Fruit Stem', color: '#5b3f22', roughness: 0.8 },
  leaf: { name: 'Fruit Leaf', color: '#3f7d2c', roughness: 0.5 },
} satisfies Record<string, ModelMaterial>;

/**
 * Ellipsoid lying along Y (radii rx, ry, rz) turned from a lathe about its long axis, `around`
 * segments around and `along` rings; its lowest point on z = 0.
 */
function addLongEllipsoid(
  b: MeshBuilder,
  rx: number,
  ry: number,
  rz: number,
  around: number,
  along: number,
  mat: number,
): void {
  const start = b.vertexCount;
  const prof: Vec2[] = [];
  for (let i = 0; i <= along; i++) {
    const t = (Math.PI * i) / along;
    prof.push([Math.sin(t), -Math.cos(t)]);
  }
  // a unit sphere turned about Z, then rotated so that its axis is the long Y axis (a proper
  // rotation: x stays, lathe z → −Y, lathe y → Z) and stretched
  addLathe(b, prof, around, { mat, smooth: true });
  mapVerts(b, start, ([x, y, z]) => [x * rx, -z * ry, y * rz + rz]);
}

/** Paints a watermelon's wavy stripes on the faces since `start` (centre height `zc`). */
function stripes(b: MeshBuilder, start: number, zc: number, length: number): void {
  paintFaces(b, start, ([x, y, z]) => {
    const a = Math.atan2(z - zc, x) + 0.09 * Math.sin((y / length) * 7);
    return Math.floor(((a + Math.PI) / (2 * Math.PI)) * 16) % 2 === 0 ? 0 : 1;
  });
}

function watermelon(): ModelGeometry {
  const b = new MeshBuilder();
  addLongEllipsoid(b, 0.12, 0.19, 0.115, 48, 20, 0);
  stripes(b, 0, 0.115, 0.19);
  // a dried stem nub at one end
  addTube(
    b,
    [
      [0, 0.188, 0.115],
      [0, 0.205, 0.12],
    ],
    0.006,
    6,
    { mat: 2, smooth: true },
  );
  return { parts: [part('watermelon', b, [M.rindDark, M.rindLight, M.stem])] };
}

/** Elliptic cap at height z with concentric bands: [scale of the radii, material] outside in. */
function ellipseCap(
  b: MeshBuilder,
  rx: number,
  ry: number,
  z: number,
  bands: [number, number][],
  segs: number,
  seam = 0,
): void {
  const rings = bands.map(([s]) =>
    Array.from({ length: segs }, (_, j) => {
      const a = seam + (2 * Math.PI * j) / segs;
      return b.vert([rx * s * Math.cos(a), ry * s * Math.sin(a), z]);
    }),
  );
  const centre = b.vert([0, 0, z]);
  for (let i = 0; i < rings.length; i++) {
    const outer = rings[i];
    const inner = rings[i + 1];
    const mat = bands[i][1];
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      if (inner) b.face([outer[j], outer[j1], inner[j1], inner[j]], mat);
      else b.face([outer[j], outer[j1], centre], mat);
    }
  }
}

/** Seeds: small dark drops pressed into a surface at height z, inside the ellipse (rx, ry). */
function seeds(
  b: MeshBuilder,
  rng: Rng,
  rx: number,
  ry: number,
  z: number,
  n: number,
  mat: number,
  half = false,
): void {
  for (let i = 0; i < n; i++) {
    const a = half ? rng.range(0.15, Math.PI - 0.15) : (2 * Math.PI * i) / n + rng.spread(0.2);
    const r = rng.range(0.35, 0.7);
    const c: Vec3 = [Math.cos(a) * rx * r, Math.sin(a) * ry * r, z];
    const start = b.vertexCount;
    addIcoSphere(b, [0, 0, 0], [0.0045, 0.0075, 0.002], 1, { mat });
    const rot = a + Math.PI / 2;
    mapVerts(b, start, ([x, y, zz]) => [
      c[0] + x * Math.cos(rot) - y * Math.sin(rot),
      c[1] + x * Math.sin(rot) + y * Math.cos(rot),
      c[2] + zz,
    ]);
  }
}

function watermelonHalf(): ModelGeometry {
  const rx = 0.12;
  const ry = 0.19;
  const rz = 0.115;
  const b = new MeshBuilder();
  // the lower half of the melon: a half ellipsoid turned about Z from the bottom to the rim
  const prof: Vec2[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = ((Math.PI / 2) * i) / steps;
    prof.push([Math.sin(t), -Math.cos(t)]);
  }
  addLathe(b, prof, 48, { mat: 0, smooth: true });
  mapVerts(b, 0, ([x, y, z]) => [x * rx, y * ry, z * rz + rz]);
  stripes(b, 0, rz, ry);
  // the cut face: rind, pith and flesh
  ellipseCap(
    b,
    rx,
    ry,
    rz,
    [
      [1, 0],
      [0.96, 2],
      [0.86, 3],
    ],
    48,
  );
  const s = new MeshBuilder();
  seeds(s, new Rng(9), rx, ry, rz + 0.0005, 18, 0);
  return {
    parts: [part('melon', b, [M.rindDark, M.rindLight, M.pith, M.flesh]), part('seeds', s, [M.seed])],
  };
}

function watermelonSlice(): ModelGeometry {
  const R = 0.13;
  const t = 0.03;
  const segs = 24;
  const radii: [number, number][] = [
    [1, 0],
    [0.95, 1],
    [0.86, 2],
  ];
  const b = new MeshBuilder();
  const ringAt = (z: number) =>
    radii.map(([s]) =>
      Array.from({ length: segs + 1 }, (_, k) => {
        const a = (Math.PI * k) / segs;
        return b.vert([R * s * Math.cos(a), R * s * Math.sin(a), z]);
      }),
    );
  const top = ringAt(t);
  const bot = ringAt(0);
  const ct = b.vert([0, 0, t]);
  const cb = b.vert([0, 0, 0]);
  for (let i = 0; i < radii.length; i++)
    for (let k = 0; k < segs; k++) {
      const mat = radii[i][1];
      if (i + 1 < radii.length) {
        b.face([top[i][k], top[i][k + 1], top[i + 1][k + 1], top[i + 1][k]], mat);
        b.face([bot[i][k], bot[i + 1][k], bot[i + 1][k + 1], bot[i][k + 1]], mat);
      } else {
        b.face([top[i][k], top[i][k + 1], ct], mat);
        b.face([bot[i][k], cb, bot[i][k + 1]], mat);
      }
    }
  // the rind side along the arc
  for (let k = 0; k < segs; k++) b.face([bot[0][k], bot[0][k + 1], top[0][k + 1], top[0][k]], 0, true);
  // the flat side along the diameter: rind, pith, flesh, then back out
  const line = (z: 'top' | 'bot') => {
    const r = z === 'top' ? top : bot;
    const c = z === 'top' ? ct : cb;
    return [r[0][0], r[1][0], r[2][0], c, r[2][segs], r[1][segs], r[0][segs]];
  };
  const lt = line('top');
  const lb = line('bot');
  const mats = [0, 1, 2, 2, 1, 0];
  for (let i = 0; i < lt.length - 1; i++) b.face([lb[i + 1], lb[i], lt[i], lt[i + 1]], mats[i]);
  const s = new MeshBuilder();
  seeds(s, new Rng(4), R * 0.8, R * 0.8, t + 0.0005, 9, 0, true);
  return {
    parts: [
      part('slice', b, [M.rindDark, M.pith, M.flesh], { sharpAngle: SHARP }),
      part('seeds', s, [M.seed]),
    ],
  };
}

function apple(): ModelGeometry {
  const b = new MeshBuilder();
  addLathe(
    b,
    [
      [0, 0.006],
      [0.012, 0.001],
      [0.026, 0.002],
      [0.037, 0.012],
      [0.043, 0.032],
      [0.042, 0.05],
      [0.035, 0.065],
      [0.022, 0.073],
      [0.01, 0.071],
      [0, 0.064],
    ],
    24,
    { mat: 0, smooth: true },
  );
  // a blush on one side
  paintFaces(b, 0, ([x, y]) => (x * 0.7 + y * 0.7 > 0.018 ? 1 : 0));
  const stem = new MeshBuilder();
  addTube(
    stem,
    [
      [0, 0, 0.06],
      [0.002, 0, 0.078],
      [0.006, 0, 0.088],
    ],
    0.0018,
    5,
    { mat: 0, smooth: true },
  );
  addBlade(
    stem,
    [
      [0.004, 0, 0.082],
      [0.016, 0.006, 0.088],
      [0.03, 0.008, 0.087],
    ],
    [0, 0.016, 0],
    [0, 0.0015, 0],
    [
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ],
    { mat: 1, smooth: true },
  );
  return {
    parts: [
      part('apple', b, [
        { name: 'Apple Red', color: '#b3242c', roughness: 0.35, coat: 0.4, tint: true },
        { name: 'Apple Blush', color: '#cf5a2a', roughness: 0.35, coat: 0.4 },
      ]),
      part('stem', stem, [M.stem, M.leaf]),
    ],
  };
}

function orange(): ModelGeometry {
  const b = new MeshBuilder();
  const prof: Vec2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = (Math.PI * i) / 12;
    prof.push([0.04 * Math.sin(t), 0.039 - 0.039 * Math.cos(t)]);
  }
  addLathe(b, prof, 24, { mat: 0, smooth: true });
  addCylinder(b, 0, 0, 0.005, 0.0765, 0.08, 6, { mat: 1 });
  return {
    parts: [
      part('orange', b, [{ name: 'Orange Peel', color: '#e8801c', roughness: 0.6, tint: true }, M.leaf]),
    ],
  };
}

function banana(): ModelGeometry {
  const b = new MeshBuilder();
  const R = 0.14;
  const n = 14;
  const path: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -0.65 + (1.3 * i) / n;
    path.push([R * Math.sin(a), R - R * Math.cos(a), 0]);
  }
  // fat in the middle, narrowing to the stalk and the tip; a five-sided (ridged) peel
  const radius = (i: number) => {
    const t = i / n;
    return 0.004 + 0.015 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.6);
  };
  addTube(b, path, radius, 5, { mat: 0, smooth: false, up: [0, 0, 1] });
  // stalk and dark tip
  const first = path[0];
  const second = path[1];
  const dir: Vec3 = [first[0] - second[0], first[1] - second[1], 0];
  const l = Math.hypot(dir[0], dir[1]);
  addTube(b, [first, [first[0] + (dir[0] / l) * 0.025, first[1] + (dir[1] / l) * 0.025, 0]], 0.004, 5, {
    mat: 1,
  });
  const last = path[n];
  addIcoSphere(b, last, [0.004, 0.004, 0.004], 1, { mat: 1 });
  return {
    parts: [
      part(
        'banana',
        b,
        [
          { name: 'Banana Peel', color: '#f0cf3a', roughness: 0.5, tint: true },
          { name: 'Banana Tip', color: '#4a3520', roughness: 0.7 },
        ],
        { sharpAngle: 1.2 },
      ),
    ],
  };
}

function breadLoaf(): ModelGeometry {
  const b = new MeshBuilder();
  addLongEllipsoid(b, 0.085, 0.145, 0.06, 36, 24, 0);
  // flatten the underside, keep the domed top
  mapVerts(b, 0, ([x, y, z]) => [x, y, z < 0.06 ? 0.06 - (0.06 - z) * 0.45 : z]);
  // diagonal scores across the top
  paintFaces(b, 0, ([x, y, z]) => {
    if (z < 0.08) return 0;
    const u = y + x * 0.6;
    return Math.abs(u - Math.round(u / 0.07) * 0.07) < 0.011 && Math.abs(y) < 0.11 ? 1 : 0;
  });
  return {
    parts: [
      part('bread', b, [
        { name: 'Bread Crust', color: '#b87a3a', roughness: 0.75, tint: true },
        { name: 'Bread Score', color: '#e2bf83', roughness: 0.8 },
      ]),
    ],
  };
}

function cake(): ModelGeometry {
  const b = new MeshBuilder();
  const R = 0.11;
  const h = 0.09;
  // board, cake and its frosting, a piped border and cherries, three candles
  addLathe(
    b,
    [
      [0, 0],
      [R + 0.025, 0],
      [R + 0.025, 0.006],
      [0, 0.006],
    ],
    40,
    { mat: 4, smooth: true },
  );
  addLathe(
    b,
    [
      [0, 0.006],
      [R, 0.006],
      [R, h - 0.01],
      [R - 0.008, h],
      [0, h + 0.002],
    ],
    40,
    { mat: 0, smooth: true },
  );
  addTorus(b, [0, 0, h - 0.004], R - 0.006, 0.008, 40, 8, { mat: 1 });
  addTorus(b, [0, 0, 0.012], R + 0.002, 0.007, 40, 8, { mat: 1 });
  for (let k = 0; k < 8; k++) {
    const a = (2 * Math.PI * k) / 8;
    addIcoSphere(
      b,
      [Math.cos(a) * (R - 0.02), Math.sin(a) * (R - 0.02), h + 0.01],
      [0.009, 0.009, 0.009],
      2,
      { mat: 2 },
    );
  }
  for (let k = 0; k < 3; k++) {
    const a = (2 * Math.PI * k) / 3 + 0.4;
    const x = Math.cos(a) * 0.04;
    const y = Math.sin(a) * 0.04;
    addCylinder(b, x, y, 0.004, h, h + 0.06, 8, { mat: 3 });
    addIcoSphere(b, [x, y, h + 0.07], [0.004, 0.004, 0.009], 1, { mat: 5 });
  }
  return {
    parts: [
      part(
        'cake',
        b,
        [
          { name: 'Frosting', color: '#f6eee2', roughness: 0.4, coat: 0.3, tint: true },
          { name: 'Icing Pink', color: '#ef9ab2', roughness: 0.4, coat: 0.3 },
          { name: 'Cherry', color: '#a8141e', roughness: 0.2, coat: 0.8 },
          { name: 'Candle Blue', color: '#6fa8dc', roughness: 0.5 },
          { name: 'Cake Board', color: '#d9b878', roughness: 0.4, metallic: 0.6 },
          { name: 'Flame', color: '#ffc861', roughness: 0.5, emission: { color: '#ffb347', strength: 4 } },
        ],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

function pizza(): ModelGeometry {
  const R = 0.15;
  const b = new MeshBuilder();
  // base disc with the crust ring around it
  addLathe(
    b,
    [
      [0, 0],
      [R - 0.012, 0],
      [R - 0.012, 0.012],
      [0, 0.012],
    ],
    40,
    { mat: 0, smooth: true },
  );
  addTorus(b, [0, 0, 0.011], R - 0.012, 0.011, 40, 8, { mat: 1 });
  // cheese over sauce: the top's faces painted in patches
  const top = new MeshBuilder();
  const rings = 6;
  const segs = 28;
  const rng = new Rng(2);
  const verts: number[][] = [];
  for (let i = 1; i <= rings; i++) {
    const r = ((R - 0.016) * i) / rings;
    verts.push(
      Array.from({ length: segs }, (_, j) =>
        top.vert([
          r * Math.cos((2 * Math.PI * j) / segs),
          r * Math.sin((2 * Math.PI * j) / segs),
          0.0125 + rng.range(0, 0.002),
        ]),
      ),
    );
  }
  const c = top.vert([0, 0, 0.0135]);
  for (let j = 0; j < segs; j++) top.face([c, verts[0][j], verts[0][(j + 1) % segs]], 0, true);
  for (let i = 0; i + 1 < rings; i++)
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      top.face([verts[i][j], verts[i + 1][j], verts[i + 1][j1], verts[i][j1]], 0, true);
    }
  paintFaces(top, 0, ([x, y]) => (Math.sin(x * 61) * Math.cos(y * 53) > 0.55 ? 1 : 0));
  // pepperoni and basil
  for (let k = 0; k < 9; k++) {
    const a = (2 * Math.PI * k) / 9 + rng.spread(0.2);
    const r = k === 0 ? 0 : rng.range(0.05, 0.1);
    addCylinder(top, Math.cos(a) * r, Math.sin(a) * r, 0.017, 0.013, 0.0175, 14, { mat: 2 });
  }
  for (let k = 0; k < 4; k++) {
    const a = (2 * Math.PI * k) / 4 + 0.6;
    const p: Vec3 = [Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0.017];
    addBlade(
      top,
      [p, [p[0] + 0.01, p[1] + 0.006, 0.0185], [p[0] + 0.02, p[1] + 0.008, 0.017]],
      [0, 0.012, 0],
      [0, 0.001, 0],
      [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ],
      { mat: 3, smooth: true },
    );
  }
  return {
    parts: [
      part('base', b, [
        { name: 'Tomato Sauce', color: '#b3301c', roughness: 0.5 },
        { name: 'Pizza Crust', color: '#d49a4a', roughness: 0.7 },
      ]),
      part('toppings', top, [
        { name: 'Mozzarella', color: '#f1d27a', roughness: 0.45, coat: 0.2, tint: true },
        { name: 'Tomato Sauce', color: '#b3301c', roughness: 0.5 },
        { name: 'Pepperoni', color: '#8f2018', roughness: 0.4, coat: 0.3 },
        { name: 'Basil', color: '#2f6b2a', roughness: 0.5 },
      ]),
    ],
  };
}

function sandwich(): ModelGeometry {
  const b = new MeshBuilder();
  const tri = (s: number): Vec2[] => [
    [-0.06 * s, -0.06 * s],
    [0.06 * s, -0.06 * s],
    [-0.06 * s, 0.06 * s],
  ];
  // bread, lettuce, cheese, tomato, bread
  const layers: [number, number, number, number][] = [
    [0, 0.016, 1, 0],
    [0.016, 0.02, 1.08, 1],
    [0.02, 0.024, 1.02, 2],
    [0.024, 0.031, 0.96, 3],
    [0.031, 0.035, 1.06, 1],
    [0.035, 0.051, 1, 0],
  ];
  // slices show crumb on their faces and crust round the edges
  for (const [z0, z1, s, mat] of layers) addPrism(b, tri(s), z0, z1, { mat, capMat: mat === 0 ? 4 : mat });
  // a cocktail stick with an olive on top
  addCylinder(b, -0.02, -0.02, 0.0018, 0.01, 0.075, 6, { mat: 5 });
  addIcoSphere(b, [-0.02, -0.02, 0.062], [0.009, 0.009, 0.011], 2, { mat: 6 });
  return {
    parts: [
      part(
        'sandwich',
        b,
        [
          { name: 'Bread Crust', color: '#b87a3a', roughness: 0.75 },
          { name: 'Lettuce', color: '#6fae3a', roughness: 0.5, coat: 0.2 },
          { name: 'Cheese', color: '#f2c14e', roughness: 0.45 },
          { name: 'Tomato', color: '#d2352b', roughness: 0.35, coat: 0.4 },
          { name: 'Bread Crumb', color: '#ecd6a4', roughness: 0.85, tint: true },
          { name: 'Cocktail Stick', color: '#e3c99a', roughness: 0.7 },
          { name: 'Olive', color: '#4f5a22', roughness: 0.3, coat: 0.6 },
        ],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

const FOOD = ['food', 'eat', 'kitchen'];

/** The built-in food. */
export const FOOD_MODELS: CatalogEntry[] = [
  defineModel({
    id: 'watermelon',
    name: 'Watermelon',
    category: 'food',
    tags: [...FOOD, 'fruit', 'melon', 'summer', 'picnic'],
    synonyms: ['melon', 'whole watermelon'],
    description: 'A whole striped watermelon lying on its side.',
    dimensions_m: [0.24, 0.4, 0.23],
    triangles: 1844,
    // the fruit keeps its own colours (no material takes `color`)
    color: false,
    geometry: watermelon,
  }),
  defineModel({
    id: 'watermelon_half',
    name: 'Half watermelon',
    category: 'food',
    tags: [...FOOD, 'fruit', 'melon', 'summer', 'picnic', 'cut'],
    synonyms: ['watermelon half', 'halved watermelon', 'cut watermelon', 'melon half'],
    description: 'A watermelon cut in half lengthwise, red flesh and seeds facing up.',
    dimensions_m: [0.24, 0.38, 0.12],
    triangles: 1320,
    // the fruit keeps its own colours (no material takes `color`)
    color: false,
    geometry: watermelonHalf,
  }),
  defineModel({
    id: 'watermelon_slice',
    name: 'Watermelon slice',
    category: 'food',
    tags: [...FOOD, 'fruit', 'melon', 'summer', 'picnic', 'cut', 'handheld'],
    synonyms: ['slice of watermelon', 'melon slice', 'watermelon wedge', 'wedge'],
    description: 'A half-moon slice of watermelon lying flat.',
    dimensions_m: [0.26, 0.13, 0.032],
    triangles: 480,
    // the fruit keeps its own colours (no material takes `color`)
    color: false,
    geometry: watermelonSlice,
  }),
  defineModel({
    id: 'apple',
    name: 'Apple',
    category: 'food',
    tags: [...FOOD, 'fruit', 'handheld', 'small'],
    synonyms: ['red apple', 'green apple'],
    description: 'A red apple with a stalk and a leaf.',
    dimensions_m: [0.086, 0.086, 0.088],
    triangles: 418,
    geometry: apple,
  }),
  defineModel({
    id: 'orange',
    name: 'Orange',
    category: 'food',
    tags: [...FOOD, 'fruit', 'citrus', 'handheld', 'small'],
    synonyms: ['mandarin', 'tangerine', 'clementine', 'citrus'],
    description: 'A whole round orange with a short green stalk.',
    dimensions_m: [0.08, 0.08, 0.08],
    triangles: 552,
    geometry: orange,
  }),
  defineModel({
    id: 'banana',
    name: 'Banana',
    category: 'food',
    tags: [...FOOD, 'fruit', 'handheld', 'small'],
    synonyms: ['plantain'],
    description: 'A ripe banana lying on its side.',
    dimensions_m: [0.2, 0.064, 0.034],
    triangles: 182,
    geometry: banana,
  }),
  defineModel({
    id: 'bread',
    name: 'Bread loaf',
    category: 'food',
    tags: [...FOOD, 'bread', 'bakery', 'breakfast', 'picnic'],
    synonyms: ['loaf', 'bread', 'baguette', 'bloomer', 'loaf of bread'],
    description: 'A scored crusty loaf of bread.',
    dimensions_m: [0.17, 0.29, 0.087],
    triangles: 1656,
    geometry: breadLoaf,
  }),
  defineModel({
    id: 'cake',
    name: 'Cake',
    category: 'food',
    tags: [...FOOD, 'dessert', 'party', 'birthday', 'bakery'],
    synonyms: ['birthday cake', 'gateau', 'dessert', 'layer cake'],
    description: 'A frosted round cake with cherries and three lit candles on a board.',
    dimensions_m: [0.27, 0.27, 0.17],
    triangles: 2476,
    geometry: cake,
  }),
  defineModel({
    id: 'pizza',
    name: 'Pizza',
    category: 'food',
    tags: [...FOOD, 'dinner', 'party', 'italian'],
    synonyms: ['pepperoni pizza', 'pizza pie', 'margherita'],
    description: 'A 30 cm pepperoni pizza.',
    dimensions_m: [0.3, 0.3, 0.022],
    triangles: 1644,
    geometry: pizza,
  }),
  defineModel({
    id: 'sandwich',
    name: 'Sandwich',
    category: 'food',
    tags: [...FOOD, 'lunch', 'picnic', 'bread', 'handheld'],
    synonyms: ['sarnie', 'sub', 'club sandwich', 'toastie'],
    description: 'A triangular sandwich half with lettuce, cheese and tomato.',
    dimensions_m: [0.13, 0.13, 0.075],
    triangles: 152,
    geometry: sandwich,
  }),
];
