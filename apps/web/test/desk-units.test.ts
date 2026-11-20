import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  briefWithoutPins,
  decodePNG,
  decodeUnit,
  encodeUnit,
  evaluatedBounds,
  extractUnit,
  getShots,
  listUnits,
  pendingPublishes,
  readUnitHeader,
  renderItems,
  sha256Hex as coreSha256Hex,
  stateUnitRows,
  threeQuarterView,
  unitStatus,
  type BriefChanges,
  type SceneBrief,
} from '@3d-editor/core';
import { CHANGES_QUIET_MS, DeskController, type SceneWorkspace } from '../src/embed/controller';
import {
  MAX_THUMBNAIL_BYTES,
  deskMessageProblems,
  publishAckTimeoutMs,
  type DeskMessage,
  type UnitPublishMessage,
} from '../src/embed/protocol';
import { StagingClient, type StagingWorkerFactory } from '../src/embed/staging';
import {
  UNIT_THUMBNAIL_SIZES,
  replyTransfer,
  runStaging,
  unitThumbnailFraming,
  type StagingReply,
  type StagingRequest,
  type StagingUnits,
  type UnitExtract,
} from '../src/embed/staging-engine';
import { UNITS_CONTAINER_VERSION, decodeDeskState } from '../src/embed/state';
import {
  emptyIntake,
  intakeCopy,
  intakeTransfer,
  keepWanted,
  protocolFrom,
  readOpenUnits,
  sha256Hex,
  stateUnits,
  unitNotice,
  withoutFiles,
  type UnitIntake,
} from '../src/embed/units';
import { DeskWorkspace } from '../src/embed/workspace';
import {
  KITE,
  MIRA,
  PIP,
  exampleBrief,
  lib,
  library,
  openUnit,
  stagedDoc,
  withPins,
  type Lib,
} from './desk-units-helpers';

/*
 * Library units in the desk's engine (docs/embedding.md "Library units"), with real unit files made
 * from the contract's example brief (desk-units-helpers.ts): the open's files read for the brief's
 * pins (SHA-256 checked, wrong formats, duplicates, entries no pin names, 32 MiB per file and 48 MiB
 * in all), the units kept for Update shots, the staging worker's unit requests (staging with units,
 * a unit made of the scene with its thumbnail, a published unit adopted, Make local) and their
 * transfer lists, the workspace (the units held, state container version 2 with its rows, Make local
 * as one undo step, an adoption that is no undo step, a worker that fails with the files), and the
 * controller: units on or off for an open (off: the host sees today's messages), state.units,
 * Save to library (unit-publish, then the ack linked, unlinked, refused, late, invalid or never),
 * and the Library tab's rows and the banner's words.
 */

const L = () => library();
// the desk's UI (DeskApp.tsx, for the banner's words) without the PWA's virtual module
vi.mock('../src/pwa/register', () => ({ pwaUpdate: { value: false }, applyPwaUpdate: () => undefined }));
/** The brief's changes in the banner's words (DeskApp.tsx changesText: loads the desk's UI). */
const bannerWords = async (c: BriefChanges) => (await import('../src/embed/DeskApp')).changesText(c);
const key = (l: Lib) => `${l.pin.ref}@${l.pin.version}`;
const snap = (doc: SceneDoc) => Y.encodeStateAsUpdate(doc.ydoc);
const role = (o: { custom_props?: Record<string, unknown> } | null | undefined) =>
  String(o?.custom_props?.desk_role ?? '');

/** The object ids of the example brief's actors and its kite in `doc`. */
function roots(doc: SceneDoc) {
  const objects = doc.listObjects();
  const actor = (castId: string) =>
    objects.find((o) => role(o) === 'actor' && o.custom_props?.desk_character_id === castId)!.id;
  const kite = objects.find((o) => role(o) === 'prop' && o.custom_props?.desk_element_id === KITE)!.id;
  return { mira: actor(MIRA), pip: actor(PIP), kite };
}

/** The example brief with the set, Mira and the kite pinned to the library's units. */
const pinnedBrief = () =>
  withPins(exampleBrief(), { set: L().set, cast: { [MIRA]: L().mira }, elements: { [KITE]: L().kite } });
/** open.units for pinnedBrief. */
const pinnedUnits = () => [openUnit(L().set), openUnit(L().mira), openUnit(L().kite)];
/** A shot the example brief does not have (a later brief adds it). */
const NEW_SHOT = 'sht_0123456789zzzz';
/** `b` with one shot more at its end (its last shot again, under an id of its own). */
function withNewShot(b: SceneBrief): SceneBrief {
  const next = structuredClone(b);
  const last = next.shots[next.shots.length - 1];
  next.shots.push({ ...structuredClone(last), id: NEW_SHOT, index: next.shots.length });
  return next;
}

type Staged = Extract<StagingReply, { summary: unknown }>;
type Extracted = Extract<StagingReply, { kind: 'unit-extract' }>;

/** A request run by the worker's engine (in process); fails the test on an error reply. */
function run<R extends StagingReply>(req: StagingRequest): R {
  const r = runStaging(req);
  if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
  return r as R;
}

/** `brief` staged by the worker's engine into an empty document (with `units`, as the page sends them). */
function stage(brief: SceneBrief, units?: StagingUnits) {
  const doc = SceneDoc.fromUpdate(Y.encodeStateAsUpdate(new Y.Doc()));
  const reply = run<Staged>({
    kind: 'stage',
    update: snap(doc),
    brief,
    lineage: 'lineage-units',
    generator: 'test',
    ...(units ? { units } : {}),
  });
  Y.applyUpdate(doc.ydoc, reply.diff);
  return { doc, reply };
}

const bySlot = <T extends { slot: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
const rowsOf = (rows: readonly { slot: string; staged: string; why?: string }[]) =>
  bySlot(rows).map((r) => [r.slot, r.staged, r.why ?? null]);

/** The kite of the example brief made into a unit by the worker (cached: a real file, meta and thumbnail). */
let kiteMade: Extracted | null = null;
function kiteUnit(): Extracted {
  if (kiteMade) return kiteMade;
  const doc = stagedDoc();
  kiteMade = run<Extracted>({
    kind: 'unit-extract',
    update: snap(doc),
    what: { root: roots(doc).kite },
    name: 'Red kite',
    deskVersion: 'test',
  });
  doc.destroy();
  return kiteMade;
}
/** A copy of an extraction (a publish hands its buffers over). */
const copyOf = (u: UnitExtract): UnitExtract => ({
  ...u,
  data: u.data.slice(),
  thumbnail: u.thumbnail ? u.thumbnail.slice() : null,
});

/** vi.waitFor with room for a busy machine. */
const waitUntil = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 20_000, interval: 20 });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Timers the test moves on by hand (the controller's). */
function handTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h: unknown) => void due.delete(h as number),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at))
        if (t.at <= now) {
          due.delete(id);
          t.fn();
        }
    },
  };
}

let n = 0;
/** A host origin of its own per desk (its projects do not meet another test's). */
const origin = () => `https://units-${++n}-${Date.now()}.example`;
const made: DeskWorkspace[] = [];
function workspace(staging = new StagingClient(() => null)): DeskWorkspace {
  const ws = new DeskWorkspace(staging, undefined, { locks: null });
  made.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of made.splice(0)) ws.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const UNITS_ON = { units: { version: 1, publish: true } };

/** The real controller over a real workspace, after an open of `scene`: what it sent, logged and hashed. */
async function realDesk(o: {
  scene: SceneBrief;
  options?: Record<string, unknown>;
  units?: unknown;
  host?: string;
  ws?: DeskWorkspace;
  /** The host's state of the scene (default none). */
  state?: unknown;
}) {
  const ws = o.ws ?? workspace();
  const sent: { message: DeskMessage; transfer?: Transferable[] }[] = [];
  const logs: string[] = [];
  const hash = vi.fn(sha256Hex);
  const timers = handTimers();
  const c = new DeskController({
    send: (message, transfer) => {
      sent.push({ message, transfer });
      return true;
    },
    workspace: ws,
    exportSupport: () => Promise.resolve({ available: false, reason: 'not in this test' }),
    deskVersion: 'test',
    timers,
    sha256: hash,
    log: (_level, m) => logs.push(m),
  });
  await c.connected(o.host ?? origin());
  c.message({
    type: 'open',
    scene: o.scene,
    state: o.state ?? null,
    ...(o.options ? { options: o.options } : {}),
    ...(o.units !== undefined ? { units: o.units } : {}),
  } as never);
  await waitUntil(() => expect(sent.some((s) => s.message.type === 'state')).toBe(true));
  const ofType = <T extends DeskMessage['type']>(t: T) =>
    sent.map((s) => s.message).filter((m): m is Extract<DeskMessage, { type: T }> => m.type === t);
  return { c, ws, sent, logs, hash, timers, ofType };
}

// ---------------------------------------------------------------- the open's files

