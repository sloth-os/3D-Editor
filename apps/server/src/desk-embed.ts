/*
 * Headers of the embeddable director's desk (docs/embedding.md, "Hosting the desk"). desk.html may
 * be framed by the origins of DESK_EMBED_ORIGINS (CSP frame-ancestors, never X-Frame-Options) and
 * is served with the Cross-Origin-Embedder-Policy of DESK_EMBED_COEP and
 * Cross-Origin-Resource-Policy: cross-origin, so that hosts that are cross-origin isolated (COOP
 * same-origin + COEP require-corp) can frame it. The built files under assets/ carry the same COEP
 * and CORP: the desk's workers start from them, and a dedicated worker of a document with a COEP
 * needs a compatible one on its script. Pure (no imports): the server (static.ts), the web app's
 * Vite dev and preview servers (apps/web/vite.config.ts) and its service worker
 * (apps/web/src/pwa/sw.ts) use it alike, so that they agree on the desk's paths.
 */

export const DESK_EMBED_COEP_VALUES = ['require-corp', 'credentialless', 'off'] as const;
export type DeskEmbedCoep = (typeof DESK_EMBED_COEP_VALUES)[number];

export interface DeskEmbedSettings {
  /** Cross-Origin-Embedder-Policy of the desk page and the built assets ('off': none sent). */
  coep: DeskEmbedCoep;
  /** The CSP frame-ancestors sources: who may frame the desk (['*']: any site). */
  frameAncestors: string[];
}

export const DEFAULT_DESK_EMBED: DeskEmbedSettings = { coep: 'require-corp', frameAncestors: ['*'] };

/**
 * URL paths of the desk page: the built desk.html and its clean URL, nothing else (`/desk/` and
 * `/desk.html/` are the editor's, as any other path).
 */
export const DESK_PAGE_PATHS: readonly string[] = ['/desk.html', '/desk'];

export function isDeskPagePath(pathname: string): boolean {
  return DESK_PAGE_PATHS.includes(pathname);
}

/** DESK_EMBED_COEP (unset: require-corp). */
export function parseDeskEmbedCoep(value: string | undefined): DeskEmbedCoep {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return DEFAULT_DESK_EMBED.coep;
  if ((DESK_EMBED_COEP_VALUES as readonly string[]).includes(v)) return v as DeskEmbedCoep;
  throw new Error(
    `Invalid configuration: DESK_EMBED_COEP: expected one of ${DESK_EMBED_COEP_VALUES.join(', ')}, got '${value}'`,
  );
}

// A host as a CSP host-source can name it (letters, digits and hyphens in dot-separated labels, an
// optional final dot; an IPv4 address is such a name): it goes into the header, so nothing that could
// end the directive or the header (no spaces, ; or quotes) gets through.
const CSP_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/;

/**
 * Ports browsers refuse to load anything from, so no framing page's origin has one: the Fetch
 * standard's bad ports (its "port blocking", which browsers apply to navigations as to every other
 * request) but 4190 and 6679, which are on that list and which Chromium still loads (checked in
 * Chromium 153), and port 0, on which no server listens (Chromium refuses it too).
 */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/**
 * One origin of DESK_EMBED_ORIGINS as a frame-ancestors source: `scheme://host[:port]` as the
 * browser writes the origin (URL-parsed: lowercased, international names in punycode, a default
 * port dropped), or with CSP's wildcards, `*.` before the host and `*` as the port. Whatever no
 * framing page's origin can match is refused with the reason, so that a typo stops the server at
 * startup rather than leaving a source that frames nothing: a value that is no URL, a scheme other
 * than http(s), a port outside 1 to 65535 or one browsers refuse (BAD_PORTS), a path, query,
 * fragment or user name, and IPv6 addresses, which CSP's host-source cannot express (browsers drop
 * such a source).
 */
