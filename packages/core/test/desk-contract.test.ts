import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { OperatorError } from '../src/operators/context';
import {
  ACTOR_KINDS,
  ACTOR_PALETTE,
  ACTOR_POSES,
  ANIMAL_POSES,
  HUMAN_POSES,
  RIDEO_POSES,
  createActor,
  isActor,
  poseHeightShare,
} from '../src/desk/characters';
import { deskPhysicsBake } from '../src/desk/physics';
import { DESK_PROPS } from '../src/desk/props';
import {
  BUILTIN_CATALOG,
  builtinResult,
  getCatalogEntry,
  insertStoreFiles,
  searchCatalog,
  type CatalogEntry,
} from '../src/store';

/*
 * The contracts FOUNDATION wrote for the workstreams (spec §8, §10): rideo's pose heights, the cast
 * palette, isActor, the catalog lookup, and functions that work or fail with an OperatorError (a
 * stub with "<name> is not implemented yet" until its owner implements it).
 */

describe('characters contract', () => {
  it("gives rideo's pose height shares and cast palette", () => {
    expect(RIDEO_POSES).toEqual([
      'stand',
      'walk',
      'run',
      'sit',
      'crouch',
      'kneel',
      'lie',
      'reach',
      'point',
      'wave',
    ]);
    expect(RIDEO_POSES.map(poseHeightShare)).toEqual([1, 1, 0.97, 0.72, 0.62, 0.74, 0.22, 1, 1, 1]);
    expect(poseHeightShare('arms_crossed')).toBe(1);
    expect(poseHeightShare('anything')).toBe(1);
    expect(ACTOR_PALETTE).toEqual([
      '#ff8a3d',
      '#3d8bff',
      '#3dbe6b',
      '#a35bff',
      '#f2c230',
      '#ff5fa2',
      '#2ec4c4',
      '#e5484d',
    ]);
    expect(ACTOR_KINDS).toHaveLength(19);
    // every pose of a humanoid or an animal is an actor pose, each once
    for (const p of [...HUMAN_POSES, ...ANIMAL_POSES]) expect(ACTOR_POSES).toContain(p);
    expect(new Set(ACTOR_POSES).size).toBe(ACTOR_POSES.length);
  });

  it('tells actors (armatures with desk_role actor) from other objects', () => {
    const doc = SceneDoc.create({ empty: true });
    const props = { [DESK_PROPS.role]: 'actor' };
    const actor = doc.addObject({
      type: 'ARMATURE',
      name: 'Ada',
      data: doc.addArmature(),
      custom_props: props,
    });
    const rig = doc.addObject({ type: 'ARMATURE', name: 'Rig', data: doc.addArmature() });
    const empty = doc.addObject({ type: 'EMPTY', name: 'Prop', custom_props: props });
    expect([actor, rig, empty, 'missing'].map((id) => isActor(doc, id))).toEqual([true, false, false, false]);
  });

  it('works or fails clearly (an OperatorError; FAILED until CHARACTERS and MOTION implement it)', () => {
    const doc = SceneDoc.create({ empty: true });
    const settles = (f: () => unknown, name: string) => {
      try {
        f();
      } catch (err) {
        expect(err, name).toBeInstanceOf(OperatorError);
        if ((err as Error).message.includes('not implemented yet'))
          expect(err).toMatchObject({ code: 'FAILED', message: `${name} is not implemented yet` });
      }
    };
    settles(() => createActor(doc, { kind: 'adult' }), 'createActor');
    // nothing to bake in an empty scene
    expect(() => deskPhysicsBake(doc, {})).toThrow(OperatorError);
  });
});

describe('store contract', () => {
  it('looks built-in models up by id or store id', () => {
    expect(getCatalogEntry('no_such_model')).toBeNull();
    expect(searchCatalog('zzqqxx no such thing')).toEqual([]);
    const entry: CatalogEntry = {
      id: 'test_box',
      name: 'Test box',
      category: 'props',
      tags: ['box'],
      synonyms: ['crate'],
      description: 'A box for this test',
      dimensions_m: [1, 1, 1],
      triangles: 12,
      rig: null,
      build: () => ({ root: '', objects: [] }),
    };
    BUILTIN_CATALOG.push(entry);
    try {
      expect(getCatalogEntry('test_box')).toBe(entry);
      expect(getCatalogEntry('builtin:test_box')).toBe(entry);
      expect(getCatalogEntry('other:test_box')).toBeNull();
      expect(builtinResult(entry)).toMatchObject({
        id: 'builtin:test_box',
        provider: 'builtin',
        category: 'props',
        license: { spdx: 'CC0-1.0' },
        dimensions_m: [1, 1, 1],
        formats: ['builtin'],
        downloadable: true,
      });
    } finally {
      BUILTIN_CATALOG.splice(BUILTIN_CATALOG.indexOf(entry), 1);
    }
    expect(() =>
      insertStoreFiles(SceneDoc.create({ empty: true }), {
        entry: {
          id: 'x:y',
          name: 'Y',
          provider: 'x',
          license: { spdx: 'CC0-1.0', url: null, attribution: null },
          author: null,
          source_url: null,
        },
        format: 'glb',
        files: {},
        main: 'y.glb',
      }),
    ).toThrow(OperatorError);
  });
});
