import { RenderCancelledError } from './protocol';

/*
 * The frame loop of a video export segment: frames are rendered ahead on every render thread (one
 * request per thread at a time) and written in order: the server's leased render processes and the
 * browser's render workers alike. How far rendering runs ahead of
 * writing is capped by count (2 × threads by default) and by bytes (results in flight plus results
 * waiting for an earlier frame), so a slow encoder or one slow frame never piles up memory. A
 * frame whose render thread died is rendered again on another thread; when no thread is left, the
 * run ends early (`threadsLost`) once the frames already rendered are written in order, and the
 * caller goes on with new threads (the server leases new render processes). Any other render error
 * ends the run.
 */

/** What the frame loop needs of a render thread: whether it still lives (a dead one gets no item). */
export interface OrderedRenderThread {
  readonly alive: boolean;
}

export interface OrderedRenderOptions<R, T extends OrderedRenderThread = OrderedRenderThread> {
  /** Items of this run, written in order 0 … count − 1. */
  count: number;
  threads: readonly T[];
  /** Most items rendering or waiting to be written at once (at least 1). */
  maxAhead: number;
  /** Most bytes of those items (estimated with `itemBytes`; one item always runs). */
  maxBytes: number;
  /** Bytes one item's result takes. */
  itemBytes: number;
  render(index: number, thread: T): Promise<R>;
  /** Writes an item's result: called in order, one at a time (awaited). */
  write(index: number, result: R): Promise<void>;
  /**
   * Called when the render process of an item's thread died while the item was sent to it (its
   * error): return false to end the run with that error — an item that took down too many render
   * processes, whatever the thread. Default: the item is rendered again.
   */
  retryAfterDeath?(index: number, error: Error): boolean;
  /** Aborts the run (a RenderCancelledError); renders already sent finish in their threads. */
  signal?: AbortSignal;
  /**
   * Starts no item after this many milliseconds (the run then ends once the items started are
   * written; the caller continues with a new lease): bounds how long one lease is held.
   */
  stopAfterMs?: number;
}

export interface OrderedRenderResult {
  /** Items written: the first `done` items (all of them unless the run stopped early). */
  done: number;
  /** Renders sent again (to another thread) because their thread died. */
  retried: number;
  /**
   * Every leased thread's render process died: the run ended once every request sent had settled
   * and the items rendered before were written (`done`); the caller renders the rest on a new lease.
   */
  threadsLost: boolean;
  /** The errors of the requests whose render process died (in the order they came). */
  deaths: Error[];
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Renders items on the threads, ahead within the caps, and writes them in order. */
export function renderInOrder<R, T extends OrderedRenderThread = OrderedRenderThread>(
  o: OrderedRenderOptions<R, T>,
): Promise<OrderedRenderResult> {
  const { count, signal } = o;
  if (!o.threads.length) return Promise.reject(new Error('no render threads'));
  if (signal?.aborted) return Promise.reject(new RenderCancelledError());
  if (count <= 0) return Promise.resolve({ done: 0, retried: 0, threadsLost: false, deaths: [] });
  const t0 = performance.now();
  const maxAhead = Math.max(1, Math.floor(o.maxAhead));
  const itemBytes = Math.max(0, o.itemBytes);
  return new Promise<OrderedRenderResult>((resolve, reject) => {
    const idle = [...o.threads];
    const retry: number[] = [];
    const results = new Map<number, R>();
    const deaths: Error[] = [];
    let next = 0;
    let inFlight = 0;
    let written = 0;
    let writing = false;
    let stopped = false;
    /** Every leased thread died: nothing more starts; the run ends once the rest has settled. */
    let lost = false;
    let finished = false;
    let retried = 0;

    const end = (err?: unknown) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      results.clear();
      if (err !== undefined) reject(asError(err));
      else resolve({ done: written, retried, threadsLost: lost, deaths });
    };
    const onAbort = () => end(new RenderCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });

    /** Items started (or to be started again) that are not written yet. */
    const pending = () => inFlight + results.size + retry.length;
    const target = () => (stopped ? next : count);

    /** Ends the run when nothing more can happen: everything written, or the threads are gone. */
    const settle = () => {
      if (finished || writing || inFlight) return;
      if (lost || (written >= target() && !retry.length)) end();
    };

    const flush = async () => {
      if (writing || finished) return;
      writing = true;
      try {
        while (results.has(written)) {
          const r = results.get(written) as R;
          results.delete(written);
          await o.write(written, r);
          if (finished) return;
          written++;
        }
      } catch (err) {
        end(err);
        return;
      } finally {
        writing = false;
      }
      pump();
    };

    const pump = () => {
      if (finished) return;
      if (!lost) {
        if (!stopped && o.stopAfterMs !== undefined && performance.now() - t0 >= o.stopAfterMs)
          stopped = true;
        while (idle.length) {
          // a render process that died between two items gets none again (its death was no item's)
          if (!idle[0].alive) {
            idle.shift();
            continue;
          }
          let i: number;
          if (retry.length) {
            i = retry.shift()!;
            retried++;
          } else {
            if (next >= target()) break;
            const ahead = pending();
            if (ahead >= maxAhead) break;
            if (ahead > 0 && (ahead + 1) * itemBytes > o.maxBytes) break;
            i = next++;
          }
          const t = idle.shift()!;
          inFlight++;
          let call: Promise<R>;
          try {
            call = o.render(i, t);
          } catch (err) {
            end(err);
            return;
          }
          call.then(
            (r) => {
              if (finished) return;
              inFlight--;
              idle.push(t);
              results.set(i, r);
              // while an earlier frame is being written (ffmpeg may be slow to take it), the
              // threads go on rendering ahead, within the caps
              if (writing) pump();
              else void flush();
            },
            (err: unknown) => {
              if (finished) return;
              inFlight--;
              // an error of the render itself (bad data) would happen on any thread: give up
              if (t.alive) return end(err);
              const e = asError(err);
              deaths.push(e);
              if (o.retryAfterDeath && !o.retryAfterDeath(i, e)) return end(e);
              // its render process died: the item goes to another thread, or to the next lease
              retry.push(i);
              pump();
            },
          );
        }
        // work left and no thread to do it: the run ends once the requests sent have settled
        if (!inFlight && written < target() && !o.threads.some((x) => x.alive)) lost = true;
      }
      settle();
    };
    pump();
  });
}
