// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VITE_SERVER_ROUTES } from '../../server/src/desk-embed';
import config from '../vite.config';

/*
 * The dev and preview servers' middleware of vite.config.ts (deskEmbedHeaders; docs/embedding.md
 * "Development", docs/subpath.md "The web app"), run on requests as connect hands them to it: the
 * editor's page with the root's <base href> where the editor server's fallback answers it (in dev
 * at /desk/ and /desk.html/, in preview also at every other page the browser opens at a path that
 * names no built file), a 404 for a file the build does not have, and everything else left to Vite.
 * desk-embed.test.ts beside the server's tests holds the decisions themselves (viteDeskRoute).
 */

/** The plugin of vite.config.ts with the middleware. */
const plugin = (config.plugins as unknown[])
  .flat(Infinity)
  .find((p): p is Plugin => (p as Plugin | null)?.name === 'desk-embed-headers')!;

/** What the middleware did with one request. */
interface Outcome {
  /** Passed on to Vite (next()), with the request's url as the middleware left it. */
  next?: { url: string; error?: unknown };
  status?: number;
  headers: Record<string, string | number>;
  body?: string;
}

/** Runs the middleware on one request. */
function run(
  middleware: Connect.NextHandleFunction,
  method: string,
  url: string,
  accept?: string,
): Promise<Outcome> {
  return new Promise((done) => {
    const headers: Record<string, string | number> = {};
    const req = { method, url, originalUrl: url, headers: accept === undefined ? {} : { accept } };
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string | number) => void (headers[name.toLowerCase()] = value),
      end: (body?: string) => done({ status: res.statusCode, headers, body }),
    };
    middleware(req as never, res as never, (error?: unknown) =>
      done({ next: { url: req.url, error }, headers }),
    );
  });
}

/** Chromium's Accept of a page it opens, and of a script a page loads. */
const PAGE = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const FILE = '*/*';

const root = mkdtempSync(join(tmpdir(), 'vite-config-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the preview server's middleware", () => {
  // a build: relative URLs, as `npm run build` writes them
  const built =
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <script type="module" src="./assets/main-1a2b.js"></script>\n  </head>\n  <body><div id="app"></div></body>\n</html>\n';
  mkdirSync(join(root, 'dist/assets'), { recursive: true });
  writeFileSync(join(root, 'dist/index.html'), built);
  writeFileSync(join(root, 'dist/desk.html'), '<!doctype html><title>desk</title>');
  writeFileSync(join(root, 'dist/sw.js'), '// sw');
  writeFileSync(join(root, 'dist/assets/main-1a2b.js'), '// main');
  let middleware!: Connect.NextHandleFunction;
  (plugin.configurePreviewServer as (server: PreviewServer) => void)({
    middlewares: { use: (fn: Connect.NextHandleFunction) => (middleware = fn) },
    config: { root, build: { outDir: 'dist' } },
  } as unknown as PreviewServer);
  const page = built.replace('<head>', '<head>\n    <base href="/" />');

  it('answers every page the browser opens at a path that names no built file with the built page and <base href="/">', async () => {
    for (const url of [
      '/x/y',
      '/x/y?project=p1',
      '/desk/',
      '/desk.html/',
      '/desk/x',
      '/icons/',
      '/index.html/',
    ]) {
      const got = await run(middleware, 'GET', url, PAGE);
      expect(got, url).toMatchObject({ status: 200, body: page });
      expect(got.headers, url).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(page),
      });
    }
    // a HEAD: the page's headers without its body
    expect(await run(middleware, 'HEAD', '/x/y', PAGE)).toMatchObject({
      status: 200,
      body: undefined,
      headers: { 'content-length': Buffer.byteLength(page) },
    });
    // /desk/ and /desk.html/ whatever the Accept, as the server answers them
    for (const url of ['/desk/', '/desk.html/'])
      expect(await run(middleware, 'GET', url, FILE), url).toMatchObject({ status: 200, body: page });
  });

  it('answers a file the build does not have with 404, never with a page', async () => {
    for (const [url, accept] of [
      ['/x/assets/main-1a2b.js', FILE],
      ['/x/y', FILE],
      ['/missing.png', 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'],
      ['/assets/missing-1a2b.js', FILE],
      ['/assets/missing-1a2b.js', PAGE],
      ['/x/y', undefined],
    ] as const) {
      const got = await run(middleware, 'GET', url, accept);
      expect(got, url).toMatchObject({ status: 404, body: `not found: ${url}\n` });
      expect(got.headers['content-type'], url).toBe('text/plain; charset=utf-8');
    }
  });

  it('leaves the built files, the root, the desk and the proxied routes to Vite, with their headers', async () => {
    for (const url of ['/', '/?project=p1', '/index.html', '/sw.js', '/assets/main-1a2b.js'])
      for (const accept of [PAGE, FILE])
        expect(await run(middleware, 'GET', url, accept), url).toMatchObject({ next: { url } });
    expect((await run(middleware, 'GET', '/assets/main-1a2b.js', FILE)).headers).toMatchObject({
      'cross-origin-resource-policy': 'cross-origin',
    });
    expect(await run(middleware, 'GET', '/desk.html?embed=1', PAGE)).toMatchObject({
      next: { url: '/desk.html?embed=1' },
      headers: { 'content-security-policy': 'frame-ancestors *' },
    });
    expect(await run(middleware, 'GET', '/desk?embed=1', PAGE)).toMatchObject({
      next: { url: '/desk.html?embed=1' },
    });
    for (const url of ['/api/config', '/sync/p1', '/mcp', '/dav/x', '/otlp/v1/traces'])
      expect(await run(middleware, 'GET', url, PAGE), url).toMatchObject({ next: { url }, headers: {} });
    // a request that changes something is Vite's (its proxy or its 404)
    expect(await run(middleware, 'POST', '/x/y', PAGE)).toMatchObject({ next: { url: '/x/y' } });
  });
});

