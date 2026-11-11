import { afterEach, describe, expect, it } from 'vitest';
import {
  DATABLOCK_ADD_BYTES,
  DATABLOCK_BASE_JSON_CHARS,
  DATABLOCK_STORED_BYTES,
  EVALUATED_BONE_BYTES,
  datablockExtraJsonChars,
  extraJsonChars,
  EVALUATED_BYTES_PER_JSON_CHAR,
  EVALUATED_OBJECT_BYTES,
  IMPORT_BYTES_PER_FILE_BYTE,
  KEYFRAME_STORED_BYTES,
  MAKE_REAL_MAX_OBJECTS,
  OBJECT_ADD_BYTES,
  OBJECT_JSON_ADD_BYTES,
  OBJECT_JSON_STORED_BYTES,
  OBJECT_BASE_JSON_CHARS,
  OBJECT_STORED_BYTES,
  OPERATOR_FIXED_BYTES,
  SAVE_BYTES_PER_KEPT_BYTE,
  SHAPE_KEY_STORED_BYTES_PER_VERTEX,
  base64Reader,
  bytesReader,
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  importEstimate,
  looseParts,
  materialParts,
  newObjectsBytes,
  operatorMemoryRefusal,
  projectObjects,
  projectStoredBytes,
  saveBytes,
  sceneEvaluationBytes,
  setOperatorMemoryCheck,
  storedMeshBytes,
  type OperatorContext,
  type OperatorMemoryRequest,
} from '../src/operators';
import {
  createCube,
  createGrid,
  createMesh,
  createTorus,
  decodedMeshBytes,
  selectAllElements,
  setMeshMemoryCheck,
  type MeshData,
} from '../src/mesh';
import {
  SceneEvaluator,
  bevelCount,
  estimateModifier,
  meshSize,
  setGeometryMemoryCheck,
  type BevelSizeParams,
} from '../src/eval';
import { gltfImportSize, objObjects, plyImportSize, readGltfJson } from '../src/io/import-size';
import { instanceBound } from '../src/operators/memory-instances';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ModifierData } from '../src/doc/types';
import { base64Encode } from '../src/util/json';

/*
 * Every object is a Yjs map of about 10 KB in the server's process, whatever geometry it has: an
 * operator that adds 200,000 objects (Separate by loose parts of 200,000 quads, a glTF file of
 * 200,000 nodes) took the server's heap down while its estimate counted only faces. The estimates
 * count the objects and datablocks every operator and import adds; glTF imports count the meshes
 * the importer decodes from the file's JSON (every glTF mesh one of its own, also where meshes
 * share accessors), PLY imports the counts their header declares; a Bevel limited by angle is
 * counted on its input before it runs.
 */

afterEach(() => {
  setOperatorMemoryCheck(null);
  setGeometryMemoryCheck(null);
  setMeshMemoryCheck(null);
});

const MB = 1024 * 1024;

function scene() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx: OperatorContext = {
    doc,
    state,
    origin: { type: 'test' },
    source: 'test',
    report: () => undefined,
  };
  const run = (id: string, params: Record<string, unknown> = {}) => {
    const r = reg.run(ctx, id, params);
    expect(r.ok, `${id}: ${r.error}`).toBe(true);
    return r;
  };
  const estimate = (id: string, params: Record<string, unknown> = {}) =>
    estimateOperator(id, ctx, reg.parseParams(id, params));
  return { doc, reg, state, ctx, run, estimate };
}
type Scene = ReturnType<typeof scene>;

/** `parts` quads in a row, none touching another. */
function looseQuads(parts: number): MeshData {
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let i = 0; i < parts; i++) {
    positions.push(2 * i, 0, 0, 2 * i + 1, 0, 0, 2 * i + 1, 1, 0, 2 * i, 1, 0);
    faces.push([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3]);
  }
  return createMesh({ positions, faces });
}

/** A mesh object, active and selected; in Edit Mode with everything selected with `edit`. */
function meshObject(s: Scene, mesh: MeshData, edit = false): string {
  const data = s.doc.addMesh('Mesh', mesh);
  const id = s.doc.addObject({ type: 'MESH', name: 'Mesh', data });
  s.state.selectedIds = [id];
  s.state.activeId = id;
  if (edit) {
    s.state.mode = 'EDIT';
    s.state.meshSelection = selectAllElements(s.doc.getMesh(data)!);
  }
  return id;
}

/**
 * A GLB (or a .gltf with its buffer embedded) of `meshes` glTF meshes that all use the accessors of
 * one grid of n × n quads (positions and triangle indices), one node each; `nodes` more nodes use
 * the first mesh; `targets` morph targets on the primitive.
 */
function sharedGltf(
  n: number,
  meshes: number,
  opts: { nodes?: number; targets?: number; gltf?: boolean } = {},
) {
  const V = (n + 1) * (n + 1);
  const T = 2 * n * n;
  const pos = new Float32Array(3 * V);
  for (let y = 0, i = 0; y <= n; y++) for (let x = 0; x <= n; x++, i++) pos.set([x / n, 0, y / n], 3 * i);
  const idx = new Uint32Array(3 * T);
  for (let y = 0, t = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      idx.set([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1], 6 * t++);
    }
  const targets = opts.targets ?? 0;
  const parts: Uint8Array[] = [new Uint8Array(pos.buffer), new Uint8Array(idx.buffer)];
  for (let k = 0; k < targets; k++) parts.push(new Uint8Array(new Float32Array(3 * V).fill(0.01).buffer));
  const bin = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  const views: object[] = [];
  let off = 0;
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength });
    bin.set(p, off);
    off += p.byteLength;
  }
  const accessors: object[] = [
    { bufferView: 0, componentType: 5126, count: V, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] },
    { bufferView: 1, componentType: 5125, count: 3 * T, type: 'SCALAR' },
    ...Array.from({ length: targets }, (_, k) => ({
      bufferView: 2 + k,
      componentType: 5126,
      count: V,
      type: 'VEC3',
      min: [0.01, 0.01, 0.01],
      max: [0.01, 0.01, 0.01],
    })),
  ];
  const prim: Record<string, unknown> = { attributes: { POSITION: 0 }, indices: 1 };
  if (targets) prim.targets = Array.from({ length: targets }, (_, k) => ({ POSITION: 2 + k }));
  const extra = opts.nodes ?? 0;
  const nodes = [
    ...Array.from({ length: meshes }, (_, i) => ({ mesh: i, translation: [1.5 * i, 0, 0] })),
    ...Array.from({ length: extra }, (_, i) => ({ mesh: 0, translation: [0, 0, 1.5 * (i + 1)] })),
  ];
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: Array.from({ length: meshes }, () => ({ primitives: [prim] })),
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.byteLength }],
  };
  if (opts.gltf) {
    (json.buffers as { uri?: string }[])[0].uri = `data:application/octet-stream;base64,${base64Encode(bin)}`;
    return new TextEncoder().encode(JSON.stringify(json));
  }
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const file = new Uint8Array(12 + 8 + jsonLength + 8 + bin.byteLength);
  const dv = new DataView(file.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, file.byteLength, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  file.fill(0x20, 20, 20 + jsonLength);
  file.set(text, 20);
  dv.setUint32(20 + jsonLength, bin.byteLength, true);
  dv.setUint32(24 + jsonLength, 0x004e4942, true);
  file.set(bin, 28 + jsonLength);
  return file;
}

