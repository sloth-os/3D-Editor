import { defaultObject } from '../../doc/defaults';
import { SceneDoc } from '../../doc/scene-doc';
import { ROOT_COLLECTION_ID, SCHEMA_VERSION, type DatablockKind, type ObjectData } from '../../doc/types';
import { FrameState } from '../../eval/frame-state';
import type { Mat4, Vec3 } from '../../math/types';
import { linearToSrgb } from '../../render/color';
import { sha256Hex, sha256HexOfText } from '../container/digest';
import { ACTOR_KINDS } from '../characters/types';
import { HIDDEN_SCALE_EPS, HIDE_SCALE } from '../hide';
import { DESK_SHAPE_PROP, STORE_PART_PROP, isWater } from '../layout';
import { DESK_PROPS } from '../props';
import { getDeskSettings } from '../shots';
import { round4 } from './canonical';
import { UnitError } from './errors';
import {
  MAX_UNIT_CREDITS,
  MAX_UNIT_LANDMARKS,
  MAX_UNIT_NAME_LENGTH,
  encodeUnit,
  readUnitHeader,
  rigDigest,
  unitMeta,
  type UnitBody,
  type UnitCredit,
  type UnitHeader,
  type UnitHeaderInput,
  type UnitLandmark,
  type UnitPublishMeta,
} from './format';
import {
  UNIT_ROOT,
  UNIT_SOURCE_ID_PATTERN,
  deriveUnitId,
  libKey,
  parseSlotKey,
  slotKey,
  type UnitSlot,
} from './ids';
import { writeUnitRecords } from './insert';
import type { UnitBlockKind, UnitKind } from './kinds';
import { readInstances, splitPartKey, type UnitInstance } from './list';
import { isSceneProp, partSum16 } from './ownership';
import { driverStamps } from './drivers';
import { channelsUnder } from './place';
import {
  ANIM_TARGET_KINDS,
  collectRecordRefs,
  mapDriverRefs,
  mapRecordRefs,
  type RefSite,
  type UnitRecord,
} from './refs';

/*
 * Making a unit from a scene (read only: the scene is not changed).
 *
 * What each kind takes:
 * - figure: an actor (an ARMATURE with desk_role 'actor') and its subtree: its parts and attachments;
 *   never cameras or other actors;
 * - prop: an object and its subtree; never cameras or actors;
 * - set: every object but the scene's action: actors and their parts, cameras, the brief's props
 *   (desk_role 'prop'), kite strings and tails, the sun (and everything under them). The set's
 *   instance root, when the scene has one, is the unit's root; otherwise a root (an EMPTY at the
 *   origin) is made, and the set's top-level objects hang from it.
 * Then the closure: object data, materials, images, the collections instancing needs (with their
 * objects), and the objects modifiers, bevels and particles use (unless they are of the scene's
 * action: those references are cut, with a warning). Constraints targeting outside the unit go
 * (holds, rides and looks are the scene's); every F-curve goes (units carry no animation); drivers
 * are kept when their target and every variable lie inside. An object whose parent is outside hangs
 * from the root, its transform kept relative to it.
 *
 * Ids: the parts of the target instance (the root given, or the scene's set instance) map back to
 * the source ids of its table, so a new version keeps the ids of the version before; other objects
 * keep their scene ids as source ids (other instances inside are flattened). Names lose their
 * '.NNN' suffix. Scene-owned values (ownership.ts) are left out, the root is put at the origin.
 *
 * The unit is inserted into a throwaway probe document to measure it (bounds, counts, set pieces) and
 * to check it is closed before anything is published; the caller can render a thumbnail from it.
 */

export type UnitSpec =
  | { kind: 'set'; name: string }
  | { kind: 'prop'; root: string; name?: string }
  | { kind: 'figure'; actor: string; name?: string };

/** What a unit made from the scene would hold (planUnit; extraction's first step). */
export interface UnitPlan {
  kind: UnitKind;
  /** The scene object that becomes the unit's root (null: a set root is made). */
  root: string | null;
  /** The instance the unit would be a new version of (its root), or null. */
  instance: string | null;
  /** The objects it takes (before the closure), with their desk role ('' for none). */
  objects: { id: string; name: string; role: string }[];
  /** Objects left out, with why. */
  excluded: { id: string; name: string; reason: string }[];
  warnings: string[];
}

/**
 * How adoptUnit links the scene's objects to the unit after the host confirms a publish: plain,
 * structured-cloneable data (the staging worker hands it to the page and back).
 */
export interface UnitLinkPlan {
  kind: UnitKind;
  /** The instance key (slotKey of the slot the unit came from, else the instance's key, else 'lib:…'). */
  key: string;
  /** The scene object that becomes the root (null when a set root is made). */
  rootSceneId: string | null;
  /** Whether adoption makes the set's root (an EMPTY at the origin) and hangs the set from it. */
  synthesizeSetRoot: boolean;
  /** The unit's name and body digest (for the provenance). */
  name: string;
  digest: string;
  /** '<kind>:<sourceId>' → the scene id it came from and its stamp. */
  parts: Record<string, { sceneId: string; sum16: string }>;
  /** The unit's drivers: their key in source ids → their stamp (drivers.ts; absent in older plans: none). */
  drivers?: Record<string, string>;
}

