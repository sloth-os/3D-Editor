import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { silentLog } from '../../src/observability/log';
import {
  ModelCache,
  cacheHash,
  writeAtomic,
  type EntryContent,
  type ModelCacheOptions,
} from '../../src/store/cache';
import { StoreCancelledError } from '../../src/store/http';
import { tempDir } from './store-fixtures';

/** Removals (fs rm) a test holds back until it lets them go: removal in the background made slow. */
const removals = vi.hoisted(() => ({
  hold: null as ((target: string) => boolean) | null,
  held: [] as { target: string; go: () => void }[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rm: async (target: Parameters<typeof real.rm>[0], options?: Parameters<typeof real.rm>[1]) => {
      if (removals.hold?.(String(target)))
        await new Promise<void>((go) => removals.held.push({ target: String(target), go }));
      return real.rm(target, options);
    },
  };
});

/*
 * The disk cache of the model store: JSON indexes (memory + disk, TTL, stale copies), and model /
 * thumbnail entries (built once for concurrent requests, renamed into place atomically, pinned
 * while read, least recently used evicted over budget, found again after a restart).
 */

let dir: string;
let t: number;
const clock = () => t;
beforeEach(async () => {
  dir = await tempDir('store-cache-');
  t = 1_700_000_000_000;
});
afterEach(async () => {
  removals.hold = null;
  for (const r of removals.held.splice(0)) r.go();
  await rm(dir, { recursive: true, force: true });
});

/** A cache whose released entries are evictable at once (`o.releaseGraceMs` sets a grace period). */
const cacheOf = (maxBytes = 1 << 30, d = dir, o: Partial<ModelCacheOptions> = {}) =>
  new ModelCache({ dir: d, maxBytes, log: silentLog, now: clock, releaseGraceMs: 0, ...o });

/** A builder writing one file of `size` bytes (counting its calls). */
function builder(size: number, o: { gate?: Promise<void>; fail?: Error } = {}) {
  const calls: AbortSignal[] = [];
  const build = async (into: string, signal: AbortSignal): Promise<EntryContent> => {
    calls.push(signal);
    const data = new Uint8Array(size).fill(7);
    await writeFile(path.join(into, 'model.glb'), data);
    if (o.gate) await o.gate;
    if (o.fail) throw o.fail;
    return {
      files: [{ path: 'model.glb', bytes: size, sha256: createHash('sha256').update(data).digest('hex') }],
      meta: { format: 'glb', main: 'model.glb' },
    };
  };
  return { build, calls };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const entryDir = (kind: string, group: string, key: string) =>
  path.join(dir, kind, group, cacheHash(`${kind}:${key}`));

describe('json', () => {
  it('loads once for concurrent callers, then answers from memory and from disk after a restart', async () => {
    const cache = cacheOf();
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return { models: [1, 2, 3] };
    };
    const [a, b] = await Promise.all([
      cache.json('khronos/index', 1000, load),
      cache.json('khronos/index', 1000, load),
    ]);
    expect(loads).toBe(1);
    expect(a.value).toEqual({ models: [1, 2, 3] });
    expect(b.value).toEqual(a.value);
    expect(a.stale).toBeNull();
    expect((await cache.json('khronos/index', 1000, load)).value).toEqual(a.value);
    expect(loads).toBe(1);
    expect(cache.peekJson('khronos/index')).toEqual(a.value);

    const files = await readdir(path.join(dir, 'index'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^khronos_index-[0-9a-f]{16}\.json$/);
    const restarted = cacheOf();
    const again = await restarted.json('khronos/index', 1000, load);
    expect(again.value).toEqual(a.value);
    expect(again.fetchedAt).toBe(t);
    expect(loads).toBe(1);
  });

  it('loads again after the TTL and keeps the old copy (stale) when the load fails', async () => {
    const cache = cacheOf();
    await cache.json('ph/assets', 1000, async () => 'v1');
    t += 1001;
    expect((await cache.json('ph/assets', 1000, async () => 'v2')).value).toBe('v2');
    t += 1001;
    const failed = await cache.json('ph/assets', 1000, async () => {
      throw new Error('HTTP 503');
    });
    expect(failed).toMatchObject({ value: 'v2', stale: 'HTTP 503' });
    // a new server whose provider fails still has the disk copy
    t += 1001;
    const restarted = await cacheOf().json('ph/assets', 1000, async () => {
      throw new Error('offline');
    });
    expect(restarted).toMatchObject({ value: 'v2', stale: 'offline' });
    await expect(
      cacheOf().json('other', 1000, async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
  });

  it('keeps disk: false values in memory only', async () => {
    const cache = cacheOf();
    await cache.json('sketchfab/search', 1000, async () => [1], { disk: false });
    expect(existsSync(path.join(dir, 'index'))).toBe(false);
    expect(cache.peekJson('sketchfab/search')).toEqual([1]);
  });

  it('goes on loading when every caller went away, so the next caller finds the value', async () => {
    const cache = cacheOf();
    let signal: AbortSignal | null = null;
    let finish!: (v: number) => void;
    let loads = 0;
    const load = (s: AbortSignal) => {
      loads++;
      signal = s;
      return new Promise<number>((resolve) => (finish = resolve));
    };
    const a = new AbortController();
    const b = new AbortController();
    const pa = cache.json('slow', 1000, load, { signal: a.signal });
    const pb = cache.json('slow', 1000, load, { signal: b.signal });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    a.abort();
    b.abort();
    await expect(pa).rejects.toBeInstanceOf(StoreCancelledError);
    await expect(pb).rejects.toBeInstanceOf(StoreCancelledError);
    // a search's deadline passed: the index still arrives for the next search
    expect(signal!.aborted).toBe(false);
    finish(5);
    await vi.waitFor(() => expect(cache.peekJson('slow')).toBe(5));
    expect((await cache.json('slow', 1000, load)).value).toBe(5);
    expect(loads).toBe(1);
  });

  it('stops a load nobody waits for after its limit, and on close', async () => {
    const cache = new ModelCache({
      dir,
      maxBytes: 1 << 30,
      log: silentLog,
      now: clock,
      backgroundLoadMs: 50,
    });
    let signal: AbortSignal | null = null;
    const hanging = (s: AbortSignal) =>
      new Promise<number>((_, reject) => {
        signal = s;
        s.addEventListener('abort', () => reject(s.reason));
      });
    const gone = new AbortController();
    const p = cache.json('hangs', 1000, hanging, { signal: gone.signal });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    gone.abort();
    await expect(p).rejects.toBeInstanceOf(StoreCancelledError);
    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
    expect(String(signal!.reason)).toMatch(/still loading after/);
    // the next caller starts a new load
    signal = null;
    const again = cache.json('hangs', 1000, hanging);
    await vi.waitFor(() => expect(signal).not.toBeNull());
    await cache.close();
    await expect(again).rejects.toThrow(/shutting down/);
  });

  it('answers with the older copy when the caller stops waiting for a new one', async () => {
    const cache = cacheOf();
    await cache.json('idx', 1000, async () => ['old index']);
    t += 1001;
    // the server hangs instead of failing: the search's deadline ends the wait
    const deadline = new AbortController();
    const hanging = (s: AbortSignal) =>
      new Promise<string[]>((_, reject) => s.addEventListener('abort', () => reject(s.reason)));
    const p = cache.json('idx', 1000, hanging, { signal: deadline.signal });
    setTimeout(() => deadline.abort(), 20);
    expect(await p).toMatchObject({ value: ['old index'], stale: 'the new copy is still loading' });
    await cache.close();
  });
});

describe('entries', () => {
  it('builds once for concurrent requests and moves the finished directory into place', async () => {
    const cache = cacheOf();
    const gate = deferred();
    const b = builder(100, { gate: gate.promise });
    const final = entryDir('models', 'khronos', 'khronos:Chair#1');
    const p1 = cache.entry('models', 'khronos', 'khronos:Chair#1', b.build);
    const p2 = cache.entry('models', 'khronos', 'khronos:Chair#1', b.build);
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    // while it is being built, nothing is where readers look
    expect(existsSync(final)).toBe(false);
    expect((await readdir(path.join(dir, 'tmp'))).length).toBe(1);
    gate.resolve();
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(b.calls).toHaveLength(1);
    expect(h1.dir).toBe(final);
    expect(h2.files).toEqual(h1.files);
    expect(h1.meta).toEqual({ format: 'glb', main: 'model.glb' });
    expect((await h1.read('model.glb')).length).toBe(100);
    await expect(h1.read('other.bin')).rejects.toThrow(/no file/);
    expect(JSON.parse(await readFile(path.join(final, 'manifest.json'), 'utf8'))).toMatchObject({
      version: 1,
      key: 'khronos:Chair#1',
      files: [{ path: 'model.glb', bytes: 100 }],
    });
    expect(await readdir(path.join(dir, 'tmp'))).toEqual([]);
    h1.release();
    h2.release();
    expect(cache.has('models', 'khronos:Chair#1')).toBe(true);
    expect(await cache.peek('models', 'khronos:Chair#1')).toMatchObject({ meta: { main: 'model.glb' } });
    // held: not built again
    (await cache.entry('models', 'khronos', 'khronos:Chair#1', b.build)).release();
    expect(b.calls).toHaveLength(1);
  });

  it('leaves nothing behind when a build fails, and builds again on the next request', async () => {
    const cache = cacheOf();
    const failing = builder(100, { fail: new Error('HTTP 500') });
    await expect(cache.entry('models', 'polyhaven', 'polyhaven:X#', failing.build)).rejects.toThrow(
      'HTTP 500',
    );
    expect(existsSync(entryDir('models', 'polyhaven', 'polyhaven:X#'))).toBe(false);
    expect(await readdir(path.join(dir, 'tmp'))).toEqual([]);
    expect(cache.has('models', 'polyhaven:X#')).toBe(false);
    const ok = builder(100);
    (await cache.entry('models', 'polyhaven', 'polyhaven:X#', ok.build)).release();
    expect(ok.calls).toHaveLength(1);
  });

  it('stops a build only when every requester went away', async () => {
    const cache = cacheOf();
    const gate = deferred();
    const b = builder(10, { gate: gate.promise });
    const a1 = new AbortController();
    const a2 = new AbortController();
    const p1 = cache.entry('models', 'g', 'k', b.build, a1.signal);
    const p2 = cache.entry('models', 'g', 'k', b.build, a2.signal);
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    a1.abort();
    await expect(p1).rejects.toBeInstanceOf(StoreCancelledError);
    expect(b.calls[0].aborted).toBe(false);
    a2.abort();
    await expect(p2).rejects.toBeInstanceOf(StoreCancelledError);
    expect(b.calls[0].aborted).toBe(true);
    gate.resolve();
    await vi.waitFor(async () => expect(await readdir(path.join(dir, 'tmp'))).toEqual([]));
    expect(cache.has('models', 'k')).toBe(false);
  });

  it('evicts the least recently used unpinned entries over budget', async () => {
    // each entry: 1000 bytes of model plus its manifest (~200 bytes)
    const cache = cacheOf(3800);
    const get = async (key: string) => {
      t += 1000;
      const h = await cache.entry('models', 'g', key, builder(1000).build);
      return h;
    };
    for (const k of ['a', 'b', 'c']) (await get(k)).release();
    expect(cache.keys()).toEqual(['a', 'b', 'c']);
    // a is used again: b is now the least recently used
    (await get('a')).release();
    expect(cache.keys()).toEqual(['b', 'c', 'a']);
    // c is being read while d arrives: b goes, c stays although older than a
    const reading = await get('c');
    (await get('d')).release();
    expect(cache.keys().sort()).toEqual(['a', 'c', 'd']);
    // the directory goes in the background
    await vi.waitFor(() => expect(existsSync(entryDir('models', 'g', 'b'))).toBe(false));
    (await get('e')).release();
    // c is pinned: a (the oldest unpinned) went instead
    expect(cache.keys().sort()).toEqual(['c', 'd', 'e']);
    reading.release();
    expect(cache.bytes).toBeLessThanOrEqual(3800);
  });

  it('builds and serves an entry larger than the budget, then drops it once read', async () => {
    const cache = cacheOf(500);
    const h = await cache.entry('models', 'g', 'huge', builder(2000).build);
    expect((await h.read('model.glb')).length).toBe(2000);
    expect(cache.has('models', 'huge')).toBe(true);
    h.release();
    expect(cache.has('models', 'huge')).toBe(false);
    expect(cache.bytes).toBe(0);
  });

  it('keeps a released entry for the grace period (a model fetched file by file downloads once)', async () => {
    const cache = cacheOf(0, dir, { releaseGraceMs: 150 });
    const b = builder(10);
    // the UI's flow: the details with download=1, then one request per file
    for (let i = 0; i < 3; i++) (await cache.entry('models', 'g', 'model', b.build)).release();
    expect(b.calls).toHaveLength(1);
    expect(cache.has('models', 'model')).toBe(true);
    // over budget, it goes once nobody used it for the grace period
    await vi.waitFor(() => expect(cache.has('models', 'model')).toBe(false), { timeout: 2000 });
    expect(cache.bytes).toBe(0);
    (await cache.entry('models', 'g', 'model', b.build)).release();
    expect(b.calls).toHaveLength(2);
    await cache.close();
  });

  it('moves a dropped entry out of the way at once: its removal never touches a new build of it', async () => {
    const cache = cacheOf(0);
    const where = entryDir('models', 'g', 'k');
    // the old directory's removal takes its time (a large model on a slow disk)
    removals.hold = (target) => target === where || target.includes(`${path.sep}trash-`);
    const first = builder(10);
    (await cache.entry('models', 'g', 'k', first.build)).release();
    // asked again at once (the next file of the model, with a budget smaller than the model)
    const again = builder(10);
    const h = await cache.entry('models', 'g', 'k', again.build);
    expect(again.calls).toHaveLength(1);
    expect((await h.read('model.glb')).length).toBe(10);
    // the old copy's removal finishes after the new copy is in place: the new copy stays whole
    await vi.waitFor(() => expect(removals.held.length).toBeGreaterThan(0));
    removals.hold = null;
    for (const r of removals.held.splice(0)) r.go();
    await vi.waitFor(async () =>
      expect((await readdir(path.join(dir, 'tmp'))).filter((n) => n.startsWith('trash-'))).toEqual([]),
    );
    expect((await h.read('model.glb')).length).toBe(10);
    expect(existsSync(path.join(where, 'manifest.json'))).toBe(true);
    h.release();
  });

  it('keeps nothing after use with a budget of 0', async () => {
    const cache = cacheOf(0);
    const b = builder(10);
    (await cache.entry('thumbs', 'builtin', 'x', b.build)).release();
    (await cache.entry('thumbs', 'builtin', 'x', b.build)).release();
    expect(b.calls).toHaveLength(2);
    expect(cache.keys()).toEqual([]);
  });

  it('builds again when a file was removed behind its back', async () => {
    const cache = cacheOf();
    const b = builder(10);
    (await cache.entry('models', 'g', 'k', b.build)).release();
    await rm(path.join(entryDir('models', 'g', 'k'), 'model.glb'));
    const h = await cache.entry('models', 'g', 'k', b.build);
    expect((await h.read('model.glb')).length).toBe(10);
    h.release();
    expect(b.calls).toHaveLength(2);
  });

  it('finds its entries after a restart (last use kept) and removes leftovers', async () => {
    const first = cacheOf(3800);
    for (const k of ['a', 'b']) {
      t += 1000;
      (await first.entry('models', 'g', k, builder(1000).build)).release();
    }
    t += 1000;
    (await first.entry('models', 'g', 'a', builder(1000).build)).release();
    const manifestA = path.join(entryDir('models', 'g', 'a'), 'manifest.json');
    await vi.waitFor(async () => expect((await stat(manifestA)).mtimeMs).toBe(t));
    // leftovers: an interrupted build an hour old, a fresh one, and an entry without manifest
    const oldTmp = path.join(dir, 'tmp', 'old-build');
    const newTmp = path.join(dir, 'tmp', 'new-build');
    await mkdir(oldTmp, { recursive: true });
    await mkdir(newTmp, { recursive: true });
    const hourAgo = new Date(t - 2 * 60 * 60 * 1000);
    await utimes(oldTmp, hourAgo, hourAgo);
    const broken = path.join(dir, 'models', 'g', 'f'.repeat(40));
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'model.glb'), 'x');

    const second = cacheOf(3800);
    await second.init();
    expect(second.keys()).toEqual(['b', 'a']);
    expect(second.bytes).toBe(first.bytes);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(newTmp)).toBe(true);
    expect(existsSync(broken)).toBe(false);
    // b is the least recently used across the restart
    t += 1000;
    (await second.entry('models', 'g', 'c', builder(1000).build)).release();
    t += 1000;
    (await second.entry('models', 'g', 'd', builder(1000).build)).release();
    expect(second.keys()).toEqual(['a', 'c', 'd']);
  });

  it('removes index files not written for a week and interrupted removals at startup', async () => {
    const first = cacheOf();
    for (const key of ['provider/index', 'provider/model/old'])
      await first.json(key, 60_000, async () => ({ key }));
    const files = async () => (await readdir(path.join(dir, 'index'))).sort();
    const [indexFile, oldFile] = await files();
    expect(indexFile).toMatch(/^provider_index-/);
    expect(oldFile).toMatch(/^provider_model_old-/);
    // written 8 days ago (a per-model answer nobody asked for since), and a day ago
    const at = (ms: number) => new Date(t - ms);
    await utimes(path.join(dir, 'index', oldFile), at(8 * 86_400_000), at(8 * 86_400_000));
    await utimes(path.join(dir, 'index', indexFile), at(86_400_000), at(86_400_000));
    // a dropped entry renamed aside whose removal a stop interrupted
    const trash = path.join(dir, 'tmp', 'trash-0123456789ab-cafe');
    await mkdir(trash, { recursive: true });
    await writeFile(path.join(trash, 'model.glb'), 'x');

    const second = cacheOf();
    await second.init();
    expect(await files()).toEqual([indexFile]);
    expect(existsSync(trash)).toBe(false);
  });

  it('stops running builds on close', async () => {
    const cache = cacheOf();
    const b = builder(10, { gate: new Promise(() => undefined) });
    const build = async (into: string, signal: AbortSignal) =>
      Promise.race([
        b.build(into, signal),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      ]);
    const p = cache.entry('models', 'g', 'k', build);
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    await cache.close();
    await expect(p).rejects.toThrow(/shutting down/);
  });
});

describe('writeAtomic', () => {
  it('replaces a file in one step and leaves no temporary file', async () => {
    const file = path.join(dir, 'a', 'b.json');
    await writeAtomic(file, '{"v":1}');
    await writeAtomic(file, new TextEncoder().encode('{"v":2}'));
    expect(await readFile(file, 'utf8')).toBe('{"v":2}');
    expect(await readdir(path.dirname(file))).toEqual(['b.json']);
  });
});
