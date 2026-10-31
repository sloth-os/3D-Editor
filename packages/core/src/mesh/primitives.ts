import type { Vec3 } from '../math/types';
import type { MeshData } from './types';
import { createMesh, edgeKey } from './types';
import { mergeByDistance } from './weld';

/*
 * Primitive generators. Parameter names follow Blender's `bpy.ops.mesh.primitive_*_add`
 * operators so that scripts and AI agents can use familiar names. Z is up.
 */

export type FillType = 'NOTHING' | 'NGON' | 'TRIFAN';

export interface CubeParams {
  size?: number;
}

export function createCube({ size = 2 }: CubeParams = {}): MeshData {
  const h = size / 2;
  const positions: number[] = [];
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) positions.push(x, y, z);
  // vertex index = xi*4 + yi*2 + zi
  const faces = [
    [0, 1, 3, 2], // -X
    [4, 6, 7, 5], // +X
    [0, 4, 5, 1], // -Y
    [2, 3, 7, 6], // +Y
    [0, 2, 6, 4], // -Z
    [1, 5, 7, 3], // +Z
  ];
  // Cross-shaped unwrap in a 4x3 grid. For each face: cell (col,row) and world axes for u/v.
  const layout: { cell: [number, number]; u: Vec3; v: Vec3 }[] = [
    { cell: [0, 1], u: [0, -1, 0], v: [0, 0, 1] },
    { cell: [2, 1], u: [0, 1, 0], v: [0, 0, 1] },
    { cell: [1, 1], u: [1, 0, 0], v: [0, 0, 1] },
    { cell: [3, 1], u: [-1, 0, 0], v: [0, 0, 1] },
    { cell: [1, 0], u: [1, 0, 0], v: [0, -1, 0] },
    { cell: [1, 2], u: [1, 0, 0], v: [0, 1, 0] },
  ];
  const uvs = faces.map((face, fi) => {
    const { cell, u, v } = layout[fi];
    const out: number[] = [];
    for (const vi of face) {
      const p: Vec3 = [positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]];
      const s = (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / (size || 1) + 0.5;
      const t = (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) / (size || 1) + 0.5;
      out.push((cell[0] + s) / 4, (cell[1] + t) / 3);
    }
    return out;
  });
  return createMesh({ positions, faces, uvs });
}

export interface PlaneParams {
  size?: number;
}

export function createPlane({ size = 2 }: PlaneParams = {}): MeshData {
  const h = size / 2;
  return createMesh({
    positions: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0],
    faces: [[0, 1, 2, 3]],
    uvs: [[0, 0, 1, 0, 1, 1, 0, 1]],
  });
}

export interface GridParams {
  x_subdivisions?: number;
  y_subdivisions?: number;
  size?: number;
}

export function createGrid({ x_subdivisions = 10, y_subdivisions = 10, size = 2 }: GridParams = {}): MeshData {
  const nx = Math.max(1, Math.floor(x_subdivisions));
  const ny = Math.max(1, Math.floor(y_subdivisions));
  const h = size / 2;
  const positions: number[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) positions.push(-h + (size * i) / nx, -h + (size * j) / ny, 0);
  const faces: number[][] = [];
  const uvs: number[][] = [];
  const idx = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
      uvs.push([i / nx, j / ny, (i + 1) / nx, j / ny, (i + 1) / nx, (j + 1) / ny, i / nx, (j + 1) / ny]);
    }
  return createMesh({ positions, faces, uvs });
}

export interface CircleParams {
  vertices?: number;
  radius?: number;
  fill_type?: FillType;
}

export function createCircle({ vertices = 32, radius = 1, fill_type = 'NOTHING' }: CircleParams = {}): MeshData {
  const n = Math.max(3, Math.floor(vertices));
  const positions: number[] = [];
  const ring: number[] = [];
  const ringUV: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + (2 * Math.PI * i) / n;
    positions.push(radius * Math.cos(a), radius * Math.sin(a), 0);
    ring.push(i);
    ringUV.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
  }
  if (fill_type === 'NGON') return createMesh({ positions, faces: [ring], uvs: [ringUV] });
  if (fill_type === 'TRIFAN') {
    const c = n;
    positions.push(0, 0, 0);
    const faces: number[][] = [];
    const uvs: number[][] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push([c, i, j]);
      uvs.push([0.5, 0.5, ringUV[i * 2], ringUV[i * 2 + 1], ringUV[j * 2], ringUV[j * 2 + 1]]);
    }
    return createMesh({ positions, faces, uvs });
  }
  const looseEdges: number[] = [];
  for (let i = 0; i < n; i++) looseEdges.push(i, (i + 1) % n);
  return createMesh({ positions, looseEdges });
}

