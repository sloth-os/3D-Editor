import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { SCHEMA_VERSION } from '../src/doc/types';
import { solveShotCameras } from '../src/operators/desk-shots';
import {
  UNIT_BUDGET,
  adoptPublished,
  briefChanges,
  briefPins,
  briefWithoutPins,
  forgetPublish,
  pendingPublishes,
  pinsRefused,
  pinsWanted,
  planInfoOf,
  recordPublish,
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
import { UNIT_MAGIC, gzipDeterministic, sha256Hex, writeContainer } from '../src/desk/container';
import { exportRideoBlocking } from '../src/desk/rideo';
import { importRideoBlocking } from '../src/desk/rideo/import';
import { getShots } from '../src/desk/shots';
import {
  UnitError,
  decodeUnit,
  deriveUnitId,
  encodeUnit,
  encodeUnitBody,
  extractUnit,
  listUnits,
  makeLocal,
  readInstance,
  unitOf,
  unitStatus,
  updateUnit,
  type UnitHeaderInput,
  type UnitPayload,
} from '../src/desk/units';
import { deskDrop } from '../src/desk/physics/presets';
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

/** Library version `l` (same ref and version) with its body's manifest edited by hand, written without checks. */
function crafted(l: Lib, edit: (manifest: string) => string): Lib {
  const unit = decodeUnit(l.given.data);
  const raw = encodeUnitBody(unit.body).bytes;
  const n = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
  const text = new TextEncoder().encode(edit(new TextDecoder().decode(raw.subarray(4, 4 + n))));
  const blobs = raw.subarray(4 + n);
  const body = new Uint8Array(4 + text.length + blobs.length);
  new DataView(body.buffer).setUint32(0, text.length, true);
  body.set(text, 4);
  body.set(blobs, 4 + text.length);
  const header = { ...unit.header, digest: sha256Hex(body), bodyBytes: body.length };
  const data = writeContainer({
    magic: UNIT_MAGIC,
    version: 1,
    codec: 'gzip',
    header: new TextEncoder().encode(JSON.stringify(header)),
    payload: gzipDeterministic(body),
  });
  return lib(l.pin.ref, l.pin.version, data);
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

/** The pins the record refuses, as 'slot ref@version'. */
const refusals = (doc: SceneDoc) =>
  stateUnitRows(doc)
    .filter((x) => x.staged === 'refused')
    .map((x) => `${x.slot} ${x.ref}@${x.version}`);

/**
 * Updates `doc` to `b` and checks that briefChanges (given the same units) was null exactly when
 * the update changed nothing of the staging and refused no pin the record did not refuse already
 * (a pin the desk holds but cannot use is a change once: the update records why). Returns the
 * update's report and the changes.
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

const NOTHING_LISTED = { added: [], removed: [], retimed: [], recast: [], cast: { added: [], removed: [] } };

/** briefChanges' words of a pin whose unit the desk holds but cannot use (one slot). */
const REFUSED_WORDS = {
  set: 'a library set that cannot be used',
  figure: '1 cast member with a library figure that cannot be used',
  prop: '1 prop with a library version that cannot be used',
} as const;

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

  it('keeps a slot made local whatever a later brief pins, with the ref@version it was made local from', () => {
    const L = library();
    const b = withPins(openBrief(), { el: { [KITE]: L.kite } });
    const { doc } = staged(b, source(L.kite));
    const kite = listUnits(doc)[0].root;
    makeLocal(doc, kite);
    const row = {
      slot: `el:${KITE}`,
      ...pick(L.kite),
      sha256: L.kite.pin.sha256,
      staged: 'unit',
      local: true,
    };
    expect(stateUnitRows(doc)).toEqual([row]);
    // a new version of the item, or no pin: no file wanted (a host may leave it out), nothing placed
    for (const later of [withPins(b, { el: { [KITE]: L.kite2 } }), withPins(b, { el: { [KITE]: null } })]) {
      expect(pinsWanted(doc, later)).toEqual([]);
      const u = update(doc, later, source(L.kite, L.kite2));
      expect(u.changes).toBeNull();
      expect(listUnits(doc)).toEqual([]);
      expect(doc.getObject(kite)).not.toBeNull();
      expect(stateUnitRows(doc)).toEqual([row]);
    }
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

describe('what the person put on an actor or a prop stays when its look changes', () => {
  /** A backpack built in the scene and put on `parent` (on its bone `bone` when given): its objects. */
  function backpack(doc: SceneDoc, parent: string, bone?: string): { root: string; objects: string[] } {
    const r = BUILTIN_CATALOG.find((e) => e.id === 'backpack')!.build(doc, { location: [0, 0, 1] });
    doc.updateObject(r.root, {
      parent,
      ...(bone ? { parent_type: 'BONE' as const, parent_bone: bone } : {}),
    });
    return { root: r.root, objects: r.objects };
  }
  const below = (
    doc: SceneDoc,
    root: string,
    keep: (o: ReturnType<SceneDoc['listObjects']>[number]) => boolean,
  ) =>
    doc
      .listObjects()
      .filter((o) => o.parent === root && keep(o))
      .map((o) => o.id);

  it('a figure pinned for a mannequin takes only its parts; back to the mannequin takes only the figure', () => {
    const L = library();
    const { doc } = staged(openBrief());
    const mira = actorOf(doc, MIRA).id;
    const pack = backpack(doc, mira, 'head');
    const mannequin = below(doc, mira, (o) => o.custom_props.desk_actor === mira);
    expect(mannequin).toHaveLength(21);
    const kept = "Mira: keeps 'Backpack', which is not part of the look the library figure replaces";

    const on = update(doc, withPins(openBrief(), { cast: { [MIRA]: L.mira } }), source(L.mira));
    expect(rowsOf(on.r)).toContain(`cast:${MIRA} unit`);
    expect(readInstance(doc, mira)?.ref).toBe(L.mira.pin.ref);
    for (const id of mannequin) expect(doc.has('objects', id)).toBe(false);
    for (const id of pack.objects) expect(doc.has('objects', id)).toBe(true);
    expect(doc.getObject(pack.root)).toMatchObject({
      parent: mira,
      parent_type: 'BONE',
      parent_bone: 'head',
    });
    expect(on.r.warnings).toContain(kept);
    expect(unitStatus(doc, mira)).toEqual({ edited: [], missing: [] });

    const figure = [...readInstance(doc, mira)!.parts.values()].map((p) => p.id).filter((id) => id !== mira);
    const off = update(doc, openBrief(), source(L.mira));
    expect(listUnits(doc)).toEqual([]);
    for (const id of figure) expect(doc.has('objects', id)).toBe(false);
    expect(below(doc, mira, (o) => o.custom_props.desk_actor === mira)).toHaveLength(21);
    for (const id of pack.objects) expect(doc.has('objects', id)).toBe(true);
    expect(doc.getObject(pack.root)).toMatchObject({
      parent: mira,
      parent_type: 'BONE',
      parent_bone: 'head',
    });
    expect(off.r.warnings).toContain(
      "Mira: keeps 'Backpack', which is not part of the library figure's look",
    );
  });

  it("a library prop pinned for a prop built from the words takes only the built model's parts", () => {
    const L = library();
    const { doc } = staged(openBrief());
    const kite = propOf(doc, KITE);
    const pack = backpack(doc, kite.id);
    const built = below(doc, kite.id, (o) => o.custom_props.store_part !== undefined);
    expect(built.length).toBeGreaterThan(3);
    const on = update(doc, withPins(openBrief(), { el: { [KITE]: L.kite } }), source(L.kite));
    expect(rowsOf(on.r)).toContain(`el:${KITE} unit`);
    expect(propOf(doc, KITE).id).toBe(kite.id);
    for (const id of built) expect(doc.has('objects', id)).toBe(false);
    for (const id of pack.objects) expect(doc.has('objects', id)).toBe(true);
    expect(doc.getObject(pack.root)?.parent).toBe(kite.id);
    expect(on.r.warnings).toContain(
      `${kite.name}: keeps 'Backpack', which is not part of the look the library prop replaces`,
    );
    expect(unitStatus(doc, kite.id)).toEqual({ edited: [], missing: [] });
  });
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

  it.each([
    ['a number that is not finite', (m: string) => m.replace('"scale":[', '"scale":[1e400,')],
    [
      'a key named __proto__',
      (m: string) => m.replace('"custom_props":{', '"custom_props":{"__proto__":{"x":1},'),
    ],
    [
      'a value nested 10,000 deep',
      (m: string) =>
        m.replace('"custom_props":{', `"custom_props":{"deep":${'['.repeat(10_000)}${']'.repeat(10_000)},`),
    ],
  ])('a kite file with %s is refused (unreadable) beside a good set, which is placed', (_what, edit) => {
    const L = library();
    const bad = crafted(L.kite, edit);
    const { doc, r } = staged(withPins(openBrief(), { set: L.set, el: { [KITE]: bad } }), source(L.set, bad));
    expect(rowsOf(r)).toEqual(['set unit', `el:${KITE} words unreadable`]);
    expect(listUnits(doc).map((i) => i.key)).toEqual(['set']);
    expect(recordElement(doc, KITE).unit).toMatchObject({ staged: 'refused', why: 'unreadable' });
  });

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
    // Pip's figure (a dog) pinned on Mira (a child): offered once, so that the refusal is recorded
    const dog = withPins(openBrief(), { cast: { [MIRA]: L.pip } });
    const u = update(doc, dog, source(L.pip));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: [REFUSED_WORDS.figure] });
    expect(rowsOf(u.r)).toEqual([`cast:${MIRA} words figure_kind`]);
    expect(libraryWarnings(u.r)[0]).toContain('Mira is staged as a child of 1.28 m');
    expect(actorOf(doc, MIRA).id).toBe(mira);
    expect(readInstance(doc, mira)).toBeNull();
    expect(recordCast(doc, MIRA).unit).toMatchObject({ staged: 'refused', why: 'figure_kind' });
    expect(pinsWanted(doc, dog)).toEqual([]);
    expect(update(doc, dog, source(L.pip)).changes).toBeNull();
    // a taller Mira
    const tall = lib(
      'lib_0123456789mira',
      3,
      reheadered(L.units.mira, (h) => (h.figure!.heightM = 1.4)),
    );
    const t = update(doc, withPins(openBrief(), { cast: { [MIRA]: tall } }), source(tall));
    expect(t.changes?.other).toEqual([REFUSED_WORDS.figure]);
    expect(rowsOf(t.r)).toEqual([`cast:${MIRA} words figure_rig`]);
    expect(readInstance(doc, mira)).toBeNull();
  });
});

