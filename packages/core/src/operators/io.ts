import { z } from 'zod';
import type { Vec3 } from '../math/types';
import { base64Decode, base64Encode } from '../util/json';
import { exportScene, importFile, type ExportFormat, type ImportFormat } from '../io';
import { isGLB } from '../io/glb';
import { safeFileName } from '../io/common';
import { encodePNG, renderSceneSoftware } from '../render';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, selectedObjects, setSelection, vec3 } from './helpers';

/*
 * File import/export and software rendering operators. Files travel as base64 strings so the same
 * operators work from the UI, the scripting console and MCP tools.
 */

const importSchema = z.object({
  data_base64: z.string().min(1).describe('File contents, base64 encoded (a data: URI prefix is accepted)'),
  name: z.string().optional().describe('Base name for created objects when the file has none'),
  location: vec3.optional().describe('World-space offset applied to the imported root objects'),
});

const exportShape = {
  use_selection: z.boolean().default(false).describe('Export only the selected objects'),
  apply_modifiers: z.boolean().default(true).describe('Export meshes with their modifier stacks applied'),
  filename: z.string().optional().describe('Output file name (default: project name)'),
};

function decodeFile(data: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(data.trim());
  } catch {
    throw new OperatorError('data_base64 is not valid base64', 'INVALID_PARAMS');
  }
  if (!bytes.length) throw new OperatorError('The file is empty', 'INVALID_PARAMS');
  return bytes;
}

