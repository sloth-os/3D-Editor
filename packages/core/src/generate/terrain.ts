import type { Vec3 } from '../math/types';
import { GradientNoise, type FractalType } from './noise';
import { Rng } from './random';
import {
  MeshBuilder,
  addIcoSphere,
  boxProjectUV,
  clampNum,
  markSharpEdges,
  placeMesh,
  smoothstep,
} from './builder';
import { MATERIALS, type GeneratorResult } from './types';

/*
 * Landscape generators: noise heightfield terrain and displaced-icosphere rocks.
 */

// ------------------------------------------------------------------ terrain

export interface TerrainParams {
  /** Width of the (square) terrain in metres. */
  size: number;
  /** Grid cells per side (vertices per side = subdivisions + 1). */
  subdivisions: number;
  /** Elevation range in metres: heights span exactly z = 0 … height. */
  height: number;
  /** Size of the largest noise features in metres. */
  noise_scale: number;
  /** Number of noise octaves (detail levels). */
  octaves: number;
  /** Amplitude kept per octave, 0..1 (higher = rougher). */
  roughness: number;
  /** FBM: rolling hills; RIDGED: sharp mountain crests; BILLOW: rounded dunes/hills. */
  noise_type: FractalType;
  seed: number;
  /** 0..1: lowers the terrain towards its rim (1 = an island whose edges are at z = 0). */
  island_falloff: number;
  /** Number of terrace levels (0 = smooth slopes). */
  terraces: number;
  /** Assign Grass / Rock (steep) / Snow (high) material slots per face (false: one Ground slot). */
  zones: boolean;
  /** Faces steeper than this slope angle (radians) get the Rock slot. */
  rock_slope: number;
  /** Faces higher than this fraction of `height` get the Snow slot (1 = no snow). */
  snow_height: number;
  /** Close the terrain into a solid block with skirt walls down to z = −base_depth. */
  solid: boolean;
  base_depth: number;
}

export const TERRAIN_DEFAULTS: TerrainParams = {
  size: 20,
  subdivisions: 64,
  height: 3,
  noise_scale: 10,
  octaves: 5,
  roughness: 0.5,
  noise_type: 'FBM',
  seed: 0,
  island_falloff: 0,
  terraces: 0,
  zones: true,
  rock_slope: 0.6,
  snow_height: 0.8,
  solid: false,
  base_depth: 1,
};

/** Heights (0..1 normalized) of the terrain grid, row-major (y rows of x), (n+1)² values. */
export function terrainHeights(p: TerrainParams, n: number): Float64Array {
  const N = n + 1;
  const size = p.size;
  const noise = new GradientNoise(p.seed);
  const rng = new Rng(p.seed, 0x7e44a1);
  const ox = rng.range(-500, 500);
  const oy = rng.range(-500, 500);
  const oz = rng.range(-500, 500);
  const fs = 1 / clampNum(p.noise_scale, 1e-3, 1e6, TERRAIN_DEFAULTS.noise_scale);
  const h = new Float64Array(N * N);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = -size / 2 + (size * i) / n;
      const y = -size / 2 + (size * j) / n;
      const v = noise.fractal(x * fs + ox, y * fs + oy, oz, {
        octaves: p.octaves,
        gain: p.roughness,
        type: p.noise_type,
      });
      h[j * N + i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  const range = hi - lo;
  for (let k = 0; k < h.length; k++) h[k] = range > 1e-12 ? (h[k] - lo) / range : 0;
  const fall = clampNum(p.island_falloff, 0, 1, 0);
  if (fall > 0) {
    let max = 0;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const r = Math.hypot(i / n - 0.5, j / n - 0.5) * 2;
        const mask = 1 - smoothstep(0.3, 1, r);
        const k = j * N + i;
        h[k] *= 1 - fall + fall * mask;
        if (h[k] > max) max = h[k];
      }
    if (max > 1e-12) for (let k = 0; k < h.length; k++) h[k] /= max;
  }
  const T = Math.round(clampNum(p.terraces, 0, 100, 0));
  if (T > 0) {
    const ramp = 0.3;
    for (let k = 0; k < h.length; k++) {
      const t = h[k] * T;
      const base = Math.min(T - 1, Math.floor(t));
      const f = t - base;
      h[k] = (base + smoothstep(1 - ramp, 1, f)) / T;
    }
  }
  return h;
}

