import { randomBytes } from 'node:crypto';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebDAVClient, newUuid } from '@3d-editor/core';
import { api, eventually, makeTempDir, sleep, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';
import { mkcolPath, startWebDAV, type TestWebDAV } from '../helpers/webdav';

/*
 * Serving under a subpath (docs/subpath.md): a server with BASE_PATH=/3d (a proxy that keeps the
 * prefix, and the server's own port without it) and one without BASE_PATH behind a proxy that
 * strips the prefix and sends X-Forwarded-Prefix. The pages are written with the request's
 * <base href>, BASE_PATH without its slash is redirected, the API, the live sync, MCP and the
 * WebDAV proxy answer under the prefix and without it, and links and hrefs carry the base. Only
 * BASE_PATH is removed from request paths: an X-Forwarded-Prefix (which clients can send) never
 * moves a route. AUTH_TOKEN guards the routes whatever the spelling of the request target, and
 * headers of any length take the server linear time.
 */

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <script type="module" crossorigin src="./assets/app.js"></script>
    <title>3D Editor</title>
  </head>
  <body><div id="app"></div></body>
</html>
`;
const DESK_HTML = INDEX_HTML.replace('<html lang="en">', '<html lang="en" data-runtime="desk">').replace(
  '<title>3D Editor</title>',
  "<title>3D director's desk</title>",
);

interface LogLine {
  level?: number;
  msg?: string;
  url?: string;
  route?: string;
  statusCode?: number;
  prefix?: string;
}

let publicDir: string;
/** BASE_PATH=/3d, its access and upgrade lines in `lines`. */
let based: TestServer;
/** No BASE_PATH (a proxy that strips the prefix sends X-Forwarded-Prefix). */
let root: TestServer;
const lines: LogLine[] = [];
const servers: TestServer[] = [];

async function serve(env: Record<string, string>, opts: Parameters<typeof startServer>[1] = {}) {
  const s = await startServer(env, opts);
  servers.push(s);
  return s;
}

beforeAll(async () => {
  publicDir = await makeTempDir('3d-editor-subpath-public-');
  await mkdir(path.join(publicDir, 'assets'));
  await writeFile(path.join(publicDir, 'index.html'), INDEX_HTML);
  await writeFile(path.join(publicDir, 'desk.html'), DESK_HTML);
  await writeFile(path.join(publicDir, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(path.join(publicDir, 'sw.js'), 'self.addEventListener("fetch", () => {})');
  await writeFile(path.join(publicDir, 'manifest.webmanifest'), '{"name":"3D Editor","start_url":"./"}');
  based = await serve(
    { PUBLIC_DIR: publicDir, BASE_PATH: '/3d/' },
    {
      logger: {
        level: 'debug',
        stream: { write: (line: string) => void lines.push(JSON.parse(line) as LogLine) },
      },
    },
  );
  root = await serve({ PUBLIC_DIR: publicDir, CORS_ORIGINS: 'https://app.example.com' });
});

afterAll(async () => {
  for (const s of servers) {
    await s.close();
    await s.cleanup();
  }
  await rm(publicDir, { recursive: true, force: true });
});

/** The access line of a request, by the URL as the client sent it. */
const accessLine = (url: string) =>
  eventually(() => lines.find((l) => l.msg === 'request completed' && l.url === url), 5000, `log of ${url}`);

/** Checks a page's headers and returns its HTML. */
async function page(res: Response, what: string): Promise<string> {
  expect(res.status, what).toBe(200);
  expect(res.headers.get('content-type'), what).toBe('text/html; charset=utf-8');
  expect(res.headers.get('cache-control'), what).toBe('no-cache');
  expect(res.headers.get('vary'), what).toMatch(/\bX-Forwarded-Prefix\b/i);
  expect(res.headers.get('etag'), what).toMatch(/^"[\w-]+"$/);
  expect(res.headers.get('x-frame-options'), what).toBeNull();
  return res.text();
}

/** The page's HTML is the build's with a <base href> as the first element of its <head>. */
function expectBase(html: string, href: string, source: string, what: string): void {
  expect(html, what).toBe(source.replace('<head>', `<head>\n    <base href="${href}" />`));
}

describe('a server with BASE_PATH=/3d', () => {
  it('writes the editor page with <base href="/3d/"> under the prefix and without it', async () => {
    const paths = [
      '/3d/',
      '/3d/index.html',
      '/3d/projects/abc?project=1',
      // another spelling of index.html is no way to the build's file
      '/3d/%69ndex.html',
      // /desk/ and /desk.html/ are the editor's, as any other path
      '/3d/desk/',
      '/3d/desk.html/',
      '/',
      '/index.html',
      '/projects/abc',
    ];
    for (const p of paths) {
      const res = await fetch(`${based.url}${p}`);
      expectBase(await page(res, p), '/3d/', INDEX_HTML, p);
      expect(res.headers.get('content-security-policy'), p).toBeNull();
      expect(res.headers.get('cross-origin-embedder-policy'), p).toBeNull();
    }
  });

  it('writes the desk page with <base href="/3d/"> and its embedding headers', async () => {
    for (const p of ['/3d/desk', '/3d/desk.html', '/3d/desk?scene=1', '/desk', '/desk.html']) {
      const res = await fetch(`${based.url}${p}`);
      expectBase(await page(res, p), '/3d/', DESK_HTML, p);
      expect(res.headers.get('cross-origin-embedder-policy'), p).toBe('require-corp');
      expect(res.headers.get('cross-origin-resource-policy'), p).toBe('cross-origin');
      expect(res.headers.get('content-security-policy'), p).toBe('frame-ancestors *');
    }
  });

  it('redirects the base without its slash to /3d/ (308), query kept', async () => {
    for (const [p, location] of [
      ['/3d', '/3d/'],
      ['/3d?x=1', '/3d/?x=1'],
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await fetch(`${based.url}${p}`, { method, redirect: 'manual' });
        expect(res.status, `${method} ${p}`).toBe(308);
        expect(res.headers.get('location'), p).toBe(location);
        // the redirect is BASE_PATH's: it depends on the URL alone
        expect(res.headers.get('vary'), p).toBeNull();
      }
      const proxied = await fetch(`${based.url}${p}`, {
        headers: { 'x-forwarded-prefix': '/editor' },
        redirect: 'manual',
      });
      expect(proxied.status, p).toBe(308);
      expect(proxied.headers.get('location'), p).toBe(location);
    }
    // logged and counted like every other request, with the URL as sent
    expect(await accessLine('/3d?x=1')).toMatchObject({ statusCode: 308 });
    // only the base itself: other paths that start with its name are no base
    expect((await fetch(`${based.url}/3dx`, { redirect: 'manual' })).status).toBe(200);
  });

  it('serves the built files with their cache headers, under the prefix and without it', async () => {
    for (const p of ['/3d/assets/app.js', '/assets/app.js']) {
      const res = await fetch(`${based.url}${p}`);
      expect(res.status, p).toBe(200);
      expect(await res.text()).toBe('console.log(1)');
      expect(res.headers.get('cache-control'), p).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('cross-origin-embedder-policy'), p).toBe('require-corp');
      expect(res.headers.get('cross-origin-resource-policy'), p).toBe('cross-origin');
    }
    for (const p of ['/3d/sw.js', '/sw.js', '/3d/manifest.webmanifest']) {
      const res = await fetch(`${based.url}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('cache-control'), p).toBe('no-cache');
      expect(res.headers.get('content-type'), p).not.toMatch(/text\/html/);
    }
    const missing = await api(based.url, '/3d/assets/missing.js');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not found: /3d/assets/missing.js' });
  });

  it('answers the API and the health checks under the prefix and without it', async () => {
    const config = await api(based.url, '/3d/api/config');
    expect(config.status).toBe(200);
    // REST gives the server's routes as paths from its root, the same under every prefix
    expect(config.body.webdav).toBeNull();
    expect((await api(based.url, '/3d/healthz')).status).toBe(200);
    expect((await api(based.url, '/healthz')).status).toBe(200);
    const nothing = await api(based.url, '/3d/api/nothing');
    expect(nothing.status).toBe(404);
    expect(nothing.headers.get('content-type')).toMatch(/application\/json/);
    expect(nothing.body).toEqual({ error: 'not found: /3d/api/nothing' });
    // the access line gives the URL as sent, the route its pattern
    expect(await accessLine('/3d/api/config')).toMatchObject({ route: '/api/config', statusCode: 200 });
    expect(await accessLine('/3d/api/nothing')).toMatchObject({ statusCode: 404 });
  });

  it('answers HEAD of a page with the headers of its GET and no body', async () => {
    const get = await fetch(`${based.url}/3d/`);
    const body = await get.text();
    const head = await fetch(`${based.url}/3d/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(head.headers.get('cache-control')).toBe('no-cache');
    expect(head.headers.get('etag')).toBe(get.headers.get('etag'));
    expect(Number(head.headers.get('content-length'))).toBe(Buffer.byteLength(body));
    expect(await head.text()).toBe('');
    const desk = await fetch(`${based.url}/3d/desk`, { method: 'HEAD' });
    expect(desk.status).toBe(200);
    expect(desk.headers.get('content-security-policy')).toBe('frame-ancestors *');
  });

  it('revalidates a page by its ETag, which depends on the base', async () => {
    const first = await fetch(`${based.url}/3d/`);
    const etag = first.headers.get('etag')!;
    const same = await fetch(`${based.url}/3d/`, { headers: { 'if-none-match': etag } });
    expect(same.status).toBe(304);
    expect(same.headers.get('etag')).toBe(etag);
    expect(same.headers.get('cache-control')).toBe('no-cache');
    expect(same.headers.get('vary')).toMatch(/\bX-Forwarded-Prefix\b/i);
    expect(await same.text()).toBe('');
    // another base is another page
    const other = await fetch(`${based.url}/`, {
      headers: { 'if-none-match': etag, 'x-forwarded-prefix': '/editor' },
    });
    expectBase(await page(other, 'other base'), '/editor/', INDEX_HTML, 'other base');
    expect(other.headers.get('etag')).not.toBe(etag);
  });
});

describe('a server without BASE_PATH behind a proxy that strips the prefix', () => {
  it('writes the pages with the base of X-Forwarded-Prefix', async () => {
    const headers = { 'x-forwarded-prefix': '/editor' };
    for (const p of ['/', '/projects/abc', '/index.html']) {
      const res = await fetch(`${root.url}${p}`, { headers });
      expectBase(await page(res, p), '/editor/', INDEX_HTML, p);
    }
    const desk = await fetch(`${root.url}/desk`, { headers });
    expectBase(await page(desk, '/desk'), '/editor/', DESK_HTML, '/desk');
    expect(desk.headers.get('content-security-policy')).toBe('frame-ancestors *');
    // the header's base is never removed from paths (only BASE_PATH is): /editor/… are paths of
    // the editor's pages at the root, and /editor is no base to redirect
    for (const p of ['/editor/desk.html', '/editor/healthz', '/editor?a=b']) {
      const res = await fetch(`${root.url}${p}`, { headers, redirect: 'manual' });
      expectBase(await page(res, p), '/editor/', INDEX_HTML, p);
    }
    // without the header: the root
    expectBase(await page(await fetch(`${root.url}/`), 'root'), '/', INDEX_HTML, 'root');
  });

  it('ignores an X-Forwarded-Prefix it cannot use, and counts several values by the first', async () => {
    const cases: [string, string][] = [
      ['//evil.example', '/'],
      ['/api', '/'],
      ['/a/../b', '/'],
      ['https://evil.example/x', '/'],
      ['/one, /two', '/one/'],
      ['//evil.example, /ok', '/'],
      ['/', '/'],
      // at most 256 characters as sent: the longest base is used, a longer value ignored
      [`/${'a'.repeat(255)}`, `/${'a'.repeat(255)}/`],
      [`/${'a'.repeat(256)}`, '/'],
      [`/${'a'.repeat(255)}, /ok`, `/${'a'.repeat(255)}/`],
    ];
    for (const [header, href] of cases) {
      const res = await fetch(`${root.url}/`, { headers: { 'x-forwarded-prefix': header } });
      expectBase(await page(res, header), href, INDEX_HTML, header);
    }
    // a path that starts with an unusable value is served as it is
    expect((await api(root.url, '/api/healthz', { headers: { 'x-forwarded-prefix': '/api' } })).status).toBe(
      404,
    );
  });

  it('keeps a Vary set before (CORS) with its own', async () => {
    const res = await fetch(`${root.url}/`, { headers: { origin: 'https://app.example.com' } });
    await page(res, 'cors');
    const vary = res.headers
      .get('vary')!
      .split(',')
      .map((v) => v.trim().toLowerCase());
    expect(vary).toEqual(expect.arrayContaining(['origin', 'x-forwarded-prefix']));
  });
});

describe('live sync under a prefix', () => {
  const clients: SyncTestClient[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.destroy()));
  });

  it('syncs a client at /3d/sync/<id> with one at /sync/<id>', async () => {
    const id = newUuid();
    const underBase = new SyncTestClient({
      baseUrl: `${based.url}/3d`,
      projectId: id,
      name: 'Under the base',
    });
    const atRoot = new SyncTestClient({ baseUrl: based.url, projectId: id, name: 'At the root' });
    clients.push(underBase, atRoot);
    expect(new URL(underBase.url).pathname).toBe(`/3d/sync/${id}`);
    expect(new URL(atRoot.url).pathname).toBe(`/sync/${id}`);
    await underBase.connect();
    await atRoot.connect();
    expect(atRoot.hello!.peers).toBe(2);
    const objectId = underBase.scene.addObject({ type: 'EMPTY', name: 'FromBase', location: [1, 2, 3] });
    await atRoot.waitFor(() => !!atRoot.scene.findObjectByName('FromBase'), 10_000, 'object from the base');
    atRoot.scene.updateObject(objectId, { location: [4, 5, 6] });
    await underBase.waitFor(
      () => underBase.scene.getObject(objectId)?.location[0] === 4,
      10_000,
      'change from the root',
    );
    // the handshake's line gives the URL as sent, the route its pattern
    const upgrade = await eventually(
      () => lines.find((l) => l.msg === 'upgrade completed' && l.url === `/3d/sync/${id}`),
      5000,
      'upgrade line',
    );
    expect(upgrade).toMatchObject({ route: '/sync/:projectId', statusCode: 101 });
  });

  /** Opens a WebSocket: 101 when it opened (then closed again), else the status of the refusal. */
  const upgrade = (url: string, headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url.replace('http:', 'ws:'), { headers });
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => resolve(0));
    });

  it("removes BASE_PATH from upgrades, never X-Forwarded-Prefix's base", async () => {
    const proxied = { 'x-forwarded-prefix': '/editor' };
    // a stripping proxy: the path without the prefix
    expect(await upgrade(`${root.url}/sync/${newUuid()}`, proxied)).toBe(101);
    // the header alone does not make the server remove its base
    expect(await upgrade(`${root.url}/editor/sync/${newUuid()}`, proxied)).toBe(404);
    // BASE_PATH is removed, whatever the header says
    expect(await upgrade(`${based.url}/3d/sync/${newUuid()}`, proxied)).toBe(101);
  });
});

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

/** Calls a tool and parses its JSON text. */
async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

/** Runs `fn` with an MCP client of `url` that sends `headers` with every request. */
async function withMcp<T>(
  url: string,
  headers: Record<string, string>,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'subpath-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe('MCP links under a prefix', () => {
  it('give the scheme, host and base the client used', async () => {
    const proxied = {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'example.com',
      'x-forwarded-prefix': '/3d',
    };
    await withMcp(`${based.url}/3d/mcp`, proxied, async (c) => {
      const created = await tool(c, 'create_project', { name: 'Under a prefix' });
      expect(created.editor_url).toBe(`https://example.com/3d/?project=${created.id}`);
      const got = await tool(c, 'get_project', { project: created.id });
      expect(got.editor_url).toBe(`https://example.com/3d/?project=${created.id}`);
    });
    // a stripping proxy: the request at /mcp, the base in the header
    await withMcp(`${root.url}/mcp`, { ...proxied, 'x-forwarded-prefix': '/editor' }, async (c) => {
      const created = await tool(c, 'create_project', { name: 'Behind a stripping proxy' });
      expect(created.editor_url).toBe(`https://example.com/editor/?project=${created.id}`);
    });
  });

  it('give BASE_PATH on the server’s own port, and today’s links at the root', async () => {
    await withMcp(`${based.url}/mcp`, {}, async (c) => {
      const created = await tool(c, 'create_project', { name: 'On the own port' });
      expect(created.editor_url).toBe(`${based.url}/3d/?project=${created.id}`);
    });
    await withMcp(`${root.url}/mcp`, {}, async (c) => {
      const created = await tool(c, 'create_project', { name: 'At the root' });
      expect(created.editor_url).toBe(`${root.url}/?project=${created.id}`);
    });
  });
});

