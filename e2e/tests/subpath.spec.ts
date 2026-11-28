import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { callJson, mcpConnect, mcpEndSession } from './helpers';

/*
 * The editor and the desk under a path of another site (docs/subpath.md), with the production
 * builds, behind both proxy styles (playwright.config.ts, PORTS and PREFIXES):
 * - /3d on an editor server with BASE_PATH=/3d, opened on its own port: the requests a proxy that
 *   keeps the prefix passes on
 * - /editor behind fixtures/prefix-proxy.mjs, which strips the prefix and sends X-Forwarded-Prefix
 *   to the plain server, as the nginx configuration does
 * For both: the bare prefix is redirected to the prefix with its slash; an unknown API path under
 * the prefix is the server's 404 in JSON, never the editor; the manifest is relative and has no id;
 * the editor's <base href> is the prefix, a project is created, synced live and reloaded under it,
 * an MCP agent gets the project's editor_url under it, the service worker's scope is the prefix and
 * its precache holds only files under it; the desk page at <prefix>/desk and <prefix>/desk.html
 * boots with its headers and registers the same service worker; and every request of the pages,
 * their workers and the service worker stays under the prefix.
 */

interface Setup {
  name: string;
  /** The site's origin. */
  origin: string;
  /** The path the editor is served under. */
  prefix: string;
  /** The prefix in the URLs the editor server sees: kept, or '' when the proxy strips it. */
  serverPrefix: string;
}

const SETUPS: Setup[] = [
  {
    name: 'prefix kept (BASE_PATH=/3d)',
    origin: 'http://127.0.0.1:4182',
    prefix: '/3d',
    serverPrefix: '/3d',
  },
  {
    name: 'prefix stripped by a proxy (X-Forwarded-Prefix: /editor)',
    origin: 'http://127.0.0.1:4183',
    prefix: '/editor',
    serverPrefix: '',
  },
];

/** Whether an http(s) or ws(s) URL is the prefix of `origin` or a path under it. */
function underPrefix(url: string, origin: string, prefix: string): boolean {
  const u = new URL(url);
  const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  return `${scheme}//${u.host}` === origin && (u.pathname === prefix || u.pathname.startsWith(`${prefix}/`));
}

/**
 * Records every URL `context` asks for: the requests of its pages, of their workers and of its
 * service workers, and the pages' WebSockets.
 */
function requestLog(context: BrowserContext) {
  const urls: string[] = [];
  let fromServiceWorker = 0;
  const watch = (page: Page) => page.on('websocket', (ws) => urls.push(ws.url()));
  context.on('request', (request) => {
    urls.push(request.url());
    if (request.serviceWorker()) fromServiceWorker++;
  });
  context.on('page', watch);
  context.pages().forEach(watch);
  const network = () => urls.filter((url) => /^(https?|wss?):/.test(url));
  return {
    /** The http(s) and ws(s) URLs asked for so far. */
    network,
    /** How many requests the service worker made itself. */
    fromServiceWorker: () => fromServiceWorker,
    /** The URLs outside the prefix: other paths of its origin, or other origins. */
    outside: (setup: Setup) => network().filter((url) => !underPrefix(url, setup.origin, setup.prefix)),
  };
}

/** The URLs of everything in the page's Cache Storage (the service worker's precache). */
const cachedUrls = (page: Page) =>
  page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    return urls;
  });

/** The page's <base href> as written, and the document's base URL. */
const pageBase = (page: Page) =>
  page.evaluate(() => [document.querySelector('base')?.getAttribute('href'), document.baseURI]);

