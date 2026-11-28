import { rewriteDestination, type DavUpstream } from './rewrite';

/*
 * The WebDAV `If` request header (RFC 4918 section 10.4) as the proxy passes it on. Its resource
 * tags name resources by URL, in the namespace the client sees, the editor's
 * (`<http://editor.example/3d/dav/x.txt?token=…>`): sent on as they are, they would hand the WebDAV
 * server the editor's token and name resources it does not have, so that the lists they tag never
 * apply to its own (a lock-guarded write then fails). Each tag is mapped as a Destination is
 * (rewriteDestination: into WEBDAV_URL, its query without the `token` pairs); state tokens
 * (`<opaquelocktoken:…>`, `<urn:uuid:…>`, `<DAV:no-lock>`), entity tags and every other byte are
 * passed on as sent.
 *
 *   If            = 1*No-tag-list | 1*Tagged-list
 *   No-tag-list   = List
 *   Tagged-list   = Resource-Tag 1*List
 *   List          = "(" 1*Condition ")"
 *   Condition     = ["Not"] (State-token | "[" entity-tag "]")
 *   State-token   = Coded-URL = "<" absolute-URI ">"
 *   Resource-Tag  = "<" Simple-ref ">"   (an absolute URI, or an absolute path, with or without
 *                                         a query)
 *
 * with linear whitespace (spaces and tabs: Node lets no line break into a header value) between the
 * tokens, none inside `<…>` or between `[`, the entity tag and `]`. An entity tag is RFC 2616's,
 * which RFC 4918 cites (its own examples hold spaces: `["I am an ETag"]`): `W/` or not, then a
 * quoted string, which may hold spaces, `\`-escaped characters and any of `<`, `>`, `(`, `)`, `[`
 * and `]`, so it is read to its closing quote before anything else is looked for. A header that
 * does not follow this grammar (an empty one, a tag with no list, a no-tag list beside tagged ones,
 * several If lines that Node joined with `, `) is refused: what a WebDAV server would make of it is
 * anyone's guess. An entity tag is passed on whatever it holds, so a WebDAV server that does not
 * read it as a quoted string may find in it a resource tag the proxy did not map: webdav-server
 * 2.6, the tests' WebDAV server, ends a list at its first `)` and reads a `<…>` before a `(` as a
 * resource tag.
 */

/** What becomes of an `If` header: the header to send upstream, or why the request is refused. */
export type IfHeaderResult = { header: string } | { refused: 'malformed' | 'outside' };

const MALFORMED: IfHeaderResult = { refused: 'malformed' };
const OUTSIDE: IfHeaderResult = { refused: 'outside' };

const TAB = 0x09;
const SPACE = 0x20;
const DQUOTE = 0x22;
const PLUS = 0x2b;
const MINUS = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const COLON = 0x3a;
const LT = 0x3c;
const GT = 0x3e;
const UPPER_W = 0x57;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const LPAREN = 0x28;
const RPAREN = 0x29;
const DEL = 0x7f;

function isSpace(c: number): boolean {
  return c === SPACE || c === TAB;
}

/** The index of the first character at or after `i` that is no space or tab. */
function skipSpaces(header: string, i: number): number {
  while (i < header.length && isSpace(header.charCodeAt(i))) i++;
  return i;
}

/**
 * The index of the `>` that closes the `<` at `start` (a Coded-URL or a Resource-Tag), or -1: it
 * holds at least one character and no space, control character or `<`.
 */
function angleEnd(header: string, start: number): number {
  for (let i = start + 1; i < header.length; i++) {
    const c = header.charCodeAt(i);
    if (c === GT) return i > start + 1 ? i : -1;
    if (c <= SPACE || c === DEL || c === LT) return -1;
  }
  return -1;
}