describe("the open's library units", () => {
  it("takes the files of the brief's pins whose bytes hash to their SHA-256, in slot order", async () => {
    const intake = await readOpenUnits(
      [openUnit(L().kite), openUnit(L().set), openUnit(L().mira)],
      pinnedBrief(),
    );
    // the set, the cast, the elements, whatever order the host sent them in
    expect(intake.units.map((u) => `${u.ref}@${u.version}`)).toEqual([
      key(L().set),
      key(L().mira),
      key(L().kite),
    ]);
    expect(intake.units.map((u) => u.sha256)).toEqual([
      L().set.pin.sha256,
      L().mira.pin.sha256,
      L().kite.pin.sha256,
    ]);
    expect(intake.units[2].data).toEqual(L().kite.data);
    expect(intake.problems).toEqual([]);
    expect(intake.ignored).toEqual([]);
  });

  it('records why the others cannot be used: bad bytes, another format, a newer one; it leaves out later duplicates, entries no pin names and entries that do not validate', async () => {
    const brief = withPins(exampleBrief(), {
      set: L().set,
      cast: { [MIRA]: L().mira, [PIP]: L().pip },
      elements: { [KITE]: L().kite },
    });
    const intake = await readOpenUnits(
      [
        // the set's pin with the kite's bytes: they do not hash to the SHA-256 sent with them
        openUnit(L().set, { data: L().kite.data.slice().buffer }),
        openUnit(L().mira, { format: 'other.format' }),
        openUnit(L().pip, { version: 2 }),
        openUnit(L().kite),
        // the kite again, broken: the first one counts
        openUnit(L().kite, { data: L().set.data.slice().buffer }),
        // a file of no pin
        openUnit(lib('lib_0123456789zzzz', 1, L().kite.data)),
        { ref: 'not an id', version: 1 },
      ],
      brief,
    );
    expect(intake.units.map((u) => `${u.ref}@${u.version}`)).toEqual([key(L().kite)]);
    expect(intake.problems.map((p) => [`${p.ref}@${p.version}`, p.staged, p.why])).toEqual([
      [key(L().set), 'pending', 'mismatch'],
      [key(L().mira), 'refused', 'unreadable'],
      [key(L().pip), 'refused', 'too_new'],
    ]);
    const ignored = new Map(intake.ignored.map((i) => [i.index, i.reason]));
    expect([...ignored.keys()].sort()).toEqual([4, 5, 6]);
    expect(ignored.get(4)).toMatch(/was sent before: the first one counts/);
    expect(ignored.get(5)).toMatch(/lib_0123456789zzzz@1 is pinned by no slot/);
    expect(ignored.get(6)).toMatch(/ref/);
  });

  it('refuses a pinned file over 32 MiB as too_large and keeps files past 48 MiB in all waiting, without hashing them', async () => {
    const MiB = 1024 * 1024;
    const big = (ref: string, mib: number, mark: number): Lib => {
      const data = new Uint8Array(mib * MiB);
      data[0] = mark;
      return { pin: { ref, version: 1, sha256: String(mark).repeat(64) }, data };
    };
    // its entry over the very buffer (no copy of so many bytes)
    const entry = (l: Lib) => ({
      ...l.pin,
      unit: { format: '3d-editor.desk-unit', version: 1, data: l.data.buffer },
    });
    const a = big('lib_0123456789aaaa', 17, 1);
    const b = big('lib_0123456789bbbb', 17, 2);
    const c = big('lib_0123456789cccc', 17, 3);
    const huge = big('lib_0123456789kite', 33, 4);
    const brief = withPins(exampleBrief(), {
      set: a,
      cast: { [MIRA]: b, [PIP]: c },
      elements: { [KITE]: huge },
    });
    // the protocol leaves the 33 MiB entry out; its pin is refused for good
    const hash = vi.fn(async (d: Uint8Array) => String(d[0]).repeat(64));
    const intake = await readOpenUnits([entry(a), entry(b), entry(c), entry(huge)], brief, { hash });
    expect(intake.units.map((u) => u.ref)).toEqual([a.pin.ref, b.pin.ref]);
    expect(intake.problems.map((p) => [p.ref, p.staged, p.why])).toEqual([
      [huge.pin.ref, 'refused', 'too_large'],
      [c.pin.ref, 'pending', 'unavailable'],
    ]);
    expect(intake.problems[0].message).toMatch(/33\.0 MiB, over the 32 MiB a unit may have/);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(intake.ignored).toEqual([{ index: 3, reason: 'over 32 MiB' }]);
  });

  it('spends the 48 MiB of an open in slot order (the set, the cast, the elements), whatever order the host sent the files in', async () => {
    const MiB = 1024 * 1024;
    const big = (ref: string, mib: number, mark: number): Lib => {
      const data = new Uint8Array(mib * MiB);
      data[0] = mark;
      return { pin: { ref, version: 1, sha256: String(mark).repeat(64) }, data };
    };
    const entry = (l: Lib) => ({
      ...l.pin,
      unit: { format: '3d-editor.desk-unit', version: 1, data: l.data.buffer },
    });
    const set = big('lib_0123456789mead', 20, 1);
    const kite = big('lib_0123456789kite', 30, 2);
    const brief = withPins(exampleBrief(), { set, elements: { [KITE]: kite } });
    const hash = async (d: Uint8Array) => String(d[0]).repeat(64);
    const read = async (sent: Lib[]) => {
      const intake = await readOpenUnits(sent.map(entry), brief, { hash });
      return {
        units: intake.units.map((u) => u.ref),
        problems: intake.problems.map((p) => [p.ref, p.staged, p.why]),
      };
    };
    // the set, the first slot, gets the budget; the prop past 48 MiB waits for another open
    const slotOrder = { units: [set.pin.ref], problems: [[kite.pin.ref, 'pending', 'unavailable']] };
    expect(await read([kite, set])).toEqual(slotOrder);
    expect(await read([set, kite])).toEqual(slotOrder);
    // of two files of one ref@version the first the host sent counts, as before
    const copy: Lib = { pin: set.pin, data: new Uint8Array(16).fill(9) };
    const dup = await readOpenUnits([kite, copy, set].map(entry), brief, { hash });
    expect(dup.problems.map((p) => [p.ref, p.why])).toEqual([[set.pin.ref, 'mismatch']]);
    expect(dup.units.map((u) => u.ref)).toEqual([kite.pin.ref]);
    expect(dup.ignored).toEqual([{ index: 2, reason: `${key(set)} was sent before: the first one counts` }]);
  });

  it("reads the contract's open-units.json: its files count for their pins, and staging refuses their text bytes as unreadable", async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(__dirname, 'fixtures/desk-protocol/open-units.json'), 'utf8'),
      (_k, v) => {
        if (v && typeof v === 'object' && typeof v.$bytes === 'string') {
          const b = Buffer.from(v.$bytes, 'base64');
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
        return v;
      },
    );
    const intake = await readOpenUnits(fixture.units, fixture.scene);
    expect(intake.problems).toEqual([]);
    expect(intake.units).toHaveLength(fixture.units.length);
    const { reply } = stage(fixture.scene, intakeCopy(intake));
    expect(reply.summary.units.length).toBeGreaterThan(0);
    for (const r of reply.summary.units)
      expect([r.slot, r.staged, r.why]).toEqual([r.slot, 'words', 'unreadable']);
  });

  it("hashes with the page's WebCrypto where it has one, else with core's, to the same digests", async () => {
    const bytes = L().kite.data;
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    expect(await sha256Hex(bytes)).toBe(L().kite.pin.sha256);
    expect(digest).toHaveBeenCalled();
    vi.stubGlobal('crypto', {});
    expect(await sha256Hex(bytes)).toBe(coreSha256Hex(bytes));
  });

  it('keeps for Update shots only the units it could still place, within one staging’s budget', () => {
    const intake: UnitIntake = {
      units: [L().kite, L().set, L().mira].map((l) => ({ ...l.pin, data: l.data })),
      problems: [
        { ref: L().pip.pin.ref, version: 1, staged: 'refused', why: 'unreadable' },
        { ref: 'lib_0123456789zzzz', version: 1, staged: 'pending', why: 'mismatch' },
      ],
      ignored: [{ index: 9, reason: 'x' }],
    };
    const kept = keepWanted(intake, [L().mira.pin, L().pip.pin]);
    expect(kept.units.map((u) => u.ref)).toEqual([L().mira.pin.ref]);
    expect(kept.problems.map((p) => p.ref)).toEqual([L().pip.pin.ref]);
    expect(kept.ignored).toEqual([]);
    // two files of 30 MiB (headers that do not read: their size is the file's): the second waits
    const MiB = 1024 * 1024;
    const a = {
      ref: 'lib_0123456789aaaa',
      version: 1,
      sha256: 'a'.repeat(64),
      data: new Uint8Array(30 * MiB),
    };
    const b = {
      ref: 'lib_0123456789bbbb',
      version: 1,
      sha256: 'b'.repeat(64),
      data: new Uint8Array(30 * MiB),
    };
    const over = keepWanted({ units: [a, b], problems: [], ignored: [] }, [a, b]);
    expect(over.units.map((u) => u.ref)).toEqual([a.ref]);
    expect(over.problems).toEqual([{ ref: b.ref, version: 1, staged: 'pending', why: 'unavailable' }]);
  });

  it('lets go of a file whose SHA-256 is not the pin’s, and its pin keeps waiting as mismatch', async () => {
    const brief = withPins(exampleBrief(), { elements: { [KITE]: L().kite } });
    // a file for the kite's ref@version that hashes to its own SHA-256, not to the pin's
    const other = lib(L().kite.pin.ref, 1, L().set.data);
    const intake = await readOpenUnits([openUnit(other)], brief);
    expect(intake.units.map((u) => u.sha256)).toEqual([other.pin.sha256]);
    const kept = keepWanted(intake, [L().kite.pin]);
    expect(kept.units).toEqual([]);
    expect(kept.problems).toEqual([
      {
        ref: L().kite.pin.ref,
        version: 1,
        staged: 'pending',
        why: 'mismatch',
        message: `${key(L().kite)}: the file sent is not the pinned one (its SHA-256 is another)`,
      },
    ]);
    // the workspace holds nothing of it after the open, and an Update shots still says mismatch
    const ws = workspace();
    const r = await ws.open({ hostOrigin: origin(), brief, state: null, units: intake });
    expect(rowsOf(r.units!)).toEqual([[`el:${KITE}`, 'words', 'mismatch']]);
    expect(ws.heldUnits()).toEqual([]);
    ws.setBrief(withNewShot(brief));
    await ws.updateFromBrief();
    expect(rowsOf(ws.unitRows()!)).toEqual([[`el:${KITE}`, 'words', 'mismatch']]);
    expect(stateUnits(ws.session!.doc).map((u) => [u.slot, u.staged, u.why])).toEqual([
      [`el:${KITE}`, 'pending', 'mismatch'],
    ]);
  });

  it('gives the worker copies of the files, each a buffer of its own to hand over', () => {
    const intake: UnitIntake = {
      units: [L().kite, L().set].map((l) => ({ ...l.pin, data: l.data })),
      problems: [{ ref: L().pip.pin.ref, version: 1, staged: 'refused', why: 'unreadable' }],
      ignored: [],
    };
    const copy = intakeCopy(intake);
    expect(copy.units.map((u) => u.data)).toEqual(intake.units.map((u) => u.data));
    expect(copy.units[0].data.buffer).not.toBe(intake.units[0].data.buffer);
    expect(intakeTransfer(copy)).toEqual(copy.units.map((u) => u.data.buffer));
    expect(copy.problems).toEqual(intake.problems);
    // after a worker failed with them: no files, their pins wait
    const given = withoutFiles(intake, 'out of memory');
    expect(given.units).toEqual([]);
    expect(given.problems.map((p) => [p.ref, p.staged, p.why])).toEqual([
      [L().pip.pin.ref, 'refused', 'unreadable'],
      [L().kite.pin.ref, 'pending', 'unavailable'],
      [L().set.pin.ref, 'pending', 'unavailable'],
    ]);
  });

  it('names the slots whose unit was not used, with the pin and the reason in words (not a slot made local or one the staging did not get to)', () => {
    const brief = exampleBrief();
    const row = (slot: string, staged: 'unit' | 'words', why?: string) => ({
      slot,
      ref: 'lib_0123456789mead',
      version: 2,
      object: null,
      staged,
      ...(why ? { why } : {}),
    });
    expect(unitNotice([row('set', 'unit'), row(`el:${KITE}`, 'words', 'local')], brief)).toBeNull();
    expect(
      unitNotice([row('set', 'words', 'mismatch'), row(`cast:${PIP}`, 'words', 'not_staged')], brief),
    ).toBe(
      "1 library unit was not used, so its slot is staged from the brief's words. The set (lib_0123456789mead v2): the file sent is not the pinned one.",
    );
    const many = [
      row('set', 'words', 'missing'),
      row(`cast:${MIRA}`, 'words', 'figure_rig'),
      row(`cast:${PIP}`, 'words', 'wrong_kind'),
      row(`el:${KITE}`, 'words', 'too_new'),
      row('el:ele_0123456789mead', 'words', 'unavailable'),
      row('cast:chr_unknown', 'words', 'over_budget'),
      row('el:ele_unknown', 'words', 'some_new_reason'),
    ];
    expect(unitNotice(many, brief)).toBe(
      "7 library units were not used, so their slots are staged from the brief's words. The set (lib_0123456789mead v2): its file was not sent; Mira (lib_0123456789mead v2): the figure does not fit the actor’s rig or height; Pip (lib_0123456789mead v2): it is not a unit of the right kind; Red kite (lib_0123456789mead v2): it was made by a newer desk; The meadow (lib_0123456789mead v2): it could not be used this time; and 2 more.",
    );
  });

  it("gives the protocol's `from` of a slot", () => {
    expect(protocolFrom({ set: true })).toEqual({ castId: null, elementId: null, set: true });
    expect(protocolFrom({ castId: MIRA })).toEqual({ castId: MIRA, elementId: null, set: false });
    expect(protocolFrom({ elementId: KITE })).toEqual({ castId: null, elementId: KITE, set: false });
    expect(protocolFrom({ elementId: 'not an id' })).toBeNull();
    expect(protocolFrom(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- the staging worker's unit work

describe("the staging worker's unit requests", () => {
  it('stages the pinned set, figure and prop from their files; without them every pin is staged from the words', async () => {
    const brief = pinnedBrief();
    const intake = await readOpenUnits(pinnedUnits(), brief);
    const { doc, reply } = stage(brief, intakeCopy(intake));
    expect(rowsOf(reply.summary.units)).toEqual([
      [`cast:${MIRA}`, 'unit', null],
      [`el:${KITE}`, 'unit', null],
      ['set', 'unit', null],
    ]);
    expect(
      listUnits(doc)
        .map((i) => [i.key, i.kind, i.ref, i.version])
        .sort(),
    ).toEqual(
      [
        [`cast:${MIRA}`, 'figure', L().mira.pin.ref, 1],
        [`el:${KITE}`, 'prop', L().kite.pin.ref, 1],
        ['set', 'set', L().set.pin.ref, 1],
      ].sort(),
    );
    expect(stateUnits(doc)).toEqual([
      { slot: `cast:${MIRA}`, ...L().mira.pin, staged: 'unit', local: false },
      { slot: `el:${KITE}`, ...L().kite.pin, staged: 'unit', local: false },
      { slot: 'set', ...L().set.pin, staged: 'unit', local: false },
    ]);
    // no files: staged as before units, every pin waiting for its file
    const plain = stage(brief);
    expect(listUnits(plain.doc)).toEqual([]);
    expect(rowsOf(plain.reply.summary.units)).toEqual([
      [`cast:${MIRA}`, 'words', 'missing'],
      [`el:${KITE}`, 'words', 'missing'],
      ['set', 'words', 'missing'],
    ]);
  });

  it('refuses a unit of another kind than its slot (wrong_kind) and takes a file whose SHA-256 is not the pin’s as mismatch', async () => {
    // Mira pinned to the kite's file; the set's pin names another file than the one sent
    const brief = withPins(exampleBrief(), {
      set: { pin: { ...L().set.pin, sha256: L().pip.pin.sha256 }, data: L().set.data },
      cast: { [MIRA]: L().kite },
    });
    const intake = await readOpenUnits([openUnit(L().kite), openUnit(L().set)], brief);
    expect(intake.problems).toEqual([]);
    const { doc, reply } = stage(brief, intakeCopy(intake));
    expect(rowsOf(reply.summary.units)).toEqual([
      [`cast:${MIRA}`, 'words', 'wrong_kind'],
      ['set', 'words', 'mismatch'],
    ]);
    expect(listUnits(doc)).toEqual([]);
    expect(stateUnits(doc).map((r) => [r.slot, r.staged, r.why])).toEqual([
      [`cast:${MIRA}`, 'refused', 'wrong_kind'],
      ['set', 'pending', 'mismatch'],
    ]);
  });

  it('makes a unit of the set, an actor and a prop, with a PNG thumbnail of at most 64 KiB and 256 px, and hands its buffers over', () => {
    const doc = stagedDoc();
    const r = roots(doc);
    const cases = [
      { what: { set: true as const }, kind: 'set', from: { set: true } },
      { what: { root: r.mira }, kind: 'figure', from: { castId: MIRA } },
      { what: { root: r.kite }, kind: 'prop', from: { elementId: KITE } },
    ];
    for (const c of cases) {
      const ex = run<Extracted>({
        kind: 'unit-extract',
        update: snap(doc),
        what: c.what,
        name: 'Saved',
        deskVersion: 'test',
      });
      expect(readUnitHeader(ex.data)).toMatchObject({ kind: c.kind, name: 'Saved' });
      expect(ex.header).toEqual(readUnitHeader(ex.data));
      expect(ex.sha256).toBe(coreSha256Hex(ex.data));
      expect(ex.from).toEqual(c.from);
      expect(ex.basedOn).toBeNull();
      expect(ex.meta.deskVersion).toBe('test');
      expect(ex.thumbnail, c.kind).not.toBeNull();
      expect(ex.thumbnail!.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES);
      expect(ex.thumbnailSize).toBe(UNIT_THUMBNAIL_SIZES[0]);
      const img = decodePNG(ex.thumbnail!);
      expect([img.width, img.height]).toEqual([256, 256]);
      let opaque = 0;
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) opaque++;
      expect(opaque, c.kind).toBeGreaterThan(256 * 4);
      expect(replyTransfer(ex)).toEqual([ex.data.buffer, ex.thumbnail!.buffer]);
    }
    // read only: the scene is as it was
    expect(listUnits(doc)).toEqual([]);
    // without a thumbnail when asked
    const bare = run<Extracted>({
      kind: 'unit-extract',
      update: snap(doc),
      what: { root: r.kite },
      name: 'Kite',
      deskVersion: 'test',
      thumbnail: false,
    });
    expect([bare.thumbnail, bare.thumbnailSize]).toEqual([null, null]);
    expect(replyTransfer(bare)).toEqual([bare.data.buffer]);
    // an object that is not in the scene
    const missing = runStaging({
      kind: 'unit-extract',
      update: snap(doc),
      what: { root: 'nope' },
      name: 'X',
      deskVersion: 'test',
    });
    expect(missing.ok).toBe(false);
    expect(replyTransfer(missing)).toEqual([]);
  });

  it('frames a set’s thumbnail on its stage, not on its ground hundreds of metres wide', () => {
    const doc = stagedDoc();
    const ex = extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    const f = unitThumbnailFraming(ex.probe, ex.header);
    const items = renderItems(new SceneEvaluator(ex.probe).evaluate(f.frame, { forRender: true }), {
      forRender: true,
    }).filter((o) => o.mesh.faces.length > 0);
    const whole = threeQuarterView(evaluatedBounds(items)!, 1);
    const dist = (v: { position: number[]; target: number[] }) =>
      Math.hypot(...v.position.map((p, i) => p - v.target[i]));
    // the meadow's stage is 20 m × 10 m: framed from some 50 m, where its ground alone is 1 km away
    expect(ex.header.set).toMatchObject({ width: 20, depth: 10 });
    expect(dist(f.view as never)).toBeLessThan(80);
    expect(dist(whole as never)).toBeGreaterThan(10 * dist(f.view as never));
    ex.probe.destroy();
  });

  it('links the scene to the version the host saved: its objects become an instance and the record pins it; Make local cuts the link', () => {
    const doc = stagedDoc();
    const { kite } = roots(doc);
    const ex = run<Extracted>({
      kind: 'unit-extract',
      update: snap(doc),
      what: { root: kite },
      name: 'Red kite',
      deskVersion: 'test',
      thumbnail: false,
    });
    const pin = { ref: 'lib_0123456789kite', version: 4, sha256: ex.sha256 };
    // not linked: an instance, and the record keeps no pin
    const loose = SceneDoc.fromUpdate(snap(doc));
    const unlinked = run<Extract<StagingReply, { kind: 'unit-adopt' }>>({
      kind: 'unit-adopt',
      update: snap(loose),
      brief: exampleBrief(),
      slot: ex.from,
      link: ex.link,
      pin,
      linked: false,
      header: ex.header,
    });
    expect([unlinked.root, unlinked.recorded]).toEqual([kite, false]);
    Y.applyUpdate(loose.ydoc, unlinked.diff);
    expect(listUnits(loose).map((i) => [i.key, i.ref, i.version])).toEqual([[`el:${KITE}`, pin.ref, 4]]);
    expect(stateUnits(loose)).toEqual([]);
    // linked
    const adopted = run<Extract<StagingReply, { kind: 'unit-adopt' }>>({
      kind: 'unit-adopt',
      update: snap(doc),
      brief: exampleBrief(),
      slot: ex.from,
      link: ex.link,
      pin,
      linked: true,
      header: ex.header,
    });
    expect([adopted.root, adopted.recorded]).toEqual([kite, true]);
    expect(replyTransfer(adopted)).toEqual([adopted.diff.buffer]);
    Y.applyUpdate(doc.ydoc, adopted.diff);
    expect(listUnits(doc).map((i) => [i.key, i.kind, i.ref, i.version, i.root])).toEqual([
      [`el:${KITE}`, 'prop', pin.ref, 4, kite],
    ]);
    expect(stateUnits(doc)).toEqual([{ slot: `el:${KITE}`, ...pin, staged: 'unit', local: false }]);
    // Make local: the objects stay, unlinked; the record says local
    const local = run<Extract<StagingReply, { kind: 'unit-local' }>>({
      kind: 'unit-local',
      update: snap(doc),
      root: kite,
    });
    expect(local.root).toBe(kite);
    expect(local.parts).toBeGreaterThan(0);
    Y.applyUpdate(doc.ydoc, local.diff);
    expect(listUnits(doc)).toEqual([]);
    expect(doc.getObject(kite)).not.toBeNull();
    expect(stateUnits(doc)).toEqual([{ slot: `el:${KITE}`, ...pin, staged: 'unit', local: true }]);
    // an object that is no instance
    expect(runStaging({ kind: 'unit-local', update: snap(doc), root: kite }).ok).toBe(false);
  });

  it("hands the units' files over to the worker, each buffer once, and only to staging and Update shots", async () => {
    const posted: { request: StagingRequest; transfer?: Transferable[] }[] = [];
    const factory: StagingWorkerFactory = () => {
      const w = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        terminate: vi.fn(),
        postMessage(m: { id: number; request: StagingRequest }, transfer?: Transferable[]) {
          posted.push({ request: m.request, transfer });
          const reply = runStaging(m.request);
          setTimeout(() => w.onmessage?.({ data: { id: m.id, reply } } as MessageEvent), 0);
        },
      };
      return w;
    };
    const client = new StagingClient(factory);
    const brief = pinnedBrief();
    const units = intakeCopy(await readOpenUnits(pinnedUnits(), brief));
    const empty = Y.encodeStateAsUpdate(new Y.Doc());
    const staged = await client.stage(empty, brief, 'lin', 'test', undefined, units);
    expect(posted[0].request).toMatchObject({ kind: 'stage', units });
    expect(posted[0].transfer).toEqual(units.units.map((u) => u.data.buffer));
    expect(new Set(posted[0].transfer).size).toBe(3);
    const doc = SceneDoc.fromUpdate(empty);
    Y.applyUpdate(doc.ydoc, staged.diff);
    await client.update(snap(doc), brief, intakeCopy(emptyIntake()));
    expect(posted[1].transfer).toEqual([]);
    await client.update(snap(doc), brief);
    expect(posted[2].request).not.toHaveProperty('units');
    const ex = await client.extractUnit(snap(doc), { set: true }, 'Meadow', 'test');
    expect(posted[3]).toMatchObject({ request: { kind: 'unit-extract', name: 'Meadow' }, transfer: [] });
    expect(ex.header.kind).toBe('set');
    client.dispose();
  });
});

// ---------------------------------------------------------------- the workspace

describe('the desk workspace with library units', () => {
  it('stages the open’s units, keeps none it placed, and writes container version 2 with the record’s rows', async () => {
    const ws = workspace();
    const brief = pinnedBrief();
    const intake = await readOpenUnits(pinnedUnits(), brief);
    const r = await ws.open({ hostOrigin: origin(), brief, state: null, units: intake });
    expect(rowsOf(r.units!)).toEqual([
      [`cast:${MIRA}`, 'unit', null],
      [`el:${KITE}`, 'unit', null],
      ['set', 'unit', null],
    ]);
    expect(ws.unitRows()).toEqual(r.units);
    expect(ws.heldUnits()).toEqual([]);
    expect(listUnits(ws.session!.doc)).toHaveLength(3);
    expect(ws.session!.undo.undoStack.length).toBe(0);
    expect(ws.changes()).toBeNull();
    const enc = await ws.encodeState();
    expect(new Uint8Array(enc.state.data)[8]).toBe(UNITS_CONTAINER_VERSION);
    expect(enc.units.map((u) => [u.slot, u.staged, u.local])).toEqual([
      [`cast:${MIRA}`, 'unit', false],
      [`el:${KITE}`, 'unit', false],
      ['set', 'unit', false],
    ]);
    const { update } = await decodeDeskState(enc.state, brief.id);
    const copy = SceneDoc.fromUpdate(update);
    expect(listUnits(copy)).toHaveLength(3);
    expect(ws.libraryRows().map((row) => [row.key, row.kind, row.status, row.text])).toEqual([
      ['set', 'set', 'current', 'up to date'],
      [`cast:${MIRA}`, 'figure', 'current', 'up to date'],
      [`el:${KITE}`, 'prop', 'current', 'up to date'],
    ]);
  });

  it('opens with units off as before: no rows, and container version 1', async () => {
    const ws = workspace();
    const r = await ws.open({ hostOrigin: origin(), brief: exampleBrief(), state: null });
    expect(r.units).toBeNull();
    expect(ws.unitRows()).toBeNull();
    const enc = await ws.encodeState();
    expect(new Uint8Array(enc.state.data)[8]).toBe(1);
    expect(enc.units).toEqual([]);
    expect(ws.libraryRows()).toEqual([]);
  });

  it('keeps the file of a pin the scene does not hold yet for Update shots, which places it in one undo step; after Ctrl+Z it offers and places it again', async () => {
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: exampleBrief(), state: null, units: emptyIntake() });
    first.close();
    // the host pins the kite later and sends its file: the desk opens its local copy
    const brief = withPins(exampleBrief(), { elements: { [KITE]: L().kite } });
    const ws = workspace();
    const r = await ws.open({
      hostOrigin: host,
      brief,
      state: null,
      units: await readOpenUnits([openUnit(L().kite)], brief),
    });
    expect([r.source, r.units]).toEqual(['local', null]);
    expect(ws.heldUnits()).toEqual([key(L().kite)]);
    expect(r.changes?.other).toContain('1 prop from the library');
    expect(await bannerWords(ws.changes()!)).toContain('1 prop from the library');
    expect(ws.libraryRows()).toMatchObject([
      {
        key: `el:${KITE}`,
        slot: `el:${KITE}`,
        root: null,
        kind: 'prop',
        status: 'update',
        text: 'v1 is here: Update shots places it',
      },
    ]);
    await ws.updateFromBrief();
    const s = ws.session!;
    expect(listUnits(s.doc).map((i) => [i.key, i.ref, i.version])).toEqual([
      [`el:${KITE}`, L().kite.pin.ref, 1],
    ]);
    expect(s.undo.undoStack.length).toBe(1);
    expect(ws.unitRows()).toEqual([expect.objectContaining({ slot: `el:${KITE}`, staged: 'unit' })]);
    // the open's files stay while the scene is open: Ctrl+Z may need this one again
    expect(ws.heldUnits()).toEqual([key(L().kite)]);
    expect(ws.changes()).toBeNull();
    expect(ws.libraryRows()).toMatchObject([{ key: `el:${KITE}`, status: 'current' }]);
    s.undo.undo();
    expect(listUnits(s.doc)).toEqual([]);
    // the banner and the tab offer it again, and Update shots places it again
    expect(ws.changes()?.other).toContain('1 prop from the library');
    expect(ws.libraryRows()).toMatchObject([
      { key: `el:${KITE}`, status: 'update', text: 'v1 is here: Update shots places it' },
    ]);
    await ws.updateFromBrief();
    expect(listUnits(s.doc).map((i) => i.key)).toEqual([`el:${KITE}`]);
    expect(ws.unitRows()).toEqual([expect.objectContaining({ slot: `el:${KITE}`, staged: 'unit' })]);
    expect(stateUnits(s.doc)).toEqual([
      { slot: `el:${KITE}`, ...L().kite.pin, staged: 'unit', local: false },
    ]);
    // a later Update shots gets no copy of a file whose version the scene holds
    const update = vi.spyOn(ws.staging, 'update');
    ws.setBrief(withNewShot(brief));
    await ws.updateFromBrief();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][2]?.units).toEqual([]);
    expect(listUnits(s.doc).map((i) => i.key)).toEqual([`el:${KITE}`]);
  });

  it('shows a version the brief pins but the staging cannot use as refused, with why, before and after the Update shots that records it', async () => {
    const host = origin();
    const b1 = withPins(exampleBrief(), { cast: { [MIRA]: L().mira } });
    const first = workspace();
    await first.open({
      hostOrigin: host,
      brief: b1,
      state: null,
      units: await readOpenUnits([openUnit(L().mira)], b1),
    });
    first.close();
    // v2 of Mira's item is 6 cm taller: it cannot be her actor's figure (figure_rig)
    const v1 = decodeUnit(L().mira.data);
    const { format: _f, version: _v, digest: _d, bodyBytes: _b, ...header } = structuredClone(v1.header);
    header.figure!.heightM += 0.06;
    const v2 = lib(L().mira.pin.ref, 2, encodeUnit(v1.body, header));
    const b2 = withPins(exampleBrief(), { cast: { [MIRA]: v2 } });
    const ws = workspace();
    const r = await ws.open({
      hostOrigin: host,
      brief: b2,
      state: null,
      units: await readOpenUnits([openUnit(v2)], b2),
    });
    expect(r.source).toBe('local');
    const refused = {
      key: `cast:${MIRA}`,
      version: 1,
      status: 'refused',
      pinned: { ref: v2.pin.ref, version: 2 },
      why: 'figure_rig',
      text: 'the brief pins v2: refused (the figure does not fit the actor’s rig or height); v1 stays',
    };
    expect(ws.libraryRows()).toMatchObject([refused]);
    // the banner offers the Update shots that records the refusal; the row says the same after it
    expect(ws.changes()).not.toBeNull();
    await ws.updateFromBrief();
    expect(stateUnits(ws.session!.doc)).toMatchObject([
      { slot: `cast:${MIRA}`, version: 2, staged: 'refused', why: 'figure_rig' },
    ]);
    expect(ws.changes()).toBeNull();
    expect(ws.libraryRows()).toMatchObject([refused]);
  });

  it('shows a version pinned in a slot staged from the words that the staging cannot use as refused, not as one Update shots places', async () => {
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: exampleBrief(), state: null, units: emptyIntake() });
    first.close();
    // the host pins the kite later, a version this desk cannot read (another format of unit file)
    const bad = lib(L().kite.pin.ref, 2, new TextEncoder().encode('not a unit file'));
    const brief = withPins(exampleBrief(), { elements: { [KITE]: bad } });
    const ws = workspace();
    await ws.open({
      hostOrigin: host,
      brief,
      state: null,
      units: await readOpenUnits([openUnit(bad)], brief),
    });
    const refused = {
      key: `el:${KITE}`,
      root: null,
      version: 2,
      status: 'refused',
      why: 'unreadable',
      text: 'refused: it is not a unit file this desk reads; staged from the words',
    };
    expect(ws.libraryRows()).toMatchObject([refused]);
    expect(ws.changes()).not.toBeNull();
    await ws.updateFromBrief();
    expect(ws.changes()).toBeNull();
    expect(ws.libraryRows()).toMatchObject([refused]);
  });

  it('makes an instance local as one undo step: the record keeps its pin as local, and the next state is version 1', async () => {
    const ws = workspace();
    const brief = withPins(exampleBrief(), { elements: { [KITE]: L().kite } });
    await ws.open({
      hostOrigin: origin(),
      brief,
      state: null,
      units: await readOpenUnits([openUnit(L().kite)], brief),
    });
    const s = ws.session!;
    const root = listUnits(s.doc)[0].root;
    expect(await ws.makeLocal(root)).toMatchObject({ root });
    expect(listUnits(s.doc)).toEqual([]);
    expect(s.doc.getObject(root)).not.toBeNull();
    expect(s.undo.undoStack.length).toBe(1);
    expect(stateUnits(s.doc)).toEqual([{ slot: `el:${KITE}`, ...L().kite.pin, staged: 'unit', local: true }]);
    expect(ws.libraryRows()).toMatchObject([
      { key: `el:${KITE}`, status: 'local', root: null, text: 'made local: it stays as it is' },
    ]);
    // a later Update shots leaves the slot as it is
    expect(ws.changes()).toBeNull();
    const enc = await ws.encodeState();
    expect(new Uint8Array(enc.state.data)[8]).toBe(1);
    expect(enc.units).toEqual([{ slot: `el:${KITE}`, ...L().kite.pin, staged: 'unit', local: true }]);
    s.undo.undo();
    expect(listUnits(s.doc)).toHaveLength(1);
    await expect(ws.makeLocal('not-an-instance')).rejects.toThrow();
  });

  it('adopts the version the host saved without an undo step and follows the brief that pins it', async () => {
    const ws = workspace();
    const brief = exampleBrief();
    await ws.open({ hostOrigin: origin(), brief, state: null, units: emptyIntake() });
    const s = ws.session!;
    const targets = ws.saveTargets();
    expect(targets.map((t) => [t.kind, t.label, t.name, t.slot])).toEqual([
      ['set', 'The set', 'The meadow', 'set'],
      ['figure', 'Mira', 'Mira', `cast:${MIRA}`],
      ['figure', 'Pip', 'Pip', `cast:${PIP}`],
      ['prop', 'Red kite', 'Red kite', `el:${KITE}`],
    ]);
    const kite = targets[3];
    const { kite: kiteRoot } = roots(s.doc);
    expect(kite.what).toEqual({ root: kiteRoot });
    expect(ws.defaultSaveTarget(null)).toEqual(targets[0]);
    expect(ws.defaultSaveTarget(kiteRoot)).toEqual(kite);
    // a part of the kite selected: its root is the target
    const part = s.doc.listObjects().find((o) => o.parent === kiteRoot);
    expect(part).toBeDefined();
    expect(ws.defaultSaveTarget(part!.id)).toEqual(kite);
    const before = ws.revision();
    const unit = await ws.extractUnit(kite.what, 'Red kite');
    expect(ws.revision()).toBe(before);
    expect(new Uint8Array((await ws.encodeState()).state.data)[8]).toBe(1);
    const pin = { ref: 'lib_0123456789kite', version: 7, sha256: unit.sha256 };
    // an edit made before the link is one undo step until the adoption, which Ctrl+Z does not go
    // back past: the steps before it go (the record it rewrote could not be undone any more)
    s.doc.addObject({ type: 'EMPTY', name: 'Marker' });
    s.undo.stopCapturing();
    s.doc.addObject({ type: 'EMPTY', name: 'Marker 2' });
    s.undo.undo();
    expect([s.undo.undoStack.length, s.undo.redoStack.length]).toEqual([1, 1]);
    const steps = s.undoRevision.peek();
    expect(await ws.adoptUnit(unit, pin, true)).toMatchObject({ root: kiteRoot, recorded: true });
    expect([s.undo.undoStack.length, s.undo.redoStack.length]).toEqual([0, 0]);
    // the editor's undo state (the redo panel) follows
    expect(s.undoRevision.peek()).toBeGreaterThan(steps);
    expect(listUnits(s.doc).map((i) => [i.key, i.ref, i.version])).toEqual([[`el:${KITE}`, pin.ref, 7]]);
    expect(new Uint8Array((await ws.encodeState()).state.data)[8]).toBe(UNITS_CONTAINER_VERSION);
    // the brief the scene was opened with pins nothing there: an update would take the unit away
    expect(ws.changes()?.other).toContain('1 prop back to the words');
    ws.setBrief(withPins(brief, { elements: { [KITE]: { pin, data: unit.data } } }));
    expect(ws.changes()).toBeNull();
    expect(ws.saveTargets()[3]).toMatchObject({ basedOn: { ref: pin.ref, version: 7, name: 'Red kite' } });
  });

  it('stages again without the files when the worker fails with them: their slots wait (pending unavailable)', async () => {
    // a worker that dies on a request carrying unit files
    const factory: StagingWorkerFactory = () => {
      const w = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        terminate: vi.fn(),
        postMessage(m: { id: number; request: StagingRequest }) {
          const req = m.request as { units?: StagingUnits };
          if (req.units?.units.length)
            setTimeout(() => w.onerror?.({ message: 'out of memory', preventDefault() {} } as ErrorEvent), 0);
          else {
            const reply = runStaging(m.request);
            setTimeout(() => w.onmessage?.({ data: { id: m.id, reply } } as MessageEvent), 0);
          }
        },
      };
      return w;
    };
    const ws = workspace(new StagingClient(factory));
    const brief = pinnedBrief();
    const r = await ws.open({
      hostOrigin: origin(),
      brief,
      state: null,
      units: await readOpenUnits(pinnedUnits(), brief),
    });
    expect(rowsOf(r.units!)).toEqual([
      [`cast:${MIRA}`, 'words', 'unavailable'],
      [`el:${KITE}`, 'words', 'unavailable'],
      ['set', 'words', 'unavailable'],
    ]);
    expect(listUnits(ws.session!.doc)).toEqual([]);
    expect(stateUnits(ws.session!.doc).map((u) => [u.slot, u.staged, u.why])).toEqual([
      [`cast:${MIRA}`, 'pending', 'unavailable'],
      [`el:${KITE}`, 'pending', 'unavailable'],
      ['set', 'pending', 'unavailable'],
    ]);
    expect(ws.heldUnits()).toEqual([]);
    ws.staging.dispose();
  });
});

