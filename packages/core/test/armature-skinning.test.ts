import { describe, expect, it } from 'vitest';
import {
  boneEnvelopeWeight,
  computePose,
  denseToSkinWeights,
  envelopeFactor,
  skinPositions,
  type ArmaturePose,
} from '../src/armature';
import { computeHeatWeights } from '../src/armature/weights';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ModifierData, PoseBone } from '../src/doc/types';
import { defaultPoseBone } from '../src/doc/defaults';
import { SceneEvaluator } from '../src/eval/evaluate';
import { identity4 } from '../src/math/mat4';
import type { Vec3 } from '../src/math/types';
import { encodeFloat32 } from '../src/mesh/shape-keys';
import type { MeshData } from '../src/mesh/types';
import { armatureData, bone, distance, ringCenter, ringRadius, tube } from './armature-helpers';

const poseOf = (arm = twoBones(), pose: Record<string, PoseBone> = {}): ArmaturePose =>
  computePose(arm, pose, { frame: 1, armatureMatrix: identity4(), getWorldMatrix: () => null });

function twoBones() {
  return armatureData([
    bone('Lower', [0, 0, 0], [0, 0, 1]),
    bone('Upper', [0, 0, 1], [0, 0, 2], { parent: 'Lower', use_connect: true }),
  ]);
}

const pb = (p: Partial<PoseBone>): PoseBone => ({ ...defaultPoseBone(), ...p });

describe('skinPositions', () => {
  it('moves fully weighted vertices rigidly and leaves unweighted ones in place', () => {
    const pose = poseOf(twoBones(), { Lower: pb({ rotation_euler: [Math.PI / 2, 0, 0] }) });
    const bones = [...pose.bones.values()];
    const pts = [0, 0, 0.5, 0.1, 0, 0.5, 5, 5, 5];
    const w = denseToSkinWeights([[1, 1, 0], null], 3);
    const out = skinPositions(pts, w, bones, { preserveVolume: false });
    // bone Lower rotated +90° about its X: +Z → -Y
    expect(distance(out.slice(0, 3), [0, -0.5, 0])).toBeLessThan(1e-9);
    expect(distance(out.slice(3, 6), [0.1, -0.5, 0])).toBeLessThan(1e-9);
    expect(out.slice(6, 9)).toEqual([5, 5, 5]);
    // weights are normalised: 3 + 3 behaves like 0.5 + 0.5, below 1e-4 nothing moves
    const a = skinPositions(
      pts,
      denseToSkinWeights(
        [
          [3, 0, 0],
          [3, 0, 0],
        ],
        3,
      ),
      bones,
      { preserveVolume: false },
    );
    const b = skinPositions(
      pts,
      denseToSkinWeights(
        [
          [0.5, 0, 0],
          [0.5, 0, 0],
        ],
        3,
      ),
      bones,
      {
        preserveVolume: false,
      },
    );
    expect(a).toEqual(b);
    const tiny = skinPositions(pts, denseToSkinWeights([[5e-5, 0, 0], null], 3), bones, {
      preserveVolume: false,
    });
    expect(tiny.slice(0, 3)).toEqual([0, 0, 0.5]);
    // NaN / negative weights are ignored
    const bad = denseToSkinWeights([[NaN, -1, 1], null], 3);
    expect(Array.from(bad.offsets)).toEqual([0, 0, 0, 1]);
  });

  it('preserves volume with dual quaternions where linear blending collapses (twist)', () => {
    // a 180° twist about the bone axis between two bones: LBS collapses the ring onto the axis
    const arm = armatureData([bone('A', [0, 0, 0], [0, 0, 1]), bone('B', [0, 0, 0], [0, 0, 1])]);
    const pose = poseOf(arm, { B: pb({ rotation_euler: [0, Math.PI, 0] }) });
    const bones = [...pose.bones.values()];
    const ring: number[] = [];
    for (let i = 0; i < 8; i++)
      ring.push(Math.cos((i * Math.PI) / 4) * 0.3, Math.sin((i * Math.PI) / 4) * 0.3, 0.5);
    const half = denseToSkinWeights([new Array(8).fill(0.5), new Array(8).fill(0.5)], 8);
    const lbs = skinPositions(ring, half, bones, { preserveVolume: false });
    const dqs = skinPositions(ring, half, bones, { preserveVolume: true });
    for (let i = 0; i < 8; i++) {
      expect(Math.hypot(lbs[i * 3], lbs[i * 3 + 1])).toBeLessThan(1e-9);
      expect(Math.hypot(dqs[i * 3], dqs[i * 3 + 1])).toBeCloseTo(0.3, 9);
      expect(dqs[i * 3 + 2]).toBeCloseTo(0.5, 9);
    }
    // a single bone gives identical LBS and DQS results (rigid motion, with translation)
    const moved = poseOf(arm, { A: pb({ location: [0.2, 0.3, -0.1], rotation_euler: [0.3, -0.7, 1.1] }) });
    const one = denseToSkinWeights([new Array(8).fill(1), null], 8);
    const l = skinPositions(ring, one, [...moved.bones.values()], { preserveVolume: false });
    const d = skinPositions(ring, one, [...moved.bones.values()], { preserveVolume: true });
    l.forEach((v, i) => expect(d[i]).toBeCloseTo(v, 9));
  });

  it('applies pose scale with dual quaternions about the bone head', () => {
    const arm = armatureData([bone('A', [1, 0, 0], [1, 0, 1])]);
    const pose = poseOf(arm, { A: pb({ scale: [2, 2, 2] }) });
    const pts = [1.5, 0, 0.5];
    const w = denseToSkinWeights([[1]], 1);
    const lbs = skinPositions(pts, w, [...pose.bones.values()], { preserveVolume: false });
    const dqs = skinPositions(pts, w, [...pose.bones.values()], { preserveVolume: true });
    expect(distance(lbs, [2, 0, 1])).toBeLessThan(1e-9);
    expect(distance(dqs, [2, 0, 1])).toBeLessThan(1e-9);
  });

  it('scales the deformation by a mask', () => {
    const pose = poseOf(twoBones(), { Lower: pb({ location: [0, 1, 0] }) }); // bone +Y = world +Z
    const pts = [0, 0, 0, 0, 0, 0];
    const w = denseToSkinWeights([[1, 1], null], 2);
    const out = skinPositions(pts, w, [...pose.bones.values()], { preserveVolume: false, mask: [0.25, 0] });
    expect(out).toEqual([0, 0, 0.25, 0, 0, 0]);
  });
});

