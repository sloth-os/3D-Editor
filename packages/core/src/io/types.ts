import type { Vec3 } from '../math/types';

export type ExportFormat = 'gltf' | 'glb' | 'obj' | 'stl' | 'ply';
export type ImportFormat = 'gltf' | 'glb' | 'obj' | 'stl' | 'ply';

export interface ExportOptions {
  /** Export only these object ids (default: all visible objects). Names are accepted as well. */
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
  /** Non-fatal issues (e.g. features the format cannot represent). */
  warnings?: string[];
}

export interface ImportOptions {
  /** Base name for created objects when the file has none. */
  name?: string;
  /** Offset applied to imported root objects (world space, Z-up). */
  location?: Vec3;
  /**
   * Companion files referenced by the main file (OBJ `mtllib` + textures, external glTF buffers and
   * images), keyed by their relative path or file name.
   */
  files?: Record<string, Uint8Array>;
}

export interface ImportResult {
  /** Ids of created objects. */
  objects: string[];
  warnings: string[];
}
