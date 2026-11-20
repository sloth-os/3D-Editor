import { sha256 } from '@noble/hashes/sha2.js';

/*
 * SHA-256, synchronously and the same everywhere (the desk's page, its staging worker and Node):
 * @noble/hashes, as the web app already uses. A library unit's file hash and body digest, and the
 * derived ids of its parts, are made with it.
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Bytes as lowercase hex. */
export function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

/** The SHA-256 of `bytes`. */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/** The SHA-256 of `bytes` as 64 lowercase hex digits. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHexLower(sha256(bytes));
}

/** The SHA-256 of a text's UTF-8 bytes as 64 lowercase hex digits. */
export function sha256HexOfText(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}
