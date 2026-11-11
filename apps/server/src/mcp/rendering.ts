import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SceneDoc } from '@3d-editor/core';
import { isNotImplemented } from '../api/projects';
import { RenderRequestError, isCancelled, isOutOfMemory, type RenderProgress } from '../render';
import { errorMessage } from '../observability/tracing';
import { RpcError, type Room, type RpcAnswer, type SyncConnection } from '../sync/room';
import { ToolError } from './agent';
import { MAX_EDITOR_WAIT_MS } from './editor-commands';
import { BROWSER_RASTER_SECONDS, measuredBrowserImages } from './editor-costs';

/*
 * Shared pieces of the rendering tools (render_image, render_animation): option schemas,
 * progress notifications, frame sizing and error mapping.
 */

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Default sampling time budget of a path traced still (seconds). */
export const DEFAULT_IMAGE_TIME_LIMIT = 30;
/** Default time budget of a whole animation render (seconds). */
export const DEFAULT_ANIMATION_TIME_LIMIT = 60;
/** Most seconds a render may be given. */
export const MAX_TIME_LIMIT = 600;
/** Largest frame side of render_animation. */
export const MAX_ANIMATION_SIZE = 2048;
/** Most frames of one render_animation call. */
export const MAX_RENDER_FRAMES = 1000;

/**
 * How long render_image waits for a RASTER image of a browser editor with renderer 'browser' (ms):
 * an editor without GPU acceleration (software WebGL, e.g. a headless browser) takes tens of
 * seconds for a heavy scene. Measured in headless Chromium with SwiftShader at the default 800×450
 * on a calm machine with 4 CPUs (editor-costs.ts BROWSER_RASTER_SECONDS, which says how its ranges
 * were made): the first image of a 71-material scene, as it built and compiled the materials, took
 * the longest, the next ones less, and images of 4 million triangles a few seconds; on a busy
 * machine up to BROWSER_BUSY_FACTOR times as long. Under the 60 s default request timeout of MCP clients
 * (see {@link MAX_EDITOR_WAIT_MS}).
 */
export const BROWSER_RASTER_TIMEOUT_MS = MAX_EDITOR_WAIT_MS;
/**
 * How long render_image waits for a browser editor's RASTER image with renderer 'auto' before it
 * renders on the server instead (ms): the fallback must stay fast.
 */
export const AUTO_BROWSER_RASTER_TIMEOUT_MS = 15_000;
/** Time a browser editor's path trace gets beyond its time_limit: loading, compiling, denoising, the PNG (ms). */
export const BROWSER_PATHTRACE_EXTRA_MS = 30_000;
/**
 * How long renderer 'auto' renders on the server without asking an editor that was too slow for
 * its last RASTER image (ms; see {@link slowBrowserRaster}).
 */
export const SLOW_EDITOR_RETRY_MS = 120_000;

const n = (v: number): string => Math.round(v).toLocaleString('en-US');

/** RASTER images render_image asked of each browser editor: when, and how many pixels. */
const rasterRequests = new WeakMap<SyncConnection, { sentAt: number; pixels: number }[]>();
/** Requests remembered per editor (the last ones). */
const RASTER_REQUESTS_KEPT = 16;
/** How far apart the noted time of a request and the time the room recorded for it may be (ms). */
const SENT_AT_SLACK_MS = 1000;

/**
 * Notes the size of a RASTER image render_image is about to ask `conn` for, so that
 * {@link slowBrowserRaster} can scale the time of a slow image to the size of the next one.
 */
export function noteBrowserRaster(
  conn: SyncConnection,
  width: number,
  height: number,
  now = Date.now(),
): void {
  let list = rasterRequests.get(conn);
  if (!list) rasterRequests.set(conn, (list = []));
  list.push({ sentAt: now, pixels: Math.max(1, width * height) });
  if (list.length > RASTER_REQUESTS_KEPT) list.shift();
}

