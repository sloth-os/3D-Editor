import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setDeskSettings, type SceneDoc } from '@3d-editor/core';
import { ToolError } from '../../src/mcp/agent';
import { sharedProcessError } from '../../src/render/pool';
import { clearFfmpegChecks } from '../../src/video/ffmpeg';
import { MAX_PROCESS_DEATHS } from '../../src/video/exporter';
import { VideoExports, type ExportJob } from '../../src/video';
import { JobStore, cleanupSelection, safeName } from '../../src/video/jobs';
import { videoExportParamsSchema } from '../../src/video/params';
import type { ServiceContext } from '../../src/services';
import { makeFakeFfmpeg, type FakeFfmpeg } from '../helpers/video-fake-ffmpeg';
import {
  exportScene,
  fakeContext,
  killedError,
  makeFakeRenderer,
  type FakeRenderer,
} from '../helpers/video-fake-renderer';

/*
 * Video export jobs: the cleanup policy, job.json on disk, what a restart does with the jobs it
 * finds, the queue (first come first served, QUEUE_FULL), the error codes, cancel and shutdown —
 * against a fake renderer and a fake ffmpeg (a Node script writing placeholder files).
 */

let fake: FakeFfmpeg;

beforeAll(async () => {
  fake = await makeFakeFfmpeg();
});

afterEach(() => {
  delete process.env.FAKE_FFMPEG_FAIL;
  delete process.env.FAKE_FFMPEG_DELAY_MS;
  delete process.env.FAKE_FFMPEG_HEAD;
  clearFfmpegChecks();
});

const params = (p: Record<string, unknown> = {}) =>
  videoExportParamsSchema.parse({ width: 32, height: 18, ...p });

const tmp = (name: string) => mkdtemp(path.join(tmpdir(), `video-jobs-${name}-`));

/** A machine with 1 TB available: these tests do not depend on the memory of the one they run on. */
const plentyMemory = () => ({ available: 2 ** 40, source: 'meminfo' as const });

/** Reads a ToolError's code from a rejected promise. */
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ToolError);
  return (err as ToolError).code;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settled = (j: ExportJob) => ['done', 'failed', 'cancelled'].includes(j.status);

/** Waits until `p` no longer exists (a job leaves the list before its folder is deleted). */
const removed = (p: string) =>
  until(
    () =>
      stat(p).then(
        () => false,
        () => true,
      ),
    (gone) => gone,
  );

function service(o: {
  dir: string;
  renderer?: FakeRenderer;
  projects?: Record<string, SceneDoc>;
  ffmpegPath?: string;
  exportMaxQueued?: number;
  exportTtlMs?: number;
  exportMaxBytes?: number;
}): { exports: VideoExports; ctx: ServiceContext; renderer: FakeRenderer } {
  const renderer = o.renderer ?? makeFakeRenderer();
  const ctx = fakeContext({
    exportDir: o.dir,
    ffmpegPath: o.ffmpegPath ?? fake.path,
    renderer: renderer.renderer,
    projects: o.projects,
    exportMaxQueued: o.exportMaxQueued,
    exportTtlMs: o.exportTtlMs,
    exportMaxBytes: o.exportMaxBytes,
  });
  // memory is plenty (the leasing by available memory has its own tests: video-memory.test.ts)
  return { exports: new VideoExports(ctx, { memory: plentyMemory }), ctx, renderer };
}

describe('cleanup policy', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const h = 3_600_000;
  const job = (id: string, status: ExportJob['status'], hoursAgo: number | null, bytes: number) => ({
    id,
    status,
    finished_at: hoursAgo === null ? null : new Date(now - hoursAgo * h).toISOString(),
    bytes,
  });

  it('deletes finished jobs past the TTL, then the oldest while over the size limit', () => {
    const jobs = [
      job('old', 'done', 30, 10),
      job('failed-old', 'failed', 25, 1),
      job('mid', 'done', 10, 50),
      job('new', 'cancelled', 1, 50),
      job('running', 'running', null, 500),
      job('queued', 'queued', null, 5),
    ];
    expect(cleanupSelection(jobs, { now, ttlMs: 24 * h, maxBytes: 10_000, totalBytes: 616 })).toEqual([
      'old',
      'failed-old',
    ]);
    // over the size limit: the oldest finished next, never running or queued ones
    expect(cleanupSelection(jobs, { now, ttlMs: 24 * h, maxBytes: 560, totalBytes: 616 })).toEqual([
      'old',
      'failed-old',
      'mid',
    ]);
    expect(cleanupSelection(jobs, { now, ttlMs: 24 * h, maxBytes: 0, totalBytes: 616 })).toEqual([
      'old',
      'failed-old',
      'mid',
      'new',
    ]);
    expect(cleanupSelection(jobs, { now, ttlMs: 100 * h, maxBytes: 10_000, totalBytes: 616 })).toEqual([]);
  });

  it('accepts only safe folder names', () => {
    expect(safeName('abcDEF123')).toBe(true);
    expect(safeName('my-project_1.v2')).toBe(true);
    for (const bad of ['', '.', '..', '../x', 'a/b', '.hidden', 'a b', 'x'.repeat(200)])
      expect(safeName(bad)).toBe(false);
  });
});

