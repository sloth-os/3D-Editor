import type { Mat4, Vec3 } from '../math/types';
import { invert4, normalMatrix4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { meshBounds } from '../mesh/types';
import { buildRenderBuffers, type RenderBuffers } from '../mesh/render-buffers';
import { PATTERN_STRIDE, rampPattern, samplePattern, type CompiledProcedural } from '../material/procedural';
import { bumpNormal, compiledCoord, type ProceduralSurface } from '../material/surface';
import { evalSkyIrradiance, sampleSkyModel, type SkyModel } from './sky';
import {
  envBRDF,
  environmentIrradiance,
  sampleEnvironmentLighting,
  type EnvironmentLighting,
} from './env-light';
import type { RenderView } from './view';

/*
 * Z-buffered triangle rasterizer with perspective-correct attribute interpolation.
 *
 * - Geometry is transformed per object, triangles are drawn front to back (cheap early depth
 *   rejection, every visible sample is shaded about once).
 * - Clipping happens in homogeneous clip space against the near plane and a guard band.
 * - Depth is stored as 1/w for perspective views (uniform relative precision, independent of the
 *   near plane) and as 1 − z_ndc for orthographic ones; larger is closer.
 * - Shading is forward, per sample; supersampling and resolve happen in the caller.
 */

export const SHADE_MATERIAL = 0;
export const SHADE_SOLID = 1;

/** Per material-slot surface parameters (linear colors). */
export interface SurfaceMaterial {
  r: number;
  g: number;
  b: number;
  alpha: number;
  metallic: number;
  roughness: number;
  er: number;
  eg: number;
  eb: number;
  /**
   * 0 opaque, 1 alpha clip, 2 alpha blend (drawn after the opaque surfaces, sorted back to front,
   * each sample blended with what is behind it by `alpha`).
   */
  blend: number;
  threshold: number;
  cull: boolean;
  vertexColors: boolean;
  /** Base color texture (sRGB RGBA8, sampled bilinearly with repeat wrapping) and its UV transform. */
  tex: SampledTexture | null;
  texScale: [number, number];
  texOffset: [number, number];
  /**
   * Procedural texture channels (MATERIAL shading, see material/surface.ts). With a procedural
   * alpha channel `alpha` must exclude the material alpha (the texture replaces it).
   */
  procedural?: ProceduralSurface | null;
  /** Emission strength (multiplies a procedural emission colour). */
  emissionStrength?: number;
  /**
   * Principled transmission 0..1 (glass): replaces the diffuse part; the surface is drawn in the
   * blended pass and lets what is behind it through, tinted by the base colour and reduced by the
   * Fresnel reflection (no refraction).
   */
  transmission?: number;
  /** Index of refraction (dielectric Fresnel reflectance F0 = ((ior − 1) / (ior + 1))², default 1.5). */
  ior?: number;
}

/** Per-object state the shading of a deferred (transparent) triangle needs. */
interface ObjectState {
  invWorld: Mat4;
  texMin: Vec3;
  texSize: Vec3;
}

/** Procedural sky lighting: diffuse irradiance SH (E/π) and the sky for reflections, × scale. */
export interface SkyLighting {
  sh: Float64Array;
  model: SkyModel;
  scale: number;
}

export interface SampledTexture {
  width: number;
  height: number;
  /** RGBA8, sRGB encoded, top row first. */
  data: Uint8ClampedArray;
}

/** sRGB byte → linear lookup. */
const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** Light types in the packed light array. */
export const LIGHT_POINT = 0;
export const LIGHT_SPOT = 1;
export const LIGHT_AREA = 2;
export const LIGHT_SUN = 3;
/** Packed light record: kind, position xyz, direction xyz (where it points), rgb (color × intensity), spotCos, spotSmooth, radius². */
export const LIGHT_STRIDE = 13;

/**
 * Vertex record in screen space: sx, sy, depthKey, 1/w, normal xyz, world position xyz, rgba, uv,
 * undeformed object-space position xyz (GENERATED procedural coordinates).
 */
const VS = 19;
const GUARD = 64;
/**
 * Cached procedural values per output pixel: base rgb, alpha factor, metallic, roughness, emission
 * rgb, bumped normal xyz (NaN until computed), bump height.
 */
const PROC_VALUES = 13;
const INV_PI = 1 / Math.PI;
/** Angular radius of a sun lamp's disc for its highlight (Blender's default sun angle 0.526°). */
const SUN_ANGULAR_RADIUS = 0.00459;

export class Rasterizer {
  readonly color: Float32Array;
  readonly cov: Float32Array;
  readonly depth: Float32Array;
  /** Ambient (world) radiance. */
  ambient: [number, number, number] = [0, 0, 0];
  lights: Float64Array = new Float64Array(0);
  lightCount = 0;
  mode = SHADE_MATERIAL;
  /** Wireframe overlay: half line width in samples and color/opacity. */
  wireHalfWidth = 0;
  wireColor: [number, number, number, number] = [0, 0, 0, 0.6];
  /** Procedural sky lighting (environment SKY); replaces the uniform `ambient` when set. */
  sky: SkyLighting | null = null;
  /**
   * Image-based lighting of a STUDIO or IMAGE world (diffuse irradiance and prefiltered
   * reflections, see env-light.ts); replaces the uniform `ambient` when set.
   */
  env: EnvironmentLighting | null = null;
  /**
   * Reflection probe (the lit scene seen from the camera, see `probeLighting`): replaces the world
   * as the source of reflections when set, so metals and glossy surfaces reflect the lit room,
   * floor and objects around them (one bounce, like the path tracer's first reflection).
   */
  probe: EnvironmentLighting | null = null;
  /** World mist (MATERIAL shading): 1 − exp(−(density·depth)²) towards `mistColor`; 0 disables. */
  mistDensity = 0;
  mistColor: [number, number, number] = [0, 0, 0];
  /**
   * Samples per output pixel side (the caller's supersampling factor): procedural textures are
   * evaluated once per output pixel and triangle and shared by its samples (like MSAA shading).
   */
  shadingBlock = 1;
  /**
   * Render buffers per mesh, shared by the rasterizers of one render (the reflection probe faces,
   * linked duplicates and instances draw the same mesh several times).
   */
  bufferCache: Map<MeshData, RenderBuffers> | null = null;
  /**
   * Skip back faces of every material (reflection probes: from a point inside or on a closed
   * object, its far side does not block the view of the surroundings).
   */
  cullBackFaces = false;
  /**
   * Transparent triangles (alpha blend, transmission) waiting for `flushTransparent`: VS numbers
   * per vertex, three vertices per triangle, with their material, facing, wire flags and object.
   */
  private tVerts = new Float64Array(VS * 3 * 64);
  private tCount = 0;
  private tInfo: { mat: SurfaceMaterial; back: boolean; wire: number; state: ObjectState | null }[] = [];
  /** Object state of the mesh being drawn (procedural texture coordinates). */
  private curState: ObjectState | null = null;
  /** Set while `flushTransparent` draws: blend instead of overwriting, no depth writes. */
  private blendPass = false;
  /** n·v of the last `shadeMaterial` call (glass Fresnel). */
  private outNdv = 1;
  /** Per output-pixel column: triangle serial, block row and cached procedural values. */
  private procTri = new Int32Array(0);
  private procRow = new Int32Array(0);
  private procVal = new Float64Array(0);
  private triSerial = 0;
  /** Pattern values of the distinct patterns of the current procedural material. */
  private patBuf = new Float64Array(PATTERN_STRIDE * 6);
  /** Current object: world → object matrix and GENERATED texture space (procedural textures). */
  private invWorld: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  private texMin: Vec3 = [0, 0, 0];
  private texSize: Vec3 = [1, 1, 1];
  /** Per-pixel material with procedural overrides (only the fields shadeMaterial reads). */
  private readonly pm: SurfaceMaterial = {
    r: 0,
    g: 0,
    b: 0,
    alpha: 1,
    metallic: 0,
    roughness: 0.5,
    er: 0,
    eg: 0,
    eb: 0,
    blend: 0,
    threshold: 0.5,
    cull: false,
    vertexColors: false,
    tex: null,
    texScale: [1, 1],
    texOffset: [0, 0],
  };
  private readonly pxv = new Float64Array(4);
  private readonly pc: Vec3 = [0, 0, 0];
  private readonly pcx: Vec3 = [0, 0, 0];
  private readonly pcy: Vec3 = [0, 0, 0];
  private readonly ppx: Vec3 = [0, 0, 0];
  private readonly ppy: Vec3 = [0, 0, 0];
  private readonly pn: Vec3 = [0, 0, 0];
  private readonly skyTmp = new Float64Array(3);
  private readonly skyTmp2 = new Float64Array(3);
  private readonly brdfTmp = new Float64Array(2);
  private readonly scr = new Float64Array(VS * 16);
  private clipA = new Float64Array(VS * 16);
  private clipB = new Float64Array(VS * 16);
  private outR = 0;
  private outG = 0;
  private outB = 0;
  private texR = 1;
  private texG = 1;
  private texB = 1;
  private texA = 1;
  private readonly zMin: number;
  private readonly solidL: Float64Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly view: RenderView,
  ) {
    const n = width * height;
    this.color = new Float32Array(n * 3);
    this.cov = new Float32Array(n);
    this.depth = new Float32Array(n);
    this.zMin = view.ortho ? 0 : 1 / view.far;
    // SOLID studio lights fixed relative to the view (key, fill, rim): world-space direction + weight
    const toWorld = (x: number, y: number, z: number): number[] => {
      const l = Math.hypot(x, y, z);
      const v = view;
      return [
        (v.right[0] * x + v.up[0] * y - v.forward[0] * z) / l,
        (v.right[1] * x + v.up[1] * y - v.forward[1] * z) / l,
        (v.right[2] * x + v.up[2] * y - v.forward[2] * z) / l,
      ];
    };
    this.solidL = new Float64Array([
      ...toWorld(-0.4, 0.6, 0.7),
      0.44,
      ...toWorld(0.75, 0.1, 0.65),
      0.16,
      ...toWorld(0.1, 0.75, -0.65),
      0.14,
    ]);
  }

  /**
   * Draws a mesh object. `materials` is indexed by material slot; `fallback` is used for empty slots.
   * `texSpace` is the GENERATED texture space of procedural textures (default: the mesh bounds) and
   * `texSpace.orco` the undeformed position of every mesh vertex (xyz per vertex, see
   * material/orco.ts; default: the mesh positions), from which GENERATED coordinates are computed.
   */
  drawMesh(
    mesh: MeshData,
    world: Mat4,
    materials: SurfaceMaterial[],
    fallback: SurfaceMaterial,
    texSpace?: { min: Readonly<Vec3>; max: Readonly<Vec3>; orco?: ArrayLike<number> | null } | null,
  ): void {
    if (!mesh.faces.length || this.offscreen(mesh, world)) return;
    const procedural = materials.some((m) => m?.procedural);
    if (procedural) {
      const cols = Math.ceil(this.width / Math.max(1, this.shadingBlock | 0)) + 1;
      if (this.procTri.length < cols) {
        this.procTri = new Int32Array(cols);
        this.procRow = new Int32Array(cols);
        this.procVal = new Float64Array(cols * PROC_VALUES);
      }
      this.invWorld = invert4(world);
      const ts = texSpace ?? meshBounds(mesh) ?? { min: [0, 0, 0], max: [1, 1, 1] };
      this.texMin = [0, 0, 0];
      this.texSize = [1, 1, 1];
      for (let k = 0; k < 3; k++) {
        this.texMin[k] = ts.min[k];
        this.texSize[k] = ts.max[k] - ts.min[k];
      }
    }
    this.curState = procedural
      ? { invWorld: this.invWorld, texMin: this.texMin, texSize: this.texSize }
      : null;
    let rb = this.bufferCache?.get(mesh);
    if (!rb) {
      rb = buildRenderBuffers(mesh);
      this.bufferCache?.set(mesh, rb);
    }
    const nv = rb.positions.length / 3;
    const tris = rb.indices.length / 3;
    if (!tris) return;
    // undeformed object-space position per render vertex (GENERATED procedural coordinates)
    let og: Float64Array | null = null;
    if (procedural) {
      og = Float64Array.from(rb.positions);
      const orco = texSpace?.orco;
      if (orco && orco.length === mesh.positions.length) {
        const src = rb.vertexSource;
        for (let i = 0; i < nv; i++) {
          const s = src[i] * 3;
          og[i * 3] = orco[s];
          og[i * 3 + 1] = orco[s + 1];
          og[i * 3 + 2] = orco[s + 2];
        }
      }
    }
    const M = world;
    const NM = normalMatrix4(M);
    // mirroring transforms reverse the winding of world-space triangles
    const mirrored =
      M[0] * (M[5] * M[10] - M[6] * M[9]) -
        M[4] * (M[1] * M[10] - M[2] * M[9]) +
        M[8] * (M[1] * M[6] - M[2] * M[5]) <
      0;
    const VP = this.view.viewProj;
    const wp = new Float64Array(nv * 3);
    const wn = new Float64Array(nv * 3);
    const cl = new Float64Array(nv * 4);
    const oc = new Uint8Array(nv);
    const gc = new Uint8Array(nv);
    const P = rb.positions;
    const Nr = rb.normals;
    for (let i = 0; i < nv; i++) {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
      const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
      const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
      wp[i * 3] = wx;
      wp[i * 3 + 1] = wy;
      wp[i * 3 + 2] = wz;
      const a = Nr[i * 3];
      const b = Nr[i * 3 + 1];
      const c = Nr[i * 3 + 2];
      let nx = NM[0] * a + NM[4] * b + NM[8] * c;
      let ny = NM[1] * a + NM[5] * b + NM[9] * c;
      let nz = NM[2] * a + NM[6] * b + NM[10] * c;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      wn[i * 3] = nx;
      wn[i * 3 + 1] = ny;
      wn[i * 3 + 2] = nz;
      const cx = VP[0] * wx + VP[4] * wy + VP[8] * wz + VP[12];
      const cy = VP[1] * wx + VP[5] * wy + VP[9] * wz + VP[13];
      const cz = VP[2] * wx + VP[6] * wy + VP[10] * wz + VP[14];
      const cw = VP[3] * wx + VP[7] * wy + VP[11] * wz + VP[15];
      cl[i * 4] = cx;
      cl[i * 4 + 1] = cy;
      cl[i * 4 + 2] = cz;
      cl[i * 4 + 3] = cw;
      oc[i] =
        (cx < -cw ? 1 : 0) |
        (cx > cw ? 2 : 0) |
        (cy < -cw ? 4 : 0) |
        (cy > cw ? 8 : 0) |
        (cz < -cw ? 16 : 0) |
        (cz > cw ? 32 : 0);
      gc[i] =
        (cz < -cw ? 16 : 0) |
        (cx < -GUARD * cw || cx > GUARD * cw || cy < -GUARD * cw || cy > GUARD * cw ? 1 : 0);
    }
    const triMat: SurfaceMaterial[] = new Array(tris);
    for (const g of rb.groups) {
      const m = materials[g.materialIndex] ?? fallback;
      for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) triMat[t] = m;
    }
    const edges = this.wireHalfWidth > 0 ? wireEdgeFlags(mesh, rb) : null;
    // front-to-back order by nearest vertex
    const idx = rb.indices;
    const keys = new Float64Array(tris);
    const persp = !this.view.ortho;
    for (let t = 0; t < tris; t++) {
      let k = -Infinity;
      for (let j = 0; j < 3; j++) {
        const v = idx[t * 3 + j];
        const w = cl[v * 4 + 3];
        const key = persp ? (w > 0 ? 1 / w : Infinity) : -cl[v * 4 + 2];
        if (key > k) k = key;
      }
      keys[t] = k;
    }
    const order = new Uint32Array(tris);
    for (let t = 0; t < tris; t++) order[t] = t;
    order.sort((a, b) => keys[b] - keys[a]);
    const colors = rb.colors;
    const uvs = rb.uvs;
    const eye = this.view.eye;
    const fwd = this.view.forward;
    for (let n = 0; n < tris; n++) {
      const t = order[n];
      const i0 = idx[t * 3];
      const i1 = idx[t * 3 + 1];
      const i2 = idx[t * 3 + 2];
      if (oc[i0] & oc[i1] & oc[i2]) continue;
      const mat = triMat[t];
      // facing from world-space geometry (robust for clipped triangles and mirrored objects)
      const ax = wp[i1 * 3] - wp[i0 * 3];
      const ay = wp[i1 * 3 + 1] - wp[i0 * 3 + 1];
      const az = wp[i1 * 3 + 2] - wp[i0 * 3 + 2];
      const bx = wp[i2 * 3] - wp[i0 * 3];
      const by = wp[i2 * 3 + 1] - wp[i0 * 3 + 1];
      const bz = wp[i2 * 3 + 2] - wp[i0 * 3 + 2];
      const fx = ay * bz - az * by;
      const fy = az * bx - ax * bz;
      const fz = ax * by - ay * bx;
      const facing = persp
        ? fx * (eye[0] - wp[i0 * 3]) + fy * (eye[1] - wp[i0 * 3 + 1]) + fz * (eye[2] - wp[i0 * 3 + 2])
        : -(fx * fwd[0] + fy * fwd[1] + fz * fwd[2]);
      const back = facing < 0 !== mirrored;
      if (back && (mat.cull || this.cullBackFaces)) continue;
      const wire = edges ? edges[t] : 0;
      // alpha-blended and transmissive surfaces wait for the sorted transparent pass
      const deferred = this.mode === SHADE_MATERIAL && (mat.blend === 2 || (mat.transmission ?? 0) > 0);
      if (!(gc[i0] | gc[i1] | gc[i2])) {
        this.loadScreen(0, i0, cl, wn, wp, colors, uvs, og);
        this.loadScreen(1, i1, cl, wn, wp, colors, uvs, og);
        this.loadScreen(2, i2, cl, wn, wp, colors, uvs, og);
        if (deferred) this.defer(0, 1, 2, mat, back, wire);
        else this.fill(0, 1, 2, mat, back, wire);
      } else {
        const A = this.clipA;
        loadClip(A, 0, i0, cl, wn, wp, colors, uvs, og);
        loadClip(A, 1, i1, cl, wn, wp, colors, uvs, og);
        loadClip(A, 2, i2, cl, wn, wp, colors, uvs, og);
        const n2 = this.clipPolygon(3);
        for (let j = 0; j < n2; j++) this.projectClip(j);
        for (let j = 1; j + 1 < n2; j++)
          if (deferred) this.defer(0, j, j + 1, mat, back, 0);
          else this.fill(0, j, j + 1, mat, back, 0);
      }
    }
  }

  /** Stores the screen-space triangle in scratch slots a, b, c for the transparent pass. */
  private defer(a: number, b: number, c: number, mat: SurfaceMaterial, back: boolean, wire: number): void {
    const need = (this.tCount + 1) * VS * 3;
    if (need > this.tVerts.length) {
      const grown = new Float64Array(Math.max(need, this.tVerts.length * 2));
      grown.set(this.tVerts);
      this.tVerts = grown;
    }
    const o = this.tCount * VS * 3;
    const S = this.scr;
    this.tVerts.set(S.subarray(a * VS, a * VS + VS), o);
    this.tVerts.set(S.subarray(b * VS, b * VS + VS), o + VS);
    this.tVerts.set(S.subarray(c * VS, c * VS + VS), o + 2 * VS);
    this.tInfo.push({ mat, back, wire, state: this.curState });
    this.tCount++;
  }

  /**
   * Draws the transparent triangles collected by `drawMesh` (call after every mesh is drawn):
   * sorted far to near by their mean depth and blended over what is already in the buffers —
   * smooth alpha blending (BLEND) and see-through glass (transmission) instead of screen-door
   * dithering. They test against but do not write the depth buffer.
   */
  flushTransparent(): void {
    const n = this.tCount;
    if (!n) return;
    const V = this.tVerts;
    const keys = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      const o = t * VS * 3;
      // depth keys: larger is closer (1/w, or 1 − z_ndc for orthographic views)
      keys[t] = V[o + 2] + V[o + VS + 2] + V[o + 2 * VS + 2];
    }
    const order = new Uint32Array(n);
    for (let t = 0; t < n; t++) order[t] = t;
    order.sort((a, b) => keys[a] - keys[b] || a - b);
    const S = this.scr;
    const saved = { invWorld: this.invWorld, texMin: this.texMin, texSize: this.texSize };
    this.blendPass = true;
    try {
      for (let k = 0; k < n; k++) {
        const t = order[k];
        const info = this.tInfo[t];
        S.set(V.subarray(t * VS * 3, (t + 1) * VS * 3), 0);
        if (info.state) {
          this.invWorld = info.state.invWorld;
          this.texMin = info.state.texMin;
          this.texSize = info.state.texSize;
        }
        this.fill(0, 1, 2, info.mat, info.back, info.wire);
      }
    } finally {
      this.blendPass = false;
      this.invWorld = saved.invWorld;
      this.texMin = saved.texMin;
      this.texSize = saved.texSize;
      this.tCount = 0;
      this.tInfo = [];
    }
  }

  /** Whole-object frustum rejection from the transformed bounding box. */
  private offscreen(mesh: MeshData, M: Mat4): boolean {
    const bb = meshBounds(mesh);
    if (!bb) return true;
    const VP = this.view.viewProj;
    let all = 63;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? bb.max[0] : bb.min[0];
      const y = i & 2 ? bb.max[1] : bb.min[1];
      const z = i & 4 ? bb.max[2] : bb.min[2];
      const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
      const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
      const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
      const cx = VP[0] * wx + VP[4] * wy + VP[8] * wz + VP[12];
      const cy = VP[1] * wx + VP[5] * wy + VP[9] * wz + VP[13];
      const cz = VP[2] * wx + VP[6] * wy + VP[10] * wz + VP[14];
      const cw = VP[3] * wx + VP[7] * wy + VP[11] * wz + VP[15];
      all &=
        (cx < -cw ? 1 : 0) |
        (cx > cw ? 2 : 0) |
        (cy < -cw ? 4 : 0) |
        (cy > cw ? 8 : 0) |
        (cz < -cw ? 16 : 0) |
        (cz > cw ? 32 : 0);
      if (!all) return false;
    }
    return all !== 0;
  }

  private loadScreen(
    slot: number,
    v: number,
    cl: Float64Array,
    wn: Float64Array,
    wp: Float64Array,
    colors: Float32Array | null,
    uvs: Float32Array | null,
    og: Float64Array | null,
  ): void {
    const S = this.scr;
    const o = slot * VS;
    const w = cl[v * 4 + 3];
    const iw = 1 / w;
    S[o] = (cl[v * 4] * iw * 0.5 + 0.5) * this.width;
    S[o + 1] = (0.5 - cl[v * 4 + 1] * iw * 0.5) * this.height;
    S[o + 2] = this.view.ortho ? 1 - cl[v * 4 + 2] * iw : iw;
    S[o + 3] = this.view.ortho ? 1 : iw;
    S[o + 4] = wn[v * 3];
    S[o + 5] = wn[v * 3 + 1];
    S[o + 6] = wn[v * 3 + 2];
    S[o + 7] = wp[v * 3];
    S[o + 8] = wp[v * 3 + 1];
    S[o + 9] = wp[v * 3 + 2];
    if (colors) {
      S[o + 10] = colors[v * 4];
      S[o + 11] = colors[v * 4 + 1];
      S[o + 12] = colors[v * 4 + 2];
      S[o + 13] = colors[v * 4 + 3];
    } else S[o + 10] = S[o + 11] = S[o + 12] = S[o + 13] = 1;
    S[o + 14] = uvs ? uvs[v * 2] : 0;
    S[o + 15] = uvs ? uvs[v * 2 + 1] : 0;
    if (og) {
      S[o + 16] = og[v * 3];
      S[o + 17] = og[v * 3 + 1];
      S[o + 18] = og[v * 3 + 2];
    }
  }

  /** Sutherland–Hodgman against the near plane and the guard band; result in clipA. */
  private clipPolygon(n: number): number {
    // plane coefficients (x, y, z, w): z + w ≥ 0 (near), then guard band |x|, |y| ≤ G·w
    const planes = [
      [0, 0, 1, 1],
      [1, 0, 0, GUARD],
      [-1, 0, 0, GUARD],
      [0, 1, 0, GUARD],
      [0, -1, 0, GUARD],
    ];
    let src = this.clipA;
    let dst = this.clipB;
    for (const [a, b, c, d] of planes) {
      if (n < 3) break;
      let inside = 0;
      for (let i = 0; i < n; i++) {
        const o = i * VS;
        if (a * src[o] + b * src[o + 1] + c * src[o + 2] + d * src[o + 3] >= 0) inside++;
      }
      if (inside === n) continue;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const oc = i * VS;
        const on = ((i + 1) % n) * VS;
        const dc = a * src[oc] + b * src[oc + 1] + c * src[oc + 2] + d * src[oc + 3];
        const dn = a * src[on] + b * src[on + 1] + c * src[on + 2] + d * src[on + 3];
        if (dc >= 0) {
          for (let k = 0; k < VS; k++) dst[m * VS + k] = src[oc + k];
          m++;
        }
        if (dc >= 0 !== dn >= 0) {
          const t = dc / (dc - dn);
          for (let k = 0; k < VS; k++) dst[m * VS + k] = src[oc + k] + (src[on + k] - src[oc + k]) * t;
          m++;
        }
      }
      const tmp = src;
      src = dst;
      dst = tmp;
      n = m;
    }
    if (src !== this.clipA) {
      this.clipB = this.clipA;
      this.clipA = src;
    }
    return n < 3 ? 0 : n;
  }

  private projectClip(slot: number): void {
    const C = this.clipA;
    const S = this.scr;
    const o = slot * VS;
    const iw = 1 / C[o + 3];
    S[o] = (C[o] * iw * 0.5 + 0.5) * this.width;
    S[o + 1] = (0.5 - C[o + 1] * iw * 0.5) * this.height;
    S[o + 2] = this.view.ortho ? 1 - C[o + 2] * iw : iw;
    S[o + 3] = this.view.ortho ? 1 : iw;
    for (let k = 4; k < VS; k++) S[o + k] = C[o + k];
  }

  /** Rasterizes one screen-space triangle from scratch slots a, b, c. */
  private fill(a: number, b: number, c: number, mat: SurfaceMaterial, back: boolean, wire: number): void {
    const S = this.scr;
    const oa = a * VS;
    const ob = b * VS;
    const oc = c * VS;
    const x0 = S[oa];
    const y0 = S[oa + 1];
    const x1 = S[ob];
    const y1 = S[ob + 1];
    const x2 = S[oc];
    const y2 = S[oc + 1];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(area > 1e-12 || area < -1e-12)) return;
    const W = this.width;
    const H = this.height;
    const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
    const maxX = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
    const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
    const maxY = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    if (minX > maxX || minY > maxY) return;
    const inv = 1 / area;
    // normalized barycentric edge functions: w0 = E12 / area, ...
    const a0 = -(y2 - y1) * inv;
    const a1 = -(y0 - y2) * inv;
    const a2 = -(y1 - y0) * inv;
    const z0 = S[oa + 2];
    const z1 = S[ob + 2];
    const z2 = S[oc + 2];
    const q0 = S[oa + 3];
    const q1 = S[ob + 3];
    const q2 = S[oc + 3];
    // wireframe: distance (samples) to each real polygon edge = w_k · |area| / |edge|
    const absA = Math.abs(area);
    const d0 = wire & 2 ? absA / Math.hypot(x2 - x1, y2 - y1) : -1; // edge v1-v2 (opposite v0)
    const d1 = wire & 4 ? absA / Math.hypot(x0 - x2, y0 - y2) : -1; // edge v2-v0
    const d2 = wire & 1 ? absA / Math.hypot(x1 - x0, y1 - y0) : -1; // edge v0-v1
    const wireHalf = this.wireHalfWidth;
    const wc = this.wireColor;
    const flip = back ? -1 : 1;
    const zMin = this.zMin;
    const blend = mat.blend;
    const tex = this.mode === SHADE_MATERIAL ? mat.tex : null;
    const proc = this.mode === SHADE_MATERIAL ? (mat.procedural ?? null) : null;
    const serial = proc ? (this.triSerial = (this.triSerial + 1) | 0) : 0;
    // barycentric increments per pixel row (neighbour pixels for the procedural bump)
    const b0 = (x2 - x1) * inv;
    const b1 = (x0 - x2) * inv;
    const b2 = (x1 - x0) * inv;
    const depth = this.depth;
    const color = this.color;
    const cov = this.cov;
    // top-left fill rule: a sample exactly on an edge shared by two triangles belongs to one of
    // them only (blended surfaces must not be drawn twice along their triangulation diagonals)
    const e0 = a0 > 0 || (a0 === 0 && b0 > 0) ? -1e-7 : 1e-7;
    const e1 = a1 > 0 || (a1 === 0 && b1 > 0) ? -1e-7 : 1e-7;
    const e2 = a2 > 0 || (a2 === 0 && b2 > 0) ? -1e-7 : 1e-7;
    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      const cx0 = minX + 0.5;
      let w0 = ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx0 - x1)) * inv;
      let w1 = ((x0 - x2) * (cy - y2) - (y0 - y2) * (cx0 - x2)) * inv;
      let w2 = ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx0 - x0)) * inv;
      let row = py * W + minX;
      for (let px = minX; px <= maxX; px++, row++, w0 += a0, w1 += a1, w2 += a2) {
        if (w0 < e0 || w1 < e1 || w2 < e2) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        if (z <= depth[row] || z < zMin) continue;
        // perspective-correct weights
        let l0 = w0 * q0;
        let l1 = w1 * q1;
        let l2 = w2 * q2;
        const s = 1 / (l0 + l1 + l2);
        l0 *= s;
        l1 *= s;
        l2 *= s;
        let cr = 1;
        let cg = 1;
        let cb = 1;
        let ca = 1;
        if (mat.vertexColors) {
          cr = l0 * S[oa + 10] + l1 * S[ob + 10] + l2 * S[oc + 10];
          cg = l0 * S[oa + 11] + l1 * S[ob + 11] + l2 * S[oc + 11];
          cb = l0 * S[oa + 12] + l1 * S[ob + 12] + l2 * S[oc + 12];
          ca = l0 * S[oa + 13] + l1 * S[ob + 13] + l2 * S[oc + 13];
        }
        if (tex) {
          const u =
            (l0 * S[oa + 14] + l1 * S[ob + 14] + l2 * S[oc + 14]) * mat.texScale[0] + mat.texOffset[0];
          const v =
            (l0 * S[oa + 15] + l1 * S[ob + 15] + l2 * S[oc + 15]) * mat.texScale[1] + mat.texOffset[1];
          this.sample(tex, u, v);
          cr *= this.texR;
          cg *= this.texG;
          cb *= this.texB;
          ca *= this.texA;
        }
        // procedural channels override the material values; they are evaluated once per output
        // pixel and triangle (cached per output-pixel column) and shared by its samples
        let sm = mat;
        let br = mat.r;
        let bg = mat.g;
        let bb = mat.b;
        const pv = this.procVal;
        let po = 0;
        if (proc) {
          const blk = this.shadingBlock;
          const slot = blk > 1 ? (px / blk) | 0 : px;
          const rowBlk = blk > 1 ? (py / blk) | 0 : py;
          po = slot * PROC_VALUES;
          if (this.procTri[slot] !== serial || this.procRow[slot] !== rowBlk) {
            this.procTri[slot] = serial;
            this.procRow[slot] = rowBlk;
            this.shadeProcedural(proc, mat, l0, l1, l2, oa, ob, oc, po);
          }
          br = pv[po];
          bg = pv[po + 1];
          bb = pv[po + 2];
          ca *= pv[po + 3];
          const pm = this.pm;
          pm.metallic = pv[po + 4];
          pm.roughness = pv[po + 5];
          pm.er = pv[po + 6];
          pm.eg = pv[po + 7];
          pm.eb = pv[po + 8];
          sm = pm;
        }
        // coverage: alpha clip (binary) or, in the transparent pass, alpha blending
        let a = 1;
        if (blend === 1) {
          if (mat.alpha * ca < mat.threshold) continue;
        } else if (blend === 2 && this.blendPass) {
          a = mat.alpha * ca;
          if (!(a > 1e-4)) continue;
          if (a > 1) a = 1;
        }
        if (!this.blendPass) depth[row] = z;
        let nx = (l0 * S[oa + 4] + l1 * S[ob + 4] + l2 * S[oc + 4]) * flip;
        let ny = (l0 * S[oa + 5] + l1 * S[ob + 5] + l2 * S[oc + 5]) * flip;
        let nz = (l0 * S[oa + 6] + l1 * S[ob + 6] + l2 * S[oc + 6]) * flip;
        const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        nx *= nl;
        ny *= nl;
        nz *= nl;
        const wx = l0 * S[oa + 7] + l1 * S[ob + 7] + l2 * S[oc + 7];
        const wy = l0 * S[oa + 8] + l1 * S[ob + 8] + l2 * S[oc + 8];
        const wz = l0 * S[oa + 9] + l1 * S[ob + 9] + l2 * S[oc + 9];
        if (proc?.normal && proc.bump !== 0) {
          if (pv[po + 9] === pv[po + 9]) {
            // bumped normal of this pixel's first sample (not NaN)
            nx = pv[po + 9];
            ny = pv[po + 10];
            nz = pv[po + 11];
          } else {
            // offsets to the neighbour pixels (like the shader's dFdx/dFdy), then Mikkelsen bump
            const pn = this.pn;
            pn[0] = nx;
            pn[1] = ny;
            pn[2] = nz;
            this.coordAt(proc.normal, l0, l1, l2, oa, ob, oc, this.pc);
            if (
              this.neighbour(proc.normal, w0 + a0, w1 + a1, w2 + a2, q0, q1, q2, oa, ob, oc, wx, wy, wz, 0) &&
              this.neighbour(proc.normal, w0 + b0, w1 + b1, w2 + b2, q0, q1, q2, oa, ob, oc, wx, wy, wz, 1)
            ) {
              const h0 = pv[po + 12];
              bumpNormal(proc.normal, proc.bump, this.pc, this.pcx, this.pcy, this.ppx, this.ppy, pn, pn, h0);
              nx = pn[0];
              ny = pn[1];
              nz = pn[2];
            }
            pv[po + 9] = nx;
            pv[po + 10] = ny;
            pv[po + 11] = nz;
          }
        }
        if (this.mode === SHADE_SOLID) this.shadeSolid(mat, nx, ny, nz);
        else this.shadeMaterial(sm, nx, ny, nz, wx, wy, wz, br * cr, bg * cg, bb * cb);
        let r = this.outR;
        let g = this.outG;
        let b = this.outB;
        if (this.mistDensity > 0 && this.mode === SHADE_MATERIAL) {
          // FogExp2 over the planar view depth (as three.js scene fog)
          const e = this.view.eye;
          const f = this.view.forward;
          const k = this.mistDensity * ((wx - e[0]) * f[0] + (wy - e[1]) * f[1] + (wz - e[2]) * f[2]);
          const m = 1 - Math.exp(-k * k);
          const mc = this.mistColor;
          r += (mc[0] - r) * m;
          g += (mc[1] - g) * m;
          b += (mc[2] - b) * m;
        }
        if (wire) {
          let d = Infinity;
          if (d0 >= 0) d = w0 * d0;
          if (d1 >= 0 && w1 * d1 < d) d = w1 * d1;
          if (d2 >= 0 && w2 * d2 < d) d = w2 * d2;
          if (d < wireHalf) {
            const k = wc[3];
            r += (wc[0] - r) * k;
            g += (wc[1] - g) * k;
            b += (wc[2] - b) * k;
          }
        }
        if (this.blendPass) {
          // premultiplied "over": the covered fraction a shows this surface plus, through glass,
          // what is behind it (transmittance: base colour × (1 − Fresnel) × transmission)
          let tr = 0;
          let tg = 0;
          let tb = 0;
          const trans = mat.transmission ?? 0;
          if (trans > 0 && this.mode === SHADE_MATERIAL) {
            const ior = mat.ior ?? 1.5;
            const f = (ior - 1) / (ior + 1);
            const f0 = f * f;
            const cv = 1 - (this.outNdv > 0 ? this.outNdv : 0);
            const cv2 = cv * cv;
            const k = trans * (1 - sm.metallic) * (1 - (f0 + (1 - f0) * cv2 * cv2 * cv));
            tr = k * Math.min(1, br * cr);
            tg = k * Math.min(1, bg * cg);
            tb = k * Math.min(1, bb * cb);
          }
          const o3 = row * 3;
          color[o3] = a * r + color[o3] * (1 - a + a * tr);
          color[o3 + 1] = a * g + color[o3 + 1] * (1 - a + a * tg);
          color[o3 + 2] = a * b + color[o3 + 2] * (1 - a + a * tb);
          const opacity = a * (1 - (0.2126 * tr + 0.7152 * tg + 0.0722 * tb));
          cov[row] = opacity + cov[row] * (1 - opacity);
          continue;
        }
        color[row * 3] = r;
        color[row * 3 + 1] = g;
        color[row * 3 + 2] = b;
        cov[row] = 1;
      }
    }
  }

  /** Texture coordinate of a procedural channel at perspective-correct barycentrics l0..l2. */
  private coordAt(
    c: CompiledProcedural,
    l0: number,
    l1: number,
    l2: number,
    oa: number,
    ob: number,
    oc: number,
    out: Vec3,
  ): void {
    const S = this.scr;
    const u = l0 * S[oa + 14] + l1 * S[ob + 14] + l2 * S[oc + 14];
    const v = l0 * S[oa + 15] + l1 * S[ob + 15] + l2 * S[oc + 15];
    if (c.mapping === 2) {
      compiledCoord(2, 0, 0, 0, this.texMin, this.texSize, u, v, out);
      return;
    }
    if (c.mapping === 0) {
      // GENERATED: undeformed position (sticks to the surface under deformation)
      compiledCoord(
        0,
        l0 * S[oa + 16] + l1 * S[ob + 16] + l2 * S[oc + 16],
        l0 * S[oa + 17] + l1 * S[ob + 17] + l2 * S[oc + 17],
        l0 * S[oa + 18] + l1 * S[ob + 18] + l2 * S[oc + 18],
        this.texMin,
        this.texSize,
        u,
        v,
        out,
      );
      return;
    }
    const wx = l0 * S[oa + 7] + l1 * S[ob + 7] + l2 * S[oc + 7];
    const wy = l0 * S[oa + 8] + l1 * S[ob + 8] + l2 * S[oc + 8];
    const wz = l0 * S[oa + 9] + l1 * S[ob + 9] + l2 * S[oc + 9];
    const M = this.invWorld;
    compiledCoord(
      c.mapping,
      M[0] * wx + M[4] * wy + M[8] * wz + M[12],
      M[1] * wx + M[5] * wy + M[9] * wz + M[13],
      M[2] * wx + M[6] * wy + M[10] * wz + M[14],
      this.texMin,
      this.texSize,
      u,
      v,
      out,
    );
  }

  /**
   * Evaluates the procedural channels of a material at perspective-correct barycentrics l0..l2
   * into `procVal[o ..]` (see PROC_VALUES): every distinct pattern once, then each channel's ramp.
   */
  private shadeProcedural(
    p: ProceduralSurface,
    mat: SurfaceMaterial,
    l0: number,
    l1: number,
    l2: number,
    oa: number,
    ob: number,
    oc: number,
    o: number,
  ): void {
    const pat = this.patBuf;
    const pc = this.pc;
    for (let i = 0; i < p.patterns.length; i++) {
      const c = p.patterns[i];
      this.coordAt(c, l0, l1, l2, oa, ob, oc, pc);
      samplePattern(c, pc[0], pc[1], pc[2], pat, i * PATTERN_STRIDE);
    }
    const out = this.procVal;
    const v = this.pxv;
    const of = p.patternOf;
    let ca = 1;
    if (p.base_color) {
      rampPattern(p.base_color, pat, of.base_color * PATTERN_STRIDE, v);
      out[o] = v[0] > 0 ? v[0] : 0;
      out[o + 1] = v[1] > 0 ? v[1] : 0;
      out[o + 2] = v[2] > 0 ? v[2] : 0;
      ca *= clamp01(v[3]);
    } else {
      out[o] = mat.r;
      out[o + 1] = mat.g;
      out[o + 2] = mat.b;
    }
    if (p.alpha) {
      rampPattern(p.alpha, pat, of.alpha * PATTERN_STRIDE, v);
      ca *= clamp01(v[0]);
    }
    out[o + 3] = ca;
    if (p.metallic) {
      rampPattern(p.metallic, pat, of.metallic * PATTERN_STRIDE, v);
      out[o + 4] = clamp01(v[0]);
    } else out[o + 4] = mat.metallic;
    if (p.roughness) {
      rampPattern(p.roughness, pat, of.roughness * PATTERN_STRIDE, v);
      out[o + 5] = clamp01(v[0]);
    } else out[o + 5] = mat.roughness;
    if (p.emission) {
      rampPattern(p.emission, pat, of.emission * PATTERN_STRIDE, v);
      const es = mat.emissionStrength ?? 0;
      out[o + 6] = (v[0] > 0 ? v[0] : 0) * es;
      out[o + 7] = (v[1] > 0 ? v[1] : 0) * es;
      out[o + 8] = (v[2] > 0 ? v[2] : 0) * es;
    } else {
      out[o + 6] = mat.er;
      out[o + 7] = mat.eg;
      out[o + 8] = mat.eb;
    }
    // bumped normal: computed by the first shaded sample; the height at this point
    out[o + 9] = NaN;
    if (p.normal) {
      rampPattern(p.normal, pat, of.normal * PATTERN_STRIDE, v);
      out[o + 12] = v[0];
    }
  }

  /**
   * World-position and texture-coordinate offsets from the current pixel (world position wx..wz,
   * coordinate `pc`) to a neighbour with screen-linear barycentrics w0..w2 (`axis` 0 → x, 1 → y).
   * False when the neighbour lies beyond the triangle plane's horizon.
   */
  private neighbour(
    c: CompiledProcedural,
    w0: number,
    w1: number,
    w2: number,
    q0: number,
    q1: number,
    q2: number,
    oa: number,
    ob: number,
    oc: number,
    wx: number,
    wy: number,
    wz: number,
    axis: number,
  ): boolean {
    let l0 = w0 * q0;
    let l1 = w1 * q1;
    let l2 = w2 * q2;
    const sum = l0 + l1 + l2;
    if (!(sum > 1e-12)) return false;
    const s = 1 / sum;
    l0 *= s;
    l1 *= s;
    l2 *= s;
    const S = this.scr;
    const dp = axis ? this.ppy : this.ppx;
    const dc = axis ? this.pcy : this.pcx;
    dp[0] = l0 * S[oa + 7] + l1 * S[ob + 7] + l2 * S[oc + 7] - wx;
    dp[1] = l0 * S[oa + 8] + l1 * S[ob + 8] + l2 * S[oc + 8] - wy;
    dp[2] = l0 * S[oa + 9] + l1 * S[ob + 9] + l2 * S[oc + 9] - wz;
    this.coordAt(c, l0, l1, l2, oa, ob, oc, dc);
    const pc = this.pc;
    dc[0] -= pc[0];
    dc[1] -= pc[1];
    dc[2] -= pc[2];
    return true;
  }

  /** Bilinear, repeat-wrapped texture lookup in linear space (editor UVs have V up). */
  private sample(t: SampledTexture, u: number, v: number): void {
    const w = t.width;
    const h = t.height;
    const fx = u * w - 0.5;
    const fy = (1 - v) * h - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    const xa = ((x0 % w) + w) % w;
    const ya = ((y0 % h) + h) % h;
    const xb = xa + 1 === w ? 0 : xa + 1;
    const yb = ya + 1 === h ? 0 : ya + 1;
    const d = t.data;
    const i00 = (ya * w + xa) * 4;
    const i10 = (ya * w + xb) * 4;
    const i01 = (yb * w + xa) * 4;
    const i11 = (yb * w + xb) * 4;
    const w00 = (1 - ax) * (1 - ay);
    const w10 = ax * (1 - ay);
    const w01 = (1 - ax) * ay;
    const w11 = ax * ay;
    const L = SRGB_TO_LINEAR;
    this.texR = L[d[i00]] * w00 + L[d[i10]] * w10 + L[d[i01]] * w01 + L[d[i11]] * w11;
    this.texG = L[d[i00 + 1]] * w00 + L[d[i10 + 1]] * w10 + L[d[i01 + 1]] * w01 + L[d[i11 + 1]] * w11;
    this.texB = L[d[i00 + 2]] * w00 + L[d[i10 + 2]] * w10 + L[d[i01 + 2]] * w01 + L[d[i11 + 2]] * w11;
    this.texA = (d[i00 + 3] * w00 + d[i10 + 3] * w10 + d[i01 + 3] * w01 + d[i11 + 3] * w11) / 255;
  }

  /** Principled-ish shading: Lambert + normalized Blinn–Phong, world ambient and emission. */
  private shadeMaterial(
    m: SurfaceMaterial,
    nx: number,
    ny: number,
    nz: number,
    px: number,
    py: number,
    pz: number,
    br: number,
    bg: number,
    bb: number,
  ): void {
    let vx: number;
    let vy: number;
    let vz: number;
    if (this.view.ortho) {
      vx = -this.view.forward[0];
      vy = -this.view.forward[1];
      vz = -this.view.forward[2];
    } else {
      vx = this.view.eye[0] - px;
      vy = this.view.eye[1] - py;
      vz = this.view.eye[2] - pz;
      const l = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1);
      vx *= l;
      vy *= l;
      vz *= l;
    }
    const met = m.metallic;
    // transmission (glass) replaces the diffuse part; the light it lets through is blended in by
    // the transparent pass
    const kd = (1 - met) * (1 - (m.transmission ?? 0));
    const dr = br * kd;
    const dg = bg * kd;
    const db = bb * kd;
    // dielectric reflectance from the IOR (0.04 at the default 1.5)
    const fi = m.ior !== undefined && m.ior > 0 ? (m.ior - 1) / (m.ior + 1) : 0.2;
    const fd = fi * fi;
    const f0r = fd * (1 - met) + br * met;
    const f0g = fd * (1 - met) + bg * met;
    const f0b = fd * (1 - met) + bb * met;
    const rough = m.roughness < 0.02 ? 0.02 : m.roughness > 1 ? 1 : m.roughness;
    const amb = this.ambient;
    let r: number;
    let g: number;
    let b: number;
    const sky = this.sky;
    const ndv = nx * vx + ny * vy + nz * vz;
    this.outNdv = ndv;
    // mirror direction
    const rx = 2 * ndv * nx - vx;
    const ry = 2 * ndv * ny - vy;
    const rz = 2 * ndv * nz - vz;
    const d = this.skyTmp;
    if (sky) {
      // diffuse: SH irradiance (the sun disc is a separate light)
      evalSkyIrradiance(sky.sh, nx, ny, nz, d);
      r = sky.scale * d[0] * dr + m.er;
      g = sky.scale * d[1] * dg + m.eg;
      b = sky.scale * d[2] * db + m.eb;
    } else if (this.env) {
      // studio / image environment: SH irradiance
      environmentIrradiance(this.env, nx, ny, nz, d);
      r = d[0] * dr + m.er;
      g = d[1] * dg + m.eg;
      b = d[2] * db + m.eb;
    } else {
      r = amb[0] * dr + m.er;
      g = amb[1] * dg + m.eg;
      b = amb[2] * db + m.eb;
    }
    const sp = this.skyTmp2;
    const probe = this.probe ?? this.env;
    if (probe) {
      // the radiance prefiltered for the roughness in the mirror direction (reflection probe: the
      // lit scene around the camera; else the studio / image) with the split-sum BRDF
      sampleEnvironmentLighting(probe, rx, ry, rz, rough, sp);
      const ab = this.brdfTmp;
      envBRDF(rough, ndv, ab);
      r += sp[0] * (f0r * ab[0] + ab[1]);
      g += sp[1] * (f0g * ab[0] + ab[1]);
      b += sp[2] * (f0b * ab[0] + ab[1]);
    } else if (sky) {
      // the sky in the mirror direction, blurred towards the irradiance with roughness
      sampleSkyModel(sky.model, rx, ry, rz, false, sp);
      const k = sky.scale;
      const t = rough;
      r += k * (sp[0] + t * (d[0] - sp[0])) * f0r;
      g += k * (sp[1] + t * (d[1] - sp[1])) * f0g;
      b += k * (sp[2] + t * (d[2] - sp[2])) * f0b;
    } else {
      r += amb[0] * f0r;
      g += amb[1] * f0g;
      b += amb[2] * f0b;
    }
    const L = this.lights;
    // GGX microfacet specular (the path tracer's principled BSDF): α = roughness², Smith
    // height-correlated visibility, Schlick Fresnel
    const alpha = rough * rough;
    const nv = ndv > 1e-4 ? ndv : 1e-4;
    for (let i = 0; i < this.lightCount; i++) {
      const o = i * LIGHT_STRIDE;
      const kind = L[o];
      let lx: number;
      let ly: number;
      let lz: number;
      let e: number;
      // lamp size: the direction of its point closest to the mirror ray (Karis 2013 "representative
      // point") and the lobe widened by its angular radius, renormalized — large lamps give large,
      // dimmer highlights in glossy surfaces and metals (as their reflections in the path tracer)
      let sx: number;
      let sy: number;
      let sz: number;
      let a2: number;
      // mirror ray outside the lamp's disc: its far GGX tail is that of a point lamp at the centre
      let outside = false;
      if (kind === LIGHT_SUN) {
        lx = -L[o + 4];
        ly = -L[o + 5];
        lz = -L[o + 6];
        e = 1;
        sx = lx;
        sy = ly;
        sz = lz;
        a2 = Math.min(1, alpha + SUN_ANGULAR_RADIUS);
      } else {
        lx = L[o + 1] - px;
        ly = L[o + 2] - py;
        lz = L[o + 3] - pz;
        const d2 = lx * lx + ly * ly + lz * lz;
        const dist = Math.sqrt(d2 || 1e-12);
        const rad = 2 * Math.sqrt(L[o + 12]);
        const t = lx * rx + ly * ry + lz * rz;
        let qx = t * rx - lx;
        let qy = t * ry - ly;
        let qz = t * rz - lz;
        const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
        outside = ql > rad && t > 0;
        const f = ql > rad ? rad / ql : 1;
        qx = lx + qx * f;
        qy = ly + qy * f;
        qz = lz + qz * f;
        const sl = 1 / (Math.sqrt(qx * qx + qy * qy + qz * qz) || 1);
        sx = qx * sl;
        sy = qy * sl;
        sz = qz * sl;
        a2 = Math.min(1, alpha + rad / (2 * dist));
        const il = 1 / dist;
        lx *= il;
        ly *= il;
        lz *= il;
        e = 1 / (d2 + L[o + 12]);
        if (kind === LIGHT_SPOT) {
          const c = -(lx * L[o + 4] + ly * L[o + 5] + lz * L[o + 6]);
          const cosHalf = L[o + 10];
          if (c <= cosHalf) continue;
          const smooth = L[o + 11];
          const t = c - cosHalf;
          if (smooth > 0 && t < smooth) {
            const u = t / smooth;
            e *= u * u * (3 - 2 * u);
          }
        } else if (kind === LIGHT_AREA) {
          const c = -(lx * L[o + 4] + ly * L[o + 5] + lz * L[o + 6]);
          if (c <= 0) continue;
          e *= c;
        }
      }
      const ndl = nx * lx + ny * ly + nz * lz;
      if (ndl <= 0) continue;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      const nds = nx * sx + ny * sy + nz * sz;
      if (nds > 0) {
        let hx = sx + vx;
        let hy = sy + vy;
        let hz = sz + vz;
        const hl = 1 / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
        hx *= hl;
        hy *= hl;
        hz *= hl;
        const ndh = nx * hx + ny * hy + nz * hz;
        if (ndh > 0) {
          const aa = alpha * alpha;
          const den = ndh * ndh * (aa - 1) + 1;
          // D at the representative point with the lamp-size normalization (α / α')²: the flat,
          // energy-conserving highlight where the mirror ray hits the lamp; away from it the lobe's
          // tail towards the lamp centre (as for a point lamp) when that is brighter
          let D = (aa / (Math.PI * den * den)) * ((alpha / a2) * (alpha / a2));
          if (outside) {
            let cx = lx + vx;
            let cy = ly + vy;
            let cz = lz + vz;
            const cl = 1 / (Math.sqrt(cx * cx + cy * cy + cz * cz) || 1);
            cx *= cl;
            cy *= cl;
            cz *= cl;
            const ndc = nx * cx + ny * cy + nz * cz;
            if (ndc > 0) {
              const dc = ndc * ndc * (aa - 1) + 1;
              const tail = aa / (Math.PI * dc * dc);
              if (tail > D) D = tail;
            }
          }
          const gv = nds * Math.sqrt(nv * nv * (1 - aa) + aa);
          const gl = nv * Math.sqrt(nds * nds * (1 - aa) + aa);
          const V = 0.5 / (gv + gl);
          const vdh = Math.max(0, vx * hx + vy * hy + vz * hz);
          const fv = 1 - vdh;
          const fv2 = fv * fv;
          const fw = fv2 * fv2 * fv;
          // per unit irradiance on the surface (× nds / ndl: the lamp's cosine is applied below)
          const k = (D * V * nds) / ndl;
          sr = (f0r + (1 - f0r) * fw) * k;
          sg = (f0g + (1 - f0g) * fw) * k;
          sb = (f0b + (1 - f0b) * fw) * k;
        }
      }
      const k = e * ndl;
      r += L[o + 7] * k * (dr * INV_PI + sr);
      g += L[o + 8] * k * (dg * INV_PI + sg);
      b += L[o + 9] * k * (db * INV_PI + sb);
    }
    this.outR = r;
    this.outG = g;
    this.outB = b;
  }

  /** Blender-like "Solid" studio shading: view-relative lights, hemisphere ambient, soft specular. */
  private shadeSolid(m: SurfaceMaterial, nx: number, ny: number, nz: number): void {
    const L = this.solidL;
    const up = this.view.up;
    const hemi = 0.2 + 0.12 * (nx * up[0] + ny * up[1] + nz * up[2]);
    let diff = hemi;
    for (let i = 0; i < 12; i += 4) {
      const d = nx * L[i] + ny * L[i + 1] + nz * L[i + 2];
      if (d > 0) diff += d * L[i + 3];
    }
    // specular highlight of the key light (view vector ≈ camera back direction)
    const f = this.view.forward;
    let hx = L[0] - f[0];
    let hy = L[1] - f[1];
    let hz = L[2] - f[2];
    const hl = 1 / (Math.hypot(hx, hy, hz) || 1);
    hx *= hl;
    hy *= hl;
    hz *= hl;
    const ndh = nx * hx + ny * hy + nz * hz;
    const spec = ndh > 0 ? 0.08 * Math.pow(ndh, 24) : 0;
    this.outR = m.r * diff + spec;
    this.outG = m.g * diff + spec;
    this.outB = m.b * diff + spec;
  }
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

