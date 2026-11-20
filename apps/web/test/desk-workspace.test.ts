import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getShots, type SceneBrief } from '@3d-editor/core';
import { session } from '../src/app/store';
import { DeskController, type ControllerDeps } from '../src/embed/controller';
import type { DeskExportOutcome, DeskExportRequest } from '../src/embed/export';
import type { DeskMessage } from '../src/embed/protocol';
import { StagingClient, type StagingWorkerFactory } from '../src/embed/staging';
import { runStaging, type StagingRequest } from '../src/embed/staging-engine';
import { decodeDeskState, encodeDeskState, readLineage } from '../src/embed/state';
import {
  DeskWorkspace,
  OTHER_DESK_WAIT,
  SCENE_LOCK_PREFIX,
  STORAGE_TIMEOUT_MS,
  deskProjectId,
  type SceneLocks,
  type WorkProgress,
  type WorkspaceOptions,
} from '../src/embed/workspace';
import { localIndex } from '../src/project/local-index';
import { ProjectSession } from '../src/project/session';
import { lastCheck } from '../src/ui/director/state';

/*
 * The desk's scene (embed/workspace.ts) in this browser's IndexedDB (fake-indexeddb): a project per
 * host origin and scene, staged from the brief, reopened from the local copy, restored from a host's
 * state (merged with a copy of the same staging, else replacing it), a state it does not read
 * reported without touching the local copy, the same state bytes while the scene does not change
 * (the very bytes it opened from), gzip read without DecompressionStream, storage that fails after
 * the probe (memory, a notice, no hang), one desk per host and scene (a second waits for the
 * scene's lock), the checks stamped with the revision they checked (and the full check after staging
 * and Update shots), the brief's changes and Update shots as one undo step, a Close while it stages
 * (the staging stopped, nothing of it kept) or clears the copy it replaces (nothing of the host's
 * state written into the copy); and with the real controller: no state sent on its own
 * after one it could not read, Close while the scene stages (its worker stopped, a later open taken).
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

/**
 * Web Locks as one browser partition has them: one holder per name, the others wait in turn; a
 * request with both `ifAvailable` and `signal` is refused, as Chromium refuses it (NotSupportedError).
 */
class FakeLocks implements SceneLocks {
  /** The names asked for, in order. */
  readonly names: string[] = [];
  /** Held before a request that does not wait is answered (the test opens it). */
  gate: Promise<void> | null = null;
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();

  /** Whether another request for `name` would wait. */
  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  async request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown> {
    if (options.ifAvailable && options.signal)
      throw new DOMException(
        "The 'signal' and 'ifAvailable' options cannot be used together.",
        'NotSupportedError',
      );
    if (options.signal?.aborted) throw new DOMException('The lock request was aborted', 'AbortError');
    this.names.push(name);
    if (options.ifAvailable && this.gate) await this.gate;
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve, reject) => {
        const list = this.waiting.get(name) ?? [];
        this.waiting.set(name, list);
        list.push(resolve);
        options.signal?.addEventListener('abort', () => {
          list.splice(list.indexOf(resolve), 1);
          reject(new DOMException('The lock request was aborted', 'AbortError'));
        });
      });
    }
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
      this.waiting.get(name)?.shift()?.();
    }
  }
}

let n = 0;
/*
 * A test that stages or reopens the scene more than once takes 30 s (its last argument): up to 1.8 s
 * with this file alone, 4.1 s in the whole web suite and 2.8 s beside core's suite, close to
 * vitest's 5 s default.
 */

/** A host origin of its own per test (its projects do not meet another test's). */
const origin = () => `https://host-${++n}-${Date.now()}.example`;

const locks = new FakeLocks();
const open: DeskWorkspace[] = [];
function workspace(opts: WorkspaceOptions = {}, onWork?: (w: WorkProgress | null) => void): DeskWorkspace {
  const ws = new DeskWorkspace(new StagingClient(() => null), onWork, { locks, ...opts });
  open.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of open.splice(0)) ws.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const hostShots = (ws: DeskWorkspace) => getShots(ws.session!.doc).map((s) => s.external?.shot ?? null);
