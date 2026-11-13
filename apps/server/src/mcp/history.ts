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
 * - at most `maxSteps` undo steps are kept, and at most `maxBytes` of replaced or deleted data,
 *   each item counted with its share of a save ({@link BUDGET_BYTES_PER_ITEM}; the newest step is
 *   always kept); older steps are dropped and their data collected;
 * - steps that Yjs drops itself are collected: redo steps (a new change after an undo) and undo or
 *   redo steps that had nothing left to change when they were applied (Yjs discards those silently);
 * - restored copies (undo and redo restore deleted data as copies, which Yjs keeps from the start)
 *   that a change no agent tracks deletes (an editor, the REST API) are collected: no step can
 *   bring them back;
 * - when the history ends (the session or agent id expires, the project is deleted) everything it
 *   kept is collected, so the memory is freed while the project stays open for others; when the
 *   last history of a document ends, so is every item still kept in it.
 *
 * Collecting means clearing `keep` on the deleted items of the dropped steps (only on them, not on
 * their parents, which other steps may still need) and running Yjs's garbage collection over those
 * items: their content is replaced by a deleted placeholder, the item structs (and their `redone`
 * links, which undo follows) stay. Both happen in one transaction, and only on the clock ranges of
 * the steps. The values one client writes to one map key one after another (an agent moving an
 * object, renaming vertex groups, adding shape keys) are consecutive items, which Yjs merges into one
 * item once they are deleted (JSON-like values and strings; the merged item is kept when any part of
 * it is). Iterating a step's ranges splits such an item at the step's boundaries, and the cleanup of
 * the transaction merges the parts again, the kept parts giving `keep` back to the others: collected
 * before the transaction ends, a part holds a deleted placeholder, which never merges with values.
 * For the same reason, what a step created and deleted again is found by clock ranges (those in both
 * the step's insertions and its deletions), not by whole items: a merged item can hold a value from
 * before the step, which undo needs, and values the step created.
 *
 * A deleted container (a nested Y.Map such as an object) is collected differently: Yjs replaces
 * everything below it, kept or not, with bare placeholders without links. Undo and redo restore
 * deleted items as copies and link each original to its copy (`redone`); undo and redo of every
 * agent follow these links (to restore into a container's copy, to delete what a step created). So
 * a deleted container is collected right away only when nothing below it is still kept by a step,
 * is such a copy or has such a link. Otherwise only the values below it are (an undo failed inside
 * Yjs when a copy below a collected container was reached), and the container stays kept while a
 * live step of any agent can reach it or an item below it ({@link reachers}): no later step can, so
 * it is collected once those steps are dropped, applied or cleared ({@link recheck}). The same
 * applies to the containers that changes no agent tracks delete (an editor), which Yjs would
 * collect at once, restored copies included (Yjs keeps those).
 */

type StackItem = Y.UndoManager['undoStack'][number];

export interface HistoryLimits {
  /** Undo steps kept per agent and project; older steps are dropped. */
  maxSteps: number;
  /**
   * Replaced or deleted data kept for undo, per agent and project, in bytes (an estimate of the
   * items' content, and {@link BUDGET_BYTES_PER_ITEM} per item); the oldest steps are dropped
   * beyond it, but the newest step is always kept.
   */
  maxBytes: number;
}

/**
 * What `maxBytes` counts for each item a history keeps besides the item's bytes: its share of a
 * save. A save of the project takes 6 times the bytes the histories keep and 1,000 bytes for each
 * item (render/memory.ts HISTORY_SAVE_BYTES_PER_BYTE, HISTORY_SAVE_BYTES_PER_ITEM; 1,000 / 6,
 * rounded up), so what a history within its budget adds to a save is at most 6 times `maxBytes`,
 * also when it keeps many small values: counted by their bytes alone, 64 MB held 441,505 replaced
 * locations (152 bytes each), whose save was estimated at 805 MB, more than the server keeps for a
 * whole project with the default heap.
 */
export const BUDGET_BYTES_PER_ITEM = 167;

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
 * Whether a deleted container can be collected right away (see above): it is no restored copy, and
 * nothing below it is kept by a step, is a restored copy or links to one. One that cannot is still
 * collected when no live step can reach it ({@link keepForUndo}).
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

/** The undo and redo steps of the live histories of `doc`. */
function liveSteps(doc: Y.Doc): StackItem[] {
  const steps: StackItem[] = [];
  for (const h of histories.get(doc) ?? []) steps.push(...h.undo.undoStack, ...h.undo.redoStack);
  return steps;
}

/**
 * Calls `f` with every struct of `store` that has a clock in `ds` (whole structs, none split), until
 * `f` returns false.
 */
function structsIn(store: Y.Doc['store'], ds: DeleteSet, f: (struct: Y.AbstractStruct) => boolean): void {
  for (const [client, ranges] of ds.clients) {
    const structs = store.clients.get(client);
    if (!structs?.length) continue;
    const last = structs[structs.length - 1];
    const state = last.id.clock + last.length;
    for (const { clock, len } of ranges) {
      if (len <= 0 || clock >= state) continue;
      for (
        let i = Y.findIndexSS(structs, clock);
        i < structs.length && structs[i].id.clock < clock + len;
        i++
      )
        if (!f(structs[i])) return;
    }
  }
}

/** Calls `f` with every item below the container `c` (in its map and its list, nested ones too). */
function forEachBelow(c: Y.Item, f: (item: Y.Item) => void): void {
  const below = (type: Y.AbstractType<any>): void => {
    for (let item = type._start; item; item = item.right) visit(item);
    for (const last of type._map.values())
      for (let item: Y.Item | null = last; item; item = item.left) visit(item);
  };
  const visit = (item: Y.Item): void => {
    f(item);
    if (item.content instanceof Y.ContentType) below(item.content.type);
  };
  below((c.content as Y.ContentType).type);
}

/** Whether an item below the container `c` is kept. */
function keptBelow(c: Y.Item): boolean {
  let kept = false;
  forEachBelow(c, (item) => {
    if (item.keep) kept = true;
  });
  return kept;
}

/**
 * The live steps of `doc` in the order {@link reachers} visits them: the undo steps of all histories
 * from the newest (those kept longest), then the redo steps (the agent's next change clears them). So
 * the steps that count as reaching everything past {@link reachSearch}'s budget are those dropped
 * soonest.
 */
function stepsNewestFirst(doc: Y.Doc): StackItem[] {
  const hs = [...(histories.get(doc) ?? [])];
  const steps: StackItem[] = [];
  for (let i = 1, more = true; more; i++) {
    more = false;
    for (const h of hs) {
      const undo = h.undo.undoStack;
      if (undo.length < i) continue;
      steps.push(undo[undo.length - i]);
      more = true;
    }
  }
  for (const h of hs) steps.push(...h.undo.redoStack);
  return steps;
}

/**
 * `budget`: items the live steps may visit at most when the server looks for those that reach
 * containers ({@link reachers}; tests lower it). A visit takes 0.1–0.2 µs (measured over 200,000 and
 * 500,000 items), so a search takes 10–30 ms at most.
 */
export const reachSearch = { budget: 100_000 };

/**
 * For each deleted container of `candidates`, the live undo and redo steps of `doc`'s histories that
 * can reach it or an item below it by the links Yjs 13.6's UndoManager follows: undoing or redoing a
 * step follows the `redone` links of the items it inserted, to delete their latest copies
 * (popStackItem), and those of the items it deleted and of their deleted parents, to restore into
 * the parent's latest copy (redoItem). A collected container keeps its own link, but the items below
 * it are replaced by bare placeholders: a link that leads below it would end there (an undo then
 * leaves a copy it should delete, or fails inside Yjs). redoItem also walks the items next to a
 * deleted item (after it under its key, or in its list) and their links: those are the children of
 * its parent or of the parent's copies, which the parent's links reach. Past the budget of
 * {@link reachSearch}, every step left counts as reaching every candidate.
 */
function reachers(doc: Y.Doc, candidates: Set<Y.Item>): Map<Y.Item, Set<StackItem>> {
  const store = doc.store;
  const out = new Map<Y.Item, Set<StackItem>>();
  const reached = (c: Y.Item, s: StackItem): void => {
    let steps = out.get(c);
    if (!steps) out.set(c, (steps = new Set()));
    steps.add(s);
  };
  let budget = reachSearch.budget;
  for (const s of stepsNewestFirst(doc)) {
    if (budget > 0) {
      const seen = new Set<Y.Item>();
      const queue: Y.Item[] = [];
      /** Visits `struct` once; false when the budget is spent. */
      const visit = (struct: Y.AbstractStruct | null): boolean => {
        if (budget <= 0) return false;
        if (!(struct instanceof Y.Item) || seen.has(struct)) return true;
        seen.add(struct);
        budget--;
        for (let item: Y.Item | null = struct; item; item = (item.parent as Y.AbstractType<any>)._item)
          if (candidates.has(item)) reached(item, s);
        queue.push(struct);
        return true;
      };
      structsIn(store, s.insertions, visit);
      structsIn(store, s.deletions, (d) => {
        if (!(d instanceof Y.Item)) return true;
        const parent = (d.parent as Y.AbstractType<any>)._item;
        return visit(d) && (!parent?.deleted || visit(parent));
      });
      for (let item = queue.pop(); item && budget > 0; item = queue.pop())
        if (item.redone) visit(Y.getItem(store, item.redone));
    }
    // past the budget (also for this step, when it ran out in it), it counts as reaching them all
    if (budget <= 0) for (const c of candidates) reached(c, s);
  }
  return out;
}

/**
 * Deleted containers kept because live steps could reach them or items below them, with those
 * steps: no later step can (a step reaches the items that were alive when it was recorded and the
 * copies undo and redo make from then on), so they are collected once none of those steps is left
 * ({@link recheck}). `items`: the items they keep (themselves and those below them).
 */
interface Guard {
  containers: Y.Item[];
  steps: Set<StackItem>;
  items: number;
}

const guardsByDoc = new WeakMap<Y.Doc, Guard[]>();

/**
 * Decides which of the deleted containers `containers`, un-kept and not {@link collectable} right
 * away, stay kept: those a live step can reach ({@link reachers}), until none of those steps is left
 * ({@link recheck}), and those below which something else is still kept. The others are left
 * un-kept for the caller to collect, and returned.
 */
function keepForUndo(doc: Y.Doc, containers: Y.Item[]): Y.Item[] {
  if (!containers.length) return [];
  const candidates = new Set(containers);
  for (const c of candidates) c.keep = false;
  const reach = reachers(doc, candidates);
  // containers reached by the same steps are kept together
  const ids = new Map<StackItem, number>();
  const idOf = (s: StackItem): number => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };
  const groups = new Map<string, Guard>();
  for (const [c, steps] of reach) {
    c.keep = true;
    const key = [...steps]
      .map(idOf)
      .sort((a, b) => a - b)
      .join();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { containers: [], steps, items: 0 }));
    g.containers.push(c);
    // counted once: with the kept container above it, if any
    let above = (c.parent as Y.AbstractType<any>)._item;
    while (above && !reach.has(above)) above = (above.parent as Y.AbstractType<any>)._item;
    if (above) continue;
    g.items++;
    forEachBelow(c, () => g.items++);
  }
  if (groups.size) {
    const guards = guardsByDoc.get(doc) ?? [];
    guards.push(...groups.values());
    guardsByDoc.set(doc, guards);
  }
  const free: Y.Item[] = [];
  for (const c of candidates) {
    if (c.keep) continue;
    // kept by nothing a step reaches: left kept until the last history of the document ends
    if (keptBelow(c)) c.keep = true;
    else free.push(c);
  }
  return free;
}

