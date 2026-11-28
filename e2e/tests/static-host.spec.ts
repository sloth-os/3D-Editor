import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/*
 * The built web app on a static host without an editor server (docs/subpath.md, "Static hosts";
 * playwright.config.ts: fixtures/static-host.mjs serves apps/web/dist at / and under /folder/ of one
 * origin, files only, and answers anything else with its own 404, as the nginx example of
 * docs/embedding.md does). The service worker answers navigations from its precache only for the
 * editor's page (<scope>, <scope>index.html) and the desk page: a deeper path, which the host does
 * not serve, gets the host's 404 rather than an editor page that would look for its files under
 * that path (a blank page), and both pages still load offline. Two deployments on one origin keep
 * apart: the root's service worker answers no navigation of the one at /folder/ (its pages load
 * from the network and register their own worker), and deletes no precache of it.
 */

const HOST = 'http://127.0.0.1:4184';
const FOLDER = `${HOST}/folder/`;
/** Workbox's precache of a scope (workbox-core cacheNames.precache). */
const precacheOf = (scope: string) => `workbox-precache-v2-${scope}`;

/** Waits until a service worker controls the page (it activated and claimed it). */
const controlled = (page: Page) =>
  page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });

/** Waits until the page's registration's worker is activated: its activate event has finished. */
const activated = (page: Page) =>
  page.evaluate(async () => {
    const worker = (await navigator.serviceWorker.ready).active!;
    if (worker.state === 'activated') return;
    await new Promise<void>((resolve) =>
      worker.addEventListener('statechange', () => worker.state === 'activated' && resolve()),
    );
  });

/** The names in the origin's Cache Storage. */
const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

/**
 * The documents a page's main frame loads, as URLs, in order: a frame navigation that follows no
 * navigation request of the main frame stays in the document (history.replaceState) and is none.
 */
function navigations(page: Page): string[] {
  const urls: string[] = [];
  let requested = false;
  page.on('request', (request) => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) requested = true;
    } catch {
      // no frame (yet)
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || !requested) return;
    requested = false;
    urls.push(frame.url());
  });
  return urls;
}

/** A new page in a new context (its own storage, service workers and caches). */
async function freshPage(browser: import('@playwright/test').Browser): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext();
  return [context, await context.newPage()];
}

test.describe('the web app on a static host', () => {
  test("once its service worker is installed, a deeper path is the host's 404, never a blank editor; the editor and the desk load offline", async ({
    browser,
  }) => {
    const [context, page] = await freshPage(browser);
    const moves = navigations(page);
    await page.goto(FOLDER);
    await expect(page.getByTestId('welcome')).toBeVisible();
    await controlled(page);
    expect(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(`${FOLDER}sw.js`);
    // a static host writes no <base href>: the page never moves anywhere
    expect(moves).toEqual([FOLDER]);

    for (const path of ['x/y', 'x/y?project=abc', 'desk/', 'desk.html/', 'desk.html/x']) {
      const response = await page.goto(`${FOLDER}${path}`);
      expect(response!.status(), path).toBe(404);
      expect(response!.fromServiceWorker(), path).toBe(false);
      await expect(page.locator('body'), path).toHaveText('not found on this static host');
    }

    await context.setOffline(true);
    for (const path of ['', '?project=abc', 'index.html']) {
      const response = await page.goto(`${FOLDER}${path}`);
      expect(response!.fromServiceWorker(), path).toBe(true);
      await expect(page.getByTestId('welcome').or(page.getByTestId('viewport')), path).toBeVisible();
    }
    const desk = await page.goto(`${FOLDER}desk.html`);
    expect(desk!.fromServiceWorker()).toBe(true);
    await expect(page.getByTestId('desk-standalone')).toBeVisible();
    // offline, a deeper path is no page at all: the service worker does not answer it
    await expect(page.goto(`${FOLDER}x/y`)).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/);
    await context.close();
  });

  test("a root deployment's service worker leaves the deployment under /folder/ to the network: it loads its own page and worker", async ({
    browser,
  }) => {
    const [context, page] = await freshPage(browser);
    await page.goto(`${HOST}/`);
    await expect(page.getByTestId('welcome')).toBeVisible();
    await controlled(page);
    expect(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(`${HOST}/sw.js`);

    // the root's worker controls every navigation in its scope until /folder/ has a worker of its
    // own: it answers none of /folder/'s pages
    const response = await page.goto(FOLDER);
    expect(response!.status()).toBe(200);
    expect(response!.fromServiceWorker()).toBe(false);
    await expect(page.getByTestId('welcome')).toBeVisible();
    // the page registers its own worker, which takes it over
    await page.waitForFunction(
      (url) => navigator.serviceWorker.controller?.scriptURL === url,
      `${FOLDER}sw.js`,
      { timeout: 30_000 },
    );
    const scopes = await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope).sort(),
    );
    expect(scopes).toEqual([`${HOST}/`, FOLDER]);
    // the desk page of /folder/ is no page of the root either
    const desk = await page.goto(`${FOLDER}desk.html`);
    expect(desk!.status()).toBe(200);
    await expect(page.getByTestId('desk-standalone')).toBeVisible();
    await context.close();
  });

  test("a root deployment's service worker deletes no precache of the deployment under /folder/, which still loads offline", async ({
    browser,
  }) => {
    const [context, page] = await freshPage(browser);
    // the deployment under /folder/ first: its precache is there when the root's worker activates
    await page.goto(FOLDER);
    await expect(page.getByTestId('welcome')).toBeVisible();
    await controlled(page);
    await activated(page);
    expect(await cacheNames(page)).toContain(precacheOf(FOLDER));

    const root = await context.newPage();
    await root.goto(`${HOST}/`);
    await expect(root.getByTestId('welcome')).toBeVisible();
    await controlled(root);
    // its activation, cleanup of outdated precaches included, is over
    await activated(root);
    const names = await cacheNames(root);
    expect(names).toContain(precacheOf(`${HOST}/`));
    expect(names).toContain(precacheOf(FOLDER));

    await context.setOffline(true);
    await page.goto(FOLDER);
    await expect(page.getByTestId('welcome')).toBeVisible();
    await page.goto(`${FOLDER}desk.html`);
    await expect(page.getByTestId('desk-standalone')).toBeVisible();
    await context.close();
  });
});
