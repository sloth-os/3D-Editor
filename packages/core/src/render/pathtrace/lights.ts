import type { Mat4 } from '../../math/types';
import type { LightData } from '../../doc/types';
import type { MeshGeometry } from './geometry';
import { buildDistribution1D, sampleDiscrete, type Distribution1D } from './distribution';

/*
 * Lamps with Blender's power units (consistent with the rasterizer):
 * - POINT / SPOT: power P (W) → radiant intensity I = P / 4π (W/sr) from a sphere of radius
 *   `shadow_soft_size` (radiance I / πr²); spot lights mask it with the cone (`spot_size`, full
 *   angle) and a smoothstep `spot_blend`.
 * - SUN: `energy` is the irradiance (W/m²) on a surface facing it; a disc of angular diameter
 *   `angle` (radians, Blender SunLight.angle; 0.526° when the field is absent).
 * - AREA: power P from a one-sided Lambertian emitter of area A facing the light's −Z axis
 *   (radiance P / πA); SQUARE/RECTANGLE (size × size_y) or DISK/ELLIPSE (diameters), scaled by
 *   the object transform.
 * Lamps light the scene and appear in reflections, but are invisible to camera rays and never
 * occlude anything (like Blender lights).
 */

export const LAMP_SPHERE = 0;
export const LAMP_SUN = 1;
export const LAMP_RECT = 2;
export const LAMP_DISK = 3;

/** Blender's default sun angular diameter (radians). */
export const DEFAULT_SUN_ANGLE = (0.526 * Math.PI) / 180;

export interface LampData {
  kind: number;
  /** Object id (diagnostics). */
  id: string;
  px: number;
  py: number;
  pz: number;
  /** Unit emission direction (the light's −Z axis): spot axis, area normal, sun travel direction. */
  nx: number;
  ny: number;
  nz: number;
  /** Area light half axes (world). */
  ux: number;
  uy: number;
  uz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Sphere radius, or the sun's angular radius. */
  radius: number;
  area: number;
  /**
   * Emitted radiance (sphere with radius, area, sun with angle) or, for delta lights, the
   * intensity (point: W/sr) / irradiance (sun: W/m²); linear rgb.
   */
  r: number;
  g: number;
  b: number;
  spot: boolean;
  cosHalf: number;
  smooth: number;
  /** cos of the sun cone half angle (sun), or 1. */
  cosMax: number;
  shadow: boolean;
  /** Scalar strength estimate for static light selection. */
  power: number;
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Converts an evaluated light object into lamp data, or null if it emits nothing / is invalid. */
export function buildLamp(id: string, l: LightData, M: Mat4, sceneRadius: number): LampData | null {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(M[i])) return null;
  const energy = Math.max(0, fin(l.energy, 0));
  const cr = Math.max(0, fin(l.color?.[0], 1));
  const cg = Math.max(0, fin(l.color?.[1], 1));
  const cb = Math.max(0, fin(l.color?.[2], 1));
  if (!(energy > 0) || !(cr + cg + cb > 0)) return null;
  // light points along its local −Z axis
  let nx = -M[8];
  let ny = -M[9];
  let nz = -M[10];
  const nl = Math.hypot(nx, ny, nz);
  if (nl > 0) {
    nx /= nl;
    ny /= nl;
    nz /= nl;
  } else {
    nx = 0;
    ny = 0;
    nz = -1;
  }
  const lamp: LampData = {
    kind: LAMP_SPHERE,
    id,
    px: M[12],
    py: M[13],
    pz: M[14],
    nx,
    ny,
    nz,
    ux: 0,
    uy: 0,
    uz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    radius: 0,
    area: 0,
    r: 0,
    g: 0,
    b: 0,
    spot: false,
    cosHalf: -1,
    smooth: 0,
    cosMax: 1,
    shadow: l.use_shadow !== false,
    power: 0,
  };
  if (l.type === 'SUN') {
    lamp.kind = LAMP_SUN;
    const angle = Math.min(
      Math.PI / 2,
      Math.max(0, fin((l as LightData & { angle?: number }).angle, DEFAULT_SUN_ANGLE)),
    );
    const half = angle / 2;
    lamp.radius = half;
    if (half > 1e-6) {
      lamp.cosMax = Math.cos(half);
      const s = Math.sin(half);
      const k = energy / (Math.PI * s * s);
      lamp.r = cr * k;
      lamp.g = cg * k;
      lamp.b = cb * k;
    } else {
      lamp.r = cr * energy;
      lamp.g = cg * energy;
      lamp.b = cb * energy;
    }
    lamp.power = energy * lum(cr, cg, cb) * Math.PI * sceneRadius * sceneRadius;
    return lamp;
  }
  if (l.type === 'AREA') {
    const sx = Math.max(0, fin(l.size, 1)) / 2;
    const sy = l.shape === 'RECTANGLE' || l.shape === 'ELLIPSE' ? Math.max(0, fin(l.size_y, 1)) / 2 : sx;
    lamp.kind = l.shape === 'DISK' || l.shape === 'ELLIPSE' ? LAMP_DISK : LAMP_RECT;
    lamp.ux = M[0] * sx;
    lamp.uy = M[1] * sx;
    lamp.uz = M[2] * sx;
    lamp.vx = M[4] * sy;
    lamp.vy = M[5] * sy;
    lamp.vz = M[6] * sy;
    let cx = lamp.uy * lamp.vz - lamp.uz * lamp.vy;
    let cy = lamp.uz * lamp.vx - lamp.ux * lamp.vz;
    let cz = lamp.ux * lamp.vy - lamp.uy * lamp.vx;
    const cl = Math.hypot(cx, cy, cz);
    const area = (lamp.kind === LAMP_RECT ? 4 : Math.PI) * cl;
    if (!(area > 1e-12)) {
      // degenerate area light: behave like a small one-sided emitter
      return null;
    }
    cx /= cl;
    cy /= cl;
    cz /= cl;
    if (cx * nx + cy * ny + cz * nz < 0) {
      cx = -cx;
      cy = -cy;
      cz = -cz;
    }
    lamp.nx = cx;
    lamp.ny = cy;
    lamp.nz = cz;
    lamp.area = area;
    lamp.radius = Math.sqrt(
      Math.max(
        lamp.ux * lamp.ux + lamp.uy * lamp.uy + lamp.uz * lamp.uz,
        lamp.vx * lamp.vx + lamp.vy * lamp.vy + lamp.vz * lamp.vz,
      ) * 2,
    );
    const k = energy / (Math.PI * area);
    lamp.r = cr * k;
    lamp.g = cg * k;
    lamp.b = cb * k;
    lamp.power = energy * lum(cr, cg, cb);
    return lamp;
  }
  // POINT / SPOT
  const radius = Math.max(0, fin(l.shadow_soft_size, 0.25));
  lamp.radius = radius;
  const I = energy / (4 * Math.PI);
  const k = radius > 0 ? I / (Math.PI * radius * radius) : I;
  lamp.r = cr * k;
  lamp.g = cg * k;
  lamp.b = cb * k;
  if (l.type === 'SPOT') {
    lamp.spot = true;
    const half = Math.min(Math.PI, Math.max(0, fin(l.spot_size, Math.PI / 4))) / 2;
    lamp.cosHalf = Math.cos(half);
    lamp.smooth = (1 - lamp.cosHalf) * Math.min(1, Math.max(0, fin(l.spot_blend, 0)));
  }
  lamp.power = energy * lum(cr, cg, cb);
  return lamp;
}

