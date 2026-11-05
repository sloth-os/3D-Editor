import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { FrameState } from '../src/eval/frame-state';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { decodeFloat32, encodeFloat32 } from '../src/mesh/shape-keys';
import { transformPoint3 } from '../src/math/vec3';
import type { Vec3 } from '../src/math/types';
import { distance, ringCenter, tube } from './armature-helpers';

/*
 * Regression tests for problems found in review: scene-level evaluation of rigs (caching,
 * targets, errors), operators and robustness.
 */

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => {},
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const err = (id: string, params?: unknown) => {
    const r = run(id, params);
    expect(r.ok, `${id} should fail`).toBe(false);
    return r.error as string;
  };
  return { doc, ctx, run, ok, err };
}

/** "Rig" (Lower → Upper along +Z, connected) and an unbound tube "Tube" around it. */
function rigWithTube(s = setup()) {
  const rig = s.ok('object.armature_add', { name: 'Rig', bone_name: 'Lower', location: [0, 0, 0] }).object;
  s.ok('armature.bone_add', { name: 'Upper', parent: 'Lower', use_connect: true });
  const meshId = s.doc.addMesh('Tube', tube(21, 12, 0.2, 2));
  const tubeId = s.doc.addObject({ type: 'MESH', name: 'Tube', data: meshId });
  return { ...s, rig, tubeId, meshId };
}

/** "Rig" with Root → Thigh → Shin (a leg along +Z, slightly bent). */
function leg(s = setup()) {
  const rig = s.ok('object.armature_add', { name: 'Rig', bone_name: 'Root' }).object;
  s.ok('armature.chain_add', {
    points: [
      [0, 0, 1],
      [0, -0.1, 2],
      [0, 0, 3],
    ],
    names: ['Thigh', 'Shin'],
    parent: 'Root',
    use_connect: true,
  });
  return { ...s, rig };
}

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

/** World-space head / tail of a posed bone. */
function boneWorld(ev: ReturnType<SceneEvaluator['evaluate']>, rig: string, bone: string) {
  const o = ev.byId.get(rig)!;
  const b = o.pose!.bones.get(bone)!;
  return { head: transformPoint3(o.worldMatrix, b.head), tail: transformPoint3(o.worldMatrix, b.tail) };
}

const origin = (m: ArrayLike<number>): Vec3 => [m[12], m[13], m[14]];

describe('skinned mesh caching in a long-lived SceneEvaluator', () => {
  const bound = () => {
    const s = rigWithTube();
    s.ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_AUTO' });
    s.ok('pose.bone_transform_set', { object: 'Rig', bone: 'Upper', rotation_euler: [1, 0, 0] });
    const ev = new SceneEvaluator(s.doc);
    ev.evaluate(1);
    const check = () => {
      const cached = ev.evaluate(1).byId.get(s.tubeId)!.mesh!.positions;
      const fresh = new SceneEvaluator(s.doc).evaluate(1).byId.get(s.tubeId)!.mesh!.positions;
      expect(maxDiff(cached, fresh)).toBeLessThan(1e-9);
      return fresh;
    };
    return { ...s, ev, check };
  };

  it('re-skins when a bone stops deforming', () => {
    const { ok, check } = bound();
    ok('armature.bone_update', { object: 'Rig', bone: 'Upper', use_deform: false });
    const top = ringCenter(check(), 20, 12);
    expect(distance(top, [0, 0, 2])).toBeLessThan(1e-6);
  });

  it('re-skins when envelope settings change', () => {
    const { ok, doc, tubeId, check } = bound();
    const o = doc.getObject(tubeId)!;
    doc.updateObject(tubeId, {
      modifiers: [
        {
          ...o.modifiers[0],
          params: { ...o.modifiers[0].params, use_vertex_groups: false, use_bone_envelopes: true },
        },
      ],
    });
    check();
    ok('armature.bone_update', { object: 'Rig', bone: 'Upper', head_radius: 0.5, tail_radius: 0.5 });
    check();
  });

  it('re-skins when a bone is renamed to match another vertex group', () => {
    const { ok, check } = bound();
    ok('object.vertex_group_rename', { object: 'Tube', group: 'Upper', name: 'Forearm' });
    const unbound = check();
    expect(distance(ringCenter(unbound, 20, 12), [0, 0, 2])).toBeLessThan(1e-6);
    ok('armature.bone_update', { object: 'Rig', bone: 'Upper', name: 'Forearm' });
    expect(distance(ringCenter(check(), 20, 12), [0, 0, 2])).toBeGreaterThan(0.5);
  });
});

