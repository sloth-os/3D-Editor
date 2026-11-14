import { z } from 'zod';
import type { Mat4, Vec2, Vec3 } from '../../math/types';
import { compose4, invert4 } from '../../math/mat4';
import type { MeshData } from '../../mesh/types';
import { MeshBuilder, addRingSurface, markSharpEdges, smoothstep } from '../../generate/builder';
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
  radialSurface,
  roundedRect,
  sphere,
  torus,
  tube,
  xf,
  type Model,
  type ModelMaterial,
} from './architecture';

/*
 * Built-in vehicles (CATALOG-B), built with the kit in architecture.ts. Vehicle contract (spec §10):
 * an EMPTY root, the `body` part, wheels `wheel.FL/FR/BL/BR` (bicycles and motorcycles `wheel.F` /
 * `wheel.B`) whose origin is the hub and which roll forward turning positively about their local X,
 * the front wheels under `steer.FL/FR` (`steer.F`) pivots that steer turning about their local Z, and
 * `saddle` empties where riders sit (they face the empty's −Y). The front faces −Y, so a vehicle's
 * own left is +X (FL = +X, −Y). Boats float with z = 0 at their waterline (the hull below it) and
 * have no wheels.
 */

const TAU = Math.PI * 2;

// ===================================================================== materials

const paint = (name: string, hex: string): ModelMaterial => material(name, hex, 0.3, { coat: 1 });
const GLASS = material('Car Glass', '#11161b', 0.05, { coat: 0.6 });
const TRIM = MAT.blackPlastic;
const CHROME = material('Trim Chrome', '#dcdfe3', 0.12, { metallic: 1 });
const ALLOY = material('Alloy Wheel', '#b9bdc3', 0.3, { metallic: 1 });
const WHEEL_DARK = material('Wheel Recess', '#26282b', 0.6);
const HEADLAMP = material('Headlamp', '#eef2f4', 0.08, { coat: 1 });
const TAIL_LAMP = material('Tail Lamp', '#a8121c', 0.22, { coat: 0.6 });
const PLATE = material('Number Plate', '#f0f0ea', 0.5);
const WHEEL_MATS = [MAT.rubber, ALLOY, WHEEL_DARK];

/** Material slots of a car body: paint, glass, trim, chrome, headlamp, tail lamp, plate. */
const S_PAINT = 0;
const S_GLASS = 1;
const S_TRIM = 2;
const S_CHROME = 3;
const S_HEAD = 4;
const S_TAIL = 5;
const S_PLATE = 6;
const carSlots = (m: Model, body: ModelMaterial): ModelMaterial[] => [
  m.main(body),
  GLASS,
  TRIM,
  CHROME,
  HEADLAMP,
  TAIL_LAMP,
  PLATE,
];

// ===================================================================== helpers

/** Smooth interpolation through (x, y) points sorted by x, without overshoot (monotone cubic); clamped. */
function smoothCurve(pts: readonly Vec2[], x: number): number {
  const n = pts.length;
  if (n === 1 || x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const slope = (k: number) => (pts[k + 1][1] - pts[k][1]) / (pts[k + 1][0] - pts[k][0]);
  const tangent = (k: number) => {
    if (k === 0) return slope(0);
    if (k === n - 1) return slope(n - 2);
    const a = slope(k - 1);
    const c = slope(k);
    return a * c <= 0 ? 0 : (2 * a * c) / (a + c);
  };
  const [x0, y0] = pts[i];
  const [x1, y1] = pts[i + 1];
  const h = x1 - x0;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * h * tangent(i) +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * h * tangent(i + 1)
  );
}

/** Adds the polygon `pts` facing `dir` (its winding set from its Newell normal). */
function facing(b: MeshBuilder, pts: readonly Vec3[], mat: number, dir: Vec3, smooth = false): void {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const ids = pts.map((p) => b.vert(p));
  b.face(nx * dir[0] + ny * dir[1] + nz * dir[2] >= 0 ? ids : ids.reverse(), mat, smooth);
}

/** The builder's mesh with edges sharper than `deg` marked sharp (smooth panels, crisp creases). */
function crisp(b: MeshBuilder, deg = 50): MeshData {
  const mesh = b.build();
  markSharpEdges(mesh, (deg * Math.PI) / 180);
  return mesh;
}

/** Root-space geometry moved into the space of a part placed by `space` (its root-space matrix). */
function inSpace(src: MeshBuilder, space: Mat4): MeshBuilder {
  const out = new MeshBuilder();
  appendMesh(out, src.build(), [], invert4(space));
  return out;
}

