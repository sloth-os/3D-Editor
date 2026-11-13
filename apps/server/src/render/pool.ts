import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MAX_DOCUMENTS, RenderEngine } from './engine';
import {
  INTERRUPTED_PREFIX,
  OUT_OF_MEMORY_PREFIX,
  RenderCancelledError,
  RenderOutOfMemoryError,
  type DocRef,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from './protocol';

/*
 * A pool of render threads: render processes (`child_process.fork` of `worker.ts`, one CPU core
 * each), or, in single-thread mode (RENDER_WORKERS=0, or when render processes cannot start), one
 * "thread" that runs the same engine on the main thread between event loop turns.
 *
 * Processes, not worker threads: when a worker thread's heap allocation fails in some paths
 * (V8's fatal "JavaScript heap out of memory", e.g. growing a large Map), Node aborts the whole
 * process whatever the worker's resourceLimits, so one render of a scene too large for its heap
 * took the server down with every editor and agent. A render process that runs out of memory only
 * ends itself: its requests fail with a RenderOutOfMemoryError, the pool logs it, and a new process
 * serves later renders (when two long renders share the processes, only the request the process
 * was working on fails with that error; the other render's requests waiting behind it fail with a
 * `shared` one, which says it can run again). Render processes also run at a lower CPU priority and
 * are the first ones the kernel's out-of-memory killer ends (priority.ts). They never outlive the
 * server: it stops them when it shuts down (main.ts), they exit when its IPC channel closes, and a
 * watchdog thread ends a busy one within a second when the server was killed (worker.ts).
 *
 * Renders lease threads, in two kinds:
 * - Long renders (path traced images, animations) lease every render thread (`size` processes).
 *   Up to two of them run at once and share the threads: a thread works through the tasks (bands
 *   of rows, frames) of both in turn, so a second long render does not wait minutes for the first.
 *   Further long renders wait, first come first served.
 * - Interactive renders (raster stills: previews, thumbnails) lease one free thread: one more
 *   process kept for them (started on first use), or an idle render thread. They never wait for
 *   long renders.
 * In single-thread mode every lease shares the main thread (the tasks of all renders interleave).
 *
 * Render processes start lazily, warm up (see `RenderEngine.warmUp`) before they take work, drop
 * their document caches after `cacheIdleMs` without work and stop after `idleTimeoutMs`. Requests
 * carry a document's state only when the process does not have that version yet (IPC copies it;
 * a large state goes in parts, see DOC_PART_BYTES).
 */

/** A request without its id (the thread assigns ids). */
export type RenderRequest = WorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never;

/** One render thread (a render process, or the main thread). */
export interface RenderThread {
  readonly id: number;
  readonly kind: 'process' | 'main';
  /** Calls the thread (requests are handled one at a time, in order). */
  call<T extends WorkerResult>(req: RenderRequest): Promise<T>;
  /** Frees what a job keeps on the thread: a prepared path tracer, an APNG encoder (fire and forget). */
  release(job: number): void;
  /** Requests sent and not answered yet. */
  readonly pending: number;
  readonly alive: boolean;
}

export interface RenderPoolLog {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
  debug?(obj: object, msg: string): void;
}

export interface RenderPoolOptions {
  /**
   * Render processes of long renders (default: CPU cores, at most 8; 0 = render on the main
   * thread). One more process is started for interactive renders when they need it.
   */
  threads?: number;
  /** Idle render processes are stopped after this time (default 10 minutes). */
  idleTimeoutMs?: number;
  /** Idle render processes drop their cached documents after this time, freeing most memory (default 2 minutes). */
  cacheIdleMs?: number;
  /**
   * Render process entry point (default: `render-worker.js` next to the bundle, else the
   * development bootstrap `worker-dev.mjs` that runs the TypeScript sources).
   */
  workerUrl?: URL;
  /**
   * JavaScript heap limit of each render process in MB (`--max-heap-size`; default: Node's
   * default for the machine, 2096 MB on a machine with 16 GB of memory). A render that needs more
   * fails with a RenderOutOfMemoryError and its process is replaced.
   */
  heapLimitMb?: number;
  /** A render process that is not ready after this time is stopped (a failed start; default 2 minutes). */
  startTimeoutMs?: number;
  /** Abandoned work (after a cancellation) may run this long before its process is stopped. */
  drainTimeoutMs?: number;
  /**
   * How long after a render process exited its calls wait for the end of its output (V8's
   * out-of-memory report on stderr) before they fail anyway (default 1 s; normally the output ends
   * with the process).
   */
  closeFallbackMs?: number;
  /** The size of the parts a large document state is sent in (default {@link DOC_PART_BYTES}; for tests). */
  docPartBytes?: number;
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

/**
 * A document state larger than this goes to a render process in parts of this size (`doc-part`
 * messages), each part sent once the one before was written to the IPC channel. Sent whole, the
 * channel copied it into one message of its size in the server's memory (outside its JavaScript
 * heap), and one more for every render process a path traced render sends it to.
 */
export const DOC_PART_BYTES = 8 * 1024 * 1024;

/** Default number of render processes: the CPU cores, at most 8. */
export function defaultRenderThreads(): number {
  return Math.max(1, Math.min(8, availableParallelism()));
}

/** The render process entry point next to the running module (bundle) or the development bootstrap. */
export function defaultWorkerUrl(): URL {
  const bundled = new URL('./render-worker.js', import.meta.url);
  if (bundled.protocol === 'file:' && existsSync(fileURLToPath(bundled))) return bundled;
  return new URL('./worker-dev.mjs', import.meta.url);
}

type Pending = {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  req: RenderRequest;
  /** Sent again with the document's state after a `missing-doc` answer. */
  resent: boolean;
};
/** Threads of long renders, or the process kept for interactive renders. */
export type Role = 'bulk' | 'interactive';

/** Bytes of a render process's stderr kept to tell how it ended. */
const STDERR_TAIL_BYTES = 16 * 1024;
/** What V8 prints when a heap allocation fails ("FATAL ERROR: … JavaScript heap out of memory"). */
const HEAP_OOM = /heap out of memory|allocation failed|out of memory/i;

/** How the errors of a render process that ran out of memory end (the pool replaces it). */
const REPLACED = 'the server keeps running and starts a new render process for the next render';

/** The message of a render process that ran out of JavaScript heap (its limit when known). */
function outOfHeapMessage(heapLimitMb: number | undefined): string {
  const heap = heapLimitMb ? `its ${heapLimitMb} MB JavaScript heap` : 'its JavaScript heap';
  return `${OUT_OF_MEMORY_PREFIX}the render process ran out of ${heap}; ${REPLACED}`;
}

/**
 * The line of a crashed render process's stderr that says why: the error line of an uncaught
 * exception ("TypeError: …"), not the source line, the stack frames, Node's hints or the "Node.js
 * vX" banner Node prints after it; else the last other line.
 */
export function crashReason(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) => l && !/^at\s/.test(l) && !/^Node\.js v\d/.test(l) && !/^\^+$/.test(l) && !/^\(Use `node/.test(l),
    );
  for (let i = lines.length - 1; i >= 0; i--)
    if (/^(?:Uncaught\s+)?(?:[A-Z]\w*)?(?:Error|Exception)\b/.test(lines[i])) return lines[i];
  return lines.pop();
}

/**
 * The error of a render process that ended by itself: out of heap (V8's fatal error on stderr),
 * killed with SIGKILL (what the kernel's out-of-memory killer sends), or another crash.
 */
export function renderProcessExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  heapLimitMb?: number,
): Error {
  if (HEAP_OOM.test(stderr))
    return new RenderOutOfMemoryError(outOfHeapMessage(heapLimitMb), heapLimitMb, 'heap');
  if (signal === 'SIGKILL')
    return new RenderOutOfMemoryError(
      `${OUT_OF_MEMORY_PREFIX}the render process was killed (SIGKILL), most likely by the system because the ` +
        `machine ran out of memory; ${REPLACED}`,
      heapLimitMb,
      'killed',
    );
  const reason = crashReason(stderr);
  return new Error(
    `the render process exited unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`})${reason ? `: ${reason}` : ''}`,
  );
}

/**
 * The error of a request that was waiting in a render process behind the request that ended it
 * (`cause`): two long renders share the render processes, and the other render's request ran the
 * process out of memory (or crashed it). This render was not the cause: it can run again.
 */
export function sharedProcessError(cause: Error): Error {
  if (cause instanceof RenderOutOfMemoryError) {
    const what =
      cause.reason === 'killed'
        ? 'was killed (SIGKILL), most likely by the system because the machine ran out of memory,'
        : 'ran out of memory';
    return new RenderOutOfMemoryError(
      `${INTERRUPTED_PREFIX}the render process ${what} while it worked on another render that shared it; ` +
        'this render was not the cause: run it again (a new render process serves it)',
      cause.heapLimitMb,
      'shared',
    );
  }
  return new Error(
    `${INTERRUPTED_PREFIX}the render process stopped while it worked on another render that shared it (${cause.message}); ` +
      'run this render again (a new render process serves it)',
  );
}

/** A render process (exported for tests; the pool creates them). */
export class ProcessThread implements RenderThread {
  readonly kind = 'process' as const;
  lastUsed = Date.now();
  /** The document caches were dropped since the last call (see RenderPool.sweep). */
  cleared = false;
  /** The process reported that it is ready (warmed up). */
  started = false;
  /** The process id, and its JavaScript heap limit in MB once it reported it. */
  readonly pid: number | undefined;
  heapLimitMb: number | undefined;
  readonly ready: Promise<void>;
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
  private readonly child: ChildProcess;
  private readonly calls = new Map<number, Pending>();
  /**
   * Ids of the pending calls in the order their messages went to the process, which handles them
   * one at a time in that order: the first one is the one it is working on.
   */
  private readonly order: number[] = [];
  private nextId = 1;
  private failure: Error | null = null;
  /** What calls made after the end get: a `shared` error when a request ended the process. */
  private lateFailure: Error | null = null;
  private idleWaiters: (() => void)[] = [];
  /** Messages for the process before it is ready (null once it is). */
  private outbox: WorkerRequest[] | null = [];
  /** Messages waiting for the parts of a document state still on their way (null: none are). */
  private behindParts: WorkerRequest[] | null = null;
  /** Documents (key → version) the process holds, least recently used first (see MAX_DOCUMENTS). */
  private readonly docs = new Map<string, number>();
  private stderrTail = '';
  /** terminate() was called: the exit is expected. */
  private stopping = false;
  private settleReady: ((err?: Error) => void) | null = null;
  /** The size of the parts a large document state is sent in (see DOC_PART_BYTES). */
  private readonly partBytes: number;

  constructor(
    readonly id: number,
    readonly role: Role,
    entry: URL,
    opts: { heapLimitMb?: number; startTimeoutMs: number; closeFallbackMs?: number; docPartBytes?: number },
    private readonly onExit: (t: ProcessThread, err: Error) => void,
  ) {
    this.partBytes = opts.docPartBytes ?? DOC_PART_BYTES;
    let resolveExited!: () => void;
    this.exited = new Promise<void>((r) => (resolveExited = r));
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = (err) => {
        this.settleReady = null;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
    });
    this.ready.catch(() => undefined);
    // the server's own Node flags (loaders, heap limit) are not passed on: worker-dev.mjs registers
    // the TypeScript loader itself, and the heap limit is the render process's own (heap flags in
    // NODE_OPTIONS would override it). --expose-gc lets an idle process give the memory of the
    // documents it dropped back (see clearCaches)
    const heapFlags = /--max-(old-space|heap|semi-space)-size(=\S*)?/g;
    const env = { ...process.env };
    if (opts.heapLimitMb && env.NODE_OPTIONS)
      env.NODE_OPTIONS = env.NODE_OPTIONS.replace(heapFlags, '').replace(/\s+/g, ' ').trim();
    this.child = fork(fileURLToPath(entry), [], {
      execArgv: [
        '--expose-gc',
        ...(opts.heapLimitMb ? [`--max-heap-size=${Math.round(opts.heapLimitMb)}`] : []),
      ],
      env,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
    });
    this.pid = this.child.pid;
    const timer = setTimeout(() => {
      const ms = opts.startTimeoutMs;
      this.fail(
        new Error(`the render process did not start within ${ms % 1000 ? `${ms} ms` : `${ms / 1000} s`}`),
      );
    }, opts.startTimeoutMs);
    timer.unref?.();
    this.child.on('message', (m: WorkerResponse) => this.onMessage(m));
    this.child.on('error', (err) => this.fail(err));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      // V8's out-of-memory report and any warning go to the server's stderr too
      process.stderr.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    let closed = false;
    const onEnded = (code: number | null, signal: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      resolveExited();
      if (this.stopping) this.fail(new RenderCancelledError('render process stopped'));
      else
        this.fail(renderProcessExitError(code, signal, this.stderrTail, this.heapLimitMb), {
          working: this.order.find((id) => this.calls.has(id)),
        });
    };
    // 'close' comes once stderr is read to its end (V8's out-of-memory report included); 'exit'
    // alone if the pipe stays open for some reason
    this.child.on('close', onEnded);
    this.child.on('exit', (code, signal) => {
      setTimeout(() => onEnded(code, signal), opts.closeFallbackMs ?? 1000).unref?.();
    });
  }

  get pending(): number {
    return this.calls.size;
  }

  get alive(): boolean {
    return !this.failure;
  }

  call<T extends WorkerResult>(req: RenderRequest): Promise<T> {
    if (this.failure) return Promise.reject(this.lateFailure ?? this.failure);
    const id = this.nextId++;
    this.cleared = false;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: never) => void, reject, req, resent: false });
      if (this.calls.size === 1) this.hold(true);
      try {
        this.post(this.message(id, req, false));
        this.order.push(id);
      } catch (err) {
        this.calls.delete(id);
        if (!this.calls.size) this.hold(false);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  release(job: number): void {
    if (!this.failure) this.tell({ type: 'release', job });
  }

  /** Drops the process's cached documents (fire and forget). */
  clearCaches(): void {
    if (this.failure || this.cleared) return;
    this.cleared = true;
    this.docs.clear();
    this.tell({ type: 'clear' });
  }

  /** Sends a message without an answer; a process that is gone needs none (its exit is handled). */
  private tell(msg: WorkerRequest): void {
    try {
      this.post(msg);
    } catch {
      // the process exited or is exiting
    }
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

  /** Stops the process (its pending calls fail with a RenderCancelledError). */
  terminate(): Promise<void> {
    this.stopping = true;
    this.fail(new RenderCancelledError('render process stopped'));
    return this.exited;
  }

  /**
   * The message of request `id`: a document's state is left out when the process already has
   * that version (the update is encoded and copied only for processes that need it).
   */
  private message(id: number, req: RenderRequest, withState: boolean): WorkerRequest {
    if (!('doc' in req)) return { ...req, id } as WorkerRequest;
    const d: DocRef = req.doc;
    const has = !withState && this.docs.get(d.key) === d.version;
    return {
      ...req,
      id,
      doc: has ? { key: d.key, version: d.version } : { key: d.key, version: d.version, update: d.update },
    } as WorkerRequest;
  }

  /** Records that the process holds `doc` (mirrors its least-recently-used document cache). */
  private holds(doc: DocRef): void {
    this.docs.delete(doc.key);
    this.docs.set(doc.key, doc.version);
    while (this.docs.size > MAX_DOCUMENTS) this.docs.delete(this.docs.keys().next().value!);
  }

  private post(msg: WorkerRequest): void {
    if (this.outbox) {
      this.outbox.push(msg);
      return;
    }
    if (!this.child.connected) throw this.failure ?? new Error('the render process is not connected');
    if (this.behindParts) {
      this.behindParts.push(msg);
      return;
    }
    const update = 'doc' in msg ? msg.doc.update : undefined;
    if (!update || update.byteLength <= this.partBytes) {
      this.write(msg);
      return;
    }
    // the state in parts, each serialized once the one before was written, then the request
    // without it (see DOC_PART_BYTES); later messages wait for them
    const { key, version } = (msg as Extract<WorkerRequest, { doc: DocRef }>).doc;
    const request = { ...msg, doc: { key, version } } as WorkerRequest;
    const total = update.byteLength;
    this.behindParts = [];
    let offset = 0;
    const next = (): void => {
      if (this.failure) {
        this.behindParts = null;
        return;
      }
      if (offset < total) {
        const bytes = update.subarray(offset, offset + this.partBytes);
        const part: WorkerRequest = { type: 'doc-part', key, version, offset, total, bytes };
        offset += bytes.byteLength;
        this.write(part, next);
        return;
      }
      const waiting = this.behindParts ?? [];
      this.behindParts = null;
      this.write(request);
      try {
        for (const m of waiting) this.post(m);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
      }
    };
    next();
  }

  /** Sends one message; `written` runs once the IPC channel has written it. */
  private write(msg: WorkerRequest, written?: () => void): void {
    this.child.send(msg, (err) => {
      if (err) this.fail(err);
      else written?.();
    });
  }

  /**
   * Keeps the server's event loop alive while calls are pending (an idle render process does not
   * keep a process that has nothing else to do from exiting).
   */
  private hold(on: boolean): void {
    const handles = [this.child, this.child.channel, this.child.stderr] as (
      | {
          ref?: () => void;
          unref?: () => void;
        }
      | null
      | undefined
    )[];
    for (const h of handles) {
      if (on) h?.ref?.();
      else h?.unref?.();
    }
  }

  private onMessage(m: WorkerResponse): void {
    if (m.type === 'ready') {
      // too late (the start timed out): the process is being stopped
      if (this.failure) return;
      this.started = true;
      this.heapLimitMb = m.heapLimitMb;
      this.lastUsed = Date.now();
      const queued = this.outbox ?? [];
      this.outbox = null;
      try {
        for (const msg of queued) this.post(msg);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!this.calls.size) this.hold(false);
      this.settleReady?.();
      return;
    }
    const c = this.calls.get(m.id);
    if (!c) return;
    if (m.type === 'error' && m.kind === 'missing-doc' && !c.resent && 'doc' in c.req) {
      // the process dropped the document (or never had it): the same request with its state
      c.resent = true;
      this.docs.delete(c.req.doc.key);
      this.unorder(m.id);
      try {
        this.post(this.message(m.id, c.req, true));
        this.order.push(m.id);
        return;
      } catch (err) {
        this.calls.delete(m.id);
        c.reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    this.calls.delete(m.id);
    this.unorder(m.id);
    this.lastUsed = Date.now();
    if (m.type === 'error') {
      if (m.kind === 'out-of-memory') {
        // an allocation failed (a buffer, outside the JavaScript heap, or V8 reported it)
        const err = new RenderOutOfMemoryError(
          `${OUT_OF_MEMORY_PREFIX}the render process could not allocate memory (${m.message}); ${REPLACED}`,
          this.heapLimitMb,
          'heap',
        );
        c.reject(err);
        // it may be out of memory for good: a new process takes the next requests, and the
        // requests waiting behind this one were not the cause
        this.fail(err, { working: undefined });
        return;
      }
      c.reject(new Error(m.message));
    } else {
      if ('doc' in c.req) this.holds(c.req.doc);
      c.resolve(m.result as never);
    }
    if (!this.calls.size) {
      this.hold(false);
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private unorder(id: number): void {
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
  }

  /**
   * Ends the thread: pending calls fail with `err`, the process is stopped if it still runs. With
   * `shared` (a request ran the process out of memory or crashed it), only the call it was working
   * on (`shared.working`, if still pending) fails with `err`; the calls waiting behind it get a
   * {@link sharedProcessError}.
   */
  private fail(err: Error, shared?: { working: number | undefined }): void {
    if (this.failure) return;
    this.failure = err;
    // a request that comes after the end was not the cause either
    this.lateFailure = shared ? sharedProcessError(err) : err;
    this.outbox = null;
    this.behindParts = null;
    for (const [id, c] of this.calls) c.reject(shared && id !== shared.working ? this.lateFailure : err);
    this.calls.clear();
    this.order.length = 0;
    for (const w of this.idleWaiters) w();
    this.idleWaiters = [];
    this.settleReady?.(err);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // referenced until it has exited, so that waiting for `exited` (RenderPool.close) works
      this.hold(true);
      try {
        this.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    this.onExit(this, err);
  }
}

/**
 * Runs the render engine on the main thread, one request per event loop turn (single-thread
 * mode). The server's heap is its heap: the Renderer refuses renders that would not fit into it
 * (memory.ts).
 */
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
    // in order with the calls, like a render process (a queued prepare must not outlive its release)
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
      case 'simulate':
        return this.engine.simulate(req.doc, req.frames);
      case 'export':
        return this.engine.exportFile(req.doc, req.format, req.options);
      case 'ping':
        return { ok: true };
      case 'test-allocate':
      case 'test-busy':
        throw new Error(`'${req.type}' is a test request for render processes`);
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
  /** Configured render processes of long renders (0 = main thread only). */
  readonly size: number;
  private readonly idleTimeoutMs: number;
  private readonly cacheIdleMs: number;
  private readonly drainTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly closeFallbackMs: number | undefined;
  private readonly docPartBytes: number | undefined;
  private readonly heapLimitMb: number | undefined;
  private readonly workerUrl: URL | null;
  private readonly log: RenderPoolLog | undefined;
  private readonly workers = new Set<ProcessThread>();
  /** Started threads without a lease. */
  private readonly free = new Set<RenderThread>();
  /** Number of leases holding each leased thread. */
  private readonly holders = new Map<RenderThread, number>();
  private readonly booting = new Set<ProcessThread>();
  /** Threads finishing abandoned work before they return to the pool. */
  private readonly draining = new Set<RenderThread>();
  private readonly waiters: Waiter[] = [];
  /** Long renders holding threads. */
  private shared = 0;
  private main: MainThread | null = null;
  private nextThreadId = 1;
  /** Why render processes are not used (they failed to start), or null. */
  private brokenReason: string | null = null;
  /** Render process starts that failed in a row (3 switch the pool to the main thread). */
  private startFailures = 0;
  private closed = false;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(opts: RenderPoolOptions = {}) {
    const n = opts.threads ?? defaultRenderThreads();
    this.size = Number.isFinite(n) ? Math.max(0, Math.min(64, Math.floor(n))) : 0;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 600_000;
    this.cacheIdleMs = Math.min(opts.cacheIdleMs ?? 120_000, this.idleTimeoutMs);
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 10_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 120_000;
    this.closeFallbackMs = opts.closeFallbackMs;
    this.docPartBytes = opts.docPartBytes;
    this.heapLimitMb =
      opts.heapLimitMb !== undefined && Number.isFinite(opts.heapLimitMb) && opts.heapLimitMb > 0
        ? Math.round(opts.heapLimitMb)
        : undefined;
    this.workerUrl = this.size > 0 ? (opts.workerUrl ?? defaultWorkerUrl()) : null;
    this.log = opts.log;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.min(30_000, this.cacheIdleMs / 2)));
    this.sweeper.unref?.();
  }

  /** 'processes' when rendering in render processes, 'main-thread' in single-thread mode. */
  get mode(): 'processes' | 'main-thread' {
    return this.size > 0 && !this.brokenReason ? 'processes' : 'main-thread';
  }

  /** Threads a long render can use at most. */
  get capacity(): number {
    return this.mode === 'processes' ? this.size : 1;
  }

  /** Live render processes (started lazily, stopped when idle). */
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

  /** Stops every render process (resolves once they exited, at most 5 s) and rejects waiting leases. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const w of this.waiters.splice(0)) {
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.reject(new RenderCancelledError('render pool closed'));
    }
    const exits = [...this.workers].map((t) => t.terminate());
    this.workers.clear();
    this.free.clear();
    this.holders.clear();
    if (!exits.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(exits),
      new Promise<void>((r) => {
        timer = setTimeout(r, 5000);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /** Hands threads to waiting renders, starting threads when needed. */
  private dispatch(): void {
    for (let round = 0; round < 2 && !this.closed; round++) {
      let longBlocked = false;
      for (let i = 0; i < this.waiters.length;) {
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
   * Starts the render processes waiting renders need: every render thread for a long render, the
   * process kept for interactive renders (and idle render threads when several wait). Returns true
   * when threads became available at once (main thread fallback).
   */
  private ensureThreads(): boolean {
    if (this.closed) return false;
    if (this.mode === 'processes') {
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
      for (let n = bulk; n < target && this.mode === 'processes'; n++) this.spawn('bulk');
    }
    // single-thread mode (configured, or render processes could not start)
    if (this.mode === 'processes' || this.main) return false;
    this.main = new MainThread(this.nextThreadId++);
    this.free.add(this.main);
    return true;
  }

  private spawn(role: Role): void {
    let t: ProcessThread;
    const t0 = performance.now();
    try {
      t = new ProcessThread(
        this.nextThreadId++,
        role,
        this.workerUrl!,
        {
          heapLimitMb: this.heapLimitMb,
          startTimeoutMs: this.startTimeoutMs,
          closeFallbackMs: this.closeFallbackMs,
          docPartBytes: this.docPartBytes,
        },
        (thread, err) => this.onWorkerExit(thread, err),
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
          this.log?.debug?.(
            {
              thread: t.id,
              pid: t.pid,
              role,
              heapLimitMb: t.heapLimitMb,
              ms: Math.round(performance.now() - t0),
            },
            'render process started',
          );
          if (t.alive && !this.closed) {
            t.lastUsed = Date.now();
            this.free.add(t);
          }
        },
        (err: unknown) => {
          this.workers.delete(t);
          if (this.closed) return;
          if (++this.startFailures >= 3) this.markBroken(err);
          else this.log?.warn({ err: String(err) }, 'render process failed to start');
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
      'render processes unavailable: rendering on the main thread',
    );
    for (const t of [...this.workers]) void t.terminate();
    this.workers.clear();
    this.free.clear();
    this.booting.clear();
  }

  private onWorkerExit(t: ProcessThread, err: Error): void {
    const known = this.workers.delete(t);
    this.free.delete(t);
    this.holders.delete(t);
    // a process that never became ready is reported as a failed start (see spawn)
    if (known && t.started && !(err instanceof RenderCancelledError) && !this.closed) {
      if (err instanceof RenderOutOfMemoryError)
        this.log?.warn(
          { err: err.message, thread: t.id, pid: t.pid, heapLimitMb: err.heapLimitMb },
          'render process ran out of memory: its renders failed, a new process serves the next ones',
        );
      else
        this.log?.warn({ err: err.message, thread: t.id, pid: t.pid }, 'render process stopped unexpectedly');
    }
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
    if (t instanceof ProcessThread && t.pending > 0 && t.alive) {
      this.draining.add(t);
      try {
        const drained = await t.drain(this.drainTimeoutMs);
        if (!drained) {
          this.log?.warn({ thread: t.id, pid: t.pid }, 'stopping a render process busy with cancelled work');
          void t.terminate();
        }
      } finally {
        this.draining.delete(t);
      }
    }
    if (t.alive && !this.closed && !this.holders.has(t)) {
      if (t instanceof ProcessThread) t.lastUsed = Date.now();
      this.free.add(t);
    }
    this.dispatch();
  }

  private sweep(): void {
    const now = Date.now();
    for (const t of [...this.free]) {
      if (!(t instanceof ProcessThread) || t.pending > 0) continue;
      const idle = now - t.lastUsed;
      if (idle >= this.idleTimeoutMs) {
        this.free.delete(t);
        this.workers.delete(t);
        void t.terminate();
      } else if (idle >= this.cacheIdleMs) t.clearCaches();
    }
  }
}

function roleOf(t: RenderThread): Role {
  return t instanceof ProcessThread ? t.role : 'bulk';
}
