import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getDeskSettings, getShots, shotOutputFrames, type SceneDoc, type ShotData } from '@3d-editor/core';
import { dialogProps, serverConfig, session as sessionSignal } from '../../app/store';
import type { ServerConfig } from '../../app/server-config';
import type { ProjectSession } from '../../project/session';
import {
  ApiError,
  PASS_NAMES,
  deleteVideoExport,
  exportFinished,
  getVideoExport,
  isAbort,
  listVideoExports,
  startVideoExport,
  videoExportFileUrl,
  type ExportCodec,
  type ExportFile,
  type ExportJob,
  type ExportLook,
  type ExportQuality,
  type ExportStatus,
  type PassName,
  type VideoExportParams,
} from '../../io/store-client';
import { Checkbox, EnumButtons, NumberField, Row, SelectField, TextField } from '../fields/fields';
import { browserExportSupport, zipExport, type BrowserExportFile } from '../../export';
import { browserJob, cancelBrowserJob, startBrowserJob, type BrowserJob } from './browser-export-job';
import { Modal } from './Dialogs';

/*
 * The Export Video window (SPEC §9, §13; wm.export_video, Render › Export Video…, Ctrl+Shift+F12).
 * By default the export runs on this device (apps/web/src/export): render workers render the
 * project as it is when the export starts and WebCodecs encodes it, with no server; where the
 * editor server can export video (it found ffmpeg) and holds the project, the server is offered as
 * a second choice, which renders the project as the server holds it and encodes it with ffmpeg.
 * Either writes the whole sequence, one frame-exact clip per shot, posters, control passes, a
 * contact sheet and a manifest. This window sets the export's parameters (§9), starts the export,
 * follows it (frames, speed, time left, the shot rendered) with Cancel, then lists the files as
 * download links with a preview of the sequence ("Download all" zips a device export's files).
 * Recent server exports of the project can be opened again or deleted. When this browser cannot
 * export (no secure page, no WebCodecs H.264 encoder) the window says why, and offers the server
 * where it can export. Both exports go on when the window is closed (a device export while the tab
 * stays open); opening the window again follows them again.
 */

/** Seconds a status request waits on the server for the job to change (long poll). */
export const POLL_WAIT_S = 1;
/** Least time between two status requests (a server that answers at once is not hammered). */
export const MIN_POLL_INTERVAL_MS = 500;
/** Status requests that may fail in a row before the window stops following the job. */
const MAX_POLL_FAILURES = 5;

export type ResolutionPreset =
  'scene' | '1280x720' | '1920x1080' | '854x480' | '720x1280' | '1080x1080' | 'custom';

/** The frame sizes offered (the scene's output size first: the server's default). */
export const RESOLUTION_PRESETS: { id: ResolutionPreset; label: string; width?: number; height?: number }[] =
  [
    { id: 'scene', label: 'Scene output size' },
    { id: '1280x720', label: '1280 × 720 (16:9)', width: 1280, height: 720 },
    { id: '1920x1080', label: '1920 × 1080 (16:9)', width: 1920, height: 1080 },
    { id: '854x480', label: '854 × 480 (16:9)', width: 854, height: 480 },
    { id: '720x1280', label: '720 × 1280 (9:16)', width: 720, height: 1280 },
    { id: '1080x1080', label: '1080 × 1080 (1:1)', width: 1080, height: 1080 },
    { id: 'custom', label: 'Custom' },
  ];

/** Largest frame the server exports (video/params.ts). */
export const MAX_EXPORT_WIDTH = 3840;
export const MAX_EXPORT_HEIGHT = 2160;
const MIN_EXPORT_SIDE = 16;
/** Most frames one export may have (video/plan.ts). */
const MAX_EXPORT_FRAMES = 100_000;

export interface ExportOutputs {
  sequence: boolean;
  clips: boolean;
  posters: boolean;
  contact_sheet: boolean;
}

/** What the window's fields hold. */
export interface ExportSettings {
  /** Every enabled shot, the shots ticked, or a frame range (the only choice without shots). */
  shots: 'all' | 'selected' | 'range';
  /** Shot ids ticked for 'selected'. */
  selected: string[];
  /** Range (null: the scene's start and end). */
  frameStart: number | null;
  frameEnd: number | null;
  /** Camera of the range (null: the scene camera). */
  camera: string | null;
  resolution: ResolutionPreset;
  /** Size of 'custom'. */
  width: number;
  height: number;
  /** Frame rate (null: the scene's). */
  fps: number | null;
  quality: ExportQuality;
  look: ExportLook;
  passes: PassName[];
  codec: ExportCodec;
  outputs: ExportOutputs;
  matchModelDuration: boolean;
  label: string;
}

/** What of the project an export depends on. */
export interface ExportContext {
  sceneFps: number;
  frameStart: number;
  frameEnd: number;
  render: { resolution_x: number; resolution_y: number; resolution_percentage: number };
  shots: ShotData[];
  desk: { max_shot_s: number | null; min_shot_s: number | null };
  cameras: { id: string; name: string }[];
  sceneCamera: string | null;
}

/** The export context of a document (shots read through desk/shots.ts). */
export function exportContext(doc: SceneDoc): ExportContext {
  const sc = doc.getScene();
  const rs = doc.getRender();
  const desk = getDeskSettings(doc);
  const cameras: { id: string; name: string }[] = [];
  for (const id of doc.objectIds()) {
    const o = doc.getObject(id);
    if (o?.type === 'CAMERA') cameras.push({ id: o.id, name: o.name });
  }
  cameras.sort((a, b) => a.name.localeCompare(b.name));
  return {
    sceneFps: sc.fps > 0 && Number.isFinite(sc.fps) ? sc.fps : 24,
    frameStart: sc.frame_start,
    frameEnd: sc.frame_end,
    render: {
      resolution_x: rs.resolution_x,
      resolution_y: rs.resolution_y,
      resolution_percentage: rs.resolution_percentage,
    },
    shots: getShots(doc),
    desk: { max_shot_s: desk.max_shot_s, min_shot_s: desk.min_shot_s },
    cameras,
    sceneCamera: sc.camera ?? null,
  };
}

const SETTINGS_KEY = '3d-editor:export-video';

