import type { Vec3 } from '../../math/types';
import type { WorldSettings } from '../../doc/types';
import type { SampledTexture } from '../raster';
import { prepareSky, sampleSkyModel, skySun, type SkyModel } from '../sky';
import {
  buildDistribution2D,
  distribution2DPdf,
  sampleDistribution2D,
  type Distribution2D,
} from './distribution';

/*
 * World lighting for the path tracer.
 *
 * environment  lighting radiance (× world strength)
 * NONE         world colour, uniform
 * STUDIO       procedural photo studio (soft gradient room, key/fill/rim/top softboxes)
 *              × environment_strength, rotated by environment_rotation about +Z
 * SKY          procedural sky (render/sky.ts) × environment_strength; its sun disc is lit as an
 *              explicit sun lamp (see `skySunLamp`) and only drawn on the camera background
 * IMAGE        equirectangular image × environment_strength, rotated by environment_rotation
 *
 * Equirectangular images follow Cycles: u = 0.5 − atan2(y, x) / 2π (the image centre faces +X),
 * v = 0.5 + asin(z) / π (top row = zenith).
 *
 * Importance sampling: a piecewise-constant table over (u, v) (STUDIO, SKY, IMAGE) mixed with a
 * small uniform-sphere share, as one mixture pdf.
 */

export const ENV_UNIFORM = 0;
export const ENV_STUDIO = 1;
export const ENV_SKY = 2;
export const ENV_IMAGE = 3;

/** Plain environment description (part of the compiled scene). */
export interface EnvironmentData {
  kind: number;
  /** Uniform radiance (ENV_UNIFORM). */
  color: Vec3;
  /** Multiplier of the studio / sky / image radiance. */
  scale: number;
  /** Rotation about +Z in radians (studio and image). */
  rotation: number;
  /** Prepared procedural sky (ENV_SKY). */
  sky: SkyModel | null;
  image: SampledTexture | null;
  table: Distribution2D | null;
  wTable: number;
  wUniform: number;
  /** ∫ luminance dω over the sphere (W/m²/sr · sr), for light selection. */
  power: number;
  /** Emits nothing at all. */
  black: boolean;
}

const SRGB_LUT = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ------------------------------------------------------------------ studio

interface Softbox {
  cx: number;
  cy: number;
  cz: number;
  ux: number;
  uy: number;
  uz: number;
  vx: number;
  vy: number;
  vz: number;
  tanU: number;
  tanV: number;
  radiance: number;
}

function softbox(azimuthDeg: number, elevationDeg: number, halfU: number, halfV: number, L: number): Softbox {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const c: Vec3 = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  // u: horizontal tangent, v: completes the frame (points "up" along the sphere)
  let u: Vec3 = [-Math.sin(az), Math.cos(az), 0];
  if (Math.abs(c[2]) > 0.999) u = [1, 0, 0];
  const v: Vec3 = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
  return {
    cx: c[0],
    cy: c[1],
    cz: c[2],
    ux: u[0],
    uy: u[1],
    uz: u[2],
    vx: v[0],
    vy: v[1],
    vz: v[2],
    tanU: Math.tan((halfU * Math.PI) / 180),
    tanV: Math.tan((halfV * Math.PI) / 180),
    radiance: L,
  };
}

/** Studio light panels: key (front left, high), fill (front right, low), rim (back), top. */
const SOFTBOXES: Softbox[] = [
  softbox(225, 45, 28, 18, 7),
  softbox(315, 15, 22, 22, 1.6),
  softbox(80, 30, 35, 8, 5),
  softbox(0, 90, 18, 18, 2.5),
];
/** Overall level: the studio acts as a soft fill (average radiance ≈ 0.35 at strength 1). */
const STUDIO_SCALE = 0.4;

