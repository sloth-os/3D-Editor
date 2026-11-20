import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { SCHEMA_VERSION } from '../src/doc/types';
import { solveShotCameras } from '../src/operators/desk-shots';
import {
  UNIT_BUDGET,
  adoptPublished,
  briefChanges,
  briefPins,
  briefWithoutPins,
  pinsWanted,
  planInfoOf,
  stageBrief,
  stateUnitRows,
  unitBudget,
  unitReadProblem,
  unitSourceOf,
  updateFromBrief,
  type BriefUnitPin,
  type GivenUnit,
  type SceneBrief,
  type StageBriefReport,
  type UnitSource,
} from '../src/desk/brief';
import { planBrief } from '../src/desk/brief/plan';
import { BRIEF_RECORD_KEY, readBriefRecord } from '../src/desk/brief/record';
import { docContext } from '../src/desk/brief/stage';
import { sha256Hex } from '../src/desk/container';
import { exportRideoBlocking } from '../src/desk/rideo';
import { importRideoBlocking } from '../src/desk/rideo/import';
import { getShots } from '../src/desk/shots';
import {
  UnitError,
  deriveUnitId,
  encodeUnit,
  extractUnit,
  listUnits,
  makeLocal,
  readInstance,
  unitOf,
  unitStatus,
  type UnitHeaderInput,
  type UnitPayload,
} from '../src/desk/units';
import { unusedData } from '../src/desk/units/remove';
import type { DatablockKind } from '../src/doc/types';
import { BUILTIN_CATALOG } from '../src/store/catalog';
import { goldenBriefs, readGolden, stageGolden } from './desk-brief-golden-helpers';
import {
  KITE,
  MIRA,
  PIP,
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
 * Staging with library pins (desk/brief units.ts, library.ts; docs/director-desk.md "Library units"):
 * a pinned set, figure or prop held by the desk is staged from its unit (the set before the import,
 * the figure as its member's actor, the prop at its element's spot); a pin whose unit is not held,
 * or cannot be used, is staged from the words and recorded 'pending' (tried again at the next open)
 * or 'refused' (only another version is tried). An update places, updates, replaces or removes a
 * slot's unit (a figure restyles its actor in place), briefChanges says so in the desk's words, and
 * is null exactly when the update changes nothing. Units come from scenes staged here (extractUnit);
 * A1's fixtures carry text where the unit files would be (refused 'unreadable').
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
const LOCATION = 'ele_0123456789mead';

/** A library version: its pin and the file the host sends for it. */
interface Lib {
  pin: BriefUnitPin;
  given: GivenUnit;
}

function lib(ref: string, version: number, data: Uint8Array): Lib {
  const sha256 = sha256Hex(data);
  return { pin: { ref, version, sha256 }, given: { ref, version, sha256, data } };
}

/** A unit file with its header changed by `edit` (the body as it is). */
function reheadered(u: UnitPayload, edit: (h: UnitHeaderInput) => void): Uint8Array {
  const h = headerInput(u.header);
  edit(h);
  return encodeUnit(u.body, h);
}

/** A new version of a unit: its first material made blue. */
function bluer(u: UnitPayload): Uint8Array {
  const e = editedUnit(u, (body) => {
    const m = Object.values(body.blocks.materials ?? {})[0] as { base_color?: number[] } | undefined;
    if (m) m.base_color = [0.1, 0.2, 0.9, 1];
  });
  return encodeUnit(e.body, headerInput(e.header));
}

interface Library {
  set: Lib;
  /** A set with a park bench where the words put Mira (her mark is at x −1.2 m, on the line). */
  bench: Lib;
  kite: Lib;
  kite2: Lib;
  mira: Lib;
  pip: Lib;
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
  const pip = unitFrom(src, { kind: 'figure', actor: actorOf(src, PIP).id, name: 'Pip' });
  const benchDoc = stagedDoc();
  BUILTIN_CATALOG.find((e) => e.id === 'park_bench')!.build(benchDoc, { location: [-1.2, 0, 0] });
  const bench = unitFrom(benchDoc, { kind: 'set', name: 'Bench meadow' });
  src.destroy();
  benchDoc.destroy();
  made = {
    set: lib('lib_0123456789mead', 1, set.ex.data),
    bench: lib('lib_0123456789bnch', 1, bench.ex.data),
    kite: lib('lib_0123456789kite', 1, kite.ex.data),
    kite2: lib('lib_0123456789kite', 2, bluer(kite.unit)),
    mira: lib('lib_0123456789mira', 1, mira.ex.data),
    pip: lib('lib_0123456789pipd', 1, pip.ex.data),
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

/** The header of a library version's file. */
const readHeader = (l: Lib) => unitSourceOf([l.given]).header(l.pin)!;
/** A report row's ref and version of a library version. */
const pick = (l: Lib) => ({ ref: l.pin.ref, version: l.pin.version });
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
const recordCast = (doc: SceneDoc, id: string) => readBriefRecord(doc)!.cast.find((c) => c.id === id)!;
const recordElement = (doc: SceneDoc, id: string) => readBriefRecord(doc)!.elements.find((e) => e.id === id)!;

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

/**
 * Updates `doc` to `b` and checks that briefChanges (given the same units) was null exactly when
 * the update changed nothing of the staging. Returns the update's report and the changes.
 */
function update(
  doc: SceneDoc,
  b: SceneBrief,
  units?: UnitSource,
): { r: StageBriefReport; changes: ReturnType<typeof briefChanges> } {
  const o = units ? { units } : {};
  const changes = briefChanges(doc, b, o);
  const before = staging(doc);
  const r = updateFromBrief(doc, b, o);
  expect(changes === null, `briefChanges ${JSON.stringify(changes)}`).toBe(staging(doc) === before);
  return { r, changes };
}

const NOTHING_LISTED = { added: [], removed: [], retimed: [], recast: [], cast: { added: [], removed: [] } };

describe('staging with library units', () => {
  it('places the set, a figure and a prop from their units and records their pins', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set, cast: { [MIRA]: L.mira }, el: { [KITE]: L.kite } });
    const units = source(L.set, L.mira, L.kite);
    const { doc, r } = staged(b, units);
    const inst = new Map(listUnits(doc).map((i) => [i.key, i]));
    expect([...inst.keys()].sort()).toEqual([`cast:${MIRA}`, `el:${KITE}`, 'set']);
    expect(r.units).toEqual([
      { slot: 'set', ...pick(L.set), object: inst.get('set')!.root, staged: 'unit' },
      { slot: `cast:${MIRA}`, ...pick(L.mira), object: actorOf(doc, MIRA).id, staged: 'unit' },
      { slot: `el:${KITE}`, ...pick(L.kite), object: propOf(doc, KITE).id, staged: 'unit' },
    ]);
    expect(libraryWarnings(r)).toEqual([]);
    expect(r.solved).toHaveLength(b.shots.length);

    // the set is the unit's: its root stamped as the scene's set, no ground, wall or landmark of the words
    const root = doc.getObject(inst.get('set')!.root)!;
    expect(prop(root, 'desk_role')).toBe('set');
    expect(prop(root, 'desk_rideo_clip')).toBe(b.id);
    expect(prop(root, 'desk_ground')).toBe('grass');
    const words = doc
      .listObjects()
      .filter(
        (o) =>
          (prop(o, 'desk_role') === 'landmark' || prop(o, 'desk_role') === 'set') &&
          unitOf(doc, o.id) === null,
      );
    expect(words.map((o) => o.name)).toEqual([]);
    // Mira is the figure (its root is her actor), the kite the unit's prop, held by her
    expect(readInstance(doc, actorOf(doc, MIRA).id)?.key).toBe(`cast:${MIRA}`);
    expect(r.cast.find((c) => c.castId === MIRA)?.kind).toBe('child');
    const kite = propOf(doc, KITE);
    expect(JSON.parse(String(prop(kite, 'desk_rideo_build')))[1]).toBe(`unit:${L.kite.pin.ref}@1`);
    expect(r.props).toEqual([{ elementId: KITE, object: kite.id, heldBy: MIRA }]);

    // the record keeps each pin as staged; Pip, pinned to nothing, has no key
    const rec = readBriefRecord(doc)!;
    expect(rec.setUnit).toEqual({ ...L.set.pin, staged: 'unit' });
    expect(recordCast(doc, MIRA).unit).toEqual({ ...L.mira.pin, staged: 'unit' });
    expect(recordElement(doc, KITE).unit).toEqual({ ...L.kite.pin, staged: 'unit' });
    expect('unit' in recordCast(doc, PIP)).toBe(false);
    expect(stateUnitRows(doc).map((x) => [x.slot, x.staged, x.local])).toEqual([
      [`cast:${MIRA}`, 'unit', false],
      [`el:${KITE}`, 'unit', false],
      ['set', 'unit', false],
    ]);

    // a later open with the same brief needs no bytes: nothing to do, nothing wanted
    expect(briefChanges(doc, b)).toBeNull();
    expect(briefChanges(doc, b, { units })).toBeNull();
    expect(pinsWanted(doc, b)).toEqual([]);
    const { r: again } = update(doc, b);
    expect(rowsOf(again)).toEqual(['set unit', `cast:${MIRA} unit`, `el:${KITE} unit`]);
  });

  it('stands a mark clear of the set’s pieces when it first places it', () => {
    const L = library();
    const { doc, r } = staged(withPins(openBrief(), { set: L.bench }), source(L.bench));
    expect(rowsOf(r)).toEqual(['set unit']);
    // the words put Mira at (−1.2, 0), on the bench: she stands 0.3 m clear of it; Pip keeps his mark
    const at = actorOf(doc, MIRA).location;
    const info = planInfoOf(readHeader(L.bench));
    const piece = info.kind === 'set' ? info.pieces.find((p) => p.label === 'Park Bench')! : null;
    expect(piece).toMatchObject({ x: -1.2, y: 0, rotationDeg: 0 });
    const gap = Math.hypot(
      Math.max(Math.abs(at[0] - piece!.x) - piece!.width / 2, 0),
      Math.max(Math.abs(at[1] - piece!.y) - piece!.depth / 2, 0),
    );
    expect(gap).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(actorOf(doc, PIP).location.slice(0, 2)).toEqual([1.2, 0]);
  });

  it('stages a brief without pins, and a brief stripped of its pins, as it always did', () => {
    const L = library();
    const plain = staged(openBrief());
    const stripped = staged(briefWithoutPins(withPins(openBrief(), { set: L.set, el: { [KITE]: L.kite } })));
    // the same record (the desk's shot ids aside), with no pin key anywhere
    const record = (doc: SceneDoc) => {
      const r = readBriefRecord(doc)!;
      return { ...r, shots: r.shots.map(({ desk: _desk, ...x }) => x) };
    };
    expect(record(stripped.doc)).toEqual(record(plain.doc));
    expect(JSON.stringify(readBriefRecord(stripped.doc))).not.toContain('"unit"');
    expect(plain.r.units).toEqual([]);
    expect(briefPins(briefWithoutPins(withPins(openBrief(), { set: L.set })))).toEqual([]);
  });
});

