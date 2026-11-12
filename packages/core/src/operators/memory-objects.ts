import type { DatablockKind, ObjectData, ObjectType } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { decodedMeshBytes } from '../mesh/memory';
import type { MeshData } from '../mesh/types';

/*
 * The heap the objects and datablocks of a project take, for the memory estimates of
 * operators/memory.ts. Every object is a Yjs map of its 31 fields in the document, about 10 KB of
 * JavaScript heap in the server's process whether or not it has geometry: an operator that adds
 * 200,000 objects (Separate by loose parts, an import of 200,000 glTF nodes) takes over 2 GB, which
 * no estimate per face counted. These constants were measured with --trace-gc (garbage included) on
 * runs that added 2,000 to 40,000 objects, with and without the server's own listeners (the update
 * every transaction is encoded into for the editors, and the agent's undo manager: 5% more), and
 * rounded up.
 */

/**
 * Heap one object keeps in the document (bytes), its datablock not included: 9.4–10.2 KB measured
 * (empties, linked duplicates, glTF nodes, instances made real, copies of array_place and
 * scatter_on_surface; 9.8 KB with the server's listeners), rounded up.
 */
export const OBJECT_STORED_BYTES = 11_000;

/**
 * Peak heap per object an operator adds, beyond OPERATOR_FIXED_BYTES (the young generation's
 * garbage): runs adding 10,000 to 100,000 objects (linked duplicates, layouts, glTF nodes, made-real
 * instances, scattered copies, with the server's listeners) peaked at 9.7–12.5 KB per object above
 * it, except linked duplicates of 80,000 objects: three runs peaked at 985, 1,028 and 1,308 MB, 16.3
 * KB per object in the last, whose garbage grew on a heap of 3,500 MB before V8 collected it (three
 * more on a heap of 3,000 MB at 1,173 MB). At 18 KB per object (1,407 MB for those 80,000) every one
 * of them stays below the estimate, the highest by 7%.
 */
export const OBJECT_ADD_BYTES = 18_000;

/** Datablock kinds an object brings or an operator adds, counted in the estimates. */
export type CountedKind = 'meshes' | 'curves' | 'materials' | 'lights' | 'cameras' | 'armatures';

const COUNTED_KINDS: readonly CountedKind[] = [
  'meshes',
  'curves',
  'materials',
  'lights',
  'cameras',
  'armatures',
];

/**
 * Heap one datablock keeps in the document, besides its object and (meshes) its decoded mesh,
 * which mesh/memory.ts counts: measured on 10,000 of each, rounded up: a mesh 1.0–2.6 KB, a
 * material 6.9 KB, a light 4.6 KB, a camera 5.0 KB, a curve (a Bézier curve primitive) 11.5 KB and
 * a text 10.6 KB, an armature of one bone 3.4 KB.
 */
export const DATABLOCK_STORED_BYTES: Readonly<Record<CountedKind, number>> = {
  meshes: 3_000,
  curves: 12_000,
  materials: 7_500,
  lights: 5_000,
  cameras: 5_500,
  armatures: 4_000,
};

/**
 * Peak heap per datablock an operator adds, besides its object (a mesh: its encoding and the copy of
 * a small mesh; the decoded size of larger ones is counted per face): measured 2.1–4.6 KB for a
 * mesh, 8.6 KB for a material, 5.1 KB for a light, 4.8 KB for a camera, 12.3 KB for a curve, 11.6
 * KB for a text, 4.3 KB for an armature; rounded up.
 */
export const DATABLOCK_ADD_BYTES: Readonly<Record<CountedKind, number>> = {
  meshes: 5_000,
  curves: 13_000,
  materials: 9_000,
  lights: 6_000,
  cameras: 5_500,
  armatures: 5_000,
};

/**
 * Heap one animation keyframe keeps in the document (its F-curve's JSON in the Yjs map): 97–104
 * measured (glTF imports of 300,000 to 900,000 keyframes), 77 for baked keyframes; rounded up.
 */
export const KEYFRAME_STORED_BYTES = 120;

/**
 * Heap one F-curve keeps in the document besides its keyframes (its entry in the Yjs map, key and
 * fields): 548 bytes measured with its one keyframe (anim.keyframe_insert on 10,000 objects, 90,000
 * F-curves), rounded up.
 */
export const FCURVE_STORED_BYTES = 600;

