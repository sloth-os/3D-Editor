import type { Mat4, Vec2, Vec3 } from '../math/types';
import {
  MeshBuilder,
  addBox,
  addBoxBetween,
  addLathe,
  addPrism,
  addRingSurface,
  addTube,
  clampNum,
  markSharpEdges,
  profileIsClockwise,
} from './builder';
import { MATERIALS, type GeneratorResult } from './types';

/*
 * Architectural elements: classical column, arch, stairs (straight or spiral) and fence.
 */

// Prism helper frame: outline (u, v) in the world YZ plane, extruded along world X.
const YZ_EXTRUDE_X: Mat4 = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1];
// Outline (u, v) in the world XZ plane, extruded along world −Y (right handed).
const XZ_EXTRUDE_NEG_Y: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

function quadBezier(a: Vec2, c: Vec2, b: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = 1 - t;
    out.push([s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]]);
  }
  return out;
}

// ------------------------------------------------------------------ column

export interface ColumnParams {
  /** Total height in metres (base + shaft + capital). */
  height: number;
  /** Radius of the shaft at its foot in metres (the shaft tapers to ~86% at the top). */
  radius: number;
  /** Number of vertical flutes (0 = smooth shaft). */
  flutes: number;
  /** Add a square plinth and a torus moulding at the foot. */
  base: boolean;
  /** Add a capital (astragal ring, echinus and square abacus) on top. */
  capital: boolean;
  /** Vertices around a smooth shaft (fluted shafts use 6 per flute). */
  segments: number;
}

export const COLUMN_DEFAULTS: ColumnParams = {
  height: 3,
  radius: 0.25,
  flutes: 16,
  base: true,
  capital: true,
  segments: 32,
};

/** Classical (Doric-like) column standing on z = 0, axis = Z. Slots: 0 shaft, 1 base & capital. */
export function generateColumn(params: Partial<ColumnParams> = {}): GeneratorResult {
  const p = { ...COLUMN_DEFAULTS, ...params };
  const H = clampNum(p.height, 0.01, 1e4, COLUMN_DEFAULTS.height);
  let r = clampNum(p.radius, 1e-3, 1e3, COLUMN_DEFAULTS.radius);
  const flutes = Math.round(clampNum(p.flutes, 0, 64, 0));
  // base 0.65·r tall, capital 0.65·r tall: shrink the radius for very short columns
  const ornament = (p.base ? 0.65 : 0) + (p.capital ? 0.65 : 0);
  if (ornament * r > H * 0.6) r = (H * 0.6) / ornament;
  const b = new MeshBuilder();
  const zs0 = p.base ? 0.65 * r : 0;
  const zs1 = H - (p.capital ? 0.65 * r : 0);
  const shaftR = (z: number) => {
    const u = clampNum((z - zs0) / Math.max(1e-9, zs1 - zs0), 0, 1);
    return r * (1 - 0.14 * u + 0.03 * Math.sin(Math.PI * u));
  };
  // shaft: rings with flute grooves (6 vertices per flute, rounded groove profile)
  const around = flutes > 0 ? flutes * 6 : Math.round(clampNum(p.segments, 8, 256, 32));
  const groove = (j: number) => (flutes > 0 ? 1 - 0.08 * Math.sin((Math.PI * (j % 6)) / 6) : 1);
  const levels = 12;
  const rings: Vec3[][] = [];
  const v: number[] = [];
  for (let k = 0; k <= levels; k++) {
    const z = zs0 + ((zs1 - zs0) * k) / levels;
    const rz = shaftR(z);
    const ring: Vec3[] = [];
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around;
      const rr = rz * groove(j);
      ring.push([rr * Math.cos(a), rr * Math.sin(a), z]);
    }
    rings.push(ring);
    v.push(z / (2 * Math.PI * r));
  }
  addRingSurface(b, rings, { mat: 0, smooth: true, capStart: true, capEnd: true, v });
  const seg = Math.max(24, Math.min(96, around));
  if (p.base) {
    addBox(b, [-1.3 * r, -1.3 * r, 0], [1.3 * r, 1.3 * r, 0.35 * r], { mat: 1 });
    const za = 0.35 * r;
    const torus: Vec2[] = [[0, za]];
    for (let i = 0; i <= 8; i++) {
      const t = -Math.PI / 2 + (Math.PI * i) / 8;
      torus.push([1.12 * r + 0.15 * r * Math.cos(t), za + 0.15 * r + 0.15 * r * Math.sin(t)]);
    }
    torus.push([1.0 * r, za + 0.3 * r], [0, za + 0.3 * r]);
    addLathe(b, torus, seg, { mat: 1, smooth: true });
  }
  if (p.capital) {
    const rt = shaftR(zs1);
    // astragal: small ring around the top of the shaft
    const ring: Vec2[] = [];
    for (let i = 0; i < 8; i++) {
      const t = (2 * Math.PI * i) / 8;
      ring.push([rt + 0.02 * r + 0.05 * r * Math.cos(t), zs1 - 0.12 * r + 0.05 * r * Math.sin(t)]);
    }
    addLathe(b, ring, seg, { mat: 1, smooth: true, loop: true });
    // echinus: flaring cushion, then the square abacus slab
    const ech = quadBezier([rt, zs1], [1.32 * r, zs1 + 0.04 * r], [1.28 * r, zs1 + 0.35 * r], 6);
    addLathe(b, [[0, zs1], ...ech, [0, zs1 + 0.35 * r]], seg, { mat: 1, smooth: true });
    addBox(b, [-1.35 * r, -1.35 * r, zs1 + 0.35 * r], [1.35 * r, 1.35 * r, H], { mat: 1 });
  }
  const mesh = b.build();
  markSharpEdges(mesh, 0.75);
  return { mesh, materials: [MATERIALS.marble, MATERIALS.marbleTrim] };
}

