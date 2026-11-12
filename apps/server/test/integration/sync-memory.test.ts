import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  OUT_OF_MEMORY_CLOSE_CODE,
  ProjectFileStore,
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  newUuid,
  type ControlMessage,
} from '@3d-editor/core';
import { DiskFileStore } from '../../src/persistence/disk';
import { SyncTestClient } from '../helpers/sync-client';

/*
 * The changes browser editors send are held against what the server keeps for a project, as the
 * operators of agents are (sync/room.ts, sync/project-memory.ts): a sync client that kept adding
 * linked cubes ended a server of Node's default heap at about 60,000 (round 11). The server runs here
 * as its own process with a heap of 640 MB and disk persistence: it keeps 216 MB of its 688 MB heap
 * for one project (render/memory.ts maxProjectMeshBytes), about 5,100 linked cubes with their saves
 * (11,000 bytes each and 33,000 more while saved). Two projects are stored before it starts: 'Past',
 * of 5,500 cubes, which it loads although it is past that limit, and 'Huge', of 15,000 cubes, which
 * it does not load (loading and saving it would take about 709 MB).
 */

const HEAP_MB = 640;
const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));

interface ServerProcess {
  child: ChildProcess;
  url: string;
  output: () => string;
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

let dataDir: string;
let server: ServerProcess;
let agent: Client;
const clients: SyncTestClient[] = [];
const stored = { past: '', huge: '' };

/** The URL of the 'server listening' log line (JSON lines at LOG_LEVEL info). */
function listeningUrl(log: string): string | null {
  for (const line of log.split('\n')) {
    if (!line.includes('"server listening"')) continue;
    try {
      const url = (JSON.parse(line) as { url?: string }).url;
      if (url) return url.replace(/\/$/, '');
    } catch {
      // a line that is not complete yet
    }
  }
  return null;
}

/** Starts the server from source (tsx) as its own process group, with disk persistence in `dir`. */
async function startServerProcess(dir: string): Promise<ServerProcess> {
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, '--import', 'tsx', path.join(SERVER_DIR, 'src', 'main.ts')],
    {
      cwd: SERVER_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PORT: '0',
        HOST: '127.0.0.1',
        DATA_DIR: dir,
        SYNC_PERSISTENCE: 'disk',
        PERSIST_DEBOUNCE_MS: '200',
        PUBLIC_DIR: path.join(dir, 'no-public'),
        LOG_LEVEL: 'info',
        RENDER_WORKERS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let log = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (log += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (log += d));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`the server did not start within 30 s:\n${log}`)), 30_000);
    const poll = setInterval(() => {
      const found = listeningUrl(log);
      if (found) done(null, found);
    }, 50);
    const onExit = (code: number | null, signal: string | null) =>
      done(new Error(`the server ended (${code ?? signal}) before it listened:\n${log}`));
    child.once('exit', onExit);
    function done(err: Error | null, found?: string) {
      clearTimeout(timer);
      clearInterval(poll);
      child.off('exit', onExit);
      if (err) reject(err);
      else resolve(found!);
    }
  });
  return { child, url, output: () => log };
}

/** Stops the server's process group: SIGTERM, then SIGKILL after 10 s. */
async function stopServerProcess(s: ServerProcess | undefined): Promise<void> {
  const pid = s?.child.pid;
  if (!s || !pid) return;
  const ended = new Promise<void>((resolve) => {
    if (s.child.exitCode !== null || s.child.signalCode !== null) resolve();
    else s.child.once('exit', () => resolve());
  });
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // the group has ended
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 10_000);
  await ended;
  clearTimeout(timer);
  signal('SIGKILL');
}

/** A browser editor's document with core's operators, as a browser runs them. */
function operators(scene: SceneDoc) {
  const registry = createOperatorRegistry();
  const ctx = {
    doc: scene,
    state: createEditorState(),
    origin: { type: 'browser' },
    source: 'test',
    report: () => undefined,
  } as never;
  return (op: string, params: unknown) => {
    const r = registry.run(ctx, op, params) as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(`${op}: ${r.error}`);
  };
}

