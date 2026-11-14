import Fastify, { type FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_CATALOG,
  SceneDoc,
  createOperatorRegistry,
  setOperatorMemoryCheck,
  type OperatorMemoryCheck,
} from '@3d-editor/core';
import { registerStoreRoutes } from '../../src/api/store';
import type { ServerServices } from '../../src/services';
import {
  KHRONOS,
  KHRONOS_CHAIR_META,
  KHRONOS_INDEX,
  SKETCHFAB_API,
  SF_UID_1,
  bytes,
  cubeGlb,
  cubeGltf,
  fakeFetch,
  json,
  makeStore,
  sketchfabModel,
  type Route,
  type TestStore,
} from './store-fixtures';

/*
 * The REST routes of the model store against a store with a fake fetch: status codes, error
 * bodies, content types, caching headers (ETag, 304) and parameter checks.
 */

const CATALOG = 'https://models.example.org/c.json';
const lamp = cubeGltf('cube.bin', 'textures/wood.png');
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const builtin = BUILTIN_CATALOG.find((e) => e.rig === null)!;

let app: FastifyInstance;
let t: TestStore;
let doc: SceneDoc;
beforeEach(async () => {
  doc = SceneDoc.create({ empty: true });
  const f = fakeFetch({
    [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
    [`${KHRONOS}StudioChair/metadata.json`]: json(KHRONOS_CHAIR_META),
    [`${KHRONOS}StudioChair/screenshot/screenshot.jpg`]: bytes(jpeg, 'image/jpeg'),
    [`${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb`]: bytes(cubeGlb(), 'model/gltf-binary'),
    [`${KHRONOS}DeskLamp/metadata.json`]: json({ ...KHRONOS_CHAIR_META, name: 'Desk Lamp' }),
    [`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`]: bytes(lamp.gltf, 'model/gltf+json'),
    [`${KHRONOS}DeskLamp/glTF/cube.bin`]: bytes(lamp.bin),
    [`${KHRONOS}DeskLamp/glTF/textures/wood.png`]: bytes(lamp.png, 'image/png'),
    [`${KHRONOS}ToyTruck/metadata.json`]: json({ ...KHRONOS_CHAIR_META, name: 'Toy Truck' }),
    [`${KHRONOS}ToyTruck/glTF-Binary/ToyTruck.glb`]: () => new Response('down', { status: 502 }),
    [`${SKETCHFAB_API}/models/${SF_UID_1}`]: json(sketchfabModel(SF_UID_1)),
    [CATALOG]: json({
      version: 1,
      name: 'Team',
      models: [{ id: 'tree', name: 'Listed tree', downloadable: false, files: { glb: 'tree.glb' } }],
    }),
  });
  t = await makeStore({
    fetch: f.fetch,
    env: { STORE_PROVIDERS: 'builtin,khronos,sketchfab,catalog', STORE_CATALOG_URLS: CATALOG },
    registry: createOperatorRegistry(),
    rooms: {
      open: async (id: string) =>
        id === 'p1' ? { scene: doc, destroyed: false, touch: () => undefined } : null,
    },
  });
  app = Fastify({ logger: false });
  registerStoreRoutes(app, { store: t.store } as unknown as ServerServices);
});
afterEach(async () => {
  await app.close();
  await t.cleanup();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

describe('GET /api/store/providers and /api/store/search', () => {
  it('lists the providers and searches with paging', async () => {
    const p = await get('/api/store/providers');
    expect(p.statusCode).toBe(200);
    expect(p.json().providers.map((x: { id: string }) => x.id)).toEqual([
      'builtin',
      'khronos',
      'sketchfab',
      'catalog',
      'polyhaven',
      'polypizza',
    ]);
    const s = await get('/api/store/search?query=chair&providers=khronos&limit=1');
    expect(s.statusCode).toBe(200);
    expect(s.headers['content-type']).toMatch(/^application\/json/);
    const body = s.json();
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['khronos:StudioChair']);
    expect(body.providers).toEqual([expect.objectContaining({ id: 'khronos', status: 'ok' })]);
  });

  it('checks its parameters (400 with the zod error or the store code)', async () => {
    for (const q of ['limit=51', 'limit=0', 'category=spaceships', `query=${'x'.repeat(201)}`]) {
      const r = await get(`/api/store/search?${q}`);
      expect(r.statusCode, q).toBe(400);
    }
    const bad = await get('/api/store/search?cursor=garbage');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'INVALID_PARAMS' });
    const unknown = await get('/api/store/search?providers=khronos,martian');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/unknown store provider 'martian'/);
  });
});

