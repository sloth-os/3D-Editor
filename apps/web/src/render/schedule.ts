/*
 * Work split of a progressive path traced render. Passes follow core `PathTracer.render` (1, 2,
 * 4, 8, then 16 samples per pixel per pass); every pass covers the whole image in bands of rows,
 * each band continuing from its own sample count, so rows left behind by a cancelled or
 * time-limited pass are evened out first. Samples are pure functions of pixel, sample index and
 * seed, so any split gives the same image as a single-threaded render.
 */

/** Pixel-samples of one band task: keeps tasks around 10–100 ms. */
export const TASK_SAMPLES = 24_576;
/** Bands per thread and pass at least (load balancing at the end of a pass). */
export const BANDS_PER_THREAD = 3;
/** Most rows of one band (bounds the tile memory and keeps the preview flowing). */
export const MAX_BAND_ROWS = 32;
/** Largest pass, in samples per pixel. */
export const MAX_PASS = 16;

/** Rows per band for a pass of `count` samples per pixel over `threads` threads. */
export function bandRows(width: number, height: number, count: number, threads: number): number {
  const bySamples = Math.ceil(TASK_SAMPLES / Math.max(1, width * count));
  const byBalance = Math.ceil(height / Math.max(1, threads * BANDS_PER_THREAD));
  return Math.max(1, Math.min(MAX_BAND_ROWS, bySamples, byBalance));
}

/** A band task: rows [y0, y1) rendered from sample `start` up to the pass target. */
export type Band = [y0: number, y1: number, start: number];

/**
 * The bands that bring every row to `target` samples per pixel. Consecutive rows with the same
 * sample count share a band (bands never mix counts); rows already at the target are skipped.
 */
export function planPass(
  rowSamples: ArrayLike<number>,
  width: number,
  target: number,
  threads: number,
): Band[] {
  const H = rowSamples.length;
  const out: Band[] = [];
  for (let y = 0; y < H;) {
    const start = rowSamples[y];
    const rows = bandRows(width, H, Math.max(1, target - start), threads);
    let end = y + 1;
    while (end < H && end - y < rows && rowSamples[end] === start) end++;
    if (start < target) out.push([y, end, start]);
    y = end;
  }
  return out;
}

/** Samples per pixel of the pass after one of `pass` samples (1, 2, 4, 8, then 16). */
export function nextPassSize(pass: number): number {
  return Math.min(Math.max(1, pass) * 2, MAX_PASS);
}

/**
 * Samples per pixel of the next pass: `pass`, at most what is left, and with a time limit at most
 * what the measured speed says still fits (0 = nothing fits any more).
 */
export function passSamples(
  pass: number,
  done: number,
  total: number,
  remainingMs: number | null,
  msPerSample: number,
): number {
  let count = Math.min(pass, total - done);
  if (remainingMs !== null && msPerSample > 0) {
    const fit = Math.floor(remainingMs / msPerSample);
    if (fit < 1) return 0;
    count = Math.min(count, fit);
  }
  return Math.max(0, count);
}
