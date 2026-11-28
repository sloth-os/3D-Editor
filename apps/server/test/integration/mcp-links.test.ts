import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../helpers/app';

/*
 * The links of MCP results when the request names no usable host (docs/mcp.md, docs/subpath.md,
 * mcp/tool-kit.ts baseUrl), through the real MCP transport: a Host the transport reads but no host
 * name or address with a port from 1 to 65535 (`a"b`, `example.com:0`), with no usable
 * X-Forwarded-Host, gives `editor_url` as a path under the base (`/3d/?project=<id>`), never one
 * from the root of the site; a usable X-Forwarded-Host still gives the address. A request without
 * a Host gets no links at all: it is answered 400 before any tool runs, by Node over HTTP/1.1 and by
 * the MCP transport over HTTP/1.0.
 */

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ BASE_PATH: '/3d' });
});

afterAll(async () => {
  await server?.close();
  await server?.cleanup();
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  /** The JSON-RPC messages of the answer (one JSON body, or the `data:` lines of an event stream). */
  messages: any[];
}

/** A JSON-RPC message POSTed to `/3d/mcp` with these headers, `host` among them, sent as given. */
function post(headers: Record<string, string>, message: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: '/3d/mcp',
        headers: { ...MCP_HEADERS, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          const messages = String(res.headers['content-type']).startsWith('text/event-stream')
            ? body
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => JSON.parse(l.slice('data: '.length)))
            : body
              ? [JSON.parse(body)]
              : [];
          resolve({ status: res.statusCode ?? 0, headers: res.headers, messages });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(message));
  });
}

const initialize = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-links-test', version: '1' },
  },
});

/** An MCP session opened with these headers (every request of it sends them): its id. */
async function open(headers: Record<string, string>): Promise<string> {
  const init = await post(headers, initialize(1));
  expect(init.status, JSON.stringify(headers)).toBe(200);
  const session = String(init.headers['mcp-session-id']);
  const initialized = await post(
    { ...headers, 'mcp-session-id': session },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  );
  expect(initialized.status).toBe(202);
  return session;
}

/** Calls a tool in a session, sending these headers, and gives its result's JSON. */
async function callTool(
  headers: Record<string, string>,
  session: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await post(
    { ...headers, 'mcp-session-id': session },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  );
  expect(res.status).toBe(200);
  const result = res.messages.find((m) => m.id === 2)?.result;
  expect(result?.isError, JSON.stringify(result)).toBeFalsy();
  return JSON.parse(result.content.find((c: { type: string }) => c.type === 'text').text);
}

/** The status line of a raw request (`target`, HTTP version and header lines exactly as given). */
function raw(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.port, '127.0.0.1', () => socket.end(request));
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (answer += chunk));
    socket.on('end', () => resolve(answer.split('\r\n')[0]));
    socket.on('error', reject);
  });
}

describe('MCP links without a usable host', () => {
  it('are paths under the base when neither Host nor X-Forwarded-Host is a usable host', async () => {
    const unusable: Record<string, string>[] = [
      { host: 'a"b' },
      { host: 'example.com:0' },
      { host: 'a"b', 'x-forwarded-host': 'a{b}' },
      { host: 'example.com:0', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'x y' },
    ];
    for (const [i, headers] of unusable.entries()) {
      const session = await open(headers);
      const created = await callTool(headers, session, 'create_project', { name: `No usable host ${i}` });
      expect(created.editor_url, JSON.stringify(headers)).toBe(`/3d/?project=${created.id}`);
      const got = await callTool(headers, session, 'get_project', { project: created.id });
      expect(got.editor_url, JSON.stringify(headers)).toBe(`/3d/?project=${created.id}`);
    }
  });

  it('take a usable X-Forwarded-Host when the Host is not usable', async () => {
    const headers = { host: 'a"b', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' };
    const session = await open(headers);
    const created = await callTool(headers, session, 'create_project', { name: 'Forwarded host' });
    expect(created.editor_url).toBe(`https://example.com/3d/?project=${created.id}`);
  });

  it('are never given to a request without a Host: 400 over HTTP/1.1 and HTTP/1.0, before any tool runs', async () => {
    const body = JSON.stringify(initialize(1));
    const lines = (version: string) =>
      `POST /3d/mcp HTTP/${version}\r\nContent-Type: application/json\r\n` +
      `Accept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n${body}`;
    expect(await raw(lines('1.1'))).toBe('HTTP/1.1 400 Bad Request');
    expect(await raw(lines('1.0'))).toMatch(/^HTTP\/1\.1 400 /);

    // in an open session, a tool call without a Host runs no tool: the project is not made
    const headers = { host: `127.0.0.1:${server.port}` };
    const session = await open(headers);
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_project', arguments: { name: 'Made without a Host' } },
    });
    const status = await raw(
      `POST /3d/mcp HTTP/1.0\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
        `Mcp-Session-Id: ${session}\r\nContent-Length: ${Buffer.byteLength(call)}\r\n\r\n${call}`,
    );
    expect(status).toMatch(/^HTTP\/1\.1 400 /);
    const listed = await callTool(headers, session, 'list_projects', {});
    expect(listed.projects.map((p: { name: string }) => p.name)).not.toContain('Made without a Host');
  });
});
