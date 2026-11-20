import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newUuid } from '@3d-editor/core';
import { api, eventually, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

/*
 * WebSocket upgrades bypass Fastify's hooks (app.server's 'upgrade' event, SyncServer): their access
 * line ('upgrade completed') and their count in http_requests_total come from the sync server
 * itself, one per handshake, refused or accepted (docs/observability.md).
 */

const TOKEN = 'upgrade-log-secret';

interface Line {
  level: number;
  msg?: string;
  method?: string;
  url?: string;
  route?: string;
  statusCode?: number;
  reason?: string;
  responseTimeMs?: number;
  aborted?: boolean;
  closeCode?: number;
}

const lines: Line[] = [];
let server: TestServer;

beforeAll(async () => {
  server = await startServer(
    { AUTH_TOKEN: TOKEN },
    {
      logger: {
        level: 'debug',
        stream: { write: (line: string) => void lines.push(JSON.parse(line) as Line) },
      },
    },
  );
});

afterAll(async () => {
  await server.close();
  await server.cleanup();
});

/**
 * Sends a raw upgrade request (headers given as '' are left out) and resolves with the status line
 * of the answer; with `leave`, the client closes its socket right after the request and resolves
 * with 'left'.
 */
function rawUpgrade(
  path: string,
  headers: Record<string, string> = {},
  opts: { method?: string; leave?: boolean; base?: string } = {},
): Promise<string> {
  const u = new URL(opts.base ?? server.url);
  return new Promise((resolve) => {
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const all: Record<string, string> = {
        Host: u.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...headers,
      };
      const head = Object.entries(all)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      socket.write(`${opts.method ?? 'GET'} ${path} HTTP/1.1\r\n${head}\r\n\r\n`);
      if (opts.leave) {
        socket.destroy();
        resolve('left');
      }
    });
    let data = '';
    socket.on('data', (b: Buffer) => {
      data += b.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(data.slice(0, data.indexOf('\r\n')));
      }
    });
    socket.on('error', (err) => resolve(`error ${err.message}`));
  });
}

const upgradeLines = () => lines.filter((l) => l.msg === 'upgrade completed');
/** The upgrade line of the request to `path` (the url as logged). */
const lineOf = (url: string): Promise<Line> =>
  eventually(() => upgradeLines().find((l) => l.url === url), 5000, url) as Promise<Line>;

async function counted(route: string, status: number, method = 'GET', base = server.url): Promise<number> {
  const text = (await api<string>(base, '/metrics')).body;
  const re = new RegExp(
    `^http_requests_total\\{method="${method}",route="${route.replace(/\//g, '\\/')}",status="${status}"\\} (\\d+)$`,
    'm',
  );
  return Number(re.exec(text)?.[1] ?? 0);
}

