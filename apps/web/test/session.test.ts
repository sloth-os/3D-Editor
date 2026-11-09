import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { MSG_CONTROL, MSG_SYNC, SceneDoc, encodeFrame, encodeJsonFrame } from '@3d-editor/core';
import { ProjectSession } from '../src/project/session';
import { localIndex } from '../src/project/local-index';
import { serverConfig, toasts } from '../src/app/store';
import { prefs, defaultPreferences } from '../src/app/prefs';

/** A WebSocket that never connects; the test plays the sync server through `receive`. */
class FakeSocket {
  static readonly OPEN = 1;
  static created: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.created.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  receive(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.slice().buffer });
  }
  /** The server accepts the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** The server closes the connection with `code`. */
  closedBy(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Browser storage only, and a server with sync whose WebSocket is a {@link FakeSocket}. */
function withSyncServer(): void {
  FakeSocket.created = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  serverConfig.value = {
    version: 'test',
    features: { sync: true, mcp: false, telemetry: false, webdavProxy: false },
    webdav: null,
    persistence: 'memory',
  };
  prefs.value = { ...defaultPreferences(), storage: { ...defaultPreferences().storage, mode: 'browser' } };
}

/** The server's hello: a room of the server took the connection. */
function hello(socket: FakeSocket, room: string): void {
  socket.receive(
    encodeJsonFrame(MSG_CONTROL, {
      kind: 'hello',
      connectionId: `c${FakeSocket.created.indexOf(socket)}`,
      room,
      serverVersion: 'test',
      protocol: 1,
      peers: 1,
    }),
  );
}

/** A WebDAV server in memory with ETags in GET, HEAD and PUT responses. */
function memoryDav() {
  const files = new Map<string, { data: Uint8Array; etag: string }>();
  let version = 0;
  const put = (path: string, data: Uint8Array) => {
    files.set(path, { data: new Uint8Array(data), etag: `"${++version}"` });
    return `"${version}"`;
  };
  return {
    files,
    /** Another writer stores a file. */
    put,
    /** Another writer deletes a project's folder. */
    remove(prefix: string) {
      for (const p of [...files.keys()]) if (p.startsWith(prefix)) files.delete(p);
    },
    fetch: async (input: string, init: RequestInit = {}) => {
      const path = decodeURIComponent(new URL(input).pathname).replace(/(.)\/$/, '$1');
      const file = files.get(path);
      switch (init.method ?? 'GET') {
        case 'GET':
        case 'HEAD':
          return file
            ? new Response(init.method === 'HEAD' ? null : file.data.slice(), {
                headers: { ETag: file.etag },
              })
            : new Response(null, { status: 404 });
        case 'PUT':
          return new Response(null, { status: 201, headers: { ETag: put(path, init.body as Uint8Array) } });
        case 'PROPFIND':
          return new Response(null, { status: 404 });
        default:
          return new Response(null, { status: 201 });
      }
    },
  };
}

/**
 * A server with sync whose WebSocket is a {@link FakeSocket}, and storage `dav`: the server's WebDAV
 * through its /dav proxy, or a WebDAV server the browser uses directly.
 */
function withSyncServerAndWebDAV(dav: ReturnType<typeof memoryDav>, via: 'server' | 'direct'): void {
  FakeSocket.created = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', dav.fetch);
  localStorage.clear();
  serverConfig.value = {
    version: 'test',
    features: { sync: true, mcp: false, telemetry: false, webdavProxy: via === 'server' },
    webdav: via === 'server' ? { url: '/dav', basePath: '/3d-editor' } : null,
    persistence: via === 'server' ? 'webdav' : 'memory',
  };
  const d = defaultPreferences();
  prefs.value =
    via === 'server'
      ? d
      : {
          ...d,
          storage: {
            mode: 'webdav',
            webdav: { ...d.storage.webdav, url: 'https://dav.test/', basePath: '/' },
          },
        };
}

afterEach(() => {
  vi.unstubAllGlobals();
  ProjectSession.remoteWaitMs = 4000;
});

describe('ProjectSession (browser storage)', () => {
  it('persists projects in IndexedDB across sessions and indexes them', async () => {
    serverConfig.value = null;
    prefs.value = { ...defaultPreferences(), storage: { ...defaultPreferences().storage, mode: 'browser' } };
    const initial = SceneDoc.create({ name: 'Persisted' });
    const s1 = await ProjectSession.open('proj-1', { initial });
    expect(s1.doc.listObjects().map((o) => o.name)).toEqual(['Camera', 'Cube', 'Light']);
    s1.doc.addObject({ type: 'EMPTY', name: 'Marker' });
    // give y-indexeddb a moment to write the update
    await new Promise((r) => setTimeout(r, 50));
    s1.close(false);

    const s2 = await ProjectSession.open('proj-1');
    expect(s2.doc.findObjectByName('Marker')).not.toBeNull();
    expect(s2.doc.name).toBe('Persisted');
    expect(s2.webdav).toBeNull();
    expect(s2.provider?.status.value).toBe('disabled');
    const entry = await localIndex.get('proj-1');
    expect(entry?.name).toBe('Persisted');
    expect(entry?.stats?.objects).toBe(4);
    s2.close(false);

    await ProjectSession.deleteLocal('proj-1');
    expect(await localIndex.get('proj-1')).toBeUndefined();
    const s3 = await ProjectSession.open('proj-1');
    expect(s3.doc.listObjects()).toHaveLength(0);
    s3.close(false);
  });

  it('opens a project it has nothing of at once when no server or WebDAV is attached', async () => {
    // regression: it waited 4 s (remoteWaitMs) for a remote that could not answer
    serverConfig.value = null;
    prefs.value = { ...defaultPreferences(), storage: { ...defaultPreferences().storage, mode: 'browser' } };
    const t0 = performance.now();
    const s = await ProjectSession.open('proj-nothing');
    // about 10 ms here; the wait it must not do is 4000 ms
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s.provider?.enabled).toBe(false);
    expect(s.webdav).toBeNull();
    expect(s.doc.listObjects()).toHaveLength(0);
    s.close(false);
  });

  it('waits for an attached sync server to deliver a project it has nothing of', async () => {
    withSyncServer();
    const events: string[] = [];
    const opening = ProjectSession.open('proj-remote').then((s) => {
      events.push(`opened with ${s.doc.listObjects().length} objects`);
      return s;
    });
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    // the server answers a moment later with the project (its sync step 2)
    await new Promise((r) => setTimeout(r, 200));
    const remote = SceneDoc.create({ name: 'On the server' });
    events.push('server answered');
    FakeSocket.created[0].receive(
      encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep2(enc, remote.ydoc)),
    );
    const s = await opening;
    expect(events).toEqual(['server answered', 'opened with 3 objects']);
    expect(s.doc.name).toBe('On the server');
    expect(s.provider?.synced.value).toBe(true);
    s.close(false);
    remote.destroy();
  });

  it('waits for attached WebDAV storage to deliver a project it has nothing of', async () => {
    serverConfig.value = null;
    const d = defaultPreferences();
    prefs.value = {
      ...d,
      storage: { mode: 'webdav', webdav: { ...d.storage.webdav, url: 'https://dav.example/' } },
    };
    const remote = SceneDoc.create({ name: 'On WebDAV' });
    const events: string[] = [];
    // the WebDAV server answers the GET of the project's document a moment later
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 200));
      events.push(`${init.method} ${new URL(url).pathname}`);
      return new Response(remote.encodeState().slice(), { status: 200, headers: { ETag: '"1"' } });
    });
    const s = await ProjectSession.open('proj-dav').then((s) => {
      events.push(`opened with ${s.doc.listObjects().length} objects`);
      return s;
    });
    // a new client asks for the ETag with PROPFIND before its first GET: it cannot know yet whether
    // the server sends the ETag with GET (this one does, so no PROPFIND follows the GET)
    expect(events).toEqual([
      'PROPFIND /3d-editor/projects/proj-dav/document.ybin',
      'GET /3d-editor/projects/proj-dav/document.ybin',
      'opened with 3 objects',
    ]);
    expect(s.webdav).not.toBeNull();
    expect(s.doc.name).toBe('On WebDAV');
    s.close(false);
    remote.destroy();
  });

  it('opens an empty project after the deadline when the attached server does not answer', async () => {
    withSyncServer();
    ProjectSession.remoteWaitMs = 300;
    const t0 = performance.now();
    const s = await ProjectSession.open('proj-silent');
    expect(FakeSocket.created).toHaveLength(1);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
    expect(s.doc.listObjects()).toHaveLength(0);
    expect(s.provider?.synced.value).toBe(false);
    s.close(false);
  });

  it('undo restores edit-mode selection metadata and removed objects clear the selection', async () => {
    serverConfig.value = null;
    const s = await ProjectSession.open('proj-2', { initial: SceneDoc.create({ empty: true }) });
    const id = s.doc.transact(() => s.doc.addObject({ type: 'EMPTY', name: 'E' }));
    s.state.selectedIds = [id];
    s.state.activeId = id;
    s.doc.removeObject(id);
    expect(s.state.selectedIds).toEqual([]);
    expect(s.state.activeId).toBeNull();
    s.close(false);
  });

  it('publishes peers when other clients change, not when this client’s own presence does', async () => {
    // regression: every frame change, selection and view move of this client (sent as presence)
    // published a new peers list, and the viewport synced and redrew the whole scene for it
    serverConfig.value = null;
    const s = await ProjectSession.open('proj-3', { initial: SceneDoc.create({ empty: true }) });
    const before = s.peers.value;
    s.awareness.setLocalState({ user: { name: 'Me', color: '#fff', kind: 'human' }, frame: 7 });
    s.awareness.setLocalState({ user: { name: 'Me', color: '#fff', kind: 'human' }, frame: 8 });
    expect(s.peers.value).toBe(before);
    // another client appears, then moves: published each time
    const other = new Awareness(new Y.Doc());
    other.setLocalState({ user: { name: 'Ada', color: '#f00', kind: 'human' }, frame: 1 });
    applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(other, [other.clientID]), 'remote');
    const withAda = s.peers.value;
    expect(withAda.map((p) => p.state.user.name)).toEqual(['Ada']);
    other.setLocalState({ user: { name: 'Ada', color: '#f00', kind: 'human' }, frame: 2 });
    applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(other, [other.clientID]), 'remote');
    expect(s.peers.value).not.toBe(withAda);
    expect(s.peers.value[0].state.frame).toBe(2);
    // this client's own presence again: unchanged
    const now = s.peers.value;
    s.awareness.setLocalState({ user: { name: 'Me', color: '#fff', kind: 'human' }, frame: 9 });
    expect(s.peers.value).toBe(now);
    other.destroy();
    s.close(false);
  });
});

