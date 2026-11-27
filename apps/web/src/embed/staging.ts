import type {
  DeskCheckResult,
  SceneBrief,
  ShotResultMeta,
  UnitHeader,
  UnitLinkPlan,
  UnitSlot,
} from '@3d-editor/core';
import {
  runStaging,
  type StagingReply,
  type StagingRequest,
  type StagingSummary,
  type StagingUnits,
  type UnitExtract,
  type UnitTarget,
} from './staging-engine';

/*
 * The page's side of the staging worker (stage.worker.ts): one worker, made when the desk starts
 * (its script loads with the page, so no request goes out later), one request at a time. The
 * person's requests (staging, Update shots, an export's shot results) run in the order they come,
 * ahead of the background checks still waiting (a check of a long scene takes seconds; one already
 * running is not stopped). Where the browser has no module workers (unit tests), the work runs in
 * process. A request that fails rejects with StagingError (its message and code); a worker that dies
 * is made again for the next request. A staging given a signal (the open's: Close cancels it) is
 * stopped when the signal aborts: it rejects at once with the signal's reason, taken out of the
 * queue if it waits, its worker stopped (terminated, made again for the next request) if it runs
 * (in process it cannot be stopped: it rejects, and what it makes is dropped). A request may hand
 * over buffers (a transfer list: the library units' files, copies the page made for it); the worker
 * hands back its change and a unit's file and thumbnail the same way (stage.worker.ts).
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

/** Why a request stopped by `signal` ends: the signal's reason (an AbortError unless one was given). */
function stopReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The open was cancelled.', 'AbortError');
}

/** A request waiting for the worker. */
interface Queued {
  request: StagingRequest;
  /** Buffers the request hands over to the worker (none in process). */
  transfer: Transferable[];
  /** A background check: the person's requests go ahead of it. */
  background: boolean;
  resolve: (r: StagingReply) => void;
  reject: (e: unknown) => void;
  /** Stopped by its signal (it has rejected; run in process, it skips the work it has not begun). */
  stopped?: boolean;
}

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

/** The buffers of a request's unit files (handed over to the worker). */
const unitBuffers = (units: StagingUnits | undefined): Transferable[] =>
  units ? [...new Set(units.units.map((u) => u.data.buffer as ArrayBuffer))] : [];