function loadClip(
  A: Float64Array,
  slot: number,
  v: number,
  cl: Float64Array,
  wn: Float64Array,
  wp: Float64Array,
  colors: Float32Array | null,
  uvs: Float32Array | null,
  og: Float64Array | null,
): void {
  const o = slot * VS;
  A[o] = cl[v * 4];
  A[o + 1] = cl[v * 4 + 1];
  A[o + 2] = cl[v * 4 + 2];
  A[o + 3] = cl[v * 4 + 3];
  A[o + 4] = wn[v * 3];
  A[o + 5] = wn[v * 3 + 1];
  A[o + 6] = wn[v * 3 + 2];
  A[o + 7] = wp[v * 3];
  A[o + 8] = wp[v * 3 + 1];
  A[o + 9] = wp[v * 3 + 2];
  if (colors) {
    A[o + 10] = colors[v * 4];
    A[o + 11] = colors[v * 4 + 1];
    A[o + 12] = colors[v * 4 + 2];
    A[o + 13] = colors[v * 4 + 3];
  } else A[o + 10] = A[o + 11] = A[o + 12] = A[o + 13] = 1;
  A[o + 14] = uvs ? uvs[v * 2] : 0;
  A[o + 15] = uvs ? uvs[v * 2 + 1] : 0;
  if (og) {
    A[o + 16] = og[v * 3];
    A[o + 17] = og[v * 3 + 1];
    A[o + 18] = og[v * 3 + 2];
  }
}

/**
 * For every render triangle, bit k is set when its edge (v_k, v_k+1) is a real polygon edge (not a
 * triangulation diagonal), so the wireframe overlay shows the polygon structure.
 */
function wireEdgeFlags(mesh: MeshData, rb: RenderBuffers): Uint8Array {
  const tris = rb.indices.length / 3;
  const out = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    const face = mesh.faces[rb.triFace[t]];
    const n = face.length;
    if (n === 3) {
      out[t] = 7;
      continue;
    }
    let bits = 0;
    for (let k = 0; k < 3; k++) {
      const ia = face.indexOf(rb.vertexSource[rb.indices[t * 3 + k]]);
      const ib = face.indexOf(rb.vertexSource[rb.indices[t * 3 + ((k + 1) % 3)]]);
      if (ia >= 0 && ib >= 0 && (ib === (ia + 1) % n || ia === (ib + 1) % n)) bits |= 1 << k;
    }
    out[t] = bits;
  }
  return out;
}
