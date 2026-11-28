import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PreconditionFailedError, ProjectFileStore, SceneDoc, WebDAVClient, newUuid } from '@3d-editor/core';
import { api, startServer, type TestServer } from '../helpers/app';
import { mkcolPath, startWebDAV, type TestWebDAV } from '../helpers/webdav';

let dav: TestWebDAV;
let server: TestServer;
const TOKEN = 'proxy-token';
/** Every request the WebDAV server got from the editor server, as it got it. */
const upstream: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  // like Nextcloud: ETags with GET, HEAD and PUT responses, If-Match and If-None-Match checked
  dav = await startWebDAV({
    username: 'bob',
    password: 'hunter2',
    etagHeaders: true,
    conditional: true,
    onRequest: ({ method, url, headers }) => {
      // the proxy's own requests (this test reads the WebDAV server directly too)
      if (headers['user-agent'] === '3d-editor-server (webdav proxy)')
        upstream.push({ method, url, headers });
    },
  });
  await mkcolPath(dav, '/users/bob smith');
  server = await startServer({
    WEBDAV_URL: `${dav.origin}/users/bob%20smith`,
    WEBDAV_USERNAME: 'bob',
    WEBDAV_PASSWORD: 'hunter2',
    SYNC_PERSISTENCE: 'memory',
    AUTH_TOKEN: TOKEN,
  });
});

afterAll(async () => {
  await server?.close();
  await server?.cleanup();
  await dav?.stop();
});

