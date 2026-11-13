import type { Mat4, Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import { FrameState } from '../eval/frame-state';
import { importFile, type ImportFormat } from '../io';
import { baseName, latin1 } from '../io/bytes';
import { isGLB } from '../io/glb';
import { OperatorError } from '../operators/context';
import { base64Decode } from '../util/json';
import { sizeScale } from './builtin/kit';
import { rankCatalog } from './search';
import type { StoreCategory, StoreResult } from './types';

/*
 * Inserting a downloaded store model (CATALOG owns this module; store.insert_files): the files are
 * imported (the main file with its buffers, textures and material files as companions), wrapped in
 * an EMPTY root named after the model, scaled to the size asked for (else to the size the provider
 * gives, else normalized: see normalizedScale), moved so that the root's origin is the base centre
 * of the model's bounds, stood on the ground at `location` and turned about +Z; the root records the
 * licence and attribution as custom properties (store_id, store_source, license, author, source_url;
 * spec §2). Cameras and lights the file brings (a showcase camera, studio lamps) are left out and the
 * scene camera stays the one the scene had: a store model adds its geometry, not a shot or lighting.
 * Everything the file is checked for happens before the document changes, so a refused insert
 * leaves nothing behind; the caller's transaction makes it one undo step.
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
  /** Frame whose pose measures the model (default: the scene's start frame). */
  frame?: number;
}

export interface InsertStoreFilesResult {
  /** The EMPTY root. */
  root: string;
  /** The root, then every imported object. */
  objects: string[];
  warnings: string[];
  /** Size of the inserted model (width, depth, height in metres). */
  dimensions_m: Vec3;
}

/** Overall sizes (the largest side, metres) believable for a kind of model, and its usual one. */
export interface SizeRange {
  min: number;
  max: number;
  typical: number;
}

/** The sizes of each store category's models (a pebble to a block of flats; a mouse to an elephant). */
export const CATEGORY_SIZES: Readonly<Record<StoreCategory, SizeRange>> = {
  people: { min: 0.4, max: 2.5, typical: 1.7 },
  animals: { min: 0.05, max: 8, typical: 1 },
  furniture: { min: 0.2, max: 4, typical: 1 },
  props: { min: 0.02, max: 3, typical: 0.4 },
  food: { min: 0.02, max: 1, typical: 0.15 },
  vehicles: { min: 0.5, max: 30, typical: 4.5 },
  nature: { min: 0.05, max: 60, typical: 4 },
  architecture: { min: 0.5, max: 300, typical: 10 },
  street: { min: 0.2, max: 15, typical: 2 },
  sports: { min: 0.03, max: 3, typical: 0.3 },
};

/** The sizes of a model of no known category: what a previs set holds. */
export const ANY_SIZE: SizeRange = { min: 0.01, max: 100, typical: 1 };

/** How many times too large or too small a model must be before its units are not believed. */
const UNIT_GUESS_FACTOR = 10;

/** Units model files are often authored in (glTF and OBJ promise metres), by their size in metres. */
const FILE_UNITS: readonly (readonly [string, number])[] = [
  ['centimetres', 0.01],
  ['inches', 0.0254],
  ['millimetres', 0.001],
];

/** Score of a search hit that is a built-in model's name or synonym (search.ts NAME/SYNONYM_PHRASE). */
const NAMED_SCORE = 38;

/**
 * The sizes a store model is believable at: its category's (the server sends the provider's or a
 * guessed one), else those of the built-in model its name is (an 'Armchair' is furniture), else
 * ANY_SIZE. `kind` names them in warnings.
 */
export function sizeRangeOf(entry: Pick<StoreFileEntry, 'category' | 'name'>): {
  range: SizeRange;
  kind: string;
} {
  let category = entry.category ?? null;
  if (!category && entry.name?.trim()) {
    const hit = rankCatalog(entry.name)[0];
    if (hit && hit.score >= NAMED_SCORE) category = hit.entry.category;
  }
  return category
    ? { range: CATEGORY_SIZES[category], kind: category }
    : { range: ANY_SIZE, kind: 'store models' };
}

