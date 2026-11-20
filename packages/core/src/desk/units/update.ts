import type { SceneDoc } from '../../doc/scene-doc';
import type { DatablockKind, ObjectData } from '../../doc/types';
import { getShots } from '../shots';
import { UnitError } from './errors';
import type { UnitPayload } from './format';
import { UNIT_ROOT, deriveUnitId } from './ids';
import { requirePin, type UnitPin } from './insert';
import { UNIT_BLOCK_KINDS } from './kinds';
import { UNIT_PROPS, provenanceProps, requireInstance, splitPartKey, type UnitPartStamp } from './list';
import { mergeForUpdate, partSum16 } from './ownership';
import { collectDriverRefs, collectRecordRefs, mapDriverRefs, mapRecordRefs, type UnitRecord } from './refs';
import { currentSum, sourceIndex, toSourceMap, type UnitPartRef } from './status';
import type { DriverData } from '../../doc/types';
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
 * - a part only the new version has is added with a derived id;
 * - a part the new version drops is removed when the scene left it untouched and nothing outside the
 *   instance uses it (animation, drivers, shots, the scene camera, other objects' references), with
 *   the data and materials only it used; otherwise it is kept and taken out of the table
 *   ('dropped-but-edited', 'dropped-but-used').
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

/** The scene ids of objects that something outside `members` uses (animation, drivers, shots, references). */
function usedFromOutside(doc: SceneDoc, members: Set<string>): Set<string> {
  const used = new Set<string>();
  for (const fc of doc.listFCurves()) if (fc.target_type === 'object') used.add(fc.target_id);
  for (const d of doc.listDrivers())
    for (const r of collectDriverRefs(d as unknown as UnitRecord)) if (r.kind === 'objects') used.add(r.id);
  for (const s of getShots(doc)) {
    if (s.camera) used.add(s.camera);
    for (const id of s.subjects) used.add(id);
    for (const l of s.layout) used.add(l.subject);
  }
  const scene = doc.getScene();
  if (scene.camera) used.add(scene.camera);
  for (const id of scene.desk?.main_pair ?? []) used.add(id);
  for (const id of doc.objectIds()) {
    if (members.has(id)) continue;
    const rec = doc.readRecord('objects', id);
    if (rec) for (const r of collectRecordRefs('objects', rec)) if (r.kind === 'objects') used.add(r.id);
  }
  return used;
}

/** Every datablock some record or driver of the document refers to, as '<kind>:<id>'. */
function referencedData(doc: SceneDoc): Set<string> {
  const out = new Set<string>();
  for (const k of UNIT_BLOCK_KINDS)
    for (const id of doc.map(k).keys()) {
      const rec = doc.readRecord(k, id);
      if (rec) for (const r of collectRecordRefs(k, rec)) out.add(`${r.kind}:${r.id}`);
    }
  for (const d of doc.listDrivers())
    for (const r of collectDriverRefs(d as unknown as UnitRecord)) out.add(`${r.kind}:${r.id}`);
  return out;
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
  const writeProvenance = (parts: Map<string, UnitPartStamp>) => {
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
      doc.transact(() => writeProvenance(inst.parts));
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
  const toSrc = toSourceMap(sourceIndex(inst, added));
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
    const cur = doc.readRecord(s.kind, id);
    current.set(pk, cur);
    const next = unit.body.blocks[s.kind as keyof typeof unit.body.blocks]?.[s.src];
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
    let usedOutside: Set<string> | null = null;
    const dropObjects: string[] = [];
    const dropData: { kind: DatablockKind; id: string; pk: string }[] = [];
    for (const k of UNIT_BLOCK_KINDS) {
      for (const pk of [...keys].filter((x) => x.startsWith(`${k}:`)).sort()) {
        const src = pk.slice(k.length + 1);
        const id = idOf.get(pk)!;
        const old = inst.parts.get(pk);
        const next = unit.body.blocks[k]?.[src];
        const cur = current.get(pk) ?? null;
        const f = fate.get(pk)!;
        const sum = next ? partSum16(k, next, place(k, src)) : null;
        switch (f) {
          case 'add': {
            const fields = mapRecordRefs(k, next!, mapOut);
            doc.addRecord(k, id, { ...copyFields(fields), name: String(next!.name ?? 'Unit') });
            current.set(pk, doc.readRecord(k, id));
            table.set(pk, { id, sum: sum! });
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
            table.set(pk, { id, sum: sum! });
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
          case 'drop': {
            if (!cur) break;
            const untouched = currentSum(k, cur, src, inst, toSrc) === old!.sum;
            if (!untouched) {
              report.kept.push({ ...refOf(pk), reason: 'dropped-but-edited' });
              break;
            }
            if (k === 'objects') {
              usedOutside ??= usedFromOutside(doc, members);
              if (usedOutside.has(id)) {
                report.kept.push({ ...refOf(pk), reason: 'dropped-but-used' });
                break;
              }
              dropObjects.push(id);
            } else dropData.push({ kind: k, id, pk });
            report.removed.push(refOf(pk));
            break;
          }
        }
      }
    }
    if (dropObjects.length) doc.removeObjects(dropObjects);
    if (dropData.length) {
      const refs = referencedData(doc);
      for (const d of dropData) {
        if (!doc.has(d.kind, d.id)) continue;
        if (refs.has(`${d.kind}:${d.id}`)) {
          const i = report.removed.findIndex((r) => r.kind === d.kind && r.id === d.id);
          if (i >= 0) report.removed.splice(i, 1);
          report.kept.push({ ...refOf(d.pk), reason: 'dropped-but-used' });
          continue;
        }
        if (d.kind === 'materials') doc.removeMaterial(d.id);
        else if (d.kind === 'images') doc.removeImage(d.id);
        else if (d.kind === 'meshes') doc.removeMesh(d.id);
        else doc.map(d.kind).delete(d.id);
      }
    }
    // drivers of the new version that the scene does not have yet
    for (const d of unit.body.drivers) {
      const mapped = mapDriverRefs(d, mapOut);
      if (!mapped) continue;
      const drv = cloneJson(mapped) as unknown as DriverData;
      if (!doc.listDrivers(drv.target_id).some((x) => x.path === drv.path && x.index === drv.index))
        doc.setDriver(drv);
    }
    if (inst.kind === 'figure') report.warnings.push(...figureWarnings(doc, root, curRoot, nextRoot, unit));
    writeProvenance(table);
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
  const arm = armSrc ? unit.body.blocks.armatures?.[armSrc] : null;
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
