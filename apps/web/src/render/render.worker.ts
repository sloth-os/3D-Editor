/// <reference lib="webworker" />
import { RenderWorkerEngine, handleWorkerMessage } from './worker-engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

/*
 * Render worker entry point (bundled by Vite as a separate module worker, see `pool.ts`). Requests
 * are handled one at a time, in order; see `protocol.ts`.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
const engine = new RenderWorkerEngine();
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  queue = queue.then(() =>
    handleWorkerMessage(engine, msg, (res: WorkerResponse, transfer) => scope.postMessage(res, transfer)),
  );
};
