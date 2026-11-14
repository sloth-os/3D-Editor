/// <reference lib="webworker" />
import { handleThumbnailMessage } from './engine';

/*
 * Thumbnail worker entry point (bundled by Vite as a separate module worker, see pool.ts; precached
 * by the PWA like the other workers, so it starts offline). Each message is one render request,
 * handled to its end before the next (the page sends one at a time).
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<unknown>) => {
  const { response, transfer } = handleThumbnailMessage(e.data);
  scope.postMessage(response, transfer);
};
