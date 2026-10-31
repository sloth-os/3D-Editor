import type { Mat4, Vec3 } from '../math/types';
import { anyPerpendicular3, cross3, dot3, normalize3 } from '../math/vec3';
import { GradientNoise } from './noise';
import { Rng } from './random';
import {
  MeshBuilder,
  add,
  addBlade,
  addIcoSphere,
  addRingSurface,
  addTube,
  clampNum,
  len,
  mix,
  placeMesh,
  profileIsClockwise,
  scale,
  sub,
} from './builder';
import { MATERIALS, type GeneratedMaterial, type GeneratorResult } from './types';

/*
 * Vegetation: trees (DECIDUOUS / CONIFER / PALM), bush, grass tuft and flower. Everything is built
 * from closed parts (tubes, blades, displaced spheres) standing on z = 0 with the trunk/stem on
 * the Z axis. Trees and bushes use slot 0 for wood and slot 1 for foliage.
 */

const UP: Vec3 = [0, 0, 1];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** A branch (or trunk) skeleton: polyline with per-point radius. */
interface Limb {
  pts: Vec3[];
  radii: number[];
  level: number;
  length: number;
}

/** Point, tangent and radius at fraction t (0..1) of a limb's length. */
function limbAt(l: Limb, t: number): { p: Vec3; tan: Vec3; r: number } {
  const n = l.pts.length - 1;
  const f = clampNum(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const u = f - i;
  return {
    p: mix(l.pts[i], l.pts[i + 1], u),
    tan: normalize3(sub(l.pts[i + 1], l.pts[i])),
    r: l.radii[i] + (l.radii[i + 1] - l.radii[i]) * u,
  };
}

function growLimb(
  start: Vec3,
  dir: Vec3,
  length: number,
  r0: number,
  r1: number,
  level: number,
  segs: number,
  rng: Rng,
  upPull: number,
  wiggle: number,
): Limb {
  const pts: Vec3[] = [start];
  const radii: number[] = [r0];
  let d = normalize3(dir);
  for (let s = 1; s <= segs; s++) {
    const w = rng.unitVector();
    d = normalize3(add(d, add(scale(UP, upPull / segs), scale(w, wiggle / segs))));
    pts.push(add(pts[s - 1], scale(d, length / segs)));
    radii.push(r0 + ((r1 - r0) * s) / segs);
  }
  return { pts, radii, level, length };
}

/** Direction tilted by `angle` away from `axis`, towards the azimuth `az` around it. */
function tilt(axis: Vec3, angle: number, az: number): Vec3 {
  let u = sub([1, 0, 0], scale(axis, axis[0]));
  if (len(u) < 0.2) u = anyPerpendicular3(axis);
  u = normalize3(u);
  const v = cross3(axis, u);
  const side = add(scale(u, Math.cos(az)), scale(v, Math.sin(az)));
  return normalize3(add(scale(axis, Math.cos(angle)), scale(side, Math.sin(angle))));
}

/** Uniformly scales skeleton positions (not radii) so that max(z·f + extra) = height. */
function fitHeight(elements: { z: number; extra: number }[], height: number): number {
  let lo = 0.05;
  let hi = 20;
  const top = (f: number) => Math.max(...elements.map((e) => e.z * f + e.extra));
  if (top(hi) < height) return hi;
  if (top(lo) > height) return lo;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (top(mid) > height) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Scales every vertex about the origin so the top of the mesh is exactly at `height`, then flattens
 * anything below the ground (the tilted foot of the trunk) onto z = 0.
 */
function exactHeight(b: MeshBuilder, height: number): void {
  const { max } = b.bounds();
  if (!(max[2] > 1e-9)) return;
  const f = height / max[2];
  const P = b.positions;
  for (let i = 0; i < P.length; i += 3) {
    P[i] *= f;
    P[i + 1] *= f;
    P[i + 2] = Math.max(0, P[i + 2] * f);
  }
}

/** Leafy clump: displaced low-poly sphere. */
function addClump(
  b: MeshBuilder,
  noise: GradientNoise,
  c: Vec3,
  r: number,
  squash: number,
  seedOff: number,
): void {
  addIcoSphere(b, c, [r, r, r * squash], 2, {
    mat: 1,
    smooth: true,
    displace: (d) =>
      1 + 0.22 * noise.noise3(d[0] * 2.1 + seedOff, d[1] * 2.1 - seedOff, d[2] * 2.1 + seedOff * 0.5),
  });
}

// ------------------------------------------------------------------ tree

export type TreeStyle = 'DECIDUOUS' | 'CONIFER' | 'PALM';

export interface TreeParams {
  style: TreeStyle;
  /** Total height including foliage, in metres (exact). */
  height: number;
  /** Radius of the trunk near the ground in metres. */
  trunk_radius: number;
  /** DECIDUOUS: branching depth (1..4); CONIFER: foliage tiers = branch_levels + 3. */
  branch_levels: number;
  /** DECIDUOUS: angle between a branch and its parent; CONIFER: slope of the tiers; PALM: frond droop (radians). */
  branch_angle: number;
  /** DECIDUOUS: child branches per branch; PALM: fronds = branches × 3. */
  branches: number;
  /** 0..1 amount of foliage (0 = bare branches). */
  leaf_density: number;
  /** DECIDUOUS: leaf clump diameter; CONIFER: depth of the jagged tier rims; PALM: frond width (metres). */
  leaf_size: number;
  seed: number;
  /** Vertices around the trunk (branches use fewer). */
  resolution: number;
}

export const TREE_DEFAULTS: TreeParams = {
  style: 'DECIDUOUS',
  height: 6,
  trunk_radius: 0.2,
  branch_levels: 3,
  branch_angle: 0.7,
  branches: 4,
  leaf_density: 0.8,
  leaf_size: 0.9,
  seed: 0,
  resolution: 8,
};

/** Tree standing on z = 0 with the trunk on the Z axis. Slots: 0 Bark, 1 foliage. */
export function generateTree(params: Partial<TreeParams> = {}): GeneratorResult {
  const p = { ...TREE_DEFAULTS, ...params };
  const q: TreeParams = {
    style: p.style === 'CONIFER' || p.style === 'PALM' ? p.style : 'DECIDUOUS',
    height: clampNum(p.height, 0.1, 1000, TREE_DEFAULTS.height),
    trunk_radius: clampNum(p.trunk_radius, 0.002, 100, TREE_DEFAULTS.trunk_radius),
    branch_levels: Math.round(clampNum(p.branch_levels, 1, 4, TREE_DEFAULTS.branch_levels)),
    branch_angle: clampNum(p.branch_angle, 0, Math.PI / 2, TREE_DEFAULTS.branch_angle),
    branches: Math.round(clampNum(p.branches, 1, 12, TREE_DEFAULTS.branches)),
    leaf_density: clampNum(p.leaf_density, 0, 1, TREE_DEFAULTS.leaf_density),
    leaf_size: clampNum(p.leaf_size, 0.01, 100, TREE_DEFAULTS.leaf_size),
    seed: Number.isFinite(p.seed) ? p.seed : 0,
    resolution: Math.round(clampNum(p.resolution, 3, 64, TREE_DEFAULTS.resolution)),
  };
  if (q.style === 'CONIFER') return conifer(q);
  if (q.style === 'PALM') return palm(q);
  return deciduous(q);
}

function addLimb(b: MeshBuilder, l: Limb, sides: number): void {
  addTube(b, l.pts, (i) => l.radii[i], sides, { mat: 0, smooth: true });
}

function deciduous(p: TreeParams): GeneratorResult {
  const H = p.height;
  const rng = new Rng(p.seed, 0xdec1);
  const trunk = growLimb(
    [0, 0, 0],
    add(UP, [rng.spread(0.06), rng.spread(0.06), 0]),
    H * 0.6,
    p.trunk_radius,
    p.trunk_radius * 0.35,
    0,
    8,
    rng,
    0,
    0.12,
  );
  trunk.radii[0] *= 1.35;
  const limbs: Limb[] = [trunk];
  for (let qi = 0; qi < limbs.length; qi++) {
    const limb = limbs[qi];
    if (limb.level >= p.branch_levels) continue;
    const kids = limb.level === 0 ? Math.max(2, Math.round(p.branches * 1.6)) : p.branches;
    const t0 = limb.level === 0 ? 0.4 : 0.28;
    const az0 = rng.range(0, 2 * Math.PI);
    for (let c = 0; c < kids; c++) {
      const t = clampNum(t0 + (1 - t0) * ((c + 0.5 + rng.spread(0.35)) / kids), t0, 0.97);
      const at = limbAt(limb, t);
      const angle = p.branch_angle * (1 + rng.spread(0.25)) * (limb.level === 0 ? 1 : 0.85);
      const dir = tilt(at.tan, angle, az0 + c * GOLDEN_ANGLE + rng.spread(0.4));
      const rel = (t - t0) / (1 - t0);
      const length =
        limb.length * (limb.level === 0 ? 0.7 : 0.62) * (1.15 - 0.55 * rel) * rng.range(0.85, 1.1);
      const r0 = Math.max(0.003, at.r * 0.7);
      limbs.push(
        growLimb(
          at.p,
          dir,
          length,
          r0,
          Math.max(0.002, r0 * 0.3),
          limb.level + 1,
          Math.max(3, 6 - limb.level),
          rng,
          0.45,
          0.3,
        ),
      );
    }
  }
  // foliage candidates: tips (and middles) of the outermost branches
  const spots: Vec3[] = [];
  for (const l of limbs) {
    if (l.level === p.branch_levels) spots.push(limbAt(l, 1).p, limbAt(l, 0.55).p);
    else if (l.level === p.branch_levels - 1 && l.level > 0) spots.push(limbAt(l, 1).p);
  }
  const clumps: { c: Vec3; r: number }[] = [];
  spots.forEach((c, i) => {
    const r = new Rng(p.seed, 0x1eaf00 + i);
    if (r.next() >= p.leaf_density) return;
    clumps.push({ c, r: (p.leaf_size / 2) * r.range(0.75, 1.2) });
  });
  // fit the skeleton so the crown top lands on the requested height
  const elements = [
    ...limbs.flatMap((l) => l.pts.map((pt, i) => ({ z: pt[2], extra: l.radii[i] }))),
    ...clumps.map((k) => ({ z: k.c[2], extra: k.r * 0.85 })),
  ];
  const f = fitHeight(elements, H);
  for (const l of limbs) l.pts = l.pts.map((pt) => scale(pt, f));
  for (const k of clumps) k.c = add(scale(k.c, f), [0, 0, k.r * 0.2]);
  const b = new MeshBuilder();
  for (const l of limbs)
    addLimb(b, l, l.level === 0 ? p.resolution : Math.max(3, p.resolution - 2 * l.level));
  const noise = new GradientNoise(p.seed + 17);
  clumps.forEach((k, i) => addClump(b, noise, k.c, k.r, 0.8, i * 3.7));
  exactHeight(b, H);
  return { mesh: b.build(), materials: [MATERIALS.bark, MATERIALS.leaves] };
}

function conifer(p: TreeParams): GeneratorResult {
  const H = p.height;
  const rng = new Rng(p.seed, 0xc0f1);
  const b = new MeshBuilder();
  const trunk = growLimb(
    [0, 0, 0],
    add(UP, [rng.spread(0.03), rng.spread(0.03), 0]),
    H * 0.97,
    p.trunk_radius,
    p.trunk_radius * 0.12,
    0,
    8,
    rng,
    0,
    0.04,
  );
  trunk.radii[0] *= 1.3;
  addLimb(b, trunk, p.resolution);
  if (p.leaf_density > 0) {
    const tiers = p.branch_levels + 3;
    const slope0 = Math.tan(clampNum(p.branch_angle, 0.15, 1.3, 0.7));
    const crownBase = H * 0.15;
    const rBottom = H * 0.24 * (0.55 + 0.45 * p.leaf_density);
    const radiusAt = (k: number) => rBottom * (1 - (0.82 * k) / Math.max(1, tiers - 1));
    const apex0 = Math.min(H, crownBase + radiusAt(0) * slope0);
    const spacing = tiers > 1 ? (H - apex0) / (tiers - 1) : 0;
    const jagCount = 12 + 2 * Math.round(4 * p.leaf_density);
    for (let k = 0; k < tiers; k++) {
      const r = radiusAt(k);
      const apex = tiers === 1 ? H : apex0 + spacing * k;
      // upper tiers get steeper so consecutive tiers always overlap
      const slope = Math.max(slope0, (spacing * 1.6) / r);
      const rimZ = apex - r * slope;
      const jag = Math.min(p.leaf_size * 0.35, r * 0.35);
      // inner rim points sit a little higher (stays below the upper ring for any slope)
      const lift = Math.min(jag * 0.4, r * slope * 0.15);
      const rot = rng.range(0, 2 * Math.PI);
      const axis = limbAt(trunk, clampNum(apex / (H * 0.97), 0, 1)).p;
      const ring = (rr: (j: number) => number, z: (j: number) => number): Vec3[] =>
        Array.from({ length: jagCount }, (_, j) => {
          const a = rot + (2 * Math.PI * j) / jagCount;
          return [axis[0] + rr(j) * Math.cos(a), axis[1] + rr(j) * Math.sin(a), z(j)];
        });
      const tipJitter = Array.from({ length: jagCount }, () => rng.range(0.9, 1.08));
      const profile: [number, number][] = [
        [0, apex],
        [r * 0.5, apex - r * 0.5 * slope],
        [r, rimZ],
        [r * 0.3, rimZ + r * slope * 0.25],
        [0, rimZ + r * slope * 0.35],
      ];
      const rings: Vec3[][] = [
        [[axis[0], axis[1], apex]],
        ring(
          (j) => r * 0.53 * (j % 2 ? 0.96 : 1.04),
          () => apex - r * 0.5 * slope,
        ),
        ring(
          (j) => (j % 2 ? r - jag : r * tipJitter[j]),
          (j) => rimZ + (j % 2 ? lift : 0),
        ),
        ring(
          () => r * 0.3,
          () => rimZ + r * slope * 0.25,
        ),
        [[axis[0], axis[1], rimZ + r * slope * 0.35]],
      ];
      addRingSurface(b, rings, { mat: 1, smooth: false, flip: profileIsClockwise(profile) });
    }
  }
  exactHeight(b, H);
  return { mesh: b.build(), materials: [MATERIALS.bark, MATERIALS.needles] };
}

function palm(p: TreeParams): GeneratorResult {
  const H = p.height;
  const rng = new Rng(p.seed, 0x9a1f);
  const b = new MeshBuilder();
  const trunkH = H * 0.84;
  const leanAz = rng.range(0, 2 * Math.PI);
  const lean = H * 0.1 * rng.range(0.5, 1.2);
  const top: Vec3 = [lean * Math.cos(leanAz), lean * Math.sin(leanAz), trunkH];
  const mid: Vec3 = [0, 0, trunkH * 0.55];
  const n = 24;
  const path: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    path.push(add(add(scale([0, 0, 0], (1 - t) * (1 - t)), scale(mid, 2 * t * (1 - t))), scale(top, t * t)));
  }
  // banded trunk: alternating ring radii
  addTube(
    b,
    path,
    (i) => p.trunk_radius * (1.25 - 0.45 * (i / n)) * (i === 0 ? 1.2 : i % 2 ? 0.93 : 1),
    p.resolution,
    {
      mat: 0,
      smooth: true,
    },
  );
  const crown = top;
  // coconuts under the crown
  const nutR = Math.max(0.03, p.trunk_radius * 0.55);
  for (let k = 0; k < 3; k++) {
    const a = leanAz + (2 * Math.PI * k) / 3 + 0.4;
    const c: Vec3 = add(crown, [
      Math.cos(a) * p.trunk_radius * 1.1,
      Math.sin(a) * p.trunk_radius * 1.1,
      -nutR * 1.2,
    ]);
    addIcoSphere(b, c, [nutR, nutR, nutR * 1.1], 2, { mat: 0, smooth: true });
  }
  if (p.leaf_density > 0) {
    const fronds = Math.max(3, Math.min(40, p.branches * 3));
    const pts = 16 + Math.round(p.leaf_density * 16);
    const droop = clampNum(p.branch_angle, 0, Math.PI / 2, 0.7) * 2.6;
    for (let k = 0; k < fronds; k++) {
      const r = new Rng(p.seed, 0xf20d + k);
      const az = (2 * Math.PI * k) / fronds + r.spread(0.25);
      const elev = r.range(0.35, 0.95);
      let d: Vec3 = [Math.cos(az) * Math.cos(elev), Math.sin(az) * Math.cos(elev), Math.sin(elev)];
      const L = H * 0.42 * r.range(0.85, 1.1);
      const spine: Vec3[] = [add(crown, scale(d, p.trunk_radius * 0.5))];
      for (let i = 1; i < pts; i++) {
        d = normalize3(add(d, [0, 0, -droop / pts]));
        spine.push(add(spine[i - 1], scale(d, L / (pts - 1))));
      }
      const widths = spine.map((_, i) => {
        const t = i / (pts - 1);
        const w = p.leaf_size * Math.pow(Math.sin(Math.PI * t), 0.6);
        return i % 2 && t > 0.1 && t < 0.95 ? w * 0.55 : w;
      });
      const thick = spine.map((_, i) => (i === 0 || i === pts - 1 ? 0 : 0.012 + 0.012 * (1 - i / pts)));
      const normals = spine.map((_, i) => {
        const tan = normalize3(sub(spine[Math.min(pts - 1, i + 1)], spine[Math.max(0, i - 1)]));
        const nn = sub(UP, scale(tan, dot3(UP, tan)));
        return len(nn) > 1e-3 ? normalize3(nn) : anyPerpendicular3(tan);
      });
      widths[0] = 0;
      widths[pts - 1] = 0;
      addBlade(b, spine, widths, thick, normals, { mat: 1, smooth: true });
    }
  }
  exactHeight(b, H);
  return { mesh: b.build(), materials: [MATERIALS.bark, MATERIALS.palmLeaves] };
}

// ------------------------------------------------------------------ bush

export interface BushParams {
  /** Diameter in metres. */
  size: number;
  /** Height in metres (exact). */
  height: number;
  /** 0..1: number of leaf clumps (8..40). */
  density: number;
  /** Diameter of one leaf clump in metres. */
  leaf_size: number;
  seed: number;
}

export const BUSH_DEFAULTS: BushParams = { size: 1.2, height: 0.9, density: 0.7, leaf_size: 0.4, seed: 0 };

/** Bush: a dome of leafy clumps on short stems, standing on z = 0. Slots: 0 Bark, 1 Leaves. */
export function generateBush(params: Partial<BushParams> = {}): GeneratorResult {
  const p = { ...BUSH_DEFAULTS, ...params };
  const size = clampNum(p.size, 0.02, 100, BUSH_DEFAULTS.size);
  const H = clampNum(p.height, 0.02, 100, BUSH_DEFAULTS.height);
  const density = clampNum(p.density, 0, 1, BUSH_DEFAULTS.density);
  const lr = Math.min(clampNum(p.leaf_size, 0.01, 100, BUSH_DEFAULTS.leaf_size) / 2, size / 2, H / 2);
  const rng = new Rng(p.seed, 0xb054);
  const noise = new GradientNoise(p.seed + 5);
  const count = Math.round(8 + density * 32);
  const rx = Math.max(0, size / 2 - lr);
  const rz = Math.max(0, H - 2 * lr);
  const b = new MeshBuilder();
  const centers: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const d = rng.unitVector();
    const u = 0.45 + 0.55 * rng.next();
    centers.push([d[0] * rx * u, d[1] * rx * u, lr * 0.9 + Math.abs(d[2]) * rz * u]);
  }
  // a few short stems from the ground to the lowest clumps
  const low = centers
    .slice()
    .sort((a, c) => a[2] - c[2])
    .slice(0, Math.min(5, centers.length));
  const stemR = Math.max(0.004, size * 0.018);
  for (const c of low)
    addTube(b, [[c[0] * 0.15, c[1] * 0.15, 0], [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], c], stemR, 6, {
      mat: 0,
      smooth: true,
    });
  centers.forEach((c, i) => addClump(b, noise, c, lr * rng.range(0.75, 1.15), 0.85, i * 2.3));
  const mesh = b.build();
  placeMesh(mesh, { ground: true });
  exactZ(mesh.positions, H);
  return { mesh, materials: [MATERIALS.bark, MATERIALS.leaves] };
}

