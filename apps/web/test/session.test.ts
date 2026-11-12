import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import {
  MSG_CONTROL,
  MSG_SYNC,
  SceneDoc,
  encodeFrame,
  encodeJsonFrame,
  readFrameType,
  readJsonPayload,
  type ControlMessage,
} from '@3d-editor/core';
import {
  INDEX_UPDATE_MS,
  LOAD_REFUSED_NOTE,
  ProjectSession,
  THUMBNAIL_RETRY_MS,
  THUMBNAIL_WAIT_MS,
  refusedOnServer,
  refusedOnServerNote,
} from '../src/project/session';
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
  /** Whether the test's server answers pings (as the editor server does while it applies changes). */
  answersPings = false;
  constructor(readonly url: string) {
    FakeSocket.created.push(this);
  }
  send(frame: Uint8Array): void {
    const { type, decoder } = readFrameType(frame);
    if (type !== MSG_CONTROL || !this.answersPings) return;
    const msg = readJsonPayload<ControlMessage>(decoder);
    if (msg.kind === 'ping')
      queueMicrotask(() => this.receive(encodeJsonFrame(MSG_CONTROL, { kind: 'pong', t: msg.t })));
  }
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

/**
 * The test's server takes the connection as a room of the editor server does: hello, its sync step 1
 * (the browser answers with its step 2), and answers to pings when `answersPings`.
 */
function serve(socket: FakeSocket, room: string, answersPings = true): void {
  socket.answersPings = answersPings;
  socket.open();
  hello(socket, room);
  socket.receive(encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, new Y.Doc())));
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

