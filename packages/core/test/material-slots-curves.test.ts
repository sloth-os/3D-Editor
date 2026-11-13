import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  defaultSpline,
  defaultSplinePoint,
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
  const run = (id: string, params?: unknown) => reg.run<Record<string, any>>(ctx, id, params);
  const select = (...ids: string[]) => {
    ctx.state.selectedIds = ids;
    ctx.state.activeId = ids[0] ?? null;
  };
  return { doc, ctx, run, select };
}

/** A beveled curve with two splines using material slots 0 and 1. */
function twoSplineCurve(doc: SceneDoc): string {
  const spline = (y: number, material_index: number) => ({
    ...defaultSpline(),
    type: 'POLY' as const,
    material_index,
    points: [
      { ...defaultSplinePoint(), co: [0, y, 0] as [number, number, number] },
      { ...defaultSplinePoint(), co: [2, y, 0] as [number, number, number] },
    ],
  });
  const data = doc.addCurve({ bevel_depth: 0.1, splines: [spline(0, 0), spline(1, 1)] });
  return doc.addObject({ type: 'CURVE', name: 'Rail', data });
}

describe('material slots on curves and text', () => {
  it('material.new assigns to selected curve and text objects', () => {
    const { doc, run, select } = setup();
    const curve = twoSplineCurve(doc);
    const text = run('object.text_add', { body: 'Hi' }).result!.object as string;
    select(curve, text);
    const r = run('material.new', { name: 'Gold', assign: true });
    expect(r.ok).toBe(true);
    const mat = r.result!.material as string;
    expect(doc.getObject(curve)!.material_slots).toEqual([mat]);
    expect(doc.getObject(text)!.material_slots).toEqual([mat]);
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(text)!.materials.map((m) => m?.name)).toEqual(['Gold']);
  });

  it('adds slots to curves and remaps spline material indices when a slot is removed', () => {
    const { doc, run, select } = setup();
    const curve = twoSplineCurve(doc);
    select(curve);
    expect(run('object.material_slot_add').ok).toBe(true);
    expect(run('object.material_slot_add').ok).toBe(true);
    expect(run('object.material_slot_add').ok).toBe(true);
    expect(doc.getObject(curve)!.material_slots).toHaveLength(3);
    const data = doc.getObject(curve)!.data!;
    doc.updateCurve(data, {
      splines: doc.getCurve(data)!.splines.map((s, i) => ({ ...s, material_index: i === 0 ? 1 : 2 })),
    });
    expect(run('object.material_slot_remove', { index: 1 }).ok).toBe(true);
    // the spline on the removed slot falls back to slot 0, later ones shift down
    expect(doc.getCurve(data)!.splines.map((s) => s.material_index)).toEqual([0, 1]);
    expect(doc.getObject(curve)!.material_slots).toHaveLength(2);
  });

  it('still refuses slots on objects without geometry', () => {
    const { doc, run, select } = setup();
    const empty = doc.addObject({ type: 'EMPTY', name: 'Pivot' });
    select(empty);
    const r = run('object.material_slot_add');
    expect(r.ok).toBe(false);
    expect(doc.getObject(empty)!.material_slots).toEqual([]);
  });
});
