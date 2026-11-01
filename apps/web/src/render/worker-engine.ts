import {
  APNGEncoder,
  PathTracer,
  SceneDoc,
  SceneEvaluator,
  decodePNG,
  denoiseFilm,
  encodeGIF,
  evaluatedBounds,
  evaluatedOrco,
  filmToRGBA8,
  preparePathTrace,
  renderItems,
  resolveView,
  sniffImageMime,
  viewCameraData,
  type AnimationFrame,
  type EvaluatedScene,
  type PathTile,
  type PathTraceRenderInput,
  type RenderItem,
  type SoftwareRenderOptions,
} from '@3d-editor/core';
import {
  StaleDocumentError,
  resultTransferables,
  type DocPayload,
  type EncodeOptions,
  type EncodedFile,
  type FilmBuffers,
  type FinishOptions,
  type PathTraceFrameOptions,
  type PixelImage,
  type PreparedInfo,
  type Vec4T,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from './protocol';

/*
 * The work done by one render worker (or, without Web Workers, by the main thread between event
 * loop turns): the document of the last render is kept with its scene evaluator, so geometry,
 * instancing and rigid body caches survive between renders and animation frames; path traced
 * renders are prepared once per job and then rendered in bands of rows; animations are encoded.
 */

/** RGBA8 sRGB image as the core renderers sample it (top row first). */
export type SampledTexture = NonNullable<ReturnType<PathTraceRenderInput['images']['get']>>;
type RenderView = PathTraceRenderInput['view'];

/** Decodes an image file the core cannot (JPEG, WebP, …) into pixels; null when it fails. */
export type ImageDecoder = (bytes: Uint8Array, mime: string) => Promise<SampledTexture | null>;

/**
 * The browser's image decoder (`createImageBitmap` + `OffscreenCanvas`, available in workers),
 * or null where the platform has none. Colours are kept as stored (no colour space conversion).
 */
export function browserImageDecoder(): ImageDecoder | null {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  return async (bytes, mime) => {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    try {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return { width: img.width, height: img.height, data: img.data };
    } finally {
      bmp.close();
    }
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Image datablocks a path traced render samples: material image slots and the world image. */
export function referencedImages(scene: EvaluatedScene, items: readonly RenderItem[]): string[] {
  const ids = new Set<string>();
  const seen = new Set<object>();
  for (const it of items)
    for (const m of it.materials) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      for (const slot of Object.values(m.textures ?? {}))
        if (slot && typeof slot === 'object' && slot.image && !slot.procedural) ids.add(slot.image);
    }
  const w = scene.world;
  if (w.environment === 'IMAGE' && w.environment_image) ids.add(w.environment_image);
  return [...ids];
}

interface CachedDocument {
  key: string;
  doc: SceneDoc;
  evaluator: SceneEvaluator;
}

interface EncoderSession {
  options: EncodeOptions;
  apng: APNGEncoder | null;
  /** GIF frames (encoded together at the end: one palette for the whole animation). */
  frames: AnimationFrame[];
  count: number;
}

/** The rendering and encoding work of one render worker. */
export class RenderWorkerEngine {
  private document: CachedDocument | null = null;
  private readonly tracers = new Map<number, PathTracer>();
  private readonly encoders = new Map<number, EncoderSession>();
  /** Decoded textures by image bytes (the document keeps the bytes of an image unchanged). */
  private readonly textures = new WeakMap<Uint8Array, SampledTexture | null>();

  constructor(private readonly decodeImage: ImageDecoder | null = browserImageDecoder()) {}

  /** Applies a document state: a full state replaces the cached document, a diff updates it. */
  applyDocument(p: DocPayload): CachedDocument {
    const cached = this.document;
    if (p.kind === 'diff') {
      if (!cached || cached.key !== p.key) throw new StaleDocumentError();
      if (p.update.length) cached.doc.applyUpdate(p.update, 'render');
      return cached;
    }
    if (cached?.key === p.key) {
      // the same document again (e.g. after a worker-side failure): merge instead of rebuilding
      cached.doc.applyUpdate(p.update, 'render');
      return cached;
    }
    cached?.doc.destroy();
    const doc = SceneDoc.fromUpdate(p.update);
    this.document = { key: p.key, doc, evaluator: new SceneEvaluator(doc) };
    return this.document;
  }

  /** Decodes the images a render needs (PNG by the core decoder, other formats by the browser). */
  private async decodeImages(doc: SceneDoc, ids: readonly string[]): Promise<Map<string, SampledTexture>> {
    const out = new Map<string, SampledTexture>();
    for (const id of ids) {
      const bytes = doc.getImageBytes(id);
      if (!bytes) continue;
      let tex = this.textures.get(bytes);
      if (tex === undefined) {
        tex = null;
        const mime = sniffImageMime(bytes) ?? doc.getImage(id)?.mime ?? '';
        try {
          if (mime === 'image/png') tex = decodePNG(bytes);
          else if (this.decodeImage && mime.startsWith('image/')) tex = await this.decodeImage(bytes, mime);
        } catch {
          tex = null;
        }
        if (tex && !(tex.width > 0 && tex.height > 0)) tex = null;
        this.textures.set(bytes, tex);
      }
      if (tex) out.set(id, tex);
    }
    return out;
  }

  /**
   * Evaluates and compiles a path traced render exactly like core `renderSceneSoftware`, and keeps a
   * tracer for `job` (rendered with {@link rows}, freed with {@link release}).
   */
  async prepare(job: number, payload: DocPayload, o: PathTraceFrameOptions): Promise<PreparedInfo> {
    const t0 = now();
    const { doc, evaluator } = this.applyDocument(payload);
    const width = Math.max(1, Math.round(o.width));
    const height = Math.max(1, Math.round(o.height));
    const scene = evaluator.evaluate(o.frame, { forRender: true });
    const items = renderItems(scene, { forRender: true }).filter((it) => it.mesh.faces.length > 0);
    const sw: SoftwareRenderOptions = {
      width,
      height,
      cameraId: o.cameraId,
      view: o.viewSpec
        ? { position: o.viewSpec.position, target: o.viewSpec.target, up: o.viewSpec.up, fovY: o.viewSpec.fovY }
        : undefined,
    };
    const view: RenderView = o.view
      ? (o.view as RenderView)
      : resolveView(doc, scene, sw, width / height, evaluatedBounds(items));
    const images = await this.decodeImages(doc, referencedImages(scene, items));
    const prepared = preparePathTrace({
      scene,
      items,
      view,
      camera: o.view ? null : viewCameraData(doc, scene, sw),
      width,
      height,
      images: { get: (id) => images.get(id) ?? null },
      orco: (it) => evaluatedOrco(doc, scene, it.object, true),
      options: {
        samples: o.samples,
        max_bounces: o.max_bounces,
        denoise: o.denoise,
        seed: o.seed,
        background: o.background,
      },
    });
    this.tracers.set(job, new PathTracer(prepared.scene, prepared.settings));
    const s = prepared.settings;
    return {
      width: s.width,
      height: s.height,
      samples: s.samples,
      denoise: s.denoise,
      exposure: prepared.exposure,
      viewTransform: prepared.viewTransform,
      displayBackground: prepared.displayBackground ? ([...prepared.displayBackground] as Vec4T) : null,
      warnings: [...prepared.scene.warnings],
      prepareMs: now() - t0,
    };
  }

  /** Renders rows [y0, y1) of a prepared job for samples [sampleStart, sampleStart + sampleCount). */
  rows(job: number, y0: number, y1: number, sampleStart: number, sampleCount: number): PathTile {
    const tracer = this.tracers.get(job);
    if (!tracer) throw new Error(`render job ${job} is not prepared on this worker`);
    return tracer.renderRows(y0, y1, sampleStart, sampleCount);
  }

  release(job: number): void {
    this.tracers.delete(job);
  }

  /** Denoises (optionally) and tone maps the mean film of a path traced render. */
  finish(film: FilmBuffers, o: FinishOptions): PixelImage {
    const linear = o.denoise ? denoiseFilm(film) : film.color;
    const data = filmToRGBA8(
      linear,
      film.width,
      film.height,
      o.exposure,
      o.viewTransform,
      o.displayBackground,
    );
    return { width: film.width, height: film.height, data };
  }

  encodeBegin(session: number, options: EncodeOptions): void {
    if (options.format !== 'APNG' && options.format !== 'GIF')
      throw new Error(`Unknown animation format '${String(options.format)}'`);
    const apng =
      options.format === 'APNG'
        ? new APNGEncoder(options.width, options.height, options.fps, { loop: options.loop })
        : null;
    this.encoders.set(session, { options, apng, frames: [], count: 0 });
  }

  encodeFrame(session: number, frame: PixelImage): void {
    const s = this.encoders.get(session);
    if (!s) throw new Error(`encoder session ${session} does not exist`);
    if (frame.width !== s.options.width || frame.height !== s.options.height)
      throw new Error(
        `frame size ${frame.width}×${frame.height} differs from the animation size ${s.options.width}×${s.options.height}`,
      );
    if (s.apng) s.apng.addFrame(frame);
    else s.frames.push(frame);
    s.count++;
  }

  encodeEnd(session: number): EncodedFile {
    const s = this.encoders.get(session);
    if (!s) throw new Error(`encoder session ${session} does not exist`);
    this.encoders.delete(session);
    if (!s.count) throw new Error('the animation has no frames');
    const data = s.apng
      ? s.apng.finish()
      : encodeGIF(s.frames, s.options.fps, { loop: s.options.loop, dither: s.options.dither });
    return { data, frames: s.count };
  }

  encodeAbort(session: number): void {
    this.encoders.delete(session);
  }

  /** Frees the cached document, tracers and encoders. */
  clear(): void {
    this.document?.doc.destroy();
    this.document = null;
    this.tracers.clear();
    this.encoders.clear();
  }
}

/** Runs one request on `engine` and posts the response (requests without an id get none). */
export async function handleWorkerMessage(
  engine: RenderWorkerEngine,
  msg: WorkerRequest,
  post: (res: WorkerResponse, transfer: ArrayBuffer[]) => void,
): Promise<void> {
  if (msg.type === 'release') return engine.release(msg.job);
  if (msg.type === 'encode-abort') return engine.encodeAbort(msg.session);
  let result: WorkerResult;
  try {
    switch (msg.type) {
      case 'prepare':
        result = await engine.prepare(msg.job, msg.doc, msg.options);
        break;
      case 'rows':
        result = engine.rows(msg.job, msg.y0, msg.y1, msg.sampleStart, msg.sampleCount);
        break;
      case 'finish':
        result = engine.finish(msg.film, msg.options);
        break;
      case 'encode-begin':
        engine.encodeBegin(msg.session, msg.options);
        result = { ok: true };
        break;
      case 'encode-frame':
        engine.encodeFrame(msg.session, msg.frame);
        result = { ok: true };
        break;
      case 'encode-end':
        result = engine.encodeEnd(msg.session);
        break;
      case 'ping':
        result = { ok: true };
        break;
      default:
        throw new Error(`unknown render worker request '${(msg as { type?: string }).type}'`);
    }
  } catch (err) {
    post(
      {
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
        code: err instanceof StaleDocumentError ? err.code : undefined,
      },
      [],
    );
    return;
  }
  post({ type: 'result', id: msg.id, result }, resultTransferables(result));
}
