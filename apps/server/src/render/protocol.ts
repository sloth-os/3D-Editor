import type { ExportFormat, PathTile, RenderEngine, ViewTransform } from '@3d-editor/core';

/*
 * Messages between the render pool (the server's main thread) and its render processes, over the
 * IPC channel of `child_process.fork` with advanced serialization (the structured clone algorithm:
 * typed arrays are copied, nothing is shared or transferred). The single-thread mode runs the same
 * requests on the main thread.
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
 * Rigid body world matrices of one frame, simulated once for every render thread (see
 * `Renderer.physics`): threads use them instead of running the simulation themselves.
 */
export interface PhysicsFrame {
  frame: number;
  /** Simulated objects (empty: nothing is simulated at this frame, e.g. before the world's start). */
  ids: string[];
  /** ids.length × 16 numbers: the world matrices (column-major), in the order of `ids`. */
  matrices: Float64Array;
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
  /** The rigid body simulation at `frame`, computed once (threads simulate themselves without it). */
  physics?: PhysicsFrame;
  /**
   * Director desk frame options of video exports (SPEC §9): look, shadows, AO, MSAA, the extra
   * passes (`ImageResult.passes`) and the frame's metadata (`ImageResult.meta`). RASTER only.
   */
  desk?: DeskFrameOptions;
}

/** The images a video export renders per frame (`beauty` is the image itself). */
export type PassName = 'beauty' | 'depth' | 'normal' | 'mask' | 'edges' | 'pose';

/** Director desk frame options (SPEC §9 protocol). */
export interface DeskFrameOptions {
  look: 'material' | 'clay' | 'solid';
  shadows: boolean;
  ao: boolean;
  msaa: boolean;
  /** World box the sun's shadow map covers (default: fitted to the view). */
  shadowFit?: { min: Vec3Tuple; max: Vec3Tuple };
  /**
   * How far ambient occlusion reaches (m), the same for every frame of a shot
   * (`DeskShotInfo.aoRadius`). Default: the renderer's own, from what each frame draws, which
   * changes when things appear, hide or scale anywhere in the scene.
   */
  aoRadius?: number;
  passes: PassName[];
  /**
   * Depth pass distances (m): `[near, far]`; inverse depth between them maps to 255…0 (see
   * passes.ts depthToBytes). Default: the camera's clipping range.
   */
  depthRange?: [number, number];
  /**
   * The job's mask palette: a colour (0–255 RGB) per object group, in palette order. The mask pass
   * byte of a group is its 1-based position in the record's key order (at most 255 entries; 0 =
   * nothing drawn). A drawn object belongs to the group of its nearest ancestor-or-self in the
   * record, or to its actor's (desk_actor); an object of no group is 0.
   */
  objectPalette?: Record<string, [number, number, number]>;
  /** Object ids whose screen boxes `ImageResult.meta.subjects` reports. */
  subjects?: string[];
  /** Actor (armature object) ids whose skeletons the pose pass draws. */
  poseActors?: string[];
  /**
   * Objects drawn as screen-space lines along their geometry (tether strings): at least 2 px wide,
   * colour in display sRGB 0–1, into the beauty image and the mask, edges and pose passes.
   */
  lines?: { object: string; width_px: number; color: [number, number, number] }[];
}

/** What a render process measures for one shot of a video export (request `desk-shot`). */
export interface DeskShotOptions {
  /** Scene frames of the shot to sample. */
  frames: number[];
  /** The shot's camera (object id or name). */
  cameraId: string;
  /** Output width / height. */
  aspect: number;
}

/** The per-shot settings of a video export (answer to `desk-shot`). */
export interface DeskShotInfo {
  /**
   * Depth pass range (m): the nearest and farthest distances from the camera to the scene's
   * rendered bounds over the sampled frames, inside the camera's clipping range.
   */
  depthRange: [number, number];
  /**
   * The world box the sun's shadow map covers for the whole shot (stable shadows): the rendered
   * bounds of the sampled frames without huge objects (grounds, sky domes), null when there is
   * nothing else.
   */
  shadowFit: { min: Vec3Tuple; max: Vec3Tuple } | null;
  /**
   * How far ambient occlusion reaches for the whole shot (m): core `defaultAoRadius` of what its
   * first frame draws, so the occlusion cannot change within the shot when things appear, hide or
   * scale (`DeskFrameOptions.aoRadius`).
   */
  aoRadius?: number;
  /** Milliseconds spent. */
  ms: number;
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

/** Camera and subject boxes of a rendered frame (computed in the render process). */
export interface FrameMeta {
  /** The camera's world matrix (column-major) and vertical field of view in radians. */
  camera: { matrix: number[]; fovY: number };
  /**
   * Screen boxes of `DeskFrameOptions.subjects` in pixels (null: not in the frame). A subject a hide
   * key put away at the frame (render/desk.ts hiddenItem: the geometry it draws collapsed to under a
   * micrometre, a string by its world matrix) has an empty box with `hidden: true` (never a
   * collapsed point).
   */
  subjects: Record<
    string,
    { x: number; y: number; w: number; h: number; visible: boolean; hidden?: true } | null
  >;
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

/** A rendered image: RGBA8 pixels (top row first) and/or the PNG file (when requested). */
export interface ImageResult {
  width: number;
  height: number;
  data?: Uint8ClampedArray;
  png?: Uint8Array;
  /** Path tracing statistics (absent for raster renders). */
  pathtrace?: { samples: number; requested: number; stopped: 'done' | 'time' | 'cancelled' };
  warnings?: string[];
  /**
   * The extra passes of `FrameOptions.desk.passes` (1 byte per pixel for depth, mask (palette
   * index) and edges; RGB for normal and pose; beauty stays `data`).
   */
  passes?: Partial<Record<PassName, Uint8Array>>;
  /** Camera and subject boxes (`FrameOptions.desk`). */
  meta?: FrameMeta;
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

/** Answer to `simulate`: the matrices of every requested frame. */
export interface SimulatedFrames {
  frames: PhysicsFrame[];
  /** Milliseconds spent simulating. */
  ms: number;
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
