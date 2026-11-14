import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SceneDoc, type SceneBrief } from '@3d-editor/core';
import { MAX_STATE_BYTES } from '../src/embed/protocol';
import { runStaging } from '../src/embed/staging-engine';
import {
  MAX_UPDATE_BYTES,
  STATE_HEADER_KEYS,
  STATE_MAGIC,
  StateTooLarge,
  StateUnreadable,
  compressesStates,
  decodeDeskState,
  encodeDeskState,
  newLineage,
  readLineage,
  readStateHeader,
  restorePlan,
  writeLineage,
} from '../src/embed/state';

/*
 * The desk state (embed/state.ts): the container round trip (gzipped and not), the same bytes for
 * the same document (no time in the header, the gzip header's system bytes fixed), what does not
 * read (another format, version, scene or container, a cut or corrupted payload, not a Yjs
 * document, no staging of the scene), gzip read where the browser has no DecompressionStream, the
 * limits both ways (64 MiB packed, 256 MiB unpacked) and a gzip bomb stopped while it unpacks, the
 * lineage and the merge rule.
 */

const BRIEF = (): SceneBrief =>
  structuredClone(
    JSON.parse(readFileSync(resolve(__dirname, 'fixtures/desk-protocol/open.json'), 'utf8')).scene,
  );
const SCENE = BRIEF().id;

/** A document staged from `brief` with `lineage` (as the staging worker stages it). */
function stagedUpdate(lineage: string, brief = BRIEF()): Uint8Array {
  const r = runStaging({
    kind: 'stage',
    update: Y.encodeStateAsUpdate(new Y.Doc()),
    brief,
    lineage,
    generator: 'test',
  });
  if (!r.ok || r.kind !== 'stage') throw new Error(JSON.stringify(r));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, r.diff);
  return Y.encodeStateAsUpdate(doc);
}