/** Point of `p` (root space) in the space placed by `space`. */
function toSpace(space: Mat4, p: Vec3): Vec3 {
  const m = invert4(space);
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

// ===================================================================== wheels

/** Axle along X: the canonical wheels are built about Z and turned a quarter about Y. */
const AXLE_X = xf([0, 0, 0], [0, Math.PI / 2, 0]);

/**
 * A road wheel about its own origin with the axle along X: tyre (`round` rounds its shoulders),
 * alloy rim with `spokes` spokes, the same face on both sides (so one mesh serves both sides and the
 * origin is the bounds centre). Slots: rubber, alloy, dark recess.
 */
function roadWheel(
  R: number,
  w: number,
  o: { round?: number; spokes?: number; segs?: number } = {},
): MeshData {
  const n = o.segs ?? 16;
  const ri = R * 0.64;
  const c = Math.min(w * (o.round ?? 0.25), (R - ri) * 0.6);
  const b = new MeshBuilder();
  lathe(
    b,
    [
      [ri, -w / 2],
      [R - c, -w / 2],
      [R, -w / 2 + c],
      [R, w / 2 - c],
      [R - c, w / 2],
      [ri, w / 2],
    ],
    n,
    0,
    { loop: true },
  );
  const f = new MeshBuilder();
  const dish = Math.min(0.03, w * 0.15);
  const z0 = w / 2 - dish;
  radialSurface(
    f,
    [
      [0, z0 + 0.012],
      [R * 0.1, z0 + 0.008],
      [R * 0.17, z0],
    ],
    n,
    1,
  );
  radialSurface(
    f,
    [
      [R * 0.17, z0],
      [ri - 0.012, z0 - dish],
    ],
    n,
    2,
  );
  radialSurface(
    f,
    [
      [ri - 0.012, z0 - dish],
      [ri, z0 + 0.004],
    ],
    n,
    1,
  );
  const k = o.spokes ?? 5;
  for (let i = 0; i < k; i++) {
    const a = (i / k) * TAU + Math.PI / 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    beam(
      f,
      [R * 0.15 * ca, R * 0.15 * sa, z0 + 0.002],
      [(ri - 0.016) * ca, (ri - 0.016) * sa, z0 - dish + 0.006],
      R * 0.15,
      0.016,
      1,
    );
  }
  const face = f.build();
  appendMesh(b, face);
  appendMesh(b, face, [], xf([0, 0, 0], [0, 0, 0], [1, 1, -1]));
  const out = new MeshBuilder();
  appendMesh(out, b.build(), [], AXLE_X);
  return crisp(out);
}

interface WheelSpec {
  /** Radius, tyre width, hub x (own left), front and rear axle y. */
  r: number;
  w: number;
  x: number;
  front: number;
  rear: number;
}

/** The four wheels: the front ones under steer.FL / steer.FR pivots at their hubs. */
function fourWheels(m: Model, w: WheelSpec, mesh: MeshData): void {
  const id = m.mesh('wheel', mesh);
  for (const [side, x] of [
    ['L', w.x],
    ['R', -w.x],
  ] as const) {
    const steer = m.empty(`steer.F${side}`, { location: [x, w.front, w.r], size: w.r * 0.6 });
    m.object(`wheel.F${side}`, id, WHEEL_MATS, { parent: steer });
  }
  for (const [side, x] of [
    ['L', w.x],
    ['R', -w.x],
  ] as const)
    m.object(`wheel.B${side}`, id, WHEEL_MATS, { location: [x, w.rear, w.r] });
}

// ===================================================================== car bodies

/**
 * A car body lofted along Y through rounded sections: plan corners rounded at both ends, the
 * underside rising toward the ends, wheel arches cut into the sides (the wells' inner walls inside
 * the wheels) and the top following `top` (hood, belt line, trunk, or the whole roof line).
 */
interface BodySpec {
  length: number;
  width: number;
  wheel: WheelSpec;
  /** Underside height between the wheels; side (sill) bottom height. */
  floor: number;
  sill: number;
  /** Plan corner radii at the front and the rear end. */
  corner: [number, number];
  /** Rise of the underside toward the front / rear end. */
  lift: [number, number];
  /** Top line of the body as (y, z) points from the front end to the rear end. */
  top: Vec2[];
  /** Inward lean of the sides at the top (m). */
  tumble: number;
  /** Radius of the section's top corners (default 0.12). */
  shoulder?: number;
  /** Spacing of the regular stations (default 0.3 m). */
  spacing?: number;
}

interface Section {
  y: number;
  /** Half-widths at the bottom and the top of the side. */
  wb: number;
  wt: number;
  /** Underside, side bottom (sill or arch) and top heights. */
  zc: number;
  zs: number;
  z1: number;
}

function archRadius(s: BodySpec): number {
  return s.wheel.r + 0.05;
}

function bodyStations(s: BodySpec): number[] {
  const y0 = -s.length / 2;
  const y1 = s.length / 2;
  const key: number[] = [y0, y1];
  for (let k = 1; k <= 4; k++) {
    key.push(y0 + s.corner[0] * (1 - Math.cos((k * Math.PI) / 8)));
    key.push(y1 - s.corner[1] * (1 - Math.cos((k * Math.PI) / 8)));
  }
  const ra = archRadius(s);
  for (const a of [s.wheel.front, s.wheel.rear]) {
    for (let k = -4; k <= 4; k++) key.push(a + ra * Math.sin((k * Math.PI) / 8));
    // the arch's ends step down to the sill within 3 cm
    key.push(a - ra - 0.03, a + ra + 0.03);
  }
  for (const [y] of s.top) key.push(y);
  const step = s.spacing ?? 0.3;
  const all = key.filter((y) => y >= y0 - 1e-9 && y <= y1 + 1e-9);
  const n = Math.max(2, Math.round(s.length / step));
  for (let i = 1; i < n; i++) {
    const y = y0 + (s.length * i) / n;
    if (all.every((k) => Math.abs(k - y) > step * 0.3)) all.push(y);
  }
  all.sort((a, b) => a - b);
  const out: number[] = [];
  for (const y of all) if (!out.length || y - out[out.length - 1] > 0.008) out.push(y);
  out[out.length - 1] = y1;
  return out;
}

function bodySection(s: BodySpec, y: number): Section {
  const y0 = -s.length / 2;
  const y1 = s.length / 2;
  const W = s.width / 2;
  const plan = (d: number, r: number) =>
    d >= r ? W : W - r + Math.sqrt(Math.max(0, r * r - (r - Math.max(0, d)) ** 2));
  const wb = Math.min(plan(y - y0, s.corner[0]), plan(y1 - y, s.corner[1]));
  const z1 = smoothCurve(s.top, y);
  const ra = archRadius(s);
  const overF = Math.max(0.05, s.wheel.front - ra - y0);
  const overR = Math.max(0.05, y1 - (s.wheel.rear + ra));
  const zc =
    s.floor + s.lift[0] * (1 - smoothstep(0, overF, y - y0)) + s.lift[1] * (1 - smoothstep(0, overR, y1 - y));
  let zs = Math.max(s.sill, zc + 0.02);
  for (const a of [s.wheel.front, s.wheel.rear]) {
    const dy = y - a;
    if (Math.abs(dy) <= ra) zs = Math.max(zs, s.wheel.r + Math.sqrt(ra * ra - dy * dy));
  }
  zs = Math.min(zs, z1 - 0.08);
  return { y, wb, wt: wb - s.tumble, zc: Math.min(zc, zs - 0.02), zs, z1 };
}

/** A section ring (counter-clockwise seen from −Y): the wells' inner walls, the sides and the top. */
function sectionRing(c: Section, xWell: number, shoulder: number): Vec3[] {
  const h = c.z1 - c.zs;
  const rb = Math.min(0.06, h / 4);
  const rt = Math.min(shoulder, h / 3, c.wt * 0.4);
  const xi = Math.min(xWell, c.wb - rb - 0.02);
  const pts: Vec2[] = [
    [xi, c.zc],
    [xi, c.zs],
  ];
  const arc = (cx: number, cz: number, r: number, a0: number, a1: number) => {
    for (let k = 0; k <= 2; k++) {
      const a = a0 + ((a1 - a0) * k) / 2;
      pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
  };
  arc(c.wb - rb, c.zs + rb, rb, -Math.PI / 2, 0);
  arc(c.wt - rt, c.z1 - rt, rt, 0, Math.PI / 2);
  arc(-c.wt + rt, c.z1 - rt, rt, Math.PI / 2, Math.PI);
  arc(-c.wb + rb, c.zs + rb, rb, Math.PI, 1.5 * Math.PI);
  pts.push([-xi, c.zs], [-xi, c.zc]);
  return pts.map(([x, zz]) => [x, c.y, zz]);
}

/** Lofts the body into `b` (slot `mat`); returns its sections. */
function carBody(b: MeshBuilder, s: BodySpec, mat: number): Section[] {
  const secs = bodyStations(s).map((y) => bodySection(s, y));
  const xWell = s.wheel.x - s.wheel.w / 2 - 0.05;
  addRingSurface(
    b,
    secs.map((c) => sectionRing(c, xWell, s.shoulder ?? 0.12)),
    { mat, smooth: true, flip: true, capStart: true, capEnd: true },
  );
  return secs;
}

/** The greenhouse of a car: windows from the belt line to the roof, narrower at the roof. */
interface CabinSpec {
  belt: number;
  roof: number;
  /** Windscreen foot and top y; rear window foot and top y. */
  front: [number, number];
  rear: [number, number];
  /** Half-widths at the belt and at the roof. */
  half: [number, number];
  /** Plan corner radius. */
  round: number;
}

/** Fraction of the cabin height where the glass ends and the roof begins. */
const glassTop = (c: CabinSpec) => 1 - 0.04 / (c.roof - c.belt);

function cabinFrame(c: CabinSpec, t: number, inset = 0) {
  const tt = Math.max(0, Math.min(1, t));
  const yf = c.front[0] + (c.front[1] - c.front[0]) * tt + inset;
  const yr = c.rear[0] + (c.rear[1] - c.rear[0]) * tt - inset;
  const w = c.half[0] + (c.half[1] - c.half[0]) * tt - inset;
  const rc = Math.min(c.round, w * 0.45, (yr - yf) * 0.3);
  return { yf, yr, w, rc, z: c.belt + (c.roof - c.belt) * t };
}

function cabinRing(c: CabinSpec, t: number, z: number, inset = 0): Vec3[] {
  const f = cabinFrame(c, t, inset);
  return roundedRect(2 * f.w, f.yr - f.yf, f.rc, 2, 0, (f.yf + f.yr) / 2).map(([x, y]): Vec3 => [x, y, z]);
}

/** Glass from below the belt (buried in the body) to the roof's edge, then the roof (slot `roofMat`). */
function cabin(b: MeshBuilder, c: CabinSpec, glassMat: number, roofMat: number): void {
  const tg = glassTop(c);
  const zg = c.belt + (c.roof - c.belt) * tg;
  addRingSurface(b, [cabinRing(c, 0, c.belt - 0.08), cabinRing(c, 0, c.belt), cabinRing(c, tg, zg)], {
    mat: glassMat,
    smooth: true,
  });
  addRingSurface(b, [cabinRing(c, tg, zg), cabinRing(c, 1, c.roof, 0.05)], {
    mat: roofMat,
    smooth: true,
    capEnd: true,
  });
}

/** Corner pillars through the cabin's plan corners and side pillars at `ys`. */
function pillars(b: MeshBuilder, c: CabinSpec, ys: number[], mat: number): void {
  const tg = glassTop(c);
  const corner = (t: number, front: boolean, s: number): Vec3 => {
    const f = cabinFrame(c, t);
    const d = Math.SQRT1_2 * f.rc;
    return front
      ? [s * (f.w - f.rc + d), f.yf + f.rc - d, f.z]
      : [s * (f.w - f.rc + d), f.yr - f.rc + d, f.z];
  };
  const push = (p: Vec3, n: Vec3, k: number): Vec3 => [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k];
  for (const s of [-1, 1])
    for (const front of [true, false]) {
      const n: Vec3 = [s * Math.SQRT1_2, (front ? -1 : 1) * Math.SQRT1_2, 0];
      beam(b, push(corner(0, front, s), n, 0.01), push(corner(tg, front, s), n, 0.01), 0.075, 0.03, mat, n);
    }
  const f0 = cabinFrame(c, 0);
  const f1 = cabinFrame(c, tg);
  for (const y of ys)
    for (const s of [-1, 1])
      beam(b, [s * (f0.w + 0.01), y, f0.z], [s * (f1.w + 0.01), y, f1.z], 0.08, 0.03, mat, [s, 0, 0]);
}

/** Lamps, grille, bumper lips, plates and mirrors of a car (positions from the body's ends). */
interface CarTrim {
  /** Headlight: x (mirrored), distance behind the front end, z, radii. */
  head: [number, number, number, Vec3];
  /** Tail light: x (mirrored), distance ahead of the rear end, z, radii. */
  tail: [number, number, number, Vec3];
  /** Grille: half width, bottom and top z. */
  grille: [number, number, number];
  /** Bottom z of the front and the rear plate. */
  plates: [number, number];
  /** Mirror: outer x, y, z. */
  mirror: [number, number, number];
}

function carTrim(b: MeshBuilder, s: BodySpec, t: CarTrim): void {
  const y0 = -s.length / 2;
  const y1 = s.length / 2;
  const zcF = s.floor + s.lift[0];
  const zcR = s.floor + s.lift[1];
  const [hx, hy, hz, hr] = t.head;
  const [tx, ty, tz, tr] = t.tail;
  for (const k of [-1, 1]) {
    sphere(b, [k * hx, y0 + hy, hz], hr, 1, S_HEAD);
    sphere(b, [k * tx, y1 - ty, tz], tr, 1, S_TAIL);
  }
  const [gw, g0, g1] = t.grille;
  box(b, [-gw, y0 - 0.012, g0], [gw, y0 + 0.12, g1], S_TRIM);
  const lipF = s.width / 2 - s.corner[0] * 0.6;
  const lipR = s.width / 2 - s.corner[1] * 0.6;
  box(b, [-lipF, y0 - 0.016, zcF], [lipF, y0 + 0.3, zcF + 0.06], S_TRIM);
  box(b, [-lipR, y1 - 0.3, zcR], [lipR, y1 + 0.016, zcR + 0.07], S_TRIM);
  box(b, [-0.26, y0 - 0.03, t.plates[0]], [0.26, y0 + 0.02, t.plates[0] + 0.11], S_PLATE);
  box(b, [-0.26, y1 - 0.02, t.plates[1]], [0.26, y1 + 0.03, t.plates[1] + 0.11], S_PLATE);
  const [mx, my, mz] = t.mirror;
  for (const k of [-1, 1]) {
    block(b, [k * (mx - 0.07), my, mz], [0.14, 0.07, 0.1], S_PAINT);
    beam(
      b,
      [k * (mx - 0.16), my + 0.02, mz - 0.03],
      [k * (mx - 0.06), my + 0.02, mz - 0.02],
      0.03,
      0.02,
      S_TRIM,
    );
  }
}

interface CarDesign {
  body: BodySpec;
  cabin: CabinSpec;
  /** Side pillars' y (B, C …). */
  pillars: number[];
  trim: CarTrim;
}

/** Body, greenhouse, pillars, trim and wheels of a car; `extra` adds model-specific parts to the body. */
function buildCar(m: Model, d: CarDesign, bodyPaint: ModelMaterial, extra?: (b: MeshBuilder) => void): void {
  const b = new MeshBuilder();
  carBody(b, d.body, S_PAINT);
  cabin(b, d.cabin, S_GLASS, S_PAINT);
  pillars(b, d.cabin, d.pillars, S_PAINT);
  carTrim(b, d.body, d.trim);
  extra?.(b);
  m.part('body', crisp(b), carSlots(m, bodyPaint));
  fourWheels(m, d.body.wheel, roadWheel(d.body.wheel.r, d.body.wheel.w));
}

// ===================================================================== cars

const SEDAN: CarDesign = {
  body: {
    length: 4.7,
    width: 1.82,
    wheel: { r: 0.325, w: 0.215, x: 0.79, front: -1.42, rear: 1.4 },
    floor: 0.16,
    sill: 0.25,
    corner: [0.42, 0.32],
    lift: [0.12, 0.1],
    tumble: 0.035,
    top: [
      [-2.35, 0.56],
      [-2.31, 0.66],
      [-2.22, 0.73],
      [-2.0, 0.78],
      [-1.6, 0.815],
      [-1.25, 0.85],
      [-1.0, 0.885],
      [0.2, 0.9],
      [1.3, 0.935],
      [1.55, 0.965],
      [2.1, 0.975],
      [2.27, 0.94],
      [2.33, 0.87],
      [2.35, 0.76],
    ],
  },
  cabin: {
    belt: 0.885,
    roof: 1.44,
    front: [-1.0, -0.28],
    rear: [1.3, 0.8],
    half: [0.8, 0.69],
    round: 0.2,
  },
  pillars: [0.25],
  trim: {
    head: [0.6, 0.11, 0.665, [0.21, 0.1, 0.05]],
    tail: [0.62, 0.06, 0.86, [0.2, 0.07, 0.055]],
    grille: [0.34, 0.46, 0.6],
    plates: [0.35, 0.5],
    mirror: [0.95, -0.86, 0.96],
  },
};

const sedan = defineModel({
  id: 'sedan',
  name: 'Sedan',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['car', 'sedan', 'vehicle', 'automobile', 'road', 'street', 'traffic', 'four door'],
  synonyms: ['car', 'saloon', 'saloon car', 'automobile', 'family car', 'motor car', 'four-door car', 'auto'],
  description:
    'Four-door sedan car (4.7 m long) in deep blue: body, wheels `wheel.FL/FR/BL/BR` (origin at the hub, rolling forward about local X) with the front wheels under `steer.FL/FR` pivots (steer about local Z). Colour sets the paint.',
  dimensions_m: [1.9, 4.76, 1.44],
  triangles: 4018,
  build(m) {
    buildCar(m, SEDAN, paint('Sedan Paint', '#1e3a6e'));
  },
});

const HATCHBACK: CarDesign = {
  body: {
    length: 4.1,
    width: 1.76,
    wheel: { r: 0.31, w: 0.2, x: 0.76, front: -1.27, rear: 1.3 },
    floor: 0.15,
    sill: 0.24,
    corner: [0.4, 0.26],
    lift: [0.1, 0.09],
    tumble: 0.035,
    top: [
      [-2.05, 0.56],
      [-2.01, 0.66],
      [-1.93, 0.72],
      [-1.75, 0.765],
      [-1.4, 0.8],
      [-1.0, 0.85],
      [-0.8, 0.88],
      [0.4, 0.9],
      [1.4, 0.93],
      [1.85, 0.95],
      [1.98, 0.93],
      [2.03, 0.86],
      [2.05, 0.74],
    ],
  },
  cabin: {
    belt: 0.88,
    roof: 1.47,
    front: [-0.8, -0.08],
    rear: [1.93, 1.56],
    half: [0.78, 0.68],
    round: 0.18,
  },
  pillars: [0.38],
  trim: {
    head: [0.58, 0.1, 0.67, [0.19, 0.1, 0.05]],
    tail: [0.62, 0.08, 0.98, [0.12, 0.06, 0.1]],
    grille: [0.32, 0.46, 0.6],
    plates: [0.35, 0.52],
    mirror: [0.95, -0.66, 0.96],
  },
};

const hatchback = defineModel({
  id: 'hatchback',
  name: 'Hatchback',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['car', 'hatchback', 'vehicle', 'automobile', 'small car', 'compact', 'road', 'street', 'traffic'],
  synonyms: ['hatch', 'compact car', 'small car', 'city car', 'five-door car', 'supermini', 'car'],
  description:
    'Compact five-door hatchback car (4.1 m) in red with a steep rear hatch and roof spoiler; vehicle contract parts (body, wheel.FL/FR/BL/BR, steer.FL/FR).',
  dimensions_m: [1.9, 4.16, 1.501],
  triangles: 3902,
  build(m) {
    buildCar(m, HATCHBACK, paint('Hatchback Paint', '#c43c2e'), (b) => {
      // roof spoiler over the hatch
      beam(b, [-0.58, 1.56, 1.46], [0.58, 1.56, 1.46], 0.2, 0.035, S_PAINT, [0, 0.25, 1]);
    });
  },
});

const SUV_DESIGN: CarDesign = {
  body: {
    length: 4.7,
    width: 1.9,
    wheel: { r: 0.37, w: 0.24, x: 0.81, front: -1.42, rear: 1.42 },
    floor: 0.24,
    sill: 0.38,
    corner: [0.4, 0.24],
    lift: [0.12, 0.08],
    tumble: 0.03,
    top: [
      [-2.35, 0.8],
      [-2.31, 0.88],
      [-2.22, 0.94],
      [-2.0, 0.99],
      [-1.6, 1.02],
      [-1.1, 1.06],
      [-0.92, 1.08],
      [1.0, 1.1],
      [2.15, 1.12],
      [2.28, 1.11],
      [2.33, 1.04],
      [2.35, 0.95],
    ],
  },
  cabin: {
    belt: 1.08,
    roof: 1.72,
    front: [-0.92, -0.28],
    rear: [2.25, 2.12],
    half: [0.87, 0.77],
    round: 0.2,
  },
  pillars: [0.3, 1.32],
  trim: {
    head: [0.62, 0.11, 0.86, [0.2, 0.1, 0.06]],
    tail: [0.7, 0.07, 1.0, [0.14, 0.06, 0.12]],
    grille: [0.42, 0.6, 0.8],
    plates: [0.46, 0.62],
    mirror: [1.06, -0.78, 1.16],
  },
};

const suv = defineModel({
  id: 'suv',
  name: 'SUV',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['car', 'suv', 'vehicle', 'automobile', 'four by four', '4x4', 'off road', 'road', 'traffic'],
  synonyms: ['sport utility vehicle', 'four-by-four', '4x4', 'jeep', 'crossover', 'off-roader', 'car'],
  description:
    'Sport utility vehicle (4.7 m) in slate grey: tall body, big wheels, near-vertical tailgate and roof rails; vehicle contract parts (body, wheel.FL/FR/BL/BR, steer.FL/FR).',
  dimensions_m: [2.12, 4.76, 1.77],
  triangles: 4010,
  build(m) {
    buildCar(m, SUV_DESIGN, paint('SUV Paint', '#5c6670'), (b) => {
      for (const s of [-1, 1]) {
        beam(b, [s * 0.6, -0.12, 1.755], [s * 0.6, 1.98, 1.755], 0.045, 0.03, S_TRIM);
        for (const y of [-0.08, 0.9, 1.94]) block(b, [s * 0.6, y, 1.73], [0.05, 0.08, 0.05], S_TRIM);
      }
    });
  },
});

const PICKUP: CarDesign = {
  body: {
    length: 5.35,
    width: 1.98,
    wheel: { r: 0.39, w: 0.26, x: 0.84, front: -1.72, rear: 1.72 },
    floor: 0.27,
    sill: 0.43,
    corner: [0.36, 0.08],
    lift: [0.12, 0.05],
    tumble: 0.02,
    top: [
      [-2.675, 0.98],
      [-2.64, 1.05],
      [-2.56, 1.1],
      [-2.35, 1.14],
      [-1.9, 1.17],
      [-1.4, 1.2],
      [-1.1, 1.22],
      [0.5, 1.26],
      [0.56, 0.98],
      [2.675, 0.98],
    ],
  },
  cabin: { belt: 1.22, roof: 1.86, front: [-1.1, -0.48], rear: [0.5, 0.46], half: [0.93, 0.83], round: 0.16 },
  pillars: [-0.3],
  trim: {
    head: [0.76, 0.06, 0.86, [0.15, 0.08, 0.07]],
    tail: [0.95, 0.04, 1.14, [0.05, 0.04, 0.13]],
    grille: [0.58, 0.62, 0.92],
    plates: [0.43, 0.9],
    mirror: [1.1, -0.98, 1.36],
  },
};

const pickupTruck = defineModel({
  id: 'pickup_truck',
  name: 'Pickup Truck',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['pickup', 'truck', 'vehicle', 'car', 'farm', 'utility', 'road', 'traffic'],
  synonyms: ['pickup', 'pick-up', 'ute', 'light truck', 'pickup truck', 'truck', 'utility vehicle'],
  description:
    'Crew-cab pickup truck (5.35 m) in dark green with an open cargo bed, tailgate and chrome bumpers; vehicle contract parts (body, wheel.FL/FR/BL/BR, steer.FL/FR).',
  dimensions_m: [2.2, 5.48, 1.86],
  triangles: 4054,
  build(m) {
    buildCar(m, PICKUP, paint('Pickup Paint', '#2e4a36'), (b) => {
      const y1 = PICKUP.body.length / 2;
      for (const s of [-1, 1]) {
        // bed walls with rail caps
        box(b, [s * 0.86, 0.56, 0.84], [s * 0.975, 2.62, 1.33], S_PAINT);
        box(b, [s * 0.85, 0.55, 1.33], [s * 0.985, 2.63, 1.36], S_TRIM);
      }
      box(b, [-0.975, 0.5, 0.9], [0.975, 0.6, 1.33], S_PAINT);
      box(b, [-0.975, 2.58, 0.86], [0.975, y1, 1.33], S_PAINT);
      box(b, [-0.12, y1, 1.2], [0.12, y1 + 0.01, 1.25], S_TRIM);
      box(b, [-0.86, 0.6, 0.975], [0.86, 2.58, 0.99], S_TRIM);
      // cab back panel below the rear window
      box(b, [-0.86, 0.45, 1.2], [0.86, 0.54, 1.5], S_PAINT);
      // chrome bumpers
      box(b, [-0.98, -y1 - 0.05, 0.4], [0.98, -y1 + 0.25, 0.6], S_CHROME);
      box(b, [-0.95, y1 - 0.1, 0.42], [0.95, y1 + 0.08, 0.58], S_CHROME);
    });
  },
});

// ===================================================================== van and bus (one loft each)

/** Glass panel on a side (x = ±`x`) from the (y, z) outline, 1 cm proud. */
function sideGlass(b: MeshBuilder, x: number, outline: Vec2[], mat: number): void {
  for (const s of [-1, 1])
    extrude(b, outline, 'x', s > 0 ? x - 0.004 : -x - 0.008, s > 0 ? x + 0.008 : -x + 0.004, mat);
}

const rect = (y0: number, y1: number, z0: number, z1: number): Vec2[] => [
  [y0, z0],
  [y1, z0],
  [y1, z1],
  [y0, z1],
];

/** y where the (rising) body top reaches `z` between y `lo` and `hi` (bisection). */
function yAtTop(top: Vec2[], z: number, lo: number, hi: number): number {
  let a = lo;
  let c = hi;
  for (let i = 0; i < 40; i++) {
    const mid = (a + c) / 2;
    if (smoothCurve(top, mid) < z) a = mid;
    else c = mid;
  }
  return (a + c) / 2;
}

const VAN_BODY: BodySpec = {
  length: 5.0,
  width: 1.98,
  wheel: { r: 0.345, w: 0.215, x: 0.84, front: -1.6, rear: 1.72 },
  floor: 0.2,
  sill: 0.31,
  corner: [0.36, 0.12],
  lift: [0.12, 0.06],
  tumble: 0,
  shoulder: 0.16,
  top: [
    [-2.5, 0.86],
    [-2.47, 0.94],
    [-2.4, 0.99],
    [-2.2, 1.03],
    [-1.95, 1.06],
    [-1.86, 1.08],
    [-1.75, 1.24],
    [-1.31, 1.88],
    [-1.18, 2.03],
    [-1.0, 2.09],
    [2.4, 2.09],
    [2.47, 2.05],
    [2.5, 1.98],
  ],
};

const van = defineModel({
  id: 'van',
  name: 'Van',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['van', 'vehicle', 'delivery', 'minibus', 'transporter', 'road', 'traffic', 'work'],
  synonyms: ['delivery van', 'panel van', 'minibus', 'transit van', 'camper', 'people carrier', 'minivan'],
  description:
    'High-roof van (5 m) in white with a sliding-door window band and rear doors; vehicle contract parts (body, wheel.FL/FR/BL/BR, steer.FL/FR).',
  dimensions_m: [2.2, 5.085, 2.09],
  triangles: 3872,
  build(m) {
    const s = VAN_BODY;
    const y0 = -s.length / 2;
    const y1 = s.length / 2;
    const W = s.width / 2;
    const b = new MeshBuilder();
    carBody(b, s, S_PAINT);
    // windscreen on the slope, 6 mm proud
    const ya = -1.73;
    const yb = -1.33;
    const pa: Vec3 = [0, ya, smoothCurve(s.top, ya)];
    const pb: Vec3 = [0, yb, smoothCurve(s.top, yb)];
    const len = Math.hypot(pb[1] - pa[1], pb[2] - pa[2]);
    const n: Vec3 = [0, -(pb[2] - pa[2]) / len, (pb[1] - pa[1]) / len];
    beam(
      b,
      [0, pa[1] + n[1] * 0.006, pa[2] + n[2] * 0.006],
      [0, pb[1] + n[1] * 0.006, pb[2] + n[2] * 0.006],
      2 * (W - 0.17),
      0.01,
      S_GLASS,
      n,
    );
    // side windows: the front door's follows the windscreen pillar
    const zLow = 1.25;
    const zHigh = 1.86;
    const front = (z: number) => yAtTop(s.top, z + 0.1, -1.86, -1.0) + 0.14;
    sideGlass(
      b,
      W,
      [
        [front(zLow), zLow],
        [-0.98, zLow],
        [-0.98, zHigh],
        [front(zHigh), zHigh],
      ],
      S_GLASS,
    );
    sideGlass(b, W, rect(-0.82, 0.46, zLow, zHigh), S_GLASS);
    sideGlass(b, W, rect(0.6, 2.25, zLow, zHigh), S_GLASS);
    // rear doors: windows, the split and the handle
    for (const k of [-1, 1]) box(b, [k * 0.06, y1 - 0.004, 1.3], [k * 0.8, y1 + 0.01, 1.9], S_GLASS);
    box(b, [-0.006, y1 - 0.004, 0.42], [0.006, y1 + 0.012, 1.98], S_TRIM);
    // front: grille, lamps, bumper, plate
    box(b, [-0.55, y0 - 0.012, 0.58], [0.55, y0 + 0.1, 0.8], S_TRIM);
    for (const k of [-1, 1]) {
      sphere(b, [k * 0.72, y0 + 0.07, 0.74], [0.16, 0.09, 0.075], 1, S_HEAD);
      box(b, [k * 0.86, y1 - 0.05, 0.75], [k * 0.97, y1 + 0.012, 1.3], S_TAIL);
      block(b, [k * (W + 0.07), -1.45, 1.45], [0.08, 0.06, 0.24], S_TRIM);
      beam(b, [k * (W - 0.02), -1.45, 1.36], [k * (W + 0.05), -1.45, 1.38], 0.03, 0.02, S_TRIM);
    }
    const zcF = s.floor + s.lift[0];
    const zcR = s.floor + s.lift[1];
    box(b, [-0.95, y0 - 0.03, zcF], [0.95, y0 + 0.3, 0.52], S_TRIM);
    box(b, [-0.97, y1 - 0.2, zcR], [0.97, y1 + 0.04, 0.5], S_TRIM);
    box(b, [-0.26, y0 - 0.045, 0.37], [0.26, y0 - 0.028, 0.48], S_PLATE);
    box(b, [-0.26, y1 + 0.006, 0.62], [0.26, y1 + 0.022, 0.73], S_PLATE);
    m.part('body', crisp(b), carSlots(m, paint('Van Paint', '#f0f0ec')));
    fourWheels(m, s.wheel, roadWheel(s.wheel.r, s.wheel.w));
  },
});

const BUS_BODY: BodySpec = {
  length: 11.2,
  width: 2.5,
  wheel: { r: 0.5, w: 0.3, x: 1.0, front: -3.3, rear: 2.6 },
  floor: 0.3,
  sill: 0.36,
  corner: [0.15, 0.2],
  lift: [0.05, 0.12],
  tumble: 0,
  shoulder: 0.28,
  spacing: 0.5,
  top: [
    [-5.6, 2.88],
    [-5.57, 2.97],
    [-5.5, 3.03],
    [-5.3, 3.05],
    [5.3, 3.05],
    [5.5, 3.03],
    [5.57, 2.97],
    [5.6, 2.88],
  ],
};

const DESTINATION = material('Destination Sign', '#ffb21f', 0.4, { emission: 2.5 });

const bus = defineModel({
  id: 'bus',
  name: 'City Bus',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['bus', 'vehicle', 'public transport', 'city', 'street', 'road', 'traffic', 'coach'],
  synonyms: ['city bus', 'transit bus', 'omnibus', 'coach', 'school bus', 'autobus', 'public bus'],
  description:
    'Single-deck city bus (11.2 m) in yellow with a window band, two doors on its right (−X) side, a lit destination sign and a roof unit; vehicle contract parts (body, wheel.FL/FR/BL/BR, steer.FL/FR).',
  dimensions_m: [2.526, 11.31, 3.2],
  triangles: 4696,
  build(m) {
    const s = BUS_BODY;
    const y0 = -s.length / 2;
    const y1 = s.length / 2;
    const W = s.width / 2;
    const b = new MeshBuilder();
    carBody(b, s, S_PAINT);
    // windows along both sides, doors on the right (−X): front door and middle door
    const doors: [number, number][] = [
      [-5.32, -4.3],
      [-0.4, 0.85],
    ];
    for (const side of [1, -1]) {
      const sx = side > 0 ? [W - 0.004, W + 0.01] : [-W - 0.01, -W + 0.004];
      for (let y = -4.15; y < 5.0; y += 1.13) {
        const ya = y;
        const yb = Math.min(y + 1.03, 5.05);
        if (side < 0 && doors.some(([d0, d1]) => yb > d0 - 0.05 && ya < d1 + 0.05)) continue;
        box(b, [sx[0], ya, 1.32], [sx[1], yb, 2.58], S_GLASS);
      }
      if (side > 0) box(b, [sx[0], -5.3, 1.32], [sx[1], -4.3, 2.58], S_GLASS);
    }
    for (const [d0, d1] of doors) {
      box(b, [-W - 0.006, d0 - 0.03, 0.42], [-W + 0.004, d1 + 0.03, 2.64], S_TRIM);
      box(b, [-W - 0.012, d0, 0.48], [-W - 0.004, d1, 2.58], S_GLASS);
      box(b, [-W - 0.016, (d0 + d1) / 2 - 0.015, 0.48], [-W - 0.008, (d0 + d1) / 2 + 0.015, 2.58], S_TRIM);
    }
    // front: windscreen, destination sign, lamps, bumper; rear: window, lamps, bumper, engine grille
    box(b, [-1.06, y0 - 0.012, 1.08], [1.06, y0 + 0.004, 2.62], S_GLASS);
    box(b, [-0.86, y0 - 0.014, 2.68], [0.86, y0 + 0.004, 2.93], S_TRIM);
    box(b, [-0.72, y0 - 0.02, 2.73], [0.72, y0 - 0.012, 2.88], 7);
    const zcF = s.floor + s.lift[0];
    const zcR = s.floor + s.lift[1];
    for (const k of [-1, 1]) {
      box(b, [k * 0.82, y0 - 0.014, 0.56], [k * 1.08, y0 + 0.004, 0.7], S_HEAD);
      box(b, [k * 0.92, y1 - 0.004, 0.72], [k * 1.14, y1 + 0.014, 1.32], S_TAIL);
    }
    box(b, [-1.2, y0 - 0.04, zcF], [1.2, y0 + 0.2, 0.5], S_TRIM);
    box(b, [-1.2, y1 - 0.2, zcR], [1.2, y1 + 0.04, 0.56], S_TRIM);
    box(b, [-0.86, y1 - 0.004, 2.08], [0.86, y1 + 0.012, 2.7], S_GLASS);
    box(b, [-0.75, y1 - 0.004, 0.75], [0.75, y1 + 0.01, 1.3], S_TRIM);
    box(b, [-0.26, y0 - 0.055, 0.32], [0.26, y0 - 0.04, 0.43], S_PLATE);
    box(b, [-0.26, y1 + 0.04, 0.6], [0.26, y1 + 0.055, 0.71], S_PLATE);
    // roof unit
    block(b, [0, 0.4, 3.1], [1.6, 2.6, 0.2], S_CHROME);
    m.part('body', crisp(b), [...carSlots(m, paint('Bus Paint', '#e8a91c')), DESTINATION]);
    fourWheels(m, s.wheel, roadWheel(s.wheel.r, s.wheel.w, { segs: 20 }));
  },
});

// ===================================================================== two wheels

/**
 * A bicycle-style wheel about its origin (axle along X): tyre, rim, hub and `spokes` wire spokes
 * from alternating flanges; `cassette` adds sprockets on the −X side (inside the hub's width).
 * Slots: rubber, alloy, spokes (chrome).
 */
function spokedWheel(R: number, o: { tyre?: number; spokes?: number; cassette?: boolean } = {}): MeshData {
  const tr = o.tyre ?? 0.018;
  const b = new MeshBuilder();
  torus(b, R - tr, tr, 28, 6, 0);
  const rr = R - 2 * tr;
  lathe(
    b,
    [
      [rr - 0.022, -0.009],
      [rr + 0.002, -0.012],
      [rr + 0.002, 0.012],
      [rr - 0.022, 0.009],
    ],
    28,
    1,
    { loop: true },
  );
  cylinder(b, [0, 0, -0.05], [0, 0, 0.05], 0.016, 8, 1);
  for (const zf of [-0.035, 0.035]) cylinder(b, [0, 0, zf - 0.003], [0, 0, zf + 0.003], 0.03, 8, 1);
  if (o.cassette) cylinder(b, [0, 0, -0.046], [0, 0, -0.022], 0.045, 12, 2, { smooth: false });
  const k = o.spokes ?? 20;
  for (let i = 0; i < k; i++) {
    const a = (i / k) * TAU;
    const side = i % 2 ? 1 : -1;
    const h = a + side * 0.25;
    beam(
      b,
      [0.028 * Math.cos(h), 0.028 * Math.sin(h), side * 0.035],
      [(rr - 0.02) * Math.cos(a), (rr - 0.02) * Math.sin(a), 0],
      0.004,
      0.004,
      2,
    );
  }
  const out = new MeshBuilder();
  appendMesh(out, b.build(), [], AXLE_X);
  return out.build();
}

/**
 * A cambered sail between `tack`, `clew` (the foot) and `head`, bulging toward +X by `camber` of each
 * chord: two surfaces 6 mm apart (so it shows from both sides).
 */
function sail(b: MeshBuilder, tack: Vec3, clew: Vec3, head: Vec3, camber: number, mat: number): void {
  const nu = 5;
  const nv = 7;
  const lerp = (p: Vec3, q: Vec3, t: number): Vec3 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
  ];
  for (const side of [1, -1]) {
    const ids: number[][] = [];
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const luff = lerp(tack, head, v);
      const leech = lerp(clew, head, v);
      const chord = Math.hypot(leech[1] - luff[1], leech[2] - luff[2]);
      const row: number[] = [];
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const p = lerp(luff, leech, u);
        row.push(b.vert([p[0] + camber * chord * 4 * u * (1 - u) + side * 0.003, p[1], p[2]]));
      }
      ids.push(row);
    }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const f = [ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]];
        b.face(side > 0 ? f : f.reverse(), mat, true);
      }
  }
}

