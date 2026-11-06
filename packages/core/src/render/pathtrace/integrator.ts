import type { Vec3 } from '../../math/types';
import { bumpNormal } from '../../material/surface';
import { PrincipledBSDF, thinTransmittance } from './bsdf';
import { CameraRays } from './camera';
import type { CompiledScene } from './compile';
import { discretePdf } from './distribution';
import { Environment } from './environment';
import { SceneIntersector } from './intersect';
import {
  GROUP_ENV,
  GROUP_LAMP,
  GROUP_MESH,
  LAMP_DISK,
  LAMP_RECT,
  LAMP_SPHERE,
  LAMP_SUN,
  LightSelector,
  spotMask,
  type LampData,
} from './lights';
import { BLEND_BLEND, ShadingContext, SurfaceShader, type PTMaterial } from './material';
import { Sampler } from './sampler';

/*
 * Unidirectional path tracer with next-event estimation and multiple importance sampling
 * (power heuristic) between light sampling and BSDF sampling, Russian roulette, indirect
 * clamping and stochastic alpha transparency. One call of `trace` computes one camera sample.
 *
 * Light through glass. Shadow rays pass alpha-transparent surfaces (by their uncovered part) and
 * transmissive ones (thin-walled: straight through, attenuated by transmission × base colour and
 * the Fresnel reflection, see `thinTransmittance`), so lamps inside glass lanterns and bulbs light
 * the scene and index-matched (IOR 1) surfaces cast almost no shadow. A closed glass object is
 * crossed twice and attenuates like a thin shell; its lens effect (caustics, a bright focus in the
 * shadow of a glass ball) is not part of the lighting. To count no light twice, glass reached by a
 * ray from a vertex that samples lights (diffuse or glossy, not a mirror and not the camera) is
 * thin-walled for that path too: it reflects like a sheet, transmits straight through, and the
 * transmission keeps that vertex's MIS state (like a transparent layer: lights found through the
 * glass are weighed against the vertex's own light samples), while the light behind the glass is
 * left to that vertex. The camera, mirrors and smooth glass still see refraction (lenses, glass
 * balls and bottles look right); reflections in glossy surfaces and indirect light see glass as
 * thin-walled.
 *
 * Alpha-blended (BLEND) surfaces seen by the camera are shaded with deterministic coverage: their
 * emission, direct light and mist count with the coverage as weight, and only the choice between
 * scattering there and passing through stays random, so faint glows (light shafts) are smooth.
 *
 * Mist follows the camera chain: every surface the camera sees, directly or through transmissions
 * and transparent layers, fades towards the mist colour by its own view depth (the background is
 * not misted), so distant objects seen through glass keep their mist like in the rasterizer.
 */

/** What camera rays that leave the scene show. */
export const BACKGROUND_ENVIRONMENT = 0;
export const BACKGROUND_COLOR = 1;
export const BACKGROUND_TRANSPARENT = 2;

export interface IntegratorSettings {
  /**
   * Maximum bounces of any kind (diffuse, glossy, transmission) on a path: Blender's Total max
   * bounces (render `max_bounces`). Alpha-transparent surfaces do not count (`maxTransparentLayers`).
   */
  maxBounces: number;
  /** Maximum refractions (glass) on a path, within `maxBounces`. */
  maxTransmissionBounces: number;
  /** Maximum alpha-transparent surfaces a ray passes through. */
  maxTransparentLayers: number;
  /** Largest per-sample contribution of indirect light (max rgb component); 0 disables. */
  clampIndirect: number;
  /**
   * Filter Glossy (Cycles): after blurry bounces, microfacet lobes are blurred to
   * α ≥ √(1 − pdf_min / filterGlossy) / 2, where pdf_min is the smallest BSDF pdf on the path so
   * far. Removes most caustic fireflies at the cost of blurrier indirect reflections; 0 disables.
   */
  filterGlossy: number;
  seed: number;
  background: number;
  /** Linear background colour (premultiplied by `bgA`) for BACKGROUND_COLOR. */
  bgR: number;
  bgG: number;
  bgB: number;
  bgA: number;
  /** World mist: surfaces fade towards the mist colour by 1 − exp(−(density · view depth)²). */
  mistDensity: number;
  mistR: number;
  mistG: number;
  mistB: number;
}

const EPS_SCALE = 1e-6;

function powerHeuristic(a: number, b: number): number {
  const a2 = a * a;
  const b2 = b * b;
  return a2 + b2 > 0 ? a2 / (a2 + b2) : 0;
}

/** Sampler dimension pairs: 0 pixel filter, 1 lens, then 3 per scattering vertex. */
const DIM_FILTER = 0;
const DIM_LENS = 1;
const DIM_VERTEX = 2;
// far above any vertex dimension (paths are at most a few thousand vertices long)
const DIM_RR = 1 << 16;
const DIM_ALPHA = 1 << 17;
/** Vertices of alpha-blended surfaces the camera ray scatters at and passes (by layer). */
const DIM_SPLIT = 1 << 18;
/** A sphere lamp counts as a point light from points closer than this squared radius factor. */
const INSIDE_SPHERE = 1.0001;
/** Blender's object shadow terminator "Geometry Offset" (default 0.1): see `terminatorAmount`. */
const TERMINATOR_CUTOFF = 0.1;

/**
 * Fraction of the shadow-terminator offset applied to a shadow ray from a smooth triangle, given
 * the cosines of the light direction to the geometric (`ngl`) and shading (`nl`) normals on the lit
 * side. As in Cycles' `shadow_ray_offset`, only light grazing the facet is lifted, fading in
 * smoothly: by 1 − ngl / cutoff, or by 2 − (ngl + nl) / cutoff while the shading normal grazes
 * the light too (nl below the cutoff). Light from higher up cannot be blocked by the neighbouring
 * facets, and lifting its rays (by up to a large part of a coarse triangle) would make nearby
 * contact shadows vanish.
 */
export function terminatorAmount(ngl: number, nl: number): number {
  const k = nl < TERMINATOR_CUTOFF ? 2 - (ngl + nl) / TERMINATOR_CUTOFF : 1 - ngl / TERMINATOR_CUTOFF;
  return k > 0 ? (k < 1 ? k : 1) : 0;
}

/** Per-sample results of `PathIntegrator.trace`. */
export class PathIntegrator {
  // ---- outputs (premultiplied radiance and coverage)
  r = 0;
  g = 0;
  b = 0;
  a = 0;
  /** Part of r/g/b seen directly by the camera: emission and background (not denoised). */
  er = 0;
  eg = 0;
  eb = 0;
  /** Denoising guides: albedo, world normal and distance of the first surface. */
  albR = 0;
  albG = 0;
  albB = 0;
  nrmX = 0;
  nrmY = 0;
  nrmZ = 0;
  depth = 0;

  readonly sampler: Sampler;
  readonly camera: CameraRays;
  readonly env: Environment;
  readonly isect: SceneIntersector;
  readonly lights: LightSelector;
  private readonly bsdf = new PrincipledBSDF();
  private readonly shader: SurfaceShader;
  private readonly ctx = new ShadingContext();
  private readonly shadowCtx = new ShadingContext();
  private readonly shadowShader: SurfaceShader;
  private readonly lampSel: Int32Array;
  private readonly meshSel: Int32Array;
  private readonly envSel: number;

  // ---- hit state (world unless noted)
  private px = 0;
  private py = 0;
  private pz = 0;
  /** Geometric normal (unit, as stored: front side outward). */
  private gx = 0;
  private gy = 0;
  private gz = 1;
  /** Shading normal (unit). */
  private sx = 0;
  private sy = 0;
  private sz = 1;
  private hitMat: PTMaterial | null = null;
  private smoothTri = false;
  /** World ∂p/∂u, ∂p/∂v of the current triangle (`uvTangents`). */
  private tux = 0;
  private tuy = 0;
  private tuz = 0;
  private tvx = 0;
  private tvy = 0;
  private tvz = 0;
  private readonly bumpC: Vec3 = [0, 0, 0];
  private readonly bumpDcx: Vec3 = [0, 0, 0];
  private readonly bumpDcy: Vec3 = [0, 0, 0];
  private readonly bumpDpx: Vec3 = [0, 0, 0];
  private readonly bumpDpy: Vec3 = [0, 0, 0];
  private readonly bumpN: Vec3 = [0, 0, 1];
  // ---- light sample
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private lDist = 0;
  private lr = 0;
  private lg = 0;
  private lb = 0;
  private lPdf = 0;
  private lDelta = false;
  private lShadow = true;
  /** `hitLamp`: distance limit of the current ray and distance of the lamp hit. */
  private lampLimit = Infinity;
  private lampT = 0;
  /** Per-channel transmittance of the current shadow ray (product over the surfaces it passed). */
  private shR = 1;
  private shG = 1;
  private shB = 1;
  /** `shadowCosine`: whether the shadow ray enters the surface from its front (outer) side. */
  private shadowEntering = true;
  /** Scratch rgb of `thinTransmittance`. */
  private readonly thin = new Float64Array(3);

