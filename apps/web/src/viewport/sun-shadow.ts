import * as THREE from 'three';

/*
 * Shadow maps of suns: SUN lamps and the procedural sky's sun, in the WebGL renders (Rendered
 * viewport, F12, Render Animation, MCP renders in a browser editor).
 *
 * A sun casts its shadows through one orthographic shadow map of SUN_SHADOW_MAP_SIZE² texels. Before
 * every render it is fitted to what that render's camera sees ({@link fitSunShadow}):
 * - the receivers: the visible geometry inside the camera's view frustum, up to a shadow distance;
 * - the casters: everything between those receivers and the sun, also outside the view.
 * The texels therefore cover the visible part of the scene, whatever the size of the scene: a 600 m
 * ground plane or a distant terrain does not spread them over hundreds of metres, and metre-sized
 * objects keep sharp shadows. In perspective views the shadow distance is SHADOW_DISTANCE_SCALE
 * times the median distance from the camera at which the visible objects start, so a far background
 * (mountains or clouds a kilometre away) does not cost the foreground its resolution; beyond it
 * there are no sun shadows. Orthographic views (as wide at every depth) have no shadow distance.
 * The depth and normal biases are a couple of texels in world units (a few millimetres to centimetres
 * for a view of metre-sized objects), whatever the depth range of the map: enough against acne on
 * faces lit at an angle, too little to detach the shadows from the objects casting them.
 */

/** Width and height of a sun's shadow map in texels. */
export const SUN_SHADOW_MAP_SIZE = 2048;
/** The shadow distance: this many times the median distance at which the visible objects start. */
export const SHADOW_DISTANCE_SCALE = 4;
/** Normal offset of shadow lookups (three.js normalBias) in texels of the fitted map. */
export const NORMAL_BIAS_TEXELS = 2;
/** Depth bias of shadow lookups in texels (world units) of the fitted map. */
export const DEPTH_BIAS_TEXELS = 2;

/** What {@link fitSunShadow} fitted, in the shadow camera's view space (metres). */
export interface SunShadowFit {
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
  /** World size of a texel of the map (its larger side). */
  texel: number;
  /** Distance from the camera up to which the visible geometry receives the sun's shadows. */
  shadowDistance: number;
}

/** Corner `i` of a box: bit 0 picks x, bit 1 y and bit 2 z (min or max). */
function corner(box: THREE.Box3, i: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
}

/** The faces of a box as cycles of {@link corner} indices. */
const BOX_FACES = [
  [0, 2, 6, 4],
  [1, 5, 7, 3],
  [0, 4, 5, 1],
  [2, 3, 7, 6],
  [0, 1, 3, 2],
  [4, 6, 7, 5],
];

/** The part of a convex polygon on the side of `plane` its normal points to (Sutherland–Hodgman). */
function clipPolygon(poly: THREE.Vector3[], plane: THREE.Plane): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = plane.distanceToPoint(a);
    const db = plane.distanceToPoint(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) out.push(a.clone().lerp(b, da / (da - db)));
  }
  return out;
}

/**
 * Vertices of the part of `box` inside every plane (each keeps the side its normal points to). The
 * region the planes bound has the corners `regionCorners` (none when it is unbounded): those inside
 * the box are vertices too. Empty when the box lies outside.
 */
function clipBox(
  box: THREE.Box3,
  planes: readonly THREE.Plane[],
  regionCorners: readonly THREE.Vector3[],
): THREE.Vector3[] {
  const corners = Array.from({ length: 8 }, (_, i) => corner(box, i));
  if (corners.every((p) => planes.every((pl) => pl.distanceToPoint(p) >= 0))) return corners;
  const out: THREE.Vector3[] = [];
  for (const face of BOX_FACES) {
    let poly = face.map((i) => corners[i]);
    for (const pl of planes) {
      poly = clipPolygon(poly, pl);
      if (!poly.length) break;
    }
    for (const p of poly) out.push(p);
  }
  for (const p of regionCorners) if (box.containsPoint(p)) out.push(p.clone());
  return out;
}