/** The tilted frame of a steering axis through `centre` (rake: its top leans back by `rake`). */
function headFrame(centre: Vec3, rake: number): { rotation: Vec3; matrix: Mat4 } {
  const rotation: Vec3 = [-rake, 0, 0];
  return { rotation, matrix: compose4(centre, rotation, [1, 1, 1]) };
}

/** Points along a bicycle chain looped round a front ring and a rear sprocket (x fixed). */
function chainLoop(front: Vec3, rf: number, rear: Vec3, rb: number, x: number): Vec3[] {
  const pts: Vec3[] = [];
  const at = (c: Vec3, r: number, a: number): Vec3 => [x, c[1] + r * Math.cos(a), c[2] + r * Math.sin(a)];
  // the ring's front half (top → front → bottom), then the sprocket's back half (bottom → back → top)
  for (let k = 0; k <= 8; k++) pts.push(at(front, rf, Math.PI / 2 + (k * Math.PI) / 8));
  for (let k = 0; k <= 6; k++) pts.push(at(rear, rb, -Math.PI / 2 + (k * Math.PI) / 6));
  return pts;
}

const bicycle = defineModel({
  id: 'bicycle',
  name: 'Bicycle',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['bicycle', 'bike', 'cycle', 'vehicle', 'cycling', 'road', 'street', 'sport', 'pedal'],
  synonyms: ['bike', 'push bike', 'cycle', 'pedal bike', 'road bike', 'city bike', 'pushbike'],
  description:
    'Diamond-frame bicycle (1.75 m long) in teal: body (frame, chain, saddle), wheel.F (under the steer.F pivot, which turns about the tilted head tube with the fork and handlebar) and wheel.B rolling about local X, a crank part turning about X at the bottom bracket, and a saddle empty on the seat.',
  dimensions_m: [0.606, 1.73, 1.013],
  triangles: 2620,
  build(m) {
    const HB: Vec3 = [0, 0.45, 0.34];
    const HF: Vec3 = [0, -0.6, 0.34];
    const BB: Vec3 = [0, 0.03, 0.28];
    const ST: Vec3 = [0, 0.18, 0.8];
    const HT1: Vec3 = [0, -0.4, 0.92];
    const HT0: Vec3 = [0, -0.44, 0.78];
    const r = 0.016;
    const b = new MeshBuilder();
    tube(b, [BB, ST], r, 8, 0);
    tube(b, [ST, [0, -0.392, 0.895]], r * 0.9, 8, 0);
    tube(b, [BB, [0, -0.435, 0.8]], r * 1.15, 8, 0);
    tube(b, [HT0, HT1], 0.02, 10, 0);
    for (const s of [-1, 1]) {
      tube(
        b,
        [
          [s * 0.02, 0.05, 0.28],
          [s * 0.06, HB[1], HB[2]],
        ],
        0.009,
        6,
        0,
      );
      tube(
        b,
        [
          [s * 0.02, ST[1] - 0.005, ST[2] - 0.03],
          [s * 0.06, HB[1], HB[2]],
        ],
        0.008,
        6,
        0,
      );
    }
    // seat post and saddle
    const post: Vec3 = [0, ST[1] + 0.04, ST[2] + 0.135];
    tube(b, [ST, post], 0.012, 8, 1);
    const saddleOutline: Vec2[] = [
      [0.075, 0.07],
      [0.06, 0.1],
      [0, 0.11],
      [-0.06, 0.1],
      [-0.075, 0.07],
      [-0.06, 0.02],
      [-0.025, -0.06],
      [-0.02, -0.15],
      [0.02, -0.15],
      [0.025, -0.06],
      [0.06, 0.02],
    ];
    extrude(b, saddleOutline, 'z', post[2], post[2] + 0.045, 2, {
      matrix: xf([0, post[1] + 0.02, 0]),
    });
    // chain on the drive side (−X)
    tube(b, chainLoop(BB, 0.1, HB, 0.042, -0.055), 0.005, 5, 3, { cyclic: true });
    m.part('body', b, [
      m.main(paint('Bicycle Paint', '#1f7a75')),
      MAT.metal,
      MAT.blackPlastic,
      MAT.darkMetal,
    ]);

    // steering: the head tube's tilted frame, the steer pivot, fork + bar and the front wheel
    const rake = Math.atan2(HT1[1] - HT0[1], HT1[2] - HT0[2]);
    const centre: Vec3 = [0, (HT0[1] + HT1[1]) / 2, (HT0[2] + HT1[2]) / 2];
    const head = headFrame(centre, rake);
    const headId = m.empty('head_tube', { location: centre, rotation: head.rotation, size: 0.1 });
    const steer = m.empty('steer.F', { parent: headId, size: 0.15 });
    const f = new MeshBuilder();
    for (const s of [-1, 1])
      tube(
        f,
        [
          [s * 0.045, -0.447, 0.765],
          [s * 0.05, HF[1], HF[2]],
        ],
        0.011,
        8,
        0,
      );
    beam(f, [-0.06, -0.445, 0.77], [0.06, -0.445, 0.77], 0.04, 0.03, 0);
    tube(f, [HT1, [0, -0.398, 0.965], [0, -0.47, 0.975]], 0.013, 8, 1);
    tube(
      f,
      [
        [-0.28, -0.44, 0.995],
        [-0.12, -0.47, 0.975],
        [0.12, -0.47, 0.975],
        [0.28, -0.44, 0.995],
      ],
      0.011,
      8,
      1,
    );
    for (const s of [-1, 1]) cylinder(f, [s * 0.2, -0.454, 0.986], [s * 0.3, -0.437, 0.997], 0.016, 8, 2);
    m.part(
      'fork',
      inSpace(f, head.matrix),
      [m.main(paint('Bicycle Paint', '#1f7a75')), MAT.metal, MAT.blackPlastic],
      {
        parent: steer,
      },
    );
    const wheelMats = [MAT.rubber, ALLOY, CHROME];
    m.part('wheel.F', spokedWheel(0.34), wheelMats, { parent: steer, location: toSpace(head.matrix, HF) });
    m.part('wheel.B', spokedWheel(0.34, { cassette: true }), [...wheelMats, MAT.darkMetal], { location: HB });

    // crank (turns about X at the bottom bracket): arms, pedals, chainring
    const c = new MeshBuilder();
    cylinder(c, [-0.075, 0, 0], [0.075, 0, 0], 0.014, 8, 1);
    cylinder(c, [-0.058, 0, 0], [-0.052, 0, 0], 0.1, 20, 2, { smooth: false });
    for (const s of [-1, 1]) {
      const y = -s * 0.17;
      beam(c, [s * 0.075, 0, 0], [s * 0.075, y, 0], 0.03, 0.014, 1);
      block(c, [s * 0.13, y, 0], [0.09, 0.06, 0.022], 3);
    }
    m.part('crank', c, [MAT.metal, ALLOY, MAT.darkMetal, MAT.blackPlastic], { location: BB });
    m.empty('saddle', { location: [0, post[1] + 0.02, post[2] + 0.045], size: 0.15 });
  },
});

