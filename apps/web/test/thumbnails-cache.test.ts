import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { forceCloseDatabase } from 'fake-indexeddb';
import {
  IDB_TIMEOUT_MS,
  IdbThumbnailCache,
  MemoryThumbnailCache,
  THUMBNAIL_DB,
  entriesToDrop,
  openThumbnailCache,
  overBounds,
} from '../src/assets/thumbnails/cache';

/*
 * The thumbnail cache (cache.ts): PNGs kept in IndexedDB across page loads (a new cache object on
 * the same database is the next page load), readable without a network, other builds' thumbnails
 * dropped when it opens, and the least recently used ones dropped beyond the database's bounds,
 * whichever pages wrote it (last uses of reads written together, a moment later); in memory where
 * IndexedDB fails, does not answer in time, or is wanted by another page (an upgrade, a deletion).
 * fake-indexeddb stands in for the browser's (test/setup.ts).
 */

let n = 0;
/** A database name of its own per test. */
const fresh = () => `thumbs-test-${++n}`;
const png = (byte: number, bytes = 100) => new Uint8Array(bytes).fill(byte);
const open: IdbThumbnailCache[] = [];
function cache(opts: ConstructorParameters<typeof IdbThumbnailCache>[0]): IdbThumbnailCache {
  const c = new IdbThumbnailCache(opts);
  open.push(c);
  return c;
}

afterEach(() => {
  for (const c of open.splice(0)) c.close();
  vi.unstubAllGlobals();
});

