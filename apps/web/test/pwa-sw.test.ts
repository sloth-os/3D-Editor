// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  DESK_PAGE,
  DESK_PAGE_SETTING_HEADERS,
  deskPageAnswer,
  deskPageOpen,
  isDeskPageRequest,
  refreshedDeskCopy,
  skipWaitingUnlessDeskOpen,
  withWorkerCoep,
} from '../src/pwa/sw-desk';
import { navigationDenylist, pathInScope } from '../src/pwa/sw-scope';

/*
 * The service worker's handling of the embeddable desk (src/pwa/sw-desk.ts, used by sw.ts;
 * docs/embedding.md "Headers" and "Offline"), on fetch API responses (Node's, as in a browser):
 * the desk page carries the server's current headers whenever the server answers, the precached
 * copy answers offline with the headers it was last served with, worker scripts get a COEP every
 * page accepts, and a new version does not take over while a desk page is open. Its routes are
 * paths from its scope, the app's base (src/pwa/sw-scope.ts, docs/subpath.md): at the root of the
 * origin and under a subpath alike, never outside the scope.
 */

const ORIGIN = 'https://desk.example.com';
/** The scope of a service worker under a subpath (registration.scope: the base with its slash). */
const SUB = `${ORIGIN}/3d/`;
const PAGE_BODY = '<!doctype html><title>desk</title>';

/** The desk page as the server sends it with `settings` headers (a 200 by default). */
function page(headers: Record<string, string>, init: { body?: string; status?: number } = {}): Response {
  return new Response(init.body ?? PAGE_BODY, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...headers },
  });
}

const OLD = {
  'content-security-policy': 'frame-ancestors *',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'cross-origin',
};
const NEW = {
  'content-security-policy': 'frame-ancestors https://studio.example.com',
  'cross-origin-embedder-policy': 'credentialless',
  'cross-origin-resource-policy': 'cross-origin',
};
const settingsOf = (r: Response) =>
  Object.fromEntries(DESK_PAGE_SETTING_HEADERS.map((n) => [n, r.headers.get(n)]));

