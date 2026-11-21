import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  EXPORTS_DIRECTORY,
  FileHash,
  MemoryStore,
  OpfsStore,
  sweepExportDirectories,
  type FileInfo,
} from '../src/export/store';
import { ZipStreamWriter, crc32Update, dosDateTime, zipBlob } from '../src/export/zip';
import { zipExport, type BrowserExportFile, type BrowserExportResult } from '../src/export';
import { readZip } from './export-files';

/*
 * Where a browser export's files go: hashes computed while they are written (SHA-256 and CRC-32,
 * chunk by chunk), the in-memory store and its release, the sweep of the export directories no
 * export holds (a fake Origin Private File System and Web Locks), ZIP archives written entry by
 * entry (the frame archives) and made of Blobs (the one-download archive), ZIP64 records past
 * 65,535 entries.
 */

const enc = new TextEncoder();
const info = (name: string): FileInfo => ({
  name,
  kind: 'poster',
  pass: null,
  shot: null,
  mime: 'image/png',
  frames: null,
  duration_s: null,
});
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('file hashes', () => {
  it('computes CRC-32 (ISO-HDLC) and SHA-256 incrementally', () => {
    expect(crc32Update(0, enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32Update(crc32Update(0, enc.encode('1234')), enc.encode('56789'))).toBe(0xcbf43926);
    const h = new FileHash();
    h.update(enc.encode('hello '));
    h.update(enc.encode('world'));
    const d = h.digest();
    expect(d.size).toBe(11);
    expect(d.sha256).toBe(bytesToHex(sha256(enc.encode('hello world'))));
    expect(d.sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    expect(d.crc32).toBe(crc32Update(0, enc.encode('hello world')));
  });
});

describe('memory store', () => {
  it('keeps files written at once or chunk by chunk, with their hashes, until the export is released', async () => {
    const store = new MemoryStore();
    const a = await store.bytes(info('a.png'), enc.encode('abc'));
    expect(a).toMatchObject({ name: 'a.png', size: 3, sha256: bytesToHex(sha256(enc.encode('abc'))) });
    expect(new TextDecoder().decode(await bytes(await a.blob()))).toBe('abc');
    const f = await store.sequential(info('b.bin'));
    const chunk = enc.encode('xy');
    await f.write(chunk);
    // the writer may reuse its buffer: the store copied it
    chunk.set(enc.encode('zz'));
    await f.write(chunk);
    const b = await f.close();
    expect(new TextDecoder().decode(await bytes(await b.blob()))).toBe('xyzz');
    expect(b.size).toBe(4);
    expect(b.crc32).toBe(crc32Update(0, enc.encode('xyzz')));
    expect(await store.randomAccess()).toBeNull();
    // released with the export: the store lets its Blobs go, and the files cannot be read any more
    const blob = await a.blob();
    await store.dispose();
    await expect(a.blob()).rejects.toThrow('a.png was released with its export');
    await expect(b.blob()).rejects.toThrow('b.bin was released with its export');
    // a Blob read before (an object URL's, say) is the caller's to keep
    expect(new TextDecoder().decode(await bytes(blob))).toBe('abc');
  });
});

/** A directory of a fake Origin Private File System (names only; files are directories too here). */
class FakeDirectory {
  readonly entries = new Map<string, FakeDirectory>();
  /** Runs before a listing yields its first name (what another page does meanwhile). */
  beforeList: (() => Promise<void>) | null = null;
  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FakeDirectory> {
    let d = this.entries.get(name);
    if (!d) {
      if (!o?.create) throw Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' });
      d = new FakeDirectory();
      this.entries.set(name, d);
    }
    return d;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name))
      throw Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' });
  }
  async *keys(): AsyncIterable<string> {
    const before = this.beforeList;
    this.beforeList = null;
    await before?.();
    for (const name of [...this.entries.keys()]) yield name;
  }
}

/** Web Locks of the pages of one origin: exclusive, granted in order, `ifAvailable` answered at once. */
class FakeLocks {
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();
  async request(
    name: string,
    a: LockOptions | ((lock: Lock | null) => Promise<unknown>),
    b?: (lock: Lock | null) => Promise<unknown>,
  ): Promise<unknown> {
    const options = typeof a === 'function' ? {} : a;
    const callback = (typeof a === 'function' ? a : b)!;
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((r) => this.waiting.set(name, [...(this.waiting.get(name) ?? []), r]));
    } else this.held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' } as Lock);
    } finally {
      const next = this.waiting.get(name)?.shift();
      if (next) next();
      else this.held.delete(name);
    }
  }
  async query(): Promise<LockManagerSnapshot> {
    return { held: [...this.held].map((name) => ({ name, mode: 'exclusive' })), pending: [] };
  }
}

