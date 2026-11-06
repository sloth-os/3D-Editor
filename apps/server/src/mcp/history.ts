import * as Y from 'yjs';

/*
 * Bounded undo histories for MCP agents.
 *
 * A Y.UndoManager keeps every item that a tracked transaction deleted (`item.keep`), so that undo
 * can restore it: Yjs never garbage collects kept items, and nothing ever clears the flag again —
 * not `UndoManager.destroy()`, and not the redo steps Yjs drops when a new change follows an undo
 * (they are un-kept but never collected). The server's replica of a project therefore kept every
 * version of every mesh an agent ever replaced, for as long as the project stayed loaded, and the
 * persisted document carried them too. One build of the lighthouse example (a batch of 146 vertex
 * paint dabs on a 16k-face terrain, 1.4 MB per mesh version) kept ~200 MB of old mesh blobs plus
 * ~700 MB of decoded copies in the document's mesh cache; rebuilding projects through MCP ran the
 * server out of memory.
 *
 * AgentHistory owns an agent's UndoManager in one project and keeps what it holds bounded:
 * - data created and deleted inside one step (a batch that edits the same mesh many times) is never
 *   needed to undo or redo that step (Yjs skips it), so it is collected right away;
 * - at most `maxSteps` undo steps are kept, and at most `maxBytes` of replaced or deleted data
 *   (the newest step is always kept); older steps are dropped and their data collected;
 * - steps that Yjs drops itself are collected: redo steps (a new change after an undo) and undo or
 *   redo steps that had nothing left to change when they were applied (Yjs discards those silently);
 * - restored copies (undo and redo restore deleted data as copies, which Yjs keeps from the start)
 *   that a change no agent tracks deletes (an editor, the REST API) are collected: no step can
 *   bring them back;
 * - when the history ends (the session or agent id expires, the project is deleted) everything it
 *   kept is collected, so the memory is freed while the project stays open for others.
 *
 * Collecting means clearing `keep` on the deleted items of the dropped steps (only on them, not on
 * their parents, which other steps may still need) and running Yjs's garbage collection over those
 * items: their content is replaced by a deleted placeholder, the item structs (and their `redone`
 * links, which undo follows) stay. A deleted container (a nested Y.Map such as an object) is
 * collected differently: Yjs replaces everything below it, kept or not, with bare placeholders
 * without links. Undo and redo restore deleted items as copies and link each original to its copy
 * (`redone`); undo and redo of every agent follow these links (to restore into a container's copy,
 * to delete what a step created). So a deleted container is only collected when nothing below it
 * is still kept by a step, is such a copy or has such a link; otherwise only the values below it
 * are (an undo failed inside Yjs when a copy below a collected container was reached). The same
 * protection applies to containers that changes no agent tracks delete (an editor), which Yjs
 * would collect at once.
 */

type StackItem = Y.UndoManager['undoStack'][number];

export interface HistoryLimits {
  /** Undo steps kept per agent and project; older steps are dropped. */
  maxSteps: number;
  /**
   * Replaced or deleted data kept for undo, per agent and project, in bytes (an estimate of the
   * items' content); the oldest steps are dropped beyond it, but the newest step is always kept.
   */
  maxBytes: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxSteps: 100,
  maxBytes: 64 * 1024 * 1024,
};

/** Limits with defaults for the missing (or undefined) ones. */
export function resolveHistoryLimits(limits: Partial<HistoryLimits> = {}): HistoryLimits {
  return {
    maxSteps: Math.max(1, Math.floor(limits.maxSteps ?? DEFAULT_HISTORY_LIMITS.maxSteps)),
    maxBytes: Math.max(0, limits.maxBytes ?? DEFAULT_HISTORY_LIMITS.maxBytes),
  };
}

export interface HistoryStats {
  /** Undo steps available. */
  steps: number;
  /** Redo steps available. */
  redo_steps: number;
  /** Bytes of replaced or deleted data the history keeps (estimate). */
  bytes: number;
  /** Steps dropped so far because of the limits. */
  dropped_steps: number;
  /** Deleted items collected so far (dropped steps, data created and deleted within a step). */
  released_items: number;
  /** Bytes collected so far (estimate). */
  released_bytes: number;
}

