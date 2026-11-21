import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneBrief, ShotResultMeta } from '@3d-editor/core';
import {
  CHANGES_QUIET_MS,
  DeskController,
  EXPORT_STOP_WAIT_MS,
  PROGRESS_INTERVAL_MS,
  READY_CHECK_MS,
  STATE_MIN_INTERVAL_MS,
  STATE_QUIET_MS,
  resolveOptions,
  type ControllerDeps,
  type SceneWorkspace,
} from '../src/embed/controller';
import { DeskExportError, type DeskExportOutcome } from '../src/embed/export';
import { deskMessageProblems, type DeskMessage } from '../src/embed/protocol';
import { StateTooLarge } from '../src/embed/state';
import type { OpenOutcome } from '../src/embed/workspace';

/*
 * The desk's side of the protocol once connected (embed/controller.ts), with a fake scene and a
 * fake export and fake timers: ready within 2 s, one open (opened, then a state), the states after
 * edits (2 s after the last, at most one per 5 s) and none after close, save, export (progress about
 * ten a second with the last of each phase, the result with its files transferred, the shots left
 * out named after it as export_failed, busy, not_open, cancel, a brief over the export's size at
 * once), Send in the Follow menu's mode, the host's ack, Done and Close (a Close while the scene
 * opens cancels the open), the brief's changes coming back when Update shots is undone, and the
 * errors the contract names. Every message sent validates against the protocol's schemas.
 */

const SHOT_A = 'sht_a';
const SHOT_B = 'sht_b';
const brief = {
  id: 'clp_1',
  name: 'Scene',
  fps: 24,
  width: 320,
  height: 180,
  shots: [
    { id: SHOT_A, durationSec: 0.5 },
    { id: SHOT_B, durationSec: 1 },
  ],
} as unknown as SceneBrief;

const metaOf = (shotId: string): ShotResultMeta =>
  ({
    shotId,
    deskShotId: `d-${shotId}`,
    frames: shotId === SHOT_A ? 12 : 24,
    durationSec: 0,
    sceneFrames: shotId === SHOT_A ? 12 : 24,
    sceneFps: 24,
    camera: { lensMm: 35, move: null },
    line: 'line',
    moves: null,
    planAgrees: null,
    issues: [],
  }) as ShotResultMeta;

const outcome: OpenOutcome = {
  source: 'brief',
  changes: null,
  unreadable: null,
  plan: 'stage',
  stageMs: 5,
  persistent: true,
};

function fakeWorkspace(over: Partial<SceneWorkspace> = {}) {
  const edits = new Set<() => void>();
  const ws = {
    open: vi.fn(async () => outcome),
    encodeState: vi.fn(async () => ({
      state: { format: '3d-editor.desk-state' as const, version: 1 as const, data: new ArrayBuffer(16) },
      shots: 2,
    })),
    onEdit: (cb: () => void) => {
      edits.add(cb);
      return () => edits.delete(cb);
    },
    snapshot: () => new Uint8Array([1, 2, 3]),
    stagedShots: () => [SHOT_A, SHOT_B],
    lengthMismatches: () => [],
    changes: () => null,
    updateFromBrief: vi.fn(async () => null),
    results: vi.fn(async (_u: Uint8Array, shots?: string[]) => (shots ?? [SHOT_A, SHOT_B]).map(metaOf)),
    projectId: 'desk-0123',
    ...over,
  };
  return { ws, edit: () => edits.forEach((cb) => cb()) };
}

function setup(
  o: {
    workspace?: Partial<SceneWorkspace>;
    support?: ControllerDeps['exportSupport'];
    runExport?: ControllerDeps['runExport'];
    timers?: ControllerDeps['timers'];
  } = {},
) {
  const sent: { message: DeskMessage; transfer?: Transferable[]; at: number }[] = [];
  const { ws, edit } = fakeWorkspace(o.workspace);
  const c = new DeskController({
    send: (message, transfer) => {
      sent.push({ message, transfer, at: o.timers ? o.timers.now() : Date.now() });
      return true;
    },
    workspace: ws,
    exportSupport: o.support ?? (async () => ({ available: true, reason: null })),
    runExport: o.runExport,
    deskVersion: '1.2.3',
    log: () => {},
    ...(o.timers ? { timers: o.timers } : {}),
  });
  const ofType = (t: DeskMessage['type']) => sent.map((s) => s.message).filter((m) => m.type === t) as any[];
  return { c, ws, edit, sent, ofType };
}

/** An export that returns every shot asked, with one camera clip each. */
const allShots = () =>
  vi.fn(async (req: any): Promise<DeskExportOutcome> => ({
    shots: req.shots.map((m: ShotResultMeta) => ({
      shotId: m.shotId,
      frames: m.frames,
      durationSec: m.frames / 24,
      references: { camera: `${m.shotId}.camera.mp4` },
      still: null,
      camera: m.camera,
      line: m.line,
      moves: null,
      planAgrees: null,
      issues: [],
    })),
    files: req.shots.map((m: ShotResultMeta) => ({
      name: `${m.shotId}.camera.mp4`,
      mime: 'video/mp4',
      data: new ArrayBuffer(4),
    })),
    failures: [],
    release: async () => {},
  }));

const CHANGES = {
  added: [],
  removed: [],
  retimed: [SHOT_B],
  recast: [],
  cast: { added: [], removed: [] },
};

/** vi.waitFor with room for a busy machine (its default gives up after 1 s). */
const waitUntil = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 10_000, interval: 20 });

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/**
 * Timers the test runs by hand: `busy` moves the clock on without running the timers that come due
 * (the page is busy, so they run late: a browser queues a due timer behind the events posted before
 * it), `runDue` then runs them, `advance` does both.
 */
function handTimers(start = 1000) {
  let now = start;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const runDue = () => {
    for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at))
      if (t.at <= now && due.delete(id)) t.fn();
  };
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h: unknown) => void due.delete(h as number),
    busy: (ms: number) => void (now += ms),
    runDue,
    advance(ms: number) {
      now += ms;
      runDue();
    },
  };
}

