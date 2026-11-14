import {
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_WIDTH,
  type PassName,
  type SceneBrief,
  type ShotResultMeta,
} from '@3d-editor/core';
import {
  BrowserExportError,
  releaseBrowserExport,
  startBrowserExport,
  type BrowserExportFile,
  type BrowserExportProgress,
  type BrowserExportRequest,
  type BrowserExportResult,
} from '../export';
import {
  MODES,
  briefShotFrames,
  type ErrorCode,
  type Mode,
  type Phase,
  type ResultFile,
  type ShotResult,
} from './protocol';

/*
 * The desk's export (docs/embedding.md, "Send and export"): the reference clips of a host's shots,
 * rendered and encoded in this browser by the browser export engine (apps/web/src/export) from a
 * snapshot of the scene, and their ShotResults.
 *
 * - Preset 'reference' (draft quality, clay look, clips only) at the brief's width, height and fps,
 *   one pass per mode: motion → beauty (in the clay look), pose → pose, camera → depth; with a still
 *   (the beauty image of the shot's first frame) unless the request says otherwise.
 * - One engine export per shot, in brief order, so that a shot that fails (out of memory, an encoder
 *   that stops) is left out and named in an error while the other shots still come back.
 * - Files are named `<shotId>.<mode>.mp4` and `<shotId>.still.png` (the host's shot ids). Every clip
 *   of a shot must have exactly the frames of its ShotResult; a shot whose desk length differs from
 *   the brief's (max(1, round(durationSec × fps))) says so in its issues: the host refuses its clip.
 */

/** The pass of each reference mode. */
export const MODE_PASS: Record<Mode, PassName> = { motion: 'beauty', pose: 'pose', camera: 'depth' };

/** The passes of `modes`, each once, in the contract's mode order. */
export function passesFor(modes: readonly Mode[]): PassName[] {
  return MODES.filter((m) => modes.includes(m)).map((m) => MODE_PASS[m]);
}

/** The mode of a pass (null for a pass no mode has). */
export function modeOfPass(pass: string | null): Mode | null {
  return MODES.find((m) => MODE_PASS[m] === pass) ?? null;
}

/** A clip's name: `<shotId>.<mode>.mp4`. */
export const clipName = (shotId: string, mode: Mode): string => `${shotId}.${mode}.mp4`;
/** A still's name: `<shotId>.still.png`. */
export const stillName = (shotId: string): string => `${shotId}.still.png`;

/**
 * Why the desk cannot export at this size, or null. The contract allows 16–4096 pixels a side; the
 * export engine (core's MAX_EXPORT_WIDTH × MAX_EXPORT_HEIGHT) renders at most 3840 × 2160, so a
 * larger brief is answered with export_unavailable (staging and editing still work).
 */
export function exportSizeProblem(width: number, height: number): string | null {
  if (width <= MAX_EXPORT_WIDTH && height <= MAX_EXPORT_HEIGHT) return null;
  return (
    `The desk exports clips of at most ${MAX_EXPORT_WIDTH} × ${MAX_EXPORT_HEIGHT} pixels; this scene is ` +
    `${width} × ${height}. Ask for a smaller size (staging and editing work at any size).`
  );
}

/** The engine's parameters of one shot's clips. */
export function shotExportParams(o: {
  deskShotId: string;
  modes: readonly Mode[];
  width: number;
  height: number;
  fps: number;
}): Record<string, unknown> {
  return {
    preset: 'reference',
    shots: [o.deskShotId],
    passes: passesFor(o.modes),
    width: o.width,
    height: o.height,
    fps: o.fps,
    match_model_duration: false,
    outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
  };
}

/** The issue of a shot whose length in the desk differs from the brief's (null when it agrees). */
export function lengthIssue(
  frames: number,
  briefShot: Pick<SceneBrief['shots'][number], 'durationSec'>,
  fps: number,
  hostName: string,
): ShotResult['issues'][number] | null {
  const asked = briefShotFrames(briefShot.durationSec, fps);
  if (asked === frames) return null;
  const sec = (n: number) => `${Math.round((n / fps) * 1000) / 1000} s`;
  return {
    code: 'brief_length',
    severity: 'error',
    message:
      `The shot is ${frames} frames (${sec(frames)}) in the desk and ${asked} frames (${sec(asked)}) in the ` +
      `brief: ${hostName} refuses a clip of another length. Set its length back, or change the shot's ` +
      `duration in ${hostName}.`,
  };
}

