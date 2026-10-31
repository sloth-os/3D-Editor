import { unzlibSync } from 'fflate';
import { crc32 } from '../src/render/png';

/*
 * Test-only decoders for the animation encoders: an APNG reader (chunk CRCs, sequence numbers,
 * frame control, unfiltering, compositing) and a GIF89a reader (blocks, extensions, LZW with code
 * size growth and clear codes, disposal and transparency). Written from the specifications,
 * independently of the encoders.
 */

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses PNG scanline filtering (8-bit samples, `bpp` bytes per pixel). */
export function unfilter(raw: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const stride = w * bpp;
  if (raw.length !== (stride + 1) * h) throw new Error(`bad scanline data length ${raw.length}`);
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    if (f > 4) throw new Error(`bad filter type ${f}`);
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[y * stride + i] = (x + p) & 0xff;
    }
  }
  return out;
}

export interface APNGFrameInfo {
  sequence: number;
  width: number;
  height: number;
  x: number;
  y: number;
  delayNum: number;
  delayDen: number;
  dispose: number;
  blend: number;
  /** Sequence numbers of the fdAT chunks of this frame. */
  dataSequences: number[];
  /** The frame's own RGBA region. */
  rgba: Uint8Array;
}

export interface DecodedAPNG {
  width: number;
  height: number;
  numFrames: number;
  numPlays: number;
  chunkTypes: string[];
  frames: APNGFrameInfo[];
  /** Full RGBA canvas after each frame. */
  canvases: Uint8Array[];
}

/** Decodes an RGBA8 APNG (throws on CRC errors, bad ordering or sequence numbers). */
export function decodeAPNG(bytes: Uint8Array): DecodedAPNG {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((v, i) => {
    if (bytes[i] !== v) throw new Error('not a PNG');
  });
  let o = 8;
  let width = 0;
  let height = 0;
  let numFrames = -1;
  let numPlays = -1;
  let expectedSeq = 0;
  let seenIdat = false;
  const chunkTypes: string[] = [];
  const frames: (Omit<APNGFrameInfo, 'rgba'> & { parts: Uint8Array[] })[] = [];
  while (o < bytes.length) {
    const len = u32(bytes, o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (crc32(bytes, o + 4, o + 8 + len) !== u32(bytes, o + 8 + len)) throw new Error(`bad CRC in ${type}`);
    chunkTypes.push(type);
    o += 12 + len;
    switch (type) {
      case 'IHDR':
        width = u32(data, 0);
        height = u32(data, 4);
        if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA, not interlaced');
        break;
      case 'acTL':
        if (seenIdat) throw new Error('acTL after IDAT');
        numFrames = u32(data, 0);
        numPlays = u32(data, 4);
        break;
      case 'fcTL': {
        const seq = u32(data, 0);
        if (seq !== expectedSeq++) throw new Error(`fcTL sequence ${seq}, expected ${expectedSeq - 1}`);
        frames.push({
          sequence: seq,
          width: u32(data, 4),
          height: u32(data, 8),
          x: u32(data, 12),
          y: u32(data, 16),
          delayNum: u16be(data, 20),
          delayDen: u16be(data, 22),
          dispose: data[24],
          blend: data[25],
          dataSequences: [],
          parts: [],
        });
        break;
      }
      case 'IDAT':
        if (frames.length !== 1) throw new Error('IDAT must belong to the first frame');
        seenIdat = true;
        frames[0].parts.push(data);
        break;
      case 'fdAT': {
        const seq = u32(data, 0);
        if (seq !== expectedSeq++) throw new Error(`fdAT sequence ${seq}, expected ${expectedSeq - 1}`);
        if (!seenIdat || frames.length < 2) throw new Error('fdAT before IDAT');
        const f = frames[frames.length - 1];
        f.dataSequences.push(seq);
        f.parts.push(data.subarray(4));
        break;
      }
      case 'IEND':
        if (o !== bytes.length) throw new Error('data after IEND');
        break;
    }
  }
  if (chunkTypes[0] !== 'IHDR' || chunkTypes[chunkTypes.length - 1] !== 'IEND') throw new Error('bad chunk order');
  const first = frames[0];
  if (!first || first.x !== 0 || first.y !== 0 || first.width !== width || first.height !== height)
    throw new Error('the first frame must cover the canvas');
  const canvas = new Uint8Array(width * height * 4);
  const canvases: Uint8Array[] = [];
  const out: APNGFrameInfo[] = [];
  let previous: Uint8Array | null = null;
  frames.forEach((f, i) => {
    if (f.x + f.width > width || f.y + f.height > height) throw new Error('frame outside the canvas');
    const rgba = unfilter(unzlibSync(concat(f.parts)), f.width, f.height, 4);
    // dispose of the previous frame
    const prevFrame = i > 0 ? frames[i - 1] : null;
    if (prevFrame?.dispose === 1)
      for (let y = 0; y < prevFrame.height; y++)
        canvas.fill(0, ((prevFrame.y + y) * width + prevFrame.x) * 4, ((prevFrame.y + y) * width + prevFrame.x + prevFrame.width) * 4);
    else if (prevFrame?.dispose === 2 && previous) canvas.set(previous);
    previous = f.dispose === 2 ? canvas.slice() : null;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const s = (y * f.width + x) * 4;
        const d = ((f.y + y) * width + f.x + x) * 4;
        if (f.blend === 0) canvas.set(rgba.subarray(s, s + 4), d);
        else {
          const a = rgba[s + 3] / 255;
          for (let c = 0; c < 4; c++) canvas[d + c] = Math.round(rgba[s + c] * a + canvas[d + c] * (1 - a));
        }
      }
    canvases.push(canvas.slice());
    const { parts: _p, ...info } = f;
    out.push({ ...info, rgba });
  });
  return { width, height, numFrames, numPlays, chunkTypes, frames: out, canvases };
}

