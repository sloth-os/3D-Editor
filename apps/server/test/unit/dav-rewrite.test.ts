import { describe, expect, it } from 'vitest';
import { parseMultistatus } from '@3d-editor/core';
import {
  davSegment,
  isInsideUpstream,
  parseUpstream,
  rewriteDestination,
  rewriteMultistatus,
  toLocalHref,
  upstreamUrlFor,
  withoutTokenPairs,
} from '../../src/dav/rewrite';

const nextcloud = parseUpstream('https://cloud.example.com/remote.php/dav/files/alice%40example.com');
const root = parseUpstream('http://127.0.0.1:1900');
const guarded = parseUpstream('http://127.0.0.1:4470/guarded');

/**
 * Spellings of a query name that decodes to `token`: the ones extractToken reads (URLSearchParams
 * decodes names) and other letter cases, which the logs redact too (isTokenName).
 */
const TOKEN_NAMES = ['token', '%74oken', 'to%6Ben', '%74%6F%6B%65%6E', 'TOKEN', 'Tok%45n'];

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** 200 000 characters read in one pass take well under a millisecond each; quadratic reading takes minutes. */
const LINEAR_BOUND_MS = 1000;

describe('upstreamUrlFor', () => {
  it('maps /dav paths below the upstream base URL', () => {
    expect(upstreamUrlFor(nextcloud, '/dav')!.toString()).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice%40example.com/',
    );
    expect(upstreamUrlFor(nextcloud, '/dav/')!.toString()).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice%40example.com/',
    );
    expect(upstreamUrlFor(nextcloud, '/dav/3d-editor/projects/a%20b/document.ybin?x=1')!.toString()).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice%40example.com/3d-editor/projects/a%20b/document.ybin?x=1',
    );
    expect(upstreamUrlFor(root, '/dav/x/y')!.toString()).toBe('http://127.0.0.1:1900/x/y');
  });

  it('refuses traversal and foreign prefixes', () => {
    expect(upstreamUrlFor(nextcloud, '/dav/../secret')).toBeNull();
    expect(upstreamUrlFor(nextcloud, '/dav/a/%2e%2e/%2E%2E/x')).toBeNull();
    expect(upstreamUrlFor(nextcloud, '/dav/a/./b')).toBeNull();
    expect(upstreamUrlFor(nextcloud, '/dav/a%00b')).toBeNull();
    expect(upstreamUrlFor(nextcloud, '/davx/a')).toBeNull();
    expect(upstreamUrlFor(nextcloud, '/api/projects')).toBeNull();
  });

  it('never leaves the upstream origin', () => {
    const u = upstreamUrlFor(root, '/dav//evil.example.com/x')!;
    expect(u.origin).toBe('http://127.0.0.1:1900');
    expect(u.pathname).toBe('/evil.example.com/x');
  });

  it('refuses segments that decode to a slash, a backslash, NUL or a dot segment (..%2f), and keeps other names', () => {
    const guarded = parseUpstream('http://127.0.0.1:4470/guarded');
    for (const upstream of [guarded, nextcloud, root]) {
      for (const path of [
        '/dav/..%2foutside-secret.txt',
        '/dav/..%2Foutside-secret.txt',
        '/dav/x/..%2f..%2foutside-secret.txt',
        '/dav/x%2f..%2f..%2fs',
        '/dav/%2e%2e%2fs',
        '/dav/.%2e/s',
        '/dav/..%5cs',
        '/dav/x%5C..%5C..%5Cs',
        '/dav/x/..\\s',
        '/dav/a%00b',
        '/dav/..',
        '/dav/x/.',
      ])
        expect(upstreamUrlFor(upstream, path), `${upstream.basePath} ${path}`).toBeNull();
    }
    // names with encoded spaces, UTF-8 and reserved characters other than the slash are kept
    expect(upstreamUrlFor(guarded, '/dav/')!.toString()).toBe('http://127.0.0.1:4470/guarded/');
    expect(upstreamUrlFor(guarded, '/dav/inside.txt')!.toString()).toBe(
      'http://127.0.0.1:4470/guarded/inside.txt',
    );
    expect(upstreamUrlFor(guarded, '/dav/x/y%20z.json')!.toString()).toBe(
      'http://127.0.0.1:4470/guarded/x/y%20z.json',
    );
    expect(upstreamUrlFor(guarded, '/dav/caf%C3%A9.txt')!.toString()).toBe(
      'http://127.0.0.1:4470/guarded/caf%C3%A9.txt',
    );
    expect(upstreamUrlFor(guarded, '/dav/a%26b%3Fc%23d%25e')!.pathname).toBe('/guarded/a%26b%3Fc%23d%25e');
    expect(upstreamUrlFor(guarded, '/dav/..x/x..')!.pathname).toBe('/guarded/..x/x..');
  });

  it('refuses segments that do not decode', () => {
    const guarded = parseUpstream('http://127.0.0.1:4470/guarded');
    for (const upstream of [guarded, nextcloud, root])
      for (const path of ['/dav/%zz', '/dav/%', '/dav/a%2', '/dav/%C3', '/dav/%C3%28', '/dav/x/%E0%A4%A'])
        expect(upstreamUrlFor(upstream, path), `${upstream.basePath} ${path}`).toBeNull();
  });

  it('reads one segment at a time (davSegment)', () => {
    expect(davSegment('a%20b')).toBe('a b');
    expect(davSegment('caf%C3%A9')).toBe('café');
    expect(davSegment('')).toBe('');
    for (const raw of ['..%2f', '%2F', '%5c', '%00', '.', '%2e', '..', '.%2E', '%zz', '%C3'])
      expect(davSegment(raw), raw).toBeNull();
  });

  it('refuses a segment with an ASCII control character or DEL, raw or encoded (davSegment)', () => {
    // the URL parser drops a tab, CR and LF: `.\t.` would be sent as `..`
    for (const raw of [
      '.\t.',
      '.%09.',
      '%09',
      'a\tb',
      '.%0A.',
      'a%0db',
      '%01',
      'x%1F',
      '\u0001',
      '%7F',
      'x\u007f',
    ])
      expect(davSegment(raw), JSON.stringify(raw)).toBeNull();
    // the characters around them are names
    expect(davSegment('%20')).toBe(' ');
    expect(davSegment('~')).toBe('~');
    expect(davSegment('%C2%80')).toBe('\u0080');
  });

  it('refuses a segment that is `.` or `..` up to its first `;`, as servlet containers read it (davSegment)', () => {
    // Tomcat cuts `;` path parameters off a segment before it resolves dot segments
    for (const raw of [
      '..;',
      '..;x',
      '..;jsessionid=1',
      '..%3b',
      '..%3B',
      '%2e%2e;',
      '%2e%2e%3b',
      '.%2E%3Bx',
      '.;',
      '%2e;',
      '.;a;b',
    ])
      expect(davSegment(raw), raw).toBeNull();
    // a name that merely holds a `;` is one
    for (const [raw, name] of [
      ['a;b.txt', 'a;b.txt'],
      ['a%3Bb', 'a;b'],
      [';', ';'],
      [';..', ';..'],
      ['...;', '...;'],
      ['..x;y', '..x;y'],
    ])
      expect(davSegment(raw), raw).toBe(name);
  });

  it('refuses paths and Destinations with control characters or `..;` segments, for every upstream', () => {
    for (const upstream of [guarded, nextcloud, root]) {
      for (const path of [
        '/dav/..;/outside-secret.txt',
        '/dav/x/..;x/..;/s',
        '/dav/..%3b/s',
        '/dav/%2e%2e;/s',
        '/dav/.;/s',
        '/dav/.%09./s',
        '/dav/x/%09/s',
        '/dav/a%0Ab',
      ])
        expect(upstreamUrlFor(upstream, path), `${upstream.basePath} ${path}`).toBeNull();
      for (const destination of [
        '/dav/.\t./pwned.txt',
        '/3d/dav/x/.\t./.\t./pwned.txt',
        '/dav/.%09./pwned.txt',
        '/3d/dav/..;/pwned.txt',
        'http://h/dav/..%3B/pwned.txt',
      ])
        expect(
          rewriteDestination(upstream, destination, ['/3d']),
          `${upstream.basePath} ${destination}`,
        ).toBeNull();
    }
    // names with a `;` are passed on
    expect(upstreamUrlFor(guarded, '/dav/a;b.txt')!.pathname).toBe('/guarded/a;b.txt');
    expect(rewriteDestination(guarded, '/3d/dav/x/c;d.txt', ['/3d'])).toBe(
      'http://127.0.0.1:4470/guarded/x/c;d.txt',
    );
  });
});

