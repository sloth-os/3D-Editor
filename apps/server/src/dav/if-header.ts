import { rewriteDestination, type DavUpstream } from './rewrite';

/*
 * The WebDAV `If` request header (RFC 4918 section 10.4) as the proxy passes it on. Its resource
 * tags name resources by URL, in the namespace the client sees, the editor's
 * (`<http://editor.example/3d/dav/x.txt?token=…>`): sent on as they are, they would hand the WebDAV
 * server the editor's token and name resources it does not have, so that the lists they tag never
 * apply to its own (a lock-guarded write then fails). Each tag is mapped as a Destination is
 * (rewriteDestination: into WEBDAV_URL, its query without the `token` pairs); state tokens of any
 * form (`<opaquelocktoken:…>`, `<urn:uuid:…>`, `<DAV:no-lock>`, the bare numbers that
 * golang.org/x/net/webdav, and so rclone, gives out: `<1795880655>`), entity tags and every other
 * byte are passed on as sent.
 *
 * The WebDAV server must find in what it gets the tags, lists and conditions the proxy read, and
 * no others: a tag it found where the proxy saw none, or read to another end, would make it
 * evaluate a condition on a resource the proxy never mapped, one outside WEBDAV_URL too (whether it
 * exists, its ETag). WebDAV servers read the header each with a parser of its own, looser than
 * RFC 4918:
 * - Sabre/DAV (Nextcloud; Server::getIfConditions) looks for one regular expression anywhere in
 *   the header,
 *   `(?:<(?P<uri>.*?)>\s)?\((?P<not>Not\s)?(?:<(?P<token>[^>]*)>)?(?:\s?)(?:\[(?P<etag>[^\]]*)\])?\)`:
 *   it reads a list only in that shape and a tag only one space or tab before one, and from any
 *   other `<` (a state token's in a list of another shape, a tag two spaces before its list) it
 *   reads a tag on to the next `>` that a space or tab and such a list follow, whatever lies
 *   between: with a state token `<urn:a/../../x#>` in it, the path of that tag, cut at the `#` and
 *   its `..` resolved, is outside WEBDAV_URL. Its `Not` negates the whole list;
 * - Apache httpd's mod_dav (dav_process_if_header) ends a list at its first `)` and an entity tag
 *   at its first `]`, and knows `Not` only so spelt;
 * - golang.org/x/net/webdav ends an entity tag at its first `]` and reads `not` or `NOT` as a
 *   state token;
 * - webdav-server 2.6, the tests' WebDAV server, ends a list at its first `)`.
 * So the proxy accepts RFC 4918's grammar narrowed to what they all read alike, and refuses any
 * other header:
 *
 *   If            = 1*No-tag-list | 1*Tagged-list
 *   No-tag-list   = List
 *   Tagged-list   = Resource-Tag WSP 1*List         one space or tab before the tag's first list
 *   List          = "(" ["Not" WSP] Condition ")"    `Not` so spelt
 *                 | "(" State-token [WSP] "[" entity-tag "]" ")"
 *   Condition     = State-token | "[" entity-tag "]"
 *   State-token   = "<" 1*(any character but a space, a control character, "<", ">" and ")") ">"
 *   Resource-Tag  = "<" 1*(any character but a space, a control character, "<" and ">") ">"
 *                   (a URL or a path that rewriteDestination maps, or else outside)
 *   entity-tag    = ["W/"] quoted-string  (RFC 2616's, which RFC 4918 cites: `\` escapes the
 *                   character after it; no "<", ">", "(", ")", "[" or "]" in it)
 *
 * with any spaces and tabs (Node lets no line break into a header value) before, between and after
 * lists, and none elsewhere. The forms WebDAV clients send fit it (Finder's and Windows'
 * `(<opaquelocktoken:…>)`, davfs2's `<http://…> (<opaquelocktoken:…>)`), and so do RFC 4918's own
 * examples but one, `(Not <urn:a> <urn:b>)`, which Sabre/DAV reads as no list. The ETags servers
 * give out hold none of the characters left out (Sabre/DAV's, Nextcloud's and x/net/webdav's are
 * hex digits, Apache's and nginx's hex digits and `-`), and lock tokens no `)`. A header outside
 * the grammar (an empty one, a tag with no list, a no-tag list beside tagged ones, several If lines
 * that Node joined with `, `) is refused as malformed before any tag in it counts as outside.
 */

/** What becomes of an `If` header: the header to send upstream, or why the request is refused. */
export type IfHeaderResult =
  | { header: string }
  | { refused: 'malformed' }
  /** `tag`: the first resource tag that names nothing in WEBDAV_URL, as sent */
  | { refused: 'outside'; tag: string };

const MALFORMED: IfHeaderResult = { refused: 'malformed' };