/** The settings a new window starts with (the last ones used, shots and range chosen afresh). */
export function initialSettings(ctx: ExportContext, preselect?: readonly string[]): ExportSettings {
  const enabled = ctx.shots.filter((s) => s.enabled).map((s) => s.id);
  const picked = preselect?.filter((id) => ctx.shots.some((s) => s.id === id)) ?? [];
  const base: ExportSettings = {
    shots: enabled.length ? (picked.length ? 'selected' : 'all') : 'range',
    selected: picked.length ? picked : enabled,
    frameStart: null,
    frameEnd: null,
    camera: null,
    resolution: 'scene',
    width: 1280,
    height: 720,
    fps: null,
    quality: 'standard',
    look: 'material',
    passes: ['beauty'],
    codec: 'h264',
    outputs: { sequence: true, clips: true, posters: true, contact_sheet: true },
    matchModelDuration: false,
    label: '',
  };
  try {
    const kept = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<ExportSettings> | null;
    if (kept && typeof kept === 'object') {
      if (RESOLUTION_PRESETS.some((p) => p.id === kept.resolution)) base.resolution = kept.resolution!;
      if (Number.isFinite(kept.width)) base.width = kept.width!;
      if (Number.isFinite(kept.height)) base.height = kept.height!;
      if (kept.quality === 'draft' || kept.quality === 'standard' || kept.quality === 'high')
        base.quality = kept.quality;
      if (kept.look === 'material' || kept.look === 'clay' || kept.look === 'solid') base.look = kept.look;
      if (Array.isArray(kept.passes)) {
        const passes = PASS_NAMES.filter((p) => kept.passes!.includes(p));
        if (passes.length) base.passes = passes;
      }
      if (kept.codec === 'h264' || kept.codec === 'vp9') base.codec = kept.codec;
      if (kept.outputs && typeof kept.outputs === 'object')
        for (const k of Object.keys(base.outputs) as (keyof ExportOutputs)[])
          if (typeof kept.outputs[k] === 'boolean') base.outputs[k] = kept.outputs[k];
    }
  } catch {
    // private browsing or a damaged entry: the defaults
  }
  return base;
}

/** Remembers the settings that are not about one project (the next window starts with them). */
function keepSettings(s: ExportSettings): void {
  try {
    const { resolution, width, height, quality, look, passes, codec, outputs } = s;
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ resolution, width, height, quality, look, passes, codec, outputs }),
    );
  } catch {
    // not kept
  }
}

/** The mode the settings mean for this project: a range when the project has no enabled shot. */
export function effectiveShotsMode(s: ExportSettings, ctx: ExportContext): ExportSettings['shots'] {
  return ctx.shots.some((x) => x.enabled) ? s.shots : 'range';
}

