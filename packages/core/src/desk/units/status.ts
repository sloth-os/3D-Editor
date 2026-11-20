import type { SceneDoc } from '../../doc/scene-doc';
import type { AnimTargetType, DatablockKind } from '../../doc/types';
import { driversChanged } from './drivers';
import { UNIT_ROOT } from './ids';
import { requireInstance, splitPartKey, type UnitInstance } from './list';
import { OUTSIDE_MARK, partSum16 } from './ownership';
import { ANIM_TARGET_KINDS, mapRecordRefs, type RefMap, type UnitRecord } from './refs';

/*
 * What became of an instance's parts in the scene: a part whose unit-owned fields no longer match
 * the stamp the unit gave it was edited here; a part no longer in the document was deleted here.
 * Scene-owned fields (names, placement of the root, holds, physics, the scene's props …) never count.
 * The drivers the unit gave (unit_drivers, drivers.ts) are told apart the same way, by their stamps.
 */

/** A part of an instance. */
export interface UnitPartRef {
  kind: DatablockKind;
  /** Its source id in the unit. */
  src: string;
  /** Its scene id. */
  id: string;
  /** Its name in the scene ('' when it is gone). */
  name: string;
}

/** A driver the unit gave an instance (drivers.ts). */
export interface UnitDriverRef {
  /** Its key in source ids: '<target type>:<source id>:<path>:<index>'. */
  key: string;
  /** The scene id of the part it drives ('' when the key names no part of the instance). */
  target: string;
}

/** What became of an instance in the scene (unitStatus). */
export interface UnitStatus {
  /** Parts whose unit-owned fields no longer match their stamps. */
  edited: UnitPartRef[];
  /** Parts no longer in the document. */
  missing: UnitPartRef[];
  /**
   * The drivers the unit gave that the scene edited (`edited`) or deleted (`missing`); there only
   * when there is one.
   */
  drivers?: { edited: UnitDriverRef[]; missing: UnitDriverRef[] };
}

/** Scene id → source id, per kind, of an instance's table (and the parts added by `extra`). */
export function sourceIndex(
  inst: UnitInstance,
  extra?: ReadonlyMap<string, string>,
): Map<DatablockKind, Map<string, string>> {
  const out = new Map<DatablockKind, Map<string, string>>();
  const add = (pk: string, id: string) => {
    const s = splitPartKey(pk);
    if (!s) return;
    let m = out.get(s.kind);
    if (!m) out.set(s.kind, (m = new Map()));
    if (!m.has(id)) m.set(id, s.src);
  };
  for (const [pk, p] of inst.parts) add(pk, p.id);
  if (extra) for (const [pk, id] of extra) add(pk, id);
  return out;
}

/** Scene id → the instance's source id ('!<id>' for ids outside it). */
export function toSourceId(
  index: Map<DatablockKind, Map<string, string>>,
): (kind: DatablockKind, id: string) => string {
  return (kind, id) => index.get(kind)?.get(id) ?? `${OUTSIDE_MARK}${id}`;
}

/** A RefMap writing scene ids as the instance's source ids ('!<id>' for ids outside it). */
export function toSourceMap(index: Map<DatablockKind, Map<string, string>>): RefMap {
  return toSourceId(index);
}

/** The stamp a part's current record would have (its unit view, ids as source ids). */
export function currentSum(
  kind: DatablockKind,
  record: UnitRecord,
  src: string,
  inst: Pick<UnitInstance, 'kind'>,
  toSrc: RefMap,
): string {
  return partSum16(kind, mapRecordRefs(kind, record, toSrc), {
    isRoot: kind === 'objects' && src === UNIT_ROOT,
    unitKind: inst.kind,
  });
}

/**
 * The parts of instance `root` edited and deleted in the scene, and the drivers the unit gave that
 * were (UnitStatus). Throws UNIT_NOT_FOUND.
 */
export function unitStatus(doc: SceneDoc, root: string): UnitStatus {
  const inst = requireInstance(doc, root);
  const index = sourceIndex(inst);
  const toSrc = toSourceMap(index);
  const edited: UnitPartRef[] = [];
  const missing: UnitPartRef[] = [];
  for (const [pk, p] of [...inst.parts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const s = splitPartKey(pk);
    if (!s) continue;
    const rec = doc.readRecord(s.kind, p.id);
    if (!rec) {
      missing.push({ kind: s.kind, src: s.src, id: p.id, name: '' });
      continue;
    }
    if (currentSum(s.kind, rec, s.src, inst, toSrc) !== p.sum)
      edited.push({ kind: s.kind, src: s.src, id: p.id, name: String(rec.name ?? '') });
  }
  const changed = driversChanged(doc, inst.drivers, toSourceId(index));
  if (!changed.edited.length && !changed.missing.length) return { edited, missing };
  /** The driver whose key is `key`, with the scene id of the part it drives. */
  const driverRef = (key: string): UnitDriverRef => {
    const [type, src] = key.split(':');
    const kind = Object.hasOwn(ANIM_TARGET_KINDS, type)
      ? ANIM_TARGET_KINDS[type as AnimTargetType]
      : undefined;
    const part = kind ? inst.parts.get(`${kind}:${src}`) : undefined;
    return { key, target: part?.id ?? '' };
  };
  return {
    edited,
    missing,
    drivers: { edited: changed.edited.map(driverRef), missing: changed.missing.map(driverRef) },
  };
}
