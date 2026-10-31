import type { Vec3, Vec4 } from '../math/types';
import type { MaterialData, MaterialTextureChannel } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { meshBounds } from '../mesh/types';
import { buildRenderBuffers } from '../mesh/render-buffers';
import type { PNGImage } from '../render/png';
import { linearToSrgbByte } from '../render/color';
import { sampleCompiled, type CompiledProcedural } from '../material/procedural';
import { compiledCoord, proceduralSurface, type ProceduralSurface } from '../material/surface';

/*
 * Bakes procedural texture slots into UV-space RGBA8 images (e.g. for glTF export, which only knows
 * image textures). Images are stored top row first with row 0 at v = 1 (editor UVs have V up), i.e.
 * the usual image orientation that glTF (V down) expects after the exporter's V flip.
 *
 * UV-mapped textures are sampled at every texel centre. GENERATED/OBJECT-mapped textures depend on
 * the surface position, so the mesh's UV layout is rasterized: every covered texel gets the object
 * position of its surface point; uncovered texels are filled by dilating the UV islands (`padding`
 * texels) and then with the mean colour, so mipmaps and bilinear filtering do not bleed background.
 * Normal maps are tangent-space (OpenGL/glTF convention: red = +U, green = +V) and are computed from
 * the height (red channel) with the surface metric of every triangle, so the bump has the same
 * strength as in the renderers.
 */

export interface BakeOptions {
  /** Image width in pixels (default 512, clamped to 1..4096). */
  width?: number;
  /** Image height in pixels (default = width). */
  height?: number;
  /** Island dilation in texels for GENERATED/OBJECT mappings (default 4). */
  padding?: number;
}

/** Geometry a texture is baked onto: object-space mesh (with UVs) and its GENERATED texture space. */
export interface BakeGeometry {
  mesh: MeshData;
  /** GENERATED texture space (default: bounds of `mesh`). */
  texMin?: Vec3;
  texMax?: Vec3;
}

interface TexelMap {
  width: number;
  height: number;
  /** 1 for texels on the surface. */
  covered: Uint8Array;
  /** Object-space position and its derivatives along U and V. */
  pos: Float64Array;
  dpdu: Float64Array;
  dpdv: Float64Array;
}

function size(opts: BakeOptions): { width: number; height: number; padding: number } {
  const clampSize = (v: number | undefined, d: number) =>
    Math.max(1, Math.min(4096, Math.round(Number.isFinite(v) ? (v as number) : d)));
  const width = clampSize(opts.width, 512);
  return {
    width,
    height: clampSize(opts.height, width),
    padding: Math.max(0, Math.min(64, Math.round(opts.padding ?? 4))),
  };
}

/** Rasterizes the mesh's UV layout: per covered texel the object position and ∂P/∂u, ∂P/∂v. */
function texelMap(mesh: MeshData, width: number, height: number): TexelMap | null {
  if (!mesh.uvs || !mesh.faces.length) return null;
  const rb = buildRenderBuffers(mesh);
  if (!rb.uvs) return null;
  const n = width * height;
  const map: TexelMap = {
    width,
    height,
    covered: new Uint8Array(n),
    pos: new Float64Array(n * 3),
    dpdu: new Float64Array(n * 3),
    dpdv: new Float64Array(n * 3),
  };
  const P = rb.positions;
  const U = rb.uvs;
  const idx = rb.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    const u0 = U[a * 2];
    const v0 = U[a * 2 + 1];
    const u1 = U[b * 2];
    const v1 = U[b * 2 + 1];
    const u2 = U[c * 2];
    const v2 = U[c * 2 + 1];
    const du1 = u1 - u0;
    const dv1 = v1 - v0;
    const du2 = u2 - u0;
    const dv2 = v2 - v0;
    const det = du1 * dv2 - du2 * dv1;
    if (!(Math.abs(det) > 1e-14)) continue;
    const id = 1 / det;
    const dpdu: Vec3 = [0, 0, 0];
    const dpdv: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const e1 = P[b * 3 + k] - P[a * 3 + k];
      const e2 = P[c * 3 + k] - P[a * 3 + k];
      dpdu[k] = (e1 * dv2 - e2 * dv1) * id;
      dpdv[k] = (e2 * du1 - e1 * du2) * id;
    }
    // texel space: X = u·W, Y = (1 − v)·H; texel centres at integer + 0.5
    const x0 = u0 * width;
    const y0 = (1 - v0) * height;
    const x1 = u1 * width;
    const y1 = (1 - v1) * height;
    const x2 = u2 * width;
    const y2 = (1 - v2) * height;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(Math.abs(area) > 1e-12)) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
    const inv = 1 / area;
    const eps = -1e-6;
    for (let y = minY; y <= maxY; y++) {
      const cy = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const cx = x + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        const i = y * width + x;
        map.covered[i] = 1;
        for (let k = 0; k < 3; k++) {
          map.pos[i * 3 + k] = w0 * P[a * 3 + k] + w1 * P[b * 3 + k] + w2 * P[c * 3 + k];
          map.dpdu[i * 3 + k] = dpdu[k];
          map.dpdv[i * 3 + k] = dpdv[k];
        }
      }
    }
  }
  return map;
}

