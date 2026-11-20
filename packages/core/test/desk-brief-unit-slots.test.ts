import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import {
  briefChanges,
  pinsWanted,
  stageBrief,
  stateUnitRows,
  unitSourceOf,
  updateFromBrief,
  type BriefUnitPin,
  type GivenUnit,
  type SceneBrief,
  type StageBriefReport,
  type UnitSource,
} from '../src/desk/brief';
import { BRIEF_RECORD_KEY, readBriefRecord } from '../src/desk/brief/record';
import { slotFailed } from '../src/desk/brief/stage';
import type { SlotUnit } from '../src/desk/brief/units';
import { sha256Hex } from '../src/desk/container';
import { getShots } from '../src/desk/shots';
import {
  MAX_UNIT_GENERATION,
  UNIT_ROOT,
  derivePartId,
  deriveUnitId,
  encodeUnit,
  listUnits,
  readInstance,
  unitOf,
  unitStatus,
  type UnitPayload,
} from '../src/desk/units';
import { createCube } from '../src/mesh/primitives';
import {
  KITE,
  MIRA,
  actorOf,
  editedUnit,
  headerInput,
  openBrief,
  prop,
  propOf,
  stagedDoc,
  unitFrom,
} from './desk-units-helpers';

/*
 * A slot always takes its unit again (desk/units ids.ts generations): an instance taken out of a
 * slot can leave a part the scene still uses (its material on an object of the person's, an object
 * of it moved out from under it), and the unit placed there again derives its parts in the next
 * generation of the slot's ids. Each slot goes in on its own: a unit the scene is in the way of (an
 * object of the person's at the id its root takes) does not sink the others, the shots or the rest
 * of an update; its slot keeps what it has, staged from the words, and waits 'unavailable' for the
 * next open or update.
 */

/** A library version: its pin and the file the host sends for it. */
interface Lib {
  pin: BriefUnitPin;
  given: GivenUnit;
}

function lib(ref: string, version: number, data: Uint8Array): Lib {
  const sha256 = sha256Hex(data);
  return { pin: { ref, version, sha256 }, given: { ref, version, sha256, data } };
}

interface Library {
  set: Lib;
  kite: Lib;
  mira: Lib;
  units: { set: UnitPayload; kite: UnitPayload; mira: UnitPayload };
}

let made: Library | null = null;
/** The units made from open.json staged (once). */
function library(): Library {
  if (made) return made;
  const src = stagedDoc();
  const set = unitFrom(src, { kind: 'set', name: 'Meadow' });
  const kite = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id, name: 'Red kite' });
  const mira = unitFrom(src, { kind: 'figure', actor: actorOf(src, MIRA).id, name: 'Mira' });
  src.destroy();
  made = {
    set: lib('lib_0123456789mead', 1, set.ex.data),
    kite: lib('lib_0123456789kite', 1, kite.ex.data),
    mira: lib('lib_0123456789mira', 1, mira.ex.data),
    units: { set: set.unit, kite: kite.unit, mira: mira.unit },
  };
  return made;
}

/** `b` with pins set (a Lib) or removed (null) on the set, cast members and elements. */
function withPins(
  b: SceneBrief,
  p: { set?: Lib | null; cast?: Record<string, Lib | null>; el?: Record<string, Lib | null> },
): SceneBrief {
  const out = structuredClone(b);
  if (p.set) out.set.unit = p.set.pin;
  else if (p.set === null) delete out.set.unit;
  for (const [id, l] of Object.entries(p.cast ?? {})) {
    const c = out.cast.find((x) => x.id === id)!;
    if (l) c.unit = l.pin;
    else delete c.unit;
  }
  for (const [id, l] of Object.entries(p.el ?? {})) {
    const e = out.elements.find((x) => x.id === id)!;
    if (l) e.unit = l.pin;
    else delete e.unit;
  }
  return out;
}

const source = (...libs: Lib[]): UnitSource => unitSourceOf(libs.map((l) => l.given));
const fresh = () => SceneDoc.create({ empty: true });

function staged(b: SceneBrief, units?: UnitSource): { doc: SceneDoc; r: StageBriefReport } {
  const doc = fresh();
  const r = stageBrief(doc, b, units ? { units } : {});
  return { doc, r };
}

