import { afterEach, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createCylinder,
  createGrid,
  estimateModifier,
  evaluateModifierStack,
  geometryMemoryCheck,
  geometryMemoryRefusals,
  getModifierDef,
  identity4,
  meshSize,
  registerBuiltinModifiers,
  setGeometryMemoryCheck,
  MODIFIER_BYTES_PER_RESULT_FACE,
  type GeometryMemoryRequest,
  type MeshData,
  type ModifierData,
} from '../src';

/*
 * Memory estimates of modifier evaluations and the check a host (the server) runs before each
 * modifier: a refused modifier is skipped with the check's message as its error wherever a stack is
 * evaluated, and such a result is not kept in the evaluator's cache.
 */

afterEach(() => {
  setGeometryMemoryCheck(null);
});

const mod = (type: string, params: Record<string, unknown> = {}, id = 'm1'): ModifierData => ({
  id,
  name: type,
  type,
  show_viewport: true,
  show_render: true,
  show_in_editmode: true,
  show_expanded: true,
  params,
});

function apply(mesh: MeshData, m: ModifierData) {
  return evaluateModifierStack(mesh, [m], {
    frame: 1,
    objectMatrix: identity4(),
    forRender: false,
    editMode: false,
    getObjectMesh: () => null,
  });
}

function gridScene(n: number, modifiers: ModifierData[]): SceneDoc {
  const doc = SceneDoc.create({ name: 'memory', empty: true });
  doc.addObject({
    type: 'MESH',
    name: 'Grid',
    data: doc.addMesh('Grid', createGrid({ x_subdivisions: n, y_subdivisions: n })),
    modifiers,
  });
  return doc;
}

describe('modifier estimates', () => {
  it('give the face count of the result of the modifiers that grow a mesh', () => {
    registerBuiltinModifiers();
    const cases: [string, Record<string, unknown>][] = [
      ['SUBSURF', { levels: 2 }],
      ['ARRAY', { count: 3 }],
      ['MIRROR', { use_axis: [true, true, false], use_mirror_merge: false }],
      ['TRIANGULATE', {}],
      ['WIREFRAME', {}],
    ];
    for (const mesh of [createCube(), createGrid({ x_subdivisions: 4, y_subdivisions: 3 }), createCylinder()])
      for (const [type, params] of cases) {
        const m = mod(type, params);
        const actual = apply(mesh, m).mesh.faces.length;
        expect([type, estimateModifier(m, meshSize(mesh), { forRender: false }).result.faces]).toEqual([
          type,
          actual,
        ]);
      }
    // closed meshes: Solidify doubles them; Bevel of every edge and corner of a cube: 26 faces
    expect(estimateModifier(mod('SOLIDIFY'), meshSize(createCube()), { forRender: false }).result.faces).toBe(
      apply(createCube(), mod('SOLIDIFY')).mesh.faces.length,
    );
    const bevel = mod('BEVEL', { limit_method: 'NONE', segments: 1 });
    expect(estimateModifier(bevel, meshSize(createCube()), { forRender: false }).result.faces).toBe(26);
    expect(apply(createCube(), bevel).mesh.faces.length).toBe(26);
  });

  it('use the render settings for renders, and the parameters the modifier runs with', () => {
    const cube = meshSize(createCube()); // 6 quads, 24 corners
    const m = mod('SUBSURF', { levels: 1, render_levels: 3 });
    expect(estimateModifier(m, cube, { forRender: false })).toEqual({
      result: { faces: 24, corners: 96, vertices: 32 },
      bytes: 24 * MODIFIER_BYTES_PER_RESULT_FACE.SUBSURF,
      lower: 'levels (render_levels for renders)',
    });
    expect(estimateModifier(m, cube, { forRender: true }).result.faces).toBe(384);
    expect(estimateModifier(m, cube, { forRender: true }).lower).toBe('render_levels');
    // schema defaults (levels 1) and an Array that fits its copies into a length
    expect(estimateModifier(mod('SUBSURF'), cube, { forRender: false }).result.faces).toBe(24);
    const fit = mod('ARRAY', { fit_type: 'FIT_LENGTH', fit_length: 9 });
    const grid = createGrid({ x_subdivisions: 2, y_subdivisions: 2, size: 2 });
    expect(estimateModifier(fit, meshSize(grid, true), { forRender: false }).result.faces).toBe(
      apply(grid, fit).mesh.faces.length,
    );
  });

  it('leave out what the modifier refuses itself, unknown types and invalid parameters', () => {
    const big = { faces: 1_000_000, corners: 4_000_000, vertices: 1_000_000 };
    // Subdivision Surface refuses results over 4,000,000 faces itself
    expect(estimateModifier(mod('SUBSURF', { levels: 2 }), big, { forRender: false }).bytes).toBe(0);
    expect(estimateModifier(mod('NOPE'), big, { forRender: false }).bytes).toBe(0);
    expect(estimateModifier(mod('SUBSURF', { levels: 'x' }), big, { forRender: false }).bytes).toBe(0);
    // a deform copies its input: estimated per face of the input
    expect(estimateModifier(mod('DISPLACE'), big, { forRender: false })).toMatchObject({
      result: big,
      bytes: 400 * 1_000_000,
    });
  });
});

