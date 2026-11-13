import type { Mat4, Vec3 } from '../math/types';
import { lookAt4, multiply4, ortho4, perspective4 } from '../math/mat4';
import { cross3, dot3, normalize3, sub3 } from '../math/vec3';
import type { CameraData } from '../doc/types';
import { cameraFovY, orthoHalfExtents } from '../eval/camera';

/** A resolved camera for rasterization. */
export interface RenderView {
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  /** Camera position (world). */
  eye: Vec3;
  /** Unit view direction (world). */
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  ortho: boolean;
  near: number;
  far: number;
}

export interface ViewSpec {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Vertical field of view in radians. */
  fovY: number;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Direction from the target towards the eye of the default 3/4 view (like Blender's startup camera). */
const AUTO_DIR: Vec3 = normalize3([7.36, -6.93, 4.96]);

/** Vertical FOV of a default 50 mm / 36 mm sensor camera at `aspect`. */
export function defaultFovY(aspect: number): number {
  return cameraFovY({ lens: 50, sensor_width: 36, sensor_fit: 'AUTO' }, aspect);
}

/**
 * Blender-like 3/4 view (from +X −Y +Z) looking at the center of `bounds` from far enough away that
 * the whole box fits the frame (with a small margin) at the given aspect ratio and vertical FOV.
 */
export function autoFrameView(bounds: Bounds | null, aspect: number, fovY = defaultFovY(aspect)): ViewSpec {
  const up: Vec3 = [0, 0, 1];
  if (!bounds) return { position: [7.36, -6.93, 4.96], target: [0, 0, 0], up, fovY };
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const back = AUTO_DIR;
  const right = normalize3(cross3([-back[0], -back[1], -back[2]], up));
  const camUp = cross3(right, [-back[0], -back[1], -back[2]]);
  const margin = 1.1;
  const tanY = Math.tan(fovY / 2) / margin;
  const tanX = tanY * aspect;
  let dist = 0;
  let maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const c: Vec3 = [
      i & 1 ? bounds.max[0] : bounds.min[0],
      i & 2 ? bounds.max[1] : bounds.min[1],
      i & 4 ? bounds.max[2] : bounds.min[2],
    ];
    const rel = sub3(c, center);
    const x = Math.abs(dot3(rel, right));
    const y = Math.abs(dot3(rel, camUp));
    const z = dot3(rel, back);
    maxZ = Math.max(maxZ, z);
    dist = Math.max(dist, z + x / tanX, z + y / tanY);
  }
  const size = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  dist = Math.max(dist, maxZ + Math.max(size * 0.05, 1e-3));
  if (size < 1e-9) dist = 5;
  return {
    position: [center[0] + back[0] * dist, center[1] + back[1] * dist, center[2] + back[2] * dist],
    target: center,
    up,
    fovY,
  };
}

/** Near/far planes that enclose `bounds` as seen from a view (view matrix rows give depth). */
function depthRange(view: Mat4, bounds: Bounds | null): { near: number; far: number } {
  if (!bounds) return { near: 0.01, far: 1000 };
  let dmin = Infinity;
  let dmax = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? bounds.max[0] : bounds.min[0];
    const y = i & 2 ? bounds.max[1] : bounds.min[1];
    const z = i & 4 ? bounds.max[2] : bounds.min[2];
    const d = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
    dmin = Math.min(dmin, d);
    dmax = Math.max(dmax, d);
  }
  const far = Math.max(dmax * 1.05, 1e-3) + 1e-3;
  // Depth uses 1/w (perspective) so a small near plane costs no precision.
  const near = dmin > 0 ? Math.max(dmin * 0.5, far * 1e-6) : far * 1e-6;
  return { near, far };
}

function finish(view: Mat4, proj: Mat4, eye: Vec3, ortho: boolean, near: number, far: number): RenderView {
  return {
    view,
    proj,
    viewProj: multiply4(proj, view),
    eye,
    forward: [-view[2], -view[6], -view[10]],
    right: [view[0], view[4], view[8]],
    up: [view[1], view[5], view[9]],
    ortho,
    near,
    far,
  };
}

/** Perspective view from a look-at specification. */
export function viewFromSpec(spec: ViewSpec, aspect: number, bounds: Bounds | null): RenderView {
  const view = lookAt4(spec.position, spec.target, spec.up);
  const { near, far } = depthRange(view, bounds);
  return finish(
    view,
    perspective4(spec.fovY, aspect, near, far),
    [...spec.position] as Vec3,
    false,
    near,
    far,
  );
}

/**
 * Orthographic view from `eye` along the unit direction `forward` (`up` picks the roll; any vector
 * not parallel to `forward`), covering [left, right] × [bottom, top] of the view plane and the
 * depths [near, far] along `forward` (either may be negative: behind `eye`). Shadow maps of suns.
 */
export function orthoView(
  eye: Vec3,
  forward: Vec3,
  up: Vec3,
  extent: { left: number; right: number; bottom: number; top: number; near: number; far: number },
): RenderView {
  const view = lookAt4(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], up);
  const { left, right, bottom, top, near, far } = extent;
  return finish(view, ortho4(left, right, bottom, top, near, far), [...eye] as Vec3, true, near, far);
}

/** View of a camera object (world matrix may contain scale; only position and orientation are used). */
export function viewFromCamera(cam: CameraData, world: Mat4, aspect: number): RenderView {
  const eye: Vec3 = [world[12], world[13], world[14]];
  const z = normalize3([world[8], world[9], world[10]]);
  let x: Vec3 = [world[0], world[1], world[2]];
  const xz = dot3(x, z);
  x = normalize3([x[0] - z[0] * xz, x[1] - z[1] * xz, x[2] - z[2] * xz]);
  const y = cross3(z, x);
  const view: Mat4 = [
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot3(x, eye),
    -dot3(y, eye),
    -dot3(z, eye),
    1,
  ];
  const near = Math.max(1e-6, cam.clip_start);
  const far = Math.max(near * 1.001, cam.clip_end);
  let proj: Mat4;
  if (cam.type === 'ORTHO') {
    const { halfW, halfH } = orthoHalfExtents(cam, aspect);
    proj = ortho4(-halfW, halfW, -halfH, halfH, near, far);
  } else proj = perspective4(cameraFovY(cam, aspect), aspect, near, far);
  // Lens shift is expressed in units of the larger frame dimension (Blender convention).
  if (cam.shift_x || cam.shift_y) {
    const sx = 2 * cam.shift_x * Math.max(1, 1 / aspect);
    const sy = 2 * cam.shift_y * Math.max(1, aspect);
    for (let c = 0; c < 4; c++) {
      proj[c * 4] -= sx * proj[c * 4 + 3];
      proj[c * 4 + 1] -= sy * proj[c * 4 + 3];
    }
  }
  return finish(view, proj, eye, cam.type === 'ORTHO', near, far);
}
