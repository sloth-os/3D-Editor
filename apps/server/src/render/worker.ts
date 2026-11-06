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

// JIT warm-up before the first request is answered (the pool's start-up ping waits for it, so
// the time it takes is not taken from a render's time limit)
try {
  engine.warmUp();
} catch (err) {
  console.warn(`render worker warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
}

function reply(id: number, result: WorkerResult, transfer: ArrayBuffer[] = []): void {
  const msg: WorkerResponse = { type: 'result', id, result };
  port!.postMessage(msg, transfer);
}

port.on('message', (msg: WorkerRequest) => {
  if (msg.type === 'release') {
    engine.release(msg.job);
    return;
  }
  if (msg.type === 'clear') {
    engine.clearDocuments();
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
      case 'encode':
      case 'apng-finish': {
        const encoded =
          msg.type === 'encode' ? engine.encode(msg.frames, msg.options) : engine.apngFinish(msg.job);
        reply(msg.id, encoded, [encoded.data.buffer as ArrayBuffer]);
        break;
      }
      case 'apng-add':
        reply(msg.id, engine.apngAdd(msg.job, msg.frame, msg.init));
        break;
      case 'auto-view':
        reply(msg.id, engine.autoView(msg.doc, msg.frames, msg.aspect, msg.camera, msg.budgetMs));
        break;
      case 'export': {
        const file = engine.exportFile(msg.doc, msg.format, msg.options);
        reply(msg.id, file, [file.data.buffer as ArrayBuffer]);
        break;
      }
      case 'simulate': {
        const sim = engine.simulate(msg.doc, msg.frames);
        reply(
          msg.id,
          sim,
          sim.frames.map((f) => f.matrices.buffer as ArrayBuffer),
        );
        break;
      }
      case 'ping':
        reply(msg.id, { ok: true });
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: 'error', id: msg.id, message } satisfies WorkerResponse);
  }
});
