import type { SceneDoc } from '../../doc/scene-doc';
import type { AnimTargetType, DatablockKind, ObjectData } from '../../doc/types';
import { STORE_PART_PROP } from '../layout';
import { DESK_PROPS } from '../props';
import { readInstance, splitPartKey } from './list';
import {
  ANIM_TARGET_KINDS,
  collectDriverRefs,
  collectRecordRefs,
  type RefSite,
  type UnitRecord,
} from './refs';

/*
 * Taking library unit instances out of a scene, and what they leave behind.
 *
 * Every part an instance holds has an id derived from its slot (ids.ts), so a unit placed in the
 * slot again (the same version, another version, or an item saved from the instance) derives the
 * same ids. Removing an instance therefore removes all of it: its objects (the root and everything
 * below it) and every datablock its part table lists (materials, images, meshes, armatures,
 * curves, lights, cameras, collections) that nothing left in the document uses. A datablock at an
 * id a unit derives that nothing uses (left behind by an older desk, or by a part deleted by hand)
 * counts as free when a unit is put in: it is deleted in the same transaction. The choice depends
 * on the document alone, so every replica makes the same one.
 *
 * A new look in place of an old one (a library figure or prop replacing what the words built, an
 * actor back to its mannequin) takes away only the old look (oldLook); what the person put on the
 * object stays, and the caller names it in a warning.
 */

/** The '<kind>:<id>' key of a datablock. */
export const dataKey = (kind: DatablockKind, id: string): string => `${kind}:${id}`;

const splitKey = (key: string): { kind: DatablockKind; id: string } => {
  const at = key.indexOf(':');
  return { kind: key.slice(0, at) as DatablockKind, id: key.slice(at + 1) };
};

/** The references of an object a unit's root rewrites when it replaces the object (its unit-owned ones). */
const REPLACED_SITES: ReadonlySet<RefSite> = new Set([
  'data',
  'material',
  'instance_collection',
  'particle_collection',
]);

/** What does not count as a use (see unusedData). */
export interface DataUses {
  /** Objects about to go: none of their references count, nor the drivers they are the targets of. */
  going?: ReadonlySet<string>;
  /** An object a unit's root replaces: its data, materials and instanced collections do not count. */
  replaced?: string;
}

/**
 * Of `candidates` ('<kind>:<id>' of datablocks that are not objects), those nothing else in the
 * document uses: no object refers to them (its data, materials, collection, instanced collections),
 * no material (an image) or collection (a parent) that is not itself unused does, no driver reads
 * them (one whose target is a candidate goes with its target), and the world does not light with
 * them (its environment image). `o` leaves out the uses of objects about to go or be replaced.
 * Candidates the document does not hold are left out.
 */
export function unusedData(doc: SceneDoc, candidates: Iterable<string>, o: DataUses = {}): Set<string> {
  const cand = new Set<string>();
  for (const key of candidates) {
    const { kind, id } = splitKey(key);
    if (kind !== 'objects' && doc.has(kind, id)) cand.add(key);
  }
  if (!cand.size) return cand;
  const going = o.going ?? new Set<string>();
  const used = new Set<string>();
  for (const id of doc.objectIds()) {
    if (going.has(id)) continue;
    const rec = doc.readRecord('objects', id);
    if (!rec) continue;
    for (const r of collectRecordRefs('objects', rec))
      if (r.kind !== 'objects' && !(id === o.replaced && REPLACED_SITES.has(r.site)))
        used.add(dataKey(r.kind, r.id));
  }
  // what each candidate refers to counts only once something used refers to the candidate
  const edges = new Map<string, string[]>();
  for (const kind of ['materials', 'collections'] as const)
    for (const id of doc.map(kind).keys()) {
      const rec = doc.readRecord(kind, id);
      if (!rec) continue;
      const refs = collectRecordRefs(kind, rec)
        .filter((r) => r.kind !== 'objects')
        .map((r) => dataKey(r.kind, r.id));
      if (cand.has(dataKey(kind, id))) edges.set(dataKey(kind, id), refs);
      else for (const r of refs) used.add(r);
    }
  for (const v of doc.map('drivers').values()) {
    const d = v as UnitRecord;
    const kind = ANIM_TARGET_KINDS[d.target_type as AnimTargetType];
    const target = typeof d.target_id === 'string' ? d.target_id : '';
    if (kind && (cand.has(dataKey(kind, target)) || (kind === 'objects' && going.has(target)))) continue;
    for (const r of collectDriverRefs(d)) if (r.kind !== 'objects') used.add(dataKey(r.kind, r.id));
  }
  const env = doc.getWorld().environment_image;
  if (env) used.add(dataKey('images', env));
  const queue = [...cand].filter((c) => used.has(c));
  while (queue.length)
    for (const r of edges.get(queue.pop()!) ?? [])
      if (!used.has(r)) {
        used.add(r);
        if (cand.has(r)) queue.push(r);
      }
  for (const key of used) cand.delete(key);
  return cand;
}

