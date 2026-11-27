import { describe, expect, it, vi } from 'vitest';
import type { ExportWorkerRequest, ExportWorkerResponse } from '../src/export/protocol';
import { ExportWorkerEngine, serveExportRequests, type ExportWorkerScope } from '../src/export/worker-engine';
import { ExportThread, type ExportWorkerLike } from '../src/export/workers';

/*
 * The browser export's render workers as the page and the worker see their messages: the worker's
 * request loop answers every request, even one whose answer the browser cannot post (it fails with
 * that error, and the worker goes on serving), and the page fails what it waits for when a worker
 * stops or sends an answer the page cannot read. No request is left without an answer.
 */

/** The error a browser's postMessage throws for an answer it cannot clone (V8's out-of-memory one). */
const cloneError = () =>
  Object.assign(new Error('Data cannot be cloned, out of memory.'), { name: 'DataCloneError' });

/** A worker scope whose postMessage throws for the answers `fails` picks. */
function scope(fails: (r: ExportWorkerResponse) => boolean) {
  const posted: ExportWorkerResponse[] = [];
  const s: ExportWorkerScope = {
    onmessage: null,
    postMessage(r) {
      if (fails(r)) throw cloneError();
      posted.push(r);
    },
  };
  const send = (msg: ExportWorkerRequest) => s.onmessage!({ data: msg } as MessageEvent<ExportWorkerRequest>);
  return { scope: s, posted, send };
}

describe('render worker request loop', () => {
  it('fails a request whose answer cannot be posted, and keeps serving the next ones', async () => {
    let failed = false;
    const w = scope((r) => !failed && r.ok && (failed = true));
    const raised: Error[] = [];
    serveExportRequests(w.scope, new ExportWorkerEngine(), (e) => raised.push(e));
    w.send({ type: 'release', id: 1 });
    w.send({ type: 'release', id: 2 });
    w.send({ type: 'release', id: 3 });
    await vi.waitFor(() => expect(w.posted).toHaveLength(3));
    expect(w.posted[0]).toEqual({
      id: 1,
      ok: false,
      error: {
        name: 'DataCloneError',
        message:
          'the render worker could not send its answer to the page (DataCloneError: Data cannot be cloned, out of memory.)',
      },
    });
    expect(w.posted.slice(1)).toEqual([
      { id: 2, ok: true, result: { ok: true } },
      { id: 3, ok: true, result: { ok: true } },
    ]);
    expect(raised).toEqual([]);
  });

  it('raises the error outside the loop when not even it can be posted, and goes on', async () => {
    let fail = true;
    const w = scope(() => fail);
    const raised: Error[] = [];
    serveExportRequests(w.scope, new ExportWorkerEngine(), (e) => {
      raised.push(e);
      fail = false;
    });
    w.send({ type: 'release', id: 1 });
    w.send({ type: 'release', id: 2 });
    await vi.waitFor(() => expect(w.posted).toHaveLength(1));
    expect(raised.map((e) => e.name)).toEqual(['DataCloneError']);
    expect(w.posted).toEqual([{ id: 2, ok: true, result: { ok: true } }]);
  });
});

/** A worker stand-in that keeps what it is sent and answers only when told. */
function silentWorker() {
  const w: ExportWorkerLike & { sent: ExportWorkerRequest[]; terminated: boolean } = {
    sent: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(m) {
      this.sent.push(m);
    },
    terminate() {
      this.terminated = true;
    },
  };
  return w;
}

describe('render thread', () => {
  it('fails every request it waits for when the page cannot read an answer', async () => {
    const w = silentWorker();
    const thread = new ExportThread(1, () => w);
    const a = thread.call({ type: 'release' });
    const b = thread.call({ type: 'release' });
    w.onmessageerror!({} as MessageEvent);
    await expect(a).rejects.toThrow(
      'render worker 2 sent an answer this page could not read (out of memory?)',
    );
    await expect(b).rejects.toThrow(/could not read/);
    expect(thread.alive).toBe(false);
    // later requests fail at once
    await expect(thread.call({ type: 'release' })).rejects.toThrow(/could not read/);
  });

  it('fails what it waits for when the worker stops, and answers in order otherwise', async () => {
    const w = silentWorker();
    const thread = new ExportThread(0, () => w);
    const a = thread.call<{ ok: true }>({ type: 'release' });
    w.onmessage!({ data: { id: 1, ok: true, result: { ok: true } } } as MessageEvent<ExportWorkerResponse>);
    await expect(a).resolves.toEqual({ ok: true });
    const b = thread.call({ type: 'release' });
    w.onmessage!({
      data: { id: 2, ok: false, error: { message: 'no snapshot', name: 'Error', code: 'NOT_FOUND' } },
    } as MessageEvent<ExportWorkerResponse>);
    await expect(b).rejects.toMatchObject({ message: 'no snapshot', code: 'NOT_FOUND' });
    const c = thread.call({ type: 'release' });
    w.onerror!({ message: 'out of memory', preventDefault() {} } as unknown as ErrorEvent);
    await expect(c).rejects.toThrow('render worker 1 stopped: out of memory');
    expect(thread.alive).toBe(false);
  });
});
