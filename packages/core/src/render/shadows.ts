import type { Vec3 } from '../math/types';
import { invert4, lookAt4 } from '../math/mat4';
import type { Bounds, RenderView } from './view';
import { orthoView, viewFromSpec } from './view';

/*
 * Shadow maps of the CPU rasterizer (`SoftwareRenderOptions.shadows`): one orthographic map per sun
 * (SUN lamps and the SKY world's sun) and one perspective map per spot light, rendered depth-only
 * before the main view and looked up while shading each light.
 *
 * Sun maps are fitted like the WebGL viewport's (apps/web/src/viewport/sun-shadow.ts, same
 * constants): the receivers are what the camera sees up to SHADOW_DISTANCE_SCALE × the median
 * distance at which the visible objects start (or a given box, the same for every frame of a shot),
 * the casters everything between them and the sun. The map's size changes in eighth-octave steps,
 * its texels are square (2048 along the longer side) and its centre sits on the texel grid, so the
 * texels stay put while the view moves a little and do not move at all over a shot with a fixed box.
 *
 * Lookups use percentage-closer filtering whose radius comes from the light's size: a
 * percentage-closer soft shadow search (average blocker depth → penumbra) for spot lights and wide
 * suns, a fixed 1.5 texels for suns whose penumbra stays under a texel. Radii up to 2 texels are a
 * tent filter over every texel they reach (smooth, noise-free, 4 to 16 reads); wider penumbrae take
 * 32 bilinear taps in a disc rotated by an integer hash of the pixel (deterministic; the 4 outer
 * taps decide alone when they agree).
 * Acne is avoided without detaching shadows from their casters: every tap compares against the
 * receiver's own plane extrapolated to that texel's centre (receiver-plane depth bias: exact on
 * planes whatever their slope), the lookup point is lifted along the face normal by half a texel and
 * a quarter-texel constant bias covers curvature. Glass and alpha-blended surfaces cast no shadow
 * (the depth pass skips them); alpha-clipped ones cast their clipped shape.
 */

/** Width and height (longer side) of a sun's shadow map in texels (as the WebGL viewport's). */
export const SUN_SHADOW_MAP_SIZE = 2048;
/** Width and height of a spot light's shadow map in texels. */
export const SPOT_SHADOW_MAP_SIZE = 1024;
/** Sun shadows reach this many times the median distance at which the visible objects start. */
export const SHADOW_DISTANCE_SCALE = 4;
/** Smallest filter radius in texels (anti-aliased shadow edges). */
export const MIN_FILTER_TEXELS = 1.5;
/** Largest filter radius in texels of sun and spot maps. */
const MAX_SUN_FILTER_TEXELS = 8;
const MAX_SPOT_FILTER_TEXELS = 16;
/** Lookups are lifted this many texels along the face normal (beyond the receiver-plane bias). */
const NORMAL_OFFSET_TEXELS = 0.5;
/** Constant depth bias in texels (curvature within the filter disc, float rounding). */
const DEPTH_BIAS_TEXELS = 0.25;
/** Faces this close to edge-on to the light (|n·l|) are treated as at this angle (bias bound). */
const MIN_FACING = 0.05;
/** A sun gets the soft-shadow search when a blocker this far above a receiver blurs its shadow. */
const SUN_PCSS_HEIGHT = 4;
/** Spot maps cover the cone plus this margin (radians) so the filter never runs off their edge. */
const SPOT_FOV_MARGIN = (6 * Math.PI) / 180;
/** Widest spot cone a map can cover (radians); wider cones are lit without shadows outside it. */
const MAX_SPOT_FOV = (160 * Math.PI) / 180;

/** A light's shadow map and how to filter it (see the module comment). */
export interface ShadowMap {
  /** Orthographic (sun) or perspective (spot). */
  ortho: boolean;
  width: number;
  height: number;
  /** Distance along the light axis per texel (row-major, top row first); Infinity: nothing. */
  depth: Float32Array;
  /** World → clip transform of the map's depth pass (column-major). */
  viewProj: Float64Array;
  /** Light view origin and basis (world): right, up and forward (the direction light travels). */
  ox: number;
  oy: number;
  oz: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
  fx: number;
  fy: number;
  fz: number;
  /** Texels per metre (orthographic) or per unit of x / depth (perspective), along u and v. */
  su: number;
  sv: number;
  /** Depth range the map covers. */
  near: number;
  far: number;
  /** Search blockers to size the filter (percentage-closer soft shadows). */
  pcss: boolean;
  /** Sun: tangent of its angular radius; spot: the emitter's radius in metres. */
  soft: number;
  /** Filter radius bounds in texels. */
  minRadius: number;
  maxRadius: number;
}

