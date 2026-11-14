import { unzlibSync } from 'fflate';

/*
 * Readers of the files a browser export writes, for its tests: MP4 boxes (sample tables, sync
 * samples, colour box, decoder configuration), stored ZIP archives and PNG images.
 */

export interface Box {
  type: string;
  start: number;
  size: number;
  /** Where the box's payload starts. */
  body: number;
  children: Box[];
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta']);

const u32 = (b: Uint8Array, p: number) =>
  ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const fourcc = (b: Uint8Array, p: number) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** The boxes of an MP4 file between `start` and `end` (containers, stsd and avc1 opened). */
export function mp4Boxes(b: Uint8Array, start = 0, end = b.length): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let body = p + 8;
    if (size === 1) {
      size = Number(new DataView(b.buffer, b.byteOffset + p + 8, 8).getBigUint64(0));
      body = p + 16;
    } else if (size === 0) size = end - p;
    const box: Box = { type, start: p, size, body, children: [] };
    if (CONTAINERS.has(type)) box.children = mp4Boxes(b, body, p + size);
    else if (type === 'stsd') box.children = mp4Boxes(b, body + 8, p + size);
    else if (type === 'avc1' || type === 'vp09') box.children = mp4Boxes(b, body + 78, p + size);
    out.push(box);
    p += size;
  }
  return out;
}

/** The first box of a path ('moov/trak/mdia/minf/stbl/stsz'). */
export function findBox(boxes: Box[], path: string): Box | null {
  const [head, ...rest] = path.split('/');
  const box = boxes.find((x) => x.type === head) ?? null;
  if (!box || !rest.length) return box;
  return findBox(box.children, rest.join('/'));
}

const STBL = 'moov/trak/mdia/minf/stbl';

/** What a one-track MP4 file says about its video. */
export interface Mp4Info {
  /** Top-level boxes in file order. */
  order: string[];
  samples: number;
  /** Sync samples (1-based), all of them when the file has no stss box. */
  sync: number[];
  /** The media time scale and the sample durations (stts expanded). */
  timescale: number;
  durations: number[];
  /** nclx colour box: primaries, transfer, matrix, full range. */
  colr: { type: string; primaries: number; transfer: number; matrix: number; fullRange: boolean } | null;
  /** The avcC box's bytes (the decoder configuration), null without one. */
  avcC: Uint8Array | null;
  codec: string;
  width: number;
  height: number;
}

export function mp4Info(b: Uint8Array): Mp4Info {
  const boxes = mp4Boxes(b);
  const stsz = findBox(boxes, `${STBL}/stsz`);
  const stss = findBox(boxes, `${STBL}/stss`);
  const stts = findBox(boxes, `${STBL}/stts`);
  const mdhd = findBox(boxes, 'moov/trak/mdia/mdhd');
  const stsd = findBox(boxes, `${STBL}/stsd`);
  if (!stsz || !stts || !mdhd || !stsd) throw new Error('not a one-track MP4 file');
  const samples = u32(b, stsz.body + 8);
  const sync: number[] = [];
  if (stss) {
    const n = u32(b, stss.body + 4);
    for (let i = 0; i < n; i++) sync.push(u32(b, stss.body + 8 + 4 * i));
  } else for (let i = 1; i <= samples; i++) sync.push(i);
  const version = b[mdhd.body];
  const timescale = u32(b, mdhd.body + (version === 1 ? 20 : 12));
  const durations: number[] = [];
  const entries = u32(b, stts.body + 4);
  for (let i = 0; i < entries; i++) {
    const count = u32(b, stts.body + 8 + 8 * i);
    const delta = u32(b, stts.body + 12 + 8 * i);
    for (let k = 0; k < count; k++) durations.push(delta);
  }
  const entry = stsd.children[0];
  const colrBox = entry?.children.find((c) => c.type === 'colr') ?? null;
  const avcBox = entry?.children.find((c) => c.type === 'avcC') ?? null;
  return {
    order: boxes.map((x) => x.type),
    samples,
    sync,
    timescale,
    durations,
    colr: colrBox
      ? {
          type: fourcc(b, colrBox.body),
          primaries: u16(b, colrBox.body + 4),
          transfer: u16(b, colrBox.body + 6),
          matrix: u16(b, colrBox.body + 8),
          fullRange: (b[colrBox.body + 10] & 0x80) !== 0,
        }
      : null,
    avcC: avcBox ? b.slice(avcBox.body, avcBox.start + avcBox.size) : null,
    codec: entry?.type ?? '',
    width: entry ? u16(b, entry.body + 24) : 0,
    height: entry ? u16(b, entry.body + 26) : 0,
  };
}

