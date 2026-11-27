import type * as Y from 'yjs';
import type { SceneDoc } from '../../doc/scene-doc';
import { docChangeToken } from '../../doc/change-token';
import type { DatablockKind } from '../../doc/types';
import { canonicalJsonStrict } from './canonical';
import { UnitError } from './errors';
import { MAX_UNIT_GENERATION, UNIT_SOURCE_ID_PATTERN, parseSlotKey, type UnitSlot } from './ids';
import { UNIT_BLOCK_KINDS, UNIT_KINDS, type UnitKind } from './kinds';

/*
 * An instance's provenance: custom props on its root object only.
 *
 *   unit_ref      the host's library item id
 *   unit_version  the item's version (a number, from 1)
 *   unit_sha256   the SHA-256 of the unit file the instance holds
 *   unit_digest   the unit's body digest (header.digest)
 *   unit_kind     'set' | 'prop' | 'figure'
 *   unit_key      the instance key (slotKey)
 *   unit_name     the unit's name
 *   unit_parts    canonical JSON {'<kind>:<sourceId>': '<sceneId>:<sum16>'}: every datablock the unit gave
 *                 (the root is 'objects:@root'), with the stamp of what the unit gave it
 *   unit_drivers  canonical JSON {'<target type>:<sourceId>:<path>:<index>': '<sum16>'}: every driver the
 *                 unit gave, with its stamp (drivers.ts); read leniently (absent or malformed: none)
 *   unit_gen      the generation the instance derives its parts' ids in (ids.ts derivePartId: a slot
 *                 whose earlier instance left a part the scene still uses), from 1; absent for
 *                 generation 0, and read leniently (malformed: 0)
 *
 * The table maps scene ids back to the unit's source ids (to publish a new version from the scene),
 * tells parts edited in the scene (their stamp no longer matches) and parts deleted there (absent),
 * and decides what an update may replace or remove. Deleting the root dissolves the instance; its
 * parts stay as plain objects. Malformed provenance reads as no instance.
 */

/** The custom props of an instance root. */
export const UNIT_PROPS = {
  ref: 'unit_ref',
  version: 'unit_version',
  sha256: 'unit_sha256',
  digest: 'unit_digest',
  kind: 'unit_kind',
  key: 'unit_key',
  name: 'unit_name',
  parts: 'unit_parts',
  drivers: 'unit_drivers',
  generation: 'unit_gen',
} as const;

/** A part of an instance as its table records it. */
export interface UnitPartStamp {
  /** The part's scene id. */
  id: string;
  /** The stamp of what the unit gave it (partSum16). */
  sum: string;
}

/** An instance as its root records it. */
export interface UnitInstance {
  root: string;
  ref: string;
  version: number;
  sha256: string;
  digest: string;
  kind: UnitKind;
  key: string;
  name: string;
  /** '<kind>:<sourceId>' → the part. */
  parts: Map<string, UnitPartStamp>;
  /** The unit's drivers: their key in source ids → their stamp (drivers.ts). */
  drivers: Map<string, string>;
  /** The generation the instance derives the ids of the parts it adds in (ids.ts derivePartId). */
  generation: number;
}

/** What listUnits reports of an instance. */
export interface UnitInstanceInfo {
  root: string;
  ref: string;
  version: number;
  sha256: string;
  digest: string;
  kind: UnitKind;
  key: string;
  name: string;
  /** The brief slot its key names (null: an instance of no slot). */
  binding: UnitSlot | null;
  /** Datablocks the unit gave. */
  parts: number;
  /** Of those, the ones still in the document. */
  present: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const STAMP = /^([A-Za-z0-9_-]{1,64}):([0-9a-f]{16})$/;
const SUM16 = /^[0-9a-f]{16}$/;

/** '<kind>:<sourceId>' split (null for a malformed table key). */
export function splitPartKey(key: string): { kind: DatablockKind; src: string } | null {
  const at = key.indexOf(':');
  if (at < 0) return null;
  const kind = key.slice(0, at);
  const src = key.slice(at + 1);
  if (!(UNIT_BLOCK_KINDS as readonly string[]).includes(kind) || !UNIT_SOURCE_ID_PATTERN.test(src))
    return null;
  return { kind: kind as DatablockKind, src };
}

/** The unit_parts text of a table (canonical JSON, keys sorted). */
export function partsTableText(parts: ReadonlyMap<string, UnitPartStamp>): string {
  const o: Record<string, string> = {};
  for (const [k, p] of parts) o[k] = `${p.id}:${p.sum}`;
  return canonicalJsonStrict(o);
}

/** The unit_drivers text of a driver table (canonical JSON, keys sorted). */
export function driversTableText(drivers: ReadonlyMap<string, string>): string {
  return canonicalJsonStrict(Object.fromEntries(drivers));
}

/** A unit_drivers table read leniently: what does not read is no driver (the instance stays one). */
function parseDrivers(text: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof text !== 'string') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
    if (typeof v === 'string' && SUM16.test(v)) out.set(k, v);
  return out;
}

