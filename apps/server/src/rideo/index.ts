import path from 'node:path';
import * as Y from 'yjs';
import { SceneDoc, createEditorState, getShots, newId } from '@3d-editor/core';
import { NotFoundError, ToolError } from '../mcp/agent';
import { errorMessage } from '../observability/tracing';
import type { ServiceContext } from '../services';
import { requireFreeProjectName, withProjectNames } from '../sync/project-names';
import { finished } from '../video/jobs';
import { videoExportParamsSchema, type VideoExportParams } from '../video/params';
import type { ExportJob } from '../video';
import type { PassName } from '../render/protocol';
import { RideoClient, RideoError, rideoBaseUrl, rideoToolError } from './client';
import {
  EXPORT_OPERATOR,
  defaultProjectName,
  importedShots,
  otherClips,
  readClipDocs,
  runImport,
  type ModelLimits,
  type ProjectRunner,
  type RideoClipDocs,
  type RideoImportResult,
} from './import';
import { ffprobePath, posterJpeg, probeClip } from './probe';
import {
  fileResources,
  firstFrameMismatch,
  pushExport,
  type OurBlocking,
  type PushResult,
  type PushedResources,
} from './push';
import { DEFAULT_PASS, defaultMode, needsReference, shotFeatures, type ReferenceMode } from './shots';

/*
 * The bridge to a rideo server (SPEC §11): rideo_import reads a rideo clip and builds or updates a
 * project from it (desk.import_rideo_blocking, one undo step); rideo_push writes the project's
 * staging back to rideo and sends an export's clips as the shots' reference videos; POST
 * /api/rideo/previs does both around a draft export as one server-side job. RIDEO_URL and RIDEO_TOKEN
 * name the default rideo server; a call may name another (its own token: the configured token only
 * ever goes to RIDEO_URL).
 */

export type { RideoImportResult } from './import';
export type { PushResult } from './push';
export type { ReferenceMode } from './shots';

/** Where the bridge talks to (RIDEO_URL, RIDEO_TOKEN; tools may name another server). */
export interface RideoTarget {
  url?: string;
  token?: string;
  /** rideo project id. */
  project: string;
  /** rideo clip id. */
  clip: string;
}

/** Options of {@link RideoBridge.importClip} (rideo_import). */
export interface RideoImportOptions {
  rideo: RideoTarget;
  /** Character ids → actor kinds, overriding what the import infers. */
  cast_overrides?: Record<string, string>;
  /** Props and landmarks as built-in store models (when the importer offers the choice). */
  use_store_models?: boolean;
  /** The video model's duration limits (default: rideo's, read from its /api/config). */
  model_limits?: ModelLimits;
}

/** Options of {@link RideoBridge.push} (rideo_push). */
export interface RideoPushOptions {
  /** The video export whose clips are pushed. */
  export: string;
  rideo: RideoTarget;
  /** Shots (our ids or names, or rideo shot ids; default: the shots with physics, tethers, held props or a camera move). */
  shots?: string[];
  mode?: ReferenceMode;
  pass?: PassName;
  write_blocking?: boolean;
}

/** A project the bridge works in, and how it was found. */
export interface ImportTarget {
  runner: ProjectRunner;
  created: boolean;
  name: string;
}

/** How the bridge finds and creates projects (the agent's own for MCP, the rooms for REST). */
export interface ProjectAccess {
  /** The project with this id or name, or null. */
  find(ref: string): Promise<{ runner: ProjectRunner; name: string } | null>;
  /** A new empty project with this name. */
  create(name: string): Promise<{ runner: ProjectRunner; name: string }>;
}

/** POST /api/rideo/previs. */
export interface PrevisRequest {
  rideo: RideoTarget;
  /** Our project (id or name; default: one named after the clip, made when missing). */
  project?: string;
  /** Video export parameters over the previs defaults (draft, clay, clips only, rideo's fps and size). */
  export?: Partial<VideoExportParams>;
  push?: { shots?: string[]; mode?: ReferenceMode; pass?: PassName; write_blocking?: boolean };
  cast_overrides?: Record<string, string>;
  use_store_models?: boolean;
  /** The video model's duration limits (default: rideo's, read from its /api/config). */
  model_limits?: ModelLimits;
}