export interface UVSphereParams {
  segments?: number;
  ring_count?: number;
  radius?: number;
}

export function createUVSphere({ segments = 32, ring_count = 16, radius = 1 }: UVSphereParams = {}): MeshData {
  const seg = Math.max(3, Math.floor(segments));
  const rings = Math.max(3, Math.floor(ring_count));
  const positions: number[] = [0, 0, radius];
  for (let k = 1; k < rings; k++) {
    const phi = (Math.PI * k) / rings;
    const z = radius * Math.cos(phi);
    const rho = radius * Math.sin(phi);
    for (let j = 0; j < seg; j++) {
      const th = (2 * Math.PI * j) / seg;
      positions.push(rho * Math.cos(th), rho * Math.sin(th), z);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, -radius);
  const ringV = (k: number, j: number) => 1 + (k - 1) * seg + (j % seg);
  const faces: number[][] = [];
  const uvs: number[][] = [];
  const vAt = (k: number) => 1 - k / rings;
  for (let j = 0; j < seg; j++) {
    faces.push([0, ringV(1, j), ringV(1, j + 1)]);
    uvs.push([(j + 0.5) / seg, 1, j / seg, vAt(1), (j + 1) / seg, vAt(1)]);
  }
  for (let k = 1; k < rings - 1; k++) {
    for (let j = 0; j < seg; j++) {
      faces.push([ringV(k, j), ringV(k + 1, j), ringV(k + 1, j + 1), ringV(k, j + 1)]);
      uvs.push([j / seg, vAt(k), j / seg, vAt(k + 1), (j + 1) / seg, vAt(k + 1), (j + 1) / seg, vAt(k)]);
    }
  }
  for (let j = 0; j < seg; j++) {
    faces.push([ringV(rings - 1, j), bottom, ringV(rings - 1, j + 1)]);
    uvs.push([j / seg, vAt(rings - 1), (j + 0.5) / seg, 0, (j + 1) / seg, vAt(rings - 1)]);
  }
  return createMesh({ positions, faces, uvs, faceSmooth: faces.map(() => false) });
}

export interface IcoSphereParams {
  subdivisions?: number;
  radius?: number;
}

export function createIcoSphere({ subdivisions = 2, radius = 1 }: IcoSphereParams = {}): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  let tris: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  verts = verts.map(norm);
  const levels = Math.max(1, Math.min(8, Math.floor(subdivisions)));
  for (let s = 1; s < levels; s++) {
    const mid = new Map<string, number>();
    const midpoint = (a: number, b: number) => {
      const k = edgeKey(a, b);
      let i = mid.get(k);
      if (i === undefined) {
        const va = verts[a];
        const vb = verts[b];
        i = verts.length;
        verts.push(norm([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]));
        mid.set(k, i);
      }
      return i;
    };
    const next: [number, number, number][] = [];
    for (const [a, b, c] of tris) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  const positions: number[] = [];
  for (const v of verts) positions.push(v[0] * radius, v[1] * radius, v[2] * radius);
  const sphUV = (v: Vec3): [number, number] => [0.5 + Math.atan2(v[1], v[0]) / (2 * Math.PI), 0.5 + Math.asin(Math.max(-1, Math.min(1, v[2]))) / Math.PI];
  const uvs = tris.map((tri) => {
    const uv = tri.map((i) => sphUV(verts[i]));
    // fix seam wrap: if a triangle spans the u=0/1 seam, shift small u values up by one
    const us = uv.map((x) => x[0]);
    if (Math.max(...us) - Math.min(...us) > 0.5) for (const x of uv) if (x[0] < 0.5) x[0] += 1;
    return uv.flat();
  });
  return createMesh({ positions, faces: tris.map((t3) => [...t3]), uvs });
}

export interface CylinderParams {
  vertices?: number;
  radius?: number;
  depth?: number;
  end_fill_type?: FillType;
}

export function createCylinder({ vertices = 32, radius = 1, depth = 2, end_fill_type = 'NGON' }: CylinderParams = {}): MeshData {
  return createCone({ vertices, radius1: radius, radius2: radius, depth, end_fill_type });
}

export interface ConeParams {
  vertices?: number;
  radius1?: number;
  radius2?: number;
  depth?: number;
  end_fill_type?: FillType;
}

export function createCone({
  vertices = 32,
  radius1 = 1,
  radius2 = 0,
  depth = 2,
  end_fill_type = 'NGON',
}: ConeParams = {}): MeshData {
  const n = Math.max(3, Math.floor(vertices));
  const h = depth / 2;
  const positions: number[] = [];
  const faces: number[][] = [];
  const uvs: number[][] = [];
  const ring = (r: number, z: number): number[] => {
    if (r <= 0) {
      positions.push(0, 0, z);
      return [positions.length / 3 - 1];
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push(positions.length / 3);
      positions.push(r * Math.cos(a), r * Math.sin(a), z);
    }
    return out;
  };
  const bottom = ring(radius1, -h);
  const top = ring(radius2, h);
  const capUV = (cx: number, i: number, flip: boolean): [number, number] => {
    const a = (2 * Math.PI * i) / n;
    return [cx + 0.24 * Math.cos(a) * (flip ? -1 : 1), 0.75 + 0.24 * Math.sin(a)];
  };
  // sides
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    const u0 = i / n;
    const u1 = j / n;
    if (bottom.length > 1 && top.length > 1) {
      faces.push([bottom[i], bottom[j % n], top[j % n], top[i]]);
      uvs.push([u0, 0, u1, 0, u1, 0.5, u0, 0.5]);
    } else if (top.length === 1 && bottom.length > 1) {
      faces.push([bottom[i], bottom[j % n], top[0]]);
      uvs.push([u0, 0, u1, 0, (u0 + u1) / 2, 0.5]);
    } else if (bottom.length === 1 && top.length > 1) {
      faces.push([bottom[0], top[j % n], top[i]]);
      uvs.push([(u0 + u1) / 2, 0, u1, 0.5, u0, 0.5]);
    }
  }
  // caps
  const cap = (verts: number[], z: number, up: boolean, cx: number) => {
    if (verts.length < 3 || end_fill_type === 'NOTHING') return;
    if (end_fill_type === 'NGON') {
      const order = up ? verts.map((_, i) => i) : verts.map((_, i) => (n - i) % n);
      faces.push(order.map((i) => verts[i]));
      uvs.push(order.flatMap((i) => capUV(cx, i, !up)));
    } else {
      const c = positions.length / 3;
      positions.push(0, 0, z);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push(up ? [c, verts[i], verts[j]] : [c, verts[j], verts[i]]);
        uvs.push(
          up ? [cx, 0.75, ...capUV(cx, i, false), ...capUV(cx, j, false)] : [cx, 0.75, ...capUV(cx, j, true), ...capUV(cx, i, true)],
        );
      }
    }
  };
  cap(top, h, true, 0.25);
  cap(bottom, -h, false, 0.75);
  return createMesh({ positions, faces, uvs });
}

