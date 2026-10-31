import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  FrameState,
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  isAnimatable,
  keyProperty,
  propertyLength,
  type CurveData,
  type MeshData,
  type OperatorContext,
} from '../src';

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
  const ok = <T = Record<string, any>>(id: string, params?: unknown): T => {
    const r = reg.run<T>(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result as T;
  };
  return { doc, reg, ctx, ok };
}

const maxX = (m: MeshData | undefined) => {
  if (!m) return -Infinity;
  let x = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) x = Math.max(x, m.positions[i]);
  return x;
};

describe('animated curve properties', () => {
  it('lists the animatable curve fields and spline point channels', () => {
    for (const p of [
      'bevel_depth',
      'bevel_factor_start',
      'bevel_factor_end',
      'extrude',
      'offset',
      'eval_time',
      'size',
      'shear',
      'space_line',
      'offset_x',
    ])
      expect(isAnimatable('curve', p), p).toBe(true);
    expect(isAnimatable('curve', 'splines[0].points[3].co')).toBe(true);
    expect(isAnimatable('curve', 'splines[1].points[0].tilt')).toBe(true);
    expect(isAnimatable('curve', 'body')).toBe(false);
    expect(isAnimatable('curve', 'fill_mode')).toBe(false);
    const sample = { splines: [{ points: [{ co: [0, 0, 0] }] }] } as unknown as Record<string, unknown>;
    expect(propertyLength('curve', 'splines[0].points[0].co', sample)).toBe(3);
  });

  it('grows a beveled curve by keyframing bevel_factor_end through the operators', () => {
    const { doc, ctx, ok } = setup();
    const c = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      bevel_depth: 0.2,
      location: [0, 0, 0],
    });
    const k1 = ok('curve.keyframe_insert', {
      path: 'bevel_factor_end',
      frame: 1,
      value: 0,
      interpolation: 'LINEAR',
    });
    expect(k1).toEqual({ inserted: 1, curve: c.curve, fcurves: [`curve:${c.curve}:bevel_factor_end:0`] });
    ctx.state.frame = 11;
    ok('curve.keyframe_insert', { path: 'bevel_factor_end', value: 1, interpolation: 'LINEAR' });
    const ev = new SceneEvaluator(doc);
    const at = (f: number) => ev.evaluate(f).byId.get(c.object)!;
    // frame 1: nothing is built yet (no surface, no wire fallback)
    expect(at(1).mesh).toBeUndefined();
    expect(at(1).lines).toBeUndefined();
    expect(at(1).curve!.bevel_factor_end).toBe(0);
    expect(maxX(at(6).mesh)).toBeCloseTo(5);
    expect(maxX(at(8.5).mesh)).toBeCloseTo(7.5);
    expect(maxX(at(11).mesh)).toBeCloseTo(10);
    expect(maxX(at(30).mesh)).toBeCloseTo(10);
    // the stored value is untouched; geometry follows the animation
    expect(doc.getCurve(c.curve)!.bevel_factor_end).toBe(1);
    expect(at(6).meshKey).not.toBe(at(8).meshKey);
  });

  it('keys curve data with the generic anim helper, re-keys edits and removes keys', () => {
    const { doc, ctx, ok, reg } = setup();
    const c = ok('curve.primitive_bezier_circle_add', { bevel_depth: 0.1, location: [0, 0, 0] });
    expect(keyProperty(ctx, 'curve', c.curve, 'extrude', 1, { value: 0 })).toBe(1);
    expect(keyProperty(ctx, 'curve', c.curve, 'extrude', 21, { value: 1 })).toBe(1);
    const ev = new SceneEvaluator(doc);
    const height = (f: number) => {
      const m = ev.evaluate(f).byId.get(c.object)!.mesh!;
      let z = -Infinity;
      for (let i = 2; i < m.positions.length; i += 3) z = Math.max(z, m.positions[i]);
      return z;
    };
    expect(height(1)).toBeCloseTo(0.1);
    expect(height(21)).toBeCloseTo(1.1);
    expect(height(11)).toBeGreaterThan(0.2);
    // editing an animated field at the current frame updates its key (stays visible)
    ctx.state.frame = 21;
    ok('curve.properties_set', { extrude: 2 });
    expect(height(21)).toBeCloseTo(2.1);
    const key = `curve:${c.curve}:extrude:0`;
    expect(doc.getFCurve(key)!.keyframes.map((k) => k.value)).toEqual([0, 2]);
    const removed = reg.run(ctx, 'anim.keyframes_remove', { keys: [{ fcurve: key, frame: 21 }] });
    expect(removed.ok).toBe(true);
    expect(doc.getFCurve(key)!.keyframes).toHaveLength(1);
    expect(reg.run(ctx, 'curve.keyframe_insert', { path: 'fill_mode' }).error).toMatch(/not animatable/);
  });

  it('animates spline points, text size and eval_time', () => {
    const { doc, ok } = setup();
    const c = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      bevel_depth: 0.05,
      location: [0, 0, 0],
    });
    ok('curve.keyframe_insert', {
      path: 'splines[0].points[1].co',
      index: 2,
      frame: 1,
      value: 0,
      interpolation: 'LINEAR',
    });
    ok('curve.keyframe_insert', {
      path: 'splines[0].points[1].co',
      index: 2,
      frame: 11,
      value: 3,
      interpolation: 'LINEAR',
    });
    ok('curve.keyframe_insert', { path: 'eval_time', frame: 1, value: 0, interpolation: 'LINEAR' });
    ok('curve.keyframe_insert', { path: 'eval_time', frame: 101, value: 100, interpolation: 'LINEAR' });
    const ev = new SceneEvaluator(doc);
    const zMax = (f: number) => {
      const m = ev.evaluate(f).byId.get(c.object)!.mesh!;
      let z = -Infinity;
      for (let i = 2; i < m.positions.length; i += 3) z = Math.max(z, m.positions[i]);
      return z;
    };
    expect(zMax(1)).toBeCloseTo(0.05);
    // the point is at z = 1.5; the mitred corner keeps the tube 0.05 thick through the bend
    const turn = Math.PI - 2 * Math.atan2(1, 1.5);
    expect(zMax(6)).toBeCloseTo(1.5 + 0.05 / Math.cos(turn / 2), 6);
    expect(new FrameState(doc, 51).curve(c.curve)!.eval_time).toBeCloseTo(50);
    const t = ok('object.text_add', { body: 'Grow', size: 1 });
    ok('curve.keyframe_insert', {
      object: t.object,
      path: 'size',
      frame: 1,
      value: 1,
      interpolation: 'LINEAR',
    });
    ok('curve.keyframe_insert', {
      object: t.object,
      path: 'size',
      frame: 11,
      value: 3,
      interpolation: 'LINEAR',
    });
    const width = (f: number) => {
      const m = ev.evaluate(f).byId.get(t.object)!.mesh!;
      let x0 = Infinity;
      let x1 = -Infinity;
      for (let i = 0; i < m.positions.length; i += 3) {
        x0 = Math.min(x0, m.positions[i]);
        x1 = Math.max(x1, m.positions[i]);
      }
      return x1 - x0;
    };
    expect(width(11) / width(1)).toBeCloseTo(3, 5);
    expect(ev.evaluate(11).byId.get(t.object)!.curve!.size).toBeCloseTo(3);
  });

  it('undoes keyframe insertion as one step and keeps animation in snapshots', () => {
    const { doc, ok } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const c = ok('curve.primitive_bezier_curve_add', { bevel_depth: 0.1 });
    ok('curve.keyframe_insert', { path: 'bevel_factor_end', frame: 1, value: 0.25 });
    ok('curve.keyframe_insert', { path: 'bevel_factor_end', frame: 9, value: 1 });
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    const curveAt = (d: SceneDoc, f: number) => new FrameState(d, f).curve(c.curve) as CurveData;
    expect(curveAt(copy, 1).bevel_factor_end).toBeCloseTo(0.25);
    expect(curveAt(copy, 5).bevel_factor_end).toBeCloseTo(curveAt(doc, 5).bevel_factor_end);
    um.undo();
    expect(doc.getFCurve(`curve:${c.curve}:bevel_factor_end:0`)!.keyframes).toHaveLength(1);
    um.undo();
    expect(doc.listFCurves(c.curve)).toHaveLength(0);
  });
});