/**
 * A .gltf of `nodes` nodes of one triangle mesh, each with its translation, rotation and scale
 * animated over `keys` keys (9 keyframes per key and node once imported).
 */
function animatedGltf(nodes: number, keys: number): Uint8Array {
  const parts = [
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Float32Array(keys).map((_, i) => i / 24),
    new Float32Array(3 * keys),
    new Float32Array(4 * keys).map((_, i) => (i % 4 === 3 ? 1 : 0)),
    new Float32Array(3 * keys).fill(1),
  ];
  const bin = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  const views: object[] = [];
  let off = 0;
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength });
    bin.set(new Uint8Array(p.buffer), off);
    off += p.byteLength;
  }
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: Array.from({ length: nodes }, (_, i) => i) }],
    nodes: Array.from({ length: nodes }, (_, i) => ({ mesh: 0, translation: [i, 0, 0] })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: keys, type: 'SCALAR', min: [0], max: [(keys - 1) / 24] },
      { bufferView: 2, componentType: 5126, count: keys, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: keys, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: keys, type: 'VEC3' },
    ],
    bufferViews: views,
    animations: [
      {
        samplers: [
          { input: 1, output: 2 },
          { input: 1, output: 3 },
          { input: 1, output: 4 },
        ],
        channels: Array.from({ length: nodes }, (_, i) => [
          { sampler: 0, target: { node: i, path: 'translation' } },
          { sampler: 1, target: { node: i, path: 'rotation' } },
          { sampler: 2, target: { node: i, path: 'scale' } },
        ]).flat(),
      },
    ],
    buffers: [
      { byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${base64Encode(bin)}` },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

/** An import operator's params for `file`. */
const fileParams = (file: Uint8Array) => ({ data_base64: base64Encode(file) });

describe('objects that operators add', () => {
  it('counts the parts Separate makes cheaply: loose parts with a union-find, material indices', () => {
    expect(looseParts(looseQuads(7))).toBe(7);
    expect(looseParts(createGrid({ x_subdivisions: 30, y_subdivisions: 30 }))).toBe(1);
    // two quads sharing an edge, a loose edge between two lone vertices, one lone vertex
    const mesh = createMesh({
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0, 5, 5, 5, 6, 6, 6, 7, 7, 7],
      faces: [
        [0, 1, 2, 3],
        [1, 4, 5, 2],
      ],
    });
    mesh.looseEdges = [6, 7];
    expect(looseParts(mesh)).toBe(3);
    const grid = createGrid({ x_subdivisions: 4, y_subdivisions: 4 });
    grid.faceMaterials = grid.faces.map((_, f) => (f % 3) * 2);
    expect(materialParts(grid)).toBe(3);
    expect(materialParts(createGrid({ x_subdivisions: 2, y_subdivisions: 2 }))).toBe(1);
  });

  // each case: the scene before, the operator and its parameters, and the objects it adds (and
  // whether the estimate is an upper bound: an OBJ file's objects by its o and g lines, one more for
  // geometry before the first)
  const cases: [string, (s: Scene) => [string, Record<string, unknown>], number, boolean?][] = [
    [
      'mesh.separate LOOSE',
      (s) => (meshObject(s, looseQuads(12), true), ['mesh.separate', { type: 'LOOSE' }]),
      11,
    ],
    [
      'mesh.separate MATERIAL',
      (s) => {
        const grid = createGrid({ x_subdivisions: 6, y_subdivisions: 6 });
        grid.faceMaterials = grid.faces.map((_, f) => f % 4);
        meshObject(s, grid, true);
        return ['mesh.separate', { type: 'MATERIAL' }];
      },
      3,
    ],
    [
      'mesh.separate SELECTED',
      (s) => (
        meshObject(s, createGrid({ x_subdivisions: 4, y_subdivisions: 4 }), true),
        ['mesh.separate', {}]
      ),
      1,
    ],
    ...[false, true].map(
      (linked) =>
        [
          `object.duplicate linked ${linked}`,
          (s: Scene) => {
            for (let i = 0; i < 3; i++) s.run('mesh.primitive_cube_add', { location: [3 * i, 0, 0] });
            s.state.selectedIds = s.doc.objectIds();
            return ['object.duplicate', { linked }];
          },
          3,
        ] as [string, (s: Scene) => [string, Record<string, unknown>], number],
    ),
    ...[false, true].map(
      (linked) =>
        [
          `object.array_place linked ${linked}`,
          (s: Scene) => {
            s.run('mesh.primitive_cube_add', {});
            s.run('mesh.primitive_plane_add', { location: [0, 3, 0] });
            s.state.selectedIds = s.doc.objectIds();
            return ['object.array_place', { count: 6, linked }];
          },
          10,
        ] as [string, (s: Scene) => [string, Record<string, unknown>], number],
    ),
    ...[false, true].map(
      (linked) =>
        [
          `object.scatter_on_surface linked ${linked}`,
          (s: Scene) => {
            s.run('mesh.primitive_plane_add', { size: 20, name: 'Ground' });
            s.run('mesh.primitive_cube_add', { size: 0.1, location: [0, 0, 5], name: 'Pebble' });
            return [
              'object.scatter_on_surface',
              { surface: 'Ground', objects: ['Pebble'], count: 15, linked },
            ];
          },
          15,
        ] as [string, (s: Scene) => [string, Record<string, unknown>], number],
    ),
    [
      'object.duplicates_make_real (particles)',
      (s) => {
        s.run('mesh.primitive_plane_add', { size: 20, name: 'Ground' });
        s.run('mesh.primitive_cube_add', { size: 0.1, location: [0, 0, 5], name: 'Pebble' });
        s.run('object.scatter_add', { surface: 'Ground', objects: ['Pebble'], count: 25 });
        const ground = s.doc.findObjectByName('Ground')!;
        s.state.selectedIds = [ground.id];
        s.state.activeId = ground.id;
        return ['object.duplicates_make_real', {}];
      },
      25,
    ],
    [
      'object.duplicates_make_real (collection instance)',
      (s) => {
        s.run('mesh.primitive_cube_add', { name: 'A' });
        s.run('mesh.primitive_cube_add', { name: 'B', location: [3, 0, 0] });
        const c = s.doc.addCollection({ name: 'Kit' });
        for (const o of s.doc.listObjects()) s.doc.updateObject(o.id, { collection: c });
        s.run('object.collection_instance_add', { collection: 'Kit' });
        return ['object.duplicates_make_real', {}];
      },
      2,
    ],
    ['mesh.primitive_cube_add', () => ['mesh.primitive_cube_add', {}], 1],
    ['mesh.primitive_torus_add', () => ['mesh.primitive_torus_add', {}], 1],
    ['object.empty_add', () => ['object.empty_add', {}], 1],
    ['object.camera_add', () => ['object.camera_add', {}], 1],
    ['object.light_add', () => ['object.light_add', { type: 'AREA' }], 1],
    ['object.armature_add', () => ['object.armature_add', {}], 1],
    ['object.text_add', () => ['object.text_add', { body: 'Hello' }], 1],
    ['curve.primitive_bezier_curve_add', () => ['curve.primitive_bezier_curve_add', {}], 1],
    [
      'curve.add_from_points',
      () => [
        'curve.add_from_points',
        {
          points: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
        },
      ],
      1,
    ],
    [
      'object.collection_instance_add',
      (s) => {
        s.run('mesh.primitive_cube_add', {});
        const c = s.doc.addCollection({ name: 'Kit' });
        s.doc.updateObject(s.doc.objectIds()[0], { collection: c });
        return ['object.collection_instance_add', { collection: 'Kit' }];
      },
      1,
    ],
    ['object.generate_rock', () => ['object.generate_rock', {}], 1],
    [
      'object.add_mesh_from_data',
      () => [
        'object.add_mesh_from_data',
        {
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
          ],
          faces: [[0, 1, 2]],
        },
      ],
      1,
    ],
    [
      'anim.turntable',
      (s) => (s.run('mesh.primitive_cube_add', {}), ['anim.turntable', { target: s.doc.objectIds()[0] }]),
      2,
    ],
    [
      'object.convert keep_original',
      (s) => {
        s.run('object.text_add', { body: 'Hi' });
        return ['object.convert', { target: 'MESH', keep_original: true }];
      },
      1,
    ],
    ['import_scene.gltf (nodes)', () => ['import_scene.gltf', fileParams(sharedGltf(2, 1, { nodes: 8 }))], 9],
    [
      'import_scene.obj (objects)',
      () => {
        let text = '';
        for (let i = 0; i < 4; i++)
          text += `o Part${i}\nv ${i} 0 0\nv ${i + 1} 0 0\nv ${i} 1 0\nf ${3 * i + 1} ${3 * i + 2} ${3 * i + 3}\n`;
        return ['import_scene.obj', fileParams(new TextEncoder().encode(text))];
      },
      4,
      true,
    ],
    [
      'import_mesh.ply',
      () => [
        'import_mesh.ply',
        fileParams(
          new TextEncoder().encode(
            'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
              'element face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n',
          ),
        ),
      ],
      1,
    ],
  ];

  it.each(cases)('are counted by the estimate: %s', (_name, setup, expected, bound) => {
    const s = scene();
    const [op, params] = setup(s);
    const before = s.doc.objectIds().length;
    const e = s.estimate(op, params);
    s.run(op, params);
    const added = s.doc.objectIds().length - before;
    expect(added).toBe(expected);
    expect(e?.objects).toBe(bound ? added + 1 : added);
    expect(e!.bytes).toBeGreaterThanOrEqual(OPERATOR_FIXED_BYTES + added * OBJECT_ADD_BYTES);
    expect(e!.addedStoredBytes).toBeGreaterThanOrEqual(added * OBJECT_STORED_BYTES);
  });

  it('counts every datablock kind at the peak of the operator and in what the project keeps', () => {
    expect(
      newObjectsBytes({ objects: 2, datablocks: { meshes: 3, lights: 1, materials: 2 }, extraJson: 100 }),
    ).toEqual({
      peak:
        2 * OBJECT_ADD_BYTES +
        3 * DATABLOCK_ADD_BYTES.meshes +
        DATABLOCK_ADD_BYTES.lights +
        2 * DATABLOCK_ADD_BYTES.materials +
        100 * OBJECT_JSON_ADD_BYTES,
      stored:
        2 * OBJECT_STORED_BYTES +
        3 * DATABLOCK_STORED_BYTES.meshes +
        DATABLOCK_STORED_BYTES.lights +
        2 * DATABLOCK_STORED_BYTES.materials +
        100 * OBJECT_JSON_STORED_BYTES,
    });
  });

  it('counts the instances of a collection of many objects in time linear in them', () => {
    // export and Make Instances Real estimates count instances (memory-instances.ts instanceBound):
    // the members of each collection were gathered by copying its list for every object it holds,
    // 3.3–3.6 s for 20,000 objects of one collection on the server's main thread before the operator
    const doc = SceneDoc.create({ name: 'Many', empty: true });
    const cube = doc.getObject(
      doc.addObject({ type: 'MESH', name: 'Cube', data: doc.addMesh('Cube', createCube()) }),
    )!;
    const objects = Array.from({ length: 20_000 }, (_, i) => ({ ...cube, id: `o${i}`, name: `C${i}` }));
    // the document's objects as listed, without the Yjs maps (listing 20,000 of them takes longer)
    const many = {
      listObjects: () => objects,
      listCollections: () => doc.listCollections(),
    } as unknown as SceneDoc;
    const t0 = performance.now();
    const bound = instanceBound(many, [objects[0]], { forRender: true, facesOf: () => 6 });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(bound).toEqual({ instances: 0, faces: 0 });
  });

  it('counts at most the objects duplicates_make_real makes in one run', () => {
    const s = scene();
    s.run('mesh.primitive_plane_add', { size: 20, name: 'Ground' });
    s.run('mesh.primitive_cube_add', { size: 0.1, location: [0, 0, 5], name: 'Pebble' });
    s.run('object.scatter_add', {
      surface: 'Ground',
      objects: ['Pebble'],
      count: MAKE_REAL_MAX_OBJECTS + 2000,
    });
    const ground = s.doc.findObjectByName('Ground')!;
    s.state.selectedIds = [ground.id];
    s.state.activeId = ground.id;
    // more instances than it makes real: it refuses (instancing.ts), it never makes more
    expect(s.estimate('object.duplicates_make_real', {})?.objects).toBe(MAKE_REAL_MAX_OBJECTS);
  });

  it('counts at most one hidden linked duplicate per object scatter_add gathers', () => {
    const s = scene();
    s.run('mesh.primitive_plane_add', { size: 20, name: 'Ground' });
    s.run('mesh.primitive_cube_add', { size: 0.1, name: 'A' });
    s.run('mesh.primitive_cube_add', { size: 0.1, name: 'B', location: [1, 0, 0] });
    // A's collection is instanced elsewhere: A gets a linked duplicate
    const kit = s.doc.addCollection({ name: 'Kit' });
    s.doc.updateObject(s.doc.findObjectByName('A')!.id, { collection: kit });
    s.run('object.collection_instance_add', { collection: 'Kit', location: [5, 0, 0] });
    const params = { surface: 'Ground', objects: ['A', 'B'], count: 10 };
    const before = s.doc.objectIds().length;
    const e = s.estimate('object.scatter_add', params);
    s.run('object.scatter_add', params);
    const added = s.doc.objectIds().length - before;
    expect(added).toBe(1);
    expect(e?.objects).toBe(2);
    // one source: nothing duplicated, nothing estimated
    expect(s.estimate('object.scatter_add', { surface: 'Ground', objects: ['B'], count: 10 })).toBeNull();
  });

  it('let the check refuse Separate by loose parts of many parts before it runs, saying what to lower', () => {
    const s = scene();
    // 6,000 loose quads: about 6,000 × 18 KB of objects and meshes, though only 6,000 faces
    const id = meshObject(s, looseQuads(6000), true);
    const asked: OperatorMemoryRequest[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req);
      return req.estimate.bytes > 96 * MB ? `Lower ${req.estimate.lower}` : null;
    });
    const res = s.reg.run(s.ctx, 'mesh.separate', { type: 'LOOSE' });
    expect(res).toMatchObject({
      ok: false,
      code: 'OUT_OF_MEMORY',
      error:
        'Lower the number of loose parts (separate some of them with type SELECTED first, then separate that ' +
        'object by loose parts)',
    });
    expect(s.doc.objectIds()).toEqual([id]);
    expect(asked[0].estimate).toMatchObject({ objects: 5999 });
    expect(asked[0].estimate.bytes).toBeGreaterThan(5999 * OBJECT_ADD_BYTES);
    // the project's objects and meshes are what the request says it stores
    expect(asked[0].objects).toBe(1);
    expect(asked[0].storedBytes).toBe(projectStoredBytes(s.doc));
    // by material: the material indices
    const m = scene();
    const grid = createGrid({ x_subdivisions: 4, y_subdivisions: 4 });
    grid.faceMaterials = grid.faces.map((_, f) => f % 2);
    meshObject(m, grid, true);
    expect(m.estimate('mesh.separate', { type: 'MATERIAL' })?.lower).toBe(
      'the number of material indices the faces use',
    );
  });

  it("counts the project's objects, datablocks and keyframes in what it stores", () => {
    const s = scene();
    const empty = projectObjects(s.doc);
    // at most PROJECT_JSON_SAMPLE objects of a kind: the JSON of every one of them is read
    for (let i = 0; i < 20; i++) s.run('object.empty_add', {});
    for (let i = 0; i < 4; i++) s.run('object.light_add', {});
    s.run('material.new', {});
    s.run('mesh.primitive_cube_add', {});
    const cube = s.doc.objectIds().at(-1)!;
    s.state.selectedIds = [cube];
    s.state.activeId = cube;
    for (const frame of [1, 10, 20]) s.run('anim.keyframe_insert', { type: 'Location', frame });
    const counted = projectObjects(s.doc);
    expect(counted.objects - empty.objects).toBe(25);
    let json = 0;
    for (const o of s.doc.listObjects()) {
      json += extraJsonChars(o);
      if (o.type === 'LIGHT') json += datablockExtraJsonChars(s.doc, 'lights', o.data!);
    }
    for (const id of s.doc.map('materials').keys()) json += datablockExtraJsonChars(s.doc, 'materials', id);
    expect(counted.bytes - empty.bytes).toBe(
      25 * OBJECT_STORED_BYTES +
        4 * DATABLOCK_STORED_BYTES.lights +
        DATABLOCK_STORED_BYTES.materials +
        DATABLOCK_STORED_BYTES.meshes +
        // three keyframes on each of location's three channels
        9 * KEYFRAME_STORED_BYTES +
        OBJECT_JSON_STORED_BYTES * json,
    );
    // deleted objects are not counted
    s.state.selectedIds = s.doc.objectIds().slice(0, 10);
    s.run('object.delete', {});
    expect(projectObjects(s.doc).objects).toBe(counted.objects - 10);
  });
});

describe('what a project keeps and what saving it takes', () => {
  it("counts what a save of the project takes besides what it keeps: three times its objects' part", () => {
    const s = scene();
    s.run('mesh.primitive_grid_add', { x_subdivisions: 50, y_subdivisions: 50, name: 'Grid' });
    for (let i = 0; i < 20; i++) s.run('object.empty_add', {});
    const objects = projectObjects(s.doc);
    expect(objects.bytes).toBe(21 * OBJECT_STORED_BYTES + DATABLOCK_STORED_BYTES.meshes);
    expect(saveBytes(objects.bytes)).toBe(SAVE_BYTES_PER_KEPT_BYTE * objects.bytes);
    expect(SAVE_BYTES_PER_KEPT_BYTE).toBe(3);
    // its meshes are not decoded by a save (their encodings are read in place): they count once
    expect(projectStoredBytes(s.doc)).toBe(storedMeshBytes(s.doc) + objects.bytes);
    // an operator that adds objects counts what saving them takes, and the request the project's
    const asked: OperatorMemoryRequest[] = [];
    setOperatorMemoryCheck((req) => (asked.push(req), null));
    s.state.selectedIds = [s.doc.findObjectByName('Grid')!.id];
    const before = projectStoredBytes(s.doc);
    s.run('object.array_place', { count: 101, linked: true });
    expect(asked[0].estimate.addedStoredBytes).toBe(100 * OBJECT_STORED_BYTES);
    expect(asked[0].estimate.addedSaveBytes).toBe(saveBytes(100 * OBJECT_STORED_BYTES));
    expect(asked[0].storedBytes).toBe(before);
    expect(asked[0].saveBytes).toBe(saveBytes(objects.bytes));
    // an import its keyframes too (a save decodes their F-curves' JSON)
    const anim = importEstimate('gltf', bytesReader(animatedGltf(10, 30)));
    expect(anim.addedSaveBytes).toBe(
      saveBytes(
        10 * OBJECT_STORED_BYTES + DATABLOCK_STORED_BYTES.meshes + 10 * 9 * 30 * KEYFRAME_STORED_BYTES,
      ),
    );
  });

  it('estimates the peak of linked duplicates above the highest measured (80,000 of them: 1,307.5 MB)', () => {
    // three runs of object.duplicate linked of 80,000 cubes peaked at 984.8, 1,027.5 and 1,307.5 MB
    // (--trace-gc, garbage included, a heap of 3,500 MB); 13 KB per object estimated 1,025.1 MB
    const peak = OPERATOR_FIXED_BYTES + newObjectsBytes({ objects: 80_000 }).peak;
    expect(peak / MB).toBeGreaterThan(1.05 * 1307.5);
    expect(OBJECT_ADD_BYTES).toBe(18_000);
  });

  it('counts the shape keys of stored meshes, and the morph targets an import makes into them', () => {
    const s = scene();
    const grid = createGrid({ x_subdivisions: 30, y_subdivisions: 30 });
    const id = s.doc.addMesh('Grid', grid);
    s.doc.addObject({ type: 'MESH', name: 'Grid', data: id });
    const plain = storedMeshBytes(s.doc);
    const key = (name: string) => ({
      name,
      value: 0.5,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: 'Basis',
      data: new Uint8Array(new Float32Array(grid.positions).buffer),
    });
    s.doc.setShapeKeys(id, [key('A'), key('B'), key('C')]);
    expect(storedMeshBytes(s.doc) - plain).toBe(3 * 961 * SHAPE_KEY_STORED_BYTES_PER_VERTEX);
    // a glTF mesh of 121 vertices with 3 morph targets: 3 shape keys of 121 vertices kept
    const one = importEstimate('glb', bytesReader(sharedGltf(10, 1)));
    const morphs = importEstimate('glb', bytesReader(sharedGltf(10, 1, { targets: 3 })));
    expect(morphs.addedStoredBytes - one.addedStoredBytes).toBe(3 * 121 * SHAPE_KEY_STORED_BYTES_PER_VERTEX);
  });

  it('counts the JSON of objects, curves and armatures beyond the default from a sample of them', () => {
    const s = scene();
    const base = projectObjects(s.doc).bytes;
    // a curve of 2,000 points keeps its splines as JSON: every character beyond a curve primitive's
    const points = Array.from({ length: 2000 }, (_, i) => [i * 0.01, Math.sin(i), 0]);
    s.run('curve.add_from_points', { points, name: 'Path' });
    const curve = s.doc.findObjectByName('Path')!;
    const chars = JSON.stringify(
      (s.doc.map('curves').get(curve.data!) as { toJSON(): unknown }).toJSON(),
    ).length;
    expect(chars).toBeGreaterThan(300_000);
    expect(projectObjects(s.doc).bytes - base).toBe(
      OBJECT_STORED_BYTES +
        DATABLOCK_STORED_BYTES.curves +
        OBJECT_JSON_STORED_BYTES * (chars - DATABLOCK_BASE_JSON_CHARS.curves),
    );
    // objects with modifiers keep their JSON too
    const t = scene();
    t.run('mesh.primitive_cube_add', {});
    const before = projectObjects(t.doc).bytes;
    for (let i = 0; i < 4; i++) t.run('object.modifier_add', { type: 'BEVEL' });
    const o = t.doc.getObject(t.state.activeId!)!;
    expect(projectObjects(t.doc).bytes - before).toBe(
      OBJECT_JSON_STORED_BYTES * (JSON.stringify(o).length - OBJECT_BASE_JSON_CHARS),
    );
  });

  it('reads the JSON of objects spread over the project, not only the first ones', () => {
    const s = scene();
    s.run('mesh.primitive_cube_add', { name: 'Cube' });
    s.run('object.array_place', { count: 64, linked: true });
    // in the order the project's map holds them: the second half get four modifiers each
    const ids = [...s.doc.map('objects')._map.keys()];
    expect(ids).toHaveLength(64);
    s.state.selectedIds = [ids[32]];
    s.state.activeId = ids[32];
    for (let i = 0; i < 4; i++) s.run('object.modifier_add', { type: 'BEVEL' });
    const modifiers = s.doc.getObject(ids[32])!.modifiers;
    for (const id of ids.slice(33)) s.doc.updateObject(id, { modifiers });
    const all = ids.reduce((sum, id) => sum + extraJsonChars(s.doc.getObject(id)!), 0);
    expect(all).toBeGreaterThan(32 * 400);
    // 32 of the 64 objects are read, every second one: their JSON scaled to all of them
    const counted = projectObjects(s.doc).bytes - 64 * OBJECT_STORED_BYTES - DATABLOCK_STORED_BYTES.meshes;
    expect(counted).toBeGreaterThan(0.9 * OBJECT_JSON_STORED_BYTES * all);
    expect(counted).toBeLessThan(1.1 * OBJECT_JSON_STORED_BYTES * all);
  });

  it('counts the JSON of every curve a copy with linked false makes', () => {
    const s = scene();
    const points = Array.from({ length: 2000 }, (_, i) => [i * 0.01, Math.sin(i), 0]);
    s.run('curve.add_from_points', { points, name: 'Path' });
    const curve = s.doc.findObjectByName('Path')!;
    const extra =
      JSON.stringify((s.doc.map('curves').get(curve.data!) as { toJSON(): unknown }).toJSON()).length -
      DATABLOCK_BASE_JSON_CHARS.curves;
    // 200 copies of a curve of 2,000 points (measured: 109.7 MB at the peak, 92.5 MB kept; counted at a
    // flat size per curve: 37 and 4.4 MB)
    s.state.selectedIds = [curve.id];
    const copies = s.estimate('object.array_place', { count: 201, linked: false })!;
    const linked = s.estimate('object.array_place', { count: 201, linked: true })!;
    expect(copies.addedStoredBytes - linked.addedStoredBytes).toBe(
      200 * (DATABLOCK_STORED_BYTES.curves + OBJECT_JSON_STORED_BYTES * extra),
    );
    expect(copies.addedStoredBytes).toBeGreaterThan(92.5 * MB);
    expect(copies.bytes).toBeGreaterThan(109.7 * MB);
    const scatter = s.estimate('object.duplicate', { linked: false })!;
    expect(scatter.addedStoredBytes).toBe(
      OBJECT_STORED_BYTES + DATABLOCK_STORED_BYTES.curves + OBJECT_JSON_STORED_BYTES * extra,
    );
  });
});

describe('operators that build the surfaces of many curves and texts', () => {
  it('count the young generation of building them once, not once per surface', () => {
    const texts = (n: number) => {
      const s = scene();
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        s.run('object.text_add', { body: 'Ab', location: [i, 0, 0] });
        ids.push(s.state.activeId!);
      }
      s.state.selectedIds = ids;
      return s.estimate('object.convert', { target: 'MESH' })!;
    };
    const one = texts(1);
    const fifty = texts(50);
    // 49 more texts of two glyphs each: well under a megabyte each (300 texts peaked at 27.7 MB
    // converted, and were estimated at 9,729 MB with 32 MB counted for each)
    expect(fifty.faces).toBe(50 * one.faces);
    expect(fifty.bytes - one.bytes).toBeLessThan(49 * MB);
    expect(fifty.bytes).toBeGreaterThan(OPERATOR_FIXED_BYTES);
  });
});

describe('scene evaluations', () => {
  it('count the JSON of lights, cameras and armatures and the bones of armatures they keep', () => {
    const doc = SceneDoc.create({ empty: true });
    const bones = Array.from({ length: 12 }, (_, i) => ({
      name: `Bone.${i}`,
      parent: i ? `Bone.${i - 1}` : null,
      head: [0, 0, i] as [number, number, number],
      tail: [0, 0, i + 1] as [number, number, number],
      roll: 0,
      use_connect: i > 0,
      use_deform: true,
      envelope_distance: 0.25,
      envelope_weight: 1,
      head_radius: 0.1,
      tail_radius: 0.05,
    }));
    for (let i = 0; i < 5; i++) {
      const data = doc.addArmature({ name: `Rig${i}`, bones });
      doc.addObject({ type: 'ARMATURE', name: `Rig${i}`, data });
    }
    const o = doc.listObjects()[0];
    const json = JSON.stringify(o).length + JSON.stringify(doc.getArmature(o.data!)).length;
    const size = sceneEvaluationBytes(doc);
    expect(size.objects).toBe(5);
    expect(size.perObject).toBe(
      EVALUATED_OBJECT_BYTES +
        EVALUATED_BYTES_PER_JSON_CHAR * (json - OBJECT_BASE_JSON_CHARS) +
        EVALUATED_BONE_BYTES * 12,
    );
    // a light's datablock JSON counts too
    const lights = SceneDoc.create({ empty: true });
    const light = lights.addLight({ name: 'Sun', type: 'SUN' });
    lights.addObject({ type: 'LIGHT', name: 'Sun', data: light });
    const l = lights.listObjects()[0];
    const lightJson = JSON.stringify(l).length + JSON.stringify(lights.getLight(light)).length;
    expect(sceneEvaluationBytes(lights).perObject).toBe(
      EVALUATED_OBJECT_BYTES +
        EVALUATED_BYTES_PER_JSON_CHAR * Math.max(0, lightJson - OBJECT_BASE_JSON_CHARS),
    );
    expect(lightJson).toBeGreaterThan(OBJECT_BASE_JSON_CHARS);
  });
});

describe('estimates that read stored meshes', () => {
  it('say why an operator does not run when its estimate reads a mesh the host would not decode', () => {
    const s = scene();
    meshObject(s, looseQuads(50), true);
    // a host that decodes no stored mesh: the estimate of Separate counts the parts of the edited mesh
    const fresh = SceneDoc.fromUpdate(s.doc.encodeState());
    const ctx = { ...s.ctx, doc: fresh };
    setOperatorMemoryCheck(() => null);
    setMeshMemoryCheck(() => 'not decoded here');
    expect(operatorMemoryRefusal('mesh.separate', ctx, { type: 'LOOSE' })).toBe('not decoded here');
  });
});

describe('imports counted from their files', () => {
  it('count every glTF mesh the importer decodes, also where meshes share accessors', () => {
    const one = gltfImportSize(readGltfJson(bytesReader(sharedGltf(20, 1)))!.json, 0);
    const forty = sharedGltf(20, 40);
    const size = gltfImportSize(readGltfJson(bytesReader(forty))!.json, 0);
    expect(size).toMatchObject({ meshes: 40, objects: 40, faces: 40 * 800, largestCorners: 2400 });
    expect(size.decodedBytes).toBe(40 * one.decodedBytes);
    expect(one.decodedBytes).toBe(
      decodedMeshBytes({ vertices: 441, faces: 800, corners: 2400, uvs: false, colors: false }),
    );
    // the file grows by little, the estimate with the meshes it decodes: not by the file's size
    const small = importEstimate('glb', bytesReader(sharedGltf(20, 1)));
    const large = importEstimate('glb', bytesReader(forty));
    expect(forty.byteLength).toBeLessThan(1.5 * sharedGltf(20, 1).byteLength);
    expect(large.bytes - small.bytes).toBeGreaterThan(39 * 2 * one.decodedBytes);
    expect(large.bytes).toBeGreaterThan(OPERATOR_FIXED_BYTES + 2 * size.decodedBytes);
    expect(large.bytes - OPERATOR_FIXED_BYTES).toBeGreaterThan(
      10 * IMPORT_BYTES_PER_FILE_BYTE * forty.byteLength,
    );
    expect(large).toMatchObject({ faces: 32_000, meshes: 40, objects: 40 });
    expect(large.addedStoredBytes).toBeGreaterThanOrEqual(size.decodedBytes + 40 * OBJECT_STORED_BYTES);
    expect(large.lower).toBe(
      'the meshes of the file (every glTF mesh is decoded into a mesh of its own, also where meshes share the same accessors)',
    );
    // a file of one mesh: its size, like other files
    expect(small).toMatchObject({
      meshes: 1,
      lower: 'the size of the file (import fewer or simpler meshes)',
    });
    // a .gltf with its buffer embedded: the same counts
    const embedded = sharedGltf(20, 40, { gltf: true });
    expect(gltfImportSize(readGltfJson(bytesReader(embedded))!.json, 0)).toEqual(size);
    expect(importEstimate('gltf', bytesReader(embedded)).bytes).toBeGreaterThan(large.bytes);
  });

  it('count nodes as objects and morph targets as copies of the vertices', () => {
    const nodes = importEstimate('gltf', bytesReader(sharedGltf(2, 1, { nodes: 2000, gltf: true })));
    expect(nodes.objects).toBe(2001);
    expect(nodes.bytes).toBeGreaterThan(OPERATOR_FIXED_BYTES + 2001 * OBJECT_ADD_BYTES);
    expect(nodes.lower).toBe('the nodes (objects) of the file');
    const morphs = gltfImportSize(readGltfJson(bytesReader(sharedGltf(10, 1, { targets: 3 })))!.json, 0);
    expect(morphs.morphVertices).toBe(3 * 121);
  });

  it("count the nodes of the first scene when the file names none, and a node's camera or light beside its mesh", () => {
    const mesh = { primitives: [{ attributes: { POSITION: 0 } }] };
    const accessors = [{ componentType: 5126, count: 3, type: 'VEC3' }];
    // no scene index, and scene 0 lists its roots: those, and their children
    const noIndex = gltfImportSize(
      {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ children: [1, 2] }, { mesh: 0 }, { mesh: 0 }, { mesh: 0 }],
        meshes: [mesh],
        accessors,
      },
      0,
    );
    expect(noIndex.objects).toBe(3);
    // an index that names a scene without nodes: scene 0's
    const emptyScene = gltfImportSize(
      {
        asset: { version: '2.0' },
        scene: 1,
        scenes: [{ nodes: [0, 1] }, {}],
        nodes: [{ mesh: 0 }, { mesh: 0 }],
        meshes: [mesh],
        accessors,
      },
      0,
    );
    expect(emptyScene.objects).toBe(2);
    // a node with a mesh and a camera, one with a mesh and a light: an object more for each
    const both = gltfImportSize(
      {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0, 1] }],
        nodes: [
          { mesh: 0, camera: 0 },
          { mesh: 0, extensions: { KHR_lights_punctual: { light: 0 } } },
        ],
        meshes: [mesh],
        accessors,
        cameras: [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.1 } }],
        extensions: { KHR_lights_punctual: { lights: [{ type: 'point' }] } },
      },
      0,
    );
    expect(both).toMatchObject({ objects: 4, cameras: 1, lights: 1 });
  });

  it('take the counts of a PLY file from its header, its corners bounded by the bytes after it', () => {
    const header = (format: string, v: number, f: number) =>
      `ply\nformat ${format} 1.0\nelement vertex ${v}\nproperty float x\nproperty float y\nproperty float z\n` +
      `property float u\nproperty float v\nelement face ${f}\nproperty list uchar uint vertex_indices\nend_header\n`;
    // binary: 1,000 vertices of 20 bytes, 500 quads (1 + 16 bytes each)
    const head = new TextEncoder().encode(header('binary_little_endian', 1000, 500));
    const binary = new Uint8Array(head.length + 20 * 1000 + 17 * 500);
    binary.set(head);
    const size = plyImportSize(bytesReader(binary))!;
    expect(size).toMatchObject({ meshes: 1, objects: 1, faces: 500, largestCorners: 2000 });
    expect(size.decodedBytes).toBe(
      decodedMeshBytes({
        vertices: 1000,
        faces: 500,
        corners: 2000,
        uvs: true,
        colors: false,
        looseEdges: 0,
      }),
    );
    // a header that declares a million faces: they are decoded whatever the file's size
    const huge = new TextEncoder().encode(header('ascii', 1_000_000, 1_000_000));
    expect(plyImportSize(bytesReader(huge))).toMatchObject({ faces: 1_000_000 });
    expect(importEstimate('ply', bytesReader(huge)).bytes).toBeGreaterThan(
      decodedMeshBytes({ vertices: 1_000_000, faces: 1_000_000, corners: 0, uvs: true, colors: false }),
    );
    expect(plyImportSize(bytesReader(new TextEncoder().encode('ply\nformat ascii 1.0\n')))).toBeNull();
  });

  it("count an OBJ file's objects by its o and g lines", () => {
    const text = 'v 0 0 0\no A\nv 1 0 0\ng B\n  o not a line start\nf 1 2 3\r\no C\n';
    expect(objObjects(bytesReader(new TextEncoder().encode(text)))).toBe(4);
  });

  it('read base64 with characters it does not have as the decoder does, and leave such files to the importer', () => {
    // the decoder skips characters base64 does not have and stops at padding: the reader's size is
    // what it decodes (it was the characters' count, and a GLB header of 20 bytes read from 8 threw)
    for (const [b64, bytes] of [
      ['!'.repeat(34), 0],
      ['QQ==QQ==', 1],
      ['Z2xURgIAAAA!!!!', 8],
      ['QUJD\nREVG', 6],
      ['QUJDREVG', 6],
    ] as const) {
      const file = base64Reader(b64);
      expect(file.byteLength, b64).toBe(bytes);
      expect(file.read(0, file.byteLength).length, b64).toBe(bytes);
    }
    const s = scene();
    setOperatorMemoryCheck(() => null);
    for (const id of ['import_scene.gltf', 'import_mesh.ply', 'import_mesh.stl', 'import_scene.obj']) {
      const r = s.reg.run(s.ctx, id, { data_base64: '!'.repeat(34) });
      expect(r, id).toMatchObject({ ok: false, error: 'The file is empty', code: 'INVALID_PARAMS' });
    }
  });
});

describe('a Bevel limited by angle', () => {
  /** A Bevel modifier with `p` over its defaults. */
  const bevel = (p: Partial<BevelSizeParams>): ModifierData => ({
    id: 'b',
    name: 'Bevel',
    type: 'BEVEL',
    show_viewport: true,
    show_render: true,
    show_in_editmode: false,
    show_expanded: true,
    params: { width: 0.02, ...p },
  });
  const params = (p: Partial<BevelSizeParams>) =>
    ({
      width: 0.02,
      segments: 1,
      limit_method: 'NONE',
      angle_limit: Math.PI / 6,
      affect: 'EDGES',
      ...p,
    }) as BevelSizeParams;

  /** What the Bevel makes of `mesh` in an evaluation, and the evaluation's modifier errors. */
  function evaluated(mesh: MeshData, mod: ModifierData) {
    const doc = SceneDoc.create({ empty: true });
    const data = doc.addMesh('Mesh', mesh);
    doc.addObject({ type: 'MESH', name: 'Mesh', data, modifiers: [mod] });
    const o = new SceneEvaluator(doc).evaluate(1).objects[0];
    const m = o.mesh!;
    return {
      faces: m.faces.length,
      corners: m.faces.reduce((a, f) => a + f.length, 0),
      vertices: m.positions.length / 3,
      errors: o.modifierErrors.map((e) => e.message),
    };
  }

  const bumpy = () => {
    const torus = createTorus({ major_segments: 24, minor_segments: 8 });
    return torus;
  };

  /** Two cones of `k` triangles around one vertex each, joined at their rim (a closed mesh). */
  const bicone = (k: number): MeshData => {
    const positions = [0, 0, 1, 0, 0, -1];
    const faces: number[][] = [];
    for (let i = 0; i < k; i++) {
      positions.push(Math.cos((2 * Math.PI * i) / k), Math.sin((2 * Math.PI * i) / k), 0);
      faces.push([0, 2 + i, 2 + ((i + 1) % k)], [1, 2 + ((i + 1) % k), 2 + i]);
    }
    return createMesh({ positions, faces });
  };

  it.each([
    ['a cube by angle', createCube, { limit_method: 'ANGLE', segments: 1 }],
    ['a cube by angle in 3 segments', createCube, { limit_method: 'ANGLE', segments: 3 }],
    [
      'a torus by angle (every edge sharper than 10°)',
      bumpy,
      { limit_method: 'ANGLE', angle_limit: 0.17, segments: 2 },
    ],
    [
      'a torus by angle (no edge sharper than 60°)',
      bumpy,
      { limit_method: 'ANGLE', angle_limit: 1.05, segments: 4 },
    ],
    [
      'a torus, vertices only',
      bumpy,
      { limit_method: 'ANGLE', angle_limit: 0.17, affect: 'VERTICES', segments: 2 },
    ],
    ['a grid (open borders)', () => createGrid({ x_subdivisions: 6, y_subdivisions: 6 }), { segments: 2 }],
    // patches of 60 profiles at two vertices: more faces than strips, which the bound counts by corner
    ['a bicone in 8 segments (two vertices of 60 edges)', () => bicone(60), { segments: 8 }],
  ] as [string, () => MeshData, Partial<BevelSizeParams>][])(
    'is counted on its input at least as large as what it makes: %s',
    (_name, make, p) => {
      const mesh = make();
      const c = bevelCount(mesh, params(p));
      const r = evaluated(mesh, bevel(p));
      expect(r.errors).toEqual([]);
      expect(c.result.faces).toBeGreaterThanOrEqual(r.faces);
      expect(c.result.corners).toBeGreaterThanOrEqual(r.corners);
      expect(c.result.vertices).toBeGreaterThanOrEqual(r.vertices);
      // and from the sizes alone (limit_method NONE's bound) at least as large again
      const bound = estimateModifier(bevel(p), meshSize(mesh), { forRender: false, bevelUpperBound: true });
      expect(bound.result.faces).toBeGreaterThanOrEqual(c.result.faces);
      expect(bound.bytes).toBeGreaterThanOrEqual(
        estimateModifier(bevel(p), meshSize(mesh), { forRender: false, bevelInput: mesh }).bytes,
      );
    },
  );

  it('is counted in about the time of a grid of as many corners, also around a vertex of 20,000 faces', () => {
    // two cones of 20,000 triangles around one vertex each (a bicone): the faces of every edge were
    // found by scanning every corner of its vertex, O(valence²): 20 s for this bicone, on the
    // server's main thread before every Bevel
    const k = 20_000;
    const positions = [0, 0, 1, 0, 0, -1];
    const fan: number[][] = [];
    for (let i = 0; i < k; i++) {
      positions.push(Math.cos((2 * Math.PI * i) / k), Math.sin((2 * Math.PI * i) / k), 0);
      fan.push([0, 2 + i, 2 + ((i + 1) % k)], [1, 2 + ((i + 1) % k), 2 + i]);
    }
    const bicone = createMesh({ positions, faces: fan });
    // as many corners (120,000) in quads around vertices of four
    const grid = createGrid({ x_subdivisions: 173, y_subdivisions: 173 });
    const p = params({ limit_method: 'ANGLE', angle_limit: 0.5, segments: 2 });
    bevelCount(createCube(), p);
    const time = (mesh: MeshData) => {
      let best = Infinity;
      for (let r = 0; r < 2; r++) {
        const t0 = performance.now();
        bevelCount(mesh, p);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const gridMs = time(grid);
    const fanMs = time(bicone);
    expect(fanMs).toBeLessThan(10 * Math.max(gridMs, 5));
    // the rim's edges are sharper than the limit, the cones' are not
    expect(bevelCount(bicone, p).edges).toBe(k);
  });

  it('that would not fit is skipped as a modifier error before it runs; a small one runs', () => {
    // every edge of the torus is sharper than 3° (5.6° and 11.3°): 6 segments add about 100,000
    // faces (about 170 MB)
    setGeometryMemoryCheck((req) => (req.estimate.bytes > 64 * MB ? `too large: ${req.label}` : null));
    const torus = createTorus({ major_segments: 64, minor_segments: 32 });
    const big = evaluated(torus, bevel({ limit_method: 'ANGLE', angle_limit: 0.05, segments: 6 }));
    expect(big.errors).toEqual(['too large: Bevel']);
    expect(big.faces).toBe(torus.faces.length);
    const cube = evaluated(createCube(), bevel({ limit_method: 'ANGLE', segments: 2 }));
    expect(cube.errors).toEqual([]);
    expect(cube.faces).toBeGreaterThan(6);
  });

  it('is counted on the stored mesh for estimates before an evaluation when it comes first, else bounded', () => {
    // no edge of the torus is sharper than 1.5 rad: the Bevel first in the stack adds nothing, which
    // only the stored mesh tells (every edge beveled: about 9 times as many faces)
    const s = scene();
    const torus = createTorus({ major_segments: 32, minor_segments: 16 });
    const id = meshObject(s, torus);
    s.doc.updateObject(id, { modifiers: [bevel({ limit_method: 'ANGLE', angle_limit: 1.5, segments: 3 })] });
    expect(s.estimate('object.convert', { target: 'MESH' })!.faces).toBe(torus.faces.length);
    // after a Subdivision Surface its input is not stored: every edge beveled, at least what it makes
    const t = scene();
    const tid = meshObject(t, createTorus({ major_segments: 32, minor_segments: 16 }));
    const subsurf: ModifierData = {
      id: 's',
      name: 'Subdivision',
      type: 'SUBSURF',
      show_viewport: true,
      show_render: true,
      show_in_editmode: true,
      show_expanded: true,
      params: { levels: 1, render_levels: 1 },
    };
    t.doc.updateObject(tid, {
      modifiers: [subsurf, bevel({ limit_method: 'ANGLE', angle_limit: 0.01, segments: 2 })],
    });
    const e = t.estimate('object.convert', { target: 'MESH' })!;
    t.run('object.convert', { target: 'MESH' });
    const made = t.doc.meshCounts(t.doc.getObject(tid)!.data!)!;
    expect(made.faces).toBeGreaterThan(4 * torus.faces.length);
    expect(e.faces).toBeGreaterThanOrEqual(made.faces);
  });

  it('is bounded as if every edge were sharp when shape keys deform the stored mesh first', () => {
    // a flat grid whose shape key folds it into a zigzag: the stored mesh has no sharp edge, the
    // input of the Bevel (after the shape key) one along every other row
    const s = scene();
    const n = 20;
    const grid = createGrid({ x_subdivisions: n, y_subdivisions: n, size: 2 });
    const id = meshObject(s, grid);
    const data = s.doc.getObject(id)!.data!;
    const folded = new Float32Array(grid.positions);
    for (let i = 0; i < folded.length; i += 3)
      folded[i + 2] = Math.round(((folded[i] + 1) * n) / 2) % 2 ? 0.05 : 0;
    s.doc.setShapeKeys(data, [
      {
        name: 'Fold',
        value: 1,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: 'Basis',
        data: new Uint8Array(folded.buffer),
      },
    ]);
    s.doc.updateObject(id, {
      modifiers: [bevel({ width: 0.002, segments: 4, limit_method: 'ANGLE', angle_limit: 0.1 })],
    });
    const e = s.estimate('object.convert', { target: 'MESH' })!;
    s.run('object.convert', { target: 'MESH' });
    const made = s.doc.meshCounts(s.doc.getObject(id)!.data!)!;
    expect(made.faces).toBeGreaterThan(2 * grid.faces.length);
    expect(e.faces).toBeGreaterThanOrEqual(made.faces);
    // a muted shape key leaves the stored mesh the input: counted on it
    const t = scene();
    const tid = meshObject(t, createGrid({ x_subdivisions: n, y_subdivisions: n, size: 2 }));
    t.doc.setShapeKeys(t.doc.getObject(tid)!.data!, [
      {
        name: 'Fold',
        value: 1,
        slider_min: 0,
        slider_max: 1,
        mute: true,
        relative_key: 'Basis',
        data: new Uint8Array(folded.buffer),
      },
    ]);
    t.doc.updateObject(tid, {
      modifiers: [bevel({ width: 0.002, segments: 4, limit_method: 'ANGLE', angle_limit: 0.1 })],
    });
    expect(t.estimate('object.convert', { target: 'MESH' })!.faces).toBe(grid.faces.length);
  });

  it("is estimated for operators from its object's mesh, else as if every edge were sharp", () => {
    const s = scene();
    const torus = createTorus({ major_segments: 32, minor_segments: 16 });
    const id = meshObject(s, torus);
    s.doc.updateObject(id, { modifiers: [bevel({ limit_method: 'ANGLE', angle_limit: 0.1, segments: 3 })] });
    const e = s.estimate('object.convert', { target: 'MESH' })!;
    s.run('object.convert', { target: 'MESH' });
    const made = s.doc.meshCounts(s.doc.getObject(id)!.data!)!;
    expect(made.faces).toBeGreaterThan(torus.faces.length);
    expect(e.faces).toBeGreaterThanOrEqual(made.faces);
  });
});
