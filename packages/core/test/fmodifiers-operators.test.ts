import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  fcurveKey,
  insertKeyframe,
  type OperatorContext,
} from '../src';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const camData = doc.addCamera({ name: 'CamData' });
  const cam = doc.addObject({ type: 'CAMERA', name: 'Cam', data: camData, rotation_euler: [1.2, 0, 0.5] });
  ctx.state.selectedIds = [cam];
  ctx.state.activeId = cam;
  return { doc, reg, ctx, run, ok, reports, cam };
}

const rotationAt = (doc: SceneDoc, id: string, frame: number) =>
  new SceneEvaluator(doc).evaluate(frame).byId.get(id)!.data.rotation_euler;

describe('anim.fmodifier_add', () => {
  it('shakes a static camera: creates curves holding the current value plus independent noise', () => {
    const { doc, ok, cam } = setup();
    const res = ok('anim.fmodifier_add', {
      path: 'rotation_euler',
      type: 'NOISE',
      params: { strength: 0.2, scale: 6 },
    });
    expect(res.created_fcurves).toEqual([0, 1, 2].map((i) => `object:${cam}:rotation_euler:${i}`));
    expect(res.modifiers.map((m: { params: { phase: number } }) => m.params.phase)).toEqual([1, 7, 13]);
    expect(res.modifiers[0]).toMatchObject({
      path: 'rotation_euler',
      index: 0,
      modifier_index: 0,
      type: 'NOISE',
    });
    const fcs = doc.listFCurves(cam);
    expect(fcs).toHaveLength(3);
    for (const fc of fcs) expect(fc.keyframes).toHaveLength(1);
    let moved = 0;
    for (let f = 1; f <= 40; f++) {
      const r = rotationAt(doc, cam, f);
      expect(Math.abs(r[0] - 1.2)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(r[2] - 0.5)).toBeLessThanOrEqual(0.1);
      if (Math.abs(r[0] - 1.2) > 1e-3) moved++;
      expect(r[0] - 1.2).not.toBeCloseTo(r[1], 9); // channels differ
    }
    expect(moved).toBeGreaterThan(30);
  });

  it('keeps an explicit phase on every channel and stacks modifiers', () => {
    const { doc, ok, cam } = setup();
    const res = ok('anim.fmodifier_add', { path: 'location', type: 'NOISE', params: { phase: 4 } });
    expect(res.modifiers.map((m: { params: { phase: number } }) => m.params.phase)).toEqual([4, 4, 4]);
    const second = ok('anim.fmodifier_add', {
      path: 'location',
      index: 2,
      type: 'LIMITS',
      params: { use_max_y: true, max_y: 0 },
    });
    expect(second.created_fcurves).toEqual([]);
    expect(second.modifiers[0].modifier_index).toBe(1);
    expect(
      doc
        .getFCurve(fcurveKey({ target_type: 'object', target_id: cam, path: 'location', index: 2 }))!
        .modifiers!.map((m) => m.type),
    ).toEqual(['NOISE', 'LIMITS']);
    for (let f = 0; f < 30; f++)
      expect(new SceneEvaluator(doc).evaluate(f).byId.get(cam)!.data.location[2]).toBeLessThanOrEqual(0);
  });

  it('adds time modifiers to existing animation (stepped keys)', () => {
    const { doc, ok, cam } = setup();
    let fc = createFCurve({ target_type: 'object', target_id: cam, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 0, 0, 'LINEAR');
    fc = insertKeyframe(fc, 64, 64, 'LINEAR');
    doc.setFCurve(fc);
    const res = ok('anim.fmodifier_add', {
      path: 'location',
      index: 0,
      type: 'STEPPED',
      params: { frame_step: 4 },
    });
    expect(res.created_fcurves).toEqual([]);
    const at = (f: number) => new SceneEvaluator(doc).evaluate(f).byId.get(cam)!.data.location[0];
    expect(at(7)).toBe(4);
    expect(at(9)).toBe(8);
  });

  it('works on data datablocks through their objects', () => {
    const { doc, ok, cam } = setup();
    const res = ok('anim.fmodifier_add', {
      target_type: 'camera',
      target: 'Cam',
      path: 'lens',
      type: 'GENERATOR',
      params: { coefficients: [20, 1] },
    });
    expect(res.modifiers[0].fcurve).toBe(`camera:${doc.getObject(cam)!.data}:lens:0`);
    expect(new SceneEvaluator(doc).evaluate(10).byId.get(cam)!.camera!.lens).toBe(30);
  });

  it('validates types, params and channels', () => {
    const { run } = setup();
    expect(run('anim.fmodifier_add', { path: 'location', type: 'CYCLES' }).error).toMatch(
      /Invalid parameters.*type/,
    );
    expect(
      run('anim.fmodifier_add', { path: 'location', type: 'NOISE', params: { strenght: 1 } }).error,
    ).toMatch(/unknown parameter\(s\) 'strenght'.*Valid parameters: blend_type, scale, strength/);
    expect(
      run('anim.fmodifier_add', { path: 'location', type: 'NOISE', params: { scale: -2 } }).error,
    ).toMatch(/scale/);
    expect(run('anim.fmodifier_add', { path: 'location', index: 3, type: 'NOISE' }).error).toMatch(
      /Index 3 is out of range/,
    );
    expect(run('anim.fmodifier_add', { path: 'hide_select', type: 'NOISE' }).error).toMatch(/not animatable/);
    expect(run('anim.fmodifier_add', { path: 'nothing', type: 'NOISE' }).error).toMatch(/does not exist/);
    expect(run('anim.fmodifier_add', { target: 'Nope', path: 'location', type: 'NOISE' }).error).toMatch(
      /not found/,
    );
  });
});

describe('anim.fmodifier_update / fmodifier_remove / fmodifier_type_list', () => {
  it('updates parameters by type or stack position', () => {
    const { doc, ok, run, cam } = setup();
    ok('anim.fmodifier_add', { path: 'location', type: 'NOISE', params: { strength: 1 } });
    ok('anim.fmodifier_add', {
      path: 'location',
      index: 0,
      type: 'GENERATOR',
      params: { coefficients: [1, 2, 3] },
    });
    const byType = ok('anim.fmodifier_update', {
      path: 'location',
      type: 'NOISE',
      params: { strength: 0.25 },
    });
    expect(byType.modifiers).toHaveLength(3);
    expect(
      byType.modifiers.every(
        (m: { params: { strength: number; phase: number } }) => m.params.strength === 0.25,
      ),
    ).toBe(true);
    // other parameters (the varied phases) are kept
    expect(byType.modifiers.map((m: { params: { phase: number } }) => m.params.phase)).toEqual([1, 2, 3]);
    const gen = ok('anim.fmodifier_update', {
      path: 'location',
      index: 0,
      modifier_index: 1,
      params: { poly_order: 1 },
    });
    expect(gen.modifiers[0].params.coefficients).toEqual([1, 2]);
    ok('anim.fmodifier_update', { path: 'location', type: 'NOISE', mute: true });
    const key0 = fcurveKey({ target_type: 'object', target_id: cam, path: 'location', index: 0 });
    expect(doc.getFCurve(key0)!.modifiers!.map((m) => !!m.mute)).toEqual([true, false]);
    expect(run('anim.fmodifier_update', { path: 'location', params: {} }).error).toMatch(
      /modifier_index and\/or type/,
    );
    expect(run('anim.fmodifier_update', { path: 'location', type: 'ENVELOPE' }).error).toMatch(/No matching/);
    expect(run('anim.fmodifier_update', { path: 'scale', type: 'NOISE' }).error).toMatch(
      /no animation curve for 'scale'/,
    );
    expect(
      run('anim.fmodifier_update', { path: 'location', type: 'NOISE', params: { depth: -1 } }).error,
    ).toMatch(/depth/);
  });

  it('validates every curve before changing any', () => {
    const { doc, ok, run, cam } = setup();
    // stack position 0: NOISE on X and Z, STEPPED on Y
    ok('anim.fmodifier_add', { path: 'location', index: 0, type: 'NOISE' });
    ok('anim.fmodifier_add', { path: 'location', index: 1, type: 'STEPPED' });
    ok('anim.fmodifier_add', { path: 'location', index: 2, type: 'NOISE' });
    const before = JSON.stringify(doc.listFCurves(cam));
    // 'strength' is valid for NOISE (X, written first) but not for STEPPED (Y)
    const res = run('anim.fmodifier_update', {
      path: 'location',
      modifier_index: 0,
      params: { strength: 3 },
    });
    expect(res.error).toMatch(
      /location\[1\] modifier 0: Invalid STEPPED modifier parameters: unknown parameter/,
    );
    expect(JSON.stringify(doc.listFCurves(cam))).toBe(before);
    // a property that cannot be keyed fails before any curve is created
    expect(run('anim.fmodifier_add', { path: 'empty_display_size', type: 'NOISE' }).error).toMatch(
      /not animatable|does not exist/,
    );
    expect(JSON.stringify(doc.listFCurves(cam))).toBe(before);
  });

  it('removes modifiers and keeps the keyframes', () => {
    const { doc, ok, run, cam } = setup();
    ok('anim.fmodifier_add', { path: 'location', type: 'NOISE' });
    ok('anim.fmodifier_add', { path: 'location', type: 'LIMITS', params: { use_min_y: true } });
    expect(ok('anim.fmodifier_remove', { path: 'location', type: 'NOISE' })).toMatchObject({ removed: 3 });
    expect(ok('anim.fmodifier_remove', { path: 'location', index: 1, modifier_index: 0 }).removed).toBe(1);
    expect(ok('anim.fmodifier_remove', {}).removed).toBe(2);
    const fcs = doc.listFCurves(cam);
    expect(fcs).toHaveLength(3);
    expect(fcs.every((fc) => fc.modifiers === undefined && fc.keyframes.length === 1)).toBe(true);
    expect(run('anim.fmodifier_remove', {}).error).toMatch(/No matching F-curve modifier/);
    expect(run('anim.fmodifier_remove', { path: 'scale' }).error).toMatch(/no animation curve for 'scale'/);
  });

  it('describes the modifier types for agents', () => {
    const { ok, reg } = setup();
    const all = ok('anim.fmodifier_type_list');
    expect(all.types.map((t: { type: string }) => t.type)).toEqual([
      'NOISE',
      'STEPPED',
      'GENERATOR',
      'LIMITS',
      'ENVELOPE',
    ]);
    const noise = ok('anim.fmodifier_type_list', { type: 'NOISE' }).types[0];
    expect(noise.defaults).toMatchObject({ scale: 1, strength: 1, blend_type: 'REPLACE' });
    expect(noise.parameters.properties.strength.description).toMatch(/Amplitude/);
    for (const info of reg.describe().filter((i) => i.id.startsWith('anim.fmodifier'))) {
      const props = (info.parameters as { properties: Record<string, { description?: string }> }).properties;
      for (const [name, prop] of Object.entries(props))
        expect(prop.description, `${info.id}.${name}`).toBeTruthy();
    }
  });
});

describe('F-curve modifier operators: undo and snapshots', () => {
  it('makes every operator one undo step and survives snapshots', () => {
    const { doc, ok, cam } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    ok('anim.fmodifier_add', { path: 'rotation_euler', type: 'NOISE', params: { strength: 0.5 } });
    ok('anim.fmodifier_update', { path: 'rotation_euler', type: 'NOISE', params: { strength: 0.1 } });
    ok('anim.fmodifier_remove', { path: 'rotation_euler', index: 0 });
    const snapshot = JSON.parse(JSON.stringify(doc.toSnapshot()));
    const copy = SceneDoc.fromSnapshot(snapshot);
    expect(rotationAt(copy, cam, 9)).toEqual(rotationAt(doc, cam, 9));
    expect(doc.listFCurves(cam).filter((f) => f.modifiers?.length)).toHaveLength(2);
    um.undo();
    expect(doc.listFCurves(cam).filter((f) => f.modifiers?.length)).toHaveLength(3);
    um.undo();
    expect(
      doc.listFCurves(cam).every((f) => (f.modifiers![0].params as { strength: number }).strength === 0.5),
    ).toBe(true);
    um.undo();
    expect(doc.listFCurves(cam)).toHaveLength(0);
    expect(rotationAt(doc, cam, 9)).toEqual([1.2, 0, 0.5]);
  });
});
