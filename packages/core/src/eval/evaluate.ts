import type { Mat4 } from '../math/types';
import { compose4, identity4, multiply4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import type {
  AnimTargetType,
  CameraData,
  FCurve,
  LightData,
  MaterialData,
  ObjectData,
  ObjectType,
  RenderSettings,
  SceneSettings,
  WorldSettings,
} from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { evaluateFCurve } from '../anim/fcurve';
import { writeChannel } from '../anim/properties';
import {
  evaluateModifierStack,
  isModifierEnabled,
  isModifierTimeDependent,
  modifierDependencies,
  registerBuiltinModifiers,
} from '../modifiers';
import { stableStringify } from '../util/json';

export interface EvaluatedObject {
  id: string;
  name: string;
  type: ObjectType;
  /** Object properties with animation applied. */
  data: ObjectData;
  localMatrix: Mat4;
  worldMatrix: Mat4;
  /** Visible in the viewport (object + collection visibility). */
  visible: boolean;
  /** Visible in final renders. */
  renderVisible: boolean;
  /** Evaluated mesh (after modifiers) for mesh objects. Treat as immutable. */
  mesh?: MeshData;
  /** Base (pre-modifier) mesh for mesh objects. Treat as immutable. */
  baseMesh?: MeshData;
  /** Changes whenever the evaluated mesh changes (for GPU buffer caching). */
  meshKey?: string;
  modifierErrors: { modifierId: string; message: string }[];
  light?: LightData;
  camera?: CameraData;
  materials: (MaterialData | null)[];
}

export interface EvaluatedScene {
  frame: number;
  objects: EvaluatedObject[];
  byId: Map<string, EvaluatedObject>;
  scene: SceneSettings;
  render: RenderSettings;
  world: WorldSettings;
  activeCamera: EvaluatedObject | null;
}

export interface EvaluateOptions {
  forRender?: boolean;
  /** Object currently in edit mode (modifiers honour `show_in_editmode`). */
  editObjectId?: string | null;
  /** Live mesh override for an object (e.g. during an interactive edit-mode transform). */
  meshOverrides?: Map<string, MeshData>;
}

type AnimIndex = Map<string, FCurve[]>; // `${type}:${id}` → curves

function indexCurves(curves: FCurve[]): AnimIndex {
  const idx: AnimIndex = new Map();
  for (const fc of curves) {
    if (fc.mute || fc.keyframes.length === 0) continue;
    const k = `${fc.target_type}:${fc.target_id}`;
    const list = idx.get(k);
    if (list) list.push(fc);
    else idx.set(k, [fc]);
  }
  return idx;
}

function applyAnimation<T extends object>(obj: T, type: AnimTargetType, id: string, idx: AnimIndex, frame: number): T {
  const curves = idx.get(`${type}:${id}`);
  if (!curves) return obj;
  const out = { ...(obj as Record<string, unknown>) };
  for (const fc of curves) {
    const v = evaluateFCurve(fc, frame);
    if (v !== undefined) writeChannel(out, fc.path, fc.index, v);
  }
  return out as T;
}

interface MeshCacheEntry {
  key: string;
  mesh: MeshData;
  errors: EvaluatedObject['modifierErrors'];
}

/**
 * Evaluates the scene at a frame: animation, parenting and modifier stacks.
 * Keeps a cache of evaluated meshes so repeated evaluations only recompute what changed.
 */
export class SceneEvaluator {
  private meshCache = new Map<string, MeshCacheEntry>();
  private overrideTokens = new WeakMap<MeshData, number>();
  private overrideCounter = 0;

  constructor(private readonly doc: SceneDoc) {
    registerBuiltinModifiers();
  }

  clearCache(): void {
    this.meshCache.clear();
  }

  evaluate(frame: number, opts: EvaluateOptions = {}): EvaluatedScene {
    const doc = this.doc;
    const anim = indexCurves(doc.listFCurves());
    const objects = doc.listObjects().map((o) => applyAnimation(o, 'object', o.id, anim, frame));
    const objById = new Map(objects.map((o) => [o.id, o]));
    const localM = new Map<string, Mat4>();
    const worldM = new Map<string, Mat4>();
    const world = (id: string, guard = new Set<string>()): Mat4 => {
      const cached = worldM.get(id);
      if (cached) return cached;
      const o = objById.get(id);
      if (!o) return identity4();
      const local = compose4(o.location, o.rotation_euler, o.scale);
      localM.set(id, local);
      let m = local;
      if (o.parent && objById.has(o.parent) && !guard.has(o.parent)) {
        guard.add(id);
        m = multiply4(world(o.parent, guard), local);
      }
      worldM.set(id, m);
      return m;
    };
    for (const o of objects) world(o.id);

    const materialCache = new Map<string, MaterialData | null>();
    const material = (id: string | null): MaterialData | null => {
      if (!id) return null;
      if (!materialCache.has(id)) {
        const m = doc.getMaterial(id);
        materialCache.set(id, m ? applyAnimation(m, 'material', id, anim, frame) : null);
      }
      return materialCache.get(id)!;
    };

    // --- meshes with modifier stacks (dependency aware)
    type MeshResult = { mesh: MeshData; key: string; errors: EvaluatedObject['modifierErrors']; base: MeshData };
    const evaluated = new Map<string, MeshResult>();
    const inProgress = new Set<string>();
    const evalMesh = (id: string): MeshResult | null => {
      if (evaluated.has(id)) return evaluated.get(id)!;
      const o = objById.get(id);
      if (!o || o.type !== 'MESH' || !o.data) return null;
      if (inProgress.has(id)) return null; // dependency cycle
      inProgress.add(id);
      try {
        const override = opts.meshOverrides?.get(id);
        const base = override ?? doc.getMesh(o.data);
        if (!base) return null;
        let baseToken: string;
        if (override) {
          let t = this.overrideTokens.get(override);
          if (t === undefined) this.overrideTokens.set(override, (t = ++this.overrideCounter));
          baseToken = `o${t}`;
        } else baseToken = `v${doc.meshVersion(o.data)}`;
        const editMode = opts.editObjectId === id;
        const ctxFlags = { forRender: !!opts.forRender, editMode };
        const active = o.modifiers.filter((m) => isModifierEnabled(m, ctxFlags));
        if (active.length === 0) {
          const r: MeshResult = { mesh: base, key: baseToken, errors: [], base };
          evaluated.set(id, r);
          return r;
        }
        const deps: string[] = [];
        let timeDep = false;
        for (const m of active) {
          deps.push(...modifierDependencies(m));
          if (isModifierTimeDependent(m)) timeDep = true;
        }
        const depKeys: string[] = deps.map((d): string => {
          const r: MeshResult | null = evalMesh(d);
          return r ? `${d}:${r.key}:${worldM.get(d)?.map((x) => x.toFixed(5)).join(',')}` : `${d}:none`;
        });
        const key: string = [
          baseToken,
          stableStringify(active),
          timeDep ? `f${frame}` : '',
          depKeys.join('|'),
          deps.length ? worldM.get(id)!.map((x) => x.toFixed(5)).join(',') : '',
          opts.forRender ? 'R' : 'V',
          editMode ? 'E' : '',
        ].join('#');
        const cached = this.meshCache.get(id);
        if (cached && cached.key === key) {
          const r: MeshResult = { mesh: cached.mesh, key, errors: cached.errors, base };
          evaluated.set(id, r);
          return r;
        }
        const res = evaluateModifierStack(base, active, {
          frame,
          objectMatrix: worldM.get(id)!,
          forRender: !!opts.forRender,
          editMode,
          getObjectMesh: (dep) => {
            const r: MeshResult | null = evalMesh(dep);
            return r ? { mesh: r.mesh, matrix: worldM.get(dep)! } : null;
          },
        });
        this.meshCache.set(id, { key, mesh: res.mesh, errors: res.errors });
        const r: MeshResult = { mesh: res.mesh, key, errors: res.errors, base };
        evaluated.set(id, r);
        return r;
      } finally {
        inProgress.delete(id);
      }
    };

    const out: EvaluatedObject[] = [];
    const visibleCollections = new Map<string, boolean>();
    const collectionVisible = (cid: string) => {
      if (!visibleCollections.has(cid)) visibleCollections.set(cid, doc.isCollectionVisible(cid));
      return visibleCollections.get(cid)!;
    };
    for (const o of objects) {
      const ev: EvaluatedObject = {
        id: o.id,
        name: o.name,
        type: o.type,
        data: o,
        localMatrix: localM.get(o.id) ?? identity4(),
        worldMatrix: worldM.get(o.id) ?? identity4(),
        visible: !o.hide_viewport && collectionVisible(o.collection),
        renderVisible: !o.hide_render && collectionVisible(o.collection),
        modifierErrors: [],
        materials: o.material_slots.map((s) => material(s)),
      };
      if (o.type === 'MESH') {
        const r = evalMesh(o.id);
        if (r) {
          ev.mesh = r.mesh;
          ev.baseMesh = r.base;
          ev.meshKey = r.key;
          ev.modifierErrors = r.errors;
        }
      } else if (o.type === 'LIGHT' && o.data) {
        const l = doc.getLight(o.data);
        if (l) ev.light = applyAnimation(l, 'light', l.id, anim, frame);
      } else if (o.type === 'CAMERA' && o.data) {
        const c = doc.getCamera(o.data);
        if (c) ev.camera = applyAnimation(c, 'camera', c.id, anim, frame);
      }
      out.push(ev);
    }
    // prune cache entries of deleted objects
    for (const id of this.meshCache.keys()) if (!objById.has(id)) this.meshCache.delete(id);

    const byId = new Map(out.map((o) => [o.id, o]));
    const scene = doc.getScene();
    const worldSettings = applyAnimation(doc.getWorld(), 'world', 'world', anim, frame);
    const activeCamera = scene.camera ? (byId.get(scene.camera) ?? null) : null;
    return { frame, objects: out, byId, scene, render: doc.getRender(), world: worldSettings, activeCamera };
  }
}

/** One-shot evaluation helper (no caching across calls). */
export function evaluateScene(doc: SceneDoc, frame: number, opts?: EvaluateOptions): EvaluatedScene {
  return new SceneEvaluator(doc).evaluate(frame, opts);
}