/**
 * Collects the containers {@link keepForUndo} kept in `doc` none of whose steps is left (dropped,
 * applied or cleared), unless something below them is still kept; calls `released` with each.
 */
function recheck(doc: Y.Doc, released: (item: Y.Item) => void): void {
  const guards = guardsByDoc.get(doc);
  if (!guards?.length || doc.isDestroyed) return;
  const live = new Set(liveSteps(doc));
  const freed: Y.Item[] = [];
  const left: Guard[] = [];
  for (const g of guards) {
    for (const s of g.steps) if (!live.has(s)) g.steps.delete(s);
    if (g.steps.size) left.push(g);
    else freed.push(...g.containers);
  }
  guardsByDoc.set(doc, left);
  if (!freed.length) return;
  const store = doc.store;
  // still the containers they were (not collected with a container above them since)
  const valid = freed.filter(
    (c) => c.deleted && c.content instanceof Y.ContentType && Y.getItem(store, c.id) === c,
  );
  if (!valid.length) return;
  doc.transact(() => {
    // all first: one can be below another
    for (const c of valid) c.keep = false;
    const ds = Y.createDeleteSet();
    const ranges = ds.clients as Map<number, { clock: number; len: number }[]>;
    for (const c of valid) {
      if (keptBelow(c)) {
        c.keep = true;
        continue;
      }
      let r = ranges.get(c.id.client);
      if (!r) ranges.set(c.id.client, (r = []));
      r.push({ clock: c.id.clock, len: c.length });
      released(c);
    }
    if (doc.gc && ranges.size) Y.tryGc(Y.mergeDeleteSets([ds]), store, doc.gcFilter);
  }, GC_ORIGIN);
}

