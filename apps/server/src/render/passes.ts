import type { Mat4, Vec3 } from '@3d-editor/core';

/*
 * Helpers of director's desk renders in the render process (video export passes, SPEC §9). The
 * per-pixel passes come from the rasterizer (core `RenderAovs`) and are encoded with core's
 * `depthToBytes`, `normalToRGB` and `edgesToBytes` (render/aov.ts); this module adds what is
 * specific to exports:
 * - mask: one byte per pixel, the job's palette index of the object group drawn there (0 = nothing),
 *   from the object pass through a lookup table;
 * - strings (tethers, desk_role 'string' objects): screen-space lines at least 2 px wide drawn into
 *   the pose pass, depth-tested against the depth pass (the beauty image, the mask and the edges
 *   get them from core drawLines, render/desk.ts);
 * - pose: RGB skeletons of the actors on black (OpenPose-18 limb colours for humanoids, a simple
 *   skeleton for quadrupeds);
 * - the camera of a frame and the subjects' screen boxes (FrameMeta).
 * Everything is deterministic and allocation-light: one output buffer per pass and frame.
 */

/** The parts of a resolved render view (core `resolveView`) that project points to pixels. */
export interface Projection {
  /** World → clip (column-major). */
  viewProj: ArrayLike<number>;
  /** World → camera (column-major). */
  view: ArrayLike<number>;
  ortho: boolean;
  /** Near clipping distance (m). */
  near: number;
  width: number;
  height: number;
}

/** A projected point: pixel coordinates (top-left origin, pixel centres at +0.5) and view depth (m). */
export interface ScreenPoint {
  x: number;
  y: number;
  depth: number;
}

/** Depth relative to which a line still counts as in front of the surface drawn at a pixel. */
const LINE_DEPTH_TOLERANCE = 0.02;
/** Absolute part of that tolerance (m): a string inside its own thin tube stays visible. */
const LINE_DEPTH_SLACK = 0.01;

/** Distance in front of the camera plane of world point `v` (m; negative behind it). */
export function viewDepth(p: Pick<Projection, 'view'>, v: Readonly<Vec3>): number {
  const m = p.view;
  return -(m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]);
}

/** Clip-space coordinates of `v` (x, y, w). */
function clip(m: ArrayLike<number>, v: Readonly<Vec3>): [number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15],
  ];
}

/** Pixel position of world point `v` (null when it is not in front of the near plane). */
export function projectPoint(p: Projection, v: Readonly<Vec3>): ScreenPoint | null {
  const depth = viewDepth(p, v);
  if (!(depth >= p.near)) return null;
  const [cx, cy, cw] = clip(p.viewProj, v);
  if (!(Math.abs(cw) > 1e-12)) return null;
  return { x: (cx / cw / 2 + 0.5) * p.width, y: (0.5 - cy / cw / 2) * p.height, depth };
}

/**
 * The part of world segment a–b in front of the near plane, projected (null when none of it is).
 */
export function projectSegment(
  p: Projection,
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
): [ScreenPoint, ScreenPoint] | null {
  const da = viewDepth(p, a);
  const db = viewDepth(p, b);
  const near = p.near;
  if (!(da >= near) && !(db >= near)) return null;
  let a2: Readonly<Vec3> = a;
  let b2: Readonly<Vec3> = b;
  if (da < near || db < near) {
    // move the end behind the near plane onto it
    const t = (near - da) / (db - da);
    const q: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    if (da < near) a2 = q;
    else b2 = q;
  }
  const pa = projectPoint(p, a2) ?? projectPoint(p, nudge(a2, b2));
  const pb = projectPoint(p, b2) ?? projectPoint(p, nudge(b2, a2));
  return pa && pb ? [pa, pb] : null;
}

