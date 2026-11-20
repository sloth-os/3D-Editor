import type { SceneDoc } from '../../doc/scene-doc';
import type { AnimTargetType, DatablockKind, FCurve, ObjectData } from '../../doc/types';
import { identity4, invert4, multiply4 } from '../../math/mat4';
import type { Mat4 } from '../../math/types';
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
 * object stays, and the caller names it in a warning. So does what the person put below a look that
 * goes with its root (another set or prop in the slot, the words' set or prop again): taken out
 * around it (removeObjectTrees' `keep`), it is hung from what takes the look's place where it was in
 * the world (hangKept), its keyed motion kept where the change of parent allows it (keepMotion).
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
 * `keep`: objects below them that stay, each with everything below it: they move up to the parent of
 * what goes, where they are in the world (doc.removeObjects), for the caller to hang (hangKept).
 */
export function removeObjectTrees(doc: SceneDoc, ids: readonly string[], keep: readonly string[] = []): void {
  const index = doc.childrenIndex();
  const keeping = new Set(keep);
  const all = new Set<string>();
  const visit = (id: string) => {
    if (all.has(id)) return;
    all.add(id);
    for (const c of index.get(id) ?? []) if (!keeping.has(c)) visit(c);
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

/** Names quoted and listed: "'A'", "'A' and 'B'", "'A', 'B' and 'C'". */
function quoted(names: readonly string[]): string {
  const q = names.map((n) => `'${n}'`);
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}` : q[0];
}

/** The warning naming what stays (oldLook's `named`): "keeps 'A' and 'B', which are not part of `of`". */
export function keptWarning(named: readonly string[], of: string): string {
  return `keeps ${quoted(named)}, which ${named.length > 1 ? 'are' : 'is'} not part of ${of}`;
}

/** Where the objects that stay below a look that goes were before it went (keptPlaces). */
export interface KeptPlaces {
  /** The objects that stay, each with everything below it (the tops of what stays). */
  ids: readonly string[];
  /** Each one's stored world matrix before anything went. */
  worlds: ReadonlyMap<string, Mat4>;
  /** Its parent's stored world matrix then (null: it had none). */
  parentWorlds: ReadonlyMap<string, Mat4 | null>;
}

/**
 * Where objects `ids` are, read before what is above them goes (see KeptPlaces); ids the scene does
 * not hold are left out.
 */
export function keptPlaces(doc: SceneDoc, ids: Iterable<string>): KeptPlaces {
  const list: string[] = [];
  const worlds = new Map<string, Mat4>();
  const parentWorlds = new Map<string, Mat4 | null>();
  for (const id of ids) {
    const o = doc.getObject(id);
    if (!o || worlds.has(id)) continue;
    list.push(id);
    worlds.set(id, doc.worldMatrix(id));
    parentWorlds.set(id, o.parent && doc.has('objects', o.parent) ? doc.worldMatrix(o.parent) : null);
  }
  return { ids: list, worlds, parentWorlds };
}

/** Whether world matrix `a` is `b` to rounding (1e-9 of the largest entry, or of 1). */
export function sameWorld(a: Readonly<Mat4>, b: Readonly<Mat4>): boolean {
  const tol = 1e-9 * Math.max(1, ...b.map(Math.abs));
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

/** How hangKept's warnings name the look that went and what takes its place. */
export interface KeptWords {
  /** What the objects that stay are not part of (keptWarning's `of`): "the look the library prop replaces". */
  of: string;
  /** What they hang from: "the library prop's root". */
  on: string;
}

/**
 * Hangs the objects of `kept` (left where taking out what was above them put them) from `root` where
 * they were in the world, in the caller's transaction, and returns the warnings naming them (cameras
 * and actors are not named: namedWhenKept). One that the root's scale would change there (a root
 * scaled unevenly shears an object turned under it, which no channels hold) goes back under its
 * parent of the moment, where it was in the world, and a warning says so. The keyed motion of each
 * stays where it was when its change of parent allows it (keepMotion); a warning names one whose
 * keyed motion now follows its new parent instead, a camera or an actor too (what the shots show
 * changes).
 */
export function hangKept(doc: SceneDoc, root: string, kept: KeptPlaces, words: KeptWords): string[] {
  const named: string[] = [];
  const stayed: string[] = [];
  // the named objects whose keyed motion now follows their new parent, by that parent (null: none)
  const moved = new Map<string | null, string[]>();
  const rootWorld = doc.worldMatrix(root);
  for (const id of kept.ids) {
    const o = doc.getObject(id);
    if (!o || doc.isAncestor(id, root)) continue;
    const world = kept.worlds.get(id)!;
    const was = o.parent;
    let parent: string | null = root;
    doc.setParent(id, root, true, { world, parentWorld: rootWorld });
    if (!sameWorld(doc.worldMatrix(id), world)) {
      parent = was;
      doc.setParent(id, was, true, { world, parentWorld: was ? doc.worldMatrix(was) : null });
      stayed.push(o.name);
    }
    const from = kept.parentWorlds.get(id) ?? null;
    const motion = keepMotion(doc, id, world, from, parent ? doc.worldMatrix(parent) : null);
    if (motion === 'changed') moved.set(parent, [...(moved.get(parent) ?? []), o.name]);
    if (namedWhenKept(o)) named.push(o.name);
  }
  const out: string[] = [];
  if (named.length) out.push(keptWarning(named, words.of));
  if (stayed.length)
    out.push(
      stayed.length > 1
        ? `${quoted(stayed)} stay where they were, not on ${words.on}: its scale would change them there`
        : `${quoted(stayed)} stays where it was, not on ${words.on}: its scale would change it there`,
    );
  for (const [parent, names] of moved) {
    const where =
      parent === root ? words.on : parent ? `'${doc.getObject(parent)?.name ?? parent}'` : 'the scene';
    out.push(
      names.length > 1
        ? `${quoted(names)} are animated: their keyed motion now follows ${where}`
        : `${quoted(names)} is animated: its keyed motion now follows ${where}`,
    );
  }
  return out;
}

/** The transform channels of an object that F-curves key and drivers set (its rotation is Euler). */
const TRANSFORM_PATHS: ReadonlySet<string> = new Set(['location', 'rotation_euler', 'scale']);

/** The value modifiers an F-curve's keys cannot be mapped through (all but STEPPED, which bends time only). */
const changesValues = (fc: FCurve): boolean =>
  (fc.modifiers ?? []).some((m) => !m.mute && m.type !== 'STEPPED');

/**
 * Keeps the keyed motion of object `id`, which stood at `world` under a parent whose world matrix
 * was `from` and now hangs, its world placement kept, from one whose world matrix is `to` (null: no
 * parent; every matrix the stored one): its transform channels are keyed in its parent's space, so
 * its keys follow the new parent unless they are rewritten. A change of parent that moves and scales
 * along the parent's axes (no turn) is undone in its keys, in the caller's transaction, so that it
 * moves in the world as it did: location keys v become d + s·v on each axis (d the move, s the
 * scale), scale keys are scaled as its own axes see that scale, rotation keys stay. A scale uneven
 * across the axes leaves keyed rotations nothing to map to (the object would shear as it turns), and
 * keys under a modifier that changes values (all but STEPPED) or channels a driver sets cannot be
 * mapped either: then no key is rewritten. Returns 'still' (no keyed or driven transform channel),
 * 'kept' (its motion is where it was) or 'changed' (its keyed motion now follows the new parent).
 */
export function keepMotion(
  doc: SceneDoc,
  id: string,
  world: Readonly<Mat4>,
  from: Readonly<Mat4> | null,
  to: Readonly<Mat4> | null,
): 'still' | 'kept' | 'changed' {
  const curves = doc
    .listFCurves(id)
    .filter((fc) => fc.target_type === 'object' && TRANSFORM_PATHS.has(fc.path));
  const driven = doc
    .listDrivers(id)
    .some((d) => d.target_type === 'object' && TRANSFORM_PATHS.has(d.path) && !d.mute);
  if (!curves.length && !driven) return 'still';
  // the object's local matrix L under the old parent becomes change · L under the new one
  const change = multiply4(invert4(to ?? identity4()), from ?? identity4());
  if (sameWorld(change, identity4())) return 'kept';
  if (driven) return 'changed';
  const tol = 1e-9 * Math.max(1, ...change.map(Math.abs));
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) if (r !== c && Math.abs(change[c * 4 + r]) > tol) return 'changed';
  const scale = [change[0], change[5], change[10]];
  if (!scale.every((v) => v > tol)) return 'changed';
  const uniform = Math.abs(scale[0] - scale[1]) <= tol && Math.abs(scale[0] - scale[2]) <= tol;
  const keyed = (path: string) => curves.some((fc) => fc.path === path);
  if (!uniform && keyed('rotation_euler')) return 'changed';
  // the scale its own axes see: its rotation R under the old parent, Rᵀ·diag(scale)·R (diagonal when
  // its axes are the parent's in some order, as they are when it hangs unsheared)
  let own = scale;
  if (!uniform && keyed('scale')) {
    const local = multiply4(invert4(from ?? identity4()), world);
    const axes = [0, 1, 2].map((c) => {
      const v = [local[c * 4], local[c * 4 + 1], local[c * 4 + 2]];
      const n = Math.hypot(v[0], v[1], v[2]) || 1;
      return v.map((x) => x / n);
    });
    const seen = (i: number, j: number) => axes[i].reduce((sum, v, k) => sum + v * scale[k] * axes[j][k], 0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) if (i !== j && Math.abs(seen(i, j)) > tol) return 'changed';
    own = [seen(0, 0), seen(1, 1), seen(2, 2)];
  }
  const rewritten: FCurve[] = [];
  for (const fc of curves) {
    if (fc.path === 'rotation_euler' || !(fc.index >= 0 && fc.index < 3)) continue;
    const add = fc.path === 'location' ? change[12 + fc.index] : 0;
    const times = (fc.path === 'location' ? scale : own)[fc.index];
    if (Math.abs(add) <= tol && Math.abs(times - 1) <= tol) continue;
    if (changesValues(fc)) return 'changed';
    rewritten.push({ ...fc, keyframes: fc.keyframes.map((k) => ({ ...k, value: add + times * k.value })) });
  }
  for (const fc of rewritten) doc.setFCurve(fc);
  return 'kept';
}