/**
 * The clock ranges in both `a` and `b`, per client (sorted and merged, like every DeleteSet Yjs
 * builds; empty when they share none).
 */
function intersect(a: DeleteSet, b: DeleteSet): DeleteSet {
  const out = Y.createDeleteSet();
  const byClock = (x: { clock: number }, y: { clock: number }) => x.clock - y.clock;
  a.clients.forEach((ra, client) => {
    const rb = b.clients.get(client);
    if (!rb?.length || !ra.length) return;
    const A = [...ra].sort(byClock);
    const B = [...rb].sort(byClock);
    const both: { clock: number; len: number }[] = [];
    for (let i = 0, j = 0; i < A.length && j < B.length;) {
      const endA = A[i].clock + A[i].len;
      const endB = B[j].clock + B[j].len;
      const start = Math.max(A[i].clock, B[j].clock);
      const end = Math.min(endA, endB);
      if (start < end) both.push({ clock: start, len: end - start });
      if (endA < endB) i++;
      else j++;
    }
    if (both.length) (out.clients as Map<number, { clock: number; len: number }[]>).set(client, both);
  });
  // sorted and merged (overlapping ranges of unmerged inputs would visit items twice)
  return Y.mergeDeleteSets([out]);
}

/**
 * Clears every `keep` flag in `doc` and collects every deleted item, when the last history of the
 * document ended: nothing can undo or redo anything in it any more (the server creates no other undo
 * managers), while deleted containers stayed kept for the steps that could reach them, and items Yjs
 * kept itself (containers above the items of tracked deletions). Collected, a container's items are
 * replaced by placeholders that merge: the document keeps hardly more than without the histories.
 */
