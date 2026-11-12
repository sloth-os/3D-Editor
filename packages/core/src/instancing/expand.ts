import type { Mat4 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { CollectionData, ModifierData, ParticleSystemData } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import type { EvaluatedObject } from '../eval/evaluate';
import type { MeshData } from '../mesh/types';
import { decodeFloat32 } from '../mesh/shape-keys';
import {
  evaluateModifierStack,
  getModifierDef,
  isModifierEnabled,
  isModifierTimeDependent,
  modifierDependencies,
  registerBuiltinModifiers,
} from '../modifiers';
import { stableStringify } from '../util/json';
import type { EvaluatedInstance } from './types';
import { MAX_INSTANCES, normalizeParticleSettings, type ParticleSettings } from './settings';
import { scatterParticles, type ScatterResult } from './sampling';
import { placeParticles, type PlacementResult, type SourceOption, type SourceTemplate } from './particles';
import { sameGeometry, sameSurface, sameTopology } from './mesh-compare';
import {
  affine4,
  invertAffine,
  isFiniteMatrix,
  isIdentity4,
  linear3,
  matrixKey,
  mulAffine,
  rotation3,
  scale3,
  translate4,
} from './matrix';

export interface InstanceContext {
  doc: SceneDoc;
  frame: number;
  forRender: boolean;
  /** Evaluated objects (meshes, matrices, visibility) of the current evaluation. */
  objects: readonly EvaluatedObject[];
  byId: ReadonlyMap<string, EvaluatedObject>;
  /**
   * Viewport evaluation of everything an instancer could make real (operators: reports, make
   * real): every particle system shown in the viewport or in renders, with all of its particles
   * (`display_percentage` ignored).
   */
  fullDisplay?: boolean;
  /**
   * Only expand these instancers (object ids); what they instance is still expanded as needed.
   * Lets operators evaluate one emitter without expanding the whole scene.
   */
  owners?: ReadonlySet<string>;
}

export interface InstanceResult {
  instances: EvaluatedInstance[];
  errors: { objectId: string; message: string }[];
}

/** Maximum nesting of instancers inside instanced collections (Blender uses 8 as well). */
export const MAX_INSTANCE_DEPTH = 8;

/** Upper bound of instances computed per evaluation (including nested intermediate lists). */
const WORK_LIMIT = 4 * MAX_INSTANCES;

// ------------------------------------------------------------------ caches (keyed by content)

/*
 * Results are cached per document and evaluation mode (V viewport, R render, F full display),
 * one slot per instancer / particle system. Entries are validated by content (key strings plus a
 * comparison of the meshes they were computed from), never by object identity alone, so they stay
 * valid across evaluators: a one-shot evaluation (operator report, export, MCP query) reuses the
 * viewport's distributions and placements instead of recomputing them, and leaves the viewport
 * cache intact. Content-validated entries of one mode are also valid in the others (a render
 * reuses the viewport's distributions; full-display reports reuse viewport placements).
 */

/** Evaluation mode: viewport, render, or full display (operators). */
type Mode = 'V' | 'R' | 'F';

interface Slot<T> {
  data: T;
  /** Generation of the last evaluation that used the entry (unused entries are pruned). */
  gen: number;
}

/** A particle distribution. */
interface ScatterData {
  key: string;
  /** Distribution mesh the samples refer to. */
  mesh: MeshData;
  result: ScatterResult;
  /** Unique id of this distribution (part of the placement keys). */
  token: number;
}

/** The instances of one collection instance or particle system. */
interface PartData {
  key: string;
  /** Mesh the placement read positions and normals from (particles), null otherwise. */
  mesh: MeshData | null;
  list: EvaluatedInstance[];
  errors: string[];
  /** False when the list was cut short by the per-evaluation work budget (never reused). */
  complete: boolean;
}

/** Rest shape of an emitter whose modifiers change the topology (see `restShape`). */
interface RestData {
  key: string;
  /** Base mesh, then the meshes of the modifier dependencies (null for objects without one). */
  inputs: (MeshData | null)[];
  mesh: MeshData | null;
}

interface ListEntry {
  parts: EvaluatedInstance[][];
  list: EvaluatedInstance[];
  token: number;
  gen: number;
}

interface ModeCache {
  gen: number;
  scatter: Map<string, Slot<ScatterData>>;
  parts: Map<string, Slot<PartData>>;
  rest: Map<string, Slot<RestData>>;
  lists: Map<string, ListEntry>;
  contents: Map<string, { key: string; token: number; gen: number }>;
  output: { parts: EvaluatedInstance[][]; result: EvaluatedInstance[] } | null;
}

const docCaches = new WeakMap<SceneDoc, Map<Mode, ModeCache>>();
/** Source of unique tokens (lists, collection contents, distributions); never reused. */
let tokenCounter = 0;

function newModeCache(): ModeCache {
  return {
    gen: 0,
    scatter: new Map(),
    parts: new Map(),
    rest: new Map(),
    lists: new Map(),
    contents: new Map(),
    output: null,
  };
}

/** Other modes whose cached entries a mode may reuse, most likely match first. */
const FALLBACK_MODES: Record<Mode, Mode[]> = { V: ['F', 'R'], R: ['V', 'F'], F: ['V', 'R'] };

function docModes(doc: SceneDoc): Map<Mode, ModeCache> {
  let modes = docCaches.get(doc);
  if (!modes) docCaches.set(doc, (modes = new Map()));
  return modes;
}

function modeCache(doc: SceneDoc, mode: Mode): ModeCache {
  const modes = docModes(doc);
  let c = modes.get(mode);
  if (!c) modes.set(mode, (c = newModeCache()));
  return c;
}

function sameInputs(a: readonly (MeshData | null)[], b: readonly (MeshData | null)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && (!x || !y || !sameGeometry(x, y))) return false;
  }
  return true;
}