/**
 * Heap one driver keeps in the document: 819 bytes measured for a driver of 240 characters of JSON
 * (one variable), 1,935 for one of 989 (eight variables), 1.5 bytes per character more; rounded up:
 * {@link DRIVER_STORED_BYTES} for a driver of up to {@link DRIVER_BASE_JSON_CHARS} characters,
 * {@link OBJECT_JSON_STORED_BYTES} per character beyond.
 */
export const DRIVER_STORED_BYTES = 1_000;
export const DRIVER_BASE_JSON_CHARS = 250;

/**
 * Heap a save of the project takes for a moment in the server's process, beyond what the project
 * keeps, per byte its objects, datablocks and keyframes keep ({@link OBJECT_STORED_BYTES},
 * {@link DATABLOCK_STORED_BYTES}, {@link KEYFRAME_STORED_BYTES}): the server's persistence (core
 * storage/project-store.ts syncDocument, after every change) merges the whole stored state into the
 * project's document and then applies the merged state to a document of its own that holds the
 * stored state, which decodes every Yjs item of a whole state into the heap three times. Measured as
 * the least heap limit a save completed in, less the heap the project kept: 30.9 and 31.6 KB per
 * object (10,000 and 20,000 linked cubes; 2.9 bytes per byte counted), about 260 bytes per keyframe
 * (270,000 keyframes of a glTF import; 2.2 per byte counted); rounded up. Its decoded meshes take
 * next to nothing then (their encodings are read in place: 0.3 MB for four grids of 250,000 faces),
 * so they are not counted.
 */
export const SAVE_BYTES_PER_KEPT_BYTE = 3;

/**
 * Heap a save of the project takes for a moment for objects, datablocks and keyframes that keep
 * `kept` bytes ({@link SAVE_BYTES_PER_KEPT_BYTE}).
 */
export function saveBytes(kept: number): number {
  return SAVE_BYTES_PER_KEPT_BYTE * Math.max(0, kept);
}

/** Characters of the JSON of an object with default fields (a mesh object without modifiers: 596). */
export const OBJECT_BASE_JSON_CHARS = 600;

/**
 * Heap per character of an object's JSON beyond {@link OBJECT_BASE_JSON_CHARS} (its modifiers,
 * constraints, particle systems, pose …), which every copy of it keeps (1.5 measured) and takes at
 * the peak of an operator that adds it (2.5 measured; 9,000 copies of objects of 1 to 8
 * modifiers), rounded up.
 */
export const OBJECT_JSON_STORED_BYTES = 2;
export const OBJECT_JSON_ADD_BYTES = 3;

/** The datablock kind of an object's data (null: none, or not counted). */
export function dataKindOf(type: ObjectType): CountedKind | null {
  switch (type) {
    case 'MESH':
      return 'meshes';
    case 'CURVE':
    case 'FONT':
      return 'curves';
    case 'LIGHT':
      return 'lights';
    case 'CAMERA':
      return 'cameras';
    case 'ARMATURE':
      return 'armatures';
    default:
      return null;
  }
}

/** Characters of the JSON of `o` beyond the default fields ({@link OBJECT_BASE_JSON_CHARS}). */
export function extraJsonChars(o: ObjectData): number {
  return Math.max(0, JSON.stringify(o).length - OBJECT_BASE_JSON_CHARS);
}

/**
 * Characters of the JSON of a datablock that {@link DATABLOCK_STORED_BYTES} and
 * {@link DATABLOCK_ADD_BYTES} cover, by kind (the datablocks they were measured on: a Bézier curve
 * primitive 991, a text 539–575, an armature of one bone 330, a point light 245, a camera 266
 * characters). A curve's splines and an armature's bones keep more: like an object's JSON, every
 * character beyond these counts ({@link OBJECT_JSON_STORED_BYTES}, {@link OBJECT_JSON_ADD_BYTES}). Meshes
 * keep their geometry encoded, counted by its decoded size (mesh/memory.ts).
 */
export const DATABLOCK_BASE_JSON_CHARS: Readonly<Record<Exclude<CountedKind, 'meshes'>, number>> = {
  curves: 1_000,
  materials: 400,
  lights: 300,
  cameras: 300,
  armatures: 400,
};

/**
 * Characters of the JSON of datablock `id` of `kind` beyond {@link DATABLOCK_BASE_JSON_CHARS} (0 for
 * meshes and missing datablocks).
 */
export function datablockExtraJsonChars(doc: SceneDoc, kind: CountedKind, id: string): number {
  if (kind === 'meshes') return 0;
  const y = doc.map(kind).get(id) as { toJSON(): unknown } | undefined;
  return y ? Math.max(0, JSON.stringify(y.toJSON()).length - DATABLOCK_BASE_JSON_CHARS[kind]) : 0;
}