describe('ProjectSession: the thumbnail of the local project list', () => {
  /*
   * The viewport gives a thumbnail only of a frame it drew that shows every change (its canvas keeps
   * it): a thumbnail of its own, drawn 3 s after every change, held the tab for as long as the GPU
   * drew the frame (0.55 to 0.95 s with 4 million triangles in software WebGL).
   */
  it('takes the thumbnail once the viewport shows the latest change, and keeps the last one meanwhile', async () => {
    serverConfig.value = null;
    prefs.value = { ...defaultPreferences(), storage: { ...defaultPreferences().storage, mode: 'browser' } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = await ProjectSession.open('proj-thumb', { initial: SceneDoc.create({ name: 'Thumb' }) });
    let shown: string | null = 'thumb-1';
    let asked = 0;
    try {
      s.thumbnailProvider = () => (asked++, shown);
      // the entry of the opening
      vi.advanceTimersByTime(INDEX_UPDATE_MS);
      expect(s.projectInfo().thumbnail).toBe('thumb-1');
      // the project's info (what WebDAV's project.json stores too) takes the thumbnail of the
      // viewport as it shows the project now
      shown = 'thumb-1b';
      expect(s.projectInfo().thumbnail).toBe('thumb-1b');
      // the viewport has not drawn the latest change: the project's info keeps the last thumbnail
      shown = null;
      expect(s.projectInfo().thumbnail).toBe('thumb-1b');
      asked = 0;
      s.doc.addObject({ type: 'EMPTY', name: 'Marker' });
      vi.advanceTimersByTime(INDEX_UPDATE_MS - 1);
      expect(asked).toBe(0);
      vi.advanceTimersByTime(1);
      expect(asked).toBe(1);
      // asked again while the viewport has not drawn it, then written with the thumbnail of it
      vi.advanceTimersByTime(THUMBNAIL_RETRY_MS);
      expect(asked).toBe(2);
      shown = 'thumb-2';
      vi.advanceTimersByTime(THUMBNAIL_RETRY_MS);
      expect(asked).toBe(3);
      vi.advanceTimersByTime(10 * THUMBNAIL_RETRY_MS);
      expect(asked).toBe(3);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(async () => expect((await localIndex.get('proj-thumb'))?.thumbnail).toBe('thumb-2'));
    // a viewport that does not draw the change: written with the last thumbnail at last
    shown = null;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      asked = 0;
      s.doc.addObject({ type: 'EMPTY', name: 'Marker 2' });
      vi.advanceTimersByTime(INDEX_UPDATE_MS + THUMBNAIL_WAIT_MS);
      // asked every THUMBNAIL_RETRY_MS from INDEX_UPDATE_MS after the change to THUMBNAIL_WAIT_MS
      const asks = asked;
      expect(asks).toBe((THUMBNAIL_WAIT_MS - INDEX_UPDATE_MS) / THUMBNAIL_RETRY_MS + 1);
      vi.advanceTimersByTime(10 * THUMBNAIL_RETRY_MS);
      expect(asked).toBe(asks);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(async () => expect((await localIndex.get('proj-thumb'))?.stats?.objects).toBe(5));
    expect((await localIndex.get('proj-thumb'))?.thumbnail).toBe('thumb-2');
    // a hidden page draws no frames: written with the last thumbnail at once
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      asked = 0;
      s.doc.addObject({ type: 'EMPTY', name: 'Marker 3' });
      vi.advanceTimersByTime(INDEX_UPDATE_MS);
      expect(asked).toBe(1);
      vi.advanceTimersByTime(10 * THUMBNAIL_RETRY_MS);
      expect(asked).toBe(1);
    } finally {
      vi.useRealTimers();
      visibility.mockRestore();
    }
    await vi.waitFor(async () => expect((await localIndex.get('proj-thumb'))?.stats?.objects).toBe(6));
    expect((await localIndex.get('proj-thumb'))?.thumbnail).toBe('thumb-2');
    await s.close(false);
    await ProjectSession.deleteLocal('proj-thumb');
  });

  it('keeps the thumbnail the local project list has until the viewport gives one', async () => {
    // the viewport draws no frame for a thumbnail: a page opened hidden gives none until it is shown
    serverConfig.value = null;
    prefs.value = { ...defaultPreferences(), storage: { ...defaultPreferences().storage, mode: 'browser' } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const first = await ProjectSession.open('proj-kept', { initial: SceneDoc.create({ name: 'Kept' }) });
      first.thumbnailProvider = () => 'stored';
      first.doc.addObject({ type: 'EMPTY', name: 'Marker' });
      vi.advanceTimersByTime(INDEX_UPDATE_MS);
      await first.close(false);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(async () => expect((await localIndex.get('proj-kept'))?.thumbnail).toBe('stored'));
    // opened again in a hidden page, before a viewport: the entry and the project's info keep it
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = await ProjectSession.open('proj-kept');
    try {
      expect(s.projectInfo().thumbnail).toBe('stored');
      // its viewport drew nothing: written after a change, still with it
      s.thumbnailProvider = () => null;
      s.doc.addObject({ type: 'EMPTY', name: 'Marker 2' });
      vi.advanceTimersByTime(INDEX_UPDATE_MS);
    } finally {
      vi.useRealTimers();
      visibility.mockRestore();
    }
    await vi.waitFor(async () => expect((await localIndex.get('proj-kept'))?.stats?.objects).toBe(5));
    expect((await localIndex.get('proj-kept'))?.thumbnail).toBe('stored');
    await s.close(false);
    await ProjectSession.deleteLocal('proj-kept');
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
 * The server did not take this browser's changes for memory (an error with code OUT_OF_MEMORY, then
 * the close code 4507): the session says so once with the server's reason, keeps the project with
 * its changes, does not wait for the server when it opens one it has nothing of, and Save connects
 * again.
 */
describe('ProjectSession of a project whose changes the server did not take', () => {
  const reason = 'changes not applied on the server: they add 50 new objects to the project (test)';
  const refusedMessage =
    `"Large" is not synced with the server: ${reason}. This browser keeps the project with your changes (in ` +
    'this browser, in its other tabs and in WebDAV when it saves there) and no longer syncs it with the server; ' +
    'Save (Ctrl+S) or a reload sends it to the server again.';
  const refuse = (socket: FakeSocket) => {
    socket.receive(encodeJsonFrame(MSG_CONTROL, { kind: 'error', code: 'OUT_OF_MEMORY', message: reason }));
    socket.closedBy(4507);
  };

  it('says so once with the reason, keeps the changes, and connects again on Save', async () => {
    withSyncServer();
    toasts.value = [];
    const s = await ProjectSession.open('proj-refused', {
      initial: SceneDoc.create({ name: 'Large', empty: true }),
    });
    FakeSocket.created[0].open();
    hello(FakeSocket.created[0], 'proj-refused');
    s.doc.addObject({ type: 'EMPTY', name: 'Not taken' });
    refuse(FakeSocket.created[0]);
    expect(s.provider?.status.value).toBe('refused');
    expect(toasts.value.map((t) => [t.level, t.message])).toEqual([['warning', refusedMessage]]);
    expect(s.doc.findObjectByName('Not taken')).not.toBeNull();
    // Save connects again; refused again, nothing more is said
    await s.flush();
    expect(FakeSocket.created).toHaveLength(2);
    FakeSocket.created[1].open();
    refuse(FakeSocket.created[1]);
    expect(toasts.value.filter((t) => t.message === refusedMessage)).toHaveLength(1);
    // the project fits now (the person deleted what it no longer needs): the connection stays
    await s.flush();
    FakeSocket.created[2].open();
    hello(FakeSocket.created[2], 'proj-refused');
    expect(s.provider?.status.value).toBe('connected');
    await s.close(false);
  });

  /*
   * A stored project the server cannot load: the toast said '"Untitled" is not synced with the
   * server' and that the browser keeps the project with the person's changes, of a project it never
   * had.
   */
  it('says that the server did not open a stored project it cannot load, with its reason', async () => {
    withSyncServer();
    toasts.value = [];
    refusedOnServer.set('proj-huge', false);
    const why = "project 'Huge' (proj-huge) was not loaded on the server: it would not fit (test)";
    const opening = ProjectSession.open('proj-huge');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    FakeSocket.created[0].open();
    FakeSocket.created[0].receive(
      encodeJsonFrame(MSG_CONTROL, { kind: 'error', code: 'OUT_OF_MEMORY', message: why }),
    );
    FakeSocket.created[0].closedBy(4507);
    const s = await opening;
    expect(toasts.value.map((t) => [t.level, t.message])).toEqual([
      ['warning', `The server did not open this project: ${why}. ${LOAD_REFUSED_NOTE}`],
    ]);
    expect(refusedOnServer.has('proj-huge')).toBe(false);
    await s.close(false);
  });

  /*
   * A server that cannot load the project says so before a room takes the connection (no hello),
   * also to the connection of a Save: the browser said so each time.
   */
  it('says once that the server did not open a stored project, not again when it refuses a Save the same way', async () => {
    withSyncServer();
    toasts.value = [];
    const why = "project 'Huge' (proj-huge-twice) was not loaded on the server: it would not fit (test)";
    const refuseLoad = (socket: FakeSocket) => {
      socket.open();
      socket.receive(encodeJsonFrame(MSG_CONTROL, { kind: 'error', code: 'OUT_OF_MEMORY', message: why }));
      socket.closedBy(4507);
    };
    const opening = ProjectSession.open('proj-huge-twice');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    refuseLoad(FakeSocket.created[0]);
    const s = await opening;
    await s.flush();
    expect(FakeSocket.created).toHaveLength(2);
    refuseLoad(FakeSocket.created[1]);
    expect(s.provider?.status.value).toBe('refused');
    expect(toasts.value.map((t) => t.message)).toEqual([
      `The server did not open this project: ${why}. ${LOAD_REFUSED_NOTE}`,
    ]);
    await s.close(false);
  });

  it('opens a project it has nothing of without waiting for a server that refused it', async () => {
    withSyncServer();
    ProjectSession.remoteWaitMs = 10_000;
    const t0 = performance.now();
    const opening = ProjectSession.open('proj-refused-load');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    FakeSocket.created[0].open();
    refuse(FakeSocket.created[0]);
    const s = await opening;
    // the wait it must not do is 10 s
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(s.provider?.status.value).toBe('refused');
    await s.close(false);
  });
});

/*
 * WebDAV through the editor server (WEBDAV_URL) is the server's storage, which its rooms read and
 * every editor of the project syncs with. A browser whose changes the server did not take saved them
 * there all the same: the next WebDAV sync of every other browser brought them to the server again,
 * which refused those browsers too, and the room no longer saved.
 */
describe('ProjectSession with WebDAV through the server, of changes the server did not take', () => {
  // (one project per test: the browser's IndexedDB keeps each project's document across tests)
  let ID = '';
  let DOC = '';
  const reason = 'changes not applied on the server: they add 1 new object to the project (test)';
  const notTaken =
    "Not saved to WebDAV (the server did not take this project's changes, so WebDAV through it gets them only " +
    'once it does). The project is saved in this browser.';
  const refuse = (socket: FakeSocket) => {
    socket.receive(encodeJsonFrame(MSG_CONTROL, { kind: 'error', code: 'OUT_OF_MEMORY', message: reason }));
    socket.closedBy(4507);
  };
  /** The project as WebDAV holds it. */
  const stored = (dav: ReturnType<typeof memoryDav>) => {
    const doc = new SceneDoc(new Y.Doc());
    Y.applyUpdate(doc.ydoc, dav.files.get(DOC)!.data);
    return doc;
  };

  /** A project open in this browser, stored in WebDAV, live with the server. */
  async function openLive(dav: ReturnType<typeof memoryDav>, id: string) {
    ID = id;
    DOC = `/dav/3d-editor/projects/${ID}/document.ybin`;
    withSyncServerAndWebDAV(dav, 'server');
    toasts.value = [];
    const s = await ProjectSession.open(ID, { initial: SceneDoc.create({ name: 'Large', empty: true }) });
    await s.webdav!.syncNow();
    expect(dav.files.has(DOC)).toBe(true);
    serve(FakeSocket.created[0], ID);
    return s;
  }

  it('saves nothing there while the server does not take them, also on Save, and saves them once it does', async () => {
    const dav = memoryDav();
    const s = await openLive(dav, 'proj-proxy-refused');
    s.doc.addObject({ type: 'EMPTY', name: 'Not taken' });
    refuse(FakeSocket.created[0]);
    expect(refusedOnServer.has(ID)).toBe(true);
    expect(toasts.value.map((t) => t.message)).toEqual([
      `"Large" is not synced with the server: ${reason}. ${refusedOnServerNote(true)}`,
    ]);
    expect(await s.webdav!.syncNow()).toBeNull();
    expect(s.webdav!.status.value).toBe('error');
    expect(stored(dav).findObjectByName('Not taken')).toBeNull();
    // Save connects again first; the server refuses again: WebDAV gets nothing, and Save says why
    const saving = s.flush();
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(2));
    FakeSocket.created[1].open();
    hello(FakeSocket.created[1], ID);
    refuse(FakeSocket.created[1]);
    expect(await saving).toEqual({ message: notTaken, level: 'error' });
    expect(stored(dav).findObjectByName('Not taken')).toBeNull();
    // one connection per Save: none again after this one was refused (the server measured the whole
    // project again and refused it the same way, and the browser said so a second time)
    expect(FakeSocket.created).toHaveLength(2);
    expect(toasts.value).toHaveLength(2);
    // the person deletes what the server could not take: Save, the server takes it, then WebDAV
    s.doc.removeObject(s.doc.findObjectByName('Not taken')!.id);
    s.doc.addObject({ type: 'EMPTY', name: 'Small' });
    const again = s.flush();
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(3));
    serve(FakeSocket.created[2], ID);
    expect(await again).toEqual({ message: 'Saved to WebDAV', level: 'info' });
    expect(stored(dav).findObjectByName('Small')).not.toBeNull();
    expect(refusedOnServer.has(ID)).toBe(false);
    await s.close(false);
  });

  it('writes there only what the server answered it holds, so a refusal that comes later stops the write', async () => {
    const dav = memoryDav();
    const s = await openLive(dav, 'proj-proxy-race');
    FakeSocket.created[0].answersPings = false;
    s.doc.addObject({ type: 'EMPTY', name: 'Not taken' });
    const sync = s.webdav!.syncNow();
    await new Promise((r) => setTimeout(r, 50));
    expect(stored(dav).findObjectByName('Not taken')).toBeNull();
    refuse(FakeSocket.created[0]);
    expect(await sync).toBeNull();
    expect(stored(dav).findObjectByName('Not taken')).toBeNull();
    await s.close(false);
  });

  it('after a reload, saves nothing there until the server answered that it holds the changes', async () => {
    const dav = memoryDav();
    const first = await openLive(dav, 'proj-proxy-reload');
    first.doc.addObject({ type: 'EMPTY', name: 'Not taken' });
    refuse(FakeSocket.created[0]);
    await new Promise((r) => setTimeout(r, 50));
    await first.close(false);
    // the page loaded again: its first WebDAV sync starts before the server says anything
    const s = await ProjectSession.open(ID);
    expect(s.doc.findObjectByName('Not taken')).not.toBeNull();
    const sync = s.webdav!.syncNow();
    await new Promise((r) => setTimeout(r, 50));
    expect(stored(dav).findObjectByName('Not taken')).toBeNull();
    FakeSocket.created[1].open();
    hello(FakeSocket.created[1], ID);
    refuse(FakeSocket.created[1]);
    expect(await sync).toBeNull();
    expect(stored(dav).findObjectByName('Not taken')).toBeNull();
    expect(refusedOnServer.has(ID)).toBe(true);
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

/*
 * A project a server opened from a project.json without a document has an empty document without a
 * name: the server no longer writes the stored name into it (a browser's rename in its copy of the
 * full document could lose to that write when they merge). The browser showed and saved it as
 * 'Untitled' (its project.json written by WebDAV syncs too); it now takes the stored name until the
 * document has one.
 */
describe('ProjectSession of a project whose document has no name', () => {
  it('shows and keeps the name the server lists, until the document has one', async () => {
    withSyncServer();
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/api/projects/proj-unnamed')
        ? Response.json({ id: 'proj-unnamed', name: 'Stored name' })
        : new Response(null, { status: 404 }),
    );
    const opening = ProjectSession.open('proj-unnamed');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    // the server's document: a change of an agent, no name
    const remote = new SceneDoc(new Y.Doc());
    remote.addObject({ type: 'EMPTY', name: 'Made by an agent' });
    FakeSocket.created[0].receive(
      encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep2(enc, remote.ydoc)),
    );
    const s = await opening;
    await vi.waitFor(() => expect(s.title.value).toBe('Stored name'));
    expect(s.projectInfo().name).toBe('Stored name');
    expect(s.doc.ydoc.getMap('meta').has('name')).toBe(false); // nothing written into the document
    s.doc.setName('Named here');
    expect(s.title.value).toBe('Named here');
    expect(s.projectInfo().name).toBe('Named here');
    await s.close(false);
    remote.destroy();
  });

  /*
   * The stored name was only the title and the name saves keep: what reads the document's name (the
   * Scene tab's Project name, the names of rendered and exported files, WebDAV's messages) showed
   * 'Untitled', and with WebDAV alone the title and the local project list did too until the first
   * change (project.json was read only before a sync that could write it).
   */
  it('shows the stored name wherever the editor reads the name, before any change (WebDAV only)', async () => {
    const dav = memoryDav();
    withSyncServerAndWebDAV(dav, 'direct');
    serverConfig.value = null; // WebDAV only
    toasts.value = [];
    const info = { id: 'proj-shown', name: 'Stored name', created_at: '', updated_at: '', schema_version: 1 };
    dav.put('/projects/proj-shown/project.json', new TextEncoder().encode(JSON.stringify(info)));
    ProjectSession.remoteWaitMs = 200; // (nothing arrives: there is no document)
    const s = await ProjectSession.open('proj-shown');
    expect(s.title.value).toBe('Stored name');
    expect(s.doc.name).toBe('Stored name'); // the Scene tab, file names, messages
    expect(s.doc.toSnapshot().meta.name).toBe('Stored name');
    expect(s.projectInfo().name).toBe('Stored name');
    expect((await localIndex.get('proj-shown'))?.name).toBe('Stored name');
    expect(s.doc.ydoc.getMap('meta').has('name')).toBe(false); // nothing written into the document
    // stored with a change, then deleted on another device: the message names it
    s.doc.addObject({ type: 'EMPTY', name: 'First change' });
    await s.webdav!.syncNow();
    dav.remove('/projects/proj-shown/');
    await s.webdav!.syncNow();
    expect(toasts.value.map((t) => t.message)).toEqual([
      '"Stored name" was deleted from WebDAV on another device. This browser keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).',
    ]);
    s.doc.setName('Named here');
    expect(s.title.value).toBe('Named here');
    expect(s.projectInfo().name).toBe('Named here');
    await s.close(false);
  });

  /*
   * The name the server lists can arrive after opening wrote the project into the local project
   * list, with no change of the document to write it again (a slow answer): the list kept
   * 'Untitled'. Taking the stored name writes the list again.
   */
  it('writes the name the server lists into the local project list when it arrives after opening', async () => {
    withSyncServer();
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    vi.stubGlobal('fetch', async (url: string) => {
      if (!url.endsWith('/api/projects/proj-late')) return new Response(null, { status: 404 });
      await answered;
      return Response.json({ id: 'proj-late', name: 'Late name' });
    });
    const opening = ProjectSession.open('proj-late');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    // the server's document is empty: the first sync changes nothing
    FakeSocket.created[0].receive(
      encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep2(enc, new Y.Doc())),
    );
    const s = await opening;
    expect((await localIndex.get('proj-late'))?.name).toBe('Untitled');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      answer();
      await vi.waitFor(() => expect(s.title.value).toBe('Late name'));
      vi.advanceTimersByTime(3000); // the list is written 3 s after a change
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(async () => expect((await localIndex.get('proj-late'))?.name).toBe('Late name'));
    await s.close(false);
  });

  /*
   * The stored name is the document's name only while the document has none: an answer of the
   * server that arrives after the document got a name of its own (a rename here, or one that synced
   * in) is not taken.
   */
  it('takes no stored name that arrives after the document got a name of its own', async () => {
    withSyncServer();
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let asked = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (!url.endsWith('/api/projects/proj-named-meanwhile')) return new Response(null, { status: 404 });
      asked++;
      await answered;
      return Response.json({ id: 'proj-named-meanwhile', name: 'Stored name' });
    });
    const opening = ProjectSession.open('proj-named-meanwhile');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    FakeSocket.created[0].receive(
      encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep2(enc, new Y.Doc())),
    );
    const s = await opening;
    await vi.waitFor(() => expect(asked).toBe(1));
    s.doc.setName('Named here');
    answer();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.storedName.value).toBeNull();
    expect(s.title.value).toBe('Named here');
    await s.close(false);
  });

  it('shows the name the server lists in the Scene tab and the names of files', async () => {
    withSyncServer();
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/api/projects/proj-listed')
        ? Response.json({ id: 'proj-listed', name: 'Listed name' })
        : new Response(null, { status: 404 }),
    );
    const opening = ProjectSession.open('proj-listed');
    await vi.waitFor(() => expect(FakeSocket.created).toHaveLength(1));
    const remote = new SceneDoc(new Y.Doc());
    remote.addObject({ type: 'EMPTY', name: 'Made by an agent' });
    FakeSocket.created[0].receive(
      encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep2(enc, remote.ydoc)),
    );
    const s = await opening;
    await vi.waitFor(() => expect(s.doc.name).toBe('Listed name'));
    expect(s.doc.getMeta().name).toBe('Listed name');
    expect(s.doc.ydoc.getMap('meta').has('name')).toBe(false);
    await s.close(false);
    remote.destroy();
  });

  it('keeps the stored name in the project.json it writes to WebDAV', async () => {
    const dav = memoryDav();
    withSyncServerAndWebDAV(dav, 'direct');
    serverConfig.value = null; // WebDAV only
    const info = { id: 'proj-info', name: 'Stored name', created_at: '', updated_at: '', schema_version: 1 };
    dav.put('/projects/proj-info/project.json', new TextEncoder().encode(JSON.stringify(info)));
    ProjectSession.remoteWaitMs = 50; // (nothing arrives: there is no document)
    const s = await ProjectSession.open('proj-info');
    await s.webdav!.syncNow();
    // the first change: the sync that stores it reads project.json first
    s.doc.addObject({ type: 'EMPTY', name: 'First change' });
    await s.webdav!.syncNow();
    expect(s.title.value).toBe('Stored name');
    expect(dav.files.has('/projects/proj-info/document.ybin')).toBe(true);
    const written = JSON.parse(
      new TextDecoder().decode(dav.files.get('/projects/proj-info/project.json')!.data),
    );
    expect(written.name).toBe('Stored name');
    await s.close(false);
  });
});
