import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RenderEngine } from './engine';
import { RenderCancelledError, type WorkerRequest, type WorkerResponse, type WorkerResult } from './protocol';

/*
 * A pool of render threads: worker threads running `worker.ts` (one CPU core each), or, in
 * single-thread mode (RENDER_WORKERS=0, or when workers cannot start), one "thread" that runs the
 * same engine on the main thread between event loop turns.
 *
 * Renders lease threads, in two kinds:
 * - Long renders (path traced images, animations) lease every render thread (`size` workers). Up
 *   to two of them run at once and share the threads: a thread works through the tasks (bands of
 *   rows, frames) of both in turn, so a second long render does not wait minutes for the first.
 *   Further long renders wait, first come first served.
 * - Interactive renders (raster stills: previews, thumbnails) lease one free thread: one more
 *   worker kept for them (started on first use), or an idle render thread. They never wait for
 *   long renders.
 * In single-thread mode every lease shares the main thread (the tasks of all renders interleave).
 *
 * Workers start lazily, warm up (see `RenderEngine.warmUp`) before they take work, drop their
 * document caches after `cacheIdleMs` without work and stop after `idleTimeoutMs`.
 */

/** A request without its id (the thread assigns ids). */
export type RenderRequest = WorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never;

/** One render thread (a worker, or the main thread). */
export interface RenderThread {
  readonly id: number;
  readonly kind: 'worker' | 'main';
  /** Calls the thread (requests are handled one at a time, in order). */
  call<T extends WorkerResult>(req: RenderRequest, transfer?: ArrayBuffer[]): Promise<T>;
  /** Frees what a job keeps on the thread: a prepared path tracer, an APNG encoder (fire and forget). */
  release(job: number): void;
  /** Requests sent and not answered yet. */
  readonly pending: number;
  readonly alive: boolean;
}

export interface RenderPoolLog {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
}

export interface RenderPoolOptions {
  /**
   * Render threads of long renders (default: CPU cores, at most 8; 0 = render on the main thread).
   * One more worker is started for interactive renders when they need it.
   */
  threads?: number;
  /** Idle workers are stopped after this time (default 10 minutes). */
  idleTimeoutMs?: number;
  /** Idle workers drop their cached documents after this time, freeing most memory (default 2 minutes). */
  cacheIdleMs?: number;
  /**
   * Worker entry point (default: `render-worker.js` next to the bundle, else the development
   * bootstrap `worker-dev.mjs` that runs the TypeScript sources).
   */
  workerUrl?: URL;
  /** Abandoned work (after a cancellation) may run this long before its worker is stopped. */
  drainTimeoutMs?: number;
  log?: RenderPoolLog;
}

/** How a render uses the pool (see the module comment). */
export interface LeaseOptions {
  /**
   * A quick render (a raster still): one free thread, possibly the one kept for interactive
   * renders; never waits for long renders. Default: a long render.
   */
  interactive?: boolean;
}

/** Threads leased by one render; give them back with `release()`. */
export interface RenderLease {
  readonly threads: readonly RenderThread[];
  release(): void;
}

/** Long renders that may share the render threads at once (others wait for one to finish). */
export const MAX_SHARED_RENDERS = 2;

/** Default number of worker threads: the CPU cores, at most 8. */
export function defaultRenderThreads(): number {
  return Math.max(1, Math.min(8, availableParallelism()));
}

/** The worker entry point next to the running module (bundle) or the development bootstrap. */
export function defaultWorkerUrl(): URL {
  const bundled = new URL('./render-worker.js', import.meta.url);
  if (bundled.protocol === 'file:' && existsSync(fileURLToPath(bundled))) return bundled;
  return new URL('./worker-dev.mjs', import.meta.url);
}

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };
/** Threads of long renders, or the worker kept for interactive renders. */
type Role = 'bulk' | 'interactive';

class WorkerThread implements RenderThread {
  readonly kind = 'worker' as const;
  lastUsed = Date.now();
  /** The document caches were dropped since the last call (see RenderPool.sweep). */
  cleared = false;
  private readonly worker: Worker;
  private readonly calls = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private idleWaiters: (() => void)[] = [];
  readonly ready: Promise<void>;

