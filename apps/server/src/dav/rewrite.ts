import { posix } from 'node:path';
import { stripBasePath } from '../base-path';
import { originForm } from '../request-base';

/*
 * URL mapping between the server's WebDAV proxy (`/dav/...`) and the upstream WebDAV server
 * (`WEBDAV_URL/...`). Only paths below the configured upstream URL are ever reachable: every
 * segment of a path the proxy sends upstream decodes to a name of its own (davSegment), so that no
 * upstream server that decodes `%2F` or `%5C` (`..%2f`) can read it as a way out, and the path,
 * decoded with its dot segments resolved, starts with the upstream base. Under a base path
 * (docs/subpath.md) the hrefs the proxy gives out start with it (`/3d/dav/...`), and the paths
 * clients send may carry it.
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

/**
 * The name a raw (percent-encoded) path segment stands for, or null when it is not one the proxy
 * passes on: it does not decode (`%zz`, a lone `%C3`), or its decoded form contains `/`, `\` or NUL
 * (`..%2f`, `x%5c..`), or is `.` or `..` (`%2e%2e`).
 */
export function davSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded === '.' || decoded === '..') return null;
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  return decoded;
}

/** A raw path (`/a/b%20c`) decoded segment by segment (davSegment), or null when a segment is refused. */
function decodeDavPath(raw: string): string | null {
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    const decoded = davSegment(seg);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out.join('/');
}

/**
 * Whether the path of an upstream URL as it is sent (`url.pathname`, encoded) is the upstream base or
 * under it: decoded segment by segment (decodeDavPath, so no segment hides a `/`) and with its dot
 * segments resolved.
 */
function isInsideUpstream(upstream: DavUpstream, pathname: string): boolean {
  const decoded = decodeDavPath(pathname);
  if (decoded === null) return false;
  if (!upstream.decodedBase) return true;
  const resolved = posix.normalize(decoded);
  const base = posix.normalize(upstream.decodedBase);
  return resolved === base || resolved.startsWith(`${base}/`);
}

/** Splits `/dav/a/b?x=1` into the part after the prefix ('/a/b') and the query ('?x=1'). */
function splitLocal(rawPath: string): { rest: string; query: string } | null {
  const q = rawPath.search(/[?#]/);
  const pathname = q >= 0 ? rawPath.slice(0, q) : rawPath;
  const query = q >= 0 && rawPath[q] === '?' ? rawPath.slice(q).replace(/#.*$/, '') : '';
  if (pathname !== DAV_PREFIX && !pathname.startsWith(`${DAV_PREFIX}/`)) return null;
  return { rest: pathname.slice(DAV_PREFIX.length), query };
}

/**
 * Upstream URL for a proxied request URL (`/dav/...`, as routed), or null if it is not acceptable:
 * a segment after `/dav` is refused (davSegment), or the URL sent upstream would not be inside the
 * upstream base (isInsideUpstream, checked on the URL as built, whatever the URL parser made of it).
 * The path is passed on as the client spelled it, its repeated slashes collapsed.
 */
export function upstreamUrlFor(upstream: DavUpstream, rawUrl: string): URL | null {
  const parts = splitLocal(rawUrl);
  if (!parts) return null;
  const rest = parts.rest.replace(/\/{2,}/g, '/');
  if (decodeDavPath(rest) === null) return null;
  let url: URL;
  try {
    url = new URL(`${upstream.origin}${upstream.basePath}${rest || '/'}${parts.query}`);
  } catch {
    return null;
  }
  return isInsideUpstream(upstream, url.pathname) ? url : null;
}

/**
 * Maps an upstream href (absolute URL or absolute path) to the corresponding `/dav` path, under
 * `base` (the request's base path, '' at the root: `/3d/dav/...`). Returns null for references
 * outside of the upstream base (left untouched by callers).
 */
export function toLocalHref(upstream: DavUpstream, href: string, base = ''): string | null {
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
  return `${base}${DAV_PREFIX}${encodePathSegments(rest)}`;
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

/**
 * Rewrites every `<href>` of a WebDAV multistatus document from upstream URLs to `/dav` paths
 * under `base` (toLocalHref).
 */
export function rewriteMultistatus(xml: string, upstream: DavUpstream, base = ''): string {
  return xml.replace(HREF_RE, (whole, open: string, inner: string, close: string) => {
    const local = toLocalHref(upstream, decodeXml(inner), base);
    return local === null ? whole : `${open}${encodeXml(local)}${close}`;
  });
}

/**
 * Rewrites a `Destination` request header (absolute URL or path pointing into `/dav`, with or
 * without one of `bases`, the request's base paths) to the corresponding upstream URL. Its path is
 * read as a request target is (originForm: `/%33d/dav/x` is `/3d/dav/x`) and goes through the same
 * checks as request paths (upstreamUrlFor: a segment that does not decode, or that decodes to a
 * `/`, is refused). Returns null if it points anywhere else or is refused.
 */
export function rewriteDestination(
  upstream: DavUpstream,
  destination: string,
  bases: readonly string[] = [],
): string | null {
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
  return upstreamUrlFor(upstream, stripBasePath(originForm(raw), bases).url)?.toString() ?? null;
}