describe('the desk page', () => {
  it('is desk.html and /desk with any query, GET, on the service worker origin', () => {
    const req = (url: string, method = 'GET') => ({ url, method });
    for (const url of [
      `${ORIGIN}/desk.html`,
      `${ORIGIN}/desk`,
      `${ORIGIN}/desk?scene=1`,
      `${new URL(DESK_PAGE, `${ORIGIN}/sw.js`).href}?x`,
    ])
      expect(isDeskPageRequest(req(url), ORIGIN), url).toBe(true);
    for (const url of [
      `${ORIGIN}/`,
      `${ORIGIN}/index.html`,
      `${ORIGIN}/desk/`,
      `${ORIGIN}/desk.html/`,
      `${ORIGIN}/assets/desk-1.js`,
      'https://other.example/desk.html',
    ])
      expect(isDeskPageRequest(req(url), ORIGIN), url).toBe(false);
    expect(isDeskPageRequest(req(`${ORIGIN}/desk.html`, 'HEAD'), ORIGIN)).toBe(false);
    // the registration's scope at the root (with its slash) is the same as the origin alone
    expect(isDeskPageRequest(req(`${ORIGIN}/desk?scene=1`), `${ORIGIN}/`)).toBe(true);
    expect(isDeskPageRequest(req(`${ORIGIN}/desk/`), `${ORIGIN}/`)).toBe(false);
  });

  it('under a subpath is <scope>desk.html and <scope>desk, nothing outside the scope', () => {
    const req = (url: string, method = 'GET') => ({ url, method });
    for (const url of [`${SUB}desk.html`, `${SUB}desk`, `${SUB}desk?scene=1`, `${SUB}desk.html?x`])
      expect(isDeskPageRequest(req(url), SUB), url).toBe(true);
    for (const url of [
      // the root's desk (another base on the same origin) and look-alikes of the scope
      `${ORIGIN}/desk.html`,
      `${ORIGIN}/desk`,
      `${ORIGIN}/3dx/desk.html`,
      `${ORIGIN}/3d`,
      `${ORIGIN}/other/3d/desk.html`,
      // the editor's paths and the built files under the scope
      SUB,
      `${SUB}index.html`,
      `${SUB}desk/`,
      `${SUB}desk.html/`,
      `${SUB}3d/desk.html`,
      `${SUB}assets/desk-1.js`,
      'https://other.example/3d/desk.html',
    ])
      expect(isDeskPageRequest(req(url), SUB), url).toBe(false);
    expect(isDeskPageRequest(req(`${SUB}desk.html`, 'POST'), SUB)).toBe(false);
  });

  it('is precached next to the service worker: its key is resolved against the script', () => {
    // sw.ts resolves DESK_PAGE against its own URL, as Workbox resolves the build's file list
    expect(DESK_PAGE).toBe('desk.html');
    expect(new URL(DESK_PAGE, `${ORIGIN}/sw.js`).href).toBe(`${ORIGIN}/desk.html`);
    expect(new URL(DESK_PAGE, `${SUB}sw.js`).href).toBe(`${SUB}desk.html`);
  });

  it("online: the precached page with the server's headers, a header the server drops dropped", async () => {
    const answer = deskPageAnswer(page(OLD), page(NEW, { body: 'a newer build of the page' }));
    expect(settingsOf(answer)).toEqual(NEW);
    // the content is the precached copy: the version whose files this service worker serves
    expect(await answer.text()).toBe(PAGE_BODY);
    expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const off = deskPageAnswer(page(OLD), page({ ...NEW, 'cross-origin-embedder-policy': '' }));
    // an empty header still counts as sent
    expect(off.headers.get('cross-origin-embedder-policy')).toBe('');
    const none = page({ 'content-security-policy': NEW['content-security-policy'] });
    expect(settingsOf(deskPageAnswer(page(OLD), none))).toEqual({
      'content-security-policy': NEW['content-security-policy'],
      'cross-origin-embedder-policy': null,
      'cross-origin-resource-policy': null,
    });
  });

  it('offline, or without an answer in time: the precached copy as it is', async () => {
    const cached = page(OLD);
    expect(deskPageAnswer(cached, null)).toBe(cached);
    expect(deskPageAnswer(undefined, null).type).toBe('error');
  });

  it("the server's own answer when it moved or refused the desk, the copy when it failed", () => {
    const gone = page({}, { status: 404 });
    expect(deskPageAnswer(page(OLD), gone)).toBe(gone);
    const refused = page({}, { status: 403 });
    expect(deskPageAnswer(page(OLD), refused)).toBe(refused);
    const cached = page(OLD);
    expect(deskPageAnswer(cached, page(NEW, { status: 503 }))).toBe(cached);
    const moved = Response.redirect(`${ORIGIN}/login`, 302);
    expect(deskPageAnswer(page(OLD), moved)).toBe(moved);
    // nothing precached: the server's answer, whatever it is
    const fresh = page(NEW);
    expect(deskPageAnswer(undefined, fresh)).toBe(fresh);
  });

  it('keeps the headers it was last served with for offline, and stores nothing when they did not change', async () => {
    const copy = refreshedDeskCopy(page(OLD), page(NEW, { body: 'another build' }));
    expect(copy).not.toBeNull();
    expect(settingsOf(copy!)).toEqual(NEW);
    expect(await copy!.text()).toBe(PAGE_BODY);
    expect(refreshedDeskCopy(page(OLD), page(OLD))).toBeNull();
    expect(refreshedDeskCopy(page(OLD), page(NEW, { status: 500 }))).toBeNull();
    expect(refreshedDeskCopy(page(OLD), page(NEW, { status: 404 }))).toBeNull();
  });
});