describe('the memory check of a host', () => {
  it('skips a refused modifier with its message, wherever a stack is evaluated, and keeps no such result', () => {
    const asked: GeometryMemoryRequest[] = [];
    let limit = 1_000_000;
    setGeometryMemoryCheck((req) => {
      asked.push(req);
      return req.estimate.bytes > limit ? `too large: ${req.estimate.result.faces} faces` : null;
    });
    const refusals = geometryMemoryRefusals();
    // 400 quads, 1,600 corners: two levels give 6,400 faces (4,480,000 bytes)
    const doc = gridScene(20, [mod('SUBSURF', { levels: 2 })]);
    const ev = new SceneEvaluator(doc);
    const first = ev.evaluate(1).objects[0];
    expect(first.mesh!.faces.length).toBe(400);
    expect(first.modifierErrors).toEqual([{ modifierId: 'm1', message: 'too large: 6400 faces' }]);
    expect(asked.map((r) => [r.type, r.label, r.estimate.result.faces])).toEqual([
      ['SUBSURF', 'Subdivision Surface', 6400],
    ]);
    expect(geometryMemoryRefusals()).toBe(refusals + 1);
    // Apply evaluates the stack itself: refused the same way
    const applied = apply(doc.getMesh(doc.listObjects()[0].data!)!, mod('SUBSURF', { levels: 2 }));
    expect(applied.errors).toEqual([{ modifierId: 'm1', message: 'too large: 6400 faces' }]);
    // the refused result was not kept: with room for it, the same evaluator computes it
    limit = Infinity;
    expect(ev.evaluate(1).objects[0].mesh!.faces.length).toBe(6400);
    expect(asked).toHaveLength(3);
    // a result without refusals is kept as before: the check is not asked again
    expect(ev.evaluate(1).objects[0].mesh!.faces.length).toBe(6400);
    expect(asked).toHaveLength(3);
  });

  it('wraps the modifiers only while it is installed', () => {
    registerBuiltinModifiers();
    const original = getModifierDef('SUBSURF');
    const check = () => 'no';
    expect(setGeometryMemoryCheck(check)).toBeNull();
    expect(geometryMemoryCheck()).toBe(check);
    expect(getModifierDef('SUBSURF')).not.toBe(original);
    expect(getModifierDef('SUBSURF')!.label).toBe(original!.label);
    expect(setGeometryMemoryCheck(null)).toBe(check);
    expect(getModifierDef('SUBSURF')).toBe(original);
    const doc = gridScene(4, [mod('SUBSURF', { levels: 1 })]);
    expect(new SceneEvaluator(doc).evaluate(1).objects[0].mesh!.faces.length).toBe(64);
  });
});
