/// <reference lib="webworker" />
import { runStaging, type StagingRequest } from './staging-engine';

/*
 * The desk's staging worker (bundled by Vite as its own module worker and precached by the PWA):
 * staging, updating, shot results and checks off the page's main thread, one request at a time
 * (staging-engine.ts). Each request carries its id; the answer goes back with it.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<{ id: number; request: StagingRequest }>) => {
  const { id, request } = e.data;
  const reply = runStaging(request);
  const transfer = reply.ok && 'diff' in reply ? [reply.diff.buffer] : [];
  scope.postMessage({ id, reply }, transfer as Transferable[]);
};
