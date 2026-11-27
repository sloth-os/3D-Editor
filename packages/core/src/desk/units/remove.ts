import { boneRestMatrix } from '../../armature/bone-math';
import type { SceneDoc } from '../../doc/scene-doc';
import type { AnimTargetType, DatablockKind, FCurve, ObjectData } from '../../doc/types';
import { identity4, invert4, multiply4, translation4 } from '../../math/mat4';
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
 * object stays, and the caller names it in a warning. So does what the person put below a piece that
 * goes with its root (another set or prop in the slot, the words' set or prop again, a words' prop or
 * landmark built anew or dropped, an actor or a shot's camera the brief drops): taken out around it
 * (removeObjectTrees' `keep`, removeKeeping), it is hung from what takes the piece's place, or from
 * the set's ground when nothing does, where it was in the world at rest (hangKept), its keyed motion
 * kept where the change of parent allows it (keepMotion); one that followed the animation of a piece
 * that went (its keys, drivers, constraints, physics or bones) is named, as it no longer does.
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
    }
  };
  walk(root);
  return { look: [...look], kept };
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

/**
 * The matrix bone `bone` of armature object `arm` gives what hangs from it, in the armature's space
 * and rest position: its tail (FrameState places a bone's children there). Null: no such bone.
 */
function restBoneTail(doc: SceneDoc, arm: ObjectData, bone: string): Mat4 | null {
  if (arm.type !== 'ARMATURE' || !arm.data || !bone) return null;
  const bones = doc.getArmature(arm.data)?.bones ?? [];
  const b = bones.find((x) => x.name === bone);
  if (!b) return null;
  const up = b.use_connect && b.parent ? bones.find((x) => x.name === b.parent) : undefined;
  const { matrix, length } = boneRestMatrix(up ? up.tail : b.head, b.tail, b.roll);
  return multiply4(matrix, translation4([0, length, 0]));
}

/**
 * Where object `id` stands at rest: its stored transform below its parents' (doc.worldMatrix), an
 * object that hangs from a bone placed at the bone's tail in the armature's rest position (which
 * doc.worldMatrix, knowing nothing of bones, leaves out). Identity for an object the scene does not
 * hold.
 */
export function restWorld(doc: SceneDoc, id: string): Mat4 {
  const chain: ObjectData[] = [];
  const seen = new Set<string>();
  for (let o = doc.getObject(id); o && !seen.has(o.id); o = o.parent ? doc.getObject(o.parent) : null) {
    seen.add(o.id);
    chain.unshift(o);
  }
  let m = identity4();
  chain.forEach((o, i) => {
    const tail = i > 0 && o.parent_type === 'BONE' ? restBoneTail(doc, chain[i - 1], o.parent_bone) : null;
    if (tail) m = multiply4(m, tail);
    m = multiply4(m, doc.localMatrix(o));
  });
  return m;
}

/** The matrix object `o` hangs from at rest (see restWorld): its parent's, at the bone's tail for a bone parent; null without one. */
export function restParentWorld(doc: SceneDoc, o: ObjectData): Mat4 | null {
  const p = o.parent && o.parent !== o.id ? doc.getObject(o.parent) : null;
  if (!p) return null;
  const m = restWorld(doc, p.id);
  const tail = o.parent_type === 'BONE' ? restBoneTail(doc, p, o.parent_bone) : null;
  return tail ? multiply4(m, tail) : m;
}

/**
 * An object above one that stays which moves on its own (moversOf): what moves it, without ids, so
 * that two objects that move alike compare equal.
 */
export interface Mover {
  id: string;
  name: string;
  /** Its own transform keyed, driven, constrained or simulated (null: still). */
  own: string | null;
  /** Its bones keyed, driven or constrained, where the object below hangs from one (null: still or not by a bone). */
  pose: string | null;
}

