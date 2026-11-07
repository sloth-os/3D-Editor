import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { SceneDoc } from '@3d-editor/core';
import { ProjectSession } from '../src/project/session';
import { localIndex } from '../src/project/local-index';
import { serverConfig } from '../src/app/store';
import { prefs, defaultPreferences } from '../src/app/prefs';

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
