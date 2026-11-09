import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { geometryMemoryCheck, setGeometryMemoryCheck, type GeometryMemoryCheck } from '@3d-editor/core';
import { geometryCheck } from '../../src/render/memory';
import { startServer, type TestServer } from '../helpers/app';

/*
 * The server evaluates scenes in its own process (scene summaries, operators), where running out
 * of JavaScript heap stops the whole server: a Subdivision Surface whose result does not fit into
 * the server's free heap is skipped with an explained modifier error instead (get_scene reports
 * it, Apply refuses it), and the server keeps answering. The server's free heap is replaced by a
 * fixed 300 MB here, so that 1,000,000 faces (about 668 MB) do not fit, like 4,000,000 faces do not
 * with the real free heap of about 1.8 GB.
 */

let server: TestServer;
let client: Client;
let installed: GeometryMemoryCheck | null = null;

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as ToolResult;
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await call(name, args);
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const MB = 1024 * 1024;

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'memory-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  installed = geometryMemoryCheck();
});

afterAll(async () => {
  setGeometryMemoryCheck(installed);
  await client?.close();
  await server?.close();
  await server?.cleanup();
});

describe("evaluations in the server's process", () => {
  it('skip a modifier whose result does not fit into the free heap, with an explained error, and keep serving', async () => {
    // the server checks every modifier it evaluates against its own free heap
    expect(installed).toBeTypeOf('function');
    setGeometryMemoryCheck(geometryCheck({ heapFree: () => 300 * MB, collect: () => undefined }));

    const { id } = await ok('create_project', { name: 'terrain', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_grid_add',
      params: { x_subdivisions: 125, y_subdivisions: 125, size: 10 },
    });
    await ok('run_operator', {
      project: id,
      operator: 'object.modifier_add',
      params: { type: 'SUBSURF', params: { levels: 3, render_levels: 3 } },
    });
    const t0 = performance.now();
    const scene = await ok('get_scene', { project: id });
    // answered at once: the 1,000,000 faces were never computed
    expect(performance.now() - t0).toBeLessThan(10_000);
    const message =
      "skipped on the server: this Subdivision Surface would need about 668 MB of JavaScript heap for a result of about 1,000,000 faces, and the server's process has 300 MB";
    const problems = (scene.problems ?? []) as { source: string; object: string; message: string }[];
    expect(problems).toContainEqual(
      expect.objectContaining({
        source: 'modifier',
        object: 'Grid',
        message: expect.stringContaining(message),
      }),
    );
    expect(problems.find((p) => p.source === 'modifier')!.message).toMatch(
      / heap free and keeps 256 MB of it for its other work\. Lower render_levels to evaluate it on the server \(a browser editor evaluates it itself\)$/,
    );

    // Apply computes the stack itself: refused the same way, the modifier stays
    const apply = await call('run_operator', {
      project: id,
      operator: 'object.modifier_apply',
      params: { modifier: 'Subdivision' },
    });
    expect(apply.isError).toBe(true);
    expect(apply.content[0].text).toContain(message);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);

    // with room for it, the same evaluation runs (no result was kept from the refusal)
    setGeometryMemoryCheck(geometryCheck({ heapFree: () => 2000 * MB, collect: () => undefined }));
    await ok('run_operator', {
      project: id,
      operator: 'object.modifier_set',
      params: { modifier: 'Subdivision', params: { levels: 2, render_levels: 2 } },
    });
    const after = await ok('get_scene', { project: id });
    expect(((after.problems ?? []) as { source: string }[]).filter((p) => p.source === 'modifier')).toEqual(
      [],
    );
  });
});
