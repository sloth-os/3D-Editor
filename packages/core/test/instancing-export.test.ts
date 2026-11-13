import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createPlane,
  exportScene,
  importFile,
  newId,
  type Mat4,
} from '../src';
import { readGLB } from '../src/io/glb';

/** Hidden 'Trees' collection with a 1 m cube, instanced by two empties; plus a visible ground. */
function scene() {
  const doc = SceneDoc.create({ empty: true });
  const trees = doc.addCollection({
    name: 'Trees',
    hide_viewport: true,
    hide_render: true,
    instance_offset: [0, 0, -1],
  });
  const mat = doc.addMaterial({ name: 'Bark' });
  const cube = doc.addObject({
    type: 'MESH',
    name: 'Cube',
    data: doc.addMesh('CubeMesh', createCube({ size: 1 })),
    collection: trees,
    material_slots: [mat],
  });
  const e1 = doc.addObject({
    type: 'EMPTY',
    name: 'InstA',
    instance_type: 'COLLECTION',
    instance_collection: trees,
    location: [5, 0, 0],
  });
  const e2 = doc.addObject({
    type: 'EMPTY',
    name: 'InstB',
    instance_type: 'COLLECTION',
    instance_collection: trees,
    location: [-5, 2, 0],
    rotation_euler: [0, 0, Math.PI / 2],
    scale: [2, 2, 2],
  });
  return { doc, trees, cube, e1, e2 };
}

function instanceMatrices(doc: SceneDoc): Map<string, Mat4> {
  const ev = new SceneEvaluator(doc).evaluate(1, { forRender: true });
  return new Map(ev.instances.map((i) => [`${ev.byId.get(i.ownerId)!.name}`, i.matrix]));
}

/** Vertex blocks per OBJ object (positions converted back to Z-up). */
function objObjects(text: string): Map<string, number[][]> {
  const out = new Map<string, number[][]>();
  let cur: number[][] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('o ')) out.set(line.slice(2), (cur = []));
    else if (line.startsWith('v ') && cur) {
      const [x, y, z] = line.slice(2).split(' ').map(Number);
      cur.push([x, -z, y]);
    }
  }
  return out;
}

const center = (pts: number[][]) => [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / pts.length);
const extent = (pts: number[][]) =>
  [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k])));

