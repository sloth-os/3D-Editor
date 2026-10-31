import type { Mat4 } from '../math/types';
import { compose4, identity4, multiply4, translation4 } from '../math/mat4';
import type { AnimTargetType, CurveData, DriverData, FCurve, ObjectData } from '../doc/types';
import { fcurveKey, type SceneDoc } from '../doc/scene-doc';
import { evaluateFCurve } from '../anim/fcurve';
import { readChannel, writeChannel } from '../anim/properties';
import { evaluateDriver } from '../anim/drivers';
import { createPoseEvaluation, type PoseEvaluation } from '../armature/pose';
import type { ArmaturePose } from '../armature/types';
import { solveConstraints } from '../constraints/solve';
import { constraintContextFor } from '../constraints/context';
import { dependencyGraph, inParentLoop } from '../constraints/depgraph';
import type { ConstraintError } from '../constraints/types';
import { buildCurvePath, type CurvePath } from '../curve/path';

export interface EvalError {
  /** What failed, e.g. `driver:object:<id>:location:0`, `pose:<objectId>`. */
  source: string;
  message: string;
}

type CurveIndex = Map<string, FCurve[]>; // `${type}:${id}` → curves

function indexByTarget<T extends { target_type: string; target_id: string; mute: boolean }>(
  items: T[],
  skip: (t: T) => boolean,
): Map<string, T[]> {
  const idx = new Map<string, T[]>();
  for (const it of items) {
    if (it.mute || skip(it)) continue;
    const k = `${it.target_type}:${it.target_id}`;
    const list = idx.get(k);
    if (list) list.push(it);
    else idx.set(k, [it]);
  }
  return idx;
}

type Block = Record<string, unknown>;

/**
 * Lazily animated datablocks of one frame: F-curves first, then drivers. A driver reading a
 * datablock that is still being resolved (e.g. its own object) sees the F-curve values.
 */
class AnimatedStore {
  private readonly animated = new Map<string, Block | null>();
  private readonly final = new Map<string, Block | null>();
  private readonly resolving = new Set<string>();

  constructor(
    private readonly doc: SceneDoc,
    private readonly frame: number,
    private readonly objects: Map<string, ObjectData>,
    private readonly curves: CurveIndex,
    private readonly drivers: Map<string, DriverData[]>,
    private readonly errors: EvalError[],
  ) {}

  private raw(type: AnimTargetType, id: string): Block | null {
    const d = this.doc;
    switch (type) {
      case 'object':
        return (this.objects.get(id) as unknown as Block) ?? null;
      case 'material':
        return d.getMaterial(id) as unknown as Block | null;
      case 'light':
        return d.getLight(id) as unknown as Block | null;
      case 'camera':
        return d.getCamera(id) as unknown as Block | null;
      case 'world':
        return d.getWorld() as unknown as Block;
      case 'scene':
        return d.getScene() as unknown as Block;
      case 'mesh':
        return d.getMeshBlock(id) ? { shape_keys: d.getShapeKeys(id) } : null;
      case 'curve':
        return d.getCurve(id) as unknown as Block | null;
    }
  }

  private animatedOnly(type: AnimTargetType, id: string): Block | null {
    const k = `${type}:${id}`;
    if (this.animated.has(k)) return this.animated.get(k)!;
    const raw = this.raw(type, id);
    let out = raw;
    const curves = this.curves.get(k);
    if (raw && curves) {
      out = { ...raw };
      for (const fc of curves) {
        const v = evaluateFCurve(fc, this.frame);
        if (v !== undefined) writeChannel(out, fc.path, fc.index, v);
      }
    }
    this.animated.set(k, out);
    return out;
  }

  get<T = Block>(type: AnimTargetType, id: string): T | null {
    const k = `${type}:${id}`;
    if (this.final.has(k)) return this.final.get(k) as T | null;
    const base = this.animatedOnly(type, id);
    const ds = base ? this.drivers.get(k) : undefined;
    if (!base || !ds) {
      this.final.set(k, base);
      return base as T | null;
    }
    this.resolving.add(k);
    const out: Block = { ...base };
    for (const d of ds) {
      try {
        const v = evaluateDriver(d, this.frame, this.read);
        if (Number.isFinite(v)) writeChannel(out, d.path, d.index, v);
        else throw new Error(`driver returned ${v}`);
      } catch (e) {
        this.errors.push({ source: `driver:${fcurveKey(d)}`, message: (e as Error).message });
      }
    }
    this.resolving.delete(k);
    this.final.set(k, out);
    return out as T;
  }

