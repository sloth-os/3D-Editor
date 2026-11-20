import { z } from 'zod';
import { SCHEMA_VERSION, type ObjectType } from '../../doc/types';
import { ACTOR_KINDS } from '../characters/types';
import { ContainerError, UNIT_MAGIC, readContainerPrefix, writeContainer } from '../container/framing';
import { gunzipBounded, gzipDeterministic } from '../container/gzip';
import { sha256Hex, sha256HexOfText } from '../container/digest';
import { BlobTable, canonicalJsonStrict, isBlobRef } from './canonical';
import { UnitError } from './errors';
import { UNIT_ROOT, UNIT_SOURCE_ID_PATTERN } from './ids';
import { UNIT_BLOCK_KINDS, UNIT_KINDS, type UnitBlockKind, type UnitKind } from './kinds';
import { ANIM_TARGET_KINDS, collectDriverRefs, collectRecordRefs, type UnitRecord } from './refs';
import { DESK_PROPS } from '../props';

/*
 * The library unit file (docs/embedding.md, "Library units"; docs/architecture.md, "Library units"):
 *
 *   the container (desk/container): magic "3DUNIT\r\n", container version 1, codec 1 (gzip),
 *   the header: canonical JSON (sorted keys, no time, floats rounded to 1e-4 by the writer),
 *   the payload: the body gzipped deterministically.
 *
 * The body is u32 LE manifest length | the manifest (canonical JSON, UTF-8) | the blob bytes, in
 * order. The manifest is {blobs: [byte length of each blob], blocks: {kind: {sourceId: record}},
 * drivers: [driver], root: '@root'}: every datablock's stored fields (minus `id`), ids written as the
 * unit's source ids, and every byte array (mesh data, shape keys, vertex weights, image bytes) moved
 * into the blob table, identical bytes stored once. header.digest is the SHA-256 of the unpacked body:
 * the content's identity (rideo's library and the protocol pin the SHA-256 of the whole file).
 *
 * The same content gives the same bytes in every browser, worker and Node. Reading is bounded: the
 * file is at most 32 MiB, its header 64 KiB, its body 128 MiB, 20,000 records and 50,000 blobs; the
 * body unpacks into one buffer of exactly bodyBytes; its digest, its manifest and every reference in it
 * (each must name a datablock of the unit) are checked before anything is inserted. Decoding is the
 * gate: what decodes inserts. The manifest nests at most MAX_UNIT_DEPTH deep, holds only finite
 * numbers and no key '__proto__', 'constructor' or 'prototype', references are looked up as own
 * properties only, and a figure's body is the actor its header describes (role, kind, height, rig).
 * A byte array shared in the file is copied at each reference when inserted, so the body counted
 * with every reference written out (expandedBytes) is held to the body's limit too.
 */

/** The `format` of a unit file (the protocol's UNIT_DATA_FORMAT). */
export const UNIT_FORMAT = '3d-editor.desk-unit';
/** The header's version (the protocol's UNIT_DATA_VERSION). */
export const UNIT_VERSION = 1;
/** The container version a unit file is written with (byte 8). */
export const UNIT_CONTAINER_VERSION = 1;
/** Largest unit file (the protocol's MAX_UNIT_BYTES, capabilities.units.maxBytes): 32 MiB. */
export const MAX_UNIT_BYTES = 32 * 1024 * 1024;
/** Largest unpacked body: 128 MiB. */
export const MAX_UNIT_BODY_BYTES = 128 * 1024 * 1024;
/** Largest header: 64 KiB (encodeUnit refuses a larger one with UNIT_TOO_LARGE). */
export const MAX_UNIT_HEADER_BYTES = 64 * 1024;
/** Most records (datablocks) a body holds. */
export const MAX_UNIT_RECORDS = 20_000;
/** Most blobs a body holds. */
export const MAX_UNIT_BLOBS = 50_000;
/** Longest unit name. */
export const MAX_UNIT_NAME_LENGTH = 120;
/** Most credits a header holds. */
export const MAX_UNIT_CREDITS = 64;
/** Most landmarks a set's header holds. */
export const MAX_UNIT_LANDMARKS = 128;
/** Most credits a publish meta holds (the protocol's limit). */
export const MAX_UNIT_META_CREDITS = 32;
/** Largest publish meta, as JSON in UTF-8 (the protocol's MAX_UNIT_META_BYTES): 16 KiB. */
export const MAX_UNIT_META_BYTES = 16 * 1024;
/** Deepest a body's manifest nests (honest records are under about 10 deep): deeper is UNIT_CORRUPT. */
export const MAX_UNIT_DEPTH = 64;
/** Heights (m) closer than this are the same rig (a figure's body and header; an actor and a figure). */
export const FIGURE_HEIGHT_TOLERANCE_M = 0.005;

