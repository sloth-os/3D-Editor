import * as Y from 'yjs';
import { Gunzip } from 'fflate';
import { SceneDoc, briefRecord } from '@3d-editor/core';
import {
  DESK_STATE_FORMAT,
  DESK_STATE_VERSION,
  MAX_STATE_BYTES,
  stateBytes,
  type DeskState,
  type GivenState,
} from './protocol';

/*
 * The desk state (docs/embedding.md, "The desk state"): the opaque bytes a host stores for a scene
 * and gives back in the next `open` (format '3d-editor.desk-state', version 1, at most 64 MiB). Its
 * data is this desk's own container:
 *
 *   bytes 0–7    magic "3DDESK\r\n"
 *   byte  8      container version (1)
 *   byte  9      compression of the payload: 0 none, 1 gzip
 *   bytes 10–11  0
 *   bytes 12–15  header length (uint32, little-endian)
 *   header       UTF-8 JSON: {sceneId, lineage, shots, deskVersion, updateBytes}
 *   payload      the scene's Yjs document (Y.encodeStateAsUpdate), gzipped where the browser has
 *                CompressionStream
 *
 * - The header is read without the payload, so a state of another scene is recognized before it
 *   is unpacked. `lineage` names the staging the document comes from (written into the document
 *   when the brief is staged): the desk merges a state with its local copy only when both have the
 *   same lineage (they are the same Yjs history); otherwise the state replaces the copy.
 * - The same document gives the same bytes: the header holds no time and its keys come in one
 *   order, and the gzip header's time, level and system bytes are written as zeros and "unknown"
 *   (a host that de-duplicates states by their digest stores nothing new for an unchanged scene;
 *   the workspace also sends the very bytes it opened from, or sent last, while nothing changed).
 * - Every desk reads what any desk writes: a gzipped payload unpacks with DecompressionStream, or
 *   with fflate where the browser has none (it then writes its own states uncompressed).
 * - Unpacking is bounded: the payload goes in 4 KiB slices and the output is copied, as it comes,
 *   into one buffer of the header's `updateBytes` (itself at most 256 MiB); past that it stops and
 *   the state does not read. A small state cannot make the page unpack more than it says, and
 *   unpacking holds that buffer and what one slice unpacks to (≤ ~4 MiB; fflate also keeps its
 *   working copy of it, ≤ ~8 MiB), never the pieces of the whole document beside it.
 * - A state reads only when its document holds a staging of its scene (a probe document is made
 *   from it before anything touches the local copy).
 */

/** The container's first bytes. */
export const STATE_MAGIC = new Uint8Array([0x33, 0x44, 0x44, 0x45, 0x53, 0x4b, 0x0d, 0x0a]); // "3DDESK\r\n"
export const CONTAINER_VERSION = 1;
const PREFIX_BYTES = 16;
/** Largest header (JSON) a state may have. */
export const MAX_HEADER_BYTES = 64 * 1024;
/** Largest document (the Yjs update, unpacked) a state may hold: 256 MiB. */
export const MAX_UPDATE_BYTES = 256 * 1024 * 1024;
/**
 * Packed bytes handed to DecompressionStream at a time: a write unpacks in full before the next
 * goes in, and Chromium queues all it gives at once (gzip unpacks at most ~1032 times: ≤ ~4 MiB).
 */
const INFLATE_SLICE = 4 * 1024;
/** Packed bytes handed to the JS inflate at a time (≤ ~4 MiB of output per push). */
const JS_INFLATE_SLICE = 4 * 1024;
/** The header's keys, in the order the desk writes them. */
export const STATE_HEADER_KEYS = ['sceneId', 'lineage', 'shots', 'deskVersion', 'updateBytes'] as const;

/** The document's meta key holding the lineage of its staging. */
export const LINEAGE_KEY = 'desk_lineage';

export interface StateHeader {
  /** The host's scene id. */
  sceneId: string;
  /** The staging the document comes from (see LINEAGE_KEY). */
  lineage: string;
  /** Shots of the document. */
  shots: number;
  /** The desk that wrote the state (a state of an older desk may also carry `savedAt`: not read). */
  deskVersion: string;
  /** Bytes of the Yjs update before compression. */
  updateBytes: number;
}

/** Why a state cannot be applied (the desk then reports state_unreadable). */
export class StateUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateUnreadable';
  }
}

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Why a state cannot be written: its data would be over 64 MiB, or the scene's document over the
 * 256 MiB a state may unpack to.
 */
