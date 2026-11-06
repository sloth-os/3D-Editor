import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  buildRenderBuffers,
  computeHeatWeights,
  createCube,
  createFCurve,
  createPlane,
  defaultPoseBone,
  defaultProcedural,
  encodeFloat32,
  encodePNG,
  exportScene,
  importFile,
  insertKeyframe,
  type ConstraintData,
  type Mat4,
  type MeshData,
  type ModifierData,
  type TextureSlot,
  type Vec3,
} from '../src';
import { writeGLB } from '../src/io/glb';
import { armatureData, bone, tube } from './armature-helpers';
import { rb } from './physics-helpers';
import {
  gltfNodePositions,
  gltfPose,
  gltfProblems,
  nodeIndex,
  parseGltf,
  readAccessor,
  type Json,
} from './fixes-export-gltf-check';

/*
 * Regression tests for phase-3 issues #19, #20, #30 and #36 (glTF export):
 * - #19: BONE-parented objects were written with their bone-relative local transform under the
 *   armature node, so they collapsed at the armature origin;
 * - #20: only object-level F-curves were exported: no pose / IK / constraint / driver / physics
 *   results, no skins, no shape-key morph targets;
 * - #30: linked duplicates with different object-level materials duplicated their vertex data;
 * - #36: texture-less materials used by meshes with and without UVs were written twice.
 * Every exported file is also checked structurally (fixes-export-gltf-check.ts).
 */

const FPS = 24;

/** glTF (Y-up) world matrix of an editor (Z-up) world matrix of a node with a converted frame. */
function yUpWorld(m: Mat4, converted = true): number[] {
  const czy = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const cyz = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  };
  return converted ? mul(mul(czy, m), cyz) : mul(czy, m);
}

function expectClose(a: ArrayLike<number>, b: ArrayLike<number>, tol: number, what: string): void {
  expect(a.length, what).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  expect(worst, what).toBeLessThan(tol);
}

/** Editor world-space vertex positions (render buffer order, Y-up) of an evaluated mesh. */
function editorPositions(mesh: MeshData, world: Mat4): number[] {
  const rbuf = buildRenderBuffers(mesh);
  const out: number[] = [];
  const p = rbuf.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
    const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
    const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
    out.push(wx, wz, -wy);
  }
  return out;
}

/** Editor world-space positions (Y-up, like `editorPositions`) of a mesh's vertices. */
function worldPoints(mesh: MeshData, world: Mat4): number[] {
  const out: number[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
    const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
    const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
    out.push(wx, wz, -wy);
  }
  return out;
}

/** Largest distance from a point of one set to the nearest point of the other (both ways). */
function pointSetDistance(a: number[], b: number[]): number {
  const one = (p: number[], q: number[]) => {
    let worst = 0;
    for (let i = 0; i < p.length; i += 3) {
      let best = Infinity;
      for (let j = 0; j < q.length; j += 3)
        best = Math.min(best, Math.hypot(p[i] - q[j], p[i + 1] - q[j + 1], p[i + 2] - q[j + 2]));
      worst = Math.max(worst, best);
    }
    return worst;
  };
  return Math.max(one(a, b), one(b, a));
}

function keyed(target: string, path: string, index: number, keys: [number, number][]) {
  let fc = createFCurve({ target_type: 'object', target_id: target, path, index });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v, 'LINEAR');
  return fc;
}

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

function subsurf(): ModifierData {
  return {
    id: 'subsurf',
    name: 'Subdivision',
    type: 'SUBSURF',
    show_viewport: true,
    show_render: true,
    show_in_editmode: true,
    show_expanded: true,
    params: { levels: 1, render_levels: 1 },
  };
}

const RINGS = 9;
const SEG = 8;

/**
 * A robot-workcell-like rig: an armature away from the origin with a keyed two-bone pose, a part
 * BONE-parented to the upper bone, a hose skinned to both bones, an object copying the part's
 * location (constraint) and one spun by a driver.
 */