/** Keys no record has: built into an object, '__proto__' would set its prototype. UNIT_BAD_RECORD. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const Num = z.number().finite();
const Vec3 = z.tuple([Num, Num, Num]);
const Count = z.number().int().min(0);
const Hex6 = z.string().regex(/^#[0-9a-f]{6}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Who made the models a unit holds (store models and built-ins alike), grouped by their store id. */
export const UnitCreditSchema = z.object({
  /** The model's name (its root object's, without a '.NNN' suffix). */
  name: z.string().min(1).max(120),
  storeId: z.string().min(1).max(200),
  source: z.string().max(64),
  /** An SPDX licence id ('unknown' when the model had none). */
  license: z.string().min(1).max(64),
  author: z.string().max(200).nullable(),
  sourceUrl: z.string().max(500).nullable(),
  /** How many roots of the model the unit holds. */
  objects: z.number().int().min(1),
});
export type UnitCredit = z.infer<typeof UnitCreditSchema>;

/** What a set landmark is. */
export const UNIT_LANDMARK_ROLES = ['ground', 'wall', 'landmark', 'dressing', 'light'] as const;

/**
 * A piece of a set, in editor axes (x right, y away from the front, z up) and metres, the set's root
 * at identity: the box of its meshes in its own turned frame (rotationDeg about z), x and y its centre,
 * height its extent in z; a light's size is 0.
 */
export const UnitLandmarkSchema = z.object({
  label: z.string().max(100),
  role: z.enum(UNIT_LANDMARK_ROLES),
  x: Num,
  y: Num,
  width: Num.min(0),
  depth: Num.min(0),
  height: Num.min(0),
  rotationDeg: Num,
  water: z.boolean(),
});
export type UnitLandmark = z.infer<typeof UnitLandmarkSchema>;

export const UnitCountsSchema = z.object({
  objects: Count,
  meshes: Count,
  materials: Count,
  images: Count,
  armatures: Count,
  curves: Count,
  lights: Count,
  cameras: Count,
  collections: Count,
  drivers: Count,
  vertices: Count,
  faces: Count,
  triangles: Count,
  /** Bytes of the blob table (each distinct byte array once). */
  blobBytes: Count,
});
export type UnitCounts = z.infer<typeof UnitCountsSchema>;

/** A set's facts: the walkable stage, interior, its ground and pieces. */
export const UnitSetFactsSchema = z.object({
  /** The stage (desk settings' set size, else the pieces' extent; at most 200 m). */
  width: Num.min(0),
  depth: Num.min(0),
  interior: z.boolean(),
  hasGround: z.boolean(),
  /** Height of the ground's origin (a set's ground is expected at 0). */
  groundZ: Num,
  /** Practical lights (point, spot, area). */
  lights: Count,
  /** Landmarks, the ground, walls, dressing with a footprint of 0.25 m² or more (largest first), lights. */
  landmarks: z.array(UnitLandmarkSchema).max(MAX_UNIT_LANDMARKS),
});
/** A prop's facts: its label, size at scale 1 and how far its base is below its origin. */
export const UnitPropFactsSchema = z.object({
  label: z.string().max(100),
  dimensions: z.tuple([Num.min(0), Num.min(0), Num.min(0)]),
  /** The lowest z of its meshes, its root at identity (place the root at z = −base to stand it on the ground). */
  base: Num,
  storeId: z.string().max(200).nullable(),
});
/** A figure's facts: the actor's kind, height, colour, rig and look. */
export const UnitFigureFactsSchema = z.object({
  kind: z.enum(ACTOR_KINDS),
  heightM: z.number().min(0.05).max(8),
  color: Hex6,
  bones: Count,
  /** The actor's parts (objects carrying desk_actor). */
  parts: Count,
  /** rigDigest of the armature's bone names in order (staging compares it with the kind's rig). */
  rig: Sha256,
  materials: z.array(z.object({ name: z.string().max(64), color: Hex6 })).max(8),
});

