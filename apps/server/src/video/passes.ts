import { ACTOR_PALETTE, DESK_PROPS, type ObjectData, type SceneDoc } from '@3d-editor/core';
import type { ImageResult, PassName } from '../render/protocol';
import type { RawPixelFormat, StreamCodec } from './ffmpeg';

/*
 * The passes of a video export on the server's side: the job's mask palette (which object group
 * gets which index and colour, the same for every frame), the ffmpeg streams of the passes and the
 * cheap per-frame conversions (mask indices to colours, a pass as RGBA for posters and the contact
 * sheet, tiles). The passes themselves are computed in the render processes (render/passes.ts).
 */

/** Groups the mask palette holds at most (index 0 is nothing drawn). */
export const MAX_PALETTE = 255;

/** One mask group: an actor or an object hierarchy, its index in the mask pass and its colour. */
export interface PaletteEntry {
  index: number;
  /** The group's object id (an actor's armature, else the hierarchy's root). */
  object: string;
  name: string;
  /** desk_role of the object, when it has one. */
  role: string | null;
  color: [number, number, number];
}

/** The colours of non-actor groups: golden-angle hues at two brightnesses (deterministic, distinct). */
const BASE_COLORS: [number, number, number][] = Array.from({ length: 48 }, (_, k) =>
  hsv(((k * 137.508) % 360) / 360, k < 24 ? 0.62 : 0.45, k < 24 ? 0.95 : 0.75),
);

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** FNV-1a hash of a string (32 bits). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** '#rrggbb' → RGB bytes, or null. */
export function hexColor(hex: unknown): [number, number, number] | null {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const GEOMETRY_TYPES = new Set(['MESH', 'CURVE', 'FONT']);

/**
 * The mask palette of an export (the same for every frame): the actors first (their desk_color),
 * then the shot subjects, then props, landmarks, set pieces and strings, then every other object
 * hierarchy that draws geometry (by name); each in a colour of its own — actors their desk colour,
 * other groups a fixed palette colour chosen by a hash of the object's id, the next free one on a
 * clash — never black (nothing drawn). At most MAX_PALETTE groups.
 */
export function buildPalette(doc: SceneDoc, subjects: Iterable<string> = []): PaletteEntry[] {
  const objects = doc.listObjects();
  const byId = new Map(objects.map((o) => [o.id, o]));
  const role = (o: ObjectData): string | null => {
    const r = o.custom_props?.[DESK_PROPS.role];
    return typeof r === 'string' ? r : null;
  };
  const isActor = (o: ObjectData) => o.type === 'ARMATURE' && role(o) === 'actor';
  // the group of an object: its nearest actor ancestor-or-self, else its root
  const groupOf = (o: ObjectData): string => {
    const seen = new Set<string>();
    let cur: ObjectData | undefined = o;
    let last = o;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (isActor(cur)) return cur.id;
      const actor = cur.custom_props?.[DESK_PROPS.actor];
      if (typeof actor === 'string' && byId.get(actor) && isActor(byId.get(actor)!)) return actor;
      last = cur;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return last.id;
  };
  const drawing = new Set<string>();
  for (const o of objects) if (GEOMETRY_TYPES.has(o.type)) drawing.add(groupOf(o));
  const subjectSet = new Set(subjects);
  const rank = (o: ObjectData): number => {
    if (isActor(o)) return 0;
    if (subjectSet.has(o.id)) return 1;
    const r = role(o);
    return r === 'prop' ? 2 : r === 'landmark' ? 3 : r === 'set' ? 4 : r === 'string' ? 5 : 6;
  };
  const groups = [...drawing]
    .map((id) => byId.get(id)!)
    .filter(Boolean)
    .sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d) return d;
      // actors in document order (their creation order: their palette colours), others by name
      if (isActor(a) && isActor(b)) return objects.indexOf(a) - objects.indexOf(b);
      return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;
    })
    .slice(0, MAX_PALETTE);
  const used = new Set<string>();
  const key = (c: readonly number[]) => c.join(',');
  const free = (c: [number, number, number]): [number, number, number] => {
    // nudge a clashing colour until it is free (deterministic)
    let out = c;
    for (let k = 1; used.has(key(out)) || key(out) === '0,0,0'; k++)
      out = [(c[0] + 37 * k) % 256, (c[1] + 59 * k) % 256, (c[2] + 83 * k) % 256];
    used.add(key(out));
    return out;
  };
  let actors = 0;
  return groups.map((o, i) => {
    let color: [number, number, number];
    if (isActor(o)) {
      color = free(
        hexColor(o.custom_props?.[DESK_PROPS.color]) ??
          hexColor(ACTOR_PALETTE[actors % ACTOR_PALETTE.length]) ?? [255, 255, 255],
      );
      actors++;
    } else {
      const start = hashString(o.id) % BASE_COLORS.length;
      let pick: [number, number, number] | null = null;
      for (let k = 0; k < BASE_COLORS.length && !pick; k++) {
        const c = BASE_COLORS[(start + k) % BASE_COLORS.length];
        if (!used.has(key(c))) pick = c;
      }
      color = free(pick ?? BASE_COLORS[start]);
    }
    return { index: i + 1, object: o.id, name: o.name, role: role(o), color };
  });
}

/** The palette as the render processes take it (FrameOptions.desk.objectPalette, in index order). */
export function paletteRecord(palette: readonly PaletteEntry[]): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const e of [...palette].sort((a, b) => a.index - b.index)) out[e.object] = e.color;
  return out;
}

