import { afterEach, describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import type { RunResult } from '../src/operators/registry';
import {
  estimateOperator,
  setOperatorMemoryCheck,
  type OperatorMemoryRequest,
} from '../src/operators/memory';
import {
  DESK_ACTOR_MAX_FACES,
  DESK_ACTOR_MAX_OBJECTS,
  STORE_MODEL_MAX_FACES,
  STORE_MODEL_MAX_OBJECTS,
  STORE_MODEL_MIN_FACES,
  STORE_PARAMS_GROWTH_BY_MODEL,
  storeModelFaces,
} from '../src/operators/memory-desk';
import { safeJsonSchema } from '../src/operators/registry';
import { BUILTIN_CATALOG, type CatalogEntry } from '../src/store';
import { base64Encode } from '../src/util/json';

/*
 * Memory estimates of the store operators: store.add from the model's catalog entry (its declared
 * triangles with margins; parametric models allowed to grow; people and animals as actors), and the
 * refusals of the installed memory check, which leave the document as it was.
 */

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
  const run = (id: string, p: unknown) => reg.run(ctx, id, p) as RunResult<any> & { result: any };
  const estimate = (id: string, p: Record<string, unknown>) =>
    estimateOperator(id, ctx, reg.parseParams(id, p));
  return { doc, reg, ctx, run, estimate };
}

/**
 * The parameters of a model at its schema maximums: every number at its maximum (a seed also at 0),
 * with every value of its choices and switches.
 */
function maximumParams(e: CatalogEntry): Record<string, unknown>[] {
  const schema = safeJsonSchema(e.params!) as { properties?: Record<string, Record<string, any>> };
  let out: Record<string, unknown>[] = [{}];
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    let values: unknown[];
    if (v.type === 'number' || v.type === 'integer') values = k === 'seed' ? [0, v.maximum] : [v.maximum];
    else if (Array.isArray(v.enum)) values = v.enum;
    else if (v.type === 'boolean') values = [true, false];
    else continue;
    expect(values.every((x) => x !== undefined), `${e.id}.${k} has a maximum`).toBe(true);
    out = out.flatMap((p) => values.map((x) => ({ ...p, [k]: x })));
  }
  return out;
}

/** Triangles of the mesh objects among `ids`. */
function triangles(doc: SceneDoc, ids: readonly string[]): number {
  let n = 0;
  for (const id of ids) {
    const o = doc.getObject(id)!;
    if (o.type === 'MESH') for (const f of doc.getMesh(o.data!)!.faces) n += f.length - 2;
  }
  return n;
}

afterEach(() => {
  setOperatorMemoryCheck(null);
});

