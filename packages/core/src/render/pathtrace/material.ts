import type { Vec3 } from '../../math/types';
import type { MaterialData, TextureSlot } from '../../doc/types';
import { sampleCompiled, type CompiledProcedural } from '../../material/procedural';
import { compiledCoord, proceduralSurface, type ProceduralSurface } from '../../material/surface';
import type { SampledTexture } from '../raster';

/*
 * Materials for the path tracer: MaterialData compiled to plain numbers plus texture references,
 * and their evaluation at a hit point.
 *
 * Image textures follow the viewport (three.js / glTF) conventions used by the editor: base_color
 * (sRGB) multiplies the base colour and alpha, roughness reads G and metallic reads B (glTF
 * packing), normal is a tangent-space normal map (OpenGL convention, `normal_strength`), emission
 * (sRGB) multiplies the emission colour, alpha reads G. UVs are transformed by the slot's
 * scale/offset; V points up (row 0 of the image is v = 1).
 *
 * Procedural textures (see material/surface.ts) replace the value they are plugged into, like in
 * Blender: base_color RGB (its alpha multiplies alpha), emission RGB (× emission_strength),
 * metallic/roughness/alpha from red; a procedural normal slot bumps the normal with its red channel
 * as a height field. A procedural slot takes precedence over an image in the same slot.
 *
 * Transparency: OPAQUE ignores alpha (like the rasterizer and the viewport), CLIP is binary at
 * `alpha_threshold`, BLEND is stochastic coverage. Vertex colours multiply the base colour.
 */

export interface TextureRef {
  /** Index into the scene's image list. */
  image: number;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
}

export const BLEND_OPAQUE = 0;
export const BLEND_CLIP = 1;
export const BLEND_BLEND = 2;

export interface PTMaterial {
  name: string;
  baseR: number;
  baseG: number;
  baseB: number;
  alpha: number;
  blend: number;
  threshold: number;
  metallic: number;
  roughness: number;
  ior: number;
  transmission: number;
  coat: number;
  coatRoughness: number;
  sheen: number;
  sheenR: number;
  sheenG: number;
  sheenB: number;
  /** Emission colour × strength (linear radiance). */
  emitR: number;
  emitG: number;
  emitB: number;
  emissionStrength: number;
  normalStrength: number;
  cull: boolean;
  texBase: TextureRef | null;
  texMetallic: TextureRef | null;
  texRoughness: TextureRef | null;
  texNormal: TextureRef | null;
  texEmission: TextureRef | null;
  texAlpha: TextureRef | null;
  /** Compiled procedural channels (null when the material has none). */
  procedural: ProceduralSurface | null;
  /** May be (partly) transparent: CLIP/BLEND with alpha < 1 or alpha-carrying textures. */
  transparent: boolean;
  /** Emits light. */
  emissive: boolean;
}

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const nonNeg = (v: unknown, d: number) => Math.max(0, fin(v, d));

/** The material of objects without one (0.8 grey, roughness 0.5, IOR 1.5). */
export function defaultPTMaterial(): PTMaterial {
  return compileMaterial(null, () => -1);
}

/**
 * Compiles a material. `imageIndex` maps an image datablock id to an index into the scene's image
 * list (−1 when missing or undecodable).
 */
