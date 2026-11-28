import { describe, expect, it } from 'vitest';
import { parseMultistatus } from '@3d-editor/core';
import {
  davSegment,
  parseUpstream,
  rewriteDestination,
  rewriteMultistatus,
  toLocalHref,
  upstreamUrlFor,
} from '../../src/dav/rewrite';

const nextcloud = parseUpstream('https://cloud.example.com/remote.php/dav/files/alice%40example.com');
const root = parseUpstream('http://127.0.0.1:1900');

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