/** Mean |∂P/∂u| and |∂P/∂v| of a mesh (metres per UV unit), 1 when unknown. */
function meanMetric(map: TexelMap | null): [number, number] {
  if (!map) return [1, 1];
  let su = 0;
  let sv = 0;
  let n = 0;
  for (let i = 0; i < map.covered.length; i++) {
    if (!map.covered[i]) continue;
    su += Math.hypot(map.dpdu[i * 3], map.dpdu[i * 3 + 1], map.dpdu[i * 3 + 2]);
    sv += Math.hypot(map.dpdv[i * 3], map.dpdv[i * 3 + 1], map.dpdv[i * 3 + 2]);
    n++;
  }
  return n ? [su / n || 1, sv / n || 1] : [1, 1];
}

/** Fills uncovered texels by `padding` dilation passes, then with the mean of the covered ones. */
function dilate(
  data: Float64Array,
  covered: Uint8Array,
  width: number,
  height: number,
  padding: number,
): void {
  const mask = covered.slice();
  for (let pass = 0; pass < padding; pass++) {
    const next = mask.slice();
    let changed = false;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (mask[i]) continue;
        let n = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const j = yy * width + xx;
            if (!mask[j]) continue;
            r += data[j * 4];
            g += data[j * 4 + 1];
            b += data[j * 4 + 2];
            a += data[j * 4 + 3];
            n++;
          }
        }
        if (!n) continue;
        data[i * 4] = r / n;
        data[i * 4 + 1] = g / n;
        data[i * 4 + 2] = b / n;
        data[i * 4 + 3] = a / n;
        next[i] = 1;
        changed = true;
      }
    mask.set(next);
    if (!changed) break;
  }
  const mean = [0, 0, 0, 0];
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let k = 0; k < 4; k++) mean[k] += data[i * 4 + k];
    n++;
  }
  if (!n) return;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) continue;
    for (let k = 0; k < 4; k++) data[i * 4 + k] = mean[k] / n;
  }
}

/** Texture-space bounds of the GENERATED mapping. */
function texSpace(geometry: BakeGeometry | null): { min: Vec3; size: Vec3 } {
  const b = geometry?.texMin && geometry.texMax ? { min: geometry.texMin, max: geometry.texMax } : null;
  const bb = b ?? (geometry ? meshBounds(geometry.mesh) : null) ?? { min: [0, 0, 0], max: [1, 1, 1] };
  return {
    min: [bb.min[0], bb.min[1], bb.min[2]],
    size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]],
  };
}

/**
 * Evaluates `fn(i, coord...)` for every texel of a channel: UV mappings at every texel centre,
 * other mappings on the covered texels of the UV layout. Returns linear RGBA floats (4 per texel) or
 * null when the mapping needs geometry that is missing (no mesh or no UVs).
 */
