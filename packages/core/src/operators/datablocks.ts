import type { DatablockKind, ObjectData, ObjectType } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { OperatorError } from './context';

/*
 * Datablock references for operators. Agents (and people) know objects by name; the light, camera,
 * mesh, curve and armature datablocks behind them have ids nobody sees. Like the Properties editor,
 * which shows the data of the active object, operators that edit data accept the object that uses it.
 */

/** Object types that use each kind of object data. */
export const DATA_OBJECT_TYPES: Partial<Record<DatablockKind, readonly ObjectType[]>> = {
  meshes: ['MESH'],
  lights: ['LIGHT'],
  cameras: ['CAMERA'],
  curves: ['CURVE', 'FONT'],
  armatures: ['ARMATURE'],
};

/** Singular, human readable name of a datablock kind ('lights' → 'light'). */
export const KIND_LABEL: Record<DatablockKind, string> = {
  objects: 'object',
  meshes: 'mesh',
  materials: 'material',
  lights: 'light',
  cameras: 'camera',
  images: 'image',
  collections: 'collection',
  curves: 'curve',
  armatures: 'armature',
};

function blockList(doc: SceneDoc, kind: DatablockKind): { id: string; name: string }[] {
  switch (kind) {
    case 'objects':
      return doc.listObjects();
    case 'meshes':
      return doc.listMeshBlocks();
    case 'materials':
      return doc.listMaterials();
    case 'lights':
      return doc.listLights();
    case 'cameras':
      return doc.listCameras();
    case 'images':
      return doc.listImages();
    case 'collections':
      return doc.listCollections();
    case 'curves':
      return doc.listCurves();
    case 'armatures':
      return doc.listArmatures();
  }
}

/** "A, B, C" (at most `max` names, then "…"). */
export function nameList(names: string[], max = 12): string {
  const shown = names.slice(0, max).map((n) => `'${n}'`);
  return names.length > max ? `${shown.join(', ')}, … (${names.length} in total)` : shown.join(', ');
}

/** Objects that use datablocks of `kind` (light objects for lights …). */
export function objectsUsing(doc: SceneDoc, kind: DatablockKind): ObjectData[] {
  const types = DATA_OBJECT_TYPES[kind];
  return types ? doc.listObjects().filter((o) => types.includes(o.type) && !!o.data) : [];
}

export interface ResolvedBlock {
  /** Datablock id. */
  id: string;
  /** The object the reference named, when it was resolved through an object. */
  object: ObjectData | null;
  /**
   * Set when the reference was ambiguous: it names an object whose data is one datablock and,
   * as a datablock name, another one. Says which was used and how to reach the other; callers
   * report it as a WARNING.
   */
  warning?: string;
}

/** Materials of an object's slots (distinct, in slot order). */
function objectMaterials(doc: SceneDoc, o: ObjectData): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const id of o.material_slots) {
    const m = id ? doc.getMaterial(id) : null;
    if (m && !out.some((x) => x.id === m.id)) out.push({ id: m.id, name: m.name });
  }
  return out;
}

/**
 * Resolves a datablock reference (like Blender's `bpy.data.<kind>[name]`). Accepted, in this order:
 * 1. the datablock id;
 * 2. the id or name of an object that uses the data: a light object for lights, a camera object
 *    for cameras, a mesh / curve or text / armature object for meshes / curves / armatures;
 * 3. the datablock name (for materials before 2., then an object with exactly one material).
 * When a name matches both an object (whose data is datablock A) and a different datablock B, the
 * order above decides and `warning` names both choices.
 * Throws an OperatorError (NOT_FOUND) naming the reference and listing the candidates.
 */
export function resolveDatablock(doc: SceneDoc, kind: DatablockKind, ref: string): ResolvedBlock {
  const label = KIND_LABEL[kind];
  if (kind === 'objects') {
    const o = doc.resolveObject(ref);
    if (!o) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
    return { id: o.id, object: o };
  }
  if (doc.getBlock(kind, ref)) return { id: ref, object: null };
  const types = DATA_OBJECT_TYPES[kind];
  const o = types || kind === 'materials' ? doc.resolveObject(ref) : null;
  if (o && types) {
    if (types.includes(o.type) && o.data && doc.getBlock(kind, o.data)) {
      const other = blockList(doc, kind).find((b) => b.name === ref && b.id !== o.data);
      if (!other) return { id: o.data, object: o };
      const own = blockList(doc, kind).find((b) => b.id === o.data);
      const users = objectsUsing(doc, kind).filter((u) => u.data === other.id);
      return {
        id: o.data,
        object: o,
        warning:
          `'${ref}' names both the ${label} object '${o.name}' (whose ${label} data is '${own?.name ?? o.data}') ` +
          `and another ${label} datablock called '${other.name}'` +
          (users.length ? ` (used by ${nameList(users.map((u) => u.name))})` : '') +
          `: used the object's data '${own?.name ?? o.data}'. To use '${other.name}' instead, pass its ` +
          `datablock id '${other.id}'` +
          (users.length ? ` or the name of an object using it ('${users[0].name}')` : ''),
      };
    }
    // an object of another type: a datablock of that name may still exist (checked below)
  } else if (o && kind === 'materials') {
    // materials are named by agents (set_material, material.new): a material name wins
    const byName = blockList(doc, kind).find((b) => b.name === ref);
    const mats = objectMaterials(doc, o);
    if (byName) {
      if (mats.length !== 1 || mats[0].id === byName.id) return { id: byName.id, object: null };
      return {
        id: byName.id,
        object: null,
        warning:
          `'${ref}' names both the material '${byName.name}' and the object '${o.name}' (whose only material ` +
          `is '${mats[0].name}'): used the material '${byName.name}'. To use '${mats[0].name}' instead, ` +
          `pass its name or id '${mats[0].id}'`,
      };
    }
    if (mats.length === 1) return { id: mats[0].id, object: o };
    throw new OperatorError(
      mats.length
        ? `Object '${o.name}' has ${mats.length} materials (${nameList(mats.map((m) => m.name))}): pass the material name or id`
        : `Object '${o.name}' has no material`,
      'NOT_FOUND',
    );
  }
  const byName = blockList(doc, kind).find((b) => b.name === ref);
  if (byName) return { id: byName.id, object: null };
  if (o && types)
    throw new OperatorError(
      `Object '${o.name}' is a ${o.type} object, not a ${label} object` + candidates(doc, kind),
      'NOT_FOUND',
    );
  throw new OperatorError(
    `${label[0].toUpperCase()}${label.slice(1)} '${ref}' not found` + candidates(doc, kind),
    'NOT_FOUND',
  );
}

/** ". Light objects: 'Key', 'Fill'" style hint (or the datablock names for kinds without objects). */
function candidates(doc: SceneDoc, kind: DatablockKind): string {
  const label = KIND_LABEL[kind];
  if (DATA_OBJECT_TYPES[kind]) {
    const objs = objectsUsing(doc, kind).map((o) => o.name);
    return objs.length
      ? `. Pass the name or id of a ${label} object (${label} objects: ${nameList(objs)}) or a ${label} datablock id`
      : `. The scene has no ${label} objects`;
  }
  const names = blockList(doc, kind).map((b) => b.name);
  return names.length
    ? `. ${label[0].toUpperCase()}${label.slice(1)}s: ${nameList(names)}`
    : `. There are no ${kind}`;
}
