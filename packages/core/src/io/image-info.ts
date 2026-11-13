/*
 * Image header sniffing: detects the format and pixel size of common image files without decoding
 * them (used when importing textures so image datablocks get correct width/height).
 */

export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
}

function be16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function le16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function le24(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}
function le32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function tag(b: Uint8Array, o: number, s: string): boolean {
  if (o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Detects the image MIME type from magic bytes (null if unknown). */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (tag(b, 0, 'RIFF') && tag(b, 8, 'WEBP')) return 'image/webp';
  if (tag(b, 0, 'GIF87a') || tag(b, 0, 'GIF89a')) return 'image/gif';
  if (tag(b, 0, 'BM')) return 'image/bmp';
  if (tag(b, 0, '\xabKTX 20\xbb')) return 'image/ktx2';
  return null;
}

/** Format and dimensions from the image header, or null when unrecognised/truncated. */
export function readImageInfo(b: Uint8Array): ImageInfo | null {
  const mime = sniffImageMime(b);
  if (!mime) return null;
  switch (mime) {
    case 'image/png':
      if (b.length < 24 || !tag(b, 12, 'IHDR')) return null;
      return { mime, width: be32(b, 16), height: be32(b, 20) };
    case 'image/jpeg':
      return jpegInfo(b);
    case 'image/gif':
      if (b.length < 10) return null;
      return { mime, width: le16(b, 6), height: le16(b, 8) };
    case 'image/bmp':
      if (b.length < 26) return null;
      return { mime, width: Math.abs(le32(b, 18) | 0), height: Math.abs(le32(b, 22) | 0) };
    case 'image/webp':
      return webpInfo(b);
    case 'image/ktx2':
      if (b.length < 28) return null;
      return { mime, width: le32(b, 20), height: le32(b, 24) };
  }
  return null;
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan before any SOF
    const len = be16(b, i + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (i + 9 > b.length) return null;
      return { mime: 'image/jpeg', height: be16(b, i + 5), width: be16(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpInfo(b: Uint8Array): ImageInfo | null {
  const mime = 'image/webp';
  if (tag(b, 12, 'VP8 ') && b.length >= 30)
    return { mime, width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (tag(b, 12, 'VP8L') && b.length >= 25) {
    const b0 = b[21];
    const b1 = b[22];
    const b2 = b[23];
    const b3 = b[24];
    return {
      mime,
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (tag(b, 12, 'VP8X') && b.length >= 30) return { mime, width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  return null;
}
