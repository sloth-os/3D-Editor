import { expect } from 'vitest';
import {
  buildTopology,
  countInconsistentEdges,
  getModifierDef,
  identity4,
  isClosedManifold,
  registerBuiltinModifiers,
  vertexCount,
  type Mat4,
  type MeshData,
  type ModifierContext,
  type ModifierData,
} from '../src';

/** Signed volume enclosed by a (closed, consistently wound) mesh; positive for outward normals. */
export function signedVolume(m: MeshData): number {
  const p = m.positions;
  let v = 0;
  for (const f of m.faces) {
    for (let i = 1; i + 1 < f.length; i++) {
      const a = f[0] * 3;
      const b = f[i] * 3;
      const c = f[i + 1] * 3;
      v +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
  }
  return v / 6;
}

export function makeCtx(over: Partial<ModifierContext> = {}): ModifierContext {
  return {
    frame: 1,
    objectMatrix: identity4(),
    getObjectMesh: () => null,
    forRender: false,
    editMode: false,
    ...over,
  };
}

/** Applies one modifier type with (partial) params, validating them through the schema. */
export function applyModifier(
  type: string,
  mesh: MeshData,
  params: Record<string, unknown> = {},
  ctx: Partial<ModifierContext> = {},
): MeshData {
  registerBuiltinModifiers();
  const def = getModifierDef(type);
  if (!def) throw new Error(`modifier ${type} not registered`);
  return def.apply(mesh, def.schema.parse(params), makeCtx(ctx));
}

/** Context resolving other objects from a table of meshes + world matrices. */
export function objectsCtx(
  objects: Record<string, { mesh: MeshData; matrix: Mat4 }>,
  over: Partial<ModifierContext> = {},
) {
  return makeCtx({
    getObjectMesh: (id) => objects[id] ?? null,
    getObjectMatrix: (id) => objects[id]?.matrix ?? null,
    ...over,
  });
}

export function expectClosedConsistent(m: MeshData): void {
  expect(isClosedManifold(m)).toBe(true);
  expect(countInconsistentEdges(m)).toBe(0);
}

/** Structural validity: indices in range, per-face arrays aligned, optional layers sized correctly. */
export function expectValidMesh(m: MeshData): void {
  const n = vertexCount(m);
  expect(m.positions.length % 3).toBe(0);
  expect(m.positions.every(Number.isFinite)).toBe(true);
  expect(m.faceMaterials.length).toBe(m.faces.length);
  expect(m.faceSmooth.length).toBe(m.faces.length);
  for (const f of m.faces) {
    expect(f.length).toBeGreaterThanOrEqual(3);
    expect(new Set(f).size).toBe(f.length);
    for (const v of f) expect(v >= 0 && v < n).toBe(true);
  }
  for (const v of m.looseEdges) expect(v >= 0 && v < n).toBe(true);
  if (m.uvs) {
    expect(m.uvs.length).toBe(m.faces.length);
    m.uvs.forEach((uv, i) => {
      expect(uv.length).toBe(m.faces[i].length * 2);
      expect(uv.every(Number.isFinite)).toBe(true);
    });
  }
  if (m.colors) expect(m.colors.length).toBe(n * 4);
}

export function boundsOf(m: MeshData): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], m.positions[i + k]);
      max[k] = Math.max(max[k], m.positions[i + k]);
    }
  }
  return { min, max };
}

export function vertexAt(m: MeshData, i: number): number[] {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
}

/** Number of edges used by exactly one face. */
export function openEdgeCount(m: MeshData): number {
  const t = buildTopology(m);
  return t.edgeFaces.filter((f) => f.length === 1).length;
}

/** Translates a mesh (returns a new mesh). */
export function translated(m: MeshData, d: [number, number, number]): MeshData {
  return { ...m, positions: m.positions.map((v, i) => v + d[i % 3]) };
}

/** Builds a ModifierData record for storing on objects. */
export function modifierData(
  type: string,
  params: Record<string, unknown> = {},
  extra: Partial<ModifierData> = {},
): ModifierData {
  return {
    id: `${type.toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`,
    name: type,
    type,
    show_viewport: true,
    show_render: true,
    show_in_editmode: true,
    show_expanded: true,
    params,
    ...extra,
  };
}
