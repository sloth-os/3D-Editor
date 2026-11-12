// Runs one operator in a child process for operator-memory-layers.test.ts and
// operator-memory-imports.test.ts and measures its peak resident memory: vertex group weights and
// images live outside the JavaScript heap, which --trace-gc does not show. The document has the
// listeners the server's process puts on a project's document: an undo manager tracking the
// operator's origin (an agent's history) and a copy of every update into a sync frame (the project's
// room). The parent starts it with MALLOC_MMAP_THRESHOLD_ set, so that freed memory goes back to the
// system at once and the peak is what the run held. Prints one JSON line (peak -1 where the process
// cannot reset its peak resident memory, outside Linux).
//   argv: parent <grid size n> <bones> <parent type>: object.parent_set of a grid of n × n quads to an
//         armature of `bones` + 1 bones
//         image <MB>: import_scene.gltf of a GLB of one triangle whose material has a PNG of that size
import { readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { createEditorState, createOperatorRegistry, estimateOperator } from '../src/operators';
import { SceneDoc } from '../src/doc/scene-doc';
import { base64Encode } from '../src/util/json';

const [scenario, ...args] = process.argv.slice(2);
const gc = (globalThis as { gc?: () => void }).gc!;
const status = (key: string): number =>
  Number(new RegExp(`${key}:\\s+(\\d+)`).exec(readFileSync('/proc/self/status', 'utf8'))![1]) * 1024;

const origin = { type: 'agent' };
const doc = new SceneDoc(SceneDoc.create({ empty: true }).ydoc, origin);
const undo = new Y.UndoManager(
  ['objects', 'meshes', 'armatures', 'materials', 'images'].map((k) => doc.ydoc.getMap(k)),
  { trackedOrigins: new Set([origin]), captureTimeout: 0 },
);
let framed = 0;
doc.ydoc.on('update', (update: Uint8Array) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, update);
  framed += encoding.toUint8Array(enc).byteLength;
});
const reg = createOperatorRegistry();
const state = createEditorState();
const ctx = { doc, state, origin, source: 'test' as const, report: () => undefined };
const run = (id: string, params: object) => {
  const r = reg.run(ctx, id, params);
  if (!r.ok) throw new Error(`${id}: ${r.error}`);
};

/** A GLB of one triangle whose material's base color texture is an image of `bytes` bytes (a PNG header, random data). */
function imageGlb(bytes: number): Uint8Array {
  const tri = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const img = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) img[i] = (i * 2654435761) >>> 24;
  img.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const binLength = Math.ceil((36 + bytes) / 4) * 4;
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: bytes },
      ],
      buffers: [{ byteLength: binLength }],
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const file = new Uint8Array(28 + jsonLength + binLength);
  const dv = new DataView(file.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, file.byteLength, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  file.fill(0x20, 20, 20 + jsonLength);
  file.set(json, 20);
  dv.setUint32(20 + jsonLength, binLength, true);
  dv.setUint32(24 + jsonLength, 0x004e4942, true);
  file.set(tri, 28 + jsonLength);
  file.set(img, 28 + jsonLength + 36);
  return file;
}

let op: string;
let params: Record<string, unknown>;
if (scenario === 'parent') {
  const [n, bones] = args.slice(0, 2).map(Number);
  run('mesh.primitive_grid_add', { name: 'Grid', x_subdivisions: n, y_subdivisions: n, size: 10 });
  run('object.armature_add', { name: 'Rig' });
  const points = Array.from({ length: bones + 1 }, (_, i) => [-5 + (10 * i) / bones, 0, 0.5]);
  run('armature.chain_add', { object: 'Rig', points });
  const grid = doc.listObjects().find((o) => o.name === 'Grid')!;
  const rig = doc.listObjects().find((o) => o.name === 'Rig')!;
  state.selectedIds = [grid.id, rig.id];
  state.activeId = rig.id;
  op = 'object.parent_set';
  params = { type: args[2] };
} else if (scenario === 'image') {
  op = 'import_scene.gltf';
  params = { data_base64: base64Encode(imageGlb(Math.round(Number(args[0]) * 1024 * 1024))) };
} else throw new Error(`unknown scenario ${scenario}`);
const estimate = estimateOperator(op, ctx, reg.parseParams(op, params))!;
gc();
gc();
let peak = -1;
try {
  // resets the peak resident memory (VmHWM) to what the process holds now
  writeFileSync('/proc/self/clear_refs', '5');
  const before = status('VmRSS');
  run(op, params);
  peak = status('VmHWM') - before;
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EACCES' && (err as NodeJS.ErrnoException).code !== 'ENOENT')
    throw err;
  run(op, params);
}
undo.destroy();
console.log(
  JSON.stringify({
    estimate: estimate.bytes,
    written: estimate.layers?.bytes ?? 0,
    stored: estimate.addedStoredBytes,
    peak,
    framed,
  }),
);
