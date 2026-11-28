/*
 * Serving under a subpath (docs/subpath.md): the base path of the server and of a request, the
 * paths from it, and the pages' `<base href>`. Pure (no imports, no Node or DOM types): the server
 * (config.ts, app.ts, static.ts, the WebDAV proxy, the MCP links), the web app (app/base-url.ts)
 * and its service worker (pwa/sw.ts, pwa/sw-desk.ts) use it alike.
 *
 * A base path is '' (the root) or `/` followed by path segments of `A-Z a-z 0-9 . _ ~ -`, without a
 * trailing slash; no segment is `.` or `..`, and the first is none of the server's own top-level
 * paths (RESERVED_PREFIXES, BUILD_TOP_LEVEL), since a path under it could then be read two ways.
 */

/** Path prefixes that belong to the server API and never fall back to the editor's page. */
export const RESERVED_PREFIXES: readonly string[] = [
  '/api',
  '/sync',
  '/mcp',
  '/dav',
  '/otlp',
  '/metrics',
  '/healthz',
  '/readyz',
];

/** Whether a path (from the base) is the server's own: a RESERVED_PREFIXES entry or a path below one. */
export function isReservedPath(pathname: string): boolean {
  return RESERVED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Names at the top of the built web app (apps/web/dist) and the desk's clean URL: like the server's
 * own paths, never the first segment of a base path.
 */
export const BUILD_TOP_LEVEL: readonly string[] = [
  'assets',
  'icons',
  'desk',
  'index.html',
  'desk.html',
  'sw.js',
  'manifest.webmanifest',
  'favicon.svg',
];

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Why `raw` cannot be a base path, or null when it can. Trailing slashes are dropped first, so '/3d/'
 * is '/3d'; '' and '/' are the root.
 */
export function basePathProblem(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, '');
  if (value === '') return null;
  if (!value.startsWith('/')) return 'does not start with /';
  const segments = value.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '') return 'has an empty path segment (//)';
    if (segment === '.' || segment === '..') return `has a '${segment}' segment`;
    if (!SEGMENT.test(segment))
      return 'has characters other than letters, digits and . _ ~ - in its path segments';
  }
  const first = segments[0]!;
  const owner = `/${first}`;
  if (RESERVED_PREFIXES.includes(owner) || BUILD_TOP_LEVEL.includes(first))
    return `starts with ${owner}, one of the server's own paths`;
  return null;
}

/** The base path `raw` names ('' for the root), or null when it names none that can be used. */
export function normalizeBasePath(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  if (basePathProblem(raw) !== null) return null;
  return raw.trim().replace(/\/+$/, '');
}

/**
 * BASE_PATH as the server reads it when it starts: '' when unset or empty; a value it cannot use
 * throws `Invalid configuration: BASE_PATH: '<value>' <reason>`.
 */
export function parseBasePath(value: string | undefined): string {
  if (value === undefined) return '';
  const problem = basePathProblem(value);
  if (problem !== null)
    throw new Error(
      `Invalid configuration: BASE_PATH: '${value}' ${problem} (expected a path such as /3d: letters, digits and . _ ~ - in its segments)`,
    );
  return normalizeBasePath(value) ?? '';
}

/**
 * The base path an `X-Forwarded-Prefix` header names: its first comma-separated value when that
 * is a usable base path ('' for `/`), else null (absent, empty or unusable: never a base that could
 * steer links off the site).
 */
export function forwardedPrefix(header: string | readonly string[] | undefined): string | null {
  const raw = typeof header === 'string' ? header : header?.[0];
  if (raw === undefined) return null;
  const first = raw.split(',')[0]!.trim();
  if (first === '') return null;
  return normalizeBasePath(first);
}

/** A request URL (path and query) without its base path. */
export interface StrippedUrl {
  /** The URL from the base: '/…' (unchanged when no base matched). */
  url: string;
  /** The base path removed from it ('' when none matched). */
  base: string;
  /** The URL was the base itself without its slash (`/3d`, `/3d?x`): it belongs at `${base}/`. */
  bare: boolean;
}

/**
 * `url` (a request's path and query) without the first of `bases` it starts with: `/3d/api/x` is
 * `/api/x` for the base `/3d`, `/3d` alone is `/` and `bare`. Root bases ('') and URLs under none of
 * them are left as they are.
 */
export function stripBasePath(url: string, bases: readonly string[]): StrippedUrl {
  for (const base of bases) {
    if (!base) continue;
    if (url === base || url.startsWith(`${base}?`))
      return { url: `/${url.slice(base.length)}`, base, bare: true };
    if (url.startsWith(`${base}/`)) return { url: url.slice(base.length), base, bare: false };
  }
  return { url, base: '', bare: false };
}

/** The pages' `<base href>` for a base path: the base with its trailing slash ('/' at the root). */
export function baseHref(base: string): string {
  return `${base}/`;
}

const BASE_TAG = /<base\s[^>]*>/i;
const HEAD_TAG = /<head(\s[^>]*)?>/i;
const HTML_TAG = /<html(\s[^>]*)?>/i;
const DOCTYPE = /<!doctype[^>]*>/i;

/**
 * A page (index.html, desk.html) with the `<base href>` of `base`: its own `<base>` replaced, else
 * one added as the first element of its `<head>` (before anything that loads a URL). A page without
 * a `<head>` tag (it is optional) gets it after its `<html>` tag or its doctype, where the parser
 * opens the head, never before the doctype (which would put the page in quirks mode). `base` must
 * be a base path (basePathProblem): it then needs no escaping.
 */
export function withBaseHref(html: string, base: string): string {
  const tag = `<base href="${baseHref(base)}" />`;
  if (BASE_TAG.test(html)) return html.replace(BASE_TAG, tag);
  if (HEAD_TAG.test(html)) return html.replace(HEAD_TAG, (head) => `${head}\n    ${tag}`);
  for (const opening of [HTML_TAG, DOCTYPE]) {
    if (opening.test(html)) return html.replace(opening, (found) => `${found}${tag}`);
  }
  return `${tag}\n${html}`;
}

/**
 * The path of `pathname` from a scope or base URL's path (`scopePath` ends with '/', as
 * `ServiceWorkerRegistration.scope` and `document.baseURI`'s directory do): '/desk.html' for
 * '/3d/desk.html' in '/3d/', '/' for '/3d/' itself, null outside the scope.
 */
export function pathWithin(pathname: string, scopePath: string): string | null {
  const scope = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
  if (!pathname.startsWith(scope)) return null;
  return `/${pathname.slice(scope.length)}`;
}
