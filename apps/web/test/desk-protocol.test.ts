import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from '@3d-editor/core';
import {
  ConnectSchema,
  DESK_MESSAGE_SCHEMAS,
  HOST_MESSAGE_SCHEMAS,
  HelloSchema,
  ID_PATTERN,
  MAX_OPEN_UNITS,
  MAX_STATE_UNITS,
  MAX_THUMBNAIL_BYTES,
  MAX_UNIT_BYTES,
  MAX_UNIT_META_BYTES,
  PUBLISH_REFUSALS,
  UNIT_DATA_FORMAT,
  UNIT_DATA_VERSION,
  UNIT_KINDS,
  UNIT_PENDING_REASONS,
  UNIT_REFUSED_REASONS,
  UnitMetaSchema,
  UnitPublishSchema,
  acceptUnits,
  briefShotFrames,
  deskMessageProblems,
  openUnitBytes,
  parseHostMessage,
  parseOpenUnits,
  publishAckTimeoutMs,
  stateBytes,
  uniqueModes,
} from '../src/embed/protocol';

/*
 * The desk embed protocol's schemas (apps/web/src/embed/protocol.ts) against the contract's
 * fixtures (test/fixtures/desk-protocol: one valid example of every message, and invalid ones
 * under invalid/; the contract's own copies, an ArrayBuffer written {"$bytes": base64}), the
 * answers to messages that do not validate, and core's copies of the scene fixtures (the staging
 * tests read them) against these.
 */

const DIR = resolve(__dirname, 'fixtures/desk-protocol');
const INVALID = resolve(DIR, 'invalid');