/** The ShotResult of a shot's results with the files the export wrote. */
export function shotResultOf(
  meta: ShotResultMeta,
  o: { modes: readonly Mode[]; still: boolean; fps: number; extraIssues?: ShotResult['issues'] },
): ShotResult {
  const references: ShotResult['references'] = {};
  for (const m of MODES) if (o.modes.includes(m)) references[m] = clipName(meta.shotId, m);
  return {
    shotId: meta.shotId,
    frames: meta.frames,
    durationSec: meta.frames / o.fps,
    references,
    still: o.still ? stillName(meta.shotId) : null,
    camera: meta.camera,
    line: meta.line,
    moves: meta.moves,
    planAgrees: meta.planAgrees,
    issues: [...meta.issues, ...(o.extraIssues ?? [])],
  };
}

/** The error code of an engine failure of one shot. */
export function failureCode(
  err: unknown,
): 'cancelled' | 'out_of_memory' | 'export_unavailable' | 'export_failed' {
  if (err instanceof BrowserExportError) {
    if (err.code === 'CANCELLED') return 'cancelled';
    if (err.code === 'OUT_OF_MEMORY') return 'out_of_memory';
    if (err.code === 'UNSUPPORTED') return 'export_unavailable';
  }
  return 'export_failed';
}

/** The engine the desk's export runs on (tests give a fake one). */
export interface ExportEngine {
  start(
    req: BrowserExportRequest,
    hooks: { onProgress?: (p: BrowserExportProgress) => void; signal?: AbortSignal },
  ): Promise<BrowserExportResult>;
  release(result: BrowserExportResult): Promise<void>;
}

export const browserEngine: ExportEngine = {
  start: (req, hooks) => startBrowserExport(req, hooks),
  release: (r) => releaseBrowserExport(r),
};

export interface DeskExportRequest {
  /** The scene snapshot (Y.encodeStateAsUpdate of the session's document). */
  update: Uint8Array;
  brief: SceneBrief;
  /** The results of the asked shots, in brief order (staging worker: shotResults). */
  shots: ShotResultMeta[];
  modes: readonly Mode[];
  still: boolean;
  hostName: string;
  project: { id: string; name: string };
}

export interface DeskExportProgress {
  phase: Phase;
  done: number;
  total: number;
  /** The host's shot id being rendered. */
  shotId?: string;
}

/** A shot the export left out. */
export interface ShotFailure {
  shotId: string;
  code: 'out_of_memory' | 'export_unavailable' | 'export_failed';
  message: string;
}

export interface DeskExportOutcome {
  shots: ShotResult[];
  files: ResultFile[];
  failures: ShotFailure[];
  /** Releases the engine's files (the Origin Private File System) once the result is sent. */
  release(): Promise<void>;
}

/** A whole export that failed: no shot came back (or it was cancelled). */
export class DeskExportError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeskExportError';
  }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Exports the asked shots one by one (see the module comment). Resolves with the shots that came
 * back and the ones left out; rejects with DeskExportError when it was cancelled (code cancelled)
 * or no shot came back (out_of_memory when every shot ran out of memory, export_unavailable when
 * the browser cannot encode any, else export_failed).
 */
