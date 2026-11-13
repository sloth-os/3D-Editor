import { z } from 'zod';
import type { Vec2 } from '../../math/types';
import { MeshBuilder, addBox, addBoxBetween, addPrism, addTube } from '../../generate/builder';
import { generateChair, generateShelf, generateTable } from '../../generate/furniture';
import { MATERIALS } from '../../generate/types';
import { Rng } from '../../generate/random';
import type { CatalogEntry } from '../types';
import {
  MATS,
  addCylinder,
  addLeg,
  addRoundLeg,
  addRoundedBox,
  addTorus,
  defineModel,
  generatedMaterial,
  generatedPart,
  paintFaces,
  part,
  tinted,
  type ModelGeometry,
  type ModelMaterial,
} from './kit';

/*
 * Built-in furniture (CATALOG-A): seating, tables, beds, storage and a rug. Original procedural
 * models in real sizes, standing on z = 0 with the base centred on the origin and the front (where
 * one sits, the doors and drawers) facing −Y. Upholstery, bedding and rugs take the `color` option,
 * and so does the main wood or paint of the wooden pieces (a painted chair, a red wardrobe).
 */

const SHARP = 0.75;

const fabric = (name: string, color: string): ModelMaterial => ({
  name,
  color,
  roughness: 0.92,
  sheen: 0.5,
  tint: true,
});

const WOOD = generatedMaterial(MATERIALS.wood);
const WOOD_DARK = generatedMaterial(MATERIALS.woodDark);

// ---------------------------------------------------------------- chairs

const chairParams = z.object({
  back: z.enum(['slats', 'panel']).default('slats').describe("Backrest: 'slats' or one 'panel'"),
});

function chair(p: z.output<typeof chairParams>): ModelGeometry {
  const res = generateChair({ back_style: p.back === 'panel' ? 'PANEL' : 'SLATS' });
  return { parts: [generatedPart('chair', res, [tinted(WOOD), WOOD_DARK])] };
}

/** Dining chair: upholstered seat and tall back on four slim wooden legs. */
function diningChair(): ModelGeometry {
  const frame = new MeshBuilder();
  const w = 0.46;
  const d = 0.5;
  const lx = w / 2 - 0.025;
  const ly = d / 2 - 0.025;
  for (const sx of [-1, 1]) {
    addLeg(frame, sx * lx, -ly, 0, 0.43, 0.032, 0.04, { mat: 0 });
    // back legs rise into the back posts
    addLeg(frame, sx * lx, ly, 0, 0.98, 0.034, 0.03, { mat: 0 });
    addBoxBetween(frame, [sx * lx, -ly, 0.16], [sx * lx, ly, 0.16], 0.018, 0.025, [0, 0, 1], { mat: 0 });
  }
  addBox(frame, [-lx, -ly - 0.01, 0.36], [lx, -ly + 0.01, 0.43], { mat: 0 });
  addBox(frame, [-lx, ly - 0.01, 0.36], [lx, ly + 0.01, 0.43], { mat: 0 });
  addBox(frame, [-lx, ly - 0.012, 0.93], [lx, ly + 0.012, 0.98], { mat: 0 });
  const up = new MeshBuilder();
  addRoundedBox(up, [-w / 2 + 0.005, -d / 2 - 0.005, 0.43], [w / 2 - 0.005, d / 2 - 0.02, 0.5], 0.025, {
    mat: 0,
  });
  addRoundedBox(up, [-lx + 0.018, ly - 0.03, 0.55], [lx - 0.018, ly + 0.0, 0.92], 0.012, { mat: 0 });
  return {
    parts: [
      part('frame', frame, [MATS.walnut], { sharpAngle: SHARP }),
      part('upholstery', up, [fabric('Chair Fabric', '#56715f')], { sharpAngle: SHARP }),
    ],
  };
}

/** Armchair: upholstered box frame with rolled arms, loose seat and back cushions, wooden feet. */
function armchair(): ModelGeometry {
  return { parts: sofaParts(1, 0.86, '#a35a3c', 'Armchair Fabric', 0.86) };
}

/**
 * Sofa of `seats` seats (each 0.62 m wide) with arms: frame (base, arms, back), one seat and one
 * back cushion per seat, and wooden feet.
 */
