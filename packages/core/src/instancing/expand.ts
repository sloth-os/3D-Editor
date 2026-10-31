import type { Mat4 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { CollectionData, ParticleSystemData } from '../doc/types';
import { ROOT_COLLECTION_ID } from '../doc/types';
import type { EvaluatedObject } from '../eval/evaluate';
import type { MeshData } from '../mesh/types';
import { decodeFloat32 } from '../mesh/shape-keys';
import { stableStringify } from '../util/json';
import type { EvaluatedInstance } from './types';
import { MAX_INSTANCES, normalizeParticleSettings, type ParticleSettings } from './settings';
import { scatterParticles, type ScatterResult } from './sampling';
import { placeParticles, type PlacementResult, type SourceOption, type SourceTemplate } from './particles';
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
  /** Viewport evaluation that ignores `display_percentage` (e.g. to make every instance real). */
  fullDisplay?: boolean;
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

interface PartEntry {
  key: string;
  list: EvaluatedInstance[];
  errors: string[];
  /** False when the list was cut short by the per-evaluation work budget (never reused). */
  complete: boolean;
  gen: number;
}

interface ScatterEntry {
  key: string;
  result: ScatterResult;
  token: number;
  gen: number;
}

interface ListEntry {
  parts: EvaluatedInstance[][];
  list: EvaluatedInstance[];
  token: number;
  gen: number;
}

interface ModeCache {
  gen: number;
  scatter: Map<string, ScatterEntry>;
  parts: Map<string, PartEntry>;
  lists: Map<string, ListEntry>;
  contents: Map<string, { key: string; token: number; gen: number }>;
  output: { parts: EvaluatedInstance[][]; result: EvaluatedInstance[] } | null;
}

const docCaches = new WeakMap<SceneDoc, Map<string, ModeCache>>();
const identityTokens = new WeakMap<object, number>();
let tokenCounter = 0;

/** Unique token of an (immutable) object instance: equal tokens imply identical content. */
function identityToken(o: object): number {
  let t = identityTokens.get(o);
  if (t === undefined) identityTokens.set(o, (t = ++tokenCounter));
  return t;
}

function newModeCache(): ModeCache {
  return {
    gen: 0,
    scatter: new Map(),
    parts: new Map(),
    lists: new Map(),
    contents: new Map(),
    output: null,
  };
}

function modeCache(doc: SceneDoc, mode: string): ModeCache {
  let modes = docCaches.get(doc);
  if (!modes) docCaches.set(doc, (modes = new Map()));
  let c = modes.get(mode);
  if (!c) modes.set(mode, (c = newModeCache()));
  return c;
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

/** Particle systems of an object that are enabled in this evaluation mode (tolerates corrupt data). */
function enabledSystems(o: EvaluatedObject, forRender: boolean): ParticleSystemData[] {
  const list = o.data.particle_systems;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (p) =>
      !!p &&
      typeof p === 'object' &&
      typeof p.id === 'string' &&
      (forRender ? p.show_render !== false : p.show_viewport !== false),
  );
}

/** True when the object generates instances in this evaluation mode. */
function isInstancer(o: EvaluatedObject, forRender: boolean): boolean {
  const d = o.data;
  if (d.instance_type === 'COLLECTION' && d.instance_collection) return true;
  return enabledSystems(o, forRender).length > 0;
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
  private readonly memberMemo = new Map<string, EvaluatedObject[]>();
  private readonly contentMemo = new Map<string, { members: Member[]; token: number }>();
  private readonly viewport: boolean;

  constructor(
    private readonly ctx: InstanceContext,
    private readonly cache: ModeCache,
  ) {
    this.gen = cache.gen;
    this.viewport = !ctx.forRender && !ctx.fullDisplay;
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
      enabledSystems(o, this.ctx.forRender).forEach((ps, i) => {
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
    if (!isInstancer(src, this.ctx.forRender)) return null;
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

  private part(
    key: string,
    cacheKey: string,
    ownerId: string,
    prefix: string,
    build: (limit: number, errors: string[]) => { list: EvaluatedInstance[]; truncated: boolean },
  ): EvaluatedInstance[] {
    const entry = this.cache.parts.get(cacheKey);
    if (entry && entry.complete && entry.key === key) {
      entry.gen = this.gen;
      for (const e of entry.errors) this.error(ownerId, prefix + e);
      return entry.list;
    }
    const limit = this.remainingWork();
    const errors: string[] = [];
    const { list, truncated } = limit > 0 ? build(limit, errors) : { list: [], truncated: true };
    const complete = !(truncated && limit < MAX_INSTANCES);
    if (truncated && complete)
      errors.push(`instance limit of ${MAX_INSTANCES} reached; some instances are skipped`);
    if (!complete)
      errors.push('too many instances in the scene; some instances are skipped (reduce counts or nesting)');
    this.noteCreated(list.length);
    this.cache.parts.set(cacheKey, { key, list, errors, complete, gen: this.gen });
    for (const e of errors) this.error(ownerId, prefix + e);
    return list;
  }

  // ---------------------------------------------------------------- collection instances

  /**
   * Members of an instanced collection with their nested instances (memoized per evaluation; the
   * content token changes whenever anything a collection instance reads from it changes).
   * `selfId` is the instancer being expanded: it is skipped silently when it is inside the collection.
   */
  private collectionContent(
    cid: string,
    budget: number,
    state: { maxDepth: number; hitDepth: boolean },
    selfId: string,
  ) {
    const memoKey = `${cid}|${budget}`;
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
    cid: string,
    budget: number,
    state: { maxDepth: number; hitDepth: boolean },
  ): EvaluatedInstance[] {
    if (cid === ROOT_COLLECTION_ID) {
      this.error(o.id, `'${o.name}' cannot instance the Scene Collection`);
      return [];
    }
    const coll = this.collection(cid);
    if (!coll) {
      this.error(o.id, `'${o.name}' instances a missing collection (${cid})`);
      return [];
    }
    if (!isFiniteMatrix(o.worldMatrix)) {
      this.error(o.id, `'${o.name}' has a non-finite transform; its collection instance is skipped`);
      return [];
    }
    const content = this.collectionContent(cid, budget, state, o.id);
    const self = this.members(cid).some((m) => m.id === o.id);
    if (self)
      this.error(
        o.id,
        `'${o.name}' is inside the collection '${coll.name}' it instances; it is not instanced itself`,
      );
    const off = instanceOffset(coll);
    const key = `${matrixKey(o.worldMatrix)}|c${content.token}|${self ? 's' : ''}`;
    return this.part(key, `C|${o.id}`, o.id, '', (limit) => {
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
    let dist: MeshData;
    let pos: MeshData;
    if (settings.use_modifier_stack) dist = pos = evalMesh;
    else {
      dist = baseMesh;
      pos =
        evalMesh !== baseMesh &&
        evalMesh.positions.length === baseMesh.positions.length &&
        evalMesh.faces.length === baseMesh.faces.length
          ? evalMesh
          : baseMesh;
    }

    // ---- sources (keys first; templates are only built when the placement changes)
    const src = this.sources(o, settings, budget, state, prefix);
    if (!src) return [];

    // ---- distribution (cached on the distribution mesh + settings)
    const scatter = this.scatter(o, systemId, settings, dist, prefix);
    if (!scatter) return [];

    const placementSettings = stableStringify(settings);
    const key = [
      scatter.token,
      identityToken(pos),
      matrixKey(o.worldMatrix),
      placementSettings,
      src.key,
      this.viewport ? 'V' : 'F',
    ].join('#');
    for (const e of scatter.result.errors) this.error(o.id, prefix + e);
    return this.part(key, `P|${o.id}|${systemId}`, o.id, prefix, (limit, errors) => {
      const options = src.build(errors);
      const r: PlacementResult = placeParticles({
        ownerId: o.id,
        systemId,
        samples: scatter.result.samples,
        mesh: pos,
        matrix: o.worldMatrix,
        settings,
        options,
        viewport: this.viewport,
        limit,
      });
      return { list: r.instances, truncated: r.truncated };
    });
  }

  /** Cached distribution of one particle system. */
  private scatter(
    o: EvaluatedObject,
    systemId: string,
    s: ParticleSettings,
    dist: MeshData,
    prefix: string,
  ): ScatterEntry | null {
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
    const key = [
      identityToken(dist),
      groupKey,
      stableStringify(distSettings),
      metric ? metric.join(',') : '',
    ].join('#');
    const cacheKey = `${o.id}|${systemId}`;
    const entry = this.cache.scatter.get(cacheKey);
    if (entry && entry.key === key) {
      entry.gen = this.gen;
      return entry;
    }
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
    const next: ScatterEntry = { key, result, token: ++tokenCounter, gen: this.gen };
    this.cache.scatter.set(cacheKey, next);
    return next;
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
    const byId = this.ctx.byId;
    const describe = (ev: EvaluatedObject, nested: LocalResult | null) =>
      `${ev.id}:${ev.mesh ? 1 : 0}:${matrixKey(ev.worldMatrix)}:${nested ? nested.token : '-'}`;
    const nestedOf = (ev: EvaluatedObject) => (ev.id === o.id ? null : this.nested(ev, budget, state, o.id));

    if (s.instance_type === 'OBJECT') {
      if (!s.instance_object) {
        this.error(o.id, `${prefix}no instance_object set`);
        return null;
      }
      const ev = byId.get(s.instance_object);
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
    const cid = s.instance_collection;
    if (!cid) {
      this.error(o.id, `${prefix}no instance_collection set`);
      return null;
    }
    const coll = cid === ROOT_COLLECTION_ID ? null : this.collection(cid);
    if (!coll) {
      this.error(
        o.id,
        cid === ROOT_COLLECTION_ID
          ? `${prefix}the Scene Collection cannot be instanced`
          : `${prefix}instance collection ${cid} not found`,
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
    const parts: EvaluatedInstance[][] = [];
    const owners: string[] = [];
    for (const o of this.ctx.objects) {
      if (!isInstancer(o, this.ctx.forRender)) continue;
      let r: LocalResult | null = null;
      try {
        r = this.local(o, MAX_INSTANCE_DEPTH);
      } catch (e) {
        this.error(o.id, `instancing failed: ${(e as Error).message}`);
      }
      if (r && r.list.length) {
        parts.push(r.list);
        owners.push(o.id);
      }
    }
    const prev = this.cache.output;
    if (prev && sameArrays(prev.parts, parts)) {
      this.reportTotal(parts, owners);
      return prev.result;
    }
    const result = concatLists(parts, MAX_INSTANCES);
    this.reportTotal(parts, owners);
    this.cache.output = { parts, result };
    return result;
  }

  private reportTotal(parts: EvaluatedInstance[][], owners: string[]): void {
    let total = 0;
    for (let i = 0; i < parts.length; i++) {
      total += parts[i].length;
      if (total > MAX_INSTANCES) {
        this.error(
          owners[i],
          `the scene exceeds ${MAX_INSTANCES} instances; the instances of later objects are skipped`,
        );
        return;
      }
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
 * Results are cached per document and evaluation mode, keyed by content (emitter geometry,
 * settings, transforms, sources): unchanged inputs return the identical arrays and instance
 * objects, and moving an emitter re-places particles without re-distributing them.
 */
export function expandInstances(ctx: InstanceContext): InstanceResult {
  // full-display evaluations are one-shot (operators): their results are not kept
  const cache =
    ctx.fullDisplay && !ctx.forRender ? newModeCache() : modeCache(ctx.doc, ctx.forRender ? 'R' : 'V');
  cache.gen++;
  const ex = new Expander(ctx, cache);
  let instances: EvaluatedInstance[] = [];
  try {
    instances = ex.run();
  } catch (e) {
    ex.error('', `instancing failed: ${(e as Error).message}`);
  }
  // prune entries that were not used by this evaluation (deleted objects, systems, collections)
  const gen = cache.gen;
  for (const m of [cache.scatter, cache.parts, cache.lists, cache.contents] as Map<string, { gen: number }>[])
    for (const [k, v] of m) if (v.gen !== gen) m.delete(k);
  return { instances, errors: ex.errors };
}