/** What a shadow map's depth pass draws: a view and a texel size; returns depth keys per texel. */
export type DepthPass = (view: RenderView, width: number, height: number) => Float32Array;

/** One of `SoftwareRenderOptions.shadows`' lights, as `buildLights` packs it. */
export type ShadowCaster =
  | { kind: 'sun'; toLight: Vec3; angularRadius: number }
  | { kind: 'spot'; position: Vec3; direction: Vec3; spotSize: number; radius: number };

// ---------------------------------------------------------------------------------------- build

/** Up vector for a light looking along `forward`: world Z unless (nearly) parallel, then Y. */
function upFor(forward: Vec3): Vec3 {
  return Math.abs(forward[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
}

function emptyMap(
  ortho: boolean,
  view: RenderView,
  width: number,
  height: number,
  near: number,
  far: number,
): ShadowMap {
  const V = view.view;
  return {
    ortho,
    width,
    height,
    depth: new Float32Array(0),
    viewProj: Float64Array.from(view.viewProj),
    ox: view.eye[0],
    oy: view.eye[1],
    oz: view.eye[2],
    rx: V[0],
    ry: V[4],
    rz: V[8],
    ux: V[1],
    uy: V[5],
    uz: V[9],
    fx: -V[2],
    fy: -V[6],
    fz: -V[10],
    su: (view.proj[0] * width) / 2,
    sv: (view.proj[5] * height) / 2,
    near,
    far,
    pcss: false,
    soft: 0,
    minRadius: MIN_FILTER_TEXELS,
    maxRadius: MAX_SUN_FILTER_TEXELS,
  };
}

/**
 * Converts the depth keys of a map's depth pass in place (1/w for perspective, 1 − z_ndc for
 * orthographic views, larger is closer, 0 nothing) to distances along the light axis.
 */
function keysToDepth(keys: Float32Array, ortho: boolean, near: number, far: number): Float32Array {
  const n = keys.length;
  if (ortho) {
    // ((1 - k)(far - near) + far + near) / 2
    const s = (far - near) / 2;
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      keys[i] = k > 0 ? far - k * s : Infinity;
    }
  } else
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      keys[i] = k > 0 ? 1 / k : Infinity;
    }
  return keys;
}

/**
 * The shadow map of a sun shining along `-toLight`: fitted to what `camera` sees of `boxes` (the
 * world bounds of every drawn item) or to `fit`, rendered by `pass`. Null without geometry to
 * shadow.
 */
export function buildSunShadow(
  caster: { toLight: Vec3; angularRadius: number },
  camera: RenderView,
  boxes: readonly Bounds[],
  fit: Bounds | null,
  pass: DepthPass,
): ShadowMap | null {
  const t = caster.toLight;
  const tl = Math.hypot(t[0], t[1], t[2]);
  if (!(tl > 0)) return null;
  const forward: Vec3 = [-t[0] / tl, -t[1] / tl, -t[2] / tl];
  const up = upFor(forward);
  const origin: Vec3 = [0, 0, 0];
  const basis = lookAt4(origin, forward, up);
  const R: Vec3 = [basis[0], basis[4], basis[8]];
  const U: Vec3 = [basis[1], basis[5], basis[9]];
  const extent = fitSunShadow(R, U, forward, camera, boxes, fit, MAX_SUN_FILTER_TEXELS, SUN_SHADOW_MAP_SIZE);
  if (!extent) return null;
  const view = orthoView(origin, forward, up, extent);
  const map = emptyMap(true, view, extent.width, extent.height, extent.near, extent.far);
  map.depth = keysToDepth(pass(view, extent.width, extent.height), true, extent.near, extent.far);
  const soft = Math.tan(Math.min(0.3, Math.max(0, caster.angularRadius)));
  map.soft = soft;
  map.pcss = soft * SUN_PCSS_HEIGHT * map.su > MIN_FILTER_TEXELS;
  map.maxRadius = MAX_SUN_FILTER_TEXELS;
  return map;
}

