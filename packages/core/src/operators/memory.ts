import type { ModifierData, ObjectData } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { decodedMeshBytes, isMeshMemoryError, type MeshLayout } from '../mesh/memory';
import { base64Decode } from '../util/json';
import {
  CURVE_FIXED_BYTES,
  TEXT_BYTES_PER_CHARACTER,
  estimateCurveSurface,
  estimateModifier,
  textGlyphCount,
  type CurveSurfaceEstimate,
  type EstimateContext,
  type MeshSize,
} from '../eval/memory';
import type { MeshData } from '../mesh/types';
import { isModifierEnabled, modifierDisabledReason } from '../modifiers';
import { MAX_GENERATED_FACES } from '../generate/types';
import type { OperatorContext } from './context';
import { GENERATOR_LOWER, generatorFaces } from './memory-generators';
import { instanceBound } from './memory-instances';
import {
  LAYER_WRITE_BYTES_PER_BYTE,
  SHAPE_KEY_BYTES_PER_VERTEX,
  armatureParentWrites,
  boneRenameWrites,
  shapeKeyWrites,
  vertexGroupWrites,
  type LayerKind,
  type LayerWrites,
  type ShapeKeyChange,
  type VertexGroupChange,
} from './memory-layers';
import {
  bakeTransformsWrites,
  copiedAnimationWrites,
  insertManyWrites,
  keyframeInsertWrites,
  rigidBodyBakeWrites,
  type KeyframeWrites,
} from './memory-keyframes';
import { isGLB } from '../io/glb';
import { sanitizeRigidBodyWorld } from '../physics/settings';
import {
  bytesReader,
  gltfImportSize,
  objImportSize,
  plyImportSize,
  readGltfJson,
  stlImportSize,
  type ImportReader,
  type ImportSize,
} from '../io/import-size';
import {
  KEYFRAME_STORED_BYTES,
  SAVE_BYTES_PER_IMAGE_BYTE,
  SAVE_BYTES_PER_LAYER_BYTE,
  SHAPE_KEY_STORED_BYTES_PER_VERTEX,
  dataKindOf,
  datablockExtraJsonChars,
  extraJsonChars,
  looseParts,
  materialParts,
  meshLayerBytes,
  newObjectsBytes,
  projectObjects,
  saveBytes,
  shapeKeyCount,
  storedMeshBytes,
  vertexGroupBytes,
  type CountedKind,
  type NewObjects,
} from './memory-objects';

export { GENERATOR_LOWER, ISOSURFACE_FACES_PER_CELL, generatorFaces } from './memory-generators';
export {
  BAKE_BYTES_PER_OBJECT_FRAME,
  BAKE_FCURVE_BYTES,
  BAKE_GARBAGE_GROWTH,
  BAKE_HEAP_BYTES,
  BAKE_TRANSFORMS_MAX_FRAMES,
  DRIVER_ADD_BYTES,
  FRAME_STATE_BYTES_PER_DRIVER,
  FRAME_STATE_BYTES_PER_KEYFRAME,
  FRAME_STATE_BYTES_PER_OBJECT,
  INSERT_MANY_BYTES_PER_KEYFRAME,
  INSERT_MANY_REWRITE_BYTES,
  KEYFRAME_COPY_BYTES,
  animationByTarget,
  copiedAnimationWrites,
  FCURVE_ADD_BYTES,
  KEYFRAME_ADD_BYTES,
  KEYFRAME_REWRITE_BYTES,
  RIGID_BODY_BAKE_BYTES,
  RIGID_BODY_BAKE_BYTES_PER_BODY_FRAME,
  frameSamplingBytes,
  frameStateBytes,
  type KeyframeWrites,
} from './memory-keyframes';
export {
  ENVELOPE_WEIGHTS_BYTES_PER_VERTEX,
  HEAT_WEIGHTS_BYTES_PER_VERTEX,
  LAYER_OP_BYTES_PER_VERTEX,
  LAYER_WRITE_BYTES_PER_BYTE,
  SHAPE_KEY_BYTES_PER_VERTEX,
  VERTEX_GROUP_BYTES_PER_VERTEX,
  type LayerKind,
} from './memory-layers';
export { bytesReader, type ImportReader, type ImportSize } from '../io/import-size';
export {
  DATABLOCK_ADD_BYTES,
  DATABLOCK_BASE_JSON_CHARS,
  DRIVER_BASE_JSON_CHARS,
  DRIVER_STORED_BYTES,
  FCURVE_STORED_BYTES,
  EVALUATED_BONE_BYTES,
  EVALUATED_BYTES_PER_JSON_CHAR,
  EVALUATED_INSTANCE_BYTES,
  EVALUATED_OBJECT_BYTES,
  EVALUATION_PEAK_BYTES,
  EVALUATION_PEAK_FACTOR,
  KEYFRAME_STORED_BYTES,
  DATABLOCK_STORED_BYTES,
  OBJECT_ADD_BYTES,
  OBJECT_BASE_JSON_CHARS,
  OBJECT_JSON_ADD_BYTES,
  OBJECT_JSON_STORED_BYTES,
  OBJECT_STORED_BYTES,
  PROJECT_JSON_SAMPLE,
  SAVE_BYTES_PER_IMAGE_BYTE,
  SAVE_BYTES_PER_KEPT_BYTE,
  SAVE_BYTES_PER_LAYER_BYTE,
  SHAPE_KEY_STORED_BYTES_PER_VERTEX,
  datablockExtraJsonChars,
  driverExtraJsonChars,
  extraJsonChars,
  layerBytes,
  looseParts,
  materialParts,
  meshLayerBytes,
  newObjectsBytes,
  projectObjects,
  projectStoredBytes,
  saveBytes,
  sceneEvaluationBytes,
  shapeKeyBytes,
  storedImageBytes,
  storedMeshBytes,
  vertexGroupBytes,
  type EvaluationSize,
  type NewObjects,
} from './memory-objects';

/*
 * Memory estimates of operators, and the check a host can run before each operator.
 *
 * The server runs the operators of MCP tools and of the REST API in its own process, next to every
 * editor connection and agent session, and V8 ends that whole process when its JavaScript heap
 * runs out (a fatal error, not an exception): one Subdivide of a grid of a million faces did. The
 * server therefore installs a check (`setOperatorMemoryCheck`): before an operator runs, the
 * registry asks it with the operator's estimated peak heap, and a refused operator fails with code
 * OUT_OF_MEMORY and says why, what it would need and what to lower. Without a check (the browser,
 * the server's render processes) operators run as before.
 *
 * The estimates are what an operator took at the peak of the JavaScript heap (--trace-gc, garbage
 * included, so they err on the safe side), measured on grids of 10,000 to 490,000 faces with every
 * element selected, per face of the edited mesh and per face it adds, rounded up. Edit Mode
 * operators build string-keyed edge structures (topology, the selection) for the whole mesh: about
 * 0.5–5 KB per face; those that add faces take 1–3.4 KB per added face. Every estimate includes the
 * decoded size of what the operator stores (the next read decodes it, see mesh/memory.ts).
 * Operators that give each selected object a mesh of its own (Join, Apply Transform, Set Origin,
 * Convert) count every object, linked duplicates included, and the meshes they add; Convert and
 * the exports also count curve and text surfaces (eval/memory.ts estimateCurveSurface) and what
 * their new evaluation of the whole scene keeps, the exports every particle and collection
 * instance they write (memory-instances.ts). Every operator and import that adds objects counts
 * them and their datablocks (memory-objects.ts: about 18 KB each at the peak, 11 KB kept): Separate
 * by loose parts or by material from the parts it will make, duplicates, made-real instances,
 * layouts, primitives, generators and the objects of an imported file. The project's objects and
 * datablocks count with its decoded meshes towards what the server keeps for one project, and so
 * does what a save of the project takes for a moment (memory-objects.ts saveBytes: three times
 * what its objects, datablocks and keyframes keep).
 *
 * Every registered operator is either estimated here (OPERATOR_ESTIMATES) or listed with the reason
 * it cannot grow the geometry much past what it reads (UNESTIMATED_OPERATORS); a test checks that
 * every operator is one of the two.
 */

/** The estimated memory of one operator run. */
export interface OperatorEstimate {
  /**
   * JavaScript heap the run takes at its peak beyond what is in use before it (bytes), the decoded
   * size of the geometry it stores included.
   */
  bytes: number;
  /** Faces of the mesh(es) it builds or edits, for messages (0: none). */
  faces: number;
  /**
   * Heap the document keeps of what it adds (0 when it adds nothing): the decoded size of the
   * meshes it adds, and its new objects and datablocks (memory-objects.ts).
   */
  addedStoredBytes: number;
  /**
   * Heap a save of the project takes for a moment for what it adds, beyond addedStoredBytes
   * (memory-objects.ts saveBytes of its new objects, datablocks and keyframes; 0 or absent: none).
   */
  addedSaveBytes?: number;
  /** Objects it adds (for messages; 0 or absent: none). */
  objects?: number;
  /** Keyframes it adds at most (for messages; 0 or absent: none). */
  keyframes?: number;
  /**
   * Bytes of rigid body frames it simulates that the document's cache keeps afterwards (physics/
   * memory.ts; part of addedStoredBytes, not saved; 0 or absent: none).
   */
  simulationBytes?: number;
  /** Meshes it builds when more than one (an import; for messages, with `faces` their faces in all). */
  meshes?: number;
  /**
   * The vertex groups or shape keys of meshes it writes (memory-layers.ts; for messages: their kind and
   * bytes, the more of before and after); absent: none.
   */
  layers?: { kind: LayerKind; bytes: number };
  /**
   * What to lower for a smaller result, completing "Lower …" (e.g. "number_cuts"); empty when the
   * operator adds next to nothing (a cube).
   */
  lower: string;
}

/** What an {@link OperatorMemoryCheck} is asked before an operator runs. */
export interface OperatorMemoryRequest {
  /** Operator id, e.g. "mesh.subdivide". */
  operator: string;
  estimate: OperatorEstimate;
  /**
   * Heap the project keeps before the operator (memory-objects.ts projectStoredBytes): its meshes
   * decoded (from their stored counts) and its objects and datablocks; counted when the operator
   * adds to it (addedStoredBytes > 0), else 0.
   */
  storedBytes: number;
  /**
   * Heap a save of the project takes for a moment beyond storedBytes (memory-objects.ts saveBytes of
   * its objects, datablocks and keyframes), counted with storedBytes (else 0 or absent).
   */
  saveBytes?: number;
  /** The project's objects before the operator (counted with storedBytes, else absent). */
  objects?: number;
  /**
   * The document the operator runs on (the server counts it with its other open projects); absent
   * where the caller has none.
   */
  doc?: SceneDoc;
}

/** Returns null to run the operator, or why it is not run (it then fails with code OUT_OF_MEMORY). */
export type OperatorMemoryCheck = (req: OperatorMemoryRequest) => string | null;

type Estimator = (ctx: OperatorContext, params: Record<string, unknown>) => OperatorEstimate | null;

// ---------------------------------------------------------------- measured constants

/**
 * Garbage an operator's run leaves in V8's young generation before a scavenge collects it, part of
 * every peak measured with --trace-gc (bytes): what small runs show beyond their per-face cost.
 * Every estimate includes it.
 */
export const OPERATOR_FIXED_BYTES = 32 * 1024 * 1024;

/**
 * Peak heap per face of the edited mesh of Edit Mode operators that do not add faces, beyond
 * {@link OPERATOR_FIXED_BYTES} (bytes): up to 3,353 measured (Split on 122,500 faces; Smart UV
 * Project, Unwrap, Merge by Distance, Smooth Vertices, Recalculate Normals, Mark Seam, Triangles to
 * Quads and Symmetrize up to 3,000–3,300, on grids of 22,500 to 302,500 faces), rounded up.
 */
export const EDIT_BYTES_PER_FACE = 3800;

/** Per face of the edited mesh, operators that need more or less than {@link EDIT_BYTES_PER_FACE}. */
export const EDIT_BYTES_PER_FACE_BY_OPERATOR: Readonly<Record<string, number>> = {
  /** 508–696 measured (Move on 90,000 and 490,000 faces). */
  'transform.translate': 1000,
  'transform.rotate': 1000,
  'transform.resize': 1000,
  /** 1,870–2,265 measured ((De)select All on 22,500 to 302,500 faces). */
  select: 2600,
  /** 1,957–2,106 measured (Delete Faces). */
  'mesh.delete': 2500,
  /** 4,049–4,922 measured (Extrude Region on 22,500 to 250,000 faces, Inset, Extrude Vertices). */
  'mesh.extrude_region_move': 5500,
  'mesh.extrude_region_shrink_fatten': 5500,
  'mesh.extrude_vertices_move': 5500,
  'mesh.inset': 5500,
  /** 10,060 fitted (Bevel of every edge of 22,500 faces with 1 and 3 segments). */
  'mesh.bevel': 10500,
  /** Entering Edit Mode selects every element: 253–421 measured (62,500 and 122,500 faces). */
  'object.mode_set': 600,
};

/**
 * Peak heap per face an Edit Mode operator adds (bytes), beyond the per-face cost of the mesh:
 * Subdivide 2,190–3,370 (10,000 → 160,000 and 62,500 → 250,000 faces), Spin 2,870, Extrude Edges
 * 2,070, Extrude Individual Faces 1,410, Inset Individual 1,410, Bevel 1,430, Duplicate 1,130,
 * Poke 960, Solidify 370, Triangulate 180; rounded up.
 */