describe('isInsideUpstream', () => {
  it('holds a path as sent upstream to the upstream base or under it, decoded and resolved', () => {
    for (const p of ['/guarded', '/guarded/', '/guarded/a/b.txt', '/guarded/a%20b', '/guarded//a'])
      expect(isInsideUpstream(guarded, p), p).toBe(true);
    for (const p of [
      '/guarded/../x',
      '/guarded/..',
      '/guarded/a/../../x',
      // the URL parser resolves dot segments: a path that still holds one is refused, inside or not
      '/guarded/a/../b',
      '/guarded/./b',
      '/guardedx/y',
      '/guarded%2fx',
      '/x',
      '/',
      '/guarded/..;/x',
      '/guarded/.%09./x',
      '/guarded/%zz',
    ])
      expect(isInsideUpstream(guarded, p), p).toBe(false);
    // the root upstream holds every path whose segments are names
    for (const p of ['/', '/x/y', '/a%20b/']) expect(isInsideUpstream(root, p), p).toBe(true);
    for (const p of ['/%zz', '/a/../b', '/x/..;/y']) expect(isInsideUpstream(root, p), p).toBe(false);
  });

  it('compares with an encoded upstream base decoded', () => {
    // `alice%40example.com` is `alice@example.com`
    expect(isInsideUpstream(nextcloud, '/remote.php/dav/files/alice%40example.com/x')).toBe(true);
    expect(isInsideUpstream(nextcloud, '/remote.php/dav/files/alice@example.com/x')).toBe(true);
    expect(isInsideUpstream(nextcloud, '/remote.php/dav/files/alice%2540example.com/x')).toBe(false);
    expect(isInsideUpstream(nextcloud, '/remote.php/dav/files/bob/x')).toBe(false);
    const spaced = parseUpstream('http://h/a%20b/c');
    expect(isInsideUpstream(spaced, '/a%20b/c/d')).toBe(true);
    expect(isInsideUpstream(spaced, '/a b/c')).toBe(true);
    expect(isInsideUpstream(spaced, '/a%20b/cd')).toBe(false);
    expect(isInsideUpstream(spaced, '/a%2520b/c')).toBe(false);
  });

  it('is what refuses a Destination the URL parser reads as a way out (upstreamUrlFor checks the URL it built)', () => {
    // `.. ` and `.%2e ` are names to the segment check, but the URL parser trims a space at the end
    // of what it reads (the Destination's fragment is cut off first): `/guarded/.. ` is built as
    // `/guarded/..`, that is `/`, outside the folder
    for (const destination of ['/dav/.. #f', '/3d/dav/.. #x', '/dav/.%2e #f'])
      expect(rewriteDestination(guarded, destination, ['/3d']), destination).toBeNull();
    expect(rewriteDestination(nextcloud, '/dav/.. #f')).toBeNull();
  });
});

