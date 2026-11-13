import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import type { RunResult } from '../src/operators/registry';
import { encodePNG } from '../src/render';
import { base64Encode } from '../src/util/json';
import { FrameState } from '../src/eval/frame-state';
import { createCube } from '../src/mesh/primitives';
import {
  ANY_SIZE,
  CATEGORY_SIZES,
  insertStoreFiles,
  normalizeFilePath,
  normalizedScale,
  sizeRangeOf,
  type StoreFileEntry,
} from '../src/store';
import type { Vec3 } from '../src/math/types';

/*
 * store.insert_files / insertStoreFiles: a downloaded model's files (here a .gltf with its .bin
 * buffer and a .png texture in a sub-folder, and an OBJ with its .mtl) imported under an EMPTY root,
 * sized, centred on its base, put on the ground, turned, attributed, selected, as one undo step.
 */

const ENTRY: StoreFileEntry = {
  id: 'polyhaven:wooden_crate',
  name: 'Wooden crate',
  provider: 'polyhaven',
  license: {
    spdx: 'CC-BY-4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Crate by Jane',
  },
  author: 'Jane Doe',
  source_url: 'https://example.org/models/wooden_crate',
};

/**
 * A glTF box 1 wide (X), 2 tall (glTF Y) and 0.5 deep (glTF Z), its node moved to (3, 5, −2) glTF
 * (editor (3, 2, 5)): JSON + external .bin buffer + .png texture under textures/.
 */
function boxFiles(): { gltf: string; bin: Uint8Array; png: Uint8Array } {
  const [hx, hy, hz] = [0.5, 1, 0.25];
  const P: number[] = [];
  for (let i = 0; i < 8; i++) P.push(i & 4 ? hx : -hx, i & 2 ? hy : -hy, i & 1 ? hz : -hz);
  const UV: number[] = [];
  for (let i = 0; i < 8; i++) UV.push(i & 4 ? 1 : 0, i & 2 ? 1 : 0);
  // corner index = xi*4 + yi*2 + zi; quads counter-clockwise seen from outside
  const quads = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  const idx: number[] = [];
  for (const [a, b, c, d] of quads) idx.push(a, b, c, a, c, d);
  const bin = new Uint8Array(96 + 64 + 72);
  new Float32Array(bin.buffer, 0, 24).set(P);
  new Float32Array(bin.buffer, 96, 16).set(UV);
  new Uint16Array(bin.buffer, 160, 36).set(idx);
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'CrateMesh', translation: [3, 5, -2] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'CrateWood', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: 'textures/wood.png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-hx, -hy, -hz], max: [hx, hy, hz] },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 96 },
      { buffer: 0, byteOffset: 96, byteLength: 64 },
      { buffer: 0, byteOffset: 160, byteLength: 72 },
    ],
    buffers: [{ uri: 'box.bin', byteLength: bin.byteLength }],
  };
  const pixels = new Uint8ClampedArray(4 * 4);
  for (let i = 0; i < 4; i++) pixels.set([140 + i * 20, 90, 40, 255], i * 4);
  const png = encodePNG({ width: 2, height: 2, data: pixels });
  return { gltf: JSON.stringify(gltf), bin, png };
}

const b64 = (s: string | Uint8Array) => base64Encode(typeof s === 'string' ? new TextEncoder().encode(s) : s);

/**
 * A one-file glTF of a box `w` wide, `h` tall and `d` deep in the file's units (glTF Y up), its
 * buffer embedded, and `extra` nodes (cameras, lights) beside it.
 */
function boxGltf(
  w: number,
  h: number,
  d: number,
  extra: { nodes?: object[]; roots?: number[]; cameras?: object[]; lights?: object[]; children?: number[] } = {},
): string {
  const P: number[] = [];
  for (let i = 0; i < 8; i++) P.push(i & 4 ? w / 2 : -w / 2, i & 2 ? h : 0, i & 1 ? d / 2 : -d / 2);
  const quads = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  const idx: number[] = [];
  for (const [a, b, c, e] of quads) idx.push(a, b, c, a, c, e);
  const bin = new Uint8Array(96 + 72);
  new Float32Array(bin.buffer, 0, 24).set(P);
  new Uint16Array(bin.buffer, 96, 36).set(idx);
  const extraNodes = extra.nodes ?? [];
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: extra.roots ?? [0, ...extraNodes.map((_, i) => i + 1)] }],
    nodes: [{ mesh: 0, name: 'Body', ...(extra.children ? { children: extra.children } : {}) }, ...extraNodes],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    ...(extra.cameras ? { cameras: extra.cameras } : {}),
    ...(extra.lights
      ? {
          extensionsUsed: ['KHR_lights_punctual'],
          extensions: { KHR_lights_punctual: { lights: extra.lights } },
        }
      : {}),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 96 },
      { buffer: 0, byteOffset: 96, byteLength: 72 },
    ],
    buffers: [{ uri: `data:application/octet-stream;base64,${base64Encode(bin)}`, byteLength: bin.byteLength }],
  });
}

