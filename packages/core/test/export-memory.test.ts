import { describe, expect, it } from 'vitest';
import { SceneDoc, createCube, createGrid, type ModifierData } from '../src';
import {
  RENDER_HEAP_BYTES_PER_TRIANGLE,
  estimateRenderMemory,
  estimateRenderTriangles,
  exportRenderEstimate,
} from '../src/export/memory';
import { qualityPreset } from '../src/export/params';
import { resultBytes } from '../src/export/passes';
import { estimateRenderBufferBytes } from '../src/render';

/*
 * What rendering takes of a render thread's memory, estimated without evaluating the scene: the
 * geometry's heap (the server's guards for renders in its own process use it) and what one render
 * thread of a video export holds (the server plans its render processes with it, the browser export
 * its render workers).
 */

const subsurf = (params: Record<string, unknown>): ModifierData => ({
  id: 'm1',
  name: 'Subdivision',
  type: 'SUBSURF',
  show_viewport: true,
  show_render: true,
  show_in_editmode: true,
  show_expanded: true,
  params,
});

function scene(): SceneDoc {
  return SceneDoc.create({ name: 'memory', empty: true });
}

function addGrid(doc: SceneDoc, n: number, name = 'Grid'): string {
  return doc.addObject({
    type: 'MESH',
    name,
    data: doc.addMesh(name, createGrid({ x_subdivisions: n, y_subdivisions: n })),
  });
}

describe('renders', () => {
  it('estimate the triangles of a render from the stored meshes and their generating modifiers', () => {
    const doc = scene();
    const grid = addGrid(doc, 10); // 200 triangles
    expect(estimateRenderTriangles(doc)).toBe(200);
    doc.updateObject(grid, {
      modifiers: [
        {
          id: 'm1',
          name: 'Subdivision',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { levels: 1, render_levels: 2 },
        },
        {
          id: 'm2',
          name: 'Array',
          type: 'ARRAY',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { count: 3 },
        },
        {
          id: 'm3',
          name: 'Mirror',
          type: 'MIRROR',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { use_axis: [true, true, false] },
        },
        {
          id: 'm4',
          name: 'Off',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: false,
          show_in_editmode: true,
          show_expanded: true,
          params: { render_levels: 3 },
        },
      ],
    });
    expect(estimateRenderTriangles(doc)).toBe(200 * 16 * 3 * 4);
    // objects hidden from renders are left out; a linked duplicate with the same stack counts once
    const cube = doc.addObject({ type: 'MESH', name: 'Cube', data: doc.addMesh('Cube', createCube()) });
    doc.addObject({ type: 'MESH', name: 'Cube 2', data: doc.getObject(cube)!.data! });
    expect(estimateRenderTriangles(doc)).toBe(200 * 16 * 3 * 4 + 12);
    doc.updateObject(cube, { hide_render: true });
    expect(estimateRenderTriangles(doc)).toBe(200 * 16 * 3 * 4 + 12);
  });

  it('estimate the heap of a render: its meshes, the peak of their modifiers, the render of their result', () => {
    const doc = scene();
    const grid = addGrid(doc, 100); // 20,000 triangles
    expect(estimateRenderMemory(doc)).toEqual({
      triangles: 20_000,
      bytes: 20_000 * RENDER_HEAP_BYTES_PER_TRIANGLE,
    });
    // one level: 40,000 quads (80,000 triangles); the subdivision's peak (700 bytes per face,
    // 28,000,000) is more than the render of its result (320 bytes per triangle, 25,600,000)
    doc.updateObject(grid, { modifiers: [subsurf({ levels: 0, render_levels: 1 })] });
    expect(estimateRenderMemory(doc)).toEqual({
      triangles: 80_000,
      bytes: 20_000 * RENDER_HEAP_BYTES_PER_TRIANGLE + 40_000 * 700,
    });
  });
});

describe('a render thread of a video export', () => {
  it('holds the scene, the renderer buffers of its passes and twice the frame it sends', () => {
    const doc = scene();
    addGrid(doc, 100);
    const passes = ['beauty', 'depth', 'pose'] as const;
    const preset = qualityPreset('draft', 1280, 720);
    const frame = resultBytes([...passes], 1280, 720);
    const e = exportRenderEstimate(doc, {
      width: 1280,
      height: 720,
      passes: [...passes],
      look: 'clay',
      preset,
      strings: false,
      resultBytes: frame,
    });
    expect(e.scene).toBe(estimateRenderMemory(doc).bytes);
    expect(e.frame).toBe(2 * frame);
    // the beauty image with shadows and the depth pass the depth and pose passes need
    expect(e.buffers).toBe(
      estimateRenderBufferBytes(
        { width: 1280, height: 720, samples: 1, look: 'clay', shadows: true, ao: false, aovs: ['depth'] },
        doc,
      ),
    );
  });

  it('holds no renderer buffers when nothing is rasterized (a pose pass without strings)', () => {
    const doc = scene();
    addGrid(doc, 10);
    const e = exportRenderEstimate(doc, {
      width: 640,
      height: 360,
      passes: ['pose'],
      look: 'material',
      preset: qualityPreset('standard', 640, 360),
      strings: false,
      resultBytes: resultBytes(['pose'], 640, 360),
    });
    expect(e.buffers).toBe(0);
    // a string in the pose pass is depth-tested: the depth pass is rasterized for it
    const withString = exportRenderEstimate(doc, {
      width: 640,
      height: 360,
      passes: ['pose'],
      look: 'material',
      preset: qualityPreset('standard', 640, 360),
      strings: true,
      resultBytes: resultBytes(['pose'], 640, 360),
    });
    expect(withString.buffers).toBeGreaterThan(0);
  });
});