/** Transaction origin of the bookkeeping transactions (tracked by no undo manager). */
const GC_ORIGIN = { type: 'mcp-history-gc' };

/** Rough size in bytes of a JSON-like value (ContentAny / ContentJSON entries). */
function valueBytes(v: unknown, depth = 0): number {
  if (v === null || v === undefined) return 8;
  switch (typeof v) {
    case 'number':
    case 'boolean':
      return 8;
    case 'string':
      return 16 + v.length * 2;
    case 'object': {
      if (ArrayBuffer.isView(v)) return 64 + v.byteLength;
      if (depth > 6) return 64;
      if (Array.isArray(v)) {
        const n = v.length;
        if (n === 0) return 32;
        // long arrays: extrapolate from a sample
        const sample = n > 256 ? 64 : n;
        let s = 0;
        for (let i = 0; i < sample; i++) s += valueBytes(v[Math.floor((i * n) / sample)], depth + 1);
        return 32 + (s * n) / sample;
      }
      let s = 32;
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        s += 16 + k.length * 2 + valueBytes(x, depth + 1);
      return s;
    }
    default:
      return 16;
  }
}

/** Bytes of content an item holds (0 once collected). */
export function itemContentBytes(item: Y.Item): number {
  const c = item.content;
  if (c instanceof Y.ContentDeleted) return 0;
  if (c instanceof Y.ContentBinary) return 64 + c.content.byteLength;
  if (c instanceof Y.ContentString) return 64 + c.str.length * 2;
  if (c instanceof Y.ContentAny || c instanceof Y.ContentJSON) return 64 + valueBytes(c.arr);
  return 96; // types (their children are items of their own), formats, embeds, sub-documents
}

const isContainer = (item: Y.Item) => item.content instanceof Y.ContentType;

type DeleteSet = StackItem['deletions'];

/** Restored copies of each document: the insertions of the agents' undo and redo transactions. */
const copiesByDoc = new WeakMap<Y.Doc, DeleteSet>();

/** Records the items an undo or redo transaction created (copies the originals link to). */
function recordCopies(tr: Y.Transaction): void {
  const created = Y.createDeleteSet();
  tr.afterState.forEach((end, client) => {
    const start = tr.beforeState.get(client) ?? 0;
    if (end > start)
      (created.clients as Map<number, { clock: number; len: number }[]>).set(client, [
        { clock: start, len: end - start },
      ]);
  });
  if (!created.clients.size) return;
  const prev = copiesByDoc.get(tr.doc);
  copiesByDoc.set(tr.doc, prev ? Y.mergeDeleteSets([prev, created]) : created);
}

/** Whether any clock of `item` lies in `ds` (sorted, merged ranges). */
function overlaps(ds: DeleteSet, item: Y.Item): boolean {
  const ranges = ds.clients.get(item.id.client);
  if (!ranges?.length) return false;
  const end = item.id.clock + item.length;
  let lo = 0;
  let hi = ranges.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].clock < end) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return last >= 0 && ranges[last].clock + ranges[last].len > item.id.clock;
}

/**
 * Whether a deleted container can be collected (see above): it is no restored copy, and nothing
 * below it is kept by a step, is a restored copy or links to one.
 */
function collectable(container: Y.Item, copies: DeleteSet | undefined): boolean {
  if (copies && overlaps(copies, container)) return false;
  const clean = (item: Y.Item): boolean =>
    !item.keep &&
    item.redone === null &&
    !(copies && overlaps(copies, item)) &&
    (!(item.content instanceof Y.ContentType) || below(item.content.type));
  const below = (type: Y.AbstractType<any>): boolean => {
    for (let item = type._start; item; item = item.right) if (!clean(item)) return false;
    for (const last of type._map.values())
      for (let item: Y.Item | null = last; item; item = item.left) if (!clean(item)) return false;
    return true;
  };
  return below((container.content as Y.ContentType).type);
}

/** The live histories of each document (to tell changes some agent tracks from the others). */
const histories = new WeakMap<Y.Doc, Set<AgentHistory>>();

/** Whether an agent history records a transaction with this origin (its changes, its undo / redo). */
function trackedByAgent(doc: Y.Doc, origin: unknown): boolean {
  for (const h of histories.get(doc) ?? []) if (h.tracks(origin)) return true;
  return false;
}