describe('bone constraint targets in the scene', () => {
  it('reaches a bone of another armature, even when both share bone names and transforms', () => {
    const { ok, doc } = setup();
    const a = ok('object.armature_add', { name: 'A', bone_name: 'Upper' }).object;
    ok('armature.bone_add', { object: 'A', name: 'Lower', parent: 'Upper', use_connect: true });
    // A has its own "Goal" bone at the same place as the armature B at the origin
    ok('armature.bone_add', { object: 'A', name: 'Goal', head: [1, 0, 1], tail: [1, 0, 1.2] });
    const b = ok('object.armature_add', { name: 'B', bone_name: 'Goal' }).object;
    ok('armature.bone_update', { object: 'B', bone: 'Goal', head: [-1, 0, 1], tail: [-1, 0, 1.2] });
    ok('pose.ik_add', { object: 'A', bone: 'Lower', target: 'B', subtarget: 'Goal', chain_count: 2 });
    let ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(a)!.pose!.errors).toEqual([]);
    expect(distance(boneWorld(ev, a, 'Lower').tail, boneWorld(ev, b, 'Goal').head)).toBeLessThan(1e-4);
    // B moved and posed: the chain follows B's posed bone in world space
    ok('object.transform_set', { objects: ['B'], location: [0.5, -0.5, 0] });
    ok('pose.bone_transform_set', { object: 'B', bone: 'Goal', location: [0, 0, 0.3] });
    ev = new SceneEvaluator(doc).evaluate(1);
    const goal = boneWorld(ev, b, 'Goal').head;
    expect(distance(goal, [-0.5, -0.5, 1])).toBeGreaterThan(0.1); // really moved
    expect(distance(boneWorld(ev, a, 'Lower').tail, goal)).toBeLessThan(1e-4);
  });

  it('copies the rotation of a bone of another armature', () => {
    const { ok, doc } = setup();
    const a = ok('object.armature_add', { name: 'A', bone_name: 'Arm' }).object;
    const b = ok('object.armature_add', { name: 'B', bone_name: 'Hand', location: [3, 0, 0] }).object;
    ok('pose.bone_transform_set', { object: 'B', bone: 'Hand', rotation_euler: [0, 0, 1] });
    ok('pose.constraint_add', {
      object: 'A',
      bone: 'Arm',
      type: 'COPY_ROTATION',
      target: 'B',
      subtarget: 'Hand',
    });
    const ev = new SceneEvaluator(doc).evaluate(1);
    const m = ev.byId.get(a)!.pose!.bones.get('Arm')!.matrix;
    const t = ev.byId.get(b)!.pose!.bones.get('Hand')!.matrix;
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) expect(m[i]).toBeCloseTo(t[i], 9);
    expect(ev.byId.get(a)!.pose!.errors).toEqual([]);
  });

  it('reaches an IK target object parented to a bone of the same rig, whatever the evaluation order', () => {
    // the target follows the Root bone (a usual control setup); the chain is Thigh → Shin
    for (const name of ['A_Target', 'Z_Target']) {
      const { ok, doc, rig } = leg();
      const e = ok('object.empty_add', { name, location: [0.5, -0.5, 2.0] }).object;
      ok('object.parent_to', { objects: [name], parent: 'Rig', type: 'BONE', bone: 'Root' });
      ok('pose.ik_add', { object: 'Rig', bone: 'Shin', target: name, chain_count: 2 });
      // Root points up (+Z): its pose location Y moves it (and the target) up
      ok('pose.bone_transform_set', { object: 'Rig', bone: 'Root', location: [0, 0.2, 0] });
      const ev = new SceneEvaluator(doc).evaluate(1);
      expect(ev.byId.get(rig)!.pose!.errors).toEqual([]);
      const target = origin(ev.byId.get(e)!.worldMatrix);
      expect(distance(target, [0.5, -0.5, 2.2])).toBeLessThan(1e-9); // follows Root
      expect(distance(boneWorld(ev, rig, 'Shin').tail, target)).toBeLessThan(1e-4);
      // FrameState asked for the pose first gives the same answer
      const fs = new FrameState(doc, 1);
      const pose = fs.pose(rig)!;
      expect(distance(origin(fs.world(e)!), target)).toBeLessThan(1e-9);
      expect(distance(transformPoint3(fs.world(rig)!, pose.bones.get('Shin')!.tail), target)).toBeLessThan(
        1e-4,
      );
    }
  });

  it('reports an IK target parented to a bone of its own chain as a cycle without failing', () => {
    const { ok, doc, rig } = leg();
    const e = ok('object.empty_add', { name: 'Target', location: [0.5, -0.5, 2.0] }).object;
    ok('object.parent_to', { objects: ['Target'], parent: 'Rig', type: 'BONE', bone: 'Thigh' });
    ok('pose.ik_add', { object: 'Rig', bone: 'Shin', target: 'Target', chain_count: 2 });
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(rig)!.pose!.errors!.length).toBeGreaterThan(0);
    for (const o of ev.objects) expect(o.worldMatrix.every((x) => Number.isFinite(x))).toBe(true);
    // the target still follows its (solved) parent bone
    const thigh = ev.byId.get(rig)!.pose!.bones.get('Thigh')!;
    expect(ev.byId.get(e)!.worldMatrix.every((x) => Number.isFinite(x))).toBe(true);
    expect(thigh.matrix.every((x) => Number.isFinite(x))).toBe(true);
  });

  it('evaluates WORLD space bone constraints in world space for rotated rigs', () => {
    const { ok, doc } = setup();
    const rig = ok('object.armature_add', { name: 'Rig', rotation: [0, 0, Math.PI / 2] }).object;
    doc.addObject({ type: 'EMPTY', name: 'T', location: [3, 5, 7] });
    ok('pose.constraint_add', {
      bone: 'Bone',
      type: 'COPY_LOCATION',
      target: 'T',
      params: { use_x: true, use_y: false, use_z: false },
    });
    const fs = new FrameState(doc, 1);
    const head = transformPoint3(fs.world(rig)!, fs.pose(rig)!.bones.get('Bone')!.head);
    expect(head[0]).toBeCloseTo(3, 9);
    expect(head[1]).toBeCloseTo(0, 9);
    expect(head[2]).toBeCloseTo(0, 9);
    // POSE space copies along the armature's own axes instead
    ok('pose.constraint_set', {
      bone: 'Bone',
      constraint: 'Copy Location',
      params: { owner_space: 'POSE', target_space: 'POSE' },
    });
    const fs2 = new FrameState(doc, 1);
    const local = fs2.pose(rig)!.bones.get('Bone')!.head;
    // T in armature space: rotate (3, 5, 7) by -90° about Z = (5, -3, 7); only x is copied
    expect(local[0]).toBeCloseTo(5, 9);
    expect(local[1]).toBeCloseTo(0, 9);
  });

  it('a constraint whose target was cleared does nothing (its sub-target bone goes too)', () => {
    const { ok, err, doc } = setup();
    ok('object.armature_add', { name: 'Rig', bone_name: 'Arm' });
    ok('armature.bone_add', { object: 'Rig', name: 'Hand', head: [0, 2, 0], tail: [0, 2, 1] });
    ok('pose.bone_transform_set', { object: 'Rig', bone: 'Hand', rotation_euler: [0, 0, 1] });
    ok('object.armature_add', { name: 'Other', bone_name: 'Hand', location: [3, 0, 0] });
    ok('pose.constraint_add', {
      object: 'Rig',
      bone: 'Arm',
      type: 'COPY_ROTATION',
      target: 'Other',
      subtarget: 'Hand',
    });
    expect(
      err('pose.constraint_set', {
        object: 'Rig',
        bone: 'Arm',
        constraint: 'Copy Rotation',
        target: '',
        subtarget: 'Hand',
      }),
    ).toMatch(/removes the target/);
    ok('pose.constraint_set', { object: 'Rig', bone: 'Arm', constraint: 'Copy Rotation', target: '' });
    const rig = doc.resolveObject('Rig')!;
    expect(rig.pose.bones.Arm.constraints![0]).toMatchObject({ target: null, subtarget: '' });
    const pose = new FrameState(doc, 1).pose(rig.id)!;
    const arm = pose.bones.get('Arm')!;
    expect(maxDiff(arm.matrix, arm.rest)).toBeLessThan(1e-12);
  });
});

