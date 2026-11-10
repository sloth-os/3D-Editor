import type { ObjectData } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { MAX_INSTANCES, normalizeParticleSettings } from '../instancing/settings';
import { MAX_INSTANCE_DEPTH } from '../instancing/expand';

/*
 * How many particle and collection instances an evaluation of a scene makes, and how many faces they
 * hold, counted from the document without evaluating it (operators/memory.ts: the exports run in the
 * server's process write every instance as a mesh of its own). An upper bound of what
 * instancing/expand.ts expands: every particle of a system (GRID: every cell of its lattice), every
 * member of an instanced collection, nested instancers to MAX_INSTANCE_DEPTH levels, and at most
 * MAX_INSTANCES instances in all, those with the most faces first.
 */

/** Faces of one instance → how many such instances (each count at most MAX_INSTANCES). */
type Tally = Map<number, number>;

function add(t: Tally, faces: number, count: number): void {
  if (!(count > 0)) return;
  t.set(faces, Math.min(MAX_INSTANCES, (t.get(faces) ?? 0) + count));
}

function merge(into: Tally, from: Tally, times = 1): void {
  for (const [faces, count] of from) add(into, faces, count * times);
}

function total(t: Tally): number {
  let faces = 0;
  for (const [f, c] of t) faces += f * c;
  return faces;
}

/** Instances and their faces, at most. */
export interface InstanceBound {
  instances: number;
  faces: number;
}

/**
 * The instances objects `owners` generate in an evaluation (render settings with `forRender`, the
 * viewport's otherwise) and their faces, at most; `facesOf` gives the faces of one object's
 * evaluated geometry (0 for objects without any).
 */
export function instanceBound(
  doc: SceneDoc,
  owners: readonly ObjectData[],
  opts: { forRender: boolean; facesOf: (o: ObjectData) => number },
): InstanceBound {
  const objects = doc.listObjects();
  const byId = new Map(objects.map((o) => [o.id, o]));
  const byName = new Map<string, ObjectData>();
  for (const o of objects) if (!byName.has(o.name)) byName.set(o.name, o);
  const objectRef = (ref: string | null | undefined) =>
    ref ? (byId.get(ref) ?? byName.get(ref)) : undefined;
  const collections = doc.listCollections();
  const collectionIds = new Set(collections.map((c) => c.id));
  const collectionNames = new Map<string, string>();
  for (const c of collections) if (!collectionNames.has(c.name)) collectionNames.set(c.name, c.id);
  const collectionRef = (ref: string | null | undefined): string | null => {
    if (!ref || ref === ROOT_COLLECTION_ID) return null;
    return collectionIds.has(ref) ? ref : (collectionNames.get(ref) ?? null);
  };
  const children = new Map<string, string[]>();
  for (const c of collections) {
    if (c.id === ROOT_COLLECTION_ID) continue;
    const parent = c.parent ?? ROOT_COLLECTION_ID;
    children.set(parent, [...(children.get(parent) ?? []), c.id]);
  }
  const inCollection = new Map<string, ObjectData[]>();
  for (const o of objects) inCollection.set(o.collection, [...(inCollection.get(o.collection) ?? []), o]);
  const memberMemo = new Map<string, ObjectData[]>();
  /** Objects of a collection and its child collections. */
  const members = (cid: string): ObjectData[] => {
    let hit = memberMemo.get(cid);
    if (hit) return hit;
    hit = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      hit!.push(...(inCollection.get(id) ?? []));
      for (const c of children.get(id) ?? []) visit(c);
    };
    visit(cid);
    memberMemo.set(cid, hit);
    return hit;
  };
  const facesMemo = new Map<string, number>();
  const facesOf = (o: ObjectData): number => {
    let f = facesMemo.get(o.id);
    if (f === undefined) facesMemo.set(o.id, (f = Math.max(0, opts.facesOf(o))));
    return f;
  };
  const shown = (ps: { show_render?: boolean; show_viewport?: boolean }) =>
    opts.forRender ? ps.show_render !== false : ps.show_viewport !== false;

  const memo = new Map<string, Tally>();
  const stack = new Set<string>();
  /** What one instance of `o` brings: itself (when it has geometry) and what it instances. */
  const oneInstance = (o: ObjectData, depth: number): Tally => {
    const t: Tally = new Map();
    const faces = facesOf(o);
    if (faces > 0 || o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT') add(t, faces, 1);
    if (depth < MAX_INSTANCE_DEPTH) merge(t, instancesOf(o, depth + 1));
    return t;
  };
  /** The instances `o` generates. */
  const instancesOf = (o: ObjectData, depth: number): Tally => {
    const key = `${o.id}|${depth}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const t: Tally = new Map();
    if (stack.has(o.id)) return t; // an instancing cycle: expand.ts skips it
    stack.add(o.id);
    try {
      if (o.type === 'EMPTY' && o.instance_type === 'COLLECTION') {
        const cid = collectionRef(o.instance_collection);
        if (cid) for (const m of members(cid)) if (m.id !== o.id) merge(t, oneInstance(m, depth));
      }
      const emitter = o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT';
      for (const ps of Array.isArray(o.particle_systems) ? o.particle_systems : []) {
        if (!emitter || !ps || typeof ps !== 'object' || !shown(ps)) continue;
        const s = normalizeParticleSettings(ps.settings).settings;
        if (s.instance_type === 'NONE') continue;
        // GRID places one particle per lattice cell crossed (at most its resolution cubed)
        const n = Math.min(MAX_INSTANCES, s.distribution === 'GRID' ? s.grid_resolution ** 3 : s.count);
        if (s.instance_type === 'OBJECT') {
          const src = objectRef(s.instance_object);
          if (src) merge(t, oneInstance(src, depth), n);
          continue;
        }
        const cid = collectionRef(s.instance_collection);
        const sources = cid ? members(cid).filter((m) => m.id !== o.id) : [];
        if (s.use_whole_collection) {
          const per: Tally = new Map();
          for (const m of sources) merge(per, oneInstance(m, depth));
          merge(t, per, n);
        } else {
          // one object per particle: the one with the most faces, at most
          let best: Tally | null = null;
          for (const m of sources) {
            const one = oneInstance(m, depth);
            if (!best || total(one) > total(best)) best = one;
          }
          if (best) merge(t, best, n);
        }
      }
    } finally {
      stack.delete(o.id);
    }
    memo.set(key, t);
    return t;
  };

  const all: Tally = new Map();
  for (const o of owners) merge(all, instancesOf(o, 1));
  // at most MAX_INSTANCES instances per evaluation: those with the most faces first
  let instances = 0;
  let faces = 0;
  for (const [f, c] of [...all].sort((a, b) => b[0] - a[0])) {
    const take = Math.min(c, MAX_INSTANCES - instances);
    if (take <= 0) break;
    instances += take;
    faces += f * take;
  }
  return { instances, faces };
}