/**
 * The world-space corners of a camera's view frustum (its four corner rays from the near plane to
 * the far plane), with the far corners pulled in to the view depth `maxDepth` when it is nearer.
 */
function frustumCorners(camera: THREE.Camera, maxDepth = Infinity): THREE.Vector3[] {
  // normalized device depth of the near and far planes (reversed depth maps them to 1 and 0)
  const zeroToOne = camera.coordinateSystem === THREE.WebGPUCoordinateSystem || camera.reversedDepth;
  const zNear = camera.reversedDepth ? 1 : zeroToOne ? 0 : -1;
  const zFar = camera.reversedDepth ? 0 : 1;
  const out: THREE.Vector3[] = [];
  const view = camera.matrixWorldInverse;
  const tmp = new THREE.Vector3();
  for (const [x, y] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const n = new THREE.Vector3(x, y, zNear).unproject(camera);
    const f = new THREE.Vector3(x, y, zFar).unproject(camera);
    const dn = -tmp.copy(n).applyMatrix4(view).z;
    const df = -tmp.copy(f).applyMatrix4(view).z;
    if (df > maxDepth && df > dn) f.lerpVectors(n, f, Math.max(0, (maxDepth - dn) / (df - dn)));
    out.push(n, f);
  }
  return out;
}

/** `size` rounded up to the next eighth of an octave (the map keeps its size while the view moves a little). */
function quantize(size: number): number {
  return 2 ** (Math.ceil(Math.log2(Math.max(size, 1e-4)) * 8) / 8);
}

/**
 * Fits the shadow camera (frustum and biases) of a sun to what `camera` sees of the shadow-casting
 * geometry `boxes` (world-space bounding boxes of the visible meshes and instances): see the module
 * comment. Call it before every render with that render's camera; three.js then draws the map from
 * the light's position along its direction (its target). Returns what it fitted, or null (the
 * shadow camera unchanged) when there is no geometry.
 */
