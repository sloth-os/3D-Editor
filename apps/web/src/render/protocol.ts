import { pathTileTransferables, type GIFDither, type PathTile, type ViewTransform } from '@3d-editor/core';

/*
 * Messages between the browser render pool (main thread) and its Web Workers. Everything is plain,
 * structured-cloneable data; tile, film and pixel buffers are transferred.
 *
 * A path traced render: every worker gets the document (`prepare`: a Yjs state update, the whole
 * state the first time and only the difference afterwards), evaluates and compiles the scene itself
 * and then renders bands of rows for ranges of sample indices (`rows`). The main thread adds the
 * tiles to one film, shows it progressively, and has a worker denoise and tone map the mean film
 * (`finish`). Animations are encoded on a worker as well (`encode-*`).
 */

export type Vec3T = [number, number, number];
export type Vec4T = [number, number, number, number];

/**
 * A resolved camera view, the `RenderView` of the core renderers: column-major world → camera
 * (`view`) and projection matrices, the eye and the camera axes in world space.
 */
export interface RenderViewData {
  view: number[];
  proj: number[];
  viewProj: number[];
  eye: Vec3T;
  forward: Vec3T;
  right: Vec3T;
  up: Vec3T;
  ortho: boolean;
  near: number;
  far: number;
}

/**
 * A document state for a worker. `key` identifies the document instance (a worker caches the
 * document and scene evaluator of the last key it saw); `full` updates replace that document,
 * `diff` updates are applied on top of it.
 */
export interface DocPayload {
  key: string;
  kind: 'full' | 'diff';
  update: Uint8Array;
}

/** What a path traced image shows; resolved on the workers like core `renderSceneSoftware`. */
export interface PathTraceFrameOptions {
  width: number;
  height: number;
  /** Scene frame to evaluate. */
  frame: number;
  /** Camera object id or name (default: the scene camera, else an automatic view). */
  cameraId?: string;
  /** Look-at view (world space, Z up; fovY in radians); overrides the camera. */
  viewSpec?: { position: Vec3T; target: Vec3T; up: Vec3T; fovY: number };
  /** A ready view (e.g. the viewport's camera, without depth of field); overrides everything else. */
  view?: RenderViewData;
  /** Samples per pixel (default: render settings `samples`). */
  samples?: number;
  /** Maximum bounces of any kind (default: render settings `max_bounces`). */
  max_bounces?: number;
  /** Denoise the result (default: render settings `use_denoising`). */
  denoise?: boolean;
  /** Noise pattern seed (default 0). */
  seed?: number;
  /** RGBA background in display values 0..1 instead of the world (alpha < 1 = transparent). */
  background?: Vec4T;
}

/** What a worker reports after preparing a path traced render (scene evaluated and compiled). */
export interface PreparedInfo {
  width: number;
  height: number;
  /** Samples per pixel requested (options or render settings). */
  samples: number;
  denoise: boolean;
  /** Exposure factor 2^exposure of the display conversion. */
  exposure: number;
  viewTransform: ViewTransform;
  displayBackground: Vec4T | null;
  /** Non-fatal problems (undecodable images, evaluation errors of rendered objects). */
  warnings: string[];
  /** Milliseconds spent decoding images, evaluating and compiling the scene. */
  prepareMs: number;
}

/** Mean values of a path traced film (`PathFilm.resolve()`), denoised and tone mapped by `finish`. */
export interface FilmBuffers {
  width: number;
  height: number;
  color: Float32Array;
  emission: Float32Array;
  variance: Float32Array;
  albedo: Float32Array;
  normal: Float32Array;
  depth: Float32Array;
}

/** Display conversion of a film. */
export interface FinishOptions {
  denoise: boolean;
  exposure: number;
  viewTransform: ViewTransform;
  displayBackground: Vec4T | null;
}

/** RGBA8 pixels, row-major, top row first. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type EncodeFormat = 'APNG' | 'GIF';

/** Settings of an animation encoder session. */
export interface EncodeOptions {
  format: EncodeFormat;
  width: number;
  height: number;
  /** Playback rate in frames per second. */
  fps: number;
  /** Number of plays, 0 = forever (default). */
  loop?: number;
  /** GIF dithering (default FLOYD_STEINBERG). */
  dither?: GIFDither;
}

/** An encoded animation file. */
export interface EncodedFile {
  data: Uint8Array;
  frames: number;
}

export type WorkerRequest =
  | { type: 'prepare'; id: number; job: number; doc: DocPayload; options: PathTraceFrameOptions }
  | {
      type: 'rows';
      id: number;
      job: number;
      y0: number;
      y1: number;
      sampleStart: number;
      sampleCount: number;
    }
  /** Frees a prepared job (no response). */
  | { type: 'release'; job: number }
  | { type: 'finish'; id: number; film: FilmBuffers; options: FinishOptions }
  | { type: 'encode-begin'; id: number; session: number; options: EncodeOptions }
  | { type: 'encode-frame'; id: number; session: number; frame: PixelImage }
  | { type: 'encode-end'; id: number; session: number }
  /** Drops an encoder session (no response). */
  | { type: 'encode-abort'; session: number }
  | { type: 'ping'; id: number };

export type WorkerResult = PreparedInfo | PathTile | PixelImage | EncodedFile | { ok: true };

/** Error codes the main thread acts on. */
export type WorkerErrorCode = 'STALE_DOCUMENT';

export type WorkerResponse =
  | { type: 'result'; id: number; result: WorkerResult }
  | { type: 'error'; id: number; message: string; code?: WorkerErrorCode };

/** Raised when a render is cancelled. */
export class RenderCancelledError extends Error {
  constructor(message = 'Render cancelled') {
    super(message);
    this.name = 'RenderCancelledError';
  }
}

/** Raised by a worker asked to apply a `diff` update to a document it does not have. */
export class StaleDocumentError extends Error {
  readonly code = 'STALE_DOCUMENT' as const;
  constructor(message = 'the render worker does not have this document') {
    super(message);
    this.name = 'StaleDocumentError';
  }
}

/** The transferable buffers of a worker result (moved instead of copied). */
export function resultTransferables(result: WorkerResult): ArrayBuffer[] {
  if ('lum2' in result) return pathTileTransferables(result);
  if ('data' in result) return [result.data.buffer as ArrayBuffer];
  return [];
}

/** The transferable buffers of a mean film (moved to the worker that finishes it). */
export function filmTransferables(f: FilmBuffers): ArrayBuffer[] {
  return [f.color, f.emission, f.variance, f.albedo, f.normal, f.depth].map((a) => a.buffer as ArrayBuffer);
}
