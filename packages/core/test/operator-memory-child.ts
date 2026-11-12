// Runs one operator (or decodes one mesh, or evaluates one curve or text) in a child process for
// operator-memory.test.ts, which starts it with --expose-gc --trace-gc: prints the estimate, then
// '#MARK before', runs, '#MARK done' and a JSON line; the parent reads the peak heap between the
// marks from V8's GC lines.
//   argv: <operator | 'decode' | 'curve'> <grid size n (scatter: instances)> <params JSON (curve: its data)>
//         <'edit' | 'object' | 'scatter' | 'import' | 'CURVE' | 'FONT'>
//   import: the grid of n × n faces exported in the format of the import operator, imported from base64
//   shared-glb: a GLB of `meshes` (params) glTF meshes that all use the accessors of one grid of n × n
//     quads, imported with the operator
//   loose: n loose quads in one mesh, in Edit Mode with everything selected
//   cubes: n linked cubes in a row, all selected (bakes to keyframes)
//   baked: n linked cubes in a row baked over frames 1-30, and a cube 'Solo' (not baked) selected
//   keyed: a cube whose location x has n keyframes (frames 1 … n), with a listener on the document's
//     updates as the server's; params `{"__between": true}` insert n keyframes between them (frames
//     1.5 … n + 0.5) with anim.keyframes_insert_many, `{"__fresh": true}` n keyframes on location y
//   rigid: n ACTIVE rigid body cubes in a grid falling on a PASSIVE floor, the cubes selected
import v8 from 'node:v8';
import { createEditorState, createOperatorRegistry, estimateOperator } from '../src/operators';
import { selectAllElements } from '../src/mesh/selection';
import { createGrid } from '../src/mesh/primitives';
import { decodeMesh, encodeMesh, peekMeshLayout } from '../src/mesh/codec';
import { decodedMeshBytes } from '../src/mesh/memory';
import { SceneDoc } from '../src/doc/scene-doc';
import { SceneEvaluator, TEXT_BYTES_PER_CHARACTER, estimateCurveSurface, textGlyphCount } from '../src/eval';
import { exportScene } from '../src/io';
import { base64Encode } from '../src/util/json';
import { createMesh } from '../src/mesh/types';

/** A GLB of `meshes` glTF meshes that all use the positions and indices of one grid of n × n quads. */
function sharedGlb(n: number, meshes: number): Uint8Array {
  const V = (n + 1) * (n + 1);
  const pos = new Float32Array(3 * V);
  for (let y = 0, i = 0; y <= n; y++) for (let x = 0; x <= n; x++, i++) pos.set([x / n, 0, y / n], 3 * i);
  const idx = new Uint32Array(6 * n * n);
  for (let y = 0, t = 0; y < n; y++)
    for (let x = 0; x < n; x++, t++) {
      const a = y * (n + 1) + x;
      idx.set([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1], 6 * t);
    }
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer));
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
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
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const file = new Uint8Array(28 + jsonLength + bin.byteLength);
  const dv = new DataView(file.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, file.byteLength, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  file.fill(0x20, 20, 20 + jsonLength);
  file.set(json, 20);
  dv.setUint32(20 + jsonLength, bin.byteLength, true);
  dv.setUint32(24 + jsonLength, 0x004e4942, true);
  file.set(bin, 28 + jsonLength);
  return file;
}

const [op, nArg, paramsJson, mode] = process.argv.slice(2);
const n = Number(nArg);
const gc = (globalThis as { gc?: () => void }).gc!;
const used = () => v8.getHeapStatistics().used_heap_size;
const MB = 1024 * 1024;