async function opened(t: ReturnType<typeof setup>, options?: object) {
  await t.c.connected('https://host.example');
  t.c.message({ type: 'open', scene: brief, state: null, ...(options ? { options } : {}) } as never);
  await waitUntil(() => expect(t.ofType('state')).toHaveLength(1));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the desk controller', () => {
  it('answers the connect with ready, and validates what it sends', async () => {
    const t = setup();
    await t.c.connected('https://host.example');
    expect(t.ofType('ready')).toEqual([
      {
        type: 'ready',
        deskVersion: '1.2.3',
        protocol: 1,
        capabilities: {
          export: {
            available: true,
            reason: null,
            container: 'mp4',
            videoCodec: 'avc1',
            modes: ['motion', 'pose', 'camera'],
          },
          offline: true,
          // library units: always announced (docs/embedding.md "Library units"); nothing else of
          // them goes unless an open turns them on
          units: { versions: [1], kinds: ['set', 'prop', 'figure'], maxBytes: 33554432, publish: true },
        },
      },
    ]);
    expect(t.c.status.value).toBe('connected');
    for (const s of t.sent) expect(deskMessageProblems(s.message)).toBeNull();
  });

  it('says why it cannot export, and answers within 2 s when the encoder check is slow', async () => {
    const no = setup({ support: async () => ({ available: false, reason: 'No H.264 encoder here.' }) });
    await no.c.connected('https://h.example');
    expect(no.ofType('ready')[0].capabilities.export).toMatchObject({
      available: false,
      reason: 'No H.264 encoder here.',
    });

    const slow = setup({ support: () => new Promise(() => {}) });
    const ready = slow.c.connected('https://h.example');
    await vi.advanceTimersByTimeAsync(READY_CHECK_MS);
    await ready;
    expect(READY_CHECK_MS).toBeLessThan(2000);
    const r = slow.ofType('ready')[0];
    // happy-dom has no VideoEncoder: not available, with a reason
    expect(r.capabilities.export.available).toBe(false);
    expect(typeof r.capabilities.export.reason).toBe('string');
    expect(deskMessageProblems(r)).toBeNull();
  });

  it('opens once: opened, then a state; a second open is busy', async () => {
    const t = setup();
    await opened(t, { hostName: 'rideo', modes: ['pose', 'camera'], defaultMode: 'pose', readOnly: false });
    expect(t.ws.open).toHaveBeenCalledWith({ hostOrigin: 'https://host.example', brief, state: null });
    const types = t.sent.map((s) => s.message.type);
    expect(types).toEqual(['ready', 'opened', 'state']);
    expect(t.ofType('opened')[0]).toEqual({
      type: 'opened',
      sceneId: 'clp_1',
      source: 'brief',
      changes: null,
    });
    const state = t.sent[2];
    expect(state.message).toMatchObject({ type: 'state', sceneId: 'clp_1', shots: 2 });
    expect(state.message).not.toHaveProperty('id');
    expect(state.transfer).toHaveLength(1);
    expect(t.c.options.value).toEqual({
      hostName: 'rideo',
      modes: ['pose', 'camera'],
      defaultMode: 'pose',
      readOnly: false,
    });
    expect(t.c.mode.value).toBe('pose');
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    expect(t.ofType('error')).toEqual([expect.objectContaining({ code: 'busy' })]);
    expect(t.ofType('error')[0]).not.toHaveProperty('id');
  });

  it('reports a state it did not apply before opened, without an id', async () => {
    const t = setup({
      workspace: {
        open: vi.fn(async () => ({ ...outcome, unreadable: 'the desk state belongs to scene x' })),
      },
    });
    await t.c.connected('https://host.example');
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await waitUntil(() => expect(t.c.status.value).toBe('open'));
    // no state on its own after one it could not read: the host keeps its copy until an edit,
    // Done or save (workspace.ts; desk-workspace.test.ts covers the edit that sends one)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.sent.map((s) => s.message.type)).toEqual(['ready', 'error', 'opened']);
    expect(t.ofType('error')[0]).toMatchObject({ code: 'state_unreadable' });
    expect(t.ofType('error')[0]).not.toHaveProperty('id');
    expect(t.c.notice.value?.level).toBe('warning');
  });

  it('answers an open it cannot stage with invalid_scene and takes another', async () => {
    let fail = true;
    const t = setup({
      workspace: {
        open: vi.fn(async () => {
          if (fail) throw new Error('no shots to stage');
          return outcome;
        }),
      },
    });
    await t.c.connected('https://h.example');
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await waitUntil(() => expect(t.ofType('error')).toHaveLength(1));
    expect(t.ofType('error')[0]).toMatchObject({
      code: 'invalid_scene',
      message: expect.stringContaining('no shots to stage'),
    });
    expect(t.c.status.value).toBe('connected');
    fail = false;
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await waitUntil(() => expect(t.ofType('opened')).toHaveLength(1));
  });

  it('answers requests before the scene is open with not_open', async () => {
    const t = setup();
    await t.c.connected('https://h.example');
    t.c.message({ type: 'export', id: 'e-1' } as never);
    t.c.message({ type: 'save', id: 's-1' } as never);
    expect(t.ofType('error').map((e) => [e.id, e.code])).toEqual([
      ['e-1', 'not_open'],
      ['s-1', 'not_open'],
    ]);
  });

  it('sends a state 2 s after the last edit, at most one every 5 s, and in answer to save', async () => {
    const t = setup();
    await opened(t);
    const t0 = Date.now();
    t.edit();
    expect(t.c.dirty.value).toBe(true);
    // the first state went out just now: the next waits for the 5 s spacing
    await vi.advanceTimersByTimeAsync(STATE_QUIET_MS);
    expect(t.ofType('state')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STATE_MIN_INTERVAL_MS);
    expect(t.ofType('state')).toHaveLength(2);
    expect(t.c.dirty.value).toBe(false);
    // edits every second: one state 2 s after they stop, never two within 5 s
    for (let i = 0; i < 8; i++) {
      t.edit();
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(STATE_QUIET_MS + STATE_MIN_INTERVAL_MS);
    const states = t.sent.filter((s) => s.message.type === 'state');
    for (let i = 1; i < states.length; i++)
      expect(states[i].at - states[i - 1].at).toBeGreaterThanOrEqual(STATE_MIN_INTERVAL_MS);
    const last = states.at(-1)!.at;
    expect(last - t0).toBeGreaterThanOrEqual(8000 + STATE_QUIET_MS - 1000);
    // save: a state with its id, now
    t.c.message({ type: 'save', id: 'save-1' } as never);
    await flush();
    expect(t.ofType('state').at(-1)).toMatchObject({ id: 'save-1', sceneId: 'clp_1' });
  });

  it('answers a state too large for the host with out_of_memory', async () => {
    const t = setup({
      workspace: { encodeState: vi.fn(async () => Promise.reject(new StateTooLarge(70 * 1024 * 1024))) },
    });
    await t.c.connected('https://h.example');
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await waitUntil(() => expect(t.ofType('opened')).toHaveLength(1));
    await flush();
    expect(t.ofType('error')[0]).toMatchObject({ code: 'out_of_memory' });
    t.c.message({ type: 'save', id: 'save-2' } as never);
    await flush();
    expect(t.ofType('error')[1]).toMatchObject({ code: 'out_of_memory', id: 'save-2' });
    expect(t.c.dirty.value).toBe(true);
  });

  it('exports: progress about ten a second, the result with its files transferred, the shots left out after it', async () => {
    const release = vi.fn(async () => {});
    let progressCalls = 0;
    const runExport = vi.fn(async (req: any, hooks: any): Promise<DeskExportOutcome> => {
      // 50 progress calls 10 ms apart: about 5 messages
      for (let i = 0; i < 50; i++) {
        hooks.onProgress({ phase: 'render', done: i, total: 36, shotId: SHOT_A });
        progressCalls++;
        await vi.advanceTimersByTimeAsync(10);
      }
      // the files and the end come at once: each phase's last message still goes
      hooks.onProgress({ phase: 'encode', done: 0, total: 1 });
      hooks.onProgress({ phase: 'encode', done: 1, total: 1 });
      hooks.onProgress({ phase: 'finish', done: 0, total: 1 });
      const data = new ArrayBuffer(4);
      return {
        shots: req.shots.slice(0, 1).map((m: ShotResultMeta) => ({
          shotId: m.shotId,
          frames: m.frames,
          durationSec: m.frames / 24,
          references: { camera: `${m.shotId}.camera.mp4` },
          still: null,
          camera: m.camera,
          line: m.line,
          moves: null,
          planAgrees: null,
          issues: [],
        })),
        files: [{ name: `${SHOT_A}.camera.mp4`, mime: 'video/mp4', data }],
        failures: [{ shotId: SHOT_B, code: 'out_of_memory', message: `${SHOT_B}: no memory` }],
        release,
      };
    });
    const t = setup({ runExport });
    await opened(t, { modes: ['camera'] });
    t.c.message({ type: 'export', id: 'exp-1', shots: [SHOT_A, SHOT_B], still: false } as never);
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(1));
    await flush();
    expect(runExport.mock.calls[0][0]).toMatchObject({
      modes: ['camera'],
      still: false,
      hostName: 'the host',
    });
    const progress = t.ofType('progress');
    expect(progressCalls).toBe(50);
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress.length).toBeLessThanOrEqual(10);
    expect(progress.every((p) => p.id === 'exp-1')).toBe(true);
    // the last message of each phase goes, the finish last, before the result
    expect(progress.filter((p) => p.phase === 'render').at(-1)).toMatchObject({ done: 49 });
    expect(progress.filter((p) => p.phase === 'encode').at(-1)).toMatchObject({ done: 1, total: 1 });
    expect(progress.at(-1)).toMatchObject({ phase: 'finish' });
    const types = t.sent.map((s) => s.message.type);
    const iResult = types.indexOf('result');
    expect(types.slice(iResult)).toEqual(['result', 'error']);
    const result = t.sent[iResult];
    expect(result.message).toMatchObject({ id: 'exp-1', sceneId: 'clp_1', fps: 24, width: 320, height: 180 });
    expect(result.transfer).toEqual([(result.message as any).files[0].data]);
    // a shot left out is export_failed whatever the cause; the message says the cause
    expect(t.ofType('error').at(-1)).toEqual({
      type: 'error',
      id: 'exp-1',
      code: 'export_failed',
      message: `${SHOT_B}: no memory`,
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(t.c.exportRun.value).toBeNull();
    for (const s of t.sent) expect(deskMessageProblems(s.message), s.message.type).toBeNull();
  });

  it('runs one export at a time, refuses unknown shots and too large scenes, and cancels', async () => {
    let finish: (() => void) | null = null;
    const runExport = vi.fn(
      (_req: any, hooks: any) =>
        new Promise<DeskExportOutcome>((resolve, reject) => {
          hooks.signal.addEventListener('abort', () =>
            reject(new DeskExportError('cancelled', 'The export was cancelled.')),
          );
          finish = () => resolve({ shots: [], files: [], failures: [], release: async () => {} });
        }),
    );
    const t = setup({ runExport });
    await opened(t);
    t.c.message({ type: 'export', id: 'x-0', shots: ['sht_unknown'] } as never);
    expect(t.ofType('error').at(-1)).toMatchObject({ id: 'x-0', code: 'bad_message' });
    t.c.message({ type: 'export', id: 'x-1' } as never);
    await waitUntil(() => expect(runExport).toHaveBeenCalledTimes(1));
    t.c.message({ type: 'export', id: 'x-2' } as never);
    expect(t.ofType('error').at(-1)).toMatchObject({ id: 'x-2', code: 'busy' });
    expect(await t.c.sendToHost()).toBeNull();
    // a cancel of another export is ignored; of this one ends it with cancelled
    t.c.message({ type: 'cancel', id: 'x-9' } as never);
    expect(t.c.exportRun.value?.id).toBe('x-1');
    t.c.message({ type: 'cancel', id: 'x-1' } as never);
    await waitUntil(() => expect(t.ofType('error').at(-1)).toMatchObject({ id: 'x-1', code: 'cancelled' }));
    expect(t.c.exportRun.value).toBeNull();
    expect(finish).not.toBeNull();

    const big = setup({ runExport });
    await big.c.connected('https://h.example');
    big.c.message({ type: 'open', scene: { ...brief, width: 4096, height: 2304 }, state: null } as never);
    await waitUntil(() => expect(big.ofType('state')).toHaveLength(1));
    big.c.message({ type: 'export', id: 'big-1' } as never);
    await waitUntil(() => expect(big.ofType('error')).toHaveLength(1));
    expect(big.ofType('error')[0]).toMatchObject({
      id: 'big-1',
      code: 'export_unavailable',
      message: expect.stringContaining('3840 pixels wide and 2160 pixels high'),
    });

    const none = setup({ runExport, support: async () => ({ available: false, reason: 'No encoder.' }) });
    await opened(none);
    none.c.message({ type: 'export', id: 'n-1' } as never);
    await waitUntil(() => expect(none.ofType('error')).toHaveLength(1));
    expect(none.ofType('error')[0]).toMatchObject({
      id: 'n-1',
      code: 'export_unavailable',
      message: 'No encoder.',
    });
  });

  it("exports the brief's shots in brief order: one not staged yet is left out and named, one the brief dropped is not exported", async () => {
    const SHOT_C = 'sht_c';
    const SHOT_OLD = 'sht_old';
    const later = {
      ...brief,
      shots: [...brief.shots, { id: SHOT_C, durationSec: 1 }],
    } as unknown as SceneBrief;
    const runExport = vi.fn(async (req: any): Promise<DeskExportOutcome> => ({
      shots: req.shots.map((m: ShotResultMeta) => ({
        shotId: m.shotId,
        frames: m.frames,
        durationSec: m.frames / 24,
        references: { camera: `${m.shotId}.camera.mp4` },
        still: null,
        camera: m.camera,
        line: m.line,
        moves: null,
        planAgrees: null,
        issues: [],
      })),
      files: req.shots.map((m: ShotResultMeta) => ({
        name: `${m.shotId}.camera.mp4`,
        mime: 'video/mp4',
        data: new ArrayBuffer(4),
      })),
      failures: [],
      release: async () => {},
    }));
    // the staging has A and B and a shot the later brief dropped; C is new in the brief
    const t = setup({ runExport, workspace: { stagedShots: () => [SHOT_A, SHOT_B] } });
    await t.c.connected('https://host.example');
    t.c.message({ type: 'open', scene: later, state: null } as never);
    await waitUntil(() => expect(t.ofType('state')).toHaveLength(1));

    t.c.message({ type: 'export', id: 'all-1', still: false } as never);
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(1));
    await flush();
    expect(t.ws.results).toHaveBeenLastCalledWith(expect.any(Uint8Array), [SHOT_A, SHOT_B]);
    expect(t.ofType('result')[0].shots.map((s: { shotId: string }) => s.shotId)).toEqual([SHOT_A, SHOT_B]);
    const types = t.sent.map((s) => s.message.type);
    expect(types.slice(types.indexOf('result'))).toEqual(['result', 'error']);
    expect(t.ofType('error').at(-1)).toMatchObject({
      id: 'all-1',
      code: 'export_failed',
      message: expect.stringContaining(SHOT_C),
    });

    // asked in another order: the result keeps the brief's; an id that is no shot of the brief is refused
    t.c.message({ type: 'export', id: 'two-1', shots: [SHOT_B, SHOT_A] } as never);
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(2));
    expect(t.ws.results).toHaveBeenLastCalledWith(expect.any(Uint8Array), [SHOT_A, SHOT_B]);
    t.c.message({ type: 'export', id: 'old-1', shots: [SHOT_A, SHOT_OLD] } as never);
    expect(t.ofType('error').at(-1)).toMatchObject({
      id: 'old-1',
      code: 'bad_message',
      message: expect.stringContaining(SHOT_OLD),
    });

    // only the new shot asked: nothing to render, the export fails naming it
    t.c.message({ type: 'export', id: 'new-1', shots: [SHOT_C] } as never);
    await waitUntil(() =>
      expect(t.ofType('error').at(-1)).toMatchObject({ id: 'new-1', code: 'export_failed' }),
    );
    expect(t.ofType('error').at(-1).message).toContain(SHOT_C);
    expect(runExport).toHaveBeenCalledTimes(2);
    for (const s of t.sent) expect(deskMessageProblems(s.message), s.message.type).toBeNull();
  });

  it("Send renders the Follow menu's mode (one of the host's), with stills, as desk-<n>", async () => {
    const runExport = allShots();
    const t = setup({ runExport });
    // no defaultMode: the host's first mode is preselected
    await opened(t, { hostName: 'rideo', modes: ['pose', 'motion'] });
    expect(t.c.mode.value).toBe('pose');
    expect(await t.c.sendToHost()).toBe('desk-1');
    expect(runExport.mock.calls[0][0]).toMatchObject({ modes: ['pose'], still: true, hostName: 'rideo' });
    t.c.mode.value = 'motion';
    expect(await t.c.sendToHost()).toBe('desk-2');
    expect(runExport.mock.calls[1][0]).toMatchObject({ modes: ['motion'] });
    // a mode the host does not take: its default
    t.c.mode.value = 'camera';
    await t.c.sendToHost();
    expect(runExport.mock.calls[2][0]).toMatchObject({ modes: ['pose'] });
    expect(t.ofType('result').map((r) => r.id)).toEqual(['desk-1', 'desk-2', 'desk-3']);
    // the host's own export keeps every mode it takes, in its order
    t.c.message({ type: 'export', id: 'h-1' } as never);
    await waitUntil(() => expect(runExport).toHaveBeenCalledTimes(4));
    expect(runExport.mock.calls[3][0]).toMatchObject({ modes: ['pose', 'motion'], still: true });
  });

  it("preselects the host's defaultMode in Follow", async () => {
    const t = setup();
    await opened(t, { modes: ['camera', 'motion', 'pose'], defaultMode: 'motion' });
    expect(t.c.mode.value).toBe('motion');
    expect(t.c.options.value.modes).toEqual(['camera', 'motion', 'pose']);
  });

  it("shows the host's answer to a result", async () => {
    const t = setup();
    await opened(t, { hostName: 'rideo' });
    t.c.message({
      type: 'result-ack',
      id: 'desk-1',
      ok: false,
      shots: [
        { shotId: SHOT_A, ok: true },
        { shotId: SHOT_B, ok: false, error: 'too short' },
      ],
    } as never);
    expect(t.c.ack.value).toMatchObject({
      id: 'desk-1',
      ok: false,
      message: 'rideo refused the result.',
      refused: [{ shotId: SHOT_B, error: 'too short' }],
    });
  });

  it('Done sends a last state, then close done; Close sends close cancel (a state first when edits wait)', async () => {
    const done = setup();
    await opened(done);
    await done.c.done();
    expect(done.sent.map((s) => s.message.type).slice(-2)).toEqual(['state', 'close']);
    expect(done.ofType('close')).toEqual([{ type: 'close', reason: 'done' }]);
    expect(done.c.status.value).toBe('closed');
    done.c.reopen();
    expect(done.c.status.value).toBe('open');

    const close = setup();
    await opened(close);
    await close.c.close();
    expect(close.sent.map((s) => s.message.type)).toEqual(['ready', 'opened', 'state', 'close']);
    expect(close.ofType('close')).toEqual([{ type: 'close', reason: 'cancel' }]);

    const dirty = setup();
    await opened(dirty);
    dirty.edit();
    await dirty.c.close();
    expect(dirty.sent.map((s) => s.message.type).slice(-2)).toEqual(['state', 'close']);
  });

  it('answers save after a Close with no scene opened with not_open, and takes a later open', async () => {
    const t = setup();
    await t.c.connected('https://h.example');
    await t.c.close();
    expect(t.ofType('close')).toEqual([{ type: 'close', reason: 'cancel' }]);
    t.c.message({ type: 'save', id: 's-1' } as never);
    expect(t.ofType('error').at(-1)).toMatchObject({ id: 's-1', code: 'not_open' });
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await waitUntil(() => expect(t.ofType('state')).toHaveLength(1));
    expect(t.ofType('opened')).toHaveLength(1);
    expect(t.c.status.value).toBe('open');
    expect(t.ofType('error').filter((e) => e.code === 'busy')).toEqual([]);
  });

  it('Close while the scene opens cancels the open: close, then nothing; a later open is taken', async () => {
    const gates: ((o: OpenOutcome) => void)[] = [];
    const close = vi.fn();
    const t = setup({
      workspace: {
        open: vi.fn(() => new Promise<OpenOutcome>((r) => gates.push(r))),
        close,
      },
    });
    await t.c.connected('https://h.example');
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await flush();
    expect(t.c.status.value).toBe('opening');
    await t.c.close();
    expect(t.ofType('close')).toEqual([{ type: 'close', reason: 'cancel' }]);
    expect(t.c.status.value).toBe('closed');
    // the host opens again before the cancelled open let go of its scene: it waits for that
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await flush();
    expect(gates).toHaveLength(1);
    gates[0](outcome);
    await waitUntil(() => expect(gates).toHaveLength(2));
    // the cancelled open sent nothing and let go of its scene
    expect(close).toHaveBeenCalledTimes(1);
    expect(t.sent.map((x) => x.message.type)).toEqual(['ready', 'close']);
    gates[1](outcome);
    await waitUntil(() => expect(t.ofType('state')).toHaveLength(1));
    expect(t.sent.map((x) => x.message.type)).toEqual(['ready', 'close', 'opened', 'state']);
    expect(t.c.status.value).toBe('open');
  });

  it('answers save with not_open while an open that Close cancelled still lets go of its scene, with no error shown', async () => {
    const gates: ((o: OpenOutcome) => void)[] = [];
    const close = vi.fn();
    // as the real workspace: there is no scene to write until an open completes
    const encodeState = vi.fn(() => Promise.reject(new Error('no scene is open')));
    const t = setup({
      workspace: { open: vi.fn(() => new Promise<OpenOutcome>((r) => gates.push(r))), close, encodeState },
    });
    await t.c.connected('https://h.example');
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await flush();
    await t.c.close();
    // the cancelled open has not let go of its scene yet
    expect(close).not.toHaveBeenCalled();
    t.c.message({ type: 'save', id: 's-1' } as never);
    t.c.message({ type: 'export', id: 'e-1' } as never);
    await flush();
    const notOpen = { type: 'error', code: 'not_open', message: 'No scene is open yet: send open first.' };
    expect(t.ofType('error')).toEqual([
      { ...notOpen, id: 's-1' },
      { ...notOpen, id: 'e-1' },
    ]);
    expect(encodeState).not.toHaveBeenCalled();
    expect(t.c.notice.value).toBeNull();
    // Back to the desk: there is no scene to go back to, the desk waits for an open
    t.c.reopen();
    expect(t.c.status.value).toBe('connected');
    // the cancelled open lets go of its scene: nothing goes, and save is answered the same
    gates[0](outcome);
    await waitUntil(() => expect(close).toHaveBeenCalledTimes(1));
    t.c.message({ type: 'save', id: 's-2' } as never);
    await flush();
    expect(t.ofType('error').at(-1)).toEqual({ ...notOpen, id: 's-2' });
    expect(t.sent.map((x) => x.message.type)).toEqual(['ready', 'close', 'error', 'error', 'error']);
    expect(t.c.status.value).toBe('connected');
  });

  it('answers requests after Done or Close with not_open saying the desk was closed; save is answered', async () => {
    const t = setup({ runExport: allShots() });
    await opened(t);
    await t.c.done();
    t.c.message({ type: 'export', id: 'e-1' } as never);
    expect(t.ofType('error').at(-1)).toMatchObject({
      id: 'e-1',
      code: 'not_open',
      message: expect.stringContaining('The desk was closed'),
    });
    t.c.message({ type: 'save', id: 's-1' } as never);
    await flush();
    expect(t.ofType('state').at(-1)).toMatchObject({ id: 's-1' });
  });

  it('sends no state after Done or Close; edits made then go once the person is back', async () => {
    const t = setup();
    await opened(t);
    await t.c.done();
    const before = t.sent.length;
    t.edit();
    await vi.advanceTimersByTimeAsync(STATE_QUIET_MS + STATE_MIN_INTERVAL_MS + 1000);
    expect(t.sent.length).toBe(before);
    expect(t.c.dirty.value).toBe(true);
    t.c.reopen();
    await vi.advanceTimersByTimeAsync(STATE_QUIET_MS + STATE_MIN_INTERVAL_MS);
    expect(t.sent.slice(before).map((x) => x.message.type)).toEqual(['state']);
    expect(t.c.dirty.value).toBe(false);
  });

  it("shows the brief's changes again when Update shots is undone", async () => {
    let now: typeof CHANGES | null = CHANGES;
    const t = setup({
      workspace: {
        open: vi.fn(async () => ({ ...outcome, changes: CHANGES })),
        changes: () => now,
        updateFromBrief: vi.fn(async () => {
          now = null;
          return null;
        }),
      },
    });
    await opened(t);
    expect(t.c.changes.value).toEqual(CHANGES);
    await t.c.updateShots();
    expect(t.c.changes.value).toBeNull();
    // Ctrl+Z: the scene is as staged again
    now = CHANGES;
    t.edit();
    await vi.advanceTimersByTimeAsync(CHANGES_QUIET_MS);
    expect(t.c.changes.value).toEqual(CHANGES);
  });

  it('takes an export with shots: [] as every shot, and each repeated mode once', async () => {
    const runExport = allShots();
    const t = setup({ runExport });
    await opened(t, { modes: ['camera'] });
    t.c.message({ type: 'export', id: 'e-1', shots: [], modes: ['pose', 'pose', 'camera', 'pose'] } as never);
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(1));
    expect(t.ws.results).toHaveBeenLastCalledWith(expect.any(Uint8Array), [SHOT_A, SHOT_B]);
    expect(runExport.mock.calls[0][0]).toMatchObject({ modes: ['pose', 'camera'] });
    expect(t.ofType('result')[0].shots).toHaveLength(2);
    // modes: [] asks for the open's
    t.c.message({ type: 'export', id: 'e-2', modes: [] } as never);
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(2));
    expect(runExport.mock.calls[1][0]).toMatchObject({ modes: ['camera'] });
  });

  it('tells the export which shots the brief retimed and whether the open is read-only', async () => {
    const runExport = allShots();
    const t = setup({ runExport, workspace: { changes: () => CHANGES } });
    await opened(t);
    t.c.message({ type: 'export', id: 'e-1' } as never);
    await waitUntil(() => expect(runExport).toHaveBeenCalledTimes(1));
    expect(runExport.mock.calls[0][0]).toMatchObject({ retimed: [SHOT_B], readOnly: false });
    const ro = setup({ runExport: allShots(), workspace: { changes: () => CHANGES } });
    await opened(ro, { readOnly: true });
    ro.c.message({ type: 'export', id: 'e-2' } as never);
    await waitUntil(() => expect(ro.ofType('result')).toHaveLength(1));
    expect((ro.c as any).deps.runExport.mock.calls[0][0]).toMatchObject({
      retimed: [SHOT_B],
      readOnly: true,
    });
  });

  it("answers an export of a brief over the export's size at once, and says so when it opens", async () => {
    // the encoder check of the brief's size never answers: the size is refused before it
    const support = vi.fn((o: { width: number }) =>
      o.width === 1280 ? Promise.resolve({ available: true, reason: null }) : new Promise<never>(() => {}),
    );
    const runExport = allShots();
    const t = setup({ runExport, support });
    await t.c.connected('https://h.example');
    t.c.message({ type: 'open', scene: { ...brief, width: 2160, height: 3840 }, state: null } as never);
    await waitUntil(() => expect(t.ofType('state')).toHaveLength(1));
    expect(t.c.notice.value).toMatchObject({
      level: 'warning',
      message: expect.stringContaining('too high'),
    });
    t.c.message({ type: 'export', id: 'big-1' } as never);
    await flush();
    expect(t.ofType('error')).toEqual([
      expect.objectContaining({
        id: 'big-1',
        code: 'export_unavailable',
        message: expect.stringContaining('2160 × 3840'),
      }),
    ]);
    expect(support).toHaveBeenCalledTimes(1);
    expect(runExport).not.toHaveBeenCalled();
    expect(t.c.exportRun.value).toBeNull();
  });

  it('Done and Close during an export: its cancelled goes first, then the state and close', async () => {
    for (const how of ['done', 'close'] as const) {
      const runExport = vi.fn(
        (_req: any, hooks: any) =>
          new Promise<DeskExportOutcome>((_resolve, reject) => {
            hooks.signal.addEventListener('abort', () =>
              setTimeout(() => reject(new DeskExportError('cancelled', 'The export was cancelled.')), 50),
            );
          }),
      );
      const t = setup({ runExport });
      await opened(t);
      t.edit();
      t.c.message({ type: 'export', id: 'x-1' } as never);
      await waitUntil(() => expect(runExport).toHaveBeenCalledTimes(1));
      const ending = how === 'done' ? t.c.done() : t.c.close();
      await vi.advanceTimersByTimeAsync(60);
      await ending;
      const types = t.sent.map((x) => x.message.type);
      expect(types.slice(-3), how).toEqual(['error', 'state', 'close']);
      expect(t.ofType('error').at(-1)).toMatchObject({ id: 'x-1', code: 'cancelled' });
    }
  });

  it('closes after EXPORT_STOP_WAIT_MS when a cancelled export does not end, and sends no progress after', async () => {
    let hooksOf: any = null;
    const runExport = vi.fn((_req: any, hooks: any) => {
      hooksOf = hooks;
      return new Promise<DeskExportOutcome>(() => {});
    });
    const t = setup({ runExport });
    await opened(t);
    t.c.message({ type: 'export', id: 'x-1' } as never);
    await waitUntil(() => expect(runExport).toHaveBeenCalledTimes(1));
    const closing = t.c.close();
    await vi.advanceTimersByTimeAsync(EXPORT_STOP_WAIT_MS);
    await closing;
    expect(t.c.status.value).toBe('closed');
    const before = t.sent.length;
    hooksOf.onProgress({ phase: 'render', done: 5, total: 36 });
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2);
    expect(t.sent.slice(before).filter((x) => x.message.type === 'progress')).toEqual([]);
  });

  it('answers a state it cannot write with export_failed (out_of_memory when it is too large)', async () => {
    const t = setup({
      workspace: { encodeState: vi.fn(async () => Promise.reject(new Error('quota exceeded'))) },
    });
    await t.c.connected('https://h.example');
    t.c.message({ type: 'open', scene: brief, state: null } as never);
    await waitUntil(() => expect(t.ofType('opened')).toHaveLength(1));
    await flush();
    expect(t.ofType('error')[0]).toMatchObject({
      code: 'export_failed',
      message: 'The desk state could not be written: quota exceeded',
    });
    expect(t.ofType('error')[0]).not.toHaveProperty('id');
    t.c.message({ type: 'save', id: 'save-3' } as never);
    await flush();
    expect(t.ofType('error')[1]).toMatchObject({ code: 'export_failed', id: 'save-3' });
  });

  it('updates the shots to the brief unless read-only', async () => {
    const t = setup({ workspace: { updateFromBrief: vi.fn(async () => null) } });
    await opened(t, { readOnly: true });
    await t.c.updateShots();
    expect(t.ws.updateFromBrief).not.toHaveBeenCalled();
    const rw = setup();
    await opened(rw);
    rw.c.changes.value = {
      added: ['x'],
      removed: [],
      retimed: [],
      recast: [],
      cast: { added: [], removed: [] },
    };
    await rw.c.updateShots();
    expect(rw.ws.updateFromBrief).toHaveBeenCalledTimes(1);
    expect(rw.c.changes.value).toBeNull();
  });

  it("counts the staging's warnings in the open's notice and lists each under it; the host is sent nothing of them", async () => {
    const warned = [
      "Red balloon: keeps 'Ribbon', which is not part of the prop it replaces",
      "Red balloon: 'Ribbon' no longer follows the animation of 'Red kite'",
    ];
    const t = setup({
      workspace: {
        open: vi.fn(async () => ({ ...outcome, notice: 'Kept in memory only.', warnings: warned })),
      },
    });
    await opened(t);
    // after what else the open says, the count, the list under it
    expect(t.c.notice.value).toEqual({
      level: 'warning',
      message: 'Kept in memory only. The staging gave 2 warnings:',
      details: warned,
      at: expect.any(Number),
    });
    expect(t.ofType('opened')[0]).toEqual({
      type: 'opened',
      sceneId: 'clp_1',
      source: 'brief',
      changes: null,
    });
    expect(JSON.stringify(t.sent.map((s) => s.message))).not.toMatch(/Ribbon|warnings/);
    // one warning, nothing else to say
    const one = setup({ workspace: { open: vi.fn(async () => ({ ...outcome, warnings: [warned[0]] })) } });
    await opened(one);
    expect(one.c.notice.value).toMatchObject({
      level: 'warning',
      message: 'The staging gave 1 warning:',
      details: [warned[0]],
    });
    // a staging that warns of nothing: no notice, as before
    const none = setup({ workspace: { open: vi.fn(async () => ({ ...outcome, warnings: [] })) } });
    await opened(none);
    expect(none.c.notice.value).toBeNull();
  });

  it("counts each Update shots' warnings in its notice and lists them; the next update without any says only that the shots were updated", async () => {
    const lists = [["Red balloon: keeps 'Ribbon', which is not part of the prop it replaces"], []];
    const t = setup({ workspace: { warnings: vi.fn(() => lists.shift() ?? []) } });
    await opened(t);
    const sentBefore = t.sent.length;
    await t.c.updateShots();
    expect(t.c.notice.value).toEqual({
      level: 'warning',
      message: 'The shots were updated to the brief (Ctrl+Z undoes it). The update gave 1 warning:',
      details: ["Red balloon: keeps 'Ribbon', which is not part of the prop it replaces"],
      at: expect.any(Number),
    });
    await t.c.updateShots();
    expect(t.c.notice.value).toEqual({
      level: 'info',
      message: 'The shots were updated to the brief (Ctrl+Z undoes it).',
      at: expect.any(Number),
    });
    // nothing of them goes to the host: the updates send what they sent before (no new messages
    // here, the fake scene sends no edits)
    expect(t.sent.slice(sentBefore)).toEqual([]);
  });

  it("sends the contract's lists in opened.changes, null when they are all empty; the banner keeps the desk's own notes", async () => {
    const onlyOther = {
      added: [],
      removed: [],
      retimed: [],
      recast: [],
      cast: { added: [], removed: [] },
      other: ['2 shots renumbered'],
    };
    const t = setup({
      workspace: { open: vi.fn(async () => ({ ...outcome, source: 'local' as const, changes: onlyOther })) },
    });
    await opened(t);
    expect(t.ofType('opened')[0]).toEqual({
      type: 'opened',
      sceneId: 'clp_1',
      source: 'local',
      changes: null,
    });
    // the desk's banner still lists what else differs
    expect(t.c.changes.value).toEqual(onlyOther);

    const both = { ...CHANGES, other: ['the set'] };
    const u = setup({
      workspace: { open: vi.fn(async () => ({ ...outcome, source: 'state' as const, changes: both })) },
    });
    await opened(u);
    const sent = u.ofType('opened')[0].changes;
    expect(sent).toEqual(CHANGES);
    expect(Object.keys(sent)).toEqual(['added', 'removed', 'retimed', 'recast', 'cast']);
    expect(Object.keys(sent.cast)).toEqual(['added', 'removed']);
    expect(u.c.changes.value).toEqual(both);
    for (const s of [...t.sent, ...u.sent]) expect(deskMessageProblems(s.message), s.message.type).toBeNull();
  });

  it('tracks an edit made while the first state is written: it goes to the host on its own, and before Close', async () => {
    let first = true;
    let editNow = () => {};
    const encodeState = vi.fn(async () => {
      // the person edits the scene while its first state is encoded (the desk is open already)
      if (first) {
        first = false;
        editNow();
      }
      return {
        state: { format: '3d-editor.desk-state' as const, version: 1 as const, data: new ArrayBuffer(16) },
        shots: 2,
      };
    });
    const t = setup({ workspace: { encodeState } });
    editNow = t.edit;
    await opened(t);
    expect(t.c.dirty.value).toBe(true);
    // the edit goes as a state of its own (2 s after it, at most one every 5 s)
    await vi.advanceTimersByTimeAsync(STATE_MIN_INTERVAL_MS);
    expect(t.ofType('state')).toHaveLength(2);
    expect(t.c.dirty.value).toBe(false);

    first = true;
    const c = setup({ workspace: { encodeState } });
    editNow = c.edit;
    await opened(c);
    await c.c.close();
    expect(c.sent.map((s) => s.message.type)).toEqual(['ready', 'opened', 'state', 'state', 'close']);
  });

  it('keeps progress messages 100 ms apart when the throttle timer runs late (a busy page)', async () => {
    const clock = handTimers(1000);
    let hooks: any = null;
    let finish: (() => void) | null = null;
    const runExport = vi.fn(
      (req: any, h: any) =>
        new Promise<DeskExportOutcome>((resolve) => {
          hooks = h;
          finish = () =>
            resolve({
              shots: req.shots.map((m: ShotResultMeta) => ({
                shotId: m.shotId,
                frames: m.frames,
                durationSec: m.frames / 24,
                references: {},
                still: null,
                camera: m.camera,
                line: m.line,
                moves: null,
                planAgrees: null,
                issues: [],
              })),
              files: [],
              failures: [],
              release: async () => {},
            });
        }),
    );
    const t = setup({ runExport, timers: clock });
    await opened(t);
    t.c.message({ type: 'export', id: 'p-1', still: false } as never);
    await waitUntil(() => expect(hooks).not.toBeNull());
    const render = (done: number) => hooks.onProgress({ phase: 'render', done, total: 36, shotId: SHOT_A });
    // prepare went at 1000; render 1 waits, its timer due at 1100
    clock.busy(10);
    render(1);
    // the page is busy past 1100: a later message comes before the due timer runs, 120 ms after
    // the last one, and goes at once
    clock.busy(110);
    render(2);
    // one more 1 ms later waits; the late timer runs 1 ms after that: it must not send it now
    clock.busy(1);
    render(3);
    clock.busy(1);
    clock.runDue();
    // it goes 100 ms after render 2
    clock.advance(100);
    // the phase's last message goes when the next phase starts (early: the last of a phase always
    // goes), and the next one 100 ms after it, though a timer was due sooner
    clock.advance(10);
    render(4);
    clock.busy(20);
    hooks.onProgress({ phase: 'encode', done: 0, total: 1 });
    clock.advance(70);
    clock.advance(30);
    finish!();
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(1));
    const progress = t.sent
      .filter((s) => s.message.type === 'progress')
      .map((s) => [(s.message as any).phase, (s.message as any).done, s.at]);
    expect(progress).toEqual([
      ['prepare', 0, 1000],
      ['render', 2, 1120],
      ['render', 3, 1222],
      ['render', 4, 1252],
      ['encode', 0, 1352],
    ]);
  });

  it("reports the shots in the open's brief order when the host reordered them since staging", async () => {
    // the host's brief now has B first; the staging (and the worker's results) still A, then B
    const reordered = { ...brief, shots: [brief.shots[1], brief.shots[0]] } as unknown as SceneBrief;
    const runExport = allShots();
    const t = setup({
      runExport,
      workspace: {
        results: vi.fn(async (_u: Uint8Array, shots?: string[]) =>
          [SHOT_A, SHOT_B].filter((id) => !shots || shots.includes(id)).map(metaOf),
        ),
      },
    });
    await t.c.connected('https://host.example');
    t.c.message({ type: 'open', scene: reordered, state: null } as never);
    await waitUntil(() => expect(t.ofType('state')).toHaveLength(1));
    t.c.message({ type: 'export', id: 'o-1', still: false } as never);
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(1));
    expect(runExport.mock.calls[0][0].shots.map((m: ShotResultMeta) => m.shotId)).toEqual([SHOT_B, SHOT_A]);
    expect(t.ofType('result')[0].shots.map((s: { shotId: string }) => s.shotId)).toEqual([SHOT_B, SHOT_A]);
    // whatever order the host names them in
    t.c.message({ type: 'export', id: 'o-2', shots: [SHOT_A, SHOT_B], still: false } as never);
    await waitUntil(() => expect(t.ofType('result')).toHaveLength(2));
    expect(t.ofType('result')[1].shots.map((s: { shotId: string }) => s.shotId)).toEqual([SHOT_B, SHOT_A]);
  });

  it('takes the contract defaults for options', () => {
    expect(resolveOptions(undefined)).toEqual({
      hostName: 'the host',
      modes: ['camera'],
      defaultMode: 'camera',
      readOnly: false,
    });
    // the host's order, each mode once; a defaultMode not among them: the host's first mode
    expect(resolveOptions({ modes: ['camera', 'motion'], defaultMode: 'pose' })).toEqual({
      hostName: 'the host',
      modes: ['camera', 'motion'],
      defaultMode: 'camera',
      readOnly: false,
    });
    expect(
      resolveOptions({ modes: ['pose', 'pose', 'camera', 'pose'], defaultMode: 'camera' }),
    ).toMatchObject({
      modes: ['pose', 'camera'],
      defaultMode: 'camera',
    });
    expect(resolveOptions({ modes: [] })).toMatchObject({ modes: ['camera'], defaultMode: 'camera' });
    expect(resolveOptions({ hostName: '  rideo ' }).hostName).toBe('rideo');
    expect(PROGRESS_INTERVAL_MS).toBe(100);
  });
});
