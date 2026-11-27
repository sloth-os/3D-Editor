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
import { FrameState } from '../src/eval/frame-state';
import { invert4, multiply4 } from '../src/math/mat4';
import type { Vec3 } from '../src/math/types';
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

/** Keys object `id`'s channel `path`[`index`] at frames 1, 25 and 50 (Bezier). */
function keyed(doc: SceneDoc, id: string, path: string, index: number, values: [number, number, number]) {
  doc.transact(() =>
    doc.setFCurve({
      target_type: 'object',
      target_id: id,
      path,
      index,
      keyframes: [1, 25, 50].map((frame, i) => ({ frame, value: values[i], interpolation: 'BEZIER' })),
      extrapolation: 'CONSTANT',
      mute: false,
    }),
  );
}
/** The frames keyed motion is compared at. */
const FRAMES = [1, 13, 25, 37, 50];

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
      // and a camera the person set by hand (keyed): a slot that does not go in changes no set, so
      // no camera is solved for one, nor warned of one
      keyed(doc, getShots(doc)[1].camera!, 'location', 0, [0, 0.5, 1]);
      const words = doc
        .listObjects()
        .filter((o) => prop(o, 'desk_role') === 'set' || prop(o, 'desk_role') === 'landmark')
        .map((o) => o.id);
      const mira = actorOf(doc, MIRA).id;
      const look = doc.listObjects().filter((o) => prop(o, 'desk_actor') === mira).length;
      const frames = getShots(doc)[0].frame_end - getShots(doc)[0].frame_start + 1;
      const set = readBriefRecord(doc)!.set;
      let r: StageBriefReport | null = null;
      expect(() => (r = updateFromBrief(doc, b, { units: source(L.set, L.kite, L.mira) }))).not.toThrow();
      expect(r!.units).toEqual([expect.objectContaining({ slot: key, staged: 'words', why: 'unavailable' })]);
      // a set that did not go in: its row names no object (the one in the way is not the set's
      // root), and the record keeps the set the scene has
      if (kind === 'set') {
        expect(r!.units[0]!.object).toBeNull();
        expect(readBriefRecord(doc)!.set).toBe(set);
      }
      expect(getShots(doc)[0].frame_end - getShots(doc)[0].frame_start + 1).toBe(frames + b.fps);
      // the lengthened shot only fits its move: no camera is solved, and none is warned of a set
      expect(r!.solved).toEqual([]);
      expect(r!.warnings.join('\n')).not.toMatch(/the set changed/);
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

  it.each(['keyed by hand', 'only hung'] as const)(
    'Update shots: a library prop pinned with no other change to it that does not go in leaves the prop as the desk has it (a camera %s under it)',
    (how) => {
      const L = library();
      const { doc } = staged(openBrief());
      const kite = propOf(doc, KITE).id;
      blockAll(doc, `el:${KITE}`, objectPart(L.units.kite));
      // the person edits one key of the kite's flight and hangs shot 2's camera under the kite
      const z = doc.listFCurves(kite).find((f) => f.path === 'location' && f.index === 2)!;
      doc.transact(() =>
        doc.setFCurve({
          ...z,
          keyframes: z.keyframes.map((k, i) => (i === 10 ? { ...k, value: k.value + 3 } : k)),
        }),
      );
      const cam = getShots(doc)[1].camera!;
      doc.setParent(cam, kite, true);
      if (how === 'keyed by hand') keyed(doc, cam, 'location', 0, [0, 0.5, 1]);
      const strings = doc
        .listObjects()
        .filter((o) => o.custom_props?.desk_string_to === kite)
        .map((o) => o.id);
      expect(strings).not.toEqual([]);
      const curves = JSON.stringify(doc.listFCurves(kite));
      // the brief pins the kite, and rewords a shot (an update without the pin acts as well)
      const b = withPins(openBrief(), { el: { [KITE]: L.kite } });
      b.shots[1].description = 'Close-up: Mira looks up at the red kite, smiling.';
      const r = updateFromBrief(doc, b, { units: source(L.kite) });
      expect(rowsOf(r)).toEqual([`el:${KITE} words unavailable`]);
      expect(r.warnings.join('\n')).toMatch(
        /Red kite's library prop .* could not be used this time .*: the prop from the words stands in/,
      );
      // the kite is as the desk had it: its keys (the person's edit with them), its string, and the
      // camera on it, neither taken off nor warned of
      expect(propOf(doc, KITE).id).toBe(kite);
      expect(JSON.stringify(doc.listFCurves(kite))).toBe(curves);
      expect(
        doc
          .listObjects()
          .filter((o) => o.custom_props?.desk_string_to === kite)
          .map((o) => o.id),
      ).toEqual(strings);
      expect(doc.getObject(cam)!.parent).toBe(kite);
      expect(r.solved).toEqual([]);
      expect(r.warnings.filter((w) => /set by hand|took it off/.test(w))).toEqual([]);
      expect(readBriefRecord(doc)!.elements.find((e) => e.id === KITE)!.unit).toMatchObject({
        staged: 'pending',
        why: 'unavailable',
      });
    },
  );

  it.each(['the words change it too', 'the desk removed it'] as const)(
    'Update shots: a library prop that does not go in is staged from the words when %s',
    (how) => {
      const L = library();
      const { doc } = staged(openBrief());
      const kite = propOf(doc, KITE).id;
      blockAll(doc, `el:${KITE}`, objectPart(L.units.kite));
      const z = doc.listFCurves(kite).find((f) => f.path === 'location' && f.index === 2)!;
      const edit = z.keyframes[10].value + 3;
      doc.transact(() =>
        doc.setFCurve({ ...z, keyframes: z.keyframes.map((k, i) => (i === 10 ? { ...k, value: edit } : k)) }),
      );
      const b = withPins(openBrief(), { el: { [KITE]: L.kite } });
      if (how === 'the words change it too') {
        const e = b.elements.find((x) => x.id === KITE)!;
        e.description = `${e.description} It has a long blue tail.`;
      } else doc.removeObjects([kite]);
      const r = updateFromBrief(doc, b, { units: source(L.kite) });
      expect(rowsOf(r)).toEqual([`el:${KITE} words unavailable`]);
      expect(r.warnings.join('\n')).toMatch(
        /Red kite's library prop .* could not be used this time .*: the prop from the words stands in/,
      );
      // the words' kite stands in, its flight keyed anew (the person's edit gone with the old keys)
      const now = propOf(doc, KITE).id;
      expect(readInstance(doc, now)).toBeNull();
      const after = doc.listFCurves(now).find((f) => f.path === 'location' && f.index === 2)!;
      expect(after.keyframes[10]?.value).not.toBe(edit);
    },
  );

  it("Update shots: a library set that does not go in leaves the record's set as the scene has it, so a brief that then drops the pin changes nothing", () => {
    const L = library();
    const { doc } = staged(openBrief());
    const groundOf = () =>
      doc.listObjects().find((o) => prop(o, 'desk_role') === 'set' && prop(o, 'desk_label') === 'ground')?.id;
    const ground = groundOf()!;
    // a camera the person hung from the words' ground and keyed
    const cam = getShots(doc)[1].camera!;
    doc.setParent(cam, ground, true);
    keyed(doc, cam, 'location', 0, [0, 0.5, 1]);
    doc.addObject({ type: 'EMPTY', name: 'Squatter' }, deriveUnitId('set', UNIT_ROOT));
    const set = readBriefRecord(doc)!.set;
    const r = updateFromBrief(doc, withPins(openBrief(), { set: L.set }), { units: source(L.set) });
    expect(rowsOf(r)).toEqual(['set words unavailable']);
    expect(readBriefRecord(doc)!.set).toBe(set);
    expect(r.warnings.filter((w) => /set by hand|took it off|the set changed/.test(w))).toEqual([]);
    // the brief drops the pin: it plans the words' set the scene has, so nothing is built again
    const u = update(doc, openBrief());
    expect(u.changes).toBeNull();
    expect(groundOf()).toBe(ground);
    expect(doc.getObject(cam)!.parent).toBe(ground);
    expect(u.r.warnings.filter((w) => /set by hand|took it off/.test(w))).toEqual([]);
  });

  it('Update shots: another library set that does not go in leaves the set, the record and the cameras as they were', () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    const other = lib('lib_0123456789othr', 1, L.set.given.data);
    // the instance's part moved out from under its root keeps its id; every later generation's id
    // is held by an object of the person's, so the other set has no id to take for that part
    const src = objectPart(L.units.set);
    doc.setParent(derivePartId('set', src, 0), null, true);
    for (let g = 1; g <= MAX_UNIT_GENERATION; g++)
      doc.addObject({ type: 'EMPTY', name: `In the way ${g}` }, derivePartId('set', src, g));
    keyed(doc, getShots(doc)[1].camera!, 'location', 0, [0, 0.5, 1]);
    const set = readBriefRecord(doc)!.set;
    const r = updateFromBrief(doc, withPins(openBrief(), { set: other }), { units: source(other) });
    expect(rowsOf(r)).toEqual(['set words unavailable']);
    expect(readInstance(doc, deriveUnitId('set', UNIT_ROOT))!.ref).toBe(L.set.pin.ref);
    expect(readBriefRecord(doc)!.set).toBe(set);
    expect(r.solved).toEqual([]);
    expect(r.warnings.join('\n')).not.toMatch(/the set changed/);
  });

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
  /**
   * Version `version` of the kite, its root an EMPTY or a MESH (wearing one of the kite's meshes),
   * scaled by `scale` when given.
   */
  function kiteRooted(type: 'EMPTY' | 'MESH', version: number, scale?: [number, number, number]): Lib {
    const L = library();
    const unit = editedUnit(L.units.kite, (body) => {
      const root = body.blocks.objects![UNIT_ROOT];
      root.type = type;
      if (type === 'EMPTY') delete root.data;
      else root.data = Object.keys(body.blocks.meshes!).sort()[0];
      if (scale) root.scale = scale;
    });
    return lib(L.kite.pin.ref, version, encodeUnit(unit.body, headerInput(unit.header)));
  }
  /** A cube of the person's under `parent`, at local `location` and `rotation`. */
  function mine(doc: SceneDoc, name: string, parent: string, location: Vec3, rotation: Vec3): string {
    let id = '';
    doc.transact(() => {
      id = doc.addObject({
        type: 'MESH',
        name,
        data: doc.addMesh(name, createCube()),
        parent,
        location,
        rotation_euler: rotation,
      });
    });
    return id;
  }
  /** Expects two world matrices to agree to rounding. */
  const sameWorld = (a: readonly number[], b: readonly number[]) =>
    a.forEach((v, i) => expect(v, `entry ${i}`).toBeCloseTo(b[i], 9));
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

  it("keeps the person's own objects under the old instance where they are, hung from the new root, in the same undo step", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    // objects of the person's: one under the kite's root (with one of their own under it), one
    // under a part of the kite that moves on its own (a segment of its tail, keyed to flutter)
    const part = [...readInstance(doc, v1.id)!.parts.values()]
      .map((p) => p.id)
      .find((id) => id !== v1.id && doc.getObject(id)?.parent === v1.id && doc.listFCurves(id).length > 0)!;
    expect(part).toBeTruthy();
    const partName = doc.getObject(part)!.name;
    const lantern = mine(doc, 'Lantern', v1.id, [0.3, -0.2, 0.4], [0.2, 0.1, 0.5]);
    const wick = mine(doc, 'Wick', lantern, [0, 0, 0.2], [0, 0, 0.3]);
    const ribbon = mine(doc, 'Ribbon', part, [0.1, 0, -0.3], [0, 0.4, 0]);
    const ours = [lantern, wick, ribbon];
    const worlds = () => ours.map((id) => doc.worldMatrix(id));
    const before = worlds();
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    // v2's root is a mesh twice v1's size: the objects keep their place in the world, not their channels
    const v2 = kiteRooted('MESH', 2, [2, 2, 2]);
    const u = update(doc, withPins(openBrief(), { el: { [KITE]: v2 } }), source(v2));
    expect(rowsOf(u.r)).toEqual([`${key} unit`]);
    const kite = propOf(doc, KITE);
    expect(kite).toMatchObject({ id: v1.id, type: 'MESH', scale: [2, 2, 2] });
    expect(readInstance(doc, kite.id)).toMatchObject({ version: 2, sha256: v2.pin.sha256 });
    expect(unitStatus(doc, kite.id)).toEqual({ edited: [], missing: [] });
    const parents = () => ours.map((id) => doc.getObject(id)?.parent);
    expect(parents()).toEqual([kite.id, lantern, kite.id]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    expect(doc.getObject(lantern)!.location).not.toEqual([0.3, -0.2, 0.4]);
    // the staging holds and flies v2 as it did v1: what is on its root follows it, unnamed; what was on
    // a part of v1 that moved on its own (the tail flutters) no longer follows that part, and is named
    expect(u.r.warnings.filter((w) => /no longer follow/.test(w))).toEqual([
      `${kite.name}: 'Ribbon' no longer follows the animation of '${partName}'`,
    ]);
    // the warnings name what stays (the tops of what the person put there), not the objects below them
    const kept = u.r.warnings.find((w) =>
      / which are not part of the look the library prop replaces$/.test(w),
    );
    expect(kept).toMatch(/: keeps '(Lantern|Ribbon)' and '(Lantern|Ribbon)', which/);
    expect(kept).toMatch(/'Lantern'/);
    expect(kept).toMatch(/'Ribbon'/);
    // one undo step: v1 again, the objects where they were under it
    undo.undo();
    expect(readInstance(doc, v1.id)).toMatchObject({ version: 1 });
    expect(parents()).toEqual([v1.id, lantern, part]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    undo.redo();
    expect(readInstance(doc, v1.id)).toMatchObject({ version: 2 });
    expect(parents()).toEqual([kite.id, lantern, kite.id]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
  });

  it("another item pinned to the slot keeps the person's own objects under the instance too", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    const lantern = mine(doc, 'Lantern', v1.id, [0.3, -0.2, 0.4], [0.2, 0.1, 0.5]);
    const before = doc.worldMatrix(lantern);
    // another library item, its root a mesh
    const rooted = kiteRooted('MESH', 1);
    const other = lib('lib_0123456789othr', 1, rooted.given.data);
    const u = update(doc, withPins(openBrief(), { el: { [KITE]: other } }), source(other));
    expect(rowsOf(u.r)).toEqual([`${key} unit`]);
    const kite = propOf(doc, KITE);
    expect(readInstance(doc, kite.id)).toMatchObject({ ref: other.pin.ref, version: 1 });
    expect(doc.getObject(lantern)?.parent).toBe(kite.id);
    sameWorld(doc.worldMatrix(lantern), before);
    expect(u.r.warnings).toContainEqual(
      expect.stringMatching(/: keeps 'Lantern', which is not part of the look the library prop replaces$/),
    );
    // Mira flies the new item as she flew the old one: what is on it follows it, unnamed
    expect(prop(kite, 'desk_rideo_held_by')).toBe(MIRA);
    expect(u.r.warnings.join('\n')).not.toMatch(/no longer follow/);
  });

  it("another item pinned where no one holds the prop any more names what followed the old one's flight", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    expect(prop(v1, 'desk_rideo_held_by')).toBe(MIRA);
    const lantern = mine(doc, 'Lantern', v1.id, [0.3, -0.2, 0.4], [0.2, 0.1, 0.5]);
    const before = doc.worldMatrix(lantern);
    const other = lib('lib_0123456789othr', 1, kiteRooted('MESH', 1).given.data);
    // Mira runs past the kite now: the staging neither holds nor flies the prop in its slot
    const b = withPins(openBrief(), { el: { [KITE]: other } });
    b.shots[0].description = 'Wide: Mira runs across the meadow past the kite, Pip chasing.';
    const u = update(doc, b, source(other));
    const kite = propOf(doc, KITE);
    expect(readInstance(doc, kite.id)).toMatchObject({ ref: other.pin.ref, version: 1 });
    expect(prop(kite, 'desk_rideo_held_by')).toBeUndefined();
    expect(doc.getObject(lantern)?.parent).toBe(kite.id);
    sameWorld(doc.worldMatrix(lantern), before);
    expect(u.r.warnings).toContain(`${kite.name}: 'Lantern' no longer follows the animation of '${v1.name}'`);
  });

  it("an object of the person's the new root's uneven scale would skew stays where it was, named", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    const s = v1.scale;
    expect(s[1]).toBeCloseTo(s[0], 12);
    expect(s[2]).toBeCloseTo(s[0], 12);
    // turned about Z under a root stretched along Y it would be sheared, which no channels hold
    const lantern = mine(doc, 'Lantern', v1.id, [0.3, 0, 0.4], [0, 0, Math.PI / 4]);
    expect(doc.getObject(lantern)!.parent).toBe(v1.id);
    const before = doc.worldMatrix(lantern);
    const v2 = kiteRooted('MESH', 2, [1, 2, 1]);
    const u = update(doc, withPins(openBrief(), { el: { [KITE]: v2 } }), source(v2));
    expect(rowsOf(u.r)).toEqual([`${key} unit`]);
    expect(propOf(doc, KITE)).toMatchObject({ type: 'MESH', scale: [1, 2, 1] });
    // it stays where the root's parent holds it (the scene), where it was in the world
    expect(doc.getObject(lantern)!.parent).toBe(v1.parent);
    sameWorld(doc.worldMatrix(lantern), before);
    expect(u.r.warnings).toContainEqual(
      expect.stringMatching(
        /: 'Lantern' stays where it was, not on the library prop's root: its scale would change it there$/,
      ),
    );
  });

  it("words the warning from the scene's object when the scene changed the type of the instance's root", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    expect(v1.type).toBe('EMPTY');
    // a scene written by other means: v1's file roots the kite in an empty, the scene in a mesh
    doc.transact(() =>
      doc.updateObject(v1.id, { type: 'MESH', data: doc.addMesh('Scene mesh', createCube()) }),
    );
    const v2 = kiteRooted('EMPTY', 2);
    const u = update(doc, withPins(openBrief(), { el: { [KITE]: v2 } }), source(v2));
    expect(rowsOf(u.r)).toEqual([`${key} unit`]);
    expect(propOf(doc, KITE)).toMatchObject({ id: v1.id, type: 'EMPTY' });
    expect(readInstance(doc, v1.id)).toMatchObject({ version: 2 });
    const said = u.r.warnings.find((w) => /so v2 replaces v1/.test(w));
    expect(said).toMatch(
      new RegExp(
        `: v2's root is an EMPTY and the scene's '${v1.name}' \\(v1's root, edited here\\) a MESH, so v2 replaces v1, edits and all, instead of updating it$`,
      ),
    );
    expect(said).not.toMatch(/v1's an? [A-Z]/);
  });

  /**
   * Where object `id` is at `frame` as seen from the kite's root, in metres along the root's own axes
   * (its world matrix in the root's frame, the root's scale left out): what the person sees of it
   * moving with the kite, whatever the root's size.
   */
  function onKite(doc: SceneDoc, id: string, frame: number): number[] {
    const fs = new FrameState(doc, frame);
    const r = fs.world(propOf(doc, KITE).id)!;
    const rigid = r.slice();
    for (let c = 0; c < 3; c++) {
      const n = Math.hypot(r[c * 4], r[c * 4 + 1], r[c * 4 + 2]);
      for (let k = 0; k < 3; k++) rigid[c * 4 + k] = r[c * 4 + k] / n;
    }
    return multiply4(invert4(rigid), fs.world(id)!);
  }
  it("keeps the keyed motion of an object of the person's under the old instance when the new root is a uniform scale of it", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    const anim = mine(doc, 'Anim', v1.id, [0.1, 0, 0], [0, 0, 0]);
    // it rises 1 m and turns a quarter, and grows by half, over frames 1 to 50
    keyed(doc, anim, 'location', 2, [0, 0.4, 1]);
    keyed(doc, anim, 'rotation_euler', 2, [0, 0.5, Math.PI / 2]);
    keyed(doc, anim, 'scale', 0, [1, 1.2, 1.5]);
    const before = FRAMES.map((f) => onKite(doc, anim, f));
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    // v2's root is a mesh twice v1's size: the keys are rewritten in it, so the motion stays
    const v2 = kiteRooted('MESH', 2, [2, 2, 2]);
    const u = update(doc, withPins(openBrief(), { el: { [KITE]: v2 } }), source(v2));
    expect(rowsOf(u.r)).toEqual([`${key} unit`]);
    expect(propOf(doc, KITE)).toMatchObject({ id: v1.id, scale: [2, 2, 2] });
    expect(doc.getObject(anim)?.parent).toBe(v1.id);
    FRAMES.forEach((f, i) => sameWorld(onKite(doc, anim, f), before[i]));
    const values = (path: string, index: number) =>
      doc
        .listFCurves(anim)
        .find((fc) => fc.path === path && fc.index === index)!
        .keyframes.map((k) => k.value);
    const near = (got: number[], want: number[]) =>
      want.forEach((v, i) => expect(got[i], `key ${i}`).toBeCloseTo(v, 12));
    near(values('location', 2), [0, 0.2, 0.5]);
    near(values('rotation_euler', 2), [0, 0.5, Math.PI / 2]);
    near(values('scale', 0), [0.5, 0.6, 0.75]);
    expect(u.r.warnings.join('\n')).not.toMatch(/animated/);
    expect(u.r.warnings).toContainEqual(
      expect.stringMatching(/: keeps 'Anim', which is not part of the look the library prop replaces$/),
    );
    // one undo step: its keys as they were under v1
    undo.undo();
    near(values('location', 2), [0, 0.4, 1]);
    FRAMES.forEach((f, i) => sameWorld(onKite(doc, anim, f), before[i]));
    undo.redo();
    near(values('location', 2), [0, 0.2, 0.5]);
    FRAMES.forEach((f, i) => sameWorld(onKite(doc, anim, f), before[i]));
  });

  it('keeps keyed moves along an unevenly scaled root, and names an object whose keyed turns now follow it', () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    const riser = mine(doc, 'Riser', v1.id, [0.1, 0, 0], [0, 0, 0]);
    keyed(doc, riser, 'location', 1, [0, 0.4, 1]);
    const spinner = mine(doc, 'Spinner', v1.id, [-0.1, 0, 0], [0, 0, 0]);
    keyed(doc, spinner, 'rotation_euler', 2, [0, 0.5, Math.PI / 2]);
    const rises = FRAMES.map((f) => onKite(doc, riser, f));
    const v2 = kiteRooted('MESH', 2, [1, 2, 1]);
    const u = update(doc, withPins(openBrief(), { el: { [KITE]: v2 } }), source(v2));
    expect(rowsOf(u.r)).toEqual([`${key} unit`]);
    expect(propOf(doc, KITE)).toMatchObject({ id: v1.id, scale: [1, 2, 1] });
    // both hang from the new root (neither is turned at rest)
    expect([riser, spinner].map((id) => doc.getObject(id)?.parent)).toEqual([v1.id, v1.id]);
    // a move along the stretched axis is halved in its keys: it moves as it did
    FRAMES.forEach((f, i) => sameWorld(onKite(doc, riser, f), rises[i]));
    // a turn under a root stretched along one axis has no keys that keep it: named
    expect(u.r.warnings).toContainEqual(
      expect.stringMatching(/: 'Spinner' is animated: its keyed motion now follows the library prop's root$/),
    );
    expect(u.r.warnings.join('\n')).not.toMatch(/'Riser' is animated/);
  });

  it("brings back the words' prop with the person's own objects on it, when the brief drops the pin", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    const v1 = propOf(doc, KITE);
    const part = [...readInstance(doc, v1.id)!.parts.values()]
      .map((p) => p.id)
      .find((id) => id !== v1.id && doc.getObject(id)?.parent === v1.id)!;
    const lantern = mine(doc, 'Lantern', v1.id, [0.3, -0.2, 0.4], [0.2, 0.1, 0.5]);
    const wick = mine(doc, 'Wick', lantern, [0, 0, 0.2], [0, 0, 0.3]);
    const ribbon = mine(doc, 'Ribbon', part, [0.1, 0, -0.3], [0, 0.4, 0]);
    const ours = [lantern, wick, ribbon];
    const worlds = () => ours.map((id) => doc.worldMatrix(id));
    const before = worlds();
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const u = update(doc, openBrief(), source(L.kite));
    expect(listUnits(doc)).toEqual([]);
    const kite = propOf(doc, KITE);
    expect(readInstance(doc, kite.id)).toBeNull();
    // the words' kite holds them where they were
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([kite.id, lantern, kite.id]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    // the warning names the tops of what the person put there, in the outliner's order (the part
    // the ribbon hangs from comes before or after the lantern by name)
    const kept = u.r.warnings.find((w) => w.endsWith(', which are not part of the library prop'));
    expect(kept).toMatch(new RegExp(`^${kite.name}: keeps '(Lantern|Ribbon)' and '(Lantern|Ribbon)', which`));
    expect(kept).toMatch(/'Lantern'/);
    expect(kept).toMatch(/'Ribbon'/);
    undo.undo();
    expect(readInstance(doc, v1.id)).toMatchObject({ version: 1 });
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([v1.id, lantern, part]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    undo.redo();
    expect(listUnits(doc)).toEqual([]);
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([kite.id, lantern, kite.id]);
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
    // and a camera the person set by hand (keyed): a set that does not go in changes nothing, so no
    // camera is solved for it, none is warned of it, and the record keeps the set the scene has
    keyed(doc, getShots(doc)[1].camera!, 'location', 0, [0, 0.5, 1]);
    const set = readBriefRecord(doc)!.set;
    let r: StageBriefReport | null = null;
    expect(() => (r = updateFromBrief(doc, b2, { units: source(v2) }))).not.toThrow();
    expect(rowsOf(r!)).toEqual(['set words unavailable']);
    expect(r!.solved).toEqual([]);
    expect(r!.warnings.join('\n')).not.toMatch(/the set changed/);
    expect(readBriefRecord(doc)!.set).toBe(set);
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

describe('what the person put on a library set stays when the brief links another item there or drops the pin', () => {
  const SET_ROOT = deriveUnitId('set', UNIT_ROOT);
  /** A cube of the person's under `parent`, at local `location` and `rotation`. */
  function mine(doc: SceneDoc, name: string, parent: string, location: Vec3, rotation: Vec3): string {
    let id = '';
    doc.transact(() => {
      id = doc.addObject({
        type: 'MESH',
        name,
        data: doc.addMesh(name, createCube()),
        parent,
        location,
        rotation_euler: rotation,
      });
    });
    return id;
  }
  /** Expects two world matrices to agree to rounding. */
  const sameWorld = (a: readonly number[], b: readonly number[]) =>
    a.forEach((v, i) => expect(v, `entry ${i}`).toBeCloseTo(b[i], 9));
  /** The placed set's part named `name`. */
  const partNamed = (doc: SceneDoc, name: string) =>
    [...readInstance(doc, SET_ROOT)!.parts.values()]
      .map((p) => p.id)
      .find((id) => id !== SET_ROOT && doc.getObject(id)?.name === name)!;
  /** Another library item holding the meadow, its root scaled by `scale` when given. */
  function otherSet(scale?: Vec3): Lib {
    const L = library();
    if (!scale) return lib('lib_0123456789othr', 1, L.set.given.data);
    const unit = editedUnit(L.units.set, (body) => {
      body.blocks.objects![UNIT_ROOT].scale = scale;
    });
    return lib('lib_0123456789othr', 1, encodeUnit(unit.body, headerInput(unit.header)));
  }
  const undoOf = (doc: SceneDoc) =>
    new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 });

  it("another item linked to the slot hangs them from the new set's root in one undo step, and a reopened scene keeps them", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    expect(readInstance(doc, SET_ROOT)).toMatchObject({ ref: L.set.pin.ref });
    const ground = partNamed(doc, 'Set Ground');
    // a bench on the set's root with a cushion of its own, and moss on its ground
    const bench = mine(doc, 'Bench', SET_ROOT, [2, -1, 0], [0, 0, 0.6]);
    const cushion = mine(doc, 'Cushion', bench, [0, 0, 0.5], [0.1, 0, 0]);
    const moss = mine(doc, 'Moss', ground, [-3, 2, 0.01], [0, 0, 1.2]);
    const ours = [bench, cushion, moss];
    const parents = (d: SceneDoc = doc) => ours.map((id) => d.getObject(id)?.parent);
    const worlds = (d: SceneDoc = doc) => ours.map((id) => d.worldMatrix(id));
    const before = worlds();
    const undo = undoOf(doc);
    const other = otherSet();
    const b2 = withPins(openBrief(), { set: other });
    const u = update(doc, b2, source(other));
    expect(rowsOf(u.r)).toEqual(['set unit']);
    expect(readInstance(doc, SET_ROOT)).toMatchObject({ ref: other.pin.ref, version: 1 });
    expect(parents()).toEqual([SET_ROOT, bench, SET_ROOT]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    expect(u.r.warnings).toContain(
      "the library set: keeps 'Bench' and 'Moss', which are not part of the set the library set replaces",
    );
    // one undo step: the first item again, the objects where they were on it
    undo.undo();
    expect(readInstance(doc, SET_ROOT)).toMatchObject({ ref: L.set.pin.ref });
    expect(parents()).toEqual([SET_ROOT, bench, ground]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    undo.redo();
    expect(readInstance(doc, SET_ROOT)).toMatchObject({ ref: other.pin.ref });
    expect(parents()).toEqual([SET_ROOT, bench, SET_ROOT]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    // a reopened scene holds them so, and the brief it holds changes nothing more
    const reopened = SceneDoc.fromUpdate(doc.encodeState());
    expect(parents(reopened)).toEqual([SET_ROOT, bench, SET_ROOT]);
    worlds(reopened).forEach((m, i) => sameWorld(m, before[i]));
    const again = update(reopened, b2, source(other));
    expect(again.changes).toBeNull();
    expect(again.r.warnings.join('\n')).not.toMatch(/keeps/);
  });

  it("the words' set brought back holds them on its ground, and the library set pinned again takes them back", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    const ground = partNamed(doc, 'Set Ground');
    const bench = mine(doc, 'Bench', SET_ROOT, [2, -1, 0], [0, 0, 0.6]);
    const moss = mine(doc, 'Moss', ground, [-3, 2, 0.01], [0, 0, 1.2]);
    const ours = [bench, moss];
    const parents = () => ours.map((id) => doc.getObject(id)?.parent);
    const worlds = () => ours.map((id) => doc.worldMatrix(id));
    const before = worlds();
    const undo = undoOf(doc);
    const off = update(doc, openBrief(), source(L.set));
    expect(listUnits(doc)).toEqual([]);
    const words = doc.listObjects().filter((o) => prop(o, 'desk_label') === 'ground');
    expect(words.map((o) => unitOf(doc, o.id))).toEqual([null]);
    expect(parents()).toEqual([words[0].id, words[0].id]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    expect(off.r.warnings).toContain(
      "the set: keeps 'Bench' and 'Moss', which are not part of the library set",
    );
    // one undo step: the library set again, the objects on it as they were
    undo.undo();
    expect(readInstance(doc, SET_ROOT)).toMatchObject({ ref: L.set.pin.ref, version: 1 });
    expect(parents()).toEqual([SET_ROOT, ground]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    undo.redo();
    expect(listUnits(doc)).toEqual([]);
    expect(parents()).toEqual([words[0].id, words[0].id]);
    // pinned again, the library set takes them from the words' ground, where they are
    const on = update(doc, withPins(openBrief(), { set: L.set }), source(L.set));
    expect(rowsOf(on.r)).toEqual(['set unit']);
    expect(parents()).toEqual([SET_ROOT, SET_ROOT]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    expect(on.r.warnings).toContain(
      "the library set: keeps 'Bench' and 'Moss', which are not part of the set the library set replaces",
    );
  });

  it("an object of the person's that the new set root's uneven scale would skew stays where it was, named", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    const turned = mine(doc, 'Turned', SET_ROOT, [1, 1, 0], [0, 0, Math.PI / 4]);
    const plain = mine(doc, 'Plain', SET_ROOT, [-1, 1, 0], [0, 0, 0]);
    const before = [turned, plain].map((id) => doc.worldMatrix(id));
    const other = otherSet([1, 2, 1]);
    const u = update(doc, withPins(openBrief(), { set: other }), source(other));
    expect(rowsOf(u.r)).toEqual(['set unit']);
    expect(doc.getObject(SET_ROOT)!.scale).toEqual([1, 2, 1]);
    // the turned one stays where the root's parent (the scene) holds it; the other hangs from the root
    expect([turned, plain].map((id) => doc.getObject(id)?.parent)).toEqual([null, SET_ROOT]);
    [turned, plain].forEach((id, i) => sameWorld(doc.worldMatrix(id), before[i]));
    expect(u.r.warnings).toContain(
      "the library set: 'Turned' stays where it was, not on the library set's root: its scale would change it there",
    );
  });

  it("keyed objects of the person's on a set's part keep their moves on the new root; one whose turns cannot be kept is named", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    // the pond is a part stretched 5 × 4: a duck swims across it, a buoy turns on it
    const pond = partNamed(doc, 'pond');
    expect(doc.getObject(pond)!.scale).toEqual([5, 4, 1]);
    const duck = mine(doc, 'Duck', pond, [0.1, 0, 0], [0, 0, 0]);
    keyed(doc, duck, 'location', 0, [-0.3, 0, 0.3]);
    keyed(doc, duck, 'location', 1, [0, 0.2, 0.1]);
    const buoy = mine(doc, 'Buoy', pond, [-0.1, 0, 0], [0, 0, 0]);
    keyed(doc, buoy, 'rotation_euler', 2, [0, 0.5, Math.PI / 2]);
    // a camera the person hung on the pond pans: not named as kept, but its motion change is
    let cam = '';
    doc.transact(() => {
      cam = doc.addObject({ type: 'CAMERA', name: 'Pond cam', data: doc.addCamera(), parent: pond });
    });
    keyed(doc, cam, 'rotation_euler', 2, [0, 0.3, 0.6]);
    const swim = FRAMES.map((f) => new FrameState(doc, f).world(duck)!);
    const other = otherSet();
    const u = update(doc, withPins(openBrief(), { set: other }), source(other));
    expect(rowsOf(u.r)).toEqual(['set unit']);
    expect([duck, buoy, cam].map((id) => doc.getObject(id)?.parent)).toEqual([SET_ROOT, SET_ROOT, SET_ROOT]);
    // the duck's moves, keyed along the pond's stretched axes, are rewritten: it swims as it did
    FRAMES.forEach((f, i) => sameWorld(new FrameState(doc, f).world(duck)!, swim[i]));
    expect(u.r.warnings).toContain(
      "the library set: keeps 'Buoy' and 'Duck', which are not part of the set the library set replaces",
    );
    expect(u.r.warnings).toContain(
      "the library set: 'Buoy' and 'Pond cam' are animated: their keyed motion now follows the library set's root",
    );
    expect(u.r.warnings.join('\n')).not.toMatch(/'Duck' (is|and)/);
  });

  it("keeps the keyed scale of a turned object of the person's on a root scaled unevenly, along the object's own axes", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    // turned a quarter about Z: its own X runs along the root's Y, which the new root stretches
    const turned = mine(doc, 'Turned', SET_ROOT, [1, 1, 0], [0, 0, Math.PI / 2]);
    keyed(doc, turned, 'scale', 0, [1, 1.5, 2]);
    keyed(doc, turned, 'scale', 1, [1, 1.2, 1.4]);
    const grows = FRAMES.map((f) => new FrameState(doc, f).world(turned)!);
    const other = otherSet([1, 2, 1]);
    const u = update(doc, withPins(openBrief(), { set: other }), source(other));
    expect(rowsOf(u.r)).toEqual(['set unit']);
    expect(doc.getObject(SET_ROOT)!.scale).toEqual([1, 2, 1]);
    expect(doc.getObject(turned)?.parent).toBe(SET_ROOT);
    // it grows in the world as it did at every keyed frame and between them
    FRAMES.forEach((f, i) => sameWorld(new FrameState(doc, f).world(turned)!, grows[i]));
    // its own X keys are halved (they scale along the stretched axis), its own Y keys stay
    const values = (index: number) =>
      doc
        .listFCurves(turned)
        .find((fc) => fc.path === 'scale' && fc.index === index)!
        .keyframes.map((k) => k.value);
    values(0).forEach((v, i) => expect(v, `X key ${i}`).toBeCloseTo([0.5, 0.75, 1][i], 12));
    values(1).forEach((v, i) => expect(v, `Y key ${i}`).toBeCloseTo([1, 1.2, 1.4][i], 12));
    expect(u.r.warnings.join('\n')).not.toMatch(/animated|skew|stays where it was|no longer follow/);
  });

  it("the words' set brought back keeps what is nested on the person's objects, and a reopened scene keeps them with nothing more to update", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    const ground = partNamed(doc, 'Set Ground');
    const bench = mine(doc, 'Bench', SET_ROOT, [2, -1, 0], [0, 0, 0.6]);
    const cushion = mine(doc, 'Cushion', bench, [0, 0, 0.5], [0.1, 0, 0]);
    const moss = mine(doc, 'Moss', ground, [-3, 2, 0.01], [0, 0, 1.2]);
    const sprout = mine(doc, 'Sprout', moss, [0, 0, 0.05], [0, 0.2, 0]);
    const ours = [bench, cushion, moss, sprout];
    const parents = (d: SceneDoc = doc) => ours.map((id) => d.getObject(id)?.parent);
    const worlds = (d: SceneDoc = doc) => ours.map((id) => d.worldMatrix(id));
    const before = worlds();
    const undo = undoOf(doc);
    const b2 = openBrief();
    const off = update(doc, b2, source(L.set));
    expect(listUnits(doc)).toEqual([]);
    const words = doc.listObjects().filter((o) => prop(o, 'desk_label') === 'ground');
    expect(words.map((o) => unitOf(doc, o.id))).toEqual([null]);
    const back = [words[0].id, bench, words[0].id, moss];
    expect(parents()).toEqual(back);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    expect(off.r.warnings).toContain(
      "the set: keeps 'Bench' and 'Moss', which are not part of the library set",
    );
    expect(off.r.warnings.join('\n')).not.toMatch(/Cushion|Sprout/);
    undo.undo();
    expect(parents()).toEqual([SET_ROOT, bench, ground, moss]);
    worlds().forEach((m, i) => sameWorld(m, before[i]));
    undo.redo();
    expect(parents()).toEqual(back);
    // a reopened scene holds them so, and the brief it holds changes nothing more
    const reopened = SceneDoc.fromUpdate(doc.encodeState());
    expect(parents(reopened)).toEqual(back);
    worlds(reopened).forEach((m, i) => sameWorld(m, before[i]));
    const again = update(reopened, b2, source(L.set));
    expect(again.changes).toBeNull();
    expect(again.r.warnings.join('\n')).not.toMatch(/keeps|goes|follow/);
    expect(parents(reopened)).toEqual(back);
  });

  it("an object of the person's on a part of the set that moved on its own no longer follows it on the new root, and is named", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    // the pond bobs, a duck of the person's on it
    const pond = partNamed(doc, 'pond');
    keyed(doc, pond, 'location', 2, [0, 0.2, 0]);
    const duck = mine(doc, 'Duck', pond, [0.1, 0, 0.02], [0, 0, 0]);
    const at = doc.worldMatrix(duck);
    const other = otherSet();
    const u = update(doc, withPins(openBrief(), { set: other }), source(other));
    expect(rowsOf(u.r)).toEqual(['set unit']);
    expect(doc.getObject(duck)?.parent).toBe(SET_ROOT);
    sameWorld(doc.worldMatrix(duck), at);
    // it keeps its place at rest, but the new root does not bob: said so
    FRAMES.forEach((f) => sameWorld(new FrameState(doc, f).world(duck)!, at));
    expect(u.r.warnings).toContain("the library set: 'Duck' no longer follows the animation of 'pond'");
  });
});