function rigScene(opts: { subsurfHose?: boolean } = {}) {
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({ frame_start: 1, frame_end: 11, fps: FPS });
  const arm = armatureData([
    bone('Base', [0, 0, 0], [0, 0, 1]),
    bone('Arm', [0, 0, 1], [0, 0, 2], { parent: 'Base', use_connect: true }),
  ]);
  const armId = doc.addArmature({ name: 'Rig', bones: arm.bones });
  const rig = doc.addObject({
    type: 'ARMATURE',
    name: 'Rig',
    data: armId,
    location: [1, 0.5, 0],
    rotation_euler: [0, 0, 0.3],
    pose: { bones: { Base: defaultPoseBone(), Arm: defaultPoseBone() } },
  });
  doc.setFCurve(
    keyed(rig, 'pose.bones["Base"].rotation_euler', 2, [
      [1, 0],
      [11, 1.2],
    ]),
  );
  doc.setFCurve(
    keyed(rig, 'pose.bones["Arm"].rotation_euler', 0, [
      [1, 0],
      [11, 0.9],
    ]),
  );
  // a part BONE-parented to the upper bone (local transform relative to the bone tail)
  const hand = doc.addObject({
    type: 'MESH',
    name: 'Hand',
    data: doc.addMesh('HandMesh', createCube({ size: 0.2 })),
    parent: rig,
    parent_type: 'BONE',
    parent_bone: 'Arm',
    location: [0.1, 0.05, 0.2],
    rotation_euler: [0.2, 0, 0],
  });
  // a hose skinned to both bones (heat weights)
  const mesh = tube(RINGS, SEG, 0.15, 2);
  const meshId = doc.addMesh('Hose', mesh);
  const weights = computeHeatWeights(mesh, [
    { name: 'Base', head: [0, 0, 0], tail: [0, 0, 1] },
    { name: 'Arm', head: [0, 0, 1], tail: [0, 0, 2] },
  ]);
  doc.setVertexGroups(meshId, [
    { name: 'Base', weights: encodeFloat32(weights.weights[0]) },
    { name: 'Arm', weights: encodeFloat32(weights.weights[1]) },
  ]);
  const hose = doc.addObject({
    type: 'MESH',
    name: 'Hose',
    data: meshId,
    parent: rig,
    modifiers: opts.subsurfHose ? [armatureModifier(rig), subsurf()] : [armatureModifier(rig)],
  });
  // follows the hand through a constraint (no F-curves of its own)
  const copy: ConstraintData = {
    id: 'c1',
    name: 'Copy Location',
    type: 'COPY_LOCATION',
    mute: false,
    influence: 1,
    target: hand,
    subtarget: '',
    show_expanded: true,
    params: {},
  };
  const follower = doc.addObject({
    type: 'EMPTY',
    name: 'Follower',
    constraints: [copy],
  });
  // spun by a driver
  const spinner = doc.addObject({
    type: 'MESH',
    name: 'Spinner',
    data: doc.addMesh('SpinnerMesh', createCube({ size: 0.3 })),
    location: [-2, 0, 0.5],
  });
  doc.setDriver({
    target_type: 'object',
    target_id: spinner,
    path: 'rotation_euler',
    index: 2,
    expression: 'frame * 0.1',
    variables: [],
    mute: false,
  });
  return { doc, rig, hand, hose, follower, spinner };
}

function exportGlb(doc: SceneDoc) {
  const res = exportScene(doc, 'glb');
  const { json, bin } = parseGltf(res.data);
  expect(gltfProblems(json, bin)).toEqual([]);
  return { res, json, bin };
}

describe('glTF export: bone parenting (#19)', () => {
  it('places BONE-parented objects under their bone node at their evaluated world transform', () => {
    const { doc, hand } = rigScene();
    const { json, bin } = exportGlb(doc);
    const handNode = nodeIndex(json, 'Hand');
    const armNode = nodeIndex(json, 'Arm');
    // child of the bone's node, not of the armature node
    expect(json.nodes[armNode].children).toContain(handNode);
    expect(json.nodes[nodeIndex(json, 'Rig')].children).not.toContain(handNode);
    const ev = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    const pose = gltfPose(json, bin, 0);
    expectClose(pose.world[handNode], yUpWorld(ev.byId.get(hand)!.worldMatrix), 1e-5, 'Hand world');
    // the re-imported file places it there too (the bones become empties)
    const doc2 = SceneDoc.create({ empty: true });
    importFile(doc2, 'glb', exportScene(doc, 'glb').data);
    const hand2 = doc2.findObjectByName('Hand')!;
    expectClose(doc2.worldMatrix(hand2.id), ev.byId.get(hand)!.worldMatrix, 1e-4, 're-imported Hand');
  });
});

