import type { Vec2, Vec3 } from '../math/types';
import {
  MeshBuilder,
  addBox,
  addBoxBetween,
  addLathe,
  addRingSurface,
  clampNum,
  markSharpEdges,
  profileIsClockwise,
} from './builder';
import { MATERIALS, type GeneratorResult } from './types';

/*
 * Simple furniture and props: table, chair, shelf, wheel and barrel. Furniture stands on z = 0
 * with its front facing −Y (Blender's front view); slot 0 is the main surface, slot 1 the frame.
 */

// ------------------------------------------------------------------ table

export interface TableParams {
  /** Size along X (ROUND: diameter) in metres. */
  width: number;
  /** Size along Y in metres (ignored for ROUND). */
  depth: number;
  /** Height of the top surface in metres. */
  height: number;
  top_thickness: number;
  leg_thickness: number;
  /** RECTANGLE: four legs with aprons; ROUND: round top on a central pedestal. */
  shape: 'RECTANGLE' | 'ROUND';
}

export const TABLE_DEFAULTS: TableParams = {
  width: 1.4,
  depth: 0.8,
  height: 0.75,
  top_thickness: 0.04,
  leg_thickness: 0.06,
  shape: 'RECTANGLE',
};

/** Table. Slots: 0 top (Wood), 1 legs/frame (Wood Dark). */
export function generateTable(params: Partial<TableParams> = {}): GeneratorResult {
  const p = { ...TABLE_DEFAULTS, ...params };
  const w = clampNum(p.width, 0.05, 100, TABLE_DEFAULTS.width);
  const d = clampNum(p.depth, 0.05, 100, TABLE_DEFAULTS.depth);
  const h = clampNum(p.height, 0.05, 100, TABLE_DEFAULTS.height);
  const tt = clampNum(p.top_thickness, 0.002, h * 0.5, Math.min(TABLE_DEFAULTS.top_thickness, h * 0.5));
  const lt = clampNum(p.leg_thickness, 0.005, Math.min(w, d) * 0.3, Math.min(w, d) * 0.1);
  const b = new MeshBuilder();
  const legH = h - tt;
  if (p.shape === 'ROUND') {
    const r = w / 2;
    addLathe(
      b,
      [
        [0, legH],
        [r, legH],
        [r, h],
        [0, h],
      ],
      48,
      { mat: 0, smooth: true },
    );
    const pr = Math.max(lt * 0.75, r * 0.08);
    const baseR = Math.max(pr * 2, r * 0.45);
    const baseH = Math.min(0.04, legH * 0.2);
    addLathe(
      b,
      [
        [0, 0],
        [baseR, 0],
        [baseR * 0.9, baseH],
        [pr, baseH * 1.5],
        [pr, legH],
        [0, legH],
      ],
      32,
      { mat: 1, smooth: true },
    );
  } else {
    addBox(b, [-w / 2, -d / 2, legH], [w / 2, d / 2, h], { mat: 0 });
    const inset = lt / 2 + Math.min(0.03, Math.min(w, d) * 0.05);
    const lx = w / 2 - inset;
    const ly = d / 2 - inset;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        addBox(b, [sx * lx - lt / 2, sy * ly - lt / 2, 0], [sx * lx + lt / 2, sy * ly + lt / 2, legH], { mat: 1 });
    // aprons connecting the legs under the top
    const ah = Math.min(0.08, legH * 0.25);
    const at = Math.min(0.02, lt * 0.5);
    for (const sy of [-1, 1]) addBox(b, [-lx, sy * ly - at / 2, legH - ah], [lx, sy * ly + at / 2, legH], { mat: 1 });
    for (const sx of [-1, 1]) addBox(b, [sx * lx - at / 2, -ly, legH - ah], [sx * lx + at / 2, ly, legH], { mat: 1 });
  }
  const mesh = b.build();
  markSharpEdges(mesh, 0.7);
  return { mesh, materials: [MATERIALS.wood, MATERIALS.woodDark] };
}

// ------------------------------------------------------------------ chair

export interface ChairParams {
  width: number;
  depth: number;
  /** Height of the top of the seat in metres. */
  seat_height: number;
  /** Height of the backrest above the seat in metres. */
  back_height: number;
  seat_thickness: number;
  leg_thickness: number;
  /** SLATS: three horizontal slats; PANEL: one solid backrest board. */
  back_style: 'SLATS' | 'PANEL';
}

