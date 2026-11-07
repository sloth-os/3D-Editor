import * as THREE from 'three';

/*
 * Transmission (glass, liquids) in the WebGL renders: Material Preview and Rendered shading, F12,
 * Render Animation and MCP renders in a browser editor.
 *
 * A transmissive surface is drawn from a picture of what lies behind it, offset along the refracted
 * view ray (three.js's MeshPhysicalMaterial transmission). three.js's own transmission pass pictures
 * only the opaque objects, so a transmissive object inside or behind another one was missing from it
 * (the amber perfume in a glass bottle left the bottle clear and empty), and it pictures objects in
 * front of the glass too, so a label on a bottle showed again, shifted, through the glass.
 *
 * The pictures are therefore drawn here ({@link TransmissionLayers}), in levels: level-0 objects
 * refract the opaque scene; an object seen through another one is drawn into the picture of the
 * level above it (level 1 refracts the opaque scene and level-0 objects, level 2 also level-1
 * objects, …). Who sees whom is decided per frame from bounding boxes: a box inside another one
 * (perfume in a bottle) is seen through it; otherwise the farther of two objects whose boxes overlap
 * on screen is. Each picture keeps its depth, and a lookup that lands on something nearer than the
 * glass itself (the label in front of it) refracts nothing: it takes what lies straight behind the
 * glass. three.js's materials keep `transmission` 0, so its own pass never runs: the level-0 picture
 * replaces it, each further level costs one more render of the scene, and only frames where
 * transmissive objects overlap pay for them; at most {@link MAX_TRANSMISSION_LEVELS} levels. A
 * picture is only drawn where its objects read it ({@link lookupRect}: their screen area, widened by
 * how far a lookup can move and by the blur of rough glass): a few panes of glass do not cost a
 * second render of everything around them (lighthouse-cove's light beams in a sky of 2.5 M grass
 * triangles: half of each viewport frame in software WebGL).
 *
 * three.js also offsets the refracted lookup by the material's `thickness` (how far light travels
 * inside the object). It is the object's size ({@link transmissionThickness}) instead of a fixed
 * 0.5 m, which made an 8 cm bottle refract what lay half a metre behind it.
 */

/** Most levels of transmissive objects seen through each other (one render of the scene each). */
export const MAX_TRANSMISSION_LEVELS = 3;
/** Above this many transmissive objects on screen, levels are not worked out (all refract the opaque scene). */
export const MAX_LAYERED_OBJECTS = 128;
/**
 * The layer transmissive meshes move to while the pictures are drawn: the scene camera (layer 0)
 * skips them, the lights' shadow cameras (which also see this layer) do not, so glass keeps casting
 * shadows into the maps drawn with the first picture.
 */
export const HIDDEN_LAYER = 31;

const LAYER = 'pfxTransmission';

/** The uniforms of a transmissive material (see {@link installTransmissionLayer}). */
export interface TransmissionUniforms {
  transmission: { value: number };
  thickness: { value: number };
  map: { value: THREE.Texture | null };
  depth: { value: THREE.Texture | null };
  size: { value: THREE.Vector2 };
  /**
   * How much the material blurs what it refracts, at most: three.js's roughness of the lookup,
   * `roughness × clamp(2 × ior − 2, 0, 1)` (0 for clear glass; a roughness texture can reach 1).
   */
  blur: number;
}

/** three.js's transmission lookup (transmission_pars_fragment), validated against the picture's depth. */
const SAMPLE_FUNCTION =
  'vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {';
const SAMPLE_LINE = 'return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );';
const DEPTH_FUNCTION = `uniform sampler2D pfxTransmissionDepth;
	// distance along the view axis of a window depth of the picture (same projection as this draw)
	float pfxViewDistance( const in float depth ) {
		float ndc = depth * 2.0 - 1.0;
		if ( isOrthographic ) return ( projectionMatrix[ 3 ][ 2 ] - ndc ) / projectionMatrix[ 2 ][ 2 ];
		return projectionMatrix[ 3 ][ 2 ] / ( ndc + projectionMatrix[ 2 ][ 2 ] );
	}
	${SAMPLE_FUNCTION}`;