// ------------------------------------------------------------------ arch

export type ArchStyle = 'ROUND' | 'POINTED';

export interface ArchParams {
  /** Clear width of the opening in metres. */
  width: number;
  /** Total height in metres. */
  height: number;
  /** Depth of the arch (along Y) in metres. */
  thickness: number;
  /** Width of each pier beside the opening in metres. */
  pier_width: number;
  /** Masonry above the top of the opening in metres. */
  crown: number;
  /** ROUND: semicircular (segmental if too low); POINTED: gothic two-centred arch. */
  style: ArchStyle;
  /** Vertices along the curve of the opening. */
  segments: number;
}

export const ARCH_DEFAULTS: ArchParams = {
  width: 2,
  height: 3,
  thickness: 0.5,
  pier_width: 0.5,
  crown: 0.4,
  style: 'ROUND',
  segments: 24,
};

/** Circle through three points (2D). Null when collinear. */
function circle3(a: Vec2, b: Vec2, c: Vec2): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) };
}

/** Points of a circular arc from `from` to `to` (counter-clockwise when `ccw`) around a centre. */
function arcPoints(cx: number, cy: number, from: Vec2, to: Vec2, n: number, ccw: boolean): Vec2[] {
  const r = Math.hypot(from[0] - cx, from[1] - cy);
  const a0 = Math.atan2(from[1] - cy, from[0] - cx);
  let a1 = Math.atan2(to[1] - cy, to[0] - cx);
  if (ccw && a1 < a0) a1 += 2 * Math.PI;
  if (!ccw && a1 > a0) a1 -= 2 * Math.PI;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  out[0] = [from[0], from[1]];
  out[n] = [to[0], to[1]];
  return out;
}

/** Free-standing arch on z = 0, opening centred on the origin, front facing −Y. Slot 0: stone. */
export function generateArch(params: Partial<ArchParams> = {}): GeneratorResult {
  const p = { ...ARCH_DEFAULTS, ...params };
  const w = clampNum(p.width, 0.01, 1e4, ARCH_DEFAULTS.width);
  const H = clampNum(p.height, 0.02, 1e4, ARCH_DEFAULTS.height);
  const depth = clampNum(p.thickness, 1e-3, 1e4, ARCH_DEFAULTS.thickness);
  const pier = clampNum(p.pier_width, 1e-3, 1e4, ARCH_DEFAULTS.pier_width);
  const crown = clampNum(p.crown, 1e-3, H * 0.9, Math.min(ARCH_DEFAULTS.crown, H * 0.3));
  const n = Math.round(clampNum(p.segments, 4, 256, 24));
  const zo = H - crown; // top of the opening
  const hw = w / 2;
  let curve: Vec2[];
  let zs: number; // springing height
  if (p.style === 'POINTED' && zo > hw) {
    // two-centred arch: equilateral (R = w) when tall enough, flatter otherwise
    const hEq = (Math.sqrt(3) / 2) * w;
    const h = Math.min(hEq, zo);
    const R = Math.max(hw, (h * h + hw * hw) / w);
    zs = zo - h;
    const half = Math.max(2, Math.round(n / 2));
    const left = arcPoints(-hw + R, zs, [-hw, zs], [0, zo], half, false);
    const right = arcPoints(hw - R, zs, [0, zo], [hw, zs], half, false);
    curve = [...left, ...right.slice(1)];
  } else {
    zs = Math.max(0, zo - hw);
    const c = circle3([-hw, zs], [0, zo], [hw, zs]);
    curve = c ? arcPoints(c.cx, c.cy, [-hw, zs], [hw, zs], n, false) : [[-hw, zs], [hw, zs]];
  }
  const xo = hw + pier;
  const outline: Vec2[] = [[-xo, 0], [-hw, 0], ...curve, [hw, 0], [xo, 0], [xo, H], [-xo, H]];
  const arcStart = 2; // outline index of the first curve point
  const arcEnd = arcStart + curve.length - 1;
  const b = new MeshBuilder();
  addPrism(b, outline, -depth / 2, depth / 2, {
    mat: 0,
    matrix: XZ_EXTRUDE_NEG_Y,
    smoothEdge: (i) => i >= arcStart && i < arcEnd,
  });
  const mesh = b.build();
  markSharpEdges(mesh, 0.5);
  return { mesh, materials: [MATERIALS.stone] };
}