export interface UnitExtraction {
  /** The unit file. */
  data: Uint8Array;
  /** The SHA-256 of `data`. */
  sha256: string;
  header: UnitHeader;
  /** The protocol `meta` for unit-publish. */
  meta: UnitPublishMeta;
  link: UnitLinkPlan;
  /** The brief slot the unit came from (null: none). */
  from: UnitSlot | null;
  /** The version the unit is a new version of (the target instance's), or null. */
  basedOn: { ref: string; version: number } | null;
  warnings: string[];
  /** The unit alone in a document of its own, at the origin (for the thumbnail). */
  probe: SceneDoc;
}

const role = (o: Pick<ObjectData, 'custom_props'> | null | undefined) =>
  String(o?.custom_props?.[DESK_PROPS.role] ?? '');
const prop = (o: Pick<ObjectData, 'custom_props'> | null | undefined, key: string) => o?.custom_props?.[key];
/** A name without the suffix that made it unique ('Kite.001' → 'Kite'). */
const stem = (name: unknown) => String(name ?? '').replace(/\.\d{3,}$/, '') || String(name ?? '');

/** Why an object is never part of a unit (the scene's action), or null. `figureRoot`: its own parts count. */
function actionReason(
  doc: SceneDoc,
  o: ObjectData,
  kind: UnitKind,
  figureRoot: string | null,
): string | null {
  if (o.type === 'CAMERA' || role(o) === 'camera') return 'a camera';
  if (role(o) === 'actor' && o.id !== figureRoot) return 'an actor';
  const actor = prop(o, DESK_PROPS.actor);
  if (actor !== undefined && actor !== figureRoot) return "an actor's part";
  if (role(o) === 'string' || prop(o, 'desk_string_to') !== undefined) return 'a kite string';
  if (prop(o, 'desk_tail_of') !== undefined) return "a flyer's tail";
  if (kind === 'set' && role(o) === 'prop') return "a prop of the scene's action";
  if (kind === 'set' && o.type === 'LIGHT') {
    if (prop(o, DESK_PROPS.label) === 'sun') return 'the sun';
    const light = o.data ? doc.getLight(o.data) : null;
    if (light?.type === 'SUN') return 'the sun';
  }
  return null;
}

interface Members {
  kind: UnitKind;
  root: string | null;
  instance: UnitInstance | null;
  objects: string[];
  excluded: { id: string; name: string; reason: string }[];
  figureRoot: string | null;
}

function members(doc: SceneDoc, spec: UnitSpec): Members {
  const index = doc.childrenIndex();
  const excluded: Members['excluded'] = [];
  const out: string[] = [];
  const instances = readInstances(doc);
  const walk = (id: string, kind: UnitKind, figureRoot: string | null) => {
    for (const child of index.get(id) ?? []) {
      const c = doc.getObject(child);
      if (!c) continue;
      const why = actionReason(doc, c, kind, figureRoot);
      if (why) {
        excluded.push({ id: c.id, name: c.name, reason: why });
        continue;
      }
      out.push(child);
      walk(child, kind, figureRoot);
    }
  };
  if (spec.kind === 'set') {
    const inst =
      instances.find((i) => i.kind === 'set' && i.key === 'set') ??
      instances.find((i) => i.kind === 'set') ??
      null;
    const visit = (id: string, under: string | null) => {
      const o = doc.getObject(id);
      if (!o) return;
      const why = under ?? actionReason(doc, o, 'set', null);
      if (why) {
        excluded.push({ id: o.id, name: o.name, reason: under ? 'under an object the set leaves out' : why });
      } else out.push(id);
      for (const child of index.get(id) ?? []) visit(child, why ? (under ?? why) : null);
    };
    for (const top of index.get(null) ?? []) visit(top, null);
    // a set made local keeps its root at the id the slot's instance derives: that root is the set's
    // again (a root made for the set would need its id)
    const local = inst ? null : deriveUnitId(slotKey({ set: true }), UNIT_ROOT);
    const kept = local ? doc.getObject(local) : null;
    const root =
      inst?.root ??
      (kept && kept.parent == null && kept.type === 'EMPTY' && role(kept) === 'set' && out.includes(kept.id)
        ? kept.id
        : null);
    if (!out.length || (root && out.length === 1 && out[0] === root))
      throw new UnitError('UNIT_EMPTY', 'the scene has no set to save (everything in it is its action)');
    return {
      kind: 'set',
      root,
      instance: inst,
      objects: out,
      excluded,
      figureRoot: null,
    };
  }
  const ref = spec.kind === 'figure' ? spec.actor : spec.root;
  const o = doc.getObject(ref) ?? doc.findObjectByName(ref);
  if (!o) throw new UnitError('UNIT_NOT_FOUND', `'${ref}' is not in the scene`);
  if (spec.kind === 'figure') {
    if (o.type !== 'ARMATURE' || role(o) !== 'actor')
      throw new UnitError('UNIT_BAD_SPEC', `'${o.name}' is not an actor (a figure is saved from an actor)`);
  } else if (o.type === 'CAMERA' || role(o) === 'camera')
    throw new UnitError('UNIT_BAD_SPEC', `'${o.name}' is a camera: cameras are not saved to the library`);
  else if (role(o) === 'actor')
    throw new UnitError('UNIT_BAD_SPEC', `'${o.name}' is an actor: save it as a figure`);
  else if (prop(o, DESK_PROPS.actor) !== undefined)
    throw new UnitError('UNIT_BAD_SPEC', `'${o.name}' is part of an actor: save the actor as a figure`);
  const inst = instances.find((i) => i.root === o.id) ?? null;
  if (inst && inst.kind !== spec.kind)
    throw new UnitError('UNIT_KIND_MISMATCH', `'${o.name}' holds a library ${inst.kind}, not a ${spec.kind}`);
  out.push(o.id);
  const figureRoot = spec.kind === 'figure' ? o.id : null;
  walk(o.id, spec.kind, figureRoot);
  return { kind: spec.kind, root: o.id, instance: inst, objects: out, excluded, figureRoot };
}