/** How many entries a table prop holds (JSON object text; anything else: 0). */
function tableSize(text: unknown): number {
  if (typeof text !== 'string') return 0;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
  } catch {
    return 0;
  }
}

/**
 * An object's custom props as they leave the editor (glTF node extras, agents' object summaries): an
 * instance root's tables (unit_parts, unit_drivers) give way to how many entries they hold
 * (unit_parts_count, unit_drivers_count); every other prop is as it is.
 */
export function exportedCustomProps<T>(props: Readonly<Record<string, T>>): Record<string, T | number> {
  // a spread copies own data properties (a prop named '__proto__' too), as the copies before did
  const out: Record<string, T | number> = { ...props };
  for (const [table, count] of [
    [UNIT_PROPS.parts, 'unit_parts_count'],
    [UNIT_PROPS.drivers, 'unit_drivers_count'],
  ] as const)
    if (Object.hasOwn(out, table)) {
      const n = tableSize(out[table]);
      delete out[table];
      out[count] = n;
    }
  return out;
}

/** The custom props that make `root` an instance root (unit_gen only from generation 1: see withProvenance). */
export function provenanceProps(
  i: Omit<UnitInstance, 'root' | 'generation'> & { generation?: number },
): Record<string, string | number> {
  return {
    [UNIT_PROPS.ref]: i.ref,
    [UNIT_PROPS.version]: i.version,
    [UNIT_PROPS.sha256]: i.sha256,
    [UNIT_PROPS.digest]: i.digest,
    [UNIT_PROPS.kind]: i.kind,
    [UNIT_PROPS.key]: i.key,
    [UNIT_PROPS.name]: i.name,
    [UNIT_PROPS.parts]: partsTableText(i.parts),
    [UNIT_PROPS.drivers]: driversTableText(i.drivers),
    ...(i.generation ? { [UNIT_PROPS.generation]: i.generation } : {}),
  };
}

/**
 * A root's custom props `props` with provenance `p` (provenanceProps) written over them: a generation
 * `p` leaves out (0) is no longer there either.
 */
export function withProvenance<T>(
  props: Readonly<Record<string, T>> | undefined,
  p: Record<string, string | number>,
): Record<string, T | string | number> {
  const out: Record<string, T | string | number> = { ...props, ...p };
  if (!Object.hasOwn(p, UNIT_PROPS.generation)) delete out[UNIT_PROPS.generation];
  return out;
}

/** A unit_gen value read leniently: a whole number from 1 to MAX_UNIT_GENERATION, else 0. */
function parseGeneration(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_UNIT_GENERATION ? v : 0;
}

function parseInstance(root: string, props: unknown): UnitInstance | null {
  if (!props || typeof props !== 'object') return null;
  const p = props as Record<string, unknown>;
  const ref = p[UNIT_PROPS.ref];
  const version = p[UNIT_PROPS.version];
  const sha256 = p[UNIT_PROPS.sha256];
  const digest = p[UNIT_PROPS.digest];
  const kind = p[UNIT_PROPS.kind];
  const key = p[UNIT_PROPS.key];
  const name = p[UNIT_PROPS.name];
  const table = p[UNIT_PROPS.parts];
  if (
    typeof ref !== 'string' ||
    !ref ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    typeof sha256 !== 'string' ||
    !SHA256.test(sha256) ||
    typeof digest !== 'string' ||
    !SHA256.test(digest) ||
    !(UNIT_KINDS as readonly unknown[]).includes(kind) ||
    typeof key !== 'string' ||
    !key ||
    typeof name !== 'string' ||
    typeof table !== 'string'
  )
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(table);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const parts = new Map<string, UnitPartStamp>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const m = typeof v === 'string' ? STAMP.exec(v) : null;
    if (!m || !splitPartKey(k)) return null;
    parts.set(k, { id: m[1], sum: m[2] });
  }
  const own = parts.get('objects:@root');
  if (!own || own.id !== root) return null;
  const drivers = parseDrivers(p[UNIT_PROPS.drivers]);
  const generation = parseGeneration(p[UNIT_PROPS.generation]);
  return {
    root,
    ref,
    version,
    sha256,
    digest,
    kind: kind as UnitKind,
    key,
    name,
    parts,
    drivers,
    generation,
  };
}

