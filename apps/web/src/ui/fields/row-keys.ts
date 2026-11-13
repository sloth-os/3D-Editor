import { useRef } from 'preact/hooks';

/**
 * Keys for the rows of a list whose items have no id of their own (driver variables, F-curve
 * modifiers, envelope control points, bones), and where each row's item is now.
 *
 * A row keeps its key while its item is edited or moves, and the key of a removed item goes to no
 * other item. A field that holds typed text so stays with its item when an agent or another person
 * adds, removes or edits other items: with rows keyed by position, the field was given the next
 * item and wrote the text into it.
 */
export interface RowKeys {
  /** The key of each item's row, in list order. */
  keys: string[];
  /**
   * Where the item of a row is in the list as last rendered, or -1 once it is gone: a commit made
   * as the row goes away (or through an earlier render) then writes nothing.
   */
  indexOf: (key: string) => number;
  /**
   * Tells that the item identified as `from` is now identified as `to` (renamed or otherwise
   * edited here): its row keeps its key (and the keyboard focus) when the list renders next. Call
   * it once the edit is made.
   */
  renamed: (from: string, to: string) => void;
}

/** A row as rendered: its item's identity, its kind, and its key. */
export interface KeyedRow {
  id: string;
  kind: string;
  key: string;
}

/** Above this many pairs of old and new rows, unchanged items are matched only in place. */
const ORDER_MATCH_LIMIT = 40_000;

/**
 * The keys for a list of items (by `ids`, what identifies an unchanged item, and `kinds`, what an
 * edited one keeps), given the rows rendered before:
 * 1. unchanged items keep their keys: as many as keep their order, the ones nearest their old place
 *    among equals (an item edited to equal its neighbour does not take the neighbour's key);
 * 2. unchanged items that moved keep theirs too;
 * 3. edited items take the key of a changed item between the same unchanged neighbours: of the same
 *    kind first, then (with `inOrder`) the others in order when as many items changed as were left;
 * 4. other items are new: a fresh key each.
 */
export function matchRowKeys(
  prev: readonly KeyedRow[],
  ids: readonly string[],
  kinds: readonly string[] | null,
  fresh: () => string,
  inOrder = true,
): string[] {
  const n = prev.length;
  const m = ids.length;
  const keys: (string | null)[] = Array.from({ length: m }, () => null);
  const used = Array.from({ length: n }, () => false);
  const anchors: [number, number][] = [];
  if (n && m && n * m <= ORDER_MATCH_LIMIT) {
    // best[i][j]: the best pairing of prev[i..] and ids[j..] that keeps the order. Each unchanged
    // item is worth more than all moves together, so the most items keep their keys; among those
    // pairings, the one moving items least
    const worth = (Math.min(n, m) + 1) * (n + m) + 1;
    const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) {
        let v = Math.max(best[i + 1][j], best[i][j + 1]);
        if (prev[i].id === ids[j]) v = Math.max(v, best[i + 1][j + 1] + worth - Math.abs(i - j));
        best[i][j] = v;
      }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      const here = best[i][j];
      if (prev[i].id === ids[j] && here === best[i + 1][j + 1] + worth - Math.abs(i - j))
        anchors.push([i++, j++]);
      else if (here === best[i + 1][j]) i++;
      else j++;
    }
  } else {
    for (let j = 0; j < Math.min(n, m); j++) if (prev[j].id === ids[j]) anchors.push([j, j]);
  }
  for (const [i, j] of anchors) {
    keys[j] = prev[i].key;
    used[i] = true;
  }
  // unchanged items that moved
  const unusedById = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    const list = unusedById.get(prev[i].id);
    if (list) list.push(i);
    else unusedById.set(prev[i].id, [i]);
  }
  for (let j = 0; j < m; j++) {
    if (keys[j] !== null) continue;
    const i = unusedById.get(ids[j])?.shift();
    if (i === undefined) continue;
    keys[j] = prev[i].key;
    used[i] = true;
  }
  // edited items, between the same unchanged neighbours
  const bounds: [number, number][] = [[-1, -1], ...anchors, [n, m]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [i0, j0] = bounds[g];
    const [i1, j1] = bounds[g + 1];
    const olds: number[] = [];
    for (let i = i0 + 1; i < i1; i++) if (!used[i]) olds.push(i);
    const news: number[] = [];
    for (let j = j0 + 1; j < j1; j++) if (keys[j] === null) news.push(j);
    if (!olds.length || !news.length) continue;
    if (kinds) {
      for (const j of news) {
        const i = olds.find((x) => !used[x] && prev[x].kind === kinds[j]);
        if (i === undefined) continue;
        keys[j] = prev[i].key;
        used[i] = true;
      }
    }
    if (!inOrder) continue;
    const restOld = olds.filter((i) => !used[i]);
    const restNew = news.filter((j) => keys[j] === null);
    if (restOld.length !== restNew.length) continue;
    restNew.forEach((j, k) => {
      keys[j] = prev[restOld[k]].key;
      used[restOld[k]] = true;
    });
  }
  return keys.map((k) => k ?? fresh());
}

/** How {@link useRowKeys} tells items apart. */
export interface RowKeyOptions<T> {
  /** What an edited item keeps (e.g. a modifier's type): an edited item keeps the row of its kind. */
  kind?: (item: T) => string;
  /**
   * Whether items edited in place (as many between the same unchanged neighbours as were there
   * before) keep their rows in order. Off for lists where others can replace an item in one change
   * (a driver's variables, envelope points): there only the edits made here keep a row, through
   * {@link RowKeys.renamed}, and a replaced item's row goes away with what was typed for it.
   */
  inOrder?: boolean;
}

/**
 * {@link RowKeys} for the items of a list, by what identifies an unchanged item (`id`; with
 * `inOrder` off, the identities must be unique, as names in a list are).
 */
export function useRowKeys<T>(
  items: readonly T[],
  id: (item: T) => string,
  opts: RowKeyOptions<T> = {},
): RowKeys {
  const state = useRef<{
    rows: KeyedRow[];
    next: number;
    at: Map<string, number>;
    renames: Map<string, string>;
  } | null>(null);
  const st = (state.current ??= { rows: [], next: 0, at: new Map(), renames: new Map() });
  const ids = items.map(id);
  const kinds = opts.kind ? items.map(opts.kind) : null;
  // the edits made here since the last render: the row of `from` is now the row of `to`
  let prev = st.rows;
  if (st.renames.size) {
    const now = new Set(ids);
    const renames = st.renames;
    prev = prev.map((r) => {
      const to = renames.get(r.id);
      return to !== undefined && now.has(to) && !now.has(r.id) ? { ...r, id: to } : r;
    });
    st.renames = new Map();
  }
  const keys = matchRowKeys(prev, ids, kinds, () => `row${st.next++}`, opts.inOrder ?? true);
  st.rows = ids.map((x, j) => ({ id: x, kind: kinds?.[j] ?? '', key: keys[j] }));
  st.at = new Map(keys.map((k, j) => [k, j]));
  return {
    keys,
    indexOf: (key) => st.at.get(key) ?? -1,
    renamed: (from, to) => {
      if (from !== to) st.renames.set(from, to);
    },
  };
}