const HEADER_FIELDS = {
  format: z.literal(UNIT_FORMAT),
  version: z.literal(UNIT_VERSION),
  kind: z.enum(UNIT_KINDS),
  name: z.string().min(1).max(MAX_UNIT_NAME_LENGTH),
  /** The SHA-256 of the unpacked body: the content's identity. */
  digest: Sha256,
  bodyBytes: z.number().int().min(1).max(MAX_UNIT_BODY_BYTES),
  /** The document schema version of the writer (SCHEMA_VERSION). */
  schemaVersion: z.number().int().min(1),
  /** The desk version that wrote the unit. */
  deskVersion: z.string().max(64),
  counts: UnitCountsSchema,
  /**
   * The bounds of its meshes at rest, its root at identity, rounded to 1e-4 (null: no meshes); a
   * set's are its own, without the world beyond the set its ground reaches out to (set.ts groundMesh).
   */
  bounds: z.object({ min: Vec3, max: Vec3 }).nullable(),
  credits: z.array(UnitCreditSchema).max(MAX_UNIT_CREDITS),
  set: UnitSetFactsSchema.optional(),
  prop: UnitPropFactsSchema.optional(),
  figure: UnitFigureFactsSchema.optional(),
};

const kindBlock = (
  h: { kind: UnitKind; set?: unknown; prop?: unknown; figure?: unknown },
  ctx: z.RefinementCtx,
) => {
  for (const k of UNIT_KINDS)
    if ((h[k] !== undefined) !== (h.kind === k))
      ctx.addIssue({
        code: 'custom',
        path: [k],
        message: h.kind === k ? `a ${k} unit has its '${k}' facts` : `only a ${k} unit has '${k}' facts`,
      });
};

/**
 * A unit's header. Reading strips keys it does not know (a later desk may add some); writing
 * (encodeUnit) allows none.
 */
export const UnitHeaderSchema = z.object(HEADER_FIELDS).superRefine(kindBlock);
const StrictHeaderSchema = z.object(HEADER_FIELDS).strict().superRefine(kindBlock);
export type UnitHeader = z.infer<typeof UnitHeaderSchema>;

/** What encodeUnit is given for the header: the rest (format, version, digest, sizes) it computes. */
export type UnitHeaderInput = Omit<UnitHeader, 'format' | 'version' | 'digest' | 'bodyBytes' | 'counts'> & {
  counts: Omit<UnitCounts, 'blobBytes'> & { blobBytes?: number };
};

/** A unit's records: datablocks by kind and source id, and the drivers that lie wholly inside it. */
export interface UnitBody {
  root: typeof UNIT_ROOT;
  blocks: Partial<Record<UnitBlockKind, Record<string, UnitRecord>>>;
  drivers: UnitRecord[];
}

/** A decoded unit: its header, its body (byte arrays are views into the unpacked body: read only) and the file. */
export interface UnitPayload {
  header: UnitHeader;
  body: UnitBody;
  bytes: Uint8Array;
  /**
   * The body's size with every blob reference written out: what inserting the unit copies into a
   * scene (byte arrays shared in the file are copied at each reference). It is header.bodyBytes when
   * each blob is referred to once, and at most MAX_UNIT_BODY_BYTES.
   */
  expandedBytes: number;
}

// ---------------------------------------------------------------- body checks

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/**
 * Record `src` of a body's `kind` (own properties only: a source id named like a member of
 * Object.prototype, 'toString' or 'valueOf', is no record unless the unit holds one by that id).
 */
export function unitRecord(body: UnitBody, kind: UnitBlockKind, src: string): UnitRecord | undefined {
  const m = Object.hasOwn(body.blocks, kind) ? body.blocks[kind] : undefined;
  return m && Object.hasOwn(m, src) ? m[src] : undefined;
}

/** The object types a unit may hold. */
const OBJECT_TYPES: readonly ObjectType[] = ['MESH', 'EMPTY', 'CAMERA', 'LIGHT', 'CURVE', 'FONT', 'ARMATURE'];

/**
 * Checks a body: known block kinds (else UNIT_SCHEMA_NEWER when reading), source ids, a root object
 * fitting the kind, records that are objects with a name (objects with a known type), the record
 * limit and closed references (each names a datablock of the unit). UNIT_BAD_RECORD otherwise.
 */
