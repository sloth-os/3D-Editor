import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { applyPose } from '../src/desk/characters';
import { actorParts, requireActor } from '../src/desk/characters/rig';
import { getShots } from '../src/desk/shots';
import { meshWorldBounds } from '../src/store/builtin/kit';
import { fcurveKey } from '../src/doc/scene-doc';
import {
  UNIT_ROOT,
  UnitError,
  adoptUnit,
  decodeUnit,
  derivePartId,
  deriveUnitId,
  extractUnit,
  docHasUnitInstances,
  encodeUnit,
  encodeUnitBody,
  exportedCustomProps,
  insertUnit,
  listUnits,
  makeLocal,
  readInstance,
  removeObjectTrees,
  unitStatus,
  updateUnit,
  type UnitBody,
  type UnitPayload,
} from '../src/desk/units';
import { UNIT_MAGIC, gzipDeterministic, sha256Hex, writeContainer } from '../src/desk/container';
import type { DatablockKind } from '../src/doc/types';
import { createCube } from '../src/mesh/primitives';
import { exportScene } from '../src/io';
import {
  KITE,
  MIRA,
  PIP,
  actorOf,
  dress,
  editedUnit,
  headerInput,
  pin,
  propOf,
  stagedDoc,
  unitFrom,
} from './desk-units-helpers';

/*
 * Inserting a decoded unit (desk/units/insert.ts): derived ids, names, placement, scene props, the
 * refusals, one undo step, a figure that works as an actor, two replicas inserting the same unit, a
 * procedural actor replaced by a library figure, and a slot an instance was taken out of (remove.ts).
 */

const kindOf = (pk: string) => pk.slice(0, pk.indexOf(':')) as DatablockKind;

/** The '<kind>:<id>' of the ids `ids` (an insert's) the document still holds. */
const held = (doc: SceneDoc, ids: Record<string, string>) =>
  Object.entries(ids)
    .filter(([pk, id]) => doc.has(kindOf(pk), id))
    .map(([pk, id]) => `${kindOf(pk)}:${id}`);

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof UnitError ? err.code : `not a UnitError: ${String(err)}`;
  }
  return 'no error';
};

/** The Mira figure unit, made once from a staged scene. */
function miraUnit(): UnitPayload {
  const src = stagedDoc();
  return unitFrom(src, { kind: 'figure', actor: actorOf(src, MIRA).id }).unit;
}

/** Mira's actor at rest, standing at the origin (her animation removed): the bounds a figure unit keeps. */
function restBounds(doc: SceneDoc, actor: string) {
  const d = SceneDoc.fromUpdate(doc.encodeState());
  const ids = [
    actor,
    ...d
      .listObjects()
      .filter((o) => o.custom_props.desk_actor === actor)
      .map((o) => o.id),
  ];
  for (const id of ids) for (const fc of d.listFCurves(id)) d.removeFCurve(fcurveKey(fc));
  const a = d.getObject(actor)!;
  const bones = Object.fromEntries(
    Object.entries(a.pose.bones).map(([n, b]) => [
      n,
      { ...b, location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1] },
    ]),
  );
  d.updateObject(actor, { location: [0, 0, 0], rotation_euler: [0, 0, 0], pose: { bones } as typeof a.pose });
  return meshWorldBounds(d, ids, 0)!;
}