export class StateTooLarge extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number = MAX_STATE_BYTES,
  ) {
    super(
      limit === MAX_STATE_BYTES
        ? `The desk state would be ${mib(bytes)} MiB, over the ${MAX_STATE_BYTES / 1024 / 1024} MiB a state may have`
        : `The scene's document is ${mib(bytes)} MiB, over the ${limit / 1024 / 1024} MiB a desk state may hold`,
    );
    this.name = 'StateTooLarge';
  }
}

/** The lineage of a document's staging (null: not staged by a desk). */
export function readLineage(doc: SceneDoc): string | null {
  const v = doc.map('meta').get(LINEAGE_KEY);
  return typeof v === 'string' && v ? v : null;
}

/** Writes the lineage of a document's staging (inside the caller's transaction). */
export function writeLineage(doc: SceneDoc, lineage: string): void {
  doc.map('meta').set(LINEAGE_KEY, lineage);
}

/** A new lineage id. */
export function newLineage(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

type Codec = 'gzip' | null;

/** Whether this browser writes gzipped states (CompressionStream). Every desk reads them. */
export function compressesStates(): boolean {
  return typeof CompressionStream === 'function';
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  // a failure rejects the read below; the writer's side is let go
  writer
    .write(bytes as Uint8Array<ArrayBuffer>)
    .then(() => writer.close())
    .catch(() => undefined);
  const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  // the same bytes on every system: no time (4–7), no level hint (8), system "unknown" (9); only
  // a header without optional fields (FLG 0, as CompressionStream writes it) is touched
  if (out.length >= 10 && out[3] === 0) {
    out.fill(0, 4, 9);
    out[9] = 255;
  }
  return out;
}

let crcTable: Uint32Array | null = null;

/** `crc` (a running CRC-32, gzip's: CRC_START at first, xor CRC_START at the end) with `data` added. */
function crc32(crc: number, data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const t = crcTable;
  for (let i = 0; i < data.length; i++) crc = t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}
const CRC_START = 0xffffffff;

/**
 * The unpacked bytes of a payload, copied as they come into one buffer of `limit` bytes (the size
 * the header claims, made with the first bytes) and refused once they would pass it: no piece is
 * kept once copied. With `sumCrc`, the CRC-32 of the bytes is summed as they are copied.
 */
class Unpacked {
  private buffer: Uint8Array | null = null;
  total = 0;
  private sum = CRC_START;

  constructor(
    private readonly limit: number,
    private readonly sumCrc = false,
  ) {}

  add(chunk: Uint8Array): void {
    if (!chunk.length) return;
    if (this.total + chunk.length > this.limit)
      throw new StateUnreadable('the desk state unpacks to more than it says');
    if (!this.buffer) {
      try {
        this.buffer = new Uint8Array(this.limit);
      } catch {
        throw new StateUnreadable(
          `the desk state unpacks to ${mib(this.limit)} MiB, more than this browser can hold`,
        );
      }
    }
    this.buffer.set(chunk, this.total);
    if (this.sumCrc) this.sum = crc32(this.sum, chunk);
    this.total += chunk.length;
  }

  /** The CRC-32 of the bytes (with `sumCrc`). */
  get checksum(): number {
    return (this.sum ^ CRC_START) >>> 0;
  }

  bytes(): Uint8Array {
    return this.buffer ? this.buffer.subarray(0, this.total) : new Uint8Array(0);
  }
}

/** Unpacks with DecompressionStream: written in slices, read and copied as it comes. */
async function gunzipStream(payload: Uint8Array, out: Unpacked): Promise<void> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // one write unpacks in full before the next goes in (the stream waits for the reads below)
  const feed = (async () => {
    for (let at = 0; at < payload.length; at += INFLATE_SLICE) {
      await writer.ready;
      await writer.write(payload.subarray(at, at + INFLATE_SLICE) as Uint8Array<ArrayBuffer>);
    }
    await writer.close();
  })();
  feed.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.add(value as Uint8Array);
    }
    await feed;
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    await writer.abort().catch(() => undefined);
    if (err instanceof StateUnreadable) throw err;
    throw new StateUnreadable('the desk state does not unpack');
  }
}

/**
 * Unpacks with fflate where the browser has no DecompressionStream: pushed in slices and copied as
 * it comes; one gzip member only, its CRC-32 (summed while copying) and size checked (fflate's
 * stream does not). `out` sums the CRC-32.
 */
