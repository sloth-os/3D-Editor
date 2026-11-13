import { z } from 'zod';
import type { Vec2, Vec3 } from '../../math/types';
import {
  MeshBuilder,
  addBlade,
  addBox,
  addBoxBetween,
  addIcoSphere,
  addLathe,
  addPrism,
  addTube,
} from '../../generate/builder';
import { Rng } from '../../generate/random';
import type { CatalogEntry } from '../types';
import {
  MATS,
  addCylinder,
  addRoundLeg,
  addRoundedBox,
  addTorus,
  defineModel,
  mapVerts,
  offsetVerts,
  paintFaces,
  part,
  type ModelGeometry,
  type ModelMaterial,
} from './kit';

/*
 * Built-in props (CATALOG-A): lamps and electronics, tableware, decoration, bags and boxes,
 * outdoor and household items, kitchen appliances and office pieces. Original procedural models in
 * real sizes, standing on z = 0 (wall pieces hang from their bottom edge) with the base centred on
 * the origin and the front facing −Y. The main material of each takes the `color` option.
 */

const SHARP = 0.75;
const DEG = Math.PI / 180;

const tinted = (
  name: string,
  color: string,
  roughness: number,
  extra: Partial<ModelMaterial> = {},
): ModelMaterial => ({
  name,
  color,
  roughness,
  ...extra,
  tint: true,
});

/** Rotates the vertices added since `start` about +Z by `a` radians (around the origin). */
function rotZ(b: MeshBuilder, start: number, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  mapVerts(b, start, ([x, y, z]) => [x * c - y * s, x * s + y * c, z]);
}

/** Rotates the vertices added since `start` about +X by `a` radians (around the origin). */
function rotX(b: MeshBuilder, start: number, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  mapVerts(b, start, ([x, y, z]) => [x, y * c - z * s, y * s + z * c]);
}

/** Half circle arc from a to b bulging towards `up` (for handles), `n` segments. */
function arc(a: Vec3, b: Vec3, up: Vec3, n: number, bulge = 1): Vec3[] {
  const c: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const r: Vec3 = [(a[0] - b[0]) / 2, (a[1] - b[1]) / 2, (a[2] - b[2]) / 2];
  const len = Math.hypot(r[0], r[1], r[2]) * bulge;
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (Math.PI * i) / n;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    pts.push([
      c[0] + r[0] * ct + up[0] * len * st,
      c[1] + r[1] * ct + up[1] * len * st,
      c[2] + r[2] * ct + up[2] * len * st,
    ]);
  }
  return pts;
}

/**
 * A hollow vessel turned about Z from its outer profile ([r, z] from the bottom centre out and up
 * to the rim), with walls `t` thick: mugs, bowls, pots, vases, buckets.
 */
function addVessel(b: MeshBuilder, outer: readonly Vec2[], t: number, segments: number, mat: number): void {
  const prof: Vec2[] = [[0, outer[0][1]], ...outer];
  const rim = outer[outer.length - 1];
  const inner: Vec2[] = [];
  for (let i = outer.length - 1; i >= 1; i--) {
    const [r, z] = outer[i];
    inner.push([Math.max(0.001, r - t), i === outer.length - 1 ? rim[1] : Math.max(outer[0][1] + t, z)]);
  }
  inner.push([0, outer[0][1] + t]);
  addLathe(b, [...prof, ...inner], segments, { mat, smooth: true });
}

// ---------------------------------------------------------------- lamps and electronics

