import { test, expect, type BrowserContext, type Frame, type Page, type Request } from '@playwright/test';
import { callJson, mcpConnect, mcpEndSession } from './helpers';

/*
 * The editor and the desk under a path of another site (docs/subpath.md), with the production
 * builds, behind both proxy styles (playwright.config.ts, PORTS and PREFIXES):
 * - /3d on an editor server with BASE_PATH=/3d, opened on its own port: the requests a proxy that
 *   keeps the prefix passes on
 * - /editor behind fixtures/prefix-proxy.mjs, which strips the prefix and sends X-Forwarded-Prefix
 *   to the plain server, as the nginx configuration does
 * - /api, one of the server's own paths, behind the same proxy in front of the plain server: the
 *   header's base may be one (BASE_PATH may not), and the editor's own API is then /api/api/…
 * For each: the bare prefix is redirected to the prefix with its slash; an unknown API path under
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
  {
    name: "prefix stripped by a proxy at one of the server's own paths (X-Forwarded-Prefix: /api)",
    origin: 'http://127.0.0.1:4185',
    prefix: '/api',
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

/*
 * A page opened outside its base moves under it before anything of it runs (docs/subpath.md, "The
 * web app"; apps/web/src/app/base-url.ts pageUnderBase): the server with BASE_PATH=/3d writes
 * <base href="/3d/"> into its pages on its own port at / too, where the editor would work online
 * but outside its service worker's scope /3d/. Root deployments, and proxies that serve the base,
 * never move a page.
 */
const OWN_PORT = 'http://127.0.0.1:4182';

/** Whether a request is a navigation of a frame `ofFrame` picks (a new document in it). */
function navigates(request: Request, ofFrame: (frame: Frame) => boolean): boolean {
  try {
    return request.isNavigationRequest() && ofFrame(request.frame());
  } catch {
    return false; // no frame (yet)
  }
}

/**
 * What happens to a page: the documents a frame of it loads (its main frame, or the one `ofFrame`
 * picks), and, by the document they belong to (1 for the first), the requests of the app once it
 * starts (its configuration, the live sync, the service worker's script) and the errors the page's
 * frames log. A document follows a navigation request of the frame: a frame navigation without one
 * stays in the document (the editor's history.replaceState of ?project=), and is no document.
 */
