/*
 * The memory the browser exports running in this tab hold (each export's plan: its share of the
 * page and its render workers, memory.ts), for every other render that plans its memory in the tab
 * (render/memory.ts TabMemory.held): another export (engine.ts) and the path traced and RASTER
 * renders (render/path-trace.ts). An export holds its plan from the moment it is planned until it
 * ends, fails or is cancelled. Nothing is imported here, so the render modules can read it.
 */

/** Bytes a render holds in all, and of them in JavaScript heaps. */
export interface HeldMemory {
  total: number;
  heap: number;
}

const running = new Map<string, HeldMemory>();

/** Records what export `id` holds until the returned function is called. */
export function holdExportMemory(id: string, held: HeldMemory): () => void {
  running.set(id, { total: Math.max(0, held.total), heap: Math.max(0, held.heap) });
  return () => void running.delete(id);
}

/** What the running browser exports hold, but export `except`. */
export function exportsHeld(except?: string): HeldMemory {
  const out: HeldMemory = { total: 0, heap: 0 };
  for (const [id, m] of running)
    if (id !== except) {
      out.total += m.total;
      out.heap += m.heap;
    }
  return out;
}
