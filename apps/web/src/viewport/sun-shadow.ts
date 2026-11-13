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
 * The normal and depth biases are a few texels in world units (millimetres to a few centimetres for a
 * view of metre-sized objects), whatever the depth range of the map: enough against acne on faces
 * the sun grazes, too little to detach the shadows from the objects casting them.
 *
 * The fitted map's texels are rarely square: under a low sun the visible ground is long across the
 * light and short along it, so a texel can be 20 times longer in x than in y. A face needs a normal
 * offset of a few texels measured along its slope across the map (the direction its depth changes
 * in): the ground under a low sun slopes along y, where texels are short. One offset for all faces,
 * sized for the long side, lifted the ground's lookups by centimetres to decimetres and so cut the
 * long shadows of a low sun short (a 10 cm box under a 3° sun cast 1.39 m instead of 1.91 m) or
 * removed those of small objects. The lit materials therefore scale the light's normal offset per
 * face to the texel length along that face's slope ({@link sunNormalOffsetScale}, the same formula
 * in GLSL: {@link installSunShadowOffset}).
 */

/** Width and height of a sun's shadow map in texels. */
export const SUN_SHADOW_MAP_SIZE = 2048;
/** The shadow distance: this many times the median distance at which the visible objects start. */
export const SHADOW_DISTANCE_SCALE = 4;
/**
 * Normal offset of shadow lookups in texels of the fitted map, beyond the reach of the shadow
 * filter: three.js's PCF samples the map up to `shadow.radius` texels beside the lookup, each sample
 * a bilinear 2 × 2 texel comparison, so a face the sun grazes needs `radius + 1` texels of offset
 * along its slope not to shadow itself there (less left a fine dither on such faces).
 */
export const NORMAL_BIAS_EXTRA_TEXELS = 1;
/**
 * Depth bias of shadow lookups in texels (world units) of the fitted map's finer axis: only depth
 * precision is left to cover once the normal offset handles slopes, and more detaches shadows from
 * what casts them (a lit gap at the foot of a wall).
 */
export const DEPTH_BIAS_TEXELS = 2;

/** The normal offset of a sun's shadow lookups in texels of its map: the filter's reach plus one. */
export function normalBiasTexels(light: THREE.DirectionalLight): number {
  return Math.max(0, light.shadow.radius) + NORMAL_BIAS_EXTRA_TEXELS;
}

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

