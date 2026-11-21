import { openThumbnailCache, type ThumbnailCache } from './cache';
import { specSize, thumbnailBuild, thumbnailKey, catalogModelId, type ThumbnailSpec } from './keys';
import { THUMBNAIL_WORKER_URL, ThumbnailRenderError, ThumbnailWorkerPool } from './pool';
import { ThumbnailQueue, higherPriority, type ThumbnailPriority } from './queue';
import type { ThumbnailErrorCode } from './protocol';

/*
 * Thumbnails of the built-in models, made in this browser (never asked of the editor server, which
 * can then serve many more users): a tile asks for its model's thumbnail when it comes near the
 * visible part of the list, and gets an object URL of the PNG, from
 *   1. memory (made or read earlier on this page),
 *   2. the cache this browser keeps across reloads (cache.ts; readable offline), or
 *   3. a thumbnail worker (pool.ts), queued by priority (tiles on screen first) behind the
 *      thumbnails already waiting.
 * Several tiles asking for one thumbnail share one render. A tile that leaves the view lets its
 * request go: a thumbnail nobody waits for leaves the queue (one already rendering is finished and
 * kept). When the page goes away the workers stop; a page restored from the back/forward cache
 * starts them again for what is still waiting. A render given to a worker that could not start
 * (its script did not load: the pool renders on the page from then on) is queued again first,
 * once, so the tiles that were waiting for it get their thumbnail rather than a warning.
 */

/** Where a thumbnail came from. */
export type ThumbnailSource = 'memory' | 'cache' | 'render';

/** A thumbnail ready to show. */
export interface ThumbnailImage {
  /** Object URL of the PNG (valid while the page keeps it, see MAX_MEMORY_THUMBNAILS). */
  url: string;
  source: ThumbnailSource;
  /** Bytes of the PNG. */
  bytes: number;
}

/** Why a thumbnail is not there: the worker's code, CANCELLED (nobody waits), STOPPED/CRASHED. */
export type ThumbnailFailure = ThumbnailErrorCode | 'CANCELLED' | 'STOPPED' | 'CRASHED';

export class ThumbnailError extends Error {
  constructor(
    message: string,
    readonly code: ThumbnailFailure,
  ) {
    super(message);
    this.name = 'ThumbnailError';
  }
}

/** One tile's request for a thumbnail. */
export interface ThumbnailTicket {
  /** The thumbnail, or why there is none (a ThumbnailError). */
  readonly promise: Promise<ThumbnailImage>;
  /** The tile came on screen or left it. */
  setPriority(priority: ThumbnailPriority): void;
  /** The tile no longer needs it. */
  cancel(): void;
}

/** What the service did (tests, measurements). */
export interface ThumbnailStats {
  /** Thumbnails rendered by the workers, and the workers' milliseconds for each. */
  renders: number;
  renderMs: number[];
  /** Thumbnails read from the persistent cache. */
  cacheHits: number;
  /** Requests answered from memory. */
  memoryHits: number;
  failures: number;
  /** Queued thumbnails taken out of the queue because nobody waited for them any more. */
  cancelled: number;
  queued: number;
  running: number;
  /** Workers started (over the page's life). */
  workersStarted: number;
}

/** Thumbnails kept in memory as object URLs (the built-in catalog has about 170). */
export const MAX_MEMORY_THUMBNAILS = 400;

type EntryState = 'lookup' | 'queued' | 'running' | 'done' | 'failed';

class Ticket implements ThumbnailTicket {
  priority: ThumbnailPriority;
  readonly promise: Promise<ThumbnailImage>;
  private active = true;

  constructor(
    private readonly entry: Entry,
    priority: ThumbnailPriority,
    private readonly service: ThumbnailService,
    promise: Promise<ThumbnailImage>,
  ) {
    this.priority = priority;
    this.promise = promise;
  }

  setPriority(priority: ThumbnailPriority): void {
    if (!this.active || priority === this.priority) return;
    this.priority = priority;
    this.service.reprioritize(this.entry);
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.service.release(this.entry, this);
  }
}

interface Entry {
  key: string;
  spec: ThumbnailSpec;
  state: EntryState;
  tickets: Set<Ticket>;
  promise: Promise<ThumbnailImage>;
  resolve: (img: ThumbnailImage) => void;
  reject: (err: ThumbnailError) => void;
  image: ThumbnailImage | null;
  error: ThumbnailError | null;
  /** The render run (a pause re-queues the entry; the run's late answer is then ignored). */
  run: number;
  /** Queued again after its worker could not start (once: the page's own failure is the answer). */
  rerun: boolean;
}

export interface ThumbnailServiceOptions {
  /** The build id (default: from the worker bundle and the app version, see keys.ts). */
  build?: string;
  cache?: ThumbnailCache;
  pool?: ThumbnailWorkerPool;
  /** Makes and frees the object URLs (tests). */
  urls?: { create(png: Uint8Array): string; revoke(url: string): void };
  memoryEntries?: number;
}