describe('briefs without pins stage as before, also with an empty unit source', () => {
  const golden = readGolden();
  const briefs = goldenBriefs();
  it.each(Object.keys(golden.briefs))('%s', (name) => {
    const now = stageGolden(briefs[name], (doc, b) => stageBrief(doc, b, { units: unitSourceOf([]) }));
    const was = golden.briefs[name];
    expect(now.hash).toBe(was.hash);
    expect(now.record).toEqual(was.record);
    expect(now.report).toEqual(was.report);
    for (const section of Object.keys(was.fingerprint))
      expect(now.fingerprint[section], section).toEqual(was.fingerprint[section]);
  });
});

describe('a pin whose unit is not held', () => {
  it('is staged from the words and recorded pending; once the unit is held an update places it', () => {
    const L = library();
    const b = withPins(openBrief(), { el: { [KITE]: L.kite } });
    const { doc, r } = staged(b, unitSourceOf([]));
    expect(r.units).toEqual([
      { slot: `el:${KITE}`, ...pick(L.kite), object: propOf(doc, KITE).id, staged: 'words', why: 'missing' },
    ]);
    expect(libraryWarnings(r)).toEqual([
      "Red kite's library prop lib_0123456789kite v1 is not here: the prop from the words stands in until it arrives (Update shots then places it)",
    ]);
    expect(recordElement(doc, KITE).unit).toEqual({ ...L.kite.pin, staged: 'pending', why: 'missing' });
    expect(listUnits(doc)).toEqual([]);
    expect(pinsWanted(doc, b)).toEqual([L.kite.pin]);
    // still not held: nothing to do
    expect(update(doc, b, unitSourceOf([])).changes).toBeNull();
    expect(recordElement(doc, KITE).unit?.staged).toBe('pending');

    // held now: the banner says so and the update places it (the words' prop gives it its id)
    const words = propOf(doc, KITE).id;
    const u = update(doc, b, source(L.kite));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: ['1 prop from the library'] });
    expect(rowsOf(u.r)).toEqual([`el:${KITE} unit`]);
    expect(propOf(doc, KITE).id).toBe(words);
    expect(readInstance(doc, words)?.key).toBe(`el:${KITE}`);
    expect(recordElement(doc, KITE).unit).toEqual({ ...L.kite.pin, staged: 'unit' });
    expect(pinsWanted(doc, b)).toEqual([]);
    expect(update(doc, b, source(L.kite)).changes).toBeNull();
  });

  it('keeps the version placed until the new one is held, then updates it in place (its root id stays)', () => {
    const L = library();
    const b1 = withPins(openBrief(), { el: { [KITE]: L.kite } });
    const { doc } = staged(b1, source(L.kite));
    const root = propOf(doc, KITE).id;
    const b2 = withPins(b1, { el: { [KITE]: L.kite2 } });
    // v2 not here: v1 stays, the record keeps v1
    const kept = update(doc, b2);
    expect(kept.changes).toBeNull();
    expect(kept.r.units).toEqual([
      { slot: `el:${KITE}`, ...pick(L.kite2), object: root, staged: 'words', why: 'missing' },
    ]);
    expect(libraryWarnings(kept.r)).toEqual([
      "Red kite's library prop lib_0123456789kite v2 is not here: v1 stays until it arrives (Update shots then places it)",
    ]);
    expect(readInstance(doc, root)?.version).toBe(1);
    expect(recordElement(doc, KITE).unit).toEqual({ ...L.kite.pin, staged: 'unit' });
    expect(pinsWanted(doc, b2)).toEqual([L.kite2.pin]);
    // v2 held: updated in place
    const u = update(doc, b2, source(L.kite2));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: ['1 prop with a new library version'] });
    expect(propOf(doc, KITE).id).toBe(root);
    expect(readInstance(doc, root)).toMatchObject({ version: 2, sha256: L.kite2.pin.sha256 });
    expect(recordElement(doc, KITE).unit).toEqual({ ...L.kite2.pin, staged: 'unit' });
    // the pin removed: the words' prop again
    const b3 = withPins(b2, { el: { [KITE]: null } });
    const back = update(doc, b3);
    expect(back.changes).toEqual({ ...NOTHING_LISTED, other: ['1 prop back to the words'] });
    expect(back.r.units).toEqual([]);
    expect(readInstance(doc, propOf(doc, KITE).id)).toBeNull();
    expect(listUnits(doc)).toEqual([]);
    expect('unit' in recordElement(doc, KITE)).toBe(false);
    expect(update(doc, b3).changes).toBeNull();
  });

  it('places a set by an update, solving the cameras still as staged, and takes it away again', () => {
    const L = library();
    const { doc } = staged(openBrief());
    const b = withPins(openBrief(), { set: L.set });
    const u = update(doc, b, source(L.set));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: ['the set from the library'] });
    expect(u.r.solved).toEqual(b.shots.map((s) => s.id));
    const grounds = () =>
      doc
        .listObjects()
        .filter((o) => prop(o, 'desk_label') === 'ground')
        .map((o) => unitOf(doc, o.id) !== null);
    expect(grounds()).toEqual([true]);
    expect(update(doc, b, source(L.set)).changes).toBeNull();
    const back = update(doc, withPins(b, { set: null }));
    expect(back.changes).toEqual({ ...NOTHING_LISTED, other: ['the set from the words (no library set)'] });
    expect(listUnits(doc)).toEqual([]);
    expect(grounds()).toEqual([false]);
  });

  it('replaces the set by another library set', () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    const b = withPins(openBrief(), { set: L.bench });
    const u = update(doc, b, source(L.bench));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: ['another library set'] });
    expect(listUnits(doc).map((i) => [i.key, i.ref])).toEqual([['set', L.bench.pin.ref]]);
    expect(readBriefRecord(doc)!.setUnit).toEqual({ ...L.bench.pin, staged: 'unit' });
    expect(update(doc, b, source(L.bench)).changes).toBeNull();
  });

  it('stages a member the update adds as its figure, and an element of kind other as its prop', () => {
    const L = library();
    // Pip in no shot at first: not staged
    const first = openBrief();
    first.shots[0].castIds = [MIRA];
    first.shots[0].layout = first.shots[0].layout.filter((e) => e.castId !== PIP);
    const { doc } = staged(first);
    expect(() => actorOf(doc, PIP)).toThrow();
    const b = withPins(openBrief(), { cast: { [PIP]: L.pip } });
    const u = update(doc, b, source(L.pip));
    expect(u.changes?.other).toContain('1 cast member from the library');
    expect(rowsOf(u.r)).toEqual([`cast:${PIP} unit`]);
    const pip = actorOf(doc, PIP);
    expect(readInstance(doc, pip.id)?.key).toBe(`cast:${PIP}`);
    expect(prop(pip, 'desk_kind')).toBe('dog');
    expect(u.r.cast.find((c) => c.castId === PIP)).toMatchObject({ object: pip.id, kind: 'dog' });
    expect(update(doc, b, source(L.pip)).changes).toBeNull();

    // an element of kind 'other' with a prop unit
    const other = withPins(openBrief(), { el: { [KITE]: L.kite } });
    other.elements.find((e) => e.id === KITE)!.kind = 'other';
    const o = staged(other, source(L.kite));
    expect(rowsOf(o.r)).toEqual([`el:${KITE} unit`]);
    expect(readInstance(o.doc, propOf(o.doc, KITE).id)?.key).toBe(`el:${KITE}`);
  });

  it('leaves a slot made local as it is', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set });
    const { doc } = staged(b, source(L.set));
    makeLocal(doc, listUnits(doc)[0].root);
    expect(stateUnitRows(doc)).toEqual([
      { slot: 'set', ...pick(L.set), sha256: L.set.pin.sha256, staged: 'unit', local: true },
    ]);
    expect(pinsWanted(doc, b)).toEqual([]);
    const u = update(doc, b, source(L.set));
    expect(u.changes).toBeNull();
    expect(u.r.units).toEqual([
      { slot: 'set', ...pick(L.set), object: expect.any(String), staged: 'words', why: 'local' },
    ]);
    // a new sun relights it, and builds no ground of the words
    const dusk = structuredClone(b);
    dusk.set.timeOfDay = 'dusk';
    expect(update(doc, dusk).changes?.other).toEqual(['the set']);
    expect(doc.listObjects().filter((o) => prop(o, 'desk_label') === 'ground')).toHaveLength(1);
  });
});