/** `from` moved a hair towards `to` (a point exactly on the near plane can round behind it). */
function nudge(from: Readonly<Vec3>, to: Readonly<Vec3>): Vec3 {
  const t = 1e-6;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

// ---------------------------------------------------------------- per-pixel passes

/** Mask bytes: the palette index of each pixel's object (`lut[objectIndex]`, 0 = nothing). */
export function maskFromObjects(
  object: ArrayLike<number>,
  lut: ArrayLike<number>,
  out?: Uint8Array,
): Uint8Array {
  const n = object.length;
  const res = out ?? new Uint8Array(n);
  for (let i = 0; i < n; i++) res[i] = lut[object[i]] ?? 0;
  return res;
}

// ---------------------------------------------------------------- lines

/** Receives a covered pixel: its index, coverage (0–1) and the line's view depth there. */
export type PixelPlot = (index: number, coverage: number, depth: number) => void;

/**
 * Rasterizes the screen segment a–b as a line `halfWidth` pixels to each side with round caps
 * (a == b draws a disc): every pixel whose centre is within halfWidth + 0.5 gets `plot` with an
 * anti-aliased coverage. Depth is interpolated perspective-correctly (linearly for orthographic
 * views) between the ends.
 */
export function rasterizeSegment(
  width: number,
  height: number,
  a: ScreenPoint,
  b: ScreenPoint,
  halfWidth: number,
  plot: PixelPlot,
  ortho = false,
): void {
  const r = Math.max(0.5, halfWidth);
  const reach = r + 0.5;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + reach));
  if (y0 > y1 || !Number.isFinite(y0) || !Number.isFinite(y1)) return;
  const ia = 1 / a.depth;
  const ib = 1 / b.depth;
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    // the x-range of the segment's points within `reach` of this row, widened by reach
    let xa: number;
    let xb: number;
    if (Math.abs(dy) < 1e-9) {
      xa = Math.min(a.x, b.x);
      xb = Math.max(a.x, b.x);
    } else {
      const t0 = Math.min(1, Math.max(0, (cy - reach - a.y) / dy));
      const t1 = Math.min(1, Math.max(0, (cy + reach - a.y) / dy));
      // the x at either parameter (a segment may run right to left)
      const xs = a.x + dx * t0;
      const xe = a.x + dx * t1;
      xa = Math.min(xs, xe);
      xb = Math.max(xs, xe);
    }
    const x0 = Math.max(0, Math.floor(xa - reach));
    const x1 = Math.min(width - 1, Math.ceil(xb + reach));
    for (let x = x0; x <= x1; x++) {
      const cx = x + 0.5;
      let t = len2 > 0 ? ((cx - a.x) * dx + (cy - a.y) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + dx * t - cx;
      const py = a.y + dy * t - cy;
      const dist = Math.sqrt(px * px + py * py);
      const coverage = reach - dist;
      if (coverage <= 0) continue;
      const depth = ortho ? a.depth + (b.depth - a.depth) * t : 1 / (ia + (ib - ia) * t);
      plot(y * width + x, coverage >= 1 ? 1 : coverage, depth);
    }
  }
}

/** Whether a line at `depth` is in front of (or at) the surface `surface` drawn at its pixel. */
export function lineVisible(depth: number, surface: number | undefined): boolean {
  if (surface === undefined || !(surface > 0) || surface === Infinity) return true;
  return depth <= surface * (1 + LINE_DEPTH_TOLERANCE) + LINE_DEPTH_SLACK;
}

/**
 * Draws a line into an RGB image, blended by coverage × `alpha`; with `surface`, only where the
 * line is not behind a surface.
 */
export function drawLineRGB(
  buf: Uint8Array,
  width: number,
  height: number,
  a: ScreenPoint,
  b: ScreenPoint,
  halfWidth: number,
  color: readonly [number, number, number],
  alpha = 1,
  surface?: ArrayLike<number>,
  ortho = false,
): void {
  rasterizeSegment(
    width,
    height,
    a,
    b,
    halfWidth,
    (i, coverage, depth) => {
      if (surface && !lineVisible(depth, surface[i])) return;
      const k = coverage * alpha;
      const o = i * 3;
      buf[o] = Math.round(buf[o] + (color[0] - buf[o]) * k);
      buf[o + 1] = Math.round(buf[o + 1] + (color[1] - buf[o + 1]) * k);
      buf[o + 2] = Math.round(buf[o + 2] + (color[2] - buf[o + 2]) * k);
    },
    ortho,
  );
}