function bakeFloat(
  tex: CompiledProcedural,
  map: TexelMap | null,
  width: number,
  height: number,
  padding: number,
  space: { min: Vec3; size: Vec3 },
  texel: (c: Float64Array, i: number, u: number, v: number, out: Float64Array) => void,
): Float64Array | null {
  const out = new Float64Array(width * height * 4);
  const px = new Float64Array(4);
  const c = new Float64Array(3);
  if (tex.mapping === 2) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const u = (x + 0.5) / width;
        const v = 1 - (y + 0.5) / height;
        c[0] = u;
        c[1] = v;
        c[2] = 0;
        texel(c, i, u, v, px);
        out.set(px, i * 4);
      }
    return out;
  }
  if (!map) return null;
  for (let i = 0; i < map.covered.length; i++) {
    if (!map.covered[i]) continue;
    compiledCoord(
      tex.mapping,
      map.pos[i * 3],
      map.pos[i * 3 + 1],
      map.pos[i * 3 + 2],
      space.min,
      space.size,
      0,
      0,
      c,
    );
    texel(c, i, 0, 0, px);
    out.set(px, i * 4);
  }
  dilate(out, map.covered, width, height, padding);
  return out;
}

function toImage(f: Float64Array, width: number, height: number, srgb: boolean): PNGImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let k = 0; k < 3; k++) {
      const v = f[i * 4 + k];
      data[i * 4 + k] = srgb ? linearToSrgbByte(v) : Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
    data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, f[i * 4 + 3])) * 255);
  }
  return { width, height, data };
}

/**
 * Bakes one procedural texture (compiled with `compileProcedural`) to an RGBA8 image in UV space.
 * Colour data is sRGB-encoded (`srgb`, default true) as image textures expect; pass false for data
 * channels (roughness, metallic, height). Returns null when the texture's mapping needs a mesh with
 * UVs that `geometry` does not provide.
 */
export function bakeProcedural(
  tex: CompiledProcedural,
  geometry: BakeGeometry | null,
  opts: BakeOptions & { srgb?: boolean } = {},
): PNGImage | null {
  const { width, height, padding } = size(opts);
  const map = tex.mapping === 2 || !geometry ? null : texelMap(geometry.mesh, width, height);
  const f = bakeFloat(tex, map, width, height, padding, texSpace(geometry), (c, _i, _u, _v, px) =>
    sampleCompiled(tex, c[0], c[1], c[2], px),
  );
  return f ? toImage(f, width, height, opts.srgb !== false) : null;
}

/**
 * Bakes a bump (height = red channel × `distance` metres) into a tangent-space normal map. Heights
 * are sampled once per texel; slopes are finite differences between neighbouring texels that are
 * continuous on the surface (same position as predicted by the texel's ∂P/∂u, ∂P/∂v), with extra
 * samples inside the texel's triangle at island borders. Slopes use the surface metric
 * (|∂P/∂u|, |∂P/∂v|) so the relief matches the renderers; without geometry 1 m per UV unit is
 * assumed (UV mapping only).
 */