describe('envelopes', () => {
  it('is 1 inside the radius and falls off quadratically over the distance', () => {
    const h: Vec3 = [0, 0, 0];
    const t: Vec3 = [0, 0, 2];
    expect(envelopeFactor([0.05, 0, 1], h, t, 0.1, 0.1, 0.5)).toBe(1);
    expect(envelopeFactor([0.35, 0, 1], h, t, 0.1, 0.1, 0.5)).toBeCloseTo(1 - 0.25 ** 2 / 0.25);
    expect(envelopeFactor([0.7, 0, 1], h, t, 0.1, 0.1, 0.5)).toBe(0);
    // radius interpolated along the bone, spherical caps beyond the ends
    expect(envelopeFactor([0.25, 0, 1], h, t, 0.1, 0.3, 0)).toBe(0);
    expect(envelopeFactor([0.15, 0, 1], h, t, 0.1, 0.3, 0)).toBe(1);
    expect(envelopeFactor([0, 0, -0.05], h, t, 0.1, 0.3, 0)).toBe(1);
    expect(envelopeFactor([0, 0, 2.25], h, t, 0.1, 0.3, 0)).toBe(1);
    expect(envelopeFactor([0, 0, -0.2], h, t, 0.1, 0.3, 0)).toBe(0);
    // zero distance: hard edge; degenerate bone: sphere around the head
    expect(envelopeFactor([0.05, 0, 0], h, h, 0.1, 0.1, 0)).toBe(1);
    const b = poseOf().bones.get('Lower')!;
    expect(boneEnvelopeWeight(b, [0, 0, 0.5])).toBe(1);
    expect(boneEnvelopeWeight({ ...b, envelope: { ...b.envelope!, weight: 0.5 } }, [0, 0, 0.5])).toBe(0.5);
  });
});

// ------------------------------------------------------------------ ARMATURE modifier

const RINGS = 21;
const SEG = 12;
const RADIUS = 0.2;

function armatureModifier(object: string, params: Record<string, unknown> = {}): ModifierData {
  return {
    id: 'arm-mod',
    name: 'Armature',
    type: 'ARMATURE',
    show_viewport: true,
    show_render: true,
    show_in_editmode: true,
    show_expanded: true,
    params: { object, ...params },
  };
}

