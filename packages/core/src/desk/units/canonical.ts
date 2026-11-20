import { bytesToHexLower, sha256Bytes } from '../container/digest';
import { UnitError } from './errors';

/*
 * Canonical JSON for unit bodies and headers: object keys sorted, undefined members left out, the
 * same text for equal values whatever their key order. Strict: a number that is not finite, a value
 * JSON cannot hold (a function, a symbol, a bigint) or a plain object that looks like a blob
 * reference ({"$blob": n}) is refused with UNIT_BAD_RECORD. Byte arrays go into a blob table when one
 * is given (written as {"$blob": index}; identical bytes share one index, in first-reference order),
 * are written as their length and SHA-256 ({"$bytes": "<length>:<sha256>"}) for 'digest' (part
 * stamps), and are refused otherwise.
 */

/** The blobs of a body: each distinct byte array once, in first-reference order. */
export class BlobTable {
  readonly list: Uint8Array[] = [];
  private readonly index = new Map<string, number>();
  bytes = 0;

  /** The index of `bytes` (added when new). */
  add(bytes: Uint8Array): number {
    const key = `${bytes.length}:${bytesToHexLower(sha256Bytes(bytes))}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(bytes);
      this.index.set(key, i);
      this.bytes += bytes.length;
    }
    return i;
  }
}

/** Whether a plain object is shaped like a blob reference ({"$blob": …} and nothing else). */
export function isBlobRef(v: unknown): v is { $blob: number } {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Uint8Array) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === '$blob';
}

/** What byte arrays become: blob references, a digest of their bytes, or a refusal (null). */
export type BytesMode = BlobTable | 'digest' | null;

function write(v: unknown, out: string[], blobs: BytesMode, path: string): void {
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'string':
      out.push(JSON.stringify(v));
      return;
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(v))
        throw new UnitError('UNIT_BAD_RECORD', `${path || 'a value'} is not a finite number`);
      out.push(JSON.stringify(v));
      return;
    case 'object':
      break;
    default:
      throw new UnitError('UNIT_BAD_RECORD', `${path || 'a value'} is not JSON (${typeof v})`);
  }
  if (v instanceof Uint8Array) {
    if (!blobs) throw new UnitError('UNIT_BAD_RECORD', `${path || 'a value'} holds bytes where none may be`);
    if (blobs === 'digest') out.push(`{"$bytes":"${v.length}:${bytesToHexLower(sha256Bytes(v))}"}`);
    else out.push(`{"$blob":${blobs.add(v)}}`);
    return;
  }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)
    throw new UnitError('UNIT_BAD_RECORD', `${path || 'a value'} is a binary value other than a byte array`);
  if (Array.isArray(v)) {
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i) out.push(',');
      const x = v[i];
      if (x === undefined) out.push('null');
      else write(x, out, blobs, `${path}[${i}]`);
    }
    out.push(']');
    return;
  }
  if (isBlobRef(v))
    throw new UnitError('UNIT_BAD_RECORD', `${path || 'a value'} is shaped like a blob reference`);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  out.push('{');
  keys.forEach((k, i) => {
    if (i) out.push(',');
    out.push(JSON.stringify(k), ':');
    write(o[k], out, blobs, path ? `${path}.${k}` : k);
  });
  out.push('}');
}

/** The canonical JSON text of `v` (see above); byte arrays go into `blobs` when given. */
export function canonicalJsonStrict(v: unknown, blobs: BytesMode = null): string {
  const out: string[] = [];
  write(v, out, blobs, '');
  return out.join('');
}

/** A number rounded to 1e-4 (headers: engines whose trigonometry differs in the last ulp agree). */
export function round4(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
}