function sofaParts(
  seats: number,
  depth: number,
  color: string,
  fabricName: string,
  height = 0.84,
): ModelGeometry['parts'] {
  const arm = 0.17;
  const seatW = 0.62;
  const w = seats * seatW + 2 * arm;
  const d = depth;
  const legH = 0.1;
  const baseTop = 0.4;
  const armTop = 0.62;
  const backT = 0.2;
  const frame = new MeshBuilder();
  // base under the seat cushions
  addRoundedBox(
    frame,
    [-w / 2 + arm - 0.01, -d / 2 + 0.02, legH],
    [w / 2 - arm + 0.01, d / 2 - 0.02, baseTop],
    0.03,
    { mat: 0 },
  );
  // arms
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -w / 2 : w / 2 - arm;
    addRoundedBox(frame, [x0, -d / 2, legH], [x0 + arm, d / 2, armTop], 0.06, { mat: 0 });
  }
  // back
  addRoundedBox(
    frame,
    [-w / 2 + arm - 0.02, d / 2 - backT, legH],
    [w / 2 - arm + 0.02, d / 2, height],
    0.06,
    { mat: 0 },
  );
  const cushions = new MeshBuilder();
  const gap = 0.012;
  for (let i = 0; i < seats; i++) {
    const x0 = -w / 2 + arm + i * seatW + gap / 2;
    const x1 = x0 + seatW - gap;
    addRoundedBox(
      cushions,
      [x0, -d / 2 + 0.005, baseTop - 0.005],
      [x1, d / 2 - backT + 0.02, baseTop + 0.12],
      0.05,
      { mat: 0 },
    );
    // back cushion leaning on the back
    addRoundedBox(
      cushions,
      [x0, d / 2 - backT - 0.13, baseTop + 0.1],
      [x1, d / 2 - backT + 0.01, height - 0.05],
      0.06,
      { mat: 0 },
    );
  }
  const legs = new MeshBuilder();
  const lx = w / 2 - 0.07;
  const ly = d / 2 - 0.07;
  const xs = seats >= 3 ? [-lx, 0, lx] : [-lx, lx];
  for (const x of xs)
    for (const y of [-ly, ly]) addRoundLeg(legs, x, y, 0, legH + 0.005, 0.018, 0.026, 10, { mat: 0 });
  const mat = fabric(fabricName, color);
  return [
    part('frame', frame, [mat], { sharpAngle: SHARP }),
    part('cushions', cushions, [mat], { sharpAngle: SHARP }),
    part('legs', legs, [MATS.walnut], { sharpAngle: SHARP }),
  ];
}

const sofaParams = z.object({
  seats: z.number().int().min(1).max(5).default(3).describe('Number of seats (1–5)'),
});

// ---------------------------------------------------------------- tables

function coffeeTable(): ModelGeometry {
  const w = 1.1;
  const d = 0.6;
  const h = 0.42;
  const top = new MeshBuilder();
  addRoundedBox(top, [-w / 2, -d / 2, h - 0.04], [w / 2, d / 2, h], 0.012, { mat: 0, cs: 2 });
  addBox(top, [-w / 2 + 0.06, -d / 2 + 0.06, 0.1], [w / 2 - 0.06, d / 2 - 0.06, 0.125], { mat: 0 });
  const frame = new MeshBuilder();
  const lx = w / 2 - 0.06;
  const ly = d / 2 - 0.06;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) addLeg(frame, sx * lx, sy * ly, 0, h - 0.04, 0.032, 0.045, { mat: 0 });
  return {
    parts: [
      part('top', top, [tinted(MATS.oak)], { sharpAngle: SHARP }),
      part('legs', frame, [MATS.walnut], { sharpAngle: SHARP }),
    ],
  };
}

function table(): ModelGeometry {
  return {
    parts: [generatedPart('table', generateTable({ width: 1.6, depth: 0.9 }), [tinted(WOOD), WOOD_DARK])],
  };
}

function roundTable(): ModelGeometry {
  return {
    parts: [
      generatedPart('table', generateTable({ shape: 'ROUND', width: 1.0 }), [tinted(WOOD), WOOD_DARK]),
    ],
  };
}

function drawerFront(
  b: MeshBuilder,
  x0: number,
  x1: number,
  y: number,
  z0: number,
  z1: number,
  mat: number,
  handleMat: number,
): void {
  addBox(b, [x0, y - 0.018, z0], [x1, y, z1], { mat });
  const cx = (x0 + x1) / 2;
  const cz = z1 - Math.min(0.05, (z1 - z0) * 0.3);
  const hw = Math.min(0.06, (x1 - x0) * 0.25);
  addBoxBetween(b, [cx - hw, y - 0.035, cz], [cx + hw, y - 0.035, cz], 0.012, 0.012, [0, 0, 1], {
    mat: handleMat,
  });
  for (const sx of [-1, 1])
    addBox(b, [cx + sx * hw - 0.005, y - 0.035, cz - 0.005], [cx + sx * hw + 0.005, y - 0.017, cz + 0.005], {
      mat: handleMat,
    });
}

