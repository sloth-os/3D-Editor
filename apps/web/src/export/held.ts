/*
 * The memory the browser exports of this tab hold, for every other render that plans its memory in
 * the tab (render/memory.ts TabMemory.held): another export (engine.ts) and the path traced and
 * RASTER renders (render/path-trace.ts). An export holds an estimate of its first render worker from
 * the moment that worker starts (it applies the snapshot and plans the export), then its plan (its
 * share of the page and its render workers, memory.ts) until it ends, fails or is cancelled. A
 * finished export whose files stay in memory (no Origin Private File System: store.ts MemoryStore)
 * holds their bytes until it is released. Nothing is imported here, so the render modules can read
 * it.
 */

/** Bytes a render holds in all, and of them in JavaScript heaps. */
export interface HeldMemory {
  total: number;
  heap: number;
  /**
   * Of `total`, the files of finished exports kept in memory until they are released (Blobs: none of
   * it in a JavaScript heap).
   */
  kept?: number;
}

const held = new Map<string, HeldMemory>();

/**
 * Records what export `id` holds, in place of what it held so far, until the returned function is
 * called (which does nothing once a later call for `id` has replaced it).
 */
export function holdExportMemory(id: string, m: HeldMemory): () => void {
  const entry: HeldMemory = { total: Math.max(0, m.total), heap: Math.max(0, m.heap) };
  const kept = Math.min(entry.total, Math.max(0, m.kept ?? 0));
  if (kept > 0) entry.kept = kept;
  held.set(id, entry);
  return () => {
    if (held.get(id) === entry) held.delete(id);
  };
}

/**
 * Records that the files of finished export `id`, `bytes` in all, stay in memory until the returned
 * function is called (in place of what the export held while it ran).
 */
export function holdExportFiles(id: string, bytes: number): () => void {
  return holdExportMemory(id, { total: bytes, heap: 0, kept: bytes });
}

/**
 * What the browser exports of this tab hold, but export `except`: those running (their plans) and the
 * files of finished ones kept in memory (`kept`, part of `total`).
 */
export function exportsHeld(except?: string): Required<HeldMemory> {
  const out = { total: 0, heap: 0, kept: 0 };
  for (const [id, m] of held)
    if (id !== except) {
      out.total += m.total;
      out.heap += m.heap;
      out.kept += m.kept ?? 0;
    }
  return out;
}
