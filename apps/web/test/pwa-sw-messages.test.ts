// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPDATE_WAITS_FOR_DESK } from '../src/pwa/sw-desk';

/*
 * The service worker's message handler (src/pwa/sw.ts) around skipWaitingUnlessDeskOpen
 * (pwa-sw.test.ts): a SKIP_WAITING (the editor's Update) looks at every window of the partition,
 * the uncontrolled ones too (a waiting version controls none), never counts the window that asks,
 * and when a desk page keeps the new version waiting it answers that window, so that the editor
 * says why its Update did nothing (docs/embedding.md "Offline", docs/storage-and-sync.md "Offline
 * / PWA"). Workbox is replaced: only the handler is under test here; e2e/tests/desk-partition.spec.ts
 * runs the built service worker in Chromium.
 */

vi.mock('workbox-precaching', () => ({
  addPlugins: vi.fn(),
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(),
  getCacheKeyForURL: vi.fn(),
  matchPrecache: vi.fn(),
  precacheAndRoute: vi.fn(),
}));
vi.mock('workbox-routing', () => ({ NavigationRoute: class {}, registerRoute: vi.fn() }));
vi.mock('workbox-core', () => ({ cacheNames: { precache: 'precache' }, clientsClaim: vi.fn() }));

const ORIGIN = 'https://desk.example.com';

/** A window client of the service worker (the global Client of a service worker). */
class FakeClient {
  readonly postMessage = vi.fn();
  constructor(
    readonly id: string,
    readonly url: string,
  ) {}
}

let windows: FakeClient[] = [];
// as in a browser: a waiting version controls no window, so only includeUncontrolled lists them
const matchAll = vi.fn(async (options?: { type?: string; includeUncontrolled?: boolean }) =>
  options?.type === 'window' && options.includeUncontrolled ? windows : [],
);
const skipWaiting = vi.fn(async () => undefined);
let onMessage: ((event: unknown) => void) | undefined;

beforeAll(async () => {
  vi.stubGlobal('Client', FakeClient);
  vi.stubGlobal('self', {
    location: new URL(`${ORIGIN}/sw.js`),
    __WB_MANIFEST: [],
    clients: { matchAll },
    skipWaiting,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') onMessage = listener;
    },
  });
  await import('../src/pwa/sw');
});

beforeEach(() => {
  matchAll.mockClear();
  skipWaiting.mockClear();
});

/** Posts `data` to the service worker from `source`; resolves once its handler is done. */
async function post(data: unknown, source: unknown): Promise<void> {
  const pending: Promise<unknown>[] = [];
  onMessage!({ data, source, waitUntil: (p: Promise<unknown>) => void pending.push(p) });
  await Promise.all(pending);
}

describe("the service worker answers the editor's Update", () => {
  it('while a desk page is open: it keeps waiting and tells the window that asked why', async () => {
    const editor = new FakeClient('editor', `${ORIGIN}/?project=abc`);
    const desk = new FakeClient('desk', `${ORIGIN}/desk.html`);
    windows = [editor, desk];
    await post({ type: 'SKIP_WAITING' }, editor);
    expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(skipWaiting).not.toHaveBeenCalled();
    expect(editor.postMessage).toHaveBeenCalledExactlyOnceWith({ type: UPDATE_WAITS_FOR_DESK });
    expect(desk.postMessage).not.toHaveBeenCalled();
  });

  it('with no desk page open: it takes over and answers nothing (the page reloads)', async () => {
    const editor = new FakeClient('editor', `${ORIGIN}/`);
    windows = [editor, new FakeClient('other', `${ORIGIN}/desk/`)];
    await post({ type: 'SKIP_WAITING' }, editor);
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(editor.postMessage).not.toHaveBeenCalled();
  });

  it('never counts the window that asks: the editor an older version served at /desk.html updates', async () => {
    const there = new FakeClient('there', `${ORIGIN}/desk.html`);
    windows = [there];
    await post({ type: 'SKIP_WAITING' }, there);
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(there.postMessage).not.toHaveBeenCalled();
  });

  it('ignores other messages', async () => {
    const editor = new FakeClient('editor', `${ORIGIN}/`);
    windows = [editor, new FakeClient('desk', `${ORIGIN}/desk`)];
    await post({ type: 'GET_VERSION' }, editor);
    await post(null, editor);
    expect(matchAll).not.toHaveBeenCalled();
    expect(skipWaiting).not.toHaveBeenCalled();
    expect(editor.postMessage).not.toHaveBeenCalled();
  });
});
