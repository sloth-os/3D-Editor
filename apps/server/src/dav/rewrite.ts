import { posix } from 'node:path';
import { TOKEN_NAME_MAX, isTokenName } from '../auth';
import { stripBasePath } from '../base-path';
import { originForm } from '../request-base';

/*
 * URL mapping between the server's WebDAV proxy (`/dav/...`) and the upstream WebDAV server
 * (`WEBDAV_URL/...`). Only paths below the configured upstream URL are ever reachable: every
 * segment of a path the proxy sends upstream decodes to a name of its own (davSegment), so that no
 * upstream server that decodes `%2F` or `%5C` (`..%2f`), cuts `;` path parameters off (`..;`) or
 * whose URL parser drops a tab (`.\t.`) can read it as a way out, and the path, as the URL parser
 * built it, decoded with its dot segments resolved, starts with the upstream base
 * (isInsideUpstream). The query goes upstream without the editor's token (withoutTokenPairs).
 * Under a base path (docs/subpath.md) the hrefs the proxy gives out start with it (`/3d/dav/...`),
 * and the paths clients send may carry it.
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

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const SEMICOLON = 0x3b;
/** U+0000-U+001F are the ASCII control characters, and DEL (U+007F) one more. */
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;
const QUESTION = 0x3f;
const AMPERSAND = 0x26;
const EQUALS = 0x3d;

/**
 * The name a raw (percent-encoded) path segment stands for, or null when it is not one the proxy
 * passes on:
 * - it does not decode (`%zz`, a lone `%C3`);
 * - its decoded form, which keeps every character of the raw one that is no `%XX`, contains `/` or
 *   `\` (`..%2f`, `x%5c..`), or an ASCII control character (U+0000-U+001F) or DEL: `.%09.`, or a
 *   raw tab, which a Destination header may carry (Node lets no other control character into a
 *   header value) and the URL parser drops, so that `.\t.` would be sent as `..`;
 * - it is `.` or `..` up to its first `;` (`%2e%2e`, `..;`, `..;x`, `..%3b`, `.;`): servlet
 *   containers such as Tomcat cut `;` path parameters off a segment before they resolve dot
 *   segments, so that `/guarded/..;/x` is `/x` there.
 * A name that merely holds a `;` (`a;b.txt`) is passed on.
 */
export function davSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // the name as a servlet container resolves it: up to the first ';'
  let name = decoded.length;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if (c < FIRST_PRINTABLE || c === DEL || c === SLASH || c === BACKSLASH) return null;
    if (c === SEMICOLON && name === decoded.length) name = i;
  }
  const resolved = name === decoded.length ? decoded : decoded.slice(0, name);
  return resolved === '.' || resolved === '..' ? null : decoded;
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
 * under it: decoded segment by segment (decodeDavPath, so no segment hides a `/`, a control character
 * or a dot segment before a `;`) and with its dot segments resolved. upstreamUrlFor checks the URL it
 * built with it, whatever the URL parser made of the path: the parser trims spaces at the end of what
 * it reads, so that a Destination `/dav/.. #x` (its fragment cut off first) is built as
 * `/guarded/..`, that is `/`, and only this check refuses it.
 */
export function isInsideUpstream(upstream: DavUpstream, pathname: string): boolean {
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
 * A query from its `?` (`?a=1&token=s&b`, a URL's `search`) without the pairs whose name decodes to
 * `token` (isTokenName): a client may send the editor its token in the query, in any spelling
 * extractToken accepts (`?token=`, `?%74oken=`, `?to%6Ben=`), and the token is the editor's
 * credential, never the WebDAV server's. A pair starts after any `?` or `&` and runs to the next `&`,
 * as redactUrl reads them, and its name ends at its first `=`. The other pairs stay as they are, in
 * their order; a query left without pairs is left out, `?` and all. Time linear in the query's
 * length: after each `?` or `&`, at most TOKEN_NAME_MAX + 1 characters of name are read.
 */
export function withoutTokenPairs(query: string): string {
  let out = '';
  let from = 0;
  let dropped = false;
  for (let i = 0; i < query.length; i++) {
    const c = query.charCodeAt(i);
    if (c !== QUESTION && c !== AMPERSAND) continue;
    // the pair's name, within the longest spelling that can decode to `token`
    const limit = Math.min(query.length, i + 2 + TOKEN_NAME_MAX);
    let nameEnd = i + 1;
    while (nameEnd < limit) {
      const d = query.charCodeAt(nameEnd);
      if (d === EQUALS || d === AMPERSAND) break;
      nameEnd++;
    }
    if (!isTokenName(query.slice(i + 1, nameEnd))) continue;
    // a `?` in its value is part of it, as in redactUrl
    let pairEnd = query.indexOf('&', nameEnd);
    if (pairEnd === -1) pairEnd = query.length;
    out += query.slice(from, i);
    from = pairEnd;
    dropped = true;
    i = pairEnd - 1;
  }
  if (!dropped) return query;
  out += query.slice(from);
  let pairs = false;
  for (let i = 0; i < out.length && !pairs; i++) {
    const c = out.charCodeAt(i);
    pairs = c !== QUESTION && c !== AMPERSAND;
  }
  if (!pairs) return '';
  // the first pair kept follows the `?`
  return out.charCodeAt(0) === AMPERSAND ? `?${out.slice(1)}` : out;
}

/**
 * Upstream URL for a proxied request URL (`/dav/...`, as routed), or null if it is not acceptable:
 * a segment after `/dav` is refused (davSegment), or the URL sent upstream would not be inside the
 * upstream base (isInsideUpstream, checked on the URL as built, whatever the URL parser made of it).
 * The path is passed on as the client spelled it, its repeated slashes collapsed, and the query
 * without its `token` pairs (withoutTokenPairs, on the query as the URL parser built it).
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
  if (!isInsideUpstream(upstream, url.pathname)) return null;
  const search = withoutTokenPairs(url.search);
  if (search !== url.search) url.search = search;
  return url;
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
 * `/`, a control character or a dot segment, is refused), and its query loses its `token` pairs.
 * Returns null if it points anywhere else or is refused.
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
