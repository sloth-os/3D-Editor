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
 * at /desk/ and /desk.html/ and at a path Vite would read as another, in preview also at every
 * other page the browser opens at a path that names no built file), a 404 for a file Vite may not
 * serve, a 403 for a path with an empty or dot segment and a 404 for any other method than GET and
 * HEAD outside the proxied routes, as the server answers them, and everything else left to Vite.
 * desk-embed.test.ts beside the server's tests holds the decisions themselves (viteDeskRoute).
 */

/** The plugin of vite.config.ts with the middleware. */
const plugin = (config.plugins as unknown[])
  .flat(Infinity)
  .find((p): p is Plugin => (p as Plugin | null)?.name === 'desk-embed-headers')!;

/**
 * What the middleware did with one request: the answer it ended and whether it passed the request
 * on, both kept until the request is done with (a request it answers must never reach Vite too).
 */
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
    const outcome: Outcome = { headers: {} };
    const finish = () => setImmediate(() => done(outcome));
    const req = { method, url, originalUrl: url, headers: accept === undefined ? {} : { accept } };
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string | number) => void (outcome.headers[name.toLowerCase()] = value),
      end: (body?: string) => {
        outcome.status = res.statusCode;
        outcome.body = body;
        finish();
      },
    };
    middleware(req as never, res as never, (error?: unknown) => {
      outcome.next = { url: req.url, error };
      finish();
    });
  });
}

/** Chromium's Accept of a page it opens, and of a script a page loads. */
const PAGE = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const FILE = '*/*';

/**
 * Paths with an empty or dot segment, also spelled `%2e` or with a backslash, which the server
 * answers with 403 (a GET or HEAD) or 404, and Vite would read as another path: `//desk.html` as the
 * desk page without its headers, `/api/../desk.html` sent through the proxy as /desk.html.
 */
const NOT_CANONICAL = [
  '//desk.html',
  '//desk.html?embed=1',
  '///desk.html',
  '/desk.html//',
  '/desk//',
  '//',
  '///',
  '/./x',
  '/./desk.html',
  '/x/../y',
  '/x/../desk.html',
  '/%2e/desk.html',
  '/x/%2e%2e/desk.html',
  '/x%5c..%5cdesk.html',
  '/api/../desk.html',
  '/api//config',
  '/assets/../desk.html',
  '/src/../desk.html',
  'http://localhost:4173//desk.html',
];

