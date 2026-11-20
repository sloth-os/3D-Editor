import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { createMesh, selectAllElements, separateMesh, type MeshData } from '../src/mesh';
import { cpuMs } from './timing-helpers';

/*
 * Operators that add thousands of datablocks in one step must not take time that grows with the
 * square of their number: the server runs them in its own process, between the requests of every
 * editor and agent. Separate by loose parts of 20,000 triangles ran for more than ten minutes:
 * each new object and mesh collected every name of its kind and tried the suffixes .001, .002 …
 * from the first, and every part went through all faces of the mesh.
 */

/** `n` loose triangles in rows of 200. */
function triangles(n: number): MeshData {
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 200) * 2;
    const y = Math.floor(i / 200) * 2;
    positions.push(x, y, 0, x + 1, y, 0, x, y + 1, 0);
    faces.push([3 * i, 3 * i + 1, 3 * i + 2]);
  }
  return createMesh({ positions, faces });
}

/** The two sizes the growth is measured between: 16 times as many parts. */
const FEW = 1000;
const MANY = 16_000;

/**
 * The least CPU time (timing-helpers' cpuMs, which does not grow while the thread waits for a CPU)
 * of a step for FEW parts and of a step for MANY parts, over `rounds` rounds with the two sizes
 * alternated in each, so that a garbage collection or a busy moment of the machine falls on one
 * sample of one size, not on the only sample of one of them: one wall-clock sample of each read up
 * to 62 times as long for 16 times the parts, under coverage with every CPU busy, where the work
 * grew 11 to 23 times. A sample of FEW parts runs `repeat` steps (each on its own input) and counts
 * their mean: the CPU clock of a thread advances in steps of 4 ms on some Linux kernels (tick-based
 * accounting), so a sample needs tens of milliseconds to read its time to a few percent. `prepare`
 * builds what a step works on (not timed) and returns the step and a check of its result, run after
 * the clock stops.
 */
function leastCpuMs(
  rounds: number,
  repeat: number,
  prepare: (n: number) => { step: () => void; check: () => void },
): [number, number] {
  // steps of the smaller size first, not timed: the code they run is compiled before the clock runs
  for (const warm of Array.from({ length: repeat }, () => prepare(FEW))) {
    warm.step();
    warm.check();
  }
  const least: [number, number] = [Infinity, Infinity];
  for (let round = 0; round < rounds; round++)
    [FEW, MANY].forEach((n, i) => {
      const steps = Array.from({ length: n === FEW ? repeat : 1 }, () => prepare(n));
      const t0 = cpuMs();
      for (const s of steps) s.step();
      least[i] = Math.min(least[i], (cpuMs() - t0) / steps.length);
      for (const s of steps) s.check();
    });
  return least;
}

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
      const doc = SceneDoc.create({ empty: true });
      const meshId = doc.addMesh('Tris', triangles(n));
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
      const registry = createOperatorRegistry();
      let res: ReturnType<typeof registry.run> | null = null;
      return {
        step: () => {
          res = registry.run(ctx, 'mesh.separate', { type: 'LOOSE' });
        },
        check: () => {
          expect(res?.ok, res?.error).toBe(true);
          expect(doc.listObjects()).toHaveLength(n);
        },
      };
    };
    const [few, many] = leastCpuMs(3, 1, separate);
    // 16 times the parts: 11 to 20 times as long (20 runs, with and without coverage, with every CPU
    // busy or not); collecting every name of their kind again for every 8th new object and mesh made
    // it 196 times as long (for every one, as before, minutes)
    expect(
      many / few,
      `${few.toFixed(1)} ms for ${FEW} parts, ${many.toFixed(1)} ms for ${MANY}`,
    ).toBeLessThan(48);
  }, 60_000);

  it('are split off a mesh in time that grows with their number (separateMesh, without the document)', () => {
    const split = (n: number) => {
      const mesh = triangles(n);
      let parts: MeshData[] = [];
      return {
        step: () => {
          parts = separateMesh(mesh, selectAllElements(mesh), 'LOOSE').parts;
        },
        check: () => expect(parts).toHaveLength(n - 1),
      };
    };
    const [few, many] = leastCpuMs(5, 16, split);
    // 16 times the parts: 14 to 23 times as long (20 runs, with and without coverage, with every CPU
    // busy or not); a pass over all faces for every part made it 150 to 190 times as long
    expect(
      many / few,
      `${few.toFixed(1)} ms for ${FEW} parts, ${many.toFixed(1)} ms for ${MANY}`,
    ).toBeLessThan(48);
  }, 30_000);
});
