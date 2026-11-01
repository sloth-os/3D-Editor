import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RenderEngine } from './engine';
import { RenderCancelledError, type WorkerRequest, type WorkerResponse, type WorkerResult } from './protocol';

/*
 * A pool of render threads: worker threads running `worker.ts` (one CPU core each), or, in
 * single-thread mode (RENDER_WORKERS=0, or when workers cannot start), one "thread" that runs the
 * same engine on the main thread between event loop turns. Renders lease threads exclusively, so
 * at most `size` scenes are prepared at once and every thread works on one render at a time.
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
  /** Frees a prepared path tracing job (fire and forget). */
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
  /** Worker threads (default: CPU cores, at most 8; 0 = render on the main thread). */
  threads?: number;
  /** Idle workers are stopped after this time, freeing their memory (default 120 s). */
  idleTimeoutMs?: number;
  /**
   * Worker entry point (default: `render-worker.js` next to the bundle, else the development
   * bootstrap `worker-dev.mjs` that runs the TypeScript sources).
   */
  workerUrl?: URL;
  /** Abandoned work (after a cancellation) may run this long before its worker is stopped. */
  drainTimeoutMs?: number;
  log?: RenderPoolLog;
}

/** Threads leased by one render; give them back with `release()`. */
export interface RenderLease {
  readonly threads: readonly RenderThread[];
  release(): void;
}

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

class WorkerThread implements RenderThread {
  readonly kind = 'worker' as const;
  lastUsed = Date.now();
  private readonly worker: Worker;
  private readonly calls = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private idleWaiters: (() => void)[] = [];
  readonly ready: Promise<void>;

  constructor(
    readonly id: number,
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
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: never) => void, reject });
      if (this.calls.size === 1) this.worker.ref();
      try {
        this.worker.postMessage({ ...req, id }, transfer);
      } catch (err) {
        this.calls.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  release(job: number): void {
    if (!this.failure) this.worker.postMessage({ type: 'release', job } satisfies WorkerRequest);
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
      case 'auto-view':
        return this.engine.autoView(req.doc, req.frames, req.aspect, req.camera, req.budgetMs);
      case 'ping':
        return { ok: true };
    }
  }
}

interface Waiter {
  max: number;
  resolve: (lease: RenderLease) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Render thread pool (see the module comment). */
export class RenderPool {
  /** Configured worker threads (0 = main thread only). */
  readonly size: number;
  private readonly idleTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly workerUrl: URL | null;
  private readonly log: RenderPoolLog | undefined;
  private readonly workers = new Set<WorkerThread>();
  private readonly free: RenderThread[] = [];
  private readonly waiters: Waiter[] = [];
  private main: MainThread | null = null;
  private booting = 0;
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
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 10_000;
    this.workerUrl = this.size > 0 ? (opts.workerUrl ?? defaultWorkerUrl()) : null;
    this.log = opts.log;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.min(30_000, this.idleTimeoutMs / 2)));
    this.sweeper.unref?.();
  }

  /** 'workers' when rendering on worker threads, 'main-thread' in single-thread mode. */
  get mode(): 'workers' | 'main-thread' {
    return this.size > 0 && !this.brokenReason ? 'workers' : 'main-thread';
  }

  /** Threads a render can use at most. */
  get capacity(): number {
    return this.mode === 'workers' ? this.size : 1;
  }

  /** Live worker threads (started lazily, stopped when idle). */
  get running(): number {
    return this.workers.size;
  }

  /**
   * Leases up to `max` threads (at least one; waits while all are busy). Rejects with a
   * RenderCancelledError when `signal` aborts first.
   */
  lease(max = Infinity, signal?: AbortSignal): Promise<RenderLease> {
    if (this.closed) return Promise.reject(new RenderCancelledError('render pool closed'));
    if (signal?.aborted) return Promise.reject(new RenderCancelledError());
    return new Promise<RenderLease>((resolve, reject) => {
      const w: Waiter = { max: Math.max(1, max), resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new RenderCancelledError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      this.ensureThreads();
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
    this.free.length = 0;
  }

  /** Starts workers for the threads leased and wanted (lazily, up to `size`). */
  private ensureThreads(): void {
    if (this.mode === 'main-thread') {
      if (!this.main) {
        this.main = new MainThread(this.nextThreadId++);
        this.free.push(this.main);
      }
      return;
    }
    const leased = this.workers.size - this.booting - this.free.length;
    let wanted = leased;
    for (const w of this.waiters) wanted += Math.min(w.max, this.size);
    const target = Math.min(this.size, wanted);
    while (this.mode === 'workers' && this.workers.size < target) this.spawn();
  }

  private spawn(): void {
    let t: WorkerThread;
    try {
      t = new WorkerThread(this.nextThreadId++, this.workerUrl!, (thread, err) =>
        this.onWorkerExit(thread, err),
      );
    } catch (err) {
      this.markBroken(err);
      return;
    }
    this.booting++;
    this.workers.add(t);
    t.ready
      .then(
        () => {
          this.startFailures = 0;
          if (t.alive && !this.closed) this.free.push(t);
        },
        (err: unknown) => {
          this.workers.delete(t);
          if (++this.startFailures >= 3) this.markBroken(err);
          else this.log?.warn({ err: String(err) }, 'render worker failed to start');
        },
      )
      .finally(() => {
        this.booting--;
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
    this.free.length = 0;
    this.ensureThreads();
  }

  private onWorkerExit(t: WorkerThread, err: Error): void {
    const known = this.workers.delete(t);
    const i = this.free.indexOf(t);
    if (i >= 0) this.free.splice(i, 1);
    if (known && !(err instanceof RenderCancelledError) && !this.closed)
      this.log?.warn({ err: err.message, thread: t.id }, 'render worker stopped unexpectedly');
  }

  private dispatch(): void {
    if (this.closed) return;
    while (this.waiters.length && this.free.length) {
      const w = this.waiters[0];
      // threads that are starting up will be free in a moment: wait for them when they are wanted
      if (this.booting > 0 && this.free.length < Math.min(w.max, this.capacity)) break;
      this.waiters.shift();
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      const threads = this.free.splice(0, Math.min(w.max, this.free.length));
      w.resolve(this.makeLease(threads));
    }
    if (this.waiters.length && !this.booting) this.ensureThreads();
  }

  private makeLease(threads: RenderThread[]): RenderLease {
    let released = false;
    return {
      threads,
      release: () => {
        if (released) return;
        released = true;
        for (const t of threads) void this.giveBack(t);
      },
    };
  }

  /** Returns a thread to the pool once its abandoned work is done (stops it when that takes too long). */
  private async giveBack(t: RenderThread): Promise<void> {
    if (t instanceof WorkerThread && t.pending > 0) {
      const drained = await t.drain(this.drainTimeoutMs);
      if (!drained) {
        this.log?.warn({ thread: t.id }, 'stopping a render worker busy with cancelled work');
        t.terminate();
      }
    }
    if (!t.alive || this.closed) {
      this.dispatch();
      return;
    }
    if (t instanceof WorkerThread) t.lastUsed = Date.now();
    this.free.push(t);
    this.dispatch();
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const t of [...this.free]) {
      if (t instanceof WorkerThread && t.lastUsed < cutoff && t.pending === 0) {
        this.free.splice(this.free.indexOf(t), 1);
        this.workers.delete(t);
        t.terminate();
      }
    }
  }
}