for (const setup of SETUPS) {
  const { origin, prefix, serverPrefix } = setup;
  const base = `${origin}${prefix}`;

  test.describe(`under a subpath, ${setup.name}`, () => {
    test('the bare prefix redirects to it with its slash; an unknown API path is a 404 in JSON; the manifest is relative', async () => {
      for (const [path, location] of [
        [prefix, `${prefix}/`],
        [`${prefix}?project=abc`, `${prefix}/?project=abc`],
      ]) {
        const res = await fetch(`${origin}${path}`, { redirect: 'manual' });
        expect(res.status, path).toBe(308);
        expect(new URL(res.headers.get('location') ?? '', `${origin}${path}`).href, path).toBe(
          `${origin}${location}`,
        );
      }
      const missing = await fetch(`${base}/api/no-such-route`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await missing.json()).toEqual({ error: `not found: ${serverPrefix}/api/no-such-route` });
      const manifest = (await (await fetch(`${base}/manifest.webmanifest`)).json()) as {
        start_url: string;
        scope: string;
        icons: { src: string }[];
        file_handlers: { action: string }[];
      };
      expect(manifest).toMatchObject({ start_url: './', scope: './' });
      expect(manifest).not.toHaveProperty('id');
      expect(manifest.file_handlers.map((h) => h.action)).toEqual(['./']);
      for (const icon of manifest.icons) expect(icon.src).toMatch(/^icons\//);
    });

    test('the editor: its <base href>, a project created, synced live and reloaded, its MCP link and the service worker, all under the prefix', async ({
      page,
      context,
    }) => {
      const log = requestLog(context);
      // the bare prefix: the editor at the prefix with its slash
      await page.goto(base);
      await expect(page).toHaveURL(`${base}/`);
      await expect(page.getByTestId('welcome')).toBeVisible();
      expect(await pageBase(page)).toEqual([`${prefix}/`, `${base}/`]);
      expect(
        await page.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel=manifest]')?.href),
      ).toBe(`${base}/manifest.webmanifest`);

      // a new project, its address and its live sync under the prefix
      const syncSocket = page.waitForEvent('websocket', (ws) => ws.url().includes('/sync/'));
      await page.getByTestId('new-project').click();
      await expect(page.getByTestId('viewport')).toBeVisible();
      await page.waitForFunction(() => new URL(location.href).searchParams.has('project'));
      const id = new URL(page.url()).searchParams.get('project')!;
      const projectUrl = `${base}/?project=${id}`;
      expect(page.url()).toBe(projectUrl);
      await expect(page.getByTestId('outliner-Cube')).toBeVisible();
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'connected');
      expect((await syncSocket).url()).toBe(`${base.replace(/^http/, 'ws')}/sync/${id}`);
      // the server has it, and its REST API answers under the prefix
      const listing = (await (await fetch(`${base}/api/projects`)).json()) as { projects: { id: string }[] };
      expect(listing.projects.map((p) => p.id)).toContain(id);

      // an agent on <prefix>/mcp gets this page's address as the project's editor_url
      const client = await mcpConnect(base);
      try {
        const project = await callJson<{ editor_url: string }>(client, 'get_project', { project: id });
        expect(project.editor_url).toBe(projectUrl);
      } finally {
        await mcpEndSession(client);
      }

      // the service worker: <prefix>/sw.js, the prefix its scope
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
      expect(scope).toBe(`${base}/`);
      // reloaded: the same project at the same address, the page now the service worker's
      await page.reload();
      await expect(page.getByTestId('outliner-Cube')).toBeVisible();
      expect(page.url()).toBe(projectUrl);
      await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'connected');
      expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${base}/sw.js`);
      // its precache: the build under the prefix, the pages among it
      const cached = await cachedUrls(page);
      expect(cached.filter((url) => !underPrefix(url, origin, prefix))).toEqual([]);
      for (const file of ['index.html', 'desk.html', 'manifest.webmanifest'])
        expect(
          cached.some((url) => new URL(url).pathname === `${prefix}/${file}`),
          file,
        ).toBe(true);

      // a navigation to an API path under the prefix is the server's, not the editor's page
      const api = await page.goto(`${base}/api/no-such-route`);
      expect(api?.status()).toBe(404);
      expect(await api?.json()).toEqual({ error: `not found: ${serverPrefix}/api/no-such-route` });

      expect(log.fromServiceWorker()).toBeGreaterThan(0);
      expect(log.network().length).toBeGreaterThan(20);
      expect(log.outside(setup)).toEqual([]);
    });

    test('the desk at <prefix>/desk and <prefix>/desk.html: its headers, its <base href> and its service worker, all under the prefix', async ({
      page,
      context,
    }) => {
      const log = requestLog(context);
      for (const path of ['/desk', '/desk.html']) {
        const response = await page.goto(`${base}${path}`);
        expect(response?.status(), path).toBe(200);
        const headers = response!.headers();
        expect(headers['cross-origin-embedder-policy'], path).toBe('require-corp');
        expect(headers['cross-origin-resource-policy'], path).toBe('cross-origin');
        expect(headers['content-security-policy'], path).toBe('frame-ancestors *');
        expect(headers['x-frame-options'], path).toBeUndefined();
        // opened on its own: what it is, its sample, and its link to the editor at the prefix
        await expect(page.getByTestId('desk-standalone')).toBeVisible();
        await expect(page.getByTestId('desk-try-sample')).toBeVisible();
        await expect(page.getByTestId('desk-full-editor')).toHaveAttribute('href', `${prefix}/`);
        expect(await pageBase(page), path).toEqual([`${prefix}/`, `${base}/`]);
      }
      // the desk registers the base's service worker, as the editor does
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
      expect(scope).toBe(`${base}/`);
      expect(log.network().length).toBeGreaterThan(5);
      expect(log.outside(setup)).toEqual([]);
    });
  });
}
