import { Gunzip, gzipSync } from 'fflate';
import { ContainerError } from './framing';

/*
 * Packing and unpacking a container's payload.
 *
 * - Packing is deterministic: fflate's gzip at level 6 with no time, then the header bytes a browser's
 *   CompressionStream varies (time 4–7, level hint 8, system 9) written as zeros and "unknown" (255),
 *   as the desk state's writer does. The same body gives the same bytes in every browser, worker and
 *   Node, so a host that de-duplicates files by their SHA-256 stores one copy.
 * - Unpacking is bounded: the payload goes into fflate in 4 KiB slices and what comes out is copied,
 *   as it comes, into one buffer of exactly the size the header declares (made with the first bytes);
 *   past that it stops. A small file cannot make the reader unpack more than it says, and unpacking
 *   holds that buffer and what one slice unpacks to, never the pieces of the whole body beside it.
 *   Only one gzip member is read, and its CRC-32 and size are checked (fflate's stream does not).
 */

/** Packed bytes handed to the inflater at a time (a slice unpacks to at most ~4 MiB). */
export const INFLATE_SLICE_BYTES = 4 * 1024;

/**
 * Writes the gzip header bytes that differ between writers as zeros and "unknown": time (4–7), level
 * hint (8), system (9). Only a header without optional fields (FLG 0) is touched. In place; returns
 * `gz`.
 */
export function normalizeGzipHeader(gz: Uint8Array): Uint8Array {
  if (gz.length >= 10 && gz[0] === 0x1f && gz[1] === 0x8b && gz[3] === 0) {
    gz.fill(0, 4, 9);
    gz[9] = 255;
  }
  return gz;
}

/** `bytes` gzipped the same way everywhere (fflate level 6, no time, normalized header). */
export function gzipDeterministic(bytes: Uint8Array): Uint8Array {
  return normalizeGzipHeader(gzipSync(bytes, { level: 6, mtime: 0 }));
}

let crcTable: Uint32Array | null = null;

/** `crc` (a running CRC-32, gzip's: 0xffffffff at first, xor 0xffffffff at the end) with `data` added. */
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

/**
 * A gzipped payload unpacked into one buffer of exactly `expectedBytes`, in 4 KiB slices. Throws a
 * ContainerError: 'corrupt' when it does not unpack, unpacks to more or fewer bytes than that, holds
 * a second gzip member or fails its CRC-32 or size; 'too_large' when the buffer cannot be made.
 */
export function gunzipBounded(payload: Uint8Array, expectedBytes: number): Uint8Array {
  if (!Number.isInteger(expectedBytes) || expectedBytes < 0)
    throw new RangeError('expectedBytes is a whole number of bytes');
  // a gzip member has a 10-byte header and an 8-byte trailer at least
  if (payload.length < 18) throw new ContainerError('corrupt', 'it does not unpack');
  let out: Uint8Array | null = null;
  let total = 0;
  let crc = 0xffffffff;
  let members = 1;
  const g = new Gunzip((chunk) => {
    if (!chunk.length) return;
    if (total + chunk.length > expectedBytes)
      throw new ContainerError('corrupt', 'it unpacks to more than it says');
    if (!out) {
      try {
        out = new Uint8Array(expectedBytes);
      } catch {
        throw new ContainerError(
          'too_large',
          `it unpacks to ${expectedBytes} bytes, more than this runtime can hold`,
        );
      }
    }
    out.set(chunk, total);
    crc = crc32(crc, chunk);
    total += chunk.length;
  });
  g.onmember = () => {
    members++;
  };
  try {
    for (let at = 0; at < payload.length; at += INFLATE_SLICE_BYTES) {
      const end = Math.min(payload.length, at + INFLATE_SLICE_BYTES);
      g.push(payload.subarray(at, end), end === payload.length);
    }
  } catch (err) {
    if (err instanceof ContainerError) throw err;
    throw new ContainerError('corrupt', 'it does not unpack');
  }
  const t = payload.subarray(payload.length - 8);
  const sum = (t[0] | (t[1] << 8) | (t[2] << 16) | (t[3] << 24)) >>> 0;
  const size = (t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24)) >>> 0;
  if (members > 1) throw new ContainerError('corrupt', 'it holds more than one gzip member');
  if (total !== expectedBytes) throw new ContainerError('corrupt', 'it unpacks to fewer bytes than it says');
  if (size !== total >>> 0 || sum !== (crc ^ 0xffffffff) >>> 0)
    throw new ContainerError('corrupt', 'it fails its checksum');
  return out ?? new Uint8Array(0);
}