export type PrevisStatus = 'importing' | 'exporting' | 'pushing' | 'done' | 'failed' | 'cancelled';

/** A previs job (GET /api/rideo/previs/:job). */
export interface PrevisJob {
  id: string;
  status: PrevisStatus;
  created_at: string;
  finished_at: string | null;
  rideo: { url: string | null; project: string; clip: string };
  project: string | null;
  project_name: string | null;
  export: string | null;
  import: RideoImportResult | null;
  export_status: Pick<ExportJob, 'status' | 'progress' | 'error' | 'warnings'> | null;
  push: PushResult | null;
  error: string | null;
  warnings: string[];
}

/** Most previs jobs kept (finished ones beyond it are forgotten, oldest first). */
export const MAX_PREVIS_JOBS = 100;
/** Most previs jobs running at once (their exports queue like any other). */
export const MAX_ACTIVE_PREVIS = 4;
/** Longest wait of a previs status request (s), as for exports. */
export const MAX_PREVIS_WAIT_S = 50;

const PREVIS_ORIGIN = { type: 'rideo-previs' };
const nowIso = () => new Date().toISOString();
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** desk.export_rideo_blocking run in a project: our blocking, what it left out and each shot's move. */
export function exportBlockingOf(runner: ProjectRunner): OurBlocking {
  const res = runner.run(EXPORT_OPERATOR, {});
  const out = res.result as { blocking?: unknown; warnings?: unknown; shots?: unknown } | undefined;
  if (!res.ok || !out?.blocking || typeof out.blocking !== 'object')
    throw new ToolError(
      `${EXPORT_OPERATOR} failed: ${res.error ?? 'it returned no blocking'}`,
      res.code ?? 'FAILED',
    );
  const warnings = Array.isArray(out.warnings)
    ? out.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  const moves: Record<string, string | null> = {};
  if (Array.isArray(out.shots))
    for (const s of out.shots as { rideo_shot?: unknown; move?: unknown }[])
      if (typeof s?.rideo_shot === 'string') moves[s.rideo_shot] = typeof s.move === 'string' ? s.move : null;
  return { blocking: out.blocking as Record<string, unknown>, warnings, moves };
}

/**
 * A runner on a copy of a project's document as it is now (the previs takes it next to the export's
 * snapshot, so that the blocking it writes is the staging the clips show, whatever is edited while
 * they render); read-only operators only.
 */
export function snapshotRunner(
  ctx: Pick<ServiceContext, 'services'>,
  runner: ProjectRunner,
): ProjectRunner & { destroy(): void } {
  const doc = SceneDoc.fromUpdate(Y.encodeStateAsUpdate(runner.doc.ydoc));
  return {
    id: runner.id,
    doc,
    run: (operator, params) =>
      ctx.services.registry.run(
        { doc, state: createEditorState(), origin: PREVIS_ORIGIN, source: 'api', report: () => undefined },
        operator,
        params,
      ),
    destroy: () => doc.destroy(),
  };
}

/** A ProjectRunner on a room (REST and previs: no agent, no undo history of an agent). */
export function roomRunner(
  ctx: Pick<ServiceContext, 'services'>,
  room: { id: string; scene: SceneDoc; touch(): void },
): ProjectRunner {
  return {
    id: room.id,
    get doc() {
      return room.scene;
    },
    run(operator, params) {
      room.touch();
      return ctx.services.registry.run(
        {
          doc: room.scene,
          state: createEditorState(),
          origin: PREVIS_ORIGIN,
          source: 'api',
          report: () => undefined,
        },
        operator,
        params,
      );
    },
  };
}

/**
 * Whether a project found by the clip's name is the clip's own: it has no shots yet, or shots
 * imported from this clip and none from another.
 */
