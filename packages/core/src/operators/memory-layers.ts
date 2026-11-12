import type { ObjectData } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import {
  SAVE_BYTES_PER_LAYER_BYTE,
  SHAPE_KEY_STORED_BYTES_PER_VERTEX,
  shapeKeyBytes,
  shapeKeyCount,
  vertexGroupBytes,
} from './memory-objects';

/*
 * The memory of operators that write the vertex groups or the shape keys of a mesh, for the
 * estimates of operators/memory.ts. The document keeps the weights of a mesh's vertex groups (a float
 * per vertex and group) and the positions of its shape keys (three floats per vertex and key) as
 * binary data, outside the JavaScript heap, and every group (or key) of the mesh as one value: a change
 * to one of them reads all of them (a copy), encodes and stores them again, and the server's process
 * copies the transaction's update twice more (Yjs encodes it for the document's update listeners, the
 * project's room copies it into the frame it sends to the editors). Parenting a mesh of a million
 * vertices to an armature of 150 deforming bones with ARMATURE_NAME writes 600 MB of weights, and took
 * a server past 3.8 GB of resident memory within 3.4 s, its JavaScript heap well below its limit.
 * Measured as resident memory in a process with the server's listeners on the document (an agent's
 * undo history and the room's copy of every update), the freed memory returned at once
 * (MALLOC_MMAP_THRESHOLD_=131072), garbage collected before each run:
 *
 * | run (grid of 251,001 vertices unless noted)                   | written (MiB) | peak (MiB)  | peak / written |
 * | ------------------------------------------------------------- | ------------- | ----------- | -------------- |
 * | object.parent_set ARMATURE_NAME, 100 bones                    | 96.7          | 502.6       | 5.20           |
 * | ARMATURE_ENVELOPE, 100 bones                                  | 96.7          | 501.9       | 5.19           |
 * | ARMATURE_ENVELOPE again over 100 groups                       | 96.7          | 484.4       | 5.01           |
 * | seven vertex group operators on 100 groups (1)                | 96.7          | 482.6–490.4 | 4.99–5.02      |
 * | ARMATURE_NAME on 90,601 vertices, 100 bones                   | 34.9          | 219.7       | 6.29           |
 * | ARMATURE_ENVELOPE on 90,601 vertices, 100 bones               | 34.9          | 189.3       | 5.42           |
 * | shape_key_set, _add, _remove (160,801 vertices, 32 keys)      | 58.9–62.6     | 296.7–313.0 | 5.00–5.04      |
 * | join of 3 × 10,201 vertices, 320 groups, 80 keys (2)          | 65.4          | 405.7–416.4 | 6.21–6.37      |
 * | transform_apply on 10,201 vertices, 160 groups, 40 keys (3)   | 15.6          | 96.5        | 6.20           |
 * | transform_apply on 40,401 vertices, 40 groups, 40 keys (3)    | 43.2          | 251.5–251.6 | 5.83           |
 *
 * (1) object.vertex_group_rename, _normalize_all, _assign, _normalize, _remove_from, _add and _remove.
 * (2) Eleven runs; the joined mesh (19.6 MiB at the peak of the same join without groups and keys)
 * included.
 * (3) Two runs each; Apply Scale of an object whose mesh a second object uses: the copy of the mesh
 * gets its groups and keys, then its keys are written again, scaled ({@link movedLayerWrites}).
 * The runs with 100 bones or 100 groups used the armature's first bone and a chain of 100 more: 101
 * deforming bones and 101 groups (101 × 4 bytes × 251,001 vertices = 96.7 MiB).
 *
 * ARMATURE_AUTO also solves the bone heat of every vertex: 79.8–611.2 MiB at the peak on meshes of
 * 10,201 to 491,401 vertices with 4 to 100 bones, up to 1,373 bytes per vertex beyond what the table's
 * ratio gives for its groups ({@link HEAT_WEIGHTS_BYTES_PER_VERTEX}).
 */

