import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  buildRenderBuffers,
  computeHeatWeights,
  createCube,
  createFCurve,
  createGrid,
  defaultPoseBone,
  encodeFloat32,
  exportScene,
  insertKeyframe,
  type AnimTargetType,
  type Mat4,
  type MeshData,
  type ModifierData,
} from '../src';
import { armatureData, bone, tube } from './armature-helpers';
import {
  gltfNodePositions,
  gltfPose,
  gltfProblems,
  nodeIndex,
  parseGltf,
  readAccessor,
} from './fixes-export-gltf-check';

/*
 * glTF exporter leftovers of the last verification:
 * - the size budget of baked deformations counted mesh vertices, but morph targets hold one delta
 *   per written vertex (split at flat faces, sharp edges and UV seams): a flat-shaded 200 × 200
 *   WAVE grid over 250 frames gave a 171 MB file for a 48 MB budget;
 * - animated camera, light, material and world properties were dropped without a warning;
 * - apply_modifiers=false dropped the skin of Armature-deformed meshes (Blender keeps it).
 */

const modifier = (type: string, params: Record<string, unknown>): ModifierData => ({
  id: type.toLowerCase(),
  name: type,
  type,
  show_viewport: true,
  show_render: true,
  show_in_editmode: true,
  show_expanded: true,
  params,
});

function keyed(
  doc: SceneDoc,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
  keys: [number, number][],
) {
  let fc = createFCurve({ target_type: type, target_id: id, path, index });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v, 'LINEAR');
  doc.setFCurve(fc);
}

function exportGlb(doc: SceneDoc, applyModifiers = true) {
  const res = exportScene(doc, 'glb', { applyModifiers });
  const { json, bin } = parseGltf(res.data);
  expect(gltfProblems(json, bin)).toEqual([]);
  return { res, json, bin, warnings: (res.warnings ?? []).join('\n') };
}

/** Editor world-space vertex positions (render buffer order, Y-up) of an evaluated mesh. */
function editorPositions(mesh: MeshData, world: Mat4): number[] {
  const p = buildRenderBuffers(mesh).positions;
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
    out.push(
      world[0] * x + world[4] * y + world[8] * z + world[12],
      world[2] * x + world[6] * y + world[10] * z + world[14],
      -(world[1] * x + world[5] * y + world[9] * z + world[13]),
    );
  }
  return out;
}

