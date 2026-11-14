import type { FrameMeta } from '@3d-editor/core';
import { lastBrowserExportStats, setBrowserExportOptions, type BrowserExportStats } from './index';

/*
 * The browser export's part of the page's debugging hook (window.__editor.export, main.tsx): the
 * raw pass digests and the metadata of the frames the next exports render (the end-to-end parity
 * check compares them with the frames core renders in Node, as the server's render processes do)
 * and how the last export ran.
 */

/** A rendered frame as the parity check sees it. */
export interface DebugFrame {
  /** SHA-256 of each raw pass ('beauty' the RGBA image, 'mask' the palette indices …). */
  digests: Record<string, string>;
  meta: FrameMeta | null;
}

export interface ExportDebugHook {
  /** Starts (or stops) collecting the frames of the next exports. */
  collectFrames(on: boolean): void;
  /** The frames collected by `${shot}:${frame}` (output frame of the shot, 0-based). */
  frames(): Record<string, DebugFrame>;
  /** How the last export ran: render workers, frames per second, seconds. */
  stats(): BrowserExportStats | null;
}

export function exportDebugHook(): ExportDebugHook {
  let collected: Record<string, DebugFrame> = {};
  return {
    collectFrames(on) {
      collected = {};
      setBrowserExportOptions(
        on
          ? {
              digests: (shot, k, digests, meta) => {
                collected[`${shot}:${k}`] = { digests, meta };
              },
            }
          : {},
      );
    },
    frames: () => ({ ...collected }),
    stats: () => lastBrowserExportStats(),
  };
}
