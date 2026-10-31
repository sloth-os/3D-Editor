import type { Mat4 } from '../math/types';
import { normalMatrix4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { meshBounds } from '../mesh/types';
import { buildRenderBuffers, type RenderBuffers } from '../mesh/render-buffers';
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
  /** 0 opaque, 1 alpha clip, 2 dithered blend. */
  blend: number;
  threshold: number;
  cull: boolean;
  vertexColors: boolean;
  /** Base color texture (sRGB RGBA8, sampled bilinearly with repeat wrapping) and its UV transform. */
  tex: SampledTexture | null;
  texScale: [number, number];
  texOffset: [number, number];
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

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** Vertex record in screen space: sx, sy, depthKey, 1/w, normal xyz, world position xyz, rgba, uv. */
const VS = 16;
const GUARD = 64;
const INV_PI = 1 / Math.PI;

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

  /** Draws a mesh object. `materials` is indexed by material slot; `fallback` is used for empty slots. */
  drawMesh(mesh: MeshData, world: Mat4, materials: SurfaceMaterial[], fallback: SurfaceMaterial): void {
    if (!mesh.faces.length || this.offscreen(mesh, world)) return;
    const rb = buildRenderBuffers(mesh);
    const nv = rb.positions.length / 3;
    const tris = rb.indices.length / 3;
    if (!tris) return;
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
      if (back && mat.cull) continue;
      const wire = edges ? edges[t] : 0;
      if (!(gc[i0] | gc[i1] | gc[i2])) {
        this.loadScreen(0, i0, cl, wn, wp, colors, uvs);
        this.loadScreen(1, i1, cl, wn, wp, colors, uvs);
        this.loadScreen(2, i2, cl, wn, wp, colors, uvs);
        this.fill(0, 1, 2, mat, back, wire);
      } else {
        const A = this.clipA;
        loadClip(A, 0, i0, cl, wn, wp, colors, uvs);
        loadClip(A, 1, i1, cl, wn, wp, colors, uvs);
        loadClip(A, 2, i2, cl, wn, wp, colors, uvs);
        const n2 = this.clipPolygon(3);
        for (let j = 0; j < n2; j++) this.projectClip(j);
        for (let j = 1; j + 1 < n2; j++) this.fill(0, j, j + 1, mat, back, 0);
      }
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
    const depth = this.depth;
    const color = this.color;
    const cov = this.cov;
    const EPS = -1e-7;
    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      const cx0 = minX + 0.5;
      let w0 = ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx0 - x1)) * inv;
      let w1 = ((x0 - x2) * (cy - y2) - (y0 - y2) * (cx0 - x2)) * inv;
      let w2 = ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx0 - x0)) * inv;
      let row = py * W + minX;
      for (let px = minX; px <= maxX; px++, row++, w0 += a0, w1 += a1, w2 += a2) {
        if (w0 < EPS || w1 < EPS || w2 < EPS) continue;
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
        if (blend) {
          const alpha = mat.alpha * ca;
          if (blend === 1 ? alpha < mat.threshold : alpha <= BAYER4[((py & 3) << 2) | (px & 3)]) continue;
        }
        depth[row] = z;
        let nx = (l0 * S[oa + 4] + l1 * S[ob + 4] + l2 * S[oc + 4]) * flip;
        let ny = (l0 * S[oa + 5] + l1 * S[ob + 5] + l2 * S[oc + 5]) * flip;
        let nz = (l0 * S[oa + 6] + l1 * S[ob + 6] + l2 * S[oc + 6]) * flip;
        const nl = 1 / (Math.hypot(nx, ny, nz) || 1);
        nx *= nl;
        ny *= nl;
        nz *= nl;
        const wx = l0 * S[oa + 7] + l1 * S[ob + 7] + l2 * S[oc + 7];
        const wy = l0 * S[oa + 8] + l1 * S[ob + 8] + l2 * S[oc + 8];
        const wz = l0 * S[oa + 9] + l1 * S[ob + 9] + l2 * S[oc + 9];
        if (this.mode === SHADE_SOLID) this.shadeSolid(mat, nx, ny, nz);
        else this.shadeMaterial(mat, nx, ny, nz, wx, wy, wz, mat.r * cr, mat.g * cg, mat.b * cb);
        let r = this.outR;
        let g = this.outG;
        let b = this.outB;
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
        color[row * 3] = r;
        color[row * 3 + 1] = g;
        color[row * 3 + 2] = b;
        cov[row] = 1;
      }
    }
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
      const l = 1 / (Math.hypot(vx, vy, vz) || 1);
      vx *= l;
      vy *= l;
      vz *= l;
    }
    const met = m.metallic;
    const dr = br * (1 - met);
    const dg = bg * (1 - met);
    const db = bb * (1 - met);
    const f0r = 0.04 * (1 - met) + br * met;
    const f0g = 0.04 * (1 - met) + bg * met;
    const f0b = 0.04 * (1 - met) + bb * met;
    const rough = m.roughness < 0.02 ? 0.02 : m.roughness > 1 ? 1 : m.roughness;
    const alpha2 = rough * rough * rough * rough;
    let shin = 2 / alpha2 - 2;
    if (shin < 1) shin = 1;
    else if (shin > 4096) shin = 4096;
    const specK = ((shin + 8) / (8 * Math.PI)) * (1 - rough);
    const amb = this.ambient;
    let r = amb[0] * (dr + f0r) + m.er;
    let g = amb[1] * (dg + f0g) + m.eg;
    let b = amb[2] * (db + f0b) + m.eb;
    const L = this.lights;
    for (let i = 0; i < this.lightCount; i++) {
      const o = i * LIGHT_STRIDE;
      const kind = L[o];
      let lx: number;
      let ly: number;
      let lz: number;
      let e: number;
      if (kind === LIGHT_SUN) {
        lx = -L[o + 4];
        ly = -L[o + 5];
        lz = -L[o + 6];
        e = 1;
      } else {
        lx = L[o + 1] - px;
        ly = L[o + 2] - py;
        lz = L[o + 3] - pz;
        const d2 = lx * lx + ly * ly + lz * lz;
        const il = 1 / Math.sqrt(d2 || 1e-12);
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
      let hx = lx + vx;
      let hy = ly + vy;
      let hz = lz + vz;
      const hl = 1 / (Math.hypot(hx, hy, hz) || 1);
      hx *= hl;
      hy *= hl;
      hz *= hl;
      const ndh = nx * hx + ny * hy + nz * hz;
      const spec = ndh > 0 ? specK * Math.pow(ndh, shin) : 0;
      const k = e * ndl;
      r += L[o + 7] * k * (dr * INV_PI + f0r * spec);
      g += L[o + 8] * k * (dg * INV_PI + f0g * spec);
      b += L[o + 9] * k * (db * INV_PI + f0b * spec);
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

function loadClip(
  A: Float64Array,
  slot: number,
  v: number,
  cl: Float64Array,
  wn: Float64Array,
  wp: Float64Array,
  colors: Float32Array | null,
  uvs: Float32Array | null,
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