describe('a pin the desk holds but cannot use is a change until an update records it', () => {
  it('a figure v2 of another height over v1 placed: offered once, recorded refused (figure_rig), v1 stays', () => {
    const L = library();
    const b1 = withPins(openBrief(), { cast: { [MIRA]: L.mira } });
    const { doc } = staged(b1, source(L.mira));
    const actor = actorOf(doc, MIRA).id;
    const h1 = Number(prop(actorOf(doc, MIRA), 'desk_height_m'));
    // v2 of the item, 6 cm taller; the host sends the figure's height as the member's
    const v2 = lib(
      L.mira.pin.ref,
      2,
      reheadered(L.units.mira, (h) => (h.figure!.heightM = h1 + 0.06)),
    );
    const b2 = withPins(openBrief(), { cast: { [MIRA]: v2 } });
    b2.cast.find((c) => c.id === MIRA)!.heightM = Math.round((h1 + 0.06) * 100) / 100;
    // the file is kept for the update that records the refusal, which the desk can name now
    expect(pinsWanted(doc, b2)).toEqual([v2.pin]);
    expect(pinsRefused(doc, b2, source(v2))).toEqual([
      {
        slot: `cast:${MIRA}`,
        pin: v2.pin,
        why: 'figure_rig',
        message: expect.stringContaining('Mira is staged as a child of 1.28 m'),
      },
    ]);
    const u = update(doc, b2, source(v2));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: [REFUSED_WORDS.figure] });
    expect(rowsOf(u.r)).toEqual([`cast:${MIRA} words figure_rig`]);
    // the actor stays the v1 figure (the brief's height is not used), with why v2 is not
    expect(libraryWarnings(u.r)).toEqual([
      "Mira's library figure 'Mira' is 1.28 m tall: the brief's height 1.34 m is not used",
      expect.stringMatching(/^Mira's library figure lib_0123456789mira v2 cannot be used \(.+\): v1 stays$/),
    ]);
    expect(stateUnitRows(doc)).toEqual([
      {
        slot: `cast:${MIRA}`,
        ...pick(v2),
        sha256: v2.pin.sha256,
        staged: 'refused',
        local: false,
        why: 'figure_rig',
      },
    ]);
    expect(readInstance(doc, actor)).toMatchObject({ ref: L.mira.pin.ref, version: 1 });
    // recorded: no change any more, and the file is not wanted
    expect(briefChanges(doc, b2, { units: source(v2) })).toBeNull();
    expect(pinsWanted(doc, b2)).toEqual([]);
    expect(pinsRefused(doc, b2, source(v2))).toEqual([]);
    expect(update(doc, b2, source(v2)).changes).toBeNull();
  });

  it.each([
    ['set', 'too_new'],
    ['prop', 'unreadable'],
  ] as const)(
    'a %s v2 that cannot be used (%s) over v1 placed: offered once, recorded refused',
    (kind, why) => {
      const L = library();
      const v1 = kind === 'set' ? L.set : L.kite;
      const v2 =
        kind === 'set'
          ? lib(
              v1.pin.ref,
              2,
              reheadered(L.units.set, (h) => (h.schemaVersion = SCHEMA_VERSION + 1)),
            )
          : lib(v1.pin.ref, 2, new TextEncoder().encode('not a unit'));
      const pins = (l: Lib) => (kind === 'set' ? { set: l } : { el: { [KITE]: l } });
      const slot = kind === 'set' ? 'set' : `el:${KITE}`;
      const { doc } = staged(withPins(openBrief(), pins(v1)), source(v1));
      const b2 = withPins(openBrief(), pins(v2));
      const u = update(doc, b2, source(v2));
      expect(u.changes).toEqual({ ...NOTHING_LISTED, other: [REFUSED_WORDS[kind]] });
      expect(rowsOf(u.r)).toEqual([`${slot} words ${why}`]);
      expect(stateUnitRows(doc)).toEqual([
        expect.objectContaining({ slot, version: 2, staged: 'refused', why }),
      ]);
      expect(listUnits(doc).map((i) => [i.key, i.version])).toEqual([[slot, 1]]);
      expect(update(doc, b2, source(v2)).changes).toBeNull();
      expect(pinsWanted(doc, b2)).toEqual([]);
    },
  );

  it('a pending pin whose file comes and cannot be used: offered although the brief is the one staged', () => {
    const L = library();
    const bad = lib(L.kite.pin.ref, 1, new TextEncoder().encode('not a unit'));
    const b = withPins(openBrief(), { el: { [KITE]: bad } });
    const { doc } = staged(b, unitSourceOf([]));
    expect(recordElement(doc, KITE).unit).toMatchObject({ staged: 'pending', why: 'missing' });
    const u = update(doc, b, source(bad));
    expect(u.changes).toEqual({ ...NOTHING_LISTED, other: [REFUSED_WORDS.prop] });
    expect(recordElement(doc, KITE).unit).toMatchObject({ staged: 'refused', why: 'unreadable' });
    expect(update(doc, b, source(bad)).changes).toBeNull();
    // and with other changes: said beside them
    const later = structuredClone(b);
    later.fps = 30;
    const { doc: other } = staged(b, unitSourceOf([]));
    expect(briefChanges(other, later, { units: source(bad) })?.other).toEqual([
      'the frame rate (24 to 30 fps)',
      REFUSED_WORDS.prop,
    ]);
  });

  it('several members and props: counted, beside what is placed', () => {
    const L = library();
    const { doc } = staged(openBrief());
    const notAUnit = (ref: string) => lib(ref, 1, new TextEncoder().encode(`not a unit: ${ref}`));
    const b = withPins(openBrief(), {
      set: L.set,
      cast: { [MIRA]: notAUnit('lib_0123456789mir1'), [PIP]: notAUnit('lib_0123456789pip1') },
      el: { [KITE]: notAUnit('lib_0123456789kit1') },
    });
    const pinned = briefPins(b).map((p) => p.pin.ref);
    const held = source(L.set, ...pinned.filter((ref) => ref !== L.set.pin.ref).map((ref) => notAUnit(ref)));
    const u = update(doc, b, held);
    expect(u.changes?.other).toEqual([
      'the set from the library',
      '2 cast members with a library figure that cannot be used',
      REFUSED_WORDS.prop,
    ]);
    expect(rowsOf(u.r)).toEqual([
      'set unit',
      `cast:${MIRA} words unreadable`,
      `cast:${PIP} words unreadable`,
      `el:${KITE} words unreadable`,
    ]);
  });
});

