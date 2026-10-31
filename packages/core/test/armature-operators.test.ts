import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { defaultPoseBone } from '../src/doc/defaults';
import { FrameState } from '../src/eval/frame-state';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { decodeFloat32 } from '../src/mesh/shape-keys';
import { boneRestMatrix } from '../src/armature';
import type { Vec3 } from '../src/math/types';
import { distance, ringCenter, tube } from './armature-helpers';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
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
  const bones = (obj: string) => doc.getArmature(doc.getObject(obj)!.data!)!.bones;
  const bone = (obj: string, name: string) => bones(obj).find((b) => b.name === name)!;
  return { doc, reg, ctx, run, ok, err, reports, bones, bone };
}

/** Armature "Rig" with a two bone chain Lower → Upper along +Z and a tube mesh "Tube" around it. */
function rigWithTube(s = setup()) {
  const rig = s.ok('object.armature_add', { name: 'Rig', bone_name: 'Lower', location: [0, 0, 0] }).object;
  s.ok('armature.bone_add', { name: 'Upper', parent: 'Lower', use_connect: true });
  const meshId = s.doc.addMesh('Tube', tube(21, 12, 0.2, 2));
  const tubeId = s.doc.addObject({ type: 'MESH', name: 'Tube', data: meshId });
  return { ...s, rig, tubeId, meshId };
}

const worldPos = (doc: SceneDoc, id: string, frame = 1): Vec3 => {
  const m = new FrameState(doc, frame).world(id)!;
  return [m[12], m[13], m[14]];
};

