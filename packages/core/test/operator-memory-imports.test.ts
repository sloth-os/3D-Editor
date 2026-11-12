import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMPORT_BYTES_PER_IMAGE_BYTE,
  IMPORT_BYTES_PER_UNUSED_IMAGE_BYTE,
  OPERATOR_FIXED_BYTES,
  SAVE_BYTES_PER_IMAGE_BYTE,
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  projectObjects,
  projectStoredBytes,
  saveBytes,
  setOperatorMemoryCheck,
  storedImageBytes,
} from '../src/operators';
import { SceneDoc } from '../src/doc/scene-doc';
import { createGrid } from '../src/mesh';
import { exportScene } from '../src/io';
import {
  dataUriBytes,
  gltfImportSize,
  objImportSize,
  readGltfJson,
  bytesReader,
} from '../src/io/import-size';
import { base64Encode } from '../src/util/json';

/*
 * What an operator that adds meshes or images counts against the project, compared with what the
 * project counts afterwards (operators/memory-objects.ts projectStoredBytes): the meshes with a UV
 * layer as stored meshes are counted, the welded vertices of an STL, the corners of PLY and OBJ faces
 * as the importers read them, and the images a glTF import keeps.
 */

afterEach(() => setOperatorMemoryCheck(null));

const here = path.dirname(fileURLToPath(import.meta.url));

function scene() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx = { doc, state, origin: { type: 'test' }, source: 'test' as const, report: () => undefined };
  return { doc, reg, state, ctx };
}

/** What the estimate of `id` adds to the project, and what the project counts more after it ran. */
function addedAndCounted(id: string, params: Record<string, unknown>) {
  const s = scene();
  const est = estimateOperator(id, s.ctx, s.reg.parseParams(id, params));
  const before = projectStoredBytes(s.doc);
  const r = s.reg.run(s.ctx, id, params);
  if (!r.ok) throw new Error(`${id}: ${r.error}`);
  return { added: est?.addedStoredBytes ?? 0, counted: projectStoredBytes(s.doc) - before, est, doc: s.doc };
}

const G = 60;
const grid = () => createGrid({ x_subdivisions: G, y_subdivisions: G });

/** A grid of G × G quads exported in `format` (binary STL and PLY, OBJ, GLB). */
function exported(format: 'stl' | 'ply' | 'obj' | 'glb'): Uint8Array {
  const src = SceneDoc.create({ empty: true });
  src.addObject({ type: 'MESH', name: 'Grid', data: src.addMesh('Grid', grid()) });
  const res = exportScene(src, format, {});
  return res.data instanceof Uint8Array ? res.data : new TextEncoder().encode(String(res.data));
}

/** The triangles of a grid of G × G quads, as [x, y] corners. */
function triangles(): number[][][] {
  const out: number[][][] = [];
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++)
      out.push(
        [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
        ],
        [
          [x, y],
          [x + 1, y + 1],
          [x, y + 1],
        ],
      );
  return out;
}