function originSource(raw: string): string {
  const refused = (why: string) => new Error(`Invalid configuration: DESK_EMBED_ORIGINS: '${raw}' ${why}`);
  if (/\s/.test(raw) || [...raw].some((c) => c < ' ' || c === '\x7f'))
    throw refused('has spaces or control characters in it');
  const value = raw.toLowerCase().replace(/\/+$/, '');
  const scheme = /^(https?):\/\//.exec(value)?.[1];
  if (!scheme)
    throw refused(
      "is not an origin: expected *, 'self', 'none' or http(s) origins such as https://app.example.com",
    );
  let rest = value.slice(`${scheme}://`.length);
  if (rest.startsWith('['))
    throw refused(
      'has a bracketed (IPv6) address, which browsers ignore in frame-ancestors: use a host name for it',
    );
  const anySubdomain = rest.startsWith('*.');
  if (anySubdomain) rest = rest.slice(2);
  const anyPort = rest.endsWith(':*');
  if (anyPort) rest = rest.slice(0, -2);
  const notAnOrigin = () =>
    refused(
      "is not an origin: expected scheme://host[:port] with a valid host and a port from 1 to 65535 other than the ports browsers refuse (Fetch's bad ports, such as 1, 25 or 6000)",
    );
  let url: URL;
  try {
    url = new URL(`${scheme}://${rest}`);
  } catch {
    throw notAnOrigin();
  }
  // no page has a port browsers refuse, or port 0 (a default port is '' here)
  if (url.port && BAD_PORTS.has(Number(url.port))) throw notAnOrigin();
  if (url.username || url.password)
    throw refused('has a user name or password: an origin is scheme://host[:port]');
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(rest))
    throw refused('has a path, query or fragment: an origin is scheme://host[:port]');
  if (anyPort && url.port) throw refused('has two ports');
  if (!CSP_HOST.test(url.hostname))
    throw refused('is not an origin: its host is not a host name or an IPv4 address');
  if (anySubdomain && /^[\d.]+$/.test(url.hostname)) throw refused('puts *. before an IP address');
  const port = anyPort ? ':*' : url.port ? `:${url.port}` : '';
  return `${scheme}://${anySubdomain ? '*.' : ''}${url.hostname}${port}`;
}

/**
 * DESK_EMBED_ORIGINS: comma-separated origins that may frame the desk, e.g.
 * `https://rideo.example.com, https://*.example.org` (unset or `*`: any site; `'self'`: the
 * desk's own origin; `'none'`: no site). Trailing slashes are dropped, host names lowercased and a
 * default port dropped; a value that cannot be an origin throws (originSource).
 */
export function parseDeskEmbedOrigins(value: string | undefined): string[] {
  const items = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return [...DEFAULT_DESK_EMBED.frameAncestors];
  const out: string[] = [];
  for (const raw of items) {
    const lower = raw.toLowerCase();
    let source: string;
    if (lower === '*') source = '*';
    else if (lower === "'self'" || lower === 'self') source = "'self'";
    else if (lower === "'none'" || lower === 'none') source = "'none'";
    else source = originSource(raw);
    if (!out.includes(source)) out.push(source);
  }
  if (out.includes("'none'") && out.length > 1)
    throw new Error("Invalid configuration: DESK_EMBED_ORIGINS: 'none' cannot be combined with origins");
  // * already allows every site
  return out.includes('*') ? ['*'] : out;
}

/** The settings of DESK_EMBED_COEP and DESK_EMBED_ORIGINS (throws on invalid values). */
export function deskEmbedSettings(env: Record<string, string | undefined>): DeskEmbedSettings {
  return {
    coep: parseDeskEmbedCoep(env.DESK_EMBED_COEP),
    frameAncestors: parseDeskEmbedOrigins(env.DESK_EMBED_ORIGINS),
  };
}

/** Headers of the built files under assets/: COEP and CORP. */
export function deskAssetHeaders(settings: DeskEmbedSettings): Record<string, string> {
  const headers: Record<string, string> = { 'cross-origin-resource-policy': 'cross-origin' };
  if (settings.coep !== 'off') headers['cross-origin-embedder-policy'] = settings.coep;
  return headers;
}

/** Headers of the desk page: COEP, CORP and who may frame it. */
export function deskPageHeaders(settings: DeskEmbedSettings): Record<string, string> {
  return {
    ...deskAssetHeaders(settings),
    'content-security-policy': `frame-ancestors ${settings.frameAncestors.join(' ')}`,
  };
}

/**
 * The desk's headers for a served file, by its path relative to the public root (posix
 * separators): the page headers for desk.html, the asset headers under assets/, none otherwise.
 */
export function deskHeadersFor(relativePath: string, settings: DeskEmbedSettings): Record<string, string> {
  const rel = relativePath.replace(/^\/+/, '');
  if (rel === 'desk.html') return deskPageHeaders(settings);
  if (rel.startsWith('assets/')) return deskAssetHeaders(settings);
  return {};
}

/**
 * URL path prefixes of what the Vite dev server serves in place of the built assets/: the source
 * modules, Vite's own client and pre-bundled dependencies, and the workers started from them.
 */
export const VITE_DEV_MODULE_PREFIXES: readonly string[] = [
  '/src/',
  '/@vite/',
  '/@fs/',
  '/@id/',
  '/node_modules/',
  '/@react-refresh',
  '/@prefresh/',
];

/**
 * URL path prefixes the web app's Vite dev and preview servers proxy to the editor server
 * (vite.config.ts server.proxy, which the preview server uses too). Vite's proxy takes every path
 * that starts with one, so none of them is a page or a file of the app there.
 */
export const VITE_SERVER_ROUTES: readonly string[] = ['/api', '/dav', '/otlp', '/mcp', '/sync'];

