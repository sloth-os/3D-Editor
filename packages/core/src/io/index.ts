import type { SceneDoc } from '../doc/scene-doc';
import { baseName, latin1 } from './bytes';
import { exportGLTF } from './gltf-export';
import { importGLTF } from './gltf-import';
import { isGLB } from './glb';
import { exportOBJ, importOBJ } from './obj';
import { exportPLY, importPLY } from './ply';
import { exportSTL, importSTL, isBinarySTL } from './stl';
import type {
  ExportFormat,
  ExportOptions,
  ExportResult,
  ImportFormat,
  ImportOptions,
  ImportResult,
} from './types';

/*
 * Import / export of interchange formats. All functions are isomorphic (no DOM, no Node APIs),
 * operate on raw bytes, and convert between the editor's Z-up space and Y-up formats (glTF, OBJ)
 * the same way Blender does. STL and PLY stay Z-up.
 */

export type {
  ExportFormat,
  ExportOptions,
  ExportResult,
  ImportFormat,
  ImportOptions,
  ImportResult,
} from './types';
export { readImageInfo, sniffImageMime, type ImageInfo } from './image-info';

const MIME: Record<ExportFormat, string> = {
  gltf: 'model/gltf+json',
  glb: 'model/gltf-binary',
  obj: 'model/obj',
  stl: 'model/stl',
  ply: 'model/x-ply',
};

/** MIME type used for an export format. */
export function exportMimeType(format: ExportFormat): string {
  return MIME[format];
}

/**
 * Exports the scene (default: every object visible in renders, evaluated at frame_start with
 * modifiers applied). OBJ/STL/PLY contain world-space meshes; glTF keeps the object hierarchy,
 * materials, cameras, lights and transform animation.
 */
export function exportScene(doc: SceneDoc, format: ExportFormat, opts: ExportOptions = {}): ExportResult {
  switch (format) {
    case 'glb':
      return exportGLTF(doc, opts, true);
    case 'gltf':
      return exportGLTF(doc, opts, false);
    case 'obj':
      return exportOBJ(doc, opts);
    case 'stl':
      return exportSTL(doc, opts);
    case 'ply':
      return exportPLY(doc, opts);
    default:
      throw new Error(`Unsupported export format '${String(format)}'`);
  }
}

/**
 * Imports a file into the document within one transaction (one undo step). Object names are made
 * unique by the document; `opts.location` offsets the imported root objects. Returns the created
 * object ids and non-fatal warnings; throws for unreadable files.
 */
export function importFile(
  doc: SceneDoc,
  format: ImportFormat,
  data: Uint8Array,
  opts: ImportOptions = {},
): ImportResult {
  // a file name passed as base name ("models/chair.glb") names objects "chair"
  if (opts.name && /\.(gltf|glb|obj|stl|ply)$/i.test(opts.name.trim()))
    opts = { ...opts, name: baseName(opts.name.trim()) || undefined };
  switch (format) {
    case 'gltf':
    case 'glb':
      return importGLTF(doc, data, opts);
    case 'obj':
      return importOBJ(doc, data, opts);
    case 'stl':
      return importSTL(doc, data, opts);
    case 'ply':
      return importPLY(doc, data, opts);
    default:
      throw new Error(`Unsupported import format '${String(format)}'`);
  }
}

/** Detects a supported format from a file name (by extension). */
export function detectFormat(filename: string): ImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'gltf' || ext === 'glb' || ext === 'obj' || ext === 'stl' || ext === 'ply' ? ext : null;
}

/** Detects a supported format from file contents (magic bytes / text markers). */
export function sniffFormat(data: Uint8Array): ImportFormat | null {
  if (isGLB(data)) return 'glb';
  const head = latin1(data, 0, Math.min(data.length, 1024));
  const trimmed = head.replace(/^\u00EF\u00BB\u00BF/, '').trimStart(); // UTF-8 BOM (bytes decoded as Latin-1)
  if (trimmed.startsWith('{')) return 'gltf';
  if (/^ply\r?\n/.test(head)) return 'ply';
  if (data.length >= 84 && isBinarySTL(data) && !/^\s*(v|vt|vn|f|o|g|#|mtllib)\s/m.test(head)) return 'stl';
  if (/^\s*solid\b/i.test(head) && /\bfacet\b/i.test(latin1(data, 0, Math.min(data.length, 4096))))
    return 'stl';
  if (/^\s*(v|vt|vn|f|o|g|mtllib|usemtl)\s/m.test(head)) return 'obj';
  return null;
}