describe('insertUnit', () => {
  it('writes every datablock under deriveUnitId(key, source id), names made unique, the root placed', () => {
    const unit = miraUnit();
    const doc = stagedDoc();
    const key = 'cast:chr_0123456789copy';
    const r = insertUnit(doc, unit, {
      ...pin(3, 'b'.repeat(64)),
      key,
      location: [2, -1, 0],
      rotation_euler: [0, 0, 1.5],
      rootProps: { desk_character_id: 'chr_0123456789copy', desk_role: 'actor' },
    });
    for (const [pk, id] of Object.entries(r.ids))
      expect(id).toBe(deriveUnitId(key, pk.slice(pk.indexOf(':') + 1)));
    expect(r.root).toBe(deriveUnitId(key, UNIT_ROOT));
    const root = doc.getObject(r.root)!;
    expect(root.name).toBe('Mira.001'); // the staged Mira keeps her name
    expect(root.location).toEqual([2, -1, 0]);
    expect(root.rotation_euler).toEqual([0, 0, 1.5]);
    expect(root.scale).toEqual(unit.body.blocks.objects![UNIT_ROOT].scale);
    expect(root.custom_props).toMatchObject({
      desk_character_id: 'chr_0123456789copy',
      desk_role: 'actor',
      desk_kind: 'child',
      unit_ref: 'lib_0123456789test',
      unit_version: 3,
      unit_sha256: 'b'.repeat(64),
      unit_digest: unit.header.digest,
      unit_kind: 'figure',
      unit_key: key,
      unit_name: 'Mira',
    });
    expect(listUnits(doc)).toEqual([
      expect.objectContaining({
        root: r.root,
        version: 3,
        binding: { castId: 'chr_0123456789copy' },
        parts: Object.keys(r.ids).length,
        present: Object.keys(r.ids).length,
      }),
    ]);
    expect(unitStatus(doc, r.root)).toEqual({ edited: [], missing: [] });
    // a unit-owned prop given in rootProps overrides the unit's and makes the root count as edited
    const d2 = SceneDoc.create({ empty: true });
    const r2 = insertUnit(d2, unit, { ...pin(), key, rootProps: { desk_color: '#000000' } });
    expect(unitStatus(d2, r2.root).edited.map((p) => p.src)).toEqual([UNIT_ROOT]);
  });

  it('refuses a second insert with the same key, a taken root id, a bad key, a bad pin, a missing parent', () => {
    const unit = miraUnit();
    const doc = SceneDoc.create({ empty: true });
    insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    expect(code(() => insertUnit(doc, unit, { ...pin(), key: 'cast:a' }))).toBe('UNIT_INSTANCE_EXISTS');
    const seeded = SceneDoc.create({ empty: true });
    seeded.addObject({ type: 'EMPTY', name: 'In the way' }, deriveUnitId('cast:b', UNIT_ROOT));
    expect(code(() => insertUnit(seeded, unit, { ...pin(), key: 'cast:b' }))).toBe('UNIT_ID_TAKEN');
    expect(seeded.objectIds()).toHaveLength(1);
    expect(code(() => insertUnit(doc, unit, { ...pin(), key: 'has space' }))).toBe('UNIT_BAD_KEY');
    expect(code(() => insertUnit(doc, unit, { ...pin(0), key: 'cast:d' }))).toBe('UNIT_BAD_SPEC');
    expect(code(() => insertUnit(doc, unit, { ...pin(1, 'ABC'), key: 'cast:d' }))).toBe('UNIT_BAD_SPEC');
    expect(code(() => insertUnit(doc, unit, { ...pin(1.5), key: 'cast:d' }))).toBe('UNIT_BAD_SPEC');
    expect(code(() => insertUnit(doc, unit, { ...pin(), key: 'cast:d', parent: 'nope' }))).toBe(
      'UNIT_NOT_FOUND',
    );
    expect(code(() => insertUnit(doc, unit, { ...pin(), key: 'cast:d', collection: 'nope' }))).toBe(
      'UNIT_NOT_FOUND',
    );
  });

  it('is one undo step, and undoing it leaves the document as it was', () => {
    const unit = miraUnit();
    const doc = stagedDoc();
    const before = doc.toSnapshot();
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    insertUnit(doc, unit, { ...pin(), key: 'cast:extra' });
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(doc.toSnapshot()).toEqual(before);
  });
});

describe('an inserted figure', () => {
  it('is an actor: requireActor, its 21 parts, applyPose keys it; its rest bounds are the source actor’s', () => {
    const src = stagedDoc();
    const mira = actorOf(src, MIRA);
    const { unit } = unitFrom(src, { kind: 'figure', actor: mira.id });
    const dst = stagedDoc();
    const r = insertUnit(dst, unit, { ...pin(), key: 'cast:chr_0123456789copy', location: [0, 0, 0] });
    expect(requireActor(dst, r.root).kind).toBe('child');
    expect(actorParts(dst, r.root).size).toBe(21);
    applyPose(dst, r.root, 'wave', { frame: 12 });
    expect(dst.listFCurves(r.root).length).toBeGreaterThan(0);
    // posing touches only scene-owned fields: no part reads as edited
    expect(unitStatus(dst, r.root)).toEqual({ edited: [], missing: [] });
    const ids = [
      r.root,
      ...dst
        .listObjects()
        .filter((o) => o.custom_props.desk_actor === r.root)
        .map((o) => o.id),
    ];
    const fresh = SceneDoc.create({ empty: true });
    const r2 = insertUnit(fresh, unit, { ...pin(), key: 'cast:x' });
    const got = meshWorldBounds(fresh, Object.values(r2.ids), 0)!;
    const want = restBounds(src, mira.id);
    for (let i = 0; i < 3; i++) {
      expect(got.min[i]).toBeCloseTo(want.min[i], 6);
      expect(got.max[i]).toBeCloseTo(want.max[i], 6);
    }
    expect(got.triangles).toBe(want.triangles);
    expect(ids).toHaveLength(22);
  });
});

