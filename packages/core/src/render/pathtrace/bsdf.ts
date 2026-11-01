/*
 * Principled-style BSDF for the path tracer, evaluated in a local shading frame (z = shading
 * normal, oriented towards the outgoing direction wo).
 *
 * Layers (outermost first), combined with directional-albedo scaling like Blender 4's Principled
 * BSDF:
 *   sheen (microfiber, Charlie distribution, roughness 0.5) →
 *   coat (GGX dielectric, IOR 1.5, coat_roughness) →
 *   base = metallic · metal (GGX, Schlick Fresnel tinted by base colour)
 *        + (1 − metallic) · transmission · glass (rough dielectric reflection + refraction, IOR)
 *        + (1 − metallic) · (1 − transmission) · (dielectric GGX specular over Lambert diffuse).
 * GGX uses α = roughness², the height-correlated Smith masking term, visible-normal sampling and an
 * energy compensation of the single-scattering loss (like Blender's multiscatter GGX) for the
 * reflection lobes and the glass lobe. Glass with IOR 1 does not bend light: its transmission is a
 * delta lobe straight through the surface, whatever the roughness.
 *
 * Sampling picks one lobe in proportion to its approximate albedo and returns the full BSDF value
 * and the combined pdf of all lobes (one-sample MIS over lobes).
 */

const INV_PI = 1 / Math.PI;
/** Smallest GGX α (roughness 0.01); avoids singular distributions. */
const ALPHA_MIN = 1e-4;
/** Lobes narrower than this α are treated as specular (no light sampling, MIS weight 1). */
export const SPECULAR_ALPHA = 1e-3;
const COAT_IOR = 1.5;

// ------------------------------------------------------------------ microfacet helpers