const motorcycle = defineModel({
  id: 'motorcycle',
  name: 'Motorcycle',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['motorcycle', 'motorbike', 'bike', 'vehicle', 'road', 'street', 'traffic', 'rider'],
  synonyms: ['motorbike', 'motor bike', 'motorcycle', 'bike', 'scooter', 'moped', 'roadster'],
  description:
    'Naked roadster motorcycle (2.1 m) in red with an air-cooled engine and chrome exhaust: body, wheel.F under the steer.F pivot (turning about the raked steering axis with the fork, headlight and handlebar) and wheel.B rolling about local X, saddle and saddle.2 (pillion) empties.',
  dimensions_m: [0.85, 2.076, 1.305],
  triangles: 2548,
  build(m) {
    const R = 0.32;
    const HF: Vec3 = [0, -0.72, R];
    const HB: Vec3 = [0, 0.7, R];
    const rake = (25 * Math.PI) / 180;
    const a: Vec3 = [0, Math.sin(rake), Math.cos(rake)];
    const fwd: Vec3 = [0, -Math.cos(rake), Math.sin(rake)];
    // the steering axis runs 3 cm behind the fork tubes
    const axisAt = (z: number): Vec3 => {
      const p: Vec3 = [0, HF[1] - 0.03 * fwd[1], HF[2] - 0.03 * fwd[2]];
      const t = (z - p[2]) / a[2];
      return [0, p[1] + a[1] * t, z];
    };
    const along = (t: number, x = 0): Vec3 => [x, HF[1] + a[1] * t, HF[2] + a[2] * t];
    const b = new MeshBuilder();
    const P = 0;
    const DARK = 1;
    const METAL = 2;
    const LEATHER = 3;
    const CHR = 4;
    const RED = 5;
    const WHITE = 6;
    // tank, seat, side cover, tail with lamp and plate
    sphere(b, [0, -0.13, 0.93], [0.17, 0.27, 0.12], 2, P);
    sphere(b, [0, 0.33, 0.86], [0.14, 0.3, 0.055], 2, LEATHER);
    block(b, [0, 0.25, 0.74], [0.24, 0.3, 0.16], DARK);
    extrude(
      b,
      [
        [0.5, 0.8],
        [0.9, 0.9],
        [0.98, 0.94],
        [0.98, 0.88],
        [0.62, 0.76],
      ],
      'x',
      -0.09,
      0.09,
      P,
    );
    block(b, [0, 0.985, 0.9], [0.1, 0.03, 0.05], RED);
    beam(b, [0, 0.9, 0.86], [0, 1.0, 0.72], 0.04, 0.015, DARK);
    block(b, [0, 1.005, 0.66], [0.2, 0.01, 0.13], WHITE);
    // engine: crankcase, finned cylinders
    block(b, [0, 0.02, 0.5], [0.32, 0.4, 0.3], METAL);
    cylinder(b, [-0.19, 0.08, 0.42], [0.19, 0.08, 0.42], 0.13, 14, METAL);
    block(b, [0, -0.12, 0.73], [0.28, 0.17, 0.2], METAL);
    for (const zf of [0.66, 0.71, 0.76, 0.81]) block(b, [0, -0.12, zf], [0.34, 0.2, 0.012], METAL);
    // frame: twin spars, cradle, subframe, swingarm and shocks
    for (const s of [-1, 1]) {
      tube(
        b,
        [
          [s * 0.06, -0.4, 0.93],
          [s * 0.13, -0.18, 0.84],
          [s * 0.13, 0.1, 0.7],
          [s * 0.1, 0.2, 0.48],
        ],
        0.022,
        8,
        DARK,
      );
      tube(
        b,
        [
          [s * 0.1, 0.12, 0.72],
          [s * 0.1, 0.62, 0.82],
        ],
        0.016,
        6,
        DARK,
      );
      beam(b, [s * 0.11, 0.2, 0.45], [s * 0.11, HB[1], HB[2]], 0.04, 0.07, DARK);
      cylinder(b, [s * 0.11, 0.52, 0.39], [s * 0.11, 0.43, 0.78], 0.026, 8, CHR);
      cylinder(b, [s * 0.12, 0.18, 0.36], [s * 0.24, 0.18, 0.36], 0.013, 6, METAL);
    }
    tube(
      b,
      [
        [0, -0.44, 0.84],
        [0, -0.35, 0.5],
        [0, -0.18, 0.27],
        [0, 0.15, 0.26],
        [0, 0.22, 0.42],
      ],
      0.022,
      8,
      DARK,
    );
    // exhaust on the right (−X)
    tube(
      b,
      [
        [-0.08, -0.2, 0.66],
        [-0.13, -0.3, 0.42],
        [-0.16, -0.12, 0.27],
        [-0.17, 0.2, 0.31],
        [-0.18, 0.42, 0.42],
      ],
      0.025,
      8,
      CHR,
    );
    cylinder(b, [-0.18, 0.4, 0.41], [-0.19, 0.86, 0.56], 0.058, 12, CHR, { r1: 0.045 });
    tube(b, [axisAt(0.8), axisAt(1.0)], 0.035, 10, DARK);
    m.part('body', crisp(b), [
      m.main(paint('Motorcycle Paint', '#a3201c')),
      MAT.darkMetal,
      material('Engine Alloy', '#8e9399', 0.4, { metallic: 1 }),
      material('Seat Leather', '#1d1a18', 0.6),
      CHROME,
      TAIL_LAMP,
      PLATE,
    ]);

    // steering head frame, steer pivot, fork assembly and front wheel
    const centre = axisAt(0.9);
    const head = headFrame(centre, rake);
    const headId = m.empty('head_tube', { location: centre, rotation: head.rotation, size: 0.1 });
    const steer = m.empty('steer.F', { parent: headId, size: 0.2 });
    const f = new MeshBuilder();
    for (const s of [-1, 1]) {
      cylinder(f, along(0, s * 0.09), along(0.35, s * 0.09), 0.032, 10, 1);
      cylinder(f, along(0.35, s * 0.09), along(0.74, s * 0.09), 0.023, 10, 3);
    }
    for (const t of [0.62, 0.71]) beam(f, along(t, -0.13), along(t, 0.13), 0.08, 0.03, 1, a);
    const top = along(0.74);
    tube(f, [top, [0, top[1] + 0.04, top[2] + 0.07]], 0.02, 8, 1);
    tube(
      f,
      [
        [-0.38, -0.26, 1.06],
        [-0.2, -0.32, 1.08],
        [0.2, -0.32, 1.08],
        [0.38, -0.26, 1.06],
      ],
      0.012,
      8,
      3,
    );
    for (const s of [-1, 1]) {
      cylinder(f, [s * 0.3, -0.28, 1.065], [s * 0.42, -0.25, 1.06], 0.02, 8, 2);
      tube(
        f,
        [
          [s * 0.24, -0.31, 1.08],
          [s * 0.32, -0.27, 1.24],
        ],
        0.007,
        6,
        3,
      );
      cylinder(f, [s * 0.32, -0.255, 1.25], [s * 0.32, -0.275, 1.25], 0.055, 12, 2);
    }
    // headlight
    cylinder(f, [0, -0.47, 0.93], [0, -0.58, 0.93], 0.09, 14, 3);
    cylinder(f, [0, -0.58, 0.93], [0, -0.59, 0.93], 0.08, 14, 4);
    // front fender over the wheel
    const fender: Vec3[] = [];
    for (let k = 0; k <= 6; k++) {
      const ang = (25 + (k * 130) / 6) * (Math.PI / 180);
      fender.push([0, HF[1] - Math.cos(ang) * (R + 0.045), HF[2] + Math.sin(ang) * (R + 0.045)]);
    }
    for (let k = 0; k < 6; k++) {
      const mid: Vec3 = [
        0,
        (fender[k][1] + fender[k + 1][1]) / 2 - HF[1],
        (fender[k][2] + fender[k + 1][2]) / 2 - HF[2],
      ];
      beam(f, fender[k], fender[k + 1], 0.13, 0.012, 0, mid);
    }
    m.part(
      'fork',
      inSpace(f, head.matrix),
      [m.main(paint('Motorcycle Paint', '#a3201c')), MAT.darkMetal, MAT.blackPlastic, CHROME, HEADLAMP],
      { parent: steer },
    );
    const wheel = roadWheel(R, 0.15, { round: 0.45, spokes: 5 });
    const wid = m.mesh('wheel', wheel);
    m.object('wheel.F', wid, WHEEL_MATS, { parent: steer, location: toSpace(head.matrix, HF) });
    m.object('wheel.B', wid, WHEEL_MATS, { location: HB });
    m.empty('saddle', { location: [0, 0.3, 0.915], size: 0.15 });
    m.empty('saddle.2', { location: [0, 0.56, 0.915], size: 0.15 });
  },
});

