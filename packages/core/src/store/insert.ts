import type { Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import { OperatorError } from '../operators/context';
import type { StoreCategory, StoreResult } from './types';

/*
 * Inserting a downloaded store model (CATALOG owns this module; store.insert_files): the files are
 * imported, wrapped in an EMPTY root, scaled to the requested (else real) size, given their origin
 * at the base centre, put on the ground, and their licence and attribution recorded as custom
 * properties (store_id, store_source, license, author, source_url). FOUNDATION wrote the signature;
 * it throws until CATALOG implements it.
 */

/** The model the files are of (a store search result's fields). */
export interface StoreFileEntry {
  id: string;
  name: string;
  provider: string;
  license: StoreResult['license'];
  author: string | null;
  source_url: string | null;
  dimensions_m?: [number, number, number];
  category?: StoreCategory;
}

export interface InsertStoreFilesOptions {
  entry: StoreFileEntry;
  format: 'glb' | 'gltf' | 'obj';
  /** File contents by path (base64), the main file and the buffers, textures and materials it names. */
  files: Record<string, string>;
  /** Path of the main file in `files`. */
  main: string;
  location?: Vec3;
  rotation_deg?: number;
  height_m?: number;
  width_m?: number;
  depth_m?: number;
  name?: string;
}

export function insertStoreFiles(
  _doc: SceneDoc,
  _o: InsertStoreFilesOptions,
): { root: string; objects: string[]; warnings: string[] } {
  throw new OperatorError('insertStoreFiles is not implemented yet', 'FAILED');
}
