import type { SceneDoc } from '../doc/scene-doc';
import type { ObjectData } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import { normalizeParticleSettings } from './settings';

/*
 * Document-level (unevaluated) collection queries used by the instancing operators.
 */

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

/**
 * True when letting `objectId` instance collection `cid` would make the object (indirectly)
 * instance itself: the collection, or anything instanced from it (nested collection instances,
 * particle instance objects and collections), contains the object.
 */
export function wouldCreateInstanceCycle(doc: SceneDoc, objectId: string, cid: string): boolean {
  const seenCollections = new Set<string>();
  const seenObjects = new Set<string>();
  const stack: { kind: 'collection' | 'object'; id: string }[] = [{ kind: 'collection', id: cid }];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.kind === 'collection') {
      if (seenCollections.has(cur.id)) continue;
      seenCollections.add(cur.id);
      for (const o of collectionMembers(doc, cur.id)) stack.push({ kind: 'object', id: o.id });
      continue;
    }
    if (cur.id === objectId) return true;
    if (seenObjects.has(cur.id)) continue;
    seenObjects.add(cur.id);
    const o = doc.getObject(cur.id);
    if (!o) continue;
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
