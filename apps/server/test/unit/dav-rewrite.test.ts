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
});