/**
 * Whether a request path is canonical as the editor server reads it: its static file server
 * (fastify-static) decodes the path with decodeURI (`%2e` is a dot and `%5C` a backslash; `%2F`
 * stays as it is) and answers a GET or HEAD of any other path with 403. A canonical path starts
 * with `/` and has no backslash, no `.` or `..` segment (`/./x`, `/x/../y`, `/x/.`) and no empty
 * segment but a last one (`//x`, `/x//y` and `/x//` are not canonical, `/x/` is). A path that does
 * not decode is read as it is. Time linear in the path's length.
 */
export function isCanonicalPath(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURI(pathname);
  } catch {
    // a malformed escape: the path is read as it is
  }
  if (!path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  return segments.every(
    (segment, i) =>
      segment !== '.' && segment !== '..' && (segment !== '' || i === 0 || i === segments.length - 1),
  );
}

/** What viteDeskRoute needs to know of a request besides its path. */
export interface ViteRequest {
  /** A GET or a HEAD: only those are Vite's to answer outside the proxied routes. */
  read: boolean;
  /** Its Accept names text/html: a page the browser opens (a navigation), not a file a page loads. */
  html: boolean;
  /**
   * Vite may answer the path itself (a GET or HEAD only): in preview, the path names a file of the
   * build (a file in outDir); in dev, Vite reads it as the path it is (decoded, `%2F` too, it has no
   * empty or dot segment) and it is neither an HTML file other than the app's two pages nor a path
   * in the build's folder (vite.config.ts).
   */
  servable: boolean;
}

/** What the Vite dev or preview server does with a request (viteDeskRoute). */
export interface ViteRoute {
  /** The desk's headers on the answer. */
  headers: Record<string, string>;
  /** The path Vite serves in place of the request's: /desk as /desk.html. */
  rewrite?: string;
  /**
   * The answer is the editor's page with `<base href="/">`, as the server writes it at the root: in
   * dev index.html as Vite makes it, in preview the built one.
   */
  page?: 'index.html';
  /** The answer is 403: a path that is not canonical (isCanonicalPath), as the server answers it. */
  forbidden?: true;
  /** The answer is 404: a file Vite may not serve, never a page, or a method that no route takes. */
  notFound?: true;
}

/**
 * What the web app's Vite dev (`dev`) and preview servers (vite.config.ts) do with a request, as the
 * editor server does with its files and its fallback, `pathname` read as the server reads it (in
 * origin form: request-target.ts originForm). In this order:
 * - a path that is not canonical (isCanonicalPath: an empty or dot segment, a backslash) gets 403
 *   for a GET or HEAD and 404 for any other method, as from the server, whatever it starts with:
 *   Vite would read it as another path (`//desk.html` as the desk page, without its headers);
 * - the editor server's routes (VITE_SERVER_ROUTES): left to the proxy;
 * - any other method than GET and HEAD: 404, as on the server, where no other route takes one
 *   (Vite would answer a POST with a page too);
 * - the desk page at /desk.html and /desk (served as /desk.html), with the page headers;
 * - the built files under /assets/ (in dev also the modules and workers it serves in their place):
 *   the asset headers, and 404 for one Vite may not serve (`request.servable`);
 * - the editor's page for /desk/ and /desk.html/, and for any other path Vite may not serve (in
 *   preview, one that names no built file) when its Accept names text/html (a page the browser
 *   opens), as the server's fallback answers them. A GET or HEAD there that accepts no HTML (a
 *   script, a style, an image, a fetch) asks for a file Vite may not serve: 404, never a page. The
 *   page carries `<base href="/">`, as the server writes it at the root, so that its base is the
 *   root, where it reaches its server (the proxied routes) and, in preview, loads its relative file
 *   URLs, and not the path it was opened at. The root itself and the paths Vite may serve are
 *   Vite's: in dev its own page at a deeper path, which has no `<base href>`;
 * - no desk headers on anything else: never on the editor's pages, the service worker or the
 *   manifest.
 */
export function viteDeskRoute(
  pathname: string,
  dev: boolean,
  settings: DeskEmbedSettings,
  request: ViteRequest,
): ViteRoute {
  if (!isCanonicalPath(pathname))
    return request.read ? { headers: {}, forbidden: true } : { headers: {}, notFound: true };
  if (VITE_SERVER_ROUTES.some((route) => pathname.startsWith(route))) return { headers: {} };
  if (!request.read) return { headers: {}, notFound: true };
  if (isDeskPagePath(pathname))
    return {
      headers: deskPageHeaders(settings),
      rewrite: pathname === '/desk.html' ? undefined : '/desk.html',
    };
  const module = dev && VITE_DEV_MODULE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (module || pathname.startsWith('/assets/')) {
    const headers = deskAssetHeaders(settings);
    return request.servable ? { headers } : { headers, notFound: true };
  }
  if (pathname.endsWith('/') && isDeskPagePath(pathname.slice(0, -1)))
    return { headers: {}, page: 'index.html' };
  if (request.servable || pathname === '/') return { headers: {} };
  return request.html ? { headers: {}, page: 'index.html' } : { headers: {}, notFound: true };
}