/** A fixture with its {"$bytes": …} as ArrayBuffers. */
function load(...path: string[]): any {
  return JSON.parse(readFileSync(resolve(...path), 'utf8'), (_k, v) => {
    if (v && typeof v === 'object' && typeof v.$bytes === 'string') {
      const b = Buffer.from(v.$bytes, 'base64');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    return v;
  });
}

const jsonFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
const VALID = jsonFiles(DIR);
const BAD = jsonFiles(INVALID);

const HOST_TYPES = Object.keys(HOST_MESSAGE_SCHEMAS);
const DESK_TYPES = Object.keys(DESK_MESSAGE_SCHEMAS);

/** Whether a message validates as what it is: a window message, a host's or the desk's. */
function validates(m: any): boolean {
  // window messages carry the protocol's name (ready's `protocol` is the version number)
  if (typeof m.protocol === 'string' || m.type === 'hello' || m.type === 'connect')
    return (m.type === 'hello' ? HelloSchema : ConnectSchema).safeParse(m).success;
  if (HOST_TYPES.includes(m.type)) return parseHostMessage(m).kind === 'ok';
  if (DESK_TYPES.includes(m.type)) return deskMessageProblems(m) === null;
  return false;
}

describe('the contract fixtures', () => {
  it('hold an example of every message type', () => {
    const types = new Set(VALID.map((f) => load(DIR, f).type));
    expect([...types].sort()).toEqual(['connect', 'hello', ...HOST_TYPES, ...DESK_TYPES].sort());
  });

  it.each(VALID)('%s validates', (name) => {
    expect(validates(load(DIR, name))).toBe(true);
  });

  it.each(BAD)('invalid/%s does not', (name) => {
    expect(validates(load(INVALID, name))).toBe(false);
  });

  it('name the files of a result as the contract does', () => {
    for (const name of ['result.json', 'result-desk.json']) {
      const r = load(DIR, name);
      const names = new Set(r.files.map((f: { name: string }) => f.name));
      for (const s of r.shots) {
        for (const [mode, file] of Object.entries(s.references)) {
          expect(file).toBe(`${s.shotId}.${mode}.mp4`);
          expect(names.has(file)).toBe(true);
        }
        if (s.still) expect(s.still).toBe(`${s.shotId}.still.png`);
        expect(s.durationSec).toBeCloseTo(s.frames / r.fps, 9);
      }
    }
  });

  it("core's copies of the scene fixtures are the same files", () => {
    const core = resolve(__dirname, '../../../packages/core/test/fixtures/desk-embed');
    // staged-golden.json is core's own (desk-brief-golden.test.ts), not a copy of the contract's
    const theirs = [
      ...jsonFiles(core).filter((f) => f !== 'staged-golden.json'),
      ...jsonFiles(resolve(core, 'invalid')).map((f) => `invalid/${f}`),
    ];
    expect(theirs.length).toBeGreaterThan(0);
    for (const f of ['open-units.json', 'open-units-figure-hints.json', 'invalid/open-units-bad-pin.json'])
      expect(theirs, f).toContain(f);
    for (const f of theirs) expect(load(core, f), f).toEqual(load(DIR, f));
  });
});

describe('reading a host message', () => {
  it('ignores what is not a message of a known type', () => {
    expect(parseHostMessage(null)).toEqual({ kind: 'unknown', type: null });
    expect(parseHostMessage('open')).toEqual({ kind: 'unknown', type: null });
    expect(parseHostMessage({ id: 'x' })).toEqual({ kind: 'unknown', type: null });
    expect(parseHostMessage({ type: 'frobnicate', id: 'x' })).toEqual({
      kind: 'unknown',
      type: 'frobnicate',
    });
    // the desk's own types are not the host's
    expect(parseHostMessage({ type: 'ready' })).toEqual({ kind: 'unknown', type: 'ready' });
  });

  it('answers a known type that does not validate with bad_message when it has an id', () => {
    const bad = parseHostMessage(load(INVALID, 'export-unknown-mode.json'));
    expect(bad).toMatchObject({ kind: 'invalid', type: 'export' });
    expect(bad.kind === 'invalid' && bad.reply).toMatchObject({
      type: 'error',
      code: 'bad_message',
      id: 'exp-3',
    });
    // no id (or not a valid one): nothing to answer
    expect(parseHostMessage({ type: 'save' })).toMatchObject({ kind: 'invalid', reply: null });
    expect(parseHostMessage({ type: 'save', id: '' })).toMatchObject({ kind: 'invalid', reply: null });
    expect(parseHostMessage({ type: 'cancel', id: 'x'.repeat(65) })).toMatchObject({
      kind: 'invalid',
      reply: null,
    });
  });

  it('answers an open whose scene is not a brief with invalid_scene, without an id', () => {
    for (const f of [
      'open-bad-id.json',
      'open-no-shots.json',
      'open-odd-width.json',
      'open-unknown-cast.json',
    ]) {
      const r = parseHostMessage(load(INVALID, f));
      expect(r.kind, f).toBe('invalid');
      if (r.kind !== 'invalid') continue;
      expect(r.reply).toMatchObject({ type: 'error', code: 'invalid_scene' });
      expect(r.reply?.id).toBeUndefined();
      expect(deskMessageProblems(r.reply!)).toBeNull();
    }
  });

  it('answers an open whose envelope is wrong with bad_message, without an id', () => {
    const open = load(DIR, 'open.json');
    for (const m of [
      { ...open, state: 'a state' },
      { ...open, options: { modes: ['smell'] } },
      { ...open, options: { hostName: 'h'.repeat(41) } },
      { type: 'open', state: null },
    ]) {
      const r = parseHostMessage(m);
      expect(r).toMatchObject({
        kind: 'invalid',
        type: 'open',
        reply: { type: 'error', code: 'bad_message' },
      });
    }
  });

  it('bounds no list the contract leaves open: empty lists and repeated modes are valid', () => {
    const open = load(DIR, 'open.json');
    for (const options of [
      { modes: [] },
      { modes: ['pose', 'pose', 'camera', 'pose'], defaultMode: 'camera' },
      { modes: ['camera', 'camera', 'camera', 'camera', 'motion'] },
    ])
      expect(parseHostMessage({ ...open, options }).kind, JSON.stringify(options)).toBe('ok');
    for (const m of [
      { type: 'export', id: 'e-1', shots: [] },
      { type: 'export', id: 'e-2', modes: [] },
      { type: 'export', id: 'e-3', modes: ['pose', 'pose', 'pose', 'pose'] },
      { type: 'export', id: 'e-4', shots: Array.from({ length: 300 }, (_, i) => `sht_${i}`) },
    ])
      expect(parseHostMessage(m).kind, m.id).toBe('ok');
    // repeats count once, in the order first named
    expect(uniqueModes(['pose', 'camera', 'pose', 'motion', 'camera'])).toEqual(['pose', 'camera', 'motion']);
  });

  it('takes a given state of any format (the desk decides whether it reads it), as a buffer or a view', () => {
    const open = load(DIR, 'open-with-state.json');
    const view = { ...open, state: { format: 'other', version: 9, data: new Uint8Array([1, 2, 3]) } };
    expect(parseHostMessage(view).kind).toBe('ok');
    const r = parseHostMessage(open);
    expect(r.kind).toBe('ok');
  });
});

describe('protocol helpers', () => {
  it('ids follow the contract pattern', () => {
    for (const ok of ['a', 'sht_0123456789aaaa', 'A.b:c-d_e', '0'.repeat(100)])
      expect(ID_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', '_a', '-a', 'a b', 'a/b', '0'.repeat(101), 'é'])
      expect(ID_PATTERN.test(bad), bad).toBe(false);
  });

  it('counts a shot in frames as hosts do', () => {
    expect(briefShotFrames(3, 24)).toBe(72);
    expect(briefShotFrames(2.5, 24)).toBe(60);
    expect(briefShotFrames(0.01, 24)).toBe(1);
    expect(briefShotFrames(1 / 3, 30)).toBe(10);
  });

  it("reads a state's bytes from a buffer or a view of part of one", () => {
    const buf = new Uint8Array([9, 1, 2, 3, 9]).buffer;
    expect([...stateBytes({ format: 'f', version: 1, data: buf })]).toEqual([9, 1, 2, 3, 9]);
    expect([...stateBytes({ format: 'f', version: 1, data: new Uint8Array(buf, 1, 3) })]).toEqual([1, 2, 3]);
  });

  it('checks what the desk sends', () => {
    expect(deskMessageProblems({ type: 'close', reason: 'done' })).toBeNull();
    expect(deskMessageProblems({ type: 'close', reason: 'later' } as never)).toMatch(/reason/);
    expect(
      deskMessageProblems({ type: 'progress', id: 'e', phase: 'render', done: -1, total: 2 } as never),
    ).toMatch(/done/);
  });

  it("checks that opened.changes holds the contract's lists and nothing more", () => {
    const changed = load(DIR, 'opened-changed.json');
    expect(deskMessageProblems(changed)).toBeNull();
    // the desk's own notes of what else differs are not the contract's
    const other = { ...changed, changes: { ...changed.changes, other: ['2 shots renumbered'] } };
    expect(deskMessageProblems(other)).toMatch(/other/);
    const cast = {
      ...changed,
      changes: { ...changed.changes, cast: { ...changed.changes.cast, renamed: [] } },
    };
    expect(deskMessageProblems(cast)).toMatch(/renamed/);
  });
});

describe('library units', () => {
  const sha = (b: ArrayBuffer | ArrayBufferView) =>
    createHash('sha256')
      .update(
        ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b),
      )
      .digest('hex');
  const openUnits = () => load(DIR, 'open-units.json');
  const publishSet = () => load(DIR, 'unit-publish-set.json');
  const stateUnits = () => load(DIR, 'state-units.json');

  it("names core's unit format, kinds and size limit", () => {
    expect(UNIT_DATA_FORMAT).toBe('3d-editor.desk-unit');
    expect(UNIT_DATA_VERSION).toBe(1);
    expect([...UNIT_KINDS]).toEqual(['set', 'prop', 'figure']);
    expect(MAX_UNIT_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_OPEN_UNITS).toBe(1 + 16 + 64);
    // core's constants (packages/core/src/desk/units) are the same, once core has them
    const c = core as Record<string, unknown>;
    if (c.UNIT_FORMAT !== undefined) expect(c.UNIT_FORMAT).toBe(UNIT_DATA_FORMAT);
    if (c.UNIT_VERSION !== undefined) expect(c.UNIT_VERSION).toBe(UNIT_DATA_VERSION);
    if (c.MAX_UNIT_BYTES !== undefined) expect(c.MAX_UNIT_BYTES).toBe(MAX_UNIT_BYTES);
    if (c.UNIT_KINDS !== undefined) expect([...(c.UNIT_KINDS as string[])]).toEqual([...UNIT_KINDS]);
  });

  it("the fixtures' hashes are the SHA-256 of their bytes, and open-units' pins are its units", () => {
    const m = openUnits();
    const pins = [
      m.scene.set.unit,
      ...m.scene.cast.map((c: any) => c.unit),
      ...m.scene.elements.map((e: any) => e.unit),
    ]
      .filter(Boolean)
      .map(({ ref, version, sha256 }: any) => ({ ref, version, sha256 }));
    // a set, a cast member's figure and a prop, in slot order
    expect(pins).toHaveLength(3);
    expect(m.units.map(({ ref, version, sha256 }: any) => ({ ref, version, sha256 }))).toEqual(pins);
    for (const u of m.units) expect(sha(u.unit.data), u.ref).toBe(u.sha256);
    for (const f of ['unit-publish-set.json', 'unit-publish-figure-new-version.json']) {
      const p = load(DIR, f);
      expect(sha(p.unit.data), f).toBe(p.sha256);
    }
    // the hints carry the figure's kind and height on its cast member
    const hinted = load(DIR, 'open-units-figure-hints.json');
    const mira = hinted.scene.cast.find((c: any) => c.unit);
    expect([mira.kind, mira.heightM]).toEqual(['child', 1.24]);
    expect(hinted.units).toEqual(m.units);
    // a thumbnail is a PNG
    const png = new Uint8Array(publishSet().thumbnail.data);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('acceptUnits takes version 1 and turns units off for anything else, never failing the open', () => {
    expect(acceptUnits({ version: 1, publish: true })).toEqual({ version: 1, publish: true });
    expect(acceptUnits({ version: 1, publish: false, extra: 'x' })).toEqual({ version: 1, publish: false });
    for (const raw of [
      undefined,
      null,
      'yes',
      {},
      { version: 1 },
      { version: '1', publish: true },
      { version: 2, publish: true },
      { version: 1, publish: 'true' },
    ])
      expect(acceptUnits(raw), JSON.stringify(raw)).toBeNull();
    const open = load(DIR, 'open.json');
    for (const units of [{ version: 2, publish: true }, 'on', 42, null]) {
      const r = parseHostMessage({ ...open, options: { ...open.options, units } });
      expect(r.kind, JSON.stringify(units)).toBe('ok');
      if (r.kind === 'ok' && r.message.type === 'open')
        expect(acceptUnits(r.message.options?.units)).toBeNull();
    }
    const r = parseHostMessage(openUnits());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok' && r.message.type === 'open')
      expect(acceptUnits(r.message.options?.units)).toEqual({ version: 1, publish: true });
  });

  it('an open without units parses as before: no units key, no option', () => {
    for (const f of ['open.json', 'open-with-state.json']) {
      const r = parseHostMessage(load(DIR, f));
      expect(r.kind, f).toBe('ok');
      if (r.kind !== 'ok' || r.message.type !== 'open') continue;
      expect('units' in r.message, f).toBe(false);
      expect('units' in (r.message.options ?? {}), f).toBe(false);
      expect(JSON.stringify(r.message.scene)).not.toContain('"unit"');
    }
  });

  it('a parsed open keeps its units for parseOpenUnits, and a bad list never fails the open', () => {
    const r = parseHostMessage(openUnits());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok' || r.message.type !== 'open') throw new Error('not an open');
    const { units, dropped } = parseOpenUnits(r.message.units);
    expect(dropped).toEqual([]);
    expect(units.map((u) => `${u.ref}@${u.version}`)).toEqual([
      'lib_0123456789mead@3',
      'lib_0123456789mira@2',
      'lib_0123456789kite@1',
    ]);
    for (const bad of ['units', 42, null, [{}], [{ ref: 'lib_x' }]])
      expect(parseHostMessage({ ...openUnits(), units: bad }).kind, JSON.stringify(bad)).toBe('ok');
  });

  it('parseOpenUnits reads each entry on its own, leaving out the bad ones', () => {
    expect(parseOpenUnits(undefined)).toEqual({ units: [], dropped: [] });
    expect(parseOpenUnits('units')).toEqual({
      units: [],
      dropped: [{ index: -1, problem: 'units: not a list' }],
    });
    const good = openUnits().units;
    const parsed = parseOpenUnits(good);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.units.map((u) => u.ref)).toEqual([
      'lib_0123456789mead',
      'lib_0123456789mira',
      'lib_0123456789kite',
    ]);
    for (const u of parsed.units) expect(sha(openUnitBytes(u))).toBe(u.sha256);
    // a bad entry is dropped with its problem; the others are kept, and the open still parses
    const bad = [
      good[0],
      { ...good[1], sha256: good[1].sha256.slice(0, 63) },
      { ...good[2], version: 0 },
      { ...good[2], unit: { ...good[2].unit, data: new ArrayBuffer(0) } },
      { ...good[2], unit: { ...good[2].unit, format: '' } },
      'not a unit',
      good[2],
    ];
    const r = parseOpenUnits(bad);
    expect(r.units.map((u) => u.ref)).toEqual(['lib_0123456789mead', 'lib_0123456789kite']);
    expect(r.dropped.map((d) => d.index)).toEqual([1, 2, 3, 4, 5]);
    expect(r.dropped[0].problem).toMatch(/sha256/);
    expect(r.dropped[1].problem).toMatch(/version/);
    expect(r.dropped[2].problem).toMatch(/1 byte to 32 MiB/);
    expect(parseHostMessage({ ...openUnits(), units: bad }).kind).toBe('ok');
    expect(parseHostMessage({ ...openUnits(), units: 'nonsense' }).kind).toBe('ok');
  });

  it('parseOpenUnits leaves out units past 81 and over 32 MiB, and takes a view of the bytes', () => {
    const entry = openUnits().units[2];
    const many = Array.from({ length: MAX_OPEN_UNITS + 2 }, (_, i) => ({ ...entry, version: i + 1 }));
    const r = parseOpenUnits(many);
    expect(r.units).toHaveLength(MAX_OPEN_UNITS);
    expect(r.dropped).toEqual([
      { index: 81, problem: 'more than 81 units: left out' },
      { index: 82, problem: 'more than 81 units: left out' },
    ]);
    const big = { ...entry, unit: { ...entry.unit, data: new ArrayBuffer(MAX_UNIT_BYTES + 1) } };
    const atMost = { ...entry, unit: { ...entry.unit, data: new ArrayBuffer(MAX_UNIT_BYTES) } };
    const oversized = parseOpenUnits([big, atMost]);
    expect(oversized.units).toHaveLength(1);
    expect(oversized.dropped).toEqual([{ index: 0, problem: expect.stringMatching(/32 MiB/) }]);
    // a view of part of a buffer, as a given state may be
    const bytes = new Uint8Array(entry.unit.data);
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 2);
    const view = parseOpenUnits([
      { ...entry, unit: { ...entry.unit, data: padded.subarray(2, 2 + bytes.length) } },
    ]);
    expect(view.dropped).toEqual([]);
    expect(sha(openUnitBytes(view.units[0]))).toBe(entry.sha256);
  });

  it('answers an invalid unit-ack with bad_message and its id, or nothing without an id', () => {
    const r = parseHostMessage(load(INVALID, 'unit-ack-ok-without-ref.json'));
    expect(r).toMatchObject({ kind: 'invalid', type: 'unit-ack' });
    expect(r.kind === 'invalid' && r.reply).toMatchObject({
      type: 'error',
      code: 'bad_message',
      id: 'pub-1',
    });
    expect(r.kind === 'invalid' && r.problems).toMatch(/ref/);
    expect(parseHostMessage({ type: 'unit-ack', ok: true })).toMatchObject({ kind: 'invalid', reply: null });
    // ok needs ref, version and linked; a refusal needs none of them, and takes any code of 1–40
    const linked = load(DIR, 'unit-ack-linked.json');
    for (const key of ['ref', 'version', 'linked']) {
      const { [key]: _gone, ...rest } = linked;
      expect(parseHostMessage(rest).kind, key).toBe('invalid');
    }
    expect(parseHostMessage({ type: 'unit-ack', id: 'pub-9', ok: false, code: 'over_quota' }).kind).toBe(
      'ok',
    );
    expect(parseHostMessage({ type: 'unit-ack', id: 'pub-9', ok: false, code: 'x'.repeat(41) }).kind).toBe(
      'invalid',
    );
    expect(PUBLISH_REFUSALS).toContain(load(DIR, 'unit-ack-refused.json').code);
  });

  it('checks a unit-publish: one source, the hash, the thumbnail and the size of meta', () => {
    expect(deskMessageProblems(publishSet())).toBeNull();
    expect(deskMessageProblems(load(INVALID, 'unit-publish-two-from.json'))).toMatch(
      /exactly one of castId, elementId, set/,
    );
    expect(
      deskMessageProblems({ ...publishSet(), from: { castId: null, elementId: null, set: false } }),
    ).toMatch(/exactly one/);
    expect(deskMessageProblems(load(INVALID, 'unit-publish-bad-sha.json'))).toMatch(/sha256/);
    expect(deskMessageProblems(load(INVALID, 'unit-publish-thumbnail-too-large.json'))).toMatch(/thumbnail/);
    const atLimit = { ...publishSet().thumbnail, data: new ArrayBuffer(MAX_THUMBNAIL_BYTES) };
    expect(deskMessageProblems({ ...publishSet(), thumbnail: atLimit })).toBeNull();
    expect(
      deskMessageProblems({ ...publishSet(), thumbnail: { mime: 'image/jpeg', data: atLimit.data } }),
    ).toMatch(/mime/);
    expect(deskMessageProblems({ ...publishSet(), unit: { ...publishSet().unit, format: 'other' } })).toMatch(
      /format/,
    );
    // meta: at most 32 credits and 16 KiB of JSON in UTF-8 (three-byte characters pass the length limits)
    const meta = publishSet().meta;
    const credit = (ch: string) => ({ name: ch.repeat(120), author: ch.repeat(200), license: ch.repeat(64) });
    const ascii = { ...meta, credits: Array.from({ length: 32 }, () => credit('a')) };
    expect(UnitMetaSchema.safeParse(ascii).success).toBe(true);
    const wide = { ...meta, credits: Array.from({ length: 32 }, () => credit('€')) };
    expect(new TextEncoder().encode(JSON.stringify(wide)).byteLength).toBeGreaterThan(MAX_UNIT_META_BYTES);
    expect(deskMessageProblems({ ...publishSet(), meta: wide })).toMatch(/16 KiB/);
    expect(
      deskMessageProblems({ ...publishSet(), meta: { ...meta, credits: Array(33).fill(credit('a')) } }),
    ).toMatch(/credits/);
    expect(UnitPublishSchema.safeParse({ ...publishSet(), kind: 'voice' }).success).toBe(false);
  });

  it('checks the rows of state.units: the slot, the reason of each state, sorted and each slot once', () => {
    const m = stateUnits();
    expect(deskMessageProblems(m)).toBeNull();
    expect(deskMessageProblems(load(INVALID, 'state-units-bad-staged.json'))).toMatch(/staged/);
    const row = (i: number, over: object) => ({
      ...m,
      units: m.units.map((u: any, k: number) => (k === i ? { ...u, ...over } : u)),
    });
    expect(deskMessageProblems(row(0, { why: 'missing' }))).toMatch(/why/);
    expect(deskMessageProblems(row(1, { why: 'too_large' }))).toMatch(/why/);
    expect(deskMessageProblems(row(1, { why: undefined }))).toMatch(/why/);
    expect(deskMessageProblems(row(2, { why: 'missing' }))).toMatch(/why/);
    expect(deskMessageProblems(row(1, { local: true }))).toMatch(/local/);
    expect(deskMessageProblems(row(0, { slot: 'actor:mira' }))).toMatch(/slot/);
    expect(deskMessageProblems(row(0, { extra: 1 }))).toMatch(/extra/);
    for (const why of UNIT_PENDING_REASONS) expect(deskMessageProblems(row(1, { why }))).toBeNull();
    for (const why of UNIT_REFUSED_REASONS)
      expect(deskMessageProblems(row(2, { staged: 'refused', why }))).toBeNull();
    expect(deskMessageProblems({ ...m, units: [...m.units].reverse() })).toMatch(/sorted/);
    expect(deskMessageProblems({ ...m, units: [m.units[0], m.units[0]] })).toMatch(/sorted/);
    const rows = Array.from({ length: MAX_STATE_UNITS + 1 }, (_, i) => ({
      ...m.units[0],
      slot: `el:e${String(i).padStart(4, '0')}`,
    }));
    expect(deskMessageProblems({ ...m, units: rows.slice(0, MAX_STATE_UNITS) })).toBeNull();
    expect(deskMessageProblems({ ...m, units: rows })).toMatch(/units/);
    // a state without units, as every state before units, still validates
    const { units: _units, ...plain } = m;
    expect(deskMessageProblems(plain)).toBeNull();
  });

  it('ready announces units only as the contract types them', () => {
    const r = load(DIR, 'ready-units.json');
    expect(deskMessageProblems(r)).toBeNull();
    expect(r.capabilities.units).toEqual({
      versions: [1],
      kinds: ['set', 'prop', 'figure'],
      maxBytes: MAX_UNIT_BYTES,
      publish: true,
    });
    const units = (over: object) => ({
      ...r,
      capabilities: { ...r.capabilities, units: { ...r.capabilities.units, ...over } },
    });
    expect(deskMessageProblems(units({ kinds: ['set', 'voice'] }))).toMatch(/kinds/);
    expect(deskMessageProblems(units({ versions: [] }))).toMatch(/versions/);
    expect(deskMessageProblems(load(DIR, 'ready.json'))).toBeNull();
  });

  it('waits for an ack 120 s and 10 s more per MiB of the unit', () => {
    const MiB = 1024 * 1024;
    expect(publishAckTimeoutMs(0)).toBe(120_000);
    expect(publishAckTimeoutMs(1)).toBe(130_000);
    expect(publishAckTimeoutMs(MiB)).toBe(130_000);
    expect(publishAckTimeoutMs(MiB + 1)).toBe(140_000);
    expect(publishAckTimeoutMs(MAX_UNIT_BYTES)).toBe(120_000 + 32 * 10_000);
  });
});
