import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ProjectFileStore, SceneDoc, WebDAVClient } from '@3d-editor/core';
import { WebDAVSync, resolveWebDAV } from '../src/storage/webdav';
import { prefs, defaultPreferences } from '../src/app/prefs';
import { serverConfig } from '../src/app/store';
import { localIndex } from '../src/project/local-index';

describe('storage selection', () => {
  it('uses the browser only when nothing is configured', () => {
    prefs.value = defaultPreferences();
    serverConfig.value = null;
    expect(resolveWebDAV()).toBeNull();
  });

  it('prefers the server WebDAV proxy in auto mode', () => {
    prefs.value = defaultPreferences();
    serverConfig.value = {
      version: '1',
      features: { sync: true, mcp: true, telemetry: true, webdavProxy: true },
      webdav: { url: '/dav', basePath: '/3d-editor' },
      persistence: 'webdav',
    };
    const t = resolveWebDAV()!;
    expect(t.viaServer).toBe(true);
    expect(t.store.basePath).toBe('/3d-editor');
  });

  it('uses a custom WebDAV server when configured, and nothing in browser mode', () => {
    const p = defaultPreferences();
    p.storage.mode = 'webdav';
    p.storage.webdav = {
      url: 'https://dav.example.com/files/me',
      username: 'u',
      password: 'p',
      basePath: '/proj',
    };
    prefs.value = p;
    serverConfig.value = null;
    const t = resolveWebDAV()!;
    expect(t.viaServer).toBe(false);
    expect(t.label).toContain('dav.example.com');
    prefs.value = { ...p, storage: { ...p.storage, mode: 'browser' } };
    expect(resolveWebDAV()).toBeNull();
  });
});

describe('local project index (IndexedDB)', () => {
  it('stores, lists and removes entries', async () => {
    await localIndex.put({
      id: 'a',
      name: 'A',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      schema_version: 1,
    });
    await localIndex.put({
      id: 'b',
      name: 'B',
      created_at: '2026-01-01',
      updated_at: '2026-01-03',
      schema_version: 1,
    });
    const list = await localIndex.list();
    expect(list.map((p) => p.id)).toEqual(['b', 'a']);
    await localIndex.patch('a', { name: 'A2' });
    expect((await localIndex.get('a'))?.name).toBe('A2');
    await localIndex.remove('a');
    expect((await localIndex.list()).map((p) => p.id)).toEqual(['b']);
  });
});

/**
 * A WebDAV server like the webdav-server the tests use: no ETag with GET or PUT, and an ETag in
 * PROPFIND made from the modification time, which two writes within one tick of its clock share.
 */
function coarseEtagServer() {
  const files = new Map<string, { data: Uint8Array; etag: string }>();
  const server = {
    files,
    /** The server's clock: ETags only change when it moves. */
    clock: 1,
    put(path: string, data: Uint8Array) {
      files.set(path, { data: data.slice(), etag: `"t${server.clock}"` });
    },
    fetch: async (input: string, init: RequestInit = {}) => {
      const path = decodeURIComponent(new URL(input).pathname).replace(/(.)\/$/, '$1');
      const file = files.get(path);
      switch (init.method ?? 'GET') {
        case 'GET':
          return file
            ? new Response(file.data.slice(), { status: 200 })
            : new Response(null, { status: 404 });
        case 'PUT':
          server.put(path, init.body as Uint8Array);
          return new Response(null, { status: 201 });
        case 'PROPFIND':
          if (!file) return new Response(null, { status: path.endsWith('.ybin') ? 404 : 207 });
          return new Response(
            `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${path}</d:href><d:propstat><d:prop>` +
              `<d:getetag>${file.etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status>` +
              `</d:propstat></d:response></d:multistatus>`,
            { status: 207 },
          );
        default:
          return new Response(null, { status: 201 });
      }
    },
  };
  return server;
}

describe('WebDAV sync of an open project', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("merges another device's save that has the ETag of the last sync", async () => {
    // regression: a sync skipped the stored document when its ETag equalled the last sync's,
    // and this device missed a save made within the same tick of the server's clock
    const server = coarseEtagServer();
    vi.stubGlobal('fetch', server.fetch);
    const path = '/projects/p-dav/document.ybin';
    const other = SceneDoc.create({ name: 'Shared', empty: true });
    server.put(path, other.encodeState());
    const doc = new SceneDoc(new Y.Doc());
    const target = {
      store: new ProjectFileStore(new WebDAVClient({ url: 'https://dav.test/' }), '/'),
      label: 'test',
      viaServer: false,
    };
    const origin = { type: 'storage' };
    const sync = new WebDAVSync(
      target,
      'p-dav',
      doc,
      () => ({ id: 'p-dav', name: 'Shared', created_at: '', updated_at: '', schema_version: 1 }),
      origin,
    );
    expect(await sync.syncNow()).toMatchObject({ pulled: true, pushed: false });
    expect(doc.name).toBe('Shared');
    // the other device saves again before the server's clock moved: same ETag, new content
    other.addObject({ type: 'EMPTY', name: 'Saved elsewhere' });
    server.put(path, other.encodeState());
    expect(await sync.syncNow()).toMatchObject({ pulled: true });
    expect(doc.findObjectByName('Saved elsewhere')).not.toBeNull();
    await sync.stop(false);
    other.destroy();
  });
});
