import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createCube,
  createUVSphere,
  exportScene,
  faceCenter,
  faceNormal,
  importFile,
  sniffFormat,
  transformPoint3,
  type MeshData,
  type Vec3,
} from '../src';

const enc = (s: string) => new TextEncoder().encode(s);

const FIXTURE = `# hand-written fixture
mtllib fixture.mtl
o Pentagon
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0.5 1.5 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vt 0.5 1
vn 0 0 1
usemtl Red
s off
f -5/-5/-1 -4/-4/-1 -3/-3/-1 -1/-1/-1 -2/-2/-1
o Wedge
v 0 0 2
v 1 0 2
v 0 1 2
v 2 2 2
usemtl Blue
s 1
f 6//1 7//1 8//1
usemtl Red
f -4 -3 -1
l 8 9
`;

const MTL = `newmtl Red
Kd 1 0 0
newmtl Blue
Kd 0 0 1
Ns 250
d 0.5
`;

function meshOf(doc: SceneDoc, name: string): MeshData {
  const o = doc.findObjectByName(name);
  expect(o, name).toBeTruthy();
  return doc.getMesh(o!.data!)!;
}

function worldPositions(doc: SceneDoc, id: string): Vec3[] {
  const o = doc.getObject(id)!;
  const m = doc.getMesh(o.data!)!;
  const w = doc.worldMatrix(id);
  const out: Vec3[] = [];
  for (let i = 0; i < m.positions.length; i += 3)
    out.push(transformPoint3(w, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]));
  return out;
}

describe('OBJ import', () => {
  it('parses objects, negative indices, n-gons, materials, smoothing and lines', () => {
    const doc = SceneDoc.create({ empty: true });
    const res = importFile(doc, 'obj', enc(FIXTURE));
    expect(res.objects).toHaveLength(2);
    expect(res.warnings.some((w) => w.includes('fixture.mtl'))).toBe(true);

    const pent = meshOf(doc, 'Pentagon');
    expect(pent.positions.length / 3).toBe(5);
    // vertices keep the file order; the corner order follows the negative indices (-1 = 5th vertex)
    expect(pent.faces).toEqual([[0, 1, 2, 4, 3]]);
    // OBJ (0.5, 1.5, 0) → Y-up to Z-up: (x, -z, y)
    expect(pent.positions.slice(12, 15)).toEqual([0.5, 0, 1.5].map((v) => expect.closeTo(v, 6)));
    expect(pent.uvs![0].slice(6, 8)).toEqual([0.5, 1]);
    expect(pent.faceSmooth).toEqual([false]);

    const wedge = meshOf(doc, 'Wedge');
    expect(wedge.positions.length / 3).toBe(4);
    expect(wedge.faces).toHaveLength(2);
    expect(wedge.faceSmooth).toEqual([true, true]);
    expect(wedge.faceMaterials).toEqual([0, 1]);
    expect(wedge.looseEdges).toHaveLength(2);
    expect(wedge.uvs).toBeNull();

    // materials are created once per name and shared between objects
    const names = (id: string) => doc.getObject(id)!.material_slots.map((m) => doc.getMaterial(m!)!.name);
    expect(names(doc.findObjectByName('Pentagon')!.id)).toEqual(['Red']);
    expect(names(doc.findObjectByName('Wedge')!.id)).toEqual(['Blue', 'Red']);
    expect(doc.listMaterials()).toHaveLength(2);
  });

  it('reads the material library when supplied as a companion file', () => {
    const doc = SceneDoc.create({ empty: true });
    const res = importFile(doc, 'obj', enc(FIXTURE), { files: { 'fixture.mtl': enc(MTL) } });
    expect(res.warnings).toEqual([]);
    const red = doc.listMaterials().find((m) => m.name === 'Red')!;
    const blue = doc.listMaterials().find((m) => m.name === 'Blue')!;
    expect(red.base_color).toEqual([1, 0, 0, 1]);
    expect(blue.roughness).toBeCloseTo(0.5);
    expect(blue.alpha).toBeCloseTo(0.5);
    expect(blue.blend_method).toBe('BLEND');
  });

  it('applies name, location offset and vertex colors; skips invalid faces with a warning', () => {
    const doc = SceneDoc.create({ empty: true });
    const src = 'v 0 0 0 1 0 0\nv 1 0 0 0 1 0\nv 0 1 0 0 0 1\nf 1 2 3\nf 1 2 7\n';
    const res = importFile(doc, 'obj', enc(src), { name: 'Tri', location: [1, 2, 3] });
    const o = doc.getObject(res.objects[0])!;
    expect(o.name).toBe('Tri');
    expect(o.location).toEqual([1, 2, 3]);
    const m = doc.getMesh(o.data!)!;
    expect(m.faces).toHaveLength(1);
    expect(m.colors!.slice(0, 4)).toEqual([1, 0, 0, 1]);
    expect(res.warnings.some((w) => w.includes('invalid indices'))).toBe(true);
    expect(sniffFormat(enc(src))).toBe('obj');
  });
});

