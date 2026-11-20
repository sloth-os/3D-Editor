import type { SceneDoc } from '../../doc/scene-doc';
import type { DatablockKind, ObjectData } from '../../doc/types';
import { getShots } from '../shots';
import { UnitError } from './errors';
import { unitRecord, type UnitPayload } from './format';
import { UNIT_ROOT, deriveUnitId } from './ids';
import { requirePin, type UnitPin } from './insert';
import { UNIT_BLOCK_KINDS, type UnitBlockKind } from './kinds';
import { UNIT_PROPS, provenanceProps, requireInstance, splitPartKey, type UnitPartStamp } from './list';
import { mergeForUpdate, partSum16, withUnitProps } from './ownership';
import {
  ANIM_TARGET_KINDS,
  REF_KINDS,
  collectDriverRefs,
  collectRecordRefs,
  mapRecordRefs,
  type UnitRecord,
} from './refs';
import { dataKey, deleteData, unusedData } from './remove';
import { currentSum, sourceIndex, toSourceId, toSourceMap, type UnitPartRef } from './status';
import { updateDrivers } from './drivers';
import { cloneJson } from '../../util/json';

/*
 * Updating an instance to another version (or relinking its slot to another item of the same kind),
 * in one transaction (one undo step):
 *
 * - a part the scene left untouched (its unit-owned fields still match its stamp) takes the new
 *   version's values in place and keeps its id, so shots, holds, constraints, F-curves and desk_actor
 *   keep resolving; its scene-owned fields (names, collections, the root's placement, constraints,
 *   physics, hiding and pose, the scene's props, constraints targeting outside) are kept;
 * - a part edited in the scene is kept as it is and reported ('edited'; with a warning when the new
 *   version changed it too); a part deleted in the scene stays deleted ('deleted');
 * - a part only the new version has is added with a derived id (a datablock nothing uses at that id,
 *   left behind by an instance taken out of the slot before, is deleted for it; remove.ts);
 * - a part the new version drops is removed when the scene left it untouched and nothing that stays
 *   uses it (a record that stays refers to it: another object, a part the update keeps, a camera's
 *   focus; or animation, drivers, shots, the scene camera), with the data and materials only it used;
 *   otherwise it is kept, with what it uses, and taken out of the table ('dropped-but-edited',
 *   'dropped-but-used').
 *
 * A part the update writes is stamped as written: a reference to a part that is not in the scene
 * (deleted here, taken or dropped) is cut, and the stamp is the cut record's, so the part reads
 * untouched afterwards. The unit's drivers follow the same rules, by their own table (unit_drivers,
 * drivers.ts); they are updated before the dropped parts go, so a driver the unit drops is not a use.
 *
 * The same content (an equal body digest) changes no part: only the provenance moves (noop).
 */

export type UnitKeptReason = 'edited' | 'deleted' | 'dropped-but-edited' | 'dropped-but-used';

