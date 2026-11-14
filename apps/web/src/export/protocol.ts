import type {
  CameraTrackEntry,
  DeskFrameOptions,
  DeskShotInfo,
  DeskShotOptions,
  ExportPlan,
  ExportRenderEstimate,
  FrameMeta,
  FrameOptions,
  ManifestFile,
  PaletteEntry,
  PassName,
  RawPixelFormat,
  SimulatedFrames,
  SubjectTrackEntry,
  VideoExportParams,
} from '@3d-editor/core';

/*
 * Messages between the browser export (the page: engine.ts) and its render workers
 * (export.worker.ts), over postMessage. Each worker holds the export's snapshot (applied once) and
 * renders frames with core's export code, so its pixels are the server's; the first worker also
 * plans the export, measures each shot, simulates the rigid bodies once for every worker and builds
 * the contact sheet and the manifest. Buffers travel as transferables (never copied).
 */

/** What the page needs to plan the export (answer to `plan`, from the first worker). */
export interface PlanReply {
  plan: ExportPlan;
  palette: PaletteEntry[];
  poseActors: string[];
  lines: NonNullable<DeskFrameOptions['lines']>;
  /** The plan's warnings, and the pose pass's when the scene has no actors. */
  warnings: string[];
  /** Whether evaluating the snapshot runs the rigid body simulation (it is then simulated once per segment). */
  simulates: boolean;
  /** Rigid bodies of the snapshot (the shared simulation's matrices per frame). */
  bodies: number;
  /** What one render worker holds rendering this export (core exportRenderEstimate). */
  estimate: ExportRenderEstimate;
  /** The JavaScript heap of a page holding the snapshot's project (render/memory.ts pageHeapEstimate). */
  pageHeap: number;
  /** The snapshot's project name. */
  name: string;
}

/** How a worker converts the frames of the export (sent once to every worker: `job`). */
export interface WorkerJob {
  width: number;
  height: number;
  /** The mask palette's colours by index (256 × RGB; 0 black). */
  lut: Uint8Array;
  /** The passes of the video streams, in stream order, with their raw formats: each comes back as I420. */
  streams: { pass: PassName; format: RawPixelFormat }[];
  /** The passes kept exactly (mask, edges): each comes back as a PNG frame. */
  lossless: ('mask' | 'edges')[];
  /** The pass posters and contact sheet tiles show (beauty when exported, else the first pass). */
  primary: { pass: PassName; format: RawPixelFormat };
  /** JPEG quality of the posters (0–1). */
  jpegQuality: number;
}

/** What a frame gives besides its video frames: posters, a still, a tile. */
export interface FrameWork {
  /** The posters of the shot (its first frame): the primary pass as an RGB PNG and a JPEG. */
  poster: boolean;
  /** The still (the beauty image as an RGB PNG): `desk.passes` must have beauty. */
  still: boolean;
  /** A contact sheet tile of this size (RGBA, box-downscaled primary pass). */
  tile: { width: number; height: number } | null;
  /** SHA-256 of each raw pass the frame rendered (debugging: parity with the server's frames). */
  digests?: boolean;
}

/** A rendered and converted frame (answer to `frame`). */
export interface FrameReply {
  /** I420 frames of the job's streams, in stream order (transferred). */
  video: ArrayBuffer[];
  /** PNG frames of the job's lossless passes, in their order (transferred). */
  lossless: Uint8Array[];
  poster: { png: Uint8Array; jpeg: Uint8Array } | null;
  still: Uint8Array | null;
  tile: Uint8ClampedArray | null;
  meta: FrameMeta | null;
  warnings: string[];
  /** SHA-256 (hex) of the raw passes ('beauty' the RGBA image, 'mask' the palette indices …). */
  digests?: Record<string, string>;
  /** Milliseconds the render took. */
  ms: number;
}

/** A shot's tracks as they travel to the worker that builds the manifest. */
export interface TracksData {
  camera: CameraTrackEntry[];
  subjects: [string, SubjectTrackEntry[]][];
}

/** What the manifest is built from, besides the snapshot the first worker holds. */
export interface ManifestRequest {
  project: { id: string; name: string };
  createdAt: string;
  plan: ExportPlan;
  codec: 'h264' | 'vp9';
  look: string;
  quality: string;
  passes: PassName[];
  files: ManifestFile[];
  palette: PaletteEntry[];
  tracks: TracksData[];
  warnings: string[];
}

export type ExportWorkerRequest =
  /** Applies the export's snapshot (a Yjs state update); answers `{ok: true}`. */
  | { type: 'init'; id: number; update: Uint8Array }
  /** Plans the export; `stills` adds the beauty image to the memory estimate (the stills need it). */
  | { type: 'plan'; id: number; params: VideoExportParams; stills: boolean }
  | { type: 'job'; id: number; job: WorkerJob }
  | { type: 'shot'; id: number; options: DeskShotOptions }
  | { type: 'simulate'; id: number; frames: number[] }
  | { type: 'frame'; id: number; options: FrameOptions & { desk: DeskFrameOptions }; work: FrameWork }
  | {
      type: 'contact-sheet';
      id: number;
      tiles: { width: number; height: number; data: Uint8ClampedArray }[];
      labels: string[];
      columns: number;
    }
  | { type: 'manifest'; id: number; request: ManifestRequest }
  /** Drops the renderer's pooled buffers (the export's frames are done). */
  | { type: 'release'; id: number };

export type ExportWorkerResult =
  | { ok: true }
  | PlanReply
  | DeskShotInfo
  | SimulatedFrames
  | FrameReply
  | Uint8Array
  | Record<string, unknown>;

export type ExportWorkerResponse =
  | { id: number; ok: true; result: ExportWorkerResult }
  | { id: number; ok: false; error: { message: string; name: string; code?: string } };

/** The buffers of a frame reply to transfer. */
export function frameTransferables(r: FrameReply): Transferable[] {
  const out: Transferable[] = [...r.video];
  for (const p of r.lossless) out.push(p.buffer);
  if (r.poster) out.push(r.poster.png.buffer, r.poster.jpeg.buffer);
  if (r.still) out.push(r.still.buffer);
  if (r.tile) out.push(r.tile.buffer);
  return [...new Set(out)];
}
