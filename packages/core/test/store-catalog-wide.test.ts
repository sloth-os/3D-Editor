import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { MaterialData } from '../src/doc/types';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import type { RunResult } from '../src/operators/registry';
import { SceneEvaluator } from '../src/eval/evaluate';
import { renderItems } from '../src/eval/renderables';
import { BUILTIN_CATALOG } from '../src/store';
import { colorIgnored, hexToLinear, takesColor } from '../src/store/builtin/kit';
import type { Vec3 } from '../src/math/types';

/*
 * Every built-in model, people and animals included, through store.add for real (no stubs): it is
 * added; the size store.add reports is the size of the model as the render evaluates it (an
 * actor's parts hang from bones); materials that share a name share their definition across the
 * catalog, so a model's colours never depend on what was added before it; and the `color` option
 * either recolours a material of the model or comes back as a warning, as search results say.
 */

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push({ level, message }),
  };
  const run = (p: unknown) => reg.run(ctx, 'store.add', p) as RunResult<any> & { result: any };
  return { doc, ctx, reports, run };
}

/** Size of the meshes as the render evaluates them. */
function evaluatedSize(doc: SceneDoc): Vec3 {
  const scene = new SceneEvaluator(doc).evaluate(doc.getScene().frame_start, { forRender: true });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const it of renderItems(scene, { forRender: true })) {
    const P = it.mesh.positions;
    const m = it.worldMatrix;
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const v = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
        min[k] = Math.min(min[k], v);
        max[k] = Math.max(max[k], v);
      }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** A material's definition: every field but its id and name. */
