import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  geometryMemoryCheck,
  meshMemoryCheck,
  operatorMemoryCheck,
  setGeometryMemoryCheck,
  setMeshMemoryCheck,
  setOperatorMemoryCheck,
  type GeometryMemoryCheck,
  type MeshMemoryCheck,
  type OperatorMemoryCheck,
} from '@3d-editor/core';
import { decodeCheck, geometryCheck, operatorCheck } from '../../src/render/memory';
import { startServer, type TestServer } from '../helpers/app';

/*
 * The server evaluates scenes in its own process (scene summaries, operators), where running out
 * of JavaScript heap stops the whole server: a Subdivision Surface whose result does not fit into
 * the server's free heap is skipped with an explained modifier error instead (get_scene reports
 * it, Apply refuses it), and the server keeps answering. The server's heap is replaced by one of
 * 1,024 MB with a fixed 300 MB free here, so that 1,000,000 faces (about 668 MB) do not fit, like
 * 4,000,000 faces do not with the real free heap of about 1.8 GB.
 */

let server: TestServer;
let client: Client;
let installed: GeometryMemoryCheck | null = null;
let installedOperatorCheck: OperatorMemoryCheck | null = null;
let installedDecodeCheck: MeshMemoryCheck | null = null;

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
  installedOperatorCheck = operatorMemoryCheck();
  installedDecodeCheck = meshMemoryCheck();
});

afterAll(async () => {
  setGeometryMemoryCheck(installed);
  setOperatorMemoryCheck(installedOperatorCheck);
  setMeshMemoryCheck(installedDecodeCheck);
  await client?.close();
  await server?.close();
  await server?.cleanup();
});

describe("evaluations in the server's process", () => {
  it('skip a modifier whose result does not fit into the free heap, with an explained error, and keep serving', async () => {
    // the server checks every modifier it evaluates against its own free heap
    expect(installed).toBeTypeOf('function');
    setGeometryMemoryCheck(
      geometryCheck({ heapFree: () => 300 * MB, collect: () => undefined, heapLimit: () => 1024 * MB }),
    );

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
    // listed once, though the viewport's evaluation skips it too: with the advice that names both
    expect(problems.filter((p) => p.source === 'modifier')).toHaveLength(1);
    expect(problems.find((p) => p.source === 'modifier')!.message).toMatch(
      / heap free and keeps 256 MB of it for its other work\. Lower levels \(render_levels for renders\) to evaluate it on the server \(a browser editor evaluates it itself\)$/,
    );

    // Apply computes the stack itself: refused the same way (here the operator's own estimate,
    // checked before it runs, is let through), the modifier stays
    expect(installedOperatorCheck).toBeTypeOf('function');
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 4096 * MB, collect: () => undefined, heapLimit: () => 1024 * MB }),
    );
    const applyArgs = { project: id, operator: 'object.modifier_apply', params: { modifier: 'Subdivision' } };
    const apply = await call('run_operator', applyArgs);
    expect(apply.isError).toBe(true);
    expect(apply.content[0].text).toContain(message);
    expect(JSON.parse(apply.content[0].text!.split('\n').slice(1).join('\n'))).toMatchObject({
      code: 'OUT_OF_MEMORY',
    });
    // the operator's estimate refuses it before it runs when the free heap is that small
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 300 * MB, collect: () => undefined, heapLimit: () => 1024 * MB }),
    );
    const refused = await call('run_operator', applyArgs);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(
      /^object\.modifier_apply failed: not run on the server: it would need about [\d,]+ MB of JavaScript heap for a mesh of about 1,000,000 faces, and the server's process has 300 MB /,
    );
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);

    // with room for it, the same evaluation runs (no result was kept from the refusal)
    setGeometryMemoryCheck(
      geometryCheck({ heapFree: () => 2000 * MB, collect: () => undefined, heapLimit: () => 1024 * MB }),
    );
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