function desk(): ModelGeometry {
  const w = 1.4;
  const d = 0.7;
  const h = 0.75;
  const top = new MeshBuilder();
  addRoundedBox(top, [-w / 2, -d / 2, h - 0.035], [w / 2, d / 2, h], 0.008, { mat: 0, cs: 2 });
  // drawer pedestal on the left (seen from the front)
  const ped = new MeshBuilder();
  const px0 = -w / 2 + 0.02;
  const px1 = px0 + 0.42;
  const py0 = -d / 2 + 0.03;
  const py1 = d / 2 - 0.03;
  addBox(ped, [px0, py0 + 0.018, 0], [px1, py1, h - 0.035], { mat: 0 });
  for (let i = 0; i < 3; i++) {
    const z0 = 0.03 + i * 0.225;
    drawerFront(ped, px0 + 0.012, px1 - 0.012, py0 + 0.018, z0, z0 + 0.21, 0, 1);
  }
  // metal legs on the right and a modesty panel
  const legs = new MeshBuilder();
  for (const sy of [-1, 1])
    addLeg(legs, w / 2 - 0.05, sy * (d / 2 - 0.05), 0, h - 0.035, 0.04, 0.04, { mat: 0 });
  addBox(legs, [w / 2 - 0.07, -d / 2 + 0.05, 0.05], [w / 2 - 0.03, d / 2 - 0.05, 0.09], { mat: 0 });
  addBox(top, [px1, d / 2 - 0.06, 0.3], [w / 2 - 0.07, d / 2 - 0.04, h - 0.035], { mat: 0 });
  return {
    parts: [
      part('top', top, [tinted(MATS.oak)], { sharpAngle: SHARP }),
      part('drawers', ped, [MATS.whitePaint, MATS.steel], { sharpAngle: SHARP }),
      part('legs', legs, [MATS.blackMetal], { sharpAngle: SHARP }),
    ],
  };
}

/** Office swivel chair: five-star base on casters, gas lift, padded seat and back, armrests. */
function officeChair(): ModelGeometry {
  const base = new MeshBuilder();
  const arms = 5;
  const reach = 0.31;
  for (let k = 0; k < arms; k++) {
    const a = (2 * Math.PI * k) / arms - Math.PI / 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    addBoxBetween(base, [0.03 * c, 0.03 * s, 0.085], [reach * c, reach * s, 0.075], 0.045, 0.035, [0, 0, 1], {
      mat: 0,
    });
    // caster: a wheel under each arm's tip
    addCylinder(base, reach * c, reach * s, 0.012, 0.05, 0.075, 8, { mat: 1 });
    const wb = new MeshBuilder();
    void wb;
    addTorus(base, [reach * c, reach * s, 0.025], 0.014, 0.012, 12, 6, { mat: 2 });
  }
  addCylinder(base, 0, 0, 0.06, 0.06, 0.11, 16, { mat: 0 });
  addCylinder(base, 0, 0, 0.028, 0.1, 0.42, 14, { mat: 1 });
  addBox(base, [-0.09, -0.09, 0.4], [0.09, 0.09, 0.44], { mat: 0 });
  const seat = new MeshBuilder();
  addRoundedBox(seat, [-0.25, -0.26, 0.44], [0.25, 0.22, 0.52], 0.04, { mat: 0 });
  // backrest on a spine from under the seat
  addBoxBetween(base, [0, 0.12, 0.43], [0, 0.27, 0.5], 0.05, 0.02, [0, -1, 0], { mat: 0 });
  addBoxBetween(base, [0, 0.27, 0.5], [0, 0.29, 0.66], 0.05, 0.02, [0, -1, 0], { mat: 0 });
  addRoundedBox(seat, [-0.23, 0.25, 0.6], [0.23, 0.31, 1.05], 0.035, { mat: 0 });
  // armrests
  for (const sx of [-1, 1]) {
    addBoxBetween(base, [sx * 0.24, -0.02, 0.48], [sx * 0.27, -0.02, 0.66], 0.03, 0.03, [0, 1, 0], {
      mat: 0,
    });
    addRoundedBox(base, [sx * 0.27 - 0.035, -0.17, 0.655], [sx * 0.27 + 0.035, 0.08, 0.685], 0.012, {
      mat: 0,
      cs: 2,
    });
  }
  return {
    parts: [
      part('base', base, [MATS.blackPlastic, MATS.chrome, MATS.rubber], { sharpAngle: SHARP }),
      part('seat', seat, [fabric('Office Fabric', '#2f3540')], { sharpAngle: SHARP }),
    ],
  };
}

