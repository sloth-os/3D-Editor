import type { CameraData } from '../doc/types';

/** Vertical field of view (radians) for a camera at a given aspect ratio (width / height). */
export function cameraFovY(
  cam: Pick<CameraData, 'lens' | 'sensor_width' | 'sensor_fit'>,
  aspect: number,
): number {
  const sensor = cam.sensor_width || 36;
  const fit = cam.sensor_fit === 'AUTO' ? (aspect >= 1 ? 'HORIZONTAL' : 'VERTICAL') : cam.sensor_fit;
  if (fit === 'HORIZONTAL') {
    const fovX = 2 * Math.atan(sensor / (2 * cam.lens));
    return 2 * Math.atan(Math.tan(fovX / 2) / aspect);
  }
  return 2 * Math.atan(sensor / (2 * cam.lens));
}

/** Focal length (mm) giving the requested vertical FOV. */
export function lensFromFovY(fovY: number, aspect: number, sensor = 36): number {
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
  return aspect >= 1 ? sensor / (2 * Math.tan(fovX / 2)) : sensor / (2 * Math.tan(fovY / 2));
}

/** Orthographic half extents for a camera at a given aspect ratio. */
export function orthoHalfExtents(
  cam: Pick<CameraData, 'ortho_scale' | 'sensor_fit'>,
  aspect: number,
): { halfW: number; halfH: number } {
  const s = cam.ortho_scale / 2;
  const fit = cam.sensor_fit === 'AUTO' ? (aspect >= 1 ? 'HORIZONTAL' : 'VERTICAL') : cam.sensor_fit;
  return fit === 'HORIZONTAL' ? { halfW: s, halfH: s / aspect } : { halfW: s * aspect, halfH: s };
}