export class StagingClient {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: StagingReply) => void; reject: (e: Error) => void }
  >();
  /** Requests waiting, in the order they run (the worker handles one at a time anyway). */
  private readonly queued: Queued[] = [];
  private running = false;
  /** The request running now (in the worker, or in process). */
  private current: Queued | null = null;

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

  /**
   * Queues a request: a background check last, any other ahead of the background checks waiting.
   * `signal` stops it (see the module comment).
   */
  private call(
    request: StagingRequest,
    background = false,
    signal?: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<StagingReply> {
    return new Promise<StagingReply>((resolve, reject) => {
      if (signal?.aborted) return reject(stopReason(signal));
      const onAbort = () => this.stop(job, stopReason(signal!));
      const settle = () => signal?.removeEventListener('abort', onAbort);
      const job: Queued = {
        request,
        transfer,
        background,
        resolve: (r) => {
          settle();
          resolve(r);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const at = background ? -1 : this.queued.findIndex((q) => q.background);
      if (at < 0) this.queued.push(job);
      else this.queued.splice(at, 0, job);
      this.next();
    });
  }

  /**
   * Stops request `job`: one waiting leaves the queue; the one running rejects now, and its worker
   * is stopped (the next request gets a new one). Either rejects with `reason`.
   */
  private stop(job: Queued, reason: Error): void {
    job.stopped = true;
    const at = this.queued.indexOf(job);
    if (at >= 0) {
      this.queued.splice(at, 1);
      job.reject(reason);
      return;
    }
    if (this.current !== job) return;
    job.reject(reason);
    // in process (no worker) the work cannot be stopped: what it makes is dropped
    if (this.worker) this.fail(reason);
  }

  /** Runs the first request waiting once the worker is free. */
  private next(): void {
    if (this.running) return;
    const job = this.queued.shift();
    if (!job) return;
    this.running = true;
    this.current = job;
    void this.run(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running = false;
        this.current = null;
        this.next();
      });
  }

  private async run(job: Queued): Promise<StagingReply> {
    const { request } = job;
    const w = this.ensure();
    if (!w) {
      // no workers here: in process, after a turn of the event loop so the page can paint first
      await new Promise((r) => setTimeout(r, 0));
      // stopped meanwhile: it has rejected already, and the work is not done
      if (job.stopped) throw new StagingError('the request was stopped', 'CANCELLED');
      return runStaging(request);
    }
    const id = ++this.seq;
    return new Promise<StagingReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, request }, job.transfer);
    });
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

  /**
   * Stages `brief` in the document `update` holds (empty); the change, the checks and the time.
   * `signal` (the open's) stops it: see the module comment. `units`: the open's library units (their
   * files handed over to the worker: give it copies); without them every pin is staged from the
   * words, as before units.
   */
  async stage(
    update: Uint8Array,
    brief: SceneBrief,
    lineage: string,
    generator: string,
    signal?: AbortSignal,
    units?: StagingUnits,
  ): Promise<Staged> {
    return StagingClient.expect<Staged>(
      await this.call(
        { kind: 'stage', update, brief, lineage, generator, ...(units ? { units } : {}) },
        false,
        signal,
        unitBuffers(units),
      ),
      ['stage'],
    );
  }

  /** Updates the staging of the document `update` holds to `brief` (with the library units held: see stage). */
  async update(update: Uint8Array, brief: SceneBrief, units?: StagingUnits): Promise<Staged> {
    return StagingClient.expect<Staged>(
      await this.call(
        { kind: 'update', update, brief, ...(units ? { units } : {}) },
        false,
        undefined,
        unitBuffers(units),
      ),
      ['update'],
    );
  }

  /** A unit of the document `update` holds (the set, an actor's figure or a prop), with its thumbnail. */
  async extractUnit(
    update: Uint8Array,
    what: UnitTarget,
    name: string,
    deskVersion: string,
  ): Promise<UnitExtract & { ms: number }> {
    return StagingClient.expect<Extract<StagingReply, { kind: 'unit-extract' }>>(
      await this.call({ kind: 'unit-extract', update, what, name, deskVersion }),
      ['unit-extract'],
    );
  }

  /** Links the document `update` holds to the version the host saved (core adoptPublished): the change. */
  async adoptUnit(
    update: Uint8Array,
    brief: SceneBrief,
    o: {
      slot: UnitSlot | null;
      link: UnitLinkPlan;
      pin: { ref: string; version: number; sha256: string };
      linked: boolean;
      header?: UnitHeader;
    },
  ): Promise<Extract<StagingReply, { kind: 'unit-adopt' }>> {
    return StagingClient.expect(await this.call({ kind: 'unit-adopt', update, brief, ...o }), ['unit-adopt']);
  }

  /** Cuts the link of instance `root` of the document `update` holds (core makeLocal): the change. */
  async makeLocal(update: Uint8Array, root: string): Promise<Extract<StagingReply, { kind: 'unit-local' }>> {
    return StagingClient.expect(await this.call({ kind: 'unit-local', update, root }), ['unit-local']);
  }

  /** The shot results of the document `update` holds (host shot ids `shots`, default all). */
  async results(update: Uint8Array, shots?: string[]): Promise<{ results: ShotResultMeta[]; ms: number }> {
    return StagingClient.expect<Extract<StagingReply, { kind: 'results' }>>(
      await this.call({ kind: 'results', update, shots }),
      ['results'],
    );
  }

  /**
   * The desk's checks of the document `update` holds. `background`: a check nobody waits for (the
   * person's requests go ahead of it while it waits).
   */
  async check(
    update: Uint8Array,
    opts: { background?: boolean } = {},
  ): Promise<{ check: DeskCheckResult; ms: number }> {
    return StagingClient.expect<Extract<StagingReply, { kind: 'check' }>>(
      await this.call({ kind: 'check', update }, opts.background === true),
      ['check'],
    );
  }

  dispose(): void {
    this.fail(new StagingError('the desk closed', 'CANCELLED'));
  }
}
