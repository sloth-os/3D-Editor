import {
  ShotTracks,
  contactSheetColumns,
  contactTileSize,
  fpsRational,
  isTileFrame,
  middleFrame,
  paletteLut,
  paletteRecord,
  qualityPreset,
  renderInOrder,
  round6,
  sceneFrameAt,
  shotDeskOptions,
  shotRenderFrames,
  streamsFor,
  tileLabel,
  videoExportParamsSchema,
  type DeskFrameOptions,
  type DeskShotInfo,
  type FrameMeta,
  type FrameOptions,
  type ManifestFile,
  type PassName,
  type PhysicsFrame,
  type PlannedShot,
  type SimulatedFrames,
  type StreamSpec,
  type VideoExportParams,
} from '@3d-editor/core';
import { tabMemory, type TabMemory } from '../render/memory';
import {
  KeyFrameSchedule,
  browserConfigProbe,
  chooseEncoding,
  gopFrames,
  type ConfigProbe,
  type VideoEncoding,
} from './codec';
import { StreamEncoder, type VideoEncoderFactory, type VideoFrameFactory } from './encode';
import {
  MAX_BYTES_AHEAD,
  fewerWorkersWarning,
  frameReplyBytes,
  pageNeeds,
  planExportWorkers,
  workerNeeds,
} from './memory';
import { StreamMuxer } from './mux';
import type { FrameReply, FrameWork, ManifestRequest, PlanReply, WorkerJob } from './protocol';
import {
  MemoryStore,
  OpfsStore,
  opfsAvailable,
  sweepExportDirectories,
  type ExportStore,
  type FileInfo,
  type StoredFile,
} from './store';
import { BrowserExportError, type BrowserExportErrorCode } from './support';
import type {
  BrowserExportFileKind,
  BrowserExportHooks,
  BrowserExportProgress,
  BrowserExportRequest,
} from './types';
import {
  ExportThread,
  ExportWorkerError,
  MAX_EXPORT_WORKERS,
  moduleWorkerFactory,
  type ExportWorkerFactory,
} from './workers';
import { ZipStreamWriter } from './zip';

/*
 * One browser export, from the snapshot the page took when it started (the live project is never
 * read): render workers (export.worker.ts) render the frames with core's export code, as the
 * server's render processes do, and the page encodes them with WebCodecs and writes the files.
 *
 * - Worker 0 applies the snapshot and plans the export (core planExport: shots, size, frames);
 *   the tab's memory then decides how many more workers start (memory.ts), each applying the
 *   snapshot once.
 * - Per shot, worker 0 measures it (depth range, shadow box); per segment of at most
 *   SEGMENT_FRAMES frames it simulates the rigid bodies once for every worker; then the segment's
 *   frames are rendered ahead on every worker and written in order (core renderInOrder, as the
 *   server does), the shot padded with its last frame (match_model_duration).
 * - Workers convert each frame for the page: I420 BT.709 limited range for each video stream, a PNG
 *   for each lossless pass (mask, edges), the posters (PNG, JPEG), the still and the contact sheet
 *   tiles. The page encodes every video stream with one VideoEncoder (key frames at every shot
 *   start and every round(2 × fps) frames), muxes its chunks into the sequence and the clip of
 *   their shot (mux.ts), and zips the lossless frames (frame-000001.png …).
 * - Worker 0 makes the contact sheet and the manifest (core contactSheet, buildManifest), the other
 *   workers having stopped once the frames were rendered.
 * Files go to the Origin Private File System when the browser has it, else stay in memory
 * (store.ts); every file's SHA-256 is computed as it is written. Cancelling (the AbortSignal) stops
 * the workers and the encoders and deletes what was written. The screen is kept awake while the
 * export runs where the browser allows it.
 */

