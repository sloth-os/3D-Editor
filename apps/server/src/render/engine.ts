import {
  APNGEncoder,
  PathFilm,
  PathTracer,
  SceneDoc,
  SceneEvaluator,
  TextureCache,
  autoFrameView,
  contactSheet,
  denoiseFilm,
  encodeGIF,
  encodePNG,
  evaluatedBounds,
  evaluatedOrco,
  filmToRGBA8,
  preparePathTrace,
  renderItems,
  renderSceneSoftware,
  resolveView,
  sampleFrameIndices,
  viewCameraData,
  type PathTile,
  type PathTraceProgress,
  type SoftwareRenderOptions,
  type Vec3,
} from '@3d-editor/core';
import type {
  APNGInit,
  AutoViewResult,
  DocRef,
  EncodeOptions,
  EncodedResult,
  FilmBuffers,
  FinishOptions,
  FrameOptions,
  ImageResult,
  PreparedInfo,
  RawFrame,
  Vec3Tuple,
  Vec4Tuple,
} from './protocol';

/*
 * The rendering work done by one render thread (a worker, or the main thread in single-thread
 * mode): documents are rebuilt from Yjs state updates and cached together with their scene
 * evaluator (so geometry, instancing and rigid body caches survive between renders of the same
 * project), path traced renders are prepared once per job and then rendered in bands of rows.
 */

/**
 * Documents kept per render thread (least recently used ones are dropped): the documents of the
 * two long renders that may share a thread and of one quick render.
 */
const MAX_DOCUMENTS = 3;
/** Most frames evaluated to frame the automatic view of an animation (as core renderAnimation). */
const AUTO_VIEW_SAMPLES = 64;

const now = () => performance.now();

interface CachedDocument {
  doc: SceneDoc;
  evaluator: SceneEvaluator;
  /** `DocRef.version` of the last applied state. */
  version: number;
  used: number;
}

/** Converts frame options to the core software renderer options (engine always explicit). */
export function softwareOptions(o: FrameOptions): SoftwareRenderOptions {
  return {
    width: o.width,
    height: o.height,
    frame: o.frame,
    engine: o.engine,
    cameraId: o.cameraId,
    view: o.view
      ? { position: o.view.position, target: o.view.target, up: o.view.up, fovY: o.view.fovY }
      : undefined,
    shading: o.shading,
    wireframe: o.wireframe,
    samples: o.samples,
    max_bounces: o.max_bounces,
    denoise: o.denoise,
    time_limit: o.time_limit,
    seed: o.seed,
    background: o.background,
  };
}

/** True when a render with these options path traces (SOLID shading and wireframes rasterize). */
export function pathTraces(o: Pick<FrameOptions, 'engine' | 'shading' | 'wireframe'>): boolean {
  return o.engine === 'PATHTRACER' && o.shading !== 'SOLID' && !o.wireframe;
}

export class RenderEngine {
  private readonly docs = new Map<string, CachedDocument>();
  private readonly tracers = new Map<number, PathTracer>();
  private readonly encoders = new Map<number, APNGEncoder>();
  private clock = 0;

  /** The cached document of `ref`, brought up to date with its state update. */
  document(ref: DocRef): CachedDocument {
    let entry = this.docs.get(ref.key);
    if (!entry || entry.version !== ref.version) {
      const update = ref.update instanceof Uint8Array ? ref.update : new Uint8Array(ref.update);
      if (entry) entry.doc.applyUpdate(update, 'render');
      else {
        const doc = SceneDoc.fromUpdate(update);
        entry = { doc, evaluator: new SceneEvaluator(doc), version: ref.version, used: 0 };
        this.docs.set(ref.key, entry);
        this.evictDocuments();
      }
      entry.version = ref.version;
    }
    entry.used = ++this.clock;
    return entry;
  }

  private evictDocuments(): void {
    while (this.docs.size > MAX_DOCUMENTS) {
      let oldest: string | null = null;
      let used = Infinity;
      for (const [k, e] of this.docs)
        if (e.used < used) {
          used = e.used;
          oldest = k;
        }
      if (oldest === null) return;
      this.docs.get(oldest)!.doc.destroy();
      this.docs.delete(oldest);
    }
  }

