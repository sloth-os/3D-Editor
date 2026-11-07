import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { MSG_SYNC, SceneDoc, encodeFrame } from '@3d-editor/core';
import { ProjectSession } from '../src/project/session';
import { localIndex } from '../src/project/local-index';
import { serverConfig } from '../src/app/store';
import { prefs, defaultPreferences } from '../src/app/prefs';

/** A WebSocket that never connects; the test plays the sync server through `receive`. */
class FakeSocket {
  static readonly OPEN = 1;
  static created: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
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
    expect(events).toEqual(['GET /3d-editor/projects/proj-dav/document.ybin', 'opened with 3 objects']);
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