// ===================================================================== boats

/** A hull: sections of half-beam B, sheer (gunwale) height and keel height along t (0 bow … 1 stern). */
interface HullSpec {
  length: number;
  stations: number;
  /** Points per section (even). */
  points: number;
  beam: Vec2[];
  sheer: Vec2[];
  keel: Vec2[];
  /** Section exponent along the hull (1: V, larger: rounder and flatter bottom). */
  shape: Vec2[];
}

const hullT = (h: HullSpec, i: number) => 0.5 - 0.5 * Math.cos((Math.PI * i) / h.stations);

/** A hull section at t (y given separately): `inset` thins the beam and raises the keel. */
function hullSection(h: HullSpec, t: number, y: number, inset = 0): Vec3[] {
  const B = Math.max(0, smoothCurve(h.beam, t) - inset);
  const zg = smoothCurve(h.sheer, t);
  const zk = smoothCurve(h.keel, t) + inset;
  const e = smoothCurve(h.shape, t);
  const out: Vec3[] = [];
  for (let j = 0; j <= h.points; j++) {
    const u = 1 - (2 * j) / h.points;
    out.push([B * u, y, zk + (zg - zk) * Math.abs(u) ** e]);
  }
  return out;
}

/** Inner half-width of the hull at height z (inside the skin `inset` thick) and t. */
function hullHalfWidth(h: HullSpec, t: number, z: number, inset: number): number {
  const B = smoothCurve(h.beam, t) - inset;
  const zg = smoothCurve(h.sheer, t);
  const zk = smoothCurve(h.keel, t) + inset;
  const e = smoothCurve(h.shape, t);
  const u = Math.max(0, Math.min(1, (z - zk) / Math.max(1e-6, zg - zk))) ** (1 / e);
  return B * u;
}

