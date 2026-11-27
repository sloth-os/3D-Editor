import {
  BLOCK_KINDS,
  CURVE_MAPS,
  OperatorError,
  SceneDoc,
  THUMBNAIL_LOOK,
  THUMBNAIL_ORIGIN,
  THUMBNAIL_SIZE,
  THUMBNAIL_VERSION,
  stageBuiltinThumbnail,
  threeQuarterView,
  thumbnailFrameOptions,
  type OperatorRegistry,
} from '@3d-editor/core';
import { ToolError } from '../mcp/agent';
import { StoreCancelledError } from './http';
import type { RenderImageRequest, RenderImageResult } from '../render';

/*
 * Thumbnails of built-in models, rendered by the server for MCP agents and other clients of the
 * store's thumbnail route (external ones are fetched from their providers; the editor's Asset
 * Browser renders built-in thumbnails in the browser instead). What a thumbnail is — the model
 * alone in a document of its own, built by core's store.add, the three-quarter framing and the
 * clay look — lives in core (store/thumbnail.ts), which the browser's thumbnail workers use too:
 * both make the same PNG of a model. Here it is rendered on a render thread (renderer.renderImage:
 * never on the event loop in render-process mode) and cached as PNG by the store.
 *
 * The store stages its thumbnails in one document (ThumbnailStage), emptied before each model and
 * rendered one model at a time: render processes keep the few documents they last rendered
 * (render/engine.ts MAX_DOCUMENTS), and a new document per thumbnail would push the projects
 * being worked on out of that cache with every page of the asset browser.
 */

export { THUMBNAIL_LOOK, THUMBNAIL_SIZE, THUMBNAIL_VERSION, threeQuarterView };

/** Thumbnails a stage document holds in turn before a new one replaces it (it keeps a record of
 * each emptied model, small but growing). */
const STAGE_RENDERS = 50;
/** The document maps a model may write into (emptied between models). */
const STAGE_MAPS = [...BLOCK_KINDS, ...CURVE_MAPS, 'scene', 'render', 'world'] as const;

/** The renderer the thumbnails use (the server's; tests pass a fake). */
export interface ThumbnailRenderer {
  renderImage(req: RenderImageRequest): Promise<RenderImageResult>;
}

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
  let framing;
  try {
    framing = stageBuiltinThumbnail(doc, { id: opts.id }, opts.registry);
  } catch (err) {
    if (err instanceof OperatorError)
      throw new ToolError(err.message, err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FAILED');
    throw err;
  }
  const img = await opts.renderer.renderImage({
    scene: doc,
    projectId: 'store-thumbnails',
    options: thumbnailFrameOptions(framing, opts.size ?? THUMBNAIL_SIZE),
    signal: opts.signal,
  });
  return img.png;
}
