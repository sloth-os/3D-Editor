import type * as Y from 'yjs';
import type { SceneDoc } from './scene-doc';

/*
 * A cheap token that changes whenever a document may have changed, for caches of values derived
 * from the document (desk/shots.ts getShots / getDeskSettings, eval/frame-input.ts the frame
 * states' input). Every change of a Y.Doc happens inside a transaction (local edits, undo and redo,
 * remote updates), so a counter of started transactions changes before anything does: outside a
 * transaction the token is that counter. It is bumped when a transaction starts, not when it ends,
 * because readers run before it ends too: the document's observers and its afterTransaction
 * listeners (SceneDoc.onChange) run once the transaction's changes are made, and a listener that
 * starts another transaction (an edit in reaction to an edit) may read again after it. Inside a
 * transaction the token also carries the number of items integrated so far (local and remote
 * inserts; every write inserts) and the size of the transaction's delete set (both grow with
 * every change), so a value written earlier in the same transaction (an operator's setShots before
 * its getShots, keys written before a frame is evaluated) is seen.
 */

const trackers = new WeakMap<Y.Doc, { version: number }>();

/** Items integrated into `y` so far: the sum of every client's clock. */
function integrated(y: Y.Doc): number {
  let n = 0;
  for (const structs of y.store.clients.values()) {
    const last = structs[structs.length - 1];
    if (last) n += last.id.clock + last.length;
  }
  return n;
}

/**
 * Token that changes whenever the Y.Doc `y` may have changed (see {@link docChangeToken}); only
 * while `y` is not destroyed.
 */
export function ydocChangeToken(y: Y.Doc): string {
  let t = trackers.get(y);
  if (!t) {
    const tracker = { version: 0 };
    y.on('beforeTransaction', () => {
      tracker.version++;
    });
    trackers.set(y, tracker);
    t = tracker;
  }
  const tr = y._transaction;
  if (!tr) return `${t.version}`;
  let deletions = 0;
  for (const items of tr.deleteSet.clients.values()) deletions += items.length;
  return `${t.version}:${integrated(y)}:${deletions}`;
}

/**
 * Token that changes whenever `doc` may have changed (null: unknown, always re-read: a document
 * without a Y.Doc, or whose Y.Doc was destroyed, which drops every listener, the counter's too).
 */
export function docChangeToken(doc: SceneDoc): string | null {
  const y = doc.ydoc;
  if (!y || typeof y.on !== 'function' || y.isDestroyed) return null;
  return ydocChangeToken(y);
}