/** The shots an export of these settings renders, in cut order (none for a range). */
export function chosenShots(s: ExportSettings, ctx: ExportContext): ShotData[] {
  const mode = effectiveShotsMode(s, ctx);
  if (mode === 'all') return ctx.shots.filter((x) => x.enabled);
  if (mode === 'selected') return ctx.shots.filter((x) => s.selected.includes(x.id));
  return [];
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/** The frame size of an export (the server's rule: the scene's output size, else the preset; even). */
export function exportOutputSize(s: ExportSettings, ctx: ExportContext): { width: number; height: number } {
  if (s.resolution === 'scene') {
    const pct = Math.max(1, ctx.render.resolution_percentage || 100) / 100;
    let w = Math.max(1, ctx.render.resolution_x || 1920) * pct;
    let h = Math.max(1, ctx.render.resolution_y || 1080) * pct;
    const scale = Math.min(1, MAX_EXPORT_WIDTH / w, MAX_EXPORT_HEIGHT / h);
    w *= scale;
    h *= scale;
    return { width: Math.min(MAX_EXPORT_WIDTH, even(w)), height: Math.min(MAX_EXPORT_HEIGHT, even(h)) };
  }
  const preset = RESOLUTION_PRESETS.find((p) => p.id === s.resolution);
  if (preset?.width && preset.height) return { width: preset.width, height: preset.height };
  return { width: even(s.width), height: even(s.height) };
}

/** Output frames of `sceneFrames` scene frames at another rate (video/plan.ts). */
function outputFrames(sceneFrames: number, sceneFps: number, fps: number): number {
  return Math.max(1, Math.round((sceneFrames * fps) / sceneFps));
}

/** What an export of these settings writes: frames, length, rate, size and shots. */
export function estimateExport(
  s: ExportSettings,
  ctx: ExportContext,
): { frames: number; seconds: number; fps: number; width: number; height: number; shots: number } {
  const fps = s.fps ?? ctx.sceneFps;
  const { width, height } = exportOutputSize(s, ctx);
  const mode = effectiveShotsMode(s, ctx);
  let frames = 0;
  let shots = 0;
  if (mode === 'range') {
    const start = Math.round(s.frameStart ?? ctx.frameStart);
    const end = Math.round(s.frameEnd ?? ctx.frameEnd);
    frames = end >= start ? outputFrames(end - start + 1, ctx.sceneFps, fps) : 0;
    shots = frames ? 1 : 0;
  } else {
    for (const shot of chosenShots(s, ctx)) {
      let n = outputFrames(shotOutputFrames(shot), ctx.sceneFps, fps);
      if (s.matchModelDuration) {
        const target = Math.min(ctx.desk.max_shot_s ?? Infinity, Math.max(ctx.desk.min_shot_s ?? 0, n / fps));
        n = Math.max(1, Math.round(target * fps));
      }
      frames += n;
      shots++;
    }
  }
  return { frames, seconds: fps > 0 ? frames / fps : 0, fps, width, height, shots };
}

/** Why these settings cannot be exported (null: they can). */
export function exportSettingsProblem(s: ExportSettings, ctx: ExportContext): string | null {
  const mode = effectiveShotsMode(s, ctx);
  if (mode === 'selected' && !chosenShots(s, ctx).length) return 'Tick at least one shot to export.';
  if (mode === 'range') {
    const start = Math.round(s.frameStart ?? ctx.frameStart);
    const end = Math.round(s.frameEnd ?? ctx.frameEnd);
    if (end < start) return `The range ends (frame ${end}) before it starts (frame ${start}).`;
    if (!(s.camera ?? ctx.sceneCamera))
      return 'The scene has no camera: pick one for the range (or add shots in the Director workspace).';
  } else {
    const noCamera = chosenShots(s, ctx).find((x) => !x.camera && !ctx.sceneCamera);
    if (noCamera) return `Shot “${noCamera.name}” has no camera and the scene has none: solve it first.`;
  }
  if (s.resolution === 'custom') {
    const w = even(s.width);
    const h = even(s.height);
    if (w < MIN_EXPORT_SIDE || h < MIN_EXPORT_SIDE || w > MAX_EXPORT_WIDTH || h > MAX_EXPORT_HEIGHT)
      return `The size must be between ${MIN_EXPORT_SIDE} × ${MIN_EXPORT_SIDE} and ${MAX_EXPORT_WIDTH} × ${MAX_EXPORT_HEIGHT} pixels.`;
  }
  const fps = s.fps ?? ctx.sceneFps;
  if (!(fps > 0 && fps <= 120)) return 'The frame rate must be above 0 and at most 120.';
  if (!s.passes.length) return 'Tick at least one pass.';
  if (!Object.values(s.outputs).some(Boolean)) return 'Tick at least one output.';
  const { frames } = estimateExport(s, ctx);
  if (frames > MAX_EXPORT_FRAMES)
    return `The export would have ${frames} frames (at most ${MAX_EXPORT_FRAMES}).`;
  return null;
}

/** The body of POST …/video-exports for these settings (defaults left to the server). */
export function buildExportParams(s: ExportSettings, ctx: ExportContext): VideoExportParams {
  const params: VideoExportParams = {
    quality: s.quality,
    look: s.look,
    passes: PASS_NAMES.filter((p) => s.passes.includes(p)),
    codec: s.codec,
    outputs: { ...s.outputs },
  };
  const mode = effectiveShotsMode(s, ctx);
  if (mode === 'all') params.shots = 'all';
  else if (mode === 'selected') params.shots = chosenShots(s, ctx).map((x) => x.id);
  else {
    params.frame_start = Math.round(s.frameStart ?? ctx.frameStart);
    params.frame_end = Math.round(s.frameEnd ?? ctx.frameEnd);
    if (s.camera) params.camera = s.camera;
  }
  if (s.resolution !== 'scene') {
    const { width, height } = exportOutputSize(s, ctx);
    params.width = width;
    params.height = height;
  }
  if (s.fps !== null && s.fps !== ctx.sceneFps) params.fps = s.fps;
  if (s.matchModelDuration && mode !== 'range') params.match_model_duration = true;
  const label = s.label.trim();
  if (label) params.label = label.slice(0, 200);
  return params;
}

/**
 * Why the editor server cannot export this project (null: it can): no server, an old one, one
 * without ffmpeg, or a project it does not hold (kept only in this browser).
 */
export function serverExportReason(cfg: ServerConfig | null, onServer: boolean): string | null {
  if (!cfg) return 'This editor runs without its server.';
  if (cfg.features.videoExport === undefined)
    return 'This editor server is too old to export video: update it.';
  if (!cfg.features.videoExport)
    return (
      'The editor server cannot export video: it did not find ffmpeg. Install ffmpeg on the server ' +
      '(or set FFMPEG_PATH) and restart it.'
    );
  if (!onServer)
    return 'The server exports the projects it holds, and this project is kept only in this browser.';
  return null;
}

/** Whether the server holds the project (it syncs with it). */
export function projectOnServer(session: Pick<ProjectSession, 'provider'>): boolean {
  return !!session.provider?.enabled;
}

/** A length in seconds: "4.5 s" under a minute, else "1:05" or "1:02:05". */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** A file size: "512 B", "12.3 KB", "4.1 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** An export's files by what they are. */
export interface ExportFileGroups {
  sequence: ExportFile[];
  clips: ExportFile[];
  posters: ExportFile[];
  passes: ExportFile[];
  contactSheet: ExportFile[];
  manifest: ExportFile[];
}

export function groupExportFiles(files: readonly ExportFile[]): ExportFileGroups {
  const g: ExportFileGroups = {
    sequence: [],
    clips: [],
    posters: [],
    passes: [],
    contactSheet: [],
    manifest: [],
  };
  for (const f of files) {
    if (f.kind === 'sequence') g.sequence.push(f);
    else if (f.kind === 'clip') g.clips.push(f);
    else if (f.kind === 'poster') g.posters.push(f);
    else if (f.kind === 'pass') g.passes.push(f);
    else if (f.kind === 'contact_sheet') g.contactSheet.push(f);
    else if (f.kind === 'manifest') g.manifest.push(f);
  }
  return g;
}

/** The video the window previews: the sequence, else the first beauty clip, else any video. */
export function previewFile(files: readonly ExportFile[]): ExportFile | null {
  const video = (f: ExportFile) => /\.(mp4|webm)$/i.test(f.name);
  return (
    files.find((f) => f.kind === 'sequence' && video(f)) ??
    files.find((f) => f.kind === 'clip' && (f.pass ?? 'beauty') === 'beauty' && video(f)) ??
    files.find(video) ??
    null
  );
}

/** What an export's status says. */
export function jobStatusText(job: ExportJob, shotName: (id: string) => string): string {
  const p = job.progress;
  switch (job.status) {
    case 'queued':
      return 'Waiting for the exports before it…';
    case 'running': {
      const parts = [`Rendering frame ${Math.min(p.frames_done + 1, p.frames_total)} of ${p.frames_total}`];
      if (p.fps > 0) parts.push(`${p.fps.toFixed(p.fps < 10 ? 1 : 0)} frames/s`);
      if (p.eta_s !== null && p.eta_s !== undefined) parts.push(`about ${formatSeconds(p.eta_s)} left`);
      if (p.shot) parts.push(`shot ${shotName(p.shot)}`);
      return parts.join(' · ');
    }
    case 'encoding':
      return 'Encoding the videos…';
    case 'done':
      return `Done: ${p.frames_total} frames`;
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return `Failed: ${job.error ?? 'unknown error'}`;
  }
}

/** How long the export ran: "took 29.0 s" once done, "after …" when stopped, "… so far" while it runs. */
export function elapsedText(status: ExportStatus, seconds: number): string {
  const t = formatSeconds(seconds);
  if (status === 'done') return `took ${t}`;
  return exportFinished(status) ? `after ${t}` : `${t} so far`;
}

/** The message of a failed request (with what a missing project means). */
function requestMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'NOT_FOUND' && /project/i.test(err.message))
      return `${err.message}. The server exports projects it holds: a project kept only in this browser is not there.`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Follows a job until it ends: status requests that wait up to POLL_WAIT_S on the server, at least
 * MIN_POLL_INTERVAL_MS apart, retried after failures (MAX_POLL_FAILURES in a row stop it).
 */
