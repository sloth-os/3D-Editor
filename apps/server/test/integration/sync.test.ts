import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { newUuid } from '@3d-editor/core';
import { api, eventually, startServer, type TestServer } from '../helpers/app';
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
