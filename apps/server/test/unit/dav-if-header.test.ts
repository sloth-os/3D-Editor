import { describe, expect, it } from 'vitest';
import { rewriteIfHeader } from '../../src/dav/if-header';
import { parseUpstream } from '../../src/dav/rewrite';

/*
 * The WebDAV proxy's If header (dav/if-header.ts, RFC 4918 section 10.4): resource tags mapped into
 * WEBDAV_URL as Destinations are, without the editor's token; state tokens of any form, entity tags
 * and every other byte as sent; a tag outside refused as a Destination outside is, and named; a
 * header refused when it does not parse or when a WebDAV server (Sabre/DAV, Apache httpd's mod_dav,
 * golang.org/x/net/webdav, webdav-server) could read it with other tags, lists or conditions than
 * the proxy reads.
 */

const guarded = parseUpstream('http://127.0.0.1:4470/guarded');
const nextcloud = parseUpstream('https://cloud.example.com/remote.php/dav/files/alice%40example.com');
const root = parseUpstream('http://127.0.0.1:1900');
const UP = 'http://127.0.0.1:4470/guarded';

/** Spellings of a query name that decodes to `token` (as in dav-rewrite.test.ts). */
const TOKEN_NAMES = ['token', '%74oken', 'to%6Ben', '%74%6F%6B%65%6E', 'TOKEN', 'Tok%45n'];

/**
 * A million characters read in one pass take a few milliseconds (5 000 tags mapped as Destinations a
 * few tens); read quadratically (a copy of the rest of the header per token) they take minutes.
 */
const LINEAR_BOUND_MS = 1000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** Each header is refused as one that does not parse, or that some server reads otherwise. */
function expectMalformed(headers: string[]): void {
  for (const header of headers)
    expect(rewriteIfHeader(guarded, header, ['/3d']), JSON.stringify(header)).toEqual({
      refused: 'malformed',
    });
}