describe('GET /api/store/models/:model', () => {
  it('answers a model, with its files when asked to download', async () => {
    const r = await get('/api/store/models/khronos:DeskLamp');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 'khronos:DeskLamp', files: null });
    const d = await get('/api/store/models/khronos%3ADeskLamp?download=1');
    expect(d.statusCode).toBe(200);
    expect(d.json().files.map((f: { path: string }) => f.path)).toEqual([
      'DeskLamp.gltf',
      'cube.bin',
      'textures/wood.png',
    ]);
    expect((await get('/api/store/models/khronos:DeskLamp?download=maybe')).statusCode).toBe(400);
    const missing = await get('/api/store/models/khronos:Nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves thumbnails with their type, an ETag and a day of caching', async () => {
    const r = await get('/api/store/models/khronos:StudioChair/thumbnail');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('private, max-age=86400');
    expect(new Uint8Array(r.rawPayload)).toEqual(jpeg);
    const etag = r.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get('/api/store/models/khronos:StudioChair/thumbnail', {
      'if-none-match': `"x", ${etag}`,
    });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    expect((await get('/api/store/models/khronos:DeskLamp/thumbnail')).statusCode).toBe(503);
  });

  it('serves model files: the main file for an empty path, others by path', async () => {
    const main = await get('/api/store/models/khronos:DeskLamp/files/');
    expect(main.statusCode).toBe(200);
    expect(main.headers['content-type']).toBe('model/gltf+json');
    expect(main.headers['cache-control']).toBe('private, max-age=3600');
    expect(new Uint8Array(main.rawPayload)).toEqual(lamp.gltf);
    const tex = await get('/api/store/models/khronos:DeskLamp/files/textures/wood.png');
    expect(tex.statusCode).toBe(200);
    expect(tex.headers['content-type']).toBe('image/png');
    const cached = await get('/api/store/models/khronos:DeskLamp/files/textures/wood.png', {
      'if-none-match': tex.headers.etag as string,
    });
    expect(cached.statusCode).toBe(304);
    expect((await get('/api/store/models/khronos:DeskLamp/files/nope.png')).statusCode).toBe(404);
    const bi = await get(`/api/store/models/builtin:${builtin.id}/files/`);
    expect(bi.statusCode).toBe(400);
    expect(bi.json().code).toBe('INVALID_PARAMS');
  });

  it('streams model files from the cache, and answers a 304 without reading the file', async () => {
    const inMemory = vi.spyOn(t.store, 'files');
    const first = await get('/api/store/models/khronos:DeskLamp/files/cube.bin');
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-length']).toBe(String(lamp.bin.length));
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(new Uint8Array(first.rawPayload)).toEqual(lamp.bin);
    expect(inMemory).not.toHaveBeenCalled();
    // the cached file gone from disk: a client that has it is answered all the same
    const held = await t.store.openFile('khronos:DeskLamp', 'cube.bin');
    held.release();
    await rm(held.path);
    const again = await get('/api/store/models/khronos:DeskLamp/files/cube.bin', {
      'if-none-match': first.headers.etag as string,
    });
    expect(again.statusCode).toBe(304);
    expect(again.headers.etag).toBe(first.headers.etag);
    expect(again.rawPayload.length).toBe(0);
  });

  it('answers the store codes: NEEDS_KEY 400, NOT_DOWNLOADABLE 409, UPSTREAM 503', async () => {
    const key = await get(`/api/store/models/sketchfab:${SF_UID_1}/files/`);
    expect(key.statusCode).toBe(400);
    expect(key.json()).toMatchObject({
      code: 'NEEDS_KEY',
      error: expect.stringContaining('SKETCHFAB_TOKEN'),
    });
    const listed = await get('/api/store/models/catalog:team.tree/files/');
    expect(listed.statusCode).toBe(409);
    expect(listed.json().code).toBe('NOT_DOWNLOADABLE');
    const upstream = await get('/api/store/models/khronos:ToyTruck/files/');
    expect(upstream.statusCode).toBe(503);
    expect(upstream.json()).toMatchObject({ code: 'UPSTREAM', error: expect.stringContaining('HTTP 502') });
  });
});