  constructor(
    readonly scene: CompiledScene,
    readonly settings: IntegratorSettings,
  ) {
    this.sampler = new Sampler(settings.seed);
    this.camera = new CameraRays(scene.camera);
    this.env = new Environment(scene.environment);
    this.isect = new SceneIntersector(scene.geometries, scene.instances, scene.tlas);
    this.isect.shadowFilter = (inst, tri, b1, b2) => this.shadowTransmittance(inst, tri, b1, b2);
    this.lights = new LightSelector(
      scene.lightKinds,
      scene.lightRefs,
      scene.lamps,
      scene.emitters,
      scene.environment.power,
    );
    this.shader = new SurfaceShader(scene.images);
    this.shadowShader = new SurfaceShader(scene.images);
    this.lampSel = new Int32Array(scene.lamps.length).fill(-1);
    this.meshSel = new Int32Array(scene.emitters.length).fill(-1);
    let envSel = -1;
    for (let i = 0; i < scene.lightKinds.length; i++) {
      const k = scene.lightKinds[i];
      if (k === GROUP_LAMP) this.lampSel[scene.lightRefs[i]] = i;
      else if (k === GROUP_MESH) this.meshSel[scene.lightRefs[i]] = i;
      else if (k === GROUP_ENV) envSel = i;
    }
    this.envSel = envSel;
  }

  /** Material of a triangle of an instance. */
  private materialOf(inst: number, tri: number): PTMaterial {
    const s = this.scene;
    const geom = s.geometries[s.instances.geom[inst]];
    const slot = geom.slot[tri];
    const idx = slot < s.instances.slotCount[inst] ? s.slotMaterials[s.instances.slotBase[inst] + slot] : 0;
    return s.materials[idx];
  }

  /** Fills a shading context (UV, object position, vertex colour) for a point on a triangle. */
  private fillContext(c: ShadingContext, inst: number, tri: number, b1: number, b2: number): void {
    const s = this.scene;
    const g = s.geometries[s.instances.geom[inst]];
    const b0 = 1 - b1 - b2;
    const V = g.verts;
    const o = tri * 9;
    c.px = b0 * V[o] + b1 * V[o + 3] + b2 * V[o + 6];
    c.py = b0 * V[o + 1] + b1 * V[o + 4] + b2 * V[o + 7];
    c.pz = b0 * V[o + 2] + b1 * V[o + 5] + b2 * V[o + 8];
    const i0 = g.vidx[tri * 3];
    const i1 = g.vidx[tri * 3 + 1];
    const i2 = g.vidx[tri * 3 + 2];
    const oi = s.instances.orco[inst];
    if (oi >= 0) {
      // undeformed positions: GENERATED coordinates stick to deformed surfaces
      const O = s.instances.orcos[oi];
      c.gx = b0 * O[i0 * 3] + b1 * O[i1 * 3] + b2 * O[i2 * 3];
      c.gy = b0 * O[i0 * 3 + 1] + b1 * O[i1 * 3 + 1] + b2 * O[i2 * 3 + 1];
      c.gz = b0 * O[i0 * 3 + 2] + b1 * O[i1 * 3 + 2] + b2 * O[i2 * 3 + 2];
    } else {
      c.gx = c.px;
      c.gy = c.py;
      c.gz = c.pz;
    }
    const uv = g.uvs;
    if (uv) {
      c.hasUV = true;
      c.u = b0 * uv[i0 * 2] + b1 * uv[i1 * 2] + b2 * uv[i2 * 2];
      c.v = b0 * uv[i0 * 2 + 1] + b1 * uv[i1 * 2 + 1] + b2 * uv[i2 * 2 + 1];
    } else c.hasUV = false;
    const col = g.colors;
    if (col) {
      c.cr = b0 * col[i0 * 4] + b1 * col[i1 * 4] + b2 * col[i2 * 4];
      c.cg = b0 * col[i0 * 4 + 1] + b1 * col[i1 * 4 + 1] + b2 * col[i2 * 4 + 1];
      c.cb = b0 * col[i0 * 4 + 2] + b1 * col[i1 * 4 + 2] + b2 * col[i2 * 4 + 2];
      c.ca = b0 * col[i0 * 4 + 3] + b1 * col[i1 * 4 + 3] + b2 * col[i2 * 4 + 3];
    } else c.cr = c.cg = c.cb = c.ca = 1;
    const gen = s.instances.gen;
    const go = inst * 6;
    c.genMin[0] = gen[go];
    c.genMin[1] = gen[go + 1];
    c.genMin[2] = gen[go + 2];
    c.genSize[0] = gen[go + 3] - gen[go];
    c.genSize[1] = gen[go + 4] - gen[go + 1];
    c.genSize[2] = gen[go + 5] - gen[go + 2];
  }

  /**
   * Light passing a surface hit by a shadow ray (the intersector's `shadowFilter`): the uncovered
   * part of alpha-transparent surfaces plus, through transmissive ones, their thin-walled
   * transmittance. Multiplies the shadow ray's per-channel transmittance (shR, shG, shB) and
   * returns this surface's largest factor, or 0 (opaque) once next to nothing is left.
   */
  private shadowTransmittance(inst: number, tri: number, b1: number, b2: number): number {
    const m = this.materialOf(inst, tri);
    const vcol = m.blend !== 0 && !!this.scene.geometries[this.scene.instances.geom[inst]].colors;
    if (!m.transparent && !vcol && !m.transmissive) return 0;
    const c = this.shadowCtx;
    this.fillContext(c, inst, tri, b1, b2);
    const sh = this.shadowShader;
    const cov = m.transparent || vcol ? sh.coverage(m, c) : 1;
    let pr = 1 - cov;
    let pg = pr;
    let pb = pr;
    if (cov > 0 && m.transmissive) {
      sh.evaluate(m, c);
      if (sh.transmission > 0 && sh.metallic < 1) {
        const mu = this.shadowCosine(inst, tri, b1, b2);
        const t = this.thin;
        thinTransmittance(sh, mu, this.shadowEntering, t);
        pr += cov * t[0];
        pg += cov * t[1];
        pb += cov * t[2];
      }
    }
    this.shR *= pr;
    this.shG *= pg;
    this.shB *= pb;
    if (!(Math.max(this.shR, this.shG, this.shB) >= 1e-4)) return 0;
    const mx = Math.max(pr, pg, pb);
    return mx > 0 ? mx : 0;
  }

