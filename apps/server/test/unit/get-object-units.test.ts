import { describe, expect, it } from 'vitest';
import { SceneDoc, createCube, decodeUnit, extractUnit, insertUnit, readInstance } from '@3d-editor/core';
import { describeObject } from '../../src/mcp/scene-summary';

/*
 * get_object of a library instance's root: its part and driver tables (unit_parts, unit_drivers,
 * about 56 bytes a part) are left out of the custom props for how many entries they hold.
 */

describe('get_object of a library instance root', () => {
  it('gives unit_parts_count and unit_drivers_count in place of the tables', () => {
    const src = SceneDoc.create({ empty: true });
    const crate = src.addObject({ type: 'MESH', name: 'Crate', data: src.addMesh('Crate', createCube()) });
    src.addObject({ type: 'MESH', name: 'Lid', parent: crate, data: src.addMesh('Lid', createCube()) });
    const unit = decodeUnit(extractUnit(src, { kind: 'prop', root: crate }, { deskVersion: 'test' }).data);
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, unit, {
      ref: 'lib_crate',
      version: 1,
      sha256: 'a'.repeat(64),
      key: 'lib:crate',
    });
    const parts = readInstance(doc, r.root)!.parts.size;
    expect(parts).toBeGreaterThanOrEqual(4);
    const props = describeObject(doc, doc.getObject(r.root)!).custom_props as Record<string, unknown>;
    expect(props).not.toHaveProperty('unit_parts');
    expect(props).not.toHaveProperty('unit_drivers');
    expect(props).toMatchObject({
      unit_ref: 'lib_crate',
      unit_version: 1,
      unit_parts_count: parts,
      unit_drivers_count: 0,
    });
    // a plain object's props are as they are
    const plain = doc.addObject({ type: 'EMPTY', name: 'Mark', custom_props: { note: 'x' } });
    expect(describeObject(doc, doc.getObject(plain)!).custom_props).toEqual({ note: 'x' });
  });
});