/**
 * A sun lamp from a direction towards the sun, an angular radius (0 = delta light) and the
 * irradiance (W/m², rgb) it delivers at normal incidence.
 */
export function makeSunLamp(
  id: string,
  toSun: readonly number[],
  halfAngle: number,
  irradiance: readonly number[],
): LampData | null {
  const l = Math.hypot(toSun[0], toSun[1], toSun[2]);
  const e = [
    Math.max(0, fin(irradiance[0], 0)),
    Math.max(0, fin(irradiance[1], 0)),
    Math.max(0, fin(irradiance[2], 0)),
  ];
  if (!(l > 0) || !(e[0] + e[1] + e[2] > 0)) return null;
  const half = Math.min(Math.PI / 4, Math.max(0, fin(halfAngle, 0)));
  const k = half > 1e-6 ? 1 / (Math.PI * Math.sin(half) ** 2) : 1;
  return {
    kind: LAMP_SUN,
    id,
    px: 0,
    py: 0,
    pz: 0,
    nx: -toSun[0] / l,
    ny: -toSun[1] / l,
    nz: -toSun[2] / l,
    ux: 0,
    uy: 0,
    uz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    radius: half > 1e-6 ? half : 0,
    area: 0,
    r: e[0] * k,
    g: e[1] * k,
    b: e[2] * k,
    spot: false,
    cosHalf: -1,
    smooth: 0,
    cosMax: half > 1e-6 ? Math.cos(half) : 1,
    shadow: true,
    power: lum(e[0], e[1], e[2]),
  };
}

/** Spot cone mask for a unit direction from the lamp towards the shaded point. */
export function spotMask(lamp: LampData, dx: number, dy: number, dz: number): number {
  if (!lamp.spot) return 1;
  const c = dx * lamp.nx + dy * lamp.ny + dz * lamp.nz;
  const t = c - lamp.cosHalf;
  if (t <= 0) return 0;
  if (lamp.smooth > 0 && t < lamp.smooth) {
    const u = t / lamp.smooth;
    return u * u * (3 - 2 * u);
  }
  return 1;
}

