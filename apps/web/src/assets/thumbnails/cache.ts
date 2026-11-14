import { openDB, type IDBPDatabase } from 'idb';

/*
 * The thumbnails this browser made, kept across reloads (and readable offline) in an IndexedDB
 * database of their own: the PNGs in one store, their metadata (build, size in bytes, last use) in
 * another, so that keeping the cache within its bounds reads the small records only. Reads are
 * read-only transactions, which run side by side (a screen of cards reads its thumbnails at once);
 * their last uses are written together a moment later, in one transaction. Thumbnails of other
 * builds are dropped when the cache opens (they can never be asked for again); beyond
 * MAX_CACHE_BYTES or MAX_CACHE_ENTRIES the least recently used ones go. Where IndexedDB cannot be
 * used (blocked storage, a sandboxed frame), the cache lives in memory for the page's lifetime.
 */

/** The cache's IndexedDB database. */
export const THUMBNAIL_DB = '3d-editor-thumbnails';
/** Most PNG bytes kept (the 170 built-in thumbnails at 256 px are about 1.3 MB). */
export const MAX_CACHE_BYTES = 16 * 1024 * 1024;
/** Most thumbnails kept. */
export const MAX_CACHE_ENTRIES = 4000;
/** A cache over its bounds is cut down to this share of them (not again at the next thumbnail). */
const PRUNE_TO = 0.75;
/** Last uses are written this long after the first read since the last write (milliseconds). */
export const USE_WRITE_MS = 1000;

const IMAGES = 'images';
const ENTRIES = 'entries';

export interface ThumbnailCache {
  /** The PNG kept under `key` (null: none); it counts as used now. */
  get(key: string): Promise<Uint8Array | null>;
  /** Keeps `png` under `key`. */
  put(key: string, png: Uint8Array): Promise<void>;
  /** Drops other builds' thumbnails and the least recently used beyond the bounds. */
  prune(): Promise<void>;
  /** Thumbnails kept and their bytes (of this build). */
  usage(): Promise<{ entries: number; bytes: number }>;
  close(): void;
}

export interface CacheOptions {
  /** The build whose thumbnails are kept (keys/build id, see keys.ts). */
  build: string;
  maxBytes?: number;
  maxEntries?: number;
  /** The clock of last uses (tests). */
  now?: () => number;
  /** Delay of the writes of last uses (default USE_WRITE_MS). */
  useWriteMs?: number;
}

interface EntryMeta {
  key: string;
  build: string;
  bytes: number;
  used: number;
}

/** Which kept entries to drop: other builds', then the least recently used beyond the bounds. */
export function entriesToDrop(
  all: readonly EntryMeta[],
  build: string,
  maxBytes: number,
  maxEntries: number,
): string[] {
  const drop = all.filter((e) => e.build !== build).map((e) => e.key);
  const mine = all.filter((e) => e.build === build);
  const bytes = mine.reduce((n, e) => n + e.bytes, 0);
  if (bytes <= maxBytes && mine.length <= maxEntries) return drop;
  // newest first: keep the most recently used that fit in the lower bounds, drop all older ones
  mine.sort((a, b) => b.used - a.used);
  let kept = 0;
  let n = 0;
  let full = false;
  for (const e of mine) {
    full ||= kept + e.bytes > maxBytes * PRUNE_TO || n + 1 > maxEntries * PRUNE_TO;
    if (full) drop.push(e.key);
    else {
      kept += e.bytes;
      n++;
    }
  }
  return drop;
}