const DEPTH_SAMPLE = `#ifdef USE_REVERSED_DEPTH_BUFFER
			return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
		#endif
		// a lookup that lands on something not clearly behind this surface (a label stuck on the glass,
		// in front of it or beside it on another facet) moves back towards what lies straight behind the
		// surface until it and the texels the filter reads around it are; "clearly" is a tenth of the
		// light's way through the object (its thickness)
		vec3 pfxScale = vec3( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ), length( modelMatrix[ 2 ].xyz ) );
		float pfxBehind = pfxViewDistance( gl_FragCoord.z ) + 0.1 * thickness * ( pfxScale.x + pfxScale.y + pfxScale.z ) / 3.0;
		vec2 pfxStraight = gl_FragCoord.xy / transmissionSamplerSize;
		vec2 pfxUv = pfxStraight;
		vec2 pfxTexel = 2.0 / transmissionSamplerSize;
		for ( int k = 0; k < 6; k ++ ) {
			vec2 uv = mix( pfxStraight, fragCoord.xy, 1.0 - float( k ) / 6.0 );
			float d = texture2D( pfxTransmissionDepth, uv ).r;
			float d1 = texture2D( pfxTransmissionDepth, uv + vec2( pfxTexel.x, 0.0 ) ).r;
			float d2 = texture2D( pfxTransmissionDepth, uv - vec2( pfxTexel.x, 0.0 ) ).r;
			float d3 = texture2D( pfxTransmissionDepth, uv + vec2( 0.0, pfxTexel.y ) ).r;
			float d4 = texture2D( pfxTransmissionDepth, uv - vec2( 0.0, pfxTexel.y ) ).r;
			float nearest = min( min( pfxViewDistance( d ), pfxViewDistance( d1 ) ), min( pfxViewDistance( d2 ), min( pfxViewDistance( d3 ), pfxViewDistance( d4 ) ) ) );
			if ( nearest >= pfxBehind ) {
				pfxUv = uv;
				break;
			}
		}
		return textureBicubic( transmissionSamplerMap, pfxUv, lod );`;

/**
 * Rewrites a physical material's shaders to refract the pictures {@link TransmissionLayers} draws:
 * transmission on (three.js only turns it on for materials it draws in its own pass) and lookups
 * validated against the picture's depth. Returns whether three.js's shaders had the expected code
 * (an update that changes them leaves them as they were: no transmission).
 */
export function patchTransmission(shader: { vertexShader: string; fragmentShader: string }): boolean {
  const chunk = THREE.ShaderChunk.transmission_pars_fragment;
  if (
    !chunk.includes(SAMPLE_FUNCTION) ||
    !chunk.includes(SAMPLE_LINE) ||
    !shader.fragmentShader.includes('#include <transmission_pars_fragment>') ||
    !shader.fragmentShader.includes('#include <transmission_fragment>')
  )
    return false;
  shader.vertexShader = `#define USE_TRANSMISSION\n${shader.vertexShader}`;
  shader.fragmentShader = `#define USE_TRANSMISSION\n${shader.fragmentShader.replace(
    '#include <transmission_pars_fragment>',
    chunk.replace(SAMPLE_FUNCTION, DEPTH_FUNCTION).replace(SAMPLE_LINE, DEPTH_SAMPLE),
  )}`;
  return true;
}

/**
 * Makes a transmissive physical material refract the pictures of {@link TransmissionLayers}: its
 * transmission moves into the material's own uniforms (three.js sees an opaque material and runs no
 * transmission pass of its own). `maxRoughness` is the most roughness its surface has (1 when a
 * procedural texture sets it). Idempotent; materials without transmission are left alone.
 */
export function installTransmissionLayer(
  material: THREE.MeshPhysicalMaterial,
  maxRoughness = material.roughness,
): void {
  if (material.userData[LAYER] || !(material.transmission > 0)) return;
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
  const u: TransmissionUniforms = {
    transmission: { value: material.transmission },
    thickness: { value: material.thickness },
    map: { value: null },
    depth: { value: null },
    size: { value: new THREE.Vector2(1, 1) },
    blur: clamp01(maxRoughness) * clamp01(material.ior * 2 - 2),
  };
  material.userData[LAYER] = u;
  material.transmission = 0;
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    if (!patchTransmission(shader)) return;
    shader.uniforms.transmission = u.transmission;
    shader.uniforms.thickness = u.thickness;
    shader.uniforms.attenuationDistance = { value: Infinity };
    shader.uniforms.attenuationColor = { value: new THREE.Color(1, 1, 1) };
    shader.uniforms.transmissionSamplerMap = u.map;
    shader.uniforms.transmissionSamplerSize = u.size;
    shader.uniforms.pfxTransmissionDepth = u.depth;
  };
  material.customProgramCacheKey = () => `${key.call(material)}|transmission`;
}

