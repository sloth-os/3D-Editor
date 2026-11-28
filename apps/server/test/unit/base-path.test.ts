import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  BUILD_TOP_LEVEL,
  RESERVED_PREFIXES,
  basePathProblem,
  baseHref,
  forwardedPrefix,
  isReservedPath,
  normalizeBasePath,
  parseBasePath,
  pathWithin,
  stripBasePath,
  withBaseHref,
} from '../../src/base-path';
import { baseUrl, type ToolExtra } from '../../src/mcp/tool-kit';
import {
  originalUrlOf,
  requestBase,
  requestBaseInfo,
  requestBases,
  rewriteRequestUrl,
} from '../../src/request-base';

/*
 * Serving under a subpath (docs/subpath.md): the parsing of BASE_PATH and X-Forwarded-Prefix, the
 * removal of the base from request URLs, the pages' <base href> and the links of MCP results.
 */

/** Values no base path can be, with the reason basePathProblem gives. */
const REFUSED: [string, RegExp][] = [
  ['//evil.example', /empty path segment/],
  ['/../x', /'\.\.' segment/],
  ['/a/..', /'\.\.' segment/],
  ['/./a', /'\.' segment/],
  ['/a b', /characters other than/],
  ['/%2e', /characters other than/],
  ['/a?b', /characters other than/],
  ['/a#b', /characters other than/],
  ['/a\\b', /characters other than/],
  ['/a@b', /characters other than/],
  ['/ä', /characters other than/],
  ['3d', /does not start with \//],
  ['https://evil.example/x', /does not start with \//],
  ['/api', /starts with \/api, one of the server's own paths/],
  ['/api/v2', /starts with \/api,/],
  ['/assets/x', /starts with \/assets,/],
  ['/desk', /starts with \/desk,/],
  ['/sw.js', /starts with \/sw\.js,/],
];

const ACCEPTED: [string, string][] = [
  ['/3d', '/3d'],
  ['/3d/', '/3d'],
  ['/3d//', '/3d'],
  [' /3d ', '/3d'],
  ['/a/b.c~d-e_f', '/a/b.c~d-e_f'],
  ['/tools/3d-editor', '/tools/3d-editor'],
  // the server's own names are reserved as the first segment only
  ['/x/api', '/x/api'],
  ['/apix', '/apix'],
  ['/desk2', '/desk2'],
  ['/', ''],
  ['', ''],
];

describe('the server’s own paths', () => {
  it('reserves the API prefixes and the paths below them', () => {
    expect(RESERVED_PREFIXES).toEqual([
      '/api',
      '/sync',
      '/mcp',
      '/dav',
      '/otlp',
      '/metrics',
      '/healthz',
      '/readyz',
    ]);
    for (const p of ['/api', '/api/config', '/sync/abc', '/mcp', '/dav/', '/otlp/v1/traces', '/healthz'])
      expect(isReservedPath(p), p).toBe(true);
    for (const p of ['/', '/apix', '/assets/app.js', '/desk', '/index.html', '/projects/api'])
      expect(isReservedPath(p), p).toBe(false);
  });

  it('names the top of the build and the desk’s clean URL', () => {
    expect([...BUILD_TOP_LEVEL].sort()).toEqual(
      [
        'assets',
        'desk',
        'desk.html',
        'favicon.svg',
        'icons',
        'index.html',
        'manifest.webmanifest',
        'sw.js',
      ].sort(),
    );
  });
});

describe('basePathProblem, normalizeBasePath and parseBasePath', () => {
  it('refuses what cannot be a base path, with the reason', () => {
    for (const [value, reason] of REFUSED) {
      expect(basePathProblem(value), value).toMatch(reason);
      expect(normalizeBasePath(value), value).toBeNull();
    }
    // every top-level name of the server and its build
    for (const prefix of RESERVED_PREFIXES) expect(basePathProblem(prefix), prefix).toMatch(/server's own/);
    for (const name of BUILD_TOP_LEVEL) expect(basePathProblem(`/${name}`), name).toMatch(/server's own/);
  });

  it('accepts paths of letters, digits and . _ ~ -, without their trailing slashes', () => {
    for (const [value, base] of ACCEPTED) {
      expect(basePathProblem(value), value).toBeNull();
      expect(normalizeBasePath(value), value).toBe(base);
      expect(parseBasePath(value), value).toBe(base);
    }
    expect(normalizeBasePath(undefined)).toBeNull();
    expect(normalizeBasePath(null)).toBeNull();
  });

  it('reads BASE_PATH: unset is the root, an unusable value stops the server with the reason', () => {
    expect(parseBasePath(undefined)).toBe('');
    for (const [value, reason] of REFUSED) {
      expect(() => parseBasePath(value), value).toThrow(/^Invalid configuration: BASE_PATH: /);
      expect(() => parseBasePath(value), value).toThrow(reason);
    }
    expect(() => parseBasePath('/a b')).toThrow(
      "Invalid configuration: BASE_PATH: '/a b' has characters other than letters, digits and . _ ~ - in its path segments",
    );
  });
});

describe('forwardedPrefix (X-Forwarded-Prefix)', () => {
  it('reads a usable prefix, without its trailing slash', () => {
    expect(forwardedPrefix('/editor')).toBe('/editor');
    expect(forwardedPrefix('/editor/')).toBe('/editor');
    expect(forwardedPrefix(' /a/b ')).toBe('/a/b');
    expect(forwardedPrefix('/')).toBe('');
  });

  it('ignores an absent, empty or unusable header: it never steers links off the site', () => {
    for (const value of [
      undefined,
      '',
      '  ',
      '//evil.example',
      '/api',
      '/a/../b',
      'https://evil.example',
      '/a b',
    ])
      expect(forwardedPrefix(value), String(value)).toBeNull();
  });

  it('counts a header of several values by its first', () => {
    expect(forwardedPrefix('/one, /two')).toBe('/one');
    expect(forwardedPrefix('/one,/two')).toBe('/one');
    expect(forwardedPrefix('//evil.example, /ok')).toBeNull();
    expect(forwardedPrefix(', /ok')).toBeNull();
    expect(forwardedPrefix(['/x', '/y'])).toBe('/x');
    expect(forwardedPrefix([])).toBeNull();
  });
});

describe('stripBasePath', () => {
  it('removes the base a URL starts with, query kept', () => {
    expect(stripBasePath('/3d/api/config', ['/3d'])).toEqual({
      url: '/api/config',
      base: '/3d',
      bare: false,
    });
    expect(stripBasePath('/3d/', ['/3d'])).toEqual({ url: '/', base: '/3d', bare: false });
    expect(stripBasePath('/3d/sync/p1?token=t', ['/3d'])).toEqual({
      url: '/sync/p1?token=t',
      base: '/3d',
      bare: false,
    });
    expect(stripBasePath('/a/b/x', ['/a/b'])).toEqual({ url: '/x', base: '/a/b', bare: false });
  });

  it('marks the base without its slash as bare, query kept', () => {
    expect(stripBasePath('/3d', ['/3d'])).toEqual({ url: '/', base: '/3d', bare: true });
    expect(stripBasePath('/3d?x=1', ['/3d'])).toEqual({ url: '/?x=1', base: '/3d', bare: true });
  });

  it('leaves URLs under no base, and root bases, as they are', () => {
    for (const url of ['/', '/api/config', '/3dx/a', '/3dx', '/x/3d/a', '/3D/a'])
      expect(stripBasePath(url, ['/3d']), url).toEqual({ url, base: '', bare: false });
    expect(stripBasePath('/x', ['', ''])).toEqual({ url: '/x', base: '', bare: false });
    expect(stripBasePath('/x', [])).toEqual({ url: '/x', base: '', bare: false });
  });

  it('removes the first of the bases the URL starts with', () => {
    expect(stripBasePath('/editor/a', ['/editor', '/3d'])).toMatchObject({ url: '/a', base: '/editor' });
    expect(stripBasePath('/3d/a', ['/editor', '/3d'])).toMatchObject({ url: '/a', base: '/3d' });
    expect(stripBasePath('/a/b/c', ['/a/b', '/a'])).toMatchObject({ url: '/c', base: '/a/b' });
    expect(stripBasePath('/a/b/c', ['/a', '/a/b'])).toMatchObject({ url: '/b/c', base: '/a' });
  });
});

describe('the pages’ <base href>', () => {
  it('is the base with its slash', () => {
    expect(baseHref('')).toBe('/');
    expect(baseHref('/3d')).toBe('/3d/');
    expect(baseHref('/a/b')).toBe('/a/b/');
  });

  it('is the first element of <head>, before anything that loads a URL', () => {
    const page =
      '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <link rel="manifest" href="./manifest.webmanifest" />\n    <script type="module" src="./assets/index-1a2b.js"></script>\n  </head>\n  <body><header></header></body>\n</html>\n';
    const out = withBaseHref(page, '/3d');
    expect(out).toBe(page.replace('<head>', '<head>\n    <base href="/3d/" />'));
    expect(out.indexOf('<base href="/3d/" />')).toBeLessThan(out.indexOf('<meta'));
    expect(withBaseHref(page, '')).toContain('<head>\n    <base href="/" />');
    expect(withBaseHref('<html><head data-x="1"><title>t</title></head></html>', '/a')).toBe(
      '<html><head data-x="1">\n    <base href="/a/" /><title>t</title></head></html>',
    );
    // <header> is no <head>
    expect(withBaseHref('<!doctype html><HEAD><title>t</title></HEAD><header>', '/a')).toBe(
      '<!doctype html><HEAD>\n    <base href="/a/" /><title>t</title></HEAD><header>',
    );
  });

  it('replaces a <base> of the page', () => {
    expect(withBaseHref('<head><base href="./" /><title>t</title></head>', '/3d')).toBe(
      '<head><base href="/3d/" /><title>t</title></head>',
    );
    expect(withBaseHref('<head><BASE HREF="/old/"></head>', '')).toBe('<head><base href="/" /></head>');
  });

  it('goes after <html> or the doctype of a page without a <head> tag, never before the doctype', () => {
    expect(withBaseHref('<!doctype html><title>3D Editor</title>', '/3d')).toBe(
      '<!doctype html><base href="/3d/" /><title>3D Editor</title>',
    );
    expect(withBaseHref('<!DOCTYPE html>\n<html lang="en"><title>t</title>', '/3d')).toBe(
      '<!DOCTYPE html>\n<html lang="en"><base href="/3d/" /><title>t</title>',
    );
    expect(withBaseHref('<title>t</title>', '/3d')).toBe('<base href="/3d/" />\n<title>t</title>');
  });
});

describe('pathWithin', () => {
  it('gives a path from a scope or base URL’s path, null outside it', () => {
    expect(pathWithin('/3d/desk.html', '/3d/')).toBe('/desk.html');
    expect(pathWithin('/3d/', '/3d/')).toBe('/');
    expect(pathWithin('/3d/a/b', '/3d')).toBe('/a/b');
    expect(pathWithin('/3d', '/3d/')).toBeNull();
    expect(pathWithin('/3dx/a', '/3d')).toBeNull();
    expect(pathWithin('/other/x', '/3d/')).toBeNull();
    expect(pathWithin('/desk.html', '/')).toBe('/desk.html');
  });
});

/** A raw request as Node gives it (the fields the prefix removal reads). */
function rawRequest(url: string, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

describe('the prefix removal (rewriteRequestUrl)', () => {
  it('removes BASE_PATH from the URLs that start with it and remembers the URL as sent', () => {
    const req = rawRequest('/3d/api/config?x=1');
    expect(rewriteRequestUrl(req, '/3d')).toBe('/api/config?x=1');
    expect(requestBaseInfo(req)).toEqual({
      base: '/3d',
      bases: ['/3d'],
      removed: '/3d',
      bare: false,
      originalUrl: '/3d/api/config?x=1',
    });
    expect(requestBase(req)).toBe('/3d');
    expect(originalUrlOf(req)).toBe('/3d/api/config?x=1');
    // requests to the server's own port without the prefix keep working, with BASE_PATH as base
    const plain = rawRequest('/healthz');
    expect(rewriteRequestUrl(plain, '/3d')).toBe('/healthz');
    expect(requestBaseInfo(plain)).toMatchObject({ base: '/3d', removed: '', bare: false });
  });

  it("takes the request's base from X-Forwarded-Prefix and removes it or BASE_PATH", () => {
    const stripped = rawRequest('/api/config', { 'x-forwarded-prefix': '/editor' });
    expect(rewriteRequestUrl(stripped, '')).toBe('/api/config');
    expect(requestBase(stripped)).toBe('/editor');
    expect(requestBases(stripped)).toEqual(['/editor', '']);
    const kept = rawRequest('/editor/api/config', { 'x-forwarded-prefix': '/editor' });
    expect(rewriteRequestUrl(kept, '/3d')).toBe('/api/config');
    expect(requestBaseInfo(kept)).toMatchObject({
      base: '/editor',
      bases: ['/editor', '/3d'],
      removed: '/editor',
    });
    const configured = rawRequest('/3d/api/config', { 'x-forwarded-prefix': '/editor' });
    expect(rewriteRequestUrl(configured, '/3d')).toBe('/api/config');
    expect(requestBaseInfo(configured)).toMatchObject({ base: '/editor', removed: '/3d' });
  });

  it('ignores an unusable X-Forwarded-Prefix', () => {
    for (const header of ['//evil.example', '/api', '/a/../b', 'https://evil.example']) {
      const req = rawRequest('/a/b', { 'x-forwarded-prefix': header });
      expect(rewriteRequestUrl(req, '/3d'), header).toBe('/a/b');
      expect(requestBase(req), header).toBe('/3d');
    }
  });

  it('marks the bare base, whose page is at the base with its slash', () => {
    const req = rawRequest('/3d?x=1');
    expect(rewriteRequestUrl(req, '/3d')).toBe('/?x=1');
    expect(requestBaseInfo(req)).toMatchObject({ removed: '/3d', bare: true });
  });

  it('answers for requests it did not see from their header', () => {
    expect(requestBaseInfo(rawRequest('/x'))).toBeNull();
    expect(requestBase(rawRequest('/x'))).toBe('');
    expect(requestBase(rawRequest('/x', { 'x-forwarded-prefix': '/p' }))).toBe('/p');
    expect(requestBases(rawRequest('/x', { 'x-forwarded-prefix': '/p' }))).toEqual(['/p']);
    expect(originalUrlOf(rawRequest('/x?y'))).toBe('/x?y');
  });
});

/** The `extra` of an MCP tool call, of which baseUrl reads `requestInfo` only. */
function extraWith(requestInfo?: ToolExtra['requestInfo']): ToolExtra {
  const extra: Partial<ToolExtra> = requestInfo ? { requestInfo } : {};
  return extra as ToolExtra;
}

/** The `extra` of an MCP tool call made over HTTP with these headers (lowercased, as the SDK gives them). */
function httpCall(headers: Record<string, string>, url = 'http://127.0.0.1:8080/mcp'): ToolExtra {
  return extraWith({ headers: { host: new URL(url).host, ...headers }, url: new URL(url) });
}

describe('the links of MCP results (baseUrl)', () => {
  const root = { basePath: '' };
  const under3d = { basePath: '/3d' };

  it('are the address the client used, then the base path', () => {
    expect(baseUrl(httpCall({}), root)).toBe('http://127.0.0.1:8080');
    expect(baseUrl(httpCall({}), under3d)).toBe('http://127.0.0.1:8080/3d');
    const proxied = {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'example.com',
      'x-forwarded-prefix': '/3d',
    };
    expect(baseUrl(httpCall(proxied), root)).toBe('https://example.com/3d');
    // the header's base wins over BASE_PATH
    expect(baseUrl(httpCall({ ...proxied, 'x-forwarded-prefix': '/editor' }), under3d)).toBe(
      'https://example.com/editor',
    );
    // a proxy that sets Host and X-Forwarded-Proto only (the nginx example)
    expect(baseUrl(httpCall({ 'x-forwarded-proto': 'https' }, 'http://example.com/mcp'), under3d)).toBe(
      'https://example.com/3d',
    );
  });

  it('read the last values of X-Forwarded-Proto and X-Forwarded-Host, as Fastify does', () => {
    expect(
      baseUrl(
        httpCall({ 'x-forwarded-proto': 'http, https', 'x-forwarded-host': 'inner.local, example.com:8443' }),
        root,
      ),
    ).toBe('https://example.com:8443');
    // a default port is dropped, the host lowercased
    expect(
      baseUrl(httpCall({ 'x-forwarded-proto': 'HTTPS', 'x-forwarded-host': 'Example.COM:443' }), root),
    ).toBe('https://example.com');
  });

  it('ignore forwarded values they cannot use', () => {
    for (const host of ['example.com/evil', 'user@example.com', 'exa mple.com', 'example.com:99999', '?x'])
      expect(baseUrl(httpCall({ 'x-forwarded-host': host }), root), host).toBe('http://127.0.0.1:8080');
    expect(baseUrl(httpCall({ 'x-forwarded-proto': 'ftp' }), root)).toBe('http://127.0.0.1:8080');
    expect(baseUrl(httpCall({ 'x-forwarded-prefix': '//evil.example' }), under3d)).toBe(
      'http://127.0.0.1:8080/3d',
    );
    expect(baseUrl(httpCall({ 'x-forwarded-prefix': '/' }), under3d)).toBe('http://127.0.0.1:8080');
  });

  it('fall back to the Host header, and are empty without an HTTP request', () => {
    expect(baseUrl(extraWith({ headers: { host: 'editor.local:9000' } }), under3d)).toBe(
      'http://editor.local:9000/3d',
    );
    expect(baseUrl(extraWith({ headers: {} }), under3d)).toBe('');
    // an in-memory client: links stay paths from the server's root, as REST gives them
    expect(baseUrl(extraWith(), under3d)).toBe('');
  });
});
