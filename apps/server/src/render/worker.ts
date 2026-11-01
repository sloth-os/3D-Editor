import { parentPort } from 'node:worker_threads';
import { pathTileTransferables } from '@3d-editor/core';
import { RenderEngine } from './engine';
import type { WorkerRequest, WorkerResponse, WorkerResult } from './protocol';

/*
 * Render worker thread (entry point `render-worker.js` of the production bundle; the sources run
 * through `worker-dev.mjs`). Handles one request at a time, in order; see `protocol.ts`.
 */

const port = parentPort;
if (!port) throw new Error('the render worker must run in a worker thread');

const engine = new RenderEngine();

function reply(id: number, result: WorkerResult, transfer: ArrayBuffer[] = []): void {
  const msg: WorkerResponse = { type: 'result', id, result };
  port!.postMessage(msg, transfer);
}

port.on('message', (msg: WorkerRequest) => {
  if (msg.type === 'release') {
    engine.release(msg.job);
    return;
  }
  try {
    switch (msg.type) {
      case 'prepare':
        reply(msg.id, engine.prepare(msg.job, msg.doc, msg.options));
        break;
      case 'rows': {
        const tile = engine.rows(msg.job, msg.y0, msg.y1, msg.sampleStart, msg.sampleCount);
        reply(msg.id, tile, pathTileTransferables(tile));
        break;
      }
      case 'image':
      case 'finish': {
        const img =
          msg.type === 'image'
            ? engine.image(msg.doc, msg.options, msg.png)
            : engine.finish(msg.film, msg.options);
        const buffer = img.png?.buffer ?? img.data?.buffer;
        reply(msg.id, img, buffer ? [buffer as ArrayBuffer] : []);
        break;
      }
      case 'auto-view':
        reply(msg.id, engine.autoView(msg.doc, msg.frames, msg.aspect, msg.camera, msg.budgetMs));
        break;
      case 'ping':
        reply(msg.id, { ok: true });
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: 'error', id: msg.id, message } satisfies WorkerResponse);
  }
});
