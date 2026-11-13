import type { Mat4, Vec3, Vec4 } from '../math/types';
import { normalize3 } from '../math/vec3';
import { invert4 } from '../math/mat4';
import type { SceneDoc } from '../doc/scene-doc';
import type { MaterialData, WorldSettings } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { meshBounds } from '../mesh/types';
import { proceduralSurface, type ProceduralSurface } from '../material/surface';
import { evaluatedOrco } from '../material/orco';
import { prepareSky, sampleSkyModel, sampleSkyPixel, skyIrradianceSH, skySun, type SkyModel } from './sky';
import {
  environmentLighting,
  probeLighting,
  sampleEnvironmentBackground,
  sampleEnvironmentLighting,
  type EnvironmentLighting,
  type ProbeFace,
} from './env-light';
import type { RenderBuffers } from '../mesh/render-buffers';
import { SceneEvaluator, type EvaluatedScene } from '../eval/evaluate';
import { evaluatedBounds } from '../io/common';
import { renderItems, type RenderItem } from '../eval/renderables';
import { sniffImageMime } from '../io/image-info';
import { ditherThreshold, linearToSrgb255, linearToSrgbByte, srgbToLinear } from './color';
import { decodePNG as decodePNGImpl, encodePNG as encodePNGImpl } from './png';
import {
  LIGHT_AREA,
  LIGHT_POINT,
  LIGHT_SPOT,
  LIGHT_STRIDE,
  LIGHT_SUN,
  Rasterizer,
  SHADE_DEPTH,
  SHADE_MATERIAL,
  SHADE_SOLID,
  type PixelBuffers,
  type SampledTexture,
  type SurfaceMaterial,
  type WorldVertices,
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
import { pooledFloat32, pooledUint32 } from './buffers';
import {
  SPOT_SHADOW_MAP_SIZE,
  SUN_SHADOW_MAP_SIZE,
  buildSpotShadow,
  buildSunShadow,
  type DepthPass,
  type ShadowCaster,
  type ShadowMap,
} from './shadows';
import { aoBufferBytes, ambientOcclusion, applyAmbientOcclusion, linearDepths } from './ao';
import { drawLines, type ScreenLine } from './lines';
import {
  renderPathTracedImage,
  viewCameraData,
  viewTransformOf,
  type PathTraceProgress,
} from './pathtrace';
import { filmRowsToRGBA8 } from './pathtrace/display';

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
 * Output: the scene exposure and view transform (AgX, Filmic, ACES, Neutral or Standard, exactly
 * like the path tracer's display conversion; SOLID shading is always Standard), Film > Transparent
 * leaves the background transparent. Transparent surfaces (blend_method BLEND,
 * transmission) are drawn after the opaque ones, sorted back to front and blended per sample
 * (glass lets the scene behind it through, tinted, with its reflections on top; no refraction).
 * Shadows, ambient occlusion, MSAA-style shading, passes and lines are opt-in (`SoftwareRenderOptions`).
 */

export { decodePNG } from './png';
export { autoFrameView, type RenderView } from './view';
export * from './aov';
export { releaseRenderBuffers } from './buffers';
export {
  SUN_SHADOW_MAP_SIZE,
  SPOT_SHADOW_MAP_SIZE,
  SHADOW_DISTANCE_SCALE,
  fitSunShadow,
  type SunShadowExtent,
} from './shadows';
// the STUDIO / IMAGE world as the renderers see it (the web viewport lights WebGL renders with it)
export { environmentLighting, sampleEnvironmentBackground, type EnvironmentLighting } from './env-light';
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
  /**
   * RGBA background in 0..1, display (sRGB) values, shown as given (no exposure or view transform;
   * default: the world, or nothing with Film > Transparent). Alpha < 1 gives a transparent PNG
   * background.
   */
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
   * shading only (SOLID and the wireframe overlay always rasterize). Both engines apply the scene's
   * exposure and `view_transform` (AgX by default, like Blender; SOLID shading uses Standard).
   * RASTER is a preview: no shadows, and glossy reflections come from one small reflection probe
   * placed in front of what the image centre shows, looked up by direction only (no parallax), so
   * reflective surfaces far from that point reflect what the probe sees in that direction (a wide
   * smear of a nearby object across rippled water, a bright far end of a large glossy table): judge
   * reflections and lighting with PATHTRACER.
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
  // ------------------------------------------------------------------ RASTER quality (opt-in)
  // Every option below defaults to off and leaves the image exactly as without it.
  /**
   * RASTER: shadows of sun and spot lights (shadow maps; point and area lights cast none). `true`
   * shadows every sun and spot light (the SKY world's sun included); `'scene'` follows the scene's
   * `render.use_shadows` and each light's `use_shadow` (the sky sun follows `use_shadows`). The
   * camera-relative studio rig never casts shadows. Default false.
   */
  shadows?: boolean | 'scene';
  /** RASTER: screen-space ambient occlusion of the ambient / environment light. Default false. */
  ao?: boolean;
  /**
   * RASTER with `ao`: how far (metres) ambient occlusion reaches. Default `defaultAoRadius` of the
   * drawn items: a quarter of their median size, 5–50 cm, from each item's rest shape and scale
   * (not its rotation or deformation, so it holds still while things turn and walk), but it does
   * follow what the scene holds: adding or hiding objects anywhere, in view or not, can change
   * it. Pass one value for every frame of a shot (as `shadowFit`) so the occlusion cannot change
   * within it.
   */
  aoRadius?: number;
  /**
   * RASTER: shade once per output pixel and triangle (coverage and depth stay per sample, MSAA
   * style) instead of once per sample: about 2× faster at `samples` 2 (measured on a 720p set of
   * 11k triangles), nearly the same image.
   */
  msaa?: boolean;
  /**
   * RASTER: how samples are averaged into a pixel. 'box' (default) averages linear values;
   * 'tonemap' weights each sample by 1 / (1 + luminance) first (less aliasing on bright edges).
   */
  resolve?: SoftwareResolve;
  /** RASTER: deterministic ordered dither before quantizing to 8 bits (less banding). */
  dither?: boolean;
  /**
   * RASTER: surface look. 'material' (default) renders the materials; 'clay' renders every surface
   * as the same matte mid grey under the scene's lights (no emission or textures; glass stays
   * clear, alpha-clipped and alpha-blended surfaces keep their alpha);
   * 'solid' is the SOLID studio shading (like `shading: 'SOLID'`).
   */
  look?: SoftwareLook;
  /**
   * RASTER: world-space box the sun shadow map covers (else fitted to what the view shows). Pass
   * the same box for every frame of a shot so the map does not move (no shadow swimming).
   */
  shadowFit?: ShadowFitBox;
  /** RASTER: extra per-pixel passes returned in `RenderedImage.aovs` (not box filtered). */
  aovs?: SoftwareAovName[];
  /**
   * RASTER: world-space segments drawn as anti-aliased screen-space lines of at least `width_px`
   * pixels over the image (strings, tethers), hidden where opaque geometry is in front.
   */
  lines?: ScreenLine[];
}

/** How a RASTER render averages its samples into pixels (`SoftwareRenderOptions.resolve`). */
export type SoftwareResolve = 'box' | 'tonemap';
/** Surface look of a RASTER render (`SoftwareRenderOptions.look`). */
export type SoftwareLook = 'material' | 'clay' | 'solid';
/** Per-pixel passes a RASTER render can return (`SoftwareRenderOptions.aovs`). */
export type SoftwareAovName = 'depth' | 'normal' | 'object';
/** World-space box a sun shadow map is fitted to (`SoftwareRenderOptions.shadowFit`). */
export interface ShadowFitBox {
  min: Vec3;
  max: Vec3;
}

/**
 * Per-pixel passes of a RASTER render (row-major, top row first, `width × height` pixels; one
 * value per pixel, three for `normal`). Not filtered: each pixel takes the nearest covered sample.
 */
export interface RenderAovs {
  /** Linear distance from the camera plane (view depth, metres); Infinity where nothing is drawn. */
  depth?: Float32Array;
  /** View-space unit normal (x right, y up, z towards the camera); 0,0,0 where nothing is drawn. */
  normal?: Float32Array;
  /** Index into `objectTable` (0 = nothing drawn). */
  object?: Uint32Array;
  /** Object ids by index; entry 0 is '' (background). Instances map to their source object's id. */
  objectTable?: string[];
}

export interface RenderedImage {
  width: number;
  height: number;
  /** RGBA8 pixels, row-major, top row first. */
  data: Uint8ClampedArray;
  /** RASTER: the passes asked for with `SoftwareRenderOptions.aovs`. */
  aovs?: RenderAovs;
  /**
   * RASTER with `aovs` or `lines`: the view the image was rendered with (project points onto it,
   * draw more `drawLines` over the passes).
   */
  view?: RenderView;
}

/**
 * Render buffers of the meshes drawn by the rasterizer, kept while a mesh is alive (meshes are
 * immutable: an evaluator reuses unchanged ones from render to render).
 */
const RENDER_BUFFERS = new WeakMap<MeshData, RenderBuffers>();

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
  const blend = m.blend_method === 'CLIP' ? 1 : m.blend_method === 'BLEND' && (alpha < 1 || varying) ? 2 : 0;
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

/** Base colour (linear) and roughness of the clay look. */
const CLAY_ALBEDO = 0.5;
const CLAY_ROUGHNESS = 0.85;

/**
 * A material in the clay look: uniform matte light grey, no emission, textures or vertex colours;
 * alpha clipping and blending keep their alpha (textures and procedural alpha included) and glass
 * stays clear glass.
 */
function claySurface(m: MaterialData | null, textures: TextureCache): SurfaceMaterial {
  const s = surfaceFromMaterial(m, false, textures);
  const glass = (s.transmission ?? 0) > 0;
  const grey = glass ? 1 : CLAY_ALBEDO;
  return {
    ...s,
    r: grey,
    g: grey,
    b: grey,
    metallic: 0,
    roughness: glass ? s.roughness : CLAY_ROUGHNESS,
    er: 0,
    eg: 0,
    eb: 0,
    emissionStrength: 0,
    vertexColors: false,
    tex: s.blend !== 0 ? s.tex : null,
    alphaOnly: true,
    procedural: s.procedural?.alpha ? alphaOnlyProcedural(s.procedural) : null,
  };
}

/** The alpha channel of a procedural surface alone (its other channels give way to the clay). */
function alphaOnlyProcedural(p: ProceduralSurface): ProceduralSurface {
  const patternOf = { ...p.patternOf };
  for (const k of Object.keys(patternOf) as (keyof typeof patternOf)[]) patternOf[k] = -1;
  patternOf.alpha = 0;
  return {
    ...p,
    base_color: null,
    metallic: null,
    roughness: null,
    normal: null,
    emission: null,
    bump: 0,
    patterns: [p.patterns[p.patternOf.alpha]],
    patternOf,
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
 * Packs scene lights for the shader; without lamps, without environment lighting (`envLit`: a
 * sky, studio or image world) and without other light (`otherLight`: emissive surfaces or a bright
 * world colour) a camera-relative studio rig — exactly when the path tracer adds one.
 */
function buildLights(
  scene: EvaluatedScene,
  view: RenderView,
  skyLight: number[] | null = null,
  envLit = false,
  otherLight = false,
  skyCaster: LightCaster | null = null,
): { data: Float64Array; count: number; studio: boolean; casters: (LightCaster | null)[] } {
  const out: number[] = [];
  // per packed light: how it casts shadows (`SoftwareRenderOptions.shadows`), or null
  const casters: (LightCaster | null)[] = [];
  // a procedural sky lights the scene itself (its sun, when up): no studio rig
  if (skyLight) {
    out.push(...skyLight);
    if (skyLight.length) casters.push(skyCaster);
  }
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
    casters.push(
      kind === LIGHT_SUN
        ? {
            kind: 'sun',
            toLight: [-dir[0], -dir[1], -dir[2]],
            angularRadius: Math.max(0, l.angle ?? DEFAULT_SUN_ANGLE) / 2,
            use: l.use_shadow,
          }
        : kind === LIGHT_SPOT
          ? {
              kind: 'spot',
              position: [M[12], M[13], M[14]],
              direction: dir,
              spotSize: l.spot_size,
              radius: Math.max(0, l.shadow_soft_size),
              use: l.use_shadow,
            }
          : null,
    );
  }
  if (out.length || skyLight || envLit || otherLight)
    return { data: new Float64Array(out), count: out.length / LIGHT_STRIDE, studio: false, casters };
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
  // (the camera-relative rig never casts shadows)
  return { data: new Float64Array(out), count: rig.length, studio: true, casters: rig.map(() => null) };
}

/** A packed light's shadow caster and whether the light's own `use_shadow` is on. */
type LightCaster = ShadowCaster & { use: boolean };

/** Blender's default sun angle (angular diameter, 0.526°) for SUN lamps without one. */
const DEFAULT_SUN_ANGLE = (0.526 * Math.PI) / 180;

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
  const k = supersampling(width, height, opts.samples);
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
  const look = opts.look ?? 'material';
  const solid = opts.shading === 'SOLID' || look === 'solid';
  const clay = !solid && look === 'clay';
  const aovNames = new Set(opts.aovs ?? []);
  const lines = opts.lines?.length ? opts.lines : null;
  // the sample buffers are reused from render to render (buffers.ts)
  const r = new Rasterizer(W, H, view, {
    color: pooledFloat32('main:color', W * H * 3),
    cov: pooledFloat32('main:cov', W * H),
    depth: pooledFloat32('main:depth', W * H),
  });
  r.shadingBlock = k;
  r.msaa = !!opts.msaa;
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
  // emissive surfaces or a bright world light the scene themselves (no studio rig, like the path
  // tracer, which samples emitters as lights; the clay look has no emission)
  const lumW = 0.2126 * world.color[0] + 0.7152 * world.color[1] + 0.0722 * world.color[2];
  const otherLight =
    lumW * ws >= 0.1 ||
    (!clay &&
      meshes.some((o) =>
        o.materials.some(
          (m) =>
            !!m &&
            (m.emission_strength ?? 0) > 0 &&
            (m.emission_color.some((c) => c > 0) || !!m.textures?.emission?.procedural),
        ),
      ));
  const lights = solid
    ? null
    : buildLights(scene, view, sky?.sunLight ?? null, !!env, otherLight, sky?.sunCaster ?? null);
  /** Shadow maps of the packed lights (built below, before anything is shaded). */
  let shadowMaps: (ShadowMap | null)[] | null = null;
  /** World lighting of a rasterizer (the main view and the reflection probe faces). */
  const light = (ras: Rasterizer) => {
    if (!lights) return;
    ras.lights = lights.data;
    ras.lightCount = lights.count;
    ras.shadowMaps = shadowMaps;
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
  // the object pass's table: object ids (instances: their source object), sorted; 0 = nothing
  const objectTable = aovNames.has('object')
    ? ['', ...[...new Set(meshes.map((o) => o.object.id))].sort()]
    : null;
  const objectIndex = new Map(objectTable?.map((id, i) => [id, i]) ?? []);
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
    } else if (clay) {
      mats = o.materials.map((m) => claySurface(m, textures));
      fallback = claySurface(null, textures);
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
    return { o, mesh, mats, fallback, texSpace, objIndex: objectIndex.get(o.object.id) ?? 0 };
  });
  // world-space vertices per item, shared by the main view, the shadow maps and the probe's faces
  const worldCache = new Map<Mat4, WorldVertices>();
  const drawItem = (ras: Rasterizer, d: (typeof draws)[number]) => {
    ras.objectIndex = d.objIndex;
    if (d.texSpace) ras.drawMesh(d.mesh, d.o.worldMatrix, d.mats, d.fallback, d.texSpace);
    else ras.drawMesh(d.mesh, d.o.worldMatrix, d.mats, d.fallback);
  };
  const drawOpaque = (ras: Rasterizer) => {
    ras.bufferCache = RENDER_BUFFERS;
    ras.worldCache = worldCache;
    for (const d of draws) drawItem(ras, d);
  };
  const drawAll = (ras: Rasterizer) => {
    drawOpaque(ras);
    // alpha-blended and glass surfaces last, back to front
    ras.flushTransparent();
  };
  // shadow maps of the suns (the sky's included) and spot lights (`shadows`; never the studio rig)
  const shadowMode = opts.shadows ?? false;
  if (
    lights &&
    !lights.studio &&
    (shadowMode === true || (shadowMode === 'scene' && scene.render.use_shadows !== false))
  ) {
    const depthPass =
      (role: string): DepthPass =>
      (v, w, h) => {
        const ras = new Rasterizer(w, h, v, {
          color: NO_SAMPLES,
          cov: NO_SAMPLES,
          depth: pooledFloat32(role, w * h),
        });
        ras.mode = SHADE_DEPTH;
        ras.sortTriangles = false;
        drawOpaque(ras);
        return ras.depth;
      };
    let boxes: Bounds[] | null = null;
    const maps = lights.casters.map((c, i) => {
      if (!c || (shadowMode === 'scene' && !c.use)) return null;
      if (c.kind === 'sun') {
        boxes ??= draws.map((d) => itemBounds(d.mesh, d.o.worldMatrix)).filter((b): b is Bounds => !!b);
        return buildSunShadow(c, view, boxes, opts.shadowFit ?? null, depthPass(`shadow:${i}`));
      }
      return buildSpotShadow(c, bounds, depthPass(`shadow:${i}`));
    });
    if (maps.some((m) => m)) shadowMaps = maps;
    r.shadowMaps = shadowMaps;
  }
  // the nearest sample of every output pixel: AOV passes, ambient occlusion and line occlusion
  const pixels: PixelBuffers | null =
    aovNames.size || opts.ao || lines
      ? {
          width,
          height,
          key: pooledFloat32('pixels:key', width * height),
          normal: pooledFloat32('pixels:normal', width * height * 3),
          object: objectTable ? pooledUint32('pixels:object', width * height) : null,
        }
      : null;
  r.pixels = pixels;
  if (opts.ao) r.ambientShare = pooledUint32('main:ambient', W * H);
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
  drawOpaque(r);
  // how far the opaque surface each pixel shows lies (once for ambient occlusion and lines; lines
  // are hidden by opaque surfaces only: seen through glass)
  const opaqueDepth =
    pixels && (r.ambientShare || lines)
      ? linearDepths(pixels.key, view, pooledFloat32('pixels:depth', width * height))
      : null;
  if (pixels && opaqueDepth && r.ambientShare) {
    // ambient occlusion of the opaque surfaces, before the transparent ones are blended over them
    const radius =
      typeof opts.aoRadius === 'number' && opts.aoRadius > 0 && Number.isFinite(opts.aoRadius)
        ? opts.aoRadius
        : defaultAoRadius(meshes);
    const ao = ambientOcclusion(pixels, view, radius, opaqueDepth);
    applyAmbientOcclusion(r.color, r.ambientShare, ao, W, H, k);
    r.ambientShare = null;
  }
  r.flushTransparent();

  // ---------------------------------------------------------------- resolve (box filter, display)
  const exposure = Math.pow(2, scene.render.exposure ?? 0);
  // the scene's view transform, like the path tracer and the browser's Rendered view (SOLID
  // shading keeps Standard, like the viewport's Solid mode)
  const vt = solid ? 'STANDARD' : viewTransformOf(scene.render.view_transform);
  // Film > Transparent (like the path tracer): nothing behind the surfaces, alpha = their coverage
  const transparent = !opts.background && !!scene.render.film_transparent;
  // an explicit background: display values, composited behind the surfaces as they are (no
  // exposure, no view transform)
  const explicit: [number, number, number, number] | null = opts.background
    ? [
        clamp01(opts.background[0]),
        clamp01(opts.background[1]),
        clamp01(opts.background[2]),
        clamp01(opts.background[3] ?? 1),
      ]
    : null;
  // the world behind uncovered samples (scene-linear, before exposure)
  const bg: [number, number, number] = [world.color[0] * ws, world.color[1] * ws, world.color[2] * ws];
  // the procedural sky / studio / image as background, per pixel along the camera ray
  const skyBg =
    (sky || env) && !opts.background && !transparent && world.show_environment_background
      ? pixelRays(view, width, height)
      : null;
  const skyPx = [0, 0, 0];
  const envPx = new Float64Array(3);
  /** The world behind pixel (x, y) into `bg` (sky, studio or image background). */
  const sampleBackground = (x: number, y: number) => {
    if (!skyBg) return;
    if (sky) {
      const d = skyBg.dir(x, y);
      sampleSkyPixel(sky.model, d[0], d[1], d[2], skyBg.pixelRadius, skyPx);
      bg[0] = skyPx[0] * sky.scale;
      bg[1] = skyPx[1] * sky.scale;
      bg[2] = skyPx[2] * sky.scale;
    } else if (env) {
      // the full-resolution world (not the prefiltered lighting maps)
      const d = skyBg.dir(x, y);
      sampleEnvironmentBackground(env, d[0], d[1], d[2], envPx);
      bg[0] = envPx[0];
      bg[1] = envPx[1];
      bg[2] = envPx[2];
    }
  };
  // Standard keeps the exact sRGB conversion and linear compositing of an explicit background; the
  // other view transforms go through a linear film, a row at a time (no image-sized film), and the
  // path tracer's display conversion
  const standard = vt === 'STANDARD';
  const film = standard ? null : pooledFloat32('film', width * 4);
  const out = new Uint8ClampedArray(width * height * 4);
  const explicitLin = explicit
    ? [srgbToLinear(explicit[0]), srgbToLinear(explicit[1]), srgbToLinear(explicit[2]), explicit[3]]
    : null;
  const inv = 1 / (k * k);
  const color = r.color;
  const cov = r.cov;
  const tonemap = opts.resolve === 'tonemap';
  const dither = !!opts.dither;
  // what lies behind the uncovered part: the world (alpha 1), or nothing
  const behind = !explicit && !transparent;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let cv = 0;
      if (tonemap) {
        // a pixel whose samples all hold one opaque colour (msaa interiors) needs no weights
        const s0 = y * k * W + x * k;
        cr = color[s0 * 3];
        cg = color[s0 * 3 + 1];
        cb = color[s0 * 3 + 2];
        cv = 1;
        let uniform = true;
        for (let sy = 0; sy < k && uniform; sy++) {
          let s = (y * k + sy) * W + x * k;
          for (let sx = 0; sx < k; sx++, s++)
            if (cov[s] !== 1 || color[s * 3] !== cr || color[s * 3 + 1] !== cg || color[s * 3 + 2] !== cb) {
              uniform = false;
              break;
            }
        }
        if (!uniform) {
          // each sample weighted by 1 / (1 + luminance) of its exposed colour (over the world when
          // the world shows): a bright sample can no longer dominate its pixel, so bright edges
          // alias less (the weights are undone by the average of the weighted samples). The
          // weights choose the colour only: with nothing behind (Film > Transparent, an explicit
          // background) alpha stays the samples' plain coverage, as in the box resolve
          cr = 0;
          cg = 0;
          cb = 0;
          cv = 0;
          let cover = 0;
          for (let sy = 0; sy < k; sy++) {
            let s = (y * k + sy) * W + x * k;
            for (let sx = 0; sx < k; sx++, s++) cover += cov[s];
          }
          if (behind && cover < k * k) sampleBackground(x, y);
          let wsum = 0;
          for (let sy = 0; sy < k; sy++) {
            let s = (y * k + sy) * W + x * k;
            for (let sx = 0; sx < k; sx++, s++) {
              let a = cov[s];
              let sr = color[s * 3];
              let sg = color[s * 3 + 1];
              let sb = color[s * 3 + 2];
              if (behind) {
                sr += bg[0] * (1 - a);
                sg += bg[1] * (1 - a);
                sb += bg[2] * (1 - a);
                a = 1;
              }
              const w = 1 / (1 + Math.max(0, 0.2126 * sr + 0.7152 * sg + 0.0722 * sb) * exposure);
              cr += sr * w;
              cg += sg * w;
              cb += sb * w;
              cv += a * w;
              wsum += w;
            }
          }
          if (behind) {
            const iw = 1 / wsum;
            cr *= iw;
            cg *= iw;
            cb *= iw;
            cv = 1;
          } else {
            // the covered samples' weighted colour (Σ c·w / Σ a·w, c premultiplied by a), times
            // their plain coverage: premultiplied by the coverage the box resolve gives
            const a = cover * inv;
            const s = cv > 0 ? a / cv : 0;
            cr *= s;
            cg *= s;
            cb *= s;
            cv = a;
          }
        }
      } else {
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
        cr *= inv;
        cg *= inv;
        cb *= inv;
        if (cv < 1) sampleBackground(x, y);
      }
      if (film) {
        const f = x * 4;
        film[f] = cr + (behind ? bg[0] * (1 - cv) : 0);
        film[f + 1] = cg + (behind ? bg[1] * (1 - cv) : 0);
        film[f + 2] = cb + (behind ? bg[2] * (1 - cv) : 0);
        film[f + 3] = behind ? 1 : cv;
        continue;
      }
      const o = (y * width + x) * 4;
      let rest = 0;
      let br = 0;
      let bgG = 0;
      let bb = 0;
      if (explicitLin) {
        rest = (1 - cv) * explicitLin[3];
        br = explicitLin[0];
        bgG = explicitLin[1];
        bb = explicitLin[2];
      } else if (behind) {
        rest = 1 - cv;
        br = bg[0] * exposure;
        bgG = bg[1] * exposure;
        bb = bg[2] * exposure;
      }
      const a = cv + rest;
      if (a > 0) {
        const ia = 1 / a;
        if (dither) {
          // (as `ditherByte`: the clamped array clamps to 0..255)
          const t = ditherThreshold(x, y);
          out[o] = Math.floor(linearToSrgb255((cr * exposure + br * rest) * ia) + t);
          out[o + 1] = Math.floor(linearToSrgb255((cg * exposure + bgG * rest) * ia) + t);
          out[o + 2] = Math.floor(linearToSrgb255((cb * exposure + bb * rest) * ia) + t);
        } else {
          out[o] = linearToSrgbByte((cr * exposure + br * rest) * ia);
          out[o + 1] = linearToSrgbByte((cg * exposure + bgG * rest) * ia);
          out[o + 2] = linearToSrgbByte((cb * exposure + bb * rest) * ia);
        }
      }
      out[o + 3] = Math.round(a * 255);
    }
    if (film) filmRowsToRGBA8(film, width, y, 1, out, exposure, vt, explicit, dither);
  }
  const data = out;
  const image: RenderedImage = { width, height, data };
  if (lines && opaqueDepth) drawLines(data, width, height, lines, view, { depth: opaqueDepth });
  if (pixels && aovNames.size) image.aovs = renderAovs(pixels, view, aovNames, objectTable);
  if (aovNames.size || lines) image.view = view;
  return image;
}

