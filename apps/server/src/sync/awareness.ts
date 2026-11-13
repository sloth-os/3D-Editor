import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { randomInt } from 'node:crypto';

/** One client entry of a y-protocols awareness update. */
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  /** null marks the client as gone. */
  state: Record<string, unknown> | null;
}

/**
 * Encodes awareness entries in the y-protocols wire format (used to publish presence for
 * server-side clients such as MCP agents, which do not own a Y.Doc of their own).
 */
export function encodeAwarenessEntries(entries: AwarenessEntry[]): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(enc, e.clientId);
    encoding.writeVarUint(enc, e.clock);
    encoding.writeVarString(enc, JSON.stringify(e.state));
  }
  return encoding.toUint8Array(enc);
}

export function decodeAwarenessEntries(update: Uint8Array): AwarenessEntry[] {
  const dec = decoding.createDecoder(update);
  const n = decoding.readVarUint(dec);
  const out: AwarenessEntry[] = [];
  for (let i = 0; i < n; i++) {
    const clientId = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    const state = JSON.parse(decoding.readVarString(dec)) as Record<string, unknown> | null;
    out.push({ clientId, clock, state });
  }
  return out;
}

/** Random awareness client id (same 32-bit space as Y.Doc client ids). */
export function randomClientId(): number {
  return randomInt(1, 0xffffffff);
}
