import { describe, expect, it } from 'vitest';
import { rewriteIfHeader } from '../../src/dav/if-header';
import { parseUpstream } from '../../src/dav/rewrite';

/*
 * The WebDAV proxy's If header (dav/if-header.ts, RFC 4918 section 10.4): resource tags mapped into
 * WEBDAV_URL as Destinations are, without the editor's token; state tokens, entity tags and every
 * other byte as sent; a tag outside refused as a Destination outside is, a header that does not
 * parse refused.
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

describe('rewriteIfHeader', () => {
  it('passes no-tag lists on as sent: state tokens, Not and entity tags', () => {
    for (const header of [
      '(<opaquelocktoken:e71d4fae-5dec-22d6-fea5-00a0c91e6be4>)',
      // RFC 4918's own examples (section 10.4): entity tags are quoted strings, spaces and all
      '(<urn:uuid:181d4fae-7d8c-11d0-a765-00a0c91e6bf2> ["I am an ETag"]) (["I am another ETag"])',
      '(Not <urn:uuid:181d4fae-7d8c-11d0-a765-00a0c91e6bf2> <urn:uuid:58f202ac-22cf-11d1-b12d-002035b29092>)',
      '(<urn:uuid:1>) (Not <DAV:no-lock>)',
      '(Not <DAV:no-lock> [W/"weak-1"])',
      '(<DAV:no-lock>) (["*"]) ([W/"x"])',
      // a quoted pair: an escaped quote or backslash is part of the entity tag
      '(["a\\"b"] ["c\\\\"])',
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

  it('reads Not in any letter case, with or without spaces before the condition', () => {
    for (const header of ['(not<urn:a>)', '(NOT ["x"])', '(Not\t<DAV:no-lock>)', '(nOt  [W/"y"] <urn:b>)'])
      expect(rewriteIfHeader(guarded, header), header).toEqual({ header });
    expect(rewriteIfHeader(guarded, '</dav/x> (nOt <urn:a> ["b"])')).toEqual({
      header: `<${UP}/x> (nOt <urn:a> ["b"])`,
    });
  });

  it('reads an entity tag to its closing quote: the <, >, (, ), [ and ] it holds are none of the header’s own', () => {
    for (const header of [
      '(["<http://evil.example/x>"])',
      '(["a)b"] [W/"(c)"] ["[d]"] ["<e>"])',
      '(["])<"] ["("])',
      '(["an ETag (with <brackets>) [and \\"quotes\\"]"])',
    ])
      expect(rewriteIfHeader(guarded, header), header).toEqual({ header });
    // only the real tags are mapped: what an entity tag holds stays as sent
    expect(rewriteIfHeader(guarded, '</dav/a> (["x)</api/projects>(["])')).toEqual({
      header: `<${UP}/a> (["x)</api/projects>(["])`,
    });
    expect(rewriteIfHeader(guarded, '</dav/a> (["x)"]) </3d/dav/b?token=s> (["y]"])', ['/3d'])).toEqual({
      header: `<${UP}/a> (["x)"]) <${UP}/b> (["y]"])`,
    });
  });

  it('keeps the spaces and tabs between tokens as sent, and needs none', () => {
    expect(rewriteIfHeader(guarded, '</dav/a>(<urn:x>)(["y"])')).toEqual({
      header: `<${UP}/a>(<urn:x>)(["y"])`,
    });
    expect(rewriteIfHeader(guarded, '\t </dav/a> \t ( \t<urn:x>\t ["y"] \t)\t')).toEqual({
      header: `\t <${UP}/a> \t ( \t<urn:x>\t ["y"] \t)\t`,
    });
    expect(rewriteIfHeader(guarded, '(<urn:x>)(<urn:y>)')).toEqual({ header: '(<urn:x>)(<urn:y>)' });
  });

  it('refuses a tag that names nothing under /dav or a path out of WEBDAV_URL, as a Destination outside is', () => {
    for (const header of [
      '<http://editor.example/api/projects> (<urn:x>)',
      '</3d/api/projects> (<urn:x>)',
      '</other/dav/x> (<urn:x>)',
      '</dav/../outside-secret.txt> (<urn:x>)',
      '</dav/..%2foutside-secret.txt> (<urn:x>)',
      '</dav/..;/outside-secret.txt> (<urn:x>)',
      '</dav/.%09./outside-secret.txt> (<urn:x>)',
      '</dav/..#f> (<urn:x>)',
      '<ftp://h/dav/x> (<urn:x>)',
      // a state token, a relative reference or the WebDAV server's own URL where a tag goes
      '<urn:uuid:1> (<urn:x>)',
      '<relative> (<urn:x>)',
      `<${UP}/x> (<urn:x>)`,
      // one tag outside among others inside
      '</dav/a> (<urn:x>) </dav/../b> (<urn:y>)',
    ])
      expect(rewriteIfHeader(guarded, header, ['/3d']), header).toEqual({ refused: 'outside' });
  });

  it('refuses a header that does not parse', () => {
    for (const header of [
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
      // state tokens: an absolute URI, with no space in it
      '(<>)',
      '(<no-scheme>)',
      '(<1abc:x>)',
      '(< urn:x>)',
      '(<urn: x>)',
      '(<urn:x)',
      '(<urn<x>)',
      // entity tags: quoted, no control character but a tab, `W/` only before the quote, nothing
      // between `[`, the quoted string and `]`
      '([unquoted])',
      '(["unterminated])',
      '(["escaped quote at the end\\"])',
      '(["backslash at the end\\',
      '(["a\u0001b"])',
      '(["a\u007fb"])',
      '(["a"b"])',
      '([ "a"])',
      '(["a" ])',
      '([w/"a"])',
      '(W/"a")',
      // Not before nothing, before Not, glued to a word
      '(Not)',
      '(Not Not <urn:x>)',
      '(Nota)',
      '(<urn:x> Not)',
      // a tag with a space or a tab in it
      '< /dav/a> (<urn:x>)',
      '</dav/a b> (<urn:x>)',
      '</dav/a\tb> (<urn:x>)',
      // anything else
      'x',
      '(<urn:x>) x',
      '</dav/a> x (<urn:x>)',
      '["e"]',
    ])
      expect(rewriteIfHeader(guarded, header), JSON.stringify(header)).toEqual({ refused: 'malformed' });
  });

  it('reads a header in time linear in its length', () => {
    const cases: [string, 'header' | 'malformed'][] = [
      ['(<urn:x>)'.repeat(100_000), 'header'],
      [`</dav/a> ${'(["e"]) '.repeat(100_000)}`, 'header'],
      ['</dav/a?token=s> (<urn:x>) '.repeat(5_000), 'header'],
      [`(["${'a'.repeat(1_000_000)}"])`, 'header'],
      [`(["${'\\"'.repeat(500_000)}"])`, 'header'],
      [`</dav/${'a'.repeat(1_000_000)}> (<urn:x>)`, 'header'],
      [`${' '.repeat(1_000_000)}(<urn:x>)`, 'header'],
      [`(${'<urn:x>'.repeat(150_000)})`, 'header'],
      [`(${'Not <urn:x> '.repeat(100_000)})`, 'header'],
      [`(${'['.repeat(1_000_000)}`, 'malformed'],
      [`(["${')'.repeat(1_000_000)}`, 'malformed'],
      [`<${'<'.repeat(1_000_000)}`, 'malformed'],
      [`(${'Not '.repeat(250_000)}`, 'malformed'],
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
