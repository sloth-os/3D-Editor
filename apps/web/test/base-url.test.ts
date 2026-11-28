import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render } from '@testing-library/preact';
import { WebDAVClient } from '@3d-editor/core';
import {
  appBasePath,
  appBaseUrl,
  pageUnderBase,
  pageUnderBaseScript,
  pageUrl,
  serverBaseUrl,
  serverRouteUrl,
  withPageUnderBaseScript,
} from '../src/app/base-url';
import { withBaseHref } from '../../server/src/base-path';
import { apiUrl, fetchServerConfig, serverBase, serverRoute, wsUrl } from '../src/app/server-config';
import { defaultPreferences, prefs, updatePrefs } from '../src/app/prefs';
import { serverConfig } from '../src/app/store';
import { resolveWebDAV } from '../src/storage/webdav';
import {
  listVideoExports,
  searchStore,
  storeFileUrl,
  storeThumbnailUrl,
  videoExportFileUrl,
} from '../src/io/store-client';
import { registerDeskServiceWorker } from '../src/embed/pwa';
import { StandalonePage } from '../src/embed/DeskApp';
import { setupTelemetry } from '../src/telemetry/setup';
import { telemetry } from '../src/telemetry/telemetry';

/*
 * The web app's base URL and the URLs of the editor server's routes (src/app/base-url.ts,
 * server-config.ts; docs/subpath.md "The web app"): the base comes from the document's base URL,
 * the `<base href>` the editor server writes under a subpath, and the server's routes (paths from
 * its root, as the app and the REST answers give them) go under it, or under the Server URL
 * preference with its path, never under the root of the origin. The token rides along as before.
 */

// the desk page's module reaches the editor's PWA registration (virtual:pwa-register, the build's)
vi.mock('../src/pwa/register', () => ({ pwaUpdate: { value: false }, applyPwaUpdate: () => undefined }));

const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

/** The page at `url`, with the `<base href>` the editor server writes (none: a static host). */
function pageAt(url: string, baseHref?: string): void {
  happyDOM.setURL(url);
  for (const base of document.head.querySelectorAll('base')) base.remove();
  if (baseHref === undefined) return;
  const base = document.createElement('base');
  base.setAttribute('href', baseHref);
  document.head.prepend(base);
}

