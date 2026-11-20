import { dataKindOf, type SceneDoc } from '../../doc/scene-doc';
import { ROOT_COLLECTION_ID, type DatablockKind, type DriverData, type ObjectData } from '../../doc/types';
import type { Vec3 } from '../../math/types';
import { cloneJson } from '../../util/json';
import { UnitError } from './errors';
import { unitRecord, type UnitBody, type UnitHeader, type UnitPayload } from './format';
import { MAX_UNIT_GENERATION, UNIT_ROOT, derivePartId, deriveUnitId, requireUnitKey } from './ids';
import { UNIT_BLOCK_KINDS, type UnitKind } from './kinds';
import { provenanceProps, readInstance, withProvenance, type UnitPartStamp } from './list';
import { mergeForUpdate, partSum16, withUnitProps } from './ownership';
import { mapDriverRefs, mapRecordRefs, type UnitRecord } from './refs';
import { dataKey, deleteData, instanceData, keptWarning, oldLook, unusedData } from './remove';
import { driverKeyOf, driverSum16 } from './drivers';

/*
 * Inserting a unit: its records are copied into the scene, each datablock under the id
 * deriveUnitId(key, sourceId), its references remapped to those ids, in one transaction (one undo
 * step). The root takes the placement given (location, rotation, parent, collection; scale from the
 * unit unless given) and the scene-owned props given (rootProps: the staging stamps desk_role 'set'
 * and desk_rideo_clip on a set's root, desk_character_id on a figure's …), then the provenance
 * (list.ts). Names are made unique as every new datablock's are. A datablock (not an object) at a
 * derived id that nothing in the document uses (remove.ts: left behind by an instance taken out
 * before) does not count as taken: the insert deletes it and writes the unit's. A part's id held by
 * anything else (a material of the instance taken out before that the person gave to an object of
 * their own, one of its objects the person moved out from under it) moves the whole unit on to the
 * next generation of the slot's ids (ids.ts derivePartId): the first whose ids are all free, which
 * the instance keeps (unit_gen), so that a slot can always take a unit again and two replicas still
 * derive the same ids. The root's id is never salted: when it is taken the insert is refused,
 * UNIT_INSTANCE_EXISTS when the slot already holds an instance with this key, UNIT_ID_TAKEN otherwise.
 *
 * `remove`: what the unit takes the place of (the words' set, the instance of another item it
 * replaces) goes in the same transaction, once the unit is sure to go in, with the datablocks only
 * it used; a unit that does not go in leaves it as it is.
 *
 * `replace` makes an existing object the root (a procedural actor or prop swapped for a library
 * one): its id, name, placement, parent, constraints, physics, pose, F-curves and scene-owned props
 * stay; its old look goes (remove.ts oldLook: the parts the desk built for it), and its own data and
 * materials and those of the old look go when nothing else uses them (they are free for the unit's
 * even when the unit derives their ids). What the person put on the object stays and is named in
 * `warnings`, with the bones the scene's animation or attachments name that the unit's rig lacks.
 */

/** A library version: the host's item id, its version number and the SHA-256 of its unit file. */
export interface UnitPin {
  ref: string;
  version: number;
  sha256: string;
}

export interface InsertUnitOptions extends UnitPin {
  /** The instance key (slotKey). */
  key: string;
  /** The root's name (default: the unit root's). */
  name?: string;
  location?: Vec3;
  rotation_euler?: Vec3;
  /** Default: the unit root's scale. */
  scale?: Vec3;
  parent?: string | null;
  /** Default: the scene collection ('root'). */
  collection?: string;
  /**
   * Custom props for the root. Scene-owned keys (desk_rideo_*, desk_character_id, every desk_* on a
   * set's or prop's root …) are the scene's from then on; a unit-owned key overrides the unit's value
   * and makes the root count as edited.
   */
  rootProps?: Record<string, string | number | boolean>;
  /** An existing object (not an instance root) that becomes the root. */
  replace?: string;
  /**
   * Objects the unit takes the place of, taken out with everything below them in the insert's own
   * transaction, with the datablocks only they used (their data and materials, the part tables of the
   * instances among them): see the module comment.
   */
  remove?: readonly string[];
}

export interface InsertUnitResult {
  /** The root object's id. */
  root: string;
  /** The scene id of every datablock inserted, by '<kind>:<sourceId>'. */
  ids: Record<string, string>;
  /** The generation of the slot's ids the parts took (ids.ts derivePartId; 0 unless one was in use). */
  generation: number;
  warnings: string[];
}