/** Characters of the JSON of driver `key` beyond {@link DRIVER_BASE_JSON_CHARS} (0 when it is missing). */
export function driverExtraJsonChars(doc: SceneDoc, key: string): number {
  const d = doc.map('drivers').get(key) as unknown;
  return d ? Math.max(0, JSON.stringify(d).length - DRIVER_BASE_JSON_CHARS) : 0;
}

/** Objects and datablocks an operator adds. */
export interface NewObjects {
  objects: number;
  /** Datablocks it adds, by kind. */
  datablocks?: Partial<Record<CountedKind, number>>;
  /** Characters of the new objects' JSON beyond the default fields, summed ({@link extraJsonChars}). */
  extraJson?: number;
}

/**
 * The heap of what an operator adds ({@link NewObjects}): at the peak of its run (`peak`, beyond
 * OPERATOR_FIXED_BYTES) and kept in the document afterwards (`stored`).
 */
export function newObjectsBytes(a: NewObjects): { peak: number; stored: number } {
  let peak = OBJECT_ADD_BYTES * a.objects + OBJECT_JSON_ADD_BYTES * (a.extraJson ?? 0);
  let stored = OBJECT_STORED_BYTES * a.objects + OBJECT_JSON_STORED_BYTES * (a.extraJson ?? 0);
  for (const kind of COUNTED_KINDS) {
    const n = a.datablocks?.[kind] ?? 0;
    peak += DATABLOCK_ADD_BYTES[kind] * n;
    stored += DATABLOCK_STORED_BYTES[kind] * n;
  }
  return { peak, stored };
}

/**
 * Live entries of one of the document's datablock maps (or its F-curves or drivers), without reading
 * them (Y.Map's `size` builds an array of all its entries first).
 */
function blocks(doc: SceneDoc, kind: DatablockKind | 'fcurves' | 'drivers'): number {
  let n = 0;
  for (const item of doc.map(kind)._map.values()) if (!item.deleted) n++;
  return n;
}

/**
 * Heap one shape key keeps per vertex of its mesh (its positions, stored with the mesh's datablock):
 * 15.3 and 15.4 measured (glTF imports of a mesh on a grid of 150 × 150 with 16 and 32 morph targets,
 * against the same mesh without them), rounded up. A save of the project copies their positions
 * outside the JavaScript heap ({@link SAVE_BYTES_PER_LAYER_BYTE}).
 */
export const SHAPE_KEY_STORED_BYTES_PER_VERTEX = 16;

/**
 * What a save of a project takes for a moment per byte of its meshes' vertex group weights and shape
 * key positions (binary data the document keeps as it is, like images): the save copies them as it
 * encodes, reads back and merges the project's state, 4.5 and 4.7 times their bytes measured as
 * resident memory (the second save, to a disk store, of projects holding 97 MiB of vertex groups and
 * 61 MiB of shape keys), rounded up. (The JavaScript heap does not show these copies: measured with
 * --trace-gc a save took next to nothing for them.)
 */
export const SAVE_BYTES_PER_LAYER_BYTE = 6;

/**
 * Bytes of the positions of stored mesh `id`'s shape keys (three floats per vertex and key), read in
 * place (no copy of them).
 */
export function shapeKeyBytes(doc: SceneDoc, id: string): number {
  const keys = (doc.map('meshes').get(id) as { get(key: string): unknown } | undefined)?.get('shape_keys');
  if (!Array.isArray(keys)) return 0;
  let bytes = 0;
  for (const k of keys) bytes += (k as { data?: { byteLength?: number } } | null)?.data?.byteLength ?? 0;
  return bytes;
}

/**
 * Bytes of the layers of stored mesh `id` that the document keeps as binary data: the weights of its
 * vertex groups ({@link vertexGroupBytes}) and the positions of its shape keys ({@link shapeKeyBytes}).
 */
export function meshLayerBytes(doc: SceneDoc, id: string): number {
  return vertexGroupBytes(doc, id) + shapeKeyBytes(doc, id);
}

/** Bytes of the vertex groups and shape keys of every mesh of the document ({@link meshLayerBytes}). */
export function layerBytes(doc: SceneDoc): number {
  let bytes = 0;
  for (const id of doc.map('meshes').keys()) bytes += meshLayerBytes(doc, id);
  return bytes;
}