  readonly read = (type: AnimTargetType, id: string, path: string, index: number): number | undefined => {
    const k = `${type}:${id}`;
    const src = this.resolving.has(k) ? this.animatedOnly(type, id) : this.get(type, id);
    return src ? readChannel(src, path, index) : undefined;
  };
}

/**
 * Transform state of the scene at one frame: animated + driven datablocks, parenting (object and
 * bone), armature poses, constraints and rigid body overrides. Everything is computed lazily and
 * memoised; dependency cycles resolve to null (callers fall back to identity).
 */
export class FrameState {
  readonly objects: ObjectData[];
  readonly byId: Map<string, ObjectData>;
  readonly errors: EvalError[] = [];
  readonly constraintErrors = new Map<string, ConstraintError[]>();
  private readonly store: AnimatedStore;
  private readonly localM = new Map<string, Mat4>();
  private readonly parentM = new Map<string, Mat4>();
  private readonly worldM = new Map<string, Mat4>();
  private readonly computing = new Set<string>();
  private readonly poses = new Map<string, ArmaturePose | null>();
  /** Incremental pose evaluations (bones are evaluated on demand, see `boneMatrix`). */
  private readonly poseEvals = new Map<string, PoseEvaluation | null>();
  private readonly paths = new Map<string, CurvePath | null>();

  constructor(
    readonly doc: SceneDoc,
    readonly frame: number,
    /** Simulated world matrices replacing the computed ones (rigid body world). */
    readonly simulated: ReadonlyMap<string, Mat4> | null = null,
  ) {
    const raw = doc.listObjects();
    const rawById = new Map(raw.map((o) => [o.id, o]));
    const curves = indexByTarget(doc.listFCurves(), (fc) => fc.keyframes.length === 0);
    const drivers = indexByTarget(doc.listDrivers(), () => false);
    this.store = new AnimatedStore(doc, frame, rawById, curves, drivers, this.errors);
    this.objects = raw.map((o) => this.store.get<ObjectData>('object', o.id)!);
    this.byId = new Map(this.objects.map((o) => [o.id, o]));
  }

  /** Animated + driven datablock (null when missing). */
  get<T>(type: AnimTargetType, id: string): T | null {
    return this.store.get<T>(type, id);
  }

  curve(id: string): CurveData | null {
    return this.store.get<CurveData>('curve', id);
  }

  local(id: string): Mat4 {
    if (!this.localM.has(id)) this.world(id);
    return this.localM.get(id) ?? identity4();
  }

  /** World matrix of the object's parent (bone tail for bone parenting), identity if none. */
  parent(id: string): Mat4 {
    if (!this.parentM.has(id)) this.world(id);
    return this.parentM.get(id) ?? identity4();
  }

  /** Final world matrix (null if the object is missing or part of a dependency cycle). */
  world(id: string): Mat4 | null {
    const cached = this.worldM.get(id);
    if (cached) return cached;
    const o = this.byId.get(id);
    if (!o || this.computing.has(id)) return null;
    // the object's dependencies not handed out yet are evaluated first (dependency order), so long
    // parent / constraint chains never recurse deeply, also when a pose bone reads an object while
    // another object is being evaluated
    for (const dep of dependencyGraph(this).evaluationOrder(id)) this.world(dep);
    // a dependency may have evaluated this object already, through a relation inside an armature
    // pose (a cycle the object graph cannot see): keep that result, so every object is solved once
    // and its constraint errors match its matrix whatever the evaluation order
    const done = this.worldM.get(id);
    if (done) return done;
    this.computing.add(id);
    try {
      const local = compose4(o.location, o.rotation_euler, o.scale);
      this.localM.set(id, local);
      let parent = identity4();
      if (o.parent && o.parent !== id && this.byId.has(o.parent)) {
        const pw = this.world(o.parent);
        const boneParent = o.parent_type === 'BONE' && !!o.parent_bone;
        // The parent (or the pose of the parent armature) is being evaluated and depends on this
        // object: a dependency cycle through parenting. Report this object as cyclic (null, not
        // cached) instead of caching it without its parent; only loops of parent links (corrupt
        // data) fall back to an identity parent.
        if (pw ? boneParent && this.boneCycle(o.parent, o.parent_bone) : !inParentLoop(this.byId, id))
          return null;
        if (pw) {
          parent = pw;
          if (boneParent) {
            const b = this.boneMatrix(o.parent, o.parent_bone);
            // Blender: bone children are placed relative to the bone's tail
            if (b) parent = multiply4(b.matrix, translation4([0, b.length, 0]));
          }
        }
      }
      this.parentM.set(id, parent);
      let m = multiply4(parent, local);
      const sim = this.simulated?.get(id);
      if (sim) m = sim;
      else if (o.constraints?.length) {
        const res = solveConstraints(o.constraints, m, constraintContextFor(this, id, parent));
        m = res.matrix;
        if (res.errors.length) this.constraintErrors.set(id, res.errors);
      }
      this.worldM.set(id, m);
      return m;
    } finally {
      this.computing.delete(id);
    }
  }