/** Radiance (grey) of the procedural studio in its local frame (Z up). */
export function studioRadiance(x: number, y: number, z: number): number {
  let L: number;
  if (z >= 0) L = 0.1 + 0.14 * Math.sqrt(z);
  else L = 0.07 - 0.035 * Math.sqrt(-z);
  for (let i = 0; i < SOFTBOXES.length; i++) {
    const b = SOFTBOXES[i];
    const a = x * b.cx + y * b.cy + z * b.cz;
    if (a <= 0.1) continue;
    const pu = (x * b.ux + y * b.uy + z * b.uz) / (a * b.tanU);
    const pv = (x * b.vx + y * b.vy + z * b.vz) / (a * b.tanV);
    const q2 = pu * pu * pu * pu + pv * pv * pv * pv;
    if (q2 >= 1) continue;
    const q = Math.sqrt(Math.sqrt(q2));
    // soft edge between 85% and 100% of the panel size
    const t = q <= 0.85 ? 1 : (1 - q) / 0.15;
    L += b.radiance * t * t * (3 - 2 * t);
  }
  return L * STUDIO_SCALE;
}

// ------------------------------------------------------------------ construction

/** Direction (world, unit) of an equirectangular coordinate before rotation. */
function equirectDir(u: number, v: number, out: Float64Array): void {
  const phi = 2 * Math.PI * (0.5 - u);
  const el = Math.PI * (v - 0.5);
  const c = Math.cos(el);
  out[0] = c * Math.cos(phi);
  out[1] = c * Math.sin(phi);
  out[2] = Math.sin(el);
}

export interface EnvironmentInput {
  world: WorldSettings;
  /** Decoded environment image (IMAGE), or null when missing / undecodable. */
  image: SampledTexture | null;
}

/** Builds the environment description (importance table) from the world settings. */
export function buildEnvironment(input: EnvironmentInput, warnings: string[]): EnvironmentData {
  const world = input.world;
  const strength = finiteNonNeg(world.strength, 1);
  const envStrength = finiteNonNeg(world.environment_strength, 1);
  const color: Vec3 = [
    finiteNonNeg(world.color?.[0], 0) * strength,
    finiteNonNeg(world.color?.[1], 0) * strength,
    finiteNonNeg(world.color?.[2], 0) * strength,
  ];
  const rotation = Number.isFinite(world.environment_rotation) ? world.environment_rotation : 0;
  const env: EnvironmentData = {
    kind: ENV_UNIFORM,
    color,
    scale: strength * envStrength,
    rotation,
    sky: null,
    image: null,
    table: null,
    wTable: 0,
    wUniform: 1,
    power: 4 * Math.PI * lum(color[0], color[1], color[2]),
    black: false,
  };
  let kind = world.environment;
  if (kind === 'IMAGE' && !input.image) {
    if (world.environment_image)
      warnings.push(
        `Environment image '${world.environment_image}' could not be decoded; using the world colour`,
      );
    kind = 'NONE';
  }
  const dir = new Float64Array(3);
  const rgb = new Float64Array(3);
  let tw = 0;
  let th = 0;
  let evalLum: ((u: number, v: number) => number) | null = null;
  if (kind === 'STUDIO') {
    env.kind = ENV_STUDIO;
    tw = 128;
    th = 64;
    evalLum = (u, v) => {
      equirectDir(u, v, dir);
      return studioRadiance(dir[0], dir[1], dir[2]);
    };
  } else if (kind === 'SKY') {
    env.kind = ENV_SKY;
    const sky = prepareSky(world);
    env.sky = sky;
    tw = 256;
    th = 128;
    evalLum = (u, v) => {
      equirectDir(u, v, dir);
      sampleSkyModel(sky, dir[0], dir[1], dir[2], false, rgb);
      return lum(rgb[0], rgb[1], rgb[2]);
    };
  } else if (kind === 'IMAGE' && input.image) {
    env.kind = ENV_IMAGE;
    env.image = input.image;
    const img = input.image;
    tw = Math.max(1, Math.min(512, img.width));
    th = Math.max(1, Math.min(256, img.height));
  }
  if (env.kind === ENV_UNIFORM) {
    env.black = !(env.power > 0);
    return env;
  }
  // --- importance table over (u, v); rows from v = 0 (nadir) to 1 (zenith)
  const func = new Float32Array(tw * th);
  if (env.kind === ENV_IMAGE) {
    const img = env.image!;
    const W = img.width;
    const H = img.height;
    const d = img.data;
    for (let j = 0; j < th; j++) {
      // table row j covers v in [j/th, (j+1)/th) → image rows from the top
      const y0 = Math.floor((1 - (j + 1) / th) * H);
      const y1 = Math.max(y0 + 1, Math.floor((1 - j / th) * H));
      const ce = Math.cos(Math.PI * ((j + 0.5) / th - 0.5));
      for (let i = 0; i < tw; i++) {
        const x0 = Math.floor((i / tw) * W);
        const x1 = Math.max(x0 + 1, Math.floor(((i + 1) / tw) * W));
        let s = 0;
        let n = 0;
        for (let y = y0; y < y1 && y < H; y++)
          for (let x = x0; x < x1 && x < W; x++) {
            const o = (y * W + x) * 4;
            s += lum(SRGB_LUT[d[o]], SRGB_LUT[d[o + 1]], SRGB_LUT[d[o + 2]]);
            n++;
          }
        func[j * tw + i] = (n ? s / n : 0) * ce;
      }
    }
  } else {
    for (let j = 0; j < th; j++) {
      const ce = Math.cos(Math.PI * ((j + 0.5) / th - 0.5));
      for (let i = 0; i < tw; i++) {
        // 2×2 supersampling per cell
        let s = 0;
        for (let a = 0; a < 2; a++)
          for (let b = 0; b < 2; b++) s += evalLum!((i + 0.25 + 0.5 * a) / tw, (j + 0.25 + 0.5 * b) / th);
        func[j * tw + i] = Math.max(0, s / 4) * ce;
      }
    }
  }
  const table = buildDistribution2D(func, tw, th);
  env.table = table.integral > 0 ? table : null;
  env.power = table.integral * 2 * Math.PI * Math.PI * env.scale;
  env.black = !(env.power > 0);
  if (env.table) {
    env.wUniform = 0.02;
    env.wTable = 1 - env.wUniform;
  }
  return env;
}