/** The transmission uniforms of a material (null for materials without transmission). */
export function transmissionOf(m: THREE.Material | null | undefined): TransmissionUniforms | null {
  const u = m?.userData?.[LAYER] as TransmissionUniforms | undefined;
  return u && u.transmission.value > 0 ? u : null;
}

/**
 * The `thickness` of a transmissive material on `geometry` (local units; three.js scales it by the
 * object's scale): the smallest side of the geometry's bounding box, the distance light travels
 * through a solid of that size (a pane's thickness, a ball's diameter).
 */
export function transmissionThickness(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  if (!b || b.isEmpty()) return 0;
  const s = b.getSize(new THREE.Vector3());
  return Math.max(0, Math.min(s.x, s.y, s.z));
}

/** A transmissive object on screen. */
export interface LayerItem {
  /** The object's mesh (instanced meshes are items of their own). */
  mesh: THREE.Mesh;
  /** World bounding box. */
  box: THREE.Box3;
  /** Normalized device rectangle it covers (x0, y0, x1, y1). */
  rect: [number, number, number, number];
  /** Distance from the camera to the box centre. */
  distance: number;
  level: number;
}

/** Whether `inner` lies inside `outer` (a small tolerance for coincident sides). */
function contains(outer: THREE.Box3, inner: THREE.Box3): boolean {
  const eps = 1e-4 * outer.getSize(new THREE.Vector3()).length() + 1e-7;
  return (
    inner.min.x >= outer.min.x - eps &&
    inner.min.y >= outer.min.y - eps &&
    inner.min.z >= outer.min.z - eps &&
    inner.max.x <= outer.max.x + eps &&
    inner.max.y <= outer.max.y + eps &&
    inner.max.z <= outer.max.z + eps
  );
}

/**
 * Whether `a` shows `b` through it, so `b` must be drawn into the picture `a` refracts: their
 * pictures overlap and `b` lies inside `a` or, when neither contains the other, behind it.
 */
export function seesThrough(a: LayerItem, b: LayerItem): boolean {
  const [ax0, ay0, ax1, ay1] = a.rect;
  const [bx0, by0, bx1, by1] = b.rect;
  if (ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0) return false;
  const bInA = contains(a.box, b.box);
  const aInB = contains(b.box, a.box);
  if (bInA !== aInB) return bInA;
  return b.distance > a.distance;
}

/**
 * Levels of transmissive objects: 0 for those that show no other one, else one more than the
 * highest level they show, at most `maxLevel` (cycles, which bounding boxes allow in odd layouts,
 * end at it). Meshes sharing their materials (an object and its instances) get the same level.
 */
export function assignLevels(items: LayerItem[], maxLevel = MAX_TRANSMISSION_LEVELS - 1): void {
  const shows: number[][] = items.map(() => []);
  for (let i = 0; i < items.length; i++)
    for (let j = 0; j < items.length; j++) if (i !== j && seesThrough(items[i], items[j])) shows[i].push(j);
  for (const it of items) it.level = 0;
  for (let pass = 0; pass <= maxLevel + 1; pass++) {
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      let level = 0;
      for (const j of shows[i]) level = Math.max(level, items[j].level + 1);
      level = Math.min(maxLevel, level);
      if (level !== items[i].level) {
        items[i].level = level;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const shared = new Map<unknown, number>();
  for (const it of items) shared.set(it.mesh.material, Math.max(shared.get(it.mesh.material) ?? 0, it.level));
  for (const it of items) it.level = shared.get(it.mesh.material)!;
}

const corner = new THREE.Vector3();

/** The normalized device rectangle of a box seen by `camera` (the whole screen when it reaches behind it). */
function screenRect(box: THREE.Box3, camera: THREE.Camera): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    corner.applyMatrix4(camera.matrixWorldInverse);
    // behind the camera (perspective): the box may cover any part of the view
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera && corner.z > -1e-6) return [-1, -1, 1, 1];
    corner.applyMatrix4(camera.projectionMatrix);
    x0 = Math.min(x0, corner.x);
    y0 = Math.min(y0, corner.y);
    x1 = Math.max(x1, corner.x);
    y1 = Math.max(y1, corner.y);
  }
  return [x0, y0, x1, y1];
}