export interface UnitUpdateReport {
  root: string;
  ref: string;
  /** True when the new version holds the same content: no part changed. */
  noop: boolean;
  from: { ref: string; version: number; digest: string };
  to: { ref: string; version: number; digest: string };
  updated: UnitPartRef[];
  added: UnitPartRef[];
  removed: UnitPartRef[];
  kept: (UnitPartRef & { reason: UnitKeptReason })[];
  warnings: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/**
 * The parts among `drops` ('<kind>:<id>') that nothing staying in the document uses: no record outside
 * them refers to one, and no F-curve, driver, shot, the scene camera or the desk's main pair names
 * one. A dropped part something staying uses stays, and then so does what it uses.
 */
function unusedDrops(doc: SceneDoc, drops: ReadonlySet<string>): Set<string> {
  const going = new Set(drops);
  const refsOf = new Map<string, string[]>();
  const used: string[] = [];
  const use = (key: string) => {
    if (going.has(key)) used.push(key);
  };
  for (const k of REF_KINDS)
    for (const id of doc.map(k).keys()) {
      const rec = doc.readRecord(k, id);
      if (!rec) continue;
      const refs = collectRecordRefs(k, rec).map((r) => dataKey(r.kind, r.id));
      if (going.has(dataKey(k, id))) refsOf.set(dataKey(k, id), refs);
      else refs.forEach(use);
    }
  for (const fc of doc.listFCurves()) {
    const kind = ANIM_TARGET_KINDS[fc.target_type];
    if (kind) use(dataKey(kind, fc.target_id));
  }
  for (const d of doc.listDrivers())
    for (const r of collectDriverRefs(d as unknown as UnitRecord)) use(dataKey(r.kind, r.id));
  for (const s of getShots(doc)) {
    if (s.camera) use(dataKey('objects', s.camera));
    for (const id of s.subjects) use(dataKey('objects', id));
    for (const l of s.layout) use(dataKey('objects', l.subject));
  }
  const scene = doc.getScene();
  if (scene.camera) use(dataKey('objects', scene.camera));
  for (const id of scene.desk?.main_pair ?? []) use(dataKey('objects', id));
  for (let key = used.pop(); key !== undefined; key = used.pop())
    if (going.delete(key)) for (const r of refsOf.get(key) ?? []) use(r);
  return going;
}

/**
 * Updates instance `root` to `unit` (another version of its item, or another item of the same kind),
 * recording `pin` as its provenance. See the module comment. Throws UNIT_NOT_FOUND (not an instance
 * root), UNIT_KIND_MISMATCH (a unit of another kind, or a root of another object type) or
 * UNIT_BAD_SPEC (pin).
 */
export function updateUnit(doc: SceneDoc, root: string, unit: UnitPayload, pin: UnitPin): UnitUpdateReport {
  const p = requirePin(pin);
  const inst = requireInstance(doc, root);
  const header = unit.header;
  if (header.kind !== inst.kind)
    throw new UnitError(
      'UNIT_KIND_MISMATCH',
      `a ${header.kind} unit cannot update the ${inst.kind} instance '${root}'`,
    );
  const curRoot = doc.readRecord('objects', root)!;
  const nextRoot = unit.body.blocks.objects?.[UNIT_ROOT];
  if (!nextRoot || nextRoot.type !== curRoot.type)
    throw new UnitError(
      'UNIT_KIND_MISMATCH',
      `the unit's root is a ${String(nextRoot?.type)}, the instance's a ${String(curRoot.type)}`,
    );
  const report: UnitUpdateReport = {
    root,
    ref: p.ref,
    noop: false,
    from: { ref: inst.ref, version: inst.version, digest: inst.digest },
    to: { ref: p.ref, version: p.version, digest: header.digest },
    updated: [],
    added: [],
    removed: [],
    kept: [],
    warnings: [],
  };
  const writeProvenance = (parts: Map<string, UnitPartStamp>, drivers: Map<string, string>) => {
    const cur = doc.readRecord('objects', root)!;
    doc.updateObject(root, {
      custom_props: {
        ...(cur.custom_props as ObjectData['custom_props']),
        ...provenanceProps({
          ...p,
          digest: header.digest,
          kind: inst.kind,
          key: inst.key,
          name: header.name,
          parts,
          drivers,
        }),
      },
    });
  };
  if (inst.digest === header.digest) {
    report.noop = true;
    const props = curRoot.custom_props as Record<string, unknown>;
    if (
      props[UNIT_PROPS.ref] !== p.ref ||
      props[UNIT_PROPS.version] !== p.version ||
      props[UNIT_PROPS.sha256] !== p.sha256 ||
      props[UNIT_PROPS.name] !== header.name
    )
      doc.transact(() => writeProvenance(inst.parts, inst.drivers));
    return report;
  }

  // the scene id of every part, old and new: old ones keep theirs, new ones derive theirs
  const idOf = new Map<string, string>();
  for (const [pk, s] of inst.parts) idOf.set(pk, s.id);
  const added = new Map<string, string>();
  for (const k of UNIT_BLOCK_KINDS)
    for (const src of Object.keys(unit.body.blocks[k] ?? {})) {
      const pk = `${k}:${src}`;
      if (idOf.has(pk)) continue;
      const id = src === UNIT_ROOT ? root : deriveUnitId(inst.key, src);
      idOf.set(pk, id);
      added.set(pk, id);
    }
  const free = unusedData(
    doc,
    [...added].flatMap(([pk, id]) => {
      const s = splitPartKey(pk);
      return s && s.kind !== 'objects' && doc.has(s.kind, id) ? [dataKey(s.kind, id)] : [];
    }),
  );
  const index = sourceIndex(inst, added);
  const toSrc = toSourceMap(index);
  const members = new Set<string>();
  for (const [pk, id] of idOf) if (pk.startsWith('objects:')) members.add(id);
  const place = (k: DatablockKind, src: string) => ({
    isRoot: k === 'objects' && src === UNIT_ROOT,
    unitKind: inst.kind,
  });

  // what becomes of each part
  type Fate = 'add' | 'update' | 'same' | 'edited' | 'deleted' | 'taken' | 'drop';
  const fate = new Map<string, Fate>();
  const current = new Map<string, UnitRecord | null>();
  const nameOf = (pk: string) => String(current.get(pk)?.name ?? '');
  const refOf = (pk: string): UnitPartRef => {
    const s = splitPartKey(pk)!;
    return { kind: s.kind, src: s.src, id: idOf.get(pk)!, name: nameOf(pk) };
  };
  const keys = new Set([...inst.parts.keys(), ...added.keys()]);
  for (const pk of [...keys].sort()) {
    const s = splitPartKey(pk);
    if (!s) continue;
    const old = inst.parts.get(pk);
    const id = idOf.get(pk)!;
    const cur = free.has(dataKey(s.kind, id)) ? null : doc.readRecord(s.kind, id);
    current.set(pk, cur);
    const next = unitRecord(unit.body, s.kind as UnitBlockKind, s.src);
    if (!old) fate.set(pk, cur ? 'taken' : 'add');
    else if (!next) fate.set(pk, 'drop');
    else if (!cur) fate.set(pk, 'deleted');
    else if (currentSum(s.kind, cur, s.src, inst, toSrc) !== old.sum) fate.set(pk, 'edited');
    else fate.set(pk, partSum16(s.kind, next, place(s.kind, s.src)) === old.sum ? 'same' : 'update');
  }
  const alive = (pk: string) => {
    const f = fate.get(pk);
    return f === 'add' || f === 'update' || f === 'same' || f === 'edited';
  };
  const mapOut = (k: DatablockKind, src: string) => {
    const pk = `${k}:${src}`;
    return alive(pk) ? (idOf.get(pk) ?? null) : null;
  };
  const outside = (id: string) => !members.has(id);

  const table = new Map<string, UnitPartStamp>();
  doc.transact(() => {
    deleteData(doc, free);
    const drops: { kind: DatablockKind; id: string; pk: string }[] = [];
    for (const k of UNIT_BLOCK_KINDS) {
      for (const pk of [...keys].filter((x) => x.startsWith(`${k}:`)).sort()) {
        const src = pk.slice(k.length + 1);
        const id = idOf.get(pk)!;
        const old = inst.parts.get(pk);
        const next = unitRecord(unit.body, k, src);
        const cur = current.get(pk) ?? null;
        const f = fate.get(pk)!;
        const sum = next ? partSum16(k, next, place(k, src)) : null;
        // what the update writes is stamped as written: references to parts not here are cut
        const stamp = () => ({ id, sum: currentSum(k, doc.readRecord(k, id)!, src, inst, toSrc) });
        switch (f) {
          case 'add': {
            const fields = mapRecordRefs(k, withUnitProps(k, next!, place(k, src)), mapOut);
            doc.addRecord(k, id, { ...copyFields(fields), name: String(next!.name ?? 'Unit') });
            current.set(pk, doc.readRecord(k, id));
            table.set(pk, stamp());
            report.added.push(refOf(pk));
            break;
          }
          case 'taken':
            report.warnings.push(
              `the new version's ${k} '${src}' was not added: its id ${id} is taken in the scene`,
            );
            break;
          case 'same':
            table.set(pk, old!);
            break;
          case 'update': {
            const fields = copyFields(mapRecordRefs(k, next!, mapOut));
            doc.replaceRecord(k, id, mergeForUpdate(k, fields, cur!, place(k, src), outside));
            table.set(pk, stamp());
            report.updated.push(refOf(pk));
            break;
          }
          case 'edited':
            table.set(pk, old!);
            report.kept.push({ ...refOf(pk), reason: 'edited' });
            if (sum !== old!.sum)
              report.warnings.push(
                `'${nameOf(pk)}' was edited here and changed in the new version: the scene's is kept`,
              );
            break;
          case 'deleted':
            table.set(pk, old!);
            report.kept.push({ ...refOf(pk), reason: 'deleted' });
            break;
          case 'drop':
            if (!cur) break;
            if (currentSum(k, cur, src, inst, toSrc) !== old!.sum)
              report.kept.push({ ...refOf(pk), reason: 'dropped-but-edited' });
            else drops.push({ kind: k, id, pk });
            break;
        }
      }
    }
    // the unit's drivers, stamped as parts are (drivers.ts), before the dropped parts go: a driver
    // of the unit on a part it drops goes with it and does not keep it
    const drivers = updateDrivers(
      doc,
      inst.drivers,
      unit.body.drivers,
      toSourceId(index),
      mapOut,
      report.warnings,
    );
    const going = unusedDrops(doc, new Set(drops.map((d) => dataKey(d.kind, d.id))));
    const gone = drops.filter((d) => going.has(dataKey(d.kind, d.id)));
    for (const d of drops)
      if (going.has(dataKey(d.kind, d.id))) report.removed.push(refOf(d.pk));
      else report.kept.push({ ...refOf(d.pk), reason: 'dropped-but-used' });
    const objects = gone.filter((d) => d.kind === 'objects').map((d) => d.id);
    if (objects.length) doc.removeObjects(objects);
    for (const d of gone) {
      if (d.kind === 'objects' || !doc.has(d.kind, d.id)) continue;
      if (d.kind === 'materials') doc.removeMaterial(d.id);
      else if (d.kind === 'images') doc.removeImage(d.id);
      else if (d.kind === 'meshes') doc.removeMesh(d.id);
      else doc.map(d.kind).delete(d.id);
    }
    if (inst.kind === 'figure') report.warnings.push(...figureWarnings(doc, root, curRoot, nextRoot, unit));
    writeProvenance(table, drivers);
  });
  return report;
}

/** Top-level copy of a record's fields (byte arrays copied: records of a decoded unit are views into it). */
function copyFields(rec: UnitRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec))
    if (k !== 'id' && v !== undefined) out[k] = v instanceof Uint8Array ? v.slice() : cloneJson(v);
  return out;
}

