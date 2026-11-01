import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SceneDoc } from '@3d-editor/core';
import { isNotImplemented } from '../api/projects';
import { RenderRequestError, isCancelled, type RenderProgress } from '../render';
import { errorMessage } from '../observability/tracing';
import { ToolError } from './agent';

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