function stool(): ModelGeometry {
  const b = new MeshBuilder();
  const h = 0.46;
  addCylinder(b, 0, 0, 0.175, h - 0.035, h, 24, { mat: 0 });
  const legs = new MeshBuilder();
  for (let k = 0; k < 4; k++) {
    const a = (Math.PI / 2) * k + Math.PI / 4;
    const top: [number, number, number] = [0.11 * Math.cos(a), 0.11 * Math.sin(a), h - 0.035];
    const foot: [number, number, number] = [0.17 * Math.cos(a), 0.17 * Math.sin(a), 0.012];
    addTube(legs, [foot, top], 0.016, 8, { mat: 0, smooth: true });
    addCylinder(legs, foot[0], foot[1], 0.017, 0, 0.012, 8, { mat: 0 });
  }
  addTorus(legs, [0, 0, 0.17], 0.153, 0.009, 24, 6, { mat: 0 });
  return {
    parts: [
      part('seat', b, [tinted(MATS.oak)], { sharpAngle: SHARP }),
      part('legs', legs, [MATS.walnut], { sharpAngle: SHARP }),
    ],
  };
}

// ---------------------------------------------------------------- beds

const bedParams = z.object({
  size: z.enum(['single', 'double', 'queen', 'king']).default('double').describe('Mattress size'),
});

const BED_WIDTH = { single: 0.9, double: 1.4, queen: 1.6, king: 1.8 } as const;

function bed(size: keyof typeof BED_WIDTH): ModelGeometry {
  const mw = BED_WIDTH[size];
  const ml = 2.0;
  const frameT = 0.05;
  const w = mw + 2 * frameT;
  const l = ml + 2 * frameT;
  const frame = new MeshBuilder();
  const railTop = 0.32;
  // side rails, foot board, legs and the headboard at the back (+Y)
  addBox(frame, [-w / 2, -l / 2, 0.12], [-w / 2 + frameT, l / 2, railTop], { mat: 0 });
  addBox(frame, [w / 2 - frameT, -l / 2, 0.12], [w / 2, l / 2, railTop], { mat: 0 });
  addBox(frame, [-w / 2 + frameT, -l / 2, 0.12], [w / 2 - frameT, -l / 2 + frameT, railTop + 0.06], {
    mat: 0,
  });
  addBox(frame, [-w / 2 + frameT, -l / 2 + frameT, 0.2], [w / 2 - frameT, l / 2 - frameT, 0.24], { mat: 0 });
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      addLeg(frame, sx * (w / 2 - 0.035), sy * (l / 2 - 0.035), 0, 0.13, 0.06, 0.06, { mat: 0 });
  const headH = 0.95 + (mw > 1 ? 0.05 : 0);
  addRoundedBox(frame, [-w / 2, l / 2 - 0.07, 0], [w / 2, l / 2, headH], 0.02, { mat: 0, cs: 2 });
  const mattress = new MeshBuilder();
  addRoundedBox(mattress, [-mw / 2, -ml / 2, 0.24], [mw / 2, ml / 2, 0.48], 0.05, { mat: 0 });
  // pillows near the headboard
  const pillows = mw > 1.2 ? 2 : 1;
  const pw = (mw - 0.12) / pillows;
  for (let i = 0; i < pillows; i++) {
    const x0 = -mw / 2 + 0.06 + i * pw + 0.02;
    addRoundedBox(mattress, [x0, ml / 2 - 0.5, 0.47], [x0 + pw - 0.04, ml / 2 - 0.08, 0.6], 0.06, { mat: 0 });
  }
  // duvet over the lower two thirds, hanging over the sides
  const duvet = new MeshBuilder();
  addRoundedBox(duvet, [-mw / 2 - 0.035, -ml / 2 - 0.035, 0.3], [mw / 2 + 0.035, ml / 2 - 0.55, 0.53], 0.04, {
    mat: 0,
  });
  return {
    parts: [
      part('frame', frame, [MATS.walnut], { sharpAngle: SHARP }),
      part('mattress', mattress, [MATS.linen], { sharpAngle: SHARP }),
      part('duvet', duvet, [fabric('Duvet', '#7d97b3')], { sharpAngle: SHARP }),
    ],
  };
}

// ---------------------------------------------------------------- storage