export const ADDED_FACE_BYTES: Readonly<Record<string, number>> = {
  'mesh.subdivide': 3400,
  'mesh.loopcut': 3400,
  'mesh.spin': 3500,
  'mesh.bridge_edge_loops': 3500,
  'mesh.extrude_edges_move': 2500,
  'mesh.extrude_faces_move': 2200,
  'mesh.inset': 2200,
  'mesh.extrude_region_move': 3500,
  'mesh.extrude_region_shrink_fatten': 3500,
  'mesh.bevel': 2000,
  'mesh.duplicate_move': 2000,
  'mesh.poke': 1500,
  'mesh.solidify': 1000,
  'mesh.quads_convert_to_tris': 1000,
  'mesh.symmetrize': 1000,
  'mesh.fill': 3500,
  primitive: 3500,
};

/**
 * Spin keeps a copy of every selected vertex for every step (its position and the step's maps from
 * the profile to the copies) while it sweeps: per copy, beyond what the faces it adds account for,
 * 88–343 bytes measured where those fell short of the peak (all of grids of 3,600 to 62,500 faces
 * in 12 to 1,000 steps), rounded up.
 */
export const SPIN_BYTES_PER_COPY = 400;

/**
 * Peak heap per face of a new primitive in Object Mode (bytes): 323 measured (a grid of 250,000
 * faces), rounded up; its decoded size is added apart.
 */
export const PRIMITIVE_BYTES_PER_FACE = 400;

/**
 * Peak heap per face of a generated object (object.generate_*), its stored mesh decoded once to
 * describe it included: 990–1,080 measured (blob of 205,836 faces, terrain of 262,144), rounded up.
 */
export const GENERATOR_BYTES_PER_FACE = 1100;

/**
 * Most faces each of the small generators built with its numeric parameters at their maxima
 * (measured), doubled for combinations of parameters: at most 80,000 faces (135 MB estimated).
 * The others are counted from their parameters (operators/memory-generators.ts).
 */
export const GENERATOR_MAX_FACES: Readonly<Record<string, number>> = {
  barrel: 80_000,
  bush: 7_000,
  chair: 200,
  column: 15_000,
  flower: 4_000,
  gear: 8_000,
  grass_tuft: 42_000,
  rock: 41_000,
  shelf: 1_000,
  stairs: 2_000,
  table: 200,
  wheel: 10_000,
};

/**
 * Peak heap per face (of the meshes they read) of Object Mode operators that copy or rewrite whole
 * meshes: a decoded copy and the stored result. Not measured per operator: twice the decoded size
 * of a face with UVs (248 B for a quad) plus the per-face cost of rebuilding it, rounded up.
 */
export const OBJECT_MESH_BYTES_PER_FACE = 1000;

/**
 * Imported meshes, per byte of the file, where the format's header does not count them: parsing,
 * the meshes built and stored, and their decoded size. Measured with --trace-gc beyond
 * OPERATOR_FIXED_BYTES, the decoded meshes added: 8–14 per byte of grids exported with normals and
 * UVs (OBJ, PLY, glTF and GLB of 1.5 to 51 MB; ASCII STL 3), 18–23 per byte of files of nothing but
 * positions and triangles (a GLB of 17 MB and an OBJ of 29 MB, 980,000 triangles each), 24.7 per
 * byte of such an OBJ of 5 MB; rounded up.
 */
export const IMPORT_BYTES_PER_FILE_BYTE = 26;

/**
 * Decoded bytes of the meshes an import adds per byte of the file, at most (a GLB of triangles with
 * UVs and nothing else, the densest of the formats: 9.6).
 */
export const IMPORT_STORED_BYTES_PER_FILE_BYTE = 10;

/**
 * A binary STL, per triangle its header declares: reading and welding the triangles, 406–527 bytes
 * measured on files of 80,000 to 1,040,000 triangles (561 through run_operator, which decodes the
 * file from base64), rounded up; the decoded mesh is added apart (at most three vertices per
 * triangle).
 */
export const IMPORT_BYTES_PER_STL_TRIANGLE = 700;

/**
 * Imports counted from their files (glTF, GLB, PLY: io/import-size.ts), per byte of the meshes they
 * decode (mesh/memory.ts decodedMeshBytes, summed over the meshes): the importer holds every mesh it
 * parsed until it stores them all, and the garbage of parsing them: up to 2.04 times their decoded
 * size measured beyond OPERATOR_FIXED_BYTES and the term per corner below (GLBs of 2 to 24 meshes
 * sharing the accessors of grids of 150 × 150 to 600 × 600 quads; 2.04 for 8 meshes of a grid of
 * 300 × 300, which peaked at 386 MB). With 2.5 every import estimate measured is at least 1.18 times
 * its peak (that GLB: 455 MB estimated; with 2, 381 MB, at its peak).
 */
export const IMPORT_BYTES_PER_DECODED_BYTE = 2.5;

/**
 * Imports counted from their files, per face corner of the largest mesh: what the importer builds for
 * one mesh at a time (its edges as a set of strings, arrays grown while they are filled), 42–68
 * bytes left by the decoded term above on single meshes of 180,000 and 720,000 triangles, rounded up.
 */
export const IMPORT_BYTES_PER_CORNER_OF_LARGEST_MESH = 100;

/** glTF morph targets, per vertex of every target (its shape key's positions): 39 measured, rounded up. */
export const IMPORT_BYTES_PER_MORPH_VERTEX = 60;

/**
 * glTF animation keyframes the import adds (one per key and component of a channel): 162–207 bytes
 * measured at the peak (300,000 to 900,000 keyframes), rounded up; the document keeps about 100 of
 * them (memory-objects.ts KEYFRAME_STORED_BYTES).
 */
export const IMPORT_BYTES_PER_KEYFRAME = 250;

/**
 * glTF images embedded in a file, per byte of those the import stores (io/import-size.ts imageBytes):
 * the importer keeps them as they are (outside the JavaScript heap, in memory all the same); the file
 * it decodes, the copy it takes, the document's, the update of the import's transaction and the sync
 * frame the project's room makes of that update are held at once: 5.0 times their bytes measured as
 * resident memory at the peak with the server's listeners on the document (GLBs with an image of 20,
 * 40 and 60 MB: 105.1, 210.1 and 315.0 MB; test/operator-memory-rss-child.ts), rounded up: estimates
 * 1.31–1.52 times those peaks. The project keeps them once, and a save copies them 3.0–4.0 times for
 * a moment (memory-objects.ts storedImageBytes, SAVE_BYTES_PER_IMAGE_BYTE).
 */
export const IMPORT_BYTES_PER_IMAGE_BYTE = 6;

/**
 * glTF images embedded in a file that the import leaves out (of materials no imported mesh uses), per
 * byte: the file the import decodes holds them while it runs (1 per byte read from the code: the GLB's
 * binary chunk is a view of the decoded file; a GLB of 60 MB with 2 such images of 20 MB peaked 40 MB
 * above the same file with one), rounded up.
 */
export const IMPORT_BYTES_PER_UNUSED_IMAGE_BYTE = 1.5;

/**
 * glTF JSON text the import parses, per character (the text and the objects it is parsed into; a
 * .gltf file's whole text, data URIs included): 2.4 measured, rounded up.
 */
export const IMPORT_BYTES_PER_JSON_CHAR = 3;

/**
 * Peak heap of the export operators (export_scene.*, export_mesh.*, run in the server's process
 * through run_operator and batch) per face of the meshes they write (bytes): the file is built in
 * that heap and returned in base64. Measured on grids of 90,000 and 250,000 faces: OBJ (text)
 * 1,562–1,682, STL 958–1,045, PLY 721–808, glTF with an embedded buffer 407, GLB at most 189;
 * rounded up.
 */
export const EXPORT_BYTES_PER_FACE: Readonly<Record<'obj' | 'stl' | 'ply' | 'gltf' | 'glb', number>> = {
  obj: 1800,
  stl: 1100,
  ply: 900,
  gltf: 500,
  glb: 300,
};

/**
 * Peak heap of the export operators per particle or collection instance they write, beyond its faces
 * (EXPORT_BYTES_PER_FACE) and the young generation's garbage (OPERATOR_FIXED_BYTES), in bytes: its
 * placement, export item and node: 410 (STL) to 1,650 (glTF) measured on exports of 100,000
 * instances of a plane, rounded up.
 */
export const EXPORT_BYTES_PER_INSTANCE = 2000;

// ---------------------------------------------------------------- helpers

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Layout of a stored mesh from its counts, with a UV layer (its decoded size errs on the safe side). */
function storedLayout(doc: SceneDoc, meshId: string | null | undefined): MeshLayout | null {
  if (!meshId) return null;
  const c = doc.meshCounts(meshId);
  return c ? { vertices: c.vertices, faces: c.faces, corners: c.corners, uvs: true, colors: false } : null;
}

/** Decoded bytes of a mesh of `faces` faces of `cornersPerFace` corners with UVs (vertices ≈ faces). */
function decodedFaces(faces: number, cornersPerFace = 4): number {
  return decodedMeshBytes({
    vertices: faces,
    faces,
    corners: faces * cornersPerFace,
    uvs: true,
    colors: false,
  });
}

const EMPTY: MeshLayout = { vertices: 0, faces: 0, corners: 0, uvs: false, colors: false };

/**
 * `e` with the objects and datablocks an operator adds (memory-objects.ts): their peak heap on top
 * of its own, and what the document keeps of them added to what it stores. An operator with no
 * estimate of its own gets the young generation's garbage (OPERATOR_FIXED_BYTES) and these, and
 * `lower` (also when `e` has nothing to lower).
 */
function withObjects(e: OperatorEstimate | null, a: NewObjects, lower = ''): OperatorEstimate | null {
  const datablocks = Object.values(a.datablocks ?? {}).reduce((n, k) => n + (k ?? 0), 0);
  if (!(a.objects > 0) && !(datablocks > 0)) return e;
  const { peak, stored } = newObjectsBytes(a);
  return {
    ...e,
    bytes: (e?.bytes ?? OPERATOR_FIXED_BYTES) + peak,
    faces: e?.faces ?? 0,
    addedStoredBytes: (e?.addedStoredBytes ?? 0) + stored,
    addedSaveBytes: (e?.addedSaveBytes ?? 0) + saveBytes(stored),
    objects: (e?.objects ?? 0) + Math.max(0, a.objects),
    lower: e?.lower || lower,
  };
}

/** One new object (and its datablock of `kind`, if any): the add operators. */
const oneObject =
  (kind: CountedKind | null, lower = ''): Estimator =>
  () =>
    withObjects(null, { objects: 1, datablocks: kind ? { [kind]: 1 } : {} }, lower);

/** The mesh edited in Edit Mode and the sizes of its selection, or null outside mesh Edit Mode. */
interface EditGeometry {
  meshId: string;
  faces: number;
  corners: number;
  vertices: number;
  /** Mean corners per face (4 for quads). */
  m: number;
  selFaces: number;
  selEdges: number;
  selVerts: number;
}

/** Selection sizes the estimates assume instead of the editor's (see editOperatorMemoryRefusal). */
let assumedSelection: { verts: number; edges: number; faces: number } | null = null;

function editGeometry(ctx: OperatorContext): EditGeometry | null {
  if (ctx.state.mode !== 'EDIT') return null;
  const o = ctx.state.activeId ? ctx.doc.getObject(ctx.state.activeId) : null;
  if (!o || o.type !== 'MESH' || !o.data) return null;
  const c = ctx.doc.meshCounts(o.data);
  if (!c) return null;
  const sel = ctx.state.meshSelection;
  const sizes = assumedSelection ?? { verts: sel.verts.size, edges: sel.edges.size, faces: sel.faces.size };
  return {
    meshId: o.data,
    faces: c.faces,
    corners: c.corners,
    vertices: c.vertices,
    m: c.faces ? c.corners / c.faces : 4,
    selFaces: sizes.faces,
    selEdges: sizes.edges,
    selVerts: sizes.verts,
  };
}

/** Edges on the outline of the selected faces, plus selected wire edges counted twice (2E − corners). */
const outline = (g: EditGeometry): number => Math.max(0, 2 * g.selEdges - g.selFaces * g.m);

/**
 * Faces of the edge ring a loop cut through edge [a, b] crosses: the walk across quads to their
 * opposite edges, in both directions (vertex → faces adjacency in typed arrays, so the estimate
 * costs little heap). Null when the edge is not in the mesh.
 */
export function edgeRingFaces(
  faces: readonly (readonly number[])[],
  vertexCount: number,
  a: number,
  b: number,
): number | null {
  if (!(a >= 0 && b >= 0 && a < vertexCount && b < vertexCount) || a === b) return null;
  const start = new Int32Array(vertexCount + 1);
  for (const f of faces) for (const v of f) if (v >= 0 && v < vertexCount) start[v + 1]++;
  for (let i = 0; i < vertexCount; i++) start[i + 1] += start[i];
  const fill = start.slice(0, vertexCount);
  const adj = new Int32Array(start[vertexCount]);
  for (let fi = 0; fi < faces.length; fi++)
    for (const v of faces[fi]) if (v >= 0 && v < vertexCount) adj[fill[v]++] = fi;
  const facesOf = (x: number, y: number): number[] => {
    const out: number[] = [];
    for (let i = start[x]; i < start[x + 1]; i++) {
      const fi = adj[i];
      const f = faces[fi];
      for (let k = 0; k < f.length; k++)
        if (f[k] === x && (f[(k + 1) % f.length] === y || f[(k + f.length - 1) % f.length] === y)) {
          if (!out.includes(fi)) out.push(fi);
          break;
        }
    }
    return out;
  };
  const first = facesOf(a, b);
  if (!first.length) return null;
  const seen = new Set<number>();
  for (const f0 of first) {
    let fi = f0;
    let e: [number, number] = [a, b];
    while (!seen.has(fi)) {
      seen.add(fi);
      const f = faces[fi];
      if (f.length !== 4) break;
      const i = f.indexOf(e[0]);
      const j = f.indexOf(e[1]);
      if (i < 0 || j < 0) break;
      // the opposite edge of the quad: the two corners that are neither a nor b
      const rest = [0, 1, 2, 3].filter((k) => k !== i && k !== j).map((k) => f[k]);
      e = [rest[0], rest[1]];
      const next = facesOf(e[0], e[1]).find((x) => x !== fi);
      if (next === undefined) break;
      fi = next;
    }
  }
  return seen.size;
}