/**
 * GIF LZW decoding (variable code sizes up to 12 bits, clear and end codes, the KwKwK case).
 * Returns the indices and the number of clear codes read.
 */
export function lzwDecode(data: Uint8Array, minCodeSize: number): { indices: number[]; clears: number; ended: boolean } {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let prev = -1;
  let bitPos = 0;
  let clears = 0;
  let ended = false;
  const out: number[] = [];
  const read = (): number => {
    let v = 0;
    for (let i = 0; i < codeSize; i++, bitPos++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return -1;
      v |= ((byte >> (bitPos & 7)) & 1) << i;
    }
    return v;
  };
  const emit = (code: number) => {
    const stack: number[] = [];
    for (let c = code; c >= 0; c = prefix[c]) stack.push(suffix[c]);
    for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
  };
  for (;;) {
    const code = read();
    if (code < 0) break;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = end + 1;
      prev = -1;
      clears++;
      continue;
    }
    if (code === end) {
      ended = true;
      break;
    }
    if (prev < 0) {
      if (code >= clear) throw new Error(`first code ${code} after a clear is not a literal`);
      emit(code);
      prev = code;
      continue;
    }
    if (code > next || (code === next && next >= 4096)) throw new Error(`invalid code ${code} (next ${next})`);
    const firstChar = code < next ? first[code] : first[prev];
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstChar;
      first[next] = first[prev];
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    emit(code);
    prev = code;
  }
  return { indices: out, clears, ended };
}

export interface GIFFrameInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  delay: number;
  disposal: number;
  transparentIndex: number | null;
  minCodeSize: number;
  indices: Uint8Array;
  clears: number;
}

export interface DecodedGIF {
  width: number;
  height: number;
  palette: Uint8Array;
  backgroundIndex: number;
  /** NETSCAPE2.0 repeat count (null without the extension). */
  loopCount: number | null;
  frames: GIFFrameInfo[];
  /** Full RGBA canvas after each frame (transparent = 0 alpha). */
  canvases: Uint8Array[];
}