/** 256 RGB colours by mask index (0 black, unknown indices black). */
export function paletteLut(palette: readonly PaletteEntry[]): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  for (const e of palette) {
    if (e.index < 1 || e.index > 255) continue;
    lut[e.index * 3] = e.color[0];
    lut[e.index * 3 + 1] = e.color[1];
    lut[e.index * 3 + 2] = e.color[2];
  }
  return lut;
}

/** Mask indices → RGB colours. */
export function maskToRGB(mask: Uint8Array, lut: Uint8Array, out?: Uint8Array): Uint8Array {
  const n = mask.length;
  const res = out ?? new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = mask[i] * 3;
    res[i * 3] = lut[k];
    res[i * 3 + 1] = lut[k + 1];
    res[i * 3 + 2] = lut[k + 2];
  }
  return res;
}

// ---------------------------------------------------------------- streams

/** The raw format of each pass as the render processes send it. */
export const PASS_FORMAT: Readonly<Record<PassName, RawPixelFormat>> = {
  beauty: 'rgba',
  depth: 'gray',
  normal: 'rgb24',
  mask: 'rgb24', // indices expanded to the palette's colours on the server
  edges: 'gray',
  pose: 'rgb24',
};

/** One ffmpeg stream of an export: a pass in the viewing codec, or a lossless copy of a data pass. */
export interface StreamSpec {
  pass: PassName;
  codec: StreamCodec;
  input: RawPixelFormat;
  /** File name suffix after the base name: '' for beauty, '.depth' …; lossless: '.mask' (.mkv). */
  suffix: string;
  /** Lossless copy (mask, edges): no clips are cut from it. */
  lossless: boolean;
}

/**
 * The streams of an export's passes: each pass in the viewing codec (H.264 MP4 or VP9 WebM), and
 * the mask and edges passes also lossless (libx264rgb in Matroska), whose exact values data
 * consumers need.
 */
export function streamsFor(passes: readonly PassName[], codec: 'h264' | 'vp9'): StreamSpec[] {
  const out: StreamSpec[] = [];
  for (const pass of passes) {
    const suffix = pass === 'beauty' ? '' : `.${pass}`;
    out.push({ pass, codec, input: PASS_FORMAT[pass], suffix, lossless: false });
    if (pass === 'mask' || pass === 'edges')
      out.push({ pass, codec: 'lossless', input: PASS_FORMAT[pass], suffix, lossless: true });
  }
  return out;
}

/** Bytes of one frame of a raw format. */
export function frameBytes(format: RawPixelFormat, width: number, height: number): number {
  return width * height * (format === 'rgba' ? 4 : format === 'rgb24' ? 3 : 1);
}

/** Bytes the render process sends per frame for these passes (beauty RGBA, passes 1 or 3 bytes). */
export function resultBytes(passes: readonly PassName[], width: number, height: number): number {
  let n = 0;
  for (const p of passes) n += p === 'beauty' ? 4 : p === 'normal' || p === 'pose' ? 3 : 1;
  // the mask's colours (3 bytes) are made on the server for each frame
  if (passes.includes('mask')) n += 3;
  return n * width * height + 64 * 1024;
}

/** The bytes of a pass of a rendered frame for its stream (the mask expanded to colours). */
export function passBytes(img: ImageResult, pass: PassName, maskRGB: Uint8Array | null): Uint8Array {
  if (pass === 'beauty') {
    const d = img.data;
    if (!d) throw new Error('the frame came back without its beauty image');
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  }
  if (pass === 'mask') {
    if (!maskRGB) throw new Error('the frame came back without its mask pass');
    return maskRGB;
  }
  const p = img.passes?.[pass];
  if (!p) throw new Error(`the frame came back without its ${pass} pass`);
  return p;
}

/** A frame of a raw format as RGBA (posters and contact sheets of exports without beauty). */
export function toRGBA(bytes: Uint8Array, format: RawPixelFormat, width: number, height: number): Uint8Array {
  if (format === 'rgba') return bytes;
  const n = width * height;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (format === 'gray') out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = bytes[i];
    else {
      out[i * 4] = bytes[i * 3];
      out[i * 4 + 1] = bytes[i * 3 + 1];
      out[i * 4 + 2] = bytes[i * 3 + 2];
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** An RGBA image scaled down by box filtering (area average) to w×h. */
export function downscaleRGBA(
  src: Uint8Array,
  sw: number,
  sh: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = sw / w;
  const sy = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const k = (yy * sw + xx) * 4;
          r += src[k];
          g += src[k + 1];
          b += src[k + 2];
          a += src[k + 3];
        }
      const c = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / c);
      out[o + 1] = Math.round(g / c);
      out[o + 2] = Math.round(b / c);
      out[o + 3] = Math.round(a / c);
    }
  }
  return out;
}

/**
 * The tile size of a contact sheet of `tiles` frames of w×h: at most 320 px wide (keeping the
 * aspect), smaller when the sheet would pass 16 million pixels.
 */
export function contactTileSize(tiles: number, w: number, h: number): { width: number; height: number } {
  const maxArea = (1 << 24) / Math.max(1, tiles) / 1.2;
  let tw = Math.min(320, w);
  let th = Math.max(1, Math.round((tw * h) / w));
  if (tw * th > maxArea) {
    const k = Math.sqrt(maxArea / (tw * th));
    tw = Math.max(16, Math.floor(tw * k));
    th = Math.max(1, Math.round((tw * h) / w));
  }
  return { width: tw, height: th };
}
