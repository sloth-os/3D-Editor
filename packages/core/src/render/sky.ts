import type { Vec3 } from '../math/types';
import type { WorldSettings } from '../doc/types';

/*
 * Analytic procedural sky (world environment 'SKY'), shared by every renderer: the CPU rasterizer,
 * the path tracer, the viewport (as an equirectangular environment map) and the glTF exporter.
 *
 * Model (radiance in linear RGB, before the world `strength`):
 * - the sky colours (`sky_zenith_color`, `sky_horizon_color`, `sky_ground_color`) describe a clear
 *   midday sky; zenith and horizon are blended with √(elevation) of the view direction, the ground
 *   (below the horizon) fades from a hazy horizon colour into the ground colour;
 * - the sun elevation drives the overall daylight (night ≈ 2 %), twilight warmth (orange horizon,
 *   deeper blue zenith) and a horizon glow towards the sun;
 * - sunlight is reddened by atmospheric extinction (optical depth ∝ air mass, Rayleigh-like
 *   λ-dependence), which colours the sun disc, its forward-scattering halo and the low-sun glow;
 * - the sun disc (angular diameter `sun_size`) with limb darkening has a radiance normalised so
 *   that it delivers `sun_intensity` W/m² (× sun colour × extinction) at normal incidence — the
 *   same unit as a SUN lamp's `energy`, which is how renderers without area sampling light with it.
 */

/**
 * Unit direction towards the sun (world space, Z up) from `sun_elevation` (radians above the
 * horizon) and `sun_rotation` (azimuth in radians, counter-clockwise seen from above, measured from
 * the −Y axis): rotation 0 puts the sun towards −Y (behind the camera of Blender's front view),
 * π/2 towards +X, π towards +Y.
 */
export function sunDirection(world: Pick<WorldSettings, 'sun_elevation' | 'sun_rotation'>): Vec3 {
  const ce = Math.cos(world.sun_elevation);
  return [
    ce * Math.sin(world.sun_rotation),
    -ce * Math.cos(world.sun_rotation),
    Math.sin(world.sun_elevation),
  ];
}

/** Limb darkening coefficient of the sun disc (linear law); mean intensity is 1 − u/3. */
const LIMB = 0.6;
/** Optical depth of the clear atmosphere at the zenith per channel (Rayleigh-like). */
const TAU: Vec3 = [0.012, 0.03, 0.07];
/** Twilight zenith tint and the night-time floor of the sky brightness. */
const TWILIGHT_ZENITH: Vec3 = [0.55, 0.62, 0.9];
const NIGHT = 0.02;

