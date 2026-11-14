import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneDoc, createEditorState, createOperatorRegistry } from '@3d-editor/core';
import {
  MAX_PREVIS_JOBS,
  RideoBridge,
  interruptedError,
  type PrevisJob,
  type PrevisRequest,
} from '../../src/rideo';
import { PREVIS_DIR, PrevisStore } from '../../src/rideo/previs-store';
import type { PushResult } from '../../src/rideo/push';
import type { ServiceContext } from '../../src/services';
import { RideoMock, kiteFixture } from '../helpers/rideo-mock';

/*
 * Previs jobs kept under DATA_DIR (rideo/previs-store.ts): a job's record (status, export id, push
 * result) is on disk as it changes, so a server started on the same DATA_DIR answers its status; a
 * job that was running when the server stopped reads failed, saying how it was stopped and what to
 * do; the last MAX_PREVIS_JOBS are kept, older finished ones deleted from disk too.
 */

const dirs: string[] = [];
const bridges: RideoBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function dataDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'previs-persist-'));
  dirs.push(d);
  return d;
}

const PUSHED = {
  status: 'done',
  blocking: { written: true, state: 'ready', error: null, differences: [], plan_mismatch: [] },
  shots: [{ shot: 's1', status: 'pushed', resource: 'res_1' }],
  moves: [],
  stale: [],
  warnings: [],
} as unknown as PushResult;

/**
 * A server's bridge on `dir`: rideo is a mock with the kite clip (or, with `rideoHangs`, a rideo
 * that never answers), our project 'prj-ours' a room, exports a fake whose job 'exp1' ends when
 * `exportDone` says so; a status request that waits ends with the request (aborted), answers
 * 'done' then with `doneOnAbort`, or never answers with `pollHangs`.
 */
function server(
  dir: string,
  o: { exportDone?: () => boolean; doneOnAbort?: boolean; pollHangs?: boolean; rideoHangs?: boolean } = {},
) {
  const mock = new RideoMock(null);
  const fx = kiteFixture();
  mock.add(fx.data);
  const registry = createOperatorRegistry();
  const doc = SceneDoc.create({ empty: true });
  const room = { id: 'prj-ours', scene: doc, touch: () => undefined };
  const exportJob = (status: string) => ({ id: 'exp1', status, progress: null, error: null, warnings: [] });
  const exports = {
    start: async () => exportJob('running'),
    status: (_id: string, opts: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        if (o.exportDone?.() ?? true) return resolve(exportJob('done'));
        if (o.pollHangs) return;
        // a long poll that ends with the request
        opts.signal?.addEventListener(
          'abort',
          () => (o.doneOnAbort ? resolve(exportJob('done')) : reject(new Error('aborted'))),
          { once: true },
        );
      }),
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bridge = new RideoBridge({
    config: { rideoUrl: 'http://rideo.local', rideoToken: null, dataDir: dir, ffmpegPath: 'ffmpeg' },
    log,
    fetch: o.rideoHangs
      ? (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          )
      : mock.fetch,
    services: { registry, exports },
    rooms: {
      open: async (id: string) => {
        if (id !== room.id) throw new Error(`no project ${id}`);
        return room;
      },
      listProjects: async () => [],
    },
  } as unknown as ServiceContext);
  bridges.push(bridge);
  const push = vi.spyOn(bridge, 'push').mockImplementation(async () => PUSHED);
  const request: PrevisRequest = { rideo: { project: fx.ids.project, clip: fx.ids.clip }, project: room.id };
  return { bridge, push, request, log, doc, registry, state: createEditorState() };
}

/** Follows a job until `until` holds (each status request waits up to a second for a change). */
async function follow(bridge: RideoBridge, id: string, until: (j: PrevisJob) => boolean): Promise<PrevisJob> {
  let job = await bridge.previsStatus(id);
  for (let i = 0; i < 60 && !until(job); i++) job = await bridge.previsStatus(id, { waitS: 1 });
  return job;
}

const onDisk = async (dir: string, id: string) =>
  JSON.parse(await readFile(path.join(dir, PREVIS_DIR, `${id}.json`), 'utf8')) as PrevisJob;

