import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import {
  BLOCK_KINDS,
  CURVE_MAPS,
  DATABLOCK_BASE_JSON_CHARS,
  DATABLOCK_STORED_BYTES,
  DRIVER_BASE_JSON_CHARS,
  DRIVER_STORED_BYTES,
  FCURVE_STORED_BYTES,
  KEYFRAME_STORED_BYTES,
  OBJECT_BASE_JSON_CHARS,
  SAVE_BYTES_PER_IMAGE_BYTE,
  SAVE_BYTES_PER_KEPT_BYTE,
  SHAPE_KEY_STORED_BYTES_PER_VERTEX,
  decodedMeshBytes,
  newObjectsBytes,
  peekMeshLayout,
  vertexGroupBytes,
  type SceneDoc,
} from '@3d-editor/core';

/*
 * What a Yjs update (the changes a browser editor sends, a project's stored document) adds to a
 * project, in the terms the server's memory checks count a project (core operators/memory-objects.ts:
 * OBJECT_STORED_BYTES per object, DATABLOCK_STORED_BYTES per datablock, the characters of their JSON
 * beyond the defaults, FCURVE_STORED_BYTES and KEYFRAME_STORED_BYTES per F-curve and keyframe,
 * DRIVER_STORED_BYTES per driver, the decoded size of meshes, the bytes of images; a save takes
 * SAVE_BYTES_PER_KEPT_BYTE times the objects' part and SAVE_BYTES_PER_IMAGE_BYTE times the images
 * more). The update is read in place, struct by struct (Yjs's update format v1), without building
 * its items: Y.decodeUpdate keeps about 530 bytes of heap per item it decodes (160 MB for an update
 * of 10,000 linked cubes, more than the 144 MB the document keeps once they are applied), and an
 * update the server cannot hold must not take that heap before it is refused. Nor does its index of
 * the structs (ClientIndex) take memory by their lengths: a GC or skip struct, and deleted content,
 * declare their length as a number (a few bytes can declare a billion clock units).
 *
 * A project document keeps its datablocks as entries of root maps (objects, meshes, materials …),
 * each a Y.Map of fields, and its F-curves and drivers as JSON values of root maps. An entry with a
 * key the project does not have is new; a field of a new datablock counts its JSON characters; a
 * field of an existing one is a change, except for what grows the project: a mesh's geometry
 * (`data`), shape keys and vertex groups, an image's data, and an F-curve's keyframes, which count by
 * how much they grow. What the update deletes as well (its delete set: items it creates and deletes again,
 * and existing datablocks, F-curves and drivers) is taken off.
 */

/** The root maps whose entries are counted: the datablocks, F-curves and drivers. */
type RootKind = (typeof BLOCK_KINDS)[number] | (typeof CURVE_MAPS)[number];
/** The datablock kinds with a size of their own (core DATABLOCK_STORED_BYTES). */
type CountedKind = keyof typeof DATABLOCK_STORED_BYTES;

const ROOT_KINDS: ReadonlySet<string> = new Set<string>([...BLOCK_KINDS, ...CURVE_MAPS]);
const COUNTED: ReadonlySet<string> = new Set(Object.keys(DATABLOCK_STORED_BYTES));

/** What an update adds to a project ({@link measureUpdate}); removals are taken off. */
export interface UpdateSize {
  /** New objects. */
  objects: number;
  /** New datablocks by kind (meshes, materials, lights, cameras, curves, armatures). */
  datablocks: Partial<Record<CountedKind, number>>;
  /** New keyframes (of new F-curves, and those added to existing ones). */
  keyframes: number;
  /**
   * Bytes of mesh geometry added, decoded (core decodedMeshBytes, with UVs), with their shape keys and
   * vertex groups (core storedMeshBytes).
   */
  meshBytes: number;
  /** Bytes of images added. */
  imageBytes: number;
  /** What the project keeps of the objects, datablocks, keyframes and drivers added (bytes). */
  objectsPart: number;
  /** What the project keeps more in all (bytes; negative when the update makes it smaller). */
  kept: number;
  /** What a save of the project takes more for a moment (bytes; negative when it takes less). */
  saved: number;
}

/** Field codes of the attribution index (see {@link Walk}). */
const ROOT = 0;
const DATA = 1;
const SHAPE_KEYS = 2;
const OTHER = 3;
const VERTEX_GROUPS = 4;
/** Attribution of a clock unit that is not an entry of a counted datablock. */
const NONE = -1;
/** Attribution of an item whose origin or parent is not resolved yet (see {@link Walk.pending}). */
const PENDING = -2;

