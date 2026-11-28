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

/** `pathname` without its trailing slashes, in one pass from its end. */
function withoutTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 0 && pathname[end - 1] === '/') end--;
  return pathname.slice(0, end);
}

/** What viteDeskRoute needs to know of a request besides its path. */
export interface ViteRequest {
  /** A GET or a HEAD: only those are answered with the editor's page or a 404 here. */
  read: boolean;
  /** Its Accept names text/html: a page the browser opens (a navigation), not a file a page loads. */
  html: boolean;
  /** In preview, the path names a file of the build (a file in outDir); always false in dev. */
  builtFile: boolean;
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
  /** The answer is 404: a file the build does not have, never a page. */
  notFound?: true;
}

/**
 * What the web app's Vite dev (`dev`) and preview servers (vite.config.ts) do with a request, as the
 * editor server does with its files and its fallback:
 * - the desk page at /desk.html and /desk (served as /desk.html), with the page headers;
 * - the editor server's routes (VITE_SERVER_ROUTES): left to the proxy;
 * - the built files under /assets/ (in dev also the modules and workers it serves in their place):
 *   the asset headers, and in preview a 404 for a GET or HEAD of one the build does not have;
 * - the editor's page for a GET or HEAD of /desk/ or /desk.html/, and in preview of any other path
 *   that names no built file when its Accept names text/html (a page the browser opens), as the
 *   server's fallback answers them. A GET or HEAD there that accepts no HTML (a script, a style, an
 *   image, a fetch) asks for a file the build does not have: 404, never a page. The page carries
 *   `<base href="/">`, as the server writes it at the root, so that its base is the root, where it
 *   reaches its server (the proxied routes) and, in preview, loads its relative file URLs, and not
 *   the path it was opened at. The root itself and the built files are Vite's to serve, as is, in
 *   dev, every other path: Vite's own page there has no `<base href>`;
 * - no desk headers on anything else: never on the editor's pages, the service worker or the
 *   manifest.
 */
export function viteDeskRoute(
  pathname: string,
  dev: boolean,
  settings: DeskEmbedSettings,
  request: ViteRequest,
): ViteRoute {
  if (isDeskPagePath(pathname))
    return {
      headers: deskPageHeaders(settings),
      rewrite: pathname === '/desk.html' ? undefined : '/desk.html',
    };
  if (VITE_SERVER_ROUTES.some((route) => pathname.startsWith(route))) return { headers: {} };
  const module = dev && VITE_DEV_MODULE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (module || pathname.startsWith('/assets/')) {
    const headers = deskAssetHeaders(settings);
    return !dev && request.read && !request.builtFile ? { headers, notFound: true } : { headers };
  }
  if (!request.read) return { headers: {} };
  if (isDeskPagePath(withoutTrailingSlashes(pathname))) return { headers: {}, page: 'index.html' };
  if (dev || request.builtFile || pathname === '/') return { headers: {} };
  return request.html ? { headers: {}, page: 'index.html' } : { headers: {}, notFound: true };
}
