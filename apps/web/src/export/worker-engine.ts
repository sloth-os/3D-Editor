import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  NO_POSE_ACTORS_WARNING,
  ShotTracks,
  buildManifest,
  buildPalette,
  contactSheet,
  downscaleRGBA,
  encodePNG,
  encodeRawPNG,
  exportRenderDocumentFromUpdate,
  exportRenderEstimate,
  maskToRGB,
  measureDeskShot,
  passBytes,
  planExport,
  poseActorsOf,
  qualityPreset,
  releaseRenderBuffers,
  renderExportFrame,
  resultBytes,
  rgbaToRGB,
  simulateRigidBodies,
  simulatesRigidBodies,
  stringLines,
  toRGBA,
  type DeskFrameOptions,
  type ExportRenderDocument,
  type FrameOptions,
  type ImageResult,
  type PassName,
  type VideoExportParams,
} from '@3d-editor/core';
import {
  frameTransferables,
  type ExportWorkerRequest,
  type ExportWorkerResponse,
  type FrameReply,
  type FrameWork,
  type ManifestRequest,
  type PlanReply,
  type WorkerJob,
} from './protocol';
import { pageHeapEstimate } from '../render/memory';
import { toI420 } from './yuv';

/*
 * The work of a browser export's render worker (export.worker.ts runs it; unit tests run it in
 * process): it applies the snapshot once, renders frames with core's export code (the server's
 * render processes run the same functions, so the pixels are the same), and converts them for the
 * page: I420 for the video encoders, PNG frames for the lossless passes, posters, stills and tiles.
 */

/** Encodes RGBA pixels as a JPEG file (a worker's OffscreenCanvas; injectable for tests). */
export type JpegEncoder = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  quality: number,
) => Promise<Uint8Array>;