/** Width in pixels of string lines at an output height: at least 2 px (3 px at 1080p, 6 px at 4K). */
export function stringLineWidth(height: number): number {
  return Math.max(2, Math.round(height / 360));
}

/**
 * The polyline a string object's evaluated geometry runs along (world space): its end points are
 * the centres of the vertices at either end of its longest extent, and up to `maxPoints` − 2 points
 * in between the centres of its vertices in equal slices along that extent. A thin tube gives its
 * axis, a wire curve its course; fewer than 2 distinct vertices give no line.
 */
export function stringPolyline(positions: ArrayLike<number>, maxPoints = 64): Vec3[] {
  const n = Math.floor(positions.length / 3);
  if (n < 2) return [];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const farthest = (fx: number, fy: number, fz: number): number => {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < n; i++) {
      const d =
        (positions[i * 3] - fx) ** 2 + (positions[i * 3 + 1] - fy) ** 2 + (positions[i * 3 + 2] - fz) ** 2;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const ia = farthest(cx, cy, cz);
  const ax = positions[ia * 3];
  const ay = positions[ia * 3 + 1];
  const az = positions[ia * 3 + 2];
  const ib = farthest(ax, ay, az);
  const ux = positions[ib * 3] - ax;
  const uy = positions[ib * 3 + 1] - ay;
  const uz = positions[ib * 3 + 2] - az;
  const len2 = ux * ux + uy * uy + uz * uz;
  if (!(len2 > 1e-12)) return [];
  const bins = Math.max(2, Math.min(Math.max(2, maxPoints), Math.ceil(n / 4) + 2));
  // slices: the two ends (the first and last 1 % of the extent) and bins − 2 equal ones between
  const sums = new Float64Array(bins * 4);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const t = ((x - ax) * ux + (y - ay) * uy + (z - az) * uz) / len2;
    let k: number;
    if (t <= 0.01) k = 0;
    else if (t >= 0.99) k = bins - 1;
    else k = 1 + Math.min(bins - 3, Math.floor(((t - 0.01) / 0.98) * (bins - 2)));
    if (bins === 2) k = t < 0.5 ? 0 : 1;
    sums[k * 4] += x;
    sums[k * 4 + 1] += y;
    sums[k * 4 + 2] += z;
    sums[k * 4 + 3] += 1;
  }
  const out: Vec3[] = [];
  for (let k = 0; k < bins; k++) {
    const c = sums[k * 4 + 3];
    if (c > 0) out.push([sums[k * 4] / c, sums[k * 4 + 1] / c, sums[k * 4 + 2] / c]);
  }
  return out.length >= 2 ? out : [];
}

/** World positions of a mesh's vertices under `world` (flat xyz). */
export function worldPositions(positions: ArrayLike<number>, world: Readonly<Mat4>): Float64Array {
  const n = Math.floor(positions.length / 3);
  const out = new Float64Array(n * 3);
  const m = world;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    out[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

// ---------------------------------------------------------------- pose skeletons

/**
 * OpenPose-18 keypoints, in order: nose, neck, right shoulder, elbow, wrist, left shoulder, elbow,
 * wrist, right hip, knee, ankle, left hip, knee, ankle, right eye, left eye, right ear, left ear
 * ("right" is the character's right). The limbs join pairs of them.
 */
export const OPENPOSE18_LIMBS: readonly (readonly [number, number])[] = [
  [1, 2],
  [1, 5],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17],
];

/** The colours of OpenPose's body rendering, one per keypoint (limb k uses colour k). */
export const OPENPOSE_COLORS: readonly (readonly [number, number, number])[] = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85],
];

/**
 * Quadruped keypoints (17, the AP-10K animal layout): left eye, right eye, nose, neck, tail root,
 * left shoulder, elbow, front paw, right shoulder, elbow, front paw, left hip, knee, back paw, right
 * hip, knee, back paw. The limbs join pairs of them.
 */
export const QUADRUPED_LIMBS: readonly (readonly [number, number])[] = [
  [0, 2],
  [1, 2],
  [2, 3],
  [3, 4],
  [3, 5],
  [5, 6],
  [6, 7],
  [3, 8],
  [8, 9],
  [9, 10],
  [4, 11],
  [11, 12],
  [12, 13],
  [4, 14],
  [14, 15],
  [15, 16],
];

