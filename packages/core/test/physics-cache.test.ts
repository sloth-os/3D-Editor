import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { createCube } from '../src/mesh/primitives';
import { SceneEvaluator } from '../src/eval/evaluate';
import { RigidBodySimulator, freeRigidBodyCache, rigidBodyCacheInfo } from '../src/physics/rigid-body';
import { hostOf, loc, physicsScene, rb } from './physics-helpers';

/** A box dropped onto a passive ground (frames 1 … 250, 10 substeps). */
function dropScene() {
  const s = physicsScene();
  const ground = s.ground();
  const box = s.add('Box', s.cube(1), rb('ACTIVE'), { location: [0, 0, 4], rotation_euler: [0.2, 0.1, 0] });
  freeRigidBodyCache(s.doc);
  const sim = new RigidBodySimulator();
  const host = hostOf(s.doc);
  const evaluate = (f: number) => sim.evaluate(s.doc, f, host);
  const steps = () => rigidBodyCacheInfo(s.doc)?.steps ?? 0;
  return { ...s, ground, box, sim, host, evaluate, steps };
}

describe('frame range semantics', () => {
  it('leaves objects alone at and before frame_start and holds the last state after frame_end', () => {
    const t = dropScene();
    t.setWorld({ frame_start: 5, frame_end: 40 });
    expect(t.evaluate(1)).toBeNull();
    expect(t.evaluate(5)).toBeNull();
    const at6 = t.evaluate(6)!;
    expect(loc(at6.get(t.box)!)[2]).toBeLessThan(4);
    expect(at6.has(t.ground)).toBe(false); // passive bodies keep their own transform
    const end = t.evaluate(40)!.get(t.box)!;
    expect(t.evaluate(41)!.get(t.box)).toEqual(end);
    expect(t.evaluate(500)!.get(t.box)).toEqual(end);
    expect(rigidBodyCacheInfo(t.doc)!.simulated_to).toBe(40);
  });

  it('interpolates fractional frames between the cached neighbours', () => {
    const t = dropScene();
    const a = loc(t.evaluate(10)!.get(t.box)!);
    const b = loc(t.evaluate(11)!.get(t.box)!);
    const mid = loc(t.evaluate(10.25)!.get(t.box)!);
    for (let k = 0; k < 3; k++) expect(mid[k]).toBeCloseTo(a[k] + 0.25 * (b[k] - a[k]), 9);
    // between frame_start and the first simulated frame too
    expect(loc(t.evaluate(1.5)!.get(t.box)!)[2]).toBeLessThan(4);
    expect(t.evaluate(Number.NaN)).toBeNull();
  });

  it('returns null when the world is disabled or has no active body', () => {
    const t = dropScene();
    t.setWorld({ enabled: false });
    expect(t.evaluate(30)).toBeNull();
    t.setWorld({ enabled: true });
    expect(t.evaluate(30)).not.toBeNull();
    t.doc.updateObject(t.box, { rigid_body: rb('PASSIVE') });
    expect(t.evaluate(30)).toBeNull();
  });
});