function wardrobe(): ModelGeometry {
  const w = 1.0;
  const d = 0.6;
  const h = 2.0;
  const body = new MeshBuilder();
  addBox(body, [-w / 2, -d / 2 + 0.02, 0.08], [w / 2, d / 2, h - 0.04], { mat: 0 });
  addBox(body, [-w / 2 + 0.03, -d / 2 + 0.04, 0], [w / 2 - 0.03, d / 2 - 0.02, 0.08], { mat: 1 });
  addBox(body, [-w / 2 - 0.015, -d / 2 + 0.005, h - 0.04], [w / 2 + 0.015, d / 2 + 0.015, h], { mat: 0 });
  const doors = new MeshBuilder();
  const gap = 0.004;
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -w / 2 + 0.01 : gap;
    const x1 = sx < 0 ? -gap : w / 2 - 0.01;
    addBox(doors, [x0, -d / 2, 0.1], [x1, -d / 2 + 0.02, h - 0.06], { mat: 0 });
    // vertical bar handle next to the middle
    const hx = sx * 0.04;
    addRoundLeg(doors, hx, -d / 2 - 0.022, 1.0, 1.3, 0.008, 0.008, 8, { mat: 1 });
    for (const z of [1.02, 1.28])
      addBoxBetween(doors, [hx, -d / 2 - 0.02, z], [hx, -d / 2 + 0.002, z], 0.01, 0.01, [0, 0, 1], {
        mat: 1,
      });
  }
  return {
    parts: [
      part('body', body, [tinted(MATS.oak), MATS.darkWood], { sharpAngle: SHARP }),
      part('doors', doors, [tinted(MATS.oak), MATS.steel], { sharpAngle: SHARP }),
    ],
  };
}

function nightstand(): ModelGeometry {
  const w = 0.45;
  const d = 0.4;
  const h = 0.55;
  const b = new MeshBuilder();
  addBox(b, [-w / 2, -d / 2 + 0.018, 0.1], [w / 2, d / 2, h - 0.025], { mat: 0 });
  addRoundedBox(b, [-w / 2 - 0.01, -d / 2 - 0.005, h - 0.025], [w / 2 + 0.01, d / 2 + 0.005, h], 0.006, {
    mat: 0,
    cs: 2,
  });
  for (let i = 0; i < 2; i++) {
    const z0 = 0.115 + i * 0.205;
    drawerFront(b, -w / 2 + 0.012, w / 2 - 0.012, -d / 2 + 0.018, z0, z0 + 0.19, 0, 2);
  }
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      addLeg(b, sx * (w / 2 - 0.03), sy * (d / 2 - 0.03), 0, 0.1, 0.022, 0.03, { mat: 1 });
  return {
    parts: [part('nightstand', b, [tinted(MATS.whitePaint), MATS.walnut, MATS.steel], { sharpAngle: SHARP })],
  };
}

const BOOK_COLORS: ModelMaterial[] = [
  { name: 'Book Red', color: '#8e2f2a', roughness: 0.6 },
  { name: 'Book Blue', color: '#2d4a73', roughness: 0.6 },
  { name: 'Book Green', color: '#3e6249', roughness: 0.6 },
  { name: 'Book Ochre', color: '#c08a2e', roughness: 0.6 },
  { name: 'Book Cream', color: '#e3d8bf', roughness: 0.7 },
  { name: 'Book Black', color: '#24262b', roughness: 0.55 },
];

/**
 * Rows of books standing on shelves between x0 and x1 (y from the back `yb` forward to `yf`), on
 * boards at the heights given, each row up to `maxH` tall; slot i of `mats` is book colour i.
 */
export function addBookRows(
  b: MeshBuilder,
  rng: Rng,
  x0: number,
  x1: number,
  yb: number,
  yf: number,
  boards: readonly number[],
  maxH: number,
): void {
  for (const z of boards) {
    let x = x0 + rng.range(0, 0.04);
    // leave a gap at a random end of some rows
    const end = x1 - (rng.chance(0.5) ? rng.range(0.05, 0.25) : 0);
    while (x < end - 0.02) {
      const t = rng.range(0.018, 0.045);
      if (x + t > end) break;
      const h = maxH * rng.range(0.62, 0.98);
      const depth = (yf - yb) * rng.range(0.75, 0.95);
      const mat = rng.int(0, BOOK_COLORS.length - 1);
      // now and then a book leans on its neighbour
      addBox(b, [x, yb, z], [x + t, yb + depth, z + h], { mat });
      x += t + rng.range(0.0, 0.004);
    }
  }
}

