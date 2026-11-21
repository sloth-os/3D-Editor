import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { PLAIN, newProject } from './helpers';

/*
 * Thumbnails of the built-in models, made in the browser (docs/model-store.md, "Thumbnails"):
 *  - with no editor server at all (the production build served as static files), the Asset
 *    Browser shows the built-in models with thumbnails that the thumbnail workers render (real,
 *    not blank: a model on a transparent square), never asking a server; after a reload offline
 *    they come from this browser's cache;
 *  - with the editor server, the browser still makes them itself (no request to the server's
 *    thumbnail route), and they are the server's thumbnails byte for byte (the same core code
 *    renders them in the server's render processes and in the browser's workers).
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '../..', 'apps/web/dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};

/** A static file server of the built app (index.html for anything that is not a file); its requests. */
async function serveStatic(): Promise<{ server: Server; base: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      paths.push(path);
      let file = normalize(join(dist, path));
      if (!file.startsWith(dist)) {
        res.writeHead(403).end();
        return;
      }
      const s = await stat(file).catch(() => null);
      if (!s || s.isDirectory()) file = join(dist, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}

const READY = '[data-testid^="asset-thumb-box-builtin:"][data-thumb-state="ready"]';

/** The built-in cards whose thumbnails show, with where they came from. */
async function readyThumbnails(page: Page): Promise<{ id: string; source: string }[]> {
  return page.locator(READY).evaluateAll((els) =>
    els.map((e) => ({
      id: (e as HTMLElement).dataset.testid!.replace('asset-thumb-box-', ''),
      source: (e as HTMLElement).dataset.thumbSource ?? '',
    })),
  );
}

/** How a shown thumbnail looks: its size, corner alpha, share of drawn pixels, shades and contrast. */
async function looks(page: Page, id: string) {
  return page.getByTestId(`asset-thumb-${id}`).evaluate((img: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let drawn = 0;
    let lo = 255;
    let hi = 0;
    const colours = new Set<number>();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      drawn++;
      colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (d[i + 3] < 255) continue;
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lo = Math.min(lo, lum);
      hi = Math.max(hi, lum);
    }
    return {
      width: c.width,
      height: c.height,
      corner: d[3],
      drawn: drawn / (c.width * c.height),
      colours: colours.size,
      contrast: hi - lo,
    };
  });
}

/** The bytes of a shown thumbnail (its blob: URL, read in the page). */
async function thumbnailBytes(page: Page, id: string): Promise<Buffer> {
  const src = await page.getByTestId(`asset-thumb-${id}`).getAttribute('src');
  expect(src, id).toMatch(/^blob:/);
  const b64 = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, src!);
  return Buffer.from(b64, 'base64');
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test.describe('built-in thumbnails made in the browser', () => {
  let server: Server;
  let base: string;
  let paths: string[];
  test.beforeAll(async () => {
    ({ server, base, paths } = await serveStatic());
  });
  test.afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  test('with no server: rendered here, not blank, then shown offline from the cache', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    const id = await newProject(page, base);
    // the service worker precaches the app (the thumbnail worker included): offline later
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active, null, {
      timeout: 30_000,
    });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });

    await page.getByTestId('bottom-tab-assets').click();
    await expect(page.getByTestId('asset-browser')).toBeVisible();
    await expect(page.getByTestId('asset-search')).toHaveAttribute('placeholder', 'Search built-in models');
    // the cards in view get their thumbnails, rendered by this browser's workers
    await expect
      .poll(async () => (await readyThumbnails(page)).length, { timeout: 60_000 })
      .toBeGreaterThan(3);
    const first = await readyThumbnails(page);
    expect(first.every((t) => t.source === 'render')).toBe(true);
    // real thumbnails: a shaded model (lit and shadowed sides: the first cards' models are solid
    // objects, with 70 to 120 colours and a contrast of 70 to 115 out of 255) in the middle of a
    // transparent 256 px square
    for (const t of first.slice(0, 4)) {
      const l = await looks(page, t.id);
      expect([l.width, l.height], t.id).toEqual([256, 256]);
      expect(l.corner, t.id).toBe(0);
      expect(l.drawn, t.id).toBeGreaterThan(0.01);
      expect(l.drawn, t.id).toBeLessThan(0.95);
      expect(l.colours, t.id).toBeGreaterThan(20);
      expect(l.contrast, t.id).toBeGreaterThan(40);
    }
    const before = new Map<string, string>();
    for (const t of first.slice(0, 4)) before.set(t.id, sha256(await thumbnailBytes(page, t.id)));
    // no server was asked for a thumbnail (there is none: only the app's files were fetched)
    expect(paths.filter((p) => /thumbnail/.test(p) && !/thumbnail\.worker-/.test(p))).toEqual([]);
    expect(paths.some((p) => /\/assets\/thumbnail\.worker-[\w-]+\.js$/.test(p))).toBe(true);

    // offline: the app from the service worker, the project from IndexedDB, the thumbnails from
    // this browser's cache (no render)
    await context.setOffline(true);
    await page.goto(`${base}/?project=${id}`);
    await expect(page.getByTestId('viewport')).toBeVisible();
    await page.getByTestId('bottom-tab-assets').click();
    await expect
      .poll(async () => (await readyThumbnails(page)).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(first.length);
    const again = await readyThumbnails(page);
    expect(again.every((t) => t.source === 'cache')).toBe(true);
    for (const [model, digest] of before)
      expect(sha256(await thumbnailBytes(page, model)), model).toBe(digest);
    await context.close();
  });
});

test.describe('built-in thumbnails with the editor server', () => {
  test("are made in the browser, never asked of the server, and are the server's PNGs byte for byte", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const asked: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/store\/models\/[^/]+\/thumbnail/.test(r.url())) asked.push(r.url());
    });
    await newProject(page, PLAIN);
    await page.getByTestId('bottom-tab-assets').click();
    await page.getByTestId('asset-provider').selectOption('builtin');
    await expect
      .poll(async () => (await readyThumbnails(page)).length, { timeout: 60_000 })
      .toBeGreaterThan(3);
    const shown = (await readyThumbnails(page)).slice(0, 5);
    expect(shown.every((t) => t.source === 'render' || t.source === 'cache')).toBe(true);
    expect(asked).toEqual([]);
    // the server's own thumbnails of the same models (rendered by its render processes)
    for (const t of shown) {
      const res = await fetch(`${PLAIN}/api/store/models/${t.id}/thumbnail`);
      expect(res.status, t.id).toBe(200);
      const server = Buffer.from(await res.arrayBuffer());
      const browser = await thumbnailBytes(page, t.id);
      expect(sha256(browser), t.id).toBe(sha256(server));
    }
  });
});
