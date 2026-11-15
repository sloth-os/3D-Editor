import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import {
  SceneDoc,
  getShots,
  setShots,
  videoExportParamsSchema,
  type SceneBrief,
  type ShotResultMeta,
} from '@3d-editor/core';
import {
  DeskExportError,
  MODE_PASS,
  bytesText,
  estimateResultBytes,
  exportSizeProblem,
  lengthChecks,
  lengthIssue,
  passesFor,
  plannedFrames,
  runDeskExport,
  shotExportParams,
  shotResultOf,
  type DeskExportProgress,
  type DeskExportRequest,
  type ExportEngine,
} from '../src/embed/export';
import { runStaging } from '../src/embed/staging-engine';
import { BrowserExportError } from '../src/export';
import type {
  BrowserExportFile,
  BrowserExportProgress,
  BrowserExportRequest,
  BrowserExportResult,
} from '../src/export/types';
import { deskMessageProblems, type Mode } from '../src/embed/protocol';

/*
 * The desk's export (embed/export.ts) on a fake engine that plans frames as core's planExport does:
 * one engine export per shot, its clips and still renamed to the contract's names
 * (<shotId>.<mode>.mp4, <shotId>.still.png), every clip's frames checked against the frames planned
 * at the brief's rate (a brief at another rate than the scene's too), the brief_length issue and
 * whose change it is, the result's size estimated before rendering, a shot whose export failed left
 * out and named with its cause, the whole export failing with the contract's codes, cancelling,
 * progress in the host's shot ids, each shot's engine files let go once its bytes are in the
 * result; the Send check's lengths on a staged scene, the size limit per axis, and the wake lock's
 * permissions policy.
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

/** A shot's results; staged at `sceneFps` (24) with `frames` scene frames. */
const meta = (shotId: string, deskShotId: string, frames: number, sceneFps = 24): ShotResultMeta =>
  ({
    shotId,
    deskShotId,
    frames,
    durationSec: frames / sceneFps,
    sceneFrames: frames,
    sceneFps,
    camera: { lensMm: 35, move: null },
    line: 'Mira on the left, facing right.',
    moves: null,
    planAgrees: null,
    issues: [],
  }) as ShotResultMeta;

const SHOTS = [meta(SHOT_A, 'd1', 12), meta(SHOT_B, 'd2', 24)];

function fileOf(over: Partial<BrowserExportFile>, bytes = 8): BrowserExportFile {
  return {
    name: 'x',
    kind: 'clip',
    pass: null,
    shot: null,
    mime: 'video/mp4',
    size: bytes,
    sha256: '',
    frames: null,
    duration_s: null,
    blob: async () => new Blob([new Uint8Array(bytes)]),
    ...over,
  };
}

type Behaviour = 'ok' | 'oom' | 'unsupported' | 'fail' | 'short' | 'nostill';

/**
 * An engine whose export of each desk shot behaves as `of[shot]` says ('ok' when not given), with
 * clips of the frames core's planExport plans: the shot's scene frames resampled to the asked rate.
 */
function fakeEngine(of: Record<string, Behaviour> = {}, metas: ShotResultMeta[] = SHOTS) {
  const started: BrowserExportRequest[] = [];
  const released: string[] = [];
  /** Per file read: the shot and the engine exports let go before it. */
  const reads: { shot: string; releasedBefore: string[] }[] = [];
  const engine: ExportEngine = {
    async start(req, hooks) {
      started.push(req);
      const p = req.params as { shots: string[]; passes: string[]; fps: number };
      const shot = p.shots[0];
      const m = metas.find((s) => s.deskShotId === shot)!;
      const frames = Math.max(1, Math.round((m.sceneFrames * p.fps) / m.sceneFps));
      const how = of[shot] ?? 'ok';
      const file = (over: Partial<BrowserExportFile>): BrowserExportFile => {
        const f = fileOf(over);
        return {
          ...f,
          blob: async () => {
            reads.push({ shot, releasedBefore: [...released] });
            return f.blob();
          },
        };
      };
      const progress = (x: BrowserExportProgress) => hooks.onProgress?.(x);
      progress({ phase: 'prepare', done: 0, total: 1 });
      if (how === 'oom') throw new BrowserExportError('no memory for a render worker', 'OUT_OF_MEMORY');
      if (how === 'unsupported') throw new BrowserExportError('no H.264 encoder', 'UNSUPPORTED');
      if (how === 'fail') throw new Error('the worker crashed');
      for (let i = 1; i <= frames; i++) {
        if (hooks.signal?.aborted) throw new BrowserExportError('cancelled', 'CANCELLED');
        progress({ phase: 'render', done: i, total: frames, shot });
      }
      const files = p.passes.map((pass) =>
        file({ name: `shot.${pass}.mp4`, pass, shot, frames: how === 'short' ? frames - 1 : frames }),
      );
      if (req.stills && how !== 'nostill')
        files.push(file({ name: 'shot.still.png', kind: 'still', shot, mime: 'image/png' }));
      files.push(file({ name: 'manifest.json', kind: 'manifest', mime: 'application/json' }));
      return { id: `exp-${shot}`, files, manifest: {}, shots: [], warnings: [] } as BrowserExportResult;
    },
    async release(r) {
      released.push(r.id);
    },
  };
  return { engine, started, released, reads };
}

