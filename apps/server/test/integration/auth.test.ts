import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newUuid } from '@3d-editor/core';
import { api, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

const TOKEN = 'team-secret';
const MCP_TOKEN = 'agent-secret';
let server: TestServer;

beforeAll(async () => {
  server = await startServer({ AUTH_TOKEN: TOKEN, MCP_TOKEN });
});

afterAll(async () => {
  await server.close();
  await server.cleanup();
});

describe('AUTH_TOKEN enforcement', () => {
  it('protects the REST API (Bearer header or ?token=)', async () => {
    const denied = await api(server.url, '/api/config');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await api(server.url, '/api/projects', { token: 'wrong' })).status).toBe(401);
    expect((await api(server.url, '/api/projects', { token: MCP_TOKEN })).status).toBe(401);
    expect((await api(server.url, '/api/config', { token: TOKEN })).status).toBe(200);
    expect((await api(server.url, `/api/projects?token=${TOKEN}`)).status).toBe(200);
    const created = await api(server.url, '/api/projects', {
      method: 'POST',
      json: { name: 'Secret' },
      token: TOKEN,
    });
    expect(created.status).toBe(201);
  });

  it('keeps health, readiness and metrics public', async () => {
    expect((await api(server.url, '/healthz')).status).toBe(200);
    expect((await api(server.url, '/readyz')).status).toBe(200);
    expect((await fetch(`${server.url}/metrics`)).status).toBe(200);
  });

  it('protects telemetry ingestion', async () => {
    const body = JSON.stringify({ resourceLogs: [] });
    const headers = { 'content-type': 'application/json' };
    expect((await fetch(`${server.url}/otlp/v1/logs`, { method: 'POST', headers, body })).status).toBe(401);
    expect(
      (await fetch(`${server.url}/otlp/v1/logs?token=${TOKEN}`, { method: 'POST', headers, body })).status,
    ).toBe(200);
  });

  it('protects WebSocket sync upgrades', async () => {
    const id = newUuid();
    const anonymous = new SyncTestClient({ baseUrl: server.url, projectId: id });
    await expect(anonymous.connect()).rejects.toThrow(/HTTP 401/);
    const wrong = new SyncTestClient({ baseUrl: server.url, projectId: id, token: 'nope' });
    await expect(wrong.connect()).rejects.toThrow(/HTTP 401/);
    const ok = new SyncTestClient({ baseUrl: server.url, projectId: id, token: TOKEN });
    await ok.connect();
    expect(ok.hello?.room).toBe(id);
    await ok.destroy();
    await anonymous.destroy();
    await wrong.destroy();
  });

  it('accepts the MCP token (or the shared secret) on /mcp only', async () => {
    const connect = async (token?: string) => {
      const client = new Client({ name: 'auth-test', version: '1' });
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers } }),
      );
      return client;
    };
    await expect(connect()).rejects.toThrow();
    await expect(connect('wrong')).rejects.toThrow();
    for (const token of [MCP_TOKEN, TOKEN]) {
      const client = await connect(token);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      await client.close();
    }
    const raw = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(raw.status).toBe(401);
  });
});
