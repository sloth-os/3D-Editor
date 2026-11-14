import type { RenderEngine } from '../doc/types';

/*
 * What a render thread is asked for and answers when it renders the frames of a video export: the
 * server's render processes (apps/server/src/render, over the IPC channel of child_process.fork)
 * and the browser export's render workers (apps/web/src/export, over postMessage) take the same
 * frame options and return the same results, rendered by the same code (desk-frame.ts), so both
 * make the same pixels.
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
 * Rigid body world matrices of one frame, simulated once for every render thread (see
 * `simulateRigidBodies`): threads use them instead of running the simulation themselves.
 */
export interface PhysicsFrame {
  frame: number;
  /** Simulated objects (empty: nothing is simulated at this frame, e.g. before the world's start). */
  ids: string[];
  /** ids.length × 16 numbers: the world matrices (column-major), in the order of `ids`. */
  matrices: Float64Array;
}

/** Answer to a simulation request: the matrices of every requested frame. */
export interface SimulatedFrames {
  frames: PhysicsFrame[];
  /** Milliseconds spent simulating. */
  ms: number;
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
   * core depthToBytes). Default: the camera's clipping range.
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

/** What a render thread measures for one shot of a video export (`measureDeskShot`). */
export interface DeskShotOptions {
  /** Scene frames of the shot to sample. */
  frames: number[];
  /** The shot's camera (object id or name). */
  cameraId: string;
  /** Output width / height. */
  aspect: number;
}

/** The per-shot settings of a video export (answer to a shot measurement). */
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

/** Camera and subject boxes of a rendered frame (computed by the render thread). */
export interface FrameMeta {
  /** The camera's world matrix (column-major) and vertical field of view in radians. */
  camera: { matrix: number[]; fovY: number };
  /**
   * Screen boxes of `DeskFrameOptions.subjects` in pixels (null: not in the frame). A subject a hide
   * key put away at the frame (desk-frame.ts hiddenItem: the geometry it draws collapsed to under a
   * micrometre, a string by its world matrix) has an empty box with `hidden: true` (never a
   * collapsed point).
   */
  subjects: Record<
    string,
    { x: number; y: number; w: number; h: number; visible: boolean; hidden?: true } | null
  >;
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

/** Error raised when a render is cancelled (client abort, shutdown, an export cancelled). */
export class RenderCancelledError extends Error {
  constructor(message = 'render cancelled') {
    super(message);
    this.name = 'RenderCancelledError';
  }
}

export function isCancelled(err: unknown): err is RenderCancelledError {
  return err instanceof RenderCancelledError;
}