  /**
   * Evaluates and compiles a path traced render exactly like `renderSceneSoftware` does, and keeps
   * a tracer for `job` (rendered with {@link rows}, freed with {@link release}).
   */
  prepare(job: number, ref: DocRef, options: FrameOptions): PreparedInfo {
    const t0 = now();
    const { doc, evaluator } = this.document(ref);
    const width = Math.round(options.width);
    const height = Math.round(options.height);
    const opts = softwareOptions(options);
    const scene = evaluator.evaluate(options.frame, { forRender: true });
    const setupMs = now() - t0;
    const items = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
    const view = resolveView(doc, scene, opts, width / height, evaluatedBounds(items));
    const prepared = preparePathTrace({
      scene,
      items,
      view,
      camera: viewCameraData(doc, scene, opts),
      width,
      height,
      images: new TextureCache(doc),
      orco: (o) => evaluatedOrco(doc, scene, o.object, true),
      options: opts,
    });
    this.tracers.set(job, new PathTracer(prepared.scene, prepared.settings));
    const s = prepared.settings;
    return {
      width: s.width,
      height: s.height,
      samples: s.samples,
      denoise: s.denoise,
      timeLimit: s.timeLimit,
      exposure: prepared.exposure,
      viewTransform: prepared.viewTransform,
      displayBackground: prepared.displayBackground ? ([...prepared.displayBackground] as Vec4Tuple) : null,
      warnings: [...prepared.scene.warnings],
      prepareMs: now() - t0,
      setupMs,
    };
  }

  /** Renders rows [y0, y1) of a prepared job for samples [sampleStart, sampleStart + sampleCount). */
  rows(job: number, y0: number, y1: number, sampleStart: number, sampleCount: number): PathTile {
    const tracer = this.tracers.get(job);
    if (!tracer) throw new Error(`render job ${job} is not prepared on this thread`);
    return tracer.renderRows(y0, y1, sampleStart, sampleCount);
  }

  /** Frees what a job keeps on this thread (path tracer, APNG encoder). */
  release(job: number): void {
    this.tracers.delete(job);
    this.encoders.delete(job);
  }

  /**
   * Adds the next frame to APNG job `job` (created by its first frame, from `init`): frames are
   * compressed here instead of on the main thread (core APNGEncoder, so the file is the one core
   * `renderAnimation` writes).
   */
  apngAdd(job: number, frame: RawFrame, init?: APNGInit): { ok: true } {
    let enc = this.encoders.get(job);
    if (!enc) {
      if (!init) throw new Error(`APNG job ${job} is not started on this thread`);
      enc = new APNGEncoder(init.width, init.height, init.fps, { loop: init.loop });
      this.encoders.set(job, enc);
    }
    enc.addFrame(frame);
    return { ok: true };
  }

  /** The APNG file of `job` (its encoder is freed). */
  apngFinish(job: number): EncodedResult {
    const enc = this.encoders.get(job);
    if (!enc) throw new Error(`APNG job ${job} is not started on this thread`);
    this.encoders.delete(job);
    return { data: enc.finish() };
  }

  /**
   * Renders a whole image on this thread (raster, or single-threaded path tracing); with `png`
   * the PNG file is returned instead of the pixels.
   */
  image(ref: DocRef, options: FrameOptions, png = false): ImageResult {
    const { doc, evaluator } = this.document(ref);
    let last: PathTraceProgress | undefined;
    const img = renderSceneSoftware(doc, {
      ...softwareOptions(options),
      evaluator,
      onProgress: (p) => {
        last = p;
      },
    });
    const out: ImageResult = png
      ? { width: img.width, height: img.height, png: encodePNG(img) }
      : { width: img.width, height: img.height, data: img.data };
    if (last)
      out.pathtrace = {
        samples: last.samples,
        requested: last.total,
        stopped: last.samples < last.total ? 'time' : 'done',
      };
    return out;
  }