// ---------------------------------------------------------------- the controller

describe('the desk controller with library units', () => {
  it("with options.units: stages the open's files, sends the record's rows with every state and offers Save to library", async () => {
    const t = await realDesk({ scene: pinnedBrief(), options: UNITS_ON, units: pinnedUnits() });
    expect(t.c.units.value).toEqual({ version: 1, publish: true });
    expect(t.c.canPublish.value).toBe(true);
    expect(t.hash).toHaveBeenCalledTimes(3);
    for (const s of t.sent) expect(deskMessageProblems(s.message), s.message.type).toBeNull();
    const [ready] = t.ofType('ready');
    expect(ready.capabilities.units).toEqual({
      versions: [1],
      kinds: ['set', 'prop', 'figure'],
      maxBytes: 33554432,
      publish: true,
    });
    const [state] = t.ofType('state');
    expect(new Uint8Array(state.state.data)[8]).toBe(UNITS_CONTAINER_VERSION);
    expect(state.units).toEqual([
      { slot: `cast:${MIRA}`, ...L().mira.pin, staged: 'unit', local: false },
      { slot: `el:${KITE}`, ...L().kite.pin, staged: 'unit', local: false },
      { slot: 'set', ...L().set.pin, staged: 'unit', local: false },
    ]);
    expect(t.c.libraryRows.value.map((r) => [r.key, r.status])).toEqual([
      ['set', 'current'],
      [`cast:${MIRA}`, 'current'],
      [`el:${KITE}`, 'current'],
    ]);
    expect(t.c.notice.value).toBeNull();
    // a save asked for later sends the rows of the scene as it is
    t.c.message({ type: 'save', id: 's-1' });
    await waitUntil(() => expect(t.ofType('state')).toHaveLength(2));
    expect(t.ofType('state')[1]).toMatchObject({ id: 's-1', units: state.units });
  });

  it('tells the person which pins were not used, in words, and offers them through the banner when a later open brings the file', async () => {
    const host = origin();
    const brief = withPins(exampleBrief(), { elements: { [KITE]: L().kite } });
    const first = await realDesk({ scene: brief, options: UNITS_ON, host });
    expect(first.c.notice.value).toMatchObject({ level: 'warning' });
    expect(first.c.notice.value!.message).toContain(
      "1 library unit was not used, so its slot is staged from the brief's words. Red kite (lib_0123456789kite v1): its file was not sent.",
    );
    expect(first.ofType('state')[0].units).toEqual([
      { slot: `el:${KITE}`, ...L().kite.pin, staged: 'pending', local: false, why: 'missing' },
    ]);
    expect(first.c.libraryRows.value).toMatchObject([
      { key: `el:${KITE}`, status: 'pending', why: 'missing' },
    ]);
    first.c.dispose();
    first.ws.close();
    // the next open brings the file: the banner offers Update shots in E2's words
    const t = await realDesk({ scene: brief, options: UNITS_ON, units: [openUnit(L().kite)], host });
    expect(t.ofType('opened')[0]).toMatchObject({ source: 'local', changes: null });
    expect(await bannerWords(t.c.changes.value!)).toBe('1 prop from the library');
    expect(t.c.libraryRows.value).toMatchObject([{ key: `el:${KITE}`, status: 'update' }]);
    await t.c.updateShots();
    expect(t.c.notice.value).toMatchObject({
      level: 'info',
      message: 'The shots were updated to the brief (Ctrl+Z undoes it).',
    });
    expect(listUnits(t.ws.session!.doc).map((i) => i.key)).toEqual([`el:${KITE}`]);
    expect(t.c.changes.value).toBeNull();
    await waitUntil(() =>
      expect(t.c.libraryRows.value).toMatchObject([{ key: `el:${KITE}`, status: 'current' }]),
    );
    // Ctrl+Z takes the Update shots back, and the banner with it once the edits pause
    const s = t.ws.session!;
    s.undo.undo();
    t.timers.advance(CHANGES_QUIET_MS);
    expect(listUnits(s.doc)).toEqual([]);
    expect(t.c.changes.value).not.toBeNull();
    expect(await bannerWords(t.c.changes.value!)).toBe('1 prop from the library');
    expect(t.c.libraryRows.value).toMatchObject([{ key: `el:${KITE}`, status: 'update' }]);
    // and Update shots places it again with the file the open brought
    await t.c.updateShots();
    expect(listUnits(s.doc).map((i) => i.key)).toEqual([`el:${KITE}`]);
    expect(t.c.notice.value).toMatchObject({
      level: 'info',
      message: 'The shots were updated to the brief (Ctrl+Z undoes it).',
    });
    expect(t.c.changes.value).toBeNull();
  });

  it("without options.units: the brief's pins are staged as though never sent, open.units is not read, and the host sees today's messages", async () => {
    const pinned = await realDesk({ scene: pinnedBrief(), units: pinnedUnits() });
    const plain = await realDesk({ scene: exampleBrief() });
    for (const t of [pinned, plain]) {
      expect(t.c.units.value).toBeNull();
      expect(t.c.canPublish.value).toBe(false);
      expect(t.c.libraryRows.value).toEqual([]);
      expect(t.hash).not.toHaveBeenCalled();
      expect(listUnits(t.ws.session!.doc)).toEqual([]);
      // the record has no pins: the staging never saw them
      expect(stateUnitRows(t.ws.session!.doc)).toEqual([]);
      const [state] = t.ofType('state');
      expect(Object.keys(state).sort()).toEqual(['sceneId', 'shots', 'state', 'type']);
      expect(new Uint8Array(state.state.data)[8]).toBe(1);
      expect(t.sent.map((s) => s.message.type)).toEqual(['ready', 'opened', 'state']);
      for (const s of t.sent) expect(deskMessageProblems(s.message), s.message.type).toBeNull();
      expect(t.c.notice.value).toBeNull();
    }
    expect(pinned.ofType('opened')).toEqual(plain.ofType('opened'));
    expect(pinned.ofType('state')[0].shots).toBe(plain.ofType('state')[0].shots);
    expect(pinned.c.brief.value).toEqual(briefWithoutPins(pinnedBrief()));
    expect(pinned.logs).toContainEqual(
      expect.stringMatching(
        /library units are off for this open .*3 pin\(s\) staged from the words, open\.units not read/,
      ),
    );
    expect(plain.logs.filter((l) => /library units/.test(l))).toEqual([]);
    // the entries were not even looked at (none is logged as left out)
    expect(pinned.logs.filter((l) => l.includes('open.units['))).toEqual([]);
    // a brief without pins reaches the workspace as the host sent it
    expect(plain.c.brief.value).toEqual(exampleBrief());
    // Save to library is not offered, and asked for anyway, nothing goes
    expect(await pinned.c.publish({ what: { set: true }, name: 'Meadow' })).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
    expect(pinned.sent.map((s) => s.message.type)).toEqual(['ready', 'opened', 'state']);
  });

  it('reopened with units off, a scene that holds units offers taking them out, as a host from before units would', async () => {
    const host = origin();
    const brief = withPins(exampleBrief(), { set: L().set, elements: { [KITE]: L().kite } });
    const on = await realDesk({
      scene: brief,
      options: UNITS_ON,
      units: [openUnit(L().set), openUnit(L().kite)],
      host,
    });
    const [state] = on.ofType('state');
    expect(state.units?.map((u) => [u.slot, u.staged])).toEqual([
      [`el:${KITE}`, 'unit'],
      ['set', 'unit'],
    ]);
    on.c.dispose();
    on.ws.close();
    // the same scene with its state, from a host that leaves options.units out (docs/embedding.md:
    // a host keeps options.units on while offline, so that this does not happen)
    const off = await realDesk({ scene: brief, host, state: state.state });
    expect(off.c.units.value).toBeNull();
    expect(off.c.source.value).toBe('state');
    expect(off.c.changes.value?.other).toEqual([
      'the set from the words (no library set)',
      '1 prop back to the words',
    ]);
    expect(off.logs).toContainEqual(
      'library units are off for this open (no options.units): 2 pin(s) staged from the words, open.units not read',
    );
  });

  it('logs an options.units it cannot read, with the shape it reads, and nothing for an open without one', async () => {
    const open = async (options: Record<string, unknown>) => {
      const logs: string[] = [];
      const sent: DeskMessage[] = [];
      const ws: SceneWorkspace = {
        open: vi.fn(async () => ({
          source: 'brief' as const,
          changes: null,
          unreadable: null,
          plan: 'stage' as const,
          stageMs: 1,
          persistent: true,
        })),
        encodeState: vi.fn(async () => ({
          state: { format: '3d-editor.desk-state' as const, version: 1 as const, data: new ArrayBuffer(16) },
          shots: 2,
        })),
        onEdit: () => () => {},
        snapshot: () => new Uint8Array([1]),
        stagedShots: () => [],
        lengthMismatches: () => [],
        changes: () => null,
        updateFromBrief: vi.fn(async () => null),
        results: vi.fn(async () => []),
        projectId: 'desk-0123',
      };
      const c = new DeskController({
        send: (m) => {
          sent.push(m);
          return true;
        },
        workspace: ws,
        exportSupport: () => Promise.resolve({ available: false, reason: 'not in this test' }),
        deskVersion: 'test',
        timers: handTimers(),
        log: (_level, m) => logs.push(m),
      });
      await c.connected('https://host.example');
      c.message({ type: 'open', scene: exampleBrief(), state: null, options } as never);
      await waitUntil(() => expect(sent.some((m) => m.type === 'state')).toBe(true));
      expect(c.units.value).toBeNull();
      return logs.filter((l) => l.includes('library units'));
    };
    const unread =
      'library units are off for this open (an options.units this desk does not read: it reads {version: 1, publish: boolean}): 0 pin(s) staged from the words, open.units not read';
    expect(await open({ units: { version: 2, publish: true } })).toEqual([unread]);
    expect(await open({ units: { version: 1, publish: 'yes' } })).toEqual([unread]);
    // a host from before units, with a brief without pins: nothing to say
    expect(await open({ hostName: 'rideo' })).toEqual([]);
  });

  it('saves a part of the real scene to the library: the linked ack makes it an instance of the version, the brief follows its pin, and the next state says so', async () => {
    const t = await realDesk({ scene: exampleBrief(), options: UNITS_ON });
    const targets = t.c.saveTargets();
    expect(targets.map((x) => x.label)).toEqual(['The set', 'Mira', 'Pip', 'Red kite']);
    const kite = targets[3];
    expect(t.c.defaultSaveTarget(null)).toEqual(targets[0]);
    const preview = await t.c.previewUnit(kite.what, 'Red kite');
    expect(preview).toMatchObject({
      kind: 'prop',
      name: 'Red kite',
      basedOn: null,
      from: { castId: null, elementId: KITE, set: false },
    });
    expect(preview.thumbnail!.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES);
    const p = t.c.publish({ what: kite.what, name: 'Red kite', description: 'Red, with a tail' });
    await waitUntil(() => expect(t.ofType('unit-publish')).toHaveLength(1));
    const { message, transfer } = t.sent.find((s) => s.message.type === 'unit-publish')! as {
      message: UnitPublishMessage;
      transfer: Transferable[];
    };
    expect(deskMessageProblems(message)).toBeNull();
    expect(message).toMatchObject({
      id: 'pub-1',
      kind: 'prop',
      name: 'Red kite',
      description: 'Red, with a tail',
    });
    // the extraction the dialog previewed (the scene has not changed since)
    expect(message.unit.data.byteLength).toBe(preview.bytes);
    expect(transfer).toEqual([message.unit.data, message.thumbnail!.data]);
    expect(t.c.publishing.value).toMatchObject({ phase: 'waiting', id: 'pub-1', kind: 'prop' });
    t.c.message({
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0123456789kite',
      version: 1,
      linked: true,
    });
    expect(await p).toEqual({ ok: true, ref: 'lib_0123456789kite', version: 1, linked: true, adopted: true });
    const pin = { ref: 'lib_0123456789kite', version: 1, sha256: message.sha256 };
    const s = t.ws.session!;
    expect(listUnits(s.doc).map((i) => [i.key, i.ref, i.version])).toEqual([[`el:${KITE}`, pin.ref, 1]]);
    expect(s.undo.undoStack.length).toBe(0);
    expect(t.c.brief.value!.elements.find((e) => e.id === KITE)!.unit).toEqual(pin);
    expect(t.c.changes.value).toBeNull();
    expect(t.c.libraryRows.value.map((r) => [r.key, r.status])).toEqual([[`el:${KITE}`, 'current']]);
    expect(t.c.publishing.value).toBeNull();
    expect(t.c.lastPublish.value).toMatchObject({
      kind: 'prop',
      name: 'Red kite',
      result: { ok: true, adopted: true },
    });
    t.c.message({ type: 'save', id: 's-1' });
    await waitUntil(() => expect(t.ofType('state')).toHaveLength(2));
    const state = t.ofType('state')[1];
    expect(new Uint8Array(state.state.data)[8]).toBe(UNITS_CONTAINER_VERSION);
    expect(state.units).toEqual([{ slot: `el:${KITE}`, ...pin, staged: 'unit', local: false }]);
    // Make local through the controller: one undo step, the row says so
    expect(await t.c.makeLocal(listUnits(s.doc)[0].root)).toEqual({ ok: true });
    expect(s.undo.undoStack.length).toBe(1);
    expect(t.c.libraryRows.value).toMatchObject([{ key: `el:${KITE}`, status: 'local' }]);
    expect(await t.c.makeLocal('nope')).toMatchObject({ ok: false });
  });
});

