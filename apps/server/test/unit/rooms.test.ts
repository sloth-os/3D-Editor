import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryFileStore,
  ProjectFileStore,
  SceneDoc,
  WebDAVClient,
  newUuid,
  type FileStore,
  type WriteOptions,
} from '@3d-editor/core';
import { RoomManager } from '../../src/sync/room-manager';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog } from '../../src/observability/log';
import { decodeAwarenessEntries, encodeAwarenessEntries } from '../../src/sync/awareness';
import type { Persistence } from '../../src/persistence';
import { mkcolPath, startWebDAV, type TestWebDAV, type TestWebDAVOptions } from '../helpers/webdav';

/** MemoryFileStore whose writes can be made to fail (storage outage). */
class FlakyStore extends MemoryFileStore {
  failWrites = false;
  override async write(path: string, data: Uint8Array, opts?: WriteOptions) {
    if (this.failWrites) throw new Error('storage offline');
    return super.write(path, data, opts);
  }
}

/**
 * A store that pairs content with the ETag of a newer write, the way the WebDAV client used to with
 * servers that send no ETag with GET or PUT: it read or wrote the content, then asked for the ETag
 * with a second request (PROPFIND), which another server's write could come before (the client now
 * pairs them, see packages/core/test/storage-etag.test.ts). Rooms merge every write even with such
 * a store, as they never skip stored content by its ETag. `betweenRead` / `betweenWrite` run once
 * between the two requests of the next read / write of a document.
 */
class SplitEtagStore extends MemoryFileStore {
  betweenRead: (() => Promise<unknown>) | null = null;
  betweenWrite: (() => Promise<unknown>) | null = null;
  override async read(path: string) {
    const r = await super.read(path);
    const between = this.betweenRead;
    if (!r || !between || !path.endsWith('/document.ybin')) return r;
    this.betweenRead = null;
    await between();
    return { data: r.data, etag: (await super.read(path))!.etag };
  }
  override async write(path: string, data: Uint8Array, opts?: WriteOptions) {
    const r = await super.write(path, data, opts);
    const between = this.betweenWrite;
    if (!between || !path.endsWith('/document.ybin')) return r;
    this.betweenWrite = null;
    await between();
    return { etag: (await super.read(path))!.etag };
  }
}

const managers: RoomManager[] = [];

function setup(opts: { ttlMs?: number; debounceMs?: number; fs?: FileStore } = {}) {
  const fs = opts.fs ?? new FlakyStore();
  const store = new ProjectFileStore(fs, '/');
  const persistence: Persistence = {
    mode: 'disk',
    store,
    location: 'memory',
    check: async () => ({ ok: true }),
  };
  const metrics = new ServerMetrics({ defaultMetrics: false });
  const rooms = new RoomManager({
    persistence,
    metrics,
    log: silentLog,
    ttlMs: opts.ttlMs ?? 60_000,
    debounceMs: opts.debounceMs ?? 10,
    serverVersion: 'test',
    sweepIntervalMs: 3_600_000,
  });
  managers.push(rooms);
  return { rooms, store, fs, metrics };
}

const davServers: TestWebDAV[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  await Promise.all(davServers.splice(0).map((d) => d.stop()));
});

type RequestHook = Parameters<NonNullable<TestWebDAVOptions['onRequest']>>[0];

/** A WebDAV server for rooms of several RoomManagers (servers), and a hook into its requests. */
async function sharedWebDAV(opts: TestWebDAVOptions) {
  let hook: ((req: RequestHook) => unknown) | null = null;
  const dav = await startWebDAV({ ...opts, onRequest: (req) => hook?.(req) });
  davServers.push(dav);
  await mkcolPath(dav, '/files');
  const client = (writer: string) =>
    new WebDAVClient({
      url: `${dav.origin}/files`,
      username: dav.username,
      password: dav.password,
      headers: { 'x-writer': writer },
    });
  return {
    dav,
    onRequest: (h: ((req: RequestHook) => unknown) | null) => (hook = h),
    /** A server (RoomManager) persisting to this WebDAV server; `writer` names its requests. */
    server: (writer: string, ttlMs = 60_000) => setup({ fs: client(writer), ttlMs, debounceMs: 60_000 }),
    docUrl: (id: string) => `${dav.origin}/files/projects/${id}/document.ybin`,
    /** The names of the objects of the stored document (null when none is stored). */
    stored: async (id: string) => {
      const stored = await new ProjectFileStore(client('check'), '/').loadDocument(id);
      if (!stored) return null;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, stored.update);
      return new SceneDoc(doc)
        .listObjects()
        .map((o) => o.name)
        .sort();
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await wait(10);
  }
}