function exactZ(P: number[], height: number): void {
  let max = 0;
  for (let i = 2; i < P.length; i += 3) max = Math.max(max, P[i]);
  if (!(max > 1e-9)) return;
  for (let i = 2; i < P.length; i += 3) P[i] *= height / max;
}

// ------------------------------------------------------------------ grass tuft

export interface GrassParams {
  /** Number of blades. */
  blades: number;
  /** Height of the tallest blades in metres. */
  height: number;
  /** Radius over which the blade roots are spread, in metres. */
  spread: number;
  /** Width of a blade at its root in metres. */
  blade_width: number;
  /** 0..1 how far the blades arch over. */
  bend: number;
  seed: number;
}

export const GRASS_DEFAULTS: GrassParams = {
  blades: 24,
  height: 0.35,
  spread: 0.08,
  blade_width: 0.014,
  bend: 0.5,
  seed: 0,
};

/** Grass tuft of curved, pointed blades standing on z = 0. Slot 0: Grass. */
export function generateGrassTuft(params: Partial<GrassParams> = {}): GeneratorResult {
  const p = { ...GRASS_DEFAULTS, ...params };
  const count = Math.round(clampNum(p.blades, 1, 1000, GRASS_DEFAULTS.blades));
  const H = clampNum(p.height, 0.005, 100, GRASS_DEFAULTS.height);
  const spread = clampNum(p.spread, 0, 100, GRASS_DEFAULTS.spread);
  const bw = clampNum(p.blade_width, 0.0005, 10, GRASS_DEFAULTS.blade_width);
  const bend = clampNum(p.bend, 0, 1, GRASS_DEFAULTS.bend);
  const b = new MeshBuilder();
  const segs = 5;
  for (let i = 0; i < count; i++) {
    const r = new Rng(p.seed, 0x6a55 + i);
    const ra = spread * Math.sqrt(r.next());
    const ta = r.range(0, 2 * Math.PI);
    const base: Vec3 = [ra * Math.cos(ta), ra * Math.sin(ta), 0];
    const az = ra > spread * 0.2 ? ta + r.spread(0.6) : r.range(0, 2 * Math.PI);
    const out: Vec3 = [Math.cos(az), Math.sin(az), 0];
    const lean = r.range(0.05, 0.45);
    const h = H * r.range(0.6, 1);
    const p1 = add(add(base, [0, 0, h * 0.55]), scale(out, h * lean * 0.3));
    const p2 = add(
      add(base, [0, 0, h * (1 - bend * 0.35 * (0.5 + lean))]),
      scale(out, h * (lean * 0.8 + bend * 0.45)),
    );
    const spine: Vec3[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      spine.push(add(add(scale(base, (1 - t) * (1 - t)), scale(p1, 2 * t * (1 - t))), scale(p2, t * t)));
    }
    const widths = spine.map((_, s) => (s === segs ? 0 : bw * Math.pow(1 - s / segs, 0.7)));
    const thick = widths.map((w) => w * 0.25);
    addBlade(
      b,
      spine,
      widths,
      thick,
      spine.map(() => out),
      { mat: 0, smooth: true },
    );
  }
  const mesh = b.build();
  placeMesh(mesh, { ground: true });
  return { mesh, materials: [MATERIALS.grass] };
}

