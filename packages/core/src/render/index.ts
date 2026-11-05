import type { Vec3, Vec4 } from '../math/types';
import { normalize3 } from '../math/vec3';
import { invert4 } from '../math/mat4';
import type { SceneDoc } from '../doc/scene-doc';
import type { MaterialData, WorldSettings } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { meshBounds } from '../mesh/types';
import { proceduralSurface } from '../material/surface';
import { evaluatedOrco } from '../material/orco';
import {
  prepareSky,
  sampleSkyModel,
  sampleSkyPixel,
  skyIrradianceSH,
  skySun,
  type SkyModel,
} from './sky';
import {
  environmentLighting,
  probeLighting,
  sampleEnvironmentLighting,
  type EnvironmentLighting,
  type ProbeFace,
} from './env-light';
import type { RenderBuffers } from '../mesh/render-buffers';
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
import type { RenderEngine } from '../doc/types';
import { renderPathTracedImage, viewCameraData, type PathTraceProgress } from './pathtrace';

/*
 * CPU software renderer used when no browser (WebGL) is available — e.g. MCP agents asking the
 * server for a picture of the scene. Z-buffered triangle rasterization with simple PBR-ish
 * shading from scene lights.
 *
 * Lighting follows Blender's units: point/spot lights emit W/(4π) W/sr with inverse-square
 * falloff (a 1000 W light 5 m away gives ≈3.2 W/m², i.e. a normally lit surface), sun strength is
 * irradiance in W/m², area lights are approximated by one-sided point emitters. The world
 * environment lights the scene like in the path tracer: STUDIO (the procedural photo studio) and
 * IMAGE (an equirectangular PNG) as image-based lighting — irradiance plus reflections prefiltered
 * by roughness (env-light.ts), so metals reflect the studio —, × strength × environment_strength;
 * NONE as a uniform ambient of the world color × strength (plus a camera-relative studio rig when
 * there are no lamps either). A procedural sky (environment SKY) gives spherical-harmonic sky
 * irradiance plus sky reflections and its sun as a directional light. With
 * `show_environment_background` the studio, image or sky is the background; world mist fogs
 * surfaces (1 − exp(−(density·depth)²)).
 * Procedural texture slots are evaluated per sample (bump via neighbour-pixel differences).
 * PNG base color textures are sampled (other image formats fall back to the color factor).
 * Output is linear → sRGB (plus the scene exposure). Transparent surfaces (blend_method BLEND,
 * transmission) are drawn after the opaque ones, sorted back to front and blended per sample
 * (glass lets the scene behind it through, tinted, with its reflections on top; no refraction).
 * No shadows.
 */

