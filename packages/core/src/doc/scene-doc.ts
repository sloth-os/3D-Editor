import * as Y from 'yjs';
import type { Vec3 } from '../math/types';
import { compose4, identity4, invert4, multiply4, rotationFromEuler } from '../math/mat4';
import type { Mat4 } from '../math/types';
import { cross3, dot3, length3 } from '../math/vec3';
import {
  column,
  determinant3,
  linearPart,
  matrixFromAxes,
  matrixToStoredEuler,
  transformVector,
} from '../constraints/math';
import type { MeshData } from '../mesh/types';
import { cloneMesh } from '../mesh/types';
import { decodeMesh, encodeMesh, peekMeshCounts } from '../mesh/codec';
import { createCube } from '../mesh/primitives';
import { newId } from '../util/id';
import { uniqueName } from '../util/names';
import { cloneJson, base64Decode, base64Encode } from '../util/json';
import {
  defaultArmature,
  defaultCurve,
  defaultCamera,
  defaultCollection,
  defaultLight,
  defaultMaterial,
  defaultObject,
  defaultRenderSettings,
  defaultSceneSettings,
  defaultWorldSettings,
} from './defaults';
import type {
  ArmatureData,
  CameraData,
  CollectionData,
  CurveData,
  DatablockKind,
  DriverData,
  FCurve,
  ShapeKeyData,
  VertexGroupData,
  ImageData,
  LightData,
  LightType,
  MaterialData,
  MeshBlock,
  ObjectData,
  ObjectType,
  ProjectMeta,
  RenderSettings,
  SceneSettings,
  SceneSnapshot,
  WorldSettings,
} from './types';
import { ROOT_COLLECTION_ID, SCHEMA_VERSION } from './types';

export const SETTINGS_KINDS = ['meta', 'scene', 'render', 'world'] as const;
export type SettingsKind = (typeof SETTINGS_KINDS)[number];
export const BLOCK_KINDS: DatablockKind[] = [
  'objects',
  'meshes',
  'materials',
  'lights',
  'cameras',
  'images',
  'collections',
  'curves',
  'armatures',
];
/** Keyed maps that are not datablocks (animation curves and drivers). */
export const CURVE_MAPS = ['fcurves', 'drivers'] as const;
export type ChangeKind = DatablockKind | 'fcurves' | 'drivers';

/** The names of one kind of datablock while a transaction runs (see SceneDoc.names). */
interface BlockNames {
  taken: Set<string>;
  /** The suffix uniqueName tries first per name stem. */
  next: Map<string, number>;
  /**
   * Keys the kind's map had when `taken` was last current (Y.Map's `_map`, deleted keys included:
   * counting the live ones takes a pass over all of them); a datablock added by other code adds one.
   */
  keys: number;
}

/** Aggregated description of what changed in one Yjs transaction. */
export interface DocChanges {
  origin: unknown;
  /** True when the change was made through this replica (including undo/redo). */
  local: boolean;
  /** ids whose fields changed, or that were added/removed, per kind. */
  changed: Map<ChangeKind, Set<string>>;
  added: Map<ChangeKind, Set<string>>;
  removed: Map<ChangeKind, Set<string>>;
  /** Changed field names per kind+id (`${kind}:${id}` → keys). */
  fields: Map<string, Set<string>>;
  settings: Set<SettingsKind>;
}

export type DocChangeListener = (changes: DocChanges) => void;

export function fcurveKey(fc: Pick<FCurve, 'target_type' | 'target_id' | 'path' | 'index'>): string {
  return `${fc.target_type}:${fc.target_id}:${fc.path}:${fc.index}`;
}

/**
 * The keys of the animation curves or drivers in `map` (fcurveKey of each) by their target id, in
 * the map's order: what listFCurves(id) and listDrivers(id) list, for every id at once.
 */
function keysByTarget(map: Y.Map<unknown>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const v of map.values()) {
    const fc = v as FCurve;
    let keys = out.get(fc.target_id);
    if (!keys) out.set(fc.target_id, (keys = []));
    keys.push(fcurveKey(fc));
  }
  return out;
}

/** Origin used for transactions that should not be tracked by undo managers (e.g. migrations). */
export const SYSTEM_ORIGIN = { type: 'system' };

/**
 * Typed facade over the project's Yjs document.
 *
 * Reads return plain JSON copies (safe to mutate). Meshes returned by `getMesh` are cached
 * decoded instances and MUST be treated as immutable — use `getMeshCopy` to edit.
 */
export class SceneDoc {
  readonly ydoc: Y.Doc;
  /** Default transaction origin for local edits (tracked by the default undo manager). */
  readonly origin: object;
  private readonly listeners = new Set<DocChangeListener>();
  private pending: DocChanges | null = null;
  private readonly meshCache = new WeakMap<Uint8Array, MeshData>();
  /** Nesting of transact calls; datablock names are kept per kind while it is above 0 (see names). */
  private transactionDepth = 0;
  private readonly namesInTransaction = new Map<DatablockKind, BlockNames>();
  private readonly blobVersions = new WeakMap<object, number>();
  private blobCounter = 0;
  private readonly unobserve: (() => void)[] = [];

  constructor(ydoc: Y.Doc = new Y.Doc(), origin: object = { type: 'local' }) {
    this.ydoc = ydoc;
    this.origin = origin;
    this.installObservers();
  }

  /** Creates a new document with Blender's default startup content (cube, camera, light). */
  static create(opts: { name?: string; empty?: boolean; generator?: string } = {}): SceneDoc {
    const doc = new SceneDoc();
    doc.transact(() => {
      const meta = doc.map('meta');
      meta.set('schema_version', SCHEMA_VERSION);
      meta.set('name', opts.name ?? 'Untitled');
      meta.set('created_at', new Date().toISOString());
      meta.set('generator', opts.generator ?? '3d-editor');
      if (!opts.empty) doc.populateDefaultScene();
    }, SYSTEM_ORIGIN);
    return doc;
  }

