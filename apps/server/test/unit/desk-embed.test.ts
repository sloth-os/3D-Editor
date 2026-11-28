import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import {
  BAD_PORTS,
  DEFAULT_DESK_EMBED,
  DESK_PAGE_PATHS,
  deskAssetHeaders,
  deskEmbedSettings,
  deskHeadersFor,
  deskPageHeaders,
  isCanonicalPath,
  isDeskPagePath,
  parseDeskEmbedCoep,
  parseDeskEmbedOrigins,
  VITE_SERVER_ROUTES,
  viteDeskRoute,
  type ViteRequest,
} from '../../src/desk-embed';

/*
 * The embeddable desk's headers (desk-embed.ts, docs/embedding.md "Hosting the desk"): what
 * DESK_EMBED_COEP and DESK_EMBED_ORIGINS accept (and refuse, so that nothing ends up in a header
 * that should not), the headers of the desk page and of the built assets, and the configuration.
 */

describe('DESK_EMBED_COEP', () => {
  it('defaults to require-corp and takes credentialless or off', () => {
    expect(parseDeskEmbedCoep(undefined)).toBe('require-corp');
    expect(parseDeskEmbedCoep('')).toBe('require-corp');
    expect(parseDeskEmbedCoep(' Credentialless ')).toBe('credentialless');
    expect(parseDeskEmbedCoep('off')).toBe('off');
    expect(() => parseDeskEmbedCoep('unsafe-none')).toThrow(
      /DESK_EMBED_COEP: expected one of require-corp, credentialless, off/,
    );
  });
});