/**
 * An Edit Mode operator: the per-face cost of the edited mesh, plus the faces it adds
 * (`resultFaces` − faces, at `ADDED_FACE_BYTES`) and their decoded size.
 */
function edit(
  id: string,
  resultFaces?: (g: EditGeometry, p: Record<string, unknown>, ctx: OperatorContext) => number,
  lower = 'the number of faces of the mesh',
  extraBytes?: (g: EditGeometry, p: Record<string, unknown>) => number,
): Estimator {
  const perFace =
    EDIT_BYTES_PER_FACE_BY_OPERATOR[id] ??
    (id.startsWith('mesh.select_') || id === 'mesh.loop_select' || id === 'mesh.edgering_select'
      ? EDIT_BYTES_PER_FACE_BY_OPERATOR.select
      : EDIT_BYTES_PER_FACE);
  return (ctx, p) => {
    const g = editGeometry(ctx);
    if (!g) return null;
    const out = resultFaces ? Math.max(0, Math.ceil(resultFaces(g, p, ctx))) : g.faces;
    const added = Math.max(0, out - g.faces);
    const addedStored = added ? decodedFaces(added, g.m) : 0;
    return {
      bytes:
        OPERATOR_FIXED_BYTES +
        perFace * g.faces +
        (ADDED_FACE_BYTES[id] ?? EDIT_BYTES_PER_FACE) * added +
        addedStored +
        (extraBytes ? extraBytes(g, p) : 0),
      faces: out,
      addedStoredBytes: addedStored,
      lower,
    };
  };
}

/** Faces of a primitive with these (schema-filled) parameters. */
export function primitiveFaces(type: string, p: Record<string, unknown>): number {
  const caps = (fill: unknown, n: number, count: number) =>
    fill === 'NOTHING' ? 0 : fill === 'TRIFAN' ? count * n : count;
  switch (type) {
    case 'CUBE':
      return 6;
    case 'PLANE':
      return 1;
    case 'GRID':
      return num(p.x_subdivisions, 10) * num(p.y_subdivisions, 10);
    case 'CIRCLE':
      return caps(p.fill_type, num(p.vertices, 32), 1);
    case 'UV_SPHERE':
      return num(p.segments, 32) * num(p.ring_count, 16);
    case 'ICO_SPHERE':
      return 20 * 4 ** (num(p.subdivisions, 2) - 1);
    case 'CYLINDER':
    case 'CONE': {
      const n = num(p.vertices, 32);
      return n + caps(p.end_fill_type, n, 2);
    }
    case 'TORUS':
      return num(p.major_segments, 48) * num(p.minor_segments, 12);
    default:
      return 0;
  }
}

/** mesh.primitive_*_add: a new object in Object Mode, merged into the edited mesh in Edit Mode. */
function primitive(type: string, lower: string): Estimator {
  return (ctx, p) => {
    const faces = primitiveFaces(type, p);
    const stored = decodedFaces(faces);
    const g = editGeometry(ctx);
    if (g) {
      // Edit Mode: the primitive is appended to a copy of the edited mesh
      return {
        bytes:
          OPERATOR_FIXED_BYTES + EDIT_BYTES_PER_FACE * g.faces + ADDED_FACE_BYTES.primitive * faces + stored,
        faces: g.faces + faces,
        addedStoredBytes: stored,
        lower: lower ? `${lower} (or the faces of the edited mesh)` : 'the faces of the edited mesh',
      };
    }
    return withObjects(
      {
        bytes: OPERATOR_FIXED_BYTES + PRIMITIVE_BYTES_PER_FACE * faces + stored,
        faces,
        addedStoredBytes: stored,
        lower,
      },
      { objects: 1, datablocks: { meshes: 1 } },
    );
  };
}

/** Selected objects that are meshes, each mesh datablock once (operators that change a shared mesh once). */
function selectedMeshes(ctx: OperatorContext, ids?: string[]): ObjectData[] {
  const seen = new Set<string>();
  const out: ObjectData[] = [];
  for (const id of ids ?? ctx.state.selectedIds) {
    const o = ctx.doc.getObject(id);
    if (!o || o.type !== 'MESH' || !o.data || seen.has(o.data)) continue;
    seen.add(o.data);
    out.push(o);
  }
  return out;
}

/** Every selected object that is a mesh: linked duplicates (objects sharing one mesh) each count. */
function selectedMeshObjects(ctx: OperatorContext): ObjectData[] {
  const out: ObjectData[] = [];
  for (const id of ctx.state.selectedIds) {
    const o = ctx.doc.getObject(id);
    if (o && o.type === 'MESH' && o.data) out.push(o);
  }
  return out;
}

function facesOf(ctx: OperatorContext, objects: readonly ObjectData[]): number {
  let f = 0;
  for (const o of objects) f += ctx.doc.meshCounts(o.data!)?.faces ?? 0;
  return f;
}

/** Decoded bytes of stored mesh `meshId`, from its stored counts. */
const meshBytes = (doc: SceneDoc, meshId: string | null | undefined): number =>
  decodedMeshBytes(storedLayout(doc, meshId) ?? EMPTY);

/** How many objects use each datablock. */
function dataUsers(doc: SceneDoc): Map<string, number> {
  const users = new Map<string, number>();
  for (const o of doc.listObjects()) if (o.data) users.set(o.data, (users.get(o.data) ?? 0) + 1);
  return users;
}

/** How many of `objects` use each mesh. */
function meshPicks(objects: readonly ObjectData[]): Map<string, number> {
  const picks = new Map<string, number>();
  for (const o of objects) if (o.data) picks.set(o.data, (picks.get(o.data) ?? 0) + 1);
  return picks;
}

/**
 * Decoded bytes of the copies an operator that gives each object a mesh of its own stores for
 * `objects` (object.ts singleUserMesh: an object whose mesh other objects use too gets a copy first),
 * so a mesh used by u objects, k of them in `objects`, is copied min(k, u − 1) times.
 */
function singleUserCopies(doc: SceneDoc, objects: readonly ObjectData[]): number {
  const users = dataUsers(doc);
  let bytes = 0;
  for (const [meshId, k] of meshPicks(objects))
    bytes += Math.min(k, Math.max(0, (users.get(meshId) ?? 1) - 1)) * meshBytes(doc, meshId);
  return bytes;
}

/**
 * Object Mode operators that copy or rewrite the meshes of the selected objects. `singleUser`: the
 * operator gives every selected object a mesh of its own before it rewrites it (object.transform_apply
 * and object.origin_set), so linked duplicates each count and their copies are added; the others
 * rewrite (shading) or copy (object.duplicate, `copies`) each mesh once.
 */
function objectMeshes(lower: string, opts: { copies?: boolean; singleUser?: boolean } = {}): Estimator {
  return (ctx) => {
    const objects = opts.singleUser ? selectedMeshObjects(ctx) : selectedMeshes(ctx);
    if (!objects.length) return null;
    let decoded = 0;
    for (const o of objects) decoded += meshBytes(ctx.doc, o.data);
    const faces = facesOf(ctx, objects);
    const added = opts.copies ? decoded : opts.singleUser ? singleUserCopies(ctx.doc, objects) : 0;
    // the copies of meshes also get their vertex groups and shape keys (object.ts duplicate), each list
    // read and written again (memory-layers.ts), kept and saved as the project counts them
    let layers = 0;
    let layersKept = 0;
    if (opts.copies)
      for (const o of objects) {
        layers += meshLayerBytes(ctx.doc, o.data!);
        layersKept +=
          vertexGroupBytes(ctx.doc, o.data!) +
          SHAPE_KEY_STORED_BYTES_PER_VERTEX *
            shapeKeyCount(ctx.doc, o.data!) *
            (ctx.doc.meshCounts(o.data!)?.vertices ?? 0);
      }
    return {
      bytes:
        OPERATOR_FIXED_BYTES +
        OBJECT_MESH_BYTES_PER_FACE * faces +
        decoded +
        added +
        LAYER_WRITE_BYTES_PER_BYTE * layers,
      faces,
      addedStoredBytes: added + layersKept,
      ...(layers > 0 ? { addedSaveBytes: SAVE_BYTES_PER_LAYER_BYTE * layers } : {}),
      lower,
    };
  };
}

/**
 * Whether the stored mesh `meshId` has shape keys that are not muted: the evaluation then deforms it
 * before its modifiers (by their values at the frame, which animation can change), so the stored
 * mesh is not their input. Reads the stored keys in place (no copy of their data).
 */
function hasShapeKeys(doc: SceneDoc, meshId: string): boolean {
  const keys = (doc.map('meshes').get(meshId) as { get(key: string): unknown } | undefined)?.get(
    'shape_keys',
  );
  return Array.isArray(keys) && keys.some((k) => !(k as { mute?: unknown } | null)?.mute);
}

/**
 * How the estimates size modifier `m` of object `o` from stored counts (eval/memory.ts
 * estimateModifier): a Bevel limited by angle that is the first modifier of a mesh without shape
 * keys counts the edges it bevels on the stored mesh, decoded (the evaluation decodes it all the
 * same; one the host does not decode counts like the rest); every other one by angle as if every edge
 * were sharp (limit_method NONE's bound), since its input's shape is not known before the evaluation
 * (shape keys deform it first: a flat grid of 3,600 faces with a shape key that folds it, beveled by
 * 0.1 rad in 4 segments, gave 17,406 faces where its stored shape counted none).
 */
export function modifierContext(
  doc: SceneDoc,
  o: ObjectData,
  m: { type: string; params?: Record<string, unknown> },
  first: boolean,
  forRender: boolean,
): EstimateContext {
  let bevelInput: MeshData | null = null;
  if (
    m.type === 'BEVEL' &&
    m.params?.limit_method !== 'NONE' &&
    first &&
    o.type === 'MESH' &&
    o.data &&
    !hasShapeKeys(doc, o.data)
  ) {
    try {
      bevelInput = doc.getMesh(o.data);
    } catch (err) {
      if (!isMeshMemoryError(err)) throw err;
    }
  }
  return { forRender, bevelInput, bevelUpperBound: true };
}

/**
 * The surface curve or text object `o` gets in an evaluation (eval/memory.ts estimateCurveSurface;
 * text at least at the measured cost per character), or null without curve data. `fixed`: the part of
 * its peak that is the young generation's garbage (CURVE_FIXED_BYTES, which an operator's estimate
 * counts once as OPERATOR_FIXED_BYTES however many surfaces it builds), 0 when the cost per character
 * of a text sets the peak.
 */
function curveSurface(
  ctx: OperatorContext,
  o: ObjectData,
  forRender: boolean,
): (CurveSurfaceEstimate & { fixed: number }) | null {
  const curve = o.data ? ctx.doc.getCurve(o.data) : null;
  if (!curve) return null;
  const bevelObject =
    curve.bevel_mode === 'OBJECT' && curve.bevel_object ? ctx.doc.getObject(curve.bevel_object) : null;
  const bevelCurve =
    bevelObject?.type === 'CURVE' && bevelObject.data ? ctx.doc.getCurve(bevelObject.data) : null;
  const e = estimateCurveSurface(curve, { isText: o.type === 'FONT', forRender, bevelCurve });
  const glyphs = o.type === 'FONT' ? textGlyphCount(curve.body ?? '') * TEXT_BYTES_PER_CHARACTER : 0;
  const fixed = glyphs > e.bytes ? 0 : CURVE_FIXED_BYTES;
  e.bytes = Math.max(e.bytes, glyphs);
  return { ...e, fixed };
}

/** What an evaluation builds for one object (see {@link evaluatedGeometry}). */
interface EvaluatedGeometry {
  /** Size of the evaluated mesh (with `applyModifiers`, after the modifiers). */
  size: MeshSize;
  /** Decoded bytes of the meshes the evaluation builds for it (0: it shows its stored mesh). */
  decoded: number;
  /** Peak heap of building the largest of them (bytes). */
  peak: number;
  /**
   * The part of `peak` that is the young generation's garbage (a curve or text surface's
   * CURVE_FIXED_BYTES when it sets the peak, else 0): an operator that builds the geometry of many
   * objects counts it once (OPERATOR_FIXED_BYTES).
   */
  fixed: number;
  /** What to lower for that peak, completing "Lower …". */
  lower: string;
}

/**
 * Whether an evaluation runs modifier `m` of an object of `doc` (modifiers/registry.ts
 * evaluateModifierStack): enabled in the mode evaluated (render or viewport settings) and not
 * disabled by its type's rule (Blender's is_disabled: a Boolean whose object is not a mesh, an Array
 * whose cap is not one, a Curve modifier without a curve …), which reads the types of the objects
 * it names.
 */
export function modifierRuns(doc: SceneDoc, m: ModifierData, forRender: boolean): boolean {
  if (!isModifierEnabled(m, { forRender, editMode: false })) return false;
  return !modifierDisabledReason(m, { forRender, objectType: (id) => doc.getObject(id)?.type ?? null });
}

