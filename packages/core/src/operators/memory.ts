import type { ObjectData } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { decodedMeshBytes, type MeshLayout } from '../mesh/memory';
import { base64Decode } from '../util/json';
import {
  TEXT_BYTES_PER_CHARACTER,
  estimateCurveSurface,
  estimateModifier,
  textGlyphCount,
  type CurveSurfaceEstimate,
  type MeshSize,
} from '../eval/memory';
import { isModifierEnabled } from '../modifiers';
import { MAX_GENERATED_FACES } from '../generate/types';
import type { OperatorContext } from './context';
import { GENERATOR_LOWER, generatorFaces } from './memory-generators';
import { instanceBound } from './memory-instances';

export { GENERATOR_LOWER, ISOSURFACE_FACES_PER_CELL, generatorFaces } from './memory-generators';

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
 * instance they write (memory-instances.ts).
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
  /** Decoded bytes of the meshes it adds to the document (0 when it adds none). */
  addedStoredBytes: number;
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
   * Decoded bytes of all meshes of the document before the operator, from their stored counts
   * (counted when the operator adds geometry, else 0).
   */
  storedBytes: number;
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

/** Decoded bytes of every mesh of the document, from their stored counts. */
export function storedMeshBytes(doc: SceneDoc): number {
  let bytes = 0;
  for (const b of doc.listMeshBlocks()) bytes += decodedMeshBytes(storedLayout(doc, b.id) ?? EMPTY);
  return bytes;
}

const EMPTY: MeshLayout = { vertices: 0, faces: 0, corners: 0, uvs: false, colors: false };

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
    return {
      bytes: OPERATOR_FIXED_BYTES + PRIMITIVE_BYTES_PER_FACE * faces + stored,
      faces,
      addedStoredBytes: stored,
      lower,
    };
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
    return {
      bytes: OPERATOR_FIXED_BYTES + OBJECT_MESH_BYTES_PER_FACE * faces + decoded + added,
      faces,
      addedStoredBytes: added,
      lower,
    };
  };
}

/**
 * The surface curve or text object `o` gets in an evaluation (eval/memory.ts estimateCurveSurface;
 * text at least at the measured cost per character), or null without curve data.
 */
function curveSurface(ctx: OperatorContext, o: ObjectData, forRender: boolean): CurveSurfaceEstimate | null {
  const curve = o.data ? ctx.doc.getCurve(o.data) : null;
  if (!curve) return null;
  const bevelObject =
    curve.bevel_mode === 'OBJECT' && curve.bevel_object ? ctx.doc.getObject(curve.bevel_object) : null;
  const bevelCurve =
    bevelObject?.type === 'CURVE' && bevelObject.data ? ctx.doc.getCurve(bevelObject.data) : null;
  const e = estimateCurveSurface(curve, { isText: o.type === 'FONT', forRender, bevelCurve });
  if (o.type === 'FONT')
    e.bytes = Math.max(e.bytes, textGlyphCount(curve.body ?? '') * TEXT_BYTES_PER_CHARACTER);
  return e;
}

