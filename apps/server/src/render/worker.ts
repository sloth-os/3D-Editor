import v8 from 'node:v8';
import { Worker } from 'node:worker_threads';
import { MissingDocumentError, RenderEngine } from './engine';
import { lowerProcessPriority, preferOomKill, renderThreadNice } from './priority';
import type { WorkerErrorKind, WorkerRequest, WorkerResponse, WorkerResult } from './protocol';

/*
 * A render process (entry point `render-worker.js` of the production bundle; the sources run
 * through `worker-dev.mjs`), started by the render pool with `child_process.fork`. Handles one
 * request at a time, in order; see `protocol.ts`. When it runs out of memory only this process
 * ends: the pool answers its requests with an out-of-memory error and starts another one.
 */

/** How often the watchdog checks that the server is still running (ms). */
const WATCHDOG_INTERVAL_MS = 500;

const send = process.send?.bind(process);
if (!send)
  throw new Error('the render worker must run as a child process with an IPC channel (child_process.fork)');
process.title = '3d-editor-render';

// never outlive the server: its IPC channel closes when it stops, crashes or is killed
process.on('disconnect', () => process.exit(0));
if (!process.connected) process.exit(0);
// … but a busy process notices that only after its request: a watchdog thread checks every half
// second that the server is still its parent and ends this process at once when it is not (the
// server was killed or crashed; the system then adopts this process)
const watchdog = new Worker(
  `const { workerData } = require('node:worker_threads');
  setInterval(() => {
    if (process.ppid !== workerData.parent) process.kill(workerData.pid, 'SIGKILL');
  }, ${WATCHDOG_INTERVAL_MS});`,
  { eval: true, workerData: { parent: process.ppid, pid: process.pid } },
);
watchdog.on('error', (err) => console.warn(`render worker: watchdog failed: ${err.message}`));
watchdog.unref();

// below the server, which keeps serving editors, agents and health checks while every render
// process is busy; and the first the kernel ends when the machine runs out of memory (priority.ts)
const priority = renderThreadNice();
if (priority.problem) console.warn(`render worker: ${priority.problem}`);
lowerProcessPriority(priority.nice);
preferOomKill();

const engine = new RenderEngine();

// JIT warm-up before the process reports that it is ready (the pool waits for it, so the time it
// takes is not taken from a render's time limit)
try {
  engine.warmUp();
} catch (err) {
  console.warn(`render worker warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
}

function post(msg: WorkerResponse): void {
  // fails only when the server is gone (the process then exits on 'disconnect')
  send!(msg, undefined, undefined, () => undefined);
}

/** What kind of failure `err` is, for the pool (allocation failures replace the process). */
function errorKind(err: unknown): WorkerErrorKind | undefined {
  if (err instanceof MissingDocumentError) return 'missing-doc';
  if (err instanceof RangeError && /allocation failed|out of memory/i.test(err.message))
    return 'out-of-memory';
  return undefined;
}

/** The test-only requests (see protocol.ts), with RENDER_WORKER_TEST_JOBS=1 only. */
function testJob(msg: Extract<WorkerRequest, { type: 'test-allocate' | 'test-busy' }>): WorkerResult {
  if (process.env.RENDER_WORKER_TEST_JOBS !== '1')
    throw new Error(
      `'${msg.type}' is a test request: render processes answer it only with RENDER_WORKER_TEST_JOBS=1`,
    );
  if (msg.type === 'test-allocate') new Uint8Array(msg.bytes);
  else for (const end = Date.now() + msg.ms; Date.now() < end;);
  return { ok: true };
}

function handle(msg: WorkerRequest): WorkerResult {
  switch (msg.type) {
    case 'prepare':
      return engine.prepare(msg.job, msg.doc, msg.options);
    case 'rows':
      return engine.rows(msg.job, msg.y0, msg.y1, msg.sampleStart, msg.sampleCount);
    case 'image':
      return engine.image(msg.doc, msg.options, msg.png);
    case 'finish':
      return engine.finish(msg.film, msg.options);
    case 'encode':
      return engine.encode(msg.frames, msg.options);
    case 'apng-add':
      return engine.apngAdd(msg.job, msg.frame, msg.init);
    case 'apng-finish':
      return engine.apngFinish(msg.job);
    case 'auto-view':
      return engine.autoView(msg.doc, msg.frames, msg.aspect, msg.camera, msg.budgetMs);
    case 'export':
      return engine.exportFile(msg.doc, msg.format, msg.options);
    case 'simulate':
      return engine.simulate(msg.doc, msg.frames);
    case 'ping':
      return { ok: true };
    case 'test-allocate':
    case 'test-busy':
      return testJob(msg);
    case 'release':
    case 'clear':
      throw new Error(`'${msg.type}' has no answer`);
  }
}

process.on('message', (msg: WorkerRequest) => {
  if (msg.type === 'release') {
    engine.release(msg.job);
    return;
  }
  if (msg.type === 'clear') {
    engine.clearDocuments();
    // an idle process gives the memory of its documents back (the pool starts it with --expose-gc)
    (globalThis as { gc?: () => void }).gc?.();
    return;
  }
  try {
    post({ type: 'result', id: msg.id, result: handle(msg) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = errorKind(err);
    post({ type: 'error', id: msg.id, message, ...(kind ? { kind } : {}) });
  }
});

post({
  type: 'ready',
  pid: process.pid,
  heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)),
});
