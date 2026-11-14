import type { ExportWorkerRequest, ExportWorkerResponse, ExportWorkerResult } from './protocol';
import { ExportWorkerEngine, type JpegEncoder } from './worker-engine';

/*
 * The render workers of a browser export: module workers running export.worker.ts (one CPU core
 * each), started for the export and terminated when it ends, fails or is cancelled. Each holds the
 * export's snapshot and answers one request at a time, in order. Where Web Workers cannot start (and
 * in unit tests) an in-process stand-in runs the same engine on the calling thread between event
 * loop turns.
 */

/** Most render workers of an export (more cores would mostly add memory: each holds the scene). */
export const MAX_EXPORT_WORKERS = 8;

/** What an export needs of a Web Worker (a real one, or the in-process stand-in). */
export interface ExportWorkerLike {
  postMessage(msg: ExportWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<ExportWorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

/** Starts the worker of render thread `index`. */
export type ExportWorkerFactory = (index: number) => ExportWorkerLike;

/** A request without its id (the thread numbers them). */
export type ExportRequest = ExportWorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never;

/** The render worker module (its own bundle in production builds). */
export const moduleWorkerFactory: ExportWorkerFactory = (index) =>
  new Worker(new URL('./export.worker.ts', import.meta.url), {
    type: 'module',
    name: `export-${index}`,
  }) as unknown as ExportWorkerLike;

/** Runs the worker's engine on the calling thread, one request per event loop turn. */
export class InProcessExportWorker implements ExportWorkerLike {
  onmessage: ((e: MessageEvent<ExportWorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  readonly engine: ExportWorkerEngine;

  constructor(jpeg?: JpegEncoder) {
    this.engine = new ExportWorkerEngine(jpeg);
  }

  postMessage(msg: ExportWorkerRequest): void {
    this.queue = this.queue.then(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (this.closed) return;
      const { response } = await this.engine.handle(msg);
      if (!this.closed) this.onmessage?.({ data: response } as MessageEvent<ExportWorkerResponse>);
    });
  }

  terminate(): void {
    this.closed = true;
    this.engine.clear();
  }
}

/** Starts in-process workers (tests; pages without Web Workers). */
export const inProcessWorkerFactory =
  (jpeg?: JpegEncoder): ExportWorkerFactory =>
  () =>
    new InProcessExportWorker(jpeg);

/** An error a render worker answered with (its name, message and export error code kept). */
export class ExportWorkerError extends Error {
  constructor(
    message: string,
    name: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = name;
  }
}

/** One render worker of an export: requests are numbered and answered in order. */
export class ExportThread {
  private readonly worker: ExportWorkerLike;
  private readonly waiting = new Map<
    number,
    { resolve(r: ExportWorkerResult): void; reject(e: Error): void }
  >();
  private nextId = 1;
  private dead: Error | null = null;

  constructor(
    readonly index: number,
    factory: ExportWorkerFactory,
  ) {
    this.worker = factory(index);
    this.worker.onmessage = (e) => {
      const res = e.data;
      const w = this.waiting.get(res.id);
      if (!w) return;
      this.waiting.delete(res.id);
      if (res.ok) w.resolve(res.result);
      else w.reject(new ExportWorkerError(res.error.message, res.error.name, res.error.code));
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(
        new Error(`render worker ${index + 1} stopped: ${e.message || 'it could not run (out of memory?)'}`),
      );
    };
  }

  /** False once the worker stopped (an uncaught error, or `terminate`). */
  get alive(): boolean {
    return !this.dead;
  }

  /** Requests sent and not answered yet. */
  get pending(): number {
    return this.waiting.size;
  }

  /** Sends a request; resolves with its answer. */
  call<T extends ExportWorkerResult>(req: ExportRequest, transfer: Transferable[] = []): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (r: ExportWorkerResult) => void, reject });
      try {
        this.worker.postMessage({ ...req, id } as ExportWorkerRequest, transfer);
      } catch (err) {
        this.waiting.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }

  /** Stops the worker (its pending requests fail with `reason`). */
  terminate(reason: Error = new Error('the render worker was stopped')): void {
    this.fail(reason);
    this.worker.terminate();
  }
}