/**
 * The shadow map of a spot light (cone `spotSize`, emitter `radius`): a perspective map from the
 * lamp along its axis, depths fitted to `sceneBounds`, rendered by `pass`.
 */
export function buildSpotShadow(
  caster: { position: Vec3; direction: Vec3; spotSize: number; radius: number },
  sceneBounds: Bounds | null,
  pass: DepthPass,
): ShadowMap | null {
  const d = caster.direction;
  const dl = Math.hypot(d[0], d[1], d[2]);
  if (!(dl > 0) || !sceneBounds) return null;
  const forward: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
  const p = caster.position;
  const fov = Math.min(MAX_SPOT_FOV, Math.max(1e-3, caster.spotSize) + SPOT_FOV_MARGIN);
  const view = viewFromSpec(
    {
      position: p,
      target: [p[0] + forward[0], p[1] + forward[1], p[2] + forward[2]],
      up: upFor(forward),
      fovY: fov,
    },
    1,
    sceneBounds,
  );
  const size = SPOT_SHADOW_MAP_SIZE;
  const map = emptyMap(false, view, size, size, view.near, view.far);
  map.depth = keysToDepth(pass(view, size, size), false, view.near, view.far);
  map.soft = Math.max(0, caster.radius);
  map.pcss = map.soft > 1e-4;
  map.maxRadius = MAX_SPOT_FILTER_TEXELS;
  return map;
}

// ---------------------------------------------------------------------------------- sun fitting

/** The fitted extent of a sun's map in its light space (metres) and its size in texels. */
export interface SunShadowExtent {
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
  width: number;
  height: number;
  /** World size of a texel (square). */
  texel: number;
}

/** `size` rounded up to the next eighth of an octave (the map keeps its size while the view moves a little). */
function quantize(size: number): number {
  return 2 ** (Math.ceil(Math.log2(Math.max(size, 1e-4)) * 8) / 8);
}

/** A plane a·x + b·y + c·z + d ≥ 0 (inside), normalized. */
type Plane = [number, number, number, number];

/** Corner `i` of a box: bit 0 picks x, bit 1 y and bit 2 z (min or max). */
function corner(b: Bounds, i: number): Vec3 {
  return [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
}

/** The faces of a box as cycles of `corner` indices. */
const BOX_FACES = [
  [0, 2, 6, 4],
  [1, 5, 7, 3],
  [0, 4, 5, 1],
  [2, 3, 7, 6],
  [0, 1, 3, 2],
  [4, 6, 7, 5],
];

const planeDist = (pl: Plane, p: Vec3) => pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3];

/** Whether a box (centre `c`, half size `h`) lies inside `pl`. */
function boxInsidePlane(pl: Plane, c: Vec3, h: Vec3): boolean {
  return planeDist(pl, c) >= Math.abs(pl[0]) * h[0] + Math.abs(pl[1]) * h[1] + Math.abs(pl[2]) * h[2];
}

/** Whether a box (centre `c`, half size `h`) lies wholly outside `pl`. */
function boxOutsidePlane(pl: Plane, c: Vec3, h: Vec3): boolean {
  return planeDist(pl, c) < -(Math.abs(pl[0]) * h[0] + Math.abs(pl[1]) * h[1] + Math.abs(pl[2]) * h[2]);
}

/** The part of a convex polygon inside `pl` (Sutherland–Hodgman). */
function clipPolygon(poly: Vec3[], pl: Plane): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = planeDist(pl, a);
    const db = planeDist(pl, b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/**
 * Vertices of the part of `box` inside every plane; `regionCorners` are the corners of the region
 * the planes bound (those inside the box are vertices too). Empty when the box lies outside.
 */
function clipBox(box: Bounds, planes: readonly Plane[], regionCorners: readonly Vec3[]): Vec3[] {
  const c: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const h: Vec3 = [
    (box.max[0] - box.min[0]) / 2,
    (box.max[1] - box.min[1]) / 2,
    (box.max[2] - box.min[2]) / 2,
  ];
  const cutting = planes.filter((pl) => !boxInsidePlane(pl, c, h));
  const corners = Array.from({ length: 8 }, (_, i) => corner(box, i));
  if (!cutting.length) return corners;
  const out: Vec3[] = [];
  for (const face of BOX_FACES) {
    let poly = face.map((i) => corners[i]);
    for (const pl of cutting) {
      poly = clipPolygon(poly, pl);
      if (!poly.length) break;
    }
    for (const p of poly) out.push(p);
  }
  const eps = 1e-9;
  for (const p of regionCorners)
    if (
      p[0] >= box.min[0] - eps &&
      p[0] <= box.max[0] + eps &&
      p[1] >= box.min[1] - eps &&
      p[1] <= box.max[1] + eps &&
      p[2] >= box.min[2] - eps &&
      p[2] <= box.max[2] + eps
    )
      out.push([...p] as Vec3);
  return out;
}

/** The six planes of a view's frustum (inside: positive), from its view-projection matrix. */
function frustumPlanes(view: RenderView): Plane[] {
  const m = view.viewProj;
  const row = (i: number): Plane => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);
  const planes: Plane[] = [];
  for (const [r, s] of [
    [r0, 1],
    [r0, -1],
    [r1, 1],
    [r1, -1],
    [r2, 1],
    [r2, -1],
  ] as [Plane, number][]) {
    const p: Plane = [r3[0] + s * r[0], r3[1] + s * r[1], r3[2] + s * r[2], r3[3] + s * r[3]];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    planes.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
  }
  return planes;
}

