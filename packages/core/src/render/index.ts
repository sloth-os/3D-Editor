import type { Vec3, Vec4 } from '../math/types';
import { normalize3 } from '../math/vec3';
import type { SceneDoc } from '../doc/scene-doc';
import type { MaterialData } from '../doc/types';
import { SceneEvaluator, type EvaluatedScene } from '../eval/evaluate';
import { evaluatedBounds } from '../io/common';
import { renderItems, type RenderItem } from '../eval/renderables';
import { sniffImageMime } from '../io/image-info';
import { linearToSrgbByte, srgbToLinear } from './color';
import { decodePNG as decodePNGImpl, encodePNG as encodePNGImpl } from './png';
import {
  LIGHT_AREA,
  LIGHT_POINT,
  LIGHT_SPOT,
  LIGHT_STRIDE,
  LIGHT_SUN,
  Rasterizer,
  SHADE_MATERIAL,
  SHADE_SOLID,
  type SampledTexture,
  type SurfaceMaterial,
} from './raster';
import {
  autoFrameView,
  defaultFovY,
  viewFromCamera,
  viewFromSpec,
  type Bounds,
  type RenderView,
} from './view';

/*
 * CPU software renderer used when no browser (WebGL) is available — e.g. MCP agents asking the
 * server for a picture of the scene. Z-buffered triangle rasterization with simple PBR-ish
 * shading from scene lights.
 *
 * Lighting follows Blender's units: point/spot lights emit W/(4π) W/sr with inverse-square
 * falloff (a 1000 W light 5 m away gives ≈3.2 W/m², i.e. a normally lit surface), sun strength is
 * irradiance in W/m², area lights are approximated by one-sided point emitters. The world color ×
 * strength is a uniform ambient term. Without lights a camera-relative studio rig is used.
 * PNG base color textures are sampled (other image formats fall back to the color factor).
 * Output is linear → sRGB (plus the scene exposure); transparency is approximated with ordered
 * dithering (smoothed by supersampling). No shadows.
 */

export { decodePNG } from './png';
export { autoFrameView } from './view';

export interface SoftwareRenderOptions {
  width: number;
  height: number;
  /** Frame to evaluate (default: scene frame_start). */
  frame?: number;
  /** Camera object id (or name). Default: scene camera, or an automatic view framing all objects. */
  cameraId?: string;
  /** Explicit view (overrides camera). fovY in radians. */
  view?: { position: Vec3; target: Vec3; up?: Vec3; fovY?: number };
  /** RGBA background in 0..1, display (sRGB) values (default: world color). Alpha < 1 gives a transparent PNG background. */
  background?: Vec4;
  shading?: 'SOLID' | 'MATERIAL';
  /** Overlay wireframe edges. */
  wireframe?: boolean;
  /** Supersampling factor for anti-aliasing (1, 2 or 4; default 2). */
  samples?: 1 | 2 | 4;
}

export interface RenderedImage {
  width: number;
  height: number;
  /** RGBA8 pixels, row-major, top row first. */
  data: Uint8ClampedArray;
}

/** Largest output image (pixels) and supersampled buffer (samples) the renderer accepts. */
const MAX_PIXELS = 4096 * 4096;
const MAX_SAMPLES = 4096 * 4096;

const DEFAULT_SURFACE: SurfaceMaterial = {
  r: 0.8,
  g: 0.8,
  b: 0.8,
  alpha: 1,
  metallic: 0,
  roughness: 0.5,
  er: 0,
  eg: 0,
  eb: 0,
  blend: 0,
  threshold: 0.5,
  cull: false,
  vertexColors: false,
  tex: null,
  texScale: [1, 1],
  texOffset: [0, 0],
};

/** Decodes PNG base color textures once per render (other formats render with the color factor only). */
class TextureCache {
  private readonly cache = new Map<string, SampledTexture | null>();
  constructor(private readonly doc: SceneDoc) {}

  get(imageId: string | undefined): SampledTexture | null {
    if (!imageId) return null;
    let t = this.cache.get(imageId);
    if (t === undefined) {
      t = null;
      const bytes = this.doc.getImageBytes(imageId);
      if (bytes && sniffImageMime(bytes) === 'image/png') {
        try {
          const img = decodePNGImpl(bytes);
          if (img.width > 0 && img.height > 0) t = img;
        } catch {
          t = null;
        }
      }
      this.cache.set(imageId, t);
    }
    return t;
  }
}