describe('incremental cache', () => {
  it('steps only the frames that are new and looks up earlier ones', () => {
    const t = dropScene();
    t.evaluate(50);
    expect(t.steps()).toBe(49 * 10);
    const at30 = t.evaluate(30)!.get(t.box);
    expect(t.steps()).toBe(49 * 10);
    t.evaluate(100);
    expect(t.steps()).toBe(99 * 10);
    // looking back gives what a fresh run computes
    freeRigidBodyCache(t.doc);
    expect(t.evaluate(30)!.get(t.box)).toEqual(at30);
    expect(t.steps()).toBe(29 * 10);
  });

  it('keeps the cache when unrelated data changes', () => {
    const t = dropScene();
    const before = t.evaluate(60)!.get(t.box);
    const steps = t.steps();
    t.doc.addMaterial({ name: 'Red' });
    t.doc.updateObject(t.box, { name: 'Renamed', hide_viewport: true });
    const other = t.doc.addObject({ type: 'EMPTY', name: 'Other' });
    t.doc.updateObject(other, { location: [5, 5, 5] });
    // keyframes of an ACTIVE body after frame_start do not matter (only its start pose does)
    t.doc.setFCurve({
      target_type: 'object',
      target_id: t.box,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 40, value: 9, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    expect(t.evaluate(60)!.get(t.box)).toEqual(before);
    expect(t.steps()).toBe(steps);
  });

  it('re-simulates from frame_start when simulation inputs change', () => {
    const changes: [string, (t: ReturnType<typeof dropScene>) => void][] = [
      ['mass', (t) => t.doc.updateObject(t.box, { rigid_body: rb('ACTIVE', { mass: 3 }) })],
      [
        'shape',
        (t) => t.doc.updateObject(t.box, { rigid_body: rb('ACTIVE', { collision_shape: 'SPHERE' }) }),
      ],
      ['start pose', (t) => t.doc.updateObject(t.box, { location: [0, 0, 6] })],
      ['substeps', (t) => t.setWorld({ substeps_per_frame: 5 })],
      ['gravity', (t) => t.doc.updateScene({ gravity: [0, 0, -3] })],
      ['fps', (t) => t.doc.updateScene({ fps: 30 })],
      ['mesh', (t) => t.doc.setMesh(t.doc.getObject(t.box)!.data!, createCube({ size: 0.5 }))],
      ['ground', (t) => t.doc.updateObject(t.ground, { location: [0, 0, 1] })],
    ];
    for (const [what, change] of changes) {
      const t = dropScene();
      const before = t.evaluate(60)!.get(t.box)!;
      change(t);
      const after = t.evaluate(60)!.get(t.box)!;
      expect(after, what).not.toEqual(before);
      const fresh = (() => {
        freeRigidBodyCache(t.doc);
        return new RigidBodySimulator().evaluate(t.doc, 60, hostOf(t.doc))!.get(t.box)!;
      })();
      expect(after, what).toEqual(fresh);
    }
  });

  it('notices removed bodies, including undo of an added rigid body', () => {
    const t = dropScene();
    const um = new Y.UndoManager(t.doc.sharedTypes(), {
      trackedOrigins: new Set([t.doc.origin]),
      captureTimeout: 0,
    });
    const blocker = t.doc.transact(
      () => t.add('Blocker', t.cube(1), null, { location: [0, 0, 1.5] }),
      'setup',
    );
    t.doc.transact(() => t.doc.updateObject(blocker, { rigid_body: rb('PASSIVE') }), t.doc.origin);
    expect(loc(t.evaluate(80)!.get(t.box)!)[2]).toBeGreaterThan(2); // rests on the blocker
    um.undo(); // a pure deletion in Yjs terms
    expect(t.doc.getObject(blocker)!.rigid_body).toBeNull();
    expect(loc(t.evaluate(80)!.get(t.box)!)[2]).toBeCloseTo(0.5, 2);
    t.doc.removeObject(t.ground);
    expect(loc(t.evaluate(80)!.get(t.box)!)[2]).toBeLessThan(-10);
  });

  it('re-checks animated bodies against the cache up to the evaluated frame', () => {
    const t = dropScene();
    const lift = t.add('Lift', t.cube(1), rb('PASSIVE', { kinematic: true }), { location: [0, 0, -2] });
    const key = (z40: number) =>
      t.doc.setFCurve({
        target_type: 'object',
        target_id: lift,
        path: 'location',
        index: 2,
        keyframes: [
          { frame: 1, value: -2, interpolation: 'LINEAR' },
          { frame: 40, value: z40, interpolation: 'LINEAR' },
        ],
        extrapolation: 'CONSTANT',
        mute: false,
      });
    key(-2);
    const still = loc(t.evaluate(80)!.get(t.box)!)[2];
    expect(still).toBeCloseTo(0.5, 2);
    // the lift now rises through the ground and carries the box up
    key(1.5);
    const lifted = loc(t.evaluate(80)!.get(t.box)!)[2];
    expect(lifted).toBeCloseTo(2.5, 1);
    freeRigidBodyCache(t.doc);
    expect(loc(new RigidBodySimulator().evaluate(t.doc, 80, hostOf(t.doc))!.get(t.box)!)[2]).toBe(lifted);
  });

  it('sees changes made earlier in the same transaction', () => {
    const t = dropScene();
    const before = t.evaluate(40)!.get(t.box)!;
    t.doc.transact(() => {
      t.doc.updateObject(t.box, { location: [3, 0, 4] });
      const moved = t.evaluate(40)!.get(t.box)!;
      expect(moved).not.toEqual(before);
      expect(loc(moved)[0]).toBeGreaterThan(2.5); // dropped from x = 3 (it tumbles a little)
      t.doc.updateObject(t.box, { location: [0, 0, 4] });
      expect(t.evaluate(40)!.get(t.box)).toEqual(before);
    });
  });

  it('shares one cache per document between simulators and evaluators', () => {
    const t = dropScene();
    t.evaluate(70);
    const steps = t.steps();
    const other = new RigidBodySimulator();
    other.evaluate(t.doc, 70, hostOf(t.doc));
    const ev = new SceneEvaluator(t.doc).evaluate(70);
    expect(ev.byId.get(t.box)!.simulated).toBe(true);
    expect(t.steps()).toBe(steps);
    // a copy of the document has its own cache with identical results
    const copy = SceneDoc.fromUpdate(t.doc.encodeState());
    expect(new RigidBodySimulator().evaluate(copy, 70, hostOf(copy))!.get(t.box)).toEqual(
      t.evaluate(70)!.get(t.box),
    );
    // dropping the cache (cache_free, SceneEvaluator.clearCache) re-simulates
    expect(freeRigidBodyCache(t.doc)!.simulated_to).toBe(70);
    expect(rigidBodyCacheInfo(t.doc)).toBeNull();
    expect(freeRigidBodyCache(t.doc)).toBeNull();
    const evaluator = new SceneEvaluator(t.doc);
    evaluator.evaluate(20);
    expect(t.steps()).toBe(19 * 10);
    evaluator.clearCache();
    expect(rigidBodyCacheInfo(t.doc)).toBeNull();
  });
});

describe('scene evaluation', () => {
  it('drives evaluated world matrices, flags simulated objects and moves their children', () => {
    const s = physicsScene();
    s.ground();
    const box = s.add('Box', s.cube(1), rb('ACTIVE'), { location: [0, 0, 3], scale: [1, 1, 1] });
    const child = s.doc.addObject({ type: 'EMPTY', name: 'Child', parent: box, location: [0, 0, 1] });
    const lift = s.add('Animated', s.cube(1), rb('ACTIVE', { kinematic: true }), { location: [5, 0, 1] });
    const ev = new SceneEvaluator(s.doc);
    const f1 = ev.evaluate(1);
    expect(f1.byId.get(box)!.simulated).toBe(false);
    expect(loc(f1.byId.get(box)!.worldMatrix)).toEqual([0, 0, 3]);
    const f60 = ev.evaluate(60);
    const b = f60.byId.get(box)!;
    expect(b.simulated).toBe(true);
    expect(loc(b.worldMatrix)[2]).toBeCloseTo(0.5, 2);
    expect(f60.byId.get(lift)!.simulated).toBe(false);
    expect(f60.byId.get(s.doc.findObjectByName('Ground')!.id)!.simulated).toBe(false);
    // children follow the simulated parent
    const c = loc(f60.byId.get(child)!.worldMatrix);
    expect(c[2]).toBeCloseTo(1.5, 2);
    expect(f60.errors).toEqual([]);
    // per-object problems are reported without stopping the simulation
    const bad = s.doc.addObject({ type: 'EMPTY', name: 'NotAMesh', rigid_body: rb('ACTIVE') });
    const withIssue = ev.evaluate(61);
    expect(withIssue.errors).toEqual([
      {
        source: `rigidbody:${bad}`,
        message: expect.stringMatching(/^ERROR: rigid bodies need a mesh object/),
      },
    ]);
    expect(withIssue.byId.get(box)!.simulated).toBe(true);
    s.doc.removeObject(bad);
    // noPhysics shows the unsimulated transforms
    const raw = ev.evaluate(60, { noPhysics: true });
    expect(raw.byId.get(box)!.simulated).toBe(false);
    expect(loc(raw.byId.get(box)!.worldMatrix)).toEqual([0, 0, 3]);
  });
});