/** Whether a box (centre `c`, half size `h`) lies inside `plane` (on the side its normal points to). */
function boxInsidePlane({ normal: n, constant }: THREE.Plane, c: THREE.Vector3, h: THREE.Vector3): boolean {
  return n.dot(c) + constant >= Math.abs(n.x) * h.x + Math.abs(n.y) * h.y + Math.abs(n.z) * h.z;
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
  const c = box.getCenter(new THREE.Vector3());
  const h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  // only the planes the box reaches across cut it
  const cutting = planes.filter((pl) => !boxInsidePlane(pl, c, h));
  const corners = Array.from({ length: 8 }, (_, i) => corner(box, i));
  if (!cutting.length) return corners;
  const out: THREE.Vector3[] = [];
  for (const face of BOX_FACES) {
    let poly = face.map((i) => corners[i]);
    for (const pl of cutting) {
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

/** Coordinate `k` (0 x, 1 y, 2 z) of the point `c` mapped by the affine matrix with `elements`. */
function mapped(elements: ArrayLike<number>, k: number, c: THREE.Vector3): number {
  const e = elements;
  return e[k] * c.x + e[4 + k] * c.y + e[8 + k] * c.z + e[12 + k];
}

/**
 * How far coordinate `k` of the corners of a box with half size `h`, mapped by the affine matrix
 * with `elements`, reaches either side of its centre's: the box's range in that coordinate is
 * exactly mapped(centre) ± this (the image of a box under an affine map).
 */
function reach(elements: ArrayLike<number>, k: number, h: THREE.Vector3): number {
  const e = elements;
  return Math.abs(e[k]) * h.x + Math.abs(e[4 + k]) * h.y + Math.abs(e[8 + k]) * h.z;
}

/** A box in view: its index, the vertices of its part in view (null: all of it) and the view depths that part spans. */
interface VisibleBox {
  i: number;
  points: THREE.Vector3[] | null;
  start: number;
  end: number;
}

/**
 * Fits the shadow camera (frustum and biases) of a sun to what `camera` sees of the shadow-casting
 * geometry `boxes` (world-space bounding boxes of the visible meshes and instances): see the module
 * comment. Call it before every render with that render's camera; three.js then draws the map from
 * the light's position along its direction (its target). Returns what it fitted, or null (the
 * shadow camera unchanged) when there is no geometry. A box costs a few multiplications unless it
 * crosses the edge of the view or of the map, where it is clipped.
 */
export function fitSunShadow(
  light: THREE.DirectionalLight,
  camera: THREE.Camera,
  boxes: readonly THREE.Box3[],
): SunShadowFit | null {
  const solid = boxes.filter((b) => !b.isEmpty());
  if (!solid.length) return null;
  const count = solid.length;
  const c = new THREE.Vector3();
  const h = new THREE.Vector3();
  const centre = (b: THREE.Box3) => {
    b.getCenter(c);
    b.getSize(h).multiplyScalar(0.5);
  };
  const tmp = new THREE.Vector3();

  // where three.js puts the shadow camera: at the light, looking at its target
  light.updateWorldMatrix(true, true);
  light.target.updateWorldMatrix(true, false);
  light.shadow.updateMatrices(light);
  const cam = light.shadow.camera;
  const lightView = cam.matrixWorldInverse;
  // every box's extent in the shadow camera's view: x, y and the depth along the light (−z)
  const L = lightView.elements;
  const lightBox = new Float64Array(6 * count);
  for (let i = 0; i < count; i++) {
    centre(solid[i]);
    const o = 6 * i;
    for (let k = 0; k < 2; k++) {
      lightBox[o + 2 * k] = mapped(L, k, c) - reach(L, k, h);
      lightBox[o + 2 * k + 1] = mapped(L, k, c) + reach(L, k, h);
    }
    lightBox[o + 4] = -mapped(L, 2, c) - reach(L, 2, h);
    lightBox[o + 5] = -mapped(L, 2, c) + reach(L, 2, h);
  }

  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse;
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view),
    camera.coordinateSystem,
    camera.reversedDepth,
  );
  const corners = frustumCorners(camera);
  const depth = (p: THREE.Vector3) => -tmp.copy(p).applyMatrix4(view).z;

  // the part of each box in view and the view depths it spans
  const visible: VisibleBox[] = [];
  for (let i = 0; i < count; i++) {
    const box = solid[i];
    if (!frustum.intersectsBox(box)) continue;
    centre(box);
    if (frustum.planes.every((pl) => boxInsidePlane(pl, c, h))) {
      const mid = -mapped(view.elements, 2, c);
      const r = reach(view.elements, 2, h);
      visible.push({ i, points: null, start: mid - r, end: mid + r });
      continue;
    }
    const points = clipBox(box, frustum.planes, corners);
    if (!points.length) continue;
    let start = Infinity;
    let end = -Infinity;
    for (const p of points) {
      const d = depth(p);
      start = Math.min(start, d);
      end = Math.max(end, d);
    }
    visible.push({ i, points, start, end });
  }

  // the receivers (what the camera sees, up to the shadow distance) in the shadow camera's view
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let d0 = Infinity;
  let d1 = -Infinity;
  let received = 0;
  const receivePoint = (p: THREE.Vector3) => {
    tmp.copy(p).applyMatrix4(lightView);
    x0 = Math.min(x0, tmp.x);
    x1 = Math.max(x1, tmp.x);
    y0 = Math.min(y0, tmp.y);
    y1 = Math.max(y1, tmp.y);
    d0 = Math.min(d0, -tmp.z);
    d1 = Math.max(d1, -tmp.z);
    received++;
  };
  const receiveBox = (i: number) => {
    const o = 6 * i;
    x0 = Math.min(x0, lightBox[o]);
    x1 = Math.max(x1, lightBox[o + 1]);
    y0 = Math.min(y0, lightBox[o + 2]);
    y1 = Math.max(y1, lightBox[o + 3]);
    d0 = Math.min(d0, lightBox[o + 4]);
    d1 = Math.max(d1, lightBox[o + 5]);
    received++;
  };
  const receive = (v: VisibleBox) => (v.points ? v.points.forEach(receivePoint) : receiveBox(v.i));
  let shadowDistance = Infinity;
  if (visible.length) {
    // perspective views: far away, a texel covers fewer pixels (an orthographic view is as wide
    // at every depth and has no shadow distance)
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      // where the visible objects start; boxes the camera is in (a room, a sky dome) start at the
      // near plane and say nothing about where the scene is
      const nearPlane = Math.max(0, Math.min(...corners.filter((_, i) => i % 2 === 0).map(depth)));
      const starts = Float64Array.from(visible, (v) => v.start).sort();
      const outside = starts.filter((d) => d > 1.5 * nearPlane + 1e-6);
      const ref = outside.length ? outside : starts;
      shadowDistance = SHADOW_DISTANCE_SCALE * Math.max(ref[ref.length >> 1], nearPlane, 1e-4);
    }
    if (visible.every((v) => v.end <= shadowDistance)) visible.forEach(receive);
    else {
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      // inside: view depth ≤ shadowDistance
      const cap = new THREE.Plane(forward.clone().negate(), shadowDistance + forward.dot(eye));
      const planes = [...frustum.planes, cap];
      const capped = frustumCorners(camera, shadowDistance);
      for (const v of visible) {
        if (v.start > shadowDistance) continue;
        if (v.end <= shadowDistance) receive(v);
        else clipBox(solid[v.i], planes, capped).forEach(receivePoint);
      }
    }
    if (!received) visible.forEach(receive);
  } else {
    // nothing in view (no shadow can be seen): the whole scene
    for (let i = 0; i < count; i++) receiveBox(i);
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
  for (let i = 0; i < count; i++) {
    const o = 6 * i;
    const bx0 = lightBox[o];
    const bx1 = lightBox[o + 1];
    const by0 = lightBox[o + 2];
    const by1 = lightBox[o + 3];
    const bd = lightBox[o + 4];
    if (bx1 < left || bx0 > right || by1 < bottom || by0 > top || bd >= near) continue;
    if (bx0 >= left && bx1 <= right && by0 >= bottom && by1 <= top) near = bd;
    else
      for (const p of clipBox(solid[i], prism, []))
        near = Math.min(near, -tmp.copy(p).applyMatrix4(lightView).z);
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
  // sized for the longer texel side; the materials scale it per face to the texel along the face's
  // slope (sunNormalOffsetScale)
  light.shadow.normalBias = normalBiasTexels(light) * texel;
  // three.js adds the bias to the receiver's depth in the map's 0..1 range (near..far)
  light.shadow.bias = -(DEPTH_BIAS_TEXELS * Math.min(tx, ty)) / (far - near);
  return { left, right, bottom, top, near, far, texel, shadowDistance };
}

/**
 * The factor the lit materials apply to a sun's normal offset (`shadow.normalBias`, sized for the
 * longer side of the map's texels) for a face with world normal `normal`, given the sun's shadow
 * matrix (world → map coordinates 0..1, three.js `shadow.matrix`): the texel length along the face's
 * slope across the map (the direction its depth changes in, the normal's projection onto the map),
 * divided by the longer texel side. 1 where the slope runs along the longer side; for the ground
 * under a low sun, whose slope runs along the short side, the ratio of the two sides. Faces turned to
 * the sun (no slope) get the shorter side's ratio. Mirrors the GLSL of {@link installSunShadowOffset}.
 */
export function sunNormalOffsetScale(normal: THREE.Vector3, shadowMatrix: THREE.Matrix4): number {
  const e = shadowMatrix.elements;
  // gradients of the map coordinates u and v in world space (rows 0 and 1): their squared lengths
  // are 1 / width² and 1 / height² of the map in world units
  const gu = new THREE.Vector3(e[0], e[4], e[8]);
  const gv = new THREE.Vector3(e[1], e[5], e[9]);
  const iu = gu.lengthSq();
  const iv = gv.lengthSq();
  const mn = Math.min(iu, iv);
  const mx = Math.max(iu, iv);
  if (!(mn > 0)) return 1;
  const n = normal.clone().normalize();
  // squared components of the normal along the map's axes
  const a = n.dot(gu) ** 2 / iu;
  const b = n.dot(gv) ** 2 / iv;
  // texel length along the normal's projection, over the longer texel side
  const along = Math.sqrt((a * (mn / iu) + b * (mn / iv)) / Math.max(a + b, 1e-6));
  return Math.min(1, Math.max(along, Math.sqrt(mn / mx)));
}

/** The GLSL of {@link sunNormalOffsetScale} (vertex shader, after `shadowmap_pars_vertex`). */
const SCALE_GLSL = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	// texel length along the face's slope across the sun's map over its longer texel side (sun-shadow.ts)
	float pfxSunNormalOffsetScale( const in vec3 normal, const in mat4 shadowMatrix ) {
		vec3 gu = vec3( shadowMatrix[ 0 ][ 0 ], shadowMatrix[ 1 ][ 0 ], shadowMatrix[ 2 ][ 0 ] );
		vec3 gv = vec3( shadowMatrix[ 0 ][ 1 ], shadowMatrix[ 1 ][ 1 ], shadowMatrix[ 2 ][ 1 ] );
		float iu = dot( gu, gu );
		float iv = dot( gv, gv );
		float mn = min( iu, iv );
		float mx = max( iu, iv );
		if ( mn <= 0.0 ) return 1.0;
		float du = dot( normal, gu );
		float dv = dot( normal, gv );
		float a = du * du / iu;
		float b = dv * dv / iv;
		float along = sqrt( ( a * ( mn / iu ) + b * ( mn / iv ) ) / max( a + b, 1e-6 ) );
		return min( 1.0, max( along, sqrt( mn / mx ) ) );
	}
#endif
`;

/** The normal offset of directional shadow lookups in three.js's `shadowmap_vertex` chunk. */
const DIRECTIONAL_OFFSET =
  'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );';
const SCALED_OFFSET =
  'shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * ( directionalLightShadows[ i ].shadowNormalBias * ' +
  'pfxSunNormalOffsetScale( shadowWorldNormal, directionalShadowMatrix[ i ] ) ), 0 );';

/**
 * Rewrites a lit material's vertex shader so the normal offset of sun (directional) shadow lookups
 * is scaled per face by {@link sunNormalOffsetScale}. Returns whether three.js's shader had the
 * expected code (a three.js update that changes it leaves the shader as it was).
 */
export function patchSunShadowOffset(shader: { vertexShader: string }): boolean {
  const chunk = THREE.ShaderChunk.shadowmap_vertex;
  if (
    !chunk.includes(DIRECTIONAL_OFFSET) ||
    !shader.vertexShader.includes('#include <shadowmap_vertex>') ||
    !shader.vertexShader.includes('#include <shadowmap_pars_vertex>')
  )
    return false;
  shader.vertexShader = shader.vertexShader
    .replace('#include <shadowmap_pars_vertex>', `#include <shadowmap_pars_vertex>\n${SCALE_GLSL}`)
    .replace('#include <shadowmap_vertex>', chunk.replace(DIRECTIONAL_OFFSET, SCALED_OFFSET));
  return true;
}

/**
 * Makes a lit material scale sun shadow normal offsets per face (see the module comment), after its
 * own `onBeforeCompile` (procedural textures); its program cache key changes with it.
 */
export function installSunShadowOffset(material: THREE.Material): void {
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    patchSunShadowOffset(shader);
  };
  material.customProgramCacheKey = () => `${key.call(material)}|sun-offset`;
}