function surfaceFromMaterial(
  m: MaterialData | null,
  vertexColors: boolean,
  textures?: TextureCache,
): SurfaceMaterial {
  if (!m) return { ...DEFAULT_SURFACE, vertexColors };
  const slot = m.textures?.base_color ?? null;
  const tex = textures && slot ? textures.get(slot.image) : null;
  const transmission = Math.min(1, Math.max(0, m.transmission ?? 0));
  const alpha = Math.min(1, Math.max(0, (m.base_color[3] ?? 1) * (m.alpha ?? 1))) * (1 - 0.8 * transmission);
  const blend =
    m.blend_method === 'CLIP' ? 1 : (m.blend_method === 'BLEND' || transmission > 0) && alpha < 1 ? 2 : 0;
  const es = Math.max(0, m.emission_strength ?? 0);
  return {
    r: Math.max(0, m.base_color[0]),
    g: Math.max(0, m.base_color[1]),
    b: Math.max(0, m.base_color[2]),
    alpha,
    metallic: Math.min(1, Math.max(0, m.metallic)),
    roughness: Math.min(1, Math.max(0, m.roughness)),
    er: Math.max(0, m.emission_color[0]) * es,
    eg: Math.max(0, m.emission_color[1]) * es,
    eb: Math.max(0, m.emission_color[2]) * es,
    blend,
    threshold: m.alpha_threshold ?? 0.5,
    cull: !!m.use_backface_culling,
    vertexColors,
    tex,
    texScale: tex && slot?.scale ? [slot.scale[0], slot.scale[1]] : [1, 1],
    texOffset: tex && slot?.offset ? [slot.offset[0], slot.offset[1]] : [0, 0],
  };
}

function resolveView(
  doc: SceneDoc,
  scene: EvaluatedScene,
  opts: SoftwareRenderOptions,
  aspect: number,
  bounds: Bounds | null,
): RenderView {
  if (opts.view) {
    const v = opts.view;
    return viewFromSpec(
      { position: v.position, target: v.target, up: v.up ?? [0, 0, 1], fovY: v.fovY ?? defaultFovY(aspect) },
      aspect,
      bounds,
    );
  }
  if (opts.cameraId) {
    const o = doc.resolveObject(opts.cameraId);
    const ev = o ? scene.byId.get(o.id) : undefined;
    if (!ev || ev.type !== 'CAMERA' || !ev.camera) throw new Error(`Camera '${opts.cameraId}' not found`);
    return viewFromCamera(ev.camera, ev.worldMatrix, aspect);
  }
  const cam = scene.activeCamera;
  if (cam && cam.type === 'CAMERA' && cam.camera) return viewFromCamera(cam.camera, cam.worldMatrix, aspect);
  return viewFromSpec(autoFrameView(bounds, aspect), aspect, bounds);
}

/** Packs scene lights (or a camera-relative studio rig when there are none) for the shader. */
function buildLights(
  scene: EvaluatedScene,
  view: RenderView,
): { data: Float64Array; count: number; studio: boolean } {
  const out: number[] = [];
  for (const o of scene.objects) {
    if (o.type !== 'LIGHT' || !o.light || !o.renderVisible) continue;
    const l = o.light;
    const M = o.worldMatrix;
    const dir = normalize3([-M[8], -M[9], -M[10]]);
    const energy = Math.max(0, l.energy);
    const kind =
      l.type === 'SUN'
        ? LIGHT_SUN
        : l.type === 'SPOT'
          ? LIGHT_SPOT
          : l.type === 'AREA'
            ? LIGHT_AREA
            : LIGHT_POINT;
    const intensity =
      kind === LIGHT_SUN ? energy : kind === LIGHT_AREA ? energy / Math.PI : energy / (4 * Math.PI);
    const cosHalf = Math.cos(Math.min(Math.PI, Math.max(0, l.spot_size)) / 2);
    const radius = Math.max(0.01, l.type === 'AREA' ? l.size / 2 : l.shadow_soft_size);
    out.push(
      kind,
      M[12],
      M[13],
      M[14],
      dir[0],
      dir[1],
      dir[2],
      Math.max(0, l.color[0]) * intensity,
      Math.max(0, l.color[1]) * intensity,
      Math.max(0, l.color[2]) * intensity,
      cosHalf,
      (1 - cosHalf) * Math.min(1, Math.max(0, l.spot_blend)),
      radius * radius * 0.25,
    );
  }
  if (out.length) return { data: new Float64Array(out), count: out.length / LIGHT_STRIDE, studio: false };
  // studio rig: key, fill and rim suns fixed relative to the camera (view-space directions → world)
  const rig: [number, number, number, number][] = [
    [-0.45, 0.6, 0.65, 2.0],
    [0.75, 0.05, 0.6, 0.5],
    [0.15, 0.7, -0.7, 1.0],
  ];
  for (const [x, y, z, e] of rig) {
    const toLight = normalize3([
      view.right[0] * x + view.up[0] * y - view.forward[0] * z,
      view.right[1] * x + view.up[1] * y - view.forward[1] * z,
      view.right[2] * x + view.up[2] * y - view.forward[2] * z,
    ]);
    out.push(LIGHT_SUN, 0, 0, 0, -toLight[0], -toLight[1], -toLight[2], e, e, e, 0, 0, 0);
  }
  return { data: new Float64Array(out), count: rig.length, studio: true };
}

/**
 * Renders the scene on the CPU. Camera: `opts.view`, else `opts.cameraId`, else the scene camera,
 * else an automatic 3/4 view framing every visible mesh. Returns RGBA8 pixels (top row first).
 */
