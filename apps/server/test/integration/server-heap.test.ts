import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/*
 * One edit operator must not take the server down. The operators of MCP tools run in the server's
 * own process, whose JavaScript heap every connection, agent session and project shares, and V8
 * ends the whole process when that heap runs out. The server checks the estimated peak heap of an
 * operator before it runs (core operators/memory.ts, render/memory.ts operatorCheck) and refuses
 * one that does not fit with code OUT_OF_MEMORY. The server runs here as its own process with a
 * heap of 640 MB (--max-old-space-size), in which subdividing a grid of 90,000 faces once does not
 * fit: without the check the process runs out of heap and ends, and nothing answers any more. The
 * same holds for a REST snapshot, which copies the meshes and serializes them in that heap
 * (render/memory.ts snapshotRefusal), and for import_model, which imports without the operator
 * registry (core importMemoryRefusal), while generators at their defaults, estimated from their
 * parameters, run.
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

/** Starts the server from source (tsx) as its own process group with a small heap. */
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
        SYNC_PERSISTENCE: 'memory',
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

/** A binary STL of one triangle. */
function smallStl(): Uint8Array {
  const stl = new Uint8Array(84 + 50);
  const view = new DataView(stl.buffer);
  view.setUint32(80, 1, true);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => view.setFloat32(84 + 12 + 4 * i, v, true));
  return stl;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 })) as ToolResult;
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await call(name, args);
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), '3d-editor-heap-'));
  server = await startServerProcess(dataDir);
  client = new Client({ name: 'heap-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await stopServerProcess(server);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe(`server process with a ${HEAP_MB} MB heap`, () => {
  it('refuses an edit operator that would run its heap out, and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Heap', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_grid_add',
      params: { x_subdivisions: 300, y_subdivisions: 300, size: 2 },
    });
    const res = await call('edit_mesh', {
      project: id,
      object: 'Grid',
      operator: 'mesh.subdivide',
      params: { number_cuts: 1 },
    }).catch((err: unknown) => {
      // the server's output says why it stopped answering (V8: "JavaScript heap out of memory")
      throw new Error(
        `edit_mesh got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
      );
    });
    const text = res.content[0]?.text ?? '';
    expect(res.isError).toBe(true);
    const [first, ...rest] = text.split('\n');
    expect(first).toMatch(
      /^mesh\.subdivide failed: not run on the server: it would need about [\d,]+ MB of JavaScript heap for a mesh of about 360,000 faces, and the server's process has [\d,]+ MB of its [\d,]+ MB heap free and keeps 256 MB of it for its other work\. Lower number_cuts, or select fewer faces to run it on the server \(a browser editor runs it in its own memory\)$/,
    );
    expect(JSON.parse(rest.join('\n'))).toMatchObject({
      ok: false,
      operator: 'mesh.subdivide',
      code: 'OUT_OF_MEMORY',
      mesh: { faces: 90_000 },
    });

    // the server keeps answering: health checks, scene summaries and operators that fit
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await ok('get_scene', { project: id })).counts.faces).toBe(90_000);
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_cube_add',
      params: { location: [5, 0, 0] },
    });
    const cube = await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'mesh.subdivide',
      params: { number_cuts: 1 },
    });
    expect(cube.mesh.faces).toBe(24);
    expect(server.child.exitCode).toBeNull();
    expect(server.child.signalCode).toBeNull();
  });

  it('runs the generators at their defaults (estimated from their parameters, not at their maximum)', async () => {
    const { id } = await ok('create_project', { name: 'Generators', empty: true });
    const kinds = ['tree', 'fence', 'spring', 'building', 'pipe', 'arch'];
    for (const [i, kind] of kinds.entries()) {
      const res = await call('run_operator', {
        project: id,
        operator: `object.generate_${kind}`,
        params: { location: [20 * i, 0, 0] },
      });
      expect(res.isError, `${kind}: ${res.content[0]?.text}`).toBeFalsy();
    }
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(kinds.length);
  });

  it('refuses a join of linked duplicates that would run its heap out, and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Linked', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_grid_add',
      params: { x_subdivisions: 300, y_subdivisions: 300, size: 2 },
    });
    // 30 objects sharing one mesh of 90,000 faces (21 MB decoded): joined, 2,700,000 faces (639 MB)
    await ok('run_operator', {
      project: id,
      operator: 'object.array_place',
      params: { objects: ['Grid'], count: 30, linked: true },
    });
    const names = (await ok('get_scene', { project: id })).objects.map((o: { name: string }) => o.name);
    expect(names).toHaveLength(30);
    const res = await call('run_operator', {
      project: id,
      operator: 'object.join',
      selection: { objects: names, active: 'Grid' },
    }).catch((err: unknown) => {
      throw new Error(
        `object.join got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
      );
    });
    expect(res.isError).toBe(true);
    const [first, ...rest] = (res.content[0]?.text ?? '').split('\n');
    expect(first).toMatch(
      /^object\.join failed: not run on the server: the project's meshes, objects, keyframes and images would then take about [\d,]+ MB of memory \(now 22 MB with 30 objects\), and a save of it about [\d,]+ MB more for a moment \(3 times what its objects, datablocks and keyframes take, 5 times its images\): [\d,]+ MB in all, more than the [\d,]+ MB the server's process keeps for one project/,
    );
    expect(JSON.parse(rest.join('\n'))).toMatchObject({ code: 'OUT_OF_MEMORY' });
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(30);
    expect(server.child.exitCode).toBeNull();
  });

  it('skips dense curve surfaces that would run its heap out in get_scene, and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Curves', empty: true });
    // two tubes of 1,431,876 vertices each (about 420 MB to build, 390 MB kept by the evaluation)
    const points = Array.from({ length: 330 }, (_, i) => [i * 0.1, Math.sin(0.3 * i), Math.cos(0.2 * i)]);
    for (const y of [0, 3]) {
      await ok('run_operator', {
        project: id,
        operator: 'curve.add_from_points',
        params: {
          points,
          type: 'BEZIER',
          resolution_u: 64,
          bevel_depth: 0.05,
          bevel_resolution: 32,
          location: [0, y, 0],
        },
      });
      const scene = await call('get_scene', { project: id }).catch((err: unknown) => {
        throw new Error(
          `get_scene got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
        );
      });
      expect(scene.isError, scene.content[0]?.text).toBeFalsy();
      const problems = JSON.parse(scene.content[0]!.text!).problems as { source: string; message: string }[];
      expect(
        problems.some(
          (p) => p.source === 'curve' && /^skipped on the server: this curve surface/.test(p.message),
        ),
      ).toBe(true);
    }
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect(server.child.exitCode).toBeNull();
  });

  it("refuses an export of a scatter's instances that would run its heap out, and keeps answering", async () => {
    const { id } = await ok('create_project', { name: 'Scatter', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_plane_add',
      params: { size: 20, name: 'Ground' },
    });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_ico_sphere_add',
      params: { subdivisions: 4, radius: 0.1, location: [0, 0, 5], name: 'Pebble' },
    });
    // 5,000 instances of 1,280 faces: an OBJ of 6,400,001 faces, built in the server's process
    await ok('run_operator', {
      project: id,
      operator: 'object.scatter_add',
      params: { surface: 'Ground', objects: ['Pebble'], count: 5000 },
    });
    const res = await call('run_operator', { project: id, operator: 'export_scene.obj' }).catch(
      (err: unknown) => {
        throw new Error(
          `export_scene.obj got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
        );
      },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(
      /^export_scene\.obj failed: not run on the server: it would need about [\d,]+ MB of JavaScript heap for a mesh of about 6,400,001 faces/,
    );
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect(server.child.exitCode).toBeNull();
  });

  it('refuses an import_model that would run its heap out, and keeps answering', async () => {
    // a binary STL of 600,000 triangles (30 MB), served over HTTP: reading and welding it takes
    // about 330 MB of heap, then about 100 MB decoded
    const triangles = 600_000;
    const stl = new Uint8Array(84 + 50 * triangles);
    const view = new DataView(stl.buffer);
    view.setUint32(80, triangles, true);
    for (let t = 0; t < triangles; t++)
      for (let k = 0; k < 3; k++) {
        const o = 84 + 50 * t + 12 + 12 * k;
        view.setFloat32(o, (t % 1000) + k, true);
        view.setFloat32(o + 4, Math.floor(t / 1000) + (k === 2 ? 1 : 0), true);
      }
    const files = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'model/stl' });
      res.end(req.url === '/big.stl' ? stl : smallStl());
    });
    await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
    try {
      const { id } = await ok('create_project', { name: 'Import', empty: true });
      const res = await call('import_model', { project: id, url: `${base}/big.stl` }).catch(
        (err: unknown) => {
          throw new Error(
            `import_model got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
          );
        },
      );
      expect(res.isError).toBe(true);
      const [first, ...rest] = (res.content[0]?.text ?? '').split('\n');
      expect(first).toMatch(
        /^Import failed: not run on the server: it would need about [\d,]+ MB of JavaScript heap for a mesh of about 600,000 faces, and the server's process has [\d,]+ MB of its [\d,]+ MB heap free and keeps 256 MB of it for its other work\. Lower the size of the file \(import fewer or simpler meshes\) to run it on the server \(a browser editor runs it in its own memory: editor_command \{command: 'run_operator', params: \{operator: 'import_mesh\.stl', params: \{data_base64\}\}\}\)$/,
      );
      expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'OUT_OF_MEMORY' });
      expect((await ok('get_scene', { project: id })).counts.objects).toBe(0);
      // the server keeps answering, and a small file is imported
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
      const small = await ok('import_model', { project: id, url: `${base}/small.stl` });
      expect(small.objects).toHaveLength(1);
      expect(server.child.exitCode).toBeNull();
    } finally {
      files.close();
    }
  });

  /** The first line of a refused call's error, and its code (the JSON after it). */
  async function refused(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ first: string; code: string }> {
    const res = await call(name, args).catch((err: unknown) => {
      throw new Error(
        `${name} got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
      );
    });
    expect(res.isError, res.content[0]?.text).toBe(true);
    const [first, ...rest] = (res.content[0]?.text ?? '').split('\n');
    return { first, code: (JSON.parse(rest.join('\n')) as { code: string }).code };
  }

  it('refuses Separate by loose parts of many parts (an object each), and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Parts', empty: true });
    // 30,000 quads none of which touches another: Separate by loose parts would make 29,999 objects
    // with a mesh each, about 14 KB each to keep and more to make (round 10: 200,000 such parts took
    // a server with the default heap down, estimated by their 200,000 faces)
    const vertices: number[][] = [];
    const faces: number[][] = [];
    for (let i = 0; i < 30_000; i++) {
      const x = 2 * (i % 200);
      const y = 2 * Math.floor(i / 200);
      vertices.push([x, y, 0], [x + 1, y, 0], [x + 1, y + 1, 0], [x, y + 1, 0]);
      faces.push([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3]);
    }
    await ok('run_operator', {
      project: id,
      operator: 'object.add_mesh_from_data',
      params: { name: 'Parts', vertices, faces },
    });
    const r = await refused('edit_mesh', {
      project: id,
      object: 'Parts',
      operator: 'mesh.separate',
      params: { type: 'LOOSE' },
    });
    expect(r.code).toBe('OUT_OF_MEMORY');
    expect(r.first).toMatch(
      /^mesh\.separate failed: not run on the server: .* 29,999 new objects .*Lower the number of loose parts \(separate some of them with type SELECTED first, then separate that object by loose parts\)/,
    );
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(1);
    expect(server.child.exitCode).toBeNull();
  });

  it('refuses a glTF import of many nodes (an object each), and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Nodes', empty: true });
    // 40,000 nodes of one triangle mesh in a file of 2 MB: 40,000 objects
    const nodes = Array.from({ length: 40_000 }, (_, i) => ({
      mesh: 0,
      translation: [i % 200, Math.floor(i / 200), 0],
    }));
    const triangle = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      ],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${triangle}` }],
    };
    const r = await refused('run_operator', {
      project: id,
      operator: 'import_scene.gltf',
      params: { data_base64: Buffer.from(JSON.stringify(gltf)).toString('base64') },
    });
    expect(r.code).toBe('OUT_OF_MEMORY');
    expect(r.first).toMatch(/^import_scene\.gltf failed: not run on the server: .*40,000 new objects/);
    expect(r.first).toMatch(/Lower the nodes \(objects\) of the file/);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(0);
    expect(server.child.exitCode).toBeNull();
  });

  it('refuses a GLB whose meshes share accessors by what it decodes, not by its size, and keeps answering', async () => {
    // 8 glTF meshes that all use the accessors of one grid of 300 × 300 quads: a file of 3 MB from
    // which the importer decodes 8 meshes of 180,000 triangles, which the project then counts as
    // 291 MB (each with a UV layer, as memory-objects.ts storedMeshBytes counts stored meshes): more
    // than the 216 MB the server keeps for one project (round 10: 40 such meshes of a 600 × 600
    // grid, estimated by the file's size, took the server down; round 11 counted them as 148 MB,
    // without the UV layer, and let a project grow past what the server keeps for it)
    const n = 300;
    const V = (n + 1) * (n + 1);
    const pos = new Float32Array(3 * V);
    for (let y = 0, i = 0; y <= n; y++) for (let x = 0; x <= n; x++, i++) pos.set([x / n, 0, y / n], 3 * i);
    const idx = new Uint32Array(6 * n * n);
    for (let y = 0, t = 0; y < n; y++)
      for (let x = 0; x < n; x++, t++) {
        const a = y * (n + 1) + x;
        idx.set([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1], 6 * t);
      }
    const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
    const json = Buffer.from(
      JSON.stringify({
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: Array.from({ length: 8 }, (_, i) => i) }],
        nodes: Array.from({ length: 8 }, (_, i) => ({ mesh: i, translation: [1.5 * i, 0, 0] })),
        meshes: Array.from({ length: 8 }, () => ({
          primitives: [{ attributes: { POSITION: 0 }, indices: 1 }],
        })),
        accessors: [
          { bufferView: 0, componentType: 5126, count: V, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] },
          { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
          { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
        ],
        buffers: [{ byteLength: bin.byteLength }],
      }),
    );
    const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + jsonChunk.length + 8 + bin.length, 8);
    head.writeUInt32LE(jsonChunk.length, 12);
    head.writeUInt32LE(0x4e4f534a, 16);
    const binHead = Buffer.alloc(8);
    binHead.writeUInt32LE(bin.length, 0);
    binHead.writeUInt32LE(0x004e4942, 4);
    const glb = Buffer.concat([head, jsonChunk, binHead, bin]);
    const files = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
      res.end(glb);
    });
    await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
    try {
      const { id } = await ok('create_project', { name: 'Shared accessors', empty: true });
      const url = `http://127.0.0.1:${(files.address() as AddressInfo).port}/shared.glb`;
      const r = await refused('import_model', { project: id, url });
      expect(r.code).toBe('OUT_OF_MEMORY');
      const m =
        /^Import failed: not run on the server: the project's meshes, objects, keyframes and images would then take about ([\d,]+) MB of memory with 8 new objects \(now 0 MB with 0 objects\), and a save of it about [\d,]+ MB more for a moment \(3 times what its objects, datablocks and keyframes take, 5 times its images\): ([\d,]+) MB in all, more than the ([\d,]+) MB the server's process keeps for one project \(half of its [\d,]+ MB heap less the 256 MB it keeps for its other work\)\. Lower the meshes of the file \(every glTF mesh is decoded into a mesh of its own, also where meshes share the same accessors\), or delete objects and meshes the project no longer needs$/.exec(
          r.first,
        );
      expect(m, r.first).not.toBeNull();
      const mb = (s: string) => Number(s.replace(/,/g, ''));
      // the meshes it decodes (291 MB), not the 3 MB of the file
      expect(mb(m![1])).toBeGreaterThanOrEqual(291);
      expect(mb(m![2])).toBeGreaterThan(mb(m![3]));
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
      expect((await ok('get_scene', { project: id })).counts.objects).toBe(0);
      expect(server.child.exitCode).toBeNull();
    } finally {
      files.close();
    }
  });

  it('skips a Bevel limited by angle that would run its heap out in get_scene, and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Bevel', empty: true });
    // every edge of a torus of 16,384 faces meets its faces at more than 0.01 rad: ten segments
    // would make about 1,561,088 faces, 2,548 MB estimated (round 10: a Bevel by angle was
    // estimated without them)
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_torus_add',
      params: { major_segments: 256, minor_segments: 64, name: 'Ring' },
    });
    await ok('add_modifier', {
      project: id,
      object: 'Ring',
      type: 'BEVEL',
      params: { limit_method: 'ANGLE', angle_limit: 0.01, segments: 10, width: 0.001 },
    });
    // a small one still runs
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_cube_add',
      params: { location: [5, 0, 0] },
    });
    await ok('add_modifier', {
      project: id,
      object: 'Cube',
      type: 'BEVEL',
      params: { limit_method: 'ANGLE', segments: 2, width: 0.1 },
    });
    const scene = await call('get_scene', { project: id }).catch((err: unknown) => {
      throw new Error(
        `get_scene got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
      );
    });
    expect(scene.isError, scene.content[0]?.text).toBeFalsy();
    const summary = JSON.parse(scene.content[0]!.text!) as {
      problems: { source: string; object?: string; message: string }[];
      objects: { name: string; faces?: number; evaluated?: { faces?: number } }[];
    };
    const ring = summary.problems.filter((p) => p.source === 'modifier' && p.object === 'Ring');
    expect(ring.length).toBeGreaterThan(0);
    expect(ring[0].message).toMatch(/^skipped on the server: /);
    expect(summary.problems.some((p) => p.object === 'Cube')).toBe(false);
    const cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(JSON.stringify(cube)).toMatch(/"faces":\s*(?!6\b)\d+/);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect(server.child.exitCode).toBeNull();
  });

  it('keeps the evaluations get_object caches frame by frame within its heap, and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Moving scatter', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_plane_add',
      params: { size: 20, name: 'Ground' },
    });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_cube_add',
      params: { size: 0.1, location: [0, 0, 5], name: 'Pebble' },
    });
    // 200,000 instances (the most a scene has) on an emitter that moves: every frame evaluated has
    // instances of its own, about 60 MB, which the cache of 16 evaluations per project kept until
    // the heap ran out (eval-cache.ts; now within a budget of a third of what one project may keep)
    await ok('run_operator', {
      project: id,
      operator: 'object.scatter_add',
      params: { surface: 'Ground', objects: ['Pebble'], count: 200_000 },
    });
    for (const [frame, x] of [
      [1, 0],
      [100, 10],
    ])
      await ok('insert_keyframe', {
        project: id,
        object: 'Ground',
        property: 'location',
        frame,
        value: [x, 0, 0],
        interpolation: 'LINEAR',
      });
    for (let frame = 2; frame <= 17; frame++) {
      const res = await call('get_object', { project: id, object: 'Ground', frame }).catch((err: unknown) => {
        throw new Error(
          `get_object at frame ${frame} got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
        );
      });
      expect(res.isError, res.content[0]?.text).toBeFalsy();
      expect(JSON.parse(res.content[0]!.text!).world_location[0]).toBeCloseTo((10 * (frame - 1)) / 99, 3);
    }
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect(server.child.exitCode).toBeNull();
    await ok('delete_project', { project: id, confirm: true });
  });

  it('refuses a REST snapshot that would run its heap out, and keeps answering', async () => {
    const { id } = await ok('create_project', { name: 'Snapshot', empty: true });
    // six grids of 145,924 faces: about 207 MB decoded, within what the server keeps for one
    // project; their copy and JSON need about as much again. Six half-size grids rather than three
    // whole ones: building a grid of 291,600 faces needs about 212 MB of the heap at its peak,
    // which the third of them no longer had (by a megabyte) with the server's own code grown
    for (let i = 0; i < 6; i++)
      await ok('run_operator', {
        project: id,
        operator: 'mesh.primitive_grid_add',
        params: { x_subdivisions: 382, y_subdivisions: 382, location: [3 * i, 0, 0] },
      });
    expect((await ok('get_scene', { project: id })).counts.faces).toBe(6 * 382 * 382);
    const res = await fetch(`${server.url}/api/projects/${id}/snapshot`).catch((err: unknown) => {
      throw new Error(
        `the snapshot got no answer (${String(err)}); the server's output:\n${server.output().slice(-1500)}`,
      );
    });
    expect(res.status).toBe(507);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('OUT_OF_MEMORY');
    expect(body.error).toMatch(
      /^snapshot failed: not built on the server: it would need about [\d,]+ MB of JavaScript heap \(a copy of the meshes and up to [\d,]+ MB of JSON\), and the server's process has [\d,]+ MB of its [\d,]+ MB heap free and keeps 256 MB of it for its other work\. Export the meshes instead \(GET \/api\/projects\/:id\/export builds the file in a render process\), or delete meshes the project no longer needs$/,
    );
    // the server keeps answering, and a small project's snapshot is built
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    const small = await ok('create_project', { name: 'Small' });
    const snap = await fetch(`${server.url}/api/projects/${small.id}/snapshot`);
    expect(snap.status).toBe(200);
    expect(((await snap.json()) as { meshes: unknown[] }).meshes.length).toBeGreaterThan(0);
    expect(server.child.exitCode).toBeNull();
    expect(server.child.signalCode).toBeNull();
  });
});
