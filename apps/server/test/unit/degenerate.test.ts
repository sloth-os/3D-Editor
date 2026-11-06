import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  TextureCache,
  createEditorState,
  createOperatorRegistry,
  preparePathTrace,
  renderItems,
  resolveView,
  evaluatedBounds,
  viewCameraData,
} from '@3d-editor/core';
import { degenerateTriangleCount, nameDegenerateTriangles } from '../../src/render/degenerate';

/*
 * The path tracer's "N degenerate triangle(s) skipped" warning named no object, so agents had to
 * bisect their scene with hide_render (clockwork-orrery v2 #0). The render threads now add the
 * objects, counted like the core scene compiler counts them.
 */

const registry = createOperatorRegistry();

function sceneWithDegenerateFaces(): SceneDoc {
  const doc = SceneDoc.create({ name: 'Degenerate' });
  const ctx = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  } as Parameters<typeof registry.run>[0];
  // face 0 is a zero-area triangle (three points on a line), face 1 a proper one
  const res = registry.run(ctx, 'object.add_mesh_from_data', {
    name: 'Motto Plate',
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0, 1, 0],
    ],
    faces: [
      [0, 1, 2],
      [0, 1, 3],
    ],
  });
  expect(res.ok).toBe(true);
  return doc;
}

function compile(doc: SceneDoc) {
  const scene = new SceneEvaluator(doc).evaluate(1, { forRender: true });
  const items = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
  const view = resolveView(doc, scene, { width: 32, height: 24 }, 32 / 24, evaluatedBounds(items));
  const prepared = preparePathTrace({
    scene,
    items,
    view,
    camera: viewCameraData(doc, scene, {}),
    width: 32,
    height: 24,
    images: new TextureCache(doc),
    options: { samples: 1 },
  });
  return { items, warnings: [...prepared.scene.warnings] };
}

describe('degenerate triangle warnings', () => {
  it('names the objects with the count the scene compiler reports', () => {
    const { items, warnings } = compile(sceneWithDegenerateFaces());
    expect(warnings).toContain('1 degenerate triangle(s) skipped');
    const plate = items.find((i) => i.object.name === 'Motto Plate')!;
    expect(degenerateTriangleCount(plate.mesh)).toBe(1);
    const named = nameDegenerateTriangles(warnings, items);
    expect(named.find((w) => w.startsWith('1 degenerate'))).toBe(
      "1 degenerate triangle(s) skipped (zero-area or non-finite faces of the render geometry; they do not render): 'Motto Plate' 1",
    );
  });

  it('names every object sharing a mesh once and leaves other warnings alone', () => {
    const doc = sceneWithDegenerateFaces();
    const plate = doc.listObjects().find((o) => o.name === 'Motto Plate')!;
    // a linked duplicate shares the mesh: the compiler counts the mesh once
    const ctx = {
      doc,
      state: { ...createEditorState(), selectedIds: [plate.id], activeId: plate.id },
      origin: doc.origin,
      source: 'test',
      report: () => undefined,
    } as Parameters<typeof registry.run>[0];
    expect(registry.run(ctx, 'object.duplicate', { linked: true, offset: [0, 3, 0] }).ok).toBe(true);
    const { items, warnings } = compile(doc);
    expect(warnings).toContain('1 degenerate triangle(s) skipped');
    const named = nameDegenerateTriangles(['texture missing', ...warnings], items);
    expect(named[0]).toBe('texture missing');
    expect(named.find((w) => w.startsWith('1 degenerate'))).toMatch(/'Motto Plate', 'Motto Plate\.001' 1$/);
  });

  it('keeps the warnings when there is nothing to name', () => {
    expect(nameDegenerateTriangles(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