function bookshelf(): ModelGeometry {
  const w = 0.8;
  const d = 0.3;
  const h = 1.8;
  const shelf = generateShelf({ width: w, depth: d, height: h, shelves: 5 });
  // boards as generateShelf spaces them: from the kick (0.06) to h − thickness
  const t = 0.02;
  const kick = Math.min(0.06, h * 0.1);
  const boards: number[] = [];
  for (let k = 0; k < 4; k++) boards.push(kick + ((h - t - kick) * k) / 4 + t);
  const books = new MeshBuilder();
  addBookRows(
    books,
    new Rng(7),
    -w / 2 + t + 0.01,
    w / 2 - t - 0.01,
    d / 2 - 0.27,
    d / 2 - 0.01,
    boards,
    (h - t - kick) / 4 - t - 0.04,
  );
  return {
    parts: [
      generatedPart('shelf', shelf, [tinted(WOOD), WOOD_DARK]),
      part('books', books, BOOK_COLORS, { sharpAngle: SHARP }),
    ],
  };
}

function tvStand(): ModelGeometry {
  const w = 1.6;
  const d = 0.42;
  const h = 0.5;
  const b = new MeshBuilder();
  const z0 = 0.1;
  // carcass: top, bottom, sides and two dividers with an open middle bay
  addBox(b, [-w / 2, -d / 2, h - 0.025], [w / 2, d / 2, h], { mat: 0 });
  addBox(b, [-w / 2, -d / 2, z0], [w / 2, d / 2, z0 + 0.025], { mat: 0 });
  for (const x of [-w / 2, w / 2 - 0.025, -0.25, 0.225])
    addBox(b, [x, -d / 2, z0 + 0.025], [x + 0.025, d / 2, h - 0.025], { mat: 0 });
  addBox(b, [-w / 2 + 0.025, d / 2 - 0.012, z0 + 0.025], [w / 2 - 0.025, d / 2, h - 0.025], { mat: 0 });
  addBox(b, [-0.225, -d / 2 + 0.04, 0.27], [0.225, d / 2 - 0.012, 0.29], { mat: 0 });
  // doors of the two side bays
  for (const [x0, x1] of [
    [-w / 2 + 0.028, -0.253],
    [0.253, w / 2 - 0.028],
  ] as const) {
    addBox(b, [x0, -d / 2 - 0.018, z0 + 0.03], [x1, -d / 2, h - 0.03], { mat: 1 });
    const hx = x0 < 0 ? x1 - 0.04 : x0 + 0.04;
    addBox(b, [hx - 0.006, -d / 2 - 0.03, 0.3], [hx + 0.006, -d / 2 - 0.018, 0.4], { mat: 2 });
  }
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      addLeg(b, sx * (w / 2 - 0.06), sy * (d / 2 - 0.05), 0, z0, 0.025, 0.035, { mat: 2 });
  return {
    parts: [
      part('stand', b, [tinted(MATS.walnut), MATS.whitePaint, MATS.blackMetal], { sharpAngle: SHARP }),
    ],
  };
}

/** Rug: a woven rectangle with a border, a thin inner line and a plain field (the field takes `color`). */
function rug(): ModelGeometry {
  const w = 2.0;
  const l = 1.4;
  const h = 0.012;
  const nx = 20;
  const ny = 14;
  const b = new MeshBuilder();
  const top: number[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) row.push(b.vert([-w / 2 + (w * i) / nx, -l / 2 + (l * j) / ny, h]));
    top.push(row);
  }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const ring = Math.min(i, j, nx - 1 - i, ny - 1 - j);
      const mat = ring < 2 ? 0 : ring === 2 ? 1 : 2;
      b.face([top[j][i], top[j][i + 1], top[j + 1][i + 1], top[j + 1][i]], mat);
    }
  // sides and bottom (border colour)
  const outline: Vec2[] = [
    [-w / 2, -l / 2],
    [w / 2, -l / 2],
    [w / 2, l / 2],
    [-w / 2, l / 2],
  ];
  const start = b.faceCount;
  addPrism(b, outline, 0, h, { mat: 0, noTop: true });
  paintFaces(b, start, () => 0);
  return {
    parts: [
      part('rug', b, [
        { name: 'Rug Border', color: '#5e2a26', roughness: 0.95, sheen: 0.6 },
        { name: 'Rug Line', color: '#e2d3b3', roughness: 0.95, sheen: 0.6 },
        { name: 'Rug Field', color: '#a1543c', roughness: 0.95, sheen: 0.6, tint: true },
      ]),
    ],
  };
}