/** What `estimateRenderBufferBytes` reads of a render's options. */
export type RenderBufferOptions = Pick<
  SoftwareRenderOptions,
  'width' | 'height' | 'samples' | 'shading' | 'look' | 'shadows' | 'ao' | 'aovs' | 'lines'
>;

/** Bytes of a sun's shadow map (its longer side 2048 texels) and of a spot light's. */
const SUN_MAP_BYTES = SUN_SHADOW_MAP_SIZE * SUN_SHADOW_MAP_SIZE * 4;
const SPOT_MAP_BYTES = SPOT_SHADOW_MAP_SIZE * SPOT_SHADOW_MAP_SIZE * 4;

/**
 * Upper bound of the memory outside the JavaScript heap (typed-array buffers) that a RASTER
 * `renderSceneSoftware` with these options holds when it returns: the working buffers it keeps for
 * the next render (buffers.ts; `releaseRenderBuffers` frees them) and the image and passes it
 * returns. Not counted: the meshes' render buffers and world-space vertices (about proportional to
 * the triangles drawn) and a few small helper renders. With `doc`, the shadow maps follow its suns,
 * spot lights and SKY world and the display film its view transform; without, one sun map and a
 * film are counted (the desk's SKY sun and AgX). Measured, about 330 MB at 1920 × 1080 with 2 × 2
 * samples, shadows, ambient occlusion, lines and the three passes, 750 MB at 3840 × 2160 (1 sample
 * per pixel there): `MAX_SAMPLES` caps the samples, not this.
 */