function holdsClip(doc: SceneDoc, clipId: string): boolean {
  if (!getShots(doc).length) return true;
  return Object.keys(importedShots(doc, clipId)).length > 0 && !otherClips(doc, clipId).length;
}

/**
 * The project a clip is imported into: the given one (made with that name when missing), else the
 * one named after the clip (made when missing), or '<title> (<clip id>)' when a project with the
 * title has shots of its own or of another clip.
 */
export async function importTarget(
  access: ProjectAccess,
  given: string | undefined,
  docs: RideoClipDocs,
): Promise<ImportTarget> {
  if (given) {
    const found = await access.find(given);
    if (found) return { runner: found.runner, created: false, name: found.name };
    return { ...(await access.create(given)), created: true };
  }
  const title = defaultProjectName(docs.clip);
  const names = [title, `${title} (${docs.clip.id})`.slice(0, 200)];
  for (const name of names) {
    const found = await access.find(name);
    if (!found) return { ...(await access.create(name)), created: true };
    if (holdsClip(found.runner.doc, docs.clip.id))
      return { runner: found.runner, created: false, name: found.name };
  }
  throw new ToolError(
    `Projects named '${names[0]}' and '${names[1]}' hold other shots: pass project to import into.`,
    'INVALID_PARAMS',
  );
}

/** The bridge to rideo of the server. */
export class RideoBridge {
  private readonly closing = new AbortController();
  private readonly pushes = new Map<string, Promise<unknown>>();
  private readonly previsJobs = new Map<string, PrevisJob>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(protected readonly ctx: ServiceContext) {}

  /** Whether a rideo server is configured (RIDEO_URL). */
  get configured(): boolean {
    return this.ctx.config.rideoUrl !== null;
  }

  /**
   * A client for a target: its url (else RIDEO_URL) and its token (else RIDEO_TOKEN, but only for
   * RIDEO_URL itself). UNAVAILABLE without either url.
   */
  connect(target: Pick<RideoTarget, 'url' | 'token'>, signal?: AbortSignal): RideoClient {
    const cfg = this.ctx.config;
    const configured = cfg.rideoUrl ? rideoBaseUrl(cfg.rideoUrl) : null;
    const url = target.url ? rideoBaseUrl(target.url) : configured;
    if (!url)
      throw new ToolError(
        'No rideo server: set RIDEO_URL (and RIDEO_TOKEN) on this server, or pass rideo.url and rideo.token.',
        'UNAVAILABLE',
      );
    const token = target.token ?? (url === configured ? cfg.rideoToken : null);
    const signals = [this.closing.signal, ...(signal ? [signal] : [])];
    return new RideoClient({ url, token, fetchImpl: this.ctx.fetch, signal: AbortSignal.any(signals) });
  }

  /** Reads a rideo clip and what its import needs (a rideo failure as rideoToolError codes it). */
  async readClip(target: RideoTarget, signal?: AbortSignal): Promise<{ docs: RideoClipDocs; url: string }> {
    const client = this.connect(target, signal);
    try {
      return { docs: await readClipDocs(client, target.project, target.clip), url: client.baseUrl };
    } catch (err) {
      throw err instanceof RideoError ? rideoToolError(err) : err;
    }
  }

  /** The resources pushed to each rideo clip, by content (kept in the server's data). */
  private resourcesStore: PushedResources | null = null;
  private get resources(): PushedResources {
    return (this.resourcesStore ??= fileResources(path.join(this.ctx.config.dataDir, 'rideo-push')));
  }

  /** Imports a read clip into a project (one operator call: one undo step for an agent). */
  importClip(
    target: ImportTarget,
    docs: RideoClipDocs,
    opts: Omit<RideoImportOptions, 'rideo'> & { url: string },
  ): RideoImportResult {
    return runImport(target.runner, docs, {
      ...opts,
      registry: this.ctx.services.registry,
      created: target.created,
      projectName: target.name,
    });
  }

