import { getConstraintTypeInfo } from '../../constraints/catalogue';
import { dataKindOf } from '../../doc/scene-doc';
import {
  ROOT_COLLECTION_ID,
  type AnimTargetType,
  type DatablockKind,
  type ObjectType,
} from '../../doc/types';
import { modifierObjectParams } from '../../modifiers/builtin';
import { DESK_PROPS } from '../props';

/*
 * Every field of a stored record that holds the id of another datablock: what a unit's records are
 * remapped through when they are extracted (scene ids → source ids), inserted (source ids → derived
 * scene ids) and compared (scene ids → source ids again), and what a decoded unit is checked against
 * (every reference must name a datablock of the unit: a closed body).
 *
 * - ObjectData: parent; data (its kind by object type); collection ('root' is the scene collection);
 *   material_slots[]; modifiers[].params of each type's object params (Armature, Array caps and
 *   offset, Boolean, Cast, Curve, Mirror, Screw, Shrinkwrap, Simple Deform, Wave); constraints[]
 *   target and object params (IK pole_target); pose.bones[*].constraints[] likewise;
 *   instance_collection; particle_systems[].settings instance_object, instance_collection and
 *   instance_weights[].object; custom_props.desk_actor.
 * - CurveData.bevel_object, CameraData.dof_focus_object, MaterialData.textures[channel].image
 *   ('' is none), CollectionData.parent.
 * - Drivers: target_id and variables[].target_id, by their target type.
 * Not ids, never remapped: constraint subtargets and parent_bone (bone names), BoneData.parent,
 * F-curve paths; ids inside desk_tether_flights (a scene-owned prop, never in a unit).
 *
 * Cutting a reference (the map gives null): a parent goes (parent null), a constraint whose target
 * is cut goes, a weight entry goes, desk_actor goes, a collection becomes the scene collection, a
 * texture's image becomes '' and every other field becomes null.
 */

/** A record: the stored fields of a datablock (minus `id`). */
export type UnitRecord = Record<string, unknown>;

/** Where a reference sits in a record. */
export type RefSite =
  | 'parent'
  | 'data'
  | 'collection'
  | 'material'
  | 'modifier'
  | 'constraint'
  | 'constraint_param'
  | 'bone_constraint'
  | 'bone_constraint_param'
  | 'instance_collection'
  | 'particle_object'
  | 'particle_collection'
  | 'particle_weight'
  | 'desk_actor'
  | 'bevel_object'
  | 'dof_focus_object'
  | 'texture_image'
  | 'collection_parent';

/** One reference of a record. */
export interface RefHit {
  kind: DatablockKind;
  id: string;
  site: RefSite;
}

/** Maps one reference: the id it becomes, or null to cut it. */
export type RefMap = (kind: DatablockKind, id: string, site: RefSite) => string | null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/** The kind of the datablock an F-curve or driver target type names (null: the world or the scene). */
export const ANIM_TARGET_KINDS: Readonly<Partial<Record<AnimTargetType, DatablockKind>>> = {
  object: 'objects',
  material: 'materials',
  light: 'lights',
  camera: 'cameras',
  mesh: 'meshes',
  curve: 'curves',
};

/** Object params of a constraint type besides its target (IK pole_target; unknown types: pole_target). */
function constraintParams(type: unknown): string[] {
  return getConstraintTypeInfo(String(type))?.objectParams ?? ['pole_target'];
}

/** A constraint list with its references mapped (constraints whose target is cut are left out). */
function mapConstraints(list: unknown, map: RefMap, bone: boolean): unknown {
  if (!Array.isArray(list)) return list;
  const out: unknown[] = [];
  for (const c of list) {
    if (!isRecord(c)) {
      out.push(c);
      continue;
    }
    const next: Record<string, unknown> = { ...c };
    if (typeof c.target === 'string' && c.target) {
      const t = map('objects', c.target, bone ? 'bone_constraint' : 'constraint');
      if (t === null) continue;
      next.target = t;
    }
    if (isRecord(c.params)) {
      const params: Record<string, unknown> = { ...c.params };
      for (const k of constraintParams(c.type)) {
        const v = params[k];
        if (typeof v === 'string' && v)
          params[k] = map('objects', v, bone ? 'bone_constraint_param' : 'constraint_param');
      }
      next.params = params;
    }
    out.push(next);
  }
  return out;
}