/** GGX normal distribution for a half vector with cosine `z` to the normal. */
function ggxD(z: number, a2: number): number {
  if (z <= 0) return 0;
  const z2 = z * z;
  const d = z2 * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

/** Smith Λ for a direction with cosine `z` to the normal. */
function ggxLambda(z: number, a2: number): number {
  const z2 = z * z;
  if (z2 >= 1) return 0;
  if (z2 <= 0) return 1e30;
  return (Math.sqrt(1 + (a2 * (1 - z2)) / z2) - 1) * 0.5;
}

/** Exact unpolarized Fresnel reflectance of a dielectric interface (cosine on the incident side, relative IOR eta). */
export function fresnelDielectric(cosI: number, eta: number): number {
  const c = Math.abs(cosI);
  let g = eta * eta - 1 + c * c;
  if (g <= 0) return 1; // total internal reflection
  g = Math.sqrt(g);
  const a = (g - c) / (g + c);
  const b = (c * (g + c) - 1) / (c * (g - c) + 1);
  return 0.5 * a * a * (1 + b * b);
}

function schlickWeight(c: number): number {
  const m = Math.min(1, Math.max(0, 1 - c));
  const m2 = m * m;
  return m2 * m2 * m;
}

// ------------------------------------------------------------------ precomputed albedo tables

const TABLE_N = 32;
let sheenTable: Float32Array | null = null;

/** Visible-normal sample of GGX (spherical-cap method); result in the given array. */
function sampleVNDF(
  wx: number,
  wy: number,
  wz: number,
  alpha: number,
  u0: number,
  u1: number,
  out: Float64Array,
): void {
  // stretch the view vector to the unit-roughness configuration
  let vx = alpha * wx;
  let vy = alpha * wy;
  let vz = wz;
  const l = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
  vx *= l;
  vy *= l;
  vz *= l;
  const phi = 2 * Math.PI * u0;
  const z = (1 - u1) * (1 + vz) - vz;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  const hx = s * Math.cos(phi) + vx;
  const hy = s * Math.sin(phi) + vy;
  const hz = z + vz;
  // unstretch
  let mx = alpha * hx;
  let my = alpha * hy;
  let mz = Math.max(0, hz);
  const ml = Math.sqrt(mx * mx + my * my + mz * mz);
  if (ml > 0) {
    mx /= ml;
    my /= ml;
    mz /= ml;
  } else {
    mx = 0;
    my = 0;
    mz = 1;
  }
  out[0] = mx;
  out[1] = my;
  out[2] = mz;
}

/** F0 levels of the dielectric albedo table: F0 = 0.25 · (k / (N − 1))², i.e. IOR 1 … 3. */
const F0_N = 8;
const F0_MAX = 0.25;
let e1Table: Float32Array | null = null;
let dielTable: Float32Array | null = null;

/**
 * Directional albedo tables of a GGX reflection lobe over μ = cos θo and roughness (32×32):
 * `E1` with Fresnel = 1 (for the energy compensation) and, per F0 level, with the exact dielectric
 * Fresnel (for layering the diffuse base and the coat under their specular lobes).
 */
function buildAlbedoTables(): void {
  const e1 = new Float32Array(TABLE_N * TABLE_N);
  const dt = new Float32Array(TABLE_N * TABLE_N * F0_N);
  const h = new Float64Array(3);
  const S = 8;
  const etas = new Float64Array(F0_N);
  for (let k = 0; k < F0_N; k++) {
    const r = Math.sqrt(F0_MAX) * (k / (F0_N - 1));
    etas[k] = (1 + r) / (1 - r);
  }
  for (let j = 0; j < TABLE_N; j++) {
    const rough = j / (TABLE_N - 1);
    const alpha = Math.max(ALPHA_MIN, rough * rough);
    const a2 = alpha * alpha;
    for (let i = 0; i < TABLE_N; i++) {
      const mu = Math.max(0.02, i / (TABLE_N - 1));
      const wx = Math.sqrt(1 - mu * mu);
      const wz = mu;
      const lo = ggxLambda(wz, a2);
      let E = 0;
      const Ed = new Float64Array(F0_N);
      for (let a = 0; a < S; a++)
        for (let b = 0; b < S; b++) {
          sampleVNDF(wx, 0, wz, alpha, (a + 0.5) / S, (b + 0.5) / S, h);
          const c = wx * h[0] + wz * h[2];
          if (c <= 0) continue;
          const iz = 2 * c * h[2] - wz;
          if (iz <= 0) continue;
          const w = (1 + lo) / (1 + lo + ggxLambda(iz, a2)); // G2 / G1(wo)
          E += w;
          for (let k = 1; k < F0_N; k++) Ed[k] += w * fresnelDielectric(c, etas[k]);
        }
      const o = j * TABLE_N + i;
      e1[o] = E / (S * S);
      for (let k = 0; k < F0_N; k++) dt[o * F0_N + k] = Ed[k] / (S * S);
    }
  }
  e1Table = e1;
  dielTable = dt;
}

/** Bilinear table coordinates of (μ, roughness). */
function tableCoords(mu: number, rough: number): void {
  const x = Math.min(1, Math.max(0, (mu - 0.02) / 0.98)) * (TABLE_N - 1);
  const y = Math.min(1, Math.max(0, rough)) * (TABLE_N - 1);
  const i = Math.min(TABLE_N - 2, Math.floor(x));
  const j = Math.min(TABLE_N - 2, Math.floor(y));
  TC.i = i;
  TC.j = j;
  TC.fx = x - i;
  TC.fy = y - j;
}
const TC = { i: 0, j: 0, fx: 0, fy: 0 };

/** Albedo of a GGX lobe with Fresnel 1 (single scattering). */
function albedoE1(mu: number, rough: number): number {
  if (!e1Table) buildAlbedoTables();
  const t = e1Table!;
  tableCoords(mu, rough);
  const o = TC.j * TABLE_N + TC.i;
  const { fx, fy } = TC;
  return (
    t[o] * (1 - fx) * (1 - fy) +
    t[o + 1] * fx * (1 - fy) +
    t[o + TABLE_N] * (1 - fx) * fy +
    t[o + TABLE_N + 1] * fx * fy
  );
}

/** Albedo of a GGX lobe with the exact dielectric Fresnel of normal reflectance f0 (≤ 0.25). */
function albedoDielectric(mu: number, rough: number, f0: number): number {
  if (!dielTable) buildAlbedoTables();
  const t = dielTable!;
  tableCoords(mu, rough);
  const kf = Math.min(1, Math.sqrt(Math.max(0, f0) / F0_MAX)) * (F0_N - 1);
  const k = Math.min(F0_N - 2, Math.floor(kf));
  const fk = kf - k;
  const { fx, fy } = TC;
  const o = (TC.j * TABLE_N + TC.i) * F0_N + k;
  return (
    lerpAt(t, o, fk) * (1 - fx) * (1 - fy) +
    lerpAt(t, o + F0_N, fk) * fx * (1 - fy) +
    lerpAt(t, o + TABLE_N * F0_N, fk) * (1 - fx) * fy +
    lerpAt(t, o + (TABLE_N + 1) * F0_N, fk) * fx * fy
  );
}

function lerpAt(t: Float32Array, q: number, f: number): number {
  return t[q] * (1 - f) + t[q + 1] * f;
}

/** Resolution of the glass albedo table over μ and roughness (F0 levels as `F0_N`). */
const GLASS_N = 16;
let glassTable: Float32Array | null = null;

/**
 * Single-scattering energy albedo (reflected plus transmitted energy, without the η² radiance
 * scaling) of the rough dielectric lobe, over μ = cos θo, roughness and F0 = ((η − 1)/(η + 1))²
 * (√-spaced like the dielectric table, IOR 1 … 3), for light arriving from outside (η = IOR,
 * first half) and from inside (η = 1/IOR, total internal reflection included).
 */
function buildGlassTable(): void {
  const levels = GLASS_N * GLASS_N * F0_N;
  const t = new Float32Array(2 * levels);
  const h = new Float64Array(3);
  const S = 10;
  for (let side = 0; side < 2; side++)
    for (let k = 0; k < F0_N; k++) {
      const r = Math.sqrt(F0_MAX) * (k / (F0_N - 1));
      const ior = (1 + r) / (1 - r);
      const eta = side === 0 ? ior : 1 / ior;
      for (let j = 0; j < GLASS_N; j++) {
        const rough = j / (GLASS_N - 1);
        const alpha = Math.max(ALPHA_MIN, rough * rough);
        const a2 = alpha * alpha;
        for (let i = 0; i < GLASS_N; i++) {
          const mu = 0.02 + (0.98 * i) / (GLASS_N - 1);
          const wx = Math.sqrt(1 - mu * mu);
          const lo = ggxLambda(mu, a2);
          let E = 0;
          for (let a = 0; a < S; a++)
            for (let b = 0; b < S; b++) {
              sampleVNDF(wx, 0, mu, alpha, (a + 0.5) / S, (b + 0.5) / S, h);
              const c = wx * h[0] + mu * h[2];
              if (c <= 0) continue;
              const F = fresnelDielectric(c, eta);
              // reflection and refraction through the sampled microfacet: weight G2 / G1(wo)
              const rz = 2 * c * h[2] - mu;
              if (rz > 0) E += (F * (1 + lo)) / (1 + lo + ggxLambda(rz, a2));
              const cos2t = 1 - (1 - c * c) / (eta * eta);
              if (F < 1 && cos2t > 0) {
                const tz = -mu / eta + (c / eta - Math.sqrt(cos2t)) * h[2];
                if (tz < 0) E += ((1 - F) * (1 + lo)) / (1 + lo + ggxLambda(-tz, a2));
              }
            }
          t[side * levels + (j * GLASS_N + i) * F0_N + k] = E / (S * S);
        }
      }
    }
  glassTable = t;
}

/** Energy albedo of the rough dielectric lobe for relative IOR `eta` (see `buildGlassTable`). */
function glassAlbedo(mu: number, rough: number, eta: number): number {
  if (!glassTable) buildGlassTable();
  const t = glassTable!;
  const ior = eta < 1 ? 1 / eta : eta;
  const f0 = ((ior - 1) / (ior + 1)) ** 2;
  const kf = Math.min(1, Math.sqrt(f0 / F0_MAX)) * (F0_N - 1);
  const k = Math.min(F0_N - 2, Math.floor(kf));
  const fk = kf - k;
  const x = Math.min(1, Math.max(0, (mu - 0.02) / 0.98)) * (GLASS_N - 1);
  const y = Math.min(1, Math.max(0, rough)) * (GLASS_N - 1);
  const i = Math.min(GLASS_N - 2, Math.floor(x));
  const j = Math.min(GLASS_N - 2, Math.floor(y));
  const fx = x - i;
  const fy = y - j;
  const o = (eta < 1 ? GLASS_N * GLASS_N * F0_N : 0) + (j * GLASS_N + i) * F0_N + k;
  return (
    lerpAt(t, o, fk) * (1 - fx) * (1 - fy) +
    lerpAt(t, o + F0_N, fk) * fx * (1 - fy) +
    lerpAt(t, o + GLASS_N * F0_N, fk) * (1 - fx) * fy +
    lerpAt(t, o + (GLASS_N + 1) * F0_N, fk) * fx * fy
  );
}

/**
 * Relative IORs closer to 1 than this make an index-matched interface: light continues straight
 * through it (a delta transmission, no Fresnel reflection) whatever the roughness.
 */
const ETA_MATCHED = 1e-4;

/** Charlie sheen distribution (roughness 0.5, i.e. sin²θh / … ) times the Neubelt visibility term. */
function sheenLobe(hz: number, wiz: number, woz: number): number {
  const s2 = Math.max(0, 1 - hz * hz);
  const D = (2 + 1 / SHEEN_ROUGHNESS) * Math.pow(s2, 0.5 / SHEEN_ROUGHNESS) * (0.5 * INV_PI);
  const V = 1 / (4 * (wiz + woz - wiz * woz));
  return D * V;
}
const SHEEN_ROUGHNESS = 0.5;

/** Directional albedo of the sheen lobe for μ = cos θo (32 entries). */
function getSheenTable(): Float32Array {
  if (sheenTable) return sheenTable;
  const t = new Float32Array(TABLE_N);
  const S = 32;
  for (let i = 0; i < TABLE_N; i++) {
    const mu = Math.max(0.02, i / (TABLE_N - 1));
    const wx = Math.sqrt(1 - mu * mu);
    let e = 0;
    for (let a = 0; a < S; a++)
      for (let b = 0; b < S; b++) {
        // cosine-weighted direction
        const r = Math.sqrt((a + 0.5) / S);
        const phi = (2 * Math.PI * (b + 0.5)) / S;
        const ix = r * Math.cos(phi);
        const iy = r * Math.sin(phi);
        const iz = Math.sqrt(Math.max(0, 1 - r * r));
        // only the half vector's cosine to the normal matters for the sheen lobe
        const hz = (iz + mu) / (Math.hypot(ix + wx, iy, iz + mu) || 1);
        e += sheenLobe(hz, iz, mu) * Math.PI;
      }
    t[i] = Math.min(1, e / (S * S));
  }
  sheenTable = t;
  return t;
}

function sheenAlbedo(mu: number): number {
  const t = getSheenTable();
  const x = Math.min(1, Math.max(0, (mu - 0.02) / 0.98)) * (TABLE_N - 1);
  const i = Math.min(TABLE_N - 2, Math.floor(x));
  const f = x - i;
  return t[i] * (1 - f) + t[i + 1] * f;
}

function lum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

// ------------------------------------------------------------------ BSDF

/** Input parameters of `PrincipledBSDF.setup` (linear colours, Blender ranges). */
export interface BSDFInputs {
  baseR: number;
  baseG: number;
  baseB: number;
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
}

const LOBE_SPEC = 0;
const LOBE_GLASS = 1;
const LOBE_DIFFUSE = 2;
const LOBE_SHEEN = 3;
const LOBE_COAT = 4;
const LOBES = 5;

/**
 * Stateful BSDF closure (no allocations per shading point): `setup` for a surface and an
 * outgoing direction, then `eval`/`sample`. Directions are in the local frame (z = normal on the
 * side of wo; for transmissive surfaces `entering` tells which side of the object wo is on).
 */
export class PrincipledBSDF {
  // results of eval / sample
  /** BSDF × |cos θi| (rgb). */
  fR = 0;
  fG = 0;
  fB = 0;
  pdf = 0;
  /** Sampled direction (local). */
  wx = 0;
  wy = 0;
  wz = 0;
  /** The sampled lobe was a near-specular one / a refraction. */
  sampledSpecular = false;
  sampledTransmission = false;
  /**
   * The sample is a delta lobe (index-matched transmission straight through, wi = −wo): f and pdf
   * hold its weight and selection probability, so f / pdf is the throughput factor, but `eval`
   * never returns it and its pdf must not enter multiple importance sampling.
   */
  sampledDelta = false;
  /** Every lobe with non-zero weight is near-specular: light sampling is pointless. */
  singular = false;
  /** Rough albedo estimate at wo (for denoising AOVs). */
  albedoR = 0;
  albedoG = 0;
  albedoB = 0;

  // configuration
  private wox = 0;
  private woy = 0;
  private woz = 1;
  private alpha = 0.25;
  private a2 = 0.0625;
  private alphaC = 0.03;
  private a2C = 0.0009;
  /** Relative IOR across the glass interface (inner / outer as seen from wo) and of opaque specular. */
  private eta = 1.5;
  private etaOpaque = 1.5;
  private baseR = 0.8;
  private baseG = 0.8;
  private baseB = 0.8;
  private metallic = 0;
  private glassW = 0;
  private dielW = 0;
  private coatW = 0;
  private sheenW = 0;
  private sheenR = 1;
  private sheenG = 1;
  private sheenB = 1;
  // per-channel attenuation of the base layer by sheen and coat, and of the coat by sheen
  private attR = 1;
  private attG = 1;
  private attB = 1;
  private coatAttR = 1;
  private coatAttG = 1;
  private coatAttB = 1;
  // energy compensation factors
  private compMR = 1;
  private compMG = 1;
  private compMB = 1;
  private compD = 1;
  private compC = 1;
  private compG = 1;
  /** Index-matched glass (|η − 1| < `ETA_MATCHED`): its transmission is a delta lobe. */
  private passThrough = false;
  // diffuse weight (rgb, already including albedo scaling and attenuation)
  private diffR = 0;
  private diffG = 0;
  private diffB = 0;
  private readonly prob = new Float64Array(LOBES);
  private readonly h = new Float64Array(3);

  /**
   * Prepares the closure. `wo` is the local outgoing direction (wz > 0); `entering` is true when
   * wo is outside the object (front face), which decides the IOR ratio for transmission.
   * `minAlpha` raises the GGX α of every microfacet lobe to at least that value (path
   * regularization, Cycles' "Filter Glossy").
   */
  setup(p: BSDFInputs, wox: number, woy: number, woz: number, entering: boolean, minAlpha = 0): void {
    this.wox = wox;
    this.woy = woy;
    this.woz = Math.max(1e-6, woz);
    const mu = this.woz;
    // roughness = √α: a blurred lobe also uses the albedo tables of its effective roughness
    const minRough = minAlpha > 0 ? Math.sqrt(Math.min(1, minAlpha)) : 0;
    const rough = Math.max(clamp01(p.roughness), minRough);
    this.alpha = Math.max(ALPHA_MIN, rough * rough);
    this.a2 = this.alpha * this.alpha;
    const cr = Math.max(clamp01(p.coatRoughness), minRough);
    this.alphaC = Math.max(ALPHA_MIN, cr * cr);
    this.a2C = this.alphaC * this.alphaC;
    const ior = p.ior > 1e-3 && Number.isFinite(p.ior) ? p.ior : 1.5;
    this.eta = entering ? ior : 1 / ior;
    // opaque specular: the reflectance of the interface, without total internal reflection
    this.etaOpaque = ior >= 1 ? ior : 1 / ior;
    const bR = clamp01(p.baseR);
    const bG = clamp01(p.baseG);
    const bB = clamp01(p.baseB);
    this.baseR = bR;
    this.baseG = bG;
    this.baseB = bB;
    const m = clamp01(p.metallic);
    const tr = clamp01(p.transmission);
    this.metallic = m;
    this.glassW = (1 - m) * tr;
    this.dielW = (1 - m) * (1 - tr);
    // sheen and coat only on the outside of transmissive objects
    const outside = entering || tr === 0;
    this.sheenW = outside ? clamp01(p.sheen) : 0;
    this.coatW = outside ? clamp01(p.coat) : 0;
    this.sheenR = Math.max(0, p.sheenR);
    this.sheenG = Math.max(0, p.sheenG);
    this.sheenB = Math.max(0, p.sheenB);

    // --- layer attenuation (albedo scaling)
    const es = this.sheenW > 0 ? sheenAlbedo(mu) * this.sheenW : 0;
    this.coatAttR = clamp01(1 - es * this.sheenR);
    this.coatAttG = clamp01(1 - es * this.sheenG);
    this.coatAttB = clamp01(1 - es * this.sheenB);
    let coatAlbedo = 0;
    const f0c = ((COAT_IOR - 1) / (COAT_IOR + 1)) ** 2;
    if (this.coatW > 0) {
      const e1c = Math.max(1e-3, albedoE1(mu, cr));
      this.compC = 1 + f0c * (1 / e1c - 1);
      coatAlbedo = albedoDielectric(mu, cr, f0c) * this.compC * this.coatW;
    } else this.compC = 1;
    const ca = clamp01(1 - coatAlbedo);
    this.attR = this.coatAttR * ca;
    this.attG = this.coatAttG * ca;
    this.attB = this.coatAttB * ca;

    // --- base specular: compensation and dielectric albedo
    const e1 = Math.max(1e-3, albedoE1(mu, rough));
    const inv1 = 1 / e1 - 1;
    this.compMR = 1 + bR * inv1;
    this.compMG = 1 + bG * inv1;
    this.compMB = 1 + bB * inv1;
    const f0d = ((this.etaOpaque - 1) / (this.etaOpaque + 1)) ** 2;
    this.compD = 1 + f0d * inv1;
    const specAlbedoD = Math.min(1, albedoDielectric(mu, rough, f0d) * this.compD);
    const kd = this.dielW * (1 - specAlbedoD);
    // glass: index-matched interfaces pass light straight through; rough ones get the energy
    // lost to single scattering back (white glass stays lossless at any roughness)
    this.passThrough = this.glassW > 0 && Math.abs(this.eta - 1) < ETA_MATCHED;
    this.compG =
      this.glassW > 0 && !this.passThrough ? 1 / Math.max(0.2, glassAlbedo(mu, rough, this.eta)) : 1;
    this.diffR = kd * bR * this.attR;
    this.diffG = kd * bG * this.attG;
    this.diffB = kd * bB * this.attB;

    // --- lobe selection weights (approximate albedos at wo)
    const fw = schlickWeight(mu);
    const metR = m * (bR + (1 - bR) * fw) * this.attR;
    const metG = m * (bG + (1 - bG) * fw) * this.attG;
    const metB = m * (bB + (1 - bB) * fw) * this.attB;
    const dsp = this.dielW * specAlbedoD;
    const specR = metR + dsp * this.attR;
    const specG = metG + dsp * this.attG;
    const specB = metB + dsp * this.attB;
    const prob = this.prob;
    prob[LOBE_SPEC] = lum(specR, specG, specB);
    const Fg = this.glassW > 0 ? fresnelDielectric(mu, this.eta) : 0;
    const attL = lum(this.attR, this.attG, this.attB);
    prob[LOBE_GLASS] = this.glassW * this.compG * attL * (Fg + (1 - Fg) * Math.max(0.05, lum(bR, bG, bB)));
    prob[LOBE_DIFFUSE] = lum(this.diffR, this.diffG, this.diffB);
    const shR = es * this.sheenR;
    const shG = es * this.sheenG;
    const shB = es * this.sheenB;
    prob[LOBE_SHEEN] = lum(shR, shG, shB);
    const coatTerm = coatAlbedo;
    prob[LOBE_COAT] = coatTerm * lum(this.coatAttR, this.coatAttG, this.coatAttB);
    let sum = 0;
    for (let i = 0; i < LOBES; i++) sum += prob[i];
    if (sum > 0) for (let i = 0; i < LOBES; i++) prob[i] /= sum;
    // near-specular closures: no light sampling
    const specOnly =
      prob[LOBE_DIFFUSE] === 0 &&
      prob[LOBE_SHEEN] === 0 &&
      (prob[LOBE_SPEC] === 0 || this.alpha < SPECULAR_ALPHA) &&
      (prob[LOBE_GLASS] === 0 || this.passThrough || this.alpha < SPECULAR_ALPHA) &&
      (prob[LOBE_COAT] === 0 || this.alphaC < SPECULAR_ALPHA);
    this.singular = sum > 0 && specOnly;
    // albedo AOV
    const glassTint = this.glassW * (Fg + (1 - Fg));
    this.albedoR = Math.min(1, this.diffR + specR + glassTint * (Fg + (1 - Fg) * bR) + shR + coatTerm);
    this.albedoG = Math.min(1, this.diffG + specG + glassTint * (Fg + (1 - Fg) * bG) + shG + coatTerm);
    this.albedoB = Math.min(1, this.diffB + specB + glassTint * (Fg + (1 - Fg) * bB) + shB + coatTerm);
    if (sum <= 0) this.prob.fill(0);
  }

  /** True when the closure scatters at all. */
  get active(): boolean {
    const p = this.prob;
    return p[0] + p[1] + p[2] + p[3] + p[4] > 0;
  }

  /** Evaluates f·|cos θi| (into fR/fG/fB) and the combined sampling pdf (into pdf) for a local direction. */
  eval(ix: number, iy: number, iz: number): void {
    let fr = 0;
    let fg = 0;
    let fb = 0;
    let pdf = 0;
    const ox = this.wox;
    const oy = this.woy;
    const oz = this.woz;
    const prob = this.prob;
    if (iz > 0) {
      // ---- reflection lobes
      let hx = ox + ix;
      let hy = oy + iy;
      let hz = oz + iz;
      const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (hl > 0) {
        hx /= hl;
        hy /= hl;
        hz /= hl;
        const c = Math.max(0, ox * hx + oy * hy + oz * hz);
        const inv4 = 1 / (4 * oz);
        if (prob[LOBE_SPEC] > 0 || prob[LOBE_GLASS] > 0) {
          const a2 = this.a2;
          const D = ggxD(hz, a2);
          const lo = ggxLambda(oz, a2);
          const G2 = 1 / (1 + lo + ggxLambda(iz, a2));
          const common = D * G2 * inv4; // D·G2/(4 μo μi) · μi
          if (prob[LOBE_SPEC] > 0) {
            const m = this.metallic;
            const fw = schlickWeight(c);
            const Fd = this.dielW > 0 ? fresnelDielectric(c, this.etaOpaque) * this.compD * this.dielW : 0;
            fr += common * (m * (this.baseR + (1 - this.baseR) * fw) * this.compMR + Fd) * this.attR;
            fg += common * (m * (this.baseG + (1 - this.baseG) * fw) * this.compMG + Fd) * this.attG;
            fb += common * (m * (this.baseB + (1 - this.baseB) * fw) * this.compMB + Fd) * this.attB;
            pdf += (prob[LOBE_SPEC] * (D * inv4)) / (1 + lo);
          }
          if (prob[LOBE_GLASS] > 0) {
            const F = fresnelDielectric(c, this.eta);
            const k = common * F * this.glassW * this.compG;
            fr += k * this.attR;
            fg += k * this.attG;
            fb += k * this.attB;
            pdf += prob[LOBE_GLASS] * F * ((D * inv4) / (1 + lo));
          }
        }
        if (prob[LOBE_COAT] > 0) {
          const a2 = this.a2C;
          const D = ggxD(hz, a2);
          const lo = ggxLambda(oz, a2);
          const G2 = 1 / (1 + lo + ggxLambda(iz, a2));
          const k = D * G2 * inv4 * fresnelDielectric(c, COAT_IOR) * this.compC * this.coatW;
          fr += k * this.coatAttR;
          fg += k * this.coatAttG;
          fb += k * this.coatAttB;
          pdf += prob[LOBE_COAT] * ((D * inv4) / (1 + lo));
        }
        if (prob[LOBE_SHEEN] > 0) {
          const k = this.sheenW * sheenLobe(hz, iz, oz) * iz;
          fr += k * this.sheenR;
          fg += k * this.sheenG;
          fb += k * this.sheenB;
          pdf += prob[LOBE_SHEEN] * iz * INV_PI;
        }
      }
      if (prob[LOBE_DIFFUSE] > 0) {
        const k = iz * INV_PI;
        fr += this.diffR * k;
        fg += this.diffG * k;
        fb += this.diffB * k;
        pdf += prob[LOBE_DIFFUSE] * k;
      }
    } else if (iz < 0 && prob[LOBE_GLASS] > 0 && !this.passThrough) {
      // ---- refraction through the rough dielectric (an index-matched one is a delta lobe)
      const eta = this.eta;
      let hx = ox + eta * ix;
      let hy = oy + eta * iy;
      let hz = oz + eta * iz;
      const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (hl > 0) {
        if (hz < 0) {
          hx = -hx;
          hy = -hy;
          hz = -hz;
        }
        hx /= hl;
        hy /= hl;
        hz /= hl;
        const co = ox * hx + oy * hy + oz * hz;
        const ci = ix * hx + iy * hy + iz * hz;
        if (co > 0 && ci < 0) {
          const a2 = this.a2;
          const D = ggxD(hz, a2);
          const lo = ggxLambda(oz, a2);
          const G2 = 1 / (1 + lo + ggxLambda(-iz, a2));
          const F = fresnelDielectric(co, eta);
          const sq = ci + co / eta;
          const denom = sq * sq;
          if (denom > 0) {
            // f·|cos θi| = D G2 (1 − F) |i·h| |o·h| / (|o_z| denom η²)
            const k = ((D * G2 * (1 - F) * -ci * co) / (oz * denom * eta * eta)) * this.glassW * this.compG;
            fr += k * this.baseR * this.attR;
            fg += k * this.baseG * this.attG;
            fb += k * this.baseB * this.attB;
            pdf += prob[LOBE_GLASS] * (1 - F) * ((D * co) / ((1 + lo) * oz)) * (-ci / denom);
          }
        }
      }
    }
    this.fR = fr;
    this.fG = fg;
    this.fB = fb;
    this.pdf = pdf;
  }

  /**
   * Samples an incident direction (local, into wx/wy/wz) with `u0`, `u1` and the lobe choice
   * `uLobe`, then evaluates the full BSDF and pdf for it. Returns false when nothing was sampled.
   */
  sample(u0: number, u1: number, uLobe: number): boolean {
    const prob = this.prob;
    let lobe = -1;
    let acc = 0;
    let lo = 0;
    for (let i = 0; i < LOBES; i++) {
      if (prob[i] <= 0) continue;
      if (uLobe < acc + prob[i] || i === lastLobe(prob)) {
        lobe = i;
        lo = acc;
        break;
      }
      acc += prob[i];
    }
    if (lobe < 0) return false;
    const uSub = Math.min(0.99999999, Math.max(0, (uLobe - lo) / prob[lobe]));
    const ox = this.wox;
    const oy = this.woy;
    const oz = this.woz;
    let ix: number;
    let iy: number;
    let iz: number;
    this.sampledSpecular = false;
    this.sampledTransmission = false;
    this.sampledDelta = false;
    if (lobe === LOBE_GLASS && this.passThrough) {
      // index-matched glass: straight through with weight (1 − F ≈ 1) × tint, chosen with prob
      this.wx = -ox;
      this.wy = -oy;
      this.wz = -oz;
      this.sampledSpecular = true;
      this.sampledTransmission = true;
      this.sampledDelta = true;
      this.fR = this.glassW * this.baseR * this.attR;
      this.fG = this.glassW * this.baseG * this.attG;
      this.fB = this.glassW * this.baseB * this.attB;
      this.pdf = prob[LOBE_GLASS];
      return this.fR + this.fG + this.fB > 0;
    }
    if (lobe === LOBE_DIFFUSE || lobe === LOBE_SHEEN) {
      const r = Math.sqrt(u0);
      const phi = 2 * Math.PI * u1;
      ix = r * Math.cos(phi);
      iy = r * Math.sin(phi);
      iz = Math.sqrt(Math.max(0, 1 - u0));
    } else {
      const coat = lobe === LOBE_COAT;
      const alpha = coat ? this.alphaC : this.alpha;
      const h = this.h;
      sampleVNDF(ox, oy, oz, alpha, u0, u1, h);
      const c = ox * h[0] + oy * h[1] + oz * h[2];
      if (c <= 0) return false;
      this.sampledSpecular = alpha < SPECULAR_ALPHA;
      let refract = false;
      if (lobe === LOBE_GLASS) {
        const F = fresnelDielectric(c, this.eta);
        refract = uSub >= F;
      }
      if (refract) {
        const eta = this.eta;
        const cos2t = 1 - (1 - c * c) / (eta * eta);
        if (cos2t <= 0) return false;
        const k = c / eta - Math.sqrt(cos2t);
        ix = -ox / eta + k * h[0];
        iy = -oy / eta + k * h[1];
        iz = -oz / eta + k * h[2];
        const l = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
        ix /= l;
        iy /= l;
        iz /= l;
        if (iz >= 0) return false;
        this.sampledTransmission = true;
      } else {
        ix = 2 * c * h[0] - ox;
        iy = 2 * c * h[1] - oy;
        iz = 2 * c * h[2] - oz;
        if (iz <= 0) return false;
      }
    }
    this.wx = ix;
    this.wy = iy;
    this.wz = iz;
    this.eval(ix, iy, iz);
    return this.pdf > 0 && this.fR + this.fG + this.fB > 0;
  }
}

function lastLobe(prob: Float64Array): number {
  for (let i = LOBES - 1; i >= 0; i--) if (prob[i] > 0) return i;
  return -1;
}