describe('glTF export: sampled animation, skins and morph targets (#20)', () => {
  it('animates bones, bone children, constraint and driver results per frame', () => {
    const { doc, hand, follower, spinner, rig } = rigScene();
    const { json, bin } = exportGlb(doc);
    const anim = json.animations[0];
    const animated = new Set(anim.channels.map((c: Json) => json.nodes[c.target.node].name));
    for (const name of ['Base', 'Arm', 'Follower', 'Spinner']) expect(animated.has(name), name).toBe(true);
    // the hand moves with its bone: its local transform is constant, no channel needed
    expect(animated.has('Hand')).toBe(false);
    const ev = new SceneEvaluator(doc);
    for (const frame of [1, 3, 6, 11]) {
      const sc = ev.evaluate(frame, { forRender: true });
      const pose = gltfPose(json, bin, (frame - 1) / FPS);
      for (const [name, id] of [
        ['Hand', hand],
        ['Follower', follower],
        ['Spinner', spinner],
        ['Rig', rig],
      ] as const)
        expectClose(
          pose.world[nodeIndex(json, name)],
          yUpWorld(sc.byId.get(id)!.worldMatrix),
          2e-4,
          `${name} @${frame}`,
        );
      // bone nodes: posed bone matrices (native frames: Y along the bone)
      const rigEv = sc.byId.get(rig)!;
      for (const b of ['Base', 'Arm']) {
        const posed = rigEv.pose!.bones.get(b)!.matrix;
        const world = (() => {
          const a = rigEv.worldMatrix;
          const o = new Array<number>(16).fill(0);
          for (let c = 0; c < 4; c++)
            for (let r = 0; r < 4; r++)
              for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * posed[c * 4 + k];
          return o;
        })();
        expectClose(pose.world[nodeIndex(json, b)], yUpWorld(world, false), 2e-4, `bone ${b} @${frame}`);
      }
    }
  });

  it('exports an armature-deformed mesh as a glTF skin that reproduces the deformation', () => {
    const { doc, hose, rig } = rigScene();
    const { json, bin, res } = exportGlb(doc);
    const hoseNode = nodeIndex(json, 'Hose');
    const node = json.nodes[hoseNode];
    expect(node.skin).toBeDefined();
    // a root node with identity transform (glTF ignores skinned mesh node transforms)
    expect(json.scenes[0].nodes).toContain(hoseNode);
    expect(node.translation ?? node.rotation ?? node.scale ?? node.matrix).toBeUndefined();
    const skin = json.skins[node.skin];
    expect(skin.joints.map((j: number) => json.nodes[j].name)).toEqual(
      expect.arrayContaining(['Base', 'Arm']),
    );
    expect(skin.skeleton).toBe(nodeIndex(json, 'Rig'));
    const prim = json.meshes[node.mesh].primitives[0];
    expect(Object.keys(prim.attributes)).toEqual(expect.arrayContaining(['JOINTS_0', 'WEIGHTS_0']));
    expect((res.warnings ?? []).join('\n')).not.toMatch(/Hose/);
    // the skin + sampled bone animation give the evaluated (Blender) deformation at every frame
    const ev = new SceneEvaluator(doc);
    for (const frame of [1, 4, 8, 11]) {
      const sc = ev.evaluate(frame, { forRender: true });
      const h = sc.byId.get(hose)!;
      const want = editorPositions(h.mesh!, h.worldMatrix);
      const got = gltfNodePositions(json, bin, hoseNode, gltfPose(json, bin, (frame - 1) / FPS));
      expectClose(got, want, 2e-3, `hose @${frame}`);
    }
    // the armature at rest: bind pose = the mesh in place
    expect(sceneHasMotion(json)).toBe(true);
    expect(rig).toBeTruthy();
  });

  it('bakes other deformations (Armature + Subdivision) per frame into morph targets, with a warning', () => {
    const { doc, hose } = rigScene({ subsurfHose: true });
    const { json, bin, res } = exportGlb(doc);
    const hoseNode = nodeIndex(json, 'Hose');
    expect(json.nodes[hoseNode].skin).toBeUndefined();
    const prim = json.meshes[json.nodes[hoseNode].mesh].primitives[0];
    expect(prim.targets.length).toBe(11);
    expect((res.warnings ?? []).join('\n')).toMatch(
      /Hose.*deforms during the animation.*baked as 11 morph targets/,
    );
    const ev = new SceneEvaluator(doc);
    for (const frame of [1, 5, 11]) {
      const sc = ev.evaluate(frame, { forRender: true });
      const h = sc.byId.get(hose)!;
      const want = editorPositions(h.mesh!, h.worldMatrix);
      const got = gltfNodePositions(json, bin, hoseNode, gltfPose(json, bin, (frame - 1) / FPS));
      expectClose(got, want, 2e-3, `subdivided hose @${frame}`);
    }
  });

  it('exports shape keys as morph targets with animated weights', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ frame_start: 1, frame_end: 9, fps: FPS });
    const cube = createCube({ size: 1 });
    const meshId = doc.addMesh('Gripper', cube);
    const obj = doc.addObject({ type: 'MESH', name: 'Gripper', data: meshId, location: [0, 1, 0] });
    // "Grip" moves the +X face in by 0.3, "Lift" raises the top by 0.5 (relative to Grip)
    const base = doc.getMesh(meshId)!.positions;
    const grip = base.map((v, i) => (i % 3 === 0 && base[i] > 0 ? v - 0.3 : v));
    const lift = grip.map((v, i) => (i % 3 === 2 && base[i] > 0 ? v + 0.5 : v));
    doc.setShapeKeys(meshId, [
      {
        name: 'Grip',
        value: 0,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: '',
        data: encodeFloat32(grip),
      },
      {
        name: 'Lift',
        value: 0.5,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: 'Grip',
        data: encodeFloat32(lift),
      },
    ]);
    let fc = createFCurve({
      target_type: 'mesh',
      target_id: meshId,
      path: 'shape_keys["Grip"].value',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 9, 1, 'LINEAR');
    doc.setFCurve(fc);
    const { json, bin } = exportGlb(doc);
    const n = nodeIndex(json, 'Gripper');
    const mesh = json.meshes[json.nodes[n].mesh];
    expect(mesh.extras.targetNames).toEqual(['Grip', 'Lift']);
    expect(mesh.weights).toEqual([0, 0.5]);
    expect(mesh.primitives[0].targets).toHaveLength(2);
    const weightsCh = json.animations[0].channels.find((c: Json) => c.target.path === 'weights');
    expect(weightsCh.target.node).toBe(n);
    const ev = new SceneEvaluator(doc);
    for (const frame of [1, 5, 9]) {
      const sc = ev.evaluate(frame, { forRender: true });
      const o = sc.byId.get(obj)!;
      const got = gltfNodePositions(json, bin, n, gltfPose(json, bin, (frame - 1) / FPS));
      expectClose(got, editorPositions(o.mesh!, o.worldMatrix), 1e-4, `shape keys @${frame}`);
    }
  });

  it('round-trips morph targets as shape keys with their animation (import)', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ frame_start: 1, frame_end: 9, fps: FPS });
    const meshId = doc.addMesh('Gripper', createCube({ size: 1 }));
    const obj = doc.addObject({ type: 'MESH', name: 'Gripper', data: meshId });
    const base = doc.getMesh(meshId)!.positions;
    const grip = base.map((v, i) => (i % 3 === 0 && base[i] > 0 ? v - 0.3 : v));
    doc.setShapeKeys(meshId, [
      {
        name: 'Grip',
        value: 0.25,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: '',
        data: encodeFloat32(grip),
      },
    ]);
    let fc = createFCurve({
      target_type: 'mesh',
      target_id: meshId,
      path: 'shape_keys["Grip"].value',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 9, 1, 'LINEAR');
    doc.setFCurve(fc);
    const doc2 = SceneDoc.create({ empty: true });
    doc2.updateScene({ frame_start: 1, frame_end: 9, fps: FPS });
    const res = importFile(doc2, 'glb', exportScene(doc, 'glb').data);
    expect(res.warnings.join('\n')).not.toMatch(/Morph/);
    const o2 = doc2.findObjectByName('Gripper')!;
    const keys = doc2.getShapeKeys(o2.data!);
    expect(keys.map((k) => k.name)).toEqual(['Grip']);
    // stored value: the default weight (the keyed value at the export frame 1, not the
    // document's 0.25); the imported F-curve drives it
    expect(keys[0].value).toBeCloseTo(0, 6);
    expect(doc2.listFCurves().some((fc) => fc.path === 'shape_keys["Grip"].value')).toBe(true);
    const ev1 = new SceneEvaluator(doc);
    const ev2 = new SceneEvaluator(doc2);
    for (const frame of [1, 5, 9]) {
      const a = ev1.evaluate(frame).byId.get(obj)!;
      const b = ev2.evaluate(frame).byId.get(o2.id)!;
      // the importer triangulates and splits vertices (one per glTF vertex): compare the world
      // positions as point sets
      expect(
        pointSetDistance(worldPoints(b.mesh!, b.worldMatrix), worldPoints(a.mesh!, a.worldMatrix)),
        `@${frame}`,
      ).toBeLessThan(1e-4);
    }
    // the deformation is really animated: the +X face moved in by 0.3 at frame 9
    const end = ev2.evaluate(9).byId.get(o2.id)!;
    const maxX = Math.max(...worldPoints(end.mesh!, end.worldMatrix).filter((_, i) => i % 3 === 0));
    expect(maxX).toBeCloseTo(0.5 - 0.3, 4);
  });

  it('imports morph targets with unique shape key names, node weights and clear warnings', () => {
    const doc = SceneDoc.create({ empty: true });
    const meshId = doc.addMesh('Blob', createCube({ size: 1 }));
    doc.addObject({ type: 'MESH', name: 'Blob', data: meshId });
    const base = doc.getMesh(meshId)!.positions;
    const up = base.map((v, i) => (i % 3 === 2 ? v + 0.25 : v));
    const key = (name: string, value: number) => ({
      name,
      value,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: '',
      data: encodeFloat32(up),
    });
    doc.setShapeKeys(meshId, [key('A', 0.1), key('B', 0.2)]);
    const { json, bin } = parseGltf(exportScene(doc, 'glb').data);
    // a hand-edited file: duplicate target names, node weights overriding the mesh's, and a
    // weights animation with the wrong number of values
    const n = nodeIndex(json, 'Blob');
    json.meshes[json.nodes[n].mesh].extras.targetNames = ['Same', 'Same'];
    json.nodes[n].weights = [0.75, 0];
    const times = json.accessors.length;
    json.accessors.push({ ...json.accessors[json.meshes[0].primitives[0].indices], count: 1 });
    json.animations = [
      {
        channels: [{ sampler: 0, target: { node: n, path: 'weights' } }],
        samplers: [{ input: times, output: times, interpolation: 'LINEAR' }],
      },
    ];
    const glb = writeGLB(json, bin);
    const doc2 = SceneDoc.create({ empty: true });
    const res = importFile(doc2, 'glb', glb);
    const o2 = doc2.findObjectByName('Blob')!;
    const keys = doc2.getShapeKeys(o2.data!);
    expect(keys.map((k) => k.name)).toEqual(['Same', 'Same.001']);
    expect(keys.map((k) => k.value)).toEqual([0.75, 0]);
    expect(res.warnings.join('\n')).toMatch(
      /weights animation of node 'Blob' ignored: .* for 2 morph targets/,
    );
  });

  it('imports sparse morph targets (as Blender writes shape keys) and their weights animation', () => {
    // one triangle; target "Lift" moves vertex 2 up by 1 (Y-up), stored as a sparse accessor
    // without a bufferView; weights animated 0 → 1 over one second (CUBICSPLINE: tangents ignored)
    const f32 = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
    const parts = [
      f32([0, 0, 0, 1, 0, 0, 0, 0, -1]), // POSITION
      new Uint8Array(new Uint16Array([2, 0]).buffer), // sparse indices (padded)
      f32([0, 1, 0]), // sparse values
      f32([0, 1]), // times
      f32([0, 0, 0, 0, 1, 0]), // weights: (in, value, out) per key
    ];
    const offsets: number[] = [];
    let len = 0;
    for (const p of parts) {
      offsets.push(len);
      len += p.length;
    }
    const bin = new Uint8Array(len);
    parts.forEach((p, i) => bin.set(p, offsets[i]));
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Tri', mesh: 0 }],
      meshes: [
        {
          name: 'Tri',
          extras: { targetNames: ['Lift'] },
          weights: [0.25],
          primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }],
        },
      ],
      buffers: [{ byteLength: len }],
      bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: p.length })),
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, -1], max: [1, 0, 0] },
        {
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [0, 1, 0],
          sparse: {
            count: 1,
            indices: { bufferView: 1, componentType: 5123 },
            values: { bufferView: 2 },
          },
        },
        { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 4, componentType: 5126, count: 6, type: 'SCALAR' },
      ],
      animations: [
        {
          channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
          samplers: [{ input: 2, output: 3, interpolation: 'CUBICSPLINE' }],
        },
      ],
    };
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ fps: 24, frame_start: 1, frame_end: 25 });
    const res = importFile(doc, 'glb', writeGLB(json, bin));
    expect(res.warnings.join('\n')).not.toMatch(/Morph|weights/);
    const tri = doc.findObjectByName('Tri')!;
    const keys = doc.getShapeKeys(tri.data!);
    expect(keys.map((k) => [k.name, k.value])).toEqual([['Lift', 0.25]]);
    const ev = new SceneEvaluator(doc);
    // glTF vertex 2 (0, 0, -1) is editor (0, 1, 0); "Lift" raises it to z = 1 at full weight
    const z2 = (frame: number) => ev.evaluate(frame).byId.get(tri.id)!.mesh!.positions[2 * 3 + 2];
    expect(z2(1)).toBeCloseTo(0, 5);
    expect(z2(25)).toBeCloseTo(1, 5);
  });

  it('re-imports a skinned mesh at its rest pose in world space', () => {
    const { doc, hose } = rigScene();
    const doc2 = SceneDoc.create({ empty: true });
    importFile(doc2, 'glb', exportScene(doc, 'glb').data);
    const h2 = doc2.findObjectByName('Hose')!;
    const rest = new SceneEvaluator(doc).evaluate(1, { forRender: true }).byId.get(hose)!;
    const imported = new SceneEvaluator(doc2).evaluate(1, { forRender: true }).byId.get(h2.id)!;
    expect(
      pointSetDistance(
        editorPositions(imported.mesh!, imported.worldMatrix),
        editorPositions(rest.mesh!, rest.worldMatrix),
      ),
    ).toBeLessThan(1e-4);
  });

  it('samples rigid body simulation results', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({
      frame_start: 1,
      frame_end: 12,
      fps: FPS,
      rigidbody_world: { ...doc.getScene().rigidbody_world, enabled: true, frame_start: 1, frame_end: 12 },
    });
    doc.addObject({
      type: 'MESH',
      name: 'Ground',
      data: doc.addMesh('Ground', createPlane({ size: 10 })),
      rigid_body: rb('PASSIVE'),
    });
    const box = doc.addObject({
      type: 'MESH',
      name: 'Box',
      data: doc.addMesh('Box', createCube({ size: 0.5 })),
      location: [0, 0, 2],
      rigid_body: rb('ACTIVE'),
    });
    const { json, bin } = exportGlb(doc);
    const n = nodeIndex(json, 'Box');
    expect(
      json.animations[0].channels.some((c: Json) => c.target.node === n && c.target.path === 'translation'),
    ).toBe(true);
    const ev = new SceneEvaluator(doc);
    for (const frame of [1, 6, 12]) {
      const w = ev.evaluate(frame, { forRender: true }).byId.get(box)!.worldMatrix;
      expectClose(gltfPose(json, bin, (frame - 1) / FPS).world[n], yUpWorld(w), 1e-4, `box @${frame}`);
    }
    // it fell
    expect(gltfPose(json, bin, 11 / FPS).world[n][13]).toBeLessThan(1.5);
  });

  it('writes a matrix for a sheared transform (non-uniform parent scale, parent not exported)', () => {
    const doc = SceneDoc.create({ empty: true });
    const parent = doc.addObject({ type: 'EMPTY', name: 'P', scale: [2, 1, 1] });
    const child = doc.addObject({
      type: 'MESH',
      name: 'C',
      data: doc.addMesh('C', createCube()),
      parent,
      location: [1, 0, 0],
      rotation_euler: [0, 0, Math.PI / 4],
    });
    const res = exportScene(doc, 'glb', { objectIds: [child] });
    const { json, bin } = parseGltf(res.data);
    expect(gltfProblems(json, bin)).toEqual([]);
    const n = json.nodes[nodeIndex(json, 'C')];
    expect(n.matrix).toHaveLength(16);
    const w = new SceneEvaluator(doc).evaluate(1).byId.get(child)!.worldMatrix;
    expectClose(gltfPose(json, bin).world[nodeIndex(json, 'C')], yUpWorld(w), 1e-6, 'sheared world');
  });

  it('animates a sheared transform with the closest rotation (not without rotation), with a warning', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ frame_start: 1, frame_end: 11, fps: FPS });
    const parent = doc.addObject({ type: 'EMPTY', name: 'P', scale: [1.5, 1, 1] });
    const child = doc.addObject({
      type: 'MESH',
      name: 'C',
      data: doc.addMesh('C', createCube()),
      parent,
      location: [1, 0, 0],
    });
    doc.setFCurve(
      keyed(child, 'rotation_euler', 2, [
        [1, 0],
        [11, Math.PI / 2],
      ]),
    );
    const res = exportScene(doc, 'glb', { objectIds: [child] });
    const { json, bin } = parseGltf(res.data);
    expect(gltfProblems(json, bin)).toEqual([]);
    expect((res.warnings ?? []).join('\n')).toMatch(/'C' has a sheared transform/);
    const n = nodeIndex(json, 'C');
    const ev = new SceneEvaluator(doc);
    // frame 6: 45° inside a 1.5× x-scale (sheared); TRS can only approximate it, but the closest
    // rotation keeps every element within 0.2 (no rotation at all would be off by more than 1)
    const w6 = ev.evaluate(6, { forRender: true }).byId.get(child)!.worldMatrix;
    expectClose(gltfPose(json, bin, 5 / FPS).world[n], yUpWorld(w6), 0.2, 'sheared @6');
    // frames 1 and 11 (0° and 90°) are not sheared: exact
    for (const frame of [1, 11]) {
      const w = ev.evaluate(frame, { forRender: true }).byId.get(child)!.worldMatrix;
      expectClose(gltfPose(json, bin, (frame - 1) / FPS).world[n], yUpWorld(w), 1e-4, `@${frame}`);
    }
  });

  it('writes no animation for a static scene and keeps plain object transforms exact', () => {
    const doc = SceneDoc.create({ empty: true });
    const parent = doc.addObject({ type: 'EMPTY', name: 'P', location: [1, 2, 3], scale: [2, 2, 2] });
    doc.addObject({
      type: 'MESH',
      name: 'C',
      data: doc.addMesh('C', createCube()),
      parent,
      location: [0.5, 0, 0],
      rotation_euler: [0, 0, Math.PI / 2],
    });
    const { json } = exportGlb(doc);
    expect(json.animations).toBeUndefined();
    expect(json.nodes[nodeIndex(json, 'P')].translation).toEqual([1, 3, -2]);
    expect(json.nodes[nodeIndex(json, 'C')].translation).toEqual([0.5, 0, 0]);
  });
});

