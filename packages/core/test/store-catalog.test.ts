import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SceneDoc } from '../src/doc/scene-doc';
import { MeshBuilder, addBox } from '../src/generate/builder';
import { OperatorError } from '../src/operators/context';
import {
  BUILTIN_CATALOG,
  BUILTIN_LICENSE,
  STORE_CATEGORIES,
  builtinResult,
  getCatalogEntry,
  normalizeCatalogId,
} from '../src/store';
import {
  assembleModel,
  defineModel,
  geometryBounds,
  geometryTriangles,
  hexToLinear,
  parseModelParams,
  part,
  sizeScale,
  type ModelGeometry,
  type ModelMaterial,
} from '../src/store/builtin/kit';
import { FURNITURE_MODELS } from '../src/store/builtin/furniture';
import { PROPS_MODELS } from '../src/store/builtin/props';
import { FOOD_MODELS } from '../src/store/builtin/food';
import { ACTOR_MODELS } from '../src/store/builtin/actors';
import type { Vec3 } from '../src/math/types';

/*
 * The built-in catalog as a whole (ids, categories, lookups, store results) and the kit every
 * CATALOG-A model is assembled with (colours, sizing, parameters, the root and its parts).
 */

describe('built-in catalog', () => {
  it('has about 150 models with unique snake_case ids in the store categories', () => {
    expect(BUILTIN_CATALOG.length).toBeGreaterThanOrEqual(140);
    const seen = new Set<string>();
    for (const e of BUILTIN_CATALOG) {
      expect(e.id, e.id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false);
      seen.add(e.id);
      expect(STORE_CATEGORIES, e.id).toContain(e.category);
      expect(
        e.dimensions_m.every((v) => v > 0 && Number.isFinite(v)),
        e.id,
      ).toBe(true);
      expect(e.triangles, e.id).toBeGreaterThan(0);
      expect(typeof e.build, e.id).toBe('function');
    }
    // CATALOG-A's categories have models (CATALOG-B fills the others)
    for (const c of ['people', 'animals', 'furniture', 'props', 'food'] as const)
      expect(
        BUILTIN_CATALOG.some((e) => e.category === c),
        c,
      ).toBe(true);
  });

  it('holds every CATALOG-A model', () => {
    const ids = new Set(BUILTIN_CATALOG.map((e) => e.id));
    for (const e of [...FURNITURE_MODELS, ...PROPS_MODELS, ...FOOD_MODELS, ...ACTOR_MODELS])
      expect(ids.has(e.id), e.id).toBe(true);
    expect(FURNITURE_MODELS.length + PROPS_MODELS.length + FOOD_MODELS.length).toBeGreaterThanOrEqual(65);
  });

  it('normalizes ids to lower-case words joined by underscores', () => {
    expect(normalizeCatalogId(' Coffee Table ')).toBe('coffee_table');
    expect(normalizeCatalogId('coffee-table')).toBe('coffee_table');
    expect(normalizeCatalogId('coffee__table')).toBe('coffee_table');
    expect(normalizeCatalogId('_sofa_')).toBe('sofa');
    expect(normalizeCatalogId('')).toBe('');
  });

  it('looks models up by id, store id, dashes, spaces or capitals', () => {
    const table = BUILTIN_CATALOG.find((e) => e.id === 'coffee_table');
    for (const id of [
      'coffee_table',
      'builtin:coffee_table',
      'Builtin : Coffee Table',
      'coffee-table',
      'COFFEE TABLE',
    ])
      expect(getCatalogEntry(id), id).toBe(table);
    expect(getCatalogEntry('polyhaven:coffee_table')).toBeNull();
    expect(getCatalogEntry('coffee')).toBeNull();
    expect(getCatalogEntry('')).toBeNull();
    expect(getCatalogEntry('builtin:')).toBeNull();
  });

  it('describes a model as a CC0 store result of the built-in provider', () => {
    const sofa = getCatalogEntry('sofa')!;
    const r = builtinResult(sofa);
    expect(r).toEqual({
      id: 'builtin:sofa',
      provider: 'builtin',
      name: sofa.name,
      category: 'furniture',
      tags: sofa.tags,
      thumbnail_url: null,
      license: { ...BUILTIN_LICENSE },
      author: '3D Editor built-in',
      source_url: null,
      dimensions_m: sofa.dimensions_m,
      triangles: sofa.triangles,
      formats: ['builtin'],
      downloadable: true,
    });
    // copies: changing the result leaves the catalog alone
    r.tags.push('changed');
    r.dimensions_m![0] = 99;
    expect(sofa.tags).not.toContain('changed');
    expect(sofa.dimensions_m[0]).not.toBe(99);
  });
});