// ---------------------------------------------------------------- the list

const SEAT = ['furniture', 'seat', 'seating', 'indoor'];

/** The built-in furniture. */
export const FURNITURE_MODELS: CatalogEntry[] = [
  defineModel({
    id: 'chair',
    name: 'Wooden chair',
    category: 'furniture',
    tags: [...SEAT, 'chair', 'wood', 'kitchen', 'dining'],
    synonyms: ['chair', 'kitchen chair', 'side chair', 'seat'],
    description: 'A plain wooden chair with a slatted (or panel) back, 0.45 m seat height.',
    dimensions_m: [0.45, 0.45, 0.9],
    triangles: 120,
    params: chairParams,
    geometry: chair,
  }),
  defineModel({
    id: 'dining_chair',
    name: 'Dining chair',
    category: 'furniture',
    tags: [...SEAT, 'chair', 'dining', 'upholstered', 'wood'],
    synonyms: ['upholstered chair', 'restaurant chair', 'padded chair'],
    description: 'A dining chair with an upholstered seat and tall back on slim walnut legs.',
    dimensions_m: [0.45, 0.5, 0.98],
    triangles: 628,
    geometry: diningChair,
  }),
  defineModel({
    id: 'armchair',
    name: 'Armchair',
    category: 'furniture',
    tags: [...SEAT, 'chair', 'living room', 'upholstered', 'lounge'],
    synonyms: ['easy chair', 'lounge chair', 'club chair', 'fauteuil', 'recliner'],
    description: 'An upholstered armchair with loose cushions on short wooden feet.',
    dimensions_m: [0.96, 0.86, 0.86],
    triangles: 1672,
    geometry: armchair,
  }),
  defineModel({
    id: 'sofa',
    name: 'Sofa',
    category: 'furniture',
    tags: [...SEAT, 'living room', 'upholstered', 'lounge'],
    synonyms: ['couch', 'settee', 'three seater', '3-seat sofa', 'chesterfield', 'divan'],
    description:
      'A three-seat upholstered sofa (seats 1–5 with the seats parameter) with arms and loose cushions.',
    dimensions_m: [2.2, 0.9, 0.84],
    triangles: 2760,
    params: sofaParams,
    geometry: (p) => ({ parts: sofaParts(p.seats, 0.9, '#6e7d8c', 'Sofa Fabric') }),
  }),
  defineModel({
    id: 'loveseat',
    name: 'Two-seat sofa',
    category: 'furniture',
    tags: [...SEAT, 'sofa', 'living room', 'upholstered', 'lounge'],
    synonyms: ['loveseat', 'love seat', 'small sofa', 'two seater', '2-seat sofa', 'small couch'],
    description: 'A two-seat upholstered sofa with arms and loose cushions.',
    dimensions_m: [1.58, 0.88, 0.84],
    triangles: 2176,
    geometry: () => ({ parts: sofaParts(2, 0.88, '#7a8a73', 'Loveseat Fabric') }),
  }),
  defineModel({
    id: 'coffee_table',
    name: 'Coffee table',
    category: 'furniture',
    tags: ['furniture', 'table', 'living room', 'wood', 'low'],
    synonyms: ['low table', 'cocktail table', 'centre table', 'center table'],
    description: 'A low oak coffee table with a lower shelf.',
    dimensions_m: [1.1, 0.6, 0.42],
    triangles: 216,
    geometry: coffeeTable,
  }),
  defineModel({
    id: 'table',
    name: 'Dining table',
    category: 'furniture',
    tags: ['furniture', 'table', 'dining', 'kitchen', 'wood'],
    synonyms: ['table', 'kitchen table', 'rectangular table', 'dinner table'],
    description: 'A rectangular wooden dining table for six (1.6 × 0.9 m).',
    dimensions_m: [1.6, 0.9, 0.75],
    triangles: 108,
    geometry: table,
  }),
  defineModel({
    id: 'round_table',
    name: 'Round table',
    category: 'furniture',
    tags: ['furniture', 'table', 'dining', 'kitchen', 'cafe', 'wood', 'round'],
    synonyms: ['circular table', 'pedestal table', 'bistro table', 'cafe table'],
    description: 'A round wooden pedestal table, 1 m across.',
    dimensions_m: [1, 1, 0.75],
    triangles: 448,
    geometry: roundTable,
  }),
  defineModel({
    id: 'desk',
    name: 'Desk',
    category: 'furniture',
    tags: ['furniture', 'table', 'office', 'study', 'work', 'drawers'],
    synonyms: ['writing desk', 'office desk', 'workstation', 'bureau', 'computer desk'],
    description: 'An office desk with an oak top, a three-drawer pedestal and black metal legs.',
    dimensions_m: [1.4, 0.7, 0.75],
    triangles: 352,
    geometry: desk,
  }),
  defineModel({
    id: 'office_chair',
    name: 'Office chair',
    category: 'furniture',
    tags: [...SEAT, 'chair', 'office', 'swivel', 'work'],
    synonyms: ['desk chair', 'swivel chair', 'task chair', 'computer chair'],
    description: 'A swivel office chair on a five-star base with casters, padded seat, back and armrests.',
    dimensions_m: [0.64, 0.65, 1.03],
    triangles: 1904,
    geometry: officeChair,
  }),
  defineModel({
    id: 'stool',
    name: 'Stool',
    category: 'furniture',
    tags: [...SEAT, 'stool', 'wood', 'kitchen'],
    synonyms: ['footstool', 'kitchen stool', 'milking stool', 'round stool'],
    description: 'A round wooden stool on four splayed legs with a foot ring.',
    dimensions_m: [0.35, 0.35, 0.46],
    triangles: 624,
    geometry: stool,
  }),
  defineModel({
    id: 'bed',
    name: 'Double bed',
    category: 'furniture',
    tags: ['furniture', 'bed', 'bedroom', 'sleep'],
    synonyms: ['double bed', 'queen bed', 'king bed', 'bedstead', 'mattress'],
    description:
      'A double bed (single, double, queen or king with the size parameter) with headboard, pillows and duvet.',
    dimensions_m: [1.5, 2.1, 1],
    triangles: 1260,
    params: bedParams,
    geometry: (p) => bed(p.size),
  }),
  defineModel({
    id: 'single_bed',
    name: 'Single bed',
    category: 'furniture',
    tags: ['furniture', 'bed', 'bedroom', 'sleep', 'child'],
    synonyms: ['single bed', 'twin bed', 'cot', 'kids bed'],
    description: 'A single bed with headboard, pillow and duvet.',
    dimensions_m: [1, 2.1, 0.95],
    triangles: 1008,
    geometry: () => bed('single'),
  }),
  defineModel({
    id: 'wardrobe',
    name: 'Wardrobe',
    category: 'furniture',
    tags: ['furniture', 'storage', 'bedroom', 'cabinet', 'cupboard'],
    synonyms: ['closet', 'armoire', 'cupboard', 'clothes cabinet'],
    description: 'A two-door oak wardrobe with bar handles, 2 m tall.',
    dimensions_m: [1.03, 0.65, 2],
    triangles: 172,
    geometry: wardrobe,
  }),
  defineModel({
    id: 'nightstand',
    name: 'Nightstand',
    category: 'furniture',
    tags: ['furniture', 'storage', 'bedroom', 'drawers', 'cabinet'],
    synonyms: ['bedside table', 'night table', 'bedside cabinet', 'side table'],
    description: 'A white two-drawer nightstand on walnut feet.',
    dimensions_m: [0.47, 0.43, 0.55],
    triangles: 312,
    geometry: nightstand,
  }),
  defineModel({
    id: 'bookshelf',
    name: 'Bookshelf',
    category: 'furniture',
    tags: ['furniture', 'storage', 'shelf', 'books', 'library', 'study'],
    synonyms: ['bookcase', 'shelves', 'shelving', 'book rack'],
    description: 'A tall wooden bookshelf with five shelves of books.',
    dimensions_m: [0.8, 0.3, 1.8],
    triangles: 972,
    geometry: bookshelf,
  }),
  defineModel({
    id: 'tv_stand',
    name: 'TV stand',
    category: 'furniture',
    tags: ['furniture', 'storage', 'living room', 'media', 'cabinet', 'low'],
    synonyms: ['media console', 'tv cabinet', 'tv unit', 'sideboard', 'entertainment center'],
    description: 'A low walnut media cabinet with two white doors and an open middle bay.',
    dimensions_m: [1.6, 0.45, 0.5],
    triangles: 208,
    geometry: tvStand,
  }),
  defineModel({
    id: 'rug',
    name: 'Rug',
    category: 'furniture',
    tags: ['furniture', 'rug', 'floor', 'living room', 'textile'],
    synonyms: ['carpet', 'mat', 'area rug', 'runner'],
    description: 'A 2 × 1.4 m woven rug with a border; its field takes the colour.',
    dimensions_m: [2, 1.4, 0.012],
    triangles: 570,
    geometry: rug,
  }),
];
