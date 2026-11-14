import { afterEach, describe, expect, it } from 'vitest';
import { MemoryThumbnailCache } from '../src/assets/thumbnails/cache';
import { thumbnailKey } from '../src/assets/thumbnails/keys';
import { ThumbnailWorkerPool, type ThumbnailWorkerLike } from '../src/assets/thumbnails/pool';
import type { ThumbnailWorkerRequest } from '../src/assets/thumbnails/protocol';
import { ThumbnailError, ThumbnailService } from '../src/assets/thumbnails/service';

/*
 * The page's thumbnail service (service.ts): memory, then the persistent cache, then a worker;
 * one render for several tiles asking for the same thumbnail; tiles on screen first; a thumbnail
 * nobody waits for leaves the queue; failures of the model kept, failures of the worker not; the
 * workers stopped when the page goes away and started again when it comes back.
 */

/** A worker the test answers for, one request at a time. */
class FakeWorker implements ThumbnailWorkerLike {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly posted: ThumbnailWorkerRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: ThumbnailWorkerRequest): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  get current(): ThumbnailWorkerRequest | undefined {
    return this.posted.at(-1);
  }
  done(byte = 1): void {
    const id = this.current!.id;
    this.onmessage?.({
      data: { type: 'done', id, png: new Uint8Array([byte, byte]), width: 2, height: 2, ms: 30 },
    } as MessageEvent<unknown>);
  }
  fail(code: string, message = 'cannot'): void {
    this.onmessage?.({
      data: { type: 'error', id: this.current!.id, code, message },
    } as MessageEvent<unknown>);
  }
}

/** The models the fake workers were asked for, in order. */
const asked = () => FakeWorker.all.flatMap((w) => w.posted.map((m) => m.model));
const tick = () => new Promise((r) => setTimeout(r, 0));

let urls = 0;
const made: string[] = [];
const revoked: string[] = [];
const services: ThumbnailService[] = [];

function service(opts: { workers?: number; cache?: MemoryThumbnailCache; memoryEntries?: number } = {}) {
  const cache = opts.cache ?? new MemoryThumbnailCache();
  const s = new ThumbnailService({
    build: 'B',
    cache,
    pool: new ThumbnailWorkerPool({ factory: () => new FakeWorker(), workers: opts.workers ?? 1 }),
    urls: {
      create: (png) => {
        const url = `blob:t/${++urls}/${png[0]}`;
        made.push(url);
        return url;
      },
      revoke: (url) => void revoked.push(url),
    },
    memoryEntries: opts.memoryEntries,
  });
  services.push(s);
  return { s, cache };
}

afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  FakeWorker.all = [];
  made.length = 0;
  revoked.length = 0;
});

