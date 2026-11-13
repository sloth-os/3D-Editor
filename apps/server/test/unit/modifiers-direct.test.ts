import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  defaultSpline,
  defaultSplinePoint,
  type OperatorContext,
  type OperatorRegistry,
} from '@3d-editor/core';
import { ToolError, type AgentProject } from '../../src/mcp/agent';
import { addModifier, applyModifier, updateModifier } from '../../src/mcp/modifiers';
import { summarizeScene } from '../../src/mcp/scene-summary';

/*
 * MCP add_modifier and update_modifier run object.modifier_add / object.modifier_set on mesh
 * objects; the stacks of curve and text objects are edited directly (modifiers.ts). Both refuse an
 * object of a type the parameter does not take, as Blender's setter stores none. apply_modifier's
 * direct path (without the operator) evaluates the modifier as the scene does: with the curve
 * paths and the types of the objects it names. get_scene lists the modifiers Blender's is_disabled
 * leaves out among its problems.
 */

const registry = createOperatorRegistry();

/** A project as the MCP tools use it, with the agent's operator context. */
function project() {
  const doc = SceneDoc.create({ empty: true });
  const state = createEditorState();
  const ctx = (): OperatorContext => ({
    doc,
    state,
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  });
  const run = (id: string, params?: unknown) => registry.run(ctx(), id, params);
  const p = {
    scene: doc,
    state,
    step: <T>(fn: () => T) => fn(),
    transact: <T>(fn: () => T) => doc.transact(fn),
    run,
  } as unknown as AgentProject;
  const add = (id: string, params: Record<string, unknown> = {}) => {
    expect(run(id, params).ok).toBe(true);
    return doc.getObject(state.activeId!)!;
  };
  return { doc, p, add };
}

/** The error `fn` throws. */
function thrown(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('nothing thrown');
}

describe('add_modifier and update_modifier on curve and text objects', () => {
  it('refuse an object of a type the parameter does not take, as on a mesh', () => {
    const { doc, p, add } = project();
    const box = add('mesh.primitive_cube_add', { name: 'Box' });
    const path = add('curve.primitive_bezier_curve_add');
    const label = add('object.text_add', { body: 'Hi' });
    const refused = thrown(() =>
      addModifier(p, registry, label, 'BOOLEAN', { params: { object: path.name } }),
    );
    expect(refused.message).toBe(
      "Parameter 'object' of the Boolean modifier takes a mesh object; 'BezierCurve' is a curve object " +
        '(object.convert with target MESH makes it one)',
    );
    expect(refused.code).toBe('INVALID_PARAMS');
    expect(
      thrown(() => addModifier(p, registry, path, 'ARMATURE', { params: { object: 'Box' } })).message,
    ).toBe("Parameter 'object' of the Armature modifier takes an armature object; 'Box' is a mesh object");
    expect(doc.getObject(label.id)!.modifiers).toEqual([]);
    expect(doc.getObject(path.id)!.modifiers).toEqual([]);
    // a mesh is taken, through the document as before
    const added = addModifier(p, registry, label, 'BOOLEAN', { params: { object: 'Box' } });
    expect(added.via).toBe('document');
    expect(added.modifier!.params.object).toBe(box.id);
    const update = thrown(() =>
      updateModifier(p, registry, doc.getObject(label.id)!, added.modifier!, { params: { object: path.id } }),
    );
    expect(update.message).toMatch(/^Parameter 'object' of the Boolean modifier takes a mesh object; /);
    expect(update.code).toBe('INVALID_PARAMS');
    expect(doc.getObject(label.id)!.modifiers[0].params.object).toBe(box.id);
    // on a mesh the operator refuses it, as before
    expect(
      thrown(() => addModifier(p, registry, box, 'BOOLEAN', { params: { object: label.id } })).message,
    ).toBe(
      "object.modifier_add failed: Parameter 'object' of the Boolean modifier takes a mesh object; 'Text' is " +
        'a text object (object.convert with target MESH makes it one)',
    );
  });
});