describe('store.add estimate', () => {
  it('takes the declared triangles with a margin, more for parametric models, within bounds', () => {
    expect(storeModelFaces(2000, false)).toBe(3000);
    expect(storeModelFaces(2000, true)).toBe(30_000);
    expect(storeModelFaces(100, false)).toBe(STORE_MODEL_MIN_FACES);
    expect(storeModelFaces(10_000, true)).toBe(STORE_MODEL_MAX_FACES);
    // no usable count: the bound
    expect(storeModelFaces(Number.NaN, false)).toBe(STORE_MODEL_MAX_FACES);
    expect(storeModelFaces(0, false)).toBe(STORE_MODEL_MAX_FACES);
  });

  it('covers what parametric models build at their largest parameters', () => {
    const t = setup();
    for (const [model, params] of [
      ['sofa', { seats: 5 }],
      ['bed', { size: 'king' }],
      ['tv', { inches: 100 }],
      ['chair', { back: 'panel' }],
    ] as const) {
      const r = t.run('store.add', { model, params });
      expect(r.ok, model).toBe(true);
      const e = t.estimate('store.add', { model, params })!;
      expect(e.faces, model).toBeGreaterThanOrEqual(triangles(t.doc, r.result.objects));
      expect(e.objects, model).toBe(STORE_MODEL_MAX_OBJECTS);
      expect(e.lower).toBe("the model's size parameters (params)");
    }
    // a model without parameters has nothing to lower
    expect(t.estimate('store.add', { model: 'mug' })!.lower).toBe('');
  });

  it('covers every parametric model built at its schema maximums', () => {
    const models = BUILTIN_CATALOG.filter((e) => e.params && e.rig !== 'actor');
    expect(models.length).toBeGreaterThan(30);
    for (const e of models) {
      for (const params of maximumParams(e)) {
        const t = setup();
        const r = t.run('store.add', { model: e.id, params });
        expect(r.ok, `${e.id} ${JSON.stringify(params)}: ${r.error}`).toBe(true);
        const built = triangles(t.doc, r.result.objects);
        const e2 = t.estimate('store.add', { model: e.id, params })!;
        expect(e2.faces, `${e.id} ${JSON.stringify(params)}: ${built} triangles`).toBeGreaterThanOrEqual(built);
      }
    }
    // the roads grow most: a six-lane 500 m road is a hundred times its default
    expect(storeModelFaces(48, true, STORE_PARAMS_GROWTH_BY_MODEL.road)).toBeGreaterThan(5000);
  });

  it('counts people and animals as actors, with the keys of a pose', () => {
    const t = setup();
    const still = t.estimate('store.add', { model: 'person' })!;
    expect(still).toMatchObject({ faces: DESK_ACTOR_MAX_FACES, objects: DESK_ACTOR_MAX_OBJECTS });
    expect(still.keyframes ?? 0).toBe(0);
    const posed = t.estimate('store.add', { model: 'horse', params: { pose: 'eat' } })!;
    expect(posed.keyframes).toBeGreaterThan(0);
    expect(posed.bytes).toBeGreaterThan(still.bytes);
  });

  it('has none for a model that does not exist (refused before anything is built)', () => {
    const t = setup();
    expect(t.estimate('store.add', { model: 'flux_capacitor' })).toBeNull();
    let asked = 0;
    setOperatorMemoryCheck(() => {
      asked++;
      return null;
    });
    expect(t.run('store.add', { model: 'flux_capacitor' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(asked).toBe(0);
  });

  it('is asked of the memory check, whose refusal adds nothing', () => {
    const t = setup();
    const asked: OperatorMemoryRequest[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req);
      return 'Not enough memory for this test';
    });
    const r = t.run('store.add', { model: 'sofa' });
    expect(r).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(r.error).toMatch(/Not enough memory for this test/);
    expect(asked).toHaveLength(1);
    expect(asked[0].operator).toBe('store.add');
    expect(asked[0].estimate.faces).toBe(storeModelFaces(2760, true));
    expect(t.doc.listObjects()).toHaveLength(0);
    expect(t.doc.listMaterials()).toHaveLength(0);
  });
});

describe('store.insert_files estimate', () => {
  const OBJ = 'mtllib crate.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nusemtl Wood\nf 1 2 3 4\n';
  const MTL = 'newmtl Wood\nKd 0.6 0.4 0.2\n';
  const entry = {
    id: 'example:crate',
    name: 'Crate',
    provider: 'example',
    license: {
      spdx: 'CC0-1.0',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: null,
    },
    author: null,
    source_url: null,
  };
  const params = (extra: Record<string, string> = {}) => ({
    entry,
    format: 'obj',
    main: 'crate.obj',
    files: {
      'crate.obj': base64Encode(new TextEncoder().encode(OBJ)),
      'crate.mtl': base64Encode(new TextEncoder().encode(MTL)),
      ...extra,
    },
  });

  it('grows with the files besides the main one and counts the root', () => {
    const t = setup();
    const small = t.estimate('store.insert_files', params())!;
    const big = t.estimate(
      'store.insert_files',
      params({ 'tex.png': base64Encode(new Uint8Array(400_000)) }),
    )!;
    expect(small.objects).toBeGreaterThanOrEqual(2);
    expect(big.bytes - small.bytes).toBeGreaterThan(400_000);
    expect(big.addedStoredBytes - small.addedStoredBytes).toBeGreaterThanOrEqual(400_000);
  });

  it('finds the main file however its path is spelled, as the insert does', () => {
    const t = setup();
    const asked: OperatorMemoryRequest[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req);
      return null;
    });
    const plain = params();
    const obj = plain.files['crate.obj'];
    const mtl = plain.files['crate.mtl'];
    for (const [files, main] of [
      [{ 'crate.obj': obj, 'crate.mtl': mtl }, 'crate.obj'],
      [{ 'crate.obj': obj, 'crate.mtl': mtl }, './crate.obj'],
      [{ 'models/crate.obj': obj, 'models/crate.mtl': mtl }, 'models\\crate.obj'],
      [{ '/crate.obj': obj, '/crate.mtl': mtl }, 'crate.obj'],
    ] as const) {
      const r = t.run('store.insert_files', { ...plain, files, main });
      expect(r.ok, `${main}: ${r.error}`).toBe(true);
    }
    expect(asked).toHaveLength(4);
    // the same estimate every time: the main file's faces, the material file as its companion
    for (const req of asked) {
      expect(req.estimate.faces).toBe(asked[0].estimate.faces);
      expect(req.estimate.bytes).toBe(asked[0].estimate.bytes);
    }
    expect(asked[0].estimate.faces).toBeGreaterThan(0);
  });

  it('is asked of the memory check, whose refusal imports nothing', () => {
    const t = setup();
    const asked: string[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req.operator);
      return 'Not enough memory for this test';
    });
    expect(t.run('store.insert_files', params())).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(asked).toEqual(['store.insert_files']);
    expect(t.doc.listObjects()).toHaveLength(0);
    expect(t.doc.listMaterials()).toHaveLength(0);
    setOperatorMemoryCheck(null);
    expect(t.run('store.insert_files', params()).ok).toBe(true);
  });
});
