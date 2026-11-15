import { isDeskPagePath } from '../../../server/src/desk-embed';

/*
 * What the service worker (sw.ts) does for the embeddable desk (docs/embedding.md, "Offline" and
 * "Headers"), as functions of requests and responses that tests can run without a service worker.
 *
 * - The desk page (desk.html, also at /desk) carries the headers the server sends now whenever the
 *   server answers: its frame-ancestors and COEP are deployment settings (DESK_EMBED_ORIGINS,
 *   DESK_EMBED_COEP), and a copy cached when the service worker installed must not freeze them. Its
 *   content stays the copy this service worker precached, the version whose files it serves offline
 *   (a newer page from the server would load files that only a newer service worker serves). Offline,
 *   or when the server does not answer in time, the precached copy answers with the headers it was
 *   last served with.
 * - A worker script the service worker serves without a COEP gets `require-corp`, which suits a
 *   worker under any page: so a desk page whose COEP was turned on after its scripts were cached
 *   still starts its workers (a dedicated worker of a page with a COEP needs one of its own).
 * - A new version never takes over while a desk page is open in the browser partition it serves
 *   (the sample, or a host on the desk's own site): the editor's Update would otherwise swap the
 *   files of a running desk session.
 */

/** The desk page's URL in the precache (it is served at /desk too). */
export const DESK_PAGE = '/desk.html';

/** How long a desk page waits for the server before the precached copy answers. */
export const DESK_NETWORK_TIMEOUT_MS = 4000;

/** The headers the server sets on the desk page from its settings (server/src/desk-embed.ts). */
export const DESK_PAGE_SETTING_HEADERS = [
  'content-security-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
] as const;

/** A GET of the desk page (desk.html or /desk, with any query) on the service worker's origin. */
export function isDeskPageRequest(request: Pick<Request, 'method' | 'url'>, origin: string): boolean {
  const url = new URL(request.url);
  return request.method === 'GET' && url.origin === origin && isDeskPagePath(url.pathname);
}

/** `base`'s headers with the desk page's setting headers of `from` (those `from` lacks removed). */
function settingHeadersOf(base: Response, from: Response): Headers {
  const headers = new Headers(base.headers);
  for (const name of DESK_PAGE_SETTING_HEADERS) {
    const value = from.headers.get(name);
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

/** A server answer whose headers describe the desk page: a 2xx that is no redirect. */
function isPageAnswer(fresh: Response): boolean {
  return fresh.ok && !fresh.redirected && fresh.type !== 'opaqueredirect';
}

/**
 * The answer to a request for the desk page, from the copy this service worker precached
 * (`cached`) and the server's answer (`fresh`, null when there is none in time):
 * - no answer from the server: the precached copy as it is (or a network error without one);
 * - a desk page from the server: the precached page with the server's setting headers;
 * - a redirect or a 4xx (the server moved or refused the desk): the server's answer;
 * - a 5xx: the precached copy, as offline.
 * It uses `cached`'s body; `fresh`'s body is the caller's to cancel when the answer is not `fresh`.
 */
export function deskPageAnswer(cached: Response | undefined, fresh: Response | null): Response {
  if (!fresh) return cached ?? Response.error();
  if (!cached) return fresh;
  if (fresh.status >= 500) return cached;
  if (!isPageAnswer(fresh)) return fresh;
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: settingHeadersOf(cached, fresh),
  });
}

/**
 * The copy of the desk page to store in place of `cached` after the server answered with `fresh`:
 * the same page with the server's setting headers, so that offline the page answers with the
 * headers it was last served with; null when nothing changes (or `fresh` is no desk page). Uses
 * `cached`'s body (pass a clone).
 */
export function refreshedDeskCopy(cached: Response, fresh: Response): Response | null {
  if (!isPageAnswer(fresh)) return null;
  const headers = settingHeadersOf(cached, fresh);
  if (DESK_PAGE_SETTING_HEADERS.every((name) => headers.get(name) === cached.headers.get(name))) return null;
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

/**
 * A precached response to a request of `destination`: a worker script without a COEP gets
 * `require-corp`, which every page accepts for its dedicated workers; anything else is unchanged.
 */
export function withWorkerCoep(response: Response, destination: string): Response {
  if (destination !== 'worker' || response.headers.has('cross-origin-embedder-policy')) return response;
  if (response.type !== 'basic' && response.type !== 'default') return response;
  const headers = new Headers(response.headers);
  headers.set('cross-origin-embedder-policy', 'require-corp');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Whether one of these window clients (their URLs) is a desk page. */
export function deskPageOpen(clientUrls: readonly string[]): boolean {
  return clientUrls.some((url) => isDeskPagePath(new URL(url).pathname));
}

/** A window client of the service worker: its id and URL. */
export interface WindowInfo {
  id: string;
  url: string;
}

/**
 * The SKIP_WAITING message (the editor's Update, pwa/register.ts): this waiting version takes over
 * at once unless a desk page is open among the windows it would take over. Then it waits as
 * versions do, until every page of the active one is closed (or Update is pressed again once the
 * desk is closed). The window that asks (`senderId`) is never a desk, which has no Update: at a
 * desk path it is the editor that an older service worker answered there, which may update.
 */
export async function skipWaitingUnlessDeskOpen(
  windows: () => Promise<readonly WindowInfo[]>,
  senderId: string | undefined,
  skipWaiting: () => Promise<void>,
): Promise<boolean> {
  const others = (await windows()).filter((w) => w.id !== senderId);
  if (deskPageOpen(others.map((w) => w.url))) return false;
  await skipWaiting();
  return true;
}