  /**
   * Writes the blocking back and pushes an export's clips (see push.ts); one push per export at a
   * time. `runner` is the project (its live document, or the previs's copy taken with the export).
   */
  async push(runner: ProjectRunner, opts: RideoPushOptions, signal?: AbortSignal): Promise<PushResult> {
    const client = this.connect(opts.rideo, signal);
    const ffmpeg = this.ctx.config.ffmpegPath;
    const ffprobe = ffprobePath(ffmpeg);
    const run = async () => {
      try {
        return await pushExport(
          {
            client,
            exports: this.ctx.services.exports,
            project: { id: runner.id, doc: runner.doc, exportBlocking: () => exportBlockingOf(runner) },
            resources: this.resources,
            probe: (file) => probeClip(ffprobe, file),
            poster: (file) => posterJpeg(ffmpeg, file),
          },
          {
            export: opts.export,
            rideo: { project: opts.rideo.project, clip: opts.rideo.clip },
            shots: opts.shots,
            mode: opts.mode,
            pass: opts.pass,
            write_blocking: opts.write_blocking ?? true,
          },
        );
      } catch (err) {
        throw err instanceof RideoError ? rideoToolError(err) : err;
      }
    };
    const prev = this.pushes.get(opts.export) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    this.pushes.set(opts.export, tail);
    void tail.then(() => {
      if (this.pushes.get(opts.export) === tail) this.pushes.delete(opts.export);
    });
    const result = await next;
    this.ctx.log?.info(
      { project: runner.id, export: opts.export, status: result.status, shots: result.shots.length },
      'rideo push',
    );
    return result;
  }

  // ---------------------------------------------------------------- previs

  /** Starts a previs job: import, draft export, push (POST /api/rideo/previs). */
  async startPrevis(req: PrevisRequest): Promise<PrevisJob> {
    const active = [...this.previsJobs.values()].filter((j) => !previsFinished(j.status)).length;
    if (active >= MAX_ACTIVE_PREVIS)
      throw new ToolError(
        `${active} previs jobs are running (at most ${MAX_ACTIVE_PREVIS}): wait for one to finish.`,
        'QUEUE_FULL',
      );
    // what can be refused at once is refused before the job starts
    const client = this.connect(req.rideo);
    if (req.export) {
      const check = videoExportParamsSchema.safeParse(req.export);
      if (!check.success)
        throw new ToolError(
          `Invalid export parameters: ${check.error.issues.map((i) => `${i.path.join('.') || 'export'}: ${i.message}`).join('; ')}`,
          'INVALID_PARAMS',
        );
    }
    const job: PrevisJob = {
      id: newId(),
      status: 'importing',
      created_at: nowIso(),
      finished_at: null,
      rideo: { url: client.baseUrl, project: req.rideo.project, clip: req.rideo.clip },
      project: null,
      project_name: null,
      export: null,
      import: null,
      export_status: null,
      push: null,
      error: null,
      warnings: [],
    };
    this.previsJobs.set(job.id, job);
    this.forgetOldPrevis();
    void this.runPrevis(job, req);
    return copy(job);
  }

  /** A previs job, after waiting up to `waitS` seconds for it to change (NOT_FOUND when unknown). */
  async previsStatus(id: string, opts: { waitS?: number; signal?: AbortSignal } = {}): Promise<PrevisJob> {
    const job = this.previsJobs.get(id);
    if (!job)
      throw new NotFoundError(`Previs job '${id}' not found (jobs are kept until the server restarts)`);
    const waitS = Math.max(0, Math.min(MAX_PREVIS_WAIT_S, opts.waitS ?? 0));
    if (waitS > 0 && !previsFinished(job.status)) await this.waitChange(id, waitS * 1000, opts.signal);
    return copy(job);
  }

