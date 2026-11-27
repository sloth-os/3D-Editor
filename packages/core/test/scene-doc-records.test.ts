import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { createCube } from '../src/mesh/primitives';

/*
 * SceneDoc's record access (readRecord, addRecord, replaceRecord): the stored fields of any
 * datablock, as library units read and write them.
 */

describe('SceneDoc records', () => {
  it('readRecord gives the stored fields without id, as a copy (byte arrays too)', () => {
    const doc = SceneDoc.create({ empty: true });
    const mesh = doc.addMesh('Box', createCube());
    const obj = doc.addObject({ type: 'MESH', name: 'Box', data: mesh, custom_props: { a: 1 } });
    const rec = doc.readRecord('objects', obj)!;
    expect(rec.id).toBeUndefined();
    expect(rec).toMatchObject({ name: 'Box', type: 'MESH', data: mesh, custom_props: { a: 1 } });
    (rec.custom_props as Record<string, unknown>).a = 2;
    expect(doc.getObject(obj)!.custom_props.a).toBe(1);
    const m = doc.readRecord('meshes', mesh)!;
    expect(m.data).toBeInstanceOf(Uint8Array);
    (m.data as Uint8Array)[0] ^= 0xff;
    expect((doc.readRecord('meshes', mesh)!.data as Uint8Array)[0]).not.toBe((m.data as Uint8Array)[0]);
    expect(doc.readRecord('objects', 'missing')).toBeNull();
  });

  it('addRecord adds under the given id with a unique name, and refuses a taken id', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addRecord('materials', 'mat_aaaaaaaaaaaa', { name: 'Paint', base_color: [1, 0, 0, 1] });
    const b = doc.addRecord('materials', 'mat_bbbbbbbbbbbb', { name: 'Paint', base_color: [0, 1, 0, 1] });
    expect([a, b]).toEqual(['mat_aaaaaaaaaaaa', 'mat_bbbbbbbbbbbb']);
    expect(doc.getMaterial(b)!.name).toBe('Paint.001');
    expect(() => doc.addRecord('materials', a, { name: 'Again' })).toThrow(/already exists/);
  });

  it('replaceRecord writes only what differs, deletes fields not given, renames uniquely', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.addObject({ type: 'EMPTY', name: 'Taken' });
    const id = doc.addObject({ type: 'EMPTY', name: 'Box', custom_props: { a: 1, b: 2 } });
    const before = doc.readRecord('objects', id)!;
    const changes: string[][] = [];
    (doc.map('objects').get(id) as Y.Map<unknown>).observe((e) => changes.push([...e.keysChanged].sort()));
    doc.replaceRecord('objects', id, { ...before, location: [1, 2, 3], custom_props: { a: 1, b: 2 } });
    expect(changes).toEqual([['location']]);
    const { show_wire: _drop, ...without } = doc.readRecord('objects', id)!;
    doc.replaceRecord('objects', id, { ...without, name: 'Taken' });
    expect(doc.getObject(id)!.name).toBe('Taken.001');
    expect('show_wire' in doc.readRecord('objects', id)!).toBe(false);
    expect(() => doc.replaceRecord('objects', 'missing', {})).toThrow(/not found/);
    // byte arrays are compared by their bytes
    const mesh = doc.addMesh('M', createCube());
    const rec = doc.readRecord('meshes', mesh)!;
    changes.length = 0;
    (doc.map('meshes').get(mesh) as Y.Map<unknown>).observe((e) => changes.push([...e.keysChanged]));
    doc.replaceRecord('meshes', mesh, { ...rec, data: (rec.data as Uint8Array).slice() });
    expect(changes).toEqual([]);
  });
});
