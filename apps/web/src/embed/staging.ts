import type { DeskCheckResult, SceneBrief, ShotResultMeta } from '@3d-editor/core';
import { runStaging, type StagingReply, type StagingRequest, type StagingSummary } from './staging-engine';

/*
 * The page's side of the staging worker (stage.worker.ts): one worker, made when the desk starts
 * (its script loads with the page, so no request goes out later), requests answered in order. Where
 * the browser has no module workers (unit tests), the work runs in process. A request that fails
 * rejects with StagingError (its message and code); a worker that dies is made again for the next
 * request.
 */

export class StagingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'StagingError';
  }
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

export type StagingWorkerFactory = () => WorkerLike | null;

/** A staging or an update of the staging: the change to apply, its summary, the checks, the time. */
export type Staged = Extract<StagingReply, { kind: 'stage' | 'update' }> & {
  diff: Uint8Array;
  summary: StagingSummary;
  check: DeskCheckResult;
  ms: number;
};

/** The browser's module worker of stage.worker.ts (null where there are no workers). */
export const moduleStagingWorker: StagingWorkerFactory = () =>
  typeof Worker === 'function'
    ? (new Worker(new URL('./stage.worker.ts', import.meta.url), {
        type: 'module',
        name: 'desk-staging',
      }) as unknown as WorkerLike)
    : null;

export class StagingClient {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: StagingReply) => void; reject: (e: Error) => void }
  >();
  /** Requests run one after another (the worker handles one at a time anyway). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly factory: StagingWorkerFactory = moduleStagingWorker) {}

  /** Makes the worker now (its script loads while the page loads). */
  warm(): void {
    this.ensure();
  }

  private ensure(): WorkerLike | null {
    if (this.worker) return this.worker;
    let w: WorkerLike | null;
    try {
      w = this.factory();
    } catch {
      w = null;
    }
    if (!w) return null;
    w.onmessage = (e: MessageEvent<{ id: number; reply: StagingReply }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      p.resolve(e.data.reply);
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      this.fail(new StagingError(`the staging worker stopped: ${e.message || 'an error'}`, 'FAILED'));
    };
    this.worker = w;
    return w;
  }

  private fail(err: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private call(request: StagingRequest): Promise<StagingReply> {
    const run = async (): Promise<StagingReply> => {
      const w = this.ensure();
      if (!w) {
        // no workers here: in process, after a turn of the event loop so the page can paint first
        await new Promise((r) => setTimeout(r, 0));
        return runStaging(request);
      }
      const id = ++this.seq;
      return new Promise<StagingReply>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        w.postMessage({ id, request });
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The reply of a request of `kinds`, or its failure thrown as StagingError. */
  private static expect<R extends StagingReply & { ok: true }>(
    reply: StagingReply,
    kinds: readonly string[],
  ): R {
    if (!reply.ok) throw new StagingError(reply.error, reply.code);
    if (!kinds.includes(reply.kind))
      throw new StagingError(`the staging worker answered ${reply.kind} to ${kinds.join('/')}`, 'FAILED');
    return reply as R;
  }

  /** Stages `brief` in the document `update` holds (empty); the change, the checks and the time. */
  async stage(update: Uint8Array, brief: SceneBrief, lineage: string, generator: string): Promise<Staged> {
    return StagingClient.expect<Staged>(
      await this.call({ kind: 'stage', update, brief, lineage, generator }),
      ['stage'],
    );
  }

  /** Updates the staging of the document `update` holds to `brief`. */
  async update(update: Uint8Array, brief: SceneBrief): Promise<Staged> {
    return StagingClient.expect<Staged>(await this.call({ kind: 'update', update, brief }), ['update']);
  }

  /** The shot results of the document `update` holds (host shot ids `shots`, default all). */
  async results(update: Uint8Array, shots?: string[]): Promise<{ results: ShotResultMeta[]; ms: number }> {
    return StagingClient.expect<Extract<StagingReply, { kind: 'results' }>>(
      await this.call({ kind: 'results', update, shots }),
      ['results'],
    );
  }

  /** The desk's checks of the document `update` holds. */
  async check(update: Uint8Array): Promise<{ check: DeskCheckResult; ms: number }> {
    return StagingClient.expect<Extract<StagingReply, { kind: 'check' }>>(
      await this.call({ kind: 'check', update }),
      ['check'],
    );
  }

  dispose(): void {
    this.fail(new StagingError('the desk closed', 'CANCELLED'));
  }
}