/**
 * The geometry an evaluation gives object `o` (render or viewport settings), estimated from stored
 * counts like a server evaluation: a mesh and its enabled modifiers (each estimated, eval/memory.ts),
 * a curve or text surface (or the wire of a curve without one) and its modifiers. Null for objects
 * without geometry. Without `applyModifiers` the size is the one before the modifiers (what exports
 * with apply_modifiers false write), though the evaluation still builds them.
 */
function evaluatedGeometry(
  ctx: OperatorContext,
  o: ObjectData,
  forRender: boolean,
  applyModifiers = true,
): EvaluatedGeometry | null {
  let size: MeshSize;
  let peak = 0;
  let fixed = 0;
  let lower = '';
  let built = false;
  if (o.type === 'MESH' && o.data) {
    const c = ctx.doc.meshCounts(o.data);
    if (!c) return null;
    size = c;
  } else if (o.type === 'CURVE' || o.type === 'FONT') {
    const c = curveSurface(ctx, o, forRender);
    if (!c) return null;
    // a curve without a surface feeds its wire (one vertex per sample) to its modifiers
    size = c.result.vertices ? c.result : { faces: 0, corners: 0, vertices: c.samples };
    peak = c.bytes;
    fixed = c.fixed;
    lower = c.lower;
    built = true;
  } else return null;
  const base = size;
  let first = o.type === 'MESH';
  for (const m of o.modifiers) {
    if (!modifierRuns(ctx.doc, m, forRender)) continue;
    const e = estimateModifier(m, size, modifierContext(ctx.doc, o, m, first, forRender));
    first = false;
    if (e.failsByItself) break;
    if (e.bytes > peak) {
      peak = e.bytes;
      fixed = 0;
      lower = `${e.lower} of the modifiers`;
    }
    size = e.result;
    built = true;
  }
  return {
    size: applyModifiers ? size : base,
    decoded: built ? decodedMeshBytes({ ...size, uvs: true, colors: false }) : 0,
    peak,
    fixed,
    lower,
  };
}

/**
 * Decoded bytes of what a new evaluation of the whole scene keeps while the operator that ran it
 * works on (object.convert, the exports): the modifier results and the curve and text surfaces of
 * every object. A modifier or surface that does not fit when it is built is refused by the
 * evaluation itself (eval/memory.ts); this counts what the operator's own work comes on top of.
 */
function evaluationBytes(ctx: OperatorContext, forRender: boolean): number {
  let bytes = 0;
  for (const o of ctx.doc.listObjects()) bytes += evaluatedGeometry(ctx, o, forRender)?.decoded ?? 0;
  return bytes;
}

/**
 * The modifier stack of `o` up to and including modifier `upTo` (all when null), estimated from its
 * stored counts like a server evaluation (eval/memory.ts): the peak of its modifiers and the size of
 * its result. The modifiers that run are the ones the operator runs (modifierRuns, viewport
 * settings), and modifier `upTo` also when the viewport hides it: object.modifier_apply applies it
 * turned on, as Blender does. Null when a modifier of it fails by itself (over its own limit): the
 * operator then refuses the object without building anything (object.convert and
 * object.modifier_apply refuse stacks with errors).
 */
function stackEstimate(
  ctx: OperatorContext,
  o: ObjectData,
  upTo: number | null,
): { bytes: number; result: MeshSize; lower: string } | null {
  const c = o.data ? ctx.doc.meshCounts(o.data) : null;
  if (!c) return null;
  let size: MeshSize = c;
  let peak = 0;
  let lower = '';
  const mods = o.modifiers.slice(0, upTo === null ? undefined : upTo + 1);
  let first = true;
  for (const [i, m] of mods.entries()) {
    if (!modifierRuns(ctx.doc, i === upTo ? { ...m, show_viewport: true } : m, false)) continue;
    const e = estimateModifier(m, size, modifierContext(ctx.doc, o, m, first, false));
    first = false;
    if (e.failsByItself) return null;
    if (e.bytes > peak) {
      peak = e.bytes;
      lower = e.lower;
    }
    size = e.result;
  }
  return { bytes: peak, result: size, lower };
}

/**
 * object.modifier_apply: a new evaluation of the whole scene (evaluationBytes: it evaluates the scene
 * for the objects its modifiers name), the stack's peak up to the modifier, a copy of its result and
 * the stored result. object.convert to MESH: a new evaluation of the whole scene, then for every
 * selected object it bakes (a mesh with modifiers, a curve or a text; linked duplicates each, every
 * one gets a mesh of its own) the peak of building its geometry, a copy of it and the stored copy; the
 * young generation's garbage of building curve and text surfaces once (OPERATOR_FIXED_BYTES), not
 * once per surface: converting 300 texts peaked at 27.7 MB and was estimated at 9,729 MB with it
 * counted for each.
 */
function bakeStack(which: 'convert' | 'apply'): Estimator {
  return (ctx, p) => {
    // text to 2D curves (target CURVE) builds no mesh
    if (which === 'convert' && p.target === 'CURVE') return null;
    const objects =
      which === 'apply'
        ? [
            ctx.doc.resolveObject(String(p.object ?? '')) ??
              (ctx.state.activeId ? ctx.doc.getObject(ctx.state.activeId) : null),
          ]
        : ctx.state.selectedIds.map((id) => ctx.doc.getObject(id));
    let bytes = 0;
    let faces = 0;
    let added = 0;
    let lower = '';
    // Convert gives a curve or text a new mesh, and with keep_original every converted object a copy
    const fresh: NewObjects = { objects: 0, datablocks: { meshes: 0 } };
    for (const o of objects) {
      if (!o) continue;
      let peak: number;
      let result: MeshSize;
      let what: string;
      if (which === 'apply') {
        if (o.type !== 'MESH' || !o.modifiers.length) continue;
        const ref = String(p.modifier ?? '');
        const i = o.modifiers.findIndex((m) => m.id === ref || m.name === ref);
        if (i < 0) continue;
        const s = stackEstimate(ctx, o, i);
        if (!s) continue;
        peak = s.bytes;
        result = s.result;
        what = s.lower ? `${s.lower} of the modifiers` : '';
      } else {
        if (o.type === 'MESH' && !o.modifiers.length) continue;
        if (o.type === 'MESH' && !stackEstimate(ctx, o, null)) continue;
        const g = evaluatedGeometry(ctx, o, false);
        if (!g) continue;
        peak = g.peak - g.fixed;
        result = g.size;
        what = g.lower;
        if (p.keep_original) {
          fresh.objects++;
          fresh.extraJson = (fresh.extraJson ?? 0) + extraJsonChars(o);
        }
        if (p.keep_original || o.type !== 'MESH') fresh.datablocks!.meshes!++;
      }
      const stored = decodedMeshBytes({ ...result, uvs: true, colors: false });
      bytes += peak + OBJECT_MESH_BYTES_PER_FACE * result.faces + stored;
      faces += result.faces;
      added += stored;
      lower ||= what;
    }
    if (!bytes) return null;
    return withObjects(
      {
        // both evaluate the whole scene first (the objects a Boolean or a Curve modifier names)
        bytes: OPERATOR_FIXED_BYTES + bytes + evaluationBytes(ctx, false),
        faces,
        addedStoredBytes: added,
        lower:
          lower ||
          (which === 'apply' ? 'the faces of the mesh' : 'the number or size of the converted meshes'),
      },
      fresh,
    );
  };
}

/**
 * object.generate_*: the faces it builds, counted from its parameters (operators/memory-generators.ts)
 * or the measured maximum of a small generator; never more than a generator builds
 * (MAX_GENERATED_FACES).
 */
function generator(kind: string): Estimator {
  return (_ctx, p) => {
    const faces = Math.min(
      MAX_GENERATED_FACES,
      generatorFaces(kind, p) ?? GENERATOR_MAX_FACES[kind] ?? MAX_GENERATED_FACES,
    );
    const stored = decodedFaces(faces);
    return withObjects(
      {
        bytes: OPERATOR_FIXED_BYTES + GENERATOR_BYTES_PER_FACE * faces + stored,
        faces,
        addedStoredBytes: stored,
        lower: GENERATOR_LOWER[kind] ?? 'the parameters that set its size or detail',
      },
      { objects: 1, datablocks: { meshes: 1 } },
    );
  };
}

/** Triangles of a binary STL of `fileBytes` bytes that begins with `head` (null: not one). */
export function binaryStlTriangles(head: Uint8Array, fileBytes: number): number | null {
  if (head.byteLength < 84) return null;
  const n = new DataView(head.buffer, head.byteOffset, 84).getUint32(80, true);
  return 84 + 50 * n === fileBytes ? n : null;
}

/**
 * What to lower for a smaller import, by what takes most of its memory (the meshes of a glTF file
 * with more than one mesh, which may share accessors; the objects of a glTF or OBJ file that makes
 * more than one, in the words of its format; the size of other files).
 */
const IMPORT_LOWER = {
  size: 'the size of the file (import fewer or simpler meshes)',
  meshes:
    'the meshes of the file (every glTF mesh is decoded into a mesh of its own, also where meshes share the same accessors)',
  objects: 'the nodes (objects) of the file',
  objBlocks: 'the objects of the file (its o and g lines)',
  keyframes: 'the animation keyframes of the file',
  images: 'the images embedded in the file (fewer or smaller textures)',
};

/** An import counted from its file (io/import-size.ts): the meshes it decodes, its objects, keyframes and JSON. */
function countedImport(s: ImportSize): OperatorEstimate {
  const meshes =
    IMPORT_BYTES_PER_DECODED_BYTE * s.decodedBytes +
    IMPORT_BYTES_PER_CORNER_OF_LARGEST_MESH * s.largestCorners +
    IMPORT_BYTES_PER_MORPH_VERTEX * s.morphVertices;
  const keyframes = IMPORT_BYTES_PER_KEYFRAME * s.keyframes;
  const images =
    IMPORT_BYTES_PER_IMAGE_BYTE * s.imageBytes +
    IMPORT_BYTES_PER_UNUSED_IMAGE_BYTE * Math.max(0, s.fileImageBytes - s.imageBytes);
  const objects = newObjectsBytes({ objects: s.objects }).peak;
  const lower =
    images > meshes && images > keyframes && images > objects
      ? IMPORT_LOWER.images
      : s.objects > 1 && objects > meshes && objects > keyframes
        ? IMPORT_LOWER.objects
        : keyframes > meshes
          ? IMPORT_LOWER.keyframes
          : s.jsonChars && s.meshes > 1
            ? IMPORT_LOWER.meshes
            : IMPORT_LOWER.size;
  return withObjects(
    {
      bytes: OPERATOR_FIXED_BYTES + meshes + keyframes + images + IMPORT_BYTES_PER_JSON_CHAR * s.jsonChars,
      faces: s.faces,
      meshes: s.meshes,
      // the meshes as the project counts them afterwards (every stored mesh with a UV layer), and
      // the images it keeps
      addedStoredBytes:
        s.storedBytes +
        SHAPE_KEY_STORED_BYTES_PER_VERTEX * s.morphVertices +
        KEYFRAME_STORED_BYTES * s.keyframes +
        s.imageBytes,
      // a save copies the images, and the positions of the morph targets' shape keys
      addedSaveBytes:
        saveBytes(KEYFRAME_STORED_BYTES * s.keyframes) +
        SAVE_BYTES_PER_IMAGE_BYTE * s.imageBytes +
        SAVE_BYTES_PER_LAYER_BYTE * SHAPE_KEY_BYTES_PER_VERTEX * s.morphVertices,
      lower,
    },
    {
      objects: s.objects,
      datablocks: { meshes: s.meshes, materials: s.materials, cameras: s.cameras, lights: s.lights },
    },
  )!;
}

/**
 * Importing `file` in `format` (stl, obj, ply, gltf or glb): a glTF file (GLB or .gltf) by what its
 * JSON says the importer decodes (every glTF mesh a node uses, its objects, morph targets and
 * keyframes: io/import-size.ts), a PLY file by the counts its header declares, a binary STL by the
 * triangles its header declares, an OBJ file and an ASCII STL by their size and (OBJ) their `o` and
 * `g` lines; each with the objects and datablocks it adds.
 */
export function importEstimate(format: string, file: ImportReader): OperatorEstimate {
  const lower = IMPORT_LOWER.size;
  // the peak by the file's size; the meshes kept as counted (`counted`) or by the size too
  const bySize = (objects: number, counted?: { faces: number; stored: number }) =>
    withObjects(
      {
        bytes: OPERATOR_FIXED_BYTES + IMPORT_BYTES_PER_FILE_BYTE * file.byteLength,
        faces: counted?.faces ?? 0,
        addedStoredBytes: counted ? counted.stored : IMPORT_STORED_BYTES_PER_FILE_BYTE * file.byteLength,
        lower,
      },
      { objects, datablocks: { meshes: objects } },
      lower,
    )!;
  if (format === 'stl') {
    const s = stlImportSize(file);
    // the mesh as the project counts it afterwards: welded, with a UV layer
    const stored = decodedMeshBytes({
      vertices: s.vertices,
      faces: s.faces,
      corners: s.corners,
      uvs: true,
      colors: false,
    });
    const tris = s.triangles;
    if (tris === null) return bySize(1, { faces: s.faces, stored });
    return withObjects(
      {
        // the triangles read and welded, and the mesh decoded before welding
        bytes:
          OPERATOR_FIXED_BYTES +
          IMPORT_BYTES_PER_STL_TRIANGLE * tris +
          decodedMeshBytes({ vertices: 3 * tris, faces: tris, corners: 3 * tris, uvs: false, colors: false }),
        faces: tris,
        addedStoredBytes: stored,
        lower,
      },
      { objects: 1, datablocks: { meshes: 1 } },
    )!;
  }
  if (format === 'obj') {
    const s = objImportSize(file);
    // the meshes as the project counts them afterwards (with a UV layer)
    const e = bySize(s.objects, {
      faces: s.faces,
      stored: decodedMeshBytes({
        vertices: s.vertices,
        faces: s.faces,
        corners: s.corners,
        uvs: true,
        colors: false,
      }),
    });
    return s.objects > 1 &&
      newObjectsBytes({ objects: s.objects }).peak > IMPORT_BYTES_PER_FILE_BYTE * file.byteLength
      ? { ...e, lower: IMPORT_LOWER.objBlocks }
      : e;
  }
  let size: ImportSize | null = null;
  if (format === 'ply') size = plyImportSize(file);
  else if (format === 'gltf' || format === 'glb') {
    const json = readGltfJson(file);
    if (json) size = gltfImportSize(json.json, json.chars);
  }
  // a file that is not what it claims: the import fails by itself, after reading at most its size
  return size ? countedImport(size) : bySize(1);
}