/** Faces of a hull grid (stations × points), facing out (or in); `slot(z)` picks each face's material. */
function hullSkin(b: MeshBuilder, g: Vec3[][], slot: (z: number) => number, outward: boolean): void {
  const ids = g.map((row) => row.map((p) => b.vert(p)));
  for (let i = 0; i + 1 < g.length; i++)
    for (let j = 0; j + 1 < g[i].length; j++) {
      const f = [ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]];
      const zc = (g[i][j][2] + g[i][j + 1][2] + g[i + 1][j + 1][2] + g[i + 1][j][2]) / 4;
      b.face(outward ? f : f.reverse(), slot(zc), true);
    }
}

const ROWBOAT_HULL: HullSpec = {
  length: 3.0,
  stations: 16,
  points: 12,
  beam: [
    [0, 0.03],
    [0.08, 0.24],
    [0.2, 0.43],
    [0.36, 0.56],
    [0.55, 0.615],
    [0.75, 0.6],
    [0.9, 0.54],
    [1, 0.48],
  ],
  sheer: [
    [0, 0.52],
    [0.25, 0.41],
    [0.55, 0.36],
    [0.85, 0.38],
    [1, 0.41],
  ],
  keel: [
    [0, 0.12],
    [0.12, -0.06],
    [0.3, -0.115],
    [0.6, -0.12],
    [0.85, -0.1],
    [1, -0.05],
  ],
  shape: [
    [0, 1.3],
    [0.35, 2.2],
    [1, 2.6],
  ],
};

