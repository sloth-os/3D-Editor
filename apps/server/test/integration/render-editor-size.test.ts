import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sharedRenderer } from '../../src/render';
import type { Room } from '../../src/sync/room';
import { eventually, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

/*
 * Renderer 'auto' renders on the server, without asking a browser editor, for 120 s after that
 * editor needed longer than 'auto' waits (15 s) for a RASTER image (mcp/rendering.ts
 * slowBrowserRaster). render_image notes the size of every RASTER image it asks an editor for, so
 * that a slow large image does not keep a smaller one from the editor: a 2048 × 2048 image that took
 * 32 s says that a 1280 × 720 one takes about 7 s. The editor here answers at once, and the room
 * reports its 2048 × 2048 image as one that took 32 s.
 */

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server: TestServer;
let client: Client;
let browser: SyncTestClient | undefined;

async function render(args: Record<string, unknown>): Promise<{ renderer: string; note?: string }> {
  const res = (await client.callTool({ name: 'render_image', arguments: args }, undefined, {
    timeout: 120_000,
  })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  expect(res.isError, text).toBeFalsy();
  return JSON.parse(text) as { renderer: string; note?: string };
}

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'render-size-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await browser?.destroy();
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe("renderer 'auto' after a slow RASTER image of a browser editor", () => {
  it('asks the editor again for a smaller image it draws in time, not for one as large', async () => {
    const created = await client.callTool({ name: 'create_project', arguments: { name: 'Image sizes' } });
    const { id } = JSON.parse((created as { content: { text: string }[] }).content[0].text) as { id: string };
    browser = new SyncTestClient({
      baseUrl: server.url,
      projectId: id,
      name: 'Browser',
      capabilities: ['render', 'ui'],
      rpcHandler: (method: string, params: any) =>
        method === 'render'
          ? { mime: 'image/png', data_base64: TINY_PNG, width: params.width, height: params.height }
          : { done: params.command },
    });
    await browser.connect();
    await eventually(() => server.handle.rooms.get(id)?.rpcCandidates('render').length === 1);
    const room = server.handle.rooms.get(id) as Room;

    const big = await render({
      project: id,
      renderer: 'browser',
      engine: 'RASTER',
      width: 2048,
      height: 2048,
    });
    expect(big.renderer).toBe('browser');
    // the editor's answer to that image now counts as taking 32 s
    const conn = room.pickRpcTarget('render')!;
    const bigAt = room.lastAnswer(conn, { method: 'render', engine: 'RASTER' })!.sentAt;
    const real = room.lastAnswer.bind(room);
    room.lastAnswer = (c, kind) => {
      const a = real(c, kind);
      return a && a.sentAt === bigAt ? { ...a, tookMs: 32_000 } : a;
    };

    // as large as the slow one: on the server, and the note says why
    const same = await render({ project: id, engine: 'RASTER', width: 2048, height: 2048 });
    expect(same.renderer).toBe('software');
    expect(same.note).toMatch(
      /^the browser editor needed 32 s for its last RASTER image, longer than renderer 'auto' waits \(15 s\): renderer 'auto' renders on the server and asks that editor again 120 s after that image/,
    );
    // smaller, but more than 15 s worth of its pixels: on the server too, with the time scaled
    const wide = await render({ project: id, engine: 'RASTER', width: 2048, height: 1080 });
    expect(wide.renderer).toBe('software');
    expect(wide.note).toMatch(
      /^the browser editor needed 32 s for its last RASTER image \(4,194,304 pixels\), about 17 s for this image's 2,211,840 pixels, longer than renderer 'auto' waits \(15 s\)/,
    );
    // 921,600 pixels take about 7 s at that pace: within the 15 s 'auto' waits
    const small = await render({ project: id, engine: 'RASTER', width: 1280, height: 720 });
    expect(small.renderer).toBe('browser');
    expect(small.note).toBeUndefined();
  });
});
