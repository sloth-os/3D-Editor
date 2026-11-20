import type { DatablockKind } from '../../doc/types';
import { sha256HexOfText } from '../container/digest';
import { canonicalJsonStrict } from './canonical';
import type { UnitKind } from './kinds';
import type { UnitRecord } from './refs';

/*
 * Who owns which fields of an instance's parts.
 *
 * Unit-owned: geometry, materials, structure, and the desk props that are part of the thing (a
 * figure's desk_role, desk_kind, desk_height_m and desk_color; the desk_role, desk_label and
 * desk_shape of set pieces). Scene-owned: where the instance stands and what the scene does with it.
 * Scene-owned values are never written into a unit, are left out of the parts' digests, and are kept
 * by updates, so staging, posing, holding and physics never make a part look edited:
 *
 * - custom props starting with unit_, desk_rideo_ or desk_tether_, and desk_character_id,
 *   desk_element_id, desk_shot, desk_dof, desk_floats, desk_in_water, desk_string_to,
 *   desk_string_from, desk_tail_of, on every object; every desk_* prop on the root of a set or a
 *   prop (the scene decides whether a library prop is an action prop or set dressing, and stamps its
 *   set's root); on a figure's root every desk_* prop but desk_role, desk_kind, desk_height_m and
 *   desk_color;
 * - the name of every part and the collection of every object;
 * - on the root: location, rotation, scale, parent (and its type and bone), constraints, rigid body,
 *   hiding and pose (scale and pose take the unit's value when it is inserted);
 * - on any other object, constraints and pose-bone constraints whose target is outside the instance.
 */

/** Custom prop prefixes the scene owns on every object. */
export const SCENE_PROP_PREFIXES = ['unit_', 'desk_rideo_', 'desk_tether_'] as const;
/** Custom props the scene owns on every object. */
export const SCENE_PROPS = [
  'desk_character_id',
  'desk_element_id',
  'desk_shot',
  'desk_dof',
  'desk_floats',
  'desk_in_water',
  'desk_string_to',
  'desk_string_from',
  'desk_tail_of',
] as const;
/** The desk props a figure's root keeps as the unit's (its other desk_* props are the scene's). */
export const FIGURE_ROOT_UNIT_PROPS = ['desk_role', 'desk_kind', 'desk_height_m', 'desk_color'] as const;
/** Fields every part leaves to the scene. */
export const PART_SCENE_FIELDS = ['name'] as const;
/** Fields every object leaves to the scene (besides PART_SCENE_FIELDS). */
export const OBJECT_SCENE_FIELDS = ['collection'] as const;
/** Fields an instance's root leaves to the scene. */
export const ROOT_SCENE_FIELDS = [
  'location',
  'rotation_euler',
  'scale',
  'parent',
  'parent_type',
  'parent_bone',
  'constraints',
  'rigid_body',
  'hide_viewport',
  'hide_render',
  'hide_select',
  'pose',
] as const;

/** Where a record sits in its unit, for the ownership rules. */
export interface PartPlace {
  /** The instance's root object. */
  isRoot: boolean;
  unitKind: UnitKind;
}