describe('a slot that held an instance before (its ids are derived from the slot)', () => {
  type Kind = 'set' | 'prop' | 'figure';
  const slotOf = (kind: Kind) => (kind === 'set' ? 'set' : kind === 'prop' ? `el:${KITE}` : `cast:${MIRA}`);
  const pinOf = (kind: Kind, l: Lib | null) =>
    kind === 'set' ? { set: l } : kind === 'prop' ? { el: { [KITE]: l } } : { cast: { [MIRA]: l } };
  /** The datablocks (not objects) a unit's parts derive to in slot `key`, as '<kind>:<id>'. */
  const derived = (u: UnitPayload, key: string) =>
    Object.entries(u.body.blocks).flatMap(([k, m]) =>
      k === 'objects' ? [] : Object.keys(m ?? {}).map((src) => `${k}:${deriveUnitId(key, src)}`),
    );

  it.each(['set', 'prop', 'figure'] as const)(
    'places a %s pinned, unpinned and pinned again; nothing the instance held is left unused',
    (kind) => {
      const L = library();
      const l = kind === 'set' ? L.set : kind === 'prop' ? L.kite : L.mira;
      const unit = kind === 'set' ? L.units.set : kind === 'prop' ? L.units.kite : L.units.mira;
      const key = slotOf(kind);
      const b = withPins(openBrief(), pinOf(kind, l));
      const { doc } = staged(b, source(l));
      expect(listUnits(doc).map((i) => i.key)).toEqual([key]);
      // the host unlinks the unit: the slot goes back to the words, its datablocks with it
      update(doc, withPins(openBrief(), pinOf(kind, null)));
      expect(listUnits(doc)).toEqual([]);
      expect([...unusedData(doc, derived(unit, key))]).toEqual([]);
      if (kind !== 'figure')
        expect(
          derived(unit, key).filter((k) => doc.has(...(k.split(':') as [DatablockKind, string]))),
        ).toEqual([]);
      // and links the same version again: placed as the first time
      const back = update(doc, b, source(l));
      expect(back.changes?.other).toHaveLength(1);
      expect(rowsOf(back.r)).toContain(`${key} unit`);
      const inst = listUnits(doc);
      expect(inst.map((i) => [i.key, i.ref, i.version])).toEqual([[key, l.pin.ref, 1]]);
      expect(unitStatus(doc, inst[0].root)).toEqual({ edited: [], missing: [] });
    },
  );

  it.each(['element', 'cast member'] as const)(
    'places the %s dropped from the brief and back with its pin',
    (what) => {
      const L = library();
      const l = what === 'element' ? L.kite : L.pip;
      const full = withPins(openBrief(), what === 'element' ? { el: { [KITE]: l } } : { cast: { [PIP]: l } });
      const without = structuredClone(full);
      if (what === 'element') {
        without.elements = without.elements.filter((e) => e.id !== KITE);
        for (const s of without.shots) s.elementIds = s.elementIds.filter((x) => x !== KITE);
      } else {
        without.cast = without.cast.filter((c) => c.id !== PIP);
        for (const s of without.shots) {
          s.castIds = s.castIds.filter((x) => x !== PIP);
          s.layout = s.layout.filter((e) => e.castId !== PIP);
        }
      }
      const key = what === 'element' ? `el:${KITE}` : `cast:${PIP}`;
      const { doc } = staged(full, source(l));
      update(doc, without, source(l));
      expect(listUnits(doc)).toEqual([]);
      const back = update(doc, full, source(l));
      expect(rowsOf(back.r)).toContain(`${key} unit`);
      expect(listUnits(doc).map((i) => i.key)).toEqual([key]);
    },
  );

  it.each(['prop', 'set'] as const)(
    'replaces a %s by another library item saved from the placed instance',
    (kind) => {
      const L = library();
      const a = kind === 'prop' ? L.kite : L.set;
      const { doc } = staged(withPins(openBrief(), pinOf(kind, a)), source(a));
      // saved as a new item (not a new version): its parts keep the instance's source ids
      const ex =
        kind === 'prop'
          ? extractUnit(
              doc,
              { kind: 'prop', root: propOf(doc, KITE).id, name: 'Blue kite' },
              { deskVersion: 'test' },
            )
          : extractUnit(doc, { kind: 'set', name: 'Meadow at dusk' }, { deskVersion: 'test' });
      expect(ex.basedOn).toEqual({ ref: a.pin.ref, version: 1 });
      const b = lib(`${a.pin.ref.slice(0, -4)}xxxB`, 1, ex.data);
      const u = update(doc, withPins(openBrief(), pinOf(kind, b)), source(b));
      expect(u.changes?.other).toEqual([
        kind === 'prop' ? '1 prop with a new library version' : 'another library set',
      ]);
      expect(listUnits(doc).map((i) => [i.key, i.ref])).toEqual([[slotOf(kind), b.pin.ref]]);
      expect(unitStatus(doc, listUnits(doc)[0].root)).toEqual({ edited: [], missing: [] });
    },
  );
});