export function compileMaterial(m: MaterialData | null, imageIndex: (id: string) => number): PTMaterial {
  let procedural: ProceduralSurface | null;
  try {
    procedural = proceduralSurface(m);
  } catch {
    procedural = null;
  }
  const slot = (s: TextureSlot | null | undefined, proc: CompiledProcedural | null): TextureRef | null => {
    if (!s || proc || (s.procedural && typeof s.procedural === 'object')) return null;
    const image = s.image ? imageIndex(s.image) : -1;
    if (image < 0) return null;
    return {
      image,
      sx: fin(s.scale?.[0], 1),
      sy: fin(s.scale?.[1], 1),
      ox: fin(s.offset?.[0], 0),
      oy: fin(s.offset?.[1], 0),
    };
  };
  const bc = m?.base_color ?? [0.8, 0.8, 0.8, 1];
  const blend =
    m?.blend_method === 'CLIP' ? BLEND_CLIP : m?.blend_method === 'BLEND' ? BLEND_BLEND : BLEND_OPAQUE;
  // a procedural alpha channel replaces the material alpha (base colour alpha still applies)
  const alpha = clamp01(fin(bc[3], 1) * (procedural?.alpha ? 1 : fin(m?.alpha, 1)));
  const es = nonNeg(m?.emission_strength, 0);
  const ec = m?.emission_color ?? [1, 1, 1];
  const t = m?.textures ?? {};
  const p = procedural;
  const out: PTMaterial = {
    name: m?.name ?? 'Default',
    baseR: nonNeg(bc[0], 0.8),
    baseG: nonNeg(bc[1], 0.8),
    baseB: nonNeg(bc[2], 0.8),
    alpha,
    blend,
    threshold: fin(m?.alpha_threshold, 0.5),
    metallic: clamp01(fin(m?.metallic, 0)),
    roughness: clamp01(fin(m?.roughness, 0.5)),
    ior: Math.max(1e-3, fin(m?.ior, 1.5)),
    transmission: clamp01(fin(m?.transmission, 0)),
    coat: clamp01(fin(m?.coat_weight, 0)),
    coatRoughness: clamp01(fin(m?.coat_roughness, 0.03)),
    sheen: clamp01(fin(m?.sheen_weight, 0)),
    sheenR: nonNeg(m?.sheen_tint?.[0], 1),
    sheenG: nonNeg(m?.sheen_tint?.[1], 1),
    sheenB: nonNeg(m?.sheen_tint?.[2], 1),
    emitR: nonNeg(ec[0], 1) * es,
    emitG: nonNeg(ec[1], 1) * es,
    emitB: nonNeg(ec[2], 1) * es,
    emissionStrength: es,
    normalStrength: nonNeg(m?.normal_strength, 1),
    cull: !!m?.use_backface_culling,
    texBase: slot(t.base_color, p?.base_color ?? null),
    texMetallic: slot(t.metallic, p?.metallic ?? null),
    texRoughness: slot(t.roughness, p?.roughness ?? null),
    texNormal: slot(t.normal, p?.normal ?? null),
    texEmission: slot(t.emission, p?.emission ?? null),
    texAlpha: slot(t.alpha, p?.alpha ?? null),
    procedural,
    transparent: false,
    emissive: false,
  };
  out.transparent =
    blend !== BLEND_OPAQUE && (alpha < 1 || !!out.texBase || !!out.texAlpha || !!p?.base_color || !!p?.alpha);
  out.emissive = p?.emission ? es > 0 : out.emitR + out.emitG + out.emitB > 0;
  return out;
}

const SRGB_LUT = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** Texture coordinates of a hit point (object space, generated box, UV, vertex colour). */
export class ShadingContext {
  u = 0;
  v = 0;
  hasUV = false;
  /** Object-space position. */
  px = 0;
  py = 0;
  pz = 0;
  /** Undeformed object-space position (orco) for GENERATED coordinates (= px/py/pz when undeformed). */
  gx = 0;
  gy = 0;
  gz = 0;
  /** Generated-coordinate box (object space) of the instance: min and size. */
  genMin: Vec3 = [0, 0, 0];
  genSize: Vec3 = [1, 1, 1];
  /** Interpolated vertex colour (1 when the mesh has none). */
  cr = 1;
  cg = 1;
  cb = 1;
  ca = 1;
}

/**
 * Evaluates a material at a hit point into its output fields (no allocations).
 */
export class SurfaceShader {
  baseR = 0.8;
  baseG = 0.8;
  baseB = 0.8;
  alpha = 1;
  metallic = 0;
  roughness = 0.5;
  ior = 1.5;
  transmission = 0;
  coat = 0;
  coatRoughness = 0.03;
  sheen = 0;
  sheenR = 1;
  sheenG = 1;
  sheenB = 1;
  emitR = 0;
  emitG = 0;
  emitB = 0;
  /** Tangent-space normal from the image normal map (when hasNormalMap). */
  hasNormalMap = false;
  nmx = 0;
  nmy = 0;
  nmz = 1;
  /** Procedural height field for bump mapping (red × bumpDistance metres), or null. */
  bumpTex: CompiledProcedural | null = null;
  bumpDistance = 0;
  // texture sample
  private tr = 1;
  private tg = 1;
  private tb = 1;
  private ta = 1;
  private readonly pv = new Float64Array(4);
  private readonly coord = new Float64Array(3);

  constructor(private readonly images: readonly (SampledTexture | null)[]) {}

