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

/*
 * The service worker's handling of the embeddable desk (src/pwa/sw-desk.ts, used by sw.ts;
 * docs/embedding.md "Headers" and "Offline"), on fetch API responses (Node's, as in a browser):
 * the desk page carries the server's current headers whenever the server answers, the precached
 * copy answers offline with the headers it was last served with, worker scripts get a COEP every
 * page accepts, and a new version does not take over while a desk page is open.
 */

const ORIGIN = 'https://desk.example.com';
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
      `${ORIGIN}${DESK_PAGE}?x`,
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
  const editor = `${ORIGIN}/?project=abc`;

  it('takes over when no desk page is open', async () => {
    const skipWaiting = vi.fn(async () => undefined);
    expect(await skipWaitingUnlessDeskOpen(async () => [editor, `${ORIGIN}/desk/`], skipWaiting)).toBe(true);
    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it('waits while a desk page is open in the partition it serves (the sample, a host on its site)', async () => {
    for (const desk of [`${ORIGIN}/desk.html`, `${ORIGIN}/desk?scene=1`]) {
      const skipWaiting = vi.fn(async () => undefined);
      expect(await skipWaitingUnlessDeskOpen(async () => [editor, desk], skipWaiting), desk).toBe(false);
      expect(skipWaiting).not.toHaveBeenCalled();
    }
    expect(deskPageOpen([editor])).toBe(false);
  });
});