describe("a later version of the library set that changes none of the set's parts", () => {
  const SET_ROOT = () => deriveUnitId('set', UNIT_ROOT);
  /** An object part of the library set, and a version 2 of the set that moves it 1 m along x. */
  const moving = () => {
    const L = library();
    const src = Object.keys(L.units.set.body.blocks.objects!).find((s) => s !== UNIT_ROOT)!;
    const edited = editedUnit(L.units.set, (body) => {
      const at = body.blocks.objects![src].location as number[];
      body.blocks.objects![src].location = [at[0] + 1, at[1], at[2]];
    });
    return { src, v2: lib(L.set.pin.ref, 2, encodeUnit(edited.body, headerInput(edited.header))) };
  };

  it.each([
    'the same file again',
    'a new name only',
    'a change to a part the person edited in the desk',
  ] as const)("Update shots: a version 2 that is %s is no set change for the shots' cameras", (how) => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    let v2: Lib;
    if (how === 'the same file again') v2 = lib(L.set.pin.ref, 2, L.set.given.data);
    else if (how === 'a new name only')
      v2 = lib(
        L.set.pin.ref,
        2,
        encodeUnit(L.units.set.body, { ...headerInput(L.units.set.header), name: 'Meadow in summer' }),
      );
    else {
      const m = moving();
      v2 = m.v2;
      // the person moved that part in the desk: the update keeps their edit of it
      const id = readInstance(doc, SET_ROOT())!.parts.get(`objects:${m.src}`)!.id;
      const at = doc.getObject(id)!.location;
      doc.transact(() => doc.updateObject(id, { location: [at[0], at[1] + 2, at[2]] }));
    }
    // a camera set by hand (keyed): it would be warned of a set change, and the others solved
    keyed(doc, getShots(doc)[1].camera!, 'location', 0, [0, 0.5, 1]);
    const { r } = update(doc, withPins(openBrief(), { set: v2 }), source(v2));
    expect(rowsOf(r)).toEqual(['set unit']);
    expect(readInstance(doc, SET_ROOT())!.version).toBe(2);
    expect(r.solved).toEqual([]);
    expect(r.warnings.join('\n')).not.toMatch(/the set changed/);
  });

  it('Update shots: a version 2 that moves a part of the set solves the cameras still as staged and keeps the one set by hand', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set });
    const { doc } = staged(b, source(L.set));
    const { v2 } = moving();
    keyed(doc, getShots(doc)[1].camera!, 'location', 0, [0, 0.5, 1]);
    const { r } = update(doc, withPins(openBrief(), { set: v2 }), source(v2));
    expect(rowsOf(r)).toEqual(['set unit']);
    expect(r.solved).toEqual(b.shots.filter((_, i) => i !== 1).map((s) => s.id));
    expect(r.warnings).toContain(
      'Shot 2: its camera was set by hand in the desk and is kept; the set changed, so check its framing (solve it again with desk.shot_solve)',
    );
  });
});
