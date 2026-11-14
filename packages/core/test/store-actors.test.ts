import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import type { RunResult } from '../src/operators/registry';
import { SceneEvaluator } from '../src/eval/evaluate';
import { renderItems } from '../src/eval/renderables';
import {
  ACTOR_KINDS,
  ANIMAL_POSES,
  BUILT_KINDS,
  HUMAN_POSES,
  HUMANOID_KINDS,
  MAX_ACTOR_HEIGHT,
  MIN_ACTOR_HEIGHT,
  defaultActorHeight,
} from '../src/desk/characters';
import { DESK_PROPS } from '../src/desk/props';
import { ACTOR_DEFS, ACTOR_MODELS, actorBuildHeight, measureActorKind } from '../src/store/builtin/actors';
import { BUILTIN_CATALOG, getCatalogEntry, rankCatalog, searchCatalog } from '../src/store';
import type { Vec3 } from '../src/math/types';

/*
 * The people and animals of the catalog, built for real by createActor (desk/characters): only the
 * kinds CHARACTERS builds are listed, their catalog sizes and triangles are those of a real build,
 * store.add reports the size the evaluated actor has (its parts hang from bones), and the size
 * options give the standing actor that size, keeping its proportions.
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

/** Bounds of the meshes as the render evaluates them (bones, poses and parents applied). */
function evaluated(doc: SceneDoc, frame = 1) {
  const scene = new SceneEvaluator(doc).evaluate(frame, { forRender: true });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const it of renderItems(scene, { forRender: true })) {
    for (const f of it.mesh.faces) triangles += f.length - 2;
    const P = it.mesh.positions;
    const m = it.worldMatrix;
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const v = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
        min[k] = Math.min(min[k], v);
        max[k] = Math.max(max[k], v);
      }
  }
  return { min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) as Vec3, triangles };
}

const near = (got: readonly number[], want: readonly number[], tol = 1e-3) =>
  expect(got.map((v, k) => Math.abs(v - want[k]) <= tol * Math.max(1, Math.abs(want[k])))).toEqual(
    want.map(() => true),
  );

describe('actor entries', () => {
  it('are defined for every kind of the spec, and listed only for the kinds CHARACTERS builds', () => {
    expect(new Set(ACTOR_DEFS.map((d) => d.kind))).toEqual(new Set(ACTOR_KINDS));
    expect(ACTOR_MODELS.map((e) => e.actor_kind)).toEqual(
      ACTOR_DEFS.filter((d) => BUILT_KINDS.includes(d.kind)).map((d) => d.kind),
    );
    for (const d of ACTOR_DEFS) {
      const listed = BUILTIN_CATALOG.find((e) => e.id === d.id);
      expect(!!listed, d.id).toBe(BUILT_KINDS.includes(d.kind));
      expect(getCatalogEntry(d.id) !== null, d.id).toBe(BUILT_KINDS.includes(d.kind));
    }
    // a kind not built yet is never a search result (it could not be added)
    const unbuilt = ACTOR_DEFS.filter((d) => !BUILT_KINDS.includes(d.kind));
    for (const d of unbuilt) {
      expect(rankCatalog(d.id).map((r) => r.entry.id)).not.toContain(d.id);
      expect(searchCatalog(d.name, { limit: 100 }).map((r) => r.id)).not.toContain(`builtin:${d.id}`);
    }
    for (const e of ACTOR_MODELS) {
      expect(e.rig, e.id).toBe('actor');
      expect(e.category, e.id).toBe(HUMANOID_KINDS.includes(e.actor_kind!) ? 'people' : 'animals');
    }
  });

  it('declare the size and triangles of their real default build', () => {
    for (const e of ACTOR_MODELS) {
      const t = setup();
      const r = t.run({ model: e.id, location: [0, 0, 0] });
      expect(r.ok, `${e.id}: ${r.error}`).toBe(true);
      const b = evaluated(t.doc);
      near(e.dimensions_m, b.size, 1e-6);
      expect(e.triangles, e.id).toBe(b.triangles);
      // and the standing actor's feet are on its location
      expect(b.min[2]).toBeCloseTo(0, 4);
      const m = measureActorKind(e.actor_kind!);
      expect(m.height, e.id).toBe(defaultActorHeight(e.actor_kind!));
    }
  });

  it('can all be added, with the size store.add reports equal to the evaluated actor', () => {
    for (const e of ACTOR_MODELS) {
      const t = setup();
      const r = t.run({ model: e.id, location: [1, -2, 0.5], rotation_deg: 30 });
      expect(r.ok, `${e.id}: ${r.error}`).toBe(true);
      // the parts hang from bones: the reported size is the posed actor's, turned 30°
      near(r.result.dimensions_m, evaluated(t.doc).size, 1e-4);
      expect(t.doc.getObject(r.result.root)!.type).toBe('ARMATURE');
      expect(r.result.objects[0]).toBe(r.result.root);
      expect(r.result.warnings).toEqual([]);
    }
  });

  it("are found by 'puppy' (the dog, while the small dog is not built)", () => {
    expect(rankCatalog('puppy')[0].entry.id).toBe('dog');
  });
});