/** Stores a project of `count` linked cubes named `name` in the server's data folder. */
async function storeProject(name: string, count: number): Promise<string> {
  const scene = SceneDoc.create({ name, empty: true });
  const run = operators(scene);
  run('mesh.primitive_cube_add', { name: 'Cube' });
  // (at most 10,000 copies at a time)
  for (let made = 1; made < count;) {
    const k = Math.min(count - made, 9_999);
    run('object.array_place', {
      objects: ['Cube'],
      linked: true,
      count: k + 1,
      offset: [0.01, made * 0.001, 0],
    });
    made += k;
  }
  const id = newUuid();
  const store = new ProjectFileStore(new DiskFileStore(path.join(dataDir)), '/');
  const now = new Date().toISOString();
  await store.syncDocument(id, scene.ydoc, {
    info: () =>
      ({
        id,
        name,
        created_at: now,
        updated_at: now,
        stats: { objects: count, vertices: 0, faces: 0 },
      }) as never,
  });
  scene.destroy();
  return id;
}

function client(projectId: string, name: string): SyncTestClient {
  const c = new SyncTestClient({ baseUrl: server.url, projectId, name });
  clients.push(c);
  return c;
}

/** The control error a client got with code OUT_OF_MEMORY. */
function outOfMemory(c: SyncTestClient): string | undefined {
  const e = c.controls.find((m): m is Extract<ControlMessage, { kind: 'error' }> => m.kind === 'error');
  return e?.code === 'OUT_OF_MEMORY' ? e.message : undefined;
}