/** The pixels of the RASTER image `conn` was asked for at `sentAt` (null when it was not noted). */
function notedPixels(conn: SyncConnection, sentAt: number): number | null {
  let best: { sentAt: number; pixels: number } | null = null;
  for (const r of rasterRequests.get(conn) ?? [])
    if (
      Math.abs(r.sentAt - sentAt) <= SENT_AT_SLACK_MS &&
      (!best || Math.abs(r.sentAt - sentAt) < Math.abs(best.sentAt - sentAt))
    )
      best = r;
  return best?.pixels ?? null;
}

/**
 * Shortest time of an editor's RASTER image that render_image scales up to a larger image (ms): a
 * third of what 'auto' waits. Shorter images are mostly fixed costs (uploading the scene, compiling
 * its materials, reading the image back), which a larger image does not multiply.
 */
export const SCALE_UP_MIN_MS = AUTO_BROWSER_RASTER_TIMEOUT_MS / 3;

/**
 * Whether renderer 'auto' should render on the server instead of asking `conn` for a RASTER image
 * of `pixels` pixels with this `shading`, because the editor's last such image, less than
 * {@link SLOW_EDITOR_RETRY_MS} ago, says that this one would take longer than 'auto' waits
 * ({@link AUTO_BROWSER_RASTER_TIMEOUT_MS}), so that 'auto' does not wait 15 s in vain for each
 * render of an editor that is that slow: in software WebGL a RASTER image can take longer than
 * 'auto' waits (the first image of a 71-material scene, see {@link BROWSER_RASTER_TIMEOUT_MS}).
 * The editor is too slow when its last image came after the server had stopped waiting, or took
 * longer than 'auto' waits; its time is scaled to the size of this image (time per pixel;
 * render_image notes the size of the images it asks for, see {@link noteBrowserRaster}) when this
 * one is smaller: a 2048×2048 image that took 32 s does not keep a 1280×720 one, which would take
 * about 7 s, from the editor. A faster last image that took {@link SCALE_UP_MIN_MS} or longer is
 * scaled up the same way to a larger one: a 1280×720 image of 12.5 s makes a 1920×1080 one about
 * 28 s. A faster answer for an image as large (renderer 'browser' waits longer) clears it.
 * Returns why, as a clause after "the browser editor", or null.
 */
export function slowBrowserRaster(
  room: Room,
  conn: SyncConnection,
  shading: 'SOLID' | 'MATERIAL' | undefined,
  now = Date.now(),
  pixels?: number,
): string | null {
  // without a shading (or with MATERIAL) the editor draws materials and lights; SOLID is separate
  const shadings = shading === 'SOLID' ? ['SOLID'] : [undefined, 'MATERIAL'];
  const last = shadings
    .map((s) => room.lastAnswer(conn, { method: 'render', engine: 'RASTER', shading: s }))
    .filter((x): x is RpcAnswer => !!x)
    .sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!last) return null;
  if (now - (last.sentAt + last.tookMs) >= SLOW_EDITOR_RETRY_MS) return null;
  const slow = last.late || last.tookMs > AUTO_BROWSER_RASTER_TIMEOUT_MS;
  const lastPixels = notedPixels(conn, last.sentAt);
  const seconds = Math.round(last.tookMs / 1000);
  // the time of the last image scaled to the size of this one: a smaller image after a slow one
  // (one as large or larger takes at least as long), a larger one after a fast one that took long
  // enough not to be mostly fixed costs
  if (
    pixels !== undefined &&
    lastPixels !== null &&
    (slow ? pixels < lastPixels : pixels > lastPixels && last.tookMs >= SCALE_UP_MIN_MS)
  ) {
    const expected = (last.tookMs * pixels) / lastPixels;
    if (expected <= AUTO_BROWSER_RASTER_TIMEOUT_MS) return null;
    return (
      `needed ${seconds} s for its last RASTER image (${n(lastPixels)} pixels), about ${Math.round(expected / 1000)} s ` +
      `for this image's ${n(pixels)} pixels, longer than renderer 'auto' waits (${AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000} s)`
    );
  }
  if (!slow) return null;
  return last.late
    ? `answered its last RASTER image after ${seconds} s, when the server had stopped waiting for it`
    : `needed ${seconds} s for its last RASTER image, longer than renderer 'auto' waits (${AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000} s)`;
}