export const CHAIR_DEFAULTS: ChairParams = {
  width: 0.45,
  depth: 0.45,
  seat_height: 0.45,
  back_height: 0.45,
  seat_thickness: 0.05,
  leg_thickness: 0.04,
  back_style: 'SLATS',
};

/** Chair facing −Y (backrest on the +Y side). Slots: 0 seat & backrest (Wood), 1 frame (Wood Dark). */
export function generateChair(params: Partial<ChairParams> = {}): GeneratorResult {
  const p = { ...CHAIR_DEFAULTS, ...params };
  const w = clampNum(p.width, 0.05, 100, CHAIR_DEFAULTS.width);
  const d = clampNum(p.depth, 0.05, 100, CHAIR_DEFAULTS.depth);
  const sh = clampNum(p.seat_height, 0.05, 100, CHAIR_DEFAULTS.seat_height);
  const bh = clampNum(p.back_height, 0, 100, CHAIR_DEFAULTS.back_height);
  const st = clampNum(p.seat_thickness, 0.005, sh * 0.5, Math.min(0.05, sh * 0.5));
  const lt = clampNum(p.leg_thickness, 0.005, Math.min(w, d) * 0.3, Math.min(w, d) * 0.1);
  const b = new MeshBuilder();
  const legTop = sh - st;
  addBox(b, [-w / 2, -d / 2, legTop], [w / 2, d / 2, sh], { mat: 0 });
  const lx = w / 2 - lt / 2;
  const ly = d / 2 - lt / 2;
  for (const sx of [-1, 1]) {
    addBox(b, [sx * lx - lt / 2, -ly - lt / 2, 0], [sx * lx + lt / 2, -ly + lt / 2, legTop], { mat: 1 });
    // back legs continue up as the backrest posts
    addBox(b, [sx * lx - lt / 2, ly - lt / 2, 0], [sx * lx + lt / 2, ly + lt / 2, sh + bh], { mat: 1 });
    // side stretcher
    const zs = Math.min(0.15, legTop * 0.35);
    addBoxBetween(b, [sx * lx, -ly, zs], [sx * lx, ly, zs], lt * 0.5, lt * 0.7, [0, 0, 1], { mat: 1 });
  }
  if (bh > 0.02) {
    const inner = lx - lt / 2;
    const bt = Math.min(0.025, lt * 0.6);
    if (p.back_style === 'PANEL') {
      addBox(b, [-inner - 0.002, ly - bt / 2, sh + bh * 0.3], [inner + 0.002, ly + bt / 2, sh + bh * 0.95], {
        mat: 0,
      });
    } else {
      const slatH = Math.min(0.06, bh * 0.18);
      for (const f of [0.35, 0.62, 0.88])
        addBox(b, [-inner - 0.002, ly - bt / 2, sh + bh * f - slatH / 2], [inner + 0.002, ly + bt / 2, sh + bh * f + slatH / 2], {
          mat: 0,
        });
    }
  }
  const mesh = b.build();
  return { mesh, materials: [MATERIALS.wood, MATERIALS.woodDark] };
}

// ------------------------------------------------------------------ shelf

export interface ShelfParams {
  width: number;
  depth: number;
  height: number;
  /** Number of horizontal boards including the bottom and top board (2..50). */
  shelves: number;
  board_thickness: number;
  /** Close the back with a thin panel. */
  back_panel: boolean;
}

export const SHELF_DEFAULTS: ShelfParams = {
  width: 0.8,
  depth: 0.3,
  height: 1.8,
  shelves: 5,
  board_thickness: 0.02,
  back_panel: true,
};