/** A report's unit rows as 'slot staged why'. */
const rowsOf = (r: StageBriefReport) =>
  r.units.map((x) => `${x.slot} ${x.staged}${x.why ? ` ${x.why}` : ''}`);
const libraryWarnings = (r: StageBriefReport) => r.warnings.filter((w) => /library/.test(w));

/** Everything of the staging but the brief record: objects, curves, materials, scene, world and render settings. */
function staging(doc: SceneDoc): string {
  const scene = Object.fromEntries([...doc.map('scene').entries()].filter(([k]) => k !== BRIEF_RECORD_KEY));
  return JSON.stringify({
    objects: doc.listObjects(),
    curves: doc.listFCurves(),
    materials: doc.listMaterials(),
    scene,
    world: doc.getWorld(),
    render: doc.getRender(),
  });
}

/** The pins the record refuses, as 'slot ref@version'. */
const refusals = (doc: SceneDoc) =>
  stateUnitRows(doc)
    .filter((x) => x.staged === 'refused')
    .map((x) => `${x.slot} ${x.ref}@${x.version}`);

/**
 * Updates `doc` to `b` and checks that briefChanges (given the same units) was null exactly when
 * the update changed nothing of the staging and refused no pin the record did not refuse already.
 */
function update(
  doc: SceneDoc,
  b: SceneBrief,
  units?: UnitSource,
): { r: StageBriefReport; changes: ReturnType<typeof briefChanges> } {
  const o = units ? { units } : {};
  const changes = briefChanges(doc, b, o);
  const before = staging(doc);
  const refused = new Set(refusals(doc));
  const r = updateFromBrief(doc, b, o);
  const acted = staging(doc) !== before || refusals(doc).some((x) => !refused.has(x));
  expect(changes === null, `briefChanges ${JSON.stringify(changes)}`).toBe(!acted);
  return { r, changes };
}