/** A GLB of `meshes` glTF meshes sharing the accessors of one triangulated grid, without TEXCOORD_0. */
function sharedGlb(meshes: number): Uint8Array {
  const V = (G + 1) * (G + 1);
  const pos = new Float32Array(3 * V);
  for (let y = 0, i = 0; y <= G; y++) for (let x = 0; x <= G; x++, i++) pos.set([x / G, 0, y / G], 3 * i);
  const idx = new Uint32Array(6 * G * G);
  for (let y = 0, t = 0; y < G; y++)
    for (let x = 0; x < G; x++, t++) {
      const a = y * (G + 1) + x;
      idx.set([a, a + 1, a + G + 2, a, a + G + 2, a + G + 1], 6 * t);
    }
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  return glb(
    {
      asset: { version: '2.0' },
      scenes: [{ nodes: Array.from({ length: meshes }, (_, i) => i) }],
      nodes: Array.from({ length: meshes }, (_, i) => ({ mesh: i, translation: [1.5 * i, 0, 0] })),
      meshes: Array.from({ length: meshes }, () => ({
        primitives: [{ attributes: { POSITION: 0 }, indices: 1 }],
      })),
      accessors: [
        { bufferView: 0, componentType: 5126, count: V, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] },
        { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
        { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
      ],
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  );
}

/** A GLB of `json` and its binary chunk `bin`. */
function glb(json: object, bin: Uint8Array): Uint8Array {
  const pad = (b: Uint8Array, fill: number) => {
    const out = new Uint8Array(Math.ceil(b.length / 4) * 4).fill(fill);
    out.set(b);
    return out;
  };
  const j = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const b = pad(bin, 0);
  const out = new Uint8Array(20 + j.length + 8 + b.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, b.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(b, 28 + j.length);
  return out;
}

const file = (bytes: Uint8Array) => ({ data_base64: base64Encode(bytes) });

describe('what an operator that adds meshes counts', () => {
  it('equals what the project counts afterwards, every stored mesh with a UV layer', () => {
    const g = grid();
    const vertices: number[][] = [];
    for (let i = 0; i < g.positions.length; i += 3)
      vertices.push([g.positions[i], g.positions[i + 1], g.positions[i + 2]]);
    const tris = triangles();
    // an ASCII STL of the triangles, and an ASCII PLY and an OBJ of them without texture coordinates
    const stlAscii =
      'solid grid\n' +
      tris
        .map(
          (t) =>
            '  facet normal 0 0 1\n    outer loop\n' +
            t.map(([x, y]) => `      vertex ${x / G} ${y / G} 0\n`).join('') +
            '    endloop\n  endfacet\n',
        )
        .join('') +
      'endsolid grid\n';
    const corners = (G + 1) * (G + 1);
    const index = ([x, y]: number[]) => y * (G + 1) + x;
    const plyAscii =
      `ply\nformat ascii 1.0\nelement vertex ${corners}\nproperty float x\nproperty float y\nproperty float z\n` +
      `element face ${tris.length}\nproperty list uchar int vertex_indices\nend_header\n` +
      Array.from(
        { length: corners },
        (_, i) => `${(i % (G + 1)) / G} ${Math.floor(i / (G + 1)) / G} 0\n`,
      ).join('') +
      tris.map((t) => `3 ${t.map(index).join(' ')}\n`).join('');
    const obj =
      Array.from(
        { length: corners },
        (_, i) => `v ${(i % (G + 1)) / G} 0 ${Math.floor(i / (G + 1)) / G}\n`,
      ).join('') + tris.map((t) => `f ${t.map((c) => index(c) + 1).join(' ')}\n`).join('');
    const text = (s: string) => new TextEncoder().encode(s);
    const cases: [string, string, Record<string, unknown>][] = [
      ['create_mesh (quads)', 'object.add_mesh_from_data', { name: 'G', vertices, faces: g.faces }],
      ['primitive grid', 'mesh.primitive_grid_add', { x_subdivisions: G, y_subdivisions: G }],
      ['primitive UV sphere', 'mesh.primitive_uv_sphere_add', { segments: 64, ring_count: 32 }],
      ['binary STL', 'import_mesh.stl', file(exported('stl'))],
      ['ASCII STL', 'import_mesh.stl', file(text(stlAscii))],
      ['binary PLY with UVs', 'import_mesh.ply', file(exported('ply'))],
      ['ASCII PLY without UVs', 'import_mesh.ply', file(text(plyAscii))],
      ['OBJ with UVs and normals', 'import_scene.obj', file(exported('obj'))],
      ['OBJ of triangles without UVs', 'import_scene.obj', file(text(obj))],
      ['GLB', 'import_scene.gltf', file(exported('glb'))],
      ['GLB of 4 meshes on one grid, without TEXCOORD_0', 'import_scene.gltf', file(sharedGlb(4))],
    ];
    for (const [label, id, params] of cases) {
      const { added, counted } = addedAndCounted(id, params);
      expect(counted, label).toBeGreaterThan(0);
      // within a few percent (the STL's welded vertices are counted from hashes of their positions)
      expect(Math.abs(added / counted - 1), `${label}: ${added} added, ${counted} counted`).toBeLessThan(
        0.03,
      );
    }
  });
});

describe('the images of a glTF import', () => {
  /** A GLB of one textured triangle whose image takes `imageBytes` bytes of a buffer view, and an unused image. */
  function texturedGlb(imageBytes: number): Uint8Array {
    const png = new Uint8Array(imageBytes).fill(7);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const geometry = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);
    const bin = new Uint8Array(geometry.byteLength + 2 * imageBytes);
    bin.set(new Uint8Array(geometry.buffer));
    bin.set(png, geometry.byteLength);
    bin.set(png, geometry.byteLength + imageBytes);
    return glb(
      {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, {}],
        textures: [{ source: 0 }, { source: 1 }],
        images: [
          { bufferView: 2, mimeType: 'image/png' },
          // no material of an imported mesh uses it: not imported
          { bufferView: 3, mimeType: 'image/png' },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
          { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 24 },
          { buffer: 0, byteOffset: geometry.byteLength, byteLength: imageBytes },
          { buffer: 0, byteOffset: geometry.byteLength + imageBytes, byteLength: imageBytes },
        ],
        buffers: [{ byteLength: bin.byteLength }],
      },
      bin,
    );
  }

  it('are counted in the peak, in what the project keeps and in what its save takes', () => {
    const imageBytes = 3 << 20;
    const bytes = texturedGlb(imageBytes);
    const json = readGltfJson(bytesReader(bytes))!;
    expect(gltfImportSize(json.json, json.chars)).toMatchObject({
      imageBytes,
      fileImageBytes: 2 * imageBytes,
    });
    const { added, counted, est, doc } = addedAndCounted('import_scene.gltf', file(bytes));
    // the importer's copy, the document's and the update's: at the peak; the image of no imported
    // material in the file the import holds
    expect(est!.bytes).toBeGreaterThan(
      OPERATOR_FIXED_BYTES +
        IMPORT_BYTES_PER_IMAGE_BYTE * imageBytes +
        IMPORT_BYTES_PER_UNUSED_IMAGE_BYTE * imageBytes,
    );
    expect(est!.lower).toBe('the images embedded in the file (fewer or smaller textures)');
    // what the project keeps: the image once, as the project counts it afterwards
    expect(storedImageBytes(doc)).toBe(imageBytes);
    expect(added).toBeGreaterThanOrEqual(imageBytes);
    expect(Math.abs(added / counted - 1)).toBeLessThan(0.03);
    // a save copies it: SAVE_BYTES_PER_IMAGE_BYTE times its bytes, the rest at saveBytes
    const project = projectObjects(doc);
    expect(project.save).toBe(saveBytes(project.bytes - imageBytes) + SAVE_BYTES_PER_IMAGE_BYTE * imageBytes);
    expect(est!.addedSaveBytes).toBeGreaterThanOrEqual(SAVE_BYTES_PER_IMAGE_BYTE * imageBytes);
  });

  it('of data URIs are counted by the bytes they decode to', () => {
    const png = new Uint8Array(30_000).fill(9);
    const uri = `data:image/png;base64,${base64Encode(png)}`;
    expect(dataUriBytes(uri)).toBe(png.length);
    expect(dataUriBytes('data:text/plain,a%20b')).toBe(3);
    expect(dataUriBytes('textures/wood.png')).toBe(0);
    const geometry = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      materials: [
        // an emission texture is imported with an emission color only: the base color's is
        { emissiveTexture: { index: 1 }, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      ],
      textures: [{ source: 0 }, { source: 1 }],
      images: [{ uri }, { uri: `data:image/png;base64,${base64Encode(new Uint8Array(5000))}` }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 24 },
      ],
      buffers: [
        {
          byteLength: geometry.byteLength,
          uri: `data:application/octet-stream;base64,${base64Encode(new Uint8Array(geometry.buffer))}`,
        },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(gltf));
    const json = readGltfJson(bytesReader(bytes))!;
    expect(gltfImportSize(json.json, json.chars).imageBytes).toBe(png.length);
    const { counted, added, doc } = addedAndCounted('import_scene.gltf', file(bytes));
    expect(storedImageBytes(doc)).toBe(png.length);
    expect(Math.abs(added / counted - 1)).toBeLessThan(0.03);
  });
});

describe('an OBJ import', () => {
  it('counts the vertices every object uses, also where objects share them', () => {
    // the vertices of a grid of 40 × 40 quads written once, used by four objects (`o` blocks), the last
    // with negative indices: obj.ts gives every object a copy of the vertices it uses
    const side = 40;
    const n = (side + 1) * (side + 1);
    const quads: number[][] = [];
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const a = y * (side + 1) + x;
        quads.push([a, a + 1, a + side + 2, a + side + 1]);
      }
    const block = (name: string, negative: boolean) =>
      `o ${name}\n` + quads.map((q) => `f ${q.map((i) => (negative ? i - n : i + 1)).join(' ')}\n`).join('');
    const text =
      Array.from({ length: n }, (_, i) => `v ${i % (side + 1)} ${Math.floor(i / (side + 1))} 0\n`).join('') +
      block('A', false) +
      block('B', false) +
      block('C', false) +
      block('D', true);
    const bytes = new TextEncoder().encode(text);
    expect(objImportSize(bytesReader(bytes))).toEqual({
      objects: 5,
      vertices: 4 * n,
      faces: 4 * side * side,
      corners: 16 * side * side,
    });
    const { added, counted, doc } = addedAndCounted('import_scene.obj', file(bytes));
    expect(doc.listObjects()).toHaveLength(4);
    expect(Math.abs(added / counted - 1), `${added} added, ${counted} counted`).toBeLessThan(0.03);
  });
});

describe('the estimate of a glTF import with a large image', () => {
  it('holds above the peak resident memory of the import (child process, the server listeners)', () => {
    // a GLB of one triangle with a PNG of 40 MB: the decoded file, the importer's copy, the document's,
    // the update and its sync frame peaked at 5.0 times the image's bytes
    const run = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=2048',
        '--import',
        'tsx',
        path.join(here, 'operator-memory-rss-child.ts'),
        'image',
        '40',
      ],
      {
        encoding: 'utf8',
        cwd: here,
        timeout: 25_000,
        env: { ...process.env, MALLOC_MMAP_THRESHOLD_: '131072' },
      },
    );
    const line = run.stdout.split('\n').find((l) => l.startsWith('{'));
    expect(line, run.stderr).toBeDefined();
    const r = JSON.parse(line!) as { estimate: number; stored: number; peak: number };
    // the image as the project keeps it
    expect(r.stored).toBeGreaterThanOrEqual(40 << 20);
    if (r.peak < 0) return;
    expect(r.estimate).toBeGreaterThanOrEqual(1.1 * r.peak);
    expect(r.estimate).toBeLessThan(3 * r.peak);
  }, 30_000);
});