/** Precomputed sky for fast repeated sampling (see `prepareSky`). */
export interface SkyModel {
  /** Unit direction towards the sun. */
  sun: Vec3;
  /** Horizontal unit direction of the sun (−Y when it is at the zenith). */
  sunH: [number, number];
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  /** Horizon glow towards the sun (radiance at the horizon in the sun's azimuth). */
  glow: Vec3;
  /** Forward-scattering halo scale (radiance next to the sun). */
  halo: Vec3;
  /** Sun disc radiance at its centre. */
  sunRadiance: Vec3;
  /** Angular radius of the disc and its cosine. */
  sunRadius: number;
  cosSunRadius: number;
  /** Irradiance (W/m², per channel) of the sun disc at normal incidence, before horizon occlusion. */
  sunIrradiance: Vec3;
  /** Fraction of the disc above the horizon (0..1). */
  sunVisible: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function col(v: unknown, fallback: Readonly<Vec3>): Vec3 {
  const a = Array.isArray(v) ? v : [];
  return [
    Math.max(0, num(a[0], fallback[0])),
    Math.max(0, num(a[1], fallback[1])),
    Math.max(0, num(a[2], fallback[2])),
  ];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

/** Atmospheric transmittance of direct sunlight at a sun height (sine of the elevation). */
export function sunTransmittance(sinElevation: number): Vec3 {
  const airMass = 1 / (Math.max(0, sinElevation) + 0.04);
  return [Math.exp(-TAU[0] * airMass), Math.exp(-TAU[1] * airMass), Math.exp(-TAU[2] * airMass)];
}

const lum = (c: Readonly<Vec3>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Precomputes the sky of a world (invalid values fall back to the defaults). Pure. */
export function prepareSky(world: Partial<WorldSettings>): SkyModel {
  const el = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, num(world.sun_elevation, (35 * Math.PI) / 180)));
  const rot = num(world.sun_rotation, Math.PI / 4);
  const sun = sunDirection({ sun_elevation: el, sun_rotation: rot });
  const hl = Math.hypot(sun[0], sun[1]);
  const sunH: [number, number] = hl > 1e-9 ? [sun[0] / hl, sun[1] / hl] : [0, -1];
  const s = sun[2];
  const T = sunTransmittance(s);
  const sunColor = col(world.sun_color, [1, 0.95, 0.88]);
  const intensity = Math.max(0, num(world.sun_intensity, 3));
  const radius = Math.min(0.5, Math.max(1e-4, num(world.sun_size, (0.545 * Math.PI) / 180) / 2));
  const cosR = Math.cos(radius);
  // effective sunlight colour and its chromaticity (warm when the sun is low)
  const lit: Vec3 = [sunColor[0] * T[0], sunColor[1] * T[1], sunColor[2] * T[2]];
  const litMax = Math.max(lit[0], lit[1], lit[2], 1e-9);
  const warm: Vec3 = [lit[0] / litMax, lit[1] / litMax, lit[2] / litMax];
  const day = NIGHT + (1 - NIGHT) * smoothstep(-0.12, 0.3, s);
  const twilight = smoothstep(-0.2, -0.02, s) * (1 - smoothstep(0, 0.4, s));
  const zen = col(world.sky_zenith_color, [0.12, 0.28, 0.65]);
  const hor = col(world.sky_horizon_color, [0.62, 0.74, 0.88]);
  const gnd = col(world.sky_ground_color, [0.18, 0.16, 0.14]);
  const horL = lum(hor);
  const zenith: Vec3 = [0, 0, 0];
  const horizon: Vec3 = [0, 0, 0];
  const ground: Vec3 = [0, 0, 0];
  const glow: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    zenith[i] = zen[i] * (1 + twilight * (TWILIGHT_ZENITH[i] - 1)) * day;
    const warmHorizon = horL * (0.35 + 0.65 * warm[i]);
    horizon[i] = (hor[i] + 0.6 * twilight * (warmHorizon - hor[i])) * day;
    ground[i] = gnd[i] * (1 + 0.3 * twilight * (warm[i] - 1)) * day;
    glow[i] = 2.5 * twilight * horL * warm[i] * warm[i] * Math.max(day, 0.15);
  }
  const visible = Math.max(0, Math.min(1, (el + radius) / (2 * radius)));
  const solidAngle = 2 * Math.PI * (1 - cosR);
  const discNorm = 1 / (solidAngle * (1 - LIMB / 3));
  const sunIrradiance: Vec3 = [intensity * lit[0], intensity * lit[1], intensity * lit[2]];
  // forward scattering is only lit while (part of) the sun is up
  const haloK = smoothstep(-0.08, 0.02, s);
  return {
    sun,
    sunH,
    zenith,
    horizon,
    ground,
    glow,
    halo: [sunIrradiance[0] * haloK, sunIrradiance[1] * haloK, sunIrradiance[2] * haloK],
    sunRadiance: [sunIrradiance[0] * discNorm, sunIrradiance[1] * discNorm, sunIrradiance[2] * discNorm],
    sunRadius: radius,
    cosSunRadius: cosR,
    sunIrradiance,
    sunVisible: visible,
  };
}

/**
 * Radiance of a prepared sky along a unit direction (x, y, z) into `out` (before `strength`).
 * `sun` adds the sun disc (point-sampled; renderers that light with the sun separately pass false).
 */