function gunzipJs(payload: Uint8Array, out: Unpacked): void {
  // a gzip member has a 10-byte header and an 8-byte trailer at least
  if (payload.length < 18) throw new StateUnreadable('the desk state does not unpack');
  let members = 1;
  const g = new Gunzip((chunk) => out.add(chunk));
  g.onmember = () => members++;
  try {
    for (let at = 0; at < payload.length; at += JS_INFLATE_SLICE) {
      const end = Math.min(payload.length, at + JS_INFLATE_SLICE);
      g.push(payload.subarray(at, end), end === payload.length);
    }
  } catch (err) {
    if (err instanceof StateUnreadable) throw err;
    throw new StateUnreadable('the desk state does not unpack');
  }
  const t = payload.subarray(payload.length - 8);
  const crc = (t[0] | (t[1] << 8) | (t[2] << 16) | (t[3] << 24)) >>> 0;
  const size = (t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24)) >>> 0;
  if (members > 1 || size !== out.total >>> 0 || crc !== out.checksum)
    throw new StateUnreadable('the desk state does not unpack');
}

/** A gzipped payload unpacked to at most `limit` bytes (StateUnreadable past it, or for bad data). */
async function gunzip(payload: Uint8Array, limit: number): Promise<Uint8Array> {
  // DecompressionStream checks the CRC-32 itself; the JS unpacking sums it while it copies
  const stream = typeof DecompressionStream === 'function';
  const out = new Unpacked(limit, !stream);
  if (stream) await gunzipStream(payload, out);
  else gunzipJs(payload, out);
  return out.bytes();
}

/**
 * Packs a document's update into a desk state (gzipped where the browser can): the same update and
 * header give the same bytes. Throws StateTooLarge when the update is over 256 MiB or the data
 * would be over 64 MiB.
 */
export async function encodeDeskState(
  update: Uint8Array,
  header: Omit<StateHeader, 'updateBytes'>,
  opts: { compress?: boolean } = {},
): Promise<DeskState> {
  if (update.length > MAX_UPDATE_BYTES) throw new StateTooLarge(update.length, MAX_UPDATE_BYTES);
  const codec: Codec = opts.compress === false || !compressesStates() ? null : 'gzip';
  const payload = codec === 'gzip' ? await gzip(update) : update;
  // the header's keys in one order (STATE_HEADER_KEYS), and nothing else
  const h: StateHeader = {
    sceneId: header.sceneId,
    lineage: header.lineage,
    shots: header.shots,
    deskVersion: header.deskVersion,
    updateBytes: update.length,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(h));
  const total = PREFIX_BYTES + headerBytes.length + payload.length;
  if (total > MAX_STATE_BYTES) throw new StateTooLarge(total);
  const out = new Uint8Array(total);
  out.set(STATE_MAGIC, 0);
  out[8] = CONTAINER_VERSION;
  out[9] = codec === 'gzip' ? 1 : 0;
  new DataView(out.buffer).setUint32(12, headerBytes.length, true);
  out.set(headerBytes, PREFIX_BYTES);
  out.set(payload, PREFIX_BYTES + headerBytes.length);
  return { format: DESK_STATE_FORMAT, version: DESK_STATE_VERSION, data: out.buffer };
}

function isHeader(v: unknown): v is StateHeader {
  const h = v as StateHeader;
  return (
    !!h &&
    typeof h === 'object' &&
    typeof h.sceneId === 'string' &&
    typeof h.lineage === 'string' &&
    h.lineage.length > 0 &&
    typeof h.updateBytes === 'number' &&
    Number.isInteger(h.updateBytes) &&
    h.updateBytes >= 0
  );
}