/** Open bookshelf facing −Y. Slots: 0 boards (Wood), 1 sides, back and plinth (Wood Dark). */
export function generateShelf(params: Partial<ShelfParams> = {}): GeneratorResult {
  const p = { ...SHELF_DEFAULTS, ...params };
  const w = clampNum(p.width, 0.05, 100, SHELF_DEFAULTS.width);
  const d = clampNum(p.depth, 0.02, 100, SHELF_DEFAULTS.depth);
  const h = clampNum(p.height, 0.05, 100, SHELF_DEFAULTS.height);
  const t = clampNum(p.board_thickness, 0.002, Math.min(w, h) * 0.2, Math.min(w, h) * 0.05);
  const n = Math.round(clampNum(p.shelves, 2, 50, SHELF_DEFAULTS.shelves));
  const b = new MeshBuilder();
  const bt = p.back_panel ? Math.min(0.008, d * 0.1) : 0;
  for (const sx of [-1, 1]) addBox(b, [sx > 0 ? w / 2 - t : -w / 2, -d / 2, 0], [sx > 0 ? w / 2 : -w / 2 + t, d / 2, h], { mat: 1 });
  const kick = Math.min(0.06, h * 0.1);
  const z0 = kick;
  const z1 = h - t;
  for (let k = 0; k < n; k++) {
    const z = z0 + ((z1 - z0) * k) / (n - 1);
    addBox(b, [-w / 2 + t, -d / 2, z], [w / 2 - t, d / 2 - bt, z + t], { mat: 0 });
  }
  if (kick > 0.005) addBox(b, [-w / 2 + t, -d / 2 + 0.01, 0], [w / 2 - t, -d / 2 + 0.01 + t, kick], { mat: 1 });
  if (bt > 0) addBox(b, [-w / 2 + t, d / 2 - bt, 0], [w / 2 - t, d / 2, h], { mat: 1 });
  return { mesh: b.build(), materials: [MATERIALS.wood, MATERIALS.woodDark] };
}

// ------------------------------------------------------------------ wheel

export interface WheelParams {
  /** Outer radius of the tyre in metres. */
  radius: number;
  /** Width of the tyre along the axle in metres. */
  width: number;
  /** Radius of the rim (inner edge of the tyre) in metres. */
  rim_radius: number;
  hub_radius: number;
  /** Number of spokes (0 = solid disc). */
  spokes: number;
  /** Vertices around the wheel. */
  segments: number;
}

export const WHEEL_DEFAULTS: WheelParams = {
  radius: 0.35,
  width: 0.22,
  rim_radius: 0.23,
  hub_radius: 0.06,
  spokes: 5,
  segments: 48,
};

/** Wheel with its axle along X, centred on the origin. Slots: 0 tyre (Rubber), 1 rim/hub/spokes (Metal). */
export function generateWheel(params: Partial<WheelParams> = {}): GeneratorResult {
  const p = { ...WHEEL_DEFAULTS, ...params };
  const R = clampNum(p.radius, 0.01, 100, WHEEL_DEFAULTS.radius);
  const w = clampNum(p.width, 0.005, 100, WHEEL_DEFAULTS.width);
  const rim = clampNum(p.rim_radius, R * 0.2, R * 0.97, R * 0.66);
  const hub = clampNum(p.hub_radius, rim * 0.05, rim * 0.8, rim * 0.25);
  const seg = Math.round(clampNum(p.segments, 8, 256, 48));
  const spokes = Math.round(clampNum(p.spokes, 0, 64, 5));
  const b = new MeshBuilder();
  // tyre: rounded-rectangle cross-section revolved around the axle (built around Z, rotated last)
  const cr = Math.min(0.4 * (R - rim), 0.4 * w);
  const tyre: Vec2[] = [[rim, -w / 2]];
  const corner = (cx: number, cz: number, a0: number) => {
    for (let i = 0; i <= 4; i++) {
      const a = a0 + (Math.PI / 2) * (i / 4);
      tyre.push([cx + cr * Math.cos(a), cz + cr * Math.sin(a)]);
    }
  };
  corner(R - cr, -w / 2 + cr, -Math.PI / 2);
  corner(R - cr, w / 2 - cr, 0);
  tyre.push([rim, w / 2]);
  addLathe(b, tyre, seg, { mat: 0, smooth: true, loop: true });
  // rim band, hub and spokes / disc
  const band: Vec2[] = [
    [rim * 0.86, -w * 0.4],
    [rim * 1.01, -w * 0.4],
    [rim * 1.01, w * 0.4],
    [rim * 0.86, w * 0.4],
  ];
  addLathe(b, band, seg, { mat: 1, smooth: true, loop: true });
  addLathe(
    b,
    [
      [0, -w * 0.45],
      [hub, -w * 0.45],
      [hub, w * 0.45],
      [0, w * 0.45],
    ],
    Math.max(12, seg / 2),
    { mat: 1, smooth: true },
  );
  if (spokes > 0) {
    const sw = Math.max(0.01, rim * 0.14);
    for (let k = 0; k < spokes; k++) {
      const a = (2 * Math.PI * k) / spokes + Math.PI / 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      addBoxBetween(b, [hub * 0.8 * c, hub * 0.8 * s, 0], [rim * 0.9 * c, rim * 0.9 * s, 0], sw, w * 0.25, [0, 0, 1], {
        mat: 1,
      });
    }
  } else {
    addLathe(
      b,
      [
        [hub * 0.9, -w * 0.12],
        [rim * 0.9, -w * 0.12],
        [rim * 0.9, w * 0.12],
        [hub * 0.9, w * 0.12],
      ],
      seg,
      { mat: 1, smooth: true, loop: true },
    );
  }
  // rotate: axle Z → X (x' = z, y' = y, z' = −x)
  const P = b.positions;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i];
    P[i] = P[i + 2];
    P[i + 2] = -x;
  }
  const mesh = b.build();
  markSharpEdges(mesh, 1.0);
  return { mesh, materials: [MATERIALS.rubber, MATERIALS.metal] };
}