const frames = (ws: DeskWorkspace) => getShots(ws.session!.doc).map((s) => s.frame_end - s.frame_start + 1);
const bytes = (s: { data: ArrayBuffer }) => new Uint8Array(s.data);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const edit = (ws: DeskWorkspace, key: string, value: unknown) =>
  ws.session!.doc.transact(() => ws.session!.doc.map('meta').set(key, value));

/**
 * Holds every gzipped state's unpacking (DecompressionStream) until `go()`; `started` settles once
 * one began. Undone by vi.unstubAllGlobals.
 */
function holdUnpacking() {
  let begin!: () => void;
  const started = new Promise<void>((r) => (begin = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const Real = DecompressionStream;
  class Held {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<BufferSource>;
    constructor(format: CompressionFormat) {
      const ds = new Real(format);
      this.writable = ds.writable;
      this.readable = ds.readable.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async start() {
            begin();
            await gate;
          },
        }),
      );
    }
  }
  vi.stubGlobal('DecompressionStream', Held);
  return { started, go };
}

/** What an open came to within `ms`: 'opened', the name of its error, or 'still opening'. */
const settledWithin = (p: Promise<unknown>, ms = 1000) =>
  Promise.race([
    p.then(
      () => 'opened',
      (e: Error) => e.name,
    ),
    new Promise<string>((r) => setTimeout(() => r('still opening'), ms)),
  ]);