/** The entries of a stored ZIP archive (from its central directory; ZIP64 sizes and offsets read). */
export function readZip(b: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let p = b.length - 22; p >= 0; p--)
    if (v.getUint32(p, true) === 0x06054b50) {
      eocd = p;
      break;
    }
  if (eocd < 0) throw new Error('no end of central directory');
  let count = v.getUint16(eocd + 10, true);
  let dir = v.getUint32(eocd + 16, true);
  if (dir === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (v.getUint32(loc, true) !== 0x07064b50) throw new Error('no ZIP64 locator');
    const rec = Number(v.getBigUint64(loc + 8, true));
    count = Number(v.getBigUint64(rec + 32, true));
    dir = Number(v.getBigUint64(rec + 48, true));
  }
  const out: { name: string; data: Uint8Array; crc: number }[] = [];
  let p = dir;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const crc = v.getUint32(p + 16, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e < extraEnd) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = Number(v.getBigUint64(q + 8, true));
          q += 16;
        }
        if (offset === 0xffffffff) offset = Number(v.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    if (v.getUint32(offset, true) !== 0x04034b50) throw new Error(`bad local header of ${name}`);
    const localStart = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    out.push({ name, data: b.subarray(localStart, localStart + size), crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A PNG image: its header fields, palette (RGB triples) and unfiltered pixel rows. */
export function readPng(b: Uint8Array): {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  palette: Uint8Array | null;
  pixels: Uint8Array;
} {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  sig.forEach((x, i) => {
    if (b[i] !== x) throw new Error('not a PNG file');
  });
  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p < b.length) {
    const len = u32(b, p);
    const type = fourcc(b, p + 4);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') palette = data.slice();
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) {
    joined.set(d, o);
    o += d.length;
  }
  const raw = unzlibSync(joined);
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const stride = width * bpp;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      pixels[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, depth, colorType, palette, pixels };
}

/** What an H.264 sequence parameter set says (profile, level, size and the VUI's colour description). */
export interface SpsInfo {
  profile: number;
  level: number;
  /** The VUI's video_signal_type: full range, colour primaries, transfer and matrix (null without one). */
  signal: { fullRange: boolean; primaries: number; transfer: number; matrix: number } | null;
}

/** The first SPS of an avcC box's bytes (AVCDecoderConfigurationRecord), parsed up to its VUI's colour fields. */
export function avcSps(avcC: Uint8Array): SpsInfo {
  if (avcC[0] !== 1) throw new Error('not an AVCDecoderConfigurationRecord');
  if ((avcC[5] & 0x1f) < 1) throw new Error('no SPS in the decoder configuration');
  const len = (avcC[6] << 8) | avcC[7];
  const nal = avcC.subarray(8, 8 + len);
  // the RBSP: emulation prevention bytes (00 00 03) removed
  const rbsp: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    rbsp.push(nal[i]);
  }
  let pos = 0;
  const bit = () => (rbsp[pos >> 3] >> (7 - (pos++ & 7))) & 1;
  const u = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + bit();
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (!bit()) zeros++;
    return (1 << zeros) - 1 + u(zeros);
  };
  const profile = u(8);
  u(8);
  const level = u(8);
  ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    if (ue() === 3) u(1);
    ue();
    ue();
    u(1);
    if (u(1)) throw new Error('SPS scaling lists are not read');
  }
  ue();
  const pocType = ue();
  if (pocType === 0) ue();
  else if (pocType === 1) throw new Error('SPS picture order count type 1 is not read');
  ue();
  u(1);
  ue();
  ue();
  if (!u(1)) u(1);
  u(1);
  if (u(1)) {
    ue();
    ue();
    ue();
    ue();
  }
  if (!u(1)) return { profile, level, signal: null };
  if (u(1) && u(8) === 255) {
    u(16);
    u(16);
  }
  if (u(1)) u(1);
  if (!u(1)) return { profile, level, signal: null };
  u(3);
  const fullRange = u(1) === 1;
  if (!u(1)) return { profile, level, signal: { fullRange, primaries: 2, transfer: 2, matrix: 2 } };
  return { profile, level, signal: { fullRange, primaries: u(8), transfer: u(8), matrix: u(8) } };
}
