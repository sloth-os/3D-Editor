import type { Vec3 } from '../math/types';
import type { MeshData } from './types';
import { vertexCount } from './types';
import { computeVertexNormals } from './normals';

/*
 * Sculpt and vertex-paint brushes. Dabs mutate the given mesh in place for speed: callers clone
 * the mesh once per stroke and commit the result at the end (one undo step per stroke).
 * All coordinates are in the mesh's local space.
 */

export type SculptBrush = 'DRAW' | 'CLAY' | 'INFLATE' | 'SMOOTH' | 'FLATTEN' | 'PINCH' | 'GRAB';

export interface SculptDab {
  brush: SculptBrush;
  center: Vec3;
  radius: number;
  /** 0..1 */
  strength: number;
  /** Subtract instead of add (Ctrl in Blender). */
  invert?: boolean;
  /** For GRAB: displacement to apply to the grabbed vertices. */
  grabDelta?: Vec3;
  /** Mirror the dab across X = 0. */
  symmetryX?: boolean;
}

export interface SculptCache {
  adjacency: number[][];
  normals: number[];
  /** For GRAB: vertices and weights captured at stroke start. */
  grabbed?: Map<number, number>;
}

export function vertexAdjacency(m: MeshData): number[][] {
  const adj: Set<number>[] = Array.from({ length: vertexCount(m) }, () => new Set<number>());
  for (const f of m.faces)
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      adj[a].add(b);
      adj[b].add(a);
    }
  for (let i = 0; i < m.looseEdges.length; i += 2) {
    adj[m.looseEdges[i]].add(m.looseEdges[i + 1]);
    adj[m.looseEdges[i + 1]].add(m.looseEdges[i]);
  }
  return adj.map((s) => [...s]);
}

export function createSculptCache(m: MeshData): SculptCache {
  return { adjacency: vertexAdjacency(m), normals: computeVertexNormals(m) };
}

/** Smooth falloff (1 at center, 0 at radius). */
export function brushFalloff(d: number, radius: number): number {
  if (d >= radius) return 0;
  const t = 1 - d / radius;
  return t * t * (3 - 2 * t);
}

function verticesInRadius(m: MeshData, c: Vec3, r: number): { index: number; weight: number }[] {
  const out: { index: number; weight: number }[] = [];
  const P = m.positions;
  const r2 = r * r;
  for (let i = 0; i < P.length / 3; i++) {
    const dx = P[i * 3] - c[0];
    const dy = P[i * 3 + 1] - c[1];
    const dz = P[i * 3 + 2] - c[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < r2) out.push({ index: i, weight: brushFalloff(Math.sqrt(d2), r) });
  }
  return out;
}

/** Captures the vertices a GRAB stroke will move (call at stroke start). */
export function beginGrab(
  m: MeshData,
  cache: SculptCache,
  center: Vec3,
  radius: number,
  symmetryX = false,
): void {
  cache.grabbed = new Map();
  for (const { index, weight } of verticesInRadius(m, center, radius)) cache.grabbed.set(index, weight);
  if (symmetryX)
    for (const { index, weight } of verticesInRadius(m, [-center[0], center[1], center[2]], radius))
      cache.grabbed.set(-(index + 1), weight); // negative keys = mirrored side
}