/** The transform channels of an object that F-curves key and drivers set (its rotation is Euler). */
const TRANSFORM_PATHS: ReadonlySet<string> = new Set(['location', 'rotation_euler', 'scale']);
/** The channels of an armature's pose bones (`pose.bones["Bone"].…`). */
const POSE_PATH = /^pose\.bones\[/;

/** What moves `x` by the channels `moves` picks (its keys, drivers and `also`), as a string; null when nothing does. */
function motionOf(
  doc: SceneDoc,
  x: ObjectData,
  moves: (path: string) => boolean,
  also: unknown[],
): string | null {
  const curves = doc
    .listFCurves(x.id)
    .filter((fc) => fc.target_type === 'object' && !fc.mute && moves(fc.path))
    .map((fc) => [fc.path, fc.index, fc.keyframes, fc.extrapolation, fc.modifiers ?? []] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const drivers = doc
    .listDrivers(x.id)
    .filter((d) => d.target_type === 'object' && !d.mute && moves(d.path))
    .map((d) => [d.path, d.index, d.expression, d.variables] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return curves.length || drivers.length || also.length ? JSON.stringify([curves, drivers, also]) : null;
}

/** A constraint as it moves what it is on (its id, name and panel state left out). */
const constraintOf = (c: ObjectData['constraints'][number]) => [
  c.type,
  c.influence,
  c.target,
  c.subtarget,
  c.params,
];

/**
 * The objects above object `id`, nearest first, that move on their own (its parent, its parent's
 * parent …): those with keyed, driven or constrained transforms or an active rigid body, and an
 * armature the object below hangs from by a bone whose bones are keyed, driven or constrained.
 */
export function moversOf(doc: SceneDoc, id: string): Mover[] {
  const out: Mover[] = [];
  const seen = new Set<string>([id]);
  for (let child = doc.getObject(id); child?.parent && !seen.has(child.parent);) {
    const p = doc.getObject(child.parent);
    if (!p) break;
    seen.add(p.id);
    const body = p.rigid_body?.enabled && p.rigid_body.type === 'ACTIVE' ? [p.rigid_body] : [];
    const constraints = (p.constraints ?? []).filter((c) => !c.mute).map(constraintOf);
    const own = motionOf(doc, p, (path) => TRANSFORM_PATHS.has(path), [...constraints, ...body]);
    const bones =
      child.parent_type === 'BONE' && p.type === 'ARMATURE'
        ? Object.entries(p.pose?.bones ?? {})
            .flatMap(([name, b]) =>
              (b.constraints ?? []).filter((c) => !c.mute).map((c) => [name, constraintOf(c)]),
            )
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        : null;
    const pose = bones ? motionOf(doc, p, (path) => POSE_PATH.test(path), bones) : null;
    if (own !== null || pose !== null) out.push({ id: p.id, name: p.name, own, pose });
    child = p;
  }
  return out;
}

/** Where the objects that stay below a piece that goes were before it went (keptPlaces). */
export interface KeptPlaces {
  /** The objects that stay, each with everything below it (the tops of what stays). */
  ids: readonly string[];
  /** Each one's world matrix at rest (restWorld) before anything went. */
  worlds: ReadonlyMap<string, Mat4>;
  /** The matrix it hung from at rest then (restParentWorld; null: it had no parent). */
  parentWorlds: ReadonlyMap<string, Mat4 | null>;
  /** The objects above it then that moved on their own (moversOf), nearest first. */
  movers: ReadonlyMap<string, readonly Mover[]>;
  /**
   * The bone it followed through the pieces that go, when one did: the last bone link up its chain
   * to the object that stays above them (a hat on a mannequin's head, the head hung from the
   * actor's 'head' bone), by the object whose bone it is (`of`: that object, or one of `tops`).
   */
  bones: ReadonlyMap<string, { of: string; bone: string }>;
  /** The pieces taken out above them (removeKeeping's `ids`, insertUnit's `remove`, an old look's parts). */
  tops: ReadonlySet<string>;
}

/**
 * Where objects `ids` are, read before what is above them goes (see KeptPlaces): below the pieces
 * `tops` that go; ids the scene does not hold are left out.
 */
export function keptPlaces(doc: SceneDoc, ids: Iterable<string>, tops: Iterable<string> = []): KeptPlaces {
  const list: string[] = [];
  const worlds = new Map<string, Mat4>();
  const parentWorlds = new Map<string, Mat4 | null>();
  const movers = new Map<string, Mover[]>();
  const bones = new Map<string, { of: string; bone: string }>();
  const topSet = new Set(tops);
  for (const id of ids) {
    const o = doc.getObject(id);
    if (!o || worlds.has(id)) continue;
    list.push(id);
    worlds.set(id, restWorld(doc, id));
    parentWorlds.set(id, restParentWorld(doc, o));
    movers.set(id, moversOf(doc, id));
    // up its chain to the first piece that goes, and that piece's own link to what stays above it
    const seen = new Set<string>([id]);
    let link: { of: string; bone: string } | null = null;
    for (let x: ObjectData | null = o; x?.parent && !seen.has(x.parent);) {
      if (x.parent_type === 'BONE' && x.parent_bone) link = { of: x.parent, bone: x.parent_bone };
      if (topSet.has(x.id)) break;
      seen.add(x.parent);
      x = doc.getObject(x.parent);
    }
    if (link) bones.set(id, link);
  }
  return { ids: list, worlds, parentWorlds, movers, bones, tops: topSet };
}

/**
 * Takes objects `ids` (desk pieces: a prop or a landmark built anew or dropped, an actor or a shot's
 * camera that goes) out with everything below them but what stays below each (oldLook's `kept`: what
 * the person put there, cameras, actors), in the caller's transaction, and returns where what stays
 * was (keptPlaces), for the caller to hang (hangKept) once what takes their place is there.
 */
export function removeKeeping(doc: SceneDoc, ids: readonly string[]): KeptPlaces {
  const present = ids.filter((id) => doc.has('objects', id));
  const kept = keptPlaces(
    doc,
    present.flatMap((id) => oldLook(doc, id).kept),
    present,
  );
  removeObjectTrees(doc, present, kept.ids);
  return kept;
}

/** Whether world matrix `a` is `b` to rounding (1e-9 of the largest entry, or of 1). */
export function sameWorld(a: Readonly<Mat4>, b: Readonly<Mat4>): boolean {
  const tol = 1e-9 * Math.max(1, ...b.map(Math.abs));
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

/** How hangKept's warnings name the piece that went and what takes its place. */
export interface KeptWords {
  /** What the objects that stay are not part of (keptWarning's `of`): "the look the library prop replaces". */
  of: string;
  /** What they hang from: "the library prop's root". */
  on: string;
  /**
   * The piece that went with nothing in its place ("'pond'"): the warning says it goes and what stays
   * where it is (on `on`) instead of what it is not part of.
   */
  gone?: string;
  /**
   * The staging moves what takes the place of the pieces that went (`kept.tops`) as it moved them (a
   * prop held, flown or hidden again, an actor on its marks): what stays follows it, so the pieces'
   * own motion is not lost, nor their bones' for what hangs from the same bone of it.
   */
  restaged?: boolean;
  /**
   * What stays is not named as kept: the caller's own warning names it, or nothing changed for it (a
   * piece built again as it was). Only what changes for it (where it hangs, its motion) is named.
   */
  listed?: boolean;
  /**
   * Objects of `kept` hung like the rest whose warnings wait: the caller may take them out after, its
   * own warning naming what goes (the string and tail of a flight, which rideo/import.ts dropTether
   * takes out naming what the person put on them). Their warnings go to `later`, for the caller to
   * write once it knows which are still there (laterWarnings); with no `later` none names them (the
   * caller takes them out right after).
   */
  unnamed?: ReadonlySet<string>;
  /** Where the warnings naming `unnamed` objects wait (see LaterWarning). */
  later?: LaterWarning[];
}

/**
 * A warning a step holds back (KeptWords' `later`): it names objects that a later step of the same
 * update may still take out, and is written once the update knows which of them are still there
 * (laterWarnings).
 */
export interface LaterWarning {
  /** The objects it names, and their names in the same order. */
  ids: string[];
  names: string[];
  /** The warning naming `names`, or the ones of them still there. */
  say: (names: readonly string[]) => string;
}

/** The warnings of `later` that still name an object in the scene, naming only those. */
export function laterWarnings(doc: SceneDoc, later: readonly LaterWarning[]): string[] {
  const out: string[] = [];
  for (const w of later) {
    const names = w.names.filter((_, i) => doc.has('objects', w.ids[i]));
    if (names.length) out.push(w.say(names));
  }
  return out;
}

/** "'A' is …" / "'A' and 'B' are …": `one` or `many` after the names. */
const namesWith = (names: readonly string[], one: string, many: string): string =>
  `${quoted(names)} ${names.length > 1 ? many : one}`;

/**
 * Hangs the objects of `kept` (left where taking out what was above them put them) from `root` (null:
 * the scene) where they were in the world at rest, in the caller's transaction, and returns the
 * warnings naming them (cameras and actors are not named: namedWhenKept; `listed`: the caller names
 * them; `unnamed`: the caller takes them out right after). One that followed a bone through the
 * pieces that went (KeptPlaces' `bones`: a hat on a mannequin's head) hangs from that bone of the
 * root when the root is the armature it was or takes its place and still has the bone, and so
 * follows it as before. One that the root's scale would change there (a root scaled unevenly shears
 * an object turned under it, which no channels hold) goes back under its parent of the moment,
 * where it was in the world, and a warning says so; one already sheared (turned below a piece
 * scaled unevenly that went), which neither parent holds as it is, hangs from the root with its
 * origin where it was, and a warning says it changes shape. The keyed motion of each stays where it
 * was when its change of parent allows it (keepMotion); a warning names one whose keyed motion now
 * follows its new parent instead, and one that followed the animation of an object that went above
 * it (moversOf: its parent or a part above it keyed, driven, constrained, simulated or posed by
 * keys) and that nothing above it now moves alike (see KeptWords' `restaged`): it keeps its place
 * at rest, but no longer moves with it. Cameras and actors are named in those two (what the shots
 * show changes).
 */
export function hangKept(doc: SceneDoc, root: string | null, kept: KeptPlaces, words: KeptWords): string[] {
  // what each warning names: the objects named now, and the `unnamed` ones, whose warning waits
  type Named = { now: { ids: string[]; names: string[] }; held: { ids: string[]; names: string[] } };
  const group = (): Named => ({ now: { ids: [], names: [] }, held: { ids: [], names: [] } });
  const add = (g: Named, quiet: boolean, o: ObjectData) => {
    const to = quiet ? g.held : g.now;
    to.ids.push(o.id);
    to.names.push(o.name);
  };
  const named = group();
  const stayed = group();
  const unskewed = group();
  // the objects whose keyed motion now follows their new parent, by that parent (null: none)
  const moved = new Map<string | null, Named>();
  // the objects that no longer follow the animation of an object above them, by its name
  const lost = new Map<string, Named>();
  const rootObj = root ? doc.getObject(root) : null;
  const rootWorld = root ? restWorld(doc, root) : null;
  // the bone of the root an object follows through the pieces that went, when the root has it
  const boneOf = (id: string): { bone: string; world: Mat4 } | null => {
    const link = kept.bones.get(id);
    if (!rootObj || !rootWorld || !link || (link.of !== root && !kept.tops.has(link.of))) return null;
    const tail = restBoneTail(doc, rootObj, link.bone);
    return tail ? { bone: link.bone, world: multiply4(rootWorld, tail) } : null;
  };
  for (const id of kept.ids) {
    const o = doc.getObject(id);
    if (!o || (root && doc.isAncestor(id, root))) continue;
    // hung like the rest, but the warnings naming it wait (the caller may take it out after)
    const quiet = words.unnamed?.has(id) ?? false;
    const world = kept.worlds.get(id)!;
    const was = o.parent;
    let parent: string | null = root;
    const bone = boneOf(id);
    if (bone) {
      doc.updateObject(id, { parent: root, parent_type: 'BONE', parent_bone: bone.bone });
      doc.setWorldMatrix(id, world, bone.world);
    } else doc.setParent(id, root, true, { world, parentWorld: rootWorld });
    let onBone = !!bone;
    if (!sameWorld(restWorld(doc, id), world)) {
      onBone = false;
      doc.setParent(id, was, true, { world, parentWorld: was ? restWorld(doc, was) : null });
      if (sameWorld(restWorld(doc, id), world)) {
        parent = was;
        add(stayed, quiet, o);
      } else {
        // skewed in the world (turned below a piece scaled unevenly), which neither parent holds as it
        // is: it hangs from the root where its channels come closest (its origin where it was)
        doc.setParent(id, root, true, { world, parentWorld: rootWorld });
        add(unskewed, quiet, o);
      }
    }
    const from = kept.parentWorlds.get(id) ?? null;
    const motion = keepMotion(doc, id, world, from, restParentWorld(doc, doc.getObject(id)!));
    if (motion === 'changed') {
      const g = moved.get(parent) ?? group();
      moved.set(parent, g);
      add(g, quiet, o);
    }
    const gone = lostMover(
      kept.movers.get(id) ?? [],
      moversOf(doc, id),
      words.restaged ? kept.tops : null,
      onBone,
    );
    if (gone) {
      const g = lost.get(gone.name) ?? group();
      lost.set(gone.name, g);
      add(g, quiet, o);
    }
    if (namedWhenKept(o)) add(named, quiet, o);
  }
  // each warning, as the names it lists: written now for the objects named now, and held back in
  // `later` for the `unnamed` ones
  const says: [Named, (names: readonly string[]) => string][] = [];
  if (!words.listed)
    says.push([
      named,
      (n) =>
        words.gone
          ? `${words.gone} goes; ${namesWith(n, 'stays where it is', 'stay where they are')}${root ? `, on ${words.on}` : ''}`
          : keptWarning(n, words.of),
    ]);
  says.push([
    stayed,
    (n) =>
      namesWith(n, 'stays where it was', 'stay where they were') +
      `, not on ${words.on}: its scale would change ${n.length > 1 ? 'them' : 'it'} there`,
  ]);
  says.push([
    unskewed,
    (n) => {
      const many = n.length > 1;
      return (
        namesWith(n, 'changes shape', 'change shape') +
        ` on ${words.on}: the uneven scale of what ${many ? 'they' : 'it'} hung from skewed ${many ? 'them' : 'it'}, and no channels keep that skew there`
      );
    },
  ]);
  for (const [parent, g] of moved) {
    const where =
      parent === root ? words.on : parent ? `'${doc.getObject(parent)?.name ?? parent}'` : 'the scene';
    says.push([
      g,
      (n) => namesWith(n, 'is animated: its', 'are animated: their') + ` keyed motion now follows ${where}`,
    ]);
  }
  for (const [name, g] of lost)
    says.push([
      g,
      (n) => namesWith(n, 'no longer follows', 'no longer follow') + ` the animation of '${name}'`,
    ]);
  const out: string[] = [];
  for (const [g, say] of says) {
    if (g.now.names.length) out.push(say(g.now.names));
    if (g.held.names.length && words.later) words.later.push({ ...g.held, say });
  }
  return out;
}

/**
 * The nearest of `before` (what moved an object before it was hung anew) whose motion it no longer
 * follows: one that is not above it now moving as it did, nor taken over by an object above it now
 * that moves alike, nor (`restaged`) one of the pieces that went whose place the staging fills with
 * what it now hangs from: that one's own motion is kept, and its bones' when the object hangs from
 * the same bone of it (`onBone`). Null: it follows all of them.
 */
function lostMover(
  before: readonly Mover[],
  after: readonly Mover[],
  restaged: ReadonlySet<string> | null,
  onBone: boolean,
): Mover | null {
  for (const m of before) {
    const restagedHere = !!restaged?.has(m.id);
    const ownKept = m.own === null || restagedHere || after.some((a) => a.own === m.own);
    const poseKept = m.pose === null || (restagedHere && onBone) || after.some((a) => a.pose === m.pose);
    if (!ownKept || !poseKept) return m;
  }
  return null;
}

/** The value modifiers an F-curve's keys cannot be mapped through (all but STEPPED, which bends time only). */
const changesValues = (fc: FCurve): boolean =>
  (fc.modifiers ?? []).some((m) => !m.mute && m.type !== 'STEPPED');

/**
 * Keeps the keyed motion of object `id`, which stood at `world` under a parent whose world matrix
 * was `from` and now hangs, its world placement kept, from one whose world matrix is `to` (null: no
 * parent; every matrix the one at rest: restWorld): its transform channels are keyed in its parent's space, so
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
