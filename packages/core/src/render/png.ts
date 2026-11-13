import { unzlibSync, zlibSync } from 'fflate';

/*
 * Minimal PNG codec. The encoder writes 8-bit RGBA with adaptive per-row filtering and zlib
 * compression; the decoder reads every standard color type and bit depth (including palettes and
 * Adam7 interlacing) and returns RGBA8.
 */

export interface PNGImage {
  width: number;
  height: number;
  /** RGBA8 pixels, row-major, top row first. */
  data: Uint8ClampedArray;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO-HDLC, as used by PNG and zlib containers). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeChunk(out: Uint8Array, o: number, type: string, data: Uint8Array): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(o, data.length);
  for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
  out.set(data, o + 8);
  dv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
  return o + 12 + data.length;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encodes RGBA8 pixels as a PNG file (color type 6, bit depth 8, adaptive filtering). */
export function encodePNG(img: PNGImage): Uint8Array {
  const { width, height, data } = img;
  if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height))
    throw new Error('Invalid PNG dimensions');
  if (data.length < width * height * 4) throw new Error('PNG pixel data is too short');
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < stride && score < bestScore; i++) {
        const x = data[row + i];
        const a = i >= 4 ? data[row + i - 4] : 0;
        const b = y > 0 ? data[prev + i] : 0;
        const c = i >= 4 && y > 0 ? data[prev + i - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (x - pred) & 0xff;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const out = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    raw[y * (stride + 1)] = best;
    for (let i = 0; i < stride; i++) {
      const x = data[row + i];
      const a = i >= 4 ? data[row + i - 4] : 0;
      const b = y > 0 ? data[prev + i] : 0;
      const c = i >= 4 && y > 0 ? data[prev + i - 4] : 0;
      const p = best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[i] = (x - p) & 0xff;
    }
  }
  const idat = zlibSync(raw, { level: 6 });
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const out = new Uint8Array(SIGNATURE.length + 12 * 3 + ihdr.length + idat.length);
  out.set(SIGNATURE, 0);
  let o = writeChunk(out, SIGNATURE.length, 'IHDR', ihdr);
  o = writeChunk(out, o, 'IDAT', idat);
  writeChunk(out, o, 'IEND', new Uint8Array(0));
  return out;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes a PNG file to RGBA8. Throws on malformed files or CRC mismatches. */
export function decodePNG(bytes: Uint8Array): PNGImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let seenEnd = false;
  while (o + 12 <= bytes.length && !seenEnd) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const start = o + 8;
    const end = start + len;
    if (end + 4 > bytes.length) throw new Error('PNG chunk exceeds file length');
    if (crc32(bytes, o + 4, end) !== dv.getUint32(end)) throw new Error(`PNG chunk ${type} has a bad CRC`);
    const body = bytes.subarray(start, end);
    switch (type) {
      case 'IHDR':
        width = dv.getUint32(start);
        height = dv.getUint32(start + 4);
        depth = body[8];
        colorType = body[9];
        if (body[10] !== 0 || body[11] !== 0) throw new Error('Unsupported PNG compression/filter method');
        interlace = body[12];
        break;
      case 'PLTE':
        palette = body;
        break;
      case 'tRNS':
        trns = body;
        break;
      case 'IDAT':
        idat.push(body);
        break;
      case 'IEND':
        seenEnd = true;
        break;
      default:
        break;
    }
    o = end + 4;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || !channels) throw new Error('PNG has a missing or invalid IHDR');
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`Unsupported PNG bit depth ${depth}`);
  if (colorType === 3 && !palette) throw new Error('Palette PNG without PLTE');
  let total = 0;
  for (const c of idat) total += c.length;
  const compressed = new Uint8Array(total);
  let p = 0;
  for (const c of idat) {
    compressed.set(c, p);
    p += c.length;
  }
  const raw = unzlibSync(compressed);
  const out = new Uint8ClampedArray(width * height * 4);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const maxV = (1 << Math.min(depth, 8)) - 1;
  /** Sample `idx` of a row (8-bit value: high byte for 16-bit images, raw value for < 8 bits). */
  const readSample = (row: Uint8Array, idx: number): number => {
    if (depth === 8) return row[idx];
    if (depth === 16) return row[idx * 2];
    const bit = idx * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxV;
  };
  const read16 = (row: Uint8Array, idx: number): number => (row[idx * 2] << 8) | row[idx * 2 + 1];
  const to8 = depth < 8 ? (v: number) => Math.round((v * 255) / maxV) : (v: number) => v;
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
  const trnsRGB =
    colorType === 2 && trns && trns.length >= 6
      ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]]
      : null;
  let rp = 0;

  const pass = (x0: number, y0: number, dx: number, dy: number) => {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = new Uint8Array(rowBytes);
    let cur = new Uint8Array(rowBytes);
    for (let ry = 0; ry < ph; ry++) {
      if (rp + 1 + rowBytes > raw.length) throw new Error('PNG image data is truncated');
      const filter = raw[rp++];
      for (let i = 0; i < rowBytes; i++) {
        const x = raw[rp + i];
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v: number;
        switch (filter) {
          case 0:
            v = x;
            break;
          case 1:
            v = x + a;
            break;
          case 2:
            v = x + b;
            break;
          case 3:
            v = x + ((a + b) >> 1);
            break;
          case 4:
            v = x + paeth(a, b, c);
            break;
          default:
            throw new Error(`Bad PNG filter type ${filter}`);
        }
        cur[i] = v & 0xff;
      }
      rp += rowBytes;
      const y = y0 + ry * dy;
      for (let rx = 0; rx < pw; rx++) {
        const q = (y * width + x0 + rx * dx) * 4;
        const si = rx * channels;
        switch (colorType) {
          case 0: {
            const raw0 = readSample(cur, si);
            out[q] = out[q + 1] = out[q + 2] = to8(raw0);
            out[q + 3] = trnsGray >= 0 && (depth === 16 ? read16(cur, si) : raw0) === trnsGray ? 0 : 255;
            break;
          }
          case 2: {
            out[q] = to8(readSample(cur, si));
            out[q + 1] = to8(readSample(cur, si + 1));
            out[q + 2] = to8(readSample(cur, si + 2));
            let alpha = 255;
            if (trnsRGB) {
              const r = depth === 16 ? read16(cur, si) : readSample(cur, si);
              const g = depth === 16 ? read16(cur, si + 1) : readSample(cur, si + 1);
              const b = depth === 16 ? read16(cur, si + 2) : readSample(cur, si + 2);
              if (r === trnsRGB[0] && g === trnsRGB[1] && b === trnsRGB[2]) alpha = 0;
            }
            out[q + 3] = alpha;
            break;
          }
          case 3: {
            const idx = readSample(cur, si);
            out[q] = palette![idx * 3] ?? 0;
            out[q + 1] = palette![idx * 3 + 1] ?? 0;
            out[q + 2] = palette![idx * 3 + 2] ?? 0;
            out[q + 3] = trns && idx < trns.length ? trns[idx] : 255;
            break;
          }
          case 4:
            out[q] = out[q + 1] = out[q + 2] = to8(readSample(cur, si));
            out[q + 3] = to8(readSample(cur, si + 1));
            break;
          default:
            out[q] = to8(readSample(cur, si));
            out[q + 1] = to8(readSample(cur, si + 1));
            out[q + 2] = to8(readSample(cur, si + 2));
            out[q + 3] = to8(readSample(cur, si + 3));
        }
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
  };

  if (interlace === 1) {
    pass(0, 0, 8, 8);
    pass(4, 0, 8, 8);
    pass(0, 4, 4, 8);
    pass(2, 0, 4, 4);
    pass(0, 2, 2, 4);
    pass(1, 0, 2, 2);
    pass(0, 1, 1, 2);
  } else pass(0, 0, 1, 1);
  return { width, height, data: out };
}