/** What a unit made from the scene would hold, read only (the Save to library dialog). */
export function planUnit(doc: SceneDoc, spec: UnitSpec): UnitPlan {
  const m = members(doc, spec);
  return {
    kind: m.kind,
    root: m.root,
    instance: m.instance?.root ?? null,
    objects: m.objects.map((id) => {
      const o = doc.getObject(id)!;
      return { id, name: o.name, role: role(o) };
    }),
    excluded: m.excluded,
    warnings: [],
  };
}

/** The slot an object's unit fills: from its instance key, else its brief ids. */
function slotOf(doc: SceneDoc, m: Members): UnitSlot | null {
  if (m.kind === 'set') return { set: true };
  const bound = m.instance ? parseSlotKey(m.instance.key) : null;
  if (bound) return bound;
  const o = m.root ? doc.getObject(m.root) : null;
  const castId = prop(o, DESK_PROPS.characterId);
  const elementId = prop(o, DESK_PROPS.elementId);
  try {
    if (m.kind === 'figure' && typeof castId === 'string' && castId) {
      slotKey({ castId });
      return { castId };
    }
    if (m.kind === 'prop' && typeof elementId === 'string' && elementId) {
      slotKey({ elementId });
      return { elementId };
    }
  } catch {
    return null;
  }
  return null;
}

/** The object ids of a collection and its child collections. */
function collectionMembers(doc: SceneDoc, collection: string): string[] {
  const all = new Set<string>([collection]);
  let grew = true;
  const cols = doc.listCollections();
  while (grew) {
    grew = false;
    for (const c of cols)
      if (c.parent && all.has(c.parent) && !all.has(c.id)) {
        all.add(c.id);
        grew = true;
      }
  }
  return doc
    .listObjects()
    .filter((o) => all.has(o.collection))
    .map((o) => o.id);
}

const hex2 = (v: number) =>
  Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255)
    .toString(16)
    .padStart(2, '0');
const linearHex = (c: unknown): string =>
  Array.isArray(c) && c.length >= 3
    ? `#${hex2(Number(c[0]))}${hex2(Number(c[1]))}${hex2(Number(c[2]))}`
    : '#808080';

/** A figure's root pose at rest: every bone's transform reset (constraints and IK settings kept). */
function restPose(pose: unknown): unknown {
  if (!pose || typeof pose !== 'object' || !('bones' in pose)) return { bones: {} };
  const bones = (pose as { bones: unknown }).bones;
  if (!bones || typeof bones !== 'object') return { bones: {} };
  const out: Record<string, unknown> = {};
  for (const [name, pb] of Object.entries(bones as Record<string, unknown>))
    out[name] =
      pb && typeof pb === 'object'
        ? { ...(pb as object), location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1] }
        : pb;
  return { bones: out };
}

/**
 * Makes a unit of the scene's set, a prop or a figure (read only): the file, its SHA-256, header and
 * protocol meta, the plan adoptUnit links the scene with once the host confirms the publish, the slot
 * it came from, the version it is a new version of, warnings, and the probe document. Throws
 * UNIT_NOT_FOUND, UNIT_BAD_SPEC, UNIT_EMPTY, UNIT_KIND_MISMATCH, UNIT_BAD_RECORD or UNIT_TOO_LARGE.
 */