describe('exporting instances', () => {
  it('bakes instances into OBJ, STL and PLY', () => {
    const { doc } = scene();
    const obj = new TextDecoder().decode(exportScene(doc, 'obj').data);
    const objects = objObjects(obj);
    expect([...objects.keys()].sort()).toEqual(['InstA.Cube.001', 'InstB.Cube.001']);
    // InstA: cube at the empty (5,0,0) lifted by the -1 offset → centre (5,0,1), size 1
    expect(center(objects.get('InstA.Cube.001')!).map((x) => +x.toFixed(5))).toEqual([5, 0, 1]);
    expect(extent(objects.get('InstA.Cube.001')!).map((x) => +x.toFixed(5))).toEqual([1, 1, 1]);
    expect(center(objects.get('InstB.Cube.001')!).map((x) => +x.toFixed(5))).toEqual([-5, 2, 2]);
    expect(extent(objects.get('InstB.Cube.001')!).map((x) => +x.toFixed(5))).toEqual([2, 2, 2]);
    expect(obj).toMatch(/usemtl Bark/);

    const stl = exportScene(doc, 'stl').data;
    expect(new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true)).toBe(24);
    const ply = new TextDecoder('latin1').decode(exportScene(doc, 'ply').data);
    expect(ply).toMatch(/element vertex (\d+)/);
    expect(Number(/element vertex (\d+)/.exec(ply)![1])).toBeGreaterThanOrEqual(16);
    expect(Number(/element face (\d+)/.exec(ply)![1])).toBe(12);
  });

  it('exports only the instances of exported owners', () => {
    const { doc, cube, e1 } = scene();
    expect([
      ...objObjects(new TextDecoder().decode(exportScene(doc, 'obj', { objectIds: [cube] }).data)).keys(),
    ]).toEqual(['Cube']);
    expect([
      ...objObjects(new TextDecoder().decode(exportScene(doc, 'obj', { objectIds: [e1] }).data)).keys(),
    ]).toEqual(['InstA.Cube.001']);
    doc.updateObject(e1, { hide_render: true });
    expect([...objObjects(new TextDecoder().decode(exportScene(doc, 'obj').data)).keys()]).toEqual([
      'InstB.Cube.001',
    ]);
  });

  it('writes glTF nodes that share the source mesh and are parented to their owner', () => {
    const { doc } = scene();
    const out = exportScene(doc, 'glb');
    const { json } = readGLB(out.data);
    const nodes: any[] = json.nodes;
    const byName = new Map(nodes.map((n, i) => [n.name, { ...n, index: i }]));
    const a = byName.get('InstA.Cube.001')!;
    const b = byName.get('InstB.Cube.001')!;
    expect(a.mesh).toBeDefined();
    expect(b.mesh).toBe(a.mesh); // shared mesh
    expect(json.meshes).toHaveLength(1);
    expect(json.meshes[0].name).toBe('CubeMesh');
    expect(byName.get('InstA')!.children).toEqual([a.index]);
    expect(byName.get('InstB')!.children).toEqual([b.index]);
    expect(byName.has('Cube')).toBe(false); // the hidden source itself is not exported
    // round trip: re-imported instance objects sit where the instances were
    const expected = instanceMatrices(doc);
    const back = SceneDoc.create({ empty: true });
    importFile(back, 'glb', out.data);
    for (const [owner, m] of expected) {
      const o = back.findObjectByName(`${owner}.Cube.001`)!;
      const w = back.worldMatrix(o.id);
      for (let k = 0; k < 16; k++) expect(w[k]).toBeCloseTo(m[k], 5);
    }
  });

  it('exports particle instances, as root nodes when the relative transform would shear', () => {
    const doc = SceneDoc.create({ empty: true });
    const rock = doc.addObject({
      type: 'MESH',
      name: 'Rock',
      data: doc.addMesh('Rock', createCube({ size: 0.2 })),
      hide_render: true,
    });
    const ground = doc.addObject({
      type: 'MESH',
      name: 'Ground',
      data: doc.addMesh('Ground', createPlane({ size: 2 })),
      scale: [4, 1, 1],
    });
    doc.updateObject(ground, {
      particle_systems: [
        {
          id: newId(),
          name: 'Rocks',
          show_viewport: true,
          show_render: true,
          settings: { count: 12, instance_object: rock, phase_factor_random: 2 },
        },
      ],
    });
    const expected = new SceneEvaluator(doc).evaluate(1, { forRender: true }).instances;
    expect(expected).toHaveLength(12);
    const out = exportScene(doc, 'glb');
    const { json } = readGLB(out.data);
    const inst = (json.nodes as any[]).filter((n) => n.name.startsWith('Ground.Rock.'));
    expect(inst).toHaveLength(12);
    const groundNode = (json.nodes as any[]).find((n) => n.name === 'Ground');
    expect(groundNode.children ?? []).toEqual([]); // sheared relative to the scaled emitter → roots
    expect(json.scenes[0].nodes.length).toBe(13);
    const back = SceneDoc.create({ empty: true });
    importFile(back, 'glb', out.data);
    const got = back
      .listObjects()
      .filter((o) => o.name.startsWith('Ground.Rock.'))
      .map((o) => back.worldMatrix(o.id));
    expect(got).toHaveLength(12);
    for (const e of expected)
      expect(got.some((w) => w.every((x, k) => Math.abs(x - e.matrix[k]) < 1e-5))).toBe(true);
    // OBJ bakes them too
    const obj = objObjects(new TextDecoder().decode(exportScene(doc, 'obj').data));
    expect([...obj.keys()].filter((k) => k.startsWith('Ground.Rock.'))).toHaveLength(12);
  });
});