  private async runPrevis(job: PrevisJob, req: PrevisRequest): Promise<void> {
    const signal = this.closing.signal;
    const exports = this.ctx.services.exports;
    const log = this.ctx.log;
    const set = (patch: Partial<PrevisJob>) => {
      Object.assign(job, patch);
      this.notify(job.id);
    };
    let snapshot: (ProjectRunner & { destroy(): void }) | null = null;
    try {
      const { docs, url } = await this.readClip(req.rideo, signal);
      const target = await importTarget(this.roomAccess(), req.project, docs);
      set({ project: target.runner.id, project_name: target.name });
      const imported = this.importClip(target, docs, {
        url,
        cast_overrides: req.cast_overrides,
        use_store_models: req.use_store_models,
        model_limits: req.model_limits,
      });
      set({ import: imported });
      const plan = previsPlan(target.runner.doc, docs, imported.shots, req.push, planMismatchOf(imported));
      job.warnings.push(...plan.warnings);
      if (!plan.shots.length) {
        job.warnings.push(
          'no shot needs a reference (no physics, tether, held prop or camera move): nothing was exported; pass push.shots to choose some',
        );
        set({ status: 'done' });
        return;
      }
      set({ status: 'exporting' });
      const params = previsExportParams(docs, plan, req.export);
      // the staging the clips will show: a copy taken with the export's snapshot (edits made while
      // they render reach neither), from which the push writes the blocking
      snapshot = snapshotRunner(this.ctx, target.runner);
      const started = await exports.start(target.runner.id, params);
      set({ export: started.id, export_status: exportStatusOf(started) });
      let st = started;
      while (!finished(st.status)) {
        if (signal.aborted) throw new ToolError('the server shut down during the previs', 'UNAVAILABLE');
        st = await exports.status(started.id, {
          project: target.runner.id,
          waitS: MAX_PREVIS_WAIT_S,
          signal,
        });
        set({ export_status: exportStatusOf(st) });
      }
      if (st.status !== 'done')
        throw new ToolError(`the export ${st.status}${st.error ? `: ${st.error}` : ''}`, 'FAILED');
      set({ status: 'pushing' });
      const pushed = await this.push(
        snapshot,
        {
          export: started.id,
          rideo: req.rideo,
          shots: plan.shots,
          mode: req.push?.mode,
          pass: req.push?.pass,
          write_blocking: req.push?.write_blocking ?? true,
        },
        signal,
      );
      set({
        push: pushed,
        status: pushed.status === 'failed' ? 'failed' : 'done',
        error:
          pushed.status === 'failed'
            ? (pushed.blocking.error ?? pushed.shots.find((s) => s.error)?.error ?? 'the push failed')
            : null,
      });
    } catch (err) {
      set({ status: signal.aborted ? 'cancelled' : 'failed', error: errorMessage(err) });
      log?.warn({ job: job.id, err: errorMessage(err) }, 'rideo previs failed');
    } finally {
      snapshot?.destroy();
      set({ finished_at: nowIso() });
    }
  }

  /** Projects found and made by id or name through the rooms (REST has no agent). */
  private roomAccess(): ProjectAccess {
    const rooms = this.ctx.rooms;
    const runner = (room: Parameters<typeof roomRunner>[1] & { scene: SceneDoc }) => ({
      runner: roomRunner(this.ctx, room),
      name: room.scene.name,
    });
    return {
      find: async (ref) => {
        const byId = await rooms.open(ref).catch(() => null);
        if (byId) return runner(byId);
        const listed = await rooms.listProjects();
        const hit =
          listed.find((p) => p.name === ref) ??
          listed.find((p) => p.name.toLowerCase() === ref.toLowerCase());
        const room = hit ? await rooms.open(hit.id).catch(() => null) : null;
        return room ? runner(room) : null;
      },
      create: async (name) => {
        const room = await withProjectNames(rooms, async () => {
          await requireFreeProjectName(rooms, name);
          return rooms.createProject({ name, empty: true });
        });
        return runner(room);
      },
    };
  }