/** Whether every clock of `item` lies in `ds`. */
function coveredBy(ds: StackItem['insertions'], item: Y.Item): boolean {
  const { client, clock } = item.id;
  if (!Y.isDeleted(ds, item.id)) return false;
  if (item.length === 1) return true;
  if (item.length > 64) return Y.isDeleted(ds, Y.createID(client, clock + item.length - 1));
  for (let i = 1; i < item.length; i++) if (!Y.isDeleted(ds, Y.createID(client, clock + i))) return false;
  return true;
}

export class AgentHistory {
  readonly undo: Y.UndoManager;
  private readonly limits: HistoryLimits;
  /** Kept bytes of the stack items already compacted. */
  private readonly sizes = new WeakMap<StackItem, number>();
  /** Stack items Yjs popped (undo / redo applied them: they are not dropped steps). */
  private readonly popped = new WeakSet<StackItem>();
  /** Popped stack items whose leaf content is not released yet. */
  private poppedPending: StackItem[] = [];
  /** The undo and redo stacks at the last maintenance (to find steps Yjs dropped since). */
  private seen: StackItem[] = [];
  /** Delete sets of the agent's changes since the last {@link compactStep}. */
  private pending: StackItem['deletions'][] = [];
  private scheduled = false;
  private destroyed = false;
  private readonly totals = { dropped_steps: 0, released_items: 0, released_bytes: 0 };