describe('a unit that cannot be used is refused, with its reason', () => {
  /** The A1 fixture's open: its unit bytes are text, not unit files. */
  const fixture = (name: string) => {
    const open = JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
    const given: GivenUnit[] = open.units.map(
      (u: { ref: string; version: number; sha256: string; unit: { data: { $bytes: string } } }) => ({
        ref: u.ref,
        version: u.version,
        sha256: u.sha256,
        data: Uint8Array.from(Buffer.from(u.unit.data.$bytes, 'base64')),
      }),
    );
    return { scene: open.scene as SceneBrief, given };
  };

  it.each(['open-units.json', 'open-units-figure-hints.json'])(
    '%s: its files hash to their pins but are not units (unreadable)',
    (name) => {
      const { scene, given } = fixture(name);
      for (const g of given) expect(sha256Hex(g.data)).toBe(g.sha256);
      const { doc, r } = staged(scene, unitSourceOf(given));
      expect(rowsOf(r)).toEqual([
        'set words unreadable',
        `cast:${MIRA} words unreadable`,
        `el:${KITE} words unreadable`,
      ]);
      expect(listUnits(doc)).toEqual([]);
      expect(readBriefRecord(doc)!.setUnit).toMatchObject({ staged: 'refused', why: 'unreadable' });
      // the brief's words stand in (with the figure's kind and height as hints, when the host sends them)
      const words = staged(briefWithoutPins(scene)).doc;
      for (const k of ['desk_kind', 'desk_height_m'])
        expect(prop(actorOf(doc, MIRA), k), k).toBe(prop(actorOf(words, MIRA), k));
      // refused: not tried again, so not wanted and no change
      expect(pinsWanted(doc, scene)).toEqual([]);
      expect(update(doc, scene, unitSourceOf(given)).changes).toBeNull();
    },
  );

  it('files that are not the pinned ones are pending (mismatch), tried again at the next open', () => {
    const { scene, given } = fixture('open-units.json');
    const other = given.map((g) => ({ ...g, sha256: 'f'.repeat(64) }));
    const { doc, r } = staged(scene, unitSourceOf(other));
    expect(rowsOf(r)).toEqual([
      'set words mismatch',
      `cast:${MIRA} words mismatch`,
      `el:${KITE} words mismatch`,
    ]);
    expect(recordElement(doc, KITE).unit).toMatchObject({ staged: 'pending', why: 'mismatch' });
    expect(pinsWanted(doc, scene)).toHaveLength(3);
    // as the caller reports it, for bytes that do not hash to their SHA-256
    const told = staged(
      scene,
      unitSourceOf(
        [],
        given.map((g) => ({ ref: g.ref, version: g.version, staged: 'pending', why: 'mismatch' })),
      ),
    );
    expect(rowsOf(told.r)).toEqual(rowsOf(r));
  });

  it('refuses each reason a unit cannot be used for, and records it', () => {
    const L = library();
    const set = (data: Uint8Array) => lib('lib_0123456789mead', 7, data);
    const fig = (data: Uint8Array) => lib('lib_0123456789mira', 7, data);
    const cases: [string, SceneBrief, UnitSource, string][] = [];
    const tooNew = set(reheadered(L.units.set, (h) => (h.schemaVersion = SCHEMA_VERSION + 1)));
    cases.push(['too_new', withPins(openBrief(), { set: tooNew }), source(tooNew), 'set']);
    const off = set(reheadered(L.units.set, (h) => (h.set!.groundZ = 0.5)));
    cases.push(['set_ground', withPins(openBrief(), { set: off }), source(off), 'set']);
    cases.push(['wrong_kind', withPins(openBrief(), { set: L.kite }), source(L.kite), 'set']);
    const duck = fig(reheadered(L.units.mira, (h) => (h.figure!.kind = 'duck')));
    cases.push([
      'figure_kind',
      withPins(openBrief(), { cast: { [MIRA]: duck } }),
      source(duck),
      `cast:${MIRA}`,
    ]);
    const rig = fig(reheadered(L.units.mira, (h) => (h.figure!.rig = 'f'.repeat(64))));
    cases.push(['figure_rig', withPins(openBrief(), { cast: { [MIRA]: rig } }), source(rig), `cast:${MIRA}`]);
    cases.push([
      'too_large',
      withPins(openBrief(), { el: { [KITE]: L.kite } }),
      unitSourceOf([], [{ ...pick(L.kite), staged: 'refused', why: 'too_large' }]),
      `el:${KITE}`,
    ]);
    for (const [why, b, units, slot] of cases) {
      const { doc, r } = staged(b, units);
      expect(rowsOf(r), why).toEqual([`${slot} words ${why}`]);
      expect(listUnits(doc), why).toEqual([]);
      expect(stateUnitRows(doc), why).toEqual([expect.objectContaining({ slot, staged: 'refused', why })]);
      expect(libraryWarnings(r)[0], why).toMatch(
        /cannot be used \(.+\): (the set|a mannequin|the prop) from the words stands in$/,
      );
      expect(pinsWanted(doc, b), why).toEqual([]);
      expect(update(doc, b, units).changes, why).toBeNull();
    }
    // read errors: a newer unit, one too large, anything else the unit's (unreadable), the desk's own (pending)
    expect(unitReadProblem(new UnitError('UNIT_VERSION', 'v2')).why).toBe('too_new');
    expect(unitReadProblem(new UnitError('UNIT_TOO_LARGE', 'big')).why).toBe('too_large');
    expect(unitReadProblem(new UnitError('UNIT_CORRUPT', 'bad')).why).toBe('unreadable');
    expect(unitReadProblem(new RangeError('out of memory'))).toMatchObject({
      staged: 'pending',
      why: 'unavailable',
    });
  });

  it('keeps a staged actor of another kind or height and refuses the figure (not tried again)', () => {
    const L = library();
    const { doc } = staged(openBrief());
    const mira = actorOf(doc, MIRA).id;
    // Pip's figure (a dog) pinned on Mira (a child)
    const dog = withPins(openBrief(), { cast: { [MIRA]: L.pip } });
    const u = update(doc, dog, source(L.pip));
    expect(u.changes).toBeNull();
    expect(rowsOf(u.r)).toEqual([`cast:${MIRA} words figure_kind`]);
    expect(libraryWarnings(u.r)[0]).toContain('Mira is staged as a child of 1.28 m');
    expect(actorOf(doc, MIRA).id).toBe(mira);
    expect(readInstance(doc, mira)).toBeNull();
    expect(recordCast(doc, MIRA).unit).toMatchObject({ staged: 'refused', why: 'figure_kind' });
    expect(pinsWanted(doc, dog)).toEqual([]);
    // a taller Mira
    const tall = lib(
      'lib_0123456789mira',
      3,
      reheadered(L.units.mira, (h) => (h.figure!.heightM = 1.4)),
    );
    const t = update(doc, withPins(openBrief(), { cast: { [MIRA]: tall } }), source(tall));
    expect(rowsOf(t.r)).toEqual([`cast:${MIRA} words figure_rig`]);
    expect(readInstance(doc, mira)).toBeNull();
  });
});