describe('kit: colours and sizes', () => {
  it('reads sRGB hex colours as linear RGB', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToLinear('#000')).toEqual([0, 0, 0]);
    expect(hexToLinear('ff0000')).toEqual([1, 0, 0]);
    const [r, g] = hexToLinear('#C03030')!;
    expect(r).toBeCloseTo(0.5271, 3);
    expect(g).toBeCloseTo(0.0296, 3);
    expect(hexToLinear('red')).toBeNull();
    expect(hexToLinear('#12345')).toBeNull();
  });

  const natural: Vec3 = [2, 1, 0.5];

  it('scales uniformly to one size, or by `scale` without sizes', () => {
    expect(sizeScale(natural, {})).toEqual([1, 1, 1]);
    expect(sizeScale(natural, { scale: 2 })).toEqual([2, 2, 2]);
    expect(sizeScale(natural, { height_m: 1 })).toEqual([2, 2, 2]);
    expect(sizeScale(natural, { width_m: 1 })).toEqual([0.5, 0.5, 0.5]);
    expect(sizeScale(natural, { depth_m: 3 })).toEqual([3, 3, 3]);
    // a size wins over scale
    expect(sizeScale(natural, { height_m: 1, scale: 5 })).toEqual([2, 2, 2]);
    // nonsense scales are ignored
    expect(sizeScale(natural, { scale: -1 })).toEqual([1, 1, 1]);
    expect(sizeScale(natural, { scale: Number.NaN })).toEqual([1, 1, 1]);
  });

  it('fits several sizes, the other axes by the geometric mean of their factors', () => {
    const s = sizeScale(natural, { width_m: 4, depth_m: 1 });
    expect(s[0]).toBeCloseTo(2, 12);
    expect(s[1]).toBeCloseTo(1, 12);
    expect(s[2]).toBeCloseTo(Math.SQRT2, 12);
    expect(sizeScale(natural, { width_m: 4, depth_m: 2, height_m: 0.25 })).toEqual([2, 2, 0.5]);
  });

  it('ignores (and reports) a size along an axis the model has no extent on', () => {
    const warnings: string[] = [];
    expect(sizeScale([1, 1, 0], { height_m: 2 }, warnings)).toEqual([1, 1, 1]);
    expect(warnings).toEqual(['height_m ignored: the model has no extent along that axis']);
    expect(sizeScale([1, 1, 0], { height_m: 2, width_m: 3 })).toEqual([3, 3, 3]);
  });
});