export function extractUnit(doc: SceneDoc, spec: UnitSpec, o: { deskVersion: string }): UnitExtraction {
  const warnings: string[] = [];
  const m = members(doc, spec);
  const kind = m.kind;
  const name = (spec.kind === 'set' ? spec.name : (spec.name ?? stem(doc.getObject(m.root!)?.name))).trim();
  if (!name) throw new UnitError('UNIT_BAD_SPEC', 'a unit needs a name');
  if (spec.name !== undefined && name.length > MAX_UNIT_NAME_LENGTH)
    throw new UnitError('UNIT_BAD_SPEC', `a unit's name is at most ${MAX_UNIT_NAME_LENGTH} characters`);
  const unitName = name.slice(0, MAX_UNIT_NAME_LENGTH);

  // ---- what the unit holds: members, then the closure
  const inUnit = new Map<DatablockKind, Set<string>>();
  const has = (k: DatablockKind, id: string) => inUnit.get(k)?.has(id) ?? false;
  const queue: [DatablockKind, string][] = [];
  const take = (k: DatablockKind, id: string) => {
    if (has(k, id) || !doc.has(k, id)) return;
    let s = inUnit.get(k);
    if (!s) inUnit.set(k, (s = new Set()));
    s.add(id);
    queue.push([k, id]);
  };
  for (const id of m.objects) take('objects', id);
  const resolve = (k: DatablockKind, ref: string): string => {
    if (doc.has(k, ref)) return ref;
    if (k === 'objects') return doc.findObjectByName(ref)?.id ?? ref;
    if (k === 'collections') return doc.listCollections().find((c) => c.name === ref)?.id ?? ref;
    return ref;
  };
  const cut: string[] = [];
  // an object the closure pulls in hangs from the root: never one of the scene's action, nor an
  // ancestor of the root (adoption would hang it from its own descendant)
  const pullReason = (obj: ObjectData): string | null =>
    actionReason(doc, obj, kind, m.figureRoot) ??
    (m.root && obj.id !== m.root && doc.isAncestor(obj.id, m.root) ? "an ancestor of the unit's root" : null);
  const PULL: ReadonlySet<RefSite> = new Set([
    'data',
    'material',
    'texture_image',
    'modifier',
    'bevel_object',
    'particle_object',
    'particle_weight',
  ]);
  while (queue.length) {
    const [k, id] = queue.shift()!;
    const rec = doc.readRecord(k, id);
    if (!rec) continue;
    for (const r of collectRecordRefs(k, rec)) {
      const target = resolve(r.kind, r.id);
      if (has(r.kind, target)) continue;
      if (r.site === 'instance_collection' || r.site === 'particle_collection') {
        take('collections', target);
        for (const oid of collectionMembers(doc, target)) {
          const obj = doc.getObject(oid);
          if (obj && !pullReason(obj)) take('objects', oid);
        }
        continue;
      }
      if (!PULL.has(r.site)) continue;
      if (r.kind === 'objects') {
        const obj = doc.getObject(target);
        const why = obj ? pullReason(obj) : 'missing';
        if (why) {
          cut.push(`${String(rec.name)} → ${obj?.name ?? target} (${why})`);
          continue;
        }
      }
      take(r.kind, target);
    }
  }
  if (cut.length)
    warnings.push(
      `references cut where they leave the unit: ${cut.slice(0, 5).join('; ')}${cut.length > 5 ? ` and ${cut.length - 5} more` : ''}`,
    );

  // ---- source ids
  const tableSrc = new Map<DatablockKind, Map<string, string>>();
  if (m.instance)
    for (const [pk, p] of m.instance.parts) {
      const s = splitPartKey(pk);
      if (!s) continue;
      let t = tableSrc.get(s.kind);
      if (!t) tableSrc.set(s.kind, (t = new Map()));
      t.set(p.id, s.src);
    }
  const srcOf = new Map<DatablockKind, Map<string, string>>();
  const usedSrc = new Map<DatablockKind, Set<string>>();
  const assign = (k: DatablockKind, id: string): string => {
    let map = srcOf.get(k);
    if (!map) srcOf.set(k, (map = new Map()));
    const known = map.get(id);
    if (known) return known;
    let used = usedSrc.get(k);
    if (!used) usedSrc.set(k, (used = new Set()));
    let src = k === 'objects' && id === m.root ? UNIT_ROOT : (tableSrc.get(k)?.get(id) ?? id);
    if (
      !UNIT_SOURCE_ID_PATTERN.test(src) ||
      (src === UNIT_ROOT && !(k === 'objects' && id === m.root)) ||
      used.has(src)
    )
      src = `s${sha256HexOfText(`${k}\n${id}`).slice(0, 20)}`;
    used.add(src);
    map.set(id, src);
    return src;
  };
  // the root first, then the instance's parts, then the rest, each in id order (deterministic)
  const ordered = (k: DatablockKind) => {
    const ids = [...(inUnit.get(k) ?? [])].sort();
    const t = tableSrc.get(k);
    return [...ids.filter((id) => t?.has(id)), ...ids.filter((id) => !t?.has(id))];
  };
  if (m.root) assign('objects', m.root);
  const kinds: UnitBlockKind[] = [
    'images',
    'materials',
    'meshes',
    'curves',
    'armatures',
    'lights',
    'cameras',
    'collections',
    'objects',
  ];
  for (const k of kinds) for (const id of ordered(k)) assign(k, id);
  const toSrc = (k: DatablockKind, id: string): string | null => {
    const target = resolve(k, id);
    return has(k, target) ? (srcOf.get(k)?.get(target) ?? null) : null;
  };

  // ---- records
  const rootWorld: Mat4 | null = m.root ? doc.worldMatrix(m.root) : null;
  const blocks: UnitBody['blocks'] = {};
  let droppedConstraints = 0;
  for (const k of kinds) {
    const ids = ordered(k);
    if (!ids.length) continue;
    const out: Record<string, UnitRecord> = {};
    for (const id of ids) {
      const rec = doc.readRecord(k, id);
      if (!rec) continue;
      const src = srcOf.get(k)!.get(id)!;
      const isRoot = k === 'objects' && src === UNIT_ROOT;
      let parentOutside = false;
      const mapped = mapRecordRefs(k, rec, (rk, ref, site) => {
        const s = toSrc(rk, ref);
        if (s === null) {
          if (site === 'parent') parentOutside = true;
          if (site === 'constraint' || site === 'bone_constraint') droppedConstraints++;
        }
        return s;
      });
      mapped.name = stem(rec.name) || 'Unit';
      if (k === 'objects') {
        const place = { isRoot, unitKind: kind };
        const props: Record<string, unknown> = {};
        for (const [pk, v] of Object.entries((mapped.custom_props as Record<string, unknown>) ?? {}))
          if (!isSceneProp(pk, place)) props[pk] = v;
        mapped.custom_props = props;
        // physics is the scene's on every object: a unit holds no rigid body
        mapped.rigid_body = null;
        if (isRoot) {
          Object.assign(mapped, {
            parent: null,
            parent_type: 'OBJECT',
            parent_bone: '',
            location: [0, 0, 0],
            rotation_euler: [0, 0, 0],
            constraints: [],
            hide_viewport: false,
            hide_render: false,
            hide_select: false,
          });
          if (kind === 'figure') mapped.pose = restPose(mapped.pose);
          if (kind === 'set') mapped.name = unitName;
          // a root hidden by its scale (hide keys write the shrunk scale) is saved at the scale it is shown at
          const sc = mapped.scale;
          if (
            Array.isArray(sc) &&
            sc.length === 3 &&
            sc.every((v) => typeof v === 'number' && v !== 0 && Math.abs(v) < HIDDEN_SCALE_EPS)
          ) {
            mapped.scale = sc.map((v) => (v as number) / HIDE_SCALE);
            warnings.push(
              `'${stem(rec.name)}' was hidden by its scale; it is saved at the scale it is shown at`,
            );
          }
        } else if (rec.parent == null || parentOutside) {
          Object.assign(mapped, {
            parent: UNIT_ROOT,
            parent_type: 'OBJECT',
            parent_bone: '',
            ...channelsUnder(doc, id, rootWorld),
          });
        }
        if (mapped.collection === undefined) mapped.collection = ROOT_COLLECTION_ID;
      }
      out[src] = mapped;
    }
    blocks[k] = out;
  }
  if (kind === 'set' && !blocks.objects?.[UNIT_ROOT]) {
    const { id: _id, ...root } = defaultObject('EMPTY', UNIT_ROOT, unitName);
    blocks.objects = { [UNIT_ROOT]: root as unknown as UnitRecord, ...(blocks.objects ?? {}) };
  }
  if (droppedConstraints)
    warnings.push(
      `${droppedConstraints} constraint(s) targeting objects outside the unit were left out (holds, rides and looks are the scene's)`,
    );

  // ---- drivers and animation
  const drivers: UnitRecord[] = [];
  for (const d of doc.listDrivers()) {
    const kindOf = ANIM_TARGET_KINDS[d.target_type];
    if (!kindOf || !has(kindOf, d.target_id)) continue;
    const mapped = mapDriverRefs(d as unknown as UnitRecord, (k, id) => toSrc(k, id));
    if (mapped) drivers.push(mapped);
  }
  let curves = 0;
  for (const fc of doc.listFCurves()) {
    const kindOf = ANIM_TARGET_KINDS[fc.target_type];
    if (kindOf && has(kindOf, fc.target_id)) curves++;
  }
  if (curves) warnings.push(`${curves} animation curve(s) were left out: library units carry no animation`);
  const body: UnitBody = { root: UNIT_ROOT, blocks, drivers };

  // ---- the probe: the unit alone at the origin
  const probe = SceneDoc.create({ empty: true, name: unitName });
  const inserted = writeUnitRecords(probe, body, kind, { key: 'probe' }, null);
  const fs = new FrameState(probe, 0);
  const objectIds = Object.keys(blocks.objects ?? {}).map((src) => inserted.ids[`objects:${src}`]);
  const header = headerOf(
    doc,
    probe,
    fs,
    body,
    objectIds,
    inserted.ids,
    m,
    kind,
    unitName,
    o.deskVersion,
    warnings,
  );

  // ---- the file (a header too large loses its longest credits first)
  const data = encodeFitting(body, header, warnings);
  const fileHeader = readUnitHeader(data);
  const meta = unitMeta(fileHeader, data, warnings);

  // ---- the link plan
  const from = slotOf(doc, m);
  const key = m.instance?.key ?? (from ? slotKey(from) : libKey());
  const synthesizeSetRoot = kind === 'set' && !m.root;
  const parts: UnitLinkPlan['parts'] = {};
  for (const k of kinds) {
    const sceneOf = new Map([...(srcOf.get(k) ?? [])].map(([id, src]) => [src, id]));
    for (const [src, rec] of Object.entries(blocks[k] ?? {})) {
      const isRoot = k === 'objects' && src === UNIT_ROOT;
      const sceneId = isRoot && synthesizeSetRoot ? deriveUnitId(key, UNIT_ROOT) : sceneOf.get(src);
      if (!sceneId) continue;
      parts[`${k}:${src}`] = { sceneId, sum16: partSum16(k, rec, { isRoot, unitKind: kind }) };
    }
  }
  const link: UnitLinkPlan = {
    kind,
    key,
    rootSceneId: m.root,
    synthesizeSetRoot,
    name: fileHeader.name,
    digest: fileHeader.digest,
    parts,
    drivers: Object.fromEntries(driverStamps(drivers)),
  };
  return {
    data,
    sha256: sha256Hex(data),
    header: fileHeader,
    meta,
    link,
    from,
    basedOn: m.instance ? { ref: m.instance.ref, version: m.instance.version } : null,
    warnings,
    probe,
  };
}

