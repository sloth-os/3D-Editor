import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/anim/fcurve', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/anim/fcurve')>();
  return { ...mod, evaluateFCurve: vi.fn(mod.evaluateFCurve) };
});
vi.mock('../src/constraints/depgraph', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/constraints/depgraph')>();
  return { ...mod, dependencyGraph: vi.fn(mod.dependencyGraph) };
});
vi.mock('../src/armature/pose', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/armature/pose')>();
  return { ...mod, createPoseEvaluation: vi.fn(mod.createPoseEvaluation) };
});

import { evaluateFCurve } from '../src/anim/fcurve';
import { dependencyGraph } from '../src/constraints/depgraph';
import { createPoseEvaluation } from '../src/armature/pose';
import {
  FrameState,
  ObjectTransform,
  SceneDoc,
  createConstraint,
  createEditorState,
  createFCurve,
  defaultBone,
  defaultPoseBone,
  insertKeyframe,
  selectionPivot,
  translation4,
  type ConstraintData,
} from '../src';

/*
 * What a pointer move of the modal Move, Rotate and Scale costs (ObjectTransform.worlds): only the
 * objects the move can change are evaluated; the rest of the scene (here hundreds of animated
 * objects) is read from the frame state the transform started from, and no dependency graph of
 * the whole scene is built again.
 */

