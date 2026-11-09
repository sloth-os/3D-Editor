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
import { silentLog, type Log } from '../../src/observability/log';
import { decodeAwarenessEntries, encodeAwarenessEntries } from '../../src/sync/awareness';
import { projectInfoFromScene } from '../../src/sync/project-info';
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

/**
 * MemoryFileStore whose reads of documents, and requests for their ETags, can be held (storage that
 * does not answer them).
 */
class HeldStore extends MemoryFileStore {
  hold: Promise<void> | null = null;
  documentReads = 0;
  etagRequests = 0;
  override async read(path: string) {
    if (path.endsWith('/document.ybin')) {
      this.documentReads++;
      if (this.hold) await this.hold;
    }
    return super.read(path);
  }
  override async etag(path: string) {
    this.etagRequests++;
    if (this.hold) await this.hold;
    return super.etag(path);
  }
}

/** MemoryFileStore whose folder listings can be made to fail (storage outage for PROPFIND). */
class ListFailStore extends MemoryFileStore {
  failList = false;
  override async list(dir: string) {
    if (this.failList) throw new Error('storage offline');
    return super.list(dir);
  }
}

const managers: RoomManager[] = [];

function setup(
  opts: { ttlMs?: number; debounceMs?: number; fs?: FileStore; log?: Log; openReadWaitMs?: number } = {},
) {
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
    log: opts.log ?? silentLog,
    ttlMs: opts.ttlMs ?? 60_000,
    debounceMs: opts.debounceMs ?? 10,
    serverVersion: 'test',
    sweepIntervalMs: 3_600_000,
    openReadWaitMs: opts.openReadWaitMs,
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
    server: (writer: string, ttlMs = 60_000, log?: Log) =>
      setup({ fs: client(writer), ttlMs, debounceMs: 60_000, log }),
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

/** What `p` resolves to, or 'still waiting' when it takes longer than `ms`. */
function within<T>(p: Promise<T>, ms = 1000): Promise<T | 'still waiting'> {
  return Promise.race([p, wait(ms).then(() => 'still waiting' as const)]);
}

/** A log that keeps the level and message of each line. */
function recordingLog() {
  const lines: string[] = [];
  const line = (level: string) => (_obj: unknown, msg?: string) => lines.push(`${level} ${msg ?? ''}`);
  const log: Log = { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
  return { log, lines };
}

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
   * write the project again. Nobody uses the room: it is closed, and this server answers like the
   * one that deleted the project (an idle room used to stay listed and open for up to an hour, and
   * a change made by an agent that opened it saved the project again).
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
      expect(a.destroyed).toBe(true);
      if (when === 'shutdown') return;
      expect(one.rooms.get(a.id)).toBeUndefined();
      expect(await one.rooms.listProjects()).toEqual([]);
      expect(await one.rooms.open(a.id)).toBeNull();
      expect(await one.rooms.exists(a.id)).toBe(false);
      // a browser that still has the project cannot upload it again at once (as on server two)
      expect(await one.rooms.open(a.id, { create: true })).toBeNull();
    },
  );

  /*
   * An editor or an MCP agent still uses the room when another server deletes the project: the
   * room stays, and a change made in it afterwards saves the project again (its users keep their
   * work). The server logs both.
   */
  it('keeps a room in use whose project another server deleted, and saves it again when it changes', async () => {
    const shared = await sharedWebDAV({});
    const rec = recordingLog();
    const one = shared.server('one', 60_000, rec.log);
    const two = shared.server('two');
    const a = await one.rooms.createProject({ name: 'In use', empty: true });
    a.holders.add('mcp-session');
    a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
    await a.flush();
    expect(await two.rooms.deleteProject(a.id)).toBe(true);
    await one.rooms.refreshActive();
    expect(a.destroyed).toBe(false);
    expect(a.deletedFromStorage).toBe(true);
    expect(await shared.stored(a.id)).toBeNull();
    a.scene.addObject({ type: 'EMPTY', name: 'Made later' });
    await a.flush();
    expect(await shared.stored(a.id)).toEqual(['Made later', 'Made on one']);
    expect(a.deletedFromStorage).toBe(false);
    expect(rec.lines.filter((l) => l.includes('deleted from storage'))).toEqual([
      'info project deleted from storage elsewhere: not saved again unless it changes on this server',
      'info project deleted from storage elsewhere: saved again with the changes made on this server',
    ]);
  });

  /*
   * Server one still has a room for the project that nobody uses and that has not read storage
   * since another server deleted the project (it did not write recently): it used to list the
   * project until the room was evicted (ROOM_IDLE_TTL_SECONDS, an hour by default). The listing
   * finds the document gone, and the room reads storage and is closed. A room in use stays listed.
   */
  it('lists what storage lists for a room nobody uses', async () => {
    const shared = await sharedWebDAV({});
    const one = shared.server('one');
    const two = shared.server('two');
    const a = await one.rooms.createProject({ name: 'Listed', empty: true });
    const b = await one.rooms.createProject({ name: 'In use', empty: true });
    b.holders.add('mcp-session');
    await one.rooms.refreshActive(); // finds its writes: nothing left to read back
    expect(a.needsReadBack).toBe(false);
    expect((await one.rooms.listProjects()).map((p) => p.name).sort()).toEqual(['In use', 'Listed']);
    expect(await two.rooms.deleteProject(a.id)).toBe(true);
    expect(await two.rooms.deleteProject(b.id)).toBe(true);
    // in use, it is listed: a change made in it saves the project again
    expect((await one.rooms.listProjects()).map((p) => p.name)).toEqual(['In use']);
    expect(a.destroyed).toBe(true);
    expect(await one.rooms.open(a.id)).toBeNull();
  });

  /*
   * Storage does not list a project whose project.json cannot be read, but its document is there:
   * a loaded room of it stays listed, and the listing asks only whether the document exists.
   */
  it('lists a loaded project whose project.json is gone, without downloading its document', async () => {
    const shared = await sharedWebDAV({});
    const one = shared.server('one');
    const a = await one.rooms.createProject({ name: 'No project.json', empty: true });
    await one.rooms.refreshActive(); // finds its write: nothing left to read back
    const info = shared.docUrl(a.id).replace('document.ybin', 'project.json');
    await fetch(info, { method: 'DELETE', headers: { authorization: shared.dav.authorization } });
    const sent: string[] = [];
    shared.onRequest((req) => {
      if (req.headers['x-writer'] === 'one') sent.push(`${req.method} ${req.path.split('/').at(-1)}`);
    });
    expect((await one.rooms.listProjects()).map((p) => p.name)).toEqual(['No project.json']);
    expect(sent).not.toContain('GET document.ybin');
    expect(a.destroyed).toBe(false);
  });

  /*
   * Server one loaded the project (an agent read it), and nobody uses the room since; another
   * server deleted the project. Server one did not list it, but it opened it by id, and a change
   * made in it saved the project again. A room nobody uses now reads storage before it is opened
   * (unless it read it within the last 2 s), which also merges changes saved elsewhere since.
   */
  it('reads storage again before it opens a room nobody uses', async () => {
    const shared = await sharedWebDAV({});
    const one = shared.server('one');
    const two = shared.server('two');
    const a = await two.rooms.createProject({ name: 'Changed on two', empty: true });
    const b = await two.rooms.createProject({ name: 'Deleted on two', empty: true });
    const onOneA = (await one.rooms.open(a.id))!;
    const onOneB = (await one.rooms.open(b.id))!;
    // the rooms read storage just now: resolving and opening them reads nothing more
    const sent: string[] = [];
    shared.onRequest((req) => {
      if (req.headers['x-writer'] === 'one') sent.push(`${req.method} ${req.path}`);
    });
    expect(await one.rooms.exists(a.id)).toBe(true);
    expect(await one.rooms.open(a.id)).toBe(onOneA);
    expect(sent).toEqual([]);
    a.scene.addObject({ type: 'EMPTY', name: 'Saved on two' });
    await a.flush();
    expect(await two.rooms.deleteProject(b.id)).toBe(true);
    onOneA.readAt = 0; // as when their last read is older than 2 s
    onOneB.readAt = 0;
    expect(await one.rooms.open(a.id)).toBe(onOneA);
    expect(onOneA.scene.findObjectByName('Saved on two')).not.toBeNull();
    expect(sent.splice(0)).toContain(`GET /files/projects/${a.id}/document.ybin`);
    expect(await one.rooms.open(a.id)).toBe(onOneA);
    expect(sent).toEqual([]);
    expect(await one.rooms.exists(b.id)).toBe(false);
    expect(onOneB.destroyed).toBe(true);
    expect(await one.rooms.open(b.id)).toBeNull();
  });

  /*
   * Storage does not answer: opening a room nobody uses waits for its read of storage only for a
   * while (5 s by default, 50 ms here) and then hands out the room as it is; the read goes on, and
   * opening the room again meanwhile sends no other one.
   */
  it('opens a room nobody uses without waiting long for storage that does not answer', async () => {
    const fs = new HeldStore();
    const { rooms } = setup({ fs, openReadWaitMs: 50 });
    const a = await rooms.createProject({ name: 'Unanswered', empty: true });
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    a.readAt = 0;
    const reads = fs.documentReads;
    // (would wait for the release, which comes only afterwards)
    expect(await rooms.open(a.id)).toBe(a);
    expect(await rooms.exists(a.id)).toBe(true);
    release();
    await a.flush(); // after the reads
    expect(fs.documentReads - reads).toBe(1);
    expect(a.readAt).toBeGreaterThan(0);
  });

  /*
   * Storage does not answer: the check whether it holds a project deleted here within the hour
   * again (saved by another writer with unsaved changes) waits for it only for a while (5 s by
   * default, 50 ms here), and the project counts as still deleted. Opening it (MCP tools, REST, sync
   * connections) and listing projects used to wait for storage's own timeouts: 30 s for HEAD or
   * PROPFIND, then 30 s for a GET. The check goes on, and once storage answers, the project is found.
   */
  it('answers for a project deleted here without waiting long for storage that does not answer', async () => {
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 50 });
    const a = await rooms.createProject({ name: 'Deleted here', empty: true });
    expect(await rooms.deleteProject(a.id)).toBe(true);
    // another writer saves it again; then storage stops answering this server's requests for it
    const again = SceneDoc.create({ name: 'Saved again', empty: true });
    await store.fs.write(store.docPath(a.id), again.encodeState());
    await store.saveInfo({
      id: a.id,
      name: 'Saved again',
      created_at: '',
      updated_at: '',
      schema_version: 1,
    });
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    expect(await within(rooms.open(a.id, { create: true }))).toBeNull(); // a sync connection
    expect(await within(rooms.open(a.id))).toBeNull(); // MCP tools, REST
    expect(await within(rooms.exists(a.id))).toBe(false);
    expect(await within(rooms.listProjects())).toEqual([]); // storage lists it, but its document does not answer
    expect(fs.etagRequests).toBe(1); // one check at a time
    release();
    await until(() => !rooms.isDeleted(a.id));
    expect((await rooms.open(a.id))?.scene.name).toBe('Saved again');
    again.destroy();
  });

  /*
   * Storage does not answer: a request that asks about a project several times waits for it once.
   * An MCP tool asks whether a project exists, then opens it, or lists the projects for its 'not
   * found' answer; each question used to wait for the same unanswered read again (10 s instead of
   * 5 s). Once a request stopped waiting for a read, the others answer at once while it goes on.
   */
  it('waits once for storage that does not answer about a project deleted here', async () => {
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 600 });
    const a = await rooms.createProject({ name: 'Deleted here', empty: true });
    expect(await rooms.deleteProject(a.id)).toBe(true);
    const again = SceneDoc.create({ name: 'Saved again', empty: true });
    await store.fs.write(store.docPath(a.id), again.encodeState());
    await store.saveInfo({
      id: a.id,
      name: 'Saved again',
      created_at: '',
      updated_at: '',
      schema_version: 1,
    });
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    try {
      const t0 = Date.now();
      expect(await rooms.exists(a.id)).toBe(false);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(550); // waited for the check
      expect(await within(rooms.listProjects(), 200)).toEqual([]);
      expect(await within(rooms.open(a.id), 200)).toBeNull();
      expect(await within(rooms.open(a.id, { create: true }), 200)).toBeNull();
      expect(fs.etagRequests).toBe(1);
    } finally {
      release();
    }
    await until(() => !rooms.isDeleted(a.id));
    expect((await rooms.open(a.id))?.scene.name).toBe('Saved again');
    again.destroy();
  });

  it('waits once for storage that does not answer about a room nobody uses', async () => {
    const fs = new HeldStore();
    const { rooms } = setup({ fs, openReadWaitMs: 600 });
    const a = await rooms.createProject({ name: 'Unanswered', empty: true });
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    a.readAt = 0;
    const reads = fs.documentReads;
    try {
      const t0 = Date.now();
      expect(await rooms.exists(a.id)).toBe(true);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(550); // waited for the read
      expect(await within(rooms.open(a.id), 200)).toBe(a);
    } finally {
      release();
    }
    await a.flush(); // after the read
    expect(fs.documentReads - reads).toBe(1);
  });

  /*
   * A room in use when its project was deleted elsewhere stays open; once nobody uses it, the next
   * check for idle rooms closes it (before its idle time is up), and so does opening it or asking
   * whether the project exists.
   */
  it.each(['sweep', 'open', 'exists'] as const)(
    'closes a room found deleted once nobody uses it (%s)',
    async (how) => {
      const shared = await sharedWebDAV({});
      const one = shared.server('one');
      const two = shared.server('two');
      const a = await one.rooms.createProject({ name: 'Left', empty: true });
      a.holders.add('mcp-session');
      expect(await two.rooms.deleteProject(a.id)).toBe(true);
      await one.rooms.refreshActive();
      expect(a.deletedFromStorage).toBe(true);
      expect(a.destroyed).toBe(false);
      a.holders.delete('mcp-session');
      if (how === 'sweep') await one.rooms.sweep();
      else if (how === 'open') expect(await one.rooms.open(a.id)).toBeNull();
      else expect(await one.rooms.exists(a.id)).toBe(false);
      expect(a.destroyed).toBe(true);
      expect(one.rooms.get(a.id)).toBeUndefined();
    },
  );

  /*
   * Listing such a room does not close it (the next check for idle rooms does), but it no longer
   * lists it: it used to list the project until then, though storage had it deleted.
   */
  it('does not list a room found deleted once nobody uses it, before it is closed', async () => {
    const shared = await sharedWebDAV({});
    const one = shared.server('one');
    const two = shared.server('two');
    const a = await one.rooms.createProject({ name: 'Left', empty: true });
    a.holders.add('mcp-session');
    expect(await two.rooms.deleteProject(a.id)).toBe(true);
    await one.rooms.refreshActive();
    expect(a.deletedFromStorage).toBe(true);
    expect((await one.rooms.listProjects()).map((p) => p.name)).toEqual(['Left']);
    a.holders.delete('mcp-session');
    expect(await one.rooms.listProjects()).toEqual([]);
  });

  /*
   * A room with unsaved changes is kept, like a room in use, also when nobody uses it: closing it
   * lost them. It is listed, and its next save stores the project again with them.
   */
  it.each(['sweep', 'periodic refresh', 'open', 'exists', 'list'] as const)(
    'keeps a room with unsaved changes whose project was deleted elsewhere (%s)',
    async (how) => {
      const shared = await sharedWebDAV({});
      const one = shared.server('one');
      const two = shared.server('two');
      const a = await one.rooms.createProject({ name: 'Unsaved', empty: true });
      await a.refresh(); // finds its write: nothing left to read back
      expect(await two.rooms.deleteProject(a.id)).toBe(true);
      await a.refresh(); // finds the project deleted
      expect(a.deletedFromStorage).toBe(true);
      a.scene.addObject({ type: 'EMPTY', name: 'Unsaved change' }); // saved after 60 s (debounce)
      if (how === 'sweep') await one.rooms.sweep();
      else if (how === 'periodic refresh') await one.rooms.refreshActive();
      else if (how === 'open') expect(await one.rooms.open(a.id)).toBe(a);
      else if (how === 'exists') expect(await one.rooms.exists(a.id)).toBe(true);
      else expect((await one.rooms.listProjects()).map((p) => p.name)).toEqual(['Unsaved']);
      expect(a.destroyed).toBe(false);
      expect(a.isDirty).toBe(true);
      await a.flush();
      expect(await shared.stored(a.id)).toEqual(['Unsaved change']);
    },
  );

  /*
   * Storage holds a project's project.json and no document (a document deleted by hand, or nginx
   * creating the folder again for the project.json of a save that a deletion came between): the
   * room loaded for it did not find a document stored, so a read that finds none is no deletion.
   * It used to be closed as a project deleted elsewhere, and hidden for an hour. Its first change
   * writes the document.
   */
  it('keeps a loaded project that has a project.json and no document', async () => {
    const fs = new FlakyStore();
    const rec = recordingLog();
    const one = setup({ fs, log: rec.log });
    const two = setup({ fs });
    const a = await two.rooms.createProject({ name: 'Info only', empty: true });
    await fs.remove(two.store.docPath(a.id));
    const r = (await one.rooms.open(a.id))!;
    expect(r.documentStored).toBe(false);
    await r.refresh();
    expect(r.deletedFromStorage).toBe(false);
    r.readAt = 0; // as when its last read is older than 2 s: opening it reads storage again
    expect(await one.rooms.open(a.id)).toBe(r);
    expect(await one.rooms.exists(a.id)).toBe(true);
    expect((await one.rooms.listProjects()).map((p) => p.id)).toEqual([a.id]);
    r.scene.addObject({ type: 'EMPTY', name: 'First change' });
    await r.flush();
    expect(await one.store.loadDocument(a.id)).not.toBeNull();
    expect(rec.lines.filter((l) => l.includes('deleted from storage'))).toEqual([]);
  });

  /*
   * The room loaded for a project.json without a document has a document without a name: it was
   * listed (and MCP get_project answered) as 'Untitled', and its first save wrote 'Untitled' into
   * project.json in place of the stored name.
   */
  it('keeps the stored name of a project that has a project.json and no document', async () => {
    const fs = new FlakyStore();
    const one = setup({ fs });
    const two = setup({ fs });
    const a = await two.rooms.createProject({ name: 'Info only', empty: true });
    await fs.remove(two.store.docPath(a.id));
    const r = (await one.rooms.open(a.id))!;
    expect(r.scene.name).toBe('Info only'); // what editors and agents see
    expect(r.isDirty).toBe(false); // read from storage: nothing to save
    expect((await one.rooms.listProjects()).map((p) => p.name)).toEqual(['Info only']);
    expect((await one.rooms.describe(a.id))?.name).toBe('Info only');
    r.scene.addObject({ type: 'EMPTY', name: 'First change' });
    await r.flush();
    expect((await one.store.loadInfo(a.id))?.name).toBe('Info only');
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await one.store.loadDocument(a.id))!.update);
    expect(new SceneDoc(stored).name).toBe('Info only');
  });

  /* A stored document without a name (written by a client that never named it) keeps the stored record's name. */
  it("lists and saves a document without a name under project.json's name", () => {
    const unnamed = new SceneDoc(new Y.Doc());
    unnamed.addObject({ type: 'EMPTY', name: 'Something' });
    const prev = {
      id: 'p',
      name: 'Stored name',
      created_at: '2026-01-01',
      updated_at: '',
      schema_version: 1,
    };
    expect(projectInfoFromScene('p', unnamed, prev).name).toBe('Stored name');
    expect(projectInfoFromScene('p', unnamed, null).name).toBe('Untitled');
    unnamed.setName('Named');
    expect(projectInfoFromScene('p', unnamed, prev).name).toBe('Named');
    unnamed.destroy();
  });

  /*
   * A room a sync connection opened for an unknown project is not listed while it holds nothing,
   * also after it read storage and found no document. A project in use that another server deleted
   * is listed, like any project in use.
   */
  it('does not list a room opened for an unknown project, also after it read storage', async () => {
    const shared = await sharedWebDAV({});
    const one = shared.server('one');
    const two = shared.server('two');
    const blank = (await one.rooms.open(newUuid(), { create: true }))!;
    await blank.refresh();
    const kept = await one.rooms.createProject({ name: 'Empty, in use', empty: true });
    kept.holders.add('mcp-session');
    expect(await two.rooms.deleteProject(kept.id)).toBe(true);
    await one.rooms.refreshActive();
    expect(kept.deletedFromStorage).toBe(true);
    expect((await one.rooms.listProjects()).map((p) => p.name)).toEqual(['Empty, in use']);
  });

  /*
   * Storage cannot list the projects (an outage): the projects this server has loaded used to be
   * hidden, as a failed listing read as one without projects, and tools found no project by name.
   */
  it('lists the projects it has loaded while storage cannot list projects', async () => {
    const fs = new ListFailStore();
    const rec = recordingLog();
    const { rooms } = setup({ fs, log: rec.log });
    await rooms.createProject({ name: 'Loaded', empty: true });
    fs.failList = true;
    expect((await rooms.listProjects()).map((p) => p.name)).toEqual(['Loaded']);
    expect(rec.lines).toContain('warn listing projects failed');
  });

  /*
   * Another server deletes a new project right after its first write: the room had not found the
   * project stored before, but storage held its write, so the project was deleted after it.
   */
  it('knows that a new project was deleted right after its first write', async () => {
    const shared = await sharedWebDAV({});
    const rec = recordingLog();
    const one = shared.server('one', 60_000, rec.log);
    const two = shared.server('two');
    let wrote = false;
    shared.onRequest(async (req) => {
      if (req.headers['x-writer'] !== 'one' || !req.path.endsWith('/document.ybin')) return;
      if (req.method === 'PUT') wrote = true;
      else if (wrote && req.method === 'GET') {
        shared.onRequest(null);
        await two.rooms.deleteProject(req.path.split('/').at(-2)!);
      }
    });
    const a = await one.rooms.createProject({ name: 'Short-lived', empty: true });
    expect(await shared.stored(a.id)).toBeNull();
    expect(a.deletedFromStorage).toBe(true);
    expect(rec.lines).toContain(
      'info project deleted from storage elsewhere: not saved again unless it changes on this server',
    );
    expect(await one.rooms.open(a.id)).toBeNull();
  });

  /*
   * Server two deleted the project; a room of server one with unsaved changes saved it again. Server
   * two used to hide it for an hour (its tombstone): it neither listed nor opened a project that
   * storage held.
   */
  it('lists and opens a project another server saved again after this server deleted it', async () => {
    const shared = await sharedWebDAV({});
    const one = shared.server('one');
    const two = shared.server('two');
    const a = await one.rooms.createProject({ name: 'Saved again', empty: true });
    a.holders.add('mcp-session');
    expect(await two.rooms.deleteProject(a.id)).toBe(true);
    expect(await two.rooms.open(a.id)).toBeNull();
    a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
    await a.flush();
    expect(await shared.stored(a.id)).toEqual(['Made on one']);
    expect((await two.rooms.listProjects()).map((p) => p.name)).toEqual(['Saved again']);
    expect(await two.rooms.exists(a.id)).toBe(true);
    expect((await two.rooms.open(a.id))?.scene.findObjectByName('Made on one')).not.toBeNull();
  });

  /*
   * Server two deletes the project right after server one's write: one has no unsaved changes left,
   * so its read-back must not write the document again, nor its project.json (the write of
   * project.json into the deleted folder used to create the folder again, and every server listed
   * the project without a document).
   */
  it.each(['read-back', 'project.json'] as const)(
    "does not write again a project another server deletes right after this server's write (%s)",
    async (when) => {
      const shared = await sharedWebDAV({});
      const one = shared.server('one');
      const two = shared.server('two');
      const a = await one.rooms.createProject({ name: 'Doomed', empty: true });
      a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
      let wrote = false;
      shared.onRequest(async (req) => {
        if (req.headers['x-writer'] !== 'one') return;
        if (req.method === 'PUT' && req.path.endsWith('/document.ybin')) wrote = true;
        else if (
          wrote &&
          (when === 'read-back'
            ? req.method === 'GET' && req.path.endsWith('/document.ybin')
            : req.method === 'PUT' && req.path.endsWith('/project.json'))
        ) {
          shared.onRequest(null);
          await two.rooms.deleteProject(a.id);
        }
      });
      await a.flush();
      expect(await shared.stored(a.id)).toBeNull();
      expect((await shared.server('three').rooms.listProjects()).map((p) => p.id)).toEqual([]);
      expect(a.deletedFromStorage).toBe(true);
      expect(a.needsReadBack).toBe(false);
      expect(a.isDirty).toBe(false);
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
