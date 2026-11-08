import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProjectFileStore, SceneDoc, WebDAVClient, newUuid } from '@3d-editor/core';
import { DiskFileStore } from '../../src/persistence/disk';
import { api, eventually, makeTempDir, sleep, startServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';
import { mkcolPath, startWebDAV, type TestWebDAV } from '../helpers/webdav';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!().catch(() => undefined);
});

describe('disk persistence', () => {
  it('survives an app restart', async () => {
    const dataDir = await makeTempDir();
    let server = await startServer({ SYNC_PERSISTENCE: 'disk', DATA_DIR: dataDir });
    cleanup.push(() => server.cleanup());
    const created = await api(server.url, '/api/projects', { method: 'POST', json: { name: 'Persistent' } });
    const id = created.body.id as string;
    const docPath = path.join(dataDir, 'projects', id, 'document.ybin');
    expect(existsSync(docPath)).toBe(true);
    const info = JSON.parse(await readFile(path.join(dataDir, 'projects', id, 'project.json'), 'utf8'));
    expect(info).toMatchObject({ id, name: 'Persistent', stats: { objects: 3, vertices: 8, faces: 6 } });

    // edit through a sync client; the change is persisted after the debounce
    const c = new SyncTestClient({ baseUrl: server.url, projectId: id });
    await c.connect();
    c.scene.addObject({ type: 'EMPTY', name: 'Added live' });
    // a project created offline by a browser and uploaded on connect
    const offlineId = newUuid();
    const local = SceneDoc.create({ name: 'Made offline' });
    const d = new SyncTestClient({ baseUrl: server.url, projectId: offlineId, doc: local.ydoc });
    await d.connect();
    await eventually(
      async () => {
        const stored = await new ProjectFileStore(new DiskFileStore(dataDir)).loadInfo(offlineId);
        return stored?.name === 'Made offline';
      },
      5000,
      'offline project persisted',
    );
    await c.destroy();
    await d.destroy();
    await server.close();

    server = await startServer({ SYNC_PERSISTENCE: 'disk', DATA_DIR: dataDir });
    cleanup.push(() => server.close());
    const list = await api(server.url, '/api/projects');
    const names = list.body.projects.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(['Made offline', 'Persistent']);
    const snap = await api(server.url, `/api/projects/${id}/snapshot`);
    expect(snap.status).toBe(200);
    expect(snap.body.objects.map((o: { name: string }) => o.name)).toContain('Added live');
    const again = new SyncTestClient({ baseUrl: server.url, projectId: id });
    cleanup.push(() => again.destroy());
    await again.connect();
    expect(again.scene.findObjectByName('Added live')).not.toBeNull();
  });

  it('persists idle rooms before evicting them', async () => {
    const server = await startServer(
      { SYNC_PERSISTENCE: 'disk', ROOM_IDLE_TTL_SECONDS: '0.3', PERSIST_DEBOUNCE_MS: '5000' },
      { sweepIntervalMs: 100 },
    );
    cleanup.push(() => server.cleanup());
    cleanup.push(() => server.close());
    const id = newUuid();
    const c = new SyncTestClient({ baseUrl: server.url, projectId: id });
    await c.connect();
    c.scene.setName('Evict me');
    c.scene.addObject({ type: 'EMPTY', name: 'Unsaved' });
    await sleep(50);
    expect(server.handle.rooms.get(id)?.isDirty).toBe(true);
    await c.destroy();
    await eventually(() => !server.handle.rooms.get(id), 5000, 'eviction');
    const stored = await new ProjectFileStore(new DiskFileStore(server.dataDir)).loadDocument(id);
    expect(stored).not.toBeNull();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored!.update);
    expect(new SceneDoc(doc).findObjectByName('Unsaved')).not.toBeNull();
    // reloads lazily
    const snap = await api(server.url, `/api/projects/${id}`);
    expect(snap.body).toMatchObject({ id, name: 'Evict me', live: true });
  });

  it('keeps memory-mode documents until the TTL and deletes projects', async () => {
    const server = await startServer({ SYNC_PERSISTENCE: 'memory' });
    cleanup.push(() => server.cleanup());
    cleanup.push(() => server.close());
    const created = await api(server.url, '/api/projects', {
      method: 'POST',
      json: { name: 'Ephemeral', empty: true },
    });
    const id = created.body.id;
    expect((await api(server.url, `/api/projects/${id}`)).body).toMatchObject({
      name: 'Ephemeral',
      stats: { objects: 0 },
    });
    const c = new SyncTestClient({ baseUrl: server.url, projectId: id });
    await c.connect();
    const del = await api(server.url, `/api/projects/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    await eventually(() => c.closeCode === 4404, 10_000, 'socket closed with 4404');
    expect((await api(server.url, `/api/projects/${id}`)).status).toBe(404);
    expect((await api(server.url, `/api/projects/${id}`, { method: 'DELETE' })).status).toBe(404);
    // a reconnecting client cannot resurrect a deleted project
    await expect(c.connect()).rejects.toThrow(/410/);
  });
});

describe('WebDAV persistence', () => {
  /** Like webdav-server itself: no ETag with GET or PUT, If-Match ignored. */
  let dav: TestWebDAV;
  /** Like Nextcloud: ETags with GET and PUT, If-Match and If-None-Match checked. */
  let checking: TestWebDAV;
  beforeAll(async () => {
    dav = await startWebDAV();
    await mkcolPath(dav, '/files/alice');
    checking = await startWebDAV({ etagHeaders: true, conditional: true });
    await mkcolPath(checking, '/files/alice');
  });
  afterAll(async () => {
    await dav.stop();
    await checking.stop();
  });

  it('stores projects at <base>/projects/<id>/document.ybin on the WebDAV server', async () => {
    const env = {
      WEBDAV_URL: `${dav.origin}/files/alice`,
      WEBDAV_USERNAME: dav.username,
      WEBDAV_PASSWORD: dav.password,
      WEBDAV_BASE_PATH: '/3d-editor',
    };
    let server = await startServer(env);
    cleanup.push(() => server.cleanup());
    expect(server.handle.persistence.mode).toBe('webdav');
    const ready = await api(server.url, '/readyz');
    expect(ready.status).toBe(200);
    const created = await api(server.url, '/api/projects', { method: 'POST', json: { name: 'On WebDAV' } });
    const id = created.body.id as string;

    const raw = await fetch(`${dav.origin}/files/alice/3d-editor/projects/${id}/document.ybin`, {
      headers: { authorization: dav.authorization },
    });
    expect(raw.status).toBe(200);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await raw.arrayBuffer()));
    expect(new SceneDoc(doc).name).toBe('On WebDAV');
    const info = await fetch(`${dav.origin}/files/alice/3d-editor/projects/${id}/project.json`, {
      headers: { authorization: dav.authorization },
    });
    expect(await info.json()).toMatchObject({ id, name: 'On WebDAV' });

    // a browser saving directly to WebDAV (same layout, CRDT merge) and the server interoperate
    const browserStore = new ProjectFileStore(
      new WebDAVClient({ url: `${dav.origin}/files/alice`, username: dav.username, password: dav.password }),
      '/3d-editor',
    );
    const browserDoc = new Y.Doc();
    Y.applyUpdate(browserDoc, (await browserStore.loadDocument(id))!.update);
    new SceneDoc(browserDoc).addObject({ type: 'EMPTY', name: 'From browser storage' });
    await browserStore.syncDocument(id, browserDoc);

    const c = new SyncTestClient({ baseUrl: server.url, projectId: id });
    await c.connect();
    c.scene.addObject({ type: 'EMPTY', name: 'From sync' });
    await c.destroy();
    await server.close();

    server = await startServer(env);
    cleanup.push(() => server.close());
    const snap = await api(server.url, `/api/projects/${id}/snapshot`);
    const names = snap.body.objects.map((o: { name: string }) => o.name);
    expect(names).toContain('From sync');
    expect(names).toContain('From browser storage');
    const list = await api(server.url, '/api/projects');
    expect(list.body.projects.map((p: { id: string }) => p.id)).toContain(id);
  });

  it.each(['ignores If-Match', 'checks If-Match'] as const)(
    'keeps two servers sharing one WebDAV storage in sync (CRDT merge + refresh), server %s',
    async (kind) => {
      const shared = kind === 'checks If-Match' ? checking : dav;
      const env = {
        WEBDAV_URL: `${shared.origin}/files/alice`,
        WEBDAV_USERNAME: shared.username,
        WEBDAV_PASSWORD: shared.password,
        WEBDAV_BASE_PATH: '/shared',
        PERSIST_DEBOUNCE_MS: '20',
      };
      const one = await startServer(env, { refreshIntervalMs: 100 });
      const two = await startServer(env, { refreshIntervalMs: 100 });
      cleanup.push(
        () => one.cleanup(),
        () => two.cleanup(),
        () => one.close(),
        () => two.close(),
      );
      const created = await api(one.url, '/api/projects', { method: 'POST', json: { name: 'Two servers' } });
      const id = created.body.id as string;
      const a = new SyncTestClient({ baseUrl: one.url, projectId: id, name: 'On server one' });
      const b = new SyncTestClient({ baseUrl: two.url, projectId: id, name: 'On server two' });
      cleanup.push(
        () => a.destroy(),
        () => b.destroy(),
      );
      await a.connect();
      await b.connect();
      expect(b.scene.name).toBe('Two servers');
      a.scene.addObject({ type: 'EMPTY', name: 'Made on one' });
      b.scene.addObject({ type: 'EMPTY', name: 'Made on two' });
      await eventually(
        () => a.scene.findObjectByName('Made on two') && b.scene.findObjectByName('Made on one'),
        10_000,
        'cross-server convergence',
      );
    },
  );

  it('reports unreachable storage on /readyz', async () => {
    const server = await startServer({
      WEBDAV_URL: 'http://127.0.0.1:9/nothing',
      WEBDAV_USERNAME: 'x',
      WEBDAV_PASSWORD: 'y',
    });
    cleanup.push(() => server.cleanup());
    cleanup.push(() => server.close());
    const ready = await api(server.url, '/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body.persistence).toMatchObject({ mode: 'webdav', ok: false });
    expect((await api(server.url, '/healthz')).status).toBe(200);
  });
});
