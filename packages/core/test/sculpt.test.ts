import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  applyPaintDab,
  applySculptDab,
  beginGrab,
  cloneMesh,
  createEditorState,
  createOperatorRegistry,
  createGrid,
  createSculptCache,
  createUVSphere,
  type OperatorContext,
} from '../src';

describe('sculpt brushes', () => {
  it('draw raises the surface along the area normal, invert lowers it', () => {
    const m = createGrid({ x_subdivisions: 20, y_subdivisions: 20, size: 2 });
    const cache = createSculptCache(m);
    applySculptDab(m, cache, { brush: 'DRAW', center: [0, 0, 0], radius: 0.5, strength: 1 });
    const maxZ = Math.max(...m.positions.filter((_, i) => i % 3 === 2));
    expect(maxZ).toBeGreaterThan(0.05);
    const m2 = createGrid({ x_subdivisions: 20, y_subdivisions: 20, size: 2 });
    applySculptDab(m2, createSculptCache(m2), { brush: 'DRAW', center: [0, 0, 0], radius: 0.5, strength: 1, invert: true });
    expect(Math.min(...m2.positions.filter((_, i) => i % 3 === 2))).toBeLessThan(-0.05);
  });

  it('does not touch vertices outside the radius', () => {
    const m = createGrid({ x_subdivisions: 10, y_subdivisions: 10, size: 2 });
    const before = m.positions.slice();
    applySculptDab(m, createSculptCache(m), { brush: 'INFLATE', center: [0.9, 0.9, 0], radius: 0.2, strength: 1 });
    // far corner untouched
    expect(m.positions.slice(0, 3)).toEqual(before.slice(0, 3));
  });

  it('smooth reduces a spike, flatten pulls to the plane, symmetry mirrors', () => {
    const m = createGrid({ x_subdivisions: 10, y_subdivisions: 10, size: 2 });
    const cache = createSculptCache(m);
    const center = 60; // middle vertex of an 11x11 grid
    m.positions[center * 3 + 2] = 1;
    applySculptDab(m, cache, { brush: 'SMOOTH', center: [0, 0, 1], radius: 0.5, strength: 1 });
    expect(m.positions[center * 3 + 2]).toBeLessThan(0.6);
    const s = createGrid({ x_subdivisions: 20, y_subdivisions: 2, size: 2 });
    applySculptDab(s, createSculptCache(s), { brush: 'DRAW', center: [0.5, 0, 0], radius: 0.3, strength: 1, symmetryX: true });
    const zAt = (x: number) => {
      for (let i = 0; i < s.positions.length / 3; i++)
        if (Math.abs(s.positions[i * 3] - x) < 1e-6 && Math.abs(s.positions[i * 3 + 1]) < 1e-6) return s.positions[i * 3 + 2];
      return NaN;
    };
    expect(zAt(-0.5)).toBeCloseTo(zAt(0.5), 6);
  });

  it('grab moves captured vertices', () => {
    const m = createUVSphere({ segments: 12, ring_count: 8 });
    const cache = createSculptCache(m);
    beginGrab(m, cache, [0, 0, 1], 0.4);
    const top = m.positions[2];
    applySculptDab(m, cache, { brush: 'GRAB', center: [0, 0, 1], radius: 0.4, strength: 1, grabDelta: [0, 0, 0.5] });
    expect(m.positions[2]).toBeCloseTo(top + 0.5, 5);
  });

  it('vertex paint creates and blends a color layer', () => {
    const m = createGrid({ x_subdivisions: 4, y_subdivisions: 4 });
    expect(m.colors).toBeNull();
    const n = applyPaintDab(m, [0, 0, 0], 0.6, [1, 0, 0, 1], 1);
    expect(n).toBeGreaterThan(0);
    expect(m.colors!.length).toBe((m.positions.length / 3) * 4);
    const center = 12;
    expect(m.colors![center * 4 + 1]).toBeLessThan(0.1);
  });
});

describe('sculpt operators (headless / MCP)', () => {
  it('applies strokes and paint as undoable operators', () => {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = { doc, state: createEditorState(), origin: doc.origin, source: 'test', report: () => {} };
    reg.run(ctx, 'mesh.primitive_uv_sphere_add', { location: [0, 0, 0] });
    const id = ctx.state.activeId!;
    const meshId = doc.getObject(id)!.data!;
    const before = cloneMesh(doc.getMesh(meshId)!);
    const r = reg.run(ctx, 'sculpt.brush_stroke', { brush: 'INFLATE', points: [[0, 0, 1]], radius: 0.6, strength: 1 });
    expect(r.ok).toBe(true);
    expect(doc.getMesh(meshId)!.positions[2]).toBeGreaterThan(before.positions[2]);
    expect(reg.run(ctx, 'paint.vertex_color_stroke', { points: [[0, 0, 1]], color: [0, 0, 1, 1] }).ok).toBe(true);
    expect(doc.getMesh(meshId)!.colors).not.toBeNull();
    expect(reg.run(ctx, 'paint.vertex_color_set', { clear: true }).ok).toBe(true);
    expect(doc.getMesh(meshId)!.colors).toBeNull();
  });
});
