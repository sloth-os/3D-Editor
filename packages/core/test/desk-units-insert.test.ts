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
  deriveUnitId,
  insertUnit,
  listUnits,
  readInstance,
  unitStatus,
  type UnitPayload,
} from '../src/desk/units';
import { createCube } from '../src/mesh/primitives';
import { MIRA, PIP, actorOf, dress, pin, stagedDoc, unitFrom } from './desk-units-helpers';

/*
 * Inserting a decoded unit (desk/units/insert.ts): derived ids, names, placement, scene props, the
 * refusals, one undo step, a figure that works as an actor, two replicas inserting the same unit, and
 * a procedural actor replaced by a library figure.
 */

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

  it('refuses a second insert with the same key, a taken id, a bad key, a bad pin, a missing parent', () => {
    const unit = miraUnit();
    const doc = SceneDoc.create({ empty: true });
    insertUnit(doc, unit, { ...pin(), key: 'cast:a' });
    expect(code(() => insertUnit(doc, unit, { ...pin(), key: 'cast:a' }))).toBe('UNIT_INSTANCE_EXISTS');
    const seeded = SceneDoc.create({ empty: true });
    seeded.addObject({ type: 'EMPTY', name: 'In the way' }, deriveUnitId('cast:b', UNIT_ROOT));
    expect(code(() => insertUnit(seeded, unit, { ...pin(), key: 'cast:b' }))).toBe('UNIT_ID_TAKEN');
    const part = Object.keys(unit.body.blocks.meshes!)[0];
    const seeded2 = SceneDoc.create({ empty: true });
    seeded2.addMesh('x', createCube(), deriveUnitId('cast:c', part));
    expect(code(() => insertUnit(seeded2, unit, { ...pin(), key: 'cast:c' }))).toBe('UNIT_ID_TAKEN');
    expect(seeded2.listObjects()).toHaveLength(0);
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