function definition(m: MaterialData): string {
  const { id: _id, name: _name, ...rest } = m;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

describe('every built-in model', () => {
  it('is added and reports the size of the evaluated model; materials of one name share a definition', () => {
    const problems: string[] = [];
    const byName = new Map<string, Map<string, string[]>>();
    for (const e of BUILTIN_CATALOG) {
      const t = setup();
      const r = t.run({ model: e.id, location: [1, -2, 0.5], rotation_deg: 20 });
      if (!r.ok) {
        problems.push(`${e.id}: ${r.error}`);
        continue;
      }
      const size = evaluatedSize(t.doc);
      const reported = r.result.dimensions_m as Vec3;
      if (reported.some((v, k) => !(Math.abs(v - size[k]) <= 1e-5 * Math.max(1, size[k]))))
        problems.push(`${e.id}: reported ${reported}, evaluated ${size}`);
      // an actor's materials are its own (named after it); the others are the catalog's
      if (e.rig === 'actor') continue;
      for (const m of t.doc.listMaterials()) {
        if (/\.\d{3,}$/.test(m.name))
          problems.push(`${e.id}: two definitions of '${m.name.replace(/\.\d+$/, '')}'`);
        const defs = byName.get(m.name) ?? new Map<string, string[]>();
        byName.set(m.name, defs);
        const def = definition(m);
        defs.set(def, [...(defs.get(def) ?? []), e.id]);
      }
    }
    for (const [name, defs] of byName)
      if (defs.size > 1)
        problems.push(`${name}: ${[...defs.values()].map((ids) => ids.join(',')).join(' / ')}`);
    expect(problems).toEqual([]);
  });

  it('recolours a material for `color`, or warns that it cannot, as its search result says', () => {
    const want = hexToLinear('#12ab34')!;
    const problems: string[] = [];
    const ignored: string[] = [];
    for (const e of BUILTIN_CATALOG) {
      const t = setup();
      const r = t.run({ model: e.id, color: '#12ab34' });
      if (!r.ok) {
        problems.push(`${e.id}: ${r.error}`);
        continue;
      }
      const used = new Set<string>();
      for (const id of r.result.objects as string[])
        for (const slot of t.doc.getObject(id)!.material_slots) if (slot) used.add(slot);
      const recoloured = [...used].some((id) => {
        const c = t.doc.getMaterial(id)!.base_color;
        return [0, 1, 2].every((k) => Math.abs(c[k] - want[k]) < 1e-6);
      });
      const warned = (r.result.warnings as string[]).includes(colorIgnored(e.id));
      const reported = t.reports.some((w) => w.level === 'WARNING' && w.message === colorIgnored(e.id));
      if (
        recoloured === warned ||
        warned !== reported ||
        takesColor(e) !== recoloured ||
        r.result.entry.recolorable !== recoloured
      )
        problems.push(
          `${e.id}: recoloured ${recoloured}, warned ${warned}, reported ${reported}, recolorable ${r.result.entry.recolorable}`,
        );
      if (warned) ignored.push(e.id);
    }
    expect(problems).toEqual([]);
    // only models in their own natural colours ignore it
    expect(ignored.sort()).toEqual(['campfire', 'watermelon', 'watermelon_half', 'watermelon_slice']);
  });
});

describe('materials of built-in models', () => {
  /** Linear base colours of the materials a model's objects use, by material name. */
  const coloursOf = (t: ReturnType<typeof setup>, objects: string[]) => {
    const out: Record<string, number[]> = {};
    for (const id of objects)
      for (const slot of t.doc.getObject(id)!.material_slots) {
        const m = slot ? t.doc.getMaterial(slot) : null;
        if (m) out[m.name.replace(/\.\d{3,}$/, '')] = m.base_color.slice(0, 3);
      }
    return out;
  };

  it("keep each model's colours whatever was added before it", () => {
    const alone: Record<string, Record<string, number[]>> = {};
    for (const id of ['umbrella', 'closed_umbrella', 'desk', 'barn']) {
      const t = setup();
      alone[id] = coloursOf(t, t.run({ model: id }).result.objects);
    }
    for (const order of [
      ['umbrella', 'closed_umbrella'],
      ['closed_umbrella', 'umbrella'],
      ['desk', 'barn'],
      ['barn', 'desk'],
    ]) {
      const t = setup();
      for (const id of order)
        expect(coloursOf(t, t.run({ model: id }).result.objects), order.join(' then ')).toEqual(alone[id]);
    }
  });

  it("share a material between models that define it the same way, never a user's or an edited one", () => {
    const t = setup();
    // a user's own 'Oak' (red) and 'Outdoor White Paint' (black)
    const userOak = t.doc.addMaterial({ name: 'Oak', base_color: [0.8, 0, 0, 1] });
    const userPaint = t.doc.addMaterial({ name: 'Outdoor White Paint', base_color: [0, 0, 0, 1] });
    const top = (objects: string[]) => {
      const id = objects.find((o) => t.doc.getObject(o)!.custom_props.store_part === 'top')!;
      return t.doc.getObject(id)!.material_slots[0]!;
    };
    const table = t.run({ model: 'coffee_table' }).result;
    const desk = t.run({ model: 'desk' }).result;
    const oak = top(table.objects);
    expect(oak).not.toBe(userOak);
    expect(top(desk.objects)).toBe(oak);
    expect(t.doc.getMaterial(oak)!.base_color.slice(0, 3)).toEqual(hexToLinear('#a97e52'));
    const barn = t.run({ model: 'barn' }).result;
    const barnMaterials = new Set(barn.objects.flatMap((id: string) => t.doc.getObject(id)!.material_slots));
    expect(barnMaterials.has(userPaint)).toBe(false);
    expect(
      [...barnMaterials].some((id) => t.doc.getMaterial(id as string)?.name === 'Outdoor White Paint.001'),
    ).toBe(true);
    // the user's materials are untouched
    expect(t.doc.getMaterial(userOak)!.base_color).toEqual([0.8, 0, 0, 1]);
    // someone edits the store's oak: the tables already added follow, a new one keeps its own oak
    t.doc.updateMaterial(oak, { base_color: [0, 0, 0.8, 1] });
    const later = t.run({ model: 'coffee_table' }).result;
    expect(top(later.objects)).not.toBe(oak);
    expect(t.doc.getMaterial(top(later.objects))!.base_color.slice(0, 3)).toEqual(hexToLinear('#a97e52'));
    expect(top(table.objects)).toBe(oak);
  });
});