  static fromUpdate(update: Uint8Array, origin?: object): SceneDoc {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, update);
    return new SceneDoc(ydoc, origin);
  }

  destroy(): void {
    for (const u of this.unobserve) u();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- low level

  map(name: SettingsKind | ChangeKind): Y.Map<any> {
    return this.ydoc.getMap(name);
  }

  /** All top-level shared types (for undo managers). */
  sharedTypes(): Y.Map<any>[] {
    return [...SETTINGS_KINDS, ...BLOCK_KINDS, ...CURVE_MAPS].map((k) => this.map(k));
  }

  transact<T>(fn: () => T, origin: unknown = this.origin): T {
    let result!: T;
    this.transactionDepth++;
    try {
      this.ydoc.transact(() => {
        result = fn();
      }, origin);
    } finally {
      if (--this.transactionDepth === 0) this.namesInTransaction.clear();
    }
    return result;
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  applyUpdate(update: Uint8Array, origin: unknown = 'remote'): void {
    Y.applyUpdate(this.ydoc, update, origin);
  }

  onChange(listener: DocChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private installObservers(): void {
    const ensure = (): DocChanges => {
      if (!this.pending)
        this.pending = {
          origin: null,
          local: true,
          changed: new Map(),
          added: new Map(),
          removed: new Map(),
          fields: new Map(),
          settings: new Set(),
        };
      return this.pending;
    };
    const addTo = (m: Map<ChangeKind, Set<string>>, kind: ChangeKind, id: string) => {
      let s = m.get(kind);
      if (!s) m.set(kind, (s = new Set()));
      s.add(id);
    };
    for (const kind of SETTINGS_KINDS) {
      const ymap = this.map(kind);
      const h = () => ensure().settings.add(kind);
      ymap.observeDeep(h);
      this.unobserve.push(() => ymap.unobserveDeep(h));
    }
    for (const kind of [...BLOCK_KINDS, ...CURVE_MAPS]) {
      const ymap = this.map(kind);
      const h = (events: Y.YEvent<any>[]) => {
        const c = ensure();
        for (const ev of events) {
          if (ev.target === ymap) {
            for (const [key, change] of (ev as Y.YMapEvent<any>).changes.keys) {
              addTo(c.changed, kind, key);
              if (change.action === 'add') addTo(c.added, kind, key);
              else if (change.action === 'delete') addTo(c.removed, kind, key);
              else {
                // replaced wholesale (e.g. concurrent creation); treat as add
                addTo(c.added, kind, key);
              }
            }
          } else {
            const id = String(ev.path[0]);
            addTo(c.changed, kind, id);
            const fk = `${kind}:${id}`;
            let fs = c.fields.get(fk);
            if (!fs) c.fields.set(fk, (fs = new Set()));
            if (ev instanceof Y.YMapEvent) for (const k of ev.keysChanged) fs.add(k);
          }
        }
      };
      ymap.observeDeep(h);
      this.unobserve.push(() => ymap.unobserveDeep(h));
    }
    const after = (tr: Y.Transaction) => {
      const c = this.pending;
      this.pending = null;
      if (!c) return;
      c.origin = tr.origin;
      c.local = tr.local;
      for (const l of [...this.listeners]) {
        try {
          l(c);
        } catch (err) {
          console.error('[scene-doc] change listener failed', err);
        }
      }
    };
    this.ydoc.on('afterTransaction', after);
    this.unobserve.push(() => this.ydoc.off('afterTransaction', after));
  }

  // ---------------------------------------------------------------- generic block helpers

  private readBlock<T extends object>(ymap: Y.Map<any> | undefined, defaults: T): T | null {
    if (!ymap) return null;
    const out: any = { ...defaults };
    for (const [k, v] of ymap.entries()) out[k] = v instanceof Uint8Array ? v : cloneJson(v);
    return out as T;
  }

  private writeFields(ymap: Y.Map<any>, patch: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || v === undefined) continue;
      ymap.set(k, v instanceof Uint8Array ? v : cloneJson(v));
    }
  }

  /**
   * The names of the datablocks of `kind` (`taken`) and the suffix to try first per name
   * (`next`, see uniqueName). While a transaction runs they are collected once and kept current by
   * createBlock and rename, so that an operator that adds thousands of datablocks in one step
   * (Separate by loose parts) names each in constant time: collecting every name and trying the
   * suffixes .001, .002 … again for each new one took more than ten minutes for 20,000 parts.
   * Collected again when other code added datablocks of the kind, and after removeObject and the
   * other remove methods (see forgetNames); remote updates and undo come in transactions of their
   * own.
   */
  private names(kind: DatablockKind): BlockNames {
    const keys = this.map(kind)._map.size;
    let names = this.transactionDepth > 0 ? this.namesInTransaction.get(kind) : undefined;
    if (!names || names.keys !== keys) {
      const taken = new Set<string>();
      for (const m of this.map(kind).values()) taken.add(String((m as Y.Map<any>).get('name') ?? ''));
      names = { taken, next: new Map(), keys };
      if (this.transactionDepth > 0) this.namesInTransaction.set(kind, names);
    }
    return names;
  }

  /** Forgets the names kept for the running transaction (see names): a datablock was removed. */
  private forgetNames(kind: DatablockKind): void {
    this.namesInTransaction.delete(kind);
  }

  private createBlock(
    kind: DatablockKind,
    fields: Record<string, unknown> & { name: string },
    id = newId(),
  ): string {
    const ymap = new Y.Map<any>();
    const names = this.names(kind);
    const name = uniqueName(fields.name, names.taken, names.next);
    this.transact(() => {
      this.map(kind).set(id, ymap);
      ymap.set('id', id);
      this.writeFields(ymap, { ...fields, name });
    });
    names.taken.add(name);
    names.keys = this.map(kind)._map.size;
    return id;
  }

  /** Renames any datablock, keeping names unique within its kind. Returns the final name. */
  rename(kind: DatablockKind, id: string, name: string): string {
    const ymap = this.map(kind).get(id) as Y.Map<any> | undefined;
    if (!ymap) throw new Error(`${kind} ${id} not found`);
    if (ymap.get('name') === name) return name;
    const names = this.names(kind);
    const old = String(ymap.get('name'));
    names.taken.delete(old);
    // the old name's suffix is free again: try its stem's suffixes from the first
    names.next.delete(old.replace(/\.\d{3,}$/, ''));
    const final = uniqueName(name, names.taken, names.next);
    names.taken.add(final);
    this.transact(() => ymap.set('name', final));
    return final;
  }

  has(kind: DatablockKind, id: string): boolean {
    return this.map(kind).has(id);
  }

  // ---------------------------------------------------------------- meta / settings

  getMeta(): ProjectMeta {
    const m = this.map('meta');
    return {
      schema_version: (m.get('schema_version') as number) ?? SCHEMA_VERSION,
      name: (m.get('name') as string) ?? 'Untitled',
      created_at: (m.get('created_at') as string) ?? '',
      generator: (m.get('generator') as string) ?? '',
    };
  }

  get name(): string {
    return this.getMeta().name;
  }

  setName(name: string): void {
    this.transact(() => this.map('meta').set('name', name));
  }

  getScene(): SceneSettings {
    return this.readBlock(this.map('scene'), defaultSceneSettings())!;
  }

  updateScene(patch: Partial<SceneSettings>): void {
    this.transact(() => this.writeFields(this.map('scene'), patch));
  }

  getRender(): RenderSettings {
    return this.readBlock(this.map('render'), defaultRenderSettings())!;
  }

  updateRender(patch: Partial<RenderSettings>): void {
    this.transact(() => this.writeFields(this.map('render'), patch));
  }

  getWorld(): WorldSettings {
    return this.readBlock(this.map('world'), defaultWorldSettings())!;
  }

  updateWorld(patch: Partial<WorldSettings>): void {
    this.transact(() => this.writeFields(this.map('world'), patch));
  }

  // ---------------------------------------------------------------- objects

  getObject(id: string): ObjectData | null {
    const y = this.map('objects').get(id) as Y.Map<any> | undefined;
    if (!y) return null;
    return this.readBlock(y, defaultObject((y.get('type') as ObjectType) ?? 'EMPTY', id, ''));
  }

  listObjects(): ObjectData[] {
    const out: ObjectData[] = [];
    for (const id of this.map('objects').keys()) {
      const o = this.getObject(id);
      if (o) out.push(o);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  objectIds(): string[] {
    return [...this.map('objects').keys()];
  }

  findObjectByName(name: string): ObjectData | null {
    for (const [id, y] of this.map('objects').entries())
      if ((y as Y.Map<any>).get('name') === name) return this.getObject(id);
    return null;
  }

  /** Resolves an object by id or (exact) name. */
  resolveObject(idOrName: string): ObjectData | null {
    return this.getObject(idOrName) ?? this.findObjectByName(idOrName);
  }

  addObject(init: Partial<ObjectData> & { type: ObjectType; name?: string }, id = newId()): string {
    const base = defaultObject(
      init.type,
      id,
      init.name ?? init.type.charAt(0) + init.type.slice(1).toLowerCase(),
    );
    const { id: _ignore, ...fields } = { ...base, ...init, name: init.name ?? base.name };
    return this.createBlock('objects', fields, id);
  }

  updateObject(id: string, patch: Partial<ObjectData>): void {
    const y = this.map('objects').get(id) as Y.Map<any> | undefined;
    if (!y) throw new Error(`object ${id} not found`);
    const { name, ...rest } = patch;
    this.transact(() => {
      this.writeFields(y, rest);
      if (name !== undefined) this.rename('objects', id, name);
    });
  }

  /** Objects whose `parent` is `id` (or root objects when id is null). */
  childrenOf(id: string | null): ObjectData[] {
    return this.listObjects().filter((o) => o.parent === id);
  }

  /** Number of objects using a data block. */
  dataUsers(dataId: string): number {
    let n = 0;
    for (const y of this.map('objects').values()) if ((y as Y.Map<any>).get('data') === dataId) n++;
    return n;
  }

  /**
   * The ids of every object's children by parent id (null: the root objects), each list in the
   * order {@link childrenOf} gives, read once. For operators that look up the children of many
   * objects: childrenOf reads every object, so looking them up again for each of N objects took
   * time in N² (Apply Transform on 2,000 linked cubes took 36 s). It describes the parents of the
   * moment it was read.
   */
  childrenIndex(): Map<string | null, string[]> {
    const out = new Map<string | null, string[]>();
    for (const o of this.listObjects()) {
      const list = out.get(o.parent);
      if (list) list.push(o.id);
      else out.set(o.parent, [o.id]);
    }
    return out;
  }

  /**
   * The number of objects using each data block ({@link dataUsers} of all of them), read once, for
   * operators that ask it for many objects; they keep it current as they give objects other data.
   */
  dataUserCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const y of this.map('objects').values()) {
      const data = (y as Y.Map<any>).get('data') as unknown;
      if (typeof data === 'string') out.set(data, (out.get(data) ?? 0) + 1);
    }
    return out;
  }

  /** Local transform matrix of an object (from its stored, non-animated properties). */
  localMatrix(o: Pick<ObjectData, 'location' | 'rotation_euler' | 'scale'>): Mat4 {
    return compose4(o.location, o.rotation_euler, o.scale);
  }

  /** World matrix from stored properties (ignores animation; see eval for animated matrices). */
  worldMatrix(id: string): Mat4 {
    const chain: ObjectData[] = [];
    let cur = this.getObject(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parent ? this.getObject(cur.parent) : null;
    }
    let m: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const o of chain) m = multiply4(m, this.localMatrix(o));
    return m;
  }

  /**
   * Sets the object's local transform so that its world matrix equals `world`, as far as a
   * location, an XYZ euler rotation and a scale can hold it (shear is dropped). Only what the new
   * matrix changes is written; a channel it leaves as it was keeps its stored value, bit for bit,
   * and is not written at all (no Yjs write, nothing for undo, sync or Adjust Last Operation to
   * see; see {@link changedTransform} for the rules). Every caller relies on that: parenting and
   * clearing parents with Keep Transform (also to and from armatures and bones), removing a parent,
   * Set Origin and Apply Transform (their children keep their world matrices), and the editor's
   * Align Active Camera to View. The transform operators (and Duplicate with an offset, a Move)
   * change channels as Blender's do instead (transformObjects in operators/transform.ts).
   * `parentWorld` is the parent's matrix as the scene evaluates it at the current frame
   * (FrameState.parent: a bone's posed matrix for an object parented to a bone, an animated or
   * constrained parent where it is); left out, it is computed from the stored values, which know
   * nothing of bones, poses, animation or constraints. `held`: the values the object's channels
   * hold at the current frame (an animated channel's value there, FrameState.byId), which the new
   * channels are compared with and kept from (whole turns, signs) instead of the stored ones; a
   * channel it does not change is then not written either. Returns the channels written (null
   * when none).
   */
  setWorldMatrix(
    id: string,
    world: Mat4,
    parentWorld?: Mat4 | null,
    held?: TransformChannels,
  ): Partial<ObjectData> | null {
    const stored = this.getObject(id);
    if (!stored) return null;
    const o = held ? { ...stored, ...held } : stored;
    const parent = parentWorld === undefined ? (o.parent ? this.worldMatrix(o.parent) : null) : parentWorld;
    // the world matrix of the channels, computed as worldMatrix(id) computes it
    const current = parent ? multiply4(parent, this.localMatrix(o)) : this.localMatrix(o);
    const patch = changedTransform(o, world, current, parent);
    if (patch) this.updateObject(id, patch);
    return patch;
  }

  /** True if `ancestor` is `id` or one of its parents. */
  isAncestor(ancestor: string, id: string): boolean {
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === ancestor) return true;
      seen.add(cur);
      cur = (this.map('objects').get(cur) as Y.Map<any> | undefined)?.get('parent') ?? null;
    }
    return false;
  }

  /**
   * Parents an object to `parent` (an object parent; null clears it), keeping its world transform
   * when `keepTransform` (Blender "Object (Keep Transform)", see {@link setWorldMatrix}).
   * `evaluated`: the object's world matrix and the new parent's world matrix as the scene evaluates
   * them at the current frame (FrameState.world: bones, poses, animation and constraints included);
   * left out, both are computed from the stored values, which know nothing of those.
   */
  setParent(
    id: string,
    parent: string | null,
    keepTransform = true,
    evaluated?: { world: Mat4; parentWorld: Mat4 | null },
  ): void {
    if (parent && this.isAncestor(id, parent))
      throw new Error('cannot parent an object to its own descendant');
    this.transact(() => {
      const o = this.getObject(id);
      if (!o) return;
      const world = evaluated?.world ?? this.worldMatrix(id);
      const patch: Partial<ObjectData> = { parent };
      // an object parent: a bone parent's bone no longer applies
      if (o.parent_type !== 'OBJECT') patch.parent_type = 'OBJECT';
      if (o.parent_bone) patch.parent_bone = '';
      this.updateObject(id, patch);
      if (keepTransform) this.setWorldMatrix(id, world, evaluated ? evaluated.parentWorld : undefined);
    });
  }

  /**
   * Removes an object. Children are re-parented to the removed object's parent keeping their
   * world transform; animation curves and orphaned object data are removed as well.
   */
  removeObject(id: string): void {
    this.removeObjects([id]);
  }

  /**
   * Removes objects one after another, each as {@link removeObject} removes it: its children (also
   * those an object removed before it left to it) are re-parented by `reparent`, in the order
   * {@link childrenOf} lists them (by default to the removed object's parent, keeping their world
   * transform; a child `reparent` leaves on the removed object gets that), then the object, its
   * animation curves and drivers, its data when no other object uses it, and the scene camera when
   * it is. The objects, data users, animation curves and drivers are indexed once for all of them:
   * looking them up again for each object made removing N objects take time in N² (1,000 linked
   * cubes took 4–6 s).
   */
  removeObjects(
    ids: Iterable<string>,
    reparent: (child: string, removed: ObjectData) => void = (child, removed) =>
      this.setParent(child, removed.parent, true),
  ): void {
    const objects = this.map('objects');
    const list = [...ids].filter((id) => objects.has(id));
    if (!list.length) return;
    this.transact(() => {
      // children by parent, in childrenOf's order (rank: the objects sorted by name), and data users
      const rank = new Map<string, number>();
      const children = new Map<string | null, Set<string>>();
      const users = new Map<string, number>();
      this.listObjects().forEach((o, i) => {
        rank.set(o.id, i);
        let set = children.get(o.parent);
        if (!set) children.set(o.parent, (set = new Set()));
        set.add(o.id);
        if (o.data) users.set(o.data, (users.get(o.data) ?? 0) + 1);
      });
      const curves = keysByTarget(this.map('fcurves'));
      const drivers = keysByTarget(this.map('drivers'));
      const parentOf = (id: string): string | null =>
        ((objects.get(id) as Y.Map<any> | undefined)?.get('parent') as string | null | undefined) ?? null;
      for (const id of list) {
        const o = this.getObject(id);
        if (!o) continue;
        const kids = [...(children.get(id) ?? [])].sort((a, b) => rank.get(a)! - rank.get(b)!);
        for (const child of kids) reparent(child, o);
        for (const child of kids) if (parentOf(child) === id) this.setParent(child, o.parent, true);
        for (const child of kids) {
          const parent = parentOf(child);
          let set = children.get(parent);
          if (!set) children.set(parent, (set = new Set()));
          set.add(child);
        }
        children.delete(id);
        // (the sets hold the objects that exist, as childrenOf lists them)
        children.get(parentOf(id))?.delete(id);
        objects.delete(id);
        this.forgetNames('objects');
        for (const key of curves.get(id) ?? []) this.map('fcurves').delete(key);
        if (o.data) {
          const left = (users.get(o.data) ?? 1) - 1;
          users.set(o.data, left);
          const kind = left === 0 ? dataKindOf(o.type) : null;
          if (kind) {
            this.map(kind).delete(o.data);
            this.forgetNames(kind);
          }
        }
        for (const key of drivers.get(id) ?? []) this.map('drivers').delete(key);
        if (this.getScene().camera === id) this.updateScene({ camera: null });
      }
    });
  }

  // ---------------------------------------------------------------- meshes

  addMesh(name: string, mesh: MeshData, id = newId()): string {
    // The cache is filled lazily by decoding, so every replica sees identical float32 values.
    return this.createBlock('meshes', { name, data: encodeMesh(mesh) }, id);
  }

  getMeshBlock(id: string): MeshBlock | null {
    const y = this.map('meshes').get(id) as Y.Map<any> | undefined;
    return y ? { id, name: y.get('name') as string } : null;
  }

  listMeshBlocks(): MeshBlock[] {
    return [...this.map('meshes').keys()]
      .map((id) => this.getMeshBlock(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private meshBytes(id: string): Uint8Array | null {
    const y = this.map('meshes').get(id) as Y.Map<any> | undefined;
    const data = y?.get('data');
    return data instanceof Uint8Array ? data : null;
  }

  /** Decoded mesh (cached, treat as immutable). */
  getMesh(id: string): MeshData | null {
    const bytes = this.meshBytes(id);
    if (!bytes) return null;
    let m = this.meshCache.get(bytes);
    if (!m) {
      m = decodeMesh(bytes);
      this.meshCache.set(bytes, m);
    }
    return m;
  }

  getMeshCopy(id: string): MeshData | null {
    const m = this.getMesh(id);
    return m ? cloneMesh(m) : null;
  }

  /** Monotonic version token of a mesh's data (changes whenever the mesh is replaced). */
  meshVersion(id: string): number {
    const bytes = this.meshBytes(id);
    if (!bytes) return -1;
    let v = this.blobVersions.get(bytes);
    if (v === undefined) {
      v = ++this.blobCounter;
      this.blobVersions.set(bytes, v);
    }
    return v;
  }

  /** Version token of a mesh's shape keys or vertex groups (changes whenever they are replaced). */
  meshAttrVersion(id: string, field: 'shape_keys' | 'vertex_groups'): number {
    const v = (this.map('meshes').get(id) as Y.Map<any> | undefined)?.get(field) as unknown;
    if (!v || typeof v !== 'object') return 0;
    let n = this.blobVersions.get(v);
    if (n === undefined) {
      n = ++this.blobCounter;
      this.blobVersions.set(v, n);
    }
    return n;
  }

  meshCounts(id: string): { vertices: number; faces: number; corners: number } | null {
    const bytes = this.meshBytes(id);
    return bytes ? peekMeshCounts(bytes) : null;
  }

  setMesh(id: string, mesh: MeshData): void {
    const y = this.map('meshes').get(id) as Y.Map<any> | undefined;
    if (!y) throw new Error(`mesh ${id} not found`);
    const bytes = encodeMesh(mesh);
    this.transact(() => y.set('data', bytes));
  }

  removeMesh(id: string): void {
    this.transact(() => this.map('meshes').delete(id));
    this.forgetNames('meshes');
  }

  // ---------------------------------------------------------------- materials

  addMaterial(init: Partial<MaterialData> = {}, id = newId()): string {
    const { id: _i, ...fields } = { ...defaultMaterial(id, 'Material'), ...init };
    return this.createBlock('materials', fields, id);
  }

  getMaterial(id: string): MaterialData | null {
    return this.readBlock(this.map('materials').get(id), defaultMaterial(id, ''));
  }

  listMaterials(): MaterialData[] {
    return [...this.map('materials').keys()]
      .map((id) => this.getMaterial(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  updateMaterial(id: string, patch: Partial<MaterialData>): void {
    this.updateBlock('materials', id, patch);
  }

  removeMaterial(id: string): void {
    this.forgetNames('materials');
    this.transact(() => {
      this.map('materials').delete(id);
      for (const o of this.listObjects()) {
        if (o.material_slots.includes(id)) {
          this.updateObject(o.id, { material_slots: o.material_slots.map((s) => (s === id ? null : s)) });
        }
      }
      for (const fc of this.listFCurves(id)) this.map('fcurves').delete(fcurveKey(fc));
    });
  }

  // ---------------------------------------------------------------- lights / cameras

  addLight(init: Partial<LightData> & { type?: LightType } = {}, id = newId()): string {
    const { id: _i, ...fields } = { ...defaultLight(id, 'Light', init.type ?? 'POINT'), ...init };
    return this.createBlock('lights', fields, id);
  }

  getLight(id: string): LightData | null {
    const y = this.map('lights').get(id) as Y.Map<any> | undefined;
    return this.readBlock(y, defaultLight(id, '', (y?.get('type') as LightType) ?? 'POINT'));
  }

  updateLight(id: string, patch: Partial<LightData>): void {
    this.updateBlock('lights', id, patch);
  }

  /** All light datablocks, sorted by name. */
  listLights(): LightData[] {
    return [...this.map('lights').keys()]
      .map((id) => this.getLight(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** All camera datablocks, sorted by name. */
  listCameras(): CameraData[] {
    return [...this.map('cameras').keys()]
      .map((id) => this.getCamera(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  addCamera(init: Partial<CameraData> = {}, id = newId()): string {
    const { id: _i, ...fields } = { ...defaultCamera(id, 'Camera'), ...init };
    return this.createBlock('cameras', fields, id);
  }

  getCamera(id: string): CameraData | null {
    return this.readBlock(this.map('cameras').get(id), defaultCamera(id, ''));
  }

  updateCamera(id: string, patch: Partial<CameraData>): void {
    this.updateBlock('cameras', id, patch);
  }

  // ---------------------------------------------------------------- images

  addImage(
    init: { name: string; mime: string; width: number; height: number; data: Uint8Array },
    id = newId(),
  ): string {
    return this.createBlock('images', init, id);
  }

  getImage(id: string): ImageData | null {
    const y = this.map('images').get(id) as Y.Map<any> | undefined;
    if (!y) return null;
    return {
      id,
      name: y.get('name'),
      mime: y.get('mime'),
      width: y.get('width') ?? 0,
      height: y.get('height') ?? 0,
    };
  }

  getImageBytes(id: string): Uint8Array | null {
    const d = (this.map('images').get(id) as Y.Map<any> | undefined)?.get('data');
    return d instanceof Uint8Array ? d : null;
  }

  listImages(): ImageData[] {
    return [...this.map('images').keys()]
      .map((id) => this.getImage(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  removeImage(id: string): void {
    this.transact(() => this.map('images').delete(id));
    this.forgetNames('images');
  }

  // ---------------------------------------------------------------- collections

  /** The root "Scene Collection" is virtual and always present. */
  getCollection(id: string): CollectionData | null {
    if (id === ROOT_COLLECTION_ID)
      return { ...defaultCollection(ROOT_COLLECTION_ID, 'Scene Collection', null) };
    return this.readBlock(this.map('collections').get(id), defaultCollection(id, ''));
  }

  listCollections(): CollectionData[] {
    return [
      this.getCollection(ROOT_COLLECTION_ID)!,
      ...[...this.map('collections').keys()]
        .map((id) => this.getCollection(id)!)
        .sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }

  addCollection(init: Partial<CollectionData> = {}, id = newId()): string {
    const { id: _i, ...fields } = { ...defaultCollection(id, 'Collection'), ...init };
    return this.createBlock('collections', fields, id);
  }

  updateCollection(id: string, patch: Partial<CollectionData>): void {
    if (id === ROOT_COLLECTION_ID) return;
    this.updateBlock('collections', id, patch);
  }

  /** Removes a collection; its objects and child collections move to its parent. */
  removeCollection(id: string): void {
    if (id === ROOT_COLLECTION_ID) return;
    const c = this.getCollection(id);
    if (!c) return;
    const parent = c.parent ?? ROOT_COLLECTION_ID;
    this.transact(() => {
      for (const o of this.listObjects())
        if (o.collection === id) this.updateObject(o.id, { collection: parent });
      for (const cc of this.listCollections()) if (cc.parent === id) this.updateCollection(cc.id, { parent });
      this.map('collections').delete(id);
    });
    this.forgetNames('collections');
  }

  /** Effective visibility of a collection (false if it or any ancestor is hidden). */
  isCollectionVisible(id: string): boolean {
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur && cur !== ROOT_COLLECTION_ID && !seen.has(cur)) {
      seen.add(cur);
      const c = this.getCollection(cur);
      if (!c) return true;
      if (c.hide_viewport) return false;
      cur = c.parent;
    }
    return true;
  }

  // ---------------------------------------------------------------- generic update/remove

  private updateBlock(kind: DatablockKind, id: string, patch: Record<string, unknown>): void {
    const y = this.map(kind).get(id) as Y.Map<any> | undefined;
    if (!y) throw new Error(`${kind} ${id} not found`);
    const { name, ...rest } = patch as { name?: string };
    this.transact(() => {
      this.writeFields(y, rest);
      if (name !== undefined) this.rename(kind, id, name);
    });
  }

  /** Generic datablock read by kind. */
  getBlock(kind: DatablockKind, id: string): Record<string, unknown> | null {
    switch (kind) {
      case 'objects':
        return this.getObject(id) as unknown as Record<string, unknown> | null;
      case 'meshes':
        return this.getMeshBlock(id) as unknown as Record<string, unknown> | null;
      case 'materials':
        return this.getMaterial(id) as unknown as Record<string, unknown> | null;
      case 'lights':
        return this.getLight(id) as unknown as Record<string, unknown> | null;
      case 'cameras':
        return this.getCamera(id) as unknown as Record<string, unknown> | null;
      case 'images':
        return this.getImage(id) as unknown as Record<string, unknown> | null;
      case 'collections':
        return this.getCollection(id) as unknown as Record<string, unknown> | null;
      case 'curves':
        return this.getCurve(id) as unknown as Record<string, unknown> | null;
      case 'armatures':
        return this.getArmature(id) as unknown as Record<string, unknown> | null;
    }
  }

  /** Generic datablock update by kind (used by property editors, scripting and MCP). */
  updateBlockByKind(kind: DatablockKind, id: string, patch: Record<string, unknown>): void {
    if (kind === 'meshes') {
      if (typeof patch.name === 'string') this.rename('meshes', id, patch.name);
      return;
    }
    if (kind === 'collections' && id === ROOT_COLLECTION_ID) return;
    this.updateBlock(kind, id, patch);
  }

  // ---------------------------------------------------------------- curves (CURVE / FONT data)

  addCurve(init: Partial<CurveData> = {}, id = newId()): string {
    const { id: _i, ...fields } = { ...defaultCurve(id, 'Curve'), ...init };
    return this.createBlock('curves', fields, id);
  }

  getCurve(id: string): CurveData | null {
    return this.readBlock(this.map('curves').get(id), defaultCurve(id, ''));
  }

  updateCurve(id: string, patch: Partial<CurveData>): void {
    this.updateBlock('curves', id, patch);
  }

  listCurves(): CurveData[] {
    return [...this.map('curves').keys()]
      .map((id) => this.getCurve(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- armatures

  addArmature(init: Partial<ArmatureData> = {}, id = newId()): string {
    const { id: _i, ...fields } = { ...defaultArmature(id, 'Armature'), ...init };
    return this.createBlock('armatures', fields, id);
  }

  getArmature(id: string): ArmatureData | null {
    return this.readBlock(this.map('armatures').get(id), defaultArmature(id, ''));
  }

  updateArmature(id: string, patch: Partial<ArmatureData>): void {
    this.updateBlock('armatures', id, patch);
  }

  listArmatures(): ArmatureData[] {
    return [...this.map('armatures').keys()]
      .map((id) => this.getArmature(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- shape keys (stored on meshes)

  /** Shape keys of a mesh datablock (the basis is the mesh itself and is not listed). */
  getShapeKeys(meshId: string): ShapeKeyData[] {
    const y = this.map('meshes').get(meshId) as Y.Map<any> | undefined;
    const keys = y?.get('shape_keys');
    return Array.isArray(keys) ? (cloneJson(keys) as ShapeKeyData[]) : [];
  }

  setShapeKeys(meshId: string, keys: ShapeKeyData[]): void {
    const y = this.map('meshes').get(meshId) as Y.Map<any> | undefined;
    if (!y) throw new Error(`mesh ${meshId} not found`);
    this.transact(() => {
      if (keys.length) y.set('shape_keys', cloneJson(keys));
      else y.delete('shape_keys');
    });
  }

  // ---------------------------------------------------------------- vertex groups (stored on meshes)

  /** Vertex groups (per-vertex weights) of a mesh datablock. */
  getVertexGroups(meshId: string): VertexGroupData[] {
    const y = this.map('meshes').get(meshId) as Y.Map<any> | undefined;
    const groups = y?.get('vertex_groups');
    return Array.isArray(groups) ? (cloneJson(groups) as VertexGroupData[]) : [];
  }

  setVertexGroups(meshId: string, groups: VertexGroupData[]): void {
    const y = this.map('meshes').get(meshId) as Y.Map<any> | undefined;
    if (!y) throw new Error(`mesh ${meshId} not found`);
    this.transact(() => {
      if (groups.length) y.set('vertex_groups', cloneJson(groups));
      else y.delete('vertex_groups');
    });
  }

  // ---------------------------------------------------------------- drivers

  listDrivers(targetId?: string): DriverData[] {
    const out: DriverData[] = [];
    for (const v of this.map('drivers').values()) {
      const d = v as DriverData;
      if (!targetId || d.target_id === targetId) out.push(cloneJson(d));
    }
    return out;
  }

  getDriver(key: string): DriverData | null {
    const v = this.map('drivers').get(key) as DriverData | undefined;
    return v ? cloneJson(v) : null;
  }

  setDriver(d: DriverData): void {
    this.transact(() => this.map('drivers').set(fcurveKey(d), cloneJson(d)));
  }

  removeDriver(key: string): void {
    this.transact(() => this.map('drivers').delete(key));
  }

  // ---------------------------------------------------------------- animation curves

  listFCurves(targetId?: string): FCurve[] {
    const out: FCurve[] = [];
    for (const v of this.map('fcurves').values()) {
      const fc = v as FCurve;
      if (!targetId || fc.target_id === targetId) out.push(cloneJson(fc));
    }
    return out;
  }

  getFCurve(key: string): FCurve | null {
    const v = this.map('fcurves').get(key) as FCurve | undefined;
    return v ? cloneJson(v) : null;
  }

  setFCurve(fc: FCurve): void {
    const sorted = { ...fc, keyframes: [...fc.keyframes].sort((a, b) => a.frame - b.frame) };
    this.transact(() => this.map('fcurves').set(fcurveKey(fc), cloneJson(sorted)));
  }

  removeFCurve(key: string): void {
    this.transact(() => this.map('fcurves').delete(key));
  }

  // ---------------------------------------------------------------- default scene

  /** Adds Blender's familiar startup content: a cube, a camera and a light. */
  populateDefaultScene(): void {
    this.transact(() => {
      const meshId = this.addMesh('Cube', createCube({ size: 2 }));
      const matId = this.addMaterial({ name: 'Material' });
      this.addObject({ type: 'MESH', name: 'Cube', data: meshId, material_slots: [matId] });
      const camData = this.addCamera({ name: 'Camera' });
      const camId = this.addObject({
        type: 'CAMERA',
        name: 'Camera',
        data: camData,
        location: [7.36, -6.93, 4.96],
        rotation_euler: [1.109, 0, 0.815],
      });
      const lightData = this.addLight({ name: 'Light', type: 'POINT', energy: 1000 });
      this.addObject({
        type: 'LIGHT',
        name: 'Light',
        data: lightData,
        location: [4.08, 1.01, 5.9],
        rotation_euler: [0.65, 0.055, 1.866],
      });
      this.updateScene({ camera: camId });
    });
  }

  // ---------------------------------------------------------------- snapshots

  toSnapshot(): SceneSnapshot {
    return {
      meta: this.getMeta(),
      scene: this.getScene(),
      render: this.getRender(),
      world: this.getWorld(),
      objects: this.listObjects(),
      meshes: this.listMeshBlocks().map((b) => {
        const keys = this.getShapeKeys(b.id);
        const groups = this.getVertexGroups(b.id);
        return {
          ...b,
          mesh: cloneMesh(this.getMesh(b.id)!),
          ...(keys.length
            ? { shape_keys: keys.map(({ data, ...k }) => ({ ...k, data_base64: base64Encode(data) })) }
            : {}),
          ...(groups.length
            ? {
                vertex_groups: groups.map((g) => ({ name: g.name, weights_base64: base64Encode(g.weights) })),
              }
            : {}),
        };
      }),
      materials: this.listMaterials(),
      lights: [...this.map('lights').keys()].map((id) => this.getLight(id)!),
      cameras: [...this.map('cameras').keys()].map((id) => this.getCamera(id)!),
      images: this.listImages().map((im) => ({
        ...im,
        data_base64: base64Encode(this.getImageBytes(im.id) ?? new Uint8Array()),
      })),
      collections: this.listCollections().filter((c) => c.id !== ROOT_COLLECTION_ID),
      fcurves: this.listFCurves(),
      curves: this.listCurves(),
      armatures: this.listArmatures(),
      drivers: this.listDrivers(),
    };
  }

  static fromSnapshot(s: SceneSnapshot): SceneDoc {
    const doc = new SceneDoc();
    doc.transact(() => {
      doc.writeFields(doc.map('meta'), { ...s.meta, schema_version: SCHEMA_VERSION });
      doc.writeFields(doc.map('scene'), s.scene as unknown as Record<string, unknown>);
      doc.writeFields(doc.map('render'), s.render as unknown as Record<string, unknown>);
      doc.writeFields(doc.map('world'), s.world as unknown as Record<string, unknown>);
      const put = (kind: DatablockKind, id: string, fields: Record<string, unknown>) => {
        const y = new Y.Map<any>();
        doc.map(kind).set(id, y);
        y.set('id', id);
        doc.writeFields(y, fields);
      };
      for (const c of s.collections) put('collections', c.id, c as unknown as Record<string, unknown>);
      for (const m of s.meshes)
        put('meshes', m.id, {
          name: m.name,
          data: encodeMesh(m.mesh),
          ...(m.shape_keys?.length
            ? {
                shape_keys: m.shape_keys.map(({ data_base64, ...k }) => ({
                  ...k,
                  data: base64Decode(data_base64),
                })),
              }
            : {}),
          ...(m.vertex_groups?.length
            ? {
                vertex_groups: m.vertex_groups.map((g) => ({
                  name: g.name,
                  weights: base64Decode(g.weights_base64),
                })),
              }
            : {}),
        });
      for (const c of s.curves ?? []) put('curves', c.id, c as unknown as Record<string, unknown>);
      for (const a of s.armatures ?? []) put('armatures', a.id, a as unknown as Record<string, unknown>);
      for (const m of s.materials) put('materials', m.id, m as unknown as Record<string, unknown>);
      for (const l of s.lights) put('lights', l.id, l as unknown as Record<string, unknown>);
      for (const c of s.cameras) put('cameras', c.id, c as unknown as Record<string, unknown>);
      for (const im of s.images) {
        const { data_base64, ...rest } = im;
        put('images', im.id, { ...rest, data: base64Decode(data_base64) });
      }
      for (const o of s.objects) put('objects', o.id, o as unknown as Record<string, unknown>);
      for (const fc of s.fcurves) doc.map('fcurves').set(fcurveKey(fc), cloneJson(fc));
      for (const d of s.drivers ?? []) doc.map('drivers').set(fcurveKey(d), cloneJson(d));
    }, SYSTEM_ORIGIN);
    return doc;
  }
}

/**
 * How far a transform value recomputed from a matrix may be from the stored one and still count as
 * unchanged (see {@link changedTransform} and {@link transformTolerance}): this fraction of the
 * larger of the two (of 1 for values nearer 0). It covers the rounding of the matrix products that
 * give callers their matrices (a world matrix taken through a turned, scaled object's matrix and its
 * inverse came back up to 7.2e-15 off in its location, relative to each coordinate or to 1 below 1,
 * and 6.8e-16 of their length in its axes; the largest of 200,000 random cases with locations within
 * 10 of the origin and scales of 0.1 to 10) and stays far below any change worth storing: a rotation
 * by a billionth of a radian is a thousand times more. Values of a child of a parent scaled unevenly
 * get a larger tolerance.
 */
const SAME_TRANSFORM = 1e-12;

/** Whether every component of `a` is within `tol` of the one of `b` (never with a NaN). */
function within(a: readonly number[], b: readonly number[], tol: number): boolean {
  for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= tol)) return false;
  return true;
}

/**
 * The channels of object `o` that the world matrix `world` changes, or null when it changes none
 * (see {@link SceneDoc.setWorldMatrix}). `current` is the world matrix of the stored values,
 * `parentWorld` the parent's world matrix (null without a parent).
 *
 * Blender keeps a parent inverse matrix in each child, which this editor does not have, so its
 * callers need new channels where Blender keeps them or sets them from the world matrix: Blender's
 * parenting stores the inverse of the new parent's matrix in the child and keeps its channels
 * (with Keep Transform it first sets them from the child's world matrix), and its Set Origin sets
 * the children's channels from their world matrices and recomputes their parent inverse. Here the
 * channels are recomputed relative to the parent, by these rules:
 *
 * - The location changes only when the object's origin moves (by more than {@link SAME_TRANSFORM}).
 * - The rotation and the scale stay as stored while the 3×3 part of the world matrix is unchanged
 *   (a parent that only moves). Otherwise each is compared with its stored value on its own, in
 *   the parent's space: a turned parent changes the rotation and keeps the scale, a uniformly
 *   scaled one the scale and keeps the rotation, except where the result would be sheared, or is
 *   a scale by negative factors along two axes (both below). The parent's inverse amplifies
 *   rounding by about the ratio of its longest to its shortest axis, and the tolerance of this
 *   comparison grows with it: without that, turning the child of a parent scaled [1000, 0.01, 1]
 *   by 180° about the parent's Z axis (which changes only the child's rotation) gave its scale
 *   back up to 1.0e-11 off, 8.5e-10 for a parent scaled [10000, 0.001, 1], and stored it again.
 * - A new rotation is the XYZ euler (objects have no other rotation mode or order) closest to the
 *   stored one: Blender's compatible euler, which its Clear Parent with Keep Transform stores,
 *   computed as precisely as the matrix allows near gimbal lock (see matrixToStoredEuler). Whole
 *   turns are kept (190° stays 190° under a parent that turns by 90° about another axis), and so
 *   are |Y| above 90° and |X| or |Z| above 180°.
 * - A new scale keeps the stored sign of each axis (a scale of [1, −1, 1] stays negative on Y)
 *   when the matrix's handedness allows it. A mirroring matrix flips the sign of one axis, or of
 *   all three, whichever leaves the rotation closest to the stored one. A matrix with negative
 *   factors along two of the object's axes does not mirror: it is a rotation by 180° about the
 *   third axis with positive factors, so the signs stay and the rotation turns by 180°.
 *
 * Shear cannot be stored: a parent scaled unevenly and turned relative to the child gives a
 * sheared matrix, from which the rotation and the scale are read with the shear dropped (each axis
 * of the object keeps its direction in the parent's space as far as the others allow; the scale
 * is the length of each axis).
 */
function changedTransform(
  o: ObjectData,
  world: Mat4,
  current: Mat4,
  parentWorld: Mat4 | null,
): Partial<ObjectData> | null {
  const t0 = column(current, 3);
  const t1 = column(world, 3);
  const span = Math.max(1, ...t0.map(Math.abs), ...t1.map(Math.abs));
  const sameLocation = within(t1, t0, SAME_TRANSFORM * span);
  let sameLinear = true;
  for (let c = 0; c < 3 && sameLinear; c++) {
    const a = column(current, c);
    const b = column(world, c);
    sameLinear = within(b, a, SAME_TRANSFORM * Math.max(length3(a), length3(b)));
  }
  if (sameLocation && sameLinear) return null;
  const parentInverse = parentWorld ? invert4(parentWorld) : null;
  const local = parentInverse ? multiply4(parentInverse, world) : world;
  const patch: Partial<ObjectData> = {};
  if (!sameLocation) patch.location = column(local, 3);
  if (!sameLinear) {
    // the parent's inverse amplifies rounding by about the ratio of its axis lengths
    let tol = SAME_TRANSFORM;
    if (parentWorld && parentInverse) {
      const frobenius = (m: Mat4) => Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((k) => m[k]));
      tol *= Math.max(1, (frobenius(parentWorld) * frobenius(parentInverse)) / 3);
    }
    const { rotation, scale } = changedRotationScale(o, local, tol);
    if (rotation) patch.rotation_euler = rotation;
    if (scale) patch.scale = scale;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * The rotation and scale of object `o` read from the 3×3 part of its new local matrix, each null
 * when it is its stored value within `tol` (see {@link changedTransform}).
 */
function changedRotationScale(
  o: ObjectData,
  local: Mat4,
  tol: number,
): { rotation: Vec3 | null; scale: Vec3 | null } {
  const cols = [0, 1, 2].map((c) => column(local, c));
  const lengths = cols.map(length3);
  const stored = rotationFromEuler(o.rotation_euler);
  const old = [0, 1, 2].map((c) => column(stored, c));
  let signs: number[] = o.scale.map((s) => (s < 0 ? -1 : 1));
  if (determinant3(local) * signs[0] * signs[1] * signs[2] < 0)
    signs = mirroredSigns(signs, cols, lengths, old);
  const scale = signs.map((s, i) => s * lengths[i]) as Vec3;
  const sameScale = scale.every(
    (v, i) => Math.abs(v - o.scale[i]) <= tol * Math.max(Math.abs(v), Math.abs(o.scale[i])),
  );
  const axes = rotationAxes(
    cols.map((c, i) => (lengths[i] > 0 ? (c.map((v) => (v * signs[i]) / lengths[i]) as Vec3) : null)),
    old,
  );
  const sameRotation = axes.every((a, i) => within(a, old[i], tol));
  const rotation = sameRotation
    ? null
    : matrixToStoredEuler(matrixFromAxes(axes[0], axes[1], axes[2]), o.rotation_euler);
  const differs = (a: Vec3 | null, b: Vec3) => !!a && a.some((v, i) => v !== b[i]);
  return {
    rotation: differs(rotation, o.rotation_euler) ? rotation : null,
    scale: !sameScale && differs(scale, o.scale) ? scale : null,
  };
}

/**
 * The sign of each scale axis for a matrix whose handedness differs from that of the stored scale
 * `signs` (it mirrors the object): one axis, or all three, flipped, whichever makes the axes
 * `cols` (of lengths `lengths`) closest to the stored rotation's axes `old`. Ties go to X.
 */
function mirroredSigns(signs: number[], cols: Vec3[], lengths: number[], old: Vec3[]): number[] {
  let best = signs;
  let bestScore = -Infinity;
  for (const flip of [[0], [1], [2], [0, 1, 2]]) {
    const s = signs.map((v, i) => (flip.includes(i) ? -v : v));
    let score = 0;
    for (let i = 0; i < 3; i++) if (lengths[i] > 0) score += (s[i] * dot3(cols[i], old[i])) / lengths[i];
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Unit rotation axes from the directions of a matrix's axes (null for an axis scaled to 0, whose
 * direction is lost), right-handed: with one axis lost it is the cross product of the other two;
 * with two lost (or the other two parallel), the axis after the known one is the stored rotation's
 * (`old`) projected perpendicular to it, and the third their cross product; with all three lost
 * they are `old`.
 */
function rotationAxes(dirs: (Vec3 | null)[], old: Vec3[]): Vec3[] {
  const known = [0, 1, 2].filter((i) => dirs[i]);
  if (known.length === 3) return dirs as Vec3[];
  if (known.length === 0) return old;
  const unit = (v: Vec3): Vec3 | null => {
    const l = length3(v);
    return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  };
  const out = dirs.slice() as Vec3[];
  if (known.length === 2) {
    const m = [0, 1, 2].find((i) => !dirs[i])!;
    const lost = unit(cross3(dirs[(m + 1) % 3]!, dirs[(m + 2) % 3]!));
    if (lost) {
      out[m] = lost;
      return out;
    }
  }
  // one axis known (or two in one direction: the first of them): the stored next axis made
  // perpendicular to it (when that one is parallel to it, the stored third axis crossed with it),
  // and their cross product
  const a = dirs[known[0]]!;
  const b = (known[0] + 1) % 3;
  const c = (known[0] + 2) % 3;
  out[b] = unit([0, 1, 2].map((k) => old[b][k] - a[k] * dot3(old[b], a)) as Vec3) ?? unit(cross3(old[c], a))!;
  out[c] = cross3(a, out[b]);
  return out;
}

// ---------------------------------------------------------------- Blender's Move, Rotate and Scale

/** An object's transform channels. */
export type TransformChannels = Pick<ObjectData, 'location' | 'rotation_euler' | 'scale'>;

/** What {@link transformedChannels} does to an object: Blender's Move, Rotate or Scale. */
export type TransformMode = 'TRANSLATE' | 'ROTATE' | 'RESIZE';

/**
 * The matrices Blender's transform tools read from an object before they change its channels
 * (ObjectToTransData in transform_convert_object.cc); the 3×3 ones as Mat4s without translation.
 */
export interface TransformBasis {
  /** The world location of the object's origin (td->center). */
  center: Vec3;
  /**
   * World space to the space of the object's channels (td->smtx): the object's local 3×3 times the
   * inverse of its world 3×3, which is the inverse of the parent's world 3×3 unless the world
   * matrix includes constraints (see {@link transformBasis}).
   */
  smtx: Mat4;
  /** The space of the object's channels to world space (td->mtx): the inverse of smtx. */
  mtx: Mat4;
  /** The object's world axes, normalized (td->axismtx). */
  axismtx: Mat4;
}

/** Whether a 3×3 matrix can be inverted: no axis is 0 and they are not (nearly) in one plane. */
function invertible3(m: Readonly<Mat4>): boolean {
  const volume = length3(column(m, 0)) * length3(column(m, 1)) * length3(column(m, 2));
  return volume > 0 && Math.abs(determinant3(m)) > 1e-12 * volume;
}

/** Blender's ortho_v3_v3: a vector perpendicular to `v` (not normalized). */
function perpendicular(v: Readonly<Vec3>): Vec3 {
  const x = Math.abs(v[0]);
  const y = Math.abs(v[1]);
  const z = Math.abs(v[2]);
  const axis = x > y ? (x > z ? 0 : 2) : y > z ? 1 : 2;
  if (axis === 0) return [-v[1] - v[2], v[0], v[0]];
  if (axis === 1) return [v[1], -v[0] - v[2], v[1]];
  return [v[2], v[2], -v[0] - v[1]];
}

/**
 * Blender's orthogonalize_m3_zero_axes with a unit length: when one or two axes are 0, they are
 * replaced by unit axes perpendicular to the others (so the matrix can be inverted).
 */
function orthogonalizeZeroAxes(m: Readonly<Mat4>): Mat4 {
  const cols = [0, 1, 2].map((c) => column(m, c));
  const zero = cols.map((c) => c[0] === 0 && c[1] === 0 && c[2] === 0);
  const count = zero.filter(Boolean).length;
  if (count === 0 || count === 3) return m.slice();
  const [x, y, z] = zero;
  if (x && y) cols[1] = perpendicular(cols[2]);
  else if (y && z) cols[2] = perpendicular(cols[0]);
  else if (z && x) cols[0] = perpendicular(cols[1]);
  if (x && !(z && x)) cols[0] = cross3(cols[1], cols[2]);
  else if (y && !(x && y)) cols[1] = cross3(cols[0], cols[2]);
  else if (z && !(y && z)) cols[2] = cross3(cols[0], cols[1]);
  for (let i = 0; i < 3; i++) {
    if (!zero[i]) continue;
    const l = length3(cols[i]);
    if (l > 0) cols[i] = [cols[i][0] / l, cols[i][1] / l, cols[i][2] / l];
    else cols[i][i] = 1;
  }
  return matrixFromAxes(cols[0], cols[1], cols[2]);
}

/**
 * Blender's invert_m3_m3_safe_ortho for the matrices {@link transformBasis} gives it: the inverse of
 * a 3×3 matrix, else the identity. Blender first tries again with the zero axes made unit length
 * ({@link orthogonalizeZeroAxes}), which changes none of these matrices (for scales whose products
 * do not underflow): the world 3×3 has had its zero axes made unit length already, and the
 * conversion to the parent's space, the local 3×3 with its zero axes made unit length times an
 * invertible matrix, can be inverted unless all three local axes are 0, and is 0 then, which
 * orthogonalize_m3_zero_axes leaves as it is.
 */
function invertSafeOrtho(m: Readonly<Mat4>): Mat4 {
  return invertible3(m) ? invert4(m) : identity4();
}

/**
 * Blender's transform_orientations_create_from_axis for an object's world axes: each normalized; a
 * zero axis is rebuilt from the others (one: their cross product; two: the other unit axes made
 * perpendicular to the third), else the identity. Blender's LOCAL orientation (the active object's
 * axes) and an object's td->axismtx.
 */
export function orientationAxes(world: Readonly<Mat4>): Mat4 {
  const cols = [0, 1, 2].map((c) => column(world, c));
  const lengths = cols.map(length3);
  const out = cols.map((c, i) => (lengths[i] > 0 ? (c.map((v) => v / lengths[i]) as Vec3) : null));
  const zero = [0, 1, 2].filter((i) => !out[i]);
  const unit = (v: Vec3): Vec3 | null => {
    const l = length3(v);
    return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  };
  if (zero.length === 1) {
    const a = zero[0];
    out[a] = unit(cross3(out[(a + 1) % 3]!, out[(a + 2) % 3]!));
  } else if (zero.length === 2) {
    const axis = [0, 1, 2].find((i) => out[i])!;
    const n = out[axis]!;
    for (const a of [(axis + 1) % 3, (axis + 2) % 3]) {
      const e: Vec3 = [0, 0, 0];
      e[a] = 1;
      out[a] = unit([e[0] - n[0] * n[a], e[1] - n[1] * n[a], e[2] - n[2] * n[a]]);
    }
  }
  return out.every(Boolean) ? matrixFromAxes(out[0]!, out[1]!, out[2]!) : identity4();
}

/**
 * The {@link TransformBasis} of an object with channels `o`, world matrix `world` and parent world
 * matrix `parentWorld` (null without a parent), as ObjectToTransData reads them at the current
 * frame: `o` holds the values the object shows there (Blender's channels hold the animated
 * values), `parentWorld` is its parent's evaluated matrix (a bone's posed matrix for a bone child)
 * and `world` = parentWorld · o, without the object's own constraints, which Blender switches off
 * for this, or with them when `constrained` (Blender's constraints_list_needinv: constraints such
 * as Follow Path that need their effect taken out). `shown`: the world matrix the object shows,
 * its constraints applied, whose axes are td->axismtx. Blender computes the conversion to the
 * parent's space as the local 3×3 times the inverse of the world 3×3 (each with zero axes made unit
 * length first, see {@link orthogonalizeZeroAxes}), which is the inverse of the parent's 3×3 when
 * neither has a zero axis and the world matrix has no constraints in it; that inverse is computed
 * directly then.
 */
export function transformBasis(
  o: TransformChannels,
  world: Readonly<Mat4>,
  parentWorld: Readonly<Mat4> | null,
  shown: Readonly<Mat4> = world,
  constrained = false,
): TransformBasis {
  const center = column(world, 3);
  const axismtx = orientationAxes(shown);
  if (!parentWorld && !constrained) return { center, smtx: identity4(), mtx: identity4(), axismtx };
  const local = linearPart(compose4(o.location, o.rotation_euler, o.scale));
  const parent = parentWorld ? linearPart(parentWorld) : null;
  const zeroAxis = [0, 1, 2].some((c) => length3(column(local, c)) === 0);
  if (parent && !constrained && !zeroAxis && invertible3(parent))
    return { center, smtx: invert4(parent), mtx: parent, axismtx };
  const smtx = multiply4(
    orthogonalizeZeroAxes(local),
    invertSafeOrtho(orthogonalizeZeroAxes(linearPart(world))),
  );
  return { center, smtx, mtx: invertSafeOrtho(smtx), axismtx };
}

/**
 * Blender's TransMat3ToSize: the length of each axis of `m`, negative where the axis points
 * against the same axis of `ref` (after mat3_to_rot_size, which negates all three in a mirroring
 * matrix).
 */
function axisFactors(m: Readonly<Mat4>, ref: Readonly<Mat4>): Vec3 {
  const cols = [0, 1, 2].map((c) => column(m, c));
  const size = cols.map(length3);
  let rot = cols.map((c, i) => (size[i] > 0 ? (c.map((v) => v / size[i]) as Vec3) : ([0, 0, 0] as Vec3)));
  if (determinant3(matrixFromAxes(rot[0], rot[1], rot[2])) < 0) {
    rot = rot.map((c) => c.map((v) => -v) as Vec3);
    for (let i = 0; i < 3; i++) size[i] = -size[i];
  }
  for (let i = 0; i < 3; i++) if (dot3(rot[i], column(ref, i)) < 0) size[i] = -size[i];
  return size as Vec3;
}

/**
 * The channels Blender's Move, Rotate and Scale give an object with channels `o` and transform
 * basis `basis` (the object branches of the translation, ElementRotation_ex and ElementResize in
 * transform_mode.cc; objects have an XYZ euler rotation and no delta transforms here):
 *
 * - TRANSLATE: `m`'s translation is the world offset. The location gets it in the parent's space:
 *   location + smtx · offset. The rotation and the scale stay.
 * - ROTATE: `m`'s 3×3 part is a world rotation about the world point `pivot`. The location gets
 *   the offset of the origin, location + smtx · (R · (origin − pivot) + pivot − origin), so a
 *   rotation about the object's own origin leaves it as it was. The rotation is the euler closest
 *   to the stored one (matrixToStoredEuler: Blender's mat3_to_compatible_eulO, computed as
 *   precisely as the matrix allows near gimbal lock) of
 *   smtx · R · mtx · R(rotation): the world rotation taken into the parent's space, applied to the
 *   stored rotation, with its axes normalized. The scale stays, bit for bit: the child of a parent
 *   scaled unevenly deforms as it turns (its world matrix is sheared, as in Blender).
 * - RESIZE: `m`'s 3×3 part is a world scale about `pivot`. The location gets the offset of the
 *   origin as for ROTATE. Each stored scale is multiplied by the factor `m` gives the object's
 *   axis (axisFactors of m · axismtx: the length `m` gives the axis, negative when `m` turns it
 *   against itself), and the rotation stays: a scale along the object's own axes multiplies each
 *   scale by its factor (S −1 along X and Y of an unrotated object stores [−1, −1, 1]), and one
 *   along other axes gives each axis the length it gets (S X 2 of an object turned 30° about Z
 *   keeps the rotation and scales X by 1.803 and Y by 1.323; S X −1 keeps it and stores [−1, 1, 1],
 *   which is not the mirror image of the object along the world's X axis).
 */
export function transformedChannels(
  o: TransformChannels,
  basis: TransformBasis,
  mode: TransformMode,
  m: Readonly<Mat4>,
  pivot: Readonly<Vec3>,
): TransformChannels {
  const add = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  if (mode === 'TRANSLATE') {
    const offset = transformVector(basis.smtx, [m[12], m[13], m[14]]);
    return { location: add(o.location, offset), rotation_euler: o.rotation_euler, scale: o.scale };
  }
  const c = basis.center;
  const turned = transformVector(m, [c[0] - pivot[0], c[1] - pivot[1], c[2] - pivot[2]]);
  const offset = transformVector(basis.smtx, [
    turned[0] + pivot[0] - c[0],
    turned[1] + pivot[1] - c[1],
    turned[2] + pivot[2] - c[2],
  ]);
  const location = add(o.location, offset);
  const m3 = linearPart(m);
  if (mode === 'ROTATE') {
    const smat = multiply4(basis.smtx, multiply4(m3, basis.mtx));
    const fmat = multiply4(smat, rotationFromEuler(o.rotation_euler));
    return { location, rotation_euler: matrixToStoredEuler(fmat, o.rotation_euler), scale: o.scale };
  }
  const f = axisFactors(multiply4(m3, basis.axismtx), basis.axismtx);
  const scale: Vec3 = [o.scale[0] * f[0], o.scale[1] * f[1], o.scale[2] * f[2]];
  return { location, rotation_euler: o.rotation_euler, scale };
}

/**
 * How far the channels {@link transformedChannels} computes for an object with transform basis
 * `basis` may be from its stored ones and still count as unchanged (see {@link changedChannels}):
 * {@link SAME_TRANSFORM}, grown by about the ratio of the parent's longest to its shortest axis as
 * in {@link changedTransform}, since the conversions to and from the parent's space amplify
 * rounding by about that much. A rotation by 0 or by whole turns, a scale by 1 and a move by 0 then
 * write nothing, except to an object in gimbal lock (Y at ±90°, see matrixToStoredEuler) with Z
 * not 0: a rotation that leaves it in gimbal lock, such as one by 0 or by whole turns, rewrites its
 * rotation with Z set to 0 and X taking the rest, as Blender's Rotate does (whose gimbal lock is
 * wider, within 0.00215° of ±90°). Outside gimbal lock, the rotation they compute came back up to
 * 4.8e-15 off without a parent or under one scaled uniformly, 5.0e-11 under a parent scaled
 * [1000, 0.01, 1] and 4.7e-9 under one scaled [10000, 0.001, 1], less than 1/200 of this tolerance
 * (40,000 random objects each, randomly turned parents; the scale came back up to 4.3e-16 off, the
 * location exactly). Auto keying keys every object a transform transforms all the same (see
 * keyChannelChanges in operators/transform.ts).
 */
export function transformTolerance(basis: TransformBasis): number {
  const frobenius = (m: Readonly<Mat4>) => Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((k) => m[k]));
  return SAME_TRANSFORM * Math.max(1, (frobenius(basis.mtx) * frobenius(basis.smtx)) / 3);
}

/**
 * The channels of `next` whose values differ from those of `o`, or null when none does: a channel
 * differs when one of its components is more than `tol` times the larger of 1 and the two values
 * from the stored one (with the default 0, when any component differs at all). Values that are not
 * finite are left out.
 */
export function changedChannels(
  o: TransformChannels,
  next: TransformChannels,
  tol = 0,
): Partial<ObjectData> | null {
  const patch: Partial<ObjectData> = {};
  for (const k of ['location', 'rotation_euler', 'scale'] as const) {
    const v = next[k];
    const differs = (x: number, i: number) =>
      !(Math.abs(x - o[k][i]) <= tol * Math.max(1, Math.abs(x), Math.abs(o[k][i])));
    if (v.every(Number.isFinite) && v.some(differs)) patch[k] = [v[0], v[1], v[2]];
  }
  return Object.keys(patch).length ? patch : null;
}

/** Convenience: location of the object's world-space origin from stored properties. */
export function objectWorldLocation(doc: SceneDoc, id: string): Vec3 {
  const m = doc.worldMatrix(id);
  return [m[12], m[13], m[14]];
}

/** Datablock kind holding the object data of an object type (null for empties). */
export function dataKindOf(type: ObjectType): DatablockKind | null {
  switch (type) {
    case 'MESH':
      return 'meshes';
    case 'LIGHT':
      return 'lights';
    case 'CAMERA':
      return 'cameras';
    case 'CURVE':
    case 'FONT':
      return 'curves';
    case 'ARMATURE':
      return 'armatures';
    default:
      return null;
  }
}
