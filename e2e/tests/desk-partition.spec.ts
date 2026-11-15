import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { PLAIN } from './helpers';

/*
 * The embeddable desk under third-party storage partitioning, as browsers run it (this spec's
 * Playwright project turns Chromium's partitioning on: playwright.config.ts; docs/embedding.md,
 * "Secure contexts and storage", "Headers" and "Offline"). The host is the fake host
 * (e2e/fixtures/desk-host), cross-origin isolated, at localhost: another site than the desk's
 * 127.0.0.1.
 * - partitioning is on: the framed desk sees none of its origin's first-party storage, and the
 *   first-party service worker does not answer the framed page
 * - the framed desk registers its own service worker in the host's partition, which then loads it
 *   offline and serves its workers: staging and an export with no network
 * - the server's frame-ancestors reach a browser whose service worker holds the desk: a host taken
 *   off DESK_EMBED_ORIGINS can no longer frame it, online at once and offline after, and framing
 *   works again once the host is listed again
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const HOST_PAGE = readFileSync(resolve(here, '../fixtures/desk-host/index.html'));
const OPEN = JSON.parse(
  readFileSync(resolve(root, 'apps/web/test/fixtures/desk-protocol/open.json'), 'utf8'),
);
const DESK_URL = `${PLAIN}/desk.html`;

/** The contract's example brief, small and short: two shots of 12 frames at 320 × 180. */
function smallBrief(id: string) {
  const b = structuredClone(OPEN.scene);
  b.id = id;
  b.width = 320;
  b.height = 180;
  b.shots[0].durationSec = 0.5;
  b.shots[1].durationSec = 0.5;
  return b;
}

// ---------------------------------------------------------------- the host (another site)

let hostServer: Server;
let hostBase: string;

