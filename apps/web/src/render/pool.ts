import * as Y from 'yjs';
import type { SceneDoc } from '@3d-editor/core';
import { RenderWorkerEngine, handleWorkerMessage } from './worker-engine';
import {
  RenderCancelledError,
  RenderMemoryError,
  StaleDocumentError,
  type DocPayload,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from './protocol';

/*
 * A pool of render workers (one CPU core each, `navigator.hardwareConcurrency` capped at
 * MAX_THREADS). Workers are started on first use and stopped after a while without work, which
 * frees the documents and caches they hold. Where Web Workers cannot start, a single in-process
 * "worker" runs the same code on the main thread between event loop turns.
 */

/** Most render workers (more cores would mostly add memory: every rendering worker holds a copy of the scene). */
export const MAX_THREADS = 8;
/** Workers without work are stopped after this long (milliseconds). */
const IDLE_TIMEOUT_MS = 90_000;

/** What the pool needs of a Web Worker (a real one, or an in-process stand-in). */
export interface WorkerLike {
  postMessage(msg: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

/** Creates the worker of thread `index`. */
export type WorkerFactory = (index: number) => WorkerLike;

/** A request without its id (the thread assigns ids). */
export type RenderRequest = WorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never;

/** Requests that get no response. */
type Notification = Extract<WorkerRequest, { type: 'release' | 'encode-abort' }>;

/** Default number of render workers: the CPU cores, at most {@link MAX_THREADS}. */
export function defaultThreadCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  return Math.max(1, Math.min(MAX_THREADS, Math.floor(cores) || 4));
}

/** The render worker module (a separate bundle in production builds, precached by the PWA). */
function startModuleWorker(index: number): WorkerLike {
  return new Worker(new URL('./render.worker.ts', import.meta.url), {
    type: 'module',
    name: `render-${index}`,
  }) as unknown as WorkerLike;
}

/**
 * Runs the worker code on the calling thread, one request per event loop turn (the fallback where
 * Web Workers are unavailable, and the worker of unit tests).
 */
export class InProcessWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private readonly engine: RenderWorkerEngine;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(engine = new RenderWorkerEngine()) {
    this.engine = engine;
  }

  postMessage(msg: WorkerRequest): void {
    this.queue = this.queue.then(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (this.closed) return;
      await handleWorkerMessage(this.engine, msg, (res) => {
        if (!this.closed) this.onmessage?.({ data: res } as MessageEvent<WorkerResponse>);
      });
    });
  }

  terminate(): void {
    this.closed = true;
    this.engine.clear();
  }
}

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };

/** One render worker and its calls. */
export class RenderThread {
  /** Key and Yjs state vector of the document last sent to the worker (see {@link docPayload}). */
  docKey: string | null = null;
  stateVector: Uint8Array | null = null;
  private readonly calls = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the worker ever answered (a worker failing before that could not start). */
  private answered = false;