describe("the scene's writes, one at a time", () => {
  /** A desk whose scene was staged from the example brief, opened again with `brief` (one shot more). */
  async function laterBrief(brief = withNewShot(exampleBrief())) {
    const host = origin();
    const first = await realDesk({ scene: exampleBrief(), options: UNITS_ON, host });
    first.c.dispose();
    first.ws.close();
    const t = await realDesk({ scene: brief, options: UNITS_ON, host });
    expect(t.c.changes.value?.added).toEqual([NEW_SHOT]);
    return t;
  }
  /** Saves the set: its unit-publish sent, `ack` answers that the host saved and linked it. */
  async function saveSet(t: Awaited<ReturnType<typeof realDesk>>) {
    const done = t.c.publish({ what: { set: true }, name: 'Meadow' });
    await waitUntil(() => expect(t.ofType('unit-publish')).toHaveLength(1));
    const [m] = t.ofType('unit-publish');
    const ack = () =>
      t.c.message({
        type: 'unit-ack',
        id: m.id,
        ok: true,
        ref: 'lib_0123456789set1',
        version: 1,
        linked: true,
      });
    return { done, ack };
  }
  /** The scene: its shots, its instances with their parts missing, the record's rows, the brief's changes. */
  function sceneOf(t: Awaited<ReturnType<typeof realDesk>>) {
    const doc = t.ws.session!.doc;
    return {
      shots: getShots(doc).length,
      instances: listUnits(doc).map((i) => [i.key, unitStatus(doc, i.root).missing.length]),
      rows: stateUnitRows(doc).map((r) => [r.slot, r.staged]),
      banner: t.c.changes.value,
      changes: t.ws.changes(),
    };
  }
  const BOTH = { shots: 3, instances: [['set', 0]], rows: [['set', 'unit']], banner: null, changes: null };

  it('a linked save answered while Update shots runs keeps both: the new shot recorded and the set linked', async () => {
    const t = await laterBrief();
    const save = await saveSet(t);
    expect(t.c.publishing.value?.phase).toBe('waiting');
    // the person closed the Save dialog and pressed Update shots; the host answers meanwhile
    const update = t.c.updateShots();
    expect(t.c.updating.value).toBe(true);
    save.ack();
    const [r] = await Promise.all([save.done, update]);
    expect(r).toMatchObject({ ok: true, linked: true, adopted: true });
    expect(sceneOf(t)).toEqual(BOTH);
  });

  it('takes no Update shots while the scene links a saved unit; pressed after, it keeps the link', async () => {
    const t = await laterBrief();
    const st = t.ws.staging;
    const adopt = st.adoptUnit.bind(st);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(st, 'adoptUnit').mockImplementation(async (u, b, o) => {
      await gate;
      return adopt(u, b, o);
    });
    const update = vi.spyOn(st, 'update');
    const save = await saveSet(t);
    save.ack();
    await waitUntil(() => expect(t.c.publishing.value?.phase).toBe('linking'));
    await t.c.updateShots();
    expect(update).not.toHaveBeenCalled();
    expect(t.c.updating.value).toBe(false);
    release();
    expect(await save.done).toMatchObject({ ok: true, linked: true, adopted: true });
    expect(sceneOf(t)).toMatchObject({ shots: 2, instances: [['set', 0]], rows: [['set', 'unit']] });
    expect(t.c.changes.value?.added).toEqual([NEW_SHOT]);
    await t.c.updateShots();
    expect(sceneOf(t)).toEqual(BOTH);
  });

  it('does not link a saved set whose pieces Update shots replaced meanwhile: no instance is left without its parts', async () => {
    const brief = withNewShot(exampleBrief());
    brief.set = {
      ...brief.set,
      description: 'A cobbled harbour at dusk, fishing boats moored along the quay, a lighthouse.',
    };
    const t = await laterBrief(brief);
    const save = await saveSet(t);
    const update = t.c.updateShots();
    save.ack();
    const [r] = await Promise.all([save.done, update]);
    expect(r).toEqual({
      ok: true,
      ref: 'lib_0123456789set1',
      version: 1,
      linked: true,
      adopted: false,
      message:
        'the host saved and linked it, but the scene could not be linked to it here: the objects it was made from are no longer in the scene',
    });
    expect(sceneOf(t)).toEqual({ shots: 3, instances: [], rows: [], banner: null, changes: null });
  });

  it('Ctrl+Z does not go back past a linked save: the scene keeps what its record says', async () => {
    const t = await laterBrief();
    await t.c.updateShots();
    const s = t.ws.session!;
    expect(s.undo.canUndo()).toBe(true);
    const save = await saveSet(t);
    save.ack();
    expect(await save.done).toMatchObject({ ok: true, adopted: true });
    expect(s.undo.canUndo()).toBe(false);
    s.undo.undo();
    t.timers.advance(CHANGES_QUIET_MS);
    expect(sceneOf(t)).toEqual(BOTH);
    expect(t.ws.stagedShots()).toContain(NEW_SHOT);
  });
});