/** Shape keys of stored mesh `id` (not counting its basis), read in place (no copy of their data). */
export function shapeKeyCount(doc: SceneDoc, id: string): number {
  const keys = (doc.map('meshes').get(id) as { get(key: string): unknown } | undefined)?.get('shape_keys');
  return Array.isArray(keys) ? keys.length : 0;
}

/**
 * Bytes of the weights of stored mesh `id`'s vertex groups (a float per vertex and group: an armature
 * bound with automatic weights has a group per deforming bone), read in place (no copy of them). A save
 * of the project copies them outside the JavaScript heap ({@link SAVE_BYTES_PER_LAYER_BYTE}).
 */
export function vertexGroupBytes(doc: SceneDoc, id: string): number {
  const groups = (doc.map('meshes').get(id) as { get(key: string): unknown } | undefined)?.get(
    'vertex_groups',
  );
  if (!Array.isArray(groups)) return 0;
  let bytes = 0;
  for (const g of groups)
    bytes += (g as { weights?: { byteLength?: number } } | null)?.weights?.byteLength ?? 0;
  return bytes;
}

/**
 * Decoded bytes of every mesh of the document, from their stored counts (not decoding them), and the
 * heap their shape keys ({@link SHAPE_KEY_STORED_BYTES_PER_VERTEX}) and vertex groups
 * ({@link vertexGroupBytes}) keep.
 */
export function storedMeshBytes(doc: SceneDoc): number {
  let bytes = 0;
  for (const id of doc.map('meshes').keys()) {
    const c = doc.meshCounts(id);
    if (!c) continue;
    // with a UV layer: the decoded size errs on the safe side
    bytes += decodedMeshBytes({ ...c, uvs: true, colors: false });
    bytes += SHAPE_KEY_STORED_BYTES_PER_VERTEX * shapeKeyCount(doc, id) * c.vertices;
    bytes += vertexGroupBytes(doc, id);
  }
  return bytes;
}

/** Keyframes of the document's F-curves (read from their stored JSON, not copied). */
function keyframes(doc: SceneDoc): number {
  let n = 0;
  for (const fc of doc.map('fcurves').values()) {
    const k = (fc as { keyframes?: unknown } | null)?.keyframes;
    if (Array.isArray(k)) n += k.length;
  }
  return n;
}

/**
 * Entries of a map of the document whose JSON {@link projectObjects} reads, at most: their extra
 * characters are counted from these, spread over the map, and scaled to all of its entries.
 */
export const PROJECT_JSON_SAMPLE = 32;

/**
 * Characters beyond the default ones of the JSON of all `count` live entries of map `kind`, from
 * `chars` of at most {@link PROJECT_JSON_SAMPLE} of them spread over the map (all of them when there
 * are no more).
 */
function sampledExtraJson(
  doc: SceneDoc,
  kind: DatablockKind | 'drivers',
  count: number,
  chars: (id: string) => number,
): number {
  if (!count) return 0;
  const step = Math.max(1, Math.floor(count / PROJECT_JSON_SAMPLE));
  let i = 0;
  let read = 0;
  let extra = 0;
  for (const [id, item] of doc.map(kind)._map) {
    if (item.deleted || i++ % step) continue;
    if (read >= PROJECT_JSON_SAMPLE) break;
    extra += chars(id);
    read++;
  }
  return read ? Math.ceil((extra / read) * count) : 0;
}

/**
 * Objects of the document and the heap they, their datablocks and their animation (F-curves and
 * their keyframes, drivers) keep (see {@link projectStoredBytes}): each at its constant, and the
 * characters of their JSON beyond the default ones (modifiers, constraints and other settings of
 * objects; splines of curves, bones of armatures; variables of drivers) at
 * {@link OBJECT_JSON_STORED_BYTES} each, counted from up to {@link PROJECT_JSON_SAMPLE} objects,
 * datablocks and drivers of each kind; and the bytes of its images ({@link storedImageBytes}).
 * `save`: what a save of the project takes for a moment beyond that ({@link saveBytes} of its
 * objects, datablocks and keyframes, {@link SAVE_BYTES_PER_IMAGE_BYTE} of its images,
 * {@link SAVE_BYTES_PER_LAYER_BYTE} of its meshes' vertex groups and shape keys, `layers` bytes,
 * which {@link storedMeshBytes} counts with the meshes).
 */