const fieldCode = (key: string | null): number =>
  key === 'data' ? DATA : key === 'shape_keys' ? SHAPE_KEYS : key === 'vertex_groups' ? VERTEX_GROUPS : OTHER;

/** An entry of a counted root map: born in the update, or an existing one of the project. */
interface Block {
  kind: RootKind;
  key: string;
  /** The entry's item is in the update (else: an entry the project has). */
  born: boolean;
  client: number;
  clock: number;
  /** Its content: a Y type (a datablock: 7), a JSON value (an F-curve, a driver: 2 or 8), deleted (1). */
  ref: number;
  /** Keyframes of a JSON value with a `keyframes` array (an F-curve). */
  keyframes: number;
  /** Characters of the JSON of its value (F-curves, drivers) or fields (datablocks). */
  json: number;
  /** Bytes of its `data` (decoded mesh, or image), shape keys and vertex groups; -1: not in the update. */
  data: number;
  shape: number;
  groups: number;
}

/** What one item contributes, for an attribution found after the pass (see Walk.pending). */
interface Content {
  ref: number;
  key: string | null;
  /** Characters of the JSON of its value (one value: a map entry's). */
  json: number;
  keyframes: number;
  binary: Uint8Array | null;
  shapeBytes: number;
  groupBytes: number;
  values: unknown[] | null;
}

interface Pending {
  client: number;
  clock: number;
  /** The origin (or the parent, `byParent`) whose attribution this item takes. */
  depClient: number;
  depClock: number;
  byParent: boolean;
  content: Content;
  /** Its entry in the index of its client's listing (-1: none, it has no clock unit). */
  idx: ClientIndex;
  entry: number;
}

/**
 * Attribution of the structs of one listing of a client in the update, by ranges of clocks: one
 * entry per struct, or per run of structs with the same attribution (`block` index and `field`
 * code), and the pending item (Walk.pending) a struct is. Never one per clock unit: GC and skip
 * structs and deleted content declare their length as a number, which the update's size does not
 * bound. The structs of a listing come in the order of their clocks, one after the other.
 */
class ClientIndex {
  private starts = new Float64Array(16);
  blocks = new Int32Array(16);
  fields = new Uint8Array(16);
  pends = new Int32Array(16);
  private size = 0;
  /** The clock after the last struct added. */
  private end = 0;

  /**
   * Adds the next struct of the listing: `len` clock units at `clock`. Returns its entry (-1 when
   * it has no clock unit).
   */
  add(clock: number, len: number, block: number, field: number, pend: number): number {
    if (!(len > 0)) return -1;
    const last = this.size - 1;
    if (
      last >= 0 &&
      pend < 0 &&
      this.pends[last] < 0 &&
      this.blocks[last] === block &&
      this.fields[last] === field &&
      this.end === clock
    ) {
      this.end = clock + len;
      return last;
    }
    if (this.size === this.starts.length) this.grow();
    const e = this.size++;
    this.starts[e] = clock;
    this.blocks[e] = block;
    this.fields[e] = field;
    this.pends[e] = pend;
    this.end = clock + len;
    return e;
  }

  /** The entry whose clocks hold `clock` (-1: none). */
  find(clock: number): number {
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= clock) lo = mid + 1;
      else hi = mid - 1;
    }
    if (hi < 0) return -1;
    return clock < (hi + 1 < this.size ? this.starts[hi + 1] : this.end) ? hi : -1;
  }

  private grow(): void {
    const n = this.starts.length * 2;
    const starts = new Float64Array(n);
    starts.set(this.starts);
    const blocks = new Int32Array(n);
    blocks.set(this.blocks);
    const fields = new Uint8Array(n);
    fields.set(this.fields);
    const pends = new Int32Array(n);
    pends.set(this.pends);
    this.starts = starts;
    this.blocks = blocks;
    this.fields = fields;
    this.pends = pends;
  }
}

/** Bytes of a shape keys value (an array of keys with Float32 xyz `data`), as the project counts them. */
function shapeKeyBytes(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let vertices = 0;
  for (const k of value) {
    const data = (k as { data?: unknown } | null)?.data;
    if (data instanceof Uint8Array) vertices += data.byteLength / 12;
  }
  return SHAPE_KEY_STORED_BYTES_PER_VERTEX * vertices;
}

