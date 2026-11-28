// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPDATE_WAITS_FOR_DESK } from '../src/pwa/sw-desk';
import { editorPageNavigations } from '../src/pwa/sw-scope';

/*
 * The service worker's message handler (src/pwa/sw.ts) around skipWaitingUnlessDeskOpen
 * (pwa-sw.test.ts): a SKIP_WAITING (the editor's Update) looks at every window of the partition,
 * the uncontrolled ones too (a waiting version controls none), never counts the window that asks,
 * and when a desk page keeps the new version waiting it answers that window, so that the editor
 * says why its Update did nothing (docs/embedding.md "Offline", docs/storage-and-sync.md "Offline
 * / PWA"). Then its routes, under the scope it was registered with (docs/subpath.md): the root of
 * the origin, and a subpath, where only the desk page and the editor's page under the scope are
 * answered from the precache, and every other navigation goes to the network; and the precaches it
 * deletes once active, only its own scope's. Workbox is replaced: only sw.ts's own code is under
 * test here; e2e/tests/desk-partition.spec.ts and static-host.spec.ts run the built service worker
 * in Chromium.
 */

/**
 * What sw.ts gave Workbox: its routes and their handlers in the order Workbox's router tries them
 * (`order`: the desk route, the navigation route, the precache's route), its navigation route's
 * options, the precache's route's options, the pages they serve, and the URLs it looked up in the
 * precache.
 */
const workbox = vi.hoisted(() => ({
  routes: [] as unknown[],
  handlers: [] as unknown[],
  order: [] as string[],
  navigations: [] as { allowlist?: RegExp[]; denylist?: RegExp[] }[],
  precacheRoutes: [] as unknown[],
  boundTo: [] as string[],
  precacheLookups: [] as string[],
}));

/** The precached desk page the precache mock answers with. */
const PRECACHED_PAGE = '<!doctype html><title>desk</title>';

vi.mock('workbox-precaching', () => ({
  addPlugins: vi.fn(),
  addRoute: vi.fn((options: unknown) => {
    workbox.precacheRoutes.push(options);
    workbox.order.push('precache');
  }),
  precache: vi.fn(),
  createHandlerBoundToURL: vi.fn((url: string) => {
    workbox.boundTo.push(url);
    return () => undefined;
  }),
  getCacheKeyForURL: vi.fn(),
  matchPrecache: vi.fn(async (url: string) => {
    workbox.precacheLookups.push(url);
    return new Response(PRECACHED_PAGE, { headers: { 'content-type': 'text/html' } });
  }),
}));
vi.mock('workbox-routing', () => ({
  NavigationRoute: class {
    readonly navigation = true;
    constructor(_handler: unknown, options: { allowlist?: RegExp[]; denylist?: RegExp[] }) {
      workbox.navigations.push(options);
    }
  },
  registerRoute: vi.fn((route: unknown, handler?: unknown) => {
    workbox.routes.push(route);
    workbox.handlers.push(handler);
    workbox.order.push((route as { navigation?: boolean }).navigation ? 'navigation' : 'desk');
  }),
}));
// Workbox's precache name: its prefix and the registration's scope (workbox-core cacheNames)
vi.mock('workbox-core', () => ({
  cacheNames: {
    get precache() {
      return `workbox-precache-v2-${(globalThis as unknown as { self: ServiceWorkerGlobalScope }).self.registration.scope}`;
    },
  },
  clientsClaim: vi.fn(),
}));

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
let onActivate: ((event: unknown) => void) | undefined;
/** The service worker global loadServiceWorker gave sw.ts. */
let currentSelf: unknown;

/**
 * Runs sw.ts as a browser would with the registration's `scope` (its script is <scope>sw.js, as the
 * editor and the desk register it), after the Workbox records of an earlier run are cleared.
 */
async function loadServiceWorker(scope: string): Promise<void> {
  vi.resetModules();
  workbox.routes.length = 0;
  workbox.handlers.length = 0;
  workbox.order.length = 0;
  workbox.navigations.length = 0;
  workbox.precacheRoutes.length = 0;
  workbox.boundTo.length = 0;
  onMessage = undefined;
  onActivate = undefined;
  vi.stubGlobal('Client', FakeClient);
  currentSelf = {
    location: new URL('sw.js', scope),
    registration: { scope },
    __WB_MANIFEST: [],
    clients: { matchAll },
    skipWaiting,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') onMessage = listener;
      if (type === 'activate') onActivate = listener;
    },
  };
  vi.stubGlobal('self', currentSelf);
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

/**
 * Whether sw.ts's navigation route answers a navigation to `url` with the editor's page: Workbox
 * tests its allowlist (and denylist, which sw.ts gives none) on the URL's path and query.
 */