const PIN_REF = /^[A-Za-z0-9_.:-]{1,100}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** `pin` when it is a library version ({ref, version, sha256}), else UNIT_BAD_SPEC. */
export function requirePin(pin: UnitPin): UnitPin {
  if (
    !pin ||
    typeof pin.ref !== 'string' ||
    !PIN_REF.test(pin.ref) ||
    !Number.isInteger(pin.version) ||
    pin.version < 1 ||
    pin.version > 1_000_000_000 ||
    typeof pin.sha256 !== 'string' ||
    !SHA256.test(pin.sha256)
  )
    throw new UnitError(
      'UNIT_BAD_SPEC',
      'a library version is {ref: a host id, version: an integer from 1, sha256: 64 lowercase hex digits}',
    );
  return { ref: pin.ref, version: pin.version, sha256: pin.sha256 };
}

/** Deep copy of a record value, byte arrays included (records of a decoded unit are views into it). */
const copy = (v: unknown): unknown => (v instanceof Uint8Array ? v.slice() : cloneJson(v));

/** The fields a record is written with (top level copied). */
function fieldsOf(rec: UnitRecord): Record<string, unknown> & { name: string } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (k !== 'id' && v !== undefined) out[k] = copy(v);
  return { ...out, name: typeof rec.name === 'string' && rec.name ? rec.name : 'Unit' };
}

/** Bones of the unit's root armature (null: the root is not an armature or has none). */
function unitBones(body: UnitBody): Set<string> | null {
  const root = body.blocks.objects?.[UNIT_ROOT];
  if (!root || root.type !== 'ARMATURE' || typeof root.data !== 'string') return null;
  const arm = unitRecord(body, 'armatures', root.data);
  const bones = Array.isArray(arm?.bones) ? (arm.bones as { name?: unknown }[]) : [];
  return new Set(bones.map((b) => String(b?.name ?? '')));
}

/** Warnings for bones the scene uses on `root` that `bones` lacks. */
function missingBones(doc: SceneDoc, root: string, bones: Set<string>, keep: Set<string>): string[] {
  const missing = new Set<string>();
  for (const fc of doc.listFCurves(root)) {
    const m = /^pose\.bones\["(.+?)"\]/.exec(fc.path);
    if (m && !bones.has(m[1])) missing.add(m[1]);
  }
  for (const o of doc.listObjects()) {
    if (o.parent === root && o.parent_type === 'BONE' && keep.has(o.id) && !bones.has(o.parent_bone))
      missing.add(o.parent_bone);
    for (const c of o.constraints ?? [])
      if (c.target === root && c.subtarget && !bones.has(c.subtarget)) missing.add(c.subtarget);
  }
  return [...missing]
    .sort()
    .map((b) => `the library figure has no bone '${b}' that the scene's animation, holds or attachments use`);
}

/** The data and materials an object record refers to, as '<kind>:<id>'. */
function dataOf(rec: UnitRecord | null): string[] {
  if (!rec) return [];
  const out: string[] = [];
  if (typeof rec.data === 'string' && rec.data) {
    const dk = dataKindOf(rec.type as ObjectData['type']);
    if (dk) out.push(dataKey(dk, rec.data));
  }
  if (Array.isArray(rec.material_slots))
    for (const m of rec.material_slots) if (typeof m === 'string' && m) out.push(dataKey('materials', m));
  return out;
}

/** The objects `ids` and everything below them, in the order removeObjectTrees takes them out. */
function treesOf(doc: SceneDoc, ids: readonly string[]): string[] {
  if (!ids.length) return [];
  const index = doc.childrenIndex();
  const all = new Set<string>();
  const visit = (id: string) => {
    if (all.has(id)) return;
    all.add(id);
    for (const c of index.get(id) ?? []) visit(c);
  };
  for (const id of ids) if (doc.has('objects', id)) visit(id);
  return [...all];
}

/**
 * Writes a body's records into `doc` under derived ids and returns the ids and the stamps of the
 * parts (no provenance; the caller writes it, given the parts, drivers and generation). Shared by
 * insertUnit and extraction's probe document.
 */
