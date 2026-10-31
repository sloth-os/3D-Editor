import type { Vec4 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { CameraData, ViewTransform } from '../../doc/types';
import type { EvaluatedScene } from '../../eval/evaluate';
import type { RenderItem } from '../../eval/renderables';
import type { SampledTexture } from '../raster';
import type { RenderView } from '../view';
import { compileScene, type CompiledScene, type SceneLight } from './compile';
import { filmToRGBA8, viewTransformOf, type DisplayBackground } from './display';
import {
  PathTracer,
  pathTracerSettings,
  type PathTraceProgress,
  type PathTracerSettings,
  type PathTraceStats,
} from './tracer';

/** Path tracer options of a software render (see `SoftwareRenderOptions`). */
export interface PathTraceRenderOptions {
  /** Samples per pixel (default: render settings `samples`). */
  samples?: number;
  /** Maximum diffuse/glossy bounces (default: render settings `max_bounces`). */
  max_bounces?: number;
  /** Denoise the result (default: render settings `use_denoising`). */
  denoise?: boolean;
  /** Wall-clock budget in seconds (0 / unset = none; at least one sample is rendered). */
  time_limit?: number;
  /** Noise pattern seed (default 0). */
  seed?: number;
  /**
   * RGBA background in 0..1 display (sRGB) values instead of the world (alpha < 1 = transparent),
   * composited after the view transform so it shows exactly this colour.
   */
  background?: Vec4;
  /** Display transform (default: render settings `view_transform`). */
  view_transform?: ViewTransform;
  /** Cycles' Filter Glossy: blur glossy lobes after blurry bounces against caustic noise (default 1, 0 = off). */
  filter_glossy?: number;
  /** Called after every progressive pass; return false to stop early. */
  onProgress?: (p: PathTraceProgress) => boolean | void;
}

export interface PathTraceRenderInput {
  scene: EvaluatedScene;
  /** Geometry to render (`renderItems(scene, { forRender: true })`). */
  items: readonly RenderItem[];
  view: RenderView;
  /** Camera data of the view (depth of field), or null for explicit / automatic views. */
  camera: CameraData | null;
  width: number;
  height: number;
  /** Image decoder (the renderer's texture cache). */
  images: { get(id: string): SampledTexture | null };
  options?: PathTraceRenderOptions;
}

/** A path traced image (RGBA8, top row first) with render statistics. */
export interface PathTracedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  stats: PathTraceStats & { warnings: string[] };
}

/** Camera object data used by a software render's view (same precedence as the view resolution). */
export function viewCameraData(
  doc: SceneDoc,
  scene: EvaluatedScene,
  opts: { view?: unknown; cameraId?: string },
): CameraData | null {
  if (opts.view) return null;
  if (opts.cameraId) {
    const o = doc.resolveObject(opts.cameraId);
    const ev = o ? scene.byId.get(o.id) : undefined;
    return ev?.type === 'CAMERA' ? (ev.camera ?? null) : null;
  }
  const cam = scene.activeCamera;
  return cam && cam.type === 'CAMERA' ? (cam.camera ?? null) : null;
}

/** Visible light objects of an evaluated scene. */
export function sceneLights(scene: EvaluatedScene): SceneLight[] {
  const out: SceneLight[] = [];
  for (const o of scene.objects)
    if (o.type === 'LIGHT' && o.light && o.renderVisible)
      out.push({ id: o.id, light: o.light, matrix: o.worldMatrix });
  return out;
}

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Everything a (possibly distributed) render needs; see `preparePathTrace`. */
export interface PreparedPathTrace {
  scene: CompiledScene;
  settings: PathTracerSettings;
  /** Exposure factor 2^exposure for the display conversion. */
  exposure: number;
  /** View transform for the display conversion (`filmToRGBA8`). */
  viewTransform: ViewTransform;
  /** Explicit display-space background to composite in `filmToRGBA8`, or null. */
  displayBackground: DisplayBackground | null;
}

/**
 * Compiles the scene and the tracer settings of a render (render settings, world background,
 * film transparency, mist and the option overrides). The result is plain data: post it to workers
 * and construct a `PathTracer` from it on each of them.
 */
export function preparePathTrace(input: PathTraceRenderInput): PreparedPathTrace {
  const ev = input.scene;
  const render = ev.render;
  const world = ev.world;
  const o = input.options ?? {};
  const exposure = Math.pow(2, fin(render.exposure, 0));
  const compiled = compileScene({
    items: input.items,
    lights: sceneLights(ev),
    world,
    view: input.view,
    camera: input.camera,
    width: input.width,
    height: input.height,
    image: (id) => input.images.get(id),
  });
  let background: PathTracerSettings['background'] = 'COLOR';
  let displayBackground: DisplayBackground | null = null;
  const ws = Math.max(0, fin(world.strength, 1));
  const backgroundColor: PathTracerSettings['backgroundColor'] = [
    Math.max(0, fin(world.color?.[0], 0)) * ws,
    Math.max(0, fin(world.color?.[1], 0)) * ws,
    Math.max(0, fin(world.color?.[2], 0)) * ws,
    1,
  ];
  if (o.background) {
    // display values like the rasterizer (not affected by exposure or view transform): the film
    // stays transparent where camera rays escape and the colour is composited after display
    background = 'TRANSPARENT';
    const b = o.background;
    const c = (v: unknown) => Math.min(1, Math.max(0, fin(v, 0)));
    displayBackground = [c(b[0]), c(b[1]), c(b[2]), Math.min(1, Math.max(0, fin(b[3], 1)))];
  } else if (render.film_transparent) background = 'TRANSPARENT';
  else if (world.show_environment_background && world.environment !== 'NONE') background = 'ENVIRONMENT';
  const settings = pathTracerSettings({
    width: input.width,
    height: input.height,
    samples: o.samples ?? render.samples,
    maxBounces: o.max_bounces ?? render.max_bounces,
    denoise: o.denoise ?? render.use_denoising,
    timeLimit: o.time_limit ?? 0,
    seed: o.seed ?? 0,
    filterGlossy: o.filter_glossy ?? 1,
    background,
    backgroundColor,
    mistDensity: fin(world.mist_density, 0),
    mistColor: world.mist_color ?? [0, 0, 0],
  });
  return {
    scene: compiled,
    settings,
    exposure,
    viewTransform: viewTransformOf(o.view_transform ?? render.view_transform),
    displayBackground,
  };
}

/** Path traces an evaluated scene and returns display-ready RGBA8 pixels. */
export function renderPathTracedImage(input: PathTraceRenderInput): PathTracedImage {
  const { scene, settings, exposure, viewTransform, displayBackground } = preparePathTrace(input);
  const tracer = new PathTracer(scene, settings);
  const stats = tracer.render(settings.samples, input.options?.onProgress);
  const linear = tracer.resolve();
  return {
    width: settings.width,
    height: settings.height,
    data: filmToRGBA8(linear, settings.width, settings.height, exposure, viewTransform, displayBackground),
    stats: { ...stats, warnings: [...scene.warnings] },
  };
}
