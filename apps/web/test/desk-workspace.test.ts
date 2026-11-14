import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { getShots, type SceneBrief } from '@3d-editor/core';
import { session } from '../src/app/store';
import { StagingClient } from '../src/embed/staging';
import { decodeDeskState, encodeDeskState, readLineage } from '../src/embed/state';
import { DeskWorkspace, deskProjectId } from '../src/embed/workspace';

/*
 * The desk's scene (embed/workspace.ts) in this browser's IndexedDB (fake-indexeddb): a project per
 * host origin and scene, staged from the brief, reopened from the local copy, restored from a host's
 * state (merged with a copy of the same staging, else replacing it), a state it does not read
 * reported and the brief staged instead, the brief's changes and Update shots as one undo step.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/desk-protocol', name), 'utf8'));
const EXAMPLE = (): SceneBrief => structuredClone(fixture('open.json').scene);
const SHOT_A = 'sht_0123456789aaaa';
const SHOT_B = 'sht_0123456789bbbb';
const SHOT_C = 'sht_0123456789cccc';

function changedBrief(): SceneBrief {
  const b = EXAMPLE();
  b.shots[1].durationSec = 3.5;
  b.shots.push({
    ...b.shots[1],
    id: SHOT_C,
    index: 2,
    durationSec: 2,
    description: 'Medium: Pip barks at the pond.',
    action: '',
    castIds: ['chr_0123456789pipd'],
    elementIds: [],
    framing: 'medium',
    movement: 'static',
    move: null,
    lensMm: null,
    layout: [],
  });
  return b;
}

let n = 0;
/** A host origin of its own per test (its projects do not meet another test's). */
const origin = () => `https://host-${++n}-${Date.now()}.example`;

const open: DeskWorkspace[] = [];
function workspace(): DeskWorkspace {
  const ws = new DeskWorkspace(new StagingClient(() => null));
  open.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of open.splice(0)) ws.close();
});

const hostShots = (ws: DeskWorkspace) => getShots(ws.session!.doc).map((s) => s.external?.shot ?? null);
const frames = (ws: DeskWorkspace) => getShots(ws.session!.doc).map((s) => s.frame_end - s.frame_start + 1);

/** Opens `brief` for `host` in a new workspace, then closes it; its state. */
async function stateOf(host: string, brief = EXAMPLE()) {
  const ws = workspace();
  await ws.open({ hostOrigin: host, brief, state: null });
  return (await ws.encodeState()).state;
}

