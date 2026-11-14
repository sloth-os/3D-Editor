import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { SceneDoc, newId } from '@3d-editor/core';
import { NotFoundError, ToolError, type ToolErrorCode } from '../mcp/agent';
import type { ServiceContext } from '../services';
import type { PassName } from '../render/protocol';
import { errorMessage } from '../observability/tracing';
import { ffmpegEncoders, requireFfmpeg } from './ffmpeg';
import { exportCodec, exportNeedsOf, mainThreadError, removeOutputs, runExport } from './exporter';
import { contentTypeOf, etagOf } from './files';
import { JobStore, SNAPSHOT_FILE, cleanupSelection, diskUsage, finished, safeName } from './jobs';
import {
  exportMemory,
  outOfMemoryMessage,
  readMachineMemory,
  type ExportMemory,
  type ExportNeeds,
  type ExportRenderInfo,
  type MemoryReader,
} from './memory';
import {
  qualityPreset,
  videoExportParamsSchema,
  type VideoExportInput,
  type VideoExportParams,
} from './params';
import { planExport, type ExportPlan } from './plan';

/*
 * Video export jobs (SPEC §9): background jobs that render the shots of a snapshot of a project in
 * the render processes and encode them with ffmpeg (start → poll). One job renders at a time, the
 * others wait first come first served (at most EXPORT_MAX_QUEUED). The snapshot is taken when the
 * export is asked for and kept on disk until the job ends, so edits made meanwhile never reach it,
 * and a queued job survives a restart; a job that was running when the server stopped is failed
 * ('server restarted'). Finished jobs are deleted after EXPORT_TTL_HOURS and when all exports
 * together pass EXPORT_MAX_MB (oldest first).
 */

export type { VideoExportParams } from './params';
export type { ExportRenderInfo } from './memory';

export type ExportStatus = 'queued' | 'running' | 'encoding' | 'done' | 'failed' | 'cancelled';

export type ExportFileKind = 'sequence' | 'clip' | 'poster' | 'manifest' | 'contact_sheet' | 'pass';

/** A file an export wrote (job.json `files`). */
export interface ExportFile {
  name: string;
  kind: ExportFileKind;
  pass?: PassName;
  /** The shot's id (clips, posters; 'range' for an export of a frame range, the manifest's shot id). */
  shot?: string;
  /** The shot's id in rideo (imported shots). */
  external_shot?: string;
  bytes: number;
  frames?: number;
  duration_s?: number;
  /** Download path (GET /api/projects/:id/video-exports/:export/files/<name>; links carry no token). */
  url: string;
  sha256: string;
}

export interface ExportProgress {
  frames_done: number;
  frames_total: number;
  /** 0–1. */
  fraction: number;
  /** Frames rendered per second (0 before the first frame). */
  fps: number;
  /** Seconds left (null while unknown). */
  eta_s: number | null;
  /** The shot being rendered (id), or null. */
  shot: string | null;
}

/** Results of pushing an export's clips to rideo (rideo_push). */
export interface ExportPush {
  status: 'running' | 'done' | 'failed';
  shots: { rideo_shot: string; resource: string | null; error: string | null }[];
}

/** An export job (persisted as `<EXPORT_DIR>/<project>/<job>/job.json`). */
export interface ExportJob {
  id: string;
  /** Project id. */
  project: string;
  label: string | null;
  status: ExportStatus;
  params: VideoExportParams;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: ExportProgress;
  error: string | null;
  /** The code of a failure that has one (OUT_OF_MEMORY: not even one render process fits in memory). */
  error_code?: ToolErrorCode;
  /**
   * How it renders, set when it starts: render processes used (fewer than RENDER_WORKERS when the
   * available memory is short), the estimated memory of each and of ffmpeg, the memory available.
   */
  render?: ExportRenderInfo;
  warnings: string[];
  files: ExportFile[];
  push?: ExportPush;
}

/** Options of {@link VideoExports} (tests). */
export interface VideoExportsOptions {
  /** Reads the memory available to an export (default: /proc/meminfo, the cgroup, os.freemem()). */
  memory?: MemoryReader;
}

/** A file of an export on disk (served with Range and ETag by the REST route). */
export interface ExportFileRef {
  path: string;
  bytes: number;
  contentType: string;
  etag: string;
}