/** Opens `brief` for `host` in a new workspace, then closes it; its state. */
async function stateOf(host: string, brief = EXAMPLE()) {
  const ws = workspace();
  await ws.open({ hostOrigin: host, brief, state: null });
  const { state } = await ws.encodeState();
  ws.close();
  return state;
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
    expect(r).toMatchObject({
      source: 'brief',
      changes: null,
      unreadable: null,
      plan: 'stage',
      persistent: true,
      notice: null,
    });
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
  }, 30_000);

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
    const state = (await ws.encodeState()).state;
    // an edit only the state will carry (made on a copy of the document from the state)
    const { header, update } = await decodeDeskState(state, EXAMPLE().id);
    const other = new Y.Doc();
    Y.applyUpdate(other, update);
    other.getMap('meta').set('from_state', 'yes');
    const merged = await encodeDeskState(Y.encodeStateAsUpdate(other), {
      sceneId: header.sceneId,
      lineage: header.lineage,
      shots: header.shots,
      deskVersion: header.deskVersion,
    });
    // an edit only the local copy has
    edit(ws, 'from_here', 'yes');
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
    edit(ws, 'local_only', 'yes');
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
  }, 30_000);

  it('does not apply a state it cannot read, says why, and opens as without one: the local copy, else the brief', async () => {
    const other = { ...EXAMPLE(), id: 'clp_other0000000001' };
    const state = await stateOf(origin(), other);
    // no copy here: the brief is staged
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
    // a copy here: the copy, as it was
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    edit(first, 'work', 'kept');
    const lineage = readLineage(first.session!.doc);
    first.close();
    const back = workspace();
    const b = await back.open({ hostOrigin: host, brief: EXAMPLE(), state });
    expect(b).toMatchObject({ source: 'local', plan: 'local' });
    expect(b.unreadable).toMatch(/belongs to scene 'clp_other0000000001'/);
    expect(back.session!.doc.map('meta').get('work')).toBe('kept');
    expect(readLineage(back.session!.doc)).toBe(lineage);
  }, 30_000);

  it('never deletes the local copy for a state of the scene that holds no staging', async () => {
    const host = origin();
    const ws = workspace();
    await ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    edit(ws, 'hand_edit', 'precious');
    const lineage = readLineage(ws.session!.doc);
    ws.close();
    // structurally fine (magic, scene, lineage, sizes, a Yjs document) but no staging in it
    const empty = await encodeDeskState(Y.encodeStateAsUpdate(new Y.Doc()), {
      sceneId: EXAMPLE().id,
      lineage: 'not-the-local-one',
      shots: 0,
      deskVersion: 'test',
    });
    const back = workspace();
    const r = await back.open({ hostOrigin: host, brief: EXAMPLE(), state: empty });
    expect(r).toMatchObject({ source: 'local', plan: 'local' });
    expect(r.unreadable).toMatch(/holds no staging of this scene/);
    expect(back.session!.doc.map('meta').get('hand_edit')).toBe('precious');
    expect(readLineage(back.session!.doc)).toBe(lineage);
  });

  it('sends the same state bytes while the scene does not change', async () => {
    const ws = workspace();
    await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state: null });
    const a = bytes((await ws.encodeState()).state);
    const b = bytes((await ws.encodeState()).state);
    expect(same(a, b)).toBe(true);
    edit(ws, 'x', 1);
    const c = bytes((await ws.encodeState()).state);
    expect(same(a, c)).toBe(false);
    expect(same(c, bytes((await ws.encodeState()).state))).toBe(true);
  });

  it('gives back the very bytes it opened from while nothing changes, and new ones with local work', async () => {
    const host = origin();
    const given = await stateOf(host);
    const original = bytes(given).slice();
    // another browser (no copy): the state replaces nothing
    const other = workspace();
    expect((await other.open({ hostOrigin: origin(), brief: EXAMPLE(), state: given })).plan).toBe('replace');
    expect(same(bytes((await other.encodeState()).state), original)).toBe(true);
    // the same browser (a copy of the same staging, nothing more in it): merged, the same bytes
    const back = workspace();
    expect((await back.open({ hostOrigin: host, brief: EXAMPLE(), state: given })).plan).toBe('merge');
    expect(same(bytes((await back.encodeState()).state), original)).toBe(true);
    // an edit: new bytes
    edit(back, 'x', 1);
    expect(same(bytes((await back.encodeState()).state), original)).toBe(false);
    back.close();
    // the copy now has work the state lacks: the merge sends new bytes holding it
    const again = workspace();
    expect((await again.open({ hostOrigin: host, brief: EXAMPLE(), state: given })).plan).toBe('merge');
    const out = (await again.encodeState()).state;
    expect(same(bytes(out), original)).toBe(false);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await decodeDeskState(out, EXAMPLE().id)).update);
    expect(doc.getMap('meta').get('x')).toBe(1);
  });

  it('gives back a state another browser wrote uncompressed as it is', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const plain = await stateOf(origin());
    vi.unstubAllGlobals();
    expect(bytes(plain)[9]).toBe(0);
    const ws = workspace();
    await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state: plain });
    const out = bytes((await ws.encodeState()).state);
    expect(out[9]).toBe(0);
    expect(same(out, bytes(plain))).toBe(true);
  });

  it('opens a gzipped state where the browser has no DecompressionStream', async () => {
    const state = await stateOf(origin());
    expect(bytes(state)[9]).toBe(1);
    vi.stubGlobal('DecompressionStream', undefined);
    const ws = workspace();
    const r = await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state });
    expect(r).toMatchObject({ source: 'state', plan: 'replace', unreadable: null });
    expect(hostShots(ws)).toEqual([SHOT_A, SHOT_B]);
  });

  it("keeps the scene in memory, with a notice, when the project's database does not answer", async () => {
    const realOpen = indexedDB.open.bind(indexedDB);
    // the probe database opens; the scene's never answers
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) =>
      name.startsWith('3d-editor-project-desk-') ? ({} as IDBOpenDBRequest) : realOpen(name, version),
    );
    const ws = workspace({ storageTimeoutMs: 150 });
    const r = await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state: null });
    expect(r).toMatchObject({ source: 'brief', plan: 'stage', persistent: false });
    expect(r.notice).toMatch(/did not answer within 1 s.*memory only/);
    expect(hostShots(ws)).toEqual([SHOT_A, SHOT_B]);
  });

  it('waits once for a project database that never answers: it does not ask it again for the copy', async () => {
    const realOpen = indexedDB.open.bind(indexedDB);
    const asked: string[] = [];
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      if (!name.startsWith('3d-editor-project-desk-')) return realOpen(name, version);
      asked.push(name);
      return {} as IDBOpenDBRequest;
    });
    const ws = workspace({ storageTimeoutMs: 300 });
    const t0 = performance.now();
    const r = await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state: null });
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ source: 'brief', persistent: false });
    // one timeout (the session's database), not a second one reading the same database for the copy
    expect(asked).toHaveLength(1);
    expect(ms).toBeGreaterThanOrEqual(300);
  });

  it('keeps the scene in memory, with its local copy read, when storage refuses writes', async () => {
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    edit(first, 'work', 'kept');
    first.close();
    // the quota is used up: the local project list refuses the write
    vi.spyOn(localIndex, 'put').mockRejectedValue(
      new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    );
    const ws = workspace();
    const r = await ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    expect(r).toMatchObject({ source: 'local', plan: 'local', persistent: false });
    expect(r.notice).toMatch(/quota has been exceeded/);
    expect(ws.session!.doc.map('meta').get('work')).toBe('kept');
  });

  it('lets a second desk on the same host and scene wait for the first, which goes on working', async () => {
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    // a state of another staging: the second desk would replace (delete) the first one's copy
    const elsewhere = await stateOf(origin());
    const work: (WorkProgress | null)[] = [];
    const second = workspace({}, (w) => work.push(w));
    let opened = false;
    const opening = second.open({ hostOrigin: host, brief: EXAMPLE(), state: elsewhere }).then((r) => {
      opened = true;
      return r;
    });
    await vi.waitFor(() => expect(work.some((w) => w?.label === OTHER_DESK_WAIT)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toBe(false);
    // the lock is the scene's, named after its local project
    expect(locks.names.at(-1)).toBe(`${SCENE_LOCK_PREFIX}${deskProjectId(host, EXAMPLE().id)}`);
    // the first desk's scene still works: its edits reach its listener and are kept
    let edits = 0;
    first.onEdit(() => edits++);
    expect(() => edit(first, 'still', 'here')).not.toThrow();
    expect(() => edit(first, 'still', 'there')).not.toThrow();
    expect(edits).toBe(2);
    first.close();
    // then the second opens it
    const r = await opening;
    expect(r).toMatchObject({ source: 'state', plan: 'replace' });
    expect(work.at(-1)).toBeNull();
    // a desk that closes while it waits stops waiting
    const third = workspace();
    const waiting = third.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    await new Promise((r) => setTimeout(r, 20));
    third.close();
    await expect(waiting).rejects.toThrow(/abort/i);
  }, 30_000);

  it('ends an open cancelled while its state unpacks: it never waits for the other desk, and that desk keeps its scene', async () => {
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    edit(first, 'work', 'kept');
    // a gzipped state of another staging: opened, it would replace the first desk's copy
    const elsewhere = await stateOf(origin());
    expect(bytes(elsewhere)[9]).toBe(1);
    const lockName = `${SCENE_LOCK_PREFIX}${deskProjectId(host, EXAMPLE().id)}`;
    const asked = locks.names.filter((n) => n === lockName).length;
    const unpacking = holdUnpacking();
    const work: (WorkProgress | null)[] = [];
    const second = workspace({}, (w) => work.push(w));
    const opening = second.open({ hostOrigin: host, brief: EXAMPLE(), state: elsewhere });
    await unpacking.started;
    // Close while the state unpacks
    second.cancelOpen();
    unpacking.go();
    expect(await settledWithin(opening)).toBe('AbortError');
    // it asked for no lock of the scene and did not wait for the first desk
    expect(locks.names.filter((n) => n === lockName).length).toBe(asked);
    expect(work.some((w) => w?.label === OTHER_DESK_WAIT)).toBe(false);
    expect(second.session).toBeNull();
    expect(first.session!.doc.map('meta').get('work')).toBe('kept');
  });

  it("ends an open cancelled while it asks for the scene's lock, and lets go of the lock it got", async () => {
    const host = origin();
    const lockName = `${SCENE_LOCK_PREFIX}${deskProjectId(host, EXAMPLE().id)}`;
    let go!: () => void;
    locks.gate = new Promise<void>((r) => (go = r));
    try {
      const ws = workspace();
      const opening = ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
      await vi.waitFor(() => expect(locks.names.at(-1)).toBe(lockName));
      // Close while the request that does not wait is answered
      ws.cancelOpen();
      go();
      expect(await settledWithin(opening)).toBe('AbortError');
      expect(ws.session).toBeNull();
      await vi.waitFor(() => expect(locks.isHeld(lockName)).toBe(false));
    } finally {
      locks.gate = null;
      go();
    }
  });

  it('ends an open cancelled while it stages: the staging gets the Close, nothing of it is kept, the next open stages again', async () => {
    const host = origin();
    const work: (WorkProgress | null)[] = [];
    const ws = workspace({}, (w) => work.push(w));
    // a staging that comes back after the Close all the same (one that does not stop by itself)
    const stage = ws.staging.stage.bind(ws.staging);
    let given: AbortSignal | undefined;
    let comeBack!: () => void;
    const back = new Promise<void>((r) => (comeBack = r));
    vi.spyOn(ws.staging, 'stage').mockImplementation(async (update, brief, lineage, generator, signal) => {
      given = signal;
      const r = await stage(update, brief, lineage, generator);
      await back;
      return r;
    });
    const opening = ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    await vi.waitFor(() => expect(work.at(-1)?.label).toBe('Staging 2 shots…'));
    ws.cancelOpen();
    // the staging was given the open's signal: Close stops it in the worker
    expect(given?.aborted).toBe(true);
    comeBack();
    expect(await settledWithin(opening)).toBe('AbortError');
    expect(ws.session).toBeNull();
    expect(work.at(-1)).toBeNull();
    // nothing of the staging became the local copy: the next open stages the brief again
    const again = workspace();
    expect(await again.open({ hostOrigin: host, brief: EXAMPLE(), state: null })).toMatchObject({
      source: 'brief',
      plan: 'stage',
    });
  });

  it('ends an open cancelled while it clears the copy it replaces: nothing of the state is written into the copy', async () => {
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    edit(first, 'local_only', 'yes');
    first.close();
    // a state of another staging: the open replaces the local copy with it
    const elsewhere = await stateOf(origin());
    const elsewhereLineage = (await decodeDeskState(elsewhere, EXAMPLE().id)).lineage;
    // the old copy's deletion held until the Close
    const deleteLocal = ProjectSession.deleteLocal.bind(ProjectSession);
    let begun!: () => void;
    const deleting = new Promise<void>((r) => (begun = r));
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    vi.spyOn(ProjectSession, 'deleteLocal').mockImplementation(async (id) => {
      begun();
      await gate;
      return deleteLocal(id);
    });
    const ws = workspace();
    const opening = ws.open({ hostOrigin: host, brief: EXAMPLE(), state: elsewhere });
    await deleting;
    // Close while the copy it replaces is cleared
    ws.cancelOpen();
    go();
    expect(await settledWithin(opening)).toBe('AbortError');
    expect(ws.session).toBeNull();
    vi.restoreAllMocks();
    // the copy holds nothing of the state (nor of the old staging): the next open stages the brief
    const again = workspace();
    expect(await again.open({ hostOrigin: host, brief: EXAMPLE(), state: null })).toMatchObject({
      source: 'brief',
      plan: 'stage',
    });
    expect(readLineage(again.session!.doc)).not.toBe(elsewhereLineage);
    expect(again.session!.doc.map('meta').get('local_only')).toBeUndefined();
  }, 30_000);

  it('stamps a background check with the revision it checked, and shows the blocking line after staging and Update shots', async () => {
    const host = origin();
    const ws = workspace();
    await ws.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    const s = ws.session!;
    // right after staging: the staging's issues, then the full check with each shot's blocking line
    await ws.backgroundCheck;
    expect(lastCheck.value!.session).toBe(s);
    expect(lastCheck.value!.revision).toBe(s.revision.peek());
    expect(lastCheck.value!.result.lines.some((l) => l.line)).toBe(true);
    ws.close();
    // reopened from the local copy, an edit made while the check runs shows it as out of date
    const back = workspace();
    await back.open({ hostOrigin: host, brief: changedBrief(), state: null });
    const b = back.session!;
    edit(back, 'meanwhile', 1);
    await back.backgroundCheck;
    expect(lastCheck.value!.session).toBe(b);
    expect(lastCheck.value!.revision).toBeLessThan(b.revision.peek());
    // Update shots: the worker's issues at once, the full check (lines of every shot) after
    await back.updateFromBrief();
    await back.backgroundCheck;
    expect(lastCheck.value!.revision).toBe(b.revision.peek());
    const lined = new Set(lastCheck.value!.result.lines.filter((l) => l.line).map((l) => l.shot));
    expect(getShots(b.doc).every((x) => lined.has(x.id))).toBe(true);
  }, 30_000);

  it("asks for its full checks in the background, behind the person's requests to the worker", async () => {
    const ws = workspace();
    const check = vi.spyOn(ws.staging, 'check');
    await ws.open({ hostOrigin: origin(), brief: EXAMPLE(), state: null });
    await ws.backgroundCheck;
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(expect.any(Uint8Array), { background: true });
  });

  it('shows the checks of an update as out of date when the scene changed while the worker ran', async () => {
    const host = origin();
    await stateOf(host);
    const ws = workspace();
    await ws.open({ hostOrigin: host, brief: changedBrief(), state: null });
    await ws.backgroundCheck;
    const s = ws.session!;
    // an edit lands while the worker updates the scene
    const update = ws.staging.update.bind(ws.staging);
    vi.spyOn(ws.staging, 'update').mockImplementation(async (u, b) => {
      const r = await update(u, b);
      edit(ws, 'meanwhile', 1);
      return r;
    });
    await ws.updateFromBrief();
    // the worker's checks are of the scene without that edit: stamped as older than the scene
    expect(lastCheck.value!.session).toBe(s);
    expect(lastCheck.value!.revision).toBeLessThan(s.revision.peek());
    // the full check that follows is of the scene as it is
    await ws.backgroundCheck;
    expect(lastCheck.value!.revision).toBe(s.revision.peek());
  }, 30_000);

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
    expect(ws.lengthMismatches().map((m) => [m.shotId, m.deskFrames, m.briefFrames])).toEqual([
      [SHOT_B, 60, 84],
    ]);
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
    edit(ws, 'x', 1);
    expect(edits).toBe(1);
    stop();
    edit(ws, 'x', 2);
    expect(edits).toBe(1);
  });

  it('is described in docs/embedding.md as it behaves', () => {
    const doc = readFileSync(resolve(__dirname, '../../../docs/embedding.md'), 'utf8').replace(/\s+/g, ' ');
    expect(doc).toContain(`does not answer within ${STORAGE_TIMEOUT_MS / 1000} s`);
    expect(doc).toContain(`named \`${SCENE_LOCK_PREFIX}\` followed by the scene's local id`);
    expect(doc).toContain(`"${OTHER_DESK_WAIT}"`);
    // the reading of an unreadable state: the local copy, else the brief; no first state
    expect(doc).toContain('opens its local copy of the scene where it has one (`source` `local`');
    expect(doc).toContain('**No first `state` after a state the desk does not read.**');
  });
});