/** Bytes of the weights of a vertex groups value, as the project counts them (core vertexGroupBytes). */
function groupBytes(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let bytes = 0;
  for (const g of value) {
    const n = Number((g as { weights?: { byteLength?: unknown } } | null)?.weights?.byteLength ?? 0);
    if (Number.isFinite(n) && n > 0) bytes += n;
  }
  return bytes;
}

/** Whether a JSON value holds a typed array (one nested deeper than 64 levels counts as one). */
function holdsView(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (ArrayBuffer.isView(value) || depth > 64) return true;
  if (Array.isArray(value)) {
    for (const v of value) if (holdsView(v, depth + 1)) return true;
    return false;
  }
  for (const k in value) if (holdsView((value as Record<string, unknown>)[k], depth + 1)) return true;
  return false;
}

/**
 * Characters of the JSON of a value (0 when it has none), a typed array in it counted as one
 * character per byte: JSON.stringify writes about ten characters per byte of a Uint8Array
 * (`{"0":12,"1":255,…}`), a string of hundreds of MB for the weights of a large mesh.
 */
function jsonChars(value: unknown): number {
  try {
    // (a replacer slows JSON.stringify down: the update of 10,000 objects took a third longer)
    if (!holdsView(value)) return JSON.stringify(value)?.length ?? 0;
    let bytes = 0;
    const json = JSON.stringify(value, (_key, v: unknown) => {
      if (!ArrayBuffer.isView(v)) return v;
      bytes += v.byteLength;
      return 0;
    });
    return (json?.length ?? 0) + bytes;
  } catch {
    return 0;
  }
}

/** Decoded bytes of a stored mesh's geometry (with a UV layer, as the project counts it), 0 for others. */
function meshBytes(bytes: Uint8Array): number {
  // core mesh/codec.ts: "M3DM" read as a little-endian u32, and a header of 28 bytes
  if (
    bytes.byteLength < 28 ||
    bytes[0] !== 0x4d ||
    bytes[1] !== 0x33 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x4d
  )
    return 0;
  return decodedMeshBytes({ ...peekMeshLayout(bytes), uvs: true, colors: false });
}

/** The pass over an update (see {@link measureUpdate}). */
class Walk {
  readonly blocks: Block[] = [];
  private readonly existing = new Map<string, number>();
  /** The index of each client's listing (of its last one: Yjs applies the last of repeated ones). */
  private readonly index = new Map<number, ClientIndex>();
  /** Items whose origin or parent is not known yet (another client's, read later). */
  readonly pending: Pending[] = [];
  /** Field contributions: client, clock, block, field, amount (bytes or characters). */
  readonly recs: number[] = [];
  private readonly roots: Map<unknown, RootKind>;
  private readonly store: Y.Doc['store'] | null;

  constructor(readonly scene: SceneDoc | null) {
    this.store = scene ? scene.ydoc.store : null;
    this.roots = new Map();
    if (scene) for (const kind of ROOT_KINDS) this.roots.set(scene.map(kind as RootKind), kind as RootKind);
  }

  /** Whether the project's document has the item with this id (its state for `client` is past it). */
  inProject(client: number, clock: number): boolean {
    return !!this.store && clock < Y.getState(this.store, client);
  }

  /** The counted root map `type` is (null: another type, or none). */
  rootKind(type: unknown): RootKind | null {
    return this.roots.get(type) ?? null;
  }

  /** The index of a new listing of `client`'s structs. */
  listing(client: number): ClientIndex {
    const idx = new ClientIndex();
    this.index.set(client, idx);
    return idx;
  }

  newBlock(kind: RootKind, key: string, born: boolean, client: number, clock: number, ref: number): number {
    this.blocks.push({
      kind,
      key,
      born,
      client,
      clock,
      ref,
      keyframes: 0,
      json: 0,
      data: -1,
      shape: -1,
      groups: -1,
    });
    return this.blocks.length - 1;
  }

  /** The block of an entry the project has (one per kind and key). */
  existingBlock(kind: RootKind, key: string): number {
    const k = `${kind}\u0000${key}`;
    let b = this.existing.get(k);
    if (b === undefined) {
      b = this.newBlock(kind, key, false, -1, -1, 7);
      this.existing.set(k, b);
    }
    return b;
  }

