// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPDATE_WAITS_FOR_DESK } from '../src/pwa/sw-desk';
import { navigationDenylist } from '../src/pwa/sw-scope';

/*
 * The service worker's message handler (src/pwa/sw.ts) around skipWaitingUnlessDeskOpen
 * (pwa-sw.test.ts): a SKIP_WAITING (the editor's Update) looks at every window of the partition,
 * the uncontrolled ones too (a waiting version controls none), never counts the window that asks,
 * and when a desk page keeps the new version waiting it answers that window, so that the editor
 * says why its Update did nothing (docs/embedding.md "Offline", docs/storage-and-sync.md "Offline
 * / PWA"). Then its routes, under the scope it was registered with (docs/subpath.md): the root of
 * the origin, and a subpath, where only the desk pages and the server paths under the scope count.
 * Workbox is replaced: only sw.ts's own code is under test here; e2e/tests/desk-partition.spec.ts
 * runs the built service worker in Chromium.
 */

/**
 * What sw.ts gave Workbox: its routes and their handlers, its navigation route's options, the pages
 * they serve, and the URLs it looked up in the precache.
 */
const workbox = vi.hoisted(() => ({
  routes: [] as unknown[],
  handlers: [] as unknown[],
  navigations: [] as { denylist?: RegExp[] }[],
  boundTo: [] as string[],
  precacheLookups: [] as string[],
}));

/** The precached desk page the precache mock answers with. */
const PRECACHED_PAGE = '<!doctype html><title>desk</title>';

vi.mock('workbox-precaching', () => ({
  addPlugins: vi.fn(),
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn((url: string) => {
    workbox.boundTo.push(url);
    return () => undefined;
  }),
  getCacheKeyForURL: vi.fn(),
  matchPrecache: vi.fn(async (url: string) => {
    workbox.precacheLookups.push(url);
    return new Response(PRECACHED_PAGE, { headers: { 'content-type': 'text/html' } });
  }),
  precacheAndRoute: vi.fn(),
}));
vi.mock('workbox-routing', () => ({
  NavigationRoute: class {
    constructor(_handler: unknown, options: { denylist?: RegExp[] }) {
      workbox.navigations.push(options);
    }
  },
  registerRoute: vi.fn((route: unknown, handler?: unknown) => {
    workbox.routes.push(route);
    workbox.handlers.push(handler);
  }),
}));
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

/**
 * Runs sw.ts as a browser would with the registration's `scope` (its script is <scope>sw.js, as the
 * editor and the desk register it), after the Workbox records of an earlier run are cleared.
 */
async function loadServiceWorker(scope: string): Promise<void> {
  vi.resetModules();
  workbox.routes.length = 0;
  workbox.handlers.length = 0;
  workbox.navigations.length = 0;
  workbox.boundTo.length = 0;
  onMessage = undefined;
  vi.stubGlobal('Client', FakeClient);
  vi.stubGlobal('self', {
    location: new URL('sw.js', scope),
    registration: { scope },
    __WB_MANIFEST: [],
    clients: { matchAll },
    skipWaiting,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') onMessage = listener;
    },
  });
  await import('../src/pwa/sw');
}

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

/** Whether sw.ts's desk route (its first route, a match callback) takes a GET of `url`. */
function deskRouteTakes(url: string): boolean {
  const match = workbox.routes[0] as (ctx: { request: { method: string; url: string } }) => boolean;
  return match({ request: { method: 'GET', url } });
}

type DeskHandler = (ctx: {
  request: Request;
  event: { waitUntil(p: Promise<unknown>): void };
}) => Promise<Response>;

/**
 * Runs sw.ts's desk route handler for a GET of `url` while the server does not answer (offline):
 * checks that the precached page answers, and resolves with the URLs looked up in the precache.
 */
async function deskPageOffline(url: string): Promise<string[]> {
  const handler = workbox.handlers[0] as DeskHandler;
  workbox.precacheLookups.length = 0;
  const offline = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
  try {
    const pending: Promise<unknown>[] = [];
    const answer = await handler({
      request: new Request(url),
      event: { waitUntil: (p) => void pending.push(p) },
    });
    await Promise.all(pending);
    expect(await answer.text()).toBe(PRECACHED_PAGE);
    return [...workbox.precacheLookups];
  } finally {
    offline.mockRestore();
  }
}

