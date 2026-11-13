const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Random URL-safe identifier (base62). 16 chars ≈ 95 bits of entropy. */
export function newId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % 62];
  return out;
}

/** RFC 4122 v4 UUID (used for project ids so they are safe as file/folder names). */
export function newUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Project ids are UUIDs, but we also accept simple slugs (letters, digits, dash, underscore). */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isValidProjectId(s: string): boolean {
  return PROJECT_ID_RE.test(s);
}
