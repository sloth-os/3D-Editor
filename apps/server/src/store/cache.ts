import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Log } from '../observability/log';
import { errorMessage } from '../observability/tracing';
import { StoreCancelledError } from './http';

/*
 * The model store's disk cache (MODEL_CACHE_DIR):
 *
 *   index/<key>.json          provider indexes and API answers ({fetched_at, data}; TTL, see json())
 *   models/<group>/<hash>/    a downloaded model: its files and manifest.json
 *   thumbs/<group>/<hash>/    a thumbnail: the image and manifest.json
 *   tmp/                      work directories (renamed into place when complete) and entries
 *                             being deleted (renamed out of place first)
 *
 * Models and thumbnails are entries of one least-recently-used budget (MODEL_CACHE_MAX_MB): every
 * entry is built in a temporary directory and renamed into place in one step (a crash never leaves
 * a half-written entry where readers look), concurrent requests for the same entry share one build
 * (which only stops when every requester went away), entries being read are pinned (eviction skips
 * them), an entry stays for a grace period after its last reader released it (a model fetched file
 * by file is not downloaded again for each file) and the least recently used ones are deleted when
 * the cache is over budget. An entry larger than the whole budget is still built and used, then
 * dropped once nobody read it for the grace period. A dropped entry's directory is renamed out of
 * place before it is deleted, so a new build of the same entry never meets a half-deleted directory.
 * Last use times survive restarts (the manifest's mtime).
 *
 * JSON loads (indexes, API answers) are shared by concurrent callers and run on when their callers
 * stop waiting (a search's deadline, a client gone), up to an overall limit, so a later caller finds
 * them cached. Index files are small and bounded by the providers' catalogs: they are not part of
 * the budget; files not written for a week are removed at startup.
 */

/** A file of a cache entry. */
export interface CachedFile {
  /** Path inside the entry (forward slashes). */
  path: string;
  bytes: number;
  sha256: string;
  /** Media type, when known. */
  type?: string;
}

/** What a builder wrote into an entry's directory. */
export interface EntryContent {
  files: CachedFile[];
  /** Anything the reader needs besides the files (format, main file …). */
  meta?: Record<string, unknown>;
}

interface Manifest extends EntryContent {
  version: 1;
  key: string;
  created_at: string;
}

interface Entry {
  hash: string;
  key: string;
  kind: CacheKind;
  dir: string;
  bytes: number;
  lastUsed: number;
  pins: number;
  /** Just built and not read yet: eviction keeps it until its requesters pin it (or a minute passes). */
  fresh: ReturnType<typeof setTimeout> | null;
  manifest: Manifest;
}

export type CacheKind = 'models' | 'thumbs';

/** A pinned cache entry: read its files, then release it (eviction skips it until then). */
export interface CacheHandle {
  readonly key: string;
  readonly dir: string;
  readonly files: readonly CachedFile[];
  readonly meta: Record<string, unknown>;
  /** The bytes of a file of the entry. */
  read(file: string): Promise<Uint8Array>;
  /** Where a file of the entry is on disk (read or stream it while the handle is held). */
  path(file: string): string;
  release(): void;
}

export interface ModelCacheOptions {
  dir: string;
  /** The budget of models and thumbnails in bytes (0: nothing is kept after the grace period). */
  maxBytes: number;
  log: Log;
  /** Clock (tests). */
  now?: () => number;
  /**
   * How long an entry nobody reads any more is kept before it may be evicted (default 60 s; 0:
   * evictable at once).
   */
  releaseGraceMs?: number;
  /** Longest a JSON load runs once nobody waits for it any more (default 2 minutes). */
  backgroundLoadMs?: number;
}

interface Shared<T> {
  promise: Promise<T>;
  waiters: number;
  controller: AbortController;
}

const MANIFEST = 'manifest.json';
/** Entries of the in-memory JSON cache (oldest dropped first). */
const MAX_MEMORY_JSON = 4000;
/** Temporary directories older than this are left over from a crash and removed. */
const STALE_TMP_MS = 60 * 60 * 1000;
/** How long a new entry is kept for its requesters before it may be evicted unread. */
const FRESH_MS = 60_000;
/** How long an entry is kept after its last reader released it (see ModelCacheOptions). */
const RELEASE_GRACE_MS = 60_000;
/** Longest a JSON load runs on once nobody waits for it any more. */
const BACKGROUND_LOAD_MS = 2 * 60_000;
/** Index files not written for this long are removed at startup (a provider's own index is
 * written again every day while it answers; per-model API answers pile up otherwise). */
const INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A file name for `key` (stable, filesystem-safe). */
export function cacheHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 40);
}

/** A directory name for a group ('khronos', 'polyhaven' …). */
function groupName(group: string): string {
  return group.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || '_';
}

/** Shared work that has settled (its controller is not aborted when the last waiter leaves). */
const doneFlags = new WeakSet<Shared<unknown>>();

/**
 * Waits for `shared` on behalf of one requester: the requester's abort ends its wait (and, with
 * `stopWhenAlone`, the work when it was the last one waiting).
 */
function waitShared<T>(
  shared: Shared<T>,
  signal: AbortSignal | undefined,
  what: string,
  stopWhenAlone = true,
): Promise<T> {
  shared.waiters++;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const leave = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (--shared.waiters === 0 && stopWhenAlone && !doneFlags.has(shared))
        shared.controller.abort(new Error('no requester left'));
    };
    const onAbort = () => {
      leave();
      reject(new StoreCancelledError(what));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (v) => {
        if (settled) return;
        leave();
        resolve(v);
      },
      (err) => {
        if (settled) return;
        leave();
        reject(err);
      },
    );
  });
}
export class ModelCache {
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly building = new Map<string, Shared<Entry>>();
  private readonly memoryJson = new Map<string, { fetchedAt: number; value: unknown }>();
  private readonly loadingJson = new Map<string, Shared<unknown>>();
  /** Directories of dropped entries being renamed out of place, by entry hash. */
  private readonly dropping = new Map<string, Promise<void>>();
  private ready: Promise<void> | null = null;
  private total = 0;
  private closed = false;
  private reads = 0;

  constructor(private readonly opts: ModelCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  get dir(): string {
    return this.opts.dir;
  }

  /** Bytes of the models and thumbnails held. */
  get bytes(): number {
    return this.total;
  }

  /** Files read into memory through handles so far (tests and diagnostics). */
  get filesRead(): number {
    return this.reads;
  }

  /** Keys of the entries held, least recently used first (tests and diagnostics). */
  keys(kind?: CacheKind): string[] {
    return [...this.entries.values()]
      .filter((e) => !kind || e.kind === kind)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .map((e) => e.key);
  }

  // ------------------------------------------------------------------ JSON (indexes, API answers)

  /**
   * A JSON value cached in memory and on disk (index/<key>.json) for `ttlMs`: `load` runs when
   * neither has a fresh copy (once for concurrent callers). When `load` fails, or the caller stops
   * waiting (`signal`: a search's deadline) before it ends, and an older copy exists, the older copy
   * is returned with `stale` set to why (the provider keeps working on its last index while its
   * server is down or slow). A load nobody waits for any more runs on in the background (at most
   * `backgroundLoadMs`), so a later caller finds its value. `disk: false` keeps the value in memory
   * only.
   */
  async json<T>(
    key: string,
    ttlMs: number,
    load: (signal: AbortSignal) => Promise<T>,
    opts: { signal?: AbortSignal; disk?: boolean } = {},
  ): Promise<{ value: T; stale: string | null; fetchedAt: number }> {
    const disk = opts.disk !== false;
    const now = this.now();
    let old = this.memoryJson.get(key) as { fetchedAt: number; value: T } | undefined;
    if (old && now - old.fetchedAt < ttlMs) {
      // most recently used last (the memory map drops its oldest entries)
      this.memoryJson.delete(key);
      this.memoryJson.set(key, old);
      return { value: old.value, stale: null, fetchedAt: old.fetchedAt };
    }
    const file = this.jsonPath(key);
    if (!old && disk) {
      const stored = await readJsonFile<{ fetched_at: number; key: string; data: T }>(file);
      if (stored && stored.key === key && typeof stored.fetched_at === 'number') {
        old = { fetchedAt: stored.fetched_at, value: stored.data };
        this.remember(key, old);
        if (now - old.fetchedAt < ttlMs) return { value: old.value, stale: null, fetchedAt: old.fetchedAt };
      }
    }
    let shared = this.loadingJson.get(key) as Shared<T> | undefined;
    // a load every requester left is being aborted: start another one
    if (shared?.controller.signal.aborted) shared = undefined;
    if (!shared) {
      const controller = new AbortController();
      const limitMs = this.opts.backgroundLoadMs ?? BACKGROUND_LOAD_MS;
      // the load runs on when its callers stop waiting, but not for ever
      const limit = setTimeout(
        () => controller.abort(new Error(`still loading after ${Math.round(limitMs / 1000)} s`)),
        limitMs,
      );
      limit.unref?.();
      const created: Shared<T> = {
        waiters: 0,
        controller,
        promise: (async () => {
          try {
            const value = await load(controller.signal);
            const fetchedAt = this.now();
            this.remember(key, { fetchedAt, value });
            if (disk && !this.closed)
              await writeAtomic(file, JSON.stringify({ fetched_at: fetchedAt, key, data: value })).catch(
                (err) =>
                  this.opts.log.warn({ key, err: errorMessage(err) }, 'model store: writing an index failed'),
              );
            return value;
          } finally {
            clearTimeout(limit);
          }
        })(),
      };
      shared = created;
      this.loadingJson.set(key, created as Shared<unknown>);
      created.promise.then(
        () => doneFlags.add(created as Shared<unknown>),
        () => doneFlags.add(created as Shared<unknown>),
      );
      void created.promise
        .finally(() => {
          if (this.loadingJson.get(key) === (created as Shared<unknown>)) this.loadingJson.delete(key);
        })
        .catch(() => undefined);
    }
    try {
      const value = await waitShared(shared, opts.signal, key, false);
      return { value, stale: null, fetchedAt: (this.memoryJson.get(key)?.fetchedAt as number) ?? this.now() };
    } catch (err) {
      if (!old) throw err;
      const stale = err instanceof StoreCancelledError ? 'the new copy is still loading' : errorMessage(err);
      return { value: old.value, stale, fetchedAt: old.fetchedAt };
    }
  }

  /** A JSON value held in memory, whatever its age (null when there is none). */
  peekJson<T>(key: string): T | null {
    return (this.memoryJson.get(key)?.value as T | undefined) ?? null;
  }

  private remember(key: string, v: { fetchedAt: number; value: unknown }): void {
    this.memoryJson.delete(key);
    this.memoryJson.set(key, v);
    while (this.memoryJson.size > MAX_MEMORY_JSON) {
      const oldest = this.memoryJson.keys().next().value as string;
      this.memoryJson.delete(oldest);
    }
  }

  private jsonPath(key: string): string {
    const readable = key.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60);
    return path.join(this.opts.dir, 'index', `${readable}-${cacheHash(key).slice(0, 16)}.json`);
  }