/** The thumbnail cache in IndexedDB (falling back to memory when the database fails). */
export class IdbThumbnailCache implements ThumbnailCache {
  private dbp: Promise<IDBPDatabase | null> | null = null;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Bytes and entries of this build kept (null: not counted yet). */
  private count: { bytes: number; entries: number } | null = null;
  private pruning: Promise<void> | null = null;
  /** Where thumbnails go once the database failed. */
  private fallback: MemoryThumbnailCache | null = null;
  /** Last uses read but not written yet (key: time). */
  private readonly uses = new Map<string, number>();
  private useTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: CacheOptions & { name?: string }) {
    this.maxBytes = opts.maxBytes ?? MAX_CACHE_BYTES;
    this.maxEntries = opts.maxEntries ?? MAX_CACHE_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  /** The database (opened once; null after it failed, the memory fallback is used then). */
  private db(): Promise<IDBPDatabase | null> {
    this.dbp ??= (async () => {
      try {
        const db = await openDB(this.opts.name ?? THUMBNAIL_DB, 1, {
          upgrade(d) {
            d.createObjectStore(IMAGES, { keyPath: 'key' });
            d.createObjectStore(ENTRIES, { keyPath: 'key' });
          },
        });
        // other builds' thumbnails can never be asked for again
        void this.prune();
        return db;
      } catch {
        this.useMemory();
        return null;
      }
    })();
    return this.dbp;
  }

  private useMemory(): MemoryThumbnailCache {
    return (this.fallback ??= new MemoryThumbnailCache(this.opts));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const db = await this.db();
    if (!db || this.fallback) return this.useMemory().get(key);
    try {
      // read-only: reads do not wait for one another; the last use is written later (writeUses)
      const image = (await db.get(IMAGES, key)) as { png?: unknown } | undefined;
      const png = image?.png instanceof Uint8Array ? image.png : null;
      if (png) this.used(key);
      return png;
    } catch {
      return null;
    }
  }

  /** Notes a read of `key`; the last uses are written together a moment later. */
  private used(key: string): void {
    this.uses.set(key, this.now());
    this.useTimer ??= setTimeout(() => {
      this.useTimer = null;
      void this.dbp?.then((db) => this.writeUses(db));
    }, this.opts.useWriteMs ?? USE_WRITE_MS);
  }

  /** Writes the last uses noted since the last time, in one transaction. */
  private async writeUses(db: IDBPDatabase | null): Promise<void> {
    if (this.useTimer) clearTimeout(this.useTimer);
    this.useTimer = null;
    const uses = [...this.uses];
    this.uses.clear();
    if (!db || !uses.length) return;
    try {
      const tx = db.transaction(ENTRIES, 'readwrite');
      for (const [key, used] of uses) {
        const meta = (await tx.store.get(key)) as EntryMeta | undefined;
        if (meta && meta.used < used) await tx.store.put({ ...meta, used });
      }
      await tx.done;
    } catch {
      // last uses only order what goes first once the cache is full
    }
  }

  async put(key: string, png: Uint8Array): Promise<void> {
    const db = await this.db();
    if (!db || this.fallback) return this.useMemory().put(key, png);
    try {
      const tx = db.transaction([IMAGES, ENTRIES], 'readwrite');
      const meta: EntryMeta = { key, build: this.opts.build, bytes: png.byteLength, used: this.now() };
      const before = (await tx.objectStore(ENTRIES).get(key)) as EntryMeta | undefined;
      await tx.objectStore(IMAGES).put({ key, png });
      await tx.objectStore(ENTRIES).put(meta);
      await tx.done;
      if (this.count && !before) {
        this.count.bytes += meta.bytes;
        this.count.entries++;
      }
      if (!this.count || this.count.bytes > this.maxBytes || this.count.entries > this.maxEntries)
        await this.prune();
    } catch {
      // a thumbnail not kept is made again next time
    }
  }

  prune(): Promise<void> {
    this.pruning ??= this.pruneNow().finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  private async pruneNow(): Promise<void> {
    const db = await this.db();
    if (!db) return;
    // the thumbnails read lately count as used
    await this.writeUses(db);
    try {
      const tx = db.transaction([IMAGES, ENTRIES], 'readwrite');
      const all = (await tx.objectStore(ENTRIES).getAll()) as EntryMeta[];
      const drop = new Set(entriesToDrop(all, this.opts.build, this.maxBytes, this.maxEntries));
      for (const key of drop) {
        await tx.objectStore(IMAGES).delete(key);
        await tx.objectStore(ENTRIES).delete(key);
      }
      await tx.done;
      const kept = all.filter((e) => !drop.has(e.key));
      this.count = { bytes: kept.reduce((n, e) => n + e.bytes, 0), entries: kept.length };
    } catch {
      this.count = null;
    }
  }

  async usage(): Promise<{ entries: number; bytes: number }> {
    const db = await this.db();
    if (!db || this.fallback) return this.useMemory().usage();
    const all = ((await db.getAll(ENTRIES)) as EntryMeta[]).filter((e) => e.build === this.opts.build);
    return { entries: all.length, bytes: all.reduce((n, e) => n + e.bytes, 0) };
  }

  close(): void {
    const dbp = this.dbp;
    this.dbp = null;
    void dbp?.then(async (db) => {
      await this.writeUses(db);
      db?.close();
    });
    this.fallback?.close();
  }
}

/** A cache in memory, for this page only (where IndexedDB cannot be used, and in tests). */
export class MemoryThumbnailCache implements ThumbnailCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(opts: Partial<CacheOptions> = {}) {
    this.maxBytes = opts.maxBytes ?? MAX_CACHE_BYTES;
    this.maxEntries = opts.maxEntries ?? MAX_CACHE_ENTRIES;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const png = this.entries.get(key);
    if (!png) return null;
    // most recently used last
    this.entries.delete(key);
    this.entries.set(key, png);
    return png;
  }

  async put(key: string, png: Uint8Array): Promise<void> {
    const before = this.entries.get(key);
    if (before) {
      this.bytes -= before.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, png);
    this.bytes += png.byteLength;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
      this.bytes -= v.byteLength;
    }
  }

  async prune(): Promise<void> {}

  async usage(): Promise<{ entries: number; bytes: number }> {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  close(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/** The thumbnail cache of build `build`: IndexedDB where the browser has it, else memory. */
export function openThumbnailCache(build: string): ThumbnailCache {
  return typeof indexedDB !== 'undefined'
    ? new IdbThumbnailCache({ build })
    : new MemoryThumbnailCache({ build });
}