  /** Denoises (optionally) and tone maps the mean film of a path traced render. */
  finish(film: FilmBuffers, o: FinishOptions): ImageResult {
    const linear = o.denoise ? denoiseFilm(film) : film.color;
    const data = filmToRGBA8(
      linear,
      film.width,
      film.height,
      o.exposure,
      o.viewTransform,
      o.displayBackground,
    );
    const img = { width: film.width, height: film.height, data };
    return o.png ? { width: img.width, height: img.height, png: encodePNG(img) } : img;
  }

  /**
   * The fixed automatic view of an animation without a camera, like core `renderAnimation`: the
   * default 3/4 view framing the union of the rendered geometry of (up to 64 of) its frames. Null
   * when `camera` is given or the scene has a camera.
   */
  autoView(ref: DocRef, frames: number[], aspect: number, camera?: string, budgetMs = 0): AutoViewResult {
    if (!frames.length) return null;
    const t0 = now();
    const { evaluator } = this.document(ref);
    const first = evaluator.evaluate(frames[0], { forRender: true });
    const cam = first.activeCamera;
    if (camera || (cam && cam.type === 'CAMERA' && cam.camera)) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const i of sampleFrameIndices(frames.length, AUTO_VIEW_SAMPLES)) {
      const scene = i === 0 ? first : evaluator.evaluate(frames[i], { forRender: true });
      const b = evaluatedBounds(
        renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0),
      );
      if (b && b.min.every(Number.isFinite) && b.max.every(Number.isFinite)) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], b.min[k]);
          max[k] = Math.max(max[k], b.max[k]);
        }
        any = true;
      }
      if (budgetMs > 0 && now() - t0 > budgetMs) break;
    }
    const v = autoFrameView(any ? { min, max } : null, aspect);
    return {
      position: [...v.position] as Vec3Tuple,
      target: [...v.target] as Vec3Tuple,
      up: [...v.up] as Vec3Tuple,
      fovY: v.fovY,
    };
  }

  /** Encodes kept animation frames as a GIF or a labelled contact sheet PNG. */
  encode(frames: RawFrame[], o: EncodeOptions): EncodedResult {
    if (o.format === 'GIF')
      return { data: encodeGIF(frames, o.fps, { loop: o.loop, dither: o.dither, colors: o.colors }) };
    const sheet = contactSheet(frames, { columns: o.columns, labels: o.labels });
    return { data: encodePNG(sheet), sheet: { width: sheet.width, height: sheet.height } };
  }

  /** Frees the cached documents (and their evaluator caches); prepared jobs are kept. */
  clearDocuments(): void {
    for (const e of this.docs.values()) e.doc.destroy();
    this.docs.clear();
  }

  /** Frees every cached document, tracer and encoder. */
  clear(): void {
    this.clearDocuments();
    this.tracers.clear();
    this.encoders.clear();
  }

  /**
   * Renders a tiny scene once, path traced (bands, denoised) and rasterized, so that a new
   * thread's first real render is not slowed down by JIT compilation: without it, the first
   * frames of a time-limited render on fresh threads come out at a fraction of their samples.
   */
  warmUp(): void {
    const doc = SceneDoc.create({ name: 'warm-up' });
    try {
      const ref: DocRef = { key: '\u0000warm-up', version: 0, update: doc.encodeState() };
      const options: FrameOptions = {
        width: 24,
        height: 16,
        frame: 1,
        engine: 'PATHTRACER',
        samples: 8,
        max_bounces: 3,
        denoise: true,
      };
      const info = this.prepare(-1, ref, options);
      const film = new PathFilm(info.width, info.height);
      for (let s = 0; s < info.samples; s += 2)
        for (let y = 0; y < info.height; y += 4) film.add(this.rows(-1, y, Math.min(info.height, y + 4), s, 2));
      this.finish(film.resolve(), { ...info, png: true });
      this.image(ref, { ...options, engine: 'RASTER', samples: 2 }, true);
    } finally {
      this.release(-1);
      this.docs.get('\u0000warm-up')?.doc.destroy();
      this.docs.delete('\u0000warm-up');
      doc.destroy();
    }
  }
}
