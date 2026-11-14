import { chooseEncoding, type ConfigProbe, browserConfigProbe } from './codec';

/*
 * Whether this browser can export video on this device, and why not: the export needs a secure
 * page (WebCodecs and the Origin Private File System exist only there), Web Workers, WebCodecs'
 * VideoEncoder and VideoFrame, and an H.264 encoder that takes the export's size and frame rate.
 */

/** Why a browser export failed or could not start. */
export type BrowserExportErrorCode =
  /** The parameters are not valid (core's schema, or the plan refused them). */
  | 'INVALID_PARAMS'
  /** A shot or camera the parameters name is not in the snapshot. */
  | 'NOT_FOUND'
  /** This browser cannot export (see browserExportSupport). */
  | 'UNSUPPORTED'
  /** Not even one render worker fits the tab's memory. */
  | 'OUT_OF_MEMORY'
  /** The export was cancelled (its AbortSignal). */
  | 'CANCELLED'
  /** Anything else (a render, an encoder or the storage failed). */
  | 'FAILED';

export class BrowserExportError extends Error {
  constructor(
    message: string,
    readonly code: BrowserExportErrorCode,
  ) {
    super(message);
    this.name = 'BrowserExportError';
  }
}

/** The environment the check reads (the page's globals; replaced in unit tests). */
export interface SupportEnvironment {
  secure: boolean;
  workers: boolean;
  webCodecs: boolean;
  probe: ConfigProbe;
}

function pageEnvironment(): SupportEnvironment {
  const g = globalThis as {
    isSecureContext?: boolean;
    Worker?: unknown;
    VideoEncoder?: unknown;
    VideoFrame?: unknown;
  };
  return {
    secure: g.isSecureContext !== false,
    workers: typeof g.Worker === 'function',
    webCodecs: typeof g.VideoEncoder === 'function' && typeof g.VideoFrame === 'function',
    probe: browserConfigProbe,
  };
}

/** Video sizes are even (4:2:0 chroma); the export rounds them up the same way. */
const even = (v: number) => Math.max(2, Math.ceil(Math.round(v) / 2) * 2);

/**
 * Whether this browser can export a video of this size and frame rate on this device; `reason` says
 * why not, in words for the user.
 */
export async function browserExportSupport(
  opts: { width: number; height: number; fps: number },
  env: SupportEnvironment = pageEnvironment(),
): Promise<{ available: boolean; reason: string | null }> {
  if (!env.secure)
    return {
      available: false,
      reason:
        'Exporting video in the browser needs a secure page (HTTPS, or localhost): this page was opened over plain HTTP, where browsers do not offer the video encoder.',
    };
  if (!env.workers)
    return {
      available: false,
      reason: 'This browser cannot run Web Workers, which render the frames of a video export.',
    };
  if (!env.webCodecs)
    return {
      available: false,
      reason:
        'This browser has no WebCodecs video encoder (VideoEncoder), which a video export needs: use a current version of Chrome, Edge, Firefox or Safari.',
    };
  const width = even(opts.width);
  const height = even(opts.height);
  const fps = opts.fps > 0 && Number.isFinite(opts.fps) ? opts.fps : 24;
  const encoding = await chooseEncoding('h264', { width, height, fps, quality: 'standard' }, env.probe);
  if (!encoding)
    return {
      available: false,
      reason: `This browser cannot encode H.264 video of ${width}×${height} at ${Math.round(fps * 1000) / 1000} fps (its encoder takes none of the High, Main and Baseline profiles at that size): lower the resolution or the frame rate.`,
    };
  return { available: true, reason: null };
}