describe('kit: parameters', () => {
  const sized = z.object({
    seats: z.number().int().min(1).max(5).default(3),
    style: z.enum(['plain', 'tufted']).default('plain'),
  });

  it('applies defaults and refuses unknown or wrong parameters', () => {
    expect(parseModelParams({ id: 'x', params: sized }, undefined)).toEqual({ seats: 3, style: 'plain' });
    expect(parseModelParams({ id: 'x', params: sized }, { seats: 2 })).toEqual({ seats: 2, style: 'plain' });
    const bad = (params: Record<string, unknown>) => {
      try {
        parseModelParams({ id: 'x', params: sized }, params);
      } catch (e) {
        expect(e).toBeInstanceOf(OperatorError);
        expect((e as OperatorError).code).toBe('INVALID_PARAMS');
        return (e as Error).message;
      }
      throw new Error('accepted');
    };
    expect(bad({ seats: 9 })).toMatch(/^Invalid parameters for model 'x': seats: /);
    expect(bad({ style: 'gold' })).toMatch(/style/);
    expect(bad({ legs: 4 })).toMatch(/legs/);
  });

  it('refuses parameters for a model that has none', () => {
    expect(parseModelParams({ id: 'rug' }, {})).toEqual({});
    expect(parseModelParams({ id: 'rug' }, undefined)).toEqual({});
    expect(() => parseModelParams({ id: 'rug' }, { size: 2, color: 'x' })).toThrow(
      "Model 'rug' has no parameters (got size, color)",
    );
  });
});