// ------------------------------------------------------------------ barrel

export interface BarrelParams {
  height: number;
  /** Radius at the top and bottom in metres. */
  radius: number;
  /** Extra radius at mid-height as a fraction of `radius` (0 = cylinder). */
  bulge: number;
  /** Number of metal hoops. */
  hoops: number;
  /** Number of wooden staves (0 = smooth body). */
  staves: number;
}

export const BARREL_DEFAULTS: BarrelParams = { height: 1, radius: 0.3, bulge: 0.15, hoops: 4, staves: 18 };

/** Wooden barrel standing on z = 0 (axis Z). Slots: 0 staves & heads (Barrel Wood), 1 hoops (Iron). */
export function generateBarrel(params: Partial<BarrelParams> = {}): GeneratorResult {
  const p = { ...BARREL_DEFAULTS, ...params };
  const H = clampNum(p.height, 0.02, 100, BARREL_DEFAULTS.height);
  const R = clampNum(p.radius, 0.01, 100, BARREL_DEFAULTS.radius);
  const bulge = clampNum(p.bulge, 0, 1, BARREL_DEFAULTS.bulge);
  const staves = Math.round(clampNum(p.staves, 0, 128, 18));
  const hoops = Math.round(clampNum(p.hoops, 0, 20, 4));
  const rAt = (z: number) => R * (1 + bulge * Math.sin((Math.PI * z) / H));
  const wall = Math.min(R * 0.08, 0.025);
  const chime = Math.min(H * 0.03, 0.025);
  const around = staves > 0 ? staves * 3 : 48;
  // stave relief: slightly proud stave centres, grooved joints
  const relief = (j: number) => (staves > 0 ? 1 + 0.012 * (Math.sin((Math.PI * (j % 3)) / 3) - 0.6) : 1);
  const ring = (r: number, z: number, carve: boolean): Vec3[] => {
    const out: Vec3[] = [];
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around;
      const rr = carve ? r * relief(j) : r;
      out.push([rr * Math.cos(a), rr * Math.sin(a), z]);
    }
    return out;
  };
  const levels = 12;
  const profile: Vec2[] = [
    [0, chime],
    [R - wall, chime],
    [R - wall, 0],
  ];
  for (let k = 0; k <= levels; k++) profile.push([rAt((H * k) / levels), (H * k) / levels]);
  profile.push([R - wall, H], [R - wall, H - chime], [0, H - chime]);
  const rings: Vec3[][] = profile.map(([r, z], i) => {
    if (r < 1e-9) return [[0, 0, z]];
    const outer = i >= 3 && i <= 3 + levels;
    return ring(r, z, outer);
  });
  const b = new MeshBuilder();
  addRingSurface(b, rings, { mat: 0, smooth: true, flip: profileIsClockwise(profile) });
  if (hoops > 0) {
    const hh = Math.min(H * 0.045, 0.06);
    for (let k = 0; k < hoops; k++) {
      const zc = hoops === 1 ? H / 2 : H * (0.1 + (0.8 * k) / (hoops - 1));
      const z0 = Math.max(0, zc - hh / 2);
      const z1 = Math.min(H, zc + hh / 2);
      const rb = rAt(z0) * 0.995;
      const rt = rAt(z1) * 0.995;
      const tk = Math.max(0.004, R * 0.02);
      addLathe(
        b,
        [
          [rb, z0],
          [rb + tk, z0],
          [rt + tk, z1],
          [rt, z1],
        ],
        Math.max(32, around),
        { mat: 1, smooth: true, loop: true },
      );
    }
  }
  const mesh = b.build();
  markSharpEdges(mesh, 0.9);
  return { mesh, materials: [MATERIALS.barrelWood, MATERIALS.iron] };
}