describe('the token in the query never reaches the WebDAV server', () => {
  it('is left out of the URL sent upstream, in every spelling, the other pairs kept as sent', () => {
    for (const name of TOKEN_NAMES) {
      expect(upstreamUrlFor(guarded, `/dav/x.txt?${name}=s3cret`)!.href, name).toBe(
        'http://127.0.0.1:4470/guarded/x.txt',
      );
      expect(upstreamUrlFor(guarded, `/dav/x.txt?a=1&${name}=s3cret&b=%41&c`)!.href, name).toBe(
        'http://127.0.0.1:4470/guarded/x.txt?a=1&b=%41&c',
      );
      expect(upstreamUrlFor(guarded, `/dav/?${name}=s3cret&z=9`)!.href, name).toBe(
        'http://127.0.0.1:4470/guarded/?z=9',
      );
      expect(upstreamUrlFor(nextcloud, `/dav/x?${name}=s3cret#frag`)!.search, name).toBe('');
      expect(upstreamUrlFor(root, `/dav/x?${name}=s3cret&${name}=again`)!.href, name).toBe(
        'http://127.0.0.1:1900/x',
      );
    }
  });

  it('is left out of a Destination too', () => {
    for (const name of TOKEN_NAMES) {
      expect(rewriteDestination(guarded, `/3d/dav/y.txt?${name}=s3cret&keep=1`, ['/3d']), name).toBe(
        'http://127.0.0.1:4470/guarded/y.txt?keep=1',
      );
      expect(rewriteDestination(guarded, `https://editor.example/dav/y.txt?${name}=s3cret#f`), name).toBe(
        'http://127.0.0.1:4470/guarded/y.txt',
      );
    }
  });

  it('keeps every other pair as it is, in order, and drops a query left without pairs (withoutTokenPairs)', () => {
    for (const [query, kept] of [
      ['', ''],
      ['?', '?'],
      ['?a=1&b=2', '?a=1&b=2'],
      ['?a=1&token=s&b=2', '?a=1&b=2'],
      ['?token=s&a=1', '?a=1'],
      ['?token=s', ''],
      ['?token=s&%74oken=t&to%6Ben=u', ''],
      // URLSearchParams reads `token` here too: a pair starts after any `?`, as redactUrl reads it
      ['??token=s', ''],
      ['?a=1?token=s', '?a=1'],
      // a value runs to the next `&`
      ['?token=s?a=1&b=2', '?b=2'],
      ['?token=s&', ''],
      ['?a&&token=s&&b', '?a&&&b'],
      // a name without a value
      ['?token', ''],
      ['?token&a=1', '?a=1'],
      // names that are not `token`, spelled as sent
      ['?tokens=1&atoken=2&to%6B=3&%74oke=4&token%3D=5', '?tokens=1&atoken=2&to%6B=3&%74oke=4&token%3D=5'],
      ['?b=%41&a=%zz&token=s&c=+&d', '?b=%41&a=%zz&c=+&d'],
    ])
      expect(withoutTokenPairs(query), query).toBe(kept);
  });

  it('reads a query in time linear in its length', () => {
    for (const query of [
      `?${'?'.repeat(200_000)}`,
      `?${'&'.repeat(200_000)}token=s`,
      `?${'%74'.repeat(70_000)}=s`,
      `?a=${'b'.repeat(200_000)}&token=s`,
      `?${'&token=s'.repeat(25_000)}`,
    ]) {
      const run = timed(() => withoutTokenPairs(query));
      expect(run.value.includes('token=s')).toBe(false);
      expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
    }
  });
});

