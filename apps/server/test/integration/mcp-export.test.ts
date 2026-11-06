import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { exportScene } from '@3d-editor/core';
import { startServer, type TestServer } from '../helpers/app';

/*
 * Exports run on a render thread (phase 3 item: export_scene ran on the server's event loop, and
 * the per-frame animation sampling of a glTF export made it take seconds, during which the server
 * answered nothing: not /healthz, not the editors' sync, not other agents).
 *
 * The scene: 30 cubes whose rotation is keyed over 3,000 frames; a GLB export samples every frame.
 */

process.env.RENDER_WORKERS = '2';

let server: TestServer;
let client: Client;
let projectId = '';

type ToolResult = {
  content: { type: string; text?: string; resource?: { blob?: string; mimeType?: string } }[];
  isError?: boolean;
};

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
}

async function ok(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await call(name, args);
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

/**
 * Polls /healthz every 10 ms from a worker thread (its own event loop: a probe on the server's
 * thread would stall together with the server and never see the stall).
 */
const PROBE = `
const { parentPort, workerData } = require('node:worker_threads');
let running = true;
const latencies = [];
parentPort.on('message', () => { running = false; });
(async () => {
  while (running) {
    const t = performance.now();
    try { await fetch(workerData.url).then((r) => r.text()); } catch {}
    latencies.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 10));
  }
  parentPort.postMessage(latencies);
})();
`;

/**
 * Runs `work` while /healthz is probed from another thread and the event loop delay of this
 * thread (the server's) is recorded; returns its result, its duration and the worst latencies.
 */
async function whileProbing<T>(
  work: () => Promise<T>,
): Promise<{ result: T; ms: number; maxHealthMs: number; maxLoopDelayMs: number; probes: number }> {
  const probe = new Worker(PROBE, { eval: true, workerData: { url: `${server.url}/healthz` } });
  const latencies = new Promise<number[]>((resolve) => probe.once('message', resolve));
  await new Promise((r) => setTimeout(r, 100));
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const t0 = performance.now();
  const result = await work();
  const ms = performance.now() - t0;
  loop.disable();
  probe.postMessage('stop');
  const lat = await latencies;
  await probe.terminate();
  return {
    result,
    ms,
    maxHealthMs: Math.max(...lat),
    maxLoopDelayMs: loop.max / 1e6,
    probes: lat.length,
  };
}

beforeAll(async () => {
  server = await startServer();
  client = new Client({ name: 'export-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  projectId = (await ok('create_project', { name: 'Long export', empty: true })).id;
  await ok('batch', {
    project: projectId,
    operations: Array.from({ length: 30 }, (_, i) => ({
      operator: 'mesh.primitive_cube_add',
      params: { location: [i * 3, 0, 0], size: 1 },
    })),
  });
  await ok('set_scene_settings', { project: projectId, frame_end: 3000 });
  const scene = await ok('get_scene', { project: projectId, max_objects: 100 });
  for (const o of scene.objects) {
    await ok('insert_keyframe', { project: projectId, object: o.name, property: 'rotation_euler', frame: 1 });
    await ok('insert_keyframe', {
      project: projectId,
      object: o.name,
      property: 'rotation_euler',
      frame: 3000,
      value: [0, 0, 6.28],
    });
  }
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  await server?.cleanup();
});

describe('exports on a render thread', () => {
  it('export_scene keeps the server responsive and gives the same file as an export on the main thread', async () => {
    const { result, ms, maxHealthMs, maxLoopDelayMs, probes } = await whileProbing(() =>
      call('export_scene', { project: projectId, format: 'glb', frame: 1 }),
    );
    expect(result.isError, JSON.stringify(result.content).slice(0, 300)).toBeFalsy();
    const info = JSON.parse(result.content[0].text!);
    expect(info.bytes).toBeGreaterThan(10_000);
    expect(info.elapsed_ms).toBeGreaterThan(0);
    // the export takes a while (every one of the 3,000 frames is sampled) …
    expect(ms).toBeGreaterThan(300);
    // … and the server answers meanwhile (it answered nothing for the whole export before)
    const bound = Math.max(250, ms / 3);
    expect(maxHealthMs, `slowest /healthz during a ${Math.round(ms)} ms export`).toBeLessThan(bound);
    expect(maxLoopDelayMs, `event loop delay during a ${Math.round(ms)} ms export`).toBeLessThan(bound);
    expect(probes).toBeGreaterThan(5);
    // the same file as core exportScene on the document (the render thread exports that state)
    const blob = result.content.find((c) => c.type === 'resource')?.resource?.blob;
    expect(blob).toBeTruthy();
    const room = server.handle.rooms.get(projectId)!;
    const local = exportScene(room.scene, 'glb', { frame: 1 });
    expect(Buffer.from(blob!, 'base64').equals(Buffer.from(local.data))).toBe(true);
  });

  it('GET /api/projects/:id/export keeps the server responsive', async () => {
    const { result, ms, maxHealthMs, maxLoopDelayMs } = await whileProbing(async () => {
      const res = await fetch(`${server.url}/api/projects/${projectId}/export?format=glb`);
      return {
        status: res.status,
        bytes: (await res.arrayBuffer()).byteLength,
        time: res.headers.get('x-export-time-ms'),
      };
    });
    expect(result.status).toBe(200);
    expect(result.bytes).toBeGreaterThan(10_000);
    expect(Number(result.time)).toBeGreaterThan(0);
    const bound = Math.max(250, ms / 3);
    expect(maxHealthMs, `slowest /healthz during a ${Math.round(ms)} ms export`).toBeLessThan(bound);
    expect(maxLoopDelayMs, `event loop delay during a ${Math.round(ms)} ms export`).toBeLessThan(bound);
  });

  it('reports export failures and keeps working afterwards', async () => {
    const bad = await call('export_scene', { project: projectId, format: 'stl', objects: ['Nope'] });
    expect(bad.isError).toBe(true);
    const obj = await ok('export_scene', { project: projectId, format: 'obj' });
    expect(obj.bytes).toBeGreaterThan(1000);
  });
});