export function useExportPolling(
  project: string | null,
  job: ExportJob | null,
  onJob: (job: ExportJob) => void,
  onError: (message: string) => void,
): void {
  const handlers = useRef({ onJob, onError });
  handlers.current = { onJob, onError };
  const active = !!job && !exportFinished(job.status);
  const id = job?.id ?? null;
  useEffect(() => {
    if (!project || !id || !active) return;
    const ctrl = new AbortController();
    void (async () => {
      let failures = 0;
      while (!ctrl.signal.aborted) {
        const t0 = Date.now();
        try {
          const j = await getVideoExport(project, id, { waitS: POLL_WAIT_S, signal: ctrl.signal });
          if (ctrl.signal.aborted) return;
          failures = 0;
          handlers.current.onJob(j);
          if (exportFinished(j.status)) return;
        } catch (err) {
          if (isAbort(err) || ctrl.signal.aborted) return;
          if (++failures >= MAX_POLL_FAILURES) {
            handlers.current.onError(`Lost track of the export: ${requestMessage(err)}`);
            return;
          }
          await sleep(1000 * failures, ctrl.signal);
          continue;
        }
        const left = MIN_POLL_INTERVAL_MS - (Date.now() - t0);
        if (left > 0) await sleep(left, ctrl.signal);
      }
    })();
    return () => ctrl.abort();
  }, [project, id, active]);
}

/** Re-renders every `ms` while `active` (elapsed time). */
function useTicker(active: boolean, ms = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(h);
  }, [active, ms]);
}

function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      data-testid="export-video-progress"
      style={{
        height: '6px',
        background: 'var(--bg-input-dark)',
        borderRadius: '3px',
        overflow: 'hidden',
        margin: '8px 0 4px',
      }}
    >
      <div
        style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 200ms' }}
      />
    </div>
  );
}

const QUALITY_TITLES: Record<ExportQuality, string> = {
  draft: 'Fastest: 1 sample, shadows, no ambient occlusion, CRF 28',
  standard: '2 samples, shadows and ambient occlusion, CRF 23',
  high: '4 samples up to 1280×720 (else 2), CRF 18, slower encoding',
};

const PASS_TITLES: Record<PassName, string> = {
  beauty: 'The picture',
  depth: 'Distance from the camera (near bright)',
  normal: 'Surface directions in view space',
  mask: 'One flat colour per object',
  edges: 'Outlines, black on white',
  pose: 'Skeletons of the actors (OpenPose colours)',
};

const OUTPUT_LABELS: Record<keyof ExportOutputs, string> = {
  sequence: 'Whole sequence',
  clips: 'One clip per shot',
  posters: 'Posters (first frames)',
  contact_sheet: 'Contact sheet',
};

/** Where an export runs: this device (the default), or the editor server. */
export type ExportWhere = 'device' | 'server';