describe('two replicas', () => {
  it('inserting the same unit with the same key derive the same ids: merged, nothing is doubled', () => {
    const unit = miraUnit();
    const base = stagedDoc();
    const a = SceneDoc.fromUpdate(base.encodeState());
    const b = SceneDoc.fromUpdate(base.encodeState());
    const ra = insertUnit(a, unit, { ...pin(), key: `cast:${PIP}x` });
    const rb = insertUnit(b, unit, { ...pin(), key: `cast:${PIP}x` });
    expect(rb.ids).toEqual(ra.ids);
    const count = a.listObjects().length;
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(a.listObjects()).toHaveLength(count);
    expect(b.listObjects()).toHaveLength(count);
    expect(
      a
        .listObjects()
        .map((o) => o.id)
        .sort(),
    ).toEqual(
      b
        .listObjects()
        .map((o) => o.id)
        .sort(),
    );
    expect(listUnits(a)).toHaveLength(1);
    expect(readInstance(b, rb.root)?.key).toBe(`cast:${PIP}x`);
  });
});

describe('replace: a procedural actor swapped for a library figure', () => {
  it('keeps its id, name, placement, animation, shot subjects and scene props; its old parts go', () => {
    const unit = miraUnit();
    const doc = stagedDoc();
    const mira = actorOf(doc, MIRA);
    const oldParts = doc
      .listObjects()
      .filter((o) => o.custom_props.desk_actor === mira.id)
      .map((o) => o.id);
    const curves = doc.listFCurves(mira.id).map(fcurveKey).sort();
    const shotsBefore = getShots(doc).map((s) => s.subjects);
    const r = insertUnit(doc, unit, { ...pin(), key: `cast:${MIRA}`, replace: mira.id });
    expect(r.root).toBe(mira.id);
    expect(r.warnings).toEqual([]);
    const now = doc.getObject(mira.id)!;
    expect(now.name).toBe('Mira');
    expect(now.location).toEqual(mira.location);
    expect(now.custom_props).toMatchObject({
      desk_character_id: MIRA,
      desk_rideo_clip: mira.custom_props.desk_rideo_clip,
      unit_key: `cast:${MIRA}`,
    });
    expect(doc.listFCurves(mira.id).map(fcurveKey).sort()).toEqual(curves);
    expect(getShots(doc).map((s) => s.subjects)).toEqual(shotsBefore);
    for (const id of oldParts) expect(doc.getObject(id)).toBeNull();
    expect(actorParts(doc, mira.id).size).toBe(21);
    for (const id of actorParts(doc, mira.id).values()) expect(Object.values(r.ids)).toContain(id);
    expect(unitStatus(doc, mira.id)).toEqual({ edited: [], missing: [] });
  });

  it('takes only the old look: what the person put on the actor stays, named in the warnings', () => {
    const unit = miraUnit();
    const doc = stagedDoc();
    const mira = actorOf(doc, MIRA);
    const hat = doc.addObject({
      type: 'MESH',
      name: 'Hat',
      data: doc.addMesh('Hat', createCube()),
      parent: mira.id,
      parent_type: 'BONE',
      parent_bone: 'head',
    });
    const brim = doc.addObject({
      type: 'MESH',
      name: 'Brim',
      data: doc.addMesh('Brim', createCube()),
      parent: hat,
    });
    const r = insertUnit(doc, unit, { ...pin(), key: `cast:${MIRA}`, replace: mira.id });
    expect(doc.getObject(hat)).toMatchObject({ parent: mira.id, parent_type: 'BONE', parent_bone: 'head' });
    expect(doc.getObject(brim)?.parent).toBe(hat);
    expect(r.warnings).toEqual(["keeps 'Hat', which is not part of the look the library figure replaces"]);
    expect(actorParts(doc, mira.id).size).toBe(21);
    expect(unitStatus(doc, mira.id)).toEqual({ edited: [], missing: [] });
  });

  it('warns of bones the scene animates that the library rig lacks, and refuses another object type', () => {
    const src = stagedDoc();
    const dog = unitFrom(src, { kind: 'figure', actor: actorOf(src, PIP).id }).unit;
    const doc = stagedDoc();
    const mira = actorOf(doc, MIRA);
    applyPose(doc, mira.id, 'wave', { frame: 12 });
    const r = insertUnit(doc, dog, { ...pin(), key: `cast:${MIRA}`, replace: mira.id });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes("'upper_arm.R'"))).toBe(true);
    expect(r.warnings[0]).toMatch(
      /^the library figure has no bone '.+' that the scene's animation, holds or attachments use$/,
    );
    const [bench] = dress(doc, [['park_bench', 1, 1]]);
    expect(code(() => insertUnit(doc, dog, { ...pin(), key: 'cast:z', replace: bench }))).toBe(
      'UNIT_KIND_MISMATCH',
    );
    expect(code(() => insertUnit(doc, dog, { ...pin(), key: 'cast:z', replace: mira.id }))).toBe(
      'UNIT_INSTANCE_EXISTS',
    );
  });
});