/** The header of a state's data, without its payload; throws StateUnreadable. */
export function readStateHeader(bytes: Uint8Array): {
  header: StateHeader;
  codec: Codec;
  payload: Uint8Array;
} {
  if (bytes.length < PREFIX_BYTES || STATE_MAGIC.some((b, i) => bytes[i] !== b))
    throw new StateUnreadable('the desk state is not one this desk wrote');
  if (bytes[8] !== CONTAINER_VERSION)
    throw new StateUnreadable(
      `the desk state's container is version ${bytes[8]}, this desk reads ${CONTAINER_VERSION}`,
    );
  if (bytes[9] !== 0 && bytes[9] !== 1)
    throw new StateUnreadable('the desk state is compressed in an unknown way');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  if (headerLength > MAX_HEADER_BYTES)
    throw new StateUnreadable(`the desk state's header is over ${MAX_HEADER_BYTES / 1024} KiB`);
  if (PREFIX_BYTES + headerLength > bytes.length) throw new StateUnreadable('the desk state is cut short');
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(16, 16 + headerLength)),
    );
  } catch {
    throw new StateUnreadable("the desk state's header does not read");
  }
  if (!isHeader(header)) throw new StateUnreadable("the desk state's header lacks its scene or lineage");
  if (header.updateBytes > MAX_UPDATE_BYTES)
    throw new StateUnreadable(
      `the desk state says it unpacks to ${mib(header.updateBytes)} MiB, over the ${MAX_UPDATE_BYTES / 1024 / 1024} MiB a state may hold`,
    );
  return {
    header,
    codec: bytes[9] === 1 ? 'gzip' : null,
    payload: bytes.subarray(PREFIX_BYTES + headerLength),
  };
}

/** A state read for a scene (decodeDeskState). */
export interface DecodedState {
  header: StateHeader;
  /** The scene's document (a Yjs update). */
  update: Uint8Array;
  /** The lineage of the document's staging. */
  lineage: string;
  /** What the document holds (its state vector and deletions), to tell whether another equals it. */
  snapshot: Y.Snapshot;
}

/**
 * A state a host gave back, read for scene `sceneId`: its header and the document's update. Throws
 * StateUnreadable (with the reason) for another format or version, data this desk did not write,
 * another scene's state, one that does not unpack (or unpacks to more than it says), one whose
 * update does not read, or one whose document holds no staging of the scene.
 */
export async function decodeDeskState(state: GivenState, sceneId: string): Promise<DecodedState> {
  if (state.format !== DESK_STATE_FORMAT)
    throw new StateUnreadable(`the desk state's format is '${state.format}', not '${DESK_STATE_FORMAT}'`);
  if (state.version !== DESK_STATE_VERSION)
    throw new StateUnreadable(
      `the desk state is version ${state.version}; this desk reads ${DESK_STATE_VERSION}`,
    );
  const bytes = stateBytes(state);
  if (bytes.length > MAX_STATE_BYTES) throw new StateUnreadable('the desk state is over 64 MiB');
  const { header, codec, payload } = readStateHeader(bytes);
  if (header.sceneId !== sceneId)
    throw new StateUnreadable(`the desk state belongs to scene '${header.sceneId}', not '${sceneId}'`);
  let update: Uint8Array;
  if (codec === 'gzip') update = await gunzip(payload, header.updateBytes);
  else if (payload.length > header.updateBytes)
    throw new StateUnreadable('the desk state unpacks to more than it says');
  else update = payload.slice();
  if (update.length !== header.updateBytes) throw new StateUnreadable('the desk state is cut short');
  // the update must read as a document holding a staging of this scene before it touches the
  // local copy
  let probe: SceneDoc;
  try {
    probe = SceneDoc.fromUpdate(update);
  } catch {
    throw new StateUnreadable("the desk state's scene does not read");
  }
  try {
    if (briefRecord(probe)?.sceneId !== sceneId)
      throw new StateUnreadable('the desk state holds no staging of this scene');
    const lineage = readLineage(probe);
    if (lineage !== null && lineage !== header.lineage)
      throw new StateUnreadable("the desk state's header does not match its scene");
    return { header, update, lineage: lineage ?? header.lineage, snapshot: Y.snapshot(probe.ydoc) };
  } finally {
    probe.destroy();
    probe.ydoc.destroy();
  }
}

/** How the desk opens a scene from a host's state and its local copy (docs/embedding.md: the merge rule). */
export type RestorePlan =
  /** The state and the local copy come from the same staging: the state is merged into the copy. */
  | 'merge'
  /** The state replaces the local copy (another staging, or none here). */
  | 'replace'
  /** No state to apply: the local copy as it is. */
  | 'local'
  /** Nothing of the scene here, and no state: the brief is staged. */
  | 'stage';

/**
 * The merge rule: a readable state merges with a local copy of the same scene from the same
 * staging (equal lineage); any other readable state replaces the local copy; without one the local
 * copy is used when it holds a staging of the scene, else the brief is staged.
 */
export function restorePlan(
  state: { lineage: string } | null,
  local: { staged: boolean; lineage: string | null },
): RestorePlan {
  if (state)
    return local.staged && local.lineage !== null && local.lineage === state.lineage ? 'merge' : 'replace';
  return local.staged ? 'local' : 'stage';
}
