export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
/** Quaternion stored as [x, y, z, w]. */
export type Quat = [number, number, number, number];
/**
 * 4x4 matrix stored column-major in a flat array of 16 numbers.
 * This is the same memory layout as three.js `Matrix4.elements`, so arrays can be passed
 * to `matrix.fromArray()` directly.
 */
export type Mat4 = number[];
