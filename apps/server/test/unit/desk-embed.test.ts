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
  isDeskPagePath,
  parseDeskEmbedCoep,
  parseDeskEmbedOrigins,
  viteDeskRoute,
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

  it('give the desk page its headers at /desk.html and /desk (served as desk.html)', () => {
    for (const dev of [true, false]) {
      expect(viteDeskRoute('/desk.html', dev, DEFAULT_DESK_EMBED)).toEqual({
        headers: page,
        rewrite: undefined,
      });
      expect(viteDeskRoute('/desk', dev, DEFAULT_DESK_EMBED)).toEqual({
        headers: page,
        rewrite: '/desk.html',
      });
    }
  });

  it('give the asset headers only to the built files (in dev, to its modules), as the server does', () => {
    for (const dev of [true, false])
      expect(viteDeskRoute('/assets/desk-1a2b.js', dev, DEFAULT_DESK_EMBED).headers).toEqual(asset);
    for (const p of [
      '/src/embed/stage.worker.ts',
      '/@vite/client',
      '/@fs/home/x/packages/core/src/index.ts',
      '/node_modules/.vite/deps/preact.js',
    ]) {
      expect(viteDeskRoute(p, true, DEFAULT_DESK_EMBED).headers, p).toEqual(asset);
      expect(viteDeskRoute(p, false, DEFAULT_DESK_EMBED).headers, p).toEqual({});
    }
  });

  it("never give desk headers to the editor's pages, the service worker or the manifest", () => {
    for (const dev of [true, false])
      for (const p of [
        '/',
        '/index.html',
        '/sw.js',
        '/manifest.webmanifest',
        '/favicon.svg',
        '/api/config',
        '/x',
      ])
        expect(viteDeskRoute(p, dev, DEFAULT_DESK_EMBED), `${p} dev=${dev}`).toEqual({ headers: {} });
  });

  it('serve the editor at /desk/ and /desk.html/, as the server and the service worker do', () => {
    for (const dev of [true, false])
      for (const p of ['/desk/', '/desk.html/'])
        expect(viteDeskRoute(p, dev, DEFAULT_DESK_EMBED), p).toEqual({ headers: {}, rewrite: '/index.html' });
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
