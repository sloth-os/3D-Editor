import { getState } from 'yjs';
import type { SceneDoc } from './scene-doc';

/*
 * A cheap token that changes whenever a document may have changed, for caches of values derived
 * from the document (desk/shots.ts getShots / getDeskSettings). Outside a transaction it is a
 * counter of the Y.Doc's finished transactions; inside one it also carries the local clock and the
 * size of the transaction's delete set, which grow with every insert and deletion, so a value
 * written earlier in the same transaction (an operator's setShots before its getShots) is seen.
 * The same rule as the rigid body cache's (physics/rigid-body.ts).
 */

const trackers = new WeakMap<object, { version: number }>();

/** Token that changes whenever `doc` may have changed (null: unknown, always re-read). */
export function docChangeToken(doc: SceneDoc): string | null {
  const y = doc.ydoc;
  if (!y || typeof y.on !== 'function') return null;
  let t = trackers.get(y);
  if (!t) {
    const tracker = { version: 0 };
    y.on('afterTransaction', () => {
      tracker.version++;
    });
    trackers.set(y, tracker);
    t = tracker;
  }
  const tr = y._transaction;
  if (!tr) return `${t.version}`;
  let deletions = 0;
  for (const items of tr.deleteSet.clients.values()) deletions += items.length;
  return `${t.version}:${getState(y.store, y.clientID)}:${deletions}`;
}