/*
 * The server deleted the project (deleted there, or found deleted from its storage): it closes the
 * connection with 4404, and every new one the same way. The browser used to connect again and again
 * and showed 'Connecting…' without telling the person.
 */
describe('ProjectSession of a project the server deleted', () => {
  const deletedMessage =
    '"On the server" was deleted on the server. This browser keeps its copy and no longer syncs it with the server.';

  it('says so once, keeps the copy and its edits, and connects again on Save', async () => {
    withSyncServer();
    toasts.value = [];
    const s = await ProjectSession.open('proj-deleted', {
      initial: SceneDoc.create({ name: 'On the server', empty: true }),
    });
    expect(FakeSocket.created).toHaveLength(1);
    FakeSocket.created[0].open();
    FakeSocket.created[0].closedBy(4404);
    expect(s.provider?.status.value).toBe('deleted');
    expect(toasts.value.map((t) => [t.level, t.message])).toEqual([['warning', deletedMessage]]);
    // edits go on and are kept in this browser (IndexedDB)
    s.doc.addObject({ type: 'EMPTY', name: 'Made afterwards' });
    await new Promise((r) => setTimeout(r, 50));
    await s.close(false);
    const again = await ProjectSession.open('proj-deleted');
    expect(again.doc.findObjectByName('Made afterwards')).not.toBeNull();
    // (a reload connects again; the server closes that connection the same way, and says so again)
    expect(FakeSocket.created).toHaveLength(2);
    FakeSocket.created[1].open();
    FakeSocket.created[1].closedBy(4404);
    expect(toasts.value.filter((t) => t.message === deletedMessage)).toHaveLength(2);
    // Save (Ctrl+S) connects again; the server has the project again, and nothing more is said
    await again.flush();
    expect(FakeSocket.created).toHaveLength(3);
    expect(again.provider?.status.value).toBe('connecting');
    FakeSocket.created[2].open();
    expect(again.provider?.status.value).toBe('connected');
    expect(toasts.value.filter((t) => t.message === deletedMessage)).toHaveLength(2);
    await again.close(false);
  });

  /*
   * Save connects again, and while the server has the project deleted it closes that connection the
   * same way: the browser said so again, next to Save's own message. A deletion after a room of the
   * server took a connection again (its storage held the project again) is a new one.
   */
  it('says so once per deletion, not again when it closes the connection of a Save the same way', async () => {
    withSyncServer();
    toasts.value = [];
    const s = await ProjectSession.open('proj-deleted-once', {
      initial: SceneDoc.create({ name: 'On the server', empty: true }),
    });
    const told = () => toasts.value.filter((t) => t.message === deletedMessage).length;
    FakeSocket.created[0].open();
    hello(FakeSocket.created[0], 'proj-deleted-once');
    expect(s.provider?.joined.value).toBe(true);
    FakeSocket.created[0].closedBy(4404);
    expect(s.provider?.joined.value).toBe(false);
    expect(told()).toBe(1);
    expect(await s.flush()).toEqual({ message: 'Saved in this browser', level: 'info' });
    expect(FakeSocket.created).toHaveLength(2);
    FakeSocket.created[1].open();
    FakeSocket.created[1].closedBy(4404);
    expect(s.provider?.status.value).toBe('deleted');
    expect(told()).toBe(1);
    // the server opens the project again (a room takes the connection), then deletes it again
    await s.flush();
    FakeSocket.created[2].open();
    hello(FakeSocket.created[2], 'proj-deleted-once');
    expect(s.provider?.status.value).toBe('connected');
    FakeSocket.created[2].closedBy(4404);
    expect(told()).toBe(2);
    await s.close(false);
  });

  it('opens a project it has nothing of without waiting for a server that deleted it', async () => {
    withSyncServer();
    ProjectSession.remoteWaitMs = 10_000;
    const t0 = performance.now();
    const opening = ProjectSession.open('proj-deleted-elsewhere');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    FakeSocket.created[0].open();
    FakeSocket.created[0].closedBy(4404);
    const s = await opening;
    // the wait it must not do is 10 s
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(s.provider?.status.value).toBe('deleted');
    await s.close(false);
  });
});