describe("the service worker answers the editor's Update", () => {
  beforeAll(() => loadServiceWorker(`${ORIGIN}/`));

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

  it("routes from the root: the desk page, index.html for navigations, the server's paths to the network", () => {
    expect(deskRouteTakes(`${ORIGIN}/desk.html`)).toBe(true);
    expect(deskRouteTakes(`${ORIGIN}/desk?scene=1`)).toBe(true);
    expect(deskRouteTakes(`${ORIGIN}/desk/`)).toBe(false);
    expect(workbox.boundTo).toEqual(['index.html']);
    expect(workbox.navigations).toHaveLength(1);
    expect(workbox.navigations[0]!.denylist!.map(String)).toEqual(
      [
        /^\/api\//,
        /^\/sync\//,
        /^\/mcp/,
        /^\/dav\//,
        /^\/otlp\//,
        /^\/metrics/,
        /^\/healthz/,
        /^\/readyz/,
      ].map(String),
    );
  });

  it('answers the desk page offline with its precached copy, /desk.html', async () => {
    expect(await deskPageOffline(`${ORIGIN}/desk?scene=1`)).toEqual([`${ORIGIN}/desk.html`]);
  });
});

describe('the service worker of a base under a subpath', () => {
  const SCOPE = `${ORIGIN}/3d/`;
  beforeAll(() => loadServiceWorker(SCOPE));

  it('routes the desk page under its scope and leaves the root (another base) alone', () => {
    expect(deskRouteTakes(`${SCOPE}desk.html`)).toBe(true);
    expect(deskRouteTakes(`${SCOPE}desk?scene=1`)).toBe(true);
    for (const url of [`${ORIGIN}/desk.html`, `${ORIGIN}/desk`, `${SCOPE}desk/`, `${ORIGIN}/3dx/desk.html`])
      expect(deskRouteTakes(url), url).toBe(false);
  });

  it('answers the desk page offline with the copy precached under its scope', async () => {
    // the precache holds <scope>desk.html, not the root's /desk.html (another base's)
    expect(await deskPageOffline(`${SCOPE}desk`)).toEqual([`${SCOPE}desk.html`]);
    expect(await deskPageOffline(`${SCOPE}desk.html?x=1`)).toEqual([`${SCOPE}desk.html`]);
  });

  it("answers navigations with its index.html, but not the server's paths under its scope", () => {
    // index.html next to the script, as Workbox resolves it: <scope>index.html
    expect(workbox.boundTo).toEqual(['index.html']);
    expect(workbox.navigations).toHaveLength(1);
    const denylist = workbox.navigations[0]!.denylist!;
    expect(denylist.map(String)).toEqual(navigationDenylist(SCOPE).map(String));
    const denied = (path: string) => denylist.some((r) => r.test(path));
    for (const path of ['/3d/api/projects', '/3d/sync/p1', '/3d/mcp', '/3d/dav/x', '/3d/healthz'])
      expect(denied(path), path).toBe(true);
    for (const path of ['/3d/', '/3d/?project=p1', '/3d/index.html', '/3d/desk/'])
      expect(denied(path), path).toBe(false);
  });

  it('waits for a desk page of its scope, and tells the window that asked', async () => {
    const editor = new FakeClient('editor', `${SCOPE}?project=abc`);
    const desk = new FakeClient('desk', `${SCOPE}desk.html`);
    windows = [editor, desk];
    await post({ type: 'SKIP_WAITING' }, editor);
    expect(skipWaiting).not.toHaveBeenCalled();
    expect(editor.postMessage).toHaveBeenCalledExactlyOnceWith({ type: UPDATE_WAITS_FOR_DESK });
  });

  it("takes over while only another base's desk is open on the origin", async () => {
    const editor = new FakeClient('editor', `${SCOPE}?project=abc`);
    windows = [
      editor,
      new FakeClient('root-desk', `${ORIGIN}/desk.html`),
      new FakeClient('x', `${ORIGIN}/desk`),
    ];
    await post({ type: 'SKIP_WAITING' }, editor);
    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(editor.postMessage).not.toHaveBeenCalled();
  });
});