/** A store entry of no known size: a provider (Sketchfab, Poly Pizza, Khronos) that gives none. */
const unsized = (name: string, category?: StoreFileEntry['category']): StoreFileEntry => ({
  id: `example:${name.toLowerCase()}`,
  name,
  provider: 'example',
  license: { spdx: 'CC-BY-4.0', url: null, attribution: null },
  author: null,
  source_url: null,
  ...(category ? { category } : {}),
});

function gltfFiles(prefix = 'crate/'): Record<string, string> {
  const f = boxFiles();
  return {
    [`${prefix}scene.gltf`]: b64(f.gltf),
    [`${prefix}box.bin`]: b64(f.bin),
    [`${prefix}textures/wood.png`]: b64(f.png),
  };
}

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push({ level, message }),
  };
  return {
    doc,
    reg,
    ctx,
    reports,
    run: (id: string, p: unknown) => reg.run(ctx, id, p) as RunResult<any> & { result: any },
  };
}

/** World bounds of the mesh objects among `ids` (evaluated at frame 1). */
function worldBounds(doc: SceneDoc, ids: readonly string[]): { min: Vec3; max: Vec3; size: Vec3 } {
  const fs = new FrameState(doc, 1);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) {
    const o = doc.getObject(id)!;
    if (o.type !== 'MESH') continue;
    const m = fs.world(id)!;
    const P = doc.getMesh(o.data!)!.positions;
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const w = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
        min[k] = Math.min(min[k], w);
        max[k] = Math.max(max[k], w);
      }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

const close = (v: readonly number[], want: readonly number[], digits = 4) =>
  expect([...v]).toEqual(want.map((w) => expect.closeTo(w, digits)));