export function sampleSkyModel(
  m: SkyModel,
  x: number,
  y: number,
  z: number,
  sun: boolean,
  out: Float64Array | number[],
): void {
  const h = z;
  // extras: horizon glow towards the sun and the forward-scattering halo
  const hl = Math.hypot(x, y);
  const az = hl > 1e-9 ? (x * m.sunH[0] + y * m.sunH[1]) / hl : 0;
  const a = 0.5 + 0.5 * az;
  const glowK = a * a * a * Math.exp(-Math.abs(h) * 4);
  const cosG = x * m.sun[0] + y * m.sun[1] + z * m.sun[2];
  let haloK = 0;
  if (cosG > 0) {
    const c2 = cosG * cosG;
    const c4 = c2 * c2;
    const c8 = c4 * c4;
    const c16 = c8 * c8;
    const c64 = c16 * c16 * c16 * c16;
    haloK = 0.02 * c8 + 0.12 * c64;
  }
  let r: number;
  let g: number;
  let b: number;
  if (h >= 0) {
    const t = Math.sqrt(h);
    r = m.horizon[0] + t * (m.zenith[0] - m.horizon[0]) + glowK * m.glow[0] + haloK * m.halo[0];
    g = m.horizon[1] + t * (m.zenith[1] - m.horizon[1]) + glowK * m.glow[1] + haloK * m.halo[1];
    b = m.horizon[2] + t * (m.zenith[2] - m.horizon[2]) + glowK * m.glow[2] + haloK * m.halo[2];
    if (sun && cosG >= m.cosSunRadius) {
      const gamma = Math.acos(Math.min(1, cosG));
      const q = gamma / m.sunRadius;
      const limb = 1 - LIMB * (1 - Math.sqrt(Math.max(0, 1 - q * q)));
      r += m.sunRadiance[0] * limb;
      g += m.sunRadiance[1] * limb;
      b += m.sunRadiance[2] * limb;
    }
  } else {
    // looking down: hazy horizon fading into the ground; the extras fade out with it
    const t = 1 - Math.exp(h * 10);
    const k = 1 - t;
    r = m.horizon[0] + t * (m.ground[0] - m.horizon[0]) + k * (glowK * m.glow[0] + haloK * m.halo[0]);
    g = m.horizon[1] + t * (m.ground[1] - m.horizon[1]) + k * (glowK * m.glow[1] + haloK * m.halo[1]);
    b = m.horizon[2] + t * (m.ground[2] - m.horizon[2]) + k * (glowK * m.glow[2] + haloK * m.halo[2]);
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

/**
 * Radiance of a prepared sky for an image pixel looking along the unit direction (x, y, z) whose
 * footprint has angular radius `pixelRadius` (radians, 0 = point sample): like `sampleSkyModel`
 * with the sun, but the disc edge is anti-aliased and a disc smaller than the pixel keeps its energy
 * (spread over the pixel) instead of flickering in and out.
 */
export function sampleSkyPixel(
  m: SkyModel,
  x: number,
  y: number,
  z: number,
  pixelRadius: number,
  out: Float64Array | number[],
): void {
  sampleSkyModel(m, x, y, z, false, out);
  if (z < 0) return;
  const R = m.sunRadius;
  const rho = pixelRadius > 0 ? pixelRadius : 0;
  const cosG = x * m.sun[0] + y * m.sun[1] + z * m.sun[2];
  if (cosG < Math.cos(Math.min(Math.PI, R + rho))) return;
  const gamma = Math.acos(Math.min(1, cosG));
  let k: number;
  if (rho <= 0) {
    if (gamma > R) return;
    const q = gamma / R;
    k = 1 - LIMB * (1 - Math.sqrt(Math.max(0, 1 - q * q)));
  } else if (R >= rho) {
    const q = Math.min(1, gamma / R);
    const limb = 1 - LIMB * (1 - Math.sqrt(Math.max(0, 1 - q * q)));
    k = limb * Math.max(0, Math.min(1, (R + rho - gamma) / (2 * rho)));
  } else {
    // unresolved disc: its (mean) radiance spread over the pixel footprint
    k = (1 - LIMB / 3) * ((R * R) / (rho * rho)) * Math.max(0, Math.min(1, (R + rho - gamma) / (2 * R)));
  }
  out[0] += m.sunRadiance[0] * k;
  out[1] += m.sunRadiance[1] * k;
  out[2] += m.sunRadiance[2] * k;
}

/**
 * Single-entry cache of the last prepared world, validated by content on every call without
 * allocating (renderers call `sampleSky` per ray): the 16 numbers `prepareSky` reads.
 */
const cacheKey: unknown[] = new Array<unknown>(16).fill(NaN);
let cacheModel: SkyModel | null = null;

function sameColour(c: unknown, o: number): boolean {
  const k = cacheKey;
  return Array.isArray(c)
    ? k[o] === c[0] && k[o + 1] === c[1] && k[o + 2] === c[2]
    : k[o] === c && k[o + 1] === undefined && k[o + 2] === undefined;
}

function storeColour(c: unknown, o: number): void {
  const a = Array.isArray(c) ? c : null;
  cacheKey[o] = a ? a[0] : c;
  cacheKey[o + 1] = a ? a[1] : undefined;
  cacheKey[o + 2] = a ? a[2] : undefined;
}

function cachedModel(w: WorldSettings): SkyModel {
  const k = cacheKey;
  if (
    cacheModel &&
    k[0] === w.sun_elevation &&
    k[1] === w.sun_rotation &&
    k[2] === w.sun_intensity &&
    k[3] === w.sun_size &&
    sameColour(w.sun_color, 4) &&
    sameColour(w.sky_zenith_color, 7) &&
    sameColour(w.sky_horizon_color, 10) &&
    sameColour(w.sky_ground_color, 13)
  )
    return cacheModel;
  cacheModel = prepareSky(w);
  k[0] = w.sun_elevation;
  k[1] = w.sun_rotation;
  k[2] = w.sun_intensity;
  k[3] = w.sun_size;
  storeColour(w.sun_color, 4);
  storeColour(w.sky_zenith_color, 7);
  storeColour(w.sky_horizon_color, 10);
  storeColour(w.sky_ground_color, 13);
  return cacheModel;
}

/**
 * Background radiance (linear RGB, before `strength`) seen along a world-space direction, for the
 * procedural sky (environment 'SKY'): zenith/horizon/ground gradient plus a sun disc. Used by the
 * software renderers and the viewport so every renderer shows the same sky. The direction need not
 * be normalised (a zero/invalid direction returns the horizon colour). Pass `{ sun: false }` to
 * omit the sun disc when the sun is lit separately (see `skySun`).
 */
export function sampleSky(world: WorldSettings, dir: Readonly<Vec3>, opts: { sun?: boolean } = {}): Vec3 {
  const m = cachedModel(world);
  let x = dir[0];
  let y = dir[1];
  let z = dir[2];
  const l = Math.hypot(x, y, z);
  if (!(l > 0) || !Number.isFinite(l)) {
    x = 1;
    y = 0;
    z = 0;
  } else {
    x /= l;
    y /= l;
    z /= l;
  }
  const out: Vec3 = [0, 0, 0];
  sampleSkyModel(m, x, y, z, opts.sun !== false, out);
  return out;
}

/** The sky's sun as a directional light. */
export interface SkySun {
  /** Unit direction towards the sun. */
  direction: Vec3;
  /** Irradiance in W/m² per channel at normal incidence (extinction and horizon occlusion applied). */
  irradiance: Vec3;
  /** Angular radius in radians (soft shadows). */
  angularRadius: number;
  /** False when the sun is below the horizon (irradiance 0). */
  visible: boolean;
}

/** The sun of a SKY world as a directional light (before the world `strength`). */
export function skySun(world: WorldSettings): SkySun {
  const m = cachedModel(world);
  const v = m.sunVisible;
  return {
    direction: [...m.sun] as Vec3,
    irradiance: [m.sunIrradiance[0] * v, m.sunIrradiance[1] * v, m.sunIrradiance[2] * v],
    angularRadius: m.sunRadius,
    visible: v > 0,
  };
}

/**
 * Equirectangular image of the sky (linear RGB float triplets, row-major, top row first, before
 * `strength`). Row 0 is the zenith (+Z) and the last row the nadir; column x has azimuth
 * φ = π − 2π(x + ½)/width measured from +X towards +Y, i.e. the image centre looks along +X and
 * u = ¼ along +Y — Blender's and three.js's equirect layout once the environment is rotated Z-up.
 *
 * With `sun` (default true) the sun disc is included; a disc smaller than ~1.5 texels is widened
 * and its radiance renormalised so the image still delivers exactly the sun's irradiance.
 */
export function skyEquirect(
  world: WorldSettings,
  width: number,
  height: number,
  opts: { sun?: boolean } = {},
): Float32Array {
  const w = Math.max(1, Math.floor(num(width, 1)));
  const h = Math.max(1, Math.floor(num(height, 1)));
  const m = prepareSky(world);
  const out = new Float32Array(w * h * 3);
  const px = new Float64Array(3);
  const dirs = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const el = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
    const ce = Math.cos(el);
    const se = Math.sin(el);
    for (let x = 0; x < w; x++) {
      const phi = Math.PI - (2 * Math.PI * (x + 0.5)) / w;
      const dx = ce * Math.cos(phi);
      const dy = ce * Math.sin(phi);
      const i = y * w + x;
      dirs[i * 3] = dx;
      dirs[i * 3 + 1] = dy;
      dirs[i * 3 + 2] = se;
      sampleSkyModel(m, dx, dy, se, false, px);
      out[i * 3] = px[0];
      out[i * 3 + 1] = px[1];
      out[i * 3 + 2] = px[2];
    }
  }
  if (opts.sun === false || !(m.sunIrradiance[0] + m.sunIrradiance[1] + m.sunIrradiance[2] > 0)) return out;
  // energy-preserving sun disc: weights over the (possibly widened) disc, normalised so that
  // Σ L·ω equals the sun irradiance; texels below the horizon count for the normalisation only
  const R = Math.max(m.sunRadius, 1.5 * (Math.PI / h));
  const cosR = Math.cos(R);
  const dPhi = (2 * Math.PI) / w;
  const weights: number[] = [];
  const texels: number[] = [];
  let sum = 0;
  for (let y = 0; y < h; y++) {
    const top = Math.PI / 2 - (y / h) * Math.PI;
    const bottom = Math.PI / 2 - ((y + 1) / h) * Math.PI;
    const omega = dPhi * (Math.sin(top) - Math.sin(bottom));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = dirs[i * 3] * m.sun[0] + dirs[i * 3 + 1] * m.sun[1] + dirs[i * 3 + 2] * m.sun[2];
      if (c < cosR) continue;
      const q = Math.acos(Math.min(1, c)) / R;
      const wt = 1 - LIMB * (1 - Math.sqrt(Math.max(0, 1 - q * q)));
      sum += wt * omega;
      if (dirs[i * 3 + 2] >= 0) {
        texels.push(i);
        weights.push(wt);
      }
    }
  }
  if (!(sum > 0)) return out;
  for (let k = 0; k < texels.length; k++) {
    const i = texels[k];
    const f = weights[k] / sum;
    out[i * 3] += m.sunIrradiance[0] * f;
    out[i * 3 + 1] += m.sunIrradiance[1] * f;
    out[i * 3 + 2] += m.sunIrradiance[2] * f;
  }
  return out;
}