describe('store.add of an actor', () => {
  it('passes facing, colour, name and pose to the actor it builds and selects it', () => {
    const t = setup();
    const r = t.run({
      model: 'person',
      location: [1, 2, 0],
      rotation_deg: 30,
      color: '#aa3344',
      name: 'Sam',
      params: { pose: 'sit' },
    });
    expect(r.ok, r.error).toBe(true);
    const actor = t.doc.getObject(r.result.root)!;
    expect(actor.name).toBe('Sam');
    expect(actor.location).toEqual([1, 2, 0]);
    expect(actor.rotation_euler[2]).toBeCloseTo((30 * Math.PI) / 180, 9);
    expect(actor.custom_props[DESK_PROPS.color]).toBe('#aa3344');
    expect(actor.custom_props[DESK_PROPS.kind]).toBe('adult');
    expect(r.result.entry).toMatchObject({ id: 'builtin:person', rig: 'actor', actor_kind: 'adult' });
    expect(r.result.entry.recolorable).toBe(true);
    expect(t.ctx.state.selectedIds).toEqual([r.result.root]);
    // sitting: lower than the standing 1.7 m
    expect(r.result.dimensions_m[2]).toBeLessThan(1.4);
  });

  it('stands at the 3D cursor by default at the kind’s own size', () => {
    const t = setup();
    t.ctx.state.cursorLocation = [3, -1, 0];
    const r = t.run({ model: 'builtin:horse' });
    expect(r.ok, r.error).toBe(true);
    expect(t.doc.getObject(r.result.root)!.location).toEqual([3, -1, 0]);
    expect(t.doc.getObject(r.result.root)!.custom_props[DESK_PROPS.heightM]).toBe(
      defaultActorHeight('horse'),
    );
    near(r.result.dimensions_m, getCatalogEntry('horse')!.dimensions_m, 1e-4);
  });

  it('gives the standing actor the overall size asked for, keeping its proportions', () => {
    for (const id of ['person', 'child', 'horse', 'dog']) {
      const e = getCatalogEntry(id)!;
      const [w, d, h] = e.dimensions_m;
      const cases: [Record<string, number>, Vec3][] = [
        // height_m is the overall height: the top of the head, a horse's ears (not its withers)
        [{ height_m: 1.6 }, [(w * 1.6) / h, (d * 1.6) / h, 1.6]],
        [{ width_m: 0.5 }, [0.5, (d * 0.5) / w, (h * 0.5) / w]],
        [{ depth_m: 1 }, [(w * 1) / d, 1, (h * 1) / d]],
        [{ scale: 1.25 }, [w * 1.25, d * 1.25, h * 1.25]],
      ];
      for (const [opts, want] of cases) {
        const t = setup();
        const r = t.run({ model: id, location: [0, 0, 0], ...opts });
        expect(r.ok, `${id} ${JSON.stringify(opts)}: ${r.error}`).toBe(true);
        near(evaluated(t.doc).size, want, 1e-6);
        near(r.result.dimensions_m, want, 1e-4);
      }
    }
  });

  it('sizes by the standing bounds whatever the pose', () => {
    const t = setup();
    const sitting = t.run({ model: 'woman', height_m: 1.8, params: { pose: 'sit' } });
    expect(sitting.ok, sitting.error).toBe(true);
    const actor = t.doc.getObject(sitting.result.root)!;
    // the same body as a woman standing 1.8 m tall
    const [, , h] = getCatalogEntry('woman')!.dimensions_m;
    expect(actor.custom_props[DESK_PROPS.heightM]).toBeCloseTo((defaultActorHeight('woman') * 1.8) / h, 9);
    expect(sitting.result.dimensions_m[2]).toBeLessThan(1.8);
  });

  it('keeps the proportions when several sizes are given: the first sets it, the others are reported', () => {
    const t = setup();
    const r = t.run({ model: 'horse', height_m: 2, width_m: 3, depth_m: 1, scale: 4 });
    expect(r.ok, r.error).toBe(true);
    expect(r.result.dimensions_m[2]).toBeCloseTo(2, 3);
    expect(r.result.warnings).toEqual([
      "'horse' keeps its proportions: height_m sets its size, width_m and depth_m ignored",
    ]);
    expect(t.reports.filter((x) => x.level === 'WARNING').map((x) => x.message)).toEqual(r.result.warnings);
  });

  it('refuses sizes outside the heights actors are built at, naming the option given, before building', () => {
    const t = setup();
    const scale = t.run({ model: 'horse', scale: 0.001 });
    expect(scale).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    const lo = MIN_ACTOR_HEIGHT / defaultActorHeight('horse');
    const hi = MAX_ACTOR_HEIGHT / defaultActorHeight('horse');
    expect(scale.error).toMatch(/^scale must be between ([\d.]+) and ([\d.]+) for 'horse' \(got 0\.001\)$/);
    const [, a, b] = /between ([\d.]+) and ([\d.]+)/.exec(scale.error!)!;
    // the printed range is inside the real one and within its rounding
    expect(Number(a)).toBeGreaterThanOrEqual(lo);
    expect(Number(a)).toBeLessThan(lo * 1.01);
    expect(Number(b)).toBeLessThanOrEqual(hi);
    expect(Number(b)).toBeGreaterThan(hi * 0.99);
    // and its bounds are accepted
    expect(t.run({ model: 'horse', scale: Number(a) }).ok).toBe(true);
    expect(t.run({ model: 'horse', scale: Number(b) }).ok).toBe(true);
    const objects = t.doc.listObjects().length;
    const width = t.run({ model: 'person', width_m: 9000 });
    expect(width).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(width.error).toMatch(/^width_m must be between [\d.]+ and [\d.]+ for 'person' \(got 9000\)$/);
    const height = t.run({ model: 'person', height_m: 10_000 });
    expect(height.error).toMatch(/^height_m must be between 0\.05 and 8 for 'person' \(got 10000\)$/);
    expect(t.doc.listObjects()).toHaveLength(objects);
  });

  it('takes the poses of its kind only, refused before anything is built', () => {
    const t = setup();
    expect(t.run({ model: 'dog', params: { pose: ANIMAL_POSES[3] } }).ok).toBe(true);
    const objects = t.doc.listObjects().length;
    const humanOnly = HUMAN_POSES.find((p) => !(ANIMAL_POSES as readonly string[]).includes(p))!;
    expect(t.run({ model: 'dog', params: { pose: humanOnly } })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(t.run({ model: 'woman', params: { pose: 'gallop' } })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(t.run({ model: 'woman', params: { mood: 'happy' } })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(t.doc.listObjects()).toHaveLength(objects);
  });
});

describe('actorBuildHeight', () => {
  const m = { height: 1.6, size: [0.8, 3.2, 2.4] as Vec3, triangles: 100 };

  it('is the default without a size, and the height that gives the size asked for', () => {
    expect(actorBuildHeight('x', m, {})).toBeUndefined();
    expect(actorBuildHeight('x', m, { scale: 1 })).toBeUndefined();
    expect(actorBuildHeight('x', m, { height_m: 1.2 })).toBeCloseTo(0.8, 12);
    expect(actorBuildHeight('x', m, { width_m: 1.6 })).toBeCloseTo(3.2, 12);
    expect(actorBuildHeight('x', m, { depth_m: 1.6 })).toBeCloseTo(0.8, 12);
    expect(actorBuildHeight('x', m, { scale: 2 })).toBeCloseTo(3.2, 12);
    // a size wins over scale (and is no warning)
    const warnings: string[] = [];
    expect(actorBuildHeight('x', m, { depth_m: 1.6, scale: 3 }, warnings)).toBeCloseTo(0.8, 12);
    expect(warnings).toEqual([]);
    expect(actorBuildHeight('x', m, { height_m: -1, scale: Number.NaN })).toBeUndefined();
  });
});