function journey(page: Page, ofFrame = (frame: Frame) => frame === page.mainFrame()) {
  const navigations: string[] = [];
  const started: string[] = [];
  const errors: string[] = [];
  let requested = false;
  page.on('request', (request) => {
    if (navigates(request, ofFrame)) requested = true;
    else if (/\/api\/config|\/sync\/|\/sw\.js/.test(request.url()))
      started.push(`${navigations.length}: ${request.url()}`);
  });
  page.on('framenavigated', (frame) => {
    if (!ofFrame(frame) || !requested) return;
    requested = false;
    navigations.push(frame.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${navigations.length}: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`${navigations.length}: ${error.message}`));
  /** What the first document did: it must have done nothing before it moved. */
  const firstDocument = (list: string[]) => list.filter((entry) => entry.startsWith('1: '));
  return { navigations, started, errors, firstDocument };
}

/** Waits until the page's service worker is `scriptURL` and controls the page. */
const controlledBy = (page: Page, scriptURL: string) =>
  page.waitForFunction((url) => navigator.serviceWorker.controller?.scriptURL === url, scriptURL, {
    timeout: 30_000,
  });

test.describe('a page opened outside its base', () => {
  test("the editor at the BASE_PATH server's own root moves under the base before it starts, into its service worker's scope", async ({
    page,
  }) => {
    const seen = journey(page);
    await page.goto(`${OWN_PORT}/?project=abc`, { waitUntil: 'commit' });
    await page.waitForURL(`${OWN_PORT}/3d/?project=abc`);
    await expect(page.getByTestId('viewport')).toBeVisible();
    expect(seen.navigations).toEqual([`${OWN_PORT}/?project=abc`, `${OWN_PORT}/3d/?project=abc`]);
    // the page at / registered no service worker, fetched no configuration, connected nothing
    expect(seen.firstDocument(seen.started)).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(await pageBase(page)).toEqual(['/3d/', `${OWN_PORT}/3d/`]);
    await controlledBy(page, `${OWN_PORT}/3d/sw.js`);
  });

  test('the desk at /desk.html and /desk of the own port moves under the base, query and fragment kept, and works there', async ({
    browser,
  }) => {
    for (const path of ['/desk.html', '/desk']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const seen = journey(page);
      await page.goto(`${OWN_PORT}${path}?x=1#top`, { waitUntil: 'commit' });
      await page.waitForURL(`${OWN_PORT}/3d${path}?x=1#top`);
      await expect(page.getByTestId('desk-standalone'), path).toBeVisible();
      await expect(page.getByTestId('desk-full-editor'), path).toHaveAttribute('href', '/3d/');
      expect(seen.navigations, path).toEqual([`${OWN_PORT}${path}?x=1#top`, `${OWN_PORT}/3d${path}?x=1#top`]);
      expect(seen.firstDocument(seen.started), path).toEqual([]);
      expect(seen.errors, path).toEqual([]);
      // the desk registers the base's service worker, which takes the page over
      await controlledBy(page, `${OWN_PORT}/3d/sw.js`);
      await context.close();
    }
  });

  test("the desk framed at the own port's /desk.html moves under the base inside its frame and says hello to its host", async ({
    page,
  }) => {
    // the host: a page of another site (localhost against the desk's 127.0.0.1) on the loopback
    // address, as browsers let a page frame loopback addresses only from there
    const HOST_PAGE = 'http://localhost:4180/healthz';
    await page.goto(HOST_PAGE);
    const seen = journey(page, (frame) => frame !== page.mainFrame());
    await page.evaluate((src) => {
      const host = window as unknown as { received: unknown[] };
      host.received = [];
      addEventListener('message', (event) => host.received.push(event.data));
      const frame = document.createElement('iframe');
      frame.src = src;
      document.body.append(frame);
    }, `${OWN_PORT}/desk.html?embed=1`);
    await expect
      .poll(() => page.frames().map((frame) => frame.url()))
      .toContain(`${OWN_PORT}/3d/desk.html?embed=1`);
    await page.waitForFunction(() =>
      (window as unknown as { received: { protocol?: string; type?: string }[] }).received.some(
        (m) => m?.protocol === '3d-desk' && m.type === 'hello',
      ),
    );
    expect(seen.navigations).toEqual([`${OWN_PORT}/desk.html?embed=1`, `${OWN_PORT}/3d/desk.html?embed=1`]);
    expect(seen.firstDocument(seen.started)).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(page.url()).toBe(HOST_PAGE);
  });

  test('root deployments, and proxies that serve the base, never move a page', async ({ browser }) => {
    const context = await browser.newContext();
    for (const url of [
      // the server at the root of its origin: <base href="/">
      'http://127.0.0.1:4180/?project=abc',
      'http://127.0.0.1:4180/desk.html?x=1',
      // behind the stripping proxies (X-Forwarded-Prefix: /editor, and /api, one of the server's own
      // paths) and under BASE_PATH's own prefix
      'http://127.0.0.1:4183/editor/?project=abc',
      'http://127.0.0.1:4183/editor/desk',
      'http://127.0.0.1:4185/api/?project=abc',
      'http://127.0.0.1:4185/api/desk.html',
      `${OWN_PORT}/3d/?project=abc`,
      `${OWN_PORT}/3d/desk.html`,
    ]) {
      const page = await context.newPage();
      const seen = journey(page);
      await page.goto(url);
      await expect(page.getByTestId('viewport').or(page.getByTestId('desk-standalone')), url).toBeVisible();
      expect(seen.navigations, url).toEqual([url]);
      await page.close();
    }
    await context.close();
  });
});

/*
 * The editor at a deeper path of its base (the server answers any path that is not its own with the
 * editor: /desk/, /desk.html/, /x/y) registers the base's service worker as its own (src/pwa/
 * register.ts editorServiceWorker): Workbox resolved the build's relative ./sw.js against the page's
 * address, took the base's worker for another page's and offered an update that was none.
 */
test("the editor at a deeper path of its base registers the base's service worker as its own: no update offered", async ({
  browser,
}) => {
  for (const [url, scriptURL] of [
    ['http://127.0.0.1:4180/desk/', 'http://127.0.0.1:4180/sw.js'],
    ['http://127.0.0.1:4180/x/y', 'http://127.0.0.1:4180/sw.js'],
    [`${OWN_PORT}/3d/desk.html/`, `${OWN_PORT}/3d/sw.js`],
    ['http://127.0.0.1:4183/editor/x/y', 'http://127.0.0.1:4183/editor/sw.js'],
    ['http://127.0.0.1:4185/api/x/y', 'http://127.0.0.1:4185/api/sw.js'],
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.getByTestId('welcome'), url).toBeVisible();
    await controlledBy(page, scriptURL);
    // its worker is activated: the page has had its installed event, and drawn what followed
    await page.evaluate(async () => {
      const worker = (await navigator.serviceWorker.ready).active!;
      if (worker.state !== 'activated')
        await new Promise<void>((resolve) =>
          worker.addEventListener('statechange', () => worker.state === 'activated' && resolve()),
        );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(page.getByRole('button', { name: /Update available/ }), url).toHaveCount(0);
    await context.close();
  }
});
