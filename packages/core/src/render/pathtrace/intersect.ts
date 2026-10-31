import type { BVH } from './bvh';
import type { MeshGeometry } from './geometry';

/** Instances of the scene: flat arrays indexed by instance number (see `SceneInstances`). */
export interface SceneInstances {
  count: number;
  /** Geometry index of each instance. */
  geom: Int32Array;
  /** Object → world affine transform, 12 per instance: 3×3 columns then translation. */
  xform: Float64Array;
  /** World → object affine transform, same layout. */
  inv: Float64Array;
  /** 1 when occlusion rays must ask `shadowFilter` about hits (possibly transparent materials). */
  filtered: Uint8Array;
}

/** Relative safety margin making slab tests conservative (2γ₃ for doubles). */
const BOX_EPS = 1 + 2 * ((3 * Number.EPSILON) / (1 - 3 * Number.EPSILON));
/** Smallest direction component used for slab tests (avoids 0 × ∞). */
const TINY = 1e-30;

/**
 * Two-level ray queries: a top-level BVH over instance bounds, and per mesh a triangle BVH in
 * object space (rays are transformed, not geometry, so instances share their mesh BVH).
 * Triangles use the watertight ray–triangle test of Woop, Benthin and Wald (2013): no ray passes
 * between triangles that share an edge, whatever the precision of the hit.
 *
 * Results of the last `intersect` call are in `t`, `inst`, `tri` (index in the geometry's BVH
 * order) and the barycentric weights `b1`, `b2` of the triangle's second and third corner.
 */
export class SceneIntersector {
  t = Infinity;
  inst = -1;
  tri = -1;
  b1 = 0;
  b2 = 0;
  /** Fraction of light that passed filtered (transparent) surfaces in the last `occluded` call. */
  transmittance = 1;
  /**
   * Called by `occluded` for hits on instances flagged in `instances.filtered`: returns the fraction
   * of light passing the surface at that point (0 = opaque, 1 = fully transparent).
   */
  shadowFilter: ((inst: number, tri: number, b1: number, b2: number) => number) | null = null;

  private readonly tStackN: Int32Array;
  private readonly tStackT: Float64Array;
  private readonly bStackN: Int32Array;
  private readonly bStackT: Float64Array;
  // closest-hit state while traversing one mesh
  private any = false;

  constructor(
    readonly geometries: readonly MeshGeometry[],
    readonly instances: SceneInstances,
    readonly tlas: BVH,
  ) {
    let depth = 1;
    for (const g of geometries) if (g.bvh.depth > depth) depth = g.bvh.depth;
    this.bStackN = new Int32Array(depth + 2);
    this.bStackT = new Float64Array(depth + 2);
    this.tStackN = new Int32Array(tlas.depth + 2);
    this.tStackT = new Float64Array(tlas.depth + 2);
  }

