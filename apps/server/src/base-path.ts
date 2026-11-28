/*
 * Serving under a subpath (docs/subpath.md): the base path of the server and of a request, the
 * paths from it, and the pages' `<base href>`. Pure (no imports, no Node or DOM types): the server
 * (config.ts, app.ts, static.ts, the WebDAV proxy, the MCP links), the web app's Vite config
 * (vite.config.ts) and its service worker (pwa/sw-scope.ts) use it alike.
 *
 * A base path is '' (the root) or `/` followed by path segments of `A-Z a-z 0-9 . _ ~ -`, without a
 * trailing slash, at most MAX_BASE_PATH_LENGTH characters as given, and no segment is `.` or `..`
 * (prefixProblem). BASE_PATH's first segment is none of the server's own top-level paths either
 * (RESERVED_PREFIXES, BUILD_TOP_LEVEL; basePathProblem): the server removes BASE_PATH from request
 * paths, and a path under such a base could be read two ways. The base in X-Forwarded-Prefix may
 * start with one (an editor at the root behind a stripping proxy at /api/): the server never removes
 * the header's value from a path (request-base.ts), so no path is read two ways.
 *
 * X-Forwarded-Prefix comes with every request, upgrade and MCP call, so what reads it takes time
 * linear in its length and gives up at once on a value longer than a base path can be: no regular
 * expression that can backtrack (`/\/+$/` takes quadratic time on a run of slashes followed by
 * another character).
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
 * own paths (RESERVED_PREFIXES), never the first segment of BASE_PATH (basePathProblem).
 */
export const BUILD_TOP_LEVEL: readonly string[] = [
  'assets',
  'icons',
  'desk',
  'index.html',
  'desk.html',
  'sw.js',
  'sw.js.map',
  'manifest.webmanifest',
  'favicon.svg',
];

/**
 * The longest base path, in characters as given (BASE_PATH, an X-Forwarded-Prefix value; spaces and
 * trailing slashes count): a longer BASE_PATH is refused, a longer header value ignored, before
 * anything else reads it.
 */
export const MAX_BASE_PATH_LENGTH = 256;

const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const SLASH = 47;

/** `s` without its trailing slashes, in one pass from its end (time linear in its length). */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === SLASH) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** The first segment of a path (`api` for `/api/v2`, '' for the root). */
function firstSegment(path: string): string {
  const slash = path.indexOf('/', 1);
  return path.slice(1, slash === -1 ? path.length : slash);
}

/**
 * Whether a base path's first segment is one of the server's own top-level paths (RESERVED_PREFIXES,
 * BUILD_TOP_LEVEL): `/api`, `/api/v2`, `/desk`, `/sw.js`; never `/apix`, `/x/api` or the root. No
 * BASE_PATH is such a path; the base in X-Forwarded-Prefix may be one.
 */
export function startsWithOwnPath(base: string): boolean {
  if (!base.startsWith('/')) return false;
  const first = firstSegment(base);
  return RESERVED_PREFIXES.includes(`/${first}`) || BUILD_TOP_LEVEL.includes(first);
}

/**
 * Why `raw` cannot be the base in an X-Forwarded-Prefix header, or null when it can: the rules of
 * every base path (at most MAX_BASE_PATH_LENGTH characters as given, `/` and segments of
 * `A-Z a-z 0-9 . _ ~ -`, none empty, `.` or `..`), whatever its first segment. Trailing slashes are
 * dropped first, so '/3d/' is '/3d'; '' and '/' are the root.
 */
export function prefixProblem(raw: string): string | null {
  if (raw.length > MAX_BASE_PATH_LENGTH) return `is longer than ${MAX_BASE_PATH_LENGTH} characters`;
  const value = trimTrailingSlashes(raw.trim());
  if (value === '') return null;
  if (!value.startsWith('/')) return 'does not start with /';
  for (const segment of value.slice(1).split('/')) {
    if (segment === '') return 'has an empty path segment (//)';
    if (segment === '.' || segment === '..') return `has a '${segment}' segment`;
    if (!SEGMENT.test(segment))
      return 'has characters other than letters, digits and . _ ~ - in its path segments';
  }
  return null;
}

/**
 * Why `raw` cannot be a base path (BASE_PATH), or null when it can: prefixProblem's rules, and its
 * first segment is none of the server's own top-level paths (startsWithOwnPath). Trailing slashes
 * are dropped first, so '/3d/' is '/3d'; '' and '/' are the root.
 */
export function basePathProblem(raw: string): string | null {
  const problem = prefixProblem(raw);
  if (problem !== null) return problem;
  const value = trimTrailingSlashes(raw.trim());
  if (startsWithOwnPath(value)) return `starts with /${firstSegment(value)}, one of the server's own paths`;
  return null;
}

/** The base path `raw` names ('' for the root), or null when it names none that can be used. */
export function normalizeBasePath(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  if (basePathProblem(raw) !== null) return null;
  return trimTrailingSlashes(raw.trim());
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
 * is a usable base (prefixProblem: '' for `/`, and its first segment may be one of the server's own
 * paths), else null (absent, empty, longer than MAX_BASE_PATH_LENGTH or unusable: never a base that
 * could steer links off the site). The base the server writes into a request's pages and links,
 * never one it removes from the request's path (request-base.ts).
 */
export function forwardedPrefix(header: string | readonly string[] | undefined): string | null {
  const raw = typeof header === 'string' ? header : header?.[0];
  if (raw === undefined) return null;
  const comma = raw.indexOf(',');
  const first = comma === -1 ? raw : raw.slice(0, comma);
  // a value longer than any base path is ignored before it is read any further
  if (first.length > MAX_BASE_PATH_LENGTH) return null;
  const value = first.trim();
  if (value === '' || prefixProblem(value) !== null) return null;
  return trimTrailingSlashes(value);
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
 * be a base path or a header's (prefixProblem): it then needs no escaping.
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
