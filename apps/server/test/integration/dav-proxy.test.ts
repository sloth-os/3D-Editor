import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ProjectFileStore, SceneDoc, WebDAVClient, newUuid } from '@3d-editor/core';
import { api, startServer, type TestServer } from '../helpers/app';
import { mkcolPath, startWebDAV, type TestWebDAV } from '../helpers/webdav';

let dav: TestWebDAV;
let server: TestServer;
const TOKEN = 'proxy-token';

beforeAll(async () => {
  dav = await startWebDAV({ username: 'bob', password: 'hunter2' });
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