describe('a pointer move of a transform', () => {
  it('evaluates only the moved object and the objects reading it, whatever the size of the scene', () => {
    const doc = SceneDoc.create({ empty: true });
    const key = (id: string) => {
      let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 2 });
      fc = insertKeyframe(insertKeyframe(fc, 1, 0), 9, 4);
      doc.setFCurve(fc);
    };
    let moved = '';
    doc.transact(() => {
      for (let i = 0; i < 400; i++) key(doc.addObject({ type: 'EMPTY', name: `A${i}`, location: [i, 0, 0] }));
      moved = doc.addObject({ type: 'EMPTY', name: 'Moved' });
      doc.addObject({ type: 'EMPTY', name: 'Child', parent: moved, location: [0, 0, 1] });
      const reader = doc.addObject({
        type: 'EMPTY',
        name: 'Reader',
        constraints: [createConstraint('COPY_LOCATION', { target: moved })],
      });
      key(reader);
    });
    const fs = new FrameState(doc, 4);
    fs.allWorldMatrices();
    const xf = new ObjectTransform(fs, [moved], 'MEDIAN_POINT', 'TRANSLATE');
    const channels = xf.channels(translation4([0, 1, 0]), [0, 0, 0]);
    // the first move finds the objects the transform can change (it reads the scene once)
    xf.worlds(channels);
    const curves = vi.mocked(evaluateFCurve);
    const graphs = vi.mocked(dependencyGraph);
    curves.mockClear();
    graphs.mockClear();
    const byId = vi.spyOn(FrameState.prototype, 'byId', 'get');
    const objects = vi.spyOn(FrameState.prototype, 'objects', 'get');
    try {
      const out = xf.worlds(channels);
      expect(out.size).toBe(3);
      // the reader's own F-curve, none of the other 400 objects' curves
      expect(curves).toHaveBeenCalledTimes(1);
      // the reader's constraint is checked against the dependency cycles of the frame state the
      // transform started from
      expect(graphs).toHaveBeenCalled();
      expect(graphs.mock.calls.every(([src]) => src === fs)).toBe(true);
      // the preview lists no object of the scene
      expect(byId.mock.contexts.filter((c) => c !== fs)).toEqual([]);
      expect(objects.mock.contexts.filter((c) => c !== fs)).toEqual([]);
    } finally {
      byId.mockRestore();
      objects.mockRestore();
    }
  });

  it('reads the pose of an armature it does not change from the frame state it started from', () => {
    // the moved object hangs from a bone: placing it needs the bone, whose pose the move leaves
    const doc = SceneDoc.create({ empty: true });
    const rig = doc.addObject({
      type: 'ARMATURE',
      name: 'Rig',
      data: doc.addArmature({ bones: [defaultBone('B', [0, 0, 0], [0, 0, 1])] }),
    });
    const moved = doc.addObject({
      type: 'EMPTY',
      name: 'Moved',
      parent: rig,
      parent_type: 'BONE',
      parent_bone: 'B',
    });
    const fs = new FrameState(doc, 1);
    const xf = new ObjectTransform(fs, [moved], 'MEDIAN_POINT', 'TRANSLATE');
    const channels = xf.channels(translation4([0, 1, 0]), [0, 0, 0]);
    xf.worlds(channels);
    const poses = vi.mocked(createPoseEvaluation);
    poses.mockClear();
    const out = xf.worlds(channels);
    // from the bone's tail at [0, 0, 1], moved by 1 along the world Y axis
    expect(out.get(moved)!.slice(12, 15)).toEqual([0, 1, 1]);
    expect(poses).not.toHaveBeenCalled();
  });

  it('solves the IK chain whose target moves without evaluating the rest of the scene', () => {
    // B1 reaches for T with B0 (chain_count 2): moving T solves the chain anew, places the child of
    // B1, and evaluates none of the 400 animated objects
    const doc = SceneDoc.create({ empty: true });
    let target = '';
    let child = '';
    doc.transact(() => {
      for (let i = 0; i < 400; i++) {
        const id = doc.addObject({ type: 'EMPTY', name: `A${i}`, location: [i, 0, 0] });
        let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 2 });
        fc = insertKeyframe(insertKeyframe(fc, 1, 0), 9, 4);
        doc.setFCurve(fc);
      }
      target = doc.addObject({ type: 'EMPTY', name: 'T', location: [1, 0, 1.5] });
      const rig = doc.addObject({
        type: 'ARMATURE',
        name: 'Rig',
        data: doc.addArmature({
          bones: [
            defaultBone('B0', [0, 0, 0], [0, 0, 1]),
            { ...defaultBone('B1', [0, 0, 1], [0, 0, 2]), parent: 'B0', use_connect: true },
          ],
        }),
      });
      const ik = createConstraint('IK' as Parameters<typeof createConstraint>[0], { target });
      doc.updateObject(rig, {
        pose: { bones: { B1: { constraints: [{ ...ik, params: { chain_count: 2 } }] } } } as never,
      });
      child = doc.addObject({
        type: 'EMPTY',
        name: 'Child',
        parent: rig,
        parent_type: 'BONE',
        parent_bone: 'B1',
      });
    });
    const fs = new FrameState(doc, 4);
    fs.allWorldMatrices();
    const xf = new ObjectTransform(fs, [target], 'MEDIAN_POINT', 'TRANSLATE');
    const channels = xf.channels(translation4([0, 0.5, 0]), [0, 0, 0]);
    xf.worlds(channels);
    const curves = vi.mocked(evaluateFCurve);
    curves.mockClear();
    const out = xf.worlds(channels);
    expect([...out.keys()].sort()).toEqual([target, doc.resolveObject('Rig')!.id, child].sort());
    expect(curves).not.toHaveBeenCalled();
  });

  it('is no dependency cycle where a driver of a parent reads its child’s channel', () => {
    // Y's Z location is driven by the X location of X, its child: drivers read channels, not
    // matrices, so moving X evaluates X and Y, none of the 300 animated objects
    const doc = SceneDoc.create({ empty: true });
    let x = '';
    let y = '';
    doc.transact(() => {
      for (let i = 0; i < 300; i++) {
        const id = doc.addObject({ type: 'EMPTY', name: `A${i}`, location: [i, 0, 0] });
        let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 2 });
        fc = insertKeyframe(insertKeyframe(fc, 1, 0), 9, 4);
        doc.setFCurve(fc);
      }
      y = doc.addObject({ type: 'EMPTY', name: 'Y' });
      x = doc.addObject({ type: 'EMPTY', name: 'X', parent: y, location: [1, 0, 0] });
      doc.setDriver({
        target_type: 'object',
        target_id: y,
        path: 'location',
        index: 2,
        expression: 'v * 0.5',
        variables: [{ name: 'v', target_type: 'object', target_id: x, path: 'location', index: 0 }],
        mute: false,
      });
    });
    const fs = new FrameState(doc, 4);
    fs.allWorldMatrices();
    const xf = new ObjectTransform(fs, [x], 'MEDIAN_POINT', 'TRANSLATE');
    const channels = xf.channels(translation4([1, 0, 0]), [0, 0, 0]);
    xf.worlds(channels);
    const curves = vi.mocked(evaluateFCurve);
    curves.mockClear();
    const out = xf.worlds(channels);
    // X at 2 drives Y up to 1; X follows it
    expect(Array.from(out.get(y)!.slice(12, 15))).toEqual([0, 0, 1]);
    expect(Array.from(out.get(x)!.slice(12, 15))).toEqual([2, 0, 1]);
    expect(curves).not.toHaveBeenCalled();
  });

  it('finds the pivot without evaluating the scene when a dependency cycle elsewhere does not reach the selection', () => {
    // six armatures with IK chains and objects on their bones (costly to evaluate), the selected
    // empty, and, in the second scene only, a cycle between two other empties (each copies the
    // other's location): the pivot evaluates as many objects in both scenes, and costs about as
    // much (0.8-1.0 times, measured here alternately; evaluating the whole scene first made it
    // 3.7-4.0 times)
    const scene = (cycle: boolean) => {
      const doc = SceneDoc.create({ empty: true });
      let selected = '';
      doc.transact(() => {
        selected = doc.addObject({ type: 'EMPTY', name: 'Sel', location: [5, 5, 0] });
        for (let r = 0; r < 6; r++) {
          const bones = Array.from({ length: 20 }, (_, i) => ({
            ...defaultBone(`B${i}`, [0, 0, i * 0.2], [0, 0.05, (i + 1) * 0.2]),
            ...(i ? { parent: `B${i - 1}`, use_connect: true } : {}),
          }));
          const rig = doc.addObject({
            type: 'ARMATURE',
            name: `Rig${r}`,
            location: [r * 3, 0, 0],
            data: doc.addArmature({ bones }),
          });
          const target = doc.addObject({ type: 'EMPTY', name: `T${r}`, location: [r * 3 + 2, 1, 3] });
          const ik = createConstraint('IK' as ConstraintData['type'], { target });
          const pose: Record<string, unknown> = {};
          for (let i = 0; i < 19; i++) pose[`B${i}`] = defaultPoseBone();
          pose.B19 = { ...defaultPoseBone(), constraints: [{ ...ik, params: { chain_count: 0 } }] };
          doc.updateObject(rig, { pose: { bones: pose } as never });
          for (let i = 0; i < 20; i++)
            doc.addObject({
              type: 'EMPTY',
              name: `K${r}_${i}`,
              parent: rig,
              parent_type: 'BONE',
              parent_bone: `B${i}`,
            });
        }
        if (cycle) {
          const a = doc.addObject({ type: 'EMPTY', name: 'CycA' });
          const b = doc.addObject({ type: 'EMPTY', name: 'CycB', location: [1, 0, 0] });
          doc.updateObject(a, { constraints: [createConstraint('COPY_LOCATION', { target: b })] });
          doc.updateObject(b, { constraints: [createConstraint('COPY_LOCATION', { target: a })] });
        }
      });
      const state = createEditorState();
      Object.assign(state, { selectedIds: [selected], activeId: selected });
      return { doc, state };
    };
    const plain = scene(false);
    const cyclic = scene(true);
    const pivot = (s: typeof plain, frame: number) => {
      s.state.frame = frame;
      const t0 = performance.now();
      expect(selectionPivot(s.doc, s.state, 'MEDIAN_POINT')).toEqual([5, 5, 0]);
      return performance.now() - t0;
    };
    const evaluated = (s: typeof plain) => {
      const world = vi.spyOn(FrameState.prototype, 'world');
      try {
        pivot(s, 1);
        return new Set(world.mock.calls.map(([id]) => id)).size;
      } finally {
        world.mockRestore();
      }
    };
    expect(evaluated(cyclic)).toBe(evaluated(plain));
    const times: [number[], number[]] = [[], []];
    for (let frame = 2; frame < 22; frame++) {
      const order = frame % 2 ? [0, 1] : [1, 0];
      for (const k of order) times[k].push(pivot(k ? cyclic : plain, frame));
    }
    const median = (l: number[]) => [...l].sort((a, b) => a - b)[l.length >> 1];
    expect(median(times[1])).toBeLessThan(2 * median(times[0]));
  });

  it('reads the scene from the document once for the gizmo’s pivot, which follows every frame change', () => {
    // the pivot's frame state (with the rigid body simulation, transformFrameState) reads the
    // objects once, also to find out whether a rigid body is simulated
    const doc = SceneDoc.create({ empty: true });
    const id = doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 2, 3] });
    const state = createEditorState();
    state.selectedIds = [id];
    state.activeId = id;
    const list = vi.spyOn(doc, 'listObjects');
    expect(selectionPivot(doc, state, 'MEDIAN_POINT')).toEqual([1, 2, 3]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