export { decodePNG } from './png';
export { autoFrameView } from './view';
export * from './sky';
export * from './animation';
export {
  PathTracer,
  pathTracerSettings,
  compileScene,
  preparePathTrace,
  renderPathTracedImage,
  filmToRGBA8,
  applyViewTransform,
  viewTransformOf,
  VIEW_TRANSFORMS,
  PathFilm,
  createPathTile,
  pathTileTransferables,
  denoiseFilm,
  viewCameraData,
  type CompiledScene,
  type PathTracerSettings,
  type PathTraceProgress,
  type PathTraceStats,
  type PathTile,
  type PreparedPathTrace,
  type DisplayBackground,
  type PathTraceRenderInput,
  type PathTraceRenderOptions,
  type PathTracedImage,
} from './pathtrace';

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
  /**
   * RASTER: supersampling factor for anti-aliasing (1, 2 or 4; default 2).
   * PATHTRACER: samples per pixel, but only when `engine: 'PATHTRACER'` is passed explicitly. When
   * the engine comes from the scene's render settings, `samples` keeps its anti-aliasing meaning
   * and the path tracer renders the render settings' `samples` (callers unaware of the engine pass
   * an anti-aliasing factor here, which must not turn into a 1–4 sample path trace).
   */
  samples?: number;
  /**
   * Render engine (default: the scene's render `engine`). PATHTRACER is a physically based CPU path
   * tracer (soft shadows, reflections, refraction, global illumination); it is used for MATERIAL
   * shading only (SOLID and the wireframe overlay always rasterize). Its output applies the scene's
   * exposure and `view_transform` (AgX by default, like Blender); the rasterizer uses Standard.
   */
  engine?: RenderEngine;
  /**
   * PATHTRACER: maximum bounces of any kind (diffuse, glossy, transmission), Blender's Total
   * (default: render settings `max_bounces`; 0 = direct light only).
   */
  max_bounces?: number;
  /** PATHTRACER: denoise the image (default: render settings `use_denoising`). */
  denoise?: boolean;
  /**
   * PATHTRACER: wall-clock budget in seconds for compiling, sampling and the estimated denoising
   * (0 / unset = none). One sample per pixel is always rendered, so huge images can take longer.
   */
  time_limit?: number;
  /** PATHTRACER: noise pattern seed (default 0; same seed and settings give the same image). */
  seed?: number;
  /** PATHTRACER: called after every progressive pass; return false to stop early. */
  onProgress?: (p: PathTraceProgress) => boolean | void;
  /**
   * Scene evaluator of `doc` to use (default: a new one). Passing the same evaluator for every
   * frame of an animation reuses its geometry and simulation caches.
   */
  evaluator?: SceneEvaluator;
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
export class TextureCache {
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
  // procedural slots (MATERIAL shading) override the image of their slot and the material value
  const procedural = textures ? proceduralSurface(m) : null;
  const slot = m.textures?.base_color ?? null;
  const tex = textures && slot && !slot.procedural ? textures.get(slot.image) : null;
  const transmission = Math.min(1, Math.max(0, m.transmission ?? 0));
  const matAlpha = procedural?.alpha ? 1 : (m.alpha ?? 1);
  const alpha = Math.min(1, Math.max(0, (m.base_color[3] ?? 1) * matAlpha));
  const varying = !!(procedural?.alpha || procedural?.base_color);
  // OPAQUE ignores alpha (like the path tracer and Eevee); BLEND blends smoothly in the sorted
  // transparent pass, where glass (transmission) also lets the background through
  const blend =
    m.blend_method === 'CLIP' ? 1 : m.blend_method === 'BLEND' && (alpha < 1 || varying) ? 2 : 0;
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
    procedural,
    emissionStrength: es,
    transmission,
    ior: Number.isFinite(m.ior) ? Math.max(1, m.ior) : 1.5,
  };
}