  constructor(
    readonly id: number,
    readonly role: Role,
    url: URL,
    private readonly onExit: (t: WorkerThread, err: Error) => void,
  ) {
    this.worker = new Worker(url, { name: `render-${id}` });
    this.worker.unref();
    this.worker.on('message', (m: WorkerResponse) => this.onMessage(m));
    this.worker.on('error', (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    this.worker.on('exit', (code) => this.fail(new Error(`render worker exited with code ${code}`)));
    this.ready = this.call({ type: 'ping' }).then(() => undefined);
    this.ready.catch(() => undefined);
  }

  get pending(): number {
    return this.calls.size;
  }

  get alive(): boolean {
    return !this.failure;
  }

  call<T extends WorkerResult>(req: RenderRequest, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    this.cleared = false;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: never) => void, reject });
      if (this.calls.size === 1) this.worker.ref();
      try {
        this.worker.postMessage({ ...req, id }, transfer);
      } catch (err) {
        this.calls.delete(id);
        if (!this.calls.size) this.worker.unref();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  release(job: number): void {
    if (!this.failure) this.worker.postMessage({ type: 'release', job } satisfies WorkerRequest);
  }

  /** Drops the worker's cached documents (fire and forget). */
  clearCaches(): void {
    if (this.failure || this.cleared) return;
    this.cleared = true;
    this.worker.postMessage({ type: 'clear' } satisfies WorkerRequest);
  }

  /** Resolves when no call is pending (true) or after `timeoutMs` (false). */
  drain(timeoutMs: number): Promise<boolean> {
    if (!this.calls.size || this.failure) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(done);
    });
  }

  private onMessage(m: WorkerResponse): void {
    const c = this.calls.get(m.id);
    if (!c) return;
    this.calls.delete(m.id);
    this.lastUsed = Date.now();
    if (m.type === 'error') c.reject(new Error(m.message));
    else c.resolve(m.result as never);
    if (!this.calls.size) {
      this.worker.unref();
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    for (const c of this.calls.values()) c.reject(err);
    this.calls.clear();
    for (const w of this.idleWaiters) w();
    this.idleWaiters = [];
    this.onExit(this, err);
  }

  terminate(): void {
    this.fail(new RenderCancelledError('render worker stopped'));
    void this.worker.terminate().catch(() => undefined);
  }
}

/** Runs the render engine on the main thread, one request per event loop turn. */
class MainThread implements RenderThread {
  readonly kind = 'main' as const;
  readonly alive = true;
  private readonly engine = new RenderEngine();
  private queue: Promise<unknown> = Promise.resolve();
  private count = 0;

  constructor(readonly id: number) {}

  get pending(): number {
    return this.count;
  }

