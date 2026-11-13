import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decodePNG } from '@3d-editor/core';
import { sharedRenderer } from '../../src/render';
import { startServer, type TestServer } from '../helpers/app';

/*
 * A server render that runs out of memory never takes the server down: render processes are
 * child processes, so only the render process ends; the call is answered with an explained error,
 * the server keeps answering health checks and MCP calls meanwhile, and the next render gets a new
 * process. A small heap limit for the render processes (RENDER_WORKER_MEMORY_MB) makes a grid of
 * 980,000 triangles run out of memory in about a second, like a scene of several million triangles
 * does with the default limit (a grid of 500 × 500 quads still renders with 128 MB).
 */

// the process-wide renderer used by the MCP tools: one render process with a heap of 128 MB
process.env.RENDER_WORKERS = '1';
process.env.RENDER_WORKER_MEMORY_MB = '128';

let server: TestServer;
let client: Client;

type ToolResult = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as ToolResult;
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await call(name, args);
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'oom-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('server render out of memory', () => {
  it('answers the render with an explained error, keeps serving meanwhile and renders again in a new process', async () => {
    const { id: big } = await ok('create_project', { name: 'Huge grid', empty: true });
    await ok('run_operator', {
      project: big,
      operator: 'mesh.primitive_grid_add',
      params: { x_subdivisions: 700, y_subdivisions: 700, size: 2 },
    });
    const args = { renderer: 'software', engine: 'RASTER', shading: 'SOLID', width: 320, height: 180 };
    let settled = false;
    const render = call('render_image', { project: big, ...args }).finally(() => (settled = true));
    // health checks and other MCP calls are answered while the render runs and its process dies
    let checks = 0;
    while (!settled) {
      const health = await fetch(`${server.url}/healthz`);
      expect(health.status).toBe(200);
      expect((await ok('list_projects')).projects.length).toBeGreaterThanOrEqual(1);
      checks++;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(checks).toBeGreaterThan(0);
    const res = await render;
    expect(res.isError).toBe(true);
    // the message, then the code as JSON on the next line
    expect(res.content[0].text).toBe(
      'Rendering failed: out of memory: the render process ran out of its 128 MB JavaScript heap; the server ' +
        'keeps running and starts a new render process for the next render. The scene needs more memory than a ' +
        'server render has. A server render loads and evaluates every mesh of the scene with its modifiers at ' +
        'their render settings, also meshes hidden from renders (hide_render): lower the render levels ' +
        '(render_levels) of Subdivision Surface modifiers or the number of particle instances, delete meshes the ' +
        "project no longer needs, or render in a browser editor that has the project open (renderer 'browser').\n" +
        JSON.stringify({ code: 'OUT_OF_MEMORY' }, null, 2),
    );
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    // a new render process renders the next scene
    const { id: small } = await ok('create_project', { name: 'Small' });
    const image = await call('render_image', { project: small, ...args });
    expect(image.isError).toBeFalsy();
    const png = image.content.find((c) => c.type === 'image')!.data!;
    expect(decodePNG(Buffer.from(png, 'base64'))).toMatchObject({ width: 320, height: 180 });
    expect(JSON.parse(image.content.find((c) => c.type === 'text')!.text!)).toMatchObject({
      renderer: 'software',
      engine: 'RASTER',
      threads: 1,
    });
  });

  it('answers an export that runs out of memory with what an export can lower, and so does the REST API', async () => {
    const { id } = await ok('create_project', { name: 'Huge export', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_grid_add',
      params: { x_subdivisions: 700, y_subdivisions: 700, size: 2 },
    });
    const replaced = 'the server keeps running and starts a new render process for the next render';
    const res = await call('export_scene', { project: id, format: 'glb' });
    expect(res.isError).toBe(true);
    const [message, ...json] = res.content[0].text!.split('\n');
    expect(message).toMatch(/^Export failed: out of memory: the render process /);
    expect(message).toContain(
      `${replaced}. The export needs more memory than a render process has. An export loads and evaluates ` +
        'every mesh of the scene with its modifiers at their render settings, whichever objects it writes and ' +
        'also with apply_modifiers: false: lower the render levels (render_levels) of Subdivision Surface ' +
        'modifiers or delete meshes the project no longer needs. Writing the file needs memory too, less with ' +
        "fewer objects (objects), base meshes (apply_modifiers: false), fewer particle instances or format 'glb'.",
    );
    expect(JSON.parse(json.join('\n'))).toEqual({ code: 'OUT_OF_MEMORY' });
    // REST: 507 with the message and a code, for the render and the export
    const png = await fetch(`${server.url}/api/projects/${id}/render.png?width=320&height=180&shading=SOLID`);
    expect(png.status).toBe(507);
    expect(await png.json()).toEqual({
      error: `render failed: out of memory: the render process ran out of its 128 MB JavaScript heap; ${replaced}`,
      code: 'OUT_OF_MEMORY',
    });
    const glb = await fetch(`${server.url}/api/projects/${id}/export?format=glb`);
    expect(glb.status).toBe(507);
    expect(await glb.json()).toMatchObject({
      error: expect.stringMatching(/^export failed: out of memory: the render process /),
      code: 'OUT_OF_MEMORY',
    });
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });
});