/** Drops cached instancing results of a document (e.g. to free memory). */
export function clearInstanceCache(doc: SceneDoc): void {
  docCaches.delete(doc);
}

function sameArrays(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concatLists(parts: EvaluatedInstance[][], limit: number): EvaluatedInstance[] {
  if (parts.length === 1 && parts[0].length <= limit) return parts[0];
  const out: EvaluatedInstance[] = [];
  for (const p of parts)
    for (const it of p) {
      if (out.length >= limit) return out;
      out.push(it);
    }
  return out;
}

// ------------------------------------------------------------------ expansion

interface LocalResult {
  list: EvaluatedInstance[];
  token: number;
  /** Instancing levels used below and including this object. */
  maxDepth: number;
  /** Some nesting was skipped because the depth budget ran out. */
  hitDepth: boolean;
  budget: number;
}

interface Member {
  ev: EvaluatedObject;
  nested: LocalResult | null;
}

/** Whether a particle system is shown in an evaluation mode (full display: viewport or render). */
function systemShown(p: ParticleSystemData, mode: Mode): boolean {
  if (mode === 'R') return p.show_render !== false;
  if (mode === 'V') return p.show_viewport !== false;
  return p.show_viewport !== false || p.show_render !== false;
}

/** Particle systems of an object that are enabled in this evaluation mode (tolerates corrupt data). */
function enabledSystems(o: EvaluatedObject, mode: Mode): ParticleSystemData[] {
  const list = o.data.particle_systems;
  if (!Array.isArray(list)) return [];
  return list.filter((p) => !!p && typeof p === 'object' && typeof p.id === 'string' && systemShown(p, mode));
}

/** True when the object generates instances in this evaluation mode. */
function isInstancer(o: EvaluatedObject, mode: Mode): boolean {
  const d = o.data;
  if (d.instance_type === 'COLLECTION' && d.instance_collection) return true;
  return enabledSystems(o, mode).length > 0;
}

/** A collection's instance offset as finite numbers (0 for invalid components). */
function instanceOffset(c: CollectionData | null): [number, number, number] {
  const v = c?.instance_offset;
  const at = (i: number) => (Array.isArray(v) && Number.isFinite(v[i]) ? (v[i] as number) : 0);
  return [at(0), at(1), at(2)];
}

/** One evaluation's expansion state (memoized per object, cycle-safe, depth-limited). */
class Expander {
  readonly errors: { objectId: string; message: string }[] = [];
  private readonly errorKeys = new Set<string>();
  private readonly memo = new Map<string, LocalResult>();
  private readonly stack = new Set<string>();
  private readonly gen: number;
  private created = 0;
  private byCollection: Map<string, EvaluatedObject[]> | null = null;
  private childCollections: Map<string, CollectionData[]> | null = null;
  private readonly collectionData = new Map<string, CollectionData | null>();
  private collectionNames: Map<string, string> | null = null;
  private objectNames: Map<string, EvaluatedObject> | null = null;
  private readonly memberMemo = new Map<string, EvaluatedObject[]>();
  private readonly contentMemo = new Map<string, { members: Member[]; token: number }>();
  /** Viewport evaluation (applies display_percentage). */
  private readonly viewport: boolean;

  /**
   * @param others caches of the document's other evaluation modes: content-validated entries found
   *   there are reused (copied into this mode's cache) instead of being recomputed.
   */
  constructor(
    private readonly ctx: InstanceContext,
    private readonly cache: ModeCache,
    private readonly mode: Mode,
    private readonly others: readonly ModeCache[],
  ) {
    this.gen = cache.gen;
    this.viewport = mode === 'V';
  }

  /**
   * Cached data of a slot that passes `valid`: this mode's entry first, then the other modes'
   * (adopted into this mode's cache). Null when nothing valid is cached.
   */
  private reuse<T>(
    pick: (c: ModeCache) => Map<string, Slot<T>>,
    slot: string,
    valid: (data: T) => boolean,
  ): T | null {
    const own = pick(this.cache);
    const mine = own.get(slot);
    if (mine && valid(mine.data)) {
      mine.gen = this.gen;
      return mine.data;
    }
    for (const c of this.others) {
      const s = pick(c).get(slot);
      if (s && valid(s.data)) {
        own.set(slot, { data: s.data, gen: this.gen });
        return s.data;
      }
    }
    return null;
  }

  /**
   * The mesh a slot's cached data was computed from when it has the same content as `mesh`, else
   * `mesh`: recomputing on that identical object reuses the caches attached to it (triangulation,
   * normals) instead of rebuilding them for another evaluator's copy.
   */
  private canonical<T extends { mesh: MeshData | null }>(
    pick: (c: ModeCache) => Map<string, Slot<T>>,
    slot: string,
    mesh: MeshData,
    same: (a: MeshData, b: MeshData) => boolean,
  ): MeshData {
    for (const c of [this.cache, ...this.others]) {
      const prev = pick(c).get(slot)?.data.mesh;
      if (prev && same(prev, mesh)) return prev;
    }
    return mesh;
  }

  error(objectId: string, message: string): void {
    const k = `${objectId}\u0000${message}`;
    if (this.errorKeys.has(k)) return;
    this.errorKeys.add(k);
    this.errors.push({ objectId, message });
  }

  private remainingWork(): number {
    return Math.max(0, Math.min(MAX_INSTANCES, WORK_LIMIT - this.created));
  }

  private noteCreated(n: number): void {
    this.created += n;
  }

  // ---------------------------------------------------------------- collections

  collection(id: string): CollectionData | null {
    if (!this.collectionData.has(id)) {
      const c = id === ROOT_COLLECTION_ID ? null : this.ctx.doc.getCollection(id);
      this.collectionData.set(id, c);
    }
    return this.collectionData.get(id)!;
  }

  /**
   * Id of a referenced collection: references are ids (operators store ids), exact names are
   * accepted as well (data written by hand or by generic property tools). Null when unknown.
   */
  private collectionId(ref: string): string | null {
    if (ref === ROOT_COLLECTION_ID || this.collection(ref)) return ref;
    if (!this.collectionNames) {
      this.collectionNames = new Map();
      for (const c of this.ctx.doc.listCollections())
        if (!this.collectionNames.has(c.name)) this.collectionNames.set(c.name, c.id);
    }
    return this.collectionNames.get(ref) ?? null;
  }

  /** Evaluated object referenced by id or exact name. */
  private objectRef(ref: string): EvaluatedObject | undefined {
    const hit = this.ctx.byId.get(ref);
    if (hit) return hit;
    if (!this.objectNames) {
      this.objectNames = new Map();
      for (const o of this.ctx.objects) if (!this.objectNames.has(o.name)) this.objectNames.set(o.name, o);
    }
    return this.objectNames.get(ref);
  }

  /** Objects of a collection and (recursively) its child collections, in a stable order. */
  members(cid: string): EvaluatedObject[] {
    const hit = this.memberMemo.get(cid);
    if (hit) return hit;
    if (!this.byCollection) {
      this.byCollection = new Map();
      for (const o of this.ctx.objects) {
        const list = this.byCollection.get(o.data.collection);
        if (list) list.push(o);
        else this.byCollection.set(o.data.collection, [o]);
      }
      this.childCollections = new Map();
      for (const c of this.ctx.doc.listCollections()) {
        if (c.id === ROOT_COLLECTION_ID) continue;
        const parent = c.parent ?? ROOT_COLLECTION_ID;
        const list = this.childCollections.get(parent);
        if (list) list.push(c);
        else this.childCollections.set(parent, [c]);
      }
    }
    const out: EvaluatedObject[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const o of this.byCollection!.get(id) ?? []) out.push(o);
      for (const child of this.childCollections!.get(id) ?? []) visit(child.id);
    };
    visit(cid);
    this.memberMemo.set(cid, out);
    return out;
  }

  // ---------------------------------------------------------------- per object

  /** Instances generated by `o` (world matrices), or null when it is part of an instancing cycle. */
  local(o: EvaluatedObject, budget: number): LocalResult | null {
    const memo = this.memo.get(o.id);
    if (memo && (memo.budget === budget || (!memo.hitDepth && memo.maxDepth <= budget))) return memo;
    if (this.stack.has(o.id)) {
      this.error(o.id, `Instancing cycle: '${o.name}' ends up instancing itself; the recursion is skipped`);
      return null;
    }
    this.stack.add(o.id);
    const state = { maxDepth: 1, hitDepth: false };
    const parts: EvaluatedInstance[][] = [];
    try {
      const d = o.data;
      if (d.instance_type === 'COLLECTION' && d.instance_collection) {
        if (o.type !== 'EMPTY')
          this.error(o.id, `Only empties can instance a collection ('${o.name}' is a ${o.type} object)`);
        else parts.push(this.collectionPart(o, d.instance_collection, budget, state));
      }
      // a duplicated system id on one object (hand-edited data) gets an index suffix to stay unique
      const seen = new Set<string>();
      enabledSystems(o, this.mode).forEach((ps, i) => {
        const systemId = seen.has(ps.id) ? `${ps.id}#${i}` : ps.id;
        seen.add(ps.id);
        parts.push(this.particlePart(o, ps, systemId, budget, state));
      });
    } finally {
      this.stack.delete(o.id);
    }
    const nonEmpty = parts.filter((p) => p.length > 0);
    const entry = this.cache.lists.get(o.id);
    let result: LocalResult;
    if (entry && sameArrays(entry.parts, nonEmpty)) {
      entry.gen = this.gen;
      result = { list: entry.list, token: entry.token, ...state, budget };
    } else {
      const list = concatLists(nonEmpty, Infinity);
      const token = ++tokenCounter;
      this.cache.lists.set(o.id, { parts: nonEmpty, list, token, gen: this.gen });
      result = { list, token, ...state, budget };
    }
    this.memo.set(o.id, result);
    return result;
  }

  /** Nested instances of an instancer inside an instanced collection / particle source. */
  private nested(
    src: EvaluatedObject,
    budget: number,
    state: { maxDepth: number; hitDepth: boolean },
    ownerId: string,
  ): LocalResult | null {
    if (!isInstancer(src, this.mode)) return null;
    if (budget <= 1) {
      state.hitDepth = true;
      this.error(
        ownerId,
        `Instancing is nested deeper than ${MAX_INSTANCE_DEPTH} levels; the instances of '${src.name}' are skipped`,
      );
      return null;
    }
    const r = this.local(src, budget - 1);
    if (r) {
      state.maxDepth = Math.max(state.maxDepth, r.maxDepth + 1);
      if (r.hitDepth) state.hitDepth = true;
    }
    return r;
  }

  /**
   * Cached instance list of one slot (`slot`), rebuilt when `key` or the content of `mesh` (the
   * mesh the placement reads, if any) changed. `build` receives the mesh to read (`mesh`, or a
   * cached object with the same content).
   */
  private part(
    key: string,
    slot: string,
    ownerId: string,
    prefix: string,
    mesh: MeshData | null,
    build: (
      limit: number,
      errors: string[],
      mesh: MeshData | null,
    ) => { list: EvaluatedInstance[]; truncated: boolean },
  ): EvaluatedInstance[] {
    const hit = this.reuse(
      (c) => c.parts,
      slot,
      (d) =>
        d.complete && d.key === key && (d.mesh === mesh || (!!d.mesh && !!mesh && sameSurface(d.mesh, mesh))),
    );
    if (hit) {
      for (const e of hit.errors) this.error(ownerId, prefix + e);
      return hit.list;
    }
    if (mesh) mesh = this.canonical((c) => c.parts, slot, mesh, sameSurface);
    const limit = this.remainingWork();
    const errors: string[] = [];
    const { list, truncated } = limit > 0 ? build(limit, errors, mesh) : { list: [], truncated: true };
    const complete = !(truncated && limit < MAX_INSTANCES);
    if (truncated && complete)
      errors.push(`instance limit of ${MAX_INSTANCES} reached; some instances are skipped`);
    if (!complete)
      errors.push('too many instances in the scene; some instances are skipped (reduce counts or nesting)');
    this.noteCreated(list.length);
    this.cache.parts.set(slot, { data: { key, mesh, list, errors, complete }, gen: this.gen });
    for (const e of errors) this.error(ownerId, prefix + e);
    return list;
  }

  // ---------------------------------------------------------------- collection instances

  /**
   * Members of an instanced collection with their nested instances (memoized per evaluation; the
   * content token changes whenever anything a collection instance reads from it changes).
   * `selfId` is the instancer being expanded: when it is inside the collection (`selfMember`) it is
   * left out, so that content is memoized separately from the content other instancers see.
   */
  private collectionContent(
    cid: string,
    budget: number,
    state: { maxDepth: number; hitDepth: boolean },
    selfId: string,
    selfMember: boolean,
  ) {
    const memoKey = selfMember ? `${cid}|${budget}|${selfId}` : `${cid}|${budget}`;
    const hit = this.contentMemo.get(memoKey);
    if (hit) {
      for (const m of hit.members)
        if (m.nested) {
          state.maxDepth = Math.max(state.maxDepth, m.nested.maxDepth + 1);
          if (m.nested.hitDepth) state.hitDepth = true;
        }
      return hit;
    }
    const members: Member[] = [];
    const keyParts: string[] = [];
    for (const ev of this.members(cid)) {
      const nested = ev.id === selfId ? null : this.nested(ev, budget, state, selfId);
      if (!ev.mesh && !nested?.list.length) continue;
      members.push({ ev, nested });
      keyParts.push(
        `${ev.id}:${ev.mesh ? 1 : 0}:${matrixKey(ev.worldMatrix)}:${nested ? nested.token : '-'}`,
      );
    }
    const c = this.collection(cid);
    keyParts.push(`o${instanceOffset(c).join(',')}`);
    const key = keyParts.join('|');
    const cached = this.cache.contents.get(memoKey);
    let token: number;
    if (cached && cached.key === key) {
      cached.gen = this.gen;
      token = cached.token;
    } else {
      token = ++tokenCounter;
      this.cache.contents.set(memoKey, { key, token, gen: this.gen });
    }
    const out = { members, token };
    this.contentMemo.set(memoKey, out);
    return out;
  }

  private collectionPart(
    o: EvaluatedObject,
    ref: string,
    budget: number,
    state: { maxDepth: number; hitDepth: boolean },
  ): EvaluatedInstance[] {
    const cid = this.collectionId(ref);
    if (cid === ROOT_COLLECTION_ID) {
      this.error(o.id, `'${o.name}' cannot instance the Scene Collection`);
      return [];
    }
    const coll = cid ? this.collection(cid) : null;
    if (!cid || !coll) {
      this.error(o.id, `'${o.name}' instances a missing collection (${ref})`);
      return [];
    }
    if (!isFiniteMatrix(o.worldMatrix)) {
      this.error(o.id, `'${o.name}' has a non-finite transform; its collection instance is skipped`);
      return [];
    }
    const self = this.members(cid).some((m) => m.id === o.id);
    const content = this.collectionContent(cid, budget, state, o.id, self);
    if (self)
      this.error(
        o.id,
        `'${o.name}' is inside the collection '${coll.name}' it instances; it is not instanced itself`,
      );
    const off = instanceOffset(coll);
    const key = `${matrixKey(o.worldMatrix)}|c${content.token}|${self ? 's' : ''}`;
    return this.part(key, `C|${o.id}`, o.id, '', null, (limit) => {
      const P = mulAffine(o.worldMatrix, translate4(-off[0], -off[1], -off[2]));
      const list: EvaluatedInstance[] = [];
      for (const m of content.members) {
        if (m.ev.id === o.id) continue;
        if (m.ev.mesh && isFiniteMatrix(m.ev.worldMatrix)) {
          if (list.length >= limit) return { list, truncated: true };
          list.push({
            id: `${o.id}:${m.ev.id}`,
            ownerId: o.id,
            sourceId: m.ev.id,
            matrix: mulAffine(P, m.ev.worldMatrix),
          });
        }
        for (const n of m.nested?.list ?? []) {
          if (list.length >= limit) return { list, truncated: true };
          list.push({
            id: `${o.id}:${n.id}`,
            ownerId: o.id,
            sourceId: n.sourceId,
            matrix: mulAffine(P, n.matrix),
          });
        }
      }
      return { list, truncated: false };
    });
  }

  // ---------------------------------------------------------------- particle systems

  private particlePart(
    o: EvaluatedObject,
    ps: ParticleSystemData,
    systemId: string,
    budget: number,
    state: { maxDepth: number; hitDepth: boolean },
  ): EvaluatedInstance[] {
    const prefix = `Particle system '${ps.name}': `;
    const { settings, errors: settingErrors } = normalizeParticleSettings(ps.settings);
    for (const e of settingErrors) this.error(o.id, prefix + e);
    if (settings.instance_type === 'NONE') return [];
    if (o.type !== 'MESH' && o.type !== 'CURVE' && o.type !== 'FONT') {
      this.error(
        o.id,
        `${prefix}particle systems need a mesh, curve or text emitter ('${o.name}' is ${o.type})`,
      );
      return [];
    }
    const evalMesh = o.mesh ?? o.baseMesh;
    const baseMesh = o.baseMesh ?? o.mesh;
    if (!evalMesh || !baseMesh) {
      this.error(o.id, `${prefix}the emitter has no geometry`);
      return [];
    }
    if (!isFiniteMatrix(o.worldMatrix)) {
      this.error(o.id, `${prefix}the emitter transform is not finite`);
      return [];
    }
    // Particles are distributed on the emitter's rest shape and evaluated on the current surface,
    // so they stay attached (same triangle and barycentric weights) while shape keys and deforming
    // modifiers move the surface, and the result never depends on which frames were evaluated.
    // `pos` always has the topology of `dist`.
    const deformOnly = sameTopology(evalMesh, baseMesh);
    let dist: MeshData;
    let pos: MeshData;
    if (!settings.use_modifier_stack) {
      dist = baseMesh;
      pos = deformOnly ? evalMesh : baseMesh;
    } else if (deformOnly) {
      dist = baseMesh;
      pos = evalMesh;
    } else {
      dist = this.restShape(o, baseMesh, evalMesh);
      pos = evalMesh;
    }

    // ---- sources (keys first; templates are only built when the placement changes)
    const src = this.sources(o, settings, budget, state, prefix);
    if (!src) return [];

    // ---- distribution (cached on the distribution mesh content + settings)
    const scatter = this.scatter(o, systemId, settings, dist, prefix);
    if (!scatter) return [];

    // the share of particles shown: viewport placements with 100% equal full-display/render ones
    const shown = this.viewport ? Math.max(0, Math.min(100, settings.display_percentage)) : 100;
    const key = [
      scatter.token,
      matrixKey(o.worldMatrix),
      stableStringify(settings),
      src.key,
      `d${shown}`,
    ].join('#');
    for (const e of scatter.result.errors) this.error(o.id, prefix + e);
    return this.part(key, `P|${o.id}|${systemId}`, o.id, prefix, pos, (limit, errors, mesh) => {
      const options = src.build(errors);
      const r: PlacementResult = placeParticles({
        ownerId: o.id,
        systemId,
        samples: scatter.result.samples,
        mesh: mesh ?? pos,
        matrix: o.worldMatrix,
        settings,
        options,
        viewport: this.viewport,
        limit,
      });
      return { list: r.instances, truncated: r.truncated };
    });
  }

  /**
   * Distribution mesh of an emitter whose modifier stack changes the topology (use_modifier_stack):
   * the base mesh with the enabled modifiers that are not deforming ones applied — the stack's
   * result without shape keys and DEFORM modifiers (armature, displace, wave, …). Particles then
   * keep their place on the surface while the emitter deforms. Returns the evaluated mesh itself
   * when nothing deforms it, or when the rest shape does not have the evaluated mesh's topology
   * (e.g. a merge-by-distance after an armature); then a deformation re-distributes the particles.
   */
  private restShape(o: EvaluatedObject, base: MeshData, evalMesh: MeshData): MeshData {
    registerBuiltinModifiers();
    const flags = { forRender: this.ctx.forRender, editMode: false };
    const mods: ModifierData[] = (Array.isArray(o.data.modifiers) ? o.data.modifiers : []).filter(
      (m) => !!m && typeof m === 'object' && isModifierEnabled(m, flags),
    );
    const deforming = (m: ModifierData) => getModifierDef(m.type)?.category === 'DEFORM';
    const meshId = o.type === 'MESH' ? o.data.data : null;
    const doc = this.ctx.doc;
    const shapeKeys = !!meshId && doc.meshAttrVersion(meshId, 'shape_keys') !== 0;
    if (!shapeKeys && !mods.some(deforming)) return evalMesh;

    const generate = mods.filter((m) => !deforming(m));
    const deps = [...new Set(generate.flatMap((m) => modifierDependencies(m)))];
    const depObjects = deps.map((d) => (d === o.id ? null : (this.ctx.byId.get(d) ?? null)));
    const key = [
      stableStringify(generate),
      generate.some((m) => isModifierTimeDependent(m)) ? `f${this.ctx.frame}` : '',
      deps.length ? matrixKey(o.worldMatrix) : '',
      deps.map((d, i) => `${d}:${matrixKey(depObjects[i]?.worldMatrix)}`).join('|'),
      meshId ? `g${doc.meshAttrVersion(meshId, 'vertex_groups')}` : '',
      this.ctx.forRender ? 'R' : 'V',
    ].join('#');
    const inputs = [base, ...depObjects.map((d) => d?.mesh ?? null)];
    const hit = this.reuse(
      (c) => c.rest,
      o.id,
      (d) => d.key === key && sameInputs(d.inputs, inputs),
    );
    let rest: MeshData | null;
    if (hit) rest = hit.mesh;
    else {
      const byId = this.ctx.byId;
      try {
        rest = evaluateModifierStack(base, generate, {
          frame: this.ctx.frame,
          objectMatrix: o.worldMatrix,
          forRender: this.ctx.forRender,
          editMode: false,
          getObjectMesh: (id) => {
            const d = id === o.id ? undefined : byId.get(id);
            return d?.mesh ? { mesh: d.mesh, matrix: d.worldMatrix } : null;
          },
          getObjectMatrix: (id) => byId.get(id)?.worldMatrix ?? null,
          // the types of the objects its modifiers name, as the scene's evaluation gives them
          // (evaluate.ts): Blender's is_disabled leaves out the same modifiers here, an Array whose
          // start cap is a text, a Boolean whose object is a curve, …
          getObjectType: (id) => byId.get(id)?.type ?? null,
          vertexGroups: meshId ? doc.getVertexGroups(meshId) : undefined,
        }).mesh;
      } catch {
        rest = null;
      }
      this.cache.rest.set(o.id, { data: { key, inputs, mesh: rest }, gen: this.gen });
    }
    return rest && sameTopology(rest, evalMesh) ? rest : evalMesh;
  }

  /** Cached distribution of one particle system (validated by the content of `dist`). */
  private scatter(
    o: EvaluatedObject,
    systemId: string,
    s: ParticleSettings,
    dist: MeshData,
    prefix: string,
  ): ScatterData | null {
    const doc = this.ctx.doc;
    let groupKey = '';
    const meshId = o.type === 'MESH' ? o.data.data : null;
    if (s.vertex_group_density) {
      if (!meshId) {
        this.error(o.id, `${prefix}vertex_group_density needs a mesh emitter; ignored`);
      } else
        groupKey = `${doc.meshAttrVersion(meshId, 'vertex_groups')}:${s.vertex_group_density}:${s.invert_vertex_group_density}`;
    }
    let metric: number[] | null = null;
    if (s.min_distance > 0) metric = metricFactor(o.worldMatrix);
    const distSettings = {
      count: s.distribution === 'GRID' ? 0 : s.count,
      seed: s.seed,
      emit_from: s.emit_from,
      distribution: s.distribution,
      even: s.use_even_distribution,
      grid: s.distribution === 'GRID' ? [s.grid_resolution, s.grid_random] : null,
      min_distance: s.min_distance,
    };
    const key = [groupKey, stableStringify(distSettings), metric ? metric.join(',') : ''].join('#');
    const slot = `${o.id}|${systemId}`;
    const hit = this.reuse(
      (c) => c.scatter,
      slot,
      (d) => d.key === key && sameGeometry(d.mesh, dist),
    );
    if (hit) return hit;
    dist = this.canonical((c) => c.scatter, slot, dist, sameGeometry);
    let density: Float32Array | null = null;
    const extraErrors: string[] = [];
    if (groupKey && meshId) {
      const group = doc.getVertexGroups(meshId).find((g) => g.name === s.vertex_group_density);
      const nv = Math.floor(dist.positions.length / 3);
      if (!group) extraErrors.push(`vertex group '${s.vertex_group_density}' not found; density ignored`);
      else {
        const w = decodeFloat32(group.weights);
        if (w.length !== nv)
          extraErrors.push(
            `vertex group '${s.vertex_group_density}' has ${w.length} weights but the emitter mesh has ${nv} vertices ` +
              '(modifiers change the topology; set use_modifier_stack false); density ignored',
          );
        else {
          density = new Float32Array(nv);
          for (let i = 0; i < nv; i++) {
            const x = Number.isFinite(w[i]) ? Math.min(1, Math.max(0, w[i])) : 0;
            density[i] = s.invert_vertex_group_density ? 1 - x : x;
          }
        }
      }
    }
    let result: ScatterResult;
    try {
      result = scatterParticles({ mesh: dist, settings: s, density, metric });
    } catch (e) {
      this.error(o.id, `${prefix}distribution failed: ${(e as Error).message}`);
      return null;
    }
    result.errors.unshift(...extraErrors);
    const data: ScatterData = { key, mesh: dist, result, token: ++tokenCounter };
    this.cache.scatter.set(slot, { data, gen: this.gen });
    return data;
  }

  /**
   * Instance sources of a particle system: a cache key describing everything the placement reads
   * from them, and a builder for the templates.
   */
  private sources(
    o: EvaluatedObject,
    s: ParticleSettings,
    budget: number,
    state: { maxDepth: number; hitDepth: boolean },
    prefix: string,
  ): { key: string; build: (errors: string[]) => SourceOption[] } | null {
    const describe = (ev: EvaluatedObject, nested: LocalResult | null) =>
      `${ev.id}:${ev.mesh ? 1 : 0}:${matrixKey(ev.worldMatrix)}:${nested ? nested.token : '-'}`;
    const nestedOf = (ev: EvaluatedObject) => (ev.id === o.id ? null : this.nested(ev, budget, state, o.id));

    if (s.instance_type === 'OBJECT') {
      if (!s.instance_object) {
        this.error(o.id, `${prefix}no instance_object set`);
        return null;
      }
      const ev = this.objectRef(s.instance_object);
      if (!ev) {
        this.error(o.id, `${prefix}instance object ${s.instance_object} not found`);
        return null;
      }
      const nested = nestedOf(ev);
      if (!ev.mesh && !nested?.list.length) {
        this.error(o.id, `${prefix}instance object '${ev.name}' (${ev.type}) has no geometry to instance`);
        return null;
      }
      return {
        key: describe(ev, nested),
        build: (errors) => [
          { name: ev.name, weight: 1, templates: this.objectTemplates(ev, nested, s, errors) },
        ],
      };
    }

    // COLLECTION
    const ref = s.instance_collection;
    if (!ref) {
      this.error(o.id, `${prefix}no instance_collection set`);
      return null;
    }
    const cid = this.collectionId(ref);
    const coll = !cid || cid === ROOT_COLLECTION_ID ? null : this.collection(cid);
    if (!cid || !coll) {
      this.error(
        o.id,
        cid === ROOT_COLLECTION_ID
          ? `${prefix}the Scene Collection cannot be instanced`
          : `${prefix}instance collection ${ref} not found`,
      );
      return null;
    }
    const members: Member[] = [];
    for (const ev of this.members(cid)) {
      if (ev.id === o.id) continue; // the emitter never instances itself
      const nested = nestedOf(ev);
      if (ev.mesh || nested?.list.length) members.push({ ev, nested });
    }
    if (!members.length) {
      this.error(o.id, `${prefix}collection '${coll.name}' has no objects with geometry to instance`);
      return null;
    }
    const off = instanceOffset(coll);
    if (s.use_whole_collection) {
      return {
        key: `W|${off.join(',')}|${members.map((m) => describe(m.ev, m.nested)).join('|')}`,
        build: () => {
          const T = translate4(-off[0], -off[1], -off[2]);
          const templates: SourceTemplate[] = [];
          for (const m of members) {
            if (m.ev.mesh && isFiniteMatrix(m.ev.worldMatrix))
              templates.push({
                sourceId: m.ev.id,
                matrix: mulAffine(T, m.ev.worldMatrix),
                identity: false,
                suffix: `:${m.ev.id}`,
              });
            for (const n of m.nested?.list ?? [])
              templates.push({
                sourceId: n.sourceId,
                matrix: mulAffine(T, n.matrix),
                identity: false,
                suffix: `:${n.id}`,
              });
          }
          return [{ name: coll.name, weight: 1, templates }];
        },
      };
    }
    // weights reference objects by id (operators store ids); names are accepted for hand-written data
    const weights = new Map<string, number>();
    for (const w of s.instance_weights) weights.set(w.object, w.weight);
    const weightOf = (ev: EvaluatedObject) => weights.get(ev.id) ?? weights.get(ev.name) ?? 1;
    if (!members.some((m) => weightOf(m.ev) > 0)) {
      this.error(o.id, `${prefix}every object of collection '${coll.name}' has weight 0`);
      return null;
    }
    return {
      key: `S|${members.map((m) => `${describe(m.ev, m.nested)}*${weightOf(m.ev)}`).join('|')}`,
      build: (errors) =>
        members.map((m) => ({
          name: m.ev.name,
          weight: weightOf(m.ev),
          templates: this.objectTemplates(m.ev, m.nested, s, errors),
        })),
    };
  }

  /** Templates of one object placed at a particle (its own geometry plus its nested instances). */
  private objectTemplates(
    ev: EvaluatedObject,
    nested: LocalResult | null,
    s: ParticleSettings,
    errors: string[],
  ): SourceTemplate[] {
    const W = ev.worldMatrix;
    const lin = linear3(W);
    let L: Mat4;
    if (s.use_rotation_instance && s.use_scale_instance) L = affine4(lin);
    else if (s.use_rotation_instance) L = affine4(rotation3(lin));
    else if (s.use_scale_instance) {
      // like Blender, the scale alone is taken unsigned (mirroring needs the rotation as well)
      const sc = scale3(lin);
      L = affine4([Math.abs(sc[0]), 0, 0, 0, sc[1], 0, 0, 0, sc[2]]);
    } else L = affine4([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    if (!isFiniteMatrix(L)) L = affine4([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const out: SourceTemplate[] = [];
    if (ev.mesh) out.push({ sourceId: ev.id, matrix: L, identity: isIdentity4(L), suffix: '' });
    if (nested?.list.length) {
      const inv = invertAffine(W);
      if (!inv) errors.push(`the nested instances of '${ev.name}' are skipped (its transform is singular)`);
      else {
        const rebase = mulAffine(L, inv);
        for (const n of nested.list)
          out.push({
            sourceId: n.sourceId,
            matrix: mulAffine(rebase, n.matrix),
            identity: false,
            suffix: `:${n.id}`,
          });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- top level

  run(): EvaluatedInstance[] {
    const filter = this.ctx.owners;
    const parts: EvaluatedInstance[][] = [];
    const owners: EvaluatedObject[] = [];
    for (const o of this.ctx.objects) {
      if (filter && !filter.has(o.id)) continue;
      if (!isInstancer(o, this.mode)) continue;
      let r: LocalResult | null = null;
      try {
        r = this.local(o, MAX_INSTANCE_DEPTH);
      } catch (e) {
        this.error(o.id, `instancing failed: ${(e as Error).message}`);
      }
      if (r && r.list.length) {
        parts.push(r.list);
        owners.push(o);
      }
    }
    this.reportTotal(parts, owners);
    // a filtered run is not the scene's output
    if (filter) return concatLists(parts, MAX_INSTANCES);
    const prev = this.cache.output;
    if (prev && sameArrays(prev.parts, parts)) return prev.result;
    const result = concatLists(parts, MAX_INSTANCES);
    this.cache.output = { parts, result };
    return result;
  }

  /** Reports every instancer whose instances the scene-wide limit cuts (instancers fill it in object order). */
  private reportTotal(parts: EvaluatedInstance[][], owners: EvaluatedObject[]): void {
    let total = 0;
    for (let i = 0; i < parts.length; i++) {
      const before = total;
      total += parts[i].length;
      if (total <= MAX_INSTANCES) continue;
      const n = parts[i].length;
      const skipped = Math.min(n, total - MAX_INSTANCES);
      this.error(
        owners[i].id,
        `the scene exceeds the limit of ${MAX_INSTANCES} instances: ${
          before >= MAX_INSTANCES ? `all ${n}` : `${skipped} of the ${n}`
        } instances of '${owners[i].name}' are skipped (instancers fill the limit in name order)`,
      );
    }
  }
}

/**
 * Upper-triangular factor U of the Gram matrix of the emitter's linear part (G = LᵀL = UᵀU), so that
 * world-space distances between object-space points are |U·(a − b)| and rotations of the emitter do
 * not change the cache key. Returned as [u00, u01, u02, u11, u12, u22].
 */
function metricFactor(m: Mat4): number[] {
  const c0 = [m[0], m[1], m[2]];
  const c1 = [m[4], m[5], m[6]];
  const c2 = [m[8], m[9], m[10]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const g00 = dot(c0, c0);
  const g01 = dot(c0, c1);
  const g02 = dot(c0, c2);
  const g11 = dot(c1, c1);
  const g12 = dot(c1, c2);
  const g22 = dot(c2, c2);
  const eps = 1e-14 * Math.max(g00, g11, g22, 1e-300);
  const u00 = g00 > eps ? Math.sqrt(g00) : 0;
  const u01 = u00 ? g01 / u00 : 0;
  const u02 = u00 ? g02 / u00 : 0;
  const r11 = g11 - u01 * u01;
  const u11 = r11 > eps ? Math.sqrt(r11) : 0;
  const u12 = u11 ? (g12 - u01 * u02) / u11 : 0;
  const r22 = g22 - u02 * u02 - u12 * u12;
  const u22 = r22 > eps ? Math.sqrt(r22) : 0;
  // rounding keeps keys stable against floating noise from rotation-only animation
  return [u00, u01, u02, u11, u12, u22].map((x) => (Number.isFinite(x) ? Number(x.toPrecision(12)) : 0));
}

/**
 * Expands collection instances (empties with instance_type COLLECTION) and particle systems
 * into instances. Instances of hidden source objects (and of hidden source collections) are still
 * generated; visibility follows the owner. Deterministic (seeded) and bounded: nesting depth
 * {@link MAX_INSTANCE_DEPTH}, at most {@link MAX_INSTANCES} instances; problems are reported in
 * `errors`, never thrown.
 *
 * Results are cached per document and evaluation mode, validated by content (emitter geometry,
 * settings, transforms, sources) rather than object identity: unchanged inputs return the
 * identical arrays and instance objects in every evaluator (viewport, one-shot evaluations of
 * operators, exports and renders), moving an emitter re-places particles without re-distributing
 * them, and particles are distributed on the emitter's rest shape so that they follow shape keys
 * and deforming modifiers.
 */
export function expandInstances(ctx: InstanceContext): InstanceResult {
  const mode: Mode = ctx.forRender ? 'R' : ctx.fullDisplay ? 'F' : 'V';
  const cache = modeCache(ctx.doc, mode);
  const modes = docModes(ctx.doc);
  const others = FALLBACK_MODES[mode].flatMap((m) => modes.get(m) ?? []);
  cache.gen++;
  const ex = new Expander(ctx, cache, mode, others);
  let instances: EvaluatedInstance[] = [];
  try {
    instances = ex.run();
  } catch (e) {
    ex.error('', `instancing failed: ${(e as Error).message}`);
  }
  // Prune entries this evaluation did not use (deleted objects, systems, collections). A filtered
  // viewport/render run leaves the other instancers' entries alone; full-display results are only
  // kept for the instancers of the last run (anything else falls back to the viewport cache).
  if (!ctx.owners || mode === 'F') {
    const gen = cache.gen;
    const maps = [cache.scatter, cache.parts, cache.rest, cache.lists, cache.contents];
    for (const m of maps as Map<string, { gen: number }>[])
      for (const [k, v] of m) if (v.gen !== gen) m.delete(k);
  }
  return { instances, errors: ex.errors };
}