/** A size for messages: three significant digits, metres. */
const metres = (v: number) => `${Number(v.toPrecision(3))} m`;

const ADVICE = 'Pass height_m, width_m or depth_m to give it its real size.';

/**
 * The uniform scale of a model `largest` metres across as imported when no size is asked for and the
 * provider gives none (glTF and OBJ promise metres, many files are in other units), with the warning
 * that names the size measured and the scale applied: 1 within `range`; when it is ten times or more
 * larger than the range allows, read in the unit (centimetres, inches, millimetres) that puts it in
 * range nearest the typical size; ten times or more off with no such unit, scaled to the typical
 * size; less far off, kept as it is with a warning.
 */
export function normalizedScale(
  largest: number,
  range: SizeRange,
  kind: string,
): { scale: number; warning: string | null } {
  if (!(largest > 0) || !Number.isFinite(largest)) return { scale: 1, warning: null };
  if (largest >= range.min && largest <= range.max) return { scale: 1, warning: null };
  const usual = `usual for ${kind}: ${range.min}–${range.max} m`;
  const measured = `The model is ${metres(largest)} across as imported (${usual})`;
  if (largest < range.max * UNIT_GUESS_FACTOR && largest > range.min / UNIT_GUESS_FACTOR)
    return { scale: 1, warning: `${measured}; kept at that size. ${ADVICE}` };
  if (largest > range.max) {
    const fits = FILE_UNITS.filter(([, u]) => largest * u >= range.min && largest * u <= range.max).sort(
      (a, b) =>
        Math.abs(Math.log((largest * a[1]) / range.typical)) -
        Math.abs(Math.log((largest * b[1]) / range.typical)),
    );
    if (fits.length) {
      const [unit, u] = fits[0];
      return {
        scale: u,
        warning: `${measured}: read as ${unit}, scaled ×${u} to ${metres(largest * u)}. ${ADVICE}`,
      };
    }
  }
  const scale = range.typical / largest;
  return {
    scale,
    warning: `${measured}: scaled ×${Number(scale.toPrecision(3))} to ${metres(range.typical)}, the usual size. ${ADVICE}`,
  };
}

/** A file path as the files map keys it: forward slashes, no leading './' or '/'. */
export function normalizeFilePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

function decodeFiles(files: Record<string, string>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    if (typeof data !== 'string') continue;
    const key = normalizeFilePath(path);
    if (!key) continue;
    let bytes: Uint8Array;
    try {
      bytes = base64Decode(data.trim());
    } catch {
      throw new OperatorError(`File '${path}' is not valid base64`, 'INVALID_PARAMS');
    }
    out.set(key, bytes);
  }
  return out;
}

/** The import format of the main file: what `format` says, corrected by the bytes for glTF. */
function importFormat(
  format: InsertStoreFilesOptions['format'],
  main: Uint8Array,
  path: string,
): ImportFormat {
  if (format === 'obj') return 'obj';
  if (isGLB(main)) return 'glb';
  const head = latin1(main, 0, Math.min(main.length, 64)).replace(/^ï»¿/, '').trimStart();
  if (head.startsWith('{')) return 'gltf';
  throw new OperatorError(
    `'${path}' is neither a GLB file nor glTF JSON (format '${format}')`,
    'INVALID_PARAMS',
  );
}

/**
 * The companion files the importer can look up: by their own path and, for files in the main file's
 * folder or below, by the path relative to it (the way the main file names them).
 */
function companions(files: Map<string, Uint8Array>, mainPath: string): Record<string, Uint8Array> {
  const dir = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
  const out: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) {
    if (path === mainPath) continue;
    out[path] = bytes;
    if (dir && path.startsWith(dir) && !(path.slice(dir.length) in out)) out[path.slice(dir.length)] = bytes;
  }
  return out;
}

