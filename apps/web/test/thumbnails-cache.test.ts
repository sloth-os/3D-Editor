import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import {
  IdbThumbnailCache,
  MemoryThumbnailCache,
  THUMBNAIL_DB,
  entriesToDrop,
  openThumbnailCache,
} from '../src/assets/thumbnails/cache';

/*
 * The thumbnail cache (cache.ts): PNGs kept in IndexedDB across page loads (a new cache object on
 * the same database is the next page load), readable without a network, other builds' thumbnails
 * dropped when it opens, and the least recently used ones dropped beyond its bounds (last uses of
 * reads written together, a moment later); in memory where IndexedDB fails. fake-indexeddb stands
 * in for the browser's (test/setup.ts).
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