  /**
   * The attribution of the item with this id: [block, field, pending item], NONE when it is no entry
   * of a counted datablock, PENDING when it is neither known to the project nor read yet (`final`:
   * NONE then), or is a pending item not resolved yet (its index in {@link pending}, else -1).
   */
  attribution(client: number, clock: number, final: boolean): [number, number, number] {
    if (this.store && clock < Y.getState(this.store, client))
      return [...this.storeAttribution(client, clock), -1];
    const idx = this.index.get(client);
    const e = idx ? idx.find(clock) : -1;
    if (e >= 0) return [idx!.blocks[e], idx!.fields[e], idx!.pends[e]];
    return [final ? NONE : PENDING, 0, -1];
  }

  private storeAttribution(client: number, clock: number): [number, number] {
    let item: Y.Item | Y.GC;
    try {
      item = Y.getItem(this.store!, Y.createID(client, clock));
    } catch {
      return [NONE, 0];
    }
    if (!(item instanceof Y.Item)) return [NONE, 0];
    const parent = item.parent as Y.AbstractType<unknown> | null;
    if (!parent || item.parentSub === null) return [NONE, 0];
    if (parent._item === null) {
      const kind = this.rootKind(parent);
      return kind ? [this.existingBlock(kind, item.parentSub), ROOT] : [NONE, 0];
    }
    const block = parent._item;
    const root = block.parent as Y.AbstractType<unknown> | null;
    if (!root || root._item !== null || block.parentSub === null) return [NONE, 0];
    const kind = this.rootKind(root);
    return kind ? [this.existingBlock(kind, block.parentSub), fieldCode(item.parentSub)] : [NONE, 0];
  }

  /**
   * Records an item with its attribution: a new entry of a counted map (`ROOT`), or a field of a
   * datablock, whose content counts.
   */
  record(client: number, clock: number, block: number, field: number, c: Content): void {
    const b = this.blocks[block];
    if (field === ROOT) {
      // a datablock's fields come as items of their own; an F-curve's or driver's value is the entry's
      b.keyframes = c.keyframes;
      b.json = c.json;
      return;
    }
    if (c.ref === 1) return; // deleted content
    let amount: number;
    if (field === DATA && c.binary) amount = b.kind === 'images' ? c.binary.byteLength : meshBytes(c.binary);
    else if (field === SHAPE_KEYS) amount = c.shapeBytes;
    else if (field === VERTEX_GROUPS) amount = c.groupBytes;
    // a field of the JSON of a datablock: "key":value,
    else amount = (c.key?.length ?? 0) + 4 + c.json;
    this.recs.push(client, clock, block, field, amount);
  }
}

/** What of a content's value is read: its JSON characters, keyframes, shape keys, vertex groups. */
interface Wanted {
  json: boolean;
  keyframes: boolean;
  shape: boolean;
  groups: boolean;
}

const NOTHING: Wanted = { json: false, keyframes: false, shape: false, groups: false };
const EVERYTHING: Wanted = { json: true, keyframes: true, shape: true, groups: true };
const JSON_ONLY: Wanted = { ...NOTHING, json: true };
const KEYFRAMES: Wanted = { ...NOTHING, keyframes: true };
const SHAPES: Wanted = { ...NOTHING, shape: true };
const GROUPS: Wanted = { ...NOTHING, groups: true };

/** Reads one item's content (see Yjs readItemContent), summed up as {@link Content}. */
function readContent(
  d: decoding.Decoder,
  ref: number,
  key: string | null,
  want: Wanted,
): { c: Content; len: number } {
  const wanted = want.json || want.keyframes || want.shape || want.groups;
  const c: Content = {
    ref,
    key,
    json: 0,
    keyframes: 0,
    binary: null,
    shapeBytes: 0,
    groupBytes: 0,
    values: null,
  };
  let len = 1;
  switch (ref) {
    case 1: // deleted
      len = decoding.readVarUint(d);
      break;
    case 2: {
      // JSON (old documents)
      len = decoding.readVarUint(d);
      const values: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const s = decoding.readVarString(d);
        if (wanted) values.push(s === 'undefined' ? undefined : (JSON.parse(s) as unknown));
      }
      if (wanted) c.values = values;
      break;
    }
    case 3: // binary (a view, no copy)
      c.binary = decoding.readVarUint8Array(d);
      break;
    case 4: // string
      len = decoding.readVarString(d).length;
      break;
    case 5: // embed
      decoding.readVarString(d);
      break;
    case 6: // format
      decoding.readVarString(d);
      decoding.readVarString(d);
      break;
    case 7: {
      // type: XmlElement and XmlHook carry a name
      const typeRef = decoding.readVarUint(d);
      if (typeRef === 3 || typeRef === 5) decoding.readVarString(d);
      break;
    }
    case 8: {
      // any
      len = decoding.readVarUint(d);
      const values: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const v = decoding.readAny(d);
        if (wanted) values.push(v);
      }
      if (wanted) c.values = values;
      break;
    }
    case 9: // sub-document
      decoding.readVarString(d);
      decoding.readAny(d);
      break;
    default:
      throw new Error(`unknown content ${ref}`);
  }
  if (c.values?.length === 1) {
    const v = c.values[0];
    if (want.json) c.json = jsonChars(v);
    if (want.keyframes) {
      const k = (v as { keyframes?: unknown } | null)?.keyframes;
      if (Array.isArray(k)) c.keyframes = k.length;
    }
    if (want.shape) c.shapeBytes = shapeKeyBytes(v);
    if (want.groups) c.groupBytes = groupBytes(v);
  }
  c.values = null;
  return { c, len };
}

