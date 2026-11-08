import * as Y from 'yjs';
import type { Vec3 } from '../math/types';
import { compose4, invert4, multiply4, rotationFromEuler } from '../math/mat4';
import type { Mat4 } from '../math/types';
import { cross3, dot3, length3 } from '../math/vec3';
import {
  EULER_GIMBAL_LOCK,
  column,
  compatibleEuler,
  determinant3,
  matrixFromAxes,
  matrixToCompatibleEuler,
  normalizedAxes,
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
    this.ydoc.transact(() => {
      result = fn();
    }, origin);
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

  private names(kind: DatablockKind): Set<string> {
    const s = new Set<string>();
    for (const m of this.map(kind).values()) s.add(String((m as Y.Map<any>).get('name') ?? ''));
    return s;
  }

  private createBlock(
    kind: DatablockKind,
    fields: Record<string, unknown> & { name: string },
    id = newId(),
  ): string {
    const ymap = new Y.Map<any>();
    const name = uniqueName(fields.name, this.names(kind));
    this.transact(() => {
      this.map(kind).set(id, ymap);
      ymap.set('id', id);
      this.writeFields(ymap, { ...fields, name });
    });
    return id;
  }

  /** Renames any datablock, keeping names unique within its kind. Returns the final name. */
  rename(kind: DatablockKind, id: string, name: string): string {
    const ymap = this.map(kind).get(id) as Y.Map<any> | undefined;
    if (!ymap) throw new Error(`${kind} ${id} not found`);
    if (ymap.get('name') === name) return name;
    const names = this.names(kind);
    names.delete(String(ymap.get('name')));
    const final = uniqueName(name, names);
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
   * see; see {@link changedTransform} for the rules). Every caller relies on that: the transform
   * operators (Move, Rotate, Scale with typed values and snapping, Duplicate with an offset),
   * parenting and clearing parents with Keep Transform, removing a parent, Set Origin and Apply
   * Transform (their children keep their world matrices), and the editor's Align Active Camera to
   * View.
   */
  setWorldMatrix(id: string, world: Mat4): void {
    const o = this.getObject(id);
    if (!o) return;
    const parentWorld = o.parent ? this.worldMatrix(o.parent) : null;
    // the world matrix of the stored values, computed as worldMatrix(id) computes it
    const current = parentWorld ? multiply4(parentWorld, this.localMatrix(o)) : this.localMatrix(o);
    const patch = changedTransform(o, world, current, parentWorld);
    if (patch) this.updateObject(id, patch);
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

  /** Re-parents keeping the world transform (Blender "Object (Keep Transform)"). */
  setParent(id: string, parent: string | null, keepTransform = true): void {
    if (parent && this.isAncestor(id, parent))
      throw new Error('cannot parent an object to its own descendant');
    this.transact(() => {
      const world = this.worldMatrix(id);
      this.updateObject(id, { parent });
      if (keepTransform) this.setWorldMatrix(id, world);
    });
  }

  /**
   * Removes an object. Children are re-parented to the removed object's parent keeping their
   * world transform; animation curves and orphaned object data are removed as well.
   */
  removeObject(id: string): void {
    const o = this.getObject(id);
    if (!o) return;
    this.transact(() => {
      for (const child of this.childrenOf(id)) this.setParent(child.id, o.parent, true);
      this.map('objects').delete(id);
      for (const fc of this.listFCurves(id)) this.map('fcurves').delete(fcurveKey(fc));
      if (o.data && this.dataUsers(o.data) === 0) {
        const kind = dataKindOf(o.type);
        if (kind) this.map(kind).delete(o.data);
      }
      for (const d of this.listDrivers(id)) this.map('drivers').delete(fcurveKey(d));
      const scene = this.getScene();
      if (scene.camera === id) this.updateScene({ camera: null });
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
 * unchanged: this fraction of the larger of the two (of 1 m for world locations nearer the origin).
 * It covers the rounding of the matrix products callers make (rotating 20,000 random objects about
 * their own origins gave their world locations back up to 2.5e-16 of the largest coordinate off)
 * and stays far below any change worth storing: a rotation by a billionth of a radian is a thousand
 * times more. The rotation and scale of a child of a parent scaled unevenly get a larger tolerance
 * (see {@link changedTransform}).
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
 * `parentWorld` the parent's world matrix (null without a parent). Blender's transform tools work
 * on the stored channels themselves; these rules give the same results from matrices:
 *
 * - The location changes only when the object's origin moves (by more than {@link SAME_TRANSFORM}):
 *   a Move, or a rotation or scale about another point than the object's own origin (the 3D
 *   cursor, the median point of several objects). Rotating or scaling an object about its own
 *   origin leaves its location as stored. Blender's Rotate and Scale likewise add only the offset
 *   of that origin to the stored location.
 * - The rotation and the scale stay as stored while the 3×3 part of the world matrix is unchanged:
 *   a Move never writes them (Blender's Move changes only the location). Otherwise each is compared
 *   with its stored value on its own, in the parent's space: a rotation keeps the stored scale and
 *   a scale along the object's own axes (any scale of an unrotated object, a uniform scale of any
 *   object) keeps the stored rotation, as Blender's Rotate and Scale do, except where the result
 *   would be sheared, or is a scale by negative factors along two axes (both below). The parent's
 *   inverse amplifies rounding by about the ratio of its longest to its shortest axis, and the
 *   tolerance of this comparison grows with it: without that, turning the child of a parent scaled
 *   [1000, 0.01, 1] by 180° about the parent's Z axis (which changes only the child's rotation)
 *   gave its scale back up to 1.0e-11 off, 8.5e-10 for a parent scaled [10000, 0.001, 1], and
 *   stored it again.
 * - A new rotation is the XYZ euler (objects have no other rotation mode or order) closest to the
 *   stored one, as Blender's Rotate stores it (mat3_to_compatible_eulO): whole turns are kept
 *   (170° + 20° gives 190°, 730° + 10° gives 740°), and so are |Y| above 90° and |X| or |Z| above
 *   180°. In gimbal lock (Y within 0.00215° of ±90°) only X − Z or X + Z is defined: Blender then
 *   sets Z to 0 (plus whole turns) and puts the rest into X; here Z keeps its stored value and X
 *   takes the rest, which gives the same matrix with angles closer to the stored ones.
 * - A new scale keeps the stored sign of each axis (a scale of [1, −1, 1] stays negative on Y)
 *   when the matrix's handedness allows it. A mirroring matrix flips the sign of one axis, or of
 *   all three, whichever leaves the rotation closest to the stored one: mirroring along the
 *   object's own X axis flips its X scale and a uniform scale by −1 flips all three, as Blender's
 *   Scale does (it multiplies each stored scale by the factor along that axis of the object).
 *   A scale with negative factors along two of the object's axes does not mirror: it is a rotation
 *   by 180° about the third axis with positive factors, so the signs stay and the rotation turns by
 *   180° about that axis (S −1 along X and Y of an unrotated object stores a Z rotation of 180° and
 *   keeps the scale). Blender's Scale keeps the rotation and negates those two scales instead; both
 *   give the same matrix.
 *
 * Shear cannot be stored. A scale along other axes than the object's own (S X on a rotated object)
 * would shear it: Blender's Scale then keeps the rotation and gives each axis of the object the
 * factor it gets; here the new rotation and scale are read from the sheared matrix (its X axis
 * keeps its direction). Rotating the child of a parent scaled unevenly would shear the child too:
 * Blender's Rotate keeps its scale (the child deforms as it turns); here it takes the rotation and
 * the scale of its new matrix, without the shear.
 *
 * Blender keeps a parent inverse matrix in each child, which this editor does not have. Blender's
 * parenting keeps the child's channels and stores the inverse of the new parent's matrix; here Keep
 * Transform recomputes the channels relative to the new parent by these rules (what the new parent
 * leaves as it was keeps its stored value). Armature Deform and Bone parenting, and clearing a Bone
 * parent, with Keep Transform do not come here (armatureParentSet and clearBoneParent in
 * operators/armature.ts): they store all three channels as decompose4 reads them from the new
 * matrix, also when it is unchanged. Set Origin changes only the object's location, like Blender's;
 * its children keep their world matrices, which changes only their locations here (Blender
 * recomputes their channels and their parent inverse instead). Align Active Camera to View sets the
 * camera's location, rotation (the euler closest to its current one) and scale from the view, like
 * Blender's (BKE_object_apply_mat4 with compatible eulers).
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
    : continuousEuler(matrixFromAxes(axes[0], axes[1], axes[2]), o.rotation_euler);
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
 * direction is lost): the lost ones are rebuilt perpendicular to the others, as close to the stored
 * rotation's axes `old` as that allows, keeping the axes right-handed.
 */
function rotationAxes(dirs: (Vec3 | null)[], old: Vec3[]): Vec3[] {
  const known = [0, 1, 2].filter((i) => dirs[i]);
  if (known.length === 3) return dirs as Vec3[];
  if (known.length === 0) return old;
  const out = dirs.slice();
  const unit = (v: Vec3): Vec3 | null => {
    const l = length3(v);
    return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  };
  if (known.length === 2) {
    const m = [0, 1, 2].find((i) => !dirs[i])!;
    out[m] = unit(cross3(dirs[(m + 1) % 3]!, dirs[(m + 2) % 3]!)) ?? old[m];
  } else {
    const a = dirs[known[0]]!;
    const b = (known[0] + 1) % 3;
    const c = (known[0] + 2) % 3;
    // the stored next axis made perpendicular to the known one (the one after it when parallel)
    out[b] =
      unit([0, 1, 2].map((k) => old[b][k] - a[k] * dot3(old[b], a)) as Vec3) ??
      unit(cross3(old[c], a)) ??
      old[b];
    out[c] = cross3(a, out[b]!);
  }
  const axes = out as Vec3[];
  // right-handed: flip the rebuilt axis if needed
  if (dot3(cross3(axes[0], axes[1]), axes[2]) < 0) {
    const m = [0, 1, 2].find((i) => !dirs[i])!;
    axes[m] = [-axes[m][0], -axes[m][1], -axes[m][2]];
  }
  return axes;
}

/**
 * The XYZ euler of rotation `rot` closest to `old` (see {@link changedTransform}): Blender's
 * compatible euler, except that in gimbal lock Z keeps its stored value and X takes the rest.
 */
function continuousEuler(rot: Mat4, old: Readonly<Vec3>): Vec3 {
  const e = matrixToCompatibleEuler(rot, old);
  const n = normalizedAxes(rot);
  if (Math.hypot(n[0], n[1]) > EULER_GIMBAL_LOCK) return e;
  // only X − Z (Y = 90°, n[2] = −sin Y < 0) or X + Z (Y = −90°) is defined, and e has all of it in X
  const dz = old[2] - e[2];
  return compatibleEuler([e[0] + (n[2] < 0 ? dz : -dz), e[1], old[2]], old);
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
