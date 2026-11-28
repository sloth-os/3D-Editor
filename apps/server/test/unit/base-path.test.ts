import { existsSync, readdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  trimTrailingSlashes,
  withBaseHref,
} from '../../src/base-path';
import { loadConfig } from '../../src/config';
import { MCP_INSTRUCTIONS } from '../../src/mcp/instructions';
import { baseUrl, isHostAndPort, type ToolExtra } from '../../src/mcp/tool-kit';
import {
  carriesForwardedPrefix,
  keptPrefix,
  originForm,
  originalUrlOf,
  requestBase,
  requestBaseInfo,
  requestBases,
  rewriteRequestUrl,
} from '../../src/request-base';

/*
 * Serving under a subpath (docs/subpath.md): the parsing of BASE_PATH and X-Forwarded-Prefix, the
 * removal of BASE_PATH from request URLs (in origin form), the pages' <base href> and the links of
 * MCP results; and that what reads a request's headers takes time linear in their length.
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
        'sw.js.map',
      ].sort(),
    );
  });

  it('names every top-level entry of the web app’s public files and, when it is built, of its build', () => {
    const web = fileURLToPath(new URL('../../../web/', import.meta.url));
    const entries = (dir: string): string[] => {
      try {
        return readdirSync(path.join(web, dir));
      } catch (err) {
        // the build is not always there (and another build may be replacing it)
        if (dir === 'dist' && (err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    };
    const publicFiles = entries('public');
    expect(publicFiles.length).toBeGreaterThan(0);
    for (const entry of publicFiles) expect(BUILD_TOP_LEVEL, `public/${entry}`).toContain(entry);
    if (!existsSync(path.join(web, 'dist'))) return;
    for (const entry of entries('dist')) expect(BUILD_TOP_LEVEL, `dist/${entry}`).toContain(entry);
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

describe('the length of a base path', () => {
  /** 256 characters, the longest base path. */
  const longest = `/${'a'.repeat(255)}`;
  /** 257 characters. */
  const tooLong = `/${'a'.repeat(256)}`;

  it('is at most 256 characters: a longer BASE_PATH stops the server with the reason', () => {
    expect(longest).toHaveLength(256);
    expect(basePathProblem(longest)).toBeNull();
    expect(parseBasePath(longest)).toBe(longest);
    expect(loadConfig({ BASE_PATH: longest }).basePath).toBe(longest);
    const refusal = `Invalid configuration: BASE_PATH: '${tooLong}' is longer than 256 characters`;
    expect(basePathProblem(tooLong)).toBe('is longer than 256 characters');
    expect(normalizeBasePath(tooLong)).toBeNull();
    expect(() => parseBasePath(tooLong)).toThrow(refusal);
    expect(() => loadConfig({ BASE_PATH: tooLong })).toThrow(refusal);
    // as given: a trailing slash counts
    expect(() => parseBasePath(`${longest}/`)).toThrow('is longer than 256 characters');
  });

  it('a longer X-Forwarded-Prefix value is ignored (as sent, spaces included)', () => {
    expect(forwardedPrefix(longest)).toBe(longest);
    expect(forwardedPrefix(`${longest}, /other`)).toBe(longest);
    expect(forwardedPrefix(tooLong)).toBeNull();
    expect(forwardedPrefix(`${tooLong}, /3d`)).toBeNull();
    expect(forwardedPrefix(`/3d${' '.repeat(253)}`)).toBe('/3d');
    expect(forwardedPrefix(`/3d${' '.repeat(254)}`)).toBeNull();
    const req = rawRequest('/api/config', { 'x-forwarded-prefix': tooLong });
    expect(rewriteRequestUrl(req, '/3d')).toBe('/api/config');
    expect(requestBase(req)).toBe('/3d');
    // the request still carries the header: nothing is removed from its path
    const under3d = rawRequest('/3d/api/config', { 'x-forwarded-prefix': tooLong });
    expect(rewriteRequestUrl(under3d, '/3d')).toBe('/3d/api/config');
  });
});