describe('the units one staging takes (48 MiB of files, 160 MiB unpacked)', () => {
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
    // a version pinned in several slots: its file and its body once, the scene's copy in each slot;
    // one without a size left out
    const each = unitBudget([pins[0], pins[2], pins[0], pins[1], pins[0], pins[0]], (p) =>
      p.ref === 'b' ? null : { ...sizes[p.ref], copy: sizes[p.ref].unpacked / 2 },
    );
    expect(each.slots).toEqual(['fits', 'fits', 'fits', null, 'fits', 'unavailable']);
    expect([...each.verdicts]).toEqual([
      ['a@1', 'fits'],
      ['c@1', 'fits'],
    ]);
    expect([each.packed, each.unpacked]).toEqual([40 * MiB, 140 * MiB]);
    // a size without its copy: each slot takes the whole unpacked bound
    expect(unitBudget([pins[0], pins[0], pins[0]], () => sizes.a).slots).toEqual([
      'fits',
      'fits',
      'unavailable',
    ]);
  });

  /** The brief with `n` more props pinned to the kite's version (in the first shot). */
  const kites = (n: number): SceneBrief => {
    const b = openBrief();
    for (let i = 1; i <= n; i++) {
      b.elements.push({
        id: `ele_0123456789kit${i}`,
        name: `Kite ${i}`,
        description: 'A red kite.',
        kind: 'prop',
        unit: library().kite.pin,
      });
      b.shots[0].elementIds.push(`ele_0123456789kit${i}`);
    }
    return b;
  };
  const kiteRows = (placed: number, n = 4) =>
    Array.from({ length: n }, (_, i) =>
      i < placed ? `el:ele_0123456789kit${i + 1} unit` : `el:ele_0123456789kit${i + 1} words unavailable`,
    );

  it('counts a version pinned in several slots: its file and body once, the scene’s copy in each slot', () => {
    const real = source(library().kite);
    // a header saying 40 MiB a body: the first slot takes 80 MiB unpacked (the body and its copy), each further one 40 MiB
    const big: UnitSource = {
      ...real,
      header: (pin) => {
        const h = real.header(pin);
        return h && { ...h, bodyBytes: 40 * MiB };
      },
    };
    expect(rowsOf(staged(kites(1), big).r)).toEqual(kiteRows(1, 1));
    const four = staged(kites(4), big);
    expect(rowsOf(four.r)).toEqual(kiteRows(3));
    expect(listUnits(four.doc)).toHaveLength(3);
    expect(recordElement(four.doc, 'ele_0123456789kit4').unit).toMatchObject({
      staged: 'pending',
      why: 'unavailable',
    });
    expect(four.r.warnings).toContainEqual(
      expect.stringContaining(
        `Kite 4's library unit lib_0123456789kite@1 does not fit what the units before it left of this staging's budget`,
      ),
    );
    // the next update places the fourth: the other three hold the version already
    const u = update(four.doc, kites(4), big);
    expect(u.changes?.other).toEqual(['1 prop from the library']);
    expect(rowsOf(u.r)).toEqual(kiteRows(4));
    expect(listUnits(four.doc)).toHaveLength(4);
  });

  it('counts a decoded version’s body once and its copy, blob references written out, in each slot', () => {
    const real = source(library().kite);
    const expanded: UnitSource = { ...real, unit: (pin) => ({ ...real.unit(pin), expandedBytes: 40 * MiB }) };
    // the body (a few KiB) and four copies of 40 MiB are past 160 MiB: the fourth waits
    const four = staged(kites(4), expanded);
    expect(rowsOf(four.r)).toEqual(kiteRows(3));
    expect(listUnits(four.doc)).toHaveLength(3);
    expect(recordElement(four.doc, 'ele_0123456789kit4').unit).toMatchObject({
      staged: 'pending',
      why: 'unavailable',
    });
    expect(rowsOf(staged(kites(3), expanded).r)).toEqual(kiteRows(3, 3));
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

  it('counts a decoded unit with its blob references written out: pending when it no longer fits, refused when it never can', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set, el: { [KITE]: L.kite } });
    const real = source(L.set, L.kite);
    // what each unit copies into the scene: a crafted unit's shared blobs can make it far more than its body
    const expanded = (n: (ref: string) => number): UnitSource => ({
      ...real,
      unit: (pin) => ({ ...real.unit(pin), expandedBytes: n(pin.ref) }),
    });
    const full = staged(
      b,
      expanded(() => 100 * MiB),
    );
    expect(rowsOf(full.r)).toEqual(['set unit', `el:${KITE} words unavailable`]);
    expect(recordElement(full.doc, KITE).unit).toMatchObject({ staged: 'pending', why: 'unavailable' });
    expect(propOf(full.doc, KITE).custom_props.unit_ref).toBeUndefined();
    const huge = staged(
      b,
      expanded((ref) => (ref === L.set.pin.ref ? UNIT_BUDGET.unpackedBytes : 1000)),
    );
    expect(rowsOf(huge.r)).toEqual(['set words over_budget', `el:${KITE} unit`]);
    expect(readBriefRecord(huge.doc)!.setUnit).toMatchObject({ staged: 'refused', why: 'over_budget' });
    // the next update places only the kite, which fits on its own
    const u = update(
      full.doc,
      b,
      expanded(() => 100 * MiB),
    );
    expect(u.changes).not.toBeNull();
    expect(rowsOf(u.r)).toEqual(['set unit', `el:${KITE} unit`]);
  });
});