/**
 * A file given in base64 (a data URI too, whitespace around it ignored) as an {@link ImportReader}:
 * its size from the number of characters, and ranges of it decoded when they are read (the whole
 * file at once when there is whitespace, or a character base64 does not have, inside it).
 */
export function base64Reader(b64: string): ImportReader {
  let start = 0;
  while (start < b64.length && b64.charCodeAt(start) <= 32) start++;
  if (b64.startsWith('data:', start)) start = b64.indexOf(',', start) + 1;
  let end = b64.length;
  while (end > start && b64.charCodeAt(end - 1) <= 32) end--;
  let padding = 0;
  while (padding < 2 && end - padding > start && b64[end - 1 - padding] === '=') padding++;
  const decode = (s: string): Uint8Array => {
    try {
      return base64Decode(s);
    } catch {
      return new Uint8Array(0);
    }
  };
  // whitespace or other characters base64 does not have inside (the decoder skips them), or
  // padding before the end: the offsets of the characters are not those of the bytes
  if (/[^A-Za-z0-9+/_-]/.test(b64.slice(start, end - padding)))
    return bytesReader(decode(b64.slice(start, end)));
  const byteLength = Math.max(0, Math.floor(((end - start) * 3) / 4) - padding);
  return {
    byteLength,
    read(from, to) {
      const e = Math.min(to, byteLength);
      if (e <= from) return new Uint8Array(0);
      const q = Math.floor(from / 3);
      const bytes = decode(b64.slice(start + 4 * q, Math.min(end, start + 4 * Math.ceil(e / 3))));
      return bytes.subarray(from - 3 * q, e - 3 * q);
    },
  };
}

/** import_*: the file given in base64 ({@link importEstimate}). */
const importOperator =
  (format: string): Estimator =>
  (_ctx, p) => {
    const file = base64Reader(String(p.data_base64 ?? ''));
    if (format === 'gltf' && isGLB(file.read(0, 4))) return importEstimate('glb', file);
    return importEstimate(format, file);
  };

/**
 * export_*: the faces the file holds: the objects shown in renders (or the selected ones), their
 * modifiers applied when apply_modifiers is on (render settings), curves and text by their surfaces,
 * and the particle and collection instances these objects generate, each written as a mesh of its
 * own (operators/memory-instances.ts); on top of what the export's new evaluation of the whole scene
 * keeps (evaluationBytes).
 */
function exportFile(format: (p: Record<string, unknown>) => keyof typeof EXPORT_BYTES_PER_FACE): Estimator {
  return (ctx, p) => {
    const apply = p.apply_modifiers !== false;
    const picked = (
      p.use_selection
        ? ctx.state.selectedIds.map((id) => ctx.doc.getObject(id))
        : ctx.doc.listObjects().filter((o) => !o.hide_render)
    ).filter((o): o is ObjectData => !!o);
    const memo = new Map<string, number>();
    const facesOfObject = (o: ObjectData): number => {
      let f = memo.get(o.id);
      if (f === undefined) memo.set(o.id, (f = evaluatedGeometry(ctx, o, true, apply)?.size.faces ?? 0));
      return f;
    };
    let faces = 0;
    for (const o of picked) faces += facesOfObject(o);
    const instances = instanceBound(ctx.doc, picked, { forRender: true, facesOf: facesOfObject });
    faces += instances.faces;
    if (!faces) return null;
    return {
      bytes:
        OPERATOR_FIXED_BYTES +
        evaluationBytes(ctx, true) +
        EXPORT_BYTES_PER_FACE[format(p)] * faces +
        EXPORT_BYTES_PER_INSTANCE * instances.instances,
      faces,
      addedStoredBytes: 0,
      lower: instances.instances
        ? 'the faces of the exported meshes and instances (export fewer objects with use_selection, lower the counts of particle systems, or use the export_scene tool, which builds the file in a render process)'
        : 'the faces of the exported meshes (export fewer objects with use_selection, or use the export_scene tool, which builds the file in a render process)',
    };
  };
}

/**
 * object.array_place and object.scatter_on_surface: a new object for every copy (array_place: every
 * object copied for every item; scatter_on_surface: `count` copies, each of one source, the one with
 * the largest data and JSON counted), each with the modifiers and settings of its source. With linked
 * false every copy also gets its own datablocks: copied meshes share the encoded data of their sources
 * (copied without decoding it, at most MAX_COPY_BYTES of it per run), so the run takes little heap for
 * them, but the project then holds every copy as a mesh of its own: their decoded size counts; copied
 * curves, lights, cameras and armatures keep their JSON (a curve's splines), counted per character
 * (memory-objects.ts datablockExtraJsonChars). Linked copies share their data.
 */
function layout(kind: 'array' | 'scatter'): Estimator {
  return (ctx, p) => {
    const refs = Array.isArray(p.objects) ? p.objects.map(String) : null;
    const surface =
      kind === 'scatter' ? ctx.doc.resolveObject(String(p.surface ?? ctx.state.activeId ?? '')) : null;
    const sources = (refs ?? ctx.state.selectedIds)
      .map((r) => ctx.doc.resolveObject(r))
      .filter((o): o is ObjectData => !!o && o.id !== surface?.id);
    if (!sources.length) return null;
    const copies = Math.max(
      0,
      kind === 'array'
        ? (p.pattern === 'GRID' ? num(p.columns, 3) * num(p.rows, 3) : num(p.count, 5)) - 1
        : num(p.count, 20),
    );
    if (!copies) return null;
    const linked = p.linked !== false;
    // per item: every source (array_place), one of them (scatter_on_surface: the largest)
    let meshes = 0;
    let extraJson = 0;
    const datablocks: Partial<Record<CountedKind, number>> = {};
    const shared = new Set<string>();
    for (const o of sources) {
      const json = extraJsonChars(o);
      const bytes = o.type === 'MESH' ? meshBytes(ctx.doc, o.data) : 0;
      const dataKind = o.data && !linked ? dataKindOf(o.type) : null;
      // the JSON of a copied curve, light, camera or armature beyond what its constants cover
      const dataJson = dataKind ? datablockExtraJsonChars(ctx.doc, dataKind, o.data!) : 0;
      if (kind === 'scatter') {
        meshes = Math.max(meshes, bytes);
        extraJson = Math.max(extraJson, json + dataJson);
        if (dataKind) datablocks[dataKind] = copies;
        continue;
      }
      extraJson += json;
      // objects of the group sharing data share its copy too (like Blender's Shift+D)
      if (!o.data || shared.has(o.data)) continue;
      shared.add(o.data);
      meshes += bytes;
      extraJson += dataJson;
      if (dataKind) datablocks[dataKind] = (datablocks[dataKind] ?? 0) + copies;
    }
    const added = linked ? 0 : meshes * copies;
    const lower =
      kind === 'array' && p.pattern === 'GRID'
        ? `columns and rows${added ? ' (or pass linked: true)' : ''}`
        : `count${added ? ' (or pass linked: true)' : ''}`;
    return withObjects(
      added ? { bytes: OPERATOR_FIXED_BYTES, faces: 0, addedStoredBytes: added, lower } : null,
      {
        objects: kind === 'array' ? copies * sources.length : copies,
        datablocks,
        extraJson: copies * extraJson,
      },
      lower,
    );
  };
}

/** The type F-curves and drivers name an object's data by (object.ts duplicate, anim.ts copyAnimation). */
const ANIMATION_DATA_TYPE: Partial<Record<ObjectData['type'], string>> = {
  MESH: 'mesh',
  CURVE: 'curve',
  FONT: 'curve',
  LIGHT: 'light',
  CAMERA: 'camera',
  ARMATURE: 'armature',
};

/**
 * object.duplicate: a copy of every selected object (each linked duplicate too, with its modifiers
 * and settings) and, with linked false, of every datablock they use, once each as object.ts copies
 * shared data once: the meshes decoded, copied and stored (objectMeshes), the curves, lights,
 * cameras and armatures with their JSON (memory-objects.ts datablockExtraJsonChars); and the
 * animation the copies get (anim.ts copyAnimation: the F-curves, keyframes and drivers of every
 * duplicated object and copied datablock, memory-keyframes.ts copiedAnimationWrites). What to lower
 * names what takes most of it: the selected objects, the meshes copied or the animation.
 */
const duplicate: Estimator = (ctx, p) => {
  const selected = ctx.state.selectedIds
    .map((id) => ctx.doc.getObject(id))
    .filter((o): o is ObjectData => !!o);
  if (!selected.length) return null;
  const datablocks: Partial<Record<CountedKind, number>> = {};
  const seen = new Set<string>();
  const animated: string[] = [];
  let extraJson = 0;
  for (const o of selected) {
    extraJson += extraJsonChars(o);
    animated.push(`object:${o.id}`);
    const kind = p.linked ? null : dataKindOf(o.type);
    if (!kind || !o.data || seen.has(o.data)) continue;
    seen.add(o.data);
    datablocks[kind] = (datablocks[kind] ?? 0) + 1;
    extraJson += datablockExtraJsonChars(ctx.doc, kind, o.data);
    if (ANIMATION_DATA_TYPE[o.type]) animated.push(`${ANIMATION_DATA_TYPE[o.type]}:${o.data}`);
  }
  const added: NewObjects = { objects: selected.length, datablocks, extraJson };
  const meshes = p.linked
    ? null
    : objectMeshes('the number or size of the duplicated meshes (or pass linked: true)', { copies: true })(
        ctx,
        p,
      );
  const anim = copiedAnimationWrites(ctx.doc, animated);
  const objectsPeak = newObjectsBytes(added).peak;
  const meshesPeak = meshes ? meshes.bytes - OPERATOR_FIXED_BYTES : 0;
  const animPeak = anim?.bytes ?? 0;
  const lower =
    meshes && meshesPeak >= objectsPeak && meshesPeak >= animPeak
      ? meshes.lower
      : anim && animPeak > objectsPeak
        ? anim.lower
        : 'the number of selected objects';
  const e = withObjects(meshes, added, lower)!;
  return {
    ...e,
    bytes: e.bytes + animPeak,
    addedStoredBytes: (e.addedStoredBytes ?? 0) + (anim?.stored ?? 0),
    addedSaveBytes: (e.addedSaveBytes ?? 0) + (anim?.save ?? 0),
    ...(anim ? { keyframes: anim.keys } : {}),
    lower,
  };
};

/** Most objects object.duplicates_make_real makes per run (operators/instancing.ts MAX_MAKE_REAL). */
export const MAKE_REAL_MAX_OBJECTS = 10_000;

/**
 * The objects instancers `owners` take their instances from, one level down: the members of the
 * collections they instance (empties, particle systems) and the objects of their particle systems.
 */
function instanceSources(doc: SceneDoc, owners: readonly ObjectData[]): ObjectData[] {
  const collections = new Set<string>();
  const objects = new Set<string>();
  for (const o of owners) {
    if (o.instance_type === 'COLLECTION' && o.instance_collection) collections.add(o.instance_collection);
    for (const ps of Array.isArray(o.particle_systems) ? o.particle_systems : []) {
      const s = (ps?.settings ?? {}) as { instance_object?: unknown; instance_collection?: unknown };
      if (typeof s.instance_object === 'string') objects.add(s.instance_object);
      if (typeof s.instance_collection === 'string') collections.add(s.instance_collection);
    }
  }
  const byName = new Map(doc.listCollections().map((c) => [c.name, c.id]));
  const ids = new Set([...collections].map((c) => byName.get(c) ?? c));
  return doc.listObjects().filter((o) => objects.has(o.id) || objects.has(o.name) || ids.has(o.collection));
}

/**
 * object.duplicates_make_real: an object for every particle and collection instance of the
 * instancers (at most MAKE_REAL_MAX_OBJECTS, beyond which it refuses), each a linked duplicate of
 * its source with the source's modifiers: counted as the evaluation counts instances
 * (memory-instances.ts), the larger of render and viewport settings, each at the JSON of the
 * largest source.
 */
