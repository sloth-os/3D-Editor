import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { effect, untracked } from '@preact/signals';
import {
  SceneEvaluator,
  cameraFovY,
  meshBounds,
  orthoHalfExtents,
  transformPoint3,
  type EvaluatedScene,
  type MeshData,
  type RenderEngine,
  type Vec3,
} from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import {
  INSTANCE_BYTES,
  RASTER_BYTES_PER_TRIANGLE,
  RasterEvaluationGuard,
  applyLensShift,
  estimateRender,
  finalRenderScene,
  guardedEvaluation,
  pageHeapEstimate,
  pathTraceDocument,
  pixelsToDataUrl,
  rasterNeeds,
  rasterRefusal,
  rasterRefusalWithModifier,
  refusedModifier,
  renderOutputSize,
  renderViewFromCamera,
  sceneCameraView,
  tabMemoryWithRenders,
  viewportCamera,
  type PathTraceJob,
  type PathTraceOptions,
  type PixelImage,
} from '../render';
import { SceneObjects, drawContext, type SyncOptions } from './scene-objects';
import { ViewportSky } from './sky';
import { ViewTransformPass } from './view-transform';
import { STUDIO_RIG, STUDIO_RIG_AMBIENT, WorldEnvironment, aimStudioRig, needsStudioRig } from './world-env';
import { EditOverlay } from './edit-overlay';
import { MAX_TRANSMISSION_LEVELS, TransmissionLayers } from './transmission';
import { createGrid, updateGrid } from './grid';
import {
  DEFAULT_POSE,
  applyPoseToCamera,
  clonePose,
  lerpPose,
  poseToPresence,
  presenceToPose,
  samePose,
  viewLabel,
  type ViewPose,
} from './navigation';
import {
  SLOW_FRAME_MS,
  recordFrame,
  resetFrameClock,
  slowFrameCompiled,
  slowFrameMs,
} from '../telemetry/perf';
import { telemetry } from '../telemetry/telemetry';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const VIEWPORT_BG = new THREE.Color(0x393939);

/** Default sampling budget (seconds) of path traced `renderImage` calls (RPC renders time out at 15 s). */
export const RPC_PATH_TRACE_SECONDS = 10;

/** The evaluator of final renders is dropped after this long without renders (its caches can be big). */
const FINAL_EVALUATOR_IDLE_MS = 60_000;

/**
 * Above this many triangles drawn per frame (meshes and instances), transmissive objects seen through
 * other transmissive objects are not drawn in layers of their own (transmission.ts): each layer
 * renders the whole scene once more.
 */
export const TRANSMISSION_LAYER_TRIANGLES = 1_000_000;

/** How long an animated view change takes ({@link ViewportEngine.setPose}). */
export const VIEW_ANIMATION_MS = 220;

/** Multisampling of the viewport's scene target (smooth edges). */
export const VIEWPORT_MSAA_SAMPLES = 4;
/**
 * Samples of a multisampled final render (F12, Render Animation, MCP renders; see
 * {@link ViewportEngine.finalSampling}). three.js gives the GPU's maximum when it has fewer: 4 in
 * software WebGL, the viewport's count.
 */
export const FINAL_RENDER_SAMPLES = 8;
/**
 * Where the pictures of a supersampled final render are moved, in pixels (x right, y up; see
 * {@link ViewportEngine.finalSampling}): not at all for the first one, the picture SMAA smooths
 * when the others do not fit {@link FINAL_SUPERSAMPLE_MS}; then by the offsets of Direct3D's
 * standard 4× multisample pattern (a rotated grid). Averaged, they sample every pixel at 5 points,
 * no two in the same row or column.
 */
export const FINAL_SUPERSAMPLE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-2 / 16, -6 / 16],
  [6 / 16, -2 / 16],
  [-6 / 16, 2 / 16],
  [2 / 16, 6 / 16],
];
/**
 * A final render drawn without samples is supersampled when the GPU drew its first picture in at
 * most this long (ms; see {@link ViewportEngine.finalSampling}): the four more pictures are then
 * projected to take at most 4 s, and the render stays well within the 15 s that render_image's
 * renderer 'auto' waits for the browser. In software WebGL (SwiftShader) at 1280×720, the first
 * picture of a light scene (the startup scene with 18 rods and a 1 M triangle grid out of view)
 * took 0.4–0.7 s; that of examples/domino-cascade's camera view, which procedural wood fills,
 * 8.0–10.4 s (3.2 s at 800×450).
 */
export const FINAL_SUPERSAMPLE_MS = 1000;
/**
 * A viewport frame whose multisampled renders (shadow maps, the scene and its overlays, drawn into
 * the scene target) the GPU is seen still drawing this long after it could start them turns the
 * scene target's multisampling off ({@link ViewportEngine.multisampling}): software WebGL
 * (SwiftShader, no GPU) rasterizes every sample, so 4× MSAA makes a heavy scene's frames several
 * times slower (lighthouse-cove's 2.6 M triangles in Solid shading: 3.2 s → 0.8 s per frame;
 * 720,000 triangles over a 1100×700 view: 0.5 s → 0.2 s). A GPU draws such frames in milliseconds.
 * Only those renders count, and only while the GPU was seen drawing them: a light scene's frames,
 * slow for their full-screen passes (selection outlines, view transform: the default cube's frames
 * took 0.4 s in SwiftShader with multisampling or without), for a busy machine (0.5–1.1 s) or for a
 * main thread busy with something else (a rigid body bake: the frame drawn before it is seen done
 * after it), keep it, and screenshots taken a moment apart compare edge for edge. Frames slow from
 * building shaders do not count either (see {@link FrameInFlight.settled}): turning multisampling
 * off makes SwiftShader build every material's pipelines again, for the new sample count.
 */
export const MSAA_OFF_FRAME_MS = 1000;
/**
 * Multisampling comes back once a frame's multisampled renders without it are seen done in less
 * than this (MSAA can cost several times more).
 */
export const MSAA_ON_FRAME_MS = MSAA_OFF_FRAME_MS / 8;
/**
 * A scene that comes to draw more triangles than this (meshes and instances) turns multisampling
 * off before its first frame: in software WebGL that frame (shader compiles included) would take
 * minutes with it. Frames fast enough ({@link MSAA_ON_FRAME_MS}, a GPU) bring it back.
 */
export const MSAA_HEAVY_TRIANGLES = 1_000_000;
/** A frame the GPU has not finished after this long is given up on (it no longer holds frames back). */
const FENCE_TIMEOUT_MS = 10 * 60_000;
/**
 * A frame's fences read as unsignalled count as "the GPU is still drawing it" only when the frame
 * loop also read fences less than this before. WebGL changes a fence's state only between tasks,
 * and Chrome reads it again from the GPU process a task later: the first read after the main
 * thread was held up (a picture, a rigid body bake) can say "drawing" for a frame done long before.
 * A frame of examples/domino-cascade in software WebGL (its frames took 0.3–0.7 s), drawn before a
 * 1.5 s picture, was read as drawing 1.7 s after it began, then as done 2 ms later. A loop whose
 * frames take up to 0.2 s of main-thread work (a scene evaluated for every frame of playback) still
 * reads them often enough.
 */
export const FRESH_POLL_MS = 250;
/**
 * Frames the GPU may be drawing at once while frames are slow ({@link SLOW_QUEUE_FRAME_MS}): a change
 * still starts its frame at once, behind the one being drawn, so a screenshot taken after it shows
 * it; further frames wait instead of queueing up behind them (software WebGL can take minutes for
 * a heavy scene's frame), and the frame drawn next shows the view as it is by then.
 */
export const MAX_FRAMES_IN_FLIGHT = 2;
/**
 * Frames the GPU may be drawing at once while frames take less than {@link SLOW_QUEUE_FRAME_MS}:
 * every change starts its frame at once (software WebGL takes a few hundred milliseconds for a
 * light scene's frame, while an agent or a test changes the scene and takes a screenshot in less).
 */
export const MAX_FAST_FRAMES_IN_FLIGHT = 6;
/** Frames that took this long (or one drawn for this long so far) limit the queue to {@link MAX_FRAMES_IN_FLIGHT}. */
export const SLOW_QUEUE_FRAME_MS = 1000;

/** A frame the GPU has not finished yet (WebGL2 fence) and what is known of it. */
interface FrameInFlight {
  fence: WebGLSync;
  /** When the frame started (before its scene sync) and when its renders started. */
  start: number;
  renderStart: number;
  /**
   * Whether its scene sync or renders compiled shader programs (the first frame of a shading, new
   * materials; see {@link ViewportEngine.compiledPrograms}).
   */
  compiled: boolean;
  /**
   * Whether its time says what frames cost ({@link ViewportEngine.adaptMultisampling}): not when it
   * compiled shader programs (a material edit that needs another shader) or is the first frame
   * after something that has the GPU build pipelines also for compiled programs (seconds for a
   * scene's materials in software WebGL): a change of shading or X-ray, a picture
   * ({@link ViewportEngine.renderPixels}) or a change of multisampling; nor when a picture held the
   * main thread up while the GPU drew it.
   */
  settled: boolean;
  /** The changes it shows ({@link ViewportEngine.changes} when it started). */
  changes: number;
  /** The samples per pixel of the scene target it was drawn into (0: multisampling off). */
  samples: number;
  /** Signalled once its multisampled renders are done ({@link SceneEndPass}; null once seen so). */
  scene: WebGLSync | null;
  /** When the GPU was last seen still drawing them, and when they were first seen done (0: not). */
  sceneBusyAt: number;
  sceneDoneAt: number;
}

/**
 * Marks the end of a frame's multisampled renders in the GPU's work, with a WebGL2 fence the frame
 * loop asks for ({@link armed}) and collects ({@link take}): shadow maps, the scene and its overlays
 * are drawn before it; the full-screen passes after it (selection outlines, view transform) cost
 * about the same with multisampling or without.
 */
class SceneEndPass extends Pass {
  /** Whether the next render puts a fence (a frame of the loop, not a thumbnail). */
  armed = false;
  private fence: WebGLSync | null = null;

  constructor() {
    super();
    this.needsSwap = false;
  }