describe('store.insert_files', () => {
  it('imports a multi-file glTF under an EMPTY root on its base centre, attributed and selected', () => {
    const t = setup();
    const res = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
      location: [1, 2, 0],
    });
    expect(res.ok, res.error).toBe(true);
    const r = res.result;
    const root = t.doc.getObject(r.root)!;
    expect(root.type).toBe('EMPTY');
    expect(root.name).toBe('Wooden crate');
    expect(r.objects[0]).toBe(r.root);
    expect(r.objects.length).toBeGreaterThan(1);
    expect(r.names[0]).toBe('Wooden crate');
    close(root.location, [1, 2, 0]);
    expect(root.custom_props).toEqual({
      store_id: 'polyhaven:wooden_crate',
      store_source: 'polyhaven',
      license: 'CC-BY-4.0',
      author: 'Jane Doe',
      source_url: 'https://example.org/models/wooden_crate',
    });
    // every imported object hangs from the root
    for (const id of r.objects.slice(1)) expect(t.doc.isAncestor(r.root, id)).toBe(true);
    // the box keeps its size (glTF Y up → Z up), its base centre on the location
    const b = worldBounds(t.doc, r.objects);
    close(b.size, [1, 0.5, 2]);
    close([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]], [1, 2, 0]);
    close(r.dimensions_m, [1, 0.5, 2]);
    // the texture and buffer were found next to the main file (no missing-file warnings)
    expect(r.warnings).toEqual([]);
    const mesh = t.doc.getObject(r.objects.find((id: string) => t.doc.getObject(id)!.type === 'MESH'))!;
    const mat = t.doc.getMaterial(mesh.material_slots[0]!)!;
    expect(mat.textures.base_color?.image).toBeTruthy();
    // the root is selected and active
    expect(t.ctx.state.selectedIds).toEqual([r.root]);
    expect(t.ctx.state.activeId).toBe(r.root);
  });

  it('sizes to height_m keeping proportions, to several sizes per axis, and to the provider size', () => {
    const t = setup();
    const height = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
      height_m: 1,
    }).result;
    close(worldBounds(t.doc, height.objects).size, [0.5, 0.25, 1]);
    close(height.dimensions_m, [0.5, 0.25, 1]);

    const both = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
      width_m: 3,
      height_m: 2,
    }).result;
    // width ×3, height ×1, depth by the geometric mean of the two (√3)
    close(worldBounds(t.doc, both.objects).size, [3, 0.5 * Math.sqrt(3), 2]);

    const provider = t.run('store.insert_files', {
      entry: { ...ENTRY, dimensions_m: [2, 1, 4] },
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
    }).result;
    close(worldBounds(t.doc, provider.objects).size, [2, 1, 4]);
    // a size asked for wins over the provider's
    const asked = t.run('store.insert_files', {
      entry: { ...ENTRY, dimensions_m: [2, 1, 4] },
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
      depth_m: 0.25,
    }).result;
    close(worldBounds(t.doc, asked.objects).size, [0.5, 0.25, 1]);
  });

  it('turns about Z by rotation_deg around the base centre and names the root', () => {
    const t = setup();
    const r = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: gltfFiles(''),
      main: 'scene.gltf',
      location: [-2, 0, 0.5],
      rotation_deg: 90,
      name: 'Crate A',
    }).result;
    expect(t.doc.getObject(r.root)!.name).toBe('Crate A');
    const b = worldBounds(t.doc, r.objects);
    close(b.size, [0.5, 1, 2]);
    close([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]], [-2, 0, 0.5]);
    close(t.doc.getObject(r.root)!.rotation_euler, [0, 0, Math.PI / 2], 6);
  });

  it('is one undo step', () => {
    const t = setup();
    const um = new Y.UndoManager(t.doc.sharedTypes(), {
      trackedOrigins: new Set([t.doc.origin]),
      captureTimeout: 0,
    });
    const res = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
    });
    expect(res.ok).toBe(true);
    expect(t.doc.listObjects().length).toBe(res.result.objects.length);
    expect(t.doc.listMaterials().length).toBeGreaterThan(0);
    um.undo();
    expect(t.doc.listObjects()).toHaveLength(0);
    expect(t.doc.listMaterials()).toHaveLength(0);
    expect(t.doc.listImages()).toHaveLength(0);
  });

  it('imports an OBJ with its material library', () => {
    const t = setup();
    const obj = [
      'mtllib chair.mtl',
      'o Seat',
      'v -0.2 0 -0.2',
      'v 0.2 0 -0.2',
      'v 0.2 0 0.2',
      'v -0.2 0 0.2',
      'v -0.2 0.45 -0.2',
      'v 0.2 0.45 -0.2',
      'v 0.2 0.45 0.2',
      'v -0.2 0.45 0.2',
      'usemtl Red',
      'f 1 2 3 4',
      'f 5 8 7 6',
      'f 1 5 6 2',
      'f 2 6 7 3',
      'f 3 7 8 4',
      'f 4 8 5 1',
      '',
    ].join('\n');
    const mtl = 'newmtl Red\nKd 0.8 0.1 0.1\n';
    const r = t.run('store.insert_files', {
      entry: {
        ...ENTRY,
        id: 'catalog:chair',
        name: 'Stool',
        provider: 'catalog',
        license: { spdx: 'CC0-1.0', url: null, attribution: null },
        author: null,
        source_url: null,
      },
      format: 'obj',
      files: { 'stool/chair.obj': b64(obj), 'stool/chair.mtl': b64(mtl) },
      main: 'stool/chair.obj',
      location: [0, 0, 0],
    });
    expect(r.ok, r.error).toBe(true);
    const root = t.doc.getObject(r.result.root)!;
    // no author and no page: only what is known is recorded
    expect(root.custom_props).toEqual({
      store_id: 'catalog:chair',
      store_source: 'catalog',
      license: 'CC0-1.0',
    });
    const b = worldBounds(t.doc, r.result.objects);
    close(b.size, [0.4, 0.4, 0.45]);
    close(b.min, [-0.2, -0.2, 0]);
    const mesh = t.doc.getObject(r.result.objects[1])!;
    const mat = t.doc.getMaterial(mesh.material_slots[0]!)!;
    expect(mat.base_color[0]).toBeGreaterThan(mat.base_color[1]);
  });

  it('accepts a .gltf that is really a GLB, and refuses bad input before changing anything', () => {
    const t = setup();
    // a GLB exported from a scene with one box, passed as format 'gltf'
    const src = setup();
    src.doc.addObject({ type: 'MESH', name: 'Box', data: src.doc.addMesh('Box', createCube({ size: 1 })) });
    const glb = src.run('export_scene.gltf', { export_format: 'GLB' }).result.data_base64 as string;
    const ok = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: { 'm.glb': glb },
      main: 'm.glb',
    });
    expect(ok.ok, ok.error).toBe(true);
    expect(t.doc.getObject(ok.result.root)!.type).toBe('EMPTY');

    const before = t.doc.listObjects().length;
    const missing = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'glb',
      files: { 'a.glb': glb },
      main: 'b.glb',
    });
    expect(missing).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(missing.error).toMatch(/main file 'b\.glb' is not among the files \(a\.glb\)/);
    const notGltf = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'glb',
      files: { 'a.glb': b64('hello world, not a model') },
      main: 'a.glb',
    });
    expect(notGltf).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    const empty = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'obj',
      files: { 'a.obj': '' },
      main: 'a.obj',
    });
    expect(empty).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    const broken = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: {
        'a.gltf': b64(
          '{"asset": {"version": "2.0"}, "meshes": [{"primitives": [{"attributes": {"POSITION": 7}}]}], "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}]}',
        ),
      },
      main: 'a.gltf',
    });
    expect(broken.ok).toBe(false);
    expect(t.doc.listObjects().length).toBe(before);
  });

  it('warns about missing companion files and implausible sizes, and needs Object Mode', () => {
    const t = setup();
    const f = gltfFiles();
    delete f['crate/textures/wood.png'];
    const r = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: f,
      main: 'crate/scene.gltf',
    });
    expect(r.ok).toBe(true);
    expect(r.result.warnings.join('\n')).toMatch(/wood\.png/);
    expect(t.reports.some((x) => x.level === 'WARNING' && /wood\.png/.test(x.message))).toBe(true);
    // a provider giving a size no crate has: used, and reported (a crate is a prop: 0.02–3 m)
    const huge = t.run('store.insert_files', {
      entry: { ...ENTRY, dimensions_m: [1000, 500, 2000] },
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
    });
    expect(huge.result.warnings).toEqual([
      'The model is 2000 m across at the size its provider gives (usual for props: 0.02–3 m). ' +
        'Pass height_m, width_m or depth_m to give it its real size.',
    ]);
    close(huge.result.dimensions_m, [1000, 500, 2000], 2);
    t.ctx.state.mode = 'EDIT';
    expect(
      t.run('store.insert_files', {
        entry: ENTRY,
        format: 'gltf',
        files: gltfFiles(),
        main: 'crate/scene.gltf',
      }),
    ).toMatchObject({ ok: false, code: 'POLL_FAILED' });
  });

  it('normalizes a model authored in centimetres when no size is given (by its category)', () => {
    const t = setup();
    // a 150 × 40 × 80 fox in centimetres, as Khronos and Sketchfab send them: no size
    const files = { 'fox.gltf': b64(boxGltf(150, 80, 40)) };
    const fox = t.run('store.insert_files', {
      entry: unsized('Fox', 'animals'),
      format: 'gltf',
      files,
      main: 'fox.gltf',
      location: [0, 0, 0],
    });
    expect(fox.ok, fox.error).toBe(true);
    close(fox.result.dimensions_m, [1.5, 0.4, 0.8]);
    close(worldBounds(t.doc, fox.result.objects).size, [1.5, 0.4, 0.8]);
    expect(fox.result.warnings).toEqual([
      'The model is 150 m across as imported (usual for animals: 0.05–8 m): read as centimetres, ' +
        'scaled ×0.01 to 1.5 m. Pass height_m, width_m or depth_m to give it its real size.',
    ]);
    expect(t.reports.filter((r) => r.level === 'WARNING').map((r) => r.message)).toEqual(fox.result.warnings);
    // no category: the built-in model its name is tells its kind (an armchair is furniture)
    const chair = t.run('store.insert_files', { entry: unsized('Armchair'), format: 'gltf', files, main: 'fox.gltf' });
    close(chair.result.dimensions_m, [1.5, 0.4, 0.8]);
    expect(chair.result.warnings[0]).toMatch(/\(usual for furniture: 0\.2–4 m\): read as centimetres/);
    // a size asked for wins, without a warning
    const asked = t.run('store.insert_files', {
      entry: unsized('Fox', 'animals'),
      format: 'gltf',
      files,
      main: 'fox.gltf',
      height_m: 0.5,
    });
    close(asked.result.dimensions_m, [150 * (0.5 / 80), 40 * (0.5 / 80), 0.5]);
    expect(asked.result.warnings).toEqual([]);
  });

  it('scales a model no unit explains to its kind’s usual size, and keeps one nearly right', () => {
    const t = setup();
    const insert = (entry: StoreFileEntry, gltf: string) =>
      t.run('store.insert_files', { entry, format: 'gltf', files: { 'm.gltf': b64(gltf) }, main: 'm.gltf' })
        .result as { dimensions_m: number[]; warnings: string[] };
    // 5000 units for a prop (0.02–3 m): no centimetres, inches or millimetres fit, 0.4 m (its usual)
    const lamp = insert(unsized('Lamp', 'props'), boxGltf(1000, 5000, 1000));
    close(lamp.dimensions_m, [0.08, 0.08, 0.4]);
    expect(lamp.warnings).toEqual([
      'The model is 5000 m across as imported (usual for props: 0.02–3 m): scaled ×0.00008 to 0.4 m, ' +
        'the usual size. Pass height_m, width_m or depth_m to give it its real size.',
    ]);
    // far too small for furniture: its usual 1 m
    const tiny = insert(unsized('Cupboard', 'furniture'), boxGltf(0.001, 0.002, 0.001));
    close(tiny.dimensions_m, [0.5, 0.5, 1]);
    expect(tiny.warnings[0]).toMatch(/^The model is 0\.002 m across as imported .*scaled ×500 to 1 m/);
    // less than ten times off: kept, with a warning (a 155 m model of no known kind; 25 m is fine)
    const big = insert(unsized('Thing'), boxGltf(2, 155, 2));
    close(big.dimensions_m, [2, 2, 155]);
    expect(big.warnings).toEqual([
      'The model is 155 m across as imported (usual for store models: 0.01–100 m); kept at that size. ' +
        'Pass height_m, width_m or depth_m to give it its real size.',
    ]);
    expect(insert(unsized('Thing'), boxGltf(2, 25, 2)).warnings).toEqual([]);
    // a 26 m prop (the Khronos lantern) is less than ten times off: kept, reported
    expect(insert(unsized('Lantern', 'props'), boxGltf(15, 26, 5)).warnings[0]).toMatch(
      /^The model is 26 m across as imported \(usual for props: 0\.02–3 m\); kept at that size/,
    );
    // a believable size: as it is, no warning
    const ok = insert(unsized('Box', 'props'), boxGltf(0.4, 0.3, 0.4));
    close(ok.dimensions_m, [0.4, 0.4, 0.3]);
    expect(ok.warnings).toEqual([]);
  });

  it('leaves out the cameras and lights a file brings and keeps the scene camera', () => {
    const t = setup();
    const gltf = boxGltf(0.4, 0.5, 0.4, {
      nodes: [
        { camera: 0, name: 'ShowcaseCam', translation: [0, 1, 5], children: [3] },
        { name: 'Lamp', translation: [0, 3, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
        // a mesh hanging from the camera stays, where it was
        { mesh: 0, name: 'Badge', translation: [0, -1, -5] },
      ],
      roots: [0, 1, 2],
      cameras: [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.1, aspectRatio: 1.5 } }],
      lights: [{ type: 'point', intensity: 500, color: [1, 1, 1] }],
    });
    const before = { cameras: t.doc.listCameras().length, lights: t.doc.listLights().length };
    expect(t.doc.getScene().camera).toBeNull();
    const r = t.run('store.insert_files', {
      entry: unsized('Prop', 'props'),
      format: 'gltf',
      files: { 'prop.gltf': b64(gltf) },
      main: 'prop.gltf',
      location: [0, 0, 0],
    });
    expect(r.ok, r.error).toBe(true);
    // no camera became the scene camera, nothing but the model was added
    expect(t.doc.getScene().camera).toBeNull();
    const types = r.result.objects.map((id: string) => t.doc.getObject(id)!.type);
    expect(types.filter((x: string) => x === 'CAMERA' || x === 'LIGHT')).toEqual([]);
    expect(t.doc.listObjects().filter((o) => o.type === 'CAMERA' || o.type === 'LIGHT')).toEqual([]);
    expect(t.doc.listCameras()).toHaveLength(before.cameras);
    expect(t.doc.listLights()).toHaveLength(before.lights);
    expect(r.result.names).toEqual(expect.arrayContaining(['Body', 'Badge']));
    for (const id of r.result.objects.slice(1)) expect(t.doc.isAncestor(r.result.root, id)).toBe(true);
    expect(r.result.warnings).toEqual([
      'Left out what the file brings besides the model: ShowcaseCam (camera), Lamp (light) (the scene keeps its own camera and lights)',
    ]);
    // a scene camera of its own is kept
    const cam = t.doc.addObject({ type: 'CAMERA', name: 'Shot 1', data: t.doc.addCamera({ name: 'Shot 1' }) });
    t.doc.updateScene({ camera: cam });
    expect(
      t.run('store.insert_files', {
        entry: unsized('Prop', 'props'),
        format: 'gltf',
        files: { 'prop.gltf': b64(gltf) },
        main: 'prop.gltf',
      }).ok,
    ).toBe(true);
    expect(t.doc.getScene().camera).toBe(cam);
  });

  it('keeps animated location keys on the moved base', () => {
    // the box animated along glTF X: its keys move with the recentring like its rest location
    const t = setup();
    const f = boxFiles();
    const json = JSON.parse(f.gltf);
    const times = new Float32Array([0, 1]);
    const values = new Float32Array([3, 5, -2, 4, 5, -2]);
    const bin = new Uint8Array(f.bin.byteLength + 8 + 24);
    bin.set(f.bin);
    new Float32Array(bin.buffer, f.bin.byteLength, 2).set(times);
    new Float32Array(bin.buffer, f.bin.byteLength + 8, 6).set(values);
    json.buffers[0].byteLength = bin.byteLength;
    json.bufferViews.push(
      { buffer: 0, byteOffset: f.bin.byteLength, byteLength: 8 },
      { buffer: 0, byteOffset: f.bin.byteLength + 8, byteLength: 24 },
    );
    json.accessors.push(
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
    );
    json.animations = [
      {
        samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
      },
    ];
    const r = t.run('store.insert_files', {
      entry: ENTRY,
      format: 'gltf',
      files: {
        'scene.gltf': b64(JSON.stringify(json)),
        'box.bin': b64(bin),
        'textures/wood.png': b64(f.png),
      },
      main: 'scene.gltf',
      location: [0, 0, 0],
    });
    expect(r.ok, r.error).toBe(true);
    const b = worldBounds(t.doc, r.result.objects);
    close([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]], [0, 0, 0]);
  });
});