/** Stick half width and joint radius of skeletons at an output height (OpenPose's 4 px at 512). */
export function skeletonScale(height: number): { stick: number; joint: number } {
  const s = Math.max(1, (height / 512) * 4);
  return { stick: s, joint: s };
}

/**
 * Draws one skeleton on an RGB image: the limbs (60 % opacity, like OpenPose's renderer) then the
 * joints (opaque discs). Points that are null (hidden or missing) and limbs touching them are left
 * out; a quadruped list of another length draws its joints only.
 */
export function drawSkeleton(
  rgb: Uint8Array,
  width: number,
  height: number,
  format: 'openpose18' | 'quadruped',
  points: readonly (ScreenPoint | null)[],
): void {
  const { stick, joint } = skeletonScale(height);
  const limbs =
    format === 'openpose18'
      ? points.length === 18
        ? OPENPOSE18_LIMBS
        : []
      : points.length === 17
        ? QUADRUPED_LIMBS
        : [];
  limbs.forEach(([i, j], k) => {
    const a = points[i];
    const b = points[j];
    if (a && b)
      drawLineRGB(rgb, width, height, a, b, stick, OPENPOSE_COLORS[k % OPENPOSE_COLORS.length], 0.6);
  });
  points.forEach((p, k) => {
    if (p) drawLineRGB(rgb, width, height, p, p, joint, OPENPOSE_COLORS[k % OPENPOSE_COLORS.length], 1);
  });
}

// ---------------------------------------------------------------- frame metadata

/** A subject's box on screen (FrameMeta.subjects). */
export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/**
 * Accumulates the screen box of a subject's vertices (world space): call `add` per vertex block,
 * then `box`. Vertices behind the near plane are left out; the box is clipped to the frame and
 * rounded to whole pixels outward; `visible` when some of it is inside the frame.
 */
export class ScreenBoxBuilder {
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private any = false;

  constructor(private readonly p: Projection) {}

  add(world: ArrayLike<number>): void {
    const p = this.p;
    const m = p.viewProj;
    const v = p.view;
    const n = Math.floor(world.length / 3);
    for (let i = 0; i < n; i++) {
      const x = world[i * 3];
      const y = world[i * 3 + 1];
      const z = world[i * 3 + 2];
      const depth = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
      if (!(depth >= p.near)) continue;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (!(Math.abs(cw) > 1e-12)) continue;
      const sx = (((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw) * 0.5 + 0.5) * p.width;
      const sy = (0.5 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5) * p.height;
      if (sx < this.minX) this.minX = sx;
      if (sx > this.maxX) this.maxX = sx;
      if (sy < this.minY) this.minY = sy;
      if (sy > this.maxY) this.maxY = sy;
      this.any = true;
    }
  }

  /** The box, or null when no vertex was in front of the camera. */
  box(): ScreenBox | null {
    if (!this.any) return null;
    const { width, height } = this.p;
    const x0 = Math.max(0, Math.floor(this.minX));
    const y0 = Math.max(0, Math.floor(this.minY));
    const x1 = Math.min(width, Math.ceil(this.maxX));
    const y1 = Math.min(height, Math.ceil(this.maxY));
    if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: 0, h: 0, visible: false };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, visible: true };
  }
}

/**
 * The camera of a resolved view: its world matrix (camera → world, column-major: right, up, back
 * and the eye as columns) and vertical field of view (radians; 0 for orthographic views).
 */
export function cameraOfView(view: {
  view: ArrayLike<number>;
  proj: ArrayLike<number>;
  eye: Readonly<Vec3>;
  ortho: boolean;
}): { matrix: number[]; fovY: number } {
  const v = view.view;
  // the view matrix is rigid: its upper 3×3 transposed is the camera's rotation
  const matrix = [
    v[0],
    v[4],
    v[8],
    0,
    v[1],
    v[5],
    v[9],
    0,
    v[2],
    v[6],
    v[10],
    0,
    view.eye[0],
    view.eye[1],
    view.eye[2],
    1,
  ];
  const fovY = view.ortho ? 0 : 2 * Math.atan(1 / view.proj[5]);
  return { matrix, fovY };
}
