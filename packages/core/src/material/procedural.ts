import type { Vec2, Vec3, Vec4 } from '../math/types';
import type { ProceduralTexture } from '../doc/types';

/**
 * Texture coordinate of a surface point for a procedural texture's `mapping`:
 * GENERATED = position normalised to the object's (base mesh) bounding box (0..1 per axis),
 * OBJECT = object-space position, UV = (u, v, 0).
 */
export function proceduralCoord(
  mapping: ProceduralTexture['mapping'],
  objectPos: Readonly<Vec3>,
  bboxMin: Readonly<Vec3>,
  bboxMax: Readonly<Vec3>,
  uv: Readonly<Vec2> | null,
): Vec3 {
  if (mapping === 'UV') return uv ? [uv[0], uv[1], 0] : [0, 0, 0];
  if (mapping === 'OBJECT') return [objectPos[0], objectPos[1], objectPos[2]];
  const g = (i: number) => {
    const d = bboxMax[i] - bboxMin[i];
    return d > 1e-12 ? (objectPos[i] - bboxMin[i]) / d : 0.5;
  };
  return [g(0), g(1), g(2)];
}

/**
 * Evaluates a procedural texture at a texture coordinate (from `proceduralCoord`; the texture's
 * `scale` is applied here) and returns linear RGBA after the colour ramp. Deterministic, pure and
 * identical on every platform; the viewport GLSL implementation must match it.
 *
 * Phase-0 stub: returns color_a. The materials workstream implements every ProceduralType.
 */
export function sampleProcedural(tex: ProceduralTexture, coord: Readonly<Vec3>): Vec4 {
  void coord;
  return [tex.color_a[0], tex.color_a[1], tex.color_a[2], tex.color_a[3]];
}
