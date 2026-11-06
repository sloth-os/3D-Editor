import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import * as Y from 'yjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, type TestServer } from '../helpers/app';

/*
 * Server memory under repeated rebuilds (phase 3, lighthouse-cove: the server reached its 2 GB heap
 * limit after ~30 minutes of rebuilding the project through MCP). Every item an agent's change
 * deleted was kept by its Y.UndoManager forever — every replaced mesh version, plus a decoded copy
 * of each in the document's mesh cache — for as long as the project stayed loaded, and it was saved
 * with the document. The agent undo histories are now bounded (MCP_UNDO_STEPS / MCP_UNDO_MEMORY_MB)
 * and what they drop, or keep when they end, is garbage collected.
 *
 * Each build: an 80×80 grid (6,561 vertices, ~0.5 MB per mesh version), a batch of 20 vertex paint
 * dabs (one undo step that replaces the mesh 20 times) and 10 more dabs as separate calls.
 */

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const UNDO_STEPS = 20;
const UNDO_MEMORY_MB = 8;

let server: TestServer;

const transports = new WeakMap<Client, StreamableHTTPClientTransport>();

async function connect(agentId?: string): Promise<Client> {
  const client = new Client({ name: 'memory-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: agentId ? { headers: { 'x-mcp-agent-id': agentId } } : undefined,
  });
  await client.connect(transport);
  transports.set(client, transport);
  return client;
}

/** Ends the session on the server (HTTP DELETE, as scripts/mcp.mjs does) and disconnects. */
async function disconnect(client: Client): Promise<void> {
  await transports.get(client)?.terminateSession();
  await client.close();
}

async function ok(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Builds the scene into an (empty) project. */
async function build(client: Client, project: string): Promise<void> {
  const grid = await ok(client, 'add_object', {
    project,
    type: 'grid',
    name: 'Ground',
    params: { x_subdivisions: 80, y_subdivisions: 80, size: 8 },
  });
  const object = grid.name ?? 'Ground';
  const dab = (i: number) => ({
    object,
    points: [[-3.5 + (i % 8), -3.5 + Math.floor(i / 8), 0]],
    radius: 0.6,
    strength: 1,
    color: [(i % 5) / 5, (i % 3) / 3, (i % 7) / 7, 1],
  });
  const batch = await ok(client, 'batch', {
    project,
    operations: Array.from({ length: 20 }, (_, i) => ({ operator: 'paint.vertex_color_stroke', params: dab(i) })),
  });
  expect(batch.failed ?? 0).toBe(0);
  for (let i = 20; i < 30; i++)
    await ok(client, 'run_operator', { project, operator: 'paint.vertex_color_stroke', params: dab(i) });
}

/** Size of the project's document as saved and synced (includes everything undo keeps). */
function docBytes(projectId: string): number {
  const room = server.handle.rooms.get(projectId);
  if (!room) throw new Error(`project ${projectId} is not loaded`);
  return Y.encodeStateAsUpdate(room.scene.ydoc).byteLength;
}

/** JS heap and array buffers after a full garbage collection, in MB. */
async function memoryMb(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setImmediate(r));
    gc();
  }
  const m = process.memoryUsage();
  return (m.heapUsed + m.arrayBuffers) / 1048576;
}

const MB = 1048576;

beforeAll(async () => {
  server = await startServer({
    MCP_UNDO_STEPS: String(UNDO_STEPS),
    MCP_UNDO_MEMORY_MB: String(UNDO_MEMORY_MB),
    RENDER_WORKERS: '0',
  });
});

afterAll(async () => {
  await server?.close();
  await server?.cleanup();
});

