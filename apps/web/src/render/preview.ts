import { filmToRGBA8, type PathFilm, type ViewTransform } from '@3d-editor/core';

/** Display settings of a path traced film (from the prepared render). */
export interface DisplaySettings {
  exposure: number;
  viewTransform: ViewTransform;
  displayBackground: readonly [number, number, number, number] | null;
}

let scratch = new Float32Array(0);

/**
 * Converts rows [y0, y1) of a progressive film (mean of the samples so far, not denoised) to RGBA8
 * display pixels in `out` (the whole image, top row first). Rows without samples are left as they
 * are, so the preview fills in band by band.
 */
export function filmRowsToRGBA8(
  film: Pick<PathFilm, 'width' | 'height' | 'color' | 'rowSamples'>,
  y0: number,
  y1: number,
  display: DisplaySettings,
  out: Uint8ClampedArray,
): void {
  const W = film.width;
  const a = Math.max(0, Math.min(film.height, Math.floor(y0)));
  const b = Math.max(a, Math.min(film.height, Math.ceil(y1)));
  const rows = b - a;
  if (!rows || !W) return;
  const n = rows * W * 4;
  if (scratch.length < n) scratch = new Float32Array(n);
  const mean = scratch.subarray(0, n);
  for (let y = a; y < b; y++) {
    const N = film.rowSamples[y];
    const src = y * W * 4;
    const dst = (y - a) * W * 4;
    if (!N) {
      mean.fill(0, dst, dst + W * 4);
      continue;
    }
    const inv = 1 / N;
    for (let i = 0; i < W * 4; i++) mean[dst + i] = film.color[src + i] * inv;
  }
  const rgba = filmToRGBA8(mean, W, rows, display.exposure, display.viewTransform, display.displayBackground);
  for (let y = a; y < b; y++) {
    if (!film.rowSamples[y]) continue;
    const off = (y - a) * W * 4;
    out.set(rgba.subarray(off, off + W * 4), y * W * 4);
  }
}