  // ------------------------------------------------------------------ entries (models, thumbnails)

  /**
   * The entry `key` of `kind` (`group` names its directory, e.g. the provider), built by `build`
   * when the cache does not hold it: `build` writes its files into the directory it gets and lists
   * them. Resolves with the entry pinned: release the handle after reading.
   */
  async entry(
    kind: CacheKind,
    group: string,
    key: string,
    build: (dir: string, signal: AbortSignal) => Promise<EntryContent>,
    signal?: AbortSignal,
  ): Promise<CacheHandle> {
    await this.init();
    // entries left over budget (their requesters went away before reading them)
    void this.evict();
    const hash = cacheHash(`${kind}:${key}`);
    for (let attempt = 0; ; attempt++) {
      const held = this.entries.get(hash);
      if (held) {
        const handle = this.pin(held);
        // a file removed behind our back (someone cleaned the directory): build it again, once
        if (attempt === 0 && !(await this.intact(held))) {
          handle.release();
          this.drop(held);
          continue;
        }
        return handle;
      }
      let shared = this.building.get(hash);
      // a build every requester left is being aborted: start another one
      if (shared?.controller.signal.aborted) shared = undefined;
      if (!shared) {
        const controller = new AbortController();
        const created: Shared<Entry> = {
          waiters: 0,
          controller,
          promise: this.build(kind, group, hash, key, build, controller.signal),
        };
        shared = created;
        this.building.set(hash, created);
        void created.promise
          .then(
            () => doneFlags.add(created as Shared<unknown>),
            () => doneFlags.add(created as Shared<unknown>),
          )
          .finally(() => {
            if (this.building.get(hash) === created) this.building.delete(hash);
          });
      }
      const entry = await waitShared(shared, signal, key);
      // fresh entries are not evicted before their requesters pin them
      return this.pin(entry);
    }
  }

  /** Whether the cache holds `key` (without building or pinning it). */
  has(kind: CacheKind, key: string): boolean {
    return this.entries.has(cacheHash(`${kind}:${key}`));
  }