/** Bytes one vertex group keeps per vertex of its mesh (a float weight). */
export const VERTEX_GROUP_BYTES_PER_VERTEX = 4;

/** Bytes one shape key keeps per vertex of its mesh (three floats of its position). */
export const SHAPE_KEY_BYTES_PER_VERTEX = 12;

/**
 * Peak per byte of the vertex groups (or shape keys) a mesh holds while an operator writes them, its
 * vertex groups before or after the change, whichever is more (see the table above): 5.0–5.2 measured on
 * 59–97 MiB, 5.4–6.3 on 35 MiB (the young generation's garbage counting more), 6.2–6.4 for a join of
 * 65 MiB with the joined mesh, 5.8–6.2 for Apply Scale's copies and moved keys of 16–43 MiB with the
 * mesh, rounded up so that every run stays at least 10% below its estimate with
 * {@link OPERATOR_FIXED_BYTES} (memory.ts) beside it.
 */
export const LAYER_WRITE_BYTES_PER_BYTE = 7;

/**
 * Peak per vertex of every mesh whose vertex groups or shape keys an operator writes, beyond
 * {@link LAYER_WRITE_BYTES_PER_BYTE}: the lists of vertex indices and decoded weights or positions it
 * builds (a few dozen bytes per vertex at most, not measured apart).
 */
export const LAYER_OP_BYTES_PER_VERTEX = 64;

/**
 * Peak per vertex of a mesh parented with ARMATURE_ENVELOPE beyond its vertex groups: the vertices
 * moved into the armature's space (a list of their coordinates, and the garbage of each transform);
 * the runs of the table above show none beyond their groups, set at a few times the list's 24 bytes.
 */
export const ENVELOPE_WEIGHTS_BYTES_PER_VERTEX = 160;

/**
 * Peak per vertex of a mesh parented with ARMATURE_AUTO beyond its vertex groups: the bone heat solve
 * (the mesh's Laplacian, its edge weights in a Map, the visibility of the bones from each vertex): up
 * to 1,373 bytes per vertex measured (a grid of 361,201 vertices with 10 bones peaked at 611 MiB),
 * rounded up.
 */
export const HEAT_WEIGHTS_BYTES_PER_VERTEX = 2_000;

/** Which layer of a mesh an operator writes, for messages. */
export type LayerKind = 'vertex groups' | 'shape keys' | 'vertex groups and shape keys';

/** What an operator that writes vertex groups or shape keys takes and adds. */
export interface LayerWrites {
  /** Peak beyond OPERATOR_FIXED_BYTES (memory.ts), the decoded meshes it reads not included. */
  bytes: number;
  /** Bytes of the vertex groups or shape keys it writes (the more of before and after, all meshes). */
  written: number;
  kind: LayerKind;
  /** Heap the document keeps of what it adds, as the project counts it (memory-objects.ts storedMeshBytes). */
  stored: number;
  /** What a save takes for it for a moment beyond `stored` (SAVE_BYTES_PER_LAYER_BYTE of the bytes added). */
  save: number;
  /** Meshes whose layers it writes, which it decodes when `decodes` (memory.ts counts their decoded size). */
  meshes: string[];
  decodes: boolean;
  /** What to lower, completing "Lower …". */
  lower: string;
}

/** The names of stored mesh `id`'s vertex groups, read in place (no copy of their weights). */
function groupNames(doc: SceneDoc, id: string): Set<string> {
  const groups = (doc.map('meshes').get(id) as { get(key: string): unknown } | undefined)?.get(
    'vertex_groups',
  );
  const out = new Set<string>();
  if (Array.isArray(groups))
    for (const g of groups) {
      const name = (g as { name?: unknown } | null)?.name;
      if (typeof name === 'string') out.add(name);
    }
  return out;
}

/** The names of stored mesh `id`'s shape keys, read in place (no copy of their positions). */
function keyNames(doc: SceneDoc, id: string): string[] {
  const keys = (doc.map('meshes').get(id) as { get(key: string): unknown } | undefined)?.get('shape_keys');
  const out: string[] = [];
  if (Array.isArray(keys))
    for (const k of keys) {
      const name = (k as { name?: unknown } | null)?.name;
      if (typeof name === 'string') out.push(name);
    }
  return out;
}