export function bakeNormalMap(
  tex: CompiledProcedural,
  distance: number,
  geometry: BakeGeometry | null,
  opts: BakeOptions = {},
): PNGImage | null {
  const { width, height, padding } = size(opts);
  const map = geometry ? texelMap(geometry.mesh, width, height) : null;
  const uvMapped = tex.mapping === 2;
  if (!uvMapped && !map) return null;
  const [mu, mv] = meanMetric(map);
  const space = texSpace(geometry);
  const scale = Number.isFinite(distance) ? distance : 0;
  const n = width * height;
  const px = new Float64Array(4);
  const q = new Float64Array(3);
  const du = 1 / width;
  const dv = 1 / height;
  // heights of every texel that is evaluated
  const H = new Float64Array(n);
  const valid = new Uint8Array(n);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (uvMapped) sampleCompiled(tex, (x + 0.5) / width, 1 - (y + 0.5) / height, 0, px);
      else {
        if (!map!.covered[i]) continue;
        compiledCoord(
          tex.mapping,
          map!.pos[i * 3],
          map!.pos[i * 3 + 1],
          map!.pos[i * 3 + 2],
          space.min,
          space.size,
          0,
          0,
          q,
        );
        sampleCompiled(tex, q[0], q[1], q[2], px);
      }
      H[i] = px[0];
      valid[i] = 1;
    }
  // height at texel i offset by (su, sv) UV units, sampled inside the texel's triangle
  const heightAt = (i: number, x: number, y: number, su: number, sv: number): number => {
    if (uvMapped) sampleCompiled(tex, (x + 0.5) / width + su, 1 - (y + 0.5) / height + sv, 0, px);
    else {
      const m = map!;
      const o = i * 3;
      compiledCoord(
        tex.mapping,
        m.pos[o] + m.dpdu[o] * su + m.dpdv[o] * sv,
        m.pos[o + 1] + m.dpdu[o + 1] * su + m.dpdv[o + 1] * sv,
        m.pos[o + 2] + m.dpdu[o + 2] * su + m.dpdv[o + 2] * sv,
        space.min,
        space.size,
        0,
        0,
        q,
      );
      sampleCompiled(tex, q[0], q[1], q[2], px);
    }
    return px[0];
  };
  // neighbour j of texel i is usable when it lies where i's triangle predicts (same surface)
  const continuous = (i: number, j: number, su: number, sv: number): boolean => {
    if (!valid[j]) return false;
    if (uvMapped && !map) return true;
    const m = map!;
    if (!m.covered[i] || !m.covered[j]) return uvMapped;
    let err = 0;
    let len = 0;
    for (let k = 0; k < 3; k++) {
      const step = m.dpdu[i * 3 + k] * su + m.dpdv[i * 3 + k] * sv;
      const e = m.pos[j * 3 + k] - (m.pos[i * 3 + k] + step);
      err += e * e;
      len += step * step;
    }
    return err <= 0.0625 * len + 1e-18;
  };
  // derivative of the height along one UV axis at texel i (per UV unit)
  const slope = (i: number, x: number, y: number, axis: 0 | 1): number => {
    const inRange = axis === 0 ? [x > 0, x < width - 1] : [y < height - 1, y > 0];
    // texel rows go down while v goes up: the −v neighbour is the next row
    const prev = axis === 0 ? i - 1 : i + width;
    const next = axis === 0 ? i + 1 : i - width;
    const su = axis === 0 ? du : 0;
    const sv = axis === 0 ? 0 : dv;
    const step = axis === 0 ? du : dv;
    const hasPrev = inRange[0] && continuous(i, prev, -su, -sv);
    const hasNext = inRange[1] && continuous(i, next, su, sv);
    if (hasPrev && hasNext) return (H[next] - H[prev]) / (2 * step);
    if (hasNext) return (H[next] - H[i]) / step;
    if (hasPrev) return (H[i] - H[prev]) / step;
    return (heightAt(i, x, y, su * 0.5, sv * 0.5) - heightAt(i, x, y, -su * 0.5, -sv * 0.5)) / step;
  };
  const f = new Float64Array(n * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      let lu = mu;
      let lv = mv;
      if (map && map.covered[i]) {
        const o = i * 3;
        lu = Math.hypot(map.dpdu[o], map.dpdu[o + 1], map.dpdu[o + 2]) || mu;
        lv = Math.hypot(map.dpdv[o], map.dpdv[o + 1], map.dpdv[o + 2]) || mv;
      }
      const su = (slope(i, x, y, 0) / lu) * scale;
      const sv = (slope(i, x, y, 1) / lv) * scale;
      const l = Math.hypot(su, sv, 1);
      f[i * 4] = (-su / l) * 0.5 + 0.5;
      f[i * 4 + 1] = (-sv / l) * 0.5 + 0.5;
      f[i * 4 + 2] = (1 / l) * 0.5 + 0.5;
      f[i * 4 + 3] = 1;
    }
  if (!uvMapped) dilate(f, map!.covered, width, height, padding);
  return toImage(f, width, height, false);
}

/** glTF-ready bake of every procedural slot of a material (see `bakeMaterialTextures`). */
export interface BakedMaterialTextures {
  /** sRGB RGBA: base colour (procedural, or white when only alpha is procedural) and alpha. */
  baseColor?: PNGImage;
  /** Factor to write with `baseColor` (RGB 1 when the colour is baked; alpha factor). */
  baseColorFactor?: Vec4;
  /** Linear: G = roughness, B = metallic (absolute values, factors 1). */
  metallicRoughness?: PNGImage;
  /** Tangent-space normal map (strength included). */
  normal?: PNGImage;
  /** sRGB emission colour (strength stays a factor). */
  emissive?: PNGImage;
  /** Channels that could not be baked (missing UVs) and why. */
  warnings: string[];
}

/** True when baking the material's procedurals depends on the mesh (not only on UVs). */
export function proceduralBakeNeedsGeometry(m: MaterialData | null): boolean {
  const s = proceduralSurface(m);
  return !!s && (s.usesObject || !!s.normal);
}