  /**
   * |cos| between the current shadow ray (`isect.ray`) and the normal of a surface it hits (the
   * interpolated shading normal of smooth triangles, else the face normal); sets `shadowEntering`
   * (the ray hits the front side).
   */
  private shadowCosine(inst: number, tri: number, b1: number, b2: number): number {
    const s = this.scene;
    const g = s.geometries[s.instances.geom[inst]];
    const V = g.verts;
    const o = tri * 9;
    const ex = V[o + 3] - V[o];
    const ey = V[o + 4] - V[o + 1];
    const ez = V[o + 5] - V[o + 2];
    const fx = V[o + 6] - V[o];
    const fy = V[o + 7] - V[o + 1];
    const fz = V[o + 8] - V[o + 2];
    const nx = ey * fz - ez * fy;
    const ny = ez * fx - ex * fz;
    const nz = ex * fy - ey * fx;
    const I = s.instances.inv;
    const io = inst * 12;
    const R = this.isect.ray;
    const dx = R[3];
    const dy = R[4];
    const dz = R[5];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const wx = I[io] * nx + I[io + 1] * ny + I[io + 2] * nz;
    const wy = I[io + 3] * nx + I[io + 4] * ny + I[io + 5] * nz;
    const wz = I[io + 6] * nx + I[io + 7] * ny + I[io + 8] * nz;
    const gl = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (!(gl > 0) || !Number.isFinite(gl)) {
      this.shadowEntering = true;
      return 1;
    }
    this.shadowEntering = wx * dx + wy * dy + wz * dz < 0;
    if (g.smooth[tri] === 1) {
      const N = g.normals;
      const b0 = 1 - b1 - b2;
      const i0 = g.vidx[tri * 3] * 3;
      const i1 = g.vidx[tri * 3 + 1] * 3;
      const i2 = g.vidx[tri * 3 + 2] * 3;
      const ax = b0 * N[i0] + b1 * N[i1] + b2 * N[i2];
      const ay = b0 * N[i0 + 1] + b1 * N[i1 + 1] + b2 * N[i2 + 1];
      const az = b0 * N[i0 + 2] + b1 * N[i1 + 2] + b2 * N[i2 + 2];
      const sx = I[io] * ax + I[io + 1] * ay + I[io + 2] * az;
      const sy = I[io + 3] * ax + I[io + 4] * ay + I[io + 5] * az;
      const sz = I[io + 6] * ax + I[io + 7] * ay + I[io + 8] * az;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl > 0 && Number.isFinite(sl)) return Math.abs(sx * dx + sy * dy + sz * dz) / (sl * dl);
    }
    return Math.abs(wx * dx + wy * dy + wz * dz) / (gl * dl);
  }

  /** Computes position and normals of the current intersection (`isect.ray` origin + t · direction). */
  private setupHit(): void {
    const s = this.scene;
    const is = this.isect;
    const R = is.ray;
    const ox = R[0];
    const oy = R[1];
    const oz = R[2];
    const dx = R[3];
    const dy = R[4];
    const dz = R[5];
    const inst = is.inst;
    const tri = is.tri;
    const g = s.geometries[s.instances.geom[inst]];
    const t = is.t;
    this.px = ox + dx * t;
    this.py = oy + dy * t;
    this.pz = oz + dz * t;
    const V = g.verts;
    const o = tri * 9;
    const ex = V[o + 3] - V[o];
    const ey = V[o + 4] - V[o + 1];
    const ez = V[o + 5] - V[o + 2];
    const fx = V[o + 6] - V[o];
    const fy = V[o + 7] - V[o + 1];
    const fz = V[o + 8] - V[o + 2];
    // object-space face normal → world with the inverse transpose
    const nx = ey * fz - ez * fy;
    const ny = ez * fx - ex * fz;
    const nz = ex * fy - ey * fx;
    const I = s.instances.inv;
    const io = inst * 12;
    let wx = I[io] * nx + I[io + 1] * ny + I[io + 2] * nz;
    let wy = I[io + 3] * nx + I[io + 4] * ny + I[io + 5] * nz;
    let wz = I[io + 6] * nx + I[io + 7] * ny + I[io + 8] * nz;
    let l = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (!(l > 0)) {
      wx = -dx;
      wy = -dy;
      wz = -dz;
      l = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    }
    this.gx = wx / l;
    this.gy = wy / l;
    this.gz = wz / l;
    this.smoothTri = g.smooth[tri] === 1;
    if (this.smoothTri) {
      const N = g.normals;
      const b1 = is.b1;
      const b2 = is.b2;
      const b0 = 1 - b1 - b2;
      const i0 = g.vidx[tri * 3] * 3;
      const i1 = g.vidx[tri * 3 + 1] * 3;
      const i2 = g.vidx[tri * 3 + 2] * 3;
      const ax = b0 * N[i0] + b1 * N[i1] + b2 * N[i2];
      const ay = b0 * N[i0 + 1] + b1 * N[i1 + 1] + b2 * N[i2 + 1];
      const az = b0 * N[i0 + 2] + b1 * N[i1 + 2] + b2 * N[i2 + 2];
      let sx = I[io] * ax + I[io + 1] * ay + I[io + 2] * az;
      let sy = I[io + 3] * ax + I[io + 4] * ay + I[io + 5] * az;
      let sz = I[io + 6] * ax + I[io + 7] * ay + I[io + 8] * az;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl > 0 && Number.isFinite(sl)) {
        sx /= sl;
        sy /= sl;
        sz /= sl;
        // keep the shading normal on the geometric front side
        if (sx * this.gx + sy * this.gy + sz * this.gz < 0) {
          sx = this.gx;
          sy = this.gy;
          sz = this.gz;
        }
        this.sx = sx;
        this.sy = sy;
        this.sz = sz;
        return;
      }
    }
    this.sx = this.gx;
    this.sy = this.gy;
    this.sz = this.gz;
  }

  /** World-space ∂p/∂u and ∂p/∂v of a triangle (into the tu… and tv… fields); false without UVs or when degenerate. */
  private uvTangents(inst: number, tri: number): boolean {
    const s = this.scene;
    const g = s.geometries[s.instances.geom[inst]];
    const uv = g.uvs;
    if (!uv) return false;
    const V = g.verts;
    const o = tri * 9;
    const i0 = g.vidx[tri * 3];
    const i1 = g.vidx[tri * 3 + 1];
    const i2 = g.vidx[tri * 3 + 2];
    const du1 = uv[i1 * 2] - uv[i0 * 2];
    const dv1 = uv[i1 * 2 + 1] - uv[i0 * 2 + 1];
    const du2 = uv[i2 * 2] - uv[i0 * 2];
    const dv2 = uv[i2 * 2 + 1] - uv[i0 * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (!(Math.abs(det) > 1e-20)) return false;
    const r = 1 / det;
    const e1x = V[o + 3] - V[o];
    const e1y = V[o + 4] - V[o + 1];
    const e1z = V[o + 5] - V[o + 2];
    const e2x = V[o + 6] - V[o];
    const e2y = V[o + 7] - V[o + 1];
    const e2z = V[o + 8] - V[o + 2];
    const ux = (e1x * dv2 - e2x * dv1) * r;
    const uy = (e1y * dv2 - e2y * dv1) * r;
    const uz = (e1z * dv2 - e2z * dv1) * r;
    const vx = (e2x * du1 - e1x * du2) * r;
    const vy = (e2y * du1 - e1y * du2) * r;
    const vz = (e2z * du1 - e1z * du2) * r;
    const X = s.instances.xform;
    const xo = inst * 12;
    this.tux = X[xo] * ux + X[xo + 3] * uy + X[xo + 6] * uz;
    this.tuy = X[xo + 1] * ux + X[xo + 4] * uy + X[xo + 7] * uz;
    this.tuz = X[xo + 2] * ux + X[xo + 5] * uy + X[xo + 8] * uz;
    this.tvx = X[xo] * vx + X[xo + 3] * vy + X[xo + 6] * vz;
    this.tvy = X[xo + 1] * vx + X[xo + 4] * vy + X[xo + 7] * vz;
    this.tvz = X[xo + 2] * vx + X[xo + 5] * vy + X[xo + 8] * vz;
    return (
      Number.isFinite(this.tux + this.tuy + this.tuz + this.tvx + this.tvy + this.tvz) &&
      this.tux * this.tux + this.tuy * this.tuy + this.tuz * this.tuz > 0 &&
      this.tvx * this.tvx + this.tvy * this.tvy + this.tvz * this.tvz > 0
    );
  }

  /**
   * Perturbs the shading normal (world, already facing wo) with the tangent-space normal map of
   * the shader, using the triangle's UV tangent frame.
   */
  private applyNormalMap(inst: number, tri: number, flip: number): void {
    if (!this.uvTangents(inst, tri)) return;
    // Gram–Schmidt against the (unflipped) shading normal
    const nx = this.sx * flip;
    const ny = this.sy * flip;
    const nz = this.sz * flip;
    let tx = this.tux;
    let ty = this.tuy;
    let tz = this.tuz;
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d;
    ty -= ny * d;
    tz -= nz * d;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (!(tl > 0)) return;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // bitangent = ±(n × t), sign from the UV orientation
    let qx = ny * tz - nz * ty;
    let qy = nz * tx - nx * tz;
    let qz = nx * ty - ny * tx;
    if (qx * this.tvx + qy * this.tvy + qz * this.tvz < 0) {
      qx = -qx;
      qy = -qy;
      qz = -qz;
    }
    const sh = this.shader;
    let mx = tx * sh.nmx + qx * sh.nmy + nx * sh.nmz;
    let my = ty * sh.nmx + qy * sh.nmy + ny * sh.nmz;
    let mz = tz * sh.nmx + qz * sh.nmy + nz * sh.nmz;
    const ml = Math.sqrt(mx * mx + my * my + mz * mz);
    if (!(ml > 0)) return;
    mx /= ml;
    my /= ml;
    mz /= ml;
    const k = this.hitMat!.normalStrength;
    mx = nx + (mx - nx) * k;
    my = ny + (my - ny) * k;
    mz = nz + (mz - nz) * k;
    const l2 = Math.sqrt(mx * mx + my * my + mz * mz);
    if (!(l2 > 0)) return;
    this.sx = (mx / l2) * flip;
    this.sy = (my / l2) * flip;
    this.sz = (mz / l2) * flip;
  }

  /**
   * Bumps the shading normal with the shader's procedural height field (material/surface.ts
   * semantics) using surface offsets of about one pixel footprint (`footprint`, world units).
   */
  private applyBump(inst: number, tri: number, flip: number, footprint: number): void {
    const sh = this.shader;
    const tex = sh.bumpTex!;
    const c = this.ctx;
    const bc = this.bumpC;
    const dcx = this.bumpDcx;
    const dcy = this.bumpDcy;
    const dpx = this.bumpDpx;
    const dpy = this.bumpDpy;
    const n = this.bumpN;
    n[0] = this.sx * flip;
    n[1] = this.sy * flip;
    n[2] = this.sz * flip;
    sh.textureCoord(tex, c, bc);
    if (tex.mapping === 2) {
      // UV mapping: offsets along ∂p/∂u and ∂p/∂v
      if (!this.uvTangents(inst, tri)) return;
      const lu = Math.sqrt(this.tux * this.tux + this.tuy * this.tuy + this.tuz * this.tuz);
      const lv = Math.sqrt(this.tvx * this.tvx + this.tvy * this.tvy + this.tvz * this.tvz);
      const du = footprint / lu;
      const dv = footprint / lv;
      dpx[0] = this.tux * du;
      dpx[1] = this.tuy * du;
      dpx[2] = this.tuz * du;
      dpy[0] = this.tvx * dv;
      dpy[1] = this.tvy * dv;
      dpy[2] = this.tvz * dv;
      dcx[0] = du;
      dcx[1] = 0;
      dcx[2] = 0;
      dcy[0] = 0;
      dcy[1] = dv;
      dcy[2] = 0;
    } else {
      // object / generated mapping: any two tangents, texture offsets through the inverse transform
      const sgn = n[2] >= 0 ? 1 : -1;
      const a = -1 / (sgn + n[2]);
      const b = n[0] * n[1] * a;
      dpx[0] = (1 + sgn * n[0] * n[0] * a) * footprint;
      dpx[1] = sgn * b * footprint;
      dpx[2] = -sgn * n[0] * footprint;
      dpy[0] = b * footprint;
      dpy[1] = (sgn + n[1] * n[1] * a) * footprint;
      dpy[2] = -n[1] * footprint;
      const I = this.scene.instances.inv;
      const io = inst * 12;
      const gen = tex.mapping === 0;
      for (let k = 0; k < 2; k++) {
        const p = k === 0 ? dpx : dpy;
        const out = k === 0 ? dcx : dcy;
        for (let i = 0; i < 3; i++) {
          const v = I[io + i] * p[0] + I[io + 3 + i] * p[1] + I[io + 6 + i] * p[2];
          const size = c.genSize[i];
          out[i] = gen ? (size > 1e-12 ? v / size : 0) : v;
        }
      }
    }
    bumpNormal(tex, sh.bumpDistance, bc, dcx, dcy, dpx, dpy, n, n);
    if (!(Number.isFinite(n[0]) && Number.isFinite(n[1]) && Number.isFinite(n[2]))) return;
    this.sx = n[0] * flip;
    this.sy = n[1] * flip;
    this.sz = n[2] * flip;
  }

  /**
   * Shadow-terminator offset (Hanika 2021): lifts shadow-ray origins on smooth low-poly surfaces
   * onto the curved surface implied by the vertex normals. Writes the offset origin into lx/ly/lz.
   */
  private terminatorOrigin(inst: number, tri: number, b1: number, b2: number): void {
    const s = this.scene;
    const g = s.geometries[s.instances.geom[inst]];
    const V = g.verts;
    const N = g.normals;
    const o = tri * 9;
    const b0 = 1 - b1 - b2;
    const px = b0 * V[o] + b1 * V[o + 3] + b2 * V[o + 6];
    const py = b0 * V[o + 1] + b1 * V[o + 4] + b2 * V[o + 7];
    const pz = b0 * V[o + 2] + b1 * V[o + 5] + b2 * V[o + 8];
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let k = 0; k < 3; k++) {
      const n = g.vidx[tri * 3 + k] * 3;
      const d =
        (px - V[o + k * 3]) * N[n] + (py - V[o + k * 3 + 1]) * N[n + 1] + (pz - V[o + k * 3 + 2]) * N[n + 2];
      if (d < 0) {
        const w = (k === 0 ? b0 : k === 1 ? b1 : b2) * d;
        ox -= w * N[n];
        oy -= w * N[n + 1];
        oz -= w * N[n + 2];
      }
    }
    const X = s.instances.xform;
    const xo = inst * 12;
    this.lx = X[xo] * ox + X[xo + 3] * oy + X[xo + 6] * oz;
    this.ly = X[xo + 1] * ox + X[xo + 4] * oy + X[xo + 7] * oz;
    this.lz = X[xo + 2] * ox + X[xo + 5] * oy + X[xo + 8] * oz;
  }

  // ------------------------------------------------------------------ light sampling

  /** Samples a point on lamp `l` as seen from p (into l* fields). */
  private sampleLamp(l: LampData, px: number, py: number, pz: number, u0: number, u1: number): boolean {
    this.lShadow = l.shadow;
    if (l.kind === LAMP_SUN) {
      let dx = -l.nx;
      let dy = -l.ny;
      let dz = -l.nz;
      if (l.radius > 1e-6) {
        const cosT = 1 - u0 * (1 - l.cosMax);
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phi = 2 * Math.PI * u1;
        // frame around the direction towards the sun
        const sgn = dz >= 0 ? 1 : -1;
        const a = -1 / (sgn + dz);
        const bb = dx * dy * a;
        const t1x = 1 + sgn * dx * dx * a;
        const t1y = sgn * bb;
        const t1z = -sgn * dx;
        const t2x = bb;
        const t2y = sgn + dy * dy * a;
        const t2z = -dy;
        const c = sinT * Math.cos(phi);
        const sn = sinT * Math.sin(phi);
        dx = dx * cosT + t1x * c + t2x * sn;
        dy = dy * cosT + t1y * c + t2y * sn;
        dz = dz * cosT + t1z * c + t2z * sn;
        this.lPdf = 1 / (2 * Math.PI * (1 - l.cosMax));
        this.lDelta = false;
      } else {
        this.lPdf = 1;
        this.lDelta = true;
      }
      this.lx = dx;
      this.ly = dy;
      this.lz = dz;
      this.lDist = Infinity;
      this.lr = l.r;
      this.lg = l.g;
      this.lb = l.b;
      return true;
    }
    if (l.kind === LAMP_SPHERE) {
      const cx = l.px - px;
      const cy = l.py - py;
      const cz = l.pz - pz;
      const d2 = cx * cx + cy * cy + cz * cz;
      const d = Math.sqrt(d2);
      if (!(d > 0)) return false;
      const mask = spotMask(l, -cx / d, -cy / d, -cz / d);
      if (mask <= 0) return false;
      const r = l.radius;
      if (r <= 0 || d2 <= r * r * INSIDE_SPHERE) {
        // point light (or inside the sphere): treat as a delta light at the centre
        const k = r > 0 ? (mask * Math.PI * r * r) / d2 : mask / d2;
        this.lx = cx / d;
        this.ly = cy / d;
        this.lz = cz / d;
        this.lDist = d;
        this.lr = l.r * k;
        this.lg = l.g * k;
        this.lb = l.b * k;
        this.lPdf = 1;
        this.lDelta = true;
        return true;
      }
      // uniform cone sampling of the visible cap
      const sin2 = (r * r) / d2;
      const cosMax = Math.sqrt(Math.max(0, 1 - sin2));
      const oneMinus = sin2 < 1e-4 ? sin2 * 0.5 + (sin2 * sin2) / 8 : 1 - cosMax;
      const cosT = 1 - u0 * oneMinus;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const phi = 2 * Math.PI * u1;
      const wx0 = cx / d;
      const wy0 = cy / d;
      const wz0 = cz / d;
      const sgn = wz0 >= 0 ? 1 : -1;
      const a = -1 / (sgn + wz0);
      const bb = wx0 * wy0 * a;
      const c = sinT * Math.cos(phi);
      const sn = sinT * Math.sin(phi);
      const dx = wx0 * cosT + (1 + sgn * wx0 * wx0 * a) * c + bb * sn;
      const dy = wy0 * cosT + sgn * bb * c + (sgn + wy0 * wy0 * a) * sn;
      const dz = wz0 * cosT - sgn * wx0 * c - wy0 * sn;
      // distance to the sphere along the direction
      const tc = d * cosT;
      const disc = r * r - d2 * sinT * sinT;
      this.lDist = tc - Math.sqrt(Math.max(0, disc));
      this.lx = dx;
      this.ly = dy;
      this.lz = dz;
      this.lr = l.r * mask;
      this.lg = l.g * mask;
      this.lb = l.b * mask;
      this.lPdf = 1 / (2 * Math.PI * oneMinus);
      this.lDelta = false;
      return true;
    }
    // area light: uniform point on the shape
    let a: number;
    let b: number;
    if (l.kind === LAMP_RECT) {
      a = 2 * u0 - 1;
      b = 2 * u1 - 1;
    } else {
      const r = Math.sqrt(u0);
      const phi = 2 * Math.PI * u1;
      a = r * Math.cos(phi);
      b = r * Math.sin(phi);
    }
    const qx = l.px + l.ux * a + l.vx * b - px;
    const qy = l.py + l.uy * a + l.vy * b - py;
    const qz = l.pz + l.uz * a + l.vz * b - pz;
    const d2 = qx * qx + qy * qy + qz * qz;
    const d = Math.sqrt(d2);
    if (!(d > 0)) return false;
    const dx = qx / d;
    const dy = qy / d;
    const dz = qz / d;
    const cosL = -(dx * l.nx + dy * l.ny + dz * l.nz);
    if (cosL <= 1e-8) return false;
    this.lx = dx;
    this.ly = dy;
    this.lz = dz;
    this.lDist = d;
    this.lr = l.r;
    this.lg = l.g;
    this.lb = l.b;
    this.lPdf = d2 / (l.area * cosL);
    this.lDelta = false;
    return true;
  }

  /** Solid-angle pdf of `sampleLamp` for a direction that hits lamp `l` at distance t (non-delta lamps). */
  private lampPdf(
    l: LampData,
    px: number,
    py: number,
    pz: number,
    dx: number,
    dy: number,
    dz: number,
    t: number,
  ): number {
    if (l.kind === LAMP_SUN) return l.radius > 1e-6 ? 1 / (2 * Math.PI * (1 - l.cosMax)) : 0;
    if (l.kind === LAMP_SPHERE) {
      const cx = l.px - px;
      const cy = l.py - py;
      const cz = l.pz - pz;
      const d2 = cx * cx + cy * cy + cz * cz;
      const r = l.radius;
      if (r <= 0 || d2 <= r * r * INSIDE_SPHERE) return 0;
      const sin2 = (r * r) / d2;
      const oneMinus = sin2 < 1e-4 ? sin2 * 0.5 + (sin2 * sin2) / 8 : 1 - Math.sqrt(1 - sin2);
      return 1 / (2 * Math.PI * oneMinus);
    }
    const cosL = -(dx * l.nx + dy * l.ny + dz * l.nz);
    return cosL > 1e-8 ? (t * t) / (l.area * cosL) : 0;
  }

  /**
   * True when the current ray (`isect.ray`) hits lamp `l` (non-delta, not the sun) closer than
   * `lampLimit`: the distance goes to `lampT`, the radiance emitted towards the ray origin to
   * lr/lg/lb.
   */
  private hitLamp(l: LampData): boolean {
    const R = this.isect.ray;
    const ox = R[0];
    const oy = R[1];
    const oz = R[2];
    const dx = R[3];
    const dy = R[4];
    const dz = R[5];
    const tMax = this.lampLimit;
    if (l.kind === LAMP_SPHERE) {
      const r = l.radius;
      if (r <= 0) return false;
      const cx = l.px - ox;
      const cy = l.py - oy;
      const cz = l.pz - oz;
      const tc = cx * dx + cy * dy + cz * dz;
      const d2 = cx * cx + cy * cy + cz * cz;
      // from (almost) inside, light sampling treats the lamp as a point light: never hit it
      if (d2 <= r * r * INSIDE_SPHERE) return false;
      const disc = r * r - (d2 - tc * tc);
      if (disc < 0 || tc <= 0) return false;
      const t = tc - Math.sqrt(disc);
      if (!(t > 0) || t >= tMax) return false;
      const d = Math.sqrt(d2);
      const mask = spotMask(l, -cx / d, -cy / d, -cz / d);
      if (mask <= 0) return false;
      this.lr = l.r * mask;
      this.lg = l.g * mask;
      this.lb = l.b * mask;
      this.lampT = t;
      return true;
    }
    if (l.kind !== LAMP_RECT && l.kind !== LAMP_DISK) return false;
    const dn = dx * l.nx + dy * l.ny + dz * l.nz;
    if (dn >= 0) return false; // back side: one-sided emitter
    const t = ((l.px - ox) * l.nx + (l.py - oy) * l.ny + (l.pz - oz) * l.nz) / dn;
    if (!(t > 0) || t >= tMax) return false;
    const qx = ox + dx * t - l.px;
    const qy = oy + dy * t - l.py;
    const qz = oz + dz * t - l.pz;
    // solve q = a·u + b·v
    const uu = l.ux * l.ux + l.uy * l.uy + l.uz * l.uz;
    const vv = l.vx * l.vx + l.vy * l.vy + l.vz * l.vz;
    const uv = l.ux * l.vx + l.uy * l.vy + l.uz * l.vz;
    const qu = qx * l.ux + qy * l.uy + qz * l.uz;
    const qv = qx * l.vx + qy * l.vy + qz * l.vz;
    const det = uu * vv - uv * uv;
    if (!(det > 0)) return false;
    const a = (qu * vv - qv * uv) / det;
    const b = (qv * uu - qu * uv) / det;
    if (l.kind === LAMP_RECT ? Math.abs(a) > 1 || Math.abs(b) > 1 : a * a + b * b > 1) return false;
    this.lr = l.r;
    this.lg = l.g;
    this.lb = l.b;
    this.lampT = t;
    return true;
  }

  /** Samples a point on emitter group k as seen from p (into l* fields). */
  private sampleEmitter(
    k: number,
    px: number,
    py: number,
    pz: number,
    u0: number,
    u1: number,
    uTri: number,
  ): boolean {
    const s = this.scene;
    const grp = s.emitters[k];
    const dist = grp.dist;
    // pick a triangle
    const cdf = dist.cdf;
    let lo = 0;
    let hi = dist.n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] <= uTri) lo = mid;
      else hi = mid;
    }
    const pTri = cdf[lo + 1] - cdf[lo];
    if (!(pTri > 0)) return false;
    const tri = grp.tris[lo];
    const inst = grp.instance;
    const g = s.geometries[s.instances.geom[inst]];
    const su = Math.sqrt(u0);
    const b1 = su * (1 - u1);
    const b2 = su * u1;
    const b0 = 1 - b1 - b2;
    const V = g.verts;
    const o = tri * 9;
    const ox = b0 * V[o] + b1 * V[o + 3] + b2 * V[o + 6];
    const oy = b0 * V[o + 1] + b1 * V[o + 4] + b2 * V[o + 7];
    const oz = b0 * V[o + 2] + b1 * V[o + 5] + b2 * V[o + 8];
    const X = s.instances.xform;
    const xo = inst * 12;
    const qx = X[xo] * ox + X[xo + 3] * oy + X[xo + 6] * oz + X[xo + 9];
    const qy = X[xo + 1] * ox + X[xo + 4] * oy + X[xo + 7] * oz + X[xo + 10];
    const qz = X[xo + 2] * ox + X[xo + 5] * oy + X[xo + 8] * oz + X[xo + 11];
    // world normal of the triangle
    const ex = V[o + 3] - V[o];
    const ey = V[o + 4] - V[o + 1];
    const ez = V[o + 5] - V[o + 2];
    const fx = V[o + 6] - V[o];
    const fy = V[o + 7] - V[o + 1];
    const fz = V[o + 8] - V[o + 2];
    const nx0 = ey * fz - ez * fy;
    const ny0 = ez * fx - ex * fz;
    const nz0 = ex * fy - ey * fx;
    const I = s.instances.inv;
    let nx = I[xo] * nx0 + I[xo + 1] * ny0 + I[xo + 2] * nz0;
    let ny = I[xo + 3] * nx0 + I[xo + 4] * ny0 + I[xo + 5] * nz0;
    let nz = I[xo + 6] * nx0 + I[xo + 7] * ny0 + I[xo + 8] * nz0;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(nl > 0)) return false;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    let dx = qx - px;
    let dy = qy - py;
    let dz = qz - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const d = Math.sqrt(d2);
    if (!(d > 0)) return false;
    dx /= d;
    dy /= d;
    dz /= d;
    const cosL = Math.abs(dx * nx + dy * ny + dz * nz);
    if (cosL < 1e-8) return false;
    const m = this.materialOf(inst, tri);
    const c = this.shadowCtx;
    this.fillContext(c, inst, tri, b1, b2);
    const cov = this.shadowShader.coverage(m, c);
    if (!(cov > 0)) return false;
    this.shadowShader.emission(m, c);
    this.lr = this.shadowShader.emitR * cov;
    this.lg = this.shadowShader.emitG * cov;
    this.lb = this.shadowShader.emitB * cov;
    if (this.lr + this.lg + this.lb <= 0) return false;
    this.lx = dx;
    this.ly = dy;
    this.lz = dz;
    // stop just short of the emitter
    this.lDist = d * (1 - 1e-5);
    this.lPdf = (pTri / grp.area[lo]) * (d2 / cosL);
    this.lDelta = false;
    this.lShadow = true;
    return true;
  }

  // ------------------------------------------------------------------ path tracing

  /** Traces one camera sample for pixel (x, y) with sample index `s` into the output fields. */
  trace(x: number, y: number, s: number): void {
    const st = this.settings;
    const smp = this.sampler;
    const isect = this.isect;
    const bsdf = this.bsdf;
    const shader = this.shader;
    const ctx = this.ctx;
    const env = this.env;
    const lights = this.lights;
    smp.start(x, y, s);
    smp.nextFilter(DIM_FILTER);
    const fx = smp.u0;
    const fy = smp.u1;
    smp.next2D(DIM_LENS);
    // radiance and the part seen directly (emission, background) gathered since the camera chain
    // reached its current surface, and the finished (misted) sums of the surfaces before it
    let Lr = 0;
    let Lg = 0;
    let Lb = 0;
    let Er = 0;
    let Eg = 0;
    let Eb = 0;
    let Fr = 0;
    let Fg = 0;
    let Fb = 0;
    let FEr = 0;
    let FEg = 0;
    let FEb = 0;
    let alpha = 0;
    this.er = this.eg = this.eb = 0;
    this.albR = this.albG = this.albB = 0;
    this.nrmX = this.nrmY = this.nrmZ = 0;
    this.depth = 0;
    if (!this.camera.generate(x + 0.5 + fx, y + 0.5 + fy, smp.u0, smp.u1)) {
      this.r = this.g = this.b = this.a = 0;
      return;
    }
    let ox = this.camera.ox;
    let oy = this.camera.oy;
    let oz = this.camera.oz;
    let dx = this.camera.dx;
    let dy = this.camera.dy;
    let dz = this.camera.dz;
    let tMax = this.camera.tMax;
    let tpR = 1;
    let tpG = 1;
    let tpB = 1;
    let cameraRay = true;
    let travelled = 0;
    // distance from the last scattering vertex (or the camera) to the ray origin, which moves
    // forward through alpha-transparent surfaces and through transmissions that continue the
    // previous vertex's MIS state; MIS densities of lights need the full distance
    let segT = 0;
    let scatters = 0;
    let bounces = 0;
    let transmissions = 0;
    let layers = 0;
    let finalSegment = false;
    // MIS state of the previous scattering vertex
    let prevPdf = 0;
    let prevSingular = true;
    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    // light selection weight sum at the previous vertex (> 0: `lights` still holds its weights)
    let prevTotal = 0;
    // smallest BSDF pdf along the path (filter glossy)
    let minPdf = Infinity;
    // denoising guides
    let aovPending = true;
    let aovSpecular = 0;
    let aovTR = 1;
    let aovTG = 1;
    let aovTB = 1;
    let firstHit = true;
    // the camera chain: the surfaces the camera sees, directly or through transmissions and
    // transparent layers; each fades towards the mist colour by its own view depth
    let chain = true;
    let mist = 0;
    const misty = st.mistDensity > 0;
    const clampK = st.clampIndirect > 0 ? st.clampIndirect : Infinity;
    const thin = this.thin;

    for (;;) {
      // the ray goes through the intersector's scratch array (no boxed arguments)
      const ray = isect.ray;
      ray[0] = ox;
      ray[1] = oy;
      ray[2] = oz;
      ray[3] = dx;
      ray[4] = dy;
      ray[5] = dz;
      ray[6] = tMax;
      const hit = isect.intersectRay();
      const hitT = hit ? isect.t : Infinity;
      // ---- lamps seen by BSDF-sampled rays (lamps are invisible to the camera, never occlude)
      if (!cameraRay && this.scene.lamps.length) {
        const lamps = this.scene.lamps;
        this.lampLimit = hitT;
        for (let i = 0; i < lamps.length; i++) {
          const l = lamps[i];
          if (l.kind === LAMP_SUN || !this.hitLamp(l)) continue;
          const t = this.lampT;
          let w = 1;
          if (!prevSingular) {
            const pSel = prevTotal > 0 ? lights.probability(this.lampSel[i]) : 0;
            w = powerHeuristic(prevPdf, pSel * this.lampPdf(l, prevX, prevY, prevZ, dx, dy, dz, segT + t));
          }
          let cr = tpR * this.lr * w;
          let cg = tpG * this.lg * w;
          let cb = tpB * this.lb * w;
          if (scatters >= 2) {
            const mx = Math.max(cr, cg, cb);
            if (mx > clampK) {
              const k = clampK / mx;
              cr *= k;
              cg *= k;
              cb *= k;
            }
          }
          Lr += cr;
          Lg += cg;
          Lb += cb;
        }
      }
      if (!hit) {
        // ---- escaped
        if (chain && misty && mist > 0) {
          // the background is not misted (like the rasterizer): close the last surface's share
          const k = 1 - mist;
          Fr += Lr * k;
          Fg += Lg * k;
          Fb += Lb * k;
          FEr += Er * k;
          FEg += Eg * k;
          FEb += Eb * k;
          Lr = Lg = Lb = Er = Eg = Eb = 0;
          mist = 0;
        }
        if (cameraRay) {
          if (st.background === BACKGROUND_TRANSPARENT) break;
          let br: number;
          let bg: number;
          let bb: number;
          let ba = 1;
          if (st.background === BACKGROUND_COLOR) {
            br = st.bgR;
            bg = st.bgG;
            bb = st.bgB;
            ba = st.bgA;
          } else {
            env.eval(dx, dy, dz, true);
            br = env.r;
            bg = env.g;
            bb = env.b;
          }
          Lr += br;
          Lg += bg;
          Lb += bb;
          Er += br;
          Eg += bg;
          Eb += bb;
          alpha = ba;
          if (aovPending) {
            this.albR = aovTR;
            this.albG = aovTG;
            this.albB = aovTB;
          }
          break;
        }
        if (!this.scene.environment.black) {
          env.eval(dx, dy, dz);
          let w = 1;
          if (!prevSingular && this.envSel >= 0) {
            const pSel = prevTotal > 0 ? lights.probability(this.envSel) : 0;
            w = powerHeuristic(prevPdf, pSel * env.pdf(dx, dy, dz));
          }
          let cr = tpR * env.r * w;
          let cg = tpG * env.g * w;
          let cb = tpB * env.b * w;
          if (scatters >= 2) {
            const mx = Math.max(cr, cg, cb);
            if (mx > clampK) {
              const k = clampK / mx;
              cr *= k;
              cg *= k;
              cb *= k;
            }
          }
          Lr += cr;
          Lg += cg;
          Lb += cb;
        }
        // sun discs
        const lamps = this.scene.lamps;
        for (let i = 0; i < lamps.length; i++) {
          const l = lamps[i];
          if (l.kind !== LAMP_SUN || !(l.radius > 1e-6)) continue;
          if (-(dx * l.nx + dy * l.ny + dz * l.nz) < l.cosMax) continue;
          let w = 1;
          if (!prevSingular) {
            const pSel = prevTotal > 0 ? lights.probability(this.lampSel[i]) : 0;
            w = powerHeuristic(prevPdf, pSel / (2 * Math.PI * (1 - l.cosMax)));
          }
          let cr = tpR * l.r * w;
          let cg = tpG * l.g * w;
          let cb = tpB * l.b * w;
          if (scatters >= 2) {
            const mx = Math.max(cr, cg, cb);
            if (mx > clampK) {
              const k = clampK / mx;
              cr *= k;
              cg *= k;
              cb *= k;
            }
          }
          Lr += cr;
          Lg += cg;
          Lb += cb;
        }
        if (aovPending) {
          this.albR = aovTR;
          this.albG = aovTG;
          this.albB = aovTB;
        }
        break;
      }

      // ---- surface hit
      const inst = isect.inst;
      const tri = isect.tri;
      const b1 = isect.b1;
      const b2 = isect.b2;
      this.setupHit();
      const m = this.materialOf(inst, tri);
      this.hitMat = m;
      this.fillContext(ctx, inst, tri, b1, b2);
      const frontFacing = this.gx * dx + this.gy * dy + this.gz * dz < 0;
      // alpha transparency and camera-ray backface culling: continue through the surface
      let passThrough = cameraRay && m.cull && !frontFacing;
      // deterministic coverage of alpha-blended surfaces seen by the camera: their emission, direct
      // light and mist are weighted by the coverage (no speckle from faint glows), and only the
      // choice between scattering at the surface and passing through it stays random
      let covScale = 1;
      let splitPass = false;
      if (!passThrough && (m.blend !== 0 || m.transparent)) {
        const cov = shader.coverage(m, ctx);
        if (cov < 1) {
          smp.next2D(DIM_ALPHA + Math.min(scatters, 60) * 64 + Math.min(layers, 63));
          const pass = smp.u0 >= cov;
          if (cameraRay && m.blend === BLEND_BLEND && cov > 0 && layers < st.maxTransparentLayers) {
            covScale = cov;
            splitPass = pass;
          } else passThrough = pass;
        }
      }
      if (passThrough && layers < st.maxTransparentLayers) {
        layers++;
        travelled += hitT;
        segT += hitT;
        const side = frontFacing ? -1 : 1;
        const eps = EPS_SCALE * (1 + Math.max(Math.abs(this.px), Math.abs(this.py), Math.abs(this.pz)));
        ox = this.px + this.gx * side * eps;
        oy = this.py + this.gy * side * eps;
        oz = this.pz + this.gz * side * eps;
        if (tMax !== Infinity) tMax = Math.max(0, tMax - hitT);
        continue;
      }
      if (cameraRay && !splitPass) alpha = 1;
      shader.evaluate(m, ctx);
      // orient the frame towards the viewer
      const flip = frontFacing ? 1 : -1;
      const gnx = this.gx * flip;
      const gny = this.gy * flip;
      const gnz = this.gz * flip;
      this.sx *= flip;
      this.sy *= flip;
      this.sz *= flip;
      if (shader.hasNormalMap) this.applyNormalMap(inst, tri, flip);
      else if (shader.bumpTex) {
        const pr = Math.max(Math.abs(this.px), Math.abs(this.py), Math.abs(this.pz));
        this.applyBump(inst, tri, flip, Math.max(this.camera.footprint(travelled + hitT), 1e-6 * (1 + pr)));
      }
      const wox = -dx;
      const woy = -dy;
      const woz = -dz;
      // keep the reflection of wo above the geometric surface (bend the shading normal)
      let snx = this.sx;
      let sny = this.sy;
      let snz = this.sz;
      if (snx * wox + sny * woy + snz * woz < 1e-3) {
        let ok = false;
        for (let k = 0.25; k <= 8; k *= 2) {
          let ax = snx + gnx * k;
          let ay = sny + gny * k;
          let az = snz + gnz * k;
          const al = Math.sqrt(ax * ax + ay * ay + az * az);
          ax /= al;
          ay /= al;
          az /= al;
          if (ax * wox + ay * woy + az * woz >= 1e-3) {
            snx = ax;
            sny = ay;
            snz = az;
            ok = true;
            break;
          }
        }
        if (!ok) {
          snx = gnx;
          sny = gny;
          snz = gnz;
        }
      }
      const transmissive = shader.transmission > 0 && shader.metallic < 1;
      if (firstHit && !splitPass) {
        firstHit = false;
        this.nrmX = snx;
        this.nrmY = sny;
        this.nrmZ = snz;
        this.depth = travelled + hitT;
      }
      if (chain && misty) {
        // ---- mist (like the rasterizer): what the camera chain gathered at the previous surface
        // fades by that surface's mist, everything from here on by this one's; the mist colour
        // fills in for the part of the view that ends here (not passed on through transmission)
        const k = 1 - mist;
        Fr += Lr * k;
        Fg += Lg * k;
        Fb += Lb * k;
        FEr += Er * k;
        FEg += Eg * k;
        FEb += Eb * k;
        Lr = Lg = Lb = Er = Eg = Eb = 0;
        const cam = this.camera;
        const e = this.scene.camera.eye;
        const zd = (this.px - e[0]) * cam.fx + (this.py - e[1]) * cam.fy + (this.pz - e[2]) * cam.fz;
        const kz = st.mistDensity * zd;
        mist = 1 - Math.exp(-kz * kz);
        if (mist > 0) {
          if (transmissive) thinTransmittance(shader, snx * wox + sny * woy + snz * woz, frontFacing, thin);
          else thin[0] = thin[1] = thin[2] = 0;
          const w = covScale * mist;
          const ir = st.mistR * w * tpR * (1 - thin[0]);
          const ig = st.mistG * w * tpG * (1 - thin[1]);
          const ib = st.mistB * w * tpB * (1 - thin[2]);
          Fr += ir;
          Fg += ig;
          Fb += ib;
          FEr += ir;
          FEg += ig;
          FEb += ib;
        }
      }
      // ---- emission
      if (shader.emitR > 0 || shader.emitG > 0 || shader.emitB > 0) {
        let w = covScale;
        if (!cameraRay && !prevSingular) {
          const k = this.scene.instances.emitGroup[inst];
          let pl = 0;
          if (k >= 0) {
            const grp = this.scene.emitters[k];
            const j = grp.lookup[tri];
            if (j >= 0) {
              const pSel = prevTotal > 0 ? lights.probability(this.meshSel[k]) : 0;
              const cosL = Math.abs(gnx * dx + gny * dy + gnz * dz);
              const dist = segT + hitT;
              if (cosL > 1e-8)
                pl = ((pSel * discretePdf(grp.dist, j)) / grp.area[j]) * ((dist * dist) / cosL);
            }
          }
          w = powerHeuristic(prevPdf, pl);
        }
        let cr = tpR * shader.emitR * w;
        let cg = tpG * shader.emitG * w;
        let cb = tpB * shader.emitB * w;
        if (scatters >= 2) {
          const mx = Math.max(cr, cg, cb);
          if (mx > clampK) {
            const k = clampK / mx;
            cr *= k;
            cg *= k;
            cb *= k;
          }
        }
        Lr += cr;
        Lg += cg;
        Lb += cb;
        if (cameraRay) {
          Er += cr;
          Eg += cg;
          Eb += cb;
        }
      }
      // ---- scattering
      // a surface reached from a vertex that sampled lights (through transmissions or transparent
      // layers) leaves the light behind it to that vertex: its shadow rays pass this surface
      const owned = !prevSingular;
      // local frame (Duff et al. 2017)
      const sgn = snz >= 0 ? 1 : -1;
      const fa = -1 / (sgn + snz);
      const fb = snx * sny * fa;
      const t1x = 1 + sgn * snx * snx * fa;
      const t1y = sgn * fb;
      const t1z = -sgn * snx;
      const t2x = fb;
      const t2y = sgn + sny * sny * fa;
      const t2z = -sny;
      let blurAlpha = 0;
      if (st.filterGlossy > 0 && minPdf < Infinity) {
        const blurPdf = minPdf / st.filterGlossy;
        if (blurPdf < 1) blurAlpha = Math.sqrt(1 - blurPdf) * 0.5;
      }
      // glass seen from such a vertex is thin-walled, like in its shadow rays: it reflects like a
      // sheet and transmits straight through (no refraction, no total internal reflection)
      bsdf.setup(
        shader,
        wox * t1x + woy * t1y + woz * t1z,
        wox * t2x + woy * t2y + woz * t2z,
        wox * snx + woy * sny + woz * snz,
        frontFacing,
        blurAlpha,
        owned && transmissive,
      );
      if (aovPending && !splitPass) {
        if (bsdf.singular && aovSpecular < 2) {
          aovSpecular++;
          aovTR *= Math.max(0.05, bsdf.albedoR);
          aovTG *= Math.max(0.05, bsdf.albedoG);
          aovTB *= Math.max(0.05, bsdf.albedoB);
        } else {
          aovPending = false;
          this.albR = aovTR * bsdf.albedoR;
          this.albG = aovTG * bsdf.albedoG;
          this.albB = aovTB * bsdf.albedoB;
        }
      }
      // the bounce limit was reached: this segment only collected (MIS-weighted) emission
      if (finalSegment) break;
      if (!bsdf.active && !splitPass) break;
      // alpha-blended surfaces scattered at with deterministic coverage get their own dimensions
      // (the surface behind them is shaded in the same sample)
      const dimBase = covScale < 1 ? DIM_SPLIT + 3 * layers : DIM_VERTEX + 3 * scatters;
      const eps = EPS_SCALE * (1 + Math.max(Math.abs(this.px), Math.abs(this.py), Math.abs(this.pz)));
      // light selection and BSDF lobe choice share one 2D point
      smp.next2D(dimBase + 2);
      const uSel = smp.u0;
      const uLobe = smp.u1;
      // ---- next-event estimation
      let selTotal = 0;
      let savedSel = false;
      if (bsdf.active && !bsdf.singular && lights.count > 0) {
        // the previous vertex's selection weights, for transmissions that continue its MIS state
        if (owned && transmissive && prevTotal > 0) {
          lights.save();
          savedSel = true;
        }
        selTotal = lights.prepare(this.px, this.py, this.pz, gnx, gny, gnz, transmissive && !owned);
        const group = lights.pick(uSel);
        if (group >= 0) {
          const pSel = lights.prob;
          const uRest = lights.uRest;
          smp.next2D(dimBase + 1);
          const kind = this.scene.lightKinds[group];
          const ref = this.scene.lightRefs[group];
          let ok: boolean;
          if (kind === GROUP_LAMP)
            ok = this.sampleLamp(this.scene.lamps[ref], this.px, this.py, this.pz, smp.u0, smp.u1);
          else if (kind === GROUP_MESH)
            ok = this.sampleEmitter(ref, this.px, this.py, this.pz, smp.u0, smp.u1, uRest);
          else {
            ok = env.sample(smp.u0, smp.u1, uRest);
            if (ok) {
              this.lx = env.dx;
              this.ly = env.dy;
              this.lz = env.dz;
              this.lDist = Infinity;
              this.lr = env.r;
              this.lg = env.g;
              this.lb = env.b;
              this.lPdf = env.pdfValue;
              this.lDelta = false;
              this.lShadow = true;
            }
          }
          if (ok && this.lPdf > 0) {
            const wx = this.lx;
            const wy = this.ly;
            const wz = this.lz;
            const geomSide = wx * gnx + wy * gny + wz * gnz;
            const ilx = wx * t1x + wy * t1y + wz * t1z;
            const ily = wx * t2x + wy * t2y + wz * t2z;
            const ilz = wx * snx + wy * sny + wz * snz;
            // reflection must stay above, transmission below the geometric surface; light behind
            // a surface owned by the previous vertex is that vertex's
            if (geomSide > 0 === ilz > 0 && geomSide !== 0 && !(owned && geomSide < 0)) {
              bsdf.eval(ilx, ily, ilz);
              if (bsdf.fR + bsdf.fG + bsdf.fB > 0) {
                const lightPdf = this.lPdf * pSel;
                const w = this.lDelta ? 1 : powerHeuristic(lightPdf, bsdf.pdf);
                let vr = 1;
                let vg = 1;
                let vb = 1;
                if (this.lShadow) {
                  const side = geomSide > 0 ? 1 : -1;
                  let sox = this.px + gnx * side * eps;
                  let soy = this.py + gny * side * eps;
                  let soz = this.pz + gnz * side * eps;
                  const lift =
                    this.smoothTri && side > 0 && frontFacing ? terminatorAmount(geomSide, ilz) : 0;
                  if (lift > 0) {
                    const lx = this.lx;
                    const ly = this.ly;
                    const lz = this.lz;
                    const ld = this.lDist;
                    this.terminatorOrigin(inst, tri, b1, b2);
                    sox += this.lx * lift;
                    soy += this.ly * lift;
                    soz += this.lz * lift;
                    this.lx = lx;
                    this.ly = ly;
                    this.lz = lz;
                    this.lDist = ld;
                  }
                  const tShadow = this.lDist === Infinity ? Infinity : this.lDist * (1 - 1e-6) - eps;
                  const ray = isect.ray;
                  ray[0] = sox;
                  ray[1] = soy;
                  ray[2] = soz;
                  ray[3] = wx;
                  ray[4] = wy;
                  ray[5] = wz;
                  ray[6] = tShadow;
                  this.shR = this.shG = this.shB = 1;
                  if (isect.occludedRay()) vr = vg = vb = 0;
                  else {
                    vr = this.shR;
                    vg = this.shG;
                    vb = this.shB;
                  }
                }
                if (vr + vg + vb > 0) {
                  const k = (w * covScale) / lightPdf;
                  let cr = tpR * bsdf.fR * this.lr * k * vr;
                  let cg = tpG * bsdf.fG * this.lg * k * vg;
                  let cb = tpB * bsdf.fB * this.lb * k * vb;
                  if (scatters >= 1) {
                    const mx = Math.max(cr, cg, cb);
                    if (mx > clampK) {
                      const kk = clampK / mx;
                      cr *= kk;
                      cg *= kk;
                      cb *= kk;
                    }
                  }
                  Lr += cr;
                  Lg += cg;
                  Lb += cb;
                }
              }
            }
          }
        }
      }
      if (splitPass) {
        // the camera ray passes the uncovered part of the alpha-blended surface
        layers++;
        travelled += hitT;
        segT += hitT;
        const side = frontFacing ? -1 : 1;
        ox = this.px + this.gx * side * eps;
        oy = this.py + this.gy * side * eps;
        oz = this.pz + this.gz * side * eps;
        if (tMax !== Infinity) tMax = Math.max(0, tMax - hitT);
        continue;
      }
      // ---- BSDF sampling
      smp.next2D(dimBase);
      if (!bsdf.sample(smp.u0, smp.u1, uLobe)) break;
      const transmission = bsdf.sampledTransmission;
      // beyond the bounce limit the ray is still traced, but only to find the light it hits
      // (completes the MIS of this vertex's direct lighting), not to scatter again
      if (
        bounces + transmissions >= st.maxBounces ||
        (transmission && transmissions >= st.maxTransmissionBounces)
      )
        finalSegment = true;
      // (a delta pass-through, i.e. index-matched glass, continues exactly along the ray)
      const delta = bsdf.sampledDelta;
      const nwx = delta ? dx : bsdf.wx * t1x + bsdf.wy * t2x + bsdf.wz * snx;
      const nwy = delta ? dy : bsdf.wx * t1y + bsdf.wy * t2y + bsdf.wz * sny;
      const nwz = delta ? dz : bsdf.wx * t1z + bsdf.wy * t2z + bsdf.wz * snz;
      const gside = nwx * gnx + nwy * gny + nwz * gnz;
      if (transmission ? gside >= 0 : gside <= 0) break;
      const ip = 1 / bsdf.pdf;
      tpR *= bsdf.fR * ip;
      tpG *= bsdf.fG * ip;
      tpB *= bsdf.fB * ip;
      if (transmission) transmissions++;
      else {
        bounces++;
        chain = false;
      }
      if (transmission && owned) {
        // the previous vertex's shadow rays pass this surface (thin-walled): what the ray finds
        // through it is weighed against that vertex's light sampling, so the transmission keeps
        // its MIS state like a transparent layer (no light is counted twice)
        if (savedSel) lights.restore();
        segT += hitT;
      } else {
        prevPdf = bsdf.pdf;
        prevSingular = bsdf.singular || delta;
        prevX = this.px;
        prevY = this.py;
        prevZ = this.pz;
        prevTotal = selTotal;
        segT = 0;
      }
      if (!delta && bsdf.pdf < minPdf) minPdf = bsdf.pdf;
      scatters++;
      cameraRay = false;
      if (!(tpR + tpG + tpB > 0) || !Number.isFinite(tpR + tpG + tpB)) break;
      // Russian roulette after three scattering events
      if (scatters >= 3 && !finalSegment) {
        const q = Math.min(1, Math.max(tpR, tpG, tpB));
        smp.next2D(DIM_RR + scatters);
        if (smp.u0 >= q) break;
        tpR /= q;
        tpG /= q;
        tpB /= q;
      }
      const side = gside > 0 ? 1 : -1;
      ox = this.px + gnx * side * eps;
      oy = this.py + gny * side * eps;
      oz = this.pz + gnz * side * eps;
      dx = nwx;
      dy = nwy;
      dz = nwz;
      tMax = Infinity;
    }
    const k = 1 - mist;
    Fr += Lr * k;
    Fg += Lg * k;
    Fb += Lb * k;
    FEr += Er * k;
    FEg += Eg * k;
    FEb += Eb * k;
    if (!(Number.isFinite(Fr) && Number.isFinite(Fg) && Number.isFinite(Fb))) {
      Fr = Fg = Fb = 0;
      FEr = FEg = FEb = 0;
    }
    this.r = Fr;
    this.g = Fg;
    this.b = Fb;
    this.er = FEr;
    this.eg = FEg;
    this.eb = FEb;
    this.a = alpha;
  }
}