/** encodeUnit, leaving credits (the longest first), then set pieces, out of a header over 64 KiB. */
function encodeFitting(
  body: UnitBody,
  header: UnitHeaderInput & { set?: UnitHeader['set'] },
  warnings: string[],
): Uint8Array {
  for (;;) {
    try {
      return encodeUnit(body, header);
    } catch (err) {
      if (!(err instanceof UnitError) || err.code !== 'UNIT_TOO_LARGE' || !/header/.test(err.message))
        throw err;
      if (header.credits.length) {
        let at = 0;
        header.credits.forEach((c, i) => {
          if (JSON.stringify(c).length >= JSON.stringify(header.credits[at]).length) at = i;
        });
        header.credits.splice(at, 1);
        warnings.push("a credit was left out of the unit's header (it holds at most 64 KiB)");
      } else if (header.set?.landmarks.length) {
        header.set.landmarks.pop();
        warnings.push("a set piece was left out of the unit's header (it holds at most 64 KiB)");
      } else throw err;
    }
  }
}

/** World bounds (and triangle count) of mesh objects `ids` in the probe, in the frame `turn` (z rotation). */
function boundsOf(
  probe: SceneDoc,
  fs: FrameState,
  ids: readonly string[],
  yaw = 0,
): { min: Vec3; max: Vec3 } | null {
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const id of ids) {
    const o = probe.getObject(id);
    if (!o || o.type !== 'MESH' || !o.data) continue;
    const mesh = probe.getMesh(o.data);
    const w = mesh ? fs.world(id) : null;
    if (!mesh || !w) continue;
    const P = mesh.positions;
    for (let i = 0; i + 2 < P.length; i += 3) {
      const x = w[0] * P[i] + w[4] * P[i + 1] + w[8] * P[i + 2] + w[12];
      const y = w[1] * P[i] + w[5] * P[i + 1] + w[9] * P[i + 2] + w[13];
      const z = w[2] * P[i] + w[6] * P[i + 1] + w[10] * P[i + 2] + w[14];
      const p: Vec3 = [c * x - s * y, s * x + c * y, z];
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
      any = true;
    }
  }
  return any ? { min, max } : null;
}