/** World bounds of the imported meshes at `frame` (bones, parents and animation applied), or null. */
function importedBounds(
  doc: SceneDoc,
  ids: readonly string[],
  frame: number,
): { min: Vec3; max: Vec3 } | null {
  const fs = new FrameState(doc, frame);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const id of ids) {
    const o = doc.getObject(id);
    if (!o || o.type !== 'MESH' || !o.data) continue;
    const mesh = doc.getMesh(o.data);
    const m: Mat4 | null = fs.world(id);
    if (!mesh || !m) continue;
    const P = mesh.positions;
    for (let i = 0; i + 2 < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const w = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
        if (w < min[k]) min[k] = w;
        if (w > max[k]) max[k] = w;
      }
    if (P.length >= 3) any = true;
  }
  return any ? { min, max } : null;
}

/** Custom properties recording where a store model comes from and under which licence (spec §2). */
export function attributionProps(entry: StoreFileEntry): Record<string, string> {
  const props: Record<string, string> = {
    store_id: entry.id,
    store_source: entry.provider,
    license: entry.license.spdx,
  };
  const author = entry.author ?? entry.license.attribution;
  if (author) props.author = author;
  if (entry.source_url) props.source_url = entry.source_url;
  return props;
}

/**
 * Imports a store model's files into `doc` under a new EMPTY root (see the module comment). Throws
 * OperatorError INVALID_PARAMS for files that cannot be what they claim (before anything changes)
 * and FAILED when the import fails or brings no objects.
 */