describe('server memory under repeated rebuilds', () => {
  it('rebuilding the same project many times keeps memory and the document bounded', async () => {
    // one agent id (like scripts/mcp.mjs): its undo history outlives the sessions
    const client = await connect('memory-rebuilds');
    const { id } = await ok(client, 'create_project', { name: 'Rebuilds', empty: true });
    const sizes: number[] = [];
    const heaps: number[] = [];
    for (let round = 0; round < 6; round++) {
      const scene = await ok(client, 'get_scene', { project: id, max_objects: 50 });
      const names = (scene.objects ?? []).map((o: { name: string }) => o.name);
      if (names.length) await ok(client, 'delete_objects', { project: id, objects: names });
      await build(client, id);
      await new Promise((r) => setImmediate(r));
      sizes.push(docBytes(id));
      heaps.push(await memoryMb());
    }
    const live = (await ok(client, 'get_scene', { project: id })).counts;
    expect(live.objects).toBe(1);
    // the history keeps at most UNDO_MEMORY_MB of replaced data: the document stays below the
    // live scene plus that budget, round after round (it grew by ~15 MB per round before)
    const budget = UNDO_MEMORY_MB * MB;
    for (const s of sizes) expect(s).toBeLessThan(budget + 4 * MB);
    expect(sizes[5] - sizes[1]).toBeLessThan(2 * MB);
    // memory: bounded too (it grew by ~50 MB per round: old mesh versions and their decoded copies)
    expect(heaps[5] - heaps[1], `heap after each round (MB): ${heaps.map((h) => h.toFixed(0)).join(', ')}`).toBeLessThan(40);
    // undo still works within the history (16 steps of ~0.5 MB fit the 8 MB budget)
    const undone = await ok(client, 'undo', { project: id, steps: 100 });
    expect(undone.undone).toBeGreaterThan(10);
    expect(undone.undone).toBeLessThanOrEqual(UNDO_STEPS);
    expect(undone.note).toMatch(/keeps the last 20 steps and at most 8 MB .* older step\(s\) were dropped/);
    await disconnect(client);
  });

  it('a deleted project is not kept alive by other sessions or agent ids that worked on it', async () => {
    const builder = await connect('memory-builder'); // agent id: its history outlives sessions
    const viewer = await connect(); // another live session that looked at the project
    const deleter = await connect();
    const { id } = await ok(deleter, 'create_project', { name: 'Doomed', empty: true });
    await build(builder, id);
    await ok(viewer, 'get_scene', { project: id });
    const doc = new WeakRef(server.handle.rooms.get(id)!.scene.ydoc);
    await ok(deleter, 'delete_project', { project: id, confirm: true });
    await memoryMb(); // collects garbage
    expect(doc.deref(), 'the deleted project document is still reachable').toBeUndefined();
    // the sessions carry on
    expect((await ok(viewer, 'list_projects', {})).projects.some((p: { id: string }) => p.id === id)).toBe(false);
    const next = await ok(builder, 'create_project', { name: 'Next', empty: true });
    await ok(builder, 'add_object', { project: next.id, type: 'cube' });
    expect((await ok(builder, 'undo', { project: next.id })).undone).toBe(1);
    for (const c of [builder, viewer, deleter]) await disconnect(c);
  });

  it('a build session that ends releases what its history kept; deleted projects free everything', async () => {
    const sizes: number[] = [];
    const heaps: number[] = [];
    let last = '';
    for (let round = 0; round < 4; round++) {
      // a new session without an agent id per build, like examples/*/build.mjs
      const client = await connect();
      const list = await ok(client, 'list_projects', {});
      for (const p of list.projects.filter((x: { name: string }) => x.name === 'Rebuilt'))
        await ok(client, 'delete_project', { project: p.id, confirm: true });
      const { id } = await ok(client, 'create_project', { name: 'Rebuilt', empty: true });
      await build(client, id);
      await disconnect(client);
      last = id;
      await new Promise((r) => setTimeout(r, 50));
      sizes.push(docBytes(id));
      heaps.push(await memoryMb());
    }
    // the session's history is gone: the document holds the live scene only (~1 MB, was ~15 MB)
    for (const s of sizes) expect(s).toBeLessThan(2 * MB);
    expect(heaps[3] - heaps[1], `heap after each round (MB): ${heaps.map((h) => h.toFixed(0)).join(', ')}`).toBeLessThan(25);
    expect(server.handle.rooms.get(last)).toBeTruthy();
  });
});
