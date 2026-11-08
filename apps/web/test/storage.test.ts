import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ProjectFileStore, SceneDoc, WebDAVClient } from '@3d-editor/core';
import { WebDAVSync, resolveWebDAV, syncRecords } from '../src/storage/webdav';
import { prefs, defaultPreferences } from '../src/app/prefs';
import { serverConfig, session, toasts } from '../src/app/store';
import { localIndex } from '../src/project/local-index';
import { deleteProject } from '../src/project/manager';
import { ProjectSession } from '../src/project/session';

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

/** An in-memory WebDAV server (ETags with GET and PUT) whose files another device can delete. */
function memoryServer() {
  const files = new Map<string, Uint8Array>();
  let version = 0;
  const etags = new Map<string, string>();
  /** Every request, as "METHOD path". */
  const requests: string[] = [];
  return {
    files,
    requests,
    /** Another device deletes a project's folder. */
    remove(prefix: string) {
      for (const p of [...files.keys()]) if (p.startsWith(prefix)) files.delete(p);
    },
    fetch: async (input: string, init: RequestInit = {}) => {
      const path = decodeURIComponent(new URL(input).pathname).replace(/(.)\/$/, '$1');
      const file = files.get(path);
      requests.push(`${init.method ?? 'GET'} ${path}`);
      switch (init.method ?? 'GET') {
        case 'GET':
        case 'HEAD':
          return file
            ? new Response(init.method === 'HEAD' ? null : file.slice(), {
                headers: { ETag: etags.get(path)! },
              })
            : new Response(null, { status: 404 });
        case 'PUT': {
          files.set(path, new Uint8Array(init.body as Uint8Array));
          etags.set(path, `"${++version}"`);
          return new Response(null, { status: 201, headers: { ETag: etags.get(path)! } });
        }
        case 'PROPFIND':
          return new Response(null, { status: 404 });
        case 'DELETE':
          for (const p of [...files.keys()]) if (p.startsWith(`${path}/`)) files.delete(p);
          return new Response(null, { status: 204 });
        default:
          return new Response(null, { status: 201 });
      }
    },
  };
}

/*
 * Another device deletes a project this browser has open. Like the editor server's rooms, the
 * browser stores it again only when its copy holds changes made since its last sync with the store
 * (it used to store it again at its next sync, every 20 s, also without any change), and says so.
 */
