import { multiply4, type Mat4 } from '@3d-editor/core';
import type { RenderViewData, Vec3T } from './protocol';

/**
 * A render view (the core renderers' camera) from column-major world → camera and projection
 * matrices, e.g. a three.js camera's `matrixWorldInverse` and `projectionMatrix`.
 */
export function renderViewFromMatrices(
  viewMatrix: ArrayLike<number>,
  projectionMatrix: ArrayLike<number>,
  ortho: boolean,
  near: number,
  far: number,
): RenderViewData {
  const v = Array.from(viewMatrix) as Mat4;
  const p = Array.from(projectionMatrix) as Mat4;
  // camera position: −Rᵀ·t of the view matrix [R | t]
  const eye: Vec3T = [
    -(v[0] * v[12] + v[1] * v[13] + v[2] * v[14]),
    -(v[4] * v[12] + v[5] * v[13] + v[6] * v[14]),
    -(v[8] * v[12] + v[9] * v[13] + v[10] * v[14]),
  ];
  return {
    view: v,
    proj: p,
    viewProj: multiply4(p, v),
    eye,
    forward: [-v[2], -v[6], -v[10]],
    right: [v[0], v[4], v[8]],
    up: [v[1], v[5], v[9]],
    ortho,
    near,
    far,
  };
}