/** How long render_image waits for a browser editor's image (ms). */
export function browserRenderTimeout(
  renderer: 'auto' | 'browser',
  pathTrace: boolean,
  timeLimitSeconds: number,
): number {
  if (pathTrace) return timeLimitSeconds * 1000 + BROWSER_PATHTRACE_EXTRA_MS;
  return renderer === 'browser' ? BROWSER_RASTER_TIMEOUT_MS : AUTO_BROWSER_RASTER_TIMEOUT_MS;
}

/** A browser editor's render that failed (render_image), for {@link browserRenderFailure}. */
export interface BrowserRender {
  renderer: 'auto' | 'browser';
  pathTrace: boolean;
  /** How long the server waited (ms). */
  timeoutMs: number;
  /** Path tracing: the time_limit (seconds). */
  timeLimit: number;
  /** The `shading` argument (SOLID is the fast grey clay look already). */
  shading?: 'SOLID' | 'MATERIAL';
  /**
   * The earlier request the editor was still busy with when this render was sent (one the server
   * had stopped waiting for, see describeLateRpcs).
   */
  busy?: string | null;
}

/**
 * Why a browser editor's render failed and what to do instead: `reason` for the error (renderer
 * 'browser') and for the `note` of the server render that replaces it (renderer 'auto'), `advice`
 * for the error. A timeout says how long the server waited, that the editor may still be drawing
 * the image (it holds up the editor's next requests: 'auto' renders on the server meanwhile) and
 * the earlier request the editor was still busy with.
 */
export function browserRenderFailure(err: unknown, r: BrowserRender): { reason: string; advice: string } {
  // the editor's message may end a sentence: the error puts '. ' and the advice after the reason
  if (!(err instanceof RpcError && err.code === 'TIMEOUT'))
    return {
      reason: `browser render failed: ${errorMessage(err).replace(/[.\s]+$/, '')}`,
      advice: "Use renderer 'software' to render on the server.",
    };
  const seconds = Math.round(r.timeoutMs / 1000);
  const busy = r.busy
    ? ` (it was still busy with an earlier request that the server had stopped waiting for: ${r.busy})`
    : '';
  if (r.pathTrace)
    return {
      reason:
        `browser render failed: the editor did not finish path tracing within ${seconds} s ` +
        `(time_limit ${r.timeLimit} s + ${BROWSER_PATHTRACE_EXTRA_MS / 1000} s for loading, compiling and denoising)${busy}`,
      advice:
        'Its render workers may still be busy with it. ' +
        "Path trace on the server with renderer 'software' or 'auto' (all its CPU cores), or lower time_limit or the image size.",
    };
  if (r.renderer === 'auto')
    return {
      reason:
        `browser render failed: the editor did not finish the RASTER image within ${seconds} s ` +
        `(renderer 'auto' waits ${seconds} s before it renders on the server; renderer 'browser' waits ` +
        `${BROWSER_RASTER_TIMEOUT_MS / 1000} s)${busy}; it may still be drawing it, and until it has, ` +
        "renderer 'auto' renders on the server without asking it",
      advice: '',
    };
  return {
    reason: `browser render failed: the editor did not finish the RASTER image within ${seconds} s${busy}`,
    advice:
      'It may still be drawing it, and its next renders and commands wait until it has. An editor without GPU ' +
      `acceleration (e.g. a headless browser) took ${measuredBrowserImages(BROWSER_RASTER_SECONDS)}, and ` +
      'longer for heavier scenes: ' +
      (r.shading === 'SOLID'
        ? "render on the server with renderer 'software' (or 'auto') or render a smaller image."
        : "render on the server with renderer 'software' (or 'auto'), render a smaller image, or pass shading 'SOLID' (grey clay, faster)."),
  };
}

/** How often a request that waits for a browser editor sends a progress notification (ms). */
export const KEEP_ALIVE_MS = 5000;

/** `engine` argument of the rendering tools. */
export const engineArg = z
  .enum(['RASTER', 'PATHTRACER'])
  .optional()
  .describe(
    "Render engine (default: the scene's render engine, see set_scene_settings). RASTER: fast rasterizer (no shadows), " +
      'good for checking layout; PATHTRACER: physically based CPU path tracer (soft shadows, global illumination, ' +
      'reflections, glass, sky, mist, AgX view transform) running in parallel on all server CPU cores — use it for final renders',
  );

