import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';

/*
 * Import / export of interchange formats. All functions are isomorphic (no DOM, no Node APIs),
 * operate on raw bytes, and convert between the editor's Z-up space and Y-up formats (glTF)
 * the same way Blender does.
 */

export type ExportFormat = 'gltf' | 'glb' | 'obj' | 'stl' | 'ply';
export type ImportFormat = 'gltf' | 'glb' | 'obj' | 'stl' | 'ply';

export interface ExportOptions {
  /** Export only these object ids (default: all visible objects). */
  objectIds?: string[];
  /** Apply modifier stacks (default true). */
  applyModifiers?: boolean;
  /** Frame used for evaluation (default scene frame_start). */
  frame?: number;
}

export interface ExportResult {
  data: Uint8Array;
  mime: string;
  extension: string;
}

export interface ImportOptions {
  /** Base name for created objects when the file has none. */
  name?: string;
  /** Offset applied to imported root objects (world space, Z-up). */
  location?: Vec3;
}

export interface ImportResult {
  /** Ids of created objects. */
  objects: string[];
  warnings: string[];
}

export function exportScene(_doc: SceneDoc, _format: ExportFormat, _opts: ExportOptions = {}): ExportResult {
  throw new Error('exportScene not implemented yet');
}

export function importFile(_doc: SceneDoc, _format: ImportFormat, _data: Uint8Array, _opts: ImportOptions = {}): ImportResult {
  throw new Error('importFile not implemented yet');
}

/** Detects a supported format from a file name (by extension). */
export function detectFormat(filename: string): ImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'gltf' || ext === 'glb' || ext === 'obj' || ext === 'stl' || ext === 'ply' ? ext : null;
}
