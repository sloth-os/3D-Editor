import type { PathTile, RenderEngine, ViewTransform } from '@3d-editor/core';

/*
 * Messages between the render pool (main thread) and its worker threads. Everything is plain,
 * structured-cloneable data; pixel and tile buffers are transferred, document states are shared.
 */

export type Vec3Tuple = [number, number, number];
export type Vec4Tuple = [number, number, number, number];

/** An explicit viewpoint (world space, Z up); fovY in radians. */
export interface ViewSpecInput {
  position: Vec3Tuple;
  target: Vec3Tuple;
  up?: Vec3Tuple;
  fovY?: number;
}

/**
 * A document state to render: `key` identifies the document instance (render threads keep a small
 * cache of documents by key and apply `update`, a full Yjs state update, on top of what they
 * have). `version` names this exact state: a thread that already applied it skips the update.
 */
export interface DocRef {
  key: string;
  version: number;
  update: Uint8Array | SharedArrayBuffer;
}

/** Options of one rendered image (a still or an animation frame). */
export interface FrameOptions {
  width: number;
  height: number;
  frame: number;
  /** RASTER or PATHTRACER (always explicit: `samples` then means samples per pixel when path tracing). */
  engine: RenderEngine;
  /** Camera object id or name (default: scene camera, else an automatic view). */
  cameraId?: string;
  /** Explicit view (overrides the camera). */
  view?: ViewSpecInput;
  shading?: 'SOLID' | 'MATERIAL';
  wireframe?: boolean;
  /** RASTER: anti-aliasing factor 1|2|4; PATHTRACER: samples per pixel (default: render settings). */
  samples?: number;
  /** PATHTRACER: maximum bounces (default: render settings). */
  max_bounces?: number;
  /** PATHTRACER: denoise (default: render settings). */
  denoise?: boolean;
  /** PATHTRACER: sampling time budget in seconds (0 / unset = none). */
  time_limit?: number;
  /** PATHTRACER: noise seed (default 0). */
  seed?: number;
  /** RGBA background (display values 0..1) instead of the world. */
  background?: Vec4Tuple;
}

/** What a worker reports after preparing a path traced render (scene compiled, tracer built). */
export interface PreparedInfo {
  width: number;
  height: number;
  /** Samples per pixel requested (resolved from the options and render settings). */
  samples: number;
  denoise: boolean;
  /** Seconds (0 = none). */
  timeLimit: number;
  exposure: number;
  viewTransform: ViewTransform;
  displayBackground: Vec4Tuple | null;
  warnings: string[];
  /** Milliseconds spent evaluating and compiling the scene. */
  prepareMs: number;
}

/** A rendered RGBA8 image (top row first). */
export interface ImageResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Path tracing statistics (absent for raster renders). */
  pathtrace?: { samples: number; requested: number; stopped: 'done' | 'time' | 'cancelled' };
  warnings?: string[];
}

/** The fixed automatic view of an animation without a camera (null when the scene has a camera). */
export type AutoViewResult = { position: Vec3Tuple; target: Vec3Tuple; up: Vec3Tuple; fovY: number } | null;

export type WorkerRequest =
  | { type: 'prepare'; id: number; job: number; doc: DocRef; options: FrameOptions }
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
  | { type: 'image'; id: number; doc: DocRef; options: FrameOptions }
  | {
      type: 'auto-view';
      id: number;
      doc: DocRef;
      frames: number[];
      aspect: number;
      camera?: string;
      /** Stop sampling frames for the bounds after this many milliseconds. */
      budgetMs?: number;
    }
  | { type: 'ping'; id: number };

export type WorkerResult = PreparedInfo | PathTile | ImageResult | AutoViewResult | { ok: true };

export type WorkerResponse =
  | { type: 'result'; id: number; result: WorkerResult }
  | { type: 'error'; id: number; message: string };

/** Error raised when a render is cancelled (client abort, shutdown). */
export class RenderCancelledError extends Error {
  constructor(message = 'render cancelled') {
    super(message);
    this.name = 'RenderCancelledError';
  }
}

export function isCancelled(err: unknown): err is RenderCancelledError {
  return err instanceof RenderCancelledError;
}
