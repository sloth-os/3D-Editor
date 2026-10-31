import * as THREE from 'three';

/*
 * Blender-like turntable navigation around a target point (Z up).
 * Camera offset from the target: distance · (cos p · sin y, −cos p · cos y, sin p)
 *   yaw 0, pitch 0   → front view (camera on −Y looking +Y)
 *   yaw 90°          → right view (camera on +X)
 *   pitch 90°        → top view
 */
export interface ViewPose {
  target: THREE.Vector3;
  distance: number;
  yaw: number;
  pitch: number;
  ortho: boolean;
  fovY: number; // radians
}

export const DEFAULT_POSE = (): ViewPose => ({
  target: new THREE.Vector3(0, 0, 0),
  distance: 17,
  yaw: THREE.MathUtils.degToRad(34),
  pitch: THREE.MathUtils.degToRad(21),
  ortho: false,
  fovY: THREE.MathUtils.degToRad(39.6),
});

export function clonePose(p: ViewPose): ViewPose {
  return { ...p, target: p.target.clone() };
}

export function poseDirection(p: ViewPose): THREE.Vector3 {
  const cp = Math.cos(p.pitch);
  return new THREE.Vector3(cp * Math.sin(p.yaw), -cp * Math.cos(p.yaw), Math.sin(p.pitch));
}

export function posePosition(p: ViewPose): THREE.Vector3 {
  return p.target.clone().addScaledVector(poseDirection(p), p.distance);
}

/** Camera basis vectors (right, up, back) for the pose; robust at the poles. */
export function poseBasis(p: ViewPose): { right: THREE.Vector3; up: THREE.Vector3; back: THREE.Vector3 } {
  const back = poseDirection(p);
  const right = new THREE.Vector3(Math.cos(p.yaw), Math.sin(p.yaw), 0);
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  return { right, up, back };
}

export function applyPoseToCamera(
  p: ViewPose,
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  aspect: number,
): void {
  const { right, up, back } = poseBasis(p);
  cam.position.copy(posePosition(p));
  const m = new THREE.Matrix4().makeBasis(right, up, back);
  cam.quaternion.setFromRotationMatrix(m);
  if (cam instanceof THREE.PerspectiveCamera) {
    cam.fov = THREE.MathUtils.radToDeg(p.fovY);
    cam.aspect = aspect;
    cam.near = Math.max(0.01, p.distance / 2000);
    cam.far = Math.max(1000, p.distance * 100);
  } else {
    const h = p.distance * Math.tan(p.fovY / 2);
    cam.top = h;
    cam.bottom = -h;
    cam.left = -h * aspect;
    cam.right = h * aspect;
    cam.near = -Math.max(1000, p.distance * 50);
    cam.far = Math.max(1000, p.distance * 50);
  }
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
}

export function lerpPose(a: ViewPose, b: ViewPose, t: number): ViewPose {
  let dy = b.yaw - a.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return {
    target: a.target.clone().lerp(b.target, t),
    distance: a.distance * Math.pow(b.distance / a.distance, t),
    yaw: a.yaw + dy * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    ortho: t < 0.5 ? a.ortho : b.ortho,
    fovY: a.fovY + (b.fovY - a.fovY) * t,
  };
}

export type AxisView = 'FRONT' | 'BACK' | 'RIGHT' | 'LEFT' | 'TOP' | 'BOTTOM';

export function axisViewAngles(v: AxisView): { yaw: number; pitch: number } {
  const h = Math.PI / 2;
  switch (v) {
    case 'FRONT':
      return { yaw: 0, pitch: 0 };
    case 'BACK':
      return { yaw: Math.PI, pitch: 0 };
    case 'RIGHT':
      return { yaw: h, pitch: 0 };
    case 'LEFT':
      return { yaw: -h, pitch: 0 };
    case 'TOP':
      return { yaw: 0, pitch: h };
    case 'BOTTOM':
      return { yaw: 0, pitch: -h };
  }
}

export function viewLabel(p: ViewPose): string {
  const deg = (r: number) => Math.round(THREE.MathUtils.radToDeg(r));
  const yaw = ((deg(p.yaw) % 360) + 360) % 360;
  const pitch = deg(p.pitch);
  const kind = p.ortho ? 'Orthographic' : 'Perspective';
  if (pitch === 90) return `Top ${kind}`;
  if (pitch === -90) return `Bottom ${kind}`;
  if (pitch === 0) {
    if (yaw === 0) return `Front ${kind}`;
    if (yaw === 180) return `Back ${kind}`;
    if (yaw === 90) return `Right ${kind}`;
    if (yaw === 270) return `Left ${kind}`;
  }
  return `User ${kind}`;
}

/** Converts a pose to the awareness "view" payload. */
export function poseToPresence(p: ViewPose) {
  const pos = posePosition(p);
  const { up } = poseBasis(p);
  return {
    position: [pos.x, pos.y, pos.z] as [number, number, number],
    target: [p.target.x, p.target.y, p.target.z] as [number, number, number],
    up: [up.x, up.y, up.z] as [number, number, number],
    fov: p.fovY,
    ortho: p.ortho,
  };
}

/** Reconstructs a pose from a peer's presence view. */
export function presenceToPose(v: {
  position: number[];
  target: number[];
  fov: number;
  ortho: boolean;
}): ViewPose {
  const pos = new THREE.Vector3(...(v.position as [number, number, number]));
  const target = new THREE.Vector3(...(v.target as [number, number, number]));
  const d = pos.clone().sub(target);
  const distance = Math.max(1e-3, d.length());
  d.divideScalar(distance);
  const pitch = Math.asin(THREE.MathUtils.clamp(d.z, -1, 1));
  const yaw = Math.atan2(d.x, -d.y);
  return { target, distance, yaw, pitch, ortho: v.ortho, fovY: v.fov };
}