function rigScene(opts: { weights?: boolean; params?: Record<string, unknown> } = {}) {
  const doc = new SceneDoc();
  const arm = twoBones();
  const armId = doc.addArmature({ name: 'Rig', bones: arm.bones });
  const rig = doc.addObject({
    type: 'ARMATURE',
    name: 'Rig',
    data: armId,
    pose: { bones: { Lower: defaultPoseBone(), Upper: defaultPoseBone() } },
  });
  const mesh = tube(RINGS, SEG, RADIUS, 2);
  const meshId = doc.addMesh('Tube', mesh);
  const obj = doc.addObject({
    type: 'MESH',
    name: 'Tube',
    data: meshId,
    modifiers: [armatureModifier(rig, opts.params)],
  });
  if (opts.weights !== false) {
    const res = computeHeatWeights(mesh, [
      { name: 'Lower', head: [0, 0, 0], tail: [0, 0, 1] },
      { name: 'Upper', head: [0, 0, 1], tail: [0, 0, 2] },
    ]);
    doc.setVertexGroups(meshId, [
      { name: 'Lower', weights: encodeFloat32(res.weights[0]) },
      { name: 'Upper', weights: encodeFloat32(res.weights[1]) },
    ]);
  }
  const ev = new SceneEvaluator(doc);
  const setPose = (name: string, p: Partial<PoseBone>) => {
    const o = doc.getObject(rig)!;
    doc.updateObject(rig, { pose: { bones: { ...o.pose.bones, [name]: pb(p) } } });
  };
  const evaluated = () => ev.evaluate(1).byId.get(obj)!;
  // the document stores positions as float32: compare against the decoded base mesh
  const base = doc.getMesh(meshId)!;
  return { doc, rig, obj, meshId, mesh, base, setPose, evaluated, ev };
}

function maxRingStep(m: MeshData): number {
  let worst = 0;
  for (let r = 0; r + 1 < RINGS; r++)
    worst = Math.max(worst, distance(ringCenter(m.positions, r, SEG), ringCenter(m.positions, r + 1, SEG)));
  return worst;
}