describe('a set unit', () => {
  it('is inserted under its made root with the scene props the caller gives', () => {
    const src = stagedDoc();
    dress(src);
    const { unit } = unitFrom(src, { kind: 'set', name: 'Meadow' });
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, unit, {
      ...pin(),
      key: 'set',
      rootProps: { desk_role: 'set', desk_rideo_clip: 'clp_x' },
    });
    expect(r.root).toBe('SIqO3S2CV5o0gCvB');
    const root = doc.getObject(r.root)!;
    expect(root).toMatchObject({ type: 'EMPTY', parent: null, location: [0, 0, 0] });
    expect(root.custom_props).toMatchObject({
      desk_role: 'set',
      desk_rideo_clip: 'clp_x',
      unit_kind: 'set',
      unit_key: 'set',
    });
    expect(doc.childIds(r.root).length).toBeGreaterThan(3);
    expect(listUnits(doc)[0].binding).toEqual({ set: true });
    expect(unitStatus(doc, r.root)).toEqual({ edited: [], missing: [] });
  });
});

describe('a slot an instance was taken out of', () => {
  it('removeObjectTrees takes all of the instance: no id it derives is left, and it goes back in', () => {
    const unit = miraUnit();
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    removeObjectTrees(doc, [r.root]);
    expect(held(doc, r.ids)).toEqual([]);
    expect(doc.listObjects()).toHaveLength(0);
    const again = insertUnit(doc, unit, { ...pin(2), key: 'cast:a' });
    expect(again.ids).toEqual(r.ids);
    expect(unitStatus(doc, again.root)).toEqual({ edited: [], missing: [] });
  });

  it('removeObjectTrees keeps a datablock of the instance that something left in the scene uses', () => {
    const unit = miraUnit();
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    const mat = Object.entries(r.ids).find(([pk]) => kindOf(pk) === 'materials')![1];
    const cube = doc.addObject({
      type: 'MESH',
      data: doc.addMesh('Cube', createCube()),
      material_slots: [mat],
    });
    removeObjectTrees(doc, [r.root]);
    expect(held(doc, r.ids)).toEqual([`materials:${mat}`]);
    expect(doc.getObject(cube)?.material_slots).toEqual([mat]);
    // the slot takes the unit again in the next generation of its ids; the material stays the cube's
    const again = insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    expect(again.generation).toBe(1);
    expect(again.root).toBe(r.root);
    expect(unitStatus(doc, again.root)).toEqual({ edited: [], missing: [] });
    expect(doc.getObject(cube)?.material_slots).toEqual([mat]);
    expect(doc.getMaterial(mat)).not.toBeNull();
  });

  it('what an older removal left at the ids the slot derives is deleted for the unit; one in use moves it on a generation', () => {
    const unit = miraUnit();
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    // objects only, as the desk took instances out before: their materials stayed behind
    doc.removeObjects(
      Object.entries(r.ids)
        .filter(([pk]) => kindOf(pk) === 'objects')
        .map(([, id]) => id),
    );
    const left = held(doc, r.ids);
    expect(left.length).toBeGreaterThan(0);
    const used = SceneDoc.fromUpdate(doc.encodeState());
    const mat = left.find((k) => k.startsWith('materials:'))!.slice('materials:'.length);
    const cube = used.addObject({
      type: 'MESH',
      data: used.addMesh('Cube', createCube()),
      material_slots: [mat],
    });
    const moved = insertUnit(used, unit, { ...pin(), key: 'cast:a' });
    expect(moved.generation).toBe(1);
    // the parts left at generation 0 that nothing uses stay where they are: generation 1 is all new
    for (const k of left) expect(used.has(...(k.split(':') as [DatablockKind, string]))).toBe(true);
    expect(used.getObject(cube)?.material_slots).toEqual([mat]);
    const again = insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    expect(again.ids).toEqual(r.ids);
    expect(unitStatus(doc, again.root)).toEqual({ edited: [], missing: [] });
  });

  it('a figure made local and restyled from the same slot frees its own data for the unit', () => {
    const unit = miraUnit();
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    makeLocal(doc, r.root);
    const again = insertUnit(doc, unit, { ...pin(2), key: 'cast:a', replace: r.root });
    expect(again.ids).toEqual(r.ids);
    expect(held(doc, again.ids)).toHaveLength(Object.keys(r.ids).length);
    expect(unitStatus(doc, again.root)).toEqual({ edited: [], missing: [] });
  });
});

