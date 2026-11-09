import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { newUuid } from '@3d-editor/core';
import { api, eventually, sleep, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

let server: TestServer;
const clients: SyncTestClient[] = [];

function client(
  projectId: string,
  opts: Partial<ConstructorParameters<typeof SyncTestClient>[0]> = {},
): SyncTestClient {
  const c = new SyncTestClient({ baseUrl: server.url, projectId, ...opts });
  clients.push(c);
  return c;
}

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.destroy()));
  await server.close();
  await server.cleanup();
});

describe('real-time sync', () => {
  it('says hello, syncs the server document and reports peers', async () => {
    const created = await api(server.url, '/api/projects', { method: 'POST', json: { name: 'Sync me' } });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const a = client(id, { name: 'Alice' });
    await a.connect();
    expect(a.hello).toMatchObject({ kind: 'hello', room: id, protocol: 1, peers: 1 });
    expect(a.hello!.connectionId).toBeTruthy();
    expect(a.scene.name).toBe('Sync me');
    expect(a.scene.listObjects().map((o) => o.name)).toEqual(['Camera', 'Cube', 'Light']);

    const b = client(id, { name: 'Bob' });
    await b.connect();
    expect(b.hello!.peers).toBe(2);
    await a.waitFor(() => a.peers === 2, 10_000, 'peers=2');
    await b.disconnect();
    await a.waitFor(() => a.peers === 1, 10_000, 'peers=1');
  });

  it('converges two clients editing the same project', async () => {
    const id = newUuid();
    const a = client(id, { name: 'Alice' });
    const b = client(id, { name: 'Bob' });
    await a.connect();
    await b.connect();
    const cubeId = a.scene.addObject({ type: 'EMPTY', name: 'FromA', location: [1, 2, 3] });
    await b.waitFor(() => !!b.scene.findObjectByName('FromA'), 10_000, 'object from A');
    b.scene.updateObject(cubeId, { location: [4, 5, 6] });
    b.scene.addObject({ type: 'EMPTY', name: 'FromB' });
    await a.waitFor(
      () => !!a.scene.findObjectByName('FromB') && a.scene.getObject(cubeId)!.location[0] === 4,
      10_000,
      'changes from B',
    );
    // concurrent edits of different fields merge
    a.scene.updateObject(cubeId, { scale: [2, 2, 2] });
    b.scene.updateObject(cubeId, { rotation_euler: [0, 0, 1] });
    await eventually(() => {
      const oa = a.scene.getObject(cubeId)!;
      const ob = b.scene.getObject(cubeId)!;
      return (
        oa.scale[0] === 2 && ob.scale[0] === 2 && oa.rotation_euler[2] === 1 && ob.rotation_euler[2] === 1
      );
    });
    // the server room holds the merged state
    const room = server.handle.rooms.get(id)!;
    expect(room.scene.getObject(cubeId)).toMatchObject({
      location: [4, 5, 6],
      scale: [2, 2, 2],
      rotation_euler: [0, 0, 1],
    });
  });

  it('propagates awareness and removes it when a client leaves', async () => {
    const id = newUuid();
    const a = client(id, { name: 'Alice' });
    const b = client(id, { name: 'Bob' });
    await a.connect();
    await b.connect();
    await a.waitFor(() => a.remoteStates().some((s) => s.user?.name === 'Bob'), 10_000, 'Bob presence');
    b.setPresence({ selection: ['x'], mode: 'EDIT' });
    await a.waitFor(
      () => a.remoteStates().some((s) => s.user?.name === 'Bob' && s.mode === 'EDIT'),
      10_000,
      'Bob in edit mode',
    );
    // a late joiner receives the full awareness state on connect
    const c = client(id, { name: 'Carol' });
    await c.connect();
    await c.waitFor(
      () => c.remoteStates().filter((s) => s.user?.kind === 'human').length === 2,
      10_000,
      'full awareness',
    );
    const room = server.handle.rooms.get(id)!;
    expect(
      room
        .presence()
        .map((p) => p.state.user?.name)
        .sort(),
    ).toEqual(['Alice', 'Bob', 'Carol']);
    await b.disconnect();
    await a.waitFor(() => !a.remoteStates().some((s) => s.user?.name === 'Bob'), 10_000, 'Bob removed');
    expect(
      room
        .presence()
        .map((p) => p.state.user?.name)
        .sort(),
    ).toEqual(['Alice', 'Carol']);
  });

  it('merges offline edits after reconnecting', async () => {
    const id = newUuid();
    const a = client(id, { name: 'Alice' });
    const b = client(id, { name: 'Bob' });
    await a.connect();
    await b.connect();
    const shared = a.scene.addObject({ type: 'EMPTY', name: 'Shared' });
    await b.waitFor(() => !!b.scene.getObject(shared), 10_000, 'shared object');
    await a.disconnect();
    // offline edits on A, concurrent online edits on B
    a.scene.addObject({ type: 'EMPTY', name: 'OfflineA' });
    a.scene.updateObject(shared, { location: [9, 9, 9] });
    b.scene.addObject({ type: 'EMPTY', name: 'OnlineB' });
    b.scene.updateObject(shared, { scale: [3, 3, 3] });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.scene.findObjectByName('OfflineA')).toBeNull();
    await a.connect();
    await eventually(
      () => a.scene.findObjectByName('OnlineB') && b.scene.findObjectByName('OfflineA'),
      10_000,
      'offline merge',
    );
    for (const c of [a, b])
      expect(c.scene.getObject(shared)).toMatchObject({ location: [9, 9, 9], scale: [3, 3, 3] });
  });

  it('answers pings, awareness queries and routes RPCs to capable editors', async () => {
    const id = newUuid();
    const plain = client(id, { name: 'Viewer' });
    const editor = client(id, {
      name: 'Editor',
      capabilities: ['render', 'ui'],
      rpcHandler: (method, params) => {
        if (method === 'ui') return { echoed: params };
        throw new Error(`unsupported ${method}`);
      },
    });
    await plain.connect();
    await editor.connect();
    plain.ping(42);
    await plain.waitFor(() => plain.controls.some((m) => m.kind === 'pong' && m.t === 42), 10_000, 'pong');
    const room = server.handle.rooms.get(id)!;
    await eventually(() => room.rpcCandidates('ui').length === 1, 10_000, 'client-info');
    await expect(room.rpc('ui', { command: 'view.frame_all' }, { capability: 'ui' })).resolves.toEqual({
      echoed: { command: 'view.frame_all' },
    });
    await expect(room.rpc('render', {}, { capability: 'render', timeoutMs: 10_000 })).rejects.toThrow(
      /unsupported render/,
    );
    await expect(room.rpc('x', {}, { capability: 'teleport' })).rejects.toMatchObject({ code: 'NO_CLIENT' });
    expect(editor.rpcRequests.map((r) => r.method)).toEqual(['ui', 'render']);
    // slow clients time out
    editor.rpcHandler = () => new Promise(() => {});
    await expect(room.rpc('ui', {}, { capability: 'ui', timeoutMs: 200 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    const metrics = await server.handle.metrics.render();
    expect(metrics).toMatch(/sync_rpc_requests_total\{method="ui",status="ok"\} 1/);
    expect(metrics).toMatch(/sync_messages_total\{type="sync",direction="in"\} \d+/);
  });

  it('rejects invalid project ids and plain HTTP requests', async () => {
    const bad = new SyncTestClient({ baseUrl: server.url, projectId: 'bad id!' });
    await expect(bad.connect()).rejects.toThrow(/HTTP 400/);
    const res = await api(server.url, `/sync/${newUuid()}`);
    expect(res.status).toBe(426);
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${server.url.replace('http', 'ws')}/elsewhere`);
      ws.on('unexpected-response', (_req, r) => {
        expect(r.statusCode).toBe(404);
        resolve();
      });
      ws.on('error', () => resolve());
    });
  });
});

/**
 * A WebSocket connection to `/sync/<id>` over a plain TCP socket: unlike a WebSocket client it can
 * send frames that clients must not send, and leave the server's close frame unanswered.
 */
async function rawSyncSocket(base: string, id: string) {
  const u = new URL(base);
  const socket = net.connect(Number(u.port), u.hostname);
  let received = Buffer.alloc(0);
  socket.on('data', (d: Buffer) => {
    received = Buffer.concat([received, d]);
  });
  socket.on('error', () => undefined);
  const closed = new Promise<number>((resolve) => socket.once('close', () => resolve(Date.now())));
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    `GET /sync/${id} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  /** The status line of the server's answer, and the close frame it sent after it (null until then). */
  const closeFrame = (): { status: string; code: number; reason: string } | null => {
    const end = received.indexOf('\r\n\r\n');
    if (end < 0) return null;
    const status = received.subarray(0, received.indexOf('\r\n')).toString('latin1');
    const frame = received.subarray(end + 4);
    // a server frame is not masked: FIN + opcode 8, payload length < 126, code, reason
    if (frame.length < 2 || frame.length < 2 + frame[1]) return null;
    expect(frame[0]).toBe(0x88);
    return {
      status,
      code: frame.readUInt16BE(2),
      reason: frame.subarray(4, 2 + frame[1]).toString('utf8'),
    };
  };
  return { socket, closed, closeFrame };
}

/** Collects the uncaught exceptions of this process while `fn` runs (an unhandled 'error' event). */
async function uncaughtDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => void uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    await fn();
    await sleep(50);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return uncaught;
}

describe('sync connections that no room takes', () => {
  async function deletedProject(base: string): Promise<string> {
    const created = await api(base, '/api/projects', { method: 'POST', json: { name: 'Deleted' } });
    expect((await api(base, `/api/projects/${created.body.id}`, { method: 'DELETE' })).status).toBe(204);
    return created.body.id as string;
  }

  /** An unmasked binary frame: a client must mask its frames (ws reports a protocol error). */
  const UNMASKED_FRAME = Buffer.from([0x82, 0x03, 1, 2, 3]);

  it('keeps running when a client breaks the protocol on a connection to a deleted project', async () => {
    const id = await deletedProject(server.url);
    const uncaught = await uncaughtDuring(async () => {
      const raw = await rawSyncSocket(server.url, id);
      const answer = await eventually(() => raw.closeFrame(), 5000, 'the close frame');
      expect(answer).toEqual({
        status: 'HTTP/1.1 101 Switching Protocols',
        code: 4404,
        reason: 'project deleted',
      });
      raw.socket.write(UNMASKED_FRAME);
      await raw.closed;
    });
    // without an 'error' listener on that connection, ws's 'error' event ended the server process
    expect(uncaught).toEqual([]);
    expect((await api(server.url, '/healthz')).status).toBe(200);
    const c = client(newUuid());
    await c.connect();
    expect(c.synced).toBe(true);
  });

  it('keeps running when a client breaks the protocol on a connection to a room closed meanwhile', async () => {
    const rooms = server.handle.rooms;
    const open = rooms.open.bind(rooms);
    // the room is closed between opening it and taking the connection (as by a deletion then)
    const spy = vi.spyOn(rooms, 'open').mockImplementationOnce(async (projectId, opts) => {
      const room = await open(projectId, opts);
      await room?.close({ flush: false });
      return room;
    });
    try {
      const uncaught = await uncaughtDuring(async () => {
        const raw = await rawSyncSocket(server.url, newUuid());
        const answer = await eventually(() => raw.closeFrame(), 5000, 'the close frame');
        expect(answer).toMatchObject({ code: 1012, reason: 'room closed' });
        raw.socket.write(UNMASKED_FRAME);
        await raw.closed;
      });
      expect(uncaught).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect((await api(server.url, '/healthz')).status).toBe(200);
  });

  it('disconnects a client that does not answer the close frame of a deleted project within seconds', async () => {
    const id = await deletedProject(server.url);
    const raw = await rawSyncSocket(server.url, id);
    await eventually(() => raw.closeFrame(), 5000, 'the close frame');
    const t0 = Date.now();
    // 2 s (as a room does with its connections); ws alone waits 30 s for the answer
    expect((await raw.closed) - t0).toBeLessThan(10_000);
  });

  it('does not wait long for such a client when it shuts down', async () => {
    const s = await startServer();
    try {
      const id = await deletedProject(s.url);
      const raw = await rawSyncSocket(s.url, id);
      await eventually(() => raw.closeFrame(), 5000, 'the close frame');
      const t0 = Date.now();
      await s.close();
      // the server waits up to 2 s for an answer to its close frames (ws alone waits 30 s)
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(s.handle.sync.wss.clients.size).toBe(0);
      await raw.closed;
    } finally {
      await s.close();
      await s.cleanup();
    }
  });
});