describe('armature and bone operators', () => {
  it('adds an armature object with one bone and its pose channel', () => {
    const { doc, ok, ctx } = setup();
    const r = ok('object.armature_add', { location: [1, 2, 3], radius: 2 });
    expect(r).toMatchObject({ name: 'Armature', bones: ['Bone'] });
    const o = doc.getObject(r.object)!;
    expect(o.type).toBe('ARMATURE');
    expect(o.location).toEqual([1, 2, 3]);
    expect(o.pose.bones.Bone).toEqual(defaultPoseBone());
    expect(doc.getArmature(r.armature)!.bones[0]).toMatchObject({
      name: 'Bone',
      head: [0, 0, 0],
      tail: [0, 0, 2],
    });
    expect(ctx.state.activeId).toBe(r.object);
    expect(ok('object.armature_add', {}).name).toBe('Armature.001');
  });

  it('adds bones relative to their parent, in world space and with aligned rolls', () => {
    const { ok, err, bone, doc } = setup();
    const rig = ok('object.armature_add', { location: [1, 0, 0] }).object;
    const child = ok('armature.bone_add', { parent: 'Bone', length: 0.5 });
    expect(child).toMatchObject({ bone: 'Bone.001', head: [0, 0, 1], tail: [0, 0, 1.5], parent: 'Bone' });
    // explicit world-space head/tail are converted into armature space
    ok('armature.bone_add', { name: 'Arm', head: [1, 0, 1], tail: [2, 0, 1], space: 'WORLD' });
    expect(bone(rig, 'Arm')).toMatchObject({ head: [0, 0, 1], tail: [1, 0, 1], parent: null });
    // align_roll: the local Z axis faces the given direction
    ok('armature.bone_add', { name: 'Rolled', head: [0, 0, 0], tail: [0, 1, 0], align_roll: [1, 0, 0] });
    const r = bone(rig, 'Rolled');
    const z = boneRestMatrix(r.head, r.tail, r.roll).matrix.slice(8, 11);
    expect(z[0]).toBeCloseTo(1);
    // connected bones snap to the parent's tail and are kept unique
    ok('armature.bone_add', {
      name: 'Arm',
      head: [5, 5, 5],
      tail: [5, 5, 6],
      parent: 'Bone',
      use_connect: true,
    });
    expect(bone(rig, 'Arm.001')).toMatchObject({ head: [0, 0, 1], use_connect: true });
    expect(doc.getObject(rig)!.pose.bones['Arm.001']).toBeDefined();
    expect(err('armature.bone_add', { head: [0, 0, 0], tail: [0, 0, 0] })).toMatch(/zero-length/);
    expect(err('armature.bone_add', { parent: 'Nope' })).toMatch(/Bone 'Nope' not found.*'Bone'/);
    expect(err('armature.bone_add', { use_connect: true })).toMatch(/needs a `parent`/);
    const mesh = ok('mesh.primitive_cube_add', {}).object;
    expect(err('armature.bone_add', { object: mesh })).toMatch(/not an armature/);
  });

  it('adds chains of connected bones through points', () => {
    const { ok, err, bones } = setup();
    const rig = ok('object.armature_add', { bone_name: 'Root' }).object;
    const r = ok('armature.chain_add', {
      points: [
        [0, 0, 1],
        [0, 0.5, 1.5],
        [0, 1, 1.5],
        [0, 1.5, 1.2],
      ],
      name: 'Tail',
      parent: 'Root',
      use_connect: true,
    });
    expect(r.bones).toEqual(['Tail', 'Tail.001', 'Tail.002']);
    const bs = bones(rig);
    expect(bs.map((b) => [b.name, b.parent, b.use_connect])).toEqual([
      ['Root', null, false],
      ['Tail', 'Root', true],
      ['Tail.001', 'Tail', true],
      ['Tail.002', 'Tail.001', true],
    ]);
    expect(bs[3].tail).toEqual([0, 1.5, 1.2]);
    expect(
      ok('armature.chain_add', {
        points: [
          [2, 0, 0],
          [2, 0, 1],
          [2, 0, 2],
        ],
        names: ['A', 'B'],
      }).bones,
    ).toEqual(['A', 'B']);
    expect(
      err('armature.chain_add', {
        points: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      }),
    ).toMatch(/coincide/);
    expect(
      err('armature.chain_add', {
        points: [
          [0, 0, 0],
          [0, 0, 1],
        ],
        names: ['A', 'B'],
      }),
    ).toMatch(/names/);
  });

  it('edits bones keeping connections and renames every reference', () => {
    const s = rigWithTube();
    const { ok, err, bone, doc, rig, tubeId, meshId } = s;
    ok('armature.bone_add', { name: 'Hand', parent: 'Upper', use_connect: true });
    // moving a tail drags connected children
    ok('armature.bone_update', { bone: 'Upper', tail: [0, -0.5, 2] });
    expect(bone(rig, 'Hand').head).toEqual([0, -0.5, 2]);
    // moving the head of a connected bone moves the parent's tail
    ok('armature.bone_update', { bone: 'Upper', head: [0, 0.1, 1.1] });
    expect(bone(rig, 'Lower').tail).toEqual([0, 0.1, 1.1]);
    expect(bone(rig, 'Upper').head).toEqual([0, 0.1, 1.1]);
    // references: vertex group, animation, bone parenting and constraint sub-targets
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_NAME' });
    const empty = doc.addObject({ type: 'EMPTY', name: 'Prop' });
    ok('object.parent_to', { objects: ['Prop'], parent: 'Rig', type: 'BONE', bone: 'Upper' });
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Rig',
      path: 'pose.bones["Upper"].rotation_euler',
    });
    ok('pose.ik_add', { bone: 'Hand', subtarget: 'Upper', use_tail: true, chain_count: 1 });
    const renamed = ok('armature.bone_update', { bone: 'Upper', name: 'Forearm' });
    expect(renamed.bone).toBe('Forearm');
    expect(bone(rig, 'Hand').parent).toBe('Forearm');
    expect(Object.keys(doc.getObject(rig)!.pose.bones).sort()).toEqual(['Forearm', 'Hand', 'Lower']);
    expect(doc.getVertexGroups(meshId).map((g) => g.name)).toContain('Forearm');
    expect(doc.getObject(empty)!.parent_bone).toBe('Forearm');
    expect(doc.listFCurves(rig).map((f) => f.path)).toEqual([
      'pose.bones["Forearm"].rotation_euler',
      'pose.bones["Forearm"].rotation_euler',
      'pose.bones["Forearm"].rotation_euler',
    ]);
    expect(doc.getObject(rig)!.pose.bones.Hand.constraints![0].subtarget).toBe('Forearm');
    void tubeId;
    // re-parenting checks
    expect(err('armature.bone_update', { bone: 'Lower', parent: 'Hand' })).toMatch(/children/);
    ok('armature.bone_update', { bone: 'Hand', parent: '' });
    expect(bone(rig, 'Hand')).toMatchObject({ parent: null, use_connect: false });
    expect(err('armature.bone_update', { bone: 'Hand', tail: bone(rig, 'Hand').head })).toMatch(
      /zero length/,
    );
    ok('armature.bone_update', { bone: 'Hand', roll: 1.5, use_deform: false, envelope_distance: 0.4 });
    // a failing edit leaves everything untouched (no half-applied rename)
    expect(err('armature.bone_update', { bone: 'Hand', name: 'Wrist', parent: 'Nope' })).toMatch(/not found/);
    expect(
      err('armature.bone_update', { bone: 'Hand', name: 'Wrist', tail: bone(rig, 'Hand').head }),
    ).toMatch(/zero length/);
    expect(bone(rig, 'Hand')).toBeDefined();
    expect(Object.keys(doc.getObject(rig)!.pose.bones)).toContain('Hand');
    expect(bone(rig, 'Hand')).toMatchObject({ roll: 1.5, use_deform: false, envelope_distance: 0.4 });
  });

  it('removes bones, re-parenting their children and dropping their animation', () => {
    const { ok, err, bones, doc } = setup();
    const rig = ok('object.armature_add', { bone_name: 'A' }).object;
    ok('armature.chain_add', {
      points: [
        [0, 0, 1],
        [0, 0, 2],
        [0, 0, 3],
      ],
      names: ['B', 'C'],
      parent: 'A',
      use_connect: true,
    });
    ok('pose.bone_transform_set', { bone: 'B', rotation_euler: [0.3, 0, 0], keyframe: true });
    const r = ok('armature.bone_remove', { bones: ['B'] });
    expect(r).toMatchObject({ removed: ['B'], remaining: ['A', 'C'] });
    expect(bones(rig).find((b) => b.name === 'C')).toMatchObject({
      parent: 'A',
      use_connect: false,
      head: [0, 0, 2],
    });
    expect(Object.keys(doc.getObject(rig)!.pose.bones)).toEqual(['A', 'C']);
    expect(doc.listFCurves(rig)).toEqual([]);
    expect(err('armature.bone_remove', { bones: ['Nope'] })).toMatch(/not found/);
  });

  it('poses bones, keyframes them and clears the pose', () => {
    const { ok, err, doc, ctx } = rigWithTube();
    const r = ok('pose.bone_transform_set', { bone: 'Upper', rotation_euler: [Math.PI / 2, 0, 0] });
    expect(r.rotation_euler).toEqual([Math.PI / 2, 0, 0]);
    const d = ok('armature.describe', {});
    const upper = d.bones.find((b: any) => b.name === 'Upper');
    expect(upper.posed_tail_world[1]).toBeCloseTo(-1);
    expect(upper.posed_tail_world[2]).toBeCloseTo(1);
    expect(upper.children).toEqual([]);
    expect(d.bones.find((b: any) => b.name === 'Lower').children).toEqual(['Upper']);
    // keyframes at given frames do not disturb other frames
    ok('pose.bone_transform_set', { bone: 'Lower', location: [0, 0, 0], keyframe: true, frame: 1 });
    ok('pose.bone_transform_set', { bone: 'Lower', location: [0, 1, 0], keyframe: true, frame: 11 });
    const rigId = ctx.state.activeId!;
    const at = (f: number) => new FrameState(doc, f).pose(rigId)!.bones.get('Lower')!.head;
    expect(at(1)[2]).toBeCloseTo(0);
    expect(at(11)[2]).toBeCloseTo(1);
    expect(at(6)[2]).toBeGreaterThan(0.2);
    expect(at(6)[2]).toBeLessThan(0.8);
    // editing an animated channel without keyframe re-keys the current frame (1)
    ok('pose.bone_transform_set', { bone: 'Lower', location: [0, 0.5, 0] });
    expect(at(1)[2]).toBeCloseTo(0.5);
    expect(at(11)[2]).toBeCloseTo(1);
    ok('pose.transforms_clear', { type: 'ROTATION' });
    expect(doc.getObject(rigId)!.pose.bones.Upper.rotation_euler).toEqual([0, 0, 0]);
    expect(doc.getObject(rigId)!.pose.bones.Lower.location).toEqual([0, 0.5, 0]);
    ok('pose.transforms_clear', {});
    expect(doc.getObject(rigId)!.pose.bones.Lower.location).toEqual([0, 0, 0]);
    expect(err('pose.bone_transform_set', { bone: 'Nope', location: [0, 0, 0] })).toMatch(/not found/);
  });
});