const makeReal: Estimator = (ctx, p) => {
  const refs = Array.isArray(p.objects) ? p.objects.map(String) : ctx.state.selectedIds;
  const owners = refs.map((r) => ctx.doc.resolveObject(r)).filter((o): o is ObjectData => !!o);
  if (!owners.length) return null;
  const count = (forRender: boolean) =>
    instanceBound(ctx.doc, owners, { forRender, facesOf: () => 0 }).instances;
  const objects = Math.min(MAKE_REAL_MAX_OBJECTS, Math.max(count(true), count(false)));
  if (!objects) return null;
  let extraJson = 0;
  for (const o of instanceSources(ctx.doc, owners)) extraJson = Math.max(extraJson, extraJsonChars(o));
  return withObjects(
    null,
    { objects, extraJson: objects * extraJson },
    'the particle count of the emitters (or the objects of the instanced collections)',
  );
};

/** What to lower for a Separate that makes too many objects, by type. */
const SEPARATE_LOWER: Readonly<Record<string, string>> = {
  LOOSE:
    'the number of loose parts (separate some of them with type SELECTED first, then separate that object by loose parts)',
  MATERIAL: 'the number of material indices the faces use',
};

/**
 * mesh.separate: the Edit Mode cost of the edited mesh (edit), and a new object with a mesh of its
 * own for every part: the selection (SELECTED), every material index its faces use but the first
 * (MATERIAL), every connected part but the first (LOOSE, counted on the mesh with a union-find in
 * typed arrays, memory-objects.ts looseParts); each copies the edited object (its modifiers).
 */
const separate: Estimator = (ctx, p) => {
  const base = edit('mesh.separate')(ctx, p);
  const g = editGeometry(ctx);
  const o = ctx.state.activeId ? ctx.doc.getObject(ctx.state.activeId) : null;
  if (!base || !g || !o) return base;
  let parts = 1;
  if (p.type === 'LOOSE' || p.type === 'MATERIAL') {
    const mesh = ctx.doc.getMesh(g.meshId);
    if (mesh) parts = Math.max(0, (p.type === 'LOOSE' ? looseParts(mesh) : materialParts(mesh)) - 1);
  }
  const e = withObjects(base, {
    objects: parts,
    datablocks: { meshes: parts },
    extraJson: parts * extraJsonChars(o),
  });
  return e && { ...e, lower: SEPARATE_LOWER[String(p.type)] ?? base.lower };
};

/**
 * object.scatter_add: no mesh copied (the evaluation counts the instances), but of several `objects`
 * each one whose collection another object instances gets a hidden linked duplicate in the new
 * sources collection (operators/instancing.ts): at most one object per given object.
 */
const scatterAdd: Estimator = (ctx, p) => {
  const sources = (Array.isArray(p.objects) ? p.objects : [])
    .map((r) => ctx.doc.resolveObject(String(r)))
    .filter((o): o is ObjectData => !!o);
  if (sources.length < 2) return null;
  let extraJson = 0;
  for (const o of sources) extraJson += extraJsonChars(o);
  return withObjects(null, { objects: sources.length, extraJson }, 'the number of objects to scatter');
};

/** anim.turntable: an empty as the pivot and, without a given camera, a camera. */
const turntable: Estimator = (_ctx, p) =>
  withObjects(null, { objects: p.camera ? 1 : 2, datablocks: p.camera ? {} : { cameras: 1 } });

/**
 * curve.add_from_points and the curve primitives: a curve object and its curve datablock, whose
 * spline points it keeps as JSON in the document (`points`: their JSON characters count like an
 * object's).
 */
const curveObject: Estimator = (_ctx, p) =>
  withObjects(
    null,
    {
      objects: 1,
      datablocks: { curves: 1 },
      extraJson: Array.isArray(p.points) ? JSON.stringify(p.points).length : 0,
    },
    'the number of spline points',
  );

/** object.add_mesh_from_data: the given vertices and faces. */
const meshFromData: Estimator = (_ctx, p) => {
  const verts = Array.isArray(p.vertices) ? p.vertices.length : 0;
  const faces = Array.isArray(p.faces) ? p.faces.length : 0;
  let corners = 0;
  if (Array.isArray(p.faces)) for (const f of p.faces) corners += Array.isArray(f) ? f.length : 0;
  const built = decodedMeshBytes({ vertices: verts, faces, corners, uvs: !!p.uvs, colors: false });
  return withObjects(
    {
      bytes: OPERATOR_FIXED_BYTES + OBJECT_MESH_BYTES_PER_FACE * faces + built,
      faces,
      // as the project counts the mesh afterwards (with a UV layer)
      addedStoredBytes: decodedMeshBytes({ vertices: verts, faces, corners, uvs: true, colors: false }),
      lower: 'the number of vertices and faces',
    },
    { objects: 1, datablocks: { meshes: 1 } },
  );
};

/**
 * object.join: copies of the meshes of the selected objects (linked duplicates each, as object.ts
 * joins them) appended into the active one, whose mesh then holds them all: the meshes only the
 * joined objects used go with them.
 */
const join: Estimator = (ctx) => {
  const objects = selectedMeshObjects(ctx);
  const active = ctx.state.activeId ? ctx.doc.getObject(ctx.state.activeId) : null;
  if (active?.type === 'MESH' && active.data && !objects.some((o) => o.id === active.id))
    objects.push(active);
  if (objects.length < 2) return null;
  let decoded = 0;
  const result: MeshLayout = { vertices: 0, faces: 0, corners: 0, uvs: true, colors: false };
  for (const o of objects) {
    const c = ctx.doc.meshCounts(o.data!);
    if (!c) continue;
    result.vertices += c.vertices;
    result.faces += c.faces;
    result.corners += c.corners;
    decoded += meshBytes(ctx.doc, o.data);
  }
  const users = dataUsers(ctx.doc);
  let freed = 0;
  for (const [meshId, k] of meshPicks(objects))
    if (k >= (users.get(meshId) ?? 0)) freed += meshBytes(ctx.doc, meshId);
  return {
    bytes: OPERATOR_FIXED_BYTES + OBJECT_MESH_BYTES_PER_FACE * result.faces + 2 * decoded,
    faces: result.faces,
    addedStoredBytes: Math.max(0, decodedMeshBytes(result) - freed),
    lower: 'the number or size of the joined meshes',
  };
};

/** Entering Edit Mode on mesh `meshId`: every element of the mesh is selected. */
function editModeEstimate(doc: SceneDoc, meshId: string): OperatorEstimate {
  const faces = doc.meshCounts(meshId)?.faces ?? 0;
  return {
    bytes: OPERATOR_FIXED_BYTES + EDIT_BYTES_PER_FACE_BY_OPERATOR['object.mode_set'] * faces,
    faces,
    addedStoredBytes: 0,
    lower: 'the number of faces of the mesh',
  };
}

/** object.mode_set into Edit Mode. */
const modeSet: Estimator = (ctx, p) => {
  if (p.mode !== 'EDIT' || ctx.state.mode === 'EDIT') return null;
  const o = ctx.state.activeId ? ctx.doc.getObject(ctx.state.activeId) : null;
  if (!o || o.type !== 'MESH' || !o.data) return null;
  return editModeEstimate(ctx.doc, o.data);
};

/**
 * An operator that writes keyframes (memory-keyframes.ts); null when it fails by itself. The rigid body
 * frames a bake simulates count with what the project keeps (its cache holds them), not saved.
 */
function keyframeEstimate(w: KeyframeWrites | null): OperatorEstimate | null {
  if (!w) return null;
  const simulation = w.simulation ?? 0;
  return {
    bytes: OPERATOR_FIXED_BYTES + w.bytes,
    faces: 0,
    addedStoredBytes: w.stored + simulation,
    addedSaveBytes: w.save,
    keyframes: w.keys,
    ...(simulation > 0 ? { simulationBytes: simulation } : {}),
    lower: w.lower,
  };
}

/**
 * The objects `refs` names (ids or names, each once; unknown ones left out: the operator reports
 * them itself), or the selected objects without any.
 */
function refObjects(ctx: OperatorContext, refs: unknown): ObjectData[] {
  const list = Array.isArray(refs) && refs.length ? refs.map(String) : ctx.state.selectedIds;
  const seen = new Set<string>();
  const out: ObjectData[] = [];
  for (const r of list) {
    const o = ctx.doc.getObject(r) ?? ctx.doc.resolveObject(r);
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
  }
  return out;
}

/** anim.bake_transforms (memory-keyframes.ts bakeTransformsWrites). */
const bakeTransforms: Estimator = (ctx, p) => {
  const scene = ctx.doc.getScene();
  return keyframeEstimate(
    bakeTransformsWrites(
      ctx.doc,
      refObjects(ctx, p.objects).map((o) => o.id),
      {
        start: num(p.frame_start, scene.frame_start),
        end: num(p.frame_end, scene.frame_end),
        step: num(p.step, 1),
        channels: Array.isArray(p.channels)
          ? p.channels.map(String)
          : ['location', 'rotation_euler', 'scale'],
        clearParents: p.clear_parents === true,
      },
    ),
  );
};

/** rigidbody.bake_to_keyframes (memory-keyframes.ts rigidBodyBakeWrites); the range defaults to the world's. */
const rigidBodyBake: Estimator = (ctx, p) => {
  const world = sanitizeRigidBodyWorld(ctx.doc.getScene().rigidbody_world);
  return keyframeEstimate(
    rigidBodyBakeWrites(ctx.doc, refObjects(ctx, p.objects), {
      start: num(p.frame_start, world.frame_start),
      end: num(p.frame_end, world.frame_end),
      step: num(p.step, 1),
    }),
  );
};

/**
 * anim.keyframes_insert_many: the keyframes given, on the channel of an object (the F-curve it may
 * already have is rewritten); other datablocks' channels count as new F-curves.
 */
const insertMany: Estimator = (ctx, p) => {
  const keys = Array.isArray(p.frames) ? p.frames.length : 0;
  if (!keys) return null;
  const target =
    (p.target_type ?? 'object') !== 'object'
      ? null
      : p.target !== undefined
        ? ctx.doc.resolveObject(String(p.target))
        : ctx.state.activeId
          ? ctx.doc.getObject(ctx.state.activeId)
          : null;
  const ref = target
    ? {
        target_type: 'object' as const,
        target_id: target.id,
        path: String(p.path ?? ''),
        index: num(p.index, 0),
      }
    : null;
  return keyframeEstimate(insertManyWrites(ctx.doc, ref, keys, p.replace === true));
};

/** anim.keyframe_insert: a keyframe per channel of the keying set on every selected object. */
const keyframeInsert: Estimator = (ctx, p) => {
  const objects = refObjects(ctx, null);
  return objects.length
    ? keyframeEstimate(keyframeInsertWrites(ctx.doc, objects, String(p.type ?? 'LocRotScale')))
    : null;
};

/**
 * An operator that writes vertex groups or shape keys (memory-layers.ts), with the decoded size of the
 * meshes it reads; null when it writes none.
 */
function layerEstimate(ctx: OperatorContext, w: LayerWrites | null): OperatorEstimate | null {
  if (!w) return null;
  let decoded = 0;
  if (w.decodes) for (const id of w.meshes) decoded += meshBytes(ctx.doc, id);
  return {
    bytes: OPERATOR_FIXED_BYTES + w.bytes + decoded,
    faces: 0,
    addedStoredBytes: w.stored,
    addedSaveBytes: w.save,
    layers: { kind: w.kind, bytes: w.written },
    lower: w.lower,
  };
}

/** The mesh object operator `p.object` names, or the active object (null: none, or not a mesh). */
function meshTargetOf(ctx: OperatorContext, p: Record<string, unknown>): string | null {
  const o =
    p.object !== undefined
      ? ctx.doc.resolveObject(String(p.object))
      : ctx.state.activeId
        ? ctx.doc.getObject(ctx.state.activeId)
        : null;
  return o?.type === 'MESH' && o.data && ctx.doc.meshCounts(o.data) ? o.data : null;
}

/** object.parent_set: the selected objects parented to the active one (memory-layers.ts armatureParentWrites). */
const parentSet: Estimator = (ctx, p) =>
  layerEstimate(
    ctx,
    armatureParentWrites(ctx.doc, ctx.state.selectedIds, ctx.state.activeId, String(p.type ?? 'OBJECT')),
  );

/** object.parent_to: `objects` (or the selection) parented to `parent` (memory-layers.ts armatureParentWrites). */
const parentTo: Estimator = (ctx, p) => {
  const parent = typeof p.parent === 'string' ? ctx.doc.resolveObject(p.parent) : null;
  return layerEstimate(
    ctx,
    armatureParentWrites(
      ctx.doc,
      refObjects(ctx, p.objects).map((o) => o.id),
      parent?.id,
      String(p.type ?? 'OBJECT'),
    ),
  );
};

/** An object.vertex_group_* operator (memory-layers.ts vertexGroupWrites). */
function vertexGroupOperator(change: (p: Record<string, unknown>) => VertexGroupChange): Estimator {
  return (ctx, p) => {
    const mesh = meshTargetOf(ctx, p);
    return mesh ? layerEstimate(ctx, vertexGroupWrites(ctx.doc, mesh, change(p))) : null;
  };
}

/** An object.shape_key_* operator (memory-layers.ts shapeKeyWrites). */
function shapeKeyOperator(change: (p: Record<string, unknown>) => ShapeKeyChange): Estimator {
  return (ctx, p) => {
    const mesh = meshTargetOf(ctx, p);
    return mesh ? layerEstimate(ctx, shapeKeyWrites(ctx.doc, mesh, change(p))) : null;
  };
}

/**
 * armature.bone_update renaming a bone (`name`): the vertex groups of the meshes the armature deforms
 * follow it (memory-layers.ts boneRenameWrites); other changes of a bone are a few hundred bytes.
 */