const vertices = (doc: SceneDoc, id: string): number => doc.meshCounts(id)?.vertices ?? 0;

/** The armature parent types that give the child meshes vertex groups (operators/armature.ts). */
const WEIGHT_PARENT_TYPES: Readonly<Record<string, number>> = {
  ARMATURE_NAME: 0,
  ARMATURE_ENVELOPE: ENVELOPE_WEIGHTS_BYTES_PER_VERTEX,
  ARMATURE_AUTO: HEAT_WEIGHTS_BYTES_PER_VERTEX,
};

/**
 * object.parent_set and object.parent_to with an armature parent type that gives meshes vertex groups
 * (operators/armature.ts armatureParentSet): every mesh of the children, once each, gets a group per
 * deforming bone of the armature it does not have yet (ARMATURE_NAME keeps the groups it has, the others
 * replace them), and its groups are written again; ARMATURE_ENVELOPE and ARMATURE_AUTO compute the weights
 * of every vertex first. Null for the other types (an Armature modifier, or bone parenting: a few hundred
 * bytes per child) and when the parent is not an armature (the operator fails by itself).
 */
export function armatureParentWrites(
  doc: SceneDoc,
  childIds: readonly string[],
  parentId: string | null | undefined,
  type: string,
): LayerWrites | null {
  const perVertex = WEIGHT_PARENT_TYPES[type];
  if (perVertex === undefined || !parentId) return null;
  const parent = doc.getObject(parentId);
  const arm = parent?.type === 'ARMATURE' && parent.data ? doc.getArmature(parent.data) : null;
  if (!arm) return null;
  const deform = arm.bones.filter((b) => b.use_deform !== false).map((b) => b.name);
  const meshes: string[] = [];
  const seen = new Set<string>();
  let written = 0;
  let added = 0;
  let verts = 0;
  for (const id of childIds) {
    if (id === parentId) continue;
    const o = doc.getObject(id);
    if (o?.type !== 'MESH' || !o.data || seen.has(o.data)) continue;
    seen.add(o.data);
    const n = vertices(doc, o.data);
    const names = groupNames(doc, o.data);
    const fresh = deform.filter((b) => !names.has(b)).length * VERTEX_GROUP_BYTES_PER_VERTEX * n;
    written += vertexGroupBytes(doc, o.data) + fresh;
    added += fresh;
    verts += n;
    meshes.push(o.data);
  }
  if (!meshes.length) return null;
  return {
    bytes: LAYER_WRITE_BYTES_PER_BYTE * written + (LAYER_OP_BYTES_PER_VERTEX + perVertex) * verts,
    written,
    kind: 'vertex groups',
    stored: added,
    save: SAVE_BYTES_PER_LAYER_BYTE * added,
    meshes,
    decodes: true,
    lower:
      'the vertices of the child meshes or the number of deforming bones (type ARMATURE parents them without vertex groups)',
  };
}

/** What a vertex group operator does to the groups of its mesh (operators/armature.ts). */
export type VertexGroupChange = { op: 'add' } | { op: 'ensure'; group: string } | { op: 'rewrite' };

/**
 * The object.vertex_group_* operators on the mesh `meshId`: every one of them writes all the groups of
 * the mesh again; add (and assign or set_weights of a group the mesh does not have) adds a group of a
 * weight per vertex.
 */
export function vertexGroupWrites(doc: SceneDoc, meshId: string, change: VertexGroupChange): LayerWrites {
  const n = vertices(doc, meshId);
  const before = vertexGroupBytes(doc, meshId);
  const adds =
    change.op === 'add' || (change.op === 'ensure' && !groupNames(doc, meshId).has(change.group))
      ? VERTEX_GROUP_BYTES_PER_VERTEX * n
      : 0;
  const written = before + adds;
  return {
    bytes: LAYER_WRITE_BYTES_PER_BYTE * written + LAYER_OP_BYTES_PER_VERTEX * n,
    written,
    kind: 'vertex groups',
    stored: adds,
    save: SAVE_BYTES_PER_LAYER_BYTE * adds,
    meshes: [meshId],
    decodes: false,
    lower: 'the vertices of the mesh or the number of its vertex groups',
  };
}