/**
 * Diffuse sky lighting as 9 spherical-harmonic coefficients per channel (27 numbers, [coef][rgb]),
 * convolved with the clamped cosine and divided by π: `evalSkyIrradiance` then returns E(n)/π, the
 * radiance a white Lambertian surface with normal n reflects (sun disc excluded, before `strength`).
 */
export function skyIrradianceSH(world: WorldSettings, resolution = 48): Float64Array {
  const m = prepareSky(world);
  const w = Math.max(8, Math.floor(resolution) * 2);
  const h = Math.max(4, Math.floor(resolution));
  const L = new Float64Array(27);
  const px = new Float64Array(3);
  const dPhi = (2 * Math.PI) / w;
  for (let y = 0; y < h; y++) {
    const top = Math.PI / 2 - (y / h) * Math.PI;
    const bottom = Math.PI / 2 - ((y + 1) / h) * Math.PI;
    const omega = dPhi * (Math.sin(top) - Math.sin(bottom));
    const el = (top + bottom) / 2;
    const ce = Math.cos(el);
    const z = Math.sin(el);
    for (let xi = 0; xi < w; xi++) {
      const phi = -Math.PI + (xi + 0.5) * dPhi;
      const x = ce * Math.cos(phi);
      const yy = ce * Math.sin(phi);
      sampleSkyModel(m, x, yy, z, false, px);
      const basis = shBasis(x, yy, z);
      for (let k = 0; k < 9; k++) {
        const b = basis[k] * omega;
        L[k * 3] += px[0] * b;
        L[k * 3 + 1] += px[1] * b;
        L[k * 3 + 2] += px[2] * b;
      }
    }
  }
  // cosine-lobe convolution (π, 2π/3, π/4 per band), then / π
  const A = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];
  for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) L[k * 3 + c] *= A[k];
  return L;
}

const shScratch = new Float64Array(9);

function shBasis(x: number, y: number, z: number): Float64Array {
  const b = shScratch;
  b[0] = 0.282095;
  b[1] = 0.488603 * y;
  b[2] = 0.488603 * z;
  b[3] = 0.488603 * x;
  b[4] = 1.092548 * x * y;
  b[5] = 1.092548 * y * z;
  b[6] = 0.315392 * (3 * z * z - 1);
  b[7] = 1.092548 * x * z;
  b[8] = 0.546274 * (x * x - y * y);
  return b;
}

/** Evaluates `skyIrradianceSH` coefficients for a unit normal into `out` (clamped at 0). */
export function evalSkyIrradiance(
  sh: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  out: Float64Array | number[],
): void {
  const b = shBasis(nx, ny, nz);
  let r = 0;
  let g = 0;
  let bl = 0;
  for (let k = 0; k < 9; k++) {
    r += sh[k * 3] * b[k];
    g += sh[k * 3 + 1] * b[k];
    bl += sh[k * 3 + 2] * b[k];
  }
  out[0] = r > 0 ? r : 0;
  out[1] = g > 0 ? g : 0;
  out[2] = bl > 0 ? bl : 0;
}