/** Frames of one segment at most (rigid bodies are simulated once per segment, as the server leases per segment). */
export const SEGMENT_FRAMES = 200;
/** Bytes of shared rigid body matrices of one segment at most (fewer frames per segment for many bodies). */
const MAX_PHYSICS_BYTES = 64 * 1024 * 1024;
/** JPEG quality of the posters (the server's ffmpeg writes them with -q:v 2). */
export const POSTER_JPEG_QUALITY = 0.92;

/** How an export runs (tests replace the browser's workers, encoder, storage and memory). */
export interface EngineOptions {
  workers?: ExportWorkerFactory;
  probe?: ConfigProbe;
  encoderFactory?: VideoEncoderFactory;
  frameFactory?: VideoFrameFactory;
  /** The store of export `id` (default: the Origin Private File System where available, else memory). */
  store?: (id: string) => Promise<ExportStore>;
  /** Most render workers (default: the device's cores, at most MAX_EXPORT_WORKERS). */
  maxWorkers?: number;
  /** The tab's memory, given the page heap of a page holding the project (default: tabMemory). */
  memory?: (pageHeap: number) => TabMemory;
  now?: () => Date;
  /** The raw pass digests and metadata of every rendered frame (the parity check with core in Node). */
  digests?: (shot: string, k: number, digests: Record<string, string>, meta: FrameMeta | null) => void;
}