/** World corners of a view's frustum: its four corner rays from the near plane to the far plane (near, far pairs). */
function frustumCorners(view: RenderView, maxDepth = Infinity): Vec3[] {
  const M = invert4(view.viewProj);
  const unproject = (x: number, y: number, z: number): Vec3 => {
    const w = M[3] * x + M[7] * y + M[11] * z + M[15];
    return [
      (M[0] * x + M[4] * y + M[8] * z + M[12]) / w,
      (M[1] * x + M[5] * y + M[9] * z + M[13]) / w,
      (M[2] * x + M[6] * y + M[10] * z + M[14]) / w,
    ];
  };
  const depth = (p: Vec3) => viewDepth(view, p);
  const out: Vec3[] = [];
  for (const [x, y] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const n = unproject(x, y, -1);
    let f = unproject(x, y, 1);
    const dn = depth(n);
    const df = depth(f);
    if (df > maxDepth && df > dn) {
      const t = Math.max(0, (maxDepth - dn) / (df - dn));
      f = [n[0] + (f[0] - n[0]) * t, n[1] + (f[1] - n[1]) * t, n[2] + (f[2] - n[2]) * t];
    }
    out.push(n, f);
  }
  return out;
}

/** Distance of `p` in front of the view's eye along its viewing direction. */
function viewDepth(view: RenderView, p: Vec3): number {
  const e = view.eye;
  const f = view.forward;
  return (p[0] - e[0]) * f[0] + (p[1] - e[1]) * f[1] + (p[2] - e[2]) * f[2];
}

/**
 * Fits a sun's orthographic shadow map (light space: x along `R`, y along `U`, depth along `F`, the
 * direction light travels) to what `camera` sees of `boxes` (port of the WebGL viewport's
 * `fitSunShadow`, see the module comment), or to `fit` when given; `filterTexels` is the widest
 * filter radius (margin). Null when there is nothing to receive shadows.
 */