/** The JPEG encoder of a worker: an OffscreenCanvas (the alpha is ignored, as ffmpeg's yuvj420p drops it). */
export const canvasJpeg: JpegEncoder = async (rgba, width, height, quality) => {
  if (typeof OffscreenCanvas === 'undefined')
    throw new Error('this browser cannot encode JPEG posters (no OffscreenCanvas)');
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser cannot encode JPEG posters (no 2D canvas)');
  const opaque = new Uint8ClampedArray(rgba);
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  ctx.putImageData(new ImageData(opaque, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
};

const hex = (bytes: Uint8Array | Uint8ClampedArray) =>
  bytesToHex(sha256(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));

/**
 * A frame's raw passes as SHA-256 digests ('beauty' the RGBA image, 'mask' the palette indices …):
 * what the parity check compares with the frames core renders in Node. (The metadata is compared
 * as numbers: browsers' and Node's V8 round some Math functions differently in the last bit.)
 */
export function frameDigests(img: ImageResult): Record<string, string> {
  const out: Record<string, string> = {};
  if (img.data) out.beauty = hex(img.data);
  for (const [pass, bytes] of Object.entries(img.passes ?? {})) if (bytes) out[pass] = hex(bytes);
  return out;
}

export class ExportWorkerEngine {
  private entry: ExportRenderDocument | null = null;
  private job: WorkerJob | null = null;

  constructor(private readonly jpeg: JpegEncoder = canvasJpeg) {}

  private document(): ExportRenderDocument {
    if (!this.entry) throw new Error('the export worker has no snapshot (init first)');
    return this.entry;
  }

  init(update: Uint8Array): { ok: true } {
    this.entry?.doc.destroy();
    this.entry = exportRenderDocumentFromUpdate(update);
    return { ok: true };
  }

  /** The export's plan, palette, actors, strings and memory estimate (core's planning errors pass through). */
  plan(params: VideoExportParams, stills = false): PlanReply {
    const { doc } = this.document();
    const plan = planExport(doc, params);
    const subjects = new Set(plan.shots.flatMap((s) => s.shot?.subjects ?? []));
    const palette = buildPalette(doc, subjects);
    const poseActors = poseActorsOf(doc);
    const lines = stringLines(doc, plan.height);
    const passes = [...new Set(params.passes)] as PassName[];
    const warnings = [...plan.warnings];
    if (passes.includes('pose') && !poseActors.length) warnings.push(NO_POSE_ACTORS_WARNING);
    // a still is the beauty image of a shot's first frame, rendered with that frame's passes
    const rendered: PassName[] = stills && !passes.includes('beauty') ? [...passes, 'beauty'] : passes;
    const estimate = exportRenderEstimate(doc, {
      width: plan.width,
      height: plan.height,
      passes: rendered,
      look: params.look,
      preset: qualityPreset(params.quality, plan.width, plan.height),
      strings: lines.length > 0,
      resultBytes: resultBytes(rendered, plan.width, plan.height),
    });
    const simulates = simulatesRigidBodies(doc);
    const bodies = simulates ? doc.listObjects().filter((o) => o.rigid_body?.enabled).length : 0;
    return {
      plan,
      palette,
      poseActors,
      lines,
      warnings,
      simulates,
      bodies,
      estimate,
      pageHeap: pageHeapEstimate(doc),
      name: doc.name,
    };
  }

  setJob(job: WorkerJob): { ok: true } {
    this.job = job;
    return { ok: true };
  }

  /** Renders a frame and converts it as the job says. */
  async frame(options: FrameOptions & { desk: DeskFrameOptions }, work: FrameWork): Promise<FrameReply> {
    const job = this.job;
    if (!job) throw new Error('the export worker has no job');
    const t0 = performance.now();
    const img = renderExportFrame(this.document(), options);
    const { width, height } = job;
    const mask = img.passes?.mask;
    const maskRGB = mask ? maskToRGB(mask, job.lut) : null;
    const video = job.streams.map((s) => {
      const bytes = passBytes(img, s.pass, maskRGB);
      return toI420(bytes, s.format, width, height).buffer as ArrayBuffer;
    });
    const lossless = job.lossless.map((pass) => {
      const data = img.passes?.[pass];
      if (!data) throw new Error(`the frame came back without its ${pass} pass`);
      return pass === 'mask'
        ? encodeRawPNG({ width, height, channels: 1, data, palette: job.lut })
        : encodeRawPNG({ width, height, channels: 1, data });
    });
    let poster: FrameReply['poster'] = null;
    let tile: Uint8ClampedArray | null = null;
    if (work.poster || work.tile) {
      const rgba = toRGBA(passBytes(img, job.primary.pass, maskRGB), job.primary.format, width, height);
      if (work.poster)
        poster = {
          png: encodeRawPNG({ width, height, channels: 3, data: rgbaToRGB(rgba, width, height) }),
          jpeg: await this.jpeg(
            new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
            width,
            height,
            job.jpegQuality,
          ),
        };
      if (work.tile) tile = downscaleRGBA(rgba, width, height, work.tile.width, work.tile.height);
    }
    let still: Uint8Array | null = null;
    if (work.still) {
      if (!img.data) throw new Error('the still frame came back without its beauty image');
      still = encodeRawPNG({ width, height, channels: 3, data: rgbaToRGB(img.data, width, height) });
    }
    const reply: FrameReply = {
      video,
      lossless,
      poster,
      still,
      tile,
      meta: img.meta ?? null,
      warnings: img.warnings ?? [],
      ms: performance.now() - t0,
    };
    if (work.digests) reply.digests = frameDigests(img);
    return reply;
  }

  /** The contact sheet PNG of the tiles (core contactSheet + encodePNG, as the server makes it). */
  contactSheet(
    tiles: { width: number; height: number; data: Uint8ClampedArray }[],
    labels: string[],
    columns: number,
  ): Uint8Array {
    return encodePNG(contactSheet(tiles, { columns, labels }));
  }

  /** The export's manifest (core buildManifest, from the snapshot). */
  manifest(r: ManifestRequest): Record<string, unknown> {
    const tracks = r.tracks.map((t) => {
      const s = new ShotTracks();
      s.camera.push(...t.camera);
      for (const [id, list] of t.subjects) s.subjects.set(id, list);
      return s;
    });
    return buildManifest({
      doc: this.document().doc,
      project: r.project,
      createdAt: r.createdAt,
      plan: r.plan,
      codec: r.codec,
      look: r.look,
      quality: r.quality,
      passes: r.passes,
      files: r.files,
      palette: r.palette,
      tracks,
      warnings: r.warnings,
    });
  }

  release(): { ok: true } {
    releaseRenderBuffers();
    return { ok: true };
  }

  /** Frees the snapshot. */
  clear(): void {
    this.entry?.doc.destroy();
    this.entry = null;
    this.job = null;
  }

  /** Answers one request (with the buffers to transfer). */
  async handle(
    msg: ExportWorkerRequest,
  ): Promise<{ response: ExportWorkerResponse; transfer: Transferable[] }> {
    try {
      switch (msg.type) {
        case 'init':
          return done(msg.id, this.init(msg.update));
        case 'plan':
          return done(msg.id, this.plan(msg.params, msg.stills));
        case 'job':
          return done(msg.id, this.setJob(msg.job));
        case 'shot':
          return done(msg.id, measureDeskShot(this.document(), msg.options));
        case 'simulate': {
          const sim = simulateRigidBodies(this.document(), msg.frames);
          return done(
            msg.id,
            sim,
            sim.frames.map((f) => f.matrices.buffer),
          );
        }
        case 'frame': {
          const r = await this.frame(msg.options, msg.work);
          return done(msg.id, r, frameTransferables(r));
        }
        case 'contact-sheet': {
          const png = this.contactSheet(msg.tiles, msg.labels, msg.columns);
          return done(msg.id, png, [png.buffer]);
        }
        case 'manifest':
          return done(msg.id, this.manifest(msg.request));
        case 'release':
          return done(msg.id, this.release());
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const code = (e as { code?: unknown }).code;
      return {
        response: {
          id: msg.id,
          ok: false,
          error: { message: e.message, name: e.name, ...(typeof code === 'string' ? { code } : {}) },
        },
        transfer: [],
      };
    }
  }
}

function done(
  id: number,
  result: ExportWorkerResponse extends infer R
    ? R extends { ok: true; result: infer T }
      ? T
      : never
    : never,
  transfer: Transferable[] = [],
): { response: ExportWorkerResponse; transfer: Transferable[] } {
  return { response: { id, ok: true, result }, transfer };
}
