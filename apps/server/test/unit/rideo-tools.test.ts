import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolContext } from '../../src/mcp/tools';

/*
 * The rideo bridge tools as an MCP client lists them (SPEC §11): rideo_import and rideo_push with
 * closed argument schemas (nested rideo target included), descriptions within the 600 characters
 * every tool keeps to, their annotations (both reach another server; rideo_push changes it), and
 * malformed rideo ids refused by the schema before anything runs.
 */

async function withClient<T>(fn: (client: Client, calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const server = new McpServer({ name: 'rideo-tools', version: '0' });
  // registration reads only the history limits; a handler that runs records it
  const ctx = {
    historyLimits: { maxSteps: 7, maxBytes: 1 << 20 },
    rideo: new Proxy({}, { get: (_t, key) => () => calls.push(String(key)) }),
    agent: new Proxy({}, { get: (_t, key) => () => calls.push(`agent.${String(key)}`) }),
  } as unknown as ToolContext;
  registerTools(server, ctx);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rideo-tools', version: '0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    return await fn(client, calls);
  } finally {
    await client.close();
    await server.close();
  }
}

type Schema = { additionalProperties?: unknown; properties?: Record<string, Schema>; required?: string[] };

describe('rideo tools', () => {
  it('are listed with closed schemas, short descriptions and their annotations', async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const imp = tools.find((t) => t.name === 'rideo_import')!;
      const push = tools.find((t) => t.name === 'rideo_push')!;
      expect(imp).toBeDefined();
      expect(push).toBeDefined();
      for (const t of [imp, push]) {
        const schema = t.inputSchema as Schema;
        expect(schema.additionalProperties, t.name).toBe(false);
        expect(schema.properties!.rideo.additionalProperties, t.name).toBe(false);
        expect(Object.keys(schema.properties!.rideo.properties!).sort(), t.name).toEqual([
          'clip',
          'project',
          'token',
          'url',
        ]);
        expect(schema.properties!.rideo.required!.sort(), t.name).toEqual(['clip', 'project']);
        expect(t.description!.length, t.name).toBeLessThanOrEqual(600);
        expect(t.annotations?.openWorldHint, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(false);
      }
      expect(push.annotations?.destructiveHint).toBe(true);
      expect(imp.annotations?.destructiveHint).toBe(false);
      expect(Object.keys((imp.inputSchema as Schema).properties!).sort()).toEqual(
        ['cast_overrides', 'model_limits', 'project', 'rideo', 'use_store_models'].sort(),
      );
      expect(Object.keys((push.inputSchema as Schema).properties!).sort()).toEqual(
        ['export', 'mode', 'pass', 'project', 'rideo', 'shots', 'write_blocking'].sort(),
      );
      expect((push.inputSchema as Schema).required!.sort()).toEqual(['export', 'project', 'rideo']);
    });
  });

  it('refuse malformed rideo ids and unknown arguments before anything runs', async () => {
    await withClient(async (client, calls) => {
      for (const args of [
        { rideo: { project: 'project-1', clip: 'clp_0000000000000002' } },
        { rideo: { project: 'prj_0000000000000001', clip: '../clips' } },
        { rideo: { project: 'prj_0000000000000001', clip: 'clp_0000000000000002', token: '' } },
        { rideo: { project: 'prj_0000000000000001', clip: 'clp_0000000000000002', secret: 'x' } },
        { rideo: { project: 'prj_0000000000000001', clip: 'clp_0000000000000002' }, cast: {} },
        {
          rideo: { project: 'prj_0000000000000001', clip: 'clp_0000000000000002' },
          cast_overrides: { x: 'dragon' },
        },
      ]) {
        const res = await client.callTool({ name: 'rideo_import', arguments: args });
        expect(res.isError, JSON.stringify(args)).toBe(true);
      }
      const push = await client.callTool({
        name: 'rideo_push',
        arguments: {
          project: 'P',
          export: 'e1',
          rideo: { project: 'prj_0000000000000001', clip: 'clp_0000000000000002' },
          mode: 'performance',
        },
      });
      expect(push.isError).toBe(true);
      expect(calls).toEqual([]);
    });
  });
});