const request = (over: Partial<DeskExportRequest> = {}): DeskExportRequest => ({
  update: new Uint8Array([1]),
  brief,
  shots: SHOTS,
  modes: ['camera', 'pose'] as Mode[],
  still: true,
  hostName: 'rideo',
  project: { id: 'desk-1', name: 'Scene' },
  ...over,
});

describe('the desk export', () => {
  it('maps modes to passes and asks the engine for the reference preset of one shot', () => {
    expect(MODE_PASS).toEqual({ motion: 'beauty', pose: 'pose', camera: 'depth' });
    expect(passesFor(['camera', 'motion'])).toEqual(['beauty', 'depth']);
    const params = shotExportParams({
      deskShotId: 'd1',
      modes: ['camera', 'pose'],
      width: 320,
      height: 180,
      fps: 24,
    });
    expect(params).toMatchObject({ preset: 'reference', shots: ['d1'], passes: ['pose', 'depth'] });
    // core's schema (the engine's) takes it
    expect(videoExportParamsSchema.safeParse(params).success).toBe(true);
  });

  it('exports each shot, names the files as the contract does and keeps brief order', async () => {
    const { engine, started, released, reads } = fakeEngine();
    const progress: DeskExportProgress[] = [];
    const out = await runDeskExport(request(), { onProgress: (p) => progress.push(p) }, engine);
    expect(started.map((r) => (r.params as { shots: string[] }).shots)).toEqual([['d1'], ['d2']]);
    expect(started.every((r) => r.stills === true)).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.files.map((f) => [f.name, f.mime])).toEqual([
      [`${SHOT_A}.camera.mp4`, 'video/mp4'],
      [`${SHOT_A}.pose.mp4`, 'video/mp4'],
      [`${SHOT_A}.still.png`, 'image/png'],
      [`${SHOT_B}.camera.mp4`, 'video/mp4'],
      [`${SHOT_B}.pose.mp4`, 'video/mp4'],
      [`${SHOT_B}.still.png`, 'image/png'],
    ]);
    expect(out.files.every((f) => f.data instanceof ArrayBuffer && f.data.byteLength === 8)).toBe(true);
    expect(out.shots.map((s) => [s.shotId, s.frames, s.durationSec])).toEqual([
      [SHOT_A, 12, 0.5],
      [SHOT_B, 24, 1],
    ]);
    expect(out.shots[0].references).toEqual({ pose: `${SHOT_A}.pose.mp4`, camera: `${SHOT_A}.camera.mp4` });
    expect(out.shots[0].still).toBe(`${SHOT_A}.still.png`);
    // the result validates as the contract's
    const message = {
      type: 'result' as const,
      id: 'e',
      sceneId: 'clp_1',
      fps: 24,
      width: 320,
      height: 180,
      shots: out.shots,
      files: out.files,
    };
    expect(deskMessageProblems(message)).toBeNull();
    // progress: prepare, then the frames of all shots in the host's ids, the files, finish
    expect(progress[0]).toEqual({ phase: 'prepare', done: 0, total: 2 });
    const render = progress.filter((p) => p.phase === 'render');
    expect(render.every((p) => p.total === 36)).toBe(true);
    expect(render.map((p) => p.done)).toEqual([...render.map((p) => p.done)].sort((a, b) => a - b));
    expect(render.at(-1)).toEqual({ phase: 'render', done: 36, total: 36, shotId: SHOT_B });
    expect(new Set(render.map((p) => p.shotId))).toEqual(new Set([SHOT_A, SHOT_B]));
    expect(progress.filter((p) => p.phase === 'encode').at(-1)).toEqual({
      phase: 'encode',
      done: 6,
      total: 6,
    });
    expect(progress.at(-1)?.phase).toBe('finish');
    // each shot's engine files go as soon as its bytes are in the result: the first shot's before
    // the second shot's are read, both before the result is sent
    expect(released).toEqual(['exp-d1', 'exp-d2']);
    expect(reads.find((r) => r.shot === 'd2')?.releasedBefore).toEqual(['exp-d1']);
    expect(reads.filter((r) => r.shot === 'd1').every((r) => r.releasedBefore.length === 0)).toBe(true);
    await out.release();
    expect(released).toEqual(['exp-d1', 'exp-d2']);
  });

  it('exports no still when none is asked, and only the modes asked', async () => {
    const { engine } = fakeEngine();
    const out = await runDeskExport(request({ modes: ['motion'], still: false }), {}, engine);
    expect(out.files.map((f) => f.name)).toEqual([`${SHOT_A}.motion.mp4`, `${SHOT_B}.motion.mp4`]);
    expect(out.shots.map((s) => s.still)).toEqual([null, null]);
  });

  it('leaves out a shot whose export failed and names it; the others come back', async () => {
    for (const [how, code, cause] of [
      ['oom', 'out_of_memory', 'out of memory'],
      ['unsupported', 'export_unavailable', 'the browser cannot encode it'],
      ['fail', 'export_failed', 'the worker crashed'],
      ['short', 'export_failed', 'not the 12 planned'],
      ['nostill', 'export_failed', 'its still is missing'],
    ] as const) {
      const { engine, released } = fakeEngine({ d1: how });
      const out = await runDeskExport(request(), {}, engine);
      expect(
        out.shots.map((s) => s.shotId),
        how,
      ).toEqual([SHOT_B]);
      // the cause is in the message (the host is told export_failed whatever the cause)
      expect(out.failures).toEqual([{ shotId: SHOT_A, code, message: expect.stringContaining(SHOT_A) }]);
      expect(out.failures[0].message, how).toContain(cause);
      expect(out.files.every((f) => f.name.startsWith(SHOT_B))).toBe(true);
      await out.release();
      // the failed shot's engine files are released as well
      if (how === 'short' || how === 'nostill') expect(released).toContain('exp-d1');
    }
  });

  it('fails as a whole when no shot comes back, with the code of the failures', async () => {
    const cases: [Record<string, Behaviour>, string][] = [
      [{ d1: 'oom', d2: 'oom' }, 'out_of_memory'],
      [{ d1: 'unsupported', d2: 'unsupported' }, 'export_unavailable'],
      [{ d1: 'oom', d2: 'fail' }, 'export_failed'],
    ];
    for (const [of, code] of cases) {
      const { engine } = fakeEngine(of);
      const err = await runDeskExport(request(), {}, engine).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeskExportError);
      expect((err as DeskExportError).code).toBe(code);
      expect((err as Error).message).toContain(SHOT_A);
      expect((err as Error).message).toContain(SHOT_B);
    }
    const { engine } = fakeEngine();
    await expect(runDeskExport(request({ shots: [] }), {}, engine)).rejects.toMatchObject({
      code: 'export_failed',
    });
  });

  it('is cancelled by its signal, and releases what it made', async () => {
    const { engine, released } = fakeEngine();
    const abort = new AbortController();
    const err = await runDeskExport(
      request(),
      {
        signal: abort.signal,
        onProgress: (p) => {
          if (p.phase === 'render' && p.shotId === SHOT_B) abort.abort();
        },
      },
      engine,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeskExportError);
    expect((err as DeskExportError).code).toBe('cancelled');
    expect(released).toEqual(['exp-d1']);
  });

  it('says why a shot of another length than the brief is refused by the host', () => {
    expect(lengthIssue(12, { durationSec: 0.5 }, 24, 'rideo')).toBeNull();
    const issue = lengthIssue(24, { durationSec: 0.5 }, 24, 'rideo');
    expect(issue).toMatchObject({ code: 'brief_length', severity: 'error' });
    expect(issue!.message).toContain('24 frames');
    expect(issue!.message).toContain('12 frames');
    expect(issue!.message).toContain('rideo');
  });

  it('reports a shot of the brief made longer in the desk with that issue', async () => {
    const { engine } = fakeEngine();
    const long = [meta(SHOT_A, 'd1', 12), meta(SHOT_B, 'd2', 24)];
    const b = {
      ...brief,
      shots: [
        { id: SHOT_A, durationSec: 0.5 },
        { id: SHOT_B, durationSec: 0.5 },
      ],
    } as unknown as SceneBrief;
    const out = await runDeskExport(request({ brief: b, shots: long }), {}, engine);
    expect(out.shots[0].issues).toEqual([]);
    expect(out.shots[1].issues.map((i) => i.code)).toEqual(['brief_length']);
  });

  it('turns shot results into the contract shape', () => {
    const r = shotResultOf(meta(SHOT_A, 'd1', 13), { modes: ['pose', 'motion'], still: false, fps: 24 });
    expect(r.durationSec).toBeCloseTo(13 / 24, 12);
    expect(Object.keys(r.references)).toEqual(['motion', 'pose']);
    expect(r.still).toBeNull();
    expect(r).not.toHaveProperty('deskShotId');
  });

  it('exports at most 3840 pixels wide and 2160 high, and says which side is over (portrait too)', () => {
    expect(exportSizeProblem(3840, 2160)).toBeNull();
    expect(exportSizeProblem(1280, 720)).toBeNull();
    expect(exportSizeProblem(1080, 2160)).toBeNull();
    expect(exportSizeProblem(3842, 2160)).toMatch(/3840 pixels wide and 2160 pixels high/);
    expect(exportSizeProblem(3842, 2160)).toMatch(/3842 × 2160, too wide\./);
    expect(exportSizeProblem(4096, 4096)).toMatch(/4096 × 4096, too wide and too high\./);
    // a portrait brief: the height is the limit, whatever the width
    const portrait = exportSizeProblem(2160, 3840);
    expect(portrait).toMatch(/2160 × 3840, too high\./);
    expect(portrait).toMatch(/a portrait scene too: at most 2160 high/);
  });

  it("counts each shot's frames as the engine plans them at the brief's rate (a brief at another rate)", async () => {
    // staged at 24 fps (12 and 24 frames); the brief now says 30 fps with the same durations
    const b30 = { ...brief, fps: 30 } as SceneBrief;
    expect(plannedFrames(SHOTS[0], 30)).toBe(15);
    const { engine, started } = fakeEngine();
    const out = await runDeskExport(request({ brief: b30 }), {}, engine);
    expect(started.every((r) => (r.params as { fps: number }).fps === 30)).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.shots.map((s) => [s.shotId, s.frames, s.durationSec])).toEqual([
      [SHOT_A, 15, 0.5],
      [SHOT_B, 30, 1],
    ]);
    // the brief's frames agree: no brief_length issue
    expect(out.shots.every((s) => s.issues.length === 0)).toBe(true);
  });

  it("says in a brief_length issue whose change it is: the brief's (Update shots) or the desk's", async () => {
    // the brief made shot B 1.5 s at 30 fps (45 frames); the scene has it at 24 frames at 24 fps (30)
    const b = {
      ...brief,
      fps: 30,
      shots: [
        { id: SHOT_A, durationSec: 0.5 },
        { id: SHOT_B, durationSec: 1.5 },
      ],
    } as unknown as SceneBrief;
    const run = async (o: Partial<DeskExportRequest>) => {
      const out = await runDeskExport(request({ brief: b, ...o }), {}, fakeEngine().engine);
      expect(out.shots[0].issues).toEqual([]);
      const issue = out.shots[1].issues.find((i) => i.code === 'brief_length')!;
      expect(issue.message).toContain('30 frames (1 s) in the desk and 45 frames (1.5 s) in the brief');
      return issue.message;
    };
    const byBrief = await run({ retimed: [SHOT_B] });
    expect(byBrief).toMatch(/^The brief changed this shot's length since it was staged/);
    expect(byBrief).toContain('Press Update shots');
    const readOnly = await run({ retimed: [SHOT_B], readOnly: true });
    expect(readOnly).toContain('The scene is read-only here');
    expect(readOnly).not.toContain('Press Update shots');
    const byDesk = await run({});
    expect(byDesk).toMatch(/^The shot is 30 frames/);
    expect(byDesk).toContain('Set its length back, or change the shot');
    expect(byDesk).not.toContain('Update shots');
  });

  it('refuses a result this tab cannot hold before rendering anything (out_of_memory)', async () => {
    const { engine, started } = fakeEngine();
    const r = request();
    const estimate = estimateResultBytes({
      frames: [12, 24],
      modes: 2,
      still: true,
      width: brief.width,
      height: brief.height,
      fps: brief.fps,
    });
    const err = await runDeskExport(r, {}, engine, { budget: estimate - 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeskExportError);
    expect((err as DeskExportError).code).toBe('out_of_memory');
    expect((err as Error).message).toContain(`about ${bytesText(estimate)} of clips and stills`);
    expect((err as Error).message).toContain('Export fewer shots or modes at a time');
    expect(started).toEqual([]);
    // within the budget it renders
    const ok = await runDeskExport(r, {}, engine, { budget: estimate });
    expect(ok.shots).toHaveLength(2);
  });

  it('estimates the result from the bit rate, the frames, the modes and the stills', () => {
    const base = { frames: [72, 60], modes: 1, still: false, width: 1280, height: 720, fps: 24 };
    const one = estimateResultBytes(base);
    expect(estimateResultBytes({ ...base, modes: 3 })).toBeCloseTo(one * 3, -2);
    expect(estimateResultBytes({ ...base, frames: [144, 120] })).toBeGreaterThan(one * 1.9);
    expect(estimateResultBytes({ ...base, still: true })).toBe(one + 2 * 1280 * 720 * 0.5);
    // a 4K export of an hour of shots is far over any tab's budget; a short 720p one is not
    expect(
      estimateResultBytes({ ...base, frames: [86400], width: 3840, height: 2160, modes: 3 }),
    ).toBeGreaterThan(2 * 1024 ** 3);
    expect(one).toBeLessThan(50 * 1024 ** 2);
    expect(bytesText(1536)).toBe('2 KB');
    expect(bytesText(5 * 1024 ** 2)).toBe('5 MB');
    expect(bytesText(1.25 * 1024 ** 3)).toBe('1.3 GB');
  });
});

