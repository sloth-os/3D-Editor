import type { Mat4, Quat, Vec3 } from '../math/types';
import { multiplyQuat } from '../math/quat';

/*
 * Axis conventions. The editor (like Blender) is right-handed and Z-up with −Y as "front"; glTF and
 * OBJ are right-handed and Y-up with +Z as "front". The conversion is a −90° rotation about X:
 *
 *   Z-up → Y-up: (x, y, z) → (x, z, −y)
 *   Y-up → Z-up: (x, y, z) → (x, −z, y)
 *
 * Node transforms of a hierarchy are converted per node. Every node has a local frame that is either
 * "converted" (meshes and empties: their local axes are re-expressed Y-up, so mesh data is converted
 * too) or "native" (cameras and lights: both editor and glTF look down local −Z with +Y up, so their
 * local axes must not be converted). With P = conversion of the parent frame (Y→Z when the parent
 * frame is converted, identity otherwise) and N = conversion of the node frame:
 *
 *   L_gltf = P⁻¹ · L_editor · N        L_editor = P · L_gltf · N⁻¹
 *
 * The scene root counts as a converted frame. Because the conversion is a signed axis permutation,
 * the result stays a clean TRS (scale components are permuted, never mixed).
 */

const H = Math.SQRT1_2;

/** Rotation taking Z-up coordinates to Y-up coordinates (−90° about X). */
export const Q_Z_TO_Y: Quat = [-H, 0, 0, H];
/** Rotation taking Y-up coordinates to Z-up coordinates (+90° about X). */
export const Q_Y_TO_Z: Quat = [H, 0, 0, H];

/** Column-major matrix of the Z-up → Y-up rotation. */
export const M_Z_TO_Y: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
/** Column-major matrix of the Y-up → Z-up rotation. */
export const M_Y_TO_Z: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

// `+ 0` turns -0 into 0 so converted data stays tidy.
export function toYUp(v: Readonly<Vec3>): Vec3 {
  return [v[0], v[2], -v[1] + 0];
}

export function toZUp(v: Readonly<Vec3>): Vec3 {
  return [v[0], -v[2] + 0, v[1]];
}

export interface TRS {
  t: Vec3;
  q: Quat;
  s: Vec3;
}

/** Converts an editor (Z-up) local TRS to the glTF (Y-up) node TRS. */
export function trsToYUp(trs: TRS, parentConverted: boolean, selfConverted: boolean): TRS {
  let q = trs.q;
  if (parentConverted) q = multiplyQuat(Q_Z_TO_Y, q);
  if (selfConverted) q = multiplyQuat(q, Q_Y_TO_Z);
  return {
    t: parentConverted ? toYUp(trs.t) : [trs.t[0], trs.t[1], trs.t[2]],
    q,
    s: selfConverted ? [trs.s[0], trs.s[2], trs.s[1]] : [trs.s[0], trs.s[1], trs.s[2]],
  };
}

/** Converts a glTF (Y-up) node TRS to the editor (Z-up) local TRS. */
export function trsToZUp(trs: TRS, parentConverted: boolean, selfConverted: boolean): TRS {
  let q = trs.q;
  if (parentConverted) q = multiplyQuat(Q_Y_TO_Z, q);
  if (selfConverted) q = multiplyQuat(q, Q_Z_TO_Y);
  return {
    t: parentConverted ? toZUp(trs.t) : [trs.t[0], trs.t[1], trs.t[2]],
    q,
    s: selfConverted ? [trs.s[0], trs.s[2], trs.s[1]] : [trs.s[0], trs.s[1], trs.s[2]],
  };
}