describe('apply_modifier without the operator', () => {
  // a registry without object.modifier_apply: applyModifier bakes the modifier itself
  const withoutApply = { get: () => undefined } as unknown as OperatorRegistry;

  it('bends a mesh along the path of its Curve modifier, as the scene shows it', () => {
    const { doc, p, add } = project();
    add('curve.primitive_nurbs_path_add', { location: [0, 1, 0], rotation: [0, 0, 0.4] });
    const rod = add('mesh.primitive_cylinder_add', { radius: 0.1, depth: 4, rotation: [0, Math.PI / 2, 0] });
    const before = Array.from(doc.getMesh(rod.data!)!.positions);
    const mod = addModifier(p, registry, rod, 'CURVE', { params: { object: 'NurbsPath' } }).modifier!;
    const shown = new SceneEvaluator(doc).evaluate(1).byId.get(rod.id)!;
    expect(shown.modifierErrors).toEqual([]);
    expect(applyModifier(p, withoutApply, doc.getObject(rod.id)!, mod).via).toBe('document');
    expect(doc.getObject(rod.id)!.modifiers).toEqual([]);
    // the stored mesh keeps 32-bit floats
    const applied = Array.from(doc.getMesh(doc.getObject(rod.id)!.data!)!.positions);
    const want = Array.from(shown.mesh!.positions);
    expect(applied.length).toBe(want.length);
    expect(Math.max(...applied.map((v, i) => Math.abs(v - want[i])))).toBeLessThan(1e-6);
    expect(Math.max(...want.map((v, i) => Math.abs(v - before[i])))).toBeGreaterThan(0.5);
  });

  it('leaves out a Curve modifier whose object is not a curve, as the scene does', () => {
    const { doc, p, add } = project();
    const rail = add('mesh.primitive_cube_add', { name: 'Rail', location: [0, 3, 0] });
    const rod = add('mesh.primitive_cylinder_add', { radius: 0.1, depth: 4 });
    const before = Array.from(doc.getMesh(rod.data!)!.positions);
    const mod = addModifier(p, registry, rod, 'CURVE').modifier!;
    // as an older document has it: the operators refuse a mesh there
    doc.updateObject(rod.id, { modifiers: [{ ...mod, params: { ...mod.params, object: rail.id } }] });
    applyModifier(p, withoutApply, doc.getObject(rod.id)!, doc.getObject(rod.id)!.modifiers[0]);
    expect(Array.from(doc.getMesh(doc.getObject(rod.id)!.data!)!.positions)).toEqual(before);
  });
});

