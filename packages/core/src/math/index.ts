export * from './types';
export * from './vec3';
export * from './mat4';
export * from './quat';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Rounds to a fixed number of decimals, avoiding `-0`. */
export function roundTo(v: number, decimals = 6): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}