export function checkUnitBody(body: UnitBody, kind: UnitKind | null, reading: boolean): void {
  if (!isRecord(body) || body.root !== UNIT_ROOT || !isRecord(body.blocks) || !Array.isArray(body.drivers))
    throw new UnitError('UNIT_BAD_RECORD', "the body is not {root: '@root', blocks, drivers}");
  let records = 0;
  for (const [k, m] of Object.entries(body.blocks)) {
    if (!(UNIT_BLOCK_KINDS as readonly string[]).includes(k))
      throw new UnitError(
        reading ? 'UNIT_SCHEMA_NEWER' : 'UNIT_BAD_RECORD',
        reading
          ? `the unit holds '${k}' records, which this desk does not know (made by a newer desk)`
          : `'${k}' is not a kind of datablock a unit holds`,
      );
    if (!isRecord(m)) throw new UnitError('UNIT_BAD_RECORD', `the unit's ${k} are not a map of records`);
    for (const [src, rec] of Object.entries(m)) {
      records++;
      if (!UNIT_SOURCE_ID_PATTERN.test(src) || (src === UNIT_ROOT && k !== 'objects'))
        throw new UnitError('UNIT_BAD_RECORD', `'${src}' is not a source id of ${k}`);
      if (!isRecord(rec) || typeof rec.name !== 'string')
        throw new UnitError('UNIT_BAD_RECORD', `${k} '${src}' is not a record with a name`);
      if (k === 'objects' && !(OBJECT_TYPES as readonly unknown[]).includes(rec.type))
        throw new UnitError('UNIT_BAD_RECORD', `object '${src}' has no known type`);
    }
  }
  // a driver is a record too: each one is written into the scene and stamped
  records += body.drivers.length;
  if (records > MAX_UNIT_RECORDS)
    throw new UnitError('UNIT_TOO_LARGE', `the unit holds ${records} records, over ${MAX_UNIT_RECORDS}`);
  const root = body.blocks.objects?.[UNIT_ROOT];
  if (!root) throw new UnitError('UNIT_BAD_RECORD', "the unit has no root object ('@root')");
  if (kind === 'figure' && root.type !== 'ARMATURE')
    throw new UnitError('UNIT_BAD_RECORD', "a figure's root is an armature");
  if (kind === 'set' && root.type !== 'EMPTY')
    throw new UnitError('UNIT_BAD_RECORD', "a set's root is an empty");
  if (root.type === 'CAMERA') throw new UnitError('UNIT_BAD_RECORD', 'a unit holds no cameras as its root');
  const has = (kind: string, id: string) =>
    (UNIT_BLOCK_KINDS as readonly string[]).includes(kind) && !!unitRecord(body, kind as UnitBlockKind, id);
  for (const [k, m] of Object.entries(body.blocks) as [UnitBlockKind, Record<string, UnitRecord>][])
    for (const [src, rec] of Object.entries(m))
      for (const ref of collectRecordRefs(k, rec))
        if (!has(ref.kind, ref.id))
          throw new UnitError(
            'UNIT_BAD_RECORD',
            `${k} '${src}' refers to ${ref.kind} '${ref.id}' (${ref.site}), which the unit does not hold`,
          );
  for (const d of body.drivers) {
    if (!isRecord(d)) throw new UnitError('UNIT_BAD_RECORD', 'a driver is not a record');
    // what a driver writes lies inside the unit: never the scene's world or settings (a variable may
    // read them: that is no write)
    if (
      !Object.hasOwn(ANIM_TARGET_KINDS, String(d.target_type)) ||
      typeof d.target_id !== 'string' ||
      typeof d.path !== 'string' ||
      !Number.isInteger(d.index)
    )
      throw new UnitError(
        'UNIT_BAD_RECORD',
        `a driver drives ${JSON.stringify(String(d.target_type))} '${String(d.path)}', not a datablock of the unit`,
      );
    for (const ref of collectDriverRefs(d))
      if (!has(ref.kind, ref.id))
        throw new UnitError(
          'UNIT_BAD_RECORD',
          `a driver refers to ${ref.kind} '${ref.id}', which the unit does not hold`,
        );
  }
}

// ---------------------------------------------------------------- body bytes

