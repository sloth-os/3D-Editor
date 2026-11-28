import { RESERVED_PREFIXES, pathWithin } from '../../../server/src/base-path';

/*
 * The service worker's routes relative to its registration's scope (docs/subpath.md, "The web
 * app"). The scope is the app's base: the editor registers ./sw.js with the scope ./ and the desk
 * the base's sw.js with the base as its scope, so it is 'https://example.com/3d/' for the editor
 * behind a proxy at /3d/ and the root of the origin otherwise. Its routes (the desk page, the
 * editor's page for navigations, the server's own paths it leaves to the network) are paths from
 * that scope, as the server's are from its base. Pure, for sw.ts, sw-desk.ts and their tests.
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

/**
 * Server paths whose routes are all below them ('/api/…'): a navigation to the bare prefix
 * ('/api') is the editor's page, as it was at the root. The other RESERVED_PREFIXES are endpoints
 * of their own ('/mcp', '/metrics', '/healthz', '/readyz'): any path that starts with one of them is
 * the server's.
 */
const ROUTES_BELOW = new Set(['/api', '/sync', '/dav', '/otlp']);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The NavigationRoute's denylist under `scope`: navigations to the server's own paths
 * (RESERVED_PREFIXES) under the scope's path are never answered with the editor's page, they go to
 * the network. Tested on a URL's path and query, as Workbox does: at the root these are
 * /^\/api\//, /^\/sync\//, /^\/mcp/, /^\/dav\//, /^\/otlp\//, /^\/metrics/, /^\/healthz/ and
 * /^\/readyz/; under https://example.com/3d/ they start with \/3d\/ instead.
 */
export function navigationDenylist(scope: string): RegExp[] {
  const base = escapeRegExp(new URL(scope).pathname.replace(/\/*$/, '/'));
  return RESERVED_PREFIXES.map(
    (prefix) =>
      new RegExp(`^${base}${escapeRegExp(prefix.slice(1))}${ROUTES_BELOW.has(prefix) ? '\\/' : ''}`),
  );
}