describe('pose problems in scene errors', () => {
  it('reports pose problems as `pose:<id>` scene errors', () => {
    const { ok, doc, ctx, rig } = leg();
    const t = ok('object.empty_add', { name: 'Target', location: [0.5, -0.5, 2] }).object;
    ok('pose.ik_add', { object: 'Rig', bone: 'Shin', target: 'Target', chain_count: 2 });
    let ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.errors.filter((e) => e.source.startsWith('pose:'))).toEqual([]);
    ctx.state.selectedIds = [t];
    ctx.state.activeId = t;
    ok('object.delete', {});
    ev = new SceneEvaluator(doc).evaluate(1);
    const poseErrors = ev.byId.get(rig)!.pose!.errors!;
    expect(poseErrors).toEqual(['bone "Shin" constraint "IK": IK target not found']);
    expect(ev.errors).toContainEqual({ source: `pose:${rig}`, message: poseErrors[0] });
    // reported once per evaluation
    expect(ev.errors.filter((e) => e.source === `pose:${rig}`)).toHaveLength(1);
  });
});

describe('duplicating rigs', () => {
  it('keeps same-armature IK targets on the copy', () => {
    const { ok, doc, ctx, rig } = leg();
    ok('armature.bone_add', { name: 'Ctrl', head: [0.5, -0.5, 2.2], tail: [0.5, -0.5, 2.5] });
    ok('pose.ik_add', { bone: 'Shin', subtarget: 'Ctrl', chain_count: 2, pole_subtarget: 'Ctrl' });
    ctx.state.selectedIds = [rig];
    ctx.state.activeId = rig;
    const dup = ok('object.duplicate', { offset: [3, 0, 0] }).objects[0];
    const c = doc.getObject(dup)!.pose.bones.Shin.constraints![0];
    expect(c.target).toBe(dup);
    expect(c.params.pole_target).toBe(dup);
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(dup)!.pose!.errors).toEqual([]);
    expect(distance(boneWorld(ev, dup, 'Shin').tail, [3.5, -0.5, 2.2])).toBeLessThan(1e-4);
    // the original is untouched
    expect(doc.getObject(rig)!.pose.bones.Shin.constraints![0].target).toBe(rig);
    expect(distance(boneWorld(ev, rig, 'Shin').tail, [0.5, -0.5, 2.2])).toBeLessThan(1e-4);
  });

  it('binds a duplicated character to the copied rig', () => {
    const { ok, doc, tubeId } = rigWithTube();
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_AUTO' });
    ok('object.select', { objects: ['Tube', 'Rig'], active: 'Rig' });
    const dups = ok('object.duplicate', { offset: [5, 0, 0] }).objects as string[];
    const dupRig = dups.find((id) => doc.getObject(id)!.type === 'ARMATURE')!;
    const dupTube = dups.find((id) => doc.getObject(id)!.type === 'MESH')!;
    expect(doc.getObject(dupTube)!.modifiers[0].params.object).toBe(dupRig);
    expect(doc.getObject(dupTube)!.parent).toBe(dupRig);
    // posing the copy bends the copied mesh only
    ok('pose.bone_transform_set', { object: dupRig, bone: 'Upper', rotation_euler: [Math.PI / 2, 0, 0] });
    const ev = new SceneEvaluator(doc).evaluate(1);
    const top = (id: string) =>
      transformPoint3(ev.byId.get(id)!.worldMatrix, ringCenter(ev.byId.get(id)!.mesh!.positions, 20, 12));
    expect(distance(top(dupTube), [5, -1, 1])).toBeLessThan(0.05);
    expect(distance(top(tubeId), [0, 0, 2])).toBeLessThan(1e-6);
  });

  it('keeps references to objects outside the duplicated set', () => {
    const { ok, doc, ctx, rig } = leg();
    const t = ok('object.empty_add', { name: 'Target', location: [0.5, -0.5, 2] }).object;
    ok('pose.ik_add', { object: 'Rig', bone: 'Shin', target: 'Target', chain_count: 2 });
    ctx.state.selectedIds = [rig];
    ctx.state.activeId = rig;
    const dup = ok('object.duplicate', {}).objects[0];
    expect(doc.getObject(dup)!.pose.bones.Shin.constraints![0].target).toBe(t);
  });
});

