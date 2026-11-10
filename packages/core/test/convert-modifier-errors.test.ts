import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { createGrid, setMeshMemoryCheck } from '../src/mesh';
import { setGeometryMemoryCheck } from '../src/eval';
import { SceneDoc } from '../src/doc/scene-doc';

/*
 * object.convert bakes the evaluated geometry and drops the modifier stack. A modifier that failed
 * (over its own limit, or skipped on the server for memory) used to be baked away silently: the
 * mesh lost the modifier and the call said ok. Like object.modifier_apply (Blender's "Modifier is
 * disabled or returned error, skipping apply"), Convert now refuses such objects and changes
 * nothing.
 */

afterEach(() => {
  setGeometryMemoryCheck(null);
  setMeshMemoryCheck(null);
});

function scene(levels: number) {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx: OperatorContext = {
    doc,
    state,
    origin: { type: 'test' },
    source: 'test',
    report: () => undefined,
  };
  const meshId = doc.addMesh('Grid', createGrid({ x_subdivisions: 50, y_subdivisions: 50 }));
  const id = doc.addObject({ type: 'MESH', name: 'Grid', data: meshId });
  state.selectedIds = [id];
  state.activeId = id;
  expect(
    reg.run(ctx, 'object.modifier_add', { type: 'SUBSURF', params: { levels, render_levels: levels } }).ok,
  ).toBe(true);
  return { doc, reg, ctx, id, meshId };
}

describe('object.convert with modifier errors', () => {
  it('refuses an object whose modifier failed, like Apply, and changes nothing', () => {
    // 2,500 quads at levels 6 would be 10,240,000 faces: Subdivision Surface refuses it
    const { doc, reg, ctx, id, meshId } = scene(6);
    const res = reg.run(ctx, 'object.convert', { target: 'MESH' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('FAILED');
    expect(res.error).toMatch(
      /^Cannot convert 'Grid': modifier 'Subdivision': Subdivision result too large \(~10240000 faces\); lower the levels\. Nothing was converted/,
    );
    expect(doc.getObject(id)!.modifiers.map((m) => m.type)).toEqual(['SUBSURF']);
    expect(doc.meshCounts(meshId)!.faces).toBe(2500);
    // Apply refuses it too
    expect(reg.run(ctx, 'object.modifier_apply', { modifier: 'Subdivision' }).ok).toBe(false);
  });

  it('refuses a modifier the host skipped for memory with code OUT_OF_MEMORY', () => {
    const { doc, reg, ctx, id } = scene(1);
    setGeometryMemoryCheck((req) => `skipped: ${req.label} too large`);
    const res = reg.run(ctx, 'object.convert', {});
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toContain("'Grid': modifier 'Subdivision': skipped: Subdivision Surface too large");
    expect(doc.getObject(id)!.modifiers).toHaveLength(1);
  });

  it('refuses an object whose stored mesh the host did not load, with code OUT_OF_MEMORY', () => {
    const { doc, id, meshId } = scene(1);
    // the project as the server opens it: nothing decoded yet
    const opened = SceneDoc.fromUpdate(Y.encodeStateAsUpdate(doc.ydoc));
    const reg = createOperatorRegistry();
    const state = createEditorState();
    state.selectedIds = [id];
    state.activeId = id;
    const ctx: OperatorContext = {
      doc: opened,
      state,
      origin: { type: 'test' },
      source: 'test',
      report: () => undefined,
    };
    setMeshMemoryCheck((req) => `not loaded: ${req.layout.faces} faces`);
    const res = reg.run(ctx, 'object.convert', {});
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toMatch(/^Cannot convert 'Grid': not loaded: 2500 faces\. Nothing was converted/);
    expect(opened.getObject(id)!.modifiers).toHaveLength(1);
    expect(opened.meshCounts(meshId)!.faces).toBe(2500);
  });

  it('still bakes objects whose modifiers evaluate', () => {
    const { doc, reg, ctx, id, meshId } = scene(1);
    const res = reg.run(ctx, 'object.convert', {});
    expect(res.ok).toBe(true);
    expect(doc.getObject(id)!.modifiers).toEqual([]);
    expect(doc.meshCounts(meshId)!.faces).toBe(10_000);
  });
});