export function projectObjects(doc: SceneDoc): {
  objects: number;
  bytes: number;
  save: number;
  layers: number;
} {
  const objects = blocks(doc, 'objects');
  const drivers = blocks(doc, 'drivers');
  const images = storedImageBytes(doc);
  const layers = layerBytes(doc);
  let bytes =
    OBJECT_STORED_BYTES * objects +
    KEYFRAME_STORED_BYTES * keyframes(doc) +
    FCURVE_STORED_BYTES * blocks(doc, 'fcurves') +
    DRIVER_STORED_BYTES * drivers;
  let extraJson = sampledExtraJson(doc, 'objects', objects, (id) => {
    const o = doc.getObject(id);
    return o ? extraJsonChars(o) : 0;
  });
  for (const kind of COUNTED_KINDS) {
    const n = blocks(doc, kind);
    bytes += DATABLOCK_STORED_BYTES[kind] * n;
    if (kind !== 'meshes')
      extraJson += sampledExtraJson(doc, kind, n, (id) => datablockExtraJsonChars(doc, kind, id));
  }
  extraJson += sampledExtraJson(doc, 'drivers', drivers, (key) => driverExtraJsonChars(doc, key));
  bytes += OBJECT_JSON_STORED_BYTES * extraJson;
  return {
    objects,
    bytes: bytes + images,
    save: saveBytes(bytes) + SAVE_BYTES_PER_IMAGE_BYTE * images + SAVE_BYTES_PER_LAYER_BYTE * layers,
    layers,
  };
}

/**
 * What a save of a project takes for a moment per byte of its images (beyond the images it keeps):
 * the save copies them as it encodes, reads back and merges the project's state, 3.0–4.0 times their
 * bytes measured as resident memory (saves of projects with an image of 10, 40 and 80 MB to a disk
 * store, the project stored before), rounded up.
 */
export const SAVE_BYTES_PER_IMAGE_BYTE = 5;

/**
 * Bytes of the document's images (their data, read in place). The document keeps them as they are,
 * outside the JavaScript heap but in the server's memory all the same, so a project counts them with
 * what it keeps, and a save of it with what it copies ({@link SAVE_BYTES_PER_IMAGE_BYTE}).
 */
export function storedImageBytes(doc: SceneDoc): number {
  let bytes = 0;
  for (const id of doc.map('images').keys()) bytes += doc.getImageBytes(id)?.byteLength ?? 0;
  return bytes;
}

/**
 * Heap a project keeps in the server's process (bytes): its meshes decoded (from their stored
 * counts, as an open project holds them once something read them), its objects and datablocks
 * ({@link OBJECT_STORED_BYTES}, {@link DATABLOCK_STORED_BYTES} each) and keyframes
 * ({@link KEYFRAME_STORED_BYTES}). Counted without reading the objects: a pass over the entries of
 * the document's maps and the headers of the stored meshes. A save of the project takes
 * {@link saveBytes} of the objects' part more for a moment.
 */
export function projectStoredBytes(doc: SceneDoc): number {
  return storedMeshBytes(doc) + projectObjects(doc).bytes;
}

/**
 * Heap one scene evaluation keeps per object (bytes; eval/evaluate.ts: the object's fields at the
 * frame, its matrices, materials, light, camera, armature and pose), beyond
 * {@link EVALUATED_BYTES_PER_JSON_CHAR} per character of its JSON over
 * {@link OBJECT_BASE_JSON_CHARS}: 1,537–1,563 measured (the second and third evaluations of 10,000
 * linked or own cubes, Bézier curves or texts, the evaluator's caches warm, --expose-gc), rounded up.
 */
export const EVALUATED_OBJECT_BYTES = 1_600;

/**
 * Heap one scene evaluation keeps per character of an object's JSON over
 * {@link OBJECT_BASE_JSON_CHARS}, its light's, camera's or armature's JSON included (bytes): 1.9
 * measured for mesh objects of 4 modifiers (3,738 bytes each), 2.5–2.8 for lights, cameras and
 * armatures; rounded up.
 */
export const EVALUATED_BYTES_PER_JSON_CHAR = 3;

/** Heap one scene evaluation keeps per bone of an armature, its pose (an armature of one bone: 3,434 bytes measured). */
export const EVALUATED_BONE_BYTES = 800;

/**
 * Heap one scene evaluation keeps per particle or collection instance that changed since the
 * evaluation before (an animated emitter: 298 bytes measured per instance of 100,000), rounded up.
 * Unchanged instances cost nothing: the instancing caches share them between evaluations.
 */
export const EVALUATED_INSTANCE_BYTES = 320;