/** Whether this browser can export a video of this size and rate (null while it is asked). */
function useBrowserSupport(
  width: number,
  height: number,
  fps: number,
): { available: boolean; reason: string | null } | null {
  const key = `${width}x${height}@${fps}`;
  const [state, setState] = useState<{
    key: string;
    value: { available: boolean; reason: string | null };
  } | null>(null);
  useEffect(() => {
    let live = true;
    void browserExportSupport({ width, height, fps }).then((value) => {
      if (live) setState({ key, value });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state?.key === key ? state.value : null;
}

/** Ctrl+Shift+F12: the Export Video window. */
export function ExportVideoDialog() {
  const s = sessionSignal.value;
  if (!s)
    return (
      <Modal title="Export Video" width="min(560px, 96vw)" testId="export-video-dialog">
        <div class="hint" style={{ fontSize: '12px' }} data-testid="export-video-unavailable">
          Open a project first: the export renders its shots.
        </div>
      </Modal>
    );
  const preselect = Array.isArray(dialogProps.value.shots)
    ? (dialogProps.value.shots as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  return <ExportVideoPanel session={s} preselect={preselect} />;
}

function ExportVideoPanel({ session, preselect }: { session: ProjectSession; preselect?: string[] }) {
  // follow edits of the project (an agent adds shots while the window is open)
  void session.revision.value;
  const ctx = exportContext(session.doc);
  const project = session.id;
  const cfg = serverConfig.value;
  const onServer = projectOnServer(session);
  const serverOk = serverExportReason(cfg, onServer) === null;
  // the server's exports of the project are listed where it exports video (or did: ffmpeg may be gone)
  const listed = !!cfg && cfg.features.videoExport !== undefined && onServer;
  const [settings, setSettingsState] = useState<ExportSettings>(() => initialSettings(ctx, preselect));
  const [whereChosen, setWhere] = useState<ExportWhere>('device');
  const where: ExportWhere = serverOk ? whereChosen : 'device';
  const [job, setJob] = useState<ExportJob | null>(null);
  const device = browserJob.value?.project === project ? browserJob.value : null;
  // the export shown: one on this device (its job runs in the page), one on the server, or none
  const [showJob, setShowJob] = useState<ExportWhere | null>(() => (device ? 'device' : null));
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const set = (patch: Partial<ExportSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      keepSettings(next);
      return next;
    });
  };

  // an export of this project that still runs on the server: follow it
  useEffect(() => {
    if (!listed) return;
    const ctrl = new AbortController();
    listVideoExports(project, ctrl.signal)
      .then((list) => {
        const active = list.find((j) => !exportFinished(j.status));
        if (active && !ctrl.signal.aborted) {
          setJob((cur) => cur ?? active);
          setShowJob((cur) => cur ?? 'server');
        }
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [project, listed]);

  /** Exports cancelled here: a status answer sent before the cancel took effect is stale. */
  const cancelled = useRef(new Set<string>());
  const onJob = useCallback((j: ExportJob) => {
    if (cancelled.current.has(j.id) && !exportFinished(j.status)) return;
    setJob((cur) => (cur && cur.id !== j.id ? cur : j));
    if (exportFinished(j.status)) setRefresh((n) => n + 1);
  }, []);
  useExportPolling(listed ? project : null, job, onJob, setError);
  const serverRunning = !!job && !exportFinished(job.status);
  const deviceRunning = device?.status === 'running';
  useTicker(serverRunning || deviceRunning);

  const shotName = (id: string) =>
    ctx.shots.find((x) => x.id === id)?.name ?? (id === 'range' ? 'Frame range' : id);
  const problem = exportSettingsProblem(settings, ctx);
  const est = estimateExport(settings, ctx);
  const support = useBrowserSupport(est.width, est.height, est.fps);
  const deviceBlocked = where === 'device' && !support?.available;

  const startOnServer = async () => {
    const j = await startVideoExport(project, buildExportParams(settings, ctx));
    setJob(j);
    setShowJob('server');
    setRefresh((n) => n + 1);
  };
  const start = async () => {
    if (problem || starting || deviceBlocked) return;
    setStarting(true);
    setError(null);
    try {
      if (where === 'server') await startOnServer();
      else {
        const params = buildExportParams(settings, ctx);
        const label = settings.label.trim() || null;
        setShowJob('device');
        // the export runs in the page (browserJob follows it): not awaited here
        void startBrowserJob(session, params, label).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          setShowJob(null);
        });
      }
    } catch (err) {
      setError(requestMessage(err));
    } finally {
      setStarting(false);
    }
  };
  const cancel = async () => {
    if (showJob === 'device') return cancelBrowserJob();
    if (!job) return;
    setCancelling(true);
    try {
      const j = await deleteVideoExport(project, job.id);
      cancelled.current.add(j.id);
      setJob({ ...j, status: exportFinished(j.status) ? j.status : 'cancelled', files: [] });
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(requestMessage(err));
    } finally {
      setCancelling(false);
    }
  };
  const open = (j: ExportJob) => {
    setJob(j);
    setShowJob('server');
    setError(null);
  };

  const shown = showJob === 'device' ? device : showJob === 'server' ? job : null;
  const running = showJob === 'device' ? deviceRunning : serverRunning;
  const footer = shown ? (
    running ? (
      <button
        class="btn"
        data-testid="export-video-cancel"
        disabled={cancelling}
        title={
          showJob === 'device'
            ? 'Stop the export and delete what it wrote'
            : 'Stop the export on the server and delete what it wrote'
        }
        onClick={() => void cancel()}
      >
        {cancelling ? 'Cancelling…' : 'Cancel Export'}
      </button>
    ) : (
      <button class="btn" data-testid="export-video-new" onClick={() => setShowJob(null)}>
        New Export
      </button>
    )
  ) : (
    <>
      <span class="hint" style={{ marginRight: 'auto' }} data-testid="export-video-estimate">
        {est.frames} frame{est.frames === 1 ? '' : 's'} · {formatSeconds(est.seconds)} at{' '}
        {Math.round(est.fps * 100) / 100} fps · {est.width} × {est.height}
        {est.shots > 1 ? ` · ${est.shots} shots` : ''}
      </span>
      <button
        class="btn primary"
        data-testid="export-video-start"
        disabled={!!problem || starting || deviceBlocked || (where === 'device' && deviceRunning)}
        title={
          problem ??
          (where === 'device'
            ? deviceRunning
              ? 'An export runs on this device: wait for it, or cancel it'
              : (support?.reason ?? 'Export on this device')
            : 'Export on the server')
        }
        onClick={() => void start()}
      >
        {starting ? 'Starting…' : 'Export'}
      </button>
    </>
  );

  return (
    <Modal title="Export Video" width="min(760px, 96vw)" testId="export-video-dialog" footer={footer}>
      {showJob === 'device' && device ? (
        <BrowserJobView job={device} shotName={shotName} />
      ) : showJob === 'server' && job ? (
        <JobView job={job} shotName={shotName} />
      ) : (
        <SettingsForm
          settings={settings}
          ctx={ctx}
          set={set}
          problem={problem}
          where={where}
          serverOk={serverOk}
          setWhere={setWhere}
          support={support}
        />
      )}
      {error && (
        <div class="error-text" role="alert" data-testid="export-video-error" style={{ marginTop: '6px' }}>
          {error}
        </div>
      )}
      {listed && (
        <RecentExports
          project={project}
          shotName={shotName}
          onOpen={open}
          onDeleted={(id) => {
            if (job?.id !== id) return;
            setJob(null);
            if (showJob === 'server') setShowJob(null);
          }}
          refresh={refresh}
          current={showJob === 'server' ? job?.id : undefined}
        />
      )}
    </Modal>
  );
}

function SettingsForm({
  settings: s,
  ctx,
  set,
  problem,
  where,
  serverOk,
  setWhere,
  support,
}: {
  settings: ExportSettings;
  ctx: ExportContext;
  set: (patch: Partial<ExportSettings>) => void;
  problem: string | null;
  where: ExportWhere;
  /** The server can export the project too (it is offered). */
  serverOk: boolean;
  setWhere: (w: ExportWhere) => void;
  /** Whether this browser can export (null while it is asked). */
  support: { available: boolean; reason: string | null } | null;
}) {
  const hasShots = ctx.shots.some((x) => x.enabled);
  const mode = effectiveShotsMode(s, ctx);
  const enabledCount = ctx.shots.filter((x) => x.enabled).length;
  const size = exportOutputSize(s, ctx);
  return (
    <div data-testid="export-video-settings" style={{ maxWidth: '560px', margin: '0 auto' }}>
      {serverOk && (
        <Row label="Export On">
          <EnumButtons
            value={where}
            testId="export-video-where"
            options={[
              { value: 'device', label: 'This device' },
              { value: 'server', label: 'Server' },
            ]}
            onChange={setWhere}
          />
        </Row>
      )}
      {where === 'device' && support && !support.available && (
        <div
          class="error-text"
          data-testid="export-video-browser-unsupported"
          style={{ margin: '4px 0 8px' }}
        >
          {support.reason}
          {serverOk && (
            <>
              {' '}
              <button
                class="btn flat"
                data-testid="export-video-use-server"
                onClick={() => setWhere('server')}
              >
                Export on the server instead
              </button>
            </>
          )}
        </div>
      )}
      {hasShots && (
        <Row label="Shots">
          <EnumButtons
            value={mode}
            testId="export-video-shots"
            options={[
              { value: 'all', label: `All (${enabledCount})` },
              { value: 'selected', label: 'Selected' },
              { value: 'range', label: 'Frame range' },
            ]}
            onChange={(v) => set({ shots: v })}
          />
        </Row>
      )}
      {mode === 'selected' && (
        <div
          data-testid="export-video-shot-list"
          style={{ margin: '2px 0 6px 40%', maxHeight: '160px', overflow: 'auto' }}
        >
          {ctx.shots.map((x) => (
            <div key={x.id}>
              <Checkbox
                value={s.selected.includes(x.id)}
                label={`${x.name} · ${shotOutputFrames(x)} frames${x.enabled ? '' : ' (disabled)'}`}
                testId={`export-video-shot-${x.id}`}
                onChange={(v) =>
                  set({
                    selected: v
                      ? [...s.selected.filter((id) => id !== x.id), x.id]
                      : s.selected.filter((id) => id !== x.id),
                  })
                }
              />
            </div>
          ))}
        </div>
      )}
      {mode === 'range' && (
        <>
          {!hasShots && (
            <div class="hint" data-testid="export-video-no-shots">
              The scene has no shots: a frame range is exported through one camera.
            </div>
          )}
          <Row label="Frame Start">
            <NumberField
              value={s.frameStart ?? ctx.frameStart}
              integer
              step={1}
              testId="export-video-frame-start"
              onChange={(v) => set({ frameStart: v })}
            />
          </Row>
          <Row label="End">
            <NumberField
              value={s.frameEnd ?? ctx.frameEnd}
              integer
              step={1}
              testId="export-video-frame-end"
              onChange={(v) => set({ frameEnd: v })}
            />
          </Row>
          <Row label="Camera">
            <SelectField
              value={s.camera ?? ''}
              testId="export-video-camera"
              options={[
                {
                  value: '',
                  label: `Scene camera${ctx.sceneCamera ? ` (${ctx.cameras.find((c) => c.id === ctx.sceneCamera)?.name ?? '?'})` : ' (none)'}`,
                },
                ...ctx.cameras.map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={(v) => set({ camera: v || null })}
            />
          </Row>
        </>
      )}
      <Row label="Resolution">
        <SelectField
          value={s.resolution}
          testId="export-video-resolution"
          options={RESOLUTION_PRESETS.map((p) => ({
            value: p.id,
            label:
              p.id === 'scene'
                ? `Scene output (${exportOutputSize({ ...s, resolution: 'scene' }, ctx).width} × ${exportOutputSize({ ...s, resolution: 'scene' }, ctx).height})`
                : p.label,
          }))}
          onChange={(v) => set({ resolution: v })}
        />
      </Row>
      {s.resolution === 'custom' && (
        <>
          <Row label="Width">
            <NumberField
              value={s.width}
              integer
              min={MIN_EXPORT_SIDE}
              max={MAX_EXPORT_WIDTH}
              step={2}
              unit=" px"
              testId="export-video-width"
              onChange={(v) => set({ width: v })}
            />
          </Row>
          <Row label="Height">
            <NumberField
              value={s.height}
              integer
              min={MIN_EXPORT_SIDE}
              max={MAX_EXPORT_HEIGHT}
              step={2}
              unit=" px"
              testId="export-video-height"
              onChange={(v) => set({ height: v })}
            />
          </Row>
          {(s.width % 2 !== 0 || s.height % 2 !== 0) && (
            <div class="hint" style={{ marginLeft: '40%' }}>
              Video frames have even sides: {size.width} × {size.height} is exported.
            </div>
          )}
        </>
      )}
      <Row label="Frame Rate" title="Frames per second (the scene's rate unless changed)">
        <NumberField
          value={s.fps ?? ctx.sceneFps}
          min={1}
          max={120}
          step={1}
          unit=" fps"
          testId="export-video-fps"
          onChange={(v) => set({ fps: v })}
        />
      </Row>
      <Row label="Quality">
        <EnumButtons
          value={s.quality}
          testId="export-video-quality"
          title={QUALITY_TITLES[s.quality]}
          options={[
            { value: 'draft', label: 'Draft' },
            { value: 'standard', label: 'Standard' },
            { value: 'high', label: 'High' },
          ]}
          onChange={(v) => set({ quality: v })}
        />
      </Row>
      <Row label="Look">
        <EnumButtons
          value={s.look}
          testId="export-video-look"
          options={[
            { value: 'material', label: 'Material' },
            { value: 'clay', label: 'Clay' },
            { value: 'solid', label: 'Solid' },
          ]}
          onChange={(v) => set({ look: v })}
        />
      </Row>
      <Row label="Passes" title="Each pass is its own video">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {PASS_NAMES.map((p) => (
            <span key={p} title={PASS_TITLES[p]}>
              <Checkbox
                value={s.passes.includes(p)}
                label={p[0].toUpperCase() + p.slice(1)}
                testId={`export-video-pass-${p}`}
                onChange={(v) =>
                  set({
                    passes: v
                      ? PASS_NAMES.filter((x) => x === p || s.passes.includes(x))
                      : s.passes.filter((x) => x !== p),
                  })
                }
              />
            </span>
          ))}
        </div>
      </Row>
      <Row label="Codec">
        <EnumButtons
          value={s.codec}
          testId="export-video-codec"
          options={[
            { value: 'h264', label: 'H.264 (MP4)' },
            { value: 'vp9', label: 'VP9 (WebM)' },
          ]}
          onChange={(v) => set({ codec: v })}
        />
      </Row>
      <Row label="Outputs">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          {(Object.keys(OUTPUT_LABELS) as (keyof ExportOutputs)[]).map((k) => (
            <Checkbox
              key={k}
              value={s.outputs[k]}
              label={OUTPUT_LABELS[k]}
              testId={`export-video-output-${k}`}
              onChange={(v) => set({ outputs: { ...s.outputs, [k]: v } })}
            />
          ))}
        </div>
      </Row>
      {mode !== 'range' && (
        <Row label="" title="Pad or trim each clip to the video model's duration limits (desk settings)">
          <Checkbox
            value={s.matchModelDuration}
            label={
              ctx.desk.max_shot_s !== null || ctx.desk.min_shot_s !== null
                ? `Match the video model's take length (${ctx.desk.min_shot_s ?? 0}–${ctx.desk.max_shot_s ?? '∞'} s)`
                : "Match the video model's take length (none set)"
            }
            testId="export-video-match-duration"
            onChange={(v) => set({ matchModelDuration: v })}
          />
        </Row>
      )}
      <Row label="Name">
        <TextField
          value={s.label}
          placeholder="Optional"
          testId="export-video-label"
          ariaLabel="Export name"
          onChange={(v) => set({ label: v })}
        />
      </Row>
      {problem && (
        <div class="error-text" data-testid="export-video-problem" style={{ marginTop: '4px' }}>
          {problem}
        </div>
      )}
      <div class="hint" style={{ marginTop: '6px' }} data-testid="export-video-where-hint">
        {where === 'device'
          ? 'This device renders the project as it is when the export starts, in render workers (one to two ' +
            'seconds per 1280 × 720 frame on each core, draft to standard quality), and encodes the videos; ' +
            'it goes on when this window is closed, as long as this tab stays open.'
          : 'The server renders the project as it holds it when the export starts; it goes on when this ' +
            'window is closed.'}
      </div>
    </div>
  );
}

/** A running or finished export: progress, then the files with a preview of the sequence. */
function JobView({ job, shotName }: { job: ExportJob; shotName: (id: string) => string }) {
  const p = job.progress;
  const finished = exportFinished(job.status);
  const started = job.started_at ? Date.parse(job.started_at) : NaN;
  const ended = job.finished_at ? Date.parse(job.finished_at) : Date.now();
  // a running job's time is the server's start against this browser's clock: never below 0
  const elapsed = Number.isFinite(started) ? Math.max(0, (ended - started) / 1000) : null;
  const preview = job.status === 'done' ? previewFile(job.files) : null;
  return (
    <div data-testid="export-video-job" data-status={job.status}>
      <div style={{ fontWeight: 600 }}>
        {job.label ?? `Export of ${new Date(job.created_at).toLocaleString()}`}
      </div>
      {!finished && (
        <ProgressBar fraction={job.status === 'encoding' ? 1 : p.fraction} label="Export progress" />
      )}
      <div
        class={job.status === 'failed' ? 'error-text' : 'hint'}
        data-testid="export-video-status"
        style={{ fontSize: '12px' }}
      >
        {jobStatusText(job, shotName)}
        {elapsed !== null && job.status !== 'queued' ? ` · ${elapsedText(job.status, elapsed)}` : ''}
      </div>
      {job.warnings.length > 0 && (
        <ul class="hint" data-testid="export-video-warnings" style={{ margin: '4px 0', paddingLeft: '18px' }}>
          {job.warnings.slice(0, 8).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {preview && (
        <video
          key={preview.url}
          src={videoExportFileUrl(preview)}
          controls
          muted
          playsInline
          preload="metadata"
          data-testid="export-video-preview"
          style={{
            width: '100%',
            maxHeight: '42vh',
            background: '#000',
            borderRadius: '4px',
            margin: '8px 0',
          }}
        />
      )}
      {job.status === 'done' && <FileList files={job.files} shotName={shotName} />}
    </div>
  );
}

/** The files of a finished export as download links, by kind. */
function FileList({ files, shotName }: { files: ExportFile[]; shotName: (id: string) => string }) {
  const g = groupExportFiles(files);
  const sections: [string, ExportFile[]][] = [
    ['Sequence', g.sequence],
    ['Clips', g.clips],
    ['Posters', g.posters],
    ['Passes', g.passes],
    ['Contact sheet', g.contactSheet],
    ['Manifest', g.manifest],
  ];
  return (
    <div data-testid="export-video-files">
      {sections
        .filter(([, list]) => list.length)
        .map(([title, list]) => (
          <div key={title} style={{ marginTop: '6px' }}>
            <div class="hint" style={{ fontWeight: 600 }}>
              {title}
            </div>
            {list.map((f) => (
              <div key={f.name} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                <a
                  href={videoExportFileUrl(f)}
                  download={f.name}
                  data-testid={`export-video-file-${f.name}`}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {f.name}
                </a>
                <span class="hint">
                  {[
                    f.shot && f.shot !== 'range' ? shotName(f.shot) : null,
                    f.pass && f.pass !== 'beauty' ? f.pass : null,
                    f.frames ? `${f.frames} frames` : null,
                    f.duration_s ? formatSeconds(f.duration_s) : null,
                    formatBytes(f.bytes),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/** A device export's files by what they are. */
export interface BrowserFileGroups {
  sequence: BrowserExportFile[];
  clips: BrowserExportFile[];
  posters: BrowserExportFile[];
  stills: BrowserExportFile[];
  passes: BrowserExportFile[];
  contactSheet: BrowserExportFile[];
  manifest: BrowserExportFile[];
}

export function groupBrowserFiles(files: readonly BrowserExportFile[]): BrowserFileGroups {
  const g: BrowserFileGroups = {
    sequence: [],
    clips: [],
    posters: [],
    stills: [],
    passes: [],
    contactSheet: [],
    manifest: [],
  };
  for (const f of files) {
    if (f.kind === 'sequence' && f.pass === 'beauty') g.sequence.push(f);
    else if (f.kind === 'sequence' || f.kind === 'frames') g.passes.push(f);
    else if (f.kind === 'clip') g.clips.push(f);
    else if (f.kind === 'poster') g.posters.push(f);
    else if (f.kind === 'still') g.stills.push(f);
    else if (f.kind === 'contact_sheet') g.contactSheet.push(f);
    else if (f.kind === 'manifest') g.manifest.push(f);
  }
  return g;
}

/** The video a device export's window previews: the sequence, else the first beauty clip. */
export function browserPreviewFile(files: readonly BrowserExportFile[]): BrowserExportFile | null {
  return (
    files.find((f) => f.kind === 'sequence' && f.pass === 'beauty') ??
    files.find((f) => f.kind === 'clip' && f.pass === 'beauty') ??
    null
  );
}

/** What a device export's state says. */
export function browserJobStatusText(job: BrowserJob, shotName: (id: string) => string): string {
  const p = job.progress;
  switch (job.status) {
    case 'running': {
      if (!p || p.phase === 'prepare') return 'Preparing the render workers…';
      if (p.phase === 'encode') return 'Finishing the videos…';
      if (p.phase === 'finish') return 'Writing the contact sheet and the manifest…';
      const parts = [`Rendering frame ${Math.min(p.done + 1, p.total)} of ${p.total}`];
      if (job.fps > 0) {
        parts.push(`${job.fps.toFixed(job.fps < 10 ? 1 : 0)} frames/s`);
        parts.push(`about ${formatSeconds((p.total - p.done) / job.fps)} left`);
      }
      if (p.shot) parts.push(`shot ${shotName(p.shot)}`);
      return parts.join(' · ');
    }
    case 'done': {
      const frames = (job.result?.manifest as { frames?: unknown } | null)?.frames;
      return `Done: ${typeof frames === 'number' ? frames : (p?.total ?? 0)} frames`;
    }
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return `Failed: ${job.error ?? 'unknown error'}`;
  }
}

/** A file name of the project's title ('Kite Day' → 'kite-day'). */
function fileBase(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'export';
}

/** Saves a Blob as a download named `name`. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // the download has read the URL by then
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** An export running or done on this device: progress, then its files with a preview and one zip of all. */
function BrowserJobView({ job, shotName }: { job: BrowserJob; shotName: (id: string) => string }) {
  const finished = job.status !== 'running';
  const elapsed = Math.max(0, ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
  const p = job.progress;
  const fraction =
    !p || p.phase === 'prepare' ? 0 : p.phase === 'render' ? (p.total ? p.done / p.total : 1) : 1;
  const result = job.status === 'done' ? job.result : null;
  const preview = result ? browserPreviewFile(result.files) : null;
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const downloadAll = async () => {
    if (!result) return;
    setZipping(true);
    setZipError(null);
    try {
      const name = (result.manifest as { project?: { name?: string } } | null)?.project?.name ?? 'export';
      saveBlob(await zipExport(result), `${fileBase(name)}-export.zip`);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : String(err));
    } finally {
      setZipping(false);
    }
  };
  return (
    <div data-testid="export-video-job" data-status={job.status} data-where="device">
      <div style={{ fontWeight: 600 }}>{job.label ?? 'Export on this device'}</div>
      {!finished && <ProgressBar fraction={fraction} label="Export progress" />}
      <div
        class={job.status === 'failed' ? 'error-text' : 'hint'}
        data-testid="export-video-status"
        style={{ fontSize: '12px' }}
      >
        {browserJobStatusText(job, shotName)} · {elapsedText(job.status, elapsed)}
      </div>
      {result && result.warnings.length > 0 && (
        <ul class="hint" data-testid="export-video-warnings" style={{ margin: '4px 0', paddingLeft: '18px' }}>
          {result.warnings.slice(0, 8).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {preview && job.urls[preview.name] && (
        <video
          key={job.urls[preview.name]}
          src={job.urls[preview.name]}
          controls
          muted
          playsInline
          preload="metadata"
          data-testid="export-video-preview"
          style={{
            width: '100%',
            maxHeight: '42vh',
            background: '#000',
            borderRadius: '4px',
            margin: '8px 0',
          }}
        />
      )}
      {result && (
        <>
          <button
            class="btn"
            data-testid="export-video-download-all"
            disabled={zipping}
            title="Every file of the export in one ZIP archive"
            onClick={() => void downloadAll()}
          >
            {zipping ? 'Packing…' : 'Download all (.zip)'}
          </button>
          {zipError && <div class="error-text">{zipError}</div>}
          <BrowserFileList files={result.files} urls={job.urls} shotName={shotName} />
        </>
      )}
    </div>
  );
}

/** The files of a device export as download links, by kind. */
function BrowserFileList({
  files,
  urls,
  shotName,
}: {
  files: BrowserExportFile[];
  urls: Record<string, string>;
  shotName: (id: string) => string;
}) {
  const g = groupBrowserFiles(files);
  const sections: [string, BrowserExportFile[]][] = [
    ['Sequence', g.sequence],
    ['Clips', g.clips],
    ['Posters', g.posters],
    ['Stills', g.stills],
    ['Passes', g.passes],
    ['Contact sheet', g.contactSheet],
    ['Manifest', g.manifest],
  ];
  return (
    <div data-testid="export-video-files">
      {sections
        .filter(([, list]) => list.length)
        .map(([title, list]) => (
          <div key={title} style={{ marginTop: '6px' }}>
            <div class="hint" style={{ fontWeight: 600 }}>
              {title}
            </div>
            {list.map((f) => (
              <div key={f.name} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                <a
                  href={urls[f.name]}
                  download={f.name}
                  data-testid={`export-video-file-${f.name}`}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {f.name}
                </a>
                <span class="hint">
                  {[
                    f.shot && f.shot !== 'range' ? shotName(f.shot) : null,
                    f.pass && f.pass !== 'beauty' ? f.pass : null,
                    f.kind === 'frames' ? 'PNG frames' : null,
                    f.frames ? `${f.frames} frames` : null,
                    f.duration_s ? formatSeconds(f.duration_s) : null,
                    formatBytes(f.size),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/** The project's exports, newest first: open one again, or delete it (two clicks). */
function RecentExports({
  project,
  shotName,
  onOpen,
  onDeleted,
  refresh,
  current,
}: {
  project: string;
  shotName: (id: string) => string;
  onOpen: ((job: ExportJob) => void) | null;
  onDeleted?: (id: string) => void;
  refresh: number;
  current?: string;
}) {
  const [list, setList] = useState<ExportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [own, setOwn] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    listVideoExports(project, ctrl.signal)
      .then((l) => {
        if (ctrl.signal.aborted) return;
        setList(l);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!isAbort(err) && !ctrl.signal.aborted) setError(requestMessage(err));
      });
    return () => ctrl.abort();
  }, [project, refresh, own]);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  if (!list && !error) return null;
  const remove = async (j: ExportJob) => {
    if (confirm !== j.id) return setConfirm(j.id);
    setConfirm(null);
    try {
      await deleteVideoExport(project, j.id);
      onDeleted?.(j.id);
    } catch (err) {
      setError(requestMessage(err));
    }
    setOwn((n) => n + 1);
  };
  return (
    <div
      data-testid="export-video-recent"
      style={{ marginTop: '12px', borderTop: '1px solid var(--border-light)', paddingTop: '6px' }}
    >
      <div class="hint" style={{ fontWeight: 600 }}>
        Recent exports
      </div>
      {error && <div class="error-text">{error}</div>}
      {list && list.length === 0 && <div class="hint">None yet.</div>}
      <div style={{ maxHeight: '150px', overflow: 'auto' }}>
        {list?.slice(0, 20).map((j) => {
          const bytes = j.files.reduce((n, f) => n + f.bytes, 0);
          const shots = Array.isArray(j.params.shots) ? j.params.shots.map(shotName).join(', ') : null;
          return (
            <div
              key={j.id}
              data-testid={`export-video-recent-${j.id}`}
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                padding: '2px 0',
                fontWeight: j.id === current ? 600 : undefined,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {j.label ?? new Date(j.created_at).toLocaleString()}
                {shots ? ` · ${shots}` : ''}
              </span>
              <span class="badge" data-status={j.status}>
                {j.status}
              </span>
              <span class="hint" style={{ minWidth: '64px', textAlign: 'right' }}>
                {j.status === 'done'
                  ? formatBytes(bytes)
                  : `${j.progress.frames_done}/${j.progress.frames_total}`}
              </span>
              {onOpen && (
                <button class="btn flat" data-testid={`export-video-open-${j.id}`} onClick={() => onOpen(j)}>
                  Show
                </button>
              )}
              <button
                class={`btn flat ${confirm === j.id ? 'danger' : ''}`}
                data-testid={`export-video-delete-${j.id}`}
                title={
                  exportFinished(j.status)
                    ? 'Delete its files on the server'
                    : 'Cancel it and delete its files'
                }
                onClick={() => void remove(j)}
              >
                {confirm === j.id ? 'Delete?' : 'Delete'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