describe('IK and bone constraint operators', () => {
  it('adds IK to a bone of the same armature and solves it during evaluation', () => {
    const { ok, err, doc } = setup();
    const rig = ok('object.armature_add', { name: 'Rig', bone_name: 'Upper', location: [2, 0, 0] }).object;
    ok('armature.bone_update', { bone: 'Upper', tail: [0, -0.1, 1] });
    ok('armature.bone_add', { name: 'Lower', parent: 'Upper', use_connect: true, tail: [0, 0, 2] });
    ok('armature.bone_add', { name: 'Hand_IK', head: [0.5, -1, 1], tail: [0.5, -1, 1.3] });
    const r = ok('pose.ik_add', { bone: 'Lower', subtarget: 'Hand_IK', chain_count: 2 });
    expect(r).toMatchObject({ name: 'IK', chain: ['Upper', 'Lower'] });
    const c = doc.getObject(rig)!.pose.bones.Lower.constraints![0];
    expect(c).toMatchObject({ type: 'IK', target: rig, subtarget: 'Hand_IK', influence: 1 });
    expect(c.params).toMatchObject({ chain_count: 2, iterations: 500, use_tail: true, use_stretch: false });
    // the frame state does not tell computePose which object is posed: the target is still recognised
    const pose = new FrameState(doc, 1).pose(rig)!;
    expect(pose.errors).toEqual([]);
    expect(distance(pose.bones.get('Lower')!.tail, [0.5, -1, 1])).toBeLessThan(1e-4);
    // moving the control bone drags the chain
    ok('pose.bone_transform_set', { bone: 'Hand_IK', location: [0, 0, 0.3] });
    const moved = new FrameState(doc, 1).pose(rig)!;
    expect(distance(moved.bones.get('Lower')!.tail, moved.bones.get('Hand_IK')!.head)).toBeLessThan(1e-4);
    // validation
    expect(err('pose.ik_add', { bone: 'Lower' })).toMatch(/needs a `target`/);
    expect(err('pose.ik_add', { bone: 'Lower', subtarget: 'Lower' })).toMatch(/own IK target/);
    expect(err('pose.ik_add', { bone: 'Upper', subtarget: 'Lower' })).toMatch(/part of/);
    expect(err('pose.ik_add', { bone: 'Lower', target: 'Nope' })).toMatch(/not found/);
    expect(err('pose.ik_add', { bone: 'Lower', subtarget: 'Nope' })).toMatch(/Bone 'Nope' not found/);
    expect(err('pose.ik_add', { bone: 'Upper', subtarget: 'Hand_IK', use_tail: false })).toMatch(/no parent/);
  });

  it('adds IK with object targets and poles; the chain reaches the empty', () => {
    const { ok, doc } = setup();
    const rig = ok('object.armature_add', { name: 'Leg', bone_name: 'Thigh' }).object;
    ok('armature.chain_add', {
      points: [
        [0, 0, 1],
        [0, 0, 2],
      ],
      names: ['Shin'],
      parent: 'Thigh',
      use_connect: true,
    });
    const target = ok('object.empty_add', { name: 'Goal', location: [0, 0, 1.2] }).object;
    ok('object.empty_add', { name: 'Knee', location: [0, -3, 0.6] });
    const r = ok('pose.ik_add', {
      object: 'Leg',
      bone: 'Shin',
      target: 'Goal',
      pole_target: 'Knee',
      chain_count: 2,
    });
    expect(r.chain).toEqual(['Thigh', 'Shin']);
    const pose = new FrameState(doc, 1).pose(rig)!;
    expect(distance(pose.bones.get('Shin')!.tail, worldPos(doc, target))).toBeLessThan(1e-4);
    expect(pose.bones.get('Thigh')!.tail[1]).toBeLessThan(-0.5); // knee bends towards the pole (-Y)
  });

  it('adds, edits and removes bone constraints with validated parameters', () => {
    const { ok, err, doc } = setup();
    const rig = ok('object.armature_add', { bone_name: 'A' }).object;
    ok('armature.bone_add', { name: 'B', head: [1, 0, 0], tail: [1, 0, 1] });
    const c = ok('pose.constraint_add', {
      bone: 'B',
      type: 'LIMIT_ROTATION',
      params: { use_limit_x: true, min_x: -0.2, max_x: 0.2 },
    });
    expect(c.name).toBe('Limit Rotation');
    ok('pose.bone_transform_set', { bone: 'B', rotation_euler: [1, 0, 0] });
    const tail = () => new FrameState(doc, 1).pose(rig)!.bones.get('B')!.tail;
    expect(tail()[1]).toBeCloseTo(-Math.sin(0.2), 6);
    ok('pose.constraint_set', {
      bone: 'B',
      constraint: 'Limit Rotation',
      params: { max_x: 0.5 },
      name: 'Elbow',
    });
    expect(tail()[1]).toBeCloseTo(-Math.sin(0.5), 6);
    ok('pose.constraint_set', { bone: 'B', constraint: 'Elbow', mute: true });
    expect(tail()[1]).toBeCloseTo(-Math.sin(1), 6);
    const ct = ok('pose.constraint_add', {
      bone: 'B',
      type: 'COPY_ROTATION',
      subtarget: 'A',
      influence: 0.5,
    });
    expect(doc.getObject(rig)!.pose.bones.B.constraints![1]).toMatchObject({
      target: rig,
      subtarget: 'A',
      influence: 0.5,
    });
    expect(err('pose.constraint_add', { bone: 'B', type: 'DAMPED_TRACK' })).toMatch(/needs a `target`/);
    expect(err('pose.constraint_add', { bone: 'B', type: 'LIMIT_ROTATION', params: { min: 1 } })).toMatch(
      /Unknown parameter 'min'.*Valid parameters: .*use_limit_x/,
    );
    expect(
      err('pose.constraint_add', {
        bone: 'B',
        type: 'COPY_ROTATION',
        subtarget: 'A',
        params: { mix_mode: 'X' },
      }),
    ).toMatch(/Invalid COPY_ROTATION parameters/);
    expect(err('pose.constraint_add', { bone: 'B', type: 'TRACK_TO', subtarget: 'A' })).toMatch(/Invalid/);
    expect(ok('pose.constraint_remove', { bone: 'B', constraint: ct.constraint }).removed).toEqual([
      'Copy Rotation',
    ]);
    expect(ok('pose.constraint_remove', { bone: 'B', all: true }).removed).toEqual(['Elbow']);
    expect(doc.getObject(rig)!.pose.bones.B.constraints).toBeUndefined();
    expect(err('pose.constraint_remove', { bone: 'B', constraint: 'Gone' })).toMatch(/not found/);
    // IK through constraint_add: a pole bone without pole object belongs to this armature
    ok('armature.bone_add', { name: 'C', parent: 'B', use_connect: true });
    const ikc = ok('pose.constraint_add', {
      bone: 'C',
      type: 'IK',
      subtarget: 'A',
      params: { chain_count: 2, pole_subtarget: 'A' },
    });
    expect(doc.getObject(rig)!.pose.bones.C.constraints![0].params).toMatchObject({
      pole_target: rig,
      pole_subtarget: 'A',
    });
    expect(
      err('pose.constraint_set', {
        bone: 'C',
        constraint: ikc.constraint,
        params: { pole_subtarget: 'Nope' },
      }),
    ).toMatch(/Bone 'Nope' not found/);
  });
});

