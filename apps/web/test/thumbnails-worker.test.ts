import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePNG, renderBuiltinThumbnailPng } from '@3d-editor/core';
import { handleThumbnailMessage } from '../src/assets/thumbnails/engine';
import {
  isRenderRequest,
  isWorkerResponse,
  type ThumbnailWorkerRequest,
  type ThumbnailWorkerResponse,
} from '../src/assets/thumbnails/protocol';
import {
  InProcessThumbnailWorker,
  MAX_THUMBNAIL_WORKERS,
  THUMBNAIL_WORKER_URL,
  ThumbnailRenderError,
  ThumbnailWorkerPool,
  defaultWorkerCount,
  type ThumbnailEngineLoader,
  type ThumbnailWorkerLike,
} from '../src/assets/thumbnails/pool';

/*
 * The thumbnail worker (engine.ts, run by thumbnail.worker.ts) and its protocol: a render request
 * answered with core's PNG of the model (the editor server's, byte for byte) or an error code; and
 * the page's pool of one or two workers: one render per worker, workers replaced when they crash,
 * rendering on the page when they cannot start (the render given to such a worker marked as never
 * run), a stand-in whose code does not load failing its renders rather than holding its place,
 * stopped when idle or when the page goes away.
 */

/** A worker the test answers for. */
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
  /** Answers the last request. */
  answer(res: Partial<ThumbnailWorkerResponse> & { type: 'done' | 'error' }): void {
    const id = this.posted.at(-1)!.id;
    const full =
      res.type === 'done'
        ? { png: new Uint8Array([1, 2, 3]), width: 1, height: 1, ms: 5, ...res, id }
        : { message: 'no', code: 'FAILED', ...res, id };
    this.onmessage?.({ data: full } as MessageEvent<unknown>);
  }
  crash(message = 'boom'): void {
    this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
  }
}

afterEach(() => {
  FakeWorker.all = [];
  vi.useRealTimers();
});

describe('the thumbnail worker', () => {
  it("answers a render request with core's PNG of the model, transferring its buffer", () => {
    const { response, transfer } = handleThumbnailMessage({
      type: 'render',
      id: 7,
      model: 'chair',
      size: 64,
    });
    expect(response).toMatchObject({ type: 'done', id: 7, width: 64, height: 64 });
    if (response.type !== 'done') throw new Error('not done');
    expect(response.ms).toBeGreaterThanOrEqual(0);
    expect(transfer).toEqual([response.png.buffer]);
    const img = decodePNG(response.png);
    expect([img.width, img.height]).toEqual([64, 64]);
    // the PNG the editor server's store makes of the model (its thumbnails use the same core code)
    expect(response.png).toEqual(renderBuiltinThumbnailPng({ id: 'chair' }, 64).png);
    expect(isWorkerResponse(response)).toBe(true);
  });

  it('answers with an error code what it cannot render', () => {
    const unknown = handleThumbnailMessage({ type: 'render', id: 1, model: 'no_such_model', size: 64 });
    expect(unknown.response).toMatchObject({ type: 'error', id: 1, code: 'NOT_FOUND' });
    expect(unknown.transfer).toEqual([]);
    expect(
      handleThumbnailMessage({ type: 'render', id: 2, model: 'chair', size: 4096 }).response,
    ).toMatchObject({ type: 'error', id: 2, code: 'INVALID' });
    expect(
      handleThumbnailMessage({ type: 'render', id: 3, model: 'oak_tree', size: 64, params: { seed: 'x' } })
        .response,
    ).toMatchObject({ type: 'error', id: 3, code: 'FAILED' });
    for (const bad of [
      null,
      'render',
      { type: 'render', id: 4 },
      { type: 'other', id: 5, model: 'a', size: 1 },
    ])
      expect(handleThumbnailMessage(bad).response).toMatchObject({ type: 'error', code: 'INVALID' });
  });

  it('checks the messages both ways', () => {
    expect(isRenderRequest({ type: 'render', id: 1, model: 'chair', size: 256 })).toBe(true);
    expect(isRenderRequest({ type: 'render', id: 1, model: 'chair', size: 256, params: { a: 1 } })).toBe(
      true,
    );
    expect(isRenderRequest({ type: 'render', id: 1, model: 'chair', size: 256, params: [1] })).toBe(false);
    expect(isRenderRequest({ type: 'render', id: '1', model: 'chair', size: 256 })).toBe(false);
    expect(isWorkerResponse({ type: 'done', id: 1, png: [1], ms: 1 })).toBe(false);
    expect(isWorkerResponse({ type: 'error', id: 1, message: 'x', code: 'FAILED' })).toBe(true);
    expect(isWorkerResponse({ type: 'error', message: 'x', code: 'FAILED' })).toBe(false);
  });

  it('is a module bundle of its own, with two workers on machines with four cores or more', () => {
    expect(THUMBNAIL_WORKER_URL).toMatch(/thumbnail\.worker/);
    expect(defaultWorkerCount(2)).toBe(1);
    expect(defaultWorkerCount(3)).toBe(1);
    expect(defaultWorkerCount(4)).toBe(MAX_THUMBNAIL_WORKERS);
    expect(defaultWorkerCount(16)).toBe(2);
    expect(defaultWorkerCount(0)).toBe(1);
  });
});