function floorLamp(): ModelGeometry {
  const b = new MeshBuilder();
  addLathe(
    b,
    [
      [0, 0],
      [0.15, 0],
      [0.15, 0.015],
      [0.13, 0.03],
      [0, 0.03],
    ],
    32,
    { mat: 0, smooth: true },
  );
  addCylinder(b, 0, 0, 0.012, 0.03, 1.38, 12, { mat: 0 });
  const shade = new MeshBuilder();
  // a thin open drum shade (inner and outer walls), lighter inside
  addLathe(
    shade,
    [
      [0.2, 1.3],
      [0.135, 1.62],
      [0.13, 1.62],
      [0.195, 1.3],
    ],
    40,
    { mat: 0, smooth: true, loop: true },
  );
  addIcoSphere(shade, [0, 0, 1.4], [0.04, 0.04, 0.05], 2, { mat: 1 });
  return {
    parts: [
      part('stand', b, [MATS.blackMetal], { sharpAngle: SHARP }),
      part(
        'shade',
        shade,
        [
          tinted('Lamp Shade', '#efe3c8', 0.85, { sheen: 0.3 }),
          {
            name: 'Warm Bulb',
            color: '#fff3d6',
            roughness: 0.3,
            emission: { color: '#ffd9a0', strength: 3 },
          },
        ],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

function tableLamp(): ModelGeometry {
  const b = new MeshBuilder();
  addLathe(
    b,
    [
      [0, 0],
      [0.06, 0],
      [0.085, 0.07],
      [0.08, 0.15],
      [0.04, 0.22],
      [0.02, 0.24],
      [0, 0.24],
    ],
    28,
    { mat: 0, smooth: true },
  );
  addCylinder(b, 0, 0, 0.008, 0.24, 0.32, 8, { mat: 1 });
  const shade = new MeshBuilder();
  addLathe(
    shade,
    [
      [0.16, 0.28],
      [0.12, 0.47],
      [0.115, 0.47],
      [0.155, 0.28],
    ],
    36,
    { mat: 0, smooth: true, loop: true },
  );
  addIcoSphere(shade, [0, 0, 0.34], [0.03, 0.03, 0.035], 2, { mat: 1 });
  return {
    parts: [
      part('base', b, [tinted('Lamp Ceramic', '#3f6f8a', 0.25, { coat: 0.6 }), MATS.steel], {
        sharpAngle: SHARP,
      }),
      part(
        'shade',
        shade,
        [
          { name: 'Lamp Shade', color: '#efe3c8', roughness: 0.85, sheen: 0.3 },
          {
            name: 'Warm Bulb',
            color: '#fff3d6',
            roughness: 0.3,
            emission: { color: '#ffd9a0', strength: 3 },
          },
        ],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

/** Flat TV of `inches` diagonal (16:9) on a pedestal stand. */
function tv(inches: number): ModelGeometry {
  const diag = inches * 0.0254;
  const sw = (diag * 16) / Math.hypot(16, 9);
  const sh = (diag * 9) / Math.hypot(16, 9);
  const bez = 0.012;
  const w = sw + 2 * bez;
  const h = sh + 2 * bez;
  const z0 = 0.075;
  const body = new MeshBuilder();
  addRoundedBox(body, [-w / 2, -0.012, z0], [w / 2, 0.025, z0 + h], 0.006, { mat: 0, cs: 2 });
  // back hump
  addRoundedBox(body, [-w * 0.3, 0.02, z0 + h * 0.15], [w * 0.3, 0.055, z0 + h * 0.7], 0.012, {
    mat: 0,
    cs: 2,
  });
  // pedestal: neck and base plate
  addBox(body, [-0.04, 0.01, 0.012], [0.04, 0.035, z0 + 0.1], { mat: 1 });
  addRoundedBox(body, [-0.18, -0.09, 0], [0.18, 0.12, 0.014], 0.005, { mat: 1, cs: 2 });
  const screen = new MeshBuilder();
  addBox(screen, [-sw / 2, -0.0135, z0 + bez], [sw / 2, -0.011, z0 + bez + sh], { mat: 0 });
  return {
    parts: [
      part('body', body, [tinted('TV Black', '#16171a', 0.35), MATS.blackMetal], { sharpAngle: SHARP }),
      part('screen', screen, [MATS.screen]),
    ],
  };
}

function laptop(): ModelGeometry {
  const w = 0.32;
  const d = 0.22;
  const t = 0.012;
  const base = new MeshBuilder();
  addRoundedBox(base, [-w / 2, -d / 2, 0], [w / 2, d / 2, t], 0.004, { mat: 0, cs: 2 });
  // keyboard well and touchpad
  addBox(base, [-w / 2 + 0.02, -d / 2 + 0.09, t - 0.0005], [w / 2 - 0.02, d / 2 - 0.02, t + 0.0008], {
    mat: 1,
  });
  addBox(base, [-0.045, -d / 2 + 0.015, t - 0.0005], [0.045, -d / 2 + 0.075, t + 0.0005], { mat: 2 });
  const lid = new MeshBuilder();
  const lt = 0.007;
  addRoundedBox(lid, [-w / 2, 0, 0], [w / 2, lt, d], 0.003, { mat: 0, cs: 2 });
  addBox(lid, [-w / 2 + 0.012, -0.0008, 0.012], [w / 2 - 0.012, 0.001, d - 0.02], { mat: 1 });
  // the lid opens 110° from the back edge: rotate about the hinge line
  const open = (110 - 90) * DEG;
  rotX(lid, 0, -open);
  offsetVerts(lid, 0, [0, d / 2 - 0.004, t]);
  return {
    parts: [
      part(
        'base',
        base,
        [tinted('Laptop Aluminium', '#a9adb3', 0.3, { metallic: 1 }), MATS.blackPlastic, MATS.greyPlastic],
        { sharpAngle: SHARP },
      ),
      part('lid', lid, [tinted('Laptop Aluminium', '#a9adb3', 0.3, { metallic: 1 }), MATS.litScreen], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

function monitor(): ModelGeometry {
  const sw = 0.6;
  const sh = 0.34;
  const z0 = 0.12;
  const b = new MeshBuilder();
  addRoundedBox(b, [-sw / 2 - 0.008, -0.012, z0], [sw / 2 + 0.008, 0.012, z0 + sh + 0.016], 0.004, {
    mat: 0,
    cs: 2,
  });
  addRoundedBox(b, [-0.12, 0.008, z0 + 0.06], [0.12, 0.035, z0 + 0.25], 0.01, { mat: 0, cs: 2 });
  addBox(b, [-0.03, 0.03, 0.01], [0.03, 0.05, z0 + 0.2], { mat: 1 });
  addRoundedBox(b, [-0.12, -0.08, 0], [0.12, 0.12, 0.012], 0.006, { mat: 1, cs: 2 });
  const screen = new MeshBuilder();
  addBox(screen, [-sw / 2, -0.0135, z0 + 0.008], [sw / 2, -0.011, z0 + 0.008 + sh], { mat: 0 });
  return {
    parts: [
      part('monitor', b, [tinted('Monitor Black', '#1b1c1f', 0.4), MATS.blackMetal], { sharpAngle: SHARP }),
      part('screen', screen, [MATS.litScreen]),
    ],
  };
}

function phone(): ModelGeometry {
  const b = new MeshBuilder();
  addRoundedBox(b, [-0.036, -0.075, 0], [0.036, 0.075, 0.008], 0.0035, { mat: 0, cs: 3 });
  addBox(b, [-0.033, -0.071, 0.0072], [0.033, 0.071, 0.0083], { mat: 1 });
  addCylinder(b, -0.02, 0.055, 0.006, -0.0008, 0.0002, 12, { mat: 2 });
  return {
    parts: [
      part('phone', b, [tinted('Phone Case', '#2a2d33', 0.35), MATS.litScreen, MATS.blackMetal], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

// ---------------------------------------------------------------- books

/** A closed hardback lying flat: cover boards and spine around a block of pages. */
function addBook(b: MeshBuilder, w: number, d: number, t: number, cover: number, pages: number): void {
  const c = 0.003;
  addBox(b, [-w / 2 + 0.004, -d / 2, 0], [w / 2, d / 2, c], { mat: cover });
  addBox(b, [-w / 2 + 0.004, -d / 2, t - c], [w / 2, d / 2, t], { mat: cover });
  // rounded spine: a half tube along the binding, closed at head and tail
  const r = t / 2;
  const ids = [-d / 2, d / 2].map((y) => {
    const ring: number[] = [];
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI / 2 + (Math.PI * k) / 6;
      ring.push(b.vert([-w / 2 + 0.004 + r * 0.45 * Math.cos(a), y, r + r * Math.sin(a)]));
    }
    return ring;
  });
  for (let k = 0; k < 6; k++) b.face([ids[0][k], ids[0][k + 1], ids[1][k + 1], ids[1][k]], cover, true);
  b.face(ids[1].slice(), cover);
  b.face(ids[0].slice().reverse(), cover);
  addBox(b, [-w / 2 + 0.004, -d / 2 + 0.004, c], [w / 2 - 0.004, d / 2 - 0.004, t - c], { mat: pages });
}

function book(): ModelGeometry {
  const b = new MeshBuilder();
  addBook(b, 0.165, 0.24, 0.032, 0, 1);
  // a ribbon bookmark hanging out at the foot
  addBox(b, [0.02, -0.155, 0.012], [0.028, -0.116, 0.0135], { mat: 2 });
  return {
    parts: [
      part(
        'book',
        b,
        [
          tinted('Book Cover', '#7a2e2e', 0.55),
          MATS.paper,
          { name: 'Ribbon Gold', color: '#c9a44c', roughness: 0.4 },
        ],
        {
          sharpAngle: SHARP,
        },
      ),
    ],
  };
}

function bookStack(): ModelGeometry {
  const b = new MeshBuilder();
  const rng = new Rng(11);
  let z = 0;
  const covers: ModelMaterial[] = [
    tinted('Book Cover', '#7a2e2e', 0.55),
    { name: 'Book Blue', color: '#2d4a73', roughness: 0.6 },
    { name: 'Book Green', color: '#3e6249', roughness: 0.6 },
    { name: 'Book Ochre', color: '#c08a2e', roughness: 0.6 },
    { name: 'Book Black', color: '#24262b', roughness: 0.55 },
  ];
  for (let i = 0; i < 5; i++) {
    const start = b.vertexCount;
    const w = rng.range(0.15, 0.2);
    const d = rng.range(0.21, 0.27);
    const t = rng.range(0.022, 0.04);
    addBook(b, w, d, t, i, covers.length);
    rotZ(b, start, rng.spread(10 * DEG));
    offsetVerts(b, start, [rng.spread(0.012), rng.spread(0.012), z]);
    z += t;
  }
  return { parts: [part('books', b, [...covers, MATS.paper], { sharpAngle: SHARP })] };
}

// ---------------------------------------------------------------- tableware

function mug(): ModelGeometry {
  const b = new MeshBuilder();
  addVessel(
    b,
    [
      [0.038, 0],
      [0.041, 0.006],
      [0.042, 0.095],
    ],
    0.0045,
    32,
    0,
  );
  addTube(b, arc([0.04, 0, 0.078], [0.04, 0, 0.022], [1, 0, 0], 10, 0.95), 0.0065, 8, {
    mat: 0,
    smooth: true,
  });
  return {
    parts: [part('mug', b, [tinted('Mug Glaze', '#d8573c', 0.2, { coat: 0.6 })], { sharpAngle: SHARP })],
  };
}

function cup(): ModelGeometry {
  const b = new MeshBuilder();
  // saucer
  addLathe(
    b,
    [
      [0, 0],
      [0.05, 0],
      [0.072, 0.008],
      [0.075, 0.014],
      [0.07, 0.014],
      [0.05, 0.008],
      [0, 0.008],
    ],
    36,
    { mat: 0, smooth: true },
  );
  // cup on it
  const start = b.vertexCount;
  addVessel(
    b,
    [
      [0.024, 0.008],
      [0.035, 0.02],
      [0.044, 0.045],
      [0.048, 0.068],
    ],
    0.003,
    32,
    0,
  );
  void start;
  addTube(b, arc([0.044, 0, 0.06], [0.036, 0, 0.03], [1, 0, 0], 10, 0.9), 0.004, 6, { mat: 0, smooth: true });
  return {
    parts: [part('cup', b, [tinted('Porcelain', '#f3f0ea', 0.15, { coat: 0.7 })], { sharpAngle: SHARP })],
  };
}

function plate(): ModelGeometry {
  const b = new MeshBuilder();
  addLathe(
    b,
    [
      [0, 0.004],
      [0.07, 0.004],
      [0.075, 0],
      [0.085, 0],
      [0.09, 0.006],
      [0.125, 0.016],
      [0.135, 0.022],
      [0.133, 0.025],
      [0.12, 0.02],
      [0.09, 0.012],
      [0, 0.012],
    ],
    48,
    { mat: 0, smooth: true },
  );
  // a glazed band on the rim
  paintFaces(b, 0, ([x, y, z]) => (Math.hypot(x, y) > 0.112 && z > 0.014 ? 1 : 0));
  return {
    parts: [
      part(
        'plate',
        b,
        [
          { name: 'Porcelain', color: '#f3f0ea', roughness: 0.15, coat: 0.7 },
          tinted('Plate Rim', '#2f5d8a', 0.2, { coat: 0.7 }),
        ],
        {
          sharpAngle: SHARP,
        },
      ),
    ],
  };
}

function bowl(): ModelGeometry {
  const b = new MeshBuilder();
  const prof: Vec2[] = [[0.035, 0]];
  for (let i = 0; i <= 8; i++) {
    const a = (Math.PI / 2) * (i / 8);
    prof.push([0.035 + 0.045 * Math.sin(a), 0.006 + 0.058 * (1 - Math.cos(a))]);
  }
  addVessel(b, prof, 0.004, 40, 0);
  return {
    parts: [part('bowl', b, [tinted('Bowl Glaze', '#5d8aa8', 0.2, { coat: 0.6 })], { sharpAngle: SHARP })],
  };
}

function bottle(): ModelGeometry {
  const b = new MeshBuilder();
  addLathe(
    b,
    [
      [0, 0],
      [0.034, 0],
      [0.037, 0.008],
      [0.037, 0.2],
      [0.033, 0.225],
      [0.016, 0.255],
      [0.0135, 0.27],
      [0.0135, 0.29],
      [0.015, 0.292],
      [0.015, 0.298],
      [0, 0.298],
    ],
    28,
    { mat: 0, smooth: true },
  );
  // label and capsule
  const deco = new MeshBuilder();
  addLathe(
    deco,
    [
      [0.0371, 0.06],
      [0.0376, 0.06],
      [0.0376, 0.15],
      [0.0371, 0.15],
    ],
    28,
    { mat: 0, smooth: true, loop: true },
  );
  addLathe(
    deco,
    [
      [0, 0.27],
      [0.0145, 0.27],
      [0.0145, 0.3],
      [0, 0.3],
    ],
    20,
    { mat: 1, smooth: true },
  );
  return {
    parts: [
      part('bottle', b, [tinted('Bottle Glass', '#24452c', 0.08, { coat: 0.8 })], { sharpAngle: SHARP }),
      part(
        'label',
        deco,
        [MATS.paper, { name: 'Capsule Red', color: '#7c1d26', roughness: 0.35, metallic: 0.6 }],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

function wineGlass(): ModelGeometry {
  const b = new MeshBuilder();
  const prof: Vec2[] = [
    [0, 0],
    [0.036, 0],
    [0.037, 0.003],
    [0.01, 0.006],
    [0.0035, 0.012],
    [0.0035, 0.09],
    [0.012, 0.1],
  ];
  // bowl outside up to the rim, then the inside back down
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    prof.push([0.012 + 0.03 * Math.sin(t * 2.2) * (1 - 0.15 * t), 0.1 + 0.095 * t]);
  }
  const rimR = prof[prof.length - 1][0];
  prof.push([rimR - 0.0015, 0.195]);
  for (let i = 7; i >= 1; i--) {
    const t = i / 8;
    prof.push([
      Math.max(0.002, 0.012 + 0.03 * Math.sin(t * 2.2) * (1 - 0.15 * t) - 0.0015),
      0.1 + 0.095 * t + 0.002,
    ]);
  }
  prof.push([0, 0.104]);
  addLathe(b, prof, 32, { mat: 0, smooth: true });
  // the lip and the foot's edge in a brighter glass that outlines the glass
  paintFaces(b, 0, (c) => (c[2] > 0.19 || c[2] < 0.0045 ? 1 : 0));
  // red wine a third of the way up the bowl (inside its wall); the colour option changes the drink
  const wine = new MeshBuilder();
  const inner = (t: number): Vec2 => [
    Math.max(0.002, 0.012 + 0.03 * Math.sin(t * 2.2) * (1 - 0.15 * t) - 0.0025),
    0.1 + 0.095 * t + 0.002,
  ];
  const fill: Vec2[] = [[0, 0.1045]];
  for (let i = 1; i <= 4; i++) fill.push(inner((0.42 * i) / 4));
  fill.push([0, inner(0.42)[1]]);
  addLathe(wine, fill, 32, { mat: 0, smooth: true });
  return {
    parts: [
      part('glass', b, [MATS.glass, MATS.glassEdge]),
      part('wine', wine, [{ name: 'Red Wine', color: '#5a0d1c', roughness: 0.08, coat: 0.6, tint: true }]),
    ],
  };
}

// ---------------------------------------------------------------- decoration

function vaseWithFlowers(): ModelGeometry {
  const vase = new MeshBuilder();
  addVessel(
    vase,
    [
      [0.05, 0],
      [0.075, 0.06],
      [0.07, 0.16],
      [0.045, 0.22],
      [0.05, 0.25],
    ],
    0.005,
    32,
    0,
  );
  const stems = new MeshBuilder();
  const heads = new MeshBuilder();
  const rng = new Rng(5);
  for (let i = 0; i < 7; i++) {
    const a = (2 * Math.PI * i) / 7 + rng.spread(0.3);
    const lean = rng.range(0.06, 0.16);
    const h = rng.range(0.42, 0.55);
    const top: Vec3 = [Math.cos(a) * lean, Math.sin(a) * lean, h];
    const mid: Vec3 = [top[0] * 0.4, top[1] * 0.4, 0.33];
    addTube(stems, [[0, 0, 0.12], mid, top], 0.0035, 5, { mat: 0, smooth: true, caps: false });
    // a leaf halfway up
    const lv: Vec3 = [mid[0] + Math.cos(a + 1.2) * 0.06, mid[1] + Math.sin(a + 1.2) * 0.06, mid[2] - 0.02];
    addBlade(
      stems,
      [mid, [(mid[0] + lv[0]) / 2, (mid[1] + lv[1]) / 2, mid[2] + 0.01], lv],
      [0, 0.025, 0],
      [0, 0.003, 0],
      [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ],
      { mat: 0, smooth: true },
    );
    // blossom: petals around a centre
    const petals = 6;
    const color = i % 3;
    for (let k = 0; k < petals; k++) {
      const pa = (2 * Math.PI * k) / petals;
      const tip: Vec3 = [top[0] + Math.cos(pa) * 0.035, top[1] + Math.sin(pa) * 0.035, top[2] + 0.012];
      addBlade(
        heads,
        [top, [(top[0] + tip[0]) / 2, (top[1] + tip[1]) / 2, top[2] + 0.01], tip],
        [0, 0.022, 0],
        [0, 0.003, 0],
        [
          [0, 0, 1],
          [0, 0, 1],
          [0, 0, 1],
        ],
        { mat: color, smooth: true },
      );
    }
    addIcoSphere(heads, [top[0], top[1], top[2] + 0.008], [0.009, 0.009, 0.007], 1, { mat: 3 });
  }
  return {
    parts: [
      part('vase', vase, [tinted('Vase Glaze', '#2f5d7c', 0.15, { coat: 0.7 })], { sharpAngle: SHARP }),
      part('stems', stems, [{ name: 'Bouquet Stem', color: '#3f6b2a', roughness: 0.65 }]),
      part('flowers', heads, [
        { name: 'Petals Red', color: '#c8323f', roughness: 0.5, sheen: 0.3 },
        { name: 'Petals Yellow', color: '#f0c33c', roughness: 0.5, sheen: 0.3 },
        { name: 'Petals White', color: '#f4f1ea', roughness: 0.5, sheen: 0.3 },
        { name: 'Bouquet Center', color: '#e8a317', roughness: 0.6 },
      ]),
    ],
  };
}

function pottedPlant(): ModelGeometry {
  const pot = new MeshBuilder();
  addVessel(
    pot,
    [
      [0.11, 0],
      [0.15, 0.24],
      [0.165, 0.25],
      [0.165, 0.28],
    ],
    0.012,
    32,
    0,
  );
  addCylinder(pot, 0, 0, 0.145, 0.23, 0.255, 24, { mat: 1 });
  const leaves = new MeshBuilder();
  const rng = new Rng(3);
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + rng.spread(0.25);
    const up = rng.range(0.35, 0.8);
    const len = rng.range(0.32, 0.5);
    const base: Vec3 = [Math.cos(a) * 0.02, Math.sin(a) * 0.02, 0.25];
    const pts: Vec3[] = [];
    const widths: number[] = [];
    const thick: number[] = [];
    const normals: Vec3[] = [];
    const steps = 6;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      // rises then arches outwards and droops
      const r = len * t;
      const z = base[2] + len * (up * Math.sin(t * Math.PI * 0.75) + 0.25 * t);
      pts.push([base[0] + Math.cos(a) * r * (0.6 + 0.4 * t), base[1] + Math.sin(a) * r * (0.6 + 0.4 * t), z]);
      widths.push(0.075 * Math.sin(Math.PI * Math.min(1, t * 1.05)) + 0.004);
      thick.push(0.004);
      normals.push([-Math.cos(a) * 0.3, -Math.sin(a) * 0.3, 1]);
    }
    widths[steps] = 0;
    thick[steps] = 0;
    addBlade(leaves, pts, widths, thick, normals, { mat: i % 2, smooth: true });
  }
  return {
    parts: [
      part(
        'pot',
        pot,
        [tinted('Terracotta', '#b5643f', 0.85), { name: 'Soil', color: '#3a2a1e', roughness: 1 }],
        { sharpAngle: SHARP },
      ),
      part('leaves', leaves, [
        { name: 'Leaf Green', color: '#3f7a35', roughness: 0.55, sheen: 0.2 },
        { name: 'Leaf Dark Green', color: '#2c5a2a', roughness: 0.55, sheen: 0.2 },
      ]),
    ],
  };
}

/** Wall clock hanging with its face to −Y; the origin is the bottom of the rim. */
function wallClock(): ModelGeometry {
  const r = 0.15;
  const b = new MeshBuilder();
  const start = b.vertexCount;
  // rim and face around Y: build around Z, then turn the Z axis to −Y
  addLathe(
    b,
    [
      [0, 0],
      [r, 0],
      [r, 0.045],
      [r - 0.012, 0.045],
      [r - 0.012, 0.012],
      [0, 0.012],
    ],
    48,
    { mat: 0, smooth: true },
  );
  const face = new MeshBuilder();
  addLathe(
    face,
    [
      [0, 0.011],
      [r - 0.012, 0.011],
      [r - 0.012, 0.013],
      [0, 0.013],
    ],
    48,
    { mat: 0, smooth: true },
  );
  // hour marks and hands on the face
  const marks = new MeshBuilder();
  for (let k = 0; k < 12; k++) {
    const a = (2 * Math.PI * k) / 12;
    const l = k % 3 === 0 ? 0.022 : 0.012;
    const ro = r - 0.024;
    addBoxBetween(
      marks,
      [Math.cos(a) * ro, Math.sin(a) * ro, 0.0135],
      [Math.cos(a) * (ro - l), Math.sin(a) * (ro - l), 0.0135],
      k % 3 === 0 ? 0.006 : 0.003,
      0.002,
      [0, 0, 1],
      { mat: 0 },
    );
  }
  addBoxBetween(
    marks,
    [0, 0, 0.016],
    [Math.cos(60 * DEG) * 0.07, Math.sin(60 * DEG) * 0.07, 0.016],
    0.006,
    0.002,
    [0, 0, 1],
    { mat: 0 },
  );
  addBoxBetween(
    marks,
    [0, 0, 0.018],
    [Math.cos(-30 * DEG) * 0.105, Math.sin(-30 * DEG) * 0.105, 0.018],
    0.004,
    0.002,
    [0, 0, 1],
    { mat: 0 },
  );
  addBoxBetween(
    marks,
    [-Math.cos(200 * DEG) * 0.02, -Math.sin(200 * DEG) * 0.02, 0.02],
    [Math.cos(200 * DEG) * 0.115, Math.sin(200 * DEG) * 0.115, 0.02],
    0.0015,
    0.001,
    [0, 0, 1],
    { mat: 1 },
  );
  addCylinder(marks, 0, 0, 0.006, 0.013, 0.021, 12, { mat: 0 });
  // stand the clock up: local +Z (towards the viewer) becomes −Y, then lift it onto its rim
  for (const m of [b, face, marks]) {
    mapVerts(m, start, ([x, y, z]) => [x, -z, y + r]);
    offsetVerts(m, 0, [0, 0.045, 0]);
  }
  return {
    parts: [
      part('rim', b, [tinted('Clock Rim', '#2b2b2e', 0.4)], { sharpAngle: SHARP }),
      part('face', face, [{ name: 'Clock Face', color: '#f5f2ea', roughness: 0.6 }], { sharpAngle: SHARP }),
      part('hands', marks, [MATS.blackPlastic, { name: 'Second Hand', color: '#c0262d', roughness: 0.4 }], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

/** Framed landscape picture hanging with its front to −Y; the origin is the bottom of the frame. */
function pictureFrame(): ModelGeometry {
  const w = 0.5;
  const h = 0.4;
  const f = 0.04;
  const d = 0.03;
  const frame = new MeshBuilder();
  addBox(frame, [-w / 2, 0, 0], [w / 2, d, f], { mat: 0 });
  addBox(frame, [-w / 2, 0, h - f], [w / 2, d, h], { mat: 0 });
  addBox(frame, [-w / 2, 0, f], [-w / 2 + f, d, h - f], { mat: 0 });
  addBox(frame, [w / 2 - f, 0, f], [w / 2, d, h - f], { mat: 0 });
  // the picture: sky, hills, field, a sun, painted as bands of faces on a grid
  const pic = new MeshBuilder();
  const nx = 12;
  const nz = 8;
  const x0 = -w / 2 + f;
  const x1 = w / 2 - f;
  const z0 = f;
  const z1 = h - f;
  const y = 0.012;
  const grid: number[][] = [];
  for (let j = 0; j <= nz; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      // the hill line rises and falls across the picture
      const zz = z0 + ((z1 - z0) * j) / nz;
      row.push(pic.vert([x, y, zz]));
    }
    grid.push(row);
  }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const u = (i + 0.5) / nx;
      const v = (j + 0.5) / nz;
      const hill = 0.42 + 0.12 * Math.sin(u * Math.PI * 1.6 + 0.4);
      const sun = Math.hypot(u - 0.74, (v - 0.72) * 0.8) < 0.09;
      const mat = v < 0.22 ? 2 : v < hill ? 1 : sun ? 3 : 0;
      pic.face([grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]], mat);
    }
  addBox(pic, [x0, y + 0.002, z0], [x1, d - 0.004, z1], { mat: 4 });
  return {
    parts: [
      part('frame', frame, [tinted('Frame Wood', '#6d4a2f', 0.5)], { sharpAngle: SHARP }),
      part('picture', pic, [
        { name: 'Paint Sky', color: '#8fb8d8', roughness: 0.8 },
        { name: 'Paint Hills', color: '#4d7a3f', roughness: 0.8 },
        { name: 'Paint Field', color: '#c9a548', roughness: 0.8 },
        { name: 'Paint Sun', color: '#f6e7a1', roughness: 0.8 },
        MATS.paper,
      ]),
    ],
  };
}

function pillow(): ModelGeometry {
  const b = new MeshBuilder();
  addRoundedBox(b, [-0.225, -0.225, 0], [0.225, 0.225, 0.13], 0.06, { mat: 0, cs: 3 });
  // plump middle, pinched corners
  mapVerts(b, 0, ([x, y, z]) => {
    const nx = x / 0.225;
    const ny = y / 0.225;
    const corner = nx * nx * ny * ny;
    const squash = 1 - 0.55 * corner;
    const zc = (z - 0.065) * squash * (1 - 0.25 * Math.max(nx * nx, ny * ny)) + 0.065 * squash;
    return [x * (1 - 0.06 * corner), y * (1 - 0.06 * corner), zc];
  });
  return { parts: [part('pillow', b, [tinted('Cushion Fabric', '#c7a24a', 0.9, { sheen: 0.5 })])] };
}

// ---------------------------------------------------------------- boxes, bags and gear

function cardboardBox(): ModelGeometry {
  const w = 0.4;
  const d = 0.3;
  const h = 0.3;
  const b = new MeshBuilder();
  addBox(b, [-w / 2, -d / 2, 0], [w / 2, d / 2, h - 0.004], { mat: 0 });
  // two top flaps meeting in the middle, taped
  addBox(b, [-w / 2, -d / 2, h - 0.004], [w / 2, -0.001, h], { mat: 0 });
  addBox(b, [-w / 2, 0.001, h - 0.004], [w / 2, d / 2, h], { mat: 0 });
  addBox(b, [-w / 2 - 0.001, -0.025, h - 0.0005], [w / 2 + 0.001, 0.025, h + 0.0012], { mat: 1 });
  addBox(b, [-w / 2 - 0.0012, -0.025, h - 0.07], [-w / 2 + 0.002, 0.025, h + 0.0012], { mat: 1 });
  addBox(b, [w / 2 - 0.002, -0.025, h - 0.07], [w / 2 + 0.0012, 0.025, h + 0.0012], { mat: 1 });
  // hand holes in the sides and a shipping label on the front
  for (const sx of [-1, 1])
    addTube(
      b,
      [
        [sx * (w / 2 - 0.002), 0, h - 0.075],
        [sx * (w / 2 + 0.001), 0, h - 0.075],
      ],
      0.018,
      10,
      { mat: 2 },
    );
  addBox(b, [0.04, -d / 2 - 0.001, 0.08], [0.16, -d / 2 + 0.002, 0.17], { mat: 3 });
  return {
    parts: [
      part(
        'box',
        b,
        [
          { ...MATS.cardboard, tint: true },
          { name: 'Packing Tape', color: '#b9925f', roughness: 0.35, coat: 0.4 },
          { name: 'Hole Dark', color: '#2a1d12', roughness: 1 },
          MATS.paper,
        ],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

function woodenCrate(): ModelGeometry {
  const w = 0.6;
  const d = 0.4;
  const h = 0.36;
  const b = new MeshBuilder();
  const post = 0.045;
  // corner posts
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      addBox(
        b,
        [sx > 0 ? w / 2 - post : -w / 2 + 0.01, sy > 0 ? d / 2 - post : -d / 2 + 0.01, 0],
        [sx > 0 ? w / 2 - 0.01 : -w / 2 + post, sy > 0 ? d / 2 - 0.01 : -d / 2 + post, h],
        { mat: 1 },
      );
  // three slats on each side with gaps, and a bottom
  const slat = 0.09;
  const gap = (h - 3 * slat) / 2;
  for (let k = 0; k < 3; k++) {
    const z0 = k * (slat + gap);
    addBox(b, [-w / 2, -d / 2, z0], [w / 2, -d / 2 + 0.012, z0 + slat], { mat: 0 });
    addBox(b, [-w / 2, d / 2 - 0.012, z0], [w / 2, d / 2, z0 + slat], { mat: 0 });
    addBox(b, [-w / 2, -d / 2 + 0.012, z0], [-w / 2 + 0.012, d / 2 - 0.012, z0 + slat], { mat: 0 });
    addBox(b, [w / 2 - 0.012, -d / 2 + 0.012, z0], [w / 2, d / 2 - 0.012, z0 + slat], { mat: 0 });
  }
  addBox(b, [-w / 2 + 0.012, -d / 2 + 0.012, 0.004], [w / 2 - 0.012, d / 2 - 0.012, 0.018], { mat: 1 });
  return {
    parts: [
      part(
        'crate',
        b,
        [
          { ...MATS.pine, tint: true },
          { name: 'Pine Dark', color: '#9a7449', roughness: 0.65 },
        ],
        {
          sharpAngle: SHARP,
        },
      ),
    ],
  };
}

function suitcase(): ModelGeometry {
  const w = 0.44;
  const d = 0.25;
  const h = 0.66;
  const shell = new MeshBuilder();
  addRoundedBox(shell, [-w / 2, -d / 2, 0.05], [w / 2, d / 2, 0.05 + h], 0.04, { mat: 0 });
  // ribs on the front shell
  for (const x of [-0.12, 0, 0.12])
    addRoundedBox(shell, [x - 0.012, -d / 2 - 0.006, 0.12], [x + 0.012, -d / 2 + 0.01, 0.65], 0.006, {
      mat: 0,
      cs: 2,
    });
  const gear = new MeshBuilder();
  // zip line around the middle
  addBox(gear, [-w / 2 - 0.002, -0.004, 0.06], [w / 2 + 0.002, 0.004, 0.05 + h - 0.01], { mat: 0 });
  // wheels and telescopic handle
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      addCylinder(gear, sx * (w / 2 - 0.04), sy * (d / 2 - 0.04), 0.02, 0.025, 0.055, 10, { mat: 0 });
      addTorus(gear, [sx * (w / 2 - 0.04), sy * (d / 2 - 0.04), 0.022], 0.012, 0.01, 12, 6, { mat: 1 });
    }
  for (const sx of [-1, 1])
    addCylinder(gear, sx * 0.1, d / 2 - 0.03, 0.009, 0.05 + h, 0.05 + h + 0.12, 8, { mat: 2 });
  addBoxBetween(
    gear,
    [-0.11, d / 2 - 0.03, 0.05 + h + 0.12],
    [0.11, d / 2 - 0.03, 0.05 + h + 0.12],
    0.03,
    0.025,
    [0, 0, 1],
    { mat: 0 },
  );
  addTube(gear, arc([-0.06, 0, 0.05 + h], [0.06, 0, 0.05 + h], [0, 0, 1], 8, 0.35), 0.008, 6, {
    mat: 0,
    smooth: true,
  });
  return {
    parts: [
      part('shell', shell, [tinted('Suitcase Shell', '#3f6e8c', 0.3, { coat: 0.5 })], { sharpAngle: SHARP }),
      part('fittings', gear, [MATS.blackPlastic, MATS.rubber, MATS.steel], { sharpAngle: SHARP }),
    ],
  };
}

function backpack(): ModelGeometry {
  const body = new MeshBuilder();
  addRoundedBox(body, [-0.15, -0.1, 0], [0.15, 0.1, 0.44], 0.07, { mat: 0 });
  // front pocket and lid flap
  addRoundedBox(body, [-0.115, -0.13, 0.05], [0.115, -0.07, 0.24], 0.035, { mat: 0 });
  addRoundedBox(body, [-0.145, -0.11, 0.36], [0.145, 0.06, 0.455], 0.04, { mat: 1 });
  const straps = new MeshBuilder();
  for (const sx of [-1, 1]) {
    const x = sx * 0.08;
    addTube(
      straps,
      [
        [x, 0.1, 0.38],
        [x, 0.135, 0.3],
        [x * 1.1, 0.135, 0.15],
        [x * 1.2, 0.105, 0.04],
      ],
      0.012,
      6,
      { mat: 0, smooth: true },
    );
  }
  addTube(straps, arc([-0.035, 0.07, 0.45], [0.035, 0.07, 0.45], [0, 0, 1], 8, 0.6), 0.008, 6, {
    mat: 0,
    smooth: true,
  });
  addBox(straps, [-0.11, -0.132, 0.215], [0.11, -0.124, 0.225], { mat: 1 });
  return {
    parts: [
      part(
        'body',
        body,
        [
          tinted('Backpack Nylon', '#c4492f', 0.7),
          { name: 'Backpack Trim', color: '#2b2e33', roughness: 0.7 },
        ],
        { sharpAngle: SHARP },
      ),
      part('straps', straps, [{ name: 'Backpack Trim', color: '#2b2e33', roughness: 0.7 }, MATS.steel], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

function handbag(): ModelGeometry {
  const b = new MeshBuilder();
  const start = b.vertexCount;
  // trapezoid body: wider at the bottom, extruded along Y
  addPrism(
    b,
    [
      [-0.16, 0],
      [0.16, 0],
      [0.13, 0.24],
      [-0.13, 0.24],
    ],
    -0.065,
    0.065,
    { mat: 0 },
  );
  mapVerts(b, start, ([x, y, z]) => [x, -z, y]);
  addBox(b, [-0.13, -0.067, 0.17], [0.13, -0.064, 0.24], { mat: 0 });
  const handles = new MeshBuilder();
  for (const y of [-0.035, 0.035])
    addTube(handles, arc([-0.08, y, 0.235], [0.08, y, 0.235], [0, 0, 1], 12, 0.85), 0.007, 6, {
      mat: 0,
      smooth: true,
    });
  addBox(handles, [-0.015, -0.069, 0.18], [0.015, -0.066, 0.2], { mat: 1 });
  return {
    parts: [
      part('bag', b, [tinted('Bag Leather', '#7b3f2a', 0.45, { coat: 0.2 })], { sharpAngle: SHARP }),
      part(
        'handles',
        handles,
        [
          tinted('Bag Leather', '#7b3f2a', 0.45, { coat: 0.2 }),
          { name: 'Gold Metal', color: '#c9a44c', roughness: 0.3, metallic: 1 },
        ],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

function umbrellaClosed(): ModelGeometry {
  const b = new MeshBuilder();
  // ferrule tip on the ground, furled canopy, shaft, crook handle at the top
  addCylinder(b, 0, 0, 0.004, 0, 0.06, 8, { mat: 1 });
  addLathe(
    b,
    [
      [0, 0.05],
      [0.012, 0.08],
      [0.032, 0.3],
      [0.03, 0.58],
      [0.012, 0.66],
      [0, 0.66],
    ],
    8,
    { mat: 0, smooth: false },
  );
  addCylinder(b, 0, 0, 0.006, 0.65, 0.78, 8, { mat: 1 });
  addTube(
    b,
    [
      [0, 0, 0.77],
      [0, 0, 0.83],
      ...arc([0, 0, 0.83], [0.08, 0, 0.83], [0, 0, 1], 10).slice(1),
      [0.08, 0, 0.8],
    ],
    0.011,
    8,
    { mat: 2, smooth: true },
  );
  // a strap around the folds
  addTorus(b, [0, 0, 0.435], 0.031, 0.006, 8, 4, { mat: 2 });
  return {
    parts: [
      part('umbrella', b, [tinted('Folded Umbrella Canopy', '#1f3b5c', 0.6), MATS.steel, MATS.darkWood], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

function umbrellaOpen(): ModelGeometry {
  const canopy = new MeshBuilder();
  const R = 0.52;
  const ribs = 8;
  const top = 0.9;
  // scalloped canopy: a shallow dome of 8 panels whose edges dip between the ribs
  const rings: Vec3[][] = [];
  const nr = 6;
  const around = ribs * 4;
  for (let i = 1; i <= nr; i++) {
    const t = i / nr;
    const ring: Vec3[] = [];
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around;
      const panel = Math.abs(Math.sin((a * ribs) / 2));
      const r = ((R * Math.sin(t * Math.PI * 0.42)) / Math.sin(Math.PI * 0.42)) * (1 - 0.06 * panel * t * t);
      const z =
        top -
        (0.26 * (1 - Math.cos(t * Math.PI * 0.42))) / (1 - Math.cos(Math.PI * 0.42)) +
        0.03 * panel * t * t;
      ring.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
    rings.push(ring);
  }
  // outside surface from the tip, then back on the inside (a thin shell)
  const inner = rings
    .map((ring) => ring.map(([x, y, z]) => [x * 0.995, y * 0.995, z - 0.006] as Vec3))
    .reverse();
  addRingSurfaceSafe(canopy, [[[0, 0, top + 0.004]], ...rings, ...inner, [[0, 0, top - 0.004]]], 0);
  paintFaces(canopy, 0, ([x, y]) =>
    Math.floor(((Math.atan2(y, x) + 2 * Math.PI) / (2 * Math.PI)) * ribs) % 2 === 0 ? 0 : 1,
  );
  const shaft = new MeshBuilder();
  addCylinder(shaft, 0, 0, 0.006, 0.08, top + 0.05, 8, { mat: 0 });
  addTube(
    shaft,
    [
      [0, 0, 0.09],
      [0, 0, 0.05],
      ...arc([0, 0, 0.05], [0.08, 0, 0.05], [0, 0, -1], 10).slice(1),
      [0.08, 0, 0.08],
    ],
    0.011,
    8,
    { mat: 1, smooth: true },
  );
  return {
    parts: [
      part('canopy', canopy, [
        tinted('Umbrella Canopy', '#c0392b', 0.6),
        { name: 'Umbrella White', color: '#f2efe8', roughness: 0.6 },
      ]),
      part('shaft', shaft, [MATS.steel, MATS.darkWood], { sharpAngle: SHARP }),
    ],
  };
}

/** addRingSurface through rings whose first and last are single points (a closed shell). */
function addRingSurfaceSafe(b: MeshBuilder, rings: Vec3[][], mat: number): void {
  // rings run outside down from the tip, inside back up: their winding faces out on both sheets
  const n = rings[1].length;
  const ids = rings.map((r) => r.map((p) => b.vert(p)));
  for (let i = 0; i + 1 < ids.length; i++) {
    const A = ids[i];
    const B = ids[i + 1];
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      if (A.length === 1) b.face([A[0], B[j], B[j1]], mat, true);
      else if (B.length === 1) b.face([A[j], B[0], A[j1]], mat, true);
      else b.face([A[j], B[j], B[j1], A[j1]], mat, true);
    }
  }
  // close the rim between the outer and inner sheets is part of the loft above
}

function picnicBasket(): ModelGeometry {
  const w = 0.44;
  const d = 0.3;
  const h = 0.24;
  const b = new MeshBuilder();
  // woven sides: rows of bands alternating two tones
  const rows = 6;
  for (let k = 0; k < rows; k++) {
    const z0 = 0.01 + (k * (h - 0.01)) / rows;
    const z1 = z0 + (h - 0.01) / rows;
    const ins = 0.008 * (1 - k / rows);
    addBox(b, [-w / 2 + ins, -d / 2 + ins, z0], [w / 2 - ins, d / 2 - ins, z1], { mat: k % 2 });
  }
  addBox(b, [-w / 2 + 0.01, -d / 2 + 0.01, 0], [w / 2 - 0.01, d / 2 - 0.01, 0.012], { mat: 1 });
  // two lid halves hinged at the middle, and the arched handle
  const lid = new MeshBuilder();
  for (const sy of [-1, 1])
    addRoundedBox(
      lid,
      [-w / 2 - 0.008, sy > 0 ? 0.004 : -d / 2 - 0.008, h],
      [w / 2 + 0.008, sy > 0 ? d / 2 + 0.008 : -0.004, h + 0.025],
      0.008,
      { mat: 0, cs: 2 },
    );
  addTube(
    lid,
    arc([-w / 2 + 0.06, 0, h + 0.02], [w / 2 - 0.06, 0, h + 0.02], [0, 0, 1], 14, 0.55),
    0.011,
    8,
    { mat: 0, smooth: true },
  );
  // a checked cloth peeking out
  addBox(lid, [-0.12, -d / 2 - 0.012, h - 0.05], [0.0, -d / 2 + 0.01, h + 0.006], { mat: 2 });
  return {
    parts: [
      part(
        'basket',
        b,
        [tinted('Wicker', '#b88d52', 0.85), { name: 'Wicker Dark', color: '#8f6a3b', roughness: 0.85 }],
        { sharpAngle: SHARP },
      ),
      part(
        'lid',
        lid,
        [
          tinted('Wicker', '#b88d52', 0.85),
          { name: 'Wicker Dark', color: '#8f6a3b', roughness: 0.85 },
          { name: 'Gingham Red', color: '#c23b3b', roughness: 0.9, sheen: 0.4 },
        ],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

function foldedBlanket(): ModelGeometry {
  const b = new MeshBuilder();
  const layers = 4;
  const t = 0.028;
  for (let k = 0; k < layers; k++) {
    const z0 = k * t;
    const s = 1 - 0.01 * k;
    addRoundedBox(b, [-0.2 * s, -0.15 * s, z0], [0.2 * s, 0.15 * s, z0 + t + 0.004], 0.013, {
      mat: k % 2,
      cs: 2,
    });
  }
  return {
    parts: [
      part('blanket', b, [
        tinted('Blanket Wool', '#3e6a8a', 0.95, { sheen: 0.6 }),
        { name: 'Blanket Cream', color: '#e9e0cc', roughness: 0.95, sheen: 0.6 },
      ]),
    ],
  };
}

/** Picnic blanket spread on the ground, red and white gingham. */
function picnicBlanket(): ModelGeometry {
  const w = 1.5;
  const l = 1.5;
  const h = 0.006;
  const n = 12;
  const b = new MeshBuilder();
  const grid: number[][] = [];
  for (let j = 0; j <= n; j++) {
    const row: number[] = [];
    for (let i = 0; i <= n; i++) {
      // a few soft ripples so it reads as cloth
      const x = -w / 2 + (w * i) / n;
      const y = -l / 2 + (l * j) / n;
      const z = h + 0.004 * Math.sin(i * 1.3) * Math.sin(j * 0.9) + 0.004;
      row.push(b.vert([x, y, z]));
    }
    grid.push(row);
  }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      b.face([grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]], (i % 2) + (j % 2), true);
  const outline: Vec2[] = [
    [-w / 2, -l / 2],
    [w / 2, -l / 2],
    [w / 2, l / 2],
    [-w / 2, l / 2],
  ];
  addPrism(b, outline, 0, h, { mat: 2, noTop: true });
  return {
    parts: [
      part('blanket', b, [
        { name: 'Gingham White', color: '#f2eee6', roughness: 0.9, sheen: 0.4 },
        { name: 'Gingham Pink', color: '#de8f8f', roughness: 0.9, sheen: 0.4 },
        tinted('Gingham Red', '#c23b3b', 0.9, { sheen: 0.4 }),
      ]),
    ],
  };
}

function bucket(): ModelGeometry {
  const b = new MeshBuilder();
  addVessel(
    b,
    [
      [0.1, 0],
      [0.14, 0.27],
      [0.145, 0.275],
    ],
    0.006,
    32,
    0,
  );
  for (const z of [0.09, 0.2]) {
    const r = 0.1 + (0.04 * z) / 0.27;
    addTorus(b, [0, 0, z], r + 0.002, 0.004, 32, 4, { mat: 0 });
  }
  addTube(b, arc([-0.14, 0, 0.255], [0.14, 0, 0.255], [0, 0, 1], 16, 0.9), 0.004, 6, {
    mat: 1,
    smooth: true,
  });
  for (const sx of [-1, 1]) addCylinder(b, sx * 0.142, 0, 0.012, 0.245, 0.265, 8, { mat: 1 });
  return {
    parts: [
      part('bucket', b, [tinted('Galvanized Steel', '#a7adb2', 0.4, { metallic: 1 }), MATS.steel], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

function trashCan(): ModelGeometry {
  const b = new MeshBuilder();
  addLathe(
    b,
    [
      [0, 0],
      [0.13, 0],
      [0.145, 0.02],
      [0.15, 0.52],
      [0, 0.52],
    ],
    32,
    { mat: 0, smooth: true },
  );
  const lid = new MeshBuilder();
  addLathe(
    lid,
    [
      [0, 0.52],
      [0.155, 0.52],
      [0.155, 0.54],
      [0.12, 0.575],
      [0, 0.585],
    ],
    32,
    { mat: 1, smooth: true },
  );
  addBox(lid, [-0.06, -0.205, 0.0], [0.06, -0.13, 0.03], { mat: 1 });
  return {
    parts: [
      part('bin', b, [tinted('Bin Steel', '#b4b8bc', 0.3, { metallic: 1 })], { sharpAngle: SHARP }),
      part('lid', lid, [tinted('Bin Steel', '#b4b8bc', 0.3, { metallic: 1 }), MATS.blackPlastic], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

/** Aluminium step ladder standing open (A-frame), the steps facing −Y. */
function ladder(): ModelGeometry {
  const h = 1.5;
  const b = new MeshBuilder();
  const spread = 0.42;
  const w0 = 0.46;
  const w1 = 0.36;
  const front = (t: number, sx: number): Vec3 => [
    (sx * (w0 + (w1 - w0) * t)) / 2,
    -spread + spread * 0.9 * t,
    h * t,
  ];
  const back = (t: number, sx: number): Vec3 => [
    (sx * (w0 + (w1 - w0) * t)) / 2,
    spread - spread * 0.9 * t,
    h * t * 0.98,
  ];
  for (const sx of [-1, 1]) {
    addBoxBetween(b, front(0, sx), front(1, sx), 0.022, 0.05, [0, 1, 0.3], { mat: 0 });
    addBoxBetween(b, back(0, sx), back(1, sx), 0.022, 0.035, [0, -1, 0.3], { mat: 0 });
    for (const p of [front(0, sx), back(0, sx)])
      addBox(b, [p[0] - 0.016, p[1] - 0.025, 0], [p[0] + 0.016, p[1] + 0.025, 0.03], { mat: 1 });
  }
  // treads on the front frame, braces on the back, a top platform
  for (let k = 1; k <= 4; k++) {
    const t = k / 5;
    const l = front(t, -1);
    const r = front(t, 1);
    addBox(b, [l[0] + 0.01, l[1] - 0.05, l[2] - 0.012], [r[0] - 0.01, l[1] + 0.05, l[2] + 0.012], { mat: 0 });
  }
  for (const t of [0.3, 0.65]) addBoxBetween(b, back(t, -1), back(t, 1), 0.015, 0.025, [0, 0, 1], { mat: 0 });
  const tp = front(1, 1);
  addBox(b, [-tp[0] - 0.02, tp[1] - 0.04, h - 0.02], [tp[0] + 0.02, spread * 0.12, h + 0.01], { mat: 2 });
  return {
    parts: [
      part('ladder', b, [{ ...MATS.steel, tint: true }, MATS.rubber, MATS.greyPlastic], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

// ---------------------------------------------------------------- kitchen

function kettle(): ModelGeometry {
  const b = new MeshBuilder();
  addLathe(
    b,
    [
      [0, 0.018],
      [0.085, 0.018],
      [0.09, 0.03],
      [0.088, 0.13],
      [0.078, 0.2],
      [0.06, 0.225],
      [0, 0.23],
    ],
    32,
    { mat: 0, smooth: true },
  );
  // spout towards −Y, handle at +Y
  addTube(
    b,
    [
      [0, -0.07, 0.07],
      [0, -0.1, 0.12],
      [0, -0.125, 0.165],
    ],
    (i: number) => [0.016, 0.012, 0.009][i] ?? 0.009,
    10,
    { mat: 0, smooth: true },
  );
  addTube(
    b,
    [
      [0, 0.06, 0.205],
      [0, 0.11, 0.2],
      [0, 0.125, 0.15],
      [0, 0.11, 0.08],
      [0, 0.08, 0.06],
    ],
    0.011,
    8,
    { mat: 1, smooth: true },
  );
  addLathe(
    b,
    [
      [0, 0.225],
      [0.025, 0.225],
      [0.02, 0.24],
      [0, 0.243],
    ],
    16,
    { mat: 1, smooth: true },
  );
  const base = new MeshBuilder();
  addLathe(
    base,
    [
      [0, 0],
      [0.1, 0],
      [0.1, 0.012],
      [0.085, 0.018],
      [0, 0.018],
    ],
    32,
    { mat: 0, smooth: true },
  );
  return {
    parts: [
      part('kettle', b, [tinted('Kettle Enamel', '#e6e1d6', 0.2, { coat: 0.6 }), MATS.blackPlastic], {
        sharpAngle: SHARP,
      }),
      part('base', base, [MATS.blackPlastic], { sharpAngle: SHARP }),
    ],
  };
}

function cookingPot(): ModelGeometry {
  const b = new MeshBuilder();
  addVessel(
    b,
    [
      [0.12, 0],
      [0.125, 0.005],
      [0.125, 0.14],
      [0.128, 0.145],
    ],
    0.004,
    40,
    0,
  );
  for (const sx of [-1, 1])
    addTube(b, arc([sx * 0.124, -0.035, 0.12], [sx * 0.124, 0.035, 0.12], [sx, 0, 0], 8, 0.9), 0.008, 6, {
      mat: 1,
      smooth: true,
    });
  const lid = new MeshBuilder();
  addLathe(
    lid,
    [
      [0, 0.165],
      [0.06, 0.162],
      [0.13, 0.142],
      [0.13, 0.138],
      [0.06, 0.158],
      [0, 0.161],
    ],
    40,
    { mat: 0, smooth: true },
  );
  addLathe(
    lid,
    [
      [0, 0.163],
      [0.02, 0.163],
      [0.022, 0.172],
      [0.018, 0.182],
      [0, 0.183],
    ],
    16,
    { mat: 1, smooth: true },
  );
  return {
    parts: [
      part('pot', b, [tinted('Pot Steel', '#c3c7cc', 0.25, { metallic: 1 }), MATS.blackPlastic], {
        sharpAngle: SHARP,
      }),
      part('lid', lid, [MATS.glass, MATS.blackPlastic], { sharpAngle: SHARP }),
    ],
  };
}

function fridge(): ModelGeometry {
  const w = 0.7;
  const d = 0.68;
  const h = 1.8;
  const body = new MeshBuilder();
  addRoundedBox(body, [-w / 2, -d / 2 + 0.04, 0.03], [w / 2, d / 2, h], 0.02, { mat: 0, cs: 2 });
  addBox(body, [-w / 2 + 0.03, -d / 2 + 0.06, 0], [w / 2 - 0.03, d / 2 - 0.05, 0.03], { mat: 2 });
  const doors = new MeshBuilder();
  const split = 0.62;
  addRoundedBox(doors, [-w / 2, -d / 2, 0.04], [w / 2, -d / 2 + 0.045, split - 0.004], 0.015, {
    mat: 0,
    cs: 2,
  });
  addRoundedBox(doors, [-w / 2, -d / 2, split + 0.004], [w / 2, -d / 2 + 0.045, h - 0.01], 0.015, {
    mat: 0,
    cs: 2,
  });
  for (const [z0, z1] of [
    [split + 0.08, split + 0.5],
    [split - 0.22, split - 0.05],
  ] as const) {
    addRoundLeg(doors, w / 2 - 0.06, -d / 2 - 0.03, z0, z1, 0.012, 0.012, 10, { mat: 1 });
    for (const z of [z0 + 0.02, z1 - 0.02])
      addBoxBetween(
        doors,
        [w / 2 - 0.06, -d / 2 - 0.028, z],
        [w / 2 - 0.06, -d / 2 + 0.002, z],
        0.014,
        0.014,
        [0, 0, 1],
        { mat: 1 },
      );
  }
  return {
    parts: [
      part(
        'body',
        body,
        [tinted('Appliance White', '#eeeeea', 0.3, { coat: 0.4 }), MATS.steel, MATS.blackPlastic],
        { sharpAngle: SHARP },
      ),
      part('doors', doors, [tinted('Appliance White', '#eeeeea', 0.3, { coat: 0.4 }), MATS.steel], {
        sharpAngle: SHARP,
      }),
    ],
  };
}

function stove(): ModelGeometry {
  const w = 0.6;
  const d = 0.6;
  const h = 0.9;
  const b = new MeshBuilder();
  addBox(b, [-w / 2, -d / 2 + 0.02, 0.06], [w / 2, d / 2, h - 0.02], { mat: 0 });
  addBox(b, [-w / 2 + 0.02, -d / 2 + 0.06, 0], [w / 2 - 0.02, d / 2 - 0.02, 0.06], { mat: 3 });
  // black glass hob and four burners
  addBox(b, [-w / 2, -d / 2 + 0.02, h - 0.02], [w / 2, d / 2, h], { mat: 2 });
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      addTorus(b, [sx * 0.14, sy * 0.13, h + 0.002], 0.07 + (sx > 0 ? 0.0 : -0.015), 0.006, 28, 4, {
        mat: 4,
      });
  // backsplash with knobs
  addBox(b, [-w / 2, d / 2 - 0.06, h], [w / 2, d / 2, h + 0.1], { mat: 0 });
  for (let k = 0; k < 4; k++) {
    const x = -0.21 + k * 0.14;
    addTube(
      b,
      [
        [x, d / 2 - 0.058, h + 0.05],
        [x, d / 2 - 0.085, h + 0.05],
      ],
      0.018,
      14,
      { mat: 3, smooth: true },
    );
  }
  const door = new MeshBuilder();
  addBox(door, [-w / 2 + 0.01, -d / 2, 0.08], [w / 2 - 0.01, -d / 2 + 0.02, h - 0.12], { mat: 0 });
  addBox(door, [-w / 2 + 0.06, -d / 2 - 0.002, 0.2], [w / 2 - 0.06, -d / 2 + 0.005, h - 0.26], { mat: 1 });
  addTube(
    door,
    [
      [-0.22, -d / 2 - 0.03, h - 0.17],
      [0.22, -d / 2 - 0.03, h - 0.17],
    ],
    0.01,
    10,
    { mat: 3, smooth: true },
  );
  for (const x of [-0.2, 0.2])
    addBoxBetween(
      door,
      [x, -d / 2 - 0.03, h - 0.17],
      [x, -d / 2 + 0.002, h - 0.17],
      0.012,
      0.012,
      [0, 0, 1],
      { mat: 3 },
    );
  return {
    parts: [
      part(
        'stove',
        b,
        [
          tinted('Appliance White', '#eeeeea', 0.3, { coat: 0.4 }),
          MATS.screen,
          { name: 'Hob Glass', color: '#121315', roughness: 0.08, coat: 1 },
          MATS.steel,
          { name: 'Burner Ring', color: '#5a5d61', roughness: 0.5, metallic: 1 },
        ],
        { sharpAngle: SHARP },
      ),
      part(
        'oven-door',
        door,
        [tinted('Appliance White', '#eeeeea', 0.3, { coat: 0.4 }), MATS.screen, MATS.steel, MATS.steel],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

function kitchenCounter(): ModelGeometry {
  const w = 1.8;
  const d = 0.62;
  const h = 0.9;
  const cab = new MeshBuilder();
  addBox(cab, [-w / 2 + 0.01, -d / 2 + 0.07, 0], [w / 2 - 0.01, d / 2 - 0.02, 0.1], { mat: 2 });
  addBox(cab, [-w / 2, -d / 2 + 0.04, 0.1], [w / 2, d / 2 - 0.02, h - 0.04], { mat: 0 });
  // three bays: drawers left, double door middle (under the sink), door right
  const fronts = new MeshBuilder();
  const bay = w / 3;
  for (let k = 0; k < 3; k++) {
    const x0 = -w / 2 + k * bay + 0.004;
    const x1 = x0 + bay - 0.008;
    if (k === 0) {
      for (let i = 0; i < 3; i++) {
        const z0 = 0.105 + i * 0.25;
        addBox(fronts, [x0, -d / 2 + 0.02, z0], [x1, -d / 2 + 0.04, z0 + 0.24], { mat: 0 });
        addBoxBetween(
          fronts,
          [(x0 + x1) / 2 - 0.08, -d / 2 + 0.005, z0 + 0.19],
          [(x0 + x1) / 2 + 0.08, -d / 2 + 0.005, z0 + 0.19],
          0.012,
          0.012,
          [0, 0, 1],
          { mat: 1 },
        );
      }
    } else {
      const doors = k === 1 ? 2 : 1;
      const dw = (x1 - x0) / doors;
      for (let i = 0; i < doors; i++) {
        const a = x0 + i * dw + 0.002;
        const c = a + dw - 0.004;
        addBox(fronts, [a, -d / 2 + 0.02, 0.105], [c, -d / 2 + 0.04, h - 0.045], { mat: 0 });
        const hx = doors === 2 ? (i === 0 ? c - 0.04 : a + 0.04) : a + 0.04;
        addBoxBetween(
          fronts,
          [hx, -d / 2 + 0.005, h - 0.25],
          [hx, -d / 2 + 0.005, h - 0.12],
          0.012,
          0.012,
          [1, 0, 0],
          { mat: 1 },
        );
      }
    }
  }
  // worktop with a sink basin and a tap
  const top = new MeshBuilder();
  const sx0 = -0.22;
  const sx1 = 0.22;
  const sy0 = -0.2;
  const sy1 = 0.17;
  const tz = h;
  addBox(top, [-w / 2 - 0.01, -d / 2 - 0.01, tz - 0.04], [sx0, d / 2, tz], { mat: 0 });
  addBox(top, [sx1, -d / 2 - 0.01, tz - 0.04], [w / 2 + 0.01, d / 2, tz], { mat: 0 });
  addBox(top, [sx0, -d / 2 - 0.01, tz - 0.04], [sx1, sy0, tz], { mat: 0 });
  addBox(top, [sx0, sy1, tz - 0.04], [sx1, d / 2, tz], { mat: 0 });
  const basin = new MeshBuilder();
  addBox(basin, [sx0, sy0, tz - 0.2], [sx1, sy1, tz - 0.19], { mat: 0 });
  addBox(basin, [sx0, sy0, tz - 0.19], [sx0 + 0.01, sy1, tz - 0.002], { mat: 0 });
  addBox(basin, [sx1 - 0.01, sy0, tz - 0.19], [sx1, sy1, tz - 0.002], { mat: 0 });
  addBox(basin, [sx0 + 0.01, sy0, tz - 0.19], [sx1 - 0.01, sy0 + 0.01, tz - 0.002], { mat: 0 });
  addBox(basin, [sx0 + 0.01, sy1 - 0.01, tz - 0.19], [sx1 - 0.01, sy1, tz - 0.002], { mat: 0 });
  addCylinder(basin, 0, sy1 + 0.04, 0.02, tz, tz + 0.04, 12, { mat: 0 });
  addTube(
    basin,
    [
      [0, sy1 + 0.04, tz + 0.03],
      [0, sy1 + 0.04, tz + 0.27],
      ...arc([0, sy1 + 0.04, tz + 0.27], [0, sy1 - 0.14, tz + 0.27], [0, 0, 1], 8, 0.7).slice(1),
      [0, sy1 - 0.14, tz + 0.21],
    ],
    0.012,
    8,
    { mat: 0, smooth: true },
  );
  return {
    parts: [
      part('cabinets', cab, [tinted('Cabinet Paint', '#5f7f78', 0.45), MATS.steel, MATS.darkWood], {
        sharpAngle: SHARP,
      }),
      part('fronts', fronts, [tinted('Cabinet Paint', '#5f7f78', 0.45), MATS.steel], { sharpAngle: SHARP }),
      part(
        'worktop',
        top,
        [{ name: 'Worktop Oak', color: '#b98b5b', roughness: 0.45, coat: 0.3 }, MATS.steel],
        { sharpAngle: SHARP },
      ),
      part('sink', basin, [MATS.chrome], { sharpAngle: SHARP }),
    ],
  };
}

// ---------------------------------------------------------------- office

function whiteboard(): ModelGeometry {
  const w = 1.2;
  const bh = 0.9;
  const z0 = 0.85;
  const b = new MeshBuilder();
  const f = 0.02;
  addBox(b, [-w / 2, -0.012, z0], [w / 2, 0.012, z0 + f], { mat: 0 });
  addBox(b, [-w / 2, -0.012, z0 + bh - f], [w / 2, 0.012, z0 + bh], { mat: 0 });
  addBox(b, [-w / 2, -0.012, z0 + f], [-w / 2 + f, 0.012, z0 + bh - f], { mat: 0 });
  addBox(b, [w / 2 - f, -0.012, z0 + f], [w / 2, 0.012, z0 + bh - f], { mat: 0 });
  addBox(b, [-w / 2 + f, -0.008, z0 + f], [w / 2 - f, 0.008, z0 + bh - f], { mat: 1 });
  // marker tray and a few strokes
  addBox(b, [-w * 0.3, -0.06, z0 - 0.005], [w * 0.3, -0.012, z0 + 0.012], { mat: 0 });
  addBoxBetween(b, [-0.35, -0.0085, z0 + 0.6], [-0.05, -0.0085, z0 + 0.66], 0.008, 0.001, [0, -1, 0], {
    mat: 2,
  });
  addBoxBetween(b, [-0.35, -0.0085, z0 + 0.5], [0.15, -0.0085, z0 + 0.5], 0.008, 0.001, [0, -1, 0], {
    mat: 2,
  });
  addBoxBetween(b, [0.1, -0.0085, z0 + 0.35], [0.4, -0.0085, z0 + 0.25], 0.008, 0.001, [0, -1, 0], {
    mat: 3,
  });
  // A-frame stand on castors
  const stand = new MeshBuilder();
  for (const sx of [-1, 1]) {
    addBox(
      stand,
      [sx * (w / 2 + 0.02) - 0.015, -0.015, 0.06],
      [sx * (w / 2 + 0.02) + 0.015, 0.015, z0 + bh * 0.7],
      { mat: 0 },
    );
    addBox(stand, [sx * (w / 2 + 0.02) - 0.02, -0.28, 0.05], [sx * (w / 2 + 0.02) + 0.02, 0.28, 0.08], {
      mat: 0,
    });
    for (const y of [-0.26, 0.26]) {
      addCylinder(stand, sx * (w / 2 + 0.02), y, 0.008, 0.035, 0.05, 8, { mat: 0 });
      addTorus(stand, [sx * (w / 2 + 0.02), y, 0.022], 0.012, 0.01, 12, 6, { mat: 1 });
    }
  }
  return {
    parts: [
      part(
        'board',
        b,
        [
          { ...MATS.steel, tint: true },
          { name: 'Whiteboard', color: '#f8f8f6', roughness: 0.12, coat: 0.6 },
          { name: 'Marker Blue', color: '#2f5fbf', roughness: 0.5 },
          { name: 'Marker Red', color: '#c6343a', roughness: 0.5 },
        ],
        { sharpAngle: SHARP },
      ),
      part('stand', stand, [{ ...MATS.steel, tint: true }, MATS.rubber], { sharpAngle: SHARP }),
    ],
  };
}

function filingCabinet(): ModelGeometry {
  const w = 0.47;
  const d = 0.62;
  const h = 1.32;
  const b = new MeshBuilder();
  addBox(b, [-w / 2, -d / 2 + 0.015, 0], [w / 2, d / 2, h], { mat: 0 });
  const fronts = new MeshBuilder();
  const n = 4;
  for (let i = 0; i < n; i++) {
    const z0 = 0.02 + (i * (h - 0.04)) / n;
    const z1 = z0 + (h - 0.04) / n - 0.008;
    addBox(fronts, [-w / 2 + 0.01, -d / 2, z0], [w / 2 - 0.01, -d / 2 + 0.015, z1], { mat: 0 });
    // recessed pull and label holder
    addBox(fronts, [-0.08, -d / 2 - 0.018, z1 - 0.11], [0.08, -d / 2, z1 - 0.09], { mat: 1 });
    addBox(fronts, [-0.04, -d / 2 - 0.002, z1 - 0.07], [0.04, -d / 2 + 0.001, z1 - 0.035], { mat: 2 });
  }
  return {
    parts: [
      part('cabinet', b, [tinted('Cabinet Steel', '#7d8791', 0.4, { metallic: 0.6 })], { sharpAngle: SHARP }),
      part(
        'drawers',
        fronts,
        [tinted('Cabinet Steel', '#7d8791', 0.4, { metallic: 0.6 }), MATS.chrome, MATS.paper],
        { sharpAngle: SHARP },
      ),
    ],
  };
}

// ---------------------------------------------------------------- the list

const tvParams = z.object({
  inches: z.number().min(19).max(100).default(55).describe('Screen diagonal in inches (19–100)'),
});

const HOME = ['props', 'household', 'indoor'];

/** The built-in props. */
export const PROPS_MODELS: CatalogEntry[] = [
  defineModel({
    id: 'floor_lamp',
    name: 'Floor lamp',
    category: 'props',
    tags: [...HOME, 'lamp', 'light', 'living room'],
    synonyms: ['standing lamp', 'standard lamp', 'lamp', 'light'],
    description: 'A floor lamp with a round base, slim pole and fabric drum shade around a glowing bulb.',
    dimensions_m: [0.4, 0.4, 1.62],
    triangles: 640,
    geometry: floorLamp,
  }),
  defineModel({
    id: 'table_lamp',
    name: 'Table lamp',
    category: 'props',
    tags: [...HOME, 'lamp', 'light', 'bedroom', 'desk'],
    synonyms: ['desk lamp', 'bedside lamp', 'lamp', 'reading lamp'],
    description: 'A table lamp with a glazed ceramic base and a fabric shade.',
    dimensions_m: [0.32, 0.32, 0.47],
    triangles: 680,
    geometry: tableLamp,
  }),
  defineModel({
    id: 'tv',
    name: 'Television',
    category: 'props',
    tags: [...HOME, 'electronics', 'screen', 'living room', 'media'],
    synonyms: ['tv', 'television', 'flat screen', 'telly', 'smart tv'],
    description: 'A 55-inch flat-screen TV on a pedestal stand (inches parameter for other sizes).',
    dimensions_m: [1.24, 0.21, 0.78],
    triangles: 444,
    params: tvParams,
    geometry: (p) => tv(p.inches),
  }),
  defineModel({
    id: 'laptop',
    name: 'Laptop',
    category: 'props',
    tags: [...HOME, 'electronics', 'computer', 'office', 'desk'],
    synonyms: ['notebook computer', 'macbook', 'computer', 'notebook'],
    description: 'An open aluminium laptop with a lit screen.',
    dimensions_m: [0.32, 0.3, 0.22],
    triangles: 316,
    geometry: laptop,
  }),
  defineModel({
    id: 'monitor',
    name: 'Computer monitor',
    category: 'props',
    tags: [...HOME, 'electronics', 'computer', 'office', 'desk', 'screen'],
    synonyms: ['monitor', 'display', 'computer screen', 'pc screen'],
    description: 'A 27-inch computer monitor on a stand, screen lit.',
    dimensions_m: [0.62, 0.2, 0.48],
    triangles: 444,
    geometry: monitor,
  }),
  defineModel({
    id: 'phone',
    name: 'Smartphone',
    category: 'props',
    tags: ['props', 'electronics', 'phone', 'small', 'handheld'],
    synonyms: ['phone', 'mobile phone', 'cell phone', 'cellphone', 'iphone', 'mobile'],
    description: 'A smartphone lying screen up.',
    dimensions_m: [0.072, 0.15, 0.009],
    triangles: 312,
    geometry: phone,
  }),
  defineModel({
    id: 'book',
    name: 'Book',
    category: 'props',
    tags: ['props', 'book', 'reading', 'small', 'handheld'],
    synonyms: ['hardback', 'hardcover', 'novel', 'notebook', 'diary'],
    description: 'A closed hardback book lying flat.',
    dimensions_m: [0.17, 0.28, 0.032],
    triangles: 70,
    geometry: book,
  }),
  defineModel({
    id: 'book_stack',
    name: 'Stack of books',
    category: 'props',
    tags: ['props', 'book', 'reading', 'pile', 'study'],
    synonyms: ['books', 'pile of books', 'book pile', 'stack'],
    description: 'Five hardback books stacked a little askew.',
    dimensions_m: [0.23, 0.27, 0.15],
    triangles: 290,
    geometry: bookStack,
  }),
  defineModel({
    id: 'mug',
    name: 'Mug',
    category: 'props',
    tags: ['props', 'tableware', 'kitchen', 'drink', 'coffee', 'handheld', 'small'],
    synonyms: ['coffee mug', 'tea mug', 'cup', 'coffee cup'],
    description: 'A glazed coffee mug with a handle.',
    dimensions_m: [0.12, 0.084, 0.095],
    triangles: 492,
    geometry: mug,
  }),
  defineModel({
    id: 'cup',
    name: 'Cup and saucer',
    category: 'props',
    tags: ['props', 'tableware', 'kitchen', 'drink', 'tea', 'small'],
    synonyms: ['teacup', 'tea cup', 'cup', 'coffee cup', 'saucer'],
    description: 'A porcelain teacup on its saucer.',
    dimensions_m: [0.15, 0.15, 0.068],
    triangles: 936,
    geometry: cup,
  }),
  defineModel({
    id: 'plate',
    name: 'Plate',
    category: 'props',
    tags: ['props', 'tableware', 'kitchen', 'dining', 'small'],
    synonyms: ['dinner plate', 'dish', 'plate'],
    description: 'A porcelain dinner plate, 27 cm across.',
    dimensions_m: [0.27, 0.27, 0.025],
    triangles: 864,
    geometry: plate,
  }),
  defineModel({
    id: 'bowl',
    name: 'Bowl',
    category: 'props',
    tags: ['props', 'tableware', 'kitchen', 'dining', 'small'],
    synonyms: ['soup bowl', 'cereal bowl', 'dish', 'salad bowl'],
    description: 'A glazed ceramic bowl.',
    dimensions_m: [0.16, 0.16, 0.064],
    triangles: 1520,
    geometry: bowl,
  }),
  defineModel({
    id: 'bottle',
    name: 'Bottle',
    category: 'props',
    tags: ['props', 'drink', 'glass', 'wine', 'kitchen', 'handheld'],
    synonyms: ['wine bottle', 'glass bottle', 'beer bottle', 'flask'],
    description: 'A green glass wine bottle with a label and capsule.',
    dimensions_m: [0.075, 0.075, 0.3],
    triangles: 808,
    geometry: bottle,
  }),
  defineModel({
    id: 'wine_glass',
    name: 'Wine glass',
    category: 'props',
    tags: ['props', 'drink', 'glass', 'wine', 'tableware', 'dining'],
    synonyms: ['wineglass', 'glass', 'goblet', 'stemware', 'champagne glass'],
    description: 'A clear stemmed wine glass.',
    dimensions_m: [0.077, 0.077, 0.2],
    triangles: 1408,
    geometry: wineGlass,
  }),
  defineModel({
    id: 'vase_with_flowers',
    name: 'Vase with flowers',
    category: 'props',
    tags: ['props', 'decoration', 'flowers', 'vase', 'table'],
    synonyms: ['flowers', 'bouquet', 'flower vase', 'vase'],
    description: 'A glazed vase holding a small bouquet of red, yellow and white flowers.',
    dimensions_m: [0.25, 0.33, 0.52],
    triangles: 1248,
    geometry: vaseWithFlowers,
  }),
  defineModel({
    id: 'potted_plant',
    name: 'Potted plant',
    category: 'props',
    tags: ['props', 'decoration', 'plant', 'indoor', 'green'],
    synonyms: ['house plant', 'houseplant', 'plant pot', 'pot plant', 'plant'],
    description: 'A leafy house plant in a terracotta pot.',
    dimensions_m: [0.87, 0.86, 0.6],
    triangles: 1188,
    geometry: pottedPlant,
  }),
  defineModel({
    id: 'wall_clock',
    name: 'Wall clock',
    category: 'props',
    tags: ['props', 'decoration', 'clock', 'wall', 'time'],
    synonyms: ['clock', 'kitchen clock', 'round clock'],
    description: 'A round wall clock, face to −Y; its origin is the bottom of the rim.',
    dimensions_m: [0.3, 0.045, 0.3],
    triangles: 804,
    geometry: wallClock,
  }),
  defineModel({
    id: 'picture_frame',
    name: 'Framed picture',
    category: 'props',
    tags: ['props', 'decoration', 'picture', 'wall', 'art'],
    synonyms: ['painting', 'picture', 'frame', 'artwork', 'photo frame'],
    description: 'A framed landscape picture to hang on a wall (front to −Y).',
    dimensions_m: [0.5, 0.03, 0.4],
    triangles: 252,
    geometry: pictureFrame,
  }),
  defineModel({
    id: 'pillow',
    name: 'Cushion',
    category: 'props',
    tags: ['props', 'textile', 'sofa', 'bed', 'soft'],
    synonyms: ['pillow', 'throw pillow', 'scatter cushion', 'cushion'],
    description: 'A plump square cushion with pinched corners.',
    dimensions_m: [0.43, 0.43, 0.095],
    triangles: 252,
    geometry: pillow,
  }),
  defineModel({
    id: 'cardboard_box',
    name: 'Cardboard box',
    category: 'props',
    tags: ['props', 'box', 'package', 'moving', 'storage'],
    synonyms: ['box', 'carton', 'package', 'parcel', 'moving box'],
    description: 'A taped cardboard box, 40 × 30 × 30 cm.',
    dimensions_m: [0.4, 0.3, 0.3],
    triangles: 156,
    geometry: cardboardBox,
  }),
  defineModel({
    id: 'wooden_crate',
    name: 'Wooden crate',
    category: 'props',
    tags: ['props', 'box', 'crate', 'wood', 'storage', 'market', 'farm'],
    synonyms: ['crate', 'fruit crate', 'wooden box', 'box'],
    description: 'An open slatted pine crate.',
    dimensions_m: [0.6, 0.4, 0.36],
    triangles: 204,
    geometry: woodenCrate,
  }),
  defineModel({
    id: 'suitcase',
    name: 'Suitcase',
    category: 'props',
    tags: ['props', 'luggage', 'travel', 'bag', 'case'],
    synonyms: ['luggage', 'trolley case', 'travel case', 'case'],
    description: 'A hard-shell suitcase on four wheels with a telescopic handle.',
    dimensions_m: [0.44, 0.26, 0.83],
    triangles: 1600,
    geometry: suitcase,
  }),
  defineModel({
    id: 'backpack',
    name: 'Backpack',
    category: 'props',
    tags: ['props', 'bag', 'travel', 'school', 'hiking'],
    synonyms: ['rucksack', 'knapsack', 'school bag', 'bag', 'daypack'],
    description: 'A nylon backpack with a front pocket and shoulder straps.',
    dimensions_m: [0.3, 0.28, 0.48],
    triangles: 960,
    geometry: backpack,
  }),
  defineModel({
    id: 'handbag',
    name: 'Handbag',
    category: 'props',
    tags: ['props', 'bag', 'fashion', 'handheld'],
    synonyms: ['purse', 'tote', 'bag', 'shoulder bag'],
    description: 'A leather handbag with two handles.',
    dimensions_m: [0.32, 0.13, 0.31],
    triangles: 340,
    geometry: handbag,
  }),
  defineModel({
    id: 'closed_umbrella',
    name: 'Closed umbrella',
    category: 'props',
    tags: ['props', 'umbrella', 'rain', 'weather', 'handheld'],
    synonyms: ['furled umbrella', 'folded umbrella', 'walking umbrella', 'brolly'],
    description: 'A furled umbrella standing on its tip with a crook handle.',
    dimensions_m: [0.13, 0.074, 0.88],
    triangles: 396,
    geometry: umbrellaClosed,
  }),
  defineModel({
    id: 'umbrella',
    name: 'Umbrella',
    category: 'props',
    tags: ['props', 'umbrella', 'rain', 'weather', 'handheld'],
    synonyms: ['open umbrella', 'rain umbrella', 'brolly', 'parasol'],
    description: 'An open umbrella (1 m across) with a striped canopy; the origin is under its handle.',
    dimensions_m: [1.04, 1.04, 0.95],
    triangles: 1004,
    geometry: umbrellaOpen,
  }),
  defineModel({
    id: 'picnic_basket',
    name: 'Picnic basket',
    category: 'props',
    tags: ['props', 'picnic', 'basket', 'wicker', 'outdoor', 'food'],
    synonyms: ['hamper', 'wicker basket', 'basket', 'picnic hamper'],
    description: 'A wicker picnic basket with a split lid, an arched handle and a gingham cloth.',
    dimensions_m: [0.46, 0.32, 0.36],
    triangles: 612,
    geometry: picnicBasket,
  }),
  defineModel({
    id: 'folded_blanket',
    name: 'Folded blanket',
    category: 'props',
    tags: ['props', 'textile', 'blanket', 'bedroom', 'picnic'],
    synonyms: ['blanket', 'throw', 'folded throw', 'rug'],
    description: 'A two-tone wool blanket folded into a neat stack.',
    dimensions_m: [0.4, 0.3, 0.12],
    triangles: 560,
    geometry: foldedBlanket,
  }),
  defineModel({
    id: 'picnic_blanket',
    name: 'Picnic blanket',
    category: 'props',
    tags: ['props', 'textile', 'blanket', 'picnic', 'outdoor', 'ground'],
    synonyms: ['blanket', 'gingham blanket', 'picnic rug', 'beach blanket', 'tablecloth'],
    description: 'A red and white gingham blanket spread on the ground, 1.5 × 1.5 m.',
    dimensions_m: [1.5, 1.5, 0.014],
    triangles: 298,
    geometry: picnicBlanket,
  }),
  defineModel({
    id: 'bucket',
    name: 'Bucket',
    category: 'props',
    tags: ['props', 'bucket', 'garden', 'farm', 'cleaning'],
    synonyms: ['pail', 'metal bucket', 'tin bucket'],
    description: 'A galvanized steel bucket with a wire handle.',
    dimensions_m: [0.31, 0.29, 0.39],
    triangles: 1096,
    geometry: bucket,
  }),
  defineModel({
    id: 'trash_can',
    name: 'Pedal bin',
    category: 'props',
    tags: ['props', 'bin', 'kitchen', 'waste'],
    synonyms: ['trash can', 'garbage can', 'bin', 'rubbish bin', 'waste bin', 'dustbin'],
    description: 'A steel pedal bin with a domed lid.',
    dimensions_m: [0.31, 0.36, 0.58],
    triangles: 396,
    geometry: trashCan,
  }),
  defineModel({
    id: 'ladder',
    name: 'Step ladder',
    category: 'props',
    tags: ['props', 'ladder', 'tools', 'workshop', 'aluminium'],
    synonyms: ['ladder', 'stepladder', 'a-frame ladder'],
    description: 'An open aluminium step ladder, 1.5 m tall, its treads facing −Y.',
    dimensions_m: [0.49, 0.89, 1.52],
    triangles: 180,
    geometry: ladder,
  }),
  defineModel({
    id: 'kettle',
    name: 'Kettle',
    category: 'props',
    tags: ['props', 'kitchen', 'appliance', 'tea', 'electric'],
    synonyms: ['electric kettle', 'tea kettle', 'teapot'],
    description: 'An enamel electric kettle on its base, spout towards −Y.',
    dimensions_m: [0.2, 0.27, 0.24],
    triangles: 708,
    geometry: kettle,
  }),
  defineModel({
    id: 'cooking_pot',
    name: 'Cooking pot',
    category: 'props',
    tags: ['props', 'kitchen', 'cookware', 'pot'],
    synonyms: ['saucepan', 'stock pot', 'casserole', 'pan', 'pot'],
    description: 'A steel cooking pot with a glass lid and two handles.',
    dimensions_m: [0.33, 0.26, 0.18],
    triangles: 1184,
    geometry: cookingPot,
  }),
  defineModel({
    id: 'fridge',
    name: 'Fridge',
    category: 'props',
    tags: ['props', 'kitchen', 'appliance', 'refrigerator'],
    synonyms: ['refrigerator', 'fridge freezer', 'icebox'],
    description: 'A white fridge-freezer, 1.8 m tall, its doors facing −Y.',
    dimensions_m: [0.7, 0.72, 1.8],
    triangles: 560,
    geometry: fridge,
  }),
  defineModel({
    id: 'stove',
    name: 'Stove',
    category: 'props',
    tags: ['props', 'kitchen', 'appliance', 'oven', 'cooking'],
    synonyms: ['cooker', 'oven', 'range', 'hob', 'cooktop'],
    description: 'A freestanding cooker with a glass hob, four burners and an oven door.',
    dimensions_m: [0.6, 0.64, 1],
    triangles: 1236,
    geometry: stove,
  }),
  defineModel({
    id: 'kitchen_counter',
    name: 'Kitchen counter',
    category: 'props',
    tags: ['props', 'kitchen', 'cabinet', 'sink', 'worktop'],
    synonyms: ['kitchen cabinets', 'countertop', 'kitchen unit', 'sink unit', 'kitchen'],
    description: 'A 1.8 m run of base cabinets with drawers, doors, an oak worktop, a sink and a tap.',
    dimensions_m: [1.82, 0.63, 1.25],
    triangles: 496,
    geometry: kitchenCounter,
  }),
  defineModel({
    id: 'whiteboard',
    name: 'Whiteboard',
    category: 'props',
    tags: ['props', 'office', 'school', 'board', 'meeting'],
    synonyms: ['white board', 'dry erase board', 'marker board', 'blackboard', 'chalkboard'],
    description: 'A whiteboard on a mobile stand with a marker tray and a few strokes.',
    dimensions_m: [1.28, 0.56, 1.74],
    triangles: 860,
    geometry: whiteboard,
  }),
  defineModel({
    id: 'filing_cabinet',
    name: 'Filing cabinet',
    category: 'props',
    tags: ['props', 'office', 'storage', 'cabinet', 'metal', 'drawers'],
    synonyms: ['file cabinet', 'filing drawers', 'file drawer', 'cabinet'],
    description: 'A four-drawer steel filing cabinet.',
    dimensions_m: [0.47, 0.64, 1.32],
    triangles: 156,
    geometry: filingCabinet,
  }),
];