const boneUpdate: Estimator = (ctx, p) => {
  if (typeof p.name !== 'string' || typeof p.bone !== 'string' || p.name === p.bone) return null;
  const o =
    p.object !== undefined
      ? ctx.doc.resolveObject(String(p.object))
      : ctx.state.activeId
        ? ctx.doc.getObject(ctx.state.activeId)
        : null;
  return o ? layerEstimate(ctx, boneRenameWrites(ctx.doc, o, p.bone)) : null;
};

// ---------------------------------------------------------------- the table

const LOWER = {
  cuts: 'number_cuts, or select fewer faces',
  segments: 'segments, or select fewer edges',
  steps: 'steps, or select fewer elements',
};

const editIds = [
  'mesh.delete',
  'mesh.dissolve_verts',
  'mesh.dissolve_edges',
  'mesh.dissolve_faces',
  'mesh.merge',
  'mesh.remove_doubles',
  'mesh.edge_face_add',
  'mesh.split',
  'mesh.flip_normals',
  'mesh.normals_make_consistent',
  'mesh.vertices_smooth',
  'mesh.mark_seam',
  'mesh.mark_sharp',
  'mesh.tris_convert_to_quads',
  'mesh.extrude_vertices_move',
  'transform.edge_crease',
  'transform.translate',
  'transform.rotate',
  'transform.resize',
  'uv.cube_project',
  'uv.cylinder_project',
  'uv.sphere_project',
  'uv.smart_project',
  'uv.unwrap',
  'uv.reset',
  'mesh.select_all',
  'mesh.select_mode',
  'mesh.select_elements',
  'mesh.select_linked',
  'mesh.select_more',
  'mesh.select_less',
  'mesh.loop_select',
  'mesh.edgering_select',
  'mesh.select_non_manifold',
  'mesh.select_loose',
  'mesh.select_random',
  'mesh.select_by_normal',
  'sculpt.brush_stroke',
  'paint.vertex_color_stroke',
  'paint.vertex_color_set',
  'paint.vertex_color_set_data',
];

/** Estimators by operator id. */
export const OPERATOR_ESTIMATES: Readonly<Record<string, Estimator>> = {
  ...Object.fromEntries(editIds.map((id) => [id, edit(id)])),
  'mesh.subdivide': edit(
    'mesh.subdivide',
    (g, p) => {
      const c = num(p.number_cuts, 1);
      // fully selected faces become (c+1)² faces (n-gons more); faces next to cut edges are split
      const extraEdges = Math.max(0, g.selEdges - g.selFaces * g.m);
      return g.faces + g.selFaces * ((c + 1) ** 2 - 1) * Math.max(1, g.m / 4) + 2 * extraEdges * c;
    },
    LOWER.cuts,
  ),
  'mesh.loopcut': edit(
    'mesh.loopcut',
    (g, p, ctx) => {
      const edge = Array.isArray(p.edge) ? (p.edge as number[]) : [];
      const mesh = ctx.doc.getMesh(g.meshId);
      const ring = mesh ? edgeRingFaces(mesh.faces, g.vertices, edge[0], edge[1]) : null;
      return g.faces + (ring ?? g.faces) * num(p.number_cuts, 1);
    },
    'number_cuts',
  ),
  'mesh.bevel': edit(
    'mesh.bevel',
    (g, p) => {
      const s = num(p.segments, 1);
      const corners = g.selVerts * (s + 1) ** 2;
      return g.faces + (p.affect === 'VERTICES' ? corners : g.selEdges * s + corners);
    },
    LOWER.segments,
  ),
  'mesh.spin': edit(
    'mesh.spin',
    (g, p) => {
      const steps = num(p.steps, 12);
      return p.dupli ? g.faces + g.selFaces * steps : g.faces + g.selFaces + steps * outline(g);
    },
    LOWER.steps,
    (g, p) => SPIN_BYTES_PER_COPY * num(p.steps, 12) * g.selVerts,
  ),
  'mesh.bridge_edge_loops': edit(
    'mesh.bridge_edge_loops',
    (g, p) => g.faces + (g.selEdges / 2) * (num(p.number_cuts, 0) + 1),
    'number_cuts, or bridge shorter loops',
  ),
  'mesh.extrude_region_move': edit('mesh.extrude_region_move', (g) => g.faces + outline(g)),
  'mesh.extrude_region_shrink_fatten': edit('mesh.extrude_region_shrink_fatten', (g) => g.faces + outline(g)),
  'mesh.extrude_faces_move': edit('mesh.extrude_faces_move', (g) => g.faces + g.selFaces * g.m),
  'mesh.extrude_edges_move': edit('mesh.extrude_edges_move', (g) => g.faces + g.selEdges),
  'mesh.inset': edit('mesh.inset', (g, p) => g.faces + (p.use_individual ? g.selFaces * g.m : outline(g))),
  'mesh.poke': edit('mesh.poke', (g) => g.faces + g.selFaces * (g.m - 1)),
  'mesh.quads_convert_to_tris': edit(
    'mesh.quads_convert_to_tris',
    (g) => g.faces + g.selFaces * Math.max(0, g.m - 3),
  ),
  'mesh.duplicate_move': edit('mesh.duplicate_move', (g) => g.faces + g.selFaces),
  'mesh.solidify': edit('mesh.solidify', (g) => g.faces + g.selFaces + outline(g)),
  'mesh.symmetrize': edit('mesh.symmetrize', (g) => 2 * g.faces),
  'mesh.fill': edit('mesh.fill', (g) => g.faces + g.selEdges),
  // a cube or a plane is a few faces: nothing of it to lower
  'mesh.primitive_cube_add': primitive('CUBE', ''),
  'mesh.primitive_plane_add': primitive('PLANE', ''),
  'mesh.primitive_grid_add': primitive('GRID', 'x_subdivisions and y_subdivisions'),
  'mesh.primitive_circle_add': primitive('CIRCLE', 'vertices'),
  'mesh.primitive_uv_sphere_add': primitive('UV_SPHERE', 'segments and ring_count'),
  'mesh.primitive_ico_sphere_add': primitive('ICO_SPHERE', 'subdivisions'),
  'mesh.primitive_cylinder_add': primitive('CYLINDER', 'vertices'),
  'mesh.primitive_cone_add': primitive('CONE', 'vertices'),
  'mesh.primitive_torus_add': primitive('TORUS', 'major_segments and minor_segments'),
  'object.add_mesh_from_data': meshFromData,
  'anim.bake_transforms': bakeTransforms,
  'rigidbody.bake_to_keyframes': rigidBodyBake,
  'anim.keyframes_insert_many': insertMany,
  'anim.keyframe_insert': keyframeInsert,
  'object.parent_set': parentSet,
  'object.parent_to': parentTo,
  'armature.bone_update': boneUpdate,
  'object.vertex_group_add': vertexGroupOperator(() => ({ op: 'add' })),
  'object.vertex_group_assign': vertexGroupOperator((p) => ({ op: 'ensure', group: String(p.group) })),
  'object.vertex_group_set_weights': vertexGroupOperator((p) => ({ op: 'ensure', group: String(p.group) })),
  'object.vertex_group_remove': vertexGroupOperator(() => ({ op: 'rewrite' })),
  'object.vertex_group_remove_from': vertexGroupOperator(() => ({ op: 'rewrite' })),
  'object.vertex_group_normalize': vertexGroupOperator(() => ({ op: 'rewrite' })),
  'object.vertex_group_normalize_all': vertexGroupOperator(() => ({ op: 'rewrite' })),
  'object.vertex_group_rename': vertexGroupOperator(() => ({ op: 'rewrite' })),
  'object.shape_key_add': shapeKeyOperator(() => ({ op: 'add' })),
  'object.shape_key_remove': shapeKeyOperator((p) => ({
    op: 'rewrite',
    decodes: p.all === true && p.apply_mix === true,
  })),
  'object.shape_key_set': shapeKeyOperator(() => ({ op: 'rewrite', decodes: false })),
  'object.shape_key_set_positions': shapeKeyOperator(() => ({ op: 'rewrite', decodes: true })),
  'object.shape_key_clear': shapeKeyOperator(() => ({ op: 'rewrite', decodes: false })),
  'object.duplicate': duplicate,
  'object.duplicates_make_real': makeReal,
  'mesh.separate': separate,
  'anim.turntable': turntable,
  'curve.add_from_points': curveObject,
  ...Object.fromEntries(
    ['bezier_circle', 'bezier_curve', 'nurbs_circle', 'nurbs_curve', 'nurbs_path', 'poly'].map((k) => [
      `curve.primitive_${k}_add`,
      curveObject,
    ]),
  ),
  'object.empty_add': oneObject(null),
  'object.camera_add': oneObject('cameras'),
  'object.light_add': oneObject('lights'),
  'object.armature_add': oneObject('armatures'),
  'object.text_add': oneObject('curves', 'the length of the text'),
  'object.collection_instance_add': oneObject(null),
  'material.new': (_ctx) => withObjects(null, { objects: 0, datablocks: { materials: 1 } }),
  'object.join': join,
  'object.convert': bakeStack('convert'),
  'object.modifier_apply': bakeStack('apply'),
  'object.transform_apply': objectMeshes('the number or size of the selected meshes', { singleUser: true }),
  'object.origin_set': objectMeshes('the number or size of the selected meshes', { singleUser: true }),
  'object.array_place': layout('array'),
  'object.scatter_on_surface': layout('scatter'),
  'object.scatter_add': scatterAdd,
  'object.shade_smooth': objectMeshes('the number or size of the selected meshes'),
  'object.shade_flat': objectMeshes('the number or size of the selected meshes'),
  'object.shade_auto_smooth': objectMeshes('the number or size of the selected meshes'),
  'object.mode_set': modeSet,
  'export_scene.gltf': exportFile((p) => (p.export_format === 'GLTF_EMBEDDED' ? 'gltf' : 'glb')),
  'export_scene.obj': exportFile(() => 'obj'),
  'export_mesh.stl': exportFile(() => 'stl'),
  'export_mesh.ply': exportFile(() => 'ply'),
  'import_scene.gltf': importOperator('gltf'),
  'import_scene.obj': importOperator('obj'),
  'import_mesh.stl': importOperator('stl'),
  'import_mesh.ply': importOperator('ply'),
  ...Object.fromEntries(
    [
      'arch',
      'barrel',
      'blob',
      'building',
      'bush',
      'chair',
      'cloud',
      'column',
      'fence',
      'flower',
      'gear',
      'grass_tuft',
      'pipe',
      'rock',
      'shelf',
      'spring',
      'stairs',
      'table',
      'terrain',
      'tree',
      'wheel',
    ].map((k) => [`object.generate_${k}`, generator(k)]),
  ),
};

/** Operators sharing one reason (see {@link UNESTIMATED_OPERATORS}). */
const because = (reason: string, ids: readonly string[]) => ids.map((match) => ({ match, reason }));

/**
 * Operators without an estimate, by id, and why they cannot add much to what the project keeps or
 * take much heap beyond it: they read the document, change the editor's state, change settings of
 * the datablocks they name, remove what they name, rewrite F-curves the project keeps, store values
 * given in the request, or build what is checked elsewhere (evaluations: eval/memory.ts; the rigid
 * body simulation: physics/memory.ts). A test checks that every operator is estimated or listed
 * here, and that every parameter of these that counts something is in
 * {@link BOUNDED_GROWTH_PARAMETERS}.
 */
