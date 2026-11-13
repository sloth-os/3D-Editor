import { describe, expect, it } from 'vitest';
import { matchRowKeys, type KeyedRow } from '../src/ui/fields/row-keys';

/** Rows for ids (and kinds), keyed k0, k1, … */
const rows = (ids: string[], kinds?: string[]): KeyedRow[] =>
  ids.map((id, i) => ({ id, kind: kinds?.[i] ?? '', key: `k${i}` }));

/** The keys for the new ids; fresh keys are new0, new1, … */
function match(prev: KeyedRow[], ids: string[], kinds: string[] | null = null, inOrder = true): string[] {
  let n = 0;
  return matchRowKeys(prev, ids, kinds, () => `new${n++}`, inOrder);
}

describe('row keys that follow their items', () => {
  it('keeps the keys of unchanged items', () => {
    expect(match(rows(['a', 'b', 'c']), ['a', 'b', 'c'])).toEqual(['k0', 'k1', 'k2']);
  });

  it('gives a removed item key to no other item', () => {
    expect(match(rows(['a', 'b', 'c']), ['b', 'c'])).toEqual(['k1', 'k2']);
    expect(match(rows(['a', 'b', 'c']), ['a', 'c'])).toEqual(['k0', 'k2']);
    expect(match(rows(['a', 'b', 'c']), ['a', 'b'])).toEqual(['k0', 'k1']);
  });

  it('gives added items fresh keys', () => {
    expect(match(rows(['a', 'b']), ['c', 'a', 'b'])).toEqual(['new0', 'k0', 'k1']);
    expect(match(rows(['a', 'b']), ['a', 'c', 'b'])).toEqual(['k0', 'new0', 'k1']);
  });

  it('keeps the keys of items that moved', () => {
    expect(match(rows(['a', 'b', 'c']), ['c', 'a', 'b'])).toEqual(['k2', 'k0', 'k1']);
    expect(match(rows(['a', 'b']), ['b', 'a'])).toEqual(['k1', 'k0']);
  });

  it('an edited item keeps its key between the same unchanged neighbours', () => {
    // renamed (or otherwise edited) in place
    expect(match(rows(['a', 'b', 'c']), ['a', 'x', 'c'])).toEqual(['k0', 'k1', 'k2']);
    expect(match(rows(['a', 'b']), ['x', 'y'])).toEqual(['k0', 'k1']);
  });

  it('an edited item is matched by its kind first', () => {
    // b (a NOISE) edited and a (a GENERATOR) removed: b keeps its key
    const prev = rows(['a', 'b'], ['GEN', 'NOISE']);
    expect(match(prev, ['b2'], ['NOISE'])).toEqual(['k1']);
    expect(match(prev, ['a2'], ['GEN'])).toEqual(['k0']);
  });

  it('items edited where as many others were removed or added get fresh keys', () => {
    // a removed and b renamed at once: which is which is not known, so neither key is reused
    expect(match(rows(['a', 'b']), ['y'])).toEqual(['new0']);
    // items on the other side of an unchanged one are not paired
    expect(match(rows(['a', 'b']), ['b', 'c'])).toEqual(['k1', 'new0']);
  });

  it('equal items keep their keys in order while as many are left', () => {
    expect(match(rows(['x', 'x', 'y']), ['x', 'x', 'y'])).toEqual(['k0', 'k1', 'k2']);
    expect(match(rows(['x', 'x', 'y']), ['x', 'x'])).toEqual(['k0', 'k1']);
  });

  it('equal items fewer than before all get fresh keys', () => {
    // regression: one of two splines with the same points (but other settings) was removed, and the
    // one left took the removed one's key, with the setting typed for it
    expect(match(rows(['x', 'x', 'y']), ['x', 'y'])).toEqual(['new0', 'k2']);
    expect(match(rows(['x', 'y', 'x']), ['y', 'x'])).toEqual(['k1', 'new0']);
    expect(match(rows(['x', 'x'], ['K', 'K']), ['x'], ['K'])).toEqual(['new0']);
    // nor does an edited item of their kind take one of their keys
    expect(match(rows(['x', 'x', 'y'], ['K', 'K', 'K']), ['x', 'z'], ['K', 'K'])).toEqual(['new0', 'k2']);
  });

  it('long lists match unchanged items in place and edited ones by kind', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `p${i}`);
    const prev = rows(ids);
    const next = [...ids];
    next[150] = 'edited';
    const keys = match(prev, next);
    expect(keys[0]).toBe('k0');
    expect(keys[299]).toBe('k299');
    expect(new Set(keys).size).toBe(300);
  });

  it('an item edited to equal its neighbour keeps its key (the neighbour keeps its own)', () => {
    // regression: the edited item took the key of the equal neighbour, so both rows were made anew
    expect(match(rows(['a', 'b']), ['b', 'b'])).toEqual(['k0', 'k1']);
    expect(match(rows(['a', 'b', 'c']), ['b', 'b', 'c'])).toEqual(['k0', 'k1', 'k2']);
    expect(match(rows(['a', 'b']), ['a', 'a'])).toEqual(['k0', 'k1']);
    expect(match(rows(['x', 'a', 'b']), ['x', 'b', 'b'], ['K', 'K', 'K'])).toEqual(['k0', 'k1', 'k2']);
  });

  it('among equal items, the ones nearest their old place keep the keys', () => {
    // an equal item added at the end: the first two keep theirs
    expect(match(rows(['x', 'x']), ['x', 'x', 'x'])).toEqual(['k0', 'k1', 'new0']);
    // an item added in front of equal ones: they keep theirs
    expect(match(rows(['x', 'x']), ['y', 'x', 'x'])).toEqual(['new0', 'k0', 'k1']);
  });

  it('edited items are paired by kind only when as many of the kind changed as were left', () => {
    // regression: one item removed and another of its kind edited in one change: the edited one took
    // the removed one's key (and the text typed for the removed one went into it)
    expect(match(rows(['a', 'b'], ['K', 'K']), ['b2'], ['K'])).toEqual(['new0']);
    // and the other way round (an undo restores the removed one and the edit): no key is given away
    expect(match(rows(['b2'], ['K']), ['a', 'b'], ['K', 'K'])).toEqual(['new0', 'new1']);
    // as many on each side: paired in order
    expect(match(rows(['a', 'b', 'c'], ['K', 'K', 'L']), ['a2', 'b2'], ['K', 'K'])).toEqual(['k0', 'k1']);
  });

  it('pairing edited items by kind takes time in proportion to the list', () => {
    // regression: each edited item looked for its old row from the start of the gap (quadratic);
    // every spline of a big curve changes when the curve is transformed
    const n = 60_000;
    const prev = rows(
      Array.from({ length: n }, (_, i) => `a${i}`),
      Array.from({ length: n }, () => 'POLY'),
    );
    const ids = Array.from({ length: n }, (_, i) => `b${i}`);
    const kinds = Array.from({ length: n }, () => 'POLY');
    const t0 = performance.now();
    const keys = match(prev, ids, kinds);
    const ms = performance.now() - t0;
    expect(keys[0]).toBe('k0');
    expect(keys[n - 1]).toBe(`k${n - 1}`);
    // linear: tens of milliseconds; the quadratic search took seconds
    expect(ms).toBeLessThan(1500);
  });

  it('without in-order pairing, an item another one replaced takes its key away', () => {
    // a driver's variable replaced by another in one change: the new one gets a fresh row
    expect(match(rows(['a']), ['c'], null, false)).toEqual(['new0']);
    expect(match(rows(['a', 'b', 'c']), ['a', 'x', 'c'], null, false)).toEqual(['k0', 'new0', 'k2']);
    // unchanged and moved items keep theirs
    expect(match(rows(['a', 'b']), ['b', 'a'], null, false)).toEqual(['k1', 'k0']);
    // kinds still pair edited items
    expect(match(rows(['a', 'b'], ['P', 'Q']), ['a', 'y'], ['P', 'Q'], false)).toEqual(['k0', 'k1']);
  });

  it('keys stay unique', () => {
    const keys = match(rows(['a', 'a', 'b', 'c']), ['a', 'x', 'a', 'y', 'b', 'z']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