describe('the desk workspace', () => {
  it('keeps a project per host origin and scene', () => {
    const a = deskProjectId('https://a.example', 'clp_1');
    expect(a).toMatch(/^desk-[0-9a-f]{32}$/);
    expect(deskProjectId('https://a.example', 'clp_1')).toBe(a);
    expect(deskProjectId('https://b.example', 'clp_1')).not.toBe(a);
    expect(deskProjectId('https://a.example', 'clp_2')).not.toBe(a);
  });

  it('stages the brief, then reopens the local copy', async () => {
    const host = origin();
    const ws = workspace();
    const r = await ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    expect(r).toMatchObject({ source: 'brief', changes: null, unreadable: null, plan: 'stage', persistent: true });
    expect(r.stageMs).toBeGreaterThanOrEqual(0);
    expect(session.value).toBe(ws.session);
    expect(ws.projectId).toBe(deskProjectId(host, EXAMPLE().id));
    expect(hostShots(ws)).toEqual([SHOT_A, SHOT_B]);
    expect(ws.stagedShots()).toEqual([SHOT_A, SHOT_B]);
    expect(ws.lengthMismatches()).toEqual([]);
    // the staging is where the scene starts: nothing to undo
    expect(ws.session!.undo.undoStack.length).toBe(0);
    const { state, shots } = await ws.encodeState();
    expect(shots).toBe(2);
    const { header, update } = await decodeDeskState(state, EXAMPLE().id);
    expect(header.lineage).toBe(readLineage(ws.session!.doc));
    expect(update.length).toBeGreaterThan(1000);
    ws.close();

    const again = workspace();
    const r2 = await again.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    expect(r2).toMatchObject({ source: 'local', changes: null, plan: 'local', stageMs: null });
    expect(hostShots(again)).toEqual([SHOT_A, SHOT_B]);
  });

  it("opens a host's state where there is no copy, and merges it with a copy of the same staging", async () => {
    const host = origin();
    const state = await stateOf(host);
    // another host origin: no copy there, the state replaces nothing
    const fresh = workspace();
    const r = await fresh.open({ hostOrigin: origin(), brief: EXAMPLE(), state });
    expect(r).toMatchObject({ source: 'state', plan: 'replace', unreadable: null, changes: null });
    expect(hostShots(fresh)).toEqual([SHOT_A, SHOT_B]);
    // the same origin: the copy has the same lineage, the state merges into it
    const same = workspace();
    const m = await same.open({ hostOrigin: host, brief: EXAMPLE(), state });
    expect(m).toMatchObject({ source: 'state', plan: 'merge' });
  });

  it('merges edits made here and edits in the state when they share a staging', async () => {
    const host = origin();
    const ws = workspace();
    await ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    const s = ws.session!;
    const state = (await ws.encodeState()).state;
    // an edit only the state will carry (made on a copy of the document from the state)
    const { update } = await decodeDeskState(state, EXAMPLE().id);
    const other = new Y.Doc();
    Y.applyUpdate(other, update);
    other.getMap('meta').set('from_state', 'yes');
    const header = (await decodeDeskState(state, EXAMPLE().id)).header;
    const merged = await encodeDeskState(Y.encodeStateAsUpdate(other), {
      sceneId: header.sceneId,
      lineage: header.lineage,
      shots: header.shots,
      savedAt: header.savedAt,
      deskVersion: header.deskVersion,
    });
    // an edit only the local copy has
    s.doc.transact(() => s.doc.map('meta').set('from_here', 'yes'));
    ws.close();
    const back = workspace();
    const r = await back.open({ hostOrigin: host, brief: EXAMPLE(), state: merged });
    expect(r.plan).toBe('merge');
    const meta = back.session!.doc.map('meta');
    expect(meta.get('from_state')).toBe('yes');
    expect(meta.get('from_here')).toBe('yes');
  });

  it('replaces a copy of another staging with the state', async () => {
    const host = origin();
    const ws = workspace();
    await ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    ws.session!.doc.transact(() => ws.session!.doc.map('meta').set('local_only', 'yes'));
    const localLineage = readLineage(ws.session!.doc);
    ws.close();
    // a state of the same scene from another staging (another host's desk staged it again)
    const elsewhere = await stateOf(origin());
    const back = workspace();
    const r = await back.open({ hostOrigin: host, brief: EXAMPLE(), state: elsewhere });
    expect(r).toMatchObject({ source: 'state', plan: 'replace' });
    expect(readLineage(back.session!.doc)).not.toBe(localLineage);
    expect(back.session!.doc.map('meta').get('local_only')).toBeUndefined();
    expect(hostShots(back)).toEqual([SHOT_A, SHOT_B]);
  });

  it("does not apply a state it cannot read, says why, and opens as without one", async () => {
    const other = { ...EXAMPLE(), id: 'clp_other0000000001' };
    const state = await stateOf(origin(), other);
    const ws = workspace();
    const r = await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state });
    expect(r.source).toBe('brief');
    expect(r.unreadable).toMatch(/belongs to scene 'clp_other0000000001'/);
    expect(hostShots(ws)).toEqual([SHOT_A, SHOT_B]);
    const garbage = workspace();
    const g = await garbage.open({
      hostOrigin: origin(),
      brief: EXAMPLE(),
      state: { format: '3d-editor.desk-state', version: 1, data: new Uint8Array([1, 2, 3]).buffer },
    });
    expect(g.source).toBe('brief');
    expect(g.unreadable).toBeTruthy();
  });

  it('lists how a later brief differs and updates the shots to it in one undo step', async () => {
    const host = origin();
    const state = await stateOf(host);
    const ws = workspace();
    const r = await ws.open({ hostOrigin: host, brief: changedBrief(), state });
    expect(r.source).toBe('state');
    expect(r.changes).toEqual(fixture('opened-changed.json').changes);
    expect(ws.changes()).toEqual(r.changes);
    // the staging stays until the person updates
    expect(hostShots(ws)).toEqual([SHOT_A, SHOT_B]);
    expect(ws.stagedShots()).toEqual([SHOT_A, SHOT_B]);
    expect(ws.lengthMismatches().map((m) => [m.shotId, m.deskFrames, m.briefFrames])).toEqual([[SHOT_B, 60, 84]]);
    const left = await ws.updateFromBrief();
    expect(left).toBeNull();
    expect(hostShots(ws)).toEqual([SHOT_A, SHOT_B, SHOT_C]);
    expect(frames(ws)).toEqual([72, 84, 48]);
    expect(ws.lengthMismatches()).toEqual([]);
    const s = ws.session!;
    expect(s.undo.undoStack.length).toBe(1);
    s.undo.undo();
    expect(hostShots(ws)).toEqual([SHOT_A, SHOT_B]);
    expect(frames(ws)).toEqual([72, 60]);
  });

  it('tells its listener about every change of the scene', async () => {
    const ws = workspace();
    await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state: null });
    let edits = 0;
    const stop = ws.onEdit(() => edits++);
    ws.session!.doc.transact(() => ws.session!.doc.map('meta').set('x', 1));
    expect(edits).toBe(1);
    stop();
    ws.session!.doc.transact(() => ws.session!.doc.map('meta').set('x', 2));
    expect(edits).toBe(1);
  });
});