describe('the units one staging takes (48 MiB of files)', () => {
  const MiB = 2 ** 20;
  const pins = ['a', 'b', 'c'].map((ref) => ({ ref, version: 1 }));

  it('counts in slot order: what fits, what does not this time, what never can', () => {
    const sizes: Record<string, { packed: number; unpacked: number }> = {
      a: { packed: 30 * MiB, unpacked: 60 * MiB },
      b: { packed: 30 * MiB, unpacked: 60 * MiB },
      c: { packed: 10 * MiB, unpacked: 20 * MiB },
    };
    const r = unitBudget(pins, (p) => sizes[p.ref]);
    expect([...r.verdicts]).toEqual([
      ['a@1', 'fits'],
      ['b@1', 'unavailable'],
      ['c@1', 'fits'],
    ]);
    expect(r.packed).toBe(40 * MiB);
    const big = unitBudget(pins.slice(0, 1), () => ({
      packed: MiB,
      unpacked: UNIT_BUDGET.unpackedBytes + 1,
    }));
    expect(big.verdicts.get('a@1')).toBe('over_budget');
    // each version once, and one without a size left out
    expect([
      ...unitBudget([pins[0], pins[0], pins[1]], (p) => (p.ref === 'a' ? sizes.a : null)).verdicts,
    ]).toEqual([['a@1', 'fits']]);
  });

  it('stages a unit that can never fit from the words (refused), one that does not fit this time pending', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set, el: { [KITE]: L.kite } });
    const real = source(L.set, L.kite);
    const bodies = (n: (ref: string) => number): UnitSource => ({
      ...real,
      header: (pin) => {
        const h = real.header(pin);
        return h && { ...h, bodyBytes: n(pin.ref) };
      },
    });
    const huge = staged(
      b,
      bodies((ref) => (ref === L.set.pin.ref ? 100 * MiB : 1000)),
    );
    expect(rowsOf(huge.r)).toEqual(['set words over_budget', `el:${KITE} unit`]);
    expect(readBriefRecord(huge.doc)!.setUnit).toMatchObject({ staged: 'refused', why: 'over_budget' });
    const full = staged(
      b,
      bodies(() => 50 * MiB),
    );
    expect(rowsOf(full.r)).toEqual(['set unit', `el:${KITE} words unavailable`]);
    expect(recordElement(full.doc, KITE).unit).toMatchObject({ staged: 'pending', why: 'unavailable' });
    expect(pinsWanted(full.doc, b)).toEqual([L.kite.pin]);
  });
});