/**
 * The sun of a SKY world as a sun lamp (direction, angular radius, uniform disc radiance giving the
 * sky's sun irradiance × strength), or null when it is below the horizon or the world is no sky.
 */
export function skySunLamp(
  world: WorldSettings,
): { direction: Vec3; halfAngle: number; irradiance: Vec3 } | null {
  if (world.environment !== 'SKY') return null;
  const scale = finiteNonNeg(world.strength, 1) * finiteNonNeg(world.environment_strength, 1);
  const s = skySun(world);
  const e: Vec3 = [s.irradiance[0] * scale, s.irradiance[1] * scale, s.irradiance[2] * scale];
  if (!s.visible || !(e[0] + e[1] + e[2] > 0) || !e.every(Number.isFinite)) return null;
  return { direction: s.direction, halfAngle: s.angularRadius, irradiance: e };
}

function finiteNonNeg(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : fallback;
}

// ------------------------------------------------------------------ runtime

/** Environment evaluation and sampling with scratch outputs (no allocations). */
export class Environment {
  r = 0;
  g = 0;
  b = 0;
  /** Sampled direction (world) and its pdf (solid angle). */
  dx = 0;
  dy = 0;
  dz = 1;
  pdfValue = 0;
  private readonly cosR: number;
  private readonly sinR: number;
  private readonly uv = new Float64Array(2);
  private readonly dir = new Float64Array(3);
  private readonly rgb = new Float64Array(3);

  constructor(readonly data: EnvironmentData) {
    this.cosR = Math.cos(data.rotation);
    this.sinR = Math.sin(data.rotation);
  }

  /**
   * Radiance arriving from world direction d (unit) into r/g/b. `background` includes what only
   * the camera sees directly (the procedural sky's sun disc, which is lit as a lamp otherwise).
   */
  eval(dx: number, dy: number, dz: number, background = false): void {
    const e = this.data;
    switch (e.kind) {
      case ENV_UNIFORM:
        this.r = e.color[0];
        this.g = e.color[1];
        this.b = e.color[2];
        return;
      case ENV_STUDIO: {
        const L =
          studioRadiance(this.cosR * dx + this.sinR * dy, -this.sinR * dx + this.cosR * dy, dz) * e.scale;
        this.r = L;
        this.g = L;
        this.b = L;
        return;
      }
      case ENV_SKY: {
        const c = this.rgb;
        sampleSkyModel(e.sky!, dx, dy, dz, background, c);
        this.r = finiteNonNeg(c[0], 0) * e.scale;
        this.g = finiteNonNeg(c[1], 0) * e.scale;
        this.b = finiteNonNeg(c[2], 0) * e.scale;
        return;
      }
      default: {
        // equirectangular image, bilinear
        const lx = this.cosR * dx + this.sinR * dy;
        const ly = -this.sinR * dx + this.cosR * dy;
        const u = 0.5 - Math.atan2(ly, lx) / (2 * Math.PI);
        const v = 0.5 + Math.asin(Math.max(-1, Math.min(1, dz))) / Math.PI;
        this.lookupImage(u, v, e.scale);
      }
    }
  }

