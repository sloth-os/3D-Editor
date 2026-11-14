import type { SceneDoc } from '../doc/scene-doc';
import { estimateModifier, meshSize, type MeshSize } from '../eval/memory';
import { modifierContext, modifierRuns } from '../operators/memory';
import { estimateRenderBufferBytes } from '../render';
import type { ScreenLine } from '../render/lines';
import { deskAovs } from './desk-frame';
import type { QualityPreset, VideoExportParams } from './params';
import type { PassName } from './protocol';

/*
 * What rendering takes of a render thread's memory, estimated without evaluating the scene: the
 * scene's geometry in the JavaScript heap (`estimateRenderMemory`; the server's guards for renders
 * in its own process use it too) and, for video exports, what one render thread holds while it
 * renders an export's frames (`exportRenderEstimate`). The server's video export plans its render
 * processes with it (apps/server/src/video/memory.ts), the browser export its render workers
 * (apps/web/src/export/memory.ts).
 */

/**
 * JavaScript heap a render takes per triangle of a mesh without modifiers, the decoded mesh
 * included: 307 bytes measured (a grid of 980,000 triangles, raster and path traced, 320×180),
 * rounded up.
 */
export const RENDER_HEAP_BYTES_PER_TRIANGLE = 320;

const triangles = (s: MeshSize): number => Math.max(0, s.corners - 2 * s.faces);

/**
 * Heap a render of `scene` takes, estimated without evaluating it: each mesh shown in renders
 * (its modifier stack counted once when objects share both) by its stored counts, the modifiers a
 * render runs (core `modifierRuns`: enabled for renders and not disabled by their type's rule) by
 * their estimates (core `estimateModifier`; a Bevel limited by angle by the
 * edges it bevels on the stored mesh when it comes first in the stack, else as if every edge were
 * sharp: core `modifierContext`), and the render of the result.
 */
export function estimateRenderMemory(scene: SceneDoc): { triangles: number; bytes: number } {
  const seen = new Set<string>();
  let tris = 0;
  let bytes = 0;
  for (const o of scene.listObjects()) {
    if (o.type !== 'MESH' || !o.data || o.hide_render) continue;
    // the modifiers a render runs (show_render, and not disabled by their type's rule)
    const mods = o.modifiers.filter((m) => modifierRuns(scene, m, true));
    const key = `${o.data}|${JSON.stringify(mods.map((m) => [m.type, m.params]))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const counts = scene.meshCounts(o.data);
    if (!counts) continue;
    let size: MeshSize = counts;
    // Array with FIT_LENGTH counts its copies from the mesh's size: decode it (the render will)
    if (mods.some((m) => m.type === 'ARRAY' && m.params?.fit_type === 'FIT_LENGTH')) {
      const mesh = scene.getMesh(o.data);
      if (mesh) size = meshSize(mesh, true);
    }
    const base = triangles(size) * RENDER_HEAP_BYTES_PER_TRIANGLE;
    let peaks = 0;
    let first = true;
    for (const m of mods) {
      // a Bevel by angle: counted on the stored mesh when it comes first, else every edge
      const e = estimateModifier(m, size, modifierContext(scene, o, m, first, true));
      first = false;
      peaks += e.bytes;
      size = { ...e.result, extent: size.extent };
    }
    // the decoded mesh stays while the modifiers run; then their result is rendered
    const result = mods.length ? triangles(size) * RENDER_HEAP_BYTES_PER_TRIANGLE : 0;
    tris += triangles(size);
    bytes += base + Math.max(peaks, result);
  }
  return { triangles: tris, bytes };
}

/** Triangles of the meshes a render of `scene` shows, after their modifiers (estimated). */
export function estimateRenderTriangles(scene: SceneDoc): number {
  return estimateRenderMemory(scene).triangles;
}

/** A string stand-in for `estimateRenderBufferBytes` (it reads only whether there are lines). */
const SOME_LINE: ScreenLine[] = [{ a: [0, 0, 0], b: [0, 0, 0], width_px: 2, color: [1, 1, 1] }];

/** The parts of the estimated memory one render thread of an export holds (bytes). */
export interface ExportRenderEstimate {
  /** The snapshot's scene in the JavaScript heap (`estimateRenderMemory`). */
  scene: number;
  /** The renderer's working buffers and returned image (core `estimateRenderBufferBytes`). */
  buffers: number;
  /** The passes of the frame in flight, converted and copied for the coordinating side (twice its result). */
  frame: number;
}

/**
 * What one render thread of an export holds besides its own base and slack: the scene, the
 * renderer's working buffers (none when no pass needs rasterizing, as `renderDeskFrame` renders)
 * and the frame in flight (`resultBytes`: what the thread sends per frame).
 */
export function exportRenderEstimate(
  snapshot: SceneDoc,
  o: {
    width: number;
    height: number;
    passes: readonly PassName[];
    look: VideoExportParams['look'];
    preset: QualityPreset;
    strings: boolean;
    resultBytes: number;
  },
): ExportRenderEstimate {
  const set = new Set(o.passes);
  const beauty = set.has('beauty');
  const aovs = deskAovs(set, o.strings);
  const buffers =
    beauty || aovs.length
      ? estimateRenderBufferBytes(
          {
            width: o.width,
            height: o.height,
            samples: o.preset.samples,
            look: o.look,
            shadows: beauty && o.preset.shadows,
            ao: beauty && o.preset.ao,
            aovs,
            lines: beauty && o.strings ? SOME_LINE : undefined,
          },
          snapshot,
        )
      : 0;
  return { scene: estimateRenderMemory(snapshot).bytes, buffers, frame: 2 * o.resultBytes };
}