describe('the thumbnail cache', () => {
  it('keeps thumbnails across page loads', async () => {
    const name = fresh();
    const first = cache({ build: 'b1', name });
    expect(await first.get('b1|builtin:chair|256|')).toBeNull();
    await first.put('b1|builtin:chair|256|', png(7));
    expect(await first.get('b1|builtin:chair|256|')).toEqual(png(7));
    first.close();
    // the next page load (same build): read back from the database
    const second = cache({ build: 'b1', name });
    expect(await second.get('b1|builtin:chair|256|')).toEqual(png(7));
    expect(await second.usage()).toEqual({ entries: 1, bytes: 100 });
  });

  it("drops other builds' thumbnails when it opens", async () => {
    const name = fresh();
    const old = cache({ build: 'old', name });
    await old.put('old|builtin:chair|256|', png(1));
    await old.put('old|builtin:sofa|256|', png(2));
    old.close();
    const next = cache({ build: 'new', name });
    await next.put('new|builtin:chair|256|', png(3));
    await next.prune();
    const db = await openDB(name);
    expect(((await db.getAllKeys('entries')) as string[]).sort()).toEqual(['new|builtin:chair|256|']);
    expect(((await db.getAllKeys('images')) as string[]).sort()).toEqual(['new|builtin:chair|256|']);
    db.close();
  });

  it('drops the least recently used thumbnails beyond its bounds', async () => {
    let clock = 0;
    const c = cache({ build: 'b', name: fresh(), maxBytes: 1000, maxEntries: 100, now: () => ++clock });
    for (let i = 0; i < 8; i++) await c.put(`b|m${i}|256|`, png(i));
    // m0 is read again: recently used now
    expect(await c.get('b|m0|256|')).toEqual(png(0));
    // three more pass the 1000-byte bound: cut to 750 bytes, the 7 most recently used kept
    for (let i = 8; i < 11; i++) await c.put(`b|m${i}|256|`, png(i));
    expect(await c.usage()).toEqual({ entries: 7, bytes: 700 });
    expect(await c.get('b|m0|256|')).toEqual(png(0));
    for (const gone of [1, 2, 3, 4]) expect(await c.get(`b|m${gone}|256|`)).toBeNull();
    for (const kept of [5, 6, 7, 8, 9, 10]) expect(await c.get(`b|m${kept}|256|`)).toEqual(png(kept));
  });

  it('writes the last uses of its reads together, a moment later, and when it closes', async () => {
    const name = fresh();
    const lastUses = async () => {
      const db = await openDB(name);
      const all = (await db.getAll('entries')) as { key: string; used: number }[];
      db.close();
      return Object.fromEntries(all.map((e) => [e.key, e.used]));
    };
    let clock = 0;
    const c = cache({ build: 'b', name, now: () => ++clock, useWriteMs: 0 });
    await c.put('b|a|256|', png(1));
    await c.put('b|b|256|', png(2));
    // a read (a read-only transaction) is not written at once: a moment later
    expect(await c.get('b|a|256|')).toEqual(png(1));
    await vi.waitFor(async () => expect(await lastUses()).toEqual({ 'b|a|256|': 3, 'b|b|256|': 2 }));
    // reads not written yet when the cache closes (the page goes away) are written then
    const slow = cache({ build: 'b', name, now: () => 100, useWriteMs: 60_000 });
    expect(await slow.get('b|b|256|')).toEqual(png(2));
    expect(await slow.get('b|none|256|')).toBeNull();
    expect(await lastUses()).toEqual({ 'b|a|256|': 3, 'b|b|256|': 2 });
    slow.close();
    await vi.waitFor(async () => expect(await lastUses()).toEqual({ 'b|a|256|': 3, 'b|b|256|': 100 }));
  });

  it('bounds the number of thumbnails too', async () => {
    let clock = 0;
    const c = cache({ build: 'b', name: fresh(), maxEntries: 4, now: () => ++clock });
    for (let i = 0; i < 5; i++) await c.put(`b|m${i}|256|`, png(i, 10));
    expect((await c.usage()).entries).toBe(3);
    expect(await c.get('b|m4|256|')).toEqual(png(4, 10));
    expect(await c.get('b|m0|256|')).toBeNull();
  });

  it('chooses what to drop: other builds, then the oldest beyond three quarters of the bounds', () => {
    const e = (key: string, build: string, bytes: number, used: number) => ({ key, build, bytes, used });
    const all = [
      e('x', 'old', 50, 9),
      e('a', 'b', 40, 1),
      e('b', 'b', 40, 3),
      e('c', 'b', 40, 2),
      e('d', 'b', 40, 4),
    ];
    // within bounds: only the other build
    expect(entriesToDrop(all, 'b', 1000, 100)).toEqual(['x']);
    // 160 bytes over 100: keep the newest up to 75 bytes (d), drop the rest, oldest included
    expect(entriesToDrop(all, 'b', 100, 100).sort()).toEqual(['a', 'b', 'c', 'x']);
    // 4 entries over 3: keep the newest 2 (3 × 0.75 = 2.25)
    expect(entriesToDrop(all, 'b', 1000, 3).sort()).toEqual(['a', 'c', 'x']);
  });

  it('keeps the bounds of the database whichever pages write to it (each re-reads the totals)', async () => {
    const name = fresh();
    let clock = 0;
    const tab = () => cache({ build: 'b', name, maxBytes: 1000, maxEntries: 100, now: () => ++clock });
    // two tabs of the editor, both open on the database
    const a = tab();
    const b = tab();
    expect(await a.get('b|none|256|')).toBeNull();
    expect(await b.get('b|none|256|')).toBeNull();
    // each one writes 600 bytes, less than the bound: together they pass it
    for (let i = 0; i < 6; i++) await a.put(`b|a${i}|256|`, png(i));
    for (let i = 0; i < 6; i++) await b.put(`b|b${i}|256|`, png(i));
    const total = await a.usage();
    expect(total.bytes).toBeLessThanOrEqual(1000);
    expect(await b.usage()).toEqual(total);
    // the most recently written stayed (b4 passed the bound: cut to 750 bytes, then b5)
    expect(total).toEqual({ entries: 8, bytes: 800 });
    for (const kept of ['a4', 'a5', 'b0', 'b5']) expect(await a.get(`b|${kept}|256|`)).not.toBeNull();
    for (const gone of ['a0', 'a3']) expect(await b.get(`b|${gone}|256|`)).toBeNull();
    // the number of thumbnails too
    expect(overBounds([{ key: 'x', build: 'old', bytes: 1, used: 0 }], 1000, 0)).toBe(true);
    expect(overBounds([{ key: 'x', build: 'old', bytes: 1001, used: 0 }], 1000, 1)).toBe(true);
    expect(overBounds([{ key: 'x', build: 'old', bytes: 1000, used: 0 }], 1000, 1)).toBe(false);
  });

  it('keeps thumbnails in memory where IndexedDB never answers, without waiting for it', async () => {
    // a context that blocks storage by never answering (the request's events never fire)
    vi.stubGlobal('indexedDB', { open: () => new IDBOpenDBRequest() });
    const c = cache({ build: 'b', name: fresh(), timeoutMs: 50 });
    const t0 = performance.now();
    expect(await c.get('b|chair|256|')).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    await c.put('b|chair|256|', png(4));
    expect(await c.get('b|chair|256|')).toEqual(png(4));
    expect(await c.usage()).toEqual({ entries: 1, bytes: 100 });
    expect(IDB_TIMEOUT_MS).toBe(3000);
  });

  it('does not wait for a database held for another page (a deletion waiting for an old tab)', async () => {
    const name = fresh();
    // a tab of an older build holds the database, and does not let go when asked
    const old = await openDB(name, 1);
    let deleted = false;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onblocked = () => resolve();
      req.onsuccess = () => void (deleted = true);
    });
    // this page's open waits behind the deletion: the cache keeps to memory meanwhile
    const c = cache({ build: 'b', name, timeoutMs: 50 });
    expect(await c.get('b|chair|256|')).toBeNull();
    await c.put('b|chair|256|', png(4));
    expect(await c.get('b|chair|256|')).toEqual(png(4));
    old.close();
    await vi.waitFor(() => expect(deleted).toBe(true));
    // the connection that opened after all was closed at once: it holds nothing up
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onblocked = () => reject(new Error('the late connection blocks the deletion'));
    });
  });

  it('lets another page upgrade or delete the database, going on in memory', async () => {
    const name = fresh();
    const c = cache({ build: 'b', name });
    await c.put('b|chair|256|', png(1));
    expect(await c.get('b|chair|256|')).toEqual(png(1));
    // another page deletes the database (a newer version would upgrade it the same way)
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onblocked = () => reject(new Error('blocked by the cache'));
    });
    await c.put('b|sofa|256|', png(2));
    expect(await c.get('b|sofa|256|')).toEqual(png(2));
    expect(await c.get('b|chair|256|')).toBeNull();
    const db = await openDB(name);
    expect(db.objectStoreNames.length).toBe(0);
    db.close();
  });

  it('goes on in memory when the browser closes the database (site data cleared)', async () => {
    const real = indexedDB;
    const requests: IDBOpenDBRequest[] = [];
    vi.stubGlobal('indexedDB', {
      open: (name: string, version?: number) => {
        const req = real.open(name, version);
        requests.push(req);
        return req;
      },
    });
    const name = fresh();
    const c = cache({ build: 'b', name });
    await c.put('b|chair|256|', png(1));
    expect(requests).toHaveLength(1);
    // (no transaction running: the browser's close event comes at once)
    await c.prune();
    forceCloseDatabase(requests[0].result as never);
    await c.put('b|sofa|256|', png(2));
    expect(await c.get('b|sofa|256|')).toEqual(png(2));
    expect(await c.get('b|chair|256|')).toBeNull();
    vi.unstubAllGlobals();
    const db = await openDB(name);
    expect(await db.getAllKeys('entries')).toEqual(['b|chair|256|']);
    db.close();
  });

  it('goes on in memory when a read never answers', async () => {
    const name = fresh();
    const c = cache({ build: 'b', name, timeoutMs: 50 });
    await c.put('b|chair|256|', png(1));
    expect(await c.get('b|chair|256|')).toEqual(png(1));
    const get = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(() => new IDBRequest() as unknown as IDBRequest);
    try {
      expect(await c.get('b|chair|256|')).toBeNull();
    } finally {
      get.mockRestore();
    }
    // from now on in memory: the thumbnail made again is kept there
    await c.put('b|chair|256|', png(2));
    expect(await c.get('b|chair|256|')).toEqual(png(2));
    expect(await c.usage()).toEqual({ entries: 1, bytes: 100 });
  });

  it('keeps thumbnails in memory where IndexedDB fails', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('The user denied permission to access the database.', 'SecurityError');
      },
    });
    const c = cache({ build: 'b', name: fresh() });
    await c.put('b|chair|256|', png(4));
    expect(await c.get('b|chair|256|')).toEqual(png(4));
    expect(await c.usage()).toEqual({ entries: 1, bytes: 100 });
    // no IndexedDB at all: the memory cache from the start
    vi.stubGlobal('indexedDB', undefined);
    expect(openThumbnailCache('b')).toBeInstanceOf(MemoryThumbnailCache);
  });

  it('bounds the memory cache the same way, least recently used first', async () => {
    const m = new MemoryThumbnailCache({ maxBytes: 300 });
    await m.put('a', png(1));
    await m.put('b', png(2));
    await m.put('c', png(3));
    await m.get('a');
    await m.put('d', png(4));
    expect(await m.get('b')).toBeNull();
    expect(await m.get('a')).toEqual(png(1));
    expect(await m.usage()).toEqual({ entries: 3, bytes: 300 });
    // the same key again replaces it
    await m.put('a', png(9, 50));
    expect(await m.usage()).toEqual({ entries: 3, bytes: 250 });
  });

  it('uses its own database', () => {
    expect(THUMBNAIL_DB).toBe('3d-editor-thumbnails');
    expect(THUMBNAIL_DB.startsWith('3d-editor-project-')).toBe(false);
  });
});
