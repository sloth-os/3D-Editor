import os from 'node:os';

/*
 * CPU priority of the render threads. Long renders keep every render thread busy (one per core,
 * plus one for quick raster renders), so without help the main thread — HTTP requests, sync rooms,
 * MCP sessions, health checks — and V8's garbage collector helper threads compete for the cores
 * with them: a 50 ms burst of main-thread work (writing a large tool result) or a full garbage
 * collection then takes several times as long, and /healthz answered in hundreds of milliseconds
 * under combined render load. Render threads therefore run at a lower priority (nice 10): they
 * still use every core the main thread leaves idle, so renders are not slower on an otherwise
 * idle server, but the event loop gets a core as soon as it has work.
 */

/** Nice value of the render threads (the main thread keeps the process's, normally 0). */
export const RENDER_THREAD_NICE = 10;

/**
 * Lowers the CPU priority of the calling thread to `nice` (never raises it). Only on Linux, where
 * the nice value belongs to each thread; elsewhere (macOS, Windows) it would change the whole
 * process, main thread included, so nothing is done. Returns the thread's nice value afterwards,
 * or null when it was not changed.
 */
export function lowerThreadPriority(
  nice = RENDER_THREAD_NICE,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform !== 'linux') return null;
  try {
    if (os.getPriority() < nice) os.setPriority(nice);
    return os.getPriority();
  } catch {
    // not permitted (seccomp profiles) or not supported: render at the inherited priority
    return null;
  }
}