/*
 * WebDAV through the editor server (WEBDAV_URL) is the server's storage. A deletion on the server
 * was told twice: the server's message, then WebDAV's 'deleted from WebDAV on another device'. And
 * when a change stored the project there again, which the server then opened again, the page stayed
 * disconnected from the server until a reload or Save.
 */
describe('ProjectSession with WebDAV through the server, of a project the server deleted', () => {
  const ID = 'proj-proxy';
  const FOLDER = `/dav/3d-editor/projects/${ID}/`;
  const DOC = `${FOLDER}document.ybin`;
  const deletedOnServer =
    '"Shared" was deleted on the server. This browser keeps its copy and stores it on the server again when you change it or save (Ctrl+S).';
  const storedAgain = '"Shared" was deleted on the server; this browser stored it there again.';

  /** A project open in this browser, synced with WebDAV and live with the server. */
  async function openLive(dav: ReturnType<typeof memoryDav>, via: 'server' | 'direct' = 'server') {
    withSyncServerAndWebDAV(dav, via);
    toasts.value = [];
    const s = await ProjectSession.open(ID, { initial: SceneDoc.create({ name: 'Shared', empty: true }) });
    expect(s.webdav?.target.viaServer).toBe(via === 'server');
    await s.webdav!.syncNow();
    expect(s.webdav!.status.value).toBe('synced');
    FakeSocket.created[0].open();
    hello(FakeSocket.created[0], ID);
    expect(s.provider?.status.value).toBe('connected');
    return s;
  }

  const messages = () => toasts.value.map((t) => t.message);

  it('says once that the server deleted it, and syncs live again once a change stores it again', async () => {
    const dav = memoryDav();
    const s = await openLive(dav);
    expect(dav.files.has(DOC)).toBe(true);
    // the server closes the project's connections, then deletes it from its storage
    FakeSocket.created[0].closedBy(4404);
    dav.remove(FOLDER);
    expect(messages()).toEqual([deletedOnServer]);
    await s.webdav!.syncNow();
    expect(s.webdav!.status.value).toBe('deleted');
    expect(messages()).toEqual([deletedOnServer]);
    expect(FakeSocket.created).toHaveLength(1);
    // a change stores it again through the proxy, and the server opens it again
    s.doc.addObject({ type: 'EMPTY', name: 'Made afterwards' });
    await s.webdav!.syncNow();
    expect(dav.files.has(DOC)).toBe(true);
    expect(messages()).toEqual([deletedOnServer, storedAgain]);
    expect(FakeSocket.created).toHaveLength(2);
    FakeSocket.created[1].open();
    hello(FakeSocket.created[1], ID);
    expect(s.provider?.status.value).toBe('connected');
    await s.close(false);
  });

  it('syncs live again when a change stores it again before WebDAV saw the deletion', async () => {
    const dav = memoryDav();
    const s = await openLive(dav);
    FakeSocket.created[0].closedBy(4404);
    dav.remove(FOLDER);
    s.doc.addObject({ type: 'EMPTY', name: 'Made afterwards' });
    expect(await s.webdav!.syncNow()).toMatchObject({ created: true });
    expect(messages()).toEqual([deletedOnServer, storedAgain]);
    expect(FakeSocket.created).toHaveLength(2);
    await s.close(false);
  });

  it('syncs live again when another writer stores it again', async () => {
    const dav = memoryDav();
    const s = await openLive(dav);
    FakeSocket.created[0].closedBy(4404);
    dav.remove(FOLDER);
    await s.webdav!.syncNow();
    expect(s.webdav!.status.value).toBe('deleted');
    // another device stores its copy again (its unsaved changes)
    const other = SceneDoc.create({ name: 'Shared', empty: true });
    dav.put(DOC, other.encodeState());
    await s.webdav!.syncNow();
    expect(s.webdav!.status.value).toBe('synced');
    expect(FakeSocket.created).toHaveLength(2);
    expect(messages()).toEqual([deletedOnServer]);
    other.destroy();
    await s.close(false);
  });

  it('says once that it was deleted when WebDAV finds the deletion before the server says so', async () => {
    const dav = memoryDav();
    const s = await openLive(dav);
    // another device deletes it: through the proxy, then through the REST API
    dav.remove(FOLDER);
    await s.webdav!.syncNow();
    FakeSocket.created[0].closedBy(4404);
    expect(s.provider?.status.value).toBe('deleted');
    expect(messages()).toEqual([
      '"Shared" was deleted from WebDAV on another device. This browser keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).',
    ]);
    await s.close(false);
  });

  it('stores it again on Save, says so, and syncs live again', async () => {
    const dav = memoryDav();
    const s = await openLive(dav);
    FakeSocket.created[0].closedBy(4404);
    dav.remove(FOLDER);
    await s.webdav!.syncNow();
    expect(await s.flush()).toEqual({ message: storedAgain, level: 'warning' });
    expect(dav.files.has(DOC)).toBe(true);
    expect(FakeSocket.created).toHaveLength(2);
    expect(s.provider?.status.value).toBe('connecting');
    await s.close(false);
  });

  /* WebDAV used directly is not the server's storage: that it holds the project says nothing of the server. */
  it('does not connect again by itself with WebDAV used directly', async () => {
    const dav = memoryDav();
    const s = await openLive(dav, 'direct');
    FakeSocket.created[0].closedBy(4404);
    const onServer =
      '"Shared" was deleted on the server. This browser keeps its copy and no longer syncs it with the server.';
    expect(messages()).toEqual([onServer]);
    // another device deletes it from this WebDAV server too: a deletion of its own, told as such
    dav.remove(`/projects/${ID}/`);
    await s.webdav!.syncNow();
    expect(s.webdav!.status.value).toBe('deleted');
    expect(messages()).toEqual([
      onServer,
      '"Shared" was deleted from WebDAV on another device. This browser keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).',
    ]);
    // a change stores it there again, which tells nothing about the server
    s.doc.addObject({ type: 'EMPTY', name: 'Made afterwards' });
    expect(await s.webdav!.syncNow()).toMatchObject({ created: true });
    expect(messages()[2]).toBe(
      '"Shared" was deleted from WebDAV on another device; this browser stored it there again.',
    );
    expect(FakeSocket.created).toHaveLength(1);
    expect(s.provider?.status.value).toBe('deleted');
    await s.close(false);
  });
});