describe('toLocalHref', () => {
  it('maps absolute URLs and paths under the base', () => {
    expect(
      toLocalHref(nextcloud, 'https://cloud.example.com/remote.php/dav/files/alice%40example.com/3d-editor/'),
    ).toBe('/dav/3d-editor/');
    expect(toLocalHref(nextcloud, '/remote.php/dav/files/alice@example.com/3d-editor/a%20b.txt')).toBe(
      '/dav/3d-editor/a%20b.txt',
    );
    expect(toLocalHref(nextcloud, '/remote.php/dav/files/alice%40example.com/')).toBe('/dav/');
    expect(toLocalHref(nextcloud, '/remote.php/dav/files/alice%40example.com')).toBe('/dav');
    expect(toLocalHref(root, 'http://127.0.0.1:1900/files/alice%20b/')).toBe('/dav/files/alice%20b/');
  });

  it('leaves foreign references alone', () => {
    expect(
      toLocalHref(nextcloud, 'https://other.example.com/remote.php/dav/files/alice%40example.com/x'),
    ).toBeNull();
    expect(toLocalHref(nextcloud, '/remote.php/dav/files/bob/x')).toBeNull();
    expect(toLocalHref(nextcloud, 'relative/path')).toBeNull();
    expect(toLocalHref(nextcloud, 'mailto:a@b')).toBeNull();
  });

  it('puts the paths under the base path of the request (docs/subpath.md)', () => {
    expect(
      toLocalHref(nextcloud, '/remote.php/dav/files/alice%40example.com/3d-editor/a%20b.txt', '/3d'),
    ).toBe('/3d/dav/3d-editor/a%20b.txt');
    expect(
      toLocalHref(
        nextcloud,
        'https://cloud.example.com/remote.php/dav/files/alice%40example.com/',
        '/tools/3d-editor',
      ),
    ).toBe('/tools/3d-editor/dav/');
    expect(toLocalHref(nextcloud, '/remote.php/dav/files/alice%40example.com', '/3d')).toBe('/3d/dav');
    expect(toLocalHref(root, 'http://127.0.0.1:1900/x/y', '/3d')).toBe('/3d/dav/x/y');
    expect(toLocalHref(root, '/x/y', '')).toBe('/dav/x/y');
    expect(toLocalHref(nextcloud, '/remote.php/dav/files/bob/x', '/3d')).toBeNull();
  });
});

