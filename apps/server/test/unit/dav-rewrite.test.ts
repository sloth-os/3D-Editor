import { describe, expect, it } from 'vitest';
import { parseMultistatus } from '@3d-editor/core';
import {
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
});