describe("the dev server's middleware", () => {
  const source = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n</html>\n';
  writeFileSync(join(root, 'index.html'), source);
  const transformIndexHtml = vi.fn(async (_url: string, html: string) =>
    html.replace('</head>', '<script type="module" src="/@vite/client"></script></head>'),
  );
  let middleware!: Connect.NextHandleFunction;
  (plugin.configureServer as (server: ViteDevServer) => void)({
    middlewares: { use: (fn: Connect.NextHandleFunction) => (middleware = fn) },
    config: { root },
    transformIndexHtml,
  } as unknown as ViteDevServer);

  it('answers /desk/ and /desk.html/ with the page Vite makes of index.html and <base href="/">', async () => {
    for (const url of ['/desk/', '/desk.html/?project=p1']) {
      transformIndexHtml.mockClear();
      const got = await run(middleware, 'GET', url, PAGE);
      expect(transformIndexHtml, url).toHaveBeenCalledExactlyOnceWith('/index.html', source, url);
      expect(got, url).toMatchObject({
        status: 200,
        body: source
          .replace('<head>', '<head>\n    <base href="/" />')
          .replace('</head>', '<script type="module" src="/@vite/client"></script></head>'),
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    expect(await run(middleware, 'HEAD', '/desk/', FILE)).toMatchObject({ status: 200, body: undefined });
  });

  it('leaves every other path to Vite: its own page at deeper paths, the desk with its headers, the modules', async () => {
    for (const url of ['/', '/x/y', '/index.html', '/src/main.tsx', '/api/config'])
      expect(await run(middleware, 'GET', url, PAGE), url).toMatchObject({ next: { url } });
    expect(await run(middleware, 'GET', '/desk', PAGE)).toMatchObject({
      next: { url: '/desk.html' },
      headers: { 'content-security-policy': 'frame-ancestors *' },
    });
    expect((await run(middleware, 'GET', '/src/main.tsx', FILE)).headers).toMatchObject({
      'cross-origin-resource-policy': 'cross-origin',
    });
  });

  it('passes an error making the page on to Vite', async () => {
    transformIndexHtml.mockRejectedValueOnce(new Error('broken index.html'));
    const got = await run(middleware, 'GET', '/desk/', PAGE);
    expect((got.next?.error as Error).message).toBe('broken index.html');
  });
});

describe('the proxy', () => {
  it('sends the routes the middleware leaves to it, and no other, to the editor server', () => {
    expect(Object.keys(config.server?.proxy ?? {}).sort()).toEqual([...VITE_SERVER_ROUTES].sort());
  });
});