const r3 = (v: Vec3): Vec3 => [round4(v[0]), round4(v[1]), round4(v[2])];

function headerOf(
  doc: SceneDoc,
  probe: SceneDoc,
  fs: FrameState,
  body: UnitBody,
  objectIds: string[],
  ids: Record<string, string>,
  m: Members,
  kind: UnitKind,
  name: string,
  deskVersion: string,
  warnings: string[],
): UnitHeaderInput & { set?: UnitHeader['set'] } {
  const blocks = body.blocks;
  const count = (k: UnitBlockKind) => Object.keys(blocks[k] ?? {}).length;
  let vertices = 0;
  let faces = 0;
  let triangles = 0;
  for (const src of Object.keys(blocks.meshes ?? {})) {
    const n = probe.meshCounts(ids[`meshes:${src}`]);
    if (!n) continue;
    vertices += n.vertices;
    faces += n.faces;
    triangles += Math.max(0, n.corners - 2 * n.faces);
  }
  const b = boundsOf(probe, fs, objectIds);
  const bounds = b ? { min: r3(b.min), max: r3(b.max) } : null;
  const objects = objectIds.map((id) => probe.getObject(id)!).filter(Boolean);

  // credits: every store model the unit holds, by store id
  const byStore = new Map<string, UnitCredit>();
  for (const o of objects) {
    const storeId = prop(o, DESK_PROPS.storeId);
    if (typeof storeId !== 'string' || !storeId) continue;
    const c = byStore.get(storeId);
    if (c) {
      c.objects++;
      continue;
    }
    const str = (k: string, max: number) => {
      const v = prop(o, k);
      return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
    };
    byStore.set(storeId, {
      name: (stem(o.name) || storeId).slice(0, 120),
      storeId: storeId.slice(0, 200),
      source: str(DESK_PROPS.storeSource, 64) ?? '',
      license: str(DESK_PROPS.license, 64) ?? 'unknown',
      author: str(DESK_PROPS.author, 200),
      sourceUrl: str(DESK_PROPS.sourceUrl, 500),
      objects: 1,
    });
  }
  let credits = [...byStore.values()].sort((x, y) =>
    x.storeId < y.storeId ? -1 : x.storeId > y.storeId ? 1 : 0,
  );
  if (credits.length > MAX_UNIT_CREDITS) {
    const keep = new Set(
      [...credits]
        .sort((x, y) => y.objects - x.objects || (x.storeId < y.storeId ? -1 : 1))
        .slice(0, MAX_UNIT_CREDITS),
    );
    warnings.push(
      `${credits.length - MAX_UNIT_CREDITS} credits were left out of the unit (it holds at most ${MAX_UNIT_CREDITS})`,
    );
    credits = credits.filter((c) => keep.has(c));
  }

  const header: UnitHeaderInput & { set?: UnitHeader['set'] } = {
    kind,
    name,
    schemaVersion: SCHEMA_VERSION,
    deskVersion: (deskVersion.trim() || 'unknown').slice(0, 64),
    counts: {
      objects: count('objects'),
      meshes: count('meshes'),
      materials: count('materials'),
      images: count('images'),
      armatures: count('armatures'),
      curves: count('curves'),
      lights: count('lights'),
      cameras: count('cameras'),
      collections: count('collections'),
      drivers: body.drivers.length,
      vertices,
      faces,
      triangles,
    },
    bounds,
    credits,
  };
  const rootId = ids[`objects:${UNIT_ROOT}`];
  const rootObj = probe.getObject(rootId)!;

  if (kind === 'prop') {
    const size: Vec3 = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [0, 0, 0];
    const storeId = prop(rootObj, DESK_PROPS.storeId);
    header.prop = {
      label: stem(rootObj.name).slice(0, 100),
      dimensions: r3(size).map((v) => Math.max(0, v)) as Vec3,
      base: b ? round4(b.min[2]) : 0,
      storeId: typeof storeId === 'string' && storeId ? storeId.slice(0, 200) : null,
    };
  }

  if (kind === 'figure') {
    const actor = doc.getObject(m.root!)!;
    const kindName = String(prop(actor, DESK_PROPS.kind) ?? '');
    if (!(ACTOR_KINDS as readonly string[]).includes(kindName))
      throw new UnitError('UNIT_BAD_SPEC', `the actor's kind '${kindName}' is not one the desk knows`);
    const height = Number(prop(actor, DESK_PROPS.heightM));
    if (!(height >= 0.05 && height <= 8))
      throw new UnitError(
        'UNIT_BAD_SPEC',
        `the actor's height ${String(prop(actor, DESK_PROPS.heightM))} is not 0.05–8 m`,
      );
    const color = String(prop(actor, DESK_PROPS.color) ?? '').toLowerCase();
    const armSrc =
      typeof blocks.objects?.[UNIT_ROOT]?.data === 'string'
        ? (blocks.objects[UNIT_ROOT].data as string)
        : null;
    const arm = armSrc ? blocks.armatures?.[armSrc] : null;
    const boneNames = (Array.isArray(arm?.bones) ? (arm.bones as { name?: unknown }[]) : []).map((x) =>
      String(x?.name ?? ''),
    );
    const parts = Object.values(blocks.objects ?? {}).filter(
      (r) => (r.custom_props as Record<string, unknown> | undefined)?.[DESK_PROPS.actor] === UNIT_ROOT,
    ).length;
    header.figure = {
      kind: kindName as (typeof ACTOR_KINDS)[number],
      heightM: round4(height),
      color: /^#[0-9a-f]{6}$/.test(color) ? color : '#808080',
      bones: boneNames.length,
      parts,
      rig: rigDigest(boneNames),
      materials: Object.keys(blocks.materials ?? {})
        .sort()
        .slice(0, 8)
        .map((src) => {
          const mat = blocks.materials![src];
          return { name: String(mat.name ?? '').slice(0, 64), color: linearHex(mat.base_color) };
        }),
    };
  }

  if (kind === 'set') {
    const settings = getDeskSettings(doc);
    const size = (v: number, i: 0 | 1) =>
      round4(Math.min(200, v > 0 ? v : b ? Math.max(0, b.max[i] - b.min[i]) : 0));
    const width = size(settings.set_width, 0);
    const depth = size(settings.set_depth, 1);
    const ground = objects.find((x) => prop(x, DESK_PROPS.label) === 'ground');
    const walls = objects.some((x) => prop(x, DESK_PROPS.label) === 'wall');
    header.set = {
      width,
      depth,
      interior: settings.interior || walls,
      hasGround: !!ground,
      groundZ: ground ? round4(fs.world(ground.id)?.[14] ?? 0) : 0,
      lights: objects.filter((x) => x.type === 'LIGHT').length,
      landmarks: landmarksOf(probe, fs, rootId, { width, depth }),
    };
  }
  return header;
}