export function estimateRenderBufferBytes(opts: RenderBufferOptions, doc?: SceneDoc): number {
  const width = Math.round(opts.width);
  const height = Math.round(opts.height);
  if (!(width >= 1 && height >= 1)) return 0;
  const k = supersampling(width, height, opts.samples);
  const n = width * height;
  const samples = n * k * k;
  const solid = opts.shading === 'SOLID' || opts.look === 'solid';
  const aovs = new Set(opts.aovs ?? []);
  const lines = !!opts.lines?.length;
  const ao = !!opts.ao;
  // samples: colour, coverage, depth; the ambient share of each with ambient occlusion
  let bytes = samples * (12 + 4 + 4) + (ao ? samples * 4 : 0);
  // every pixel's nearest sample: depth key, normal, object index
  if (aovs.size || ao || lines) bytes += n * (4 + 12) + (aovs.has('object') ? n * 4 : 0);
  // the opaque surfaces' distances; the occlusion's working buffers
  if (ao || lines) bytes += n * 4;
  if (ao) bytes += aoBufferBytes(width, height);
  // one row of display film for view transforms other than Standard
  const vt = solid ? 'STANDARD' : doc ? viewTransformOf(doc.getRender().view_transform) : 'AGX';
  if (vt !== 'STANDARD') bytes += width * 16;
  if (!solid) bytes += shadowMapBytes(opts.shadows ?? false, doc);
  // returned: the RGBA8 image and the passes
  bytes += n * 4;
  if (aovs.has('depth')) bytes += n * 4;
  if (aovs.has('normal')) bytes += n * 12;
  if (aovs.has('object')) bytes += n * 4;
  return bytes;
}