const blobUrls = {
  create: (png: Uint8Array) => URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' })),
  revoke: (url: string) => URL.revokeObjectURL(url),
};

/** User Timing of a rendered thumbnail (measurements read them in the browser). */
function measure(model: string, start: number, workerMs: number): void {
  try {
    performance.measure('thumbnail', { start, end: performance.now(), detail: { model, workerMs } });
  } catch {
    // no User Timing Level 3: nothing to report
  }
}

export class ThumbnailService {
  readonly build: string;
  private readonly cache: ThumbnailCache;
  private readonly pool: ThumbnailWorkerPool;
  private readonly urls: { create(png: Uint8Array): string; revoke(url: string): void };
  private readonly memoryEntries: number;
  private readonly entries = new Map<string, Entry>();
  /** Done entries, least recently used first. */
  private readonly done = new Set<Entry>();
  private readonly queue = new ThumbnailQueue<Entry>();
  private paused = false;
  private disposed = false;
  private runs = 0;
  private readonly counters = { renders: 0, cacheHits: 0, memoryHits: 0, failures: 0, cancelled: 0 };
  private readonly renderMs: number[] = [];

  constructor(opts: ThumbnailServiceOptions = {}) {
    this.build = opts.build ?? thumbnailBuild(THUMBNAIL_WORKER_URL, __APP_VERSION__);
    this.cache = opts.cache ?? openThumbnailCache(this.build);
    this.pool = opts.pool ?? new ThumbnailWorkerPool();
    this.urls = opts.urls ?? blobUrls;
    this.memoryEntries = opts.memoryEntries ?? MAX_MEMORY_THUMBNAILS;
  }

  /** Asks for the thumbnail of `spec` (see the module comment). */
  request(spec: ThumbnailSpec, priority: ThumbnailPriority = 'near'): ThumbnailTicket {
    const key = thumbnailKey(this.build, spec);
    let entry = this.entries.get(key);
    if (entry?.state === 'done' && entry.image) {
      this.counters.memoryHits++;
      this.done.delete(entry);
      this.done.add(entry);
      const img: ThumbnailImage = { ...entry.image, source: 'memory' };
      return new Ticket(entry, priority, this, Promise.resolve(img));
    }
    if (entry?.state === 'failed') return new Ticket(entry, priority, this, entry.promise);
    if (!entry) {
      entry = this.newEntry(key, { ...spec, model: catalogModelId(spec.model), size: specSize(spec) });
      const ticket = new Ticket(entry, priority, this, entry.promise);
      entry.tickets.add(ticket);
      void this.lookup(entry);
      return ticket;
    }
    const ticket = new Ticket(entry, priority, this, entry.promise);
    entry.tickets.add(ticket);
    this.reprioritize(entry);
    return ticket;
  }

