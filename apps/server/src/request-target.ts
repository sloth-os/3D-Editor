/*
 * A request target as the router reads it (docs/subpath.md, "Both proxy styles"): request-base.ts
 * reads every request's target with it before anything routes the request, the WebDAV proxy the
 * path of a Destination and of each resource tag of an If header (dav/rewrite.ts and
 * dav/if-header.ts, through request-base.ts), and the Vite dev and preview servers every request's
 * (apps/web/vite.config.ts), so that they all read a path as the server does.
 *
 * No imports: vite.config.ts imports this file, and Vite's 'native' config loader (Node's own
 * import) loads it and everything it imports as Node resolves ES modules, where an import names its
 * file with its extension.
 */

const SLASH = 47;
const QUESTION = 63;
const HASH = 35;

/** The value of a hexadecimal digit's char code, or -1. */
function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  const lower = c | 0x20;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

/** Whether a char code is an unreserved character of RFC 3986: `A-Z a-z 0-9 - . _ ~`. */
function isUnreserved(c: number): boolean {
  const lower = c | 0x20;
  return (
    (lower >= 97 && lower <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 95 || c === 126
  );
}

/**
 * A request target in origin form, as the router reads it, so that what the server reads of the
 * path (its BASE_PATH, the page it falls back to) is the path the router routes:
 * - an absolute-form target (`http://host/path?q`, `HTTPS://host?q`: what a request to a proxy
 *   looks like, which servers must accept) loses its scheme and authority (`/path?q`, `/?q`), as
 *   the router does with it;
 * - a fragment (`#…`, which clients never send) is dropped, as the router ends the path there;
 * - the percent-encoded unreserved characters of the path are decoded (`/%61pi` is `/api`: RFC 3986
 *   6.2.2.2), as the router decodes them before it matches.
 * Any other target (`*`, `x`) is left as it is: no route serves it. Time linear in the target's
 * length.
 */
export function originForm(url: string): string {
  let target = url;
  if (target.charCodeAt(0) !== SLASH) {
    const scheme = target.slice(0, 8).toLowerCase();
    const authority = scheme.startsWith('http://') ? 7 : scheme.startsWith('https://') ? 8 : -1;
    if (authority === -1) return url;
    let end = authority;
    while (end < target.length) {
      const c = target.charCodeAt(end);
      if (c === SLASH || c === QUESTION || c === HASH) break;
      end++;
    }
    target = target.charCodeAt(end) === SLASH ? target.slice(end) : `/${target.slice(end)}`;
  }
  const hash = target.indexOf('#');
  if (hash !== -1) target = target.slice(0, hash);
  const query = target.indexOf('?');
  const pathEnd = query === -1 ? target.length : query;
  let percent = target.indexOf('%');
  if (percent === -1 || percent >= pathEnd) return target;
  let out = '';
  let from = 0;
  for (; percent !== -1 && percent + 2 < pathEnd; percent = target.indexOf('%', percent + 1)) {
    const high = hexValue(target.charCodeAt(percent + 1));
    const low = hexValue(target.charCodeAt(percent + 2));
    if (high < 0 || low < 0) continue;
    const code = high * 16 + low;
    if (!isUnreserved(code)) continue;
    out += target.slice(from, percent) + String.fromCharCode(code);
    from = percent + 3;
  }
  return from === 0 ? target : out + target.slice(from);
}