/** Bytes of the shadow maps a render with `shadows` builds (at most; see `estimateRenderBufferBytes`). */
function shadowMapBytes(shadows: boolean | 'scene', doc: SceneDoc | undefined): number {
  if (!shadows) return 0;
  if (!doc) return SUN_MAP_BYTES;
  const scene = shadows === 'scene';
  if (scene && doc.getRender().use_shadows === false) return 0;
  let bytes = doc.getWorld().environment === 'SKY' ? SUN_MAP_BYTES : 0;
  for (const o of doc.listObjects()) {
    if (o.type !== 'LIGHT' || !o.data || o.hide_render) continue;
    const light = doc.getLight(o.data);
    if (!light || (scene && !light.use_shadow)) continue;
    if (light.type === 'SUN') bytes += SUN_MAP_BYTES;
    else if (light.type === 'SPOT') bytes += SPOT_MAP_BYTES;
  }
  return bytes;
}

/** Samples per pixel side of a RASTER render: `samples` as 1, 2 or 4, less when the buffer would be too large. */
function supersampling(width: number, height: number, samples: number | undefined): number {
  let k = samples ?? 2;
  k = k >= 4 ? 4 : k >= 2 ? 2 : 1;
  while (k > 1 && width * height * k * k > MAX_SAMPLES) k = k === 4 ? 2 : 1;
  return k;
}