function sweep(doc: Y.Doc): void {
  copiesByDoc.delete(doc);
  guardsByDoc.delete(doc);
  if (doc.isDestroyed || !doc.gc) return;
  doc.transact(() => {
    for (const structs of doc.store.clients.values())
      for (const struct of structs) if (struct instanceof Y.Item && struct.keep) struct.keep = false;
    Y.tryGc(Y.createDeleteSetFromStructStore(doc.store), doc.store, doc.gcFilter);
  }, GC_ORIGIN);
}

/** What an undo history keeps: deleted items whose content it holds, and the bytes of that content. */
export interface HistoryKept {
  /** Bytes of the items' content (an estimate, {@link itemContentBytes}). */
  bytes: number;
  /** Items (Yjs structs, a run of merged values counting once). */
  items: number;
}

/**
 * Heap one item of a deleted container kept for undo's links ({@link keepForUndo}) takes: the
 * container, and below it the items whose values were collected (a cube object has 30). Measured,
 * after full garbage collections, over rounds of deleting 400 and 1,000 linked cubes and undoing it:
 * 225–274 bytes per item kept (6.8–8.2 KB per cube); rounded up.
 */
export const KEPT_CONTAINER_ITEM_BYTES = 280;

/**
 * What the agents' undo histories in `doc` keep together ({@link AgentHistory.kept}; nothing when it
 * has none), and the deleted containers kept for undo's links ({@link KEPT_CONTAINER_ITEM_BYTES} per
 * item, in `bytes`). The server's memory checks count it with what the project keeps
 * (render/memory.ts).
 */