export function fitSunShadow(
  R: Vec3,
  U: Vec3,
  F: Vec3,
  camera: RenderView,
  boxes: readonly Bounds[],
  fit: Bounds | null,
  filterTexels: number,
  mapSize: number,
): SunShadowExtent | null {
  const count = boxes.length;
  if (!count && !fit) return null;
  // every box's extent in light space: x, y and the depth along the light
  const lightBox = new Float64Array(6 * count);
  const axes = [R, U, F];
  const extentOf = (b: Bounds, out: Float64Array, o: number) => {
    const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const h: Vec3 = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
    for (let k = 0; k < 3; k++) {
      const a = axes[k];
      const mid = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
      const r = Math.abs(a[0]) * h[0] + Math.abs(a[1]) * h[1] + Math.abs(a[2]) * h[2];
      out[o + 2 * k] = mid - r;
      out[o + 2 * k + 1] = mid + r;
    }
  };
  for (let i = 0; i < count; i++) extentOf(boxes[i], lightBox, 6 * i);

  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let d0 = Infinity;
  let d1 = -Infinity;
  let received = 0;
  const receivePoint = (p: Vec3) => {
    const x = R[0] * p[0] + R[1] * p[1] + R[2] * p[2];
    const y = U[0] * p[0] + U[1] * p[1] + U[2] * p[2];
    const d = F[0] * p[0] + F[1] * p[1] + F[2] * p[2];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    d0 = Math.min(d0, d);
    d1 = Math.max(d1, d);
    received++;
  };
  const receiveExtent = (e: Float64Array, o: number) => {
    x0 = Math.min(x0, e[o]);
    x1 = Math.max(x1, e[o + 1]);
    y0 = Math.min(y0, e[o + 2]);
    y1 = Math.max(y1, e[o + 3]);
    d0 = Math.min(d0, e[o + 4]);
    d1 = Math.max(d1, e[o + 5]);
    received++;
  };

  if (fit) {
    const e = new Float64Array(6);
    extentOf(fit, e, 0);
    receiveExtent(e, 0);
  } else {
    const planes = frustumPlanes(camera);
    const corners = frustumCorners(camera);
    // the part of each box in view and the view depths it spans
    const visible: { i: number; points: Vec3[] | null; start: number; end: number }[] = [];
    const F0 = camera.forward;
    for (let i = 0; i < count; i++) {
      const b = boxes[i];
      const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const h: Vec3 = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
      if (planes.some((pl) => boxOutsidePlane(pl, c, h))) continue;
      if (planes.every((pl) => boxInsidePlane(pl, c, h))) {
        const mid = viewDepth(camera, c);
        const r = Math.abs(F0[0]) * h[0] + Math.abs(F0[1]) * h[1] + Math.abs(F0[2]) * h[2];
        visible.push({ i, points: null, start: mid - r, end: mid + r });
        continue;
      }
      const points = clipBox(b, planes, corners);
      if (!points.length) continue;
      let start = Infinity;
      let end = -Infinity;
      for (const p of points) {
        const d = viewDepth(camera, p);
        start = Math.min(start, d);
        end = Math.max(end, d);
      }
      visible.push({ i, points, start, end });
    }
    const receive = (v: (typeof visible)[number]) =>
      v.points ? v.points.forEach(receivePoint) : receiveExtent(lightBox, 6 * v.i);
    let shadowDistance = Infinity;
    if (visible.length) {
      if (!camera.ortho) {
        // where the visible objects start; boxes the camera is in (a room, a sky dome) start at
        // the near plane and say nothing about where the scene is
        const nearPlane = Math.max(
          0,
          Math.min(...corners.filter((_, i) => i % 2 === 0).map((p) => viewDepth(camera, p))),
        );
        const starts = Float64Array.from(visible, (v) => v.start).sort();
        const outside = starts.filter((d) => d > 1.5 * nearPlane + 1e-6);
        const ref = outside.length ? outside : starts;
        shadowDistance = SHADOW_DISTANCE_SCALE * Math.max(ref[ref.length >> 1], nearPlane, 1e-4);
      }
      if (visible.every((v) => v.end <= shadowDistance)) visible.forEach(receive);
      else {
        const e = camera.eye;
        const cap: Plane = [
          -F0[0],
          -F0[1],
          -F0[2],
          shadowDistance + F0[0] * e[0] + F0[1] * e[1] + F0[2] * e[2],
        ];
        const capped = [...planes, cap];
        const cappedCorners = frustumCorners(camera, shadowDistance);
        for (const v of visible) {
          if (v.start > shadowDistance) continue;
          if (v.end <= shadowDistance) receive(v);
          else clipBox(boxes[v.i], capped, cappedCorners).forEach(receivePoint);
        }
      }
      if (!received) visible.forEach(receive);
    } else {
      // nothing in view (no shadow can be seen): the whole scene
      for (let i = 0; i < count; i++) receiveExtent(lightBox, 6 * i);
    }
  }
  if (!received || !Number.isFinite(x0 + x1 + y0 + y1 + d0 + d1)) return null;

  // margin for the filter, a size that changes in steps, square texels and a centre on the texel
  // grid: the shadow edges stay put while the view moves a little (and over a shot with `fit`)
  const pad = (Math.max(x1 - x0, y1 - y0, 1e-3) * (filterTexels + 2)) / mapSize;
  const w = quantize(x1 - x0 + 2 * pad);
  const h = quantize(y1 - y0 + 2 * pad);
  const texel = Math.max(w, h) / mapSize;
  const width = Math.min(mapSize, 2 * Math.ceil(w / texel / 2 - 1e-9));
  const height = Math.min(mapSize, 2 * Math.ceil(h / texel / 2 - 1e-9));
  const cx = Math.round((x0 + x1) / 2 / texel) * texel;
  const cy = Math.round((y0 + y1) / 2 / texel) * texel;
  const left = cx - (width / 2) * texel;
  const right = cx + (width / 2) * texel;
  const bottom = cy - (height / 2) * texel;
  const top = cy + (height / 2) * texel;

  // the casters: whatever lies between the receivers and the sun inside the map's footprint
  let near = d0;
  for (let i = 0; i < count; i++) {
    const o = 6 * i;
    if (lightBox[o + 1] < left || lightBox[o] > right || lightBox[o + 3] < bottom || lightBox[o + 2] > top)
      continue;
    if (lightBox[o + 4] < near) near = lightBox[o + 4];
  }
  const margin = Math.max(0.05, 0.01 * (d1 - near));
  return { left, right, bottom, top, near: near - margin, far: d1 + margin, width, height, texel };
}