const root = mkdtempSync(join(tmpdir(), 'vite-config-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// the app's index.html: the page the dev server makes, and in preview a file outside the build
const source = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n</html>\n';
writeFileSync(join(root, 'index.html'), source);

/** Expects the middleware to answer every path of NOT_CANONICAL as the server does. */
async function expectServerAnswersForNotCanonical(middleware: Connect.NextHandleFunction) {
  for (const url of NOT_CANONICAL) {
    for (const [method, accept] of [
      ['GET', PAGE],
      ['GET', FILE],
      ['HEAD', PAGE],
    ] as const) {
      const got = await run(middleware, method, url, accept);
      expect(got, `${method} ${url}`).toMatchObject({
        status: 403,
        body: method === 'HEAD' ? undefined : expect.stringMatching(/^forbidden: /),
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
      expect(got.next, `${method} ${url}`).toBeUndefined();
      expect(got.headers['content-security-policy'], `${method} ${url}`).toBeUndefined();
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const got = await run(middleware, method, url, PAGE);
      expect(got, `${method} ${url}`).toMatchObject({
        status: 404,
        body: expect.stringMatching(/^not found: /),
      });
      expect(got.next, `${method} ${url}`).toBeUndefined();
    }
  }
}

/** Expects any other method than GET and HEAD to get 404 outside the proxied routes, as on the server. */
async function expectServerAnswersForWrites(middleware: Connect.NextHandleFunction) {
  for (const url of ['/', '/x/y', '/index.html', '/desk.html', '/desk', '/desk/', '/assets/main-1a2b.js'])
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const got = await run(middleware, method, url, PAGE);
      expect(got, `${method} ${url}`).toMatchObject({ status: 404, body: `not found: ${url}\n` });
      expect(got.next, `${method} ${url}`).toBeUndefined();
    }
  // the proxied routes take every method
  for (const url of ['/api/projects', '/dav/3d-editor/x.json', '/mcp', '/otlp/v1/traces'])
    expect(await run(middleware, 'POST', url, FILE), url).toMatchObject({ next: { url } });
}

describe("the preview server's middleware", () => {
  // a build: relative URLs, as `npm run build` writes them
  const built =
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <script type="module" src="./assets/main-1a2b.js"></script>\n  </head>\n  <body><div id="app"></div></body>\n</html>\n';
  mkdirSync(join(root, 'dist/assets'), { recursive: true });
  mkdirSync(join(root, 'dist/icons'));
  writeFileSync(join(root, 'dist/index.html'), built);
  writeFileSync(join(root, 'dist/desk.html'), '<!doctype html><title>desk</title>');
  writeFileSync(join(root, 'dist/sw.js'), '// sw');
  writeFileSync(join(root, 'dist/assets/main-1a2b.js'), '// main');
  writeFileSync(join(root, 'dist/icons/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
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

  it('reads a path as naming no built file when it names a folder of the build, a file outside the build once decoded, or does not decode: the page for a page the browser opens, 404 otherwise, never passed on', async () => {
    // /icons is a folder of the build; /..%2findex.html is the index.html beside the build (in
    // root) once its %2F is decoded, as Vite's file server decodes it; /%E0%A4%A does not decode
    for (const url of ['/icons', '/..%2findex.html', '/%E0%A4%A']) {
      const opened = await run(middleware, 'GET', url, PAGE);
      expect(opened, url).toMatchObject({ status: 200, body: page });
      expect(opened.next, url).toBeUndefined();
      const loaded = await run(middleware, 'GET', url, FILE);
      expect(loaded, url).toMatchObject({ status: 404, body: `not found: ${url}\n` });
      expect(loaded.next, url).toBeUndefined();
    }
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
      expect(got.next, url).toBeUndefined();
    }
  });

  it('answers a path with an empty or dot segment as the server does (403, any other method 404), never as the path Vite would read', async () => {
    await expectServerAnswersForNotCanonical(middleware);
  });

  it('answers any other method than GET and HEAD with 404 outside the proxied routes, as the server does', async () => {
    await expectServerAnswersForWrites(middleware);
  });

  it('leaves the built files, the root, the desk and the proxied routes to Vite, with their headers', async () => {
    for (const url of [
      '/',
      '/?project=p1',
      '/index.html',
      '/sw.js',
      '/assets/main-1a2b.js',
      '/icons/icon.svg',
    ])
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
  });

  it('reads the request target as the server does and hands it to Vite in that form: an absolute-form target by its path, percent-encoded letters and digits decoded', async () => {
    const desk = {
      'content-security-policy': 'frame-ancestors *',
      'cross-origin-resource-policy': 'cross-origin',
    };
    // Vite itself serves the editor's page for an absolute-form target of the desk page
    for (const [url, passed] of [
      ['http://localhost:4173/desk.html', '/desk.html'],
      ['http://localhost:4173/desk.html?embed=1', '/desk.html?embed=1'],
      ['http://localhost:4173/desk?embed=1', '/desk.html?embed=1'],
      ['/%64esk', '/desk.html'],
      ['/%64esk.html', '/desk.html'],
      ['/desk%2ehtml', '/desk.html'],
    ])
      expect(await run(middleware, 'GET', url, PAGE), url).toMatchObject({
        next: { url: passed },
        headers: desk,
      });
    for (const [url, passed] of [
      ['http://localhost:4173/', '/'],
      ['http://localhost:4173/sw.js', '/sw.js'],
      ['http://localhost:4173/assets/main-1a2b.js?v=1', '/assets/main-1a2b.js?v=1'],
      ['/%69ndex.html', '/index.html'],
    ])
      expect(await run(middleware, 'GET', url, FILE), url).toMatchObject({ next: { url: passed } });
    expect(await run(middleware, 'GET', 'http://localhost:4173/x/y', PAGE)).toMatchObject({
      status: 200,
      body: page,
    });
  });
});

describe("the dev server's middleware", () => {
  const transformIndexHtml = vi.fn(async (_url: string, html: string) =>
    html.replace('</head>', '<script type="module" src="/@vite/client"></script></head>'),
  );
  let middleware!: Connect.NextHandleFunction;
  (plugin.configureServer as (server: ViteDevServer) => void)({
    middlewares: { use: (fn: Connect.NextHandleFunction) => (middleware = fn) },
    config: { root, build: { outDir: 'dist' } },
    transformIndexHtml,
  } as unknown as ViteDevServer);
  const page = source
    .replace('<head>', '<head>\n    <base href="/" />')
    .replace('</head>', '<script type="module" src="/@vite/client"></script></head>');

  it('answers /desk/ and /desk.html/ with the page Vite makes of index.html and <base href="/">', async () => {
    for (const url of ['/desk/', '/desk.html/?project=p1']) {
      transformIndexHtml.mockClear();
      const got = await run(middleware, 'GET', url, PAGE);
      expect(transformIndexHtml, url).toHaveBeenCalledExactlyOnceWith('/index.html', source, url);
      expect(got, url).toMatchObject({
        status: 200,
        body: page,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    expect(await run(middleware, 'HEAD', '/desk/', FILE)).toMatchObject({ status: 200, body: undefined });
  });

  it('leaves every other path Vite may serve to it: its own page at deeper paths, the desk with its headers, the modules', async () => {
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

  it("leaves Vite's own URLs to it with the asset headers: its client, the modules and workers, the pre-bundled dependencies, the files under /@fs/", async () => {
    for (const url of [
      '/@vite/client',
      '/src/main.tsx',
      '/src/embed/stage.worker.ts?worker_file&type=module',
      '/node_modules/.vite/deps/preact.js?v=1a2b3c4d',
      `/@fs${root}/src/x.ts`,
      '/@id/__x00__virtual:pwa-register',
    ])
      expect(await run(middleware, 'GET', url, FILE), url).toMatchObject({
        next: { url },
        headers: { 'cross-origin-resource-policy': 'cross-origin' },
      });
  });

  it("answers a path Vite would read as another (a decoded %2F, an HTML file other than the app's two pages, a path in the build's folder, one that does not decode) as one that names no file, never passed on", async () => {
    for (const url of [
      '/x%2f..%2fdesk',
      '/%2fdesk.html',
      '/dist/desk',
      '/dist/desk.html',
      '/%E0%A4%A.html',
      '/%E0%A4%A',
    ]) {
      const opened = await run(middleware, 'GET', url, PAGE);
      expect(opened, url).toMatchObject({ status: 200, body: page });
      expect(opened.next, url).toBeUndefined();
      const loaded = await run(middleware, 'GET', url, FILE);
      expect(loaded, url).toMatchObject({ status: 404, body: `not found: ${url}\n` });
      expect(loaded.next, url).toBeUndefined();
    }
    // an HTML file under /@fs/ (Vite would serve it as a page): 404, without the page headers
    for (const accept of [PAGE, FILE]) {
      const got = await run(middleware, 'GET', `/@fs${root}/desk.html`, accept);
      expect(got).toMatchObject({ status: 404, headers: { 'cross-origin-resource-policy': 'cross-origin' } });
      expect(got.headers['content-security-policy']).toBeUndefined();
      expect(got.next).toBeUndefined();
    }
  });

  it('answers a path with an empty or dot segment as the server does (403, any other method 404), never as the path Vite would read', async () => {
    await expectServerAnswersForNotCanonical(middleware);
    for (const url of [`/@fs/${root}/desk.html`, `/@fs${root}/./desk.html`, `/@fs${root}/src/../desk.html`])
      expect(await run(middleware, 'GET', url, PAGE), url).toMatchObject({ status: 403 });
  });

  it('answers any other method than GET and HEAD with 404 outside the proxied routes, as the server does', async () => {
    await expectServerAnswersForWrites(middleware);
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
