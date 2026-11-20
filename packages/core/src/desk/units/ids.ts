import { newId } from '../../util/id';
import { sha256Bytes } from '../container/digest';
import { UnitError } from './errors';

/*
 * Instance keys and the ids of an instance's parts.
 *
 * An instance key names the place an instance fills: 'set' (the scene's set), 'cast:<castId>' (a
 * cast member's figure), 'el:<elementId>' (an element's prop); 'lib:<id>' is kept for instances put
 * in by hand (P1). slotKey() is the only code that builds keys, so the browser desk and any other
 * replica name the same slot the same way.
 *
 * Every part an insert creates gets the id deriveUnitId(key, sourceId): 16 characters of newId's
 * alphabet taken from SHA-256('3d-editor/unit-id/v1' LF key LF sourceId). Two replicas inserting the
 * same unit in the same slot make the same ids, so a merge of the same lineage never duplicates parts,
 * and the root ('@root') depends only on the key: relinking a slot to another item keeps the root,
 * and with it shot subjects, holds and the root's animation.
 */

/** newId's alphabet (util/id.ts). */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The source id of a unit's root. */
export const UNIT_ROOT = '@root';

/** What an instance key may be. */
export const UNIT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

/** What a source id may be: '@root', or 1–64 letters, digits, '_' and '-' (scene ids are 16 base62). */
export const UNIT_SOURCE_ID_PATTERN = /^(@root|[A-Za-z0-9_-]{1,64})$/;

/** A host id in a slot (the brief's id pattern, HOST_ID_PATTERN: 1–100 of [A-Za-z0-9_.:-]). */
const SLOT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * The brief slot an instance fills: the scene's set, a cast member's figure or an element's prop. It
 * is also the `binding` UnitInstanceInfo reports (parsed from the key).
 */
export type UnitSlot = { set: true } | { castId: string } | { elementId: string };

/** The instance key of a slot: 'set', 'cast:<castId>' or 'el:<elementId>'. Throws UNIT_BAD_KEY. */
export function slotKey(slot: UnitSlot): string {
  if ('set' in slot && slot.set === true) return 'set';
  const id = 'castId' in slot ? slot.castId : 'elementId' in slot ? slot.elementId : null;
  if (typeof id !== 'string' || !SLOT_ID_PATTERN.test(id))
    throw new UnitError(
      'UNIT_BAD_KEY',
      `a slot names the set, a cast id or an element id (got ${JSON.stringify(slot)})`,
    );
  return 'castId' in slot ? `cast:${id}` : `el:${id}`;
}

/** The slot an instance key names (null: a key of no slot, such as 'lib:…', or not a key). */
export function parseSlotKey(key: string): UnitSlot | null {
  if (key === 'set') return { set: true };
  const m = /^(cast|el):(.+)$/.exec(key);
  if (!m || !SLOT_ID_PATTERN.test(m[2])) return null;
  return m[1] === 'cast' ? { castId: m[2] } : { elementId: m[2] };
}

/** A key for an instance of no slot ('lib:<newId()>'), kept for instances put in by hand (P1). */
export function libKey(): string {
  return `lib:${newId()}`;
}

/** `key` when it is an instance key, else UNIT_BAD_KEY. */
export function requireUnitKey(key: unknown): string {
  if (typeof key !== 'string' || !UNIT_KEY_PATTERN.test(key))
    throw new UnitError(
      'UNIT_BAD_KEY',
      `an instance key is 1–128 letters, digits and _ . : @ - starting with a letter or digit (got ${JSON.stringify(key)})`,
    );
  return key;
}

const encoder = new TextEncoder();

/** The scene id of source `src` in the instance with key `key` (16 base62 characters). */
export function deriveUnitId(key: string, src: string): string {
  requireUnitKey(key);
  if (!UNIT_SOURCE_ID_PATTERN.test(src))
    throw new UnitError('UNIT_BAD_RECORD', `'${src}' is not a source id`);
  const h = sha256Bytes(encoder.encode(`3d-editor/unit-id/v1\n${key}\n${src}`));
  let out = '';
  for (let i = 0; i < 16; i++) out += ALPHABET[h[i] % 62];
  return out;
}