/** A finished export as the engine returns it (index.ts gives it its public shape). */
export interface EngineResult {
  id: string;
  files: (StoredFile & { kind: BrowserExportFileKind })[];
  manifest: Record<string, unknown>;
  shots: { id: string; slug: string; frames: number }[];
  warnings: string[];
  /** The export's store (released with the result). */
  store: ExportStore;
  /** Measurements: render workers used, frames per second of the render phase, its seconds. */
  stats: { workers: number; renderFps: number; seconds: number };
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** A new export id: its start time (base 36) and a random part (the store's directory name). */
export function exportId(now = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `${now.toString(36)}-${rand}`;
}

/** The name of a frame in a frame archive: its output frame, 1-based, six digits at least. */
export function frameName(index: number): string {
  return `frame-${String(index + 1).padStart(6, '0')}.png`;
}

/** The file name of a stream (base 'sequence' or a shot's slug). */
export function streamFileName(
  base: string,
  spec: Pick<StreamSpec, 'suffix' | 'lossless'>,
  encoding: Pick<VideoEncoding, 'container'> | null,
): string {
  if (spec.lossless) return `${base}${spec.suffix}.zip`;
  return `${base}${spec.suffix}.${encoding?.container ?? 'mp4'}`;
}

/** The manifest's kind of a browser file: the server's names, plus 'frames' and 'still' (docs/video-export.md). */
function manifestKind(kind: BrowserExportFileKind, pass: string | null): string {
  if (kind === 'sequence') return pass === 'beauty' ? 'sequence' : 'pass';
  return kind;
}

/** A file of the export as the manifest lists it (the server's fields, in its order). */
export function manifestFile(
  f: StoredFile & { kind: BrowserExportFileKind },
  externalShot?: string,
): ManifestFile {
  const out: Record<string, unknown> = { name: f.name, kind: manifestKind(f.kind, f.pass) };
  // the beauty sequence names no pass (as the server's); every other video and archive does
  if (f.pass && !(f.kind === 'sequence' && f.pass === 'beauty')) out.pass = f.pass;
  if (f.shot) out.shot = f.shot;
  if (externalShot) out.external_shot = externalShot;
  if (f.frames !== null) out.frames = f.frames;
  if (f.duration_s !== null) out.duration_s = f.duration_s;
  out.bytes = f.size;
  out.sha256 = f.sha256;
  return out as unknown as ManifestFile;
}

/** The error of a worker's answer or of the export itself, with its code. */
function exportError(err: unknown): BrowserExportError {
  if (err instanceof BrowserExportError) return err;
  const e = asError(err);
  const code: BrowserExportErrorCode =
    e instanceof ExportWorkerError && (e.code === 'INVALID_PARAMS' || e.code === 'NOT_FOUND')
      ? e.code
      : 'FAILED';
  const out = new BrowserExportError(e.message, code);
  out.stack = e.stack;
  return out;
}

const cancelled = () => new BrowserExportError('The export was cancelled', 'CANCELLED');

/** Validates the parameters with core's schema. */
export function exportParams(params: unknown): VideoExportParams {
  const parsed = videoExportParamsSchema.safeParse(params ?? {});
  if (!parsed.success)
    throw new BrowserExportError(
      `Invalid video export parameters: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
      'INVALID_PARAMS',
    );
  return parsed.data;
}

async function defaultStore(id: string): Promise<ExportStore> {
  if (opfsAvailable()) {
    try {
      return await OpfsStore.open(id);
    } catch {
      // the storage refused (private mode, quota): keep the files in memory
    }
  }
  return new MemoryStore();
}

/** Keeps the screen on while the export runs (where the browser allows it); returns the release. */
async function keepAwake(): Promise<() => void> {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
    };
    const lock = await nav.wakeLock?.request('screen');
    return () => void lock?.release().catch(() => undefined);
  } catch {
    return () => {};
  }
}

/** Runs one browser export; throws a BrowserExportError (after deleting its partial files) when it fails or is cancelled. */
export async function runBrowserExport(
  req: BrowserExportRequest,
  hooks: BrowserExportHooks = {},
  opts: EngineOptions = {},
): Promise<EngineResult> {
  const t0 = performance.now();
  const params = exportParams(req.params);
  if (!(req.update instanceof Uint8Array) || req.update.length === 0)
    throw new BrowserExportError(
      'The export has no snapshot (update): Y.encodeStateAsUpdate of the project',
      'INVALID_PARAMS',
    );
  const outer = hooks.signal;
  if (outer?.aborted) throw cancelled();
  const now = opts.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const id = exportId(now().getTime());
  const progress = (p: BrowserExportProgress) => {
    try {
      hooks.onProgress?.(p);
    } catch {
      // a failing progress listener does not fail the export
    }
  };
  const factory = opts.workers ?? moduleWorkerFactory;
  const threads: ExportThread[] = [];
  const ac = new AbortController();
  const signal = ac.signal;
  const stopAll = (reason: Error) => {
    for (const t of threads) t.terminate(reason);
  };
  const onAbort = () => {
    ac.abort();
    stopAll(cancelled());
  };
  outer?.addEventListener('abort', onAbort, { once: true });
  const checkAbort = () => {
    if (signal.aborted) throw cancelled();
  };

  let store: ExportStore | null = null;
  const encoders: StreamEncoder[] = [];
  const muxers: StreamMuxer[] = [];
  const pendingFiles: { abort(): Promise<void> }[] = [];
  const release = await keepAwake();
  try {
    if (opfsAvailable() && !opts.store) await sweepExportDirectories();
    store = await (opts.store ?? defaultStore)(id);
    checkAbort();

    // ---------------------------------------------------------------- prepare
    const prepareTotal = 3;
    progress({ phase: 'prepare', done: 0, total: prepareTotal });
    const first = new ExportThread(0, factory);
    threads.push(first);
    await first.call({ type: 'init', update: req.update });
    checkAbort();
    progress({ phase: 'prepare', done: 1, total: prepareTotal });
    const planned = await first.call<PlanReply>({ type: 'plan', params, stills: !!req.stills });
    checkAbort();
    progress({ phase: 'prepare', done: 2, total: prepareTotal });
    const { plan } = planned;
    const { width, height } = plan;
    const fps = fpsRational(plan.fps);
    const warningsSeen = new Set<string>();
    const warn = (w: string) => void warningsSeen.add(w);
    for (const w of planned.warnings) warn(w);

    const outputs = {
      sequence: params.outputs?.sequence ?? true,
      clips: params.outputs?.clips ?? true,
      posters: params.outputs?.posters ?? true,
      contact_sheet: params.outputs?.contact_sheet ?? true,
    };
    const passes = [...new Set(params.passes)] as PassName[];
    const videoWanted = outputs.sequence || outputs.clips;
    // the codec: VP9 where the browser encodes it at this size, else H.264
    const probe = opts.probe ?? browserConfigProbe;
    let codec: 'h264' | 'vp9' = params.codec;
    let encoding: VideoEncoding | null = null;
    if (codec === 'vp9') {
      encoding = await chooseEncoding(
        'vp9',
        { width, height, fps: plan.fps, quality: params.quality },
        probe,
      );
      if (!encoding) {
        warn(`codec vp9: this browser cannot encode VP9 at ${width}×${height}, so the videos are H.264 MP4`);
        codec = 'h264';
      }
    }
    if (codec === 'h264')
      encoding = await chooseEncoding(
        'h264',
        { width, height, fps: plan.fps, quality: params.quality },
        probe,
      );
    const streams = streamsFor(passes, codec);
    const videoSpecs = videoWanted ? streams.filter((s) => !s.lossless) : [];
    const losslessSpecs = streams.filter((s) => s.lossless);
    if (videoSpecs.length && !encoding)
      throw new BrowserExportError(
        `This browser cannot encode H.264 video of ${width}×${height} at ${plan.fps} fps: lower the resolution or the frame rate, or export on the server.`,
        'UNSUPPORTED',
      );
    // posters and contact sheet tiles show the beauty image when it is exported, else the first pass
    const primary = streams.find((s) => s.pass === 'beauty' && !s.lossless) ?? streams[0];

    // the render workers the tab's memory holds
    const totalRender = plan.shots.reduce((n, s) => n + s.renderFrames, 0);
    const cores = Math.max(1, Math.floor(navigator.hardwareConcurrency || 4));
    const maxWorkers = Math.max(
      1,
      Math.min(opts.maxWorkers ?? Math.min(cores, MAX_EXPORT_WORKERS), totalRender || 1),
    );
    const longestShot = plan.shots.reduce((n, s) => Math.max(n, s.outFrames), 0);
    const memory = (opts.memory ?? ((h: number) => tabMemory(h)))(planned.pageHeap);
    const page = (workers: number) =>
      pageNeeds({
        width,
        height,
        fps: plan.fps,
        quality: params.quality,
        codec,
        videoStreams: videoSpecs.length,
        lossless: losslessSpecs.length,
        frames: plan.frames,
        longestShot,
        shots: plan.shots.length,
        outputs: {
          sequence: outputs.sequence,
          clips: outputs.clips,
          posters: outputs.posters,
          stills: !!req.stills,
        },
        onDisk: store!.onDisk,
        workers,
      });
    const workerPlan = planExportWorkers({
      worker: workerNeeds(planned.estimate),
      page: page(maxWorkers),
      maxWorkers,
      memory,
      onDisk: store.onDisk,
    });
    if (!workerPlan.workers)
      throw new BrowserExportError(workerPlan.refusal ?? 'The export does not fit this tab', 'OUT_OF_MEMORY');
    if (
      workerPlan.limited &&
      workerPlan.workers < Math.min(cores, MAX_EXPORT_WORKERS) &&
      workerPlan.workers < totalRender
    )
      warn(fewerWorkersWarning(workerPlan.workers, Math.min(cores, MAX_EXPORT_WORKERS)));
    for (let i = 1; i < workerPlan.workers; i++) threads.push(new ExportThread(i, factory));
    await Promise.all(threads.slice(1).map((t) => t.call({ type: 'init', update: req.update })));
    checkAbort();

    const lut = paletteLut(planned.palette);
    const objectPalette = paletteRecord(planned.palette);
    const job: WorkerJob = {
      width,
      height,
      lut,
      streams: videoSpecs.map((s) => ({ pass: s.pass, format: s.input })),
      lossless: losslessSpecs.map((s) => s.pass as 'mask' | 'edges'),
      primary: { pass: primary.pass, format: primary.input },
      jpegQuality: POSTER_JPEG_QUALITY,
    };
    await Promise.all(threads.map((t) => t.call({ type: 'job', job })));
    checkAbort();
    progress({ phase: 'prepare', done: 3, total: prepareTotal });

    // ---------------------------------------------------------------- outputs
    const files: (StoredFile & { kind: BrowserExportFileKind })[] = [];
    const clipFiles = new Map<string, StoredFile & { kind: BrowserExportFileKind }>();
    const posterFiles: (StoredFile & { kind: BrowserExportFileKind })[] = [];
    const stillFiles: (StoredFile & { kind: BrowserExportFileKind })[] = [];
    const info = (o: Omit<FileInfo, 'frames' | 'duration_s'> & { frames?: number }): FileInfo => ({
      ...o,
      frames: o.frames ?? null,
      duration_s: o.frames !== undefined ? round6(o.frames / plan.fps) : null,
    });
    const keep = (f: StoredFile, kind: BrowserExportFileKind) => ({ ...f, kind });
    const shotStarts = plan.shots.map((s) => s.outStart);
    const schedule = new KeyFrameSchedule(shotStarts, gopFrames(plan.fps));

    /** The sequence file of each video stream on disk (null in memory or without a sequence). */
    const sequenceFiles: (Awaited<ReturnType<ExportStore['randomAccess']>> | null)[] = [];
    for (const spec of videoSpecs) {
      const enc = encoding!;
      const seqInfo = info({
        name: streamFileName('sequence', spec, enc),
        kind: 'sequence',
        pass: spec.pass,
        shot: null,
        mime: enc.mime,
        frames: plan.frames,
      });
      const onDisk = outputs.sequence ? await store.randomAccess(seqInfo) : null;
      sequenceFiles.push(onDisk);
      const muxer = new StreamMuxer({
        muxCodec: enc.muxCodec,
        container: enc.container,
        fps,
        frames: plan.frames,
        shots: plan.shots.map((s) => ({ start: s.outStart, frames: s.outFrames })),
        sequence: outputs.sequence ? (onDisk ? onDisk.writable : 'memory') : null,
        clips: outputs.clips,
        onClip: async (index, bytes) => {
          const shot = plan.shots[index];
          const f = await store!.bytes(
            info({
              name: streamFileName(shot.slug, spec, enc),
              kind: 'clip',
              pass: spec.pass,
              shot: shot.id,
              mime: enc.mime,
              frames: shot.outFrames,
            }),
            bytes,
          );
          clipFiles.set(`${index}:${spec.pass}`, keep(f, 'clip'));
        },
      });
      muxers.push(muxer);
      encoders.push(
        new StreamEncoder({
          encoding: enc,
          width,
          height,
          fps,
          onChunk: (chunk, config) => muxer.add(chunk, config),
          encoderFactory: opts.encoderFactory,
          frameFactory: opts.frameFactory,
        }),
      );
    }
    const archives: {
      spec: StreamSpec;
      zip: ZipStreamWriter;
      file: Awaited<ReturnType<ExportStore['sequential']>>;
    }[] = [];
    for (const spec of losslessSpecs) {
      const file = await store.sequential(
        info({
          name: streamFileName('sequence', spec, null),
          kind: 'frames',
          pass: spec.pass,
          shot: null,
          mime: 'application/zip',
          frames: plan.frames,
        }),
      );
      pendingFiles.push(file);
      archives.push({ spec, file, zip: new ZipStreamWriter((chunk) => file.write(chunk), now()) });
    }

    // ---------------------------------------------------------------- frames
    const preset = qualityPreset(params.quality, width, height);
    const tile = contactTileSize(plan.shots.length * 2, width, height);
    const tiles: { data: Uint8ClampedArray; label: string }[] = [];
    const shotTracks: ShotTracks[] = [];
    const itemBytes = frameReplyBytes(width, height, videoSpecs.length, losslessSpecs.length);
    const bytesPerBody = 16 * 8;
    const segmentFrames = Math.max(
      1,
      Math.min(
        SEGMENT_FRAMES,
        planned.bodies ? Math.floor(MAX_PHYSICS_BYTES / (planned.bodies * bytesPerBody)) : SEGMENT_FRAMES,
      ),
    );
    let written = 0;
    const renderStart = performance.now();

    /** The last rendered frame of the shot, held again for padding. */
    interface Held {
      video: Uint8Array[];
      lossless: Uint8Array[];
      meta: FrameMeta | null;
      tile: Uint8ClampedArray | null;
    }

    const writeFrame = async (shot: PlannedShot, k: number, frame: Held, tracks: ShotTracks) => {
      checkAbort();
      const out = shot.outStart + k;
      const key = schedule.keyFrame(out);
      for (let j = 0; j < encoders.length; j++) await encoders[j].encode(frame.video[j], out, key);
      for (let j = 0; j < archives.length; j++) await archives[j].zip.add(frameName(out), frame.lossless[j]);
      tracks.add(sceneFrameAt(plan, shot, k), frame.meta ?? undefined);
      if (outputs.contact_sheet && isTileFrame(shot, k)) {
        if (!frame.tile)
          throw new Error(`the contact sheet tile of shot ${shot.index + 1} frame ${k + 1} is missing`);
        tiles.push({ data: frame.tile, label: tileLabel(plan, shot, k) });
      }
      written++;
      progress({ phase: 'render', done: written, total: plan.frames, shot: shot.id });
    };

    for (const shot of plan.shots) {
      checkAbort();
      const tracks = new ShotTracks();
      shotTracks.push(tracks);
      const measured = await first.call<DeskShotInfo>({
        type: 'shot',
        options: { frames: shotRenderFrames(plan, shot), cameraId: shot.camera, aspect: width / height },
      });
      checkAbort();
      const desk: DeskFrameOptions = shotDeskOptions({
        look: params.look,
        preset,
        passes,
        info: measured,
        objectPalette,
        shot,
        poseActors: planned.poseActors,
        lines: planned.lines,
      });
      const middle = middleFrame(shot);
      const last: { frame: Held | null } = { frame: null };
      for (let k = 0; k < shot.renderFrames;) {
        const end = Math.min(shot.renderFrames, k + segmentFrames);
        const frames = Array.from({ length: end - k }, (_, i) => sceneFrameAt(plan, shot, k + i));
        // the segment's rigid body simulation, once for every worker (else each simulates itself)
        let physics: Map<number, PhysicsFrame> | null = null;
        if (planned.simulates) {
          try {
            const sim = await first.call<SimulatedFrames>({ type: 'simulate', frames });
            physics = new Map(sim.frames.map((f) => [f.frame, f]));
          } catch (err) {
            if (signal.aborted) throw cancelled();
            if (!first.alive) throw err;
          }
        }
        const base = k;
        const r = await renderInOrder<FrameReply, ExportThread>({
          count: frames.length,
          threads,
          maxAhead: 2 * threads.length,
          maxBytes: MAX_BYTES_AHEAD,
          itemBytes,
          signal,
          // a frame whose worker stopped (out of memory, most likely) is not rendered again
          retryAfterDeath: () => false,
          render: (i, t) => {
            const kk = base + i;
            const frame = frames[i];
            const p = physics?.get(frame);
            const still = !!req.stills && kk === 0;
            const options: FrameOptions & { desk: DeskFrameOptions } = {
              width,
              height,
              frame,
              engine: 'RASTER',
              cameraId: shot.camera,
              samples: preset.samples,
              desk:
                still && !desk.passes.includes('beauty')
                  ? { ...desk, passes: [...desk.passes, 'beauty'] }
                  : desk,
              ...(p ? { physics: p } : {}),
            };
            const tileHere =
              outputs.contact_sheet &&
              (isTileFrame(shot, kk) ||
                (kk === shot.renderFrames - 1 && middle >= shot.renderFrames && isTileFrame(shot, middle)));
            const work: FrameWork = {
              poster: outputs.posters && kk === 0,
              still,
              tile: tileHere ? tile : null,
              ...(opts.digests ? { digests: true } : {}),
            };
            return t.call<FrameReply>({ type: 'frame', options, work });
          },
          write: async (i, reply) => {
            const kk = base + i;
            for (const w of reply.warnings) warn(w);
            if (reply.digests) opts.digests?.(shot.id, kk, reply.digests, reply.meta);
            if (reply.poster) {
              const png = await store!.bytes(
                info({
                  name: `${shot.slug}.png`,
                  kind: 'poster',
                  pass: null,
                  shot: shot.id,
                  mime: 'image/png',
                }),
                reply.poster.png,
              );
              const jpg = await store!.bytes(
                info({
                  name: `${shot.slug}.jpg`,
                  kind: 'poster',
                  pass: null,
                  shot: shot.id,
                  mime: 'image/jpeg',
                }),
                reply.poster.jpeg,
              );
              posterFiles.push(keep(png, 'poster'), keep(jpg, 'poster'));
            }
            if (reply.still) {
              const f = await store!.bytes(
                info({
                  name: `${shot.slug}.still.png`,
                  kind: 'still',
                  pass: null,
                  shot: shot.id,
                  mime: 'image/png',
                }),
                reply.still,
              );
              stillFiles.push(keep(f, 'still'));
            }
            last.frame = {
              video: reply.video.map((b) => new Uint8Array(b)),
              lossless: reply.lossless,
              meta: reply.meta,
              tile: reply.tile,
            };
            await writeFrame(shot, kk, last.frame, tracks);
          },
        });
        if (r.threadsLost || r.done < frames.length) {
          checkAbort();
          const why = r.deaths[0]?.message ?? 'the render workers stopped';
          throw new Error(
            `The export's render workers stopped (${why}): the tab may be short of memory; lower the resolution or the passes`,
          );
        }
        k += r.done;
      }
      // padding (match_model_duration): the last frame held
      const held = last.frame;
      if (shot.outFrames > shot.renderFrames && !held)
        throw new Error(`shot ${shot.index + 1} rendered no frame to hold`);
      for (let j = shot.renderFrames; j < shot.outFrames && held; j++)
        await writeFrame(shot, j, held, tracks);
    }
    const renderSeconds = (performance.now() - renderStart) / 1000;
    // the frames are rendered: every worker but the first stops (the first makes the sheet and manifest)
    for (const t of threads.slice(1)) t.terminate();

    // ---------------------------------------------------------------- encode
    const encodeTotal = encoders.length + archives.length;
    let encodeDone = 0;
    progress({ phase: 'encode', done: 0, total: encodeTotal });
    const sequences: (StoredFile & { kind: BrowserExportFileKind })[] = [];
    for (let j = 0; j < encoders.length; j++) {
      checkAbort();
      await encoders[j].flush();
      encoders[j].close();
      const bytes = await muxers[j].finish();
      const spec = videoSpecs[j];
      if (outputs.sequence) {
        const onDisk = sequenceFiles[j];
        const f = onDisk
          ? await onDisk.close()
          : await store.bytes(
              info({
                name: streamFileName('sequence', spec, encoding),
                kind: 'sequence',
                pass: spec.pass,
                shot: null,
                mime: encoding!.mime,
                frames: plan.frames,
              }),
              bytes!,
            );
        sequences.push(keep(f, 'sequence'));
      }
      progress({ phase: 'encode', done: ++encodeDone, total: encodeTotal });
    }
    const archiveFiles: (StoredFile & { kind: BrowserExportFileKind })[] = [];
    for (const a of archives) {
      checkAbort();
      await a.zip.finish();
      const f = await a.file.close();
      pendingFiles.splice(pendingFiles.indexOf(a.file), 1);
      archiveFiles.push(keep(f, 'frames'));
      progress({ phase: 'encode', done: ++encodeDone, total: encodeTotal });
    }

    // ---------------------------------------------------------------- finish
    progress({ phase: 'finish', done: 0, total: 2 });
    for (const shot of plan.shots)
      for (const spec of videoSpecs) {
        const f = clipFiles.get(`${shot.index}:${spec.pass}`);
        if (f) files.push(f);
      }
    files.push(...posterFiles, ...stillFiles);
    if (outputs.contact_sheet && tiles.length) {
      checkAbort();
      const png = await first.call<Uint8Array>(
        {
          type: 'contact-sheet',
          tiles: tiles.map((t) => ({ width: tile.width, height: tile.height, data: t.data })),
          labels: tiles.map((t) => t.label),
          columns: contactSheetColumns(tiles.length),
        },
        [...new Set(tiles.map((t) => t.data.buffer))],
      );
      const f = await store.bytes(
        info({ name: 'contact-sheet.png', kind: 'contact_sheet', pass: null, shot: null, mime: 'image/png' }),
        png,
      );
      files.push(keep(f, 'contact_sheet'));
    }
    progress({ phase: 'finish', done: 1, total: 2 });
    // the sequences and archives in stream order (as the server lists its sequence and pass files)
    for (const spec of streams) {
      const f = spec.lossless
        ? archiveFiles.find((a) => a.pass === spec.pass)
        : sequences.find((s) => s.pass === spec.pass);
      if (f) files.push(f);
    }
    const externalShot = (shotId: string | null) =>
      plan.shots.find((s) => s.id === shotId)?.shot?.external?.shot ?? undefined;
    const warnings = [...warningsSeen];
    const manifestRequest: ManifestRequest = {
      project: { id: req.project?.id ?? '', name: req.project?.name ?? planned.name },
      createdAt,
      plan,
      codec,
      look: params.look,
      quality: params.quality,
      passes,
      files: files.map((f) => manifestFile(f, f.kind === 'clip' ? externalShot(f.shot) : undefined)),
      palette: planned.palette,
      tracks: shotTracks.map((t) => ({ camera: t.camera, subjects: [...t.subjects] })),
      warnings,
    };
    checkAbort();
    const manifest = await first.call<Record<string, unknown>>({
      type: 'manifest',
      request: manifestRequest,
    });
    manifest.exporter = {
      kind: 'browser',
      video_codec: videoSpecs.length ? encoding!.config.codec : null,
      bitrate: videoSpecs.length && encoding!.quantizer === null ? (encoding!.config.bitrate ?? null) : null,
      vp9_quantizer: videoSpecs.length ? encoding!.quantizer : null,
      render_workers: threads.length,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    const mf = await store.bytes(
      info({ name: 'manifest.json', kind: 'manifest', pass: null, shot: null, mime: 'application/json' }),
      manifestBytes,
    );
    files.push(keep(mf, 'manifest'));
    progress({ phase: 'finish', done: 2, total: 2 });
    first.terminate();
    return {
      id,
      files,
      manifest,
      shots: plan.shots.map((s) => ({ id: s.id, slug: s.slug, frames: s.outFrames })),
      warnings,
      store,
      stats: {
        workers: threads.length,
        renderFps: renderSeconds > 0 ? written / renderSeconds : 0,
        seconds: (performance.now() - t0) / 1000,
      },
    };
  } catch (err) {
    const aborted = signal.aborted || !!outer?.aborted;
    ac.abort();
    stopAll(aborted ? cancelled() : asError(err));
    for (const e of encoders) e.close();
    await Promise.allSettled(muxers.map((m) => m.cancel()));
    await Promise.allSettled(pendingFiles.map((f) => f.abort()));
    await store?.dispose().catch(() => undefined);
    throw aborted ? cancelled() : exportError(err);
  } finally {
    outer?.removeEventListener('abort', onAbort);
    release();
  }
}
