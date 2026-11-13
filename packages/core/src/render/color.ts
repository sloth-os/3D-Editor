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