describe('armature parenting (object.parent_set)', () => {
  it('ARMATURE_AUTO binds a mesh with normalised automatic weights; posing deforms it', () => {
    const s = rigWithTube();
    const { ok, doc, ctx, rig, tubeId, meshId } = s;
    ok('object.select', { objects: ['Tube', 'Rig'], active: 'Rig' });
    const r = ok('object.parent_set', { type: 'ARMATURE_AUTO' });
    expect(r).toMatchObject({ parent: rig, type: 'ARMATURE_AUTO', children: [tubeId] });
    expect(r.vertex_groups).toEqual({ Tube: ['Lower', 'Upper'] });
    const o = doc.getObject(tubeId)!;
    expect(o.parent).toBe(rig);
    expect(o.modifiers.map((m) => [m.type, m.params.object])).toEqual([['ARMATURE', rig]]);
    const groups = doc.getVertexGroups(meshId);
    const w = groups.map((g) => decodeFloat32(g.weights));
    for (let v = 0; v < 21 * 12; v++) expect(w[0][v] + w[1][v]).toBeCloseTo(1, 4);
    expect(w[0][0]).toBeCloseTo(1, 4); // bottom ring → Lower
    expect(w[1][20 * 12]).toBeCloseTo(1, 4); // top ring → Upper
    // binding again replaces the weights and keeps a single modifier
    ok('object.parent_set', { type: 'ARMATURE_AUTO' });
    expect(doc.getObject(tubeId)!.modifiers).toHaveLength(1);
    expect(doc.getVertexGroups(meshId)).toHaveLength(2);
    // pose → deformation
    ok('pose.bone_transform_set', { object: 'Rig', bone: 'Upper', rotation_euler: [Math.PI / 2, 0, 0] });
    const mesh = new SceneEvaluator(doc).evaluate(ctx.state.frame).byId.get(tubeId)!.mesh!;
    expect(distance(ringCenter(mesh.positions, 20, 12), [0, -1, 1])).toBeLessThan(0.02);
  });

  it('places the Armature modifier before generators and keeps transforms', () => {
    const { ok, doc, rig, tubeId } = rigWithTube();
    doc.updateObject(rig, { location: [0, 0, 1] });
    doc.updateObject(tubeId, { location: [0.5, 0, 0] });
    ok('object.modifier_add', { object: 'Tube', type: 'SUBSURF' });
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE' });
    const o = doc.getObject(tubeId)!;
    expect(o.modifiers.map((m) => m.type)).toEqual(['ARMATURE', 'SUBSURF']);
    expect(o.location).toEqual([0.5, 0, -1]);
    expect(worldPos(doc, tubeId)).toEqual([0.5, 0, 0]);
    expect(doc.getVertexGroups(o.data!)).toEqual([]); // plain ARMATURE creates no groups
  });

  it('creates empty or envelope groups with ARMATURE_NAME / ARMATURE_ENVELOPE', () => {
    const { ok, doc, meshId } = rigWithTube();
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_NAME' });
    const empty = doc.getVertexGroups(meshId);
    expect(empty.map((g) => g.name)).toEqual(['Lower', 'Upper']);
    expect(Array.from(decodeFloat32(empty[0].weights)).every((x) => x === 0)).toBe(true);
    ok('armature.bone_update', {
      object: 'Rig',
      bone: 'Lower',
      envelope_distance: 0.5,
      head_radius: 0.1,
      tail_radius: 0.1,
    });
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_ENVELOPE' });
    const env = decodeFloat32(doc.getVertexGroups(meshId)[0].weights);
    expect(env[0]).toBeGreaterThan(0.5); // bottom ring, 0.2 from the bone: inside 0.1 + 0.5
    expect(env[20 * 12]).toBe(0); // top ring, far away
  });

  it('parents objects to bones keeping their transform; they follow the bone', () => {
    const { ok, err, doc, ctx } = setup();
    const rig = ok('object.armature_add', { name: 'Rig' }).object;
    const prop = ok('object.empty_add', { name: 'Prop', location: [0, 0, 3] }).object;
    ok('object.select', { objects: ['Prop', 'Rig'], active: 'Rig' });
    ok('object.parent_set', { type: 'BONE' }); // the only bone
    const o = doc.getObject(prop)!;
    expect(o).toMatchObject({ parent: rig, parent_type: 'BONE', parent_bone: 'Bone' });
    expect(worldPos(doc, prop)).toEqual([0, 0, 3].map((v) => expect.closeTo(v, 9)));
    ok('pose.bone_transform_set', { object: 'Rig', bone: 'Bone', rotation_euler: [Math.PI / 2, 0, 0] });
    const p = worldPos(doc, prop);
    expect(distance(p, [0, -3, 0])).toBeLessThan(1e-9);
    // clear parent keeps the posed world position
    ok('object.select', { objects: ['Prop'] });
    ok('object.parent_clear', {});
    expect(doc.getObject(prop)).toMatchObject({ parent: null, parent_type: 'OBJECT', parent_bone: '' });
    expect(distance(worldPos(doc, prop), [0, -3, 0])).toBeLessThan(1e-9);
    // re-parenting a bone child to an object resets the parent type
    ok('object.parent_to', { objects: ['Prop'], parent: 'Rig', type: 'BONE', bone: 'Bone' });
    const cam = ok('object.empty_add', { name: 'Other', location: [5, 5, 5] }).object;
    ok('object.parent_to', { objects: ['Prop'], parent: 'Other' });
    expect(doc.getObject(prop)).toMatchObject({ parent: cam, parent_type: 'OBJECT' });
    expect(distance(worldPos(doc, prop), [0, -3, 0])).toBeLessThan(1e-9);
    ok('armature.bone_add', { object: 'Rig', name: 'Second' });
    expect(err('object.parent_to', { objects: ['Prop'], parent: 'Rig', type: 'BONE' })).toMatch(
      /needs `bone`/,
    );
    expect(err('object.parent_to', { objects: ['Prop'], parent: 'Other', type: 'ARMATURE' })).toMatch(
      /needs an armature/,
    );
    void ctx;
  });
});