/** The instance whose root is `root` (null: not an instance root, or its provenance does not read). */
export function readInstance(doc: SceneDoc, root: string): UnitInstance | null {
  const y = doc.map('objects').get(root) as Y.Map<unknown> | undefined;
  if (!y || typeof y.get !== 'function') return null;
  return parseInstance(root, y.get('custom_props'));
}

/** The instance whose root is `root`, or UNIT_NOT_FOUND. */
export function requireInstance(doc: SceneDoc, root: string): UnitInstance {
  const i = readInstance(doc, root);
  if (!i) throw new UnitError('UNIT_NOT_FOUND', `'${root}' is not the root of a library unit instance`);
  return i;
}

interface Scan {
  token: string;
  instances: UnitInstance[];
  /** Scene id of every part → its instance's root. */
  owner: Map<string, string>;
}
const scans = new WeakMap<SceneDoc, Scan>();

function scan(doc: SceneDoc): Scan {
  const token = docChangeToken(doc);
  const hit = scans.get(doc);
  if (hit && token !== null && hit.token === token) return hit;
  const instances: UnitInstance[] = [];
  for (const [id, y] of doc.map('objects').entries()) {
    const props = (y as Y.Map<unknown>).get?.('custom_props') as Record<string, unknown> | undefined;
    if (!props || typeof props[UNIT_PROPS.ref] !== 'string') continue;
    const i = parseInstance(id, props);
    if (i) instances.push(i);
  }
  instances.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.root < b.root ? -1 : 1));
  const owner = new Map<string, string>();
  for (const i of instances) for (const p of i.parts.values()) if (!owner.has(p.id)) owner.set(p.id, i.root);
  const s = { token: token ?? '', instances, owner };
  if (token !== null) scans.set(doc, s);
  return s;
}

/** Every instance in the document (by key, then root). Cached until the document changes. */
export function readInstances(doc: SceneDoc): UnitInstance[] {
  return scan(doc).instances;
}

/** The instances in the document, as the desk lists them (by key, then root). */
export function listUnits(doc: SceneDoc): UnitInstanceInfo[] {
  return scan(doc).instances.map((i) => {
    let present = 0;
    for (const [k, p] of i.parts) {
      const s = splitPartKey(k);
      if (s && doc.has(s.kind, p.id)) present++;
    }
    return {
      root: i.root,
      ref: i.ref,
      version: i.version,
      sha256: i.sha256,
      digest: i.digest,
      kind: i.kind,
      key: i.key,
      name: i.name,
      binding: parseSlotKey(i.key),
      parts: i.parts.size,
      present,
    };
  });
}

/** The library versions the document's instances hold, each once, sorted by ref and version. */
export function unitsInUse(doc: SceneDoc): { ref: string; version: number; sha256: string }[] {
  const seen = new Map<string, { ref: string; version: number; sha256: string }>();
  for (const i of scan(doc).instances)
    seen.set(`${i.ref}@${i.version}:${i.sha256}`, { ref: i.ref, version: i.version, sha256: i.sha256 });
  return [...seen.values()].sort((a, b) =>
    a.ref !== b.ref
      ? a.ref < b.ref
        ? -1
        : 1
      : a.version !== b.version
        ? a.version - b.version
        : a.sha256 < b.sha256
          ? -1
          : 1,
  );
}

/** The root of the instance datablock `id` belongs to (its own root for a root; null: none). Cached. */
export function unitOf(doc: SceneDoc, id: string): string | null {
  return scan(doc).owner.get(id) ?? null;
}

/**
 * Whether the document holds an instance of a library unit (a root with a readable unit_parts table):
 * the desk then writes its state as container version 2, which a desk from before units does not read.
 */
export function docHasUnitInstances(doc: SceneDoc): boolean {
  return scan(doc).instances.length > 0;
}
