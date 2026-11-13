import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SceneDoc } from '@3d-editor/core';

/*
 * A project the server holds must be one it can also save. With disk or WebDAV persistence the
 * server saves a project after every change (core storage/project-store.ts syncDocument), and a
 * save decodes the whole stored state three times in the server's heap, about three times what the
 * project's objects keep: saves of 70,000 linked cubes, which the limit per project allowed by what
 * they keep, ended a server of Node's default heap (round 11). The limit per project counts what a
 * save takes (core memory-objects.ts saveBytes, render/memory.ts maxProjectMeshBytes). The server
 * runs here as its own process with a heap of 640 MB and disk persistence: it keeps 216 MB of its
 * 688 MB heap for one project, about 5,000 objects with their saves (about 20,000 by what they keep
 * alone).
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
let client: Client;

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
  // whatever the server started in its group (esbuild's service of tsx, a render process)
  signal('SIGKILL');
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client
    .callTool({ name, arguments: args }, undefined, { timeout: 45_000 })
    .catch((err: unknown) => {
      throw new Error(
        `${name} got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
      );
    })) as ToolResult;
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await call(name, args);
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

/** The first line of a refused call's error, and its code (the JSON after it). */
async function refused(
  name: string,
  args: Record<string, unknown>,
): Promise<{ first: string; code: string }> {
  const res = await call(name, args);
  expect(res.isError, res.content[0]?.text).toBe(true);
  const [first, ...rest] = (res.content[0]?.text ?? '').split('\n');
  return { first, code: (JSON.parse(rest.join('\n')) as { code: string }).code };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), '3d-editor-save-'));
  server = await startServerProcess(dataDir);
  client = new Client({ name: 'save-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await stopServerProcess(server);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe(`server process with a ${HEAP_MB} MB heap that saves its projects to disk`, () => {
  it('refuses objects whose saves would not fit, saves the ones that fit, and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Saved', empty: true });
    await ok('run_operator', { project: id, operator: 'mesh.primitive_cube_add', params: { name: 'Cube' } });
    const place = (count: number) => ({
      project: id,
      operator: 'object.array_place',
      params: { objects: ['Cube'], count, linked: true, offset: [0.01, 0, 0] },
    });
    // 9,999 linked cubes keep about 105 MB, within the 216 MB the server keeps for one project, but
    // a save of them takes 315 MB more for a moment
    const big = await refused('run_operator', place(10_000));
    expect(big.code).toBe('OUT_OF_MEMORY');
    expect(big.first).toMatch(
      /^object\.array_place failed: not run on the server: the project's meshes, objects, keyframes and images would then take about 105 MB of memory with 9,999 new objects \(now 0 MB with 1 object\), and a save of it about 315 MB more for a moment \(3 times what its objects, datablocks and keyframes take, 5 times its images\): 420 MB in all, more than the [\d,]+ MB the server's process keeps for one project \(half of its [\d,]+ MB heap less the 256 MB it keeps for its other work\)\. Lower count, or delete objects and meshes the project no longer needs$/,
    );
    // 3,999 fit with their saves (176 MB)
    await ok('run_operator', place(4_000));
    // the inspection tools cache evaluations of the project, which the server keeps beside it
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(4_000);
    for (const frame of [2, 3])
      expect((await ok('get_object', { project: id, object: 'Cube', frame })).name).toBe('Cube');
    // 1,499 more would not fit with their saves
    const more = await refused('run_operator', place(1_500));
    expect(more.code).toBe('OUT_OF_MEMORY');
    expect(more.first).toMatch(
      /with 1,499 new objects \(now [\d,]+ MB with 4,000 objects\), and a save of it about /,
    );
    // a small change, saved: the stored document holds it, and the server answers on
    const changed = Date.now();
    await ok('run_operator', { project: id, operator: 'object.empty_add', params: { name: 'Marker' } });
    const file = path.join(dataDir, 'projects', id, 'document.ybin');
    const deadline = Date.now() + 20_000;
    let stored: SceneDoc | null = null;
    while (Date.now() < deadline && !stored) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const s = await stat(file).catch(() => null);
      if (!s || s.mtimeMs < changed) continue;
      const doc = SceneDoc.fromUpdate(new Uint8Array(await readFile(file)));
      if (doc.listObjects().some((o) => o.name === 'Marker')) stored = doc;
    }
    expect(
      stored,
      `the change was not saved within 20 s; the server's output:\n${server.output().slice(-1500)}`,
    ).not.toBeNull();
    expect(stored!.objectIds()).toHaveLength(4_001);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect(server.child.exitCode).toBeNull();
  });
});