function applyOne(m: MeshData, cache: SculptCache, dab: SculptDab, mirror: boolean): number {
  const P = m.positions;
  const center: Vec3 = mirror ? [-dab.center[0], dab.center[1], dab.center[2]] : dab.center;
  const sign = dab.invert ? -1 : 1;
  if (dab.brush === 'GRAB') {
    if (!cache.grabbed || !dab.grabDelta) return 0;
    const d = dab.grabDelta;
    let n = 0;
    for (const [key, w] of cache.grabbed) {
      const isMirror = key < 0;
      if (isMirror !== mirror) continue;
      const i = isMirror ? -key - 1 : key;
      P[i * 3] += (mirror ? -d[0] : d[0]) * w;
      P[i * 3 + 1] += d[1] * w;
      P[i * 3 + 2] += d[2] * w;
      n++;
    }
    return n;
  }
  const verts = verticesInRadius(m, center, dab.radius);
  if (verts.length === 0) return 0;
  const N = cache.normals;
  // area normal and center
  const an: Vec3 = [0, 0, 0];
  const ac: Vec3 = [0, 0, 0];
  let wsum = 0;
  for (const { index: i, weight: w } of verts) {
    an[0] += N[i * 3] * w;
    an[1] += N[i * 3 + 1] * w;
    an[2] += N[i * 3 + 2] * w;
    ac[0] += P[i * 3] * w;
    ac[1] += P[i * 3 + 1] * w;
    ac[2] += P[i * 3 + 2] * w;
    wsum += w;
  }
  const al = Math.hypot(an[0], an[1], an[2]) || 1;
  an[0] /= al;
  an[1] /= al;
  an[2] /= al;
  if (wsum > 0) for (let k = 0; k < 3; k++) ac[k] /= wsum;
  const amount = dab.strength * dab.radius * 0.15;
  const snapshot = dab.brush === 'SMOOTH' ? P.slice() : null;
  for (const { index: i, weight: w } of verts) {
    switch (dab.brush) {
      case 'DRAW':
      case 'CLAY': {
        let f = amount * w * sign;
        if (dab.brush === 'CLAY') {
          // clay: only raise vertices below the area plane
          const h =
            (P[i * 3] - ac[0]) * an[0] + (P[i * 3 + 1] - ac[1]) * an[1] + (P[i * 3 + 2] - ac[2]) * an[2];
          f = sign > 0 ? Math.max(0, Math.min(f, amount * w - h)) : Math.min(0, Math.max(f, -amount * w - h));
        }
        P[i * 3] += an[0] * f;
        P[i * 3 + 1] += an[1] * f;
        P[i * 3 + 2] += an[2] * f;
        break;
      }
      case 'INFLATE': {
        const f = amount * w * sign;
        P[i * 3] += N[i * 3] * f;
        P[i * 3 + 1] += N[i * 3 + 1] * f;
        P[i * 3 + 2] += N[i * 3 + 2] * f;
        break;
      }
      case 'SMOOTH': {
        const nb = cache.adjacency[i];
        if (!nb?.length || !snapshot) break;
        const avg: Vec3 = [0, 0, 0];
        for (const j of nb) {
          avg[0] += snapshot[j * 3];
          avg[1] += snapshot[j * 3 + 1];
          avg[2] += snapshot[j * 3 + 2];
        }
        const t = Math.min(1, dab.strength * w);
        for (let k = 0; k < 3; k++) P[i * 3 + k] += (avg[k] / nb.length - snapshot[i * 3 + k]) * t;
        break;
      }
      case 'FLATTEN': {
        const h =
          (P[i * 3] - ac[0]) * an[0] + (P[i * 3 + 1] - ac[1]) * an[1] + (P[i * 3 + 2] - ac[2]) * an[2];
        const t = Math.min(1, dab.strength * w) * sign;
        P[i * 3] -= an[0] * h * t;
        P[i * 3 + 1] -= an[1] * h * t;
        P[i * 3 + 2] -= an[2] * h * t;
        break;
      }
      case 'PINCH': {
        const t = Math.min(1, dab.strength * w * 0.5) * sign;
        for (let k = 0; k < 3; k++) P[i * 3 + k] += (center[k] - P[i * 3 + k]) * t;
        break;
      }
    }
  }
  return verts.length;
}

/** Applies one brush dab (and its X mirror). Returns the number of affected vertices. */
export function applySculptDab(m: MeshData, cache: SculptCache, dab: SculptDab): number {
  let n = applyOne(m, cache, dab, false);
  if (dab.symmetryX) n += applyOne(m, cache, dab, true);
  return n;
}

/** Recomputes cached vertex normals after a batch of dabs. */
export function refreshSculptNormals(m: MeshData, cache: SculptCache): void {
  cache.normals = computeVertexNormals(m);
}

/** Paints vertex colors (creates a white color layer if missing). */
export function applyPaintDab(
  m: MeshData,
  center: Vec3,
  radius: number,
  color: readonly number[],
  strength: number,
  symmetryX = false,
): number {
  const n = vertexCount(m);
  if (!m.colors || m.colors.length !== n * 4) m.colors = new Array(n * 4).fill(1);
  const C = m.colors;
  let count = 0;
  const paint = (c: Vec3) => {
    for (const { index: i, weight: w } of verticesInRadius(m, c, radius)) {
      const t = Math.min(1, strength * w);
      for (let k = 0; k < 4; k++) C[i * 4 + k] += ((color[k] ?? 1) - C[i * 4 + k]) * t;
      count++;
    }
  };
  paint(center);
  if (symmetryX) paint([-center[0], center[1], center[2]]);
  return count;
}