describe('a slot whose earlier instance left a part the scene still uses', () => {
  type Kind = 'set' | 'prop' | 'figure';
  const slotOf = (kind: Kind) => (kind === 'set' ? 'set' : kind === 'prop' ? `el:${KITE}` : `cast:${MIRA}`);
  const pinOf = (kind: Kind, l: Lib | null) =>
    kind === 'set' ? { set: l } : kind === 'prop' ? { el: { [KITE]: l } } : { cast: { [MIRA]: l } };

  /** The scene id of the first material the slot's instance holds. */
  const materialOf = (doc: SceneDoc, key: string) => {
    const inst = readInstance(doc, listUnits(doc).find((i) => i.key === key)!.root)!;
    return [...inst.parts].find(([pk]) => pk.startsWith('materials:'))![1].id;
  };
  /** A mesh of the person's own (no unit's) wearing material `mat`. */
  const mine = (doc: SceneDoc, mat: string) =>
    doc.addObject({
      type: 'MESH',
      name: 'Mine',
      data: doc.addMesh('Mine', createCube()),
      material_slots: [mat],
    });

  it.each(['set', 'prop', 'figure'] as const)(
    'places a %s again when the person kept a material of the instance taken out (its ids salted)',
    (kind) => {
      const L = library();
      const l = kind === 'set' ? L.set : kind === 'prop' ? L.kite : L.mira;
      const key = slotOf(kind);
      const b = withPins(openBrief(), pinOf(kind, l));
      const { doc } = staged(b, source(l));
      const mat = materialOf(doc, key);
      const cube = mine(doc, mat);
      update(doc, withPins(openBrief(), pinOf(kind, null)));
      expect(listUnits(doc)).toEqual([]);
      expect(doc.has('materials', mat)).toBe(true);
      // pinned again: placed beside what the person kept, which stays theirs
      const back = update(doc, b, source(l));
      expect(rowsOf(back.r)).toContain(`${key} unit`);
      const inst = listUnits(doc);
      expect(inst.map((i) => [i.key, i.ref, i.version])).toEqual([[key, l.pin.ref, 1]]);
      expect(unitStatus(doc, inst[0].root)).toEqual({ edited: [], missing: [] });
      expect(readInstance(doc, inst[0].root)!.generation).toBe(1);
      expect(materialOf(doc, key)).not.toBe(mat);
      expect(doc.getObject(cube)?.material_slots).toEqual([mat]);
      expect(unitOf(doc, mat)).toBeNull();
      // and once more: taken out and back again, a generation further on
      update(doc, withPins(openBrief(), pinOf(kind, null)));
      update(doc, b, source(l));
      expect(listUnits(doc).map((i) => i.key)).toEqual([key]);
      expect(readInstance(doc, listUnits(doc)[0].root)!.generation).toBe(1);
    },
  );

  it('places a prop again when the person moved one of its parts out from under it', () => {
    const L = library();
    const key = slotOf('prop');
    const b = withPins(openBrief(), pinOf('prop', L.kite));
    const { doc } = staged(b, source(L.kite));
    const root = propOf(doc, KITE).id;
    const part = [...readInstance(doc, root)!.parts].find(
      ([pk, p]) => pk.startsWith('objects:') && p.id !== root && doc.getObject(p.id)?.type === 'MESH',
    )![1].id;
    doc.setParent(part, null, true);
    update(doc, withPins(openBrief(), pinOf('prop', null)));
    expect(listUnits(doc)).toEqual([]);
    expect(doc.has('objects', part)).toBe(true);
    const back = update(doc, b, source(L.kite));
    expect(rowsOf(back.r)).toContain(`${key} unit`);
    const inst = listUnits(doc);
    expect(inst.map((i) => i.key)).toEqual([key]);
    expect(unitStatus(doc, inst[0].root)).toEqual({ edited: [], missing: [] });
    expect(doc.has('objects', part)).toBe(true);
    expect(unitOf(doc, part)).toBeNull();
  });

  it('places a prop again beside a set pinned anew in the same update', () => {
    const L = library();
    const b = withPins(openBrief(), pinOf('prop', L.kite));
    const { doc } = staged(b, source(L.kite));
    const root = propOf(doc, KITE).id;
    const part = [...readInstance(doc, root)!.parts].find(
      ([pk, p]) => pk.startsWith('objects:') && p.id !== root && doc.getObject(p.id)?.type === 'MESH',
    )![1].id;
    doc.setParent(part, null, true);
    update(doc, withPins(openBrief(), pinOf('prop', null)));
    const both = withPins(openBrief(), { set: L.set, el: { [KITE]: L.kite } });
    const u = update(doc, both, source(L.set, L.kite));
    expect(rowsOf(u.r)).toEqual(['set unit', `el:${KITE} unit`]);
    expect(
      listUnits(doc)
        .map((i) => i.key)
        .sort(),
    ).toEqual([`el:${KITE}`, 'set']);
  });

  it('derives the same salted ids in two replicas of the scene', () => {
    const L = library();
    const b = withPins(openBrief(), pinOf('prop', L.kite));
    const { doc } = staged(b, source(L.kite));
    mine(doc, materialOf(doc, slotOf('prop')));
    update(doc, withPins(openBrief(), pinOf('prop', null)));
    const other = SceneDoc.fromUpdate(doc.encodeState());
    update(doc, b, source(L.kite));
    updateFromBrief(other, b, { units: source(L.kite) });
    const tableOf = (d: SceneDoc) => readInstance(d, propOf(d, KITE).id)!.parts;
    expect([...tableOf(other)]).toEqual([...tableOf(doc)]);
    // merged, no part is doubled (the kite's string the desk flies it by is each replica's own)
    const root = propOf(doc, KITE).id;
    const parts = () => doc.listObjects().filter((o) => unitOf(doc, o.id) === root).length;
    const before = parts();
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(other.ydoc));
    expect(parts()).toBe(before);
    expect(listUnits(doc)).toMatchObject([{ root, parts: tableOf(doc).size, present: tableOf(doc).size }]);
    expect(unitStatus(doc, root)).toEqual({ edited: [], missing: [] });
  });
});