describe('insertStoreFiles', () => {
  it('normalizes file paths', () => {
    expect(normalizeFilePath('./a\\b/c.png')).toBe('a/b/c.png');
    expect(normalizeFilePath('/x.glb')).toBe('x.glb');
  });

  it('knows the sizes each kind of model is believable at', () => {
    expect(sizeRangeOf({ name: 'Anything', category: 'animals' })).toEqual({
      range: CATEGORY_SIZES.animals,
      kind: 'animals',
    });
    expect(sizeRangeOf({ name: 'Sofa' }).kind).toBe('furniture');
    expect(sizeRangeOf({ name: 'Couch' }).kind).toBe('furniture');
    expect(sizeRangeOf({ name: 'Zorblax 3000' })).toEqual({ range: ANY_SIZE, kind: 'store models' });
    for (const r of Object.values(CATEGORY_SIZES)) {
      expect(r.min).toBeLessThan(r.typical);
      expect(r.typical).toBeLessThan(r.max);
    }
    // inches when centimetres fall short of the range and inches are nearer the usual size
    expect(normalizedScale(150, { min: 2, max: 10, typical: 4 }, 'x').scale).toBe(0.0254);
    expect(normalizedScale(1, CATEGORY_SIZES.furniture, 'furniture')).toEqual({ scale: 1, warning: null });
  });

  it('can be called without an operator (origin at the location, default frame)', () => {
    const doc = SceneDoc.create({ empty: true });
    const r = insertStoreFiles(doc, {
      entry: ENTRY,
      format: 'gltf',
      files: gltfFiles(),
      main: 'crate/scene.gltf',
    });
    expect(doc.getObject(r.root)!.location).toEqual([0, 0, 0]);
    close(r.dimensions_m, [1, 0.5, 2]);
  });
});