  /** The files and meta of a held entry, without pinning or building it (null when not held). */
  async peek(kind: CacheKind, key: string): Promise<EntryContent | null> {
    await this.init();
    const e = this.entries.get(cacheHash(`${kind}:${key}`));
    return e ? { files: e.manifest.files, meta: e.manifest.meta ?? {} } : null;
  }

  private pin(e: Entry): CacheHandle {
    e.pins++;
    if (e.fresh) {
      clearTimeout(e.fresh);
      e.fresh = null;
    }
    e.lastUsed = Math.max(this.now(), e.lastUsed + 1);
    // the manifest's mtime keeps the last use across restarts
    const t = new Date(e.lastUsed);
    void utimes(path.join(e.dir, MANIFEST), t, t).catch(() => undefined);
    let released = false;
    const where = (file: string) => {
      const f = e.manifest.files.find((x) => x.path === file);
      if (!f) throw new Error(`no file '${file}' in the cached entry`);
      return path.join(e.dir, ...f.path.split('/'));
    };
    return {
      key: e.key,
      dir: e.dir,
      files: e.manifest.files,
      meta: e.manifest.meta ?? {},
      read: async (file) => {
        const at = where(file);
        this.reads++;
        // the Buffer itself (a copy would double what a large model costs)
        const data = await readFile(at);
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      },
      path: where,
      release: () => {
        if (released) return;
        released = true;
        e.pins--;
        if (e.pins > 0) return;
        // kept for a while for the next request (a model fetched file by file), then evictable
        const grace = this.opts.releaseGraceMs ?? RELEASE_GRACE_MS;
        if (grace > 0 && this.entries.get(e.hash) === e) {
          e.fresh = setTimeout(() => {
            e.fresh = null;
            void this.evict();
          }, grace);
          e.fresh.unref?.();
        } else void this.evict();
      },
    };
  }