function editorPageAnswers(url: string): boolean {
  const { allowlist = [/./], denylist = [] } = workbox.navigations[0]!;
  const u = new URL(url);
  const target = `${u.pathname}${u.search}`;
  return !denylist.some((r) => r.test(target)) && allowlist.some((r) => r.test(target));
}

/**
 * Activates sw.ts with `names` in Cache Storage: resolves with the names it deleted, once the
 * activate event's waitUntil promise has settled.
 */
async function activateWith(names: string[]): Promise<string[]> {
  const deleted: string[] = [];
  vi.stubGlobal('caches', {
    keys: vi.fn(async () => [...names]),
    delete: vi.fn(async (name: string) => {
      deleted.push(name);
      return true;
    }),
  });
  try {
    const pending: Promise<unknown>[] = [];
    onActivate!({ waitUntil: (p: Promise<unknown>) => void pending.push(p) });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    return deleted.sort();
  } finally {
    vi.unstubAllGlobals();
    // the service worker's own globals stay (loadServiceWorker stubbed them)
    vi.stubGlobal('Client', FakeClient);
    vi.stubGlobal('self', currentSelf);
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

  it("routes from the root: the desk page, then the editor's page for / and /index.html only, then the files", () => {
    expect(deskRouteTakes(`${ORIGIN}/desk.html`)).toBe(true);
    expect(deskRouteTakes(`${ORIGIN}/desk?scene=1`)).toBe(true);
    expect(deskRouteTakes(`${ORIGIN}/desk/`)).toBe(false);
    // Workbox's router tries routes in this order: the precache's comes last
    expect(workbox.order).toEqual(['desk', 'navigation', 'precache']);
    expect(workbox.boundTo).toEqual(['index.html']);
    expect(workbox.navigations).toHaveLength(1);
    expect(workbox.navigations[0]!.denylist).toBeUndefined();
    expect(workbox.navigations[0]!.allowlist!.map(String)).toEqual(
      editorPageNavigations(`${ORIGIN}/`).map(String),
    );
    for (const path of ['/', '/?project=p1', '/index.html', '/index.html?x=1'])
      expect(editorPageAnswers(`${ORIGIN}${path}`), path).toBe(true);
    // deeper paths, the desk's look-alikes, the server's paths and a deployment nested in the scope
    for (const path of ['/x/y', '/desk/', '/desk.html/', '/api/projects', '/mcp', '/3d/', '/folder/'])
      expect(editorPageAnswers(`${ORIGIN}${path}`), path).toBe(false);
    // the precache's route ignores every query, and answers no clean URL (/index for index.html)
    expect(workbox.precacheRoutes).toEqual([{ ignoreURLParametersMatching: [/.*/], cleanURLs: false }]);
  });

  it("deletes, once active, the precaches of its own earlier versions and never another scope's", async () => {
    const root = `${ORIGIN}/`;
    expect(
      await activateWith([
        `workbox-precache-v2-${root}`,
        `workbox-precache-${root}`,
        `workbox-precache-v2-${root}folder/`,
        `workbox-precache-v2-${ORIGIN}/3d/`,
        `workbox-runtime-${root}`,
      ]),
    ).toEqual([`workbox-precache-${root}`]);
    expect(await activateWith([`workbox-precache-v2-${root}`])).toEqual([]);
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

  it("answers navigations to its editor's page only: never the root's, a deeper path or the server's", () => {
    // index.html next to the script, as Workbox resolves it: <scope>index.html
    expect(workbox.boundTo).toEqual(['index.html']);
    expect(workbox.order).toEqual(['desk', 'navigation', 'precache']);
    expect(workbox.navigations).toHaveLength(1);
    expect(workbox.navigations[0]!.allowlist!.map(String)).toEqual(editorPageNavigations(SCOPE).map(String));
    for (const url of [SCOPE, `${SCOPE}?project=p1`, `${SCOPE}index.html`])
      expect(editorPageAnswers(url), url).toBe(true);
    for (const path of [
      '/3d/x/y',
      '/3d/desk/',
      '/3d/desk.html/',
      '/3d/api/projects',
      '/3d/mcp',
      '/',
      '/index.html',
    ])
      expect(editorPageAnswers(`${ORIGIN}${path}`), path).toBe(false);
  });

  it("deletes, once active, only the outdated precaches of its scope: never the root deployment's", async () => {
    expect(
      await activateWith([
        `workbox-precache-v2-${SCOPE}`,
        `workbox-precache-${SCOPE}`,
        `workbox-precache-v2-${ORIGIN}/`,
        `workbox-precache-${ORIGIN}/`,
        `workbox-precache-v2-${SCOPE}x/`,
      ]),
    ).toEqual([`workbox-precache-${SCOPE}`]);
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