/** An oar along +X from its pivot (the oarlock): handle inboard, loom, blade outboard. */
function oarMesh(): MeshBuilder {
  const o = new MeshBuilder();
  cylinder(o, [-0.65, 0, 0], [-0.5, 0, 0], 0.017, 8, 0);
  cylinder(o, [-0.5, 0, 0], [1.2, 0, 0], 0.022, 8, 0, { r1: 0.018 });
  extrude(
    o,
    [
      [1.18, -0.025],
      [1.4, -0.07],
      [1.66, -0.07],
      [1.68, 0],
      [1.66, 0.07],
      [1.4, 0.07],
      [1.18, 0.025],
    ],
    'z',
    -0.007,
    0.007,
    0,
  );
  cylinder(o, [-0.04, 0, 0], [0.04, 0, 0], 0.026, 8, 1);
  return o;
}

const rowboat = defineModel({
  id: 'rowboat',
  name: 'Rowboat',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['rowboat', 'boat', 'dinghy', 'rowing', 'lake', 'water', 'oars', 'fishing', 'vehicle'],
  synonyms: [
    'rowing boat',
    'dinghy',
    'skiff',
    'row boat',
    'small boat',
    'tender',
    'punt',
    'boat',
    'canoe',
    'kayak',
  ],
  description:
    'Wooden rowboat (3 m) with a painted hull, three thwarts and two oars; z = 0 is its waterline (the keel 12 cm below). Parts: body, oar.L / oar.R (origin at the oarlock, swing about Z; oars "shipped" along the gunwales or "out" over the water), saddle (rowing seat, the rower facing aft, +Y) and saddle.2 (stern seat facing forward).',
  dimensions_m: [1.331, 3, 0.644],
  triangles: 1189,
  params: z.object({
    oars: z
      .enum(['shipped', 'out'])
      .default('shipped')
      .describe('Oars lying along the gunwales (shipped) or out over the water ready to row'),
  }),
  build(m, p) {
    const h = ROWBOAT_HULL;
    const L = h.length;
    const th = 0.022;
    const PAINT = 0;
    const WOOD = 1;
    const RIM = 2;
    const METAL = 3;
    const b = new MeshBuilder();
    const yAt = (t: number) => -L / 2 + L * t;
    const outer: Vec3[][] = [];
    for (let i = 0; i <= h.stations; i++) outer.push(hullSection(h, hullT(h, i), yAt(hullT(h, i))));
    hullSkin(b, outer, () => PAINT, true);
    // the inside from just behind the bow (under the foredeck) to just inside the transom
    const first = 2;
    const inner: Vec3[][] = [];
    for (let i = first; i <= h.stations; i++) {
      const t = hullT(h, i);
      inner.push(hullSection(h, t, i === h.stations ? L / 2 - th : yAt(t), th));
    }
    hullSkin(b, inner, () => WOOD, false);
    // gunwale rims, transom, foredeck and the bulkhead under it
    const n = h.points;
    const deckTo = 3;
    for (let i = first; i < h.stations; i++) {
      const k = i - first;
      if (i >= deckTo)
        for (const j of [0, n])
          facing(b, [outer[i][j], outer[i + 1][j], inner[k + 1][j], inner[k][j]], RIM, [0, 0, 1]);
    }
    facing(b, outer[h.stations], PAINT, [0, 1, 0]);
    facing(b, inner[inner.length - 1], WOOD, [0, -1, 0]);
    const last = h.stations;
    facing(
      b,
      [outer[last][0], outer[last][n], inner[inner.length - 1][n], inner[inner.length - 1][0]],
      RIM,
      [0, 0, 1],
    );
    const deck: Vec3[] = [];
    for (let i = 0; i <= deckTo; i++) deck.push(outer[i][0]);
    for (let i = deckTo; i >= 0; i--) deck.push(outer[i][n]);
    facing(
      b,
      deck.map((q): Vec3 => [q[0], q[1], q[2] + 0.004]),
      WOOD,
      [0, 0, 1],
    );
    facing(b, inner[deckTo - first], WOOD, [0, 1, 0]);
    // thwarts (bow, rowing, stern), floorboards and oarlocks
    const plank = (y: number, z: number, depth: number) => {
      const t = (y + L / 2) / L;
      const w = hullHalfWidth(h, t, z, th) + 0.005;
      box(b, [-w, y - depth / 2, z - 0.028], [w, y + depth / 2, z], WOOD);
    };
    plank(-0.85, 0.22, 0.2);
    plank(-0.12, 0.2, 0.24);
    plank(1.05, 0.21, 0.42);
    box(b, [-0.2, -0.95, -0.085], [0.2, 1.15, -0.07], WOOD);
    const lockY = 0.24;
    const lockT = (lockY + L / 2) / L;
    const lockX = smoothCurve(h.beam, lockT);
    const lockZ = smoothCurve(h.sheer, lockT);
    for (const s of [-1, 1]) {
      cylinder(b, [s * lockX, lockY, lockZ - 0.02], [s * lockX, lockY, lockZ + 0.06], 0.012, 6, METAL);
      tube(
        b,
        [
          [s * lockX, lockY - 0.04, lockZ + 0.1],
          [s * lockX, lockY - 0.035, lockZ + 0.06],
          [s * lockX, lockY + 0.035, lockZ + 0.06],
          [s * lockX, lockY + 0.04, lockZ + 0.1],
        ],
        0.006,
        5,
        METAL,
      );
    }
    m.part('body', crisp(b, 60), [
      m.main(material('Rowboat Paint', '#2f6690', 0.45, { coat: 0.4 })),
      MAT.woodLight,
      MAT.woodDark,
      MAT.metal,
    ]);
    // oars: pivots at the oarlocks; shipped along the gunwales (blades forward) or out over the water
    const oar = m.mesh('oar', oarMesh());
    const oarMats = [MAT.woodLight, MAT.darkMetal];
    for (const [name, s] of [
      ['oar.L', 1],
      ['oar.R', -1],
    ] as const) {
      const rotation: Vec3 =
        p.oars === 'out'
          ? [0, 0.24, s > 0 ? 0 : Math.PI]
          : [0, 0, s > 0 ? -93 * (Math.PI / 180) : -87 * (Math.PI / 180)];
      m.object(name, oar, oarMats, { location: [s * lockX, lockY, lockZ + 0.075], rotation });
    }
    m.empty('saddle', { location: [0, -0.12, 0.2], rotation: [0, 0, Math.PI], size: 0.15 });
    m.empty('saddle.2', { location: [0, 1.05, 0.21], size: 0.15 });
  },
});