/**
 * Square heightfield terrain centred on the origin. Heights span z = 0 … `height`; UVs map the
 * whole terrain to 0..1. Slots: Grass, Rock, Snow (zones) or Ground.
 */
export function generateTerrain(params: Partial<TerrainParams> = {}): GeneratorResult {
  const p: TerrainParams = { ...TERRAIN_DEFAULTS, ...params };
  p.size = clampNum(p.size, 0.01, 1e5, TERRAIN_DEFAULTS.size);
  p.height = clampNum(p.height, 0, 1e5, TERRAIN_DEFAULTS.height);
  const n = Math.round(clampNum(p.subdivisions, 1, 1024, TERRAIN_DEFAULTS.subdivisions));
  const N = n + 1;
  const h = terrainHeights(p, n);
  const b = new MeshBuilder();
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++)
      b.vert([-p.size / 2 + (p.size * i) / n, -p.size / 2 + (p.size * j) / n, h[j * N + i] * p.height]);
  const idx = (i: number, j: number) => j * N + i;
  const cosRock = Math.cos(clampNum(p.rock_slope, 0, Math.PI / 2, TERRAIN_DEFAULTS.rock_slope));
  const snow = clampNum(p.snow_height, 0, 1, TERRAIN_DEFAULTS.snow_height);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const vs = [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)];
      let mat = 0;
      if (p.zones) {
        const z = vs.map((v) => b.positions[v * 3 + 2]);
        // face normal from the two diagonals
        const dx = p.size / n;
        const gx = (z[1] + z[2] - z[0] - z[3]) / (2 * dx);
        const gy = (z[2] + z[3] - z[0] - z[1]) / (2 * dx);
        const nz = 1 / Math.hypot(gx, gy, 1);
        const zf = p.height > 0 ? (z[0] + z[1] + z[2] + z[3]) / 4 / p.height : 0;
        if (nz < cosRock) mat = 1;
        else if (snow < 1 && zf > snow) mat = 2;
      }
      b.face(vs, mat, true, [i / n, j / n, (i + 1) / n, j / n, (i + 1) / n, (j + 1) / n, i / n, (j + 1) / n]);
    }
  if (p.solid) {
    const depth = clampNum(p.base_depth, 1e-3, 1e5, TERRAIN_DEFAULTS.base_depth);
    // border loop, counter-clockwise seen from above
    const loop: number[] = [];
    for (let i = 0; i < n; i++) loop.push(idx(i, 0));
    for (let j = 0; j < n; j++) loop.push(idx(n, j));
    for (let i = n; i > 0; i--) loop.push(idx(i, n));
    for (let j = n; j > 0; j--) loop.push(idx(0, j));
    const bottom = loop.map((v) => {
      const q = b.position(v);
      return b.vert([q[0], q[1], -depth]);
    });
    const side = p.zones ? 1 : 0;
    for (let k = 0; k < loop.length; k++) {
      const k1 = (k + 1) % loop.length;
      b.face([bottom[k], bottom[k1], loop[k1], loop[k]], side);
    }
    b.face(bottom.slice().reverse(), side);
  }
  return {
    mesh: b.build(),
    materials: p.zones ? [MATERIALS.grass, MATERIALS.rock, MATERIALS.snow] : [MATERIALS.ground],
  };
}

// ------------------------------------------------------------------ rock

