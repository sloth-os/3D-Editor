import {
  PathTracer,
  SceneDoc,
  SceneEvaluator,
  TextureCache,
  autoFrameView,
  evaluatedBounds,
  evaluatedOrco,
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
  AutoViewResult,
  DocRef,
  FrameOptions,
  ImageResult,
  PreparedInfo,
  Vec3Tuple,
  Vec4Tuple,
} from './protocol';

/*
 * The rendering work done by one render thread (a worker, or the main thread in single-thread
 * mode): documents are rebuilt from Yjs state updates and cached together with their scene
 * evaluator (so geometry, instancing and rigid body caches survive between renders of the same
 * project), path traced renders are prepared once per job and then rendered in bands of rows.
 */

/** Documents kept per render thread (least recently used ones are dropped). */
const MAX_DOCUMENTS = 2;
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
    view: o.view ? { position: o.view.position, target: o.view.target, up: o.view.up, fovY: o.view.fovY } : undefined,
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
      displayBackground: prepared.displayBackground
        ? ([...prepared.displayBackground] as Vec4Tuple)
        : null,
      warnings: [...prepared.scene.warnings],
      prepareMs: now() - t0,
    };
  }

  /** Renders rows [y0, y1) of a prepared job for samples [sampleStart, sampleStart + sampleCount). */
  rows(job: number, y0: number, y1: number, sampleStart: number, sampleCount: number): PathTile {
    const tracer = this.tracers.get(job);
    if (!tracer) throw new Error(`render job ${job} is not prepared on this thread`);
    return tracer.renderRows(y0, y1, sampleStart, sampleCount);
  }

  release(job: number): void {
    this.tracers.delete(job);
  }

  /** Renders a whole image on this thread (raster, or single-threaded path tracing). */
  image(ref: DocRef, options: FrameOptions): ImageResult {
    const { doc, evaluator } = this.document(ref);
    let last: PathTraceProgress | undefined;
    const img = renderSceneSoftware(doc, {
      ...softwareOptions(options),
      evaluator,
      onProgress: (p) => {
        last = p;
      },
    });
    const out: ImageResult = { width: img.width, height: img.height, data: img.data };
    if (last)
      out.pathtrace = {
        samples: last.samples,
        requested: last.total,
        stopped: last.samples < last.total ? 'time' : 'done',
      };
    return out;
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
      const b = evaluatedBounds(renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0));
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

  /** Frees every cached document and tracer. */
  clear(): void {
    for (const e of this.docs.values()) e.doc.destroy();
    this.docs.clear();
    this.tracers.clear();
  }
}