/** `samples` argument: samples per pixel (path tracer) or anti-aliasing (raster). */
export const samplesArg = z
  .number()
  .int()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    'PATHTRACER: samples per pixel (default: the render settings samples, 64; 16–32 for previews, 128+ for clean finals). ' +
      "RASTER: anti-aliasing supersampling 1, 2 or 4 (default 2) of the server's rasterizer; a browser editor's RASTER " +
      "image ignores it (WebGL: 8 samples, or the GPU's maximum: 4 in software WebGL; where the viewport drew that " +
      'shading only without multisampling, or has not drawn it while its multisampling is off: 5 pictures averaged ' +
      'when the first took at most 1 s, else SMAA)',
  );

/**
 * `samples` of render_animation, which renders on the server only: what a browser editor does with
 * `samples` (samplesArg) does not apply.
 */
export const animationSamplesArg = z
  .number()
  .int()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    'PATHTRACER: samples per pixel of each frame (default: the render settings samples, 64; keep it small for ' +
      "many frames). RASTER: anti-aliasing supersampling 1, 2 or 4 (default 2) of the server's rasterizer",
  );

/** `max_bounces` argument (path tracer). */
export const maxBouncesArg = z
  .number()
  .int()
  .min(0)
  .max(64)
  .optional()
  .describe(
    'PATHTRACER: maximum light bounces of any kind (default: render settings max_bounces; 0 = direct light only)',
  );

/** `denoise` argument (path tracer). */
export const denoiseArg = z
  .boolean()
  .optional()
  .describe('PATHTRACER: denoise the result (default: render settings use_denoising)');

/** `seed` argument (path tracer noise pattern). */
export const seedArg = z
  .number()
  .int()
  .min(0)
  .max(2 ** 31 - 1)
  .optional()
  .describe('PATHTRACER: noise pattern seed (default 0; the same seed and settings give the same image)');

/**
 * Sends MCP progress notifications when the client asked for them (a progress token); throttled,
 * and the progress value only grows.
 */
export function progressReporter(extra: ToolExtra): ((p: RenderProgress) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let last = 0;
  let lastProgress = -1;
  return (p) => {
    const t = Date.now();
    if (p.progress <= lastProgress) return;
    if (t - last < 250 && p.progress < p.total) return;
    last = t;
    lastProgress = p.progress;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: p.progress, total: p.total, message: p.message },
      })
      .catch(() => undefined);
  };
}

/**
 * While a request waits for a browser editor (which sends no progress of its own), sends a progress
 * notification every {@link KEEP_ALIVE_MS} (only when the client asked for progress), so clients
 * that reset their request timeout on progress keep waiting. `at` gives the notification after a
 * number of seconds: the whole seconds since the request started, and at least the intervals that
 * have passed (Node counts a timer from the event loop's time, which can be some milliseconds
 * earlier than Date.now() when the timer is set, so the first notification could otherwise say
 * 4 s). Returns the function that stops it.
 */
export function keepAlive(extra: ToolExtra, at: (seconds: number) => RenderProgress): () => void {
  const progress = progressReporter(extra);
  if (!progress) return () => undefined;
  const t0 = Date.now();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    progress(at(Math.max((ticks * KEEP_ALIVE_MS) / 1000, Math.floor((Date.now() - t0) / 1000))));
  }, KEEP_ALIVE_MS);
  return () => clearInterval(timer);
}

/**
 * Frame size of an animation render: the render resolution (× percentage) scaled to fit `fit`
 * pixels when neither side is given, else the given side(s) keeping the render aspect, at most
 * MAX_ANIMATION_SIZE (same rule as the render.render_animation operator).
 */
