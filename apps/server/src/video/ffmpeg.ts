import { execFile } from 'node:child_process';

/*
 * The ffmpeg executable of video exports (FFMPEG_PATH, default `ffmpeg` on the PATH).
 */

/** How long `ffmpeg -version` may take before ffmpeg counts as missing. */
const VERSION_TIMEOUT_MS = 5000;

/** The executable when none is given: FFMPEG_PATH, else `ffmpeg` on the PATH. */
export function defaultFfmpegPath(env: Record<string, string | undefined> = process.env): string {
  return env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

const checks = new Map<string, Promise<boolean>>();

/**
 * Whether `path` runs as ffmpeg: `ffmpeg -version` exits with 0 within 5 s. Checked once per path
 * and process (the answer is cached, also a negative one: the server checks at startup), so it is
 * cheap to ask again. Never rejects.
 */
export function hasFfmpeg(path: string = defaultFfmpegPath()): Promise<boolean> {
  let check = checks.get(path);
  if (!check) {
    check = new Promise<boolean>((resolve) => {
      try {
        execFile(path, ['-version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err) =>
          resolve(!err),
        );
      } catch {
        resolve(false);
      }
    });
    checks.set(path, check);
  }
  return check;
}

/** Forgets the cached answers of {@link hasFfmpeg} (tests that install a fake ffmpeg). */
export function clearFfmpegChecks(): void {
  checks.clear();
}
