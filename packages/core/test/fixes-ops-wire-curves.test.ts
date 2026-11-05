import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  exportScene,
  renderItems,
  type OperatorContext,
} from '../src';

// Regression tests for phase-3 issue #35: modifiers on a curve without a surface (no bevel,
// extrude or fill) produced nothing. Blender converts such a curve to its wire (vertices + loose
// edges) for the modifier stack, so a SCREW modifier revolves a profile curve (the lathe workflow).

const PROFILE = [
  [0, 0, 0],
  [0.03, 0, 0],
  [0.03, 0, 0.08],
  [0.01, 0, 0.09],
  [0.01, 0, 0.1],
  [0, 0, 0.1],
];

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => {},
  };
  const ok = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result as Record<string, any>;
  };
  const evalObject = (name: string, frame = 1, forRender = false) => {
    const ev = new SceneEvaluator(doc).evaluate(frame, { forRender });
    return { ev, o: ev.byId.get(doc.findObjectByName(name)!.id)! };
  };
  return { doc, reg, ctx, ok, evalObject };
}

function bounds(positions: number[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  return { min, max };
}

describe('modifiers on wire curves', () => {
  it('SCREW revolves a profile curve into a surface (product-shot repro)', () => {
    const { ok, evalObject } = setup();
    ok('curve.add_from_points', { points: PROFILE, type: 'POLY', name: 'Profile', dimensions: '3D' });
    // without modifiers the curve stays a wire
    expect(evalObject('Profile').o.mesh).toBeUndefined();
    expect(evalObject('Profile').o.lines!.length / 6).toBe(5);
    ok('object.modifier_add', {
      object: 'Profile',
      type: 'SCREW',
      params: { steps: 8, angle: 2 * Math.PI, axis: 'Z' },
    });
    const { o, ev } = evalObject('Profile');
    expect(o.modifierErrors).toEqual([]);
    expect(o.mesh).toBeDefined();
    // 5 profile segments × 8 steps
    expect(o.mesh!.faces.length).toBe(40);
    expect(o.lines).toBeUndefined();
    const b = bounds(o.mesh!.positions);
    expect(b.min[0]).toBeCloseTo(-0.03, 6);
    expect(b.max[1]).toBeCloseTo(0.03, 6);
    expect(b.max[2]).toBeCloseTo(0.1, 6);
    // it renders and exports
    expect(renderItems(ev, { forRender: true }).map((r) => r.object.name)).toContain('Profile');
  });

  it('uses render_steps for renders and exports the revolved surface', () => {
    const { doc, ok, evalObject } = setup();
    ok('curve.add_from_points', { points: PROFILE, type: 'POLY', name: 'Profile', dimensions: '3D' });
    ok('object.modifier_add', {
      object: 'Profile',
      type: 'SCREW',
      params: { steps: 4, render_steps: 12, angle: 2 * Math.PI },
    });
    expect(evalObject('Profile', 1, true).o.mesh!.faces.length).toBe(60);
    const obj = new TextDecoder().decode(exportScene(doc, 'obj').data);
    expect(obj).toContain('o Profile');
    expect(obj.split('\n').filter((l) => l.startsWith('f ')).length).toBeGreaterThanOrEqual(20);
  });

  it('keeps edge-only results as wires (ARRAY, MIRROR) and converts them', () => {
    const { doc, ok, evalObject } = setup();
    ok('curve.add_from_points', { points: PROFILE, type: 'POLY', name: 'Profile', dimensions: '3D' });
    ok('object.modifier_add', { object: 'Profile', type: 'ARRAY', params: { count: 3 } });
    const { o } = evalObject('Profile');
    expect(o.mesh).toBeUndefined();
    expect(o.lines!.length / 6).toBe(15);
    // Convert to Mesh bakes the modified wire as loose edges
    ok('object.select', { objects: ['Profile'] });
    ok('object.convert', { target: 'MESH' });
    const converted = doc.findObjectByName('Profile')!;
    expect(converted.type).toBe('MESH');
    expect(doc.getMesh(converted.data!)!.looseEdges.length / 2).toBe(15);
  });

  it('converts a revolved profile into a mesh with faces', () => {
    const { doc, ok } = setup();
    ok('curve.add_from_points', { points: PROFILE, type: 'POLY', name: 'Profile', dimensions: '3D' });
    ok('object.modifier_add', { object: 'Profile', type: 'SCREW', params: { steps: 6 } });
    ok('object.select', { objects: ['Profile'] });
    ok('object.convert', { target: 'MESH' });
    const mesh = doc.getMesh(doc.findObjectByName('Profile')!.data!)!;
    expect(mesh.faces.length).toBe(30);
  });

  it('closes cyclic splines in the wire and leaves curves with a surface unchanged', () => {
    const { ok, evalObject } = setup();
    ok('curve.primitive_bezier_circle_add', { name: 'Ring', radius: 1, location: [3, 0, 0] });
    ok('object.modifier_add', {
      object: 'Ring',
      type: 'SCREW',
      params: { steps: 6, axis: 'Y', angle: Math.PI },
    });
    const ring = evalObject('Ring').o;
    expect(ring.mesh!.faces.length).toBeGreaterThan(0);
    // a beveled curve keeps modifying its surface
    ok('curve.add_from_points', {
      points: PROFILE,
      type: 'POLY',
      name: 'Tube',
      dimensions: '3D',
      bevel_depth: 0.005,
    });
    const before = evalObject('Tube').o.mesh!.faces.length;
    ok('object.modifier_add', { object: 'Tube', type: 'ARRAY', params: { count: 2 } });
    expect(evalObject('Tube').o.mesh!.faces.length).toBe(2 * before);
  });

  it('refuses to apply single modifiers of a curve with a pointer to object.convert', () => {
    const { reg, ctx, ok } = setup();
    ok('curve.add_from_points', { points: PROFILE, type: 'POLY', name: 'Profile', dimensions: '3D' });
    ok('object.modifier_add', { object: 'Profile', type: 'SCREW' });
    const r = reg.run(ctx, 'object.modifier_apply', { object: 'Profile', modifier: 'Screw' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('object.convert');
  });
});
