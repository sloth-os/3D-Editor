import { decodePNG } from '../src/render/png';
import { SceneEvaluator } from '../src/eval/evaluate';
import { evaluatedBounds } from '../src/io/common';
import { renderItems } from '../src/eval/renderables';
import { viewFromCamera, viewFromSpec, defaultFovY, type RenderView } from '../src/render/view';
import { PathTracer, preparePathTrace, viewCameraData } from '../src/render/pathtrace';
import { evaluatedOrco } from '../src/material/orco';
import type { PathTraceRenderOptions } from '../src/render/pathtrace';
import type { SampledTexture } from '../src/render/raster';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { Vec3 } from '../src/math/types';

/** Shared helpers of the path tracer tests. */

export interface TraceSetup {
  width: number;
  height: number;
  samples?: number;
  maxBounces?: number;
  seed?: number;
  /** Explicit look-at view instead of the scene camera. */
  view?: { position: Vec3; target: Vec3; up?: Vec3; fovY?: number };
  options?: PathTraceRenderOptions;
}

/** Decodes PNG image datablocks of a document (like the renderer's texture cache). */
export function docImages(doc: SceneDoc): { get(id: string): SampledTexture | null } {
  return {
    get(id: string) {
      const bytes = doc.getImageBytes(id);
      if (!bytes) return null;
      try {
        return decodePNG(bytes);
      } catch {
        return null;
      }
    },
  };
}

/** Builds a path tracer for the document's scene camera (or an explicit view). */
export function tracerFor(doc: SceneDoc, s: TraceSetup): PathTracer {
  const scene = new SceneEvaluator(doc).evaluate(doc.getScene().frame_start, { forRender: true });
  const items = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
  const aspect = s.width / s.height;
  let view: RenderView;
  if (s.view)
    view = viewFromSpec(
      {
        position: s.view.position,
        target: s.view.target,
        up: s.view.up ?? [0, 0, 1],
        fovY: s.view.fovY ?? defaultFovY(aspect),
      },
      aspect,
      evaluatedBounds(items),
    );
  else {
    const cam = scene.activeCamera;
    if (!cam?.camera) throw new Error('test scene needs a camera');
    view = viewFromCamera(cam.camera, cam.worldMatrix, aspect);
  }
  const { scene: compiled, settings } = preparePathTrace({
    scene,
    items,
    view,
    camera: s.view ? null : viewCameraData(doc, scene, {}),
    width: s.width,
    height: s.height,
    images: docImages(doc),
    orco: (item) => evaluatedOrco(doc, scene, item.object, true),
    options: {
      samples: s.samples ?? 16,
      max_bounces: s.maxBounces,
      seed: s.seed,
      denoise: false,
      ...s.options,
    },
  });
  return new PathTracer(compiled, settings);
}

/** Renders and returns the mean linear premultiplied RGBA film (not denoised). */
export function traceLinear(doc: SceneDoc, s: TraceSetup): { tracer: PathTracer; img: Float32Array } {
  const tracer = tracerFor(doc, s);
  tracer.render();
  return { tracer, img: tracer.resolve(false) };
}

/** RGBA of pixel (x, y) of a linear film. */
export function at(img: Float32Array, width: number, x: number, y: number): number[] {
  const o = (y * width + x) * 4;
  return [img[o], img[o + 1], img[o + 2], img[o + 3]];
}

/** Mean RGBA over a pixel rectangle [x0, x1) × [y0, y1). */
export function mean(
  img: Float32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  const s = [0, 0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = at(img, width, x, y);
      for (let k = 0; k < 4; k++) s[k] += p[k];
      n++;
    }
  return s.map((v) => v / n);
}

/** Adds an orthographic camera looking straight down (−Z) from `height`, image up = +Y. */
export function topCamera(doc: SceneDoc, orthoScale: number, height = 10, lens?: number): string {
  const data = lens
    ? doc.addCamera({ name: 'Top', type: 'PERSP', lens, clip_end: 1000 })
    : doc.addCamera({ name: 'Top', type: 'ORTHO', ortho_scale: orthoScale, clip_end: 1000 });
  const id = doc.addObject({ type: 'CAMERA', name: 'Top', data, location: [0, 0, height] });
  doc.updateScene({ camera: id });
  return id;
}

/** Deterministic pseudo-random numbers in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