export function renderSceneSoftware(doc: SceneDoc, opts: SoftwareRenderOptions): RenderedImage {
  const width = Math.round(opts.width);
  const height = Math.round(opts.height);
  if (!(width >= 1 && height >= 1)) throw new Error('Render width and height must be at least 1');
  if (width * height > MAX_PIXELS)
    throw new Error(`Render size ${width}×${height} exceeds the ${MAX_PIXELS} pixel limit`);
  let k: number = opts.samples ?? 2;
  k = k >= 4 ? 4 : k >= 2 ? 2 : 1;
  while (k > 1 && width * height * k * k > MAX_SAMPLES) k = k === 4 ? 2 : 1;
  const frame = opts.frame ?? doc.getScene().frame_start;
  const scene = new SceneEvaluator(doc).evaluate(frame, { forRender: true });
  const aspect = width / height;
  const meshes = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
  const bounds = evaluatedBounds(meshes);
  const view = resolveView(doc, scene, opts, aspect, bounds);
  const W = width * k;
  const H = height * k;
  const r = new Rasterizer(W, H, view);
  const solid = opts.shading === 'SOLID';
  r.mode = solid ? SHADE_SOLID : SHADE_MATERIAL;
  const world = scene.world;
  const ws = Math.max(0, world.strength ?? 1);
  if (!solid) {
    const lights = buildLights(scene, view);
    r.lights = lights.data;
    r.lightCount = lights.count;
    const boost = lights.studio ? 0.03 : 0;
    r.ambient = [world.color[0] * ws + boost, world.color[1] * ws + boost, world.color[2] * ws + boost];
  }
  if (opts.wireframe) {
    r.wireHalfWidth = 0.6 * k;
    r.wireColor = solid ? [0, 0, 0, 0.55] : [0.005, 0.005, 0.005, 0.6];
  }
  // nearest objects first: cheap early depth rejection for the ones behind
  const dist = (o: RenderItem) => {
    const m = o.worldMatrix;
    const e = view.eye;
    return view.ortho
      ? (m[12] - e[0]) * view.forward[0] + (m[13] - e[1]) * view.forward[1] + (m[14] - e[2]) * view.forward[2]
      : Math.hypot(m[12] - e[0], m[13] - e[1], m[14] - e[2]);
  };
  meshes.sort((a, b) => dist(a) - dist(b));
  const textures = new TextureCache(doc);
  for (const o of meshes) {
    const mesh = o.mesh!;
    const hasColors = !!mesh.colors && mesh.colors.length === (mesh.positions.length / 3) * 4;
    let mats: SurfaceMaterial[];
    let fallback: SurfaceMaterial;
    if (solid) {
      const c = o.data.color ?? [1, 1, 1, 1];
      fallback = {
        ...DEFAULT_SURFACE,
        r: 0.8 * Math.max(0, c[0]),
        g: 0.8 * Math.max(0, c[1]),
        b: 0.8 * Math.max(0, c[2]),
      };
      mats = [];
    } else {
      mats = o.materials.map((m) => surfaceFromMaterial(m, hasColors, textures));
      fallback = surfaceFromMaterial(null, hasColors);
    }
    r.drawMesh(mesh, o.worldMatrix, mats, fallback);
  }

  // ---------------------------------------------------------------- resolve (box filter, sRGB)
  const exposure = Math.pow(2, scene.render.exposure ?? 0);
  let bg: [number, number, number, number];
  if (opts.background) {
    const b = opts.background;
    bg = [
      srgbToLinear(clamp01(b[0])),
      srgbToLinear(clamp01(b[1])),
      srgbToLinear(clamp01(b[2])),
      clamp01(b[3] ?? 1),
    ];
  } else
    bg = [world.color[0] * ws * exposure, world.color[1] * ws * exposure, world.color[2] * ws * exposure, 1];
  const out = new Uint8ClampedArray(width * height * 4);
  const inv = 1 / (k * k);
  const color = r.color;
  const cov = r.cov;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let cv = 0;
      for (let sy = 0; sy < k; sy++) {
        let s = (y * k + sy) * W + x * k;
        for (let sx = 0; sx < k; sx++, s++) {
          cr += color[s * 3];
          cg += color[s * 3 + 1];
          cb += color[s * 3 + 2];
          cv += cov[s];
        }
      }
      cv *= inv;
      const rest = (1 - cv) * bg[3];
      const a = cv + rest;
      const o = (y * width + x) * 4;
      if (a > 0) {
        const ia = 1 / a;
        out[o] = linearToSrgbByte((cr * inv * exposure + bg[0] * rest) * ia);
        out[o + 1] = linearToSrgbByte((cg * inv * exposure + bg[1] * rest) * ia);
        out[o + 2] = linearToSrgbByte((cb * inv * exposure + bg[2] * rest) * ia);
      }
      out[o + 3] = Math.round(a * 255);
    }
  }
  return { width, height, data: out };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Encodes RGBA pixels as a PNG file. */
export function encodePNG(img: RenderedImage): Uint8Array {
  return encodePNGImpl(img);
}