async function healthy(): Promise<void> {
  expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  expect(server.child.exitCode, server.output().slice(-1500)).toBeNull();
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await agent.callTool({ name, arguments: args }, undefined, { timeout: 45_000 })) as ToolResult;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), '3d-editor-sync-memory-'));
  stored.past = await storeProject('Past', 5_500);
  stored.huge = await storeProject('Huge', 15_000);
  server = await startServerProcess(dataDir);
  agent = new Client({ name: 'sync-memory-agent', version: '1.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.destroy().catch(() => undefined)));
  await agent?.close().catch(() => undefined);
  await stopServerProcess(server);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe(`sync clients of a server process with a ${HEAP_MB} MB heap`, () => {
  it('refuses changes the project cannot take: the error, the close code, nothing applied, the others go on', async () => {
    const res = await fetch(`${server.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Flood', empty: true }),
    });
    const { id } = (await res.json()) as { id: string };
    const a = client(id, 'A');
    const b = client(id, 'B');
    await a.connect(20_000);
    await b.connect(20_000);
    const run = operators(a.scene);
    run('mesh.primitive_cube_add', { name: 'Cube' });
    await b.waitFor(() => b.scene.objectIds().length === 1, 10_000, 'the first cube');
    // 6,000 linked cubes: 63 MB kept and 189 MB more while saved, past the 216 MB of one project
    run('object.array_place', { objects: ['Cube'], linked: true, count: 6_001, offset: [0.01, 0, 0] });
    await a.waitFor(() => a.closeCode !== null, 15_000, 'the close');
    expect(a.closeCode).toBe(OUT_OF_MEMORY_CLOSE_CODE);
    expect(outOfMemory(a)).toMatch(
      /^changes not applied on the server: they add 6,000 new objects to the project, and the project's meshes, objects, keyframes and images would then take about 63 MB of memory \(now 0 MB with 1 object\), and a save of it about 189 MB more for a moment \(3 times what its objects, datablocks and keyframes take, 5 times its images\): 252 MB in all, more than the 21\d MB the server's process keeps for one project \(half of its 68\d MB heap less the 256 MB it keeps for its other work\)\. Delete objects and meshes the project no longer needs, then Save \(Ctrl\+S\) to send it to the server again$/,
    );
    await wait(300);
    // nothing of them reached the server or the other client, which goes on
    expect(b.scene.objectIds()).toHaveLength(1);
    expect(b.connected).toBe(true);
    const listed = (await (await fetch(`${server.url}/api/projects/${id}`)).json()) as {
      stats: { objects: number };
    };
    expect(listed.stats.objects).toBe(1);
    operators(b.scene)('mesh.primitive_uv_sphere_add', { name: 'Ball' });
    const back = client(id, 'Check');
    await back.connect(20_000);
    await back.waitFor(() => !!back.scene.findObjectByName('Ball'), 10_000, 'the ball');
    expect(back.scene.objectIds()).toHaveLength(2);
    await healthy();
  });

  it('applies changes and deletions of a project past its limit, and refuses what adds to it', async () => {
    const c = client(stored.past, 'C');
    await c.connect(30_000);
    expect(c.scene.objectIds()).toHaveLength(5_500);
    const first = c.scene.findObjectByName('Cube')!.id;
    c.scene.updateObject(first, { location: [7, 7, 7] });
    // (core's removeObject reads the whole scene: about 50 ms each here)
    const ids = c.scene
      .objectIds()
      .filter((o) => o !== first)
      .slice(0, 10);
    c.scene.transact(() => ids.forEach((o) => c.scene.removeObject(o)));
    // the server applied them (its listing counts the objects of the room)
    const deadline = Date.now() + 15_000;
    let objects = 0;
    while (Date.now() < deadline && objects !== 5_490) {
      await wait(100);
      objects = (
        (await (await fetch(`${server.url}/api/projects/${stored.past}`)).json()) as {
          stats: { objects: number };
        }
      ).stats.objects;
    }
    expect(objects).toBe(5_490);
    const moved = await call('get_object', { project: stored.past, object: 'Cube' });
    expect(JSON.parse(moved.content[0]!.text!).location).toEqual([7, 7, 7]);
    expect(c.connected).toBe(true);
    operators(c.scene)('mesh.primitive_cube_add', { name: 'More' });
    await c.waitFor(() => c.closeCode !== null, 15_000, 'the close');
    expect(c.closeCode).toBe(OUT_OF_MEMORY_CLOSE_CODE);
    expect(outOfMemory(c)).toMatch(
      /^changes not applied on the server: they add 1 new object and 1 new mesh to the project, and the project's meshes, objects, keyframes and images already take about \d+ MB of memory with 5,490 objects, and a save of it about \d+ MB more for a moment/,
    );
    const after = (await (await fetch(`${server.url}/api/projects/${stored.past}`)).json()) as {
      stats: { objects: number };
    };
    expect(after.stats.objects).toBe(5_490);
    await healthy();
  });

  it('does not load a stored project whose load would not fit: agents get OUT_OF_MEMORY, browsers the close code', async () => {
    const res = await call('get_project', { project: stored.huge });
    expect(res.isError).toBe(true);
    const [first, ...rest] = (res.content[0]?.text ?? '').split('\n');
    expect(first).toMatch(
      new RegExp(
        `^get_project failed: project 'Huge' \\(${stored.huge}\\) was not loaded on the server: loading it and saving it would take about 7\\d\\d MB of JavaScript heap for its 15,000 objects, and the server's process has [\\d,]+ MB of its 68\\d MB heap free and keeps 256 MB of it for its other work\\. Open it again once the server has more heap free`,
      ),
    );
    expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'OUT_OF_MEMORY' });
    const rest507 = await fetch(`${server.url}/api/projects/${stored.huge}`);
    expect(rest507.status).toBe(507);
    expect(await rest507.json()).toMatchObject({
      code: 'OUT_OF_MEMORY',
      message: expect.stringMatching(/^project 'Huge' /),
    });
    const browser = client(stored.huge, 'Browser');
    await expect(browser.connect(15_000)).rejects.toThrow(`closed (${OUT_OF_MEMORY_CLOSE_CODE})`);
    expect(outOfMemory(browser)).toMatch(/^project 'Huge' \(.*\) was not loaded on the server: /);
    await healthy();
  });
});