export interface TorusParams {
  major_segments?: number;
  minor_segments?: number;
  major_radius?: number;
  minor_radius?: number;
}

export function createTorus({
  major_segments = 48,
  minor_segments = 12,
  major_radius = 1,
  minor_radius = 0.25,
}: TorusParams = {}): MeshData {
  const M = Math.max(3, Math.floor(major_segments));
  const N = Math.max(3, Math.floor(minor_segments));
  const positions: number[] = [];
  for (let i = 0; i < M; i++) {
    const u = (2 * Math.PI * i) / M;
    for (let j = 0; j < N; j++) {
      const v = (2 * Math.PI * j) / N;
      const r = major_radius + minor_radius * Math.cos(v);
      positions.push(r * Math.cos(u), r * Math.sin(u), minor_radius * Math.sin(v));
    }
  }
  const idx = (i: number, j: number) => (i % M) * N + (j % N);
  const faces: number[][] = [];
  const uvs: number[][] = [];
  for (let i = 0; i < M; i++)
    for (let j = 0; j < N; j++) {
      faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
      uvs.push([i / M, j / N, (i + 1) / M, j / N, (i + 1) / M, (j + 1) / N, i / M, (j + 1) / N]);
    }
  return createMesh({ positions, faces, uvs });
}

export type PrimitiveType = 'CUBE' | 'PLANE' | 'GRID' | 'CIRCLE' | 'UV_SPHERE' | 'ICO_SPHERE' | 'CYLINDER' | 'CONE' | 'TORUS';

export function createPrimitive(type: PrimitiveType, params: Record<string, unknown> = {}): MeshData {
  switch (type) {
    case 'CUBE':
      return createCube(params);
    case 'PLANE':
      return createPlane(params);
    case 'GRID':
      return createGrid(params);
    case 'CIRCLE':
      return createCircle(params);
    case 'UV_SPHERE':
      return createUVSphere(params);
    case 'ICO_SPHERE':
      return createIcoSphere(params);
    case 'CYLINDER':
      return createCylinder(params);
    case 'CONE':
      return createCone(params);
    case 'TORUS':
      return createTorus(params);
  }
}

/** Re-exported for convenience (used by importers to weld triangle soups). */
export { mergeByDistance };