/** What a shape key operator does to the keys of its mesh (operators/armature.ts). */
export type ShapeKeyChange = { op: 'add' } | { op: 'rewrite'; decodes: boolean };

/**
 * The object.shape_key_* operators on the mesh `meshId`: every one of them writes all the keys of the
 * mesh again; add adds a key of a position per vertex (kept as the project counts it,
 * SHAPE_KEY_STORED_BYTES_PER_VERTEX); add, set_positions and remove with apply_mix read the mesh.
 */
export function shapeKeyWrites(doc: SceneDoc, meshId: string, change: ShapeKeyChange): LayerWrites {
  const n = vertices(doc, meshId);
  const adds = change.op === 'add' ? SHAPE_KEY_BYTES_PER_VERTEX * n : 0;
  const written = shapeKeyBytes(doc, meshId) + adds;
  return {
    bytes: LAYER_WRITE_BYTES_PER_BYTE * written + LAYER_OP_BYTES_PER_VERTEX * n,
    written,
    kind: 'shape keys',
    stored: change.op === 'add' ? SHAPE_KEY_STORED_BYTES_PER_VERTEX * n : 0,
    save: SAVE_BYTES_PER_LAYER_BYTE * adds,
    meshes: [meshId],
    decodes: change.op === 'add' || change.decodes,
    lower: 'the vertices of the mesh or the number of its shape keys',
  };
}

/** Whether mesh object `o` is deformed by one of the armature objects `users` (armature/edit.ts isDeformedBy). */
function deformedBy(o: ObjectData, users: ReadonlySet<string>): boolean {
  return o.modifiers.some(
    (m) => m.type === 'ARMATURE' && typeof m.params?.object === 'string' && users.has(m.params.object),
  );
}

/**
 * armature.bone_update renaming bone `from` of armature object `armatureObject` (armature/edit.ts
 * renameBone): the vertex groups named like it, of the meshes the armature deforms or parents, follow
 * the new name, so every group of each such mesh is written again. Null when it writes none.
 */
export function boneRenameWrites(
  doc: SceneDoc,
  armatureObject: ObjectData,
  from: string,
): LayerWrites | null {
  if (armatureObject.type !== 'ARMATURE' || !armatureObject.data) return null;
  const users = new Set(
    doc
      .listObjects()
      .filter((o) => o.type === 'ARMATURE' && o.data === armatureObject.data)
      .map((o) => o.id),
  );
  const meshes: string[] = [];
  let written = 0;
  let verts = 0;
  for (const o of doc.listObjects()) {
    if (o.type !== 'MESH' || !o.data || meshes.includes(o.data)) continue;
    if (!deformedBy(o, users) && !(o.parent && users.has(o.parent))) continue;
    if (!groupNames(doc, o.data).has(from)) continue;
    meshes.push(o.data);
    written += vertexGroupBytes(doc, o.data);
    verts += vertices(doc, o.data);
  }
  if (!meshes.length) return null;
  return {
    bytes: LAYER_WRITE_BYTES_PER_BYTE * written + LAYER_OP_BYTES_PER_VERTEX * verts,
    written,
    kind: 'vertex groups',
    stored: 0,
    save: 0,
    meshes,
    decodes: false,
    lower: 'the vertex groups of the meshes the armature deforms',
  };
}

/**
 * object.transform_apply and object.origin_set (object.ts) on the meshes `meshes` (for each, the
 * selected objects that use it and the copies the operator makes of it: memory.ts singleUserCopies):
 * a copy gets the vertex groups and shape keys of its mesh, and the shape keys of the mesh of every
 * selected object are written again, moved with its vertices (as Blender's BKE_mesh_transform and
 * BKE_mesh_translate move every key block). The copies keep what they get. Null when they write none.
 */
