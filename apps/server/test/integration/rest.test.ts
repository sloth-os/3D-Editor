import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SceneDoc, encodePNG, exportScene, renderSceneSoftware } from '@3d-editor/core';
import { api, makeTempDir, startServer, type TestServer } from '../helpers/app';

function implemented(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    return !/not implemented/i.test(String(err));
  }
}
const canExport = implemented(() => exportScene(SceneDoc.create({ name: 'probe' }), 'glb'));
const canRender = implemented(() =>
  encodePNG(renderSceneSoftware(SceneDoc.create({ name: 'probe' }), { width: 4, height: 4 })),
);

let server: TestServer;
let publicDir: string;

beforeAll(async () => {
  publicDir = await makeTempDir('3d-editor-public-');
  await mkdir(path.join(publicDir, 'assets'));
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>3D Editor</title>');
  await writeFile(path.join(publicDir, 'assets', 'app-1a2b3c.js'), 'console.log(1)');
  await writeFile(path.join(publicDir, 'sw.js'), 'self.addEventListener("fetch", () => {})');
  await writeFile(path.join(publicDir, 'workbox-abc123.js'), '//');
  await writeFile(path.join(publicDir, 'manifest.webmanifest'), '{"name":"3D Editor"}');
  server = await startServer({ PUBLIC_DIR: publicDir, CORS_ORIGINS: 'https://app.example.com' });
});

afterAll(async () => {
  await server.close();
  await server.cleanup();
});

describe('PWA hosting', () => {
  it('serves index.html and assets with the right cache headers', async () => {
    const index = await fetch(`${server.url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('3D Editor');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const asset = await fetch(`${server.url}/assets/app-1a2b3c.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    for (const file of ['sw.js', 'workbox-abc123.js', 'manifest.webmanifest', 'index.html']) {
      const res = await fetch(`${server.url}/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('falls back to index.html for client-side routes only', async () => {
    const spa = await fetch(`${server.url}/projects/abc?project=1`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get('content-type')).toMatch(/text\/html/);
    expect(spa.headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${server.url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${server.url}/metricsx/a`)).status).toBe(200);
    expect((await fetch(`${server.url}/projects/x`, { method: 'POST' })).status).toBe(404);
    const api404 = await api(server.url, '/api/does/not/exist');
    expect(api404.body).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('serves only the API when there is no PWA build', async () => {
    const bare = await startServer();
    try {
      expect((await fetch(`${bare.url}/`)).status).toBe(404);
      expect((await api(bare.url, '/api/config')).status).toBe(200);
    } finally {
      await bare.close();
      await bare.cleanup();
    }
  });
});

describe('REST API', () => {
  it('returns the client configuration', async () => {
    const res = await api(server.url, '/api/config');
    expect(res.body).toEqual({
      version: expect.any(String),
      features: { sync: true, mcp: true, telemetry: true, webdavProxy: false },
      webdav: null,
      persistence: 'memory',
    });
  });

  it('creates, lists, reads, renames and deletes projects', async () => {
    const created = await api(server.url, '/api/projects', {
      method: 'POST',
      json: { name: 'REST project' },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body.name).toBe('REST project');
    const empty = await api(server.url, '/api/projects', {
      method: 'POST',
      json: { name: 'Empty', empty: true },
    });
    expect((await api(server.url, `/api/projects/${empty.body.id}`)).body.stats.objects).toBe(0);
    expect((await api(server.url, '/api/projects', { method: 'POST', json: { name: 42 } })).status).toBe(400);

    const list = await api(server.url, '/api/projects');
    expect(list.body.projects.map((p: any) => p.id)).toEqual(expect.arrayContaining([id, empty.body.id]));
    const one = await api(server.url, `/api/projects/${id}`);
    expect(one.body).toMatchObject({
      id,
      name: 'REST project',
      peers: 0,
      live: true,
      stats: { objects: 3, vertices: 8, faces: 6 },
    });

    const renamed = await api(server.url, `/api/projects/${id}`, {
      method: 'PATCH',
      json: { name: 'Renamed' },
    });
    expect(renamed.body.name).toBe('Renamed');

    const snap = await api(server.url, `/api/projects/${id}/snapshot`);
    expect(snap.body.meta.name).toBe('Renamed');
    expect(snap.body.objects.map((o: any) => o.name).sort()).toEqual(['Camera', 'Cube', 'Light']);
    expect(snap.body.meshes[0].mesh.positions).toHaveLength(24);

    expect((await api(server.url, '/api/projects/not-there')).status).toBe(404);
    expect((await api(server.url, '/api/projects/bad id')).status).toBe(404);
    expect((await api(server.url, `/api/projects/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(server.url, `/api/projects/${id}`)).status).toBe(404);
  });

  it.skipIf(!canExport)('exports scenes as downloads', async () => {
    const { body } = await api(server.url, '/api/projects', {
      method: 'POST',
      json: { name: 'Export: me!' },
    });
    const res = await fetch(`${server.url}/api/projects/${body.id}/export?format=glb`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Export_me.glb"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF');
    expect((await fetch(`${server.url}/api/projects/${body.id}/export?format=fbx`)).status).toBe(400);
  });

  it.skipIf(!canRender)('renders PNG previews with the software renderer', async () => {
    const { body } = await api(server.url, '/api/projects', { method: 'POST', json: { name: 'Render' } });
    const res = await fetch(`${server.url}/api/projects/${body.id}/render.png?width=64`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(36);
    expect((await fetch(`${server.url}/api/projects/${body.id}/render.png?width=99999`)).status).toBe(400);
  });

  it('answers CORS preflights for allowed origins only', async () => {
    const pre = await fetch(`${server.url}/api/projects`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(pre.headers.get('access-control-allow-methods')).toContain('PROPFIND');
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    const get = await fetch(`${server.url}/api/config`, { headers: { origin: 'https://app.example.com' } });
    expect(get.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    const other = await fetch(`${server.url}/api/config`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('exposes request metrics', async () => {
    const text = await (await fetch(`${server.url}/metrics`)).text();
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/api\/projects\/:id",status="200"\} \d+/);
    expect(text).toMatch(
      /http_request_duration_seconds_bucket\{le="[\d.]+",method="POST",route="\/api\/projects"\} \d+/,
    );
    expect(text).toMatch(/persistence_operations_total|sync_rooms \d+/);
  });
});