// ------------------------------------------------------------------ stairs

export type StairsStyle = 'STRAIGHT' | 'SPIRAL';

export interface StairsParams {
  /** Number of steps. */
  steps: number;
  /** Width of the flight (STRAIGHT) / radial length of the treads (SPIRAL) in metres. */
  width: number;
  /** Height of one step in metres. */
  rise: number;
  /** Depth of one tread in metres (SPIRAL: measured on the walking line at mid-width). */
  run: number;
  style: StairsStyle;
  /** STRAIGHT: fill down to the ground (true) or a sloped slab of `thickness` underneath. */
  solid: boolean;
  /** Slab thickness under a non-solid straight flight / tread thickness of spiral steps (m). */
  thickness: number;
  /** SPIRAL: radius of the central column in metres. */
  inner_radius: number;
  /** SPIRAL: turn clockwise (seen from above) while going up. */
  clockwise: boolean;
  /** Add handrails on posts (slot 1). */
  railing: boolean;
}

export const STAIRS_DEFAULTS: StairsParams = {
  steps: 12,
  width: 1,
  rise: 0.18,
  run: 0.28,
  style: 'STRAIGHT',
  solid: true,
  thickness: 0.15,
  inner_radius: 0.15,
  clockwise: false,
  railing: false,
};

/**
 * Stairs. STRAIGHT: climbs along +Y from y = 0 (front edge of the first step), centred on X.
 * SPIRAL: winds around a central column on the Z axis starting towards +X. The top tread is at
 * z = steps × rise. Slots: 0 steps, 1 column & railing.
 */