  constructor(
    readonly index: number,
    private readonly worker: WorkerLike,
    readonly kind: 'worker' | 'main',
    private readonly idleMs: number,
    private readonly onStop: (t: RenderThread, startupFailure: boolean) => void,
  ) {
    worker.onmessage = (e) => this.onMessage(e.data);
    worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(new Error(`Render worker failed: ${e.message || 'unknown error'}`));
    };
  }

  /** False once the worker failed or was stopped. */
  get alive(): boolean {
    return !this.failure;
  }

  /** Requests sent and not answered yet. */
  get pending(): number {
    return this.calls.size;
  }

  /** Calls the worker; requests are handled one at a time, in order. */
  call<T extends WorkerResult>(req: RenderRequest, transfer: Transferable[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    this.clearIdle();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: never) => void, reject });
      try {
        this.worker.postMessage({ ...req, id } as WorkerRequest, transfer);
      } catch (err) {
        this.calls.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Sends a request that gets no response (release, encode-abort). */
  notify(req: Notification): void {
    if (!this.failure) this.worker.postMessage(req);
  }

  private onMessage(m: WorkerResponse): void {
    this.answered = true;
    const c = this.calls.get(m.id);
    if (!c) return;
    this.calls.delete(m.id);
    if (m.type === 'error')
      c.reject(
        m.code === 'STALE_DOCUMENT'
          ? new StaleDocumentError(m.message)
          : m.code === 'RENDER_MEMORY'
            ? new RenderMemoryError(m.message)
            : new Error(m.message),
      );
    else c.resolve(m.result as never);
    if (!this.calls.size) this.scheduleIdle();
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.idleMs > 0 && Number.isFinite(this.idleMs))
      this.idleTimer = setTimeout(() => {
        if (!this.calls.size) this.stop(new RenderCancelledError('Render worker stopped (idle)'));
      }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private fail(err: Error, crashed = true): void {
    if (this.failure) return;
    this.failure = err;
    this.clearIdle();
    for (const c of this.calls.values()) c.reject(err);
    this.calls.clear();
    this.onStop(this, crashed && !this.answered && this.kind === 'worker');
  }

  /** Stops the worker; pending calls are rejected with `reason`. */
  stop(reason: Error = new RenderCancelledError('Render worker stopped')): void {
    this.fail(reason, false);
    try {
      this.worker.terminate();
    } catch {
      /* already gone */
    }
  }
}

export interface RenderPoolOptions {
  /** Number of workers (default: {@link defaultThreadCount}). */
  size?: number;
  /** Worker constructor (default: the module worker; tests pass in-process workers). */
  factory?: WorkerFactory;
  /** Idle workers are stopped after this many milliseconds (default 90 s; 0 = never). */
  idleMs?: number;
}

/** The render workers of the editor. */
export class RenderPool {
  private size: number;
  private readonly threads: (RenderThread | null)[] = [];
  private readonly factory: WorkerFactory;
  private readonly idleMs: number;
  /** Set when Web Workers could not start: one in-process worker is used instead. */
  private fallback = false;

  constructor(opts: RenderPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(opts.size ?? defaultThreadCount()));
    this.factory = opts.factory ?? startModuleWorker;
    this.idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS;
  }

  /** Number of threads renders use. */
  get threadCount(): number {
    return this.size;
  }

  /** True when rendering runs on the main thread (no Web Workers). */
  get inProcess(): boolean {
    return this.fallback;
  }

  /** Every thread of the pool (started as needed; failed or stopped ones are replaced). */
  acquire(): RenderThread[] {
    const out: RenderThread[] = [];
    for (let i = 0; i < this.size; i++) out.push(this.thread(i));
    return out;
  }

  /** Thread `index` (started if needed). */
  thread(index = 0): RenderThread {
    const i = Math.max(0, Math.min(this.size - 1, Math.floor(index)));
    const t = this.threads[i];
    if (t?.alive) return t;
    const created = this.start(i);
    this.threads[i] = created;
    return created;
  }

  private start(index: number): RenderThread {
    const onStop = (t: RenderThread, startupFailure: boolean) => {
      if (this.threads[t.index] === t) this.threads[t.index] = null;
      // a worker that never answered could not start (blocked or missing script): stop trying
      if (startupFailure) this.useMainThread(new Error('render worker failed to start'));
    };
    if (!this.fallback) {
      try {
        return new RenderThread(index, this.factory(index), 'worker', this.idleMs, onStop);
      } catch (err) {
        this.useMainThread(err);
      }
    }
    return new RenderThread(0, new InProcessWorker(), 'main', this.idleMs, onStop);
  }

  private useMainThread(reason: unknown): void {
    if (this.fallback) return;
    console.warn('Render workers are unavailable; rendering on the main thread', reason);
    this.fallback = true;
    this.size = 1;
    const old = this.threads.splice(0);
    for (const t of old) t?.stop();
  }

  /** Stops every worker. */
  dispose(): void {
    for (const t of this.threads) t?.stop();
    this.threads.length = 0;
  }
}

/** Unique key per document instance (workers cache one document by key). */
const docKeys = new WeakMap<SceneDoc, string>();
let docKeyCounter = 0;

/** The key identifying a document instance in render workers. */
export function documentKey(doc: SceneDoc): string {
  let k = docKeys.get(doc);
  if (!k) {
    k = `doc-${++docKeyCounter}-${Math.random().toString(36).slice(2, 10)}`;
    docKeys.set(doc, k);
  }
  return k;
}

/**
 * Builds the document updates of one render for several threads: the whole state for threads that
 * do not have this document yet, only the difference to what a thread already has otherwise.
 * Threads with the same state share one update. Call {@link DocumentSnapshot.payload} right before
 * posting (it records what the thread will have).
 */
export class DocumentSnapshot {
  private readonly key: string;
  private readonly stateVector: Uint8Array;
  private readonly updates = new Map<string, DocPayload>();

  constructor(private readonly doc: SceneDoc) {
    this.key = documentKey(doc);
    this.stateVector = Y.encodeStateVector(doc.ydoc);
  }

  /** The update to send to `thread` (and records that the thread then has this state). */
  payload(thread: Pick<RenderThread, 'docKey' | 'stateVector'>): DocPayload {
    const sv = thread.docKey === this.key ? thread.stateVector : null;
    const cacheKey = sv ? svKey(sv) : '';
    let p = this.updates.get(cacheKey);
    if (!p) {
      p = sv
        ? { key: this.key, kind: 'diff', update: Y.encodeStateAsUpdate(this.doc.ydoc, sv) }
        : { key: this.key, kind: 'full', update: Y.encodeStateAsUpdate(this.doc.ydoc) };
      this.updates.set(cacheKey, p);
    }
    thread.docKey = this.key;
    thread.stateVector = this.stateVector;
    return p;
  }
}

function svKey(sv: Uint8Array): string {
  let s = '';
  for (let i = 0; i < sv.length; i++) s += String.fromCharCode(sv[i]);
  return s || 'empty';
}

/** Forgets what a thread has (the next render sends it the whole document). */
export function resetThreadDocument(thread: Pick<RenderThread, 'docKey' | 'stateVector'>): void {
  thread.docKey = null;
  thread.stateVector = null;
}

let shared: RenderPool | null = null;

/** The editor's render pool (created on first use). */
export function renderPool(): RenderPool {
  if (!shared) shared = new RenderPool();
  return shared;
}