const TAB = 0x09;
const SPACE = 0x20;
const DQUOTE = 0x22;
const LPAREN = 0x28;
const RPAREN = 0x29;
const SLASH = 0x2f;
const LT = 0x3c;
const GT = 0x3e;
const UPPER_N = 0x4e;
const UPPER_W = 0x57;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const LOWER_O = 0x6f;
const LOWER_T = 0x74;
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
 * The index of the `>` that closes the `<` at `start` (a Resource-Tag, or a State-token when
 * `stateToken`), or -1: it holds at least one character and no space, control character or `<`,
 * nor, in a state token, a `)`, which ends a list for mod_dav and webdav-server.
 */
function angleEnd(header: string, start: number, stateToken: boolean): number {
  for (let i = start + 1; i < header.length; i++) {
    const c = header.charCodeAt(i);
    if (c === GT) return i > start + 1 ? i : -1;
    if (c <= SPACE || c === DEL || c === LT || (stateToken && c === RPAREN)) return -1;
  }
  return -1;
}

/**
 * Whether a char code may stand in an entity tag's quoted string, escaped or not: RFC 2616 TEXT (no
 * control character but the tab; a space or anything else up to U+00FF, a header value's bytes as
 * Node reads them), but none of `<`, `>`, `(`, `)`, `[` and `]`, which other parsers take for the
 * header's own structure there.
 */
function isEntityTagText(c: number): boolean {
  if (c !== TAB && (c < SPACE || c === DEL || c > 0xff)) return false;
  return c !== LT && c !== GT && c !== LPAREN && c !== RPAREN && c !== LBRACKET && c !== RBRACKET;
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
    let c = header.charCodeAt(i);
    if (c === DQUOTE) return header.charCodeAt(i + 1) === RBRACKET ? i + 2 : -1;
    // a quoted pair: the character after the backslash, `"` too, is part of the string
    if (c === BACKSLASH) c = header.charCodeAt(++i);
    if (!isEntityTagText(c)) return -1;
  }
  return -1;
}

/** Whether `Not`, so spelt, starts at `i`. */
function isNot(header: string, i: number): boolean {
  return (
    header.charCodeAt(i) === UPPER_N &&
    header.charCodeAt(i + 1) === LOWER_O &&
    header.charCodeAt(i + 2) === LOWER_T
  );
}

/**
 * The index after the `)` that ends the list opened by the `(` at `start`, or -1 when it is none:
 * `Not`, one space or tab, and one condition; or a state token, an entity tag, or a state token and
 * an entity tag with one space or tab between them or none. Nothing else, no space either, stands
 * between the parentheses.
 */
function listEnd(header: string, start: number): number {
  let i = start + 1;
  const not = isNot(header, i);
  if (not) {
    if (!isSpace(header.charCodeAt(i + 3))) return -1;
    i += 4;
  }
  let conditions = 0;
  if (header.charCodeAt(i) === LT) {
    const end = angleEnd(header, i, true);
    if (end === -1) return -1;
    i = end + 1;
    conditions++;
    if (!not && isSpace(header.charCodeAt(i)) && header.charCodeAt(i + 1) === LBRACKET) i++;
  }
  // `Not` negates one condition: Sabre/DAV would negate both
  if (header.charCodeAt(i) === LBRACKET && !(not && conditions > 0)) {
    i = entityTagEnd(header, i);
    if (i === -1) return -1;
    conditions++;
  }
  return conditions > 0 && header.charCodeAt(i) === RPAREN ? i + 1 : -1;
}

/**
 * An `If` request header with its resource tags mapped into the WebDAV server's namespace, as
 * Destinations are (rewriteDestination, with `bases`, the request's base paths), and every other
 * byte as sent; or `malformed` when it does not follow the grammar above, `outside` when it does
 * but a tag names nothing under `/dav` or a path that leaves WEBDAV_URL (the request is then
 * refused as a Destination outside is). Time linear in the header's length.
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
  let lists = 0;
  let outside: string | undefined;
  let i = skipSpaces(header, 0);
  while (i < header.length) {
    if (header.charCodeAt(i) === LT) {
      // a resource tag: none among no-tag lists, and one space or tab then its first list after it
      if (tagged === false) return MALFORMED;
      const end = angleEnd(header, i, false);
      if (end === -1 || !isSpace(header.charCodeAt(end + 1)) || header.charCodeAt(end + 2) !== LPAREN)
        return MALFORMED;
      const tag = header.slice(i + 1, end);
      const mapped = rewriteDestination(upstream, tag, bases);
      if (mapped === null) outside ??= tag;
      else {
        out += header.slice(copied, i + 1) + mapped;
        copied = end;
      }
      tagged = true;
      i = end + 2;
    }
    if (header.charCodeAt(i) !== LPAREN) return MALFORMED;
    tagged ??= false;
    i = listEnd(header, i);
    if (i === -1) return MALFORMED;
    lists++;
    i = skipSpaces(header, i);
  }
  // no list at all: an empty header
  if (lists === 0) return MALFORMED;
  if (outside !== undefined) return { refused: 'outside', tag: outside };
  return { header: copied === 0 ? header : out + header.slice(copied) };
}