describe('WebSocket upgrades in the access log and the HTTP metrics', () => {
  it('logs and counts a refused upgrade: no route, a bad project id, no token, a malformed handshake', async () => {
    const id = newUuid();
    expect(await rawUpgrade('/no-such-path')).toBe('HTTP/1.1 404 Not Found');
    expect(await rawUpgrade('/sync/bad%ZZ')).toBe('HTTP/1.1 400 Bad Request');
    expect(await rawUpgrade(`/sync/${id}?token=wrong`)).toBe('HTTP/1.1 401 Unauthorized');
    // a handshake ws itself refuses (here: no Sec-WebSocket-Key), after the room opened
    expect(await rawUpgrade(`/sync/${id}?token=${TOKEN}`, { 'Sec-WebSocket-Key': '' })).toBe(
      'HTTP/1.1 400 Bad Request',
    );

    const notFound = await lineOf('/no-such-path');
    expect(notFound).toMatchObject({
      level: 30,
      method: 'GET',
      route: 'unmatched',
      statusCode: 404,
      reason: 'not found',
      aborted: false,
    });
    expect(notFound.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(await lineOf('/sync/bad%ZZ')).toMatchObject({
      level: 30,
      route: '/sync/:projectId',
      statusCode: 400,
      reason: 'invalid project id',
    });
    // the token is never logged
    expect(await lineOf(`/sync/${id}?token=[REDACTED]`)).toMatchObject({
      level: 30,
      route: '/sync/:projectId',
      statusCode: 401,
      reason: 'unauthorized',
    });
    const malformed = await eventually(
      () => upgradeLines().find((l) => l.statusCode === 400 && /Sec-WebSocket-Key/.test(l.reason ?? '')),
      5000,
      'the malformed handshake',
    );
    expect(malformed).toMatchObject({ level: 30, route: '/sync/:projectId' });
    expect(lines.some((l) => JSON.stringify(l).includes('wrong') || JSON.stringify(l).includes(TOKEN))).toBe(
      false,
    );

    expect(await counted('unmatched', 404)).toBe(1);
    expect(await counted('/sync/:projectId', 400)).toBe(2);
    expect(await counted('/sync/:projectId', 401)).toBe(1);

    // another method: ws refuses it with 405, as it always has
    const other = newUuid();
    expect(await rawUpgrade(`/sync/${other}?token=${TOKEN}`, {}, { method: 'POST' })).toBe(
      'HTTP/1.1 405 Method Not Allowed',
    );
    expect(await lineOf(`/sync/${other}?token=[REDACTED]`)).toMatchObject({
      level: 30,
      method: 'POST',
      statusCode: 405,
      reason: 'Invalid HTTP method',
    });
    expect(await counted('/sync/:projectId', 405, 'POST')).toBe(1);
  });

  it('logs an accepted upgrade at debug and counts it as 101, and a server fault at warn as 500', async () => {
    const before = await counted('/sync/:projectId', 101);
    const c = new SyncTestClient({ baseUrl: server.url, projectId: newUuid(), token: TOKEN });
    try {
      await c.connect();
      const accepted = await lineOf(`/sync/${c.opts.projectId}?token=[REDACTED]`);
      expect(accepted).toMatchObject({
        level: 20,
        method: 'GET',
        route: '/sync/:projectId',
        statusCode: 101,
        aborted: false,
      });
      expect(await counted('/sync/:projectId', 101)).toBe(before + 1);
    } finally {
      await c.destroy();
    }

    const spy = vi.spyOn(server.handle.rooms, 'open').mockRejectedValueOnce(new Error('disk on fire'));
    try {
      const id = newUuid();
      expect(await rawUpgrade(`/sync/${id}?token=${TOKEN}`)).toBe('HTTP/1.1 500 Internal Server Error');
      expect(await lineOf(`/sync/${id}?token=[REDACTED]`)).toMatchObject({
        level: 40,
        statusCode: 500,
        reason: 'internal error',
      });
      expect(await counted('/sync/:projectId', 500)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a client that leaves while its project loads, without an answer', async () => {
    const rooms = server.handle.rooms;
    const open = rooms.open.bind(rooms);
    let opened!: () => void;
    const loading = new Promise<void>((resolve) => (opened = resolve));
    const spy = vi.spyOn(rooms, 'open').mockImplementationOnce(async (projectId, opts) => {
      await loading;
      return open(projectId, opts);
    });
    try {
      const id = newUuid();
      expect(await rawUpgrade(`/sync/${id}?token=${TOKEN}`, {}, { leave: true })).toBe('left');
      await eventually(() => spy.mock.calls.length === 1, 5000, 'the project to load');
      await new Promise((resolve) => setTimeout(resolve, 100));
      opened();
      expect(await lineOf(`/sync/${id}?token=[REDACTED]`)).toMatchObject({
        level: 20,
        statusCode: 101,
        reason: 'the client went away before the answer',
        aborted: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('logs at warn and counts an upgrade the server refuses while it shuts down', async () => {
    const own: Line[] = [];
    const s = await startServer(
      {},
      {
        logger: {
          level: 'debug',
          stream: { write: (line: string) => void own.push(JSON.parse(line) as Line) },
        },
      },
    );
    try {
      await s.handle.sync.close();
      const id = newUuid();
      expect(await rawUpgrade(`/sync/${id}`, {}, { base: s.url })).toBe('HTTP/1.1 503 Service Unavailable');
      const line = await eventually(
        () => own.find((l) => l.msg === 'upgrade completed' && l.url === `/sync/${id}`),
        5000,
        'the refused upgrade',
      );
      expect(line).toMatchObject({ level: 40, statusCode: 503, reason: 'server is shutting down' });
      expect(await counted('/sync/:projectId', 503, 'GET', s.url)).toBe(1);
    } finally {
      await s.close();
      await s.cleanup();
    }
  });
});
