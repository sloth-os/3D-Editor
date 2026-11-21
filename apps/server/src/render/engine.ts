import {
  APNGEncoder,
  PathFilm,
  PathTracer,
  SceneDoc,
  SceneEvaluator,
  TextureCache,
  autoFrameView,
  contactSheet,
  createExportRenderDocument,
  denoiseFilm,
  encodeGIF,
  encodePNG,
  evaluatedBounds,
  evaluatedOrco,
  exportScene,
  filmToRGBA8,
  measureDeskShot,
  preparePathTrace,
  renderExportFrame,
  renderItems,
  renderPathTracedImage,
  renderSceneSoftware,
  resolveView,
  sampleFrameIndices,
  simulateRigidBodies,
  softwareOptions,
  useFramePhysics,
  viewCameraData,
  type ExportFormat,
  type ExportRenderDocument,
  type PathTile,
  type PathTraceProgress,
  type PathTraceRenderInput,
  type Vec3,
} from '@3d-editor/core';
import type {
  APNGInit,
  AutoViewResult,
  DeskShotInfo,
  DeskShotOptions,
  DocRef,
  EncodeOptions,
  EncodedResult,
  ExportJobOptions,
  ExportedFile,
  FilmBuffers,
  FinishOptions,
  FrameOptions,
  ImageResult,
  PreparedInfo,
  RawFrame,
  SimulatedFrames,
  Vec3Tuple,
  Vec4Tuple,
} from './protocol';

/*
 * The rendering work done by one render thread (a render process, or the main thread in
 * single-thread mode): documents are rebuilt from Yjs state updates and cached together with their
 * scene evaluator (so geometry, instancing and rigid body caches survive between renders of the
 * same project), path traced renders are prepared once per job and then rendered in bands of rows.
 */

/**
 * Documents kept per render thread (least recently used ones are dropped): the documents of the
 * two long renders that may share a thread and of one quick render. The pool mirrors this cache
 * to leave out the states a render process already has (see `DocRef`).
 */
export const MAX_DOCUMENTS = 3;
/** Most frames evaluated to frame the automatic view of an animation (as core renderAnimation). */
const AUTO_VIEW_SAMPLES = 64;

const now = () => performance.now();

/**
 * A cached document: core's export render document (its evaluator, and the physics shared with the
 * thread for the frame it renders: `FrameOptions.physics`) with its version and last use.
 */
interface CachedDocument extends ExportRenderDocument {
  /** `DocRef.version` of the last applied state. */
  version: number;
  used: number;
}

/** True when a render with these options path traces (SOLID shading and wireframes rasterize). */
export function pathTraces(o: Pick<FrameOptions, 'engine' | 'shading' | 'wireframe'>): boolean {
  return o.engine === 'PATHTRACER' && o.shading !== 'SOLID' && !o.wireframe;
}

/**
 * The input of a path traced render, set up exactly like core `renderSceneSoftware` does (render
 * evaluation, visible geometry, camera precedence, depth of field, textures, orco).
 */
function pathTraceInput(
  doc: SceneDoc,
  evaluator: SceneEvaluator,
  options: FrameOptions,
): PathTraceRenderInput {
  const width = Math.round(options.width);
  const height = Math.round(options.height);
  const opts = softwareOptions(options);
  const scene = evaluator.evaluate(options.frame, { forRender: true });
  const items = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
  const view = resolveView(doc, scene, opts, width / height, evaluatedBounds(items));
  return {
    scene,
    items,
    view,
    camera: viewCameraData(doc, scene, opts),
    width,
    height,
    images: new TextureCache(doc),
    orco: (o) => evaluatedOrco(doc, scene, o.object, true),
    options: opts,
  };
}

/**
 * A request named a document version without its state (see `DocRef`) and this thread does not
 * have that version: the pool sends the request again with the state.
 */
export class MissingDocumentError extends Error {
  constructor(key: string, version: number) {
    super(`document ${key} version ${version} is not cached on this render thread`);
    this.name = 'MissingDocumentError';
  }
}

export class RenderEngine {
  private readonly docs = new Map<string, CachedDocument>();
  private readonly tracers = new Map<number, PathTracer>();
  private readonly encoders = new Map<number, APNGEncoder>();
  private clock = 0;