describe('rewriteIfHeader', () => {
  it('passes no-tag lists on as sent: state tokens of any form, Not and entity tags', () => {
    for (const header of [
      '(<opaquelocktoken:e71d4fae-5dec-22d6-fea5-00a0c91e6be4>)',
      // RFC 4918's own examples (section 10.4): entity tags are quoted strings, spaces and all
      '(<urn:uuid:181d4fae-7d8c-11d0-a765-00a0c91e6bf2> ["I am an ETag"]) (["I am another ETag"])',
      '(<urn:uuid:1>) (Not <DAV:no-lock>)',
      '(Not [W/"weak-1"])',
      '(<DAV:no-lock>) (["*"]) ([W/"x"])',
      // the lock tokens golang.org/x/net/webdav, and so rclone, gives out: bare decimal numbers
      '(<1795880655>)',
      '(<1795880655> ["e"])',
      // a state token of any other form: what a server gives out is passed on as it was given
      '(<no-scheme>)',
      '(<1abc:x>)',
      '(<a(b>) (<x]y>) (<"q">)',
      // a state token and an entity tag with a tab between them, or nothing
      '(<urn:x>\t["e"]) (<urn:y>[W/"f"])',
      // a quoted pair: an escaped quote or backslash is part of the entity tag
      '(["a\\"b"]) (["c\\\\"])',
      // a space or a tab in an entity tag, and the Latin-1 characters Node reads a header's bytes as
      '(["a b\tc"]) (["café ÿ"])',
    ])
      expect(rewriteIfHeader(guarded, header), header).toEqual({ header });
  });

  it('maps every resource tag of tagged lists into WEBDAV_URL and keeps every other byte as sent', () => {
    const bases = ['/3d'];
    expect(rewriteIfHeader(guarded, '</3d/dav/a.txt?token=s3cret> (<urn:uuid:1>)', bases)).toEqual({
      header: `<${UP}/a.txt> (<urn:uuid:1>)`,
    });
    // several tagged lists, absolute and path tags, several lists after a tag
    expect(
      rewriteIfHeader(
        guarded,
        '<http://editor.example/3d/dav/a.txt?token=s3cret> (<urn:uuid:1>) (["e1"]) </dav/b%20c.txt?k=1&%74oken=s3cret> (Not <DAV:no-lock>)',
        bases,
      ),
    ).toEqual({
      header: `<${UP}/a.txt> (<urn:uuid:1>) (["e1"]) <${UP}/b%20c.txt?k=1> (Not <DAV:no-lock>)`,
    });
    // a tag read as a request target is (`/%33d` is `/3d`), its encoded name kept
    expect(rewriteIfHeader(guarded, '</%33d/dav/caf%C3%A9.txt> (["x"])', bases)).toEqual({
      header: `<${UP}/caf%C3%A9.txt> (["x"])`,
    });
    // an absolute tag keeps the other pairs of its query
    expect(
      rewriteIfHeader(guarded, '<https://editor.example/dav/y.txt?keep=1&token=s3cret> (<urn:x>)'),
    ).toEqual({ header: `<${UP}/y.txt?keep=1> (<urn:x>)` });
    // with the request's base or BASE_PATH, or at the root
    expect(
      rewriteIfHeader(guarded, '</editor/dav/a> (<urn:x>) </3d/dav/b> (<urn:y>)', ['/editor', '/3d']),
    ).toEqual({
      header: `<${UP}/a> (<urn:x>) <${UP}/b> (<urn:y>)`,
    });
    expect(rewriteIfHeader(nextcloud, '</dav/3d-editor/p/doc.ybin> (<opaquelocktoken:abc>)')).toEqual({
      header:
        '<https://cloud.example.com/remote.php/dav/files/alice%40example.com/3d-editor/p/doc.ybin> (<opaquelocktoken:abc>)',
    });
    expect(rewriteIfHeader(root, '<http://h/dav/x/y> (["e"])')).toEqual({
      header: '<http://127.0.0.1:1900/x/y> (["e"])',
    });
    // the bare numbers x/net/webdav gives out, in a tagged list as davfs2 sends one
    expect(rewriteIfHeader(guarded, '<http://editor.example/3d/dav/n.txt> (<1795880655>)', bases)).toEqual({
      header: `<${UP}/n.txt> (<1795880655>)`,
    });
  });

  it('leaves the token out of a tag in every spelling, the other pairs kept in order', () => {
    for (const name of TOKEN_NAMES) {
      expect(
        rewriteIfHeader(guarded, `</3d/dav/x.txt?a=1&${name}=s3cret&b=%41> (<urn:x>)`, ['/3d']),
        name,
      ).toEqual({ header: `<${UP}/x.txt?a=1&b=%41> (<urn:x>)` });
      expect(rewriteIfHeader(guarded, `<http://e/dav/x.txt?${name}=s3cret> (<urn:x>)`), name).toEqual({
        header: `<${UP}/x.txt> (<urn:x>)`,
      });
    }
  });

  it('keeps the spaces and tabs before, between and after lists as sent, one after a tag', () => {
    expect(rewriteIfHeader(guarded, '\t </dav/a> (<urn:x>) \t (["y"])\t')).toEqual({
      header: `\t <${UP}/a> (<urn:x>) \t (["y"])\t`,
    });
    expect(rewriteIfHeader(guarded, '</dav/a>\t(<urn:x>)(["y"]) </dav/b> (<urn:z>)')).toEqual({
      header: `<${UP}/a>\t(<urn:x>)(["y"]) <${UP}/b> (<urn:z>)`,
    });
    expect(rewriteIfHeader(guarded, '(<urn:x>)(<urn:y>)')).toEqual({ header: '(<urn:x>)(<urn:y>)' });
  });

  it('reads `Not` so spelt, then one space or tab and one condition', () => {
    for (const header of ['(Not <urn:a>)', '(Not\t<DAV:no-lock>)', '(Not ["x"])', '(Not [W/"y"])'])
      expect(rewriteIfHeader(guarded, header), header).toEqual({ header });
    expect(rewriteIfHeader(guarded, '</dav/x> (Not <urn:a>) (Not ["b"])')).toEqual({
      header: `<${UP}/x> (Not <urn:a>) (Not ["b"])`,
    });
    expectMalformed([
      // golang.org/x/net/webdav reads `not` or `NOT` as a state token, mod_dav refuses them
      '(not <urn:a>)',
      '(NOT ["x"])',
      '(nOt [W/"y"])',
      '</dav/x> (not <urn:a>)',
      // Sabre/DAV reads a list only with one space or tab after `Not`, mod_dav with none too
      '(Not<urn:a>)',
      '(Not  <urn:a>)',
      // Sabre/DAV negates the whole list, RFC 4918 the condition `Not` stands before
      '(Not <urn:a> ["b"])',
      '(Not <urn:uuid:181d4fae-7d8c-11d0-a765-00a0c91e6bf2> <urn:uuid:58f202ac-22cf-11d1-b12d-002035b29092>)',
      '(Not ["a"] <urn:b>)',
      '(<urn:a> Not ["b"])',
    ]);
  });

  it('refuses an entity tag that holds <, >, (, ), [ or ], which other parsers take for the header’s own', () => {
    expectMalformed([
      '(["<http://evil.example/x>"])',
      '(["a)b"])',
      '([W/"(c)"])',
      '(["[d]"])',
      '(["<e>"])',
      '(["])<"])',
      '(["("])',
      '(["an ETag (with <brackets>) [and \\"quotes\\"]"])',
      // a tag hidden in an entity tag: Sabre/DAV, mod_dav, x/net/webdav and webdav-server read one
      '</dav/a> (["x)</api/projects>(["])',
      '</dav/a> (["x)"]) </3d/dav/b?token=s> (["y]"])',
      '</3d/dav/p.txt?token=s3cret> (Not <urn:x>) (["x] </remote.php/dav/files/alice/Documents/secret.txt> ([\\"e\\"]) "])',
      '</dav/p.txt> (["x]) </dav/../Documents/secret.txt> ([\\"e\\"]) ([\\""])',
      // escaped, too: a backslash makes none of them a character of the quoted string to all parsers
      '(["a\\<b"])',
      '(["a\\)"])',
      '(["a\\]"])',
      '(["\\["])',
    ]);
  });

  it('refuses a header that a WebDAV server could read with other tags, lists or conditions', () => {
    const tag = '</3d/dav/p.txt?token=s3cret>';
    expectMalformed([
      // a list of another shape than Sabre/DAV's: it reads a tag from a state token's `<` on to a
      // later tag (`#` cuts the path, `..` leaves WEBDAV_URL)
      `${tag} (Not <urn:x>) (<http://h/remote.php/dav/files/alice/Documents/secret.txt#> <urn:y>) ${tag} (["e"])`,
      `${tag} (<urn:b> <urn:a/../../Documents/secret.txt#>) ${tag} (["e"])`,
      '(<urn:a> <urn:b>)',
      '(<urn:a><urn:b>)',
      '(["a"] ["b"])',
      '(["a"] <urn:b>)',
      '(<urn:a>  ["b"])',
      // two spaces between a tag and its list: Sabre/DAV reads that tag on to the next one
      `${tag}  (Not <urn:a/../../Documents/secret.txt#>) ${tag} (["e"])`,
      '</dav/a>  (<urn:x>)',
      '</dav/a> \t(<urn:x>)',
      // no space between them: Sabre/DAV reads no tag there, the others do
      '</dav/a>(<urn:x>)',
      // a space just inside the parentheses
      '( <urn:x>)',
      '(<urn:x> )',
      '( ["e"])',
      '(["e"] )',
      // a `)` in a state token ends the list for mod_dav and webdav-server
      '(<urn:a)b>)',
      '(<urn:a)>) (<urn:b>)',
    ]);
  });

  it('refuses a tag that names nothing under /dav or a path out of WEBDAV_URL, and names the first such tag', () => {
    for (const [header, tag] of [
      ['<http://editor.example/api/projects> (<urn:x>)', 'http://editor.example/api/projects'],
      ['</3d/api/projects> (<urn:x>)', '/3d/api/projects'],
      ['</other/dav/x> (<urn:x>)', '/other/dav/x'],
      ['</dav/../outside-secret.txt> (<urn:x>)', '/dav/../outside-secret.txt'],
      ['</dav/..%2foutside-secret.txt> (<urn:x>)', '/dav/..%2foutside-secret.txt'],
      ['</dav/..;/outside-secret.txt> (<urn:x>)', '/dav/..;/outside-secret.txt'],
      ['</dav/.%09./outside-secret.txt> (<urn:x>)', '/dav/.%09./outside-secret.txt'],
      ['</dav/..#f> (<urn:x>)', '/dav/..#f'],
      ['<ftp://h/dav/x> (<urn:x>)', 'ftp://h/dav/x'],
      // a state token, a relative reference or the WebDAV server's own URL where a tag goes
      ['<urn:uuid:1> (<urn:x>)', 'urn:uuid:1'],
      ['<relative> (<urn:x>)', 'relative'],
      [`<${UP}/x> (<urn:x>)`, `${UP}/x`],
      // one tag outside among others inside, or the first of two outside
      ['</dav/a> (<urn:x>) </dav/../b> (<urn:y>)', '/dav/../b'],
      ['</api/one?token=s> (<urn:x>) </api/two> (<urn:y>)', '/api/one?token=s'],
    ])
      expect(rewriteIfHeader(guarded, header, ['/3d']), header).toEqual({ refused: 'outside', tag });
    // a header that does not parse is refused as such, whatever its tags name
    expectMalformed(['</api/projects> (<urn:x>) x', '</api/projects> (<urn:x> <urn:y>)']);
  });

  it('refuses a header that does not parse', () => {
    expectMalformed([
      // no list at all
      '',
      '   ',
      '\t',
      // lists that do not close or hold no condition
      '(',
      ')',
      '()',
      '( )',
      '(<urn:x>',
      '(<urn:x>) )',
      '(<urn:x>)(',
      // a tag without a list, two tags in a row, a tag and a no-tag list mixed
      '</dav/a>',
      '</dav/a> </dav/b> (<urn:x>)',
      '</dav/a> (<urn:x>) </dav/b>',
      '(<urn:x>) </dav/a> (<urn:y>)',
      '</dav/a>(<urn:x>)<',
      // several If lines, which Node joins with `, `
      '(<urn:x>), (<urn:y>)',
      '</dav/a> (<urn:x>), </dav/b> (<urn:y>)',
      // state tokens and tags: at least one character, no space, control character or `<` in it
      '(<>)',
      '<> (<urn:x>)',
      '(< urn:x>)',
      '(<urn: x>)',
      '(<urn:x)',
      '(<urn<x>)',
      '(<urn:a<b>)',
      '(<urn:\u0001>)',
      '(<urn:\u007f>)',
      '</dav/a<b> (<urn:x>)',
      '< /dav/a> (<urn:x>)',
      '</dav/a b> (<urn:x>)',
      '</dav/a\tb> (<urn:x>)',
      '</dav/a\u0000b> (<urn:x>)',
      // entity tags: quoted, no control character but a tab (escaped or not), `W/` only before the
      // quote, nothing between `[`, the quoted string and `]`
      '([unquoted])',
      '(["unterminated])',
      '(["escaped quote at the end\\"])',
      '(["backslash at the end\\',
      '(["a\u0001b"])',
      '(["a\u007fb"])',
      '(["a\\\u0001"])',
      '(["a\\\u007f"])',
      '(["a\\\u0000"])',
      '(["a"b"])',
      '([ "a"])',
      '(["a" ])',
      '([w/"a"])',
      '(W/"a")',
      '(["Ā"])',
      // Not before nothing, before Not, glued to a word
      '(Not)',
      '(Not )',
      '(Not Not <urn:x>)',
      '(Nota)',
      '(<urn:x> Not)',
      // anything else
      'x',
      '(<urn:x>) x',
      '</dav/a> x (<urn:x>)',
      '["e"]',
      '(<urn:x>)\u000b',
    ]);
  });

  it('reads a header in time linear in its length', () => {
    const cases: [string, 'header' | 'malformed'][] = [
      ['(<urn:x>)'.repeat(100_000), 'header'],
      [`</dav/a> ${'(["e"]) '.repeat(100_000)}`, 'header'],
      ['</dav/a?token=s> (<urn:x>) '.repeat(5_000), 'header'],
      [`(["${'a'.repeat(1_000_000)}"])`, 'header'],
      [`(["${'\\"'.repeat(500_000)}"])`, 'header'],
      [`(<${'a'.repeat(1_000_000)}>)`, 'header'],
      [`</dav/${'a'.repeat(1_000_000)}> (<urn:x>)`, 'header'],
      [`${' '.repeat(1_000_000)}(<urn:x>)`, 'header'],
      [`(${'<urn:x>'.repeat(150_000)})`, 'malformed'],
      [`(${'Not <urn:x> '.repeat(100_000)})`, 'malformed'],
      [`(${'['.repeat(1_000_000)}`, 'malformed'],
      [`(["${')'.repeat(1_000_000)}`, 'malformed'],
      [`<${'<'.repeat(1_000_000)}`, 'malformed'],
      [`(${'Not '.repeat(250_000)}`, 'malformed'],
      [`${'</dav/a> '.repeat(100_000)}`, 'malformed'],
      [`(<${'a'.repeat(1_000_000)}`, 'malformed'],
    ];
    for (const [header, outcome] of cases) {
      const run = timed(() => rewriteIfHeader(guarded, header));
      expect(outcome === 'header' ? 'header' in run.value : run.value, header.slice(0, 30)).toEqual(
        outcome === 'header' ? true : { refused: 'malformed' },
      );
      expect(run.ms, header.slice(0, 30)).toBeLessThan(LINEAR_BOUND_MS);
    }
    // the 5 000 tags are all mapped, without the token
    const many = rewriteIfHeader(guarded, '</dav/a?token=s> (<urn:x>) '.repeat(5_000));
    expect('header' in many && many.header).toBe(`<${UP}/a> (<urn:x>) `.repeat(5_000));
  });
});