  private lookupImage(u: number, v: number, scale: number): void {
    const img = this.data.image!;
    const W = img.width;
    const H = img.height;
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      this.r = this.g = this.b = 0;
      return;
    }
    const fx = u * W - 0.5;
    const fy = Math.min(H - 1, Math.max(0, (1 - v) * H - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    const xa = ((x0 % W) + W) % W;
    const xb = xa + 1 === W ? 0 : xa + 1;
    const ya = y0;
    const yb = Math.min(H - 1, y0 + 1);
    const d = img.data;
    const i00 = (ya * W + xa) * 4;
    const i10 = (ya * W + xb) * 4;
    const i01 = (yb * W + xa) * 4;
    const i11 = (yb * W + xb) * 4;
    const w00 = (1 - ax) * (1 - ay) * scale;
    const w10 = ax * (1 - ay) * scale;
    const w01 = (1 - ax) * ay * scale;
    const w11 = ax * ay * scale;
    const L = SRGB_LUT;
    this.r = L[d[i00]] * w00 + L[d[i10]] * w10 + L[d[i01]] * w01 + L[d[i11]] * w11;
    this.g = L[d[i00 + 1]] * w00 + L[d[i10 + 1]] * w10 + L[d[i01 + 1]] * w01 + L[d[i11 + 1]] * w11;
    this.b = L[d[i00 + 2]] * w00 + L[d[i10 + 2]] * w10 + L[d[i01 + 2]] * w01 + L[d[i11 + 2]] * w11;
  }

  /** Solid-angle density of `sample` for a world direction. */
  pdf(dx: number, dy: number, dz: number): number {
    const e = this.data;
    let p = e.wUniform / (4 * Math.PI);
    if (e.table && e.wTable > 0) {
      const lx = this.cosR * dx + this.sinR * dy;
      const ly = -this.sinR * dx + this.cosR * dy;
      const u = 0.5 - Math.atan2(ly, lx) / (2 * Math.PI);
      const v = 0.5 + Math.asin(Math.max(-1, Math.min(1, dz))) / Math.PI;
      const ce = Math.sqrt(Math.max(0, 1 - dz * dz));
      if (ce > 1e-7) p += (e.wTable * distribution2DPdf(e.table, u, v)) / (2 * Math.PI * Math.PI * ce);
    }
    return p;
  }

  /**
   * Samples a direction (dx/dy/dz) with its mixture pdf (pdfValue) and radiance (r/g/b).
   * Returns false if nothing was sampled.
   */
  sample(u0: number, u1: number, uStrategy: number): boolean {
    const e = this.data;
    if (e.black) return false;
    let x: number;
    let y: number;
    let z: number;
    if (uStrategy < e.wTable && e.table) {
      if (!(sampleDistribution2D(e.table, u0, u1, this.uv) > 0)) return false;
      equirectDir(this.uv[0], this.uv[1], this.dir);
      // env-local → world (rotate by +rotation)
      const lx = this.dir[0];
      const ly = this.dir[1];
      x = this.cosR * lx - this.sinR * ly;
      y = this.sinR * lx + this.cosR * ly;
      z = this.dir[2];
    } else {
      z = 1 - 2 * u0;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = 2 * Math.PI * u1;
      x = r * Math.cos(phi);
      y = r * Math.sin(phi);
    }
    const l = Math.hypot(x, y, z) || 1;
    x /= l;
    y /= l;
    z /= l;
    this.dx = x;
    this.dy = y;
    this.dz = z;
    this.pdfValue = this.pdf(x, y, z);
    if (!(this.pdfValue > 0)) return false;
    this.eval(x, y, z);
    return this.r + this.g + this.b > 0;
  }
}
