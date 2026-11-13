import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ZipError,
  bufferZipSource,
  fileZipSource,
  readZipEntries,
  readZipEntry,
  safeArchivePath,
} from '../../src/store/zip';
import { makeZip, tempDir } from './store-fixtures';

/* The model store's ZIP reader (Sketchfab archives), against archives written by the fixtures. */

const text = (s: string) => new TextEncoder().encode(s);
const big = (n: number) => text('glTF '.repeat(Math.ceil(n / 5)).slice(0, n));

async function entriesOf(zip: Uint8Array) {
  const src = bufferZipSource(zip);
  return { src, entries: await readZipEntries(src) };
}

/** The offset of the first central directory record of `zip`. */
function centralAt(zip: Uint8Array): number {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i + 4 <= zip.length; i++) if (dv.getUint32(i, true) === 0x02014b50) return i;
  throw new Error('no central directory');
}

async function zipError(p: Promise<unknown>): Promise<ZipError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ZipError);
    return err as ZipError;
  }
  throw new Error('resolved');
}

describe('readZipEntries / readZipEntry', () => {
  it('reads stored and deflated entries and their names', async () => {
    const files = [
      { name: 'scene/scene.gltf', data: text('{"asset":{"version":"2.0"}}') },
      { name: 'scene/textures/wood.png', data: big(5000), method: 0 as const },
      { name: 'scene/', data: new Uint8Array(0), method: 0 as const },
    ];
    const { src, entries } = await entriesOf(makeZip(files));
    expect(entries.map((e) => [e.name, e.method, e.directory])).toEqual([
      ['scene/scene.gltf', 8, false],
      ['scene/textures/wood.png', 0, false],
      ['scene/', 0, true],
    ]);
    expect(new TextDecoder().decode(await readZipEntry(src, entries[0]))).toBe('{"asset":{"version":"2.0"}}');
    expect(await readZipEntry(src, entries[1])).toEqual(files[1].data);
    // deflate really compressed the repeated text
    const deflated = (await entriesOf(makeZip([{ name: 'a.txt', data: big(5000) }]))).entries[0];
    expect(deflated.compressedSize).toBeLessThan(200);
  });

  it('reads ZIP64 end records', async () => {
    const { src, entries } = await entriesOf(
      makeZip(
        [
          { name: 'model.glb', data: big(300) },
          { name: 'b.bin', data: big(10) },
        ],
        { zip64: true },
      ),
    );
    expect(entries.map((e) => e.name)).toEqual(['model.glb', 'b.bin']);
    expect((await readZipEntry(src, entries[0])).length).toBe(300);
  });

  it('refuses damaged, encrypted, lying and unsupported entries', async () => {
    const crc = await entriesOf(makeZip([{ name: 'a.bin', data: big(100), crc: 1234 }]));
    expect((await zipError(readZipEntry(crc.src, crc.entries[0]))).message).toMatch(/CRC-32/);

    const enc = await entriesOf(makeZip([{ name: 'a.bin', data: big(100), encrypted: true }]));
    expect(enc.entries[0].encrypted).toBe(true);
    expect((await zipError(readZipEntry(enc.src, enc.entries[0]))).message).toMatch(/encrypted/);

    // an entry declaring less than it inflates to (an archive bomb) stops at the declared size
    const bomb = await entriesOf(makeZip([{ name: 'a.bin', data: big(100_000), size: 1000 }]));
    expect((await zipError(readZipEntry(bomb.src, bomb.entries[0]))).message).toMatch(
      /could not be inflated/,
    );
    const short = await entriesOf(makeZip([{ name: 'a.bin', data: big(100), size: 200 }]));
    expect((await zipError(readZipEntry(short.src, short.entries[0]))).message).toMatch(
      /not the size it declares/,
    );
    const stored = await entriesOf(makeZip([{ name: 'a.bin', data: big(100), size: 50, method: 0 }]));
    expect((await zipError(readZipEntry(stored.src, stored.entries[0]))).message).toMatch(
      /inconsistent sizes/,
    );

    const bzip = makeZip([{ name: 'a.bin', data: big(10), method: 0 }]);
    new DataView(bzip.buffer).setUint16(centralAt(bzip) + 10, 12, true);
    const b = await entriesOf(bzip);
    expect((await zipError(readZipEntry(b.src, b.entries[0]))).message).toMatch(/compression method 12/);
  });

  it('marks entries over the size limit as too large (not damaged)', async () => {
    const { src, entries } = await entriesOf(makeZip([{ name: 'a.bin', data: big(1000) }]));
    const err = await zipError(readZipEntry(src, entries[0], 999));
    expect(err.tooLarge).toBe(true);
    expect((await readZipEntry(src, entries[0], 1000)).length).toBe(1000);
  });

  it('refuses what is not a ZIP archive, truncated ones and too many entries', async () => {
    expect(
      (await zipError(readZipEntries(bufferZipSource(text('<html>not found</html>'.repeat(3)))))).message,
    ).toMatch(/no end of central directory/);
    expect((await zipError(readZipEntries(bufferZipSource(text('PK'))))).message).toMatch(/too short/);
    const zip = makeZip([
      { name: 'a', data: big(10) },
      { name: 'b', data: big(10) },
    ]);
    // the central directory cut off: its declared place lies outside the file
    const cut = zip.slice(centralAt(zip) + 10);
    await zipError(readZipEntries(bufferZipSource(cut)));
    await zipError(readZipEntries(bufferZipSource(zip), 1));
    // a central record pointing at no local header
    const bad = makeZip([{ name: 'a', data: big(10), method: 0 }]);
    new DataView(bad.buffer).setUint32(centralAt(bad) + 42, 5, true);
    const b = await entriesOf(bad);
    expect((await zipError(readZipEntry(b.src, b.entries[0]))).message).toMatch(/local header/);
  });

  describe('from a file', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await tempDir('store-zip-');
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reads entries with positional reads', async () => {
      const file = path.join(dir, 'a.zip');
      await writeFile(
        file,
        makeZip([
          { name: 'm/model.glb', data: big(70_000) },
          { name: 'm/x.bin', data: big(3) },
        ]),
      );
      const src = await fileZipSource(file);
      try {
        const entries = await readZipEntries(src);
        expect((await readZipEntry(src, entries[0])).length).toBe(70_000);
        expect(new TextDecoder().decode(await readZipEntry(src, entries[1]))).toBe('glT');
        await expect(src.read(src.size - 2, 10)).rejects.toBeInstanceOf(ZipError);
      } finally {
        await src.close();
      }
    });
  });
});

describe('safeArchivePath', () => {
  it('normalizes paths and rejects those leaving the archive', () => {
    expect(safeArchivePath('scene/./textures//wood.png')).toBe('scene/textures/wood.png');
    expect(safeArchivePath('scene\\textures\\wood.png')).toBe('scene/textures/wood.png');
    for (const bad of [
      '../x.bin',
      'a/../../x',
      '/etc/passwd',
      'C:/x.bin',
      'c:\\x',
      '__MACOSX/._a.png',
      '',
      '.',
      'a/\0b',
    ])
      expect(safeArchivePath(bad), bad).toBeNull();
  });
});