const SAILBOAT_HULL: HullSpec = {
  length: 5.6,
  stations: 20,
  points: 14,
  beam: [
    [0, 0.04],
    [0.08, 0.38],
    [0.2, 0.7],
    [0.38, 0.95],
    [0.6, 1.04],
    [0.8, 1.0],
    [0.92, 0.94],
    [1, 0.88],
  ],
  sheer: [
    [0, 0.8],
    [0.3, 0.62],
    [0.6, 0.54],
    [0.85, 0.54],
    [1, 0.57],
  ],
  keel: [
    [0, 0.32],
    [0.1, -0.04],
    [0.3, -0.24],
    [0.6, -0.3],
    [0.85, -0.18],
    [1, 0.02],
  ],
  shape: [
    [0, 1.2],
    [0.4, 2.0],
    [1, 2.8],
  ],
};

const SAILCLOTH = material('Sailcloth', '#f4f1e8', 0.8, { sheen: 0.2 });

const sailboat = defineModel({
  id: 'sailboat',
  name: 'Sailboat',
  category: 'vehicles',
  rig: 'vehicle',
  tags: ['sailboat', 'boat', 'yacht', 'sail', 'sailing', 'sea', 'lake', 'water', 'vehicle', 'harbour'],
  synonyms: ['sailing boat', 'yacht', 'sloop', 'keelboat', 'dinghy', 'sail boat', 'daysailer', 'boat'],
  description:
    'Small sloop-rigged keelboat (5.6 m hull, 7.3 m mast above the water) in navy with white sails; z = 0 is its waterline (fin keel to 1.25 m below). Parts: body (hull, deck, coachroof, mast, rigging), boom (pivot on the mast, swings about Z) with the mainsail under it, jib, rudder (pivot at the transom, turns about Z, with its tiller), saddle (helm, facing forward) and saddle.2 (crew).',
  dimensions_m: [2.078, 5.93, 8.55],
  triangles: 1411,
  build(m) {
    const h = SAILBOAT_HULL;
    const L = h.length;
    const TOP = 0;
    const BOTTOM = 1;
    const BOOT = 2;
    const DECK = 3;
    const TEAK = 4;
    const ALU = 5;
    const WIN = 6;
    const WIRE = 7;
    const LEAD = 8;
    const b = new MeshBuilder();
    const yAt = (t: number) => -L / 2 + L * t;
    const g: Vec3[][] = [];
    for (let i = 0; i <= h.stations; i++) g.push(hullSection(h, hullT(h, i), yAt(hullT(h, i))));
    hullSkin(b, g, (zc) => (zc < -0.01 ? BOTTOM : zc < 0.06 ? BOOT : TOP), true);
    facing(b, g[h.stations], TOP, [0, 1, 0]);
    // cambered deck: gunwale → raised centreline → gunwale
    const n = h.points;
    const crown = (i: number): Vec3 => {
      const q = g[i][0];
      return [0, q[1], q[2] + 0.05 * Math.min(1, Math.abs(q[0]) / 0.5)];
    };
    for (let i = 0; i < h.stations; i++)
      for (const j of [0, n])
        facing(b, [g[i][j], g[i + 1][j], crown(i + 1), crown(i)], DECK, [0, 0, 1], true);
    const deckZ = (y: number) => smoothCurve(h.sheer, (y + L / 2) / L);
    // cockpit: teak sole and coaming
    const cy0 = 0.75;
    const cy1 = 2.45;
    const cz = deckZ(1.6) + 0.04;
    box(b, [-0.55, cy0, cz - 0.03], [0.55, cy1, cz + 0.005], TEAK);
    for (const s of [-1, 1]) box(b, [s * 0.58, cy0, cz - 0.04], [s * 0.62, cy1, cz + 0.14], DECK);
    box(b, [-0.62, cy0 - 0.04, cz - 0.04], [0.62, cy0, cz + 0.16], DECK);
    // coachroof with windows
    const roof: CabinSpec = {
      belt: deckZ(-0.5) + 0.04,
      roof: deckZ(-0.5) + 0.4,
      front: [-1.55, -1.35],
      rear: [0.72, 0.68],
      half: [0.64, 0.54],
      round: 0.3,
    };
    cabin(b, roof, DECK, DECK);
    for (const s of [-1, 1])
      for (const [y0, y1] of [
        [-1.0, -0.45],
        [-0.3, 0.3],
      ])
        beam(b, [s * 0.605, y0, roof.belt + 0.2], [s * 0.605, y1, roof.belt + 0.2], 0.1, 0.03, WIN, [
          s,
          0,
          0.2,
        ]);
    // mast, spreaders, rigging, keel
    const mastY = -0.75;
    const mastTop = 7.3;
    cylinder(b, [0, mastY, roof.roof - 0.02], [0, mastY, mastTop], 0.05, 10, ALU);
    beam(b, [-0.46, mastY, 4.3], [0.46, mastY, 4.3], 0.03, 0.02, ALU);
    const bow: Vec3 = [0, -L / 2 + 0.06, deckZ(-L / 2 + 0.06) + 0.02];
    tube(b, [bow, [0, mastY - 0.04, 6.4]], 0.006, 4, WIRE);
    tube(
      b,
      [
        [0, mastY + 0.04, mastTop - 0.05],
        [0, L / 2 - 0.05, deckZ(L / 2) + 0.03],
      ],
      0.006,
      4,
      WIRE,
    );
    for (const s of [-1, 1])
      tube(
        b,
        [
          [s * 0.03, mastY, 6.9],
          [s * 0.46, mastY, 4.3],
          [s * 0.97, -0.55, deckZ(-0.55) + 0.02],
        ],
        0.006,
        4,
        WIRE,
      );
    extrude(
      b,
      [
        [-0.45, -0.05],
        [0.4, -0.05],
        [0.2, -1.1],
        [-0.25, -1.1],
      ],
      'x',
      -0.04,
      0.04,
      LEAD,
    );
    sphere(b, [0, 0.0, -1.13], [0.12, 0.5, 0.12], 2, LEAD);
    m.part('body', crisp(b, 55), [
      m.main(material('Hull Paint', '#1d3557', 0.3, { coat: 1 })),
      material('Antifouling', '#6e2a24', 0.7),
      material('Boot Stripe', '#f2f2ee', 0.35, { coat: 0.6 }),
      material('Deck White', '#e9e5d8', 0.6),
      material('Teak', '#8b5a2b', 0.7),
      MAT.metal,
      GLASS,
      MAT.darkMetal,
      material('Keel Lead', '#4a4d52', 0.5, { metallic: 0.6 }),
    ]);
    // boom with the mainsail: both turn about the mast (Z) at the gooseneck
    const goose: Vec3 = [0, mastY, roof.roof + 0.45];
    const boom = new MeshBuilder();
    cylinder(boom, [0, 0.05, 0], [0, 3.05, 0], 0.045, 10, 0);
    const boomId = m.part('boom', boom, [MAT.metal], { location: goose });
    const main = new MeshBuilder();
    sail(main, [0, 0.07, 0.06], [0, 2.95, 0.08], [0, 0.07, mastTop - 0.2 - goose[2]], 0.07, 0);
    m.part('mainsail', main, [SAILCLOTH], { parent: boomId });
    const jib = new MeshBuilder();
    sail(
      jib,
      [0, bow[1] + 0.12, bow[2] + 0.1],
      [0, mastY - 0.15, roof.roof + 0.55],
      [0, mastY - 0.12, 6.2],
      0.08,
      0,
    );
    m.part('jib', jib, [SAILCLOTH]);
    // rudder with tiller, pivoting at the transom
    const pivot: Vec3 = [0, L / 2 + 0.03, 0.36];
    const r = new MeshBuilder();
    extrude(
      r,
      [
        [0, 0.05],
        [0.3, 0.05],
        [0.28, -1.15],
        [0.06, -1.2],
        [0, -1.0],
      ],
      'x',
      -0.025,
      0.025,
      0,
    );
    tube(
      r,
      [
        [0, 0.05, 0.1],
        [0, -0.5, 0.2],
        [0, -1.1, 0.22],
      ],
      0.022,
      8,
      1,
    );
    m.part('rudder', r, [material('Rudder White', '#e9e5d8', 0.5), material('Teak', '#8b5a2b', 0.7)], {
      location: pivot,
    });
    m.empty('saddle', { location: [0.5, 1.7, cz + 0.12], size: 0.15 });
    m.empty('saddle.2', { location: [-0.5, 1.25, cz + 0.12], size: 0.15 });
  },
});

export const VEHICLE_MODELS: CatalogEntry[] = [
  sedan,
  hatchback,
  suv,
  pickupTruck,
  van,
  bus,
  bicycle,
  motorcycle,
  rowboat,
  sailboat,
];
