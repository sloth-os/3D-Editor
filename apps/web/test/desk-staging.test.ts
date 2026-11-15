import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { SceneDoc, briefRecord, getShots, type SceneBrief } from '@3d-editor/core';
import { checkSummary, runStaging, type StagingRequest } from '../src/embed/staging-engine';
import { StagingClient, StagingError, type StagingWorkerFactory } from '../src/embed/staging';
import { readLineage } from '../src/embed/state';

/*
 * The desk's brief work off the main thread (embed/staging-engine.ts, the staging worker's body,
 * and embed/staging.ts, the page's client): staging the contract's example brief into an empty
 * document as one change with its lineage, updating it to a later brief, the shot results in the
 * host's ids and brief order, the checks, failures as replies, and the client's worker protocol
 * (in order, in process without workers, a dead worker made again).
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/desk-protocol', name), 'utf8'));
const EXAMPLE = (): SceneBrief => structuredClone(fixture('open.json').scene);
const SHOT_A = 'sht_0123456789aaaa';
const SHOT_B = 'sht_0123456789bbbb';

function changedBrief(): SceneBrief {
  const b = EXAMPLE();
  b.shots[1].durationSec = 3.5;
  b.shots.push({
    ...b.shots[1],
    id: 'sht_0123456789cccc',
    index: 2,
    durationSec: 2,
    castIds: ['chr_0123456789pipd'],
    elementIds: [],
    layout: [],
    move: null,
    framing: 'medium',
  });
  return b;
}

const empty = () => Y.encodeStateAsUpdate(SceneDoc.create({ empty: true }).ydoc);

/** The example brief staged into an empty document (the change applied to that same document). */
function staged() {
  const doc = SceneDoc.create({ empty: true });
  const r = runStaging({
    kind: 'stage',
    update: Y.encodeStateAsUpdate(doc.ydoc),
    brief: EXAMPLE(),
    lineage: 'lin-1',
    generator: 'test',
  });
  if (!r.ok || r.kind !== 'stage') throw new Error(JSON.stringify(r));
  Y.applyUpdate(doc.ydoc, r.diff);
  return { r, doc };
}

describe('the staging engine', () => {
  it('stages the example brief as one change, with its lineage and checks', () => {
    const { r, doc } = staged();
    expect(r.summary.shots).toBe(2);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(readLineage(doc)).toBe('lin-1');
    expect(doc.map('meta').get('name')).toBe(EXAMPLE().name);
    expect(doc.map('meta').get('generator')).toBe('test');
    expect(briefRecord(doc)?.sceneId).toBe(EXAMPLE().id);
    const shots = getShots(doc);
    expect(shots.map((s) => s.external?.shot)).toEqual([SHOT_A, SHOT_B]);
    expect(shots.map((s) => s.frame_end - s.frame_start + 1)).toEqual([72, 60]);
    expect(r.check.summary).toMatch(/^2 shots checked/);
    expect(r.check.issues.every((i) => shots.some((s) => s.id === i.shot))).toBe(true);
  });

  it('updates the staging to a later brief and reports the shot results of the shots asked', () => {
    const { doc } = staged();
    const u = runStaging({ kind: 'update', update: Y.encodeStateAsUpdate(doc.ydoc), brief: changedBrief() });
    if (!u.ok || u.kind !== 'update') throw new Error(JSON.stringify(u));
    Y.applyUpdate(doc.ydoc, u.diff);
    expect(u.summary.shots).toBe(3);
    expect(getShots(doc).map((s) => s.frame_end - s.frame_start + 1)).toEqual([72, 84, 48]);
    // in brief order, whatever order they are asked in
    const res = runStaging({
      kind: 'results',
      update: Y.encodeStateAsUpdate(doc.ydoc),
      shots: [SHOT_B, SHOT_A],
    });
    if (!res.ok || res.kind !== 'results') throw new Error(JSON.stringify(res));
    expect(res.results.map((x) => [x.shotId, x.frames])).toEqual([
      [SHOT_A, 72],
      [SHOT_B, 84],
    ]);
    const all = runStaging({ kind: 'results', update: Y.encodeStateAsUpdate(doc.ydoc) });
    expect(all.ok && all.kind === 'results' && all.results.length).toBe(3);
    const check = runStaging({ kind: 'check', update: Y.encodeStateAsUpdate(doc.ydoc) });
    expect(check.ok && check.kind === 'check' && check.check.summary).toMatch(/^3 shots checked/);
  });

  it('answers a failure with its message and code', () => {
    const r = runStaging({ kind: 'update', update: empty(), brief: EXAMPLE() });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.length > 0).toBe(true);
    const junk = runStaging({ kind: 'check', update: new Uint8Array([255, 255, 255]) });
    expect(junk.ok).toBe(false);
  });

  it('words a check summary as desk.check does', () => {
    expect(checkSummary(2, [])).toMatch(/^2 shots/);
    const s = checkSummary(1, [
      { severity: 'error' } as never,
      { severity: 'warning' } as never,
      { severity: 'warning' } as never,
    ]);
    expect(s).toMatch(/1 error/);
    expect(s).toMatch(/2 warnings/);
  });
});

