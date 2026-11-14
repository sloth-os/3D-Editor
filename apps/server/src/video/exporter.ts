import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DESK_PROPS, isActor, type SceneDoc } from '@3d-editor/core';
import { ToolError } from '../mcp/agent';
import type { Renderer } from '../render';
import type { RenderLease, RenderRequest, RenderThread } from '../render/pool';
import { stringLineWidth } from '../render/passes';
import {
  INTERRUPTED_PREFIX,
  RenderOutOfMemoryError,
  isCancelled,
  type DeskFrameOptions,
  type DeskShotInfo,
  type DocRef,
  type EncodedResult,
  type FrameOptions,
  type ImageResult,
  type PassName,
  type PhysicsFrame,
  type ProcessMemory,
  type RawFrame,
  type WorkerResult,
} from '../render/protocol';
import {
  FfmpegProcess,
  clipArgs,
  encoderArgs,
  posterArgs,
  runFfmpeg,
  streamExtension,
  type StreamCodec,
} from './ffmpeg';
import { renderInOrder } from './frames';
import { ShotTracks, buildManifest, type ManifestFile } from './manifest';
import {
  exportMemory,
  exportNeeds,
  fewerProcessesWarning,
  outOfMemoryMessage,
  readMachineMemory,
  renderInfo,
  type ExportMemory,
  type ExportNeeds,
  type ExportRenderInfo,
  type MemoryReader,
} from './memory';
import { qualityPreset, type VideoExportParams } from './params';
import {
  buildPalette,
  contactTileSize,
  downscaleRGBA,
  maskToRGB,
  paletteLut,
  paletteRecord,
  passBytes,
  resultBytes,
  streamsFor,
  toRGBA,
  type StreamSpec,
} from './passes';
import { planExport, sceneFrameAt, type ExportPlan, type PlannedShot } from './plan';
import type { ExportFile, ExportProgress } from './index';

/*
 * One video export, run from its snapshot (SPEC §9): per shot, segments of at most 200 frames are
 * rendered on a long lease of the render pool (released after each segment once its frames are
 * written, and after two minutes at most, so that waiting long renders take turns and replacement
 * render processes join), frames written in order into one ffmpeg process per stream; then the
 * per-shot clips are cut by stream copy at the forced keyframes, and the posters, the contact sheet
 * and the manifest are written. The live project is never read: everything comes from the
 * snapshot, which has its own render-cache key in the render processes.
 *
 * A render process that dies (the system's out-of-memory killer, a crash) does not end the export:
 * its frame is rendered again on another leased thread, or, when none is left, on a new lease once
 * the pool has started new processes. Only a frame (or a shot's measurement, or the contact sheet)
 * that took down MAX_PROCESS_DEATHS render processes itself fails the export.
 *
 * Before anything starts, the export leases only as many render processes as the machine's
 * available memory holds next to ffmpeg and the server (memory.ts, `decideMemory`; at least one, at
 * most RENDER_WORKERS), and fails with OUT_OF_MEMORY when not even one fits. Once its frames are
 * rendered (or it fails), the render processes it used drop the renderer's working buffers and,
 * unless another long render uses them, their cached documents (its snapshot is of no use to
 * anyone after it), which they would otherwise keep until they idle out.
 */

/** Frames of one lease at most (SPEC: per shot, or at most 200 frames / 2 minutes). */
export const SEGMENT_FRAMES = 200;
export const SEGMENT_MS = 120_000;
/** Bytes of rendered frames in flight or waiting to be written at most. */
export const MAX_BYTES_AHEAD = 256 * 1024 * 1024;
/**
 * Render processes one frame (or one shot's measurement, or the contact sheet) may take down
 * before the export fails with the error of the last one: a frame that always ends its process
 * (out of memory) must not restart processes for ever. Deaths it did not cause do not count (see
 * {@link notTheCause}).
 */
export const MAX_PROCESS_DEATHS = 3;

