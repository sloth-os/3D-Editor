import { describe, expect, it } from 'vitest';
import { matchRowKeys, type KeyedRow } from '../src/ui/fields/row-keys';

/** Rows for ids (and kinds), keyed k0, k1, … */
const rows = (ids: string[], kinds?: string[]): KeyedRow[] =>
  ids.map((id, i) => ({ id, kind: kinds?.[i] ?? '', key: `k${i}` }));

/** The keys for the new ids; fresh keys are new0, new1, … */
function match(prev: KeyedRow[], ids: string[], kinds: string[] | null = null): string[] {
  let n = 0;
  return matchRowKeys(prev, ids, kinds, () => `new${n++}`);
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

  it('duplicates keep their keys in order', () => {
    expect(match(rows(['x', 'x', 'y']), ['x', 'y'])).toEqual(['k0', 'k2']);
    expect(match(rows(['x', 'y', 'x']), ['y', 'x'])).toEqual(['k1', 'k2']);
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

  it('keys stay unique', () => {
    const keys = match(rows(['a', 'a', 'b', 'c']), ['a', 'x', 'a', 'y', 'b', 'z']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
