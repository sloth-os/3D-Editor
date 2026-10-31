import type { Vec3 } from '../math/types';
import { Rng } from './random';
import { MeshBuilder, boxProjectUV, clampNum, placeMesh } from './builder';
import { polygonize, sampleGrid } from './isosurface';
import { MATERIALS, type GeneratorResult } from './types';

/*
 * Organic shapes from a smooth union of spheres (signed distance fields blended with a polynomial
 * smooth minimum), meshed with the marching-cubes polygonizer: free-form blobs and clouds.
 */

export interface BlobSphere {
  center: Vec3;
  radius: number;
}

/** Polynomial smooth minimum: blends a and b over a band of width k (k = 0: plain minimum). */
export function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

/** Signed distance to the smooth union of the spheres (negative inside). */
export function blobDistance(spheres: readonly BlobSphere[], k: number, x: number, y: number, z: number): number {
  let d = Infinity;
  for (const s of spheres) {
    const e = Math.hypot(x - s.center[0], y - s.center[1], z - s.center[2]) - s.radius;
    d = d === Infinity ? e : smoothMin(d, e, k);
  }
  return d;
}

/** Meshes the zero level set of `field` inside [min, max]; returns null when nothing is inside. */
function meshField(
  field: (x: number, y: number, z: number) => number,
  min: Vec3,
  max: Vec3,
  resolution: number,
): MeshBuilder | null {
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(extent > 0)) return null;
  const cell = extent / resolution;
  // one extra cell of margin keeps the boundary of the grid outside the surface
  const lo: Vec3 = [min[0] - cell, min[1] - cell, min[2] - cell];
  const hi: Vec3 = [max[0] + cell, max[1] + cell, max[2] + cell];
  const grid = sampleGrid(field, lo, hi, cell);
  const { positions, triangles } = polygonize(grid, 0);
  if (triangles.length === 0) return null;
  const b = new MeshBuilder();
  for (let i = 0; i < positions.length; i += 3) b.vert([positions[i], positions[i + 1], positions[i + 2]]);
  for (let t = 0; t < triangles.length; t += 3) b.face([triangles[t], triangles[t + 1], triangles[t + 2]], 0, true);
  return b;
}

function sphereBounds(spheres: readonly BlobSphere[], pad: number): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of spheres)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], s.center[k] - s.radius - pad);
      max[k] = Math.max(max[k], s.center[k] + s.radius + pad);
    }
  return { min, max };
}

// ------------------------------------------------------------------ blob

export interface BlobParams {
  /** Explicit spheres (object space). When empty/null, `count` random spheres are used. */
  spheres: BlobSphere[] | null;
  /** Number of random spheres (when `spheres` is not given). */
  count: number;
  /** Size of the cube the random spheres are placed in, in metres. */
  size: number;
  /** Blend distance in metres: how softly the spheres merge (0 = hard union). */
  smoothness: number;
  /** Grid cells along the longest side (mesh resolution, 8..160). */
  resolution: number;
  seed: number;
}

export const BLOB_DEFAULTS: BlobParams = { spheres: null, count: 6, size: 2, smoothness: 0.35, resolution: 48, seed: 0 };

/**
 * Smooth union of spheres. Explicit spheres keep their coordinates; random blobs are centred on
 * the origin. Slot 0: Blob.
 */
export function generateBlob(params: Partial<BlobParams> = {}): GeneratorResult {
  const p = { ...BLOB_DEFAULTS, ...params };
  const k = clampNum(p.smoothness, 0, 100, BLOB_DEFAULTS.smoothness);
  const res = Math.round(clampNum(p.resolution, 8, 160, BLOB_DEFAULTS.resolution));
  let spheres = (p.spheres ?? []).filter(
    (s) => s && Array.isArray(s.center) && s.center.every(Number.isFinite) && Number.isFinite(s.radius) && s.radius > 0,
  );
  const explicit = spheres.length > 0;
  if (!explicit) {
    const size = clampNum(p.size, 0.01, 1000, BLOB_DEFAULTS.size);
    const count = Math.round(clampNum(p.count, 1, 64, BLOB_DEFAULTS.count));
    const rng = new Rng(p.seed, 0xb10b);
    spheres = Array.from({ length: count }, () => ({
      center: [rng.spread(size * 0.3), rng.spread(size * 0.3), rng.spread(size * 0.3)] as Vec3,
      radius: size * rng.range(0.15, 0.3),
    }));
  }
  const { min, max } = sphereBounds(spheres, k * 0.5);
  const b = meshField((x, y, z) => blobDistance(spheres, k, x, y, z), min, max, res);
  if (!b) return { mesh: new MeshBuilder().build(), materials: [MATERIALS.blob] };
  const mesh = b.build();
  if (!explicit) placeMesh(mesh, { centerXY: true, centerZ: true });
  return { mesh, materials: [MATERIALS.blob] };
}