// ---------------------------------------------------------------------------------- lookups

/** Filter radii up to this many texels use the tent filter over every texel they reach. */
const TENT_MAX_TEXELS = 2;
/**
 * Disc of wide penumbrae: 4 outer taps first (they decide alone when they agree), then 28 inner
 * ones (a Vogel spiral), unit radius; each tap compares bilinearly (2 × 2 texels).
 */
const PCF_TAPS = (() => {
  const t: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = ((i + 0.5) * Math.PI) / 2;
    t.push(0.9 * Math.cos(a), 0.9 * Math.sin(a));
  }
  for (let i = 0; i < 28; i++) {
    const r = 0.88 * Math.sqrt((i + 0.5) / 28);
    const a = i * 2.399963229728653;
    t.push(r * Math.cos(a), r * Math.sin(a));
  }
  return Float64Array.from(t);
})();
const PCF_COUNT = PCF_TAPS.length / 2;
/** Blocker search disc (Vogel spiral of 16 taps, unit radius). */
const SEARCH_TAPS = (() => {
  const t: number[] = [];
  for (let i = 0; i < 16; i++) {
    const r = Math.sqrt((i + 0.5) / 16);
    const a = i * 2.399963229728653 + 0.7;
    t.push(r * Math.cos(a), r * Math.sin(a));
  }
  return Float64Array.from(t);
})();
const SEARCH_COUNT = SEARCH_TAPS.length / 2;
/** Rotations of the tap discs, picked per pixel by a hash. */
const ROTATIONS = 64;
const ROT_COS = Float64Array.from({ length: ROTATIONS }, (_, i) =>
  Math.cos((2 * Math.PI * (i + 0.5)) / ROTATIONS),
);
const ROT_SIN = Float64Array.from({ length: ROTATIONS }, (_, i) =>
  Math.sin((2 * Math.PI * (i + 0.5)) / ROTATIONS),
);