/** Empty colour and coverage buffers of depth-only rasterizers (shadow maps). */
const NO_SAMPLES = new Float32Array(0);

/** World-space bounds of a mesh under a matrix (the exact box around its transformed bounds). */
function itemBounds(mesh: MeshData, M: Mat4): Bounds | null {
  const b = meshBounds(mesh);
  if (!b) return null;
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const h = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const mid = M[i] * c[0] + M[4 + i] * c[1] + M[8 + i] * c[2] + M[12 + i];
    const r = Math.abs(M[i]) * h[0] + Math.abs(M[4 + i]) * h[1] + Math.abs(M[8 + i]) * h[2];
    min[i] = mid - r;
    max[i] = mid + r;
  }
  return Number.isFinite(min[0] + min[1] + min[2] + max[0] + max[1] + max[2]) ? { min, max } : null;
}

/** Share of the median item size that ambient occlusion reaches, and its bounds in metres. */
const AO_RADIUS_SHARE = 0.25;
const AO_RADIUS_MIN = 0.05;
const AO_RADIUS_MAX = 0.5;

/** Extents (x, y, z) of meshes' own bounds, kept while a mesh is alive (meshes are immutable). */
const MESH_EXTENTS = new WeakMap<MeshData, Vec3 | null>();

function meshExtents(mesh: MeshData): Vec3 | null {
  let e = MESH_EXTENTS.get(mesh);
  if (e === undefined) {
    const b = meshBounds(mesh);
    e = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : null;
    MESH_EXTENTS.set(mesh, e);
  }
  return e;
}

