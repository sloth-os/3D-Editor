import { describe, expect, it } from 'vitest';
import {
  UNIT_KEY_PATTERN,
  UnitError,
  deriveUnitId,
  parseSlotKey,
  requireUnitKey,
  slotKey,
} from '../src/desk/units';

/*
 * Instance keys and derived part ids (desk/units/ids.ts): the golden vectors every replica (the
 * browser desk, its worker, a server) must reproduce, the key pattern and slotKey, the only builder
 * of keys.
 */

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof UnitError ? err.code : String(err);
  }
  return 'no error';
};

describe('deriveUnitId', () => {
  it('gives the golden ids', () => {
    expect(deriveUnitId('set', '@root')).toBe('SIqO3S2CV5o0gCvB');
    expect(deriveUnitId('cast:chr_0123456789mira', '@root')).toBe('m9bklhbHfc2vJWPk');
    expect(deriveUnitId('el:ele_0123456789kite', 'J9ODKvYZn1qsGH13')).toBe('XzLRaAVqoW4rTGbp');
  });

  it('is 16 base62 characters, the same on every call, and differs by key and source', () => {
    const a = deriveUnitId('set', 'abc');
    expect(a).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(deriveUnitId('set', 'abc')).toBe(a);
    expect(deriveUnitId('set', 'abd')).not.toBe(a);
    expect(deriveUnitId('el:x', 'abc')).not.toBe(a);
  });

  it('refuses keys with a line feed or over 128 characters, and bad source ids', () => {
    expect(code(() => deriveUnitId('set\nx', '@root'))).toBe('UNIT_BAD_KEY');
    expect(code(() => deriveUnitId('k'.repeat(129), '@root'))).toBe('UNIT_BAD_KEY');
    expect(code(() => deriveUnitId('k'.repeat(128), '@root'))).toBe('no error');
    expect(code(() => deriveUnitId('', '@root'))).toBe('UNIT_BAD_KEY');
    expect(code(() => deriveUnitId('set', 'a.b'))).toBe('UNIT_BAD_RECORD');
    expect(code(() => requireUnitKey('-set'))).toBe('UNIT_BAD_KEY');
    expect(UNIT_KEY_PATTERN.test('lib:0123456789abcdef')).toBe(true);
  });
});

describe('slotKey', () => {
  it("builds 'set', 'el:<id>' and 'cast:<id>' and parses them back", () => {
    expect(slotKey({ set: true })).toBe('set');
    expect(slotKey({ castId: 'chr_0123456789mira' })).toBe('cast:chr_0123456789mira');
    expect(slotKey({ elementId: 'ele_0123456789kite' })).toBe('el:ele_0123456789kite');
    expect(parseSlotKey('set')).toEqual({ set: true });
    expect(parseSlotKey('cast:chr_0123456789mira')).toEqual({ castId: 'chr_0123456789mira' });
    expect(parseSlotKey('el:ele_0123456789kite')).toEqual({ elementId: 'ele_0123456789kite' });
    expect(parseSlotKey('el:a:b')).toEqual({ elementId: 'a:b' });
    expect(parseSlotKey('lib:0123456789abcdef')).toBeNull();
    expect(parseSlotKey('element:x')).toBeNull();
    expect(parseSlotKey('cast:')).toBeNull();
  });

  it('matches the state.units slot pattern of the protocol and refuses ids it cannot hold', () => {
    const SLOT = /^(set|cast:[A-Za-z0-9_.:-]{1,100}|el:[A-Za-z0-9_.:-]{1,100})$/;
    for (const s of [{ set: true as const }, { castId: 'c'.repeat(100) }, { elementId: 'e.1:x-y_z' }])
      expect(slotKey(s)).toMatch(SLOT);
    expect(code(() => slotKey({ castId: 'c'.repeat(101) }))).toBe('UNIT_BAD_KEY');
    expect(code(() => slotKey({ elementId: 'has space' }))).toBe('UNIT_BAD_KEY');
    expect(code(() => slotKey({ castId: '' }))).toBe('UNIT_BAD_KEY');
    expect(code(() => slotKey({} as never))).toBe('UNIT_BAD_KEY');
  });
});