/** Integer hash of a pixel's coordinates (deterministic tap rotation). */
export function pixelHash(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul((y | 0) + 0x3c6ef372, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * How much of a light reaches the world point (px, py, pz) through its shadow map, 0..1. `gx..gz`
 * is the unit face normal and `sx..sz` the unit shading normal, both on the viewer's side (the
 * lit side when the light is shaded at all): the face normal sizes the normal offset and the
 * receiver plane, the shading normal stands in where the face itself is turned from the light
 * (facets at the terminator of smooth surfaces). (hx, hy) is the pixel (tap rotation).
 */
export function shadowVisibility(
  m: ShadowMap,
  px: number,
  py: number,
  pz: number,
  gx: number,
  gy: number,
  gz: number,
  sx: number,
  sy: number,
  sz: number,
  hx: number,
  hy: number,
): number {
  // world size of a texel at the point
  let texel: number;
  let towards: number;
  if (m.ortho) {
    texel = 1 / m.su;
    towards = -(gx * m.fx + gy * m.fy + gz * m.fz);
  } else {
    const ex = px - m.ox;
    const ey = py - m.oy;
    const ez = pz - m.oz;
    const d = ex * m.fx + ey * m.fy + ez * m.fz;
    if (!(d > 0)) return 1;
    texel = d / m.su;
    towards = -(gx * ex + gy * ey + gz * ez) / (Math.sqrt(ex * ex + ey * ey + ez * ez) || 1);
  }
  if (towards < MIN_FACING) {
    gx = sx;
    gy = sy;
    gz = sz;
  }
  // the lookup point, lifted along the normal
  const lift = NORMAL_OFFSET_TEXELS * texel;
  const qx = px + gx * lift;
  const qy = py + gy * lift;
  const qz = pz + gz * lift;
  const VP = m.viewProj;
  const cx = VP[0] * qx + VP[4] * qy + VP[8] * qz + VP[12];
  const cy = VP[1] * qx + VP[5] * qy + VP[9] * qz + VP[13];
  const cw = VP[3] * qx + VP[7] * qy + VP[11] * qz + VP[15];
  if (!(cw > 0)) return 1;
  const W = m.width;
  const H = m.height;
  const u = ((cx / cw) * 0.5 + 0.5) * W;
  const v = (0.5 - (cy / cw) * 0.5) * H;
  // light-space coordinates of the lookup point
  const lx = qx - m.ox;
  const ly = qy - m.oy;
  const lz = qz - m.oz;
  const d = lx * m.fx + ly * m.fy + lz * m.fz;
  if (d > m.far || u < -m.maxRadius || v < -m.maxRadius || u > W + m.maxRadius || v > H + m.maxRadius)
    return 1;
  // receiver plane: depth change per texel step in u and v on the face's plane
  const nR = gx * m.rx + gy * m.ry + gz * m.rz;
  const nU = gx * m.ux + gy * m.uy + gz * m.uz;
  let gu: number;
  let gv: number;
  if (m.ortho) {
    let nF = gx * m.fx + gy * m.fy + gz * m.fz;
    if (nF > -MIN_FACING) nF = -MIN_FACING;
    gu = -nR / (nF * m.su);
    gv = nU / (nF * m.sv);
  } else {
    // c = n·P with P the point in light view space; negative on faces turned to the lamp
    let c = nR * (lx * m.rx + ly * m.ry + lz * m.rz) + nU * (lx * m.ux + ly * m.uy + lz * m.uz);
    c += (gx * m.fx + gy * m.fy + gz * m.fz) * d;
    if (c > -MIN_FACING * d) c = -MIN_FACING * d;
    const dd = (d * d) / c;
    gu = (-nR * dd) / m.su;
    gv = (nU * dd) / m.sv;
  }
  const dRef = d - DEPTH_BIAS_TEXELS * texel;
  const depth = m.depth;
  const rot = pixelHash(hx, hy) & (ROTATIONS - 1);
  const rc = ROT_COS[rot];
  const rs = ROT_SIN[rot];

  let radius = m.minRadius;
  if (m.pcss) {
    // blocker search: the average depth of what lies in front of the receiver nearby
    let search: number;
    if (m.ortho) search = (m.soft * Math.max(0, d - m.near)) / texel;
    else search = (3 * m.soft * m.su) / d;
    search = Math.min(m.maxRadius, Math.max(m.minRadius, search));
    let sum = 0;
    let n = 0;
    for (let k = 0; k < SEARCH_COUNT; k++) {
      const ax = SEARCH_TAPS[2 * k];
      const ay = SEARCH_TAPS[2 * k + 1];
      const iu = Math.floor(u + (ax * rc - ay * rs) * search);
      const iv = Math.floor(v + (ax * rs + ay * rc) * search);
      if (iu < 0 || iv < 0 || iu >= W || iv >= H) continue;
      const z = depth[iv * W + iu];
      if (z < dRef + gu * (iu + 0.5 - u) + gv * (iv + 0.5 - v)) {
        sum += z;
        n++;
      }
    }
    if (!n) return 1;
    const blocker = sum / n;
    // penumbra radius in texels: sun → (d − blocker)·tan(angle); spot → r·(d − blocker)/blocker
    const pen = m.ortho
      ? (m.soft * Math.max(0, d - blocker)) / texel
      : (m.soft * Math.max(0, d - blocker) * m.su) / (Math.max(blocker, 1e-6) * d);
    radius = Math.min(m.maxRadius, Math.max(m.minRadius, pen));
  }
  // percentage-closer filtering against the receiver plane
  if (radius <= TENT_MAX_TEXELS) {
    // narrow: a tent filter over every texel centre within `radius` (smooth, no noise)
    const c0 = Math.floor(u - 0.5) - 1;
    const r0 = Math.floor(v - 0.5) - 1;
    if (c0 >= 0 && r0 >= 0 && c0 + 3 < W && r0 + 3 < H) {
      // the 4 × 4 texels around the point hold every centre within 2 texels: unrolled, weights
      // max(0, radius − |offset|) per column and row (the tent is separable)
      const dx0 = c0 + 0.5 - u;
      const dy0 = r0 + 0.5 - v;
      const wx0 = tent(radius, dx0);
      const wx1 = tent(radius, dx0 + 1);
      const wx2 = tent(radius, dx0 + 2);
      const wx3 = tent(radius, dx0 + 3);
      // (summed in the order the lit texels are, so a fully lit point gets exactly 1)
      const rowTotal = wx0 + wx1 + wx2 + wx3;
      const e0 = dRef + gu * dx0;
      const e1 = e0 + gu;
      const e2 = e1 + gu;
      const e3 = e2 + gu;
      let lit = 0;
      let total = 0;
      for (let j = 0; j < 4; j++) {
        const dy = dy0 + j;
        const wy = tent(radius, dy);
        if (wy === 0) continue;
        total += wy * rowTotal;
        const b = gv * dy;
        const o = (r0 + j) * W + c0;
        let row = 0;
        if (depth[o] >= e0 + b) row += wx0;
        if (depth[o + 1] >= e1 + b) row += wx1;
        if (depth[o + 2] >= e2 + b) row += wx2;
        if (depth[o + 3] >= e3 + b) row += wx3;
        lit += wy * row;
      }
      return total > 0 ? lit / total : 1;
    }
    // near the map's edge: texels beyond it are lit
    const u0 = Math.ceil(u - radius - 0.5);
    const u1 = Math.floor(u + radius - 0.5);
    const v0 = Math.ceil(v - radius - 0.5);
    const v1 = Math.floor(v + radius - 0.5);
    let lit = 0;
    let total = 0;
    for (let iv = v0; iv <= v1; iv++) {
      const dy = iv + 0.5 - v;
      const wy = radius - (dy < 0 ? -dy : dy);
      if (!(wy > 0)) continue;
      const inside = iv >= 0 && iv < H;
      const row = iv * W;
      const base = dRef + gv * dy;
      for (let iu = u0; iu <= u1; iu++) {
        const dx = iu + 0.5 - u;
        const w = (radius - (dx < 0 ? -dx : dx)) * wy;
        if (!(w > 0)) continue;
        total += w;
        if (!inside || iu < 0 || iu >= W || depth[row + iu] >= base + gu * dx) lit += w;
      }
    }
    return total > 0 ? lit / total : 1;
  }
  // wide: a rotated disc of bilinear comparisons
  let lit = 0;
  for (let k = 0; k < PCF_COUNT; k++) {
    if (k === 4 && (lit === 0 || lit === 4)) return lit / 4;
    const ax = PCF_TAPS[2 * k];
    const ay = PCF_TAPS[2 * k + 1];
    const tu = u + (ax * rc - ay * rs) * radius - 0.5;
    const tv = v + (ax * rs + ay * rc) * radius - 0.5;
    const iu = Math.floor(tu);
    const iv = Math.floor(tv);
    const fx = tu - iu;
    const fy = tv - iv;
    lit +=
      (1 - fy) *
        ((1 - fx) * litTexel(m, iu, iv, u, v, dRef, gu, gv) +
          fx * litTexel(m, iu + 1, iv, u, v, dRef, gu, gv)) +
      fy *
        ((1 - fx) * litTexel(m, iu, iv + 1, u, v, dRef, gu, gv) +
          fx * litTexel(m, iu + 1, iv + 1, u, v, dRef, gu, gv));
  }
  return lit / PCF_COUNT;
}

/** Tent filter weight of a texel `offset` texels from the point: max(0, radius − |offset|). */
function tent(radius: number, offset: number): number {
  const w = radius - (offset < 0 ? -offset : offset);
  return w > 0 ? w : 0;
}

/** 1 when texel (iu, iv) of the map lets the light through to the receiver plane (or is off the map). */
function litTexel(
  m: ShadowMap,
  iu: number,
  iv: number,
  u: number,
  v: number,
  dRef: number,
  gu: number,
  gv: number,
): number {
  if (iu < 0 || iv < 0 || iu >= m.width || iv >= m.height) return 1;
  return m.depth[iv * m.width + iu] >= dRef + gu * (iu + 0.5 - u) + gv * (iv + 0.5 - v) ? 1 : 0;
}