export function writeUnitRecords(
  doc: SceneDoc,
  body: UnitBody,
  kind: UnitKind,
  o: Omit<InsertUnitOptions, 'ref' | 'version' | 'sha256'>,
  provenance:
    | ((
        parts: Map<string, UnitPartStamp>,
        drivers: Map<string, string>,
        generation: number,
      ) => Record<string, string | number>)
    | null,
): InsertUnitResult {
  const key = requireUnitKey(o.key);
  const warnings: string[] = [];
  const unitRoot = body.blocks.objects?.[UNIT_ROOT];
  if (!unitRoot) throw new UnitError('UNIT_BAD_RECORD', "the unit has no root object ('@root')");
  const rootId = o.replace ?? deriveUnitId(key, UNIT_ROOT);
  const rootKey = `objects:${UNIT_ROOT}`;
  // what the unit takes the place of: those objects and everything below them
  const removed = treesOf(doc, o.remove ?? []);
  const removing = new Set(removed);

  let old: UnitRecord | null = null;
  let doomed: string[] = [];
  let kept = new Set<string>();
  let named: string[] = [];
  if (o.replace) {
    old = doc.readRecord('objects', o.replace);
    if (!old || removing.has(o.replace))
      throw new UnitError('UNIT_NOT_FOUND', `object '${o.replace}' is not in the scene`);
    if (old.type !== unitRoot.type)
      throw new UnitError(
        'UNIT_KIND_MISMATCH',
        `a ${String(unitRoot.type)} unit root cannot replace a ${String(old.type)} object`,
      );
    if (readInstance(doc, o.replace))
      throw new UnitError('UNIT_INSTANCE_EXISTS', `'${o.replace}' is already an instance: update it instead`);
    const look = oldLook(doc, o.replace);
    doomed = look.look.filter((id) => !removing.has(id));
    kept = new Set(look.kept);
    named = look.named;
  } else if (doc.has('objects', rootId) && !removing.has(rootId)) {
    const props = doc.readRecord('objects', rootId)?.custom_props as Record<string, unknown> | undefined;
    if (props?.unit_key === key)
      throw new UnitError('UNIT_INSTANCE_EXISTS', `the scene already holds the instance '${key}'`);
    throw new UnitError('UNIT_ID_TAKEN', `the id ${rootId} the unit's root derives to is taken`);
  }
  // what the insert frees (remove.ts): the ids it derives that a datablock nothing uses holds;
  // replacing an object, its own data and materials and its old parts' once nothing else uses them;
  // and what the objects it takes the place of alone used
  const going = new Set([...doomed, ...removed]);
  const freed: string[] = [];
  if (old) freed.push(...dataOf(old));
  for (const id of going) freed.push(...dataOf(doc.readRecord('objects', id)));
  for (const id of removed) freed.push(...instanceData(doc, id));
  // the parts' ids in a generation of the slot's, or why one of them is taken there
  const idsAt = (generation: number): Record<string, string> => {
    const ids: Record<string, string> = {};
    for (const k of UNIT_BLOCK_KINDS)
      for (const src of Object.keys(body.blocks[k] ?? {}))
        ids[`${k}:${src}`] =
          k === 'objects' && src === UNIT_ROOT ? rootId : derivePartId(key, src, generation);
    return ids;
  };
  const freeAt = (ids: Record<string, string>): { free: Set<string> } | { taken: string } => {
    const candidates = [...freed];
    const held: [string, string][] = [];
    for (const [pk, id] of Object.entries(ids)) {
      if (pk === rootKey) continue;
      const k = pk.slice(0, pk.indexOf(':')) as DatablockKind;
      if (id === rootId) return { taken: `${id} (${pk})` };
      if (!doc.has(k, id)) continue;
      if (k === 'objects') {
        if (!going.has(id)) return { taken: `${id} (${pk})` };
        continue;
      }
      candidates.push(dataKey(k, id));
      held.push([pk, dataKey(k, id)]);
    }
    const free = unusedData(doc, candidates, { going, replaced: o.replace });
    for (const [pk, dk] of held)
      if (!free.has(dk)) return { taken: `${dk.slice(dk.indexOf(':') + 1)} (${pk})` };
    return { free };
  };
  // the first generation whose ids are all free (0 unless something the scene keeps holds one)
  let ids: Record<string, string> = {};
  let free = new Set<string>();
  let generation = 0;
  let first = '';
  for (; ; generation++) {
    if (generation > MAX_UNIT_GENERATION)
      throw new UnitError(
        'UNIT_ID_TAKEN',
        `the ids the unit's parts derive to are taken in all ${MAX_UNIT_GENERATION + 1} generations of the slot's ids (first ${first})`,
      );
    ids = idsAt(generation);
    const r = freeAt(ids);
    if ('free' in r) {
      free = r.free;
      break;
    }
    first ||= r.taken;
  }
  if (o.parent && (!doc.has('objects', o.parent) || removing.has(o.parent)))
    throw new UnitError('UNIT_NOT_FOUND', `the parent '${o.parent}' is not in the scene`);
  if (o.collection && o.collection !== ROOT_COLLECTION_ID && !doc.has('collections', o.collection))
    throw new UnitError('UNIT_NOT_FOUND', `the collection '${o.collection}' is not in the scene`);

  const map = (k: DatablockKind, src: string) => ids[`${k}:${src}`] ?? null;
  // everything read from the unit's records is worked out before anything is written, so a unit that
  // does not insert leaves the scene as it was (a Yjs transaction does not roll back)
  const stamps = new Map<string, UnitPartStamp>();
  // in the order the records were always written (names are made unique in that order)
  const writes: {
    kind: DatablockKind;
    id: string;
    fields: Record<string, unknown> & { name: string };
    replace?: boolean;
  }[] = [];
  let drivers: DriverData[] = [];
  const driverStamps = new Map<string, string>();
  try {
    for (const k of UNIT_BLOCK_KINDS) {
      const m = body.blocks[k];
      if (!m) continue;
      for (const src of Object.keys(m).sort()) {
        const rec = m[src];
        const id = ids[`${k}:${src}`];
        const place = { isRoot: k === 'objects' && src === UNIT_ROOT, unitKind: kind };
        stamps.set(`${k}:${src}`, { id, sum: partSum16(k, rec, place) });
        // the scene's custom props are never the unit's (withUnitProps), on the root or any part
        const fields = fieldsOf(mapRecordRefs(k, withUnitProps(k, rec, place), map));
        if (!place.isRoot) {
          writes.push({ kind: k, id, fields });
          continue;
        }
        if (o.replace && old) {
          const merged = mergeForUpdate('objects', fields, old, place, () => true);
          merged.custom_props = { ...(merged.custom_props as object), ...(o.rootProps ?? {}) };
          const fieldsOut = merged as Record<string, unknown> & { name: string };
          writes.push({ kind: k, id, fields: fieldsOut, replace: true });
          continue;
        }
        fields.location = o.location ? [...o.location] : [0, 0, 0];
        fields.rotation_euler = o.rotation_euler ? [...o.rotation_euler] : [0, 0, 0];
        if (o.scale) fields.scale = [...o.scale];
        fields.parent = o.parent ?? null;
        fields.parent_type = 'OBJECT';
        fields.parent_bone = '';
        fields.collection = o.collection ?? ROOT_COLLECTION_ID;
        if (o.name) fields.name = o.name;
        fields.custom_props = { ...(fields.custom_props as object | undefined), ...(o.rootProps ?? {}) };
        writes.push({ kind: k, id, fields });
      }
    }
    drivers = body.drivers.flatMap((d) => {
      const mapped = mapDriverRefs(d, map);
      if (!mapped) return [];
      driverStamps.set(driverKeyOf(d), driverSum16(d));
      return [cloneJson(mapped) as unknown as DriverData];
    });
  } catch (err) {
    // a record of a shape decoding did not foresee is the unit's fault (out of memory is not)
    if (err instanceof TypeError)
      throw new UnitError('UNIT_BAD_RECORD', `the unit's records do not insert (${err.message})`);
    throw err;
  }
  const provenanceOf = provenance ? provenance(stamps, driverStamps, generation) : null;
  const bones = o.replace ? unitBones(body) : null;
  doc.transact(() => {
    if (removed.length) doc.removeObjects(removed);
    if (doomed.length) doc.removeObjects(doomed);
    deleteData(doc, free);
    for (const w of writes)
      if (w.replace) doc.replaceRecord(w.kind, w.id, w.fields);
      else doc.addRecord(w.kind, w.id, w.fields);
    for (const d of drivers) doc.setDriver(d);
    if (provenanceOf) {
      const cur = doc.readRecord('objects', rootId)!;
      doc.updateObject(rootId, {
        custom_props: withProvenance(
          cur.custom_props as ObjectData['custom_props'],
          provenanceOf,
        ) as ObjectData['custom_props'],
      });
    }
    if (named.length) warnings.push(keptWarning(named, `the look the library ${kind} replaces`));
    if (bones && o.replace) warnings.push(...missingBones(doc, o.replace, bones, kept));
  });
  return { root: rootId, ids, generation, warnings };
}

/**
 * Inserts a decoded unit into the scene (one transaction): see the module comment. Throws
 * UNIT_BAD_KEY, UNIT_BAD_SPEC (pin), UNIT_INSTANCE_EXISTS, UNIT_ID_TAKEN (the root's id, or every
 * generation of the parts'), UNIT_NOT_FOUND (parent, collection or `replace`) or UNIT_KIND_MISMATCH
 * (`replace` of another object type), each before anything is written.
 */
export function insertUnit(doc: SceneDoc, unit: UnitPayload, o: InsertUnitOptions): InsertUnitResult {
  const pin = requirePin(o);
  const header: UnitHeader = unit.header;
  return writeUnitRecords(doc, unit.body, header.kind, o, (parts, drivers, generation) =>
    provenanceProps({
      ...pin,
      digest: header.digest,
      kind: header.kind,
      key: o.key,
      name: header.name,
      parts,
      drivers,
      generation,
    }),
  );
}