describe('a slot whose earlier instance left a part the scene keeps (generations of its ids)', () => {
  /** The kite prop unit, made once from a staged scene. */
  function kiteUnit(): UnitPayload {
    const src = stagedDoc();
    return unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id, name: 'Red kite' }).unit;
  }
  const key = `el:${KITE}`;
  /** A kite inserted and taken out again, its first material kept by a cube of the person's. */
  function leftMaterial(unit: UnitPayload): { doc: SceneDoc; first: Record<string, string>; mat: string } {
    const doc = SceneDoc.create({ empty: true });
    const first = insertUnit(doc, unit, { ...pin(), key }).ids;
    const mat = Object.entries(first).find(([pk]) => kindOf(pk) === 'materials')![1];
    doc.addObject({
      type: 'MESH',
      name: 'Mine',
      data: doc.addMesh('Mine', createCube()),
      material_slots: [mat],
    });
    removeObjectTrees(doc, [deriveUnitId(key, UNIT_ROOT)]);
    return { doc, first, mat };
  }

  it('derives the parts in the first generation whose ids are all free; the root keeps its id', () => {
    const unit = kiteUnit();
    const { doc, first, mat } = leftMaterial(unit);
    const r = insertUnit(doc, unit, { ...pin(), key });
    expect(r.generation).toBe(1);
    for (const [pk, id] of Object.entries(r.ids)) {
      const src = pk.slice(pk.indexOf(':') + 1);
      expect(id).toBe(src === UNIT_ROOT ? deriveUnitId(key, UNIT_ROOT) : derivePartId(key, src, 1));
      if (src !== UNIT_ROOT) expect(id).not.toBe(first[pk]);
    }
    expect(derivePartId(key, 'abc', 0)).toBe(deriveUnitId(key, 'abc'));
    expect(derivePartId(key, UNIT_ROOT, 3)).toBe(deriveUnitId(key, UNIT_ROOT));
    expect(doc.getObject(r.root)?.custom_props.unit_gen).toBe(1);
    expect(readInstance(doc, r.root)?.generation).toBe(1);
    expect(unitStatus(doc, r.root)).toEqual({ edited: [], missing: [] });
    expect(doc.getMaterial(mat)?.name).toBeTruthy();
    // generation 0 writes no unit_gen at all (the provenance of every instance before is as it was)
    const plain = SceneDoc.create({ empty: true });
    const p = insertUnit(plain, unit, { ...pin(), key });
    expect(p.generation).toBe(0);
    expect(plain.getObject(p.root)?.custom_props).not.toHaveProperty('unit_gen');
    expect(readInstance(plain, p.root)?.generation).toBe(0);
  });

  it('moves on a generation for an object the person moved out from under the instance', () => {
    const unit = kiteUnit();
    const doc = SceneDoc.create({ empty: true });
    const first = insertUnit(doc, unit, { ...pin(), key });
    const part = Object.entries(first.ids).find(
      ([pk, id]) => kindOf(pk) === 'objects' && id !== first.root,
    )![1];
    doc.setParent(part, null, true);
    removeObjectTrees(doc, [first.root]);
    expect(doc.has('objects', part)).toBe(true);
    const r = insertUnit(doc, unit, { ...pin(), key });
    expect(r.generation).toBe(1);
    expect(Object.values(r.ids)).not.toContain(part);
    expect(doc.has('objects', part)).toBe(true);
  });

  it('two replicas move on to the same generation: the same ids, merged without doubling', () => {
    const unit = kiteUnit();
    const { doc } = leftMaterial(unit);
    const a = SceneDoc.fromUpdate(doc.encodeState());
    const b = SceneDoc.fromUpdate(doc.encodeState());
    const ra = insertUnit(a, unit, { ...pin(), key });
    const rb = insertUnit(b, unit, { ...pin(), key });
    expect(rb.ids).toEqual(ra.ids);
    expect(rb.generation).toBe(1);
    const count = a.listObjects().length;
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    expect(a.listObjects()).toHaveLength(count);
    expect(listUnits(a)).toHaveLength(1);
    expect(unitStatus(a, ra.root)).toEqual({ edited: [], missing: [] });
  });

  it('a later version adds its new parts in the generation, or the next one whose id is free', () => {
    const unit = kiteUnit();
    const { doc } = leftMaterial(unit);
    const r = insertUnit(doc, unit, { ...pin(), key });
    const extra = (body: UnitBody, src: string) => {
      const mats = body.blocks.materials!;
      mats[src] = { ...Object.values(mats)[0], name: src };
    };
    const v2 = editedUnit(unit, (b) => extra(b, 'added1'));
    // something of the person's holds the id 'added1' would take in generation 1
    const mine = doc.addMaterial({ name: 'Theirs' }, derivePartId(key, 'added1', 1));
    doc.addObject({
      type: 'MESH',
      name: 'Theirs',
      data: doc.addMesh('T', createCube()),
      material_slots: [mine],
    });
    const rep = updateUnit(doc, r.root, v2, pin(2, 'c'.repeat(64)));
    expect(rep.added.map((p) => [p.src, p.id])).toEqual([['added1', derivePartId(key, 'added1', 2)]]);
    expect(rep.warnings).toEqual([]);
    expect(readInstance(doc, r.root)?.generation).toBe(1);
    expect(doc.getMaterial(mine)?.name).toBe('Theirs');
    const v3 = editedUnit(v2, (b) => extra(b, 'added2'));
    const rep3 = updateUnit(doc, r.root, v3, pin(3, 'd'.repeat(64)));
    expect(rep3.added.map((p) => [p.src, p.id])).toEqual([['added2', derivePartId(key, 'added2', 1)]]);
    expect(unitStatus(doc, r.root)).toEqual({ edited: [], missing: [] });
  });

  it('a version saved from the instance keeps its generation through adoption; Make local drops it', () => {
    const unit = kiteUnit();
    const { doc } = leftMaterial(unit);
    const r = insertUnit(doc, unit, { ...pin(), key });
    const ex = extractUnit(doc, { kind: 'prop', root: r.root, name: 'Red kite' }, { deskVersion: 'test' });
    expect(ex.link.generation).toBe(1);
    expect(Object.fromEntries(Object.entries(ex.link.parts).map(([pk, p]) => [pk, p.sceneId]))).toEqual(
      r.ids,
    );
    makeLocal(doc, r.root);
    expect(doc.getObject(r.root)?.custom_props).not.toHaveProperty('unit_gen');
    const adopted = adoptUnit(doc, ex.link, pin(2, ex.sha256));
    expect(readInstance(doc, adopted.root)?.generation).toBe(1);
    expect(unitStatus(doc, adopted.root)).toEqual({ edited: [], missing: [] });
    // a plan of a generation the desk does not make is not one extractUnit made
    expect(code(() => adoptUnit(doc, { ...ex.link, generation: -1 }, pin(3, ex.sha256)))).toBe(
      'UNIT_BAD_SPEC',
    );
  });
});