/** Raw HTTP request (no client-side URL normalization of the path). */
function rawRequest(pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: pathname, method, headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The browser's WebDAV client pointed at the server's same-origin proxy. */
function proxiedClient(): WebDAVClient {
  return new WebDAVClient({ url: `${server.url}/dav`, token: TOKEN });
}

describe('WebDAV proxy', () => {
  it('advertises the proxy in /api/config', async () => {
    const res = await api(server.url, '/api/config', { token: TOKEN });
    expect(res.body).toMatchObject({
      features: { webdavProxy: true },
      webdav: { url: '/dav', basePath: '/3d-editor' },
      persistence: 'memory',
    });
  });

  it('supports PUT / GET / PROPFIND / DELETE through /dav with the core WebDAVClient', async () => {
    const client = proxiedClient();
    expect(await client.check()).toMatchObject({ ok: true });
    await client.mkdirp('/3d-editor/projects/demo');
    const put = await client.write(
      '/3d-editor/projects/demo/hello.txt',
      new TextEncoder().encode('hello via proxy'),
      { contentType: 'text/plain' },
    );
    expect(put.etag).toBeTruthy();
    const got = await client.read('/3d-editor/projects/demo/hello.txt');
    expect(new TextDecoder().decode(got!.data)).toBe('hello via proxy');

    const entries = await client.list('/3d-editor/projects/demo');
    expect(entries.map((e) => e.name)).toEqual(['hello.txt']);
    expect(entries[0]).toMatchObject({ isDir: false, size: 15 });

    // the file really is on the upstream server, under WEBDAV_URL
    const upstream = await fetch(`${dav.origin}/users/bob%20smith/3d-editor/projects/demo/hello.txt`, {
      headers: { authorization: dav.authorization },
    });
    expect(await upstream.text()).toBe('hello via proxy');

    await client.remove('/3d-editor/projects/demo/hello.txt');
    expect(await client.read('/3d-editor/projects/demo/hello.txt')).toBeNull();
  });

  it('passes ETags and conditional writes through', async () => {
    const client = proxiedClient();
    await client.mkdirp('/3d-editor/projects/etags');
    const path = '/3d-editor/projects/etags/doc.bin';
    const first = await client.write(path, new Uint8Array([1]), { ifNoneMatch: '*' });
    expect(first.etag).toMatch(/^"w\d+"$/);
    expect((await client.read(path))!.etag).toBe(first.etag);
    expect(await client.etag(path)).toBe(first.etag);
    const second = await client.write(path, new Uint8Array([2]), { ifMatch: first.etag });
    expect(second.etag).not.toBe(first.etag);
    // a write based on the first version, and a create of an existing file, are refused (412)
    await expect(client.write(path, new Uint8Array([3]), { ifMatch: first.etag })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await expect(client.write(path, new Uint8Array([3]), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    const now = (await client.read(path))!;
    expect([...now.data]).toEqual([2]);
    expect(now.etag).toBe(second.etag);
  });

  it('rewrites PROPFIND hrefs to the /dav namespace', async () => {
    const res = await fetch(`${server.url}/dav/3d-editor/`, {
      method: 'PROPFIND',
      headers: { authorization: `Bearer ${TOKEN}`, depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>',
    });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain('/dav/3d-editor/');
    expect(xml).not.toContain(dav.origin);
    expect(xml).not.toContain('/users/bob');
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('streams binary bodies and supports MOVE / COPY with rewritten Destination', async () => {
    const bytes = new Uint8Array(256 * 1024).map((_, i) => (i * 31) % 256);
    let res = await fetch(`${server.url}/dav/3d-editor/blob.bin`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    expect(res.status).toBeLessThan(300);
    res = await fetch(`${server.url}/dav/3d-editor/blob.bin`, {
      method: 'MOVE',
      headers: { authorization: `Bearer ${TOKEN}`, destination: `${server.url}/dav/3d-editor/moved.bin` },
    });
    expect(res.status).toBeLessThan(300);
    res = await fetch(`${server.url}/dav/3d-editor/moved.bin`, {
      method: 'COPY',
      headers: { authorization: `Bearer ${TOKEN}`, destination: '/dav/3d-editor/copied.bin' },
    });
    expect(res.status).toBeLessThan(300);
    const copied = await fetch(`${server.url}/dav/3d-editor/copied.bin`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(new Uint8Array(await copied.arrayBuffer())).toEqual(bytes);
    const head = await fetch(`${server.url}/dav/3d-editor/copied.bin`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
    expect(
      (await fetch(`${server.url}/dav/3d-editor/blob.bin`, { headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(404);
  });

  it('is not an open proxy', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    // destinations outside /dav are refused
    let res = await fetch(`${server.url}/dav/3d-editor/copied.bin`, {
      method: 'COPY',
      headers: { ...auth, destination: 'http://evil.example.com/x' },
    });
    expect(res.status).toBe(502);
    // traversal out of the upstream base is refused
    expect(await rawRequest('/dav/%2e%2e/%2e%2e/secret', auth)).toBe(400);
    expect(await rawRequest('/dav/a/../../../etc/passwd', auth)).toBe(400);
    // absolute-form request targets do not reach other hosts
    res = await fetch(`${server.url}/dav//evil.example.com/x`, { headers: auth });
    expect([404, 400]).toContain(res.status);
    // credentials are required (AUTH_TOKEN)
    res = await fetch(`${server.url}/dav/3d-editor/copied.bin`);
    expect(res.status).toBe(401);
  });

  it('lets a token in the query authorize GET, PUT, PROPFIND and COPY, and never passes it on to the WebDAV server', async () => {
    await proxiedClient().mkdirp('/in-query');
    upstream.length = 0;
    // every spelling of the name extractToken reads as `token`
    const names = ['token', '%74oken', 'to%6Ben'];
    for (const [i, name] of names.entries()) {
      const pair = `${name}=${TOKEN}`;
      let res = await fetch(`${server.url}/dav/in-query/f${i}.txt?${pair}`, {
        method: 'PUT',
        body: `file ${i}`,
      });
      expect(res.status, name).toBe(201);
      res = await fetch(`${server.url}/dav/in-query/f${i}.txt?a=1&${pair}&b=%41`);
      expect(res.status, name).toBe(200);
      expect(await res.text(), name).toBe(`file ${i}`);
      res = await fetch(`${server.url}/dav/in-query/?${pair}`, {
        method: 'PROPFIND',
        headers: { depth: '1' },
      });
      expect(res.status, name).toBe(207);
      expect(await res.text(), name).toContain(`/dav/in-query/f${i}.txt`);
      // the token in the URL and in the Destination
      res = await fetch(`${server.url}/dav/in-query/f${i}.txt?${pair}`, {
        method: 'COPY',
        headers: { destination: `${server.url}/dav/in-query/c${i}.txt?${pair}` },
      });
      expect(res.status, name).toBe(201);
      // without it the same request is refused: the query's token is what let them through
      expect((await fetch(`${server.url}/dav/in-query/f${i}.txt`)).status, name).toBe(401);
    }
    // the WebDAV server never saw the token, in a URL or in a header
    expect(upstream.length).toBe(names.length * 4);
    for (const r of upstream) {
      const seen = `${r.url} ${JSON.stringify(r.headers)}`;
      expect(seen, `${r.method} ${r.url}`).not.toContain(TOKEN);
      expect(seen, `${r.method} ${r.url}`).not.toMatch(/[?&](token|%74oken|to%6Ben)=/i);
    }
    const stored = await fetch(`${dav.origin}/users/bob%20smith/in-query/c2.txt`, {
      headers: { authorization: dav.authorization },
    });
    expect(await stored.text()).toBe('file 2');
    // the other pairs reach it as they were sent, in their order
    expect(upstream.filter((r) => r.method === 'GET').map((r) => r.url)).toEqual(
      names.map((_, i) => `/users/bob%20smith/in-query/f${i}.txt?a=1&b=%41`),
    );
    expect(upstream.filter((r) => r.method === 'COPY').map((r) => [r.url, r.headers.destination])).toEqual(
      names.map((_, i) => [
        `/users/bob%20smith/in-query/f${i}.txt`,
        `${dav.origin}/users/bob%20smith/in-query/c${i}.txt`,
      ]),
    );
  });

  it('answers with a sandbox and nosniff: uploaded .html and .svg are never active on the editor’s origin', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const files: [string, string, string][] = [
      ['evil.html', 'text/html', '<html><body><script>parent.postMessage("x", "*")</script></body></html>'],
      [
        'evil.svg',
        'image/svg+xml',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ],
    ];
    for (const [name, type, body] of files) {
      const put = await fetch(`${server.url}/dav/3d-editor/${name}`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': type },
        body,
      });
      expect(put.status, name).toBeLessThan(300);
      const got = await fetch(`${server.url}/dav/3d-editor/${name}`, { headers: auth });
      expect(got.status, name).toBe(200);
      expect(await got.text(), name).toBe(body);
      expect(got.headers.get('content-security-policy'), name).toBe('sandbox');
      expect(got.headers.get('x-content-type-options'), name).toBe('nosniff');
    }
    // every answer of the proxy: listings, misses, refusals
    const answers = [
      await fetch(`${server.url}/dav/3d-editor/`, { method: 'PROPFIND', headers: { ...auth, depth: '1' } }),
      await fetch(`${server.url}/dav/3d-editor/missing.txt`, { headers: auth }),
      await fetch(`${server.url}/dav/3d-editor/evil.html`, {
        method: 'COPY',
        headers: { ...auth, destination: 'http://evil.example/x' },
      }),
      await fetch(`${server.url}/dav/..%2fx`, { headers: auth }),
    ];
    expect(answers.map((r) => r.status)).toEqual([207, 404, 502, 400]);
    for (const res of answers) {
      expect(res.headers.get('content-security-policy'), String(res.status)).toBe('sandbox');
      expect(res.headers.get('x-content-type-options'), String(res.status)).toBe('nosniff');
      expect(res.headers.get('vary'), String(res.status)).toMatch(/\bX-Forwarded-Prefix\b/);
      await res.arrayBuffer();
    }
  });

  it('puts its own Content-Security-Policy in place of the WebDAV server’s, and adds X-Forwarded-Prefix to its Vary', async () => {
    // a WebDAV server that sends its own policy and Vary
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src *; script-src 'unsafe-inline'",
        vary: 'Accept-Encoding, Brief',
        'content-length': '2',
      });
      res.end('hi');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port;
    const proxy = await startServer({
      WEBDAV_URL: `http://127.0.0.1:${port}/files`,
      SYNC_PERSISTENCE: 'memory',
      CORS_ORIGINS: 'https://app.example.com',
    });
    try {
      const res = await fetch(`${proxy.url}/dav/page.html`, {
        headers: { origin: 'https://app.example.com' },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hi');
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      // the WebDAV server's, the CORS hook's and the proxy's own
      const vary = res.headers
        .get('vary')!
        .split(',')
        .map((v) => v.trim().toLowerCase());
      expect(vary.sort()).toEqual(['accept-encoding', 'brief', 'origin', 'x-forwarded-prefix']);
    } finally {
      await proxy.close();
      await proxy.cleanup();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('lets a browser-style ProjectFileStore save CRDT documents through the proxy', async () => {
    const store = new ProjectFileStore(proxiedClient(), '/3d-editor');
    const id = newUuid();
    const scene = SceneDoc.create({ name: 'Via proxy' });
    const res = await store.syncDocument(id, scene.ydoc, {
      info: () => ({
        id,
        name: 'Via proxy',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        schema_version: 1,
      }),
    });
    expect(res.pushed).toBe(true);
    const listed = await store.listProjects();
    expect(listed.map((p) => p.id)).toContain(id);
    const loaded = await store.loadDocument(id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, loaded!.update);
    expect(new SceneDoc(doc).name).toBe('Via proxy');
  });

  it('maps upstream credential failures to 502', async () => {
    const bad = await startServer({
      WEBDAV_URL: `${dav.origin}/users/bob%20smith`,
      WEBDAV_USERNAME: 'bob',
      WEBDAV_PASSWORD: 'wrong',
      SYNC_PERSISTENCE: 'memory',
    });
    try {
      const res = await fetch(`${bad.url}/dav/3d-editor/`, { method: 'PROPFIND', headers: { depth: '0' } });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/credentials/);
    } finally {
      await bad.close();
      await bad.cleanup();
    }
  });
});
