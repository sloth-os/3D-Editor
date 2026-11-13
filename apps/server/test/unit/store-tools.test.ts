import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setOperatorMemoryCheck, type OperatorMemoryCheck } from '@3d-editor/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BUILTIN_CATALOG,
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  type ReportLevel,
} from '@3d-editor/core';
import { NotFoundError } from '../../src/mcp/agent';
import { registerTools, type ToolContext } from '../../src/mcp/tools';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog } from '../../src/observability/log';
import {
  KHRONOS,
  KHRONOS_CHAIR_META,
  KHRONOS_INDEX,
  SKETCHFAB_API,
  SF_UID_1,
  bytes,
  cubeGltf,
  fakeFetch,
  json,
  makeStore,
  sketchfabModel,
  type TestStore,
} from './store-fixtures';

/*
 * store_search and store_add through an in-memory MCP client: argument checks, results, the
 * operator store_add runs in the agent's project (one run), and failures with their code on a
 * second line.
 */

const lamp = cubeGltf('cube.bin', 'textures/wood.png');
const builtin = BUILTIN_CATALOG.find((e) => e.rig === null)!;

let t: TestStore;
let client: Client;
let server: McpServer;
let doc: SceneDoc;
let runs: string[];
let projectLookups: string[];

beforeEach(async () => {
  doc = SceneDoc.create({ empty: true });
  runs = [];
  projectLookups = [];
  const f = fakeFetch({
    [`${KHRONOS}model-index.json`]: json(KHRONOS_INDEX),
    [`${KHRONOS}DeskLamp/metadata.json`]: json({ ...KHRONOS_CHAIR_META, name: 'Desk Lamp' }),
    [`${KHRONOS}DeskLamp/glTF/DeskLamp.gltf`]: bytes(lamp.gltf, 'model/gltf+json'),
    [`${KHRONOS}DeskLamp/glTF/cube.bin`]: bytes(lamp.bin),
    [`${KHRONOS}DeskLamp/glTF/textures/wood.png`]: bytes(lamp.png, 'image/png'),
    [`${SKETCHFAB_API}/models/${SF_UID_1}`]: json(sketchfabModel(SF_UID_1)),
  });
  t = await makeStore({ fetch: f.fetch, env: { STORE_PROVIDERS: 'builtin,khronos,sketchfab' } });
  const registry = createOperatorRegistry();
  const state = createEditorState();
  const project = {
    scene: doc,
    run(operator: string, params?: unknown) {
      runs.push(operator);
      const reports: { level: ReportLevel; message: string }[] = [];
      return registry.run(
        {
          doc,
          state,
          origin: { type: 'agent-test' },
          source: 'mcp',
          report: (level, message) => void reports.push({ level, message }),
        },
        operator,
        params,
      );
    },
  };
  const ctx = {
    historyLimits: { maxSteps: 10, maxBytes: 1 << 20 },
    metrics: new ServerMetrics({ defaultMetrics: false }),
    log: silentLog,
    store: t.store,
    agent: {
      id: 'agent-1',
      project: async (id: string) => {
        projectLookups.push(id);
        if (id !== 'p1') throw new NotFoundError(`Project not found: ${id}`);
        return project;
      },
    },
  } as unknown as ToolContext;
  server = new McpServer({ name: 'store-tools', version: '0' });
  registerTools(server, ctx);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'store-tools', version: '0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await t.cleanup();
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

describe('store_search', () => {
  it('searches the providers and reports each', async () => {
    const r = await call('store_search', { query: 'lamp', providers: ['khronos', 'sketchfab'], limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.body.results[0]).toMatchObject({
      id: 'khronos:DeskLamp',
      // no HTTP request behind an in-memory call: the route stays relative
      thumbnail_url: '/api/store/models/khronos:DeskLamp/thumbnail',
    });
    expect(r.body.providers.map((p: { id: string }) => p.id)).toEqual(['khronos', 'sketchfab']);
    // Sketchfab is not reachable here: reported, not thrown
    expect(r.body.providers[1].status).toBe('error');
    expect(r.body).toHaveProperty('next_cursor');
  });

  it('checks its arguments', async () => {
    expect((await call('store_search', { limit: 51 })).isError).toBe(true);
    expect((await call('store_search', { category: 'spaceships' })).isError).toBe(true);
    const typo = await call('store_search', { qeury: 'lamp' });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/query/);
  });
});

describe('store_add', () => {
  it('inserts a built-in model as one operator run', async () => {
    const r = await call('store_add', { project: 'p1', model: `builtin:${builtin.id}`, location: [1, 0, 0] });
    expect(r.isError).toBe(false);
    expect(runs).toEqual(['store.add']);
    expect(doc.getObject(r.body.result.root)?.location).toEqual([1, 0, 0]);
    expect(r.body.entry.id).toBe(`builtin:${builtin.id}`);
    expect(r.body.warnings).toEqual([]);
  });

  it('downloads an external model and inserts its files', async () => {
    const r = await call('store_add', { project: 'p1', model: 'khronos:DeskLamp', height_m: 0.4 });
    expect(r.isError).toBe(false);
    expect(runs).toEqual(['store.insert_files']);
    expect(r.body.result.dimensions_m[2]).toBeCloseTo(0.4, 3);
    expect(r.body.warnings.join('\n')).toMatch(/non-commercial use only/);
    expect(projectLookups).toEqual(['p1', 'p1']);
  });

  it('refuses a model the server cannot hold before reading its files or running the operator', async () => {
    let installed: OperatorMemoryCheck | null = null;
    try {
      installed = setOperatorMemoryCheck(() => 'the insert needs 900 MB and 300 MB are free');
      const r = await call('store_add', { project: 'p1', model: 'khronos:DeskLamp' });
      expect(r.isError).toBe(true);
      const [first, ...rest] = r.text.split('\n');
      expect(first).toBe('the insert needs 900 MB and 300 MB are free');
      expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'OUT_OF_MEMORY' });
      expect(runs).toEqual([]);
      expect(t.store.cache.filesRead).toBe(0);
    } finally {
      setOperatorMemoryCheck(installed);
    }
  });

  it('fails with the code on a second line, before downloading for an unknown project', async () => {
    const key = await call('store_add', { project: 'p1', model: `sketchfab:${SF_UID_1}` });
    expect(key.isError).toBe(true);
    const [first, ...rest] = key.text.split('\n');
    expect(first).toMatch(/SKETCHFAB_TOKEN/);
    expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'NEEDS_KEY' });
    const missing = await call('store_add', { project: 'nope', model: 'khronos:DeskLamp' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('Project not found: nope');
    expect(runs).toEqual([]);
    expect(
      (await call('store_add', { project: 'p1', model: 'khronos:DeskLamp', color: 'blue' })).isError,
    ).toBe(true);
    const unknown = await call('store_add', { project: 'p1', model: 'builtin:nope_nope' });
    expect(unknown.text).toMatch(/No built-in model/);
  });
});
