import type { CameraData } from '../../doc/types';
import { invert4 } from '../../math/mat4';
import type { RenderView } from '../view';

/**
 * Camera of the path tracer, derived from the same `RenderView` as the rasterizer (so lens shift,
 * sensor fit, orthographic scale and clipping match exactly). Rays start on the near clipping
 * plane and end on the far plane. Depth of field (perspective cameras with `dof_use`) samples a
 * circular aperture of radius `lens / (2 · f-stop)` (mm → m) focused at `dof_focus_distance`.
 */
export interface CameraModel {
  ortho: boolean;
  width: number;
  height: number;
  eye: [number, number, number];
  /** Camera → world rotation (columns: right, up, back), 9 floats column-major. */
  rot: number[];
  /** Inverse projection matrix (column-major). */
  invProj: number[];
  near: number;
  far: number;
  lensRadius: number;
  focusDistance: number;
}

const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);

export function buildCamera(
  view: RenderView,
  cam: CameraData | null,
  width: number,
  height: number,
): CameraModel {
  const m = view.view;
  const rot = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  let invProj = invert4(view.proj);
  if (!invProj.every(Number.isFinite)) invProj = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let lensRadius = 0;
  let focusDistance = 1;
  if (cam && cam.dof_use && !view.ortho) {
    const fstop = finite(cam.dof_aperture_fstop, 0);
    const lens = finite(cam.lens, 50);
    if (fstop > 0 && lens > 0) lensRadius = (0.5 * lens * 1e-3) / fstop;
    focusDistance = Math.max(1e-4, finite(cam.dof_focus_distance, 10));
  }
  return {
    ortho: view.ortho,
    width,
    height,
    eye: [view.eye[0], view.eye[1], view.eye[2]],
    rot,
    invProj,
    near: Math.max(0, finite(view.near, 0)),
    far: Math.max(finite(view.far, 1e30), 0),
    lensRadius,
    focusDistance,
  };
}

/** Generates primary rays into its public fields (no allocations). */
export class CameraRays {
  ox = 0;
  oy = 0;
  oz = 0;
  dx = 0;
  dy = 0;
  dz = -1;
  tMax = Infinity;
  /** Unit view axis (world), for depth AOVs. */
  readonly fx: number;
  readonly fy: number;
  readonly fz: number;

  /** Pixel footprint: angle per pixel (perspective) or world size of a pixel (orthographic). */
  private readonly spread: number;

  constructor(readonly cam: CameraModel) {
    const r = cam.rot;
    this.fx = -r[6];
    this.fy = -r[7];
    this.fz = -r[8];
    // rays through two vertically adjacent pixels at the image centre
    const P = cam.invProj;
    const near = (y: number): number[] => {
      const w = P[7] * y - P[11] + P[15];
      return [(P[4] * y - P[8] + P[12]) / w, (P[5] * y - P[9] + P[13]) / w, (P[6] * y - P[10] + P[14]) / w];
    };
    const a = near(0);
    const b = near(2 / Math.max(1, cam.height));
    let spread: number;
    if (cam.ortho) spread = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    else {
      const la = Math.hypot(a[0], a[1], a[2]);
      const lb = Math.hypot(b[0], b[1], b[2]);
      const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
      spread = Math.acos(Math.max(-1, Math.min(1, c)));
    }
    this.spread = Number.isFinite(spread) ? spread : 0;
  }

  /** Approximate width (world units) of one pixel at distance `d` along a camera path. */
  footprint(d: number): number {
    return this.cam.ortho ? this.spread : this.spread * d;
  }

  /**
   * Ray through film position (px, py) in pixels (y down, pixel centres at +0.5); `lu`, `lv` in
   * [0, 1) pick the point on the aperture. Returns false for degenerate cameras.
   */
  generate(px: number, py: number, lu: number, lv: number): boolean {
    const c = this.cam;
    const x = (2 * px) / c.width - 1;
    const y = 1 - (2 * py) / c.height;
    const P = c.invProj;
    // near-plane point in camera space
    const w = P[3] * x + P[7] * y - P[11] + P[15];
    const nx = (P[0] * x + P[4] * y - P[8] + P[12]) / w;
    const ny = (P[1] * x + P[5] * y - P[9] + P[13]) / w;
    const nz = (P[2] * x + P[6] * y - P[10] + P[14]) / w;
    let ox: number;
    let oy: number;
    let oz: number;
    let dx: number;
    let dy: number;
    let dz: number;
    let tMax: number;
    if (c.ortho) {
      ox = nx;
      oy = ny;
      oz = nz;
      dx = 0;
      dy = 0;
      dz = -1;
      tMax = c.far - c.near;
    } else {
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      dx = nx / l;
      dy = ny / l;
      dz = nz / l;
      if (c.lensRadius > 0 && dz < 0) {
        // thin lens: aim at the point on the focal plane, start on the aperture
        const ft = c.focusDistance / -dz;
        const fx = dx * ft;
        const fy = dy * ft;
        const fz = dz * ft;
        // concentric disc mapping
        const a = 2 * lu - 1;
        const b = 2 * lv - 1;
        let r = 0;
        let phi = 0;
        if (a !== 0 || b !== 0) {
          if (Math.abs(a) > Math.abs(b)) {
            r = a;
            phi = (Math.PI / 4) * (b / a);
          } else {
            r = b;
            phi = Math.PI / 2 - (Math.PI / 4) * (a / b);
          }
        }
        const lx = c.lensRadius * r * Math.cos(phi);
        const ly = c.lensRadius * r * Math.sin(phi);
        dx = fx - lx;
        dy = fy - ly;
        dz = fz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= dl;
        dy /= dl;
        dz /= dl;
        // start where the ray crosses the near plane
        const t0 = c.near / -dz;
        ox = lx + dx * t0;
        oy = ly + dy * t0;
        oz = dz * t0;
        tMax = (c.far - c.near) / -dz;
      } else {
        ox = nx;
        oy = ny;
        oz = nz;
        tMax = dz < 0 ? (c.far - c.near) / -dz : Infinity;
      }
    }
    const R = c.rot;
    this.ox = c.eye[0] + R[0] * ox + R[3] * oy + R[6] * oz;
    this.oy = c.eye[1] + R[1] * ox + R[4] * oy + R[7] * oz;
    this.oz = c.eye[2] + R[2] * ox + R[5] * oy + R[8] * oz;
    this.dx = R[0] * dx + R[3] * dy + R[6] * dz;
    this.dy = R[1] * dx + R[4] * dy + R[7] * dz;
    this.dz = R[2] * dx + R[5] * dy + R[8] * dz;
    this.tMax = tMax > 0 ? tMax : Infinity;
    return (
      Number.isFinite(this.ox) &&
      Number.isFinite(this.oy) &&
      Number.isFinite(this.oz) &&
      Number.isFinite(this.dx) &&
      Number.isFinite(this.dy) &&
      Number.isFinite(this.dz)
    );
  }
}