/** Runs `fn`: what it returned and the milliseconds it took. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/**
 * 200 000 slashes and an `x`: a regular expression such as /\/+$/ takes quadratic time on it (about
 * 20 s on a laptop), a scan from its end well under a millisecond. The bound leaves room for a busy
 * machine.
 */
const SLASH_RUN = `${'/'.repeat(200_000)}x`;
const LINEAR_BOUND_MS = 1000;

describe('what reads request headers takes time linear in their length', () => {
  it('trims trailing slashes in one pass', () => {
    for (const [value, trimmed] of [
      ['/3d/', '/3d'],
      ['/3d//', '/3d'],
      ['/', ''],
      ['', ''],
      ['/a/b', '/a/b'],
      ['//x//', '//x'],
    ])
      expect(trimTrailingSlashes(value), value).toBe(trimmed);
    const run = timed(() => [
      trimTrailingSlashes(SLASH_RUN),
      trimTrailingSlashes('/'.repeat(200_000)),
      trimTrailingSlashes(`x${'/'.repeat(200_000)}`),
    ]);
    expect(run.value).toEqual([SLASH_RUN, '', 'x']);
    expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
  });

  it('X-Forwarded-Prefix, BASE_PATH: a long run of slashes is refused at once', () => {
    const run = timed(() => [
      forwardedPrefix(SLASH_RUN),
      forwardedPrefix(`${SLASH_RUN}, /3d`),
      forwardedPrefix([SLASH_RUN]),
      normalizeBasePath(SLASH_RUN),
      basePathProblem(SLASH_RUN),
    ]);
    expect(run.value).toEqual([null, null, null, null, 'is longer than 256 characters']);
    expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
  });

  it('the base of a request or WebSocket upgrade with such a header (rewriteRequestUrl)', () => {
    const req = rawRequest('/3d/api/config', { 'x-forwarded-prefix': SLASH_RUN });
    const run = timed(() => rewriteRequestUrl(req, '/3d'));
    // the header is not usable, but the request carries it: routed as it came
    expect(run.value).toBe('/3d/api/config');
    expect(requestBase(req)).toBe('/3d');
    expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
  });

  it('whether a request carries X-Forwarded-Prefix, in long or many header lines', () => {
    const blank = ' \t'.repeat(100_000);
    const lines = Array.from({ length: 50_000 }, () => ['X-Forwarded-Prefix', blank.slice(0, 8)]).flat();
    for (const [raw, carries] of [
      [['X-Forwarded-Prefix', blank], false],
      [['X-Forwarded-Prefix', `${blank}/3d`], true],
      [lines, false],
      [[...lines, 'x-forwarded-prefix', '/3d'], true],
    ] as const) {
      const run = timed(() => carriesForwardedPrefix(rawLines('/3d/x', [...raw])));
      expect(run.value).toBe(carries);
      expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
    }
  });

  it('the links of MCP results with such X-Forwarded-Prefix, -Host and -Proto headers (baseUrl)', () => {
    const headers = {
      'x-forwarded-prefix': SLASH_RUN,
      'x-forwarded-host': `${'a'.repeat(200_000)}/`,
      'x-forwarded-proto': `${' '.repeat(200_000)}x`,
    };
    const run = timed(() => baseUrl(httpCall(headers), { basePath: '/3d' }));
    expect(run.value).toBe('http://127.0.0.1:8080/3d');
    expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
  });

  it('a request target with long runs of what originForm scans for', () => {
    const run = timed(() => [
      originForm(`http://${'a'.repeat(200_000)}`),
      originForm(`/${'%61'.repeat(70_000)}`),
      originForm(`/${'%%'.repeat(100_000)}`),
      originForm(SLASH_RUN),
    ]);
    expect(run.value).toEqual(['/', `/${'a'.repeat(70_000)}`, `/${'%%'.repeat(100_000)}`, SLASH_RUN]);
    expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
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

/**
 * A raw request with these header lines (name, value, name, value...), as Node gives it: its
 * rawHeaders, and its headers with the values of a repeated name joined by ', ' (an empty line
 * included, so two empty lines read ', ').
 */
function rawLines(url: string, rawHeaders: string[]): IncomingMessage {
  const headers: Record<string, string> = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    headers[name] = name in headers ? `${headers[name]}, ${rawHeaders[i + 1]}` : rawHeaders[i + 1]!;
  }
  return { url, headers, rawHeaders } as unknown as IncomingMessage;
}

describe('the prefix removal (rewriteRequestUrl)', () => {
  it('removes BASE_PATH from the URLs that start with it and remembers the URL as sent', () => {
    const req = rawRequest('/3d/api/config?x=1');
    expect(rewriteRequestUrl(req, '/3d')).toBe('/api/config?x=1');
    expect(requestBaseInfo(req)).toEqual({
      base: '/3d',
      bases: ['/3d'],
      forwarded: false,
      forwardedBase: null,
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

  it("takes the request's base from X-Forwarded-Prefix, and removes nothing from a request that carries it", () => {
    // a proxy that strips the prefix: the path is from the base the header names
    const stripped = rawRequest('/api/config', { 'x-forwarded-prefix': '/editor' });
    expect(rewriteRequestUrl(stripped, '')).toBe('/api/config');
    expect(requestBase(stripped)).toBe('/editor');
    expect(requestBases(stripped)).toEqual(['/editor', '']);
    expect(requestBaseInfo(stripped)).toMatchObject({ forwarded: true, forwardedBase: '/editor' });
    // a header a client sends never re-roots routing: a path under its base stays as it is
    for (const basePath of ['', '/3d']) {
      const sent = rawRequest('/editor/metrics', { 'x-forwarded-prefix': '/editor' });
      expect(rewriteRequestUrl(sent, basePath), basePath).toBe('/editor/metrics');
      expect(requestBaseInfo(sent), basePath).toMatchObject({ base: '/editor', removed: '', bare: false });
      const bare = rawRequest('/editor?a=b', { 'x-forwarded-prefix': '/editor' });
      expect(rewriteRequestUrl(bare, basePath), basePath).toBe('/editor?a=b');
      expect(requestBaseInfo(bare)?.bare, basePath).toBe(false);
    }
    // nor is BASE_PATH removed from it: the proxy that sent it stripped the prefix already, and a
    // path it passed on is never stripped twice (/3d/3d/metrics through it is /3d/metrics here)
    for (const header of ['/editor', '/3d']) {
      const twice = rawRequest('/3d/metrics', { 'x-forwarded-prefix': header });
      expect(rewriteRequestUrl(twice, '/3d'), header).toBe('/3d/metrics');
      expect(requestBaseInfo(twice), header).toMatchObject({ removed: '', bare: false });
    }
    const configured = rawRequest('/3d/api/config', { 'x-forwarded-prefix': '/editor' });
    expect(rewriteRequestUrl(configured, '/3d')).toBe('/3d/api/config');
    expect(requestBaseInfo(configured)).toMatchObject({
      base: '/editor',
      bases: ['/editor', '/3d'],
      forwarded: true,
      removed: '',
    });
    const bareBase = rawRequest('/3d?a=b', { 'x-forwarded-prefix': '/3d' });
    expect(rewriteRequestUrl(bareBase, '/3d')).toBe('/3d?a=b');
    expect(requestBaseInfo(bareBase)?.bare).toBe(false);
  });

  it('counts a header with any value that is not blank, in any of its lines', () => {
    const routed = (raw: string[]) => rewriteRequestUrl(rawLines('/3d/api/config', raw), '/3d');
    // not usable, still carried: nothing removed
    for (const value of ['//evil.example', '/api', 'x', ' /3d ', ',', '/3d, /other'])
      expect(routed(['X-Forwarded-Prefix', value]), value).toBe('/3d/api/config');
    // blank (spaces and tabs only) is no header: BASE_PATH removed
    for (const value of ['', ' ', '\t', ' \t '])
      expect(routed(['X-Forwarded-Prefix', value]), JSON.stringify(value)).toBe('/api/config');
    expect(routed([])).toBe('/api/config');
    // several lines: one that is not blank is enough, whatever the case of its name; two blank
    // lines (which Node joins as ', ') are none
    expect(routed(['X-Forwarded-Prefix', '', 'x-forwarded-prefix', '/3d'])).toBe('/3d/api/config');
    expect(routed(['x-forwarded-prefix', '/3d', 'X-FORWARDED-PREFIX', ''])).toBe('/3d/api/config');
    expect(routed(['X-Forwarded-Prefix', '', 'X-Forwarded-Prefix', ' '])).toBe('/api/config');
    expect(routed(['X-Forwarded-Prefix-Other', '/3d', 'X-Forwarded-Prefi', '/3d'])).toBe('/api/config');
    // a request without raw lines (built by hand) is read from its headers
    expect(carriesForwardedPrefix(rawRequest('/x', { 'x-forwarded-prefix': ['', ' /3d'] }))).toBe(true);
    expect(carriesForwardedPrefix(rawRequest('/x', { 'x-forwarded-prefix': ' ' }))).toBe(false);
  });

  it('names the base the path of a request that carries X-Forwarded-Prefix still starts with', () => {
    const kept = (url: string, header: string, basePath: string) => {
      const req = rawRequest(url, { 'x-forwarded-prefix': header });
      return keptPrefix(req, rewriteRequestUrl(req, basePath), basePath);
    };
    // the header's usable base, else BASE_PATH
    expect(kept('/editor/api/config', '/editor', '')).toBe('/editor');
    expect(kept('/editor?a=b', '/editor', '')).toBe('/editor');
    expect(kept('/editor/x', '/editor', '/3d')).toBe('/editor');
    expect(kept('/3d/x', '/editor', '/3d')).toBe('/3d');
    expect(kept('/3d/x', '/3d', '/3d')).toBe('/3d');
    expect(kept('/3d?a', '/3d', '/3d')).toBe('/3d');
    // an unusable header: BASE_PATH only, never the header's text
    expect(kept('/3d/x', '//evil.example', '/3d')).toBe('/3d');
    expect(kept('//evil.example/x', '//evil.example', '')).toBeNull();
    // a path under neither, one that only looks like it, a request without the header
    expect(kept('/api/config', '/editor', '')).toBeNull();
    expect(kept('/editorial', '/editor', '')).toBeNull();
    expect(kept('/3dx/y', '/editor', '/3d')).toBeNull();
    expect(kept('/x', '/', '')).toBeNull();
    const plain = rawRequest('/3d/x');
    expect(keptPrefix(plain, rewriteRequestUrl(plain, '/3d'), '/3d')).toBeNull();
    expect(keptPrefix(rawRequest('/editor/x'), '/editor/x', '')).toBeNull();
  });

  it('reads the request target in origin form, as the router does', () => {
    const cases: [string, string][] = [
      ['http://x/api/projects?y=1', '/api/projects?y=1'],
      ['HTTPS://Host.example:8080/a', '/a'],
      ['hTtP://host', '/'],
      ['http://host?q=1', '/?q=1'],
      ['http://host/a#f', '/a'],
      ['/a?b=1#c', '/a?b=1'],
      ['/mcp#x', '/mcp'],
      ['/%61pi/%70rojects', '/api/projects'],
      ['/%41%5a%7E%2d%2E%5F', '/AZ~-._'],
      // reserved characters, '%' itself and the query keep their encoding
      ['/a%2Fb%3F%23%25%20', '/a%2Fb%3F%23%25%20'],
      ['/%2561', '/%2561'],
      ['/a?%61=%62', '/a?%61=%62'],
      ['/a%6', '/a%6'],
      ['/%%61', '/%a'],
      // no route serves these: left as they are
      ['*', '*'],
      ['ftp://host/a', 'ftp://host/a'],
      ['%61', '%61'],
    ];
    for (const [target, origin] of cases) expect(originForm(target), target).toBe(origin);
  });

  it('removes BASE_PATH from a target in any of its forms', () => {
    for (const target of [
      '/3d/api/config',
      'http://x/3d/api/config',
      'HTTP://x/3d/%61pi/config',
      '/%33d/api/config',
      '/3d/api/config#f',
    ]) {
      const req = rawRequest(target);
      expect(rewriteRequestUrl(req, '/3d'), target).toBe('/api/config');
      expect(requestBaseInfo(req), target).toMatchObject({ removed: '/3d', originalUrl: target });
    }
    const bare = rawRequest('http://x/3d?y');
    expect(rewriteRequestUrl(bare, '/3d')).toBe('/?y');
    expect(requestBaseInfo(bare)).toMatchObject({ removed: '/3d', bare: true, originalUrl: 'http://x/3d?y' });
    expect(rewriteRequestUrl(rawRequest('http://x/api/config'), '')).toBe('/api/config');
  });

  it('ignores an unusable X-Forwarded-Prefix for the base, and removes nothing from its request', () => {
    for (const header of ['//evil.example', '/api', '/a/../b', 'https://evil.example']) {
      const req = rawRequest('/a/b', { 'x-forwarded-prefix': header });
      expect(rewriteRequestUrl(req, '/3d'), header).toBe('/a/b');
      expect(requestBase(req), header).toBe('/3d');
      expect(requestBaseInfo(req), header).toMatchObject({ forwarded: true, forwardedBase: null });
      const under = rawRequest('/3d/a/b', { 'x-forwarded-prefix': header });
      expect(rewriteRequestUrl(under, '/3d'), header).toBe('/3d/a/b');
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
    for (const host of [
      'example.com/evil',
      'user@example.com',
      'exa mple.com',
      'example.com:99999',
      '?x',
      // characters the URL parser keeps in a host name
      'a"b',
      "a'b",
      'a`b',
      'a{b}',
      'a%41b',
      // not a host and port
      '[::1',
      '[zz]',
      '[::1]x',
      'example.com:0',
      'example.com:',
      'example.com:65536',
      'example.com:+80',
      ':80',
    ])
      expect(baseUrl(httpCall({ 'x-forwarded-host': host }), root), host).toBe('http://127.0.0.1:8080');
    expect(baseUrl(httpCall({ 'x-forwarded-host': '[::1]:8443' }), root)).toBe('http://[::1]:8443');
    expect(baseUrl(httpCall({ 'x-forwarded-host': 'Editor-1.Example.com:65535' }), root)).toBe(
      'http://editor-1.example.com:65535',
    );
    // the Host header is held to the same rule
    expect(baseUrl(extraWith({ headers: { host: 'a"b' } }), root)).toBe('');
    expect(baseUrl(httpCall({ 'x-forwarded-proto': 'ftp' }), root)).toBe('http://127.0.0.1:8080');
    expect(baseUrl(httpCall({ 'x-forwarded-prefix': '//evil.example' }), under3d)).toBe(
      'http://127.0.0.1:8080/3d',
    );
    expect(baseUrl(httpCall({ 'x-forwarded-prefix': '/' }), under3d)).toBe('http://127.0.0.1:8080');
  });

  it('fall back to the Host header, then to the base alone, and are empty without an HTTP request', () => {
    expect(baseUrl(extraWith({ headers: { host: 'editor.local:9000' } }), under3d)).toBe(
      'http://editor.local:9000/3d',
    );
    // an HTTP request without a Host (HTTP/1.0): paths under the base
    expect(baseUrl(extraWith({ headers: {} }), under3d)).toBe('/3d');
    // an in-memory client: links stay paths from the server's root, as REST gives them
    expect(baseUrl(extraWith(), under3d)).toBe('');
  });

  it('take a Docker service name as host (`_`)', () => {
    expect(baseUrl(httpCall({}, 'http://docker_svc:8080/mcp'), under3d)).toBe('http://docker_svc:8080/3d');
    expect(baseUrl(httpCall({}, 'http://editor_1/mcp'), root)).toBe('http://editor_1');
    expect(baseUrl(httpCall({ 'x-forwarded-host': 'my_host.internal:9000' }), under3d)).toBe(
      'http://my_host.internal:9000/3d',
    );
  });

  it('are paths under the base when no host is usable, never paths from the root of the site', () => {
    for (const host of ['a"b', 'a{b}', 'a b', '[::1', 'example.com:0']) {
      // the Host header as the transport gives it, and the URL it built from it where it could
      const calls = [
        extraWith({ headers: { host } }),
        ...(URL.canParse(`http://${host}/mcp`) ? [httpCall({}, `http://${host}/mcp`)] : []),
      ];
      for (const call of calls) {
        expect(baseUrl(call, under3d), host).toBe('/3d');
        expect(baseUrl(call, root), host).toBe('');
      }
      // a usable X-Forwarded-Prefix is the base, whatever BASE_PATH is
      const prefixed = extraWith({ headers: { host, 'x-forwarded-prefix': '/editor' } });
      expect(baseUrl(prefixed, under3d), host).toBe('/editor');
      expect(baseUrl(prefixed, root), host).toBe('/editor');
      // an unusable one is not
      expect(
        baseUrl(extraWith({ headers: { host, 'x-forwarded-prefix': '//evil.example' } }), under3d),
        host,
      ).toBe('/3d');
    }
    // a refused X-Forwarded-Host and a refused Host
    expect(
      baseUrl(
        extraWith({ headers: { host: 'a{b}', 'x-forwarded-host': 'c"d', 'x-forwarded-proto': 'https' } }),
        under3d,
      ),
    ).toBe('/3d');
  });
});

describe('the hosts of MCP links (isHostAndPort)', () => {
  it('are a host name, an IPv4 address or a bracketed IPv6 address, and an optional port', () => {
    for (const host of [
      'example.com',
      'EXAMPLE.com',
      'a-b.c',
      '127.0.0.1',
      '[::1]',
      '[2001:db8::1]:443',
      'x:1',
      // Docker's service names
      'docker_svc',
      'docker_svc:8080',
      'my_host.internal:9000',
    ])
      expect(isHostAndPort(host), host).toBe(true);
    for (const host of [
      '',
      ':80',
      'a b',
      'a:b',
      'a:123456',
      'a:0',
      '[]',
      '[:]',
      '[::1',
      '[::1]:',
      'a]',
      'ä.de',
    ])
      expect(isHostAndPort(host), host).toBe(false);
  });

  it('are read in time linear in their length', () => {
    for (const host of [`${'a'.repeat(200_000)}"`, `[${':'.repeat(200_000)}`, `a:${'1'.repeat(200_000)}`]) {
      const run = timed(() => isHostAndPort(host));
      expect(run.value).toBe(false);
      expect(run.ms).toBeLessThan(LINEAR_BOUND_MS);
    }
  });
});

describe('the project links agents are told to open', () => {
  it('are the editor_url the tools give, never a path from the server root', () => {
    // under a base path, /?project=<id> is the root of another site
    expect(MCP_INSTRUCTIONS).not.toContain('/?project=');
    expect(MCP_INSTRUCTIONS).toContain(
      'a project opens in the web editor at its editor_url (list_projects, create_project and get_project give it)',
    );
  });
});
