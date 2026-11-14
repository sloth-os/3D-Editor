import type {
  DeskShotInfo,
  DeskShotOptions,
  ExportFormat,
  FrameOptions,
  ImageResult,
  PathTile,
  SimulatedFrames,
  Vec3Tuple,
  Vec4Tuple,
  ViewTransform,
} from '@3d-editor/core';

/*
 * Messages between the render pool (the server's main thread) and its render processes, over the
 * IPC channel of `child_process.fork` with advanced serialization (the structured clone algorithm:
 * typed arrays are copied, nothing is shared or transferred). The single-thread mode runs the same
 * requests on the main thread. The frame options and results of video exports are core's
 * (export/protocol.ts), shared with the browser export's render workers.
 */

export {
  RenderCancelledError,
  isCancelled,
  type DeskFrameOptions,
  type DeskShotInfo,
  type DeskShotOptions,
  type FrameMeta,
  type FrameOptions,
  type ImageResult,
  type PassName,
  type PhysicsFrame,
  type SimulatedFrames,
  type Vec3Tuple,
  type Vec4Tuple,
  type ViewSpecInput,
} from '@3d-editor/core';

/**
 * A document state to render: `key` identifies the document instance (render threads keep a small
 * cache of documents by key and apply `update`, a full Yjs state update, on top of what they
 * have). `version` names this exact state: a thread that already applied it skips the update. The
 * pool leaves `update` out of the message when the render process already has `version` (a
 * process without it answers with a `missing-doc` error and gets the request again with it).
 */
export interface DocRef {
  key: string;
  version: number;
  update?: Uint8Array;
}

/**
 * What a render process holds (request `memory`): its `process.memoryUsage()` in bytes (the
 * renderer's buffers are typed arrays: `arrayBuffers`). A video export asks the processes it would
 * render on: what they hold already, it needs no more of the machine (video/memory.ts).
 */
export interface ProcessMemory {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
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
  /** Milliseconds spent loading the document, evaluating and compiling the scene. */
  prepareMs: number;
  /**
   * Part of `prepareMs` spent loading the document and evaluating the scene (animation, physics,
   * modifiers): like core `renderSceneSoftware`, time limits cover compiling and sampling only.
   */
  setupMs: number;
}

/**
 * The mean film of a path traced render (`PathFilm.resolve()`): what `finish` denoises and tone
 * maps on a render thread.
 */
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
  displayBackground: Vec4Tuple | null;
  /** Return the PNG file instead of the pixels. */
  png: boolean;
}

/** Options of an export (core `exportScene`). */
export interface ExportJobOptions {
  /** Only these objects (ids; default every object shown in renders). */
  objectIds?: string[];
  /** Apply the modifier stacks (default true). */
  applyModifiers?: boolean;
  /** Frame the scene is evaluated at (default the scene's frame_start). */
  frame?: number;
  /**
   * glTF: size in pixels (64–4096) of the square images procedural textures are baked into
   * (default: chosen per mesh from its size, see core ExportOptions.bakeResolution).
   */
  bakeResolution?: number;
}

