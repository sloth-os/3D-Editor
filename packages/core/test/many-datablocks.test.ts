import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { createMesh, selectAllElements, separateMesh, type MeshData } from '../src/mesh';

/*
 * Operators that add thousands of datablocks in one step must not take time that grows with the
 * square of their number: the server runs them in its own process, between the requests of every
 * editor and agent. Separate by loose parts of 20,000 triangles ran for more than ten minutes:
 * each new object and mesh collected every name of its kind and tried the suffixes .001, .002 …
 * from the first, and every part went through all faces of the mesh.
 */

describe('datablocks added in one transaction', () => {
  it('are named from the names of their kind collected once, however many there are', () => {
    const doc = SceneDoc.create({ empty: true });
    const values = vi.spyOn(doc.map('objects'), 'values');
    doc.transact(() => {
      for (let i = 0; i < 300; i++) doc.addObject({ type: 'EMPTY', name: 'Part' });
    });
    expect(values.mock.calls.length).toBeLessThanOrEqual(2);
    const names = doc.listObjects().map((o) => o.name);
    expect(new Set(names).size).toBe(300);
    expect(names).toContain('Part');
    expect(names).toContain('Part.299');
    expect(names).not.toContain('Part.300');
  });

  it('get the lowest free suffix, as when each is named alone, around removals, renames and other code', () => {
    const doc = SceneDoc.create({ empty: true });
    const add = (name = 'Cube') => doc.getObject(doc.addObject({ type: 'EMPTY', name }))!.name;
    doc.transact(() => {
      expect([add(), add(), add()]).toEqual(['Cube', 'Cube.001', 'Cube.002']);
      // a removed object's name is free again
      doc.removeObject(doc.findObjectByName('Cube.002')!.id);
      expect(add()).toBe('Cube.002');
      // so is the old name of a renamed one, below the suffixes given since
      doc.rename('objects', doc.findObjectByName('Cube.001')!.id, 'Box');
      expect(add()).toBe('Cube.001');
      // an object added by other code (scene tools write their maps directly) is not named again
      const y = new Y.Map<unknown>();
      doc.map('objects').set('direct', y);
      y.set('id', 'direct');
      y.set('name', 'Cube.003');
      expect(add()).toBe('Cube.004');
    });
    // outside a transaction too
    expect(add()).toBe('Cube.005');
    expect(add('Box')).toBe('Box.001');
  });

  it('are separated by loose parts in time that grows with their number, not with its square', () => {
    const separate = (n: number) => {
      const positions: number[] = [];
      const faces: number[][] = [];
      for (let i = 0; i < n; i++) {
        const x = (i % 200) * 2;
        const y = Math.floor(i / 200) * 2;
        positions.push(x, y, 0, x + 1, y, 0, x, y + 1, 0);
        faces.push([3 * i, 3 * i + 1, 3 * i + 2]);
      }
      const doc = SceneDoc.create({ empty: true });
      const meshId = doc.addMesh('Tris', createMesh({ positions, faces }));
      const id = doc.addObject({ type: 'MESH', name: 'Tris', data: meshId });
      const state = createEditorState();
      state.selectedIds = [id];
      state.activeId = id;
      state.mode = 'EDIT';
      state.meshSelection = selectAllElements(doc.getMesh(meshId)!);
      const ctx: OperatorContext = {
        doc,
        state,
        origin: { type: 'test' },
        source: 'test',
        report: () => undefined,
      };
      const t0 = performance.now();
      const res = createOperatorRegistry().run(ctx, 'mesh.separate', { type: 'LOOSE' });
      const ms = performance.now() - t0;
      expect(res.ok, res.error).toBe(true);
      expect(doc.listObjects()).toHaveLength(n);
      return ms;
    };
    separate(500);
    const base = separate(1000);
    // 16 times the parts: about 16 times as long (256 times when it grew with the square)
    const many = separate(16_000);
    expect(many / base).toBeLessThan(64);
  }, 30_000);

  it('are split off a mesh in time that grows with their number (separateMesh, without the document)', () => {
    const triangles = (n: number): MeshData => {
      const positions: number[] = [];
      const faces: number[][] = [];
      for (let i = 0; i < n; i++) {
        const x = (i % 200) * 2;
        const y = Math.floor(i / 200) * 2;
        positions.push(x, y, 0, x + 1, y, 0, x, y + 1, 0);
        faces.push([3 * i, 3 * i + 1, 3 * i + 2]);
      }
      return createMesh({ positions, faces });
    };
    const split = (n: number) => {
      const mesh = triangles(n);
      const t0 = performance.now();
      const { parts } = separateMesh(mesh, selectAllElements(mesh), 'LOOSE');
      const ms = performance.now() - t0;
      expect(parts).toHaveLength(n - 1);
      return ms;
    };
    split(500);
    const base = split(1000);
    // 16 times the parts: about 16 times as long; a pass over all faces for every part made it
    // 90 to 140 times as long
    expect(split(16_000) / base).toBeLessThan(48);
  }, 30_000);
});
