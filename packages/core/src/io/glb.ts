import { utf8Decode, utf8Encode } from './bytes';

/*
 * GLB binary container: 12-byte header (magic "glTF", version 2, total length), a JSON chunk padded
 * with spaces and an optional BIN chunk padded with zeros; every chunk is 4-byte aligned.
 */

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const CHUNK_JSON = 0x4e4f534a; // "JSON"
export const CHUNK_BIN = 0x004e4942; // "BIN\0"

export function isGLB(data: Uint8Array): boolean {
  return data.length >= 12 && data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46;
}

function padded(len: number): number {
  return (len + 3) & ~3;
}

export function writeGLB(json: unknown, bin: Uint8Array | null): Uint8Array {
  const jsonBytes = utf8Encode(JSON.stringify(json));
  const jsonLen = padded(jsonBytes.length);
  const binLen = bin && bin.length ? padded(bin.length) : 0;
  const total = 12 + 8 + jsonLen + (binLen ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  if (binLen && bin) {
    const o = 20 + jsonLen;
    dv.setUint32(o, binLen, true);
    dv.setUint32(o + 4, CHUNK_BIN, true);
    out.set(bin, o + 8); // zero padding is already in place
  }
  return out;
}

export function readGLB(data: Uint8Array): { json: any; bin: Uint8Array | null } {
  if (!isGLB(data)) throw new Error('Not a GLB file (bad magic)');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported GLB version ${version}`);
  const length = Math.min(dv.getUint32(8, true), data.length);
  let o = 12;
  let json: any = null;
  let bin: Uint8Array | null = null;
  while (o + 8 <= length) {
    const chunkLen = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const start = o + 8;
    const end = start + chunkLen;
    if (end > length) throw new Error('GLB chunk exceeds file length');
    if (type === CHUNK_JSON && json === null) json = JSON.parse(utf8Decode(data.subarray(start, end)));
    else if (type === CHUNK_BIN && bin === null) bin = data.subarray(start, end);
    o = padded(end);
  }
  if (json === null) throw new Error('GLB file has no JSON chunk');
  return { json, bin };
}