/** An exported file. */
export interface ExportedFile {
  data: Uint8Array;
  mime: string;
  extension: string;
  warnings: string[];
  /** Milliseconds the export took on the render thread. */
  ms: number;
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
  /** Renders a whole image on the thread; `png` returns the PNG file instead of the pixels. */
  | { type: 'image'; id: number; doc: DocRef; options: FrameOptions; png?: boolean }
  /** Denoises and tone maps a film. */
  | { type: 'finish'; id: number; film: FilmBuffers; options: FinishOptions }
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
  /** Encodes kept animation frames as a GIF or a contact sheet PNG. */
  | { type: 'encode'; id: number; frames: RawFrame[]; options: EncodeOptions }
  /**
   * Adds the next frame of APNG job `job` (frames in order; the encoder of the job lives on this
   * thread, created by the first frame with `init`). Freed by `apng-finish` or `release`.
   */
  | { type: 'apng-add'; id: number; job: number; frame: RawFrame; init?: APNGInit }
  /** Returns the APNG file of `job` and frees its encoder. */
  | { type: 'apng-finish'; id: number; job: number }
  /** Simulates the rigid body world up to the given frames and returns their matrices. */
  | { type: 'simulate'; id: number; doc: DocRef; frames: number[] }
  /** Measures the per-shot settings of a video export (depth range, shadow box). */
  | { type: 'desk-shot'; id: number; doc: DocRef; options: DeskShotOptions }
  /** Exports the document (glTF, OBJ, STL, PLY) off the event loop. */
  | { type: 'export'; id: number; doc: DocRef; format: ExportFormat; options: ExportJobOptions }
  /** Drops the cached documents (an idle thread frees its memory; no response). */
  | { type: 'clear' }
  /**
   * Drops the renderer's pooled working buffers (core `releaseRenderBuffers`: about 140 MB at
   * 1280×720, 300 MB at 1080p) and collects garbage right after, so they are freed now instead of
   * at some later collection, which an idle process may not run for a long time: sent at the end of
   * a video export (no response). Freed memory goes back to the system when the allocator returns
   * it: the pool starts render processes with a fixed glibc mmap threshold of 1 MiB
   * (MALLOC_MMAP_THRESHOLD_), so that the buffers, mapped on their own, are unmapped when freed;
   * with glibc's default (dynamic) threshold those of a 720p frame stayed in its heap.
   */
  | { type: 'release-buffers' }
  /**
   * Part of the state of document `key` at `version` (`total` bytes; this part starts at
   * `offset`; no response). The pool sends a state larger than `DOC_PART_BYTES` in such parts,
   * followed by the request that needs it, whose `doc` then has no `update`.
   */
  | { type: 'doc-part'; key: string; version: number; offset: number; total: number; bytes: Uint8Array }
  | { type: 'ping'; id: number }
  /** What the process holds now (`ProcessMemory`). */
  | { type: 'memory'; id: number }
  /**
   * Test-only requests, answered only by render processes started with RENDER_WORKER_TEST_JOBS=1
   * (else they fail): `test-allocate` allocates a buffer of `bytes` (to make an allocation fail),
   * `test-busy` keeps the process busy for `ms`.
   */
  | { type: 'test-allocate'; id: number; bytes: number }
  | { type: 'test-busy'; id: number; ms: number };

/** Settings of an APNG encoder job (see `apng-add`). */
export interface APNGInit {
  width: number;
  height: number;
  fps: number;
  loop?: number;
}

/** RGBA8 pixels of one frame (top row first). */
export interface RawFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** How `encode` writes the frames of an animation. */
export interface EncodeOptions {
  format: 'GIF' | 'CONTACT_SHEET';
  fps: number;
  loop?: number;
  dither?: 'FLOYD_STEINBERG' | 'BAYER' | 'NONE';
  colors?: number;
  /** CONTACT_SHEET: tiles per row and per-tile labels. */
  columns?: number;
  labels?: string[];
}

/** An encoded animation file; contact sheets also report the sheet size. */
export interface EncodedResult {
  data: Uint8Array;
  sheet?: { width: number; height: number };
}

export type WorkerResult =
  | PreparedInfo
  | PathTile
  | ImageResult
  | AutoViewResult
  | EncodedResult
  | SimulatedFrames
  | ExportedFile
  | DeskShotInfo
  | ProcessMemory
  | { ok: true };

/**
 * Why a render process could not do a request: `missing-doc` (the request left the document's
 * state out, see {@link DocRef}, and the process does not have that version), `out-of-memory` (an
 * allocation failed: the process is replaced).
 */
export type WorkerErrorKind = 'missing-doc' | 'out-of-memory';

export type WorkerResponse =
  | { type: 'result'; id: number; result: WorkerResult }
  | { type: 'error'; id: number; message: string; kind?: WorkerErrorKind }
  /** Sent once by a render process that warmed up and takes requests. */
  | { type: 'ready'; pid: number; heapLimitMb: number };

/**
 * How every out-of-memory error starts, whatever ended the render process (its heap, an allocation,
 * the system's out-of-memory killer) or refused the render (single-thread mode): agents match it
 * (the tools put "Rendering failed: " and the like in front, see mcp/rendering.ts).
 */
export const OUT_OF_MEMORY_PREFIX = 'out of memory: ';
/**
 * How the error of a render that was not the cause starts: another render that shared its render
 * process ran the process out of memory or crashed it (it can run again, see pool.ts
 * sharedProcessError).
 */
export const INTERRUPTED_PREFIX = 'interrupted: ';

/**
 * A render that needed more memory than its render process has: the process ran out of
 * JavaScript heap (V8 aborted it, or an allocation failed), or it was killed with SIGKILL, which
 * on Linux is what the kernel's out-of-memory killer does. The server itself keeps running and a
 * new render process serves later renders. In single-thread mode (render on the main thread), a
 * render that would not fit into the server's heap is refused with this error before it starts.
 * Reason `shared`: the process ran out of memory while it worked on another render that shared it
 * (two long renders share the render processes); this render was not the cause and can run again.
 */
export class RenderOutOfMemoryError extends Error {
  constructor(
    message: string,
    /** The JavaScript heap limit of the process that ran out of memory (MB), when known. */
    readonly heapLimitMb?: number,
    /**
     * How it ended: out of heap, killed (SIGKILL), refused before it started (single-thread mode),
     * or ended by another render that shared the process (`shared`).
     */
    readonly reason: 'heap' | 'killed' | 'refused' | 'shared' = 'heap',
  ) {
    super(message);
    this.name = 'RenderOutOfMemoryError';
  }
}

export function isOutOfMemory(err: unknown): err is RenderOutOfMemoryError {
  return err instanceof RenderOutOfMemoryError;
}

/**
 * The error a render reports when several of its requests failed: the first one that is not a
 * `shared` one (its own request ran a process out of memory, or another failure), else the first.
 */
export function primaryRenderError(errors: readonly unknown[]): Error | undefined {
  const all = errors.map((e) => (e instanceof Error ? e : new Error(String(e))));
  return all.find((e) => !(e instanceof RenderOutOfMemoryError && e.reason === 'shared')) ?? all[0];
}