describe('pose animation end to end', () => {
  it('keyframed pose bones animate the pose, the skinned mesh and bone children', () => {
    const { ok, doc, tubeId } = rigWithTube();
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_AUTO' });
    const prop = ok('object.empty_add', { name: 'Prop', location: [0, 0, 2] }).object;
    ok('object.parent_to', { objects: ['Prop'], parent: 'Rig', type: 'BONE', bone: 'Upper' });
    const k1 = ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Rig',
      path: 'pose.bones["Upper"].rotation_euler',
      frame: 1,
      interpolation: 'LINEAR',
    });
    expect(k1.inserted).toBe(3);
    ok('pose.bone_transform_set', {
      object: 'Rig',
      bone: 'Upper',
      rotation_euler: [Math.PI / 2, 0, 0],
      keyframe: true,
      frame: 21,
    });
    const ev = new SceneEvaluator(doc);
    const top = (f: number) => ringCenter(ev.evaluate(f).byId.get(tubeId)!.mesh!.positions, 20, 12);
    const propAt = (f: number) => {
      const m = ev.evaluate(f).byId.get(prop)!.worldMatrix;
      return [m[12], m[13], m[14]];
    };
    expect(distance(top(1), [0, 0, 2])).toBeLessThan(1e-4);
    expect(distance(top(21), [0, -1, 1])).toBeLessThan(0.02);
    const mid = top(11);
    expect(mid[1]).toBeLessThan(-0.4);
    expect(mid[1]).toBeGreaterThan(-0.9);
    // the empty at the Upper tail rotates around the joint with the bone
    expect(distance(propAt(1), [0, 0, 2])).toBeLessThan(1e-6);
    expect(distance(propAt(21), [0, -1, 1])).toBeLessThan(1e-6);
    const pm = propAt(11);
    expect(distance(pm, [0, -Math.sin(Math.PI / 4), 1 + Math.cos(Math.PI / 4)])).toBeLessThan(1e-6);
  });
});

