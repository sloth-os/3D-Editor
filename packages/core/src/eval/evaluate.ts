import type { Mat4, Vec2 } from '../math/types';
import { identity4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { applyShapeKeys } from '../mesh/shape-keys';
import type {
  ArmatureData,
  CameraData,
  CurveData,
  LightData,
  MaterialData,
  ObjectData,
  ObjectType,
  RenderSettings,
  SceneSettings,
  ShapeKeyData,
  WorldSettings,
} from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import {
  evaluateModifierStack,
  isModifierEnabled,
  isModifierTimeDependent,
  modifierDependencies,
  registerBuiltinModifiers,
} from '../modifiers';
import { curveMemoryRefusal, geometryMemoryRefusals } from './memory';
import { isMeshMemoryError } from '../mesh/memory';
import { stableStringify } from '../util/json';
import type { ArmaturePose } from '../armature/types';
import type { ConstraintError } from '../constraints/types';
import { curveToMesh, type CurveMeshResult } from '../curve/to-mesh';
import { evaluateCurveSplines } from '../curve/spline';
import { expandInstances } from '../instancing/expand';
import type { EvaluatedInstance } from '../instancing/types';
import { RigidBodySimulator } from '../physics/rigid-body';
import { FrameState, type EvalError } from './frame-state';

export type { EvalError } from './frame-state';

export interface EvaluatedObject {
  id: string;
  name: string;
  type: ObjectType;
  /** Object properties with animation and drivers applied. */
  data: ObjectData;
  localMatrix: Mat4;
  /** Final world matrix (parenting, constraints and rigid body simulation applied). */
  worldMatrix: Mat4;
  /** Visible in the viewport (object + collection visibility). */
  visible: boolean;
  /** Visible in final renders. */
  renderVisible: boolean;
  /**
   * Evaluated geometry (after shape keys and modifiers) of meshes, and of curves/text with a
   * surface (bevel, extrude, fill, text). Treat as immutable.
   */
  mesh?: MeshData;
  /** Base (pre-modifier) geometry. Treat as immutable. */
  baseMesh?: MeshData;
  /** Changes whenever the evaluated mesh changes (for GPU buffer caching). */
  meshKey?: string;
  modifierErrors: { modifierId: string; message: string }[];
  /** Wire display geometry (flat xyz segment pairs, object space), e.g. curve splines. */
  lines?: Float32Array;
  /** Changes whenever `lines` changes. */
  linesKey?: string;
  /** Animated curve/text data (CURVE and FONT objects). */
  curve?: CurveData;
  /** Armature data and evaluated pose (ARMATURE objects). */
  armature?: ArmatureData;
  pose?: ArmaturePose;
  constraintErrors: ConstraintError[];
  /** True when the rigid body simulation drives the transform at this frame. */
  simulated: boolean;
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
  /** Instances from collection instances and particle systems (see `renderItems`). */
  instances: EvaluatedInstance[];
  /** Non-fatal evaluation problems (drivers, poses, curves, instancing, physics). */
  errors: EvalError[];
}

export interface EvaluateOptions {
  forRender?: boolean;
  /** Object currently in edit mode (modifiers honour `show_in_editmode`, shape keys are off). */
  editObjectId?: string | null;
  /** Live mesh override for an object (e.g. during an interactive edit-mode transform). */
  meshOverrides?: Map<string, MeshData>;
  /** Skip the rigid body simulation (transforms as animated). */
  noPhysics?: boolean;
}

interface MeshCacheEntry {
  key: string;
  mesh: MeshData;
  errors: EvaluatedObject['modifierErrors'];
}

interface CurveCacheEntry {
  key: string;
  token: number;
  result: CurveMeshResult;
}

const fmtMatrix = (m: Mat4 | null | undefined): string => (m ? m.map((x) => x.toFixed(5)).join(',') : 'none');

/**
 * Whether the scene simulates rigid bodies: its world is enabled and an object has an enabled body.
 * The stored objects (Y.Maps of their fields, SceneDoc.createBlock) are read in place, not the frame
 * states' input (eval/frame-input.ts): a document that has no cached input (no live Y.Doc) is then
 * read once per evaluation, by its frame state.
 */
function hasRigidBodies(doc: SceneDoc): boolean {
  if (!doc.getScene().rigidbody_world?.enabled) return false;
  for (const y of doc.map('objects').values()) {
    const body = (y as { get(key: string): unknown }).get('rigid_body') as
      ObjectData['rigid_body'] | undefined;
    if (body?.enabled) return true;
  }
  return false;
}

/**
 * Evaluates the scene at a frame: animation, drivers, parenting, armature poses, constraints,
 * rigid bodies, shape keys, curves/text, modifier stacks and instancing. Keeps caches of
 * evaluated geometry (and the rigid body simulation) so repeated evaluations only recompute what
 * changed.
 */
export class SceneEvaluator {
  private meshCache = new Map<string, MeshCacheEntry>();
  private curveCache = new Map<string, CurveCacheEntry>();
  private curveCounter = 0;
  private overrideTokens = new WeakMap<MeshData, number>();
  private overrideCounter = 0;
  /** Wire display of modified wire curves, keyed by the evaluated mesh key. */
  private wireLineCache = new Map<string, { key: string; token: number; lines: Float32Array | null }>();
  readonly rigidBodies = new RigidBodySimulator();

  constructor(private readonly doc: SceneDoc) {
    registerBuiltinModifiers();
  }

  clearCache(): void {
    this.meshCache.clear();
    this.curveCache.clear();
    this.wireLineCache.clear();
    this.rigidBodies.reset();
  }

  /** Segment pairs of the loose edges of an evaluated wire (cached per object and mesh key). */
  private wireLines(id: string, key: string, mesh: MeshData): { lines: Float32Array; token: number } | null {
    let e = this.wireLineCache.get(id);
    if (!e || e.key !== key) {
      const p = mesh.positions;
      const segs = new Float32Array(mesh.looseEdges.length * 3);
      mesh.looseEdges.forEach((v, i) => segs.set([p[v * 3], p[v * 3 + 1], p[v * 3 + 2]], i * 3));
      e = { key, token: ++this.curveCounter, lines: segs.length ? segs : null };
      this.wireLineCache.set(id, e);
    }
    return e.lines ? { lines: e.lines, token: e.token } : null;
  }

  /** Unsimulated world matrices of every object at a frame (no geometry evaluation). */
  transformsAt(frame: number): Map<string, Mat4> {
    return new FrameState(this.doc, frame).allWorldMatrices();
  }

  evaluate(frame: number, opts: EvaluateOptions = {}): EvaluatedScene {
    const doc = this.doc;
    const forRender = !!opts.forRender;
    let simulated: Map<string, Mat4> | null = null;
    const physicsErrors: EvalError[] = [];
    if (!opts.noPhysics && hasRigidBodies(doc)) {
      try {
        simulated = this.rigidBodies.evaluate(doc, frame, {
          transformsAt: (f) => this.transformsAt(f),
          meshOf: (id) => {
            const o = doc.getObject(id);
            return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
          },
        });
        // per-object problems (bodies left out, shape fallbacks) do not stop the simulation
        for (const i of this.rigidBodies.issues)
          physicsErrors.push({ source: `rigidbody:${i.objectId}`, message: `${i.level}: ${i.message}` });
      } catch (e) {
        physicsErrors.push({ source: 'rigidbody', message: (e as Error).message });
      }
    }
    const fs = new FrameState(doc, frame, simulated);
    fs.errors.push(...physicsErrors);
    for (const o of fs.objects) fs.world(o.id);

    const materialCache = new Map<string, MaterialData | null>();
    const material = (id: string | null): MaterialData | null => {
      if (!id) return null;
      if (!materialCache.has(id)) materialCache.set(id, fs.get<MaterialData>('material', id));
      return materialCache.get(id)!;
    };

    // --- curves / text → geometry (cached on the animated curve data)
    const curveResults = new Map<string, CurveCacheEntry | null>();
    const bevelProfile = (cid: string): Vec2[][] | null => {
      const co = fs.byId.get(cid);
      const c = co?.type === 'CURVE' && co.data ? fs.curve(co.data) : null;
      return c
        ? evaluateCurveSplines(c, forRender).map((s) => s.points.map((p): Vec2 => [p[0], p[1]]))
        : null;
    };
    // exact profiles (open vs cyclic splines), scaled by the bevel object's X/Y scale like Blender
    const bevelCurveOf = (cid: string): CurveData | null => {
      const co = fs.byId.get(cid);
      return co?.type === 'CURVE' && co.data ? fs.curve(co.data) : null;
    };
    const bevelScaleOf = (cid: string): Vec2 | null => {
      const s = fs.byId.get(cid)?.scale;
      return s ? [s[0], s[1]] : null;
    };
    const evalCurve = (o: ObjectData): CurveCacheEntry | null => {
      if (curveResults.has(o.id)) return curveResults.get(o.id)!;
      const curve = o.data ? fs.curve(o.data) : null;
      let entry: CurveCacheEntry | null = null;
      if (curve) {
        const bevelObj =
          curve.bevel_mode === 'OBJECT' && curve.bevel_object ? fs.byId.get(curve.bevel_object) : undefined;
        const bevelCurve = bevelObj?.type === 'CURVE' && bevelObj.data ? fs.curve(bevelObj.data) : null;
        const key = [
          o.type,
          forRender ? 'R' : 'V',
          stableStringify(curve),
          bevelCurve ? stableStringify(bevelCurve) : '',
          bevelObj ? `${bevelObj.scale[0]},${bevelObj.scale[1]}` : '',
        ].join('#');
        const cached = this.curveCache.get(o.id);
        // a host's memory check (memory.ts) may refuse the surface of a dense curve or a long text:
        // none is built, nor its wire
        const refused = cached?.key === key ? null : curveMemoryRefusal(o, curve, { forRender, bevelCurve });
        if (refused) fs.errors.push({ source: `curve:${o.id}`, message: refused });
        else if (cached && cached.key === key) entry = cached;
        else {
          const result = curveToMesh(curve, {
            forRender,
            isText: o.type === 'FONT',
            getBevelProfile: bevelProfile,
            getBevelCurve: bevelCurveOf,
            getBevelScale: bevelScaleOf,
          });
          entry = { key, token: ++this.curveCounter, result };
          this.curveCache.set(o.id, entry);
        }
        // curve problems (missing bevel object, surface too dense, …) are reported every evaluation
        for (const message of entry?.result.errors ?? [])
          fs.errors.push({ source: `curve:${o.id}`, message });
      }
      curveResults.set(o.id, entry);
      return entry;
    };

    // --- geometry with shape keys + modifier stacks (dependency aware)
    type MeshResult = {
      mesh: MeshData;
      key: string;
      errors: EvaluatedObject['modifierErrors'];
      base: MeshData;
    };
    const evaluated = new Map<string, MeshResult | null>();
    const inProgress = new Set<string>();

    /**
     * Signature of everything a dependent modifier may read from object `d`, its type included
     * (which disables some modifiers: ModifierContext.getObjectType).
     */
    const depSignature = (d: string): string => {
      const o = fs.byId.get(d);
      if (!o) return `${d}:missing`;
      const parts = [d, o.type, fmtMatrix(fs.world(d))];
      const r = evalMesh(d);
      parts.push(r ? r.key : 'nomesh');
      if (o.type === 'ARMATURE') {
        const pose = fs.pose(d);
        if (pose) for (const n of pose.order) parts.push(fmtMatrix(pose.bones.get(n)!.matrix));
        // bone data the Armature modifier reads besides the posed matrices (names, rest, deform, envelopes)
        const arm = o.data ? doc.getArmature(o.data) : null;
        parts.push(arm ? stableStringify(arm.bones) : 'noarm');
      } else if (o.type === 'CURVE' && o.data) {
        const c = fs.curve(o.data);
        parts.push(c ? stableStringify(c) : 'nocurve');
      }
      return parts.join(':');
    };

    const evalMesh = (id: string): MeshResult | null => {
      if (evaluated.has(id)) return evaluated.get(id)!;
      const o = fs.byId.get(id);
      if (!o || !o.data || inProgress.has(id)) return null; // missing, no data or dependency cycle
      if (o.type !== 'MESH' && o.type !== 'CURVE' && o.type !== 'FONT') return null;
      inProgress.add(id);
      try {
        const editMode = opts.editObjectId === id;
        let base: MeshData | null = null;
        let baseToken: string;
        let shapeKeys: ShapeKeyData[] = [];
        if (o.type === 'MESH') {
          const override = opts.meshOverrides?.get(id);
          try {
            base = override ?? doc.getMesh(o.data);
          } catch (e) {
            // a host's memory check refused to decode the stored mesh (mesh/memory.ts): the object
            // has no geometry in this evaluation, and says why
            if (!isMeshMemoryError(e)) throw e;
            fs.errors.push({ source: `mesh:${o.id}`, message: e.message });
            evaluated.set(id, null);
            return null;
          }
          if (override) {
            let t = this.overrideTokens.get(override);
            if (t === undefined) this.overrideTokens.set(override, (t = ++this.overrideCounter));
            baseToken = `o${t}`;
          } else baseToken = `v${doc.meshVersion(o.data)}`;
          if (!editMode) {
            shapeKeys = fs.get<{ shape_keys: ShapeKeyData[] }>('mesh', o.data)?.shape_keys ?? [];
            if (shapeKeys.length) {
              baseToken += `|k${doc.meshAttrVersion(o.data, 'shape_keys')}:${shapeKeys
                .map((k) => `${k.value}${k.mute ? 'm' : ''}${k.relative_key}${k.slider_min}/${k.slider_max}`)
                .join(',')}`;
            }
          }
          baseToken += `|g${doc.meshAttrVersion(o.data, 'vertex_groups')}`;
        } else {
          const c = evalCurve(o);
          base = c?.result.mesh ?? null;
          baseToken = `c${c?.token ?? 0}`;
          // Blender converts a curve without a surface to its wire (vertices + loose edges) for the
          // modifier stack: SCREW revolves a profile curve, ARRAY repeats it, …
          if (
            !base &&
            c?.result.wire &&
            o.modifiers.some((m) => isModifierEnabled(m, { forRender, editMode }))
          ) {
            base = c.result.wire;
            baseToken += 'w';
          }
        }
        if (!base) {
          evaluated.set(id, null);
          return null;
        }
        const ctxFlags = { forRender, editMode };
        const active = o.modifiers.filter((m) => isModifierEnabled(m, ctxFlags));
        const hasKeys = shapeKeys.some((k) => !k.mute && k.value !== 0);
        if (active.length === 0 && !hasKeys) {
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
        const key: string = [
          baseToken,
          stableStringify(active),
          timeDep ? `f${frame}` : '',
          deps.map(depSignature).join('|'),
          deps.length ? fmtMatrix(fs.world(id)) : '',
          forRender ? 'R' : 'V',
          editMode ? 'E' : '',
        ].join('#');
        const cached = this.meshCache.get(id);
        if (cached && cached.key === key) {
          const r: MeshResult = { mesh: cached.mesh, key, errors: cached.errors, base };
          evaluated.set(id, r);
          return r;
        }
        const errors: EvaluatedObject['modifierErrors'] = [];
        let input = base;
        if (hasKeys) {
          const sk = applyShapeKeys(base, shapeKeys);
          input = sk.mesh;
          for (const message of sk.errors) errors.push({ modifierId: 'shape_keys', message });
        }
        const refusals = geometryMemoryRefusals();
        const res = evaluateModifierStack(input, active, {
          frame,
          objectMatrix: fs.world(id) ?? identity4(),
          forRender,
          editMode,
          getObjectMesh: (dep) => {
            const r: MeshResult | null = evalMesh(dep);
            return r ? { mesh: r.mesh, matrix: fs.world(dep) ?? identity4() } : null;
          },
          getObjectMatrix: (dep) => fs.world(dep),
          getArmature: (dep) => {
            const pose = fs.pose(dep);
            const matrix = fs.world(dep);
            return pose && matrix ? { pose, matrix } : null;
          },
          getCurvePath: (dep) => {
            const r = fs.curvePath(dep);
            return r ? { path: r.path, matrix: r.matrix } : null;
          },
          // Blender's is_disabled reads the types of the objects a modifier names: a Boolean whose
          // object is a text, a Curve modifier whose curve became a mesh, … are left out
          getObjectType: (dep) => fs.byId.get(dep)?.type ?? null,
          vertexGroups: o.type === 'MESH' ? doc.getVertexGroups(o.data) : undefined,
        });
        errors.push(...res.errors);
        // a modifier the host's memory check skipped (memory.ts) may fit later, when memory was
        // freed elsewhere: such a result is not kept
        if (geometryMemoryRefusals() !== refusals) this.meshCache.delete(id);
        else this.meshCache.set(id, { key, mesh: res.mesh, errors });
        const r: MeshResult = { mesh: res.mesh, key, errors, base };
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
    for (const o of fs.objects) {
      const ev: EvaluatedObject = {
        id: o.id,
        name: o.name,
        type: o.type,
        data: o,
        localMatrix: fs.local(o.id),
        worldMatrix: fs.world(o.id) ?? identity4(),
        visible: !o.hide_viewport && collectionVisible(o.collection),
        renderVisible: !o.hide_render && collectionVisible(o.collection),
        modifierErrors: [],
        constraintErrors: fs.constraintErrors.get(o.id) ?? [],
        simulated: !!simulated?.has(o.id),
        materials: o.material_slots.map((s) => material(s)),
      };
      if (o.type === 'MESH' || o.type === 'CURVE' || o.type === 'FONT') {
        const r = evalMesh(o.id);
        const c = o.type !== 'MESH' && o.data ? evalCurve(o) : null;
        if (r && c && r.base === c.result.wire && r.mesh.faces.length === 0) {
          // a modified wire curve that is still a wire (ARRAY, MIRROR, deform modifiers …) keeps the
          // wire display, now of the modified edges
          const w = this.wireLines(o.id, r.key, r.mesh);
          if (w) {
            ev.lines = w.lines;
            ev.linesKey = `w${w.token}`;
          }
          ev.modifierErrors = r.errors;
        } else if (r) {
          ev.mesh = r.mesh;
          ev.baseMesh = r.base;
          ev.meshKey = r.key;
          ev.modifierErrors = r.errors;
        }
        if (o.type !== 'MESH' && o.data) {
          ev.curve = fs.curve(o.data) ?? undefined;
          if (c?.result.lines && !ev.mesh && !ev.lines) {
            ev.lines = c.result.lines;
            ev.linesKey = `c${c.token}`;
          }
        }
      } else if (o.type === 'LIGHT' && o.data) {
        ev.light = fs.get<LightData>('light', o.data) ?? undefined;
      } else if (o.type === 'CAMERA' && o.data) {
        const cam = fs.get<CameraData>('camera', o.data);
        ev.camera = cam ? withFocusObject(cam, ev.worldMatrix, fs, o.id) : undefined;
      } else if (o.type === 'ARMATURE' && o.data) {
        ev.armature = doc.getArmature(o.data) ?? undefined;
        ev.pose = fs.pose(o.id) ?? undefined;
      }
      out.push(ev);
    }
    // prune cache entries of deleted objects
    for (const id of this.meshCache.keys()) if (!fs.byId.has(id)) this.meshCache.delete(id);
    for (const id of this.curveCache.keys()) if (!fs.byId.has(id)) this.curveCache.delete(id);
    for (const id of this.wireLineCache.keys()) if (!fs.byId.has(id)) this.wireLineCache.delete(id);

    const byId = new Map(out.map((o) => [o.id, o]));
    let instances: EvaluatedInstance[] = [];
    if (fs.objects.some((o) => o.instance_type === 'COLLECTION' || o.particle_systems?.length)) {
      try {
        const res = expandInstances({ doc, frame, forRender, objects: out, byId });
        instances = res.instances;
        for (const e of res.errors) fs.errors.push({ source: `instances:${e.objectId}`, message: e.message });
      } catch (e) {
        fs.errors.push({ source: 'instances', message: (e as Error).message });
      }
    }
    const scene = doc.getScene();
    const world = fs.get<WorldSettings>('world', 'world') ?? doc.getWorld();
    const activeCamera = scene.camera ? (byId.get(scene.camera) ?? null) : null;
    return {
      frame,
      objects: out,
      byId,
      scene,
      render: doc.getRender(),
      world,
      activeCamera,
      instances,
      errors: fs.errors,
    };
  }
}

/**
 * Depth of field with a focus object (Blender BKE_camera_object_dof_distance): the focus distance
 * becomes the depth of the object's origin along the camera's view axis at this frame.
 */
export function withFocusObject(
  cam: CameraData,
  camWorld: Mat4,
  fs: FrameState,
  cameraObjectId: string,
): CameraData {
  const focusId = cam.dof_focus_object;
  if (!focusId) return cam;
  const target = fs.byId.has(focusId) ? fs.world(focusId) : null;
  if (!target) {
    if (cam.dof_use)
      fs.errors.push({
        source: `camera:${cameraObjectId}`,
        message: `depth of field focus object '${focusId}' not found: using dof_focus_distance`,
      });
    return cam;
  }
  const [zx, zy, zz] = [camWorld[8], camWorld[9], camWorld[10]];
  const len = Math.hypot(zx, zy, zz) || 1;
  const depth =
    Math.abs(
      zx * (camWorld[12] - target[12]) + zy * (camWorld[13] - target[13]) + zz * (camWorld[14] - target[14]),
    ) / len;
  return { ...cam, dof_focus_distance: depth };
}

/** One-shot evaluation helper (no caching across calls). */
export function evaluateScene(doc: SceneDoc, frame: number, opts?: EvaluateOptions): EvaluatedScene {
  return new SceneEvaluator(doc).evaluate(frame, opts);
}