function runImport(
  ctx: OperatorContext,
  format: ImportFormat,
  bytes: Uint8Array,
  p: z.infer<typeof importSchema>,
) {
  let res: ReturnType<typeof importFile>;
  try {
    res = importFile(ctx.doc, format, bytes, { name: p.name, location: p.location as Vec3 | undefined });
  } catch (err) {
    throw new OperatorError(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
  }
  for (const w of res.warnings) ctx.report('WARNING', w);
  if (res.objects.length) setSelection(ctx, res.objects, res.objects[0]);
  ctx.report('INFO', `Imported ${res.objects.length} object(s)`);
  return {
    objects: res.objects,
    names: res.objects.map((id) => ctx.doc.getObject(id)?.name ?? id),
    warnings: res.warnings,
  };
}

function runExport(
  ctx: OperatorContext,
  format: ExportFormat,
  p: { use_selection: boolean; apply_modifiers: boolean; filename?: string; bake_resolution?: number },
) {
  let objectIds: string[] | undefined;
  if (p.use_selection) {
    objectIds = selectedObjects(ctx).map((o) => o.id);
    if (!objectIds.length)
      throw new OperatorError('No objects selected (use_selection is enabled)', 'POLL_FAILED');
  }
  const res = exportScene(ctx.doc, format, {
    objectIds,
    applyModifiers: p.apply_modifiers,
    frame: ctx.state.frame,
    bakeResolution: p.bake_resolution,
  });
  for (const w of res.warnings ?? []) ctx.report('WARNING', w);
  const base = p.filename?.trim() ? p.filename.trim() : safeFileName(ctx.doc.name, 'scene');
  const filename = base.toLowerCase().endsWith(`.${res.extension}`) ? base : `${base}.${res.extension}`;
  ctx.report('INFO', `Exported ${filename} (${res.data.length} bytes)`);
  return {
    filename,
    mime: res.mime,
    data_base64: base64Encode(res.data),
    size: res.data.length,
    warnings: res.warnings ?? [],
  };
}

export function registerIOOperators(reg: OperatorRegistry): void {
  // ------------------------------------------------------------------ import
  const importOp = (
    id: string,
    label: string,
    description: string,
    format: (bytes: Uint8Array) => ImportFormat,
  ) =>
    reg.register(
      defineOperator({
        id,
        label,
        description,
        category: 'Import',
        schema: importSchema,
        poll: pollObjectMode,
        execute(ctx, p) {
          const bytes = decodeFile(p.data_base64);
          return runImport(ctx, format(bytes), bytes, p);
        },
      }),
    );
  importOp(
    'import_scene.gltf',
    'Import glTF 2.0',
    'Import a glTF 2.0 file (.glb binary or .gltf with embedded data): objects with hierarchy, meshes, materials, textures, cameras, lights and transform animation. Y-up is converted to Z-up.',
    (bytes) => (isGLB(bytes) ? 'glb' : 'gltf'),
  );
  importOp(
    'import_scene.obj',
    'Import Wavefront OBJ',
    'Import a Wavefront OBJ file: one object per o/g group, usemtl material slots, smoothing groups, loose edges. Y-up is converted to Z-up.',
    () => 'obj',
  );
  importOp(
    'import_mesh.stl',
    'Import STL',
    'Import an STL file (ASCII or binary) as one welded mesh object.',
    () => 'stl',
  );
  importOp(
    'import_mesh.ply',
    'Import PLY',
    'Import a Stanford PLY file (ASCII or binary) with optional normals, UVs and vertex colors as one mesh object.',
    () => 'ply',
  );

  // ------------------------------------------------------------------ export
  reg.register(
    defineOperator({
      id: 'export_scene.gltf',
      label: 'Export glTF 2.0',
      description:
        'Export the scene as glTF 2.0 (GLB binary or .gltf with an embedded buffer): hierarchy, meshes, materials, textures (procedural textures baked into images), cameras, KHR_lights_punctual lights and transform animation sampled per frame (where the motion of an object curves between frames, e.g. on a fast orbit, 2 or 4 times per frame; motion that is straight between frames, like LINEAR keys or rigid bodies, keeps one key per frame). Returns { filename, mime, data_base64, warnings }.',
      category: 'Export',
      undo: false,
      schema: z.object({
        export_format: z.enum(['GLB', 'GLTF_EMBEDDED']).default('GLB'),
        ...exportShape,
        bake_resolution: z
          .number()
          .int()
          .min(64)
          .max(4096)
          .optional()
          .describe(
            'Size in pixels of the square images procedural textures are baked into. Default: per mesh, about 64 texels per metre of its surface (512–2048 px) within a budget for the whole export',
          ),
      }),
      execute: (ctx, p) => runExport(ctx, p.export_format === 'GLB' ? 'glb' : 'gltf', p),
    }),
  );
  const exportOp = (id: string, label: string, description: string, format: ExportFormat) =>
    reg.register(
      defineOperator({
        id,
        label,
        description,
        category: 'Export',
        undo: false,
        schema: z.object(exportShape),
        execute: (ctx, p) => runExport(ctx, format, p),
      }),
    );
  exportOp(
    'export_scene.obj',
    'Export Wavefront OBJ',
    'Export mesh objects as Wavefront OBJ (world space, Y-up, UVs, normals, usemtl). Returns { filename, mime, data_base64 }.',
    'obj',
  );
  exportOp(
    'export_mesh.stl',
    'Export STL',
    'Export mesh objects as binary STL (world space, triangulated). Returns { filename, mime, data_base64 }.',
    'stl',
  );
  exportOp(
    'export_mesh.ply',
    'Export PLY',
    'Export mesh objects as binary little-endian PLY (world space, UVs and vertex colors when present). Returns { filename, mime, data_base64 }.',
    'ply',
  );

  // ------------------------------------------------------------------ render
  reg.register(
    defineOperator({
      id: 'render.render_software',
      label: 'Render Image (Software)',
      description:
        'Render the scene on the CPU and return a PNG ({ mime, data_base64, width, height }). Camera: the given camera, else the scene camera, else an automatic view of all objects. Size defaults to the render resolution scaled to fit 800 px. This is the RASTER preview: no shadows, and glossy reflections come from one reflection probe in front of what the image centre shows, looked up by direction only, so water, floors and large tables far from it can show reflections the path tracer does not (judge reflections with a PATHTRACER render).',
      category: 'Render',
      undo: false,
      schema: z.object({
        width: z.number().int().min(1).max(4096).optional(),
        height: z.number().int().min(1).max(4096).optional(),
        camera: z.string().optional().describe('Camera object id or name'),
        shading: z.enum(['MATERIAL', 'SOLID']).default('MATERIAL'),
        wireframe: z.boolean().default(false).describe('Overlay mesh edges'),
        samples: z
          .union([z.literal(1), z.literal(2), z.literal(4)])
          .default(2)
          .describe('Supersampling factor (anti-aliasing)'),
        frame: z.number().optional().describe('Frame to render (default: current frame)'),
      }),
      execute(ctx, p) {
        const rs = ctx.doc.getRender();
        const pct = (rs.resolution_percentage > 0 ? rs.resolution_percentage : 100) / 100;
        const fw = Math.max(1, rs.resolution_x * pct);
        const fh = Math.max(1, rs.resolution_y * pct);
        const aspect = fw / fh;
        let width = p.width;
        let height = p.height;
        if (!width && !height) {
          const s = Math.min(1, 800 / Math.max(fw, fh));
          width = Math.round(fw * s);
          height = Math.round(fh * s);
        } else if (!height) height = Math.round(width! / aspect);
        else if (!width) width = Math.round(height * aspect);
        width = Math.min(4096, Math.max(1, width!));
        height = Math.min(4096, Math.max(1, height!));
        if (p.camera) {
          const cam = ctx.doc.resolveObject(p.camera);
          if (!cam || cam.type !== 'CAMERA')
            throw new OperatorError(`Camera '${p.camera}' not found`, 'NOT_FOUND');
        }
        const img = renderSceneSoftware(ctx.doc, {
          width,
          height,
          cameraId: p.camera,
          shading: p.shading,
          wireframe: p.wireframe,
          samples: p.samples,
          frame: p.frame ?? ctx.state.frame,
        });
        return { mime: 'image/png', data_base64: base64Encode(encodePNG(img)), width, height };
      },
    }),
  );
}
