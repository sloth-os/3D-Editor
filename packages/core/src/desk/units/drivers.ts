import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import type { AnimTargetType, DatablockKind, DriverData } from '../../doc/types';
import { cloneJson } from '../../util/json';
import { sha256HexOfText } from '../container/digest';
import { canonicalJsonStrict } from './canonical';
import { OUTSIDE_MARK } from './ownership';
import { ANIM_TARGET_KINDS, mapDriverRefs, type UnitRecord } from './refs';

/*
 * A unit's drivers in its instances. Every driver the unit gave is stamped in the root's
 * unit_drivers table (list.ts) by its key in source ids (the scene's driver key, fcurveKey, with the
 * target's source id: '<target type>:<source id>:<path>:<index>') with the first 16 hex digits of the
 * SHA-256 of its canonical JSON in source ids. An update treats a driver as it treats a part
 * (update.ts): one the scene left as the unit gave it takes the new version, or goes when the new
 * version drops it (when the new version drops the part it drives too, it goes with that part: a
 * dropped part the scene still uses stays, driven as it was); one edited in the scene is kept, with
 * a warning when the new version changed it too; one deleted in the scene stays deleted; a driver
 * only the new version has is added unless the scene drives that channel itself. Drivers outside the
 * table (the scene's own) are never touched. unitStatus (status.ts) names the ones edited or
 * deleted in the scene (driversChanged).
 */

/** A driver's key: its target type, target id, path and index (fcurveKey), ids as the driver has them. */
export const driverKeyOf = (d: UnitRecord): string => fcurveKey(d as unknown as DriverData);

/** The stamp of a driver whose ids are source ids. */
export function driverSum16(d: UnitRecord): string {
  return sha256HexOfText(canonicalJsonStrict(d, 'digest')).slice(0, 16);
}

/** The stamps of the drivers a unit gives (source ids), by key. */
export function driverStamps(drivers: readonly UnitRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of drivers) out.set(driverKeyOf(d), driverSum16(d));
  return out;
}

/** Maps ids both ways: a scene id to its source id ('!<id>' outside the instance) or back (null: none). */
export type IdMap = (kind: DatablockKind, id: string) => string | null;

/** The scene's drivers on the instance's datablocks, by their key in source ids. */
function sceneDrivers(doc: SceneDoc, toSrc: IdMap): Map<string, { scene: DriverData; src: UnitRecord }> {
  const out = new Map<string, { scene: DriverData; src: UnitRecord }>();
  for (const d of doc.listDrivers()) {
    if (!Object.hasOwn(ANIM_TARGET_KINDS, d.target_type)) continue;
    const src = mapDriverRefs(d as unknown as UnitRecord, toSrc);
    if (!src || typeof src.target_id !== 'string' || src.target_id.startsWith(OUTSIDE_MARK)) continue;
    out.set(driverKeyOf(src), { scene: d, src });
  }
  return out;
}

/**
 * The keys of the drivers in `stamps` (an instance's unit_drivers) the scene edited and deleted,
 * sorted; `toSrc` maps scene ids to the instance's source ids.
 */
export function driversChanged(
  doc: SceneDoc,
  stamps: ReadonlyMap<string, string>,
  toSrc: IdMap,
): { edited: string[]; missing: string[] } {
  const edited: string[] = [];
  const missing: string[] = [];
  if (!stamps.size) return { edited, missing };
  const current = sceneDrivers(doc, toSrc);
  for (const key of [...stamps.keys()].sort()) {
    const cur = current.get(key);
    if (!cur) missing.push(key);
    else if (driverSum16(cur.src) !== stamps.get(key)) edited.push(key);
  }
  return { edited, missing };
}