describe("stored meshes the server's process does not load", () => {
  it('are refused by get_mesh_data with code OUT_OF_MEMORY, like the operators that read them', async () => {
    expect(installedDecodeCheck).toBeTypeOf('function');
    const { id } = await ok('create_project', { name: 'unloaded', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_grid_add',
      params: { x_subdivisions: 100, y_subdivisions: 100 },
    });
    // a heap with 1 MB free above the reserve: the grid of 20,000 triangles (2 MB) is not decoded
    setMeshMemoryCheck(
      decodeCheck({ heapFree: () => 257 * MB, collect: () => undefined, heapLimit: () => 1024 * MB }),
    );
    try {
      const res = await call('get_mesh_data', { project: id, object: 'Grid' });
      expect(res.isError).toBe(true);
      const [first, ...rest] = res.content[0].text!.split('\n');
      expect(first).toMatch(
        /^get_mesh_data failed: this mesh of 20,000 triangles was not loaded on the server: decoding it needs about 2 MB of JavaScript heap/,
      );
      expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'OUT_OF_MEMORY' });
    } finally {
      setMeshMemoryCheck(installedDecodeCheck);
    }
    expect((await ok('get_mesh_data', { project: id, object: 'Grid' })).totals).toMatchObject({
      faces: 10_000,
    });
  });
});

describe('Edit Mode operators the server does not run', () => {
  it('are refused before Edit Mode is entered and the elements are selected (edit_mesh, run_operator, batch)', async () => {
    const { id } = await ok('create_project', { name: 'edit-early', empty: true });
    await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_grid_add',
      params: { x_subdivisions: 50, y_subdivisions: 50 },
    });
    // a check that refuses Subdivide and records what it is asked: entering Edit Mode would ask
    // about object.mode_set first (and select the 2,500 faces) before the operator is checked
    const asked: string[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req.operator);
      return req.operator === 'mesh.subdivide' ? `no room for ${req.estimate.faces} faces` : null;
    });
    try {
      const edit = await call('edit_mesh', {
        project: id,
        object: 'Grid',
        operator: 'mesh.subdivide',
        params: { number_cuts: 1 },
      });
      expect(edit.isError).toBe(true);
      const [first, ...rest] = edit.content[0].text!.split('\n');
      expect(first).toBe('mesh.subdivide failed: no room for 10000 faces');
      expect(JSON.parse(rest.join('\n'))).toMatchObject({
        ok: false,
        operator: 'mesh.subdivide',
        error: 'no room for 10000 faces',
        code: 'OUT_OF_MEMORY',
        mesh: { vertices: 2601, faces: 2500, triangles: 5000 },
        selection: { mode: 'OBJECT' },
      });
      expect(asked).toEqual(['mesh.subdivide']);

      asked.length = 0;
      const selection = { objects: ['Grid'], mode: 'EDIT', mesh: { faces: [0, 1, 2, 3] } };
      const run = await call('run_operator', {
        project: id,
        operator: 'mesh.subdivide',
        params: { number_cuts: 1 },
        selection,
      });
      expect(run.isError).toBe(true);
      // 2,500 faces, 4 of them selected and cut in four
      expect(run.content[0].text!.split('\n')[0]).toBe('mesh.subdivide failed: no room for 2512 faces');
      expect(JSON.parse(run.content[0].text!.split('\n').slice(1).join('\n'))).toMatchObject({
        code: 'OUT_OF_MEMORY',
        selection: { mode: 'OBJECT' },
      });
      expect(asked).toEqual(['mesh.subdivide']);

      asked.length = 0;
      const batch = await call('batch', {
        project: id,
        operations: [{ operator: 'mesh.subdivide', params: { number_cuts: 1 }, selection }],
      });
      expect(batch.isError).toBe(true);
      expect(JSON.parse(batch.content[0].text!.split('\n').slice(1).join('\n')).results[0]).toEqual({
        operator: 'mesh.subdivide',
        ok: false,
        error: 'no room for 2512 faces',
        code: 'OUT_OF_MEMORY',
      });
      expect(asked).toEqual(['mesh.subdivide']);

      // an operator that fits enters Edit Mode, and the registry checks it again with the selection
      asked.length = 0;
      const smooth = await ok('edit_mesh', { project: id, object: 'Grid', operator: 'mesh.vertices_smooth' });
      expect(smooth.ok).toBe(true);
      expect(asked).toEqual(['mesh.vertices_smooth', 'object.mode_set', 'mesh.vertices_smooth']);
    } finally {
      setOperatorMemoryCheck(installedOperatorCheck);
    }
  });
});