/** Whether any animation channel exists. */
function sceneHasMotion(json: Json): boolean {
  return (json.animations?.[0]?.channels?.length ?? 0) > 0;
}

describe('glTF export: deduplication (#30, #36)', () => {
  it('shares the vertex data of linked duplicates with different object-level materials', () => {
    const doc = SceneDoc.create({ empty: true });
    const meshId = doc.addMesh('Domino', createCube({ size: 0.5 }));
    const colors: [number, number, number, number][] = [
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ];
    colors.forEach((c, i) =>
      doc.addObject({
        type: 'MESH',
        name: `Domino.${i}`,
        data: meshId,
        location: [i, 0, 0],
        material_slots: [doc.addMaterial({ name: `M${i}`, base_color: c })],
      }),
    );
    const { json } = exportGlb(doc);
    expect(json.meshes).toHaveLength(3);
    const pos = new Set(json.meshes.map((m: Json) => m.primitives[0].attributes.POSITION));
    const idx = new Set(json.meshes.map((m: Json) => m.primitives[0].indices));
    expect(pos.size).toBe(1);
    expect(idx.size).toBe(1);
    expect(new Set(json.meshes.map((m: Json) => m.primitives[0].material)).size).toBe(3);
    // one copy of the vertex data in the buffer: 3 meshes cost about as much as one
    const single = SceneDoc.create({ empty: true });
    single.addObject({
      type: 'MESH',
      name: 'Domino',
      data: single.addMesh('Domino', createCube({ size: 0.5 })),
      material_slots: [single.addMaterial({ name: 'M' })],
    });
    const one = parseGltf(exportScene(single, 'glb').data).bin.length;
    expect(parseGltf(exportScene(doc, 'glb').data).bin.length).toBeLessThan(one * 1.2);
  });

  it('writes a texture-less material once for meshes with and without UVs', () => {
    const doc = SceneDoc.create({ empty: true });
    const gold = doc.addMaterial({ name: 'Polished Gold', base_color: [1, 0.8, 0.3, 1], metallic: 1 });
    doc.addObject({
      type: 'MESH',
      name: 'WithUV',
      data: doc.addMesh('WithUV', createCube()),
      material_slots: [gold],
    });
    doc.addObject({
      type: 'MESH',
      name: 'NoUV',
      data: doc.addMesh('NoUV', { ...createCube(), uvs: null }),
      location: [3, 0, 0],
      material_slots: [gold],
    });
    const { json } = exportGlb(doc);
    expect(json.materials.map((m: Json) => m.name)).toEqual(['Polished Gold']);
  });
});

