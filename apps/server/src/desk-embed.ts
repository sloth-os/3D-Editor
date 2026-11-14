/*
 * Headers of the embeddable director's desk (docs/embedding.md, "Hosting the desk"). desk.html may
 * be framed by the origins of DESK_EMBED_ORIGINS (CSP frame-ancestors, never X-Frame-Options) and
 * is served with the Cross-Origin-Embedder-Policy of DESK_EMBED_COEP and
 * Cross-Origin-Resource-Policy: cross-origin, so that hosts that are cross-origin isolated (COOP
 * same-origin + COEP require-corp) can frame it. The built files under assets/ carry the same COEP
 * and CORP: the desk's workers start from them, and a dedicated worker of a document with a COEP
 * needs a compatible one on its script. Pure (no imports): the server (static.ts) and the web
 * app's Vite dev and preview servers (apps/web/vite.config.ts) use it alike.
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

/** URL paths of the desk page: the built desk.html and its clean URL. */
export const DESK_PAGE_PATHS: readonly string[] = ['/desk.html', '/desk', '/desk/'];

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

// scheme://host[:port]: a host name (its first label may be the wildcard *), an IPv4 address or a
// bracketed IPv6 address; a port number or *. Nothing else (no path, no spaces, no ; or quotes): the
// value goes into a header, and a source list must not end the directive.
const ORIGIN_SOURCE =
  /^https?:\/\/(?:(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::(?:\d{1,5}|\*))?$/;

/**
 * DESK_EMBED_ORIGINS: comma-separated origins that may frame the desk, e.g.
 * `https://rideo.example.com, https://*.example.org` (unset or `*`: any site; `'self'`: the
 * desk's own origin; `'none'`: no site). Trailing slashes are dropped and host names lowercased.
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
    else {
      source = lower.replace(/\/+$/, '');
      if (!ORIGIN_SOURCE.test(source)) {
        throw new Error(
          `Invalid configuration: DESK_EMBED_ORIGINS: expected *, 'self', 'none' or http(s) origins such as https://app.example.com, got '${raw}'`,
        );
      }
      const port = /:(\d+)$/.exec(source);
      if (port && Number(port[1]) > 65535)
        throw new Error(`Invalid configuration: DESK_EMBED_ORIGINS: bad port in '${raw}'`);
    }
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