/** The body's bytes: the manifest (blobs taken out) and the blob bytes. Deterministic. */
export function encodeUnitBody(body: UnitBody): { bytes: Uint8Array; blobBytes: number; blobs: number } {
  const blobs = new BlobTable();
  const kinds = (Object.keys(body.blocks) as UnitBlockKind[])
    .filter((k) => Object.keys(body.blocks[k] ?? {}).length)
    .sort();
  const blockText = kinds
    .map((k) => {
      const m = body.blocks[k]!;
      const recs = Object.keys(m)
        .sort()
        .map((src) => `${JSON.stringify(src)}:${canonicalJsonStrict(m[src], blobs)}`);
      return `${JSON.stringify(k)}:{${recs.join(',')}}`;
    })
    .join(',');
  const drivers = body.drivers.map((d) => canonicalJsonStrict(d)).sort();
  if (blobs.list.length > MAX_UNIT_BLOBS)
    throw new UnitError(
      'UNIT_TOO_LARGE',
      `the unit holds ${blobs.list.length} blobs, over ${MAX_UNIT_BLOBS}`,
    );
  const manifest =
    `{"blobs":[${blobs.list.map((b) => b.length).join(',')}],"blocks":{${blockText}},` +
    `"drivers":[${drivers.join(',')}],"root":${JSON.stringify(UNIT_ROOT)}}`;
  const text = new TextEncoder().encode(manifest);
  const total = 4 + text.length + blobs.bytes;
  if (total > MAX_UNIT_BODY_BYTES)
    throw new UnitError(
      'UNIT_TOO_LARGE',
      `the unit's body would be ${total} bytes, over ${MAX_UNIT_BODY_BYTES}`,
    );
  // what decoding allows: the body with its shared blobs written out at every reference
  const expanded = 4 + text.length + blobs.refBytes;
  if (expanded > MAX_UNIT_BODY_BYTES)
    throw new UnitError(
      'UNIT_TOO_LARGE',
      `the unit would be ${expanded} bytes in a scene (its shared byte arrays copied at each use), over ${MAX_UNIT_BODY_BYTES}`,
    );
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, text.length, true);
  out.set(text, 4);
  let at = 4 + text.length;
  for (const b of blobs.list) {
    out.set(b, at);
    at += b.length;
  }
  return { bytes: out, blobBytes: blobs.bytes, blobs: blobs.list.length };
}

/** A body from its bytes (byte arrays are views into `bytes`). UNIT_CORRUPT when the manifest does not read. */
export function decodeUnitBody(bytes: Uint8Array): UnitBody {
  return readUnitBody(bytes).body;
}

/**
 * A body from its bytes and its size with every blob reference written out (UnitPayload's
 * expandedBytes): UNIT_TOO_LARGE past MAX_UNIT_BODY_BYTES, as a file of a few KiB could refer to one
 * large blob any number of times and each reference is a copy in the scene.
 */
function readUnitBody(bytes: Uint8Array): { body: UnitBody; expandedBytes: number } {
  if (bytes.length < 4) throw new UnitError('UNIT_CORRUPT', 'the body is cut short');
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + n > bytes.length) throw new UnitError('UNIT_CORRUPT', "the body's manifest is cut short");
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + n)));
  } catch {
    throw new UnitError('UNIT_CORRUPT', "the body's manifest does not read");
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.blobs) || !isRecord(manifest.blocks))
    throw new UnitError('UNIT_CORRUPT', "the body's manifest is not {blobs, blocks, drivers, root}");
  if (manifest.blobs.length > MAX_UNIT_BLOBS)
    throw new UnitError(
      'UNIT_TOO_LARGE',
      `the unit holds ${manifest.blobs.length} blobs, over ${MAX_UNIT_BLOBS}`,
    );
  const blobs: Uint8Array[] = [];
  let at = 4 + n;
  for (const len of manifest.blobs) {
    if (!Number.isInteger(len) || (len as number) < 0 || at + (len as number) > bytes.length)
      throw new UnitError('UNIT_CORRUPT', "the body's blob table does not fit its bytes");
    blobs.push(bytes.subarray(at, at + (len as number)));
    at += len as number;
  }
  if (at !== bytes.length) throw new UnitError('UNIT_CORRUPT', 'the body has bytes after its blobs');
  let expandedBytes = 4 + n;
  // recursion is bounded by the depth limit, so a deep manifest is refused, not a stack overflow
  const thaw = (v: unknown, depth: number): unknown => {
    if (depth > MAX_UNIT_DEPTH)
      throw new UnitError('UNIT_CORRUPT', `the body's manifest nests deeper than ${MAX_UNIT_DEPTH}`);
    if (typeof v === 'number') {
      if (!Number.isFinite(v))
        throw new UnitError('UNIT_BAD_RECORD', 'a record holds a number that is not finite');
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => thaw(x, depth + 1));
    if (isBlobRef(v)) {
      const i = v.$blob;
      if (!Number.isInteger(i) || i < 0 || i >= blobs.length)
        throw new UnitError(
          'UNIT_BAD_RECORD',
          `a record refers to blob ${String(i)}, which the body does not hold`,
        );
      expandedBytes += blobs[i].length;
      if (expandedBytes > MAX_UNIT_BODY_BYTES)
        throw new UnitError(
          'UNIT_TOO_LARGE',
          `its records refer to its byte arrays for over ${MAX_UNIT_BODY_BYTES} bytes, each reference a copy in the scene`,
        );
      return blobs[i];
    }
    if (isRecord(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) throw new UnitError('UNIT_BAD_RECORD', `a record has the key '${k}'`);
        o[k] = thaw(x, depth + 1);
      }
      return o;
    }
    return v;
  };
  const body: UnitBody = {
    root: manifest.root as typeof UNIT_ROOT,
    blocks: thaw(manifest.blocks, 0) as UnitBody['blocks'],
    drivers: Array.isArray(manifest.drivers) ? (thaw(manifest.drivers, 0) as UnitRecord[]) : (null as never),
  };
  return { body, expandedBytes };
}