/** The Server URL and access token preferences. */
function preferences(serverUrl: string, token = ''): void {
  updatePrefs((p) => ({ ...p, sync: { ...p.sync, serverUrl, token } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  pageAt('http://localhost:3000/');
  prefs.value = defaultPreferences();
  serverConfig.value = null;
});

describe("the app's base", () => {
  it('is the directory of the document: the root of the origin for the editor at the root', () => {
    pageAt('https://example.com/?project=p1');
    expect(appBaseUrl()).toBe('https://example.com/');
    expect(appBasePath()).toBe('/');
  });

  it("is the editor server's <base href> under a subpath, for every page it serves", () => {
    for (const page of [
      'https://example.com/3d/?project=p1',
      'https://example.com/3d/desk.html',
      'https://example.com/3d/desk',
      // a deeper page path the server answers with the editor's page
      'https://example.com/3d/some/page?x=1',
    ]) {
      pageAt(page, '/3d/');
      expect(appBaseUrl(), page).toBe('https://example.com/3d/');
      expect(appBasePath(), page).toBe('/3d/');
    }
  });

  it("is the page's own folder on a static host, which writes no <base href>", () => {
    for (const page of [
      'https://static.example/folder/',
      'https://static.example/folder/index.html?project=p1',
      'https://static.example/folder/desk.html',
      'https://static.example/folder/desk',
    ]) {
      pageAt(page);
      expect(appBaseUrl(), page).toBe('https://static.example/folder/');
    }
  });

  it('comes from a base URL given where there is no document (a worker): never from its location', () => {
    expect(appBaseUrl('https://example.com/3d/sw.js')).toBe('https://example.com/3d/');
    expect(appBasePath('https://example.com/3d/desk?x')).toBe('/3d/');
    vi.stubGlobal('document', undefined);
    expect(() => appBaseUrl()).toThrow(/a worker has no document/);
    expect(appBaseUrl('https://example.com/3d/')).toBe('https://example.com/3d/');
  });
});

describe('a page opened outside its base', () => {
  /** The editor server with BASE_PATH=/3d on its own port: it writes <base href="/3d/"> at every path. */
  const PORT = 'http://192.168.1.5:8080';
  const BASE = `${PORT}/3d/`;

  it('moves to the same page under its base: the path from the root under the base, query and fragment kept', () => {
    for (const [page, moved] of [
      ['/', '/3d/'],
      ['/?project=abc', '/3d/?project=abc'],
      ['/?project=abc#frag', '/3d/?project=abc#frag'],
      ['/index.html', '/3d/index.html'],
      ['/desk.html?embed=1#x', '/3d/desk.html?embed=1#x'],
      ['/desk', '/3d/desk'],
      ['/desk/', '/3d/desk/'],
      ['/some/page?x=1', '/3d/some/page?x=1'],
      // a look-alike of the base is outside it
      ['/3dx/', '/3d/3dx/'],
      // the base without its slash is the base
      ['/3d', '/3d/'],
      ['/3d?project=abc', '/3d/?project=abc'],
      // a first segment with a colon is a path, not a scheme
      ['/a:b/c', '/3d/a:b/c'],
    ])
      expect(pageUnderBase(`${PORT}${page}`, BASE), page).toBe(`${PORT}${moved}`);
    // a base of more segments, and a base URL with a file name: its directory is the base
    expect(pageUnderBase(`${PORT}/?p=1`, `${PORT}/tools/3d/`)).toBe(`${PORT}/tools/3d/?p=1`);
    expect(pageUnderBase(`${PORT}/desk`, `${PORT}/3d/index.html`)).toBe(`${PORT}/3d/desk`);
    // leading slashes stay a path on the page's own origin
    expect(new URL(pageUnderBase(`${PORT}//evil.example/x`, BASE)!).origin).toBe(PORT);
  });

  it('never moves under its base, at the root, without a <base href> or to another origin', () => {
    for (const [page, baseURI] of [
      // under its base: the server behind a proxy that keeps or strips the prefix
      [`${BASE}`, BASE],
      [`${BASE}?project=abc`, BASE],
      [`${BASE}desk.html?embed=1`, BASE],
      [`${BASE}some/page`, BASE],
      // at the root: <base href="/">
      [`${PORT}/`, `${PORT}/`],
      [`${PORT}/desk.html`, `${PORT}/`],
      [`${PORT}/desk/`, `${PORT}/`],
      [`${PORT}/some/page?x=1`, `${PORT}/`],
      // no <base href>: a static host or the Vite dev server, the base is the page's own directory
      ['https://static.example/folder/', 'https://static.example/folder/'],
      ['https://static.example/folder/desk.html?x', 'https://static.example/folder/desk.html?x'],
      ['https://static.example/folder/x/y', 'https://static.example/folder/x/y'],
      ['http://localhost:5173/desk', 'http://localhost:5173/desk'],
      // a base on another origin is never followed
      [`${PORT}/`, 'https://cdn.example/3d/'],
      [`${PORT}/`, 'http://192.168.1.5:8081/3d/'],
    ])
      expect(pageUnderBase(page, baseURI), `${page} with base ${baseURI}`).toBeNull();
  });

  /** Runs the inline script with this page's address and base URL; what it did, in order. */
  function runScript(href: string, baseURI: string): string[] {
    const did: string[] = [];
    const location = { href, replace: (to: string) => did.push(`replace ${to}`) };
    const window = { stop: () => did.push('stop') };
    new Function('location', 'document', 'window', pageUnderBaseScript())(location, { baseURI }, window);
    return did;
  }

  it("runs pageUnderBase in the page: stops the page's loading, then replaces it with the page under its base", () => {
    expect(runScript(`${PORT}/?project=abc`, BASE)).toEqual(['stop', `replace ${BASE}?project=abc`]);
    expect(runScript(`${PORT}/desk.html?embed=1#x`, BASE)).toEqual([
      'stop',
      `replace ${BASE}desk.html?embed=1#x`,
    ]);
    for (const [href, baseURI] of [
      [`${BASE}?project=abc`, BASE],
      [`${PORT}/`, `${PORT}/`],
      ['https://static.example/folder/x/y', 'https://static.example/folder/x/y'],
    ])
      expect(runScript(href, baseURI), href).toEqual([]);
  });

  /** A page of the app as written, from apps/web. */
  const sourcePage = (name: string) => readFileSync(resolve(__dirname, '..', name), 'utf8');

  it("is in both pages right after <meta charset>, before their scripts and styles, after the server's <base href>", () => {
    for (const name of ['index.html', 'desk.html']) {
      const page = withPageUnderBaseScript(sourcePage(name));
      const head = /<head>([\s\S]*)<\/head>/.exec(page)![1]!;
      const script = `<script>${pageUnderBaseScript()}</script>`;
      expect(head.indexOf(script), name).toBeGreaterThan(head.indexOf('<meta charset="UTF-8" />'));
      expect(head.indexOf(script), name).toBeLessThan(head.search(/<link|<script(?!>\(function)/));
      expect(page.split(script), name).toHaveLength(2);
      // the server writes the base first into the <head>: the script reads it as document.baseURI
      const served = withBaseHref(page, '/3d');
      expect(served.indexOf('<base href="/3d/" />'), name).toBeLessThan(served.indexOf(script));
    }
    expect(() => withPageUnderBaseScript('<html><head><title>x</title></head></html>')).toThrow(
      /no <meta charset>/,
    );
  });
});

describe('the Server URL preference', () => {
  const APP = 'https://example.com/3d/';

  it('unset, leaves the server under the app base', () => {
    expect(serverBaseUrl('', APP)).toBe(APP);
    expect(serverBaseUrl('   ', APP)).toBe(APP);
  });

  it('keeps its path, with a slash, and drops its query and fragment', () => {
    expect(serverBaseUrl('https://editor.example.com', APP)).toBe('https://editor.example.com/');
    expect(serverBaseUrl('https://editor.example.com/', APP)).toBe('https://editor.example.com/');
    expect(serverBaseUrl('https://example.com/3d', APP)).toBe('https://example.com/3d/');
    expect(serverBaseUrl('https://example.com/3d/', APP)).toBe('https://example.com/3d/');
    expect(serverBaseUrl(' https://example.com/tools/3d?x=1#top ', APP)).toBe(
      'https://example.com/tools/3d/',
    );
    // a path alone is on the page's origin
    expect(serverBaseUrl('/other', APP)).toBe('https://example.com/other/');
  });

  it("reads a ws: or wss: URL as its server's, and no other URL", () => {
    expect(serverBaseUrl('wss://example.com/3d', APP)).toBe('https://example.com/3d/');
    expect(serverBaseUrl('ws://127.0.0.1:8080', APP)).toBe('http://127.0.0.1:8080/');
    for (const unusable of ['http://', 'ftp://example.com/3d', 'mailto:me@example.com'])
      expect(serverBaseUrl(unusable, APP), unusable).toBe(APP);
  });
});

describe("a server route's URL", () => {
  const BASE = 'https://example.com/3d/';

  it('is the path from the server root under the base, with its query, never under the origin root', () => {
    expect(serverRouteUrl('/api/config', BASE).href).toBe('https://example.com/3d/api/config');
    expect(serverRouteUrl('/sync/p1', BASE).href).toBe('https://example.com/3d/sync/p1');
    expect(serverRouteUrl('/dav', BASE).href).toBe('https://example.com/3d/dav');
    expect(serverRouteUrl('/api/store/search?query=a%20b&limit=2', BASE).href).toBe(
      'https://example.com/3d/api/store/search?query=a%20b&limit=2',
    );
    expect(serverRouteUrl('api/config', BASE).href).toBe('https://example.com/3d/api/config');
    expect(serverRouteUrl('/api/config', 'https://example.com/').href).toBe('https://example.com/api/config');
  });

  it('stays under the base for paths that climb or look like another host', () => {
    expect(serverRouteUrl('/../x', BASE).href).toBe('https://example.com/3d/x');
    expect(serverRouteUrl('/api/../../x', BASE).href).toBe('https://example.com/3d/x');
    expect(serverRouteUrl('//evil.example/x', BASE).href).toBe('https://example.com/3d/evil.example/x');
    expect(serverRouteUrl('\\\\evil.example\\x', BASE).href).toBe('https://example.com/3d/evil.example/x');
    expect(serverRouteUrl('/https://evil.example/x', BASE).origin).toBe('https://example.com');
  });

  it("is a path on the app's own origin and an absolute URL on another", () => {
    expect(pageUrl(new URL('https://example.com/3d/api/x?y=1'), BASE)).toBe('/3d/api/x?y=1');
    expect(pageUrl(new URL('https://editor.example.com/3d/api/x'), BASE)).toBe(
      'https://editor.example.com/3d/api/x',
    );
  });
});

describe('the app asks the server under its base', () => {
  it('at the root: the same paths as ever, with the token as a query', () => {
    pageAt('https://example.com/?project=p1');
    expect(serverBase()).toBe('https://example.com/');
    expect(serverRoute('/api/config')).toBe('/api/config');
    expect(apiUrl('/api/projects')).toBe('/api/projects');
    preferences('', 'tk n');
    expect(apiUrl('/api/projects')).toBe('/api/projects?token=tk%20n');
    expect(apiUrl('/api/store/search?query=x')).toBe('/api/store/search?query=x&token=tk%20n');
    expect(wsUrl('/sync/p1')).toBe('wss://example.com/sync/p1?token=tk+n');
    pageAt('http://localhost:8080/');
    expect(wsUrl('/sync/p1')).toBe('ws://localhost:8080/sync/p1?token=tk+n');
  });

  it('under a subpath: every route under the base, the live sync with ws(s)', () => {
    pageAt('https://example.com/3d/?project=p1', '/3d/');
    expect(serverBase()).toBe('https://example.com/3d/');
    expect(serverRoute('/api/config')).toBe('/3d/api/config');
    expect(apiUrl('/api/projects/p1')).toBe('/3d/api/projects/p1');
    expect(wsUrl('/sync/p1')).toBe('wss://example.com/3d/sync/p1');
    preferences('', 'tk');
    expect(apiUrl('/api/projects')).toBe('/3d/api/projects?token=tk');
    expect(apiUrl('/otlp').replace(/\?.*$/, '')).toBe('/3d/otlp');
    expect(wsUrl('/sync/p1')).toBe('wss://example.com/3d/sync/p1?token=tk');
    pageAt('http://192.168.1.5:8080/3d/desk', '/3d/');
    expect(wsUrl('/sync/p1')).toBe('ws://192.168.1.5:8080/3d/sync/p1?token=tk');
  });

  it('with a Server URL: under it, with its path for the REST routes and the live sync alike', () => {
    pageAt('https://example.com/?project=p1');
    preferences('https://editor.example.com/3d', 'tk');
    expect(serverBase()).toBe('https://editor.example.com/3d/');
    expect(apiUrl('/api/config')).toBe('https://editor.example.com/3d/api/config?token=tk');
    // the path of the Server URL stays (new URL('/sync/p1', 'https://editor.example.com/3d') drops it)
    expect(wsUrl('/sync/p1')).toBe('wss://editor.example.com/3d/sync/p1?token=tk');
    preferences('http://editor.example.com:8080', 'tk');
    expect(apiUrl('/api/config')).toBe('http://editor.example.com:8080/api/config?token=tk');
    expect(wsUrl('/sync/p1')).toBe('ws://editor.example.com:8080/sync/p1?token=tk');
    // a Server URL on the page's own origin is a path there
    pageAt('https://example.com/3d/', '/3d/');
    preferences('https://example.com/other/');
    expect(serverRoute('/api/config')).toBe('/other/api/config');
  });

  it('fetches the configuration and the REST routes under the base', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/video-exports')
        ? Response.json({ exports: [] })
        : url.includes('/api/store/search')
          ? Response.json({ results: [], providers: [], next_cursor: null })
          : Response.json({ version: '1', features: { sync: true }, webdav: null, persistence: 'memory' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    pageAt('https://example.com/3d/?project=p1', '/3d/');
    preferences('', 'tk');
    expect(await fetchServerConfig()).not.toBeNull();
    await searchStore({ query: 'chair', limit: 3 });
    await listVideoExports('p 1');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/3d/api/config?token=tk',
      '/3d/api/store/search?query=chair&limit=3&token=tk',
      '/3d/api/projects/p%201/video-exports?token=tk',
    ]);
  });

  it('sends browser telemetry under the base', () => {
    const configure = vi.spyOn(telemetry, 'configure').mockImplementation(() => undefined);
    pageAt('https://example.com/3d/', '/3d/');
    preferences('', 'tk');
    setupTelemetry();
    expect(configure.mock.calls[0]![0].endpoint).toBe('/3d/otlp');
    configure.mockRestore();
  });
});

describe("the server's WebDAV proxy", () => {
  /** The server's configuration with its WebDAV proxy at `url` (a path from its root). */
  function serverWithDav(url = '/dav'): void {
    serverConfig.value = {
      version: '1',
      features: { sync: true, mcp: true, telemetry: true, webdavProxy: true },
      webdav: { url, basePath: '/3d-editor' },
      persistence: 'webdav',
    };
  }

  /** The URL of the projects' folder the browser's WebDAV client asks for. */
  const projectsUrl = () => {
    const target = resolveWebDAV()!;
    expect(target.viaServer).toBe(true);
    return (target.store.fs as WebDAVClient).urlFor('/3d-editor/projects');
  };

  it('is the route of /api/config webdav.url under the base', () => {
    serverWithDav();
    pageAt('https://example.com/?project=p1');
    expect(projectsUrl()).toBe('https://example.com/dav/3d-editor/projects');
    pageAt('https://example.com/3d/?project=p1', '/3d/');
    expect(projectsUrl()).toBe('https://example.com/3d/dav/3d-editor/projects');
    // also from a deeper page path the server answered with the editor
    pageAt('https://example.com/3d/some/page', '/3d/');
    expect(projectsUrl()).toBe('https://example.com/3d/dav/3d-editor/projects');
  });

  it('is under the Server URL with its path when one is set', () => {
    serverWithDav();
    pageAt('https://example.com/?project=p1');
    preferences('https://editor.example.com/3d', 'tk');
    expect(projectsUrl()).toBe('https://editor.example.com/3d/dav/3d-editor/projects');
  });
});

describe('the model store and video export links', () => {
  it('are the REST paths under the base, with the token; absolute links stay as they are', () => {
    pageAt('https://example.com/3d/?project=p1', '/3d/');
    preferences('', 'tk');
    expect(
      storeThumbnailUrl({ id: 'builtin:chair', thumbnail_url: '/api/store/models/builtin:chair/thumbnail' }),
    ).toBe('/3d/api/store/models/builtin:chair/thumbnail?token=tk');
    // an MCP result's link already carries the scheme, host and base
    const absolute = 'https://example.com/3d/api/store/models/builtin:chair/thumbnail';
    expect(storeThumbnailUrl({ id: 'builtin:chair', thumbnail_url: absolute })).toBe(absolute);
    expect(storeFileUrl('khronos:Box', 'Box.glb')).toBe(
      '/3d/api/store/models/khronos:Box/files/Box.glb?token=tk',
    );
    expect(videoExportFileUrl({ url: '/api/projects/p/video-exports/a/files/sequence.mp4' })).toBe(
      '/3d/api/projects/p/video-exports/a/files/sequence.mp4?token=tk',
    );
  });

  it('are under the Server URL with its path when one is set', () => {
    pageAt('https://example.com/?project=p1');
    preferences('https://editor.example.com/3d');
    expect(videoExportFileUrl({ url: '/api/projects/p/video-exports/a/files/sequence.mp4' })).toBe(
      'https://editor.example.com/3d/api/projects/p/video-exports/a/files/sequence.mp4',
    );
  });
});

describe("the desk's service worker", () => {
  it("registers the base's sw.js with the base as its scope, the editor's registration", async () => {
    const register = vi.fn(async () => ({}));
    vi.stubEnv('DEV', false);
    Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
    try {
      for (const [page, base] of [
        ['https://desk.example.com/3d/desk.html', 'https://desk.example.com/3d/'],
        ['https://desk.example.com/3d/desk?scene=1', 'https://desk.example.com/3d/'],
        ['https://desk.example.com/desk.html', 'https://desk.example.com/'],
      ] as const) {
        pageAt(page, new URL(base).pathname);
        register.mockClear();
        expect(await registerDeskServiceWorker(), page).toBe(true);
        expect(register, page).toHaveBeenCalledExactlyOnceWith(`${base}sw.js`, {
          scope: base,
          type: 'classic',
        });
      }
    } finally {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      vi.unstubAllEnvs();
    }
  });
});

describe("the desk's own page", () => {
  it('links the full editor of its base, and loads its icon relative to the base', () => {
    for (const [page, baseHref, editor] of [
      ['http://localhost:3000/desk.html', undefined, '/'],
      ['https://desk.example.com/3d/desk', '/3d/', '/3d/'],
      ['https://desk.example.com/3d/desk.html?x=1', '/3d/', '/3d/'],
    ] as const) {
      pageAt(page, baseHref);
      const view = render(h(StandalonePage, { onTry: () => undefined }));
      try {
        expect(view.getByTestId('desk-full-editor').getAttribute('href'), page).toBe(editor);
        expect(view.container.querySelector('img')?.getAttribute('src'), page).toBe('icons/icon.svg');
      } finally {
        view.unmount();
      }
    }
  });
});

describe("the app's Web Workers", () => {
  /**
   * The app's own modules a worker entry imports, from the source tree (packages left out): every
   * module Vite's bundler puts in the worker's chunks, none of them tree-shaken away, with no
   * config of the app's (only its root) and nothing written.
   */
  async function ownModules(entry: string): Promise<string[]> {
    const output = await build({
      configFile: false,
      root: resolve(__dirname, '..'),
      logLevel: 'silent',
      build: {
        write: false,
        rolldownOptions: {
          input: fileURLToPath(new URL(entry, import.meta.url)),
          // a package, not a path: left out ('\0…' is one of Vite's own modules)
          external: (id) => /^[\w@]/.test(id) && !isAbsolute(id),
          treeshake: false,
        },
      },
    });
    const outputs = Array.isArray(output) ? output : [output];
    return outputs.flatMap((o) =>
      'output' in o ? o.output.flatMap((chunk) => (chunk.type === 'chunk' ? chunk.moduleIds : [])) : [],
    );
  }

  it("import neither the app's base nor the server's URLs: a worker has no base of its own", async () => {
    for (const entry of [
      '../src/render/render.worker.ts',
      '../src/export/export.worker.ts',
      '../src/embed/stage.worker.ts',
      '../src/assets/thumbnails/thumbnail.worker.ts',
    ]) {
      const inputs = await ownModules(entry);
      expect(
        inputs.some((i) => i.endsWith(entry.slice(3))),
        entry,
      ).toBe(true);
      for (const module of ['src/app/base-url.ts', 'src/app/server-config.ts', 'src/app/prefs.ts'])
        expect(
          inputs.filter((i) => i.endsWith(module)),
          `${entry} imports ${module}`,
        ).toEqual([]);
    }
  });
});