const worst = (a: number[], b: number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

describe('glTF export leftovers', () => {
  it('keeps baked deformations within the size budget counted in written (split) vertices', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ frame_start: 1, frame_end: 60 });
    const grid = createGrid({ x_subdivisions: 100, y_subdivisions: 100, size: 10 });
    grid.faceSmooth = grid.faces.map(() => false); // flat: 4 written vertices per mesh vertex
    const sea = doc.addObject({
      type: 'MESH',
      name: 'Sea',
      data: doc.addMesh('Sea', grid),
      modifiers: [modifier('WAVE', { height: 0.2, speed: 0.1 })],
    });
    const { json, bin, warnings } = exportGlb(doc);
    const node = nodeIndex(json, 'Sea');
    const prim = json.meshes[json.nodes[node].mesh].primitives[0];
    const written = json.accessors[prim.attributes.POSITION].count;
    expect(written).toBe(4 * 100 * 100);
    // POSITION + NORMAL deltas of every target fit in the 12M-float budget (60 frames would be
    // 14.4M; the old budget, counting the 10 201 mesh vertices, let all 60 through)
    const targets = prim.targets.length;
    expect(Object.keys(prim.targets[0]).sort()).toEqual(['NORMAL', 'POSITION']);
    expect(targets * written * 6).toBeLessThanOrEqual(12_000_000);
    // frames 1, 3, …, 59 and the last one
    expect(targets).toBe(31);
    expect(warnings).toMatch(
      /Mesh 'Sea' deforms during the animation.*baked as 31 morph targets \(every 2nd frame/,
    );
    // the baked frames (and the last one) still reproduce the evaluated wave
    const ev = new SceneEvaluator(doc);
    for (const frame of [1, 31, 60]) {
      const sc = ev.evaluate(frame, { forRender: true });
      const o = sc.byId.get(sea)!;
      const got = gltfNodePositions(json, bin, node, gltfPose(json, bin, (frame - 1) / 24));
      expect(worst(got, editorPositions(o.mesh!, o.worldMatrix)), `frame ${frame}`).toBeLessThan(1e-4);
    }
  });

  it('warns about animated camera, light, material and world properties glTF cannot carry', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ frame_start: 1, frame_end: 20 });
    const camData = doc.addCamera({ lens: 50 });
    doc.addObject({ type: 'CAMERA', name: 'Cam', data: camData, location: [0, -5, 1] });
    keyed(doc, 'camera', camData, 'lens', 0, [
      [1, 35],
      [20, 85],
    ]);
    const lamp = doc.addLight({ type: 'SPOT', energy: 100 });
    doc.addObject({ type: 'LIGHT', name: 'Lamp', data: lamp, location: [0, 0, 3] });
    keyed(doc, 'light', lamp, 'energy', 0, [
      [1, 100],
      [20, 400],
    ]);
    doc.setDriver({
      target_type: 'light',
      target_id: lamp,
      path: 'spot_size',
      index: 0,
      expression: '0.5 + frame * 0.01',
      variables: [],
      mute: false,
    });
    const glow = doc.addMaterial({ name: 'Glow', base_color: [1, 1, 1, 1] });
    const still = doc.addMaterial({ name: 'Still', base_color: [0.2, 0.2, 0.2, 1] });
    keyed(doc, 'material', glow, 'base_color', 0, [
      [1, 1],
      [20, 0],
    ]);
    // keyed but constant: nothing is lost, no warning
    keyed(doc, 'material', still, 'roughness', 0, [
      [1, 0.4],
      [20, 0.4],
    ]);
    doc.addObject({
      type: 'MESH',
      name: 'Box',
      data: doc.addMesh('Box', createCube({ size: 1 })),
      material_slots: [glow, still],
    });
    keyed(doc, 'world', 'world', 'color', 2, [
      [1, 0.05],
      [20, 0.5],
    ]);
    const { warnings } = exportGlb(doc);
    expect(warnings).toMatch(
      /Camera 'Cam': the animation of lens is not exported .*KHR_animation_pointer.*frame 1/,
    );
    expect(warnings).toMatch(/Light 'Lamp': the animation of energy, spot_size is not exported/);
    expect(warnings).toMatch(/Material 'Glow': the animation of base_color is not exported/);
    expect(warnings).toMatch(/World: the animation of color is not exported \(glTF has no world/);
    expect(warnings).not.toMatch(/Still/);
  });

  it('keeps the skin of an Armature-deformed mesh with apply_modifiers=false', () => {
    const rig = (withSubsurf: boolean) => {
      const doc = SceneDoc.create({ empty: true });
      doc.updateScene({ frame_start: 1, frame_end: 11 });
      const arm = armatureData([
        bone('Base', [0, 0, 0], [0, 0, 1]),
        bone('Arm', [0, 0, 1], [0, 0, 2], { parent: 'Base', use_connect: true }),
      ]);
      const rigId = doc.addObject({
        type: 'ARMATURE',
        name: 'Rig',
        data: doc.addArmature({ name: 'Rig', bones: arm.bones }),
        pose: { bones: { Base: defaultPoseBone(), Arm: defaultPoseBone() } },
      });
      keyed(doc, 'object', rigId, 'pose.bones["Arm"].rotation_euler', 0, [
        [1, 0],
        [11, 0.9],
      ]);
      const mesh = tube(9, 8, 0.15, 2);
      const meshId = doc.addMesh('Hose', mesh);
      const w = computeHeatWeights(mesh, [
        { name: 'Base', head: [0, 0, 0], tail: [0, 0, 1] },
        { name: 'Arm', head: [0, 0, 1], tail: [0, 0, 2] },
      ]);
      doc.setVertexGroups(meshId, [
        { name: 'Base', weights: encodeFloat32(w.weights[0]) },
        { name: 'Arm', weights: encodeFloat32(w.weights[1]) },
      ]);
      const hose = doc.addObject({
        type: 'MESH',
        name: 'Hose',
        data: meshId,
        parent: rigId,
        modifiers: [
          modifier('ARMATURE', { object: rigId }),
          ...(withSubsurf ? [modifier('SUBSURF', { levels: 1, render_levels: 1 })] : []),
        ],
      });
      return { doc, hose };
    };
    // Armature + Subdivision without applying modifiers: the base mesh with its skin
    const { doc } = rig(true);
    const { json, bin, warnings } = exportGlb(doc, false);
    const node = nodeIndex(json, 'Hose');
    expect(json.nodes[node].skin).toBeDefined();
    const prim = json.meshes[json.nodes[node].mesh].primitives[0];
    expect(prim.targets).toBeUndefined();
    expect(Object.keys(prim.attributes)).toEqual(expect.arrayContaining(['JOINTS_0', 'WEIGHTS_0']));
    // the base mesh (not subdivided)
    expect(readAccessor(json, bin, prim.attributes.POSITION).length / 3).toBe(
      buildRenderBuffers(tube(9, 8, 0.15, 2)).positions.length / 3,
    );
    expect(warnings).not.toMatch(/Hose/);
    // it deforms like the mesh with the Armature modifier alone
    const plain = rig(false);
    const ev = new SceneEvaluator(plain.doc);
    for (const frame of [1, 6, 11]) {
      const o = ev.evaluate(frame, { forRender: true }).byId.get(plain.hose)!;
      const got = gltfNodePositions(json, bin, node, gltfPose(json, bin, (frame - 1) / 24));
      expect(worst(got, editorPositions(o.mesh!, o.worldMatrix)), `frame ${frame}`).toBeLessThan(2e-3);
    }
  });
});