/**
 * Deletes datablocks `keys` ('<kind>:<id>', none an object, nothing referring to them: see
 * unusedData) with their animation curves and drivers. Keys the document does not hold are skipped.
 */
export function deleteData(doc: SceneDoc, keys: Iterable<string>): void {
  const list = [...keys];
  if (!list.length) return;
  doc.transact(() => {
    const byTarget = (name: 'fcurves' | 'drivers') => {
      const out = new Map<string, string[]>();
      for (const [key, v] of doc.map(name).entries()) {
        const target = String((v as { target_id?: unknown }).target_id ?? '');
        let keys = out.get(target);
        if (!keys) out.set(target, (keys = []));
        keys.push(key);
      }
      return out;
    };
    const curves = byTarget('fcurves');
    const drivers = byTarget('drivers');
    for (const key of list) {
      const { kind, id } = splitKey(key);
      if (kind === 'objects' || !doc.has(kind, id)) continue;
      if (kind === 'meshes') doc.removeMesh(id);
      else if (kind === 'images') doc.removeImage(id);
      else doc.map(kind).delete(id);
      for (const k of curves.get(id) ?? []) doc.map('fcurves').delete(k);
      for (const k of drivers.get(id) ?? []) doc.map('drivers').delete(k);
    }
  });
}

/** The datablocks (not objects) the part table of the instance with root `root` lists, as '<kind>:<id>'. */
export function instanceData(doc: SceneDoc, root: string): string[] {
  const out: string[] = [];
  for (const [pk, p] of readInstance(doc, root)?.parts ?? []) {
    const s = splitPartKey(pk);
    if (s && s.kind !== 'objects') out.push(dataKey(s.kind, p.id));
  }
  return out;
}

/**
 * Removes objects `ids` and everything below them, in one transaction (doc.removeObjects: their
 * animation, drivers and the object data no other object uses go too), and the datablocks the part
 * tables of the library unit instances among them list that nothing left in the document uses.
 */
export function removeObjectTrees(doc: SceneDoc, ids: readonly string[]): void {
  const index = doc.childrenIndex();
  const all = new Set<string>();
  const visit = (id: string) => {
    if (all.has(id)) return;
    all.add(id);
    for (const c of index.get(id) ?? []) visit(c);
  };
  for (const id of ids) if (doc.has('objects', id)) visit(id);
  if (!all.size) return;
  const data = [...all].flatMap((id) => instanceData(doc, id));
  doc.transact(() => {
    doc.removeObjects([...all]);
    if (data.length) deleteData(doc, unusedData(doc, data));
  });
}

/** An object's old look, and what stays below it (see oldLook). */
export interface OldLook {
  /** The objects of the look, which go. */
  look: string[];
  /** The tops of what stays below the object: what the person put there, cameras, other actors. */
  kept: string[];
  /** The names of the kept objects that are not cameras or actors, for a warning. */
  named: string[];
}

/**
 * The look of `root` that a new look takes the place of (insertUnit's `replace`, the way back to
 * the mannequin): an instance's own parts (the objects its part table lists), else the parts the
 * desk built for it, an actor's (desk_actor = root) or a built-in model's (store_part, below the
 * root or below such a part). Nothing else goes: what the person put on the object stays (below a
 * part that goes, it moves up with its world placement kept).
 */
export function oldLook(doc: SceneDoc, root: string): OldLook {
  const inst = readInstance(doc, root);
  const actor = doc.getObject(root)?.custom_props?.[DESK_PROPS.role] === 'actor';
  const look = new Set<string>();
  for (const [pk, p] of inst?.parts ?? [])
    if (splitPartKey(pk)?.kind === 'objects' && p.id !== root && doc.has('objects', p.id)) look.add(p.id);
  const ofLook = (o: ObjectData) =>
    inst
      ? look.has(o.id)
      : actor
        ? o.custom_props?.[DESK_PROPS.actor] === root
        : typeof o.custom_props?.[STORE_PART_PROP] === 'string';
  const index = doc.childrenIndex();
  const kept: string[] = [];
  const named: string[] = [];
  const walk = (id: string) => {
    for (const child of index.get(id) ?? []) {
      const o = doc.getObject(child);
      if (!o) continue;
      if (ofLook(o)) {
        look.add(child);
        walk(child);
        continue;
      }
      kept.push(child);
      if (namedWhenKept(o)) named.push(o.name);
    }
  };
  walk(root);
  return { look: [...look], kept, named };
}

/** Whether the warnings name an object that stays when a new look comes (cameras and actors are not named). */
export const namedWhenKept = (o: ObjectData): boolean =>
  o.type !== 'CAMERA' && o.custom_props?.[DESK_PROPS.role] !== 'actor';

/** The warning naming what stays (oldLook's `named`): "keeps 'A' and 'B', which are not part of `of`". */
export function keptWarning(named: readonly string[], of: string): string {
  const q = named.map((n) => `'${n}'`);
  const list = q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}` : q[0];
  return `keeps ${list}, which ${q.length > 1 ? 'are' : 'is'} not part of ${of}`;
}
