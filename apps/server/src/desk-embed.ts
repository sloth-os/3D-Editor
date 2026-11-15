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
 * One origin of DESK_EMBED_ORIGINS as a frame-ancestors source: `scheme://host[:port]` as the
 * browser writes the origin (URL-parsed: lowercased, international names in punycode, a default
 * port dropped), or with CSP's wildcards, `*.` before the host and `*` as the port. Whatever no
 * framing page's origin can match is refused with the reason, so that a typo stops the server at
 * startup rather than leaving a source that frames nothing: a value that is no URL, a scheme other
 * than http(s), a path, query, fragment or user name, and IPv6 addresses, which CSP's host-source
 * cannot express (browsers drop such a source).
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
  let url: URL;
  try {
    url = new URL(`${scheme}://${rest}`);
  } catch {
    throw refused('is not an origin: expected scheme://host[:port] with a valid host and a port up to 65535');
  }
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
 * What the web app's Vite dev (`dev`) and preview servers do with a request path, as the server
 * does with its files: the page headers on the desk page (/desk served as /desk.html), the asset
 * headers on the built files under /assets/ (in dev also on the modules and workers it serves in
 * their place), the editor's index.html at /desk/ and /desk.html/ as at any path that is no desk
 * page, and no desk headers on anything else: never on the editor's pages, the service worker or
 * the manifest.
 */
export function viteDeskRoute(
  pathname: string,
  dev: boolean,
  settings: DeskEmbedSettings,
): { headers: Record<string, string>; rewrite?: string } {
  if (isDeskPagePath(pathname))
    return {
      headers: deskPageHeaders(settings),
      rewrite: pathname === '/desk.html' ? undefined : '/desk.html',
    };
  if (isDeskPagePath(pathname.replace(/\/+$/, ''))) return { headers: {}, rewrite: '/index.html' };
  const module = dev && VITE_DEV_MODULE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (module || pathname.startsWith('/assets/')) return { headers: deskAssetHeaders(settings) };
  return { headers: {} };
}