/**
 * Whether a request whose render process died was not the cause: it waited in the process behind
 * the request of another render that ended it (two long renders share the render processes; see
 * pool.ts sharedProcessError), or the pool stopped the process itself (it is closing). Such a
 * request runs again without counting against its MAX_PROCESS_DEATHS.
 */
export function notTheCause(err: Error): boolean {
  if (err instanceof RenderOutOfMemoryError) return err.reason === 'shared';
  // the error of a crash (not out of memory) of another render's request
  if (err.message.startsWith(INTERRUPTED_PREFIX)) return true;
  return isCancelled(err);
}

export interface ExportEnvironment {
  renderer: Renderer;
  ffmpegPath: string;
  /** The encoders ffmpeg has (libvpx-vp9 decides whether VP9 is possible). */
  encoders: ReadonlySet<string>;
  /** Reads the memory available to the export (default: /proc/meminfo and the cgroup, else os.freemem()). */
  memory?: MemoryReader;
  /** Frames written (metrics). */
  onFrames?(n: number): void;
}

export interface ExportRunInput {
  jobId: string;
  project: { id: string; name: string };
  createdAt: string;
  params: VideoExportParams;
  snapshot: SceneDoc;
  /** The job's directory (exists). */
  dir: string;
  signal: AbortSignal;
  /** Download path of a file of the job (job.json `url`). */
  fileUrl(name: string): string;
  onStatus(status: 'running' | 'encoding'): void;
  onProgress(p: ExportProgress): void;
  /** How the export renders (job status `render`): told once, before rendering or refusing. */
  onRender?(info: ExportRenderInfo): void;
  /** A warning (each reported once by the job). */
  onWarning(message: string): void;
}

export interface ExportRunResult {
  files: ExportFile[];
  plan: ExportPlan;
}

const linearToSrgb = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};

/** The strings of the snapshot (desk_role 'string'), drawn as lines of at least 2 px. */
export function stringLines(doc: SceneDoc, height: number): NonNullable<DeskFrameOptions['lines']> {
  const width = stringLineWidth(height);
  return doc
    .listObjects()
    .filter((o) => o.custom_props?.[DESK_PROPS.role] === 'string')
    .map((o) => {
      const mat = o.material_slots.map((id) => (id ? doc.getMaterial(id) : null)).find(Boolean);
      const c = mat?.base_color ?? [0.85, 0.85, 0.85, 1];
      return {
        object: o.id,
        width_px: width,
        color: [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2])] as [number, number, number],
      };
    });
}

/** SHA-256 of a file (hex). */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Deletes every file of a job directory but those kept (partial outputs of a failed run). */
export async function removeOutputs(dir: string, keep: ReadonlySet<string>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.filter((n) => !keep.has(n)).map((n) => rm(path.join(dir, n), { force: true, recursive: true })),
  );
}

/** A stream of the export with its ffmpeg process. */
interface OpenStream {
  spec: StreamSpec;
  file: string;
  proc: FfmpegProcess;
}

/** The base name of a stream's file (sequence or clip). */
function streamFile(base: string, spec: StreamSpec): string {
  return `${base}${spec.suffix}.${streamExtension(spec.codec)}`;
}