/** The pieces of a set at rest, its root at identity (see UnitLandmarkSchema), at most 128. */
function landmarksOf(
  probe: SceneDoc,
  fs: FrameState,
  rootId: string,
  stage: { width: number; depth: number },
): UnitLandmark[] {
  const index = probe.childrenIndex();
  const subtree = (id: string): string[] => {
    const out = [id];
    for (let i = 0; i < out.length; i++) out.push(...(index.get(out[i]) ?? []));
    return out;
  };
  const landmarks: UnitLandmark[] = [];
  const grounds: UnitLandmark[] = [];
  const walls: UnitLandmark[] = [];
  const dressing: (UnitLandmark & { area: number })[] = [];
  const lights: UnitLandmark[] = [];
  for (const id of index.get(rootId) ?? []) {
    const o = probe.getObject(id);
    if (!o) continue;
    const label = (String(prop(o, DESK_PROPS.label) ?? '') || stem(o.name)).slice(0, 100);
    const w = fs.world(id);
    if (!w) continue;
    if (o.type === 'LIGHT') {
      lights.push({
        label,
        role: 'light',
        x: round4(w[12]),
        y: round4(w[13]),
        width: 0,
        depth: 0,
        height: round4(Math.max(0, w[14])),
        rotationDeg: 0,
        water: false,
      });
      continue;
    }
    if (prop(o, DESK_PROPS.label) === 'ground') {
      const g = String(prop(o, 'desk_ground') ?? '') || label;
      grounds.push({
        label: g.slice(0, 100),
        role: 'ground',
        x: 0,
        y: 0,
        width: stage.width,
        depth: stage.depth,
        height: 0,
        rotationDeg: 0,
        water: false,
      });
      continue;
    }
    const ids = subtree(id);
    const yaw = Math.atan2(w[1], w[0]);
    const b = boundsOf(probe, fs, ids, yaw);
    if (!b) continue;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const water =
      isWater(o) ||
      ids.some((x) => {
        const p = probe.getObject(x);
        return (
          String(prop(p, DESK_SHAPE_PROP) ?? '').toLowerCase() === 'water' ||
          prop(p, STORE_PART_PROP) === 'water'
        );
      });
    const piece: UnitLandmark = {
      label,
      role: 'dressing',
      x: round4(Math.cos(yaw) * cx - Math.sin(yaw) * cy),
      y: round4(Math.sin(yaw) * cx + Math.cos(yaw) * cy),
      width: round4(b.max[0] - b.min[0]),
      depth: round4(b.max[1] - b.min[1]),
      height: round4(Math.max(0, b.max[2] - b.min[2])),
      rotationDeg: round4((yaw * 180) / Math.PI),
      water,
    };
    if (prop(o, DESK_PROPS.label) === 'wall') walls.push({ ...piece, role: 'wall' });
    else if (role(o) === 'landmark') landmarks.push({ ...piece, role: 'landmark' });
    else if (piece.width * piece.depth >= 0.25) dressing.push({ ...piece, area: piece.width * piece.depth });
  }
  dressing.sort((x, y) => y.area - x.area || (x.label < y.label ? -1 : 1));
  const byLabel = (x: UnitLandmark, y: UnitLandmark) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0);
  return [
    ...landmarks.sort(byLabel),
    ...grounds,
    ...walls.sort(byLabel),
    ...dressing.map(({ area: _area, ...d }) => d),
    ...lights.sort(byLabel),
  ].slice(0, MAX_UNIT_LANDMARKS);
}
