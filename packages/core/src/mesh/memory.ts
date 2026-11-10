/*
 * The JavaScript heap of meshes in their decoded form, and the check a host can run before a stored
 * mesh is decoded.
 *
 * Meshes are stored as binary blobs (codec.ts, outside the JavaScript heap) and decoded into
 * MeshData, whose JavaScript arrays take the heap: SceneDoc keeps every mesh it decoded for as long
 * as its blob is in the document, so an open project holds its meshes decoded once something read
 * them (a scene summary, an operator, an export). The server reads projects in its own process, next
 * to every editor connection and agent session, and V8 ends that whole process when its heap runs
 * out (a fatal error, not an exception). The server therefore installs a check
 * (`setMeshMemoryCheck`): `decodeMesh` then asks it before it builds the arrays, and a refused mesh
 * throws a {@link MeshMemoryError}, which the callers report (a scene summary lists the mesh's stored
 * counts instead, an operator fails with code OUT_OF_MEMORY). Without a check (the browser, the
 * server's render processes) meshes decode as before.
 */

/** Counts of a mesh as its stored header gives them (see codec.ts). */
export interface MeshLayout {
  vertices: number;
  faces: number;
  /** Face corners: the sum of the faces' vertex counts. */
  corners: number;
  /** A UV layer (per face corner). */
  uvs: boolean;
  /** Vertex colors. */
  colors: boolean;
  /** Edges with attributes (seams, sharp edges, creases). */
  edgeAttrs?: number;
  /** Loose (wire) edges. */
  looseEdges?: number;
}

/**
 * Heap of a decoded mesh (bytes), by element: what `decodeMesh` allocates, measured with V8 on
 * x64 (no pointer compression, as Node.js runs) on grids, triangulated grids, spheres and meshes
 * with vertex colors, and the same to the byte for every one of them: a vertex is 3 doubles (24 B);
 * a face is an array of its vertex indices (a 32 B array object, a 16 B backing store header and 8 B
 * per corner) plus its slot in the face list, its material index and its smooth flag (8 B each);
 * a UV layer adds an array of 2 doubles per corner to every face (56 B + 16 B per corner); colors
 * are 4 doubles per vertex. Edge attributes are entries of an object keyed by strings (about 160 B
 * each, not measured exactly).
 */
export const DECODED_MESH_BYTES = {
  perVertex: 24,
  perFace: 72,
  perCorner: 8,
  uvPerFace: 56,
  uvPerCorner: 16,
  colorPerVertex: 32,
  perEdgeAttr: 160,
  perLooseEdge: 16,
} as const;

/** Heap a mesh of this layout takes decoded (bytes, see {@link DECODED_MESH_BYTES}). */
export function decodedMeshBytes(l: MeshLayout): number {
  const K = DECODED_MESH_BYTES;
  return (
    K.perVertex * l.vertices +
    K.perFace * l.faces +
    K.perCorner * l.corners +
    (l.uvs ? K.uvPerFace * l.faces + K.uvPerCorner * l.corners : 0) +
    (l.colors ? K.colorPerVertex * l.vertices : 0) +
    K.perEdgeAttr * (l.edgeAttrs ?? 0) +
    K.perLooseEdge * (l.looseEdges ?? 0)
  );
}

/**
 * A mesh structure the host's memory check refused to build (a stored mesh it would not decode).
 * `code` is the operator failure code it becomes (OUT_OF_MEMORY).
 */
export class MeshMemoryError extends Error {
  readonly code = 'OUT_OF_MEMORY' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MeshMemoryError';
  }
}

export function isMeshMemoryError(err: unknown): err is MeshMemoryError {
  return err instanceof MeshMemoryError;
}

/** What a {@link MeshMemoryCheck} is asked before a stored mesh is decoded. */
export interface MeshMemoryRequest {
  layout: MeshLayout;
  /** Heap the decoded mesh takes, and what decoding it allocates on the way (bytes). */
  bytes: number;
}

/** Returns null to decode the mesh, or why it is not decoded (a {@link MeshMemoryError} with that message). */
export type MeshMemoryCheck = (req: MeshMemoryRequest) => string | null;

let installed: MeshMemoryCheck | null = null;

/** Installs the check `decodeMesh` runs (null removes it). Returns the one installed before. */
export function setMeshMemoryCheck(check: MeshMemoryCheck | null): MeshMemoryCheck | null {
  const before = installed;
  installed = check;
  return before;
}

/** The installed check, if any. */
export function meshMemoryCheck(): MeshMemoryCheck | null {
  return installed;
}

/**
 * Asks the installed check before a mesh of `layout` is decoded; throws a {@link MeshMemoryError}
 * when it refuses. Nothing to do without a check.
 */
export function checkMeshDecode(layout: MeshLayout): void {
  const check = installed;
  if (!check) return;
  // what decodeMesh allocates besides the result: the face sizes (8 B per face)
  const bytes = decodedMeshBytes(layout) + 8 * layout.faces;
  const reason = check({ layout, bytes });
  if (reason) throw new MeshMemoryError(reason);
}