/** Sorted, merged delete ranges of an update by client: start, length, start, length … */
type DeleteSet = Map<number, number[]>;

function isDeleted(ds: DeleteSet, client: number, clock: number): boolean {
  const r = ds.get(client);
  if (!r) return false;
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = r[2 * mid];
    if (clock < start) hi = mid - 1;
    else if (clock >= start + r[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Reads an update's delete set (Yjs update format v1), sorted and merged per client. */
function readDeleteSet(d: decoding.Decoder): DeleteSet {
  const ds: DeleteSet = new Map();
  const clients = decoding.readVarUint(d);
  for (let i = 0; i < clients; i++) {
    const client = decoding.readVarUint(d);
    const n = decoding.readVarUint(d);
    const pairs: [number, number][] = [];
    for (let j = 0; j < n; j++) pairs.push([decoding.readVarUint(d), decoding.readVarUint(d)]);
    pairs.sort((a, b) => a[0] - b[0]);
    const merged: number[] = [];
    for (const [start, len] of pairs) {
      const last = merged.length - 2;
      if (last >= 0 && start <= merged[last] + merged[last + 1])
        merged[last + 1] = Math.max(merged[last + 1], start + len - merged[last]);
      else merged.push(start, len);
    }
    ds.set(client, merged);
  }
  return ds;
}

/** What of the value of an entry of root map `kind` counts: an F-curve's keyframes, a driver's JSON. */
const entryWanted = (kind: RootKind): Wanted =>
  kind === 'fcurves' ? KEYFRAMES : kind === 'drivers' ? JSON_ONLY : NOTHING;

/**
 * What of an item's value counts, by the entry it is (`entryKind`: the root map's) or the
 * attribution of its origin or parent ([block, field]): an entry's keyframes or JSON (a new F-curve
 * or driver, or one set again), the JSON of a new datablock's fields (not of a mesh's: its geometry
 * counts), shape keys, vertex groups; all of it while that attribution is not known yet (PENDING).
 */
function wanted(
  walk: Walk,
  entryKind: RootKind | null,
  block: number,
  field: number,
  byParent: boolean,
  key: string | null,
): Wanted {
  if (entryKind) return entryWanted(entryKind);
  if (block === PENDING) return EVERYTHING;
  if (block < 0) return NOTHING;
  const b = walk.blocks[block];
  const f = byParent ? fieldCode(key) : field;
  if (f === ROOT) return entryWanted(b.kind);
  if (f === SHAPE_KEYS) return SHAPES;
  if (f === VERTEX_GROUPS) return GROUPS;
  if (f === DATA) return NOTHING;
  return b.born && b.kind !== 'meshes' ? JSON_ONLY : NOTHING;
}

/**
 * What `update` (Yjs update format v1) adds to the project of `scene` (see the comment at the top of
 * this file); without a scene, what a document made of it would hold (a stored project before it
 * is loaded). Items the project has already are not counted. Throws when the update cannot be read.
 */
export function measureUpdate(update: Uint8Array, scene?: SceneDoc | null): UpdateSize {
  const walk = new Walk(scene ?? null);
  const d = decoding.createDecoder(update);
  const clients = decoding.readVarUint(d);
  for (let i = 0; i < clients; i++) {
    const structs = decoding.readVarUint(d);
    const client = decoding.readVarUint(d);
    let clock = decoding.readVarUint(d);
    const idx = walk.listing(client);
    for (let j = 0; j < structs; j++) {
      const info = decoding.readUint8(d);
      if ((info & 0x1f) === 0 || (info & 0x1f) === 10) {
        // garbage-collected items, or a skip (the low five bits tell, as Yjs reads them)
        const len = decoding.readVarUint(d);
        idx.add(clock, len, NONE, 0, -1);
        clock += len;
        continue;
      }
      let depClient = -1;
      let depClock = -1;
      let byParent = false;
      if (info & 0x80) {
        // origin (the item before it, for a map entry the value it replaces)
        depClient = decoding.readVarUint(d);
        depClock = decoding.readVarUint(d);
      }
      if (info & 0x40) {
        // right origin
        const rightClient = decoding.readVarUint(d);
        const rightClock = decoding.readVarUint(d);
        if (depClient < 0) {
          depClient = rightClient;
          depClock = rightClock;
        }
      }
      let parentKey: string | null = null;
      let parentSub: string | null = null;
      if ((info & 0xc0) === 0) {
        if (decoding.readVarUint(d) === 1) parentKey = decoding.readVarString(d);
        else {
          depClient = decoding.readVarUint(d);
          depClock = decoding.readVarUint(d);
          byParent = true;
        }
        if (info & 0x20) parentSub = decoding.readVarString(d);
      }
      const ref = info & 0x1f;
      // the attribution decides whether the content's values are read
      const inProject = walk.inProject(client, clock);
      const entryKind =
        !inProject && parentKey !== null && parentSub !== null && ROOT_KINDS.has(parentKey)
          ? (parentKey as RootKind)
          : null;
      let block = NONE;
      let field = 0;
      if (!inProject && parentKey === null && depClient >= 0)
        [block, field] = walk.attribution(depClient, depClock, false);
      const { c, len } = readContent(
        d,
        ref,
        parentSub,
        wanted(walk, entryKind, block, field, byParent, parentSub),
      );
      if (inProject) {
        // the project has it (lookups of its id go to the project's document)
        clock += len;
        continue;
      }
      let pend = -1;
      if (entryKind) {
        block = walk.newBlock(entryKind, parentSub!, true, client, clock, ref);
        field = ROOT;
      } else if (block === PENDING) {
        pend = walk.pending.length;
        walk.pending.push({ client, clock, depClient, depClock, byParent, content: c, idx, entry: -1 });
      } else if (block >= 0) {
        [block, field] = resolved(walk, block, field, byParent, parentSub, client, clock, ref);
      }
      const e = idx.add(clock, len, block, field, pend);
      if (pend >= 0) walk.pending[pend].entry = e;
      if (block >= 0) walk.record(client, clock, block, field, c);
      clock += len;
    }
  }
  resolvePending(walk);
  return total(walk, readDeleteSet(d));
}

/**
 * Attributes the items that refer to items read after them (another client's, later in the
 * update; Walk.pending): each takes the attribution of its origin or parent, which may be pending
 * itself: a chain of them is followed to its first known item once, and resolved from there back
 * (one pass over all of them, whatever the order of the update). An item whose chain comes back to
 * itself, or ends at an item the update and the project do not have, counts nothing.
 */
function resolvePending(walk: Walk): void {
  const { pending } = walk;
  /** 0: not resolved; 1: on the chain followed; 2: resolved. */
  const state = new Uint8Array(pending.length);
  const chain: number[] = [];
  for (let first = 0; first < pending.length; first++) {
    if (state[first]) continue;
    chain.length = 0;
    for (let at = first; ;) {
      state[at] = 1;
      chain.push(at);
      const p = pending[at];
      const [block, , pend] = walk.attribution(p.depClient, p.depClock, true);
      if (block !== PENDING || pend < 0 || state[pend] !== 0) break;
      at = pend;
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      const p = pending[chain[k]];
      let [block, field] = walk.attribution(p.depClient, p.depClock, true);
      // (still pending: an item of this chain, which comes back to itself)
      if (block === PENDING) block = NONE;
      if (block >= 0)
        [block, field] = resolved(
          walk,
          block,
          field,
          p.byParent,
          p.content.key,
          p.client,
          p.clock,
          p.content.ref,
        );
      if (p.entry >= 0) {
        p.idx.blocks[p.entry] = block;
        p.idx.fields[p.entry] = block >= 0 ? field : 0;
      }
      state[chain[k]] = 2;
      if (block >= 0) walk.record(p.client, p.clock, block, field, p.content);
    }
  }
}

/**
 * The attribution of an item whose origin (or parent, `byParent`) has attribution [block, field]:
 * a field named `key` of the datablock whose entry is its parent; the same field of the same
 * datablock as its origin; a new entry for the same key when its origin is an entry.
 */
function resolved(
  walk: Walk,
  block: number,
  field: number,
  byParent: boolean,
  key: string | null,
  client: number,
  clock: number,
  ref: number,
): [number, number] {
  const b = walk.blocks[block];
  if (byParent) return field === ROOT && b.ref === 7 ? [block, fieldCode(key)] : [NONE, 0];
  if (field !== ROOT) return [block, field];
  return [walk.newBlock(b.kind, b.key, true, client, clock, ref), ROOT];
}

/** Keyframes of the project's F-curve `key` (0 when it has none). */
function keyframesOf(scene: SceneDoc, key: string): number {
  const k = (scene.map('fcurves').get(key) as { keyframes?: unknown } | undefined)?.keyframes;
  return Array.isArray(k) ? k.length : 0;
}

/** Decoded bytes of the project's mesh `id` (0 when it has none). */
function projectMeshBytes(scene: SceneDoc, id: string): number {
  const c = scene.meshCounts(id);
  return c ? decodedMeshBytes({ ...c, uvs: true, colors: false }) : 0;
}

/** Bytes the shape keys of the project's mesh `id` keep (0 when it has none). */
function projectShapeBytes(scene: SceneDoc, id: string): number {
  const keys = (scene.map('meshes').get(id) as Y.Map<unknown> | undefined)?.get('shape_keys');
  return shapeKeyBytes(keys);
}

/** A JSON value (an F-curve's, a driver's): content of format JSON (2) or any (8). */
const isValue = (ref: number) => ref === 2 || ref === 8;

function total(walk: Walk, ds: DeleteSet): UpdateSize {
  const scene = walk.scene;
  const { blocks, recs } = walk;
  const live = (b: Block) => !b.born || (b.ref !== 1 && !isDeleted(ds, b.client, b.clock));
  for (let i = 0; i < recs.length; i += 5) {
    const b = blocks[recs[i + 2]];
    if (!live(b) || isDeleted(ds, recs[i], recs[i + 1])) continue;
    const field = recs[i + 3];
    const amount = recs[i + 4];
    if (field === DATA) b.data = Math.max(b.data, amount);
    else if (field === SHAPE_KEYS) b.shape = Math.max(b.shape, amount);
    else if (field === VERTEX_GROUPS) b.groups = Math.max(b.groups, amount);
    else b.json += amount;
  }
  let objects = 0;
  const datablocks: Partial<Record<CountedKind, number>> = {};
  let extraJson = 0;
  let fcurves = 0;
  let keyframes = 0;
  let drivers = 0;
  let mesh = 0;
  let images = 0;
  /** Entries of the update that set a key again (kind and key): the old value is not taken off. */
  const replaced = new Set<string>();
  for (const b of blocks) {
    if (!live(b)) continue;
    const exists = !!scene && scene.map(b.kind).has(b.key);
    if (b.born) replaced.add(`${b.kind}\u0000${b.key}`);
    if (b.kind === 'fcurves' || b.kind === 'drivers') {
      if (!b.born || !isValue(b.ref)) continue;
      if (b.kind === 'fcurves') {
        keyframes += b.keyframes - (exists ? keyframesOf(scene!, b.key) : 0);
        if (!exists) fcurves++;
      } else if (!exists) {
        drivers++;
        extraJson += Math.max(0, b.json - DRIVER_BASE_JSON_CHARS);
      }
      continue;
    }
    if (b.ref !== 7) continue;
    const isNew = b.born && !exists;
    if (isNew) {
      if (b.kind === 'objects') {
        objects++;
        extraJson += Math.max(0, b.json - OBJECT_BASE_JSON_CHARS);
      } else if (COUNTED.has(b.kind)) {
        const kind = b.kind as CountedKind;
        datablocks[kind] = (datablocks[kind] ?? 0) + 1;
        if (kind !== 'meshes')
          extraJson += Math.max(
            0,
            b.json - DATABLOCK_BASE_JSON_CHARS[kind as Exclude<CountedKind, 'meshes'>],
          );
      }
    }
    // geometry, shape keys, vertex groups and images: what they grow by (all of it for a new datablock)
    if (b.kind === 'meshes') {
      if (b.data >= 0) mesh += b.data - (isNew || !scene ? 0 : projectMeshBytes(scene, b.key));
      if (b.shape >= 0) mesh += b.shape - (isNew || !scene ? 0 : projectShapeBytes(scene, b.key));
      if (b.groups >= 0) mesh += b.groups - (isNew || !scene ? 0 : vertexGroupBytes(scene, b.key));
    } else if (b.kind === 'images' && b.data >= 0) {
      images += b.data - (isNew || !scene ? 0 : (scene.getImageBytes(b.key)?.byteLength ?? 0));
    }
  }
  let objectsPart =
    newObjectsBytes({ objects, datablocks, extraJson }).stored +
    FCURVE_STORED_BYTES * fcurves +
    KEYFRAME_STORED_BYTES * keyframes +
    DRIVER_STORED_BYTES * drivers;
  // what the update deletes of the project: its datablocks, F-curves and drivers
  if (scene) {
    const removed = removedByUpdate(walk, ds, replaced);
    objectsPart -= removed.objectsPart;
    objects -= removed.objects;
    keyframes -= removed.keyframes;
    for (const [kind, n] of Object.entries(removed.datablocks))
      datablocks[kind as CountedKind] = (datablocks[kind as CountedKind] ?? 0) - n;
    mesh -= removed.meshBytes;
    images -= removed.imageBytes;
  }
  return {
    objects,
    datablocks,
    keyframes,
    meshBytes: mesh,
    imageBytes: images,
    objectsPart,
    kept: objectsPart + mesh + images,
    saved: SAVE_BYTES_PER_KEPT_BYTE * objectsPart + SAVE_BYTES_PER_IMAGE_BYTE * images,
  };
}

/**
 * The entries of the project that the update's delete set deletes (live in the project, and their
 * key not set again by the update), in the same terms as what it adds.
 */
function removedByUpdate(
  walk: Walk,
  ds: DeleteSet,
  replaced: ReadonlySet<string>,
): {
  objects: number;
  datablocks: Partial<Record<CountedKind, number>>;
  keyframes: number;
  objectsPart: number;
  meshBytes: number;
  imageBytes: number;
} {
  const scene = walk.scene!;
  const store = scene.ydoc.store;
  let objects = 0;
  const datablocks: Partial<Record<CountedKind, number>> = {};
  let fcurves = 0;
  let keyframes = 0;
  let drivers = 0;
  let meshBytesRemoved = 0;
  let imageBytes = 0;
  for (const [client, ranges] of ds) {
    const structs = store.clients.get(client);
    if (!structs) continue;
    const state = Y.getState(store, client);
    for (let r = 0; r < ranges.length; r += 2) {
      const start = ranges[r];
      const end = Math.min(start + ranges[r + 1], state);
      if (start >= end) continue;
      for (let i = Y.findIndexSS(structs, start); i < structs.length && structs[i].id.clock < end; i++) {
        const s = structs[i];
        if (!(s instanceof Y.Item) || s.deleted || s.parentSub === null) continue;
        const kind = walk.rootKind(s.parent);
        if (!kind || replaced.has(`${kind}\u0000${s.parentSub}`)) continue;
        const key = s.parentSub;
        if (kind === 'fcurves') {
          fcurves++;
          keyframes += keyframesOf(scene, key);
        } else if (kind === 'drivers') drivers++;
        else if (kind === 'objects') objects++;
        else if (kind === 'images') imageBytes += scene.getImageBytes(key)?.byteLength ?? 0;
        else if (COUNTED.has(kind)) {
          datablocks[kind as CountedKind] = (datablocks[kind as CountedKind] ?? 0) + 1;
          if (kind === 'meshes')
            meshBytesRemoved +=
              projectMeshBytes(scene, key) + projectShapeBytes(scene, key) + vertexGroupBytes(scene, key);
        }
      }
    }
  }
  return {
    objects,
    datablocks,
    keyframes,
    objectsPart:
      newObjectsBytes({ objects, datablocks }).stored +
      FCURVE_STORED_BYTES * fcurves +
      KEYFRAME_STORED_BYTES * keyframes +
      DRIVER_STORED_BYTES * drivers,
    meshBytes: meshBytesRemoved,
    imageBytes,
  };
}