let staged: Uint8Array;
beforeAll(() => {
  staged = stagedUpdate('lineage-a');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const header = (over: Partial<{ sceneId: string; lineage: string; shots: number }> = {}) => ({
  sceneId: SCENE,
  lineage: 'lineage-a',
  shots: 2,
  deskVersion: 'test',
  ...over,
});

const bytesOf = (s: { data: ArrayBuffer }) => new Uint8Array(s.data);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A container of version 1 around `payload` with `head` as its header (not checked). */
function container(head: Record<string, unknown>, payload: Uint8Array, codec: 0 | 1) {
  const h = new TextEncoder().encode(JSON.stringify(head));
  const out = new Uint8Array(16 + h.length + payload.length);
  out.set(STATE_MAGIC, 0);
  out[8] = 1;
  out[9] = codec;
  new DataView(out.buffer).setUint32(12, h.length, true);
  out.set(h, 16);
  out.set(payload, 16 + h.length);
  return { format: '3d-editor.desk-state' as const, version: 1 as const, data: out.buffer };
}

/** A gzip of `mib` MiB of zeros whose last deflate bytes are broken (an unpacker that gets there fails). */
function bomb(mib: number): Uint8Array {
  const b = new Uint8Array(gzipSync(Buffer.alloc(mib * 1024 * 1024), { level: 9 }));
  for (let i = b.length - 24; i < b.length - 12; i++) b[i] ^= 0xa5;
  return b;
}

describe('the desk state', () => {
  it('writes gzip where the browser has CompressionStream', () => {
    expect(compressesStates()).toBe(true);
  });

  it.each([true, false])('round-trips a scene (compressed: %s)', async (compress) => {
    const state = await encodeDeskState(staged, header(), { compress });
    expect(state.format).toBe('3d-editor.desk-state');
    expect(state.version).toBe(1);
    const b = bytesOf(state);
    expect([...b.subarray(0, 8)]).toEqual([...STATE_MAGIC]);
    expect(b[9]).toBe(compress ? 1 : 0);
    const read = readStateHeader(b);
    expect(read.header).toEqual({ ...header(), updateBytes: staged.length });
    // the header's keys in one order, and no time
    const length = new DataView(b.buffer).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(b.subarray(16, 16 + length))) as object;
    expect(Object.keys(json)).toEqual([...STATE_HEADER_KEYS]);
    const { header: h, update: back, lineage } = await decodeDeskState(state, SCENE);
    expect(h.lineage).toBe('lineage-a');
    expect(lineage).toBe('lineage-a');
    expect(same(back, staged)).toBe(true);
    const doc = SceneDoc.fromUpdate(back);
    expect(readLineage(doc)).toBe('lineage-a');
    // a view of the bytes (a host that kept a Uint8Array) reads the same
    const view = await decodeDeskState({ ...state, data: new Uint8Array(state.data) }, SCENE);
    expect(same(view.update, staged)).toBe(true);
  });

  it('gives the same bytes for the same document, whatever system gzips them', async () => {
    const a = bytesOf(await encodeDeskState(staged, header()));
    const b = bytesOf(await encodeDeskState(staged, header()));
    expect(same(a, b)).toBe(true);
    // the gzip header: no time, no level hint, system "unknown"
    const at = 16 + new DataView(a.buffer).getUint32(12, true);
    expect([...a.subarray(at, at + 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
    // a CompressionStream that stamps a time and its system (as zlib does on other systems) gives
    // the same bytes
    const Real = CompressionStream;
    class Stamping {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const cs = new Real(format);
        this.writable = cs.writable;
        let first = true;
        this.readable = cs.readable.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) {
              if (first && chunk.length >= 10) {
                chunk = chunk.slice();
                chunk.set([0x78, 0x56, 0x34, 0x12, 2, 11], 4);
              }
              first = false;
              c.enqueue(chunk);
            },
          }),
        );
      }
    }
    vi.stubGlobal('CompressionStream', Stamping);
    const c = bytesOf(await encodeDeskState(staged, header()));
    expect(same(a, c)).toBe(true);
  });

  it('reads a state written before the header lost its time (savedAt)', async () => {
    const old = container(
      {
        sceneId: SCENE,
        lineage: 'lineage-a',
        shots: 2,
        savedAt: '2026-11-14T10:00:00.000Z',
        deskVersion: 'old',
        updateBytes: staged.length,
      },
      staged,
      0,
    );
    const { header: h, update } = await decodeDeskState(old, SCENE);
    expect(h.deskVersion).toBe('old');
    expect(same(update, staged)).toBe(true);
  });

  it('reads a gzipped state where the browser has no DecompressionStream, and writes its own uncompressed', async () => {
    const gz = await encodeDeskState(staged, header());
    expect(bytesOf(gz)[9]).toBe(1);
    vi.stubGlobal('DecompressionStream', undefined);
    vi.stubGlobal('CompressionStream', undefined);
    expect(compressesStates()).toBe(false);
    const { update } = await decodeDeskState(gz, SCENE);
    expect(same(update, staged)).toBe(true);
    const plain = await encodeDeskState(staged, header());
    expect(bytesOf(plain)[9]).toBe(0);
    expect(same((await decodeDeskState(plain, SCENE)).update, staged)).toBe(true);
    // the JS unpacking checks the gzip trailer (CRC-32, size) and takes one member only
    const b = bytesOf(gz);
    const crc = b.slice();
    crc[crc.length - 6] ^= 0xff;
    await expect(decodeDeskState({ ...gz, data: crc.buffer }, SCENE)).rejects.toThrow(/does not unpack/);
    const size = b.slice();
    size[size.length - 2] ^= 0x01;
    await expect(decodeDeskState({ ...gz, data: size.buffer }, SCENE)).rejects.toThrow(/does not unpack/);
    const length = new DataView(b.buffer).getUint32(12, true);
    const twice = container(
      { ...header(), updateBytes: staged.length },
      new Uint8Array([...b.subarray(16 + length), ...b.subarray(16 + length)]),
      1,
    );
    await expect(decodeDeskState(twice, SCENE)).rejects.toBeInstanceOf(StateUnreadable);
  });

  it('does not read another format, version, scene or container', async () => {
    const state = await encodeDeskState(staged, header());
    const unreadable = (p: Promise<unknown>, what: RegExp) => expect(p).rejects.toThrow(what);
    await unreadable(decodeDeskState({ ...state, format: 'other.state' }, SCENE), /format/);
    await unreadable(decodeDeskState({ ...state, version: 2 }, SCENE), /version 2/);
    await unreadable(decodeDeskState(state, 'clp_2'), new RegExp(`belongs to scene '${SCENE}', not 'clp_2'`));
    const b = bytesOf(state).slice();
    b[0] = 0;
    await unreadable(decodeDeskState({ ...state, data: b.buffer }, SCENE), /not one this desk wrote/);
    const v = bytesOf(state).slice();
    v[8] = 9;
    await unreadable(decodeDeskState({ ...state, data: v.buffer }, SCENE), /container is version 9/);
    await expect(decodeDeskState({ ...state, version: 2 }, SCENE)).rejects.toBeInstanceOf(StateUnreadable);
  });

  it('does not read a cut, corrupted or foreign payload, or a document without a staging of the scene', async () => {
    for (const compress of [true, false]) {
      const state = await encodeDeskState(staged, header(), { compress });
      const b = bytesOf(state);
      const cut = b.slice(0, b.length - 5);
      await expect(decodeDeskState({ ...state, data: cut.buffer }, SCENE)).rejects.toBeInstanceOf(
        StateUnreadable,
      );
      // gzip's CRC catches any change; an uncompressed update has no checksum, so its structure is
      // broken (the first bytes: how many clients, how many structs)
      const bad = b.slice();
      const at = 16 + new DataView(b.buffer).getUint32(12, true);
      if (compress) for (let i = b.length - 20; i < b.length - 2; i++) bad[i] ^= 0x5a;
      else bad.fill(0xff, at, at + 6);
      await expect(decodeDeskState({ ...state, data: bad.buffer }, SCENE)).rejects.toBeInstanceOf(
        StateUnreadable,
      );
    }
    // a payload that is not a Yjs document
    const junk = await encodeDeskState(new Uint8Array([200, 1, 2, 3, 4, 5]), header(), { compress: false });
    await expect(decodeDeskState(junk, SCENE)).rejects.toThrow(/does not read/);
    // a header without its lineage
    const noLineage = await encodeDeskState(staged, header({ lineage: '' }), { compress: false });
    await expect(decodeDeskState(noLineage, SCENE)).rejects.toThrow(/scene or lineage/);
    // fewer bytes than the prefix
    await expect(
      decodeDeskState({ format: '3d-editor.desk-state', version: 1, data: new ArrayBuffer(3) }, SCENE),
    ).rejects.toBeInstanceOf(StateUnreadable);
    // a document of the scene's id that holds no staging, or the staging of another scene
    const empty = await encodeDeskState(Y.encodeStateAsUpdate(new Y.Doc()), header());
    await expect(decodeDeskState(empty, SCENE)).rejects.toThrow(/holds no staging of this scene/);
    const other = { ...BRIEF(), id: 'clp_other0000000001' };
    const foreign = await encodeDeskState(stagedUpdate('lineage-a', other), header());
    await expect(decodeDeskState(foreign, SCENE)).rejects.toThrow(/holds no staging of this scene/);
    // a header whose lineage is not the document's
    const mismatch = await encodeDeskState(staged, header({ lineage: 'lineage-b' }));
    await expect(decodeDeskState(mismatch, SCENE)).rejects.toThrow(/header does not match/);
  });

  it('keeps to 64 MiB packed and 256 MiB unpacked, both ways', async () => {
    const big = new Uint8Array(MAX_STATE_BYTES);
    const err = await encodeDeskState(big, header(), { compress: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateTooLarge);
    expect((err as StateTooLarge).bytes).toBeGreaterThan(MAX_STATE_BYTES);
    expect((err as Error).message).toMatch(/64 MiB/);
    await expect(
      decodeDeskState(
        { format: '3d-editor.desk-state', version: 1, data: new ArrayBuffer(MAX_STATE_BYTES + 1) },
        SCENE,
      ),
    ).rejects.toThrow(/over 64 MiB/);
    // a document over 256 MiB is not written (the desk never writes what it would not read)
    const huge = { length: MAX_UPDATE_BYTES + 1 } as Uint8Array;
    const tooBig = await encodeDeskState(huge, header()).catch((e: unknown) => e);
    expect(tooBig).toBeInstanceOf(StateTooLarge);
    expect((tooBig as Error).message).toMatch(/256 MiB a desk state may hold/);
    // a header that says more than 256 MiB is refused before anything is unpacked
    const says = container({ ...header(), updateBytes: MAX_UPDATE_BYTES + 1 }, new Uint8Array(32), 1);
    await expect(decodeDeskState(says, SCENE)).rejects.toThrow(/over the 256 MiB a state may hold/);
  });

  it('stops unpacking a gzip bomb once it passes what the header says', async () => {
    // 64 MiB of zeros in about 64 KiB, its end broken: an unpacker that read it all would fail on
    // the broken end ("does not unpack"); one that stops at the header's 1 MiB never gets there
    const payload = bomb(64);
    const state = container({ ...header(), updateBytes: 1024 * 1024 }, payload, 1);
    const Real = DecompressionStream;
    let unpacked = 0;
    class Counting {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const ds = new Real(format);
        this.writable = ds.writable;
        this.readable = ds.readable.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) {
              unpacked += chunk.length;
              c.enqueue(chunk);
            },
          }),
        );
      }
    }
    vi.stubGlobal('DecompressionStream', Counting);
    await expect(decodeDeskState(state, SCENE)).rejects.toThrow(/unpacks to more than it says/);
    expect(unpacked).toBeGreaterThan(1024 * 1024);
    expect(unpacked).toBeLessThan(24 * 1024 * 1024);
    // the same with the JS unpacking (no DecompressionStream)
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(decodeDeskState(state, SCENE)).rejects.toThrow(/unpacks to more than it says/);
  });

  it('names a staging by its lineage', () => {
    const a = newLineage();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newLineage()).not.toBe(a);
    const doc = SceneDoc.create({ empty: true });
    expect(readLineage(doc)).toBeNull();
    doc.transact(() => writeLineage(doc, a));
    expect(readLineage(doc)).toBe(a);
  });

  it('merges a state of the same staging, replaces with any other, else keeps or stages', () => {
    const local = (lineage: string | null) => ({ staged: true, lineage });
    expect(restorePlan({ lineage: 'a' }, local('a'))).toBe('merge');
    expect(restorePlan({ lineage: 'a' }, local('b'))).toBe('replace');
    expect(restorePlan({ lineage: 'a' }, local(null))).toBe('replace');
    expect(restorePlan({ lineage: 'a' }, { staged: false, lineage: 'a' })).toBe('replace');
    expect(restorePlan(null, local('a'))).toBe('local');
    expect(restorePlan(null, { staged: false, lineage: null })).toBe('stage');
  });
});
