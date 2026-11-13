import {
  BLOCK_KINDS,
  CURVE_MAPS,
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  evaluatedBounds,
  renderItems,
  type OperatorRegistry,
  type ReportLevel,
} from '@3d-editor/core';
import { ToolError } from '../mcp/agent';
import { StoreCancelledError } from './http';
import type { RenderImageRequest, RenderImageResult } from '../render';
import type { DeskFrameOptions, ViewSpecInput } from '../render/protocol';

/*
 * Thumbnails of built-in models, rendered by the server (external ones are fetched from their
 * providers): the model alone in a document of its own (built by the core operator store.add, so
 * it looks as inserted), framed from the front-right and a little above (a three-quarter view
 * filling the square), rendered on a render thread (renderer.renderImage: never on the event loop
 * in render-process mode) in the 'clay' look with soft shadows and ambient occlusion, on a
 * transparent background, and cached as PNG by the store.
 *
 * The store stages its thumbnails in one document (ThumbnailStage), emptied before each model and
 * rendered one model at a time: render processes keep the few documents they last rendered
 * (render/engine.ts MAX_DOCUMENTS), and a new document per thumbnail would push the projects
 * being worked on out of that cache with every page of the asset browser.
 */

/** Side of a thumbnail in pixels. */
export const THUMBNAIL_SIZE = 256;
/** Changes when thumbnails should be rendered again (framing, look). */
export const THUMBNAIL_VERSION = 1;

/** Vertical field of view of the thumbnail camera (a short telephoto: little distortion). */
const FOV_Y = (30 * Math.PI) / 180;
/** The view direction: 35° to the model's right of its front (−Y), 20° above. */
const AZIMUTH = (35 * Math.PI) / 180;
const ELEVATION = (20 * Math.PI) / 180;
/** Share of the frame the model fills (a margin around it). */
const FILL = 0.86;

/** Origin of the thumbnail documents' edits (never seen by anyone). */
const THUMBNAIL_ORIGIN = { type: 'store-thumbnail' };
/** Thumbnails a stage document holds in turn before a new one replaces it (it keeps a record of
 * each emptied model, small but growing). */
const STAGE_RENDERS = 50;
/** The document maps a model may write into (emptied between models). */
const STAGE_MAPS = [...BLOCK_KINDS, ...CURVE_MAPS, 'scene', 'render', 'world'] as const;

type Vec3 = [number, number, number];

/**
 * The view that frames the box `b` from the three-quarter direction: the camera looks at the box
 * centre from as close as it can while every corner stays inside the frame (`aspect` = width /
 * height).
 */
export function threeQuarterView(b: { min: Vec3; max: Vec3 }, aspect = 1, fovY = FOV_Y): ViewSpecInput {
  const centre: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  // from the target towards the camera: in front (−Y), to the model's right (+X), above (+Z)
  const d: Vec3 = [
    Math.sin(AZIMUTH) * Math.cos(ELEVATION),
    -Math.cos(AZIMUTH) * Math.cos(ELEVATION),
    Math.sin(ELEVATION),
  ];
  // camera basis: right = d × up(+Z) normalised, up = right × d (the camera looks along −d)
  const rl = Math.hypot(d[1], d[0]);
  const right: Vec3 = [-d[1] / rl, d[0] / rl, 0];
  const up: Vec3 = [
    right[1] * d[2] - right[2] * d[1],
    right[2] * d[0] - right[0] * d[2],
    right[0] * d[1] - right[1] * d[0],
  ];
  const tanV = Math.tan(fovY / 2) * FILL;
  const tanH = tanV * aspect;
  let dist = 0;
  let extent = 0;
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
    const r: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    const x = r[0] * right[0] + r[1] * right[1] + r[2] * right[2];
    const y = r[0] * up[0] + r[1] * up[1] + r[2] * up[2];
    const z = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
    // the corner's depth is dist − z; it must see |x| ≤ tanH·depth and |y| ≤ tanV·depth
    dist = Math.max(dist, Math.abs(x) / tanH + z, Math.abs(y) / tanV + z);
    extent = Math.max(extent, Math.hypot(r[0], r[1], r[2]));
  }
  // a degenerate (empty or flat) box still gets a camera outside it
  dist = Math.max(dist, extent * 1.05, 0.05);
  return {
    position: [centre[0] + d[0] * dist, centre[1] + d[1] * dist, centre[2] + d[2] * dist],
    target: centre,
    up: [0, 0, 1],
    fovY,
  };
}

