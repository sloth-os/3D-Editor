import * as THREE from 'three';
import { cameraFovY, multiply4, orthoHalfExtents, type CameraData, type Mat4 } from '@3d-editor/core';
import { applyPoseToCamera, type ViewPose } from '../viewport/navigation';
import type { RenderViewData, Vec3T } from './protocol';

/**
 * Blender's lens shift on a three.js camera's projection (call after `updateProjectionMatrix`, which
 * resets it): the image moves by `shiftX` / `shiftY` times its larger dimension, exactly like core
 * `viewFromCamera`, so rasterized renders frame a shifted camera like the path tracer and the
 * server's renderers.
 */
export function applyLensShift(
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  shiftX: number,
  shiftY: number,
  aspect: number,
): void {
  if (!shiftX && !shiftY) return;
  const sx = 2 * (shiftX || 0) * Math.max(1, 1 / aspect);
  const sy = 2 * (shiftY || 0) * Math.max(1, aspect);
  const e = cam.projectionMatrix.elements;
  for (let c = 0; c < 4; c++) {
    e[c * 4] -= sx * e[c * 4 + 3];
    e[c * 4 + 1] -= sy * e[c * 4 + 3];
  }
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

/**
 * A three.js camera showing a scene camera (its evaluated data and world matrix) in an image of
 * `aspect`: perspective or orthographic with the camera's field of view (sensor fit), clipping range
 * and lens shift; the view core `viewFromCamera` gives the path tracer and the server's renderers.
 */
export function sceneCameraView(
  cam: CameraData,
  world: ArrayLike<number>,
  aspect: number,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const near = Math.max(1e-6, cam.clip_start);
  const far = Math.max(near * 1.001, cam.clip_end);
  let c: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  if (cam.type === 'ORTHO') {
    const e = orthoHalfExtents(cam, aspect);
    c = new THREE.OrthographicCamera(-e.halfW, e.halfW, e.halfH, -e.halfH, near, far);
  } else
    c = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(cameraFovY(cam, aspect)), aspect, near, far);
  new THREE.Matrix4().fromArray(Array.from(world)).decompose(c.position, c.quaternion, new THREE.Vector3());
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  applyLensShift(c, cam.shift_x, cam.shift_y, aspect);
  return c;
}

/**
 * A camera showing the viewport's own view (its navigation pose) in an image of `aspect`:
 * perspective, or orthographic when the viewport is. An orthographic viewport sees everything
 * within its clipping range in front of and behind the view point (negative near plane); with
 * `nearInFront` the camera is moved back by that range instead, so the whole range lies in front of
 * it (the path tracer starts its rays on the near plane).
 */
export function viewportCamera(
  pose: ViewPose,
  aspect: number,
  nearInFront = false,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  if (!pose.ortho) {
    const pc = new THREE.PerspectiveCamera(40, aspect, 0.01, 10000);
    applyPoseToCamera(pose, pc, aspect);
    return pc;
  }
  const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  applyPoseToCamera(pose, oc, aspect);
  if (nearInFront && oc.near < 0) {
    const back = -oc.near;
    oc.position.addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(oc.quaternion), back);
    oc.far += back;
    oc.near = 0;
    oc.updateMatrixWorld(true);
    oc.updateProjectionMatrix();
  }
  return oc;
}

/** The render view of a three.js camera (world matrices up to date). */
export function renderViewFromCamera(
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
): RenderViewData {
  return renderViewFromMatrices(
    cam.matrixWorldInverse.elements,
    cam.projectionMatrix.elements,
    (cam as THREE.OrthographicCamera).isOrthographicCamera === true,
    cam.near,
    cam.far,
  );
}

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
