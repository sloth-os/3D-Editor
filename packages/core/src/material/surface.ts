import type { Vec3 } from '../math/types';
import type { MaterialData, MaterialTextureChannel, ProceduralTexture } from '../doc/types';
import { compileProcedural, patternKey, sampleCompiled, type CompiledProcedural } from './procedural';

/*
 * Procedural texture slots of a material, ready for evaluation by renderers (CPU rasterizer, path
 * tracer, glTF baker). Semantics (like plugging a texture into a Principled BSDF input in Blender):
 *
 *   base_color  RGB replaces the base colour; its alpha multiplies the material alpha
 *   emission    RGB replaces the emission colour (emission_strength still applies)
 *   metallic, roughness, alpha
 *               the red component replaces the scalar value
 *   normal      the red component is a height field; the shading normal is bumped by
 *               red × params.bump_distance (metres, default 0.1) × material normal_strength
 *
 * A procedural slot takes precedence over an image in the same slot.
 */

export const MATERIAL_TEXTURE_CHANNELS: readonly MaterialTextureChannel[] = [
  'base_color',
  'metallic',
  'roughness',
  'normal',
  'emission',
  'alpha',
];

/** The procedural texture of a material channel, or null. */
export function channelProcedural(
  m: Pick<MaterialData, 'textures'> | null | undefined,
  channel: MaterialTextureChannel,
): ProceduralTexture | null {
  const slot = m?.textures?.[channel];
  const p = slot && typeof slot === 'object' ? slot.procedural : null;
  return p && typeof p === 'object' ? p : null;
}

/** True when any texture slot of the material is procedural. */
export function hasProceduralTextures(m: Pick<MaterialData, 'textures'> | null | undefined): boolean {
  return MATERIAL_TEXTURE_CHANNELS.some((ch) => channelProcedural(m, ch) !== null);
}

/** Compiled procedural channels of a material. */
export interface ProceduralSurface {
  base_color: CompiledProcedural | null;
  metallic: CompiledProcedural | null;
  roughness: CompiledProcedural | null;
  normal: CompiledProcedural | null;
  emission: CompiledProcedural | null;
  alpha: CompiledProcedural | null;
  /** Bump displacement in metres for height 1 (bump_distance × normal_strength). */
  bump: number;
  /** Some channel uses OBJECT or GENERATED mapping (needs object-space positions). */
  usesObject: boolean;
  /** Some channel uses GENERATED mapping (needs undeformed positions, see material/orco.ts). */
  usesGenerated: boolean;
  /** Some channel uses UV mapping. */
  usesUv: boolean;
  /**
   * Distinct patterns of the channels (one representative texture per `patternKey`): renderers can
   * evaluate each once per shading point (`samplePattern`) and colour every channel from it
   * (`rampPattern` with `patternOf`), e.g. when one noise drives colour, roughness and bump.
   */
  patterns: CompiledProcedural[];
  /** Index into `patterns` of every channel's texture (−1 for channels without one). */
  patternOf: Record<MaterialTextureChannel, number>;
}

/** Compiles the procedural slots of a material; null when it has none. Never throws. */
export function proceduralSurface(m: MaterialData | null | undefined): ProceduralSurface | null {
  if (!m || !hasProceduralTextures(m)) return null;
  const get = (ch: MaterialTextureChannel) => {
    const p = channelProcedural(m, ch);
    return p ? compileProcedural(p) : null;
  };
  const s: ProceduralSurface = {
    base_color: get('base_color'),
    metallic: get('metallic'),
    roughness: get('roughness'),
    normal: get('normal'),
    emission: get('emission'),
    alpha: get('alpha'),
    bump: 0,
    usesObject: false,
    usesGenerated: false,
    usesUv: false,
    patterns: [],
    patternOf: { base_color: -1, metallic: -1, roughness: -1, normal: -1, emission: -1, alpha: -1 },
  };
  if (s.normal) {
    const strength =
      typeof m.normal_strength === 'number' && Number.isFinite(m.normal_strength) ? m.normal_strength : 1;
    s.bump = s.normal.bumpDistance * strength;
  }
  const keys: string[] = [];
  for (const ch of MATERIAL_TEXTURE_CHANNELS) {
    const c = s[ch];
    if (!c) continue;
    if (c.mapping === 2) s.usesUv = true;
    else s.usesObject = true;
    if (c.mapping === 0) s.usesGenerated = true;
    const key = patternKey(c);
    let i = keys.indexOf(key);
    if (i < 0) {
      i = keys.push(key) - 1;
      s.patterns.push(c);
    }
    s.patternOf[ch] = i;
  }
  return s;
}