describe('a pin on a location', () => {
  it('is ignored with a warning: the place’s set is the set’s own pin', () => {
    const L = library();
    const b = withPins(openBrief(), { el: { [LOCATION]: L.set } });
    const { doc, r } = staged(b, source(L.set));
    expect(r.units).toEqual([]);
    expect(r.warnings).toContain(
      "The meadow's library unit lib_0123456789mead@1 is ignored: the place's set is the set's own pin (set.unit)",
    );
    expect(listUnits(doc)).toEqual([]);
    expect('unit' in recordElement(doc, LOCATION)).toBe(false);
    expect(briefPins(b)).toEqual([]);
  });
});

describe('figures', () => {
  it('restyles the staged actor in place: its armature, keys, holds and shots stay', () => {
    const L = library();
    const { doc } = staged(openBrief());
    const mira = actorOf(doc, MIRA);
    const curves = doc.listFCurves(mira.id).length;
    // Mira flies the kite: its tether names her armature and hand
    const flights = () => String(prop(propOf(doc, KITE), 'desk_tether_flights'));
    const flight = flights();
    expect(flight).toContain(`@${mira.id}/hand.R`);
    const pose = JSON.stringify(mira.pose);
    const subjects = JSON.stringify(getShots(doc).map((s) => s.subjects));
    const b = withPins(openBrief(), { cast: { [MIRA]: L.mira } });
    const u = update(doc, b, source(L.mira));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: ['1 cast member from the library'] });
    const now = actorOf(doc, MIRA);
    expect(now.id).toBe(mira.id);
    expect(readInstance(doc, now.id)?.key).toBe(`cast:${MIRA}`);
    expect(doc.listFCurves(now.id)).toHaveLength(curves);
    expect(JSON.stringify(now.pose)).toBe(pose);
    expect(flights()).toBe(flight);
    expect(JSON.stringify(getShots(doc).map((s) => s.subjects))).toBe(subjects);
    expect(recordCast(doc, MIRA).unit).toEqual({ ...L.mira.pin, staged: 'unit' });

    // the pin removed: the mannequin of her kind and height again, the same armature
    const parts = doc.listObjects().filter((o) => prop(o, 'desk_actor') === mira.id).length;
    const back = update(doc, withPins(b, { cast: { [MIRA]: null } }));
    expect(back.changes).toEqual({ ...NOTHING_LISTED, other: ['1 cast member back to a mannequin'] });
    expect(actorOf(doc, MIRA).id).toBe(mira.id);
    expect(readInstance(doc, mira.id)).toBeNull();
    expect(listUnits(doc)).toEqual([]);
    expect(doc.listObjects().filter((o) => prop(o, 'desk_actor') === mira.id)).toHaveLength(parts);
    expect(doc.listFCurves(mira.id)).toHaveLength(curves);
    expect(flights()).toBe(flight);
    expect('unit' in recordCast(doc, MIRA)).toBe(false);
  });
});

