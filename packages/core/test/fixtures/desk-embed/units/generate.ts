/**
 * Writes the contract's real unit file, `units/unit-file-prop.json` (docs/embedding.md "Fixtures"):
 * the example brief (`open.json`) staged, its red kite saved as a prop unit by core, in the
 * fixtures' `{"$bytes": "<base64>"}` notation. Both copies, this one and the web's under
 * `apps/web/test/fixtures/desk-protocol/units/`, are written. Run it from the repository's root when
 * the unit format or what staging makes of the kite changes:
 *
 *     npx tsx packages/core/test/fixtures/desk-embed/units/generate.ts
 *
 * Staging draws the scene's ids at random, so each run writes other bytes (the ids, and the header's
 * digest of the body that holds them); `desk-unit-fixture.test.ts` checks that the committed files
 * are what this makes today in all else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SceneDoc, extractUnit, stageBrief } from '../../../../src';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository's root. */
const ROOT = resolve(HERE, '../../../../../..');

/** Where the file is kept, from the repository's root: core's copy, then the contract's. */
export const UNIT_FILE_PROP_COPIES = [
  'packages/core/test/fixtures/desk-embed/units/unit-file-prop.json',
  'apps/web/test/fixtures/desk-protocol/units/unit-file-prop.json',
] as const;

/** The example brief's element whose prop is saved. */
const KITE = 'ele_0123456789kite';

/** The unit file of the example brief's red kite, as core writes it now (desk version 'fixture'). */
export function unitFileProp(): Uint8Array {
  const open = JSON.parse(readFileSync(resolve(HERE, '../open.json'), 'utf8')) as {
    scene: Parameters<typeof stageBrief>[1];
  };
  const doc = SceneDoc.create({ empty: true });
  try {
    stageBrief(doc, open.scene);
    const kite = doc
      .listObjects()
      .find((o) => o.custom_props?.desk_role === 'prop' && o.custom_props?.desk_element_id === KITE);
    if (!kite) throw new Error(`the example brief staged no prop for ${KITE}`);
    const unit = extractUnit(
      doc,
      { kind: 'prop', root: kite.id, name: 'Red kite' },
      { deskVersion: 'fixture' },
    );
    unit.probe.destroy();
    return unit.data;
  } finally {
    doc.destroy();
  }
}

/** A unit file in the fixtures' notation, laid out as the copies hold it (as Prettier leaves it). */
export const fixtureText = (data: Uint8Array): string =>
  `${JSON.stringify({ $bytes: Buffer.from(data).toString('base64') }, null, 2)}\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const text = fixtureText(unitFileProp());
  for (const copy of UNIT_FILE_PROP_COPIES) writeFileSync(resolve(ROOT, copy), text);
  console.log(`wrote ${UNIT_FILE_PROP_COPIES.join(' and ')}`);
}