export function insertStoreFiles(doc: SceneDoc, o: InsertStoreFilesOptions): InsertStoreFilesResult {
  const files = decodeFiles(o.files ?? {});
  const mainPath = normalizeFilePath(o.main);
  const main = files.get(mainPath);
  if (!main) {
    const have = [...files.keys()].slice(0, 8).join(', ');
    throw new OperatorError(
      `The main file '${o.main}' is not among the files${have ? ` (${have})` : ''}`,
      'INVALID_PARAMS',
    );
  }
  if (!main.length) throw new OperatorError(`The main file '${o.main}' is empty`, 'INVALID_PARAMS');
  const format = importFormat(o.format, main, o.main);
  const label = o.name?.trim() || o.entry.name?.trim() || baseName(mainPath) || 'Model';
  const materialsBefore = new Set(doc.listMaterials().map((m) => m.id));
  const imagesBefore = new Set(doc.listImages().map((m) => m.id));
  const sceneCamera = doc.getScene().camera;
  let res: ReturnType<typeof importFile>;
  try {
    res = importFile(doc, format, main, { name: label, files: companions(files, mainPath) });
  } catch (err) {
    throw new OperatorError(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
  }
  const warnings = [...res.warnings];
  const dropped = dropCamerasAndLights(doc, res.objects);
  if (dropped.length)
    warnings.push(
      `Left out what the file brings besides the model: ${dropped.join(', ')} (the scene keeps its own camera and lights)`,
    );
  // the importer makes the file's first camera the scene camera when the scene has none
  if (doc.getScene().camera !== sceneCamera) doc.updateScene({ camera: sceneCamera });
  const objects = res.objects.filter((id) => doc.getObject(id));
  // measure the model as imported (the root is added at the origin, so world = root space)
  const frame = Number.isFinite(o.frame) ? (o.frame as number) : doc.getScene().frame_start;
  const bounds = importedBounds(doc, objects, frame);
  if (!bounds) {
    // nothing to see: take back what the import added and refuse
    doc.removeObjects(objects);
    for (const m of doc.listMaterials()) if (!materialsBefore.has(m.id)) doc.removeMaterial(m.id);
    for (const im of doc.listImages()) if (!imagesBefore.has(im.id)) doc.removeImage(im.id);
    if (doc.getScene().camera !== sceneCamera) doc.updateScene({ camera: sceneCamera });
    throw new OperatorError(
      `The file '${o.main}' has no mesh geometry to insert${warnings.length ? ` (${warnings.join('; ')})` : ''}`,
      'FAILED',
    );
  }
  const imported = new Set(objects);
  const tops = objects.filter((id) => {
    const parent = doc.getObject(id)?.parent;
    return !parent || !imported.has(parent);
  });
  const natural: Vec3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const base: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    bounds.min[2],
  ];

  // the size: the one asked for, else the provider's (largest side to largest side, proportions
  // kept), else the file's own when believable for its kind (normalizedScale)
  const asked = [o.width_m, o.depth_m, o.height_m].some((v) => v !== undefined && v > 0);
  const have = Math.max(...natural);
  const want = o.entry.dimensions_m ? Math.max(...o.entry.dimensions_m) : 0;
  const { range, kind } = sizeRangeOf(o.entry);
  let scale: Vec3;
  if (asked) scale = sizeScale(natural, o, warnings);
  else if (want > 0 && Number.isFinite(want) && have > 1e-9) {
    scale = [want / have, want / have, want / have];
    if (want < range.min || want > range.max)
      warnings.push(
        `The model is ${metres(want)} across at the size its provider gives (usual for ${kind}: ` +
          `${range.min}–${range.max} m). ${ADVICE}`,
      );
  } else {
    const n = normalizedScale(have, range, kind);
    scale = [n.scale, n.scale, n.scale];
    if (n.warning) warnings.push(n.warning);
  }

  const loc = o.location && o.location.every((v) => Number.isFinite(v)) ? o.location : [0, 0, 0];
  const root = doc.addObject({
    type: 'EMPTY',
    name: label,
    location: [0, 0, 0],
    empty_display_type: 'PLAIN_AXES',
    empty_display_size: Math.min(5, Math.max(0.05, Math.max(natural[0], natural[1]) * 0.6)),
    custom_props: attributionProps(o.entry),
  });
  // hang the imported top-level objects from the root (keeping where they are), then move them so
  // that the base centre of the bounds is the root's origin (location keys move with them)
  for (const id of tops) {
    doc.setParent(id, root, true);
    const obj = doc.getObject(id);
    if (!obj) continue;
    doc.updateObject(id, {
      location: [obj.location[0] - base[0], obj.location[1] - base[1], obj.location[2] - base[2]],
    });
    for (const fc of doc.listFCurves(id)) {
      if (fc.target_type !== 'object' || fc.path !== 'location' || fc.index < 0 || fc.index > 2) continue;
      const d = base[fc.index];
      if (!d) continue;
      doc.setFCurve({ ...fc, keyframes: fc.keyframes.map((k) => ({ ...k, value: k.value - d })) });
    }
  }
  const rot = Number.isFinite(o.rotation_deg) ? ((o.rotation_deg as number) * Math.PI) / 180 : 0;
  doc.updateObject(root, { location: [loc[0], loc[1], loc[2]], rotation_euler: [0, 0, rot], scale });
  return {
    root,
    objects: [root, ...objects],
    warnings,
    dimensions_m: [natural[0] * scale[0], natural[1] * scale[1], natural[2] * scale[2]],
  };
}

/**
 * Removes the CAMERA and LIGHT objects among `ids` (their children keep their place under the
 * removed object's parent); returns what was removed, as 'name (camera)' / 'name (light)'.
 */
function dropCamerasAndLights(doc: SceneDoc, ids: readonly string[]): string[] {
  const out: string[] = [];
  const remove: string[] = [];
  for (const id of ids) {
    const o = doc.getObject(id);
    if (o?.type !== 'CAMERA' && o?.type !== 'LIGHT') continue;
    remove.push(id);
    out.push(`${o.name} (${o.type.toLowerCase()})`);
  }
  if (remove.length) doc.removeObjects(remove);
  return out;
}