/**
 * UNIT_BAD_RECORD unless a figure's body is the actor its header describes: its root an actor
 * (desk_role 'actor') of the header's kind and height (within 5 mm), its armature's bones the rig the
 * header names. Extraction writes exactly these, so only a crafted or damaged file fails.
 */
function checkFigureBody(body: UnitBody, figure: NonNullable<UnitHeader['figure']>): void {
  const root = unitRecord(body, 'objects', UNIT_ROOT);
  const props = isRecord(root?.custom_props) ? root.custom_props : {};
  const arm = typeof root?.data === 'string' ? unitRecord(body, 'armatures', root.data) : undefined;
  const bones = Array.isArray(arm?.bones) ? (arm.bones as unknown[]) : [];
  const height = Number(props[DESK_PROPS.heightM]);
  const why =
    props[DESK_PROPS.role] !== 'actor'
      ? 'its root is not an actor'
      : props[DESK_PROPS.kind] !== figure.kind
        ? `its root is a ${String(props[DESK_PROPS.kind])}, not a ${figure.kind}`
        : !(Math.abs(height - figure.heightM) < FIGURE_HEIGHT_TOLERANCE_M)
          ? `its root is ${String(props[DESK_PROPS.heightM])} m tall, not ${figure.heightM} m`
          : rigDigest(bones.map((b) => String(isRecord(b) ? (b.name ?? '') : ''))) !== figure.rig
            ? "its armature's bones are not the rig its header names"
            : null;
  if (why)
    throw new UnitError('UNIT_BAD_RECORD', `the figure's body is not the one its header describes: ${why}`);
}

// ---------------------------------------------------------------- files

const CONTAINER_CODES: Record<ContainerError['code'], UnitError['code']> = {
  not_ours: 'UNIT_NOT_A_UNIT',
  version: 'UNIT_VERSION',
  codec: 'UNIT_CORRUPT',
  header_too_large: 'UNIT_TOO_LARGE',
  cut_short: 'UNIT_CORRUPT',
  bad_header: 'UNIT_CORRUPT',
  corrupt: 'UNIT_CORRUPT',
  too_large: 'UNIT_TOO_LARGE',
};

function fromContainer<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ContainerError)
      throw new UnitError(CONTAINER_CODES[err.code], `the unit file: ${err.message}`);
    throw err;
  }
}