  override render(renderer: THREE.WebGLRenderer): void {
    if (!this.armed) return;
    this.armed = false;
    const gl = renderer.getContext?.();
    if (!gl || !('fenceSync' in gl)) return;
    const gl2 = gl as WebGL2RenderingContext;
    // one a frame that threw after this pass never collected
    if (this.fence) gl2.deleteSync(this.fence);
    this.fence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  /** The fence the last render put, if any (the caller deletes it). */
  take(): WebGLSync | null {
    const f = this.fence;
    this.fence = null;
    this.armed = false;
    return f;
  }
}

/**
 * Divides colour by alpha (straight alpha) for transparent-film renders: a render over a clear
 * alpha of 0 holds coverage-weighted colours at edges and in blended surfaces.
 */
const UNPREMULTIPLY_SHADER = {
  name: 'UnpremultiplyShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
    }`,
};

/**
 * SMAA on a transparent film (see renderPixels), around three.js's SMAA pass: premultiplies the
 * shown (sRGB-encoded) colours by alpha, and divides them by it again after SMAA. SMAA's blend
 * (SMAABlendShader) mixes neighbouring colours raised to the power 2.2, about linear light, and
 * alpha as it is: the colours are premultiplied in that space (rgb · a^(1/2.2) = (rgb^2.2 · a)^(1/2.2)),
 * so they are blended with the same weights as alpha, and an edge pixel between an object and the
 * transparent background keeps the object's colour at the blended alpha (premultiplied by alpha
 * itself, it came out a^(1/2.2 - 1) times too bright: 1.65 times at 40 % coverage).
 */
const SMAA_PREMULTIPLY_SHADER = {
  name: 'SmaaPremultiplyShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: UNPREMULTIPLY_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    vec4 premultiplied( vec4 c ) {
      return vec4( c.rgb * pow( c.a, 1.0 / 2.2 ), c.a );
    }
    void main() {
      gl_FragColor = premultiplied( texture2D( tDiffuse, vUv ) );
    }`,
};
/** Divides SMAA's output by alpha again (see {@link SMAA_PREMULTIPLY_SHADER}). */
const SMAA_UNPREMULTIPLY_SHADER = {
  name: 'SmaaUnpremultiplyShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: UNPREMULTIPLY_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    vec4 straight( vec4 c ) {
      return c.a > 0.0 ? vec4( c.rgb / pow( c.a, 1.0 / 2.2 ), c.a ) : vec4( 0.0 );
    }
    void main() {
      gl_FragColor = straight( texture2D( tDiffuse, vUv ) );
    }`,
};

/**
 * Averages the pictures of a supersampled final render ({@link FINAL_SUPERSAMPLE_OFFSETS}): mixes
 * picture `tSample` into the average of those before it (`tDiffuse`) with `weight` 1 / n for the
 * n-th, colour (linear, premultiplied on a transparent film) and alpha alike, like the resolve of a
 * multisampled picture.
 */
const AVERAGE_SHADER = {
  name: 'AverageShader',
  uniforms: { tDiffuse: { value: null }, tSample: { value: null }, weight: { value: 1 } },
  vertexShader: UNPREMULTIPLY_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tSample;
    uniform float weight;
    varying vec2 vUv;
    vec4 averaged( vec4 before, vec4 picture ) {
      return mix( before, picture, weight );
    }
    void main() {
      gl_FragColor = averaged( texture2D( tDiffuse, vUv ), texture2D( tSample, vUv ) );
    }`,
};

/**
 * Moves the picture of `cam` by `x`, `y` pixels of a `width` × `height` image (sub-pixel offsets
 * of a supersampled render): its projection becomes `base` followed by that translation in clip
 * space, which keeps a lens shift (render/view.ts applyLensShift edits the projection the same way;
 * setViewOffset would compute the projection anew without it).
 */
function moveProjection(
  cam: THREE.Camera,
  base: THREE.Matrix4,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const e = cam.projectionMatrix.copy(base).elements;
  const dx = (2 * x) / width;
  const dy = (2 * y) / height;
  for (let c = 0; c < 4; c++) {
    e[c * 4] += dx * e[c * 4 + 3];
    e[c * 4 + 1] += dy * e[c * 4 + 3];
  }
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

/** Options of {@link ViewportEngine.renderImage} and the other render entry points. */
export interface RenderImageOptions {
  width?: number;
  height?: number;
  cameraId?: string;
  /**
   * Show what the viewport shows (a capture): its own view, orthographic or perspective like the
   * viewport, or the scene camera while the viewport looks through it.
   */
  useViewport?: boolean;
  /** Explicit viewpoint (world space, Z up); fov in degrees. */
  view?: { position: number[]; target: number[]; up?: number[]; fov_degrees?: number } | null;
  /**
   * A frame of Render Animation: multisampled ({@link FINAL_RENDER_SAMPLES}) whatever samples the
   * viewport drew its shading with (see {@link ViewportEngine.finalSampling}).
   */
  animation?: boolean;
  /**
   * Viewport shading for the image: by default the viewport's current shading for a capture
   * (`useViewport`), RENDERED for a final render.
   */
  shading?: 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED' | null;
  /** Evaluate the scene at this frame. */
  frame?: number | null;
  /** Render engine (default: the render settings; viewport captures rasterize). */
  engine?: RenderEngine | null;
  /** PATHTRACER: samples per pixel (default: render settings). */
  samples?: number;
  /** PATHTRACER: maximum bounces (default: render settings). */
  max_bounces?: number;
  /** PATHTRACER: denoise (default: render settings). */
  denoise?: boolean;
  /** PATHTRACER: sampling budget in seconds (0 = none). */
  time_limit?: number;
  /** PATHTRACER: noise seed (default 0). */
  seed?: number;
}

/**
 * A JPEG of `width` × `height` RGBA pixels read back from WebGL (bottom row first), scaled down to
 * `maxW` pixels wide, each pixel the mean of up to 3 × 3 pixels of the area it covers; null without
 * a 2D canvas. The project's thumbnail of a canvas read back without waiting for the GPU
 * (ViewportEngine.readThumbnail).
 */
export function thumbnailJpeg(pixels: Uint8Array, width: number, height: number, maxW = 320): string | null {
  const w = Math.max(1, Math.min(width, Math.round(maxW)));
  const h = Math.max(1, Math.round((height * w) / width));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  const sx = width / w;
  const sy = height / h;
  const tx = Math.min(3, Math.ceil(sx));
  const ty = Math.min(3, Math.ceil(sy));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ty; j++) {
        // the image's top row is the last one WebGL reads
        const row = height - 1 - Math.min(height - 1, Math.floor((y + (j + 0.5) / ty) * sy));
        for (let i = 0; i < tx; i++) {
          const k = (row * width + Math.min(width - 1, Math.floor((x + (i + 0.5) / tx) * sx))) * 4;
          r += pixels[k];
          g += pixels[k + 1];
          b += pixels[k + 2];
        }
      }
      const n = tx * ty;
      const o = (y * w + x) * 4;
      img.data[o] = r / n;
      img.data[o + 1] = g / n;
      img.data[o + 2] = b / n;
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.7);
}

function cursorTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      g.strokeStyle = i % 2 ? '#ffffff' : '#e8322e';
      g.beginPath();
      g.arc(32, 32, 20, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(32, 2);
    g.lineTo(32, 20);
    g.moveTo(32, 44);
    g.lineTo(32, 62);
    g.moveTo(2, 32);
    g.lineTo(20, 32);
    g.moveTo(44, 32);
    g.lineTo(62, 32);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** WebGL viewport: owns the three.js renderer and mirrors the evaluated scene. */
export class ViewportEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly overlay = new THREE.Scene();
  readonly perspCam = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  readonly sceneCam = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  readonly objects: SceneObjects;
  readonly edit = new EditOverlay();
  /**
   * The view: what the viewport shows, or, while an animated view change runs ({@link setPose}),
   * the view it is going to. Navigation changes it (in place or with setPose); get_view, renders of
   * the viewport's view and Align Camera to View read it. The frames drawn meanwhile show
   * {@link shownPose}.
   */
  pose: ViewPose = DEFAULT_POSE();
  width = 1;
  height = 1;
  ev: EvaluatedScene | null = null;
  /** Live mesh overrides (interactive edit-mode transforms). */
  readonly meshOverrides = new Map<string, MeshData>();
  /** Live world-matrix overrides (interactive object transforms). */
  readonly matrixOverrides = new Map<string, number[]>();
  readonly onAfterRender = new Set<() => void>();
  private composer: EffectComposer;
  private outlineSel: OutlinePass;
  private outlineActive: OutlinePass;
  private overlayPass: RenderPass;
  private renderPass: RenderPass;
  /** Where a frame's multisampled renders end (see {@link adaptMultisampling}). */
  private sceneEnd = new SceneEndPass();
  /** Exposure, view transform and sRGB encoding of the viewport (see view-transform.ts). */
  private outputPass = new ViewTransformPass();
  /** The view transform and exposure (stops) the last `applyShading` chose. */
  private colorManagement: { view: string; exposure: number } = { view: 'STANDARD', exposure: 0 };
  /** Pictures of transmissive objects seen through other ones (transmission.ts). */
  private transmission = new TransmissionLayers();
  private grid = createGrid();
  private cursor: THREE.Sprite;
  private originDots: THREE.Points;
  private peerBoxes = new THREE.Group();
  private ambient = new THREE.AmbientLight(0xffffff, 0);
  private envTexture: THREE.Texture | null = null;
  private pmrem: THREE.PMREMGenerator;
  /** The STUDIO / IMAGE world environment of Rendered shading and final renders. */
  private worldEnv: WorldEnvironment;
  /** World sky (environment SKY) and mist. */
  private sky: ViewportSky;
  private dirty = true;
  private needsSync = true;
  private raf = 0;
  /**
   * The animated view change running (Blender's smooth view): the frames drawn until `start + dur`
   * show poses on the way from `from` (what was shown when it started) to `to` (a copy of
   * {@link pose} then); see {@link framePose}.
   */
  private animating: { from: ViewPose; to: ViewPose; start: number; dur: number } | null = null;
  /** The pose of the last frame drawn (null: none drawn yet). */
  private shown: ViewPose | null = null;
  private disposers: (() => void)[] = [];
  private resizeObserver: ResizeObserver;
  private lastFrameTime = 0;
  /**
   * The frames the GPU still draws, oldest first (WebGL2 fences): a few at most
   * ({@link MAX_FRAMES_IN_FLIGHT}, {@link MAX_FAST_FRAMES_IN_FLIGHT}), so a slow GPU (software
   * WebGL drawing a heavy scene for seconds) never gets a queue of frames behind the one it draws,
   * and each frame's cost is known ({@link slowFrameMs}).
   */
  private framesInFlight: FrameInFlight[] = [];
  /** When the last frame was seen finished: a frame queued behind it started drawing then. */
  private lastFrameDone = 0;
  /** How long the last finished frame took (see {@link frameDone}). */
  private lastFrameMs = 0;
  /** When {@link frameDone} last read the frames' fences, and how many times ({@link FRESH_POLL_MS}). */
  private lastPoll = -Infinity;
  private polls = 0;
  /** The read that saw the last frame done ({@link polls}), and whether it was fresh. */
  private lastDonePoll = -1;
  private lastDoneFresh = false;
  /**
   * Whether the next frame is the first after a change that has the GPU build pipelines (see
   * {@link FrameInFlight.settled}).
   */
  private unsettled = true;
  /** The shader programs three.js held when the frame being drawn began ({@link compiledPrograms}). */
  private readonly framePrograms = new Set<unknown>();
  /** The draw context (shading, X-ray) of the last scene sync ({@link drawContext}). */
  private syncedContext = '';
  /**
   * The sample counts each draw context was drawn with, by the viewport or a capture: software
   * WebGL keeps the pipelines it built for them ({@link captureSamples}).
   */
  private drawnSamples = new Map<string, Set<number>>();
  /** Whether the last sync drew more than {@link MSAA_HEAVY_TRIANGLES} triangles. */
  private heavyScene = false;
  /**
   * Whether the viewport's scene target is multisampled: off while frames are slow (software
   * WebGL, see {@link MSAA_OFF_FRAME_MS}), on again once they are fast.
   */
  multisampling = true;
  imagesRevision = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly session: ProjectSession,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // shadow maps are drawn once per frame (render, renderPixels set needsUpdate), not again for
    // every render of the scene in it (transmission pictures, selection outlines)
    this.renderer.shadowMap.autoUpdate = false;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.sky = new ViewportSky(this.pmrem);
    this.worldEnv = new WorldEnvironment(this.pmrem);
    this.objects = new SceneObjects(this.scene, this.overlay, () => this.requestRender());
    this.scene.add(this.ambient);
    this.overlay.add(this.grid, this.edit.group, this.peerBoxes);
    this.cursor = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: cursorTexture(),
        depthTest: false,
        sizeAttenuation: false,
        transparent: true,
      }),
    );
    this.cursor.scale.set(0.045, 0.045, 1);
    this.cursor.renderOrder = 20;
    this.overlay.add(this.cursor);
    this.originDots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, color: 0xf17e2a, depthTest: false }),
    );
    this.originDots.renderOrder = 19;
    this.overlay.add(this.originDots);

    const rt = new THREE.WebGLRenderTarget(1, 1, {
      samples: VIEWPORT_MSAA_SAMPLES,
      type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.perspCam);
    this.overlayPass = new RenderPass(this.overlay, this.perspCam);
    this.overlayPass.clear = false;
    this.overlayPass.clearDepth = false;
    this.outlineSel = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.perspCam);
    this.outlineActive = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.perspCam);
    for (const [p, c] of [
      [this.outlineSel, 0xf17e2a],
      [this.outlineActive, 0xffb359],
    ] as const) {
      p.visibleEdgeColor.set(c);
      p.hiddenEdgeColor.set(c);
      p.edgeStrength = 4;
      p.edgeThickness = 1;
      p.edgeGlow = 0;
    }
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.overlayPass);
    this.composer.addPass(this.sceneEnd);
    this.composer.addPass(this.outlineSel);
    this.composer.addPass(this.outlineActive);
    this.composer.addPass(this.outputPass);

    this.restorePose();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();

    const s = session;
    const st = s.state;
    const v = s.view;
    // Any of these changes requires a re-sync of three objects.
    this.disposers.push(
      effect(() => {
        void s.revision.value;
        void st.$frame.value;
        void st.$selectedIds.value;
        void st.$activeId.value;
        void st.$mode.value;
        void st.$meshSelection.value;
        void st.$selectMode.value;
        void v.shading.value;
        void v.xray.value;
        void v.showWireframe.value;
        void v.overlays.value;
        void v.showGrid.value;
        void v.tool.value;
        void v.snapping.value;
        this.invalidate();
      }),
      // other people's selections only move their boxes: no scene sync (a full one redraws the
      // point and spot light shadow maps, seconds in software WebGL)
      effect(() => {
        void s.peers.value;
        untracked(() => this.syncPeers());
        this.requestRender();
      }),
      effect(() => {
        void st.$cursorLocation.value;
        void v.cameraView.value;
        this.requestRender();
      }),
      effect(() => {
        const follow = v.following.value;
        if (follow === null) return;
        const peer = s.peers.value.find((p) => p.clientId === follow);
        if (peer?.state.view) {
          this.pose = presenceToPose(peer.state.view);
          this.requestRender();
        } else if (!peer) v.following.value = null;
      }),
    );
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ frame loop

  invalidate(): void {
    this.needsSync = true;
    this.requestRender();
  }

  requestRender(): void {
    this.dirty = true;
    this.changes++;
    this.showViewState('pending');
  }

  /** Changes asked for so far (invalidate, requestRender), and those the last frame drawn shows. */
  private changes = 0;
  private drawnChanges = 0;
  /**
   * The document revision (ProjectSession.revision) the canvas shows once the frames in flight are
   * drawn: that of the frame the loop drew last; -1 while it shows none (no frame drawn yet, or a
   * resize cleared it).
   */
  private canvasRevision = -1;
  /** Frames the loop drew so far (the canvas shows the last one). */
  private canvasFrames = 0;
  /**
   * The project's thumbnail as last copied from the canvas ({@link thumbnail}): the revision it
   * shows, and the frame it was copied from ({@link canvasFrames}).
   */
  private thumb: { url: string; revision: number; frame: number } | null = null;
  /**
   * A thumbnail of the latest revision was asked for while the GPU drew a frame: the frame loop
   * reads the canvas back once a frame of that revision was started ({@link readThumbnail}).
   */
  private thumbWanted = false;
  /**
   * The read back of the canvas for the project's thumbnail on its way ({@link readThumbnail}): the
   * pixel buffer the GPU fills, its fence, the size of the canvas and the revision and frame it shows.
   */
  private thumbRead: {
    buffer: WebGLBuffer;
    fence: WebGLSync;
    width: number;
    height: number;
    revision: number;
    frame: number;
  } | null = null;
  /** The samples per pixel the last frame drawn was drawn with ({@link FrameInFlight.samples}). */
  private drawnFrameSamples = 0;

  /**
   * The canvas's `data-view` attribute: `drawn` once the GPU has drawn a frame that shows every
   * change asked for so far (scene, view, shading, selection …), `pending` until then. End-to-end
   * tests wait for `drawn` before they take a picture of the viewport: the browser shows the last
   * frame drawn, which software WebGL can take seconds to draw (compiling shaders). With `drawn`,
   * `data-samples` says how many samples per pixel that frame was drawn with (4, or 0 while frames
   * are slow, {@link multisampling}): pictures compare edge for edge only when they agree.
   */
  private showViewState(state: 'drawn' | 'pending'): void {
    if (state === 'drawn') {
      const samples = String(this.drawnFrameSamples);
      if (this.canvas.dataset.samples !== samples) this.canvas.dataset.samples = samples;
    }
    if (this.canvas.dataset.view !== state) this.canvas.dataset.view = state;
  }

  /** Whether no frame is in flight and nothing is left to draw: the canvas shows every change asked for. */
  private get viewDrawn(): boolean {
    return (
      !this.framesInFlight.length && !this.dirty && !this.needsSync && this.drawnChanges === this.changes
    );
  }

  /** Says `drawn` (see {@link showViewState}) when no frame is in flight and nothing is left to draw. */
  private updateViewState(): void {
    if (this.viewDrawn) this.showViewState('drawn');
  }

  private loop(now: number): void {
    this.raf = requestAnimationFrame(this.loop);
    const v = this.session.view;
    if (v.playing.value) {
      const fps = this.ev?.scene.fps ?? this.session.doc.getScene().fps;
      if (!this.lastFrameTime) this.lastFrameTime = now;
      const step = 1000 / Math.max(1, fps);
      if (now - this.lastFrameTime >= step) {
        const sc = this.session.doc.getScene();
        const frames = Math.floor((now - this.lastFrameTime) / step);
        this.lastFrameTime += frames * step;
        let f = this.session.state.frame + frames;
        if (f > sc.frame_end)
          f = sc.frame_start + ((f - sc.frame_start) % Math.max(1, sc.frame_end - sc.frame_start + 1));
        this.session.state.frame = f;
      }
    } else this.lastFrameTime = 0;
    // an animated view change draws a frame on every animation frame until it ends (framePose)
    if (this.animating) this.dirty = true;
    if (!this.frameDone()) return;
    // the project's thumbnail asked for while the GPU drew (thumbnail): read back without waiting
    // for the GPU, from the frame that shows the latest document
    this.finishThumbnail();
    if (this.thumbWanted && !this.thumbRead && this.canvasRevision === this.session.revision.peek())
      this.readThumbnail();
    if (!this.dirty && !this.needsSync) {
      resetFrameClock();
      return;
    }
    const start = performance.now();
    // (noted before the sync: the environment maps it can make compile programs too)
    this.notePrograms();
    if (this.needsSync) this.sync();
    // the frame shows the changes asked for so far, also those of its sync (it can turn
    // multisampling off, which asks for a frame: this one)
    const changes = this.changes;
    this.dirty = false;
    const renderStart = performance.now();
    const settled = !this.unsettled;
    this.unsettled = false;
    this.sceneEnd.armed = true;
    // (the scene was synced with the document as it is now: a change of it asks for a sync)
    this.canvasRevision = this.session.revision.peek();
    this.canvasFrames++;
    this.render(now);
    const samples = this.multisampling ? VIEWPORT_MSAA_SAMPLES : 0;
    this.noteDrawn(samples);
    recordFrame(now);
    const compiled = this.compiledPrograms();
    this.fenceFrame(
      start,
      renderStart,
      compiled,
      settled && !compiled,
      changes,
      samples,
      this.sceneEnd.take(),
    );
  }

  /** Notes the shader programs three.js holds now ({@link compiledPrograms}). */
  private notePrograms(): void {
    this.framePrograms.clear();
    for (const p of this.renderer.info?.programs ?? []) this.framePrograms.add(p);
  }

  /**
   * Whether three.js holds a shader program it did not hold at the last {@link notePrograms}: one
   * it compiled since. Neither the number of programs nor the last one says so. three.js appends a
   * program it compiles to its list (renderer.info.programs) and takes one it releases out by
   * moving the last one into its place (WebGLPrograms.releaseProgram): a frame that compiled one
   * and released another (an edit that gives a material another shader, its old material disposed
   * once the new one is drawn) keeps both, and a frame that only released one (an object with a
   * material of its own deleted) changes the last one.
   */
  private compiledPrograms(): boolean {
    const compiled = (this.renderer.info?.programs ?? []).some((p) => !this.framePrograms.has(p));
    // (no hold on released programs until the next frame)
    this.framePrograms.clear();
    return compiled;
  }

  /**
   * Retires the frames the GPU has finished, oldest first, and says whether another one may start:
   * fewer than {@link MAX_FRAMES_IN_FLIGHT} in flight while frames are slow
   * ({@link SLOW_QUEUE_FRAME_MS}), fewer than {@link MAX_FAST_FRAMES_IN_FLIGHT} otherwise, always
   * without WebGL2 fences. A finished frame's cost updates {@link slowFrameMs} (from the start of
   * the frame, scene sync included, or from when the frame before it finished) and the
   * multisampling ({@link adaptMultisampling}, from the start of its renders). A frame of a lost
   * context, or not done after {@link FENCE_TIMEOUT_MS}, is given up on.
   */
  private frameDone(): boolean {
    const gl = this.renderer.getContext?.();
    const gl2 = gl && 'getSyncParameter' in gl ? (gl as WebGL2RenderingContext) : null;
    const poll = ++this.polls;
    const polled = performance.now();
    // "still drawing" is believed only from a read a moment after another one (FRESH_POLL_MS)
    const fresh = polled - this.lastPoll < FRESH_POLL_MS;
    this.lastPoll = polled;
    while (this.framesInFlight.length) {
      const f = this.framesInFlight[0];
      const now = performance.now();
      if (gl2 && !gl2.isContextLost?.() && now - f.start < FENCE_TIMEOUT_MS) {
        if (f.scene) {
          if (gl2.getSyncParameter(f.scene, gl2.SYNC_STATUS) === gl2.SIGNALED) {
            gl2.deleteSync(f.scene);
            f.scene = null;
            f.sceneDoneAt = now;
          } else if (fresh) f.sceneBusyAt = now;
        }
        if (gl2.getSyncParameter(f.fence, gl2.SYNC_STATUS) !== gl2.SIGNALED) break;
        gl2.deleteSync(f.fence);
      } else if (gl2 && !gl2.isContextLost?.()) {
        // given up on after FENCE_TIMEOUT_MS
        if (f.scene) gl2.deleteSync(f.scene);
        gl2.deleteSync(f.fence);
      }
      this.framesInFlight.shift();
      this.drawnChanges = f.changes;
      this.drawnFrameSamples = f.samples;
      // a frame queued behind another one only started drawing when that one was done; when that
      // was is known if a fresh read of an earlier turn saw it (read now, or by the first read
      // after the main thread was held up, the GPU can have finished both long before)
      const queued = this.lastFrameDone > f.renderStart;
      const beginKnown = !queued || (this.lastDonePoll !== poll && this.lastDoneFresh);
      const begin = Math.max(f.renderStart, this.lastFrameDone);
      const elapsed = now - Math.max(f.start, this.lastFrameDone);
      this.lastFrameDone = now;
      this.lastDonePoll = poll;
      this.lastDoneFresh = fresh;
      this.lastFrameMs = elapsed;
      if (f.settled) this.adaptMultisampling(f, begin, beginKnown, now);
      const slow = elapsed > SLOW_FRAME_MS && document.visibilityState === 'visible' ? elapsed : 0;
      if (slowFrameMs.value !== slow) slowFrameMs.value = slow;
      const compiled = slow > 0 && f.compiled;
      if (slowFrameCompiled.value !== compiled) slowFrameCompiled.value = compiled;
    }
    this.updateViewState();
    const oldest = this.framesInFlight[0];
    if (!oldest) return true;
    const drawing = performance.now() - Math.max(oldest.start, this.lastFrameDone);
    const slow = this.lastFrameMs >= SLOW_QUEUE_FRAME_MS || drawing >= SLOW_QUEUE_FRAME_MS;
    return this.framesInFlight.length < (slow ? MAX_FRAMES_IN_FLIGHT : MAX_FAST_FRAMES_IN_FLIGHT);
  }

  /**
   * Puts a fence after the frame that started at `start` showing `changes`, rendered from
   * `renderStart` with `samples`, `compiled` shader programs or not and `settled` or not (see
   * {@link FrameInFlight}), whose multisampled renders end at the fence `scene` (WebGL2; see
   * {@link frameDone}). Without fences, the frame counts as drawn.
   */
  private fenceFrame(
    start: number,
    renderStart: number,
    compiled: boolean,
    settled: boolean,
    changes: number,
    samples: number,
    scene: WebGLSync | null,
  ): void {
    const gl = this.renderer.getContext?.();
    const gl2 = gl && 'fenceSync' in gl ? (gl as WebGL2RenderingContext) : null;
    const fence = gl2?.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!gl2 || !fence) {
      if (scene) gl2?.deleteSync(scene);
      this.drawnChanges = changes;
      this.drawnFrameSamples = samples;
      this.updateViewState();
      return;
    }
    this.framesInFlight.push({
      fence,
      start,
      renderStart,
      compiled,
      settled,
      changes,
      samples,
      scene,
      sceneBusyAt: 0,
      sceneDoneAt: 0,
    });
    gl2.flush();
  }

  /**
   * Turns the scene target's multisampling off after a settled frame ({@link FrameInFlight.settled})
   * whose multisampled renders the GPU was seen still drawing {@link MSAA_OFF_FRAME_MS} after it
   * could `begin` them, and draws the view again without it; turns it back on (and redraws) once a
   * settled frame's renders are seen done in less than {@link MSAA_ON_FRAME_MS} after a `begin`
   * that is known (`beginKnown`, see {@link frameDone}). Only what was seen counts: a main thread
   * busy with something else (a rigid body bake, a picture) sees a frame done long after the GPU
   * finished it. A frame that built shaders changes nothing: its time is the compiler's (seconds in
   * software WebGL, even for a light scene), and the frames after it show what the scene itself
   * costs.
   */
  private adaptMultisampling(f: FrameInFlight, begin: number, beginKnown: boolean, now: number): void {
    if (this.multisampling && f.sceneBusyAt - begin > MSAA_OFF_FRAME_MS) this.setMultisampling(false);
    else if (!this.multisampling && beginKnown && (f.sceneDoneAt || now) - begin < MSAA_ON_FRAME_MS)
      this.setMultisampling(true);
  }

  private setMultisampling(on: boolean): void {
    this.multisampling = on;
    // final renders of a shading it draws now go without samples too: supersampled when their first
    // picture fits FINAL_SUPERSAMPLE_MS, else smoothed with SMAA, whose pass is made now so that its
    // lookup textures load before a render needs them (finalSampling, drawFinalScene)
    if (!on) this.smaaPass();
    // the next frame builds every pipeline again, for the new sample count
    this.unsettled = true;
    const samples = on ? VIEWPORT_MSAA_SAMPLES : 0;
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples === samples) continue;
      t.samples = samples;
      // three.js allocates the target again, with the new sample count, when it is next used
      t.dispose();
    }
    this.requestRender();
  }

  // ------------------------------------------------------------------ scene sync

  sync(): void {
    this.needsSync = false;
    const s = this.session;
    const st = s.state;
    const v = s.view;
    const span = telemetry.startSpan('viewport.sync');
    const editId = st.mode === 'EDIT' ? st.activeId : null;
    this.ev = s.evaluator.evaluate(st.frame, { editObjectId: editId, meshOverrides: this.meshOverrides });
    for (const [id, m] of this.matrixOverrides) {
      const o = this.ev.byId.get(id);
      if (o) o.worldMatrix = m;
    }
    const render = this.ev.render;
    const shading = v.shading.value;
    // Overlays off hides everything Blender's overlay engine draws: helpers (cameras, lights,
    // empties, bones, wire curves), wireframe overlays, the edit-mode cage display, outlines,
    // origins, the grid, the 3D cursor, peers' boxes (and, in Viewport.tsx, the text info,
    // statistics and camera frame). Wireframe shading itself stays.
    const overlays = v.overlays.value;
    const opts: SyncOptions = {
      shading,
      showWireOverlay: v.showWireframe.value,
      // X-ray sees through objects in Solid and Wireframe shading only, like Blender's (its Material
      // Preview and Rendered shading draw them as they are; Edit Mode clicks still select through)
      xray: shading === 'WIREFRAME' || (shading === 'SOLID' && v.xray.value),
      selected: new Set(st.selectedIds),
      activeId: st.activeId,
      editObjectId: editId,
      renderAspect: render.resolution_x / Math.max(1, render.resolution_y),
      castShadows: shading === 'RENDERED' && render.use_shadows,
      imagesRevision: this.imagesRevision,
      overlays,
    };
    // another draw context (shading, X-ray) draws with other materials and render state: the GPU
    // builds pipelines for the next frame also where their programs are compiled already (by a
    // picture in that shading, or before multisampling changed). A material built again for new
    // values reuses its program and pipelines; a new program is a compile (FrameInFlight.compiled).
    const context = drawContext(opts, false);
    if (context !== this.syncedContext) this.unsettled = true;
    this.syncedContext = context;
    this.objects.sync(s.doc, this.ev, opts);
    const heavy = this.objects.drawnTriangles() > MSAA_HEAVY_TRIANGLES;
    if (heavy && !this.heavyScene && this.multisampling) this.setMultisampling(false);
    this.heavyScene = heavy;
    this.applyShading();
    // edit overlay (picking keeps using its cage while it is hidden)
    if (editId) {
      const o = this.ev.byId.get(editId);
      const base = this.meshOverrides.get(editId) ?? o?.baseMesh;
      if (o && base) {
        const token = this.meshOverrides.has(editId)
          ? `live${this.overrideToken}`
          : `doc${s.doc.meshVersion(o.data.data ?? '')}`;
        this.edit.update(base, st.meshSelection, st.selectMode, o.worldMatrix, v.xray.value, token);
        this.edit.group.visible = overlays;
      } else this.edit.hide();
    } else this.edit.hide();
    // outlines
    const sel = new Set(st.selectedIds);
    const selMeshes: THREE.Object3D[] = [];
    const activeMeshes: THREE.Object3D[] = [];
    if (st.mode === 'OBJECT' && overlays)
      for (const id of sel) {
        const view = this.objects.views.get(id);
        if (!view?.mesh?.visible || !view.root.visible) continue;
        (id === st.activeId ? activeMeshes : selMeshes).push(view.mesh);
      }
    this.outlineSel.selectedObjects = selMeshes;
    this.outlineActive.selectedObjects = activeMeshes;
    this.outlineSel.enabled = selMeshes.length > 0;
    this.outlineActive.enabled = activeMeshes.length > 0;
    // origin dots
    const dots: number[] = [];
    if (st.mode === 'OBJECT' && overlays)
      for (const id of sel) {
        const o = this.ev.byId.get(id);
        if (o?.visible) dots.push(o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]);
      }
    this.originDots.geometry.dispose();
    this.originDots.geometry = new THREE.BufferGeometry();
    this.originDots.geometry.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
    this.syncPeers();
    this.grid.visible = overlays && v.showGrid.value;
    this.cursor.visible = overlays;
    span.setAttribute('scene.objects', this.ev.objects.length).end();
  }

  private overrideToken = 0;
  setMeshOverride(id: string, mesh: MeshData | null): void {
    if (mesh) this.meshOverrides.set(id, mesh);
    else this.meshOverrides.delete(id);
    this.overrideToken++;
    this.invalidate();
  }

  setMatrixOverrides(m: Map<string, number[]> | null): void {
    this.matrixOverrides.clear();
    if (m) for (const [k, v] of m) this.matrixOverrides.set(k, v);
    this.invalidate();
  }

  private syncPeers(): void {
    for (const c of [...this.peerBoxes.children]) {
      this.peerBoxes.remove(c);
      (c as THREE.Box3Helper).geometry?.dispose();
    }
    if (!this.ev || !this.session.view.overlays.value) return;
    for (const peer of this.session.peers.value) {
      for (const id of peer.state.selection ?? []) {
        const o = this.ev.byId.get(id);
        if (!o?.visible) continue;
        const box = new THREE.Box3();
        if (o.mesh) {
          const b = meshBounds(o.mesh);
          if (!b) continue;
          for (const x of [b.min[0], b.max[0]])
            for (const y of [b.min[1], b.max[1]])
              for (const z of [b.min[2], b.max[2]])
                box.expandByPoint(new THREE.Vector3(...transformPoint3(o.worldMatrix, [x, y, z])));
        } else {
          const p = new THREE.Vector3(o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]);
          box.setFromCenterAndSize(p, new THREE.Vector3(0.6, 0.6, 0.6));
        }
        box.expandByScalar(0.03);
        const helper = new THREE.Box3Helper(box, new THREE.Color(peer.state.user.color));
        (helper.material as THREE.LineBasicMaterial).depthTest = false;
        this.peerBoxes.add(helper);
      }
    }
  }

  /** Lighting, background and colour management of `shading` (default: the viewport's) for `ev`. */
  private applyShading(ev: EvaluatedScene = this.ev!, shading = this.session.view.shading.value): void {
    const world = ev.world;
    const r = this.renderer;
    // Colour management (exposure, view transform, sRGB) is the output pass's, with the core
    // renderers' curves; three.js's own tone mapping stays off. Solid / wireframe: Standard.
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;
    this.colorManagement =
      shading === 'RENDERED' || shading === 'MATERIAL'
        ? { view: ev.render.view_transform ?? 'AGX', exposure: ev.render.exposure ?? 0 }
        : { view: 'STANDARD', exposure: 0 };
    this.outputPass.setTransform(this.colorManagement.view, this.colorManagement.exposure);
    r.shadowMap.enabled = shading === 'RENDERED' && ev.render.use_shadows;
    // Material Preview: three.js's studio room as a look-dev HDRI, whatever the world (like
    // Blender's). Rendered: the world as the core renderers light it: a STUDIO / IMAGE environment
    // (world-env.ts), the procedural sky (sky.ts, below) or the flat world colour.
    if (shading === 'MATERIAL' && !this.envTexture)
      this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const env = shading === 'RENDERED' ? this.worldEnv.maps(this.session.doc, world) : null;
    const ws = Number.isFinite(world.strength) ? Math.max(0, world.strength) : 1;
    this.scene.environment = shading === 'MATERIAL' ? this.envTexture : (env?.lighting ?? null);
    this.scene.environmentIntensity = env ? env.scale : 1;
    // equirect layouts are Y up; the scene is Z up
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    this.scene.backgroundRotation.set(Math.PI / 2, 0, 0);
    this.scene.backgroundIntensity = 1;
    this.scene.backgroundBlurriness = 0;
    // the core renderers' studio rig lights a scene without any light (aimed per render)
    this.rigNeeded =
      shading === 'RENDERED' && needsStudioRig(ev, !!env || world.environment === 'SKY', this.finalShading);
    for (const l of this.studioRig) l.visible = this.rigNeeded;
    if (shading === 'RENDERED') {
      if (env && world.show_environment_background) {
        this.scene.background = env.background();
        this.scene.backgroundIntensity = env.scale;
      } else
        this.scene.background = new THREE.Color(
          world.color[0] * ws,
          world.color[1] * ws,
          world.color[2] * ws,
        );
      // the flat world colour lights the scene (radiance colour × strength: irradiance π × that),
      // unless an environment or the sky does
      const boost = this.rigNeeded ? STUDIO_RIG_AMBIENT : 0;
      this.ambient.color.setRGB(
        world.color[0] * ws + boost,
        world.color[1] * ws + boost,
        world.color[2] * ws + boost,
      );
      this.ambient.intensity = env || world.environment === 'SKY' ? 0 : Math.PI;
    } else if (shading === 'MATERIAL') {
      this.scene.background = this.envTexture;
      this.scene.backgroundBlurriness = 0.6;
      this.ambient.intensity = 0;
    } else {
      this.scene.background = VIEWPORT_BG;
      this.ambient.intensity = 0;
    }
    // procedural sky (Rendered) and mist (Material Preview / Rendered) override the above
    this.sky.apply(this.scene, ev, shading, r.shadowMap.enabled);
  }

  /** Whether the studio rig lights the scene (see `needsStudioRig`), set by `applyShading`. */
  private rigNeeded = false;
  /** Whether `applyShading` runs for a final render (render visibility) rather than the viewport. */
  private finalShading = false;
  /** The key, fill and rim suns of the studio rig (world-env.ts). */
  private studioRig = STUDIO_RIG.map(() => {
    const l = new THREE.DirectionalLight(0xffffff, 0);
    l.visible = false;
    this.scene.add(l, l.target);
    return l;
  });

  /** Points the studio rig at a camera when it is on. */
  private aimRig(camera: THREE.Camera): void {
    if (this.rigNeeded) aimStudioRig(this.studioRig, camera);
  }

  /**
   * Fits the shadow maps of the suns (SUN lamps and the sky's sun) to what `camera` sees, before a
   * render with it (sun-shadow.ts).
   */
  private fitShadows(camera: THREE.Camera): void {
    if (!this.renderer.shadowMap.enabled) return;
    this.objects.fitSunShadows(camera);
    this.sky.fitShadow(camera, this.objects.shadowBoxes());
  }

  /**
   * Shadow maps of a frame: those of point and spot lights only after a scene change (they do not
   * depend on the view; SceneObjects.renderLocalShadows, which also keeps big instance scatters out
   * of them), the suns' (fitted to the frame's camera by fitShadows) with the frame's first render
   * of the scene. Shadow maps are drawn once per frame, not again for every render of the scene in
   * it (transmission pictures, selection outlines).
   */
  private drawShadows(): void {
    if (this.renderer.shadowMap.enabled) this.objects.renderLocalShadows(this.renderer);
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Levels of transmission pictures for this frame (one in heavy scenes, see transmission.ts). */
  private transmissionLevels(): number {
    return this.objects.drawnTriangles() > TRANSMISSION_LAYER_TRIANGLES ? 1 : MAX_TRANSMISSION_LEVELS;
  }

  // ------------------------------------------------------------------ cameras & render

  /** The camera of the frames drawn: the scene camera's view, else the viewport's (as last drawn). */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    if (this.session.view.cameraView.value && this.ev?.activeCamera?.camera) return this.updateSceneCamera();
    return this.shownPose.ortho ? this.orthoCam : this.perspCam;
  }

  /**
   * The pose of the last frame drawn: {@link pose}, or a pose on the way to it while an animated
   * view change runs. Picking and the view's camera use it (they work on what the person sees).
   */
  get shownPose(): ViewPose {
    return this.shown ?? this.pose;
  }

  /**
   * The pose a frame drawn at `now` shows: {@link pose}, or a pose on the way to it while an animated
   * view change runs. A change of the view during the animation (zooming, panning, orbiting, the
   * projection or focal length, following someone) ends it: the frame shows the view with the
   * change, made on the view the animation was going to, like Blender, whose navigation finishes a
   * running smooth view before it changes the view.
   */
  private framePose(now: number): ViewPose {
    const a = this.animating;
    if (!a) return this.pose;
    const t = (now - a.start) / a.dur;
    if (t >= 1 || !samePose(this.pose, a.to)) {
      this.animating = null;
      return this.pose;
    }
    // ease in and out; a frame's timestamp can be a little older than the change
    const k = Math.max(0, t);
    return lerpPose(a.from, a.to, k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  }

  /** Viewport camera matching the active scene camera (frame fitted into the viewport). */
  private updateSceneCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    const camObj = this.ev!.activeCamera!;
    const cam = camObj.camera!;
    const render = this.ev!.render;
    const renderAspect = render.resolution_x / Math.max(1, render.resolution_y);
    const viewAspect = this.width / Math.max(1, this.height);
    const margin = 0.88;
    const fitScale = Math.max(1, renderAspect / viewAspect) / margin;
    // lens shift moves the image inside the centred camera frame (see cameraFrameRect), as in renders:
    // the frame's half size in viewport NDC scales the render's shift
    const shiftX = cam.shift_x * (renderAspect / (viewAspect * fitScale));
    const shiftY = cam.shift_y / fitScale;
    const m = new THREE.Matrix4().fromArray(camObj.worldMatrix);
    if (cam.type === 'ORTHO') {
      const e = orthoHalfExtents(cam, renderAspect);
      const hh = e.halfH * fitScale;
      const oc = this.orthoCam;
      oc.top = hh;
      oc.bottom = -hh;
      oc.left = -hh * viewAspect;
      oc.right = hh * viewAspect;
      oc.near = cam.clip_start;
      oc.far = cam.clip_end;
      m.decompose(oc.position, oc.quaternion, new THREE.Vector3());
      oc.updateProjectionMatrix();
      applyLensShift(oc, shiftX, shiftY, renderAspect);
      oc.updateMatrixWorld(true);
      return oc;
    }
    const fov = cameraFovY(cam, renderAspect);
    const c = this.sceneCam;
    c.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(fov / 2) * fitScale));
    c.aspect = viewAspect;
    c.near = cam.clip_start;
    c.far = cam.clip_end;
    m.decompose(c.position, c.quaternion, new THREE.Vector3());
    c.updateProjectionMatrix();
    applyLensShift(c, shiftX, shiftY, renderAspect);
    c.updateMatrixWorld(true);
    return c;
  }

  /** Rectangle of the camera frame in CSS pixels (for the passepartout overlay). */
  cameraFrameRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.session.view.cameraView.value || !this.ev?.render) return null;
    const render = this.ev.render;
    const renderAspect = render.resolution_x / Math.max(1, render.resolution_y);
    const viewAspect = this.width / Math.max(1, this.height);
    const fitScale = Math.max(1, renderAspect / viewAspect) / 0.88;
    const h = this.height / fitScale;
    const w = h * renderAspect;
    return { x: (this.width - w) / 2, y: (this.height - h) / 2, w, h };
  }

  private render(now = performance.now()): void {
    const v = this.session.view;
    const aspect = this.width / Math.max(1, this.height);
    const pose = (this.shown = this.framePose(now));
    if (!(v.cameraView.value && this.ev?.activeCamera?.camera)) {
      applyPoseToCamera(pose, pose.ortho ? this.orthoCam : this.perspCam, aspect);
    }
    const cam = this.camera;
    updateGrid(this.grid, pose.distance, pose.ortho);
    const cl = this.session.state.cursorLocation;
    this.cursor.position.set(cl[0], cl[1], cl[2]);
    this.renderPass.camera = cam;
    this.overlayPass.camera = cam;
    this.outlineSel.renderCamera = cam;
    this.outlineActive.renderCamera = cam;
    this.aimRig(cam);
    this.fitShadows(cam);
    this.drawShadows();
    const pr = this.renderer.getPixelRatio();
    this.transmission.prepare(
      this.renderer,
      this.scene,
      cam,
      this.width * pr,
      this.height * pr,
      1,
      this.transmissionLevels(),
    );
    this.composer.render();
    // three.js has given the materials drawn their shader programs: those they replaced can go
    // unless kept for a draw context they have not been drawn in yet (scene-objects.ts replaceSlot)
    this.objects.disposeReplaced();
    v.viewLabel.value = v.cameraView.value ? 'Camera Perspective' : viewLabel(this.pose);
    for (const cb of this.onAfterRender) cb();
  }

  resize(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // resizing the canvas clears it: it shows no frame until the next one
    this.canvasRevision = -1;
    this.requestRender();
  }

  // ------------------------------------------------------------------ view manipulation

  /**
   * Sets the view. `animate` (a view change the person asks for: an axis view, an orbit step,
   * framing) draws the next {@link VIEW_ANIMATION_MS} of frames on the way there from what they
   * showed, like Blender's smooth view, while {@link pose} is the new view at once: get_view and
   * renders of the viewport's view read it, and a change of the view made meanwhile (zooming,
   * panning, orbiting, the projection, another view change) starts from it, so none is lost.
   */
  setPose(p: ViewPose, animate = false): void {
    this.session.view.following.value = null;
    this.animating = animate
      ? {
          from: clonePose(this.shownPose),
          to: clonePose(p),
          start: performance.now(),
          dur: VIEW_ANIMATION_MS,
        }
      : null;
    this.pose = p;
    this.persistPose();
    this.requestRender();
  }

  /** Called after interactive navigation; publishes the view for "follow" and saves it locally. */
  persistPose(): void {
    this.session.schedulePresence(poseToPresence(this.pose));
    try {
      localStorage.setItem(
        `3d-editor:view:${this.session.id}`,
        JSON.stringify({ ...this.pose, target: this.pose.target.toArray() }),
      );
    } catch {
      /* ignore */
    }
  }

  private restorePose(): void {
    try {
      const raw = localStorage.getItem(`3d-editor:view:${this.session.id}`);
      if (!raw) return;
      const p = JSON.parse(raw);
      this.pose = { ...DEFAULT_POSE(), ...p, target: new THREE.Vector3().fromArray(p.target) };
    } catch {
      /* ignore */
    }
  }

  /** World-space bounding sphere of objects (all visible when ids omitted). */
  boundsOf(ids?: string[]): THREE.Sphere | null {
    if (!this.ev) this.sync();
    const box = new THREE.Box3();
    const list = ids
      ? ids.map((id) => this.ev!.byId.get(id)).filter(Boolean)
      : this.ev!.objects.filter((o) => o.visible);
    for (const o of list) {
      if (!o) continue;
      if (o.mesh) {
        const b = meshBounds(o.mesh);
        if (b)
          for (const x of [b.min[0], b.max[0]])
            for (const y of [b.min[1], b.max[1]])
              for (const z of [b.min[2], b.max[2]])
                box.expandByPoint(new THREE.Vector3(...transformPoint3(o.worldMatrix, [x, y, z])));
      } else box.expandByPoint(new THREE.Vector3(o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]));
    }
    if (box.isEmpty()) return null;
    return box.getBoundingSphere(new THREE.Sphere());
  }

  frameSphere(sphere: THREE.Sphere | null, animate = true): void {
    if (!sphere) return;
    const p = clonePose(this.pose);
    p.target.copy(sphere.center);
    const r = Math.max(sphere.radius, 0.1);
    p.distance = (r / Math.sin(p.fovY / 2)) * 1.1;
    this.session.view.cameraView.value = false;
    this.setPose(p, animate);
  }

  /** Projects a world point to CSS pixel coordinates (x right, y down) and NDC depth. */
  project(p: Vec3 | THREE.Vector3): { x: number; y: number; z: number } {
    const v = p instanceof THREE.Vector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]);
    v.project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z };
  }

  /** Ray through a CSS pixel. */
  rayAt(x: number, y: number): THREE.Raycaster {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    rc.params.Line = { threshold: 0.05 * (this.shownPose.distance / 10) };
    rc.params.Points = { threshold: 0.1 };
    return rc;
  }

  /** Point on the plane through `origin` facing the camera, under the mouse. */
  viewPlanePoint(x: number, y: number, origin: THREE.Vector3): THREE.Vector3 | null {
    const rc = this.rayAt(x, y);
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin);
    return rc.ray.intersectPlane(plane, new THREE.Vector3());
  }

  /**
   * Renders the scene from the active camera into a PNG data URL at a given size (F12 / RPC).
   * When the engine (option, else the render settings) is PATHTRACER the image is path traced on
   * the render workers, except SOLID / WIREFRAME shading and viewport captures (`useViewport`
   * without an explicit engine), which rasterize; path traced renders stop sampling after
   * `time_limit` seconds (default {@link RPC_PATH_TRACE_SECONDS}, within the server's RPC timeout).
   */
  async renderImage(
    opts: RenderImageOptions = {},
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    const span = telemetry.startSpan('render.image');
    try {
      let img: PixelImage;
      if (this.pathTraces(opts)) {
        span.setAttribute('render.engine', 'PATHTRACER');
        const r = await this.startPathTrace({
          ...opts,
          time_limit: opts.time_limit ?? RPC_PATH_TRACE_SECONDS,
        }).result;
        span.setAttribute('render.samples', r.samples);
        img = r;
      } else img = this.renderPixels(opts);
      span.setAttribute('render.width', img.width).setAttribute('render.height', img.height).setOk();
      return { dataUrl: pixelsToDataUrl(img), width: img.width, height: img.height };
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      telemetry.histogram('editor.render_ms', span.end());
    }
  }

  /**
   * Whether {@link renderImage} path traces with these options. A viewport capture (`useViewport`,
   * editor_command 'screenshot') without an explicit engine is always rasterized: in RENDERED
   * shading while the render engine is PATHTRACER it shows the viewport's WebGL Rendered shading,
   * not a path traced image.
   */
  pathTraces(opts: RenderImageOptions = {}): boolean {
    const engine = opts.engine ?? (opts.useViewport ? 'RASTER' : this.session.doc.getRender().engine);
    return engine === 'PATHTRACER' && opts.shading !== 'SOLID' && opts.shading !== 'WIREFRAME';
  }

  /**
   * Output size of a render: the options (a missing side follows the output's aspect ratio), else
   * the output settings (resolution × %). Larger than 4096 px on a side, both sides are scaled by
   * the same factor, so the image keeps the camera's framing (see {@link renderOutputSize}).
   */
  private renderSize(opts: RenderImageOptions): { width: number; height: number } {
    const render = this.session.doc.getRender();
    const aspect = render.resolution_x / Math.max(1, render.resolution_y);
    const size =
      opts.width === undefined && opts.height === undefined
        ? renderOutputSize(render.resolution_x, render.resolution_y, render.resolution_percentage)
        : renderOutputSize(opts.width ?? opts.height! * aspect, opts.height ?? opts.width! / aspect, 100);
    return { width: size.width, height: size.height };
  }

  /**
   * Starts a progressive path traced render on the render workers with {@link renderImage}'s view
   * choice: the explicit view, else the camera (option or scene camera), else the viewport's view.
   * The document is captured now; the render settings give samples, bounces and denoising unless
   * the options override them.
   */
  startPathTrace(opts: RenderImageOptions = {}): PathTraceJob {
    const { width, height } = this.renderSize(opts);
    const frame =
      typeof opts.frame === 'number' && Number.isFinite(opts.frame) ? opts.frame : this.session.state.frame;
    // the page's own heap (its document and the viewport's evaluation, at the viewport's frame) and
    // the geometry the evaluator of RASTER final renders keeps (which counts the path traced renders
    // running in turn, evaluateFinal)
    const o: PathTraceOptions = {
      width,
      height,
      frame,
      pageFrame: this.session.state.frame,
      pageHeld: this.finalEval ? this.finalHeld : 0,
    };
    if (opts.samples !== undefined) o.samples = opts.samples;
    if (opts.max_bounces !== undefined) o.max_bounces = opts.max_bounces;
    if (opts.denoise !== undefined) o.denoise = opts.denoise;
    if (opts.seed !== undefined) o.seed = opts.seed;
    if (opts.time_limit !== undefined) o.timeLimit = opts.time_limit;
    // the workers evaluate the camera at `frame` (`cameraId`); whether there is one is read from
    // the document as it is now (the viewport's last evaluation can be stale, e.g. in a hidden tab)
    const cameraId = opts.view ? null : this.renderCameraId(opts);
    if (opts.view) {
      const v = opts.view;
      o.viewSpec = {
        position: [v.position[0], v.position[1], v.position[2]],
        target: [v.target[0], v.target[1], v.target[2]],
        up: v.up ? [v.up[0], v.up[1], v.up[2]] : [0, 0, 1],
        fovY: THREE.MathUtils.degToRad(v.fov_degrees ?? 50),
      };
    } else if (cameraId) o.cameraId = cameraId;
    // the viewport's view (orthographic when the viewport is), like the rasterized render
    else o.view = renderViewFromCamera(viewportCamera(this.pose, width / height, true));
    return pathTraceDocument(this.session.doc, o);
  }

  /**
   * Whether a render without an explicit view shows the camera (option or scene camera): always,
   * except viewport captures (`useViewport`) while the viewport is not looking through the camera.
   */
  private rendersCamera(opts: RenderImageOptions): boolean {
    return !opts.useViewport || this.session.view.cameraView.value;
  }

  /**
   * The camera object a render without an explicit view shows (see {@link rendersCamera}): the
   * requested camera, else the scene camera; null when it shows the viewport's view. Read from the
   * document as it is now, not from the viewport's last evaluation. A requested object that is not a
   * camera is an error.
   */
  private renderCameraId(opts: RenderImageOptions): string | null {
    if (!this.rendersCamera(opts)) return null;
    const doc = this.session.doc;
    const isCamera = (id: string | null | undefined) => {
      const o = id ? doc.getObject(id) : null;
      return !!o && o.type === 'CAMERA' && !!o.data && !!doc.getCamera(o.data);
    };
    if (opts.cameraId) {
      if (!isCamera(opts.cameraId)) {
        const o = doc.getObject(opts.cameraId);
        throw new Error(
          o ? `'${o.name}' is a ${o.type} object, not a camera` : `Camera '${opts.cameraId}' not found`,
        );
      }
      return opts.cameraId;
    }
    const sceneCamera = doc.getScene().camera;
    return isCamera(sceneCamera) ? sceneCamera : null;
  }

  /**
   * Rasterizes the scene (WebGL) with {@link renderImage}'s camera choice and returns RGBA8 pixels
   * (top row first).
   *
   * A final render (F12, Render Animation, MCP renders) shows the document as it is now, evaluated
   * for rendering like the path tracer and the server's renderers: objects visible in renders
   * (`hide_render`, not `hide_viewport`), modifiers with their render settings (Subdivision render
   * levels, `show_render`), curve render resolution and render particle amounts, shape keys also
   * while the viewport is in Edit Mode, and none of the viewport's display settings (X-ray, Display
   * As Wire / Bounds, live transform previews); in Rendered shading unless `shading` says otherwise.
   * A capture (`useViewport`) shows the viewport as it is, without overlays, in the shading it shows
   * now unless `shading` names another one. The first picture in a shading the viewport has not
   * drawn yet builds that shading's materials and compiles their shaders (tens of seconds for a
   * heavy scene in Rendered shading in software WebGL, see rpc.ts); they are kept for later
   * pictures, and the viewport's own for its next frame (scene-objects.ts
   * ObjectView.materialSets). The viewport's shading, overlays and frame are restored afterwards.
   *
   * A capture is drawn with the viewport's multisampling, or with the other sample count when its
   * shading was drawn with that one only ({@link captureSamples}); a final render with up to 8
   * samples, or, where its shading was drawn without samples, without them: supersampled when that
   * fits a time budget, else smoothed with SMAA ({@link finalSampling}).
   */
  renderPixels(opts: RenderImageOptions = {}): PixelImage {
    // the frames the GPU still draws are waited for with this picture, and the next frame comes
    // after it: their times say nothing of what frames cost (adaptMultisampling)
    for (const f of this.framesInFlight) f.settled = false;
    this.unsettled = true;
    const { width, height } = this.renderSize(opts);
    const aspect = width / height;
    const view = this.session.view;
    const state = this.session.state;
    const shading = opts.shading ?? (opts.useViewport ? view.shading.value : 'RENDERED');
    const frame = typeof opts.frame === 'number' && Number.isFinite(opts.frame) ? opts.frame : state.frame;
    const prevShading = view.shading.value;
    const prevOverlays = view.overlays.value;
    const prevFrame = state.frame;
    const prevBg = this.scene.background;
    const disposables: { dispose(): void }[] = [];
    const hiddenOverlays: THREE.Object3D[] = [];
    let smaa: SMAAPass | null = null;
    try {
      // The camera comes from this evaluation too: the viewport's own one is from its last animation
      // frame (stale in hidden tabs, which get none) and at the viewport's frame.
      let ev: EvaluatedScene;
      if (opts.useViewport) {
        state.frame = frame;
        view.shading.value = shading;
        view.overlays.value = false;
        this.sync();
        ev = this.ev!;
      } else ev = this.syncFinalRender(frame, shading);
      const cam = this.renderCamera(ev, opts, aspect);
      this.aimRig(cam);
      this.fitShadows(cam);
      const final = opts.useViewport ? null : this.finalSampling(shading, opts.animation === true);
      const samples = final ? final.samples : this.captureSamples();
      const target = new THREE.WebGLRenderTarget(width, height, { samples, type: THREE.HalfFloatType });
      // The composer output is already tone mapped and sRGB encoded, so copy it raw (linear target).
      const out = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType });
      const comp = new EffectComposer(this.renderer, target);
      disposables.push(target, out, comp);
      comp.renderToScreen = false;
      comp.setPixelRatio(1);
      comp.setSize(width, height);
      // Film > Transparent: no world background and a clear alpha of 0, so the background stays
      // transparent; the coverage-weighted (premultiplied) colours are divided by alpha before tone
      // mapping, so the PNG has straight alpha without dark fringes, like the path tracer's film.
      const transparent = ev.render.film_transparent;
      if (transparent) this.scene.background = null;
      const scenePass = new RenderPass(
        this.scene,
        cam,
        null,
        transparent ? new THREE.Color(0, 0, 0) : null,
        transparent ? 0 : null,
      );
      // a final render without samples draws its scene here (supersampled or not), the passes after
      // it run in the composer
      const supersampled =
        final?.samples === 0 && this.drawFinalScene(scenePass, cam, comp, out, width, height, transparent);
      if (final?.samples !== 0) comp.addPass(scenePass);
      if (opts.useViewport) {
        // The objects' part of the overlay scene, drawn over the scene like the viewport does: with
        // overlays off it holds only the wires of Wireframe shading, which are the shading, not an
        // overlay (scene-objects.ts). The editor's own parts of it (transform gizmo, grid, 3D
        // cursor, origins, Edit Mode cage, others' selections) stay out of the picture.
        for (const c of this.overlay.children)
          if (c.visible && typeof c.userData.objectId !== 'string') {
            c.visible = false;
            hiddenOverlays.push(c);
          }
        const wires = new RenderPass(this.overlay, cam);
        wires.clear = false;
        wires.clearDepth = false;
        comp.addPass(wires);
      }
      const parts = this.captureParts();
      if (transparent) comp.addPass(parts.unpremultiply);
      // exposure, view transform and sRGB encoding like the path tracer's film (view-transform.ts)
      parts.output.setTransform(this.colorManagement.view, this.colorManagement.exposure);
      comp.addPass(parts.output);
      if (final?.samples === 0 && !supersampled) {
        // anti-aliasing of the picture as shown (after the view transform); on a transparent film
        // it blends premultiplied colours, so the edges against the background keep their colour
        if (transparent) comp.addPass(parts.premultiply);
        smaa = this.smaaPass();
        comp.addPass(smaa);
        if (transparent) comp.addPass(parts.unpremultiplyShown);
      }
      if (final?.samples !== 0) {
        this.drawShadows();
        this.transmission.prepare(
          this.renderer,
          this.scene,
          cam,
          width,
          height,
          transparent ? 0 : 1,
          this.transmissionLevels(),
        );
      }
      comp.render();
      if (final) this.noteDrawn(final.drawn, final.context);
      else this.noteDrawn(samples);
      this.objects.disposeReplaced();
      // copy result (composer read buffer) into a byte target via a fullscreen quad, unblended
      parts.quad.material.map = comp.readBuffer.texture;
      const prevTm = this.renderer.toneMapping;
      const prevClear = this.renderer.getClearColor(new THREE.Color());
      const prevAlpha = this.renderer.getClearAlpha();
      const pixels = new Uint8Array(width * height * 4);
      try {
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.setRenderTarget(out);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear();
        this.renderer.render(parts.quadScene, parts.quadCamera);
        this.renderer.readRenderTargetPixels(out, 0, 0, width, height, pixels);
      } finally {
        this.renderer.setRenderTarget(null);
        this.renderer.toneMapping = prevTm;
        this.renderer.setClearColor(prevClear, prevAlpha);
      }
      // flip rows (WebGL origin is bottom-left)
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      for (let i = 3; i < data.length; i += 4)
        if (!transparent) data[i] = 255;
        else if (data[i] === 0) data[i - 3] = data[i - 2] = data[i - 1] = 0;
      return { width, height, data };
    } finally {
      for (const d of disposables) d.dispose();
      // the SMAA pass is kept (its shader programs); its targets go until the next render needs them
      smaa?.setSize(1, 1);
      for (const c of hiddenOverlays) c.visible = true;
      this.scene.background = prevBg;
      view.shading.value = prevShading;
      view.overlays.value = prevOverlays;
      state.frame = prevFrame;
      this.invalidate();
    }
  }

  /**
   * The samples of a capture (editor_command screenshot) in the draw context of the last sync: the
   * viewport's, 4 while it is multisampled and none while it is not ({@link multisampling}: heavy
   * scenes, slow frames), unless that context was drawn with the other count only (by the viewport
   * before its multisampling changed, or by a capture; {@link drawnSamples}). Software WebGL
   * (SwiftShader) builds a pipeline per shader and sample count: a picture with other samples than
   * the frames before it builds a second one for every material. Measured with
   * examples/domino-cascade (also with a 1 M triangle grid added), for the first Material Preview
   * or Rendered picture after the viewport drew that shading without samples (no shader compiled):
   * 9.8–13.5 s with 4 samples, 0.7–1.4 s with the viewport's. A picture with the viewport's samples
   * shows what the viewport shows, as Blender's screenshot shows the viewport's pixels (its Solid
   * shading draws one sample, with SMAA or no anti-aliasing, while the view moves or an animation
   * plays). Timed in the page there, at 1280×720 with the viewport single-sampled, per picture
   * without samples / with 4 (pipelines built) / supersampled 2×2 without: Rendered 0.42 / 0.96 /
   * 1.58 s, Solid 0.14 / 0.60 / 0.46 s; edges, the mean difference from a 4×4-supersampled picture
   * on its edge pixels (of 255): Rendered 12.6 / 10.4 / 5.8, Solid 6.7 / 3.0 / 2.4. FXAA (Rendered
   * 8.3, +0.13 s) blurred the dominoes and doubled Wireframe lines.
   */
  private captureSamples(): number {
    const own = this.multisampling ? VIEWPORT_MSAA_SAMPLES : 0;
    const other = own ? 0 : VIEWPORT_MSAA_SAMPLES;
    const drawn = this.drawnSamples.get(this.syncedContext);
    return drawn && !drawn.has(own) && drawn.has(other) ? other : own;
  }

  /**
   * How a final render (F12, Render Animation, MCP renders) in `shading` is anti-aliased without
   * building a second set of pipelines in software WebGL (see {@link captureSamples}):
   * multisampled ({@link FINAL_RENDER_SAMPLES}) where its draw context was drawn with samples, or
   * has not been drawn while the viewport is multisampled, and in every frame of Render Animation
   * (`animation`: its first frame builds the pipelines once if need be, and every frame gets the
   * same anti-aliasing); else (`samples` 0) drawn without samples by {@link drawFinalScene}:
   * supersampled, 5 pictures moved by fractions of a pixel and averaged, when the GPU drew the
   * first one in at most {@link FINAL_SUPERSAMPLE_MS}, else that picture smoothed with SMAA after
   * the view transform ({@link smaaPass}), which cannot draw what falls between pixel centres.
   * With samples, the first final render after the viewport drew its shading without them (heavy
   * scenes, slow frames) builds every material's pipelines again. Measured in software WebGL at
   * 1280×720, in examples/domino-cascade with a 1 M triangle grid out of view (procedural wood fills
   * the camera's picture): with 4 samples F12 took 17.9 s the first time (6 pipelines built) and
   * 9.3 s the next, and render_image 'auto' gave up on the browser after 15 s (18.6 s in the page);
   * without samples the first picture took 8.0–10.4 s, so SMAA: 8.3–8.8 s for F12, 10.1 s for
   * render_image 'auto', which the browser answered. In the startup scene with 18 rods 0.8 px wide
   * and the same grid, the first picture took 0.4–0.7 s, the supersampled render 1.6–3.4 s (4
   * samples: 1.4–2.2 s); edges, the mean difference from a 4×4-supersampled render on its edge
   * pixels (of 255), supersampled / 4 samples / SMAA / none: 5.8 / 6.6 / 10.7 / 13.8, the rods
   * continuous with the first two and dashed with SMAA. `drawn` is the sample count noted for the
   * context.
   */
  private finalSampling(
    shading: NonNullable<RenderImageOptions['shading']>,
    animation: boolean,
  ): { samples: number; context: string; drawn: number } {
    const context = drawContext({ shading, xray: false }, false);
    const drawn = this.drawnSamples.get(context);
    if (animation || (drawn ? [...drawn].some((n) => n > 0) : this.multisampling)) {
      const samples = FINAL_RENDER_SAMPLES;
      // three.js draws with the GPU's maximum when it has fewer
      const max = this.renderer.capabilities?.maxSamples;
      return { samples, context, drawn: max ? Math.min(samples, max) : samples };
    }
    return { samples: 0, context, drawn: 0 };
  }

  /**
   * Draws the scene of a final render without samples ({@link finalSampling}) into the composer's
   * read buffer with `pass`: one picture, timed by reading back one pixel of `sync` after the frames
   * the GPU still drew for the viewport and after the picture; when that took at most
   * {@link FINAL_SUPERSAMPLE_MS}, four more with the picture moved by fractions of a pixel
   * ({@link FINAL_SUPERSAMPLE_OFFSETS}), averaged with it in linear light before the view transform
   * (premultiplied on a transparent film), like the samples of a multisampled picture. Shadow maps
   * are drawn once, transmission pictures for each picture, with its camera. Returns whether it
   * supersampled (else the caller smooths the picture with SMAA).
   */
  private drawFinalScene(
    pass: RenderPass,
    cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    comp: EffectComposer,
    sync: THREE.WebGLRenderTarget,
    width: number,
    height: number,
    transparent: boolean,
  ): boolean {
    const levels = this.transmissionLevels();
    const draw = (into: THREE.WebGLRenderTarget) => {
      this.transmission.prepare(this.renderer, this.scene, cam, width, height, transparent ? 0 : 1, levels);
      pass.render(this.renderer, into, into, 0, false);
    };
    const start = this.gpuDone(sync);
    this.drawShadows();
    draw(comp.readBuffer);
    if (this.gpuDone(sync) - start > FINAL_SUPERSAMPLE_MS) return false;
    const base = cam.projectionMatrix.clone();
    const picture = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType });
    const average = this.captureParts().average;
    try {
      for (let i = 1; i < FINAL_SUPERSAMPLE_OFFSETS.length; i++) {
        const [x, y] = FINAL_SUPERSAMPLE_OFFSETS[i];
        moveProjection(cam, base, x, y, width, height);
        draw(picture);
        average.uniforms.tSample.value = picture.texture;
        average.uniforms.weight.value = 1 / (i + 1);
        average.render(this.renderer, comp.writeBuffer, comp.readBuffer, 0, false);
        comp.swapBuffers();
      }
    } finally {
      cam.projectionMatrix.copy(base);
      cam.projectionMatrixInverse.copy(base).invert();
      average.uniforms.tSample.value = null;
      picture.dispose();
    }
    return true;
  }

  /**
   * Reads one pixel of `target` back: returns, with the time, once the GPU has drawn everything it
   * was given (WebGL has no other wait for the GPU).
   */
  private gpuDone(target: THREE.WebGLRenderTarget): number {
    this.renderer.setRenderTarget(target);
    this.renderer.readRenderTargetPixels(target, 0, 0, 1, 1, new Uint8Array(4));
    return performance.now();
  }

  /** SMAA of final renders drawn without samples ({@link finalSampling}). */
  private smaa: SMAAPass | null = null;

  /**
   * The SMAA pass, made when first asked for: when the viewport first draws without samples
   * ({@link setMultisampling}), so the lookup textures it decodes from data URLs are loaded before a
   * final render that is not supersampled uses it. Kept with its shader programs; its targets
   * shrink after each render.
   */
  private smaaPass(): SMAAPass {
    return (this.smaa ??= new SMAAPass());
  }

  /**
   * Notes that a draw context (by default the one of the last sync) was drawn with `samples`
   * ({@link drawnSamples}).
   */
  private noteDrawn(samples: number, context = this.syncedContext): void {
    const drawn = this.drawnSamples.get(context);
    if (drawn) drawn.add(samples);
    else this.drawnSamples.set(context, new Set([samples]));
  }

  /**
   * The output passes and the copy quad of pictures ({@link renderPixels}): kept from one picture
   * to the next, so that a picture does not link their shader programs again (three.js drops a
   * program with the last material that uses it: two programs for every picture).
   */
  private capture: {
    output: ViewTransformPass;
    unpremultiply: ShaderPass;
    /** SMAA of a final render on a transparent film (see renderPixels). */
    premultiply: ShaderPass;
    unpremultiplyShown: ShaderPass;
    /** The average of a supersampled final render's pictures ({@link drawFinalScene}). */
    average: ShaderPass;
    quad: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    quadScene: THREE.Scene;
    quadCamera: THREE.OrthographicCamera;
  } | null = null;

  private captureParts(): NonNullable<ViewportEngine['capture']> {
    if (this.capture) return this.capture;
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ blending: THREE.NoBlending, toneMapped: false, depthTest: false }),
    );
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    return (this.capture = {
      output: new ViewTransformPass(),
      unpremultiply: new ShaderPass(UNPREMULTIPLY_SHADER),
      premultiply: new ShaderPass(SMAA_PREMULTIPLY_SHADER),
      unpremultiplyShown: new ShaderPass(SMAA_UNPREMULTIPLY_SHADER),
      average: new ShaderPass(AVERAGE_SHADER),
      quad,
      quadScene,
      quadCamera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    });
  }

  /** Evaluator of final renders (see {@link finalEvaluator}) and the timer that drops it. */
  private finalEval: SceneEvaluator | null = null;
  private finalEvalTimer: ReturnType<typeof setTimeout> | null = null;
  /** The JavaScript heap the evaluator of final renders holds: its last render's geometry (estimated). */
  private finalHeld = 0;

  /**
   * The evaluator of final renders. It is not the viewport's: its caches keep the geometry evaluated
   * with the render settings, the viewport's with the viewport settings, so neither recomputes the
   * other's. Dropped after {@link FINAL_EVALUATOR_IDLE_MS} without renders.
   */
  private finalEvaluator(): SceneEvaluator {
    this.finalEval ??= new SceneEvaluator(this.session.doc);
    if (this.finalEvalTimer) clearTimeout(this.finalEvalTimer);
    this.finalEvalTimer = setTimeout(() => this.dropFinalEvaluator(), FINAL_EVALUATOR_IDLE_MS);
    return this.finalEval;
  }

  /** Drops the evaluator of final renders and what its caches hold. */
  private dropFinalEvaluator(): void {
    if (this.finalEvalTimer) clearTimeout(this.finalEvalTimer);
    this.finalEvalTimer = null;
    this.finalEval = null;
    this.finalHeld = 0;
  }

  /**
   * The scene evaluated at `frame` with the render settings for a final render (F12, Render
   * Animation, MCP renders), when that fits the tab's JavaScript heap. The evaluation runs on the
   * page, next to the viewport's (render/memory.ts `rasterNeeds`): a scene whose geometry at the
   * render settings does not fit the room the heap has left is refused before it is evaluated
   * (`rasterRefusal`, from its estimate at `frame`), and while it is evaluated every modifier is
   * checked right before it runs, from its real input (render/guard.ts `RasterEvaluationGuard`):
   * running out of heap would end the tab. A refusal is thrown with the reason. The geometry the
   * evaluator keeps from an earlier render stays in the heap while this one is evaluated: it goes
   * first where it and the new one would not fit together, and, where a modifier then does not fit
   * next to it, the scene is evaluated once more without it.
   */
  private evaluateFinal(frame: number): EvaluatedScene {
    const s = this.session;
    const estimate = estimateRender(s.doc, true, frame);
    // the page's own heap: its document and the viewport's evaluation, at the viewport's frame
    const memory = tabMemoryWithRenders(pageHeapEstimate(s.doc, s.state.frame));
    const needs = rasterNeeds(estimate);
    const refusal = rasterRefusal(needs, memory);
    if (refusal) throw new Error(refusal);
    if (this.finalEval && rasterRefusal({ ...needs, heap: needs.heap + this.finalHeld }, memory))
      this.dropFinalEvaluator();
    const evaluate = (kept: number) => {
      const guard = new RasterEvaluationGuard(estimate, { ...memory, heapUsed: memory.heapUsed + kept });
      const evaluator = this.finalEvaluator();
      return { guard, ev: guardedEvaluation(guard, () => evaluator.evaluate(frame, { forRender: true })) };
    };
    const kept = this.finalEval ? this.finalHeld : 0;
    let { guard, ev } = evaluate(kept);
    if (guard.refusal && kept > 0) {
      this.dropFinalEvaluator();
      ({ guard, ev } = evaluate(0));
    }
    if (guard.refusal) {
      // the evaluator kept results without the modifiers it skipped: the next render starts afresh
      this.dropFinalEvaluator();
      throw new Error(
        rasterRefusalWithModifier(guard.refusal, memory, refusedModifier(s.doc, ev, guard.refusal.message)),
      );
    }
    this.finalHeld =
      guard.heldTriangles * RASTER_BYTES_PER_TRIANGLE + estimate.instances * INSTANCE_BYTES.heap;
    return ev;
  }

  /**
   * Mirrors the scene as a final render shows it (see {@link renderPixels}) into the three.js scene
   * with `shading`, and returns that evaluation. The viewport shows its own state again from its
   * next frame. Clay shading (SOLID) has the world colour behind it, like the server's renderer,
   * instead of the viewport's grey.
   */
  private syncFinalRender(
    frame: number,
    shading: NonNullable<RenderImageOptions['shading']>,
  ): EvaluatedScene {
    const s = this.session;
    const ev = finalRenderScene(this.evaluateFinal(frame));
    const render = ev.render;
    this.objects.sync(s.doc, ev, {
      shading,
      showWireOverlay: false,
      xray: false,
      selected: new Set(s.state.selectedIds),
      activeId: s.state.activeId,
      editObjectId: null,
      renderAspect: render.resolution_x / Math.max(1, render.resolution_y),
      castShadows: shading === 'RENDERED' && render.use_shadows,
      imagesRevision: this.imagesRevision,
      overlays: false,
    });
    this.finalShading = true;
    try {
      this.applyShading(ev, shading);
    } finally {
      this.finalShading = false;
    }
    if (shading === 'SOLID' || shading === 'WIREFRAME') {
      const w = ev.world;
      const k = Number.isFinite(w.strength) ? Math.max(0, w.strength) : 1;
      this.scene.background = new THREE.Color(w.color[0] * k, w.color[1] * k, w.color[2] * k);
    }
    this.needsSync = true;
    return ev;
  }

  /**
   * The camera of a rasterized render with {@link renderImage}'s camera choice, taken from `ev` (the
   * scene evaluated for this render): the explicit view, else the camera (option or scene camera)
   * with its field of view, clipping and lens shift, else the viewport's view.
   */
  private renderCamera(
    ev: EvaluatedScene,
    opts: RenderImageOptions,
    aspect: number,
  ): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    if (opts.view) {
      const v = opts.view;
      const pc = new THREE.PerspectiveCamera(v.fov_degrees ?? 50, aspect, 0.01, 10000);
      pc.up.set(...((v.up ?? [0, 0, 1]) as [number, number, number]));
      pc.position.set(...(v.position as [number, number, number]));
      pc.lookAt(new THREE.Vector3(...(v.target as [number, number, number])));
      pc.updateMatrixWorld(true);
      pc.updateProjectionMatrix();
      return pc;
    }
    const cameraId = this.renderCameraId(opts);
    const camObj = cameraId ? ev.byId.get(cameraId) : null;
    if (camObj?.camera) return sceneCameraView(camObj.camera, camObj.worldMatrix, aspect);
    const vc = viewportCamera(this.pose, aspect);
    vc.updateMatrixWorld(true);
    vc.updateProjectionMatrix();
    return vc;
  }

  /**
   * A small JPEG of the viewport for the project's thumbnail: a frame that shows the document as it
   * is (its revision), scaled down. The canvas keeps the last frame drawn (preserveDrawingBuffer), so
   * no frame is drawn for it, which held the main thread for as long as the GPU drew it (0.55–0.95 s
   * with 4 million triangles in software WebGL). A copy of the canvas waits for the frames the GPU
   * still draws (1.16–1.28 s for the default cube while the animation played, in software WebGL):
   * while the GPU draws one, the thumbnail is what the frame loop read back of a frame of this
   * revision, without waiting ({@link readThumbnail}; the loop reads one back when asked); null until
   * then, and while the viewport drew no frame (a hidden page draws none).
   */
  thumbnail(maxW = 320): string | null {
    const revision = this.session.revision.peek();
    const last = this.thumb;
    // the canvas shows the document as it is and the GPU draws nothing: a copy of it (the one made
    // already when no frame was drawn since)
    if (!this.framesInFlight.length && this.canvasRevision === revision)
      return last?.frame === this.canvasFrames ? last.url : this.copyThumbnail(maxW);
    if (last?.revision === revision) return last.url;
    // (one on its way already)
    if (this.thumbRead?.revision !== revision) this.thumbWanted = true;
    return null;
  }

  /**
   * Starts reading the canvas back for the project's thumbnail without waiting for the GPU (WebGL2):
   * its pixels go into a buffer after the frames the GPU draws, and a fence says when they are there
   * ({@link finishThumbnail}). Without WebGL2 (no frames in flight then), a copy of the canvas.
   */
  private readThumbnail(): void {
    const gl = this.renderer.getContext?.();
    const gl2 = gl && 'fenceSync' in gl ? (gl as WebGL2RenderingContext) : null;
    if (!gl2) {
      if (!this.framesInFlight.length) this.copyThumbnail();
      return;
    }
    if (gl2.isContextLost?.()) return;
    const width = gl2.drawingBufferWidth;
    const height = gl2.drawingBufferHeight;
    const buffer = gl2.createBuffer();
    if (!buffer || !(width > 0) || !(height > 0)) return;
    // what three.js has bound stays bound
    const read = gl2.getParameter(gl2.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const pack = gl2.getParameter(gl2.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, null);
    gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, buffer);
    gl2.bufferData(gl2.PIXEL_PACK_BUFFER, width * height * 4, gl2.STREAM_READ);
    gl2.readPixels(0, 0, width, height, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
    gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, pack);
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, read);
    const fence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl2.flush();
    if (!fence) {
      gl2.deleteBuffer(buffer);
      return;
    }
    this.thumbWanted = false;
    this.thumbRead = {
      buffer,
      fence,
      width,
      height,
      revision: this.canvasRevision,
      frame: this.canvasFrames,
    };
  }

  /**
   * Makes the project's thumbnail of the canvas read back ({@link readThumbnail}) once the GPU has
   * put it into its buffer, without waiting for the frames drawn since: one task of 28–277 ms while
   * the default cube's animation played in software WebGL (12–261 ms of it to take the 1067 × 631
   * pixels from the buffer, the rest to scale them down and encode them), where a copy of the
   * canvas waited 1.16–1.28 s.
   */
  private finishThumbnail(maxW = 320): void {
    const r = this.thumbRead;
    if (!r) return;
    const gl = this.renderer.getContext?.();
    const gl2 = gl && 'fenceSync' in gl ? (gl as WebGL2RenderingContext) : null;
    if (!gl2 || gl2.isContextLost?.()) {
      this.thumbRead = null;
      return;
    }
    if (gl2.getSyncParameter(r.fence, gl2.SYNC_STATUS) !== gl2.SIGNALED) return;
    this.thumbRead = null;
    gl2.deleteSync(r.fence);
    const pixels = new Uint8Array(r.width * r.height * 4);
    const pack = gl2.getParameter(gl2.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, r.buffer);
    gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, pixels);
    gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, pack);
    gl2.deleteBuffer(r.buffer);
    const url = thumbnailJpeg(pixels, r.width, r.height, maxW);
    if (url) this.thumb = { url, revision: r.revision, frame: r.frame };
  }

  /** Copies the canvas, scaled down to `maxW` pixels wide, into the project's thumbnail (a JPEG). */
  private copyThumbnail(maxW = 320): string | null {
    this.thumbWanted = false;
    try {
      const src = this.renderer.domElement;
      const scale = maxW / Math.max(1, src.width);
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.7);
      this.thumb = { url, revision: this.canvasRevision, frame: this.canvasFrames };
      return url;
    } catch {
      return null;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    if (this.thumbRead) {
      const gl = this.renderer.getContext?.() as WebGL2RenderingContext | undefined;
      if (gl && !gl.isContextLost?.()) {
        gl.deleteSync?.(this.thumbRead.fence);
        gl.deleteBuffer?.(this.thumbRead.buffer);
      }
      this.thumbRead = null;
    }
    if (this.capture) {
      this.capture.output.dispose();
      this.capture.unpremultiply.dispose();
      this.capture.premultiply.dispose();
      this.capture.unpremultiplyShown.dispose();
      this.capture.average.dispose();
      this.capture.quad.geometry.dispose();
      this.capture.quad.material.dispose();
    }
    this.smaa?.dispose();
    this.worldEnv.dispose();
    this.dropFinalEvaluator();
    this.resizeObserver.disconnect();
    for (const d of this.disposers) d();
    this.objects.dispose();
    this.transmission.dispose();
    this.edit.dispose();
    this.composer.dispose();
    this.sky.dispose();
    this.pmrem.dispose();
    this.envTexture?.dispose();
    this.renderer.dispose();
  }
}
