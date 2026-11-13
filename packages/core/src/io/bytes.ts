/*
 * Small isomorphic helpers for binary and text file formats (no Node `Buffer`, no DOM).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Decodes UTF-8 text, dropping a leading byte-order mark. */
export function utf8Decode(bytes: Uint8Array): string {
  const s = decoder.decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Decodes bytes as Latin-1 (one char per byte; used for headers that are ASCII by spec). */
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  const e = Math.min(end, bytes.length);
  for (let i = start; i < e; i += 0x4000)
    s += String.fromCharCode(...bytes.subarray(i, Math.min(e, i + 0x4000)));
  return s;
}

/** Growable little-endian byte buffer. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(capacity = 4096) {
    this.buf = new Uint8Array(Math.max(16, capacity));
    this.view = new DataView(this.buf.buffer);
  }

  private reserve(n: number): void {
    const need = this.length + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.reserve(1);
    this.buf[this.length++] = v;
  }

  u16(v: number): void {
    this.reserve(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }

  u32(v: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
  }

  i32(v: number): void {
    this.reserve(4);
    this.view.setInt32(this.length, v, true);
    this.length += 4;
  }

  f32(v: number): void {
    this.reserve(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
  }

  bytes(b: Uint8Array): void {
    this.reserve(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  ascii(s: string): void {
    this.reserve(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.length++] = s.charCodeAt(i) & 0xff;
  }

  /** Pads with `fill` up to a multiple of `align` bytes. */
  pad(align: number, fill = 0): void {
    while (this.length % align) this.u8(fill);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Formats a number for text formats: fixed decimals, trailing zeros trimmed, no `-0`. */
export function fmtNum(n: number, decimals = 6): string {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(decimals);
  if (s.indexOf('.') >= 0) {
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 48) end--;
    if (s.charCodeAt(end - 1) === 46) end--;
    s = s.slice(0, end);
  }
  return s === '-0' ? '0' : s;
}

/** Calls `fn` for each line (without the line terminator). */
export function forEachLine(text: string, fn: (line: string, lineNo: number) => void): void {
  const len = text.length;
  let start = 0;
  let n = 0;
  while (start < len) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = len;
    const stop = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    fn(text.slice(start, stop), ++n);
    start = end + 1;
  }
}

/** Splits a line on ASCII whitespace into `out` (reused); returns the token count. */
export function splitWs(line: string, out: string[]): number {
  let n = 0;
  const len = line.length;
  let i = 0;
  while (i < len) {
    while (i < len && isWs(line.charCodeAt(i))) i++;
    if (i >= len) break;
    const s = i;
    while (i < len && !isWs(line.charCodeAt(i))) i++;
    out[n++] = line.slice(s, i);
  }
  return n;
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 11 || c === 12;
}

/** Text after the first whitespace-delimited token (trimmed). */
export function restOfLine(line: string): string {
  const t = line.trim();
  const m = /\s/.exec(t);
  return m ? t.slice(m.index).trim() : '';
}

/** Finds a companion file by path, then by case-insensitive base name. */
export function lookupFile(files: Record<string, Uint8Array> | undefined, ref: string): Uint8Array | null {
  if (!files) return null;
  let path = ref.trim();
  try {
    path = decodeURIComponent(path);
  } catch {}
  path = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (files[path]) return files[path];
  const base = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const want = base(path);
  for (const [k, v] of Object.entries(files)) if (base(k) === want) return v;
  return null;
}

/** File name without directories or extension. */
export function baseName(path: string): string {
  const b = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}
