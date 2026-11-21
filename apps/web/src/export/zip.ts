/*
 * ZIP archives of stored (not compressed) files: the frames of the lossless passes (PNG files,
 * compressed already) as the export writes them, entry after entry, and every file of an export for
 * one download, made of the files' Blobs without copying them. ZIP64 records are added where sizes
 * or offsets pass 4 GiB (or the archive holds more than 65,535 entries). Names are UTF-8.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO-HDLC, as ZIP and PNG use), updated with more bytes: start with 0. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const U32 = 0xffffffff;
const U16 = 0xffff;

/** MS-DOS date and time of a date (local time, 2-second resolution; 1980 at the earliest). */
export function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

/** A stored entry: its name, size, CRC-32 and where its local header starts. */
interface Entry {
  name: Uint8Array;
  size: number;
  crc: number;
  offset: number;
}

const encoder = new TextEncoder();

function localHeader(e: Entry, when: { date: number; time: number }): Uint8Array {
  const zip64 = e.size >= U32;
  const extra = zip64 ? 20 : 0;
  const out = new Uint8Array(30 + e.name.length + extra);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, zip64 ? 45 : 20, true);
  v.setUint16(6, 0x0800, true); // UTF-8 names
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, when.time, true);
  v.setUint16(12, when.date, true);
  v.setUint32(14, e.crc, true);
  v.setUint32(18, zip64 ? U32 : e.size, true);
  v.setUint32(22, zip64 ? U32 : e.size, true);
  v.setUint16(26, e.name.length, true);
  v.setUint16(28, extra, true);
  out.set(e.name, 30);
  if (zip64) {
    const o = 30 + e.name.length;
    v.setUint16(o, 0x0001, true);
    v.setUint16(o + 2, 16, true);
    v.setBigUint64(o + 4, BigInt(e.size), true);
    v.setBigUint64(o + 12, BigInt(e.size), true);
  }
  return out;
}

function centralHeader(e: Entry, when: { date: number; time: number }): Uint8Array {
  const bigSize = e.size >= U32;
  const bigOffset = e.offset >= U32;
  const extra = bigSize || bigOffset ? 4 + (bigSize ? 16 : 0) + (bigOffset ? 8 : 0) : 0;
  const out = new Uint8Array(46 + e.name.length + extra);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, (3 << 8) | 45, true); // made by Unix, ZIP 4.5
  v.setUint16(6, extra ? 45 : 20, true);
  v.setUint16(8, 0x0800, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, when.time, true);
  v.setUint16(14, when.date, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, bigSize ? U32 : e.size, true);
  v.setUint32(24, bigSize ? U32 : e.size, true);
  v.setUint16(28, e.name.length, true);
  v.setUint16(30, extra, true);
  v.setUint16(32, 0, true); // comment
  v.setUint16(34, 0, true); // disk
  v.setUint16(36, 0, true); // internal attributes
  v.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, rw-r--r--
  v.setUint32(42, bigOffset ? U32 : e.offset, true);
  out.set(e.name, 46);
  if (extra) {
    let o = 46 + e.name.length;
    v.setUint16(o, 0x0001, true);
    v.setUint16(o + 2, extra - 4, true);
    o += 4;
    if (bigSize) {
      v.setBigUint64(o, BigInt(e.size), true);
      v.setBigUint64(o + 8, BigInt(e.size), true);
      o += 16;
    }
    if (bigOffset) v.setBigUint64(o, BigInt(e.offset), true);
  }
  return out;
}

/** The central directory and end records of entries, the directory starting at `offset`. */
function directory(
  entries: readonly Entry[],
  offset: number,
  when: { date: number; time: number },
): Uint8Array[] {
  const parts = entries.map((e) => centralHeader(e, when));
  const size = parts.reduce((n, p) => n + p.length, 0);
  const zip64 =
    entries.length >= U16 ||
    offset >= U32 ||
    size >= U32 ||
    entries.some((e) => e.size >= U32 || e.offset >= U32);
  if (zip64) {
    const rec = new Uint8Array(56);
    const v = new DataView(rec.buffer);
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, 44n, true);
    v.setUint16(12, (3 << 8) | 45, true);
    v.setUint16(14, 45, true);
    v.setUint32(16, 0, true);
    v.setUint32(20, 0, true);
    v.setBigUint64(24, BigInt(entries.length), true);
    v.setBigUint64(32, BigInt(entries.length), true);
    v.setBigUint64(40, BigInt(size), true);
    v.setBigUint64(48, BigInt(offset), true);
    const loc = new Uint8Array(20);
    const lv = new DataView(loc.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setUint32(4, 0, true);
    lv.setBigUint64(8, BigInt(offset + size), true);
    lv.setUint32(16, 1, true);
    parts.push(rec, loc);
  }
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, Math.min(entries.length, U16), true);
  v.setUint16(10, Math.min(entries.length, U16), true);
  v.setUint32(12, Math.min(size, U32), true);
  v.setUint32(16, zip64 ? U32 : offset, true);
  parts.push(end);
  return parts;
}

/**
 * A ZIP archive written entry after entry (stored) through `write`: each entry's bytes are known
 * when it is added, so no data descriptors are needed and the archive is written front to back.
 */
export class ZipStreamWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private readonly when: { date: number; time: number };
  private finished = false;

  constructor(
    private readonly write: (chunk: Uint8Array) => Promise<void>,
    date: Date = new Date(),
  ) {
    this.when = dosDateTime(date);
  }

  /** Entries added so far. */
  get count(): number {
    return this.entries.length;
  }

  /** Adds a file (stored as it is). */
  async add(name: string, bytes: Uint8Array): Promise<void> {
    if (this.finished) throw new Error('the archive is finished');
    const e: Entry = {
      name: encoder.encode(name),
      size: bytes.length,
      crc: crc32Update(0, bytes),
      offset: this.offset,
    };
    const header = localHeader(e, this.when);
    await this.write(header);
    await this.write(bytes);
    this.offset += header.length + bytes.length;
    this.entries.push(e);
  }

  /** Writes the central directory: the archive is complete. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    for (const p of directory(this.entries, this.offset, this.when)) await this.write(p);
  }
}

/** A file of a one-download archive: its Blob, size and CRC-32 (known: the export computed them). */
export interface ZipBlobEntry {
  name: string;
  blob: Blob;
  size: number;
  crc32: number;
}

/**
 * A ZIP archive of these files as one Blob: headers between the files' own Blobs (which Blob
 * composition does not copy: a file the export kept on disk stays there until it is read).
 */
export function zipBlob(files: readonly ZipBlobEntry[], date: Date = new Date()): Blob {
  const when = dosDateTime(date);
  const parts: BlobPart[] = [];
  const entries: Entry[] = [];
  let offset = 0;
  for (const f of files) {
    const e: Entry = { name: encoder.encode(f.name), size: f.size, crc: f.crc32 >>> 0, offset };
    const header = localHeader(e, when);
    parts.push(header as Uint8Array<ArrayBuffer>, f.blob);
    offset += header.length + f.size;
    entries.push(e);
  }
  for (const p of directory(entries, offset, when)) parts.push(p as Uint8Array<ArrayBuffer>);
  return new Blob(parts, { type: 'application/zip' });
}