export function animationFrameSize(
  doc: SceneDoc,
  width: number | undefined,
  height: number | undefined,
  fit: number,
): { width: number; height: number } {
  const rs = doc.getRender();
  const pct = (rs.resolution_percentage > 0 ? rs.resolution_percentage : 100) / 100;
  const fw = Math.max(1, rs.resolution_x * pct || 1);
  const fh = Math.max(1, rs.resolution_y * pct || 1);
  const aspect = fw / fh;
  let w = width;
  let h = height;
  if (!w && !h) {
    const s = Math.min(1, fit / Math.max(fw, fh));
    w = fw * s;
    h = fh * s;
  } else if (!h) h = w! / aspect;
  else if (!w) w = h * aspect;
  const s = Math.min(1, MAX_ANIMATION_SIZE / Math.max(w!, h!));
  return {
    width: Math.max(1, Math.min(MAX_ANIMATION_SIZE, Math.round(w! * s))),
    height: Math.max(1, Math.min(MAX_ANIMATION_SIZE, Math.round(h! * s))),
  };
}

/**
 * What a server render evaluates, whatever it shows: core SceneEvaluator.evaluate(frame, {forRender})
 * evaluates every mesh, curve and text object, hidden from renders or not (hide_render only leaves
 * it out of the image), with the render settings of its modifiers (SUBSURF render_levels).
 */
const SERVER_RENDER_EVALUATES =
  'A server render loads and evaluates every mesh of the scene with its modifiers at their render ' +
  'settings, also meshes hidden from renders (hide_render): lower the render levels (render_levels) of ' +
  'Subdivision Surface modifiers or the number of particle instances, delete meshes the project no ' +
  'longer needs';

/**
 * What to do when a render_image render needed more memory than the server gives it (a
 * RenderOutOfMemoryError: its render process ran out of memory; a render that single-thread mode
 * did not start gets {@link SINGLE_THREAD_RENDER_ADVICE}).
 */
export const OUT_OF_MEMORY_ADVICE =
  `The scene needs more memory than a server render has. ${SERVER_RENDER_EVALUATES}, or render in a ` +
  "browser editor that has the project open (renderer 'browser').";

/** The same for render_animation, which renders on the server only. */
export const ANIMATION_OUT_OF_MEMORY_ADVICE =
  `The scene needs more memory than a server render has. ${SERVER_RENDER_EVALUATES}, or render its ` +
  "frames one by one with render_image {frame, renderer: 'browser'} in a browser editor that has the " +
  'project open.';

/**
 * The same for export_scene (and the REST export), which exports in a render process. Every export
 * evaluates the whole scene at render settings before it picks what to write (core collectExport),
 * so `objects` and apply_modifiers: false lower only the memory of writing the file; OBJ, STL and
 * PLY write a copy of each instance and took more memory than GLB.
 */
export const EXPORT_OUT_OF_MEMORY_ADVICE =
  'The export needs more memory than a render process has. An export loads and evaluates every mesh of ' +
  'the scene with its modifiers at their render settings, whichever objects it writes and also with ' +
  'apply_modifiers: false: lower the render levels (render_levels) of Subdivision Surface modifiers or ' +
  'delete meshes the project no longer needs. Writing the file needs memory too, less with fewer ' +
  "objects (objects), base meshes (apply_modifiers: false), fewer particle instances or format 'glb'.";

/** The advice of each tool's out-of-memory error, by the `what` it starts with. */
const OUT_OF_MEMORY_ADVICE_BY_TOOL: Readonly<Record<string, string>> = {
  Rendering: OUT_OF_MEMORY_ADVICE,
  'Rendering the animation': ANIMATION_OUT_OF_MEMORY_ADVICE,
  Export: EXPORT_OUT_OF_MEMORY_ADVICE,
};

/**
 * What single-thread mode checks before a render or export starts in the server's own process
 * (render/memory.ts checkMainThreadRender, a RenderOutOfMemoryError with reason 'refused'): its
 * estimate (estimateRenderMemory) counts the meshes shown in renders by their stored counts, with
 * their modifiers enabled for renders at their render settings. Meshes hidden from renders
 * (hide_render) and modifiers turned off for renders (show_render) are left out, and so are curves,
 * text and particle and collection instances: hiding the heavy mesh from renders lets the render
 * start (its evaluation in the server's process is capped by the server's own guards, which skip a
 * modifier that would not fit, see installGeometryMemoryGuard).
 */