describe('export directories in the Origin Private File System', () => {
  const root = new FakeDirectory();
  let locks: FakeLocks | undefined;
  const page = (withLocks: boolean) => {
    root.entries.clear();
    locks = withLocks ? new FakeLocks() : undefined;
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks });
    vi.stubGlobal(
      'FileSystemFileHandle',
      class {
        createWritable() {}
      },
    );
  };
  afterEach(() => void vi.unstubAllGlobals());
  /** Another page's export holding its directory's lock until the returned function is called. */
  const otherPage = async (id: string) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await new Promise<void>((taken) => void locks!.request(`3d-editor-export:${id}`, () => (taken(), held)));
    await (
      await root.getDirectoryHandle(EXPORTS_DIRECTORY, { create: true })
    ).getDirectoryHandle(id, {
      create: true,
    });
    return release;
  };

  it('deletes only the directories no export holds, also one that starts while the sweep lists', async () => {
    page(true);
    const exports = await root.getDirectoryHandle(EXPORTS_DIRECTORY, { create: true });
    await exports.getDirectoryHandle('old-closed-tab', { create: true });
    const releaseOther = await otherPage('other-tab');
    // an export of this page that opens its store after the sweep began, before it lists
    let opened: OpfsStore | null = null;
    exports.beforeList = async () => void (opened = await OpfsStore.open('starting-now'));
    await sweepExportDirectories();
    expect(opened).not.toBeNull();
    expect([...exports.entries.keys()].sort()).toEqual(['other-tab', 'starting-now']);
    // the export writes its files; once released, its directory goes, and the other tab's once it ends
    await opened!.dispose();
    expect([...exports.entries.keys()]).toEqual(['other-tab']);
    releaseOther();
    await sweepExportDirectories();
    expect([...exports.entries.keys()]).toEqual([]);
  });

  it('keeps directories younger than a day where the browser has no Web Locks', async () => {
    page(false);
    const exports = await root.getDirectoryHandle(EXPORTS_DIRECTORY, { create: true });
    const name = (ageMs: number) => `${(Date.now() - ageMs).toString(36)}-x`;
    const young = name(3600_000);
    const old = name(25 * 3600_000);
    await exports.getDirectoryHandle(young, { create: true });
    await exports.getDirectoryHandle(old, { create: true });
    await sweepExportDirectories();
    expect([...exports.entries.keys()]).toEqual([young]);
  });
});

describe('ZIP archives', () => {
  it('writes MS-DOS times', () => {
    expect(dosDateTime(new Date(2026, 10, 14, 10, 30, 15))).toEqual({
      date: (46 << 9) | (11 << 5) | 14,
      time: (10 << 11) | (30 << 5) | 7,
    });
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });

  it('writes entries one after another that other readers read back', async () => {
    const parts: Uint8Array[] = [];
    const zip = new ZipStreamWriter(async (c) => void parts.push(c.slice()), new Date(2026, 10, 14));
    await zip.add('frame-000001.png', enc.encode('one'));
    await zip.add('frame-000002.png', new Uint8Array(0));
    await zip.add('ünïcode.txt', enc.encode('ü'));
    expect(zip.count).toBe(3);
    await zip.finish();
    await expect(zip.add('late', new Uint8Array(1))).rejects.toThrow(/finished/);
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const read = unzipSync(all);
    expect(Object.keys(read)).toEqual(['frame-000001.png', 'frame-000002.png', 'ünïcode.txt']);
    expect(new TextDecoder().decode(read['frame-000001.png'])).toBe('one');
    expect(read['frame-000002.png'].length).toBe(0);
    expect(readZip(all).map((e) => [e.name, e.crc])).toEqual([
      ['frame-000001.png', crc32Update(0, enc.encode('one'))],
      ['frame-000002.png', 0],
      ['ünïcode.txt', crc32Update(0, enc.encode('ü'))],
    ]);
  });

  it('adds ZIP64 end records to an archive of more than 65,534 entries', async () => {
    const parts: Uint8Array[] = [];
    const zip = new ZipStreamWriter(async (c) => void parts.push(c));
    const n = 65_536;
    const empty = new Uint8Array(0);
    for (let i = 0; i < n; i++) await zip.add(`f${i}`, empty);
    await zip.finish();
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const v = new DataView(all.buffer);
    // the classic end record says "see ZIP64"; the ZIP64 record has the count
    expect(v.getUint16(all.length - 22 + 10, true)).toBe(0xffff);
    expect(v.getUint32(all.length - 22 - 20, true)).toBe(0x07064b50);
    const entries = readZip(all);
    expect(entries).toHaveLength(n);
    expect(entries[n - 1].name).toBe(`f${n - 1}`);
  });

  it('makes one archive of Blobs, and of an export result (its files read once each)', async () => {
    const blob = zipBlob([
      { name: 'a.txt', blob: new Blob(['aaa']), size: 3, crc32: crc32Update(0, enc.encode('aaa')) },
      { name: 'b.txt', blob: new Blob(['bb']), size: 2, crc32: crc32Update(0, enc.encode('bb')) },
    ]);
    expect(blob.type).toBe('application/zip');
    const read = unzipSync(await bytes(blob));
    expect(new TextDecoder().decode(read['b.txt'])).toBe('bb');

    const file = (name: string, text: string): BrowserExportFile => ({
      name,
      kind: 'manifest',
      pass: null,
      shot: null,
      mime: 'text/plain',
      size: text.length,
      sha256: '',
      frames: null,
      duration_s: null,
      blob: async () => new Blob([text]),
    });
    const result: BrowserExportResult = {
      id: 'x',
      files: [file('one.txt', 'first'), file('two.txt', 'second')],
      manifest: {},
      shots: [],
      warnings: [],
    };
    const archive = readZip(await bytes(await zipExport(result)));
    expect(archive.map((e) => [e.name, new TextDecoder().decode(e.data), e.crc])).toEqual([
      ['one.txt', 'first', crc32Update(0, enc.encode('first'))],
      ['two.txt', 'second', crc32Update(0, enc.encode('second'))],
    ]);
  });
});