export function generateStairs(params: Partial<StairsParams> = {}): GeneratorResult {
  const p = { ...STAIRS_DEFAULTS, ...params };
  const n = Math.round(clampNum(p.steps, 1, 500, STAIRS_DEFAULTS.steps));
  const w = clampNum(p.width, 0.05, 1e3, STAIRS_DEFAULTS.width);
  const rise = clampNum(p.rise, 0.005, 10, STAIRS_DEFAULTS.rise);
  const run = clampNum(p.run, 0.01, 10, STAIRS_DEFAULTS.run);
  const th = clampNum(p.thickness, 0.005, 10, STAIRS_DEFAULTS.thickness);
  const b = new MeshBuilder();
  const top = n * rise;
  if (p.style === 'SPIRAL') {
    const rIn = clampNum(p.inner_radius, 0.01, 100, STAIRS_DEFAULTS.inner_radius);
    const rOut = rIn + w;
    const sign = p.clockwise ? -1 : 1;
    const delta = Math.min(Math.PI / 2, run / (rIn + w / 2));
    const arcN = Math.max(1, Math.ceil(delta / (Math.PI / 18)));
    const tread = Math.min(th, rise);
    for (let i = 0; i < n; i++) {
      const outline: Vec2[] = [];
      for (let k = 0; k <= arcN; k++) {
        const a = sign * (i + k / arcN) * delta;
        outline.push([rIn * 0.95 * Math.cos(a), rIn * 0.95 * Math.sin(a)]);
      }
      for (let k = arcN; k >= 0; k--) {
        const a = sign * (i + k / arcN) * delta;
        outline.push([rOut * Math.cos(a), rOut * Math.sin(a)]);
      }
      addPrism(b, outline, (i + 1) * rise - tread, (i + 1) * rise, { mat: 0 });
    }
    const colTop = top + (p.railing ? 0.9 : 0.05);
    addLathe(
      b,
      [
        [0, 0],
        [rIn, 0],
        [rIn, colTop],
        [0, colTop],
      ],
      24,
      { mat: 1, smooth: true },
    );
    if (p.railing) {
      const rr = rOut - 0.04;
      const rail: Vec3[] = [];
      for (let i = 0; i < n; i++) {
        const a = sign * (i + 0.5) * delta;
        const base: Vec3 = [rr * Math.cos(a), rr * Math.sin(a), (i + 1) * rise];
        addTube(b, [base, [base[0], base[1], base[2] + 0.9]], 0.015, 8, { mat: 1, smooth: true });
      }
      const sub = 4;
      for (let s = 0; s <= (n - 1) * sub; s++) {
        const t = s / sub;
        const a = sign * (t + 0.5) * delta;
        rail.push([rr * Math.cos(a), rr * Math.sin(a), (t + 1) * rise + 0.92]);
      }
      addTube(b, rail, 0.025, 8, { mat: 1, smooth: true });
    }
  } else {
    // side profile in (y, z), extruded across X
    const prof: Vec2[] = [[0, 0]];
    for (let i = 0; i < n; i++) prof.push([i * run, (i + 1) * rise], [(i + 1) * run, (i + 1) * rise]);
    const slope = Math.atan2(rise, run);
    const tv = th / Math.cos(slope);
    const ys = (tv * run) / rise;
    if (p.solid || top - tv <= 1e-6 || ys >= n * run - 1e-6) prof.push([n * run, 0]);
    else prof.push([n * run, top - tv], [ys, 0]);
    addPrism(b, prof, -w / 2, w / 2, { mat: 0, matrix: YZ_EXTRUDE_X });
    if (p.railing) {
      const posts = [...new Set([...Array.from({ length: Math.ceil(n / 2) }, (_, k) => k * 2), n - 1])];
      for (const side of [-1, 1]) {
        const x = side * (w / 2 - 0.04);
        const tops: Vec3[] = [];
        for (const i of posts) {
          const y = (i + 0.5) * run;
          const z = (i + 1) * rise;
          addBoxBetween(b, [x, y, z], [x, y, z + 0.9], 0.04, 0.04, [0, 1, 0], { mat: 1 });
          tops.push([x, y, z + 0.92]);
        }
        if (tops.length >= 2) addTube(b, [tops[0], tops[tops.length - 1]], 0.025, 8, { mat: 1, smooth: true });
      }
    }
  }
  const mesh = b.build();
  markSharpEdges(mesh, 0.7);
  return { mesh, materials: [MATERIALS.concrete, MATERIALS.metal] };
}

// ------------------------------------------------------------------ fence

export type FenceStyle = 'RAIL' | 'PICKET';

export interface FenceParams {
  /** Path the fence follows (object space, [x, y] or [x, y, z]); default a straight run along +X. */
  points: number[][] | null;
  /** Length of the default straight fence in metres (when `points` is not given). */
  length: number;
  /** Height in metres. */
  height: number;
  /** Maximum distance between posts in metres (posts are also placed at every path point). */
  post_spacing: number;
  /** Width of the square posts in metres. */
  post_width: number;
  /** RAIL: number of horizontal rails between posts. */
  rails: number;
  /** RAIL: horizontal rails only; PICKET: two rails with pointed vertical boards. */
  style: FenceStyle;
  /** PICKET: board width and gap between boards in metres. */
  picket_width: number;
  picket_gap: number;
  /** Close the path into a loop. */
  closed: boolean;
}

export const FENCE_DEFAULTS: FenceParams = {
  points: null,
  length: 6,
  height: 1,
  post_spacing: 2,
  post_width: 0.1,
  rails: 2,
  style: 'PICKET',
  picket_width: 0.08,
  picket_gap: 0.05,
  closed: false,
};

