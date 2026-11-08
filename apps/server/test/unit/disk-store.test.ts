import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreconditionFailedError, ProjectFileStore, SceneDoc } from '@3d-editor/core';
import { DiskFileStore, etagFor } from '../../src/persistence/disk';

let root: string;
let store: DiskFileStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'disk-store-'));
  store = new DiskFileStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

describe('DiskFileStore', () => {
  it('writes, reads and lists files with ETags', async () => {
    const { etag } = await store.write('/a/b/file.txt', bytes('hello'));
    expect(etag).toMatch(/^"5-[\d.]+"$/);
    const st = await stat(path.join(root, 'a', 'b', 'file.txt'));
    expect(etag).toBe(etagFor(st));
    const r = await store.read('/a/b/file.txt');
    expect(str(r!.data)).toBe('hello');
    expect(r!.etag).toBe(etag);
    expect(await store.read('/a/missing.txt')).toBeNull();
    const entries = await store.list('/a');
    expect(entries).toEqual([{ name: 'b', isDir: true }]);
    const files = await store.list('/a/b/');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'file.txt', isDir: false, size: 5, etag });
    expect(await store.list('/nope')).toEqual([]);
  });

  it('enforces If-None-Match: *', async () => {
    await store.write('/x.bin', bytes('1'), { ifNoneMatch: '*' });
    await expect(store.write('/x.bin', bytes('2'), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    expect(str((await store.read('/x.bin'))!.data)).toBe('1');
  });

  it('enforces If-Match and always produces a new ETag', async () => {
    const first = await store.write('/doc.bin', bytes('aaaa'));
    // same size, immediately: the ETag must still change
    const second = await store.write('/doc.bin', bytes('bbbb'), { ifMatch: first.etag });
    expect(second.etag).not.toBe(first.etag);
    await expect(store.write('/doc.bin', bytes('cccc'), { ifMatch: first.etag })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await expect(store.write('/missing.bin', bytes('x'), { ifMatch: '"1-2"' })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    const third = await store.write('/doc.bin', bytes('cccc'), { ifMatch: second.etag });
    expect(str((await store.read('/doc.bin'))!.data)).toBe('cccc');
    expect((await store.read('/doc.bin'))!.etag).toBe(third.etag);
  });

  it('reads the ETag of the content it read when a write replaces the file meanwhile', async () => {
    const first = await store.write('/doc.bin', bytes('aaaa'));
    let second: { etag?: string } | undefined;
    // a write lands right after the read opened (or read) the file, before it learnt its ETag
    const after = async () => {
      if (second) return;
      second = {};
      second = await store.write('/doc.bin', bytes('bbbbbbbb'));
    };
    const fsp = (await import('node:fs')).promises;
    const open = fsp.open.bind(fsp);
    const readFile = fsp.readFile.bind(fsp);
    const spies = [
      vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
        const fh = await open(...args);
        if (String(args[0]).endsWith('doc.bin') && (args[1] ?? 'r') === 'r') await after();
        return fh;
      }),
      vi.spyOn(fsp, 'readFile').mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
        const data = await readFile(...args);
        if (String(args[0]).endsWith('doc.bin')) await after();
        return data;
      }),
    ];
    try {
      const r = (await store.read('/doc.bin'))!;
      expect(second?.etag).toBeTruthy();
      // the content read and its ETag belong to the same version (one or the other)
      if (str(r.data) === 'aaaa') expect(r.etag).toBe(first.etag);
      else expect(r.etag).toBe(second!.etag);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('gives every version a later modification time than the one it replaces', async () => {
    // a version whose mtime is ahead of the clock (the clock went back, or writes came within one
    // tick and were nudged): its successors must still get later ones, or the ETag ("size-mtime")
    // of a version of the same size as an earlier one could repeat it, and an If-Match based on
    // that earlier version would be accepted
    const first = await store.write('/doc.bin', bytes('aaaa'));
    const ahead = new Date(Date.now() + 3_600_000);
    await utimes(path.join(root, 'doc.bin'), ahead, ahead);
    const mtimeOf = (etag?: string) => Number(etag!.slice(1, -1).split('-')[1]);
    const second = await store.write('/doc.bin', bytes('bbbbbbbb'), {
      ifMatch: etagFor(await stat(path.join(root, 'doc.bin'))),
    });
    const third = await store.write('/doc.bin', bytes('cccc'), { ifMatch: second.etag });
    expect(mtimeOf(second.etag)).toBeGreaterThan(ahead.getTime());
    expect(mtimeOf(third.etag)).toBeGreaterThan(mtimeOf(second.etag));
    expect(new Set([first.etag, second.etag, third.etag]).size).toBe(3);
    expect((await store.read('/doc.bin'))!.etag).toBe(third.etag);
    expect(await store.etag('/doc.bin')).toBe(third.etag);
    expect(await store.etag('/missing.bin')).toBeNull();
  });

  it('serializes concurrent conditional writes (exactly one wins)', async () => {
    const base = await store.write('/race.bin', bytes('0'));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        store.write('/race.bin', bytes(String(i + 1)), { ifMatch: base.etag }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => (r as PromiseRejectedResult).reason instanceof PreconditionFailedError),
    ).toBe(true);
  });

  it('writes atomically and hides temporary files', async () => {
    await store.write('/p/doc.ybin', bytes('data'));
    await writeFile(path.join(root, 'p', '.doc.ybin.0123456789ab.tmp'), 'partial');
    const names = (await store.list('/p')).map((e) => e.name);
    expect(names).toEqual(['doc.ybin']);
    const onDisk = await readdir(path.join(root, 'p'));
    expect(onDisk.filter((n) => n.endsWith('.tmp') && n !== '.doc.ybin.0123456789ab.tmp')).toEqual([]);
  });

  it('removes files and directories recursively', async () => {
    await store.write('/proj/a.txt', bytes('a'));
    await store.write('/proj/sub/b.txt', bytes('b'));
    await store.remove('/proj');
    expect(await store.list('/')).toEqual([]);
    await store.remove('/never-existed');
  });

  it('rejects paths escaping the root', async () => {
    expect(() => store.resolve('/../etc/passwd')).toThrow();
    expect(() => store.resolve('/a/../../x')).toThrow();
    await expect(store.write('/a/../../x', bytes('x'))).rejects.toThrow();
    await expect(store.remove('/')).rejects.toThrow();
    expect(store.resolve('/a/b')).toBe(path.join(root, 'a', 'b'));
  });

  it('works as a ProjectFileStore backend (CRDT merge saves)', async () => {
    const projects = new ProjectFileStore(store, '/');
    const scene = SceneDoc.create({ name: 'Disk test' });
    const id = 'proj-1';
    const first = await projects.syncDocument(id, scene.ydoc, {
      info: () => ({ id, name: 'Disk test', created_at: 'now', updated_at: 'now', schema_version: 1 }),
    });
    expect(first.pushed).toBe(true);
    // another writer (other server/device) changes the stored doc
    const other = new Y.Doc();
    Y.applyUpdate(other, (await projects.loadDocument(id))!.update);
    new SceneDoc(other).addObject({ type: 'EMPTY', name: 'Remote' });
    await store.write(projects.docPath(id), Y.encodeStateAsUpdate(other));
    // local change, then sync: both survive
    scene.addObject({ type: 'EMPTY', name: 'Local' });
    const second = await projects.syncDocument(id, scene.ydoc, { lastEtag: first.etag });
    expect(second.pulled).toBe(true);
    expect(second.pushed).toBe(true);
    const names = scene.listObjects().map((o) => o.name);
    expect(names).toContain('Remote');
    expect(names).toContain('Local');
    const listed = await projects.listProjects();
    expect(listed.map((p) => p.id)).toEqual([id]);
  });
});