/** Decodes a GIF89a file with a global colour table. */
export function decodeGIF(bytes: Uint8Array): DecodedGIF {
  if (String.fromCharCode(...bytes.subarray(0, 6)) !== 'GIF89a') throw new Error('not a GIF89a');
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  const packed = bytes[10];
  const backgroundIndex = bytes[11];
  if (bytes[12] !== 0) throw new Error('unexpected pixel aspect ratio');
  let o = 13;
  let palette = new Uint8Array(0);
  if (packed & 0x80) {
    const size = 1 << ((packed & 7) + 1);
    palette = bytes.slice(o, o + size * 3);
    o += size * 3;
  }
  const subBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (;;) {
      const n = bytes[o++];
      if (n === undefined) throw new Error('truncated sub-blocks');
      if (n === 0) break;
      parts.push(bytes.subarray(o, o + n));
      o += n;
    }
    return concat(parts);
  };
  let loopCount: number | null = null;
  let gce: { delay: number; disposal: number; transparentIndex: number | null } | null = null;
  const frames: GIFFrameInfo[] = [];
  const canvas = new Uint8Array(width * height * 4);
  const canvases: Uint8Array[] = [];
  for (;;) {
    const intro = bytes[o++];
    if (intro === 0x3b) break;
    if (intro === 0x21) {
      const label = bytes[o++];
      if (label === 0xf9) {
        if (bytes[o] !== 4) throw new Error('bad GCE size');
        const p = bytes[o + 1];
        gce = {
          disposal: (p >> 2) & 7,
          delay: u16le(bytes, o + 2),
          transparentIndex: p & 1 ? bytes[o + 4] : null,
        };
        o += 5;
        if (bytes[o++] !== 0) throw new Error('missing GCE terminator');
      } else if (label === 0xff) {
        const n = bytes[o++];
        const app = String.fromCharCode(...bytes.subarray(o, o + n));
        o += n;
        const data = subBlocks();
        if (app === 'NETSCAPE2.0') {
          if (data[0] !== 1 || data.length !== 3) throw new Error('bad NETSCAPE2.0 block');
          loopCount = u16le(data, 1);
        }
      } else subBlocks();
      continue;
    }
    if (intro !== 0x2c) throw new Error(`unexpected block 0x${intro?.toString(16)}`);
    const x = u16le(bytes, o);
    const y = u16le(bytes, o + 2);
    const w = u16le(bytes, o + 4);
    const h = u16le(bytes, o + 6);
    const ip = bytes[o + 8];
    o += 9;
    if (ip & 0x80) throw new Error('unexpected local colour table');
    if (ip & 0x40) throw new Error('unexpected interlacing');
    const minCodeSize = bytes[o++];
    const { indices, clears, ended } = lzwDecode(subBlocks(), minCodeSize);
    if (!ended) throw new Error('LZW stream without end code');
    if (indices.length !== w * h) throw new Error(`decoded ${indices.length} pixels, expected ${w * h}`);
    const info: GIFFrameInfo = {
      x,
      y,
      width: w,
      height: h,
      delay: gce?.delay ?? 0,
      disposal: gce?.disposal ?? 0,
      transparentIndex: gce?.transparentIndex ?? null,
      minCodeSize,
      indices: Uint8Array.from(indices),
      clears,
    };
    gce = null;
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const v = info.indices[yy * w + xx];
        if (v === info.transparentIndex) continue;
        const d = ((y + yy) * width + x + xx) * 4;
        canvas[d] = palette[v * 3];
        canvas[d + 1] = palette[v * 3 + 1];
        canvas[d + 2] = palette[v * 3 + 2];
        canvas[d + 3] = 255;
      }
    canvases.push(canvas.slice());
    if (info.disposal === 2)
      for (let yy = 0; yy < h; yy++) canvas.fill(0, ((y + yy) * width + x) * 4, ((y + yy) * width + x + w) * 4);
    frames.push(info);
  }
  if (o !== bytes.length) throw new Error('data after the trailer');
  return { width, height, palette, backgroundIndex, loopCount, frames, canvases };
}

/** A solid RGBA test frame with optional rectangles drawn on it. */
export function solidFrame(
  width: number,
  height: number,
  color: [number, number, number, number],
  rects: { x: number; y: number; w: number; h: number; color: [number, number, number, number] }[] = [],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(color, i * 4);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) data.set(r.color, (y * width + x) * 4);
  return { width, height, data };
}
