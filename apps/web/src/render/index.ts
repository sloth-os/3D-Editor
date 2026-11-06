import { encodePNG, type SceneDoc } from '@3d-editor/core';
import { renderPool } from './pool';
import { startPathTrace, type PathTraceJob, type PathTraceOptions } from './path-trace';

/*
 * Browser rendering: path tracing on a pool of Web Workers (progressive, cancellable) and
 * animation rendering into APNG / GIF files. See `path-trace.ts`, `animation.ts` and `pool.ts`.
 */

export {
  MAX_THREADS,
  RenderPool,
  RenderThread,
  InProcessWorker,
  DocumentSnapshot,
  defaultThreadCount,
  documentKey,
  renderPool,
  type RenderPoolOptions,
  type WorkerFactory,
  type WorkerLike,
} from './pool';
export {
  PathTraceJob,
  startPathTrace,
  type PathTraceOptions,
  type PathTracePhase,
  type PathTraceResult,
  type PathTraceStatus,
} from './path-trace';
export {
  AnimationJob,
  MAX_ANIMATION_FRAMES,
  MAX_GIF_PIXELS,
  animationFrames,
  animationProblem,
  startAnimationRender,
  type AnimationPhase,
  type AnimationRenderOptions,
  type AnimationResult,
  type AnimationStatus,
  type FrameRender,
} from './animation';
export {
  applyLensShift,
  renderViewFromCamera,
  renderViewFromMatrices,
  sceneCameraView,
  viewportCamera,
} from './view';
export {
  MAX_RENDER_SIDE,
  finalRenderScene,
  renderOutputSize,
  scaledOutputNote,
  type RenderOutputSize,
} from './final';
export { filmRowsToRGBA8 } from './preview';
export { RenderCancelledError, type PixelImage, type RenderViewData, type EncodeFormat } from './protocol';

/** Path traces `doc` (as it is now) on the editor's render workers. */
export function pathTraceDocument(doc: SceneDoc, options: PathTraceOptions): PathTraceJob {
  return startPathTrace(renderPool(), doc, options);
}

/**
 * Copies RGBA8 pixels into a canvas (created when not given) and returns it; null where the
 * platform has no 2D canvas.
 */
export function pixelsToCanvas(
  img: { width: number; height: number; data: Uint8ClampedArray },
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): HTMLCanvasElement | null {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;
  const data = ctx.createImageData(img.width, img.height);
  data.data.set(img.data.subarray(0, data.data.length));
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** PNG data URL of RGBA8 pixels (the browser's encoder, else the core PNG encoder). */
export function pixelsToDataUrl(img: { width: number; height: number; data: Uint8ClampedArray }): string {
  const canvas = pixelsToCanvas(img);
  if (canvas) return canvas.toDataURL('image/png');
  const png = encodePNG({ width: img.width, height: img.height, data: img.data });
  let bin = '';
  for (let i = 0; i < png.length; i += 0x8000)
    bin += String.fromCharCode(...png.subarray(i, Math.min(png.length, i + 0x8000)));
  return `data:image/png;base64,${btoa(bin)}`;
}