// ------------------------------------------------------------------ emissive meshes

/** Emissive triangles of one instance, sampled by world area × emitted luminance. */
export interface EmitterGroup {
  instance: number;
  /** Emissive triangles (geometry BVH order). */
  tris: Uint32Array;
  /** Geometry triangle → index into `tris`, or −1. */
  lookup: Int32Array;
  /** World-space area of each emissive triangle. */
  area: Float64Array;
  dist: Distribution1D;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  /** Average emitted luminance and total world area. */
  luminance: number;
  totalArea: number;
  power: number;
}

/**
 * Collects the emissive triangles of an instance. `slotLuminance[s]` is the emitted luminance of
 * material slot s (0 = not emissive); `xform` is the object → world transform (12 floats at `o`).
 */
export function buildEmitterGroup(
  instance: number,
  g: MeshGeometry,
  xform: Float64Array,
  o: number,
  slotLuminance: ArrayLike<number>,
  fallbackLuminance: number,
): EmitterGroup | null {
  const n = g.triCount;
  const lookup = new Int32Array(n).fill(-1);
  const tris: number[] = [];
  const areas: number[] = [];
  const weights: number[] = [];
  const X = xform;
  const V = g.verts;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let totalArea = 0;
  let lumArea = 0;
  for (let t = 0; t < n; t++) {
    const s = g.slot[t];
    const L = s < slotLuminance.length ? slotLuminance[s] : fallbackLuminance;
    if (!(L > 0)) continue;
    const w: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = V[t * 9 + k * 3];
      const y = V[t * 9 + k * 3 + 1];
      const z = V[t * 9 + k * 3 + 2];
      const wx = X[o] * x + X[o + 3] * y + X[o + 6] * z + X[o + 9];
      const wy = X[o + 1] * x + X[o + 4] * y + X[o + 7] * z + X[o + 10];
      const wz = X[o + 2] * x + X[o + 5] * y + X[o + 8] * z + X[o + 11];
      w.push(wx, wy, wz);
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
    const ex = w[3] - w[0];
    const ey = w[4] - w[1];
    const ez = w[5] - w[2];
    const fx = w[6] - w[0];
    const fy = w[7] - w[1];
    const fz = w[8] - w[2];
    const a = 0.5 * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
    if (!(a > 0) || !Number.isFinite(a)) continue;
    lookup[t] = tris.length;
    tris.push(t);
    areas.push(a);
    weights.push(a * L);
    totalArea += a;
    lumArea += a * L;
  }
  if (!tris.length || !(lumArea > 0)) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  return {
    instance,
    tris: Uint32Array.from(tris),
    lookup,
    area: Float64Array.from(areas),
    dist: buildDistribution1D(weights),
    cx,
    cy,
    cz,
    radius: 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    luminance: lumArea / totalArea,
    totalArea,
    // two-sided Lambertian emitter: Φ = 2π · L · A
    power: 2 * Math.PI * lumArea,
  };
}

// ------------------------------------------------------------------ light selection

export const GROUP_LAMP = 0;
export const GROUP_MESH = 1;
export const GROUP_ENV = 2;

/** Above this many light groups, selection uses fixed power weights instead of per-point weights. */
const MAX_ADAPTIVE = 64;

/**
 * Chooses which light to sample at a shading point. With few lights the probabilities are
 * per-point irradiance estimates (distance, facing and spot cone aware, exactly 0 only where a
 * light cannot contribute); with many lights they are proportional to emitted power.
 */
export class LightSelector {
  readonly count: number;
  readonly adaptive: boolean;
  private readonly weights: Float64Array;
  private readonly staticDist: Distribution1D;
  /** Sum of the weights of the last `prepare` call. */
  total = 0;
  /** Probability of the group chosen by the last `pick`, and the remapped random number. */
  prob = 0;
  uRest = 0;

