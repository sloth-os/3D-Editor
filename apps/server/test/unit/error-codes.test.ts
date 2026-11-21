import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVICE_ERROR_CODES, ToolError, codedErrorDetails, type ToolErrorCode } from '../../src/mcp/agent';
import { registerTools, type ToolContext } from '../../src/mcp/tools';
import { SERVICE_ERROR_STATUS, errorStatus, restErrorReply, sendRestError } from '../../src/api/errors';
import { registerVideoExportRoutes } from '../../src/api/video-exports';
import { registerStoreRoutes } from '../../src/api/store';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog } from '../../src/observability/log';
import { VideoExports } from '../../src/video';
import { ModelStore } from '../../src/store';
import type { ServerServices, ServiceContext } from '../../src/services';

/*
 * The error codes of the server's services (SPEC §1): a ToolError carries UNAVAILABLE,
 * FFMPEG_UNAVAILABLE, NEEDS_KEY, NOT_DOWNLOADABLE, QUEUE_FULL or UPSTREAM besides the core codes.
 * The MCP tool wrapper writes `{"code": …}` as JSON on a second line for those and OUT_OF_MEMORY
 * (every other failure stays one line), and the REST routes answer them with 503, 409 or 400 and
 * `{error, code}`. Until the services land, their stubs answer UNAVAILABLE everywhere.
 */

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('REST status of the error codes', () => {
  it('maps the service codes to 503, 409 and 400 with {error, code}', () => {
    expect(SERVICE_ERROR_STATUS).toEqual({
      UNAVAILABLE: 503,
      FFMPEG_UNAVAILABLE: 503,
      UPSTREAM: 503,
      QUEUE_FULL: 409,
      NOT_DOWNLOADABLE: 409,
      NEEDS_KEY: 400,
    });
    expect([...SERVICE_ERROR_CODES].sort()).toEqual(Object.keys(SERVICE_ERROR_STATUS).sort());
    for (const code of SERVICE_ERROR_CODES)
      expect(restErrorReply(new ToolError('the store is down', code)), code).toEqual({
        status: SERVICE_ERROR_STATUS[code],
        body: { error: 'the store is down', code },
      });
  });

  it('maps the core codes as the other routes do, and errors without a code to 500', () => {
    const cases: [ToolErrorCode | undefined, number][] = [
      ['NOT_FOUND', 404],
      ['INVALID_PARAMS', 400],
      ['POLL_FAILED', 409],
      ['OUT_OF_MEMORY', 507],
      ['FAILED', 500],
      [undefined, 500],
    ];
    for (const [code, status] of cases) expect(errorStatus(code), String(code)).toBe(status);
    expect(restErrorReply(new ToolError('no such export', 'NOT_FOUND'))).toEqual({
      status: 404,
      body: { error: 'no such export', code: 'NOT_FOUND' },
    });
    expect(restErrorReply(new ToolError('plain'))).toEqual({ status: 500, body: { error: 'plain' } });
    // only ToolErrors carry a code the client may see
    expect(restErrorReply(new Error('boom'))).toBeNull();
  });

  it('sendRestError answers a ToolError with its status and anything else with 500', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.get('/queue', async (_request, reply) =>
      sendRestError(reply, new ToolError('too many exports wait', 'QUEUE_FULL'), 'video export'),
    );
    app.get('/crash', async (_request, reply) =>
      sendRestError(reply, new Error('disk on fire'), 'video export'),
    );
    const queue = await app.inject({ method: 'GET', url: '/queue' });
    expect(queue.statusCode).toBe(409);
    expect(queue.json()).toEqual({ error: 'too many exports wait', code: 'QUEUE_FULL' });
    const crash = await app.inject({ method: 'GET', url: '/crash' });
    expect(crash.statusCode).toBe(500);
    expect(crash.json()).toEqual({ error: 'video export failed: disk on fire' });
  });

  it('the routes of the stub services answer 503 UNAVAILABLE', async () => {
    // the stubs read nothing of their context until they work
    const ctx = {} as ServiceContext;
    const services = {
      exports: new VideoExports(ctx),
      store: new ModelStore(ctx),
    } as unknown as ServerServices;
    const app = Fastify({ logger: false });
    apps.push(app);
    registerVideoExportRoutes(app, services);
    registerStoreRoutes(app, services);
    const VIDEO = 'Video export is not available yet on this server.';
    const STORE = 'The model store is not available yet on this server.';
    const unavailable = async (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      error: string,
      payload?: object,
    ) => {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json(), `${method} ${url}`).toEqual({ error, code: 'UNAVAILABLE' });
    };
    const exports = '/api/projects/p1/video-exports';
    await unavailable('POST', exports, VIDEO, {});
    await unavailable('GET', exports, VIDEO);
    await unavailable('GET', `${exports}/e1?wait=1`, VIDEO);
    await unavailable('GET', `${exports}/e1/files/sequence.mp4`, VIDEO);
    await unavailable('DELETE', `${exports}/e1`, VIDEO);
    await unavailable('GET', '/api/store/providers', STORE);
    await unavailable('GET', '/api/store/search?query=oak%20tree&providers=builtin,polyhaven', STORE);
    await unavailable('GET', '/api/store/models/builtin:oak_tree', STORE);
    await unavailable('GET', '/api/store/models/builtin:oak_tree/thumbnail', STORE);
    await unavailable('GET', '/api/store/models/khronos:Duck/files/Duck.gltf', STORE);
    await unavailable('POST', '/api/projects/p1/store', STORE, { model: 'builtin:oak_tree' });
    // the parameters are checked before the service is asked
    const bad = await app.inject({ method: 'POST', url: exports, payload: { width: 17 } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/store',
      payload: { modle: 'x' },
    });
    expect(unknown.statusCode).toBe(400);
  });
});