/** The materials of a mesh. */
const materialsOf = (m: THREE.Mesh): THREE.Material[] =>
  Array.isArray(m.material) ? m.material : [m.material];

/** A mesh's bounding box in its own space (an instanced mesh's covers all its instances). */
function localBox(m: THREE.Mesh): THREE.Box3 {
  const im = m as THREE.InstancedMesh;
  if (im.isInstancedMesh) {
    if (!im.boundingBox) im.computeBoundingBox();
    return im.boundingBox!.clone();
  }
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  return m.geometry.boundingBox!.clone();
}

/** A rectangle of a picture in pixels from its bottom left corner: x0, y0, x1, y1 (exclusive). */
export type PixelRect = [number, number, number, number];

/**
 * Roughness three.js adds to every surface (at least 0.0525, more where the normal turns quickly
 * from pixel to pixel), which blurs even clear glass's lookups a little.
 */
const GEOMETRY_BLUR = 0.1;

/**
 * Pixels around a lookup that a material with blur `blur` ({@link TransmissionUniforms.blur}) reads
 * in a `width` pixels wide picture: three.js filters the picture's mip level `log2(width) × blur`
 * bicubically (about three texels of 2^level pixels each way), and the depth check reads two
 * pixels around it.
 */
export function blurMargin(width: number, blur: number): number {
  return 8 + 6 * Math.pow(Math.max(1, width), Math.min(1, Math.max(0, blur)));
}

/**
 * The part of a `width` × `height` picture an object's lookups read: its box seen by `camera`,
 * widened by how far a lookup moves from the surface (three.js offsets it along the refracted ray
 * by the material's `thickness`, scaled like the object) and by the blur of rough glass. Null when
 * it may read any part of it (the box reaches behind the camera); an empty rectangle when it reads
 * nothing (the object is off screen).
 */
export function lookupRect(
  it: LayerItem,
  camera: THREE.Camera,
  width: number,
  height: number,
): PixelRect | null {
  const scale = it.mesh.matrixWorld.getMaxScaleOnAxis();
  let reach = 0;
  let blur = 0;
  for (const x of materialsOf(it.mesh)) {
    const u = transmissionOf(x);
    if (!u) continue;
    reach = Math.max(reach, u.thickness.value * scale);
    blur = Math.max(blur, u.blur);
  }
  const [x0, y0, x1, y1] = screenRect(it.box.clone().expandByScalar(reach), camera);
  if (x0 <= -1 && y0 <= -1 && x1 >= 1 && y1 >= 1) return null;
  // three.js roughens curved surfaces a little more where their normals turn quickly on screen
  const m = Math.ceil(blurMargin(width, Math.min(1, blur + GEOMETRY_BLUR)));
  /** A normalized device coordinate in pixels, `pad` more (clamped to the picture). */
  const px = (ndc: number, size: number, pad: number) => {
    const v = ((ndc + 1) / 2) * size;
    return Math.min(size, Math.max(0, (pad < 0 ? Math.floor(v) : Math.ceil(v)) + pad));
  };
  return [px(x0, width, -m), px(y0, height, -m), px(x1, width, m), px(y1, height, m)];
}

/**
 * Pictures that cover less than this part of the frame are drawn with a scissor (only there): over
 * it, drawing all of it costs about the same.
 */
const SCISSOR_MAX_AREA = 0.75;

/** Draws the pictures transmissive objects refract (see the module comment). */
export class TransmissionLayers {
  private targets: THREE.WebGLRenderTarget[] = [];
  /** The transmissive objects of the last {@link prepare} and their levels (tests and diagnostics). */
  lastItems: LayerItem[] = [];
  /** Pictures drawn by the last {@link prepare}. */
  lastPictures = 0;
  /** The part of each picture the last {@link prepare} drew (null: all of it; tests and diagnostics). */
  lastRects: (PixelRect | null)[] = [];

