import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BUILTIN_CATALOG, decodePNG } from '@3d-editor/core';
import { sharedRenderer } from '../../src/render';
import { api, startServer, type TestServer } from '../helpers/app';
import {
  KHRONOS,
  KHRONOS_CHAIR_META,
  KHRONOS_INDEX,
  bytes,
  cubeGlb,
  cubeGltf,
  fakeFetch,
  json,
  type Route,
} from '../unit/store-fixtures';

/*
 * The model store in the real server, with providers answered by a fake fetch (no network): an
 * agent searches, inserts an external multi-file glTF (one undo step) and a built-in model; the
 * REST routes serve search results, thumbnails (a built-in one rendered by the server's renderer
 * once, then cached), model files and inserts.
 */

const lamp = cubeGltf('cube.bin', 'textures/wood.png');
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const builtin =
  BUILTIN_CATALOG.find((e) => e.rig === null && e.category === 'furniture') ?? BUILTIN_CATALOG[0];
/** `route` answering after `ms` (a download's latency). */
const later =
  (route: Route, ms: number): Route =>
  async (req) => {
    await new Promise((r) => setTimeout(r, ms));
    return route(req);
  };
const fake = fakeFetch({
  [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
  [`${KHRONOS}StudioChair/metadata.json`]: json(KHRONOS_CHAIR_META),
  [`${KHRONOS}StudioChair/screenshot/screenshot.jpg`]: bytes(jpeg, 'image/jpeg'),
  [`${KHRONOS}StudioChair/glTF-Binary/StudioChair.glb`]: bytes(cubeGlb(), 'model/gltf-binary'),
  [`${KHRONOS}DeskLamp/metadata.json`]: json({ ...KHRONOS_CHAIR_META, name: 'Desk Lamp' }),
  [`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`]: bytes(lamp.gltf, 'model/gltf+json'),
  [`${KHRONOS}DeskLamp/glTF/cube.bin`]: bytes(lamp.bin),
  [`${KHRONOS}DeskLamp/glTF/textures/wood.png`]: bytes(lamp.png, 'image/png'),
  // only inserted over REST, with a latency: nothing of it is cached before the POST
  [`${KHRONOS}ToyTruck/metadata.json`]: later(json({ ...KHRONOS_CHAIR_META, name: 'Toy Truck' }), 100),
  [`${KHRONOS}ToyTruck/glTF-Binary/ToyTruck.glb`]: later(bytes(cubeGlb(), 'model/gltf-binary'), 300),
});

let server: TestServer;
let client: Client;
let project: string;

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const raw = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 60_000,
  })) as ToolResult;
  const text = raw.content.map((c) => c.text ?? '').join('\n');
  if (raw.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

beforeAll(async () => {
  server = await startServer({ STORE_PROVIDERS: 'builtin,khronos' }, { serviceFetch: fake.fetch });
  client = new Client({ name: 'store-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  project = (await ok('create_project', { name: 'Store test', empty: true })).id;
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('model store in the server', () => {
  it('lets an agent search, insert a multi-file glTF as one undo step, and undo it', async () => {
    const found = await ok('store_search', { query: 'lamp', providers: ['khronos'] });
    expect(found.results[0]).toMatchObject({
      id: 'khronos:DeskLamp',
      thumbnail_url: `${server.url}/api/store/models/khronos:DeskLamp/thumbnail`,
    });
    const added = await ok('store_add', {
      project,
      model: 'khronos:DeskLamp',
      location: [1, 1, 0],
      height_m: 0.6,
    });
    expect(added.entry.id).toBe('khronos:DeskLamp');
    const scene = await ok('get_scene', { project });
    const names = JSON.stringify(scene);
    expect(names).toContain(added.result.name);
    // the model's files were downloaded once
    expect(fake.count(`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`)).toBe(1);
    await ok('undo', { project });
    expect(JSON.stringify(await ok('get_scene', { project }))).not.toContain(added.result.name);
  });

  it('serves search, thumbnails, files and inserts over REST', async () => {
    const search = await api(server.url, '/api/store/search?query=chair&providers=khronos,builtin&limit=5');
    expect(search.status).toBe(200);
    expect(search.body.results.length).toBeGreaterThan(0);
    const thumb = await fetch(`${server.url}/api/store/models/khronos:StudioChair/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    const main = await fetch(`${server.url}/api/store/models/khronos:DeskLamp/files/`);
    expect(main.headers.get('content-type')).toBe('model/gltf+json');
    expect(new Uint8Array(await main.arrayBuffer())).toEqual(lamp.gltf);
    const insert = await api(server.url, `/api/projects/${project}/store`, {
      method: 'POST',
      json: { model: `builtin:${builtin.id}`, name: 'From REST' },
    });
    expect(insert.status).toBe(200);
    expect(JSON.stringify(await ok('get_scene', { project }))).toContain('From REST');
    const bad = await api(server.url, `/api/projects/${project}/store`, {
      method: 'POST',
      json: { model: 'khronos:Nope' },
    });
    expect(bad.status).toBe(404);
  });

  it('inserts an external model over REST that is not downloaded yet', async () => {
    // Node closes a POST's request as soon as its body was read: that must not cancel the download
    const insert = await api(server.url, `/api/projects/${project}/store`, {
      method: 'POST',
      json: { model: 'khronos:ToyTruck', name: 'REST truck' },
    });
    expect(insert.status, JSON.stringify(insert.body)).toBe(200);
    expect(insert.body.entry.id).toBe('khronos:ToyTruck');
    expect(fake.count(`${KHRONOS}ToyTruck/glTF-Binary/ToyTruck.glb`)).toBe(1);
    expect(JSON.stringify(await ok('get_scene', { project }))).toContain('REST truck');
  });

  it('renders a built-in thumbnail with the server renderer once, then serves it from the cache', async () => {
    const url = `${server.url}/api/store/models/builtin:${builtin.id}/thumbnail`;
    const t0 = performance.now();
    const first = await fetch(url);
    const firstMs = performance.now() - t0;
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/png');
    const png = decodePNG(new Uint8Array(await first.arrayBuffer()));
    expect([png.width, png.height]).toEqual([256, 256]);
    // transparent around the model, something drawn in the middle
    expect(png.data[3]).toBe(0);
    let opaque = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 0) opaque++;
    expect(opaque).toBeGreaterThan(256 * 256 * 0.05);
    const t1 = performance.now();
    const second = await fetch(url, { headers: { 'if-none-match': first.headers.get('etag')! } });
    const secondMs = performance.now() - t1;
    expect(second.status).toBe(304);
    expect(secondMs).toBeLessThan(Math.max(200, firstMs));
  });
});