describe('operators', () => {
  it('pose.transforms_clear re-keys only the channels it clears', () => {
    const { ok, doc, ctx } = setup();
    const rig = ok('object.armature_add', { name: 'Rig', bone_name: 'Bone' }).object;
    ok('pose.bone_transform_set', {
      bone: 'Bone',
      rotation_euler: [0, 0, 0],
      location: [0, 0, 0],
      keyframe: true,
      frame: 1,
    });
    ok('pose.bone_transform_set', {
      bone: 'Bone',
      rotation_euler: [1, 0, 0],
      location: [0, 1, 0],
      keyframe: true,
      frame: 21,
    });
    const at = (f: number) => new FrameState(doc, f).byId.get(rig)!.pose.bones.Bone;
    ctx.state.frame = 11;
    const curves = () => doc.listFCurves(rig).map((fc) => `${fc.path}[${fc.index}]:${fc.keyframes.length}`);
    const before = curves();
    expect(at(11).rotation_euler[0]).toBeCloseTo(0.5, 9);
    const r = ok('pose.transforms_clear', { type: 'LOCATION' });
    expect(r.channels).toEqual(['location']);
    expect(at(11).rotation_euler[0]).toBeCloseTo(0.5, 9); // untouched animation
    expect(at(11).location).toEqual([0, 0, 0]); // the cleared channel is keyed at frame 11
    expect(at(21).location[1]).toBeCloseTo(1, 9);
    const after = curves();
    for (const c of before.filter((x) => x.startsWith('pose.bones["Bone"].rotation_euler')))
      expect(after).toContain(c);
  });

  it('object.modifier_apply bakes the Armature modifier (current pose) into the mesh', () => {
    const { ok, doc, tubeId, meshId } = rigWithTube();
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_AUTO' });
    ok('pose.bone_transform_set', { object: 'Rig', bone: 'Upper', rotation_euler: [Math.PI / 2, 0, 0] });
    const shown = new SceneEvaluator(doc).evaluate(1).byId.get(tubeId)!.mesh!.positions;
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    ok('object.modifier_apply', { object: 'Tube', modifier: 'Armature' });
    const o = doc.getObject(tubeId)!;
    expect(o.modifiers).toEqual([]);
    const baked = doc.getMesh(o.data!)!.positions;
    expect(maxDiff(baked, shown)).toBeLessThan(1e-5);
    expect(distance(ringCenter(baked, 20, 12), [0, -1, 1])).toBeLessThan(0.05);
    um.undo();
    expect(doc.getObject(tubeId)!.modifiers).toHaveLength(1);
    expect(distance(ringCenter(doc.getMesh(meshId)!.positions, 20, 12), [0, 0, 2])).toBeLessThan(1e-6);
  });

  it('shape key "from mix" and "apply mix" use the blend shown at the current frame', () => {
    const { ok, doc, ctx } = setup();
    const cube = ok('mesh.primitive_cube_add', { size: 2 }).object;
    const meshId = doc.getObject(cube)!.data!;
    ok('object.shape_key_add', { object: cube, name: 'Up' });
    ok('object.shape_key_set_positions', {
      object: cube,
      key: 'Up',
      offsets: Array.from({ length: 8 }, () => [0, 0, 1]),
    });
    ok('object.shape_key_set', { object: cube, key: 'Up', value: 0, keyframe: true, frame: 1 });
    ok('object.shape_key_set', { object: cube, key: 'Up', value: 1, keyframe: true, frame: 11 });
    ctx.state.frame = 6;
    const shown = new SceneEvaluator(doc).evaluate(6).byId.get(cube)!.mesh!.positions;
    expect(shown[2]).toBeCloseTo(-0.5, 6); // half way up
    ok('object.shape_key_add', { object: cube, name: 'Mix', from_mix: true });
    const mix = decodeFloat32(doc.getShapeKeys(meshId)[1].data);
    expect(maxDiff(mix, shown)).toBeLessThan(1e-6);
    ok('object.shape_key_remove', { object: cube, all: true, apply_mix: true });
    expect(maxDiff(doc.getMesh(meshId)!.positions, shown)).toBeLessThan(1e-6);
    expect(doc.getShapeKeys(meshId)).toEqual([]);
  });

  it('animates bone constraint influence (IK/FK switching) end to end', () => {
    const { ok, doc, run } = setup();
    const rig = ok('object.armature_add', { name: 'Rig', bone_name: 'Upper' }).object;
    ok('armature.bone_add', { object: 'Rig', name: 'Lower', parent: 'Upper', use_connect: true });
    ok('armature.bone_add', { object: 'Rig', name: 'Goal', head: [1, 0, 1], tail: [1, 0, 1.2] });
    ok('pose.ik_add', { object: 'Rig', bone: 'Lower', subtarget: 'Goal', chain_count: 2 });
    const path = 'pose.bones["Lower"].constraints["IK"].influence';
    const r = run('anim.keyframe_insert_property', { target_type: 'object', target: 'Rig', path, frame: 10 });
    expect(r.error).toBeUndefined();
    const k = ok('pose.constraint_set', {
      object: 'Rig',
      bone: 'Lower',
      constraint: 'IK',
      influence: 0,
      keyframe: true,
      frame: 1,
    });
    expect(k.keyframes_inserted).toBe(1);
    const tip = (f: number) => boneWorld(new SceneEvaluator(doc).evaluate(f), rig, 'Lower').tail;
    expect(distance(tip(1), [0, 0, 2])).toBeLessThan(1e-9); // FK
    expect(distance(tip(10), [1, 0, 1])).toBeLessThan(1e-4); // IK
    const mid = tip(5.5);
    expect(distance(mid, [0, 0, 2])).toBeGreaterThan(0.1);
    expect(distance(mid, [1, 0, 1])).toBeGreaterThan(0.1);
    // renaming the constraint keeps its animation; removing it deletes it
    ok('pose.constraint_set', { object: 'Rig', bone: 'Lower', constraint: 'IK', name: 'Leg IK' });
    expect(doc.listFCurves(rig).map((fc) => fc.path)).toEqual([
      'pose.bones["Lower"].constraints["Leg IK"].influence',
    ]);
    expect(distance(tip(1), [0, 0, 2])).toBeLessThan(1e-9);
    ok('pose.constraint_remove', { object: 'Rig', bone: 'Lower', constraint: 'Leg IK' });
    expect(doc.listFCurves(rig)).toEqual([]);
  });

  it('never names bones after Object.prototype members', () => {
    const { ok, doc } = setup();
    const rig = ok('object.armature_add', { name: 'Rig', bone_name: '__proto__' }).object;
    const names = [ok('object.armature_add', {}).bones[0]];
    for (const name of ['constructor', 'toString', 'hasOwnProperty'])
      names.push(
        ok('armature.bone_add', {
          object: 'Rig',
          name,
          parent: doc.getArmature(doc.getObject(rig)!.data!)!.bones[0].name,
        }).bone,
      );
    ok('armature.bone_update', { object: 'Rig', bone: names[1], name: 'valueOf' });
    const bones = doc.getArmature(doc.getObject(rig)!.data!)!.bones.map((b) => b.name);
    expect(bones).toEqual(
      ['__proto__.001', 'constructor.001', 'toString.001', 'hasOwnProperty.001'].map((n, i) =>
        i === 1 ? 'valueOf.001' : n,
      ),
    );
    const channels = doc.getObject(rig)!.pose.bones;
    for (const n of bones) {
      expect(Object.hasOwn(channels, n)).toBe(true);
      expect(typeof channels[n]).toBe('object');
      ok('pose.bone_transform_set', { object: 'Rig', bone: n, rotation_euler: [0.1, 0, 0], keyframe: true });
    }
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(Object.keys(copy.getObject(rig)!.pose.bones).sort()).toEqual([...bones].sort());
    expect(new SceneEvaluator(copy).evaluate(1).byId.get(rig)!.pose!.errors).toEqual([]);
  });
});