describe('the staging client', () => {
  it('runs in process where there are no workers', async () => {
    const client = new StagingClient(() => null);
    const r = await client.stage(empty(), EXAMPLE(), 'lin-2', 'test');
    expect(r.summary.shots).toBe(2);
    await expect(client.update(empty(), EXAMPLE())).rejects.toBeInstanceOf(StagingError);
  });

  /** A fake worker that runs the engine itself, after a tick, and can die. */
  function fakeWorkers() {
    const made: { die(): void; posted: number }[] = [];
    const factory: StagingWorkerFactory = () => {
      const w = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        posted: 0,
        terminate: vi.fn(),
        postMessage(m: { id: number; request: never }) {
          w.posted++;
          setTimeout(
            () => w.onmessage?.({ data: { id: m.id, reply: runStaging(m.request) } } as MessageEvent),
            0,
          );
        },
        die() {
          w.onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent);
        },
      };
      made.push(w);
      return w;
    };
    return { factory, made };
  }

  it("runs the person's requests (results, an update) ahead of a background check still waiting", async () => {
    // a worker that answers each request only when the test says so
    const posted: { id: number; request: StagingRequest }[] = [];
    let w: { onmessage: ((e: MessageEvent) => void) | null } | null = null;
    const factory: StagingWorkerFactory = () => {
      const worker = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        terminate: vi.fn(),
        postMessage: (m: { id: number; request: StagingRequest }) => void posted.push(m),
      };
      w = worker;
      return worker;
    };
    const answer = (i: number) =>
      w!.onmessage!({ data: { id: posted[i].id, reply: runStaging(posted[i].request) } } as MessageEvent);
    const kinds = () => posted.map((p) => p.request.kind);
    const client = new StagingClient(factory);
    const update = Y.encodeStateAsUpdate(staged().doc.ydoc);
    // a background check runs and another waits behind it; then an export asks for the results
    const first = client.check(update, { background: true });
    const second = client.check(update, { background: true });
    const results = client.results(update);
    await vi.waitFor(() => expect(kinds()).toEqual(['check']));
    answer(0);
    await first;
    // the results go next, ahead of the check that waits (it is not dropped: it runs after them)
    await vi.waitFor(() => expect(kinds()).toEqual(['check', 'results']));
    answer(1);
    expect((await results).results.map((r) => r.shotId)).toEqual([SHOT_A, SHOT_B]);
    await vi.waitFor(() => expect(kinds()).toEqual(['check', 'results', 'check']));
    answer(2);
    expect((await second).check.summary).toMatch(/^2 shots checked/);
    // the person's own requests keep their order among themselves
    const u = client.update(update, changedBrief());
    const c = client.check(update);
    await vi.waitFor(() => expect(kinds().slice(3)).toEqual(['update']));
    answer(3);
    await u;
    await vi.waitFor(() => expect(kinds().slice(3)).toEqual(['update', 'check']));
    answer(4);
    await c;
    client.dispose();
  });

  it('answers requests in order through its worker, and makes a new worker after one dies', async () => {
    const { factory, made } = fakeWorkers();
    const client = new StagingClient(factory);
    client.warm();
    expect(made).toHaveLength(1);
    const { doc } = staged();
    const a = client.check(empty());
    const b = client.results(Y.encodeStateAsUpdate(doc.ydoc));
    expect((await a).check.summary).toMatch(/^0 shots/);
    expect((await b).results.map((r) => r.shotId)).toEqual([SHOT_A, SHOT_B]);
    expect(made[0].posted).toBe(2);
    // the worker dies while a request waits: it fails, the next request gets a new worker
    const pending = new Promise<void>((done) => {
      const p = client.check(empty());
      p.catch((e) => {
        expect(e).toBeInstanceOf(StagingError);
        expect(String(e.message)).toMatch(/boom/);
        done();
      });
    });
    // let the queued request reach the worker, then kill it before it answers
    await Promise.resolve();
    await Promise.resolve();
    made[0].die();
    await pending;
    expect((await client.check(empty())).check.summary).toMatch(/^0 shots/);
    expect(made).toHaveLength(2);
    client.dispose();
  });
});