describe('adoptPublished', () => {
  it.each([true, false])(
    'links a published prop (linked %s); the next brief pinning it changes nothing',
    (linked) => {
      const { doc } = staged(openBrief());
      const ex = extractUnit(
        doc,
        { kind: 'prop', root: propOf(doc, KITE).id, name: 'Red kite' },
        { deskVersion: 'test' },
      );
      const pin = { ref: 'lib_0123456789kite', version: 1, sha256: ex.sha256 };
      const r = adoptPublished(doc, openBrief(), {
        slot: ex.from,
        link: ex.link,
        pin,
        linked,
        header: ex.header,
      });
      expect(r.recorded).toBe(linked);
      expect(readInstance(doc, propOf(doc, KITE).id)?.key).toBe(`el:${KITE}`);
      expect(recordElement(doc, KITE).unit).toEqual(linked ? { ...pin, staged: 'unit' } : undefined);
      // the host pins it next when linked, and sends the brief as it was when not: no change either way
      const next = structuredClone(openBrief());
      if (linked) next.elements.find((e) => e.id === KITE)!.unit = pin;
      expect(briefChanges(doc, next)).toBeNull();
      expect(update(doc, next).changes).toBeNull();
      expect(stateUnitRows(doc)).toHaveLength(linked ? 1 : 0);
    },
  );

  it.each([true, false])(
    'links a published set (linked %s): the record’s set is the unit’s only when linked',
    (linked) => {
      const { doc } = staged(openBrief());
      const before = readBriefRecord(doc)!.set;
      const ex = extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
      const pin = { ref: 'lib_0123456789mead', version: 1, sha256: ex.sha256 };
      const r = adoptPublished(doc, openBrief(), {
        slot: ex.from,
        link: ex.link,
        pin,
        linked,
        header: ex.header,
      });
      const root = doc.getObject(r.root)!;
      expect(prop(root, 'desk_role')).toBe('set');
      expect(prop(root, 'desk_rideo_clip')).toBe(openBrief().id);
      expect(readBriefRecord(doc)!.set !== before).toBe(linked);
      expect(readBriefRecord(doc)!.setUnit).toEqual(linked ? { ...pin, staged: 'unit' } : undefined);
      // the host pins it next when linked, and sends the brief as it was when not
      const next = structuredClone(openBrief());
      if (linked) next.set.unit = pin;
      expect(briefChanges(doc, next)).toBeNull();
      expect(update(doc, next).changes).toBeNull();
      expect(stateUnitRows(doc)).toHaveLength(linked ? 1 : 0);
    },
  );
});