/**
 * Bakes the procedural slots of a material for a mesh into glTF-style textures: base colour (+
 * alpha), metallic-roughness (G/B), normal and emissive. Channels with an image instead of a
 * procedural are left to the caller. Never throws; channels that need UVs the mesh lacks are skipped
 * with a warning.
 */
export function bakeMaterialTextures(
  m: MaterialData,
  geometry: BakeGeometry | null,
  opts: BakeOptions = {},
): BakedMaterialTextures {
  const out: BakedMaterialTextures = { warnings: [] };
  const s: ProceduralSurface | null = proceduralSurface(m);
  if (!s) return out;
  const { width, height, padding } = size(opts);
  const space = texSpace(geometry);
  const needMap = [s.base_color, s.alpha, s.metallic, s.roughness, s.emission, s.normal].some(
    (c) => c && c.mapping !== 2,
  );
  const map = needMap && geometry ? texelMap(geometry.mesh, width, height) : null;
  const skip = (ch: MaterialTextureChannel) =>
    out.warnings.push(
      `Material '${m.name}': procedural ${ch} needs a UV-mapped mesh to bake; exported without it`,
    );
  const bake = (c: CompiledProcedural | null, ch: MaterialTextureChannel): Float64Array | null => {
    if (!c) return null;
    const f = bakeFloat(c, map, width, height, padding, space, (q, _i, _u, _v, px) =>
      sampleCompiled(c, q[0], q[1], q[2], px),
    );
    if (!f) skip(ch);
    return f;
  };
  const n = width * height;
  const image = (ch: MaterialTextureChannel) => !!m.textures?.[ch]?.image && !m.textures?.[ch]?.procedural;
  // base colour + alpha (glTF keeps alpha in the base colour texture)
  const base = bake(s.base_color, 'base_color');
  let alpha: Float64Array | null = null;
  if (s.alpha && !s.base_color && image('base_color'))
    out.warnings.push(
      `Material '${m.name}': a procedural alpha cannot be combined with an image base colour in glTF; alpha texture not exported`,
    );
  else alpha = bake(s.alpha, 'alpha');
  if (base || alpha) {
    const f = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      f[i * 4] = base ? base[i * 4] : 1;
      f[i * 4 + 1] = base ? base[i * 4 + 1] : 1;
      f[i * 4 + 2] = base ? base[i * 4 + 2] : 1;
      f[i * 4 + 3] = (base ? base[i * 4 + 3] : 1) * (alpha ? alpha[i * 4] : 1);
    }
    out.baseColor = toImage(f, width, height, true);
    const a = (m.base_color[3] ?? 1) * (alpha ? 1 : (m.alpha ?? 1));
    out.baseColorFactor = base ? [1, 1, 1, a] : [m.base_color[0], m.base_color[1], m.base_color[2], a];
  }
  // metallic / roughness (one glTF texture: an image in the other channel falls back to its factor)
  const rough = bake(s.roughness, 'roughness');
  const metal = bake(s.metallic, 'metallic');
  if ((rough && image('metallic')) || (metal && image('roughness')))
    out.warnings.push(
      `Material '${m.name}': metallic and roughness share one glTF texture; the image ${rough ? 'metallic' : 'roughness'} texture is replaced by its factor`,
    );
  if (rough || metal) {
    const f = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      f[i * 4] = 1;
      f[i * 4 + 1] = rough ? rough[i * 4] : m.roughness;
      f[i * 4 + 2] = metal ? metal[i * 4] : m.metallic;
      f[i * 4 + 3] = 1;
    }
    out.metallicRoughness = toImage(f, width, height, false);
  }
  // emission without strength and a zero bump have no visible effect: not baked
  const emission = m.emission_strength > 0 ? bake(s.emission, 'emission') : null;
  if (emission) {
    for (let i = 0; i < n; i++) emission[i * 4 + 3] = 1;
    out.emissive = toImage(emission, width, height, true);
  }
  if (s.normal && s.bump !== 0) {
    const img = bakeNormalMap(s.normal, s.bump, geometry, { width, height, padding });
    if (img) out.normal = img;
    else skip('normal');
  }
  return out;
}
