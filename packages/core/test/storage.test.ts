import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MemoryFileStore,
  MissingFolderError,
  ProjectFileStore,
  SceneDoc,
  parseMultistatus,
  updateAddsToState,
} from '../src';

describe('ProjectFileStore', () => {
  it('merge-syncs two replicas through a shared store without losing edits', async () => {
    const store = new ProjectFileStore(new MemoryFileStore(), '/3d');
    const a = SceneDoc.create({ name: 'Shared' });
    const info = () => ({
      id: 'p1',
      name: a.name,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: new Date().toISOString(),
      schema_version: 1,
    });
    const r1 = await store.syncDocument('p1', a.ydoc, { info });
    expect(r1.pushed).toBe(true);
    const b = new SceneDoc();
    const r2 = await store.syncDocument('p1', b.ydoc);
    expect(r2.pulled).toBe(true);
    expect(r2.pushed).toBe(false);
    expect(b.listObjects()).toHaveLength(3);
    // concurrent edits
    a.addObject({ type: 'EMPTY', name: 'FromA' });
    b.addObject({ type: 'EMPTY', name: 'FromB' });
    await store.syncDocument('p1', a.ydoc, { lastEtag: r1.etag });
    await store.syncDocument('p1', b.ydoc);
    await store.syncDocument('p1', a.ydoc);
    const names = (d: SceneDoc) =>
      d
        .listObjects()
        .map((o) => o.name)
        .sort();
    expect(names(a)).toEqual(names(b));
    expect(names(a)).toContain('FromA');
    expect(names(a)).toContain('FromB');
    const list = await store.listProjects();
    expect(list.map((p) => p.id)).toEqual(['p1']);
    await store.deleteProject('p1');
    expect(await store.listProjects()).toEqual([]);
  });

  it('detects pure deletions as changes', () => {
    const a = SceneDoc.create({ empty: true });
    const id = a.addObject({ type: 'EMPTY', name: 'X' });
    const before = Y.encodeStateAsUpdate(a.ydoc);
    a.removeObject(id);
    expect(updateAddsToState(before, Y.encodeStateAsUpdate(a.ydoc))).toBe(true);
    expect(updateAddsToState(Y.encodeStateAsUpdate(a.ydoc), before)).toBe(false);
  });

  it('rejects invalid project ids', () => {
    const store = new ProjectFileStore(new MemoryFileStore());
    expect(() => store.docPath('../etc')).toThrow();
  });

  /*
   * A failed listing used to list no projects: callers then took every project for deleted (the
   * editor server hid the projects it had loaded, and browsers showed no WebDAV error).
   */
  it('reports a failed listing instead of listing no projects', async () => {
    const fs = new MemoryFileStore();
    const store = new ProjectFileStore(fs, '/3d');
    expect(await store.listProjects()).toEqual([]); // no projects folder yet
    fs.list = async () => {
      throw new Error('storage offline');
    };
    await expect(store.listProjects()).rejects.toThrow('storage offline');
  });
});

describe('MemoryFileStore', () => {
  it('writes into a missing folder only when it may create folders', async () => {
    const fs = new MemoryFileStore();
    const data = new Uint8Array([1]);
    await expect(fs.write('/a/b/f', data, { createFolders: false })).rejects.toThrow(MissingFolderError);
    expect(await fs.read('/a/b/f')).toBeNull();
    expect(await fs.list('/a')).toEqual([]);
    await fs.write('/a/b/f', data); // creates them by default
    // a folder that holds a file exists, as does one made with mkdirp
    await fs.write('/a/b/g', data, { createFolders: false });
    await fs.mkdirp('/c');
    await fs.write('/c/f', data, { createFolders: false });
    await fs.remove('/a');
    await expect(fs.write('/a/b/f', data, { createFolders: false })).rejects.toThrow(MissingFolderError);
  });
});

describe('WebDAV multistatus parsing', () => {
  it('handles prefixes, collections and entities', () => {
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
 <D:response><D:href>/dav/projects/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
 <D:response><D:href>/dav/projects/a%20b&amp;c.json</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>42</D:getcontentlength><D:getetag>"abc"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    const r = parseMultistatus(xml);
    expect(r).toHaveLength(2);
    expect(r[0].isDir).toBe(true);
    expect(r[1]).toMatchObject({ href: '/dav/projects/a%20b&c.json', isDir: false, size: 42, etag: '"abc"' });
  });
});
