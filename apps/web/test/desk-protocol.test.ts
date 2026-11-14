import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConnectSchema,
  DESK_MESSAGE_SCHEMAS,
  HOST_MESSAGE_SCHEMAS,
  HelloSchema,
  ID_PATTERN,
  briefShotFrames,
  deskMessageProblems,
  parseHostMessage,
  stateBytes,
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
    const theirs = [...jsonFiles(core), ...jsonFiles(resolve(core, 'invalid')).map((f) => `invalid/${f}`)];
    expect(theirs.length).toBeGreaterThan(0);
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
      { ...open, options: { modes: [] } },
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
});