describe('job store', () => {
  it('writes job.json atomically and reads back only well-formed jobs', async () => {
    const dir = await tmp('store');
    const warnings: unknown[] = [];
    const store = new JobStore(dir, { debug() {}, info() {}, error() {}, warn: (o) => warnings.push(o) });
    const job = {
      id: 'job1',
      project: 'p1',
      status: 'done',
      created_at: '2026-11-13T10:00:00.000Z',
    } as unknown as ExportJob;
    await store.save(job);
    expect(JSON.parse(await readFile(path.join(dir, 'p1', 'job1', 'job.json'), 'utf8'))).toMatchObject({
      id: 'job1',
    });
    expect((await readdir(path.join(dir, 'p1', 'job1'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // broken, foreign and mismatched entries are skipped
    await mkdir(path.join(dir, 'p1', 'broken'), { recursive: true });
    await writeFile(path.join(dir, 'p1', 'broken', 'job.json'), '{not json');
    await mkdir(path.join(dir, 'p1', 'other'), { recursive: true });
    await writeFile(path.join(dir, 'p1', 'other', 'job.json'), JSON.stringify({ ...job, id: 'job1' }));
    await writeFile(path.join(dir, 'stray.txt'), 'x');
    await mkdir(path.join(dir, '.trash', 'x'), { recursive: true });
    const all = await store.loadAll();
    expect(all.map((j) => j.id)).toEqual(['job1']);
    expect(warnings).toHaveLength(1);
    await store.remove(job);
    expect(await store.loadAll()).toEqual([]);
  });

  // file system bound (two writes and a read per round): give a busy machine time
  it(
    'keeps job.json whole when saves of a job overlap, the last one asked for written last',
    { timeout: 30_000 },
    async () => {
      const dir = await tmp('store-race');
      const store = new JobStore(dir, silentLogLike());
      const job = (status: string, frames: number, files = 0) =>
        ({
          id: 'job1',
          project: 'p1',
          status,
          created_at: '2026-11-13T10:00:00.000Z',
          progress: { frames_done: frames },
          files: Array.from({ length: files }, (_, i) => ({ name: `f${i}.mp4`, sha256: 'a'.repeat(64) })),
        }) as unknown as ExportJob;
      const file = path.join(dir, 'p1', 'job1', 'job.json');
      let rejected = 0;
      for (let i = 0; i < 40; i++) {
        // progress saves of different lengths in flight while the job ends (as onProgress and finish do)
        const saves = [store.save(job('running', i)), store.save(job('running', i + 1, 50))];
        saves.push(store.save(job('done', i + 2, i % 7)));
        rejected += (await Promise.allSettled(saves)).filter((r) => r.status === 'rejected').length;
        const read = JSON.parse(await readFile(file, 'utf8')) as ExportJob;
        expect(read.status).toBe('done');
        expect(read.progress.frames_done).toBe(i + 2);
      }
      expect(rejected).toBe(0);
      expect((await readdir(path.join(dir, 'p1', 'job1'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      // a save in progress does not write the folder back once the job is deleted
      void store.save(job('running', 1));
      await store.remove(job('running', 1));
      expect(await stat(path.join(dir, 'p1', 'job1')).catch(() => null)).toBeNull();
    },
  );
});

function silentLogLike() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// every export spawns fake ffmpeg processes (Node scripts): slow on a busy machine
describe('VideoExports', { timeout: 30_000 }, () => {
  it('runs an export to its files with the fake ffmpeg (clips, posters, contact sheet, passes, manifest)', async () => {
    const dir = await tmp('run');
    const { doc, cams, shotIds } = exportScene({ shots: 2, frames: 12 });
    const { exports, renderer } = service({ dir, projects: { p1: doc } });
    const queued = await exports.start(
      'p1',
      params({ passes: ['beauty', 'depth', 'mask'], quality: 'draft' }),
    );
    // nothing else waits: it starts at once
    expect(queued).toMatchObject({
      project: 'p1',
      status: 'running',
      progress: { frames_total: 24, frames_done: 0 },
    });
    expect(queued.progress.eta_s).toBeGreaterThan(0);
    const job = await until(() => exports.status(queued.id, { waitS: 5 }), settled);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.progress).toMatchObject({ frames_done: 24, frames_total: 24, fraction: 1 });
    const names = job.files.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        'contact-sheet.png',
        'manifest.json',
        'sequence.depth.mp4',
        'sequence.mask.mkv',
        'sequence.mask.mp4',
        'sequence.mp4',
        'shot-01-wide.depth.mp4',
        'shot-01-wide.jpg',
        'shot-01-wide.mask.mp4',
        'shot-01-wide.mp4',
        'shot-01-wide.png',
        'shot-02-shot-2.depth.mp4',
        'shot-02-shot-2.jpg',
        'shot-02-shot-2.mask.mp4',
        'shot-02-shot-2.mp4',
        'shot-02-shot-2.png',
      ].sort(),
    );
    const clip = job.files.find((f) => f.name === 'shot-02-shot-2.mp4')!;
    expect(clip).toMatchObject({
      kind: 'clip',
      pass: 'beauty',
      shot: shotIds[1],
      frames: 12,
      duration_s: 0.5,
    });
    expect(clip.url).toBe(`/api/projects/p1/video-exports/${job.id}/files/shot-02-shot-2.mp4`);
    expect(clip.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(job.files.find((f) => f.name === 'sequence.mask.mkv')).toMatchObject({
      kind: 'pass',
      pass: 'mask',
      frames: 24,
    });
    expect(job.files.find((f) => f.name === 'sequence.mp4')).toMatchObject({
      kind: 'sequence',
      frames: 24,
      duration_s: 1,
    });
    // what was rendered: every frame once, each shot with its camera, from the snapshot
    expect(renderer.stats.images.map((i) => i.frame)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(new Set(renderer.stats.images.slice(0, 12).map((i) => i.camera))).toEqual(new Set([cams[0]]));
    expect(new Set(renderer.stats.images.slice(12).map((i) => i.camera))).toEqual(new Set([cams[1]]));
    expect(renderer.stats.docs).toHaveLength(1);
    expect(renderer.stats.docs[0].key).not.toContain(doc.ydoc.guid);
    expect(renderer.stats.leases).toBe(renderer.stats.releases);
    // the sequence got every frame's bytes: 24 RGBA frames of 32×18
    const dirOf = path.join(dir, 'p1', job.id);
    expect(await readFile(path.join(dirOf, 'sequence.mp4'), 'utf8')).toBe(
      `fake sequence.mp4 ${24 * 32 * 18 * 4}\n`,
    );
    expect(await readFile(path.join(dirOf, 'sequence.mask.mkv'), 'utf8')).toBe(
      `fake sequence.mask.mkv ${24 * 32 * 18 * 3}\n`,
    );
    // ffmpeg: keyframes at the shot starts; clips cut from them by stream copy, frame-exact
    const calls = await fake.calls();
    const encode = calls.find((a) => a.at(-1)?.endsWith(`${job.id}/sequence.mp4`) && a.includes('pipe:0'))!;
    expect(encode[encode.indexOf('-force_key_frames') + 1]).toBe('expr:eq(n,0)+eq(n,12)');
    const cut = calls.find((a) => a.at(-1)?.endsWith(`${job.id}/shot-02-shot-2.mp4`))!;
    expect(cut[cut.indexOf('-ss') + 1]).toBe((12.5 / 24).toFixed(6));
    expect(cut[cut.indexOf('-frames:v') + 1]).toBe('12');
    expect(cut[cut.indexOf('-c') + 1]).toBe('copy');
    // no clip is cut from the lossless stream
    expect(calls.some((a) => a.at(-1)?.endsWith('.mask.mkv') && a.includes('copy'))).toBe(false);
    // the snapshot is gone once the job ended; job.json stays
    expect(await stat(path.join(dirOf, 'snapshot.ybin')).catch(() => null)).toBeNull();
    const manifest = JSON.parse(await readFile(path.join(dirOf, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      version: 2,
      frames: 24,
      width: 32,
      height: 18,
      passes: ['beauty', 'depth', 'mask'],
    });
    expect(manifest.shots).toHaveLength(2);
    expect(manifest.shots[1]).toMatchObject({ timecode_in: '00:00:00:12', timecode_out: '00:00:01:00' });
    expect(manifest.shots[0].camera_track).toHaveLength(12);
    expect(manifest.files.map((f: { name: string }) => f.name)).not.toContain('manifest.json');
    expect(manifest.mask_palette.length).toBeGreaterThan(0);
    await exports.close();
  });

  it('pads shots by holding the last frame and takes a new lease every 200 frames', async () => {
    const dir = await tmp('segments');
    const { doc } = exportScene({ shots: 1, frames: 450 });
    setDeskSettings(doc, { min_shot_s: 20 });
    const { exports, renderer } = service({ dir, projects: { p1: doc } });
    const q = await exports.start(
      'p1',
      params({
        width: 16,
        height: 16,
        match_model_duration: true,
        outputs: { posters: false, contact_sheet: false },
      }),
    );
    expect(q.warnings[0]).toMatch(/^duration_clamped: shot 'Wide' \(18\.75 s\) was padded to 20\.00 s/);
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('done');
    // 450 rendered in leases of at most 200 frames, 480 written
    expect(renderer.stats.images).toHaveLength(450);
    expect(renderer.stats.leaseFrames).toEqual([200, 200, 50]);
    expect(renderer.stats.releases).toBe(3);
    expect(job.files.find((f) => f.kind === 'clip')).toMatchObject({ frames: 480, duration_s: 20 });
    expect(await readFile(path.join(dir, 'p1', job.id, 'sequence.mp4'), 'utf8')).toBe(
      `fake sequence.mp4 ${480 * 16 * 16 * 4}\n`,
    );
    await exports.close();
  });

  it('fails a job whose ffmpeg fails and deletes its partial files', async () => {
    const dir = await tmp('fail');
    const { doc } = exportScene();
    const { exports } = service({ dir, projects: { p1: doc } });
    process.env.FAKE_FFMPEG_FAIL = 'sequence.mp4';
    const q = await exports.start('p1', params());
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/ffmpeg exited with code 1/);
    expect(job.files).toEqual([]);
    expect(await readdir(path.join(dir, 'p1', job.id))).toEqual(['job.json']);
    await exports.close();
  });

  it('fails a job whose frame cannot be rendered', async () => {
    const dir = await tmp('render-fail');
    const { doc } = exportScene();
    const renderer = makeFakeRenderer();
    renderer.failFrame = { frame: 5, error: new Error('evaluation failed: bad modifier') };
    const { exports } = service({ dir, renderer, projects: { p1: doc } });
    const q = await exports.start('p1', params());
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job).toMatchObject({ status: 'failed', error: 'evaluation failed: bad modifier' });
    expect(renderer.stats.leases).toBe(renderer.stats.releases);
    await exports.close();
  });

  it('exports the snapshot taken when asked, whatever happens to the project afterwards', async () => {
    const dir = await tmp('snapshot');
    const { doc } = exportScene();
    const renderer = makeFakeRenderer();
    renderer.delayMs = 30;
    const { exports } = service({ dir, renderer, projects: { p1: doc } });
    const first = await exports.start('p1', params());
    const second = await exports.start('p1', params({ label: 'after' }));
    const names = doc
      .listObjects()
      .map((o) => o.name)
      .sort();
    // edit the live project while the first export runs and the second waits
    doc.transact(() => {
      for (const o of doc.listObjects()) if (o.type === 'MESH') doc.removeObject(o.id);
      doc.addObject({ type: 'EMPTY', name: 'Added later' });
    });
    for (const id of [first.id, second.id])
      expect((await until(() => exports.status(id, { waitS: 5 }), settled)).status).toBe('done');
    expect(renderer.stats.docs).toHaveLength(2);
    for (const d of renderer.stats.docs) expect(d.names).toEqual(names);
    await exports.close();
  });

  it('refuses with FFMPEG_UNAVAILABLE, UNAVAILABLE, QUEUE_FULL, NOT_FOUND and INVALID_PARAMS', async () => {
    const dir = await tmp('codes');
    const { doc } = exportScene();
    const missing = service({ dir, projects: { p1: doc }, ffmpegPath: path.join(dir, 'no-ffmpeg') });
    const err = await missing.exports.start('p1', params()).catch((e: Error) => e);
    expect((err as ToolError).code).toBe('FFMPEG_UNAVAILABLE');
    expect((err as Error).message).toMatch(/Install ffmpeg/);
    await missing.exports.close();

    const main = service({ dir, projects: { p1: doc }, renderer: makeFakeRenderer({ mode: 'main-thread' }) });
    const mainErr = await main.exports.start('p1', params()).catch((e: Error) => e);
    expect((mainErr as ToolError).code).toBe('UNAVAILABLE');
    expect((mainErr as Error).message).toMatch(/RENDER_WORKERS/);
    await main.exports.close();

    const renderer = makeFakeRenderer();
    renderer.delayMs = 100;
    const { exports } = service({ dir, renderer, projects: { p1: doc }, exportMaxQueued: 1 });
    expect(await codeOf(exports.start('nope', params()))).toBe('NOT_FOUND');
    expect(await codeOf(exports.start('p1', params({ shots: ['No such shot'] })))).toBe('NOT_FOUND');
    expect(await codeOf(exports.start('p1', { ...params(), width: 33 } as never))).toBe('INVALID_PARAMS');
    // by name of a loaded project
    const running = await exports.start('Demo', params());
    expect(running.project).toBe('p1');
    await until(
      () => exports.status(running.id),
      (j) => j.status === 'running',
    );
    const waiting = await exports.start('p1', params());
    expect(await codeOf(exports.start('p1', params()))).toBe('QUEUE_FULL');
    await expect(exports.start('p1', params())).rejects.toThrow(
      /^1 video export is already waiting \(EXPORT_MAX_QUEUED is 1\): wait for one to finish/,
    );
    // a request that can never succeed is told so, whatever the queue holds
    expect(await codeOf(exports.start('nope', params()))).toBe('NOT_FOUND');
    expect(await codeOf(exports.start('p1', params({ shots: ['No such shot'] })))).toBe('NOT_FOUND');
    expect(await codeOf(exports.start('p1', params({ camera: 'Nope', frame_start: 1 })))).toBe('NOT_FOUND');
    expect(await codeOf(exports.start('p1', params({ frame_start: 9, frame_end: 3 })))).toBe(
      'INVALID_PARAMS',
    );
    expect(await codeOf(exports.status('missing'))).toBe('NOT_FOUND');
    expect(await codeOf(exports.status(running.id, { project: 'other' }))).toBe('NOT_FOUND');
    expect(await codeOf(exports.file(running.id, 'sequence.mp4'))).toBe('NOT_FOUND');
    // cancel a queued job: no files, its folder kept with job.json
    const c = await exports.cancel(waiting.id);
    expect(c.status).toBe('cancelled');
    const listed = await exports.list('p1');
    expect(listed.map((j) => j.id)).toEqual([waiting.id, running.id]);
    expect(await exports.list('other')).toEqual([]);
    // cancel the running one and delete it with its files
    const stopped = await exports.cancel(running.id, { deleteFiles: true });
    expect(stopped.status).toBe('cancelled');
    expect(await stat(path.join(dir, 'p1', running.id)).catch(() => null)).toBeNull();
    expect(await codeOf(exports.status(running.id))).toBe('NOT_FOUND');
    expect(renderer.stats.leases).toBe(renderer.stats.releases);
    await exports.close();
  });

  it('answers UNAVAILABLE without configuration', async () => {
    const bare = new VideoExports({} as ServiceContext);
    const err = await bare.list().catch((e: Error) => e);
    expect((err as ToolError).code).toBe('UNAVAILABLE');
    expect((err as Error).message).toBe('Video export is not available yet on this server.');
  });

  it('cancels a running export: ffmpeg stopped, partial files deleted', async () => {
    const dir = await tmp('cancel');
    const { doc } = exportScene({ shots: 1, frames: 400 });
    const renderer = makeFakeRenderer();
    renderer.delayMs = 5;
    const { exports } = service({ dir, renderer, projects: { p1: doc } });
    const q = await exports.start('p1', params());
    await until(
      () => exports.status(q.id),
      (j) => j.progress.frames_done > 10,
    );
    const t0 = Date.now();
    const c = await exports.cancel(q.id);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(c.status).toBe('cancelled');
    expect(c.files).toEqual([]);
    expect(await readdir(path.join(dir, 'p1', q.id))).toEqual(['job.json']);
    // waiting on a finished job answers at once
    const t1 = Date.now();
    expect((await exports.status(q.id, { waitS: 30 })).status).toBe('cancelled');
    expect(Date.now() - t1).toBeLessThan(1000);
    expect(renderer.stats.leases).toBe(renderer.stats.releases);
    await exports.close();
  });

  it('fails the running job on shutdown and keeps queued ones for the next start', async () => {
    const dir = await tmp('shutdown');
    const { doc } = exportScene({ shots: 1, frames: 400 });
    const renderer = makeFakeRenderer();
    renderer.delayMs = 5;
    const first = service({ dir, renderer, projects: { p1: doc } });
    const running = await first.exports.start('p1', params());
    const queued = await first.exports.start('p1', params({ shots: 'all', label: 'second' }));
    await until(
      () => first.exports.status(running.id),
      (j) => j.progress.frames_done > 0,
    );
    await first.exports.close();
    const after = JSON.parse(
      await readFile(path.join(dir, 'p1', running.id, 'job.json'), 'utf8'),
    ) as ExportJob;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/server shut down while the export ran/);
    expect(await stat(path.join(dir, 'p1', queued.id, 'snapshot.ybin'))).toBeTruthy();
    expect(await first.exports.start('p1', params()).catch((e: ToolError) => e.code)).toBe('UNAVAILABLE');

    // the next start resumes the queued job
    renderer.delayMs = 0;
    const second = service({ dir, renderer, projects: { p1: doc } });
    const resumed = await until(() => second.exports.status(queued.id, { waitS: 5 }), settled);
    expect(resumed.status).toBe('done');
    expect(resumed.label).toBe('second');
    await second.exports.close();
  });

  it('at startup: fails jobs that were running, resumes queued ones, drops expired ones', async () => {
    const dir = await tmp('restart');
    const { doc } = exportScene();
    const base = {
      project: 'p1',
      label: null,
      params: params(),
      started_at: null,
      finished_at: null,
      progress: { frames_done: 0, frames_total: 24, fraction: 0, fps: 0, eta_s: null, shot: null },
      error: null,
      warnings: [],
      files: [],
    };
    const write = async (
      id: string,
      job: Record<string, unknown>,
      extra: Record<string, Uint8Array | string> = {},
    ) => {
      const d = path.join(dir, 'p1', id);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, 'job.json'), JSON.stringify({ ...base, id, ...job }));
      for (const [name, data] of Object.entries(extra)) await writeFile(path.join(d, name), data);
    };
    const snapshot = Y.encodeStateAsUpdate(doc.ydoc);
    await write(
      'wasRunning',
      { status: 'encoding', created_at: '2026-11-13T09:00:00.000Z', started_at: '2026-11-13T09:00:01.000Z' },
      {
        'sequence.mp4': 'partial',
        'snapshot.ybin': snapshot,
      },
    );
    await write(
      'wasQueued',
      { status: 'queued', created_at: '2026-11-13T09:01:00.000Z' },
      { 'snapshot.ybin': snapshot },
    );
    await write('lostSnapshot', { status: 'queued', created_at: '2026-11-13T09:02:00.000Z' });
    await write(
      'expired',
      {
        status: 'done',
        created_at: '2020-01-01T00:00:00.000Z',
        finished_at: '2020-01-01T00:01:00.000Z',
      },
      { 'sequence.mp4': 'old' },
    );
    await write('recent', {
      status: 'done',
      created_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    const { exports } = service({ dir, projects: { p1: doc } });
    const running = await exports.status('wasRunning');
    expect(running).toMatchObject({ status: 'failed', files: [] });
    expect(running.error).toMatch(/server restarted/);
    expect((await readdir(path.join(dir, 'p1', 'wasRunning'))).sort()).toEqual(['job.json']);
    const lost = await exports.status('lostSnapshot');
    expect(lost.status).toBe('failed');
    expect(lost.error).toMatch(/snapshot .* was lost/);
    const resumed = await until(() => exports.status('wasQueued', { waitS: 5 }), settled);
    expect(resumed.status).toBe('done');
    await until(
      () => exports.list('p1'),
      (l) => !l.some((j) => j.id === 'expired'),
    );
    await removed(path.join(dir, 'p1', 'expired'));
    expect((await exports.list('p1')).map((j) => j.id)).toContain('recent');
    await exports.close();
  });

  it('deletes the oldest finished exports when all of them pass EXPORT_MAX_MB', async () => {
    const dir = await tmp('size');
    const { doc } = exportScene({ shots: 1, frames: 4 });
    const { exports } = service({ dir, projects: { p1: doc }, exportMaxBytes: 1 });
    const a = await exports.start('p1', params({ outputs: { posters: false, contact_sheet: false } }));
    // finished, then deleted as the total passes the limit
    await until(
      () => exports.list('p1'),
      (l) => !l.some((j) => j.id === a.id),
    );
    await removed(path.join(dir, 'p1', a.id));
    await exports.close();
  });

  it('keeps EXPORT_MAX_QUEUED when exports are asked for at the same time', async () => {
    const dir = await tmp('queue-race');
    const { doc } = exportScene({ shots: 1, frames: 400 });
    const renderer = makeFakeRenderer();
    renderer.delayMs = 5;
    const { exports } = service({ dir, renderer, projects: { p1: doc }, exportMaxQueued: 1 });
    // nothing runs: two at once are both taken (one runs, one waits)
    const both = await Promise.allSettled([exports.start('p1', params()), exports.start('p1', params())]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // one runs and one waits: five more at once are all refused
    const more = await Promise.allSettled(Array.from({ length: 5 }, () => exports.start('p1', params())));
    expect(more.map((r) => (r.status === 'rejected' ? (r.reason as ToolError).code : 'ok'))).toEqual(
      Array(5).fill('QUEUE_FULL'),
    );
    const listed = await exports.list('p1');
    expect(listed.filter((j) => j.status === 'queued')).toHaveLength(1);
    // no folder was left behind by the refused ones
    expect((await readdir(path.join(dir, 'p1'))).sort()).toEqual(listed.map((j) => j.id).sort());
    for (const j of listed) await exports.cancel(j.id, { deleteFiles: true });
    await exports.close();
  });

  it('shows the beauty image in posters and contact sheet whatever the order of the passes', async () => {
    const dir = await tmp('posters');
    const { doc } = exportScene({ shots: 1, frames: 4 });
    const { exports, renderer } = service({ dir, projects: { p1: doc } });
    process.env.FAKE_FFMPEG_HEAD = '1';
    const q = await exports.start('p1', params({ passes: ['depth', 'mask', 'beauty'] }));
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('done');
    // the fake beauty image of scene frame 1 is all ones (RGBA); depth would be grey 128, alpha 255
    const poster = await readFile(path.join(dir, 'p1', job.id, 'shot-01-wide.png'), 'utf8');
    expect(poster).toMatch(/ head=0101010101010101\n$/);
    const tile = renderer.stats.contactTiles[0];
    expect([...tile.data.subarray(0, 4)]).toEqual([1, 1, 1, 1]);
    // without beauty: the first pass listed
    const d = await exports.start('p1', params({ passes: ['depth', 'mask'] }));
    const depthOnly = await until(() => exports.status(d.id, { waitS: 5 }), settled);
    expect(await readFile(path.join(dir, 'p1', depthOnly.id, 'shot-01-wide.png'), 'utf8')).toMatch(
      / head=808080ff808080ff\n$/,
    );
    await exports.close();
  });

  it('lists the files of a frame range export under its manifest entry', async () => {
    const dir = await tmp('range');
    const { doc } = exportScene({ shots: 1, frames: 6 });
    const { exports } = service({ dir, projects: { p1: doc } });
    const q = await exports.start(
      'p1',
      params({ frame_start: 2, frame_end: 4, passes: ['beauty', 'depth'] }),
    );
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('done');
    for (const name of ['range.mp4', 'range.depth.mp4', 'range.png', 'range.jpg'])
      expect(job.files.find((f) => f.name === name)).toMatchObject({ shot: 'range' });
    const manifest = JSON.parse(await readFile(path.join(dir, 'p1', job.id, 'manifest.json'), 'utf8'));
    expect(manifest.shots).toHaveLength(1);
    expect(manifest.shots[0]).toMatchObject({
      id: 'range',
      files: { beauty: 'range.mp4', depth: 'range.depth.mp4', poster: 'range.png', poster_jpeg: 'range.jpg' },
    });
    await exports.close();
  });
});

describe('render processes that die during an export', { timeout: 30_000 }, () => {
  /** Runs an export of 2 shots × 12 frames with `renderer` and waits for its end. */
  async function exportWith(renderer: FakeRenderer, p: Record<string, unknown> = {}) {
    const dir = await tmp('deaths');
    const { doc } = exportScene({ shots: 2, frames: 12 });
    const { exports } = service({ dir, renderer, projects: { p1: doc } });
    const q = await exports.start('p1', params(p));
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    await exports.close();
    return { job, jobDir: path.join(dir, 'p1', job.id) };
  }

  /** Scene frames of the camera track of each shot in the manifest: the order frames were written. */
  async function writtenFrames(jobDir: string): Promise<number[][]> {
    const manifest = JSON.parse(await readFile(path.join(jobDir, 'manifest.json'), 'utf8'));
    return manifest.shots.map((s: { camera_track: { frame: number }[] }) =>
      s.camera_track.map((e) => e.frame),
    );
  }

  const frameIs = (frame: number) => (req: { type: string; options?: unknown }) =>
    req.type === 'image' && (req.options as { frame: number }).frame === frame;

  it('finishes when the only render process dies mid-export (RENDER_WORKERS=1)', async () => {
    const renderer = makeFakeRenderer({ threads: 1 });
    let killed = 0;
    renderer.kill = (req) => frameIs(5)(req) && killed++ === 0;
    const { job, jobDir } = await exportWith(renderer);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(renderer.stats.deaths).toBe(1);
    expect(renderer.stats.replacements).toBe(1);
    // every frame written once, in order: frame 5 rendered again on the new process
    expect(await writtenFrames(jobDir)).toEqual([
      Array.from({ length: 12 }, (_, i) => i + 1),
      Array.from({ length: 12 }, (_, i) => i + 13),
    ]);
    expect(renderer.stats.images.map((i) => i.frame)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      ...Array.from({ length: 12 }, (_, i) => i + 13),
    ]);
    expect(await readFile(path.join(jobDir, 'sequence.mp4'), 'utf8')).toBe(
      `fake sequence.mp4 ${24 * 32 * 18 * 4}\n`,
    );
    expect(
      job.warnings.some((w) =>
        /^A render process stopped during the export \(out of memory: .*in a new render process, so the files are complete$/.test(
          w,
        ),
      ),
    ).toBe(true);
    // the lease that lost its process was given back and a new one taken
    expect(renderer.stats.leases).toBe(renderer.stats.releases);
    expect(renderer.stats.leases).toBe(3);
  });

  it('finishes when every leased process dies at once, and when one of several does', async () => {
    const all = makeFakeRenderer({ threads: 3 });
    const done = new Set<number>();
    // the three processes die on frames 7, 8 and 9 (in flight together)
    all.kill = (req, thread) => {
      const f = req.type === 'image' ? (req.options as { frame: number }).frame : 0;
      if (f < 7 || f > 9 || done.has(f) || thread > 3) return false;
      done.add(f);
      return true;
    };
    const a = await exportWith(all);
    expect(a.job.status).toBe('done');
    expect(all.stats.deaths).toBe(3);
    expect(await writtenFrames(a.jobDir)).toEqual([
      Array.from({ length: 12 }, (_, i) => i + 1),
      Array.from({ length: 12 }, (_, i) => i + 13),
    ]);
    const one = makeFakeRenderer({ threads: 3 });
    let n = 0;
    one.kill = (req) => frameIs(15)(req) && n++ === 0;
    const b = await exportWith(one);
    expect(b.job.status).toBe('done');
    expect((await writtenFrames(b.jobDir))[1]).toEqual(Array.from({ length: 12 }, (_, i) => i + 13));
  });

  it('fails when one frame takes down every render process it is sent to', async () => {
    const renderer = makeFakeRenderer({ threads: 1 });
    renderer.kill = frameIs(5);
    const { job, jobDir } = await exportWith(renderer);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^out of memory: the render process was killed \(SIGKILL\)/);
    // three processes at most, then the export gives up (no endless restarts)
    expect(renderer.stats.deaths).toBe(MAX_PROCESS_DEATHS);
    expect(renderer.stats.leases).toBe(renderer.stats.releases);
    expect(await readdir(jobDir)).toEqual(['job.json']);
  });

  it('measures a shot and encodes the contact sheet again when their render process dies', async () => {
    const renderer = makeFakeRenderer({ threads: 1 });
    let shots = 0;
    let sheets = 0;
    renderer.kill = (req) =>
      (req.type === 'desk-shot' && shots++ === 1) || (req.type === 'encode' && sheets++ === 0);
    const { job, jobDir } = await exportWith(renderer);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(renderer.stats.deaths).toBe(2);
    // two shots measured (the second one twice), one contact sheet encoded (on the second try)
    expect(renderer.stats.deskShots).toBe(2);
    expect(renderer.stats.encodes).toBe(1);
    expect(job.files.map((f) => f.name)).toContain('contact-sheet.png');
    expect(job.warnings.some((w) => /^2 render processes stopped during the export/.test(w))).toBe(true);
    expect((await writtenFrames(jobDir)).flat()).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    // a measurement that always ends its process fails the export
    const always = makeFakeRenderer({ threads: 1 });
    always.kill = (req) => req.type === 'desk-shot';
    const failed = await exportWith(always);
    expect(failed.job.status).toBe('failed');
    expect(always.stats.deaths).toBe(MAX_PROCESS_DEATHS);
  });

  it('does not count against a frame the processes another render ended while the frame waited in them', async () => {
    // another long render shares the processes: its requests end them (out of memory) while a frame,
    // a shot's measurement and the contact sheet of the export wait behind them, more often than
    // MAX_PROCESS_DEATHS — the export's work was not the cause and is done again each time
    const times = MAX_PROCESS_DEATHS + 1;
    const renderer = makeFakeRenderer({ threads: 1 });
    const count = { frame: 0, shot: 0, sheet: 0 };
    const shared = () => sharedProcessError(killedError());
    renderer.kill = (req) => {
      if (frameIs(5)(req) && count.frame++ < times) return shared();
      if (req.type === 'desk-shot' && count.shot++ < times) return shared();
      if (req.type === 'encode' && count.sheet++ < times) return shared();
      return false;
    };
    const { job, jobDir } = await exportWith(renderer);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(renderer.stats.deaths).toBe(3 * times);
    expect((await writtenFrames(jobDir)).flat()).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(job.files.map((f) => f.name)).toContain('contact-sheet.png');
    expect(
      job.warnings.some((w) => w.startsWith(`${3 * times} render processes stopped during the export`)),
    ).toBe(true);
  });
});
