import type { RawPixelFormat } from '@3d-editor/core';

/*
 * Rendered pixels as the video encoder takes them: 8-bit I420 (planar Y, then U and V at half the
 * width and height) with the BT.709 matrix in limited ("TV") range, what the server's ffmpeg makes
 * with `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`. The conversion runs in the
 * render worker (1.5 bytes per pixel then cross to the encoder instead of 4), and the frames are
 * tagged BT.709 limited range, so the encoder writes those tags (the video's VUI and the MP4's colr
 * box) instead of the full-range sRGB a browser gives RGBA frames.
 *
 * Y  = 16 + 219/255 × (0.2126 R + 0.7152 G + 0.0722 B)
 * Cb = 128 + 224/255 × (B − Y′) / 1.8556,  Cr = 128 + 224/255 × (R − Y′) / 1.5748
 * in 16.16 fixed point, each chroma sample from the average of its 2 × 2 pixels; alpha is dropped
 * (as ffmpeg drops it from rgba input). Gray input is R = G = B: Y = 16 + 219/255 × v, Cb = Cr = 128.
 * The coefficients of each row are rounded so that grey keeps exactly neutral chroma and a full
 * white luma of 235.
 */

/** Luma coefficients × 2^16: 0.2126, 0.7152 and 0.0722 of 219/255 (they add up to 219/255 × 2^16). */
const YR = 11966;
const YG = 40254;
const YB = 4064;
const Y_SUM = YR + YG + YB; // 56284
/** Chroma coefficients × 2^16 (each row adds up to 0: grey stays at 128). */
const UR = -6596;
const UG = -22188;
const UB = 28784;
const VR = 28784;
const VG = -26145;
const VB = -2639;

/** Bytes of an I420 frame of width × height (even sizes). */
export function i420Size(width: number, height: number): number {
  return width * height + 2 * (width >> 1) * (height >> 1);
}

/**
 * The I420 bytes of a frame of raw pixels (RGBA, RGB or one gray byte per pixel), BT.709 limited
 * range, chroma averaged over 2 × 2 pixels. Width and height must be even (video frames are).
 */
export function toI420(
  src: ArrayLike<number>,
  format: RawPixelFormat,
  width: number,
  height: number,
  out: Uint8Array = new Uint8Array(i420Size(width, height)),
): Uint8Array {
  if (width % 2 || height % 2 || width <= 0 || height <= 0)
    throw new Error(`I420 frames have even sides (${width} × ${height})`);
  const n = width * height;
  const stride = format === 'rgba' ? 4 : format === 'rgb24' ? 3 : 1;
  if (src.length < n * stride) throw new Error('the frame has fewer pixels than its size');
  if (out.length < i420Size(width, height)) throw new Error('the I420 buffer is too short');
  const cw = width >> 1;
  const uOff = n;
  const vOff = n + cw * (height >> 1);
  if (stride === 1) {
    for (let i = 0; i < n; i++) out[i] = (Y_SUM * src[i] + (16 << 16) + (1 << 15)) >> 16;
    out.fill(128, uOff, vOff + cw * (height >> 1));
    return out;
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let dy = 0; dy < 2; dy++) {
        const row = (y + dy) * width;
        for (let dx = 0; dx < 2; dx++) {
          const p = row + x + dx;
          const s = p * stride;
          const r = src[s];
          const g = src[s + 1];
          const b = src[s + 2];
          out[p] = (YR * r + YG * g + YB * b + (16 << 16) + (1 << 15)) >> 16;
          sr += r;
          sg += g;
          sb += b;
        }
      }
      const c = (y >> 1) * cw + (x >> 1);
      // the average of four pixels: a further 2 bits of the shift
      out[uOff + c] = (UR * sr + UG * sg + UB * sb + (128 << 18) + (1 << 17)) >> 18;
      out[vOff + c] = (VR * sr + VG * sg + VB * sb + (128 << 18) + (1 << 17)) >> 18;
    }
  }
  return out;
}

/** The colour space of the I420 frames (and of the videos): BT.709 primaries, transfer and matrix, limited range. */
export const BT709_LIMITED = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
} as const satisfies VideoColorSpaceInit;