describe('the blocking export of a library set', () => {
  it('writes no landmark of its pieces, so that importing it again adds no copies', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set });
    const { doc } = staged(b, source(L.set));
    const out = exportRideoBlocking(doc);
    expect(out.blocking.set.landmarks).toEqual([]);
    expect(out.blocking.set.ground).toBe('grass');
    expect(out.warnings).toContain(
      "the set is the library's 'Meadow': its 1 piece(s) are not written as landmarks (a re-import keeps the set)",
    );
    const count = () => ({
      landmarks: doc.listObjects().filter((o) => prop(o, 'desk_role') === 'landmark').length,
      grounds: doc.listObjects().filter((o) => prop(o, 'desk_label') === 'ground').length,
      units: listUnits(doc).length,
    });
    const was = count();
    const input = planBrief(b).input;
    doc.transact(() =>
      importRideoBlocking(
        docContext(doc),
        { ...input, blocking: out.blocking, update: true },
        solveShotCameras,
      ),
    );
    expect(count()).toEqual(was);
  });

  it('keeps the pieces of a set published from the scene through a re-import and a new sun', () => {
    const { doc } = staged(openBrief());
    const ex = extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    const pin = { ref: 'lib_0123456789mead', version: 1, sha256: ex.sha256 };
    adoptPublished(doc, openBrief(), { slot: ex.from, link: ex.link, pin, linked: false, header: ex.header });
    const pieces = () =>
      doc
        .listObjects()
        .filter((o) => prop(o, 'desk_role') === 'landmark')
        .map((o) => [o.id, unitOf(doc, o.id) !== null]);
    const was = pieces();
    expect(was).toEqual([[expect.any(String), true]]);
    // the blocking written and read again: the pond stays the unit's, and no copy is made
    const out = exportRideoBlocking(doc);
    expect(out.blocking.set.landmarks).toEqual([]);
    const input = planBrief(openBrief()).input;
    doc.transact(() =>
      importRideoBlocking(
        docContext(doc),
        { ...input, blocking: out.blocking, update: true },
        solveShotCameras,
      ),
    );
    expect(pieces()).toEqual(was);
    // a new sun relights the set (an instance, though the brief pins none) and builds no landmark
    const dusk = openBrief();
    dusk.set.timeOfDay = 'dusk';
    expect(update(doc, dusk).changes?.other).toEqual(['the set']);
    expect(pieces()).toEqual(was);
  });
});