describe('a save the host linked after the desk stopped waiting', () => {
  it("comes with a later brief: Update shots makes the scene's own pieces the set's instance, with no copy beside them", async () => {
    const host = origin();
    const first = await realDesk({ scene: exampleBrief(), options: UNITS_ON, host });
    const ids = (t: Awaited<ReturnType<typeof realDesk>>) => t.ws.session!.doc.listObjects().map((o) => o.id);
    const before = ids(first);
    const p = first.c.publish({ what: { set: true }, name: 'Meadow' });
    await waitUntil(() => expect(first.ofType('unit-publish')).toHaveLength(1));
    const [m] = first.ofType('unit-publish');
    // the host takes longer than the desk waits
    first.timers.advance(publishAckTimeoutMs(m.unit.data.byteLength));
    expect(await p).toMatchObject({ ok: false, code: 'timeout' });
    // the scene keeps what it sent (no undo step), in its local copy and the states it sends
    expect(pendingPublishes(first.ws.session!.doc)).toMatchObject([{ slot: 'set', sha256: m.sha256 }]);
    expect(first.ws.session!.undo.canUndo()).toBe(false);
    first.c.dispose();
    first.ws.close();
    // the host saved and linked it meanwhile: its next brief pins that file, and the open sends it
    const meadow = lib('lib_0123456789set1', 1, new Uint8Array(m.unit.data));
    const t = await realDesk({
      scene: withPins(exampleBrief(), { set: meadow }),
      options: UNITS_ON,
      units: [openUnit(meadow)],
      host,
    });
    expect(await bannerWords(t.c.changes.value!)).toBe('the set from the library');
    await t.c.updateShots();
    const s = t.ws.session!;
    // the pieces it was made from are its parts: only the set's root is new
    expect(ids(t).filter((id) => !before.includes(id))).toHaveLength(1);
    expect(before.filter((id) => !ids(t).includes(id))).toEqual([]);
    expect(
      listUnits(s.doc).map((i) => [i.key, i.ref, i.version, unitStatus(s.doc, i.root).missing.length]),
    ).toEqual([['set', meadow.pin.ref, 1, 0]]);
    expect(stateUnitRows(s.doc).map((r) => [r.slot, r.staged])).toEqual([['set', 'unit']]);
    expect(pendingPublishes(s.doc)).toEqual([]);
    expect(t.c.changes.value).toBeNull();
    // Ctrl+Z takes the Update shots back with the adoption, and the publish waits again
    s.undo.undo();
    t.timers.advance(CHANGES_QUIET_MS);
    expect(listUnits(s.doc)).toEqual([]);
    expect(ids(t).sort()).toEqual([...before].sort());
    expect(pendingPublishes(s.doc)).toMatchObject([{ slot: 'set', sha256: m.sha256 }]);
    expect(await bannerWords(t.c.changes.value!)).toBe('the set from the library');
  });
});