describe('rewriteMultistatus', () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/alice%40example.com/3d-editor/projects/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>https://cloud.example.com/remote.php/dav/files/alice%40example.com/3d-editor/projects/p1/document.ybin</d:href>
<d:propstat><d:prop><d:getetag>"abc"</d:getetag><d:getcontentlength>12</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<D:response xmlns:D="DAV:"><D:href>/remote.php/dav/files/alice%40example.com/a&amp;b%20c.txt</D:href></D:response>
<d:response><d:href>https://elsewhere.example.com/x</d:href></d:response></d:multistatus>`;

  it('rewrites every href (any namespace prefix) and keeps the rest', () => {
    const out = rewriteMultistatus(xml, nextcloud);
    expect(out).toContain('<d:href>/dav/3d-editor/projects/</d:href>');
    expect(out).toContain('<d:href>/dav/3d-editor/projects/p1/document.ybin</d:href>');
    expect(out).toContain('<D:href>/dav/a%26b%20c.txt</D:href>');
    expect(out).toContain('<d:href>https://elsewhere.example.com/x</d:href>');
    expect(out).toContain('<d:getetag>"abc"</d:getetag>');
    const parsed = parseMultistatus(out);
    expect(parsed.map((r) => r.href)).toEqual([
      '/dav/3d-editor/projects/',
      '/dav/3d-editor/projects/p1/document.ybin',
      '/dav/a%26b%20c.txt',
      'https://elsewhere.example.com/x',
    ]);
    expect(parsed[0].isDir).toBe(true);
    expect(parsed[1].size).toBe(12);
  });

  it('puts the hrefs under the base path given (docs/subpath.md)', () => {
    const out = rewriteMultistatus(xml, nextcloud, '/3d');
    expect(out).toContain('<D:href>/3d/dav/a%26b%20c.txt</D:href>');
    expect(parseMultistatus(out).map((r) => r.href)).toEqual([
      '/3d/dav/3d-editor/projects/',
      '/3d/dav/3d-editor/projects/p1/document.ybin',
      '/3d/dav/a%26b%20c.txt',
      'https://elsewhere.example.com/x',
    ]);
  });
});

