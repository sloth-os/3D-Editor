import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SceneDoc } from '@3d-editor/core';
import { isNotImplemented } from '../api/projects';
import { RenderRequestError, isCancelled, type RenderProgress } from '../render';
import { errorMessage } from '../observability/tracing';
import { RpcError, type Room, type RpcAnswer, type SyncConnection } from '../sync/room';
import { ToolError } from './agent';
import { MAX_EDITOR_WAIT_MS } from './editor-commands';

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
 * seconds for a heavy scene. Measured in headless Chromium with SwiftShader at the default 800×450:
 * the first image of a 71-material scene took 21.9–26.7 s, as it built and compiled the materials,
 * and the next ones 3.7–4.7 s; images of 4 million triangles took 4.6–10.2 s. Under the 60 s
 * default request timeout of MCP clients (see {@link MAX_EDITOR_WAIT_MS}).
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

/**
 * Whether renderer 'auto' should render on the server instead of asking `conn` for a RASTER image
 * with this `shading`: the editor's last such image came after the server had stopped waiting, or
 * took longer than 'auto' waits ({@link AUTO_BROWSER_RASTER_TIMEOUT_MS}), less than
 * {@link SLOW_EDITOR_RETRY_MS} ago, so that 'auto' does not wait 15 s in vain for each render of an
 * editor that stays that slow: in software WebGL a RASTER image can take longer than 'auto' waits
 * (the first image of a 71-material scene, see {@link BROWSER_RASTER_TIMEOUT_MS}). A faster answer
 * (renderer 'browser' waits longer) clears it.
 * Returns why, as a clause after "the browser editor", or null.
 */
export function slowBrowserRaster(
  room: Room,
  conn: SyncConnection,
  shading: 'SOLID' | 'MATERIAL' | undefined,
  now = Date.now(),
): string | null {
  // without a shading (or with MATERIAL) the editor draws materials and lights; SOLID is separate
  const shadings = shading === 'SOLID' ? ['SOLID'] : [undefined, 'MATERIAL'];
  const last = shadings
    .map((s) => room.lastAnswer(conn, { method: 'render', engine: 'RASTER', shading: s }))
    .filter((x): x is RpcAnswer => !!x)
    .sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!last || !(last.late || last.tookMs > AUTO_BROWSER_RASTER_TIMEOUT_MS)) return null;
  if (now - (last.sentAt + last.tookMs) >= SLOW_EDITOR_RETRY_MS) return null;
  const seconds = Math.round(last.tookMs / 1000);
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
  if (!(err instanceof RpcError && err.code === 'TIMEOUT'))
    return {
      reason: `browser render failed: ${errorMessage(err)}`,
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
      'It may still be drawing it, and its next renders and commands wait until it has. ' +
      'A heavy scene takes tens of seconds in an editor without GPU acceleration (software WebGL, e.g. a headless browser): ' +
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
      'RASTER: anti-aliasing supersampling 1, 2 or 4 (default 2)',
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

/** Converts render failures to tool errors with a useful message. */
export function renderToolError(err: unknown, what = 'Rendering'): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof RenderRequestError) return new ToolError(err.message);
  if (isCancelled(err)) return new ToolError(`${what} was cancelled.`);
  if (isNotImplemented(err))
    return new ToolError(`${what} is not available in this build (${errorMessage(err)}).`);
  return new ToolError(`${what} failed: ${errorMessage(err)}`);
}
