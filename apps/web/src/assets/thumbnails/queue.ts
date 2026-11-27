/*
 * The thumbnails waiting for a worker, on the page (where a tile that leaves the view takes its
 * thumbnail out again): tiles on screen go before tiles just outside it (the next screenful the
 * browser watches), first come first served among equals.
 */

/** How soon a tile wants its thumbnail: it is on screen, or near it. */
export type ThumbnailPriority = 'visible' | 'near';

const RANK: Record<ThumbnailPriority, number> = { visible: 0, near: 1 };

/** The higher of two priorities. */
export const higherPriority = (a: ThumbnailPriority, b: ThumbnailPriority): ThumbnailPriority =>
  RANK[a] <= RANK[b] ? a : b;

interface Queued<T> {
  value: T;
  priority: ThumbnailPriority;
  /** Order of arrival (the first add's). */
  seq: number;
}

export class ThumbnailQueue<T> {
  private readonly jobs = new Map<string, Queued<T>>();
  private seq = 0;
  /** Arrival numbers of jobs put back at the front (before every other one). */
  private front = -1;

  /** Jobs waiting. */
  get size(): number {
    return this.jobs.size;
  }

  has(key: string): boolean {
    return this.jobs.has(key);
  }

  /**
   * Queues `value` as `key`; a key already queued keeps its place and gets `priority`. `first` puts
   * a new job before every other one of its priority (a render that was interrupted).
   */
  add(key: string, value: T, priority: ThumbnailPriority, first = false): void {
    const job = this.jobs.get(key);
    if (job) {
      job.value = value;
      job.priority = priority;
    } else this.jobs.set(key, { value, priority, seq: first ? this.front-- : this.seq++ });
  }

  /** Changes the priority of a queued job (false: not queued). */
  setPriority(key: string, priority: ThumbnailPriority): boolean {
    const job = this.jobs.get(key);
    if (!job) return false;
    job.priority = priority;
    return true;
  }

  /** Takes `key` out of the queue (false: not queued). */
  remove(key: string): boolean {
    return this.jobs.delete(key);
  }

  /** The next job (visible before near, then by arrival), taken out of the queue; null when empty. */
  take(): { key: string; value: T } | null {
    let best: [string, Queued<T>] | null = null;
    for (const entry of this.jobs) {
      const [, job] = entry;
      if (
        !best ||
        RANK[job.priority] < RANK[best[1].priority] ||
        (RANK[job.priority] === RANK[best[1].priority] && job.seq < best[1].seq)
      )
        best = entry;
    }
    if (!best) return null;
    this.jobs.delete(best[0]);
    return { key: best[0], value: best[1].value };
  }

  /** The queued keys in the order they would be taken. */
  order(): string[] {
    return [...this.jobs]
      .sort(([, a], [, b]) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq)
      .map(([k]) => k);
  }

  /** Empties the queue, returning what it held. */
  clear(): T[] {
    const values = [...this.jobs.values()].map((j) => j.value);
    this.jobs.clear();
    return values;
  }
}
