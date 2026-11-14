import { zlibSync } from 'fflate';
import { crc32 } from '../render/png';

/*
 * PNG files of export pixels in their own layout, without converting them to RGBA first: grayscale
 * (colour type 0, the edges pass), RGB (2, posters and stills: what ffmpeg's rgb24 PNGs hold), RGBA
 * (6) and indexed colour (3, the mask pass: each pixel's palette index, the palette's exact
 * colours in PLTE). 8 bits per sample, no interlacing; rows are filtered adaptively (the filter
 * with the smallest sum of absolute differences, as core encodePNG), indexed rows not at all (the
 * PNG specification's advice for palette images). Deterministic: the same pixels give the same file.
 */

export interface RawPNGImage {
  width: number;
  height: number;
  /** Samples per pixel: 1 (grayscale, or palette indices with `palette`), 3 (RGB) or 4 (RGBA). */
  channels: 1 | 3 | 4;
  /** Row-major samples, top row first: width × height × channels bytes. */
  data: Uint8Array | Uint8ClampedArray;
  /** RGB triples of an indexed image (1–256 entries; `channels` 1): colour type 3. */
  palette?: Uint8Array;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The filtered scanlines (filter byte + row) of the image. */
function filterRows(img: RawPNGImage, adaptive: boolean): Uint8Array {
  const { width, height, data } = img;
  const bpp = img.channels;
  const stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0;
    if (adaptive) {
      let bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        let score = 0;
        for (let i = 0; i < stride && score < bestScore; i++) {
          const x = data[row + i];
          const a = i >= bpp ? data[row + i - bpp] : 0;
          const b = y > 0 ? data[prev + i] : 0;
          const c = i >= bpp && y > 0 ? data[prev + i - bpp] : 0;
          const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
          const v = (x - pred) & 0xff;
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) {
          bestScore = score;
          best = f;
        }
      }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    for (let i = 0; i < stride; i++) {
      const x = data[row + i];
      const a = i >= bpp ? data[row + i - bpp] : 0;
      const b = y > 0 ? data[prev + i] : 0;
      const c = i >= bpp && y > 0 ? data[prev + i - bpp] : 0;
      const p = best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[o + 1 + i] = (x - p) & 0xff;
    }
  }
  return raw;
}

/** Encodes the image as a PNG file (deflate level `level`, 0–9). */
export function encodeRawPNG(img: RawPNGImage, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const { width, height, channels, palette } = img;
  if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height))
    throw new Error('Invalid PNG dimensions');
  if (channels !== 1 && channels !== 3 && channels !== 4) throw new Error(`Invalid PNG channels ${channels}`);
  if (img.data.length < width * height * channels) throw new Error('PNG pixel data is too short');
  if (palette) {
    if (channels !== 1) throw new Error('An indexed PNG has one sample (the index) per pixel');
    if (palette.length < 3 || palette.length > 768 || palette.length % 3)
      throw new Error('A PNG palette holds 1–256 RGB entries');
  }
  const colorType = palette ? 3 : channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const idat = zlibSync(filterRows(img, !palette), { level });
  const parts = [SIGNATURE, chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette));
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** RGB bytes of RGBA pixels (alpha dropped: what posters and stills keep, as ffmpeg's rgb24). */
export function rgbaToRGB(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}