export function fitSunShadow(
  light: THREE.DirectionalLight,
  camera: THREE.Camera,
  boxes: readonly THREE.Box3[],
): SunShadowFit | null {
  const solid = boxes.filter((b) => !b.isEmpty());
  if (!solid.length) return null;
  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse;
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view),
    camera.coordinateSystem,
    camera.reversedDepth,
  );
  const corners = frustumCorners(camera);
  const tmp = new THREE.Vector3();
  const depth = (p: THREE.Vector3) => -tmp.copy(p).applyMatrix4(view).z;

  // the visible part of each box and the view depths it spans
  const visible: { box: THREE.Box3; points: THREE.Vector3[]; start: number; end: number }[] = [];
  for (const box of solid) {
    if (!frustum.intersectsBox(box)) continue;
    const points = clipBox(box, frustum.planes, corners);
    if (!points.length) continue;
    let start = Infinity;
    let end = -Infinity;
    for (const p of points) {
      const d = depth(p);
      start = Math.min(start, d);
      end = Math.max(end, d);
    }
    visible.push({ box, points, start, end });
  }

  // the receivers: what the camera sees, up to the shadow distance (perspective views: far away, a
  // texel covers fewer pixels; an orthographic view is as wide at every depth and has none)
  const receivers: THREE.Vector3[] = [];
  let shadowDistance = Infinity;
  if (visible.length) {
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      // where the visible objects start; boxes the camera is in (a room, a sky dome) start at the
      // near plane and say nothing about where the scene is
      const nearPlane = Math.max(0, Math.min(...corners.filter((_, i) => i % 2 === 0).map(depth)));
      const starts = visible.map((v) => v.start).sort((a, b) => a - b);
      const outside = starts.filter((d) => d > 1.5 * nearPlane + 1e-6);
      const ref = outside.length ? outside : starts;
      shadowDistance = SHADOW_DISTANCE_SCALE * Math.max(ref[ref.length >> 1], nearPlane, 1e-4);
    }
    if (visible.every((v) => v.end <= shadowDistance)) for (const v of visible) receivers.push(...v.points);
    else {
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      // inside: view depth ≤ shadowDistance
      const cap = new THREE.Plane(forward.clone().negate(), shadowDistance + forward.dot(eye));
      const planes = [...frustum.planes, cap];
      const capped = frustumCorners(camera, shadowDistance);
      for (const v of visible) {
        if (v.start > shadowDistance) continue;
        if (v.end <= shadowDistance) receivers.push(...v.points);
        else receivers.push(...clipBox(v.box, planes, capped));
      }
    }
    if (!receivers.length) for (const v of visible) receivers.push(...v.points);
  } else {
    // nothing in view (no shadow can be seen): the whole scene
    for (const b of solid) for (let i = 0; i < 8; i++) receivers.push(corner(b, i));
  }

  // where three.js puts the shadow camera: at the light, looking at its target
  light.updateWorldMatrix(true, true);
  light.target.updateWorldMatrix(true, false);
  light.shadow.updateMatrices(light);
  const cam = light.shadow.camera;
  const lightView = cam.matrixWorldInverse;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let d0 = Infinity;
  let d1 = -Infinity;
  for (const p of receivers) {
    tmp.copy(p).applyMatrix4(lightView);
    x0 = Math.min(x0, tmp.x);
    x1 = Math.max(x1, tmp.x);
    y0 = Math.min(y0, tmp.y);
    y1 = Math.max(y1, tmp.y);
    d0 = Math.min(d0, -tmp.z);
    d1 = Math.max(d1, -tmp.z);
  }
  if (!Number.isFinite(x0 + x1 + y0 + y1 + d0 + d1)) return null;
  // margin for the filter, a size that changes in steps and a centre on the texel grid: the shadow
  // edges stay put while the view moves a little
  const mapSize = Math.max(1, light.shadow.mapSize.x);
  const pad = (Math.max(x1 - x0, y1 - y0, 1e-3) * (Math.max(0, light.shadow.radius) + 2)) / mapSize;
  const width = quantize(x1 - x0 + 2 * pad);
  const height = quantize(y1 - y0 + 2 * pad);
  const tx = width / mapSize;
  const ty = height / mapSize;
  const cx = Math.round((x0 + x1) / 2 / tx) * tx;
  const cy = Math.round((y0 + y1) / 2 / ty) * ty;
  const left = cx - width / 2;
  const right = cx + width / 2;
  const bottom = cy - height / 2;
  const top = cy + height / 2;

  // the casters: whatever lies between the receivers and the sun (inside the footprint's prism)
  const prism = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -left),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), right),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -bottom),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), top),
  ].map((pl) => pl.applyMatrix4(cam.matrixWorld));
  let near = d0;
  for (const box of solid) {
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let by0 = Infinity;
    let by1 = -Infinity;
    let bd = Infinity;
    for (let i = 0; i < 8; i++) {
      corner(box, i, tmp).applyMatrix4(lightView);
      bx0 = Math.min(bx0, tmp.x);
      bx1 = Math.max(bx1, tmp.x);
      by0 = Math.min(by0, tmp.y);
      by1 = Math.max(by1, tmp.y);
      bd = Math.min(bd, -tmp.z);
    }
    if (bx1 < left || bx0 > right || by1 < bottom || by0 > top || bd >= near) continue;
    if (bx0 >= left && bx1 <= right && by0 >= bottom && by1 <= top) near = bd;
    else
      for (const p of clipBox(box, prism, [])) near = Math.min(near, -tmp.copy(p).applyMatrix4(lightView).z);
  }
  const margin = Math.max(0.05, 0.01 * (d1 - near));
  near -= margin;
  const far = d1 + margin;

  cam.left = left;
  cam.right = right;
  cam.bottom = bottom;
  cam.top = top;
  cam.near = near;
  cam.far = far;
  cam.updateProjectionMatrix();
  const texel = Math.max(tx, ty);
  light.shadow.normalBias = NORMAL_BIAS_TEXELS * texel;
  // three.js adds the bias to the receiver's depth in the map's 0..1 range (near..far)
  light.shadow.bias = -(DEPTH_BIAS_TEXELS * texel) / (far - near);
  return { left, right, bottom, top, near, far, texel, shadowDistance };
}