if (op === 'curve') {
  // __zigzag: n points of a POLY spline that turns sharply at every point; __wave: n points of a
  // Bezier spline; __text: a text of that many characters
  const { __zigzag, __wave, __text, ...data } = JSON.parse(paramsJson) as Record<string, unknown>;
  const point = (co: number[]) => ({
    co,
    handle_left: null,
    handle_right: null,
    handle_left_type: 'AUTO',
    handle_right_type: 'AUTO',
    radius: 1,
    tilt: 0,
    weight: 1,
  });
  const spline = (type: string, co: number[][]) => ({
    type,
    points: co.map(point),
    use_cyclic_u: false,
    resolution_u: 0,
    order_u: 4,
    use_endpoint_u: true,
    use_smooth: true,
    material_index: 0,
  });
  if (__zigzag)
    data.splines = [
      spline(
        'POLY',
        Array.from({ length: Number(__zigzag) }, (_, i) => [i * 0.1, (i % 2) * 0.5, 0]),
      ),
    ];
  if (__wave)
    data.splines = [
      spline(
        'BEZIER',
        Array.from({ length: Number(__wave) }, (_, i) => [i * 0.1, Math.sin(0.3 * i), Math.cos(0.2 * i)]),
      ),
    ];
  if (__text)
    data.body = 'The quick brown fox jumps over the lazy dog 0123456789 '
      .repeat(Math.ceil(Number(__text) / 55))
      .slice(0, Number(__text));
  const doc = SceneDoc.create({ empty: true });
  const id = doc.addCurve(data);
  doc.addObject({ type: mode as 'CURVE' | 'FONT', name: 'Curve', data: id });
  const curve = doc.getCurve(id)!;
  const estimate = estimateCurveSurface(curve, { isText: mode === 'FONT', forRender: false });
  gc();
  gc();
  console.log(`#MARK before ${(used() / MB).toFixed(1)}`);
  const ev = new SceneEvaluator(doc).evaluate(1);
  console.log(`#MARK done ${(used() / MB).toFixed(1)}`);
  const mesh = ev.objects[0].mesh;
  // a curve without a surface has its wire
  console.log(
    JSON.stringify({
      ok: !!mesh || !!ev.objects[0].lines,
      estimate,
      glyphBytes: textGlyphCount(curve.body) * TEXT_BYTES_PER_CHARACTER,
      vertices: mesh ? mesh.positions.length / 3 : 0,
    }),
  );
} else if (op === 'decode') {
  const bytes = encodeMesh(createGrid({ x_subdivisions: n, y_subdivisions: n }));
  gc();
  gc();
  const before = used();
  const mesh = decodeMesh(bytes);
  gc();
  gc();
  const after = used();
  console.log(
    JSON.stringify({
      measured: after - before,
      estimate: decodedMeshBytes(peekMeshLayout(bytes)),
      faces: mesh.faces.length,
    }),
  );
} else {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx = { doc, state, origin: { type: 'test' }, source: 'test' as const, report: () => undefined };
  let paramsText = paramsJson;
  if (mode === 'scatter') {
    // n instances of a plane scattered over a ground plane (the pebble hidden in renders)
    for (const [id, params] of [
      ['mesh.primitive_plane_add', { size: 20, name: 'Ground' }],
      ['mesh.primitive_plane_add', { size: 0.1, location: [0, 0, 5], name: 'Pebble' }],
      ['object.scatter_add', { surface: 'Ground', objects: ['Pebble'], count: n }],
    ] as const) {
      const r = reg.run(ctx, id, params);
      if (!r.ok) throw new Error(`${id}: ${r.error}`);
    }
  } else if (mode === 'shared-glb') {
    const { meshes, ...rest } = JSON.parse(paramsJson) as { meshes: number };
    paramsText = JSON.stringify({ ...rest, data_base64: base64Encode(sharedGlb(n, meshes)) });
  } else if (mode === 'loose') {
    const positions: number[] = [];
    const faces: number[][] = [];
    for (let i = 0; i < n; i++) {
      const x = 2 * (i % 300);
      const y = 2 * Math.floor(i / 300);
      positions.push(x, y, 0, x + 1, y, 0, x + 1, y + 1, 0, x, y + 1, 0);
      faces.push([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3]);
    }
    const meshId = doc.addMesh('Parts', createMesh({ positions, faces }));
    const id = doc.addObject({ type: 'MESH', name: 'Parts', data: meshId });
    state.selectedIds = [id];
    state.activeId = id;
    state.mode = 'EDIT';
    state.meshSelection = selectAllElements(doc.getMesh(meshId)!);
  } else if (mode === 'cubes' || mode === 'rigid' || mode === 'baked') {
    const run = (id: string, params: object) => {
      const r = reg.run(ctx, id, params);
      if (!r.ok) throw new Error(`${id}: ${r.error}`);
    };
    run('mesh.primitive_cube_add', { name: 'Cube' });
    if (mode === 'rigid') run('rigidbody.object_add', { type: 'ACTIVE' });
    const side = Math.ceil(Math.sqrt(n));
    if (n > 1)
      run(
        'object.array_place',
        mode === 'rigid'
          ? {
              objects: ['Cube'],
              linked: true,
              pattern: 'GRID',
              columns: side,
              rows: Math.ceil(n / side),
              offset: [2.05, 2.05, 0],
            }
          : { objects: ['Cube'], linked: true, count: n, offset: [3, 0, 0] },
      );
    const cubes = doc.objectIds();
    if (mode === 'rigid') {
      run('mesh.primitive_plane_add', { name: 'Floor', size: 400, location: [0, 0, -3] });
      run('rigidbody.object_add', { type: 'PASSIVE' });
    }
    state.selectedIds = cubes;
    state.activeId = cubes[0];
    if (mode === 'baked') {
      run('anim.bake_transforms', { frame_start: 1, frame_end: 30 });
      run('mesh.primitive_cube_add', { name: 'Solo', location: [0, 0, 5] });
    }
  } else if (mode === 'keyed') {
    const frames = Array.from({ length: n }, (_, i) => i + 1);
    const keys = { target: 'Cube', path: 'location', index: 0, frames, values: frames };
    for (const [id, params] of [
      ['mesh.primitive_cube_add', { name: 'Cube' }],
      ['anim.keyframes_insert_many', keys],
    ] as const) {
      const r = reg.run(ctx, id, params);
      if (!r.ok) throw new Error(`${id}: ${r.error}`);
    }
    const { __between, __fresh } = JSON.parse(paramsJson) as { __between?: boolean; __fresh?: boolean };
    if (__between) paramsText = JSON.stringify({ ...keys, frames: frames.map((f) => f + 0.5) });
    if (__fresh) paramsText = JSON.stringify({ ...keys, index: 1 });
    // the server's process encodes every transaction's update for its listeners
    let updates = 0;
    doc.ydoc.on('update', (u: Uint8Array) => (updates += u.byteLength));
  } else if (mode === 'import') {
    const source = SceneDoc.create({ empty: true });
    const id = source.addMesh('Grid', createGrid({ x_subdivisions: n, y_subdivisions: n }));
    source.addObject({ type: 'MESH', name: 'Grid', data: id });
    const format = op.split('.')[1] as 'stl' | 'obj' | 'ply' | 'gltf';
    const file = exportScene(source, format === 'gltf' ? 'glb' : format).data;
    paramsText = JSON.stringify({ data_base64: base64Encode(file) });
  } else if (n > 0) {
    const meshId = doc.addMesh('Grid', createGrid({ x_subdivisions: n, y_subdivisions: n }));
    const id = doc.addObject({ type: 'MESH', name: 'Grid', data: meshId });
    state.selectedIds = [id];
    state.activeId = id;
    // an open project has its meshes decoded
    const mesh = doc.getMesh(meshId)!;
    if (mode === 'edit') {
      state.mode = 'EDIT';
      state.meshSelection = selectAllElements(mesh);
    }
  }
  const params = JSON.parse(paramsText || '{}') as Record<string, unknown>;
  const estimate = estimateOperator(op, ctx, reg.parseParams(op, params));
  gc();
  gc();
  console.log(`#MARK before ${(used() / MB).toFixed(1)}`);
  const res = reg.run(ctx, op, params);
  console.log(`#MARK done ${(used() / MB).toFixed(1)}`);
  console.log(JSON.stringify({ ok: res.ok, error: res.error, estimate }));
}
