import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError } from '../../src/mcp/agent';
import { registerTools, type ToolContext } from '../../src/mcp/tools';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog } from '../../src/observability/log';
import { VideoExports } from '../../src/video';
import { clearFfmpegChecks } from '../../src/video/ffmpeg';
import { makeFakeFfmpeg, type FakeFfmpeg } from '../helpers/video-fake-ffmpeg';
import {
  exportScene,
  fakeContext,
  makeFakeRenderer,
  type FakeRenderer,
} from '../helpers/video-fake-renderer';

/*
 * The video export tools through an in-memory MCP client (export_video, export_status,
 * cancel_export, list_exports) over the real job service with a fake renderer and a fake ffmpeg:
 * results, projects by name, waiting, and failures with their code on a second line.
 */

let fake: FakeFfmpeg;
let client: Client;
let server: McpServer;
let exports: VideoExports;
let renderer: FakeRenderer;
let ffmpegPath: string;

beforeAll(async () => {
  fake = await makeFakeFfmpeg();
});

async function connect(o: { maxQueued?: number; ffmpeg?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-tools-'));
  const { doc } = exportScene({ shots: 2, frames: 6 });
  renderer = makeFakeRenderer();
  ffmpegPath = o.ffmpeg ?? fake.path;
  exports = new VideoExports(
    fakeContext({
      exportDir: dir,
      ffmpegPath,
      renderer: renderer.renderer,
      projects: { p1: doc },
      exportMaxQueued: o.maxQueued,
    }),
    // whatever the memory of the machine the tests run on
    { memory: () => ({ available: 2 ** 40, source: 'meminfo' }) },
  );
  const ctx = {
    historyLimits: { maxSteps: 10, maxBytes: 1 << 20 },
    metrics: new ServerMetrics({ defaultMetrics: false }),
    log: silentLog,
    exports,
    agent: {
      id: 'agent-1',
      resolveProjectId: async (ref: string) => {
        if (ref === 'p1' || ref === 'Demo') return 'p1';
        throw new NotFoundError(`Project not found: ${ref}`);
      },
    },
  } as unknown as ToolContext;
  server = new McpServer({ name: 'video-tools', version: '0' });
  registerTools(server, ctx);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'video-tools', version: '0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
}

beforeEach(() => clearFfmpegChecks());

afterEach(async () => {
  await client?.close();
  await server?.close();
  await exports?.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = res.content.map((c) => c.text).join('\n');
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* an error text */
  }
  return { isError: !!res.isError, text, body };
}

// every export spawns fake ffmpeg processes (Node scripts): slow on a busy machine
describe('video export tools', { timeout: 30_000 }, () => {
  it('starts an export, waits for it and lists it', async () => {
    await connect();
    const start = await call('export_video', { project: 'Demo', width: 32, height: 18, quality: 'draft' });
    expect(start.isError).toBe(false);
    expect(start.body).toMatchObject({ frames_total: 12 });
    expect(['queued', 'running']).toContain(start.body.status);
    expect(start.body.estimate_s).toBeGreaterThan(0);
    const id = start.body.export as string;
    let status = await call('export_status', { export: id, wait_s: 20 });
    for (let i = 0; i < 20 && !['done', 'failed'].includes(status.body.status); i++)
      status = await call('export_status', { export: id, wait_s: 20 });
    expect(status.body.status).toBe('done');
    expect(status.body.progress).toMatchObject({ frames_done: 12, frames_total: 12 });
    const clip = status.body.files.find((f: { name: string }) => f.name === 'shot-01-wide.mp4');
    // no HTTP request behind an in-memory call: the link stays the route
    expect(clip.url).toBe(`/api/projects/p1/video-exports/${id}/files/shot-01-wide.mp4`);
    const list = await call('list_exports', { project: 'Demo' });
    expect(list.body.exports.map((j: { id: string }) => j.id)).toEqual([id]);
    expect((await call('list_exports', {})).body.exports).toHaveLength(1);
  });

  it('cancels a queued export and deletes it with its files', async () => {
    await connect();
    renderer.delayMs = 50;
    const a = await call('export_video', { project: 'p1', width: 32, height: 18 });
    const b = await call('export_video', { project: 'p1', width: 32, height: 18, label: 'second' });
    const cancelled = await call('cancel_export', { export: b.body.export });
    expect(cancelled.body.status).toBe('cancelled');
    const gone = await call('cancel_export', { export: a.body.export, delete_files: true });
    expect(gone.body.status).toBe('cancelled');
    const after = await call('export_status', { export: a.body.export });
    expect(after.isError).toBe(true);
    const [first, ...rest] = after.text.split('\n');
    expect(first).toMatch(/not found/);
    expect(rest.join('\n')).not.toMatch(/FFMPEG/);
  });

  it('fails with the code on a second line', async () => {
    await connect({ ffmpeg: '/nonexistent/ffmpeg' });
    const r = await call('export_video', { project: 'p1' });
    expect(r.isError).toBe(true);
    const [first, ...rest] = r.text.split('\n');
    expect(first).toMatch(/^Video export needs ffmpeg/);
    expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'FFMPEG_UNAVAILABLE' });
  });

  it('refuses a full queue with QUEUE_FULL', async () => {
    await connect({ maxQueued: 1 });
    renderer.delayMs = 100;
    await call('export_video', { project: 'p1', width: 32, height: 18 });
    await call('export_video', { project: 'p1', width: 32, height: 18 });
    const r = await call('export_video', { project: 'p1', width: 32, height: 18 });
    expect(r.isError).toBe(true);
    const [first, ...rest] = r.text.split('\n');
    expect(first).toMatch(/EXPORT_MAX_QUEUED is 1/);
    expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'QUEUE_FULL' });
  });

  it('checks its arguments', async () => {
    await connect();
    expect((await call('export_status', { export: 'x', wait_s: 51 })).isError).toBe(true);
    expect((await call('export_video', { project: 'p1', width: 33 })).isError).toBe(true);
    expect((await call('export_video', { project: 'p1', passes: ['albedo'] })).isError).toBe(true);
    const typo = await call('export_video', { project: 'p1', qualty: 'draft' });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/quality/);
    const unknown = await call('export_video', { project: 'Nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Project not found: Nope/);
  });
});