describe('kit: assembleModel', () => {
  const wood: ModelMaterial = { name: 'Test Wood', color: '#a0522d', roughness: 0.6 };
  const paint: ModelMaterial = { name: 'Test Paint', color: '#2050c0', roughness: 0.4, tint: true };
  const glass: ModelMaterial = { name: 'Test Glass', color: '#ffffff', roughness: 0.05, alpha: 0.3 };
  const lamp: ModelMaterial = {
    name: 'Test Lamp',
    color: '#ffffff',
    roughness: 0.5,
    emission: { color: '#ffcc88', strength: 4 },
  };

  /** A 2 × 1 × 0.5 slab standing from z 1 to 1.5 off-centre, a post under it and a knob on the post. */
  function geometry(): ModelGeometry {
    const slab = new MeshBuilder();
    addBox(slab, [3, 4, 1], [5, 5, 1.5], { mat: 0 });
    addBox(slab, [3.5, 4.2, 1.5], [4.5, 4.8, 1.52], { mat: 1 });
    const post = new MeshBuilder();
    addBox(post, [-0.05, -0.05, 0], [0.05, 0.05, 1], { mat: 0 });
    const knob = new MeshBuilder();
    addBox(knob, [-0.02, -0.02, -0.02], [0.02, 0.02, 0.02], { mat: 0 });
    return {
      parts: [
        // the knob is listed before the post it hangs from
        part('knob', knob, [lamp], { parent: 'post', location: [0, -0.1, 0.5] }),
        part('slab', slab, [wood, paint]),
        part('post', post, [glass], { location: [4, 4.5, 0] }),
        part('empty', new MeshBuilder(), [wood]),
      ],
    };
  }

  it('adds an EMPTY root at the base centre with the parts under it', () => {
    const doc = SceneDoc.create({ empty: true });
    const g = geometry();
    expect(geometryTriangles(g)).toBe(4 * 12);
    expect(geometryBounds(g.parts)).toEqual({ min: [3, 4, 0], max: [5, 5, 1.52] });
    const { root, objects, warnings } = assembleModel(doc, 'Thing', g, { location: [10, 20, 0.5] }, { a: 1 });
    expect(warnings).toEqual([]);
    const r = doc.getObject(root)!;
    expect(r).toMatchObject({
      type: 'EMPTY',
      name: 'Thing',
      location: [10, 20, 0.5],
      rotation_euler: [0, 0, 0],
      scale: [1, 1, 1],
      custom_props: { a: 1 },
    });
    // the empty part is left out; the post comes before its knob
    expect(objects.slice(1).map((id) => doc.getObject(id)!.custom_props.store_part)).toEqual([
      'post',
      'knob',
      'slab',
    ]);
    const [post, knob, slab] = objects.slice(1).map((id) => doc.getObject(id)!);
    // root-level parts move by the base centre (4, 4.5, 0); the knob keeps its offset on the post
    expect(slab.location).toEqual([-4, -4.5, 0]);
    expect(slab.parent).toBe(root);
    expect(post.location).toEqual([0, 0, 0]);
    expect(knob.parent).toBe(post.id);
    expect(knob.location).toEqual([0, -0.1, 0.5]);
    const world = doc.worldMatrix(knob.id);
    expect([world[12], world[13], world[14]]).toEqual([10, 19.9, 1]);
  });

  it('turns and sizes the root, names it and recolours the tinted material only', () => {
    const doc = SceneDoc.create({ empty: true });
    const { root, objects } = assembleModel(doc, 'Thing', geometry(), {
      rotation_deg: 90,
      height_m: 3.04,
      name: '  Big thing ',
      color: '#FF0000',
    });
    const r = doc.getObject(root)!;
    expect(r.name).toBe('Big thing');
    expect(r.rotation_euler[2]).toBeCloseTo(Math.PI / 2, 12);
    expect(r.scale.map((v) => +v.toFixed(9))).toEqual([2, 2, 2]);
    const slab = doc.getObject(objects[3])!;
    const names = slab.material_slots.map((id) => doc.getMaterial(id!)!.name);
    expect(names).toEqual(['Test Wood', 'Test Paint #ff0000']);
    expect(doc.getMaterial(slab.material_slots[1]!)!.base_color).toEqual([1, 0, 0, 1]);
    // the material settings
    const post = doc.getObject(objects[1])!;
    expect(doc.getMaterial(post.material_slots[0]!)).toMatchObject({ alpha: 0.3, blend_method: 'BLEND' });
    const knob = doc.getObject(objects[2])!;
    const lampMat = doc.getMaterial(knob.material_slots[0]!)!;
    expect(lampMat.emission_strength).toBe(4);
    expect(lampMat.emission_color[0]).toBeCloseTo(1, 6);
  });

  it('reuses materials by name and keeps the default colour when the colour asked is it', () => {
    const doc = SceneDoc.create({ empty: true });
    assembleModel(doc, 'A', geometry(), {});
    const count = doc.listMaterials().length;
    assembleModel(doc, 'B', geometry(), { color: '#2050C0' });
    assembleModel(doc, 'C', geometry(), {});
    expect(doc.listMaterials().length).toBe(count);
    // not a colour: ignored
    assembleModel(doc, 'D', geometry(), { color: 'blue' });
    expect(doc.listMaterials().length).toBe(count);
  });

  it('refuses a model without geometry', () => {
    const doc = SceneDoc.create({ empty: true });
    expect(() => assembleModel(doc, 'Nothing', { parts: [part('a', new MeshBuilder(), [])] }, {})).toThrow(
      /Nothing: the model has no geometry/,
    );
    expect(doc.listObjects()).toHaveLength(0);
  });

  it('defineModel builds with the store id and licence on the root', () => {
    const entry = defineModel({
      id: 'test_slab',
      name: 'Test slab',
      category: 'props',
      tags: ['test'],
      synonyms: [],
      description: 'A test slab.',
      dimensions_m: [2, 1, 0.52],
      triangles: 24,
      params: z.object({ tall: z.boolean().default(false) }),
      geometry: (p) => {
        const b = new MeshBuilder();
        addBox(b, [-1, -0.5, 0], [1, 0.5, p.tall ? 2 : 0.52], { mat: 0 });
        return { parts: [part('slab', b, [wood])] };
      },
    });
    expect(entry.rig).toBeNull();
    const doc = SceneDoc.create({ empty: true });
    const { root } = entry.build(doc, { params: { tall: true } });
    expect(doc.getObject(root)!.custom_props).toEqual({
      store_id: 'builtin:test_slab',
      store_source: 'builtin',
      license: 'CC0-1.0',
      author: '3D Editor built-in',
    });
    expect(() => entry.build(doc, { params: { tall: 'yes' } })).toThrow(
      /Invalid parameters for model 'test_slab'/,
    );
  });
});
