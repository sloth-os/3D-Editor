/// <reference lib="webworker" />
import { replyTransfer, runStaging, type StagingRequest } from './staging-engine';

/*
 * The desk's staging worker (bundled by Vite as its own module worker and precached by the PWA):
 * staging, updating, shot results and checks off the page's main thread, one request at a time
 * (staging-engine.ts), and the library units' work (a unit made of the scene with its thumbnail, a
 * published unit adopted, an instance made local). Each request carries its id; the answer goes
 * back with it, its buffers transferred (the change; a unit's file and thumbnail).
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<{ id: number; request: StagingRequest }>) => {
  const { id, request } = e.data;
  const reply = runStaging(request);
  scope.postMessage({ id, reply }, replyTransfer(reply));
};