/** Runs an export to its files; throws (after deleting partial outputs) when it fails or is cancelled. */
export async function runExport(env: ExportEnvironment, input: ExportRunInput): Promise<ExportRunResult> {
  const { snapshot, params, dir, signal } = input;
  const warningsSeen = new Set<string>();
  const warn = (w: string) => {
    if (warningsSeen.has(w)) return;
    warningsSeen.add(w);
    input.onWarning(w);
  };
  const plan = planExport(snapshot, params);
  for (const w of plan.warnings) warn(w);
  const { width, height } = plan;
  let codec: 'h264' | 'vp9' = params.codec;
  if (codec === 'vp9' && !env.encoders.has('libvpx-vp9')) {
    warn("codec vp9: this server's ffmpeg has no libvpx-vp9 encoder, so the videos are H.264 MP4");
    codec = 'h264';
  }
  const passes = [...new Set(params.passes)] as PassName[];
  const streams = streamsFor(passes, codec);
  const preset = qualityPreset(params.quality, width, height);
  const outputs = {
    sequence: params.outputs?.sequence ?? true,
    clips: params.outputs?.clips ?? true,
    posters: params.outputs?.posters ?? true,
    contact_sheet: params.outputs?.contact_sheet ?? true,
  };
  const subjects = new Set(plan.shots.flatMap((s) => s.shot?.subjects ?? []));
  const palette = buildPalette(snapshot, subjects);
  const lut = paletteLut(palette);
  const objectPalette = paletteRecord(palette);
  const poseActors = snapshot
    .listObjects()
    .filter((o) => isActor(snapshot, o.id))
    .map((o) => o.id);
  if (passes.includes('pose') && !poseActors.length)
    warn("pose pass: the scene has no actors (desk_role 'actor'), so the pose images are black");
  const lines = stringLines(snapshot, height);
  const renderer = env.renderer;
  if (renderer.pool.mode === 'main-thread') throw mainThreadError();
  // the render processes the machine's memory holds next to ffmpeg and the server (decided before
  // either starts)
  const memory = await decideMemory(
    renderer.pool,
    exportNeedsOf(snapshot, plan, params, codec, renderer.pool.capacity),
    { read: env.memory ?? readMachineMemory, contactSheet: outputs.contact_sheet, signal },
  );
  input.onRender?.(renderInfo(memory));
  if (memory.processes < 1) throw new ToolError(outOfMemoryMessage(memory, width, height), 'OUT_OF_MEMORY');
  if (memory.processes < memory.capacity) warn(fewerProcessesWarning(memory));
  // the snapshot's state, held for the whole run (render processes cache it by its own key)
  const doc: DocRef = renderer.docRef(input.project.id, snapshot);

  const keep = new Set(['job.json', 'snapshot.ybin']);
  const shotTracks = new Map<PlannedShot, ShotTracks>();
  const open: OpenStream[] = [];
  const pending: Promise<void>[] = [];
  const tiles: { frame: RawFrame; label: string }[] = [];
  const tile = contactTileSize(plan.shots.length * 2, width, height);
  /** Errors of the render processes that died during the export (their work was done again). */
  const processDeaths: Error[] = [];
  /** The render threads the export leased (they drop their working buffers at its end). */
  const used = new Set<RenderThread>();
  let buffersReleased = false;
  const releaseBuffers = () => {
    if (buffersReleased) return;
    buffersReleased = true;
    // its snapshot (cached by every process it rendered on) is of no use after it: the documents
    // go too, unless another long render works in the processes now (its document stays)
    const documents = !((renderer.pool.activeLongRenders || 0) > 0);
    // after the requests sent before (fire and forget); a dead process has nothing to give back
    for (const t of used) if (t.alive) t.releaseBuffers?.({ documents });
  };
  const t0 = performance.now();
  let written = 0;
  try {
    input.onStatus('running');
    const keyframes = plan.shots.map((s) => s.outStart);
    for (const spec of streams) {
      const file = streamFile('sequence', spec);
      const args = encoderArgs({
        width,
        height,
        fps: plan.fps,
        input: spec.input,
        codec: spec.codec as StreamCodec,
        quality: params.quality,
        keyframes,
        output: path.join(dir, file),
      });
      open.push({ spec, file, proc: new FfmpegProcess(env.ffmpegPath, args) });
    }
    // posters and contact sheet tiles show the beauty image when it is exported, else the first pass
    const primary = (open.find((s) => s.spec.pass === 'beauty' && !s.spec.lossless) ?? open[0]).spec;

    const progress = (shot: PlannedShot | null) => {
      const seconds = (performance.now() - t0) / 1000;
      const fps = seconds > 0 && written > 0 ? written / seconds : 0;
      input.onProgress({
        frames_done: written,
        frames_total: plan.frames,
        fraction: plan.frames ? written / plan.frames : 1,
        fps: Math.round(fps * 100) / 100,
        eta_s: fps > 0 ? Math.round((plan.frames - written) / fps) : null,
        shot: shot?.id ?? null,
      });
    };

    /** Writes output frame `k` of `shot` (a rendered frame, or the last one held again). */
    const writeFrame = async (
      shot: PlannedShot,
      k: number,
      img: ImageResult,
      maskRGB: Uint8Array | null,
      tracks: ShotTracks,
    ) => {
      for (const s of open) await s.proc.write(passBytes(img, s.spec.pass, maskRGB));
      tracks.add(sceneFrameAt(plan, shot, k), img.meta);
      const middle = Math.floor(shot.outFrames / 2);
      if ((outputs.posters && k === 0) || (outputs.contact_sheet && (k === 0 || k === middle))) {
        const rgba = toRGBA(passBytes(img, primary.pass, maskRGB), primary.input, width, height);
        if (outputs.posters && k === 0) {
          const base = path.join(dir, shot.slug);
          const poster = new FfmpegProcess(
            env.ffmpegPath,
            posterArgs(width, height, `${base}.png`, `${base}.jpg`),
          );
          const p = poster.write(rgba).then(() => poster.finish());
          // a failed poster fails the export (when its promise is awaited at the end)
          p.catch(() => undefined);
          pending.push(p);
        }
        if (outputs.contact_sheet && (k === 0 || k === middle) && (k === 0 || middle > 0))
          tiles.push({
            frame: {
              width: tile.width,
              height: tile.height,
              data: downscaleRGBA(rgba, width, height, tile.width, tile.height),
            },
            label: `${shot.index + 1}-${Math.round(sceneFrameAt(plan, shot, k))}`,
          });
      }
      written++;
      env.onFrames?.(1);
    };

    for (const shot of plan.shots) {
      if (signal.aborted) throw cancelled();
      const tracks = new ShotTracks();
      shotTracks.set(shot, tracks);
      let info: DeskShotInfo | null = null;
      /** The shot's last frame written (held again for padding). */
      const last: { img: ImageResult | null; mask: Uint8Array | null } = { img: null, mask: null };
      /** Render processes each output frame of the shot took down (key -1: its preparation). */
      const deathsOf = new Map<number, number>();
      /** Records a render process that died; false once `key` took down MAX_PROCESS_DEATHS of them. */
      const died = (key: number, err: Error): boolean => {
        processDeaths.push(err);
        // another render's request (or the pool) ended the process this frame waited in
        if (notTheCause(err)) return true;
        const n = (deathsOf.get(key) ?? 0) + 1;
        deathsOf.set(key, n);
        return n < MAX_PROCESS_DEATHS;
      };
      let k = 0;
      while (k < shot.renderFrames) {
        const lease: RenderLease = await renderer.pool.lease(memory.processes, signal);
        for (const t of lease.threads) used.add(t);
        try {
          if (lease.threads.some((t) => t.kind === 'main')) throw mainThreadError();
          const first: RenderThread = lease.threads.find((t) => t.alive) ?? lease.threads[0];
          const end = Math.min(shot.renderFrames, k + SEGMENT_FRAMES);
          const frames = Array.from({ length: end - k }, (_, i) => sceneFrameAt(plan, shot, k + i));
          // the shot's measurement and the segment's rigid body simulation (once for every thread)
          // on its first thread, whose call errors are kept: renderer.physics answers null when its
          // simulation failed, also when that took the process down
          const errors: Error[] = [];
          const watched = keepingErrors(first, errors);
          let physics: Map<number, PhysicsFrame> | null = null;
          try {
            info ??= await watched.call<DeskShotInfo>({
              type: 'desk-shot',
              doc,
              options: {
                frames: Array.from({ length: shot.renderFrames }, (_, i) => sceneFrameAt(plan, shot, i)),
                cameraId: shot.camera,
                aspect: width / height,
              },
            });
            physics = await renderer.physics(snapshot, doc, frames, watched, signal);
          } catch (err) {
            if (signal.aborted || first.alive) throw err;
          }
          if (!first.alive && errors.length) {
            // its render process died: prepared again on a new lease (the pool starts a new process)
            const err = errors[errors.length - 1];
            if (!died(-1, err)) throw err;
            continue;
          }
          const measured = info!;
          const desk: DeskFrameOptions = {
            look: params.look,
            shadows: preset.shadows,
            ao: preset.ao,
            msaa: preset.msaa,
            shadowFit: measured.shadowFit ?? undefined,
            aoRadius: measured.aoRadius,
            passes,
            depthRange: measured.depthRange,
            objectPalette,
            subjects: shot.shot?.subjects ?? [],
            poseActors,
            lines,
          };
          const base = k;
          // frames of render processes that died go to the other threads; when none is left the
          // run ends early (threadsLost) and the next lease brings new processes
          const r = await renderInOrder<ImageResult>({
            count: frames.length,
            threads: lease.threads,
            maxAhead: 2 * lease.threads.length,
            maxBytes: MAX_BYTES_AHEAD,
            itemBytes: resultBytes(passes, width, height),
            signal,
            stopAfterMs: SEGMENT_MS,
            retryAfterDeath: (i, err) => died(base + i, err),
            render: (i, t) => {
              const frame = frames[i];
              const p: PhysicsFrame | undefined = physics?.get(frame);
              const options: FrameOptions = {
                width,
                height,
                frame,
                engine: 'RASTER',
                cameraId: shot.camera,
                samples: preset.samples,
                desk,
                ...(p ? { physics: p } : {}),
              };
              return t.call<ImageResult>({ type: 'image', doc, options, png: false });
            },
            write: async (i, img) => {
              for (const w of img.warnings ?? []) warn(w);
              const mask = img.passes?.mask ? maskToRGB(img.passes.mask, lut) : null;
              await writeFrame(shot, base + i, img, mask, tracks);
              last.img = img;
              last.mask = mask;
              progress(shot);
            },
          });
          k += r.done;
        } finally {
          lease.release();
        }
      }
      // padding (match_model_duration): the last frame held
      for (let j = shot.renderFrames; j < shot.outFrames && last.img; j++) {
        await writeFrame(shot, j, last.img, last.mask, tracks);
        progress(shot);
      }
    }

    // every frame is rendered: the render processes give their working buffers back
    releaseBuffers();
    input.onStatus('encoding');
    await Promise.all(open.map((s) => s.proc.finish()));
    for (const s of open) keep.add(s.file);

    const files: ExportFile[] = [];
    const add = async (name: string, f: Omit<ExportFile, 'name' | 'bytes' | 'url' | 'sha256'>) => {
      const full = path.join(dir, name);
      const st = await stat(full);
      files.push({ name, ...f, bytes: st.size, url: input.fileUrl(name), sha256: await sha256File(full) });
      keep.add(name);
    };

    if (outputs.clips)
      for (const shot of plan.shots)
        for (const s of open) {
          if (s.spec.lossless) continue;
          if (signal.aborted) throw cancelled();
          const name = streamFile(shot.slug, s.spec);
          await runFfmpeg(
            env.ffmpegPath,
            clipArgs(path.join(dir, s.file), path.join(dir, name), shot.outStart, shot.outFrames, plan.fps),
            { signal },
          );
          // every planned shot's files name it ('range' for a frame range): the manifest finds them so
          await add(name, {
            kind: 'clip',
            pass: s.spec.pass,
            shot: shot.id,
            ...(shot.shot?.external?.shot ? { external_shot: shot.shot.external.shot } : {}),
            frames: shot.outFrames,
            duration_s: round6(shot.outFrames / plan.fps),
          });
        }

    await Promise.all(pending);
    if (outputs.posters)
      for (const shot of plan.shots)
        for (const ext of ['png', 'jpg']) await add(`${shot.slug}.${ext}`, { kind: 'poster', shot: shot.id });

    if (outputs.contact_sheet && tiles.length) {
      if (signal.aborted) throw cancelled();
      const sheet = await encodeContactSheet(renderer, tiles, plan, signal, processDeaths);
      await writeFile(path.join(dir, 'contact-sheet.png'), sheet);
      await add('contact-sheet.png', { kind: 'contact_sheet' });
    }
    if (processDeaths.length) warn(deathsWarning(processDeaths));

    for (const s of open) {
      if (!outputs.sequence && !s.spec.lossless) {
        await rm(path.join(dir, s.file), { force: true });
        keep.delete(s.file);
        continue;
      }
      await add(s.file, {
        kind: s.spec.pass === 'beauty' && !s.spec.lossless ? 'sequence' : 'pass',
        ...(s.spec.pass === 'beauty' && !s.spec.lossless ? {} : { pass: s.spec.pass }),
        frames: plan.frames,
        duration_s: round6(plan.frames / plan.fps),
      });
    }

    const manifest = buildManifest({
      doc: snapshot,
      project: input.project,
      createdAt: input.createdAt,
      plan,
      codec,
      look: params.look,
      quality: params.quality,
      passes,
      files: files.map(({ url: _url, ...f }) => f as ManifestFile),
      palette,
      tracks: plan.shots.map((s) => shotTracks.get(s) ?? new ShotTracks()),
      warnings: [...warningsSeen],
    });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await add('manifest.json', { kind: 'manifest' });
    return { files, plan };
  } catch (err) {
    releaseBuffers();
    // stop ffmpeg (SIGKILL) and delete the partial outputs
    await Promise.allSettled(open.map((s) => s.proc.kill()));
    await Promise.allSettled(pending);
    await removeOutputs(dir, new Set(['job.json', 'snapshot.ybin']));
    throw signal.aborted && !(err instanceof ToolError) ? cancelled() : err;
  }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function cancelled(): Error {
  const e = new Error('export cancelled');
  e.name = 'ExportCancelledError';
  return e;
}

/** The error of an export the server cannot run because it renders on its main thread. */
export function mainThreadError(): ToolError {
  return new ToolError(
    'Video export needs render processes, and this server renders on its main thread (RENDER_WORKERS=0, or render processes could not start): set RENDER_WORKERS to 1 or more and restart the server.',
    'UNAVAILABLE',
  );
}

/** The codec an export encodes with: VP9 needs ffmpeg's libvpx-vp9 encoder, else H.264. */
export function exportCodec(codec: 'h264' | 'vp9', encoders: ReadonlySet<string>): 'h264' | 'vp9' {
  return codec === 'vp9' && !encoders.has('libvpx-vp9') ? 'h264' : codec;
}

/** What an export of `doc` needs (memory.ts), as `runExport` renders and encodes it. */
export function exportNeedsOf(
  doc: SceneDoc,
  plan: Pick<ExportPlan, 'width' | 'height'>,
  params: VideoExportParams,
  codec: 'h264' | 'vp9',
  capacity: number,
): ExportNeeds {
  const passes = [...new Set(params.passes)] as PassName[];
  return exportNeeds({
    snapshot: doc,
    width: plan.width,
    height: plan.height,
    passes,
    look: params.look,
    preset: qualityPreset(params.quality, plan.width, plan.height),
    strings: stringLines(doc, plan.height).length > 0,
    streams: streamsFor(passes, codec),
    quality: params.quality,
    capacity,
    maxBytesAhead: MAX_BYTES_AHEAD,
  });
}

/**
 * How many render processes an export renders on (memory.ts), decided before ffmpeg or any render
 * starts. First as if no render process ran: every one still to start, nothing held (exact for an
 * idle pool; with processes running, their memory then counts twice, which errs on the safe side).
 * When that holds fewer than RENDER_WORKERS while render processes run, and what they could hold
 * would change it, every render process of the pool is leased (the pool starts the missing ones,
 * as it would for the export's first segment) and asked what it holds (`memory`), and the machine's
 * memory read again: each process the export leases needs only what it does not hold yet, in the
 * order the pool leases them. Processes that work for another render at the same time hold memory
 * of that render: nothing of theirs counts then. The contact sheet may start the interactive
 * render process at the end: its base is kept when it does not run.
 */
export async function decideMemory(
  pool: Renderer['pool'],
  needs: ExportNeeds,
  o: { read: MemoryReader; contactSheet: boolean; signal: AbortSignal },
): Promise<ExportMemory> {
  const capacity = needs.capacity;
  const cold = exportMemory(needs, { notStarted: capacity, interactive: o.contactSheet, machine: o.read() });
  const running = Math.min(capacity, Math.max(0, pool.running || 0));
  if (cold.processes >= capacity || running === 0) return cold;
  // the most the running processes could hold: whether asking them can change anything
  const best = exportMemory(needs, {
    notStarted: capacity - running,
    warm: Array.from({ length: running }, () => Infinity),
    machine: cold.machine,
  });
  if (best.processes <= cold.processes) return cold;
  const lease = await pool.lease(capacity, o.signal);
  try {
    if (lease.threads.some((t) => t.kind === 'main')) throw mainThreadError();
    // another long render shares the processes (this lease is one): their memory is partly its own
    const shared = (pool.activeLongRenders || 1) > 1;
    const rss = await Promise.all(
      lease.threads.map((t) =>
        shared || !t.alive || t.pending > 0
          ? 0
          : t.call<ProcessMemory>({ type: 'memory' }).then(
              (m) => m.rss,
              () => 0,
            ),
      ),
    );
    return exportMemory(needs, {
      notStarted: capacity - lease.threads.length,
      warm: rss,
      // every render process of long renders runs now: one more is the interactive one
      interactive: o.contactSheet && (pool.running || 0) <= lease.threads.length,
      machine: o.read(),
    });
  } finally {
    lease.release();
  }
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * `t` with the errors of its calls kept in `errors` (the rigid body simulation answers null when
 * its call fails, also when that call took the render process down).
 */
function keepingErrors(t: RenderThread, errors: Error[]): RenderThread {
  return {
    id: t.id,
    kind: t.kind,
    call: <T extends WorkerResult>(req: RenderRequest) =>
      t.call<T>(req).catch((err: unknown) => {
        errors.push(asError(err));
        throw err;
      }),
    release: (job) => t.release(job),
    get pending() {
      return t.pending;
    },
    get alive() {
      return t.alive;
    },
  };
}

/** The job's warning about render processes that died during the export (their work was redone). */
export function deathsWarning(deaths: readonly Error[]): string {
  if (deaths.length === 1)
    return `A render process stopped during the export (${deaths[0].message}); what it was rendering was rendered again in a new render process, so the files are complete`;
  return `${deaths.length} render processes stopped during the export (the first: ${deaths[0].message}); what they were rendering was rendered again in new render processes, so the files are complete`;
}

/**
 * Encodes the contact sheet (first and middle frame of each shot, labelled shot-frame) on a render
 * thread; again on a new one when its render process died (until it took down MAX_PROCESS_DEATHS).
 */
async function encodeContactSheet(
  renderer: Renderer,
  tiles: { frame: RawFrame; label: string }[],
  plan: ExportPlan,
  signal: AbortSignal,
  deaths: Error[],
): Promise<Uint8Array> {
  const pairs = Math.max(1, Math.round(Math.sqrt(tiles.length / 2)));
  /** Render processes the encoding took down. */
  let caused = 0;
  for (;;) {
    const lease = await renderer.pool.lease(1, signal, { interactive: true });
    const thread = lease.threads[0];
    try {
      const res = await thread.call<EncodedResult>({
        type: 'encode',
        frames: tiles.map((t) => t.frame),
        options: {
          format: 'CONTACT_SHEET',
          fps: plan.fps,
          columns: Math.min(tiles.length, 2 * pairs),
          labels: tiles.map((t) => t.label),
        },
      });
      return res.data;
    } catch (err) {
      // an error of the encoding itself (its process lives on) would come again: give up
      if (signal.aborted || thread.alive) throw err;
      const e = asError(err);
      if (!notTheCause(e) && ++caused >= MAX_PROCESS_DEATHS) throw err;
      deaths.push(e);
    } finally {
      lease.release();
    }
  }
}
