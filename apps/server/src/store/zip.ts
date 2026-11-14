import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';

/*
 * A small ZIP reader for the model store (Sketchfab delivers glTF models as ZIP archives): the
 * central directory (with ZIP64 records), stored and deflated entries (node:zlib inflateRaw), CRC-32
 * checks, and limits against archive bombs (entry count, the declared size of every entry and of all
 * of them; inflating stops at the declared size). Encrypted entries and other compression methods
 * are refused. Paths are normalized and those leaving the archive ('..', absolute) are rejected.
 */

const inflate = promisify(inflateRaw) as (
  buf: Uint8Array,
  opts: { maxOutputLength: number },
) => Promise<Buffer>;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Most entries an archive may list. */
export const MAX_ZIP_ENTRIES = 10_000;

export class ZipError extends Error {
  constructor(
    message: string,
    /** An entry is larger than the size limit (not a damaged archive). */
    readonly tooLarge = false,
  ) {
    super(`ZIP archive: ${message}`);
    this.name = 'ZipError';
  }
}

/** Random access to the bytes of an archive. */
export interface ZipSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** An archive held in memory. */
export function bufferZipSource(data: Uint8Array): ZipSource {
  return {
    size: data.byteLength,
    read: async (offset, length) => {
      if (offset < 0 || offset + length > data.byteLength) throw new ZipError('truncated');
      return data.subarray(offset, offset + length);
    },
  };
}

/** An archive file on disk (positional reads; close it when done). */
export async function fileZipSource(path: string): Promise<ZipSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    read: async (offset, length) => {
      if (offset < 0 || offset + length > size) throw new ZipError('truncated');
      const buf = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(buf, done, length - done, offset + done);
        if (bytesRead === 0) throw new ZipError('truncated');
        done += bytesRead;
      }
      return buf;
    },
    close: () => handle.close(),
  };
}

export interface ZipEntry {
  /** The path as stored (forward slashes). */
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  /** Offset of the local header. */
  offset: number;
  encrypted: boolean;
  directory: boolean;
}

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}
function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}
function u64(b: Uint8Array, at: number): number {
  const lo = u32(b, at);
  const hi = u32(b, at + 4);
  if (hi >= 0x200000) throw new ZipError('a 64-bit size or offset is too large');
  return hi * 0x100000000 + lo;
}

/** Reads the central directory (every entry, in archive order). */
export async function readZipEntries(src: ZipSource, maxEntries = MAX_ZIP_ENTRIES): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipError('too short');
  // the end of central directory record is in the last 22 + 65535 (comment) bytes
  const tailSize = Math.min(src.size, 22 + 0xffff);
  const tailStart = src.size - tailSize;
  const tail = await src.read(tailStart, tailSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (u32(tail, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ZipError('no end of central directory (not a ZIP file?)');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the locator sits right before the end record
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== SIG_EOCD64_LOCATOR) throw new ZipError('ZIP64 locator missing');
    const recOffset = u64(tail, loc + 8);
    const rec = await src.read(recOffset, 56);
    if (u32(rec, 0) !== SIG_EOCD64) throw new ZipError('ZIP64 end record missing');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (count > maxEntries) throw new ZipError(`${count} entries (at most ${maxEntries})`);
  if (cdOffset + cdSize > src.size) throw new ZipError('the central directory lies outside the file');
  const cd = await src.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let at = 0;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (let n = 0; n < count; n++) {
    if (at + 46 > cd.length || u32(cd, at) !== SIG_CENTRAL) throw new ZipError('damaged central directory');
    const flags = u16(cd, at + 8);
    const method = u16(cd, at + 10);
    const crc = u32(cd, at + 16);
    let compressedSize = u32(cd, at + 20);
    let size = u32(cd, at + 24);
    const nameLen = u16(cd, at + 28);
    const extraLen = u16(cd, at + 30);
    const commentLen = u16(cd, at + 32);
    let offset = u32(cd, at + 42);
    if (at + 46 + nameLen + extraLen + commentLen > cd.length)
      throw new ZipError('damaged central directory');
    const name = decoder.decode(cd.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, '/');
    // ZIP64 extended information: the 64-bit values of the fields that hold 0xFFFFFFFF, in order
    let x = at + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (id === 0x0001) {
        let p = x + 4;
        if (size === 0xffffffff) {
          size = u64(cd, p);
          p += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(cd, p);
          p += 8;
        }
        if (offset === 0xffffffff) offset = u64(cd, p);
      }
      x += 4 + len;
    }
    entries.push({
      name,
      method,
      compressedSize,
      size,
      crc32: crc,
      offset,
      encrypted: (flags & 1) !== 0,
      directory: name.endsWith('/'),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * The bytes of `entry` (inflated), checked against its declared size and CRC-32. `maxBytes` caps
 * the declared size (the remaining budget of the whole archive).
 */
export async function readZipEntry(
  src: ZipSource,
  entry: ZipEntry,
  maxBytes = Infinity,
): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError(`'${entry.name}' is encrypted`);
  if (entry.method !== 0 && entry.method !== 8)
    throw new ZipError(`'${entry.name}' uses compression method ${entry.method} (only stored and deflated)`);
  if (entry.size > maxBytes) throw new ZipError(`'${entry.name}' is larger than the size limit`, true);
  const header = await src.read(entry.offset, 30);
  if (u32(header, 0) !== SIG_LOCAL) throw new ZipError(`damaged local header of '${entry.name}'`);
  const start = entry.offset + 30 + u16(header, 26) + u16(header, 28);
  if (start + entry.compressedSize > src.size) throw new ZipError(`'${entry.name}' lies outside the file`);
  const raw = await src.read(start, entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new ZipError(`'${entry.name}' has inconsistent sizes`);
    data = raw;
  } else {
    try {
      // one byte more than declared: a bigger output means the size lied (an archive bomb)
      data = await inflate(raw, { maxOutputLength: Math.max(1, entry.size + 1) });
    } catch (err) {
      throw new ZipError(
        `'${entry.name}' could not be inflated (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (data.byteLength !== entry.size) throw new ZipError(`'${entry.name}' is not the size it declares`);
  if (crc32(data) >>> 0 !== entry.crc32) throw new ZipError(`'${entry.name}' fails its CRC-32 check`);
  return data;
}

/**
 * `name` as a safe relative path (no '..', no absolute or drive paths, no empty segments), or null.
 * macOS resource forks (__MACOSX/) are dropped too.
 */
export function safeArchivePath(name: string): string | null {
  const parts: string[] = [];
  for (const seg of name.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' || /^[a-zA-Z]:$/.test(seg) || seg.includes('\0')) return null;
    parts.push(seg);
  }
  if (name.startsWith('/') || parts.length === 0 || parts[0] === '__MACOSX') return null;
  return parts.join('/');
}