/** What an evaluation builds for one object (see {@link evaluatedGeometry}). */
interface EvaluatedGeometry {
  /** Size of the evaluated mesh (with `applyModifiers`, after the modifiers). */
  size: MeshSize;
  /** Decoded bytes of the meshes the evaluation builds for it (0: it shows its stored mesh). */
  decoded: number;
  /** Peak heap of building the largest of them (bytes). */
  peak: number;
  /** What to lower for that peak, completing "Lower …". */
  lower: string;
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
    lower = c.lower;
    built = true;
  } else return null;
  const base = size;
  for (const m of o.modifiers) {
    if (!isModifierEnabled(m, { forRender, editMode: false })) continue;
    const e = estimateModifier(m, size, { forRender });
    if (e.failsByItself) break;
    if (e.bytes > peak) {
      peak = e.bytes;
      lower = `${e.lower} of the modifiers`;
    }
    size = e.result;
    built = true;
  }
  return {
    size: applyModifiers ? size : base,
    decoded: built ? decodedMeshBytes({ ...size, uvs: true, colors: false }) : 0,
    peak,
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
 * its result. Null when a modifier of it fails by itself (over its own limit): the operator then
 * refuses the object without building anything (object.convert and object.modifier_apply refuse
 * stacks with errors).
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
  for (const m of mods) {
    if (!isModifierEnabled(m, { forRender: false, editMode: false })) continue;
    const e = estimateModifier(m, size, { forRender: false });
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
 * object.modifier_apply: the stack's peak up to the modifier, a copy of its result and the stored
 * result. object.convert to MESH: a new evaluation of the whole scene (evaluationBytes), then for every
 * selected object it bakes (a mesh with modifiers, a curve or a text; linked duplicates each, every
 * one gets a mesh of its own) the peak of building its geometry, a copy of it and the stored copy.
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
        peak = g.peak;
        result = g.size;
        what = g.lower;
      }
      const stored = decodedMeshBytes({ ...result, uvs: true, colors: false });
      bytes += peak + OBJECT_MESH_BYTES_PER_FACE * result.faces + stored;
      faces += result.faces;
      added += stored;
      lower ||= what;
    }
    if (!bytes) return null;
    return {
      bytes: OPERATOR_FIXED_BYTES + bytes + (which === 'convert' ? evaluationBytes(ctx, false) : 0),
      faces,
      addedStoredBytes: added,
      lower:
        lower || (which === 'apply' ? 'the faces of the mesh' : 'the number or size of the converted meshes'),
    };
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
    return {
      bytes: OPERATOR_FIXED_BYTES + GENERATOR_BYTES_PER_FACE * faces + stored,
      faces,
      addedStoredBytes: stored,
      lower: GENERATOR_LOWER[kind] ?? 'the parameters that set its size or detail',
    };
  };
}

/** Triangles of a binary STL of `fileBytes` bytes that begins with `head` (null: not one). */
export function binaryStlTriangles(head: Uint8Array, fileBytes: number): number | null {
  if (head.byteLength < 84) return null;
  const n = new DataView(head.buffer, head.byteOffset, 84).getUint32(80, true);
  return 84 + 50 * n === fileBytes ? n : null;
}

/**
 * Importing a file of `fileBytes` bytes in `format` (stl, obj, ply, gltf or glb) that begins with
 * `head` (its first 84 bytes, or fewer): a binary STL by the triangles its header declares, any
 * other file by its size.
 */
export function importEstimate(format: string, head: Uint8Array, fileBytes: number): OperatorEstimate {
  const lower = 'the size of the file (import fewer or simpler meshes)';
  const tris = format === 'stl' ? binaryStlTriangles(head, fileBytes) : null;
  if (tris !== null) {
    const stored = decodedMeshBytes({
      vertices: 3 * tris,
      faces: tris,
      corners: 3 * tris,
      uvs: false,
      colors: false,
    });
    return {
      bytes: OPERATOR_FIXED_BYTES + IMPORT_BYTES_PER_STL_TRIANGLE * tris + stored,
      faces: tris,
      addedStoredBytes: stored,
      lower,
    };
  }
  return {
    bytes: OPERATOR_FIXED_BYTES + IMPORT_BYTES_PER_FILE_BYTE * fileBytes,
    faces: 0,
    addedStoredBytes: IMPORT_STORED_BYTES_PER_FILE_BYTE * fileBytes,
    lower,
  };
}

/**
 * The size of a file given in base64 (3 bytes per 4 characters; a data URI too) and its first 84
 * bytes, without decoding the rest.
 */
function base64File(b64: string): { head: Uint8Array; fileBytes: number } {
  let start = 0;
  while (start < b64.length && b64.charCodeAt(start) <= 32) start++;
  if (b64.startsWith('data:', start)) start = b64.indexOf(',', start) + 1;
  let end = b64.length;
  while (end > start && b64.charCodeAt(end - 1) <= 32) end--;
  let padding = 0;
  while (padding < 2 && end - padding > start && b64[end - 1 - padding] === '=') padding++;
  let head: Uint8Array;
  try {
    head = base64Decode(b64.slice(start, start + 112));
  } catch {
    head = new Uint8Array(0);
  }
  return { head, fileBytes: Math.max(0, Math.floor(((end - start) * 3) / 4) - padding) };
}