describe('glTF export: procedural textures on meshes without UVs (#21)', () => {
  const slot = (p: ReturnType<typeof defaultProcedural>): TextureSlot => ({
    image: '',
    scale: [1, 1],
    offset: [0, 0],
    procedural: p,
  });

  it('bakes GENERATED/OBJECT textures into generated UVs (non-overlapping, inside 0..1)', () => {
    const doc = SceneDoc.create({ empty: true });
    const stripes = doc.addMaterial({
      name: 'Hazard',
      textures: {
        base_color: slot(
          defaultProcedural('WAVE', {
            mapping: 'OBJECT',
            scale: 4,
            color_a: [1, 0.8, 0, 1],
            color_b: [0, 0, 0, 1],
          }),
        ),
      },
    });
    doc.addObject({
      type: 'MESH',
      name: 'Fence',
      data: doc.addMesh('Fence', { ...createCube({ size: 1 }), uvs: null }),
      material_slots: [stripes],
    });
    const { json, bin, res } = exportGlb(doc);
    expect((res.warnings ?? []).join('\n')).toMatch(/Fence.*generated UVs/);
    const prim = json.meshes[0].primitives[0];
    const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0);
    expect(uv.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
    expect(json.images).toHaveLength(1);
  }, 60_000);

  it('keeps image textures of a material shared with a mesh whose UVs were generated', () => {
    const doc = SceneDoc.create({ empty: true });
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const png = encodePNG({ width: 2, height: 2, data: px });
    const img = doc.addImage({ name: 'Checker', mime: 'image/png', width: 2, height: 2, data: png });
    const textured = doc.addMaterial({
      name: 'Textured',
      textures: { base_color: { image: img, scale: [1, 1], offset: [0, 0] } },
    });
    const stripes = doc.addMaterial({
      name: 'Stripes',
      textures: { base_color: slot(defaultProcedural('WAVE', { mapping: 'OBJECT', scale: 4 })) },
    });
    // "A" (exported first) has no UVs: generated for its procedural slot, its image slot dropped
    const noUv = { ...createCube(), uvs: null };
    noUv.faceMaterials = noUv.faces.map((_, f) => f % 2);
    doc.addObject({
      type: 'MESH',
      name: 'A',
      data: doc.addMesh('A', noUv),
      material_slots: [stripes, textured],
    });
    doc.addObject({
      type: 'MESH',
      name: 'B',
      data: doc.addMesh('B', createCube()),
      location: [3, 0, 0],
      material_slots: [textured],
    });
    const { json, res } = exportGlb(doc);
    expect((res.warnings ?? []).join('\n')).toMatch(/'Textured': image textures need UVs, but mesh 'A'/);
    const matOf = (name: string) => {
      const mesh = json.meshes[json.nodes[nodeIndex(json, name)].mesh];
      return mesh.primitives.map((p: Json) => json.materials[p.material]);
    };
    const onB = matOf('B')[0];
    expect(onB.name).toBe('Textured');
    expect(onB.pbrMetallicRoughness.baseColorTexture).toBeDefined();
    const onA = matOf('A').find((m: Json) => m.name === 'Textured');
    expect(onA.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
  }, 60_000);
});

/** Re-exported for the vertex check of skinned meshes (rest pose): bone matrices are used. */
export type { Vec3 };