/** The renderer the thumbnails use (the server's; tests pass a fake). */
export interface ThumbnailRenderer {
  renderImage(req: RenderImageRequest): Promise<RenderImageResult>;
}

/** The desk options of a thumbnail: the clay look with shadows and ambient occlusion. */
export const THUMBNAIL_LOOK: DeskFrameOptions = {
  look: 'clay',
  shadows: true,
  ao: true,
  msaa: true,
  passes: ['beauty'],
};

/**
 * The document the store renders its built-in thumbnails in: one, reused (emptied before each
 * model; replaced after STAGE_RENDERS models), rendering one model at a time.
 */
export class ThumbnailStage {
  private doc: SceneDoc | null = null;
  private renders = 0;
  private turn: Promise<unknown> = Promise.resolve();

  /** The thumbnail of a built-in model (see {@link renderBuiltinThumbnail}), after those before it. */
  render(opts: Omit<BuiltinThumbnailOptions, 'stage'>): Promise<Uint8Array> {
    const run = this.turn.then(() => {
      if (opts.signal?.aborted) throw new StoreCancelledError(`the thumbnail of builtin:${opts.id}`);
      return renderInto(this.take(), opts);
    });
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** The stage document, empty (a new one after STAGE_RENDERS renders). */
  private take(): SceneDoc {
    if (this.doc && this.renders >= STAGE_RENDERS) this.close();
    const doc = (this.doc ??= SceneDoc.create({ empty: true, name: 'store thumbnails' }));
    if (this.renders++ > 0)
      doc.transact(() => {
        for (const name of STAGE_MAPS) doc.map(name).clear();
      }, THUMBNAIL_ORIGIN);
    return doc;
  }

  /** Lets the document go (a later render starts a new one). */
  close(): void {
    if (!this.doc) return;
    this.doc.destroy();
    this.doc.ydoc.destroy();
    this.doc = null;
    this.renders = 0;
  }
}

export interface BuiltinThumbnailOptions {
  id: string;
  registry: OperatorRegistry;
  renderer: ThumbnailRenderer;
  size?: number;
  signal?: AbortSignal;
  /** Where to stage the model (default: a document of its own, destroyed after the render). */
  stage?: ThumbnailStage;
}

/**
 * Renders the thumbnail (PNG) of built-in model `id` with core's store.add, alone in its document
 * (NOT_FOUND for an unknown model; FAILED when its build fails).
 */
export async function renderBuiltinThumbnail(opts: BuiltinThumbnailOptions): Promise<Uint8Array> {
  if (opts.stage) return opts.stage.render(opts);
  const doc = SceneDoc.create({ empty: true, name: `thumbnail ${opts.id}` });
  try {
    return await renderInto(doc, opts);
  } finally {
    doc.destroy();
    doc.ydoc.destroy();
  }
}

/** Builds built-in model `opts.id` into the empty document `doc` and renders its thumbnail. */
async function renderInto(doc: SceneDoc, opts: BuiltinThumbnailOptions): Promise<Uint8Array> {
  const size = opts.size ?? THUMBNAIL_SIZE;
  const reports: { level: ReportLevel; message: string }[] = [];
  const res = opts.registry.run(
    {
      doc,
      state: createEditorState(),
      origin: THUMBNAIL_ORIGIN,
      source: 'api',
      report: (level, message) => void reports.push({ level, message }),
    },
    'store.add',
    { model: `builtin:${opts.id}`, location: [0, 0, 0] },
  );
  if (!res.ok)
    throw new ToolError(
      `The thumbnail of builtin:${opts.id} could not be made: ${res.error ?? 'store.add failed'}`,
      res.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FAILED',
    );
  const frame = doc.getScene().frame_start;
  const scene = new SceneEvaluator(doc).evaluate(frame, { forRender: true });
  const bounds = evaluatedBounds(
    renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0),
  );
  const view = threeQuarterView(bounds ?? { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1] }, 1);
  const img = await opts.renderer.renderImage({
    scene: doc,
    projectId: 'store-thumbnails',
    options: {
      width: size,
      height: size,
      frame,
      engine: 'RASTER',
      view,
      samples: 2,
      // transparent: the asset browser shows thumbnails on its own background
      background: [0, 0, 0, 0],
      desk: THUMBNAIL_LOOK,
    },
    signal: opts.signal,
  });
  return img.png;
}