describe('rewriteDestination', () => {
  it('maps absolute and path destinations into the upstream', () => {
    expect(rewriteDestination(nextcloud, 'http://editor.local:8080/dav/3d-editor/b.txt')).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice%40example.com/3d-editor/b.txt',
    );
    expect(rewriteDestination(root, '/dav/x%20y')).toBe('http://127.0.0.1:1900/x%20y');
  });

  it('refuses destinations outside /dav', () => {
    expect(rewriteDestination(root, 'http://editor.local/api/projects')).toBeNull();
    expect(rewriteDestination(root, '/dav/../etc')).toBeNull();
    expect(rewriteDestination(root, 'ftp://x/dav/a')).toBeNull();
    expect(rewriteDestination(root, 'relative')).toBeNull();
  });

  it("accepts destinations with or without one of the request's base paths (docs/subpath.md)", () => {
    const bases = ['/editor', '/3d'];
    expect(rewriteDestination(root, 'https://example.com/3d/dav/x%20y', bases)).toBe(
      'http://127.0.0.1:1900/x%20y',
    );
    expect(rewriteDestination(root, '/editor/dav/a/b.txt?x=1', bases)).toBe(
      'http://127.0.0.1:1900/a/b.txt?x=1',
    );
    expect(rewriteDestination(root, '/dav/a', bases)).toBe('http://127.0.0.1:1900/a');
    expect(rewriteDestination(nextcloud, '/3d/dav/3d-editor/b.txt', bases)).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice%40example.com/3d-editor/b.txt',
    );
  });

  it('refuses destinations under another prefix, or outside /dav below the base', () => {
    const bases = ['/3d'];
    expect(rewriteDestination(root, '/other/dav/a', bases)).toBeNull();
    expect(rewriteDestination(root, 'https://example.com/other/dav/a', bases)).toBeNull();
    expect(rewriteDestination(root, '/3dx/dav/a', bases)).toBeNull();
    expect(rewriteDestination(root, '/3d/api/projects', bases)).toBeNull();
    expect(rewriteDestination(root, '/3d', bases)).toBeNull();
    expect(rewriteDestination(root, '/3d/dav/../etc', bases)).toBeNull();
    // at the root (no base) a path under a prefix is not under /dav
    expect(rewriteDestination(root, '/3d/dav/a')).toBeNull();
  });

  it('refuses destinations that leave the upstream base through an encoded slash (..%2f)', () => {
    const guarded = parseUpstream('http://127.0.0.1:4470/guarded');
    for (const destination of [
      '/dav/..%2fpwned.txt',
      '/3d/dav/..%2fpwned.txt',
      'http://h/dav/x/..%2f..%2fpwned.txt',
      'https://h/3d/dav/x%2f..%2f..%2fpwned.txt',
      '/dav/%2e%2e%2fpwned.txt',
      '/dav/..%5cpwned.txt',
    ])
      expect(rewriteDestination(guarded, destination, ['/3d']), destination).toBeNull();
  });

  it('refuses destinations whose segments do not decode', () => {
    const guarded = parseUpstream('http://127.0.0.1:4470/guarded');
    for (const destination of ['/dav/%%%%', `/dav/${'%'.repeat(10_000)}`, '/dav/%zz', 'http://h/dav/a%C3'])
      expect(rewriteDestination(guarded, destination), destination.slice(0, 20)).toBeNull();
  });

  it('reads the path of a destination as a request target is read (originForm)', () => {
    const bases = ['/3d'];
    expect(rewriteDestination(root, '/%33d/dav/x', bases)).toBe('http://127.0.0.1:1900/x');
    expect(rewriteDestination(root, '/%64av/x')).toBe('http://127.0.0.1:1900/x');
    expect(rewriteDestination(root, 'http://h/%33d/%64%61v/x%20y', bases)).toBe(
      'http://127.0.0.1:1900/x%20y',
    );
    expect(rewriteDestination(root, '/3d/dav/caf%C3%A9.txt#f', bases)).toBe(
      'http://127.0.0.1:1900/caf%C3%A9.txt',
    );
    // reserved characters keep their encoding: %2F is no slash
    expect(rewriteDestination(root, '/3d%2Fdav/x', bases)).toBeNull();
  });
});