describe('the WebDAV proxy under a prefix', () => {
  let dav: TestWebDAV;
  let server: TestServer;
  const bytes = (s: string) => new TextEncoder().encode(s);

  beforeAll(async () => {
    dav = await startWebDAV({ username: 'bob', password: 'hunter2' });
    await mkcolPath(dav, '/files');
    server = await serve({
      WEBDAV_URL: `${dav.origin}/files`,
      WEBDAV_USERNAME: 'bob',
      WEBDAV_PASSWORD: 'hunter2',
      SYNC_PERSISTENCE: 'memory',
      BASE_PATH: '/3d',
    });
  });

  afterAll(async () => {
    await dav?.stop();
  });

  const propfind = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'PROPFIND', headers: { depth: '1', ...headers } });
  const hrefs = (xml: string) => [...xml.matchAll(/<(?:\w+:)?href>([^<]*)</g)].map((m) => m[1]);

  it('gives hrefs under the base, which the editor’s WebDAV client follows', async () => {
    const client = new WebDAVClient({ url: `${server.url}/3d/dav` });
    await client.mkdirp('/3d-editor/projects/demo');
    await client.write('/3d-editor/projects/demo/hello.txt', bytes('hello'), { contentType: 'text/plain' });
    const entries = await client.list('/3d-editor/projects/demo');
    expect(entries.map((e) => e.name)).toEqual(['hello.txt']);
    expect(new TextDecoder().decode((await client.read('/3d-editor/projects/demo/hello.txt'))!.data)).toBe(
      'hello',
    );

    const res = await propfind(`${server.url}/3d/dav/3d-editor/projects/demo/`);
    expect(res.status).toBe(207);
    expect(hrefs(await res.text()).sort()).toEqual([
      '/3d/dav/3d-editor/projects/demo/',
      '/3d/dav/3d-editor/projects/demo/hello.txt',
    ]);
    // behind a stripping proxy: the request without the prefix, the hrefs under the header's base
    const stripped = await propfind(`${server.url}/dav/3d-editor/projects/demo/`, {
      'x-forwarded-prefix': '/editor',
    });
    expect(hrefs(await stripped.text()).sort()).toEqual([
      '/editor/dav/3d-editor/projects/demo/',
      '/editor/dav/3d-editor/projects/demo/hello.txt',
    ]);
  });

  it('accepts a Destination with or without the base, and nothing else', async () => {
    const at = (p: string) => `${server.url}/3d/dav/3d-editor/${p}`;
    expect((await fetch(at('a.txt'), { method: 'PUT', body: 'moved' })).status).toBeLessThan(300);
    // an absolute URL under the base
    let res = await fetch(at('a.txt'), { method: 'MOVE', headers: { destination: at('b.txt') } });
    expect(res.status).toBeLessThan(300);
    // a path without the base
    res = await fetch(at('b.txt'), { method: 'COPY', headers: { destination: '/dav/3d-editor/c.txt' } });
    expect(res.status).toBeLessThan(300);
    // a path under the base of X-Forwarded-Prefix
    res = await fetch(`${server.url}/dav/3d-editor/c.txt`, {
      method: 'COPY',
      headers: { destination: '/editor/dav/3d-editor/d.txt', 'x-forwarded-prefix': '/editor' },
    });
    expect(res.status).toBeLessThan(300);
    for (const name of ['b.txt', 'c.txt', 'd.txt']) {
      const upstream = await fetch(`${dav.origin}/files/3d-editor/${name}`, {
        headers: { authorization: dav.authorization },
      });
      expect(await upstream.text(), name).toBe('moved');
    }
    // anywhere else: refused with 502
    for (const destination of ['/other/dav/3d-editor/e.txt', '/3d/api/projects', 'http://evil.example/x']) {
      res = await fetch(at('b.txt'), { method: 'COPY', headers: { destination } });
      expect(res.status, destination).toBe(502);
      expect((await res.json()).error).toBe('Destination must be inside /3d/dav/');
    }
  });

  it('gives Location and Content-Location under the base', async () => {
    // an upstream that answers with both headers in its own namespace, and records Destination
    const seen: IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      const port = (upstream.address() as AddressInfo).port;
      res.writeHead(201, {
        location: `http://127.0.0.1:${port}/remote/files/new%20folder/`,
        'content-location': '/remote/files/doc.txt',
        'content-length': '0',
      });
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port;
    try {
      const proxy = await serve({
        WEBDAV_URL: `http://127.0.0.1:${port}/remote/files`,
        SYNC_PERSISTENCE: 'memory',
        BASE_PATH: '/3d',
      });
      let res = await fetch(`${proxy.url}/3d/dav/new%20folder/`, { method: 'MKCOL' });
      expect(res.status).toBe(201);
      expect(res.headers.get('location')).toBe('/3d/dav/new%20folder/');
      expect(res.headers.get('content-location')).toBe('/3d/dav/doc.txt');
      res = await fetch(`${proxy.url}/dav/new%20folder/`, {
        method: 'MKCOL',
        headers: { 'x-forwarded-prefix': '/editor' },
      });
      expect(res.headers.get('location')).toBe('/editor/dav/new%20folder/');
      expect(res.headers.get('content-location')).toBe('/editor/dav/doc.txt');
      // the Destination reaches the upstream in its own namespace, with or without the base
      for (const destination of [`${proxy.url}/3d/dav/x/y.txt`, '/dav/x/y.txt']) {
        res = await fetch(`${proxy.url}/3d/dav/doc.txt`, { method: 'MOVE', headers: { destination } });
        expect(res.status, destination).toBe(201);
        expect(seen.at(-1)!.destination, destination).toBe(`http://127.0.0.1:${port}/remote/files/x/y.txt`);
      }
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

/** A request with this exact target, which fetch would normalise: absolute form, fragments. */
function rawRequest(
  server: TestServer,
  target: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: init.method ?? 'GET',
        path: target,
        headers: init.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/** The status of a WebSocket upgrade with this exact target: 101 when the server accepts it. */
function rawUpgrade(
  server: TestServer,
  target: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: target,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'subpath-test', version: '1' },
  },
});
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('X-Forwarded-Prefix never moves a route', () => {
  it('serves /x/metrics and POST /x/mcp with X-Forwarded-Prefix: /x as any other path', async () => {
    const header = { 'x-forwarded-prefix': '/x' };
    for (const [server, prefix] of [
      [root, ''],
      [based, ''],
      [based, '/3d'],
    ] as const) {
      const what = `${server === root ? 'root' : 'BASE_PATH'} ${prefix}`;
      // the editor's page, not the metrics
      const metrics = await fetch(`${server.url}${prefix}/x/metrics`, { headers: header });
      expect(await page(metrics, what)).not.toContain('# HELP');
      // not the MCP endpoint
      const mcp = await rawRequest(server, `${prefix}/x/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, ...header },
        body: MCP_INITIALIZE,
      });
      expect(mcp.status, what).toBe(404);
      expect(JSON.parse(mcp.body), what).toEqual({ error: `not found: ${prefix}/x/mcp` });
      // the routes themselves still answer with the header
      const real = await fetch(`${server.url}${prefix}/metrics`, { headers: header });
      expect(real.status, what).toBe(200);
      expect(await real.text(), what).toContain('# HELP');
      const initialize = await rawRequest(server, `${prefix}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, ...header },
        body: MCP_INITIALIZE,
      });
      expect(initialize.status, what).toBe(200);
    }
  });

  it('says once, at warn, that a proxy keeping its prefix needs BASE_PATH', async () => {
    const logged: LogLine[] = [];
    const server = await serve(
      { PUBLIC_DIR: publicDir },
      {
        logger: {
          level: 'warn',
          stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogLine) },
        },
      },
    );
    const warnings = () => logged.filter((l) => l.msg?.includes('needs BASE_PATH='));
    // a path that does not start with the header's base, or a base the server removes: nothing to say
    await fetch(`${server.url}/healthz`, { headers: { 'x-forwarded-prefix': '/editor' } });
    expect(warnings()).toEqual([]);
    for (const [p, prefix] of [
      ['/editor/?token=abc', '/editor'],
      ['/editor/api/config', '/editor'],
      ['/other/', '/other'],
    ]) {
      const res = await fetch(`${server.url}${p}`, { headers: { 'x-forwarded-prefix': prefix } });
      await res.arrayBuffer();
    }
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({ level: 40, prefix: '/editor', url: '/editor/?token=[REDACTED]' });
    expect(warnings()[0]!.msg).toContain('a proxy that keeps the prefix needs BASE_PATH=/editor');
  });

  it('refuses a BASE_PATH longer than 256 characters when it starts', async () => {
    const longest = `/${'a'.repeat(255)}`;
    const dataDir = await makeTempDir('3d-editor-subpath-long-');
    try {
      await expect(startServer({ DATA_DIR: dataDir, BASE_PATH: `${longest}a` })).rejects.toThrow(
        `Invalid configuration: BASE_PATH: '${longest}a' is longer than 256 characters`,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
    const server = await serve({ PUBLIC_DIR: publicDir, BASE_PATH: longest });
    expectBase(
      await page(await fetch(`${server.url}${longest}/`), 'longest'),
      `${longest}/`,
      INDEX_HTML,
      'longest',
    );
  });
});