const issues = (e: z.ZodError) =>
  e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'header'}: ${i.message}`)
    .join('; ');

/**
 * A unit file: the body and the header (its format, version, digest and sizes computed here). The same
 * body and header give the same bytes. Throws UNIT_BAD_RECORD (a body that would not read back),
 * UNIT_BAD_SPEC (a header that does not fit UnitHeaderSchema), UNIT_TOO_LARGE (body over 128 MiB,
 * header over 64 KiB, file over 32 MiB).
 */
export function encodeUnit(body: UnitBody, header: UnitHeaderInput): Uint8Array {
  checkUnitBody(body, header.kind, false);
  const encoded = encodeUnitBody(body);
  const full = {
    ...header,
    counts: { ...header.counts, blobBytes: encoded.blobBytes },
    format: UNIT_FORMAT,
    version: UNIT_VERSION,
    digest: sha256Hex(encoded.bytes),
    bodyBytes: encoded.bytes.length,
  };
  const parsed = StrictHeaderSchema.safeParse(full);
  if (!parsed.success)
    throw new UnitError('UNIT_BAD_SPEC', `the unit's header is not valid (${issues(parsed.error)})`);
  const headerBytes = new TextEncoder().encode(canonicalJsonStrict(full));
  if (headerBytes.length > MAX_UNIT_HEADER_BYTES)
    throw new UnitError(
      'UNIT_TOO_LARGE',
      `the unit's header would be ${headerBytes.length} bytes, over the ${MAX_UNIT_HEADER_BYTES} it may have`,
    );
  const file = writeContainer({
    magic: UNIT_MAGIC,
    version: UNIT_CONTAINER_VERSION,
    codec: 'gzip',
    header: headerBytes,
    payload: gzipDeterministic(encoded.bytes),
  });
  if (file.length > MAX_UNIT_BYTES)
    throw new UnitError(
      'UNIT_TOO_LARGE',
      `the unit file would be ${file.length} bytes, over ${MAX_UNIT_BYTES}`,
    );
  return file;
}

function readFile(bytes: Uint8Array): { header: UnitHeader; codec: 'gzip' | null; payload: Uint8Array } {
  if (!(bytes instanceof Uint8Array)) throw new UnitError('UNIT_NOT_A_UNIT', 'a unit file is bytes');
  if (bytes.length > MAX_UNIT_BYTES)
    throw new UnitError('UNIT_TOO_LARGE', `the unit file is ${bytes.length} bytes, over ${MAX_UNIT_BYTES}`);
  const prefix = fromContainer(() =>
    readContainerPrefix(bytes, {
      magic: UNIT_MAGIC,
      versions: [UNIT_CONTAINER_VERSION],
      maxHeaderBytes: MAX_UNIT_HEADER_BYTES,
    }),
  );
  const h = prefix.header;
  if (!isRecord(h)) throw new UnitError('UNIT_CORRUPT', "the unit's header is not an object");
  if (h.format !== UNIT_FORMAT)
    throw new UnitError('UNIT_NOT_A_UNIT', `its format is ${JSON.stringify(h.format)}, not '${UNIT_FORMAT}'`);
  if (h.version !== UNIT_VERSION)
    throw new UnitError(
      'UNIT_VERSION',
      `it is a unit of version ${JSON.stringify(h.version)}; this desk reads ${UNIT_VERSION}`,
    );
  if (typeof h.schemaVersion === 'number' && h.schemaVersion > SCHEMA_VERSION)
    throw new UnitError(
      'UNIT_SCHEMA_NEWER',
      `it was made by a newer desk (document schema ${h.schemaVersion}; this desk reads ${SCHEMA_VERSION})`,
    );
  if (typeof h.bodyBytes === 'number' && h.bodyBytes > MAX_UNIT_BODY_BYTES)
    throw new UnitError('UNIT_TOO_LARGE', `it unpacks to ${h.bodyBytes} bytes, over ${MAX_UNIT_BODY_BYTES}`);
  const parsed = UnitHeaderSchema.safeParse(h);
  if (!parsed.success)
    throw new UnitError('UNIT_CORRUPT', `its header does not read (${issues(parsed.error)})`);
  return { header: parsed.data, codec: prefix.codec, payload: prefix.payload };
}

/**
 * A unit file's header, read without unpacking its body (cheap: the prefix and the header only).
 * Throws UNIT_NOT_A_UNIT, UNIT_VERSION, UNIT_SCHEMA_NEWER, UNIT_TOO_LARGE or UNIT_CORRUPT.
 */
export function readUnitHeader(bytes: Uint8Array): UnitHeader {
  return readFile(bytes).header;
}

/**
 * A unit file read in full: its header, its body unpacked (bounded) and checked against the digest,
 * the manifest and its references. Throws UNIT_NOT_A_UNIT, UNIT_VERSION, UNIT_SCHEMA_NEWER,
 * UNIT_TOO_LARGE, UNIT_CORRUPT or UNIT_BAD_RECORD.
 */
