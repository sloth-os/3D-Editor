import { OperatorError, renderBuiltinThumbnailPng } from '@3d-editor/core';
import { isRenderRequest, type ThumbnailErrorCode, type ThumbnailWorkerResponse } from './protocol';

/*
 * What a thumbnail worker does with a message (thumbnail.worker.ts runs it; the in-page fallback
 * and the unit tests call it directly): core's renderBuiltinThumbnailPng, the code the editor
 * server's store renders its built-in thumbnails with, so the PNG is the server's, byte for byte.
 */

/** The answer to `msg` and what to transfer with it (the PNG's buffer). */
export function handleThumbnailMessage(msg: unknown): {
  response: ThumbnailWorkerResponse;
  transfer: Transferable[];
} {
  const id = typeof (msg as { id?: unknown })?.id === 'number' ? (msg as { id: number }).id : -1;
  if (!isRenderRequest(msg))
    return {
      response: { type: 'error', id, message: 'Not a thumbnail request', code: 'INVALID' },
      transfer: [],
    };
  const t0 = performance.now();
  try {
    const img = renderBuiltinThumbnailPng({ id: msg.model, params: msg.params }, msg.size);
    return {
      response: {
        type: 'done',
        id,
        png: img.png,
        width: img.width,
        height: img.height,
        ms: performance.now() - t0,
      },
      transfer: [img.png.buffer],
    };
  } catch (err) {
    return {
      response: { type: 'error', id, message: messageOf(err), code: codeOf(err) },
      transfer: [],
    };
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function codeOf(err: unknown): ThumbnailErrorCode {
  if (!(err instanceof OperatorError)) return 'FAILED';
  if (err.code === 'NOT_FOUND') return 'NOT_FOUND';
  return err.code === 'INVALID_PARAMS' ? 'INVALID' : 'FAILED';
}