/** The datablocks a driver's variables read (the world and the scene left out). */
export function driverReads(d: DriverData): { kind: DatablockKind; id: string }[] {
  const out: { kind: DatablockKind; id: string }[] = [];
  for (const v of Array.isArray(d.variables) ? (d.variables as unknown[]) : []) {
    if (!v || typeof v !== 'object') continue;
    const { target_type: type, target_id: id } = v as { target_type?: unknown; target_id?: unknown };
    if (typeof type !== 'string' || !Object.hasOwn(ANIM_TARGET_KINDS, type) || typeof id !== 'string')
      continue;
    out.push({ kind: ANIM_TARGET_KINDS[type as AnimTargetType]!, id });
  }
  return out;
}

/** How a driver reads in a warning: its target's name, path and index. */
function driverName(doc: SceneDoc, d: DriverData): string {
  const kind = ANIM_TARGET_KINDS[d.target_type];
  const name = kind ? doc.readRecord(kind, d.target_id)?.name : null;
  return `the driver of '${String(name ?? d.target_id)}' ${d.path}[${d.index}]`;
}

/**
 * Updates the unit's drivers in the scene (inside the update's transaction, after its parts) from the
 * instance's `stamps` to the new version's `next` drivers (source ids), as the module comment says.
 * `toSrc` maps scene ids to source ids, `toScene` source ids to the scene ids of the parts the update
 * keeps (null: none). Returns the new table (`table`), the drivers the new version drops together
 * with the part they drive, left in place (`withPart`: the update removes each with its part, or
 * leaves it to the scene with the part when the scene still uses that), and the scene keys
 * (fcurveKey) of the drivers it wrote or removed (`changed`: a driver the scene edited or deleted, or
 * one the new version gives as it was, is not among them), and pushes warnings.
 */
export function updateDrivers(
  doc: SceneDoc,
  stamps: ReadonlyMap<string, string>,
  next: readonly UnitRecord[],
  toSrc: IdMap,
  toScene: IdMap,
  warnings: string[],
): {
  table: Map<string, string>;
  withPart: DriverData[];
  changed: { added: string[]; updated: string[]; removed: string[] };
} {
  const out = new Map<string, string>();
  const withPart: DriverData[] = [];
  const changed = { added: [] as string[], updated: [] as string[], removed: [] as string[] };
  const current = sceneDrivers(doc, toSrc);
  const nextByKey = new Map(next.map((d) => [driverKeyOf(d), d]));
  const write = (d: UnitRecord, into: string[]): boolean => {
    const placed = mapDriverRefs(d, toScene);
    if (!placed) return false;
    const driver = cloneJson(placed) as unknown as DriverData;
    doc.setDriver(driver);
    into.push(fcurveKey(driver));
    return true;
  };
  for (const key of [...new Set([...stamps.keys(), ...nextByKey.keys()])].sort()) {
    const old = stamps.get(key);
    const nd = nextByKey.get(key);
    const cur = current.get(key);
    if (old === undefined) {
      // new in this version: added unless the scene drives that channel itself
      if (nd && !cur && write(nd, changed.added)) out.set(key, driverSum16(nd));
      continue;
    }
    if (!cur) {
      // deleted here: it stays deleted while the unit has it
      if (nd) out.set(key, old);
      continue;
    }
    if (driverSum16(cur.src) !== old) {
      // edited here: kept (the scene's alone once the new version drops it)
      if (nd) {
        out.set(key, old);
        if (driverSum16(nd) !== old)
          warnings.push(
            `${driverName(doc, cur.scene)} was edited here and changed in the new version: the scene's is kept`,
          );
      }
      continue;
    }
    // left as the unit gave it: the new version's, or gone (with the part it drives when the new
    // version drops that too)
    if (!nd) {
      const kind = ANIM_TARGET_KINDS[cur.src.target_type as AnimTargetType]!;
      if (toScene(kind, String(cur.src.target_id)) === null) withPart.push(cur.scene);
      else {
        doc.removeDriver(fcurveKey(cur.scene));
        changed.removed.push(fcurveKey(cur.scene));
      }
    } else if (driverSum16(nd) === old) out.set(key, old);
    else if (write(nd, changed.updated)) out.set(key, driverSum16(nd));
    else out.set(key, old);
  }
  return { table: out, withPart, changed };
}
