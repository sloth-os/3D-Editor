import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildPalette,
  exportRenderDocumentFromUpdate,
  measureDeskShot,
  paletteRecord,
  planExport,
  poseActorsOf,
  qualityPreset,
  renderExportFrame,
  sceneFrameAt,
  shotDeskOptions,
  shotRenderFrames,
  stringLines,
  videoExportParamsSchema,
  type ImageResult,
  type PassName,
} from '@3d-editor/core';

/*
 * The frames of a video export as core renders them in Node (what the server's render processes
 * run), for the browser export's parity check: reads a project snapshot (a Yjs update) on stdin and
 * the export's parameters (JSON) as the first argument, and prints, by `${shot}:${frame}`, the
 * SHA-256 of every rendered frame's raw passes (as the browser's render workers report them:
 * apps/web/src/export/worker-engine.ts frameDigests) and its metadata. Run with `node --import tsx`.
 */

const sha = (b: Uint8Array | Uint8ClampedArray) =>
  createHash('sha256')
    .update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
    .digest('hex');

function digests(img: ImageResult): Record<string, string> {
  const out: Record<string, string> = {};
  if (img.data) out.beauty = sha(img.data);
  for (const [pass, bytes] of Object.entries(img.passes ?? {})) if (bytes) out[pass] = sha(bytes);
  return out;
}

const update = new Uint8Array(readFileSync(0));
const params = videoExportParamsSchema.parse(JSON.parse(process.argv[2] ?? '{}'));
const entry = exportRenderDocumentFromUpdate(update);
const plan = planExport(entry.doc, params);
const passes = [...new Set(params.passes)] as PassName[];
const preset = qualityPreset(params.quality, plan.width, plan.height);
const subjects = new Set(plan.shots.flatMap((s) => s.shot?.subjects ?? []));
const objectPalette = paletteRecord(buildPalette(entry.doc, subjects));
const poseActors = poseActorsOf(entry.doc);
const lines = stringLines(entry.doc, plan.height);
const out: Record<string, { digests: Record<string, string>; meta: ImageResult['meta'] | null }> = {};
for (const shot of plan.shots) {
  const info = measureDeskShot(entry, {
    frames: shotRenderFrames(plan, shot),
    cameraId: shot.camera,
    aspect: plan.width / plan.height,
  });
  const desk = shotDeskOptions({
    look: params.look,
    preset,
    passes,
    info,
    objectPalette,
    shot,
    poseActors,
    lines,
  });
  for (let k = 0; k < shot.renderFrames; k++) {
    const img = renderExportFrame(entry, {
      width: plan.width,
      height: plan.height,
      frame: sceneFrameAt(plan, shot, k),
      engine: 'RASTER',
      cameraId: shot.camera,
      samples: preset.samples,
      desk,
    });
    out[`${shot.id}:${k}`] = { digests: digests(img), meta: img.meta ?? null };
  }
}
process.stdout.write(JSON.stringify(out));
