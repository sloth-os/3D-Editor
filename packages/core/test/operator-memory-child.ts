// Runs one operator (or decodes one mesh, or evaluates one curve or text) in a child process for
// operator-memory.test.ts, which starts it with --expose-gc --trace-gc: prints the estimate, then
// '#MARK before', runs, '#MARK done' and a JSON line; the parent reads the peak heap between the
// marks from V8's GC lines.
//   argv: <operator | 'decode' | 'curve'> <grid size n (scatter: instances)> <params JSON (curve: its data)>
//         <'edit' | 'object' | 'scatter' | 'CURVE' | 'FONT'>
import v8 from 'node:v8';
import { createEditorState, createOperatorRegistry, estimateOperator } from '../src/operators';
import { selectAllElements } from '../src/mesh/selection';
import { createGrid } from '../src/mesh/primitives';
import { decodeMesh, encodeMesh, peekMeshLayout } from '../src/mesh/codec';
import { decodedMeshBytes } from '../src/mesh/memory';
import { SceneDoc } from '../src/doc/scene-doc';
import { SceneEvaluator, TEXT_BYTES_PER_CHARACTER, estimateCurveSurface, textGlyphCount } from '../src/eval';

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
  const params = JSON.parse(paramsJson || '{}') as Record<string, unknown>;
  const estimate = estimateOperator(op, ctx, reg.parseParams(op, params));
  gc();
  gc();
  console.log(`#MARK before ${(used() / MB).toFixed(1)}`);
  const res = reg.run(ctx, op, params);
  console.log(`#MARK done ${(used() / MB).toFixed(1)}`);
  console.log(JSON.stringify({ ok: res.ok, error: res.error, estimate }));
}