  private forgetOldPrevis(): void {
    const all = [...this.previsJobs.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    for (const j of all) {
      if (this.previsJobs.size <= MAX_PREVIS_JOBS) break;
      if (previsFinished(j.status)) this.previsJobs.delete(j.id);
    }
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

  /** Stops requests in flight and running previs jobs (server shutdown). */
  async close(): Promise<void> {
    this.closing.abort();
    for (const set of this.waiters.values()) for (const w of set) w();
    this.waiters.clear();
  }
}

const previsFinished = (s: PrevisStatus) => s === 'done' || s === 'failed' || s === 'cancelled';

/**
 * The rideo shots whose camera the import found at odds with their planned layout (the desk's
 * plan_mismatch, which rideo's own check repeats once the blocking is written): their references
 * will be camera references, so a previs renders the pass that mode sends.
 */
export function planMismatchOf(imported: RideoImportResult): Map<string, string> {
  const out = new Map<string, string>();
  const shots = (imported.result as { shots?: unknown } | null)?.shots;
  if (Array.isArray(shots))
    for (const s of shots as { rideo_shot?: unknown; agrees?: unknown }[])
      if (typeof s?.rideo_shot === 'string' && s.agrees === false)
        out.set(s.rideo_shot, "the shot's camera disagrees with its planned layout");
  return out;
}

function exportStatusOf(j: ExportJob): PrevisJob['export_status'] {
  return { status: j.status, progress: j.progress, error: j.error, warnings: j.warnings };
}

/** What a previs exports: the shots to push (our ids) and the passes their modes need. */
export interface PrevisPlan {
  shots: string[];
  passes: PassName[];
  warnings: string[];
}

/**
 * The shots a previs pushes (as given, else those with props in motion or a camera move) and the
 * passes their default modes need; beauty is always rendered, so a shot whose mode turns out
 * different at push time (rideo's line differs) still has a clip.
 */
export function previsPlan(
  doc: SceneDoc,
  docs: RideoClipDocs,
  imported: Record<string, string>,
  push: PrevisRequest['push'],
  planMismatch: ReadonlyMap<string, string> = new Map(),
): PrevisPlan {
  const warnings: string[] = [];
  const shots = getShots(doc);
  const byRideo = new Map(Object.entries(imported));
  const rideoShots = new Map(docs.clip.shots.map((s) => [s.id, s]));
  const aspect = docs.project.settings.resolution.width / docs.project.settings.resolution.height;
  let chosen: string[];
  if (push?.shots?.length) {
    chosen = push.shots.map((ref) => {
      const id =
        byRideo.get(ref) ??
        shots.find((s) => s.id === ref)?.id ??
        shots.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase())?.id;
      if (!id) throw new ToolError(`push.shots: no shot '${ref}' in the imported project`, 'INVALID_PARAMS');
      return id;
    });
  } else
    chosen = shots
      .filter((s) => s.enabled && s.external?.shot && byRideo.get(s.external.shot) === s.id)
      .filter((s) => needsReference(shotFeatures(doc, s, aspect)))
      .map((s) => s.id);
  const passes = new Set<PassName>(['beauty']);
  for (const id of chosen) {
    const s = shots.find((x) => x.id === id);
    const rs = s?.external?.shot ? rideoShots.get(s.external.shot) : undefined;
    if (!s || !rs) continue;
    const mode =
      push?.mode ??
      defaultMode(
        shotFeatures(doc, s, aspect),
        firstFrameMismatch(docs.project, rs, new Set(), planMismatch) === null,
      );
    passes.add(push?.pass ?? DEFAULT_PASS[mode]);
  }
  return { shots: [...new Set(chosen)], passes: [...passes], warnings };
}

/** The export of a previs: draft, clay, clips only, at rideo's fps and size, over which `given` goes. */
export function previsExportParams(
  docs: RideoClipDocs,
  plan: PrevisPlan,
  given: Partial<VideoExportParams> | undefined,
): VideoExportParams {
  const { fps, resolution } = docs.project.settings;
  const title = docs.clip.title || docs.clip.id;
  return videoExportParamsSchema.parse({
    shots: plan.shots,
    quality: 'draft',
    look: 'clay',
    outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
    passes: plan.passes,
    fps,
    width: resolution.width,
    height: resolution.height,
    label: `rideo previs: ${title}`.slice(0, 200),
    ...(given ?? {}),
  });
}