/**
 * The reach of ambient occlusion `renderSceneSoftware` uses when `aoRadius` is not given: a
 * quarter of the median size of the items drawn (renderable meshes and instances), between 5 and
 * 50 cm — contact shadows of human-scale sets, finer ones on a tabletop. An item's size is the
 * diagonal of its rest shape's own bounds (the mesh before modifiers) stretched by its world
 * scale: turning, moving or deforming things never changes it, adding, hiding or scaling them does.
 */
export function defaultAoRadius(items: readonly RenderItem[]): number {
  const sizes: number[] = [];
  for (const o of items) {
    const e = meshExtents(o.object.baseMesh ?? o.mesh);
    if (!e) continue;
    const M = o.worldMatrix;
    // the length of each local axis in the world (rotation-free scale)
    const sx = Math.hypot(M[0], M[1], M[2]);
    const sy = Math.hypot(M[4], M[5], M[6]);
    const sz = Math.hypot(M[8], M[9], M[10]);
    const s = Math.hypot(e[0] * sx, e[1] * sy, e[2] * sz);
    if (s > 0 && Number.isFinite(s)) sizes.push(s);
  }
  if (!sizes.length) return AO_RADIUS_MAX;
  sizes.sort((a, b) => a - b);
  return Math.min(AO_RADIUS_MAX, Math.max(AO_RADIUS_MIN, sizes[sizes.length >> 1] * AO_RADIUS_SHARE));
}

