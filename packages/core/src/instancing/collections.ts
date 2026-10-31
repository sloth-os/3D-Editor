import type { SceneDoc } from '../doc/scene-doc';
import type { ObjectData } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import { normalizeParticleSettings, type ParticleSettings } from './settings';

/*
 * Document-level (unevaluated) collection queries used by the instancing operators.
 */

/**
 * Id of a collection reference: an id, or an exact name (stored references written by hand or by
 * generic property tools). Null when unknown. 'Scene Collection' resolves to the root.
 */
export function resolveCollectionRef(doc: SceneDoc, ref: string): string | null {
  if (!ref) return null;
  if (ref === ROOT_COLLECTION_ID || doc.getCollection(ref)) return ref;
  return doc.listCollections().find((c) => c.name === ref)?.id ?? null;
}

/** The collection an object is in and all its ancestors (innermost first, root excluded). */
export function collectionAncestry(doc: SceneDoc, cid: string): string[] {
  const out: string[] = [];
  let cur: string | null = cid;
  while (cur && cur !== ROOT_COLLECTION_ID && !out.includes(cur)) {
    out.push(cur);
    cur = doc.getCollection(cur)?.parent ?? null;
  }
  return out;
}

/**
 * Collections that are instanced, with descriptions of their users: collection instance empties
 * ("'Tree.001' (collection instance)") and particle systems ("particle system 'Grass' of 'Ground'").
 */
export function collectionUsers(doc: SceneDoc): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (ref: string | null, user: string) => {
    const cid = ref ? resolveCollectionRef(doc, ref) : null;
    if (!cid || cid === ROOT_COLLECTION_ID) return;
    const list = out.get(cid);
    if (list) list.push(user);
    else out.set(cid, [user]);
  };
  for (const o of doc.listObjects()) {
    if (o.instance_type === 'COLLECTION') add(o.instance_collection, `'${o.name}' (collection instance)`);
    for (const ps of Array.isArray(o.particle_systems) ? o.particle_systems : []) {
      if (!ps || typeof ps !== 'object') continue;
      const s = normalizeParticleSettings(ps.settings).settings;
      if (s.instance_type === 'COLLECTION') add(s.instance_collection, `particle system '${ps.name}' of '${o.name}'`);
    }
  }
  return out;
}

/** Ids of a collection and all its descendant collections (cycle safe). */
function collectionTree(doc: SceneDoc, cid: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of doc.listCollections()) {
    if (c.id === ROOT_COLLECTION_ID) continue;
    const parent = c.parent ?? ROOT_COLLECTION_ID;
    const list = children.get(parent);
    if (list) list.push(c.id);
    else children.set(parent, [c.id]);
  }
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const c of children.get(id) ?? []) visit(c);
  };
  visit(cid);
  return out;
}

/** Objects of a collection including its child collections (sorted by name). */
export function collectionMembers(doc: SceneDoc, cid: string): ObjectData[] {
  const tree = collectionTree(doc, cid);
  return doc.listObjects().filter((o) => tree.has(o.collection));
}

/** True when the object is in the collection or one of its child collections. */
export function collectionContainsObject(doc: SceneDoc, cid: string, objectId: string): boolean {
  const o = doc.getObject(objectId);
  return !!o && collectionTree(doc, cid).has(o.collection);
}

type InstanceNode = { kind: 'collection' | 'object'; id: string };

/**
 * True when `target` is among the objects instanced from `start`: members of the collections, and
 * (recursively) whatever those objects instance (collection instances, particle instance objects
 * and collections). References are resolved by id or exact name.
 */
function instancesObject(doc: SceneDoc, start: InstanceNode[], target: string): boolean {
  const seenCollections = new Set<string>();
  const seenObjects = new Set<string>();
  const stack = start.slice();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.kind === 'collection') {
      const cid = resolveCollectionRef(doc, cur.id);
      if (!cid || cid === ROOT_COLLECTION_ID || seenCollections.has(cid)) continue;
      seenCollections.add(cid);
      for (const o of collectionMembers(doc, cid)) stack.push({ kind: 'object', id: o.id });
      continue;
    }
    const o = doc.resolveObject(cur.id);
    if (!o) continue;
    if (o.id === target) return true;
    if (seenObjects.has(o.id)) continue;
    seenObjects.add(o.id);
    if (o.instance_type === 'COLLECTION' && o.instance_collection)
      stack.push({ kind: 'collection', id: o.instance_collection });
    for (const ps of Array.isArray(o.particle_systems) ? o.particle_systems : []) {
      if (!ps || typeof ps !== 'object') continue;
      const s = normalizeParticleSettings(ps.settings).settings;
      if (s.instance_type === 'OBJECT' && s.instance_object && s.instance_object !== o.id)
        stack.push({ kind: 'object', id: s.instance_object });
      else if (s.instance_type === 'COLLECTION' && s.instance_collection)
        stack.push({ kind: 'collection', id: s.instance_collection });
    }
  }
  return false;
}

/**
 * True when letting `objectId` instance collection `cid` would make the object (indirectly)
 * instance itself: the collection, or anything instanced from it (nested collection instances,
 * particle instance objects and collections), contains the object.
 */
export function wouldCreateInstanceCycle(doc: SceneDoc, objectId: string, cid: string): boolean {
  return instancesObject(doc, [{ kind: 'collection', id: cid }], objectId);
}

/**
 * True when a particle system with settings `s` on `emitterId` would make the emitter instance
 * itself through its instance object or collection (also through nested collection instances and
 * particle systems). The emitter as a direct member of its own instance collection is not a cycle:
 * a particle system never instances its own emitter.
 */
export function particleSourceCycle(
  doc: SceneDoc,
  emitterId: string,
  s: Pick<ParticleSettings, 'instance_type' | 'instance_object' | 'instance_collection'>,
): boolean {
  if (s.instance_type === 'OBJECT' && s.instance_object)
    return instancesObject(doc, [{ kind: 'object', id: s.instance_object }], emitterId);
  if (s.instance_type === 'COLLECTION' && s.instance_collection) {
    const cid = resolveCollectionRef(doc, s.instance_collection);
    if (!cid || cid === ROOT_COLLECTION_ID) return false;
    const start: InstanceNode[] = collectionMembers(doc, cid)
      .filter((o) => o.id !== emitterId)
      .map((o) => ({ kind: 'object', id: o.id }));
    return instancesObject(doc, start, emitterId);
  }
  return false;
}