describe('OBJ export', () => {
  function scene() {
    const doc = SceneDoc.create({ empty: true });
    const mat = doc.addMaterial({ name: 'Painted Metal', base_color: [0.1, 0.2, 0.3, 1] });
    const cube = doc.addObject({
      type: 'MESH',
      name: 'Box',
      data: doc.addMesh('Box', createCube({ size: 2 })),
      location: [1, 2, 3],
      rotation_euler: [0.3, 0.2, 0.1],
      scale: [1, 2, 1],
      material_slots: [mat],
    });
    const sphereMesh = createUVSphere({ segments: 12, ring_count: 6 });
    sphereMesh.faceSmooth = sphereMesh.faceSmooth.map(() => true);
    const sphere = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', sphereMesh),
      location: [-3, 0, 0],
    });
    const mirrored = doc.addObject({
      type: 'MESH',
      name: 'Mirror',
      data: doc.addMesh('Mirror', createCube({ size: 1 })),
      location: [0, 5, 0],
      scale: [-1, 1, 1],
    });
    return { doc, cube, sphere, mirrored };
  }

  it('round-trips world-space geometry, UVs, smoothing and material names', () => {
    const { doc, cube, sphere } = scene();
    const out = exportScene(doc, 'obj');
    expect(out.mime).toBe('model/obj');
    expect(out.extension).toBe('obj');
    const text = new TextDecoder().decode(out.data);
    expect(text).toContain('o Box');
    expect(text).toContain('usemtl Painted_Metal');
    const doc2 = SceneDoc.create({ empty: true });
    const res = importFile(doc2, 'obj', out.data);
    expect(res.objects).toHaveLength(3);
    for (const [id, name] of [
      [cube, 'Box'],
      [sphere, 'Ball'],
    ] as const) {
      const src = doc.getMesh(doc.getObject(id)!.data!)!;
      const imported = doc2.findObjectByName(name)!;
      const dst = doc2.getMesh(imported.data!)!;
      expect(dst.positions.length).toBe(src.positions.length);
      expect(dst.faces.length).toBe(src.faces.length);
      expect(dst.faceSmooth).toEqual(src.faceSmooth);
      expect(dst.uvs!.flat().length).toBe(src.uvs!.flat().length);
      const a = worldPositions(doc, id);
      const b = worldPositions(doc2, imported.id);
      for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) expect(b[i][k]).toBeCloseTo(a[i][k], 5);
    }
    const box = doc2.findObjectByName('Box')!;
    expect(doc2.getMaterial(box.material_slots[0]!)!.name).toBe('Painted_Metal');
  });

  it('writes Y-up coordinates and keeps outward winding for mirrored objects', () => {
    const { doc, mirrored } = scene();
    const out = exportScene(doc, 'obj', { objectIds: [mirrored] });
    const text = new TextDecoder().decode(out.data);
    // Z-up (x, y, z) → Y-up (x, z, -y): the mirror cube spans y ∈ [4.5, 5.5] → OBJ z ∈ [-5.5, -4.5]
    const vs = text
      .split('\n')
      .filter((l) => l.startsWith('v '))
      .map((l) => l.split(' ').slice(1).map(Number));
    expect(vs).toHaveLength(8);
    for (const v of vs) expect(v[2]).toBeLessThan(-4.4);
    const doc2 = SceneDoc.create({ empty: true });
    importFile(doc2, 'obj', out.data);
    const m = doc2.getMesh(doc2.listObjects()[0].data!)!;
    const center: Vec3 = [0, 5, 0];
    for (let f = 0; f < m.faces.length; f++) {
      const c = faceCenter(m, f);
      const n = faceNormal(m, f);
      expect(
        (c[0] - center[0]) * n[0] + (c[1] - center[1]) * n[1] + (c[2] - center[2]) * n[2],
      ).toBeGreaterThan(0);
    }
  });
});