export function decodeUnit(bytes: Uint8Array): UnitPayload {
  const { header, codec, payload } = readFile(bytes);
  let body: Uint8Array;
  if (codec === 'gzip') body = fromContainer(() => gunzipBounded(payload, header.bodyBytes));
  else if (payload.length !== header.bodyBytes)
    throw new UnitError('UNIT_CORRUPT', 'its body is not as long as its header says');
  else body = payload.slice();
  if (sha256Hex(body) !== header.digest)
    throw new UnitError('UNIT_CORRUPT', 'its body does not match its digest');
  let decoded: UnitBody;
  let expandedBytes: number;
  try {
    ({ body: decoded, expandedBytes } = readUnitBody(body));
    checkUnitBody(decoded, header.kind, true);
    if (header.figure) checkFigureBody(decoded, header.figure);
  } catch (err) {
    // a record of a shape no check foresaw is the unit's fault (out of memory is not: it stays as it is)
    if (err instanceof TypeError)
      throw new UnitError('UNIT_BAD_RECORD', `its records do not read (${err.message})`);
    throw err;
  }
  return { header, body: decoded, bytes, expandedBytes };
}

// ---------------------------------------------------------------- meta and rig

/** The `meta` of a unit-publish message (docs/embedding.md, "Library units"), exactly. */
export interface UnitPublishMeta {
  dimensionsM: [number, number, number];
  objects: number;
  triangles: number;
  actor: { kind: string; heightM: number } | null;
  credits: { name: string; author: string | null; license: string }[];
  deskVersion: string;
  /** header.digest (the body's SHA-256), informational. */
  digest: string;
}

const metaBytes = (m: UnitPublishMeta) => new TextEncoder().encode(JSON.stringify(m)).length;

/**
 * The protocol `meta` of a unit file: its size (a prop's or a figure's bounds; a set's stage, its
 * width and depth, and the height of its own bounds, whatever stands beyond the stage's edge), object
 * and triangle counts, the figure's kind and height, its credits (at most 32, at most 16 KiB as JSON:
 * the longest credits are left out first, and `warnings` gets a line saying so), the desk version and
 * the body digest. `fileBytes` is the file the header was read from (UNIT_BAD_SPEC when its header is
 * another unit's).
 */
export function unitMeta(header: UnitHeader, fileBytes: Uint8Array, warnings?: string[]): UnitPublishMeta {
  if (canonicalJsonStrict(readUnitHeader(fileBytes)) !== canonicalJsonStrict(header))
    throw new UnitError('UNIT_BAD_SPEC', "the header is not the file's");
  const b = header.bounds;
  const size = (v: number) => Math.max(0, Math.round(v * 1e4) / 1e4) || 0;
  const extent = (i: number) => (b ? size(b.max[i] - b.min[i]) : 0);
  const dims: [number, number, number] = header.set
    ? [size(header.set.width), size(header.set.depth), extent(2)]
    : [extent(0), extent(1), extent(2)];
  const credits = header.credits.map((c) => ({
    name: c.name.slice(0, 120),
    author: c.author === null ? null : c.author.slice(0, 200),
    license: c.license.slice(0, 64) || 'unknown',
  }));
  const meta: UnitPublishMeta = {
    dimensionsM: dims,
    objects: header.counts.objects,
    triangles: header.counts.triangles,
    actor: header.figure ? { kind: header.figure.kind, heightM: header.figure.heightM } : null,
    credits,
    deskVersion: (header.deskVersion || 'unknown').slice(0, 64),
    digest: header.digest,
  };
  const total = credits.length;
  let dropped = 0;
  while (
    meta.credits.length &&
    (meta.credits.length > MAX_UNIT_META_CREDITS || metaBytes(meta) > MAX_UNIT_META_BYTES)
  ) {
    let longest = 0;
    let at = 0;
    meta.credits.forEach((c, i) => {
      const n = JSON.stringify(c).length;
      if (n >= longest) {
        longest = n;
        at = i;
      }
    });
    meta.credits.splice(at, 1);
    dropped++;
  }
  if (dropped && warnings)
    warnings.push(
      `${dropped} of the unit's ${total} credits were left out of the library entry (it lists at most ${MAX_UNIT_META_CREDITS} in ${MAX_UNIT_META_BYTES / 1024} KiB); the unit file keeps them all`,
    );
  return meta;
}

/** The digest of a rig: the SHA-256 of its bone names in order (as canonical JSON), 64 hex digits. */
export function rigDigest(boneNames: readonly string[]): string {
  return sha256HexOfText(canonicalJsonStrict([...boneNames]));
}