describe('AUTH_TOKEN on every spelling of a protected path', () => {
  const TOKEN = 's3cret';
  const auth = { authorization: `Bearer ${TOKEN}` };
  let dav: TestWebDAV;
  let guarded: TestServer;
  let guardedBased: TestServer;

  beforeAll(async () => {
    dav = await startWebDAV({ username: 'bob', password: 'hunter2' });
    await mkcolPath(dav, '/guarded');
    const env = {
      AUTH_TOKEN: TOKEN,
      WEBDAV_URL: `${dav.origin}/guarded`,
      WEBDAV_USERNAME: 'bob',
      WEBDAV_PASSWORD: 'hunter2',
      SYNC_PERSISTENCE: 'memory',
    };
    guarded = await serve(env);
    guardedBased = await serve({ ...env, BASE_PATH: '/3d' });
  });

  afterAll(async () => {
    await dav?.stop();
  });

  /** The servers and the prefixes their routes answer under. */
  const targets = () =>
    [
      [guarded, ''],
      [guardedBased, ''],
      [guardedBased, '/3d'],
    ] as const;

  it('answers the API, MCP, the WebDAV proxy and telemetry only with the token', async () => {
    const otlp = JSON.stringify({ resourceSpans: [] });
    for (const [server, p] of targets()) {
      const cases: [string, Parameters<typeof rawRequest>[2], number][] = [
        // percent-encoded letters, which the router decodes before it matches
        [`${p}/%61pi/projects`, {}, 200],
        [`${p}/a%70i/config`, {}, 200],
        [`${p}/%6dcp`, { method: 'POST', headers: MCP_HEADERS, body: MCP_INITIALIZE }, 200],
        [`${p}/%64av/`, { method: 'PROPFIND', headers: { depth: '1' } }, 207],
        [
          `${p}/%6ftlp/v1/traces`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: otlp },
          200,
        ],
        // absolute form, any case of the scheme, as a request to a proxy is sent
        [`http://x${p}/api/projects`, {}, 200],
        [`HTTP://X${p}/api/projects`, {}, 200],
        [`https://x${p}/api/config?y=1`, {}, 200],
        // a fragment, where the router ends the path
        [`${p}/mcp#x`, { method: 'POST', headers: MCP_HEADERS, body: MCP_INITIALIZE }, 200],
        [`${p}/api/projects#x`, {}, 200],
      ];
      for (const [target, init, ok] of cases) {
        const what = `${server === guarded ? 'root' : 'BASE_PATH'} ${init?.method ?? 'GET'} ${target}`;
        const denied = await rawRequest(server, target, init);
        expect(denied.status, what).toBe(401);
        expect(denied.headers['www-authenticate'], what).toMatch(/Bearer/);
        const allowed = await rawRequest(server, target, { ...init, headers: { ...init?.headers, ...auth } });
        expect(allowed.status, `${what} with the token`).toBe(ok);
      }
    }
  });

  it('accepts sync upgrades only with the token, whatever the spelling of their path', async () => {
    for (const [server, p] of targets()) {
      const what = `${server === guarded ? 'root' : 'BASE_PATH'} ${p}`;
      for (const target of [
        `${p}/%73ync/${newUuid()}`,
        // an encoded letter of the project id
        `${p}/sync/%61${newUuid().slice(1)}`,
        `http://x${p}/sync/${newUuid()}`,
        `HTTPS://X${p}/sync/${newUuid()}?y=1`,
        `${p}/sync/${newUuid()}#x`,
      ]) {
        expect(await rawUpgrade(server, target), `${what} ${target}`).toBe(401);
        const withToken = target.includes('?')
          ? `${target}&token=${TOKEN}`
          : target.replace(/(#.*)?$/, `?token=${TOKEN}$1`);
        expect(await rawUpgrade(server, withToken), `${what} ${withToken}`).toBe(101);
        expect(await rawUpgrade(server, target, auth), `${what} ${target} with the header`).toBe(101);
      }
      // no route: refused with or without the token
      for (const target of [
        `${p}//sync/${newUuid()}`,
        `${p}/sync%2F${newUuid()}`,
        `${p}/SYNC/${newUuid()}`,
      ]) {
        expect(await rawUpgrade(server, target), `${what} ${target}`).toBe(404);
        expect(await rawUpgrade(server, target, auth), `${what} ${target} with the token`).toBe(404);
      }
    }
  });
});

describe('headers that a regular expression would read in quadratic time', () => {
  /**
   * Sends `count` page requests with `headers` at once and, while the server works through them, a
   * health check; gives the statuses and the time until the server answered all of them. A server
   * that spends quadratic time on such a header (/\/+$/ on 15 KB of slashes before an `x`: about a
   * tenth of a second per value on a laptop, for each request) takes seconds; the server reads the
   * headers in linear time, in microseconds.
   */
  async function flood(server: TestServer, headers: Record<string, string>, count = 80) {
    const start = performance.now();
    const pages = Array.from({ length: count }, () =>
      fetch(`${server.url}/`, { headers }).then(async (res) => {
        await res.arrayBuffer();
        return res.status;
      }),
    );
    await sleep(10);
    const health = fetch(`${server.url}/healthz`).then(async (res) => {
      await res.arrayBuffer();
      return res.status;
    });
    const [statuses, healthStatus] = await Promise.all([Promise.all(pages), health]);
    return { statuses: new Set(statuses), healthStatus, ms: performance.now() - start };
  }

  const SLASHES = `${'/'.repeat(15_000)}x`;

  it('answers a flood of 15 KB X-Forwarded-Prefix values of slashes, and a health check, at once', async () => {
    for (const server of [root, based]) {
      const { statuses, healthStatus, ms } = await flood(server, { 'x-forwarded-prefix': SLASHES });
      // the header is ignored: the pages are written with the server's own base
      expect(statuses).toEqual(new Set([200]));
      expect(healthStatus).toBe(200);
      expect(ms).toBeLessThan(2000);
    }
  });

  it('answers a flood of 15 KB Origin headers of slashes (CORS_ORIGINS), and a health check, at once', async () => {
    const { statuses, healthStatus, ms } = await flood(root, { origin: `https://app.example.com${SLASHES}` });
    expect(statuses).toEqual(new Set([200]));
    expect(healthStatus).toBe(200);
    expect(ms).toBeLessThan(2000);
  });
});