  constructor(
    private readonly doc: Y.Doc,
    scope: Y.AbstractType<any>[],
    private readonly origin: object,
    limits: Partial<HistoryLimits> = {},
  ) {
    this.limits = resolveHistoryLimits(limits);
    this.undo = new Y.UndoManager(scope, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    this.undo.on('stack-item-added', (e) => {
      this.sizes.delete(e.stackItem);
      this.schedule();
    });
    this.undo.on('stack-item-updated', (e) => {
      this.sizes.delete(e.stackItem);
      this.schedule();
    });
    this.undo.on('stack-item-popped', (e) => {
      this.popped.add(e.stackItem);
      this.poppedPending.push(e.stackItem);
      this.schedule();
    });
    this.undo.on('stack-cleared', () => this.schedule());
    // registered after the UndoManager's own handler: the step already holds the transaction
    doc.on('afterTransaction', this.onTransaction);
    let set = histories.get(doc);
    if (!set) histories.set(doc, (set = new Set()));
    set.add(this);
  }

  /** Whether this history records transactions with `origin` (the agent's changes, undo, redo). */
  tracks(origin: unknown): boolean {
    return origin === this.origin || origin === this.undo;
  }

  private readonly onTransaction = (tr: Y.Transaction): void => {
    if (tr.origin === this.undo && !tr.deleteSet.clients.size) recordCopies(tr);
    if (!tr.deleteSet.clients.size) return;
    if (tr.origin === this.origin) {
      if (!this.undo.undoing && !this.undo.redoing) this.pending.push(tr.deleteSet);
      return;
    }
    if (tr.origin === this.undo) {
      recordCopies(tr);
      // Undo / redo restored a copy into a container that is deleted by now: Yjs deletes the copy
      // in the same transaction but keeps it, and records no step when nothing else changed, so
      // nothing would ever release it. Copies created and deleted here are never restored.
      Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
        if (
          struct instanceof Y.Item &&
          struct.keep &&
          !isContainer(struct) &&
          struct.id.clock >= (tr.beforeState.get(struct.id.client) ?? 0)
        ) {
          struct.keep = false;
          this.totals.released_items++;
          this.totals.released_bytes += itemContentBytes(struct);
        }
      });
      return;
    }
    // A change no agent history records (an editor, the REST API, storage), handled by the first
    // history of the document, right before Yjs collects what the change deleted:
    // - restored copies it deleted: Yjs keeps those from the moment undo or redo creates them, but
    //   no step can bring them back now, so they are un-kept and collected;
    // - containers it deleted that Yjs would collect at once although undo still needs what is
    //   below them (see above) stay.
    const set = histories.get(this.doc);
    if (set?.values().next().value !== this || trackedByAgent(this.doc, tr.origin)) return;
    const copies = copiesByDoc.get(this.doc);
    const containers: Y.Item[] = [];
    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item)) return;
      if (isContainer(struct)) {
        if (!struct.keep) containers.push(struct);
      } else if (struct.keep) {
        struct.keep = false;
        this.totals.released_items++;
        this.totals.released_bytes += itemContentBytes(struct);
      }
    });
    for (const c of containers) if (!collectable(c, copies)) c.keep = true;
  };

  /**
   * Collects what the agent created and then deleted again since the step began, while the step
   * is still running (a batch replacing a large mesh hundreds of times would otherwise hold every
   * version until it ends). Call it between the operations of a step, outside any transaction.
   */
  compactStep(): void {
    if (!this.pending.length || this.destroyed || this.doc.isDestroyed || this.doc._transaction) return;
    const pending = this.pending;
    this.pending = [];
    const s = this.undo.undoStack[this.undo.undoStack.length - 1];
    if (!s) return;
    let churn = 0;
    let churnBytes = 0;
    const containers: Y.Item[] = [];
    this.doc.transact((tr) => {
      for (const ds of pending)
        Y.iterateDeletedStructs(tr, ds, (struct) => {
          if (!(struct instanceof Y.Item) || !struct.keep) return;
          if (!Y.isDeleted(s.deletions, struct.id) || !coveredBy(s.insertions, struct)) return;
          struct.keep = false;
          if (isContainer(struct)) containers.push(struct);
          churn++;
          churnBytes += itemContentBytes(struct);
        });
    }, GC_ORIGIN);
    this.protect(containers);
    if (!churn) return;
    this.collect(Y.mergeDeleteSets(pending));
    this.sizes.delete(s);
    this.totals.released_items += churn;
    this.totals.released_bytes += churnBytes;
  }

  get maxSteps(): number {
    return this.limits.maxSteps;
  }

  get maxBytes(): number {
    return this.limits.maxBytes;
  }

  /**
   * Runs the bookkeeping after the current synchronous work (the UndoManager reports its stacks
   * from inside the transaction cleanup, where Yjs must not be re-entered).
   */
  private schedule(): void {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.maintain();
    });
  }

  /** Kept bytes of a stack item; collects the data created and deleted within it on first use. */
  private sizeOf(s: StackItem): number {
    let size = this.sizes.get(s);
    if (size === undefined) {
      size = this.compact(s);
      this.sizes.set(s, size);
    }
    return size;
  }

  /**
   * Applies the limits now: compacts new steps, collects the redo steps Yjs dropped and drops the
   * oldest steps beyond `maxSteps` / `maxBytes`. Runs automatically after every change, undo and
   * redo; exposed for tests.
   */
  maintain(): void {
    if (this.destroyed || this.doc.isDestroyed) return;
    if (this.doc._transaction) {
      this.schedule();
      return;
    }
    const um = this.undo;
    this.pending = [];
    const release: StackItem[] = [];
    // steps that Yjs dropped since the last maintenance and that undo / redo did not apply: redo
    // steps cleared by a new change, and steps with nothing left to change, which undo and redo
    // discard without an event
    if (this.seen.length) {
      const live = new Set([...um.undoStack, ...um.redoStack]);
      for (const s of this.seen) if (!live.has(s) && !this.popped.has(s)) release.push(s);
    }
    let total = 0;
    for (const s of um.undoStack) total += this.sizeOf(s);
    for (const s of um.redoStack) total += this.sizeOf(s);
    while (um.undoStack.length > this.limits.maxSteps) {
      const s = um.undoStack.shift()!;
      total -= this.sizeOf(s);
      release.push(s);
      this.totals.dropped_steps++;
    }
    // over the memory budget: drop the oldest undo steps, then the furthest redo steps, but keep
    // the newest step (or, with nothing to undo, the next redo)
    while (total > this.limits.maxBytes) {
      let s: StackItem | undefined;
      if (um.undoStack.length > 1) s = um.undoStack.shift();
      else if (um.redoStack.length > (um.undoStack.length ? 0 : 1)) s = um.redoStack.shift();
      if (!s) break;
      total -= this.sizeOf(s);
      release.push(s);
      this.totals.dropped_steps++;
    }
    this.seen = [...um.undoStack, ...um.redoStack];
    this.release(release);
    if (this.poppedPending.length) {
      const popped = this.poppedPending;
      this.poppedPending = [];
      this.release(popped);
    }
  }

  /**
   * Collects the items of a step that were created and deleted within it (Yjs never restores
   * them: they are not part of the state before or after the step). Returns the bytes the step
   * still keeps.
   */
  private compact(s: StackItem): number {
    if (this.doc.isDestroyed) return 0;
    let kept = 0;
    let churn = 0;
    let churnBytes = 0;
    const containers: Y.Item[] = [];
    this.doc.transact((tr) => {
      Y.iterateDeletedStructs(tr, s.deletions, (struct) => {
        if (!(struct instanceof Y.Item)) return;
        const bytes = itemContentBytes(struct);
        if (struct.keep && coveredBy(s.insertions, struct)) {
          struct.keep = false;
          if (isContainer(struct)) containers.push(struct);
          churn++;
          churnBytes += bytes;
        } else kept += bytes;
      });
    }, GC_ORIGIN);
    this.protect(containers);
    if (churn) {
      this.collect(s.deletions);
      this.totals.released_items += churn;
      this.totals.released_bytes += churnBytes;
    }
    return kept;
  }

  /** Containers just un-kept that cannot be collected yet (see above) stay kept. */
  private protect(containers: Y.Item[]): void {
    if (!containers.length) return;
    const copies = copiesByDoc.get(this.doc);
    for (const c of containers) if (!collectable(c, copies)) c.keep = true;
  }

  /**
   * Clears `keep` on the deleted items of dropped (or applied) steps and collects them; containers
   * only when collectable (also those Yjs un-kept itself when it dropped redo steps).
   */
  private release(steps: StackItem[]): void {
    if (!steps.length || this.doc.isDestroyed) return;
    let items = 0;
    let bytes = 0;
    const containers: Y.Item[] = [];
    this.doc.transact((tr) => {
      for (const s of steps)
        Y.iterateDeletedStructs(tr, s.deletions, (struct) => {
          if (!(struct instanceof Y.Item)) return;
          if (isContainer(struct)) containers.push(struct);
          if (!struct.keep) return;
          bytes += itemContentBytes(struct);
          items++;
          struct.keep = false;
        });
    }, GC_ORIGIN);
    // after every item of these steps is un-kept: what is below a container may be theirs
    for (const c of containers) c.keep = false;
    this.protect(containers);
    this.collect(Y.mergeDeleteSets(steps.map((s) => s.deletions)));
    this.totals.released_items += items;
    this.totals.released_bytes += bytes;
  }

  /** Yjs garbage collection of the deleted, un-kept items in `ds` (outside any transaction). */
  private collect(ds: StackItem['deletions']): void {
    if (!this.doc.gc) return;
    Y.tryGc(ds, this.doc.store, this.doc.gcFilter);
  }

  stats(): HistoryStats {
    let bytes = 0;
    for (const s of this.undo.undoStack) bytes += this.sizes.get(s) ?? 0;
    for (const s of this.undo.redoStack) bytes += this.sizes.get(s) ?? 0;
    return {
      steps: this.undo.undoStack.length,
      redo_steps: this.undo.redoStack.length,
      bytes: Math.round(bytes),
      ...this.totals,
      released_bytes: Math.round(this.totals.released_bytes),
    };
  }

  /**
   * Ends the history: everything it kept is collected (unless the document is gone anyway) and the
   * UndoManager stops tracking.
   */
  destroy(): void {
    if (this.destroyed) return;
    if (!this.doc.isDestroyed && this.doc._transaction) {
      // called from inside a transaction: finish it first
      queueMicrotask(() => this.destroy());
      return;
    }
    this.destroyed = true;
    const live = new Set([...this.undo.undoStack, ...this.undo.redoStack]);
    // steps Yjs dropped since the last maintenance
    for (const s of this.seen) if (!this.popped.has(s)) live.add(s);
    const popped = this.poppedPending;
    this.undo.undoStack = [];
    this.undo.redoStack = [];
    this.seen = [];
    this.poppedPending = [];
    this.release([...live, ...popped]);
    this.pending = [];
    this.doc.off('afterTransaction', this.onTransaction);
    const set = histories.get(this.doc);
    set?.delete(this);
    if (set && !set.size) histories.delete(this.doc);
    this.undo.destroy();
  }
}