describe("a figure's body is the actor its header describes", () => {
  /** Mira's unit file with its body changed by `edit`, written as given (encodeUnit would refuse it). */
  function crafted(edit: (body: UnitBody) => void): Uint8Array {
    const unit = miraUnit();
    const body = structuredClone(unit.body);
    edit(body);
    const b = encodeUnitBody(body);
    const header = {
      ...unit.header,
      counts: { ...unit.header.counts, blobBytes: b.blobBytes },
      digest: sha256Hex(b.bytes),
      bodyBytes: b.bytes.length,
    };
    return writeContainer({
      magic: UNIT_MAGIC,
      version: 1,
      codec: 'gzip',
      header: new TextEncoder().encode(JSON.stringify(header)),
      payload: gzipDeterministic(b.bytes),
    });
  }
  const rootProps = (b: UnitBody) => b.blocks.objects![UNIT_ROOT].custom_props as Record<string, unknown>;

  it('decodes as extracted; a root that is no actor, of another kind or height, or another rig is UNIT_BAD_RECORD', () => {
    expect(code(() => decodeUnit(crafted(() => {})))).toBe('no error');
    expect(code(() => decodeUnit(crafted((b) => void (rootProps(b).desk_role = 'prop'))))).toBe(
      'UNIT_BAD_RECORD',
    );
    expect(code(() => decodeUnit(crafted((b) => void (rootProps(b).desk_kind = 'dog'))))).toBe(
      'UNIT_BAD_RECORD',
    );
    const taller = (b: UnitBody) =>
      void (rootProps(b).desk_height_m = Number(rootProps(b).desk_height_m) + 0.01);
    expect(code(() => decodeUnit(crafted(taller)))).toBe('UNIT_BAD_RECORD');
    const renamed = (b: UnitBody) => {
      const arm = Object.values(b.blocks.armatures!)[0];
      (arm.bones as { name: string }[])[3].name = 'renamed';
    };
    expect(code(() => decodeUnit(crafted(renamed)))).toBe('UNIT_BAD_RECORD');
  });
});