const SINGLE_THREAD_COUNTS =
  'The check counts the meshes shown in renders, with their modifiers at their render settings';

/** What to do when single-thread mode refused a render_image render. */
export const SINGLE_THREAD_RENDER_ADVICE =
  `${SINGLE_THREAD_COUNTS}: lower the render levels (render_levels) of Subdivision Surface modifiers or ` +
  'turn modifiers off for renders (show_render), hide meshes from renders (hide_render) or delete meshes the ' +
  "project no longer needs, or render in a browser editor that has the project open (renderer 'browser').";

/** The same for render_animation, which renders on the server only. */
export const SINGLE_THREAD_ANIMATION_ADVICE =
  `${SINGLE_THREAD_COUNTS}: lower the render levels (render_levels) of Subdivision Surface modifiers or ` +
  'turn modifiers off for renders (show_render), hide meshes from renders (hide_render) or delete meshes the ' +
  "project no longer needs, or render the frames one by one with render_image {frame, renderer: 'browser'} " +
  'in a browser editor that has the project open.';

/**
 * The same for export_scene: the estimate does not depend on `objects` or apply_modifiers, and an
 * export without `objects` writes the objects shown in renders only (core collectExport).
 */
export const SINGLE_THREAD_EXPORT_ADVICE =
  `${SINGLE_THREAD_COUNTS}, whichever objects the export writes and also with apply_modifiers: false: lower ` +
  'the render levels (render_levels) of Subdivision Surface modifiers or turn modifiers off for renders ' +
  '(show_render), hide meshes from renders (hide_render: an export without objects leaves them out of the ' +
  'file) or delete meshes the project no longer needs.';

/** The advice of each tool's refusal in single-thread mode, by the `what` it starts with. */
const SINGLE_THREAD_ADVICE_BY_TOOL: Readonly<Record<string, string>> = {
  Rendering: SINGLE_THREAD_RENDER_ADVICE,
  'Rendering the animation': SINGLE_THREAD_ANIMATION_ADVICE,
  Export: SINGLE_THREAD_EXPORT_ADVICE,
};

/**
 * Converts render failures to tool errors with a useful message. A render that ran out of memory
 * says so with a stable start, "<what> failed: out of memory: …", that the server keeps running and
 * what to do instead (the advice of the tool, see OUT_OF_MEMORY_ADVICE_BY_TOOL), with code
 * OUT_OF_MEMORY (the tools print it as JSON on the next line). One that single-thread mode did not
 * start ("… was not started: …", reason 'refused') gets the advice of that mode instead
 * (SINGLE_THREAD_ADVICE_BY_TOOL): there, unlike in a render process, a mesh hidden from renders
 * does not count. One that only shared its render process with the render that ran it out of
 * memory starts "<what> failed: interrupted: …" and says it can run again.
 */
export function renderToolError(
  err: unknown,
  what = 'Rendering',
  advice = OUT_OF_MEMORY_ADVICE_BY_TOOL[what] ?? OUT_OF_MEMORY_ADVICE,
): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof RenderRequestError) return new ToolError(err.message);
  if (isCancelled(err)) return new ToolError(`${what} was cancelled.`);
  // another render that shared the render process ran it out of memory: this one can run again
  if (isOutOfMemory(err) && err.reason === 'shared')
    return new ToolError(`${what} failed: ${err.message}.`, 'FAILED');
  if (isOutOfMemory(err) && err.reason === 'refused')
    return new ToolError(
      `${what} failed: ${err.message}. ${SINGLE_THREAD_ADVICE_BY_TOOL[what] ?? SINGLE_THREAD_RENDER_ADVICE}`,
      'OUT_OF_MEMORY',
    );
  if (isOutOfMemory(err)) return new ToolError(`${what} failed: ${err.message}. ${advice}`, 'OUT_OF_MEMORY');
  if (isNotImplemented(err))
    return new ToolError(`${what} is not available in this build (${errorMessage(err)}).`);
  return new ToolError(`${what} failed: ${errorMessage(err)}`);
}
