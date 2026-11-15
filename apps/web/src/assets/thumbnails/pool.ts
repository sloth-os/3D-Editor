import workerUrl from './thumbnail.worker.ts?worker&url';
import {
  isWorkerResponse,
  type ThumbnailDone,
  type ThumbnailErrorCode,
  type ThumbnailWorkerRequest,
  type ThumbnailWorkerResponse,
} from './protocol';

/*
 * The thumbnail workers: one, or two on machines with four cores or more, so that thumbnails never
 * take the cores the page and its viewport need. Each runs one render at a time; the queue stays on
 * the page (service.ts). Workers start on first use and stop after a while without work (they hold
 * core and its caches), and at once when the page goes away. Where Web Workers cannot start, a
 * stand-in renders on the page itself, one thumbnail per event loop turn: from the start where the
 * browser has none or refuses one, else from the first worker that fails before it ever answered
 * (its script did not load). The render that worker was given did not run: it fails with
 * `notStarted`, so the service asks for it again (on the page now). A stand-in whose own code does
 * not load (the engine's chunk, after a deploy removed it) fails its render the same way and frees
 * its place.
 */

/** URL of the worker bundle (its file name carries the hash of its content in a build). */
export const THUMBNAIL_WORKER_URL: string = workerUrl;
/** Most thumbnail workers. */
export const MAX_THUMBNAIL_WORKERS = 2;
/** Workers without work stop after this long (milliseconds). */
export const WORKER_IDLE_MS = 30_000;

/** Workers for a machine with `cores` cores: 2 from 4 cores up, else 1. */
export function defaultWorkerCount(
  cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0,
): number {
  return Math.floor(cores) >= 4 ? MAX_THUMBNAIL_WORKERS : 1;
}

