import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FileHash, MemoryStore, type FileInfo } from '../src/export/store';
import { ZipStreamWriter, crc32Update, dosDateTime, zipBlob } from '../src/export/zip';
import { zipExport, type BrowserExportFile, type BrowserExportResult } from '../src/export';
import { readZip } from './export-files';

/*
 * Where a browser export's files go: hashes computed while they are written (SHA-256 and CRC-32,
 * chunk by chunk), the in-memory store, ZIP archives written entry by entry (the frame archives)
 * and made of Blobs (the one-download archive), ZIP64 records past 65,535 entries.
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
  it('keeps files written at once or chunk by chunk, with their hashes', async () => {
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