describe('get_scene problems', () => {
  it('list the modifiers that are disabled, and in which evaluation', () => {
    const { p, add } = project();
    const box = add('mesh.primitive_cube_add', { name: 'Box' });
    addModifier(p, registry, box, 'BOOLEAN');
    addModifier(p, registry, box, 'SUBSURF', { params: { levels: 0, render_levels: 2 } });
    addModifier(p, registry, box, 'BEVEL', { params: { width: 0 } });
    // disabled too, but hidden in renders: listed for the viewport only
    const smooth = addModifier(p, registry, box, 'SMOOTH', { params: { factor: 0 } }).modifier!;
    updateModifier(p, registry, p.scene.getObject(box.id)!, smooth, { show_render: false });
    // hidden in both: listed nowhere
    const cast = addModifier(p, registry, box, 'CAST', { params: { factor: 0 } }).modifier!;
    updateModifier(p, registry, p.scene.getObject(box.id)!, cast, {
      show_render: false,
      show_viewport: false,
    });
    const { problems } = summarizeScene(p.scene) as unknown as { problems: Record<string, unknown>[] };
    expect(problems).toEqual([
      {
        source: 'modifier',
        object: 'Box',
        modifier: 'Boolean',
        disabled: true,
        message:
          "Modifier is disabled: the Boolean modifier 'Boolean' has no object, so it changes nothing; change " +
          'it with update_modifier or remove it with remove_modifier',
      },
      {
        source: 'modifier',
        object: 'Box',
        modifier: 'Bevel',
        disabled: true,
        message:
          "Modifier is disabled: the Bevel modifier 'Bevel' has a width of 0, so it changes nothing; change " +
          'it with update_modifier or remove it with remove_modifier',
      },
      {
        // renders use it (render_levels 2): no advice to remove it
        source: 'modifier',
        object: 'Box',
        modifier: 'Subdivision',
        disabled: true,
        message:
          "Modifier is disabled: the Subdivision Surface modifier 'Subdivision' has 0 viewport levels " +
          '(levels), so it changes nothing in the viewport; renders use it',
        viewport: true,
      },
      {
        source: 'modifier',
        object: 'Box',
        modifier: 'Smooth',
        disabled: true,
        message:
          "Modifier is disabled: the Smooth modifier 'Smooth' has a factor of 0, so it changes nothing; change " +
          'it with update_modifier or remove it with remove_modifier',
        viewport: true,
      },
    ]);
  });

  it('say which evaluation uses a modifier that the settings of the other disable', () => {
    const { p, add } = project();
    // the viewport subdivides it (levels 2); renders do not (render_levels 0)
    const r = add('mesh.primitive_cube_add', { name: 'R' });
    addModifier(p, registry, r, 'SUBSURF', { params: { levels: 2, render_levels: 0 } });
    // the same, hidden in the viewport: it changes nothing anywhere
    const hv = add('mesh.primitive_cube_add', { name: 'HV' });
    const hidden = addModifier(p, registry, hv, 'SUBSURF', {
      params: { levels: 2, render_levels: 0 },
    }).modifier!;
    updateModifier(p, registry, p.scene.getObject(hv.id)!, hidden, { show_viewport: false });
    // 0 viewport levels and render_levels 2, hidden in renders: it changes nothing anywhere either
    const hr = add('mesh.primitive_cube_add', { name: 'HR' });
    const off = addModifier(p, registry, hr, 'SUBSURF', {
      params: { levels: 0, render_levels: 2 },
    }).modifier!;
    updateModifier(p, registry, p.scene.getObject(hr.id)!, off, { show_render: false });
    const { problems } = summarizeScene(p.scene) as unknown as { problems: Record<string, unknown>[] };
    const disabled = (levels: string, where = '') =>
      `Modifier is disabled: the Subdivision Surface modifier 'Subdivision' has 0 ${levels}, so it changes nothing${where}`;
    const remove = '; change it with update_modifier or remove it with remove_modifier';
    const byObject = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a.object).localeCompare(String(b.object));
    expect([...problems].sort(byObject)).toEqual([
      {
        source: 'modifier',
        object: 'HR',
        modifier: 'Subdivision',
        disabled: true,
        message: disabled('viewport levels (levels)') + remove,
        viewport: true,
      },
      {
        source: 'modifier',
        object: 'HV',
        modifier: 'Subdivision',
        disabled: true,
        message: disabled('render levels (render_levels)') + remove,
      },
      {
        source: 'modifier',
        object: 'R',
        modifier: 'Subdivision',
        disabled: true,
        message: disabled('render levels (render_levels)', ' in renders; the viewport uses it'),
      },
    ]);
  });

  it('list the disabled modifiers after the errors, which the cap of the list keeps', () => {
    const { doc, p, add } = project();
    // 41 Booleans without an object (more than the 40 entries listed), then an error on an object
    // evaluated after them: a Curve modifier along a curve whose two points are one
    const box = add('mesh.primitive_cube_add', { name: 'Box' });
    for (let i = 0; i < 41; i++) addModifier(p, registry, p.scene.getObject(box.id)!, 'BOOLEAN');
    const rail = doc.addObject({
      type: 'CURVE',
      name: 'Rail',
      data: doc.addCurve({
        splines: [defaultSpline('POLY', [defaultSplinePoint([1, 1, 1]), defaultSplinePoint([1, 1, 1])])],
      }),
    });
    const grid = add('mesh.primitive_grid_add', { name: 'Grid' });
    addModifier(p, registry, grid, 'CURVE', { params: { object: rail } });
    const summary = summarizeScene(p.scene) as unknown as {
      problems: Record<string, unknown>[];
      problems_total?: number;
    };
    expect(summary.problems).toHaveLength(40);
    expect(summary.problems_total).toBe(42);
    expect(summary.problems[0]).toEqual({
      source: 'modifier',
      object: 'Grid',
      modifier: 'Curve',
      message: "Object 'Rail' is not a curve with at least two distinct points",
    });
    expect(summary.problems.slice(1).every((x) => x.disabled === true && x.object === 'Box')).toBe(true);
  });
});