describe('POST /api/projects/:id/store', () => {
  const post = (id: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/projects/${id}/store`, payload: payload as object });

  it('inserts a model into the project', async () => {
    const r = await post('p1', { model: 'khronos:DeskLamp', location: [0, 1, 0], name: 'Lamp' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.entry.id).toBe('khronos:DeskLamp');
    expect(doc.getObject(body.result.root)?.name).toBe('Lamp');
    // the reply of store_add: the model once, as a credit, its thumbnail the route REST search gives
    expect(Object.keys(body.entry).sort()).toEqual([
      'author',
      'id',
      'license',
      'name',
      'provider',
      'source_url',
      'thumbnail_url',
    ]);
    expect(body.entry.thumbnail_url).toBe('/api/store/models/khronos:DeskLamp/thumbnail');
    expect(body.result).not.toHaveProperty('warnings');
    const b = await post('p1', { model: `builtin:${builtin.id}`, color: '#336699' });
    expect(b.statusCode).toBe(200);
    // core's store.add returns its catalog entry too: the reply carries it once, at the top
    expect(b.json().result).not.toHaveProperty('entry');
    expect(b.json().entry).not.toHaveProperty('description');
  });

  it("builds a built-in model with its own parameters, checked by the model's schema", async () => {
    const r = await post('p1', { model: 'builtin:sofa', params: { seats: 2 } });
    expect(r.statusCode).toBe(200);
    const three = await post('p1', { model: 'builtin:sofa' });
    // two seats make a shorter sofa than the default three
    expect(r.json().result.dimensions_m[0]).toBeLessThan(three.json().result.dimensions_m[0] - 0.3);
    const wrong = await post('p1', { model: 'builtin:sofa', params: { seats: 9 } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({
      code: 'INVALID_PARAMS',
      error: expect.stringContaining('It takes: seats (integer 1–5, default 3)'),
    });
    expect((await post('p1', { model: 'builtin:sofa', params: 'seats=2' })).statusCode).toBe(400);
    expect(doc.listObjects().filter((o) => o.parent === null)).toHaveLength(2);
  });

  it('checks the body and answers the codes', async () => {
    expect((await post('p1', {})).statusCode).toBe(400);
    expect((await post('p1', { model: 'khronos:DeskLamp', colour: '#ffffff' })).statusCode).toBe(400);
    expect((await post('p1', { model: 'khronos:DeskLamp', color: 'red' })).statusCode).toBe(400);
    expect((await post('p1', { model: 'khronos:DeskLamp', name: 'x'.repeat(65) })).statusCode).toBe(400);
    const missing = await post('p9', { model: `builtin:${builtin.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
    expect((await post('p1', { model: `sketchfab:${SF_UID_1}` })).json().code).toBe('NEEDS_KEY');
    expect((await post('p1', { model: 'catalog:team.tree' })).statusCode).toBe(409);
    expect(doc.listObjects()).toHaveLength(0);
  });

  it('answers 507 for a model the server cannot hold, before reading its files', async () => {
    let installed: OperatorMemoryCheck | null = null;
    try {
      installed = setOperatorMemoryCheck(() => 'the insert needs 900 MB and 300 MB are free');
      const r = await post('p1', { model: 'khronos:DeskLamp' });
      expect(r.statusCode).toBe(507);
      expect(r.json()).toMatchObject({
        code: 'OUT_OF_MEMORY',
        error: expect.stringContaining('the insert needs 900 MB and 300 MB are free'),
      });
      expect(t.store.cache.filesRead).toBe(0);
      expect(doc.listObjects()).toHaveLength(0);
    } finally {
      setOperatorMemoryCheck(installed);
    }
  });
});

describe('over a real HTTP connection', () => {
  // app.inject does not reproduce what Node does with a real request: it closes the request
  // (IncomingMessage 'close') as soon as its body was read, while the client still waits
  let server: FastifyInstance;
  let ts: TestStore;
  let target: SceneDoc;
  afterEach(async () => {
    await server.close();
    await ts.cleanup();
  });

  async function serve(routes: Record<string, Route>) {
    target = SceneDoc.create({ empty: true });
    const f = fakeFetch(routes);
    ts = await makeStore({
      fetch: f.fetch,
      env: { STORE_PROVIDERS: 'builtin,khronos' },
      registry: createOperatorRegistry(),
      rooms: {
        open: async (id: string) =>
          id === 'p1' ? { scene: target, destroyed: false, touch: () => undefined } : null,
      },
    });
    server = Fastify({ logger: false });
    registerStoreRoutes(server, { store: ts.store } as unknown as ServerServices);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    return { f, base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` };
  }

  const later =
    (route: Route, ms: number): Route =>
    async (req) => {
      await new Promise((r) => setTimeout(r, ms));
      return route(req);
    };

  it('inserts an external model that is not downloaded yet (reading the POST body is not the client leaving)', async () => {
    const { f, base } = await serve({
      [`${KHRONOS}model-index.json`]: later(json(KHRONOS_INDEX), 50),
      [`${KHRONOS}StudioChair/metadata.json`]: later(json(KHRONOS_CHAIR_META), 50),
      [`${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb`]: later(
        bytes(cubeGlb(), 'model/gltf-binary'),
        150,
      ),
    });
    const res = await fetch(`${base}/api/projects/p1/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'khronos:StudioChair', name: 'Chair' }),
    });
    const body = (await res.json()) as { result: { root: string }; entry: { id: string } };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.entry.id).toBe('khronos:StudioChair');
    expect(target.getObject(body.result.root)?.name).toBe('Chair');
    expect(f.count(`${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb`)).toBe(1);
  });

  it('stops the download of a request whose client went away', async () => {
    let download: AbortSignal | undefined;
    const { base } = await serve({
      [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
      [`${KHRONOS}StudioChair/metadata.json`]: json(KHRONOS_CHAIR_META),
      [`${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb`]: (req) => {
        download = req.signal;
        return new Promise<Response>((_, reject) =>
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
    });
    const client = new AbortController();
    const pending = fetch(`${base}/api/store/models/khronos:StudioChair?download=1`, {
      signal: client.signal,
    }).catch((err: unknown) => err);
    await vi.waitFor(() => expect(download).toBeDefined());
    expect(download!.aborted).toBe(false);
    client.abort();
    await pending;
    await vi.waitFor(() => expect(download!.aborted).toBe(true));
  });
});
