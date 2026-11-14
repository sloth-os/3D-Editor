import {
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_WIDTH,
  briefChanges,
  getShots,
  shotOutputFrames,
  type PassName,
  type SceneBrief,
  type SceneDoc,
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
import { videoBitrate } from '../export/codec';
import { tabMemory } from '../render/memory';
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
 * - Each shot's frames are counted before anything renders, as the engine plans them at the brief's
 *   frame rate (its scene frames resampled from the scene's rate: plannedFrames); every clip must
 *   have exactly those, and a shot whose count differs from the brief's (max(1, round(durationSec ×
 *   fps))) says so in its issues (brief_length): the host refuses its clip.
 * - Before rendering, the result's size is estimated (the encoder's bit rate, the stills): a result
 *   this tab cannot hold at once is refused with out_of_memory.
 * - One engine export per shot, in brief order, so that a shot that fails (out of memory, an encoder
 *   that stops) is left out and named in an error while the other shots still come back. A shot's
 *   engine files are let go as soon as its bytes are in the result (or it failed a check).
 * - Files are named `<shotId>.<mode>.mp4` and `<shotId>.still.png` (the host's shot ids).
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
 * export engine (core's MAX_EXPORT_WIDTH and MAX_EXPORT_HEIGHT) renders clips at most 3840 pixels
 * wide and 2160 high, whichever way the scene is turned (a portrait scene too is at most 2160 high),
 * so a larger brief is answered with export_unavailable (staging and editing still work).
 */
export function exportSizeProblem(width: number, height: number): string | null {
  const wide = width > MAX_EXPORT_WIDTH;
  const high = height > MAX_EXPORT_HEIGHT;
  if (!wide && !high) return null;
  const over = wide && high ? 'too wide and too high' : wide ? 'too wide' : 'too high';
  return (
    `The desk exports clips at most ${MAX_EXPORT_WIDTH} pixels wide and ${MAX_EXPORT_HEIGHT} pixels high ` +
    `(a portrait scene too: at most ${MAX_EXPORT_HEIGHT} high); this scene is ${width} × ${height}, ${over}. ` +
    `Ask for a smaller size (staging and editing work at any size).`
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

/** Output frames of `sceneFrames` scene frames at another rate, as core's planExport counts them. */
const resampled = (sceneFrames: number, sceneFps: number, fps: number): number =>
  Math.max(1, Math.round((sceneFrames * fps) / sceneFps));

/**
 * The frames of a shot's clips at `fps` (the brief's), as the engine plans them: the shot's scene
 * frames resampled from the scene's rate (core's planExport), counted before anything renders.
 */
export function plannedFrames(
  meta: Pick<ShotResultMeta, 'frames' | 'sceneFrames' | 'sceneFps'>,
  fps: number,
) {
  if (!(meta.sceneFrames > 0) || !(meta.sceneFps > 0)) return meta.frames;
  return resampled(meta.sceneFrames, meta.sceneFps, fps);
}

/** Why a shot's clip has another length than the brief's, as its issue says it. */
export interface LengthCause {
  /** The brief changed the shot's length (or frame rate) since it was staged: Update shots fixes it. */
  byBrief: boolean;
  /** The open is read-only (no Update shots). */
  readOnly?: boolean;
}

/** The issue of a shot whose length in the desk differs from the brief's (null when it agrees). */
export function lengthIssue(
  frames: number,
  briefShot: Pick<SceneBrief['shots'][number], 'durationSec'>,
  fps: number,
  hostName: string,
  cause: LengthCause = { byBrief: false },
): ShotResult['issues'][number] | null {
  const asked = briefShotFrames(briefShot.durationSec, fps);
  if (asked === frames) return null;
  const sec = (n: number) => `${Math.round((n / fps) * 1000) / 1000} s`;
  const lengths =
    `${frames} frames (${sec(frames)}) in the desk and ${asked} frames (${sec(asked)}) in the brief, ` +
    `at ${fps} fps: ${hostName} refuses a clip of another length.`;
  const message = cause.byBrief
    ? `The brief changed this shot's length since it was staged: it is ${lengths} ` +
      (cause.readOnly
        ? `The scene is read-only here: open it for editing and press Update shots, then send again.`
        : `Press Update shots (the brief's changes, above the scene), then send again.`)
    : `The shot is ${lengths} Set its length back, or change the shot's duration in ${hostName}.`;
  return { code: 'brief_length', severity: 'error', message };
}

/** The ShotResult of a shot's results with the files the export wrote (`frames`: its clips' frames). */
export function shotResultOf(
  meta: ShotResultMeta,
  o: {
    modes: readonly Mode[];
    still: boolean;
    fps: number;
    frames?: number;
    extraIssues?: ShotResult['issues'];
  },
): ShotResult {
  const frames = o.frames ?? plannedFrames(meta, o.fps);
  const references: ShotResult['references'] = {};
  for (const m of MODES) if (o.modes.includes(m)) references[m] = clipName(meta.shotId, m);
  return {
    shotId: meta.shotId,
    frames,
    durationSec: frames / o.fps,
    references,
    still: o.still ? stillName(meta.shotId) : null,
    camera: meta.camera,
    line: meta.line,
    moves: meta.moves,
    planAgrees: meta.planAgrees,
    issues: [...meta.issues, ...(o.extraIssues ?? [])],
  };
}

/** The error code of an engine failure of one shot (out_of_memory and export_unavailable decide the
 * code of an export of which no shot came back; a shot left out is reported as export_failed). */
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

/** The cause of a shot's failure in words (its left-out error says it). */
const FAILURE_CAUSE: Record<'out_of_memory' | 'export_unavailable' | 'export_failed', string> = {
  out_of_memory: 'out of memory',
  export_unavailable: 'the browser cannot encode it',
  export_failed: 'the export failed',
};

// ---------------------------------------------------------------- the result's size

/** Bytes a still (an 8-bit RGB PNG of the clay look) takes per pixel, about (they compress well). */
export const STILL_BYTES_PER_PIXEL = 0.5;
/** Bytes an MP4 clip takes besides its frames' data: the index (per frame) and the headers. */
export const CLIP_OVERHEAD = { base: 4096, perFrame: 32 } as const;

/**
 * The bytes of a result, estimated before it renders: each clip at the encoder's bit rate for the
 * reference preset (draft quality at the brief's size and rate) over its frames, with the MP4 index,
 * and each still at STILL_BYTES_PER_PIXEL.
 */
export function estimateResultBytes(o: {
  frames: readonly number[];
  modes: number;
  still: boolean;
  width: number;
  height: number;
  fps: number;
}): number {
  const bitrate = videoBitrate('draft', o.width, o.height, o.fps);
  let bytes = 0;
  for (const f of o.frames) {
    const clip = (bitrate * f) / o.fps / 8 + CLIP_OVERHEAD.base + CLIP_OVERHEAD.perFrame * f;
    bytes += clip * o.modes;
    if (o.still) bytes += o.width * o.height * STILL_BYTES_PER_PIXEL;
  }
  return Math.ceil(bytes);
}

/**
 * The bytes a result may have: it is held in this page at once (its files' ArrayBuffers) and handed
 * to the host, which holds it too while it takes it, so half of the memory a render may use
 * (render/memory.ts tabMemory: half the device's memory, at most 4 GB).
 */
export function resultBudget(): number {
  return Math.floor(tabMemory().budget / 2);
}

/** Bytes in words: "1.6 GB", "540 MB", "820 KB". */
export function bytesText(n: number): string {
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ---------------------------------------------------------------- the Send check

/** A brief shot whose clip would have another length than the brief's (its clip is refused). */
export interface LengthCheck {
  shotId: string;
  name: string;
  /** The frames its clips would have at the brief's frame rate (as the engine plans them). */
  frames: number;
  /** The brief's frames: max(1, round(durationSec × fps)). */
  briefFrames: number;
  /** The brief changed the shot's length (or frame rate) since it was staged: Update shots fixes it. */
  byBrief: boolean;
}

/**
 * The brief's staged shots whose clips would have another length than the brief's, counted as the
 * export counts them (the scene's frames resampled to the brief's rate), each with why: the brief
 * retimed it since it was staged (briefChanges), else the desk did.
 */
export function lengthChecks(doc: SceneDoc, brief: SceneBrief): LengthCheck[] {
  const fps = doc.getScene().fps;
  const sceneFps = fps > 0 && Number.isFinite(fps) ? fps : 24;
  const desk = new Map<string, ReturnType<typeof getShots>[number]>();
  for (const s of getShots(doc))
    if (
      s.external?.source === 'host' &&
      s.external.clip === brief.id &&
      s.external.shot &&
      !desk.has(s.external.shot)
    )
      desk.set(s.external.shot, s);
  let retimed: Set<string>;
  try {
    retimed = new Set(briefChanges(doc, brief)?.retimed ?? []);
  } catch {
    retimed = new Set();
  }
  const out: LengthCheck[] = [];
  for (const b of brief.shots) {
    const d = desk.get(b.id);
    if (!d) continue;
    const frames = resampled(shotOutputFrames(d), sceneFps, brief.fps);
    const briefFrames = briefShotFrames(b.durationSec, brief.fps);
    if (frames !== briefFrames)
      out.push({ shotId: b.id, name: d.name, frames, briefFrames, byBrief: retimed.has(b.id) });
  }
  return out;
}

// ---------------------------------------------------------------- the screen's wake lock

/**
 * Whether this document may keep the screen on (the permissions policy's 'screen-wake-lock'): a
 * framed desk may only where its iframe's `allow` names it. True where the browser cannot tell (the
 * request is then refused if it may not).
 */
export function wakeLockAllowed(doc: unknown = globalThis.document): boolean {
  type Policy = { allowsFeature?: (feature: string) => boolean };
  const d = doc as { permissionsPolicy?: Policy; featurePolicy?: Policy } | undefined;
  const policy = d?.permissionsPolicy ?? d?.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== 'function') return true;
  try {
    return policy.allowsFeature('screen-wake-lock') !== false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- the export

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
  /** The host's shot ids the brief retimed since they were staged (their brief_length issue says so). */
  retimed?: readonly string[];
  /** The open is read-only (no Update shots). */
  readOnly?: boolean;
}

export interface DeskExportProgress {
  phase: Phase;
  done: number;
  total: number;
  /** The host's shot id being rendered. */
  shotId?: string;
}

/** A shot the export left out (reported as export_failed; `code` is the engine's cause). */
export interface ShotFailure {
  shotId: string;
  code: 'out_of_memory' | 'export_unavailable' | 'export_failed';
  message: string;
}

export interface DeskExportOutcome {
  shots: ShotResult[];
  files: ResultFile[];
  failures: ShotFailure[];
  /** Releases what the engine still holds (the Origin Private File System) once the result is sent. */
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

export interface DeskExportOptions {
  /** The bytes the result may have (default resultBudget()). */
  budget?: number;
}

/**
 * Exports the asked shots one by one (see the module comment). Resolves with the shots that came
 * back and the ones left out; rejects with DeskExportError when it was cancelled (code cancelled),
 * when its result would not fit in memory (out_of_memory, before anything renders) or when no shot
 * came back (out_of_memory when every shot ran out of memory, export_unavailable when the browser
 * cannot encode any, else export_failed).
 */
export async function runDeskExport(
  req: DeskExportRequest,
  hooks: { onProgress?: (p: DeskExportProgress) => void; signal?: AbortSignal } = {},
  engine: ExportEngine = browserEngine,
  opts: DeskExportOptions = {},
): Promise<DeskExportOutcome> {
  const { brief } = req;
  const fps = brief.fps;
  // each shot's frames as the engine plans them at the brief's rate, before anything renders
  const planned = new Map(req.shots.map((m) => [m.shotId, plannedFrames(m, fps)]));
  const framesOf = (m: ShotResultMeta) => planned.get(m.shotId)!;
  const totalFrames = req.shots.reduce((n, s) => n + framesOf(s), 0);
  const progress = (p: DeskExportProgress) => {
    try {
      hooks.onProgress?.(p);
    } catch {
      // a failing listener does not fail the export
    }
  };
  // the result is held at once: refuse one this tab cannot hold before rendering it
  const estimate = estimateResultBytes({
    frames: req.shots.map(framesOf),
    modes: req.modes.length,
    still: req.still,
    width: brief.width,
    height: brief.height,
    fps,
  });
  const budget = opts.budget ?? resultBudget();
  if (estimate > budget) {
    const n = req.shots.length;
    throw new DeskExportError(
      'out_of_memory',
      `The export would hand over about ${bytesText(estimate)} of clips${req.still ? ' and stills' : ''} at once ` +
        `(${n} shot${n === 1 ? '' : 's'}, ${req.modes.length} clip${req.modes.length === 1 ? '' : 's'} each at ` +
        `${brief.width} × ${brief.height} and ${fps} fps); this browser can hold about ${bytesText(budget)} for it. ` +
        `Export fewer shots or modes at a time, or ask for a smaller size.`,
    );
  }
  const briefShot = new Map(brief.shots.map((s) => [s.id, s]));
  const retimed = new Set(req.retimed ?? []);
  const done: { result: ShotResult; files: BrowserExportFile[]; engine: BrowserExportResult }[] = [];
  const failures: ShotFailure[] = [];
  const kept = new Set<BrowserExportResult>();
  const release = async (r: BrowserExportResult) => {
    if (!kept.delete(r)) return;
    await engine.release(r).catch(() => undefined);
  };
  const releaseAll = async () => {
    await Promise.all([...kept].map((r) => release(r)));
  };
  let framesBefore = 0;
  let rendering = false;
  progress({ phase: 'prepare', done: 0, total: req.shots.length });
  try {
    for (const meta of req.shots) {
      if (hooks.signal?.aborted) throw new DeskExportError('cancelled', 'The export was cancelled.');
      const frames = framesOf(meta);
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
              const inShot =
                p.phase === 'render' ? Math.min(p.done, frames) : p.phase === 'prepare' ? 0 : frames;
              progress({
                phase: 'render',
                done: framesBefore + inShot,
                total: totalFrames,
                shotId: meta.shotId,
              });
            },
          },
        );
      } catch (err) {
        const code = failureCode(err);
        if (code === 'cancelled' || hooks.signal?.aborted)
          throw new DeskExportError('cancelled', 'The export was cancelled.');
        failures.push({
          shotId: meta.shotId,
          code,
          message: `${meta.shotId}: ${FAILURE_CAUSE[code]}: ${errorMessage(err)}`,
        });
        framesBefore += frames;
        continue;
      }
      kept.add(r);
      framesBefore += frames;
      // the files of the shot, and their frames
      const files: BrowserExportFile[] = [];
      let problem: string | null = null;
      for (const mode of req.modes) {
        const f = r.files.find(
          (x) => x.kind === 'clip' && x.shot === meta.deskShotId && x.pass === MODE_PASS[mode],
        );
        if (!f) problem = `its ${mode} clip is missing`;
        else if (f.frames !== frames)
          problem = `its ${mode} clip has ${f.frames ?? 'no'} frames, not the ${frames} planned`;
        else files.push({ ...f, name: clipName(meta.shotId, mode) });
        if (problem) break;
      }
      if (!problem && req.still) {
        const f = r.files.find((x) => x.kind === 'still' && x.shot === meta.deskShotId);
        if (!f) problem = 'its still is missing';
        else files.push({ ...f, name: stillName(meta.shotId) });
      }
      if (problem) {
        failures.push({
          shotId: meta.shotId,
          code: 'export_failed',
          message: `${meta.shotId}: ${FAILURE_CAUSE.export_failed}: ${problem}.`,
        });
        // a shot left out keeps nothing
        await release(r);
        continue;
      }
      const b = briefShot.get(meta.shotId);
      const issue = b
        ? lengthIssue(frames, b, fps, req.hostName, {
            byBrief: retimed.has(meta.shotId),
            readOnly: req.readOnly,
          })
        : null;
      done.push({
        result: shotResultOf(meta, {
          modes: req.modes,
          still: req.still,
          fps,
          frames,
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
    // the files' bytes, for the host; each shot's engine files go once its bytes are read
    const fileCount = done.reduce((n, d) => n + d.files.length, 0);
    let read = 0;
    progress({ phase: 'encode', done: 0, total: fileCount });
    const files: ResultFile[] = [];
    for (const d of done) {
      for (const f of d.files) {
        if (hooks.signal?.aborted) throw new DeskExportError('cancelled', 'The export was cancelled.');
        const data = await (await f.blob()).arrayBuffer();
        files.push({ name: f.name, mime: f.mime as ResultFile['mime'], data });
        progress({ phase: 'encode', done: ++read, total: fileCount });
      }
      await release(d.engine);
    }
    progress({ phase: 'finish', done: 0, total: 1 });
    return { shots: done.map((d) => d.result), files, failures, release: releaseAll };
  } catch (err) {
    await releaseAll();
    if (err instanceof DeskExportError) throw err;
    throw new DeskExportError('export_failed', errorMessage(err));
  }
}
