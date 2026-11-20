import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNIT_ROOT, decodeUnit, type UnitPayload } from '../src/desk/units';
import { UNIT_FILE_PROP_COPIES, fixtureText, unitFileProp } from './fixtures/desk-embed/units/generate';

/*
 * The contract's unit file, `units/unit-file-prop.json` (core's copy and the web's), is what its
 * generator (fixtures/desk-embed/units/generate.ts) writes today. Not byte for byte: staging draws
 * the scene's ids at random, so each run writes other ids, which also change the order of a block's
 * records (they follow the ids) and the header's digest (of the body that holds them). All else must
 * be the same: the header but its digest, each block's records in any order, and what every id
 * names (the record it is, by its block and contents).
 */

const ROOT = resolve(__dirname, '../../..');

/** The bytes a unit file in the fixtures' notation holds. */
const bytesOf = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(text) as { $bytes: string }).$bytes, 'base64'));

/** JSON with byte arrays as base64 (a mesh's packed data), not as one key per byte. */
const write = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') : v,
  );

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * A unit as its ids and their order do not change it: the header without its digest, and each
 * block's records sorted, every id (a record's key, wherever the body writes it) replaced by the
 * record it names, its block and a digest of its contents with ids erased.
 */
function shape(unit: Pick<UnitPayload, 'header' | 'body'>) {
  const { digest: _digest, ...header } = unit.header;
  const blocks = Object.entries(unit.body.blocks) as [string, Record<string, unknown>][];
  const ids = new Set(blocks.flatMap(([, records]) => Object.keys(records)).filter((id) => id !== UNIT_ROOT));
  const swap = (text: string, name: (id: string) => string) =>
    text.replace(/"([A-Za-z0-9]{16})"/g, (written, id: string) => (ids.has(id) ? `"${name(id)}"` : written));
  const names = new Map<string, string>();
  for (const [kind, records] of blocks)
    for (const [id, record] of Object.entries(records))
      names.set(id, `${kind}:${sha(swap(write(record), () => '#')).slice(0, 16)}`);
  const named = (value: unknown) => swap(write(value), (id) => names.get(id)!);
  return {
    header,
    root: unit.body.root,
    blocks: Object.fromEntries(
      blocks.map(([kind, records]) => [
        kind,
        Object.entries(records)
          .map(([id, r]) => named({ id, r }))
          .sort(),
      ]),
    ),
    drivers: named(unit.body.drivers),
  };
}

describe("the contract's unit file and its generator", () => {
  it('is, in both copies, what the generator writes today but for the ids staging draws', () => {
    const fresh = unitFileProp();
    const again = unitFileProp();
    // the ids are drawn anew on each run (were they not, the files would have to be these bytes)
    const drawn = !Buffer.from(fresh).equals(Buffer.from(again));
    expect(shape(decodeUnit(again))).toEqual(shape(decodeUnit(fresh)));
    for (const copy of UNIT_FILE_PROP_COPIES) {
      const text = readFileSync(resolve(ROOT, copy), 'utf8');
      const bytes = bytesOf(text);
      // in the generator's notation, and the same unit
      expect(text, copy).toBe(fixtureText(bytes));
      expect(shape(decodeUnit(bytes)), copy).toEqual(shape(decodeUnit(fresh)));
      if (!drawn) expect(text, copy).toBe(fixtureText(fresh));
    }
  });

  it('tells apart a unit with another colour, or with two parts’ materials swapped', () => {
    const unit = decodeUnit(unitFileProp());
    const same = shape(unit);
    const copy = () => structuredClone({ header: unit.header, body: unit.body });
    type Fields = Record<string, unknown>;
    const records = (u: ReturnType<typeof copy>, kind: 'materials' | 'objects') =>
      Object.values(u.body.blocks[kind]!) as Fields[];
    // the sail's red a little lighter
    const recoloured = copy();
    const red = records(recoloured, 'materials').find((m) => m.name === 'Kite Red')!;
    red.base_color = [0.68, 0.02, 0.05, 1];
    expect(shape(recoloured)).not.toEqual(same);
    // the sail wearing the spars' materials and the spars the sail's: the same records, other links
    const swapped = copy();
    const part = (name: string) =>
      records(swapped, 'objects').find((o) => (o.custom_props as Fields).store_part === name)!;
    const [sail, spars] = [part('sail'), part('spars')];
    [sail.material_slots, spars.material_slots] = [spars.material_slots, sail.material_slots];
    expect(shape(swapped)).not.toEqual(same);
    // and nothing changed is the same
    expect(shape(copy())).toEqual(same);
  });
});