export interface RockParams {
  /** Approximate dimensions [x, y, z] in metres. */
  size: Vec3;
  /** 0..1 amount of noise displacement (0 = smooth pebble). */
  roughness: number;
  /** Icosphere subdivision level 1..6 (resolution: 20·4^(detail−1) triangles). */
  detail: number;
  /** Number of flat fractured faces cut into the rock (0..16). */
  facets: number;
  /** Flatten the underside so the rock sits stably on the ground. */
  flat_bottom: boolean;
  seed: number;
}

export const ROCK_DEFAULTS: RockParams = {
  size: [1, 0.8, 0.6],
  roughness: 0.5,
  detail: 4,
  facets: 5,
  flat_bottom: true,
  seed: 0,
};

/** Polynomial smooth minimum of two radii (k = blend width). */
function smoothMinRadius(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

/** Rock resting on z = 0, centred on the Z axis. Slot 0: Rock. */
export function generateRock(params: Partial<RockParams> = {}): GeneratorResult {
  const p = { ...ROCK_DEFAULTS, ...params };
  const size = (p.size ?? ROCK_DEFAULTS.size).map((v, k) => clampNum(v, 1e-3, 1e4, ROCK_DEFAULTS.size[k])) as Vec3;
  const rough = clampNum(p.roughness, 0, 1, ROCK_DEFAULTS.roughness);
  const detail = Math.round(clampNum(p.detail, 1, 6, ROCK_DEFAULTS.detail));
  const facets = Math.round(clampNum(p.facets, 0, 16, ROCK_DEFAULTS.facets));
  const noise = new GradientNoise(p.seed);
  const rng = new Rng(p.seed, 0x70c4);
  const off: Vec3 = [rng.range(-100, 100), rng.range(-100, 100), rng.range(-100, 100)];
  // cutting planes in the unit-sphere space (n·q ≤ d). Vertices only move along their ray from the
  // centre, so the surface stays star-shaped (no folds); a smooth minimum rounds the facet borders
  // instead of leaving a jagged crease along the triangulation.
  const planes: { n: Vec3; d: number; k: number }[] = [];
  for (let i = 0; i < facets; i++) {
    const n = rng.unitVector();
    if (n[2] < -0.6) n[2] = -n[2]; // the bottom is handled by flat_bottom
    planes.push({ n, d: rng.range(0.6, 0.82), k: 0.1 });
  }
  if (p.flat_bottom) planes.push({ n: [0, 0, -1], d: 0.55, k: 0.04 });
  const radial = (d: Vec3): number => {
    const big = noise.fractal(d[0] * 1.2 + off[0], d[1] * 1.2 + off[1], d[2] * 1.2 + off[2], {
      octaves: 3,
      gain: 0.5,
    });
    const ridges = noise.fractal(d[0] * 2.6 + off[1], d[1] * 2.6 + off[2], d[2] * 2.6 + off[0], {
      octaves: 3,
      gain: 0.5,
      type: 'RIDGED',
    });
    const fine = noise.fractal(d[0] * 7 + off[2], d[1] * 7 + off[0], d[2] * 7 + off[1], { octaves: 2, gain: 0.5 });
    let r = 1 + rough * (0.55 * big + 0.16 * ridges + 0.05 * fine);
    r = Math.max(0.35, r);
    for (const pl of planes) {
      const along = pl.n[0] * d[0] + pl.n[1] * d[1] + pl.n[2] * d[2];
      if (along > 1e-6) r = smoothMinRadius(r, pl.d / along, pl.k);
    }
    return Math.max(0.2, r);
  };
  const b = new MeshBuilder();
  addIcoSphere(b, [0, 0, 0], [size[0] / 2, size[1] / 2, size[2] / 2], detail, {
    mat: 0,
    smooth: detail > 2,
    displace: radial,
  });
  const mesh = b.build();
  placeMesh(mesh, { ground: true, centerXY: true });
  markSharpEdges(mesh, 0.8);
  // icosphere UVs are spherical; a box projection (metres) reads better on faceted rock
  mesh.uvs = mesh.faces.map((f) => boxProjectUV(mesh.positions, f));
  return { mesh, materials: [MATERIALS.rock] };
}