  private newEntry(key: string, spec: ThumbnailSpec): Entry {
    let resolve!: (img: ThumbnailImage) => void;
    let reject!: (err: ThumbnailError) => void;
    const promise = new Promise<ThumbnailImage>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // tiles that let their request go do not listen any more
    promise.catch(() => undefined);
    const entry: Entry = {
      key,
      spec,
      state: 'lookup',
      tickets: new Set(),
      promise,
      resolve,
      reject,
      image: null,
      error: null,
      run: 0,
      rerun: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** The priority an entry's tiles want (the highest of theirs). */
  private priorityOf(entry: Entry): ThumbnailPriority {
    let p: ThumbnailPriority = 'near';
    for (const t of entry.tickets) p = higherPriority(p, t.priority);
    return p;
  }

  /** @internal A tile of `entry` changed priority. */
  reprioritize(entry: Entry): void {
    if (entry.state === 'queued') this.queue.setPriority(entry.key, this.priorityOf(entry));
  }

  /** @internal A tile let its request for `entry` go. */
  release(entry: Entry, ticket: Ticket): void {
    entry.tickets.delete(ticket);
    if (entry.tickets.size || entry.state !== 'queued') return;
    // nobody waits for it: out of the queue (a lookup or a render under way finishes and is kept)
    this.queue.remove(entry.key);
    this.counters.cancelled++;
    this.forget(entry, new ThumbnailError('Nobody waits for this thumbnail', 'CANCELLED'));
  }

  /** Drops an entry that is not done (a later request starts over). */
  private forget(entry: Entry, err: ThumbnailError): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.state = 'failed';
    entry.error = err;
    entry.reject(err);
  }

  /** Reads the cache, then queues a render if the thumbnail is not there. */
  private async lookup(entry: Entry): Promise<void> {
    let png: Uint8Array | null;
    try {
      png = await this.cache.get(entry.key);
    } catch {
      png = null;
    }
    if (this.disposed || this.entries.get(entry.key) !== entry) return;
    if (png) {
      this.counters.cacheHits++;
      this.finish(entry, png, 'cache');
      return;
    }
    if (!entry.tickets.size) {
      this.counters.cancelled++;
      this.forget(entry, new ThumbnailError('Nobody waits for this thumbnail', 'CANCELLED'));
      return;
    }
    entry.state = 'queued';
    this.queue.add(entry.key, entry, this.priorityOf(entry));
    this.pump();
  }

  /** Starts the next thumbnails while workers are free. */
  private pump(): void {
    while (!this.paused && !this.disposed && this.queue.size && this.pool.free > 0) {
      const next = this.queue.take();
      if (!next) break;
      void this.render(next.value);
    }
  }

  private async render(entry: Entry): Promise<void> {
    entry.state = 'running';
    const run = (entry.run = ++this.runs);
    const start = performance.now();
    try {
      const done = await this.pool.run({
        model: entry.spec.model,
        size: entry.spec.size ?? specSize(entry.spec),
        ...(entry.spec.params ? { params: entry.spec.params } : {}),
      });
      if (entry.run !== run || this.disposed) return;
      this.counters.renders++;
      this.renderMs.push(done.ms);
      measure(entry.spec.model, start, done.ms);
      this.finish(entry, done.png, 'render');
      // kept for the next page loads (a failed write only means a render then)
      void this.cache.put(entry.key, done.png).catch(() => undefined);
    } catch (err) {
      if (entry.run !== run || this.disposed) return;
      if (err instanceof ThumbnailRenderError && err.notStarted && !entry.rerun && entry.tickets.size) {
        // its worker could not start, and the pool renders on the page now: made there, first
        entry.rerun = true;
        entry.state = 'queued';
        this.queue.add(entry.key, entry, this.priorityOf(entry), true);
        return;
      }
      const e =
        err instanceof ThumbnailRenderError
          ? new ThumbnailError(err.message, err.code)
          : new ThumbnailError(err instanceof Error ? err.message : String(err), 'FAILED');
      if (e.code === 'STOPPED' || e.code === 'CRASHED') {
        // not the model's fault: a later request tries again
        this.forget(entry, e);
      } else {
        // the model cannot be made (in this build): every later request gets the same answer
        entry.state = 'failed';
        entry.error = e;
        entry.reject(e);
      }
      this.counters.failures++;
    } finally {
      this.pump();
    }
  }

  private finish(entry: Entry, png: Uint8Array, source: ThumbnailSource): void {
    entry.image = { url: this.urls.create(png), source, bytes: png.byteLength };
    entry.state = 'done';
    entry.tickets.clear();
    this.done.add(entry);
    entry.resolve(entry.image);
    // the oldest thumbnails leave memory (their URLs are freed; the cache still has them)
    for (const old of this.done) {
      if (this.done.size <= this.memoryEntries) break;
      this.done.delete(old);
      if (this.entries.get(old.key) === old) this.entries.delete(old.key);
      if (old.image) this.urls.revoke(old.image.url);
    }
  }

  stats(): ThumbnailStats {
    let running = 0;
    for (const e of this.entries.values()) if (e.state === 'running') running++;
    return {
      ...this.counters,
      renderMs: [...this.renderMs],
      queued: this.queue.size,
      running,
      workersStarted: this.pool.workersStarted,
    };
  }

  /** The page goes away: the workers stop and what they were rendering waits again. */
  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    for (const e of [...this.entries.values()]) {
      if (e.state !== 'running') continue;
      // its run's answer (STOPPED) is ignored; it renders again when the page comes back, if a
      // tile still waits for it
      e.run = 0;
      if (!e.tickets.size) {
        this.forget(e, new ThumbnailError('Nobody waits for this thumbnail', 'CANCELLED'));
        continue;
      }
      e.state = 'queued';
      this.queue.add(e.key, e, this.priorityOf(e), true);
    }
    this.pool.stop();
  }

  /** The page is shown again (back/forward cache): what waits renders. */
  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    this.pump();
  }

  /** Stops everything and frees the URLs (tests, and pages that replace the service). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.stop();
    for (const e of this.queue.clear())
      e.reject(new ThumbnailError('The thumbnails were stopped', 'STOPPED'));
    for (const e of this.done) if (e.image) this.urls.revoke(e.image.url);
    this.done.clear();
    this.entries.clear();
    this.cache.close();
  }
}

let shared: ThumbnailService | null = null;
let listening = false;

/** The page's thumbnail service (created on first use; stops its workers when the page goes away). */
export function thumbnailService(): ThumbnailService {
  shared ??= new ThumbnailService();
  if (!listening && typeof addEventListener === 'function') {
    listening = true;
    addEventListener('pagehide', () => shared?.pause());
    addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) shared?.resume();
    });
  }
  return shared;
}

/** Replaces the page's thumbnail service (tests); null makes a new one on next use. */
export function setThumbnailService(service: ThumbnailService | null): void {
  shared = service;
}
