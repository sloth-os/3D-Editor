import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryFileStore,
  ProjectFileStore,
  SceneDoc,
  newUuid,
  type FileStore,
  type WriteOptions,
} from '@3d-editor/core';
import { RoomManager } from '../../src/sync/room-manager';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog } from '../../src/observability/log';
import { decodeAwarenessEntries, encodeAwarenessEntries } from '../../src/sync/awareness';
import type { Persistence } from '../../src/persistence';

/** MemoryFileStore whose writes can be made to fail (storage outage). */
class FlakyStore extends MemoryFileStore {
  failWrites = false;
  override async write(path: string, data: Uint8Array, opts?: WriteOptions) {
    if (this.failWrites) throw new Error('storage offline');
    return super.write(path, data, opts);
  }
}

/**
 * A store that pairs content and ETag the way the WebDAV client does with servers that send no ETag
 * with GET or PUT (packages/core webdav.ts read() and write(), e.g. the webdav-server of the
 * integration tests): it reads or writes the content, then asks for the ETag with a second request
 * (PROPFIND), which another server's write can come before. `betweenRead` / `betweenWrite` run once
 * between the two requests of the next read / write of a project's document.
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

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

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