describe('worker scripts', () => {
  const script = (headers: Record<string, string> = {}) =>
    new Response('postMessage(1)', { headers: { 'content-type': 'text/javascript', ...headers } });

  it('without a COEP get require-corp, which every page accepts for its dedicated workers', () => {
    const served = withWorkerCoep(script({ 'cross-origin-resource-policy': 'cross-origin' }), 'worker');
    expect(served.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(served.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('keep the COEP they have; other files are left as they are', () => {
    const own = script({ 'cross-origin-embedder-policy': 'credentialless' });
    expect(withWorkerCoep(own, 'worker')).toBe(own);
    for (const destination of ['script', 'style', 'document', 'iframe', '']) {
      const res = script();
      expect(withWorkerCoep(res, destination), destination).toBe(res);
    }
  });
});

describe("a new version and the editor's Update", () => {
  const editor = { id: 'editor', url: `${ORIGIN}/?project=abc` };
  const windows =
    (...list: { id: string; url: string }[]) =>
    async () =>
      list;

  it('takes over when no desk page is open', async () => {
    const skipWaiting = vi.fn(async () => undefined);
    const other = { id: 'other', url: `${ORIGIN}/desk/` };
    expect(await skipWaitingUnlessDeskOpen(windows(editor, other), 'editor', skipWaiting, ORIGIN)).toBe(true);
    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it('waits while a desk page is open in the partition it serves (the sample, a host on its site)', async () => {
    for (const url of [`${ORIGIN}/desk.html`, `${ORIGIN}/desk?scene=1`]) {
      const skipWaiting = vi.fn(async () => undefined);
      const desk = { id: 'desk', url };
      expect(await skipWaitingUnlessDeskOpen(windows(editor, desk), 'editor', skipWaiting, ORIGIN), url).toBe(
        false,
      );
      expect(skipWaiting).not.toHaveBeenCalled();
    }
    expect(deskPageOpen([editor.url], ORIGIN)).toBe(false);
  });

  it('the window that asks is no desk: the editor an older version answered at a desk path updates', async () => {
    // an older service worker answered /desk.html with the editor, whose Update asks from there
    const there = { id: 'there', url: `${ORIGIN}/desk.html` };
    const skipWaiting = vi.fn(async () => undefined);
    expect(await skipWaitingUnlessDeskOpen(windows(editor, there), 'there', skipWaiting, ORIGIN)).toBe(true);
    expect(skipWaiting).toHaveBeenCalledOnce();
    // another window at a desk path still holds it
    const desk = { id: 'desk', url: `${ORIGIN}/desk` };
    const held = vi.fn(async () => undefined);
    expect(await skipWaitingUnlessDeskOpen(windows(editor, there, desk), 'there', held, ORIGIN)).toBe(false);
    expect(held).not.toHaveBeenCalled();
  });

  it('under a subpath, only desk windows within its scope hold it: not those of another base', async () => {
    const subEditor = { id: 'editor', url: `${SUB}?project=abc` };
    // a desk of the root's service worker, or of another base, on the same origin: matchAll lists
    // every window of the origin, but those pages are not this version's to take over
    for (const url of [`${ORIGIN}/desk.html`, `${ORIGIN}/desk`, `${ORIGIN}/other/desk.html`, `${SUB}desk/`]) {
      const skipWaiting = vi.fn(async () => undefined);
      const elsewhere = { id: 'elsewhere', url };
      expect(
        await skipWaitingUnlessDeskOpen(windows(subEditor, elsewhere), 'editor', skipWaiting, SUB),
        url,
      ).toBe(true);
      expect(skipWaiting).toHaveBeenCalledOnce();
    }
    for (const url of [`${SUB}desk.html`, `${SUB}desk?scene=1`]) {
      const skipWaiting = vi.fn(async () => undefined);
      const desk = { id: 'desk', url };
      expect(await skipWaitingUnlessDeskOpen(windows(subEditor, desk), 'editor', skipWaiting, SUB), url).toBe(
        false,
      );
      expect(skipWaiting).not.toHaveBeenCalled();
    }
    // the root's service worker is not held back by a desk under the subpath either
    expect(deskPageOpen([`${SUB}desk.html`], ORIGIN)).toBe(false);
    expect(deskPageOpen([`${SUB}desk.html`], `${ORIGIN}/other/`)).toBe(false);
  });
});

describe("the service worker's scope", () => {
  it('gives paths from the scope, and none on another origin or outside it', () => {
    expect(pathInScope(`${SUB}desk.html`, SUB)).toBe('/desk.html');
    expect(pathInScope(SUB, SUB)).toBe('/');
    expect(pathInScope(`${SUB}api/projects?x=1`, SUB)).toBe('/api/projects');
    expect(pathInScope(`${ORIGIN}/desk.html`, ORIGIN)).toBe('/desk.html');
    expect(pathInScope(`${ORIGIN}/desk.html`, `${ORIGIN}/`)).toBe('/desk.html');
    expect(pathInScope(new URL(`${SUB}desk`), SUB)).toBe('/desk');
    for (const url of [
      `${ORIGIN}/desk.html`,
      `${ORIGIN}/3d`,
      `${ORIGIN}/3dx/desk.html`,
      'https://other.example/3d/',
    ])
      expect(pathInScope(url, SUB), url).toBeNull();
  });

  /** Whether a navigation to `url` is left to the network (Workbox tests a path with its query). */
  const denied = (list: RegExp[], url: string) => {
    const u = new URL(url);
    return list.some((r) => r.test(`${u.pathname}${u.search}`));
  };

  it("at the root is the denylist the service worker always had: the server's own paths", () => {
    const before = [
      /^\/api\//,
      /^\/sync\//,
      /^\/mcp/,
      /^\/dav\//,
      /^\/otlp\//,
      /^\/metrics/,
      /^\/healthz/,
      /^\/readyz/,
    ];
    for (const scope of [ORIGIN, `${ORIGIN}/`])
      expect(navigationDenylist(scope).map(String), scope).toEqual(before.map(String));
    const list = navigationDenylist(`${ORIGIN}/`);
    for (const path of [
      '/api/projects',
      '/sync/p1',
      '/mcp',
      '/mcp/x',
      '/dav/',
      '/otlp/v1/traces',
      '/metrics',
      '/healthz',
      '/readyz',
    ])
      expect(denied(list, `${ORIGIN}${path}`), path).toBe(true);
    // the editor's pages, also at the bare names of the server's route families (as before)
    for (const path of ['/', '/?project=p1', '/index.html', '/desk/', '/api', '/dav', '/projects/api/'])
      expect(denied(list, `${ORIGIN}${path}`), path).toBe(false);
  });

  it("under a subpath leaves the server's paths under the scope to the network, and only those", () => {
    const list = navigationDenylist(SUB);
    expect(list.map((r) => r.source)).toEqual([
      '^\\/3d\\/api\\/',
      '^\\/3d\\/sync\\/',
      '^\\/3d\\/mcp',
      '^\\/3d\\/dav\\/',
      '^\\/3d\\/otlp\\/',
      '^\\/3d\\/metrics',
      '^\\/3d\\/healthz',
      '^\\/3d\\/readyz',
    ]);
    for (const path of [
      'api/projects',
      'sync/p1',
      'mcp',
      'dav/3d-editor/',
      'otlp/v1/logs',
      'metrics',
      'healthz',
      'readyz',
    ])
      expect(denied(list, `${SUB}${path}`), path).toBe(true);
    for (const path of ['', '?project=p1', 'index.html', 'desk/', 'api', 'dav', '3d/api/x'])
      expect(denied(list, `${SUB}${path}`), path).toBe(false);
    // a base with a dot is matched as written, not as a pattern
    const dotted = navigationDenylist(`${ORIGIN}/v1.2/`);
    expect(denied(dotted, `${ORIGIN}/v1.2/api/projects`)).toBe(true);
    expect(denied(dotted, `${ORIGIN}/v1x2/api/projects`)).toBe(false);
  });
});
