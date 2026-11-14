import * as Y from 'yjs';
import type { SceneDoc } from '@3d-editor/core';
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
 *   header       UTF-8 JSON: {sceneId, lineage, shots, savedAt, deskVersion, updateBytes}
 *   payload      the scene's Yjs document (Y.encodeStateAsUpdate), gzipped where the browser has
 *                CompressionStream
 *
 * The header is read without the payload, so a state of another scene or lineage is recognized
 * before it is unpacked. `lineage` names the staging the document comes from (written into the
 * document when the brief is staged): the desk merges a state with its local copy only when both
 * have the same lineage (they are the same Yjs history); otherwise the state replaces the copy.
 */

/** The container's first bytes. */
export const STATE_MAGIC = new Uint8Array([0x33, 0x44, 0x44, 0x45, 0x53, 0x4b, 0x0d, 0x0a]); // "3DDESK\r\n"
export const CONTAINER_VERSION = 1;
const PREFIX_BYTES = 16;
/** Largest header (JSON) a state may have. */
const MAX_HEADER_BYTES = 64 * 1024;

/** The document's meta key holding the lineage of its staging. */
export const LINEAGE_KEY = 'desk_lineage';

export interface StateHeader {
  /** The host's scene id. */
  sceneId: string;
  /** The staging the document comes from (see LINEAGE_KEY). */
  lineage: string;
  /** Shots of the document. */
  shots: number;
  savedAt: string;
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

/** Why a state cannot be written: its data would be over 64 MiB. */
export class StateTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(
      `The desk state would be ${(bytes / 1024 / 1024).toFixed(1)} MiB, over the ${MAX_STATE_BYTES / 1024 / 1024} MiB a state may have`,
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

/** Whether this browser compresses with gzip streams. */
export function gzipAvailable(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function streamThrough(bytes: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }) {
  const writer = stream.writable.getWriter();
  // a failure (bytes that do not unpack) rejects the read below; the writer's side is let go
  writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => undefined);
  const out = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(out);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return streamThrough(bytes, new CompressionStream('gzip'));
}

async function gunzip(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const out = await streamThrough(bytes, new DecompressionStream('gzip'));
  if (out.length > limit) throw new StateUnreadable('the desk state unpacks to more than it says');
  return out;
}

/**
 * Packs a document's update into a desk state (gzipped where the browser can). Throws
 * StateTooLarge when the data would be over 64 MiB.
 */
export async function encodeDeskState(
  update: Uint8Array,
  header: Omit<StateHeader, 'updateBytes'>,
  opts: { compress?: boolean } = {},
): Promise<DeskState> {
  const codec: Codec = opts.compress === false || !gzipAvailable() ? null : 'gzip';
  const payload = codec === 'gzip' ? await gzip(update) : update;
  const headerBytes = new TextEncoder().encode(JSON.stringify({ ...header, updateBytes: update.length }));
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
export function readStateHeader(bytes: Uint8Array): { header: StateHeader; codec: Codec; payload: Uint8Array } {
  if (bytes.length < PREFIX_BYTES || STATE_MAGIC.some((b, i) => bytes[i] !== b))
    throw new StateUnreadable('the desk state is not one this desk wrote');
  if (bytes[8] !== CONTAINER_VERSION)
    throw new StateUnreadable(`the desk state's container is version ${bytes[8]}, this desk reads ${CONTAINER_VERSION}`);
  if (bytes[9] !== 0 && bytes[9] !== 1) throw new StateUnreadable('the desk state is compressed in an unknown way');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  if (headerLength > MAX_HEADER_BYTES || PREFIX_BYTES + headerLength > bytes.length)
    throw new StateUnreadable('the desk state is cut short');
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(16, 16 + headerLength)));
  } catch {
    throw new StateUnreadable("the desk state's header does not read");
  }
  if (!isHeader(header)) throw new StateUnreadable("the desk state's header lacks its scene or lineage");
  return { header, codec: bytes[9] === 1 ? 'gzip' : null, payload: bytes.subarray(PREFIX_BYTES + headerLength) };
}

/**
 * A state a host gave back, read for scene `sceneId`: its header and the document's update. Throws
 * StateUnreadable (with the reason) for another format or version, data this desk did not write,
 * another scene's state, or one whose update does not read.
 */
export async function decodeDeskState(
  state: GivenState,
  sceneId: string,
): Promise<{ header: StateHeader; update: Uint8Array }> {
  if (state.format !== DESK_STATE_FORMAT)
    throw new StateUnreadable(`the desk state's format is '${state.format}', not '${DESK_STATE_FORMAT}'`);
  if (state.version !== DESK_STATE_VERSION)
    throw new StateUnreadable(`the desk state is version ${state.version}; this desk reads ${DESK_STATE_VERSION}`);
  const bytes = stateBytes(state);
  if (bytes.length > MAX_STATE_BYTES) throw new StateUnreadable('the desk state is over 64 MiB');
  const { header, codec, payload } = readStateHeader(bytes);
  if (header.sceneId !== sceneId)
    throw new StateUnreadable(`the desk state belongs to scene '${header.sceneId}', not '${sceneId}'`);
  let update: Uint8Array;
  if (codec === 'gzip') {
    if (!gzipAvailable()) throw new StateUnreadable('this browser cannot unpack the desk state (no gzip streams)');
    try {
      update = await gunzip(payload, header.updateBytes);
    } catch (err) {
      if (err instanceof StateUnreadable) throw err;
      throw new StateUnreadable('the desk state does not unpack');
    }
  } else update = payload.slice();
  if (update.length !== header.updateBytes) throw new StateUnreadable('the desk state is cut short');
  // the update must read as a Yjs document of this scene before it touches the local copy
  try {
    const probe = new Y.Doc();
    Y.applyUpdate(probe, update);
    probe.destroy();
  } catch {
    throw new StateUnreadable("the desk state's scene does not read");
  }
  return { header, update };
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
  if (state) return local.staged && local.lineage !== null && local.lineage === state.lineage ? 'merge' : 'replace';
  return local.staged ? 'local' : 'stage';
}