describe('a unit the scene is in the way of (each slot on its own)', () => {
  /** A document holding an object of the person's at the id the root of slot `key`'s instance takes. */
  const squatted = (key: string) => {
    const doc = fresh();
    doc.addObject({ type: 'EMPTY', name: 'Squatter' }, deriveUnitId(key, UNIT_ROOT));
    return doc;
  };

  it('staging: a set whose root id is taken is pending (unavailable) beside a kite that is placed', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set, el: { [KITE]: L.kite } });
    const doc = squatted('set');
    let r: StageBriefReport | null = null;
    expect(() => (r = stageBrief(doc, b, { units: source(L.set, L.kite) }))).not.toThrow();
    expect(rowsOf(r!)).toEqual(['set words unavailable', `el:${KITE} unit`]);
    expect(listUnits(doc).map((i) => i.key)).toEqual([`el:${KITE}`]);
    expect(readBriefRecord(doc)!.setUnit).toMatchObject({ staged: 'pending', why: 'unavailable' });
    expect(stateUnitRows(doc).find((x) => x.slot === 'set')).toMatchObject({
      staged: 'pending',
      why: 'unavailable',
    });
    // the set staged from the words stands in, and the warning names what is in the way
    expect(
      doc.listObjects().some((o) => prop(o, 'desk_role') === 'set' && prop(o, 'desk_label') === 'ground'),
    ).toBe(true);
    expect(libraryWarnings(r!).join('\n')).toMatch(/set.*could not be used this time.*taken/);
    // a good file is tried again: once the way is clear, the next update places the set
    expect(pinsWanted(doc, b).map((p) => p.ref)).toEqual([L.set.pin.ref]);
    doc.removeObjects([deriveUnitId('set', UNIT_ROOT)]);
    const u = update(doc, b, source(L.set, L.kite));
    expect(rowsOf(u.r)).toEqual(['set unit', `el:${KITE} unit`]);
    expect(readBriefRecord(doc)!.setUnit).toMatchObject({ staged: 'unit' });
  });

  it.each(['prop', 'figure'] as const)(
    'staging: a %s whose root id is taken is pending (unavailable); the other slots and the shots stage',
    (kind) => {
      const L = library();
      const b = withPins(openBrief(), {
        set: L.set,
        ...(kind === 'prop' ? { el: { [KITE]: L.kite } } : { cast: { [MIRA]: L.mira } }),
      });
      const key = kind === 'prop' ? `el:${KITE}` : `cast:${MIRA}`;
      const doc = squatted(key);
      const r = stageBrief(doc, b, { units: source(L.set, L.kite, L.mira) });
      expect(rowsOf(r)).toEqual(['set unit', `${key} words unavailable`]);
      expect(listUnits(doc).map((i) => i.key)).toEqual(['set']);
      expect(r.shots).toHaveLength(b.shots.length);
      // the words' prop or mannequin stands in
      if (kind === 'prop') expect(readInstance(doc, propOf(doc, KITE).id)).toBeNull();
      else {
        expect(readInstance(doc, actorOf(doc, MIRA).id)).toBeNull();
        expect(prop(actorOf(doc, MIRA), 'desk_kind')).toBe('child');
      }
      expect(libraryWarnings(r).join('\n')).toMatch(/could not be used this time.*taken/);
      // once the way is clear, the next update places it
      doc.removeObjects([deriveUnitId(key, UNIT_ROOT)]);
      const u = update(doc, b, source(L.set, L.kite, L.mira));
      expect(rowsOf(u.r)).toEqual(['set unit', `${key} unit`]);
    },
  );

  /** Objects of the person's at the ids part `src` of slot `key` takes in every generation. */
  const blockAll = (doc: SceneDoc, key: string, src: string) => {
    for (let g = 0; g <= MAX_UNIT_GENERATION; g++)
      doc.addObject({ type: 'EMPTY', name: `In the way ${g}` }, derivePartId(key, src, g));
  };
  /** A part of `u` that is an object (not its root): its source id. */
  const objectPart = (u: UnitPayload) =>
    Object.keys(u.body.blocks.objects!).find((src) => src !== UNIT_ROOT)!;

  it.each(['set', 'prop', 'figure'] as const)(
    'Update shots: a %s that does not go in leaves the rest of the update applied',
    (kind) => {
      const L = library();
      const { doc } = staged(openBrief());
      const key = kind === 'set' ? 'set' : kind === 'prop' ? `el:${KITE}` : `cast:${MIRA}`;
      // in the way: an object of the person's at the set root's id; for a prop or figure, which
      // take the place of what the words built (its id kept), at every generation of a part's id
      if (kind === 'set') doc.addObject({ type: 'EMPTY', name: 'Squatter' }, deriveUnitId('set', UNIT_ROOT));
      else blockAll(doc, key, objectPart(kind === 'prop' ? L.units.kite : L.units.mira));
      const b = withPins(
        openBrief(),
        kind === 'set'
          ? { set: L.set }
          : kind === 'prop'
            ? { el: { [KITE]: L.kite } }
            : { cast: { [MIRA]: L.mira } },
      );
      // and a shot the brief lengthens, which the update applies all the same
      b.shots[0].durationSec += 1;
      const words = doc
        .listObjects()
        .filter((o) => prop(o, 'desk_role') === 'set' || prop(o, 'desk_role') === 'landmark')
        .map((o) => o.id);
      const mira = actorOf(doc, MIRA).id;
      const look = doc.listObjects().filter((o) => prop(o, 'desk_actor') === mira).length;
      const frames = getShots(doc)[0].frame_end - getShots(doc)[0].frame_start + 1;
      let r: StageBriefReport | null = null;
      expect(() => (r = updateFromBrief(doc, b, { units: source(L.set, L.kite, L.mira) }))).not.toThrow();
      expect(r!.units).toEqual([expect.objectContaining({ slot: key, staged: 'words', why: 'unavailable' })]);
      expect(getShots(doc)[0].frame_end - getShots(doc)[0].frame_start + 1).toBe(frames + b.fps);
      expect(listUnits(doc)).toEqual([]);
      // what the slot held stays as it was: the words' set, the kite and Mira's mannequin
      if (kind === 'set') for (const id of words) expect(doc.has('objects', id)).toBe(true);
      if (kind === 'prop') expect(readInstance(doc, propOf(doc, KITE).id)).toBeNull();
      if (kind === 'figure') {
        expect(actorOf(doc, MIRA).id).toBe(mira);
        expect(doc.listObjects().filter((o) => prop(o, 'desk_actor') === mira)).toHaveLength(look);
      }
      expect(r!.warnings.join('\n')).toMatch(/could not be used this time.*taken/);
      const rec = readBriefRecord(doc)!;
      const pinned =
        kind === 'set'
          ? rec.setUnit
          : kind === 'prop'
            ? rec.elements.find((e) => e.id === KITE)!.unit
            : rec.cast.find((c) => c.id === MIRA)!.unit;
      expect(pinned).toMatchObject({ staged: 'pending', why: 'unavailable' });
    },
  );

  it('Update shots: a member it adds whose figure does not go in stands as a mannequin of its height', () => {
    const L = library();
    const first = openBrief();
    first.shots[0].castIds = first.shots[0].castIds.filter((id) => id !== MIRA);
    first.shots[0].layout = first.shots[0].layout.filter((e) => e.castId !== MIRA);
    for (const s of first.shots.slice(1)) {
      s.castIds = s.castIds.filter((id) => id !== MIRA);
      s.layout = s.layout.filter((e) => e.castId !== MIRA);
    }
    const { doc } = staged(first);
    expect(() => actorOf(doc, MIRA)).toThrow();
    doc.addObject({ type: 'EMPTY', name: 'Squatter' }, deriveUnitId(`cast:${MIRA}`, UNIT_ROOT));
    const b = withPins(openBrief(), { cast: { [MIRA]: L.mira } });
    let r: StageBriefReport | null = null;
    expect(() => (r = updateFromBrief(doc, b, { units: source(L.mira) }))).not.toThrow();
    expect(rowsOf(r!)).toEqual([`cast:${MIRA} words unavailable`]);
    const mira = actorOf(doc, MIRA);
    expect(readInstance(doc, mira.id)).toBeNull();
    expect(prop(mira, 'desk_kind')).toBe(L.units.mira.header.figure!.kind);
    expect(Number(prop(mira, 'desk_height_m'))).toBeCloseTo(L.units.mira.header.figure!.heightM, 6);
  });

  it('a slot the brief pins nothing in whose instance does not go says so', () => {
    const slot: SlotUnit = {
      slot: { castId: MIRA },
      key: `cast:${MIRA}`,
      kind: 'figure',
      name: 'Mira',
      pin: null,
      rec: null,
      inst: null,
      local: false,
      stageable: true,
      held: null,
      payload: null,
      problem: null,
      action: 'remove',
    };
    const done = new Set([slot.key]);
    expect(slotFailed(slot, new Error('the mannequin did not build'), done)).toEqual([
      "Mira's library figure could not be taken out this time (the mannequin did not build): it stays until the next update",
    ]);
    expect(done.has(slot.key)).toBe(false);
    expect(slot.action).toBe('none');
  });
});

