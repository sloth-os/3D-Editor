/*
 * URL mapping between the server's WebDAV proxy (`/dav/...`) and the upstream WebDAV server
 * (`WEBDAV_URL/...`). Only paths below the configured upstream URL are ever reachable.
 */

export const DAV_PREFIX = '/dav';

export interface DavUpstream {
  /** e.g. `https://cloud.example.com` */
  origin: string;
  /** Percent-encoded path of WEBDAV_URL without trailing slash ('' for the root). */
  basePath: string;
  /** Decoded form of basePath (used for comparisons). */
  decodedBase: string;
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseUpstream(url: string): DavUpstream {
  const u = new URL(url);
  const basePath = u.pathname.replace(/\/+$/, '');
  return { origin: u.origin, basePath, decodedBase: safeDecode(basePath) };
}

function encodePathSegments(decoded: string): string {
  return decoded
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Validates the raw (encoded) remainder of a proxied path: no dot segments, no NUL bytes. */
function isSafeRawPath(rest: string): boolean {
  for (const seg of rest.split('/')) {
    const d = safeDecode(seg);
    if (d === '.' || d === '..' || d.includes('\0') || d.includes('\\')) return false;
  }
  return true;
}

/** Splits `/dav/a/b?x=1` into the part after the prefix ('/a/b') and the query ('?x=1'). */
function splitLocal(rawPath: string): { rest: string; query: string } | null {
  const q = rawPath.search(/[?#]/);
  const pathname = q >= 0 ? rawPath.slice(0, q) : rawPath;
  const query = q >= 0 && rawPath[q] === '?' ? rawPath.slice(q).replace(/#.*$/, '') : '';
  if (pathname !== DAV_PREFIX && !pathname.startsWith(`${DAV_PREFIX}/`)) return null;
  return { rest: pathname.slice(DAV_PREFIX.length), query };
}

/** Upstream URL for a proxied request URL (`/dav/...`), or null if it is not acceptable. */
export function upstreamUrlFor(upstream: DavUpstream, rawUrl: string): URL | null {
  const parts = splitLocal(rawUrl);
  if (!parts || !isSafeRawPath(parts.rest)) return null;
  const rest = parts.rest.replace(/\/{2,}/g, '/');
  const url = new URL(`${upstream.origin}${upstream.basePath}${rest || '/'}${parts.query}`);
  // Defense in depth: the resolved path must stay inside the upstream base.
  const decoded = safeDecode(url.pathname);
  if (
    upstream.decodedBase &&
    decoded !== upstream.decodedBase &&
    !decoded.startsWith(`${upstream.decodedBase}/`)
  )
    return null;
  return url;
}

/**
 * Maps an upstream href (absolute URL or absolute path) to the corresponding `/dav` path.
 * Returns null for references outside of the upstream base (left untouched by callers).
 */
export function toLocalHref(upstream: DavUpstream, href: string): string | null {
  const value = href.trim();
  let pathname: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      return null;
    }
    if (u.origin.toLowerCase() !== upstream.origin.toLowerCase()) return null;
    pathname = u.pathname;
  } else if (value.startsWith('/')) {
    pathname = value.replace(/[?#].*$/, '');
  } else return null;
  const decoded = safeDecode(pathname);
  let rest: string;
  if (!upstream.decodedBase) rest = decoded;
  else if (decoded === upstream.decodedBase || decoded.startsWith(`${upstream.decodedBase}/`))
    rest = decoded.slice(upstream.decodedBase.length);
  else return null;
  if (!rest) rest = pathname.endsWith('/') ? '/' : '';
  return `${DAV_PREFIX}${encodePathSegments(rest)}`;
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m) => {
    if (XML_ENTITIES[m]) return XML_ENTITIES[m];
    if (/^&#x/i.test(m)) return String.fromCodePoint(parseInt(m.slice(3, -1), 16));
    if (/^&#/.test(m)) return String.fromCodePoint(parseInt(m.slice(2, -1), 10));
    return m;
  });
}

function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HREF_RE = /(<(?:[\w.-]+:)?href\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?href\s*>)/gi;

/** Rewrites every `<href>` of a WebDAV multistatus document from upstream URLs to `/dav` paths. */
export function rewriteMultistatus(xml: string, upstream: DavUpstream): string {
  return xml.replace(HREF_RE, (whole, open: string, inner: string, close: string) => {
    const local = toLocalHref(upstream, decodeXml(inner));
    return local === null ? whole : `${open}${encodeXml(local)}${close}`;
  });
}

/**
 * Rewrites a `Destination` request header (absolute URL or path pointing into `/dav`) to the
 * corresponding upstream URL. Returns null if it points anywhere else.
 */
export function rewriteDestination(upstream: DavUpstream, destination: string): string | null {
  let raw = destination.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      raw = u.pathname + u.search;
    } catch {
      return null;
    }
  }
  if (!raw.startsWith('/')) return null;
  return upstreamUrlFor(upstream, raw)?.toString() ?? null;
}