/** Whether `header[from, to)` starts with a URI scheme and its `:`, as an absolute URI does. */
function startsWithScheme(header: string, from: number, to: number): boolean {
  const first = header.charCodeAt(from) | 0x20;
  if (first < 0x61 || first > 0x7a) return false;
  for (let i = from + 1; i < to; i++) {
    const c = header.charCodeAt(i);
    if (c === COLON) return true;
    const lower = c | 0x20;
    const ok =
      (lower >= 0x61 && lower <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === PLUS || c === MINUS || c === DOT;
    if (!ok) return false;
  }
  return false;
}

/**
 * Whether a char code is text of a quoted string (RFC 2616 TEXT): no control character but the tab,
 * a space or anything else up to U+00FF (a header value's bytes, as Node reads them).
 */
function isQuotedText(c: number): boolean {
  return c === TAB || (c >= SPACE && c !== DEL && c <= 0xff);
}

/**
 * The index after the `]` that ends the entity tag condition opened by the `[` at `start`, or -1:
 * `W/` or not, then a quoted string (RFC 2616, which RFC 4918's entity-tag is: text and `\`-escaped
 * characters between double quotes), then the `]` right after it.
 */
function entityTagEnd(header: string, start: number): number {
  let i = start + 1;
  if (header.charCodeAt(i) === UPPER_W && header.charCodeAt(i + 1) === SLASH) i += 2;
  if (header.charCodeAt(i) !== DQUOTE) return -1;
  for (i++; i < header.length; i++) {
    const c = header.charCodeAt(i);
    if (c === DQUOTE) return header.charCodeAt(i + 1) === RBRACKET ? i + 2 : -1;
    if (!isQuotedText(c)) return -1;
    // a quoted pair: the character after the backslash, `"` too, is part of the string
    if (c === BACKSLASH && !isQuotedText(header.charCodeAt(++i))) return -1;
  }
  return -1;
}

/** Whether `Not`, in any letter case (ABNF strings are), starts at `i`. */
function isNot(header: string, i: number): boolean {
  return (
    (header.charCodeAt(i) | 0x20) === 0x6e &&
    (header.charCodeAt(i + 1) | 0x20) === 0x6f &&
    (header.charCodeAt(i + 2) | 0x20) === 0x74
  );
}

/** The index after the `)` that ends the list opened by the `(` at `start`, or -1 when it is none. */
function listEnd(header: string, start: number): number {
  let conditions = 0;
  let i = start + 1;
  for (;;) {
    i = skipSpaces(header, i);
    if (i === header.length) return -1;
    let c = header.charCodeAt(i);
    if (c === RPAREN) return conditions > 0 ? i + 1 : -1;
    if (isNot(header, i)) {
      i = skipSpaces(header, i + 3);
      c = header.charCodeAt(i);
    }
    if (c === LT) {
      // a state token: an absolute URI, passed on as sent
      const end = angleEnd(header, i);
      if (end === -1 || !startsWithScheme(header, i + 1, end)) return -1;
      i = end + 1;
    } else if (c === LBRACKET) {
      i = entityTagEnd(header, i);
      if (i === -1) return -1;
    } else return -1;
    conditions++;
  }
}

/**
 * An `If` request header with its resource tags mapped into the WebDAV server's namespace, as
 * Destinations are (rewriteDestination, with `bases`, the request's base paths), and every other
 * byte as sent; or `malformed` when it does not follow RFC 4918's grammar, `outside` when a tag
 * names nothing under `/dav` or a path that leaves WEBDAV_URL (the request is then refused as a
 * Destination outside is). Time linear in the header's length.
 */
export function rewriteIfHeader(
  upstream: DavUpstream,
  header: string,
  bases: readonly string[] = [],
): IfHeaderResult {
  let out = '';
  // header[0, copied) is in `out`
  let copied = 0;
  // whether the header's lists are tagged, once its first list or tag has told
  let tagged: boolean | undefined;
  // lists since the last resource tag (since the start for no-tag lists)
  let lists = 0;
  let i = 0;
  for (;;) {
    i = skipSpaces(header, i);
    if (i === header.length) break;
    const c = header.charCodeAt(i);
    if (c === LT) {
      // a resource tag: none among no-tag lists, and none without a list of its own before the next
      if (tagged === false || (tagged === true && lists === 0)) return MALFORMED;
      const end = angleEnd(header, i);
      if (end === -1) return MALFORMED;
      const mapped = rewriteDestination(upstream, header.slice(i + 1, end), bases);
      if (mapped === null) return OUTSIDE;
      out += header.slice(copied, i + 1) + mapped;
      copied = end;
      tagged = true;
      lists = 0;
      i = end + 1;
    } else if (c === LPAREN) {
      tagged ??= false;
      i = listEnd(header, i);
      if (i === -1) return MALFORMED;
      lists++;
    } else return MALFORMED;
  }
  // no list at all (an empty header), or a tag at the end without one
  if (lists === 0) return MALFORMED;
  return { header: copied === 0 ? header : out + header.slice(copied) };
}