describe("the Send check's lengths on a staged scene", () => {
  const fixture = (name: string) =>
    JSON.parse(readFileSync(resolve(__dirname, 'fixtures/desk-protocol', name), 'utf8'));
  const EXAMPLE = (): SceneBrief => structuredClone(fixture('open.json').scene);

  /** The example brief staged into an empty document. */
  function staged(): SceneDoc {
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
    return doc;
  }

  it('finds none as staged, and none for a brief at another rate with the same durations', () => {
    const doc = staged();
    expect(lengthChecks(doc, EXAMPLE())).toEqual([]);
    // 24 → 30 fps: the clips are resampled to the brief's rate (72 → 90 frames), as the brief has them
    expect(lengthChecks(doc, { ...EXAMPLE(), fps: 30 })).toEqual([]);
  });

  it('names a shot the brief retimed (Update shots) apart from one made longer in the desk', () => {
    const doc = staged();
    const [a, b] = EXAMPLE().shots.map((s) => s.id);
    // the brief made the second shot 3.5 s (84 frames); the scene has 60
    const later = EXAMPLE();
    later.shots[1].durationSec = 3.5;
    expect(lengthChecks(doc, later)).toEqual([
      { shotId: b, name: getShots(doc)[1].name, frames: 60, briefFrames: 84, byBrief: true },
    ]);
    // the desk made the first shot 12 frames longer: the brief did not change it
    const shots = getShots(doc);
    shots[0] = { ...shots[0], frame_end: shots[0].frame_end + 12 };
    shots[1] = { ...shots[1], frame_start: shots[1].frame_start + 12, frame_end: shots[1].frame_end + 12 };
    setShots(doc, shots);
    expect(lengthChecks(doc, EXAMPLE())).toEqual([
      { shotId: a, name: shots[0].name, frames: 84, briefFrames: 72, byBrief: false },
    ]);
  });
});

describe('a failing progress listener', () => {
  it('does not fail the export', async () => {
    const { engine } = fakeEngine();
    const out = await runDeskExport(
      request(),
      {
        onProgress: vi.fn(() => {
          throw new Error('listener');
        }),
      },
      engine,
    );
    expect(out.shots).toHaveLength(2);
  });
});
