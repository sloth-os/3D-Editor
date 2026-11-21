import { SceneDoc } from '../doc/scene-doc';
import { SceneEvaluator } from '../eval/evaluate';
import { renderItems } from '../eval/renderables';
import { createExportRenderDocument, renderExportFrame } from '../export/document';
import type { DeskFrameOptions, FrameOptions, ViewSpecInput } from '../export/protocol';
import { evaluatedBounds } from '../io/common';
import { OperatorError, createEditorState } from '../operators/context';
import { OperatorRegistry } from '../operators/registry';
import { registerStoreOperators } from '../operators/store';

/*
 * Thumbnails of the built-in models (spec §10): the model alone in a document of its own, built by
 * the operator store.add (so it looks as inserted), framed from in front, to the right as seen from
 * there and a little above (a three-quarter view filling the square) and rendered as a desk frame
 * in the 'clay' look with soft shadows and ambient occlusion, on a transparent background, as a PNG.
 *
 * The editor server's store (apps/server/src/store/thumbnails.ts, on its render processes) and the
 * web app's thumbnail workers (apps/web/src/assets/thumbnails) both make thumbnails with this
 * module: the same model at the same size is the same PNG, byte for byte, wherever it is made.
 * Nothing here touches Node or the DOM.
 */

/** Side of a thumbnail in pixels. */
export const THUMBNAIL_SIZE = 256;
/** Changes when thumbnails should be rendered again (framing, look). */
export const THUMBNAIL_VERSION = 1;
/** Anti-aliasing factor of a thumbnail render (RASTER samples). */
export const THUMBNAIL_SAMPLES = 2;

/** Vertical field of view of the thumbnail camera (a short telephoto: little distortion). */
const FOV_Y = (30 * Math.PI) / 180;
/** The view direction: 35° from the front (−Y) towards +X (right, seen from the front), 20° above. */
const AZIMUTH = (35 * Math.PI) / 180;
const ELEVATION = (20 * Math.PI) / 180;
/** Share of the frame the model fills (a margin around it). */
const FILL = 0.86;

/** Origin of the edits that build a thumbnail's model (never seen by anyone). */
export const THUMBNAIL_ORIGIN = { type: 'store-thumbnail' } as const;

/** The desk options of a thumbnail: the clay look with shadows and ambient occlusion. */
export const THUMBNAIL_LOOK: DeskFrameOptions = {
  look: 'clay',
  shadows: true,
  ao: true,
  msaa: true,
  passes: ['beauty'],
};

type Vec3 = [number, number, number];

/**
 * The view that frames the box `b` from the three-quarter direction: the camera looks at the box
 * centre from as close as it can while every corner stays inside the frame (`aspect` = width /
 * height).
 */
export function threeQuarterView(b: { min: Vec3; max: Vec3 }, aspect = 1, fovY = FOV_Y): ViewSpecInput {
  const centre: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  // from the target towards the camera: in front (−Y), to the right as seen from there (+X), above (+Z)
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

/** What a thumbnail render needs of the staged model: the frame it stands at and the view. */
export interface ThumbnailFraming {
  frame: number;
  view: ViewSpecInput;
}

/** A built-in model's thumbnail: its catalog id and, optionally, its own parameters (store.add's). */
export interface BuiltinThumbnailModel {
  /** Catalog id ('chair'; 'builtin:chair' works too). */
  id: string;
  /** The model's parameters (default: its defaults, as the catalog shows it). */
  params?: Record<string, unknown>;
}

let storeRegistry: OperatorRegistry | null = null;

/** A registry with the store operators alone (all a thumbnail needs: store.add). */
function thumbnailRegistry(): OperatorRegistry {
  if (!storeRegistry) {
    storeRegistry = new OperatorRegistry();
    registerStoreOperators(storeRegistry);
  }
  return storeRegistry;
}

/** The catalog id of `id` without the provider ('builtin:chair' → 'chair'). */
const bareId = (id: string) => id.replace(/^builtin:/i, '');

/**
 * Builds built-in model `model` into the empty document `doc` with core's store.add (at the origin,
 * as inserted) and frames it: the scene's first frame and the three-quarter view of what renders.
 * Throws an OperatorError: NOT_FOUND for an unknown model, FAILED when its build fails (bad
 * parameters included). `registry` runs store.add (default: one with the store operators alone).
 */
export function stageBuiltinThumbnail(
  doc: SceneDoc,
  model: BuiltinThumbnailModel,
  registry: OperatorRegistry = thumbnailRegistry(),
): ThumbnailFraming {
  const id = bareId(model.id);
  const res = registry.run(
    {
      doc,
      state: createEditorState(),
      origin: THUMBNAIL_ORIGIN,
      source: 'api',
      report: () => undefined,
    },
    'store.add',
    {
      model: `builtin:${id}`,
      location: [0, 0, 0],
      ...(model.params && Object.keys(model.params).length ? { params: model.params } : {}),
    },
  );
  if (!res.ok)
    throw new OperatorError(
      `The thumbnail of builtin:${id} could not be made: ${res.error ?? 'store.add failed'}`,
      res.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FAILED',
    );
  const frame = doc.getScene().frame_start;
  const scene = new SceneEvaluator(doc).evaluate(frame, { forRender: true });
  const bounds = evaluatedBounds(
    renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0),
  );
  return { frame, view: threeQuarterView(bounds ?? { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1] }, 1) };
}

/**
 * The render options of a thumbnail `size` pixels square: a RASTER desk frame in THUMBNAIL_LOOK,
 * THUMBNAIL_SAMPLES samples, on a transparent background (the asset browser shows thumbnails on its
 * own background).
 */
export function thumbnailFrameOptions(
  framing: ThumbnailFraming,
  size = THUMBNAIL_SIZE,
): FrameOptions & { desk: DeskFrameOptions } {
  return {
    width: size,
    height: size,
    frame: framing.frame,
    engine: 'RASTER',
    view: framing.view,
    samples: THUMBNAIL_SAMPLES,
    background: [0, 0, 0, 0],
    desk: THUMBNAIL_LOOK,
  };
}

/** A rendered thumbnail. */
export interface BuiltinThumbnailImage {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * Renders the thumbnail of built-in model `model` on this thread (a web worker's, or any other):
 * the model alone in a document of its own, staged and rendered as above, the document destroyed
 * after. The PNG is the one the editor server's store makes of the same model at the same size.
 * Throws an OperatorError (NOT_FOUND, FAILED) as stageBuiltinThumbnail does.
 */
export function renderBuiltinThumbnailPng(
  model: BuiltinThumbnailModel,
  size = THUMBNAIL_SIZE,
): BuiltinThumbnailImage {
  if (!(Number.isInteger(size) && size >= 16 && size <= 1024))
    throw new OperatorError(`A thumbnail is 16 to 1024 pixels square (got ${size})`, 'INVALID_PARAMS');
  const doc = SceneDoc.create({ empty: true, name: `thumbnail ${bareId(model.id)}` });
  try {
    const framing = stageBuiltinThumbnail(doc, model);
    const img = renderExportFrame(
      createExportRenderDocument(doc),
      thumbnailFrameOptions(framing, size),
      true,
    );
    if (!img.png)
      throw new OperatorError(`The thumbnail of builtin:${bareId(model.id)} rendered nothing`, 'FAILED');
    return { png: img.png, width: img.width, height: img.height };
  } finally {
    doc.destroy();
    doc.ydoc.destroy();
  }
}