/** The record with every reference mapped through `map` (a new object; the input is not changed). */
export function mapRecordRefs(kind: DatablockKind, record: UnitRecord, map: RefMap): UnitRecord {
  const r: UnitRecord = { ...record };
  switch (kind) {
    case 'objects': {
      if (typeof r.parent === 'string' && r.parent) {
        const p = map('objects', r.parent, 'parent');
        if (p === null) {
          r.parent = null;
          if (r.parent_type !== undefined) r.parent_type = 'OBJECT';
          if (r.parent_bone !== undefined) r.parent_bone = '';
        } else r.parent = p;
      }
      if (typeof r.data === 'string' && r.data) {
        const dk = dataKindOf(String(r.type) as ObjectType);
        if (dk) r.data = map(dk, r.data, 'data');
      }
      if (typeof r.collection === 'string' && r.collection && r.collection !== ROOT_COLLECTION_ID)
        r.collection = map('collections', r.collection, 'collection') ?? ROOT_COLLECTION_ID;
      if (Array.isArray(r.material_slots))
        r.material_slots = r.material_slots.map((m) =>
          typeof m === 'string' && m ? map('materials', m, 'material') : m,
        );
      if (Array.isArray(r.modifiers))
        r.modifiers = r.modifiers.map((m) => {
          if (!isRecord(m) || !isRecord(m.params)) return m;
          const keys = modifierObjectParams(String(m.type));
          if (!keys.length) return m;
          const params: Record<string, unknown> = { ...m.params };
          for (const k of keys) {
            const v = params[k];
            if (typeof v === 'string' && v) params[k] = map('objects', v, 'modifier');
          }
          return { ...m, params };
        });
      if (Array.isArray(r.constraints)) r.constraints = mapConstraints(r.constraints, map, false);
      if (isRecord(r.pose) && isRecord(r.pose.bones)) {
        const bones: Record<string, unknown> = {};
        for (const [name, pb] of Object.entries(r.pose.bones))
          bones[name] =
            isRecord(pb) && Array.isArray(pb.constraints)
              ? { ...pb, constraints: mapConstraints(pb.constraints, map, true) }
              : pb;
        r.pose = { ...r.pose, bones };
      }
      if (typeof r.instance_collection === 'string' && r.instance_collection)
        r.instance_collection = map('collections', r.instance_collection, 'instance_collection');
      if (Array.isArray(r.particle_systems))
        r.particle_systems = r.particle_systems.map((ps) => {
          if (!isRecord(ps) || !isRecord(ps.settings)) return ps;
          const s: Record<string, unknown> = { ...ps.settings };
          if (typeof s.instance_object === 'string' && s.instance_object)
            s.instance_object = map('objects', s.instance_object, 'particle_object');
          if (typeof s.instance_collection === 'string' && s.instance_collection)
            s.instance_collection = map('collections', s.instance_collection, 'particle_collection');
          if (Array.isArray(s.instance_weights))
            s.instance_weights = s.instance_weights.flatMap((w) => {
              if (!isRecord(w) || typeof w.object !== 'string' || !w.object) return [w];
              const o = map('objects', w.object, 'particle_weight');
              return o === null ? [] : [{ ...w, object: o }];
            });
          return { ...ps, settings: s };
        });
      if (isRecord(r.custom_props) && typeof r.custom_props[DESK_PROPS.actor] === 'string') {
        const props: Record<string, unknown> = { ...r.custom_props };
        const a = map('objects', props[DESK_PROPS.actor] as string, 'desk_actor');
        if (a === null) delete props[DESK_PROPS.actor];
        else props[DESK_PROPS.actor] = a;
        r.custom_props = props;
      }
      break;
    }
    case 'curves':
      if (typeof r.bevel_object === 'string' && r.bevel_object)
        r.bevel_object = map('objects', r.bevel_object, 'bevel_object');
      break;
    case 'cameras':
      if (typeof r.dof_focus_object === 'string' && r.dof_focus_object)
        r.dof_focus_object = map('objects', r.dof_focus_object, 'dof_focus_object');
      break;
    case 'materials':
      if (isRecord(r.textures)) {
        const textures: Record<string, unknown> = {};
        for (const [ch, slot] of Object.entries(r.textures))
          textures[ch] =
            isRecord(slot) && typeof slot.image === 'string' && slot.image
              ? { ...slot, image: map('images', slot.image, 'texture_image') ?? '' }
              : slot;
        r.textures = textures;
      }
      break;
    case 'collections':
      if (typeof r.parent === 'string' && r.parent && r.parent !== ROOT_COLLECTION_ID)
        r.parent = map('collections', r.parent, 'collection_parent');
      break;
    default:
      break;
  }
  return r;
}

/** Every reference of a record, in the order mapRecordRefs visits them. */
export function collectRecordRefs(kind: DatablockKind, record: UnitRecord): RefHit[] {
  const hits: RefHit[] = [];
  mapRecordRefs(kind, record, (k, id, site) => {
    hits.push({ kind: k, id, site });
    return id;
  });
  return hits;
}

/**
 * A driver with its target and variables mapped through `map` (by their target types; world and
 * scene targets are kept), or null when the target or a variable's datablock is cut.
 */
export function mapDriverRefs(
  driver: UnitRecord,
  map: (kind: DatablockKind, id: string) => string | null,
): UnitRecord | null {
  const d: UnitRecord = { ...driver };
  const one = (type: unknown, id: unknown): string | null | undefined => {
    const kind = ANIM_TARGET_KINDS[type as AnimTargetType];
    if (!kind || typeof id !== 'string') return undefined;
    return map(kind, id);
  };
  const t = one(d.target_type, d.target_id);
  if (t === null) return null;
  if (t !== undefined) d.target_id = t;
  if (Array.isArray(d.variables)) {
    const vars: unknown[] = [];
    for (const v of d.variables) {
      if (!isRecord(v)) {
        vars.push(v);
        continue;
      }
      const m = one(v.target_type, v.target_id);
      if (m === null) return null;
      vars.push(m === undefined ? v : { ...v, target_id: m });
    }
    d.variables = vars;
  }
  return d;
}

/** Every datablock reference of a driver (its target and variables; world and scene left out). */
export function collectDriverRefs(driver: UnitRecord): { kind: DatablockKind; id: string }[] {
  const hits: { kind: DatablockKind; id: string }[] = [];
  mapDriverRefs(driver, (kind, id) => {
    hits.push({ kind, id });
    return id;
  });
  return hits;
}