  call<T extends WorkerResult>(req: RenderRequest): Promise<T> {
    this.count++;
    const run = async (): Promise<T> => {
      await new Promise<void>((r) => setImmediate(r));
      try {
        return this.handle(req) as T;
      } finally {
        this.count--;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  release(job: number): void {
    // in order with the calls, like a worker (a queued prepare must not outlive its release)
    const run = () => this.engine.release(job);
    this.queue = this.queue.then(run, run);
  }

  private handle(req: RenderRequest): WorkerResult {
    switch (req.type) {
      case 'prepare':
        return this.engine.prepare(req.job, req.doc, req.options);
      case 'rows':
        return this.engine.rows(req.job, req.y0, req.y1, req.sampleStart, req.sampleCount);
      case 'image':
        return this.engine.image(req.doc, req.options, req.png);
      case 'finish':
        return this.engine.finish(req.film, req.options);
      case 'encode':
        return this.engine.encode(req.frames, req.options);
      case 'apng-add':
        return this.engine.apngAdd(req.job, req.frame, req.init);
      case 'apng-finish':
        return this.engine.apngFinish(req.job);
      case 'auto-view':
        return this.engine.autoView(req.doc, req.frames, req.aspect, req.camera, req.budgetMs);
      case 'ping':
        return { ok: true };
    }
  }
}

interface Waiter {
  max: number;
  interactive: boolean;
  resolve: (lease: RenderLease) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Render thread pool (see the module comment). */
export class RenderPool {
  /** Configured worker threads of long renders (0 = main thread only). */
  readonly size: number;
  private readonly idleTimeoutMs: number;
  private readonly cacheIdleMs: number;
  private readonly drainTimeoutMs: number;
  private readonly workerUrl: URL | null;
  private readonly log: RenderPoolLog | undefined;
  private readonly workers = new Set<WorkerThread>();
  /** Started threads without a lease. */
  private readonly free = new Set<RenderThread>();
  /** Number of leases holding each leased thread. */
  private readonly holders = new Map<RenderThread, number>();
  private readonly booting = new Set<WorkerThread>();
  /** Threads finishing abandoned work before they return to the pool. */
  private readonly draining = new Set<RenderThread>();
  private readonly waiters: Waiter[] = [];
  /** Long renders holding threads. */
  private shared = 0;
  private main: MainThread | null = null;
  private nextThreadId = 1;
  /** Why worker threads are not used (they failed to start), or null. */
  private brokenReason: string | null = null;
  /** Worker starts that failed in a row (3 switch the pool to the main thread). */
  private startFailures = 0;
  private closed = false;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(opts: RenderPoolOptions = {}) {
    const n = opts.threads ?? defaultRenderThreads();
    this.size = Number.isFinite(n) ? Math.max(0, Math.min(64, Math.floor(n))) : 0;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 600_000;
    this.cacheIdleMs = Math.min(opts.cacheIdleMs ?? 120_000, this.idleTimeoutMs);
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 10_000;
    this.workerUrl = this.size > 0 ? (opts.workerUrl ?? defaultWorkerUrl()) : null;
    this.log = opts.log;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.min(30_000, this.cacheIdleMs / 2)));
    this.sweeper.unref?.();
  }

  /** 'workers' when rendering on worker threads, 'main-thread' in single-thread mode. */
  get mode(): 'workers' | 'main-thread' {
    return this.size > 0 && !this.brokenReason ? 'workers' : 'main-thread';
  }

  /** Threads a long render can use at most. */
  get capacity(): number {
    return this.mode === 'workers' ? this.size : 1;
  }

  /** Live worker threads (started lazily, stopped when idle). */
  get running(): number {
    return this.workers.size;
  }

  /** Long renders holding threads right now (at most MAX_SHARED_RENDERS). */
  get activeLongRenders(): number {
    return this.shared;
  }

  /**
   * Leases up to `max` threads (at least one). Long renders get every render thread, shared with
   * at most one other long render (later ones wait); interactive ones get one free thread (see
   * {@link LeaseOptions}). Rejects with a RenderCancelledError when `signal` aborts first.
   */
  lease(max = Infinity, signal?: AbortSignal, opts: LeaseOptions = {}): Promise<RenderLease> {
    if (this.closed) return Promise.reject(new RenderCancelledError('render pool closed'));
    if (signal?.aborted) return Promise.reject(new RenderCancelledError());
    return new Promise<RenderLease>((resolve, reject) => {
      const w: Waiter = {
        max: opts.interactive ? 1 : Math.max(1, max),
        interactive: !!opts.interactive,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new RenderCancelledError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      this.dispatch();
    });
  }

  /** Stops every worker and rejects waiting leases. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const w of this.waiters.splice(0)) {
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.reject(new RenderCancelledError('render pool closed'));
    }
    for (const t of [...this.workers]) t.terminate();
    this.workers.clear();
    this.free.clear();
    this.holders.clear();
  }

  /** Hands threads to waiting renders, starting threads when needed. */
  private dispatch(): void {
    for (let round = 0; round < 2 && !this.closed; round++) {
      let longBlocked = false;
      for (let i = 0; i < this.waiters.length; ) {
        const w = this.waiters[i];
        let threads: RenderThread[] | null = null;
        if (w.interactive) threads = this.pickInteractive();
        else if (!longBlocked) {
          threads = this.pickLong(w.max);
          // long renders start in the order they were asked for
          if (!threads) longBlocked = true;
        }
        if (!threads) {
          i++;
          continue;
        }
        this.waiters.splice(i, 1);
        if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
        w.resolve(this.makeLease(threads, w.interactive));
      }
      // starting threads may make some available at once (the main thread fallback): one more round
      if (!this.waiters.length || !this.ensureThreads()) return;
    }
  }

  /** A free thread for an interactive render (the main thread is shared), or null. */
  private pickInteractive(): RenderThread[] | null {
    if (this.mode === 'main-thread') return this.main ? [this.main] : null;
    let best: RenderThread | null = null;
    for (const t of this.free) {
      if (!t.alive) continue;
      // the thread kept for interactive renders first: idle render threads stay free for long renders
      if (!best || (roleOf(t) === 'interactive' && roleOf(best) !== 'interactive')) best = t;
    }
    return best ? [best] : null;
  }

  /** Threads for a long render (shared with the other long render), or null when it must wait. */
  private pickLong(max: number): RenderThread[] | null {
    if (this.shared >= MAX_SHARED_RENDERS) return null;
    if (this.mode === 'main-thread') return this.main ? [this.main] : null;
    const want = Math.min(max, this.size);
    const usable: RenderThread[] = [];
    let coming = 0;
    for (const t of this.workers) {
      if (t.role !== 'bulk') continue;
      if (this.booting.has(t) || this.draining.has(t)) coming++;
      else if (t.alive) usable.push(t);
    }
    // threads starting up (or finishing cancelled work) will be there in a moment: wait for them
    // when they are wanted, and for the threads still to be started
    if (usable.length < want && (coming > 0 || usable.length + coming < this.size)) return null;
    if (!usable.length) return null;
    // free threads first, then the ones with fewer renders on them
    usable.sort((a, b) => (this.holders.get(a) ?? 0) - (this.holders.get(b) ?? 0));
    return usable.slice(0, want);
  }

  /**
   * Starts the workers waiting renders need: every render thread for a long render, the thread
   * kept for interactive renders (and idle render threads when several wait). Returns true when
   * threads became available at once (main thread fallback).
   */
  private ensureThreads(): boolean {
    if (this.closed) return false;
    if (this.mode === 'workers') {
      let bulk = 0;
      let interactive = 0;
      for (const t of this.workers) {
        if (t.role === 'bulk') bulk++;
        else interactive++;
      }
      const quickWaiting = this.waiters.filter((w) => w.interactive).length;
      let target = this.waiters.length > quickWaiting ? this.size : bulk;
      if (quickWaiting) {
        if (!interactive) this.spawn('interactive');
        // more quick renders than threads that are free or about to be: idle render threads help
        const soon = this.free.size + this.booting.size;
        if (quickWaiting > soon) target = Math.max(target, Math.min(this.size, bulk + quickWaiting - soon));
      }
      for (let n = bulk; n < target && this.mode === 'workers'; n++) this.spawn('bulk');
    }
    // single-thread mode (configured, or workers could not start)
    if (this.mode === 'workers' || this.main) return false;
    this.main = new MainThread(this.nextThreadId++);
    this.free.add(this.main);
    return true;
  }

  private spawn(role: Role): void {
    let t: WorkerThread;
    try {
      t = new WorkerThread(this.nextThreadId++, role, this.workerUrl!, (thread, err) =>
        this.onWorkerExit(thread, err),
      );
    } catch (err) {
      this.markBroken(err);
      return;
    }
    this.booting.add(t);
    this.workers.add(t);
    t.ready
      .then(
        () => {
          this.startFailures = 0;
          if (t.alive && !this.closed) {
            t.lastUsed = Date.now();
            this.free.add(t);
          }
        },
        (err: unknown) => {
          this.workers.delete(t);
          if (++this.startFailures >= 3) this.markBroken(err);
          else this.log?.warn({ err: String(err) }, 'render worker failed to start');
        },
      )
      .finally(() => {
        this.booting.delete(t);
        this.dispatch();
      });
  }

  private markBroken(err: unknown): void {
    if (this.brokenReason) return;
    this.brokenReason = err instanceof Error ? err.message : String(err);
    this.log?.warn(
      { err: this.brokenReason, worker: this.workerUrl?.href },
      'render worker threads unavailable: rendering on the main thread',
    );
    for (const t of [...this.workers]) t.terminate();
    this.workers.clear();
    this.free.clear();
    this.booting.clear();
  }

  private onWorkerExit(t: WorkerThread, err: Error): void {
    const known = this.workers.delete(t);
    this.free.delete(t);
    this.holders.delete(t);
    if (known && !(err instanceof RenderCancelledError) && !this.closed)
      this.log?.warn({ err: err.message, thread: t.id }, 'render worker stopped unexpectedly');
    // a long render waiting for a replacement thread
    if (this.waiters.length && !this.closed) queueMicrotask(() => this.dispatch());
  }

  private makeLease(threads: RenderThread[], interactive: boolean): RenderLease {
    for (const t of threads) {
      this.free.delete(t);
      this.holders.set(t, (this.holders.get(t) ?? 0) + 1);
    }
    if (!interactive) this.shared++;
    let released = false;
    return {
      threads,
      release: () => {
        if (released) return;
        released = true;
        if (!interactive) this.shared--;
        for (const t of threads) {
          const n = (this.holders.get(t) ?? 0) - 1;
          if (n > 0) this.holders.set(t, n);
          else {
            this.holders.delete(t);
            void this.giveBack(t);
          }
        }
        this.dispatch();
      },
    };
  }

  /**
   * Returns a thread nobody leases any more to the pool, once its abandoned work is done (stops
   * it when that takes too long).
   */
  private async giveBack(t: RenderThread): Promise<void> {
    if (t instanceof WorkerThread && t.pending > 0 && t.alive) {
      this.draining.add(t);
      try {
        const drained = await t.drain(this.drainTimeoutMs);
        if (!drained) {
          this.log?.warn({ thread: t.id }, 'stopping a render worker busy with cancelled work');
          t.terminate();
        }
      } finally {
        this.draining.delete(t);
      }
    }
    if (t.alive && !this.closed && !this.holders.has(t)) {
      if (t instanceof WorkerThread) t.lastUsed = Date.now();
      this.free.add(t);
    }
    this.dispatch();
  }

  private sweep(): void {
    const now = Date.now();
    for (const t of [...this.free]) {
      if (!(t instanceof WorkerThread) || t.pending > 0) continue;
      const idle = now - t.lastUsed;
      if (idle >= this.idleTimeoutMs) {
        this.free.delete(t);
        this.workers.delete(t);
        t.terminate();
      } else if (idle >= this.cacheIdleMs) t.clearCaches();
    }
  }
}

function roleOf(t: RenderThread): Role {
  return t instanceof WorkerThread ? t.role : 'bulk';
}