  constructor(
    readonly kinds: Int32Array,
    readonly refs: Int32Array,
    readonly lamps: readonly LampData[],
    readonly groups: readonly EmitterGroup[],
    readonly envPower: number,
  ) {
    this.count = kinds.length;
    this.adaptive = this.count <= MAX_ADAPTIVE;
    this.weights = new Float64Array(this.count);
    const pw = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++)
      pw[i] =
        kinds[i] === GROUP_LAMP
          ? lamps[refs[i]].power
          : kinds[i] === GROUP_MESH
            ? groups[refs[i]].power
            : envPower;
    this.staticDist = buildDistribution1D(pw);
  }

  /**
   * Irradiance-like weight of group `i` at point p with unit normal n. `twoSided` disables the
   * horizon test (transmissive surfaces receive light from both sides).
   */
  weight(
    i: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    twoSided: boolean,
  ): number {
    const kind = this.kinds[i];
    if (kind === GROUP_ENV) return this.envPower * 0.25;
    if (kind === GROUP_MESH) {
      const g = this.groups[this.refs[i]];
      const dx = g.cx - px;
      const dy = g.cy - py;
      const dz = g.cz - pz;
      if (!twoSided && dx * nx + dy * ny + dz * nz < -g.radius) return 0;
      const d2 = dx * dx + dy * dy + dz * dz;
      return g.luminance * Math.min(Math.PI, g.totalArea / Math.max(d2, 1e-12));
    }
    const l = this.lamps[this.refs[i]];
    const Ll = lum(l.r, l.g, l.b);
    if (l.kind === LAMP_SUN) {
      if (!twoSided && -(nx * l.nx + ny * l.ny + nz * l.nz) < -Math.sin(l.radius) - 1e-6) return 0;
      // irradiance of a sun disc: L · π sin²(half angle), or the delta strength
      if (l.radius > 1e-6) {
        const s = Math.sin(l.radius);
        return Ll * Math.PI * s * s;
      }
      return Ll;
    }
    const dx = l.px - px;
    const dy = l.py - py;
    const dz = l.pz - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!twoSided && dx * nx + dy * ny + dz * nz < -l.radius) return 0;
    if (l.kind === LAMP_SPHERE) {
      const r2 = l.radius * l.radius;
      if (l.spot) {
        const d = Math.sqrt(d2);
        if (d > l.radius) {
          // outside the cone widened by the lamp's angular radius → no light
          const c = -(dx * l.nx + dy * l.ny + dz * l.nz) / d;
          const ang = Math.acos(Math.max(-1, Math.min(1, c)));
          const half = Math.acos(Math.max(-1, Math.min(1, l.cosHalf)));
          if (ang > half + Math.asin(Math.min(1, l.radius / d)) + 1e-6) return 0;
        }
      }
      // radiance × projected area (πr²) = intensity
      const I = l.radius > 0 ? Ll * Math.PI * r2 : Ll;
      return I / Math.max(d2, r2 + 1e-12);
    }
    // area light: one-sided, nothing behind its plane
    const side = -(dx * l.nx + dy * l.ny + dz * l.nz);
    if (side <= 0) return 0;
    const cosL = Math.max(0.05, side / Math.sqrt(d2 || 1e-24));
    return Ll * Math.min(Math.PI, (l.area * cosL) / Math.max(d2, 1e-12));
  }

  /** Computes the selection weights at a point; returns their sum. */
  prepare(px: number, py: number, pz: number, nx: number, ny: number, nz: number, twoSided: boolean): number {
    let sum = 0;
    if (this.adaptive) {
      const w = this.weights;
      for (let i = 0; i < this.count; i++) {
        const v = this.weight(i, px, py, pz, nx, ny, nz, twoSided);
        w[i] = v > 0 && Number.isFinite(v) ? v : 0;
        sum += w[i];
      }
    } else sum = this.staticDist.total > 0 ? 1 : 0;
    this.total = sum;
    return sum;
  }

  /** Picks a group with probability ∝ weight (after `prepare`); −1 when nothing can be sampled. */
  pick(u: number): number {
    if (!(this.total > 0)) return -1;
    if (!this.adaptive) {
      const i = sampleDiscrete(this.staticDist, u);
      const c0 = this.staticDist.cdf[i];
      const c1 = this.staticDist.cdf[i + 1];
      this.prob = c1 - c0;
      this.uRest = this.prob > 0 ? Math.min(0.99999999, (u - c0) / this.prob) : 0;
      return this.prob > 0 ? i : -1;
    }
    const w = this.weights;
    const target = u * this.total;
    let acc = 0;
    let last = -1;
    for (let i = 0; i < this.count; i++) {
      if (!(w[i] > 0)) continue;
      last = i;
      if (target < acc + w[i]) {
        this.prob = w[i] / this.total;
        this.uRest = Math.min(0.99999999, Math.max(0, (target - acc) / w[i]));
        return i;
      }
      acc += w[i];
    }
    if (last < 0) return -1;
    this.prob = w[last] / this.total;
    this.uRest = 0.5;
    return last;
  }

  /**
   * Probability that `prepare(p, n, twoSided)` with weight sum `total` followed by `pick` selects
   * group `i` (for MIS when a BSDF-sampled ray hits a light).
   */
  probability(
    i: number,
    total: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    twoSided: boolean,
  ): number {
    if (i < 0 || !(total > 0)) return 0;
    if (!this.adaptive) return this.staticDist.cdf[i + 1] - this.staticDist.cdf[i];
    const v = this.weight(i, px, py, pz, nx, ny, nz, twoSided);
    return v > 0 && Number.isFinite(v) ? v / total : 0;
  }
}