export function movedLayerWrites(
  doc: SceneDoc,
  meshes: ReadonlyMap<string, { objects: number; copies: number }>,
): LayerWrites | null {
  let written = 0;
  let copied = 0;
  let stored = 0;
  let verts = 0;
  let groups = false;
  let keys = false;
  const ids: string[] = [];
  for (const [id, { objects, copies }] of meshes) {
    const g = vertexGroupBytes(doc, id);
    const k = shapeKeyBytes(doc, id);
    if (!k && !(copies && g)) continue;
    const n = vertices(doc, id);
    written += copies * (g + k) + objects * k;
    copied += copies * (g + k);
    stored += copies * (g + SHAPE_KEY_STORED_BYTES_PER_VERTEX * shapeKeyCount(doc, id) * n);
    verts += (copies + (k ? objects : 0)) * n;
    groups ||= copies > 0 && g > 0;
    keys ||= k > 0;
    ids.push(id);
  }
  if (!ids.length) return null;
  const kind: LayerKind =
    groups && keys ? 'vertex groups and shape keys' : keys ? 'shape keys' : 'vertex groups';
  return {
    bytes: LAYER_WRITE_BYTES_PER_BYTE * written + LAYER_OP_BYTES_PER_VERTEX * verts,
    written,
    kind,
    stored,
    save: SAVE_BYTES_PER_LAYER_BYTE * copied,
    meshes: ids,
    decodes: false,
    lower: `the number or size of the selected meshes or the number of their ${kind}`,
  };
}

/**
 * object.join of the meshes `meshIds` (the active object's, `activeMesh`, and one per joined object: a
 * mesh linked duplicates share counts for each), whose vertex groups and shape keys object.ts merges
 * by name into the joined mesh as Blender's Join does: every group and key of any of them (the keys of
 * a joined mesh without vertices left out) is written with a value per vertex of the joined mesh. The
 * meshes `freed` (those the join replaces or removes) take their groups and keys with them. Null when
 * no mesh has any.
 */
export function joinLayerWrites(
  doc: SceneDoc,
  meshIds: readonly string[],
  freed: readonly string[],
  activeMesh: string | null = null,
): LayerWrites | null {
  const groups = new Set<string>();
  const keys = new Set<string>();
  let verts = 0;
  for (const id of meshIds) {
    const n = vertices(doc, id);
    verts += n;
    for (const g of groupNames(doc, id)) groups.add(g);
    if (n > 0 || id === activeMesh) for (const k of keyNames(doc, id)) keys.add(k);
  }
  if (!groups.size && !keys.size) return null;
  const groupBytes = VERTEX_GROUP_BYTES_PER_VERTEX * groups.size * verts;
  const written = groupBytes + SHAPE_KEY_BYTES_PER_VERTEX * keys.size * verts;
  let freedBytes = 0;
  let freedKept = 0;
  for (const id of new Set(freed)) {
    const g = vertexGroupBytes(doc, id);
    freedBytes += g + shapeKeyBytes(doc, id);
    freedKept += g + SHAPE_KEY_STORED_BYTES_PER_VERTEX * shapeKeyCount(doc, id) * vertices(doc, id);
  }
  return {
    bytes: LAYER_WRITE_BYTES_PER_BYTE * written + LAYER_OP_BYTES_PER_VERTEX * verts,
    written,
    kind: !keys.size ? 'vertex groups' : !groups.size ? 'shape keys' : 'vertex groups and shape keys',
    stored: Math.max(0, groupBytes + SHAPE_KEY_STORED_BYTES_PER_VERTEX * keys.size * verts - freedKept),
    save: SAVE_BYTES_PER_LAYER_BYTE * Math.max(0, written - freedBytes),
    meshes: [...new Set(meshIds)],
    decodes: false,
    lower: 'the number or size of the joined meshes or the number of their vertex groups and shape keys',
  };
}
