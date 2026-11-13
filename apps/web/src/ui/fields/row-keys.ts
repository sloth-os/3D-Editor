import { useRef } from 'preact/hooks';

/**
 * Keys for the rows of a list whose items have no id of their own (driver variables, F-curve
 * modifiers, envelope control points), and where each row's item is now.
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
 * 1. unchanged items keep their keys, in the longest run that keeps their order;
 * 2. unchanged items that moved keep theirs too;
 * 3. edited items take the key of a changed item between the same unchanged neighbours: of the same
 *    kind first, then the others in order when as many items changed as were left there;
 * 4. other items are new: a fresh key each.
 */
export function matchRowKeys(
  prev: readonly KeyedRow[],
  ids: readonly string[],
  kinds: readonly string[] | null,
  fresh: () => string,
): string[] {
  const n = prev.length;
  const m = ids.length;
  const keys: (string | null)[] = Array.from({ length: m }, () => null);
  const used = Array.from({ length: n }, () => false);
  const anchors: [number, number][] = [];
  if (n && m && n * m <= ORDER_MATCH_LIMIT) {
    // longest common subsequence of the identities: lcs[i][j] for prev[i..] and ids[j..]
    const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i][j] = prev[i].id === ids[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (prev[i].id === ids[j]) anchors.push([i++, j++]);
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
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

/**
 * {@link RowKeys} for the items of a list, by what identifies an unchanged item (`id`) and what an
 * edited item keeps (`kind`, e.g. a modifier's type; without it, edited items are matched in order).
 */
export function useRowKeys<T>(
  items: readonly T[],
  id: (item: T) => string,
  kind?: (item: T) => string,
): RowKeys {
  const state = useRef<{ rows: KeyedRow[]; next: number; at: Map<string, number> } | null>(null);
  const st = (state.current ??= { rows: [], next: 0, at: new Map() });
  const ids = items.map(id);
  const kinds = kind ? items.map(kind) : null;
  const keys = matchRowKeys(st.rows, ids, kinds, () => `row${st.next++}`);
  st.rows = ids.map((x, j) => ({ id: x, kind: kinds?.[j] ?? '', key: keys[j] }));
  st.at = new Map(keys.map((k, j) => [k, j]));
  return { keys, indexOf: (key) => st.at.get(key) ?? -1 };
}