/** The AOV passes asked for, from the nearest sample of every pixel (see `RenderAovs`). */
function renderAovs(
  pixels: PixelBuffers,
  view: RenderView,
  names: ReadonlySet<SoftwareAovName>,
  objectTable: string[] | null,
): RenderAovs {
  const aovs: RenderAovs = {};
  if (names.has('depth')) aovs.depth = linearDepths(pixels.key, view);
  if (names.has('normal')) {
    const n = pixels.key.length;
    const out = new Float32Array(n * 3);
    const R = view.right;
    const U = view.up;
    const F = view.forward;
    const src = pixels.normal;
    for (let i = 0; i < n; i++) {
      if (!(pixels.key[i] > 0)) continue;
      const x = src[i * 3];
      const y = src[i * 3 + 1];
      const z = src[i * 3 + 2];
      // view space: x right, y up, z towards the camera
      const vx = x * R[0] + y * R[1] + z * R[2];
      const vy = x * U[0] + y * U[1] + z * U[2];
      const vz = -(x * F[0] + y * F[1] + z * F[2]);
      const l = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      out[i * 3] = vx / l;
      out[i * 3 + 1] = vy / l;
      out[i * 3 + 2] = vz / l;
    }
    aovs.normal = out;
  }
  if (names.has('object') && pixels.object && objectTable) {
    aovs.object = Uint32Array.from(pixels.object);
    aovs.objectTable = objectTable;
  }
  return aovs;
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
/**
 * Grid cells per axis of the coarse proxies that the reflection probe's faces and its depth
 * pre-pass draw instead of dense meshes (`Rasterizer.lodCells`): about one cell per face pixel
 * for an object that fills a face, so the tiny, blurred probe looks the same while a mesh of
 * hundreds of thousands of triangles no longer costs every probe pass as much as the main view.
 */
const PROBE_LOD_CELLS = 32;
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
  pre.sortTriangles = false;
  pre.lodCells = PROBE_LOD_CELLS;
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
  return [
    view.eye[0] + view.forward[0] * t,
    view.eye[1] + view.forward[1] * t,
    view.eye[2] + view.forward[2] * t,
  ];
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
    ras.sortTriangles = false;
    ras.lodCells = PROBE_LOD_CELLS;
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
): { model: SkyModel; sh: Float64Array; scale: number; sunLight: number[]; sunCaster: LightCaster } {
  const es = world.environment_strength;
  const scale = strength * (typeof es === 'number' && Number.isFinite(es) ? Math.max(0, es) : 1);
  const sun = skySun(world);
  const e = sun.irradiance;
  const d = sun.direction;
  const sunLight =
    sun.visible && scale > 0
      ? [LIGHT_SUN, 0, 0, 0, -d[0], -d[1], -d[2], e[0] * scale, e[1] * scale, e[2] * scale, 0, 0, 0]
      : [];
  // the sky's sun is the key light of outdoor scenes: it casts shadows like a SUN lamp (it has no
  // use_shadow of its own: `shadows: 'scene'` follows the render setting alone)
  const sunCaster: LightCaster = {
    kind: 'sun',
    toLight: [d[0], d[1], d[2]],
    angularRadius: sun.angularRadius,
    use: true,
  };
  return { model: prepareSky(world), sh: skyIrradianceSH(world), scale, sunLight, sunCaster };
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
