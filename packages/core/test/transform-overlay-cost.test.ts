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
  createFCurve,
  defaultBone,
  insertKeyframe,
  translation4,
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
});