describe('WebDAV sync of a project another device deleted', () => {
  const ID = 'p-deleted';
  const DOC = `/projects/${ID}/document.ybin`;

  function open(server: ReturnType<typeof memoryServer>, doc: SceneDoc) {
    const target = {
      store: new ProjectFileStore(new WebDAVClient({ url: 'https://dav.test/' }), '/'),
      label: 'test',
      viaServer: false,
    };
    return new WebDAVSync(
      target,
      ID,
      doc,
      () => ({ id: ID, name: doc.name, created_at: '', updated_at: '', schema_version: 1 }),
      { type: 'storage' },
    );
  }

  /** A project this browser stored, which another device then deletes. */
  async function deletedAfterSync() {
    localStorage.clear();
    toasts.value = [];
    const server = memoryServer();
    vi.stubGlobal('fetch', server.fetch);
    const doc = SceneDoc.create({ name: 'Doomed', empty: true });
    const sync = open(server, doc);
    expect(await sync.syncNow()).toMatchObject({ pushed: true, created: true });
    expect(toasts.value).toEqual([]);
    server.remove(`/projects/${ID}/`);
    return { server, doc, sync };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('does not store it again without changes, and says it was deleted', async () => {
    const { server, doc, sync } = await deletedAfterSync();
    expect(await sync.syncNow()).toMatchObject({ pushed: false, missing: true });
    expect(server.files.size).toBe(0);
    expect(sync.status.value).toBe('deleted');
    expect(toasts.value.map((t) => t.message)).toEqual([
      '"Doomed" was deleted from WebDAV on another device. This browser keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).',
    ]);
    // the next syncs (every 20 s) neither store it nor say it again
    await sync.syncNow();
    expect(server.files.size).toBe(0);
    expect(toasts.value).toHaveLength(1);
    // a new session of this browser knows what it synced
    await sync.stop(false);
    const again = open(server, doc);
    expect(await again.syncNow()).toMatchObject({ missing: true });
    expect(server.files.size).toBe(0);
    await again.stop(false);
    doc.destroy();
  });

  it('stores it again with changes made since its last sync, and says so', async () => {
    const { server, doc, sync } = await deletedAfterSync();
    doc.addObject({ type: 'EMPTY', name: 'Made after the sync' });
    expect(await sync.syncNow()).toMatchObject({ pushed: true, created: true });
    expect(server.files.has(DOC)).toBe(true);
    expect(server.files.has(`/projects/${ID}/project.json`)).toBe(true);
    expect(sync.status.value).toBe('synced');
    expect(toasts.value.map((t) => t.message)).toEqual([
      '"Doomed" was deleted from WebDAV on another device; this browser stored it there again.',
    ]);
    await sync.stop(false);
    doc.destroy();
  });

  it('stores it again on Save (Ctrl+S)', async () => {
    const { server, doc, sync } = await deletedAfterSync();
    await sync.syncNow();
    expect(server.files.size).toBe(0);
    expect(await sync.syncNow({ save: true })).toMatchObject({ pushed: true, created: true });
    expect(server.files.has(DOC)).toBe(true);
    expect(sync.status.value).toBe('synced');
    expect(toasts.value.map((t) => t.message).at(-1)).toBe(
      '"Doomed" was deleted from WebDAV on another device; this browser stored it there again.',
    );
    await sync.stop(false);
    doc.destroy();
  });

  /*
   * Deleting the open project closed it with a last sync, which wrote its unsaved changes and could
   * land after the deletion: the project came back.
   */
  it('deletes the open project without syncing it a last time', async () => {
    localStorage.clear();
    const server = memoryServer();
    vi.stubGlobal('fetch', server.fetch);
    useWebDAVDirectly();
    const s = await ProjectSession.open(ID, {
      initial: SceneDoc.create({ name: 'Deleted here', empty: true }),
    });
    session.value = s;
    await s.webdav!.syncNow();
    expect(server.files.has(DOC)).toBe(true);
    s.doc.addObject({ type: 'EMPTY', name: 'Unsaved' });
    const from = server.requests.length;
    await deleteProject({ ...s.projectInfo(), sources: ['local', 'webdav'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.requests.slice(from)).toEqual([`DELETE /projects/${ID}`]);
    expect(server.files.size).toBe(0);
    // what this browser synced stays known, and that it deleted the project (for its other tabs)
    const target = resolveWebDAV()!;
    expect(syncRecords.synced(target, ID)).not.toBeNull();
    expect(syncRecords.deleted(target, ID)).toBe(true);
  });

  it('uploads a project it never synced with the store', async () => {
    localStorage.clear();
    const server = memoryServer();
    vi.stubGlobal('fetch', server.fetch);
    const doc = SceneDoc.create({ name: 'Made offline', empty: true });
    const sync = open(server, doc);
    expect(syncRecords.synced(sync.target, ID)).toBeNull();
    expect(await sync.syncNow()).toMatchObject({ pushed: true, created: true });
    expect(server.files.has(DOC)).toBe(true);
    expect(syncRecords.synced(sync.target, ID)).not.toBeNull();
    await sync.stop(false);
    doc.destroy();
  });

  it('shows nothing for a project that has no content and no stored document yet', async () => {
    localStorage.clear();
    toasts.value = [];
    const server = memoryServer();
    vi.stubGlobal('fetch', server.fetch);
    // opened from a share link before the project arrived: nothing to upload, nothing deleted
    const doc = new SceneDoc(new Y.Doc());
    const sync = open(server, doc);
    expect(await sync.syncNow()).toMatchObject({ pushed: false, missing: true });
    expect(sync.status.value).toBe('idle');
    expect(toasts.value).toEqual([]);
    expect(server.files.size).toBe(0);
    await sync.stop(false);
  });

  /* Save (Ctrl+S) is ProjectSession.flush: it stores a project the store lost, without changes. */
  it('stores it again when the open project is saved', async () => {
    localStorage.clear();
    const server = memoryServer();
    vi.stubGlobal('fetch', server.fetch);
    useWebDAVDirectly();
    const s = await ProjectSession.open(ID, { initial: SceneDoc.create({ name: 'Saved', empty: true }) });
    await s.webdav!.syncNow();
    server.remove(`/projects/${ID}/`);
    await s.webdav!.syncNow();
    expect(s.webdav!.status.value).toBe('deleted');
    await s.flush();
    expect(server.files.has(DOC)).toBe(true);
    expect(s.webdav!.status.value).toBe('synced');
    await s.close(false);
  });
});

/** The browser saves to a WebDAV server of its own (https://dav.test/, base path /). */
function useWebDAVDirectly(): void {
  serverConfig.value = null;
  const d = defaultPreferences();
  prefs.value = {
    ...d,
    storage: { mode: 'webdav', webdav: { ...d.storage.webdav, url: 'https://dav.test/', basePath: '/' } },
  };
}

/**
 * An in-memory WebDAV server like Nextcloud: ETags with GET, HEAD and PUT, If-Match and
 * If-None-Match checked, and HTTP 409 for a write into a folder that does not exist. `once` runs
 * code (another device, another tab) right before or after a request.
 */
function davServer() {
  const files = new Map<string, { data: Uint8Array; etag: string }>();
  const dirs = new Set<string>(['/']);
  let version = 0;
  /** Every request, as "METHOD path". */
  const requests: string[] = [];
  const hooks: { when: 'before' | 'after'; request: string; run: () => unknown }[] = [];
  const remove = (path: string) => {
    for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p);
    for (const d of [...dirs]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d);
  };
  const runHook = async (when: 'before' | 'after', request: string) => {
    const hook = hooks.find((h) => h.when === when && h.request === request);
    if (!hook) return;
    hooks.splice(hooks.indexOf(hook), 1);
    await hook.run();
  };
  const handle = (method: string, path: string, headers: Headers, body: unknown): Response => {
    const file = files.get(path);
    switch (method) {
      case 'GET':
      case 'HEAD':
        if (!file) return new Response(null, { status: 404 });
        return new Response(method === 'HEAD' ? null : file.data.slice(), { headers: { ETag: file.etag } });
      case 'PUT': {
        if (!dirs.has(path.slice(0, path.lastIndexOf('/')) || '/'))
          return new Response(null, { status: 409 });
        const ifMatch = headers.get('If-Match');
        if ((ifMatch && file?.etag !== ifMatch) || (headers.get('If-None-Match') === '*' && file))
          return new Response(null, { status: 412 });
        const etag = `"v${++version}"`;
        const data = typeof body === 'string' ? new TextEncoder().encode(body) : (body as Uint8Array);
        files.set(path, { data: new Uint8Array(data), etag });
        return new Response(null, { status: file ? 204 : 201, headers: { ETag: etag } });
      }
      case 'MKCOL':
        if (dirs.has(path)) return new Response(null, { status: 405 });
        dirs.add(path);
        return new Response(null, { status: 201 });
      case 'DELETE':
        if (!file && !dirs.has(path)) return new Response(null, { status: 404 });
        remove(path);
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 404 });
    }
  };
  return {
    files,
    requests,
    /** Another device deletes a project's folder. */
    remove,
    once(when: 'before' | 'after', request: string, run: () => unknown) {
      hooks.push({ when, request, run });
    },
    fetch: async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = decodeURIComponent(new URL(input).pathname).replace(/(.)\/$/, '$1');
      const request = `${method} ${path}`;
      requests.push(request);
      await runHook('before', request);
      const res = handle(method, path, new Headers(init.headers as Record<string, string>), init.body);
      await runHook('after', request);
      return res;
    },
  };
}