describe('the thumbnail worker pool', () => {
  const pool = (workers = 2, idleMs = 60_000) =>
    new ThumbnailWorkerPool({ factory: () => new FakeWorker(), workers, idleMs });

  it('runs one render per worker, starting workers as renders need them', async () => {
    const p = pool(2);
    expect(p.free).toBe(2);
    expect(p.alive).toBe(0);
    const a = p.run({ model: 'chair', size: 256 });
    expect(p.free).toBe(1);
    const b = p.run({ model: 'sofa', size: 256 });
    expect(p.free).toBe(0);
    expect(() => p.run({ model: 'bed', size: 256 })).toThrow(/free/);
    expect(FakeWorker.all.map((w) => w.posted.map((m) => m.model))).toEqual([['chair'], ['sofa']]);
    FakeWorker.all[1].answer({ type: 'done', ms: 12 });
    await expect(b).resolves.toMatchObject({ type: 'done', ms: 12 });
    expect(p.free).toBe(1);
    FakeWorker.all[0].answer({ type: 'error', code: 'NOT_FOUND', message: 'no chair' });
    await expect(a).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'no chair' });
    // free workers are used again (no third worker)
    void p.run({ model: 'bed', size: 256 });
    expect(FakeWorker.all).toHaveLength(2);
    expect(p.workersStarted).toBe(2);
  });

  it('replaces a worker that crashed, failing its render with CRASHED', async () => {
    const p = pool(1);
    const first = p.run({ model: 'chair', size: 256 });
    FakeWorker.all[0].answer({ type: 'done' });
    await first;
    const second = p.run({ model: 'sofa', size: 256 });
    FakeWorker.all[0].crash('out of memory');
    await expect(second).rejects.toBeInstanceOf(ThumbnailRenderError);
    await expect(second).rejects.toMatchObject({ code: 'CRASHED' });
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(p.alive).toBe(0);
    void p.run({ model: 'bed', size: 256 });
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('renders on the page from now on when a worker could not start (no answer before failing)', async () => {
    const p = pool(1);
    const r = p.run({ model: 'chair', size: 64 });
    FakeWorker.all[0].crash('script not found');
    // the render never ran: it can be asked for again (on the page)
    await expect(r).rejects.toMatchObject({ code: 'CRASHED', notStarted: true });
    // the next render runs on the page itself, with the worker's code
    const again = await p.run({ model: 'chair', size: 64 });
    expect(FakeWorker.all).toHaveLength(1);
    expect(again.png).toEqual(renderBuiltinThumbnailPng({ id: 'chair' }, 64).png);
    // a worker that crashed after it answered: its render ran (no asking again at once)
    const q = pool(1);
    const first = q.run({ model: 'chair', size: 64 });
    FakeWorker.all[1].answer({ type: 'done' });
    await first;
    const second = q.run({ model: 'sofa', size: 64 });
    FakeWorker.all[1].crash('out of memory');
    await expect(second).rejects.toMatchObject({ code: 'CRASHED', notStarted: false });
  });

  it("fails the stand-in's renders when its code does not load, freeing the worker's place", async () => {
    // a deploy removed the engine's chunk this page would load (or the network is gone)
    const missing: ThumbnailEngineLoader = () =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/engine-0ld.js'));
    const w = new InProcessThumbnailWorker(missing);
    const errors: string[] = [];
    w.onerror = (e) => void errors.push(e.message);
    w.postMessage({ type: 'render', id: 1, model: 'chair', size: 32 });
    w.postMessage({ type: 'render', id: 2, model: 'chair', size: 32 });
    // every request gets an answer: an error (none is left waiting)
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors[0]).toContain('Failed to fetch dynamically imported module');
    // in the pool: the render fails, the worker's place is free again, the next render runs
    let load = missing;
    const p = new ThumbnailWorkerPool({
      factory: () => new InProcessThumbnailWorker(() => load()),
      workers: 1,
    });
    const r = p.run({ model: 'chair', size: 32 });
    await expect(r).rejects.toBeInstanceOf(ThumbnailRenderError);
    // (already on the page: nowhere else to make it)
    await expect(r).rejects.toMatchObject({ code: 'CRASHED', notStarted: false });
    expect(p.free).toBe(1);
    expect(p.alive).toBe(0);
    load = () => import('../src/assets/thumbnails/engine');
    await expect(p.run({ model: 'chair', size: 32 })).resolves.toMatchObject({ type: 'done', width: 32 });
  });

  it('stops every worker on stop() (the page goes away) and when idle', async () => {
    vi.useFakeTimers();
    const p = pool(2, 1000);
    const a = p.run({ model: 'chair', size: 256 });
    p.stop();
    await expect(a).rejects.toMatchObject({ code: 'STOPPED' });
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(p.alive).toBe(0);
    const b = p.run({ model: 'sofa', size: 256 });
    FakeWorker.all[1].answer({ type: 'done' });
    await b;
    expect(p.alive).toBe(1);
    vi.advanceTimersByTime(999);
    expect(FakeWorker.all[1].terminated).toBe(false);
    vi.advanceTimersByTime(2);
    expect(FakeWorker.all[1].terminated).toBe(true);
    expect(p.alive).toBe(0);
  });

  it('has an in-page stand-in that answers like a worker, one turn later', async () => {
    const w = new InProcessThumbnailWorker();
    const got = new Promise<unknown>((resolve) => {
      w.onmessage = (e) => resolve(e.data);
    });
    w.postMessage({ type: 'render', id: 9, model: 'chair', size: 32 });
    expect(await got).toMatchObject({ type: 'done', id: 9, width: 32 });
    // terminated: no more answers
    const silent = new InProcessThumbnailWorker();
    const seen = vi.fn();
    silent.onmessage = seen;
    silent.postMessage({ type: 'render', id: 1, model: 'chair', size: 32 });
    silent.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).not.toHaveBeenCalled();
  });
});