describe('RoomManager', () => {
  it('creates and persists projects, loads them lazily', async () => {
    const { rooms, store } = setup();
    const room = await rooms.createProject({ name: 'First' });
    expect(await store.loadInfo(room.id)).toMatchObject({
      name: 'First',
      stats: { objects: 3, vertices: 8, faces: 6 },
    });
    expect(await rooms.open(newUuid())).toBeNull();
    expect(await rooms.open('not a valid id')).toBeNull();

    // a sync client may open an unknown project: empty rooms are not listed until they get content
    const blank = await rooms.open(newUuid(), { create: true });
    expect(blank).not.toBeNull();
    expect((await rooms.listProjects()).map((p) => p.name)).toEqual(['First']);
    blank!.scene.setName('Now with content');
    expect((await rooms.listProjects()).map((p) => p.name).sort()).toEqual(['First', 'Now with content']);
  });

  it('debounces saves and merges with the stored document', async () => {
    const { rooms, store } = setup({ debounceMs: 30 });
    const room = await rooms.createProject({ name: 'Debounced', empty: true });
    room.scene.addObject({ type: 'EMPTY', name: 'One' });
    room.scene.addObject({ type: 'EMPTY', name: 'Two' });
    expect(room.isDirty).toBe(true);
    await until(() => !room.isDirty);
    await room.flush(); // wait for the debounced save to finish
    // another writer changed the stored copy meanwhile: the next save merges it into the room
    const other = new Y.Doc();
    Y.applyUpdate(other, (await store.loadDocument(room.id))!.update);
    new SceneDoc(other).addObject({ type: 'EMPTY', name: 'Elsewhere' });
    await store.fs.write(store.docPath(room.id), Y.encodeStateAsUpdate(other));
    room.scene.addObject({ type: 'EMPTY', name: 'Three' });
    await room.flush();
    expect(room.scene.listObjects().map((o) => o.name)).toEqual(['Elsewhere', 'One', 'Three', 'Two']);
    expect((await store.loadInfo(room.id))!.stats!.objects).toBe(4);
  });

  it('merges changes made to the stored document by other writers on refresh', async () => {
    const { rooms, store, metrics } = setup();
    const room = await rooms.createProject({ name: 'Shared storage', empty: true });
    const other = new Y.Doc();
    Y.applyUpdate(other, (await store.loadDocument(room.id))!.update);
    new SceneDoc(other).addObject({ type: 'EMPTY', name: 'From another server' });
    await store.fs.write(store.docPath(room.id), Y.encodeStateAsUpdate(other));
    expect(room.scene.findObjectByName('From another server')).toBeNull();
    await room.refresh();
    expect(room.scene.findObjectByName('From another server')).not.toBeNull();
    expect(room.isDirty).toBe(false); // merged storage changes are not re-saved
    expect(await metrics.render()).toContain('persistence_operations_total{op="refresh",status="ok"} 1');
  });

  /*
   * Two servers sharing one storage (the WebDAV persistence integration test, which failed now and
   * then on a busy machine: 7 of 30 runs with every CPU busy). A server must merge every write of
   * the other one, also when the ETag it got with a read or a write names a newer write than the
   * content it read or wrote: it used to skip reading the stored document when its ETag equalled
   * the one of its last sync, and so never merged that newer write.
   */
  it("merges the other server's write that came between reading the document and its ETag", async () => {
    const fs = new SplitEtagStore();
    const one = setup({ fs, debounceMs: 60_000 });
    const two = setup({ fs, debounceMs: 60_000 });
    const a = await one.rooms.createProject({ name: 'Two servers' });
    const b = (await two.rooms.open(a.id))!;
    a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
    // server two refreshes while server one saves: two reads the document before one's write, and
    // its ETag after it
    fs.betweenRead = () => a.flush();
    await b.refresh();
    expect(b.scene.findObjectByName('Made on one')).toBeNull();
    // its next refresh reads one's write, with that ETag
    await b.refresh();
    expect(b.scene.findObjectByName('Made on one')).not.toBeNull();
  });

  it("merges the other server's write that came between its own write and that write's ETag", async () => {
    const fs = new SplitEtagStore();
    const one = setup({ fs, debounceMs: 60_000 });
    const two = setup({ fs, debounceMs: 60_000 });
    const a = await one.rooms.createProject({ name: 'Two servers' });
    const b = (await two.rooms.open(a.id))!;
    b.scene.addObject({ type: 'EMPTY', name: 'Made on two' });
    a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
    // server two saves; server one saves (merging two's write) before two asks for its ETag
    fs.betweenWrite = () => a.flush();
    await b.flush();
    expect(a.scene.findObjectByName('Made on two')).not.toBeNull();
    expect(b.scene.findObjectByName('Made on one')).toBeNull();
    await b.refresh();
    expect(b.scene.findObjectByName('Made on one')).not.toBeNull();
  });

  /*
   * Two servers sharing a WebDAV server that checks If-Match and reports ETags only with PROPFIND:
   * server two read the document, server one saved its change and stopped, then server two took
   * the ETag of one's write (PROPFIND) as the ETag of what it had read, and its write with that
   * If-Match replaced one's change in storage for good.
   */
  it("keeps a change in storage when its server stops right after another server's read", async () => {
    const shared = await sharedWebDAV({ conditional: true });
    const one = shared.server('one');
    const two = shared.server('two');
    const a = await one.rooms.createProject({ name: 'Two servers', empty: true });
    const b = (await two.rooms.open(a.id))!;
    b.scene.addObject({ type: 'EMPTY', name: 'Made on two' });
    a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
    let read = false;
    shared.onRequest(async (req) => {
      if (req.headers['x-writer'] !== 'two' || !req.path.endsWith('/document.ybin')) return;
      if (req.method === 'GET') read = true;
      else if (read) {
        // server two has read the document: server one saves its change and stops
        shared.onRequest(null);
        await a.flush();
        await one.rooms.close();
      }
    });
    await b.flush();
    expect(a.destroyed).toBe(true);
    expect(await shared.stored(a.id)).toEqual(['Made on one', 'Made on two']);
  });

  /*
   * A WebDAV server that ignores If-Match (webdav-server as the integration tests run it, nginx,
   * rclone): another writer that read the document before a room's save can write over it after
   * the room read its write back. The room reads storage again before it goes away, and in the
   * periodic refresh, and writes its change again.
   */
  it.each(['eviction', 'shutdown', 'periodic refresh'] as const)(
    'writes its change again at %s when a write it did not merge replaced it',
    async (when) => {
      const shared = await sharedWebDAV({});
      const one = shared.server('one', 20);
      const a = await one.rooms.createProject({ name: 'Replaced', empty: true });
      const headers = { authorization: shared.dav.authorization };
      const before = new Uint8Array(await (await fetch(shared.docUrl(a.id), { headers })).arrayBuffer());
      a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
      await a.flush();
      // the other writer had read the document before that save
      const other = new Y.Doc();
      Y.applyUpdate(other, before);
      new SceneDoc(other).addObject({ type: 'EMPTY', name: 'Made elsewhere' });
      const body = new Uint8Array(Y.encodeStateAsUpdate(other));
      await fetch(shared.docUrl(a.id), { method: 'PUT', headers, body });
      expect(await shared.stored(a.id)).toEqual(['Made elsewhere']);
      a.lastActive = 0;
      if (when === 'eviction') await one.rooms.sweep();
      else if (when === 'shutdown') await one.rooms.close();
      else await one.rooms.refreshActive();
      expect(await shared.stored(a.id)).toEqual(['Made elsewhere', 'Made on one']);
      if (when === 'eviction') {
        // merging the other write counted as activity: the next sweep evicts the room
        a.lastActive = 0;
        await one.rooms.sweep();
        expect(one.rooms.get(a.id)).toBeUndefined();
      }
    },
  );

  /*
   * Another server deleted the project after this one saved it, and the room has no unsaved
   * changes: reading its write back (before eviction, at shutdown, in the periodic refresh) used to
   * write the project again.
   */
  it.each(['eviction', 'shutdown', 'periodic refresh'] as const)(
    'does not bring back a project another server deleted, at %s',
    async (when) => {
      const shared = await sharedWebDAV({});
      const one = shared.server('one', 20);
      const two = shared.server('two');
      const a = await one.rooms.createProject({ name: 'Doomed', empty: true });
      a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
      await a.flush();
      expect(a.needsReadBack).toBe(true);
      expect(await two.rooms.deleteProject(a.id)).toBe(true);
      a.lastActive = 0;
      if (when === 'eviction') await one.rooms.sweep();
      else if (when === 'shutdown') await one.rooms.close();
      else await one.rooms.refreshActive();
      expect(await shared.stored(a.id)).toBeNull();
      // nor its project.json: a server that did not know the project does not list it
      expect((await shared.server('three').rooms.listProjects()).map((p) => p.id)).toEqual([]);
      if (when === 'eviction') expect(one.rooms.get(a.id)).toBeUndefined();
      if (when === 'periodic refresh') {
        expect(a.needsReadBack).toBe(false);
        // a change made in the room afterwards is saved (its editors keep their work)
        a.scene.addObject({ type: 'EMPTY', name: 'Made later' });
        await a.flush();
        expect(await shared.stored(a.id)).toEqual(['Made later', 'Made on one']);
      }
    },
  );

  /*
   * The room could not read storage before eviction (unreachable for this server), so it cannot
   * know whether another writer's save replaced its write: it used to be evicted all the same, and
   * a replaced change was then lost for good.
   */
  it('keeps a room that could not check its last save in storage, and writes the change again later', async () => {
    const shared = await sharedWebDAV({});
    const one = shared.server('one', 20);
    const a = await one.rooms.createProject({ name: 'Replaced', empty: true });
    const headers = { authorization: shared.dav.authorization };
    const before = new Uint8Array(await (await fetch(shared.docUrl(a.id), { headers })).arrayBuffer());
    a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
    await a.flush();
    expect(a.needsReadBack).toBe(true);
    // the other writer had read the document before that save
    const other = new Y.Doc();
    Y.applyUpdate(other, before);
    new SceneDoc(other).addObject({ type: 'EMPTY', name: 'Made elsewhere' });
    const body = new Uint8Array(Y.encodeStateAsUpdate(other));
    await fetch(shared.docUrl(a.id), { method: 'PUT', headers, body });
    // storage does not answer server one
    shared.onRequest((req) => {
      if (req.headers['x-writer'] === 'one') throw new Error('unreachable');
    });
    a.lastActive = 0;
    await one.rooms.sweep();
    expect(one.rooms.get(a.id)).toBe(a);
    expect(a.needsReadBack).toBe(true);
    // storage answers again: the next sweep writes the change again, and a later one evicts the room
    shared.onRequest(null);
    a.lastActive = 0;
    await one.rooms.sweep();
    expect(await shared.stored(a.id)).toEqual(['Made elsewhere', 'Made on one']);
    a.lastActive = 0;
    await one.rooms.sweep();
    expect(one.rooms.get(a.id)).toBeUndefined();
  });

  it('loads and lists projects from WebDAV with one GET of each file', async () => {
    // a server that sends no ETag with GET: reads whose ETag is used take two PROPFIND requests,
    // loading and listing use no ETag
    const shared = await sharedWebDAV({});
    const one = shared.server('one');
    const a = await one.rooms.createProject({ name: 'Load', empty: true });
    const sent: string[] = [];
    shared.onRequest((req) => {
      if (req.headers['x-writer'] === 'two')
        sent.push(`${req.method} ${req.path.replace(`/files/projects/${a.id}`, '~')}`);
    });
    const two = shared.server('two');
    expect(await two.rooms.open(a.id)).not.toBeNull();
    expect(sent.splice(0)).toEqual(['GET ~/document.ybin', 'GET ~/project.json']);
    await two.rooms.close();
    const three = shared.server('two');
    expect((await three.rooms.listProjects()).map((p) => p.name)).toEqual(['Load']);
    expect(sent).toEqual(['PROPFIND /files/projects', 'GET ~/project.json']);
  });

  it('evicts idle rooms after saving, but keeps rooms in use or with unsaved changes', async () => {
    const fs = new FlakyStore();
    const { rooms, store } = setup({ ttlMs: 20, debounceMs: 60_000, fs });
    const room = await rooms.createProject({ name: 'Idle', empty: true });
    room.scene.addObject({ type: 'EMPTY', name: 'Pending' });
    room.holders.add('mcp-session');
    await wait(40);
    await rooms.sweep();
    expect(rooms.get(room.id)).toBe(room); // held by an MCP session

    room.holders.delete('mcp-session');
    fs.failWrites = true;
    await rooms.sweep();
    expect(rooms.get(room.id)).toBe(room); // could not be saved: kept
    expect(room.isDirty).toBe(true);

    fs.failWrites = false;
    room.lastActive = 0;
    await rooms.sweep();
    expect(rooms.get(room.id)).toBeUndefined();
    expect(room.destroyed).toBe(true);
    const reloaded = await rooms.open(room.id);
    expect(reloaded).not.toBe(room);
    expect(reloaded!.scene.findObjectByName('Pending')).not.toBeNull();
    expect((await store.loadInfo(room.id))!.name).toBe('Idle');
  });

  it('publishes and removes server-side (agent) presence', async () => {
    const { rooms } = setup();
    const room = await rooms.createProject({ name: 'Presence', empty: true });
    room.setAgentPresence(1234, {
      user: { name: 'AI agent (test)', color: '#fff', kind: 'agent' },
      selection: ['a'],
      mode: 'OBJECT',
    });
    expect(room.presence()).toEqual([
      expect.objectContaining({
        clientId: 1234,
        kind: 'agent',
        connectionId: null,
        state: expect.objectContaining({ selection: ['a'] }),
      }),
    ]);
    room.setAgentPresence(1234, {
      user: { name: 'AI agent (test)', color: '#fff', kind: 'agent' },
      selection: [],
      mode: 'EDIT',
    });
    expect(room.presence()[0].state.mode).toBe('EDIT');
    room.setAgentPresence(1234, null);
    expect(room.presence()).toEqual([]);
  });

  it('deletes projects and refuses to resurrect them', async () => {
    const { rooms, store } = setup();
    const room = await rooms.createProject({ name: 'Doomed' });
    expect(await rooms.deleteProject(room.id)).toBe(true);
    expect(room.destroyed).toBe(true);
    expect(await store.loadInfo(room.id)).toBeNull();
    expect(rooms.isDeleted(room.id)).toBe(true);
    expect(await rooms.open(room.id, { create: true })).toBeNull();
    expect(await rooms.deleteProject(room.id)).toBe(false);
  });
});

describe('awareness encoding', () => {
  it('round-trips entries in the y-protocols format', () => {
    const entries = [
      { clientId: 7, clock: 3, state: { user: { name: 'x' } } },
      { clientId: 9, clock: 1, state: null },
    ];
    expect(decodeAwarenessEntries(encodeAwarenessEntries(entries))).toEqual(entries);
  });
});