/*
 * Another writer deletes the project right after this browser's own write. That write held all of
 * the browser's changes: like the editor server's rooms, it does not store the project again, also
 * not at its next syncs (it used to, as it did not record what it had written).
 */
describe('WebDAV sync of a project deleted right after this browser wrote it', () => {
  const ID = 'p-doomed';
  const DIR = `/projects/${ID}`;
  const DOC = `${DIR}/document.ybin`;

  function open(doc: SceneDoc) {
    const target = {
      store: new ProjectFileStore(new WebDAVClient({ url: 'https://dav.test/' }), '/'),
      label: 'test',
      viaServer: false,
    };
    const info = () => ({ id: ID, name: doc.name, created_at: '', updated_at: '', schema_version: 1 });
    return new WebDAVSync(target, ID, doc, info, { type: 'storage' });
  }

  afterEach(() => vi.unstubAllGlobals());

  it.each(['a change', 'a new project'] as const)('does not store %s again', async (what) => {
    localStorage.clear();
    toasts.value = [];
    const server = davServer();
    vi.stubGlobal('fetch', server.fetch);
    const doc = SceneDoc.create({ name: 'Doomed', empty: true });
    const sync = open(doc);
    if (what === 'a change') {
      expect(await sync.syncNow()).toMatchObject({ pushed: true, created: true });
      doc.addObject({ type: 'EMPTY', name: 'Saved, then deleted' });
    }
    // another device deletes the project right after this browser's write of the document
    server.once('after', `PUT ${DOC}`, () => server.remove(DIR));
    expect(await sync.syncNow()).toMatchObject({ pushed: true, missing: true });
    expect(server.files.size).toBe(0);
    expect(sync.status.value).toBe('deleted');
    // the next syncs (every 20 s), without a change made since
    expect(await sync.syncNow()).toMatchObject({ pushed: false, missing: true });
    expect(server.files.size).toBe(0);
    expect(toasts.value.map((t) => t.message)).toEqual([
      '"Doomed" was deleted from WebDAV on another device. This browser keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).',
    ]);
    // a change made afterwards stores it again
    doc.addObject({ type: 'EMPTY', name: 'Made afterwards' });
    expect(await sync.syncNow()).toMatchObject({ pushed: true, created: true });
    expect(server.files.has(DOC)).toBe(true);
    await sync.stop(false);
    doc.destroy();
  });

  /*
   * The record of what the browser synced keeps what earlier syncs stored: a writer that ignored
   * If-Match stored a state without this browser's object, and the project was deleted while this
   * browser was writing it again. That object is no change made since its last sync: the browser
   * does not store the project again at its next sync.
   */
  it('remembers what it synced when the last state it read lacked part of it', async () => {
    localStorage.clear();
    const server = davServer();
    vi.stubGlobal('fetch', server.fetch);
    const doc = SceneDoc.create({ name: 'Replaced', empty: true });
    doc.addObject({ type: 'EMPTY', name: 'Synced' });
    const sync = open(doc);
    expect(await sync.syncNow()).toMatchObject({ pushed: true, created: true });
    const other = SceneDoc.create({ name: 'Replaced', empty: true });
    server.files.set(DOC, { data: other.encodeState(), etag: '"other"' });
    server.once('after', `GET ${DOC}`, () => server.remove(DIR));
    expect(await sync.syncNow()).toMatchObject({ pulled: true, pushed: false, missing: true });
    expect(await sync.syncNow()).toMatchObject({ pushed: false, missing: true });
    expect(server.files.size).toBe(0);
    await sync.stop(false);
    doc.destroy();
    other.destroy();
  });
});