/** Fence along a path of points (posts stand on the path; z values let it follow terrain). */
export function generateFence(params: Partial<FenceParams> = {}): GeneratorResult {
  const p = { ...FENCE_DEFAULTS, ...params };
  const H = clampNum(p.height, 0.05, 100, FENCE_DEFAULTS.height);
  const spacing = clampNum(p.post_spacing, 0.1, 1e3, FENCE_DEFAULTS.post_spacing);
  const pw = clampNum(p.post_width, 0.005, 10, FENCE_DEFAULTS.post_width);
  let path: Vec3[] = (p.points ?? [])
    .filter((q) => Array.isArray(q) && q.length >= 2 && q.slice(0, 3).every(Number.isFinite))
    .map((q) => [q[0], q[1], q[2] ?? 0]);
  path = path.filter((q, i) => i === 0 || Math.hypot(q[0] - path[i - 1][0], q[1] - path[i - 1][1]) > 1e-6);
  if (path.length < 2) {
    const L = clampNum(p.length, 0.1, 1e4, FENCE_DEFAULTS.length);
    path = [
      [0, 0, 0],
      [L, 0, 0],
    ];
  }
  const closed = p.closed && path.length > 2;
  if (closed && Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]) < 1e-6)
    path.pop();
  // posts: every path point plus evenly spaced intermediate posts
  const posts: Vec3[] = [];
  const segs = closed ? path.length : path.length - 1;
  for (let s = 0; s < segs; s++) {
    const a = path[s];
    const c = path[(s + 1) % path.length];
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const k = Math.max(1, Math.ceil(L / spacing - 1e-9));
    for (let i = 0; i < k; i++) {
      const t = i / k;
      posts.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t]);
    }
  }
  if (!closed) posts.push(path[path.length - 1]);
  const b = new MeshBuilder();
  const postTop = H + (p.style === 'PICKET' ? 0.06 : 0.08);
  const bays = closed ? posts.length : posts.length - 1;
  const dirOf = (i: number): Vec2 => {
    const a = posts[i % posts.length];
    const c = posts[(i + 1) % posts.length];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    return [(c[0] - a[0]) / l, (c[1] - a[1]) / l];
  };
  posts.forEach((q, i) => {
    // posts are turned to the average direction of their two bays
    const d0 = i < bays ? dirOf(i) : dirOf(i - 1);
    const d1 = i > 0 || closed ? dirOf((i - 1 + posts.length) % posts.length) : d0;
    let dx = d0[0] + d1[0];
    let dy = d0[1] + d1[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) [dx, dy] = d0;
    else [dx, dy] = [dx / l, dy / l];
    addBoxBetween(b, [q[0] - (dx * pw) / 2, q[1] - (dy * pw) / 2, q[2] + postTop / 2], [q[0] + (dx * pw) / 2, q[1] + (dy * pw) / 2, q[2] + postTop / 2], pw, postTop, [0, 0, 1]);
  });
  for (let i = 0; i < bays; i++) {
    const a = posts[i];
    const c = posts[(i + 1) % posts.length];
    if (p.style === 'RAIL') {
      const rails = Math.round(clampNum(p.rails, 1, 20, 2));
      for (let k = 0; k < rails; k++) {
        const h = rails === 1 ? 0.75 * H : H * (0.3 + (0.6 * k) / (rails - 1));
        addBoxBetween(b, [a[0], a[1], a[2] + h], [c[0], c[1], c[2] + h], pw * 0.4, Math.min(pw * 0.9, H * 0.15), [0, 0, 1]);
      }
      continue;
    }
    const railT = Math.min(0.025, pw * 0.3);
    for (const f of [0.25, 0.72])
      addBoxBetween(b, [a[0], a[1], a[2] + f * H], [c[0], c[1], c[2] + f * H], railT, Math.min(0.07, H * 0.1), [0, 0, 1]);
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const dx = (c[0] - a[0]) / (L || 1);
    const dy = (c[1] - a[1]) / (L || 1);
    const nx = dy; // bay normal (right of the walking direction)
    const ny = -dx;
    const pk = clampNum(p.picket_width, 0.005, 1, FENCE_DEFAULTS.picket_width);
    const gap = clampNum(p.picket_gap, 0, 1, FENCE_DEFAULTS.picket_gap);
    const usable = L - pw;
    const count = Math.floor((usable + gap) / (pk + gap));
    if (count < 1) continue;
    const span = count * pk + (count - 1) * gap;
    const thick = 0.02;
    const off = railT / 2 + thick / 2;
    for (let k = 0; k < count; k++) {
      const s = (L - span) / 2 + pk / 2 + k * (pk + gap);
      const t = s / (L || 1);
      const gz = a[2] + (c[2] - a[2]) * t;
      const h0 = gz + 0.05;
      const ph = Math.max(pk, gz + H - h0);
      const cx = a[0] + dx * s + nx * off;
      const cy = a[1] + dy * s + ny * off;
      // pentagon board (pointed top) in the (bay direction, up) plane, extruded along the bay normal
      const m: Mat4 = [dx, dy, 0, 0, 0, 0, 1, 0, nx, ny, 0, 0, cx, cy, h0, 1];
      const half = pk / 2;
      addPrism(
        b,
        [
          [-half, 0],
          [half, 0],
          [half, ph - half],
          [0, ph],
          [-half, ph - half],
        ],
        -thick / 2,
        thick / 2,
        { matrix: m },
      );
    }
  }
  return { mesh: b.build(), materials: [MATERIALS.fence] };
}

/** Lathe helper re-exported for generators that build revolved props. */
export { profileIsClockwise };