/** Whether custom prop `key` of an object is the scene's (see the rules above). */
export function isSceneProp(key: string, place: PartPlace): boolean {
  if (SCENE_PROP_PREFIXES.some((p) => key.startsWith(p))) return true;
  if ((SCENE_PROPS as readonly string[]).includes(key)) return true;
  if (place.isRoot && key.startsWith('desk_'))
    return place.unitKind !== 'figure' || !(FIGURE_ROOT_UNIT_PROPS as readonly string[]).includes(key);
  return false;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/** A record's custom props split into the unit's and the scene's. */
export function splitProps(
  props: unknown,
  place: PartPlace,
): { unit: Record<string, unknown>; scene: Record<string, unknown> } {
  const unit: Record<string, unknown> = {};
  const scene: Record<string, unknown> = {};
  if (isRecord(props))
    for (const [k, v] of Object.entries(props)) (isSceneProp(k, place) ? scene : unit)[k] = v;
  return { unit, scene };
}

/**
 * A unit record as it is written into the scene: an object's custom props without those the scene
 * owns (extraction never writes them; a crafted unit carrying unit_* props on a part would plant a
 * second instance). The record's stamp is the same, as unitView leaves them out too.
 */
export function withUnitProps(kind: DatablockKind, record: UnitRecord, place: PartPlace): UnitRecord {
  return kind === 'objects' && isRecord(record.custom_props)
    ? { ...record, custom_props: splitProps(record.custom_props, place).unit }
    : record;
}

/** Whether a constraint targets an object outside the instance (ids already mapped: outside ones start with '!'). */
const external = (c: unknown, outside: (id: string) => boolean): boolean =>
  isRecord(c) && typeof c.target === 'string' && !!c.target && outside(c.target);

/** A constraint list without the constraints that target outside the instance. */
function internalConstraints(list: unknown, outside: (id: string) => boolean): unknown {
  return Array.isArray(list) ? list.filter((c) => !external(c, outside)) : list;
}

/** Whether an id (as a unit view writes it) is outside the instance: views write those as '!<id>'. */
export const OUTSIDE_MARK = '!';
const outsideMarked = (id: string) => id.startsWith(OUTSIDE_MARK);

/**
 * The fields of a part the unit owns: what its digest covers. `record` holds source ids, with ids
 * outside the instance written as '!<id>' (they never match a stamp).
 */
export function unitView(kind: DatablockKind, record: UnitRecord, place: PartPlace): UnitRecord {
  const v: UnitRecord = { ...record };
  delete v.id;
  for (const f of PART_SCENE_FIELDS) delete v[f];
  if (kind !== 'objects') return v;
  for (const f of OBJECT_SCENE_FIELDS) delete v[f];
  if (place.isRoot) for (const f of ROOT_SCENE_FIELDS) delete v[f];
  v.custom_props = splitProps(record.custom_props, place).unit;
  if (!place.isRoot) {
    v.constraints = internalConstraints(v.constraints, outsideMarked);
    if (isRecord(v.pose) && isRecord(v.pose.bones)) {
      const bones: Record<string, unknown> = {};
      for (const [name, pb] of Object.entries(v.pose.bones))
        bones[name] = isRecord(pb)
          ? { ...pb, constraints: internalConstraints(pb.constraints, outsideMarked) }
          : pb;
      v.pose = { ...v.pose, bones };
    }
  }
  return v;
}

/** The stamp of a part: the first 16 hex digits of the SHA-256 of its unit view's canonical JSON. */
export function partSum16(kind: DatablockKind, record: UnitRecord, place: PartPlace): string {
  return sha256HexOfText(canonicalJsonStrict(unitView(kind, record, place), 'digest')).slice(0, 16);
}

/**
 * The record an update writes for a part the scene left untouched: the new unit record (`next`,
 * already in scene ids) with the scene-owned fields of the current one (`current`): its name and
 * collection, the root's placement, parent, constraints, physics, hiding and pose, the scene's custom
 * props, and on other objects the constraints (and pose-bone constraints) that target outside the
 * instance after the unit's own. `outside(id)` tells a scene id outside the instance.
 */
export function mergeForUpdate(
  kind: DatablockKind,
  next: UnitRecord,
  current: UnitRecord,
  place: PartPlace,
  outside: (id: string) => boolean,
): UnitRecord {
  const merged: UnitRecord = { ...next };
  for (const f of PART_SCENE_FIELDS) if (f in current) merged[f] = current[f];
  if (kind !== 'objects') return merged;
  for (const f of OBJECT_SCENE_FIELDS) if (f in current) merged[f] = current[f];
  if (place.isRoot) {
    for (const f of ROOT_SCENE_FIELDS)
      if (f in current) merged[f] = current[f];
      else delete merged[f];
  }
  merged.custom_props = {
    ...splitProps(next.custom_props, place).unit,
    ...splitProps(current.custom_props, place).scene,
  };
  if (!place.isRoot) {
    const mine = Array.isArray(next.constraints) ? next.constraints : [];
    const theirs = Array.isArray(current.constraints)
      ? current.constraints.filter((c) => external(c, outside))
      : [];
    merged.constraints = [...mine, ...theirs];
    const nextBones = isRecord(next.pose) && isRecord(next.pose.bones) ? next.pose.bones : null;
    const curBones = isRecord(current.pose) && isRecord(current.pose.bones) ? current.pose.bones : null;
    if (curBones) {
      const bones: Record<string, unknown> = { ...(nextBones ?? {}) };
      for (const [name, pb] of Object.entries(curBones)) {
        if (!isRecord(pb) || !Array.isArray(pb.constraints)) continue;
        const ext = pb.constraints.filter((c) => external(c, outside));
        if (!ext.length) continue;
        const nb = isRecord(bones[name]) ? (bones[name] as Record<string, unknown>) : {};
        const own = Array.isArray(nb.constraints) ? nb.constraints : [];
        bones[name] = { ...nb, constraints: [...own, ...ext] };
      }
      merged.pose = { ...(isRecord(next.pose) ? next.pose : {}), bones };
    }
  }
  return merged;
}
