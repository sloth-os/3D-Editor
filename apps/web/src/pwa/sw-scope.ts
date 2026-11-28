import { pathWithin } from '../../../server/src/base-path';

/*
 * The service worker's routes relative to its registration's scope (docs/subpath.md, "The web
 * app"). The scope is the app's base: the editor and the desk register the base's sw.js with the
 * base as its scope (pwa/register.ts, embed/pwa.ts), so it is 'https://example.com/3d/' for the
 * editor behind a proxy at /3d/ and the root of the origin otherwise. Its routes (the desk page, the
 * editor's page for navigations) are paths from that scope, as the server's are from its base, and
 * so are the caches it cleans up: never another scope's, also on the same origin (another editor
 * deployment at a parent or nested path). Pure, for sw.ts, sw-desk.ts and their tests.
 */

/**
 * The path of `url` from `scope` (a scope URL such as `ServiceWorkerRegistration.scope`; an origin
 * alone is the root scope): '/desk.html' for https://example.com/3d/desk.html in
 * https://example.com/3d/, '/' for the scope itself, null on another origin or outside the scope.
 */
export function pathInScope(url: string | URL, scope: string): string | null {
  const target = new URL(url);
  const within = new URL(scope);
  if (target.origin !== within.origin) return null;
  return pathWithin(target.pathname, within.pathname);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The navigations the service worker answers with the editor's page from its precache (sw.ts's
 * NavigationRoute allowlist): the scope itself and <scope>index.html, with any query. Workbox tests
 * the patterns on a URL's path and query: at the root that is /^\/(?:index\.html)?(?:\?.*)?$/, under
 * https://example.com/3d/ the same after \/3d\/. Every other navigation in the scope goes to the
 * network (the desk page has its own route): a deeper path, desk/ or desk.html/, which the editor
 * server answers with the editor and a static host with its own 404 or redirect (the editor's page
 * there would look for its files under that path, as a static host writes no <base href>), the
 * server's own paths, and the pages of another deployment nested in the scope (/3d/ under an editor
 * at the root), which load their own page and service worker.
 */
export function editorPageNavigations(scope: string): RegExp[] {
  const path = new URL(scope).pathname;
  const base = escapeRegExp(path.endsWith('/') ? path : `${path}/`);
  return [new RegExp(`^${base}(?:index\\.html)?(?:\\?.*)?$`)];
}

/**
 * Of the Cache Storage `names` of the service worker's origin, those of the precaches that earlier
 * versions of this service worker left under its `scope` (its registration's scope URL), which it
 * deletes once it is active (sw.ts): names with '-precache-' that end with '-' and the exact scope
 * (Workbox's names, 'workbox-precache-v2-https://example.com/3d/' and older ones), other than the
 * precache in use (`current`). Never another scope's, also when one of the two scopes holds the
 * other: Workbox's cleanupOutdatedCaches deletes every precache whose name merely contains the
 * scope, so an editor at the root would delete the precache of one at /3d/ on the same origin.
 */
export function outdatedPrecaches(names: readonly string[], scope: string, current: string): string[] {
  const suffix = `-${scope}`;
  return names.filter((name) => {
    if (name === current || !name.endsWith(suffix)) return false;
    const prefix = name.slice(0, -suffix.length);
    // the name's own part, before the scope: no URL in it (a scope that ends with this one)
    return `${prefix}-`.includes('-precache-') && !prefix.includes('://');
  });
}