  /** Closest hit with 0 < t < tMax. Direction need not be normalized (t is in its units). */
  intersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): boolean {
    this.t = tMax;
    this.inst = -1;
    this.tri = -1;
    this.any = false;
    this.traverseTop(ox, oy, oz, dx, dy, dz);
    return this.inst >= 0;
  }

  /**
   * True when anything opaque lies on the segment 0 < t < tMax. Filtered (possibly transparent)
   * surfaces attenuate `transmittance` instead; the ray counts as occluded once it drops below 1e-4.
   */
  occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): boolean {
    this.t = tMax;
    this.inst = -1;
    this.tri = -1;
    this.any = true;
    this.transmittance = 1;
    this.traverseTop(ox, oy, oz, dx, dy, dz);
    return this.inst >= 0;
  }

  private traverseTop(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    const inst = this.instances;
    if (inst.count === 0) return;
    const B = this.tlas.bounds;
    const C = this.tlas.child;
    const K = this.tlas.count;
    const prims = this.tlas.prims;
    const ix = 1 / (Math.abs(dx) < TINY ? (dx < 0 ? -TINY : TINY) : dx);
    const iy = 1 / (Math.abs(dy) < TINY ? (dy < 0 ? -TINY : TINY) : dy);
    const iz = 1 / (Math.abs(dz) < TINY ? (dz < 0 ? -TINY : TINY) : dz);
    const sN = this.tStackN;
    const sT = this.tStackT;
    let sp = 0;
    let node = 0;
    if (slab(B, 0, ox, oy, oz, ix, iy, iz, this.t) === Infinity) return;
    const I = inst.inv;
    for (;;) {
      const cnt = K[node];
      if (cnt > 0) {
        const first = C[node];
        for (let k = first; k < first + cnt; k++) {
          const i = prims[k];
          const o = i * 12;
          const lox = I[o] * ox + I[o + 3] * oy + I[o + 6] * oz + I[o + 9];
          const loy = I[o + 1] * ox + I[o + 4] * oy + I[o + 7] * oz + I[o + 10];
          const loz = I[o + 2] * ox + I[o + 5] * oy + I[o + 8] * oz + I[o + 11];
          const ldx = I[o] * dx + I[o + 3] * dy + I[o + 6] * dz;
          const ldy = I[o + 1] * dx + I[o + 4] * dy + I[o + 7] * dz;
          const ldz = I[o + 2] * dx + I[o + 5] * dy + I[o + 8] * dz;
          if (this.traverseMesh(i, inst.geom[i], lox, loy, loz, ldx, ldy, ldz) && this.any) return;
        }
      } else {
        const l = C[node];
        const tl = slab(B, l, ox, oy, oz, ix, iy, iz, this.t);
        const tr = slab(B, l + 1, ox, oy, oz, ix, iy, iz, this.t);
        if (tl !== Infinity) {
          if (tr !== Infinity) {
            if (tl <= tr) {
              sN[sp] = l + 1;
              sT[sp++] = tr;
              node = l;
            } else {
              sN[sp] = l;
              sT[sp++] = tl;
              node = l + 1;
            }
          } else node = l;
          continue;
        }
        if (tr !== Infinity) {
          node = l + 1;
          continue;
        }
      }
      // pop the next node that can still hold a closer hit
      let found = false;
      while (sp > 0) {
        sp--;
        if (sT[sp] < this.t) {
          node = sN[sp];
          found = true;
          break;
        }
      }
      if (!found) return;
    }
  }

  /** Traverses one instance's mesh BVH; returns true if a hit was recorded. */
  private traverseMesh(
    instance: number,
    geomIndex: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
  ): boolean {
    const g = this.geometries[geomIndex];
    if (g.triCount === 0) return false;
    const B = g.bvh.bounds;
    const C = g.bvh.child;
    const K = g.bvh.count;
    const V = g.verts;
    const ix = 1 / (Math.abs(dx) < TINY ? (dx < 0 ? -TINY : TINY) : dx);
    const iy = 1 / (Math.abs(dy) < TINY ? (dy < 0 ? -TINY : TINY) : dy);
    const iz = 1 / (Math.abs(dz) < TINY ? (dz < 0 ? -TINY : TINY) : dz);
    if (slab(B, 0, ox, oy, oz, ix, iy, iz, this.t) === Infinity) return false;
    // watertight setup: kz = dominant axis, shear so the ray becomes +z
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    const kz = ax > ay ? (ax > az ? 0 : 2) : ay > az ? 1 : 2;
    let kx = kz === 2 ? 0 : kz + 1;
    let ky = kx === 2 ? 0 : kx + 1;
    const dkz = kz === 0 ? dx : kz === 1 ? dy : dz;
    if (!(dkz !== 0)) return false;
    if (dkz < 0) {
      const tmp = kx;
      kx = ky;
      ky = tmp;
    }
    const dkx = kx === 0 ? dx : kx === 1 ? dy : dz;
    const dky = ky === 0 ? dx : ky === 1 ? dy : dz;
    const Sx = dkx / dkz;
    const Sy = dky / dkz;
    const Sz = 1 / dkz;
    const okx = kx === 0 ? ox : kx === 1 ? oy : oz;
    const oky = ky === 0 ? ox : ky === 1 ? oy : oz;
    const okz = kz === 0 ? ox : kz === 1 ? oy : oz;
    const filtered = this.any && this.instances.filtered[instance] === 1;
    const sN = this.bStackN;
    const sT = this.bStackT;
    let sp = 0;
    let node = 0;
    let hit = false;
    for (;;) {
      const cnt = K[node];
      if (cnt > 0) {
        const first = C[node];
        for (let tri = first; tri < first + cnt; tri++) {
          const b = tri * 9;
          const Ax = V[b + kx] - okx;
          const Ay = V[b + ky] - oky;
          const Az = V[b + kz] - okz;
          const Bx = V[b + 3 + kx] - okx;
          const By = V[b + 3 + ky] - oky;
          const Bz = V[b + 3 + kz] - okz;
          const Cx = V[b + 6 + kx] - okx;
          const Cy = V[b + 6 + ky] - oky;
          const Cz = V[b + 6 + kz] - okz;
          const ax_ = Ax - Sx * Az;
          const ay_ = Ay - Sy * Az;
          const bx_ = Bx - Sx * Bz;
          const by_ = By - Sy * Bz;
          const cx_ = Cx - Sx * Cz;
          const cy_ = Cy - Sy * Cz;
          const U = cx_ * by_ - cy_ * bx_;
          const Vv = ax_ * cy_ - ay_ * cx_;
          const W = bx_ * ay_ - by_ * ax_;
          if ((U < 0 || Vv < 0 || W < 0) && (U > 0 || Vv > 0 || W > 0)) continue;
          const det = U + Vv + W;
          if (det === 0) continue;
          const T = (U * Az + Vv * Bz + W * Cz) * Sz;
          if (det > 0 ? T <= 0 || T >= this.t * det : T >= 0 || T <= this.t * det) continue;
          const inv = 1 / det;
          if (filtered) {
            const pass = this.shadowFilter ? this.shadowFilter(instance, tri, Vv * inv, W * inv) : 0;
            if (pass > 0) {
              this.transmittance *= pass;
              if (this.transmittance >= 1e-4) continue;
            }
          }
          this.t = T * inv;
          this.inst = instance;
          this.tri = tri;
          this.b1 = Vv * inv;
          this.b2 = W * inv;
          hit = true;
          if (this.any) return true;
        }
      } else {
        const l = C[node];
        const tl = slab(B, l, ox, oy, oz, ix, iy, iz, this.t);
        const tr = slab(B, l + 1, ox, oy, oz, ix, iy, iz, this.t);
        if (tl !== Infinity) {
          if (tr !== Infinity) {
            if (tl <= tr) {
              sN[sp] = l + 1;
              sT[sp++] = tr;
              node = l;
            } else {
              sN[sp] = l;
              sT[sp++] = tl;
              node = l + 1;
            }
          } else node = l;
          continue;
        }
        if (tr !== Infinity) {
          node = l + 1;
          continue;
        }
      }
      let found = false;
      while (sp > 0) {
        sp--;
        if (sT[sp] < this.t) {
          node = sN[sp];
          found = true;
          break;
        }
      }
      if (!found) return hit;
    }
  }
}

/** Entry distance of a ray into box `n` if it is hit before `tMax`, else Infinity. */
function slab(
  B: Float64Array,
  n: number,
  ox: number,
  oy: number,
  oz: number,
  ix: number,
  iy: number,
  iz: number,
  tMax: number,
): number {
  const o = n * 6;
  let t0 = (B[o] - ox) * ix;
  let t1 = (B[o + 3] - ox) * ix;
  let lo = t0 < t1 ? t0 : t1;
  let hi = t0 < t1 ? t1 : t0;
  t0 = (B[o + 1] - oy) * iy;
  t1 = (B[o + 4] - oy) * iy;
  if (t0 > t1) {
    const t = t0;
    t0 = t1;
    t1 = t;
  }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  t0 = (B[o + 2] - oz) * iz;
  t1 = (B[o + 5] - oz) * iz;
  if (t0 > t1) {
    const t = t0;
    t0 = t1;
    t1 = t;
  }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  hi *= BOX_EPS;
  if (lo < 0) lo = 0;
  return lo <= hi && lo < tMax ? lo : Infinity;
}
