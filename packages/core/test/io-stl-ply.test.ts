import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SceneDoc,
  cloneMesh,
  registerModifier,
  createCube,
  createGrid,
  exportScene,
  importFile,
  isClosedManifold,
  sniffFormat,
  transformPoint3,
  type Vec3,
} from '../src';

const enc = (s: string) => new TextEncoder().encode(s);

function worldBounds(doc: SceneDoc, id: string): { min: Vec3; max: Vec3 } {
  const o = doc.getObject(id)!;
  const m = doc.getMesh(o.data!)!;
  const w = doc.worldMatrix(id);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    const p = transformPoint3(w, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

const TETRA = `solid tetra
facet normal 0 0 -1
 outer loop
  vertex 0 0 0
  vertex 0 1 0
  vertex 1 0 0
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 0 1
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex 0 0 0
  vertex 0 0 1
  vertex 0 1 0
 endloop
endfacet
facet normal 1 1 1
 outer loop
  vertex 1 0 0
  vertex 0 1 0
  vertex 0 0 1.0000000001
 endloop
endfacet
endsolid tetra
`;

describe('STL', () => {
  it('imports ASCII STL as one welded, closed mesh', () => {
    const doc = SceneDoc.create({ empty: true });
    expect(sniffFormat(enc(TETRA))).toBe('stl');
    const res = importFile(doc, 'stl', enc(TETRA), { location: [0, 0, 1] });
    expect(res.objects).toHaveLength(1);
    const o = doc.getObject(res.objects[0])!;
    expect(o.name).toBe('tetra');
    expect(o.location).toEqual([0, 0, 1]);
    const m = doc.getMesh(o.data!)!;
    expect(m.positions.length / 3).toBe(4);
    expect(m.faces).toHaveLength(4);
    expect(isClosedManifold(m)).toBe(true);
  });

  it('exports binary STL in world space and re-imports it', () => {
    const doc = SceneDoc.create({ empty: true });
    const id = doc.addObject({
      type: 'MESH',
      name: 'Cube',
      data: doc.addMesh('Cube', createCube({ size: 2 })),
      location: [1, 2, 3],
      scale: [2, 1, 1],
    });
    const out = exportScene(doc, 'stl');
    expect(out.mime).toBe('model/stl');
    const header = new TextDecoder().decode(out.data.subarray(0, 80));
    expect(header.startsWith('solid')).toBe(false);
    const dv = new DataView(out.data.buffer, out.data.byteOffset, out.data.byteLength);
    expect(dv.getUint32(80, true)).toBe(12);
    expect(out.data.length).toBe(84 + 12 * 50);
    // stored normals point away from the cube center
    for (let t = 0; t < 12; t++) {
      const o = 84 + t * 50;
      const n = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
      const c = [0, 1, 2].map(
        (k) =>
          (dv.getFloat32(o + 12 + k * 4, true) +
            dv.getFloat32(o + 24 + k * 4, true) +
            dv.getFloat32(o + 36 + k * 4, true)) /
          3,
      );
      expect(n[0] * (c[0] - 1) + n[1] * (c[1] - 2) + n[2] * (c[2] - 3)).toBeGreaterThan(0);
    }
    expect(sniffFormat(out.data)).toBe('stl');
    const doc2 = SceneDoc.create({ empty: true });
    const res = importFile(doc2, 'stl', out.data, { name: 'models/Copy.stl' });
    const o2 = doc2.getObject(res.objects[0])!;
    expect(o2.name).toBe('Copy');
    const m2 = doc2.getMesh(o2.data!)!;
    expect(m2.positions.length / 3).toBe(8);
    expect(m2.faces).toHaveLength(12);
    expect(isClosedManifold(m2)).toBe(true);
    const a = worldBounds(doc, id);
    const b = worldBounds(doc2, o2.id);
    for (let k = 0; k < 3; k++) {
      expect(b.min[k]).toBeCloseTo(a.min[k], 5);
      expect(b.max[k]).toBeCloseTo(a.max[k], 5);
    }
  });
});

describe('export selection and modifiers', () => {
  registerModifier({
    type: 'TEST_IO_LIFT',
    label: 'Lift (test)',
    category: 'DEFORM',
    description: 'Moves every vertex up (test-only modifier).',
    schema: z.object({ offset: z.number().default(1) }),
    apply(mesh, p) {
      const m = cloneMesh(mesh);
      for (let i = 2; i < m.positions.length; i += 3) m.positions[i] += p.offset;
      return m;
    },
  });

  it('applies modifier stacks by default and skips objects hidden for render', () => {
    const doc = SceneDoc.create({ empty: true });
    const lifted = doc.addObject({
      type: 'MESH',
      name: 'Lifted',
      data: doc.addMesh('Lifted', createCube({ size: 2 })),
      modifiers: [
        {
          id: 'm1',
          name: 'Lift',
          type: 'TEST_IO_LIFT',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { offset: 5 },
        },
      ],
    });
    doc.addObject({
      type: 'MESH',
      name: 'Hidden',
      data: doc.addMesh('Hidden', createCube({ size: 10 })),
      hide_render: true,
    });
    const zRange = (data: Uint8Array) => {
      const d2 = SceneDoc.create({ empty: true });
      const id = importFile(d2, 'stl', data).objects[0];
      return worldBounds(d2, id);
    };
    const withMods = zRange(exportScene(doc, 'stl').data);
    expect([withMods.min[2], withMods.max[2]]).toEqual([4, 6].map((v) => expect.closeTo(v, 5)));
    expect(withMods.max[0]).toBeCloseTo(1, 5); // the hidden 10 m cube is not exported
    const base = zRange(exportScene(doc, 'stl', { applyModifiers: false }).data);
    expect([base.min[2], base.max[2]]).toEqual([-1, 1].map((v) => expect.closeTo(v, 5)));
    // explicit ids (or names) override render visibility
    const hidden = zRange(exportScene(doc, 'stl', { objectIds: ['Hidden'] }).data);
    expect(hidden.max[0]).toBeCloseTo(5, 5);
    void lifted;
  });
});

const PLY_ASCII = `ply
format ascii 1.0
comment hand-written fixture
element vertex 4
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 2
property list uchar int vertex_indices
end_header
0 0 0 255 0 0
1 0 0 0 255 0
1 1 0 0 0 128
0 1 0 255 255 255
3 0 1 2
3 0 2 3
`;

describe('PLY', () => {
  it('imports ASCII PLY with vertex colors (sRGB → linear)', () => {
    const doc = SceneDoc.create({ empty: true });
    expect(sniffFormat(enc(PLY_ASCII))).toBe('ply');
    const res = importFile(doc, 'ply', enc(PLY_ASCII), { name: 'Quad' });
    const o = doc.getObject(res.objects[0])!;
    expect(o.name).toBe('Quad');
    const m = doc.getMesh(o.data!)!;
    expect(m.positions).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(m.faces).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
    const c = m.colors!;
    expect(c.slice(0, 4)).toEqual([1, 0, 0, 1].map((v) => expect.closeTo(v, 5)));
    expect(c[10]).toBeCloseTo(0.2158, 3); // 128 in sRGB
    expect(c.slice(12, 16)).toEqual([1, 1, 1, 1].map((v) => expect.closeTo(v, 5)));
  });

  it('reads big-endian binary PLY', () => {
    const header =
      'ply\nformat binary_big_endian 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nelement face 1\nproperty list uchar uint vertex_index\nend_header\n';
    const body = new DataView(new ArrayBuffer(3 * 24 + 1 + 12));
    const pts = [0, 0, 0, 2, 0, 0, 0, 3, 0.5];
    pts.forEach((v, i) => body.setFloat64(i * 8, v, false));
    body.setUint8(72, 3);
    [0, 1, 2].forEach((v, i) => body.setUint32(73 + i * 4, v, false));
    const bytes = new Uint8Array(header.length + body.byteLength);
    bytes.set(enc(header));
    bytes.set(new Uint8Array(body.buffer), header.length);
    const doc = SceneDoc.create({ empty: true });
    const res = importFile(doc, 'ply', bytes);
    const m = doc.getMesh(doc.getObject(res.objects[0])!.data!)!;
    expect(m.positions).toEqual(pts);
    expect(m.faces).toEqual([[0, 1, 2]]);
  });

  it('round-trips binary PLY with UVs and vertex colors in world space', () => {
    const doc = SceneDoc.create({ empty: true });
    const grid = createGrid({ x_subdivisions: 3, y_subdivisions: 2, size: 2 });
    const nv = grid.positions.length / 3;
    grid.colors = [];
    for (let i = 0; i < nv; i++) grid.colors.push(i / nv, 0.5, 1 - i / nv, 1);
    const id = doc.addObject({
      type: 'MESH',
      name: 'Grid',
      data: doc.addMesh('Grid', grid),
      location: [0, 0, 2],
      rotation_euler: [0, 0, 0.5],
    });
    const out = exportScene(doc, 'ply');
    const text = new TextDecoder().decode(out.data.subarray(0, 400));
    expect(text).toContain('format binary_little_endian 1.0');
    expect(text).toContain('property uchar red');
    expect(text).toContain('property float s');
    const doc2 = SceneDoc.create({ empty: true });
    const res = importFile(doc2, 'ply', out.data);
    const m2 = doc2.getMesh(doc2.getObject(res.objects[0])!.data!)!;
    expect(m2.faces).toHaveLength(grid.faces.length);
    expect(m2.uvs).not.toBeNull();
    // every corner keeps its position, UV and color
    const w = doc.worldMatrix(id);
    for (let f = 0; f < grid.faces.length; f++) {
      for (let i = 0; i < grid.faces[f].length; i++) {
        const v = grid.faces[f][i];
        const p = transformPoint3(w, [
          grid.positions[v * 3],
          grid.positions[v * 3 + 1],
          grid.positions[v * 3 + 2],
        ]);
        const v2 = m2.faces[f][i];
        for (let k = 0; k < 3; k++) expect(m2.positions[v2 * 3 + k]).toBeCloseTo(p[k], 5);
        expect(m2.uvs![f][i * 2]).toBeCloseTo(grid.uvs![f][i * 2], 5);
        expect(m2.uvs![f][i * 2 + 1]).toBeCloseTo(grid.uvs![f][i * 2 + 1], 5);
        for (let k = 0; k < 4; k++)
          expect(Math.abs(m2.colors![v2 * 4 + k] - grid.colors[v * 4 + k])).toBeLessThan(0.01);
      }
    }
  });

  it('keeps vertex counts when there are no UV seams', () => {
    const doc = SceneDoc.create({ empty: true });
    const cube = createCube();
    cube.uvs = null;
    doc.addObject({ type: 'MESH', name: 'Cube', data: doc.addMesh('Cube', cube) });
    const doc2 = SceneDoc.create({ empty: true });
    const res = importFile(doc2, 'ply', exportScene(doc, 'ply').data);
    const m2 = doc2.getMesh(doc2.getObject(res.objects[0])!.data!)!;
    expect(m2.positions.length / 3).toBe(8);
    expect(m2.faces.map((f) => f.length)).toEqual(cube.faces.map((f) => f.length));
    expect(m2.uvs).toBeNull();
  });
});
