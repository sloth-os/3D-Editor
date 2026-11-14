import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import {
  DEFAULT_DESK_EMBED,
  deskAssetHeaders,
  deskEmbedSettings,
  deskHeadersFor,
  deskPageHeaders,
  isDeskPagePath,
  parseDeskEmbedCoep,
  parseDeskEmbedOrigins,
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
    expect(parseDeskEmbedOrigins('https://a.example:*, http://127.0.0.1:8080, http://[::1]:3000')).toEqual([
      'https://a.example:*',
      'http://127.0.0.1:8080',
      'http://[::1]:3000',
    ]);
    expect(parseDeskEmbedOrigins('self, https://a.example')).toEqual(["'self'", 'https://a.example']);
    expect(parseDeskEmbedOrigins("'none'")).toEqual(["'none'"]);
    expect(parseDeskEmbedOrigins('https://a.example, *')).toEqual(['*']);
    expect(parseDeskEmbedOrigins('https://a.example, https://a.example')).toEqual(['https://a.example']);
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

  it('knows the URL paths of the desk page', () => {
    for (const p of ['/desk.html', '/desk', '/desk/']) expect(isDeskPagePath(p)).toBe(true);
    for (const p of ['/', '/index.html', '/desks', '/desk.htm', '/x/desk'])
      expect(isDeskPagePath(p)).toBe(false);
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
  });
});