/*
 * One tab of this browser deletes a project that another tab has open. The tabs share what the
 * browser synced (localStorage); the deletion used to forget it, and the other tab then uploaded the
 * project at its next sync as one it had never synced, without telling the person.
 */
describe('WebDAV sync of a project deleted in another tab', () => {
  const ID = 'p-two-tabs';
  const DOC = `/projects/${ID}/document.ybin`;

  function openTab(doc: SceneDoc) {
    const target = resolveWebDAV()!;
    const info = () => ({ id: ID, name: doc.name, created_at: '', updated_at: '', schema_version: 1 });
    return new WebDAVSync(target, ID, doc, info, { type: 'storage' });
  }

  /** Tab 1 has the project open; tab 2 deletes it from the project list. */
  async function deletedInOtherTab(opts: { synced: boolean }) {
    localStorage.clear();
    toasts.value = [];
    session.value = null;
    const server = davServer();
    vi.stubGlobal('fetch', server.fetch);
    useWebDAVDirectly();
    const doc = SceneDoc.create({ name: 'Two tabs', empty: true });
    const tab1 = openTab(doc);
    if (opts.synced) expect(await tab1.syncNow()).toMatchObject({ pushed: true });
    const info = { id: ID, name: 'Two tabs', created_at: '', updated_at: '', schema_version: 1 };
    await deleteProject({ ...info, sources: opts.synced ? ['local', 'webdav'] : ['local'] });
    expect(server.files.size).toBe(0);
    return { server, doc, tab1 };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('does not store it again without changes, and says it was deleted in this browser', async () => {
    const { server, doc, tab1 } = await deletedInOtherTab({ synced: true });
    expect(await tab1.syncNow()).toMatchObject({ pushed: false, missing: true });
    expect(server.files.size).toBe(0);
    expect(tab1.status.value).toBe('deleted');
    expect(toasts.value.map((t) => t.message)).toEqual([
      '"Two tabs" was deleted from WebDAV in this browser. This tab keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).',
    ]);
    await tab1.stop(false);
    doc.destroy();
  });

  it('stores it again with changes made since, and says so', async () => {
    const { server, doc, tab1 } = await deletedInOtherTab({ synced: true });
    doc.addObject({ type: 'EMPTY', name: 'Made in tab 1' });
    expect(await tab1.syncNow()).toMatchObject({ pushed: true, created: true });
    expect(server.files.has(DOC)).toBe(true);
    expect(toasts.value.map((t) => t.message)).toEqual([
      '"Two tabs" was deleted from WebDAV in this browser; this tab stored it there again.',
    ]);
    // stored again: the deletion no longer counts
    expect(syncRecords.deleted(tab1.target, ID)).toBe(false);
    await tab1.stop(false);
    doc.destroy();
  });

  it('does not upload a project it never synced that another tab deleted', async () => {
    const { server, doc, tab1 } = await deletedInOtherTab({ synced: false });
    expect(await tab1.syncNow()).toMatchObject({ pushed: false, missing: true });
    expect(server.files.size).toBe(0);
    expect(tab1.status.value).toBe('deleted');
    await tab1.stop(false);
    doc.destroy();
  });

  /*
   * The open project's sync was running (its GET answered) when the person deleted the project: it
   * went on after the deletion, found the document gone and wrote the project again.
   */
  it('waits for a sync that is running before it deletes the open project', async () => {
    localStorage.clear();
    const server = davServer();
    vi.stubGlobal('fetch', server.fetch);
    useWebDAVDirectly();
    const s = await ProjectSession.open(ID, { initial: SceneDoc.create({ name: 'Racing', empty: true }) });
    session.value = s;
    await s.webdav!.syncNow();
    s.doc.addObject({ type: 'EMPTY', name: 'Unsaved' });
    let deleting: Promise<void> | null = null;
    server.once('after', `GET ${DOC}`, () => {
      deleting = deleteProject({ ...s.projectInfo(), sources: ['local', 'webdav'] });
    });
    // the sync's write takes a while: until the deletion, or 100 ms (the deletion waits for it)
    let release = () => {};
    server.once('before', `PUT ${DOC}`, () => new Promise<void>((r) => setTimeout((release = r), 100)));
    server.once('after', `DELETE /projects/${ID}`, () => release());
    await s.webdav!.syncNow();
    await deleting;
    // the sync wrote its change, and then the project was deleted
    const writes = server.requests.filter((r) => r.startsWith('PUT') || r.startsWith('DELETE'));
    expect(writes).toEqual([
      `PUT ${DOC}`,
      `PUT /projects/${ID}/project.json`,
      `PUT ${DOC}`,
      `PUT /projects/${ID}/project.json`,
      `DELETE /projects/${ID}`,
    ]);
    expect(server.files.size).toBe(0);
  });
});
