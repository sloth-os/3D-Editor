import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { SceneDoc } from '@3d-editor/core';
import { MAX_STATE_BYTES } from '../src/embed/protocol';
import {
  STATE_MAGIC,
  StateTooLarge,
  StateUnreadable,
  decodeDeskState,
  encodeDeskState,
  gzipAvailable,
  newLineage,
  readLineage,
  readStateHeader,
  restorePlan,
  writeLineage,
} from '../src/embed/state';

/*
 * The desk state (embed/state.ts): the container round trip (gzipped and not), what does not read
 * (another format, version, scene, container, a cut or corrupted payload, not a Yjs document), the
 * 64 MiB limit both ways, the lineage and the merge rule.
 */

function sceneUpdate(name = 'Kite Day'): { doc: SceneDoc; update: Uint8Array } {
  const doc = SceneDoc.create({ empty: true });
  doc.transact(() => {
    doc.map('meta').set('name', name);
    writeLineage(doc, 'lineage-a');
  });
  return { doc, update: Y.encodeStateAsUpdate(doc.ydoc) };
}

const header = (over: Partial<{ sceneId: string; lineage: string; shots: number }> = {}) => ({
  sceneId: 'clp_1',
  lineage: 'lineage-a',
  shots: 2,
  savedAt: '2026-11-14T10:00:00.000Z',
  deskVersion: 'test',
  ...over,
});

const bytesOf = (s: { data: ArrayBuffer }) => new Uint8Array(s.data);

describe('the desk state', () => {
  it('has gzip streams here', () => {
    expect(gzipAvailable()).toBe(true);
  });

  it.each([true, false])('round-trips a scene (compressed: %s)', async (compress) => {
    const { update } = sceneUpdate();
    const state = await encodeDeskState(update, header(), { compress });
    expect(state.format).toBe('3d-editor.desk-state');
    expect(state.version).toBe(1);
    const b = bytesOf(state);
    expect([...b.subarray(0, 8)]).toEqual([...STATE_MAGIC]);
    expect(b[9]).toBe(compress ? 1 : 0);
    const read = readStateHeader(b);
    expect(read.header).toMatchObject({ ...header(), updateBytes: update.length });
    const { header: h, update: back } = await decodeDeskState(state, 'clp_1');
    expect(h.lineage).toBe('lineage-a');
    expect([...back]).toEqual([...update]);
    const doc = SceneDoc.fromUpdate(back);
    expect(doc.map('meta').get('name')).toBe('Kite Day');
    expect(readLineage(doc)).toBe('lineage-a');
    // a view of the bytes (a host that kept a Uint8Array) reads the same
    const view = await decodeDeskState({ ...state, data: new Uint8Array(state.data) }, 'clp_1');
    expect([...view.update]).toEqual([...update]);
  });

  it('compresses a scene', async () => {
    const doc = SceneDoc.create({ empty: true });
    doc.transact(() => {
      for (let i = 0; i < 200; i++) doc.map('meta').set(`k${i}`, 'the same words again and again');
    });
    const update = Y.encodeStateAsUpdate(doc.ydoc);
    const state = await encodeDeskState(update, header());
    expect(state.data.byteLength).toBeLessThan(update.length / 2);
  });

  it('does not read another format, version, scene or container', async () => {
    const { update } = sceneUpdate();
    const state = await encodeDeskState(update, header());
    const unreadable = (p: Promise<unknown>, what: RegExp) => expect(p).rejects.toThrow(what);
    await unreadable(decodeDeskState({ ...state, format: 'other.state' }, 'clp_1'), /format/);
    await unreadable(decodeDeskState({ ...state, version: 2 }, 'clp_1'), /version 2/);
    await unreadable(decodeDeskState(state, 'clp_2'), /belongs to scene 'clp_1', not 'clp_2'/);
    const b = bytesOf(state).slice();
    b[0] = 0;
    await unreadable(decodeDeskState({ ...state, data: b.buffer }, 'clp_1'), /not one this desk wrote/);
    const v = bytesOf(state).slice();
    v[8] = 9;
    await unreadable(decodeDeskState({ ...state, data: v.buffer }, 'clp_1'), /container is version 9/);
    await expect(decodeDeskState({ ...state, version: 2 }, 'clp_1')).rejects.toBeInstanceOf(StateUnreadable);
  });

  it('does not read a cut, corrupted or foreign payload', async () => {
    const { update } = sceneUpdate();
    for (const compress of [true, false]) {
      const state = await encodeDeskState(update, header(), { compress });
      const b = bytesOf(state);
      const cut = b.slice(0, b.length - 5);
      await expect(decodeDeskState({ ...state, data: cut.buffer }, 'clp_1')).rejects.toBeInstanceOf(
        StateUnreadable,
      );
      const bad = b.slice();
      for (let i = b.length - 20; i < b.length - 2; i++) bad[i] ^= 0x5a;
      await expect(decodeDeskState({ ...state, data: bad.buffer }, 'clp_1')).rejects.toBeInstanceOf(
        StateUnreadable,
      );
    }
    // a payload that is not a Yjs document
    const junk = await encodeDeskState(new Uint8Array([200, 1, 2, 3, 4, 5]), header(), { compress: false });
    await expect(decodeDeskState(junk, 'clp_1')).rejects.toThrow(/does not read/);
    // a header without its lineage
    const noLineage = await encodeDeskState(update, header({ lineage: '' }), { compress: false });
    await expect(decodeDeskState(noLineage, 'clp_1')).rejects.toThrow(/scene or lineage/);
    // fewer bytes than the prefix
    await expect(
      decodeDeskState({ format: '3d-editor.desk-state', version: 1, data: new ArrayBuffer(3) }, 'clp_1'),
    ).rejects.toBeInstanceOf(StateUnreadable);
  });

  it('keeps to 64 MiB both ways', async () => {
    const big = new Uint8Array(MAX_STATE_BYTES);
    const err = await encodeDeskState(big, header(), { compress: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateTooLarge);
    expect((err as StateTooLarge).bytes).toBeGreaterThan(MAX_STATE_BYTES);
    expect((err as Error).message).toMatch(/64 MiB/);
    await expect(
      decodeDeskState(
        { format: '3d-editor.desk-state', version: 1, data: new ArrayBuffer(MAX_STATE_BYTES + 1) },
        'clp_1',
      ),
    ).rejects.toThrow(/over 64 MiB/);
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
    const staged = (lineage: string | null) => ({ staged: true, lineage });
    expect(restorePlan({ lineage: 'a' }, staged('a'))).toBe('merge');
    expect(restorePlan({ lineage: 'a' }, staged('b'))).toBe('replace');
    expect(restorePlan({ lineage: 'a' }, staged(null))).toBe('replace');
    expect(restorePlan({ lineage: 'a' }, { staged: false, lineage: 'a' })).toBe('replace');
    expect(restorePlan(null, staged('a'))).toBe('local');
    expect(restorePlan(null, { staged: false, lineage: null })).toBe('stage');
  });
});
