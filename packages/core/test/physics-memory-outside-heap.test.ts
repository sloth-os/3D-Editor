import { describe, expect, it } from 'vitest';
import { rigidBodyCachesBytes } from '../src/physics/rigid-body';
import { documentSimulationBytes } from '../src/physics/memory';
import { physicsScene, range, rb, simulate } from './physics-helpers';

/*
 * The part of a document's rigid body simulation outside the JavaScript heap, estimated before it is
 * simulated (physics/memory.ts documentSimulationBytes with outsideHeap), against what its cache keeps
 * outside the heap once simulated (rigid-body.ts rigidBodyCachesBytes): a browser export counts only
 * the rest in its first worker's heap.
 */

/** A world of `bodies` falling boxes, some released late (`start_frame`), with a ground. */
function world(bodies: number, start: number | null = null) {
  const s = physicsScene();
  s.ground();
  for (let i = 0; i < bodies; i++)
    s.add(`Box${i}`, s.cube(0.5), rb('ACTIVE', { start_frame: start }), { location: [i * 2, 0, 1] });
  s.setWorld({ frame_start: 1, frame_end: 100 });
  return s.doc;
}

describe('the part of a simulation outside the JavaScript heap', () => {
  it('is estimated as its cache keeps it once simulated', () => {
    for (const [bodies, start] of [
      [1, null],
      [2, null],
      [5, null],
      [2, 50],
    ] as const) {
      const doc = world(bodies, start);
      const outside = documentSimulationBytes(doc, 100, { outsideHeap: true });
      const all = documentSimulationBytes(doc, 100);
      expect(outside, `${bodies} bodies`).toBeLessThanOrEqual(all);
      const before = rigidBodyCachesBytes({ outsideHeap: true });
      simulate(doc, range(1, 100));
      expect(outside, `${bodies} bodies, start ${start}`).toBe(
        rigidBodyCachesBytes({ outsideHeap: true }) - before,
      );
    }
    // one body's pose is short enough for V8 to keep in the heap; two bodies' poses are not
    expect(documentSimulationBytes(world(1), 100, { outsideHeap: true })).toBe(0);
    expect(documentSimulationBytes(world(2), 100, { outsideHeap: true })).toBeGreaterThan(0);
    // nothing simulated: nothing at all
    expect(documentSimulationBytes(world(0), 100, { outsideHeap: true })).toBe(0);
  });
});