/** What the pool needs of a worker (a Web Worker, or a stand-in). */
export interface ThumbnailWorkerLike {
  postMessage(msg: ThumbnailWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<unknown>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export type ThumbnailWorkerFactory = (index: number) => ThumbnailWorkerLike;

/** A render that failed: the worker's error code, or STOPPED / CRASHED (worker gone, try again). */
export class ThumbnailRenderError extends Error {
  constructor(
    message: string,
    readonly code: ThumbnailErrorCode | 'STOPPED' | 'CRASHED',
    /**
     * The render never ran: its Web Worker failed before it ever answered (its script did not
     * load), and the pool renders on the page from now on, so asking again renders it there.
     */
    readonly notStarted = false,
  ) {
    super(message);
    this.name = 'ThumbnailRenderError';
  }
}

/** A module Web Worker running thumbnail.worker.ts. */
function moduleWorker(index: number): ThumbnailWorkerLike {
  return new Worker(THUMBNAIL_WORKER_URL, {
    type: 'module',
    name: `thumbnails-${index}`,
  }) as unknown as ThumbnailWorkerLike;
}

/** The worker's code, loaded on the page by the stand-in (a chunk of its own in a build). */
export type ThumbnailEngineLoader = () => Promise<Pick<typeof import('./engine'), 'handleThumbnailMessage'>>;

const loadEngine: ThumbnailEngineLoader = () => import('./engine');

/** The worker code run on the page, one request per event loop turn (no Web Workers). */
export class InProcessThumbnailWorker implements ThumbnailWorkerLike {
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  /** @param load loads the worker's code (tests give one that fails) */
  constructor(private readonly load: ThumbnailEngineLoader = loadEngine) {}

  postMessage(msg: ThumbnailWorkerRequest): void {
    this.queue = this.queue
      .then(async () => {
        await new Promise<void>((r) => setTimeout(r, 0));
        if (this.closed) return;
        const { handleThumbnailMessage } = await this.load();
        const { response } = handleThumbnailMessage(msg);
        if (!this.closed) this.onmessage?.({ data: response } as MessageEvent<unknown>);
      })
      .catch((err: unknown) => {
        // the code did not load (offline after a deploy removed its chunk, a network failure):
        // the request fails like a worker whose script did not load, and later ones are still
        // answered
        if (this.closed) return;
        const message = err instanceof Error ? err.message : String(err);
        this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
      });
  }

  terminate(): void {
    this.closed = true;
  }
}

/** The default worker: a module Web Worker, or the in-page stand-in where there are none. */
export function defaultWorkerFactory(index: number): ThumbnailWorkerLike {
  return typeof Worker === 'function' ? moduleWorker(index) : new InProcessThumbnailWorker();
}

interface Running {
  id: number;
  resolve: (r: ThumbnailDone) => void;
  reject: (e: ThumbnailRenderError) => void;
}

/** One worker and the render it runs. */
class ThumbnailThread {
  running: Running | null = null;
  /** Whether the worker ever answered (one failing before could not start). */
  answered = false;
  dead = false;

  constructor(
    private readonly worker: ThumbnailWorkerLike,
    /** Whether the worker renders on the page (the stand-in): nowhere else to go when it fails. */
    private readonly onPage: boolean,
    private readonly onDead: (thread: ThumbnailThread, neverStarted: boolean) => void,
  ) {
    worker.onmessage = (e) => this.onMessage(e.data);
    worker.onerror = (e) => {
      e.preventDefault?.();
      this.die(
        new ThumbnailRenderError(`Thumbnail worker failed: ${e.message || 'unknown error'}`, 'CRASHED'),
      );
    };
  }

  run(req: ThumbnailWorkerRequest): Promise<ThumbnailDone> {
    return new Promise<ThumbnailDone>((resolve, reject) => {
      this.running = { id: req.id, resolve, reject };
      try {
        this.worker.postMessage(req);
      } catch (err) {
        this.running = null;
        reject(new ThumbnailRenderError(err instanceof Error ? err.message : String(err), 'CRASHED'));
      }
    });
  }

  private onMessage(data: unknown): void {
    this.answered = true;
    const run = this.running;
    if (!run || !isWorkerResponse(data) || data.id !== run.id) return;
    this.running = null;
    const res: ThumbnailWorkerResponse = data;
    if (res.type === 'done') run.resolve(res);
    else run.reject(new ThumbnailRenderError(res.message, res.code));
  }

  /**
   * Stops the worker; its render fails with `err`, marked `notStarted` when a Web Worker failed
   * before it ever answered (the pool renders on the page from then on: the render can go there).
   */
  die(err: ThumbnailRenderError): void {
    if (this.dead) return;
    this.dead = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    const run = this.running;
    this.running = null;
    const neverStarted = !this.answered && err.code === 'CRASHED';
    this.onDead(this, neverStarted);
    run?.reject(neverStarted && !this.onPage ? new ThumbnailRenderError(err.message, err.code, true) : err);
  }
}

export interface PoolOptions {
  factory?: ThumbnailWorkerFactory;
  /** The worker that renders on the page where Web Workers cannot start (default: the stand-in). */
  pageWorker?: () => ThumbnailWorkerLike;
  /** Workers at most (default: defaultWorkerCount()). */
  workers?: number;
  idleMs?: number;
}

/** The thumbnail workers, started as renders need them. */
export class ThumbnailWorkerPool {
  private readonly threads: ThumbnailThread[] = [];
  private readonly factory: ThumbnailWorkerFactory;
  private readonly pageWorker: () => ThumbnailWorkerLike;
  /** Whether renders run on the page from now on (Web Workers could not start). */
  private onPage = false;
  readonly size: number;
  private readonly idleMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private started = 0;

  constructor(opts: PoolOptions = {}) {
    this.factory = opts.factory ?? defaultWorkerFactory;
    this.pageWorker = opts.pageWorker ?? (() => new InProcessThumbnailWorker());
    this.size = Math.max(1, Math.floor(opts.workers ?? defaultWorkerCount()));
    this.idleMs = opts.idleMs ?? WORKER_IDLE_MS;
  }

  /** Renders that could start now (free or not yet started workers). */
  get free(): number {
    return this.size - this.threads.filter((t) => t.running).length;
  }

  /** Workers started so far (over the page's life). */
  get workersStarted(): number {
    return this.started;
  }

  /** Workers running now. */
  get alive(): number {
    return this.threads.length;
  }

  /** Renders a thumbnail on a free worker (throws when none is free). */
  run(req: Omit<ThumbnailWorkerRequest, 'id' | 'type'>): Promise<ThumbnailDone> {
    this.clearIdle();
    const thread = this.threads.find((t) => !t.running) ?? this.start();
    const p = thread.run({ ...req, type: 'render', id: this.nextId++ });
    void p.then(
      () => this.idleSoon(),
      () => this.idleSoon(),
    );
    return p;
  }

  private start(): ThumbnailThread {
    if (this.threads.length >= this.size) throw new Error('No thumbnail worker is free');
    let worker: ThumbnailWorkerLike | null = null;
    if (!this.onPage) {
      try {
        worker = this.factory(this.started);
      } catch {
        // Web Workers cannot start here (a policy, a sandbox): render on the page
        this.onPage = true;
      }
    }
    const onPage = !worker || worker instanceof InProcessThumbnailWorker;
    worker ??= this.pageWorker();
    this.started++;
    const thread = new ThumbnailThread(worker, onPage, (t, neverStarted) => {
      this.threads.splice(this.threads.indexOf(t), 1);
      // a worker that never answered could not load its script: render on the page from now on
      if (neverStarted) this.onPage = true;
    });
    this.threads.push(thread);
    return thread;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private idleSoon(): void {
    this.clearIdle();
    if (this.threads.some((t) => t.running)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.threads.some((t) => t.running)) this.stop();
    }, this.idleMs);
  }

  /** Stops every worker; renders running fail with STOPPED (workers start again when needed). */
  stop(): void {
    this.clearIdle();
    for (const t of [...this.threads])
      t.die(new ThumbnailRenderError('The thumbnail workers were stopped', 'STOPPED'));
  }
}