/** Warnings for a figure update: bones the scene uses that the new rig lacks, proportions changed. */
function figureWarnings(
  doc: SceneDoc,
  root: string,
  before: UnitRecord,
  next: UnitRecord,
  unit: UnitPayload,
): string[] {
  const out: string[] = [];
  const armSrc = typeof next.data === 'string' ? next.data : null;
  const arm = armSrc ? unitRecord(unit.body, 'armatures', armSrc) : null;
  const bones = new Set(
    (Array.isArray(arm?.bones) ? (arm.bones as unknown[]) : []).map((b) =>
      isRecord(b) ? String(b.name) : '',
    ),
  );
  const missing = new Set<string>();
  for (const fc of doc.listFCurves(root)) {
    const m = /^pose\.bones\["(.+?)"\]/.exec(fc.path);
    if (m && !bones.has(m[1])) missing.add(m[1]);
  }
  for (const o of doc.listObjects())
    for (const c of o.constraints ?? [])
      if (c.target === root && c.subtarget && !bones.has(c.subtarget)) missing.add(c.subtarget);
  for (const b of [...missing].sort())
    out.push(`the new figure has no bone '${b}' that the scene's animation or holds use`);
  const h0 = Number((before.custom_props as Record<string, unknown> | undefined)?.desk_height_m);
  const h1 = Number((next.custom_props as Record<string, unknown> | undefined)?.desk_height_m);
  if (Number.isFinite(h0) && Number.isFinite(h1) && Math.abs(h0 - h1) >= 0.005)
    out.push(`the figure's height changes from ${h0} m to ${h1} m: its keyed steps may slide`);
  return out;
}

/** Makes instance `root` local: its provenance goes, its parts stay as plain objects (one transaction). */
export function makeLocal(doc: SceneDoc, root: string): { root: string; parts: number } {
  const inst = requireInstance(doc, root);
  doc.transact(() => {
    const cur = doc.readRecord('objects', root)!;
    const props = { ...(cur.custom_props as Record<string, unknown>) };
    for (const k of Object.keys(props)) if (k.startsWith('unit_')) delete props[k];
    doc.replaceRecord('objects', root, { ...cur, custom_props: props });
  });
  return { root, parts: inst.parts.size };
}