describe('ARMATURE modifier', () => {
  it('bends a subdivided cylinder smoothly with two bones', () => {
    const s = rigScene();
    expect(s.evaluated().mesh!.positions).toEqual(s.base.positions); // rest pose: unchanged
    s.setPose('Upper', { rotation_euler: [Math.PI / 2, 0, 0] });
    const ev = s.evaluated();
    expect(ev.modifierErrors).toEqual([]);
    const p = ev.mesh!.positions;
    // the base stays, the top swings around the joint from +Z to -Y
    expect(distance(ringCenter(p, 0, SEG), [0, 0, 0])).toBeLessThan(1e-6);
    // heat weights fade out over about one limb radius below the joint
    expect(distance(ringCenter(p, 3, SEG), [0, 0, 0.3])).toBeLessThan(0.03);
    expect(distance(ringCenter(p, RINGS - 1, SEG), [0, -1, 1])).toBeLessThan(0.02);
    // smooth: no ring jumps, no collapsed cross-sections
    expect(maxRingStep(ev.mesh!)).toBeLessThan(0.15);
    for (let r = 0; r < RINGS; r++) expect(ringRadius(p, r, SEG)).toBeGreaterThan(RADIUS * 0.6);
    // the joint ring is blended between both bones: it stays centred on the joint but tilts ~45°
    expect(distance(ringCenter(p, 10, SEG), [0, 0, 1])).toBeLessThan(1e-3);
    const zs = Array.from({ length: SEG }, (_, i) => p[(10 * SEG + i) * 3 + 2]);
    const tilt = Math.max(...zs) - Math.min(...zs);
    expect(tilt).toBeGreaterThan(0.7 * RADIUS);
    expect(tilt).toBeLessThan(1.3 * RADIUS);
    // above the joint the rings follow the upper bone round the bend
    expect(ringCenter(p, 14, SEG)[1]).toBeLessThan(-0.2);
  });

  it('keeps more volume at the joint with use_deform_preserve_volume', () => {
    const lbs = rigScene();
    const dqs = rigScene({ params: { use_deform_preserve_volume: true } });
    for (const s of [lbs, dqs]) s.setPose('Upper', { rotation_euler: [Math.PI / 2, 0, 0] });
    const rl = ringRadius(lbs.evaluated().mesh!.positions, 10, SEG);
    const rd = ringRadius(dqs.evaluated().mesh!.positions, 10, SEG);
    expect(rd).toBeGreaterThan(rl + 0.01 * RADIUS);
    expect(rd).toBeGreaterThan(0.9 * RADIUS);
    expect(maxRingStep(dqs.evaluated().mesh!)).toBeLessThan(0.15);
  });

  it('converts between the mesh, armature and bone spaces', () => {
    const s = rigScene();
    s.setPose('Upper', { rotation_euler: [Math.PI / 2, 0, 0] });
    const local = s.evaluated().mesh!.positions.slice();
    // move both objects by the same transform: the local-space result is unchanged
    for (const id of [s.rig, s.obj])
      s.doc.updateObject(id, {
        location: [3, -2, 1],
        rotation_euler: [0.3, 0.2, 1.1],
        scale: [1.5, 1.5, 1.5],
      });
    const moved = s.evaluated().mesh!.positions;
    moved.forEach((v, i) => expect(v).toBeCloseTo(local[i], 6));
    // moving only the armature object: in mesh space the bones move away and drag the mesh along
    s.doc.updateObject(s.obj, { location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1] });
    s.doc.updateObject(s.rig, { location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1] });
    s.setPose('Upper', {});
    s.doc.updateObject(s.rig, { location: [5, 0, 0] });
    const shifted = s.evaluated().mesh!.positions;
    shifted.forEach((v, i) => expect(v).toBeCloseTo(s.base.positions[i], 9)); // rest pose: no deformation
    s.setPose('Lower', { location: [0, 0.5, 0] }); // along the bone's Y axis (world +Z)
    const lifted = s.evaluated().mesh!.positions;
    expect(lifted[2]).toBeCloseTo(s.base.positions[2] + 0.5, 6);
  });

  it('uses envelopes for vertices without bone weights and honours the mask group', () => {
    const s = rigScene({ weights: false, params: { use_bone_envelopes: true } });
    const arm = s.doc.getArmature(s.doc.getObject(s.rig)!.data!)!;
    s.doc.updateArmature(arm.id, {
      bones: arm.bones.map((b) => ({ ...b, envelope_distance: 0.5, head_radius: 0.1, tail_radius: 0.1 })),
    });
    s.setPose('Lower', { location: [0, 1, 0] });
    const p = s.evaluated().mesh!.positions;
    // everything is within the envelopes of both bones near the bottom: only Lower moves them
    expect(ringCenter(p, 0, SEG)[2]).toBeCloseTo(1, 6);
    // mask: vertices with mask weight 0 keep their position
    const mask = new Float32Array(RINGS * SEG).fill(0);
    s.doc.setVertexGroups(s.meshId, [{ name: 'Mask', weights: encodeFloat32(mask) }]);
    s.doc.updateObject(s.obj, {
      modifiers: [armatureModifier(s.rig, { use_bone_envelopes: true, vertex_group: 'Mask' })],
    });
    expect(s.evaluated().mesh!.positions).toEqual(s.base.positions);
    s.doc.updateObject(s.obj, {
      modifiers: [
        armatureModifier(s.rig, {
          use_bone_envelopes: true,
          vertex_group: 'Mask',
          invert_vertex_group: true,
        }),
      ],
    });
    expect(ringCenter(s.evaluated().mesh!.positions, 0, SEG)[2]).toBeCloseTo(1, 6);
  });

  it('reports missing armatures and vertex groups that do not match the mesh', () => {
    const s = rigScene();
    const empty = s.doc.addObject({ type: 'EMPTY', name: 'Empty' });
    s.doc.updateObject(s.obj, { modifiers: [armatureModifier(empty)] });
    let ev = s.evaluated();
    expect(ev.modifierErrors[0].message).toMatch(/not an armature/);
    expect(ev.mesh!.positions).toEqual(s.base.positions);
    s.doc.updateObject(s.obj, { modifiers: [armatureModifier(s.rig)] });
    s.doc.setVertexGroups(s.meshId, [{ name: 'Lower', weights: encodeFloat32([1, 1, 1]) }]);
    s.setPose('Lower', { location: [0, 1, 0] });
    ev = s.evaluated();
    expect(ev.modifierErrors[0].message).toMatch(/do not match the mesh/);
    // unset object: silently inactive (like Blender)
    s.doc.updateObject(s.obj, { modifiers: [armatureModifier('')] });
    ev = s.evaluated();
    expect(ev.modifierErrors).toEqual([]);
  });

  it('re-evaluates when the pose changes and caches otherwise', () => {
    const s = rigScene();
    const a = s.evaluated();
    const b = s.evaluated();
    expect(b.mesh).toBe(a.mesh);
    s.setPose('Upper', { rotation_euler: [0.5, 0, 0] });
    const c = s.evaluated();
    expect(c.mesh).not.toBe(a.mesh);
    expect(c.meshKey).not.toBe(a.meshKey);
  });
});