describe('previs jobs kept in DATA_DIR', { timeout: 60_000 }, () => {
  it('a server started on the same DATA_DIR answers a finished job as it ended', async () => {
    const dir = await dataDir();
    const first = server(dir);
    const started = await first.bridge.startPrevis(first.request);
    const done = await follow(first.bridge, started.id, (j) => j.finished_at !== null);
    expect(done).toMatchObject({ status: 'done', export: 'exp1', error: null });
    expect(done.push).toEqual(PUSHED);
    await first.bridge.close();

    // the record on disk is the job as it ended
    expect(await onDisk(dir, started.id)).toEqual(done);
    const second = server(dir);
    expect(await second.bridge.previsStatus(started.id)).toEqual(done);
    // a status request waits for nothing on a finished job
    const t0 = Date.now();
    await second.bridge.previsStatus(started.id, { waitS: 5 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a job running when the server died reads failed after the restart, with what to do', async () => {
    const dir = await dataDir();
    // the first server never sees its export end, nor shuts down cleanly (a crash)
    const first = server(dir, { exportDone: () => false });
    const started = await first.bridge.startPrevis(first.request);
    const running = await follow(first.bridge, started.id, (j) => j.export !== null);
    expect(running.status).toBe('exporting');
    expect((await onDisk(dir, started.id)).status).toBe('exporting');

    const second = server(dir);
    const after = await second.bridge.previsStatus(started.id);
    expect(after).toMatchObject({
      id: started.id,
      status: 'failed',
      export: 'exp1',
      error: "server restarted while the previs's export exp1 rendered: start the previs again",
    });
    expect(after.finished_at).toEqual(expect.any(String));
    // the restarted server starts new jobs
    expect((await second.bridge.startPrevis(second.request)).status).toBe('importing');
    // saved so: a third start reads the same
    await second.bridge.close();
    expect(await onDisk(dir, started.id)).toEqual(after);
  });

  it('a job is on disk before its id is answered (a server that dies while importing)', async () => {
    const dir = await dataDir();
    const first = server(dir, { rideoHangs: true });
    const started = await first.bridge.startPrevis(first.request);
    expect(started.status).toBe('importing');
    // no wait: the record is written before startPrevis answers
    expect(await onDisk(dir, started.id)).toEqual(started);

    const second = server(dir);
    expect(await second.bridge.previsStatus(started.id)).toMatchObject({
      status: 'failed',
      export: null,
      error: 'server restarted while the previs imported the clip: start the previs again',
    });
  });

  it.each([
    ['answers done as the shutdown ends it', { doneOnAbort: true }],
    ['never answers', { pollHangs: true }],
  ])(
    'a clean shutdown ends a running job failed at once, saved before close() resolves (the export poll %s)',
    async (_how, o) => {
      const dir = await dataDir();
      const first = server(dir, { exportDone: () => false, ...o });
      const started = await first.bridge.startPrevis(first.request);
      const running = await follow(first.bridge, started.id, (j) => j.export !== null);
      await first.bridge.close();
      const message = "server shut down while the previs's export exp1 rendered: start the previs again";
      const atClose = await onDisk(dir, started.id);
      // the job as it was when the server stopped, ended
      expect(atClose).toEqual({
        ...running,
        status: 'failed',
        error: message,
        finished_at: expect.any(String),
      });
      expect(await first.bridge.previsStatus(started.id)).toEqual(atClose);
      // what the job does after the shutdown changes it no more: nothing pushed, saved or logged
      await new Promise((r) => setTimeout(r, 100));
      expect(first.push).not.toHaveBeenCalled();
      expect(await onDisk(dir, started.id)).toEqual(atClose);
      expect(await first.bridge.previsStatus(started.id)).toEqual(atClose);
      expect(first.log.warn).not.toHaveBeenCalledWith(expect.anything(), 'rideo previs failed');
      const second = server(dir);
      expect(await second.bridge.previsStatus(started.id)).toEqual(atClose);
    },
  );

  it('refuses new jobs once the server shuts down', async () => {
    const { bridge, request } = server(await dataDir());
    await bridge.close();
    await expect(bridge.startPrevis(request)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'The server is shutting down: no new previs jobs.',
    });
  });

  it('a job started while the jobs of the earlier run are read back is saved after that read', async () => {
    const dir = await dataDir();
    // the read back (which deletes half-written files) waits for the test's word
    const loadAll = PrevisStore.prototype.loadAll;
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(PrevisStore.prototype, 'loadAll').mockImplementation(async function (this: PrevisStore) {
      await gate;
      return loadAll.call(this);
    });
    const { bridge, request } = server(dir, { rideoHangs: true });
    let answered = false;
    const starting = bridge.startPrevis(request).then((j) => ((answered = true), j));
    await new Promise((r) => setTimeout(r, 100));
    expect(answered).toBe(false);
    await expect(readdir(path.join(dir, PREVIS_DIR))).rejects.toThrow(/ENOENT/);
    release();
    const job = await starting;
    expect(await onDisk(dir, job.id)).toEqual(job);
  });

  it('a job that ended just before the server died keeps its status', async () => {
    const dir = await dataDir();
    await mkdir(path.join(dir, PREVIS_DIR), { recursive: true });
    // done, but the write of its end time never happened
    const ended: PrevisJob = {
      id: 'jobDone1',
      status: 'done',
      created_at: '2026-11-13T10:00:00.000Z',
      finished_at: null,
      rideo: { url: 'http://rideo.local', project: 'prj', clip: 'clp' },
      project: 'p',
      project_name: 'P',
      export: 'exp7',
      import: null,
      export_status: null,
      push: PUSHED,
      error: null,
      warnings: [],
    };
    await writeFile(path.join(dir, PREVIS_DIR, 'jobDone1.json'), JSON.stringify(ended));
    const { bridge } = server(dir);
    const job = await bridge.previsStatus('jobDone1');
    expect(job).toMatchObject({ status: 'done', error: null, push: PUSHED });
    expect(job.finished_at).toEqual(expect.any(String));
  });

  it('a server stopped as soon as it started still ends the jobs the earlier run left running', async () => {
    const dir = await dataDir();
    await mkdir(path.join(dir, PREVIS_DIR), { recursive: true });
    const left: PrevisJob = {
      id: 'jobLeft1',
      status: 'pushing',
      created_at: '2026-11-13T10:00:00.000Z',
      finished_at: null,
      rideo: { url: 'http://rideo.local', project: 'prj', clip: 'clp' },
      project: 'p',
      project_name: 'P',
      export: 'exp7',
      import: null,
      export_status: null,
      push: null,
      error: null,
      warnings: [],
    };
    await writeFile(path.join(dir, PREVIS_DIR, 'jobLeft1.json'), JSON.stringify(left));
    // closed before the read back the bridge starts on its own has run
    await server(dir).bridge.close();
    expect(await onDisk(dir, 'jobLeft1')).toMatchObject({
      status: 'failed',
      error:
        'server restarted while the previs pushed export exp7 to rideo: push it again with rideo_push, or start the previs again',
      finished_at: expect.any(String),
    });
  });

  it('keeps the last MAX_PREVIS_JOBS jobs, deleting older finished ones from disk; skips unreadable files', async () => {
    const dir = await dataDir();
    const jobsDir = path.join(dir, PREVIS_DIR);
    await mkdir(jobsDir, { recursive: true });
    const record = (i: number): PrevisJob => ({
      id: `job${String(i).padStart(4, '0')}`,
      status: 'done',
      created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      finished_at: new Date(Date.UTC(2026, 10, 1, 0, 1, i)).toISOString(),
      rideo: { url: 'http://rideo.local', project: 'prj', clip: 'clp' },
      project: 'p',
      project_name: 'P',
      export: `exp${i}`,
      import: null,
      export_status: null,
      push: null,
      error: null,
      warnings: [],
    });
    for (let i = 0; i < MAX_PREVIS_JOBS + 2; i++)
      await writeFile(path.join(jobsDir, `${record(i).id}.json`), JSON.stringify(record(i)));
    await writeFile(path.join(jobsDir, 'broken.json'), '{"id": "broken", "stat');
    // a record under another job's name, and JSON that is no job
    await writeFile(path.join(jobsDir, 'other.json'), JSON.stringify({ ...record(200), id: 'job0201' }));
    await writeFile(path.join(jobsDir, 'notajob.json'), JSON.stringify({ id: 'notajob' }));
    // a status this server does not know (it would count as running forever)
    await writeFile(
      path.join(jobsDir, 'oddstatus.json'),
      JSON.stringify({ ...record(203), id: 'oddstatus', status: 'cancelled' }),
    );
    await writeFile(path.join(jobsDir, '.job0001.123.4.tmp'), 'half a write');
    const { bridge } = server(dir);
    await expect(bridge.previsStatus('job0000')).rejects.toThrow(
      `Previs job 'job0000' not found (the server keeps the last ${MAX_PREVIS_JOBS} previs jobs)`,
    );
    for (const id of ['broken', 'other', 'job0201', 'notajob', 'oddstatus'])
      await expect(bridge.previsStatus(id)).rejects.toThrow(/not found/);
    expect((await bridge.previsStatus('job0002')).export).toBe('exp2');
    await bridge.close();
    const left = (await readdir(jobsDir)).sort();
    expect(left).not.toContain('job0000.json');
    expect(left).not.toContain('job0001.json');
    expect(left).not.toContain('.job0001.123.4.tmp');
    expect(left.filter((f) => f.startsWith('job'))).toHaveLength(MAX_PREVIS_JOBS);
  });

  it('says what to do by how far the job got', () => {
    expect(interruptedError({ status: 'importing', export: null }, 'restarted')).toBe(
      'server restarted while the previs imported the clip: start the previs again',
    );
    expect(interruptedError({ status: 'exporting', export: null }, 'shut down')).toBe(
      "server shut down while the previs's export rendered: start the previs again",
    );
    expect(interruptedError({ status: 'pushing', export: 'exp9' }, 'restarted')).toBe(
      'server restarted while the previs pushed export exp9 to rideo: push it again with rideo_push, or start the previs again',
    );
  });
});