/**
 * Texture coordinate of a compiled texture's mapping (same rules as `proceduralCoord`) written to
 * `out`: `texMin`/`texSize` describe the GENERATED texture space (base mesh bounding box).
 */
export function compiledCoord(
  mapping: number,
  ox: number,
  oy: number,
  oz: number,
  texMin: Readonly<Vec3>,
  texSize: Readonly<Vec3>,
  u: number,
  v: number,
  out: Float64Array | number[],
): void {
  if (mapping === 2) {
    out[0] = u;
    out[1] = v;
    out[2] = 0;
  } else if (mapping === 1) {
    out[0] = ox;
    out[1] = oy;
    out[2] = oz;
  } else {
    out[0] = texSize[0] > 1e-12 ? (ox - texMin[0]) / texSize[0] : 0.5;
    out[1] = texSize[1] > 1e-12 ? (oy - texMin[1]) / texSize[1] : 0.5;
    out[2] = texSize[2] > 1e-12 ? (oz - texMin[2]) / texSize[2] : 0.5;
  }
}

const tmp = new Float64Array(4);

/**
 * Bumps a unit shading normal `n` by the height field `tex` (red × `distance` metres) using
 * Mikkelsen's surface-gradient formulation with explicit offsets, as the viewport shader does:
 * `c` is the texture coordinate at the shading point, `dcx`/`dcy` its change along two small
 * surface offsets `dpx`/`dpy` (e.g. to the neighbouring pixels). Writes the unit result to `out`
 * (`n` unchanged when the offsets are degenerate). `height` is the height at `c` when the caller
 * already has it (e.g. from a pattern shared with other channels); it is sampled otherwise.
 */
export function bumpNormal(
  tex: CompiledProcedural,
  distance: number,
  c: Readonly<Vec3>,
  dcx: Readonly<Vec3>,
  dcy: Readonly<Vec3>,
  dpx: Readonly<Vec3>,
  dpy: Readonly<Vec3>,
  n: Readonly<Vec3>,
  out: Vec3 | Float64Array,
  height?: number,
): void {
  let h0: number;
  if (height !== undefined) h0 = height;
  else {
    sampleCompiled(tex, c[0], c[1], c[2], tmp);
    h0 = tmp[0];
  }
  sampleCompiled(tex, c[0] + dcx[0], c[1] + dcx[1], c[2] + dcx[2], tmp);
  const dhx = (tmp[0] - h0) * distance;
  sampleCompiled(tex, c[0] + dcy[0], c[1] + dcy[1], c[2] + dcy[2], tmp);
  const dhy = (tmp[0] - h0) * distance;
  // r1 = dpy × n, r2 = n × dpx, det = dpx · r1
  const r1x = dpy[1] * n[2] - dpy[2] * n[1];
  const r1y = dpy[2] * n[0] - dpy[0] * n[2];
  const r1z = dpy[0] * n[1] - dpy[1] * n[0];
  const r2x = n[1] * dpx[2] - n[2] * dpx[1];
  const r2y = n[2] * dpx[0] - n[0] * dpx[2];
  const r2z = n[0] * dpx[1] - n[1] * dpx[0];
  const det = dpx[0] * r1x + dpx[1] * r1y + dpx[2] * r1z;
  if (!(Math.abs(det) > 1e-30) || !Number.isFinite(dhx) || !Number.isFinite(dhy)) {
    out[0] = n[0];
    out[1] = n[1];
    out[2] = n[2];
    return;
  }
  const sg = det < 0 ? -1 : 1;
  const ad = Math.abs(det);
  const x = ad * n[0] - sg * (dhx * r1x + dhy * r2x);
  const y = ad * n[1] - sg * (dhx * r1y + dhy * r2y);
  const z = ad * n[2] - sg * (dhx * r1z + dhy * r2z);
  const l = Math.hypot(x, y, z);
  if (!(l > 0)) {
    out[0] = n[0];
    out[1] = n[1];
    out[2] = n[2];
    return;
  }
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
}