describe('DESK_EMBED_ORIGINS', () => {
  it('defaults to any site', () => {
    expect(parseDeskEmbedOrigins(undefined)).toEqual(['*']);
    expect(parseDeskEmbedOrigins(' , ')).toEqual(['*']);
  });

  it('takes origins, wildcard subdomains and ports, and the keywords', () => {
    expect(
      parseDeskEmbedOrigins('https://rideo.example.com, http://localhost:5173/,https://*.example.org'),
    ).toEqual(['https://rideo.example.com', 'http://localhost:5173', 'https://*.example.org']);
    expect(parseDeskEmbedOrigins('HTTPS://Rideo.Example.com')).toEqual(['https://rideo.example.com']);
    expect(
      parseDeskEmbedOrigins('https://a.example:*, http://127.0.0.1:8080, https://*.b.example:*'),
    ).toEqual(['https://a.example:*', 'http://127.0.0.1:8080', 'https://*.b.example:*']);
    expect(parseDeskEmbedOrigins('self, https://a.example')).toEqual(["'self'", 'https://a.example']);
    expect(parseDeskEmbedOrigins("'none'")).toEqual(["'none'"]);
    expect(parseDeskEmbedOrigins('https://a.example, *')).toEqual(['*']);
    expect(parseDeskEmbedOrigins('https://a.example, https://a.example')).toEqual(['https://a.example']);
  });

  it('writes each origin as the browser does: a default port dropped, a host in punycode', () => {
    expect(
      parseDeskEmbedOrigins('https://a.example:443, http://b.example:80, https://c.example:8443'),
    ).toEqual(['https://a.example', 'http://b.example', 'https://c.example:8443']);
    expect(parseDeskEmbedOrigins('https://bücher.example')).toEqual(['https://xn--bcher-kva.example']);
    expect(parseDeskEmbedOrigins('http://0x7f.0.0.1:8080')).toEqual(['http://127.0.0.1:8080']);
    expect(parseDeskEmbedOrigins('https://a.example, https://a.example:443/')).toEqual(['https://a.example']);
  });

  it('refuses what would not be an origin in the header', () => {
    for (const bad of [
      'rideo.example.com',
      'https://a.example/path',
      'https://a.example; script-src *',
      "https://a.example'",
      'https://a example',
      'ftp://a.example',
      'https://*',
      'https://a.example:99999',
      'javascript:alert(1)',
    ])
      expect(() => parseDeskEmbedOrigins(bad), bad).toThrow(/DESK_EMBED_ORIGINS/);
    expect(() => parseDeskEmbedOrigins("'none', https://a.example")).toThrow(/'none' cannot be combined/);
  });

  it('refuses, with the reason, values no framing page can match', () => {
    const refusal = (value: string) => {
      try {
        parseDeskEmbedOrigins(value);
      } catch (err) {
        return (err as Error).message;
      }
      return null;
    };
    // hosts the URL parser refuses: no page has such an origin
    for (const bad of ['http://1.2.3.4.5.6', 'http://999.999.999.999', 'https://a.example:*:*'])
      expect(refusal(bad), bad).toMatch(/^Invalid configuration: DESK_EMBED_ORIGINS: '.+' is not an origin/);
    // nor a port above 65535, port 0, which no server listens on, or a port browsers refuse
    for (const bad of [
      'https://a.example:0',
      'https://a.example:00',
      'http://127.0.0.1:0',
      'https://*.a.example:0',
      'https://a.example:65536',
      'https://a.example:1',
      'http://127.0.0.1:6000',
      'https://*.a.example:10080',
      'https://a.example:06667',
    ])
      expect(refusal(bad), bad).toMatch(
        /^Invalid configuration: DESK_EMBED_ORIGINS: '.+' is not an origin: .* a port from 1 to 65535 other than the ports browsers refuse \(Fetch's bad ports, such as 1, 25 or 6000\)$/,
      );
    expect(
      parseDeskEmbedOrigins('https://a.example:2, http://b.example:65535, https://c.example:0443'),
    ).toEqual(['https://a.example:2', 'http://b.example:65535', 'https://c.example']);
    // CSP has no IPv6 sources: browsers drop them from frame-ancestors, valid or not
    for (const bad of [
      'http://[::1]:3000',
      'https://[:::::]',
      'https://[1.2.3.4]',
      'https://[10.0.0.5]:8443',
    ])
      expect(refusal(bad), bad).toMatch(
        /bracketed \(IPv6\) address, which browsers ignore in frame-ancestors/,
      );
    expect(refusal('https://user:pw@a.example')).toMatch(/has a user name or password/);
    for (const bad of ['https://a.example?x=1', 'https://a.example#top', 'https://a.example/desk.html'])
      expect(refusal(bad), bad).toMatch(/has a path, query or fragment/);
    for (const bad of ['https://a_b.example', 'https://a..example', 'https://*.*.example'])
      expect(refusal(bad), bad).toMatch(/its host is not a host name or an IPv4 address/);
    expect(refusal('https://*.10.0.0.1')).toMatch(/puts \*\. before an IP address/);
    expect(refusal('https://a.example:8443:*')).toMatch(/has two ports/);
    expect(refusal('https://a.exa\nmple')).toMatch(/has spaces or control characters/);
  });

  it("refuses the ports browsers refuse to load from (Fetch's bad ports), and only those", async () => {
    // Node's own Fetch refuses each of them before it connects anywhere ('bad port'): the list is
    // Fetch's (port 0 aside, which no server listens on)
    const fetchRefusal = (port: number) =>
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(
        () => 'loaded',
        (err: unknown) => (err as { cause?: { message?: string } }).cause?.message ?? String(err),
      );
    expect(BAD_PORTS.size).toBe(81);
    for (const port of BAD_PORTS) {
      if (port) expect(await fetchRefusal(port), `port ${port}`).toBe('bad port');
      expect(() => parseDeskEmbedOrigins(`https://a.example:${port}`), `port ${port}`).toThrow(
        /is not an origin: .* other than the ports browsers refuse/,
      );
    }
    // 4190 and 6679 are on Fetch's list too, but Chromium loads them: a framing page can have them
    for (const port of [4190, 6679]) expect(await fetchRefusal(port)).toBe('bad port');
    // they and the neighbours of the bad ports are ports like any other
    const taken = [4190, 6679, 2, 8, 10, 24, 26, 5999, 6001, 6664, 6670, 6696, 6698, 10079, 10081];
    for (const port of taken) expect(BAD_PORTS.has(port), `port ${port}`).toBe(false);
    expect(parseDeskEmbedOrigins(taken.map((p) => `https://a.example:${p}`).join(','))).toEqual(
      taken.map((p) => `https://a.example:${p}`),
    );
    // the default ports are no bad ports, and a default port is dropped before the check
    expect(parseDeskEmbedOrigins('http://a.example:80, https://b.example:443, http://c.example:443')).toEqual(
      ['http://a.example', 'https://b.example', 'http://c.example:443'],
    );
  });
});

describe('the headers', () => {
  it('of the desk page: COEP, CORP and who may frame it; never X-Frame-Options', () => {
    expect(deskPageHeaders(DEFAULT_DESK_EMBED)).toEqual({
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'cross-origin',
      'content-security-policy': 'frame-ancestors *',
    });
    const s = deskEmbedSettings({
      DESK_EMBED_COEP: 'credentialless',
      DESK_EMBED_ORIGINS: 'https://a.example,https://b.example',
    });
    expect(deskPageHeaders(s)['content-security-policy']).toBe(
      'frame-ancestors https://a.example https://b.example',
    );
    expect(deskPageHeaders(s)['cross-origin-embedder-policy']).toBe('credentialless');
    const off = deskPageHeaders(deskEmbedSettings({ DESK_EMBED_COEP: 'off' }));
    expect(off).not.toHaveProperty('cross-origin-embedder-policy');
    expect(off['cross-origin-resource-policy']).toBe('cross-origin');
    for (const h of [deskPageHeaders(s), deskAssetHeaders(s)])
      expect(Object.keys(h)).not.toContain('x-frame-options');
  });

  it('by file: the page, the assets, nothing for the rest', () => {
    expect(deskHeadersFor('desk.html', DEFAULT_DESK_EMBED)).toHaveProperty('content-security-policy');
    expect(deskHeadersFor('/desk.html', DEFAULT_DESK_EMBED)).toHaveProperty('content-security-policy');
    expect(deskHeadersFor('assets/desk-abc.js', DEFAULT_DESK_EMBED)).toEqual({
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'cross-origin',
    });
    for (const f of ['index.html', 'sw.js', 'workbox-1.js', 'manifest.webmanifest', 'icons/icon.svg'])
      expect(deskHeadersFor(f, DEFAULT_DESK_EMBED), f).toEqual({});
  });

  it('knows the URL paths of the desk page: desk.html and /desk, nothing else', () => {
    expect(DESK_PAGE_PATHS).toEqual(['/desk.html', '/desk']);
    for (const p of ['/desk.html', '/desk']) expect(isDeskPagePath(p)).toBe(true);
    for (const p of ['/', '/index.html', '/desks', '/desk.htm', '/x/desk', '/desk/', '/desk.html/'])
      expect(isDeskPagePath(p), p).toBe(false);
  });
});

describe("the web app's Vite servers (vite.config.ts)", () => {
  const page = deskPageHeaders(DEFAULT_DESK_EMBED);
  const asset = deskAssetHeaders(DEFAULT_DESK_EMBED);
  const route = (pathname: string, dev: boolean, request: ViteRequest) =>
    viteDeskRoute(pathname, dev, DEFAULT_DESK_EMBED, request);
  /** A page the browser opens: a GET whose Accept names text/html, at a path Vite may not serve. */
  const opens: ViteRequest = { read: true, html: true, servable: false };
  /** A file a page loads (a script, a style, an image, a fetch): a GET that accepts no HTML. */
  const loads: ViteRequest = { read: true, html: false, servable: false };
  /** A request that changes something (POST, PUT, DELETE …): never one Vite may serve. */
  const writes: ViteRequest = { read: false, html: false, servable: false };
  /** The request at a path Vite may serve (in preview, a file of the build). */
  const servable = (request: ViteRequest): ViteRequest => ({ ...request, servable: true });

  it('read a path as the server does: canonical with no empty or dot segment and no backslash once decoded as its static file server decodes it', () => {
    for (const p of [
      '/',
      '/x',
      '/x/',
      '/x/y',
      '/desk.html',
      '/desk/',
      '/.well-known/x',
      '/x/.y',
      '/x/..y',
      '/x/y..',
      // %2F stays as it is there: one segment, a name the file server looks for
      '/x%2f..%2fdesk',
      '/..%2findex.html',
      '/%2fdesk.html',
      // a path that does not decode is read as it is
      '/%E0%A4%A',
    ])
      expect(isCanonicalPath(p), p).toBe(true);
    for (const p of [
      '*',
      'desk.html',
      '//',
      '///',
      '//desk.html',
      '//x/y',
      '/x//y',
      '/x//',
      '/desk//',
      '/desk.html//',
      '/.',
      '/..',
      '/./x',
      '/x/.',
      '/x/./y',
      '/x/..',
      '/x/../y',
      '/%2e/desk.html',
      '/%2E%2E/desk.html',
      '/x/%2e%2e/desk.html',
      '/x\\y',
      '/x%5c..%5cdesk.html',
      '/%E0%A4%A/..',
    ])
      expect(isCanonicalPath(p), p).toBe(false);
  });

  it('answer a path that is not canonical as the server does, wherever it points: 403 for a GET or HEAD, 404 for any other method', () => {
    for (const p of [
      '//desk.html',
      '//desk',
      '/desk.html//',
      '/desk//',
      '/desk.html///',
      '//',
      '/./x',
      '/x/../y',
      '/x/../desk.html',
      '/%2e/desk.html',
      '/x%5c..%5cdesk.html',
      // under the proxied routes, the assets and Vite's modules too (Vite's proxy would send
      // /api/../desk.html to the server as /desk.html)
      '/api/../desk.html',
      '/api//config',
      '/assets/../desk.html',
      '/src/../desk.html',
      '/@fs//home/x/apps/web/desk.html',
    ])
      for (const dev of [true, false]) {
        for (const request of [opens, loads, servable(opens), servable(loads)])
          expect(route(p, dev, request), `${p} dev=${dev}`).toEqual({ headers: {}, forbidden: true });
        expect(route(p, dev, writes), `${p} dev=${dev}`).toEqual({ headers: {}, notFound: true });
      }
  });

  it('give the desk page its headers at /desk.html and /desk (served as desk.html) for a GET or HEAD', () => {
    for (const dev of [true, false])
      for (const request of [opens, loads, servable(opens), servable(loads)]) {
        expect(route('/desk.html', dev, request)).toEqual({ headers: page, rewrite: undefined });
        expect(route('/desk', dev, request)).toEqual({ headers: page, rewrite: '/desk.html' });
      }
  });

  it('answer any other method than GET and HEAD with 404 outside the proxied routes, as the server does (Vite would answer a POST with a page)', () => {
    for (const dev of [true, false])
      for (const p of [
        '/',
        '/x/y',
        '/index.html',
        '/desk.html',
        '/desk',
        '/desk/',
        '/assets/main-1a2b.js',
        '/src/main.tsx',
        '/sw.js',
      ])
        expect(route(p, dev, writes), `${p} dev=${dev}`).toEqual({ headers: {}, notFound: true });
  });

  it('give the asset headers only to the built files (in dev, to its modules), as the server does', () => {
    for (const dev of [true, false])
      for (const request of [servable(loads), servable(opens)])
        expect(route('/assets/desk-1a2b.js', dev, request)).toEqual({ headers: asset });
    for (const p of [
      '/src/embed/stage.worker.ts',
      '/@vite/client',
      '/@fs/home/x/packages/core/src/index.ts',
      '/node_modules/.vite/deps/preact.js',
    ]) {
      expect(route(p, true, servable(loads)), p).toEqual({ headers: asset });
      // in preview no file of the build: never the asset headers, and never a page either
      expect(route(p, false, loads), p).toEqual({ headers: {}, notFound: true });
    }
    // in dev a module path Vite may not serve (an HTML file there, which Vite would serve as a page
    // without its headers): 404, never a page
    for (const request of [opens, loads])
      expect(route('/@fs/home/x/apps/web/desk.html', true, request)).toEqual({
        headers: asset,
        notFound: true,
      });
  });

  it("never give desk headers to the editor's pages, the service worker or the manifest", () => {
    for (const dev of [true, false])
      for (const p of ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/favicon.svg'])
        for (const request of [opens, loads])
          expect(route(p, dev, servable(request)), `${p} dev=${dev}`).toEqual({ headers: {} });
  });

  it("leave the editor server's routes to the proxy, whatever the method: never a page, a 404 or desk headers", () => {
    expect(VITE_SERVER_ROUTES).toEqual(['/api', '/dav', '/otlp', '/mcp', '/sync']);
    // Vite's proxy takes every path that starts with one (/apix too)
    for (const p of [
      '/api',
      '/api/config',
      '/apix',
      '/dav/3d-editor/projects',
      '/otlp/v1/traces',
      '/mcp',
      '/sync/p1',
    ])
      for (const dev of [true, false])
        for (const request of [opens, loads, writes])
          expect(route(p, dev, request), `${p} dev=${dev}`).toEqual({ headers: {} });
  });

  it('serve the editor at /desk/ and /desk.html/ for a GET or HEAD, in dev and preview alike: Vite\'s page or the built one, with <base href="/">', () => {
    for (const p of ['/desk/', '/desk.html/'])
      for (const dev of [true, false])
        for (const request of [opens, loads, servable(opens), servable(loads)])
          expect(route(p, dev, request), `${p} dev=${dev}`).toEqual({ headers: {}, page: 'index.html' });
  });

  it('in dev, leave every other path Vite may serve to it: its own page at deeper paths, its files, the root', () => {
    for (const p of ['/x/y', '/desks/', '/x/desk/', '/desk/x', '/3d/', '/index.html/', '/', '/index.html'])
      for (const request of [opens, loads])
        expect(route(p, true, servable(request)), p).toEqual({ headers: {} });
    expect(route('/', true, opens)).toEqual({ headers: {} });
  });

  it("in dev, answer a path Vite may not serve (it would read it as another path) as one that names no file: the editor's page for a page the browser opens, 404 otherwise", () => {
    for (const p of [
      '/x%2f..%2fdesk',
      '/%2fdesk.html',
      // the desk page once decoded (//desk, /./desk): canonical as read, never servable in dev
      '/%2fdesk',
      '/.%2fdesk',
      '/dist/desk',
      '/dist/desk.html',
      '/%E0%A4%A.html',
    ]) {
      expect(route(p, true, opens), p).toEqual({ headers: {}, page: 'index.html' });
      expect(route(p, true, loads), p).toEqual({ headers: {}, notFound: true });
    }
  });

  it("in preview, serve the editor's page at every page the browser opens at a path that names no built file, as the server's fallback does", () => {
    for (const p of [
      '/x/y',
      '/x/',
      '/desks/',
      '/x/desk/',
      '/desk/x',
      '/3d/',
      '/icons/',
      '/assets',
      '/index.html/',
      '/sw.js/',
      '/missing.js',
      // paths that name no built file once decoded (vite.config.ts isBuiltFile): a folder, a file
      // outside the build, a path that does not decode
      '/icons',
      '/..%2findex.html',
      '/%E0%A4%A',
    ])
      expect(route(p, false, opens), p).toEqual({ headers: {}, page: 'index.html' });
    // the root and the built files are Vite's
    for (const p of ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png'])
      expect(route(p, false, p === '/' ? opens : servable(opens)), p).toEqual({ headers: {} });
  });

  it('in preview, answer a file the build does not have with 404, never with a page', () => {
    // what a page loads at a deeper path: its relative files looked for in the wrong folder
    for (const p of [
      '/x/assets/main-Aq3A8fVw.js',
      '/x/y',
      '/missing.css',
      '/favicon.ico',
      '/icons/missing.png',
      '/icons',
      '/..%2findex.html',
      '/%E0%A4%A',
    ])
      expect(route(p, false, loads), p).toEqual({ headers: {}, notFound: true });
    // under /assets/ also when it is opened as a page: the server's own 404 there
    for (const request of [opens, loads])
      expect(route('/assets/missing-1a2b.js', false, request)).toEqual({ headers: asset, notFound: true });
  });
});

describe('the configuration', () => {
  const load = (env: Record<string, string>) =>
    loadConfig({ PUBLIC_DIR: '/nowhere', ...env }, { exists: () => false });

  it('has the desk defaults', () => {
    expect(load({}).deskEmbed).toEqual({ coep: 'require-corp', frameAncestors: ['*'] });
  });

  it('reads DESK_EMBED_COEP and DESK_EMBED_ORIGINS', () => {
    expect(load({ DESK_EMBED_COEP: 'off', DESK_EMBED_ORIGINS: 'https://rideo.example' }).deskEmbed).toEqual({
      coep: 'off',
      frameAncestors: ['https://rideo.example'],
    });
  });

  it('refuses values it cannot use', () => {
    expect(() => load({ DESK_EMBED_COEP: 'yes' })).toThrow(/Invalid configuration: DESK_EMBED_COEP/);
    expect(() => load({ DESK_EMBED_ORIGINS: 'https://a.example/x' })).toThrow(
      /Invalid configuration: DESK_EMBED_ORIGINS/,
    );
    expect(() => load({ DESK_EMBED_ORIGINS: 'https://a.example, https://[10.0.0.5]:8443' })).toThrow(
      /Invalid configuration: DESK_EMBED_ORIGINS: 'https:\/\/\[10\.0\.0\.5\]:8443' has a bracketed/,
    );
  });
});