export async function runDeskExport(
  req: DeskExportRequest,
  hooks: { onProgress?: (p: DeskExportProgress) => void; signal?: AbortSignal } = {},
  engine: ExportEngine = browserEngine,
): Promise<DeskExportOutcome> {
  const { brief } = req;
  const fps = brief.fps;
  const totalFrames = req.shots.reduce((n, s) => n + s.frames, 0);
  const progress = (p: DeskExportProgress) => {
    try {
      hooks.onProgress?.(p);
    } catch {
      // a failing listener does not fail the export
    }
  };
  const briefShot = new Map(brief.shots.map((s) => [s.id, s]));
  const done: { result: ShotResult; files: BrowserExportFile[]; engine: BrowserExportResult }[] = [];
  const failures: ShotFailure[] = [];
  const kept: BrowserExportResult[] = [];
  const releaseAll = async () => {
    await Promise.all(kept.splice(0).map((r) => engine.release(r).catch(() => undefined)));
  };
  let framesBefore = 0;
  let rendering = false;
  progress({ phase: 'prepare', done: 0, total: req.shots.length });
  try {
    for (const meta of req.shots) {
      if (hooks.signal?.aborted) throw new DeskExportError('cancelled', 'The export was cancelled.');
      let r: BrowserExportResult;
      try {
        r = await engine.start(
          {
            update: req.update,
            params: shotExportParams({
              deskShotId: meta.deskShotId,
              modes: req.modes,
              width: brief.width,
              height: brief.height,
              fps,
            }),
            stills: req.still,
            project: req.project,
          },
          {
            signal: hooks.signal,
            onProgress: (p) => {
              if (p.phase !== 'render' && !rendering) return;
              rendering = true;
              const inShot = p.phase === 'render' ? Math.min(p.done, meta.frames) : p.phase === 'prepare' ? 0 : meta.frames;
              progress({ phase: 'render', done: framesBefore + inShot, total: totalFrames, shotId: meta.shotId });
            },
          },
        );
      } catch (err) {
        const code = failureCode(err);
        if (code === 'cancelled' || hooks.signal?.aborted)
          throw new DeskExportError('cancelled', 'The export was cancelled.');
        failures.push({ shotId: meta.shotId, code, message: `${meta.shotId}: ${errorMessage(err)}` });
        framesBefore += meta.frames;
        continue;
      }
      kept.push(r);
      framesBefore += meta.frames;
      // the files of the shot, and their frames
      const files: BrowserExportFile[] = [];
      let problem: string | null = null;
      for (const mode of req.modes) {
        const f = r.files.find(
          (x) => x.kind === 'clip' && x.shot === meta.deskShotId && x.pass === MODE_PASS[mode],
        );
        if (!f) problem = `its ${mode} clip is missing`;
        else if (f.frames !== meta.frames)
          problem = `its ${mode} clip has ${f.frames ?? 'no'} frames, not the shot's ${meta.frames}`;
        else files.push({ ...f, name: clipName(meta.shotId, mode) });
        if (problem) break;
      }
      if (!problem && req.still) {
        const f = r.files.find((x) => x.kind === 'still' && x.shot === meta.deskShotId);
        if (!f) problem = 'its still is missing';
        else files.push({ ...f, name: stillName(meta.shotId) });
      }
      if (problem) {
        failures.push({ shotId: meta.shotId, code: 'export_failed', message: `${meta.shotId}: ${problem}.` });
        continue;
      }
      const b = briefShot.get(meta.shotId);
      const issue = b ? lengthIssue(meta.frames, b, fps, req.hostName) : null;
      done.push({
        result: shotResultOf(meta, {
          modes: req.modes,
          still: req.still,
          fps,
          extraIssues: issue ? [issue] : [],
        }),
        files,
        engine: r,
      });
    }
    if (!done.length) {
      const codes = new Set(failures.map((f) => f.code));
      const code: ErrorCode =
        codes.size === 1 && codes.has('out_of_memory')
          ? 'out_of_memory'
          : codes.size === 1 && codes.has('export_unavailable')
            ? 'export_unavailable'
            : 'export_failed';
      throw new DeskExportError(
        code,
        failures.length
          ? failures.map((f) => f.message).join(' ')
          : 'The export has no shots: the scene has none of the shots asked for.',
      );
    }
    // the files' bytes, for the host
    const fileCount = done.reduce((n, d) => n + d.files.length, 0);
    let read = 0;
    progress({ phase: 'encode', done: 0, total: fileCount });
    const files: ResultFile[] = [];
    for (const d of done)
      for (const f of d.files) {
        if (hooks.signal?.aborted) throw new DeskExportError('cancelled', 'The export was cancelled.');
        const data = await (await f.blob()).arrayBuffer();
        files.push({ name: f.name, mime: f.mime as ResultFile['mime'], data });
        progress({ phase: 'encode', done: ++read, total: fileCount });
      }
    progress({ phase: 'finish', done: 0, total: 1 });
    return { shots: done.map((d) => d.result), files, failures, release: releaseAll };
  } catch (err) {
    await releaseAll();
    if (err instanceof DeskExportError) throw err;
    throw new DeskExportError('export_failed', errorMessage(err));
  }
}