describe('robustness', () => {
  it('ignores invalid (NaN) weights of the Armature modifier mask group', () => {
    const { ok, doc, tubeId, meshId } = rigWithTube();
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_AUTO' });
    const mask = new Float32Array(21 * 12).fill(1);
    mask[200] = NaN;
    mask[201] = Infinity;
    doc.setVertexGroups(meshId, [
      ...doc.getVertexGroups(meshId),
      { name: 'Mask', weights: encodeFloat32(mask) },
    ]);
    const setMask = (invert: boolean) => {
      const o = doc.getObject(tubeId)!;
      doc.updateObject(tubeId, {
        modifiers: [
          {
            ...o.modifiers[0],
            params: { ...o.modifiers[0].params, vertex_group: 'Mask', invert_vertex_group: invert },
          },
        ],
      });
    };
    ok('pose.bone_transform_set', { object: 'Rig', bone: 'Upper', rotation_euler: [1, 0, 0] });
    const base = doc.getMesh(meshId)!.positions;
    const free = new SceneEvaluator(doc).evaluate(1).byId.get(tubeId)!.mesh!.positions;
    setMask(false);
    let r = new SceneEvaluator(doc).evaluate(1).byId.get(tubeId)!;
    expect(r.modifierErrors).toEqual([]);
    expect(r.mesh!.positions.every((x) => Number.isFinite(x))).toBe(true);
    // invalid weights count as "not in the group": those vertices stay put, the others deform fully
    for (const v of [200, 201])
      for (let k = 0; k < 3; k++) expect(r.mesh!.positions[v * 3 + k]).toBeCloseTo(base[v * 3 + k], 9);
    expect(r.mesh!.positions[199 * 3 + 1]).toBeCloseTo(free[199 * 3 + 1], 9);
    // inverted: they deform fully, the others stay put
    setMask(true);
    r = new SceneEvaluator(doc).evaluate(1).byId.get(tubeId)!;
    for (const v of [200, 201])
      for (let k = 0; k < 3; k++) expect(r.mesh!.positions[v * 3 + k]).toBeCloseTo(free[v * 3 + k], 9);
    expect(r.mesh!.positions[199 * 3 + 1]).toBeCloseTo(base[199 * 3 + 1], 9);
  });
});