// ------------------------------------------------------------------ flower

export interface FlowerParams {
  /** Height of the flower head above the ground in metres. */
  height: number;
  /** Number of petals. */
  petals: number;
  petal_length: number;
  petal_width: number;
  /** Radius of the flower centre (disc) in metres. */
  head_size: number;
  /** Number of leaves on the stem (0..6). */
  leaves: number;
  seed: number;
}

export const FLOWER_DEFAULTS: FlowerParams = {
  height: 0.45,
  petals: 8,
  petal_length: 0.06,
  petal_width: 0.03,
  head_size: 0.02,
  leaves: 2,
  seed: 0,
};

/** Flower (stem, leaves, petals, centre disc) on z = 0. Slots: 0 Stem, 1 Petals, 2 Flower Center. */
export function generateFlower(params: Partial<FlowerParams> = {}): GeneratorResult {
  const p = { ...FLOWER_DEFAULTS, ...params };
  const H = clampNum(p.height, 0.01, 100, FLOWER_DEFAULTS.height);
  const petals = Math.round(clampNum(p.petals, 0, 64, FLOWER_DEFAULTS.petals));
  const pl = clampNum(p.petal_length, 0.001, 10, FLOWER_DEFAULTS.petal_length);
  const pw = clampNum(p.petal_width, 0.0005, 10, FLOWER_DEFAULTS.petal_width);
  const hs = clampNum(p.head_size, 0.001, 10, FLOWER_DEFAULTS.head_size);
  const leaves = Math.round(clampNum(p.leaves, 0, 6, FLOWER_DEFAULTS.leaves));
  const rng = new Rng(p.seed, 0xf10e);
  const b = new MeshBuilder();
  const leanAz = rng.range(0, 2 * Math.PI);
  const lean = H * 0.08 * rng.next();
  const head: Vec3 = [lean * Math.cos(leanAz), lean * Math.sin(leanAz), H - hs * 0.5];
  const c1: Vec3 = [0, 0, H * 0.5];
  const stem: Vec3[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    stem.push(add(add(scale([0, 0, 0], (1 - t) * (1 - t)), scale(c1, 2 * t * (1 - t))), scale(head, t * t)));
  }
  const stemR = Math.max(0.0015, H * 0.012);
  addTube(b, stem, (i) => stemR * (1 - 0.25 * (i / 6)), 6, { mat: 0, smooth: true });
  const endTan = normalize3(sub(stem[6], stem[5]));
  const up = normalize3(add(endTan, UP));
  let e1 = sub([1, 0, 0], scale(up, up[0]));
  if (len(e1) < 0.2) e1 = anyPerpendicular3(up);
  e1 = normalize3(e1);
  const e2 = cross3(up, e1);
  const center = add(head, scale(up, hs * 0.15));
  const m: Mat4 = [
    e1[0],
    e1[1],
    e1[2],
    0,
    e2[0],
    e2[1],
    e2[2],
    0,
    up[0],
    up[1],
    up[2],
    0,
    center[0],
    center[1],
    center[2],
    1,
  ];
  addIcoSphere(b, [0, 0, 0], [hs, hs, hs * 0.5], 2, { mat: 2, smooth: true, matrix: m });
  const a0 = rng.range(0, 2 * Math.PI);
  for (let k = 0; k < petals; k++) {
    const a = a0 + (2 * Math.PI * k) / petals;
    const dir = add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a)));
    const spine: Vec3[] = [];
    for (let s = 0; s <= 5; s++) {
      const t = s / 5;
      spine.push(add(add(head, scale(dir, hs * 0.7 + pl * t)), scale(up, pl * 0.3 * t * t)));
    }
    const widths = spine.map((_, s) => pw * Math.pow(Math.sin(Math.PI * (0.15 + 0.85 * (s / 5))), 0.7));
    widths[5] = 0;
    const thick = spine.map((_, s) => (s === 5 ? 0 : 0.0025 * (1 - (0.6 * s) / 5)));
    addBlade(
      b,
      spine,
      widths,
      thick,
      spine.map(() => up),
      { mat: 1, smooth: true },
    );
  }
  for (let k = 0; k < leaves; k++) {
    const t = 0.22 + (0.3 * k) / Math.max(1, leaves);
    const i = Math.min(5, Math.floor(t * 6));
    const at = mix(stem[i], stem[i + 1], t * 6 - i);
    const az = leanAz + Math.PI * k + rng.spread(0.5);
    const out: Vec3 = [Math.cos(az), Math.sin(az), 0];
    const L = H * 0.3;
    const spine: Vec3[] = [];
    for (let s = 0; s <= 6; s++) {
      const u = s / 6;
      spine.push(add(add(at, scale(out, L * u * 0.9)), [0, 0, L * (0.55 * u - 0.45 * u * u)]));
    }
    const widths = spine.map((_, s) => L * 0.22 * Math.pow(Math.sin(Math.PI * (s / 6)), 0.8));
    const thick = spine.map((_, s) => (s === 0 || s === 6 ? 0 : 0.002));
    const normals = spine.map((_, s) => {
      const tan = normalize3(sub(spine[Math.min(6, s + 1)], spine[Math.max(0, s - 1)]));
      const nn = sub(UP, scale(tan, dot3(UP, tan)));
      return len(nn) > 1e-3 ? normalize3(nn) : out;
    });
    addBlade(b, spine, widths, thick, normals, { mat: 0, smooth: true });
  }
  const mesh = b.build();
  placeMesh(mesh, { ground: true });
  return { mesh, materials: [MATERIALS.stem, MATERIALS.petals, MATERIALS.flowerCenter] };
}

/** Materials of a tree style (slot 0 bark, slot 1 foliage). */
export function treeMaterials(style: TreeStyle): GeneratedMaterial[] {
  return [
    MATERIALS.bark,
    style === 'CONIFER' ? MATERIALS.needles : style === 'PALM' ? MATERIALS.palmLeaves : MATERIALS.leaves,
  ];
}