/** The view of a software render (`renderSceneSoftware`'s camera precedence; exported for parallel renders). */
export function resolveView(
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

/**
 * Packs scene lights for the shader; without lamps and without environment lighting (`envLit`:
 * a sky, studio or image world) a camera-relative studio rig.
 */
function buildLights(
  scene: EvaluatedScene,
  view: RenderView,
  skyLight: number[] | null = null,
  envLit = false,
): { data: Float64Array; count: number; studio: boolean } {
  const out: number[] = [];
  // a procedural sky lights the scene itself (its sun, when up): no studio rig
  if (skyLight) out.push(...skyLight);
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
  if (out.length || skyLight || envLit)
    return { data: new Float64Array(out), count: out.length / LIGHT_STRIDE, studio: false };
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
  const scene = (opts.evaluator ?? new SceneEvaluator(doc)).evaluate(frame, { forRender: true });
  const aspect = width / height;
  const meshes = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
  const bounds = evaluatedBounds(meshes);
  const view = resolveView(doc, scene, opts, aspect, bounds);
  if (
    (opts.engine ?? doc.getRender().engine) === 'PATHTRACER' &&
    opts.shading !== 'SOLID' &&
    !opts.wireframe
  ) {
    const pt = renderPathTracedImage({
      scene,
      items: meshes,
      view,
      camera: viewCameraData(doc, scene, opts),
      width,
      height,
      images: new TextureCache(doc),
      orco: (o) => evaluatedOrco(doc, scene, o.object, true),
      // a sample count only from callers that picked the path tracer themselves (see `samples`)
      options: opts.engine === 'PATHTRACER' ? opts : { ...opts, samples: undefined },
    });
    return { width: pt.width, height: pt.height, data: pt.data };
  }
  const W = width * k;
  const H = height * k;
  const r = new Rasterizer(W, H, view);
  r.shadingBlock = k;
  const solid = opts.shading === 'SOLID';
  r.mode = solid ? SHADE_SOLID : SHADE_MATERIAL;
  const world = scene.world;
  const ws = Math.max(0, world.strength ?? 1);
  // procedural sky (environment SKY): radiance × strength × environment_strength, like the path tracer
  const sky = !solid && world.environment === 'SKY' ? skySetup(world, ws) : null;
  const textures = new TextureCache(doc);
  // studio / image world (like the path tracer): image-based lighting instead of the flat ambient
  const env =
    !solid && (world.environment === 'STUDIO' || world.environment === 'IMAGE')
      ? environmentLighting(
          world,
          world.environment === 'IMAGE' ? textures.get(world.environment_image ?? undefined) : null,
        )
      : null;
  const lights = solid ? null : buildLights(scene, view, sky?.sunLight ?? null, !!env);
  /** World lighting of a rasterizer (the main view and the reflection probe faces). */
  const light = (ras: Rasterizer) => {
    if (!lights) return;
    ras.lights = lights.data;
    ras.lightCount = lights.count;
    const boost = lights.studio ? 0.03 : 0;
    ras.ambient = env
      ? [0, 0, 0]
      : [world.color[0] * ws + boost, world.color[1] * ws + boost, world.color[2] * ws + boost];
    if (sky) ras.sky = { sh: sky.sh, model: sky.model, scale: sky.scale };
    else if (env) ras.env = env;
  };
  light(r);
  if (!solid) {
    const mist = world.mist_density;
    if (typeof mist === 'number' && mist > 0 && Number.isFinite(mist)) {
      r.mistDensity = mist;
      const mc = world.mist_color ?? [0, 0, 0];
      r.mistColor = [Math.max(0, mc[0] || 0), Math.max(0, mc[1] || 0), Math.max(0, mc[2] || 0)];
    }
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
  // materials and GENERATED texture spaces once per item (shared by the probe faces and the view)
  const texSpaces = new Map<MeshData, Bounds | null>();
  const draws = meshes.map((o) => {
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
    let texSpace: { min: Vec3; max: Vec3; orco: ArrayLike<number> | null } | null = null;
    if (mats.some((m) => m.procedural)) {
      // GENERATED texture space: bounds of the base (pre-modifier) mesh; coordinates from the
      // undeformed positions (orco) so textures stick to deformed surfaces
      const ts = texSpaceOf(o.object.baseMesh ?? mesh, texSpaces);
      const orco = mats.some((m) => m.procedural?.usesGenerated)
        ? evaluatedOrco(doc, scene, o.object, true)
        : null;
      if (ts) texSpace = { min: ts.min, max: ts.max, orco };
    }
    return { o, mesh, mats, fallback, texSpace };
  });
  const buffers = new Map<MeshData, RenderBuffers>();
  const drawAll = (ras: Rasterizer) => {
    ras.bufferCache = buffers;
    for (const d of draws) {
      if (d.texSpace) ras.drawMesh(d.mesh, d.o.worldMatrix, d.mats, d.fallback, d.texSpace);
      else ras.drawMesh(d.mesh, d.o.worldMatrix, d.mats, d.fallback);
    }
    // alpha-blended and glass surfaces last, back to front
    ras.flushTransparent();
  };
  // reflections of the lit scene in metals and glossy surfaces: a probe rendered in front of
  // what the camera looks at
  const probeAt =
    !solid && draws.some((d) => d.mats.some(reflective)) ? probePosition(view, bounds, drawAll) : null;
  if (probeAt) {
    r.probe = reflectionProbe(probeAt, bounds, light, drawAll, (x, y, z, out) => {
      if (sky) {
        sampleSkyModel(sky.model, x, y, z, false, out);
        out[0] *= sky.scale;
        out[1] *= sky.scale;
        out[2] *= sky.scale;
      } else if (env) sampleEnvironmentLighting(env, x, y, z, 0, out);
      else {
        out[0] = world.color[0] * ws;
        out[1] = world.color[1] * ws;
        out[2] = world.color[2] * ws;
      }
    });
  }
  drawAll(r);

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
  // the procedural sky / studio / image as background, per pixel along the camera ray
  const skyBg =
    (sky || env) && !opts.background && world.show_environment_background
      ? pixelRays(view, width, height)
      : null;
  const skyPx = [0, 0, 0];
  const envPx = new Float64Array(3);
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
      if (skyBg && sky && cv < 1) {
        const d = skyBg.dir(x, y);
        sampleSkyPixel(sky.model, d[0], d[1], d[2], skyBg.pixelRadius, skyPx);
        const f = sky.scale * exposure;
        bg[0] = skyPx[0] * f;
        bg[1] = skyPx[1] * f;
        bg[2] = skyPx[2] * f;
      } else if (skyBg && env && cv < 1) {
        const d = skyBg.dir(x, y);
        sampleEnvironmentLighting(env, d[0], d[1], d[2], 0, envPx);
        bg[0] = envPx[0] * exposure;
        bg[1] = envPx[1] * exposure;
        bg[2] = envPx[2] * exposure;
      }
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

/** Whether a surface shows noticeable reflections of its surroundings (metallic or glossy). */
function reflective(m: SurfaceMaterial): boolean {
  return m.metallic > 0.05 || m.roughness < 0.3 || !!m.procedural?.metallic || !!m.procedural?.roughness;
}

/** Size (pixels) of a reflection probe cube face. */
const PROBE_FACE = 32;
/** Cube faces of the reflection probe: viewing direction and image up. */
const PROBE_DIRS: [Vec3, Vec3][] = [
  [
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [0, -1, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
  ],
];

/** Size (pixels, width) of the depth pre-pass that places the reflection probe. */
const PROBE_PREPASS = 48;

/**
 * Where the reflection probe goes: on the line of sight through the image centre, a tenth of the
 * way from the first surface it meets back towards the camera (the median depth of the central
 * pixels of a small pre-render), so the probe sees the surroundings much like the objects the
 * camera looks at; the centre of the scene bounds when the centre of the image shows no geometry.
 * Null without geometry.
 */
function probePosition(view: RenderView, bounds: Bounds | null, draw: (r: Rasterizer) => void): Vec3 | null {
  if (!bounds) return null;
  const aspect = Math.abs(view.proj[5] / (view.proj[0] || 1)) || 1;
  const w = PROBE_PREPASS;
  const h = Math.max(4, Math.min(256, Math.round(w / aspect)));
  const pre = new Rasterizer(w, h, view);
  pre.mode = SHADE_SOLID;
  draw(pre);
  const depths: number[] = [];
  const cx = w >> 1;
  const cy = h >> 1;
  for (let y = cy - 2; y <= cy + 2; y++)
    for (let x = cx - 2; x <= cx + 2; x++) if (pre.cov[y * w + x] > 0) depths.push(pre.depth[y * w + x]);
  if (!depths.length)
    return [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
  depths.sort((a, b) => a - b);
  const key = depths[depths.length >> 1];
  // depth keys: 1/w (perspective), 1 − z_ndc (orthographic)
  const n = view.near;
  const f = view.far;
  const dist = view.ortho ? ((1 - key) * (f - n) + f + n) / 2 : 1 / key;
  const t = dist * 0.9;
  return [view.eye[0] + view.forward[0] * t, view.eye[1] + view.forward[1] * t, view.eye[2] + view.forward[2] * t];
}

/**
 * A reflection probe at `at`: the scene rendered with its direct lighting into the six faces of a
 * small cube map (`light` sets up a rasterizer's lighting, `draw` draws every item; back faces are
 * culled, so a probe on or in an object sees past it), resampled and prefiltered by roughness
 * (env-light.ts). Directions without geometry see the world (`background`). Reflections then show
 * the lit floor, walls and objects around — what a metal or glossy surface mostly reflects in the
 * path tracer — instead of only the world.
 */
function reflectionProbe(
  at: Vec3,
  bounds: Bounds | null,
  light: (r: Rasterizer) => void,
  draw: (r: Rasterizer) => void,
  background: (x: number, y: number, z: number, out: Float64Array) => void,
): EnvironmentLighting {
  const eye = at;
  const faces: ProbeFace[] = PROBE_DIRS.map(([dir, up]) => {
    const fv = viewFromSpec(
      { position: eye, target: [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]], up, fovY: Math.PI / 2 },
      1,
      bounds,
    );
    const ras = new Rasterizer(PROBE_FACE, PROBE_FACE, fv);
    ras.mode = SHADE_MATERIAL;
    ras.cullBackFaces = true;
    light(ras);
    draw(ras);
    return {
      size: PROBE_FACE,
      color: ras.color,
      cov: ras.cov,
      right: fv.right,
      up: fv.up,
      forward: fv.forward,
    };
  });
  return probeLighting(faces, background);
}

/** Procedural sky of a SKY world: model, diffuse SH, scale and its sun as a packed SUN light. */
function skySetup(
  world: WorldSettings,
  strength: number,
): { model: SkyModel; sh: Float64Array; scale: number; sunLight: number[] } {
  const es = world.environment_strength;
  const scale = strength * (typeof es === 'number' && Number.isFinite(es) ? Math.max(0, es) : 1);
  const sun = skySun(world);
  const e = sun.irradiance;
  const d = sun.direction;
  const sunLight =
    sun.visible && scale > 0
      ? [LIGHT_SUN, 0, 0, 0, -d[0], -d[1], -d[2], e[0] * scale, e[1] * scale, e[2] * scale, 0, 0, 0]
      : [];
  return { model: prepareSky(world), sh: skyIrradianceSH(world), scale, sunLight };
}

/** GENERATED texture space (bounds) of a base mesh, cached per mesh for one render. */
function texSpaceOf(mesh: MeshData, cache: Map<MeshData, Bounds | null>): Bounds | null {
  let b = cache.get(mesh);
  if (b === undefined) cache.set(mesh, (b = meshBounds(mesh)));
  return b;
}

/** World-space unit ray directions through output pixel centres, and the angular pixel radius. */
function pixelRays(
  view: RenderView,
  width: number,
  height: number,
): { dir: (x: number, y: number) => Vec3; pixelRadius: number } {
  const M = invert4(view.viewProj);
  const unproject = (nx: number, ny: number, nz: number): Vec3 => {
    const x = M[0] * nx + M[4] * ny + M[8] * nz + M[12];
    const y = M[1] * nx + M[5] * ny + M[9] * nz + M[13];
    const z = M[2] * nx + M[6] * ny + M[10] * nz + M[14];
    const w = M[3] * nx + M[7] * ny + M[11] * nz + M[15];
    return [x / w, y / w, z / w];
  };
  const dir = (px: number, py: number): Vec3 => {
    const nx = ((px + 0.5) / width) * 2 - 1;
    const ny = 1 - ((py + 0.5) / height) * 2;
    const a = unproject(nx, ny, -1);
    const b = unproject(nx, ny, 1);
    const d = normalize3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    return Number.isFinite(d[0]) ? d : view.forward;
  };
  const c = dir(width / 2, height / 2);
  const n = dir(width / 2 + 1, height / 2);
  const dot = Math.min(1, c[0] * n[0] + c[1] * n[1] + c[2] * n[2]);
  return { dir, pixelRadius: view.ortho ? 0 : Math.acos(dot) / 2 };
}

/** Encodes RGBA pixels as a PNG file. */
export function encodePNG(img: RenderedImage): Uint8Array {
  return encodePNGImpl(img);
}