  /**
   * The cached document of `ref`, brought up to date with its state update. Throws a
   * {@link MissingDocumentError} when `ref` has no update and this version is not cached.
   */
  document(ref: DocRef): CachedDocument {
    let entry = this.docs.get(ref.key);
    if (!entry || entry.version !== ref.version) {
      const update = ref.update;
      if (!update) throw new MissingDocumentError(ref.key, ref.version);
      if (entry) entry.doc.applyUpdate(update, 'render');
      else {
        // matrices simulated once for every thread (FrameOptions.physics) replace the simulation
        entry = Object.assign(createExportRenderDocument(SceneDoc.fromUpdate(update)), {
          version: ref.version,
          used: 0,
        });
        this.docs.set(ref.key, entry);
      }
      entry.version = ref.version;
    }
    entry.used = ++this.clock;
    // after marking this document as used: a new document drops the least recently used other one
    // (not itself; the pool mirrors this order, see `DocRef`)
    this.evictDocuments();
    // shared physics only apply to the render they came with (see documentFor)
    entry.physics = null;
    return entry;
  }

  /** The cached document of `ref`, set up to use the physics of `options` (if any) for its frame. */
  private documentFor(ref: DocRef, options: FrameOptions): CachedDocument {
    const entry = this.document(ref);
    useFramePhysics(entry, options);
    return entry;
  }

  /**
   * Simulates the rigid body world up to `frames` (incrementally, cached per document like every
   * evaluation) and returns the world matrices of the simulated objects at each of them (core
   * `simulateRigidBodies`).
   */
  simulate(ref: DocRef, frames: number[]): SimulatedFrames {
    return simulateRigidBodies(this.document(ref), frames);
  }

  /**
   * Measures one shot of a video export (core `measureDeskShot`): its depth range, shadow box and
   * occlusion reach. The samples are evaluated without the rigid body simulation.
   */
  deskShot(ref: DocRef, options: DeskShotOptions): DeskShotInfo {
    return measureDeskShot(this.document(ref), options);
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
    const { doc, evaluator } = this.documentFor(ref, options);
    const input = pathTraceInput(doc, evaluator, options);
    const setupMs = now() - t0;
    const prepared = preparePathTrace(input);
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
      // the scene compiler's warnings name the objects (e.g. those with degenerate triangles)
      warnings: prepared.scene.warnings,
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
   * the PNG file is returned instead of the pixels. A video export frame (`options.desk`) also
   * returns its passes and metadata (desk.ts).
   */
  image(ref: DocRef, options: FrameOptions, png = false): ImageResult {
    const entry = this.documentFor(ref, options);
    const { doc, evaluator } = entry;
    if (options.desk) return renderExportFrame(entry, { ...options, desk: options.desk }, png);
    let last: PathTraceProgress | undefined;
    const onProgress = (p: PathTraceProgress) => {
      last = p;
    };
    let img: { width: number; height: number; data: Uint8ClampedArray };
    let warnings: string[] = [];
    if (pathTraces(options)) {
      // renderSceneSoftware's path tracing, with the warnings it does not return
      const input = pathTraceInput(doc, evaluator, options);
      const pt = renderPathTracedImage({ ...input, options: { ...input.options, onProgress } });
      img = pt;
      warnings = pt.stats.warnings ?? [];
    } else
      // Film > Transparent: core's rasterizer leaves the background transparent itself
      img = renderSceneSoftware(doc, { ...softwareOptions(options), evaluator, onProgress });
    const out: ImageResult = png
      ? { width: img.width, height: img.height, png: encodePNG(img) }
      : { width: img.width, height: img.height, data: img.data };
    if (last)
      out.pathtrace = {
        samples: last.samples,
        requested: last.total,
        stopped: last.samples < last.total ? 'time' : 'done',
      };
    if (warnings.length) out.warnings = warnings;
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

  /**
   * Exports the document (core `exportScene`): on a render thread, a long export (glTF animation
   * sampled frame by frame, texture bakes) does not hold up the server's event loop.
   */
  exportFile(ref: DocRef, format: ExportFormat, options: ExportJobOptions): ExportedFile {
    const t0 = now();
    const { doc } = this.document(ref);
    const res = exportScene(doc, format, options);
    return {
      data: res.data,
      mime: res.mime,
      extension: res.extension,
      warnings: res.warnings ?? [],
      ms: Math.round(now() - t0),
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
        for (let y = 0; y < info.height; y += 4)
          film.add(this.rows(-1, y, Math.min(info.height, y + 4), s, 2));
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