describe('Save to library', () => {
  /** The controller over a fake scene whose units are the kite's; opened with `options`. */
  async function fakeDesk(
    o: {
      options?: Record<string, unknown>;
      ws?: Partial<SceneWorkspace>;
      /** Whether the host gets a message (default: every one). */
      delivers?: (message: DeskMessage) => boolean;
    } = {},
  ) {
    const unit = kiteUnit();
    const base = {
      open: vi.fn(async () => ({
        source: 'brief' as const,
        changes: null,
        unreadable: null,
        plan: 'stage' as const,
        stageMs: 1,
        persistent: true,
        units: [],
      })),
      encodeState: vi.fn(async () => ({
        state: { format: '3d-editor.desk-state' as const, version: 1 as const, data: new ArrayBuffer(16) },
        shots: 2,
        units: [],
      })),
      onEdit: () => () => {},
      snapshot: () => new Uint8Array([1]),
      stagedShots: () => [],
      lengthMismatches: () => [],
      changes: () => null,
      updateFromBrief: vi.fn(async () => null),
      results: vi.fn(async () => []),
      projectId: 'desk-0123',
      extractUnit: vi.fn(async (): Promise<UnitExtract> => copyOf(unit)),
      adoptUnit: vi.fn(async () => ({ root: 'kite-root', recorded: true, warnings: [] })),
      recordPublish: vi.fn(),
      forgetPublish: vi.fn(),
      setBrief: vi.fn(),
      revision: () => 7,
      libraryRows: () => [],
    } satisfies SceneWorkspace;
    // the fake with `o.ws` over it (the tests that look at a mock do not replace it)
    const ws = { ...base, ...o.ws } as typeof base;
    const sent: { message: DeskMessage; transfer?: Transferable[] }[] = [];
    const logs: string[] = [];
    const timers = handTimers();
    const c = new DeskController({
      send: (message, transfer) => {
        if (o.delivers && !o.delivers(message)) return false;
        sent.push({ message, transfer });
        return true;
      },
      workspace: ws,
      exportSupport: () => Promise.resolve({ available: false, reason: 'not in this test' }),
      deskVersion: 'test',
      timers,
      log: (_level, m) => logs.push(m),
    });
    await c.connected('https://host.example');
    c.message({
      type: 'open',
      scene: exampleBrief(),
      state: null,
      options: { hostName: 'rideo', ...o.options },
    } as never);
    await waitUntil(() => expect(sent.some((s) => s.message.type === 'state')).toBe(true));
    const published = () =>
      sent.filter((s) => s.message.type === 'unit-publish') as {
        message: UnitPublishMessage;
        transfer: Transferable[];
      }[];
    return { c, ws, sent, logs, timers, unit, published };
  }
  const KITE_ROOT = { root: 'kite-root' };
  const pinOf = (t: { unit: UnitExtract }, version: number) => ({
    ref: 'lib_0123456789kite',
    version,
    sha256: t.unit.sha256,
  });

  it('sends unit-publish with the file and thumbnail handed over; a linked ack adopts the version and moves the brief’s pin', async () => {
    const t = await fakeDesk({ options: UNITS_ON });
    const p = t.c.publish({ what: KITE_ROOT, name: '  Red kite ', description: ' Red, with a tail ' });
    await waitUntil(() => expect(t.published()).toHaveLength(1));
    const { message, transfer } = t.published()[0];
    expect(deskMessageProblems(message)).toBeNull();
    expect(message).toMatchObject({
      type: 'unit-publish',
      id: 'pub-1',
      kind: 'prop',
      name: 'Red kite',
      description: 'Red, with a tail',
      from: { castId: null, elementId: KITE, set: false },
      unit: { format: '3d-editor.desk-unit', version: 1 },
      sha256: t.unit.sha256,
      thumbnail: { mime: 'image/png' },
      meta: t.unit.meta,
    });
    expect(message).not.toHaveProperty('newVersionOf');
    expect(new Uint8Array(message.unit.data)).toEqual(t.unit.data);
    expect(transfer).toEqual([message.unit.data, message.thumbnail!.data]);
    expect(t.ws.extractUnit).toHaveBeenCalledWith(KITE_ROOT, 'Red kite');
    t.c.message({
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0123456789kite',
      version: 3,
      linked: true,
      message: 'Saved.',
    });
    expect(await p).toEqual({
      ok: true,
      ref: 'lib_0123456789kite',
      version: 3,
      linked: true,
      adopted: true,
      message: 'Saved.',
    });
    // with the brief that pins the version, which the scene follows in the adoption's own turn
    expect(t.ws.adoptUnit).toHaveBeenCalledWith(
      expect.objectContaining({ link: t.unit.link, from: t.unit.from }),
      pinOf(t, 3),
      true,
      t.c.brief.value,
    );
    expect(t.c.brief.value!.elements.find((e) => e.id === KITE)!.unit).toEqual(pinOf(t, 3));
    expect(t.ws.setBrief).toHaveBeenCalledWith(t.c.brief.value);
    expect(t.c.publishing.value).toBeNull();
    expect(t.c.lastPublish.value).toMatchObject({
      kind: 'prop',
      name: 'Red kite',
      result: { ok: true, version: 3 },
    });
  });

  it('saves a new version of the instance it is only when asked to', async () => {
    const based = { ...kiteUnit(), basedOn: { ref: 'lib_0123456789kite', version: 2 } };
    const t = await fakeDesk({ options: UNITS_ON, ws: { extractUnit: vi.fn(async () => copyOf(based)) } });
    const p1 = t.c.publish({ what: KITE_ROOT, name: 'Red kite', asNewVersion: true });
    await waitUntil(() => expect(t.published()).toHaveLength(1));
    expect(t.published()[0].message.newVersionOf).toEqual({ ref: 'lib_0123456789kite', version: 2 });
    t.c.message({
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0123456789kite',
      version: 3,
      linked: false,
    });
    await p1;
    const p2 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(2));
    expect(t.published()[1].message).toMatchObject({ id: 'pub-2' });
    expect(t.published()[1].message).not.toHaveProperty('newVersionOf');
    t.c.message({ type: 'unit-ack', id: 'pub-2', ok: false, code: 'refused' });
    await p2;
  });

  it('changes nothing in the scene when the host saved it unlinked, refused it, or never answered (an ack that comes later is not applied)', async () => {
    const t = await fakeDesk({ options: UNITS_ON });
    const brief = t.c.brief.value;
    const p1 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(1));
    t.c.message({
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0123456789kite',
      version: 1,
      linked: false,
      message: 'Its pin stays.',
    });
    expect(await p1).toEqual({
      ok: true,
      ref: 'lib_0123456789kite',
      version: 1,
      linked: false,
      adopted: false,
      message: 'Its pin stays.',
    });

    const p2 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(2));
    t.c.message({
      type: 'unit-ack',
      id: 'pub-2',
      ok: false,
      code: 'conflict',
      message: 'A newer version exists.',
    });
    expect(await p2).toEqual({ ok: false, code: 'conflict', message: 'A newer version exists.' });

    const p3 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(3));
    t.c.message({ type: 'unit-ack', id: 'pub-3', ok: false });
    expect(await p3).toEqual({ ok: false, code: 'failed', message: "rideo did not save 'Red kite'." });

    // 120 s and 10 s for the file's MiB (counted up)
    const p4 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(4));
    const wait = publishAckTimeoutMs(t.unit.data.byteLength);
    expect(wait).toBe(130_000);
    t.timers.advance(wait - 1);
    await flush();
    expect(t.c.publishing.value).toMatchObject({ phase: 'waiting', id: 'pub-4' });
    t.timers.advance(1);
    expect(await p4).toEqual({
      ok: false,
      code: 'timeout',
      message: "rideo did not say whether it saved 'Red kite'.",
    });
    t.c.message({
      type: 'unit-ack',
      id: 'pub-4',
      ok: true,
      ref: 'lib_0123456789kite',
      version: 4,
      linked: true,
    });
    expect(t.logs).toContainEqual("ignored a unit-ack of 'pub-4': no unit waits for it");
    expect(t.c.lastPublish.value!.result).toMatchObject({ code: 'timeout' });

    expect(t.ws.adoptUnit).not.toHaveBeenCalled();
    expect(t.ws.setBrief).not.toHaveBeenCalled();
    expect(t.c.brief.value).toBe(brief);
  });

  it('ends the wait at once on an invalid ack, and when the desk goes away', async () => {
    const t = await fakeDesk({ options: UNITS_ON });
    const p1 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(1));
    // not a reply to this publish, or not an ack: nothing ends
    t.c.invalidReply('unit-ack', 'pub-9', 'ref: required when ok is true');
    t.c.invalidReply('result-ack', 'pub-1', 'ok: required');
    await flush();
    expect(t.c.publishing.value).toMatchObject({ phase: 'waiting' });
    t.c.invalidReply('unit-ack', 'pub-1', 'ref: required when ok is true');
    expect(await p1).toEqual({
      ok: false,
      code: 'bad_reply',
      message: "rideo's answer was not valid: ref: required when ok is true",
    });
    const p2 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(2));
    t.c.dispose();
    expect(await p2).toMatchObject({ ok: false, code: 'closed' });
    expect(t.ws.adoptUnit).not.toHaveBeenCalled();
  });

  it('keeps in the scene what it sent from a slot until the host refuses it: a link the host makes later comes with its next brief', async () => {
    let delivers = true;
    const t = await fakeDesk({ options: UNITS_ON, delivers: (m) => m.type !== 'unit-publish' || delivers });
    const kept = expect.objectContaining({ from: t.unit.from, sha256: t.unit.sha256, link: t.unit.link });
    const answer = async (id: string, ack: Record<string, unknown> | null) => {
      const p = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
      await waitUntil(() => expect(t.ws.recordPublish).toHaveBeenCalledTimes(Number(id.slice(4))));
      // kept before the host can answer
      expect(t.ws.recordPublish).toHaveBeenLastCalledWith(kept);
      if (ack) t.c.message({ type: 'unit-ack', id, ...ack } as never);
      else t.timers.advance(publishAckTimeoutMs(t.unit.data.byteLength));
      return p;
    };
    // saved but not linked, never answered, an answer that is not valid: a later brief may pin it
    await answer('pub-1', { ok: true, ref: 'lib_0123456789kite', version: 1, linked: false });
    expect(await answer('pub-2', null)).toMatchObject({ ok: false, code: 'timeout' });
    const p3 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.ws.recordPublish).toHaveBeenCalledTimes(3));
    t.c.invalidReply('unit-ack', 'pub-3', 'ref: required when ok is true');
    expect(await p3).toMatchObject({ ok: false, code: 'bad_reply' });
    expect(t.ws.forgetPublish).not.toHaveBeenCalled();
    // refused: no brief pins it
    expect(await answer('pub-4', { ok: false, code: 'conflict' })).toMatchObject({ code: 'conflict' });
    expect(t.ws.forgetPublish).toHaveBeenCalledTimes(1);
    expect(t.ws.forgetPublish).toHaveBeenLastCalledWith(t.unit.sha256);
    // not sent at all
    delivers = false;
    expect(await t.c.publish({ what: KITE_ROOT, name: 'Red kite' })).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'No host is connected.',
    });
    expect(t.ws.recordPublish).toHaveBeenCalledTimes(5);
    expect(t.ws.forgetPublish).toHaveBeenCalledTimes(2);
    expect(t.ws.forgetPublish).toHaveBeenLastCalledWith(t.unit.sha256);
    expect(t.ws.adoptUnit).not.toHaveBeenCalled();
    // a read-only open keeps nothing (its scene is never written)
    const ro = await fakeDesk({ options: { ...UNITS_ON, readOnly: true } });
    const p = ro.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(ro.published()).toHaveLength(1));
    ro.c.message({ type: 'unit-ack', id: 'pub-1', ok: false, code: 'refused' });
    await p;
    expect(ro.ws.recordPublish).not.toHaveBeenCalled();
    expect(ro.ws.forgetPublish).not.toHaveBeenCalled();
  });

  it('publishes from a read-only open but never links the scene', async () => {
    const t = await fakeDesk({ options: { ...UNITS_ON, readOnly: true } });
    expect(t.c.canPublish.value).toBe(true);
    const p = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(1));
    t.c.message({
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0123456789kite',
      version: 1,
      linked: true,
    });
    expect(await p).toEqual({
      ok: true,
      ref: 'lib_0123456789kite',
      version: 1,
      linked: true,
      adopted: false,
      message: 'The scene is read-only here: it stays as it is.',
    });
    expect(t.ws.adoptUnit).not.toHaveBeenCalled();
    expect(await t.c.makeLocal('kite-root')).toEqual({ ok: false, message: 'The scene is read-only here.' });
  });

  it('is not offered without options.units or with publish false, and sends nothing then', async () => {
    for (const options of [
      {},
      { units: { version: 1, publish: false } },
      { units: { version: 2, publish: true } },
    ]) {
      const t = await fakeDesk({ options });
      expect(t.c.canPublish.value).toBe(false);
      expect(await t.c.publish({ what: KITE_ROOT, name: 'Red kite' })).toMatchObject({
        ok: false,
        code: 'unavailable',
      });
      expect(t.ws.extractUnit).not.toHaveBeenCalled();
      expect(t.published()).toEqual([]);
      expect(t.c.lastPublish.value).toMatchObject({ result: { code: 'unavailable' } });
    }
  });

  it('refuses a second save while one runs, a name it cannot send, and says why a unit could not be made or linked', async () => {
    const t = await fakeDesk({ options: UNITS_ON });
    expect(await t.c.publish({ what: KITE_ROOT, name: '   ' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await t.c.publish({ what: KITE_ROOT, name: 'x'.repeat(121) })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await t.c.publish({ what: KITE_ROOT, name: 'Kite', description: 'x'.repeat(2001) })).toMatchObject(
      { ok: false, code: 'invalid' },
    );
    const p = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    expect(await t.c.publish({ what: KITE_ROOT, name: 'Red kite' })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    await waitUntil(() => expect(t.published()).toHaveLength(1));
    t.ws.adoptUnit.mockRejectedValueOnce(new Error('the scene was closed'));
    t.c.message({
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0123456789kite',
      version: 1,
      linked: true,
    });
    expect(await p).toMatchObject({
      ok: true,
      linked: true,
      adopted: false,
      message:
        'rideo saved and linked it, but the scene could not be linked to it here: the scene was closed',
    });
    t.ws.extractUnit.mockRejectedValueOnce(new Error('the object is gone'));
    expect(await t.c.publish({ what: KITE_ROOT, name: 'Red kite' })).toEqual({
      ok: false,
      code: 'failed',
      message: 'The unit could not be made: the object is gone',
    });
    expect(t.published()).toHaveLength(1);
  });

  it('reuses the unit the dialog previewed while the scene is unchanged', async () => {
    let revision = 7;
    const t = await fakeDesk({ options: UNITS_ON, ws: { revision: () => revision } });
    const preview = await t.c.previewUnit(KITE_ROOT, 'Red kite');
    expect(preview).toMatchObject({ kind: 'prop', bytes: t.unit.data.byteLength, from: { elementId: KITE } });
    expect(preview.thumbnail).toEqual(t.unit.thumbnail);
    const p1 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(1));
    expect(t.ws.extractUnit).toHaveBeenCalledTimes(1);
    t.c.message({ type: 'unit-ack', id: 'pub-1', ok: false, code: 'unavailable' });
    await p1;
    // previewed, then the scene changed: made again
    await t.c.previewUnit(KITE_ROOT, 'Red kite');
    revision = 8;
    const p2 = t.c.publish({ what: KITE_ROOT, name: 'Red kite' });
    await waitUntil(() => expect(t.published()).toHaveLength(2));
    expect(t.ws.extractUnit).toHaveBeenCalledTimes(3);
    t.c.message({ type: 'unit-ack', id: 'pub-2', ok: false, code: 'unavailable' });
    await p2;
  });
});

describe('the desk state container with library units', () => {
  it('is described in docs/embedding.md as the desk writes it', () => {
    const doc = readFileSync(resolve(__dirname, '../../../docs/embedding.md'), 'utf8').replace(/\s+/g, ' ');
    expect(doc).toContain(
      `\`1\`, or \`${UNITS_CONTAINER_VERSION}\` when the document holds instances of library units`,
    );
    expect(doc).toContain('The desk waits for the `unit-ack` 120 s plus 10 s per MiB of the file');
    expect(doc).toContain('a PNG of at most 64 KiB and at most 256 px a side');
    expect(UNIT_THUMBNAIL_SIZES[0]).toBe(256);
    expect(doc).toContain(
      'After the open it keeps in memory the files an **Update shots** could place (those of slots that do not hold their pinned version yet, within one staging',
    );
    expect(doc).toContain('It keeps them while the scene is open, also once an Update shots has placed them');
    expect(doc).toContain(
      'or the staging worker failed while reading the unit (out of memory, a worker restart)',
    );
  });
});