// ------------------------------------------------------------------ cloud

export interface CloudParams {
  /** Dimensions [x, y, z] of the cloud in metres (exact). */
  size: Vec3;
  /** Number of puffs (spheres) the cloud is made of. */
  puffs: number;
  /** Blend distance as a fraction of the cloud height (how soft the puffs merge). */
  smoothness: number;
  /** Cut the underside flat (cumulus look). */
  flat_bottom: boolean;
  /** Grid cells along the longest side (mesh resolution, 8..160). */
  resolution: number;
  seed: number;
}

export const CLOUD_DEFAULTS: CloudParams = {
  size: [4, 2.5, 1.5],
  puffs: 14,
  smoothness: 0.12,
  flat_bottom: true,
  resolution: 56,
  seed: 0,
};

/** Puffy cloud centred on the Z axis with its base at z = 0. Slot 0: Cloud. */
export function generateCloud(params: Partial<CloudParams> = {}): GeneratorResult {
  const p = { ...CLOUD_DEFAULTS, ...params };
  const size = (p.size ?? CLOUD_DEFAULTS.size).map((v, i) => clampNum(v, 0.01, 1e4, CLOUD_DEFAULTS.size[i])) as Vec3;
  const puffs = Math.round(clampNum(p.puffs, 1, 64, CLOUD_DEFAULTS.puffs));
  const res = Math.round(clampNum(p.resolution, 8, 160, CLOUD_DEFAULTS.resolution));
  const rng = new Rng(p.seed, 0xc10d);
  // build in a normalized space (height 1) and stretch to the exact size at the end:
  // a base layer of large puffs spread over the footprint, smaller puffs heaped on top of them
  const ax = size[0] / size[2];
  const ay = size[1] / size[2];
  const rBase = Math.max(0.2, Math.min(0.55, ax / 4, ay / 4));
  const baseCount = Math.max(1, Math.round(puffs * 0.55));
  const spheres: BlobSphere[] = [];
  for (let i = 0; i < baseCount; i++) {
    const r = rBase * rng.range(0.7, 1);
    const a = (2 * Math.PI * i) / baseCount + rng.spread(0.5);
    const u = baseCount === 1 ? 0 : rng.range(0.35, 1);
    const cx = Math.cos(a) * u * Math.max(0, ax / 2 - r);
    const cy = Math.sin(a) * u * Math.max(0, ay / 2 - r);
    spheres.push({ center: [cx, cy, r * 0.35], radius: r });
  }
  for (let i = baseCount; i < puffs; i++) {
    // heap on a base puff, preferring the ones near the centre
    const j = Math.min(baseCount - 1, Math.floor(rng.next() * rng.next() * baseCount));
    const base = spheres[j];
    const r = base.radius * rng.range(0.55, 0.85);
    spheres.push({
      center: [
        base.center[0] * 0.7 + rng.spread(base.radius * 0.4),
        base.center[1] * 0.7 + rng.spread(base.radius * 0.4),
        base.center[2] + base.radius * rng.range(0.45, 0.85),
      ],
      radius: r,
    });
  }
  const k = clampNum(p.smoothness, 0, 2, CLOUD_DEFAULTS.smoothness);
  const flat = p.flat_bottom !== false;
  const field = (x: number, y: number, z: number) => {
    const d = blobDistance(spheres, k, x, y, z);
    return flat ? -smoothMin(-d, z, 0.05) : d;
  };
  const { min, max } = sphereBounds(spheres, k * 0.5);
  if (flat) min[2] = Math.max(min[2], -0.05);
  const b = meshField(field, min, max, res);
  if (!b) return { mesh: new MeshBuilder().build(), materials: [MATERIALS.cloud] };
  const mesh = b.build();
  placeMesh(mesh, { ground: true, centerXY: true });
  // stretch to the exact requested dimensions
  const P = mesh.positions;
  const ext: Vec3 = [0, 0, 0];
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], P[i + c]);
      hi[c] = Math.max(hi[c], P[i + c]);
    }
  for (let c = 0; c < 3; c++) ext[c] = hi[c] - lo[c];
  for (let i = 0; i < P.length; i += 3)
    for (let c = 0; c < 3; c++) if (ext[c] > 1e-9) P[i + c] *= size[c] / ext[c];
  mesh.uvs = mesh.faces.map((f) => boxProjectUV(P, f));
  return { mesh, materials: [MATERIALS.cloud] };
}
