/// <reference lib="webworker" />
import type { ExportWorkerRequest } from './protocol';
import { ExportWorkerEngine } from './worker-engine';

/*
 * A render worker of the browser video export (bundled by Vite as its own module worker and
 * precached by the PWA, like the render workers of path tracing): requests are handled one at a
 * time, in order; see protocol.ts.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
const engine = new ExportWorkerEngine();
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent<ExportWorkerRequest>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    const { response, transfer } = await engine.handle(msg);
    scope.postMessage(response, transfer);
  });
};
