import { readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';

/*
 * CPU priority of the render processes, and who the kernel's out-of-memory killer picks first.
 *
 * Long renders keep every render process busy (one per core, plus one for quick raster renders),
 * so without help the server's main thread — HTTP requests, sync rooms, MCP sessions, health
 * checks — and V8's garbage collector helper threads compete for the cores with them: a 50 ms
 * burst of main-thread work (writing a large tool result) or a full garbage collection then takes
 * several times as long, and /healthz answered in hundreds of milliseconds under combined render
 * load. Render processes therefore run at a lower priority (nice 10): they still use every core
 * the server leaves idle, so renders are not slower on an otherwise idle server, but the event
 * loop gets a core as soon as it has work. RENDER_WORKER_NICE changes the value (0: the server's
 * priority).
 */

/** Nice value of the render processes (the server keeps its own, normally 0). */
export const RENDER_THREAD_NICE = 10;

/**
 * `oom_score_adj` of the render processes (Linux, -1000 to 1000): the highest, so that when the
 * machine runs out of memory the kernel's out-of-memory killer ends a render process (the server
 * answers its renders with an error and starts a new one) before the server.
 */
export const RENDER_OOM_SCORE_ADJ = 1000;

/**
 * The nice value render processes use: `RENDER_WORKER_NICE` (0–19; 0 keeps the priority of the
 * server, e.g. on a machine that only renders), default {@link RENDER_THREAD_NICE}. Render
 * processes also yield to other processes of the machine at a higher nice value; an invalid value
 * is reported in `problem` and the default is used.
 */
export function renderThreadNice(env: Record<string, string | undefined> = process.env): {
  nice: number;
  problem?: string;
} {
  const raw = env.RENDER_WORKER_NICE?.trim();
  if (!raw) return { nice: RENDER_THREAD_NICE };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 19) return { nice: n };
  return {
    nice: RENDER_THREAD_NICE,
    problem: `RENDER_WORKER_NICE must be a whole number from 0 to 19 (got '${raw}'): using ${RENDER_THREAD_NICE}`,
  };
}

/**
 * Lowers the CPU priority of the calling process to `nice` (never raises it). On Linux the nice
 * value belongs to each thread, so every thread the process has (its main thread, V8's helper
 * threads; threads started later inherit it) is lowered; elsewhere the process is. Only for render
 * processes: the server's own threads keep their priority. Returns the main thread's nice value
 * afterwards, or null when it could not be changed (not permitted, or not supported).
 */
export function lowerProcessPriority(
  nice = RENDER_THREAD_NICE,
  platform: NodeJS.Platform = process.platform,
): number | null {
  try {
    if (platform === 'linux') {
      let tids: number[];
      try {
        tids = readdirSync('/proc/self/task').map(Number);
      } catch {
        tids = [0];
      }
      for (const tid of tids) {
        try {
          if (os.getPriority(tid) < nice) os.setPriority(tid, nice);
        } catch {
          // the thread ended meanwhile
        }
      }
    } else if (os.getPriority() < nice) os.setPriority(nice);
    return os.getPriority();
  } catch {
    // not permitted (seccomp profiles) or not supported: render at the inherited priority
    return null;
  }
}

/**
 * Makes the calling process the kernel's first choice when the machine runs out of memory (Linux:
 * `/proc/self/oom_score_adj`, which any process may raise for itself). Returns whether it was set.
 */
export function preferOomKill(
  adj = RENDER_OOM_SCORE_ADJ,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'linux') return false;
  try {
    writeFileSync('/proc/self/oom_score_adj', String(adj));
    return true;
  } catch {
    return false;
  }
}