  private async intact(e: Entry): Promise<boolean> {
    try {
      for (const f of e.manifest.files) {
        const s = await stat(path.join(e.dir, ...f.path.split('/')));
        if (s.size !== f.bytes) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async build(
    kind: CacheKind,
    group: string,
    hash: string,
    key: string,
    build: (dir: string, signal: AbortSignal) => Promise<EntryContent>,
    signal: AbortSignal,
  ): Promise<Entry> {
    const tmp = path.join(this.opts.dir, 'tmp', `${hash.slice(0, 12)}-${randomBytes(6).toString('hex')}`);
    const finalDir = path.join(this.opts.dir, kind, groupName(group), hash);
    await mkdir(tmp, { recursive: true });
    try {
      const content = await build(tmp, signal);
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
      const manifest: Manifest = {
        version: 1,
        key,
        created_at: new Date(this.now()).toISOString(),
        files: content.files,
        ...(content.meta ? { meta: content.meta } : {}),
      };
      const text = JSON.stringify(manifest);
      await writeFile(path.join(tmp, MANIFEST), text);
      await mkdir(path.dirname(finalDir), { recursive: true });
      // a dropped copy of this entry is renamed out of the way first
      await this.dropping.get(hash);
      try {
        await rename(tmp, finalDir);
      } catch (err) {
        // a directory left over from an earlier run (not in the index): replace it
        if (!isExistsError(err)) throw err;
        await rm(finalDir, { recursive: true, force: true });
        await rename(tmp, finalDir);
      }
      const bytes = content.files.reduce((s, f) => s + f.bytes, 0) + Buffer.byteLength(text);
      const entry: Entry = {
        hash,
        key,
        kind,
        dir: finalDir,
        bytes,
        lastUsed: this.now(),
        pins: 0,
        fresh: null,
        manifest,
      };
      // its requesters pin it right after; should none do (they all went away), it becomes evictable
      entry.fresh = setTimeout(() => {
        entry.fresh = null;
        void this.evict();
      }, FRESH_MS);
      entry.fresh.unref?.();
      this.add(entry);
      return entry;
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private add(e: Entry): void {
    const old = this.entries.get(e.hash);
    if (old) this.total -= old.bytes;
    this.entries.set(e.hash, e);
    this.total += e.bytes;
  }

  /**
   * Forgets entry `e` and deletes its directory: renamed out of place first (a build of the same
   * entry waits for that, see build()), then removed in the background.
   */
  private drop(e: Entry): void {
    if (this.entries.get(e.hash) !== e) return;
    if (e.fresh) clearTimeout(e.fresh);
    e.fresh = null;
    this.entries.delete(e.hash);
    this.total -= e.bytes;
    const warn = (err: unknown) =>
      this.opts.log.warn(
        { dir: e.dir, err: errorMessage(err) },
        'model store: removing a cache entry failed',
      );
    const trash = path.join(
      this.opts.dir,
      'tmp',
      `trash-${e.hash.slice(0, 12)}-${randomBytes(6).toString('hex')}`,
    );
    const moved = rename(e.dir, trash).then(
      () => void rm(trash, { recursive: true, force: true }).catch(warn),
      // not renamed (already gone, or another file system): removed where it is, before a rebuild
      (err: NodeJS.ErrnoException) =>
        err?.code === 'ENOENT' ? undefined : rm(e.dir, { recursive: true, force: true }).catch(warn),
    );
    this.dropping.set(e.hash, moved);
    void moved.finally(() => {
      if (this.dropping.get(e.hash) === moved) this.dropping.delete(e.hash);
    });
  }

  /** Deletes least recently used, unpinned entries until the cache fits its budget. */
  async evict(): Promise<void> {
    if (this.total <= this.opts.maxBytes) return;
    const candidates = [...this.entries.values()]
      .filter((e) => e.pins === 0 && !e.fresh)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of candidates) {
      if (this.total <= this.opts.maxBytes) break;
      this.drop(e);
      this.opts.log.debug({ key: e.key, bytes: e.bytes }, 'model store: cache entry evicted');
    }
  }

  // ------------------------------------------------------------------ startup and shutdown

  /** Reads the entries already on disk (once) and removes leftovers of interrupted builds. */
  init(): Promise<void> {
    this.ready ??= this.scan().catch((err) => {
      this.opts.log.warn(
        { dir: this.opts.dir, err: errorMessage(err) },
        'model store: reading the cache failed',
      );
    });
    return this.ready;
  }

  private async scan(): Promise<void> {
    await mkdir(path.join(this.opts.dir, 'tmp'), { recursive: true });
    const now = this.now();
    for (const name of await readdir(path.join(this.opts.dir, 'tmp')).catch(() => [] as string[])) {
      const p = path.join(this.opts.dir, 'tmp', name);
      const s = await stat(p).catch(() => null);
      // deleted entries whose removal a stop interrupted, and builds an hour old (a crash)
      if (s && (name.startsWith('trash-') || now - s.mtimeMs > STALE_TMP_MS))
        await rm(p, { recursive: true, force: true }).catch(() => undefined);
    }
    // index files not written for a week (per-model API answers of models nobody looks at now)
    const index = path.join(this.opts.dir, 'index');
    for (const name of await readdir(index).catch(() => [] as string[])) {
      const p = path.join(index, name);
      const s = await stat(p).catch(() => null);
      if (s && now - s.mtimeMs > INDEX_MAX_AGE_MS) await rm(p, { force: true }).catch(() => undefined);
    }
    for (const kind of ['models', 'thumbs'] as const) {
      const root = path.join(this.opts.dir, kind);
      for (const group of await readdir(root).catch(() => [] as string[]))
        for (const hash of await readdir(path.join(root, group)).catch(() => [] as string[])) {
          const dir = path.join(root, group, hash);
          const manifestPath = path.join(dir, MANIFEST);
          const manifest = await readJsonFile<Manifest>(manifestPath);
          const s = await stat(manifestPath).catch(() => null);
          if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !s) {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
          if (cacheHash(`${kind}:${manifest.key}`) !== hash) continue;
          const bytes = manifest.files.reduce((sum, f) => sum + (f.bytes || 0), 0) + s.size;
          this.add({
            hash,
            key: manifest.key,
            kind,
            dir,
            bytes,
            lastUsed: s.mtimeMs,
            pins: 0,
            fresh: null,
            manifest,
          });
        }
    }
    await this.evict();
  }

  /** Stops builds nobody waits for any more and waits for running ones to settle. */
  async close(): Promise<void> {
    this.closed = true;
    for (const e of this.entries.values())
      if (e.fresh) {
        clearTimeout(e.fresh);
        e.fresh = null;
      }
    for (const s of this.building.values()) s.controller.abort(new Error('the server is shutting down'));
    for (const s of this.loadingJson.values()) s.controller.abort(new Error('the server is shutting down'));
    await Promise.allSettled([
      ...[...this.building.values()].map((s) => s.promise),
      ...[...this.loadingJson.values()].map((s) => s.promise),
    ]);
  }
}

function isExistsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Writes `file` through a temporary file and a rename (readers never see half a file). */
export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
