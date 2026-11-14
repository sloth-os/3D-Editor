import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { crc32Update } from './zip';

/*
 * Where the files of a browser export are kept: in the Origin Private File System when the browser
 * has it (a directory per export, written as the export goes, so long sequences and frame archives
 * do not stay in memory; the files' Blobs are read from disk when they are downloaded), else in
 * memory. Every file gets its size, SHA-256 and CRC-32 (the one-download zip needs it) while it is
 * written, chunk after chunk; a video written out of order (an MP4 sequence whose index is written
 * last, at the start of the file) is read back once when it is finished. Cancelling deletes what
 * an export wrote. An export's directory lives until the page releases the export (or another
 * page of the origin starts an export after this one ended without releasing it: export
 * directories nobody holds a Web Lock for are deleted then).
 */

/** The kinds of files of a browser export. */
export type BrowserFileKind =
  'sequence' | 'clip' | 'poster' | 'still' | 'contact_sheet' | 'manifest' | 'frames';

/** What an export file is, besides its bytes. */
export interface FileInfo {
  name: string;
  kind: BrowserFileKind;
  /** The pass of a video or frame archive (beauty, depth …), else null. */
  pass: string | null;
  /** The desk shot id of a shot's file ('range' for a frame range export), else null. */
  shot: string | null;
  mime: string;
  frames: number | null;
  duration_s: number | null;
}

/** A finished file of an export. */
export interface StoredFile extends FileInfo {
  size: number;
  sha256: string;
  crc32: number;
  blob(): Promise<Blob>;
}

/** SHA-256 and CRC-32 of bytes given chunk after chunk. */
export class FileHash {
  private readonly h = sha256.create();
  private crc = 0;
  size = 0;

  update(chunk: Uint8Array): void {
    this.h.update(chunk);
    this.crc = crc32Update(this.crc, chunk);
    this.size += chunk.length;
  }

  digest(): { sha256: string; crc32: number; size: number } {
    return { sha256: bytesToHex(this.h.digest()), crc32: this.crc >>> 0, size: this.size };
  }
}

/** A file written front to back (hashed as it goes). */
export interface SequentialFile {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<StoredFile>;
  /** Drops what was written (the export failed or was cancelled). */
  abort(): Promise<void>;
}

/** The chunks mediabunny's StreamTarget writes (a position each). */
export interface PositionedChunk {
  type: 'write';
  data: Uint8Array;
  position: number;
}

/** A file written at positions (a video whose index goes at its start once it is finished). */
export interface RandomAccessFile {
  /** Where mediabunny writes (its StreamTarget's stream). */
  readonly writable: WritableStream<PositionedChunk>;
  /** The finished file, read back once for its hashes (the stream must be closed: mediabunny closes it). */
  close(): Promise<StoredFile>;
}

export interface ExportStore {
  /** True when files go to disk (the Origin Private File System). */
  readonly onDisk: boolean;
  /** A file of these bytes. */
  bytes(info: FileInfo, data: Uint8Array): Promise<StoredFile>;
  /** A file written front to back. */
  sequential(info: FileInfo): Promise<SequentialFile>;
  /** A file written at positions; null when files stay in memory (mediabunny then keeps the video). */
  randomAccess(info: FileInfo): Promise<RandomAccessFile | null>;
  /** Deletes every file of the export (it failed or was cancelled, or it is released). */
  dispose(): Promise<void>;
}

function stored(
  info: FileInfo,
  d: { sha256: string; crc32: number; size: number },
  blob: () => Promise<Blob>,
): StoredFile {
  return { ...info, size: d.size, sha256: d.sha256, crc32: d.crc32, blob };
}

/** Files kept in memory (Blobs of their chunks). */
export class MemoryStore implements ExportStore {
  readonly onDisk = false;

  async bytes(info: FileInfo, data: Uint8Array): Promise<StoredFile> {
    const h = new FileHash();
    h.update(data);
    const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: info.mime });
    return stored(info, h.digest(), async () => blob);
  }

  async sequential(info: FileInfo): Promise<SequentialFile> {
    const h = new FileHash();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    return {
      write: async (chunk) => {
        h.update(chunk);
        // the caller may reuse its buffer
        chunks.push(chunk.slice() as Uint8Array<ArrayBuffer>);
      },
      close: async () => {
        const blob = new Blob(chunks, { type: info.mime });
        chunks.length = 0;
        return stored(info, h.digest(), async () => blob);
      },
      abort: async () => {
        chunks.length = 0;
      },
    };
  }

  async randomAccess(): Promise<null> {
    return null;
  }

  async dispose(): Promise<void> {}
}

