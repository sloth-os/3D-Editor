/*
 * Messages between the page and a thumbnail worker (thumbnail.worker.ts). The page sends one
 * render request at a time per worker (its queue stays on the page, where tiles that leave the
 * view are taken out of it); the worker answers each with the PNG (its buffer transferred) or an
 * error. Requests and answers carry the request's id.
 */

/** Renders the thumbnail of a built-in model. */
export interface ThumbnailRenderRequest {
  type: 'render';
  /** The request's id (its answer carries it). */
  id: number;
  /** Catalog id of the built-in model ('chair'). */
  model: string;
  /** Side of the square thumbnail in pixels. */
  size: number;
  /** The model's own parameters (store.add's `params`; none: its defaults). */
  params?: Record<string, unknown>;
}

export type ThumbnailWorkerRequest = ThumbnailRenderRequest;

/**
 * Why a thumbnail could not be made: NOT_FOUND (no such built-in model in this build), INVALID
 * (a size or parameters the model refuses), FAILED (its build or render failed).
 */
export type ThumbnailErrorCode = 'NOT_FOUND' | 'INVALID' | 'FAILED';

/** The PNG of a render request. */
export interface ThumbnailDone {
  type: 'done';
  id: number;
  png: Uint8Array;
  width: number;
  height: number;
  /** Milliseconds the worker spent (model build, framing, render and PNG encoding). */
  ms: number;
}

/** A render request that failed. */
export interface ThumbnailFailed {
  type: 'error';
  id: number;
  message: string;
  code: ThumbnailErrorCode;
}

export type ThumbnailWorkerResponse = ThumbnailDone | ThumbnailFailed;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Whether `x` is a render request a worker can act on (anything else is answered with an error). */
export function isRenderRequest(x: unknown): x is ThumbnailRenderRequest {
  return (
    isRecord(x) &&
    x.type === 'render' &&
    typeof x.id === 'number' &&
    typeof x.model === 'string' &&
    typeof x.size === 'number' &&
    (x.params === undefined || isRecord(x.params))
  );
}

/** Whether `x` is a worker's answer. */
export function isWorkerResponse(x: unknown): x is ThumbnailWorkerResponse {
  if (!isRecord(x) || typeof x.id !== 'number') return false;
  if (x.type === 'done') return x.png instanceof Uint8Array && typeof x.ms === 'number';
  return x.type === 'error' && typeof x.message === 'string' && typeof x.code === 'string';
}
