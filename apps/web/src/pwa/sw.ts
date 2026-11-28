/// <reference lib="webworker" />
import {
  addPlugins,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  getCacheKeyForURL,
  matchPrecache,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { cacheNames, clientsClaim } from 'workbox-core';
import {
  DESK_NETWORK_TIMEOUT_MS,
  DESK_PAGE,
  answerSkipWaiting,
  deskPageAnswer,
  isDeskPageRequest,
  refreshedDeskCopy,
  withWorkerCoep,
} from './sw-desk';
import { navigationDenylist } from './sw-scope';

/*
 * The web app's service worker, for the editor and the embeddable desk alike, built by
 * vite-plugin-pwa (injectManifest: the build's file list goes in place of self.__WB_MANIFEST, as
 * paths relative to this script). Its scope is the app's base: '/' at the root, '/3d/' behind a
 * proxy at /3d/ (docs/subpath.md), and its routes are paths from that scope (sw-scope.ts). It
 * precaches the build, so both pages load and work offline (docs/embedding.md, "Offline"):
 * - the desk page (<scope>desk.html, <scope>desk): sw-desk.ts, its route first so that the
 *   precache's own cache-first route never answers it;
 * - the built files: from the precache (worker scripts with a COEP, sw-desk.ts withWorkerCoep);
 * - the editor's pages: index.html from the precache, but never for the server's own paths under
 *   the scope;
 * - a new version waits until the pages of the old one are closed, or takes over when the editor's
 *   Update asks, unless a desk page is open: then it tells the editor, which says why
 *   (sw-desk.ts answerSkipWaiting).
 */

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };

/** The registration's scope: the app's base ('https://example.com/3d/'), the routes' root. */
const SCOPE = self.registration.scope;
/** The desk page's precached URL: desk.html next to this script, as the precache resolves it. */
const DESK_PAGE_URL = new URL(DESK_PAGE, self.location.href).href;

const delay = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

async function storeDeskCopy(copy: Response): Promise<void> {
  const key = getCacheKeyForURL(DESK_PAGE_URL);
  if (key) await (await caches.open(cacheNames.precache)).put(key, copy);
}

registerRoute(
  ({ request }) => isDeskPageRequest(request, SCOPE),
  async ({ request, event }) => {
    const cached = await matchPrecache(DESK_PAGE_URL);
    const copy = cached?.clone();
    const network = fetch(request).then(
      (response) => response,
      () => null,
    );
    const fresh = await Promise.race([network, delay(DESK_NETWORK_TIMEOUT_MS)]);
    const answer = deskPageAnswer(cached, fresh);
    // later: the stored copy takes the headers the server sent (also when it answered too late)
    (event as ExtendableEvent).waitUntil(
      network.then(async (late) => {
        if (!late) return;
        const refreshed = copy ? refreshedDeskCopy(copy, late) : null;
        if (refreshed) await storeDeskCopy(refreshed).catch(() => undefined);
        if (late !== answer) await late.body?.cancel().catch(() => undefined);
      }),
    );
    return answer;
  },
);

addPlugins([
  {
    cachedResponseWillBeUsed: async ({ cachedResponse, event }) =>
      cachedResponse && event instanceof FetchEvent
        ? withWorkerCoep(cachedResponse, event.request.destination)
        : cachedResponse,
  },
]);
precacheAndRoute(self.__WB_MANIFEST, { ignoreURLParametersMatching: [/.*/] });
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    // the server's own paths under the scope (base-path.ts RESERVED_PREFIXES) are never the editor
    denylist: navigationDenylist(SCOPE),
  }),
);

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type !== 'SKIP_WAITING') return;
  event.waitUntil(
    answerSkipWaiting(
      // every window of this partition: a waiting version controls none of them
      async () =>
        (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map((c) => ({
          id: c.id,
          url: c.url,
        })),
      event.source instanceof Client ? event.source : undefined,
      () => self.skipWaiting(),
      SCOPE,
    ),
  );
});
clientsClaim();