describe('physics on a library set', () => {
  it("a drop on the set's ground is no edit of the set, and the next version still updates the ground", () => {
    const L = library();
    const { doc } = staged(withPins(openBrief(), { set: L.set }), source(L.set));
    const set = listUnits(doc).find((i) => i.key === 'set')!;
    const ground = doc
      .listObjects()
      .find((o) => prop(o, 'desk_label') === 'ground' && o.parent === set.root)!;
    expect(ground.rigid_body).toBeNull();
    const ball = BUILTIN_CATALOG.find((e) => e.id === 'soccer_ball')!.build(doc, {
      location: [3, 3, 0],
    }).root;
    deskDrop(doc, [ball], { frame: 10, height: 2 });
    // the drop makes the ground a passive body: physics, which the scene owns on every part
    const body = doc.getObject(ground.id)!.rigid_body;
    expect(body).toMatchObject({ type: 'PASSIVE' });
    expect(unitStatus(doc, set.root)).toEqual({ edited: [], missing: [] });
    // a version whose ground is larger updates it in place and keeps the scene's body
    const v2 = editedUnit(L.units.set, (b) => {
      const g = Object.values(b.blocks.objects!).find(
        (r) => (r.custom_props as Record<string, unknown> | undefined)?.desk_label === 'ground',
      )!;
      g.scale = (g.scale as number[]).map((v) => v * 2);
    });
    const rep = updateUnit(doc, set.root, v2, {
      ref: L.set.pin.ref,
      version: 2,
      sha256: sha256Hex(v2.bytes),
    });
    expect(rep.updated.map((p) => p.id)).toContain(ground.id);
    expect(rep.kept.map((p) => p.id)).not.toContain(ground.id);
    expect(doc.getObject(ground.id)!.scale).toEqual((ground.scale as number[]).map((v) => v * 2));
    expect(doc.getObject(ground.id)!.rigid_body).toEqual(body);
    expect(unitStatus(doc, set.root)).toEqual({ edited: [], missing: [] });
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
  /** An animal figure of Pip as `kind` (a library version), and the brief pinning it as the host sends it. */
  function animalFigure(kind: 'dog' | 'horse'): { l: Lib; b: SceneBrief; heightM: number } {
    const src = openBrief();
    const pip = src.cast.find((c) => c.id === PIP)!;
    pip.kind = kind;
    if (kind === 'horse') pip.description = 'A brown horse.';
    const srcDoc = stagedDoc(src);
    const fig = unitFrom(srcDoc, { kind: 'figure', actor: actorOf(srcDoc, PIP).id, name: 'Pip' });
    srcDoc.destroy();
    const f = fig.ex.header.figure!;
    expect(f.kind).toBe(kind);
    const l = lib(`lib_0123456789${kind.slice(0, 4).padEnd(4, 'x')}`, 1, fig.ex.data);
    // with a figure pin the host sends the figure's kind and height (the desk's) as the member's
    const b = withPins(src, { cast: { [PIP]: l } });
    const c = b.cast.find((x) => x.id === PIP)!;
    c.kind = f.kind;
    c.heightM = f.heightM;
    return { l, b, heightM: f.heightM };
  }

  it.each(['dog', 'horse'] as const)(
    'stands a %s figure that is not here in at its own height, so that Update shots places it once it comes',
    (kind) => {
      const { l, b, heightM } = animalFigure(kind);
      const { doc, r } = staged(b, unitSourceOf([]));
      expect(rowsOf(r)).toEqual([`cast:${PIP} words missing`]);
      const stand = actorOf(doc, PIP);
      expect(prop(stand, 'desk_kind')).toBe(kind);
      expect(Number(prop(stand, 'desk_height_m'))).toBeCloseTo(heightM, 6);
      // the file comes at a later open: offered, and placed on the stand-in
      const u = update(doc, b, source(l));
      expect(u.changes).toEqual({ ...NOTHING_LISTED, other: ['1 cast member from the library'] });
      expect(rowsOf(u.r)).toEqual([`cast:${PIP} unit`]);
      expect(actorOf(doc, PIP).id).toBe(stand.id);
      expect(readInstance(doc, stand.id)).toMatchObject({ key: `cast:${PIP}`, ref: l.pin.ref, version: 1 });
      expect(recordCast(doc, PIP).unit).toEqual({ ...l.pin, staged: 'unit' });
    },
  );

  it('stands a member an update adds in at its pinned figure’s height, then places the figure', () => {
    const { l, b, heightM } = animalFigure('dog');
    // Pip in no shot at first: not staged
    const first = structuredClone(b);
    first.shots[0].castIds = [MIRA];
    first.shots[0].layout = first.shots[0].layout.filter((e) => e.castId !== PIP);
    const { doc } = staged(first, unitSourceOf([]));
    expect(() => actorOf(doc, PIP)).toThrow();
    const added = update(doc, b, unitSourceOf([]));
    expect(added.changes?.recast).toEqual([b.shots[0].id]);
    expect(rowsOf(added.r)).toEqual([`cast:${PIP} words missing`]);
    expect(Number(prop(actorOf(doc, PIP), 'desk_height_m'))).toBeCloseTo(heightM, 6);
    const u = update(doc, b, source(l));
    expect(u.changes?.other).toEqual(['1 cast member from the library']);
    expect(rowsOf(u.r)).toEqual([`cast:${PIP} unit`]);
  });

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

describe('a unit saved to the library whose answer came too late (the host linked it)', () => {
  const benches = (doc: SceneDoc) => doc.listObjects().filter((o) => /bench/i.test(o.name));
  /** The scene staged from open.json with a park bench added by hand, its set extracted and sent. */
  function savedSet(b: SceneBrief = openBrief(), units?: UnitSource) {
    const { doc } = staged(b, units);
    BUILTIN_CATALOG.find((e) => e.id === 'park_bench')!.build(doc, { location: [4, 6, 0] });
    const ex = extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    // the desk keeps what it sent until the answer is taken in (the host's never came)
    recordPublish(doc, ex.from!, ex.sha256, ex.link);
    return { doc, ex };
  }
  const pinned = (b: SceneBrief, pin: BriefUnitPin) => {
    const next = structuredClone(b);
    next.set.unit = pin;
    return next;
  };

  it('adopts a set saved from the words’ set when the brief pins its file: no copy of the bench', () => {
    const { doc, ex } = savedSet();
    expect(pendingPublishes(doc)).toEqual([{ slot: 'set', sha256: ex.sha256, link: ex.link }]);
    const objects = doc.listObjects().length;
    const bench = benches(doc).map((o) => o.id);
    expect(bench).toHaveLength(2);
    const pin = { ref: 'lib_0123456789mead', version: 1, sha256: ex.sha256 };
    const next = pinned(openBrief(), pin);
    const units = unitSourceOf([{ ...pin, data: ex.data }]);
    // the banner offers the set (as for a set placed from the library), and Update shots adopts it
    const { r, changes } = update(doc, next, units);
    expect(changes?.other).toEqual(['the set from the library']);
    expect(benches(doc).map((o) => o.id)).toEqual(bench);
    // the update adds the set's root and takes no object out
    expect(doc.listObjects().length).toBe(objects + 1);
    expect(listUnits(doc).map((i) => [i.key, i.ref, i.version, i.root])).toEqual([
      ['set', pin.ref, 1, deriveUnitId('set', '@root')],
    ]);
    expect(unitStatus(doc, listUnits(doc)[0].root)).toEqual({ edited: [], missing: [] });
    expect(rowsOf(r)).toEqual(['set unit']);
    expect(readBriefRecord(doc)!.setUnit).toEqual({ ...pin, staged: 'unit' });
    expect(pendingPublishes(doc)).toEqual([]);
    expect(briefChanges(doc, next, { units })).toBeNull();
  });

  it('adopts a new version saved from a set placed from the library: no copy of the bench', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set });
    const { doc, ex } = savedSet(b, source(L.set));
    expect(ex.basedOn).toEqual({ ref: L.set.pin.ref, version: 1 });
    const root = listUnits(doc)[0].root;
    const bench = benches(doc).map((o) => o.id);
    const pin = { ref: L.set.pin.ref, version: 2, sha256: ex.sha256 };
    const next = pinned(b, pin);
    const { changes } = update(doc, next, unitSourceOf([{ ...pin, data: ex.data }]));
    expect(changes?.other).toEqual(['a new version of the library set']);
    expect(benches(doc).map((o) => o.id)).toEqual(bench);
    expect(listUnits(doc).map((i) => [i.key, i.version, i.root])).toEqual([['set', 2, root]]);
    expect(unitStatus(doc, root)).toEqual({ edited: [], missing: [] });
    expect(pendingPublishes(doc)).toEqual([]);
  });

  it('adopts a prop and a figure saved from the scene: their objects stay, no copy goes in', () => {
    const { doc } = staged(openBrief());
    const kite = propOf(doc, KITE).id;
    const mira = actorOf(doc, MIRA).id;
    const exKite = extractUnit(doc, { kind: 'prop', root: kite, name: 'Red kite' }, { deskVersion: 'test' });
    const exMira = extractUnit(doc, { kind: 'figure', actor: mira, name: 'Mira' }, { deskVersion: 'test' });
    recordPublish(doc, exKite.from!, exKite.sha256, exKite.link);
    recordPublish(doc, exMira.from!, exMira.sha256, exMira.link);
    const ids = doc
      .listObjects()
      .map((o) => o.id)
      .sort();
    const pinKite = { ref: 'lib_0123456789kite', version: 1, sha256: exKite.sha256 };
    const pinMira = { ref: 'lib_0123456789mira', version: 1, sha256: exMira.sha256 };
    const next = withPins(openBrief(), {
      cast: { [MIRA]: lib(pinMira.ref, 1, exMira.data) },
      el: { [KITE]: lib(pinKite.ref, 1, exKite.data) },
    });
    const units = unitSourceOf([
      { ...pinKite, data: exKite.data },
      { ...pinMira, data: exMira.data },
    ]);
    const { r, changes } = update(doc, next, units);
    expect(changes?.other).toEqual(['1 cast member from the library', '1 prop from the library']);
    expect(
      doc
        .listObjects()
        .map((o) => o.id)
        .sort(),
    ).toEqual(ids);
    expect(listUnits(doc).map((i) => [i.key, i.version, i.root])).toEqual([
      [`cast:${MIRA}`, 1, mira],
      [`el:${KITE}`, 1, kite],
    ]);
    expect(rowsOf(r)).toEqual([`cast:${MIRA} unit`, `el:${KITE} unit`]);
    expect(pendingPublishes(doc)).toEqual([]);
  });

  it('waits while the brief does not pin the file or the file is not here, and keeps it through Ctrl+Z', () => {
    const { doc, ex } = savedSet();
    const undo = new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]) });
    const pin = { ref: 'lib_0123456789mead', version: 1, sha256: ex.sha256 };
    const next = pinned(openBrief(), pin);
    const objects = doc.listObjects().length;
    // the brief does not pin it yet (the host has not answered), then pins it without its file
    expect(update(doc, openBrief()).changes).toBeNull();
    update(doc, next, unitSourceOf([]));
    expect(pendingPublishes(doc).map((p) => p.sha256)).toEqual([ex.sha256]);
    expect(listUnits(doc)).toEqual([]);
    // the file comes: Update shots adopts the set, and Ctrl+Z takes the adoption and the publish back
    const units = unitSourceOf([{ ...pin, data: ex.data }]);
    undo.stopCapturing();
    update(doc, next, units);
    expect(listUnits(doc).map((i) => i.key)).toEqual(['set']);
    expect(pendingPublishes(doc)).toEqual([]);
    undo.undo();
    expect(listUnits(doc)).toEqual([]);
    expect(doc.listObjects().length).toBe(objects);
    expect(pendingPublishes(doc).map((p) => p.sha256)).toEqual([ex.sha256]);
    // pressed again it adopts again: still no copy of the bench
    update(doc, next, units);
    expect(benches(doc)).toHaveLength(2);
    expect(listUnits(doc).map((i) => [i.key, i.version])).toEqual([['set', 1]]);
    undo.destroy();
  });

  it('puts the unit in as usual when the objects it was made from are gone, and lets the publish go', () => {
    const { doc, ex } = savedSet();
    const parts = Object.entries(ex.link.parts)
      .filter(([k]) => k.startsWith('objects:') && k !== 'objects:@root')
      .map(([, p]) => p.sceneId);
    doc.transact(() => doc.removeObjects(parts.filter((id) => doc.has('objects', id))));
    expect(benches(doc)).toEqual([]);
    const pin = { ref: 'lib_0123456789mead', version: 1, sha256: ex.sha256 };
    const { r } = update(doc, pinned(openBrief(), pin), unitSourceOf([{ ...pin, data: ex.data }]));
    expect(rowsOf(r)).toEqual(['set unit']);
    // placed from the file: its bench, once
    expect(benches(doc)).toHaveLength(2);
    expect(listUnits(doc).map((i) => [i.key, i.version])).toEqual([['set', 1]]);
    expect(pendingPublishes(doc)).toEqual([]);
    expect(r.warnings).toContainEqual(
      `the set: the objects 'Meadow' was saved to the library from are no longer in the scene: its library unit lib_0123456789mead@1 is put in instead`,
    );
  });

  it('is let go when the answer adopts it, and a later save from the slot takes its place', () => {
    const { doc, ex } = savedSet();
    recordPublish(doc, ex.from!, 'f'.repeat(64), ex.link);
    expect(pendingPublishes(doc).map((p) => p.sha256)).toEqual(['f'.repeat(64)]);
    forgetPublish(doc, 'f'.repeat(64));
    expect(pendingPublishes(doc)).toEqual([]);
    recordPublish(doc, ex.from!, ex.sha256, ex.link);
    const pin = { ref: 'lib_0123456789mead', version: 1, sha256: ex.sha256 };
    adoptPublished(doc, openBrief(), { slot: ex.from, link: ex.link, pin, linked: true, header: ex.header });
    expect(pendingPublishes(doc)).toEqual([]);
  });
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

  it('writes no landmark of a set made local either: the slot is still the library set', () => {
    const L = library();
    const b = withPins(openBrief(), { set: L.set });
    const { doc } = staged(b, source(L.set));
    makeLocal(doc, listUnits(doc)[0].root);
    expect(listUnits(doc)).toEqual([]);
    expect(readBriefRecord(doc)!.setUnit).toMatchObject({ ...L.set.pin, staged: 'unit' });
    const out = exportRideoBlocking(doc);
    expect(out.blocking.set.landmarks).toEqual([]);
    expect(out.blocking.set.ground).toBe('grass');
    expect(out.warnings).toContain(
      "the set is the library's 'Meadow': its 1 piece(s) are not written as landmarks (a re-import keeps the set)",
    );
    const count = () => ({
      landmarks: doc.listObjects().filter((o) => prop(o, 'desk_role') === 'landmark').length,
      grounds: doc.listObjects().filter((o) => prop(o, 'desk_label') === 'ground').length,
      objects: doc.listObjects().length,
    });
    const was = count();
    doc.transact(() =>
      importRideoBlocking(
        docContext(doc),
        { ...planBrief(b).input, blocking: out.blocking, update: true },
        solveShotCameras,
      ),
    );
    expect(count()).toEqual(was);
    // the words' set (its pin not here) is written as it is
    const words = staged(b).doc;
    expect(readBriefRecord(words)!.setUnit).toMatchObject({ staged: 'pending', why: 'missing' });
    expect(exportRideoBlocking(words).blocking.set.landmarks.map((l) => l.label)).toEqual(['pond']);
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