/** Timers the test moves on by hand (the controller's state schedule). */
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

/** The real controller over a real workspace: what it sends (`runExport`: a fake export, available). */
async function controllerWith(
  ws: DeskWorkspace,
  o: { hostOrigin?: string; runExport?: ControllerDeps['runExport'] } = {},
) {
  const sent: DeskMessage[] = [];
  const timers = handTimers();
  const c = new DeskController({
    send: (m) => {
      sent.push(m);
      return true;
    },
    workspace: ws,
    exportSupport: () =>
      Promise.resolve(
        o.runExport ? { available: true, reason: null } : { available: false, reason: 'not in this test' },
      ),
    runExport: o.runExport,
    deskVersion: 'test',
    timers,
    log: () => {},
  });
  await c.connected(o.hostOrigin ?? 'https://host.example');
  return { c, sent, timers, ofType: (t: DeskMessage['type']) => sent.filter((m) => m.type === t) };
}

/** An export that hands back every shot asked, in the order asked, with no files. */
const echoExport = () =>
  vi.fn(async (req: DeskExportRequest): Promise<DeskExportOutcome> => ({
    shots: req.shots.map((m) => ({
      shotId: m.shotId,
      frames: m.frames,
      durationSec: m.durationSec,
      references: {},
      still: null,
      camera: m.camera,
      line: m.line,
      moves: m.moves,
      planAgrees: m.planAgrees,
      issues: m.issues,
    })),
    files: [],
    failures: [],
    release: async () => {},
  }));