/** The directory of the browser exports in the Origin Private File System. */
export const EXPORTS_DIRECTORY = '3d-editor-exports';
/** The Web Lock an export holds while its directory is in use. */
const lockName = (id: string) => `3d-editor-export:${id}`;
/** Export directories older than this are deleted when the browser has no Web Locks to tell. */
const STALE_MS = 24 * 3600 * 1000;

/** Whether this page can keep export files in the Origin Private File System. */
export function opfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable === 'function'
  );
}

/** Holds the Web Lock of an export until the returned function is called (nothing without Web Locks). */
async function holdLock(id: string): Promise<() => void> {
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) return () => {};
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await new Promise<void>((acquired) => {
    void locks.request(lockName(id), () => {
      acquired();
      return held;
    });
  });
  return release;
}

/**
 * Deletes the export directories of this origin nobody uses any more: those whose Web Lock no page
 * holds (without Web Locks: those older than a day, by their name's time).
 */
export async function sweepExportDirectories(keep: ReadonlySet<string> = new Set()): Promise<void> {
  if (!opfsAvailable()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(EXPORTS_DIRECTORY, { create: true });
    const locks = (navigator as { locks?: LockManager }).locks;
    const held = new Set<string>();
    if (locks) for (const l of (await locks.query()).held ?? []) if (l.name) held.add(l.name);
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) {
      if (keep.has(name) || held.has(lockName(name))) continue;
      if (!locks) {
        const t = parseInt(name.split('-')[0] ?? '', 36);
        if (Number.isFinite(t) && Date.now() - t < STALE_MS) continue;
      }
      await dir.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
  } catch {
    // nothing to sweep, or the storage refused: nothing to do
  }
}

/** Files of an export in its own directory of the Origin Private File System. */
export class OpfsStore implements ExportStore {
  readonly onDisk = true;
  private disposed = false;

  private constructor(
    private readonly parent: FileSystemDirectoryHandle,
    private readonly dir: FileSystemDirectoryHandle,
    readonly id: string,
    private readonly unlock: () => void,
  ) {}

  /** The store of export `id` (its directory created, its Web Lock held). */
  static async open(id: string): Promise<OpfsStore> {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle(EXPORTS_DIRECTORY, { create: true });
    const unlock = await holdLock(id);
    try {
      const dir = await parent.getDirectoryHandle(id, { create: true });
      return new OpfsStore(parent, dir, id, unlock);
    } catch (err) {
      unlock();
      throw err;
    }
  }

  private async handle(name: string): Promise<FileSystemFileHandle> {
    if (this.disposed) throw new Error('the export was cancelled');
    return this.dir.getFileHandle(name, { create: true });
  }

  private reader(handle: FileSystemFileHandle, mime: string): () => Promise<Blob> {
    return async () => {
      const f = await handle.getFile();
      return f.type === mime ? f : new Blob([f], { type: mime });
    };
  }

  async bytes(info: FileInfo, data: Uint8Array): Promise<StoredFile> {
    const f = await this.sequential(info);
    await f.write(data);
    return f.close();
  }

  async sequential(info: FileInfo): Promise<SequentialFile> {
    const handle = await this.handle(info.name);
    const w = await handle.createWritable();
    const h = new FileHash();
    return {
      write: async (chunk) => {
        h.update(chunk);
        await w.write(chunk as Uint8Array<ArrayBuffer>);
      },
      close: async () => {
        await w.close();
        return stored(info, h.digest(), this.reader(handle, info.mime));
      },
      abort: async () => {
        await w.abort().catch(() => undefined);
      },
    };
  }

  async randomAccess(info: FileInfo): Promise<RandomAccessFile> {
    const handle = await this.handle(info.name);
    const writable = (await handle.createWritable()) as unknown as WritableStream<PositionedChunk>;
    return {
      writable,
      close: async () => {
        // read back once: the index was written last, at the start of the file
        const h = new FileHash();
        const reader = (await handle.getFile()).stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          h.update(value);
        }
        return stored(info, h.digest(), this.reader(handle, info.mime));
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.parent.removeEntry(this.id, { recursive: true });
    } catch {
      // an open writable keeps a file busy on some browsers: the next sweep deletes it
    } finally {
      this.unlock();
    }
  }
}