/** Options of {@link VideoExports.status}. */
export interface ExportStatusOptions {
  /** The project the export must belong to (REST: the route's project). */
  project?: string;
  /** Wait up to this many seconds (0–50) for the job to finish or change (long poll). */
  waitS?: number;
  /** Stops waiting (the request ended); never cancels the job. */
  signal?: AbortSignal;
}

/** Options of {@link VideoExports.cancel}. */
export interface ExportCancelOptions {
  project?: string;
  /** Also delete the files written so far (and the job). */
  deleteFiles?: boolean;
}

/** Most warnings a job keeps. */
const MAX_WARNINGS = 50;
/** How often finished jobs are checked against the TTL and size limit. */
const CLEANUP_INTERVAL_MS = 15 * 60_000;
/** How often job.json is rewritten with the progress while a job renders (at most). */
const PROGRESS_SAVE_MS = 2000;
/** How long cancel and shutdown wait for a running job to stop. */
const STOP_WAIT_MS = 15_000;
/** Seconds one render process takes for a megapixel at one sample before any export measured it. */
const DEFAULT_SECONDS_PER_MEGAPIXEL = 1.2;
const MiB = 1024 * 1024;

interface RunningJob {
  id: string;
  controller: AbortController;
  /** Why it was stopped (null: it was not). */
  reason: 'cancel' | 'shutdown' | 'too-large' | null;
  done: Promise<void>;
}

const nowIso = () => new Date().toISOString();

/** A copy of a job a caller may keep (the record changes while the job runs). */
function copy(job: ExportJob): ExportJob {
  return JSON.parse(JSON.stringify(job)) as ExportJob;
}

/** The video export jobs of the server (FIFO, one renders at a time). */
export class VideoExports {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly queue: string[] = [];
  /** Exports being started (checked against EXPORT_MAX_QUEUED, not in the queue yet). */
  private pendingStarts = 0;
  private running: RunningJob | null = null;
  private store: JobStore | null = null;
  private loading: Promise<void> | null = null;
  private loadError: Error | null = null;
  private closed = false;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** Waiters for a change of each job's status. */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Measured render seconds per megapixel-frame and render process (for estimates). */
  private secondsPerMegapixel = DEFAULT_SECONDS_PER_MEGAPIXEL;

  constructor(
    protected readonly ctx: ServiceContext,
    private readonly opts: VideoExportsOptions = {},
  ) {
    // the jobs of an earlier run are read (and the queue resumed) soon after the server starts;
    // the context's other services are read only when a job runs
    if (ctx?.config) setImmediate(() => void this.load().catch(() => undefined));
  }