describe("a unit whose records carry the scene's props", () => {
  it('inserts without them: a part stamped unit_* is no second instance, and nothing is left after Make local', () => {
    const src = stagedDoc();
    const { unit } = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id });
    const body = structuredClone(unit.body);
    const part = Object.keys(body.blocks.objects!).find((k) => k !== UNIT_ROOT)!;
    body.blocks.objects![part].custom_props = {
      ...(body.blocks.objects![part].custom_props as object),
      unit_ref: 'lib:fake',
      unit_version: 1,
      unit_key: 'el:fake',
      desk_element_id: 'ele_0123456789fake',
    };
    const crafted = decodeUnit(encodeUnit(body, headerInput(unit.header)));
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, crafted, { ...pin(), key: `el:${KITE}` });
    expect(listUnits(doc).map((i) => i.root)).toEqual([r.root]);
    expect(doc.getObject(r.ids[`objects:${part}`])?.custom_props).not.toHaveProperty('unit_ref');
    expect(doc.getObject(r.ids[`objects:${part}`])?.custom_props).not.toHaveProperty('desk_element_id');
    makeLocal(doc, r.root);
    expect(docHasUnitInstances(doc)).toBe(false);
  });
});

describe('an instance outside the editor', () => {
  it("leaves its part table out of glTF node extras: the root's extras say how many parts it has", () => {
    const src = stagedDoc();
    const kite = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id }).unit;
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, kite, { ...pin(), key: `el:${KITE}` });
    const parts = readInstance(doc, r.root)!.parts.size;
    expect(parts).toBe(19);
    const json = JSON.parse(new TextDecoder().decode(exportScene(doc, 'gltf').data));
    const node = json.nodes.find((n: { name: string }) => n.name === doc.getObject(r.root)!.name);
    expect(node.extras).not.toHaveProperty('unit_parts');
    expect(node.extras).not.toHaveProperty('unit_drivers');
    expect(node.extras).toMatchObject({ unit_ref: pin().ref, unit_version: 1, unit_parts_count: parts });
  });

  it('keeps every other prop as its own property, one named __proto__ too', () => {
    const props = JSON.parse('{"__proto__":"x","unit_parts":"{\\"a\\":\\"b\\"}","note":"n"}') as Record<
      string,
      string
    >;
    const out = exportedCustomProps(props);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'note', 'unit_parts_count']);
    expect(out.unit_parts_count).toBe(1);
  });
});