describe('MCP tool errors with a code', () => {
  /** The text of a failed get_connected_clients call whose project lookup throws `err`. */
  async function failedCall(err: Error): Promise<string> {
    const server = new McpServer({ name: 'error-codes', version: '0' });
    const ctx = {
      historyLimits: { maxSteps: 10, maxBytes: 1 << 20 },
      metrics: new ServerMetrics({ defaultMetrics: false }),
      log: silentLog,
      agent: {
        id: 'agent-1',
        project: async () => {
          throw err;
        },
      },
    } as unknown as ToolContext;
    registerTools(server, ctx);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'error-codes', version: '0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const res = await client.callTool({ name: 'get_connected_clients', arguments: { project: 'P' } });
      expect(res.isError).toBe(true);
      const content = res.content as { type: string; text: string }[];
      expect(content).toHaveLength(1);
      return content[0].text;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('writes {"code"} on a second line for OUT_OF_MEMORY and the service codes', async () => {
    for (const code of ['OUT_OF_MEMORY', ...SERVICE_ERROR_CODES] as ToolErrorCode[]) {
      const text = await failedCall(new ToolError(`${code} happened`, code));
      const [first, ...rest] = text.split('\n');
      expect(first, code).toBe(`${code} happened`);
      expect(JSON.parse(rest.join('\n')), code).toEqual({ code });
      expect(codedErrorDetails(code)).toEqual({ code });
    }
  });

  it('keeps every other tool error on one line', async () => {
    for (const code of ['NOT_FOUND', 'INVALID_PARAMS', 'FAILED', 'POLL_FAILED', undefined] as const) {
      const text = await failedCall(new ToolError('Project not found: P', code));
      expect(text, String(code)).toBe('Project not found: P');
      expect(codedErrorDetails(code)).toBeUndefined();
    }
  });

  it('registers the video export and model store tools with closed argument schemas', async () => {
    const server = new McpServer({ name: 'error-codes', version: '0' });
    // registration reads only the history limits (the handlers use the rest of the context)
    registerTools(server, { historyLimits: { maxSteps: 7, maxBytes: 1 << 20 } } as unknown as ToolContext);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'error-codes', version: '0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      for (const name of [
        'export_video',
        'export_status',
        'cancel_export',
        'list_exports',
        'store_search',
        'store_add',
      ]) {
        expect(names.has(name), name).toBe(true);
        const t = tools.find((x) => x.name === name)!;
        expect(t.inputSchema.additionalProperties, name).toBe(false);
        expect(t.description!.length, name).toBeLessThanOrEqual(600);
      }
      // nested argument objects are closed too (export_video outputs)
      const outputs = (
        tools.find((t) => t.name === 'export_video')!.inputSchema.properties as Record<
          string,
          { additionalProperties?: unknown }
        >
      ).outputs;
      expect(outputs.additionalProperties).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
