import { describe, expect, it, vi } from 'vitest';
import { videoExportParamsSchema, type SceneBrief, type ShotResultMeta } from '@3d-editor/core';
import {
  DeskExportError,
  MODE_PASS,
  exportSizeProblem,
  lengthIssue,
  passesFor,
  runDeskExport,
  shotExportParams,
  shotResultOf,
  type DeskExportProgress,
  type DeskExportRequest,
  type ExportEngine,
} from '../src/embed/export';
import { BrowserExportError } from '../src/export';
import type {
  BrowserExportFile,
  BrowserExportProgress,
  BrowserExportRequest,
  BrowserExportResult,
} from '../src/export/types';
import { deskMessageProblems, type Mode } from '../src/embed/protocol';

/*
 * The desk's export (embed/export.ts) on a fake engine: one engine export per shot, its clips and
 * still renamed to the contract's names (<shotId>.<mode>.mp4, <shotId>.still.png), every clip's
 * frames checked against the shot's, a shot whose export failed left out and named, the whole
 * export failing with the contract's codes, cancelling, progress in the host's shot ids, and the
 * engine's files released.
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

const meta = (shotId: string, deskShotId: string, frames: number): ShotResultMeta =>
  ({
    shotId,
    deskShotId,
    frames,
    durationSec: frames / 24,
    camera: { lensMm: 35, move: null },
    line: 'Mira on the left, facing right.',
    moves: null,
    planAgrees: null,
    issues: [],
  }) as ShotResultMeta;

const SHOTS = [meta(SHOT_A, 'd1', 12), meta(SHOT_B, 'd2', 24)];

function file(over: Partial<BrowserExportFile>, bytes = 8): BrowserExportFile {
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

/** An engine whose export of each desk shot behaves as `of[shot]` says ('ok' when not given). */
function fakeEngine(of: Record<string, Behaviour> = {}) {
  const started: BrowserExportRequest[] = [];
  const released: string[] = [];
  const engine: ExportEngine = {
    async start(req, hooks) {
      started.push(req);
      const p = req.params as { shots: string[]; passes: string[] };
      const shot = p.shots[0];
      const frames = SHOTS.find((s) => s.deskShotId === shot)!.frames;
      const how = of[shot] ?? 'ok';
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
  return { engine, started, released };
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
    const { engine, started, released } = fakeEngine();
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
    // the engine's files stay until the result is sent
    expect(released).toEqual([]);
    await out.release();
    expect(released.sort()).toEqual(['exp-d1', 'exp-d2']);
  });

  it('exports no still when none is asked, and only the modes asked', async () => {
    const { engine } = fakeEngine();
    const out = await runDeskExport(request({ modes: ['motion'], still: false }), {}, engine);
    expect(out.files.map((f) => f.name)).toEqual([`${SHOT_A}.motion.mp4`, `${SHOT_B}.motion.mp4`]);
    expect(out.shots.map((s) => s.still)).toEqual([null, null]);
  });

  it('leaves out a shot whose export failed and names it; the others come back', async () => {
    for (const [how, code] of [
      ['oom', 'out_of_memory'],
      ['unsupported', 'export_unavailable'],
      ['fail', 'export_failed'],
      ['short', 'export_failed'],
      ['nostill', 'export_failed'],
    ] as const) {
      const { engine, released } = fakeEngine({ d1: how });
      const out = await runDeskExport(request(), {}, engine);
      expect(
        out.shots.map((s) => s.shotId),
        how,
      ).toEqual([SHOT_B]);
      expect(out.failures).toEqual([{ shotId: SHOT_A, code, message: expect.stringContaining(SHOT_A) }]);
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

  it('exports at most 3840 × 2160 (either way round)', () => {
    expect(exportSizeProblem(3840, 2160)).toBeNull();
    expect(exportSizeProblem(1280, 720)).toBeNull();
    expect(exportSizeProblem(3842, 2160)).toMatch(/3840 × 2160/);
    expect(exportSizeProblem(4096, 4096)).toMatch(/4096 × 4096/);
    expect(exportSizeProblem(2160, 3840)).not.toBeNull();
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