  /**
   * Call right before rendering `scene` with `camera` into a `width` × `height` target: draws the
   * pictures the transmissive objects on screen refract and points their materials at them (nothing
   * but a traversal of the scene when there are none). `clearAlpha` 0 keeps a transparent film's
   * background transparent behind glass. `maxLevels` 1 draws only the picture of the opaque scene
   * (heavy scenes: each level renders the whole scene once more).
   */
  prepare(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    clearAlpha = 1,
    maxLevels = MAX_TRANSMISSION_LEVELS,
  ): void {
    // where the objects are now (three.js updates the matrices in render(), after this)
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const items: LayerItem[] = [];
    scene.traverseVisible((o) => {
      const shadow = (o as THREE.Light & { shadow?: THREE.LightShadow }).shadow;
      if ((o as THREE.Light).isLight && shadow) shadow.camera.layers.enable(HIDDEN_LAYER);
      const m = o as THREE.Mesh;
      if (!m.isMesh || !materialsOf(m).some(transmissionOf)) return;
      const box = localBox(m).applyMatrix4(m.matrixWorld);
      if (box.isEmpty()) return;
      const centre = box.getCenter(new THREE.Vector3());
      items.push({ mesh: m, box, rect: screenRect(box, camera), distance: centre.distanceTo(eye), level: 0 });
    });
    this.lastItems = items;
    this.lastPictures = 0;
    this.lastRects = [];
    if (!items.length) return;
    if (items.length <= MAX_LAYERED_OBJECTS && maxLevels > 1) assignLevels(items, maxLevels - 1);
    const top = Math.max(...items.map((it) => it.level));
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    // the part of each picture its objects read (a picture nobody on screen reads is not drawn)
    const rects: (PixelRect | null)[] = [];
    for (let l = 0; l <= top; l++) {
      let union: PixelRect | null = [w, h, 0, 0];
      for (const it of items) {
        if (it.level !== l || !union) continue;
        const r = lookupRect(it, camera, w, h);
        if (!r) union = null;
        else if (r[2] > r[0] && r[3] > r[1])
          union = [
            Math.min(union[0], r[0]),
            Math.min(union[1], r[1]),
            Math.max(union[2], r[2]),
            Math.max(union[3], r[3]),
          ];
      }
      if (
        union &&
        union[2] > union[0] &&
        (union[2] - union[0]) * (union[3] - union[1]) > SCISSOR_MAX_AREA * w * h
      )
        union = null;
      rects.push(union);
    }
    this.lastRects = rects;
    for (let l = 0; l <= top; l++) {
      let t = this.targets[l];
      if (!t) {
        t = this.targets[l] = new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType,
          generateMipmaps: true,
          minFilter: THREE.LinearMipmapLinearFilter,
          magFilter: THREE.LinearFilter,
          depthTexture: new THREE.DepthTexture(w, h),
        });
      }
      if (t.width !== w || t.height !== h) t.setSize(w, h);
    }
    /** Points the materials of the objects up to `level` at their pictures. */
    const point = (level: number) => {
      for (const it of items) {
        if (it.level > level) continue;
        const t = this.targets[it.level];
        for (const x of materialsOf(it.mesh)) {
          const u = transmissionOf(x);
          if (!u) continue;
          u.map.value = t.texture;
          u.depth.value = t.depthTexture;
          u.size.value.set(t.width, t.height);
        }
      }
    };
    const layers = items.map((it) => it.mesh.layers.mask);
    const prevTarget = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    try {
      if (clearAlpha < 1) renderer.setClearColor(0x000000, clearAlpha);
      for (let l = 0; l <= top; l++) {
        // the picture of level l: everything but the transmissive objects of level l and above,
        // those below refracting their own pictures
        items.forEach((it, i) => {
          if (it.level >= l) it.mesh.layers.set(HIDDEN_LAYER);
          else it.mesh.layers.mask = layers[i];
        });
        point(l - 1);
        const t = this.targets[l];
        const r = rects[l];
        // its objects are off screen: nothing reads it
        if (r && !(r[2] > r[0] && r[3] > r[1])) continue;
        t.scissorTest = false;
        renderer.setRenderTarget(t);
        if (r) {
          // drawn only where its objects read it; around that it holds the clear colour (what the
          // blur of rough glass may reach), not an older picture
          renderer.clear();
          t.scissor.set(r[0], r[1], r[2] - r[0], r[3] - r[1]);
          t.scissorTest = true;
          renderer.setRenderTarget(t);
        }
        renderer.render(scene, camera);
        t.scissorTest = false;
        this.lastPictures++;
      }
    } finally {
      items.forEach((it, i) => (it.mesh.layers.mask = layers[i]));
      for (const t of this.targets) if (t) t.scissorTest = false;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevColor, prevAlpha);
    }
    point(top);
  }

  dispose(): void {
    for (const t of this.targets) {
      t?.depthTexture?.dispose();
      t?.dispose();
    }
    this.targets = [];
  }
}
