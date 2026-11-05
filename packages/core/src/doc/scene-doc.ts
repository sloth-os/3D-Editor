import * as Y from 'yjs';
import type { Vec3 } from '../math/types';
import { compose4, decompose4, invert4, multiply4 } from '../math/mat4';
import type { Mat4 } from '../math/types';
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

  /** Sets the object's local transform so that its world matrix equals `world`. */
  setWorldMatrix(id: string, world: Mat4): void {
    const o = this.getObject(id);
    if (!o) return;
    const parentWorld = o.parent ? this.worldMatrix(o.parent) : null;
    const local = parentWorld ? multiply4(invert4(parentWorld), world) : world;
    const d = decompose4(local);
    this.updateObject(id, { location: d.location, rotation_euler: d.rotation, scale: d.scale });
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