describe('the thumbnail service', () => {
  it('reads the cache first and renders only what it lacks, keeping what it renders', async () => {
    const cache = new MemoryThumbnailCache();
    await cache.put(thumbnailKey('B', { model: 'chair' }), new Uint8Array([9, 9]));
    const { s } = service({ cache });
    const chair = await s.request({ model: 'builtin:chair' }).promise;
    expect(chair).toMatchObject({ source: 'cache', bytes: 2 });
    expect(chair.url).toMatch(/\/9$/);
    expect(FakeWorker.all).toHaveLength(0);

    const sofa = s.request({ model: 'builtin:sofa' });
    await tick();
    expect(asked()).toEqual(['sofa']);
    expect(FakeWorker.all[0].current).toMatchObject({ type: 'render', model: 'sofa', size: 256 });
    FakeWorker.all[0].done(5);
    expect(await sofa.promise).toMatchObject({ source: 'render', bytes: 2 });
    // kept for the next page loads
    await tick();
    expect(await cache.get(thumbnailKey('B', { model: 'sofa' }))).toEqual(new Uint8Array([5, 5]));
    // and in memory for this one
    expect(await s.request({ model: 'sofa' }).promise).toMatchObject({ source: 'memory' });
    expect(s.stats()).toMatchObject({ renders: 1, cacheHits: 1, memoryHits: 1, renderMs: [30] });
  });

  it('renders a thumbnail once for every tile that asks for it', async () => {
    const { s } = service();
    const a = s.request({ model: 'chair' });
    const b = s.request({ model: 'builtin:chair' });
    await tick();
    const c = s.request({ model: 'chair' });
    FakeWorker.all[0].done(3);
    const [ia, ib, ic] = await Promise.all([a.promise, b.promise, c.promise]);
    expect(asked()).toEqual(['chair']);
    expect(new Set([ia.url, ib.url, ic.url]).size).toBe(1);
    // the same model in another size or with other parameters is another thumbnail
    void s.request({ model: 'chair', size: 128 });
    void s.request({ model: 'chair', params: { seed: 2 } });
    await tick();
    FakeWorker.all[0].done();
    await tick();
    expect(FakeWorker.all[0].posted.slice(1).map((m) => [m.size, m.params])).toEqual([
      [128, undefined],
      [256, { seed: 2 }],
    ]);
  });

  it('renders the tiles on screen first, then the others, in the order they came', async () => {
    const { s } = service({ workers: 1 });
    const first = s.request({ model: 'chair' }, 'near');
    await tick();
    // the worker is busy with the chair; these wait
    s.request({ model: 'sofa' }, 'near');
    s.request({ model: 'bed' }, 'visible');
    const lamp = s.request({ model: 'lamp' }, 'near');
    s.request({ model: 'desk' }, 'visible');
    await tick();
    lamp.setPriority('visible');
    expect(s.stats().queued).toBe(4);
    for (let i = 0; i < 5; i++) {
      FakeWorker.all[0].done();
      await tick();
    }
    await first.promise;
    // the lamp came before the desk: first among the tiles on screen once it is on screen too
    expect(asked()).toEqual(['chair', 'bed', 'lamp', 'desk', 'sofa']);
  });

  it('takes a thumbnail nobody waits for out of the queue, and keeps one already rendering', async () => {
    const { s, cache } = service({ workers: 1 });
    const chair = s.request({ model: 'chair' });
    await tick();
    const sofa = s.request({ model: 'sofa' });
    const bedA = s.request({ model: 'bed' });
    const bedB = s.request({ model: 'bed' });
    await tick();
    // the sofa's tile leaves the view: out of the queue
    sofa.cancel();
    await expect(sofa.promise).rejects.toMatchObject({ code: 'CANCELLED' });
    // one of the bed's two tiles leaves: still wanted
    bedA.cancel();
    // the chair's tile leaves while its thumbnail renders: finished and kept anyway
    chair.cancel();
    FakeWorker.all[0].done(1);
    await tick();
    FakeWorker.all[0].done(2);
    await expect(bedB.promise).resolves.toMatchObject({ source: 'render' });
    expect(asked()).toEqual(['chair', 'bed']);
    expect(await cache.get(thumbnailKey('B', { model: 'chair' }))).toEqual(new Uint8Array([1, 1]));
    expect(s.stats()).toMatchObject({ cancelled: 1, renders: 2 });
    // the sofa's tile comes back: asked again
    const again = s.request({ model: 'sofa' });
    await tick();
    FakeWorker.all[0].done(3);
    await expect(again.promise).resolves.toMatchObject({ source: 'render' });
  });

  it('drops a request cancelled during the cache read when the cache does not have it', async () => {
    const { s } = service();
    const t = s.request({ model: 'chair' });
    t.cancel();
    await expect(t.promise).rejects.toMatchObject({ code: 'CANCELLED' });
    await tick();
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("answers a model's failure at once the next times, and retries after a worker's failure", async () => {
    const { s } = service();
    const ghost = s.request({ model: 'not_in_this_build' });
    await tick();
    FakeWorker.all[0].fail('NOT_FOUND', 'No built-in model');
    const err = await ghost.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThumbnailError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', message: 'No built-in model' });
    await expect(s.request({ model: 'not_in_this_build' }).promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(asked()).toEqual(['not_in_this_build']);

    const chair = s.request({ model: 'chair' });
    await tick();
    FakeWorker.all[0].onerror?.({ message: 'worker died', preventDefault() {} } as unknown as ErrorEvent);
    await expect(chair.promise).rejects.toMatchObject({ code: 'CRASHED' });
    const retry = s.request({ model: 'chair' });
    await tick();
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1].done();
    await expect(retry.promise).resolves.toMatchObject({ source: 'render' });
    expect(s.stats().failures).toBe(2);
  });

  it('stops the workers when the page goes away and renders what waits when it comes back', async () => {
    const { s } = service({ workers: 1 });
    const chair = s.request({ model: 'chair' });
    const sofa = s.request({ model: 'sofa' });
    await tick();
    expect(asked()).toEqual(['chair']);
    s.pause();
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(s.stats()).toMatchObject({ queued: 2, running: 0 });
    await tick();
    // nothing starts while the page is away
    expect(FakeWorker.all).toHaveLength(1);
    s.resume();
    await tick();
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1].done(1);
    await expect(chair.promise).resolves.toMatchObject({ source: 'render' });
    await tick();
    FakeWorker.all[1].done(2);
    await expect(sofa.promise).resolves.toMatchObject({ source: 'render' });
    expect(asked()).toEqual(['chair', 'chair', 'sofa']);
  });

  it('keeps a bounded number of thumbnails in memory, freeing the oldest URLs', async () => {
    const { s, cache } = service({ memoryEntries: 2 });
    for (const [i, model] of ['chair', 'sofa', 'bed'].entries()) {
      await cache.put(thumbnailKey('B', { model }), new Uint8Array([i]));
      await s.request({ model }).promise;
    }
    expect(revoked).toEqual([made[0]]);
    // the chair left memory: read from the cache again
    expect(await s.request({ model: 'chair' }).promise).toMatchObject({ source: 'cache' });
    expect(await s.request({ model: 'bed' }).promise).toMatchObject({ source: 'memory' });
  });
});
