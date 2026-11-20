import type { SceneDoc } from '../../doc/scene-doc';
import type { DatablockKind } from '../../doc/types';
import { UNIT_ROOT } from './ids';
import { requireInstance, splitPartKey, type UnitInstance } from './list';
import { OUTSIDE_MARK, partSum16 } from './ownership';
import { mapRecordRefs, type RefMap, type UnitRecord } from './refs';

/*
 * What became of an instance's parts in the scene: a part whose unit-owned fields no longer match
 * the stamp the unit gave it was edited here; a part no longer in the document was deleted here.
 * Scene-owned fields (names, placement of the root, holds, physics, the scene's props …) never count.
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

/** The parts of instance `root` edited and deleted in the scene. Throws UNIT_NOT_FOUND. */
export function unitStatus(doc: SceneDoc, root: string): { edited: UnitPartRef[]; missing: UnitPartRef[] } {
  const inst = requireInstance(doc, root);
  const toSrc = toSourceMap(sourceIndex(inst));
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
  return { edited, missing };
}