describe('the desk workspace with the controller', () => {
  it('sends no state on its own after one it could not read, until an edit', async () => {
    const ws = workspace();
    const encode = vi.spyOn(ws, 'encodeState');
    const { c, timers, ofType } = await controllerWith(ws);
    c.message({
      type: 'open',
      scene: EXAMPLE(),
      state: { format: '3d-editor.desk-state', version: 1, data: new Uint8Array([1, 2, 3]).buffer },
    });
    await vi.waitFor(() => expect(ofType('opened')).toHaveLength(1));
    expect(ofType('error')).toMatchObject([{ code: 'state_unreadable' }]);
    // no state is even written (a first state would be, right after opened)
    expect(encode).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(ofType('state')).toHaveLength(0);
    expect(encode).not.toHaveBeenCalled();
    // an edit sends one (after the quiet time)
    edit(ws, 'x', 1);
    timers.advance(5000);
    await vi.waitFor(() => expect(ofType('state')).toHaveLength(1));
    c.dispose();
  });

  it('stops waiting for another desk when Close cancels the open, so a later open is not held up', async () => {
    // another desk of this browser has the scene open (same host origin as the controller's)
    const first = workspace();
    await first.open({ hostOrigin: 'https://host.example', brief: EXAMPLE(), state: null });
    const work: (WorkProgress | null)[] = [];
    const ws = workspace({}, (w) => work.push(w));
    const { c, ofType } = await controllerWith(ws);
    c.message({ type: 'open', scene: EXAMPLE(), state: null });
    await vi.waitFor(() => expect(work.some((w) => w?.label === OTHER_DESK_WAIT)).toBe(true));
    await c.close();
    // the host opens another scene: it opens now, while the first desk still holds its own
    c.message({ type: 'open', scene: { ...EXAMPLE(), id: 'clp_fedcba9876543210' }, state: null });
    await vi.waitFor(() => expect(ofType('opened')).toHaveLength(1), { timeout: 10_000 });
    expect(ofType('opened')[0]).toMatchObject({ sceneId: 'clp_fedcba9876543210' });
    expect(ofType('error')).toEqual([]);
    expect(first.session).not.toBeNull();
    c.dispose();
  }, 20_000);

  it('ends an open that Close cancelled while the state unpacked, though another desk has the scene', async () => {
    const host = origin();
    const first = workspace();
    await first.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    const state = await stateOf(origin());
    const unpacking = holdUnpacking();
    const ws = workspace();
    const { c, sent, ofType } = await controllerWith(ws, { hostOrigin: host });
    c.message({ type: 'open', scene: EXAMPLE(), state });
    await unpacking.started;
    await c.close();
    unpacking.go();
    vi.unstubAllGlobals();
    // the host opens another scene: it opens now, while the first desk keeps its own
    c.message({ type: 'open', scene: { ...EXAMPLE(), id: 'clp_fedcba9876543211' }, state: null });
    await vi.waitFor(() => expect(ofType('opened')).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(ofType('state')).toHaveLength(1));
    expect(sent.map((m) => m.type)).toEqual(['ready', 'close', 'opened', 'state']);
    expect(ofType('opened')[0]).toMatchObject({ sceneId: 'clp_fedcba9876543211' });
    expect(first.session).not.toBeNull();
    c.dispose();
  }, 20_000);

  it('stops the staging worker when Close cancels the open while it stages; a later open stages the scene anew', async () => {
    // the first staging worker never answers (a long brief); the workers made after it answer
    const workers: { posted: string[]; terminate: ReturnType<typeof vi.fn> }[] = [];
    const factory: StagingWorkerFactory = () => {
      const first = workers.length === 0;
      const w = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null as ((e: ErrorEvent) => void) | null,
        posted: [] as string[],
        terminate: vi.fn(),
        postMessage(m: { id: number; request: StagingRequest }) {
          w.posted.push(m.request.kind);
          if (!first)
            setTimeout(() =>
              w.onmessage?.({ data: { id: m.id, reply: runStaging(m.request) } } as MessageEvent),
            );
        },
      };
      workers.push(w);
      return w;
    };
    const work: (WorkProgress | null)[] = [];
    const ws = new DeskWorkspace(new StagingClient(factory), (w) => work.push(w), { locks });
    open.push(ws);
    const { c, sent, ofType } = await controllerWith(ws, { hostOrigin: origin() });
    c.message({ type: 'open', scene: EXAMPLE(), state: null });
    await vi.waitFor(() => expect(workers[0]?.posted).toEqual(['stage']));
    await c.close();
    // the staging stops at once, its worker with it, and the work it showed is over
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(work.at(-1)).toBeNull());
    // the host opens the scene again: staged anew, nothing of the cancelled staging was kept
    c.message({ type: 'open', scene: EXAMPLE(), state: null });
    await vi.waitFor(() => expect(ofType('state')).toHaveLength(1), { timeout: 10_000 });
    expect(sent.map((m) => m.type)).toEqual(['ready', 'close', 'opened', 'state']);
    expect(ofType('opened')[0]).toMatchObject({ source: 'brief' });
    expect(workers[1].posted[0]).toBe('stage');
    c.dispose();
  }, 20_000);

  it("sends the host's own bytes as the first state when it opened from them unchanged", async () => {
    const given = await stateOf(origin());
    const original = bytes(given).slice();
    const ws = workspace();
    const { c, ofType } = await controllerWith(ws);
    c.message({ type: 'open', scene: EXAMPLE(), state: given });
    await vi.waitFor(() => expect(ofType('state')).toHaveLength(1));
    const first = ofType('state')[0] as Extract<DeskMessage, { type: 'state' }>;
    expect(same(new Uint8Array(first.state.data), original)).toBe(true);
    c.dispose();
  });

  it("exports in the open's brief order after the host reordered its shots, before and after Update shots", async () => {
    const host = origin();
    // staged here as A, B
    const first = workspace();
    await first.open({ hostOrigin: host, brief: EXAMPLE(), state: null });
    first.close();
    // the host's brief now has B first
    const reordered = EXAMPLE();
    const [a, b] = reordered.shots;
    reordered.shots = [
      { ...b, index: 0 },
      { ...a, index: 1 },
    ];
    const runExport = echoExport();
    const ws = workspace();
    const { c, ofType } = await controllerWith(ws, { hostOrigin: host, runExport });
    c.message({ type: 'open', scene: reordered, state: null });
    await vi.waitFor(() => expect(ofType('opened')).toHaveLength(1));
    expect(ofType('opened')[0]).toMatchObject({ source: 'local' });
    const resultShots = (i: number) =>
      (ofType('result')[i] as Extract<DeskMessage, { type: 'result' }>).shots.map((s) => s.shotId);
    c.message({ type: 'export', id: 'r-1', still: false });
    await vi.waitFor(() => expect(ofType('result')).toHaveLength(1), { timeout: 10_000 });
    expect(runExport.mock.calls[0][0].shots.map((m) => m.shotId)).toEqual([SHOT_B, SHOT_A]);
    expect(resultShots(0)).toEqual([SHOT_B, SHOT_A]);
    // Update shots brings the staging to the brief: still the brief's order
    await c.updateShots();
    c.message({ type: 'export', id: 'r-2', still: false });
    await vi.waitFor(() => expect(ofType('result')).toHaveLength(2), { timeout: 10_000 });
    expect(resultShots(1)).toEqual([SHOT_B, SHOT_A]);
    expect(ofType('error')).toEqual([]);
    c.dispose();
  }, 30_000);

  it('tells the person when storage failed and the scene is in memory only', async () => {
    vi.spyOn(localIndex, 'put').mockRejectedValue(
      new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    );
    const ws = workspace();
    const { c } = await controllerWith(ws);
    c.message({ type: 'open', scene: EXAMPLE(), state: null });
    await vi.waitFor(() => expect(c.status.value).toBe('open'));
    expect(c.notice.value?.message).toMatch(/memory only/);
    c.dispose();
  });
});