  /** Full evaluation of the surface parameters. */
  evaluate(m: PTMaterial, c: ShadingContext): void {
    const p = m.procedural;
    let br = m.baseR;
    let bg = m.baseG;
    let bb = m.baseB;
    let alpha = m.alpha * c.ca;
    if (p?.base_color) {
      this.proc(p.base_color, c);
      const v = this.pv;
      br = v[0] > 0 ? v[0] : 0;
      bg = v[1] > 0 ? v[1] : 0;
      bb = v[2] > 0 ? v[2] : 0;
      alpha *= clamp01(v[3]);
    } else if (m.texBase && this.image(m.texBase, c, true)) {
      br *= this.tr;
      bg *= this.tg;
      bb *= this.tb;
      alpha *= this.ta;
    }
    br *= c.cr;
    bg *= c.cg;
    bb *= c.cb;
    let metallic = m.metallic;
    if (p?.metallic) {
      this.proc(p.metallic, c);
      metallic = this.pv[0];
    } else if (m.texMetallic && this.image(m.texMetallic, c, false)) metallic *= this.tb;
    let roughness = m.roughness;
    if (p?.roughness) {
      this.proc(p.roughness, c);
      roughness = this.pv[0];
    } else if (m.texRoughness && this.image(m.texRoughness, c, false)) roughness *= this.tg;
    let er = m.emitR;
    let eg = m.emitG;
    let eb = m.emitB;
    if (p?.emission) {
      if (m.emissionStrength > 0) {
        this.proc(p.emission, c);
        const v = this.pv;
        er = (v[0] > 0 ? v[0] : 0) * m.emissionStrength;
        eg = (v[1] > 0 ? v[1] : 0) * m.emissionStrength;
        eb = (v[2] > 0 ? v[2] : 0) * m.emissionStrength;
      }
    } else if (m.texEmission && (er > 0 || eg > 0 || eb > 0) && this.image(m.texEmission, c, true)) {
      er *= this.tr;
      eg *= this.tg;
      eb *= this.tb;
    }
    if (p?.alpha) {
      this.proc(p.alpha, c);
      alpha *= clamp01(this.pv[0]);
    } else if (m.texAlpha && this.image(m.texAlpha, c, false)) alpha *= this.tg;
    this.hasNormalMap = false;
    this.bumpTex = null;
    if (p?.normal) {
      if (p.bump !== 0 && Number.isFinite(p.bump)) {
        this.bumpTex = p.normal;
        this.bumpDistance = p.bump;
      }
    } else if (m.texNormal && m.normalStrength > 0 && c.hasUV && this.image(m.texNormal, c, false)) {
      this.hasNormalMap = true;
      this.nmx = this.tr * 2 - 1;
      this.nmy = this.tg * 2 - 1;
      this.nmz = this.tb * 2 - 1;
    }
    this.baseR = br;
    this.baseG = bg;
    this.baseB = bb;
    this.alpha = clamp01(alpha);
    this.metallic = clamp01(metallic);
    this.roughness = clamp01(roughness);
    this.ior = m.ior;
    this.transmission = m.transmission;
    this.coat = m.coat;
    this.coatRoughness = m.coatRoughness;
    this.sheen = m.sheen;
    this.sheenR = m.sheenR;
    this.sheenG = m.sheenG;
    this.sheenB = m.sheenB;
    this.emitR = er;
    this.emitG = eg;
    this.emitB = eb;
  }

  /** Coverage of the surface (1 = opaque): OPAQUE → 1, CLIP → 0/1, BLEND → alpha. */
  coverage(m: PTMaterial, c: ShadingContext): number {
    if (m.blend === BLEND_OPAQUE) return 1;
    const p = m.procedural;
    let alpha = m.alpha * c.ca;
    if (p?.base_color) {
      this.proc(p.base_color, c);
      alpha *= clamp01(this.pv[3]);
    } else if (m.texBase && this.image(m.texBase, c, true)) alpha *= this.ta;
    if (p?.alpha) {
      this.proc(p.alpha, c);
      alpha *= clamp01(this.pv[0]);
    } else if (m.texAlpha && this.image(m.texAlpha, c, false)) alpha *= this.tg;
    alpha = clamp01(alpha);
    if (m.blend === BLEND_CLIP) return alpha >= m.threshold ? 1 : 0;
    return alpha;
  }