test.beforeAll(async () => {
  hostServer = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(HOST_PAGE);
  });
  await new Promise<void>((r) => hostServer.listen(0, '127.0.0.1', r));
  hostBase = `http://localhost:${(hostServer.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((r) => hostServer.close(r));
});

const hostUrl = (deskUrl: string) => `${hostBase}/?desk=${encodeURIComponent(deskUrl)}`;

/** The messages of `type` the desk sent on the connected port. */
const sent = (page: Page, type: string): Promise<any[]> =>
  page.evaluate(
    (t) =>
      (window as any).host
        .messages()
        .filter((r: any) => !r.bad && !r.sibling && !r.extra && r.message?.type === t)
        .map((r: any) => r.message),
    type,
  );

async function waitFor(page: Page, type: string, count = 1, timeout = 60_000): Promise<any[]> {
  await expect.poll(async () => (await sent(page, type)).length, { timeout }).toBeGreaterThanOrEqual(count);
  return sent(page, type);
}

const send = (page: Page, message: unknown) => page.evaluate((m) => (window as any).host.send(m), message);
const remount = (page: Page) => page.evaluate(() => (window as any).host.mount());

/** The desk's frame, once it has navigated to `deskUrl`. */
async function deskFrame(page: Page, deskUrl: string): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(deskUrl)), { timeout: 30_000 })
    .toBe(true);
  return page.frames().find((f) => f.url().startsWith(deskUrl))!;
}

/** Waits until the desk's page is controlled by its service worker (installed on this visit). */
async function controlled(frame: Frame): Promise<void> {
  await frame.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60_000 });
}

/**
 * Remounts the desk and waits until the browser refused to frame it for its frame-ancestors (it
 * logs the violation and shows its error page in the frame): no new `ready` comes.
 */
async function remountRefused(page: Page, deskOrigin: string): Promise<void> {
  const ready = (await sent(page, 'ready')).length;
  const violation = page.waitForEvent('console', {
    predicate: (m) =>
      m.text().includes(`Framing '${deskOrigin}/' violates`) && m.text().includes('frame-ancestors'),
    timeout: 30_000,
  });
  await remount(page);
  await violation;
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith('chrome-error://')), { timeout: 15_000 })
    .toBe(true);
  // the page that would answer was refused: nothing more comes from the desk
  await page.waitForTimeout(1500);
  expect((await sent(page, 'ready')).length).toBe(ready);
}

// ---------------------------------------------------------------- a server of the spec's own

const SERVER_MAIN = resolve(root, 'apps/server/dist/main.js');

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * The production server on `port` with `env` (DESK_EMBED_ORIGINS and the like): the desk's origin
 * stays the same across restarts, so the browser's partition and service worker stay too.
 */
async function startServer(port: number, env: Record<string, string>) {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'e2e-desk-partition-'));
  const proc: ChildProcess = spawn(process.execPath, [SERVER_MAIN], {
    env: {
      ...process.env,
      PUBLIC_DIR: resolve(root, 'apps/web/dist'),
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'error',
      SYNC_PERSISTENCE: 'memory',
      DATA_DIR: dataDir,
      SHUTDOWN_TIMEOUT_SECONDS: '2',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise((r) => proc.once('exit', r));
  await expect
    .poll(
      async () => {
        if (proc.exitCode !== null) throw new Error(`the server exited with ${proc.exitCode}`);
        return fetch(`http://127.0.0.1:${port}/healthz`).then(
          (r) => r.ok,
          () => false,
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return {
    async stop() {
      if (proc.exitCode === null) proc.kill('SIGTERM');
      await exited;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- the tests

test.describe('the desk under storage partitioning', () => {
  let context: BrowserContext;

  test.beforeEach(async ({ browser }) => {
    context = await browser.newContext();
    // whether a page (any frame) was controlled by a service worker when it started
    await context.addInitScript(() => {
      (window as any).__e2eControlledAtStart = !!navigator.serviceWorker?.controller;
    });
  });

  test.afterEach(async () => {
    await context.setOffline(false).catch(() => {});
    await context.close();
  });

  test("partitioning is on: the framed desk sees none of its origin's first-party storage", async () => {
    test.setTimeout(120_000);
    // first party: the desk opened on its own, with its service worker and a value in its storage
    const own = await context.newPage();
    await own.goto(DESK_URL);
    await expect(own.getByTestId('desk-standalone')).toBeVisible();
    await own.evaluate(() => localStorage.setItem('e2e-partition', 'first-party'));
    await own.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active, null, {
      timeout: 60_000,
    });
    await own.reload();
    expect(await own.evaluate(() => (window as any).__e2eControlledAtStart)).toBe(true);

    // framed by a host on another site: a storage partition of its own
    const page = await context.newPage();
    await page.goto(hostUrl(DESK_URL));
    await waitFor(page, 'ready');
    const frame = await deskFrame(page, DESK_URL);
    expect(await frame.evaluate(() => localStorage.getItem('e2e-partition'))).toBeNull();
    expect(await frame.evaluate(() => (window as any).__e2eControlledAtStart)).toBe(false);
  });

  test('a host on another site: the desk registers its service worker there and works offline', async () => {
    test.setTimeout(300_000);
    const page = await context.newPage();
    await page.goto(hostUrl(DESK_URL));
    const [ready] = await waitFor(page, 'ready');
    expect(ready.capabilities.offline).toBe(true);
    const frame = await deskFrame(page, DESK_URL);
    await controlled(frame);
    expect(await frame.evaluate(async () => (await caches.keys()).length)).toBeGreaterThan(0);
    // the registration and its caches are the host partition's: the desk's origin on its own has none
    const own = await context.newPage();
    await own.goto(`${PLAIN}/healthz`);
    expect(await own.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    expect(await own.evaluate(async () => (await caches.keys()).length)).toBe(0);
    await own.close();

    await context.setOffline(true);
    // framed again with no network: the page, its scripts and its workers from that service worker
    await remount(page);
    const readies = await waitFor(page, 'ready', 2, 60_000);
    expect(readies[1].capabilities.export.available).toBe(true);
    await send(page, { type: 'open', scene: smallBrief('clp_partition000001'), state: null });
    const [opened] = await waitFor(page, 'opened', 1, 120_000);
    expect(opened.source).toBe('brief');
    await send(page, { type: 'export', id: 'part-1' });
    const [result] = await waitFor(page, 'result', 1, 180_000);
    expect(result.shots.map((s: any) => s.frames)).toEqual([12, 12]);
    expect(await sent(page, 'error')).toEqual([]);
  });

  test('DESK_EMBED_ORIGINS changed on the server reaches a browser whose service worker holds the desk', async () => {
    test.setTimeout(240_000);
    const port = await freePort();
    const deskOrigin = `http://127.0.0.1:${port}`;
    const deskUrl = `${deskOrigin}/desk.html`;
    let server = await startServer(port, {});
    try {
      // any site may frame the desk (the default): the host frames it, its service worker installs
      const page = await context.newPage();
      await page.goto(hostUrl(deskUrl));
      await waitFor(page, 'ready');
      await controlled(await deskFrame(page, deskUrl));

      // the desk is taken off the host: online, the browser has the server's frame-ancestors at once
      await server.stop();
      server = await startServer(port, { DESK_EMBED_ORIGINS: "'self'" });
      await remountRefused(page, deskOrigin);
      // offline, the copy in the service worker keeps the headers it was last served with
      await context.setOffline(true);
      await remountRefused(page, deskOrigin);
      await context.setOffline(false);

      // the host is listed again: it frames the desk, online and then offline
      await server.stop();
      server = await startServer(port, { DESK_EMBED_ORIGINS: hostBase });
      const before = (await sent(page, 'ready')).length;
      await remount(page);
      await waitFor(page, 'ready', before + 1);
      await context.setOffline(true);
      await remount(page);
      await waitFor(page, 'ready', before + 2);
    } finally {
      await server.stop();
    }
  });
});
