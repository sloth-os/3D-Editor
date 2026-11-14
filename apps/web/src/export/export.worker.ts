/// <reference lib="webworker" />
import { ExportWorkerEngine, serveExportRequests, type ExportWorkerScope } from './worker-engine';

/*
 * A render worker of the browser video export (bundled by Vite as its own module worker and
 * precached by the PWA, like the render workers of path tracing): requests are handled one at a
 * time, in order (serveExportRequests: a reply that cannot be posted fails its request, and the
 * worker goes on serving the next ones); see protocol.ts.
 */

serveExportRequests(self as unknown as ExportWorkerScope, new ExportWorkerEngine());
