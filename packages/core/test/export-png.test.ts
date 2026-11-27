import { describe, expect, it } from 'vitest';
import { decodePNG } from '../src';
import { encodeRawPNG, rgbaToRGB } from '../src/export/png';

/*
 * PNG files of export pixels in their own layout: grayscale (edges), RGB (posters, stills), RGBA and
 * indexed colour (the mask: its palette indices, the palette's exact colours). Each decodes back to
 * exactly the pixels it was made from.
 */

/** The colour type byte of a PNG file (IHDR). */
const colorType = (png: Uint8Array) => png[25];

/** The chunk types of a PNG file, in order. */
function chunks(png: Uint8Array): string[] {
  const out: string[] = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let o = 8; o < png.length;) {
    const len = dv.getUint32(o);
    out.push(String.fromCharCode(...png.subarray(o + 4, o + 8)));
    o += 12 + len;
  }
  return out;
}

/** Pixels with flat regions and gradients (what passes look like). */
function pattern(width: number, height: number, channels: number): Uint8Array {
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < channels; c++)
        out[(y * width + x) * channels + c] = x < width / 2 ? (x * 7 + y * 3 + c * 50) & 255 : 200 - c;
  return out;
}

describe('encodeRawPNG', () => {
  it('writes grayscale exactly (colour type 0)', () => {
    const data = pattern(33, 17, 1);
    const png = encodeRawPNG({ width: 33, height: 17, channels: 1, data });
    expect(colorType(png)).toBe(0);
    const back = decodePNG(png);
    expect(back.width).toBe(33);
    for (let i = 0; i < 33 * 17; i++) {
      expect(back.data[i * 4]).toBe(data[i]);
      expect(back.data[i * 4 + 1]).toBe(data[i]);
      expect(back.data[i * 4 + 3]).toBe(255);
    }
  });

  it('writes RGB and RGBA exactly (colour types 2 and 6)', () => {
    const rgb = pattern(20, 9, 3);
    const png = encodeRawPNG({ width: 20, height: 9, channels: 3, data: rgb });
    expect(colorType(png)).toBe(2);
    const back = decodePNG(png);
    for (let i = 0; i < 20 * 9; i++)
      expect([...back.data.subarray(i * 4, i * 4 + 4)]).toEqual([
        rgb[i * 3],
        rgb[i * 3 + 1],
        rgb[i * 3 + 2],
        255,
      ]);
    const rgba = pattern(20, 9, 4);
    const png4 = encodeRawPNG({ width: 20, height: 9, channels: 4, data: rgba });
    expect(colorType(png4)).toBe(6);
    expect([...decodePNG(png4).data]).toEqual([...rgba]);
  });

  it('writes palette indices with the exact palette colours (colour type 3, PLTE)', () => {
    const palette = new Uint8Array(256 * 3);
    palette.set([0, 0, 0, 255, 0, 0, 12, 200, 99, 1, 2, 3], 0);
    const index = new Uint8Array(16 * 8);
    for (let i = 0; i < index.length; i++) index[i] = i % 4;
    const png = encodeRawPNG({ width: 16, height: 8, channels: 1, data: index, palette });
    expect(colorType(png)).toBe(3);
    expect(chunks(png)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    const back = decodePNG(png);
    for (let i = 0; i < index.length; i++) {
      const k = index[i] * 3;
      expect([...back.data.subarray(i * 4, i * 4 + 3)]).toEqual([palette[k], palette[k + 1], palette[k + 2]]);
    }
  });

  it('is deterministic and refuses what PNG cannot hold', () => {
    const data = pattern(8, 8, 3);
    expect(encodeRawPNG({ width: 8, height: 8, channels: 3, data })).toEqual(
      encodeRawPNG({ width: 8, height: 8, channels: 3, data: data.slice() }),
    );
    expect(() => encodeRawPNG({ width: 0, height: 8, channels: 3, data })).toThrow(/dimensions/);
    expect(() => encodeRawPNG({ width: 8, height: 8, channels: 3, data: data.subarray(1) })).toThrow(/short/);
    expect(() =>
      encodeRawPNG({ width: 8, height: 8, channels: 3, data, palette: new Uint8Array(3) }),
    ).toThrow(/one sample/);
    expect(() =>
      encodeRawPNG({ width: 8, height: 8, channels: 1, data, palette: new Uint8Array(4) }),
    ).toThrow(/1–256/);
  });
});

describe('rgbaToRGB', () => {
  it('drops alpha, as ffmpeg keeps rgb24 of an RGBA frame', () => {
    expect([...rgbaToRGB(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 0]), 2, 1)]).toEqual([1, 2, 3, 5, 6, 7]);
  });
});
