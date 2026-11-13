/** sRGB electro-optical transfer: encoded 0..1 → linear. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear → sRGB encoded 0..1 (input clamped to [0, 1]). */
export function linearToSrgb(c: number): number {
  if (!(c > 0)) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Lookup table: linear value quantized to 4096 steps → sRGB byte. */
const LUT_SIZE = 4096;
let lut: Uint8Array | null = null;

/** Fast linear → sRGB byte conversion (input clamped to [0, 1]). */
export function linearToSrgbByte(c: number): number {
  if (!lut) {
    lut = new Uint8Array(LUT_SIZE + 1);
    for (let i = 0; i <= LUT_SIZE; i++) lut[i] = Math.round(linearToSrgb(i / LUT_SIZE) * 255);
  }
  if (!(c > 0)) return 0;
  if (c >= 1) return 255;
  // Quantizing in linear space is too coarse near black; use the exact curve there.
  if (c < 0.02) return Math.round(linearToSrgb(c) * 255);
  return lut[Math.round(c * LUT_SIZE)];
}

/** Linear → sRGB × 255 lookup (4096 steps, interpolated; the exact curve below 0.02). */
let lut255: Float32Array | null = null;

/** Linear (clamped to [0, 1]) → sRGB × 255, unrounded (dithered quantization). */
export function linearToSrgb255(c: number): number {
  if (!(c > 0)) return 0;
  if (c >= 1) return 255;
  if (c < 0.02) return linearToSrgb(c) * 255;
  if (!lut255) {
    lut255 = new Float32Array(LUT_SIZE + 2);
    for (let i = 0; i <= LUT_SIZE; i++) lut255[i] = linearToSrgb(i / LUT_SIZE) * 255;
    lut255[LUT_SIZE + 1] = 255;
  }
  const f = c * LUT_SIZE;
  const i = f | 0;
  return lut255[i] + (lut255[i + 1] - lut255[i]) * (f - i);
}

/** 8 × 8 ordered dither thresholds in (0, 1), row-major (Bayer matrix, (k + 0.5) / 64). */
const BAYER = (() => {
  const m = new Float32Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      // bit-reversed interleave of x ^ y and y
      const a = x ^ y;
      const k =
        ((a & 1) << 5) | ((y & 1) << 4) | ((a & 2) << 2) | ((y & 2) << 1) | ((a & 4) >> 1) | ((y & 4) >> 2);
      m[y * 8 + x] = (k + 0.5) / 64;
    }
  return m;
})();

/** The ordered-dither threshold of pixel (x, y), in (0, 1). */
export function ditherThreshold(x: number, y: number): number {
  return BAYER[((y & 7) << 3) | (x & 7)];
}

/** A display value in 0..255 (unrounded) quantized to a byte with dither threshold `t` in (0, 1). */
export function ditherByte(v: number, t: number): number {
  const q = Math.floor(v + t);
  return q <= 0 ? 0 : q >= 255 ? 255 : q;
}