  /** Emission only (for light sampling of emissive triangles), into emitR/G/B. */
  emission(m: PTMaterial, c: ShadingContext): void {
    let er = m.emitR;
    let eg = m.emitG;
    let eb = m.emitB;
    const p = m.procedural;
    if (p?.emission) {
      this.proc(p.emission, c);
      const v = this.pv;
      er = (v[0] > 0 ? v[0] : 0) * m.emissionStrength;
      eg = (v[1] > 0 ? v[1] : 0) * m.emissionStrength;
      eb = (v[2] > 0 ? v[2] : 0) * m.emissionStrength;
    } else if (m.texEmission && (er > 0 || eg > 0 || eb > 0) && this.image(m.texEmission, c, true)) {
      er *= this.tr;
      eg *= this.tg;
      eb *= this.tb;
    }
    this.emitR = er;
    this.emitG = eg;
    this.emitB = eb;
  }

  /**
   * Texture coordinate of a compiled procedural's mapping at the context's point, into `out`
   * (GENERATED from the undeformed position, OBJECT from the evaluated one, like Blender).
   */
  textureCoord(t: CompiledProcedural, c: ShadingContext, out: Float64Array | number[]): void {
    const gen = t.mapping === 0;
    compiledCoord(
      t.mapping,
      gen ? c.gx : c.px,
      gen ? c.gy : c.py,
      gen ? c.gz : c.pz,
      c.genMin,
      c.genSize,
      c.hasUV ? c.u : 0,
      c.hasUV ? c.v : 0,
      out,
    );
  }

  /** Samples a procedural channel into `pv` (RGBA; zero on failure). */
  private proc(t: CompiledProcedural, c: ShadingContext): void {
    const co = this.coord;
    this.textureCoord(t, c, co);
    try {
      sampleCompiled(t, co[0], co[1], co[2], this.pv);
    } catch {
      this.pv.fill(0);
    }
    const v = this.pv;
    for (let i = 0; i < 4; i++) if (!Number.isFinite(v[i])) v[i] = 0;
  }

  /** Samples an image slot into tr/tg/tb/ta; false when there is nothing to sample. */
  private image(t: TextureRef, c: ShadingContext, srgb: boolean): boolean {
    const img = this.images[t.image];
    if (!img || !c.hasUV) return false;
    sampleImage(img, c.u * t.sx + t.ox, c.v * t.sy + t.oy, srgb, this);
    return true;
  }

  /** @internal */
  setSample(r: number, g: number, b: number, a: number): void {
    this.tr = r;
    this.tg = g;
    this.tb = b;
    this.ta = a;
  }
}

/** Bilinear, repeat-wrapped lookup (V up), linearized from sRGB when `srgb`. */
function sampleImage(t: SampledTexture, u: number, v: number, srgb: boolean, out: SurfaceShader): void {
  const w = t.width;
  const h = t.height;
  if (!(Number.isFinite(u) && Number.isFinite(v))) {
    u = 0;
    v = 0;
  }
  const fx = u * w - 0.5;
  const fy = (1 - v) * h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const xa = ((x0 % w) + w) % w;
  const ya = ((y0 % h) + h) % h;
  const xb = xa + 1 === w ? 0 : xa + 1;
  const yb = ya + 1 === h ? 0 : ya + 1;
  const d = t.data;
  const i00 = (ya * w + xa) * 4;
  const i10 = (ya * w + xb) * 4;
  const i01 = (yb * w + xa) * 4;
  const i11 = (yb * w + xb) * 4;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  let r: number;
  let g: number;
  let b: number;
  if (srgb) {
    const L = SRGB_LUT;
    r = L[d[i00]] * w00 + L[d[i10]] * w10 + L[d[i01]] * w01 + L[d[i11]] * w11;
    g = L[d[i00 + 1]] * w00 + L[d[i10 + 1]] * w10 + L[d[i01 + 1]] * w01 + L[d[i11 + 1]] * w11;
    b = L[d[i00 + 2]] * w00 + L[d[i10 + 2]] * w10 + L[d[i01 + 2]] * w01 + L[d[i11 + 2]] * w11;
  } else {
    const k = 1 / 255;
    r = (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11) * k;
    g = (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11) * k;
    b = (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11) * k;
  }
  const a = (d[i00 + 3] * w00 + d[i10 + 3] * w10 + d[i01 + 3] * w01 + d[i11 + 3] * w11) / 255;
  out.setSample(r, g, b, a);
}
