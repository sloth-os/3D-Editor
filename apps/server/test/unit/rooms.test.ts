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
import { readBeforeAnswer } from '../../src/mcp/project-storage';
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

/**
 * MemoryFileStore whose removals (a project's deletion) and writes of documents can be held, and
 * whose removals can be made to fail (storage that refuses a deletion).
 */
class DeletionStore extends MemoryFileStore {
  holdRemove: Promise<void> | null = null;
  failRemove = false;
  removals = 0;
  holdWrite: Promise<void> | null = null;
  heldWrites = 0;
  override async remove(path: string) {
    this.removals++;
    if (this.holdRemove) await this.holdRemove;
    if (this.failRemove) throw new Error('storage refuses the deletion');
    return super.remove(path);
  }
  override async write(path: string, data: Uint8Array, opts?: WriteOptions) {
    if (this.holdWrite && path.endsWith('/document.ybin')) {
      this.heldWrites++;
      await this.holdWrite;
    }
    return super.write(path, data, opts);
  }
}

/** MemoryFileStore whose reads of project.json files can be held. */
class InfoHeldStore extends MemoryFileStore {
  holdInfo: Promise<void> | null = null;
  infoReads = 0;
  override async read(path: string) {
    if (path.endsWith('/project.json')) {
      this.infoReads++;
      if (this.holdInfo) await this.holdInfo;
    }
    return super.read(path);
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

/** MemoryFileStore whose reads can be made to fail (storage outage for GET). */
class ReadFailStore extends MemoryFileStore {
  failReads = false;
  reads = 0;
  override async read(path: string) {
    this.reads++;
    if (this.failReads) throw new Error('storage offline');
    return super.read(path);
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
   * Storage lists the projects but does not answer whether the document of a loaded project it
   * does not list is stored: listing waited for that check as long as storage took (30 s per
   * request), unlike the other checks of single projects.
   */
  it('lists a loaded project storage does not list without waiting long for storage that does not answer about it', async () => {
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 50 });
    const a = await rooms.createProject({ name: 'No project.json', empty: true });
    await fs.remove(store.infoPath(a.id));
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    try {
      const listed = await within(rooms.listProjects(), 1000);
      expect(listed === 'still waiting' ? listed : listed.map((p) => p.name)).toEqual(['No project.json']);
      expect(fs.etagRequests).toBe(1);
    } finally {
      release();
    }
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
   * Storage accepts connections and never answers: MCP get_project on a loaded room nobody uses
   * (an agent's one-shot session created it) asks whether the project exists, opens it, and checks
   * storage before it answers (readBeforeAnswer). Opening the room waited for its read of storage,
   * and then get_project waited for its own check as long again: 10 s instead of the 5 s it says.
   */
  it('waits once in get_project for storage that does not answer about a room nobody uses', async () => {
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 600 });
    const a = await rooms.createProject({ name: 'Unanswered', empty: true });
    const b = await rooms.createProject({ name: 'Unanswered too', empty: true });
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    a.readAt = 0;
    try {
      const t0 = Date.now();
      expect(await rooms.exists(a.id)).toBe(true);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(550); // waited for the room's read
      expect(await within(rooms.open(a.id), 200)).toBe(a);
      expect(await within(readBeforeAnswer(a, store), 1000)).toBeUndefined();
      expect(fs.etagRequests).toBe(0); // no check of its own while the read goes on
      // the other way round: a read of the room that a request stopped waiting for goes on (as
      // get_project's check does once it waited 5 s): opening the room waits for nothing
      b.readIsLate(fs.hold);
      b.readAt = 0;
      expect(await within(rooms.exists(b.id), 200)).toBe(true);
    } finally {
      release();
    }
    await a.flush(); // after the read
    expect(a.storageLate).toBe(false);
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
   * project.json in place of the stored name. The room's scene has the stored name; the document
   * gets no name item from the server (see the next test).
   */
  it('keeps the stored name of a project that has a project.json and no document', async () => {
    const fs = new FlakyStore();
    const one = setup({ fs });
    const two = setup({ fs });
    const a = await two.rooms.createProject({ name: 'Info only', empty: true });
    await fs.remove(two.store.docPath(a.id));
    const r = (await one.rooms.open(a.id))!;
    expect(r.scene.name).toBe('Info only'); // what editors and agents see
    expect(r.scene.toSnapshot().meta.name).toBe('Info only'); // REST snapshot
    expect(r.doc.getMap('meta').has('name')).toBe(false);
    expect(r.isDirty).toBe(false); // read from storage: nothing to save
    expect((await one.rooms.listProjects()).map((p) => p.name)).toEqual(['Info only']);
    expect((await one.rooms.describe(a.id))?.name).toBe('Info only');
    r.scene.addObject({ type: 'EMPTY', name: 'First change' });
    await r.flush();
    expect((await one.store.loadInfo(a.id))?.name).toBe('Info only');
    // the stored document has no name either; the name stays in project.json until one is given
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await one.store.loadDocument(a.id))!.update);
    expect(stored.getMap('meta').has('name')).toBe(false);
    // a rename names the document
    r.scene.setName('Named at last');
    await r.flush();
    expect(r.scene.name).toBe('Named at last');
    expect((await one.store.loadInfo(a.id))?.name).toBe('Named at last');
  });

  /*
   * The room of a project.json without a document wrote the stored name into its new document, as a
   * new item of the server's: a browser that had renamed the project in its copy of the full
   * document merged that copy with the room's, and the two concurrent writes of the name were
   * resolved by client id, so the browser's rename was lost in about half of the cases (here its
   * first name was written by client 1, which loses to any other client id).
   */
  it("keeps a browser's rename when it brings the full document to a room of a project.json without one", async () => {
    const fs = new FlakyStore();
    const one = setup({ fs });
    const two = setup({ fs });
    const a = await two.rooms.createProject({ name: 'Old name', empty: true });
    await fs.remove(two.store.docPath(a.id));
    const browser = new Y.Doc();
    browser.clientID = 1;
    const copy = new SceneDoc(browser);
    copy.setName('Old name');
    copy.addObject({ type: 'EMPTY', name: 'Made in the browser' });
    copy.setName('Renamed in the browser');
    const r = (await one.rooms.open(a.id, { create: true }))!;
    // the sync connection: the room and the browser exchange their states
    Y.applyUpdate(r.doc, Y.encodeStateAsUpdate(browser));
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(r.doc));
    expect(r.scene.name).toBe('Renamed in the browser');
    expect(copy.name).toBe('Renamed in the browser');
    await r.flush();
    expect((await one.store.loadInfo(a.id))?.name).toBe('Renamed in the browser');
    copy.destroy();
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

  /*
   * Storage refuses the deletion: the room used to be closed (its browsers told, with 4404, that
   * the project was deleted, and no longer connecting) before storage was asked, so the project
   * stayed in storage while every editor had lost it. The room now serves until storage deleted the
   * project, and goes on serving, and saving, when the deletion fails.
   */
  it('keeps serving and saving a project whose deletion storage refuses', async () => {
    const fs = new DeletionStore();
    const { rooms, store } = setup({ fs });
    const a = await rooms.createProject({ name: 'Kept', empty: true });
    fs.failRemove = true;
    let release!: () => void;
    fs.holdRemove = new Promise((resolve) => (release = resolve));
    const deleting = rooms.deleteProject(a.id);
    const refused = expect(deleting).rejects.toThrow(
      `could not delete project ${a.id} from storage (storage refuses the deletion); the project stays open on this server`,
    );
    await until(() => fs.removals === 1);
    expect(a.destroyed).toBe(false); // serves while storage deletes the project
    a.scene.addObject({ type: 'EMPTY', name: 'Made meanwhile' });
    release();
    await refused;
    expect(a.destroyed).toBe(false);
    expect(rooms.isDeleted(a.id)).toBe(false);
    expect(await rooms.open(a.id)).toBe(a);
    await a.flush();
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await store.loadDocument(a.id))!.update);
    expect(new SceneDoc(stored).findObjectByName('Made meanwhile')).not.toBeNull();
  });

  /*
   * Once storage deleted the project, its room writes nothing: a save asked for while storage
   * deleted it (a change, an agent's flush) used to be able to store the project again after the
   * deletion.
   */
  it('stores nothing again that a save asked for while storage deleted the project', async () => {
    const fs = new DeletionStore();
    const { rooms, store } = setup({ fs });
    const a = await rooms.createProject({ name: 'Doomed', empty: true });
    let release!: () => void;
    fs.holdRemove = new Promise((resolve) => (release = resolve));
    const deleting = rooms.deleteProject(a.id);
    await until(() => fs.removals === 1);
    expect(a.destroyed).toBe(false);
    a.scene.addObject({ type: 'EMPTY', name: 'Made meanwhile' });
    const saved = a.flush();
    release();
    expect(await deleting).toBe(true);
    await saved;
    await wait(50); // (the debounced save of the change, 10 ms here, would have run)
    expect(a.destroyed).toBe(true);
    expect(rooms.isDeleted(a.id)).toBe(true);
    expect(await store.loadDocument(a.id)).toBeNull();
    expect(await store.loadInfo(a.id)).toBeNull();
    expect((await fs.list(store.projectsDir())).map((e) => e.name)).not.toContain(a.id);
  });

  /* A save that is running when the deletion starts ends first: written after it, it would store the project again. */
  it('deletes a project after the save that is running', async () => {
    const fs = new DeletionStore();
    const { rooms, store } = setup({ fs });
    const a = await rooms.createProject({ name: 'Doomed', empty: true });
    let release!: () => void;
    fs.holdWrite = new Promise((resolve) => (release = resolve));
    a.scene.addObject({ type: 'EMPTY', name: 'Being saved' });
    const saving = a.flush();
    await until(() => fs.heldWrites === 1);
    const deleting = rooms.deleteProject(a.id);
    await wait(20);
    expect(fs.removals).toBe(0); // waits for the save
    release();
    await saving;
    expect(await deleting).toBe(true);
    expect(await store.loadDocument(a.id)).toBeNull();
    expect((await fs.list(store.projectsDir())).map((e) => e.name)).not.toContain(a.id);
  });

  /*
   * Storage does not answer the room's earlier reads and writes (each of their requests can take
   * 30 s, and a refresh sends up to three): the deletion waited behind them before it sent its
   * DELETE (175 s in a live run with storage that accepts connections and never answers, longer
   * than MCP clients wait). It now waits for them as long as other requests wait for storage, and
   * fails; the deletion it gave up does not run later.
   */
  it('gives up deleting a project whose earlier saves storage does not finish', async () => {
    const fs = new DeletionStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 100 });
    const a = await rooms.createProject({ name: 'Busy', empty: true });
    let release!: () => void;
    fs.holdWrite = new Promise((resolve) => (release = resolve));
    a.scene.addObject({ type: 'EMPTY', name: 'Being saved' });
    const saving = a.flush();
    await until(() => fs.heldWrites === 1);
    await expect(within(rooms.deleteProject(a.id), 2000)).rejects.toThrow(
      `could not delete project ${a.id} from storage (storage did not finish this project's earlier reads and writes within 0.1 s)`,
    );
    expect(a.destroyed).toBe(false);
    release();
    await saving;
    await a.flush();
    expect(fs.removals).toBe(0); // the deletion it gave up never ran
    expect(await store.loadDocument(a.id)).not.toBeNull();
    expect(await rooms.deleteProject(a.id)).toBe(true);
    expect(a.destroyed).toBe(true);
  });

  /*
   * A request that would load the project from storage while storage deletes it (a sync
   * connection, after the room was evicted) waits for the deletion: it used to load the project
   * from storage halfway through, and its room could store it again.
   */
  it('loads nothing while storage deletes a project that is not loaded', async () => {
    const fs = new DeletionStore();
    const { rooms } = setup({ fs });
    const a = await rooms.createProject({ name: 'Doomed', empty: true });
    a.lastActive = 0;
    await rooms.sweep(); // evicted
    expect(rooms.get(a.id)).toBeUndefined();
    let release!: () => void;
    fs.holdRemove = new Promise((resolve) => (release = resolve));
    const deleting = rooms.deleteProject(a.id);
    await until(() => fs.removals === 1);
    const opening = rooms.open(a.id, { create: true });
    expect(await within(opening, 50)).toBe('still waiting');
    release();
    expect(await deleting).toBe(true);
    expect(await opening).toBeNull();
  });

  /*
   * A request that would load the project while a deletion checks whether it exists (a sync
   * connection, during the deletion's read of project.json) waits for the deletion too: the
   * deletion used to let it load the project halfway through, and then deleted the project without
   * its room's saves, which could store it again.
   */
  it('loads nothing that is asked for while a deletion checks whether the project exists', async () => {
    const fs = new InfoHeldStore();
    const { rooms, store } = setup({ fs });
    const a = await rooms.createProject({ name: 'Doomed', empty: true });
    a.lastActive = 0;
    await rooms.sweep(); // evicted
    expect(rooms.get(a.id)).toBeUndefined();
    let release!: () => void;
    fs.holdInfo = new Promise((resolve) => (release = resolve));
    const reads = fs.infoReads;
    const deleting = rooms.deleteProject(a.id);
    await until(() => fs.infoReads > reads); // the deletion reads project.json
    fs.holdInfo = null;
    const opening = rooms.open(a.id, { create: true });
    expect(await within(opening, 50)).toBe('still waiting');
    release();
    expect(await deleting).toBe(true);
    expect(await opening).toBeNull();
    expect(rooms.get(a.id)).toBeUndefined();
    expect(await store.loadInfo(a.id)).toBeNull();
    expect(await store.loadDocument(a.id)).toBeNull();
  });

  /*
   * The same when the request asked before the deletion started, and was still checking whether
   * storage holds the project again (deleted here within the hour, then stored again by another
   * writer) when it began: it goes on only once the deletion has finished.
   */
  it('loads nothing that a request asked for before a deletion started and would load during it', async () => {
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs });
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
    const opening = rooms.open(a.id, { create: true }); // asks storage whether it holds it again
    await until(() => fs.etagRequests === 1);
    const deleting = rooms.deleteProject(a.id);
    release();
    expect(await deleting).toBe(true);
    expect(await opening).toBeNull();
    expect(rooms.get(a.id)).toBeUndefined();
    expect(await store.loadDocument(a.id)).toBeNull();
    again.destroy();
  });

  /*
   * Asking whether a project that is not loaded exists while storage deletes it waits for the
   * deletion: it used to read project.json halfway through, and answered that the project existed.
   */
  it('answers whether a project that is not loaded exists once its deletion has finished', async () => {
    const fs = new DeletionStore();
    const { rooms } = setup({ fs });
    const a = await rooms.createProject({ name: 'Doomed', empty: true });
    a.lastActive = 0;
    await rooms.sweep(); // evicted
    let release!: () => void;
    fs.holdRemove = new Promise((resolve) => (release = resolve));
    const deleting = rooms.deleteProject(a.id);
    await until(() => fs.removals === 1);
    const asked = rooms.exists(a.id);
    expect(await within(asked, 50)).toBe('still waiting');
    release();
    expect(await deleting).toBe(true);
    expect(await asked).toBe(false);
  });

  /*
   * Two deletions of a project at the same time (two agents, a REST call and an agent): the second
   * waits for the first and then finds the project deleted. Both used to ask storage to delete it,
   * and both answered that they deleted it.
   */
  it('runs one deletion of a project at a time', async () => {
    const fs = new DeletionStore();
    const { rooms } = setup({ fs });
    const a = await rooms.createProject({ name: 'Doomed', empty: true });
    let release!: () => void;
    fs.holdRemove = new Promise((resolve) => (release = resolve));
    const first = rooms.deleteProject(a.id);
    const second = rooms.deleteProject(a.id);
    await until(() => fs.removals === 1);
    expect(await within(second, 50)).toBe('still waiting');
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(fs.removals).toBe(1);
    expect(a.destroyed).toBe(true);
  });

  /*
   * Storage does not answer a load of the project that started before the deletion (a sync
   * connection opening it): the deletion waited for the load as long as storage took (30 s per
   * request on WebDAV). It now waits as long as for the project's other reads, and deletes nothing.
   */
  it('deletes nothing while a load of the project that storage does not answer goes on', async () => {
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 300 });
    const a = await rooms.createProject({ name: 'Loading', empty: true });
    a.lastActive = 0;
    await rooms.sweep(); // evicted
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    const reads = fs.documentReads;
    const opening = rooms.open(a.id, { create: true });
    await until(() => fs.documentReads > reads); // the load reads the document
    try {
      await expect(within(rooms.deleteProject(a.id), 1200)).rejects.toThrow(
        `could not delete project ${a.id} from storage (storage did not finish this project's earlier reads and writes within 0.3 s); nothing was deleted: delete it again`,
      );
    } finally {
      release();
    }
    const room = await opening;
    expect(room?.id).toBe(a.id);
    expect(room?.destroyed).toBe(false);
    expect(rooms.isDeleted(a.id)).toBe(false);
    expect(await store.loadDocument(a.id)).not.toBeNull();
  });

  /*
   * Storage accepts connections and never answers: MCP delete_project asks whether the project
   * exists (a loaded room nobody uses reads storage first, for 5 s at most), then deletes it, which
   * waited for that read as long again (10 s in a live run); REST DELETE, whose deletion reads
   * storage itself, too. The deletion now waits for none of the room's reads and writes while one
   * that a request stopped waiting for goes on, and deletes nothing. Its reason says so: it said
   * that storage did not finish them within the wait, also when the deletion had not waited.
   */
  it('waits once in a deletion for storage that does not answer about a room nobody uses', async () => {
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 500 });
    const a = await rooms.createProject({ name: 'Unanswered', empty: true });
    const b = await rooms.createProject({ name: 'Unanswered too', empty: true });
    let release!: () => void;
    fs.hold = new Promise((resolve) => (release = resolve));
    a.readAt = 0;
    b.readAt = 0;
    const notDeleted = (id: string) =>
      `could not delete project ${id} from storage (storage has not finished a read of this project that a request stopped waiting for after 0.5 s); nothing was deleted, and the project stays open on this server for its editors and agents: delete it again`;
    try {
      // as MCP delete_project: whether the project exists, then the deletion
      let t0 = Date.now();
      expect(await rooms.exists(a.id)).toBe(true);
      const waited = Date.now() - t0; // one wait for the room's read
      expect(waited).toBeGreaterThanOrEqual(450);
      await expect(within(rooms.deleteProject(a.id), 200)).rejects.toThrow(notDeleted(a.id));
      // as REST DELETE
      t0 = Date.now();
      await expect(rooms.deleteProject(b.id)).rejects.toThrow(notDeleted(b.id));
      expect(Date.now() - t0).toBeLessThan(waited + 250); // one wait, not two
    } finally {
      release();
    }
    await Promise.all([a.flush(), b.flush()]); // after the reads
    expect(a.destroyed || b.destroyed).toBe(false);
    expect(rooms.isDeleted(a.id) || rooms.isDeleted(b.id)).toBe(false);
    expect(await store.loadDocument(a.id)).not.toBeNull();
    expect(await store.loadDocument(b.id)).not.toBeNull();
    expect(await rooms.deleteProject(a.id)).toBe(true);
  });

  /*
   * The deletion waits for the project's earlier reads and writes of storage as long as other
   * requests wait for storage in all, not once per read or write: here the room's read of storage
   * (as REST DELETE opens a room nobody uses) ends in time, and a save of a change made meanwhile
   * ends after that wait, before a second wait would end. The deletion used to wait for the save as
   * long again, and then deleted the project. (No bound on the time: timers fire in the order they
   * are due, also on a busy machine, so the save ends after the deletion gave up.)
   */
  it('waits for the earlier reads and writes of storage once in all before it deletes a project', async () => {
    const waitMs = 600;
    const fs = new HeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: waitMs });
    const a = await rooms.createProject({ name: 'Busy', empty: true });
    let releaseRead!: () => void;
    let releaseSave!: () => void;
    const save = new Promise<void>((resolve) => (releaseSave = resolve));
    fs.hold = new Promise((resolve) => (releaseRead = resolve));
    a.readAt = 0;
    const reads = fs.documentReads;
    const t0 = Date.now();
    const deleting = rooms.deleteProject(a.id).then(
      (deleted) => ({ deleted, after: Date.now() - t0 }),
      (err: Error) => ({ error: err.message, after: Date.now() - t0 }),
    );
    try {
      await until(() => fs.documentReads > reads); // the room reads storage first
      a.scene.addObject({ type: 'EMPTY', name: 'Made meanwhile' }); // its save waits for the read
      await wait(0.8 * waitMs - (Date.now() - t0));
      fs.hold = save;
      releaseRead(); // the read ends in time; the save's read of storage goes on
      await wait(1.4 * waitMs - (Date.now() - t0));
      releaseSave();
      const result = await deleting;
      expect(result).toMatchObject({
        error: `could not delete project ${a.id} from storage (storage did not finish this project's earlier reads and writes within 0.6 s); nothing was deleted, and the project stays open on this server for its editors and agents: delete it again`,
      });
      expect(result.after).toBeGreaterThanOrEqual(waitMs - 50);
    } finally {
      releaseRead();
      releaseSave();
    }
    await a.flush();
    expect(a.destroyed).toBe(false);
    expect(await store.loadDocument(a.id)).not.toBeNull();
    expect(await rooms.deleteProject(a.id)).toBe(true);
  });

  /*
   * A deletion that started in time is not given up when storage takes longer than the rest of the
   * wait to delete the project: it reports the deletion, records it and closes the room (it is not
   * reported as one that deleted nothing while storage deletes the project).
   */
  it('reports a deletion whose request to storage outlasts the wait as done', async () => {
    const fs = new DeletionStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 100 });
    const a = await rooms.createProject({ name: 'Slow to delete', empty: true });
    let release!: () => void;
    fs.holdRemove = new Promise((resolve) => (release = resolve));
    const deleting = rooms.deleteProject(a.id);
    await until(() => fs.removals === 1); // started at once (the room's queue is idle)
    await wait(300); // past the wait
    release();
    expect(await deleting).toBe(true);
    expect(a.destroyed).toBe(true);
    expect(rooms.isDeleted(a.id)).toBe(true);
    expect(await store.loadDocument(a.id)).toBeNull();
  });

  /*
   * A read that a request stopped waiting for and that is not in the room's queue of reads and
   * writes (MCP get_project's check whether the document is stored) does not stop a deletion while
   * the queue is idle: the deletion waits for nothing then.
   */
  it('deletes a project while a late check outside the queue of its room goes on', async () => {
    const fs = new DeletionStore();
    const { rooms, store } = setup({ fs });
    const a = await rooms.createProject({ name: 'Checked', empty: true });
    let release!: () => void;
    a.readIsLate(new Promise<void>((resolve) => (release = resolve))); // as get_project's check is marked
    try {
      expect(a.storageLate).toBe(true);
      expect(await within(rooms.deleteProject(a.id), 2000)).toBe(true);
    } finally {
      release();
    }
    expect(a.destroyed).toBe(true);
    expect(await store.loadDocument(a.id)).toBeNull();
  });

  /*
   * Three deletions of a project asked for at once, the first refused by storage: loads of the
   * project also wait for the second one, which deletes it (the end of the first one must not let
   * them load the project while storage deletes it).
   */
  it('loads nothing while the deletion after a refused one deletes the project', async () => {
    const fs = new DeletionStore();
    const { rooms } = setup({ fs });
    const a = await rooms.createProject({ name: 'Thrice', empty: true });
    a.lastActive = 0;
    await rooms.sweep(); // evicted
    expect(rooms.get(a.id)).toBeUndefined();
    fs.failRemove = true;
    let releaseFirst!: () => void;
    fs.holdRemove = new Promise((resolve) => (releaseFirst = resolve));
    const outcome = (p: Promise<boolean>) =>
      p.then(
        (deleted) => deleted,
        (err: Error) => err.message,
      );
    const first = outcome(rooms.deleteProject(a.id));
    const second = outcome(rooms.deleteProject(a.id));
    const third = outcome(rooms.deleteProject(a.id));
    await until(() => fs.removals === 1);
    let releaseSecond!: () => void;
    fs.holdRemove = new Promise((resolve) => (releaseSecond = resolve));
    releaseFirst();
    expect(await first).toBe(
      `could not delete project ${a.id} from storage (storage refuses the deletion); storage may still hold all or part of it: delete it again`,
    );
    fs.failRemove = false;
    await until(() => fs.removals === 2); // the second deletion asks storage
    const opening = rooms.open(a.id, { create: true });
    expect(await within(opening, 50)).toBe('still waiting');
    releaseSecond();
    expect(await second).toBe(true);
    expect(await third).toBe(false);
    expect(await opening).toBeNull();
    expect(fs.removals).toBe(2);
  });

  /* A refused deletion of a project that is not loaded says nothing of a room that stays open. */
  it('says why it could not delete a project that is not loaded', async () => {
    const fs = new DeletionStore();
    const { rooms } = setup({ fs });
    const a = await rooms.createProject({ name: 'Stored', empty: true });
    a.lastActive = 0;
    await rooms.sweep(); // evicted
    expect(rooms.get(a.id)).toBeUndefined();
    fs.failRemove = true;
    expect(await rooms.deleteProject(a.id).catch((err: Error) => err.message)).toBe(
      `could not delete project ${a.id} from storage (storage refuses the deletion); storage may still hold all or part of it: delete it again`,
    );
    expect(rooms.isDeleted(a.id)).toBe(false);
    fs.failRemove = false;
    expect(await rooms.deleteProject(a.id)).toBe(true);
  });

  /*
   * Storage fails (on WebDAV also: gets no answer within 30 s) when a request asks about a project
   * that is not loaded: exists() answered that there was no such project once both of its reads had
   * failed, so MCP tools answered that the project was not found (after 90 s with storage that
   * accepts connections and does not answer: the two reads and a listing of the projects) and REST
   * DELETE 404. It now says that storage could not tell, after the first read.
   */
  it('says that storage cannot tell whether a project that is not loaded exists', async () => {
    const fs = new ReadFailStore();
    const { rooms, store } = setup({ fs });
    const a = await rooms.createProject({ name: 'Stored', empty: true });
    a.lastActive = 0;
    await rooms.sweep(); // evicted
    expect(rooms.get(a.id)).toBeUndefined();
    fs.failReads = true;
    fs.reads = 0;
    const error = `could not read project ${a.id} from storage (storage offline)`;
    await expect(rooms.exists(a.id)).rejects.toThrow(error);
    expect(fs.reads).toBe(1);
    await expect(rooms.deleteProject(a.id)).rejects.toThrow(error);
    fs.failReads = false;
    expect(rooms.isDeleted(a.id)).toBe(false);
    expect(await rooms.exists(a.id)).toBe(true);
    expect(await rooms.exists(newUuid())).toBe(false);
    // an unreadable project.json reads as none, as before
    await fs.write(store.infoPath(a.id), new TextEncoder().encode('{'));
    expect(await rooms.exists(a.id)).toBe(true);
    await fs.remove(store.docPath(a.id));
    expect(await rooms.exists(a.id)).toBe(false);
  });

  /*
   * MCP tools take a project's id or name and ask whether the reference is a project's id first
   * (AgentSession.resolveProjectId); a name such as 'Lighthouse' is a valid id too. While storage
   * failed, that question threw ('could not read project Lighthouse from storage'), and every tool
   * call that named a loaded project so failed, also for the agent working on it. The name now
   * finds the loaded project; a name no loaded project has still says that storage cannot tell.
   */
  it('leaves a name of a loaded project to find it while storage fails', async () => {
    const fs = new ReadFailStore();
    const { rooms, store } = setup({ fs });
    const a = await rooms.createProject({ name: 'Lighthouse', empty: true });
    const unsaved = await rooms.open('Unsaved', { create: true }); // listed once it has content
    fs.failReads = true;
    expect(await rooms.exists('Lighthouse')).toBe(false); // not an id: the name finds the project
    expect(await rooms.exists('lighthouse')).toBe(false); // ignoring letter case, as tools match names
    expect(await rooms.exists(a.id)).toBe(true);
    const cannotTell = (ref: string) => `could not read project ${ref} from storage (storage offline)`;
    await expect(rooms.exists('Harbour')).rejects.toThrow(cannotTell('Harbour'));
    // a room that is not listed (opened for an unknown project, nothing in it) names nothing
    await expect(rooms.exists('Untitled')).rejects.toThrow(cannotTell('Untitled'));
    unsaved!.scene.addObject({ type: 'EMPTY', name: 'Content' });
    expect(await rooms.exists('untitled')).toBe(false);
    // nor does a room nobody uses whose project another writer deleted (it is not listed)
    fs.failReads = false;
    const gone = await rooms.createProject({ name: 'Gone', empty: true });
    await store.deleteProject(gone.id);
    await gone.refresh();
    expect(gone.deletedFromStorage).toBe(true);
    fs.failReads = true;
    await expect(rooms.exists('Gone')).rejects.toThrow(cannotTell('Gone'));
    // storage that answers: the id comes first
    fs.failReads = false;
    expect(await rooms.exists('Lighthouse')).toBe(false);
    await store.saveInfo({
      id: 'Lighthouse',
      name: 'Stored',
      created_at: '',
      updated_at: '',
      schema_version: 1,
    });
    expect(await rooms.exists('Lighthouse')).toBe(true);
  });

  /*
   * The same with storage that does not answer: the question waited for storage (30 s per request
   * on WebDAV) and then failed, for a project loaded here. It now waits as other requests wait for
   * storage (openReadWaitMs, 5 s), once while the read goes on, and leaves the name to find the
   * project; the read's answer counts for the requests after it.
   */
  it('leaves a name of a loaded project to find it without waiting long for storage that does not answer', async () => {
    const fs = new InfoHeldStore();
    const { rooms, store } = setup({ fs, openReadWaitMs: 300 });
    const lighthouse = await rooms.createProject({ name: 'Lighthouse', empty: true });
    await store.saveInfo({
      id: 'Lighthouse',
      name: 'Stored',
      created_at: '',
      updated_at: '',
      schema_version: 1,
    });
    let release!: () => void;
    fs.holdInfo = new Promise((resolve) => (release = resolve));
    const reads = fs.infoReads;
    const harbour = rooms.exists('Harbour'); // a name no loaded project has: it waits for storage
    try {
      expect(await within(rooms.exists('Lighthouse'), 3000)).toBe(false); // after 300 ms
      // requests for the project the name finds wait for that read no more (get_project's check)
      expect(lighthouse.storageLate).toBe(true);
      expect(await within(rooms.exists('Lighthouse'), 150)).toBe(false); // at once: the read goes on
      expect(await within(rooms.exists('lighthouse'), 150)).toBe(false); // the same project: at once
      expect(fs.infoReads).toBe(reads + 2); // 'Harbour' and 'Lighthouse'
      expect(await within(harbour, 50)).toBe('still waiting');
    } finally {
      release();
    }
    expect(await harbour).toBe(false);
    await until(() => !lighthouse.storageLate);
    expect(await rooms.exists('Lighthouse')).toBe(true); // storage answered: the id comes first
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