/**
 * Peak heap of evaluating a scene, per object, from what the evaluation keeps of it (`perObject`):
 * EVALUATION_PEAK_FACTOR × perObject + EVALUATION_PEAK_BYTES. Measured peaks (--trace-gc, garbage
 * included, 10,000 objects): 4.0–4.9 KB for objects of the default size (5.8 KB estimated),
 * 5.2 KB for Bézier curves and texts (5.8 KB), 8.2 KB for mesh objects of 4 modifiers (16.3 KB),
 * 9.7 KB for armatures of one bone (11.7 KB). Modifiers, curve and text surfaces and stored meshes
 * are checked apart (eval/memory.ts, mesh/memory.ts) when they are built.
 */
export const EVALUATION_PEAK_FACTOR = 3;
export const EVALUATION_PEAK_BYTES = 1_000;

/** What one scene evaluation takes, estimated before it runs ({@link sceneEvaluationBytes}). */
export interface EvaluationSize {
  /** Objects of the scene. */
  objects: number;
  /** Heap the evaluation keeps per object (bytes). */
  perObject: number;
  /** Heap the evaluation keeps (bytes): `objects` × `perObject`. */
  retained: number;
  /** Peak heap of the evaluation (bytes). */
  peak: number;
}

/**
 * The heap one evaluation of `doc`'s objects keeps and takes at its peak (see
 * {@link EVALUATED_OBJECT_BYTES}), estimated from the JSON of `sample` objects spread over the
 * document (their datablock's for lights, cameras and armatures): a pass over the entries of the
 * objects map, `sample` of them read. Modifiers, curve and text surfaces and stored meshes are
 * checked apart when they are built; instances and the meshes modifiers make are counted from the
 * evaluation itself (EVALUATED_INSTANCE_BYTES, mesh/memory.ts).
 */
export function sceneEvaluationBytes(doc: SceneDoc, sample = 64): EvaluationSize {
  const objects = blocks(doc, 'objects');
  if (!objects) return { objects: 0, perObject: 0, retained: 0, peak: 0 };
  const step = Math.max(1, Math.floor(objects / sample));
  let i = 0;
  let read = 0;
  let extra = 0;
  for (const y of doc.map('objects').values()) {
    if (i++ % step) continue;
    if (read >= sample) break;
    const o = (y as { toJSON(): ObjectData }).toJSON();
    let chars = JSON.stringify(o).length;
    let bones = 0;
    const kind =
      o.type === 'LIGHT'
        ? 'lights'
        : o.type === 'CAMERA'
          ? 'cameras'
          : o.type === 'ARMATURE'
            ? 'armatures'
            : null;
    const block =
      kind && o.data ? (doc.map(kind).get(o.data) as { toJSON(): unknown } | undefined) : undefined;
    if (block) {
      const json = block.toJSON() as { bones?: unknown };
      chars += JSON.stringify(json).length;
      if (Array.isArray(json.bones)) bones = json.bones.length;
    }
    extra +=
      EVALUATED_BYTES_PER_JSON_CHAR * Math.max(0, chars - OBJECT_BASE_JSON_CHARS) +
      EVALUATED_BONE_BYTES * bones;
    read++;
  }
  const perObject = Math.ceil(EVALUATED_OBJECT_BYTES + extra / Math.max(1, read));
  return {
    objects,
    perObject,
    retained: objects * perObject,
    peak: objects * (EVALUATION_PEAK_FACTOR * perObject + EVALUATION_PEAK_BYTES),
  };
}

/**
 * The connected parts of `mesh` that Separate by loose parts makes objects of (mesh/ops/duplicate.ts
 * separateMesh: vertex islands joined by faces and loose edges; every vertex without an edge is a
 * part of its own), counted with a union-find in typed arrays: no topology built, little heap.
 */
export function looseParts(mesh: MeshData): number {
  const n = Math.floor(mesh.positions.length / 3);
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  let parts = n;
  const union = (a: number, b: number) => {
    if (!(a >= 0 && a < n && b >= 0 && b < n)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[ra] = rb;
    parts--;
  };
  for (const f of mesh.faces) for (let i = 1; i < f.length; i++) union(f[0], f[i]);
  for (let i = 0; i + 1 < mesh.looseEdges.length; i += 2) union(mesh.looseEdges[i], mesh.looseEdges[i + 1]);
  return parts;
}

/**
 * The material indices the faces of `mesh` use: Separate by material makes an object of each but
 * the first (loose edges and lone vertices stay with it).
 */
export function materialParts(mesh: MeshData): number {
  const seen = new Set<number>();
  for (const m of mesh.faceMaterials) seen.add(m);
  return Math.max(1, seen.size);
}