/** import_*: the file given in base64 ({@link importEstimate}). */
const importOperator =
  (format: string): Estimator =>
  (_ctx, p) => {
    const { head, fileBytes } = base64File(String(p.data_base64 ?? ''));
    return importEstimate(format, head, fileBytes);
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
 * object.array_place and object.scatter_on_surface with linked false: the copies share the encoded
 * data of their sources (copied without decoding it, at most MAX_COPY_BYTES of it per run), so the run
 * takes little heap, but the project then holds every copy as a mesh of its own: the decoded size of
 * the copies is what counts (array_place: every object copied for every item; scatter_on_surface:
 * `count` copies of one source each, the largest counted). Linked copies share their data: nothing.
 */
function layoutCopies(kind: 'array' | 'scatter'): Estimator {
  return (ctx, p) => {
    if (p.linked !== false) return null;
    const refs = Array.isArray(p.objects) ? p.objects.map(String) : null;
    const surface =
      kind === 'scatter' ? ctx.doc.resolveObject(String(p.surface ?? ctx.state.activeId ?? '')) : null;
    const sources = (refs ?? ctx.state.selectedIds)
      .map((r) => ctx.doc.resolveObject(r))
      .filter((o): o is ObjectData => !!o && (refs !== null || o.id !== surface?.id));
    let per = 0;
    for (const o of sources)
      if (o.type === 'MESH')
        per = kind === 'array' ? per + meshBytes(ctx.doc, o.data) : Math.max(per, meshBytes(ctx.doc, o.data));
    const copies =
      kind === 'array'
        ? (p.pattern === 'GRID' ? num(p.columns, 3) * num(p.rows, 3) : num(p.count, 5)) - 1
        : num(p.count, 20);
    const added = per * Math.max(0, copies);
    if (!added) return null;
    return {
      bytes: OPERATOR_FIXED_BYTES,
      faces: 0,
      addedStoredBytes: added,
      lower:
        kind === 'array' && p.pattern === 'GRID'
          ? 'columns and rows (or pass linked: true)'
          : 'count (or pass linked: true)',
    };
  };
}

/** object.add_mesh_from_data: the given vertices and faces. */
const meshFromData: Estimator = (_ctx, p) => {
  const verts = Array.isArray(p.vertices) ? p.vertices.length : 0;
  const faces = Array.isArray(p.faces) ? p.faces.length : 0;
  let corners = 0;
  if (Array.isArray(p.faces)) for (const f of p.faces) corners += Array.isArray(f) ? f.length : 0;
  const stored = decodedMeshBytes({ vertices: verts, faces, corners, uvs: !!p.uvs, colors: false });
  return {
    bytes: OPERATOR_FIXED_BYTES + OBJECT_MESH_BYTES_PER_FACE * faces + stored,
    faces,
    addedStoredBytes: stored,
    lower: 'the number of vertices and faces',
  };
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
  'mesh.separate',
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
  'object.duplicate': (ctx, p) =>
    p.linked
      ? null
      : objectMeshes('the number or size of the duplicated meshes (or pass linked: true)', { copies: true })(
          ctx,
          p,
        ),
  'object.join': join,
  'object.convert': bakeStack('convert'),
  'object.modifier_apply': bakeStack('apply'),
  'object.transform_apply': objectMeshes('the number or size of the selected meshes', { singleUser: true }),
  'object.origin_set': objectMeshes('the number or size of the selected meshes', { singleUser: true }),
  'object.array_place': layoutCopies('array'),
  'object.scatter_on_surface': layoutCopies('scatter'),
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

/**
 * Operators without an estimate, by id prefix or id, and why they cannot grow the geometry much past
 * what they read: they change no mesh, change one in place at a cost the estimates of the Edit Mode
 * operators bound, or build what is bounded elsewhere.
 */
export const UNESTIMATED_OPERATORS: readonly { match: string; reason: string }[] = [
  { match: 'anim.', reason: 'keyframes, drivers and F-curve modifiers: no mesh' },
  { match: 'armature.', reason: 'bones: no mesh' },
  { match: 'pose.', reason: 'pose channels and bone constraints: no mesh' },
  { match: 'constraint.', reason: 'object constraints: no mesh' },
  { match: 'camera.', reason: 'camera data: no mesh' },
  { match: 'light.', reason: 'light data: no mesh' },
  { match: 'material.', reason: 'materials: no mesh' },
  { match: 'world.', reason: 'world settings: no mesh' },
  { match: 'collection.', reason: 'collections: no mesh' },
  { match: 'data.', reason: 'a property of a datablock: no mesh' },
  {
    match: 'rigidbody.',
    reason:
      'rigid body settings; the simulation runs in renders and evaluations, whose memory is checked there',
  },
  {
    match: 'scene.',
    reason: 'reads the evaluated scene (its modifier evaluations are checked by eval/memory.ts)',
  },
  { match: 'screen.', reason: 'the frame: no mesh' },
  { match: 'view3d.', reason: 'the 3D cursor or object transforms: no mesh' },
  {
    match: 'curve.',
    reason:
      'spline points: the evaluation builds the surface, and the server checks it per curve first (eval/memory.ts)',
  },
  {
    match: 'font.',
    reason:
      'text content: the evaluation builds its surface, and the server checks it per text first (eval/memory.ts)',
  },
  {
    match: 'object.text_add',
    reason:
      'a text object: the evaluation builds its surface, and the server checks it per text first (eval/memory.ts)',
  },
  {
    match: 'object.duplicates_make_real',
    reason:
      'linked duplicates of the instanced objects (their data is shared), at most MAX_MAKE_REAL objects per run',
  },
  { match: 'render.', reason: 'refused through MCP tools in favour of render_image and render_animation' },
  {
    match: 'object.modifier_',
    reason: 'the modifier stack (modifier_apply is estimated): evaluations are checked per modifier',
  },
  { match: 'object.constraint_', reason: 'object constraints: no mesh' },
  { match: 'object.constraints_', reason: 'object constraints: no mesh' },
  { match: 'object.vertex_group_', reason: 'vertex weights: one float per vertex' },
  { match: 'object.shape_key_', reason: 'shape keys: three floats per vertex and key' },
  { match: 'object.material_', reason: 'material slots: no mesh' },
  { match: 'object.particle_system_', reason: 'particle settings: instances are counted by the evaluation' },
  { match: 'object.select', reason: 'the object selection: no mesh' },
  { match: 'object.select_', reason: 'the object selection: no mesh' },
  { match: 'object.hide_view_', reason: 'visibility: no mesh' },
  { match: 'object.parent_', reason: 'parenting: no mesh' },
  ...[
    'object.align',
    'object.dimensions_set',
    'object.distribute',
    'object.location_clear',
    'object.look_at',
    'object.randomize_transform',
    'object.rotation_clear',
    'object.scale_clear',
    'object.track_set',
    'object.transform_set',
    'object.visual_transform_apply',
  ].map((match) => ({ match, reason: 'object transforms: no mesh' })),
  ...['object.drop_to_ground', 'object.snap_to_surface'].map((match) => ({
    match,
    reason: 'object transforms from rays cast at evaluated meshes (their evaluations are checked)',
  })),
  ...['object.armature_add', 'object.camera_add', 'object.empty_add', 'object.light_add'].map((match) => ({
    match,
    reason: 'a new object without a mesh',
  })),
  ...['object.collection_instance_add', 'object.instance_collection_set', 'object.scatter_add'].map(
    (match) => ({ match, reason: 'instances: no mesh copied (the evaluation counts them)' }),
  ),
  ...['object.delete', 'object.rename', 'object.move_to_collection'].map((match) => ({
    match,
    reason: 'names, links and deletions: no mesh built',
  })),
];

/** Why operator `id` has no estimate (null when it has one or is not classified). */
export function unestimatedReason(id: string): string | null {
  if (OPERATOR_ESTIMATES[id]) return null;
  return (
    UNESTIMATED_OPERATORS.find((u) =>
      u.match.endsWith('.') || u.match.endsWith('_') ? id.startsWith(u.match) : id === u.match,
    )?.reason ?? null
  );
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
  const estimate = importEstimate(format, data.subarray(0, 84), data.byteLength);
  return check({
    operator: IMPORT_OPERATORS[format] ?? 'import',
    estimate,
    storedBytes: storedMeshBytes(doc),
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
  const estimate = estimateOperator(id, ctx, params);
  if (!estimate || estimate.bytes <= 0) return null;
  // the document's meshes are counted only for operators that add geometry
  const storedBytes = estimate.addedStoredBytes > 0 ? storedMeshBytes(ctx.doc) : 0;
  return check({ operator: id, estimate, storedBytes });
}