describe('undo and snapshots', () => {
  it('makes every operator one undo step', () => {
    const { ok, doc, bones } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const rig = ok('object.armature_add', {}).object;
    ok('armature.chain_add', {
      points: [
        [0, 0, 1],
        [0, 0, 2],
        [0, 0, 3],
      ],
      parent: 'Bone',
      use_connect: true,
    });
    ok('pose.bone_transform_set', { bone: 'Bone.001', rotation_euler: [0.5, 0, 0] });
    ok('pose.ik_add', { bone: 'Bone.002', target: rig, subtarget: 'Bone', chain_count: 1 });
    ok('armature.bone_update', { bone: 'Bone.001', name: 'Mid' });
    expect(bones(rig).map((b) => b.name)).toEqual(['Bone', 'Mid', 'Bone.002']);
    um.undo();
    expect(bones(rig).map((b) => b.name)).toEqual(['Bone', 'Bone.001', 'Bone.002']);
    expect(doc.getObject(rig)!.pose.bones['Bone.001'].rotation_euler).toEqual([0.5, 0, 0]);
    um.undo();
    expect(doc.getObject(rig)!.pose.bones['Bone.002'].constraints).toBeUndefined();
    um.undo();
    expect(doc.getObject(rig)!.pose.bones['Bone.001'].rotation_euler).toEqual([0, 0, 0]);
    um.undo();
    expect(bones(rig)).toHaveLength(1);
    expect(Object.keys(doc.getObject(rig)!.pose.bones)).toEqual(['Bone']);
    um.undo();
    expect(doc.getObject(rig)).toBeNull();
    um.redo();
    um.redo();
    expect(bones(rig)).toHaveLength(3);
  });

  it('round-trips rigs, poses, constraints, weights and bone parenting through snapshots', () => {
    const { ok, doc, rig, tubeId } = rigWithTube();
    ok('object.parent_to', { objects: ['Tube'], parent: 'Rig', type: 'ARMATURE_AUTO' });
    const prop = ok('object.empty_add', { name: 'Prop', location: [0, 0, 2.5] }).object;
    ok('object.parent_to', { objects: ['Prop'], parent: 'Rig', type: 'BONE', bone: 'Upper' });
    ok('armature.bone_add', {
      object: 'Rig',
      name: 'Target',
      head: [0, -1, 1],
      tail: [0, -1, 1.2],
      use_deform: false,
    });
    ok('pose.ik_add', { object: 'Rig', bone: 'Upper', subtarget: 'Target', chain_count: 1 });
    ok('pose.bone_transform_set', {
      object: 'Rig',
      bone: 'Lower',
      rotation_euler: [0.2, 0, 0.1],
      keyframe: true,
    });
    const before = new SceneEvaluator(doc).evaluate(1);
    const snap = JSON.parse(JSON.stringify(doc.toSnapshot()));
    const copy = SceneDoc.fromSnapshot(snap);
    const after = new SceneEvaluator(copy).evaluate(1);
    expect(copy.getVertexGroups(doc.getObject(tubeId)!.data!).map((g) => g.name)).toEqual(['Lower', 'Upper']);
    expect(copy.getObject(prop)).toMatchObject({ parent_type: 'BONE', parent_bone: 'Upper' });
    const a = before.byId.get(tubeId)!.mesh!.positions;
    const b = after.byId.get(tubeId)!.mesh!.positions;
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
    for (const n of ['Lower', 'Upper', 'Target'])
      expect(after.byId.get(rig)!.pose!.bones.get(n)!.matrix).toEqual(
        before.byId.get(rig)!.pose!.bones.get(n)!.matrix,
      );
    expect(after.byId.get(prop)!.worldMatrix).toEqual(before.byId.get(prop)!.worldMatrix);
  });

  it('describes the operators for agents', () => {
    const { reg } = setup();
    const ids = reg
      .describe()
      .map((o) => o.id)
      .filter((id) =>
        /^(armature|pose)\.|^object\.(armature_add|vertex_group_|shape_key_|parent_set|parent_to)/.test(id),
      );
    expect(ids.length).toBeGreaterThanOrEqual(25);
    for (const info of reg.describe().filter((o) => ids.includes(o.id))) {
      expect(info.description.length, info.id).toBeGreaterThan(40);
      const props =
        (info.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [k, v] of Object.entries(props)) expect(v.description, `${info.id}.${k}`).toBeTruthy();
    }
  });
});