export function historyKept(doc: Y.Doc): HistoryKept {
  const total = { bytes: 0, items: 0 };
  for (const h of histories.get(doc) ?? []) {
    const k = h.kept();
    total.bytes += k.bytes;
    total.items += k.items;
  }
  for (const g of guardsByDoc.get(doc) ?? []) total.bytes += KEPT_CONTAINER_ITEM_BYTES * g.items;
  return total;
}

/** Bytes and items of the deleted items in `ds` whose content the document still holds. */
function heldIn(tr: Y.Transaction, ds: DeleteSet): HistoryKept {
  const held = { bytes: 0, items: 0 };
  Y.iterateDeletedStructs(tr, ds, (struct) => {
    if (!(struct instanceof Y.Item) || struct.content instanceof Y.ContentDeleted) return;
    held.bytes += itemContentBytes(struct);
    held.items++;
  });
  return held;
}

export class AgentHistory {
  readonly undo: Y.UndoManager;
  private readonly limits: HistoryLimits;
  /** What the stack items already compacted keep. */
  private readonly sizes = new WeakMap<StackItem, HistoryKept>();
  /** Stack items changed since their size was measured (new ones, ones a change was added to). */
  private readonly stale = new WeakSet<StackItem>();
  /** Stack items Yjs popped (undo / redo applied them: they are not dropped steps). */
  private readonly popped = new WeakSet<StackItem>();
  /** Popped stack items whose leaf content is not released yet. */
  private poppedPending: StackItem[] = [];
  /** The undo and redo stacks at the last maintenance (to find steps Yjs dropped since). */
  private seen: StackItem[] = [];
  /** Delete sets of the agent's changes since the last {@link compactStep} or {@link maintain}. */
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
      this.stale.add(e.stackItem);
      this.schedule();
    });
    this.undo.on('stack-item-updated', (e) => {
      this.stale.add(e.stackItem);
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
      // nothing would ever release it. Copies created and deleted here are never restored. (Yjs
      // collects them in this transaction's cleanup, before it merges deleted items.)
      Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
        if (
          struct instanceof Y.Item &&
          struct.keep &&
          !isContainer(struct) &&
          struct.id.clock >= (tr.beforeState.get(struct.id.client) ?? 0)
        ) {
          struct.keep = false;
          this.countReleased(struct);
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
      // containers kept already too: restored copies, containers above items a step keeps
      if (isContainer(struct)) containers.push(struct);
      else if (struct.keep) {
        struct.keep = false;
        this.countReleased(struct);
      }
    });
    // those left un-kept here are collected by Yjs when the transaction ends
    for (const c of keepForUndo(
      this.doc,
      containers.filter((c) => c.keep || !collectable(c, copies)),
    ))
      this.countReleased(c);
  };

  /** Counts an item un-kept for Yjs to collect in the stats (when the document collects at all). */
  private countReleased(item: Y.Item): void {
    if (!this.doc.gc) return;
    this.totals.released_items++;
    this.totals.released_bytes += itemContentBytes(item);
  }

  /**
   * Collects what the agent created and then deleted again since the step began, while the step
   * is still running (a batch replacing a large mesh hundreds of times would otherwise hold every
   * version until it ends), and adds what those changes replaced from before the step to the
   * step's size. Call it between the operations of a step, outside any transaction.
   */
  compactStep(): void {
    if (!this.pending.length || this.destroyed || this.doc.isDestroyed || this.doc._transaction) return;
    const pending = Y.mergeDeleteSets(this.pending);
    this.pending = [];
    const s = this.undo.undoStack[this.undo.undoStack.length - 1];
    if (!s) return;
    // what these changes deleted in the step; of it, what the step created is never restored
    const deleted = intersect(pending, s.deletions);
    let kept: HistoryKept = { bytes: 0, items: 0 };
    this.doc.transact((tr) => {
      this.collectWithin(tr, intersect(deleted, s.insertions));
      kept = heldIn(tr, deleted);
    }, GC_ORIGIN);
    // measured again at the next maintenance (the step is stale since these changes)
    const size = this.sizes.get(s);
    this.sizes.set(s, { bytes: (size?.bytes ?? 0) + kept.bytes, items: (size?.items ?? 0) + kept.items });
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

  /**
   * What a stack item counts against `maxBytes`: its kept bytes and {@link BUDGET_BYTES_PER_ITEM}
   * per kept item. Collects the data created and deleted within it when it changed.
   */
  private sizeOf(s: StackItem): number {
    let size = this.sizes.get(s);
    if (size === undefined || this.stale.has(s)) {
      size = this.compact(s);
      this.sizes.set(s, size);
      this.stale.delete(s);
    }
    return size.bytes + BUDGET_BYTES_PER_ITEM * size.items;
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
    const popped = this.poppedPending;
    if (popped.length) {
      this.poppedPending = [];
      this.release(popped);
    }
    // containers kept for steps that are gone now
    if (release.length || popped.length) recheck(this.doc, (c) => this.countReleased(c));
  }

  /**
   * Collects the data a step created and deleted within it (Yjs never restores it: it is not part
   * of the state before or after the step). Returns what the step still keeps.
   */
  private compact(s: StackItem): HistoryKept {
    let kept: HistoryKept = { bytes: 0, items: 0 };
    if (this.doc.isDestroyed) return kept;
    this.doc.transact((tr) => {
      this.collectWithin(tr, intersect(s.deletions, s.insertions));
      kept = heldIn(tr, s.deletions);
    }, GC_ORIGIN);
    return kept;
  }

  /**
   * Containers just un-kept that cannot be collected yet (see above) stay kept while a live step can
   * reach them ({@link keepForUndo}).
   */
  private protect(containers: Y.Item[]): void {
    if (!containers.length) return;
    const copies = copiesByDoc.get(this.doc);
    keepForUndo(
      this.doc,
      containers.filter((c) => !collectable(c, copies)),
    );
  }

  /**
   * Clears `keep` on the deleted items in `ds` (containers only when collectable, also those Yjs
   * un-kept itself when it dropped redo steps) and collects them, inside transaction `tr`: before
   * its cleanup can merge the parts it split off kept items back into them (see above).
   */
  private collectWithin(tr: Y.Transaction, ds: DeleteSet): void {
    if (!ds.clients.size) return;
    const containers: Y.Item[] = [];
    Y.iterateDeletedStructs(tr, ds, (struct) => {
      if (!(struct instanceof Y.Item)) return;
      if (isContainer(struct)) containers.push(struct);
      if (!struct.keep) return;
      this.countReleased(struct);
      struct.keep = false;
    });
    // once every item in `ds` is un-kept: what is below a container may be theirs
    this.protect(containers);
    if (this.doc.gc) Y.tryGc(ds, this.doc.store, this.doc.gcFilter);
  }

  /** Clears `keep` on the deleted items of dropped (or applied) steps and collects them. */
  private release(steps: StackItem[]): void {
    if (!steps.length || this.doc.isDestroyed) return;
    const ds = Y.mergeDeleteSets(steps.map((s) => s.deletions));
    this.doc.transact((tr) => this.collectWithin(tr, ds), GC_ORIGIN);
  }

  /**
   * The replaced or deleted data the history keeps for its undo and redo steps: its bytes (an
   * estimate of the items' content) and items, measured when a step changes (the step of a running
   * batch grows with every {@link compactStep}).
   */
  kept(): HistoryKept {
    const kept = { bytes: 0, items: 0 };
    if (this.destroyed) return kept;
    for (const s of [...this.undo.undoStack, ...this.undo.redoStack]) {
      const size = this.sizes.get(s);
      kept.bytes += size?.bytes ?? 0;
      kept.items += size?.items ?? 0;
    }
    return kept;
  }

  stats(): HistoryStats {
    return {
      steps: this.undo.undoStack.length,
      redo_steps: this.undo.redoStack.length,
      bytes: Math.round(this.kept().bytes),
      ...this.totals,
      released_bytes: Math.round(this.totals.released_bytes),
    };
  }

  /**
   * Ends the history: everything it kept is collected (unless the document is gone anyway) and the
   * UndoManager stops tracking. The last history of a document also clears `keep` on every item
   * still kept in it and collects them ({@link sweep}).
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
    this.undo.destroy();
    if (set && !set.size) {
      histories.delete(this.doc);
      sweep(this.doc);
    } else recheck(this.doc, (c) => this.countReleased(c));
  }
}