  /** Reads the jobs on disk once: marks interrupted ones failed and resumes the queue. */
  private load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const cfg = this.ctx?.config;
      // a service built without configuration (tests of other services) exports nothing
      if (!cfg) throw new ToolError('Video export is not available yet on this server.', 'UNAVAILABLE');
      const store = new JobStore(cfg.exportDir, this.ctx.log);
      this.store = store;
      const all = await store.loadAll();
      all.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      for (const job of all) {
        if (this.jobs.has(job.id)) continue;
        this.jobs.set(job.id, job);
        if (job.status === 'running' || job.status === 'encoding') {
          job.status = 'failed';
          job.error = 'server restarted while the export ran: start it again';
          job.finished_at = nowIso();
          await this.removePartial(job);
          await store.save(job).catch(() => undefined);
          this.ctx.log.warn({ job: job.id, project: job.project }, 'video export failed: server restarted');
        } else if (job.status === 'queued') {
          const snap = path.join(store.dirOf(job), SNAPSHOT_FILE);
          if (
            await stat(snap).then(
              () => true,
              () => false,
            )
          )
            this.queue.push(job.id);
          else {
            job.status = 'failed';
            job.error = 'the project snapshot of the queued export was lost: start it again';
            job.finished_at = nowIso();
            await store.save(job).catch(() => undefined);
          }
        }
      }
      this.sweeper = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
      this.sweeper.unref?.();
      this.updateActive();
      void this.cleanup();
      this.pump();
    })().catch((err: unknown) => {
      this.loadError = err instanceof Error ? err : new Error(String(err));
      this.ctx?.log?.warn(
        { err: errorMessage(err) },
        'video exports unavailable: the export directory cannot be used',
      );
      throw this.loadError;
    });
    return this.loading;
  }

  private async ready(): Promise<JobStore> {
    try {
      await this.load();
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Video export is not available: ${errorMessage(err)}`, 'UNAVAILABLE');
    }
    return this.store!;
  }

  // ---------------------------------------------------------------- public API

  /**
   * Queues an export of project `project` (id, or the name of a loaded project) and returns its
   * job (status `queued`, or `running` when nothing else waits). Refuses with FFMPEG_UNAVAILABLE
   * without ffmpeg, UNAVAILABLE in main-thread render mode, NOT_FOUND / INVALID_PARAMS for unknown
   * projects, shots or cameras (whatever the queue holds), OUT_OF_MEMORY when no export runs and
   * not even one render process of it fits in the memory available now (see `startMemory`), and
   * QUEUE_FULL when EXPORT_MAX_QUEUED jobs already wait (exports asked for at the same time
   * included).
   */
  async start(project: string, given: VideoExportInput): Promise<ExportJob> {
    const store = await this.ready();
    // callers in code (the rideo bridge) get the same validation and defaults as MCP and REST, and
    // a preset sets what export_video's arguments left out (its schema applies no defaults)
    const parsedParams = videoExportParamsSchema.safeParse(given);
    if (!parsedParams.success)
      throw new ToolError(
        `Invalid video export parameters: ${parsedParams.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
        'INVALID_PARAMS',
      );
    const params = parsedParams.data;
    if (this.closed) throw new ToolError('The server is shutting down: no new video exports.', 'UNAVAILABLE');
    const cfg = this.ctx.config;
    const encoders = await requireFfmpeg(cfg.ffmpegPath);
    const renderer = this.ctx.services.renderer;
    if (renderer.pool.mode === 'main-thread') throw mainThreadError();
    const room = await this.openRoom(project);
    if (!safeName(room.id))
      throw new ToolError(`Project id '${room.id}' cannot name a folder`, 'INVALID_PARAMS');
    // From here to the reservation below nothing awaits: the plan is checked on the project as it is
    // now (a request that can never succeed is told so, whatever the queue holds), and the snapshot
    // encoded in the same tick is that very state.
    const plan: ExportPlan = planExport(room.scene, params);
    // the render processes it would get if it started now (the run decides again when it starts)
    const needs = exportNeedsOf(
      room.scene,
      plan,
      params,
      exportCodec(params.codec, encoders),
      renderer.pool.capacity,
    );
    const memory = this.startMemory(needs);
    // (the message quotes what a render process started for it needs: the processes were not
    // asked what they hold, they were counted as holding all they could)
    if (memory.processes < 1 && !this.running)
      throw new ToolError(
        outOfMemoryMessage(exportMemory(needs, { machine: memory.machine }), plan.width, plan.height),
        'OUT_OF_MEMORY',
      );
    // the jobs ahead of this one: running, waiting, and being started by concurrent requests (they
    // count from their check on, so simultaneous requests cannot all pass it); one of them runs
    const ahead = (this.running ? 1 : 0) + this.queue.length + this.pendingStarts;
    if (ahead > cfg.exportMaxQueued) {
      const waiting = ahead - 1;
      throw new ToolError(
        `${waiting} video ${waiting === 1 ? 'export is' : 'exports are'} already waiting (EXPORT_MAX_QUEUED is ${cfg.exportMaxQueued}): wait for one to finish (export_status) or cancel one (cancel_export).`,
        'QUEUE_FULL',
      );
    }
    this.pendingStarts++;
    try {
      return await this.enqueue(
        store,
        room.id,
        params,
        plan,
        Y.encodeStateAsUpdate(room.scene.ydoc),
        Math.max(1, memory.processes),
      );
    } finally {
      this.pendingStarts--;
    }
  }

  /**
   * Writes a new job (its snapshot, then job.json) and queues it; its queue slot is reserved by
   * the caller (`pendingStarts`) until it is in the queue. `processes`: the render processes it
   * is expected to render on (its first estimate).
   */
  private async enqueue(
    store: JobStore,
    projectId: string,
    params: VideoExportParams,
    plan: ExportPlan,
    bytes: Uint8Array,
    processes: number,
  ): Promise<ExportJob> {
    const job: ExportJob = {
      id: newId(),
      project: projectId,
      label: params.label ?? null,
      status: 'queued',
      params,
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      progress: {
        frames_done: 0,
        frames_total: plan.frames,
        fraction: 0,
        fps: 0,
        eta_s: this.estimate(plan, params, processes),
        shot: null,
      },
      error: null,
      warnings: [...plan.warnings].slice(0, MAX_WARNINGS),
      files: [],
    };
    const dir = store.dirOf(job);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, SNAPSHOT_FILE), bytes);
      await store.save(job);
    } catch (err) {
      // no half-written job is left behind (a folder without job.json is never cleaned up)
      await store.remove(job).catch(() => undefined);
      throw err;
    }
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.updateActive();
    this.ctx.log.info({ job: job.id, project: job.project, frames: plan.frames }, 'video export queued');
    this.pump();
    return copy(job);
  }

  /** The job `exportId` (NOT_FOUND when unknown), after waiting up to `waitS` for a change. */
  async status(exportId: string, opts: ExportStatusOptions = {}): Promise<ExportJob> {
    await this.ready();
    const job = this.find(exportId, opts.project);
    const waitS = Math.max(0, Math.min(50, opts.waitS ?? 0));
    if (waitS > 0 && !finished(job.status)) await this.waitChange(job.id, waitS * 1000, opts.signal);
    return copy(this.jobs.get(job.id) ?? job);
  }

  /** Cancels a queued or running job (a finished one stays); returns the job. */
  async cancel(exportId: string, opts: ExportCancelOptions = {}): Promise<ExportJob> {
    await this.ready();
    const job = this.find(exportId, opts.project);
    if (job.status === 'queued') {
      const i = this.queue.indexOf(job.id);
      if (i >= 0) this.queue.splice(i, 1);
      await this.finish(job, 'cancelled', null);
    } else if (this.running?.id === job.id) {
      const run = this.running;
      run.reason = 'cancel';
      run.controller.abort();
      await Promise.race([run.done, new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref?.())]);
    }
    const out = copy(job);
    if (opts.deleteFiles) {
      if (this.running?.id === job.id) {
        // still stopping: deleted once it has
        void this.running.done.then(() => this.forget(job));
      } else await this.forget(job);
    }
    return out;
  }

  /** The jobs of a project (id), newest first, or of every project. */
  async list(project?: string): Promise<ExportJob[]> {
    await this.ready();
    return [...this.jobs.values()]
      .filter((j) => !project || j.project === project)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .map(copy);
  }

  /** A file of an export (NOT_FOUND when the job or file is unknown). */
  async file(exportId: string, name: string, opts: { project?: string } = {}): Promise<ExportFileRef> {
    const store = await this.ready();
    const job = this.find(exportId, opts.project);
    const f = job.files.find((x) => x.name === name);
    if (!f) throw new NotFoundError(`Video export '${exportId}' has no file '${name}'`);
    const full = path.join(store.dirOf(job), f.name);
    const st = await stat(full).catch(() => null);
    if (!st) throw new NotFoundError(`The file '${name}' of video export '${exportId}' was deleted`);
    return { path: full, bytes: st.size, contentType: contentTypeOf(f.name), etag: etagOf(f.sha256) };
  }

  /** Cancels running jobs and stops ffmpeg (server shutdown); queued jobs wait for the next start. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const run = this.running;
    if (run) {
      run.reason = 'shutdown';
      run.controller.abort();
      await Promise.race([run.done, new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref?.())]);
    }
    for (const set of this.waiters.values()) for (const w of set) w();
    this.waiters.clear();
  }

  // ---------------------------------------------------------------- jobs

  private find(id: string, project?: string): ExportJob {
    const job = this.jobs.get(id);
    if (!job || (project !== undefined && job.project !== project))
      throw new NotFoundError(
        `Video export '${id}' not found${project !== undefined ? ` in project '${project}'` : ''} (see list_exports)`,
      );
    return job;
  }

  /** The room of a project id (or of the one loaded project with that name). */
  private async openRoom(project: string) {
    const rooms = this.ctx.rooms;
    const room = await rooms.open(project).catch(() => null);
    if (room) return room;
    const named = rooms.loadedNamed(project);
    if (named.length === 1) return named[0];
    throw new NotFoundError(`Project '${project}' not found`);
  }

  /**
   * The memory decision of an export asked for now, as its run would make it if it started at once
   * (exporter.ts `decideMemory`), but without asking the render processes: each one running (the
   * one kept for interactive renders too) is counted as a render process of the export holding all
   * it could reuse, no base is kept for the contact sheet's, and the ffmpeg encoders of an export
   * that runs now count as freed (they end with it). So it fits at least as many render processes
   * as the run will: an export it refuses, with no export running, would be refused by its run too.
   */
  private startMemory(needs: ExportNeeds): ExportMemory {
    const pool = this.ctx.services.renderer.pool;
    const running = Math.min(needs.capacity, Math.max(0, pool.running || 0));
    const machine = (this.opts.memory ?? readMachineMemory)();
    const ahead = this.running ? this.jobs.get(this.running.id)?.render : undefined;
    const freed = (ahead?.ffmpeg_mb ?? 0) * MiB;
    return exportMemory(needs, {
      warm: Array.from({ length: running }, () => Infinity),
      machine: freed ? { ...machine, available: machine.available + freed } : machine,
    });
  }

  /** The first estimate of an export's duration (seconds), from the speed measured so far. */
  private estimate(plan: ExportPlan, params: VideoExportParams, threads: number): number {
    const preset = qualityPreset(params.quality, plan.width, plan.height);
    const mp = (plan.width * plan.height) / 1e6;
    const sampleCost = preset.msaa ? 1 + 0.25 * (preset.samples - 1) : preset.samples ** 2;
    const passes = 1 + 0.15 * Math.max(0, params.passes.length - 1);
    const perFrame = this.secondsPerMegapixel * mp * sampleCost * passes;
    return Math.round((plan.frames * perFrame) / Math.max(1, threads)) + 2;
  }

  private notify(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const w of set) w();
  }

  private waitChange(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.waiters.get(id)?.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal?.addEventListener('abort', done, { once: true });
      set.add(done);
    });
  }

  private updateActive(): void {
    this.ctx.metrics?.videoExportsActive.set(this.queue.length + (this.running ? 1 : 0));
  }

  /** Ends a job (status, error, finish time), saves it and tells waiters. */
  private async finish(
    job: ExportJob,
    status: 'done' | 'failed' | 'cancelled',
    error: string | null,
    code?: ToolErrorCode,
  ) {
    job.status = status;
    job.error = error;
    if (code) job.error_code = code;
    else delete job.error_code;
    job.finished_at = nowIso();
    if (status !== 'done') job.files = [];
    this.ctx.metrics?.videoExports.inc({ status });
    if (job.started_at)
      this.ctx.metrics?.videoExportDuration.observe(
        (Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000,
      );
    const store = this.store!;
    await rm(path.join(store.dirOf(job), SNAPSHOT_FILE), { force: true }).catch(() => undefined);
    await store
      .save(job)
      .catch((err: unknown) =>
        this.ctx.log.warn({ job: job.id, err: errorMessage(err) }, 'saving the video export job failed'),
      );
    this.updateActive();
    this.notify(job.id);
  }

  /** Deletes a job and its files. */
  private async forget(job: ExportJob): Promise<void> {
    this.jobs.delete(job.id);
    await this.store?.remove(job).catch(() => undefined);
  }

  /** Deletes the media files of an interrupted job (job.json stays). */
  private async removePartial(job: ExportJob): Promise<void> {
    await removeOutputs(this.store!.dirOf(job), new Set(['job.json']));
    job.files = [];
  }

  /** Starts the next queued job when none runs. */
  private pump(): void {
    if (this.running || this.closed) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return this.pump();
    const controller = new AbortController();
    const run: RunningJob = { id, controller, reason: null, done: Promise.resolve() };
    this.running = run;
    run.done = this.run(job, run)
      .catch((err: unknown) =>
        this.ctx.log.error({ job: id, err: errorMessage(err) }, 'video export crashed'),
      )
      .finally(() => {
        this.running = null;
        this.updateActive();
        void this.cleanup();
        this.pump();
      });
  }

  /** Runs one job to its end. */
  private async run(job: ExportJob, run: RunningJob): Promise<void> {
    const store = this.store!;
    const dir = store.dirOf(job);
    const cfg = this.ctx.config;
    const log = this.ctx.log;
    job.status = 'running';
    job.started_at = nowIso();
    await store.save(job).catch(() => undefined);
    this.updateActive();
    this.notify(job.id);
    log.info({ job: job.id, project: job.project }, 'video export started');
    let snapshot: SceneDoc | null = null;
    let lastSave = 0;
    let lastSizeCheck = 0;
    const t0 = performance.now();
    try {
      snapshot = SceneDoc.fromUpdate(new Uint8Array(await readFile(path.join(dir, SNAPSHOT_FILE))));
      const encoders = await ffmpegEncoders(cfg.ffmpegPath);
      const renderer = this.ctx.services.renderer;
      const name = snapshot.name;
      const result = await runExport(
        {
          renderer,
          ffmpegPath: cfg.ffmpegPath,
          encoders,
          memory: this.opts.memory,
          onFrames: (n) => this.ctx.metrics?.videoExportFrames.inc(undefined, n),
        },
        {
          jobId: job.id,
          project: { id: job.project, name },
          createdAt: job.created_at,
          params: job.params,
          snapshot,
          dir,
          signal: run.controller.signal,
          fileUrl: (file) =>
            `/api/projects/${encodeURIComponent(job.project)}/video-exports/${job.id}/files/${encodeURIComponent(file)}`,
          onStatus: (status) => {
            if (job.status === status) return;
            job.status = status;
            void store.save(job).catch(() => undefined);
            this.notify(job.id);
          },
          onProgress: (p) => {
            job.progress = p;
            const now = Date.now();
            if (now - lastSave >= PROGRESS_SAVE_MS) {
              lastSave = now;
              void store.save(job).catch(() => undefined);
            }
            // one export alone may not pass the size limit of all exports
            if (now - lastSizeCheck >= 10_000) {
              lastSizeCheck = now;
              void diskUsage(dir).then((bytes) => {
                if (bytes > cfg.exportMaxBytes && run.reason === null) {
                  run.reason = 'too-large';
                  run.controller.abort();
                }
              });
            }
          },
          onWarning: (w) => {
            if (job.warnings.length < MAX_WARNINGS && !job.warnings.includes(w)) job.warnings.push(w);
          },
          onRender: (info) => {
            job.render = info;
          },
        },
      );
      job.files = result.files;
      job.progress = {
        ...job.progress,
        frames_done: job.progress.frames_total,
        fraction: 1,
        eta_s: 0,
        shot: null,
      };
      // the speed of this export makes the next estimates
      const seconds = (performance.now() - t0) / 1000;
      const { width: w, height: h, frames } = result.plan;
      if (frames > 0 && seconds > 0) {
        const preset = qualityPreset(job.params.quality, w, h);
        const sampleCost = preset.msaa ? 1 + 0.25 * (preset.samples - 1) : preset.samples ** 2;
        const passes = 1 + 0.15 * Math.max(0, job.params.passes.length - 1);
        // per render process: the ones it rendered on (fewer than RENDER_WORKERS when memory was short)
        const processes = Math.max(1, job.render?.processes || renderer.pool.capacity);
        const measured = (seconds * processes) / frames / ((w * h) / 1e6) / sampleCost / passes;
        if (Number.isFinite(measured) && measured > 0)
          this.secondsPerMegapixel = 0.5 * this.secondsPerMegapixel + 0.5 * measured;
      }
      await this.finish(job, 'done', null);
      log.info(
        { job: job.id, project: job.project, files: job.files.length, seconds: Math.round(seconds) },
        'video export done',
      );
    } catch (err) {
      if (run.reason === 'cancel') {
        await this.finish(job, 'cancelled', null);
        log.info({ job: job.id, project: job.project }, 'video export cancelled');
      } else {
        const message =
          run.reason === 'shutdown'
            ? 'server shut down while the export ran: start it again'
            : run.reason === 'too-large'
              ? `the export grew larger than EXPORT_MAX_MB (${Math.round(cfg.exportMaxBytes / 1048576)} MB): export fewer frames, a smaller size or fewer passes, or raise EXPORT_MAX_MB`
              : errorMessage(err);
        const code = run.reason === null && err instanceof ToolError ? err.code : undefined;
        await this.finish(job, 'failed', message, code);
        log.warn({ job: job.id, project: job.project, err: message }, 'video export failed');
      }
    } finally {
      snapshot?.destroy();
    }
  }

  /** Deletes finished jobs past EXPORT_TTL_HOURS, then the oldest while all pass EXPORT_MAX_MB. */
  private async cleanup(): Promise<void> {
    const store = this.store;
    if (!store) return;
    const cfg = this.ctx.config;
    const sizes = new Map<string, number>();
    for (const job of this.jobs.values()) sizes.set(job.id, await diskUsage(store.dirOf(job)));
    const totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
    const ids = cleanupSelection(
      [...this.jobs.values()].map((j) => ({
        id: j.id,
        status: j.status,
        finished_at: j.finished_at,
        bytes: sizes.get(j.id) ?? 0,
      })),
      { now: Date.now(), ttlMs: cfg.exportTtlMs, maxBytes: cfg.exportMaxBytes, totalBytes },
    );
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (!job) continue;
      await this.forget(job);
      this.ctx.log.info(
        { job: id, project: job.project },
        'video export deleted (expired or over the size limit)',
      );
    }
  }
}