describe("a later version whose root is another type of object than the instance's", () => {
  const key = `el:${KITE}`;
  /** Version `version` of the kite, its root an EMPTY or a MESH (wearing one of the kite's meshes). */
  function kiteRooted(type: 'EMPTY' | 'MESH', version: number): Lib {
    const L = library();
    const unit = editedUnit(L.units.kite, (body) => {
      const root = body.blocks.objects![UNIT_ROOT];
      root.type = type;
      if (type === 'EMPTY') delete root.data;
      else root.data = Object.keys(body.blocks.meshes!).sort()[0];
    });
    return lib(L.kite.pin.ref, version, encodeUnit(unit.body, headerInput(unit.header)));
  }
  /** How the update stages the kite's flight: its hold, its holder and what flies it. */
  const flight = (doc: SceneDoc, kite: string) => ({
    constraints: (doc.getObject(kite)!.constraints ?? []).map((c) => [c.type, c.target, c.subtarget]),
    heldBy: prop(doc.getObject(kite), 'desk_rideo_held_by'),
    tether: doc
      .listObjects()
      .filter((o) => prop(o, 'desk_string_to') === kite || prop(o, 'desk_tail_of') === kite).length,
  });

  it("Update shots puts the prop's new version in the old one's place in one undo step: the row reads unit at it", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    expect(v1.type).toBe('EMPTY');
    const parts = readInstance(doc, v1.id)!.parts.size;
    const before = flight(doc, v1.id);
    const subjects = getShots(doc).map((s) => s.subjects);
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const v2 = kiteRooted('MESH', 2);
    const b2 = withPins(openBrief(), { el: { [KITE]: v2 } });
    const u = update(doc, b2, source(v2));
    expect(rowsOf(u.r)).toEqual([`${key} unit`]);
    expect(u.r.units).toEqual([expect.objectContaining({ ref: v2.pin.ref, version: 2 })]);
    expect(u.r.warnings.join('\n')).not.toMatch(/cannot be used|could not be used/);
    expect(u.r.warnings).toContainEqual(
      expect.stringMatching(
        /: v2's root is a MESH and v1's an EMPTY, so v2 replaces v1, edits and all, instead of updating it$/,
      ),
    );
    // the kite is v2, as a placed v2 is: its root at the old one's id, nothing of v1 beside it, and
    // the shots, its hold and its flight find it
    const kite = propOf(doc, KITE);
    expect(kite.id).toBe(v1.id);
    expect(kite.type).toBe('MESH');
    expect(readInstance(doc, kite.id)).toMatchObject({ ref: v2.pin.ref, version: 2, sha256: v2.pin.sha256 });
    expect(unitStatus(doc, kite.id)).toEqual({ edited: [], missing: [] });
    expect(listUnits(doc)).toMatchObject([{ key, version: 2, parts, present: parts }]);
    expect(doc.listObjects().filter((o) => prop(o, 'desk_element_id') === KITE)).toHaveLength(1);
    expect(getShots(doc).map((s) => s.subjects)).toEqual(subjects);
    expect(flight(doc, kite.id)).toEqual(before);
    expect(stateUnitRows(doc)).toEqual([
      { slot: key, ref: v2.pin.ref, version: 2, sha256: v2.pin.sha256, staged: 'unit', local: false },
    ]);
    expect(briefChanges(doc, b2, { units: source(v2) })).toBeNull();
    // one undo step: v1 again, as it was
    undo.undo();
    expect(propOf(doc, KITE).type).toBe('EMPTY');
    expect(readInstance(doc, v1.id)).toMatchObject({ version: 1, sha256: L.kite.pin.sha256 });
    expect(flight(doc, v1.id)).toEqual(before);
    undo.redo();
    expect(readInstance(doc, v1.id)).toMatchObject({ version: 2 });
    // and a v3 whose root is an empty again takes v2's place the same way
    const v3 = kiteRooted('EMPTY', 3);
    const b3 = withPins(openBrief(), { el: { [KITE]: v3 } });
    const u3 = update(doc, b3, source(v3));
    expect(rowsOf(u3.r)).toEqual([`${key} unit`]);
    expect(u3.r.warnings).toContainEqual(
      expect.stringMatching(/: v3's root is an EMPTY and v2's a MESH, so v3 replaces v2/),
    );
    expect(propOf(doc, KITE)).toMatchObject({ id: v1.id, type: 'EMPTY' });
    expect(readInstance(doc, v1.id)).toMatchObject({ version: 3, sha256: v3.pin.sha256 });
    expect(stateUnitRows(doc)).toEqual([expect.objectContaining({ slot: key, version: 3, staged: 'unit' })]);
    expect(flight(doc, v1.id)).toEqual(before);
  });

  it('cannot differ for a set or a figure: every version roots a set in an empty and a figure in an armature', () => {
    const L = library();
    const set = structuredClone(L.units.set.body);
    set.blocks.objects![UNIT_ROOT].type = 'MESH';
    expect(() => encodeUnit(set, headerInput(L.units.set.header))).toThrow(/a set's root is an empty/);
    const figure = structuredClone(L.units.mira.body);
    figure.blocks.objects![UNIT_ROOT].type = 'EMPTY';
    expect(() => encodeUnit(figure, headerInput(L.units.mira.header))).toThrow(
      /a figure's root is an armature/,
    );
  });

  it('a set root the scene holds as another type of object waits as unavailable and is tried again', () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    const root = deriveUnitId('set', UNIT_ROOT);
    expect(readInstance(doc, root)).toMatchObject({ version: 1 });
    const edited = editedUnit(L.units.set, (body) => {
      const piece = Object.keys(body.blocks.objects!).find((src) => src !== UNIT_ROOT)!;
      const at = body.blocks.objects![piece].location as number[];
      body.blocks.objects![piece].location = [at[0] + 1, at[1], at[2]];
    });
    const v2 = lib(L.set.pin.ref, 2, encodeUnit(edited.body, headerInput(edited.header)));
    const b2 = withPins(openBrief(), { set: v2 });
    // no operator turns an empty into another type: a scene written by other means
    doc.transact(() => doc.updateObject(root, { type: 'MESH' }));
    let r: StageBriefReport | null = null;
    expect(() => (r = updateFromBrief(doc, b2, { units: source(v2) }))).not.toThrow();
    expect(rowsOf(r!)).toEqual(['set words unavailable']);
    // v1 stays, as the record says, and v2 is not refused: the next open or update tries it again
    expect(readInstance(doc, root)).toMatchObject({ version: 1 });
    expect(readBriefRecord(doc)!.setUnit).toMatchObject({ version: 1, staged: 'unit' });
    expect(r!.warnings.join('\n')).toMatch(
      /v2 could not be used this time \(the scene is in its way: the unit's root is an EMPTY, the instance's a MESH\): v1 stays/,
    );
    expect(pinsWanted(doc, b2).map((p) => p.ref)).toEqual([L.set.pin.ref]);
    expect(briefChanges(doc, b2, { units: source(v2) })).not.toBeNull();
    // once the scene's root is an empty again, the next update places v2
    doc.transact(() => doc.updateObject(root, { type: 'EMPTY' }));
    const again = update(doc, b2, source(v2));
    expect(rowsOf(again.r)).toEqual(['set unit']);
    expect(readInstance(doc, root)).toMatchObject({ version: 2 });
  });
});