  /**
   * Incremental pose evaluation of an armature object (null if not an armature, or while the
   * armature object's own transform is being computed).
   */
  private poseEvaluation(id: string): PoseEvaluation | null {
    const known = this.poseEvals.get(id);
    if (known !== undefined) return known;
    const o = this.byId.get(id);
    const arm = o?.type === 'ARMATURE' && o.data ? this.doc.getArmature(o.data) : null;
    if (!o || !arm) {
      this.poseEvals.set(id, null);
      return null;
    }
    const armatureMatrix = this.world(id);
    if (!armatureMatrix) return null;
    let ev = this.poseEvals.get(id);
    if (!ev) {
      ev = createPoseEvaluation(arm, o.pose?.bones ?? {}, {
        frame: this.frame,
        armatureMatrix,
        armatureId: id,
        getWorldMatrix: (t) => this.world(t),
        getBoneMatrix: (a, b) => this.boneMatrix(a, b),
      });
      this.poseEvals.set(id, ev);
    }
    return ev;
  }

  /**
   * Evaluated pose of an armature object (null if not an armature, or cyclic). Pose problems are
   * reported in `errors` (source `pose:<id>`).
   */
  pose(id: string): ArmaturePose | null {
    if (this.poses.has(id)) return this.poses.get(id)!;
    const ev = this.poseEvaluation(id);
    // asked for while one of its bones is being evaluated: a dependency cycle
    if (!ev || ev.busy) return null;
    let pose: ArmaturePose | null = null;
    try {
      pose = ev.result();
      for (const message of pose.errors ?? []) this.errors.push({ source: `pose:${id}`, message });
    } catch (e) {
      this.errors.push({ source: `pose:${id}`, message: (e as Error).message });
    }
    this.poses.set(id, pose);
    return pose;
  }

  /**
   * World-space posed bone matrix (origin at the head, +Y along the bone). Only the bone and
   * what it depends on are evaluated, so this works while other bones of the pose are evaluated.
   */
  boneMatrix(armatureId: string, bone: string): { matrix: Mat4; length: number } | null {
    const b = this.poseEvaluation(armatureId)?.bone(bone);
    const am = b ? this.world(armatureId) : null;
    return b && am ? { matrix: multiply4(am, b.matrix), length: b.length } : null;
  }

  /** Whether a bone is being evaluated or depends on one that is (a cycle through bone parenting). */
  private boneCycle(armatureId: string, bone: string): boolean {
    return !!this.poseEvaluation(armatureId)?.bone(bone)?.cyclic;
  }

  /** Path along the first spline of a CURVE object, with its world matrix. */
  curvePath(id: string): { path: CurvePath; matrix: Mat4; curve: CurveData } | null {
    const o = this.byId.get(id);
    if (!o || o.type !== 'CURVE' || !o.data) return null;
    const curve = this.curve(o.data);
    if (!curve) return null;
    if (!this.paths.has(id)) this.paths.set(id, buildCurvePath(curve));
    const path = this.paths.get(id);
    const matrix = this.world(id);
    return path && matrix ? { path, matrix, curve } : null;
  }

  /** World matrices of every object. */
  allWorldMatrices(): Map<string, Mat4> {
    const out = new Map<string, Mat4>();
    for (const o of this.objects) out.set(o.id, this.world(o.id) ?? identity4());
    return out;
  }
}