export const UNESTIMATED_OPERATORS: readonly { match: string; reason: string }[] = [
  ...because('reads the document or the evaluated scene, changes nothing', [
    'anim.driver_list',
    'anim.fmodifier_type_list',
    'armature.describe',
    'constraint.describe',
    'constraint.type_list',
    'material.preset_list',
    'scene.measure',
    'scene.raycast',
    'scene.stats',
  ]),
  ...because(
    'builds the bodies of the rigid body world and their collision shapes to describe them, steps no frame',
    ['rigidbody.describe'],
  ),
  ...because('the editor state (frame, selection, 3D cursor): nothing stored', [
    'scene.frame_set',
    'screen.frame_jump',
    'object.select',
    'object.select_all',
    'object.select_by_type',
    'object.select_pattern',
    'view3d.cursor_set',
    'view3d.snap_cursor_to_active',
    'view3d.snap_cursor_to_center',
    'view3d.snap_cursor_to_selected',
  ]),
  ...because(
    'settings of the datablocks, objects or bones it names: a few hundred bytes each, counted with them',
    [
      'anim.driver_update',
      'anim.fmodifier_add',
      'anim.fmodifier_update',
      'armature.bone_add',
      'armature.properties_set',
      'camera.properties_set',
      'collection.create',
      'constraint.childof_clear_inverse',
      'constraint.childof_set_inverse',
      'constraint.limitdistance_reset',
      'constraint.move_to_index',
      'constraint.update',
      'curve.cyclic_toggle',
      'curve.handle_type_set',
      'curve.switch_direction',
      'data.set_property',
      'light.properties_set',
      'material.preset_apply',
      'material.procedural_set',
      'material.update',
      'object.constraint_add',
      'object.hide_view_clear',
      'object.hide_view_set',
      'object.instance_collection_set',
      'object.material_assign',
      'object.material_slot_add',
      'object.material_slot_assign',
      'object.move_to_collection',
      'object.parent_clear',
      'object.rename',
      'object.track_set',
      'pose.constraint_add',
      'pose.constraint_set',
      'pose.ik_add',
      'pose.ik_settings_set',
      'rigidbody.object_add',
      'rigidbody.object_settings_set',
      'world.mist_set',
      'world.sky_set',
    ],
  ),
  ...because(
    'one driver per channel of the property (at most four), each with at most 64 variables: a few kilobytes',
    ['anim.driver_add'],
  ),
  ...because(
    'the modifier stack: the evaluation checks every modifier before it is built (eval/memory.ts; modifier_apply is estimated)',
    [
      'object.modifier_add',
      'object.modifier_copy',
      'object.modifier_move_down',
      'object.modifier_move_to_index',
      'object.modifier_move_up',
      'object.modifier_set',
    ],
  ),
  ...because(
    'particle settings: the evaluation makes their instances, at most 200,000 per scene, and counts them',
    ['object.particle_system_add', 'object.particle_system_update'],
  ),
  ...because(
    "curve settings and text: the evaluation checks every curve's or text's surface before it is built (eval/memory.ts)",
    ['curve.properties_set', 'font.text_set'],
  ),
  ...because(
    'spline points given in the request, kept as they are (the project counts curves by their JSON)',
    ['curve.spline_add', 'curve.spline_set_points'],
  ),
  ...because('a bone per point given in the request (the project counts armatures by their JSON)', [
    'armature.chain_add',
  ]),
  ...because(
    "rigid body world settings: the server checks a simulation's frames before it steps them (physics/memory.ts)",
    ['rigidbody.world_set'],
  ),
  ...because('removes what it names', [
    'anim.driver_remove',
    'anim.fmodifier_remove',
    'anim.keyframe_clear',
    'armature.bone_remove',
    'collection.delete',
    'constraint.delete',
    'curve.spline_remove',
    'material.delete',
    'object.constraints_clear',
    'object.delete',
    'object.material_slot_remove',
    'object.modifier_remove',
    'object.particle_system_remove',
    'pose.constraint_remove',
    'rigidbody.cache_free',
    'rigidbody.object_remove',
  ]),
  ...because(
    'rewrites F-curves the project keeps, or adds at most four keyframes to one: at the peak about KEYFRAME_REWRITE_BYTES (180) per keyframe of the curves it rewrites, less than half of what the limit per project counts per keyframe with its save (480)',
    [
      'anim.extrapolation_set',
      'anim.interpolation_type',
      'anim.keyframe_delete',
      'anim.keyframe_insert_property',
      'anim.keyframes_move',
      'anim.keyframes_remove',
      'constraint.followpath_path_animate',
      'curve.keyframe_insert',
      'pose.bone_transform_set',
      'pose.transforms_clear',
    ],
  ),
  ...because(
    'object transforms (with auto keying, a keyframe on each of the 9 transform channels of every moved object, else on each animated channel whose value changes; their F-curves rewritten as above)',
    [
      'constraint.apply',
      'object.align',
      'object.dimensions_set',
      'object.distribute',
      'object.location_clear',
      'object.look_at',
      'object.randomize_transform',
      'object.rotation_clear',
      'object.scale_clear',
      'object.transform_set',
      'object.visual_transform_apply',
      'view3d.snap_selected_to_cursor',
      'view3d.snap_selected_to_grid',
    ],
  ),
  ...because(
    'object transforms from rays cast at evaluated meshes (their evaluations are checked by eval/memory.ts)',
    ['object.drop_to_ground', 'object.snap_to_surface'],
  ),
  ...because('refused through MCP tools in favour of render_image and render_animation', [
    'render.render_animation',
    'render.render_software',
  ]),
];

/**
 * Parameters of the operators in {@link UNESTIMATED_OPERATORS} whose names say they count something
 * (frames, objects, points, counts, resolutions …), by `<operator id>.<parameter path>`, and why
 * what they count stays small or is checked elsewhere. A test checks that every such parameter of an
 * operator without an estimate is listed here: an operator whose output grows with a parameter needs
 * an estimate (OPERATOR_ESTIMATES) or a reason here.
 */
export const BOUNDED_GROWTH_PARAMETERS: Readonly<Record<string, string>> = (() => {
  const frame =
    'one frame, at which the scene is evaluated (its modifiers and rigid body simulation are checked when they are built and stepped)';
  const objects = 'the objects it changes: a few hundred bytes each at most, counted with the objects';
  const keys =
    'keyframes of F-curves the project keeps, moved or removed (rewritten: see UNESTIMATED_OPERATORS)';
  const given = 'values given in the request, kept as they are';
  const curve = "the curve's surface is checked when it is evaluated (eval/memory.ts)";
  const particles = 'instances the evaluation makes and counts: at most 200,000 per scene';
  const render = 'refused through MCP tools in favour of render_image and render_animation';
  const out: Record<string, string> = {
    'anim.driver_add.variables': 'at most 64 variables of a few hundred bytes each',
    'anim.driver_update.variables': 'at most 64 variables of a few hundred bytes each',
    'anim.keyframes_move.keys': keys,
    'anim.keyframes_move.keys.frame': keys,
    'anim.keyframes_remove.keys': keys,
    'anim.keyframes_remove.keys.frame': keys,
    'armature.bone_add.length': "a bone's length, not a count",
    'armature.bone_remove.bones': 'bones it removes',
    'armature.chain_add.points': given,
    'armature.chain_add.names': given,
    'camera.properties_set.sensor_width': 'a camera setting, not a count',
    'constraint.followpath_path_animate.frame_start': 'two keyframes whatever the frames',
    'constraint.followpath_path_animate.length': 'two keyframes whatever the length',
    'curve.handle_type_set.points': 'points of a spline the project keeps, changed in place',
    'curve.properties_set.resolution_u': curve,
    'curve.properties_set.render_resolution_u': curve,
    'curve.properties_set.bevel_resolution': curve,
    'curve.spline_add.points': given,
    'curve.spline_add.resolution_u': curve,
    'curve.spline_set_points.points': given,
    'curve.spline_set_points.resolution_u': curve,
    'object.particle_system_add.settings.count': particles,
    'object.particle_system_add.settings.grid_resolution': particles,
    'object.particle_system_add.settings.instance_weights': given,
    'object.particle_system_update.settings.count': particles,
    'object.particle_system_update.settings.grid_resolution': particles,
    'object.particle_system_update.settings.instance_weights': given,
    'pose.ik_add.chain_count': 'one constraint, whatever the length of its chain',
    'pose.ik_add.iterations': "the solver's iterations take time, not memory",
    'pose.transforms_clear.bones': 'bones it clears',
    'rigidbody.world_set.frame_start':
      "the simulation's frames are checked before the server steps them (physics/memory.ts)",
    'rigidbody.world_set.frame_end':
      "the simulation's frames are checked before the server steps them (physics/memory.ts)",
    'rigidbody.world_set.substeps_per_frame':
      'substeps take time, not memory (a frame keeps one pose per body)',
    'rigidbody.world_set.solver_iterations': "the solver's iterations take time, not memory",
  };
  for (const id of ['anim.driver_list', 'armature.describe', 'camera.properties_set', 'constraint.describe'])
    out[`${id}.frame`] = frame;
  for (const id of [
    'anim.keyframe_delete',
    'anim.keyframe_insert_property',
    'curve.keyframe_insert',
    'light.properties_set',
    'pose.bone_transform_set',
    'pose.constraint_set',
    'rigidbody.describe',
    'scene.frame_set',
    'scene.measure',
    'scene.raycast',
    'scene.stats',
  ])
    out[`${id}.frame`] = frame;
  for (const id of [
    'anim.extrapolation_set',
    'camera.properties_set',
    'light.properties_set',
    'material.preset_apply',
    'object.align',
    'object.constraints_clear',
    'object.delete',
    'object.dimensions_set',
    'object.distribute',
    'object.drop_to_ground',
    'object.look_at',
    'object.material_assign',
    'object.randomize_transform',
    'object.select',
    'object.snap_to_surface',
    'object.track_set',
    'object.transform_set',
    'object.visual_transform_apply',
    'rigidbody.describe',
    'rigidbody.object_add',
    'rigidbody.object_remove',
    'rigidbody.object_settings_set',
    'scene.measure',
    'scene.raycast',
  ])
    out[`${id}.objects`] = objects;
  for (const param of ['frame_start', 'frame_end', 'frame_step', 'width', 'height', 'samples'])
    out[`render.render_animation.${param}`] = render;
  for (const param of ['width', 'height', 'samples', 'frame'])
    out[`render.render_software.${param}`] = render;
  return out;
})();

/** Why operator `id` has no estimate (null when it has one or is not listed). */
export function unestimatedReason(id: string): string | null {
  if (OPERATOR_ESTIMATES[id]) return null;
  return UNESTIMATED_OPERATORS.find((u) => u.match === id)?.reason ?? null;
}

/** The memory estimate of running operator `id` with `params` (schema defaults filled in) now. */
export function estimateOperator(id: string, ctx: OperatorContext, params: unknown): OperatorEstimate | null {
  const est = OPERATOR_ESTIMATES[id];
  if (!est) return null;
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  return est(ctx, p);
}

let installed: OperatorMemoryCheck | null = null;

/** Installs the check every operator runs before it (null removes it). Returns the one installed before. */
export function setOperatorMemoryCheck(check: OperatorMemoryCheck | null): OperatorMemoryCheck | null {
  const before = installed;
  installed = check;
  return before;
}

/** The installed check, if any. */
export function operatorMemoryCheck(): OperatorMemoryCheck | null {
  return installed;
}

/**
 * Why Edit Mode is not entered on mesh `meshId` (null: enter it), as for object.mode_set: tools
 * such as MCP edit_mesh enter Edit Mode without the registry, and selecting every element of a mesh
 * of millions of faces takes hundreds of megabytes. Nothing to do without a check.
 */
export function editModeMemoryRefusal(ctx: OperatorContext, meshId: string): string | null {
  const check = installed;
  if (!check) return null;
  return check({ operator: 'object.mode_set', estimate: editModeEstimate(ctx.doc, meshId), storedBytes: 0 });
}

/** The import operator of each file format (the operator id a refused import names). */
const IMPORT_OPERATORS: Readonly<Record<string, string>> = {
  stl: 'import_mesh.stl',
  ply: 'import_mesh.ply',
  obj: 'import_scene.obj',
  gltf: 'import_scene.gltf',
  glb: 'import_scene.gltf',
};

/**
 * Why importing file `data` in `format` is not run (null: import it): the import's estimate
 * ({@link importEstimate}) asked from the installed check like the import_* operators, for tools
 * such as MCP import_model that import without the registry. Nothing to do without a check.
 */
export function importMemoryRefusal(doc: SceneDoc, format: string, data: Uint8Array): string | null {
  const check = installed;
  if (!check) return null;
  const estimate = importEstimate(format, bytesReader(data));
  const project = projectObjects(doc);
  return check({
    operator: IMPORT_OPERATORS[format] ?? 'import',
    estimate,
    storedBytes: storedMeshBytes(doc) + project.bytes,
    saveBytes: project.save,
    objects: project.objects,
    doc,
  });
}

/** Vertices, edges and faces selected in Edit Mode, or 'all' (every element of the mesh). */
export type EditSelectionSizes = { verts: number; edges: number; faces: number } | 'all';

/**
 * Why Edit Mode operator `id` (mesh.*, transform.*, uv.*) would be refused on the mesh of object
 * `objectId` (null: it may run), asked before Edit Mode is entered and `selection` is selected:
 * selecting the elements of a mesh of millions of faces takes seconds, and MCP tools (edit_mesh, a
 * run_operator or batch `selection` with mode EDIT) do that before the registry checks the
 * operator. The estimate comes from the mesh's stored counts and the selection's sizes with no
 * edges counted: no estimate shrinks with more selected edges, so it is at most what the registry
 * asks with the real selection, and what this refuses would be refused after that work. `params`
 * with their defaults (OperatorRegistry.parseParams). Nothing to do without a check.
 */
export function editOperatorMemoryRefusal(
  ctx: OperatorContext,
  id: string,
  params: unknown,
  objectId: string,
  selection: EditSelectionSizes,
): string | null {
  if (!installed || !OPERATOR_ESTIMATES[id] || !/^(mesh|transform|uv)\./.test(id)) return null;
  const o = ctx.doc.getObject(objectId);
  const c = o?.type === 'MESH' && o.data ? ctx.doc.meshCounts(o.data) : null;
  if (!c) return null;
  const state = { ...ctx.state, mode: 'EDIT' as const, activeId: objectId, selectedIds: [objectId] };
  assumedSelection =
    selection === 'all' ? { verts: c.vertices, edges: 0, faces: c.faces } : { ...selection, edges: 0 };
  try {
    return operatorMemoryRefusal(id, { ...ctx, state }, params);
  } finally {
    assumedSelection = null;
  }
}

/**
 * Why operator `id` is not run with `params` (null: run it). Asks the installed check with the
 * operator's estimate; nothing to do without a check or an estimate.
 */
export function operatorMemoryRefusal(id: string, ctx: OperatorContext, params: unknown): string | null {
  const check = installed;
  if (!check) return null;
  let estimate: OperatorEstimate | null;
  try {
    estimate = estimateOperator(id, ctx, params);
  } catch (err) {
    // an estimate that reads a stored mesh the host would not decode (Separate counts the parts of
    // the edited mesh): the operator could not read it either
    if (isMeshMemoryError(err)) return err.message;
    throw err;
  }
  if (!estimate || estimate.bytes <= 0) return null;
  // what the project keeps is counted only for operators that add to it
  if (!(estimate.addedStoredBytes > 0))
    return check({ operator: id, estimate, storedBytes: 0, doc: ctx.doc });
  const project = projectObjects(ctx.doc);
  return check({
    operator: id,
    estimate,
    storedBytes: storedMeshBytes(ctx.doc) + project.bytes,
    saveBytes: project.save,
    objects: project.objects,
    doc: ctx.doc,
  });
}
