import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  base64Decode,
  base64Encode,
  createEditorState,
  createOperatorRegistry,
  decodePNG,
  type OperatorContext,
} from '../src';

function setup(empty = false) {
  const doc = SceneDoc.create({ empty, name: 'My Scene' });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push({ level, message }),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  return { doc, reg, ctx, run, reports };
}

describe('IO operators', () => {
  it('registers import/export/render operators with the expected undo behaviour', () => {
    const { reg } = setup();
    for (const id of ['import_scene.gltf', 'import_scene.obj', 'import_mesh.stl', 'import_mesh.ply'])
      expect(reg.get(id)?.undo).not.toBe(false);
    for (const id of [
      'export_scene.gltf',
      'export_scene.obj',
      'export_mesh.stl',
      'export_mesh.ply',
      'render.render_software',
    ])
      expect(reg.get(id)?.undo).toBe(false);
    const info = reg.describe().find((o) => o.id === 'export_scene.gltf')!;
    expect(JSON.stringify(info.parameters)).toContain('GLTF_EMBEDDED');
  });

  it('exports glTF and imports it back as one undo step with the new objects selected', () => {
    const src = setup();
    const exp = src.run('export_scene.gltf', { export_format: 'GLB' });
    expect(exp.ok).toBe(true);
    expect(exp.result).toMatchObject({ filename: 'My_Scene.glb', mime: 'model/gltf-binary' });
    const bytes = base64Decode(exp.result.data_base64);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF');

    const dst = setup(true);
    const um = new Y.UndoManager(dst.doc.sharedTypes(), {
      trackedOrigins: new Set([dst.doc.origin]),
      captureTimeout: 0,
    });
    const imp = dst.run('import_scene.gltf', { data_base64: exp.result.data_base64, location: [0, 0, 1] });
    expect(imp.ok).toBe(true);
    expect(imp.result.objects).toHaveLength(3);
    expect(dst.ctx.state.selectedIds).toEqual(imp.result.objects);
    expect(dst.ctx.state.activeId).toBe(imp.result.objects[0]);
    expect(dst.doc.findObjectByName('Cube')!.location).toEqual([0, 0, 1].map((v) => expect.closeTo(v, 6)));
    um.undo();
    expect(dst.doc.listObjects()).toHaveLength(0);

    const embedded = src.run('export_scene.gltf', { export_format: 'GLTF_EMBEDDED', filename: 'out' });
    expect(embedded.result.filename).toBe('out.gltf');
    const again = setup(true);
    expect(
      again.run('import_scene.gltf', { data_base64: embedded.result.data_base64 }).result.objects,
    ).toHaveLength(3);
  });

  it('round-trips OBJ, STL and PLY through operators, honouring use_selection', () => {
    const src = setup();
    expect(src.run('export_mesh.stl', { use_selection: true }).error).toMatch(/No objects selected/);
    src.run('object.select', { objects: ['Cube'] });
    for (const [exp, imp, ext] of [
      ['export_scene.obj', 'import_scene.obj', 'obj'],
      ['export_mesh.stl', 'import_mesh.stl', 'stl'],
      ['export_mesh.ply', 'import_mesh.ply', 'ply'],
    ] as const) {
      const out = src.run(exp, { use_selection: true });
      expect(out.ok, exp).toBe(true);
      expect(out.result.filename).toBe(`My_Scene.${ext}`);
      const dst = setup(true);
      const res = dst.run(imp, { data_base64: out.result.data_base64, name: 'Imported' });
      expect(res.ok, imp).toBe(true);
      expect(res.result.objects).toHaveLength(1);
      const o = dst.doc.getObject(res.result.objects[0])!;
      expect(dst.doc.getMesh(o.data!)!.positions.length).toBeGreaterThanOrEqual(8 * 3);
    }
  });

  it('reports invalid input and requires object mode for imports', () => {
    const { run, ctx, reports } = setup(true);
    const bad = run('import_scene.gltf', {
      data_base64: base64Encode(new TextEncoder().encode('{"nope":1}')),
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Import failed/);
    expect(reports.some((r) => r.level === 'ERROR')).toBe(true);
    ctx.state.mode = 'EDIT';
    expect(run('import_mesh.stl', { data_base64: 'AAAA' }).error).toMatch(/Object Mode/);
  });

  it('renders a PNG with the software renderer', () => {
    const { run, doc } = setup();
    const r = run('render.render_software', { width: 64, shading: 'SOLID' });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ mime: 'image/png', width: 64, height: 36 });
    const img = decodePNG(base64Decode(r.result.data_base64));
    expect([img.width, img.height]).toEqual([64, 36]);
    const def = run('render.render_software', {});
    expect([def.result.width, def.result.height]).toEqual([800, 450]);
    expect(run('render.render_software', { width: 8, height: 8, camera: 'Cube' }).error).toMatch(/not found/);
    const cam = doc.findObjectByName('Camera')!;
    expect(run('render.render_software', { width: 8, height: 8, camera: cam.name }).ok).toBe(true);
  });
});
